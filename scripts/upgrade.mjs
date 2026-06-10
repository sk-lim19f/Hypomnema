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
 *   --force-commands    Overwrite user-modified slash command files (creates .bak)
 *   --force-extensions  Overwrite user-modified / conflicting extension copies (creates .bak)
 *   --codex             Mirror to ~/.codex/{hooks,commands,settings.json} — core
 *                       hook drift/apply, settings.json registration, the
 *                       wiki-*.mjs → hypo-*.mjs rename migration, and
 *                       the user-extensions companion sync (E4).
 *   --json              Output results as JSON
 *   --allow-downgrade   Override the guard that refuses to overwrite a NEWER
 *                       active install with an older package (ADR 0038)
 *   --allow-dual-install  Override the dual-install guard: register the Claude core
 *                       surface even though the Hypomnema plugin is also enabled
 *                       (knowingly accept the double-registration risk)
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
import { syncExtensions } from './lib/extensions.mjs';
import { isHypomnemaPluginEnabled } from './lib/plugin-detect.mjs';
import { classifyInstall, downgradeGuardMessage } from '../hooks/version-check.mjs';

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
  const args = {
    hypoDir: null,
    apply: false,
    json: false,
    forceCommands: false,
    forceExtensions: false,
    codex: false,
    allowDowngrade: false,
    allowDualInstall: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--force-commands') args.forceCommands = true;
    else if (arg === '--force-extensions') args.forceExtensions = true;
    else if (arg === '--codex') args.codex = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--allow-downgrade') args.allowDowngrade = true;
    else if (arg === '--allow-dual-install') args.allowDualInstall = true;
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

// Target-aware: the same core-hook integrity check runs against ~/.claude/hooks/
// for the default claude target, and against ~/.codex/hooks/ when --codex is set
// (ADR 0024). The function reads only — apply happens in applyHookFiles.
function checkHookFiles(hooksDir) {
  const results = [];

  const allFiles = [...Object.values(HOOK_MAP).flat(), ...SHARED_FILES];
  for (const file of allFiles) {
    const installedPath = join(hooksDir, file);
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

// Same target-aware shape as checkHookFiles — the registered command string is
// reconstructed from `hooksDir`, so a codex check verifies that ~/.codex/settings.json
// references ~/.codex/hooks/<file>.mjs (not the claude path).
function checkSettingsJson(settingsPath, hooksDir) {
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

// `hooksDir` is the target the stale/missing paths in `hookResults` already point
// at (the check above embeds the absolute installedPath). The directory is created
// up front so first-time codex installs (~/.codex/hooks/ absent) succeed.
function applyHookFiles(hookResults, hooksDir) {
  mkdirSync(hooksDir, { recursive: true });

  const applied = [];
  for (const h of hookResults) {
    if ((h.status === 'stale' || h.status === 'missing') && existsSync(h.srcPath)) {
      copyFileSync(h.srcPath, h.installedPath);
      applied.push(h.file);
    }
  }
  return applied;
}

function applySettingsJson(settingsResults, settingsPath) {
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
    // re-check the current parsed settings before appending.
    // applyHookNameMigration may have rewritten a legacy wiki-*.mjs command to
    // exactly `s.cmd` between checkSettingsJson and now — appending without
    // this guard creates a duplicate registration (codex 2-worker review
    // reproduced 11 duplicate hypo-*.mjs entries on a wiki-only legacy settings
    // file). The precheck list is allowed to be stale; the apply path must
    // self-heal against the on-disk truth.
    const alreadyPresent = settings.hooks[s.event]
      .flatMap((g) => g.hooks || [])
      .some((h) => h.command === s.cmd);
    if (alreadyPresent) continue;
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

// Same target-aware shape: scans either ~/.claude/settings.json or ~/.codex/settings.json
// for v1.0/v1.1 `wiki-*.mjs` references that need renaming to `hypo-*.mjs`.
function checkOldHookNames(settingsPath) {
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

function applyHookNameMigration(oldRefs, settingsPath, hooksDir) {
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
    // Copy renamed hook files to the target hooks dir (~/.claude/hooks or
    // ~/.codex/hooks per the caller — codex mirror).
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

function writeMigrationReport(hypoDir, fromVersion, toVersion, { pluginMode = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `MIGRATION-v${toVersion}.md`;
  const dest = join(hypoDir, filename);

  // Don't overwrite an existing report
  if (existsSync(dest)) return dest;

  // v1 → v2 specific guidance for the ADR 0031 feedback classification bump.
  // Other major jumps fall back to the generic body. ADR 0034 reserves the
  // right to keep SCHEMA.md as user-owned (Option C); auto-stub of the 9 new
  // fields is rejected because scope/tier/targets/sensitivity/reason/source
  // are semantic decisions whose wrong defaults would project wrong behavior.
  const isV1ToV2 = fromVersion === '1.0' && toVersion === '2.0';
  const specificBody = isV1ToV2
    ? `## What changed in SCHEMA 2.0

ADR 0031 (\`projects/hypomnema/decisions/0031-feedback-as-sot-external-memory-projection.md\`)
made \`feedback\` pages the single source of truth for behavior corrections and added
**9 hard-required frontmatter fields** for every \`feedback\` page:

- \`status\` (active | superseded | archived)
- \`scope\` (global | project:<project-id>)
- \`tier\` (L1 | L2)
- \`targets\` (project-memory and/or claude-learned)
- \`sensitivity\` (public | sanitized) — \`private\` is forbidden
- \`priority\` (1–5)
- \`memory_summary\` (one line for MEMORY.md index)
- \`reason\` (why the rule exists)
- \`source\` (session:YYYY-MM-DD | commit:<hash> | pr:<n> | URL)

**Conditional (when \`targets\` includes \`claude-learned\`):** \`global_summary\`
and \`promote_to_global\` become required (set \`promote_to_global: true\`), and
the page MUST also be \`scope: global\` + \`tier: L1\`. A claude-learned page
that does not satisfy all four is rejected by both \`hypomnema lint\` and
\`hypomnema feedback\` (see \`scripts/lint.mjs\` and \`scripts/feedback.mjs\`
enforcement).

ADR 0034 records this schema bump and the reasoning (semver-major because
existing feedback pages without these fields now fail \`hypomnema lint\`).

## Action items — existing wiki

Run \`hypomnema lint\` first to see exactly which feedback pages are missing
fields. Then **manually** backfill each \`pages/feedback/*.md\` — the upgrade
deliberately does NOT auto-stub the 9 fields because wrong defaults for
\`scope\` / \`tier\` / \`targets\` / \`sensitivity\` / \`reason\` / \`source\` would
silently project wrong behavior into MEMORY.md or CLAUDE.md.

\`SCHEMA.md\` is intentionally **not** overwritten by upgrade (Option C); the
checklist below is manual:

- [ ] Run \`hypomnema lint\` and read the per-file errors for type \`feedback\`
- [ ] Backfill the 9 fields in each \`pages/feedback/*.md\` (use an existing
      valid page as a template; see \`templates/pages/_index.md\` if present)
- [ ] **Fix incomplete feedback pages BEFORE running \`/hypo:feedback\` append**
      — append mode preserves existing frontmatter, so a partial page stays
      partial
- [ ] Compare your \`SCHEMA.md\` (v${fromVersion}) with the package template
      (v${toVersion}) and merge changes manually — only the \`version:\` line
      and the \`feedback\` type section under §3 are load-bearing for the
      hard-required fields above
- [ ] Run \`hypomnema feedback-sync --check\` to verify the MEMORY/CLAUDE
      projection still resolves cleanly
- [ ] Run \`hypomnema doctor\` to verify installation health
- [ ] **Re-run \`hypomnema lint\` after backfilling — confirm 0 feedback errors
      remain (including the conditional \`claude-learned\` fields above)**

## Note — \`scope: project:<project-id>\` and the scope regex

As of v1.3.0 the feedback scope regex \`^(global|project:[A-Za-z0-9_-]+)\$\`
accepts cwd-derived project-ids directly (e.g.
\`-Users-you-Workspace-Project\`), so a \`scope: project:*\` page no longer needs
a \`--project-id=<slug>\` override just to pass \`lint\`. The resolved id must
still exact-match \`feedback-sync\`'s project-id for projection (default: cwd
with \`/\` and \`.\` replaced by \`-\`). Known limit: a cwd containing spaces or
other characters outside \`[A-Za-z0-9_-]\` still derives an id the regex
rejects — pass \`--project-id=<id>\` for those.
`
    : `## What changed

This is a **major version bump** (v${fromVersion} → v${toVersion}).
Review the SCHEMA diff and update your wiki pages accordingly.

## Action items

This report was generated during \`/hypo:upgrade --apply\`. ${
        pluginMode
          ? 'You are on a **plugin install**, so the core hook files and settings.json hook ' +
            'registrations were NOT touched — the Claude Code plugin loader owns them (upgrade the ' +
            'plugin via `/plugin marketplace update hypomnema` then `/reload-plugins`). Vault ' +
            'extensions, if any, were still synced.'
          : 'Hook files and settings.json entries were applied by that run (or skipped with a ' +
            'warning if the target was malformed — see the upgrade output).'
      } \`SCHEMA.md\` is intentionally **not** overwritten by upgrade — the
remaining steps are manual:

- [ ] Compare your \`SCHEMA.md\` (v${fromVersion}) with the package template (v${toVersion}) and merge changes manually
- [ ] Re-check all \`adr\` and \`learning\` pages for new required frontmatter fields once SCHEMA is updated
- [ ] Run \`/hypo:doctor\` to verify installation health
`;

  const content = `---
title: Migration Report — v${fromVersion} → v${toVersion}
type: reference
updated: ${today}
tags: [schema]
---

# Migration Report: v${fromVersion} → v${toVersion}

Generated by \`/hypo:upgrade\` on ${today}.

${specificBody}
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
    schemaVersion: '2.0',
    commands: newSHAs,
  });
  return applied;
}

// In plugin mode `applyCommands` is skipped (no command copy), but the
// runtime still needs hypo-pkg.json to resolve PKG_ROOT for lint/feedback scripts
// (hooks/hypo-shared.mjs → hypo-personal-check). Write minimal metadata pointing
// at the plugin's package root, preserving any existing fields (e.g. `extensions`)
// but DROPPING any prior `commands` map (no commands were copied, so a stale map
// would falsely assert ownership of ~/.claude/commands/hypo).
function writePluginModeMetadata() {
  const path = pkgJsonPath();
  // Drop any prior top-level `commands` SHA map: no commands were copied in plugin
  // mode, so keeping a manual install's map would falsely assert ownership of
  // ~/.claude/commands/hypo. Preserve every other field (e.g. `extensions`).
  const { commands: _droppedCommands, ...existing } = readPkgJsonSafe(path) || {};
  let pkgVersion = null;
  try {
    pkgVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')).version;
  } catch {}
  writePkgJsonAtomic(path, {
    ...existing,
    pkgRoot: PKG_ROOT,
    pkgVersion,
    schemaVersion: '2.0',
  });
  return true;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

// Target paths. Claude is always checked; codex is checked only when --codex is set
// (ADR 0024) so users without codex installed see no false drift.
const claudeHooksDir = join(HOME, '.claude', 'hooks');
const claudeSettingsPath = join(HOME, '.claude', 'settings.json');
const codexHooksDir = join(HOME, '.codex', 'hooks');
const codexSettingsPath = join(HOME, '.codex', 'settings.json');

// When `/hypo:upgrade` runs as the Claude Code PLUGIN, the 15 core hooks
// and 14 slash commands are provided by the plugin's hooks.json + commands/
// (auto-wired by Claude Code), NOT copied into ~/.claude/. The manual/npm health
// check below would then report all of them "missing" and recommend `--apply`,
// which copies the hooks into ~/.claude/hooks/ and registers 14 settings.json
// events → Claude Code runs BOTH the plugin hooks.json AND user settings.json, so
// every hook fires TWICE. The decisive signal: the plugin command runs the
// PLUGIN's upgrade.mjs, so PKG_ROOT lives under ~/.claude/plugins/. (A manual/npm
// upgrade.mjs run while the plugin is ALSO enabled is a different failure mode —
// dual install — handled by the guard below.)
// Match the Claude plugin cache shape specifically (`~/.claude/plugins/…`), NOT a
// generic `/plugins/` substring — this flag now GATES install behavior, so a
// legitimate npm/dev checkout under some unrelated `…/plugins/…` path must not be
// misclassified and silently stop managing its hooks. (detectChannel's broad
// `/plugins/` test is fine for the notifier's display-only use, but too loose here.)
const pluginMode = PKG_ROOT.replace(/\\/g, '/').includes('/.claude/plugins/');
// Dual install: the OTHER way the same double-registration can happen.
// Here the MANUAL/npm upgrade.mjs is running (pluginMode=false), but the Hypomnema
// plugin is ALSO enabled in ~/.claude/settings.json — so the plugin loader already
// provides the core hooks/commands/settings. A manual/npm `--apply` would copy and
// register them on top, and every core hook fires twice. The detector is fail-open
// (see lib/plugin-detect.mjs): a false positive would wrongly alter a legitimate
// npm-only user's upgrade, so it only fires on an exact `hypo@<mp>: true` (or the
// legacy `hypomnema@<mp>: true`, matched across the plugin-rename migration window).
const hypomnemaPluginEnabled = !pluginMode && isHypomnemaPluginEnabled(claudeSettingsPath);
const dualInstallCoreConflict = hypomnemaPluginEnabled;
// Surface policy: the Claude core surface (hooks/settings/commands/hook-name
// migration) is skipped when EITHER the plugin runs this script (pluginMode) OR a
// manual/npm run detects the plugin is enabled (dualInstallCoreConflict) — unless
// the user knowingly overrides with --allow-dual-install. The codex core surface
// (--codex) and vault-defined extensions are NOT plugin-provided, so they stay
// managed in every case.
const managesClaudeCore = !pluginMode && (!dualInstallCoreConflict || args.allowDualInstall);
// dualSkip = core was skipped specifically because of the dual install (not a true
// plugin-mode run, and not overridden). Drives the warning banner and the metadata
// preservation below.
const dualSkip = dualInstallCoreConflict && !args.allowDualInstall;

const schema = checkSchemaVersion(args.hypoDir);
const hooks = checkHookFiles(claudeHooksDir);
const settings = checkSettingsJson(claudeSettingsPath, claudeHooksDir);
const pkgJson = checkPkgJson();
const commands = checkCommands();
const oldHookRefs = checkOldHookNames(claudeSettingsPath);
const hypoignore = checkHypoignore(args.hypoDir);

// when --codex is set, mirror the same core-hook checks against ~/.codex/
// so `hypomnema upgrade --codex` reports drift symmetrically and `--apply --codex`
// updates both targets in one pass (matching init.mjs behaviour).
const hooksCodex = args.codex ? checkHookFiles(codexHooksDir) : null;
const settingsCodex = args.codex ? checkSettingsJson(codexSettingsPath, codexHooksDir) : null;
const oldHookRefsCodex = args.codex ? checkOldHookNames(codexSettingsPath) : null;

// Extensions companion (ADR 0024). Read-only check; the apply
// happens below, AFTER applyCommands, so the per-target SHA map merges into the
// hypo-pkg.json that applyCommands writes (rather than being clobbered by it).
const extSettingsPath = claudeSettingsPath;
const extDir = join(args.hypoDir, 'extensions');
const extCheck = syncExtensions({
  extDir,
  hypoDir: args.hypoDir,
  target: 'claude',
  settingsPath: extSettingsPath,
  pkgPath: pkgJsonPath(),
  apply: false,
  force: args.forceExtensions,
});

// E4: --codex mirrors the extensions sync into ~/.codex (hooks + commands
// only; skills/agents skipped with a notice). The per-target SHA map lives in the
// same ~/.claude/hypo-pkg.json under extensions.codex, so pkgPath is unchanged.
const extCodexSettingsPath = codexSettingsPath;
const extCheckCodex = args.codex
  ? syncExtensions({
      extDir,
      hypoDir: args.hypoDir,
      target: 'codex',
      settingsPath: extCodexSettingsPath,
      pkgPath: pkgJsonPath(),
      apply: false,
      force: args.forceExtensions,
    })
  : null;

const staleHooks = hooks.filter(
  (h) => h.status === 'stale' || h.status === 'missing' || h.status === 'src-missing',
);
const missingSettings = settings.filter((s) => s.status === 'missing');
const invalidSettings = settings.some((s) => s.status === 'invalid-json');
const staleHooksCodex = hooksCodex
  ? hooksCodex.filter(
      (h) => h.status === 'stale' || h.status === 'missing' || h.status === 'src-missing',
    )
  : [];
const missingSettingsCodex = settingsCodex
  ? settingsCodex.filter((s) => s.status === 'missing')
  : [];
const invalidSettingsCodex = settingsCodex
  ? settingsCodex.some((s) => s.status === 'invalid-json')
  : false;
const schemaDrift = schema.bump !== 'none' && schema.bump !== 'unknown' && schema.bump !== 'ahead';
// Dual-install: when core is skipped, hypo-pkg.json is deliberately left
// pointing at the PLUGIN's package root (preserved identity), so checkPkgJson()
// reports it 'stale' relative to this npm/manual PKG_ROOT. That mismatch is
// INTENTIONAL — `--apply` will not (and must not) rewrite it — so it must not
// count as actionable drift, or the user would be nagged to run --apply forever.
// A genuinely missing/corrupt file (status 'missing') is still surfaced (warning
// below), because the runtime then cannot resolve its package root at all.
const pkgJsonDrift = pkgJson.status !== 'up-to-date' && !(dualSkip && pkgJson.status === 'stale');
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
let appliedHooksCodex = [];
let appliedSettingsCodex = [];
let appliedHookNameRenamesCodex = [];
let appliedCommands = [];
let appliedHypoignore = [];
let appliedExtensions = null;
let appliedExtensionsCodex = null;

if (args.apply) {
  // Downgrade guard (ADR 0038, P): an `--apply` from an OLDER package than the
  // active install would overwrite newer hooks (upgrade.mjs:287 copyFileSync) and
  // rewrite hypo-pkg.json to the older version. Refuse before the first mutation.
  // A dev workspace re-running its own --apply (incl. the post-commit sync hook)
  // is exempt via realpath'd pkgRoot equality. Exit 2 = refused downgrade.
  if (!args.allowDowngrade) {
    const _active = readPkgJsonSafe(pkgJsonPath());
    let _incomingVersion = null;
    try {
      _incomingVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')).version;
    } catch {
      /* unreadable own package.json — cannot prove a downgrade, allow */
    }
    if (
      _active &&
      _active.pkgVersion &&
      _incomingVersion &&
      classifyInstall(
        { pkgRoot: PKG_ROOT, version: _incomingVersion },
        { pkgRoot: _active.pkgRoot, version: _active.pkgVersion },
      ) === 'downgrade'
    ) {
      console.error(downgradeGuardMessage(_incomingVersion, _active.pkgVersion, 'upgrade --apply'));
      process.exit(2);
    }
  }
  // Migration report is vault-side (writes into the Hypomnema root) and applies
  // in both install models.
  if (schema.bump === 'major' && schema.installed && schema.current && existsSync(args.hypoDir)) {
    migrationPath = writeMigrationReport(args.hypoDir, schema.installed, schema.current, {
      // Use the core-skipped predicate, not raw pluginMode: in a dual-install skip
      // the core surface is plugin-owned too, so the report must not claim the
      // core hooks/settings were applied.
      pluginMode: !managesClaudeCore,
    });
  }
  if (managesClaudeCore) {
    if (oldHookRefs.length > 0) {
      appliedHookNameRenames = applyHookNameMigration(
        oldHookRefs,
        claudeSettingsPath,
        claudeHooksDir,
      );
    }
    appliedHooks = applyHookFiles(hooks, claudeHooksDir);
    appliedSettings = applySettingsJson(settings, claudeSettingsPath);
    // applyCommands handles the single atomic hypo-pkg.json write (pkgRoot, version, schema, commands map)
    appliedCommands = applyCommands(commands, args.forceCommands);
    appliedPkgJson = true;
  } else if (pluginMode) {
    // Plugin mode: the plugin loader owns the core hooks/commands and
    // settings.json wiring — copying them here would double-register. Skip those,
    // but STILL write minimal package metadata so the runtime can resolve PKG_ROOT
    // for lint/feedback scripts (hooks/hypo-shared.mjs → hypo-personal-check). The
    // commands SHA map is intentionally omitted (no command copy happened). PKG_ROOT
    // is the plugin's own path here, so this metadata is authoritative.
    appliedPkgJson = writePluginModeMetadata();
  } else {
    // Dual-install skip: a manual/npm run while the plugin is enabled. We
    // skip the core surface (the plugin owns it), but — unlike true plugin mode —
    // PKG_ROOT here is the npm/manual path while the ACTIVE runtime hooks are the
    // PLUGIN's. Rewriting a VALID hypo-pkg.json.pkgRoot to this npm path would
    // mis-point the plugin runtime's lint/feedback resolution, so we PRESERVE an
    // existing plugin-written identity (pkgJson.status 'stale'/'up-to-date' both
    // mean a usable pkgRoot is already on disk) and do not touch it.
    //
    // If the metadata is MISSING or corrupt (status 'missing'; corrupt files are
    // renamed to *.corrupt-*.json by readPkgJson and then read as absent), there is
    // no plugin identity to preserve. Write minimal fallback metadata pointing at
    // this (same-version) npm copy so the plugin runtime can resolve a package root
    // at all — strictly better than the pkgRoot-less file extension sync would
    // otherwise create, or no file at all. The dual-install banner still tells the
    // user to resolve the dual install.
    if (pkgJson.status === 'missing') {
      appliedPkgJson = writePluginModeMetadata();
    } else {
      appliedPkgJson = false;
    }
  }
  appliedHypoignore = applyHypoignoreMigration(hypoignore);
  // codex core hooks + settings + wiki-*→hypo-* rename mirror. Same order
  // as the claude side (rename first so subsequent hook copy can find renamed targets).
  if (args.codex) {
    if (oldHookRefsCodex.length > 0) {
      appliedHookNameRenamesCodex = applyHookNameMigration(
        oldHookRefsCodex,
        codexSettingsPath,
        codexHooksDir,
      );
    }
    appliedHooksCodex = applyHookFiles(hooksCodex, codexHooksDir);
    appliedSettingsCodex = applySettingsJson(settingsCodex, codexSettingsPath);
  }
  // After applyCommands wrote hypo-pkg.json — merges extensions.<target> alongside.
  appliedExtensions = syncExtensions({
    extDir,
    hypoDir: args.hypoDir,
    target: 'claude',
    settingsPath: extSettingsPath,
    pkgPath: pkgJsonPath(),
    apply: true,
    force: args.forceExtensions,
  });
  // E4: codex apply runs AFTER the claude apply so it reads the freshly
  // written hypo-pkg.json and merges extensions.codex alongside extensions.claude
  // (the per-target spread in syncExtensions preserves the other target's map).
  if (args.codex) {
    appliedExtensionsCodex = syncExtensions({
      extDir,
      hypoDir: args.hypoDir,
      target: 'codex',
      settingsPath: extCodexSettingsPath,
      pkgPath: pkgJsonPath(),
      apply: true,
      force: args.forceExtensions,
    });
  }
}

// ── output ───────────────────────────────────────────────────────────────────

const extDrift = extCheck.needsWork || (extCheckCodex?.needsWork ?? false);

// codex drift only counts when --codex is set — without the flag the codex
// target is intentionally unobserved (parity with the existing extensions pattern).
const codexCoreDrift =
  args.codex &&
  (staleHooksCodex.length > 0 ||
    missingSettingsCodex.length > 0 ||
    invalidSettingsCodex ||
    (oldHookRefsCodex?.length ?? 0) > 0);

// Claude core-surface drift (hooks/settings/commands/rename/metadata). In plugin
// mode these are plugin-managed, so they must NOT count as drift — otherwise the
// report nags "N items need updating" and recommends a double-registering --apply.
// Plugin-provided surface (hooks/settings/commands/rename) — excluded from drift
// in plugin mode. pkgJsonDrift is intentionally NOT here: hypo-pkg.json is written
// in BOTH install models (plugin mode writes minimal metadata so the runtime can
// resolve PKG_ROOT for lint/feedback), so a missing/stale metadata file should
// still prompt a (safe, metadata-only) --apply.
const claudeCoreDrift =
  staleHooks.length > 0 ||
  missingSettings.length > 0 ||
  invalidSettings ||
  oldHookRefs.length > 0 ||
  staleCommands.length > 0 ||
  userModifiedCommands.length > 0 ||
  orphanedCommands.length > 0 ||
  nonRegularCommands.length > 0;

const hasDrift =
  (managesClaudeCore && claudeCoreDrift) ||
  pkgJsonDrift ||
  schemaDrift ||
  hypoignore.status === 'needs-migration' ||
  extDrift ||
  codexCoreDrift;

if (args.json) {
  console.log(
    JSON.stringify(
      {
        pluginMode,
        // Dual-install signals.
        hypomnemaPluginEnabled,
        dualInstallCoreConflict,
        coreManagedBy: managesClaudeCore ? 'self' : pluginMode ? 'plugin' : 'plugin-enabled',
        dualInstallOverride: args.allowDualInstall,
        schema,
        hooks,
        settings,
        pkgJson,
        commands,
        oldHookRefs,
        hypoignore,
        extensions: extCheck,
        extensionsCodex: extCheckCodex,
        // codex core mirror (null when --codex absent).
        hooksCodex,
        settingsCodex,
        oldHookRefsCodex,
        applied: {
          hooks: appliedHooks,
          settings: appliedSettings,
          pkgJson: appliedPkgJson,
          hookNameRenames: appliedHookNameRenames,
          commands: appliedCommands,
          hypoignore: appliedHypoignore,
          extensions: appliedExtensions,
          extensionsCodex: appliedExtensionsCodex,
          hooksCodex: appliedHooksCodex,
          settingsCodex: appliedSettingsCodex,
          hookNameRenamesCodex: appliedHookNameRenamesCodex,
        },
        migrationReport: migrationPath,
      },
      null,
      2,
    ),
  );
  process.exit(
    (hasDrift && !args.apply) ||
      extCheck.conflicts.length > 0 ||
      (extCheckCodex?.conflicts.length ?? 0) > 0
      ? 1
      : 0,
  );
}

// Human-readable report
const lines = [];

// Lead with the plugin-mode banner so the user understands why the core
// hook/command/settings sections read "managed by plugin" and that `--apply` will
// NOT touch them (only vault-side migrations + package metadata).
if (pluginMode) {
  lines.push(
    'ℹ Plugin install detected — Hypomnema is loaded via the Claude Code plugin.',
    '  Core hooks, slash commands, and settings.json wiring are provided by the',
    '  plugin loader, so `/hypo:upgrade` does NOT manage them (and `--apply` will',
    '  not copy/register them — that would double-register every hook).',
    '  → To upgrade the plugin: `/plugin marketplace update hypomnema` then `/reload-plugins`.',
    '  → `/hypo:upgrade --apply` here applies vault-side migrations (SCHEMA,',
    '    .hypoignore), refreshes package metadata, and still syncs any vault',
    '    extensions — but does NOT install the core hooks/commands/settings.',
    '',
  );
}

// Dual install: a manual/npm upgrade.mjs is running while the Hypomnema plugin is ALSO
// enabled — a dual install. Lead with a loud banner: the core surface is owned by
// the plugin and is intentionally skipped, so `--apply` will not double-register.
if (dualSkip) {
  lines.push(
    '⚠ Dual install detected — you are running the MANUAL/npm `upgrade.mjs`, but the',
    '  Hypomnema plugin is ALSO enabled in ~/.claude/settings.json. The plugin loader',
    '  already provides the core hooks, slash commands, and settings.json wiring, so',
    '  this run does NOT copy/register them (doing so would double-register every hook).',
    '  → Recommended: pick ONE install. To keep the plugin, remove the npm/manual copy',
    '    (`npm uninstall -g hypomnema`) and upgrade via `/plugin marketplace update',
    '    hypomnema` + `/reload-plugins`. Vault extensions + codex (if any) are still synced.',
    '  → To register the core surface here anyway (knowingly accept the double-register',
    '    risk), re-run with `--allow-dual-install`.',
    '',
  );
} else if (dualInstallCoreConflict && args.allowDualInstall) {
  // Override path: the user forced core registration despite the enabled plugin.
  lines.push(
    '⚠ Dual install — `--allow-dual-install` set: registering the Claude core surface',
    '  even though the Hypomnema plugin is enabled. Every core hook may now fire TWICE',
    '  (plugin loader + ~/.claude registration) until one install is removed.',
    '',
  );
}

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
    `✗ SCHEMA version    ${schema.installed} → ${schema.current}  [MAJOR — --apply writes MIGRATION report; SCHEMA must be merged manually]`,
  );
} else {
  lines.push(
    `⚠ SCHEMA version    ${schema.installed} → ${schema.current}  [minor update — review and update SCHEMA.md manually]`,
  );
}

// Hook files (target-aware so --codex can mirror the same block).
function pushHookSummary(hookList, label, targetPath) {
  const colHook = `Hook files${label}`.padEnd(20);
  const up = hookList.filter((h) => h.status === 'up-to-date').length;
  const st = hookList.filter((h) => h.status === 'stale').length;
  const mi = hookList.filter((h) => h.status === 'missing').length;
  const sm = hookList.filter((h) => h.status === 'src-missing').length;
  if (st === 0 && mi === 0 && sm === 0) {
    lines.push(`✓ ${colHook}${up}/${hookList.length} up to date`);
  } else {
    lines.push(`⚠ ${colHook}${up} up to date, ${st} stale, ${mi} missing, ${sm} src-missing:`);
    for (const h of hookList) {
      if (h.status === 'up-to-date') {
        lines.push(`    ✓ ${h.file}`);
      } else if (h.status === 'stale') {
        lines.push(`    ⚠ ${h.file}  [stale — package has newer version]`);
      } else if (h.status === 'missing') {
        lines.push(`    ✗ ${h.file}  [not found in ${targetPath}]`);
      } else if (h.status === 'src-missing') {
        lines.push(`    ⚠ ${h.file}  [installed but missing from package — may be orphaned]`);
      }
    }
  }
}
if (managesClaudeCore) {
  pushHookSummary(hooks, '', '~/.claude/hooks/');
} else {
  lines.push(
    '✓ Hook files          provided by the plugin loader (not managed in ~/.claude/hooks/)',
  );
}
if (hooksCodex) pushHookSummary(hooksCodex, ' (codex)', '~/.codex/hooks/');

// settings.json registrations (target-aware mirror).
function pushSettingsSummary(sList, label, invalidFlag) {
  const colS = `settings.json${label}`.padEnd(20);
  const reg = sList.filter((s) => s.status === 'registered').length;
  const mr = sList.filter((s) => s.status === 'missing').length;
  if (invalidFlag) {
    lines.push(`✗ ${colS}invalid JSON — fix or back it up before re-running`);
  } else if (mr === 0) {
    lines.push(`✓ ${colS}${reg}/${sList.length} hook registrations present`);
  } else {
    lines.push(`⚠ ${colS}${reg}/${sList.length} registrations present — ${mr} missing:`);
    for (const s of sList) {
      if (s.status === 'missing') lines.push(`    + ${s.event}: ${s.file}`);
    }
  }
}
if (managesClaudeCore) {
  pushSettingsSummary(settings, '', invalidSettings);
} else {
  lines.push(
    '✓ settings.json       hook wiring provided by the plugin (no ~/.claude registration)',
  );
}
if (settingsCodex) pushSettingsSummary(settingsCodex, ' (codex)', invalidSettingsCodex);

// Package metadata
if (dualSkip && pkgJson.status === 'stale') {
  // Dual-install: the 'stale' here is the preserved plugin identity (pkgRoot points at
  // the plugin, not this npm/manual copy). That is intentional — not actionable.
  lines.push(
    `✓ Package metadata  hypo-pkg.json plugin-owned (preserved — not rewritten in a dual install)`,
  );
} else if (dualSkip && pkgJson.status === 'missing') {
  // Missing/corrupt in a dual install: there is no plugin identity to preserve, so
  // `--apply` writes minimal fallback metadata (pointing at this same-version npm
  // copy) — enough for the plugin runtime to resolve its scripts. The real fix is
  // still to resolve the dual install.
  lines.push(
    `⚠ Package metadata  hypo-pkg.json missing/unreadable — \`--apply\` writes fallback metadata`,
    `                    for this npm copy so the plugin runtime can resolve its scripts.`,
    `                    Better: resolve the dual install (remove the npm/manual copy).`,
  );
} else if (pkgJson.status === 'up-to-date') {
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
if (!managesClaudeCore) {
  lines.push('✓ Slash commands    provided by the plugin loader (not ~/.claude/commands/hypo/)');
} else if (commands.length === 0) {
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

// Old hook names (wiki-*.mjs → hypo-*.mjs rename migration). Target-aware so
// codex settings.json entries that still reference the v1.0/v1.1 names are surfaced.
function pushHookNameSummary(refs, label) {
  if (refs.length > 0) {
    lines.push(
      `⚠ Hook name migration${label}  ${refs.length} old wiki-*.mjs reference(s) — run --apply to rename:`,
    );
    for (const r of refs) lines.push(`    ${r.event}: ${r.oldName} → ${HOOK_RENAMES[r.oldName]}`);
  } else {
    const colN = `Hook names${label}`.padEnd(20);
    lines.push(`✓ ${colN}All hook references use current hypo-*.mjs names`);
  }
}
// In plugin mode the Claude settings.json is plugin-owned and --apply skips the
// rename migration, so do not print a "run --apply to rename" instruction it will
// not honor. (codex hook-name migration is unaffected by pluginMode.)
if (managesClaudeCore) pushHookNameSummary(oldHookRefs, '');
if (oldHookRefsCodex) pushHookNameSummary(oldHookRefsCodex, ' (codex)');

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

// Extensions companion (ADR 0024; conflict/drift gating E3, #31). Shared by the
// claude target and, under --codex, the codex target (E4, #32) — the label keeps
// the two blocks distinguishable in the report.
function pushExtSummary(check, label) {
  // Pad to fit the longest label ("Extensions (codex)" = 18) plus a separating
  // space so the count never glues onto the label.
  const col = `Extensions${label}`.padEnd(20);
  const pending = check.actions.filter(
    (a) => a.action === 'create' || a.action === 'update' || a.action === 'force-update',
  );
  const nConflicts = check.conflicts.length;
  const nDrifts = check.drifts.length;
  if (check.actions.length === 0 && check.warnings.length === 0) {
    lines.push(`✓ ${col}none found in ${extDir.replace(HOME, '~')}`);
  } else if (pending.length === 0 && nConflicts === 0 && nDrifts === 0) {
    const reg = check.registered.length;
    lines.push(`✓ ${col}${check.actions.length} synced${reg ? `, ${reg} hook(s) registered` : ''}`);
  } else {
    lines.push(
      `⚠ ${col}${pending.length} to sync, ${nConflicts} conflict(s), ${nDrifts} drift(s):`,
    );
    for (const a of pending) lines.push(`    + ${a.file}  [${a.action}]`);
    for (const c of check.conflicts) lines.push(`    ✗ ${c.file}  [${c.action} — left untouched]`);
    for (const d of check.drifts) lines.push(`    ⚠ ${d.file}  [drift — left untouched]`);
  }
  // E3: a hard conflict blocks install (exit 1, even under --apply); drift is
  // resolvable advisory. Emit the spec'd WIKI messages so the user knows the recovery.
  if (nConflicts > 0) {
    lines.push('  [WIKI: existing file conflicts. Backup and retry, or use --force-extensions]');
  }
  for (const d of check.drifts) {
    lines.push(
      `  [WIKI: extension ${d.name} drift detected. Use --force-extensions to overwrite.]`,
    );
  }
  for (const w of check.warnings) lines.push(`    ⚠ ${w}`);
}
pushExtSummary(extCheck, '');
if (extCheckCodex) pushExtSummary(extCheckCodex, ' (codex)');

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
  appliedHypoignore.length > 0 ||
  appliedHooksCodex.length > 0 ||
  appliedSettingsCodex.length > 0 ||
  appliedHookNameRenamesCodex.length > 0
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
  // codex-target applied actions (mirrors claude blocks above).
  if (appliedHookNameRenamesCodex.length > 0) {
    lines.push(`✓ Renamed legacy hook references (codex) (${appliedHookNameRenamesCodex.length}):`);
    for (const r of appliedHookNameRenamesCodex) lines.push(`    → ${r}`);
  }
  if (appliedHooksCodex.length > 0) {
    lines.push(`✓ Updated hook files (codex) (${appliedHooksCodex.length}):`);
    for (const f of appliedHooksCodex) lines.push(`    → ${f}`);
  }
  if (appliedSettingsCodex.length > 0) {
    lines.push(`✓ Merged settings.json entries (codex) (${appliedSettingsCodex.length}):`);
    for (const e of appliedSettingsCodex) lines.push(`    → ${e}`);
  }
}

function pushAppliedExt(applied, label) {
  if (!applied) return;
  const synced = applied.actions.filter(
    (a) => a.action === 'create' || a.action === 'update' || a.action === 'force-update',
  );
  if (synced.length > 0 || applied.settingsChanged) {
    lines.push('');
    if (synced.length > 0) {
      lines.push(`✓ Synced extensions${label} (${synced.length}):`);
      for (const a of synced) lines.push(`    → ${a.file} (${a.action})`);
    }
    if (applied.settingsChanged) {
      lines.push(`✓ Registered extension hooks${label} (${applied.registered.length}):`);
      for (const r of applied.registered) lines.push(`    → ${r}`);
    }
  }
}
pushAppliedExt(appliedExtensions, '');
pushAppliedExt(appliedExtensionsCodex, ' (codex)');

// Summary
lines.push('');
// Claude core-surface item count — zeroed in plugin mode (plugin-managed), so the
// summary never reads "N items need updating" for hooks/settings/commands.
const claudeCoreCount = managesClaudeCore
  ? staleHooks.length +
    missingSettings.length +
    (invalidSettings ? 1 : 0) +
    oldHookRefs.length +
    staleCommands.length +
    userModifiedCommands.length +
    orphanedCommands.length +
    nonRegularCommands.length
  : 0;

const totalDrift =
  claudeCoreCount +
  (pkgJsonDrift ? 1 : 0) +
  (schemaDrift ? 1 : 0) +
  (hypoignore.status === 'needs-migration' ? hypoignore.missing.length : 0) +
  extCheck.actions.filter(
    (a) => a.action === 'create' || a.action === 'update' || a.action === 'force-update',
  ).length +
  // E3: unresolved drift/conflict is pending work too — without these the
  // summary printed "up to date" while the exit code was 1.
  extCheck.conflicts.length +
  extCheck.drifts.length +
  // E4: codex-target pending work counts identically (same message/exit
  // consistency the E3 review caught — a codex conflict must not read "up to date").
  (extCheckCodex
    ? extCheckCodex.actions.filter(
        (a) => a.action === 'create' || a.action === 'update' || a.action === 'force-update',
      ).length +
      extCheckCodex.conflicts.length +
      extCheckCodex.drifts.length
    : 0) +
  // codex core mirror counts the same way as the claude side.
  staleHooksCodex.length +
  missingSettingsCodex.length +
  (invalidSettingsCodex ? 1 : 0) +
  (oldHookRefsCodex?.length ?? 0);
if (totalDrift === 0) {
  lines.push('Result: Hypomnema is up to date');
} else if (args.apply) {
  const countApplied = (r) =>
    r
      ? r.actions.filter(
          (a) => a.action === 'create' || a.action === 'update' || a.action === 'force-update',
        ).length + (r.settingsChanged ? 1 : 0)
      : 0;
  const appliedExtCount = countApplied(appliedExtensions) + countApplied(appliedExtensionsCodex);
  const total =
    appliedHooks.length +
    appliedSettings.length +
    (appliedPkgJson ? 1 : 0) +
    appliedHookNameRenames.length +
    appliedHypoignore.length +
    appliedExtCount +
    appliedHooksCodex.length +
    appliedSettingsCodex.length +
    appliedHookNameRenamesCodex.length;
  lines.push(`Result: ${total} update(s) applied. Run /hypo:doctor to verify.`);
} else {
  lines.push(`Result: ${totalDrift} item(s) need updating — run with --apply to install`);
}

console.log(lines.join('\n'));

// E3: a hard extension conflict blocks even under --apply (unlike ordinary
// drift, which only fails check mode). --force-extensions clears the resolvable
// cases; an unfollowable symlink/non-regular dest still counts and stays exit 1.
const extBlocked = extCheck.conflicts.length > 0 || (extCheckCodex?.conflicts.length ?? 0) > 0;
process.exit((hasDrift && !args.apply) || extBlocked ? 1 : 0);
