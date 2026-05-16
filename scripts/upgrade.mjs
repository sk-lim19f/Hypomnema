#!/usr/bin/env node
/**
 * Hypomnema upgrade script
 *
 * Compares the installed wiki against the current package version.
 * Reports schema version drift, stale hook files, and missing settings.json
 * registrations — without overwriting anything unless --apply is passed.
 *
 * Usage:
 *   node scripts/upgrade.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root directory (default: resolved via HYPO_DIR / hypo-config.md scan / ~/hypomnema)
 *   --apply             Apply hook file updates and settings.json merges
 *   --json              Output results as JSON
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import {
  readPkgJson as readPkgJsonSafe,
  writePkgJsonAtomic,
  sha256 as sha256Buf,
  isRegularFile,
  readFileIfRegular,
} from './lib/pkg-json.mjs';

const HOME = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT =
  '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';
const HOOKS_SRC = join(PKG_ROOT, 'hooks');
const COMMANDS_SRC = join(PKG_ROOT, 'commands');
const TEMPLATES = join(PKG_ROOT, 'templates');

function sha256(buf) {
  return sha256Buf(buf);
}
function pkgJsonPath() {
  return join(HOME, '.claude', 'hypo-pkg.json');
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, apply: false, json: false, forceCommands: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--force-commands') args.forceCommands = true;
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── version helpers ──────────────────────────────────────────────────────────

function parseVersion(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2] || '0', 10), raw: String(str) };
}

function bumpType(installed, current) {
  if (!installed || !current) return 'unknown';
  if (installed.major !== current.major) {
    return installed.major > current.major ? 'ahead' : 'major';
  }
  if (installed.minor !== current.minor) {
    return installed.minor > current.minor ? 'ahead' : 'minor';
  }
  return 'none';
}

// ── hook map (loaded from hooks/hooks.json — single source of truth) ─────────

let _hookConfig;
try {
  _hookConfig = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
} catch {
  console.error(`Error: cannot read hooks/hooks.json from package root: ${PKG_ROOT}`);
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}
if (!_hookConfig || typeof _hookConfig !== 'object' || Array.isArray(_hookConfig)) {
  console.error('Error: hooks/hooks.json must be a JSON object');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}
if (
  !_hookConfig.hooks ||
  typeof _hookConfig.hooks !== 'object' ||
  Array.isArray(_hookConfig.hooks)
) {
  console.error('Error: hooks/hooks.json must contain a "hooks" object');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}
function _extractCommandFileName(command) {
  if (typeof command !== 'string') return null;
  const matches = [...command.matchAll(/(?:^|[\/\\])([^\/\\\s"'`]+\.mjs)(?=$|[\s"'`])/g)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  const bare = command.match(/(?:^|\s)([^\/\\\s"'`]+\.mjs)(?=$|[\s"'`])/);
  return bare ? bare[1] : null;
}

function _isHookFileName(file) {
  return typeof file === 'string' && /^[^/\\\s]+\.mjs$/.test(file.trim());
}

function _isHookGroup(group) {
  return (
    group &&
    typeof group === 'object' &&
    !Array.isArray(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every(
      (hook) =>
        hook &&
        typeof hook === 'object' &&
        !Array.isArray(hook) &&
        hook.type === 'command' &&
        _extractCommandFileName(hook.command),
    )
  );
}

// Extract .mjs file names from both old format (string[]) and new format (hook-group object[])
function _extractFileNames(groups) {
  return groups.flatMap((group) => {
    if (typeof group === 'string') return [group.trim()];
    return group.hooks.map((hook) => _extractCommandFileName(hook.command));
  });
}

for (const [event, groups] of Object.entries(_hookConfig.hooks)) {
  const valid =
    Array.isArray(groups) &&
    groups.length > 0 &&
    groups.every((group) => _isHookFileName(group) || _isHookGroup(group)) &&
    _extractFileNames(groups).length > 0;
  if (!valid) {
    console.error(
      `Error: hooks/hooks.json "hooks.${event}" must be a non-empty array of .mjs file names or Claude hook groups`,
    );
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
}
if (
  _hookConfig.shared !== undefined &&
  (!Array.isArray(_hookConfig.shared) || !_hookConfig.shared.every((f) => _isHookFileName(f)))
) {
  console.error('Error: hooks/hooks.json "shared" must be an array of .mjs file names');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}

const HOOK_MAP = Object.fromEntries(
  Object.entries(_hookConfig.hooks).map(([e, gs]) => [e, _extractFileNames(gs)]),
);
const SHARED_FILES = _hookConfig.shared ?? [];

// ── checks ───────────────────────────────────────────────────────────────────

function checkSchemaVersion(hypoDir) {
  const pkgPath = join(TEMPLATES, 'SCHEMA.md');
  const hypoPath = join(hypoDir, 'SCHEMA.md');

  const pkgVersion = existsSync(pkgPath)
    ? parseVersion((parseFrontmatter(readFileSync(pkgPath, 'utf-8')) ?? {}).version)
    : null;
  const hypoVersion = existsSync(hypoPath)
    ? parseVersion((parseFrontmatter(readFileSync(hypoPath, 'utf-8')) ?? {}).version)
    : null;

  return {
    installed: hypoVersion?.raw ?? null,
    current: pkgVersion?.raw ?? null,
    bump: bumpType(hypoVersion, pkgVersion),
    hypoPath,
    pkgPath,
  };
}

function checkHookFiles() {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  const results = [];

  const allFiles = [...Object.values(HOOK_MAP).flat(), ...SHARED_FILES];
  for (const file of allFiles) {
    const installedPath = join(claudeHooks, file);
    const srcPath = join(HOOKS_SRC, file);

    if (!existsSync(installedPath)) {
      results.push({ file, status: 'missing', installedPath, srcPath });
    } else if (!existsSync(srcPath)) {
      results.push({ file, status: 'src-missing', installedPath, srcPath });
    } else {
      const installedContent = readFileSync(installedPath, 'utf-8');
      const srcContent = readFileSync(srcPath, 'utf-8');
      results.push({
        file,
        status: installedContent === srcContent ? 'up-to-date' : 'stale',
        installedPath,
        srcPath,
      });
    }
  }

  return results;
}

function checkSettingsJson() {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  const hooksDir = join(HOME, '.claude', 'hooks');
  const results = [];

  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      return [{ event: '*', file: '*', status: 'invalid-json', cmd: '' }];
    }
  }

  for (const [event, files] of Object.entries(HOOK_MAP)) {
    for (const file of files) {
      const cmd = `node ${hooksDir.replace(HOME, '$HOME')}/${file}`;
      const found = (Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [])
        .flatMap((g) => g.hooks || [])
        .some((h) => h.command === cmd);
      results.push({ event, file, status: found ? 'registered' : 'missing', cmd });
    }
  }

  return results;
}

// ── apply actions ────────────────────────────────────────────────────────────

function applyHookFiles(hookResults) {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  mkdirSync(claudeHooks, { recursive: true });

  const applied = [];
  for (const h of hookResults) {
    if ((h.status === 'stale' || h.status === 'missing') && existsSync(h.srcPath)) {
      copyFileSync(h.srcPath, h.installedPath);
      applied.push(h.file);
    }
  }
  return applied;
}

function applySettingsJson(settingsResults) {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      return [];
    }
  }
  if (!settings.hooks) settings.hooks = {};

  const applied = [];
  for (const s of settingsResults) {
    if (s.status !== 'missing') continue;
    if (!Array.isArray(settings.hooks[s.event])) settings.hooks[s.event] = [];
    settings.hooks[s.event].push({ hooks: [{ type: 'command', command: s.cmd }] });
    applied.push(`${s.event}: ${s.file}`);
  }

  if (applied.length > 0) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return applied;
}

// Rename map: old wiki-*.mjs → new hypo-*.mjs
const HOOK_RENAMES = {
  'wiki-session-start.mjs': 'hypo-session-start.mjs',
  'wiki-first-prompt.mjs': 'hypo-first-prompt.mjs',
  'wiki-lookup.mjs': 'hypo-lookup.mjs',
  'wiki-compact-guard.mjs': 'hypo-compact-guard.mjs',
  'wiki-auto-stage.mjs': 'hypo-auto-stage.mjs',
  'wiki-hot-rebuild.mjs': 'hypo-hot-rebuild.mjs',
  'wiki-auto-commit.mjs': 'hypo-auto-commit.mjs',
  'wiki-cwd-change.mjs': 'hypo-cwd-change.mjs',
  'wiki-file-watch.mjs': 'hypo-file-watch.mjs',
  'wiki-shared.mjs': 'hypo-shared.mjs',
  'personal-wiki-check.mjs': 'hypo-personal-check.mjs',
};

function checkOldHookNames() {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return [];
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return [];
  }

  const found = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of group.hooks || []) {
        const cmd = hook.command || '';
        for (const oldName of Object.keys(HOOK_RENAMES)) {
          if (cmd.includes(oldName)) found.push({ event, oldName, cmd });
        }
      }
    }
  }
  return found;
}

function applyHookNameMigration(oldRefs) {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  const hooksDir = join(HOME, '.claude', 'hooks');
  if (!existsSync(settingsPath)) return [];

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return [];
  }

  const applied = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of group.hooks || []) {
        for (const [oldName, newName] of Object.entries(HOOK_RENAMES)) {
          if ((hook.command || '').includes(oldName)) {
            hook.command = hook.command.replace(oldName, newName);
            applied.push(`${event}: ${oldName} → ${newName}`);
          }
        }
      }
    }
  }

  if (applied.length > 0) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    // Copy renamed hook files to ~/.claude/hooks/
    for (const [oldName, newName] of Object.entries(HOOK_RENAMES)) {
      const oldPath = join(hooksDir, oldName);
      const newPath = join(hooksDir, newName);
      const srcPath = join(HOOKS_SRC, newName);
      if (existsSync(oldPath) && !existsSync(newPath) && existsSync(srcPath)) {
        copyFileSync(srcPath, newPath);
      }
    }
  }
  return applied;
}

// ── .hypoignore migration — ensure required runtime patterns are present ─────
//
// Idempotent: only appends entries that are absent. Re-running --apply on an
// already-migrated .hypoignore is a no-op.

const HYPOIGNORE_REQUIRED_ENTRIES = [
  {
    pattern: '.cache/',
    comment: '# Hypomnema runtime cache (session growth metrics, future index.jsonl, etc.)',
  },
];

function checkHypoignore(hypoDir) {
  const path = join(hypoDir, '.hypoignore');
  if (!existsSync(path)) return { status: 'no-file', missing: [], path };
  const content = readFileSync(path, 'utf-8');
  const entries = new Set(
    content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
  const missing = HYPOIGNORE_REQUIRED_ENTRIES.filter((e) => !entries.has(e.pattern));
  return { status: missing.length === 0 ? 'up-to-date' : 'needs-migration', missing, path };
}

function applyHypoignoreMigration(result) {
  if (result.status !== 'needs-migration') return [];
  let content = readFileSync(result.path, 'utf-8');
  if (!content.endsWith('\n')) content += '\n';
  const appended = [];
  for (const entry of result.missing) {
    content += `\n${entry.comment}\n${entry.pattern}\n`;
    appended.push(entry.pattern);
  }
  writeFileSync(result.path, content);
  return appended;
}

function writeMigrationReport(hypoDir, fromVersion, toVersion) {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `MIGRATION-v${toVersion}.md`;
  const dest = join(hypoDir, filename);

  // Don't overwrite an existing report
  if (existsSync(dest)) return dest;

  const content = `---
title: Migration Report — v${fromVersion} → v${toVersion}
type: reference
updated: ${today}
tags: [hypomnema, migration, schema]
---

# Migration Report: v${fromVersion} → v${toVersion}

Generated by \`/hypo:upgrade\` on ${today}.

## What changed

This is a **major version bump** (v${fromVersion} → v${toVersion}).
Review the SCHEMA diff and update your wiki pages accordingly.

## Action items

- [ ] Compare your \`SCHEMA.md\` (v${fromVersion}) with the package template (v${toVersion}) and update manually
- [ ] Run \`/hypo:upgrade --apply\` to install updated hook files and settings.json entries
- [ ] Check all \`adr\` and \`learning\` pages for new required frontmatter fields
- [ ] Run \`/hypo:doctor\` after applying updates to verify installation health

## Notes

Add migration-specific notes here after reviewing the SCHEMA diff.
`;

  writeFileSync(dest, content);
  return dest;
}

function checkPkgJson() {
  const path = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(path)) return { status: 'missing', path };
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8')).pkgRoot;
    if (typeof v !== 'string' || !v) return { status: 'missing', path };
    if (v !== PKG_ROOT) return { status: 'stale', path, installed: v, current: PKG_ROOT };
    return { status: 'up-to-date', path };
  } catch {
    return { status: 'missing', path };
  }
}

// ── slash command sync (mirrors init.mjs:installCommands logic) ─────────────

function readPkgRecordedCommands() {
  const pkg = readPkgJsonSafe(pkgJsonPath());
  return pkg && pkg.commands && typeof pkg.commands === 'object' ? pkg.commands : {};
}

function checkCommands() {
  const targetDir = join(HOME, '.claude', 'commands', 'hypo');
  const results = [];
  if (!existsSync(COMMANDS_SRC)) return results;

  const recorded = readPkgRecordedCommands();
  const packagedFiles = new Set();

  for (const file of readdirSync(COMMANDS_SRC)) {
    if (!file.endsWith('.md')) continue;
    packagedFiles.add(file);
    const srcPath = join(COMMANDS_SRC, file);
    const dest = join(targetDir, file);
    const srcSHA = sha256(readFileSync(srcPath));

    if (!existsSync(dest)) {
      results.push({ file, status: 'missing', srcPath, dest, srcSHA });
      continue;
    }
    if (!isRegularFile(dest)) {
      results.push({ file, status: 'non-regular', srcPath, dest, srcSHA });
      continue;
    }
    const onDiskBuf = readFileIfRegular(dest);
    if (onDiskBuf === null) {
      results.push({ file, status: 'unreadable', srcPath, dest, srcSHA });
      continue;
    }
    const onDiskSHA = sha256(onDiskBuf);
    if (onDiskSHA === srcSHA) {
      results.push({ file, status: 'up-to-date', srcPath, dest, srcSHA });
      continue;
    }
    const recordedSHA = recorded[file];
    if (recordedSHA && onDiskSHA === recordedSHA) {
      results.push({ file, status: 'stale', srcPath, dest, srcSHA, recordedSHA });
    } else {
      results.push({ file, status: 'user-modified', srcPath, dest, srcSHA, onDiskSHA });
    }
  }

  // Reconcile orphaned recorded entries (packages removed a command we previously installed)
  for (const file of Object.keys(recorded)) {
    if (packagedFiles.has(file)) continue;
    const dest = join(targetDir, file);
    results.push({ file, status: 'orphaned', dest, recordedSHA: recorded[file] });
  }
  return results;
}

function writeFreshAtomic(dest, content) {
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

function applyCommands(commandResults, force) {
  const targetDir = join(HOME, '.claude', 'commands', 'hypo');
  mkdirSync(targetDir, { recursive: true });

  const applied = [];
  const newSHAs = {};

  for (const c of commandResults) {
    if (c.status === 'up-to-date') {
      newSHAs[c.file] = c.srcSHA;
      continue;
    }
    if (c.status === 'missing') {
      writeFreshAtomic(c.dest, readFileSync(c.srcPath));
      newSHAs[c.file] = c.srcSHA;
      applied.push(c.file);
      continue;
    }
    if (c.status === 'stale') {
      // Compare-and-swap: re-verify just before write to avoid TOCTOU.
      const verifyBuf = readFileIfRegular(c.dest);
      const verifySHA = verifyBuf ? sha256(verifyBuf) : null;
      if (verifySHA !== c.recordedSHA) {
        // Something changed between check and apply — keep recorded SHA, skip.
        newSHAs[c.file] = c.recordedSHA;
        applied.push(`${c.file} (skipped — changed since check)`);
        continue;
      }
      writeFreshAtomic(c.dest, readFileSync(c.srcPath));
      newSHAs[c.file] = c.srcSHA;
      applied.push(c.file);
      continue;
    }
    if (c.status === 'user-modified') {
      if (force) {
        const buf = readFileIfRegular(c.dest);
        if (buf) writeFreshAtomic(c.dest + '.bak', buf);
        writeFreshAtomic(c.dest, readFileSync(c.srcPath));
        newSHAs[c.file] = c.srcSHA;
        applied.push(`${c.file} (force-overwritten, backup at ${c.file}.bak)`);
      } else {
        // Preserve user changes — only claim ownership if we already had it.
        // (user-modified is only reported when on-disk SHA != src SHA; the
        //  pre-existing ownership comes from the recorded map.)
        const recorded = readPkgRecordedCommands();
        if (recorded[c.file]) newSHAs[c.file] = recorded[c.file];
      }
      continue;
    }
    if (c.status === 'non-regular' || c.status === 'unreadable') {
      // Refuse silently — keep prior recorded SHA if any.
      const recorded = readPkgRecordedCommands();
      if (recorded[c.file]) newSHAs[c.file] = recorded[c.file];
      continue;
    }
    if (c.status === 'orphaned') {
      // Package no longer ships this command. Drop from recorded map; only
      // delete on-disk file if it still matches our recorded SHA (unmodified).
      if (existsSync(c.dest) && isRegularFile(c.dest)) {
        const buf = readFileIfRegular(c.dest);
        const sha = buf ? sha256(buf) : null;
        if (sha === c.recordedSHA) {
          unlinkSync(c.dest);
          applied.push(`${c.file} (orphaned — removed)`);
        } else {
          // Leave user-modified orphaned file alone.
          applied.push(`${c.file} (orphaned — user-modified, kept on disk)`);
        }
      }
      // Either way, drop the recorded entry.
      continue;
    }
  }

  // Persist atomically — single write per upgrade run.
  const path = pkgJsonPath();
  const existing = readPkgJsonSafe(path);
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')).version;
  } catch {}
  writePkgJsonAtomic(path, {
    ...existing,
    pkgRoot: PKG_ROOT,
    pkgVersion,
    schemaVersion: '1.0',
    commands: newSHAs,
  });
  return applied;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const schema = checkSchemaVersion(args.hypoDir);
const hooks = checkHookFiles();
const settings = checkSettingsJson();
const pkgJson = checkPkgJson();
const commands = checkCommands();
const oldHookRefs = checkOldHookNames();
const hypoignore = checkHypoignore(args.hypoDir);

const staleHooks = hooks.filter(
  (h) => h.status === 'stale' || h.status === 'missing' || h.status === 'src-missing',
);
const missingSettings = settings.filter((s) => s.status === 'missing');
const invalidSettings = settings.some((s) => s.status === 'invalid-json');
const schemaDrift = schema.bump !== 'none' && schema.bump !== 'unknown' && schema.bump !== 'ahead';
const pkgJsonDrift = pkgJson.status !== 'up-to-date';
const staleCommands = commands.filter((c) => c.status === 'stale' || c.status === 'missing');
const userModifiedCommands = commands.filter((c) => c.status === 'user-modified');
const orphanedCommands = commands.filter((c) => c.status === 'orphaned');
const nonRegularCommands = commands.filter(
  (c) => c.status === 'non-regular' || c.status === 'unreadable',
);

let migrationPath = null;
let appliedHooks = [];
let appliedSettings = [];
let appliedPkgJson = false;
let appliedHookNameRenames = [];
let appliedCommands = [];
let appliedHypoignore = [];

if (args.apply) {
  if (oldHookRefs.length > 0) {
    appliedHookNameRenames = applyHookNameMigration(oldHookRefs);
  }
  if (schema.bump === 'major' && schema.installed && schema.current && existsSync(args.hypoDir)) {
    migrationPath = writeMigrationReport(args.hypoDir, schema.installed, schema.current);
  }
  appliedHooks = applyHookFiles(hooks);
  appliedSettings = applySettingsJson(settings);
  // applyCommands handles the single atomic hypo-pkg.json write (pkgRoot, version, schema, commands map)
  appliedCommands = applyCommands(commands, args.forceCommands);
  appliedPkgJson = true;
  appliedHypoignore = applyHypoignoreMigration(hypoignore);
}

// ── output ───────────────────────────────────────────────────────────────────

const hasDrift =
  staleHooks.length > 0 ||
  missingSettings.length > 0 ||
  schemaDrift ||
  invalidSettings ||
  pkgJsonDrift ||
  oldHookRefs.length > 0 ||
  staleCommands.length > 0 ||
  userModifiedCommands.length > 0 ||
  orphanedCommands.length > 0 ||
  nonRegularCommands.length > 0 ||
  hypoignore.status === 'needs-migration';

if (args.json) {
  console.log(
    JSON.stringify(
      {
        schema,
        hooks,
        settings,
        pkgJson,
        commands,
        oldHookRefs,
        hypoignore,
        applied: {
          hooks: appliedHooks,
          settings: appliedSettings,
          pkgJson: appliedPkgJson,
          hookNameRenames: appliedHookNameRenames,
          commands: appliedCommands,
          hypoignore: appliedHypoignore,
        },
        migrationReport: migrationPath,
      },
      null,
      2,
    ),
  );
  process.exit(hasDrift && !args.apply ? 1 : 0);
}

// Human-readable report
const lines = [];

// Schema version
if (schema.bump === 'none') {
  lines.push(`✓ SCHEMA version    ${schema.installed} (up to date)`);
} else if (schema.bump === 'unknown') {
  lines.push(
    `⚠ SCHEMA version    installed=${schema.installed ?? 'not found'}, package=${schema.current ?? 'not found'} (cannot compare)`,
  );
} else if (schema.bump === 'ahead') {
  lines.push(
    `⚠ SCHEMA version    ${schema.installed} (installed is ahead of package ${schema.current})`,
  );
} else if (schema.bump === 'major') {
  lines.push(
    `✗ SCHEMA version    ${schema.installed} → ${schema.current}  [MAJOR — review MIGRATION report, update manually]`,
  );
} else {
  lines.push(
    `⚠ SCHEMA version    ${schema.installed} → ${schema.current}  [minor update — review and update SCHEMA.md manually]`,
  );
}

// Hook files
const upToDate = hooks.filter((h) => h.status === 'up-to-date').length;
const staleCount = hooks.filter((h) => h.status === 'stale').length;
const missCount = hooks.filter((h) => h.status === 'missing').length;
const srcMiss = hooks.filter((h) => h.status === 'src-missing').length;

if (staleCount === 0 && missCount === 0 && srcMiss === 0) {
  lines.push(`✓ Hook files        ${upToDate}/${hooks.length} up to date`);
} else {
  lines.push(
    `⚠ Hook files        ${upToDate} up to date, ${staleCount} stale, ${missCount} missing, ${srcMiss} src-missing:`,
  );
  for (const h of hooks) {
    if (h.status === 'up-to-date') {
      lines.push(`    ✓ ${h.file}`);
    } else if (h.status === 'stale') {
      lines.push(`    ⚠ ${h.file}  [stale — package has newer version]`);
    } else if (h.status === 'missing') {
      lines.push(`    ✗ ${h.file}  [not found in ~/.claude/hooks/]`);
    } else if (h.status === 'src-missing') {
      lines.push(`    ⚠ ${h.file}  [installed but missing from package — may be orphaned]`);
    }
  }
}

// settings.json
const regCount = settings.filter((s) => s.status === 'registered').length;
const missReg = settings.filter((s) => s.status === 'missing').length;

if (invalidSettings) {
  lines.push(`✗ settings.json     invalid JSON — fix or back it up before re-running`);
} else if (missReg === 0) {
  lines.push(`✓ settings.json     ${regCount}/${settings.length} hook registrations present`);
} else {
  lines.push(
    `⚠ settings.json     ${regCount}/${settings.length} registrations present — ${missReg} missing:`,
  );
  for (const s of settings) {
    if (s.status === 'missing') lines.push(`    + ${s.event}: ${s.file}`);
  }
}

// Package metadata
if (pkgJson.status === 'up-to-date') {
  lines.push(`✓ Package metadata  hypo-pkg.json up to date`);
} else if (pkgJson.status === 'stale') {
  lines.push(
    `⚠ Package metadata  hypo-pkg.json stale (${pkgJson.installed} → ${pkgJson.current}) — run --apply to update`,
  );
} else {
  lines.push(`✗ Package metadata  hypo-pkg.json missing — run --apply to install`);
}

// Slash commands
const cmdUpToDate = commands.filter((c) => c.status === 'up-to-date').length;
const cmdStaleCount = commands.filter((c) => c.status === 'stale').length;
const cmdMissCount = commands.filter((c) => c.status === 'missing').length;
const cmdUserCount = userModifiedCommands.length;
const cmdOrphanCount = orphanedCommands.length;
const cmdNonRegCount = nonRegularCommands.length;
if (commands.length === 0) {
  lines.push(`⚠ Slash commands    package commands/ is empty`);
} else if (
  cmdStaleCount === 0 &&
  cmdMissCount === 0 &&
  cmdUserCount === 0 &&
  cmdOrphanCount === 0 &&
  cmdNonRegCount === 0
) {
  lines.push(
    `✓ Slash commands    ${cmdUpToDate}/${commands.length} up to date in ~/.claude/commands/hypo/`,
  );
} else {
  lines.push(
    `⚠ Slash commands    ${cmdUpToDate} up to date, ${cmdStaleCount} stale, ${cmdMissCount} missing, ${cmdUserCount} user-modified, ${cmdOrphanCount} orphaned, ${cmdNonRegCount} non-regular:`,
  );
  for (const c of commands) {
    if (c.status === 'up-to-date') lines.push(`    ✓ ${c.file}`);
    else if (c.status === 'stale')
      lines.push(`    ⚠ ${c.file}  [stale — package has newer version]`);
    else if (c.status === 'missing') lines.push(`    ✗ ${c.file}  [not installed]`);
    else if (c.status === 'user-modified')
      lines.push(`    ⚠ ${c.file}  [user-modified — use --apply --force-commands to overwrite]`);
    else if (c.status === 'orphaned')
      lines.push(
        `    ⊘ ${c.file}  [orphaned — no longer shipped by package; --apply will reconcile]`,
      );
    else if (c.status === 'non-regular')
      lines.push(`    ✗ ${c.file}  [not a regular file (symlink?) — refusing to touch]`);
    else if (c.status === 'unreadable')
      lines.push(`    ✗ ${c.file}  [unreadable — refusing to touch]`);
  }
}

// Old hook names (wiki-*.mjs → hypo-*.mjs rename migration)
if (oldHookRefs.length > 0) {
  lines.push(
    `⚠ Hook name migration  ${oldHookRefs.length} old wiki-*.mjs reference(s) in settings.json — run --apply to rename:`,
  );
  for (const r of oldHookRefs)
    lines.push(`    ${r.event}: ${r.oldName} → ${HOOK_RENAMES[r.oldName]}`);
} else {
  lines.push(`✓ Hook names        All hook references use current hypo-*.mjs names`);
}

// .hypoignore migration (ensure required runtime patterns are present)
if (hypoignore.status === 'no-file') {
  lines.push(`⚠ .hypoignore       not found at ${hypoignore.path} (init.mjs scaffolds this)`);
} else if (hypoignore.status === 'up-to-date') {
  lines.push(`✓ .hypoignore       required entries present`);
} else {
  lines.push(
    `⚠ .hypoignore       ${hypoignore.missing.length} missing entry(s) — run --apply to append:`,
  );
  for (const e of hypoignore.missing) lines.push(`    + ${e.pattern}`);
}

// Migration report notice
if (migrationPath) {
  lines.push('');
  lines.push(`📋 Migration report: ${migrationPath}`);
  lines.push(`   Review and update SCHEMA.md manually — auto-overwrite is intentionally disabled.`);
}

// Applied actions
if (
  appliedHooks.length > 0 ||
  appliedSettings.length > 0 ||
  appliedPkgJson ||
  appliedHookNameRenames.length > 0 ||
  appliedCommands.length > 0 ||
  appliedHypoignore.length > 0
) {
  lines.push('');
  if (appliedHookNameRenames.length > 0) {
    lines.push(`✓ Renamed legacy hook references (${appliedHookNameRenames.length}):`);
    for (const r of appliedHookNameRenames) lines.push(`    → ${r}`);
  }
  if (appliedHooks.length > 0) {
    lines.push(`✓ Updated hook files (${appliedHooks.length}):`);
    for (const f of appliedHooks) lines.push(`    → ${f}`);
  }
  if (appliedCommands.length > 0) {
    lines.push(`✓ Updated slash commands (${appliedCommands.length}):`);
    for (const f of appliedCommands) lines.push(`    → ${f}`);
  }
  if (appliedSettings.length > 0) {
    lines.push(`✓ Merged settings.json entries (${appliedSettings.length}):`);
    for (const e of appliedSettings) lines.push(`    → ${e}`);
  }
  if (appliedPkgJson) {
    lines.push(`✓ Written package metadata: ~/.claude/hypo-pkg.json`);
  }
  if (appliedHypoignore.length > 0) {
    lines.push(`✓ Appended .hypoignore entries (${appliedHypoignore.length}):`);
    for (const e of appliedHypoignore) lines.push(`    → ${e}`);
  }
}

// Summary
lines.push('');
const totalDrift =
  staleHooks.length +
  missingSettings.length +
  (schemaDrift ? 1 : 0) +
  (invalidSettings ? 1 : 0) +
  (pkgJsonDrift ? 1 : 0) +
  oldHookRefs.length +
  staleCommands.length +
  userModifiedCommands.length +
  orphanedCommands.length +
  nonRegularCommands.length +
  (hypoignore.status === 'needs-migration' ? hypoignore.missing.length : 0);
if (totalDrift === 0) {
  lines.push('Result: Hypomnema is up to date');
} else if (args.apply) {
  const total =
    appliedHooks.length +
    appliedSettings.length +
    (appliedPkgJson ? 1 : 0) +
    appliedHookNameRenames.length +
    appliedHypoignore.length;
  lines.push(`Result: ${total} update(s) applied. Run /hypo:doctor to verify.`);
} else {
  lines.push(`Result: ${totalDrift} item(s) need updating — run with --apply to install`);
}

console.log(lines.join('\n'));

process.exit(hasDrift && !args.apply ? 1 : 0);
