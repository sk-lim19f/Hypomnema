#!/usr/bin/env node
/**
 * Hypomnema uninstall script
 *
 * Removes hook files installed by Hypomnema and strips wiki entries from
 * settings.json, leaving all other user hooks untouched.
 *
 * Usage:
 *   node scripts/uninstall.mjs [options]
 *
 * Options:
 *   --apply              Actually remove files / edit settings.json (default: dry-run)
 *   --codex              Also remove Codex hooks (~/.codex/hooks/)
 *   --hooks-dir=<path>   Override Claude hooks directory (default: ~/.claude/hooks)
 */

import { existsSync, readFileSync, writeFileSync, rmSync, rmdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { readPkgJson as readPkgJsonSafe, sha256, isRegularFile, readFileIfRegular } from './lib/pkg-json.mjs';

const HOME       = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT   = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT = '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';

function removeCommands(apply, force) {
  const targetDir = join(HOME, '.claude', 'commands', 'hypo');
  const pkgPath   = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(targetDir)) return { removed: [], skippedUserModified: [], skippedNonRegular: [] };

  const recorded = readPkgJsonSafe(pkgPath).commands || {};
  const removed = [];
  const skippedUserModified = [];
  const skippedNonRegular = [];

  for (const file of readdirSync(targetDir)) {
    if (!file.endsWith('.md')) continue;
    const fullPath = join(targetDir, file);
    const recordedSHA = recorded[file];
    if (!recordedSHA) continue; // wasn't installed by us — leave alone

    if (!isRegularFile(fullPath)) {
      // Refuse to follow symlinks during destructive ops.
      skippedNonRegular.push(fullPath);
      continue;
    }
    const buf = readFileIfRegular(fullPath);
    const sha = buf ? sha256(buf) : null;

    if (sha === recordedSHA || force) {
      if (apply) rmSync(fullPath);
      removed.push(fullPath);
    } else {
      // User-modified tracked command — preserve unless --force.
      skippedUserModified.push(fullPath);
    }
  }

  // Remove the hypo/ dir only if it ends up empty.
  if (apply && existsSync(targetDir)) {
    try {
      const remaining = readdirSync(targetDir);
      if (remaining.length === 0) rmdirSync(targetDir);
    } catch {}
  }
  return { removed, skippedUserModified, skippedNonRegular };
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { apply: false, codex: false, hooksDir: null, forceCommands: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply')                 args.apply    = true;
    else if (arg === '--codex')            args.codex    = true;
    else if (arg === '--force-commands')   args.forceCommands = true;
    else if (arg.startsWith('--hooks-dir=')) args.hooksDir = arg.slice(12);
  }
  return args;
}

// ── hook map (single source of truth) ───────────────────────────────────────

function loadHookFiles() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  } catch {
    console.error('Error: cannot read hooks/hooks.json');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
  if (!cfg?.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) {
    console.error('Error: hooks/hooks.json must contain a "hooks" object');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }

  const hookFiles = new Set();
  const normalizedHookMap = {};

  for (const [event, groups] of Object.entries(cfg.hooks)) {
    const filenames = [];
    for (const entry of groups) {
      if (typeof entry === 'string') {
        // legacy flat format: entry is a filename
        hookFiles.add(entry);
        filenames.push(entry);
      } else if (entry && Array.isArray(entry.hooks)) {
        // current group format: extract filename from command string
        for (const h of entry.hooks) {
          if (h.type === 'command' && typeof h.command === 'string') {
            const m = h.command.match(/\/hooks\/([^/\s]+\.mjs)$/);
            if (m) { hookFiles.add(m[1]); filenames.push(m[1]); }
          }
        }
      }
    }
    normalizedHookMap[event] = filenames;
  }

  if (Array.isArray(cfg.shared)) {
    for (const f of cfg.shared) hookFiles.add(f);
  }
  return { hookMap: normalizedHookMap, hookFiles };
}

// ── hook file removal ────────────────────────────────────────────────────────

function removeHookFiles(hooksDir, hookFiles, apply) {
  const removed = [], missing = [];
  for (const file of hookFiles) {
    const p = join(hooksDir, file);
    if (existsSync(p)) {
      if (apply) rmSync(p);
      removed.push(p);
    } else {
      missing.push(p);
    }
  }
  return { removed, missing };
}

// ── settings.json cleanup ────────────────────────────────────────────────────

