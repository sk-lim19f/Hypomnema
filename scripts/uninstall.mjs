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
 *   --codex              Also remove Codex hooks/commands + ext hard-copies (~/.codex/)
 *   --force-commands     Remove user-modified slash commands instead of preserving them
 *   --force-extensions   Remove user-modified extension files (hypo-ext-*) instead of preserving them
 *   --hooks-dir=<path>   Override Claude hooks directory (default: ~/.claude/hooks)
 *
 * Extensions: hypo-ext-* hard-copies under
 * ~/.claude/{hooks,commands,skills,agents}/ and ~/.codex/{hooks,commands}/ (with
 * --codex) are removed when their on-disk SHA matches the recorded one in
 * ~/.claude/hypo-pkg.json#extensions.<target>. User-modified copies are preserved
 * unless --force-extensions; symlinks/non-regular files are NEVER removed (force
 * does not follow them). The wiki source (~/hypomnema/extensions/) is preserved.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, rmdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  readPkgJson as readPkgJsonSafe,
  sha256,
  isRegularFile,
  readFileIfRegular,
} from './lib/pkg-json.mjs';
import {
  EXT_PREFIX,
  EXT_TYPES,
  CODEX_TYPES,
  readExtensionPkgStateNoMutate,
} from './lib/extensions.mjs';

const HOME = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT =
  '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';

function removeCommands(apply, force) {
  const targetDir = join(HOME, '.claude', 'commands', 'hypo');
  const pkgPath = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(targetDir))
    return { removed: [], skippedUserModified: [], skippedNonRegular: [] };

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

// ── extensions removal ───────────────────────────────────

// Strip per-target extension SHA records from ~/.claude/hypo-pkg.json. Surgical:
// we only touch the entries for keys we actually removed, so a `--force-extensions`
// run that leaves user-modified files behind keeps their recorded SHAs intact
// (doctor still has something to compare against next time). When the per-target
// map empties out, drop the target key; when the whole `extensions` object empties,
// drop it too. Other targets' records (e.g. codex map during a Claude-only uninstall)
// are never touched.
function stripExtensionsFromPkg(pkgPath, target, removedKeys, apply) {
  if (!existsSync(pkgPath) || removedKeys.length === 0) return false;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return false;
  const extensions = pkg.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  const perTarget = extensions[target];
  if (!perTarget || typeof perTarget !== 'object' || Array.isArray(perTarget)) return false;

  let changed = false;
  for (const key of removedKeys) {
    if (key in perTarget) {
      delete perTarget[key];
      changed = true;
    }
  }
  if (Object.keys(perTarget).length === 0) {
    delete extensions[target];
    changed = true;
  }
  if (Object.keys(extensions).length === 0) {
    delete pkg.extensions;
    changed = true;
  }
  if (changed && apply) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return changed;
}

// Remove hypo-ext-* hard-copies for one target (claude | codex). Mirrors
// removeCommands' 3-way model: filesystem scan + per-target recorded SHA from
// hypo-pkg.json#extensions[target] decides ownership. A file we never installed
// (no recorded SHA) is left alone — that may be a foreign hypo-ext-* file the
// user created by hand, never ours to delete. A user-modified file is preserved
// unless --force-extensions; a symlink/non-regular target is always preserved
// (force does not follow them, matching install/upgrade E3's guard).
function removeExtensions(target, apply, force) {
  const targetRoot = target === 'codex' ? join(HOME, '.codex') : join(HOME, '.claude');
  const types = target === 'codex' ? CODEX_TYPES : EXT_TYPES;
  // Per-target SHAs live in ~/.claude/hypo-pkg.json regardless of target (the
  // file is a single source of truth, with extensions: { claude: {}, codex: {} }).
  const pkgPath = join(HOME, '.claude', 'hypo-pkg.json');
  const recorded = readExtensionPkgStateNoMutate(pkgPath, target);

  const removed = [];
  const removedKeys = [];
  const skippedUserModified = [];
  const skippedNonRegular = [];

  for (const type of types) {
    const typeDir = join(targetRoot, type);
    if (!existsSync(typeDir)) continue;
    let entries;
    try {
      entries = readdirSync(typeDir);
    } catch {
      continue;
    }
    for (const fname of entries) {
      if (!fname.startsWith(EXT_PREFIX)) continue;
      const key = `${type}/${fname}`;
      const recordedSHA = recorded[key];
      if (!recordedSHA) continue; // not tracked by us → leave alone
      const fullPath = join(typeDir, fname);

      if (!isRegularFile(fullPath)) {
        // Refuse to follow symlinks/sockets even under --force-extensions.
        skippedNonRegular.push(fullPath);
        continue;
      }
      const buf = readFileIfRegular(fullPath);
      const sha = buf ? sha256(buf) : null;

      if (sha === recordedSHA || force) {
        if (apply) rmSync(fullPath);
        removed.push(fullPath);
        removedKeys.push(key);
      } else {
        skippedUserModified.push(fullPath);
      }
    }
  }
  return { target, removed, removedKeys, skippedUserModified, skippedNonRegular };
}

