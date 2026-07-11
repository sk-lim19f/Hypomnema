#!/usr/bin/env node
/**
 * scripts/capture.mjs — Reverse extension capture (MVP capture design).
 *
 * Pulls extensions authored the "normal way" under `~/.claude/{commands,agents}/`
 * (readdir enumeration) and canonical hooks registered in `~/.claude/settings.json`
 * (settings enumeration) into the wiki `~/hypomnema/extensions/{commands,agents,hooks}/`
 * so they propagate to other machines via the existing forward-sync ("register on
 * A → sync on B").
 *
 * Scope: commands + agents (pure file copy, no settings.json), hooks (settings
 * reverse-capture, lossless round-trip only), and skills (a DIRECTORY: SKILL.md
 * plus an arbitrary subtree, stored as `extensions/skills/hypo-ext-<name>/`).
 *
 * Skills (skills-capture design): the same subtree walker forward-sync uses is run
 * in `strict` mode here, so anything that cannot round-trip through the wiki
 * (symlink, hardlink, empty directory, VCS control dir, reserved manifest name)
 * refuses the WHOLE skill rather than capturing a lossy subset — what lands in the
 * wiki is exactly what the far machine installs. Cumulative ceilings abort the walk
 * early so a vendored skill (14k files, 1.1GB) never gets enumerated in full.
 *
 * Naming (capture design §3): the wiki STORAGE name is `hypo-ext-<name>.<ext>` (keeps
 * the discovery whitelist), and a sidecar `hypo-ext-<name>.manifest.json` records
 * `{ type, installName, ... }` so forward-sync installs the file back under the
 * user's ORIGINAL name (`~/.claude/<type>/<name>.<ext>`), not the wiki storage name.
 * For hooks the manifest also carries `{ event, matcher?, timeout? }` so the original
 * settings.json registration is restored on the far machine.
 *
 * Adopt (capture design §4): capture copies the source verbatim into the wiki, then
 * runs forward-sync. The install target already holds byte-identical content, so
 * `copyOne` hits its `up-to-date` branch and records the SHA — ownership is
 * acquired through the normal sync path, never by injecting a SHA directly.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  renameSync,
  realpathSync,
  lstatSync,
  openSync,
  closeSync,
} from 'fs';
import { randomBytes } from 'crypto';
import { join, dirname, relative, sep } from 'path';
import { homedir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import {
  sha256,
  isRegularFile,
  readFileIfRegular,
  readPkgJson,
  writePkgJsonAtomic,
} from './lib/pkg-json.mjs';
import { resolveHypoRoot } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';
import {
  syncExtensions,
  readExtensionPkgStateNoMutate,
  isValidInstallStem,
  isValidSkillDirSegment,
  parseSkillKey,
  parseSkillShaValue,
  walkSkillSubtree,
  emptyShaMap,
  isRealDir,
  isContainedUnder,
  hasSymlinkAncestor,
  scanSettingsHooks,
  parseCapturableHookCommand,
  HOOK_EVENT_ALLOWLIST,
  SKILL_ROOT_FILE,
  EXT_PREFIX,
} from './lib/extensions.mjs';
import { readCoreHooksConfig, deriveCoreHookBasenames } from './lib/core-hooks.mjs';

const HOME = homedir();

// The package root (contains hooks/hooks.json) so reverse-capture can reserve the
// core hook basenames without importing init.mjs (which has exit-on-error side
// effects). capture.mjs lives in scripts/, so the root is one level up.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Captured types and their singular manifest `type` value. commands/agents install
// as top-level `.md` files; hooks install as `.mjs` and additionally register a
// settings.json entry (reverse of forward-sync); skills install as a DIRECTORY.
const CAPTURE_TYPES = ['commands', 'agents', 'hooks', 'skills'];
// The flat, single-file types. `TYPE_EXT` has no `skills` entry on purpose: a skill
// has no install extension, and letting it through a flat helper would silently
// build paths with an `undefined` suffix. Every flat helper keys off this list.
const FLAT_TYPES = ['commands', 'agents', 'hooks'];
// The flat types enumerated by readdir. hooks are enumerated from the settings.json
// registration instead, and skills have their own directory scanner.
const READDIR_TYPES = ['commands', 'agents'];
const TYPE_SINGULAR = { commands: 'command', agents: 'agent', hooks: 'hook', skills: 'skill' };
const TYPE_EXT = { commands: '.md', agents: '.md', hooks: '.mjs' };

// Ceilings for a captured skill subtree (skills-capture design §3). A hand-authored
// skill is a handful of files; a vendored one (gstack: 14,311 files / 1.1GB, mostly
// node_modules) must be refused, not copied into a git-tracked vault. Enforced as
// cumulative counters DURING the walk, from lstat sizes, so the verdict lands before
// anything is read and the candidate listing never enumerates a vendored tree.
const SKILL_MAX_FILES = 500;
const SKILL_MAX_BYTES = 5 * 1024 * 1024;
const SKILL_LIMITS = { strict: true, maxFiles: SKILL_MAX_FILES, maxBytes: SKILL_MAX_BYTES };

function pkgJsonPath() {
  return join(HOME, '.claude', 'hypo-pkg.json');
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Decide whether a top-level `~/.claude/<type>/<file>` is a capture candidate.
 * Excludes (capture design §6): the reserved `hypo` namespace (case-insensitive — core
 * hooks/commands + already-synced hypo-ext-* copies), anything already owned
 * (a recorded SHA for its install path means the wiki already manages it), and
 * non-.md files. Symlink/non-regular is checked by the caller (needs an fs stat).
 */
export function isCaptureCandidate(type, file, recorded) {
  if (!file.endsWith(TYPE_EXT[type])) return { ok: false, reason: `not a ${TYPE_EXT[type]} file` };
  const lower = file.toLowerCase();
  if (lower === 'hypo' || lower.startsWith('hypo-')) {
    return { ok: false, reason: 'reserved hypo namespace' };
  }
  if (recorded[`${type}/${file}`]) {
    return { ok: false, reason: 'already managed by the wiki' };
  }
  return { ok: true };
}

