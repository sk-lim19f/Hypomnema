/**
 * scripts/lib/extensions.mjs — User extensions companion sync.
 *
 * `~/hypomnema/extensions/{hooks,commands,skills,agents}/` holds user-authored
 * extensions, git-tracked alongside the wiki. init/upgrade hard-copy them into
 * `~/.claude/{type}/` (and, in E4, `~/.codex/{type}/`), track a per-target 3-way
 * SHA in `~/.claude/hypo-pkg.json`, and auto-register hook-type extensions in
 * settings.json from a sibling `<name>.manifest.json`.
 *
 * This module is the single source of sync logic — both init.mjs and
 * upgrade.mjs --apply call `syncExtensions(...)` so the two flows can never
 * drift (plan §5 D4). The read-only helpers (`discoverExtensions`,
 * `parseManifest`, `buildExpectedSettingsEntries`, `readExtensionPkgStateNoMutate`)
 * are exported for doctor (E5) and uninstall (E6) reuse without re-deriving them.
 *
 * Security (plan §5 #9): only files matching the `hypo-ext-<name>.<ext>` basename
 * whitelist are discovered, and the settings.json command string is always
 * constructed here as `node $HOME/.claude/hooks/<basename>` — never sourced from
 * the manifest. A manifest cannot inject an arbitrary command path.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { sha256, isRegularFile, readFileIfRegular, writePkgJsonAtomic } from './pkg-json.mjs';
import { loadHypoIgnore, isIgnored } from './hypo-ignore.mjs';

const HOME = homedir();

// Extension types and their on-disk target subdirectory under ~/.claude or ~/.codex.
export const EXT_TYPES = ['hooks', 'commands', 'skills', 'agents'];

// Required filename prefix (plan §5 #9 enforces). Files
// without it are skipped so uninstall (which strips hypo-ext-*) can always reach
// every file we install — and so a stray name cannot collide with core hooks.
export const EXT_PREFIX = 'hypo-ext-';

// Codex supports hooks + commands only; skills/agents are Claude-only.
export const CODEX_TYPES = ['hooks', 'commands'];

// Per-type expected file extension. Hooks are executable .mjs; the rest are .md.
const TYPE_FILE_EXT = { hooks: '.mjs', commands: '.md', skills: '.md', agents: '.md' };

// Singular manifest `type` value per directory (capture design §3). A captured
// extension's sidecar manifest must declare a `type` matching its parent dir
// before its `installName` is honored (guards against a mislabelled manifest
// retargeting an install path).
const TYPE_SINGULAR = { hooks: 'hook', commands: 'command', skills: 'skill', agents: 'agent' };

// installName carrier (capture design §3): reverse-captured commands/agents install
// under the user's ORIGINAL name, not the wiki `hypo-ext-*` storage name. Only
// commands/agents opt in — hooks keep the wiki name (their settings.json command
// string is prefix-derived) and skills are not captured in the MVP.
const INSTALLNAME_TYPES = new Set(['commands', 'agents']);

// A valid installName stem: same conservative charset as SAFE_EXT_STEM but
// WITHOUT the required hypo-ext- prefix (the whole point of C is to restore the
// user's own name). Rejects path separators, traversal (leading dot blocks `..`
// and `.`), and anything outside the charset.
const SAFE_INSTALL_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Windows reserved device names (capture design §5 — the extensions-companion design chose hard-copy partly
// for Windows compatibility, so an installName must never resolve to one).
const WINDOWS_RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * True iff `stem` is a syntactically valid, non-reserved installName (the reverse-capture design
 * §5). Case-insensitive on the reservations so `Hypo-x` cannot slip past on a
 * case-insensitive filesystem. Does NOT append an extension — callers add
 * TYPE_FILE_EXT in code so a manifest can never inject the extension.
 */
export function isValidInstallStem(stem) {
  if (typeof stem !== 'string' || !SAFE_INSTALL_STEM.test(stem)) return false;
  // Reject `..` anywhere, not just a leading dot: an internal `a..b` passes the
  // charset but parseExtKey (uninstall) rejects it, which would strand a captured
  // file it can never remove. Keep the two validators in agreement.
  if (stem.includes('..')) return false;
  const lower = stem.toLowerCase();
  if (lower === 'hypo' || lower.startsWith('hypo-')) return false; // reserved namespace
  // Windows treats a device name reserved even WITH an extension (`con.v1`), so
  // test the segment before the first dot, not just the whole stem.
  const base = lower.split('.')[0];
  if (WINDOWS_RESERVED.has(base)) return false;
  return true;
}

/**
 * Resolve the install filename for a discovered extension (capture design §3).
 * Returns `{ installFile }` — the basename under `~/.claude/<type>/`. Defaults
 * to `ext.file` (the wiki storage name) so existing hypo-ext-* extensions are
 * untouched (backward compatible). Only commands/agents with a sidecar manifest
 * whose `type` matches the directory AND whose `installName` is valid install
 * under the user's original name. A present-but-invalid installName yields
 * `{ skip, warn }` — the extension is dropped rather than silently installed
 * under a surprising name.
 */