// True iff `pkg.json` still holds extensions state for a target the current
// uninstall did NOT process. Without this guard, a Claude-only uninstall would
// wholesale-rm pkg.json even when ~/.codex/hooks/hypo-ext-* hard-copies (and
// their `extensions.codex` ownership baseline) are still live — silently
// orphaning Codex's per-target SHA contract (plan D2b/E6).
//
// Scope is narrowed to unprocessed targets so the legacy clean-uninstall path
// stands: when commands are removed in full (commandResult has no skipped
// entries) the stale `pkg.commands` map still gets wholesale-removed, matching
// pre-E6 behavior. A processed target whose own state is non-empty (e.g.
// user-modified ext file held back) is already guarded by its skippedUserModified
// / skippedNonRegular tally — so we don't double-count it here.
function unprocessedExtensionTargetRemains(pkgPath, processedTargets) {
  if (!existsSync(pkgPath)) return false;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    // Cannot reliably inspect — refuse to delete (fail-safe: keep the file).
    return true;
  }
  const exts = pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg.extensions : null;
  if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return false;
  for (const [target, m] of Object.entries(exts)) {
    if (processedTargets.has(target)) continue;
    if (m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length > 0) {
      return true;
    }
  }
  return false;
}

// settings.json: strip groups whose command points to a hypo-ext-* path under
// the target's hooks dir. Identity is path-based (plan §0 D1) — no hookMap needed
// because ext hooks are never enumerated there. Mixed groups (foreign hook +
// ours) keep the foreign hook; ours-only groups are dropped entirely. Mirrors
// stripSettingsJson's flatMap pattern so other-plugin invariants (§7.3) hold.
function stripExtensionSettings(settingsPath, hooksDir, apply) {
  if (!existsSync(settingsPath)) return { stripped: [] };
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { stripped: [], error: `${settingsPath} is not valid JSON — skipping` };
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') return { stripped: [] };

  const cmdPrefix = `node ${hooksDir.replace(HOME, '$HOME')}/${EXT_PREFIX}`;
  const isExtHook = (h) =>
    h && h.type === 'command' && typeof h.command === 'string' && h.command.startsWith(cmdPrefix);

  const stripped = [];
  let changed = false;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;

    const filtered = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];

      const extHooks = group.hooks.filter(isExtHook);
      const others = group.hooks.filter((h) => !isExtHook(h));

      for (const h of extHooks) stripped.push(`${event}: ${h.command}`);

      if (extHooks.length === 0) return [group];
      changed = true;
      if (others.length === 0) return [];
      return [{ ...group, hooks: others }];
    });

    settings.hooks[event] = filtered;
  }

  if (changed && apply) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return { stripped };
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    apply: false,
    codex: false,
    hooksDir: null,
    forceCommands: false,
    forceExtensions: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--codex') args.codex = true;
    else if (arg === '--force-commands') args.forceCommands = true;
    else if (arg === '--force-extensions') args.forceExtensions = true;
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
            if (m) {
              hookFiles.add(m[1]);
              filenames.push(m[1]);
            }
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
  const removed = [],
    missing = [];
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

    const managed = hookMap[event] ?? [];
    const isHypoHook = (h) =>
      h.type === 'command' &&
      typeof h.command === 'string' &&
      managed.some((file) => h.command === `node ${hooksDir.replace(HOME, '$HOME')}/${file}`);

    const filtered = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];

      const hypoHooks = group.hooks.filter((h) => isHypoHook(h));
      const userHooks = group.hooks.filter((h) => !isHypoHook(h));

      for (const h of hypoHooks) stripped.push(`${event}: ${h.command}`);

      if (hypoHooks.length === 0) return [group]; // no Hypomnema hooks → keep as-is
      changed = true;
      if (userHooks.length === 0) return []; // all Hypomnema → remove group
      return [{ ...group, hooks: userHooks }]; // mixed → keep only user hooks
    });

    settings.hooks[event] = filtered;
  }

  if (changed && apply) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { stripped, kept: 0 };
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
const dryRun = !args.apply;