/** Order-independent deep equality for parsed JSON values (objects/arrays/scalars).
 * Manifests are compared by content, not key order, so a hand-reordered but
 * equivalent sidecar is still recognized as `already` rather than a false conflict. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Plan the capture of one candidate against the current wiki state. Generalized
 * over extension type: the caller assembles the desired `wantManifest` (commands
 * and agents get `{ type, installName }`; hooks additionally carry
 * `{ event, matcher?, timeout? }`) and this decides the outcome by comparing the
 * source SHA and doing a deep-equality check against any existing sidecar. Pure
 * w.r.t. decisions; the caller supplies the already-read source + wiki contents so
 * this stays testable.
 *
 * status:
 *   'invalid'  — the installName stem is unsafe/reserved (skip).
 *   'conflict' — a wiki storage file or sidecar manifest already exists and
 *                disagrees (refuse; never silently overwrite, capture design §7).
 *   'already'  — wiki file + manifest already match this capture (no-op).
 *   'ready'    — safe to write.
 */
export function planCapture({ wantManifest, srcSha, existingFileSha, existingManifestRaw }) {
  if (!isValidInstallStem(wantManifest.installName)) {
    return { status: 'invalid', reason: `invalid installName "${wantManifest.installName}"` };
  }

  if (existingFileSha !== null && existingFileSha !== undefined) {
    if (existingFileSha !== srcSha) {
      return { status: 'conflict', reason: 'wiki storage file exists with different content' };
    }
    // The storage file matches — the manifest must also match, else install
    // semantics (installName/event/matcher/timeout) would differ.
    if (existingManifestRaw == null) {
      return { status: 'conflict', reason: 'wiki file exists without its installName manifest' };
    }
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'wiki manifest is not valid JSON' };
    }
    if (!deepEqual(parsed, wantManifest)) {
      return { status: 'conflict', reason: 'wiki manifest declares a different mapping' };
    }
    return { status: 'already', manifest: wantManifest };
  }
  // No wiki storage file yet. A stray manifest with a different mapping is still a conflict.
  if (existingManifestRaw != null) {
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'stray wiki manifest is not valid JSON' };
    }
    if (!deepEqual(parsed, wantManifest)) {
      return { status: 'conflict', reason: 'stray wiki manifest declares a different mapping' };
    }
  }
  return { status: 'ready', manifest: wantManifest };
}

/**
 * The set of install directories the wiki VALIDLY owns as directory skills.
 *
 * Ownership must be read through the same schema the rest of the module trusts, not
 * raw property truthiness (skills-capture design §8). A corrupt hypo-pkg.json that
 * parks a string under `skills/mine` would otherwise read as "already managed" and
 * lock that skill out of capture forever, and it would also poison the "keys this
 * run newly recorded" bookkeeping the failed-adopt purge depends on.
 */
export function ownedSkillDirs(recorded) {
  const out = new Set();
  for (const [key, value] of Object.entries(recorded)) {
    const parsed = parseSkillKey(key);
    if (!parsed) continue;
    const nested = parseSkillShaValue(value);
    if (nested === null || Object.keys(nested).length === 0) continue;
    out.add(parsed.installDir);
  }
  return out;
}

/**
 * Plan the capture of one directory skill. Same three outcomes as the flat planner,
 * but `ready` is deliberately narrow: it means the wiki skill directory is WHOLLY
 * ABSENT (skills-capture design §4). That narrowness is what makes the rollback safe
 * — every path the rollback removes is a path this run created.
 *
 * `wikiShas` is null when the wiki directory does not exist, and a rel→sha map when
 * it does. A wiki path that exists but cannot be read as a clean skill (a file, a
 * symlink, a crash-truncated directory with no SKILL.md) arrives here as
 * `wikiPresent: true, wikiShas: null` and is a conflict — never a crash, never a
 * silent overwrite.
 */
export function planSkillCapture({
  wantManifest,
  srcShas,
  wikiPresent,
  wikiShas,
  existingManifestRaw,
}) {
  if (!isValidSkillDirSegment(wantManifest.installName)) {
    return { status: 'invalid', reason: `invalid installName "${wantManifest.installName}"` };
  }

  if (wikiPresent) {
    if (wikiShas === null) {
      return {
        status: 'conflict',
        reason: 'wiki target exists but is not a readable skill directory',
      };
    }
    if (!deepEqual(wikiShas, srcShas)) {
      return { status: 'conflict', reason: 'wiki skill directory exists with different content' };
    }
    if (existingManifestRaw == null) {
      return { status: 'conflict', reason: 'wiki skill exists without its installName manifest' };
    }
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'wiki manifest is not valid JSON' };
    }
    if (!deepEqual(parsed, wantManifest)) {
      return { status: 'conflict', reason: 'wiki manifest declares a different mapping' };
    }
    return { status: 'already', manifest: wantManifest };
  }

  // No wiki directory yet. A stray sidecar with a different mapping is still a conflict.
  if (existingManifestRaw != null) {
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'stray wiki manifest is not valid JSON' };
    }
    if (!deepEqual(parsed, wantManifest)) {
      return { status: 'conflict', reason: 'stray wiki manifest declares a different mapping' };
    }
  }
  return { status: 'ready', manifest: wantManifest };
}

/**
 * Reverse-generate the sidecar manifest for a capture candidate. commands/agents
 * carry only `{ type, installName }`; hooks additionally carry the settings
 * registration fields `{ event, matcher?, timeout? }`. matcher/timeout are omitted
 * when absent (an empty-string matcher is already normalized to undefined by the
 * scanner) via conditional spread, so the in-memory object never carries an
 * `undefined`-valued key that would break the planCapture deep-equality check.
 */