function stripSettingsJson(settingsPath, hooksDir, hookMap, apply) {
  if (!existsSync(settingsPath)) return { stripped: [], kept: 0 };

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { stripped: [], kept: 0, error: `${settingsPath} is not valid JSON — skipping` };
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') return { stripped: [], kept: 0 };

  const stripped = [];
  let changed = false;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;

    const managed = (hookMap[event] ?? []);
    const isHypoHook = h =>
      h.type === 'command' &&
      typeof h.command === 'string' &&
      managed.some(file => h.command === `node ${hooksDir.replace(HOME, '$HOME')}/${file}`);

    const filtered = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) return [group];

      const hypoHooks = group.hooks.filter(h => isHypoHook(h));
      const userHooks = group.hooks.filter(h => !isHypoHook(h));

      for (const h of hypoHooks) stripped.push(`${event}: ${h.command}`);

      if (hypoHooks.length === 0) return [group];   // no Hypomnema hooks → keep as-is
      changed = true;
      if (userHooks.length === 0) return [];          // all Hypomnema → remove group
      return [{ ...group, hooks: userHooks }];        // mixed → keep only user hooks
    });

    settings.hooks[event] = filtered;
  }

  if (changed && apply) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { stripped, kept: 0 };
}

// ── main ─────────────────────────────────────────────────────────────────────

const args   = parseArgs(process.argv);
const dryRun = !args.apply;

const { hookMap, hookFiles } = loadHookFiles();

const claudeHooksDir  = args.hooksDir ?? join(HOME, '.claude', 'hooks');
const claudeSettings  = join(HOME, '.claude', 'settings.json');

const hookResult     = removeHookFiles(claudeHooksDir, hookFiles, args.apply);
const settingsResult = stripSettingsJson(claudeSettings, claudeHooksDir, hookMap, args.apply);
const commandResult  = removeCommands(args.apply, args.forceCommands);

// pkg.json metadata file removal — only when no user-modified commands remain on disk.
const pkgJsonPath = join(HOME, '.claude', 'hypo-pkg.json');
let pkgJsonRemoved = null;
const keepPkgJson = commandResult.skippedUserModified.length > 0 || commandResult.skippedNonRegular.length > 0;
if (existsSync(pkgJsonPath) && !keepPkgJson) {
  if (args.apply) rmSync(pkgJsonPath);
  pkgJsonRemoved = pkgJsonPath;
}

let codexHookResult     = { removed: [], missing: [] };
let codexSettingsResult = { stripped: [] };

if (args.codex) {
  const codexHooksDir = join(HOME, '.codex', 'hooks');
  const codexSettings = join(HOME, '.codex', 'settings.json');
  codexHookResult     = removeHookFiles(codexHooksDir, hookFiles, args.apply);
  codexSettingsResult = stripSettingsJson(codexSettings, codexHooksDir, hookMap, args.apply);
}

// ── report ───────────────────────────────────────────────────────────────────

const lines = [];
if (dryRun) lines.push('[DRY RUN — pass --apply to make changes]');

const allRemoved = [...hookResult.removed, ...codexHookResult.removed];
const allStripped = [...settingsResult.stripped, ...codexSettingsResult.stripped];

if (allRemoved.length)  lines.push(`✓ Hook files ${dryRun ? 'to remove' : 'removed'} (${allRemoved.length}):\n${allRemoved.map(p => `  ${p}`).join('\n')}`);
if (commandResult.removed.length) lines.push(`✓ Slash commands ${dryRun ? 'to remove' : 'removed'} (${commandResult.removed.length}):\n${commandResult.removed.map(p => `  ${p}`).join('\n')}`);
if (commandResult.skippedUserModified.length) lines.push(`⊘ Slash commands preserved (user-modified, ${commandResult.skippedUserModified.length}) — pass --force-commands to remove anyway:\n${commandResult.skippedUserModified.map(p => `  ${p}`).join('\n')}`);
if (commandResult.skippedNonRegular.length) lines.push(`⊘ Slash commands skipped (non-regular file, ${commandResult.skippedNonRegular.length}) — refusing to follow symlinks:\n${commandResult.skippedNonRegular.map(p => `  ${p}`).join('\n')}`);
if (allStripped.length) lines.push(`✓ settings.json entries ${dryRun ? 'to remove' : 'removed'} (${allStripped.length}):\n${allStripped.map(p => `  ${p}`).join('\n')}`);
if (pkgJsonRemoved)     lines.push(`✓ Package metadata ${dryRun ? 'to remove' : 'removed'}: ${pkgJsonRemoved}`);
if (keepPkgJson && !pkgJsonRemoved && existsSync(pkgJsonPath)) lines.push(`⊘ Package metadata preserved (${pkgJsonPath}) — user-modified or non-regular commands still tracked`);
if (hookResult.missing.length) lines.push(`⊘ Already absent (${hookResult.missing.length}):\n${hookResult.missing.map(p => `  ${p}`).join('\n')}`);
if (settingsResult.error) lines.push(`⚠ ${settingsResult.error}`);

if (!allRemoved.length && !allStripped.length && !hookResult.missing.length && !commandResult.removed.length && !pkgJsonRemoved && !commandResult.skippedUserModified.length) {
  lines.push('Nothing to uninstall — Hypomnema does not appear to be installed.');
}

console.log(lines.join('\n\n'));