const { hookMap, hookFiles } = loadHookFiles();

const claudeHooksDir = args.hooksDir ?? join(HOME, '.claude', 'hooks');
const claudeSettings = join(HOME, '.claude', 'settings.json');

const hookResult = removeHookFiles(claudeHooksDir, hookFiles, args.apply);
const settingsResult = stripSettingsJson(claudeSettings, claudeHooksDir, hookMap, args.apply);
const commandResult = removeCommands(args.apply, args.forceCommands);

// Extensions. Order matters: remove files first, then strip
// settings, then surgically clear the per-target SHA map. The SHA strip uses
// removedKeys so a user-modified file we left in place keeps its recorded SHA
// (doctor still has a baseline next run). Settings are path-based and run even
// if no files were removed — a manifest could have registered entries that the
// hook copy was deleted by hand (force-commands legacy state).
const pkgJsonPath = join(HOME, '.claude', 'hypo-pkg.json');
const claudeExtResult = removeExtensions('claude', args.apply, args.forceExtensions);
const claudeExtSettings = stripExtensionSettings(claudeSettings, claudeHooksDir, args.apply);

let codexHookResult = { removed: [], missing: [] };
let codexSettingsResult = { stripped: [] };
let codexCommandResult = null;
let codexExtResult = {
  target: 'codex',
  removed: [],
  removedKeys: [],
  skippedUserModified: [],
  skippedNonRegular: [],
};
let codexExtSettings = { stripped: [] };

if (args.codex) {
  const codexHooksDir = join(HOME, '.codex', 'hooks');
  const codexSettings = join(HOME, '.codex', 'settings.json');
  codexHookResult = removeHookFiles(codexHooksDir, hookFiles, args.apply);
  codexSettingsResult = stripSettingsJson(codexSettings, codexHooksDir, hookMap, args.apply);
  codexExtResult = removeExtensions('codex', args.apply, args.forceExtensions);
  codexExtSettings = stripExtensionSettings(codexSettings, codexHooksDir, args.apply);
}

// Surgical per-target ext SHA strip — only for files we actually removed.
stripExtensionsFromPkg(pkgJsonPath, 'claude', claudeExtResult.removedKeys, args.apply);
if (args.codex) {
  stripExtensionsFromPkg(pkgJsonPath, 'codex', codexExtResult.removedKeys, args.apply);
}

// pkg.json metadata file removal — only when no user-tracked state remains.
// Both command and extension preservation cases hold the file: doctor still
// needs the recorded SHAs of files we left behind so the next sync compares
// against truth, not nothing.
let pkgJsonRemoved = null;
const processedExtTargets = new Set(['claude']);
if (args.codex) processedExtTargets.add('codex');
const keepPkgJson =
  commandResult.skippedUserModified.length > 0 ||
  commandResult.skippedNonRegular.length > 0 ||
  claudeExtResult.skippedUserModified.length > 0 ||
  claudeExtResult.skippedNonRegular.length > 0 ||
  codexExtResult.skippedUserModified.length > 0 ||
  codexExtResult.skippedNonRegular.length > 0 ||
  // Claude-only uninstall must not wholesale-rm pkg.json if extensions.codex
  // (or any other unprocessed target) still tracks live Codex hard-copies.
  unprocessedExtensionTargetRemains(pkgJsonPath, processedExtTargets);
if (existsSync(pkgJsonPath) && !keepPkgJson) {
  if (args.apply) rmSync(pkgJsonPath);
  pkgJsonRemoved = pkgJsonPath;
}

// ── report ───────────────────────────────────────────────────────────────────

const lines = [];
if (dryRun) lines.push('[DRY RUN — pass --apply to make changes]');