function buildWantManifest(c) {
  const manifest = { type: TYPE_SINGULAR[c.type], installName: c.stem };
  if (c.type === 'hooks') {
    manifest.event = c.event;
    if (c.matcher !== undefined && c.matcher !== '') manifest.matcher = c.matcher;
    if (c.timeout !== undefined) manifest.timeout = c.timeout;
  }
  return manifest;
}

// ── filesystem orchestration ─────────────────────────────────────────────────

/**
 * Enumerate capturable DIRECTORY skills under `~/.claude/skills/`.
 *
 * Every rejected entry gets a visible reason (never a silent drop): the strict walker
 * refuses the whole skill for anything that cannot round-trip, and the ceilings abort
 * the walk as soon as they are crossed. Returns `{ candidates, skipped }`.
 *
 * A flat `.md` under `skills/` is not a candidate: the directory is the real Claude
 * Code layout, and the flat form only exists as a backward-compatible wiki storage
 * shape. A symlinked directory is not a candidate either (never followed).
 *
 * `vault` is `{ hypoDir, patterns }` — the vault's `.hypoignore`. Capture must judge a
 * source file by the rule that will apply to it AFTER it lands in the wiki: forward-sync
 * discovers the wiki subtree through that filter, so a file the vault ignores (a `.pdf`
 * reference, a `.cache/` directory) would be written here and then dropped from
 * discovery, leaving the adopt check short one relpath and failing with no reason a user
 * could act on. Refuse it up front instead, with the pattern named.
 */
export function scanSkillCandidates(claudeHome, ownedDirs, vault = null) {
  const candidates = [];
  const skipped = [];
  const dir = join(claudeHome, 'skills');
  if (!existsSync(dir)) return { candidates, skipped };
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { candidates, skipped };
  }
  for (const name of entries) {
    const srcPath = join(dir, name);
    if (!isRealDir(srcPath)) continue; // flat .md, symlinked dir, or junk: not a skill dir
    const lower = name.toLowerCase();
    if (lower === 'hypo' || lower.startsWith('hypo-')) continue; // reserved namespace
    if (ownedDirs.has(name)) continue; // already managed by the wiki
    const label = `skills/${name}`;
    if (!isValidSkillDirSegment(name)) {
      skipped.push({ type: 'skills', file: name, reason: `unsafe skill directory name "${name}"` });
      continue;
    }
    // The SOURCE walk applies no ignore filter (the patterns are the vault's, and the
    // source lives under ~/.claude). The dir argument still has to be a string: isIgnored()
    // calls relative() on it before it ever looks at the (empty) patterns.
    const walked = walkSkillSubtree(srcPath, label, dir, [], SKILL_LIMITS);
    if (walked.skip) {
      skipped.push({
        type: 'skills',
        file: name,
        reason: walked.fatal || `no regular ${SKILL_ROOT_FILE} at the skill root`,
      });
      continue;
    }
    // Would any of these files be invisible to forward-sync once they are in the wiki?
    if (vault && vault.patterns.length > 0) {
      const wikiRootForSkill = join(vault.hypoDir, 'extensions', 'skills', `${EXT_PREFIX}${name}`);
      const ignored = walked.files.find((f) =>
        isIgnored(join(wikiRootForSkill, ...f.rel.split('/')), vault.hypoDir, vault.patterns),
      );
      if (ignored) {
        skipped.push({
          type: 'skills',
          file: name,
          reason: `${ignored.rel} matches the vault .hypoignore and would not sync back`,
        });
        continue;
      }
    }
    candidates.push({
      type: 'skills',
      file: name,
      stem: name,
      srcPath,
      isDir: true,
      files: walked.files,
    });
  }
  return { candidates, skipped };
}

function scanCandidates(claudeHome, recorded, types) {
  const out = [];
  for (const type of types) {
    // hooks come from the settings registration, skills from their own directory
    // scanner. Letting either through here would double-enumerate them.
    if (!READDIR_TYPES.includes(type)) continue;
    const dir = join(claudeHome, type);
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      const verdict = isCaptureCandidate(type, file, recorded);
      if (!verdict.ok) continue;
      const srcPath = join(dir, file);
      if (!isRegularFile(srcPath)) continue; // never follow symlinks/sockets
      out.push({ type, file, stem: file.slice(0, -TYPE_EXT[type].length), srcPath });
    }
  }
  return out;
}

// The preservable shape a capturable hook must have (F3). Anything outside these
// key sets, or a non-positive-integer timeout, means a lossless round-trip cannot
// be guaranteed → skip rather than drop a field on the far machine.
const ALLOWED_HOOK_KEYS = new Set(['type', 'command', 'timeout']);
const ALLOWED_GROUP_KEYS = new Set(['matcher', 'hooks']);

function subsetOf(keys, allowed) {
  for (const k of keys) if (!allowed.has(k)) return false;
  return true;
}

/**
 * Enumerate capturable hooks from `~/.claude/settings.json`. Unlike commands/agents
 * (readdir), hooks are discovered by walking the settings registration and keeping
 * only entries that round-trip losslessly to the canonical form forward-sync emits.
 * Returns `{ candidates, skipped }`; every rejected entry gets a visible skip reason
 * (never a silent drop, capture design F4) so a user can see why a hook was passed
 * over — including absolute-path / tilde registrations that are legal but not
 * canonical.
 *
 * A candidate must satisfy ALL of: strict command grammar
 * (`parseCapturableHookCommand`) resolving under `~/.claude/hooks/`; the resolved
 * `.mjs` is a real regular file (no symlink / non-regular); `type === 'command'`;
 * the event is in `HOOK_EVENT_ALLOWLIST`; a preservable shape (F3); the case-folded
 * basename appears exactly once across all settings hooks (F6); and the stem is not
 * a core hook, not the reserved hypo namespace, and not already wiki-owned.
 */