export function resolveInstallFile(ext) {
  if (!INSTALLNAME_TYPES.has(ext.type) || !ext.manifestPath) {
    return { installFile: ext.file };
  }
  const parsed = parseManifest(ext.manifestPath);
  // Non-hook manifests are always ok:true (parseManifest only fails hook ones),
  // so a malformed non-hook manifest is not reachable here; be defensive anyway.
  if (!parsed.ok) return { installFile: ext.file };
  const m = parsed.manifest;
  if (!m || m.type !== TYPE_SINGULAR[ext.type] || m.installName === undefined) {
    return { installFile: ext.file };
  }
  if (!isValidInstallStem(m.installName)) {
    return {
      skip: true,
      warn: `${ext.type}/${ext.file}: invalid installName "${m.installName}" — extension skipped`,
    };
  }
  return { installFile: m.installName + TYPE_FILE_EXT[ext.type] };
}

/**
 * Parse + validate a recorded pkg-json extension key `${type}/${installFile}`
 * for destructive use (capture design §8 — uninstall traverses recorded keys, which
 * come from an on-disk JSON we do not fully control). Returns
 * `{ type, installFile }` only when the key is exactly one covered type, a
 * single path segment for the filename (no separators / traversal), and the
 * expected extension. Returns null otherwise so the caller skips it — never
 * `join`s an untrusted key that could escape the extension directory.
 */
export function parseExtKey(key, coveredTypes) {
  if (typeof key !== 'string') return null;
  const slash = key.indexOf('/');
  if (slash === -1) return null;
  const type = key.slice(0, slash);
  const installFile = key.slice(slash + 1);
  if (!coveredTypes.includes(type)) return null;
  // The filename portion must be a single safe segment: no further separators,
  // no traversal, and it must end in the type's expected extension. Only HOOKS
  // additionally track a `.manifest.json` sidecar copy in the SHA map, so the
  // manifest suffix is accepted for hooks alone — accepting it for every type
  // would let a forged `commands/x.manifest.json` key name a removable file that
  // sync never owns (codex pre-commit CONCERN).
  if (installFile.includes('/') || installFile.includes('\\')) return null;
  if (installFile.includes('..') || installFile.startsWith('.')) return null;
  const MANIFEST_SUFFIX = '.manifest.json';
  const suffix =
    type === 'hooks' && installFile.endsWith(MANIFEST_SUFFIX)
      ? MANIFEST_SUFFIX
      : TYPE_FILE_EXT[type];
  if (!installFile.endsWith(suffix)) return null;
  const stem = installFile.slice(0, -suffix.length);
  if (stem.length === 0) return null;
  return { type, installFile };
}

// Claude Code hook events (D3 allowlist). A manifest with an event outside this
// set is malformed → the whole extension is skipped (no copy, no registration).
export const HOOK_EVENT_ALLOWLIST = new Set([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
]);

// The <name> portion (filename minus extension) must match this. Rejects path
// separators, traversal (..), and anything outside a conservative charset.
const SAFE_EXT_STEM = /^hypo-ext-[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Hard-copy outcomes that mean "this file is ours" — safe to track its manifest
// and register a settings entry. The skip-* outcomes mean we left a file we do
// not own untouched, so we must not wire it up.
const OWNED_ACTIONS = new Set(['create', 'update', 'force-update', 'up-to-date']);

function pkgRootDir(target) {
  return target === 'codex' ? join(HOME, '.codex') : join(HOME, '.claude');
}

// ── read-only helpers ─────────────────────────────────────────────────────────

/**
 * Discover sync-eligible extensions under `extDir`. Returns a per-type map plus a
 * `warnings` array. Applies the `.hypoignore` filter, the basename
 * whitelist (plan §5 #9), and pairs each file with its optional `<name>.manifest.json`.
 * No-ops gracefully when extDir is absent (e.g. --from-remote clones, plan §5 #8).
 */
export function discoverExtensions(extDir, hypoignorePatterns, hypoDir) {
  const result = { hooks: [], commands: [], skills: [], agents: [], warnings: [] };
  if (!extDir || !existsSync(extDir)) return result;

  for (const type of EXT_TYPES) {
    const typeDir = join(extDir, type);
    if (!existsSync(typeDir)) continue;
    let entries;
    try {
      entries = readdirSync(typeDir);
    } catch {
      continue;
    }
    const fileExt = TYPE_FILE_EXT[type];
    for (const fname of entries) {
      if (fname === '.gitkeep') continue;
      // Manifests are paired with their sibling, not discovered standalone.
      if (fname.endsWith('.manifest.json')) continue;
      const srcPath = join(typeDir, fname);
      if (isIgnored(srcPath, hypoDir, hypoignorePatterns)) continue;
      if (!isRegularFile(srcPath)) continue;
      if (!fname.endsWith(fileExt)) continue;
      const stem = fname.slice(0, -fileExt.length);
      if (!SAFE_EXT_STEM.test(stem)) {
        result.warnings.push(
          `${type}/${fname} skipped (extensions must use a 'hypo-ext-<name>' filename)`,
        );
        continue;
      }
      const manifestName = `${stem}.manifest.json`;
      const manifestPath = join(typeDir, manifestName);
      // The manifest is subject to the same .hypoignore filter as its sibling —
      // an ignored manifest must not be copied or SHA-tracked.
      const hasManifest =
        existsSync(manifestPath) &&
        isRegularFile(manifestPath) &&
        !isIgnored(manifestPath, hypoDir, hypoignorePatterns);
      result[type].push({
        type,
        name: stem,
        file: fname,
        srcPath,
        manifestName,
        manifestPath: hasManifest ? manifestPath : null,
      });
    }
  }
  return result;
}

/**
 * Parse + validate an extension manifest. `registrable` is true only for a valid
 * hook manifest (the kind that yields a settings.json entry). A non-hook manifest
 * is `ok` but not registrable; a malformed one is `!ok` (caller skips the ext).
 */
export function parseManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ok: false, error: 'manifest unreadable' };
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'manifest is not valid JSON' };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, error: 'manifest must be a JSON object' };
  }
  if (m.type !== 'hook') {
    // skill/agent/command manifests carry no hook registration metadata.
    return { ok: true, manifest: m, registrable: false };
  }
  if (typeof m.event !== 'string' || !HOOK_EVENT_ALLOWLIST.has(m.event)) {
    return { ok: false, error: `unknown or missing hook event: ${m.event ?? '(none)'}` };
  }
  if (m.matcher !== undefined && typeof m.matcher !== 'string') {
    return { ok: false, error: 'matcher must be a string' };
  }
  if (m.timeout !== undefined && (typeof m.timeout !== 'number' || m.timeout <= 0)) {
    return { ok: false, error: 'timeout must be a positive number' };
  }
  // Boundary normalization: `matcher: ""` is a
  // valid string per the type check above, but every downstream call site
  // disagrees on what it means — `if (entry.matcher)` (line ~641) silently
  // drops it from desiredGroup, while rankOccurrence's null/undefined→undef
  // coercion (line ~571) compares "" against undefined as mismatch. Normalize
  // here so every consumer (rank, registerSettings, doctor) sees a single
  // representation: empty matcher === absent matcher.
  if (m.matcher === '') {
    m = { ...m };
    delete m.matcher;
  }
  return { ok: true, manifest: m, registrable: true };
}