const allRemoved = [...hookResult.removed, ...codexHookResult.removed];
const allStripped = [...settingsResult.stripped, ...codexSettingsResult.stripped];
const extRemoved = [...claudeExtResult.removed, ...codexExtResult.removed];
const extSkippedUserModified = [
  ...claudeExtResult.skippedUserModified,
  ...codexExtResult.skippedUserModified,
];
const extSkippedNonRegular = [
  ...claudeExtResult.skippedNonRegular,
  ...codexExtResult.skippedNonRegular,
];
const extStripped = [...claudeExtSettings.stripped, ...codexExtSettings.stripped];

if (allRemoved.length)
  lines.push(
    `✓ Hook files ${dryRun ? 'to remove' : 'removed'} (${allRemoved.length}):\n${allRemoved.map((p) => `  ${p}`).join('\n')}`,
  );
if (commandResult.removed.length)
  lines.push(
    `✓ Slash commands ${dryRun ? 'to remove' : 'removed'} (${commandResult.removed.length}):\n${commandResult.removed.map((p) => `  ${p}`).join('\n')}`,
  );
if (commandResult.skippedUserModified.length)
  lines.push(
    `⊘ Slash commands preserved (user-modified, ${commandResult.skippedUserModified.length}) — pass --force-commands to remove anyway:\n${commandResult.skippedUserModified.map((p) => `  ${p}`).join('\n')}`,
  );
if (commandResult.skippedNonRegular.length)
  lines.push(
    `⊘ Slash commands skipped (non-regular file, ${commandResult.skippedNonRegular.length}) — refusing to follow symlinks:\n${commandResult.skippedNonRegular.map((p) => `  ${p}`).join('\n')}`,
  );
if (extRemoved.length)
  lines.push(
    `✓ Extension files ${dryRun ? 'to remove' : 'removed'} (${extRemoved.length}):\n${extRemoved.map((p) => `  ${p}`).join('\n')}`,
  );
if (extSkippedUserModified.length)
  lines.push(
    `⊘ Extension files preserved (user-modified, ${extSkippedUserModified.length}) — pass --force-extensions to remove anyway:\n${extSkippedUserModified.map((p) => `  ${p}`).join('\n')}`,
  );
if (extSkippedNonRegular.length)
  lines.push(
    `⊘ Extension files skipped (non-regular file, ${extSkippedNonRegular.length}) — refusing to follow symlinks:\n${extSkippedNonRegular.map((p) => `  ${p}`).join('\n')}`,
  );
if (extStripped.length)
  lines.push(
    `✓ settings.json extension entries ${dryRun ? 'to remove' : 'removed'} (${extStripped.length}):\n${extStripped.map((p) => `  ${p}`).join('\n')}`,
  );
if (allStripped.length)
  lines.push(
    `✓ settings.json entries ${dryRun ? 'to remove' : 'removed'} (${allStripped.length}):\n${allStripped.map((p) => `  ${p}`).join('\n')}`,
  );
if (pkgJsonRemoved)
  lines.push(`✓ Package metadata ${dryRun ? 'to remove' : 'removed'}: ${pkgJsonRemoved}`);
if (keepPkgJson && !pkgJsonRemoved && existsSync(pkgJsonPath))
  lines.push(
    `⊘ Package metadata preserved (${pkgJsonPath}) — user-modified or non-regular files still tracked`,
  );
if (hookResult.missing.length)
  lines.push(
    `⊘ Already absent (${hookResult.missing.length}):\n${hookResult.missing.map((p) => `  ${p}`).join('\n')}`,
  );
if (settingsResult.error) lines.push(`⚠ ${settingsResult.error}`);
if (claudeExtSettings.error) lines.push(`⚠ ${claudeExtSettings.error}`);
if (codexExtSettings.error) lines.push(`⚠ ${codexExtSettings.error}`);

if (
  !allRemoved.length &&
  !allStripped.length &&
  !extRemoved.length &&
  !extStripped.length &&
  !hookResult.missing.length &&
  !commandResult.removed.length &&
  !pkgJsonRemoved &&
  !commandResult.skippedUserModified.length &&
  !extSkippedUserModified.length &&
  !extSkippedNonRegular.length
) {
  lines.push('Nothing to uninstall — Hypomnema does not appear to be installed.');
}

console.log(lines.join('\n\n'));