export function scanHookCandidates(claudeHome, settingsPath, recorded, coreBasenames) {
  const candidates = [];
  const skipped = [];
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    // Absent or invalid settings.json → nothing to capture (not an error).
    return { candidates, skipped };
  }

  const records = scanSettingsHooks(settings);

  // First pass: count case-folded basenames across every record whose command
  // parses to a canonical basename. A basename seen 2+ times (multiple events, or
  // the same event with different matchers) cannot be reverse-generated to a single
  // manifest, so ALL its registrations are skipped (F6).
  const parsedByRecord = new Map();
  const basenameCounts = new Map();
  for (const rec of records) {
    const parsed = parseCapturableHookCommand(rec.command);
    parsedByRecord.set(rec, parsed);
    if (parsed.ok) {
      const key = parsed.basename.toLowerCase();
      basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
    }
  }

  // Second pass: classify each record.
  for (const rec of records) {
    const parsed = parsedByRecord.get(rec);
    if (!parsed.ok) {
      skipped.push({ type: 'hooks', command: rec.command, reason: parsed.reason });
      continue;
    }
    const { stem, basename } = parsed;
    const label = `hooks/${basename}`;

    // Duplicate first: a basename registered 2+ times is uniformly skipped so both
    // sides report the same reason.
    if (basenameCounts.get(basename.toLowerCase()) >= 2) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'duplicate-registration',
      });
      continue;
    }
    if (rec.type !== 'command') {
      skipped.push({ type: 'hooks', command: rec.command, basename, reason: 'non-command-type' });
      continue;
    }
    if (!HOOK_EVENT_ALLOWLIST.has(rec.event)) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'event-not-allowlisted',
      });
      continue;
    }
    if (
      !subsetOf(rec.hookKeys, ALLOWED_HOOK_KEYS) ||
      !subsetOf(rec.groupKeys, ALLOWED_GROUP_KEYS) ||
      (rec.timeout !== undefined && !(Number.isInteger(rec.timeout) && rec.timeout > 0))
    ) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'unpreservable-shape',
      });
      continue;
    }
    if (coreBasenames.has(basename.toLowerCase())) {
      skipped.push({ type: 'hooks', command: rec.command, basename, reason: 'core-hook' });
      continue;
    }
    if (recorded[label]) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'already-managed by the wiki',
      });
      continue;
    }
    // The command resolved under $HOME/.claude/hooks; the source must be a real
    // regular file there (a symlink or non-regular is refused, capture design F4).
    const srcPath = join(claudeHome, 'hooks', basename);
    if (!existsSync(srcPath) || !isRegularFile(srcPath)) {
      skipped.push({ type: 'hooks', command: rec.command, basename, reason: 'unresolved-source' });
      continue;
    }
    candidates.push({
      type: 'hooks',
      file: basename,
      stem,
      srcPath,
      event: rec.event,
      matcher: rec.matcher,
      timeout: rec.timeout,
      label,
    });
  }
  return { candidates, skipped };
}

function parseArgs(argv) {
  const args = { names: [], all: false, types: CAPTURE_TYPES.slice(), dryRun: false, help: false };
  let hypoDir = null;
  for (const a of argv.slice(2)) {
    if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--type=')) {
      args.types = a
        .slice(7)
        .split(',')
        .map((s) => s.trim())
        .filter((t) => CAPTURE_TYPES.includes(t));
    } else if (a.startsWith('--hypo-dir=')) hypoDir = a.slice(11);
    else if (!a.startsWith('-')) args.names.push(a);
  }
  args.hypoDir = hypoDir || resolveHypoRoot();
  if (args.types.length === 0) args.types = CAPTURE_TYPES.slice();
  return args;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// Write via a sibling temp + rename so the final replace is atomic and, crucially,