/**
 * Build the settings.json entries expected for the discovered hook extensions.
 * The command string is constructed here (never from the manifest) as
 * `node $HOME/.claude/hooks/<basename>`. Extensions whose manifest is missing or
 * not registrable yield no entry.
 */
export function buildExpectedSettingsEntries(discoveredHooks, targetHooksDir) {
  const entries = [];
  for (const ext of discoveredHooks) {
    if (!ext.manifestPath) continue;
    const parsed = parseManifest(ext.manifestPath);
    if (!parsed.ok || !parsed.registrable) continue;
    const command = `node ${targetHooksDir.replace(HOME, '$HOME')}/${ext.file}`;
    entries.push({
      name: ext.name,
      file: ext.file,
      event: parsed.manifest.event,
      matcher: parsed.manifest.matcher,
      timeout: parsed.manifest.timeout,
      command,
    });
  }
  return entries;
}

/**
 * The single source of the settings.json hook command string (capture design
 * F4). Both the forward path (`buildExpectedSettingsEntries`) and the reverse
 * strict parser (`parseCapturableHookCommand`) mirror this one shape so the two
 * directions can never drift. `hooksDir` is `<HOME>/.claude/hooks`, rewritten to
 * a `$HOME` literal so a captured registration stays portable across machines.
 */
export function buildHookCommand(hooksDir, installFile) {
  return `node ${hooksDir.replace(HOME, '$HOME')}/${installFile}`;
}

// The exact canonical hook path prefix that `buildHookCommand` emits for a dir
// under HOME. The strict parser accepts only this literal — an absolute path, a
// `~`, or an env prefix all diverge and are rejected with a visible reason.
const CAPTURABLE_HOOK_PATH_PREFIX = '$HOME/.claude/hooks/';
const CAPTURABLE_NODE_PREFIX = 'node ';
const MJS_EXT = '.mjs';

/**
 * Strict, fs-free parser for a capturable hook command (capture design F4). It
 * accepts ONLY the byte-for-byte shape `buildHookCommand` produces for a dir
 * under HOME: `node $HOME/.claude/hooks/<stem>.mjs`. Returns
 * `{ ok:true, stem, basename }` on a match, else `{ ok:false, reason }` with a
 * distinct reason per rejection axis so a caller can surface why a hook was not
 * captured (never a silent drop). This is deliberately NOT the lenient
 * `_extractCommandFileName` used by init: capture eligibility must be exact.
 */
