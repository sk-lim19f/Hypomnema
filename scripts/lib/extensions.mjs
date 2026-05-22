/**
 * scripts/lib/extensions.mjs — User extensions companion sync (ADR 0024, fix #29 + #30).
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

// Required filename prefix (ADR 0024 §2 recommends; plan §5 #9 enforces). Files
// without it are skipped so uninstall (which strips hypo-ext-*) can always reach
// every file we install — and so a stray name cannot collide with core hooks.
export const EXT_PREFIX = 'hypo-ext-';

// Codex supports hooks + commands only; skills/agents are Claude-only (ADR 0024 §4).
export const CODEX_TYPES = ['hooks', 'commands'];

// Per-type expected file extension. Hooks are executable .mjs; the rest are .md.
const TYPE_FILE_EXT = { hooks: '.mjs', commands: '.md', skills: '.md', agents: '.md' };

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
 * `warnings` array. Applies the `.hypoignore` filter (#30), the basename
 * whitelist (#9), and pairs each file with its optional `<name>.manifest.json`.
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

  // E4 (#32): Codex supports hooks + commands only. If the user authored
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

  for (const type of types) {
    const typeDir = join(targetRoot, type);
    for (const ext of discovered[type]) {
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

      // (2) hard-copy the main file.
      const fileKey = `${type}/${ext.file}`;
      const fileRes = copyOne({
        srcPath: ext.srcPath,
        destPath: join(typeDir, ext.file),
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
 * For each entry we locate the single-hook group that owns its command (D1,
 * path-based identity). If it already sits in the right event with the right
 * matcher/timeout, it is left untouched — so a no-op run does not rewrite the
 * file (idempotent). If the manifest changed matcher/timeout, the group is
 * patched in place; if the event changed, the stale group is removed and a fresh
 * one added under the new event. A pre-existing multi-hook group containing our
 * command is treated as a manual edit and left alone (drift; E3 handles force).
 *
 * E3 scope note (#31): settings.json entry drift is NOT surfaced here. Without a
 * recorded last-written entry we cannot tell a user edit apart from a manifest
 * change (the latter must auto-update — see the "manifest change re-registers"
 * test), so this reconcile silently self-heals a single-hook group back to the
 * manifest-derived shape. Detecting + reporting settings-entry mismatch is E5's
 * job (#33, doctor integrity §8.12-7). Mixed-group surgical replacement (preserve
 * sibling plugins' hooks, swap only ours) is likewise deferred — today a foreign
 * hook sharing our group is left untouched as drift.
 */
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

  const isOurGroup = (g, command) =>
    g &&
    typeof g === 'object' &&
    Array.isArray(g.hooks) &&
    g.hooks.length === 1 &&
    g.hooks[0] &&
    g.hooks[0].command === command;

  const registered = [];
  for (const entry of expectedEntries) {
    registered.push(`${entry.event}: ${entry.name}`);

    const desiredHook = { type: 'command', command: entry.command };
    if (entry.timeout) desiredHook.timeout = entry.timeout;
    const desiredGroup = { hooks: [desiredHook] };
    if (entry.matcher) desiredGroup.matcher = entry.matcher;

    // Locate the single-hook group that owns this command, in any event.
    let foundEvent = null;
    let foundIdx = -1;
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      const idx = groups.findIndex((g) => isOurGroup(g, entry.command));
      if (idx !== -1) {
        foundEvent = event;
        foundIdx = idx;
        break;
      }
    }

    if (foundEvent === entry.event) {
      // Same event — patch in place only if matcher/timeout drifted.
      if (JSON.stringify(settings.hooks[entry.event][foundIdx]) !== JSON.stringify(desiredGroup)) {
        settings.hooks[entry.event][foundIdx] = desiredGroup;
      }
    } else {
      // Event migration or first registration.
      if (foundEvent !== null) settings.hooks[foundEvent].splice(foundIdx, 1);
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