// never follows a symlink already sitting at `dest` (rename swaps the link itself).
//
// The temp path is randomized and opened with `wx` (O_CREAT|O_EXCL). The old
// `${dest}.tmp.${pid}` name was predictable, and writeFileSync on a path someone had
// already planted a symlink at would follow it straight out of the wiki. O_EXCL fails
// on an existing path of any kind, symlink included.
function writeAtomic(dest, buf) {
  const tmp = `${dest}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, 'wx');
  try {
    writeFileSync(fd, buf);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Undo one capture's wiki writes: drop the storage file(s), and either restore the
// manifest bytes we overwrote (a pre-existing same-mapping sidecar) or remove the
// manifest we created. Used on a failed/aborted adopt so a capture never half-lands.
//
// A skill's rollback walks the ledger of paths this run actually created, newest
// first: files, then the directories that held them. It never removes a tree
// wholesale. The plan only says `ready` when the wiki directory was absent, and the
// root is claimed with an exclusive mkdir, so everything in the ledger is ours — but
// deleting only what we recorded is what makes that true by construction rather than
// by trusting a check made earlier in time.
function rollbackRec(rec) {
  // A skill ledger is AUTHORITATIVE: only paths this run actually created are removed,
  // and the manifest is touched only if we actually wrote it. The flat branch below
  // unlinks `manifestPath` unconditionally, which is wrong for a skill whose write
  // failed BEFORE the manifest was written — a dangling sidecar symlink is invisible to
  // existsSync, so the guard refuses the write and the rollback would then delete a
  // path the run never touched (codex pre-commit BLOCKER, with a repro).
  if (rec.createdFiles) {
    for (const p of [...rec.createdFiles].reverse()) {
      try {
        unlinkSync(p);
      } catch {}
    }
    for (const d of [...(rec.createdDirs || [])].reverse()) {
      try {
        rmdirSync(d); // fails on a non-empty dir, which is the point: never a tree wipe
      } catch {}
    }
    if (rec.manifestOverwritten && rec.manifestPrevBuf != null) {
      try {
        writeFileSync(rec.manifestPath, rec.manifestPrevBuf);
      } catch {}
    }
    return;
  }
  try {
    unlinkSync(rec.filePath);
  } catch {}
  if (rec.manifestExisted && rec.manifestPrevBuf != null) {
    try {
      writeFileSync(rec.manifestPath, rec.manifestPrevBuf);
    } catch {}
  } else {
    try {
      unlinkSync(rec.manifestPath);
    } catch {}
  }
}

/**
 * Write one directory skill into the wiki, recording every path created so a failed
 * adopt can be undone exactly (skills-capture design §5/§7).
 *
 * Order: the sidecar manifest first, then the subtree with SKILL.md LAST. A crash at
 * any point therefore leaves a directory with no SKILL.md, which discovery skips —
 * never a half-skill that the far machine would partially install.
 *
 * `guard` re-checks the destination against the wiki boundary immediately before each
 * mutation. Lexical containment cannot see a symlinked ancestor, and the boundary has
 * to be the wiki root itself: rooting the walk at `extensions/skills` would lstat
 * straight through a symlinked `extensions/`.
 */
function writeSkill({ rec, skillRoot, manifestPath, manifest, files, guard, wikiRoot }) {
  const prev = readFileIfRegular(manifestPath);
  rec.manifestExisted = prev != null;
  rec.manifestPrevBuf = prev;

  if (!guard(manifestPath) || !guard(skillRoot)) {
    throw new Error('wiki path is not inside the vault or crosses a symlinked directory');
  }
  // Build the chain down to the type directory segment by segment, so a directory this
  // run creates (a fresh `extensions/skills/`) lands in the ledger and can be undone.
  // A recursive mkdir would create them silently and leak them on rollback.
  const typeDir = dirname(skillRoot);
  const chain = relative(wikiRoot, typeDir).split(sep).filter(Boolean);
  let cur = wikiRoot;
  for (const seg of chain) {
    cur = join(cur, seg);
    if (existsSync(cur)) continue;
    if (!guard(cur)) throw new Error('wiki path crosses a symlinked directory');
    mkdirSync(cur);
    rec.createdDirs.push(cur);
  }
  // Exclusive: EEXIST here means the "absent" verdict the plan made is already stale,
  // and the rollback must not be handed a directory it did not create.
  mkdirSync(skillRoot);
  rec.createdDirs.push(skillRoot);

  writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  // Record what the write actually did, not what we predicted it would do: the rollback
  // must never remove or restore a manifest it did not touch.
  if (rec.manifestExisted) rec.manifestOverwritten = true;
  else rec.createdFiles.push(manifestPath);

  // SKILL.md last: it is the file that makes the directory discoverable.
  const ordered = [
    ...files.filter((f) => f.rel !== SKILL_ROOT_FILE),
    ...files.filter((f) => f.rel === SKILL_ROOT_FILE),
  ];
  const madeDirs = new Set([skillRoot]);
  for (const f of ordered) {
    const destPath = join(skillRoot, ...f.rel.split('/'));
    if (!guard(destPath)) {
      throw new Error(`unsafe wiki destination for ${f.rel}`);
    }
    const parent = dirname(destPath);
    if (!madeDirs.has(parent)) {
      // Build the chain segment by segment so every new directory lands in the ledger.
      const segs = f.rel.split('/').slice(0, -1);
      let cur = skillRoot;
      for (const s of segs) {
        cur = join(cur, s);
        if (madeDirs.has(cur)) continue;
        if (!guard(cur)) throw new Error(`unsafe wiki destination for ${f.rel}`);
        mkdirSync(cur);
        rec.createdDirs.push(cur);
        madeDirs.add(cur);
      }
    }
    writeAtomic(destPath, readFileSync(f.srcPath));
    rec.createdFiles.push(destPath);
  }
}

// Remove specific per-target ownership keys from hypo-pkg.json (codex pre-commit
// CONCERN). A partial adopt can leave forward-sync having recorded SOME of a
// capture's install keys (e.g. the byte-identical `.mjs` was owned but its sidecar
// manifest could not be), and the wiki-file rollback alone would leave that
// ownership stranded: a later capture would skip the hook as already-managed and
// uninstall would trust the recorded SHA and delete the user's ORIGINAL hook.
// Reads the freshly-written pkg, drops only the given keys, and rewrites atomically.
function purgeOwnedKeys(pkgPath, target, keys) {
  if (keys.size === 0) return;
  const pkg = readPkgJson(pkgPath);
  const ext = pkg.extensions;
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return;
  const perTarget = ext[target];
  if (!perTarget || typeof perTarget !== 'object' || Array.isArray(perTarget)) return;
  let changed = false;
  for (const k of keys) {
    if (perTarget[k] !== undefined) {
      delete perTarget[k];
      changed = true;
    }
  }
  if (changed) writePkgJsonAtomic(pkgPath, pkg);
}

/**
 * Plan + write one directory skill. Pushes into the caller's captured/skipped/created
 * lists so the shared adopt + rollback machinery downstream treats it like any other
 * capture.
 *
 * The wiki side is read with the SAME strict walker as the source, so a wiki directory
 * that is unreadable, symlink-poisoned, or crash-truncated (no SKILL.md) surfaces as
 * `wikiShas: null` and lands on the conflict branch instead of being silently treated
 * as absent and then blown away by a rollback.
 */
function captureOneSkill({ c, extDir, guard, wikiRoot, args, captured, skipped, created }) {
  const wikiStem = `${EXT_PREFIX}${c.stem}`;
  const typeDir = join(extDir, 'skills');
  const skillRoot = join(typeDir, wikiStem);
  const manifestPath = join(typeDir, `${wikiStem}.manifest.json`);
  const label = `skills/${c.file}`;

  // Null-prototype: a skill file legitimately named `__proto__` would otherwise assign
  // through the prototype setter instead of creating an own key, so it would vanish from
  // the comparison and from the adopt check (forward-sync keeps its SHA maps this way for
  // the same reason). codex pre-commit CONCERN.
  const srcShas = emptyShaMap();
  for (const f of c.files) srcShas[f.rel] = sha256(readFileSync(f.srcPath));

  const wikiPresent = existsSync(skillRoot);
  let wikiShas = null;
  if (wikiPresent && isRealDir(skillRoot)) {
    const walked = walkSkillSubtree(skillRoot, label, args.hypoDir, [], SKILL_LIMITS);
    if (!walked.skip) {
      wikiShas = emptyShaMap();
      for (const f of walked.files) wikiShas[f.rel] = sha256(readFileSync(f.srcPath));
    }
  }
  if (existsSync(manifestPath) && !isRegularFile(manifestPath)) {
    const reason = 'wiki manifest exists but is not a regular file';
    log(`⊘ ${label}: ${reason} — skipped`);
    skipped.push({ ...c, reason, status: 'conflict' });
    return;
  }
  const existingManifestBuf = readFileIfRegular(manifestPath);
  const existingManifestRaw = existingManifestBuf ? existingManifestBuf.toString('utf-8') : null;

  const wantManifest = { type: TYPE_SINGULAR.skills, installName: c.stem };
  const plan = planSkillCapture({
    wantManifest,
    srcShas,
    wikiPresent,
    wikiShas,
    existingManifestRaw,
  });

  // The install key is the whole directory; forward-sync records one nested map under
  // it, one entry per relpath (skills-dir design).
  const rec = { ...c, installKey: `skills/${c.stem}`, srcShas };

  if (plan.status === 'invalid' || plan.status === 'conflict') {
    log(`⊘ ${label}: ${plan.reason} — skipped`);
    skipped.push({ ...rec, reason: plan.reason, status: plan.status });
    return;
  }
  if (plan.status === 'already') {
    log(`= ${label}: already captured`);
    captured.push({ ...rec, status: 'already' });
    return;
  }

  // Content round-trips; the executable bit does not (forward-sync writes with the
  // default mode). Say so rather than let a captured `scripts/run.sh` arrive
  // non-executable on the far machine without a word.
  const execFiles = c.files.filter((f) => {
    try {
      return (lstatSync(f.srcPath).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
  if (execFiles.length > 0) {
    log(
      `! ${label}: ${execFiles.length} executable file(s) — content is captured, but the executable bit is not carried by sync`,
    );
  }

  if (!args.dryRun) {
    // The ledger is owned by the caller so a throw MID-write is still recoverable: the
    // paths created before the failure are already recorded in it.
    const ledger = {
      type: 'skills',
      stem: c.stem,
      manifestPath,
      manifestExisted: false,
      manifestOverwritten: false,
      manifestPrevBuf: null,
      createdFiles: [],
      createdDirs: [],
    };
    try {
      writeSkill({
        rec: ledger,
        skillRoot,
        manifestPath,
        manifest: plan.manifest,
        files: c.files,
        guard,
        wikiRoot,
      });
    } catch (err) {
      rollbackRec(ledger);
      const reason = `wiki write failed (${err.message})`;
      log(`⊘ ${label}: ${reason} — skipped`);
      skipped.push({ ...rec, reason, status: 'conflict' });
      return;
    }
    created.push(ledger);
  }
  captured.push({ ...rec, status: 'ready' });
}

function run(args, { claudeHome = join(HOME, '.claude') } = {}) {
  // Resolve the vault root through realpath. Every wiki mutation below is boundary-
  // checked against it, and a symlinked ancestor INSIDE the vault must be caught while
  // a vault root that is itself a symlink (a perfectly normal setup) still works. Doing
  // it here means extDir and the sync call see the same real root.
  let wikiRoot = args.hypoDir;
  try {
    wikiRoot = realpathSync(args.hypoDir);
  } catch {
    // Not created yet: fall back to the lexical path; the guard below still applies.
  }
  const extDir = join(wikiRoot, 'extensions');
  const settingsPath = join(claudeHome, 'settings.json');
  const recorded = readExtensionPkgStateNoMutate(pkgJsonPath(), 'claude');
  // commands/agents enumerate by readdir; hooks enumerate from settings.json; skills
  // enumerate as directories under ~/.claude/skills.
  const candidates = scanCandidates(claudeHome, recorded, args.types);

  const scanSkipped = [];
  if (args.types.includes('skills')) {
    const skillScan = scanSkillCandidates(claudeHome, ownedSkillDirs(recorded), {
      hypoDir: wikiRoot,
      patterns: loadHypoIgnore(wikiRoot),
    });
    candidates.push(...skillScan.candidates);
    scanSkipped.push(...skillScan.skipped);
  }

  // Hooks are captured from the settings registration. Reserve the core hook
  // basenames deterministically from hooks.json; if that load is not ok (read,
  // parse, or shape failure) skip the whole hooks type rather than risk capturing
  // a core hook (T1 fail-closed contract: gate on ok, not on cfg presence).
  if (args.types.includes('hooks')) {
    const core = readCoreHooksConfig(PKG_ROOT);
    if (!core.ok) {
      log(`⊘ hooks: core hook reservations unavailable (${core.error}) — hooks capture skipped`);
    } else {
      const coreBasenames = deriveCoreHookBasenames(core.cfg);
      const hookScan = scanHookCandidates(claudeHome, settingsPath, recorded, coreBasenames);
      candidates.push(...hookScan.candidates);
      scanSkipped.push(...hookScan.skipped);
    }
  }

  // Surface every scan-time skip with its reason (never a silent drop, F4). Printed
  // before any early return so observability holds even when nothing is capturable.
  for (const s of scanSkipped) {
    let label;
    if (s.type === 'skills') label = `skills/${s.file}`;
    else if (s.basename) label = `hooks/${s.basename}`;
    else label = `hooks (${s.command})`;
    log(`⊘ ${label}: ${s.reason} — skipped`);
  }

  // No explicit selection → list candidates and stop (capture design §6).
  if (!args.all && args.names.length === 0) {
    if (candidates.length === 0) {
      log('No capturable extensions found under ~/.claude/{' + args.types.join(',') + '}.');
      return { selected: [], captured: [], skipped: scanSkipped, failed: [], listedOnly: true };
    }
    log('Capturable extensions (pass names to capture, or --all):');
    for (const c of candidates) log(`  ${c.type}/${c.file}`);
    log('');
    log('Note: --all captures every unowned candidate here — not a provenance check.');
    log('Explicit selection is the trust boundary.');
    return {
      selected: candidates,
      captured: [],
      skipped: scanSkipped,
      failed: [],
      listedOnly: true,
    };
  }

  // Resolve the selection. A bare name can now be ambiguous (`commands/mine.md` and
  // `skills/mine/` can both exist), and the old map silently let the last candidate
  // win. Collect every match per name and refuse when there is more than one: the
  // caller must say which by qualifying with the type.
  let selected;
  if (args.all) {
    selected = candidates;
  } else {
    const byName = new Map();
    const add = (key, c) => {
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(c);
    };
    for (const c of candidates) {
      add(c.file, c);
      if (c.stem !== c.file) add(c.stem, c);
      add(`${c.type}/${c.file}`, c);
    }
    selected = [];
    for (const name of args.names) {
      const matches = byName.get(name) || [];
      if (matches.length === 0) {
        log(`⊘ ${name}: no capturable candidate by that name — skipped`);
        continue;
      }
      if (matches.length > 1) {
        const qualified = matches.map((c) => `${c.type}/${c.file}`).join(', ');
        log(`⊘ ${name}: ambiguous (matches ${qualified}) — qualify with the type — skipped`);
        continue;
      }
      selected.push(matches[0]);
    }
  }

  const captured = [];
  const skipped = [...scanSkipped];
  const failed = [];
  const created = []; // files written THIS run, for rollback on adopt failure

  // Every wiki mutation is checked against the vault root, not the type directory: a
  // symlinked `extensions/` would otherwise be walked straight through.
  const guard = (dest) => isContainedUnder(wikiRoot, dest) && !hasSymlinkAncestor(wikiRoot, dest);

  for (const c of selected) {
    if (c.type === 'skills') {
      captureOneSkill({ c, extDir, guard, wikiRoot, args, captured, skipped, created });
      continue;
    }
    const fileExt = TYPE_EXT[c.type];
    const wikiStem = `${EXT_PREFIX}${c.stem}`;
    const typeDir = join(extDir, c.type);
    const filePath = join(typeDir, `${wikiStem}${fileExt}`);
    const manifestPath = join(typeDir, `${wikiStem}.manifest.json`);

    // A pre-existing NON-regular wiki target (symlink / dir / socket) is a hard
    // conflict: readFileIfRegular reports it as absent, so without this guard a
    // naive write would follow a symlink out of the wiki (codex pre-commit
    // BLOCKER). Refuse before reading or planning.
    if (
      (existsSync(filePath) && !isRegularFile(filePath)) ||
      (existsSync(manifestPath) && !isRegularFile(manifestPath))
    ) {
      const reason = 'wiki target exists but is not a regular file';
      log(`⊘ ${c.type}/${c.file}: ${reason} — skipped`);
      skipped.push({ ...c, reason, status: 'conflict' });
      continue;
    }

    const srcBuf = readFileSync(c.srcPath); // verbatim bytes (capture design §4)
    const srcSha = sha256(srcBuf);
    const existingFileBuf = readFileIfRegular(filePath);
    const existingFileSha = existingFileBuf ? sha256(existingFileBuf) : null;
    const existingManifestBuf = readFileIfRegular(manifestPath);
    const existingManifestRaw = existingManifestBuf ? existingManifestBuf.toString('utf-8') : null;

    const wantManifest = buildWantManifest(c);
    const plan = planCapture({ wantManifest, srcSha, existingFileSha, existingManifestRaw });

    // installFile is the ORIGINAL name the far machine installs under (installName
    // adoption); for hooks that is `<stem>.mjs`, for commands/agents `<stem>.md`.
    const installFile = `${c.stem}${fileExt}`;
    // Ownership keys sync must record for the adoption to count. Hooks track BOTH
    // the `.mjs` and its `.manifest.json` sidecar under the install path (success
    // criterion d); commands/agents track only the single install file.
    const requiredKeys =
      c.type === 'hooks'
        ? [`hooks/${installFile}`, `hooks/${c.stem}.manifest.json`]
        : [`${c.type}/${installFile}`];

    if (plan.status === 'invalid' || plan.status === 'conflict') {
      log(`⊘ ${c.type}/${c.file}: ${plan.reason} — skipped`);
      skipped.push({ ...c, reason: plan.reason, status: plan.status });
      continue;
    }
    if (plan.status === 'already') {
      log(`= ${c.type}/${c.file}: already captured`);
      captured.push({ ...c, installFile, requiredKeys, status: 'already' });
      continue;
    }

    // status === 'ready'. Write the manifest FIRST, then the storage file (capture
    // design §4): a crash between the two leaves only a manifest (no sibling →
    // discovery skips it), never a lone file that forward-sync would install under
    // the wiki storage name. Both writes are atomic (temp + rename) so a symlink at
    // the target is replaced, not followed.
    if (!args.dryRun) {
      mkdirSync(typeDir, { recursive: true });
      const rec = {
        type: c.type,
        stem: c.stem,
        filePath,
        manifestPath,
        manifestExisted: existingManifestBuf != null,
        manifestPrevBuf: existingManifestBuf,
      };
      writeAtomic(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
      writeAtomic(filePath, srcBuf);
      created.push(rec);
    }
    captured.push({ ...c, installFile, requiredKeys, status: 'ready' });
  }

  const toAdopt = captured.filter((c) => c.status === 'ready');
  if (toAdopt.length === 0 || args.dryRun) {
    report(captured, skipped, failed, args.dryRun);
    return { selected, captured, skipped, failed };
  }

  // Adopt: run forward-sync so the install targets (byte-identical) hit the
  // up-to-date branch and record ownership. If sync THROWS, roll back every file
  // written this run so a hard failure never leaves a half-captured extension
  // behind (codex pre-commit CONCERN).
  let sync;
  try {
    sync = syncExtensions({
      extDir,
      hypoDir: wikiRoot,
      target: 'claude',
      settingsPath: join(claudeHome, 'settings.json'),
      pkgPath: pkgJsonPath(),
      apply: true,
      force: false,
    });
  } catch (err) {
    for (const rec of created) rollbackRec(rec);
    log(`capture aborted: forward-sync failed (${err.message}); wiki files rolled back.`);
    for (const c of toAdopt) {
      c.status = 'failed';
      failed.push(c);
    }
    report([], skipped, failed, false);
    return { selected, captured, skipped, failed, sync: null };
  }
  const newSHAs = sync.newSHAs || {};

  // VERIFY every expected key is owned; roll back any capture whose adoption did
  // not take (e.g. the install target changed between copy and sync → skip-conflict
  // with a null SHA) so the wiki does not keep an un-adopted file. Hooks require
  // BOTH the `.mjs` and the sidecar `.manifest.json` keys (success criterion d).
  // Ownership keys that this run's sync newly recorded for a capture whose adoption
  // then failed. `recorded` is the pre-sync owned map, so a key absent there but
  // present in newSHAs is new THIS run: safe to strip. A key already owned before
  // this run is preserved (never touched here).
  const strayOwnedKeys = new Set();
  for (const c of toAdopt) {
    const ok =
      c.type === 'skills' ? skillAdopted(c, sync) : c.requiredKeys.every((k) => newSHAs[k]);
    if (ok) {
      c.status = 'captured';
    } else {
      c.status = 'failed';
      failed.push(c);
      const rec = created.find((r) => r.type === c.type && r.stem === c.stem);
      if (rec) rollbackRec(rec);
      const keys = c.type === 'skills' ? [c.installKey] : c.requiredKeys;
      for (const k of keys) {
        if (recorded[k] === undefined && newSHAs[k] !== undefined) strayOwnedKeys.add(k);
      }
    }
  }
  // Never strip a key a successful capture still depends on (distinct install
  // stems make this impossible in practice, but the guard keeps the rollback
  // strictly scoped to failed captures).
  for (const c of toAdopt) {
    if (c.status !== 'captured') continue;
    for (const k of c.type === 'skills' ? [c.installKey] : c.requiredKeys) strayOwnedKeys.delete(k);
  }
  purgeOwnedKeys(pkgJsonPath(), 'claude', strayOwnedKeys);
  const okCaptured = captured.filter((c) => c.status === 'captured' || c.status === 'already');
  for (const w of sync.warnings || []) log(`  sync: ${w}`);
  report(okCaptured, skipped, failed, args.dryRun);
  return { selected, captured, skipped, failed, sync };
}

/**
 * Did forward-sync actually adopt this skill, file for file?
 *
 * Presence of the key is not enough. A skill's recorded value is a NESTED map, so the
 * `newSHAs[key]` truthiness test the flat types use passes as soon as a single relpath
 * lands — a skill missing half its files would count as adopted and the wiki would own
 * a lossy install. Worse, copyOne hands back the previously recorded SHA on its drift
 * and skip paths, so even a per-relpath presence check can be satisfied by a file sync
 * refused to touch.
 *
 * So: every captured relpath must be recorded with EXACTLY the SHA we captured, the
 * recorded map must hold nothing else, and sync must not have reported drift or a
 * conflict against this skill. A first capture is source == install target, so every
 * file is expected to land on the up-to-date branch.
 */
function skillAdopted(c, sync) {
  const nested = (sync.newSHAs || {})[c.installKey];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return false;
  const wikiName = `${EXT_PREFIX}${c.stem}`;
  const touched = (list) => (list || []).some((e) => e.name === wikiName);
  if (touched(sync.drifts) || touched(sync.conflicts)) return false;
  const relpaths = Object.keys(c.srcShas);
  if (Object.keys(nested).length !== relpaths.length) return false;
  return relpaths.every((rel) => nested[rel] === c.srcShas[rel]);
}

function report(captured, skipped, failed, dryRun) {
  log('');
  if (captured.length > 0) {
    log(`${dryRun ? 'Would capture' : 'Captured'} ${captured.length} extension(s):`);
    for (const c of captured) {
      const dest =
        c.type === 'skills'
          ? `extensions/skills/${EXT_PREFIX}${c.stem}/`
          : `extensions/${c.type}/${EXT_PREFIX}${c.stem}${TYPE_EXT[c.type]}`;
      log(`  ${c.type}/${c.file} → ${dest}`);
    }
  }
  if (skipped.length > 0) log(`Skipped ${skipped.length} (conflict/invalid — see above).`);
  if (failed.length > 0)
    log(`Failed to adopt ${failed.length} (see sync warnings; wiki files rolled back).`);
  if (!dryRun && captured.some((c) => c.status === 'captured')) {
    log('');
    log('Next: commit + push the wiki, then run `hypomnema upgrade --apply` on another machine.');
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    log(
      'Usage: hypomnema capture [names…] [--all] [--type=commands,agents,hooks,skills] [--dry-run]',
    );
    log('  Pull ~/.claude/{commands,agents,skills} extensions and canonical');
    log('  settings.json hooks into the wiki for cross-machine sync. Hooks and skills');
    log('  are captured only when they round-trip losslessly; others are skipped with');
    log('  a reason. A skill is a directory (SKILL.md + subtree); one holding symlinks,');
    log(`  hardlinks, empty dirs, or more than ${SKILL_MAX_FILES} files is refused.`);
    return 0;
  }
  const res = run(args);
  return res.failed.length > 0 ? 1 : 0;
}

function isMain() {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(main());
}

export { parseArgs, scanCandidates, run };
// scanHookCandidates is exported at its definition above.