export function parseCapturableHookCommand(command) {
  if (typeof command !== 'string') return { ok: false, reason: 'not-a-string' };
  // A newline in a command would break the one-line canonical shape and could
  // smuggle a second statement past a prefix check.
  if (/[\r\n]/.test(command)) return { ok: false, reason: 'contains-newline' };
  if (!command.startsWith(CAPTURABLE_NODE_PREFIX)) {
    return { ok: false, reason: 'bad-node-prefix' };
  }
  const rest = command.slice(CAPTURABLE_NODE_PREFIX.length);
  // Reject extra leading whitespace (a double space or a tab after `node`): the
  // builder emits exactly one space, so anything more is a lossy divergence.
  if (rest.length === 0 || rest[0] === ' ' || rest[0] === '\t') {
    return { ok: false, reason: 'bad-node-prefix' };
  }
  if (!rest.startsWith(CAPTURABLE_HOOK_PATH_PREFIX)) {
    // Covers `~`, a relative path, an env prefix, and an absolute path — none
    // start with the `$HOME/.claude/hooks/` literal.
    return { ok: false, reason: 'path-not-under-home-hooks' };
  }
  const tail = rest.slice(CAPTURABLE_HOOK_PATH_PREFIX.length);
  // The tail must be a single filename segment: no further separators (no
  // subdirectory) and no traversal.
  if (tail.includes('/') || tail.includes('\\') || tail.includes('..')) {
    return { ok: false, reason: 'nested-segment' };
  }
  if (!tail.endsWith(MJS_EXT)) {
    return { ok: false, reason: 'not-mjs' };
  }
  const stem = tail.slice(0, -MJS_EXT.length);
  // Same stem gate as install (rejects the reserved hypo-* namespace, Windows
  // device names, and out-of-charset names) so parse and install agree.
  if (!isValidInstallStem(stem)) {
    return { ok: false, reason: 'invalid-stem' };
  }
  return { ok: true, stem, basename: tail };
}

/**
 * Pure, defensive walk of `settings.hooks[event][group].hooks[]` (capture design
 * F4). Yields one record per hook entry:
 * `{ event, matcher, timeout, command, hookKeys, groupKeys }`. `matcher` is taken
 * verbatim from the parent group with `''` normalized to absent (undefined),
 * matching `parseManifest`/`registerSettings`. Any malformed rung (non-array
 * event list, non-object group, non-array hook list, non-object hook) is skipped
 * rather than throwing, so a hand-edited settings.json cannot crash the caller.
 */
export function scanSettingsHooks(settings) {
  const records = [];
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return records;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return records;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      const groupKeys = Object.keys(group);
      let matcher = group.matcher;
      if (matcher === '') matcher = undefined; // empty matcher === absent matcher
      const hookList = group.hooks;
      if (!Array.isArray(hookList)) continue;
      for (const entry of hookList) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        records.push({
          event,
          matcher,
          timeout: entry.timeout,
          command: entry.command,
          hookKeys: Object.keys(entry),
          groupKeys,
        });
      }
    }
  }
  return records;
}

/** Read the full hypo-pkg.json without any side effect (cf. pkg-json.readPkgJson,
 * which renames a corrupt file — unsafe for read-only callers, plan §5 #3). */
function readFullPkgNoMutate(pkgPath) {
  if (!existsSync(pkgPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Read the recorded per-target extension SHA map without side effects. */
export function readExtensionPkgStateNoMutate(pkgPath, target) {
  const pkg = readFullPkgNoMutate(pkgPath);
  const ext = pkg.extensions;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {};
  const perTarget = ext[target];
  return perTarget && typeof perTarget === 'object' && !Array.isArray(perTarget) ? perTarget : {};
}

// ── sync orchestration ─────────────────────────────────────────────────────────

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

/**
 * Decide + (when apply) perform the hard-copy of one file, returning the SHA to
 * record and an action label. Mirrors the slash-command 3-way SHA matrix
 * (init.mjs:installCommands). `force` (E3, --force-extensions) backs up (.bak) +
 * overwrites user-modified / unowned files; without it those are left untouched and
 * surface as drift/conflict. A symlink/non-regular dest is never followed even under
 * force (the isRegularFile guard precedes the force branch).
 */
function copyOne({ srcPath, destPath, key, recordedSHA, apply, force }) {
  const srcContent = readFileSync(srcPath);
  const srcSHA = sha256(srcContent);

  if (!existsSync(destPath)) {
    if (apply) writeFreshAtomic(destPath, srcContent);
    return { action: 'create', sha: srcSHA };
  }
  if (!isRegularFile(destPath)) {
    // Never overwrite symlinks/sockets; never claim ownership of them.
    return { action: 'skip-non-regular', sha: recordedSHA ?? null };
  }
  const onDisk = readFileIfRegular(destPath);
  if (onDisk === null) {
    return { action: 'skip-unreadable', sha: recordedSHA ?? null };
  }
  const onDiskSHA = sha256(onDisk);
  if (onDiskSHA === srcSHA) {
    return { action: 'up-to-date', sha: srcSHA };
  }
  if (recordedSHA && onDiskSHA === recordedSHA) {
    // Owned + unmodified by user → overwrite (edit-sync). CAS re-verify on apply.
    if (apply) {
      const verify = readFileIfRegular(destPath);
      if (!verify || sha256(verify) !== recordedSHA) {
        return { action: 'skip-changed', sha: recordedSHA };
      }
      writeFreshAtomic(destPath, srcContent);
    }
    return { action: 'update', sha: srcSHA };
  }
  // User-modified or pre-existing unowned file.
  if (force) {
    if (apply) {
      writeFreshAtomic(`${destPath}.bak`, onDisk);
      writeFreshAtomic(destPath, srcContent);
    }
    return { action: 'force-update', sha: srcSHA };
  }
  return {
    action: recordedSHA ? 'skip-user-modified' : 'skip-conflict',
    sha: recordedSHA ?? null,
  };
}

/**
 * Classify one hard-copy outcome into the sync result (E3, #31). Owned writes mark
 * pending work; an owned-but-edited file is drift (warn + check-mode work); an
 * unowned or unsafe-to-overwrite file is a hard conflict (blocks even --apply).
 */
function recordCopyOutcome(result, name, key, action, apply) {
  if (action === 'create' || action === 'update' || action === 'force-update') {
    result.needsWork = result.needsWork || !apply;
  } else if (action === 'skip-user-modified') {
    result.drifts.push({ name, file: key });
    // Drift is pending work; needsWork drives check-mode exit 1 (not --apply).
    result.needsWork = true;
    result.warnings.push(`${key} (drift — user-modified) — left untouched`);
  } else if (
    action === 'skip-conflict' ||
    action === 'skip-non-regular' ||
    action === 'skip-unreadable'
  ) {
    result.conflicts.push({ name, file: key, action });
    result.warnings.push(`${key} (${action}) — left untouched`);
  }
}

/**
 * Sync all discovered extensions for one target ('claude' | 'codex').
 *
 * Ordering (D2): per extension, the manifest is parsed + validated BEFORE any
 * hard-copy, so a malformed manifest never leaves an orphaned, unregistered hook
 * copy behind. settings.json is written once at the end (D2), and hypo-pkg.json's
 * per-target SHA map is merged into the existing object (D2b) so the `commands`
 * map and other fields survive.
 *
 * Returns a structured result; `needsWork` is true when a copy/registration is
 * pending (drift), used by upgrade's check-mode exit code.
 */
export function syncExtensions({
  extDir,
  hypoDir,
  target = 'claude',
  settingsPath,
  pkgPath,
  apply = false,
  force = false,
}) {
  const result = {
    target,
    actions: [],
    registered: [],
    warnings: [],
    // Hard conflicts (E3, #31): a file we do NOT own — or cannot safely overwrite
    // (symlink/non-regular/unreadable) — already occupies the target path. These
    // block install with exit 1 even under --apply; --force-extensions resolves the
    // owned/unowned-file cases (backup + overwrite) but never follows a symlink.
    conflicts: [],
    // Drift (E3, #31): a file we own whose on-disk copy the user has since edited.
    // Warned + counted as pending work (check-mode exit 1, mirroring slash commands)
    // but NOT a hard block under --apply. --force-extensions overwrites it.
    drifts: [],
    settingsChanged: false,
    needsWork: false,
  };

  const types = target === 'codex' ? CODEX_TYPES : EXT_TYPES;
  const targetRoot = pkgRootDir(target);
  const patterns = loadHypoIgnore(hypoDir);
  const discovered = discoverExtensions(extDir, patterns, hypoDir);
  result.warnings.push(...discovered.warnings);

  // E4: Codex supports hooks + commands only. If the user authored
  // skills/agents extensions, surface a one-time notice that they are skipped
  // for this target rather than silently dropping them (plan §2 E4).
  if (target === 'codex') {
    const skipped = discovered.skills.length + discovered.agents.length;
    if (skipped > 0) {
      result.warnings.push(
        `${skipped} skill/agent extension(s) skipped for Codex — only hooks + commands are supported`,
      );
    }
  }

  const recorded = readExtensionPkgStateNoMutate(pkgPath, target);
  const newSHAs = {};
  // Preserve recorded SHAs for types this target does not cover (e.g. codex skips
  // skills/agents) so a Claude-then-Codex run does not drop Claude's records.
  for (const [k, v] of Object.entries(recorded)) {
    const t = k.split('/')[0];
    if (!types.includes(t)) newSHAs[k] = v;
  }

  const expectedHookExts = [];

  // capture design §3/§3a: resolve each extension's install filename (installName
  // decoupling) and detect duplicate install targets BEFORE any hard-copy. A
  // case-folded collision on `${type}/${installFile}` (two wiki files mapping to
  // the same install path, or a case-only clash on macOS/Windows) skips the
  // WHOLE group — otherwise file traversal order would decide ownership and
  // overwrite/skip unpredictably. Keyed by ext object identity.
  const installFileByExt = new Map();
  const dupSkip = new Set();
  for (const type of types) {
    const seen = new Map(); // case-folded `${type}/${installFile}` → first ext
    for (const ext of discovered[type]) {
      const res = resolveInstallFile(ext);
      if (res.skip) {
        dupSkip.add(ext);
        result.warnings.push(res.warn);
        continue;
      }
      installFileByExt.set(ext, res.installFile);
      const norm = `${type}/${res.installFile.toLowerCase()}`;
      const first = seen.get(norm);
      if (first !== undefined) {
        dupSkip.add(ext);
        dupSkip.add(first);
        result.warnings.push(
          `${type}/${res.installFile} install target claimed by multiple extensions — all skipped (rename installName)`,
        );
      } else {
        seen.set(norm, ext);
      }
    }
  }

  // Preserve the ownership record of an already-installed file whose extension we
  // now skip on a duplicate-target collision. Without this, the newSHAs map (which
  // replaces the target map wholesale) would drop the recorded SHA and orphan the
  // previously-owned installed copy — it would linger on disk, untracked by doctor
  // and unreachable by uninstall (codex pre-commit BLOCKER).
  for (const ext of dupSkip) {
    const inst = installFileByExt.get(ext);
    if (!inst) continue; // invalid-installName skip: never owned
    const key = `${ext.type}/${inst}`;
    if (recorded[key] !== undefined && newSHAs[key] === undefined) newSHAs[key] = recorded[key];
  }

  for (const type of types) {
    const typeDir = join(targetRoot, type);
    for (const ext of discovered[type]) {
      if (dupSkip.has(ext)) continue;
      // Install under the manifest-declared installName (capture design §3) or, by
      // default, the wiki storage name (backward compatible).
      const installFile = installFileByExt.get(ext) ?? ext.file;
      // D3: validate the manifest before touching the filesystem.
      let manifestParsed = null;
      if (type === 'hooks') {
        if (ext.manifestPath) {
          manifestParsed = parseManifest(ext.manifestPath);
          if (!manifestParsed.ok) {
            result.warnings.push(
              `${type}/${ext.manifestName} is malformed (${manifestParsed.error}) — skipping ${ext.name}`,
            );
            continue;
          }
        } else {
          result.warnings.push(`${ext.name}.manifest.json missing — hook will not auto-register`);
        }
      }

      if (apply) mkdirSync(typeDir, { recursive: true });

      // (2) hard-copy the main file. Key + destPath use installFile so the
      // recorded SHA map, doctor, and uninstall all agree on the install path.
      const fileKey = `${type}/${installFile}`;
      const fileRes = copyOne({
        srcPath: ext.srcPath,
        destPath: join(typeDir, installFile),
        key: fileKey,
        recordedSHA: recorded[fileKey],
        apply,
        force,
      });
      if (fileRes.sha != null) newSHAs[fileKey] = fileRes.sha;
      result.actions.push({ target, file: fileKey, action: fileRes.action });
      recordCopyOutcome(result, ext.name, fileKey, fileRes.action, apply);

      // If the main hook file was NOT written/owned by us (a pre-existing
      // unowned file or a user-modified copy), we must not copy its manifest or
      // register a settings entry — that would activate a file we refused to
      // overwrite. The conflict/drift is recorded above; init/upgrade turn a hard
      // conflict into exit 1 (E3, #31) unless --force-extensions resolves it.
      const ownedMainFile = OWNED_ACTIONS.has(fileRes.action);

      // (2b) hard-copy the manifest alongside, when present + valid + owned, so
      // its SHA is tracked and ~/.claude stays self-describing.
      if (
        type === 'hooks' &&
        ownedMainFile &&
        ext.manifestPath &&
        manifestParsed &&
        manifestParsed.ok
      ) {
        const mKey = `${type}/${ext.manifestName}`;
        const mRes = copyOne({
          srcPath: ext.manifestPath,
          destPath: join(typeDir, ext.manifestName),
          key: mKey,
          recordedSHA: recorded[mKey],
          apply,
          force,
        });
        if (mRes.sha != null) newSHAs[mKey] = mRes.sha;
        result.actions.push({ target, file: mKey, action: mRes.action });
        recordCopyOutcome(result, ext.name, mKey, mRes.action, apply);
        if (manifestParsed.registrable) expectedHookExts.push(ext);
      }
    }
  }

  // (3) settings.json registration — single write, path-based identity (D1).
  const targetHooksDir = join(targetRoot, 'hooks');
  const expectedEntries = buildExpectedSettingsEntries(expectedHookExts, targetHooksDir);
  if (expectedEntries.length > 0) {
    const reg = registerSettings(settingsPath, expectedEntries, apply);
    result.registered = reg.registered;
    result.settingsChanged = reg.changed;
    if (reg.changed && !apply) result.needsWork = true;
    if (reg.invalidJson) {
      result.warnings.push(`${settingsPath} is not valid JSON — extension hooks not registered`);
    }
  }

  // (4) persist per-target SHA map, merged into the existing pkg object (D2b).
  if (apply) {
    const existing = readFullPkgNoMutate(pkgPath);
    const extObj =
      existing.extensions &&
      typeof existing.extensions === 'object' &&
      !Array.isArray(existing.extensions)
        ? { ...existing.extensions }
        : {};
    extObj[target] = newSHAs;
    writePkgJsonAtomic(pkgPath, { ...existing, extensions: extObj });
  }
  result.newSHAs = newSHAs;

  return result;
}

/**
 * Reconcile the expected ext hook entries into settings.json (§8.12 b).
 *
 * For each entry we locate any group whose hooks[] array contains our command
 * (D1, path-based identity) — single-hook groups owned exclusively by us AND
 * mixed groups where a sibling plugin's hook shares the matcher. We collect ALL
 * occurrences, rank them by an 8-step priority, pick one canonical, drop the
 * rest (cleanup pre-existing duplicates), and mutate the canonical with the
 * lowest-disturbance edit that lands the manifest-derived shape.
 *
 * Priority (lowest rank wins, ties break by settings traversal order):
 *   1. target event · single-hook ours · exact desired shape          (no-op)
 *   2. target event · mixed · matcher matches · our hook exact         (no-op)
 *   3. target event · single-hook ours · drift                         (group patch)
 *   4. target event · mixed · matcher matches · our hook drift         (in-place hook patch)
 *   5. target event · mixed · matcher differs                          (extract + append new)
 *   6. non-target event · single-hook ours                             (splice + append new)
 *   7. non-target event · mixed                                        (extract + append new)
 *   8. no occurrence                                                   (append new)
 *
 * Mixed-group invariant (amendment 2026-05-23): foreign hooks
 * sharing the matcher group are NEVER read, modified, or reordered. The hosting
 * group's matcher is also left exactly as-is once we extract — even when our
 * extraction is the reason the group becomes single-foreign. Foreign handler-
 * level fields (`if`, `args`, `async`, `statusMessage`, …) are not even
 * inspected (path-identity on `command` is the sole match key). Empty groups
 * left behind by extraction are removed.
 *
 * Our hook entry, however, is canonical-reset on any drift mutation (ranks 3
 * and 4): the entire prior hook object — including any handler-level fields a
 * user appended to our hypo-ext-* entry — is replaced by the manifest-derived
 * `{ type, command, timeout? }` shape. This mirrors the hard-copy
 * ownership semantic for hypo-ext-* file copies. Users who want extra handler
 * fields on a Hypomnema-managed extension must extend the manifest, not edit
 * settings.json directly (manifest-as-SoT). registerSettings is honest about
 * this in its rank-3/rank-4 mutation steps below.
 *
 * Idempotency: rank-1 and rank-2 are explicit no-ops (output JSON byte-matches
 * input). Every other rank converges after one pass — a second registerSettings
 * call sees the just-written single-hook or in-place hook, scores it rank-1 or
 * rank-2, and writes nothing.
 *
 * Doctor mirror: `scripts/doctor.mjs:776-802` previously only
 * recognised single-hook groups as "owning" our command — it warned `not
 * registered` for a mixed-group occurrence this function now accepts as
 * canonical. The doctor side was updated in lock-step using the
 * `collectOurOccurrences` helper exported below, so write-path acceptance and
 * read-path recognition stay aligned.
 */
/**
 * Find every occurrence of `command` across every matcher group in `hooks`.
 * Returns an array of locators in settings traversal order — the canonical
 * tie-breaker when ranking matches in registerSettings.
 *
 * Exported so `scripts/doctor.mjs` can use the same locator and
 * accept mixed-group ownership instead of warning `not registered`.
 *
 * @param {object} hooks - settings.json `hooks` object (event → group[])
 * @param {string} command - the manifest-derived command string to match
 * @returns {Array<{event: string, groupIdx: number, hookIdx: number,
 *                  group: object, hook: object, isMixed: boolean}>}
 */
export function collectOurOccurrences(hooks, command) {
  const out = [];
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIdx) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, hookIdx) => {
        if (hook && hook.command === command) {
          out.push({
            event,
            groupIdx,
            hookIdx,
            group,
            hook,
            isMixed: group.hooks.length > 1,
          });
        }
      });
    });
  }
  return out;
}

// Rank an occurrence against the desired entry. Lower = preferred canonical.
// See registerSettings docstring for the 8-step table (ranks 1-7 here; 8 is
// "no occurrence found" handled by the caller).
//
// Exported so `scripts/doctor.mjs` can mirror the write-
// path canonical selection rather than picking the first traversal-order
// occurrence — otherwise doctor warns "differs" on a drifted earlier match
// while upgrade --apply silently accepts a rank-1 later one.
export function rankOccurrence(occ, entry, desiredHook) {
  const onTarget = occ.event === entry.event;
  const groupMatcher = occ.group.matcher;
  const matcherMatches =
    (groupMatcher === undefined || groupMatcher === null ? undefined : groupMatcher) ===
    (entry.matcher === undefined || entry.matcher === null ? undefined : entry.matcher);
  const hookExact = JSON.stringify(occ.hook) === JSON.stringify(desiredHook);

  if (!onTarget) return occ.isMixed ? 7 : 6;
  if (!occ.isMixed) return hookExact && matcherMatches ? 1 : 3;
  // mixed on target
  if (matcherMatches && hookExact) return 2;
  if (matcherMatches) return 4;
  return 5;
}

/**
 * Pick the canonical occurrence for `entry` from `occurrences`, mirroring the
 * write-path selection in registerSettings (lowest rank wins; ties break by
 * settings traversal order — assumes the caller passed `collectOurOccurrences`
 * output, which traverses events + groups + hooks in JSON key/array order).
 * Returns `{ occ, rank } | null`.
 *
 * Exported so doctor reports drift against the SAME occurrence that
 * upgrade --apply will treat as canonical — otherwise an earlier drifted
 * occurrence would be flagged "differs" while a later exact occurrence is the
 * actual canonical. Note: rank 1/2 means the canonical SHAPE is accepted, but
 * upgrade --apply may still rewrite settings.json to remove non-canonical
 * duplicates (doctor also surfaces `occurrences.length > 1` for that reason).
 */
export function pickCanonicalOccurrence(occurrences, entry, desiredHook) {
  let canonical = null;
  let canonicalRank = Infinity;
  for (const occ of occurrences) {
    const r = rankOccurrence(occ, entry, desiredHook);
    if (r < canonicalRank) {
      canonicalRank = r;
      canonical = occ;
    }
  }
  return canonical ? { occ: canonical, rank: canonicalRank } : null;
}

// Locate a matcher-group object reference inside the settings.hooks tree.
// Returns null if the object has already been removed.
//
// Reference-based locators (instead of recorded {event, groupIdx, hookIdx}
// numeric paths) are mandatory for cleanup-then-mutate safety: cleanup may
// splice arrays at lower indices than the canonical, which would invalidate
// any recorded numeric path. Object identity survives the splice.
function locateGroup(hooks, groupRef) {
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const gi = groups.indexOf(groupRef);
    if (gi !== -1) return { event, groupIdx: gi };
  }
  return null;
}

// Remove a matcher-group from its hosting event. If the event is left with no
// groups, delete the event key so downstream iteration doesn't see empty arrays.
function removeGroup(hooks, groupRef) {
  const loc = locateGroup(hooks, groupRef);
  if (!loc) return;
  hooks[loc.event].splice(loc.groupIdx, 1);
  if (hooks[loc.event].length === 0) delete hooks[loc.event];
}

// Splice a single hook object out of its matcher-group. If the group becomes
// empty as a result, also remove the group. Foreign hook entries sharing the
// group AND the group-level matcher are NEVER read or modified — `indexOf` on
// the explicit hook reference is the sole locator.
function removeHook(hooks, groupRef, hookRef) {
  const hi = groupRef.hooks.indexOf(hookRef);
  if (hi === -1) return;
  groupRef.hooks.splice(hi, 1);
  if (groupRef.hooks.length === 0) removeGroup(hooks, groupRef);
}

function registerSettings(settingsPath, expectedEntries, apply) {
  let original = '';
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      original = readFileSync(settingsPath, 'utf-8');
      settings = JSON.parse(original);
    } catch {
      return { registered: [], changed: false, invalidJson: true };
    }
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  const registered = [];
  for (const entry of expectedEntries) {
    registered.push(`${entry.event}: ${entry.name}`);

    const desiredHook = { type: 'command', command: entry.command };
    if (entry.timeout) desiredHook.timeout = entry.timeout;
    const desiredGroup = { hooks: [desiredHook] };
    if (entry.matcher) desiredGroup.matcher = entry.matcher;

    // 1. collect ALL occurrences (single + mixed across all events). Each
    //    occurrence carries direct references to its container group and hook
    //    objects — numeric (event, groupIdx, hookIdx) coordinates are recorded
    //    only for ranking, never used for mutation (BLOCKER #1 fix from #47
    //    pre-commit review: cleanup may invalidate numeric paths; object
    //    identity is the only stable locator).
    const occurrences = collectOurOccurrences(settings.hooks, entry.command);

    // 2. rank + pick canonical (lowest rank; first occurrence in traversal
    //    order wins on tie because `<` is strict). Doctor uses the same
    //    helper so its drift report matches what --apply will actually do.
    const picked = pickCanonicalOccurrence(occurrences, entry, desiredHook);
    const canonical = picked ? picked.occ : null;
    const canonicalRank = picked ? picked.rank : Infinity;

    // 3. drop non-canonical occurrences (cleanup pre-existing duplicates).
    //    Removal is by (group ref, hook ref) — index shifts at any depth do
    //    not corrupt the canonical's hook reference, which we still hold.
    for (const occ of occurrences) {
      if (occ === canonical) continue;
      removeHook(settings.hooks, occ.group, occ.hook);
    }

    // 4. apply mutation to canonical OR create new. All locators are by
    //    object identity; numeric indices from step 1 are no longer trusted.
    if (!canonical) {
      // rank 8 — no occurrence.
      if (!Array.isArray(settings.hooks[entry.event])) settings.hooks[entry.event] = [];
      settings.hooks[entry.event].push(desiredGroup);
    } else if (canonicalRank === 1 || canonicalRank === 2) {
      // exact — no-op (idempotent).
    } else if (canonicalRank === 3) {
      // target single-hook drift → replace the canonical group object with
      // the manifest-derived shape. Our hook entry is canonical-reset on this
      // path (any user-added handler fields are discarded — that mirrors the
      // hard-copy ownership semantic for hypo-ext-*).
      const loc = locateGroup(settings.hooks, canonical.group);
      if (loc) settings.hooks[loc.event][loc.groupIdx] = desiredGroup;
    } else if (canonicalRank === 4) {
      // target mixed, matcher matches, our hook drifted → replace OUR hook
      // entry (looked up by identity) with the manifest-derived shape.
      // Foreign hooks and the group-level matcher are untouched; our own
      // hook is canonical-reset (handler-level user mods on the hypo-ext-*
      // hook are not preserved — by the same ownership semantic).
      const hi = canonical.group.hooks.indexOf(canonical.hook);
      if (hi !== -1) canonical.group.hooks[hi] = desiredHook;
    } else {
      // ranks 5/6/7 — extract our hook from its current group (foreign
      // siblings + matcher in the source group remain exactly as found) and
      // append a fresh single-hook group under the target event.
      removeHook(settings.hooks, canonical.group, canonical.hook);
      if (!Array.isArray(settings.hooks[entry.event])) settings.hooks[entry.event] = [];
      settings.hooks[entry.event].push(desiredGroup);
    }
  }

  const next = JSON.stringify(settings, null, 2) + '\n';
  const changed = next !== original;
  if (changed && apply) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, next);
  }
  return { registered, changed, invalidJson: false };
}
