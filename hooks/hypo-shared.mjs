#!/usr/bin/env node
/**
 * hypo-shared.mjs — shared utilities for Hypomnema hooks
 *
 * Imported by personal-wiki-check.mjs, wiki-compact-guard.mjs, and others.
 * Hooks are deployed to ~/.claude/hooks/ — no external imports allowed.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  lstatSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  realpathSync,
  openSync,
  unlinkSync,
  linkSync,
} from 'fs';
import { join, relative, basename, dirname, isAbsolute, sep, resolve as resolvePath } from 'path';
import { homedir, hostname, tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { randomBytes, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { atomicWrite, fsyncDir } from './atomic-write.mjs';
import { isValidSessionId } from './proposal-store.mjs';
import {
  GITIGNORE_BLOCK,
  LEGACY_TRACK_ID,
  NEXT_UP_HEADINGS,
  buildLegacyBaselines,
  generatedViewSlug,
  isGeneratedViewPath,
  isSessionEntryPath,
  isSessionProjectDir,
  isValidProjectName,
  mergeAdditiveGitignore,
  missingBlockLines,
  narrowestVisibilityScope,
  parseSessionEntry,
  projectNameProblem,
  scopeVisible,
  sessionViewPathsOf,
  nfcRenameCommands,
} from './session-entries.mjs';

const HOME = homedir();

// ── session marker path ─────────────────────────────────────────────────────
// hypo-session-start / hypo-cwd-change WRITE this marker; hypo-first-prompt
// READS + unlinks it. The session_id comes from the Claude Code runtime (a
// UUID), but we sanitize defensively so a malformed id with path separators or
// `..` can never escape tmpdir or collide on an empty value. Non-alphanumeric
// chars collapse to `_`.
export function sessionMarkerPath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return join(tmpdir(), `hypo-session-marker-${safe}.json`);
}

// ── project name sanitizer for prompt-facing interpolation ─────────────────
// marker.proj is read from a wiki directory name (findProjectFiles) and
// interpolated into LLM-facing additionalContext strings by multiple hooks.
// A manually-crafted directory name could otherwise close a wrapping tag,
// smuggle a newline, or inject conflicting instructions. Centralized so the
// three injection sites stay in lock-step (codex v2 review 2026-05-26 —
// addresses shared-helper concern across hypo-first-prompt / hypo-session-start
// / hypo-cwd-change).
//
// Strips: angle brackets, control chars (C0 + C1), Unicode line separators
// (U+2028 / U+2029), then collapses whitespace and caps length.
export function sanitizeProjForPrompt(raw, fallback = 'unknown') {
  const cleaned = String(raw || fallback)
    .replace(/[<>\[\]]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

// ── wiki root resolution ────────────────────────────────────────────────────

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2));
  return p;
}

/**
 * Resolve Hypomnema root: HYPO_DIR env → hypo-config.md scan → ~/hypomnema default.
 * @returns {string}
 */
function resolveHypoRoot() {
  if (process.env.HYPO_DIR) return expandHome(process.env.HYPO_DIR);

  const candidates = [
    join(HOME, 'hypomnema'),
    join(HOME, 'wiki'),
    join(HOME, 'notes'),
    join(HOME, 'knowledge'),
    join(HOME, 'Documents', 'hypomnema'),
    join(HOME, 'Documents', 'wiki'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'hypo-config.md'))) return c;
  }
  return join(HOME, 'hypomnema');
}

export const HYPO_DIR = resolveHypoRoot();
export const LOG_PATH = join(HYPO_DIR, 'log.md');
export const HOT_PATH = join(HYPO_DIR, 'hot.md');
export const GUIDE_PATH = join(HYPO_DIR, 'hypo-guide.md');

// Package root: written by init/upgrade to ~/.claude/hypo-pkg.json.
//
// The plugin channel is the primary distribution path, and
// Claude Code's own plugin manager updates hooks WITHOUT ever touching
// hypo-pkg.json — only our own init/upgrade write it. So after a plugin
// auto-update this file can point at a stale pkgRoot indefinitely with no
// signal to the user, and PKG_ROOT (resolved here) is what lint/feedback
// scripts get resolved through — a hook can run at the new version while the
// script it shells out to still runs from the old one.
//
// An earlier version of this cross-check queried ~/.claude/settings.json's
// `enabledPlugins` + the plugin registry to positively attribute an active
// install. That was wrong: Claude Code layers `enabledPlugins` across
// user/project/local/managed settings (project overrides user), and a plugin
// with no explicit key is enabled by default — so a single-file read of the
// user settings can neither prove "enabled" nor "disabled". Querying it was
// certain to misjudge some real layout.
//
// This code already knows the one thing that can't be wrong: where IT is
// running from. `import.meta.url`, walked up to the nearest package.json,
// names the actual root of the code executing right now — no
// settings/registry guessing needed. That's `selfLocationPkgRoot()` below.
//
// Never throw: this runs at hook-module load time (`export const PKG_ROOT =
// resolvePkgRoot()`), so a throw here takes the whole hook process down.
// Every read below is try/caught and every helper fails open to null.

/** Non-mutating read of the cached pointer, or null on any absence/corruption. */
function readCachedPkgRoot() {
  try {
    const p = join(HOME, '.claude', 'hypo-pkg.json');
    if (!existsSync(p)) return null;
    const v = JSON.parse(readFileSync(p, 'utf-8')).pkgRoot;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

// A pkgRoot is usable only as an ABSOLUTE path to a real package directory
// whose package.json carries a version. A relative path (e.g. ".") resolves
// against whatever cwd the reading process happens to have; a directory that
// merely EXISTS but carries no versioned package.json is a pointer nothing
// can actually resolve scripts through. Same contract for every source of a
// pkgRoot value in this file — the cache included (a cached `pkgRoot: "."`
// used to pass on directory-existence alone).
//
// NOT sufficient by itself for self-location (see selfLocationPkgRoot below):
// "absolute path + a package.json with SOME version" is true of any Node
// package anywhere on disk, including one that has nothing to do with
// Hypomnema — e.g. `$HOME/package.json` from an unrelated project. This
// contract answers "is this a real, resolvable directory", not "is this OUR
// package". Callers that need the latter also require self-containment.
//
// Exported so scripts/doctor.mjs can apply the SAME predicate to a sidecar's
// recorded pkgRoot that readVerifiedProvenancePkgRoot() below applies at
// runtime — doctor used to hand-roll a thinner name+hash check that a
// version-less "name":"hypomnema" root would pass while the runtime resolver
// rejects it, so doctor could PASS a sidecar the runtime treats as null. The
// import direction stays scripts/ → hooks/, never the reverse.
export function isUsablePkgRootLocal(pkgRoot) {
  if (typeof pkgRoot !== 'string' || !pkgRoot || !isAbsolute(pkgRoot)) return false;
  try {
    const v = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8')).version;
    return typeof v === 'string' && v.length > 0;
  } catch {
    return false;
  }
}

// True iff `candidateRoot` actually CONTAINS the module that is running right
// now — i.e. `<candidateRoot>/hooks/hypo-shared.mjs` is, on disk, the exact
// same file as `ownRealPath` (this module's own realpath). This is the
// decisive check self-location needs and isUsablePkgRootLocal alone cannot
// give it: a versioned package.json only proves SOME package lives at
// `candidateRoot`, not that it is the Hypomnema install this code is part of.
// Without this, walking up from an unrelated location (a standalone-copied
// hooks/ dir sitting under a directory that happens to have its own,
// unrelated package.json a few levels up — e.g. `$HOME/package.json`) would
// silently adopt that unrelated tree as PKG_ROOT, and every script path built
// from it (`join(PKG_ROOT, 'scripts', 'lint.mjs')`, the crystallize recovery
// command in hypo-auto-minimal-crystallize.mjs, etc.) would point at files
// that were never shipped there.
//
// Both paths are realpath'd before comparing so a symlinked candidate or a
// symlinked ancestor of the running module (macOS's /var → /private/var, a
// symlinked plugin cache dir) still compares correctly. Fails closed (false)
// on any read error — a candidate this can't positively confirm is never
// adopted.
function candidateContainsRunningModule(candidateRoot, ownRealPath) {
  try {
    return realpathSync(join(candidateRoot, 'hooks', 'hypo-shared.mjs')) === ownRealPath;
  } catch {
    return false;
  }
}

// Walk up from the PARENT of the directory this module (hooks/hypo-shared.mjs)
// is actually running from, looking for the nearest ancestor that is (a) a
// usable package root AND (b) actually contains this exact running module —
// that IS the package root of the code currently executing, regardless of
// which channel put it there (plugin, npm, dev checkout).
//
// Plugin mode runs hooks straight out of the plugin's own cache directory
// (`${CLAUDE_PLUGIN_ROOT}/hooks/...`), so this resolves directly to whatever
// the plugin loader most recently updated — exactly the channel that can
// silently drift ahead of hypo-pkg.json. A manual/npm install COPIES hooks
// standalone into ~/.claude/hooks/ with no package.json alongside (the "hooks
// import only Node built-ins, nothing outside the hooks dir" contract), so
// this correctly finds nothing self-containing there and resolvePkgRoot()
// falls through to the cache — which IS authoritative for that channel, since
// our own init/upgrade own writing it. And even if SOME unrelated ancestor
// happens to carry its own versioned package.json (a plain "usable" root),
// candidateContainsRunningModule rejects it: that ancestor's own hooks/
// subdirectory (if it even has one) is not this file.
//
// Bounded walk: up to 6 candidate ancestors above hooksDir's own parent (the
// ordinary root sits at the very first one; a few extra levels tolerate an
// unusual nesting depth). Never throws, fails open to null on any error.
//
// Split out from selfLocationPkgRoot() (below) so scripts/doctor.mjs can ask
// the same question about an ARBITRARY installed hooks directory
// (~/.claude/hooks, ~/.codex/hooks) instead of only about wherever THIS
// running module happens to live. doctor needs that to tell "self-location
// genuinely can't resolve for this install" (the standalone-copy steady
// state, silence is correct) apart from "self-location would resolve but the
// provenance sidecar is missing/broken" (a real gap — see CONCERN 4's
// PKG_ROOT-null-and-silent fix in checkProvenanceSidecar). Exported;
// scripts/ → hooks/ stays the only allowed import direction.
export function selfLocationPkgRootFrom(hooksDir) {
  let ownRealPath;
  try {
    ownRealPath = realpathSync(join(hooksDir, 'hypo-shared.mjs'));
  } catch {
    return null; // can't even resolve the module at hooksDir — nothing to self-contain against
  }
  try {
    let dir = dirname(hooksDir); // first candidate: the ordinary root, one level above hooks/
    for (let i = 0; i < 6; i++) {
      if (isUsablePkgRootLocal(dir) && candidateContainsRunningModule(dir, ownRealPath)) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function selfLocationPkgRoot() {
  let hooksDir;
  try {
    hooksDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null; // can't even resolve our own path
  }
  return selfLocationPkgRootFrom(hooksDir);
}

// Copy-time provenance sidecar (`.hypo-provenance.json`, written next to a
// standalone-copied hooks/ dir by installHooks/applyHookFiles — see
// scripts/lib/pkg-provenance.mjs, the writer half of this contract) is the
// ONLY fallback resolvePkgRoot() gets when self-location can't resolve. The
// filename and the "hypomnema" name check below must stay byte-identical
// with scripts/lib/pkg-provenance.mjs — hooks can't import scripts/ (no
// reaching outside hooks/), so the contract is duplicated, not shared.
//
// This is accidental-staleness protection, not a security boundary: any
// process running as this OS user can edit this JSON file (or hypo-shared.mjs
// itself) freely. It only catches what installHooks/applyHookFiles left
// unguarded before this fix — a manual-install hooks/ copy left pointing at
// an old pkgVersion because a skip-then-refresh-the-cache-anyway sequence
// (init re-run against an unchanged hooks/ dir) recorded a version the copy
// on disk never actually became.
//
// Producer proof, BOTH required before this pkgRoot is trusted:
//   - the recorded pkgRoot's package.json "name" must be "hypomnema" (not
//     merely "some usable versioned package.json" — isUsablePkgRootLocal
//     alone would accept $HOME/package.json from an unrelated project)
//   - the recorded hypoSharedSha256 must match the SHA-256 of THIS running
//     hypo-shared.mjs file — ties the sidecar to the exact copy it was
//     written next to, so a sidecar surviving a partial re-install (new
//     hooks/*.mjs dropped in, old sidecar left behind) is rejected rather
//     than silently trusted.
//
// Scope, stated honestly: hypoSharedSha256 pins ONE file — this file. A
// sidecar surviving a re-install that touched some OTHER hook (e.g.
// hypo-personal-check.mjs got a new version, hypo-shared.mjs itself didn't
// change a byte) still passes this check and PKG_ROOT still resolves,
// because the running module — the one thing this function can verify
// without cost — never changed. Catching that wider drift needs hashing
// every file hooks.json wires up, which is too expensive to do on every
// hook load (this function runs on every single hook invocation); that
// broader, once-per-`doctor`-run check is `hooksDigest`
// (scripts/lib/pkg-provenance.mjs's computeHooksDigest, verified by
// scripts/doctor.mjs), deliberately NOT read here.
const PROVENANCE_FILENAME = '.hypo-provenance.json';
const EXPECTED_PKG_NAME = 'hypomnema';

function readVerifiedProvenancePkgRoot(hooksDir) {
  try {
    const raw = JSON.parse(readFileSync(join(hooksDir, PROVENANCE_FILENAME), 'utf-8'));
    const { pkgRoot, hypoSharedSha256 } = raw || {};
    if (!isUsablePkgRootLocal(pkgRoot)) return null;
    const producerPkgJson = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
    if (producerPkgJson.name !== EXPECTED_PKG_NAME) return null;
    if (typeof hypoSharedSha256 !== 'string' || !hypoSharedSha256) return null;
    const ownHash = createHash('sha256')
      .update(readFileSync(join(hooksDir, 'hypo-shared.mjs')))
      .digest('hex');
    if (ownHash !== hypoSharedSha256) return null;
    return pkgRoot;
  } catch {
    return null;
  }
}

// Resolution order: self-location wins whenever it resolves — it is a direct,
// self-containment-verified fact about the code currently running, not an
// inference. Only when it cannot resolve (the standalone-copied hooks case
// above, or a genuine read failure) does the verified provenance sidecar get
// to answer, checked against the same directory this module is actually
// running from. The cache (readCachedPkgRoot/hypo-pkg.json) is deliberately
// NOT a resolution fallback here — a disagreeing provenance sidecar means
// "stop", not "ask the cache", because the cache is exactly what can be
// stale (that staleness is this fix's whole premise). readCachedPkgRoot stays
// in this file only for pkgRootDriftStatus()'s surfacing comparison below.
function resolvePkgRoot() {
  const self = selfLocationPkgRoot();
  if (self) return self;
  try {
    const hooksDir = dirname(fileURLToPath(import.meta.url));
    return readVerifiedProvenancePkgRoot(hooksDir);
  } catch {
    return null;
  }
}
export const PKG_ROOT = resolvePkgRoot();

// realpath a path for comparison, falling back to the raw value on any error
// (missing/unreadable/etc — the comparison then just degrades to a literal
// string compare, same as before this existed). Never throws.
function canonicalPath(p) {
  if (typeof p !== 'string' || !p) return p;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// Tri-state comparison between the cache and the code's own resolved
// location, for the SURFACING decision only (resolvePkgRoot() above already
// self-corrects PKG_ROOT in memory regardless of this). Three outcomes:
//   'match'   — cache and self-location agree (or both resolve to nothing
//               comparable) → any earlier drift mark should be CLEARED.
//   'drift'   — self-location resolves and DISAGREES with the cache → notify.
//   'unknown' — self-location could not be resolved at all → leave any
//               existing mark untouched. This is the PERMANENT steady state
//               for the npm/manual channel (no package.json ships next to the
//               standalone-copied hooks), not a rare hiccup — collapsing it
//               into 'match' would let that channel silently clear a mark it
//               never had grounds to judge, and collapsing it into 'drift'
//               would falsely warn a channel with nothing to compare against.
//
// The equality check canonicalizes BOTH sides first: the cache may record a
// symlink alias of the very same physical root selfLocationPkgRoot() just
// walked to (a symlinked plugin cache dir, or the same /var vs /private/var
// split candidateContainsRunningModule already has to handle) — a literal
// string compare would misreport that as drift.
//
// Never throws (every helper it calls already fails open).
export function pkgRootDriftStatus() {
  const self = selfLocationPkgRoot();
  if (!self) return { status: 'unknown' };
  const cached = readCachedPkgRoot();
  if (canonicalPath(self) === canonicalPath(cached)) return { status: 'match' };
  return { status: 'drift', cached, self };
}

// Optional H2 allowlist for hot.md validation.
// Set HYPO_ALLOWED_HOT_H2=comma,separated,headings to enable.
const _allowedH2Env = process.env.HYPO_ALLOWED_HOT_H2;
export const ALLOWED_HOT_H2 = _allowedH2Env
  ? new Set(_allowedH2Env.split(',').map((s) => s.trim()))
  : null;

// ── skip-gate helper ───────────────────────────────────────────────────────

/** Returns true if the wiki gate should be bypassed. */
export function isGateSkipped() {
  return process.env.HYPO_SKIP_GATE === '1';
}

// ── state checkers ─────────────────────────────────────────────────────────

export function lastSubstantialOpIsSession() {
  // Single read, no existsSync precheck: a check-then-read pair leaves a race
  // window where the file exists at the check and is gone by the read, and
  // the old code treated that ENOENT the same as a stably-missing file
  // (fail-open, `true`). Only a genuinely absent log.md (ENOENT) folds to
  // `false` here; any other read failure (EISDIR, EACCES, ...) is a real
  // problem the caller needs to see, not a silent "no session", so it is
  // rethrown. hypo-compact-guard.mjs is the only in-repo caller (verified via
  // grep) and its own try/catch already turns any throw here into
  // fail-closed ("session log entry missing") plus a stderr line, so this
  // fail-open-to-fail-closed flip needed no other caller to be re-audited.
  let log;
  try {
    log = readFileSync(LOG_PATH, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
  const substantial = log
    .split('\n')
    .filter((l) => /^## \[\d{4}-\d{2}-\d{2}\] (session|ingest)/.test(l));
  if (substantial.length === 0) return true;
  return /^## \[\d{4}-\d{2}-\d{2}\] session/.test(substantial[substantial.length - 1]);
}

// Returns the wiki's git state split into its two independent axes:
//   uncommitted — working-tree changes (real unsaved work; a human-fixable blocker)
//   ahead       — committed-but-unpushed commits (a soft, auto-synced state: the
//                 auto-commit Stop hook pushes, and push failures are non-fatal —
//                 see hypo-auto-commit.mjs / appendSyncFailure)
// `clean` stays `!uncommitted && !ahead` for back-compat with callers that only
// read it. Callers that gate session-close / compact distinguish the two: they
// block on `uncommitted` and demote `ahead` to a notice (precompactGateStatus,
// hypo-compact-guard) so a committed-but-unpushed close is still "compact-ready".
// A deadline shared across every git spawn one "am I clean" check can make:
// `{ end: <performance.now()-based timestamp> }`, built once by a caller that
// needs to bound hypoIsClean and gitDirtyFiles to a slice of its own hook
// timeout (session-close-scope-boundary spec §5). remainingSpawnTimeoutMs
// turns "time left" into what spawnSync's own `timeout` option actually
// requires — verified on Node 26: `timeout: 0` DISABLES the timeout (waits
// forever) rather than firing immediately, and a negative or fractional value
// THROWS ERR_OUT_OF_RANGE. A throw here would escape as an exception through
// a hook's outermost catch and come back silent, so a caller must never pass
// a value this function did not produce, and must never spawn once it
// returns 0.
// A deadline built from a bad `end` (Infinity, NaN, or already past) must
// also fold to 0, not just a plain negative one: a caller-supplied
// `{ end: Infinity }` produces `remaining = Infinity`, and `Infinity` is
// exactly as unsafe a `timeout` value as a negative or fractional one, same
// `ERR_OUT_OF_RANGE` throw, just via a different guard. `Number.isFinite`
// alone is not enough, though: it also passes `Number.MAX_VALUE`, which is
// finite but still outside spawnSync's documented `timeout` range (0 through
// `Number.MAX_SAFE_INTEGER`) and throws the same `ERR_OUT_OF_RANGE` (verified
// directly: `gitDirtyFiles(cwd, { deadline: { end: Number.MAX_VALUE } })`
// threw before this guard, since MAX_SAFE_INTEGER is exactly spawnSync's
// upper bound, `Number.isSafeInteger` is the one predicate that matches it.
//   undefined — no deadline given: omit `timeout` entirely (today's behavior)
//   0         — budget exhausted, or the deadline itself was not a safe
//               positive integer: do not spawn
//   >0        — a whole positive integer number of ms safe to pass as `timeout`
export function remainingSpawnTimeoutMs(deadline) {
  if (!deadline) return undefined;
  const remaining = Math.floor(deadline.end - performance.now());
  return Number.isSafeInteger(remaining) && remaining > 0 ? remaining : 0;
}

// True when `git status --porcelain -z` output names a path that is not a lock artifact.
// `-uall` is what makes this sound: without it a directory holding only a lock file shows
// as one untracked directory entry and the artifact cannot be told from real work. A
// rename or copy record is followed by its source path as a bare record.
function porcelainHasDirt(stdout) {
  const records = (stdout || '').split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') {
      i++;
      if (records[i] && !isUntrackedLockArtifact(xy, records[i])) return true;
    }
    if (!isUntrackedLockArtifact(xy, rec.slice(3))) return true;
  }
  return false;
}

// `opts.deadline` is optional (session-close-scope-boundary spec §5): when
// omitted, both spawns run exactly as before, no timeout, no status/error
// check on the second one. hypo-compact-guard.mjs is the only caller that
// passes one; precompactGateStatus (`:3872`) and all six direct test call
// sites still pass a bare `dir` and must see byte-identical behavior.
export function hypoIsClean(dir = HYPO_DIR, opts = {}) {
  const { deadline } = opts;
  try {
    const t1 = remainingSpawnTimeoutMs(deadline);
    if (t1 === 0) {
      return {
        clean: false,
        uncommitted: true,
        ahead: false,
        reason: `git check deadline exhausted in ${dir}`,
      };
    }
    const porcelain = spawnSync(
      'git',
      ['--no-optional-locks', '-C', dir, 'status', '--porcelain', '-uall', '-z'],
      t1 === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', timeout: t1 },
    );
    if (porcelain.error || porcelain.status !== 0)
      return {
        clean: false,
        uncommitted: true,
        ahead: false,
        reason: `git check failed in ${dir}`,
      };
    const uncommitted = porcelainHasDirt(porcelain.stdout);

    const t2 = remainingSpawnTimeoutMs(deadline);
    if (t2 === 0) {
      return {
        clean: false,
        uncommitted: true,
        ahead: false,
        reason: `git check deadline exhausted in ${dir}`,
      };
    }
    const aheadRes = spawnSync(
      'git',
      ['--no-optional-locks', '-C', dir, 'status', '--branch', '--porcelain'],
      t2 === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', timeout: t2 },
    );
    // Only enforced when a deadline is in play. Without one this spawn cannot
    // time out, and its `stdout` (empty on any other kind of failure too) was
    // already read as "not ahead" before this change — harmless when nothing
    // can kill the process out from under it. WITH a deadline this spawn CAN
    // now die from the same budget the first spawn already spent, and a
    // silent "not ahead" would make the caller's own notification vanish
    // (spec §5's own regression). The first spawn already fails closed this
    // way (`porcelain.status !== 0` above); this brings the second spawn to
    // the same contract, but only where a deadline made it possible to break.
    if (deadline && (aheadRes.error || aheadRes.status !== 0)) {
      return {
        clean: false,
        uncommitted: true,
        ahead: false,
        reason: `git check failed in ${dir}`,
      };
    }
    const ahead = /\[ahead \d+\]/.test(aheadRes.stdout || '');
    const reasons = [];
    if (uncommitted) reasons.push(`uncommitted changes in ${dir}`);
    if (ahead) reasons.push(`unpushed commits in ${dir}`);
    return {
      clean: !uncommitted && !ahead,
      uncommitted,
      ahead,
      reason: reasons.length ? reasons.join('; ') : undefined,
    };
  } catch {
    return { clean: false, uncommitted: true, ahead: false, reason: `git check failed in ${dir}` };
  }
}

/**
 * Repo-relative POSIX paths with uncommitted changes (tracked or untracked) in
 * `dir`. Reuses the SAME `-z` rename-aware porcelain parsing as
 * commitWikiChanges (PR #222): a rename or copy emits `to\0from`, and both
 * sides count as dirty (a rename's source still shows staged until the rename
 * itself lands). This is the read-only half of that fix's pathspec boundary:
 * commitWikiChanges narrows what gets COMMITTED to a caller-supplied scope;
 * this narrows what counts as a BLOCKER the same way, for precompactGateStatus
 * to attribute dirty files to the session that owns them instead of the whole
 * shared working tree.
 *
 * Paths are normalized to be relative to `dir` itself, NOT to the git
 * repository's top level: `git -C <dir> status --porcelain` prints paths
 * relative to the repo TOP LEVEL even under `-C` (verified empirically: a
 * vault nested under `<repo>/vault/` reports `vault/hot.md`, not `hot.md`).
 * Every other path this file compares against (closeAccountableScope,
 * closeFileTargetsGlobal, extractTouchedWikiFiles) is `dir`-relative, so
 * without this normalization a nested vault's OWN files would never match
 * its own scope and every one of them would look foreign (codex pre-commit
 * review BLOCKER 2). `git rev-parse --show-prefix` gives exactly the prefix
 * to strip; a dirty path that does not start with it lives outside the
 * vault entirely (the rest of a bigger host repo) and is dropped, never
 * "mine".
 *
 * @returns {string[]} dirty paths relative to `dir`, or `[]` on any git
 *   failure (the caller already has its own git-status result via
 *   hypoIsClean and treats that failure as an unconditional blocker; an
 *   empty return here just means "cannot attribute", not "clean").
 *
 * `opts.deadline` (session-close-scope-boundary spec §5): the SAME shared
 * deadline object passed to hypoIsClean, so the two functions' spawns split
 * one budget instead of each getting their own (which would let the pair
 * together run twice as long as intended). Omitted, both spawns run exactly
 * as before — precompactGateStatus's own call (`:3874`) does not pass one.
 */
// Read-only status calls here pass --no-optional-locks: a plain `git status` may take
// .git/index.lock to refresh the index, and outside the vault commit lock that collides
// with another close's `git add` ("index.lock: File exists").
export function gitDirtyFiles(dir = HYPO_DIR, opts = {}) {
  const { deadline } = opts;
  const t1 = remainingSpawnTimeoutMs(deadline);
  if (t1 === 0) return []; // budget exhausted before the first spawn → cannot attribute
  const prefixRes = spawnSync(
    'git',
    ['-C', dir, 'rev-parse', '--show-prefix'],
    t1 === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', timeout: t1 },
  );
  if (prefixRes.error || prefixRes.status !== 0) return []; // can't resolve the repo → cannot attribute
  // Only the line ending is git's framing (LF, or CRLF where git writes one). The
  // prefix is a real path segment, so a leading or trailing space in a parent
  // directory name belongs to it; trim() would make every path under that vault
  // read as foreign.
  const prefix = (prefixRes.stdout || '').replace(/\r?\n$/, '');

  const t2 = remainingSpawnTimeoutMs(deadline);
  if (t2 === 0) return [];
  const porcelain = spawnSync(
    'git',
    ['--no-optional-locks', '-C', dir, 'status', '--porcelain', '-uall', '-z'],
    t2 === undefined ? { encoding: 'utf-8' } : { encoding: 'utf-8', timeout: t2 },
  );
  if (porcelain.error || porcelain.status !== 0) return [];
  const out = [];
  const records = (porcelain.stdout || '').split('\0');
  const toDirRelative = (f) => {
    if (!f) return null;
    if (!prefix) return f; // dir IS the repo top level, nothing to strip
    return f.startsWith(prefix) ? f.slice(prefix.length) : null; // outside the vault
  };
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3); // destination path for a rename/copy
    const isRenameOrCopy = xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C';
    let fromFile = null;
    if (isRenameOrCopy) {
      i++;
      fromFile = records[i] || null;
    }
    const rel = toDirRelative(file);
    if (rel && !isUntrackedLockArtifact(xy, rel)) out.push(rel);
    const relFrom = toDirRelative(fromFile);
    if (relFrom && !isUntrackedLockArtifact(xy, relFrom)) out.push(relFrom);
  }
  return out;
}

// session-close-scope-boundary spec §2b/§5: the ONE path-prefix rule that
// decides a dirty file structurally belongs to a DIFFERENT eligible project
// than the one this call is scoped to. Extracted from precompactGateStatus's
// former inline closure so hypo-compact-guard.mjs (spec §5) can call the
// exact same predicate instead of duplicating it — a closure over the gate's
// local variables cannot be called, or asserted against, from anywhere else.
// The gate itself no longer calls it: its git axis judges by the session's
// touched-paths record, so hypo-compact-guard.mjs is now the only caller (via
// classifyForeignOnlyDirty).
//
// Lexical, on the RAW git-porcelain path `f`, BEFORE posixPath()'s
// unconditional `\` -> `/` conversion: a file whose actual NAME contains a
// literal backslash (`projects\other\x.md`, one path segment, no real
// subdirectory) must not be reinterpreted as living under `projects/other/`
// just because posixPath() would rewrite it that way — testing the raw
// string means it never matches the regex below and falls through to
// "not foreign", the fail-closed default. `transcriptTouched` IS keyed by
// posix paths (it comes from extractTouchedWikiFiles), so that one check
// still normalizes `f` before the lookup. No caller passes it any more (the
// gate was the only one that did), so it always takes its empty default.
//
// @param {string} f - a raw dirty path from gitDirtyFiles/git porcelain
// @param {{eligibleSlugs: Set<string>|null, effectiveOverride: string|null,
//   transcriptTouched?: Set<string>}} ctx
// @returns {boolean}
export function isForeignProjectFile(
  f,
  { eligibleSlugs, effectiveOverride, transcriptTouched = new Set() },
) {
  // Transcript evidence outranks the path-prefix heuristic below: it PROVES
  // this session edited f, whatever its path prefix says. The heuristic only
  // exists to cover files an untrusted (or absent) transcript could not
  // vouch for either way.
  if (transcriptTouched.has(posixPath(f))) return false;
  if (!eligibleSlugs) return false;
  const m = /^projects\/([^/]+)\/.+$/.exec(f);
  if (!m) return false;
  const slug = m[1];
  return slug !== effectiveOverride && eligibleSlugs.has(slug);
}

// session-close-scope-boundary spec §5: hypo-compact-guard.mjs only needs a
// yes/no on "may I drop my git notice line", never precompactGateStatus's
// full per-file partition, and the answer must never escape as a throw — this
// hook's outermost catch turns ANY exception into a fully suppressed
// {suppressOutput:true}, so a failure inside collectProjectWorkingDirs (a
// readdirSync it does not itself catch) must come back as data instead.
//
// Returns one of two sentinels, never throws:
//   'foreign-only'   — dirty is non-empty, at least one eligible project is
//                       known, and EVERY dirty file is provably someone
//                       else's under isForeignProjectFile.
//   'unattributable' — anything short of that full proof (no dirty files, no
//                       eligible project known, project enumeration failed,
//                       or a mix of foreign and non-foreign files). The
//                       caller must treat this exactly like today's unscoped
//                       git blocker/notice — this is the fail-closed default.
export function classifyForeignOnlyDirty(hypoDir, dirty, { effectiveOverride = null } = {}) {
  if (!dirty || dirty.length === 0) return 'unattributable'; // vacuous every() must not pass
  let eligibleSlugs;
  try {
    eligibleSlugs = new Set(collectProjectWorkingDirs(hypoDir).map((p) => p.slug));
  } catch {
    return 'unattributable';
  }
  if (eligibleSlugs.size === 0) return 'unattributable';
  const allForeign = dirty.every((f) =>
    isForeignProjectFile(f, { eligibleSlugs, effectiveOverride }),
  );
  return allForeign ? 'foreign-only' : 'unattributable';
}

export function hotMdIsClean(dir = HYPO_DIR) {
  const hotPath = dir === HYPO_DIR ? HOT_PATH : join(dir, 'hot.md');
  if (!existsSync(hotPath)) return { clean: true };
  const content = readFileSync(hotPath, 'utf-8');
  const reasons = [];

  // Optional: check H2 allowlist if HYPO_ALLOWED_HOT_H2 is set
  if (ALLOWED_HOT_H2) {
    const h2s = [...content.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    const extra = h2s.filter((h) => !ALLOWED_HOT_H2.has(h));
    if (extra.length > 0) reasons.push(`hot.md has unexpected H2 sections: ${extra.join(', ')}`);
  }

  // Always check for forbidden frontmatter fields
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch && /^last_session:/m.test(fmMatch[1])) {
    reasons.push('hot.md frontmatter has forbidden field: last_session');
  }

  return reasons.length === 0 ? { clean: true } : { clean: false, reason: reasons.join(' / ') };
}

// ── strict session-close verification ────────────────────────────
// spec §5.2.7 / §8.3 (updated 2026-05-15): session-close = steps 1~6 of the
// 11-step crystallize checklist (synthesis is steps 7~11). The hard gate
// (sessionCloseFileStatus) confirms the close files: this close's own session
// entry (projects/<p>/sessions/<date>-<close id>.md), session-log/YYYY-MM-DD.md, and
// log.md. The generated session-state.md and project hot.md are not close files. Root hot.md is NOT
// one of them: it became a hook-generated projection, so the close no longer
// writes it and the gate no longer checks it (see the note at the
// checkUpdated calls in sessionCloseFileStatus for why its `updated:` field
// cannot be read as this project's own date).
// pages/open-questions.md (step 5) is conditional ("변경 시") — it is a
// cross-project queue, so a session that raises no questions should not be
// forced to touch it. Gating it would produce false-blocks; spec §5.2.7
// records this as the intended policy.
//
// Known limitation: freshness is date-based per spec §8.3 ("timestamp가 같음"),
// so a second session on the same day that skips updating a file still passes
// if an earlier close that day already stamped it. freshDates() accepting both
// local and UTC dates widens that window by up to one UTC offset. A per-session
// boundary is out of scope for the strict session-close check.

/** Parse the frontmatter `updated:` field. Returns the trimmed value or null. */
function frontmatterUpdated(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const u = m[1].match(/^updated:\s*(.+)$/m);
  return u ? u[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `content` carries an ATX heading dated `date` (YYYY-MM-DD), e.g.
 *   `## [2026-05-15] something`. Matches H1-H6.
 * Shared by sessionCloseFileStatus() and the crystallize apply helper so both
 * use the same definition of "session-log already updated for today".
 */
export function hasSessionLogHeading(content, date) {
  return new RegExp('^#{1,6} \\[' + escapeRegExp(date) + '\\]', 'm').test(content || '');
}

/**
 * Canonical session-log shard path (repo-relative POSIX) for a single day.
 * Option D: the date IS the filename (`YYYY-MM-DD.md`), so no
 * "current part" resolver is needed and the per-session write touches a small
 * file instead of a multi-thousand-line monthly log. This is the WRITE target.
 */
export function sessionLogShardPath(project, date) {
  return `projects/${project}/session-log/${date}.md`;
}

/**
 * Read candidates for a date's session-log entry, in priority order:
 *   1. the daily shard `YYYY-MM-DD.md` (canonical, small)
 *   2. the legacy monthly `YYYY-MM.md` (pre-shard history is never split)
 * Callers iterate and short-circuit on the first file carrying the dated
 * heading, so once a daily shard exists the large monthly file is never read —
 * which is where the per-close token saving comes from. The monthly fallback
 * keeps pre-cutover months (and a hybrid cutover month) resolving correctly
 * without a retroactive split.
 */
export function sessionLogReadCandidates(project, date) {
  return [
    sessionLogShardPath(project, date),
    `projects/${project}/session-log/${date.slice(0, 7)}.md`,
  ];
}

/**
 * The session-log file the close gate should hold accountable for `date` — i.e.
 * the read candidate that ACTUALLY carries a today-dated heading (daily shard
 * preferred), or the daily write target when none does yet. The freshness gate
 * accepts a today-heading found in the legacy monthly file via fallback; if the
 * lint scope only ever named the daily shard, a close could pass on a *corrupt*
 * monthly evidence file while that file's lint error was demoted to a
 * non-blocking notice (out of scope). Scoping to the resolved evidence file
 * closes that gap: whatever file the gate trusts as proof, lint judges too.
 */
export function sessionLogScopePath(hypoDir, project, date) {
  for (const rel of sessionLogReadCandidates(project, date)) {
    const full = join(hypoDir, rel);
    if (!existsSync(full)) continue;
    try {
      if (hasSessionLogHeading(readFileSync(full, 'utf-8'), date)) return rel;
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  return sessionLogShardPath(project, date);
}

/**
 * True if `content` carries a today-dated `## [date] session | <project>` entry
 * in log.md.
 *
 * Bounded with an explicit `(?=[\s:]|$)` lookahead, NOT `\b`: a regex word
 * boundary matches between word and non-word chars, so `\b` after "foo" still
 * matches in "foo-bar" (hyphen is non-word). The canonical log format separates
 * the project slug from anything that follows by whitespace, a colon, or
 * end-of-line, so the lookahead correctly rejects "session | foo-bar" when
 * looking for "foo". Both delimiters are canonical: the derive path
 * (rootLogEntry) now emits `<project>: <title>` (colon, since the tone rule
 * banned the em dash), and log.md files written by earlier versions carry
 * `<project>` + space + em dash + `<title>`, which must keep matching. The colon must be
 * accepted: without it, a close whose only log.md evidence used the colon form
 * was misread as "stale" and blocked non-deterministically. (Was a pre-existing boundary bug in
 * sessionCloseFileStatus that the helper extraction inherited.)
 */
export function hasLogEntry(content, date, project) {
  return new RegExp(
    '^## \\[' + escapeRegExp(date) + '\\] session \\| ' + escapeRegExp(project) + '(?=[\\s:]|$)',
    'm',
  ).test(content || '');
}

/**
 * True when log.md carries ANY `## [<freshDate>] session | <slug>` heading —
 * project-agnostic. The minimum proof for a log-only close: a
 * non-project (tooling/wiki-only) session has no project mandatory files, but it
 * MUST still leave a today log.md trace so the close is not a content-free bypass.
 * Uses the same canonical heading parser as hasLogEntry (not a loose substring —
 * codex design review: keep the fresh-date/canonical-heading style) so a stray
 * mention of the date elsewhere cannot satisfy it.
 * @param {string} hypoDir
 * @returns {boolean}
 */
export function hasAnyTodayLogEntry(hypoDir) {
  const logPath = join(hypoDir, 'log.md');
  if (!existsSync(logPath)) return false;
  let content = '';
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return false;
  }
  return freshDates().some((d) =>
    new RegExp('^## \\[' + escapeRegExp(d) + '\\] session \\| \\S', 'm').test(content),
  );
}

/**
 * Local and UTC calendar-day strings for a given instant. Both matter because
 * some writers stamp a date in the user's local zone (Claude writing file
 * content) while others stamp UTC (hypo-hot-rebuild, the session-closed
 * marker's `closed_at`) — comparing only one representation opens a
 * ~timezone-offset window where a same-moment date-comparison reads as two
 * different days. Shared by `freshDates()` (today) and any caller comparing
 * against an arbitrary past timestamp (e.g. doctor correlating a marker's
 * `closed_at` against an artifact's local-dated heading).
 * @param {Date} [date]
 * @returns {string[]} 1-2 ISO dates (YYYY-MM-DD), local first.
 */
export function localAndUtcDates(date = new Date()) {
  const local = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const utc = date.toISOString().slice(0, 10);
  return local === utc ? [local] : [local, utc];
}

/**
 * Date strings that count as "today" for freshness checks. See
 * {@link localAndUtcDates} for why both representations are accepted.
 * @returns {string[]} 1-2 ISO dates (YYYY-MM-DD), most-relevant first.
 */
export function freshDates() {
  return localAndUtcDates(new Date());
}

// Parse a single frontmatter scalar (mirrors hypo-session-start.mjs /
// hypo-cwd-change.mjs; local copy per the hook self-contained convention).
function parseFrontmatterField(content, key) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

// ── freshness: overdue verify_by_date predicate + STALE injection marker ─────
// Authority is doctor.mjs:487-491 (D1). Same characters, same meaning: only a
// well-formed ISO date strictly before `today` is overdue. verify_by (the
// natural-language question) is never a date and is never consulted here.
// today is caller-supplied and must use the UTC convention (new Date()
// .toISOString().slice(0,10)) so this set matches doctor's.
export function isOverdueDate(dateStr, today) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < today;
}

// Compute the injection marker for a page's raw content. Returns
// `[STALE verify_by_date=YYYY-MM-DD]` when overdue, otherwise an empty string
// (so non-targets pass through unchanged). Callers prepend the non-empty result
// at injection time.
//
// The value read here must be normalized exactly as scripts/lib/frontmatter.mjs
// does (doctor's parser), so the overdue set stays char-identical to doctor.mjs.
// In particular it strips a trailing YAML inline comment (`2020-01-01 # note`):
// the plain parseFrontmatterField does not, which would silently miss dates
// doctor flags overdue. Top-level line only (skip indented / list entries),
// first-wins, strip comment, then strip surrounding quotes.
export function staleMarkerFor(rawContent, today) {
  const m = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  let value = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || /^-(\s|$)/.test(line)) continue; // nested / list item
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() !== 'verify_by_date') continue; // key match (idx: tolerates `key : v`)
    value = line
      .slice(idx + 1)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
    break; // first-wins
  }
  return value && isOverdueDate(value, today) ? `[STALE verify_by_date=${value}]` : '';
}

// ── page-usage logging: commit-coverage guard + append (B, D6) ───────────────
// Logging which pages lookup injects is observability, never an injection path.
// The log lives at .cache/page-usage.jsonl and must never be committed. Before
// any append, prove that file cannot be staged/committed: it must be covered by
// BOTH git's ignore rules (check-ignore) AND .hypoignore (which is what gates
// hypo-auto-stage and commitWikiChanges). Missing either signal, or any error
// (no git, timeout, non-repo), returns false so nothing is written (fail-closed
// logging). Injection stays fail-open and is unaffected. The verdict is cached
// per session (keyed by session_id plus a vault-path hash so two vaults in one
// session can't cross-contaminate) so git runs at most once per session.
export const PAGE_USAGE_REL = '.cache/page-usage.jsonl';

export function pageUsageGuardCachePath(sessionId, hypoDir) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  // djb2 over the vault path so the cache key is per-(session, vault).
  let h = 5381;
  const s = String(hypoDir || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return join(tmpdir(), `hypo-pageusage-guard-${safe}-${h.toString(36)}.json`);
}

// `probeFn` is test-only: tests inject a fake to control the "did git answer"
// outcome deterministically instead of racing a real subprocess under shard
// load. Production callers never pass it, so they always get `runGitCheckIgnore`
// below, byte-for-byte the same spawnSync call this file always made.
export function pageUsageLoggingAllowed(hypoDir, sessionId, probeFn) {
  // The load-bearing commit gate is .hypoignore: it is what hypo-auto-stage and
  // commitWikiChanges actually filter on. Re-check it FRESH on every call (it is
  // cheap, no subprocess) so that if coverage is removed mid-session the guard
  // flips closed immediately and can never leave logging armed against a
  // now-committable file. Only the expensive git check-ignore probe is cached
  // per session. Any error on either signal fails closed.
  let hypoIgnored = false;
  try {
    const target = join(hypoDir, PAGE_USAGE_REL);
    const patterns = loadHypoIgnore(hypoDir);
    hypoIgnored = patterns.length > 0 && isIgnored(target, hypoDir, patterns);
  } catch {
    hypoIgnored = false;
  }
  if (!hypoIgnored) return false;

  return gitIgnoresPageUsageCached(hypoDir, sessionId, probeFn);
}

// git check-ignore is the belt signal (defends a manual `git add`); it spawns a
// subprocess, so cache its result per session. The verdict cached here is only
// the git signal, never the composite allow decision, so the fresh .hypoignore
// re-check above always still runs.
// How long an unanswered probe suppresses the next one. Long enough that a git
// that is genuinely wedged costs one 10s wait per half-minute instead of one per
// prompt, short enough that a blip clears on its own well inside a session.
const PROBE_BACKOFF_MS = 30000;

// The real probe: check-ignore answers with an exit code, 0 = ignored, 1 = not
// ignored. Split out to a named function so `gitIgnoresPageUsageCached` can take
// a substitute in tests without touching what production actually spawns.
function runGitCheckIgnore(hypoDir) {
  return spawnSync('git', ['-C', hypoDir, 'check-ignore', '-q', '--', PAGE_USAGE_REL], {
    timeout: 10000,
  });
}

function gitIgnoresPageUsageCached(hypoDir, sessionId, probeFn = runGitCheckIgnore) {
  // Without a session id every caller lands on the same `default` cache file, so
  // one session's verdict would answer for the next one — and the file outlives
  // both, sitting in tmpdir with nothing to expire it. A verdict that cannot be
  // scoped to a session is not cached at all: re-probe every time instead of
  // serving a stale `true` after .gitignore coverage has been removed.
  const scoped = Boolean(sessionId);
  const cachePath = pageUsageGuardCachePath(sessionId, hypoDir);
  if (scoped) {
    try {
      if (existsSync(cachePath)) {
        const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
        if (typeof cached.gitIgnored === 'boolean') return cached.gitIgnored;
        // A recorded outage still stands until it expires. This is what keeps a
        // wedged git off the UserPromptSubmit path: hypo-lookup calls this before
        // it prints, so a 10s wait here is 10s of dead prompt, every prompt.
        if (typeof cached.unavailableUntil === 'number' && Date.now() < cached.unavailableUntil) {
          return false;
        }
      }
    } catch {
      // corrupt cache → recompute below
    }
  }

  // check-ignore answers with an exit code: 0 = ignored, 1 = not ignored. Every
  // other outcome means the probe never got to answer — 128 for a fatal git
  // error (hypoDir not a repo yet), or a null status when the timeout below
  // fired or the spawn itself failed, which is what a machine under heavy
  // process load produces. Treating those as a plain `false` is the bug this guards
  // against: it is indistinguishable from git actually saying "not ignored",
  // and the verdict then gets cached, so one blip keeps logging disabled for
  // the rest of the session even after the condition clears.
  // The bound is here to survive a git that never returns (an index.lock held by
  // a dead process, a corrupt repo), not to race a busy machine. It used to be
  // 2s, which a loaded box clears by a hair: instrumenting a one-process-per-suite
  // run produced eight ETIMEDOUT probes, every one of them landing between 2011ms
  // and 2254ms. check-ignore on a real vault costs single-digit milliseconds, so
  // the old bound was three orders of magnitude tighter than the work and was
  // measuring scheduler latency instead of git. 10s still catches a true hang.
  let probe = null;
  try {
    probe = probeFn(hypoDir);
  } catch {
    probe = null;
  }

  // Inconclusive → fail closed for this call. The verdict is never cached as an
  // answer; what gets recorded is that the probe is down, and only until the
  // backoff expires. So a scheduler blip self-heals within the session, while a
  // wedged git is waited on once per backoff window rather than once per prompt.
  if (!probe || (probe.status !== 0 && probe.status !== 1)) {
    if (scoped) {
      try {
        writeFileSync(
          cachePath,
          JSON.stringify({ unavailableUntil: Date.now() + PROBE_BACKOFF_MS }),
        );
      } catch {
        // non-fatal; the probe just runs again next prompt
      }
    }
    return false;
  }

  const gitIgnored = probe.status === 0;
  if (scoped) {
    try {
      writeFileSync(cachePath, JSON.stringify({ gitIgnored }));
    } catch {
      // cache write failure is non-fatal; the git probe just reruns next prompt
    }
  }
  return gitIgnored;
}

// Append one JSONL record per injected slug to .cache/page-usage.jsonl. Callers
// MUST gate this behind pageUsageLoggingAllowed first. Fully fail-open: any error
// (mkdir, disk, serialization) is swallowed so a logging failure never disturbs
// the lookup injection that already happened (mirrors hypo-session-record).
export function recordLookupUsage(hypoDir, { sessionId = null, slugs = [] } = {}) {
  try {
    if (!Array.isArray(slugs) || slugs.length === 0) return;
    const target = join(hypoDir, PAGE_USAGE_REL);
    mkdirSync(join(hypoDir, '.cache'), { recursive: true });
    const ts = new Date().toISOString();
    const lines = slugs
      .map((slug) => JSON.stringify({ ts, session_id: sessionId ?? null, slug, source: 'lookup' }))
      .join('\n');
    appendFileSync(target, lines + '\n');
  } catch {
    // logging is observability; never let it break injection (fail-open)
  }
}

// ── cwd ↔ project matcher ────────────────────────────────────────────────────
// Hand-synced with scripts/lib/wd-match.mjs: hooks deploy to ~/.claude/hooks/
// without scripts/, so this cannot import the lib and must mirror it. Keep the
// two in step; the lib carries the unit tests.

// Expand a leading ~/ (or bare ~), strip trailing slashes. null for empty.
export function normalizeWorkingDir(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (s === '~') s = homedir();
  else if (s.startsWith('~/')) s = `${homedir()}/${s.slice(2)}`;
  s = s.replace(/\/+$/, '');
  return s || null;
}

// macOS/Windows match paths case-insensitively; Linux does not. Fold only there.
export function isCaseInsensitiveFs(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function _fold(s, ci) {
  return ci ? s.toLowerCase() : s;
}
function _lastSeg(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// Resolve which project owns cwd. Tier 1: longest absolute working_dir prefix
// (the original behavior). Tier 2 (cross-machine): when the synced vault holds
// another machine's absolute path, a cwd ancestor whose directory name is a
// GLOBALLY unique project basename identifies the project; a shared dirname
// declines (null) so the caller falls back to recency. `projects` is the whole
// universe (for the uniqueness gate); `eligible` restricts the answer.
export function pickProjectByCwd(projects, cwd, opts = {}) {
  const {
    eligible = null,
    realpathCwd = null,
    caseInsensitive = isCaseInsensitiveFs(),
    rejectAmbiguous = false,
  } = opts;
  if (!cwd && !realpathCwd) return null;
  const eligibleSet = eligible ? new Set(eligible) : null;
  const isEligible = (slug) => !eligibleSet || eligibleSet.has(slug);

  const entries = [];
  for (const p of projects) {
    const path = normalizeWorkingDir(p.workingDir);
    if (path) entries.push({ slug: p.slug, path });
  }
  if (entries.length === 0) return null;

  // raw cwd first, realpath only as a fallback (a raw match must not be
  // overridden by a longer realpath match).
  const cwds = [];
  for (const c of [cwd, realpathCwd]) {
    const n = normalizeWorkingDir(c);
    if (n && !cwds.includes(n)) cwds.push(n);
  }

  // Tier 1: first cwd variant with any longest-prefix match wins. With
  // rejectAmbiguous (session-cwd close check), two DISTINCT projects sharing the same
  // longest matching working_dir (a monorepo config with no uniqueness invariant)
  // is a genuine tie we must NOT break arbitrarily — silently picking the first
  // would attribute a close to the wrong project and either mask a real failure
  // (false-green) or block the wrong one (false-block). Decline the tie → null,
  // so the caller degrades to the unresolved-cwd path instead of guessing.
  for (const c of cwds) {
    const cf = _fold(c, caseInsensitive);
    let bestSlug = null;
    let bestLen = -1;
    let bestTied = false;
    for (const e of entries) {
      if (!isEligible(e.slug)) continue;
      const pf = _fold(e.path, caseInsensitive);
      if (cf === pf || cf.startsWith(`${pf}/`)) {
        if (e.path.length > bestLen) {
          bestLen = e.path.length;
          bestSlug = e.slug;
          bestTied = false;
        } else if (e.path.length === bestLen && e.slug !== bestSlug) {
          bestTied = true;
        }
      }
    }
    if (bestSlug) {
      if (bestTied && rejectAmbiguous) return null;
      return bestSlug;
    }
  }

  // Tier 2: unique-basename ancestor, but only when the chain points at exactly
  // ONE project (two distinct matches along the path → decline, fail closed).
  const byBasename = new Map();
  for (const e of entries) {
    const b = _fold(_lastSeg(e.path), caseInsensitive);
    if (!b) continue;
    const hit = byBasename.get(b);
    if (hit) hit.count += 1;
    else byBasename.set(b, { slug: e.slug, count: 1 });
  }

  for (const c of cwds) {
    const matched = new Set();
    let cur = c;
    while (cur && cur.includes('/')) {
      const b = _fold(_lastSeg(cur), caseInsensitive);
      const hit = b && byBasename.get(b);
      if (hit && hit.count === 1 && isEligible(hit.slug)) matched.add(hit.slug);
      cur = cur.slice(0, cur.lastIndexOf('/'));
    }
    if (matched.size === 1) return [...matched][0];
  }
  return null;
}

// Disk companion: [{slug, workingDir}] for every real project (skips _template
// and dirs without index.md). The full set is the tier-2 uniqueness universe.
// working_dir is cleaned exactly like scripts/lib/frontmatter.mjs parseFrontmatter
// (strip a trailing ` # comment`, then surrounding quotes) so this stays in step
// with the script-side collector — parseFrontmatterField alone skips the comment.
export function collectProjectWorkingDirs(hypoDir) {
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return [];
  // existsSync is true for a regular file too, and it says nothing about
  // permissions, so readdirSync here can still throw ENOTDIR or EACCES. It
  // used to, and the caller that matters is SessionStart's cwd-to-project
  // resolution, which runs long before the view writer. An unguarded throw
  // there took the whole hook to its top-level catch. Degrade to "no projects"
  // instead. Resolving cwd to a project is a convenience.
  let slugs;
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    if (slug === '_template') continue;
    const dir = join(projectsDir, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const indexPath = join(dir, 'index.md');
    if (!existsSync(indexPath)) continue;
    let workingDir = null;
    try {
      const fm = readFileSync(indexPath, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const line = fm && fm[1].split(/\r?\n/).find((l) => /^working_dir:/.test(l));
      if (line) {
        workingDir = line
          .slice('working_dir:'.length)
          .trim()
          .replace(/\s+#.*$/, '')
          .replace(/^['"]|['"]$/g, '');
      }
    } catch {
      workingDir = null;
    }
    out.push({ slug, workingDir: workingDir || null });
  }
  return out;
}

// One place that answers "is this string a slug naming a real project directory?" and, if so,
// which directory name it is on disk. Both resolveGateProjectOverride (a caller-supplied
// --project) and the gate's mustEvaluate filter (slugs arriving from a transcript or a marker)
// need it. The grammar is session-entries' isValidProjectName, the one rule every gate shares.
// Names are compared in NFC: a payload name typed in NFD finds a directory stored in NFC (and the
// reverse) even on a filesystem that compares bytes. The returned name is the one on disk, so
// callers join paths and compare slugs with the spelling the directory really has. A directory
// whose on-disk spelling is not NFC resolves to null: git on macOS reports NFC paths, so every
// supplied-path match, entry project and gate slug built from that name would miss. Callers that
// can say why ask nonNfcProjectDir. Exported for scripts/, which resolves its own payload and
// --project names through it.
function findProjectDir(hypoDir, slug) {
  if (!isValidProjectName(slug)) return null;
  const want = slug.normalize('NFC');
  try {
    const names = readdirSync(join(hypoDir, 'projects'));
    const hit = names.includes(slug) ? slug : names.find((n) => n.normalize('NFC') === want);
    return hit !== undefined && statSync(join(hypoDir, 'projects', hit)).isDirectory() ? hit : null;
  } catch {
    return null;
  }
}

export function resolveProjectDirName(hypoDir, slug) {
  const hit = findProjectDir(hypoDir, slug);
  return hit !== null && projectNameProblem(hit) === null ? hit : null;
}

// The on-disk name when `slug` finds a project directory spelled in a non-NFC form, else null.
// This is the reason resolveProjectDirName returned null for a name that does exist.
export function nonNfcProjectDir(hypoDir, slug) {
  const hit = findProjectDir(hypoDir, slug);
  return hit !== null && projectNameProblem(hit) === 'not-nfc' ? hit : null;
}

// The refusal text for a non-NFC project directory, with the command that fixes it. APFS treats the
// NFC and NFD spellings as one name, and rename respells the directory in one move.
export function nonNfcProjectMessage(onDisk) {
  const [command] = nfcRenameCommands(onDisk);
  return (
    `projects/${onDisk} is spelled in decomposed (NFD) Unicode, and git reports project paths ` +
    `precomposed (NFC), so the close cannot match its files. Rename projects/${onDisk} to its NFC ` +
    `spelling first: ${command}`
  );
}

// session-close-scope-boundary spec §2: the one place that turns a caller-
// supplied project name into precompactGateStatus's opts.projectOverride. Four
// call sites share it (--mark-session-closed, apply's auto-marker, PreCompact,
// Stop) so a foreign project's dangling close files demote to a notice instead
// of blocking a session that never touched them, everywhere the gate runs.
//
// `project` is trusted nowhere upstream of this function: crystallize.mjs's
// own --project only gets slug-syntax + directory-existence checked when the
// CLI itself parses it (parseArgs + requireProjectDir); a value that arrives
// via a hook payload or apply's JSON body never passes through that. So this
// re-validates from scratch — same charset rule as project-create.mjs's
// isValidProjectName, imported from session-entries.mjs, the one place that
// owns the rule — plus a directory
// existence check. Either failure returns null, the same as "no project was
// given": a garbage slug must never narrow the gate's scope, only a real one
// may (spec success criterion: "opts.projectOverride 가 없는 slug 이면 게이트가
// 그것을 거절한다").
//
// With no `project`, the override is inferred from `sessionCwd` via
// pickProjectByCwd's rejectAmbiguous mode — the same mode the gate's own
// close-cwd check already trusts. Without rejectAmbiguous, two projects
// sharing one working_dir (a monorepo with no uniqueness invariant) would
// silently resolve to the first slug and could narrow the gate to a project
// whose OWN close is still incomplete while the real cwd project goes
// unchecked. A decline here (null) is not a failure: precompactGateStatus
// falls back to the global, unscoped judgment, which is exactly the STOP-hook
// call site's actual point (session-close-scope-boundary spec §2: "해석 실패면
// 기존 fail-closed 가 받아 준다는 틀렸다 ... cwd 미해결을 마커 차단으로 만들지 않는다").
//
// @param {string} hypoDir
// @param {{project?: string|null, sessionCwd?: string|null}} [opts]
// @returns {string|null}
export function resolveGateProjectOverride(hypoDir, { project = null, sessionCwd = null } = {}) {
  if (project) {
    return resolveProjectDirName(hypoDir, project);
  }
  return pickProjectByCwd(collectProjectWorkingDirs(hypoDir), sessionCwd, {
    rejectAmbiguous: true,
  });
}

// A project without a working_dir anchor (no index.md, or an index.md missing
// the field) never enters collectProjectWorkingDirs' universe, so cwd-first
// resume always MISSes for it — the SessionStart/CwdChanged MISS branch would
// otherwise only ever offer to create a brand-new (duplicate) project. Match
// the cwd's LEAF basename only (not every ancestor): the anchor being written
// is `working_dir: <cwd>` itself, so matching an ancestor directory would
// backfill the wrong (parent) path. Since projects/<slug>/ names are unique on
// disk, a leaf-basename match identifies at most one project — no separate
// uniqueness gate is needed here (unlike pickProjectByCwd's cross-machine tier
// 2, which reasons over synced *paths* that can collide).
//
// Known bound: a session whose cwd is a SUBDIRECTORY of the anchorless
// project's root (rather than the root itself) will not match — this is a
// deliberate scope limit, not a bug: guessing the project from a mid-tree cwd
// would risk writing an anchor to the wrong (non-root) path.
//
// @param {string} cwd
// @param {string} [hypoDir=HYPO_DIR]
// @returns {{slug: string, hasIndex: boolean}|null} the anchorless project
//   this cwd's leaf basename names, or null when there is no match, no
//   session artifacts, or the project already carries a working_dir.
export function findBackfillCandidate(cwd, hypoDir = HYPO_DIR) {
  const n = normalizeWorkingDir(cwd);
  if (!n) return null;
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return null;
  const leaf = _lastSeg(n);
  if (!leaf) return null;

  const ci = isCaseInsensitiveFs();
  let entries;
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  const slug = entries.find((e) => e !== '_template' && _fold(e, ci) === _fold(leaf, ci));
  if (!slug) return null;

  const dir = join(projectsDir, slug);
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const hasArtifacts =
    existsSync(join(dir, 'session-state.md')) ||
    existsSync(join(dir, 'hot.md')) ||
    existsSync(join(dir, 'session-log'));
  if (!hasArtifacts) return null;

  const indexPath = join(dir, 'index.md');
  const hasIndex = existsSync(indexPath);
  let workingDir = null;
  if (hasIndex) {
    try {
      const fmBlock = readFileSync(indexPath, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const line = fmBlock && fmBlock[1].split(/\r?\n/).find((l) => /^working_dir:/.test(l));
      if (line) {
        workingDir = line
          .slice('working_dir:'.length)
          .trim()
          .replace(/\s+#.*$/, '')
          .replace(/^['"]|['"]$/g, '');
      }
    } catch {
      workingDir = null;
    }
  }
  if (hasIndex && workingDir) return null; // already anchored — not a backfill case

  return { slug, hasIndex };
}

/**
 * When the session cwd is a project working_dir distinct from the vault root,
 * the wiki/knowledge files live in the VAULT, not in this cwd. SessionStart puts
 * hot.md/session-state content in the model's context, and CwdChanged surfaces
 * the same content as a terminal notification the model does not see, but
 * neither carries the vault's absolute path, so the AI re-discovers it each
 * session and can wrongly conclude a wiki file is missing after checking only
 * the code repo (a real misjudgment seen in a dev-repo session, 2026-06-23).
 *
 * Returns a one-line "look in the vault, not here" orientation carrying the
 * absolute vault path, or '' when cwd is anywhere inside the vault tree (the
 * "wiki files live in the vault, not here" framing would be false there) or
 * hypoDir is unset. The HIT matcher is prefix-based, so a project whose
 * working_dir is the vault root can match a vault SUBDIRECTORY; checking only
 * exact root-equality would wrongly fire for those. Compared via realpath so a
 * symlinked cwd or vault still matches.
 *
 * Containment uses the SAME normalize + case-fold + prefix policy as
 * pickProjectByCwd so the two never disagree: on a case-insensitive FS the
 * matcher case-folds, so a cwd differing only in case is still a HIT and must be
 * suppressed here too (otherwise a false orientation leaks).
 *
 * @param {string} cwd  the session cwd (already known to be a project HIT)
 * @param {string} [hypoDir=HYPO_DIR]
 * @param {{caseInsensitive?: boolean}} [opts]  override FS case policy (tests)
 * @returns {string}
 */
export function buildVaultOrientation(cwd, hypoDir = HYPO_DIR, opts = {}) {
  if (!cwd || !hypoDir) return '';
  const { caseInsensitive = isCaseInsensitiveFs() } = opts;
  let realCwd = cwd;
  let realVault = hypoDir;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    /* keep raw path when cwd is unreadable */
  }
  try {
    realVault = realpathSync(hypoDir);
  } catch {
    /* keep raw path when vault is unreadable */
  }
  // Suppress when cwd is the vault root OR a descendant of it.
  const c = _fold(normalizeWorkingDir(realCwd) || '', caseInsensitive);
  const v = _fold(normalizeWorkingDir(realVault) || '', caseInsensitive);
  if (!c || !v) return '';
  if (c === v || c.startsWith(`${v}/`)) return '';
  return (
    `[WIKI VAULT: ${hypoDir}] 이 cwd는 작업/코드 레포이고 vault가 아니다. ` +
    `wiki·knowledge·세션로그 파일은 여기가 아니라 vault(${hypoDir})에서 조회한다.`
  );
}

// resume/close entry: match `slugs` against cwd via the two-tier matcher.
// Uniqueness is judged over EVERY project on disk, not just `slugs`. close
// callers pass no cwd, so it stays inert for them.
function pickByCwd(hypoDir, slugs, cwd) {
  if (!cwd) return null;
  let realpathCwd = null;
  try {
    realpathCwd = realpathSync(cwd);
  } catch {
    realpathCwd = null;
  }
  return pickProjectByCwd(collectProjectWorkingDirs(hypoDir), cwd, {
    eligible: slugs,
    realpathCwd,
  });
}

// ── generated view bookkeeping ───────────────────────────────────────────────
// The generated views (`projects/<p>/hot.md`, `projects/<p>/session-state.md` and the root
// `hot.md`) are rendered and written by `hooks/session-views.mjs`. What stays here is what that
// writer and the pull resolution share: the backup path calculation below, the recovery sentence
// a notice carries, and the one-time read of the old root projection's ownership hash.

// File-name suffix of a view backup, kept under `.cache/backups/` (see VIEW_BACKUP_DIR_REL):
// `.cache/backups/hot.md.pre-projection-backup.md`. Every backup of bytes the generator did not
// write gets its own numbered path from nextGeneratedBackupPath, without limit.
export const ROOT_HOT_BACKUP_SUFFIX = '.pre-projection-backup.md';

/**
 * The one recovery sentence for a generated view whose unowned bytes were just backed up before
 * the generator replaced them. Naming the backup file alone is not a recovery path: copying it
 * back onto the view just gets it replaced again on the next write. One formatter for every
 * writer, so they cannot drift into different wordings of the same advice.
 * @param {string} viewRelPath the view's vault-relative path (`hot.md`, `projects/<p>/hot.md`, ...)
 * @param {string} backupPath absolute path to the backup
 * @returns {string}
 */
export function rootHotBackupRecoveryNotice(viewRelPath, backupPath) {
  // A project view names its own project; the root `hot.md` has none to name, so the placeholder
  // is written to be read as one.
  const project = generatedViewSlug(viewRelPath) ?? '<프로젝트>';
  return (
    `생성 파일 \`${viewRelPath}\`에 생성기가 쓰지 않은 내용이 있어 \`${backupPathForNotice(backupPath)}\`에 보관했습니다. ` +
    '구버전 Hypomnema(같은 기계의 다른 설치일 수 있습니다)나 사람이 쓴 내용으로 보입니다. 자동으로 합치지 않았습니다. ' +
    `남길 내용은 다음 close의 요약이나 \`projects/${project}/notes.md\`로 옮기세요.`
  );
}

const ROOT_HOT_PROJECTION_STATE_FILENAME = 'root-hot-projection-state.json';

function sha256Hex(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * The hash the old root `hot.md` projection last wrote, from `.cache/`. Nothing writes this file
 * any more: the view writer reads it once, as the starting ownership of `hot.md` when it has no
 * `generated-views.json` yet, so a vault upgraded from the projection does not back up bytes the
 * old writer itself produced. Missing or corrupt state resolves to "no prior hash": the safe
 * direction, since the only cost is one extra backup.
 * @returns {{lastHash: string|null}}
 */
export function readRootHotProjectionOwnership(hypoDir) {
  const path = join(hypoDir, '.cache', ROOT_HOT_PROJECTION_STATE_FILENAME);
  if (!existsSync(path)) return { lastHash: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return { lastHash: typeof parsed?.lastHash === 'string' ? parsed.lastHash : null };
  } catch {
    return { lastHash: null };
  }
}

/**
 * First unused backup path for `hotPath`: the plain suffix if free, else a
 * numbered variant, so every later non-owned overwrite gets its own place
 * to land instead of finding the plain name taken and skipping the backup.
 */
function nextGeneratedBackupPath(hotPath) {
  const plain = `${hotPath}${ROOT_HOT_BACKUP_SUFFIX}`;
  if (!existsSync(plain)) return plain;
  const stem = ROOT_HOT_BACKUP_SUFFIX.slice(0, -'.md'.length); // '.pre-projection-backup'
  for (let n = 2; n <= 9999; n++) {
    const candidate = `${hotPath}${stem}-${n}.md`;
    if (!existsSync(candidate)) return candidate;
  }
  // Practically unreachable (9998 prior collisions), but never reuse a path
  // silently: a millisecond timestamp is guaranteed distinct from every
  // numbered candidate already checked above.
  return `${hotPath}${stem}-${Date.now()}.md`;
}

// Where view backups live, relative to the vault: `.cache/backups/<view relPath>.pre-projection-backup*.md`.
// Never next to the view: before the migration ignore block lands, and after a rollback, no pattern
// ignores that name, so a blanket `git add -A` would stage a backup holding a person's notes.
// `.cache/` is ignored by every vault `.gitignore` this plugin writes.
export const VIEW_BACKUP_DIR_REL = join('.cache', 'backups');

/**
 * The part of a backup path that a notice shows: from `.cache/backups/` on, so the reader can open
 * it from the vault root. A path from before the move (next to the view) shows its file name.
 */
export function backupPathForNotice(backupPath) {
  const marker = `${VIEW_BACKUP_DIR_REL}${sep}`;
  const at = backupPath.lastIndexOf(marker);
  return at === -1 ? basename(backupPath) : backupPath.slice(at).split(sep).join('/');
}

/**
 * Back `content` up under `.cache/backups/` (see `VIEW_BACKUP_DIR_REL`) for `viewPath` (any
 * generated view's absolute path inside `hypoDir`, not only the root hot.md: the session view
 * writer and the pull resolution use the same function), unless a backup already holds exactly
 * these bytes.
 *
 * minor fix: the backup and the `.gitignore` update run BEFORE the write that
 * replaces hot.md, so a write that fails afterwards (disk full, a rename
 * error) leaves the original in place and the next run sees the same
 * non-owned file again. Without the content comparison that run made a
 * SECOND, numbered copy of bytes already sitting in the first one, and a
 * loop that keeps failing kept minting them. Comparing what is already there
 * makes the retry converge instead: one backup per distinct content, however
 * many times the write after it fails.
 *
 * Reuses nextGeneratedBackupPath's candidate order, so the paths checked here
 * are exactly the ones a fresh backup could occupy, and an unreadable
 * candidate counts as "not a match" (the safe direction: one extra copy, not
 * a skipped one).
 * `testHooks.beforeBackupWrite` is test-only: called with the fresh backup
 * path right before its write, so a test can fail the backup alone while the
 * projection write after it would still succeed. Failing the whole directory
 * cannot tell "the backup ran and failed" from "the backup never ran", since
 * the projection write fails there too.
 * `content` is a string or a Buffer (bytes that may not be text).
 * @returns {string} the backup path now holding `content`, fresh or reused
 */
export function backUpGeneratedPath(hypoDir, viewPath, content, testHooks) {
  const rel = relative(hypoDir, viewPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`backup target is outside the vault: ${viewPath}`);
  }
  const hotPath = join(hypoDir, VIEW_BACKUP_DIR_REL, rel);
  const stem = ROOT_HOT_BACKUP_SUFFIX.slice(0, -'.md'.length);
  const holdsContent = (candidate) => {
    try {
      return readFileSync(candidate).equals(
        Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
      );
    } catch {
      return false; // unreadable: cannot prove it already holds these bytes
    }
  };
  const plain = `${hotPath}${ROOT_HOT_BACKUP_SUFFIX}`;
  // The plain name is always taken first, so its absence means no backup
  // exists yet and the numbered scan below has nothing to find.
  if (existsSync(plain)) {
    if (holdsContent(plain)) return plain;
    for (let n = 2; n <= 9999; n++) {
      const candidate = `${hotPath}${stem}-${n}.md`;
      if (!existsSync(candidate)) break;
      if (holdsContent(candidate)) return candidate;
    }
  }
  const fresh = nextGeneratedBackupPath(hotPath);
  testHooks?.beforeBackupWrite?.(fresh);
  // Durable: the archive record that names this backup is written next, and the clearing step
  // removes the original after that. A power loss must not keep the record and lose the backup.
  atomicWrite(fresh, content, { durable: true });
  return fresh;
}

/**
 * Append `pattern` to the vault's own `.gitignore` when it is not already
 * there. NOT best-effort: a caller about to write a file git must never see
 * calls this first and lets a thrown error stop that write, since a file git can
 * see and auto-commit is a leak, not a private copy.
 * @returns {boolean} true when the file was actually changed
 */
export function ensureVaultGitignorePattern(hypoDir, pattern) {
  const path = join(hypoDir, '.gitignore');
  const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  if (content.split('\n').some((l) => l.trim() === pattern)) return false;
  // An append, not a rewrite: the file may be a symlink into a dotfiles repo, have a mode of
  // its own, or be saved by an editor at this moment; a replace would change the first two
  // and could drop the third.
  appendFileSync(path, `${content.length > 0 && !content.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return true;
}

// ── vault git path helpers ───────────────────────────────────────────────────
// The vault may be a subdirectory of a larger repository. `<rev>:./<path>` makes
// git resolve the path from the vault; `update-index --cacheinfo` and other
// repository-root paths take `vaultGitPrefix` in front instead.

const vaultGit = (hypoDir, args, extra = {}) =>
  spawnSync('git', ['-C', hypoDir, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    ...extra,
  });

/**
 * Git's own words for a failed command: the first three non-empty lines of its stderr (stdout when
 * stderr is empty) on one line, at most 400 characters. A stale `.git/index.lock` is named in the
 * first of them, with the path.
 */
function gitFailureText(run) {
  return String(run?.stderr || run?.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .slice(0, 400);
}

/** `<rev>:./<relPath>`: a `git show` / `cat-file` argument resolved from the vault. */
export function revPathArg(rev, relPath) {
  return `${rev}:./${relPath}`;
}

/**
 * Whether HEAD's tree has `relPath`: `'present'`, `'absent'` (also when the
 * repository has no commit yet), or `'error'` when git could not answer (no
 * repository, a broken one). A caller that would act on "absent" must not read an
 * error as one.
 */
export function headPathState(hypoDir, relPath, { deadline } = {}) {
  // With a `deadline` every git call is cut to the time left, and no time left is an
  // `'error'` (git did not answer), never an `'absent'`.
  const git = (args) => {
    const timeout = remainingSpawnTimeoutMs(deadline);
    return timeout === 0 ? { error: true } : vaultGit(hypoDir, args, timeout ? { timeout } : {});
  };
  const r = git(['ls-tree', '--name-only', 'HEAD', '--', relPath]);
  if (!r.error && r.status === 0) return r.stdout.length > 0 ? 'present' : 'absent';
  // A repository with no commit yet (unborn HEAD) has no path in HEAD at all.
  const head = git(['rev-parse', '--verify', '-q', 'HEAD']);
  const repo = git(['rev-parse', '--git-dir']);
  return !head.error && head.status === 1 && repo.status === 0 ? 'absent' : 'error';
}

/** Whether HEAD's tree has `relPath` (a blob or a tree). False with no HEAD or no repository. */
export function pathInHead(hypoDir, relPath) {
  return headPathState(hypoDir, relPath) === 'present';
}

/** The vault's path inside its repository (`vault/`, or `''` at the top or outside a repository). */
export function vaultGitPrefix(hypoDir) {
  const r = vaultGit(hypoDir, ['rev-parse', '--show-prefix']);
  return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : '';
}

// ── session projects and migration state ─────────────────────────────────────
// Defined here, not in session-views.mjs (which re-exports them), because the
// close gate in this file needs them and session-views imports this file.

/** Present in HEAD's tree when the vault was rolled back to the old flat files on purpose. */
export const SESSION_ENTRIES_OFF_MARKER = '.hypo-session-entries-off';

const statIs = (path, kind) => {
  try {
    return kind === 'dir' ? statSync(path).isDirectory() : statSync(path).isFile();
  } catch {
    return false;
  }
};

// A file or a symlink (dangling or not) sits at the path. `git add` stages both, and `statIs`
// follows links, so a dangling one would read as absent.
const isFileOrLink = (path) => {
  try {
    const st = lstatSync(path);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Slugs of the `projects/` children that are session projects, in code-unit order. A vault with no
 * `projects/` directory has none (`[]`). Any other read error (EACCES, EIO) throws: an empty list
 * must mean "no projects", never "could not look", or a root table rendered from it would silently
 * drop every row.
 */
export function listSessionProjects(hypoDir) {
  let names;
  try {
    names = readdirSync(join(hypoDir, 'projects'));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
  return names
    .filter((slug) => {
      const dir = join(hypoDir, 'projects', slug);
      return (
        statIs(dir, 'dir') &&
        isSessionProjectDir({
          slug,
          hasIndex: statIs(join(dir, 'index.md'), 'file'),
          hasSessions: statIs(join(dir, 'sessions'), 'dir'),
        })
      );
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The generated view paths git tracks. `source: 'index'` (default) is `git ls-files`, `'head'` is
 * `git ls-tree -r HEAD`. Filtered by `isGeneratedViewPath`, never by a pathspec (`*` crosses `/`).
 * Throws when git cannot answer: an empty list must always mean "nothing tracked".
 */
export function listTrackedGeneratedViews(hypoDir, { source = 'index' } = {}) {
  if (source !== 'head' && source !== 'index') {
    throw new Error(`listTrackedGeneratedViews: source must be 'head' or 'index', got ${source}`);
  }
  const args =
    source === 'head' ? ['ls-tree', '-r', '-z', '--name-only', 'HEAD'] : ['ls-files', '-z'];
  const r = vaultGit(hypoDir, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim()}`);
  return r.stdout.split('\0').filter((p) => isGeneratedViewPath(p));
}

/**
 * The generated views HEAD tracks in a vault that counts as migrated: what a push must not hand to
 * other machines, and what `doctor` reports with the `git rm --cached` remedy. "Migrated" is either
 * the upstream carrying the `.gitignore` block with HEAD having taken it in (`@{u}` is an ancestor
 * of HEAD, so a copy that has not pulled yet is not judged), or HEAD's own `.gitignore` holding the
 * whole block (the only reading a vault with no remote has). The off marker in HEAD is a rollback
 * on purpose, where tracking the flat files is the intended state: it is judged by presence only,
 * its content is never read. Throws when git cannot list the tracked paths. `[]` means nothing to
 * report.
 */
export function listRetrackedViews(hypoDir) {
  if (pathInHead(hypoDir, SESSION_ENTRIES_OFF_MARKER)) return [];
  const caughtUp =
    upstreamIsMigrated(hypoDir) &&
    vaultGit(hypoDir, ['merge-base', '--is-ancestor', '@{u}', 'HEAD']).status === 0;
  if (!caughtUp) {
    const shown = vaultGit(hypoDir, ['show', revPathArg('HEAD', '.gitignore')]);
    const missing = shown.status === 0 ? missingBlockLines(shown.stdout, GITIGNORE_BLOCK) : null;
    if (!missing || missing.length) return [];
  }
  return listTrackedGeneratedViews(hypoDir, { source: 'head' });
}

// A `.git` in `dir` or a parent, a directory or the file a linked worktree or submodule has. Both
// the path as given and its real path are walked: a vault reached through a symlink to a
// subdirectory of a repository has its `.git` above the real path, not above the link.
function hasGitEntry(dir) {
  const starts = [resolvePath(dir)];
  try {
    starts.push(realpathSync(dir));
  } catch {
    // unresolvable: the path as given is all there is
  }
  for (const start of starts) {
    for (let d = start; ; d = dirname(d)) {
      if (existsSync(join(d, '.git'))) return true;
      if (dirname(d) === d) break;
    }
  }
  return false;
}

/**
 * True for a vault that is not a git repository and has no `.git` entry in it or any parent. Such a
 * vault tracks nothing, so `migrationState` calls it `migrated`, and its old `hot.md` and
 * `session-state.md` are moved to baseline entries by the generator instead of a migration commit.
 * Git failing to answer while the entry is there is not this (the vault may well track views).
 */
export function vaultHasNoGit(hypoDir) {
  return (
    vaultGit(hypoDir, ['rev-parse', '--is-inside-work-tree']).status !== 0 && !hasGitEntry(hypoDir)
  );
}

/**
 * `'migrated' | 'not-migrated' | 'opted-out' | 'incomplete-block'`, read from HEAD's tree only (the real index is not
 * consulted: a migration commit moves HEAD and the index together). The off marker in HEAD is
 * `opted-out`; the `.gitignore` block in HEAD plus no tracked generated view in HEAD is
 * `migrated`; a `.gitignore` in HEAD that has the block's first line but lacks one of its pattern
 * lines is `incomplete-block` (a hand edit or a bad merge: nothing treats it as `migrated`, and
 * migration waits for the user to restore it); anything else, including git failing to answer, is
 * `not-migrated`. Only a vault with
 * no `.git` entry in it or any parent (`hasGitEntry`) tracks nothing and counts as `migrated`: when
 * git cannot say whether the directory is a work tree (not installed, dubious ownership, a timeout,
 * a broken config) but the entry is there, the vault may well track views, so it is `not-migrated`.
 */
export function migrationState(hypoDir) {
  if (vaultGit(hypoDir, ['rev-parse', '--is-inside-work-tree']).status !== 0) {
    return hasGitEntry(hypoDir) ? 'not-migrated' : 'migrated';
  }
  if (pathInHead(hypoDir, SESSION_ENTRIES_OFF_MARKER)) return 'opted-out';
  const shown = vaultGit(hypoDir, ['show', revPathArg('HEAD', '.gitignore')]);
  const missing = shown.status === 0 ? missingBlockLines(shown.stdout, GITIGNORE_BLOCK) : null;
  if (missing === null) return 'not-migrated';
  if (missing.length) return 'incomplete-block';
  try {
    return listTrackedGeneratedViews(hypoDir, { source: 'head' }).length === 0
      ? 'migrated'
      : 'not-migrated';
  } catch {
    return 'not-migrated';
  }
}

// Paths per git call in `localChangesOn`: a pathspec per path on the command line stays under the
// argument-size limit of the platform however many paths a migration commit touches.
const LOCAL_CHANGES_CHUNK = 500;

/**
 * Which of `relPaths` carry uncommitted changes: `{staged, unstaged}`. `staged` is where the index
 * differs from HEAD, `unstaged` where the working tree differs from the index (so a path staged and
 * then edited again is in both). Each path is a literal pathspec of its own, so `*` and `:` in a
 * name mean themselves. Untracked files are not changes here. When git cannot answer (no HEAD, not
 * a repository) every path is reported in both lists: this decides whether it is safe to start, so
 * the failure must land on the side that stops. The paths go to git in groups of `chunkSize`
 * (default 500) and the answers are joined; a group git cannot answer counts as all changed.
 */
export function localChangesOn(hypoDir, relPaths, { chunkSize = LOCAL_CHANGES_CHUNK } = {}) {
  const staged = [];
  const unstaged = [];
  for (let i = 0; i < relPaths.length; i += chunkSize) {
    const group = relPaths.slice(i, i + chunkSize);
    const specs = literalSpecs(group);
    const names = (args) => {
      const r = vaultGit(hypoDir, args);
      return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
    };
    staged.push(
      ...(names(['diff', '--cached', '--name-only', '-z', '--relative', 'HEAD', '--', ...specs]) ??
        group),
    );
    unstaged.push(...(names(['diff', '--name-only', '-z', '--relative', '--', ...specs]) ?? group));
  }
  return { staged, unstaged };
}

// ── catching up with a migration commit ──────────────────────────────────────
// Another machine's migration (or rollback) commit changes paths this machine may hold local edits
// on. git then refuses to fast-forward or merge, and reports no unmerged path, so no conflict
// resolution would ever see it. `clearGeneratedPathsBlockingPull` clears that block first and sets
// the bytes it removes aside; `shareLegacyBytes` publishes them afterwards as additional baseline
// entries so a memory that lived only on this machine reaches the others. None of these takes the
// vault commit lock: the caller holds it, and the lock is not reentrant.

const PULL_ARCHIVE_REL = join('.cache', 'pull-archive.json');
const GENERATED_VIEWS_RECORD_REL = join('.cache', 'generated-views.json');
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const BASELINE_FILE_RE = /-baseline-[0-9a-f]{16}\.md$/;

function gitOut(hypoDir, args) {
  const r = vaultGit(hypoDir, args);
  return r.status === 0 ? r.stdout : null;
}

/**
 * The files Hypomnema keeps under `.cache/` (a view backup, the ownership record, the pull archive)
 * that a `git add -A` would stage because no ignore rule covers them, as paths relative to the vault.
 * `[]` means every one is ignored, or there is no repository (nothing to stage). A repository whose
 * check-ignore fails or answers with another code counts as nothing ignored. The
 * block this plugin writes ignores `/.cache/`, but a vault with its own `.gitignore` may not, and
 * the backups hold a person's own notes. Callers write nothing under `.cache/` while this is not
 * empty. A tracked path counts as not ignored, which is the safe side. A vault that ignores only
 * individual cache files is deferred too: the backups sit at paths no such rule names.
 */
export function unignoredCachePaths(hypoDir) {
  // `.cache/` itself, plus a backup path as deep as the ones `backUpGeneratedPath` writes, so a
  // rule that names a few files (or one directory level) does not pass for ignoring the tree.
  return unignoredPaths(hypoDir, [
    '.cache/',
    '.cache/backups/projects/probe/hot.md.pre-projection-backup.md',
    '.cache/pull-archive.json',
    '.cache/generated-views.json',
  ]);
}

/**
 * The paths of `paths` (relative to the vault) that git would NOT ignore, judged by the effective
 * rules in one `git check-ignore --stdin -z` call. A tracked path counts as not ignored. When git
 * cannot answer, inside a repository every path counts as not ignored (that is not proof of an
 * ignore rule); outside one there is nothing to stage and the answer is `[]`.
 */
export function unignoredPaths(hypoDir, paths) {
  if (!paths.length) return [];
  const r = vaultGit(hypoDir, ['check-ignore', '--stdin', '-z'], {
    input: paths.map((p) => `${p}\0`).join(''),
  });
  if (r.status !== 0 && r.status !== 1) {
    return vaultGit(hypoDir, ['rev-parse', '--is-inside-work-tree']).status === 0 ? paths : [];
  }
  const ignored = new Set(String(r.stdout).split('\0'));
  return paths.filter((p) => !ignored.has(p));
}

/** The notice that goes with a deferral because `unignoredCachePaths` was not empty. */
export function cacheNotIgnoredNotice(paths) {
  return (
    `.gitignore가 ${paths.join(', ')}를 무시하지 않아 백업과 기록을 쓰지 않고 미뤘습니다 ` +
    '(그대로 쓰면 git add -A가 개인 메모가 든 백업을 스테이징합니다). ' +
    '.gitignore가 `/.cache/`를 무시하도록 고치면(줄을 추가하거나 뒤의 `!` 규칙을 지웁니다) 다음 시도에서 진행됩니다.'
  );
}

// `git show <rev>:./<path>` as text, `null` when git cannot produce it (no such path or revision).
function gitShowText(hypoDir, rev, relPath) {
  const r = spawnSync('git', ['-C', hypoDir, 'show', revPathArg(rev, relPath)], {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

const literalSpecs = (paths) => paths.map((p) => `:(literal)${p}`);

// A project is hidden by `.hypoignore` when its session entries are (isIgnored's second look
// covers a pattern on either view path or on the project directory). The generator, the migration
// and the catch-up all ask this one question.
export const projectHiddenByHypoignore = (hypoDir, slug, patterns) =>
  patterns.length > 0 &&
  isIgnored(join(hypoDir, 'projects', slug, 'sessions', 'x.md'), hypoDir, patterns);

const isAncestorOfHead = (hypoDir, sha) =>
  vaultGit(hypoDir, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0;

/**
 * `.cache/generated-views.json` = {views: {relPath: sha256}}: the bytes the generator last wrote at
 * each generated path. Returns `{views, state}` with `state` `'ok'`, `'missing'` (no file) or
 * `'invalid'` (unreadable, not JSON, or `views` not an object); `views` is `{}` unless `'ok'`.
 * Entries whose value is not a string are dropped. The generator and the catch-up share this one
 * reader, so "did we write these bytes" has one answer.
 */
export function readGeneratedViewsRecord(hypoDir) {
  let raw;
  try {
    raw = readFileSync(join(hypoDir, GENERATED_VIEWS_RECORD_REL), 'utf-8');
  } catch (err) {
    return { views: {}, state: err?.code === 'ENOENT' ? 'missing' : 'invalid' };
  }
  try {
    const views = JSON.parse(raw)?.views;
    if (views === null || typeof views !== 'object' || Array.isArray(views))
      throw new Error('shape');
    return {
      views: Object.fromEntries(Object.entries(views).filter(([, v]) => typeof v === 'string')),
      state: 'ok',
    };
  } catch {
    return { views: {}, state: 'invalid' };
  }
}

const LEGACY_MOVE_PENDING_REL = join('.cache', 'legacy-move-pending.json');

/**
 * The slugs of the projects whose move of old `hot.md` / `session-state.md` into baseline entries
 * (a vault with no git) has not happened yet: hidden by `.hypoignore` or stopped by a name clash
 * when the first pass ran. A missing or unreadable file is the empty set.
 */
export function readLegacyMovePending(hypoDir) {
  try {
    const slugs = JSON.parse(readFileSync(join(hypoDir, LEGACY_MOVE_PENDING_REL), 'utf-8'))?.slugs;
    return new Set(Array.isArray(slugs) ? slugs.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Save the set `readLegacyMovePending` reads; an empty set removes the file. */
export function writeLegacyMovePending(hypoDir, slugs) {
  if (slugs.size === 0) rmSync(join(hypoDir, LEGACY_MOVE_PENDING_REL), { force: true });
  else
    atomicWrite(
      join(hypoDir, LEGACY_MOVE_PENDING_REL),
      JSON.stringify({ slugs: [...slugs].sort() }),
    );
}

/** Save `views` (`{relPath: sha256}`) as the ownership record. The one writer of the file `readGeneratedViewsRecord` reads. */
export function writeGeneratedViewsRecord(hypoDir, views) {
  atomicWrite(join(hypoDir, GENERATED_VIEWS_RECORD_REL), JSON.stringify({ views }));
}

/**
 * `{relPath: sha256}` read from an off marker's text. A marker written before the hashes existed
 * (one line) has none, and so does a missing or unreadable one: `{}`. Only a line shaped exactly
 * like the ones a rollback writes (`<sha256>  <path>`) counts.
 */
export function offMarkerHashes(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    // A marker recommitted with CRLF bytes (autocrlf off) leaves one `\r` on every line.
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.replace(/\r$/, ''));
    if (m) out[m[2]] = m[1];
  }
  return out;
}

/**
 * Re-enabling after a rollback: the flat files the rollback committed are the generator's own
 * rendering, so the ownership record takes the marker's hash for every path whose bytes in HEAD
 * still match it. The writer then replaces them without a backup, and the clearing step does not
 * call the root `hot.md` someone's own writing. Bytes edited after the rollback match no hash and
 * stay foreign. Called while HEAD still holds the marker, by the one step both the re-enabling
 * machine and a machine pulling the re-enable commit run. `beforeWrite` runs before the record is
 * written (the cache-ignored check). Returns the claimed paths.
 */
export function claimRolledBackViews(hypoDir, beforeWrite = () => {}) {
  const marked = offMarkerHashes(gitShowText(hypoDir, 'HEAD', SESSION_ENTRIES_OFF_MARKER));
  const { views, state } = readGeneratedViewsRecord(hypoDir);
  const claimed = Object.entries(marked)
    .filter(([rel, hash]) => {
      const text = gitShowText(hypoDir, 'HEAD', rel);
      return text !== null && sha256Hex(text) === hash && views[rel] !== hash;
    })
    .map(([rel]) => rel);
  if (!claimed.length) return claimed;
  beforeWrite();
  // A record that does not exist yet starts from the old root projection's hash, as the writer does.
  const { lastHash } = readRootHotProjectionOwnership(hypoDir);
  if (state === 'missing' && lastHash) views['hot.md'] ??= lastHash;
  for (const rel of claimed) views[rel] = marked[rel];
  writeGeneratedViewsRecord(hypoDir, views);
  return claimed;
}

/**
 * Whether the branch's upstream already carries the session-entries `.gitignore` block, read from
 * `@{u}`'s tree (a failed `pull --ff-only` has still fetched it). False without an upstream. It
 * answers "is the remote migrated", not "does the incoming range need the clearing step": a rollback
 * commit leaves it false. The entry decision for a catch-up is `incomingChangesViewTracking`.
 */
export function upstreamIsMigrated(hypoDir) {
  const shown = gitShowText(hypoDir, '@{u}', '.gitignore');
  const first = GITIGNORE_BLOCK.split('\n')[0];
  return shown !== null && shown.split('\n').some((l) => l.trim() === first);
}

/**
 * Whether taking in `targetRev` adds or removes tracking of any generated view path (`hot.md`,
 * `projects/<p>/hot.md`, `projects/<p>/session-state.md`), read from git: the paths `targetRev`
 * changes since its merge-base with HEAD, status `A` or `D`. This is what decides whether a
 * catch-up needs `clearGeneratedPathsBlockingPull` first. A migration commit removes tracking and a
 * rollback commit adds it back (git then overwrites an ignored local file without a word), so both
 * directions count; `upstreamIsMigrated` sees only the first. A revision git cannot read or diff
 * counts as touching, because the clearing step then reports the failure itself.
 */
export function incomingChangesViewTracking(hypoDir, targetRev) {
  return viewTrackingChangedSince(hypoDir, targetRev, targetRev);
}

/**
 * The same question for our side: whether the commits HEAD holds beyond its merge-base with
 * `targetRev` add or remove tracking of a generated view path (a migration made on this machine and
 * not pushed yet). `pullRemote` asks both sides before it merges.
 */
export function outgoingChangesViewTracking(hypoDir, targetRev) {
  return viewTrackingChangedSince(hypoDir, targetRev, 'HEAD');
}

// `side` is the revision whose changes since the merge-base of HEAD and `targetRev` are judged.
function viewTrackingChangedSince(hypoDir, targetRev, side) {
  const base = gitOut(hypoDir, ['merge-base', 'HEAD', targetRev])?.trim();
  if (!base) return true;
  const diff = gitOut(hypoDir, [
    'diff',
    '--no-renames',
    '--name-status',
    '-z',
    '--relative',
    base,
    side,
  ]);
  if (diff === null) return true;
  const tokens = diff.split('\0').filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    if ('AD'.includes(tokens[i][0]) && isGeneratedViewPath(tokens[i + 1])) return true;
  }
  return false;
}

// `.cache/pull-archive.json`: {v: 2, stage: 'archived'|'merged', targetSha, gitignoreLines,
// views: [{relPath, kind: 'stage'|'worktree', backupPath, sha256, companionRev, run}],
// localOnly: [{relPath, kind, backupPath}], unowned: [{relPath, kind, backupPath}],
// cleared: [{relPath, backupPath}], gitignoreSaved: [{relPath: '.gitignore', kind, backupPath}]}.
// `run` numbers the clearing runs that fed the record: the views of one run (and kind) are one
// state of the machine and pair up in a baseline. The four lists after `views` are what the
// clearing step set aside besides the views, written before it removes anything. A record from
// before they existed lacks them (read as empty, and a view without `run` as run 0). A record of
// any other shape counts as no record.
function readPullArchive(hypoDir) {
  let rec;
  try {
    rec = JSON.parse(readFileSync(join(hypoDir, PULL_ARCHIVE_REL), 'utf-8'));
  } catch {
    return null;
  }
  const okView = (v) =>
    v && ['relPath', 'backupPath', 'sha256'].every((k) => typeof v[k] === 'string');
  const okItem = (v) => v && ['relPath', 'backupPath'].every((k) => typeof v[k] === 'string');
  const items = (key) => (Array.isArray(rec[key]) ? rec[key].filter(okItem) : []);
  if (
    rec?.v !== 2 ||
    !['archived', 'merged'].includes(rec.stage) ||
    typeof rec.targetSha !== 'string' ||
    !Array.isArray(rec.views) ||
    !Array.isArray(rec.gitignoreLines)
  ) {
    return null;
  }
  return {
    v: 2,
    stage: rec.stage,
    targetSha: rec.targetSha,
    gitignoreLines: rec.gitignoreLines.filter((l) => typeof l === 'string'),
    views: rec.views.filter(okView),
    localOnly: items('localOnly'),
    unowned: items('unowned'),
    cleared: items('cleared'),
    gitignoreSaved: items('gitignoreSaved'),
  };
}

// Durable, and only ever called after every backup it names was written durably: nothing is
// removed from the index or the working tree until this record is on disk.
const pullArchiveText = (rec) => `${JSON.stringify(rec, null, 2)}\n`;
const writePullArchive = (hypoDir, rec) =>
  atomicWrite(join(hypoDir, PULL_ARCHIVE_REL), pullArchiveText(rec), { durable: true });

// Whether the record on disk is byte for byte `text` (null: whether there is no record). Null when
// the record cannot be read. A write that threw says nothing about what was published (`atomicWrite`
// renames first and syncs the directory after), so the caller asks the disk.
function pullArchiveHolds(hypoDir, text) {
  try {
    return readTextOrNull(join(hypoDir, PULL_ARCHIVE_REL)) === text;
  } catch {
    return null;
  }
}

// Line endings as git stores them: `core.autocrlf=true` checks a file out with CRLF, so a working
// tree text and the HEAD blob of the same file only match once both are read this way.
const lfText = (t) => (typeof t === 'string' ? t.replace(/\r\n/g, '\n') : t);

const viewKey = (v) => `${v.relPath}\0${v.kind}\0${v.sha256}`;

function mergeViews(...lists) {
  const seen = new Map();
  for (const v of lists.flat()) if (!seen.has(viewKey(v))) seen.set(viewKey(v), v);
  return [...seen.values()];
}

// The key of an entry in the set-aside lists: the path, the kind and the backup that holds it.
const itemKey = (v) => `${v.relPath}\0${v.kind ?? 'worktree'}\0${v.backupPath}`;

// The same merge for the set-aside lists (`localOnly`, `unowned`, `cleared`, `gitignoreSaved`),
// keyed by the backup, so a retry that finds an entry again does not list it twice and one that
// does not find it any more (the file is already gone) does not lose it.
function mergeItems(...lists) {
  const seen = new Map();
  for (const v of lists.flat()) if (!seen.has(itemKey(v))) seen.set(itemKey(v), v);
  return [...seen.values()];
}

// The record `rec` without what an undo took back: `undone` (the undo's own `all`, every entry it
// put back) and `moved.unowned` (copies, never put back). An entry the earlier record
// (`moved.priorRecord`) also holds under the same key stays: `backUpGeneratedPath` reuses a backup
// that already holds the same bytes, so one backup path can belong to the earlier run and to this
// one. The lines this run set aside leave, except those the earlier record carries too. `stage`
// and `targetSha` return to the earlier record's values, so a `merged` record stays one. Null when
// nothing is left.
function pullArchiveWithout(rec, moved, undone) {
  const prior = moved.priorRecord ?? null;
  const without = (list, gone, earlier) => {
    const goneKeys = new Set(gone.map(itemKey));
    const earlierKeys = new Set((earlier ?? []).map(itemKey));
    return list.filter((v) => !goneKeys.has(itemKey(v)) || earlierKeys.has(itemKey(v)));
  };
  const earlierLines = prior?.gitignoreLines ?? [];
  const left = {
    v: 2,
    stage: moved.priorRecord?.stage ?? rec.stage,
    targetSha: moved.priorRecord?.targetSha ?? rec.targetSha,
    gitignoreLines: rec.gitignoreLines.filter(
      (l) => !(moved.gitignoreLines ?? []).includes(l) || earlierLines.includes(l),
    ),
    views: without(rec.views, undone, prior?.views),
    localOnly: without(rec.localOnly, undone, prior?.localOnly),
    unowned: without(rec.unowned, moved.unowned ?? [], prior?.unowned),
    cleared: without(rec.cleared, undone, prior?.cleared),
    gitignoreSaved: without(rec.gitignoreSaved, undone, prior?.gitignoreSaved),
  };
  const anything = ['gitignoreLines', 'views', 'localOnly', 'unowned', 'cleared', 'gitignoreSaved'];
  return anything.some((k) => left[k].length) ? left : null;
}

/**
 * The notices for what the clearing step set aside besides the views: an ignored project's old
 * files (`localOnly`), a root `hot.md` nobody vouched for (`unowned`), an untracked file in a path
 * the merge adds as tracked (`cleared`). Each names its backup. Entries whose `backupPath` is in
 * `announced` are skipped: a caller that already told the user about this run's entries passes
 * them, so the resume of the same record does not say it twice.
 */
export function setAsideNotices(
  hypoDir,
  { localOnly = [], unowned = [], cleared = [] },
  announced = [],
) {
  const done = new Set(announced);
  const fresh = (list) => list.filter((v) => !done.has(v.backupPath));
  const notices = [];
  for (const { relPath, backupPath } of fresh(localOnly)) {
    const proj = generatedViewSlug(relPath) ?? relPath;
    notices.push(
      `무시 프로젝트 ${proj}의 옛 세션 현황을 ${relative(hypoDir, backupPath)}에 보관했습니다. 이 기억은 공유되지 않습니다.`,
    );
  }
  for (const { relPath, backupPath } of fresh(unowned))
    notices.push(rootHotBackupRecoveryNotice(relPath, backupPath));
  for (const { relPath, backupPath } of fresh(cleared)) {
    notices.push(
      `${relPath}는 이행 커밋이 추적 파일로 더하는 경로라 치웠습니다. 원래 내용은 ${relative(hypoDir, backupPath)}에 있습니다.`,
    );
  }
  return notices;
}

// The notice lines for everything the clearing step sets aside, views included: where each backup
// is. `clearBlockingPaths` makes them durable before it removes anything, and `undoClearedPaths`
// takes the same lines back out once every path is back in place.
function clearingNoticeLines(hypoDir, moved) {
  const views = (moved.archived ?? []).map(
    ({ relPath, kind, backupPath }) =>
      `${relPath}의 이 기계 쪽 ${kind === 'stage' ? '스테이징본' : '작업 트리본'}을 ${relative(hypoDir, backupPath)}에 보관했습니다.`,
  );
  return [...views, ...setAsideNotices(hypoDir, moved)];
}

/**
 * Append the lines of `lines` that the working-tree `.gitignore` does not have, at the end (the
 * file stays uncommitted). Lines are compared without a trailing `\r`, so a CRLF file does not get
 * the same line again. A line only counts as present when it sits at or after the last `!` line:
 * ignore rules are order sensitive, so a pattern that appears above a later negation does not
 * apply any more, and appending it again is what puts it back in force. Returns the lines it added.
 */
export function restoreGitignoreLines(hypoDir, lines) {
  const path = join(hypoDir, '.gitignore');
  const current = readTextOrNull(path) ?? '';
  const bare = (l) => l.replace(/\r$/, '');
  const all = current.split('\n').map(bare);
  const lastNegation = all.findLastIndex((l) => l.trimStart().startsWith('!'));
  const have = new Set(all.slice(Math.max(lastNegation, 0)));
  const missing = [...new Set(lines)].filter((l) => !have.has(bare(l)));
  if (!missing.length) return [];
  const lead = current === '' || current.endsWith('\n') ? '' : '\n';
  atomicWrite(path, `${current}${lead}${missing.join('\n')}\n`);
  return missing;
}

/** Mark the archive record `merged`: the caller's merge landed. No record, no change. */
export function markPullArchiveMerged(hypoDir) {
  const rec = readPullArchive(hypoDir);
  if (rec) writePullArchive(hypoDir, { ...rec, stage: 'merged' });
}

/**
 * The step before `merge --ff-only <targetRev>` or `pull --no-rebase` takes in a migration (or
 * rollback) commit: clear what would block it, without ever migrating this machine. Returns
 * `{ok, deferred?, reason?, notice?, backups[], archived[], localOnly[], unowned[], cleared[], gitignoreLines[], gitignoreSaved[], priorRecord, recordWritten}`.
 * A stopped run (`ok: false`) reports everything it had moved up to that point in the same lists,
 * so the caller can take it back. A stop on a failed git command (`unstage-failed`,
 * `checkout-failed`) also carries `gitError`, the first lines of git's own message (a stale
 * `.git/index.lock` with its path), which `pullRemote` puts in its notice and the recorded failure.
 * `priorRecord` is the whole archive record this run read before it wrote its own (null when
 * there was none), and `recordWritten` is true only once this run's own write of the record returned (or threw after the disk already held its bytes): until then the
 * record on disk is the earlier run's, and the undo leaves it alone. `recordUncertain` is true when
 * that write threw and the disk holds neither its bytes nor the earlier ones; the undo then leaves
 * the record and every backup in place.
 *
 * The paths looked at are the ones `targetRev` changes since its merge-base with HEAD (so a
 * diverged history counts only what is coming in). A local change on any of them that is not a
 * generated view or `.gitignore` stops everything (`reason: 'other-dirty'`), and so does a staged
 * `.gitignore` (`deferred: 'gitignore'`, `reason: 'gitignore-staged'`) or a `.gitignore` edit that
 * cannot be merged as a pure addition (`deferred: 'gitignore'`); all of these leave the vault
 * untouched. Otherwise: an ignored project's generated paths that `targetRev` deletes are backed
 * up even when clean (the merge deletes them from the working tree), and go to `localOnly[]`
 * only; every blocked generated path gets its working-tree bytes, and its staged bytes when
 * staged, backed up and listed in `archived[]`;
 * staged target paths are unstaged; the blocked paths are restored to HEAD (or removed when HEAD
 * lacks them); and a path `targetRev` adds as tracked that exists here untracked is cleared
 * (backed up unless its bytes are what this machine's generator last wrote), because git
 * overwrites such a file silently. A cleared path with a backup is listed in `cleared[]`
 * (`{relPath, backupPath}`), not in `archived[]`: it is not a view this machine meant to keep, so
 * it is never shared as a baseline, and `undoClearedPaths` still puts it back. `gitignoreLines` are the uncommitted `.gitignore` additions the
 * caller appends back after the merge (`restoreGitignoreLines`). `gitignoreSaved[]` holds the exact
 * working-tree bytes of a blocked `.gitignore` (`{relPath, kind, backupPath}`, backed up like a
 * view; a staged one was deferred above), which `undoClearedPaths` puts back when the merge does
 * not happen.
 *
 * Before anything is removed or unstaged, everything set aside (`archived`, `localOnly`, `unowned`,
 * `cleared`, `gitignoreSaved`, the lines) is written to `.cache/pull-archive.json`, so a crash at
 * any later point leaves a record that names every backup. The lists also carry what an earlier
 * run that stopped had recorded, merged by backup path. The record is touched only when this run
 * set something aside or the recovery of an earlier `archived` record leaves something for the
 * caller to take back (a record that held only `.gitignore` lines is not rewritten): the callers
 * undo only when a file was moved, so a rewrite for nothing would cost a failed attempt the
 * earlier record's `merged` stage.
 *
 * The root `hot.md` that `targetRev` deletes while it is clean is the one path nobody else
 * touches: its bytes are copied to `unowned[]` (`{relPath, kind, backupPath}`, not part of
 * `backups[]`) unless the generator record or the old root projection state says this machine
 * wrote them. Hashes and comparisons against HEAD ignore the line-ending difference
 * (`\r\n` is read as `\n`), because `core.autocrlf=true` checks the file out with CRLF.
 *
 * Only bytes are moved, never a deletion. A blocked view path the user had deleted (in the working
 * tree or the index) has no bytes to back up, and the clearing step brings it back from HEAD.
 *
 * Just before the unstage, and again before the restore, every blocked path's working-tree bytes
 * and index blob are read again and compared with what the backup took (and a cleared untracked
 * file with the bytes just backed up). A difference means another process wrote meanwhile: nothing
 * more is changed and `{ok: false, deferred: 'concurrent-change'}` comes back.
 *
 * Right after those bytes are read (the snapshot), a blocked path that step 3 saw unstaged but
 * whose index blob now differs from HEAD, or a blocked `.gitignore` whose bytes differ from the
 * ones step 4 judged, stops the run the same way: another process staged or edited it in the
 * window between the scan and the snapshot. `testHooks.beforeSnapshot` runs just before the
 * snapshot is read.
 *
 * `testHooks.beforeUnstage` runs before the first of those comparisons, `testHooks.afterArchive`
 * after the archive record is written and the stage is released, before the second (and before any
 * working-tree path is restored). `testHooks.beforeBackupWrite` goes to the backups.
 */
export function clearGeneratedPathsBlockingPull(hypoDir, targetRev, opts = {}) {
  try {
    return clearBlockingPaths(hypoDir, targetRev, opts);
  } catch (err) {
    if (err?.message === CACHE_NOT_IGNORED && err.result) return err.result;
    throw err;
  }
}

// The generated view paths that exist as files in the working tree: the root `hot.md` and the two
// views of every session project. Tracked or not; the caller judges.
function generatedViewPathsOnDisk(hypoDir) {
  return [
    'hot.md',
    ...listSessionProjects(hypoDir).flatMap((slug) =>
      ['hot.md', 'session-state.md'].map((n) => `projects/${slug}/${n}`),
    ),
  ].filter((rel) => isGeneratedViewPath(rel) && statIs(join(hypoDir, rel), 'file'));
}

// Adds the vault paths `relPaths` to the repository's local exclude file (never the committed
// `.gitignore`, which would publish a hidden project's name). The patterns are relative to the
// repository root, so a vault inside a larger repository gets its prefix. Only lines not already
// there are appended. Returns false when the file could not be written.
function excludeLocally(hypoDir, relPaths) {
  if (!relPaths.length) return true;
  const r = vaultGit(hypoDir, ['rev-parse', '--git-path', 'info/exclude']);
  if (r.status !== 0) return false;
  const file = resolvePath(hypoDir, r.stdout.replace(/\r?\n$/, ''));
  const prefix = vaultGitPrefix(hypoDir);
  try {
    const have = new Set(existsSync(file) ? readFileSync(file, 'utf-8').split(/\r?\n/) : []);
    const add = relPaths
      .map((p) => `/${prefix}${p}`.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ '))
      .filter((line) => !have.has(line));
    if (!add.length) return true;
    mkdirSync(dirname(file), { recursive: true });
    const old = existsSync(file) ? readFileSync(file, 'utf-8') : '';
    appendFileSync(file, `${old.length > 0 && !old.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
    return true;
  } catch {
    return false;
  }
}

// Thrown by `clearBlockingPaths` (carrying its stop result) at the first write under `.cache/` when
// no ignore rule covers it, so a vault with nothing to set aside never meets the check.
const CACHE_NOT_IGNORED = 'cache-not-ignored';

function clearBlockingPaths(hypoDir, targetRev, opts) {
  const { testHooks } = opts;
  // What has been moved so far. Every stop reports all of it, so the caller can undo it.
  const backups = [];
  let localOnly = [];
  let unowned = [];
  let cleared = [];
  let archived = [];
  let gitignoreLines = [];
  let gitignoreSaved = [];
  // Owned views removed without a backup (the generator wrote those bytes); a failed move writes
  // them back from here.
  const ownedRemoved = [];
  // True once this run's `writePullArchive` returned. Until then the record on disk is an earlier
  // run's, and the undo must not rewrite or delete it.
  let recordWritten = false;
  // True when this run's record write threw and the disk holds neither the bytes it meant nor the
  // earlier ones: whether the record was published cannot be judged.
  let recordUncertain = false;
  const stop = (extra) => ({
    ok: false,
    backups,
    archived,
    localOnly,
    unowned,
    cleared,
    gitignoreLines,
    gitignoreSaved,
    ownedRemoved,
    priorRecord: prior ?? null,
    recordWritten,
    recordUncertain,
    ...extra,
  });

  // 1. A previous run that stopped before the merge: put its `.gitignore` lines back and carry its
  // archived bytes into this run. The `.gitignore` write is a restore, so it is safe before the
  // checks below.
  const prior = readPullArchive(hypoDir);
  // The earlier record's exact bytes (null: no file), what a throwing write is judged against.
  let priorRecordText;
  try {
    priorRecordText = readTextOrNull(join(hypoDir, PULL_ARCHIVE_REL));
  } catch {
    priorRecordText = undefined; // unreadable: no later read can match it
  }
  const recovered =
    prior && prior.stage === 'archived' && !isAncestorOfHead(hypoDir, prior.targetSha)
      ? prior
      : null;
  // The exact `.gitignore` bytes of that run come back first (guarded like any undo). The lines are
  // the fallback for a record that has none or whose bytes could not be put back (that entry is
  // carried on); appended after an exact restore they would repeat lines that are already back.
  let carriedGitignore = [];
  if (recovered) {
    let exactBack = false;
    if (recovered.gitignoreSaved.length) {
      exactBack = undoClearedPaths(
        hypoDir,
        { gitignoreSaved: recovered.gitignoreSaved },
        { keepRecord: true },
      ).ok;
      if (!exactBack) carriedGitignore = recovered.gitignoreSaved;
    }
    if (!exactBack) restoreGitignoreLines(hypoDir, recovered.gitignoreLines);
  }

  const targetSha = gitOut(hypoDir, ['rev-parse', '--verify', '--quiet', `${targetRev}^{commit}`]);
  const headSha = gitOut(hypoDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!targetSha || !headSha) return stop({ reason: 'revision-unreadable' });
  const target = targetSha.trim();
  const head = headSha.trim();

  // 1b. Backups and the archive go under `.cache/`: no byte is moved while a `git add -A` would
  // stage them. The check runs just before the first of those writes (`cacheGate`), so a vault
  // with nothing to set aside is not held back by it. Nothing was written yet except the restore
  // of step 1.
  let cacheChecked = false;
  const cacheGate = () => {
    if (cacheChecked) return;
    const unignored = unignoredCachePaths(hypoDir);
    if (!unignored.length) {
      cacheChecked = true;
      return;
    }
    throw Object.assign(new Error(CACHE_NOT_IGNORED), {
      result: stop({
        deferred: 'cache-not-ignored',
        reason: 'cache-not-ignored',
        notice: cacheNotIgnoredNotice(unignored),
      }),
    });
  };

  // 2. What `target` brings in.
  const base = gitOut(hypoDir, ['merge-base', 'HEAD', target])?.trim();
  if (!base) return stop({ reason: 'no-merge-base' });
  const diff = gitOut(hypoDir, [
    'diff',
    '--no-renames',
    '--name-status',
    '-z',
    '--relative',
    base,
    target,
  ]);
  if (diff === null) return stop({ reason: 'diff-failed' });
  const tokens = diff.split('\0').filter(Boolean);
  const incoming = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    incoming.push({ status: tokens[i][0], path: tokens[i + 1] });
  }
  const targetPaths = incoming.map((c) => c.path);

  // 3. Which of them carry local changes. Anything but generated views and `.gitignore` is not
  // ours to move.
  const changes = localChangesOn(hypoDir, targetPaths);
  const staged = new Set(changes.staged);
  const dirty = new Set([...changes.staged, ...changes.unstaged]);
  const blocked = targetPaths.filter((p) => dirty.has(p));
  if (blocked.some((p) => p !== '.gitignore' && !isGeneratedViewPath(p))) {
    return stop({ reason: 'other-dirty' });
  }
  // An intent-to-add entry (`git add -N`) reads as unstaged here (`diff --cached` leaves it out), but
  // the index already holds an empty blob for a path HEAD lacks. The late-stage check below would
  // read that as a concurrent stage on every attempt, with no writer involved, so it waits for the
  // person who made it. A real stage of a path is in `staged` and never matches.
  const intentToAdd = blocked.find(
    (p) => !staged.has(p) && !pathInHead(hypoDir, p) && gitShowText(hypoDir, ':0', p) === '',
  );
  if (intentToAdd) {
    return stop({
      deferred: 'intent-to-add',
      reason: 'intent-to-add',
      notice: `${intentToAdd}에 git add -N 으로 추가 의도만 등록해 둔 항목이 있어 이행 커밋을 받지 못했습니다. 그 파일을 커밋하거나 git restore --staged 로 등록을 풀면 다음 동기화에서 받습니다`,
    });
  }

  // 4. `.gitignore`: only a pure working-tree addition can be set aside. A staged one is not set
  // aside at all: the merge would take it out of the index and the lines come back to the working
  // tree only, so a person's stage boundary would be gone and the backup the notice names deleted.
  // It waits until they commit or unstage it. Everything below this check therefore sees a
  // `.gitignore` that was unstaged when step 3 looked, and keeps no stage copy of it. A stage made
  // after step 3 and before the snapshot below is caught right after the snapshot (`lateStage`),
  // and so is an edit of the `.gitignore` after this step read it (`lateGitignoreEdit`).
  let judgedGitignoreText = null;
  if (staged.has('.gitignore') && blocked.includes('.gitignore')) {
    return stop({
      deferred: 'gitignore',
      reason: 'gitignore-staged',
      notice:
        '스테이징해 둔 .gitignore 변경이 있어 이행 커밋을 받지 못했습니다. 그 변경을 커밋하거나 스테이징을 풀면 다음 동기화에서 받습니다',
    });
  }
  if (blocked.includes('.gitignore')) {
    const headText = gitShowText(hypoDir, 'HEAD', '.gitignore') ?? '';
    const targetText = gitShowText(hypoDir, target, '.gitignore') ?? '';
    judgedGitignoreText = readTextOrNull(join(hypoDir, '.gitignore'));
    const text = judgedGitignoreText ?? '';
    if (!mergeAdditiveGitignore(headText, text, targetText).ok) {
      return stop({
        deferred: 'gitignore',
        reason: 'gitignore-not-additive',
        notice:
          '커밋되지 않은 .gitignore 변경과 받을 커밋의 .gitignore 를 순수 추가로 합칠 수 없어 이행 커밋을 받지 못했습니다. 그 변경을 커밋하거나 되돌리세요',
      });
    }
    const own = mergeAdditiveGitignore(headText, text, headText);
    gitignoreLines = [...new Set(own.merged.slice(headText.length).split('\n').filter(Boolean))];
  }

  const patterns = loadHypoIgnore(hypoDir);
  const hidden = (relPath) => {
    const slug = generatedViewSlug(relPath);
    return slug !== null && projectHiddenByHypoignore(hypoDir, slug, patterns);
  };
  const fresh = [];
  // The number of this run among those that fed the record; see the record's comment.
  const run = Math.max(0, ...(prior?.views ?? []).map((v) => v.run ?? 0)) + 1;
  const backUp = (relPath, kind, text) => {
    cacheGate();
    const backupPath = backUpGeneratedPath(hypoDir, join(hypoDir, relPath), text, testHooks);
    backups.push(backupPath);
    return { relPath, kind, backupPath };
  };

  // 5. An ignored project's generated path that `target` deletes: the merge removes it from the
  // working tree even when clean, so keep a local copy. It is never shared.
  for (const { status, path } of incoming) {
    if (status !== 'D' || !hidden(path) || dirty.has(path)) continue;
    const text = readTextOrNull(join(hypoDir, path)) ?? gitShowText(hypoDir, 'HEAD', path);
    if (text !== null) localOnly.push(backUp(path, 'worktree', text));
  }

  // 5a. A range that removes the off marker re-enables the entries: the flat files the rollback
  // committed are generator bytes (the marker names their hashes), not someone's own writing.
  if (incoming.some((c) => c.status === 'D' && c.path === SESSION_ENTRIES_OFF_MARKER)) {
    claimRolledBackViews(hypoDir, cacheGate);
  }

  // 5b. The root `hot.md` is a generated path too, and a clean one that `target` deletes goes with
  // the merge. Bytes that neither the generator record nor the old root projection state vouches
  // for are someone's own writing: keep a copy and say so (`unowned[]`). Bytes that are exactly
  // what HEAD tracks need no copy either: the merge keeps HEAD in the history, so nothing is lost
  // (the first move of a vault has no ownership record yet, and every clean old file reads as
  // unvouched without this). A re-enable range (it removes the off marker) gets no such vouch: the
  // rollback committed the flat file, so HEAD tracks it and the merge replaces it with the generated
  // view, and a person's rolled-back writing would be lost without the copy.
  const reenabling = incoming.some(
    (c) => c.status === 'D' && c.path === SESSION_ENTRIES_OFF_MARKER,
  );
  if (incoming.some((c) => c.status === 'D' && c.path === 'hot.md') && !dirty.has('hot.md')) {
    const text = readTextOrNull(join(hypoDir, 'hot.md'));
    if (text !== null) {
      const sha = sha256Hex(lfText(text));
      const inHead = gitShowText(hypoDir, 'HEAD', 'hot.md');
      const vouched = [
        readGeneratedViewsRecord(hypoDir).views['hot.md'],
        readRootHotProjectionOwnership(hypoDir).lastHash,
        inHead === null || reenabling ? null : sha256Hex(lfText(inHead)),
      ];
      if (!vouched.includes(sha)) {
        cacheGate();
        const backupPath = backUpGeneratedPath(hypoDir, join(hypoDir, 'hot.md'), text, testHooks);
        unowned.push({ relPath: 'hot.md', kind: 'worktree', backupPath });
      }
    }
  }

  // The vault's own writers are shut out by the vault commit lock the caller holds, so a change
  // since the snapshot came from another Hypomnema process that does not take it, or a person.
  // Either way this run changes nothing more and the bytes stay where they are. ponytail: an
  // external editor can still save between this re-read and the git command right after it; that
  // window (milliseconds) is accepted, a compare-and-swap does not exist for a working tree.
  const changedSince = () => ({
    deferred: 'concurrent-change',
    reason: 'changed-during-clear',
    notice:
      '이행 커밋을 받는 도중 생성 파일이나 인덱스가 바뀌어 아무것도 더 바꾸지 않고 미뤘습니다. 다음 동기화에서 다시 시도합니다',
  });
  testHooks?.beforeSnapshot?.();

  // 6. Blocked generated paths: the working-tree bytes, and the staged bytes of a staged path.
  // `snapshot` is what every blocked path (`.gitignore` too) held when its backup was taken: the
  // unstage and the restore below run only while the bytes still match it (`drifted`).
  const snapshot = new Map(
    blocked.map((p) => [
      p,
      { work: readTextOrNull(join(hypoDir, p)), index: gitShowText(hypoDir, ':0', p) },
    ]),
  );
  // Steps 3 and 4 judged these paths earlier. A path they saw unstaged that holds a different index
  // blob than HEAD now was staged in between, and a `.gitignore` whose bytes are not the ones step 4
  // judged was edited in between. No blocked path has been backed up or recorded yet, so stopping
  // here leaves the stage and the bytes as the other writer left them.
  const lateStage = blocked.some(
    (p) => !staged.has(p) && snapshot.get(p).index !== gitShowText(hypoDir, 'HEAD', p),
  );
  if (lateStage) return stop(changedSince());
  const lateGitignoreEdit =
    blocked.includes('.gitignore') && snapshot.get('.gitignore').work !== judgedGitignoreText;
  if (lateGitignoreEdit) return stop(changedSince());
  for (const path of blocked.filter(isGeneratedViewPath)) {
    const versions = [];
    const { work, index } = snapshot.get(path);
    if (work !== null) versions.push(['worktree', work]);
    const stagedText = staged.has(path) ? index : null;
    if (stagedText !== null) versions.push(['stage', stagedText]);
    for (const [kind, text] of versions) {
      const where = backUp(path, kind, text);
      if (hidden(path)) localOnly.push(where);
      else fresh.push({ ...where, sha256: sha256Hex(text), companionRev: head, run });
    }
  }
  // The `.gitignore` of a blocked run: its exact working-tree bytes, so a failed move can put them
  // back as they were (the lines in `gitignoreLines` are all the merge's success keeps). One that
  // was staged when step 3 looked never gets here (step 4 defers it).
  if (blocked.includes('.gitignore')) {
    const { work } = snapshot.get('.gitignore');
    if (work !== null) gitignoreSaved.push(backUp('.gitignore', 'worktree', work));
  }
  // 6b. A path `target` adds as tracked, held here as an untracked file: git overwrites it without a
  // word (rollback commits do this to every view), so it is moved out below. Its bytes are backed up
  // now, with everything else, so the record written next knows them before anything is removed.
  // A range that brings the off marker is a rollback: its commit tracks the flat files of the
  // projects that existed at its point only. The generated views of any other project (one made
  // since) stay on disk, untracked and no longer ignored once the block is gone, and a `git add -A`
  // would publish them. They are cleared with the rest: dropped when they hold what this machine's
  // generator wrote, backed up first otherwise. A path a person staged is left alone.
  const owned = readGeneratedViewsRecord(hypoDir).views;
  const rollsBack = incoming.some((c) => c.status === 'A' && c.path === SESSION_ENTRIES_OFF_MARKER);
  const added = incoming.filter((c) => c.status === 'A').map((c) => c.path);
  const sweep = rollsBack
    ? generatedViewPathsOnDisk(hypoDir).filter(
        (p) => !added.includes(p) && !hidden(p) && gitShowText(hypoDir, ':0', p) === null,
      )
    : [];
  // A hidden project's local views are not swept: the rollback commit drops the ignore block, so
  // they would show up untracked and a `git add -A` would publish them. They stay on disk and go
  // into this clone's own exclude file.
  const hiddenLocal = rollsBack
    ? generatedViewPathsOnDisk(hypoDir).filter(
        (p) => !added.includes(p) && hidden(p) && gitShowText(hypoDir, ':0', p) === null,
      )
    : [];
  if (!excludeLocally(hypoDir, hiddenLocal)) return stop({ reason: 'exclude-write-failed' });
  const untracked = [];
  for (const path of [...added.filter(isGeneratedViewPath), ...sweep]) {
    if (blocked.includes(path)) continue;
    if (pathInHead(hypoDir, path)) continue;
    const text = readTextOrNull(join(hypoDir, path));
    if (text === null) continue;
    if (owned[path] !== sha256Hex(text)) {
      const { backupPath } = backUp(path, 'worktree', text);
      cleared.push({ relPath: path, backupPath });
    }
    untracked.push({ path, text });
  }
  // What this run set aside itself, counted before the earlier run's entries are merged in.
  const thisRunSetAside = [fresh, localOnly, unowned, cleared, gitignoreSaved, gitignoreLines].some(
    (list) => list.length,
  );
  // What the recovery carries into the lists the caller counts. A record that only held
  // `.gitignore` lines was put back in step 1 and leaves nothing for the caller to undo.
  const recoveredCarries =
    recovered !== null &&
    (recovered.views.length > 0 ||
      recovered.localOnly.length > 0 ||
      recovered.unowned.length > 0 ||
      recovered.cleared.length > 0 ||
      carriedGitignore.length > 0);
  archived = mergeViews(recovered?.views ?? [], fresh);
  localOnly = mergeItems(recovered?.localOnly ?? [], localOnly);
  unowned = mergeItems(recovered?.unowned ?? [], unowned);
  cleared = mergeItems(recovered?.cleared ?? [], cleared);
  gitignoreSaved = mergeItems(carriedGitignore, gitignoreSaved);
  // The record is rewritten only when this run has something to set aside or to carry. The callers
  // undo only when a file was moved, so a rewrite for nothing would leave a failed attempt with a
  // record that lost the earlier run's `merged` stage.
  const touchesRecord = thisRunSetAside || recoveredCarries;
  if (touchesRecord) {
    cacheGate();
    const record = {
      v: 2,
      stage: 'archived',
      targetSha: target,
      gitignoreLines: [...new Set([...(prior?.gitignoreLines ?? []), ...gitignoreLines])],
      views: mergeViews(prior?.views ?? [], archived),
      localOnly: mergeItems(prior?.localOnly ?? [], localOnly),
      unowned: mergeItems(prior?.unowned ?? [], unowned),
      cleared: mergeItems(prior?.cleared ?? [], cleared),
      gitignoreSaved: mergeItems(prior?.gitignoreSaved ?? [], gitignoreSaved),
    };
    const intendedRecordText = pullArchiveText(record);
    try {
      writePullArchive(hypoDir, record);
      recordWritten = true;
    } catch {
      // A throw can come after the rename published the record (the directory sync): ask the disk.
      const heldIntended = pullArchiveHolds(hypoDir, intendedRecordText) === true;
      if (heldIntended) recordWritten = true;
      else if (pullArchiveHolds(hypoDir, priorRecordText) !== true) recordUncertain = true;
      return stop({ reason: 'archive-write-failed' });
    }
    // The notice naming every backup is on disk before anything is removed or unstaged: a stop at
    // any later point (a kill included) leaves the next SessionStart something to show. Delivery
    // can repeat a line the caller prints too. No notice, no clearing.
    const lines = clearingNoticeLines(hypoDir, { archived, localOnly, unowned, cleared });
    if (lines.length && !writeRootHotHealthNotice(hypoDir, lines.join('\n'))) {
      return stop({ reason: 'notice-write-failed' });
    }
  }
  const read = (p) => {
    try {
      return readTextOrNull(join(hypoDir, p));
    } catch {
      return undefined; // unreadable counts as changed
    }
  };
  const drifted = (afterUnstage) =>
    blocked.some((p) => {
      const was = snapshot.get(p);
      const index = afterUnstage && staged.has(p) ? gitShowText(hypoDir, 'HEAD', p) : was.index;
      return read(p) !== was.work || gitShowText(hypoDir, ':0', p) !== index;
    });
  testHooks?.beforeUnstage?.();
  if (drifted(false)) return stop(changedSince());
  const unstage = blocked.filter((p) => staged.has(p));
  const unstageRun = unstage.length
    ? vaultGit(hypoDir, ['reset', '-q', '--', ...literalSpecs(unstage)])
    : null;
  if (unstageRun && unstageRun.status !== 0) {
    return stop({ reason: 'unstage-failed', gitError: gitFailureText(unstageRun) });
  }
  testHooks?.afterArchive?.();
  if (drifted(true)) return stop(changedSince());

  // 7. Put the working tree where `target` can land. Bytes of a blocked path are already backed
  // up. A path HEAD lacks is removed instead of restored.
  const restore = blocked.filter((p) => pathInHead(hypoDir, p));
  for (const p of blocked.filter((q) => !restore.includes(q)))
    rmSync(join(hypoDir, p), { force: true });
  // The untracked files of 6b go now, each only while it still holds the bytes that were backed up.
  for (const { path, text } of untracked) {
    if (read(path) !== text) return stop(changedSince());
    rmSync(join(hypoDir, path), { force: true });
    if (!cleared.some((c) => c.relPath === path)) ownedRemoved.push({ relPath: path, text });
  }
  if (restore.length) {
    const r = vaultGit(hypoDir, ['checkout', 'HEAD', '--', ...literalSpecs(restore)]);
    if (r.status !== 0) {
      return stop({ reason: 'checkout-failed', gitError: gitFailureText(r) });
    }
  }
  return {
    ok: true,
    backups,
    archived,
    localOnly,
    unowned,
    cleared,
    gitignoreLines,
    gitignoreSaved,
    ownedRemoved,
    priorRecord: prior ?? null,
    recordWritten,
    recordUncertain,
  };
}

/**
 * Take back what `clearGeneratedPathsBlockingPull` moved when the merge it was clearing for did not
 * happen. `moved` is its result. Each archived, local-only or cleared path gets its bytes back: a
 * working-tree path is rewritten only when it is absent or still holds what HEAD holds (bytes that
 * landed since are not overwritten; a CRLF checkout of HEAD's bytes counts as holding them), a
 * staged one is put back in the index only when the index entry still equals HEAD's
 * (`hash-object -w`, then `update-index --cacheinfo`, with the vault's prefix in front). The
 * backup bytes are written as they are. When every path is back, the backup files made for them
 * (and for `unowned[]`) are deleted, and `.cache/pull-archive.json` loses the entries this run took
 * back (`pullArchiveWithout`; deleted when nothing is left); otherwise those stay for the next
 * catch-up to carry. The order is record, then the notice lines, then the backups: a stop in
 * between leaves a backup nobody names, never a record naming a backup that is gone. When the
 * record cannot be rewritten (the disk does not hold the bytes the rewrite meant, `pullArchiveHolds`;
 * a throw after the rename published them counts as written), the result is `ok: false` with a
 * notice naming the record, and the record, the notice lines and every backup stay. The callers
 * (`fastForwardTo`, `pullRemote`) read only `.notices`, so that sentence is the user's only signal;
 * `fastForwardTo` appends it to its `notice`. The record is
 * touched only when `moved.recordWritten` says this run wrote it; an earlier run's record is left
 * byte for byte. A backup the record on disk or `moved.priorRecord` still names is never deleted
 * (a run that finds the same bytes already backed up reuses that file, so the earlier run and this
 * one can share it). `keepRecord` leaves the record in place (the clearing step uses it to take
 * back a stopped run's `.gitignore` bytes while that record lives on).
 * `moved.gitignoreSaved[]` is the exact `.gitignore` bytes, put back with the same guards as a
 * view: a working tree that is absent or at HEAD, an index entry that is at HEAD. A `.gitignore`
 * written since is left alone, with a notice naming the backup.
 *
 * Only bytes come back, never a deletion: a view path the user had deleted before the clearing step
 * had no bytes to back up, the clearing step restored it from HEAD, and nothing here deletes it
 * again. The generated views are rebuilt from the entries, so the file returns either way.
 * Returns `{ok, notices[]}`; a path that could not be put back has a notice naming its backup.
 */
export function undoClearedPaths(hypoDir, moved, { keepRecord = false } = {}) {
  const seen = new Set();
  const dedupe = (v) => {
    const key = `${v.relPath}\0${v.kind}\0${v.backupPath}`;
    return !seen.has(key) && seen.add(key);
  };
  const items = [...(moved.archived ?? []), ...(moved.localOnly ?? [])].filter(dedupe);
  const all = [
    ...items,
    ...(moved.cleared ?? []).map((c) => ({ ...c, kind: 'worktree' })).filter(dedupe),
    ...(moved.gitignoreSaved ?? []).filter(dedupe),
  ];
  const prefix = vaultGitPrefix(hypoDir);
  const notices = [];
  const lenient = (path) => {
    try {
      return readTextOrNull(path);
    } catch {
      return undefined; // unreadable: neither absent nor equal to anything
    }
  };
  const indexSha = (relPath) => {
    const out = gitOut(hypoDir, ['ls-files', '-s', '--', ...literalSpecs([relPath])]);
    return out?.split(/\s+/)[1] ?? null;
  };
  const putBack = ({ relPath, kind, backupPath }, bytes) => {
    if (kind === 'stage') {
      const blob = vaultGit(hypoDir, ['hash-object', '-w', '--stdin'], { input: bytes });
      if (blob.status !== 0) return false;
      const sha = blob.stdout.trim();
      const now = indexSha(relPath);
      if (now === sha) return true;
      const head = gitOut(hypoDir, [
        'rev-parse',
        '--verify',
        '--quiet',
        revPathArg('HEAD', relPath),
      ]);
      if (now !== (head?.trim() ?? null)) return false;
      return (
        vaultGit(hypoDir, [
          'update-index',
          '--add',
          '--cacheinfo',
          `100644,${sha},${prefix}${relPath}`,
        ]).status === 0
      );
    }
    const abs = join(hypoDir, relPath);
    const now = lenient(abs);
    if (now === bytes) return true;
    if (now !== null && lfText(now) !== lfText(gitShowText(hypoDir, 'HEAD', relPath))) return false;
    // Durable: the backup this was read from is deleted below, and a power loss must not keep the
    // delete while losing these bytes.
    atomicWrite(abs, bytes, { durable: true });
    return true;
  };
  let allBack = true;
  // A view the generator wrote and the clearing step removed has no backup: write it back when the
  // path is still absent (a file there now is someone's, and rendering rebuilds the view anyway).
  for (const { relPath, text } of moved.ownedRemoved ?? []) {
    try {
      if (lenient(join(hypoDir, relPath)) === null) {
        atomicWrite(join(hypoDir, relPath), text, { durable: true });
      }
    } catch {
      // rendering writes it again
    }
  }
  for (const item of all) {
    const bytes = lenient(item.backupPath);
    let back = false;
    if (typeof bytes === 'string') {
      try {
        back = putBack(item, bytes);
      } catch {
        back = false;
      }
    }
    if (!back) {
      allBack = false;
      notices.push(
        `${item.relPath}를 원래대로 되돌리지 못했습니다. 보관한 내용은 ${item.backupPath}에 있습니다.`,
      );
    }
  }
  // The record may or may not be the one this run meant to write: it stays as it is, the notice
  // lines stay and no backup is deleted. The callers read only `.notices`, so this sentence is what
  // reaches the user.
  if (moved.recordUncertain) {
    return {
      ok: false,
      notices: [
        ...notices,
        `보관 기록(${PULL_ARCHIVE_REL})이 게시됐는지 판정하지 못해 기록과 백업 파일을 모두 그대로 남겼습니다. 기록이 가리키는 항목을 확인한 뒤 정리하세요.`,
      ],
    };
  }
  if (allBack) {
    // Each deletion is synced before the next step relies on it: a power loss that replays the
    // backup removal but not the record change would leave a record naming a backup that is gone.
    const syncDir = (dir) => {
      if (existsSync(dir)) fsyncDir(dir);
    };
    // The record goes first: a stop in between leaves a backup nobody names, not a record that
    // names a backup that is gone. Only a record this run wrote is touched; one written by an
    // earlier run stays as it is. What this run took back leaves the record, what an earlier run
    // left in it stays, and a record with nothing left is deleted.
    let rewriteFailed = false;
    if (moved.recordWritten && !keepRecord && all.length + (moved.unowned ?? []).length > 0) {
      const record = join(hypoDir, PULL_ARCHIVE_REL);
      const rec = readPullArchive(hypoDir);
      const rest = rec && pullArchiveWithout(rec, moved, all);
      const intendedRecordText = rest ? pullArchiveText(rest) : null;
      // A record that is there but unreadable (read error, wrong shape) is not one with nothing left.
      rewriteFailed = rec === null && existsSync(record);
      try {
        if (rest) writePullArchive(hypoDir, rest);
        else if (!rewriteFailed) rmSync(record, { force: true });
      } catch {
        // A throw after the rename still left the intended bytes on disk: go on as written.
        const published = pullArchiveHolds(hypoDir, intendedRecordText) === true;
        rewriteFailed = !published;
      }
      // The disk showing the intended bytes is not durable: a power loss can replay the old record
      // while the backups below are gone. The change counts as done only once the directory sync
      // succeeded; a sync that throws keeps the record, the notice lines and every backup.
      if (!rewriteFailed) {
        try {
          syncDir(dirname(record));
        } catch {
          rewriteFailed = true;
        }
      }
    }
    // The record is in an unknown state (the disk holds neither the bytes this run meant to write
    // nor, necessarily, the earlier ones): it stays as it is, the notice lines stay (they name the
    // backups) and no backup is deleted. The callers read only `.notices` of this result, so this
    // sentence is what reaches the user.
    if (rewriteFailed) {
      return {
        ok: false,
        notices: [
          ...notices,
          `보관 기록(${PULL_ARCHIVE_REL})을 다시 쓰지 못해 기록과 백업 파일을 모두 그대로 남겼습니다. 기록이 가리키는 항목을 확인한 뒤 정리하세요.`,
        ],
      };
    }
    // Every path is back where it was, so the lines naming the backups are retracted before the
    // backups go. A stop in between leaves a notice for a backup that is still there.
    if (!keepRecord) {
      retractRootHotHealthNotice(hypoDir, clearingNoticeLines(hypoDir, moved).join('\n'));
    }
    // A backup a record still names is not deleted: the earlier run's record, or this run's own
    // when it reused that backup, or the record `keepRecord` leaves in place.
    const backupPathsOf = (rec) =>
      rec
        ? [rec.views, rec.localOnly, rec.unowned, rec.cleared, rec.gitignoreSaved].flatMap((list) =>
            (list ?? []).map((v) => v.backupPath),
          )
        : [];
    const referencedBackups = new Set([
      ...backupPathsOf(readPullArchive(hypoDir)),
      ...backupPathsOf(moved.priorRecord),
    ]);
    const backups = [...all, ...(moved.unowned ?? [])].map((v) => v.backupPath);
    for (const backupPath of backups) {
      const deletable = !referencedBackups.has(backupPath);
      if (deletable) rmSync(backupPath, { force: true });
    }
    for (const dir of new Set(backups.map((b) => dirname(b)))) syncDir(dir);
  }
  return { ok: allBack, notices };
}

/**
 * The date of a baseline built from a project's old `hot.md` and `session-state.md` (`texts`, the
 * bytes the baseline holds): the larger `updated:` of the two, else the day git last changed either
 * file, else the local day of `hot.md`'s mtime (`session-state.md`'s when `hot.md` is not on
 * disk), else today. Every step after the first reads the vault, not the bytes, so one pair of
 * bytes gets a different date on two machines only when neither has `updated:` and git has never
 * seen the files. mtime comes before today because today would turn the same bytes into a
 * different baseline on a different day.
 * The generator's virtual baseline, the migration and the catch-up all date a baseline here.
 */
export function legacyBaselineDate(hypoDir, slug, texts) {
  const updated = texts
    .map((t) => ISO_DAY_RE.exec(frontmatterUpdated(t) ?? '')?.[0])
    .filter(Boolean)
    .sort();
  if (updated.length) return updated.at(-1);
  const names = ['hot', 'session-state'];
  const committed = names
    .map((name) => {
      const out = gitOut(hypoDir, [
        'log',
        '-1',
        '--format=%cd',
        '--date=short',
        '--',
        `:(literal)projects/${slug}/${name}.md`,
      ]);
      return out === null ? null : ISO_DAY_RE.exec(out.trim())?.[0];
    })
    .filter(Boolean)
    .sort();
  if (committed.length) return committed.at(-1);
  const pad = (n) => String(n).padStart(2, '0');
  const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  for (const name of names) {
    try {
      return day(statSync(join(hypoDir, 'projects', slug, `${name}.md`)).mtime);
    } catch {
      // not on disk: try the other file
    }
  }
  return day(new Date());
}

// Write `text` at `abs` unless something is already there (a link fails on an existing name, so
// a concurrent writer is never overwritten). 'same' when the existing bytes are these bytes.
function publishNoClobber(abs, text) {
  const tmp = `${abs}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  atomicWrite(tmp, text);
  try {
    linkSync(tmp, abs);
    return 'published';
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    return readTextOrNull(abs) === text ? 'same' : 'conflict';
  } finally {
    rmSync(tmp, { force: true });
  }
}

// A scope as the duplicate check compares it: absent, empty and `shared` are one value.
const scopeKey = (scope) => {
  const v = String(scope ?? '').trim();
  return v === '' ? 'shared' : v;
};

// The baseline entries HEAD already has for `slug`, parsed: [{summary, legacy, scope}].
function committedBaselines(hypoDir, slug) {
  const dir = `projects/${slug}/sessions/`;
  const listed = gitOut(hypoDir, ['ls-tree', '--name-only', '-z', 'HEAD', dir]);
  const found = [];
  for (const name of (listed ?? '').split('\0').filter((n) => BASELINE_FILE_RE.test(n))) {
    const text = gitShowText(hypoDir, 'HEAD', `${dir}${name.split('/').at(-1)}`);
    const parsed = text === null ? null : parseSessionEntry(text);
    if (parsed?.ok) {
      found.push({
        summary: parsed.entry.summary,
        legacy: parsed.entry.bodies[LEGACY_TRACK_ID],
        bodies: JSON.stringify(parsed.entry.bodies),
        scope: scopeKey(parsed.entry.visibilityScope),
      });
    }
  }
  return found;
}

/**
 * Publish the old generated-file bytes `archived` set aside as additional baseline entries
 * (`projects/<p>/sessions/<date>-baseline-<h16>.md`) in one commit, so a memory that only this
 * machine held reaches the others. `archived` is `[{relPath, kind, backupPath, sha256,
 * companionRev}]`; the bytes come from `backupPath` (a missing or changed backup is skipped with a
 * notice). The root `hot.md` and `.hypoignore`d projects are skipped. Per project, one pair
 * (`hot.md` text, `session-state.md` text) is built per run and kind (`run` is 0 when absent), and
 * once for every distinct version of a path within one, so a path archived in two runs with
 * different bytes yields a baseline for each; the side that was not archived comes from
 * `companionRev`'s tree. A pair is not made when HEAD already has a baseline whose summary
 * and state sections (the `legacy` body, or every body of a split state file) are byte-equal to it
 * and the same scope (frontmatter included, so a changed
 * `machine_note` is a different memory, and the same text under another scope is another baseline).
 * The scope of an entry is the narrowest of the old file's, HEAD's `index.md` and the working
 * tree's, so an uncommitted edit of `index.md` can narrow what is committed but never widen it.
 * A path whose file is already there with the same bytes (published, not yet
 * committed) is committed without being written again. Returns `{created: [relPath], skipped:
 * [relPath], unresolved: [archived member], notices: [string]}`. `unresolved` holds the members
 * whose bytes could not be shared yet (a missing or changed backup, a conflicting destination
 * file); a caller that deletes its record must keep them. The caller holds the
 * vault commit lock.
 */
export function shareLegacyBytes(hypoDir, archived) {
  const created = [];
  const skipped = [];
  const notices = [];
  const unresolved = [];
  const patterns = loadHypoIgnore(hypoDir);
  const projects = new Map();
  // Per project, the archived members behind each old text, so a baseline that cannot be written
  // names the members to retry.
  const members = new Map();
  for (const el of archived ?? []) {
    const slug = generatedViewSlug(el?.relPath ?? '');
    if (slug === null || projectHiddenByHypoignore(hypoDir, slug, patterns)) {
      skipped.push(el?.relPath);
      // The root hot.md never becomes a baseline, so its set-aside bytes stay in the backup
      // alone; say where, as the clean-and-deleted case does.
      if (el?.relPath === 'hot.md' && el.backupPath) {
        notices.push(rootHotBackupRecoveryNotice(el.relPath, el.backupPath));
      }
      continue;
    }
    const text = (() => {
      try {
        return readFileSync(el.backupPath, 'utf-8');
      } catch {
        return null;
      }
    })();
    if (text === null || (el.sha256 && sha256Hex(text) !== el.sha256)) {
      skipped.push(el.relPath);
      unresolved.push(el);
      notices.push(
        `${el.relPath}의 백업(${el.backupPath})이 없거나 달라져 추가 기준선을 만들지 않았습니다.`,
      );
      continue;
    }
    // One group per run and kind: the versions of both files that one clearing run set aside.
    // Another run's version of the same path is a version of its own and gets its own baseline.
    const groups = projects.get(slug) ?? new Map();
    projects.set(slug, groups);
    const run = Number.isInteger(el.run) ? el.run : 0;
    const kind = el.kind === 'stage' ? 'stage' : 'worktree';
    const groupKey = `${run}\0${kind === 'stage' ? 1 : 0}`;
    const group = groups.get(groupKey) ?? {
      sort: [run, kind === 'stage' ? 1 : 0],
      hot: [],
      state: [],
    };
    groups.set(groupKey, group);
    const list = el.relPath.endsWith('/hot.md') ? group.hot : group.state;
    if (!list.includes(text)) list.push(text);
    group.rev ??= el.companionRev;
    const memberKey = `${list === group.hot ? 'hot' : 'state'}\0${text}`;
    const byText = members.get(slug) ?? new Map();
    members.set(slug, byText);
    byText.set(memberKey, [...(byText.get(memberKey) ?? []), el]);
  }

  const toCommit = [];
  for (const [slug, groups] of projects) {
    const pairs = new Map();
    const ordered = [...groups.values()].sort(
      (a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1],
    );
    for (const group of ordered) {
      // Only what this group set aside becomes a baseline. The side it did not set aside comes
      // from `companionRev`'s tree for the date alone: that file is not this machine's memory, and
      // a baseline of it would be a stale copy of the other machine's bytes.
      const companion = (name, list, i) =>
        list[i] ??
        (group.rev ? gitShowText(hypoDir, group.rev, `projects/${slug}/${name}.md`) : null) ??
        '';
      for (let i = 0; i < Math.max(group.hot.length, group.state.length); i++) {
        const pair = {
          hotText: group.hot[i] ?? '',
          stateText: group.state[i] ?? '',
          dateTexts: [companion('hot', group.hot, i), companion('session-state', group.state, i)],
        };
        pairs.set(JSON.stringify([pair.hotText, pair.stateText]), pair);
      }
    }
    // The working tree's `index.md` can only narrow what HEAD's says: an uncommitted edit that
    // widens the scope must not publish old text to the other machines before it is committed.
    const indexScope = narrowestVisibilityScope([
      readVisibilityScope(gitShowText(hypoDir, 'HEAD', `projects/${slug}/index.md`) ?? ''),
      readVisibilityScope(readTextOrNull(join(hypoDir, 'projects', slug, 'index.md')) ?? ''),
    ]);
    let existing = null;
    for (const { hotText, stateText, dateTexts } of pairs.values()) {
      // One entry per old file, each with its own scope.
      const builtPair = buildLegacyBaselines({
        hotText,
        stateText,
        date: legacyBaselineDate(hypoDir, slug, dateTexts),
        project: slug,
        scopes: {
          index: indexScope.scope,
          hot: readVisibilityScope(hotText),
          state: readVisibilityScope(stateText),
        },
        legacyDone: false,
      });
      for (const built of builtPair) {
        const mine = parseSessionEntry(built.text).entry;
        existing ??= committedBaselines(hypoDir, slug);
        const rel = `projects/${slug}/sessions/${built.fileName}`;
        // A baseline made before the split held both files in one entry, so the section of this
        // kind is what is compared, not the whole entry.
        const scope = scopeKey(mine.visibilityScope);
        // An earlier build wrote a state file whole, as one `legacy` body, even when it has track
        // sections. The same bytes are the same memory: a split copy beside it would bring back
        // the tracks that were finished there.
        const unsplitBody = (stateText ?? '').replace(/\r\n/g, '\n');
        const same =
          built.kind === 'hot'
            ? (e) => e.scope === scope && e.summary === mine.summary
            : (e) =>
                e.scope === scope &&
                (e.bodies === JSON.stringify(mine.bodies) ||
                  e.bodies === JSON.stringify({ [LEGACY_TRACK_ID]: unsplitBody }));
        if (existing.some(same)) {
          skipped.push(rel);
          continue;
        }
        if (publishNoClobber(join(hypoDir, rel), built.text) === 'conflict') {
          skipped.push(rel);
          unresolved.push(
            ...(members
              .get(slug)
              ?.get(`${built.kind}\0${built.kind === 'hot' ? hotText : stateText}`) ?? []),
          );
          notices.push(`${rel}에 다른 내용의 파일이 이미 있어 추가 기준선을 쓰지 않았습니다.`);
          continue;
        }
        toCommit.push(rel);
        // A later pair in this run can name the same file (two groups with one hot text): it is
        // taken now, not published twice.
        existing.push({
          summary: mine.summary,
          legacy: mine.bodies[LEGACY_TRACK_ID],
          bodies: JSON.stringify(mine.bodies),
          scope,
        });
        notices.push(
          built.kind === 'state'
            ? `이 기계에만 있던 옛 세션 현황을 추가 기준선 ${rel}로 기록했습니다. legacy 트랙에 머리가 여럿 보일 수 있습니다.`
            : `이 기계에만 있던 옛 hot.md를 추가 기준선 ${rel}로 기록했습니다. 최근 세션 요약에 따로 보일 수 있습니다.`,
        );
      }
    }
  }
  if (toCommit.length) {
    const result = commitWikiChanges(hypoDir, toCommit);
    if (!result.committed) {
      notices.push(`추가 기준선을 커밋하지 못했습니다: ${result.reason ?? '이유 미상'}`);
    }
    created.push(...toCommit);
  }
  return { created, skipped, unresolved: [...new Set(unresolved)], notices };
}

/**
 * Finish what a catch-up merge left behind: a record whose `stage` is `merged`, or whose
 * `targetSha` is already an ancestor of HEAD (the merge landed, the rest did not run). Puts the
 * archived `.gitignore` lines back, shares the archived bytes, and deletes the record once every
 * baseline it made is in HEAD and nothing was left unshared (otherwise the record keeps only the
 * unshared views). It names the backup of every local-only, unowned and cleared entry
 * the record holds, except those whose backup path is in `announced`. A record that is still
 * `archived` with a target HEAD does not contain is the next catch-up's to recover and is left
 * alone. Independent of the migration state. Returns `{resumed, created, notices}`.
 */
export function resumePullArchive(hypoDir, { announced = [] } = {}) {
  const rec = readPullArchive(hypoDir);
  if (!rec || (rec.stage !== 'merged' && !isAncestorOfHead(hypoDir, rec.targetSha))) {
    return { resumed: false, created: [], notices: [] };
  }
  restoreGitignoreLines(hypoDir, rec.gitignoreLines);
  // The merge landed, so the lines above are all of the `.gitignore` that carries over.
  for (const { backupPath } of rec.gitignoreSaved) rmSync(backupPath, { force: true });
  const shared = shareLegacyBytes(hypoDir, rec.views);
  const notices = [...shared.notices, ...setAsideNotices(hypoDir, rec, announced)];
  // The record is the only other place that names these backups, and every branch below may drop
  // or shrink it. Their lines are in the notice store first, announced ones included (the caller's
  // copy lives in memory), or the record stays as it is for the next run. A line can show twice.
  const durable = [...shared.notices, ...setAsideNotices(hypoDir, rec)];
  if (durable.length && !writeRootHotHealthNotice(hypoDir, durable.join('\n'))) {
    return {
      resumed: true,
      created: shared.created,
      notices: [
        ...notices,
        `알림을 저장하지 못해 보관 기록(${PULL_ARCHIVE_REL})을 지우지 않고 남겼습니다. 다음 실행이 이어서 처리합니다.`,
      ],
    };
  }
  // A backup the record names that is not on disk (a crash lost it) means nothing was shared for
  // that entry, so "no baseline was created" must not read as "nothing left to do".
  const lost = [...rec.views, ...rec.localOnly, ...rec.unowned, ...rec.cleared].filter(
    (v) => !existsSync(v.backupPath),
  );
  if (lost.length) {
    // A view that was shared and is in HEAD is done; the kept record holds only the unresolved
    // ones, as in the branch below. A baseline not in HEAD yet keeps the whole record for a retry.
    if (
      shared.unresolved.length < rec.views.length &&
      shared.created.every((rel) => pathInHead(hypoDir, rel))
    ) {
      writePullArchive(hypoDir, { ...rec, views: shared.unresolved });
    }
    notices.push(
      `보관 기록이 가리키는 백업 파일이 없어 기록을 지우지 않고 남겼습니다: ${lost.map((v) => `${v.relPath} (${v.backupPath})`).join(', ')}. 내용을 확인한 뒤 ${PULL_ARCHIVE_REL}를 직접 지우세요.`,
    );
  } else if (!shared.created.every((rel) => pathInHead(hypoDir, rel))) {
    notices.push(
      '추가 기준선이 아직 커밋되지 않아 보관 기록을 남겼습니다. 다음 실행이 이어서 처리합니다.',
    );
  } else if (shared.unresolved.length) {
    // The merge landed and the lines above are back, so only the members that could not be shared
    // are left to retry. Their backups stay on disk; the set-aside lists were announced above.
    writePullArchive(hypoDir, {
      ...rec,
      stage: 'merged',
      gitignoreLines: [],
      views: shared.unresolved,
      localOnly: [],
      unowned: [],
      cleared: [],
      gitignoreSaved: [],
    });
    notices.push(
      `공유하지 못한 보관 항목이 있어 기록(${PULL_ARCHIVE_REL})에 그것만 남겼습니다: ${shared.unresolved.map((v) => `${v.relPath} (${v.backupPath})`).join(', ')}. 다음 실행이 다시 시도합니다. 백업이 달라졌거나 같은 이름에 다른 파일이 있으면 대개 저절로 풀리지 않습니다. 공유하지 않아도 되면, 다른 터미널에서 동기화가 돌지 않을 때 백업을 확인하고 ${PULL_ARCHIVE_REL}의 stage 가 merged 이고 views 에 위 항목만 있으며 gitignoreLines, gitignoreSaved, localOnly, unowned, cleared 가 모두 비어 있을 때만 그 파일을 직접 지우세요. 백업 파일은 그대로 남고 이 알림은 멈춥니다.`,
    );
  } else {
    rmSync(join(hypoDir, PULL_ARCHIVE_REL), { force: true });
  }
  return { resumed: true, created: shared.created, notices };
}

const ROOT_HOT_HEALTH_NOTICE_FILENAME = 'root-hot-projection-notice.json';

/**
 * Leave a durable note for the NEXT SessionStart when the Stop-hook rebuild
 * (hypo-hot-rebuild.mjs) fails or hits a scan error: Stop's own stdout is
 * suppressed (`{ suppressOutput: true }`), so a failure there is otherwise
 * invisible to the user until they go looking at stderr. Best-effort like
 * every other cache write in this file: a hook must not fail Stop over a
 * notice file. A notice nobody has read yet is kept and the new message is added after it, one
 * line at a time (a line already pending is kept once, so a multi-line message repeats nothing).
 * @param {string} hypoDir
 * @param {string} message
 * @returns {boolean} whether the notice is on disk. Most callers ignore it; a caller that is about
 *   to replace the only copy of someone's bytes (a view or an index entry) stops when it is false.
 */
export function writeRootHotHealthNotice(hypoDir, message) {
  const path = join(hypoDir, '.cache', ROOT_HOT_HEALTH_NOTICE_FILENAME);
  try {
    // Same lock consumeRootHotHealthNotice takes, so this write can never
    // land inside a concurrent reader's read-then-unlink window (which would
    // otherwise let this brand-new notice be deleted by a reader that read
    // the OLD one, or read half-written bytes from atomicWrite's rename).
    withFileLock(path, () => {
      // A notice nobody has read yet is kept: a second writer before the next SessionStart (a
      // staged-version backup, then an index warning, in one Stop) must not erase the first.
      let pending = '';
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        if (typeof parsed?.message === 'string') pending = parsed.message;
      } catch {
        // no notice yet, or an unreadable one: start over
      }
      const lines = pending ? pending.split('\n') : [];
      for (const line of String(message).split('\n')) if (!lines.includes(line)) lines.push(line);
      // Durable: a caller that gets true goes on to replace the only copy of someone's bytes, so the
      // notice naming the backup has to survive a power loss the backup itself survives.
      atomicWrite(path, JSON.stringify({ message: lines.join('\n'), ts: Date.now() }), {
        durable: true,
      });
    });
    return true;
  } catch {
    // best-effort: losing the notice is strictly better than crashing Stop
    // over it.
    return false;
  }
}

/**
 * Read and delete a pending root-hot-projection health notice left by a
 * prior Stop. One-shot (unlinked on read) so it surfaces exactly once, at
 * the next SessionStart. Returns null when nothing is pending or the file is
 * unreadable/corrupt.
 *
 * Guarded by the same per-target file lock every other read-then-mutate in
 * this file uses (withFileLock), so two SessionStarts racing this call
 * (a shared vault, two machines) cannot both read the same notice and both
 * display it: only the lock holder sees a non-null message, the other finds
 * the file already gone. This does not make delivery exactly-once across a
 * crash (a process that dies between the unlink and actually showing the
 * message still loses it, same as before this lock existed). Only the
 * concurrent double-read is closed here; a true crash-safe exactly-once
 * would need a durable ack, which this file does not keep.
 * @param {string} hypoDir
 * @returns {string|null}
 */
export function consumeRootHotHealthNotice(hypoDir) {
  const path = join(hypoDir, '.cache', ROOT_HOT_HEALTH_NOTICE_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return withFileLock(path, () => {
      if (!existsSync(path)) return null; // a concurrent reader already claimed it
      let message = null;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        message = parsed && typeof parsed.message === 'string' ? parsed.message : null;
      } catch {
        message = null;
      }
      try {
        unlinkSync(path);
      } catch {
        // best-effort cleanup: a leftover file just gets read (and re-shown)
        // again next time, rather than losing anything.
      }
      return message;
    });
  } catch {
    // lock-timeout: leave the file exactly as-is, same as every other
    // lock-timeout path in this file: the notice just waits for the next
    // reader instead of being lost.
    return null;
  }
}

/**
 * Take lines back out of the pending notice: the ones `message` holds, nothing else. For a notice
 * written ahead of a move that was then taken back, so it does not name backups that are gone.
 * The file goes when no line is left. Best-effort like the writer; returns whether it succeeded.
 */
export function retractRootHotHealthNotice(hypoDir, message) {
  const path = join(hypoDir, '.cache', ROOT_HOT_HEALTH_NOTICE_FILENAME);
  if (!existsSync(path)) return true;
  const drop = new Set(String(message).split('\n'));
  try {
    withFileLock(path, () => {
      let pending;
      try {
        pending = JSON.parse(readFileSync(path, 'utf-8')).message;
      } catch {
        return;
      }
      if (typeof pending !== 'string') return;
      const lines = pending.split('\n').filter((l) => !drop.has(l));
      if (lines.length === pending.split('\n').length) return;
      if (!lines.length) unlinkSync(path);
      else atomicWrite(path, JSON.stringify({ message: lines.join('\n'), ts: Date.now() }));
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the active project slug from root hot.md. With a cwd, a project whose
 * working_dir contains it wins (cwd-first); otherwise the
 * most-recently-active row is returned.
 * The cwd helpers (parseFrontmatterField / pickByCwd) and the cwd-first body
 * are kept in sync with scripts/resume.mjs by hand; the surrounding wrapper
 * intentionally differs (resume.mjs adds an mtime fallback, this does not).
 * `cwd` is an optional cwd-first selector: a cwd↔working_dir match
 * wins over recency. resume passes process.cwd(); session-close callers
 * (sessionCloseFileStatus / closeFileTargets) intentionally pass null — close
 * has a different authority (payload.project / freshness, the global invariant),
 * so it never picks by cwd. When cwd is omitted, behavior is
 * identical to the legacy recency version.
 * @param {string} hypoDir
 * @param {string|null} [cwd]
 * @returns {string|null}
 */
export function resolveActiveProject(hypoDir, cwd = null) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return null;
  let content;
  try {
    // Strip HTML comments before parsing so a commented example row, which
    // vaults created before the root table became generated still carry
    // (`<!-- Row format: ... -->`), is not picked up as data.
    content = readFileSync(hotPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
  } catch {
    return null;
  }
  // Canonical hot.md uses wikilinks: | name | date | [[projects/slug/hot]] |
  const wikiRows = [
    ...content.matchAll(
      /\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g,
    ),
  ].map((m) => ({ name: m[1].trim(), date: m[2] || '', slug: m[3] }));
  if (wikiRows.length > 0) {
    // cwd-first: a cwd↔working_dir match wins over recency, across
    // ALL rows. Kept in sync with scripts/resume.mjs. close callers pass null →
    // recency path below (resume=cwd-positive / close=no-pick).
    if (cwd) {
      const picked = pickByCwd(
        hypoDir,
        wikiRows.map((r) => r.slug),
        cwd,
      );
      if (picked) return picked;
    }
    // No cwd match → most recent by date (stable-sort keeps the first table row
    // on a tie, the legacy behavior).
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
    return wikiRows[0].slug;
  }
  // Legacy markdown-link rows: | [name](projects/name/...) | ...
  const mdSlugs = [...content.matchAll(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/g)].map((m) => m[2]);
  if (mdSlugs.length > 0) {
    if (cwd) {
      const picked = pickByCwd(hypoDir, mdSlugs, cwd);
      if (picked) return picked;
    }
    return mdSlugs[0]; // legacy: first table row
  }
  return null;
}

// The session entries of `project` on disk whose file name starts with one of `dates`.
export function datedEntryPaths(hypoDir, project, dates) {
  let names = [];
  try {
    names = readdirSync(join(hypoDir, 'projects', project, 'sessions'));
  } catch {
    return [];
  }
  return names
    .filter((n) => isSessionEntryPath(`projects/${project}/sessions/${n}`))
    .filter((n) => dates.includes(n.slice(0, 10)) && n[10] === '-')
    .sort()
    .map((n) => `projects/${project}/sessions/${n}`);
}

// The entry file of one close id in `project`, found by name on disk:
// `<date>-<closeId>.md`, the date being whatever the close was first published with.
export function entryPathOfClose(hypoDir, project, closeId) {
  let names = [];
  try {
    names = readdirSync(join(hypoDir, 'projects', project, 'sessions'));
  } catch {
    return null;
  }
  const name = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n) && n === `${n.slice(0, 10)}-${closeId}.md`)
    .sort()[0];
  return name ? `projects/${project}/sessions/${name}` : null;
}

// sha256 of a file's raw bytes, null when it cannot be read.
function fileSha256(absPath) {
  try {
    return createHash('sha256').update(readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

// A close id is `<sessionId>-<openedAtIndex>` (closeIdFor), so the pin that holds its local proof
// is the one of the session id in front of the last `-`.
const sessionIdOfClose = (closeId) => closeId.replace(/-\d+$/, '');

// Whether `text` parses as the entry `relPath` names: that close id, that project
// folder, that date, and (when it carries one) the session the close id belongs
// to. A file name is easy to type or copy, so a name alone proves nothing.
function entryMatchesPath(text, relPath) {
  const m = /^projects\/([^/]+)\/sessions\/(\d{4}-\d{2}-\d{2})-(.+-\d+)\.md$/.exec(relPath);
  if (!m) return false;
  const [, project, date, closeId] = m;
  const parsed = parseSessionEntry(text);
  if (!parsed.ok) return false;
  const e = parsed.entry;
  if (e.closeId !== closeId || e.project !== project || e.date !== date) return false;
  return e.sessionId === null || e.sessionId === sessionIdOfClose(closeId);
}

// A session entry another session published that no commit holds yet: a file not in
// HEAD whose name carries a close id of a different session. That session's own close
// commits it, so a gate of this session neither blocks on it nor tells anyone to
// commit or revert it (it is the only copy of that session's summary). An entry
// already in HEAD and since modified is not new, and git failing to answer is not
// "absent": both stay blocking. The file must also be the entry its path names
// (entryMatchesPath).
export function isForeignUncommittedEntry(hypoDir, relPath, sessionId, { deadline } = {}) {
  if (!isValidSessionId(sessionId) || !isSessionEntryPath(relPath)) return false;
  const m = /^projects\/[^/]+\/sessions\/\d{4}-\d{2}-\d{2}-(.+-\d+)\.md$/.exec(relPath);
  if (!m) return false;
  const owner = sessionIdOfClose(m[1]);
  if (owner === sessionId || !isValidSessionId(owner)) return false;
  let text;
  try {
    text = readFileSync(join(hypoDir, relPath), 'utf-8');
  } catch {
    return false;
  }
  if (!entryMatchesPath(text, relPath)) return false;
  return headPathState(hypoDir, relPath, { deadline }) === 'absent';
}

const FOREIGN_ENTRY_NOTICE = (f) =>
  `${f} is another session's new session entry, not committed yet. That session's close ` +
  `commits it, so do not commit or revert it here (다른 세션 close 의 원본이다. 그 세션의 ` +
  `커밋이 실패해 남은 것이면 그 세션이 close 를 다시 실행해야 동기화된다)`;

// Where a session keeps the session-log appends its closes made, one record each:
// `{path, beforeLen, beforeSha256, addedLen, addedSha256, closeId}`.
function shardAppendsPath(hypoDir, sessionId) {
  return join(sessionCacheDir(hypoDir, sessionId), 'shard-appends.json');
}

function readShardAppends(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Record that this session's close appends the text `added` to the session-log shard
 * `relPath`, whose text is `before`. The caller holds the shard lock and calls this
 * before writing: an append nobody recorded blocks every other session's gate, while
 * a record whose write then failed matches no bytes. Never throws.
 *
 * @returns {boolean} false when the record could not be written
 */
export function recordShardAppend(hypoDir, sessionId, relPath, before, added, closeId = null) {
  if (!isValidSessionId(sessionId)) return false;
  const b = Buffer.from(before, 'utf-8');
  const a = Buffer.from(added, 'utf-8');
  const path = shardAppendsPath(hypoDir, sessionId);
  try {
    withFileLock(path, () => {
      const list = readShardAppends(path);
      list.push({
        path: posixPath(relPath),
        beforeLen: b.length,
        beforeSha256: sha256Hex(b),
        addedLen: a.length,
        addedSha256: sha256Hex(a),
        closeId,
      });
      atomicWrite(path, JSON.stringify(list));
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take back the record `recordShardAppend` wrote for one append, once the append itself
 * has been restored (the close's commit did not land). Left behind, the record would
 * license the same bytes added later by hand as that close's own. Only a record that
 * matches the path, the close id and both hashes goes; other records stay. Never throws.
 *
 * @returns {boolean} false when the records could not be rewritten (no matching record is
 *   true: there was nothing to remove)
 */
export function removeShardAppend(hypoDir, sessionId, relPath, before, added, closeId = null) {
  if (!isValidSessionId(sessionId)) return true;
  const path = shardAppendsPath(hypoDir, sessionId);
  if (!existsSync(path)) return true;
  const beforeSha256 = sha256Hex(Buffer.from(before, 'utf-8'));
  const addedSha256 = sha256Hex(Buffer.from(added, 'utf-8'));
  try {
    return withFileLock(path, () => {
      const list = readShardAppends(path);
      const kept = list.filter(
        (r) =>
          !(
            r?.path === posixPath(relPath) &&
            r.closeId === closeId &&
            r.beforeSha256 === beforeSha256 &&
            r.addedSha256 === addedSha256
          ),
      );
      if (kept.length !== list.length) atomicWrite(path, JSON.stringify(kept));
      return true;
    });
  } catch {
    return false;
  }
}

// Every other session's recorded appends to `relPath`.
// ponytail: one small file read per session directory; index the records by shard if
// a vault ever keeps thousands of session directories.
function foreignShardAppends(hypoDir, relPath, sessionId) {
  const own = sessionCacheDir(hypoDir, sessionId);
  const root = dirname(own);
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  return dirs
    .filter((d) => join(root, d) !== own)
    .flatMap((d) => readShardAppends(join(root, d, 'shard-appends.json')))
    .filter(
      (r) =>
        r?.path === relPath &&
        Number.isInteger(r.beforeLen) &&
        Number.isInteger(r.addedLen) &&
        r.addedLen > 0,
    );
}

// A session-log shard other sessions are appending to: in HEAD, and the bytes on disk
// are HEAD's bytes followed by appends other sessions' closes recorded
// (recordShardAppend), one after another, byte for byte. Two closes of one project
// share the day's shard, so the later close's heading sits uncommitted while the
// earlier close's marker gate still runs. A byte no other session recorded (a hand
// edit, this session's own append, a close that died before recording) keeps the
// shard blocking, and so does an index entry that is neither HEAD nor HEAD plus some
// of those appends (a staged edit or deletion). A shard this session recorded counts
// only when the bytes it recorded are the ones HEAD holds (its own write committed),
// the same retirement commitTouchedPaths applies.
export function isForeignAppendOnlyShard(hypoDir, relPath, sessionId, { deadline } = {}) {
  if (!isValidSessionId(sessionId) || !CLOSE_FILE_RE.test(relPath)) return false;
  const head = headBlob(hypoDir, relPath, { deadline });
  if (!head) return false;
  let disk;
  try {
    disk = readFileSync(join(hypoDir, relPath));
  } catch {
    return false;
  }
  if (disk.length < head.length || !disk.subarray(0, head.length).equals(head)) return false;
  const records = foreignShardAppends(hypoDir, relPath, sessionId);
  const ends = [head.length]; // HEAD, then HEAD plus each whole recorded append
  for (let pos = head.length; pos < disk.length; ) {
    const before = sha256Hex(disk.subarray(0, pos));
    const r = records.find(
      (x) =>
        x.beforeLen === pos &&
        x.beforeSha256 === before &&
        pos + x.addedLen <= disk.length &&
        sha256Hex(disk.subarray(pos, pos + x.addedLen)) === x.addedSha256,
    );
    if (!r) return false;
    pos += r.addedLen;
    ends.push(pos);
  }
  const touched = readTouchedPathsStrict(hypoDir, sessionId, touchedLockBudget(deadline));
  if (touched.state === 'locked' || touched.state === 'unreadable') return false;
  // The bytes this session recorded writing, when it wrote this shard. They must be
  // HEAD's, or HEAD's up to a line end: a pathspec commit (`--only`) reads each path
  // from the work tree twice, so another close's append landing between the two
  // reads is committed along with this one's.
  let own = null;
  if (touched.paths.map(posixPath).includes(relPath)) {
    const hashes = readTouchedHashesFile(touchedHashesPath(hypoDir, sessionId));
    if (!Object.hasOwn(hashes, relPath)) return false;
    own = hashes[relPath];
    let committed = sha256Hex(head) === own;
    // One hash per line end: a day's shard is a few hundred lines at most.
    for (let end = head.indexOf(10); !committed && end !== -1; end = head.indexOf(10, end + 1)) {
      committed = sha256Hex(head.subarray(0, end + 1)) === own;
    }
    if (!committed) return false;
  }
  // The index: HEAD, HEAD plus recorded appends another close is staging right now,
  // or (the same race) the shorter bytes this session's committed write left there.
  const index = headBlob(hypoDir, relPath, { index: true, deadline });
  if (!index) return false;
  if (ends.some((e) => e === index.length && disk.subarray(0, e).equals(index))) return true;
  return own !== null && sha256Hex(index) === own;
}

const FOREIGN_APPEND_NOTICE = (f) =>
  `${f} differs from its committed version only by lines added after it, or only in the ` +
  `index, and this session did not write them (most likely another session's close, still ` +
  `committing), so do not commit or revert it here (다른 세션이 덧붙이고 있는 session-log ` +
  `샤드다. 그 세션의 close 가 커밋한다)`;

// The session-log and log.md half of a close check, for one project and the dates its close
// counts under. Pushes into `stale`/`missing` and returns the session-log file that carried the
// heading (`{path, date}`), or null.
function checkCloseLogs(hypoDir, project, dates, stale, missing) {
  // session-log: daily shard, with legacy monthly fallback: must carry a heading for one of
  // `dates` in whichever file holds it. Daily-first read order short-circuits on the small shard.
  // When no match is found, the gap is reported under the canonical daily shard for dates[0].
  // The candidate that actually satisfied the check is returned so a caller that must certify a
  // SPECIFIC committed version (a close receipt) knows which of the (up to) four local/UTC ×
  // daily/monthly candidates this check trusted, rather than re-deriving it.
  let sessionLogEvidence = null;
  for (const date of dates) {
    for (const rel of sessionLogReadCandidates(project, date)) {
      const full = join(hypoDir, rel);
      if (!existsSync(full)) continue;
      let content = '';
      try {
        content = readFileSync(full, 'utf-8');
      } catch {
        continue;
      }
      if (hasSessionLogHeading(content, date)) {
        sessionLogEvidence = { path: rel, date };
        break;
      }
    }
    if (sessionLogEvidence) break;
  }
  if (!sessionLogEvidence) {
    const logRel = sessionLogShardPath(project, dates[0]);
    (existsSync(join(hypoDir, logRel)) ? stale : missing).push(logRel);
  }

  // log.md: must carry a `session` entry for the project on one of `dates`.
  const logFull = join(hypoDir, 'log.md');
  if (!existsSync(logFull)) {
    missing.push('log.md');
  } else {
    let content = '';
    try {
      content = readFileSync(logFull, 'utf-8');
    } catch {
      missing.push('log.md');
    }
    const logFresh = content && dates.some((d) => hasLogEntry(content, d, project));
    if (content && !logFresh) stale.push('log.md');
  }
  return sessionLogEvidence;
}

/** Notice for a project whose session-log shows a close today but whose `sessions/` has no entry for it. */
export const LEGACY_CLOSE_NOTICE_TYPE = 'close-legacy';

/**
 * Notice, on a session-scope check, that the project has no session-log heading or log.md line
 * under the entry's date. It is a notice and not a gap: the heading and line carry no close id,
 * so whatever the check finds there may belong to another close of the same day, and a close is
 * proven by its own entry alone.
 */
export const CLOSE_LOGS_MISSING_NOTICE_TYPE = 'close-logs-missing';

/**
 * Session-close verification (spec §5.2.7 / §8.3). A close writes one entry
 * `projects/<p>/sessions/<date>-<closeId>.md`, a session-log heading and a
 * log.md `## [<date>] session | <p>` line. The generated views (`hot.md`,
 * `session-state.md`) are proof of nothing and are not read.
 *
 * `opts.scope` is required and picks what is proven:
 *   'session'  THIS close, `opts.closeId` (the key is required, a null value is
 *              "no close to prove" and reads as missing). Its entry must be in
 *              HEAD's tree; for a `.hypoignore` project, which never commits
 *              it, the entry's disk bytes must hash to the close pin's
 *              `localProofs[closeId]` instead. Either way those bytes must be
 *              the entry the path names (entryMatchesPath): another close's
 *              entry committed under this close's name proves nothing. Another
 *              close's entry, even one of the same session, proves nothing.
 *              The session-log heading and log.md line are NOT part of this proof:
 *              they carry no close id, so a same-day heading of another close would
 *              pass for this one. They are looked up under the entry's own date (a close
 *              committed before midnight still reads right after it) and a gap
 *              comes back as a `close-logs-missing` notice, never in `stale`/`missing`.
 *              `sessionLogEvidence` is null for this scope.
 *   'global'   any close of the project today: an entry dated today on disk,
 *              plus today's session-log heading and log.md line. A project with
 *              today's heading and no entry dated today was closed by a writer
 *              that predates entries (an older install, or by hand): that is
 *              not a gap, and in a migrated vault it is reported as a
 *              `close-legacy` notice.
 * A missing or unknown scope throws: a call that forgot it must not fall back
 * to the weaker global answer.
 *
 * `projectOverride`: the project to check; when omitted, the active project
 * resolved from root hot.md (recency).
 *
 * `deadline` (optional, `{end}` as `remainingSpawnTimeoutMs` reads it): the budget for the git
 * read of the entry's committed blob. When it runs out before git answers, the result carries
 * `incomplete: 'deadline'` and `ok: false`, with neither `stale` nor `missing` naming the entry:
 * the proof was not finished, which is not the same as the close having failed.
 *
 * @param {string} hypoDir
 * @param {{scope: 'session'|'global', closeId?: string|null, projectOverride?: string|null, deadline?: {end: number}}} opts
 * @returns {{ok: boolean, project: string|null, dates: string[], stale: string[], missing: string[],
 *   sessionLogEvidence: {path: string, date: string}|null, entry: string|null,
 *   notices: {type: string, project: string, reason: string}[], incomplete?: 'deadline'}}
 */
export function sessionCloseFileStatus(hypoDir, opts) {
  const scope = opts?.scope;
  if (scope !== 'session' && scope !== 'global') {
    throw new Error(`sessionCloseFileStatus: scope must be 'session' or 'global', got ${scope}`);
  }
  if (scope === 'session' && !('closeId' in opts)) {
    throw new Error("sessionCloseFileStatus: scope 'session' requires a closeId key");
  }
  const project = opts.projectOverride || resolveActiveProject(hypoDir);
  const notices = [];
  if (!project) {
    return {
      ok: false,
      project: null,
      dates: freshDates(),
      stale: [],
      missing: ['hot.md (no active project in pointer table)'],
      sessionLogEvidence: null,
      entry: null,
      notices,
    };
  }

  const stale = []; // exists but does not prove the close
  const missing = []; // does not exist
  let dates = freshDates();
  let entry = null;
  let sessionLogEvidence = null;
  let incomplete = null;

  if (scope === 'session') {
    const closeId = opts.closeId;
    entry = closeId ? entryPathOfClose(hypoDir, project, closeId) : null;
    if (!entry) {
      missing.push(
        closeId
          ? `projects/${project}/sessions/<date>-${closeId}.md`
          : `projects/${project}/sessions/ (this session has no close entry to prove)`,
      );
    } else {
      dates = [entry.split('/').pop().slice(0, 10)];
      const ignorePatterns = loadHypoIgnore(hypoDir);
      if (ignorePatterns.length > 0 && isIgnored(join(hypoDir, entry), hypoDir, ignorePatterns)) {
        const proof = readClosePin(hypoDir, sessionIdOfClose(closeId)).localProofs[closeId];
        let text = null;
        try {
          text = readFileSync(join(hypoDir, entry), 'utf-8');
        } catch {
          // unreadable: no proof
        }
        if (
          !proof ||
          proof.entryRelPath !== entry ||
          proof.entrySha256 !== fileSha256(join(hypoDir, entry)) ||
          !entryMatchesPath(text, entry)
        ) {
          stale.push(entry);
        }
      } else {
        const blob = headBlob(hypoDir, entry, { deadline: opts.deadline });
        if (!blob && remainingSpawnTimeoutMs(opts.deadline) === 0) incomplete = 'deadline';
        else if (!blob || !entryMatchesPath(blob.toString('utf-8'), entry)) stale.push(entry);
      }
      const logStale = [];
      const logMissing = [];
      checkCloseLogs(hypoDir, project, dates, logStale, logMissing);
      if (logStale.length > 0 || logMissing.length > 0) {
        notices.push({
          type: CLOSE_LOGS_MISSING_NOTICE_TYPE,
          project,
          reason:
            `${project}: no session-log heading or log.md line dated ${dates[0]} was found (` +
            [...logMissing.map((f) => `${f} missing`), ...logStale.map((f) => `${f} stale`)].join(
              ', ',
            ) +
            `). 로그는 이 close의 증명에 쓰지 않습니다. 로그 줄이 빠졌는지 확인하세요`,
        });
      }
    }
  } else {
    const todays = datedEntryPaths(hypoDir, project, dates);
    entry = todays[0] ?? null;
    sessionLogEvidence = checkCloseLogs(hypoDir, project, dates, stale, missing);
    if (!entry) {
      if (sessionLogEvidence) {
        if (migrationState(hypoDir) === 'migrated') {
          notices.push({
            type: LEGACY_CLOSE_NOTICE_TYPE,
            project,
            reason:
              `${project}: today's session-log has a close heading but projects/${project}/sessions/ ` +
              `has no entry dated today. 구버전 Hypomnema나 손으로 쓴 close로 보입니다. 그 기계를 업그레이드하세요.`,
          });
        }
      } else {
        missing.push(`projects/${project}/sessions/${dates[0]}-<close id>.md`);
      }
    }
  }

  return {
    ok: stale.length === 0 && missing.length === 0 && !incomplete,
    project,
    dates,
    stale,
    missing,
    sessionLogEvidence,
    entry,
    notices,
    ...(incomplete ? { incomplete } : {}),
  };
}

// ── global session-close gate ────────────────
// The no-payload close paths must NOT pick one project (recency / cwd) and check
// it — that re-derivation is the prior session-close false-block, and a cwd
// tie-break here would let a fresh cwd mask a DIFFERENT project's dangling
// close. Instead the gate enforces a global invariant: no project may end a
// session with a partial close. resume stays cwd-positive; close
// never picks. The two copies of resolveActiveProject share the cwd-first body
// but the resume.mjs copy adds an mtime fallback this one omits — see resume.mjs.

// Root hot.md Active-Projects rows as {slug, date}. The per-row date column is
// project-scoped (unlike the shared frontmatter `updated:`). Used for candidate
// DISCOVERY in closeCandidateSlugs, not as close-activity evidence: the row date
// was dropped as an activity signal because project-create and
// hypo-hot-rebuild both stamp rows today without a real session. Mirrors
// resolveActiveProject's regex.
function rootHotRows(hypoDir) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return [];
  let content;
  try {
    content = readFileSync(hotPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
  } catch {
    return [];
  }
  return [
    ...content.matchAll(
      /\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g,
    ),
  ].map((m) => ({ slug: m[3], date: m[2] || '' }));
}

// Candidate slugs the global gate must consider: the session projects
// (listSessionProjects: a `projects/` child with an index.md or a sessions/
// directory, never _template) ∪ slugs in a today-dated `## [today] session | P`
// log.md entry ∪ slugs in a today-dated root hot.md row. The log/row unions
// catch a dangling close whose own project files are missing —
// sessionCloseFileStatus reports those as `missing` correctly.
function closeCandidateSlugs(hypoDir, dates) {
  const projectsDir = join(hypoDir, 'projects');
  // An unreadable projects/ reads as no project here. Swallowing that is the
  // same shape as the fail-open hasTornCloseIntent was hardened out of (a
  // judgment that could not be made reading as "nothing found"), and it is
  // deliberate only because this is one of THREE unioned sources, not the
  // whole answer: an unreadable projects/ still leaves today's log.md entries
  // and today's root hot.md rows to name the same slug. A close goes unnoticed
  // only when all three miss it at once. Signalling the uncertainty instead
  // would mean carrying a scanError out through sessionCloseGlobalStatus, whose
  // result is read in five places, so it is a separate change rather than a
  // line here. If you are adding a FOURTH source or removing one of the other
  // two, this comment stops being true and the gate needs the scanError.
  let slugs;
  try {
    slugs = new Set(listSessionProjects(hypoDir));
  } catch {
    slugs = new Set();
  }
  for (const r of rootHotRows(hypoDir)) {
    if (r.date && dates.includes(r.date)) slugs.add(r.slug);
  }
  const logPath = join(hypoDir, 'log.md');
  if (existsSync(logPath)) {
    let content = '';
    try {
      content = readFileSync(logPath, 'utf-8');
    } catch {
      content = '';
    }
    for (const d of dates) {
      // Capture the slug up to the first whitespace OR colon so both canonical
      // log delimiters resolve to the same bare slug: `session | beta — t` and
      // `session | beta: t` both yield `beta`. This parser shares the
      // colon-delimiter contract with hasLogEntry, so a colon-form entry for a
      // real project is a close candidate, not a ghost. `[^\s:]+` cannot span
      // the colon, so a stale/typo heading still yields a token that fails the
      // on-disk directory gate below.
      const re = new RegExp('^## \\[' + escapeRegExp(d) + '\\] session \\| ([^\\s:]+)', 'gm');
      for (const m of content.matchAll(re)) {
        // B-1: only real projects are close candidates. A stale or misspelled
        // slug yields a token that no longer maps to a `projects/<slug>/`
        // directory — gating on disk keeps it out of the dangling-close set.
        // Directory (not bare-exists) mirrors the apply-path project check
        // (crystallize-args.mjs).
        const dir = join(projectsDir, m[1]);
        if (existsSync(dir) && statSync(dir).isDirectory()) slugs.add(m[1]);
      }
    }
  }
  return slugs;
}

// True when project P shows an AUTHORITATIVE today close-activity signal: a
// today-dated session-log heading, or a today-dated `## [today] session | P`
// log.md entry. These are written ONLY by a real session close (apply, or its
// auto-derived root log).
//
// Soft state files are EXCLUDED, because each is bumped to today by
// non-session tooling and is therefore indistinguishable from a real close:
//   - session-state.md `updated:`  — tracker bookkeeping mirrors a new item into
//     the "next tasks" section (a cross-block incident: editing one project's
//     tracker bumped session-state and blocked an unrelated project's /compact).
//   - project hot.md `updated:`    — project-create stamps the template `updated: today`.
//   - root hot.md ROW date:         generated from the session entries (the date of the
//     project's newest entry), left BLANK rather than defaulted to today.
// (Root hot.md *frontmatter* was already never a signal: it is shared, and it is
// the MAX row date across the generated table, never today.)
//
// Tradeoff (documented, accepted): apply writes the session entry FIRST, then the
// session-log + log entry. A process crash before the session-log write leaves a
// torn close that this gate no longer flags. Accepted: a torn close never reached
// apply's ok=true so it wrote no marker; the surviving entry is what the next
// session reads; what is lost is a narrative log entry, not continuity.
function hasTodayCloseActivity(hypoDir, project, dates) {
  for (const d of dates) {
    for (const rel of sessionLogReadCandidates(project, d)) {
      const sl = join(hypoDir, rel);
      if (!existsSync(sl)) continue;
      try {
        if (hasSessionLogHeading(readFileSync(sl, 'utf-8'), d)) return true;
      } catch {
        /* skip */
      }
    }
  }
  const logPath = join(hypoDir, 'log.md');
  if (existsSync(logPath)) {
    try {
      const c = readFileSync(logPath, 'utf-8');
      if (dates.some((d) => hasLogEntry(c, d, project))) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/**
 * Global session-close status for the no-payload close paths.
 * Checks EVERY project with today close-activity; ok only when all are complete.
 * When no project has today activity, falls back to the legacy single recency
 * project (preserves "force the initial close" behavior, byte-identical gate).
 *
 * stale/missing entries are self-describing paths — project-specific files carry
 * `projects/<slug>/…`, root files (`hot.md`/`log.md`) are shared — so the flat
 * aliases need no project prefix and a single-project session is byte-identical
 * to sessionCloseFileStatus (back-compat for the flat-field readers).
 *
 * @param {string} hypoDir
 * @returns {{ok: boolean, projects: Array<{project:string, ok:boolean, stale:string[], missing:string[]}>,
 *            dates: string[], fallback: boolean, primary: string|null,
 *            project: string|null, stale: string[], missing: string[]}}
 */
export function sessionCloseGlobalStatus(hypoDir, opts = {}) {
  // projectOverride (check-only): the caller (`crystallize --check-session-close
  // --project=<slug>`) wants THIS project's close status, not the recency pick —
  // bypass discovery and report the single project, preserving the global return
  // shape. This is the ONLY caller of projectOverride now: the four marker-writing
  // paths (--mark / apply auto-marker / PreCompact / Stop) attribute through
  // `opts.attributionScope` instead (resolveCloseScope, below this function), which
  // only widens the mine/foreign partition's scope Set and leaves this function
  // evaluating every project, same as an unscoped call. A green status here is a
  // project-scoped diagnostic, not the global compact-readiness verdict. The
  // invariant that once justified keeping the writer paths fully unscoped
  // ("marker == compact-ready", codex design review) is superseded by that
  // partition, not restored by it — a marker's own `verified_scope`, attesting
  // exactly what this function's caller evaluated (never `markerProjects`'
  // evidence-based attribution), now ships (session-close-scope-boundary
  // spec §3). The writer is `scripts/lib/crystallize-close-apply.mjs`
  // (`runMarkSessionClosed` and `runMarkerPhase`); the reader is
  // `markerCoversArtifact` in `scripts/doctor.mjs`.
  if (opts.projectOverride) {
    const s = sessionCloseFileStatus(hypoDir, {
      scope: 'global',
      projectOverride: opts.projectOverride,
    });
    return {
      ok: s.ok,
      projects: s.project
        ? [{ project: s.project, ok: s.ok, stale: s.stale, missing: s.missing }]
        : [],
      dates: freshDates(),
      fallback: false,
      primary: s.project,
      project: s.project,
      stale: s.stale,
      missing: s.missing,
      notices: s.notices,
    };
  }
  const dates = freshDates();
  const recency = resolveActiveProject(hypoDir); // no cwd — close never picks by cwd
  // opts.mustEvaluate: slugs this session ATTRIBUTED its close to (explicit
  // --project, transcript close-file edits, a prior marker). They are evaluated
  // even when they are not today-active candidates, because the marker writer
  // stamps the attribution scope: a slug that reaches the marker but never
  // reached this evaluation would be attested as closed without ever being
  // checked (codex pre-commit BLOCKER, reproduced with an empty projects/orphan/).
  // `projects/<slug>/` must exist on disk; a slug naming a directory that is gone
  // (a stale marker inside its 7-day TTL) is dropped rather than turned into a
  // permanent blocker for a project nobody can close any more.
  // existsSync alone would admit a file, or a traversal like '..', from a
  // malformed marker or transcript slug and turn it into a surprise blocker.
  // Same slug grammar the CLI and resolveGateProjectOverride validate against.
  const mustEvaluate = [...(opts.mustEvaluate || [])]
    .map((p) => resolveProjectDirName(hypoDir, p))
    .filter((p) => p !== null);
  // The fallback decision reads REAL today activity only. Letting mustEvaluate
  // populate it would mean an attributed slug suppresses the "this session closed
  // nothing at all" branch, and that branch is a fail-closed guard the partition
  // below depends on (`!close.fallback`).
  const activeCandidates = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );

  // This branch drops `mustEvaluate` on the floor and reports the recency
  // project instead, so `projects` here can name a DIFFERENT project than the
  // caller asked for. No marker is ever written from it, though: `close.fallback`
  // is an unconditional gate blocker (see the fail-closed guards in the partition
  // below) and both marker writers only stamp on a green gate. So a marker whose
  // `verified_scope` names the recency project instead of the requested one is
  // unreachable, not merely fail-safe — do not write code defending that state.
  if (activeCandidates.length === 0) {
    const legacy = sessionCloseFileStatus(hypoDir, { scope: 'global' });
    return {
      ok: legacy.ok,
      projects: legacy.project
        ? [{ project: legacy.project, ok: legacy.ok, stale: legacy.stale, missing: legacy.missing }]
        : [],
      dates,
      fallback: true,
      primary: legacy.project,
      project: legacy.project,
      stale: legacy.stale,
      missing: legacy.missing,
      notices: legacy.notices,
    };
  }

  const todayActive = [...new Set([...activeCandidates, ...mustEvaluate])];

  // primary = the recency project when it is itself today-active, else the first
  // today-active slug (stable order from the candidate set). Used only as the
  // single-slug alias for the message header and the flat `close.project` field.
  // It is NEVER an attribution source: the marker is stamped from close evidence
  // (explicit --project, transcript close-files, apply's payload.project), so this
  // recency-derived value cannot leak into a marker and back into the next gate.
  const primary = recency && todayActive.includes(recency) ? recency : todayActive[0];
  const ordered = [primary, ...todayActive.filter((p) => p !== primary)];

  const notices = [];
  const projects = ordered.map((p) => {
    const s = sessionCloseFileStatus(hypoDir, { scope: 'global', projectOverride: p });
    notices.push(...s.notices);
    return { project: p, ok: s.ok, stale: s.stale, missing: s.missing };
  });
  const ok = projects.every((x) => x.ok);
  const stale = [...new Set(projects.flatMap((x) => x.stale))];
  const missing = [...new Set(projects.flatMap((x) => x.missing))];
  return {
    ok,
    projects,
    dates,
    fallback: false,
    primary,
    project: primary,
    stale,
    missing,
    notices,
  };
}

// ── derivable-artifact auto-derive: root log.md session entry ──────────────────
// The root log.md `## [date] session | <slug>` entry is a DERIVABLE artifact —
// it restates a project's session-log heading, which the close already authored.
// root hot.md is already auto-derived here (rebuild() above); log.md was the only
// derivable still left as a manual checklist step, so a hand-edited close that
// skipped it left the global gate (sessionCloseGlobalStatus) hard-blocking /compact
// for EVERY today-active project — cross-session, looking like a fresh bug each
// time. This derives the missing entry from the session-log heading so the gate
// never blocks on a purely-derivable gap. The session-closed MARKER is NOT derived
// here: it is a proof artifact the close gate actually ran.
//
// Safety guard (codex design review): derive ONLY for a project whose close is
// otherwise complete — i.e. its sole gate problem is log.md. If session-state /
// project hot / session-log are also stale/missing, the authored close is genuinely
// incomplete and MUST keep blocking; deriving log.md then would mask it.

// Build the canonical root log.md heading from a raw session-log heading tail.
// The gate's session-log freshness check accepts ANY `## [date] ...` heading, but
// the log.md check requires `## [date] session | <slug>` — so normalise to that
// shape rather than copying a heading that might not carry `session | <slug>`.
function deriveLogTitle(tail) {
  let t = (tail || '').trim();
  t = t.replace(/^session\b\s*/i, ''); // drop a leading "session" token
  if (t.startsWith('|')) {
    // Drop a leading "| <old label/slug>" segment up to the first em-dash, so a
    // renamed-project heading (`| oldslug — title`) does not leak its old slug
    // into the derived title. A pipe segment with no separator is a bare label
    // (e.g. `| slug`) → no title.
    const dash = t.indexOf('—');
    t = dash === -1 ? '' : t.slice(dash);
  }
  return t.replace(/^\s*[—:-]\s*/, '').trim(); // drop a leading separator
}

/**
 * Build the canonical root log.md entry for ONE session-log heading. Single
 * source of truth for the derived-entry format, shared by the global Stop-hook
 * derive (deriveRootLogEntries) and apply's direct per-close write (B-1), so the
 * two paths never drift on the `→ [[projects/<slug>/hot]]` pointer or spacing.
 * `headingTail` is the text AFTER `## [date]` in the authored session-log heading.
 * @returns {{ heading: string, block: string }} heading = the `## [date] session
 *   | <slug>` line used for exact-line dedup; block = the full two-line entry.
 */
export function rootLogEntry(slug, date, headingTail) {
  const title = deriveLogTitle(headingTail);
  const heading = `## [${date}] session | ${slug}` + (title ? `: ${title}` : '');
  return { heading, block: `${heading}\n→ [[projects/${slug}/hot]]` };
}

/**
 * The form of a log.md line that rootLogEntry's exact-line dedup compares. Earlier
 * versions wrote an em dash after the slug; this one writes `## [d] session | slug: title`. A
 * log.md that already carries the old heading must count as having the entry, or
 * the next derive appends the same session a second time. Only the separator right
 * after the slug is rewritten, so every other line is returned as it came.
 */
export function rootLogHeadingKey(line) {
  return String(line).replace(/^(## \[[^\]]*\] session \| [^\s:]+) — /, '$1: ');
}

/**
 * Append any missing root log.md `## [date] session | <slug>` entries derived from
 * each today-active project's session-log heading(s). Idempotent: dedups on the
 * exact generated heading line, so re-running (or a same-day apply that already
 * wrote the entry) is a no-op, and multiple same-day sessions each get their own
 * entry. Best-effort and read-mostly: returns the number of entries appended.
 *
 * @param {string} hypoDir
 * @returns {number} count of entries appended to log.md
 */
// ── append-only file lock ───────────────────────────────────────────────────
// Serializes the read → dedup → rebuild → temp+rename sequence on append-only
// history files (session-log shards, log.md) so two concurrent session closes
// never lose an entry. The lock does NOT replace the existing write-isolation:
// each writer still rebuilds the full content and commits via atomicWrite
// (temp write + rename), so a partial write lands on a throwaway temp and the
// target is never torn. The lock only makes the read-modify-write exclusive, so
// the second closer re-reads the first's committed bytes and appends onto them
// (last-writer-wins can no longer drop the earlier entry), and exact-entry dedup
// becomes precise rather than best-effort.
//
// Why not O_APPEND: an in-place append that short-writes (ENOSPC / EDQUOT /
// RLIMIT_FSIZE / a split write() killed mid-loop) leaves a torn dated heading on
// the real file that the freshness gate mis-reads as valid close evidence, and
// it cannot be rolled back once a concurrent appender has written past it. That
// is a normal-operation regression temp+rename does not have (a failed temp
// write never runs the rename, so the target stays untouched). Confirmed against
// Node/libuv write-loop behavior and POSIX write(2) partial-write semantics.
//
// Local-FS only: `openSync(lock, 'wx')` is not atomic on NFS — the same caveat
// the vault already carries. Power-loss durability is unchanged from today
// (atomicWrite never fsync'd), so it is out of scope here.
function sleepSync(ms) {
  // Synchronous sleep with no busy-spin: block this thread on an Atomics.wait
  // against a private SharedArrayBuffer that is never signaled, so it always
  // times out after `ms`. Hooks run in a short-lived sync context.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
}

// Commit via temp write + rename now lives in ./atomic-write.mjs, imported
// above as `atomicWrite`. It used to be a local copy here (`atomicWriteShared`)
// that only cleaned up the tmp file on a rename failure; the shared version
// also cleans up on a write failure. See that file's own doc comment.

// Read the pid the current holder recorded in its lockfile (see withFileLock).
// Returns null for anything we can't trust as a pid: empty/missing content (a
// lock written before this pid-recording existed, or already gone), or content
// that doesn't parse as a positive integer. null means "unknown holder" and the
// caller falls back to the pre-liveness, mtime-only steal rule.
function readLockHolderPid(lockPath) {
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf-8').trim();
  } catch {
    return null; // vanished/unreadable mid-check — let the caller's own catch handle it
  }
  // Canonical decimal only. `Number()` would accept '1e3' and '0x10' as pids,
  // which contradicts what this function promises its callers: anything we
  // can't trust is null, not a number we guessed at.
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) ? pid : null;
}

// Is `pid` still running? EPERM means it exists but we can't signal it (e.g. a
// different user) — treat that as alive too, since "can't prove it's dead" must
// not be steal-eligible.
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Is this porcelain record a file `withFileLock` leaves on disk while a close works: the lock
 * itself (`<target>.lock`) or a waiter's staging file (`<target>.lock.<16 hex>.tmp`, present
 * for the whole wait)? Both are transient and untracked, and a vault's `.gitignore` may not
 * list either (an old vault lacks `*.lock`, the maintainer's does not ignore the staging
 * file), so the dirty-tree judgments (`hypoIsClean`, `gitDirtyFiles`, and the SessionStart
 * and resume copies) skip them rather than let one close's lock read as another close's
 * uncommitted work. Only the two files a close locks inside the tracked tree qualify: the
 * root `log.md` and a project's `session-log/<file>.md` shard (every other lock a close
 * takes lives under the gitignored `.cache/`). A person's own untracked `notes.md.lock` or
 * `pages/x.lock` stays dirty, and so does a tracked `*.lock` file that is edited, renamed or
 * deleted (only an untracked record, `??`, can be an artifact).
 * The one rule all four callers share. Matches on the vault-relative path.
 * @param {string} xy the two-character porcelain status of the record
 * @param {string} path
 */
export function isUntrackedLockArtifact(xy, path) {
  return xy === '??' && CLOSE_LOCK_ARTIFACT.test(path);
}

const CLOSE_LOCK_ARTIFACT =
  /^(?:log\.md|projects\/[^/]+\/session-log\/[^/]+\.md)\.lock(?:\.[0-9a-f]{16}\.tmp)?$/;

/**
 * Run `fn` while holding an exclusive lock on `<targetPath>.lock`.
 *
 * Acquire is a spin on `linkSync(tmp, lock)`, where `tmp` already holds this
 * process's pid in full: EEXIST means another writer holds it, so poll until it
 * frees. Linking a complete file is what makes the lock's content trustworthy —
 * a lock is never observable in a half-written state, so "no pid in there" always
 * means a genuine pre-liveness lockfile and never a holder mid-acquire. The lock
 * file's content is therefore the holder's own pid,
 * so a lock whose mtime is older than `staleMs` is only stolen once we can also
 * confirm the recorded holder is no longer running (`process.kill(pid, 0)`). A
 * LIVE holder preempted past `staleMs` is therefore left alone — its lock is not
 * stolen, so the second writer instead polls through to `timeoutMs` and throws,
 * falling back to the write=proposal gate instead of racing the live holder's
 * critical section (this was case (1) of the old mtime-only rule, and it's what
 * closes it). A lock with no readable/parseable pid (written before this
 * recording existed) falls back to the old mtime-only rule so pre-existing
 * lockfiles from a live process on disk still get treated as steal-eligible once
 * stale — see `readLockHolderPid`. Every steal, and every steal we refuse because
 * the holder is alive, is logged to stderr so a preemption or an actual steal is
 * never silent. One edge remains, unrelated to holder liveness: between the
 * stale `statSync` and the `unlinkSync`, the holder can release and a fresh
 * holder grab the same path, whose lock we then remove — `staleMs` is set well
 * above a normal close (seconds) to make that extreme-low-probability, and it is
 * out of scope here. Release is symmetric: we only unlink the lock while it still
 * records OUR pid, so a writer that WAS stolen from never removes the lock of the
 * holder that replaced it. If the lock cannot be acquired within `timeoutMs`,
 * throw so the caller can fall back to the write=proposal gate — for an append
 * that means blocking the close (proposal-pending) with no artifact; the next
 * close re-appends (architecturally consistent with the existing fail-safe).
 *
 * Note what refusing to steal from a live holder trades away: a holder that is
 * alive but permanently hung is now never stolen from, so every later close
 * times out too. That is availability loss, not a deadlock (`timeoutMs` still
 * bounds each attempt), but unlike an ordinary lock timeout it does NOT self-heal
 * on the next close — it needs the hung process to go away. Losing an append is
 * silent; blocking one is visible, so this is the direction to fail in.
 *
 * @param {string} targetPath file being guarded (lock is a sibling `.lock`)
 * @param {() => T} fn critical section
 * @param {{timeoutMs?: number, staleMs?: number, pollMs?: number}} [opts]
 * @returns {T} whatever `fn` returns
 * @template T
 */
export function withFileLock(targetPath, fn, opts = {}) {
  const { timeoutMs = 5000, staleMs = 30000, pollMs = 50 } = opts;
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  // Publish the lock ATOMICALLY: write the whole pid into a private sibling
  // first, then `linkSync` it into place. `openSync(lockPath,'wx')` followed by
  // a write cannot do this — it publishes an EMPTY lock and fills it in after,
  // and a holder preempted inside that window looks exactly like a pid-less
  // legacy lock, so a second writer steals it and both run the critical section.
  // That is the very bug the liveness check exists to close, so the acquire has
  // to be atomic for the check to mean anything. `link` also gives us the same
  // EEXIST-if-taken primitive `wx` did, and it leaves nothing behind when the
  // write fails: no link, no lock.
  // The staging name is per-call random, and the staging write is exclusive.
  // A predictable `<lock>.<pid>.tmp` would be reachable again by a later run of
  // the same pid, and a crash between the link and the staging unlink leaves tmp
  // and lock as two names for ONE inode — writing the staging file would then
  // rewrite the live lock's bytes and mtime, resurrecting a dead lock under a
  // live pid that the liveness check would then protect. Random + `wx` removes
  // both the collision and the symlink it could otherwise be pointed through.
  const tmpPath = `${lockPath}.${randomBytes(8).toString('hex')}.tmp`;
  let staged = false;
  // The live-holder refusal is re-evaluated on every poll, but it is one event,
  // not `timeoutMs / pollMs` of them. Log each once per acquire or a single
  // preemption buries the hook's stderr under ~100 identical lines.
  let loggedLiveHolder = false;
  let loggedSteal = false;
  try {
    for (;;) {
      try {
        if (!staged) {
          try {
            writeFileSync(tmpPath, String(process.pid), { flag: 'wx' });
            staged = true;
          } catch (stageErr) {
            // Staging fails for the same reason acquisition does — an unwritable
            // directory — and `openSync(lock,'wx')` used to report exactly that as
            // EEXIST whenever a lock was already sitting there, sending it down the
            // contention path. Preserve that: contend if a lock exists, and surface
            // a genuine write failure otherwise rather than masking it as a timeout.
            if (!existsSync(lockPath)) throw stageErr;
            throw Object.assign(new Error('lock-contended'), { code: 'EEXIST' });
          }
        }
        // Kept separate from staging on purpose: EPERM/EMLINK from the link are
        // real failures, not contention, and must not decay into ELOCKTIMEOUT.
        linkSync(tmpPath, lockPath);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Held by another writer. Steal ONLY a demonstrably stale lock; otherwise
        // wait and eventually time out. The stat and the unlink are handled
        // separately on purpose: an un-removable stale lock (EACCES/EPERM/EBUSY)
        // and a fresh lock must both fall through to the timeout check — never
        // `continue` past it, or an un-unlinkable lock spins forever and violates
        // the timeoutMs → ELOCKTIMEOUT contract (caller falls to the proposal gate).
        let stale = false;
        try {
          // Steal-eligible by age alone; liveness is checked separately below
          // before we actually act on it.
          stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
        } catch (statErr) {
          if (statErr.code === 'ENOENT') continue; // lock vanished; retry create now
          throw statErr; // unexpected stat failure — surface it, don't mask
        }
        if (stale) {
          const holderPid = readLockHolderPid(lockPath);
          if (holderPid !== null && isPidAlive(holderPid)) {
            // LIVE holder preempted past staleMs: do NOT steal. Surface it so the
            // preemption is visible, then fall through to the poll/timeout path
            // below instead of racing a second writer into the critical section.
            if (!loggedLiveHolder) {
              console.error(
                `[hypomnema] withFileLock: NOT stealing ${lockPath} — holder pid ${holderPid} is still alive past staleMs=${staleMs}`,
              );
              loggedLiveHolder = true;
            }
            stale = false;
          } else if (!loggedSteal) {
            // Also once per acquire: an un-removable stale lock re-enters this
            // branch on every poll, and the steal is one event either way.
            console.error(
              `[hypomnema] withFileLock: stealing stale lock ${lockPath}` +
                (holderPid !== null
                  ? ` (holder pid ${holderPid} is no longer running)`
                  : ' (no readable holder pid — pre-liveness lockfile)'),
            );
            loggedSteal = true;
          }
        }
        if (stale) {
          try {
            unlinkSync(lockPath);
            continue; // stole it; retry the create immediately
          } catch (unlinkErr) {
            if (unlinkErr.code === 'ENOENT') continue; // another stealer won; retry
            // Cannot remove it: do NOT spin — fall through to timeout/sleep so
            // acquisition eventually throws ELOCKTIMEOUT instead of hanging.
          }
        }
        if (Date.now() - start > timeoutMs) {
          // Tagged so callers can distinguish "could not get the lock" (fall to the
          // proposal gate) from a real fn() write error (mkdir/openSync/disk-full),
          // which must NOT be masked as a timeout.
          const e = new Error(`lock-timeout: ${lockPath}`);
          e.code = 'ELOCKTIMEOUT';
          throw e;
        }
        sleepSync(pollMs);
      }
    }
  } finally {
    // The sibling is only ever a staging file: once linked, the lock IS the
    // link, and on every failure path it must not survive as litter.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* never created, or already gone */
    }
  }
  try {
    return fn();
  } finally {
    // Only remove the lock if it is still OURS. Recording the pid makes this
    // checkable: if we were stolen from (a legacy pid-less lock of ours, or the
    // stat/unlink window below), the path now holds a DIFFERENT holder's lock and
    // unlinking it unconditionally would hand a third writer the critical section
    // while that holder is still inside it. Leaving a foreign lock alone costs
    // nothing — its own holder releases it, or it goes stale.
    try {
      const stillOurs = readLockHolderPid(lockPath);
      if (stillOurs === process.pid) unlinkSync(lockPath);
      else if (existsSync(lockPath))
        console.error(
          `[hypomnema] withFileLock: not releasing ${lockPath} — it now holds ${
            stillOurs === null ? 'no readable pid' : `pid ${stillOurs}`
          }, so ours was stolen`,
        );
    } catch {
      /* lock already stolen/removed */
    }
  }
}

export function deriveRootLogEntries(hypoDir) {
  const logPath = join(hypoDir, 'log.md');
  if (!existsSync(logPath)) return 0;
  const dates = freshDates();
  const todayActive = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );
  if (todayActive.length === 0) return 0;

  let logContent;
  try {
    logContent = readFileSync(logPath, 'utf-8');
  } catch {
    return 0;
  }

  // Exact-LINE dedup: a titleless heading (`## [d] session | a`) is a substring/
  // prefix of a titled one (`## [d] session | a: first`), so substring checks
  // would wrongly drop a distinct same-day session. Track whole heading lines,
  // with an old em dash heading read as its colon form.
  const seenHeadings = new Set((logContent || '').split(/\r?\n/).map(rootLogHeadingKey));
  const additions = [];
  for (const slug of todayActive) {
    // Guard: only the log.md entry may be the gap; an otherwise-incomplete close
    // must keep blocking (do not mask missing authored files).
    const st = sessionCloseFileStatus(hypoDir, { scope: 'global', projectOverride: slug });
    const problems = [...st.stale, ...st.missing];
    if (!(problems.length === 1 && problems[0] === 'log.md')) continue;

    for (const date of dates) {
      // Pick the candidate that actually CARRIES this date's heading (daily shard
      // preferred), mirroring the freshness gate's resolution. Selecting merely
      // the first *existing* file would diverge from freshness: a header-only
      // daily shard (e.g. a seeded-but-not-yet-appended file) would be chosen and
      // the real heading in the legacy monthly fallback missed — freshness would
      // pass while derive failed to recover the log.md entry.
      let slog = null;
      for (const rel of sessionLogReadCandidates(slug, date)) {
        const slogPath = join(hypoDir, rel);
        if (!existsSync(slogPath)) continue;
        let content;
        try {
          content = readFileSync(slogPath, 'utf-8');
        } catch {
          continue;
        }
        if (!hasSessionLogHeading(content, date)) continue;
        slog = content;
        break;
      }
      if (slog === null) continue;
      const headingRe = new RegExp('^#{1,6} \\[' + escapeRegExp(date) + '\\]\\s*(.*)$', 'gm');
      let m;
      while ((m = headingRe.exec(slog)) !== null) {
        const { heading, block } = rootLogEntry(slug, date, m[1]);
        if (seenHeadings.has(heading)) continue; // exact-line dedup (log.md + queued)
        seenHeadings.add(heading);
        additions.push({ heading, block });
      }
    }
  }

  if (additions.length === 0) return 0;

  // Serialize the read-modify-write on log.md: a concurrent session close (its
  // own crystallize apply, or another project's derive) may commit between the
  // read above and the write below. Under the lock we RE-READ the latest
  // committed log.md and re-run exact-heading dedup, so this derive appends onto
  // the other writer's entry instead of a full-file overwrite dropping it. The
  // same lock guards crystallize.mjs's per-close log.md append, so the two
  // paths never race. On lock-timeout, skip (best-effort backfill; the next
  // close re-derives) rather than risk a lost update.
  try {
    return withFileLock(logPath, () => {
      let current;
      try {
        current = readFileSync(logPath, 'utf-8');
      } catch {
        return 0;
      }
      const seen = new Set((current || '').split(/\r?\n/).map(rootLogHeadingKey));
      const fresh = additions.filter(({ heading }) => {
        if (seen.has(heading)) return false;
        seen.add(heading);
        return true;
      });
      if (fresh.length === 0) return 0;
      const sep = current.endsWith('\n') ? '\n' : '\n\n';
      atomicWrite(logPath, current + sep + fresh.map((a) => a.block).join('\n\n') + '\n');
      return fresh.length;
    });
  } catch {
    // lock-timeout or unexpected lock error: skip this backfill pass.
    return 0;
  }
}

// ── sync-state ────────────────────────────────────────────
// `.cache/sync-state.json` is JSONL: one {timestamp, op, error, host} entry per
// line. hypo-auto-commit appends on pull/push failure; hypo-session-start
// surfaces open entries and clears them once sync is healthy again;
// doctor warns while entries remain. Keep the schema defined here only.

/** @returns {string} path to the sync-state JSONL file for a wiki root. */
function syncStatePath(hypoDir) {
  return join(hypoDir, '.cache', 'sync-state.json');
}

/**
 * Classify a sync-state `op` into the guidance branch it needs. Centralized
 * here — rather than each surface repeating its own string check — because
 * hypo-session-start.mjs's syncStateNotice and doctor.mjs's checkSyncState
 * used to each carry their own comparison, and drifted: session-start's
 * exact `=== 'conflict'` check silently missed 'conflict-unresolved' (the
 * MORE dangerous op, since the abort itself failed and the tree may still be
 * half-merged) and fell through to the generic "last sync failed" line,
 * while doctor's `startsWith('conflict')` already caught it. Both
 * callers now branch on this single function's return value, so they cannot
 * silently diverge on WHICH op gets which treatment again — only on the
 * prose each renders for a given branch.
 *
 * Both known ops are matched by EXACT string, not startsWith: a future
 * `conflict-*` value this function has never seen (e.g. a new syncRemote
 * failure mode added later) must not silently fall into either known
 * bucket. 'conflict' asserts the abort succeeded and local work is safely
 * committed; 'conflict-unresolved' asserts the abort itself failed. Neither
 * claim is known to hold for an op nobody has written a branch for yet, so
 * it gets its own conservative 'unknown-conflict' bucket instead of
 * inheriting either surface's reassurance by accident.
 *
 * @param {string} op
 * @returns {'conflict-unresolved'|'conflict'|'unknown-conflict'|'other'}
 */
export function classifySyncOp(op) {
  const s = String(op || '');
  if (s === 'conflict-unresolved') return 'conflict-unresolved';
  if (s === 'conflict') return 'conflict';
  if (s.startsWith('conflict')) return 'unknown-conflict';
  return 'other';
}

/**
 * The short text a sync failure record keeps from git's stderr. The first non-empty line is not
 * enough: a refused merge says "would be overwritten by merge" and lists the paths on the lines
 * after it, and a refused push opens with `To <url>`, with the rejection two lines further down.
 * Both are kept here (the blocking paths, `non-fast-forward`), capped so a record stays one line.
 *
 * @param {unknown} error raw stderr/stdout
 * @returns {string}
 */
export function summarizeSyncError(error) {
  const lines = String(error || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = (lines[0] || 'unknown error').slice(0, 200);
  const blocked = lines.findIndex((l) => /would be overwritten by (merge|checkout)/i.test(l));
  if (blocked >= 0) {
    const paths = [];
    for (const l of lines.slice(blocked + 1)) {
      if (/^(please|aborting|error:|hint:)/i.test(l)) break;
      paths.push(l);
    }
    if (paths.length) {
      const shown = paths.slice(0, 5).join(', ');
      const more = paths.length > 5 ? ` (+${paths.length - 5} more)` : '';
      return `${lines[blocked].slice(0, 120)} ${shown}${more}`.slice(0, 400);
    }
    return lines[blocked].slice(0, 200);
  }
  const rejected = lines.find((l) =>
    /\[(remote )?rejected\]|non-fast-forward|fetch first/i.test(l),
  );
  if (rejected) {
    const behind = /non-fast-forward|fetch first/i.test(rejected);
    return `push rejected${behind ? ' as non-fast-forward (the remote moved)' : ''}: ${rejected}`.slice(
      0,
      300,
    );
  }
  return first;
}

/**
 * Append a sync failure entry. Best-effort — never throws, since a failed
 * failure-log must not break the Stop hook that calls it.
 *
 * @param {string} hypoDir
 * @param {'pull'|'push'|'conflict'|'conflict-unresolved'} op  'conflict' = a
 *   merge conflict was detected and aborted (the tree was left clean at the
 *   local commit); 'conflict-unresolved' = the abort itself failed and the tree
 *   may still be half-merged (rare). See syncRemote.
 * @param {string} error  raw stderr/stdout; kept as `summarizeSyncError` shortens it
 */
export function appendSyncFailure(hypoDir, op, error) {
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(),
      op,
      error: summarizeSyncError(error),
      host: hostname(),
    };
    appendFileSync(syncStatePath(hypoDir), JSON.stringify(entry) + '\n');
  } catch {
    // best-effort
  }
}

const syncGit = (hypoDir, ...args) =>
  spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', timeout: 30000 });

// ── resolving a sync conflict (pullRemote) ───────────────────────────────────
// A pull that stops on a conflict Hypomnema can settle without a person is finished here: a
// generated view path with a modify/delete conflict (an old install changed a view the migration
// untracked) and a `.gitignore` both sides only added lines to. Everything else is aborted as
// before. The caller holds the vault commit lock (the lock is not reentrant, so nothing here takes it).

// The two merge records live under the git directory, never in the vault tree. A vault whose
// `.gitignore` lacks `.cache/` would otherwise get no record at all, and a merge a killed run left
// open would stay unrecognized for good. Git never stages anything under its own directory.
// `--absolute-git-dir` is this worktree's own directory (`.git/worktrees/<name>` in a linked
// worktree, where `MERGE_HEAD` lives too); `--git-path` would send a name git does not know to the
// directory every worktree shares, and two worktrees would overwrite each other's record.
const MERGE_OWNED_FILE = 'hypo-merge-owned.json';
const MERGE_INTENT_FILE = 'hypo-merge-intent.json';

/** Absolute path of `name` under the vault's git directory, or `null` when git cannot say. */
function gitDirFile(hypoDir, name) {
  const r = vaultGit(hypoDir, ['rev-parse', '--absolute-git-dir']);
  const dir = r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : '';
  return dir ? join(dir, name) : null;
}

function readGitDirJson(hypoDir, name) {
  try {
    return JSON.parse(readFileSync(gitDirFile(hypoDir, name), 'utf-8'));
  } catch {
    return null;
  }
}

function writeGitDirJson(hypoDir, name, rec, pretty = false) {
  const path = gitDirFile(hypoDir, name);
  if (!path) throw new Error('git directory unknown');
  atomicWrite(path, `${JSON.stringify(rec, null, pretty ? 2 : 0)}\n`, { durable: true });
}

function removeGitDirFile(hypoDir, name) {
  try {
    const path = gitDirFile(hypoDir, name);
    if (path) rmSync(path, { force: true });
  } catch {
    // best-effort: a leftover record only counts while a `MERGE_HEAD` it names is open
  }
}

// `hypo-merge-owned.json`: {v: 1, mergeHead, indexDigest, resolvedPaths: [{relPath, kind:
// 'modify-delete'|'gitignore', backupPath?, backupSha256?, mergedSha256?}]}. Written before the
// first resolving git command, and again with `indexDigest` (sha256 of `git ls-files -s`) once the
// resolution is applied, so a merge left open by a killed run can be told from one a person started.
function readMergeOwned(hypoDir) {
  const rec = readGitDirJson(hypoDir, MERGE_OWNED_FILE);
  const ok =
    rec?.v === 1 &&
    typeof rec.mergeHead === 'string' &&
    Array.isArray(rec.resolvedPaths) &&
    (rec.indexDigest === null || typeof rec.indexDigest === 'string');
  return ok ? rec : null;
}

const writeMergeOwned = (hypoDir, rec) => writeGitDirJson(hypoDir, MERGE_OWNED_FILE, rec, true);
const clearMergeOwned = (hypoDir) => removeGitDirFile(hypoDir, MERGE_OWNED_FILE);

// `hypo-merge-intent.json`: {v: 1, phase: 'pull', head, target, fingerprint?}. Written (durably) just
// before the merge command runs, which is whenever HEAD is behind the upstream (git may
// fast-forward), so a `MERGE_HEAD` a killed run left with no resolution record can be told from one
// a person opened: it names the HEAD and the upstream commit this run was about to merge.
// `fingerprint` ({index, files}) is added right after the merge command returned with a merge
// open: the sha256 of `git ls-files -s` and of each unmerged worktree file at that moment. The
// intent alone only proves which merge started; the fingerprint is what proves nobody has touched
// it since (a person's staged resolution changes it). It is deleted once no `MERGE_HEAD` is left.
function readMergeIntent(hypoDir) {
  const rec = readGitDirJson(hypoDir, MERGE_INTENT_FILE);
  const ok =
    rec?.v === 1 &&
    rec.phase === 'pull' &&
    typeof rec.head === 'string' &&
    typeof rec.target === 'string';
  return ok ? rec : null;
}

const clearMergeIntent = (hypoDir) => removeGitDirFile(hypoDir, MERGE_INTENT_FILE);

const mergeIntentExists = (hypoDir) => {
  const path = gitDirFile(hypoDir, MERGE_INTENT_FILE);
  return path !== null && existsSync(path);
};

function fileSha256OrNull(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * `{index, files: {relPath: sha256|null}}` for the merge now open: the index digest and the worktree
 * bytes of every unmerged path. `null` when git cannot give the index digest.
 */
function mergeFingerprint(hypoDir, unmergedPaths) {
  const index = indexDigestOf(hypoDir);
  if (index === null) return null;
  const files = {};
  for (const relPath of [...unmergedPaths].sort()) {
    files[relPath] = fileSha256OrNull(join(hypoDir, relPath));
  }
  return { index, files };
}

const sameFingerprint = (a, b) =>
  a !== null &&
  b !== null &&
  typeof a === 'object' &&
  typeof b === 'object' &&
  a.index === b.index &&
  JSON.stringify(a.files) === JSON.stringify(b.files);

/** Record the post-merge fingerprint in the intent (a kill before this leaves the merge to a person). */
function recordMergeFingerprint(hypoDir, unmergedPaths) {
  try {
    const intent = readMergeIntent(hypoDir);
    const fingerprint = intent && mergeFingerprint(hypoDir, unmergedPaths);
    if (intent && fingerprint) {
      writeGitDirJson(hypoDir, MERGE_INTENT_FILE, { ...intent, fingerprint });
    }
  } catch {
    // no fingerprint: the merge is then left to a person
  }
}

/** `{state: 'present', sha}`, `{state: 'absent'}` or `{state: 'error'}` for `MERGE_HEAD`. */
function mergeHeadState(hypoDir) {
  const r = vaultGit(hypoDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (r.status === 0) return { state: 'present', sha: r.stdout.trim() };
  return { state: r.status === 1 ? 'absent' : 'error' };
}

function indexDigestOf(hypoDir) {
  const r = vaultGit(hypoDir, ['ls-files', '-s']);
  return r.status === 0 ? sha256Hex(r.stdout) : null;
}

/** `Map<path, Set<stage>>` of the unmerged index entries, or `null` when git cannot answer. */
function unmergedEntries(hypoDir) {
  const r = vaultGit(hypoDir, ['ls-files', '-u', '-z']);
  if (r.status !== 0) return null;
  const byPath = new Map();
  for (const rec of r.stdout.split('\0').filter(Boolean)) {
    const m = /^\d+ [0-9a-f]+ ([123])\t([\s\S]*)$/.exec(rec);
    if (!m) return null;
    byPath.set(m[2], (byPath.get(m[2]) ?? new Set()).add(Number(m[1])));
  }
  return byPath;
}

/**
 * Is the vault repo in the middle of a git operation a person has to finish first?
 * Returns `null` when it is not (or git cannot answer), else `{state, detail}` where `state` is
 * `merge`, `rebase`, `am`, `cherry-pick`, `revert` or `unmerged` and `detail` is a plain sentence naming
 * what to do. A commit that names paths (`--only`) fails during any of these, so a writer that
 * commits has to refuse before it writes.
 */
export function vaultOperationInProgress(hypoDir) {
  const gitPathExists = (name) => {
    const r = vaultGit(hypoDir, ['rev-parse', '--git-path', name]);
    const p = r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : '';
    return p ? existsSync(resolvePath(hypoDir, p)) : false;
  };
  const refExists = (name) => vaultGit(hypoDir, ['rev-parse', '-q', '--verify', name]).status === 0;
  const unfinished = (what, finish, abort) =>
    `${what} is unfinished: finish it (${finish}) or abort it (${abort})`;
  if (refExists('MERGE_HEAD')) {
    return { state: 'merge', detail: unfinished('a merge', 'git commit', 'git merge --abort') };
  }
  // `git am` keeps its state in `rebase-apply/` too; only its `applying` file tells it from a rebase,
  // and `git rebase --continue` refuses while an am is in progress.
  if (gitPathExists('rebase-apply/applying')) {
    return {
      state: 'am',
      detail: unfinished('a git am', 'git am --continue', 'git am --abort'),
    };
  }
  if (gitPathExists('rebase-merge') || gitPathExists('rebase-apply')) {
    return {
      state: 'rebase',
      detail: unfinished('a rebase', 'git rebase --continue', 'git rebase --abort'),
    };
  }
  if (refExists('CHERRY_PICK_HEAD')) {
    return {
      state: 'cherry-pick',
      detail: unfinished('a cherry-pick', 'git cherry-pick --continue', 'git cherry-pick --abort'),
    };
  }
  if (refExists('REVERT_HEAD')) {
    return {
      state: 'revert',
      detail: unfinished('a revert', 'git revert --continue', 'git revert --abort'),
    };
  }
  const unmerged = unmergedEntries(hypoDir);
  if (unmerged && unmerged.size > 0) {
    const first = [...unmerged.keys()].slice(0, 3).join(', ');
    return {
      state: 'unmerged',
      detail: `${unmerged.size} path(s) have unresolved conflicts (${first}): resolve and stage them, or abort the operation that left them`,
    };
  }
  return null;
}

/**
 * Settle the open conflict when every unmerged path is one of the two kinds Hypomnema resolves:
 * (a) a generated view path that one side modified and the other deleted (stages 1+2 or 1+3), or
 * (b) `.gitignore` with all three stages where `mergeAdditiveGitignore(:1, :2, :3)` is `ok`.
 * (a) backs the modified side's stage up (whichever side it is), lists it in the pull archive for
 * `shareLegacyBytes`, and removes the path from the index; (b) writes and stages the merged bytes.
 * The merge commit is not made here (`finishOwnedMerge` does it). Returns `{ok, notices, rollback}`;
 * `ok: false` means nothing was resolved and the records it wrote are taken back (the backups stay),
 * so the caller aborts the merge as it always did. `rollback` takes the records back after a later
 * failure. `testHooks.beforeBackupWrite` goes to the backups.
 */
function resolveSyncConflict(hypoDir, byPath, { testHooks } = {}) {
  const plan = [];
  for (const [relPath, stages] of byPath) {
    const key = [...stages].sort().join('');
    if (isGeneratedViewPath(relPath) && (key === '12' || key === '13')) {
      plan.push({ kind: 'modify-delete', relPath, stage: key === '12' ? 2 : 3 });
    } else if (relPath === '.gitignore' && key === '123') {
      const [base, ours, theirs] = [1, 2, 3].map((n) => gitShowText(hypoDir, `:${n}`, relPath));
      if ([base, ours, theirs].includes(null)) return { ok: false, notices: [] };
      const merged = mergeAdditiveGitignore(base, ours, theirs);
      if (!merged.ok) return { ok: false, notices: [] };
      plan.push({ kind: 'gitignore', relPath, merged: merged.merged });
    } else {
      return { ok: false, notices: [] };
    }
  }
  if (!plan.length) return { ok: false, notices: [] };
  // The backups and the pull archive go under `.cache/`: write none of them while `git add -A` would stage them.
  const unignored = unignoredCachePaths(hypoDir);
  if (unignored.length) return { ok: false, notices: [cacheNotIgnoredNotice(unignored)] };
  const merge = mergeHeadState(hypoDir);
  const head = gitOut(hypoDir, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
  if (merge.state !== 'present' || !head) return { ok: false, notices: [] };

  const archivePath = join(hypoDir, PULL_ARCHIVE_REL);
  let priorRaw = null;
  try {
    priorRaw = readTextOrNull(archivePath);
  } catch {
    return { ok: false, notices: [] };
  }
  const rollback = () => {
    clearMergeOwned(hypoDir);
    try {
      if (priorRaw === null) rmSync(archivePath, { force: true });
      else atomicWrite(archivePath, priorRaw);
    } catch {
      // the record then still names backups that exist: the next catch-up carries it
    }
  };
  try {
    const prior = readPullArchive(hypoDir);
    // One state of the machine per run: these versions are committed ones, not the dirty files of an
    // earlier clearing run, so they pair up among themselves.
    const run = Math.max(0, ...(prior?.views ?? []).map((v) => v.run ?? 0)) + 1;
    const views = [];
    const resolvedPaths = [];
    for (const item of plan) {
      if (item.kind === 'gitignore') {
        resolvedPaths.push({
          relPath: item.relPath,
          kind: 'gitignore',
          mergedSha256: sha256Hex(item.merged),
        });
        continue;
      }
      const bytes = gitShowText(hypoDir, `:${item.stage}`, item.relPath);
      if (bytes === null) throw new Error(`stage ${item.stage} of ${item.relPath} is unreadable`);
      const backupPath = backUpGeneratedPath(
        hypoDir,
        join(hypoDir, item.relPath),
        bytes,
        testHooks,
      );
      const sha256 = sha256Hex(bytes);
      // Stage 2 is ours: the other side (theirs) deleted, so its tree has nothing and the companion
      // file comes from our pre-merge HEAD. Stage 3 is theirs: the companion comes from MERGE_HEAD.
      // Both are commit ids, because the name `MERGE_HEAD` is gone once the merge commit exists.
      const companionRev = item.stage === 2 ? head : merge.sha;
      views.push({
        relPath: item.relPath,
        kind: 'worktree',
        backupPath,
        sha256,
        companionRev,
        run,
      });
      resolvedPaths.push({
        relPath: item.relPath,
        kind: 'modify-delete',
        backupPath,
        backupSha256: sha256,
      });
    }
    if (views.length) {
      writePullArchive(hypoDir, {
        v: 2,
        stage: 'archived',
        targetSha: merge.sha,
        gitignoreLines: prior?.gitignoreLines ?? [],
        views: mergeViews(prior?.views ?? [], views),
        localOnly: prior?.localOnly ?? [],
        unowned: prior?.unowned ?? [],
        cleared: prior?.cleared ?? [],
        gitignoreSaved: prior?.gitignoreSaved ?? [],
      });
    }
    const owned = { v: 1, mergeHead: merge.sha, indexDigest: null, resolvedPaths };
    writeMergeOwned(hypoDir, owned);

    const removals = plan.filter((p) => p.kind === 'modify-delete').map((p) => p.relPath);
    if (
      removals.length &&
      vaultGit(hypoDir, ['rm', '--cached', '-q', '--', ...literalSpecs(removals)]).status !== 0
    ) {
      throw new Error('git rm --cached failed');
    }
    for (const item of plan.filter((p) => p.kind === 'gitignore')) {
      atomicWrite(join(hypoDir, item.relPath), item.merged);
      if (vaultGit(hypoDir, ['add', '--', ...literalSpecs([item.relPath])]).status !== 0) {
        throw new Error('git add .gitignore failed');
      }
    }
    if (unmergedEntries(hypoDir)?.size !== 0) throw new Error('unmerged paths remain');
    const indexDigest = indexDigestOf(hypoDir);
    if (indexDigest === null) throw new Error('index digest unreadable');
    writeMergeOwned(hypoDir, { ...owned, indexDigest });
  } catch {
    rollback();
    return { ok: false, notices: [] };
  }
  return { ok: true, notices: [], rollback };
}

/**
 * Finish a merge Hypomnema started and a killed run left open: `MERGE_HEAD` exists and
 * the owned record (`hypo-merge-owned.json` in the git directory) names it. Called first in `pullRemote`. Returns `{state, notices}`:
 *   - `'none'`: no merge is open (a leftover owned record is deleted). Carry on with the sync.
 *   - `'finished'`: the merge commit was made, the archived bytes were shared (`resumePullArchive`)
 *     and the owned record was deleted.
 *   - `'external'`: a merge is open that this code did not start (no record, or one that names
 *     another `MERGE_HEAD`: a person, `git pull`, Obsidian Git). Nothing is touched.
 *   - `'stuck'`: it is ours but is not safe to finish, and nothing is touched: the index has
 *     entries the resolution did not stage (`indexDigest` differs), an unmerged path remains, a
 *     recorded backup is gone or changed, the merged `.gitignore` is not what was recorded, a view
 *     is still in the index, or the commit failed.
 * The index digest check is what keeps `git commit --no-edit` from sweeping a path another session
 * staged in between into the merge commit.
 */
export function finishOwnedMerge(hypoDir) {
  const owned = readMergeOwned(hypoDir);
  const merge = mergeHeadState(hypoDir);
  if (merge.state === 'error') {
    return {
      state: 'external',
      notices: ['git이 진행 중인 merge 여부를 답하지 못해 동기화를 건너뛰었습니다.'],
    };
  }
  if (merge.state === 'absent') {
    if (owned) clearMergeOwned(hypoDir);
    clearMergeIntent(hypoDir);
    return { state: 'none', notices: [] };
  }
  if (!owned || owned.mergeHead !== merge.sha) {
    // A pull of ours that was killed after the merge started and before any resolution record: the
    // intent names this very HEAD and `MERGE_HEAD`, and its fingerprint says the merge is still as
    // the merge command left it. Only then is it taken back, as the old code did. A merge that
    // differs from the fingerprint holds somebody's work (a staged resolution), so it stays.
    // ponytail: a person who merges the same upstream commit by hand at the same HEAD while a
    // stale intent exists would not match the fingerprint either; a kill between the merge command
    // and the fingerprint write leaves an untouched merge to a person, who gets the notice below.
    const intent = readMergeIntent(hypoDir);
    const head = gitOut(hypoDir, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
    if (intent && intent.target === merge.sha && intent.head === head) {
      const unmerged = unmergedEntries(hypoDir);
      const untouched =
        unmerged !== null &&
        sameFingerprint(intent.fingerprint ?? null, mergeFingerprint(hypoDir, unmerged.keys()));
      if (!untouched) {
        return {
          state: 'external',
          notices: [
            intent.fingerprint
              ? '끊긴 동기화가 남긴 merge에 사람이 해소한 내용이나 스테이징한 변경이 있어 그대로 두고 동기화를 건너뛰었습니다. git status를 보고 git merge --continue나 git merge --abort로 먼저 끝내세요.'
              : '끊긴 동기화가 남긴 것으로 보이는 merge가 있지만 그 시점의 상태 기록이 없어 사람의 해소가 섞였는지 알 수 없습니다. 그대로 두고 동기화를 건너뛰었으니 git status를 보고 git merge --continue나 git merge --abort로 먼저 끝내세요.',
          ],
        };
      }
      const abort = vaultGit(hypoDir, ['merge', '--abort']);
      if (abort.status === 0 && unmergedEntries(hypoDir)?.size === 0) {
        clearMergeOwned(hypoDir);
        clearMergeIntent(hypoDir);
        return {
          state: 'none',
          notices: ['끊긴 동기화가 남긴 merge를 취소하고 동기화를 다시 시도합니다.'],
        };
      }
      return {
        state: 'stuck',
        notices: [
          '끊긴 동기화가 남긴 merge를 취소하지 못했습니다. git status를 보고 git merge --abort로 끝내세요.',
        ],
      };
    }
    return {
      state: 'external',
      notices: [
        '진행 중인 merge가 있어 동기화를 건너뛰었습니다. git status를 보고 git merge --continue나 git merge --abort로 먼저 끝내세요.',
      ],
    };
  }
  const stuck = (why) => ({
    state: 'stuck',
    notices: [
      `Hypomnema가 시작한 merge를 끝내지 못했습니다: ${why}. git status를 보고 git merge --continue나 git merge --abort로 끝내세요.`,
    ],
  });
  const unmerged = unmergedEntries(hypoDir);
  if (unmerged === null) return stuck('git ls-files -u가 실패했습니다');
  if (unmerged.size)
    return stuck(`해소되지 않은 경로가 남았습니다 (${[...unmerged.keys()].join(', ')})`);
  for (const r of owned.resolvedPaths) {
    if (r.kind === 'modify-delete') {
      let bytes = null;
      try {
        bytes = readFileSync(r.backupPath, 'utf-8');
      } catch {
        // missing: reported below
      }
      if (bytes === null || sha256Hex(bytes) !== r.backupSha256) {
        return stuck(`${r.relPath}의 백업(${r.backupPath})이 없거나 달라졌습니다`);
      }
      const tracked = vaultGit(hypoDir, ['ls-files', '--', ...literalSpecs([r.relPath])]);
      if (tracked.status !== 0 || tracked.stdout.trim()) {
        return stuck(`${r.relPath}가 아직 인덱스에 있습니다`);
      }
    } else if (r.kind === 'gitignore') {
      const staged = gitShowText(hypoDir, ':0', r.relPath);
      if (staged === null || sha256Hex(staged) !== r.mergedSha256) {
        return stuck(`${r.relPath}의 인덱스 내용이 기록한 합친 결과와 다릅니다`);
      }
    } else {
      return stuck(`알 수 없는 기록 종류입니다 (${r.kind})`);
    }
  }
  // Killed between the first record and the second: the resolution may be half applied, and there
  // is no digest to compare the index with.
  if (owned.indexDigest === null) {
    return stuck(
      '해소를 하던 중 끊겨 인덱스 기록이 없습니다(아직 커밋된 것이 없어 git merge --abort는 안전합니다)',
    );
  }
  if (indexDigestOf(hypoDir) !== owned.indexDigest) {
    return {
      state: 'stuck',
      notices: [
        '끝나지 않은 동기화가 있고 그 사이 스테이징된 변경이 있어 자동으로 이어 가지 않았습니다. git status를 보고 git merge --continue나 git merge --abort로 끝내세요.',
      ],
    };
  }
  const commit = vaultGit(hypoDir, ['commit', '--no-edit', '-q']);
  if (commit.status !== 0) {
    // The whole stderr: a vault pre-commit hook that rejects the merge says why there.
    const why = String(commit.stderr)
      .trim()
      .replace(/\s*\n\s*/g, ' / ')
      .slice(0, 600);
    return stuck(`git commit 실패: ${why}`);
  }
  const resumed = resumePullArchive(hypoDir);
  clearMergeOwned(hypoDir);
  clearMergeIntent(hypoDir);
  const backups = owned.resolvedPaths
    .filter((r) => r.kind === 'modify-delete')
    .map((r) => backupPathForNotice(r.backupPath));
  const summary =
    `동기화 충돌을 자동으로 해소했습니다: ${owned.resolvedPaths.map((r) => r.relPath).join(', ')}.` +
    (backups.length ? ` 수정된 쪽 내용은 ${backups.join(', ')}에 보관했습니다.` : '') +
    (resumed.created.length ? ` 추가 기준선: ${resumed.created.join(', ')}.` : '');
  return { state: 'finished', notices: [summary, ...resumed.notices] };
}

// Append `notices` to the health notice the next SessionStart shows (the one-slot file
// `writeRootHotHealthNotice` owns), keeping what an earlier writer left there. Read and write sit
// under the file lock `writeRootHotHealthNotice` and the reader take, and a line already in the
// message is not added again, so a notice that repeats on every sync does not pile up.
function leaveSyncNotice(hypoDir, notices) {
  const lines = notices.flatMap((n) => n.split('\n')).filter(Boolean);
  if (!lines.length) return;
  const path = join(hypoDir, '.cache', ROOT_HOT_HEALTH_NOTICE_FILENAME);
  try {
    withFileLock(path, () => {
      let earlier = '';
      try {
        const message = JSON.parse(readFileSync(path, 'utf-8')).message;
        if (typeof message === 'string') earlier = message;
      } catch {
        // none, or unreadable: nothing to keep
      }
      const have = new Set(earlier.split('\n'));
      const fresh = [...new Set(lines)].filter((l) => !have.has(l));
      if (!fresh.length) return;
      atomicWrite(
        path,
        JSON.stringify({ message: [earlier, ...fresh].filter(Boolean).join('\n'), ts: Date.now() }),
      );
    });
  } catch {
    // best-effort, like every notice write: a hook must not fail Stop over it
  }
}

/**
 * The tree-mutating half of a sync: `git fetch` and `git merge @{u}` (a pull made of its two
 * halves, so the fetch runs once), plus the abort that keeps the working tree from being left
 * half-merged.
 *
 * Split out of syncRemote (review r5-w4 major 2) so a caller can hold the
 * vault commit lock across this and NOT across the push. This half has to
 * stay inside the lock: it rewrites files another session could be reading,
 * staging, or committing at the same moment. See hypo-auto-commit.mjs for the
 * other side of that split. A caller must hold that lock (it is not reentrant,
 * and the baseline commit this makes runs inside it).
 *
 * Order of work:
 *   1. `finishOwnedMerge`: a merge Hypomnema left open is finished first; a merge somebody else
 *      left open stops this sync (notice only, `deferred: 'external'`).
 *   2. `resumePullArchive`: archived bytes whose merge already landed are shared.
 *   3. `git fetch` (one failure is recorded as the 'pull' failure and the sync stops there, with no
 *      merge). When the incoming range changes generated view tracking (a migration or a
 *      rollback commit) or the upstream is migrated, and HEAD does not hold `@{u}`,
 *      `clearGeneratedPathsBlockingPull` sets aside what would block the merge. A deferral
 *      (`.gitignore` not a pure addition, `.cache/` not ignored, a concurrent change) skips the
 *      pull: notice only. Any other stop is taken back and the pull runs, so git reports its own
 *      failure. A pull that then fails takes the cleared bytes back (`undoClearedPaths`).
 *   4. `git merge --no-edit @{u}`, and the conflict policy below. When either side adds or
 *      removes generated view tracking across the merge (`incomingChangesViewTracking`,
 *      `outgoingChangesViewTracking`), the merge runs with `-X rename-threshold=100%`: otherwise
 *      git pairs the view the migration deleted with the baseline entry that holds its bytes, and an
 *      old machine's edit of that view lands as a content merge on the shared baseline file (a
 *      conflict on a `sessions/` path, or a silent change of a content-named file) instead of a
 *      modify/delete conflict on the view. When HEAD does not hold `@{u}`, the merge is announced
 *      first by `hypo-merge-intent.json` in the git directory, which lets a later run take back a merge a killed run
 *      left open before it had any resolution record (`finishOwnedMerge`). After a merge that
 *      landed, `resumePullArchive` shares what was set aside. The flag applies to the whole merge,
 *      so during the one-time migration merge a page that one side renamed and edited while the
 *      other side edited it ends as modify/delete, and the sync aborts for a manual merge. The
 *      merge is `git merge`, which ignores `pull.ff` (it honors `merge.ff`), unlike the old
 *      `git pull --no-rebase`.
 *
 * Failure policy (v1.4 "sync hardening"):
 *   - clean fast-forward / conflict-free merge → `{pulled: true}`, caller pushes.
 *   - MERGE CONFLICT (`git merge` leaves unmerged paths): when every unmerged path is a
 *     generated view with a modify/delete conflict, or a `.gitignore` both sides only added lines
 *     to, resolve it and finish the merge (`resolveSyncConflict`, `finishOwnedMerge`) →
 *     `{pulled: true}`. Otherwise abort the merge so the tree returns to the just-committed local
 *     state ("ours"), record op='conflict', and report `{conflict: true}` so the caller does
 *     NOT push (a diverged branch cannot fast-forward, so the push would only
 *     add a noisy second failure). No data is lost: ours stays committed
 *     locally, "theirs" stays on the remote, and the divergence is surfaced by
 *     session-start + doctor until the user merges manually.
 *   - non-conflict pull failure (network/auth: no unmerged paths) → record
 *     op='pull' and report `{pulled: false, conflict: false}`. The caller does not push either:
 *     a push after a failed or deferred pull only adds a second failure that hides the cause
 *     (the last record is what the next SessionStart shows).
 *
 * `notices` (always an array) are also left for the next SessionStart. `deferred` is set only when
 * this sync skipped the pull on purpose; `leaveNotices: false` leaves them to a caller that
 * shows them itself. `testHooks`: `afterMergeStarted` (runs right after the merge command
 * returns), `afterResolveBeforeCommit` (runs after a conflict is resolved, before its merge
 * commit), and what `clearGeneratedPathsBlockingPull` and
 * `backUpGeneratedPath` take.
 *
 * Best-effort: never throws. A sync failure must not break the Stop hook. A
 * throw is recorded as a pull failure and reported as `{pulled: false, conflict: false}`. A throw
 * never aborts an open merge (a killed run leaves the same state).
 *
 * @param {string} hypoDir
 * @param {{testHooks?: object, leaveNotices?: boolean}} [opts]
 * @returns {{pulled: boolean, conflict: boolean, notices: string[], deferred?: string}}
 */
export function pullRemote(hypoDir, { testHooks, leaveNotices = true } = {}) {
  const git = (...args) => syncGit(hypoDir, ...args);
  const notices = [];
  const done = (result) => {
    // The intent only matters while a merge it announced is open.
    if (mergeIntentExists(hypoDir) && mergeHeadState(hypoDir).state === 'absent') {
      clearMergeIntent(hypoDir);
    }
    if (leaveNotices) leaveSyncNotice(hypoDir, notices);
    return { ...result, notices };
  };
  // A deferral skips the pull on purpose; it is recorded like a failed pull so doctor shows it, and
  // so the last record names the cause even when the deferral came without a notice.
  const defer = (why, note, recorded) => {
    appendSyncFailure(hypoDir, 'pull', recorded || note || `pull deferred: ${why}`);
    return done({ pulled: false, conflict: false, deferred: why });
  };
  // What the clearing step moved. A pull that does not land takes it back. Returns whether anything
  // was moved (so the take-back ran).
  let pre = null;
  const takeBack = () => {
    const moved = pre
      ? pre.archived.length +
        pre.localOnly.length +
        pre.unowned.length +
        pre.cleared.length +
        pre.gitignoreSaved.length +
        pre.ownedRemoved.length
      : 0;
    if (moved > 0) notices.push(...undoClearedPaths(hypoDir, pre).notices);
    pre = null;
    return moved > 0;
  };
  try {
    const owned = finishOwnedMerge(hypoDir);
    notices.push(...owned.notices);
    if (owned.state === 'finished') {
      recordSyncSuccess(hypoDir, 'pull');
      return done({ pulled: true, conflict: false });
    }
    if (owned.state !== 'none') return defer(owned.state, owned.notices[0]);
    notices.push(...resumePullArchive(hypoDir).notices);

    const fetch = git('fetch', '-q');
    if (fetch.status !== 0) {
      appendSyncFailure(hypoDir, 'pull', fetch.stderr || fetch.stdout);
      return done({ pulled: false, conflict: false });
    }
    const behind =
      git('rev-parse', '--verify', '-q', '@{u}').status === 0 &&
      git('merge-base', '--is-ancestor', '@{u}', 'HEAD').status !== 0;
    const incomingMoves = behind && incomingChangesViewTracking(hypoDir, '@{u}');
    const canCatchUp = behind && (upstreamIsMigrated(hypoDir) || incomingMoves);
    // A side that adds or removes view tracking needs exact renames only (see the docblock).
    const exactRenames = behind && (incomingMoves || outgoingChangesViewTracking(hypoDir, '@{u}'));
    if (canCatchUp) {
      pre = clearGeneratedPathsBlockingPull(hypoDir, '@{u}', { testHooks });
      if (!pre.ok) {
        const { deferred, notice, reason, gitError } = pre;
        const tookBack = takeBack();
        if (deferred) {
          if (notice) notices.push(notice);
          return defer(deferred, notice);
        }
        // A stop after bytes were moved and put back (the record could not be written, an unstage
        // or checkout failed): the take-back may leave an ignored file that the merge would
        // overwrite without a word, with its backup and record gone. Merge nothing; the next pull
        // runs the clearing step again.
        if (tookBack) {
          const note =
            `이행 커밋을 받으려고 옛 세션 현황을 보관하던 중 멈춰(${reason}) 보관한 내용을 되돌리고 병합하지 않았습니다. 다음 동기화에서 다시 시도합니다` +
            (gitError
              ? `. git의 말: ${gitError}. git이 잠금 파일(.lock)을 가리키는데 실행 중인 git 프로세스가 없다면, 그 파일을 직접 지운 뒤 다음 동기화를 기다리면 됩니다`
              : '');
          notices.push(note);
          // The record keeps git's own line: retrying cannot fix a stale lock, and the one-line
          // summary of a long note would cut it off.
          return defer('clear-failed', note, gitError ? `${reason}: ${gitError}` : undefined);
        }
        // Any other stop (another file is dirty, a revision git cannot read) moved nothing: pull
        // anyway and let git report its own failure.
      } else if (pre.backups.length) {
        const where = [...new Set(pre.backups.map(backupPathForNotice))].join(', ');
        notices.push(`이행 커밋을 받으려고 이 기계의 옛 세션 현황 변경을 ${where}에 보관했습니다.`);
      }
    }

    if (behind) {
      const head = gitOut(hypoDir, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
      const target = gitOut(hypoDir, ['rev-parse', '--verify', '--quiet', '@{u}'])?.trim();
      if (head && target) {
        try {
          writeGitDirJson(hypoDir, MERGE_INTENT_FILE, { v: 1, phase: 'pull', head, target });
        } catch {
          // no intent: a merge left open by a kill is then left to a person
        }
      }
    }
    const pull = git(
      'merge',
      '-q',
      '--no-edit',
      ...(exactRenames ? ['-X', 'rename-threshold=100%'] : []),
      '@{u}',
    );
    if (pull.status !== 0 && mergeHeadState(hypoDir).state === 'present') {
      recordMergeFingerprint(hypoDir, unmergedEntries(hypoDir)?.keys() ?? []);
    }
    testHooks?.afterMergeStarted?.();
    if (pull.status === 0) {
      notices.push(...resumePullArchive(hypoDir).notices);
      recordSyncSuccess(hypoDir, 'pull');
      return done({ pulled: true, conflict: false });
    }
    // A merge conflict leaves unmerged index entries; a network/auth failure
    // leaves none. Only the former must be aborted to keep the tree clean.
    const unmerged = unmergedEntries(hypoDir);
    if (unmerged !== null && unmerged.size > 0) {
      const resolved = resolveSyncConflict(hypoDir, unmerged, { testHooks });
      notices.push(...resolved.notices);
      if (resolved.ok) {
        testHooks?.afterResolveBeforeCommit?.();
        const finished = finishOwnedMerge(hypoDir);
        if (finished.state === 'finished') {
          notices.push(...finished.notices);
          recordSyncSuccess(hypoDir, 'pull');
          return done({ pulled: true, conflict: false });
        }
        // Our own resolution could not be committed: abort like any other conflict.
        resolved.rollback();
      }
      // Abort to return the tree to the just-committed local state. Verify the
      // abort actually cleaned up: if it fails (filesystem/concurrent-mutation
      // edge), the tree may still be half-merged, so record that distinctly
      // ('conflict-unresolved') rather than masking it as a clean abort. Only a
      // clean abort lets the cleared bytes go back: into a half-merged tree they
      // stay in their backups, and the archive record names them.
      const abort = git('merge', '--abort');
      const aborted = abort.status === 0 && unmergedEntries(hypoDir)?.size === 0;
      if (aborted) takeBack();
      appendSyncFailure(
        hypoDir,
        aborted ? 'conflict' : 'conflict-unresolved',
        pull.stderr || pull.stdout,
      );
      return done({ pulled: false, conflict: true });
    }
    // No merge was open when this run began (`finishOwnedMerge` said so), so a `MERGE_HEAD` now is
    // this merge stopped before its commit (a `pre-merge-commit` hook that rejects): take it back,
    // or the next sync would find it and wait for a person.
    const stopped = mergeHeadState(hypoDir).state === 'present';
    if (
      !stopped ||
      (git('merge', '--abort').status === 0 && unmergedEntries(hypoDir)?.size === 0)
    ) {
      takeBack();
    }
    appendSyncFailure(hypoDir, 'pull', pull.stderr || pull.stdout);
    return done({ pulled: false, conflict: false });
  } catch (err) {
    // best-effort: never break the Stop hook. The record keeps a caller that does not push after a
    // failed pull from going quiet.
    appendSyncFailure(hypoDir, 'pull', `pull stopped: ${err?.message ?? String(err)}`);
    return done({ pulled: false, conflict: false });
  }
}

/**
 * Pin WHAT the push will send and WHERE, so the push itself carries no
 * ambiguity about either.
 *
 * Meant to be called from inside the vault commit lock, right after the
 * commit and the pull that this session performed. A bare `git push` resolves
 * its source at push time, from whatever HEAD is then: release the lock, let a
 * sibling session commit, and the push sends the SIBLING's newer commit rather
 * than the one this session just made and verified. Reading the OID here, still
 * under the lock, makes that impossible: the push sends this exact object or it
 * sends nothing.
 *
 * `oid` defaults to HEAD, which is correct for the Stop hook's use even though
 * the commit it made has its own sha: a non-conflicting `git pull --no-rebase`
 * can add a merge commit on top, and pushing the pre-merge sha would be
 * rejected as a non-fast-forward. HEAD under the lock, after the pull,
 * contains this session's commit and nothing a sibling added afterwards.
 *
 * Destination comes from the current branch's configured upstream, read as a
 * full `refs/heads/<name>` so no `push.default` mode, no `remote.<n>.push`
 * refspec, and no branch-name-to-remote-name guess gets to reinterpret it.
 * Returns null when the branch is detached or has no upstream: a null target
 * makes pushRemote decline to push at all, which is the safe end of the trade.
 * Pushing SOMETHING under an unresolvable destination is how a vault ends up
 * with a branch nobody meant to publish.
 *
 * Best-effort: never throws.
 *
 * @param {string} hypoDir
 * @param {string} [oid] the exact commit to send; defaults to current HEAD
 * @returns {{remote: string, remoteRef: string, oid: string}|null}
 */
export function resolvePushTarget(hypoDir, oid) {
  try {
    const branch = syncGit(hypoDir, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    if (branch.status !== 0) return null; // detached HEAD: no branch, no upstream
    const name = (branch.stdout || '').trim();
    if (!name) return null;
    // for-each-ref, not `rev-parse @{upstream}`: this yields the remote NAME and
    // the remote-side ref SEPARATELY and already fully qualified
    // (`refs/heads/main`), where `@{upstream}` yields one `origin/main` string a
    // caller has to split on the first slash and then guess whether the rest is
    // a branch (it is not, for a remote whose name contains a slash, or a ref
    // outside refs/heads).
    const up = syncGit(
      hypoDir,
      'for-each-ref',
      '--format=%(upstream:remotename)%09%(upstream:remoteref)',
      `refs/heads/${name}`,
    );
    if (up.status !== 0) return null;
    const [remote, remoteRef] = (up.stdout || '').trim().split('\t');
    if (!remote || !remoteRef) return null; // no upstream configured
    const head = syncGit(hypoDir, 'rev-parse', oid || 'HEAD');
    if (head.status !== 0) return null;
    const resolved = (head.stdout || '').trim();
    if (!/^[0-9a-f]{40}$/.test(resolved)) return null;
    return { remote, remoteRef, oid: resolved };
  } catch {
    return null;
  }
}

/**
 * The network half of a sync: push one pinned commit to one pinned
 * destination.
 *
 * Runs OUTSIDE the vault commit lock (review r5-w4 major 2). Holding the lock
 * across a network round trip made one session's Stop own the vault for up to
 * a minute, and a sibling SessionStart needs that same lock twice (its own
 * `git pull` and the generated view write), each with a 5s timeout,
 * out of a 30s hook budget.
 *
 * The earlier justification for putting the push outside the lock was that
 * a push changes nothing locally. Half of that is closed here and half is not:
 *
 *   - CLOSED: "a push sends whatever HEAD is at push time". It sends `target`
 *     and only `target`, decided under the lock by resolvePushTarget.
 *   - OPEN, and it stays open: a client-side `pre-push` hook is an arbitrary
 *     program that git runs inside this `git push`, with the working tree and
 *     the index right there. A user whose pre-push builds, formats, or stages
 *     anything is mutating the vault from outside the lock, racing the
 *     view write and the commit fence exactly as a pull would. This is
 *     not theoretical: tests/session-hooks.test.mjs observes the lock boundary
 *     THROUGH a pre-push hook, so the mechanism is exercised on every run.
 *     `--no-verify` would close it and is deliberately not used: it overrides
 *     the user's own push policy, which is not this hook's call to make, and it
 *     would blind the one observation point the boundary has. Closing it for
 *     real means either pushing from a scratch clone or taking the lock back
 *     across the network, both bigger than this fix.
 *
 * Callers must not call this after a pullRemote that did not report `pulled` (a conflict, a
 * deferral or a failure): pushing then only records a second failure over the real cause.
 *
 * Best-effort: never throws.
 *
 * @param {string} hypoDir
 * @param {{remote: string, remoteRef: string, oid: string}|null} target
 * @returns {{pushed: boolean}}
 */
export function pushRemote(hypoDir, target) {
  try {
    if (!target || !target.remote || !target.remoteRef || !target.oid) {
      // No destination this function is willing to name. Not pushing is the
      // conservative outcome and it is recorded like any other push failure, so
      // session-start and doctor surface it instead of letting a vault look
      // synced while it silently never pushes again.
      appendSyncFailure(
        hypoDir,
        'push',
        'push destination could not be resolved (detached HEAD, or the current branch has no upstream); nothing was pushed',
      );
      return { pushed: false };
    }
    const push = syncGit(hypoDir, 'push', target.remote, `${target.oid}:${target.remoteRef}`);
    if (push.status === 0) {
      recordSyncSuccess(hypoDir, 'push');
      return { pushed: true };
    }
    appendSyncFailure(hypoDir, 'push', push.stderr || push.stdout);
    return { pushed: false };
  } catch {
    // best-effort: never break the Stop hook
    return { pushed: false };
  }
}

/**
 * Pull + push the wiki against its remote. A conflict is aborted in the same run, so the working
 * tree normally is not left half-merged. A run killed mid-merge, or an abort git cannot complete
 * (`conflict-unresolved`), leaves a merge open; the next `pullRemote` takes it back or reports it
 * (`finishOwnedMerge`).
 *
 * The two halves in their original order, for a caller that holds the vault
 * commit lock around the whole thing (`pullRemote` needs it, and the push then
 * runs inside it too). hypo-auto-commit.mjs holds it for the pull only and
 * calls pullRemote/pushRemote itself; see there. The ordering guarantee lives here as well as there: a conflicting
 * pull returns before the push, so a diverged branch is never pushed from.
 *
 * Best-effort: never throws. A sync failure must not break the Stop hook.
 *
 * @param {string} hypoDir
 * @returns {{pulled: boolean, pushed: boolean, conflict: boolean}}
 */
export function syncRemote(hypoDir) {
  const { pulled, conflict } = pullRemote(hypoDir);
  if (conflict) return { pulled: false, pushed: false, conflict: true };
  if (!pulled) return { pulled: false, pushed: false, conflict: false };
  // Resolved here rather than left to the push: the target is what makes the
  // push unambiguous, and a caller of this combined form has no other place to
  // decide it. HEAD right after the pull, which is what a bare `git push` would
  // have sent anyway, minus the window between this line and the push itself.
  const { pushed } = pushRemote(hypoDir, resolvePushTarget(hypoDir));
  return { pulled, pushed, conflict: false };
}

// ── touched-paths (scope the auto-commit to session-touched paths) ───────────
//
// The old commitWikiChanges swept the ENTIRE working tree: in a shared
// multi-project vault with concurrent Claude Code sessions, another session's
// staged/dirty files got committed and pushed by THIS session's Stop hook, and
// the human-authored commit message was clobbered. The fix is to accumulate,
// per session_id, the vault-relative paths this session actually touched, and
// have commitWikiChanges commit only that scope.
//
// Sources that feed the accumulator:
//   - hypo-auto-stage.mjs (PostToolUse): every Write/Edit/MultiEdit to a file
//     under the vault.
//   - hypo-hot-rebuild.mjs (Stop, runs BEFORE auto-commit): log.md, which is
//     hook-generated, not user Write/Edit — without this a scope built from
//     Write/Edit alone would drop it from the scoped commit. The generated
//     views are never claimed: they are not committed at all.
//
// No session_id → never accumulate, and never fall back to a shared "default"
// bucket: a path recorded under the wrong key could leak between sessions.

/** Directory holding one session's cache artifacts (touched-paths.json and
 * friends). Not cleaned up when a session ends normally or dies mid-session. */
function sessionCacheDir(hypoDir, sessionId) {
  return join(hypoDir, '.cache', 'sessions', sanitizeSessionId(sessionId));
}

/** @returns {string} path to a session's accumulated touched-paths JSON array. */
export function touchedPathsPath(hypoDir, sessionId) {
  return join(sessionCacheDir(hypoDir, sessionId), 'touched-paths.json');
}

/** @returns {string} path to a session's touched-paths failure flag. */
export function touchedPathsFailedPath(hypoDir, sessionId) {
  return join(sessionCacheDir(hypoDir, sessionId), 'touched-paths-failed.json');
}

// How much of a caller's time budget `recordTouchedPaths` leaves for writing the failure flag, so a
// record that waited out its lock still has time to say it failed.
const TOUCHED_FLAG_SHARE_MS = 1000;

/**
 * HEAD's state for one vault path, for the failure flag: `{state: 'present', sha256}`,
 * `{state: 'absent'}` (HEAD has no such path, or no commit yet) or `{state: 'error'}` when git could
 * not answer (including no time left on `deadline`, or a blob that will not read). Built on
 * `headPathState`, which keeps absent and error apart; `headBlob` alone returns `null` for both.
 */
function headBlobState(hypoDir, relPath, { deadline } = {}) {
  const state = headPathState(hypoDir, relPath, { deadline });
  if (state !== 'present') return { state };
  const blob = headBlob(hypoDir, relPath, { deadline });
  return blob ? { state: 'present', sha256: sha256Hex(blob) } : { state: 'error' };
}

/**
 * True for a zero-byte `projects/<slug>/index.md` that HEAD does not have: the shape a close leaves
 * when it dies between creating the project index and writing its seed. `headBlobState` answering
 * `error` gives no hint, since "not in HEAD" is then unknown.
 */
function emptyNewIndexHint(hypoDir, relPath, { deadline } = {}) {
  if (!/^projects\/[^/]+\/index\.md$/.test(relPath)) return false;
  try {
    if (statSync(join(hypoDir, relPath)).size !== 0) return false;
  } catch {
    return false;
  }
  return headBlobState(hypoDir, relPath, { deadline }).state === 'absent';
}

/**
 * Read a session's failure flag (`touched-paths-failed.json`):
 * `{v: 1, entries: {<path>: {headSha256?: string|null}}, pathsUnknown, reasons}`.
 * `failed` is false only when there is no flag. A flag that exists but cannot be read is a failure
 * with the lost paths unknown, never "no flag".
 *
 * @returns {{failed: boolean, entries: Record<string, {headSha256?: string|null}>, pathsUnknown: boolean, reasons: string[]}}
 */
function readTouchedPathsFailed(hypoDir, sessionId) {
  const path = touchedPathsFailedPath(hypoDir, sessionId);
  if (!existsSync(path)) return { failed: false, entries: {}, pathsUnknown: false, reasons: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const entries = parsed?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('shape');
    return {
      failed: true,
      entries,
      pathsUnknown: parsed.pathsUnknown === true,
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((r) => typeof r === 'string')
        : [],
    };
  } catch {
    return { failed: true, entries: {}, pathsUnknown: true, reasons: [] };
  }
}

/**
 * Leave a mark that a touched-paths record did not land, so a gate that reads the set cannot take
 * the missing path for "not this session's". Best-effort and lock-free on purpose: a lock failure is
 * one of the causes it exists for. Merges into an existing flag (a path takes its newest entry,
 * `pathsUnknown` is a logical or, reasons accumulate). An unreadable existing flag is replaced by a
 * `pathsUnknown` one. Each entry holds HEAD's blob hash for the path as of now: `null` when HEAD has
 * none, no `headSha256` key when git could not say (the gate then always blocks on it).
 *
 * @param {string[]} paths vault-relative paths whose record did not land
 * @param {string} reason why (an error code, or a fixed label)
 * @param {{pathsUnknown?: boolean, deadline?: {end: number}}} [opts] `pathsUnknown`: paths were
 *   lost that this call cannot name
 */
function markTouchedPathsFailed(hypoDir, sessionId, paths, reason, opts = {}) {
  const { pathsUnknown = false, deadline } = opts;
  try {
    const prior = readTouchedPathsFailed(hypoDir, sessionId);
    const entries = { ...prior.entries };
    for (const p of paths) {
      const head = headBlobState(hypoDir, p, { deadline });
      entries[p] =
        head.state === 'present'
          ? { headSha256: head.sha256 }
          : head.state === 'absent'
            ? { headSha256: null }
            : {};
    }
    const reasons = prior.reasons.includes(reason) ? prior.reasons : [...prior.reasons, reason];
    atomicWrite(
      touchedPathsFailedPath(hypoDir, sessionId),
      JSON.stringify({
        v: 1,
        entries,
        pathsUnknown: prior.pathsUnknown || pathsUnknown,
        reasons,
      }),
    );
  } catch {
    // Nothing more to fall back on: see the double-failure limit in the plan.
  }
}

/** A record of `paths` landed: they no longer need a flag entry. `pathsUnknown` stays, since the
 * paths it stands for are not named. The flag file goes once it holds nothing. Best-effort. */
function dropTouchedPathsFailedEntries(hypoDir, sessionId, paths) {
  const path = touchedPathsFailedPath(hypoDir, sessionId);
  if (!existsSync(path)) return;
  try {
    const prior = readTouchedPathsFailed(hypoDir, sessionId);
    if (!prior.failed || !paths.some((p) => Object.hasOwn(prior.entries, p))) return;
    const entries = { ...prior.entries };
    for (const p of paths) delete entries[p];
    if (Object.keys(entries).length === 0 && !prior.pathsUnknown) {
      rmSync(path, { force: true });
      return;
    }
    atomicWrite(
      path,
      JSON.stringify({ v: 1, entries, pathsUnknown: prior.pathsUnknown, reasons: prior.reasons }),
    );
  } catch {
    // best-effort: a leftover entry only keeps blocking, the safe direction
  }
}

/**
 * Whether a failure-flag entry still points at this session's uncommitted write. The entry holds
 * HEAD's blob hash at flag time; HEAD still at that value means the flagged write was never
 * committed, HEAD moved means it was (what is dirty now may be another writer's). A flag entry
 * with no hash, or a HEAD lookup that fails now, is no evidence of a move, so it stays pending.
 */
function flaggedPathStillPending(hypoDir, relPath, entry, { deadline } = {}) {
  if (!entry || !Object.hasOwn(entry, 'headSha256')) return true;
  const now = headBlobState(hypoDir, relPath, { deadline });
  if (now.state === 'error') return true;
  return (now.state === 'present' ? now.sha256 : null) === entry.headSha256;
}

/**
 * Read the raw touched-paths JSON array off disk. Caller's responsibility to
 * hold the per-session lock first — this has no locking of its own.
 *
 * Absent and unreadable are different answers, and callers MUST branch on
 * the difference: a genuinely absent (or genuinely empty) file returns `[]`
 * — safe to treat as "nothing accumulated". A file that exists but fails to
 * read or parse returns `null` — NOT the same as empty. A caller that
 * conflates the two (codex FIX 1) and then does a set-difference clear on
 * `null`-as-`[]` will compute "nothing left" and delete the file outright,
 * silently losing every pending path to a transient I/O or parse error.
 *
 * @returns {string[]|null} the array, or `null` on a read/parse failure
 */
function readTouchedPathsFile(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : null;
  } catch {
    return null; // corrupt/unreadable — NOT the same as empty; see above
  }
}

/**
 * Accumulate vault-relative touched paths for `sessionId`. Best-effort in the
 * sense that it never throws, but no longer silent about it: it now reports
 * whether the accumulation actually landed, because a caller that treats a
 * write as accounted-for the moment it calls this (the hook-generated log.md
 * entries, see hypo-hot-rebuild.mjs) needs to know when that assumption was
 * wrong. A lock-timeout or write failure used to be
 * indistinguishable from success: the write would go through, this would
 * swallow the error, and the file would sit dirty with nothing in ANY
 * session's touched-paths set to bring it into an auto-commit, orphaned
 * until some unrelated write happens to touch the same path again. Dedup-on-
 * insert, JSON array (not delimiter-joined, survives non-ASCII and any byte
 * a filename can legally hold). No-op (and reports true, nothing to fail)
 * without a session_id or with an empty path list: never accumulate into a
 * shared bucket, and an empty call isn't a failure.
 *
 * Read-merge-write is guarded by the per-session file lock (the SAME lock
 * `drainTouchedPaths` takes), so a PostToolUse hook accumulating concurrently
 * with the Stop-chain drain can never lose a path to either a lost update
 * (two writers merging from the same stale read) or a drain racing between
 * this function's read and its write.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {string|string[]} relPaths one or more vault-relative paths
 * @param {{expectedHashes?: Record<string, string>, deadline?: {end: number}}} [opts]
 *   `expectedHashes`: record this sha256 for a path instead of the bytes on disk (for a path
 *   recorded before its bytes are written). `deadline`: a `{end}` budget (see
 *   `remainingSpawnTimeoutMs`) that caps the lock wait and the failure flag's git lookups.
 * @returns {boolean} true when the accumulation is durably recorded (or there
 *   was nothing to record); false when a lock-timeout or write failure means
 *   the caller cannot assume this path is in ANY session's touched-paths set.
 *   A false also leaves `touched-paths-failed.json` naming the paths, whether or
 *   not the caller looks at the return value.
 */
/**
 * Shared read-merge-write body for accumulating touched paths. Runs OUTSIDE
 * any lock; every caller wraps it in `withFileLock(path, ...)`.
 *
 * A corrupt/unreadable file (`readTouchedPathsFile` returns `null`) is
 * recovered from here, not preserved: an accumulate is additive by nature
 * (there is nothing salvageable to merge with), so starting fresh from
 * `incoming` is the correct best-effort behavior, unlike `clearTouchedPaths`,
 * where the same `null` MUST NOT be treated as empty (see
 * `readTouchedPathsFile`).
 *
 * @returns {{added: boolean}} whether at least one of `incoming` was NOT
 *   already present in the set before this call.
 */
function mergeIncomingTouchedPaths(hypoDir, sessionId, incoming, hashFor, deadline) {
  const path = touchedPathsPath(hypoDir, sessionId);
  const current = readTouchedPathsFile(path);
  // Starting over from `incoming` drops whatever the unreadable file held, and a later read says
  // `ok`. The lost paths are not known, so the flag says so.
  if (current === null) {
    markTouchedPathsFailed(hypoDir, sessionId, incoming, 'prior-record-unreadable', {
      pathsUnknown: true,
      deadline,
    });
  }
  const merged = new Set(current === null ? [] : current);
  let added = false;
  for (const p of incoming) {
    if (!merged.has(p)) added = true;
    merged.add(p);
  }
  // Hashes first, the set second. A failure between the two leaves a hash
  // for a path the set may not hold (never read: only paths in the set are
  // looked up) or the previous hash of a path the set already held (at worst
  // a false drift, which keeps the path out of the commit and blocks, never
  // one that sweeps foreign bytes in).
  const hashPath = touchedHashesPath(hypoDir, sessionId);
  const hashes = readTouchedHashesFile(hashPath);
  for (const p of incoming) {
    const h = hashFor(p);
    if (h === undefined) delete hashes[p];
    else hashes[p] = h;
  }
  atomicWrite(hashPath, JSON.stringify(hashes));
  atomicWrite(path, JSON.stringify([...merged]));
  return { added };
}

/**
 * Where the per-path content hashes recorded alongside a session's
 * touched-paths set live: `{ "<vault-relative path>": "<sha256 hex>" | null }`,
 * `null` meaning the file did not exist when it was recorded. A separate file
 * rather than a new shape for touched-paths.json, so every reader of that
 * array keeps working unchanged, and a set written before hashes existed
 * simply has no entry here.
 *
 * What the hash is for: the set records that this session wrote a path, not
 * which bytes. When a clear after a successful commit fails, the stale claim
 * outlives its commit, and a later edit by ANOTHER session to that same path
 * would be swept into this session's next commit. Comparing the bytes on disk
 * with the bytes recorded here at commit time is what tells the two apart
 * (see commitTouchedPaths).
 */
export function touchedHashesPath(hypoDir, sessionId) {
  return join(sessionCacheDir(hypoDir, sessionId), 'touched-hashes.json');
}

/** Absent, corrupt, or not an object all read as `{}`: no hash recorded for
 * any path, which is exactly how a set from before hashes existed behaves. */
function readTouchedHashesFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** sha256 of a vault file's bytes, `null` when it does not exist, `undefined`
 * when it exists but cannot be read (nothing trustworthy to record). */
function vaultFileHash(hypoDir, relPath) {
  try {
    return sha256Hex(readFileSync(join(hypoDir, relPath)));
  } catch (err) {
    return err?.code === 'ENOENT' ? null : undefined;
  }
}

/** sha256 of a vault path's blob in HEAD, `null` when HEAD has no such path
 * (or there is no HEAD to read). `./` makes git resolve the path from the
 * vault, which may sit below the repository root. */
function headFileHash(hypoDir, relPath) {
  const blob = headBlob(hypoDir, relPath);
  return blob ? sha256Hex(blob) : null;
}

/** A vault path's blob in HEAD (or, with `index`, in the index at stage 0) as a
 * Buffer, `null` when git cannot give it (or `deadline` has run out). */
export function headBlob(hypoDir, relPath, { index = false, deadline } = {}) {
  const spec = `${index ? ':0' : 'HEAD'}:./${relPath}`;
  // With a `deadline` the call is cut to the time left; none left means git is not asked.
  const left = remainingSpawnTimeoutMs(deadline);
  if (left === 0) return null;
  const r = spawnSync('git', ['-C', hypoDir, 'cat-file', 'blob', spec], {
    timeout: left ?? 30000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

/** Whether a hash was recorded for `relPath` and the bytes on disk no longer
 * match it. A path with no recorded hash never counts as drifted. */
function recordedHashDrifted(hypoDir, hashes, relPath) {
  return Object.hasOwn(hashes, relPath) && vaultFileHash(hypoDir, relPath) !== hashes[relPath];
}

/** Drop hash entries for paths no longer in the set. Best-effort: a leftover
 * entry is never read (lookups are by paths in the set) and is overwritten
 * the next time that path is recorded. */
function pruneTouchedHashes(hypoDir, sessionId, remaining) {
  const hashPath = touchedHashesPath(hypoDir, sessionId);
  try {
    if (remaining.length === 0) {
      rmSync(hashPath, { force: true });
      return;
    }
    const hashes = readTouchedHashesFile(hashPath);
    const kept = {};
    for (const p of remaining) if (Object.hasOwn(hashes, p)) kept[p] = hashes[p];
    atomicWrite(hashPath, JSON.stringify(kept));
  } catch {
    // best-effort, see above
  }
}

export function recordTouchedPaths(hypoDir, sessionId, relPaths, opts = {}) {
  if (!sessionId) return true;
  const incoming = (Array.isArray(relPaths) ? relPaths : [relPaths]).filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  if (incoming.length === 0) return true;
  const { expectedHashes, deadline } = opts;
  const path = touchedPathsPath(hypoDir, sessionId);
  // With a `deadline` the lock wait leaves room to write the failure flag.
  const left = remainingSpawnTimeoutMs(deadline);
  const lockOpts =
    left === undefined
      ? {}
      : { timeoutMs: Math.max(0, Math.min(5000, left - TOUCHED_FLAG_SHARE_MS)) };
  try {
    withFileLock(
      path,
      () =>
        mergeIncomingTouchedPaths(
          hypoDir,
          sessionId,
          incoming,
          (p) =>
            expectedHashes && Object.hasOwn(expectedHashes, p)
              ? expectedHashes[p]
              : vaultFileHash(hypoDir, p),
          deadline,
        ),
      lockOpts,
    );
  } catch (err) {
    // Never throws out to the caller (a hook must not fail a tool call over
    // a cache write, includes a lock-timeout), but no longer silent: the
    // false return is what lets a caller decide whether to trust this write
    // as accounted for, and the failure flag is what tells a gate that reads
    // the set later, whether or not the caller looked at the return.
    markTouchedPathsFailed(hypoDir, sessionId, incoming, err?.code || 'write-failed', { deadline });
    return false;
  }
  // The record now covers these paths, so an earlier failure flag entry for them is spent.
  dropTouchedPathsFailedEntries(hypoDir, sessionId, incoming);
  return true;
}

/**
 * Read and clear a session's accumulated touched paths in one step — "drain",
 * not "read", because the caller is expected to consume the WHOLE set
 * unconditionally. Kept for callers that genuinely want that (e.g. a
 * probe/inspection path); the Stop-chain auto-commit does NOT use this —
 * see commitTouchedPaths below, which holds ONE lock across a peek, the
 * commit itself, and a clear scoped to exactly what committed, so neither a
 * commit failure nor a same-path race loses anything.
 *
 * Guarded by the SAME per-session file lock every touched-paths mutation
 * takes: the read-then-remove here is mutually exclusive with a concurrent
 * accumulate or commitTouchedPaths call.
 *
 * A read/parse failure is NOT treated as an empty set to be cleared: like
 * clearTouchedPaths and commitTouchedPaths, a corrupt/unreadable file
 * (readTouchedPathsFile returns `null`) is left on disk untouched — never
 * deleted — so a transient I/O or parse error can't erase a set that a human
 * or a later pass could still recover. Drain returns `[]` in that case
 * (nothing safely consumable), but does not remove the file.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @returns {string[]} vault-relative paths, deduped; [] when absent, corrupt, or no session_id
 */
export function drainTouchedPaths(hypoDir, sessionId) {
  if (!sessionId) return [];
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const result = readTouchedPathsFile(path);
      if (result === null) return []; // corrupt/unreadable: leave the file for inspection, never delete
      try {
        rmSync(path, { force: true });
        pruneTouchedHashes(hypoDir, sessionId, []);
      } catch {
        // best-effort
      }
      return result;
    });
  } catch {
    // lock-timeout (or an unexpected lock error): fail closed to "nothing
    // drained" rather than risk reading concurrently with a writer. The set
    // stays on disk untouched, so it is still there for the next drain.
    return [];
  }
}

/**
 * Read a session's accumulated touched paths WITHOUT clearing them. Kept as
 * a standalone probe for callers that just want to inspect the set; the
 * Stop-chain auto-commit does NOT call this on its own — see
 * commitTouchedPaths, which performs an equivalent internal read but holds
 * the lock through the commit and clear that follow it too.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @returns {string[]} vault-relative paths, deduped; [] when absent, corrupt,
 *   no session_id, or a lock-timeout (fails closed to "nothing to commit" —
 *   the set stays on disk, untouched, for the next Stop)
 */
export function peekTouchedPaths(hypoDir, sessionId) {
  if (!sessionId) return [];
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const result = readTouchedPathsFile(path);
      return result === null ? [] : result;
    });
  } catch {
    return [];
  }
}

/**
 * Like `peekTouchedPaths`, but does not collapse "corrupt", "lock timeout"
 * and "empty" into the same silent `[]`. The close gate (every caller) treats
 * the three differently: a lock timeout is transient (another writer holds
 * the lock right now) and blocks so the retry reads the real set; a corrupt
 * file stays corrupt on every retry, so it is not a blocker of its own: it
 * widens the project folder being closed to every uncommitted file in it
 * (with the way out in the reason) instead of refusing every close for
 * good. `peekTouchedPaths`
 * itself is unchanged: its callers already treat its `[]` as
 * fail-safe-to-no-scope for a best-effort commit attempt.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {{timeoutMs?: number}} [opts] cap on the lock wait (default: the lock's own)
 * @returns {{state: 'ok'|'empty'|'unreadable'|'locked', paths: string[], cause?: 'corrupt'|'lock-failed'}}
 *   'ok': a non-empty set was read. 'empty': no session_id, or the file is
 *   absent/genuinely empty. 'unreadable': the file exists but is corrupt
 *   (`cause: 'corrupt'`), or the lock could not be taken for a reason other
 *   than a timeout, an unwritable directory (`cause: 'lock-failed'`). Deleting
 *   the file mends the first and not the second. 'locked': the per-session
 *   lock timed out. paths is always `[]` unless 'ok', since nothing safely
 *   known could be returned.
 */
export function readTouchedPathsStrict(hypoDir, sessionId, opts = {}) {
  if (!sessionId) return { state: 'empty', paths: [] };
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(
      path,
      () => {
        const result = readTouchedPathsFile(path);
        if (result === null) return { state: 'unreadable', paths: [], cause: 'corrupt' };
        return result.length === 0 ? { state: 'empty', paths: [] } : { state: 'ok', paths: result };
      },
      lockWaitOpts(opts),
    );
  } catch (err) {
    return err?.code === 'ELOCKTIMEOUT'
      ? { state: 'locked', paths: [] }
      : { state: 'unreadable', paths: [], cause: 'lock-failed' };
  }
}

/** The touched-paths lock wait of a reader that runs under a gate `deadline`: the lock's own cap
 * (5000 ms) or the time left, whichever is smaller. `{}` (the lock's own default) without a deadline. */
function touchedLockBudget(deadline) {
  return deadline ? { timeoutMs: Math.min(5000, remainingSpawnTimeoutMs(deadline)) } : {};
}

/** `withFileLock` options for a reader's optional `timeoutMs` (the lock wait cap): unset keeps the
 * lock's own default. */
function lockWaitOpts({ timeoutMs } = {}) {
  return Number.isFinite(timeoutMs) ? { timeoutMs: Math.max(0, timeoutMs) } : {};
}

/**
 * The paths in a session's touched-paths set whose bytes on disk no longer
 * match the hash recorded for them (see touchedHashesPath): another write
 * landed after this session recorded the path, so Stop keeps it out of the
 * auto-commit. A separate reader, not a new field on readTouchedPathsStrict,
 * so that function's `{state, paths}` shape stays exactly what its callers
 * compare against. Only for wording a blocker; `[]` on no session_id or a
 * lock timeout, since readTouchedPathsStrict already decides whether to block.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {{timeoutMs?: number}} [opts] cap on the lock wait (default: the lock's own)
 * @returns {string[]}
 */
export function readTouchedPathsDrifted(hypoDir, sessionId, opts = {}) {
  if (!sessionId) return [];
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(
      path,
      () => {
        const current = readTouchedPathsFile(path) || [];
        const hashes = readTouchedHashesFile(touchedHashesPath(hypoDir, sessionId));
        return current.filter((p) => recordedHashDrifted(hypoDir, hashes, p));
      },
      lockWaitOpts(opts),
    );
  } catch {
    return [];
  }
}

/**
 * Remove exactly `paths` from a session's touched-paths set — a set
 * difference, not a clear, and NOT a drain: any path a concurrent
 * PostToolUse (or Stop-chain generator) accumulated before this call is read
 * fresh under the SAME lock and therefore survives, because it was never in
 * `paths` to begin with.
 *
 * Called only after commitWikiChanges has ACTUALLY committed `paths` (or
 * confirmed there was nothing to commit) — never on a commit failure.
 *
 * Two failure modes this function must not turn into data loss (codex FIX 1
 * + FIX 2 review):
 *
 *   - A read/parse failure on the touched-paths file (readTouchedPathsFile
 *     returns `null`, NOT `[]`) must NOT be treated as "nothing left" — that
 *     would make the set difference below compute an empty remainder and
 *     DELETE the file outright on a transient I/O or parse error, losing
 *     every pending path. On `null`, this function does nothing at all:
 *     no write, no delete, the file is left exactly as it was.
 *   - If this clear itself fails (lock-timeout, I/O) after a successful
 *     read, the already-committed paths simply stay in the file: the next
 *     Stop re-peeks them and re-runs commitWikiChanges, which is a clean
 *     no-op (INTERSECT against a tree with no more changes at those paths
 *     yields an empty scoped set). Over-retention is safe by construction —
 *     it can never lose a path, only a commit failure (handled by leaving
 *     the file alone entirely, see commitTouchedPaths) can.
 *
 * Standalone use of peekTouchedPaths + clearTouchedPaths as two SEPARATE
 * lock acquisitions still carries the same-path race codex FIX 2 describes
 * (a write between the two calls is indistinguishable from the one already
 * peeked, since the set only tracks path presence, not a generation/version
 * per path) — that is exactly why the Stop hook uses commitTouchedPaths
 * instead, which holds ONE lock across the whole peek→commit→clear window
 * so no write can land inside it at all.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {string[]} paths the exact paths that were just committed
 */
export function clearTouchedPaths(hypoDir, sessionId, paths) {
  if (!sessionId) return;
  const toRemove = new Set((Array.isArray(paths) ? paths : []).filter(Boolean));
  if (toRemove.size === 0) return;
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    withFileLock(path, () => {
      const current = readTouchedPathsFile(path);
      if (current === null) return; // FIX 1: never delete/write on a read failure
      const remaining = current.filter((p) => !toRemove.has(p));
      if (remaining.length === 0) {
        try {
          rmSync(path, { force: true });
        } catch {
          // best-effort
        }
      } else {
        atomicWrite(path, JSON.stringify(remaining));
      }
      pruneTouchedHashes(hypoDir, sessionId, remaining);
    });
  } catch {
    // lock-timeout or unexpected error: leave the file as-is. Safe per the
    // over-retention argument above — the committed paths simply linger
    // until a later clear (or drain) removes them, at worst causing a
    // future no-op re-commit attempt, never a lost path.
  }
}

/**
 * Peek a session's touched paths, run `commitFn(paths)` (expected to be
 * `commitWikiChanges` or an equivalent), and — only when it reports
 * `committed: true` — clear `paths` from the touched-paths set, ALL under
 * ONE hold of the per-session file lock (codex FIX 2). This is what the
 * Stop-chain auto-commit uses instead of calling peekTouchedPaths,
 * commitFn, and clearTouchedPaths as three separate steps.
 *
 * Holding one lock across peek → commit → clear (rather than acquiring and
 * releasing it three times, with the commit itself unlocked in between)
 * closes a same-path race: without it, a `recordTouchedPaths` call for a
 * path already in the just-peeked set could land in the window between the
 * commit and the clear. Since the touched-paths set only tracks path
 * PRESENCE (no per-path version/generation), that accumulate call is
 * indistinguishable from the one already peeked — the clear would remove it
 * anyway, silently orphaning a real edit that was never actually committed
 * (it landed on disk after `git commit` already ran, but the touched-paths
 * record of it just got wiped). With one continuous lock hold, that
 * accumulate call either fully precedes the peek (so it's included in THIS
 * commit, since commitWikiChanges reads live git status, not a cached
 * snapshot) or fully follows the clear (so it's untouched, waiting for the
 * next Stop) — there is no window where it can land in between.
 *
 * Lock order stays vault → per-session everywhere in this codebase (the
 * Stop hook takes the vault lock before calling this; accumulation only
 * ever takes the per-session lock, never the vault lock), so holding the
 * per-session lock for the whole commit here introduces no new ordering and
 * no deadlock risk.
 *
 * FIX 1 (read/parse failure) applies here too: a corrupt/unreadable
 * touched-paths file is never treated as empty. `commitFn` still runs (with
 * an empty scope — a safe no-op through commitWikiChanges), but nothing is
 * ever written to the corrupt file; it is left exactly as it was for a
 * human or a future recovery pass to look at.
 *
 * A `committed: true` result clears the whole peeked scope EXCEPT
 * `result.ignoredPaths`: the paths `commitFn` reports as still dirty but kept
 * out of the commit by `.hypoignore`. Those stay in the touched-paths set,
 * still blocking as a known, unresolved session write, instead of reading as
 * "resolved" because their siblings committed. Everything else is retired,
 * including a claim that was already clean at Stop time or that the caller
 * deliberately left out of the scope (a generated view path, which
 * `commitWikiChanges` never commits): keeping those would let a path
 * another session later edits be blocked on, or swept into, this session's
 * next commit. A `commitFn` that reports no `ignoredPaths` (an older or
 * test-only stand-in for `commitWikiChanges`) keeps nothing, the plain
 * whole-scope clear.
 *
 * `commitFn` does not always get the whole set. A path whose bytes on disk
 * differ from the hash recorded for it (touchedHashesPath) is left out, and
 * is then either retired (HEAD already holds the recorded bytes, or the file
 * is clean) or kept alongside `ignoredPaths` (another write landed after the
 * record). The same-session case this also catches, a Bash rewrite of a
 * path after its last Edit, is left out too: the conservative direction.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {(paths: string[]) => {committed: boolean, ignoredPaths?: string[], [k: string]: unknown}} commitFn
 * @returns {{committed: boolean, [k: string]: unknown}} whatever `commitFn` returned,
 *   or `{committed: false, reason: 'touched-paths-lock-timeout'}` if the lock
 *   itself could not be acquired (commitFn never ran; the file is untouched)
 */
export function commitTouchedPaths(hypoDir, sessionId, commitFn) {
  if (!sessionId) return commitFn([]);
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const current = readTouchedPathsFile(path);
      if (current === null) {
        // FIX 1: a read/parse failure is not "empty" — commit nothing this
        // round (a safe no-op scope) and leave the corrupt file untouched,
        // rather than let a downstream clear compute "nothing left" and
        // delete it.
        return commitFn([]);
      }
      // Content check before the commit, for every path that has a recorded
      // hash (see touchedHashesPath). Bytes still equal to what this session
      // recorded go into the scope. Anything else is left out of THIS commit,
      // because the bytes on disk are no longer the ones this session wrote:
      //   - HEAD already holds the recorded bytes: an old claim whose commit
      //     landed but whose clear failed. Retired, so another session's
      //     later edit of the path is never swept in under it.
      //   - HEAD already holds the bytes on disk and the index does too: nothing is dirty.
      //     Retired. An index that still holds other bytes keeps the claim.
      //   - neither: some other write landed after this session recorded the
      //     path. Kept, so the checkpoint gate still blocks on it and says
      //     why (readTouchedPathsDrifted), instead of the path reading as
      //     ownerless.
      // A path with no recorded hash (a set from before hashes existed, an
      // unreadable file) goes into the scope as before.
      const hashes = readTouchedHashesFile(touchedHashesPath(hypoDir, sessionId));
      const scope = [];
      const driftKept = [];
      for (const p of current) {
        if (!recordedHashDrifted(hypoDir, hashes, p)) {
          scope.push(p);
          continue;
        }
        const head = headFileHash(hypoDir, p);
        if (head === hashes[p]) continue;
        // The worktree is back at HEAD, but the claim is spent only if the index agrees. An index
        // still holding this session's bytes would be committed under no claim at all. An index git
        // cannot read keeps the claim.
        if (head === vaultFileHash(hypoDir, p)) {
          const blobs = indexAndHeadBlobs(hypoDir, p);
          if (blobs && blobs.index === blobs.head) continue;
        }
        driftKept.push(p);
      }
      const result = commitFn(scope);
      if (result && result.committed && current.length > 0) {
        // Still under the SAME lock acquired above: no recordTouchedPaths
        // call for this session can have landed since `current` was read
        // (it takes this exact lock too), so the set on disk right now is
        // EXACTLY `current`, the removal below needs no re-read.
        const keep = new Set([
          ...(Array.isArray(result.ignoredPaths) ? result.ignoredPaths : []),
          ...driftKept,
        ]);
        const remaining = current.filter((p) => keep.has(p));
        if (remaining.length < current.length) {
          try {
            if (remaining.length === 0) {
              rmSync(path, { force: true });
            } else {
              atomicWrite(path, JSON.stringify(remaining));
            }
            pruneTouchedHashes(hypoDir, sessionId, remaining);
          } catch {
            // best-effort: the retired paths just linger on disk; the next
            // Stop re-peeks them and re-runs commitFn, a clean no-op.
          }
        }
      }
      return result;
    });
  } catch {
    // Lock-timeout (or an unexpected lock error): never entered the
    // critical section, so commitFn never ran and nothing was peeked or
    // cleared. The touched-paths file is untouched on disk, and the next
    // Stop retries this session's commit from the same scope.
    return { committed: false, reason: 'touched-paths-lock-timeout' };
  }
}

/**
 * The lock target both commit loci (hypo-auto-commit.mjs Stop hook,
 * crystallize.mjs --apply-session-close) hold while staging+committing (and,
 * for the Stop hook, syncing) the vault, so two concurrent sessions on a
 * shared vault never interleave `git add`/`git commit`/`git pull`/`git push`.
 * A stable, non-content path — withFileLock only ever touches its `.lock`
 * sibling, this file itself is never created.
 */
export function vaultCommitLockTarget(hypoDir) {
  return join(hypoDir, '.cache', 'vault-commit');
}

// `.cache/auto-staged.json`: {<vault path>: {blob, headBlob}} for the blob hypo-auto-stage staged for
// a path and the blob HEAD held for that path at that moment (`null` when HEAD had none). `.cache/`
// is gitignored, so it never syncs or commits. Writers hold the vault commit lock (the auto-stage
// hook and commitWikiChanges' caller), and the update takes the file's own lock too.
function autoStagedPath(hypoDir) {
  return join(hypoDir, '.cache', 'auto-staged.json');
}

// `.cache/index-reconcile.json`: {<vault path>: {index, head}} for a commit's post-commit reset: the
// index blob the reset is meant to replace, and the blob HEAD held for the path before the commit.
// Written before the commit, dropped when the reset succeeded or the commit was refused, and kept
// when the reset failed, so the next commitWikiChanges can finish it (only if HEAD moved).
function indexReconcilePath(hypoDir) {
  return join(hypoDir, '.cache', 'index-reconcile.json');
}

// A missing or unreadable record is `{}`.
function readCacheRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// `timeoutMs` caps the lock wait (a hook with a time budget passes what is left); without it the
// wait is `withFileLock`'s default.
function updateCacheRecord(path, mutate, { timeoutMs } = {}) {
  withFileLock(
    path,
    () => {
      // An unreadable record starts over: a lost entry only means one more backup later.
      const record = readCacheRecord(path);
      mutate(record);
      // An empty record is no file, so a commit that leaves nothing to remember leaves no trace in a
      // vault whose `.gitignore` has no `.cache/` line.
      if (Object.keys(record).length === 0) rmSync(path, { force: true });
      else atomicWrite(path, JSON.stringify(record));
    },
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

/** The recorded auto-stage blobs. A missing or unreadable record is `{}`: nothing is skipped. */
export function readAutoStagedRecord(hypoDir) {
  return readCacheRecord(autoStagedPath(hypoDir));
}

/**
 * Remember that hypo-auto-stage staged `blob` for `relPath` while HEAD held `headBlob` for it, so a
 * commit does not back it up.
 */
export function recordAutoStagedBlob(hypoDir, relPath, blob, headBlob, { timeoutMs } = {}) {
  updateCacheRecord(
    autoStagedPath(hypoDir),
    (record) => {
      record[relPath] = { blob, headBlob: headBlob ?? null };
    },
    { timeoutMs },
  );
}

/**
 * The one rule for "this staged blob is hypo-auto-stage's own, not a person's": `record` names
 * `blob` for `relPath`, and HEAD's blob for the path (`headBlob`, `null` when HEAD has none) is
 * still the one recorded with it. Once HEAD moves the record is stale (a person may have staged the
 * same bytes since), and an entry in the old string format has no HEAD blob to compare, so neither
 * is trusted. The auto-stage hook and `backUpStagedVersions` both decide through this.
 */
export function isAutoStagedBlob(record, relPath, blob, headBlob) {
  const entry = record?.[relPath];
  return (
    !!entry &&
    typeof entry === 'object' &&
    entry.blob === blob &&
    entry.headBlob === (headBlob ?? null)
  );
}

/**
 * A staged deletion: HEAD has the path and the index holds no entry for it at any stage (a `git rm`).
 * The auto-stage hook leaves such a path alone, and the commit says so when it replaces the deletion.
 * @param {string|null} headBlob HEAD's blob for the path, `null` when HEAD has none
 * @param {boolean} indexed whether the index has an entry for the path at any stage
 */
export function isStagedDeletion(headBlob, indexed) {
  return headBlob != null && !indexed;
}

/**
 * The stage-0 index blob and HEAD's blob for one vault path (`null` when absent; an unborn HEAD has
 * no blobs), and whether the index has an entry for it at any stage. `null` for the whole result
 * when git cannot answer about the index (or `deadline` has run out).
 * @returns {{index: string|null, head: string|null, indexed: boolean}|null}
 */
export function indexAndHeadBlobs(hypoDir, relPath, { deadline } = {}) {
  // With a `deadline` each git call is cut to the time left, and no time left is `null` (git did
  // not answer about the index), the answer callers already skip on.
  const git = (args) => {
    const timeout = remainingSpawnTimeoutMs(deadline);
    return timeout === 0 ? { error: true } : vaultGit(hypoDir, args, timeout ? { timeout } : {});
  };
  const ls = git(['ls-files', '-s', '--', relPath]);
  if (ls.error || ls.status !== 0) return null;
  const tree = git(['ls-tree', 'HEAD', '--', relPath]);
  return {
    index: /^\d+ ([0-9a-f]+) 0\t/m.exec(ls.stdout || '')?.[1] ?? null,
    head:
      !tree.error && tree.status === 0
        ? (/^\d+ blob ([0-9a-f]+)\t/m.exec(tree.stdout || '')?.[1] ?? null)
        : null,
    indexed: (ls.stdout || '').trim() !== '',
  };
}

// Forget the entries of paths a commit just took, so the record holds only paths still pending.
// Best-effort: HEAD moving with the commit makes a leftover entry untrusted anyway.
function dropAutoStagedBlobs(hypoDir, relPaths) {
  try {
    if (!Object.keys(readAutoStagedRecord(hypoDir)).some((p) => relPaths.includes(p))) return;
    updateCacheRecord(autoStagedPath(hypoDir), (record) => {
      for (const p of relPaths) delete record[p];
    });
  } catch {
    // keep the commit result; the record is a cache
  }
}

// Journal for the post-commit reset (see `indexReconcilePath`). Both writes are best-effort: a
// journal that cannot be written only means a failed reset has no retry, as it had none before.
// An entry already there is an earlier failed reset still waiting for its retry, and it is kept:
// the stale index is that entry's, not this call's. Returns the paths this call newly wrote, the
// only ones its own refusal may take back out.
function journalIndexBlobs(hypoDir, blobs) {
  const written = [];
  try {
    updateCacheRecord(indexReconcilePath(hypoDir), (record) => {
      written.length = 0;
      for (const [path, entry] of Object.entries(blobs)) {
        if (record[path] && typeof record[path] === 'object') continue;
        record[path] = entry;
        written.push(path);
      }
    });
  } catch {
    return [];
  }
  return written;
}

function dropIndexJournal(hypoDir, relPaths) {
  try {
    updateCacheRecord(indexReconcilePath(hypoDir), (record) => {
      for (const p of relPaths) delete record[p];
    });
  } catch {
    // best-effort
  }
}

// Finish a post-commit reset that failed earlier. A journaled path is stale residue of that commit,
// and is reset to HEAD, only when all three hold: its index blob is still the journaled one (any
// other blob was staged by a person since), HEAD's blob for it is no longer the one recorded before
// the commit (the commit landed; a refused or interrupted one never moved HEAD, and then the index
// is the person's), and the index differs from HEAD. Every entry is dropped except those whose
// reset itself failed, and that failure comes back as a warning for the caller to forward. The
// caller holds the vault commit lock.
// @returns {string|undefined} the warning when a reset failed
function reconcileStaleIndex(hypoDir) {
  const journal = readCacheRecord(indexReconcilePath(hypoDir));
  const paths = Object.keys(journal);
  if (paths.length === 0) return undefined;
  const ls = vaultGit(hypoDir, ['ls-files', '-s', '-z', '--', ...paths]);
  if (ls.error || ls.status !== 0) return undefined; // keep the entries for the next call
  const index = new Map();
  for (const rec of (ls.stdout || '').split('\0')) {
    const m = /^\d+ ([0-9a-f]+) 0\t([\s\S]*)$/.exec(rec);
    if (m) index.set(m[2], m[1]);
  }
  const head = new Map();
  const tree = vaultGit(hypoDir, ['ls-tree', '-r', '-z', 'HEAD', '--', ...paths]);
  if (tree.error || tree.status !== 0) return undefined; // HEAD unreadable: decide next call
  for (const rec of tree.stdout.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
    if (m) head.set(m[2], m[1]);
  }
  const stale = paths.filter((p) => {
    const entry = journal[p];
    const now = head.get(p) ?? null;
    return (
      !!entry &&
      typeof entry === 'object' &&
      index.get(p) === entry.index &&
      now !== (entry.head ?? null) &&
      index.get(p) !== now
    );
  });
  const reset =
    stale.length > 0 ? vaultGit(hypoDir, ['reset', '-q', 'HEAD', '--', ...stale]) : { status: 0 };
  dropIndexJournal(hypoDir, reset.status === 0 ? paths : paths.filter((p) => !stale.includes(p)));
  if (reset.status === 0) return undefined;
  return `the index of ${stale.join(', ')} was not brought to HEAD after an earlier commit (${(reset.stderr || '').trim() || 'unknown'}); run \`git reset -q HEAD -- ${stale.map(shellQuote).join(' ')}\` before any plain git commit`;
}

// A path for a POSIX shell command line: bare when it has only safe characters, else in single
// quotes with each embedded single quote written as `'\''`.
function shellQuote(path) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** `projects/<slug>/...` → `<slug>`; anything else → its first path segment. */
function projectOfPath(relPath) {
  const parts = relPath.split('/');
  if (parts[0] === 'projects' && parts.length > 1 && parts[1]) return parts[1];
  return parts[0] || relPath;
}

/**
 * Save every version a person staged for one of `commitScope` that the commit is about to replace:
 * the stage-0 index blob that is neither HEAD's blob for the path (for a rename's destination, the
 * source path's HEAD blob counts too), nor the work tree's blob, which is what gets committed, nor
 * the blob hypo-auto-stage recorded for the path (`isAutoStagedBlob`: only while HEAD's blob for the
 * path is still the one recorded with it).
 * Each lands under `.cache/backups/staged/<path>` through `backUpGeneratedPath`, so a retry that
 * finds the same bytes already saved reuses that file. Throws when a blob cannot be read or the
 * backup cannot be written or announced; the caller then commits nothing. The health notice for a
 * backup is written right after the backup, before the caller stages anything, so a later failure
 * cannot leave a saved version nobody was told about.
 * @param {string} hypoDir
 * @param {string[]} commitScope vault-relative paths about to be staged and committed
 * @param {Map<string, string>} renamedFrom rename destination -> source path
 * @param {string} lsStaged `git ls-files -s -z --full-name` output for `commitScope`
 * @param {(f: string) => string|null} toVaultRelative repository path -> vault path
 * @param {Map<string, string>} head vault path -> HEAD's blob, for `commitScope` (none on an unborn HEAD)
 * @returns {{path: string, backupPath: string}[]}
 */
function backUpStagedVersions(hypoDir, commitScope, renamedFrom, lsStaged, toVaultRelative, head) {
  const staged = new Map(); // vault path -> stage-0 blob
  const indexed = new Set(); // vault paths with an index entry at any stage
  for (const rec of (lsStaged || '').split('\0')) {
    const any = /^\d+ [0-9a-f]+ \d\t([\s\S]*)$/.exec(rec);
    const anyRel = any && toVaultRelative(any[1]);
    if (anyRel) indexed.add(anyRel);
    const m = /^\d+ ([0-9a-f]+) 0\t([\s\S]*)$/.exec(rec);
    const rel = m && toVaultRelative(m[2]);
    if (rel) staged.set(rel, m[1]);
  }

  // A staged deletion (`git rm`) of a path that is back in the work tree: the add below puts the new
  // content over it and the commit takes that. HEAD keeps the old bytes, so nothing is lost, but
  // the deletion is gone from the index afterwards, so the notice says how to redo it. A plain
  // rename's source is skipped by the work-tree check: `git mv` leaves no file there. A file that
  // reappears at a renamed-away source does replace that staged deletion, so it is announced too.
  for (const path of commitScope) {
    if (
      !isStagedDeletion(head.get(path) ?? null, indexed.has(path)) ||
      !isFileOrLink(join(hypoDir, path))
    )
      continue;
    const noticed = writeRootHotHealthNotice(
      hypoDir,
      `index 에 올려 둔 ${path} 의 삭제를 새 파일 내용이 대신해, 이어지는 커밋에는 새 내용이 들어갑니다(커밋이 실패하거나 커밋할 것이 없으면 삭제는 index 에 그대로 남습니다). ` +
        `이전 내용은 HEAD 이력에 남아 있습니다. 파일을 지우려면 커밋 뒤에 \`git rm -- ${shellQuote(path)}\` 를 다시 실행하세요.`,
    );
    if (!noticed)
      throw new Error(`the notice for the staged deletion of ${path} could not be written`);
  }
  if (staged.size === 0) return [];

  // `hash-object` applies the same attribute filters `git add` does, so equal bytes hash equal. A
  // failed hash leaves the work tree blob unknown, which only makes the comparison save more.
  const onDisk = [...staged.keys()].filter((p) => statIs(join(hypoDir, p), 'file'));
  const work = new Map();
  if (onDisk.length > 0) {
    const hashed = vaultGit(hypoDir, ['hash-object', '--', ...onDisk]);
    const lines = hashed.status === 0 ? hashed.stdout.split('\n').filter(Boolean) : [];
    if (lines.length === onDisk.length) onDisk.forEach((p, i) => work.set(p, lines[i]));
  }

  // The blob hypo-auto-stage itself staged for a path is Claude's own write, not a person's. With
  // no record, a stale one or one that cannot be read, nothing is skipped and the blob is saved.
  const autoStaged = readAutoStagedRecord(hypoDir);
  const toSave = [...staged].filter(
    ([path, blob]) =>
      !(
        blob === head.get(path) ||
        blob === head.get(renamedFrom.get(path)) ||
        blob === work.get(path) ||
        isAutoStagedBlob(autoStaged, path, blob, head.get(path) ?? null)
      ),
  );
  // The backups hold a person's own bytes: none is written while a `git add -A` would stage them.
  // The commit is refused here, before anything is staged, and their stage stays where it is.
  if (toSave.length > 0) {
    const unignored = unignoredCachePaths(hypoDir);
    if (unignored.length > 0) {
      const noticed = writeRootHotHealthNotice(
        hypoDir,
        `${cacheNotIgnoredNotice(unignored)} 올려 둔 버전은 index 에 그대로 남고 커밋은 미뤄졌습니다.`,
      );
      throw new Error(
        `.cache/ is not ignored (${unignored.join(', ')}), so no backup is written${noticed ? '' : ' and the notice could not be written'}`,
      );
    }
  }
  const saved = [];
  for (const [path, blob] of toSave) {
    const content = spawnSync('git', ['-C', hypoDir, 'cat-file', 'blob', blob], {
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (content.status !== 0)
      throw new Error(
        `git cat-file failed for ${path}: ${String(content.stderr).trim() || 'unknown'}`,
      );
    const backupPath = backUpGeneratedPath(hypoDir, join(hypoDir, 'staged', path), content.stdout);
    // The commit that follows holds the work tree bytes, so this backup is the only copy of the
    // person's version. The notice goes out now, not after the commit.
    const noticed = writeRootHotHealthNotice(
      hypoDir,
      `index 에 올려 둔 ${path} 의 버전이 작업 파일과 달라 ${backupPathForNotice(backupPath)} 로 백업했습니다. ` +
        '이어지는 커밋에는 작업 파일 내용이 들어갑니다(커밋이 실패하거나 커밋할 것이 없으면 올려 둔 버전은 index 에 그대로 남습니다). ' +
        '열어 본 뒤 필요한 내용을 반영하고 백업은 지우세요.',
    );
    if (!noticed) throw new Error(`the notice for the backup of ${path} could not be written`);
    saved.push({ path, backupPath });
  }
  return saved;
}

// The paths a commit just took whose index entry is another blob than the one journaled before it
// and still differs from HEAD: staged after the commit by something else, and left staged. Names
// them in a durable notice. Returns the message instead when the notice could not be written, so the
// caller's warning carries it.
function noticeStagedAfterCommit(hypoDir, git, kept) {
  if (kept.length === 0) return undefined;
  const differing = git('diff', '--cached', '--name-only', '--relative', '-z', '--', ...kept);
  const paths =
    differing.status === 0 ? (differing.stdout || '').split('\0').filter(Boolean) : kept;
  if (paths.length === 0) return undefined;
  const message =
    `커밋 직후 ${paths.join(', ')} 의 index 에 다른 내용이 올라와 HEAD 로 되돌리지 않고 그대로 두었습니다(post-commit 훅 같은 것이 올렸을 수 있습니다). ` +
    `필요 없으면 \`git reset -q HEAD -- ${paths.map(shellQuote).join(' ')}\` 로 되돌리세요.`;
  return writeRootHotHealthNotice(hypoDir, message) ? undefined : message;
}

/**
 * Stage + commit ONLY the caller-supplied `paths`, intersected with what is
 * actually changed on disk right now. Does NOT pull/push; remote
 * sync stays in the auto-commit Stop hook (commit is local + cheap; sync is
 * network + soft-fail). Shared by hypo-auto-commit.mjs and crystallize.mjs's
 * --apply-session-close path so the .hypoignore staging filter cannot diverge
 * between the two commit loci.
 *
 * The caller supplies the scope; this function never re-derives it from the
 * whole tree. `paths` absent/empty is a clean no-op (`scoped: 0`), not an
 * error and not a whole-tree fallback — this is how a caller with nothing to
 * contribute (e.g. no session_id, so nothing was accumulated) skips cleanly.
 * It still finishes an earlier commit's failed index reset (`reconcileStaleIndex`) and reports a
 * failure of that as `indexWarning`.
 *
 * The authoritative scope is INTERSECT(paths, currently-changed): a stale
 * entry (already committed elsewhere, or never actually changed) is dropped
 * silently rather than erroring. `.hypoignore` filtering, the staged
 * re-derivation, the commit-message count, and the final commit all use this
 * SAME scoped set — no step here may widen back to whole-tree, or another
 * session's dirty/staged files could slip back in through any one of them.
 *
 * "Nothing to commit" (empty scope, or only .hypoignore'd changes) is
 * SUCCESS, not failure — the caller's tree is already in the state it wanted.
 *
 * @param {string} hypoDir
 * @param {string[]} [paths] vault-relative paths this caller wrote/owns this close. Generated view
 *   paths (`isGeneratedViewPath`) are dropped from it before anything else.
 * @returns {{committed: boolean, scoped?: number, sha?: string|null, committedPaths?: string[], ignoredPaths?: string[], stagedBackups?: {path: string, backupPath: string}[], reason?: string, indexWarning?: string}}
 *   committed:true when a commit was created OR nothing needed committing
 *   (scoped:0 in the latter case); committed:false (with reason) on a real
 *   failure: not a git repo, or git status/add/commit erroring. `sha` is the
 *   commit this call created, and is present ONLY on that branch: a
 *   `scoped: 0` success created no commit, so it carries no sha rather than
 *   an unrelated HEAD a caller could tell someone to revert. It is `null`
 *   when the commit succeeded but reading its hash did not. `committedPaths`
 *   is present on every `committed: true` outcome, `[]` for a no-op, and
 *   names exactly the paths THIS call actually staged into the commit (the
 *   rename-collapsed destination set `git diff --cached --name-only` itself
 *   reports). `ignoredPaths` (also on every `committed: true` outcome) names
 *   the supplied paths that ARE dirty but were kept out of the commit only
 *   because `.hypoignore` matches them, so a caller clearing a per-session
 *   pending-write set (Stop's `commitTouchedPaths`) can keep exactly those as
 *   unresolved. A path is also listed there when it is the destination of a
 *   rename whose source is a generated view: that pair is left out whole.
 *   A stale or already-clean supplied path is never listed: nothing about it
 *   is left unresolved. On a failed add or commit the index entries of this
 *   call's paths are put back as they were (the `reason` says so when that
 *   fails too). After a commit every committed path's index entry is the new
 *   HEAD, except one that something staged after the commit (its blob is not the one journaled before
 *   it): that stays staged and a health notice names it. A version a person had staged for a committed path, when it differs
 *   from HEAD's and from the bytes committed, is saved first under
 *   `.cache/backups/staged/`: `stagedBackups` names each `{path, backupPath}`
 *   and a health notice, written right after each backup, says so. When nothing ends up to commit
 *   the saved entries are put back in the index (a person's stage is not cleared by a no-op). A
 *   staged deletion (`git rm`) of a committed path whose file is back in the work tree is replaced
 *   by the new content, with a notice that says how to redo the deletion. `indexWarning` is present
 *   only when a commit landed but index entries could not be brought to HEAD afterwards: its own
 *   paths', or those of an earlier commit whose reset this call retried and failed again.
 */
export function commitWikiChanges(hypoDir, paths) {
  const git = (...args) =>
    spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', timeout: 30000 });
  if (git('rev-parse', '--is-inside-work-tree').status !== 0)
    return { committed: false, reason: `not a git repository: ${hypoDir}` };

  // A generated view (`hot.md`, `projects/<p>/hot.md`, `projects/<p>/session-state.md`) is rendered
  // on every machine and never committed here, whether a caller names it or not. The migration and
  // the rollback commit views through their own path, not this function.
  const supplied = new Set(
    (Array.isArray(paths) ? paths : []).filter(
      (p) => typeof p === 'string' && p.length > 0 && !isGeneratedViewPath(p),
    ),
  );

  // A reset that failed after an earlier commit is finished first, while the caller's vault lock is
  // held, so this call's own scope starts from an index that matches HEAD. It runs before the
  // empty-scope return too: an idle Stop is the retry for a reset that failed, and its warning
  // comes back on every outcome that follows.
  const reconcileWarning = reconcileStaleIndex(hypoDir);
  const withWarning = (outcome) =>
    reconcileWarning ? { ...outcome, indexWarning: reconcileWarning } : outcome;

  if (supplied.size === 0)
    return withWarning({ committed: true, scoped: 0, committedPaths: [], ignoredPaths: [] });

  // `-z`: NUL-separated records with verbatim paths — no surrounding quotes and
  // no octal escaping, so non-ASCII paths (Korean page names are normal input
  // here) survive intact. Without it, `core.quotepath=true` (the default) yields
  // `"pages/\355\225\234\352\270\200.md"` and the old quote-strip parser fed that
  // literal, non-existent path to `git add` — failing the whole commit.
  const porcelain = git('status', '--porcelain', '-uall', '-z');
  if (porcelain.status !== 0)
    return { committed: false, reason: `git status failed in ${hypoDir}` };
  // porcelain paths are repository-root relative, while `supplied` and every
  // pathspec below are vault relative (git resolves pathspecs against -C). A
  // vault nested inside a larger repository therefore needs its prefix
  // stripped before matching, the same rule gitDirtyFiles uses; a record
  // outside the vault is out of scope.
  const prefixRes = git('rev-parse', '--show-prefix');
  if (prefixRes.status !== 0)
    return { committed: false, reason: `git rev-parse --show-prefix failed in ${hypoDir}` };
  const prefix = (prefixRes.stdout || '').replace(/\r?\n$/, '');
  const toVaultRelative = (f) => {
    if (!f || !prefix) return f || null;
    return f.startsWith(prefix) ? f.slice(prefix.length) : null;
  };
  // `.hypoignore` is the project privacy boundary. `git add -A` ignores it, so
  // enumerate changed paths, drop ignored ones, then stage explicitly.
  const ignorePatterns = loadHypoIgnore(hypoDir);
  const scoped = []; // pathspec for `git add -A` — worktree/index paths only
  const commitScope = []; // pathspec for the final diff/commit --only (superset)
  const ignoredPaths = []; // supplied, dirty, but kept out of the commit on purpose
  const renamedFrom = new Map(); // rename destination -> its source path
  const records = (porcelain.stdout || '').split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const file = toVaultRelative(rec.slice(3)); // `XY <path>`; the destination for a rename/copy
    const isRename = xy[0] === 'R' || xy[1] === 'R';
    // A rename OR copy emits two records (`to\0from`); consume the trailing
    // `from`. Copy `C` records only appear under `status.renames=copies`, but
    // when they do, missing this skip feeds the `from` path to `git add` as a
    // bogus pathspec — the exact auto-commit failure this parser fixes.
    let fromFile = null;
    if (isRename || xy[0] === 'C' || xy[1] === 'C') {
      i++;
      fromFile = toVaultRelative(records[i] || null);
    }
    if (!file) continue;
    if (!supplied.has(file)) continue; // out of this caller's scope
    // The source half of a rename is a generated view: committing the pair would commit the view's
    // deletion, which this function never does. The whole pair stays out, and it stays reported as
    // unresolved so a caller clearing a pending set does not retire a path that was not committed.
    if (isRename && fromFile && isGeneratedViewPath(fromFile)) {
      ignoredPaths.push(file);
      continue;
    }
    if (isExcludedFromCommit(hypoDir, file, ignorePatterns)) {
      ignoredPaths.push(file);
      continue;
    }
    scoped.push(file);
    commitScope.push(file);
    // A rename's `from` path is the SAME change as its destination — without
    // it, `git commit --only` on the destination alone commits the addition
    // but leaves the source's deletion staged as residue (a git --only
    // quirk, verified). It is NOT added to `git add -A` (the deletion is
    // already staged by the rename itself, and its worktree entry is gone —
    // `git add -A -- <a gone-and-already-staged path>` errors "did not match
    // any files"), only to the commit's pathspec. A copy's `from` is
    // independently-owned, still-existing content, so it is NOT auto-pulled
    // in at all: the caller must name it explicitly if it wants it in scope.
    if (isRename && fromFile) {
      commitScope.push(fromFile);
      renamedFrom.set(file, fromFile);
    }
  }
  if (scoped.length === 0 && commitScope.length === 0)
    return withWarning({ committed: true, scoped: 0, committedPaths: [], ignoredPaths });

  // A held `index.lock` (another git process mid-operation, or a stale one) would fail the staging
  // below, and the restore after a failure needs the same lock. Stop here, before anything is saved
  // or staged, so the reason names the lock and the caller keeps its pending scope for the next try.
  const indexPath = git('rev-parse', '--git-path', 'index');
  if (indexPath.status !== 0)
    return { committed: false, reason: `git rev-parse --git-path index failed in ${hypoDir}` };
  const indexLock = `${resolvePath(hypoDir, (indexPath.stdout || '').trim())}.lock`;
  if (existsSync(indexLock))
    return {
      committed: false,
      reason: `git index is locked (${indexLock}): another git process is running, or the lock is stale`,
    };

  // The real index entries of this call's paths before it stages anything, so a
  // failed add or commit can put them back. Left staged, they would ride along
  // with the next plain `git commit` anyone runs in this tree (a new session
  // entry included). `--full-name` because `--index-info` reads repository-root
  // paths. A crash between the add and the restore still leaves them staged.
  const before = git('ls-files', '-s', '-z', '--full-name', '--', ...commitScope);
  if (before.status !== 0)
    return {
      committed: false,
      reason: `git ls-files failed: ${(before.stderr || '').trim() || 'unknown'}`,
    };
  // HEAD's blob for each path of the scope before this call touches anything (an unborn HEAD has
  // none). The post-commit journal records it, and the staged-version backup reads it too.
  const headTree = git('ls-tree', '-r', '-z', 'HEAD', '--', ...commitScope);
  const headBlobs = new Map();
  if (headTree.status === 0) {
    for (const rec of (headTree.stdout || '').split('\0')) {
      const m = /^\d+ blob ([0-9a-f]+)\t([\s\S]*)$/.exec(rec);
      if (m) headBlobs.set(m[2], m[1]);
    }
  }
  // A failed tree read on a HEAD that exists leaves the pre-commit blobs unknown: no journal then.
  const headKnown =
    headTree.status === 0 || git('rev-parse', '--verify', '-q', 'HEAD').status !== 0;
  let journaled = []; // the journal entries this call newly wrote (a refusal takes only these back)
  const restoreIndex = () => {
    const removed = git('update-index', '--force-remove', '--', ...commitScope);
    return removed.status === 0 && before.stdout
      ? spawnSync('git', ['-C', hypoDir, 'update-index', '-z', '--index-info'], {
          input: before.stdout,
          encoding: 'utf-8',
          timeout: 30000,
        })
      : removed;
  };
  const failed = (reason) => {
    const restored = restoreIndex();
    // Whatever the outcome, no commit landed, so the journal has nothing to finish.
    dropIndexJournal(hypoDir, journaled);
    if (restored.status !== 0)
      return {
        committed: false,
        reason: `${reason}; the index was not restored: ${(restored.stderr || '').trim() || 'unknown'}`,
      };
    return { committed: false, reason };
  };

  // Staging puts the work tree bytes over whatever a person had staged for a path, and the commit
  // takes the same bytes. A staged version that is neither HEAD's nor the work tree's would be gone
  // from the index afterwards, and from HEAD too, so it is saved before anything is staged.
  let stagedBackups;
  try {
    stagedBackups = backUpStagedVersions(
      hypoDir,
      commitScope,
      renamedFrom,
      before.stdout,
      toVaultRelative,
      headBlobs,
    );
  } catch (err) {
    return {
      committed: false,
      reason: `could not save a version staged in the index before committing: ${err?.message ?? String(err)}`,
    };
  }

  if (scoped.length > 0) {
    const add = git('add', '-A', '--', ...scoped);
    if (add.status !== 0)
      return failed(`git add failed: ${(add.stderr || '').trim() || 'unknown'}`);
  }

  // Re-derive from what actually landed in the index, bounded by the SAME
  // pathspec (commitScope, the rename-aware superset of `scoped`): this step
  // must not widen back to whole-tree either, or another session's already-
  // staged file would slip into the commit here.
  // `--relative`: name the staged paths from the vault, like everything above.
  const staged = git('diff', '--cached', '--name-only', '--relative', '-z', '--', ...commitScope);
  if (staged.status !== 0)
    return failed(`git diff --cached failed: ${(staged.stderr || '').trim() || 'unknown'}`);
  const stagedFiles = (staged.stdout || '').split('\0').filter(Boolean);
  if (stagedFiles.length === 0) {
    // Nothing differs from HEAD, but the add above may have put the work tree bytes over a version
    // a person staged for one of these paths. No commit takes their place, so put the entries back.
    const restored = restoreIndex();
    if (restored.status !== 0)
      return {
        committed: false,
        reason: `nothing to commit, and the index was not restored: ${(restored.stderr || '').trim() || 'unknown'}`,
      };
    return withWarning({ committed: true, scoped: 0, committedPaths: [], ignoredPaths });
  }

  const projects = new Set(stagedFiles.map(projectOfPath));
  const today = new Date().toISOString().slice(0, 10);
  const msg = `auto: ${today} wiki update (${stagedFiles.length} paths across ${projects.size} projects)`;

  // `git commit --only -- <paths>` (first use of --only in this repo): commits
  // ONLY the staged changes under this pathspec, ignoring anything else
  // staged in the index, e.g. another session's own staged-but-uncommitted
  // work sharing this working tree. A bare `git commit -m` would sweep in
  // every staged path, defeating the whole point of the scoped set above.
  //
  // Pathspec is `commitScope`, NOT `stagedFiles`: `git diff --name-only`
  // collapses a rename to its destination alone (rename detection folds the
  // pair into one line), so re-deriving the commit's own pathspec from that
  // output would silently drop the `from` path again and reproduce the
  // exact `--only`-leaves-the-deletion-staged residue this function's rename
  // handling exists to avoid (verified). `stagedFiles` still governs the
  // empty-scope check and the N/M count above, both correct as "how many
  // logical changes", where a rename is rightly one.
  // Journal first: the index blobs the post-commit reset below is meant to replace. If that reset
  // fails, the next call finishes it (`reconcileStaleIndex`).
  const added = new Map();
  for (const rec of (git('ls-files', '-s', '-z', '--', ...commitScope).stdout || '').split('\0')) {
    const m = /^\d+ ([0-9a-f]+) 0\t([\s\S]*)$/.exec(rec);
    if (m) added.set(m[2], m[1]);
  }
  if (headKnown) {
    journaled = journalIndexBlobs(
      hypoDir,
      Object.fromEntries(
        [...added].map(([path, blob]) => [
          path,
          { index: blob, head: headBlobs.get(path) ?? null },
        ]),
      ),
    );
  }
  const commit = git('commit', '--only', '-m', msg, '--', ...commitScope);
  if (commit.status !== 0)
    return failed(`git commit failed: ${(commit.stderr || '').trim() || 'unknown'}`);
  // `--only` reads each path from the work tree twice, once into the real index
  // and once into the commit. Another close appending in between leaves HEAD with
  // the append and the real index without it, and the next plain `git commit`
  // anyone runs would then take the append back out of HEAD. Bring these paths'
  // index entries to HEAD while the caller still holds the vault lock. Every
  // committed path ends with index == HEAD, so a later write to it shows as an
  // unstaged change only, and a merge that touches it is not refused.
  //
  // Only a path whose index blob is still the one journaled before the commit is reset. Any other
  // blob was staged after that by something else (a person's post-commit hook, say) and is theirs:
  // it stays, and a notice names it. An index that cannot be read resets nothing: which blob each
  // path holds is unknown, so a reset could take away someone else's stage. The journal stays, and
  // the next call's reconcile resets only a path whose index still holds the journaled blob.
  const after = git('ls-files', '-s', '-z', '--', ...commitScope);
  const indexRead = after.status === 0;
  const indexNow = new Map();
  for (const rec of (after.stdout || '').split('\0')) {
    const m = /^\d+ ([0-9a-f]+) 0\t([\s\S]*)$/.exec(rec);
    if (m) indexNow.set(m[2], m[1]);
  }
  const resetScope = indexRead
    ? commitScope.filter((p) => (indexNow.get(p) ?? null) === (added.get(p) ?? null))
    : [];
  const kept = indexRead ? commitScope.filter((p) => !resetScope.includes(p)) : [];
  const sync =
    resetScope.length > 0 ? git('reset', '-q', 'HEAD', '--', ...resetScope) : { status: 0 };
  dropAutoStagedBlobs(hypoDir, commitScope);
  // The reset brought these paths to HEAD, which also settles an older entry for the same path.
  if (indexRead && sync.status === 0 && headKnown) dropIndexJournal(hypoDir, [...added.keys()]);
  const ownWarning = !indexRead
    ? `the index of the committed paths could not be read after the commit (${(after.stderr || '').trim() || 'unknown'}); nothing was reset, and the next commit call finishes it`
    : sync.status === 0
      ? undefined
      : `the index of the committed paths was not brought to HEAD (${(sync.stderr || '').trim() || 'unknown'}); run \`git reset -q HEAD -- ${resetScope.map(shellQuote).join(' ')}\` before any plain git commit`;
  const keptWarning = noticeStagedAfterCommit(hypoDir, git, kept);
  const indexWarning =
    [reconcileWarning, ownWarning, keptWarning].filter(Boolean).join('\n') || undefined;
  // MAJOR fix: name the commit this call just created. A caller that has to
  // tell a user how to take it back (close-gate-store.mjs's
  // hostTagWarningWithUndo) cannot derive it afterwards: on a shared vault
  // HEAD by then may be a concurrent session's commit, and reverting that
  // undoes someone else's work. Read right here, still inside the caller's
  // lock hold. `null` when rev-parse somehow fails: an undo instruction with
  // no target is a smaller failure than one with the wrong target, and the
  // commit itself did succeed, so this must not turn into `committed: false`.
  const head = git('rev-parse', 'HEAD');
  const sha = head.status === 0 ? (head.stdout || '').trim() || null : null;
  return {
    committed: true,
    scoped: stagedFiles.length,
    sha,
    committedPaths: stagedFiles,
    ignoredPaths,
    ...(indexWarning ? { indexWarning } : {}),
    ...(stagedBackups.length > 0 ? { stagedBackups } : {}),
  };
}

/**
 * Read sync-state entries.
 * @param {string} hypoDir
 * @returns {{entries: object[], parseError: boolean}}
 */
export function readSyncState(hypoDir) {
  const path = syncStatePath(hypoDir);
  if (!existsSync(path)) return { entries: [], parseError: false };
  try {
    const entries = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    return { entries, parseError: false };
  } catch {
    return { entries: [], parseError: true };
  }
}

/** Remove the sync-state file. Called once sync is healthy again. Best-effort. */
export function clearSyncState(hypoDir) {
  try {
    rmSync(syncStatePath(hypoDir), { force: true });
  } catch {
    // best-effort
  }
}

// ── sync-last-success ────────────────────────────────────────
// `.cache/sync-last-success.json` is a single JSON object, PER-OPERATION:
//   { "pull": {"timestamp": "<ISO>", "host": "<os.hostname()>"},
//     "push": {"timestamp": "<ISO>", "host": "<...>"} }
// Either key may be absent (pull-only or push-only history). Deliberately
// separate from sync-state.json: that file is failure-only and gets wiped
// wholesale on recovery (clearSyncState), so a success record living there
// would be erased by the very thing it is meant to survive. syncRemote()
// records here on a successful pull/push; session-start's independent
// `git pull --ff-only` records a pull here too, so doctor never reports
// "never synced" right after a healthy startup pull. doctor reads it via
// readSyncLastSuccess; schema + parsing live here only.
//
// Scope: `.cache/` is gitignored (templates/gitignore), same as
// sync-state.json — this file never syncs across machines, so there is no
// cross-machine merge to protect. The lock below only has to cover the
// same-machine case: two concurrent processes on one machine (a pull-writer
// and a push-writer, or two overlapping sessions). `host` is kept per record
// purely for provenance (which machine last recorded the op), not because a
// remote write could ever land here.

/** @returns {string} path to the sync-last-success JSON file for a wiki root. */
function syncLastSuccessPath(hypoDir) {
  return join(hypoDir, '.cache', 'sync-last-success.json');
}

/**
 * A valid last-success record: `{timestamp: string, host: string}`. Anything
 * else (wrong type, missing field, non-object) is malformed.
 * @param {unknown} v
 * @returns {boolean}
 */
function isValidSyncSuccessRecord(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof v.timestamp === 'string' &&
    v.timestamp.trim().length > 0 &&
    typeof v.host === 'string' &&
    v.host.trim().length > 0
  );
}

/**
 * Read last-success records. A missing file means "never synced" (not an
 * error) — the caller distinguishes that from a parse failure via
 * `parseError`. A present `pull`/`push` field that does not match the
 * `{timestamp, host}` shape (including an empty/whitespace-only timestamp or
 * host — a technically-typed but content-free record) is dropped from `data`
 * (never surfaced as if it were a real record) AND flags `parseError: true`,
 * so the caller warns ("cannot parse ... inspect manually") instead of
 * silently rendering `undefined` or an empty value — same corrupt-file
 * handling as sync-state.json. An unrecognized top-level key (anything other
 * than `pull`/`push`) likewise flags the whole file as corrupt: this schema
 * has exactly two legal keys, so a third one is evidence of a hand-edit or a
 * future/foreign writer, not a shape this reader should quietly tolerate.
 *
 * @param {string} hypoDir
 * @returns {{data: {pull?: {timestamp: string, host: string}, push?: {timestamp: string, host: string}}, parseError: boolean}}
 */
export function readSyncLastSuccess(hypoDir) {
  const path = syncLastSuccessPath(hypoDir);
  if (!existsSync(path)) return { data: {}, parseError: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { data: {}, parseError: true };
    let malformed = Object.keys(parsed).some((k) => k !== 'pull' && k !== 'push');
    const data = {};
    for (const op of ['pull', 'push']) {
      if (parsed[op] === undefined) continue;
      if (isValidSyncSuccessRecord(parsed[op])) data[op] = parsed[op];
      else malformed = true; // drop the bad field; flag the file as corrupt
    }
    return { data, parseError: malformed };
  } catch {
    return { data: {}, parseError: true };
  }
}

/**
 * Record a successful pull or push. Concurrency-safe on the same machine:
 * takes the vault file lock on the target path, re-reads the CURRENT file
 * under the lock, updates only the given op's field (the other op's existing
 * value survives — a same-machine concurrent pull-writer and push-writer must
 * not erase each other), then commits via temp-write + rename so a crash or a
 * concurrent read never sees a half-written file. `.cache/` is gitignored, so
 * this file never syncs across machines — there is no cross-machine case to
 * protect here. A pre-existing but unparseable file, or a sibling field that
 * does not match `{timestamp, host}` (including an empty/whitespace-only
 * value) or that carries an unrecognized key, is dropped rather than carried
 * forward (never preserve garbage into a freshly-written record) — the same
 * `isValidSyncSuccessRecord` predicate readSyncLastSuccess uses.
 *
 * Lock acquisition is best-effort — a timeout (or any other failure) is
 * swallowed, same as appendSyncFailure, since a failed success-log must never
 * break the caller (Stop hook / SessionStart).
 *
 * @param {string} hypoDir
 * @param {'pull'|'push'} op
 */
export function recordSyncSuccess(hypoDir, op) {
  try {
    const path = syncLastSuccessPath(hypoDir);
    withFileLock(path, () => {
      let current = {};
      try {
        if (existsSync(path)) {
          const parsed = JSON.parse(readFileSync(path, 'utf-8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const k of ['pull', 'push']) {
              if (isValidSyncSuccessRecord(parsed[k])) current[k] = parsed[k];
            }
          }
        }
      } catch {
        // corrupt existing file: overwrite with a fresh object rather than
        // carry the corruption forward.
      }
      current[op] = { timestamp: new Date().toISOString(), host: hostname() };
      atomicWrite(path, JSON.stringify(current, null, 2) + '\n');
    });
  } catch {
    // best-effort: lock timeout or write failure must never break the caller
  }
}

// ── auto-project suggestion ────────────────────────────────────────
// `.cache/project-suggestions.json` is a single JSON object:
//   { "skips": [{cwd, declined_at, reason}], "cooldowns": {"<cwd>": "<iso>"} }
// `skips` is written by the LLM (Layer-1 behavioral rule) when the user answers
// "N" to an auto-project offer — permanent per-cwd suppression (no TTL).
// `cooldowns` is written by the hook each time it emits an offer — a 5-minute
// same-cwd noise guard. The two live in one file so doctor validates a single
// schema. Both reads/writes are best-effort; a failure only loses the offer,
// never breaks SessionStart/CwdChanged.

const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
];
const SUGGESTION_COOLDOWN_MS = 5 * 60 * 1000;

/** @returns {string} path to the project-suggestions file for a wiki root. */
export function projectSuggestionsPath(hypoDir) {
  return join(hypoDir, '.cache', 'project-suggestions.json');
}

/**
 * Read the project-suggestions store.
 * @param {string} hypoDir
 * @returns {{skips: object[], cooldowns: Record<string,string>, parseError: boolean}}
 */
export function readProjectSuggestions(hypoDir) {
  const path = projectSuggestionsPath(hypoDir);
  if (!existsSync(path)) return { skips: [], cooldowns: {}, parseError: false };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      skips: Array.isArray(data.skips) ? data.skips : [],
      cooldowns: data.cooldowns && typeof data.cooldowns === 'object' ? data.cooldowns : {},
      parseError: false,
    };
  } catch {
    return { skips: [], cooldowns: {}, parseError: true };
  }
}

/**
 * Record that an offer was just emitted for `cwd`, starting the cooldown.
 * Preserves the existing skips array. Best-effort.
 */
export function recordSuggestionCooldown(hypoDir, cwd, now = new Date()) {
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const { skips, cooldowns } = readProjectSuggestions(hypoDir);
    cooldowns[cwd] = now.toISOString();
    writeFileSync(
      projectSuggestionsPath(hypoDir),
      JSON.stringify({ skips, cooldowns }, null, 2) + '\n',
    );
  } catch {
    // best-effort
  }
}

/** True when `cwd` carries one of the recognized project-root markers. */
export function cwdHasProjectMarker(cwd) {
  return PROJECT_MARKERS.some((m) => existsSync(join(cwd, m)));
}

// Shared cooldown/skip gate for BOTH the new-project offer and the backfill
// offer below — same store (.cache/project-suggestions.json), same key (cwd),
// so a user who just answered one kind of offer for a cwd doesn't immediately
// get re-prompted with the other. A corrupt store stays silent (doctor
// surfaces the malformation separately).
function suggestionNotSuppressed(cwd, hypoDir, now) {
  const { skips, cooldowns, parseError } = readProjectSuggestions(hypoDir);
  if (parseError) return false;
  if (skips.some((s) => s && s.cwd === cwd)) return false;
  const ts = cooldowns[cwd];
  if (ts) {
    const t = Date.parse(ts);
    if (Number.isFinite(t) && now - t < SUGGESTION_COOLDOWN_MS) return false;
  }
  return true;
}

/**
 * Decide whether SessionStart/CwdChanged should offer to create a project for
 * `cwd`. The caller MUST have already confirmed `cwd` matches no project's
 * `working_dir` (the hook's MISS branch); this evaluates the remaining
 * trigger conditions: (a) cwd is a git repo, (b) carries a project marker
 * (`.git` alone is a weak signal — §8.11), (c) not in cooldown, (d) not a cwd
 * the user previously declined. A corrupt store stays silent (doctor surfaces).
 *
 * @param {string} cwd
 * @param {string} [hypoDir]
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {boolean}
 */
export function shouldSuggestProjectCreation(cwd, hypoDir = HYPO_DIR, now = Date.now()) {
  if (!cwd) return false;
  if (!existsSync(join(cwd, '.git'))) return false;
  if (!cwdHasProjectMarker(cwd)) return false;
  return suggestionNotSuppressed(cwd, hypoDir, now);
}

/**
 * Decide whether SessionStart/CwdChanged should offer to BACKFILL a
 * working_dir anchor for `cwd`. The caller MUST have already located a
 * findBackfillCandidate() match; this only applies the same cooldown/skip
 * gate shouldSuggestProjectCreation uses, so the two offers share one
 * suppression store. No git/marker gate here — the project directory
 * already existing is itself the trigger condition.
 *
 * @param {string} cwd
 * @param {string} [hypoDir]
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {boolean}
 */
export function shouldSuggestBackfill(cwd, hypoDir = HYPO_DIR, now = Date.now()) {
  if (!cwd) return false;
  return suggestionNotSuppressed(cwd, hypoDir, now);
}

/**
 * Build the §8.11 auto-project offer line for a cwd. The display name is the
 * cwd basename, which is attacker-influenced (a directory name can contain
 * newlines/control chars on Unix). Strip control characters and length-cap it
 * so a crafted dir name cannot spoof extra instructions in additionalContext.
 */
export function buildProjectSuggestionLine(cwd) {
  // Replace any control char (code < 0x20 or === 0x7F) with a space so a
  // crafted dir name cannot inject newlines/instructions into additionalContext.
  // Done by codepoint to keep control bytes out of this source file.
  const sanitized = Array.from(basename(cwd))
    .map((ch) => {
      const code = ch.codePointAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
  const safe = sanitized.slice(0, 80).trim() || 'project';
  return `[WIKI: cwd '${safe}'에 매칭되는 프로젝트가 없습니다. 자동 생성할까요? (Y/n)]`;
}

// Neutralize a PATH value for additionalContext injection without truncating
// it — unlike sanitizeProjForPrompt (built for a short display name), a path
// must render in full or the backfilled working_dir would be wrong. Only
// newline/control chars are stripped (the injection vector); everything else,
// including shell metacharacters, passes through untouched because this value
// is NEVER assembled into a runnable command (see buildBackfillSuggestionLine)
// — it is purely descriptive text for the LLM/user to read.
function stripControlCharsForPath(raw) {
  // Per-codepoint (not a regex escape range) so no control byte is written
  // literally into this source file (the source-corruption trap hit earlier
  // in this same change). Mirrors sanitizeProjForPrompt's coverage EXACTLY —
  // C0 (0x00-0x1F), DEL+C1 (0x7F-0x9F, which folds in U+0085 NEL), and the
  // U+2028/U+2029 line separators. Deliberately does NOT strip bidi format
  // controls: sanitizeProjForPrompt doesn't either, and matching its exact
  // decision (rather than inventing a wider one here) is the principled
  // choice so the two sanitizers never silently diverge in coverage.
  return Array.from(String(raw == null ? '' : raw))
    .map((ch) => {
      const code = ch.codePointAt(0);
      const isC0OrDelOrC1 = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      const isLineSep = code === 0x2028 || code === 0x2029;
      return isC0OrDelOrC1 || isLineSep ? ' ' : ch;
    })
    .join('');
}

/**
 * Build the working_dir-backfill offer line for a cwd that names an EXISTING
 * `projects/<slug>/` directory (findBackfillCandidate already confirmed it
 * carries session artifacts but no anchor). `slug` (short, display-only)
 * routes through sanitizeProjForPrompt; `cwd` (a real path that must not be
 * corrupted) routes through stripControlCharsForPath instead — truncating a
 * path would silently backfill the WRONG working_dir. Neither branch
 * assembles a runnable shell command from either value (codex pre-commit
 * review: embedding untrusted path/slug text into a copy-paste `node ...`
 * invocation is a shell-injection vector); both branches are purely
 * descriptive guidance for the LLM/user to act on.
 *
 * The two cases still need different WORDING: a MISSING index.md has nothing
 * to edit yet, so the offer describes creating a fresh one anchored to the
 * current cwd (the agent constructs the actual project-create.mjs invocation
 * itself, safely, outside this string). An index.md that already EXISTS but
 * simply omits working_dir needs a direct frontmatter addition instead.
 *
 * @param {string} slug the matching projects/<slug>/ directory name
 * @param {string} cwd the session cwd (the value that would become working_dir)
 * @param {boolean} hasIndex whether projects/<slug>/index.md already exists
 * @returns {string}
 */
export function buildBackfillSuggestionLine(slug, cwd, hasIndex) {
  const safeSlug = sanitizeProjForPrompt(slug);
  const safeCwd = stripControlCharsForPath(cwd);
  const action = hasIndex
    ? `projects/${safeSlug}/index.md의 frontmatter에 working_dir: ${safeCwd}를 추가할까요?`
    : `projects/${safeSlug}/index.md가 없습니다. 현재 세션의 cwd(${safeCwd})를 working_dir로 삼아 index.md를 새로 만들까요?`;
  return `[WIKI: cwd가 기존 프로젝트 'projects/${safeSlug}/'와 이름이 일치하지만 working_dir 앵커가 없습니다. ${action} (Y/n)]`;
}

// ── clear-marker (amendment 2026-05-14) ──────────────────────
// `/clear` cannot be blocked (no UserPromptSubmit fire). The only intervention
// point is the SessionEnd(reason='clear') → SessionStart(source='clear') pair:
// SessionEnd writes `.cache/clear-marker.json` with the dying session's id +
// transcript path; SessionStart on `source=clear` reads, injects a recovery
// nudge into additionalContext, and unlinks (one-shot). A 7-day stale guard
// prevents an orphaned marker (SessionEnd fired but new session never began)
// from polluting an unrelated later session.

const CLEAR_MARKER_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** @returns {string} path to the clear-marker file for a wiki root. */
function clearMarkerPath(hypoDir) {
  return join(hypoDir, '.cache', 'clear-marker.json');
}

/**
 * Persist the dying session's identity so the next SessionStart(source=clear)
 * can issue a recovery nudge. Single-file by design (see the amendment):
 * /clear is a single-client UX action, multi-marker disambiguation buys no
 * safety and breaks the 1-of-1 read-and-unlink contract.
 *
 * Best-effort: a failure here only loses the recovery nudge, never the user's
 * `/clear` itself.
 *
 * @param {string} hypoDir
 * @param {{prev_session_id: string, prev_transcript_path: string, prev_cwd?: string}} info
 */
export function writeClearMarker(hypoDir, info) {
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const payload = {
      prev_session_id: info.prev_session_id || null,
      prev_transcript_path: info.prev_transcript_path || null,
      prev_cwd: info.prev_cwd || null,
      ts: new Date().toISOString(),
    };
    writeFileSync(clearMarkerPath(hypoDir), JSON.stringify(payload) + '\n');
  } catch (err) {
    process.stderr.write(`[hypo] clear-marker write failed: ${err?.message || err}\n`);
  }
}

/**
 * Read the clear-marker if present and not stale (>7 days). Returns null when
 * absent, unreadable, or expired. Stale markers are unlinked here so a single
 * SessionStart cleans them up — no separate cron needed.
 *
 * @param {string} hypoDir
 * @returns {object|null}
 */
export function readClearMarker(hypoDir) {
  const path = clearMarkerPath(hypoDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const ts = Date.parse(data?.ts || '');
    if (!Number.isFinite(ts) || Date.now() - ts > CLEAR_MARKER_STALE_MS) {
      rmSync(path, { force: true });
      return null;
    }
    return data;
  } catch (err) {
    // Corrupt marker: emit a debug line AND unlink so the next SessionStart
    // does not log the same parse error forever (self-cleanup invariant).
    process.stderr.write(`[hypo] clear-marker read failed: ${err?.message || err}\n`);
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort
    }
    return null;
  }
}

/** Delete the clear-marker. One-shot contract — caller is SessionStart. */
export function clearClearMarker(hypoDir) {
  try {
    rmSync(clearMarkerPath(hypoDir), { force: true });
  } catch {
    // best-effort
  }
}

// ── session-closed marker (amendment 2026-05-19) ─────────────
// Per-session marker proving session-close completed. Stop hook
// (`hypo-auto-minimal-crystallize`) reads it; `scripts/crystallize.mjs` writes
// it after a verified close. Per-session (not per-day) precision resolves the
// codex BLOCKER from 2026-05-14: log.md date-level check false-passes when a
// later session reuses an earlier session's entry on the same day.
//
// Writer authority lives in crystallize, NOT this hook: the hook only checks
// presence. See amendment 2026-05-19 Q2 for the split rationale.

export const SESSION_CLOSED_MARKER_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Sanitize session_id for filesystem use — Claude session_ids are UUIDs but
 *  defend against accidental path traversal regardless. */
export function sanitizeSessionId(sessionId) {
  return String(sessionId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 128);
}

/** @returns {string} path to the session-closed marker for a given session_id. */
export function sessionClosedMarkerPath(hypoDir, sessionId) {
  return join(hypoDir, '.cache', `session-closed-${sanitizeSessionId(sessionId)}.marker`);
}

// ── close pin: one close id per close request ───────────────────────────────
// `.cache/close-pin/<sessionId>.json` remembers which close id a session's
// open close request writes under, so every retry of that request lands on the
// same session entry. It is not kept in the close journal: `clearJournal` wipes
// that file as soon as the commit lands, and a retry after a failed receipt
// would lose the id.
//
// Shape: `{v: 2, pending, lastResolved, resolvedByProject, localProofs}`.
//   pending            `{closeId, openedAtIndex, entryRelPath, entrySha256s}` of the
//                      close in flight, or null
//   lastResolved       the closeId of the last close that finished, or null
//   resolvedByProject  `{project: closeId}`, the last finished close per project its
//                      entry went to. One session can close several projects in turn,
//                      and each one is proven by its own close, not by the last one.
//                      A pin written before this field existed reads as `{}`.
//   localProofs        `{closeId: {entryRelPath, entrySha256}}`, never cleared on resolution
//
// The functions below sit here, not in close-gate-store.mjs or
// close-journal.mjs, because both import this file: `sessionProofCloseId`
// (called by the PreCompact gate in this file) would otherwise close an import
// cycle. That is also why nothing here calls `closeGateStatus`; callers pass
// its answers in.

const EMPTY_CLOSE_PIN = Object.freeze({
  pending: null,
  lastResolved: null,
  resolvedByProject: {},
  localProofs: {},
});
const emptyClosePin = () => ({ ...EMPTY_CLOSE_PIN, resolvedByProject: {}, localProofs: {} });

/** `<hypoDir>/.cache/close-pin/<sessionId>.json`, or null for an id unsafe as a filename. */
export function closePinPath(hypoDir, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  return join(hypoDir, '.cache', 'close-pin', `${sessionId}.json`);
}

function wellFormedClosePin(pin) {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin) || pin.v !== 2) return false;
  const { pending, lastResolved, resolvedByProject, localProofs } = pin;
  if (pending !== null) {
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) return false;
    if (!isValidSessionId(pending.closeId)) return false;
    if (!Number.isSafeInteger(pending.openedAtIndex) || pending.openedAtIndex < 0) return false;
    if (pending.entryRelPath !== null && typeof pending.entryRelPath !== 'string') return false;
    if (
      !Array.isArray(pending.entrySha256s) ||
      !pending.entrySha256s.every((h) => typeof h === 'string')
    ) {
      return false;
    }
  }
  if (lastResolved !== null && !isValidSessionId(lastResolved)) return false;
  if (resolvedByProject !== undefined) {
    if (!resolvedByProject || typeof resolvedByProject !== 'object') return false;
    if (Array.isArray(resolvedByProject)) return false;
    if (!Object.values(resolvedByProject).every((id) => isValidSessionId(id))) return false;
  }
  if (!localProofs || typeof localProofs !== 'object' || Array.isArray(localProofs)) return false;
  return Object.values(localProofs).every(
    (p) =>
      p &&
      typeof p === 'object' &&
      typeof p.entryRelPath === 'string' &&
      typeof p.entrySha256 === 'string',
  );
}

/**
 * Read the pin. An absent, unreadable, wrongly shaped or older-format (`v: 1`)
 * file reads as an empty pin, never as a throw: a pin that cannot be trusted
 * must not block a close, it just means no id is pinned yet.
 *
 * @returns {{pending: object|null, lastResolved: string|null, resolvedByProject: object, localProofs: object}}
 */
export function readClosePin(hypoDir, sessionId) {
  const path = closePinPath(hypoDir, sessionId);
  if (!path) return emptyClosePin();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (wellFormedClosePin(parsed)) {
      const { pending, lastResolved, resolvedByProject = {}, localProofs } = parsed;
      return { pending, lastResolved, resolvedByProject, localProofs };
    }
  } catch {
    // absent or unparseable: same answer as a malformed file
  }
  return emptyClosePin();
}

/**
 * Write the pin durably (temp file, fsync, rename). Throws on any failure and
 * on an id unsafe as a filename: the pin must be on disk before the entry it
 * names is published, so a write that did not land has to stop the caller.
 */
export function writeClosePin(hypoDir, sessionId, pin) {
  const path = closePinPath(hypoDir, sessionId);
  if (!path) throw new Error(`close pin refused for unsafe session id: ${String(sessionId)}`);
  atomicWrite(
    path,
    JSON.stringify({
      v: 2,
      pending: pin.pending ?? null,
      lastResolved: pin.lastResolved ?? null,
      resolvedByProject: pin.resolvedByProject ?? {},
      localProofs: pin.localProofs ?? {},
    }),
    { durable: true },
  );
}

/**
 * Retire a `pending` that the recorded resolution already covers. Pure.
 *
 * A close resolves in two steps (resolution record first, then `pending`
 * moves to `lastResolved`); a crash between them leaves `pending` standing,
 * and the next close request would reuse its id and adopt the entry the
 * earlier close already committed. `resolvedAtIndex` is a record COUNT and
 * `openedAtIndex` a 0-based position, so `<` is "the resolution includes that
 * signal". Do not change it to `<=` (see `closeGateStatus` for the same base
 * difference). `resolvedAtIndex` is `null` when no usable resolution exists.
 */
export function normalizeClosePin(pin, resolvedAtIndex) {
  if (pin.pending && resolvedAtIndex !== null && pin.pending.openedAtIndex < resolvedAtIndex) {
    return retireClosePending(pin);
  }
  return pin;
}

// The project a session entry path belongs to, null for any other path.
function projectOfEntryPath(relPath) {
  const p = posixPath(relPath);
  return isSessionEntryPath(p) ? p.split('/')[1] : null;
}

/**
 * `pending` finished: it becomes `lastResolved`, and the last resolved close of
 * the project its entry went to. A pending that never recorded an entry path
 * names no project and only moves to `lastResolved`. Pure.
 */
export function retireClosePending(pin) {
  const { closeId, entryRelPath } = pin.pending;
  const project = entryRelPath ? projectOfEntryPath(entryRelPath) : null;
  return {
    ...pin,
    pending: null,
    lastResolved: closeId,
    resolvedByProject: {
      ...(pin.resolvedByProject ?? {}),
      ...(project ? { [project]: closeId } : {}),
    },
  };
}

/**
 * The close id that proves THIS session's close, for a verdict site that
 * cannot write (PreCompact gate, `--check-session-close`, `--mark-session-closed`).
 *
 * `closeOpen` is "a close signal is open and unresolved right now" and
 * `resolvedAtIndex` the resolution position, both read off `closeGateStatus`
 * by the caller (this file cannot call it, see the note above). Both keys are
 * required: a call that forgot one would silently take the weaker branch.
 * The pin is normalized in memory only; this function never writes.
 *
 * With `opts.project` the answer is the close that proves THAT project, since
 * one session can close several projects in turn:
 *   pending in this project, or with no entry yet    its closeId
 *   otherwise, closeOpen                             null (a new request is open:
 *                                                    no earlier close vouches for it)
 *   otherwise                                        resolvedByProject[project], or
 *                                                    lastResolved when its entry is in
 *                                                    this project (a pin written before
 *                                                    resolvedByProject), or null
 * Without it (no production caller; kept for the session-wide question):
 *   pending exists            its closeId
 *   no pending, closeOpen     null
 *   no pending, !closeOpen    lastResolved, or null
 *
 * @param {{closeOpen: boolean, resolvedAtIndex: number|null, project?: string}} opts
 * @returns {string|null}
 */
export function sessionProofCloseId(hypoDir, sessionId, opts) {
  if (!opts || typeof opts.closeOpen !== 'boolean') {
    throw new Error('sessionProofCloseId requires a boolean closeOpen');
  }
  if (!(opts.resolvedAtIndex === null || Number.isSafeInteger(opts.resolvedAtIndex))) {
    throw new Error('sessionProofCloseId requires resolvedAtIndex (a number or null)');
  }
  const pin = normalizeClosePin(readClosePin(hypoDir, sessionId), opts.resolvedAtIndex);
  const { project } = opts;
  if (project === undefined) {
    if (pin.pending) return pin.pending.closeId;
    return opts.closeOpen ? null : pin.lastResolved;
  }
  if (pin.pending) {
    const rel = pin.pending.entryRelPath;
    if (!rel || projectOfEntryPath(rel) === project) return pin.pending.closeId;
  }
  if (opts.closeOpen) return null;
  const byProject = Object.hasOwn(pin.resolvedByProject, project)
    ? pin.resolvedByProject[project]
    : null;
  if (byProject) return byProject;
  return pin.lastResolved && entryPathOfClose(hypoDir, project, pin.lastResolved)
    ? pin.lastResolved
    : null;
}

// verified_scope (session-close-scope-boundary spec §3) records the scope the
// gate ABOVE this write actually verified, not merely the attribution the
// marker's `projects` field carries — those can diverge whenever a gate run
// widens attribution beyond what it narrowed the check to. The caller
// decides `kind`: this function only refuses to persist a shape it cannot
// stand behind. Exported so scripts/doctor.mjs's reader runs the SAME
// collapse instead of a hand-rolled copy — an unrecognized shape, or a
// 'project'/'global' scope with an empty `projects` (a narrower-than-nothing
// claim), reads back as "field absent", never as a false claim.
export function normalizeVerifiedScope(verifiedScope) {
  if (!verifiedScope || typeof verifiedScope !== 'object') return null;
  if (verifiedScope.kind === 'log-only') return { kind: 'log-only' };
  if (verifiedScope.kind === 'project' || verifiedScope.kind === 'global') {
    const projects = Array.isArray(verifiedScope.projects)
      ? [...new Set(verifiedScope.projects.filter((p) => typeof p === 'string' && p))]
      : [];
    // An empty projects list under 'project'/'global' asserts a verified
    // boundary with nothing in it — that is not a narrower claim, it is a
    // malformed one. Drop it rather than persist a scope nothing can satisfy
    // by design (verified_scope must only ever tighten, never silently gate
    // out everything).
    if (projects.length === 0) return null;
    return { kind: verifiedScope.kind, projects };
  }
  return null;
}

/**
 * Persist a per-session close proof. Caller MUST verify
 * `sessionCloseFileStatus(hypoDir, ...).ok` before invoking: this helper does NOT
 * re-check; that's the writer's contract (crystallize.mjs).
 *
 * Best-effort: stderr debug line on failure, no exception propagation.
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {{project?: string, scope?: string, transcript_path?: string, verifiedScope?: {kind: 'log-only'|'project'|'global', projects?: string[]}, hostTagWarning?: string}} info
 *   `hostTagWarning` is optional and, when present, is persisted as
 *   `host_tag_warning` (see the payload below): the close-time residual a
 *   reader of this file after the fact would otherwise have no record of.
 *   `receiptGeneration`: when a caller wrote a close
 *   receipt (`hooks/close-receipt.mjs`) for this session BEFORE calling this
 *   function, it passes that receipt's `generation` here. A new Stop keys its
 *   `legacy-closed` acceptance on this field's ABSENCE: a marker written by
 *   an old build (or a caller that skipped the receipt) has no generation and
 *   is accepted as a weaker, time-limited proof; a marker that carries one
 *   promises a receipt exists, and Stop refuses to trust the marker alone
 *   when that receipt is missing, invalid, or unreachable.
 */
export function writeSessionClosedMarker(hypoDir, sessionId, info = {}) {
  if (!sessionId) return false;
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    // scope distinguishes a project close (its close files were verified) from a
    // log-only close (a non-project session, no project attribution). Readers (precompactGateStatus / --check-session-close) key
    // the gate semantics on this field, so it must be recorded.
    const scope = info.scope === 'log-only' ? 'log-only' : 'project';
    // v4 attribution discriminator (session-close attribution). `projects` is the evidence-based
    // set this session actually closed — explicit --project ∪ transcript
    // close-file edits ∪ apply's authoritative payload.project — and NEVER the
    // recency primary. Its PRESENCE marks a v4 marker whose scope resolveCloseScope
    // trusts directly; a pre-v4 marker carries only `project` and is treated as an
    // uncorroborated legacy hint (see resolveCloseScope). `project` stays as
    // projects[0] for back-compat with the flat-field readers.
    const projects = Array.isArray(info.projects)
      ? [...new Set(info.projects.filter(Boolean))]
      : info.project
        ? [info.project]
        : [];
    const verifiedScope = normalizeVerifiedScope(info.verifiedScope);
    const payload = {
      session_id: sessionId,
      project: info.project || projects[0] || null,
      projects,
      scope,
      transcript_path: info.transcript_path || null,
      closed_at: new Date().toISOString(),
      verification: scope === 'log-only' ? 'log-only-close:ok' : 'session-close-file-status:ok',
      // Omitted entirely (not even `null`) when the caller passes nothing or
      // an unrecognized shape, so a marker written by a caller that hasn't
      // adopted this field reads back byte-identical to before it existed —
      // doctor's reader treats "field absent" as "no additional scope check".
      ...(verifiedScope ? { verified_scope: verifiedScope } : {}),
      // Same omit-when-absent contract. Set only when this close survived a
      // HOST_TAG_NAMES-shaped queue item reading as neutral rather than a
      // retraction (see walkCloseGate's neutralizedHostTagName and
      // closeGateStatus's hostTagWarning): a caller inspecting the marker
      // after the fact can then see the same residual the close-time console
      // output already warned about once.
      ...(info.hostTagWarning ? { host_tag_warning: info.hostTagWarning } : {}),
      // Omit-when-absent, same contract as the two fields above: a marker
      // written with no receipt behind it (or by a caller that predates the
      // receipt writer) must read back exactly as it always has.
      ...(info.receiptGeneration ? { receipt_generation: info.receiptGeneration } : {}),
    };
    // Atomic, and it reports. Two reasons, and the caller needs both.
    //
    // A plain writeFileSync can leave a truncated file behind, and the reader
    // below drops a marker it cannot parse. That combination turns one failed
    // write into a session that can never close: the caller sees a file, calls
    // the close signal spent, and the next Stop deletes the unparseable marker.
    // temp+rename means the target is either the old bytes or the whole new
    // ones, never half.
    //
    // And existsSync cannot answer the question the caller is really asking.
    // "A marker file is there" is not "this run put it there" — a corrupt
    // marker from an earlier attempt satisfies it just as well. So say whether
    // THIS write landed and let the caller key on that.
    atomicWrite(sessionClosedMarkerPath(hypoDir, sessionId), JSON.stringify(payload) + '\n');
    return true;
  } catch (err) {
    process.stderr.write(`[hypo] session-closed marker write failed: ${err?.message || err}\n`);
    return false;
  }
}

/**
 * Read the session-closed marker for `sessionId` if present and not stale
 * (>7 days). Returns null when absent, unreadable, or expired. Stale/corrupt
 * markers are unlinked here so a single Stop hook call cleans them up — no
 * separate sweeper needed (mirrors clear-marker self-cleanup invariant).
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @returns {object|null}
 */
export function readSessionClosedMarker(hypoDir, sessionId) {
  if (!sessionId) return null;
  const path = sessionClosedMarkerPath(hypoDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const ts = Date.parse(data?.closed_at || '');
    if (!Number.isFinite(ts) || Date.now() - ts > SESSION_CLOSED_MARKER_STALE_MS) {
      rmSync(path, { force: true });
      return null;
    }
    return data;
  } catch (err) {
    process.stderr.write(`[hypo] session-closed marker read failed: ${err?.message || err}\n`);
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort
    }
    return null;
  }
}

/** Delete a session-closed marker. Test/maintenance helper. */
export function clearSessionClosedMarker(hypoDir, sessionId) {
  if (!sessionId) return;
  try {
    rmSync(sessionClosedMarkerPath(hypoDir, sessionId), { force: true });
  } catch {
    // best-effort
  }
}

// ── transcript activity heuristic (amendment 2026-05-19; 6a 2026-06-14) ─────────
// Substantial-session gate for the Stop hook: a session "worth" blocking on for
// session-close is either (a) any mutation (Edit/Write/MultiEdit/NotebookEdit)
// or (b) a high-volume read-only investigation (≥ READONLY_SUBSTANTIAL_THRESHOLD
// Read/Grep/Glob/Bash calls). Pure Q&A / incidental lookups skip the block.
//
// 6a rationale: code-review / debugging sessions reach real conclusions worth
// crystallizing while touching only read-only tools. The original gate keyed
// purely on mutation tools, so those sessions were never nudged to close. The
// investigation threshold (5) mirrors session-audit.mjs's "search-many" cutoff
// (scripts/session-audit.mjs:206) and sits in the empirical gap between
// incidental lookups (0–3 calls) and real investigation (16–22 calls). Bash is
// now counted (it is the dominant signal in read-only sessions); over-firing is
// bounded by the close-intent gate (the Stop hook only blocks when the user also
// signalled wrap-up) — see hypo-auto-minimal-crystallize.mjs.
//
// NOTE: counting a Bash call here does NOT widen the lint scope. Lint scoping
// (precompactGateStatus) still seeds only Edit/Write-touched files plus the
// mandatory close files — a Bash-written wiki file is not auto-scoped.

const MUTATING_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Read-only investigation tools. Bash included: read-only sessions are
// Bash-dominant (git/grep/cat), so excluding it would leave most of them
// undetectable (a real session had read=0, bash=16).
const INVESTIGATION_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'Bash']);
// Investigation-volume cutoff for a read-only session to count as substantial.
const READONLY_SUBSTANTIAL_THRESHOLD = 5;

/** Mirror of `scripts/session-audit.mjs` extractToolNames: handles both top-level
 *  `tool_use` entries (legacy fixtures) and nested `message.content[].tool_use`
 *  blocks (real Claude Code transcripts). */
function extractTranscriptToolNames(entry) {
  const names = [];
  if (!entry || typeof entry !== 'object') return names;
  if (entry.type === 'tool_use') {
    const n = entry.name || entry.tool_name;
    if (n) names.push(n);
  } else if (entry.tool_name || entry.name) {
    if (entry.type === undefined || entry.type === 'tool_use') {
      const n = entry.tool_name || entry.name;
      if (n) names.push(n);
    }
  }
  const content = entry.message?.content ?? (Array.isArray(entry.content) ? entry.content : null);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const n = block.name || block.tool_name;
        if (n) names.push(n);
      }
    }
  }
  return names;
}

/**
 * Single-pass tool-use census over a JSONL transcript. Both public predicates
 * (`hasMutatingTranscriptActivity`, `isSubstantialSession`) derive from this one
 * census so the mutation leg stays identical between them. (They still diverge
 * on read-only ≥ threshold sessions, where only `isSubstantialSession` is true.)
 *
 * Granularity (shared contract):
 *   • Whole-file unreadable / missing path → all counts 0 (fail-open).
 *   • Per-line malformed JSON → that line is skipped, scan continues. Real
 *     transcripts occasionally carry truncated lines; one bad line must not
 *     hide a clearly-active session that follows. (Codex Worker-2 CONCERN
 *     resolved 2026-05-19: line-level skip is the intended contract.)
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {{ mutationCount: number, investigationCount: number }}
 */
function transcriptActivityStats(transcriptPath) {
  const stats = { mutationCount: 0, investigationCount: 0 };
  if (!transcriptPath || typeof transcriptPath !== 'string') return stats;
  if (!existsSync(transcriptPath)) return stats;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return stats;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const name of extractTranscriptToolNames(entry)) {
      if (MUTATING_TOOL_NAMES.has(name)) stats.mutationCount++;
      else if (INVESTIGATION_TOOL_NAMES.has(name)) stats.investigationCount++;
    }
  }
  return stats;
}

/**
 * True if the JSONL transcript at `transcriptPath` contains ≥1 mutation
 * tool_use (Edit/Write/MultiEdit/NotebookEdit). Kept as a precise, standalone
 * helper (and regression oracle) even though the Stop hook now gates on the
 * broader `isSubstantialSession`.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function hasMutatingTranscriptActivity(transcriptPath) {
  return transcriptActivityStats(transcriptPath).mutationCount > 0;
}

/**
 * True if the session is "substantial" enough to nudge a session-close:
 * any mutation, OR a read-only investigation of at least
 * READONLY_SUBSTANTIAL_THRESHOLD Read/Grep/Glob/Bash calls (6a). The mutation
 * leg is identical to `hasMutatingTranscriptActivity`, so mutating sessions
 * behave exactly as before; only high-volume read-only sessions are newly
 * caught. Over-firing on read-only sessions is bounded downstream by the
 * close-intent gate in hypo-auto-minimal-crystallize.mjs.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function isSubstantialSession(transcriptPath) {
  const { mutationCount, investigationCount } = transcriptActivityStats(transcriptPath);
  return mutationCount > 0 || investigationCount >= READONLY_SUBSTANTIAL_THRESHOLD;
}

// ── session-scoped lint classification ──────────────────────────────────────
// Bug A/B fix: the close gate must judge a session on the files IT touched, not
// the whole vault. Lint debt from another project/session (often in shared
// pages/) must not block this session's close/compact. Two scope builders feed
// one shared classifier: transcript-derived (hooks + standalone marker) and
// close-file/payload-derived (the documented apply path writes via Bash, so its
// files never appear as Edit/Write file_paths and must be seeded explicitly).

const MUTATING_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Pull file_path/notebook_path args from mutating tool_use blocks in one
 *  transcript entry. Mirrors extractTranscriptToolNames' shape handling
 *  (top-level tool_use + nested message.content[] blocks). */
function extractTranscriptToolFilePaths(entry) {
  const paths = [];
  if (!entry || typeof entry !== 'object') return paths;
  const pull = (name, input) => {
    if (!name || !MUTATING_FILE_TOOLS.has(name) || !input || typeof input !== 'object') return;
    const fp = input.file_path || input.notebook_path;
    if (typeof fp === 'string' && fp) paths.push(fp);
  };
  if (entry.type === 'tool_use') pull(entry.name || entry.tool_name, entry.input);
  const content = entry.message?.content ?? (Array.isArray(entry.content) ? entry.content : null);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        pull(block.name || block.tool_name, block.input);
      }
    }
  }
  return paths;
}

/** Normalize an absolute path to a repo-relative POSIX path under hypoDir, or
 *  null if it resolves outside the wiki. */
function toHypoRel(absPath, hypoDir) {
  let rel;
  try {
    rel = relative(hypoDir, absPath);
  } catch {
    return null;
  }
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null;
  return rel.split('\\').join('/');
}

/**
 * Same walk as extractTouchedWikiFiles, but also reports whether the walk can
 * be TRUSTED as a complete enumeration: `trusted: false` when the transcript
 * is missing, unreadable, or contains a line that failed to parse (transcripts
 * occasionally truncate mid-write). `extractTouchedWikiFiles` collapses all of
 * that to an empty/partial Set, indistinguishable from "this session touched
 * nothing", which is fine for lint's existing debt-partition (a false notice is not a
 * false pass), but NOT fine for a caller that must not guess from a partial
 * walk, such as deriveTouchedProject: a truncated line could have named a
 * second project the walk never saw. The gate's git check does not read the
 * transcript at all (it uses the touched-paths record), so it is not such a
 * caller any more.
 *
 * @returns {{files: Set<string>, trusted: boolean}}
 */
export function extractTouchedWikiFilesWithTrust(transcriptPath, hypoDir) {
  const out = new Set();
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return { files: out, trusted: false };
  }
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return { files: out, trusted: false };
  }
  let trusted = true;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      trusted = false; // a truncated/corrupt line: the walk may be incomplete
      continue;
    }
    for (const fp of extractTranscriptToolFilePaths(entry)) {
      const rel = toHypoRel(fp, hypoDir);
      if (rel) out.add(rel);
    }
  }
  return { files: out, trusted };
}

/**
 * Repo-relative POSIX paths of wiki files this session edited via direct
 * Edit/Write/MultiEdit/NotebookEdit tool_use. Returns a Set; empty when the
 * transcript is missing/unreadable (callers decide the fallback). A per-line
 * JSON parse error skips that line only (transcripts occasionally truncate).
 * A caller that needs to tell "genuinely empty" apart from "could not fully
 * enumerate" wants extractTouchedWikiFilesWithTrust instead.
 */
export function extractTouchedWikiFiles(transcriptPath, hypoDir) {
  return extractTouchedWikiFilesWithTrust(transcriptPath, hypoDir).files;
}

/**
 * The mandatory session-close files (repo-relative POSIX). The documented close
 * path `crystallize.mjs --apply-session-close` writes these from inside a Bash
 * call, so they never surface as Edit/Write file_paths — they must seed the
 * scoped-lint set explicitly or a close-introduced error would escape the gate.
 * Mirrors what sessionCloseFileStatus reads: today's session entries, the
 * session-log evidence file, and the two root files.
 */
export function closeFileTargets(hypoDir) {
  const out = new Set(['hot.md', 'log.md']);
  const project = resolveActiveProject(hypoDir);
  if (project) {
    const dates = freshDates();
    for (const e of datedEntryPaths(hypoDir, project, dates)) out.add(e);
    out.add(sessionLogScopePath(hypoDir, project, dates[0]));
  }
  return out;
}

/**
 * Global variant of closeFileTargets for the no-payload lint-scope callers
 * Union of the close files over every today-active project
 * (fallback: the recency project when none is active). Includes the session-log
 * evidence file for EVERY freshDate (not just dates[0]) so the lint scope matches
 * what sessionCloseFileStatus actually checks across a local/UTC date boundary.
 */
// The lint-scope target set for ONE project's close: the shared root files
// (hot.md / log.md) plus that project's mandatory close files: today's session
// entries and each fresh date's session-log evidence file. Used both by
// `--check-session-close --project=<slug>` (a project-scoped diagnostic — see
// precompactGateStatus opts.projectOverride) and as the per-project building
// block of closeFileTargetsGlobal, so the two scopes stay identical per project.
export function closeFileTargetsForProject(hypoDir, slug) {
  const dates = freshDates();
  const out = new Set(['hot.md', 'log.md']);
  for (const e of datedEntryPaths(hypoDir, slug, dates)) out.add(e);
  // Scope to the file each date's freshness is PROVEN by (daily shard or, via
  // fallback, the legacy monthly), so a corrupt evidence file can't pass the
  // gate while its lint error is demoted to an out-of-scope notice.
  for (const d of dates) out.add(sessionLogScopePath(hypoDir, slug, d));
  return out;
}

export function closeFileTargetsGlobal(hypoDir) {
  const dates = freshDates();
  const out = new Set(['hot.md', 'log.md']);
  let active = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );
  // No project closed today → fall back to the recency project (mirrors
  // sessionCloseGlobalStatus's own fallback at the top of this file), so the lint
  // scope never narrows below the close-status scope. Dropping this (root-only
  // when active=[]) would re-open the very gap closeFileTargetsForProject closes.
  if (active.length === 0) {
    const recency = resolveActiveProject(hypoDir);
    if (recency) active = [recency];
  }
  for (const p of active) {
    for (const f of closeFileTargetsForProject(hypoDir, p)) out.add(f);
  }
  return out;
}

/** Normalize a path's separators to POSIX so scope membership is OS-independent.
 *  lint.mjs emits `file` via path.relative (back-slashes on Windows) while the
 *  scope builders produce forward-slash paths — normalize both sides. */
function posixPath(p) {
  return (p || '').split('\\').join('/');
}

/**
 * Partition lint findings into `blocking` (a file this session is accountable
 * for) vs `notice` (pre-existing debt elsewhere — surfaced, not blocking).
 *
 * `scope` = iterable of repo-relative paths the session is accountable for.
 * Membership is exact on the normalized path. Only findings passed in are
 * classified — callers pass lint ERRORS; broken wikilinks (lint W4 warnings) are
 * intentionally warn-only (forward references to planned pages are normal in a
 * wiki) and are NOT promoted to blocking by this gate.
 */
export function partitionLintScope(findings, scope) {
  const normScope = new Set([...scope].map(posixPath));
  const blocking = [];
  const notice = [];
  for (const f of findings || []) {
    if (normScope.has(posixPath(f.file))) blocking.push(f);
    else notice.push(f);
  }
  return { blocking, notice };
}

/**
 * True if a repo-relative file lives under any of the given project dirs
 * (`projects/<slug>/...`, or the dir itself). Both surfaces that surface
 * pre-existing lint-debt NOTICES use this to decide what to LIST vs fold: debt
 * under a close-target project is the close's own neighborhood and stays listed;
 * debt elsewhere (other projects, shared `pages/`, root `hot.md`/`log.md`) folds
 * to a count so the same untouched-file debt does not re-list its filenames on
 * every close. Same path policy as the lint-scope matcher above: separators
 * normalized to POSIX, exact prefix at a segment boundary.
 */
// This function keeps the posixPath() normalization deliberately, unlike
// isForeign (§2b), which reads the raw porcelain path so a literal-backslash
// filename cannot be misread as a nested projects/<slug>/ path. Every caller
// of isUnderProjectDirs would need to be checked before applying the same
// raw-path treatment here, and that audit has not been done, so the existing
// behavior stays until it has.
export function isUnderProjectDirs(file, slugs) {
  const f = posixPath(file);
  return (slugs || []).some((s) => s && (f === `projects/${s}` || f.startsWith(`projects/${s}/`)));
}

/**
 * The session-close FILES of some project, as a path matcher. Used to attribute a
 * close to a session: a transcript that edited one of `projects/<slug>/`'s
 * session-log shards is evidence THIS session was closing <slug>. The project's
 * `hot.md` and `session-state.md` are generated views now, which a close never
 * edits (close-guard refuses a Write/Edit there), so an edit to one is not a
 * close signal. Any other file under `projects/<slug>/` is NOT evidence: merely
 * editing a page or an ADR there says nothing about whose close is whose, and
 * treating it as attribution would re-block a session for a project it only read
 * around in (codex design review).
 */
const CLOSE_FILE_RE = /^projects\/([^/]+)\/session-log\/[^/]+\.md$/;

/** Slugs whose close files this session edited directly (Write/Edit tool_use). */
function projectsFromTouchedCloseFiles(transcriptPath, hypoDir) {
  const out = new Set();
  if (!transcriptPath) return out;
  for (const f of extractTouchedWikiFiles(transcriptPath, hypoDir)) {
    const m = posixPath(f).match(CLOSE_FILE_RE);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * closeScope: the projects THIS session is accountable for closing. The union of
 * three signals, because no single one covers every close path:
 *
 *   1. `opts.closeScope` — the caller states it outright. `--apply-session-close`
 *      passes `payload.project` (it is the authority on what it just closed) and
 *      `--mark-session-closed --project=<slug>` passes its attribution slug. This
 *      signal is LOAD-BEARING, not a convenience: the documented close path writes
 *      its files from inside a Bash call, so they never surface as Edit/Write
 *      `file_path`s and signal 2 cannot see them (the same blind spot that forces
 *      closeFileTargets() to seed the lint scope explicitly).
 *   2. close files the transcript shows this session editing — the hand-written
 *      close, which bypasses the script entirely.
 *   3. `marker.project` — after a scripted close marked, this is how a later reader
 *      (PreCompact) recovers signal 1. It is what keeps the marker == compact-ready
 *      invariant: the writer scopes by `payload.project`, PreCompact re-scopes by
 *      the `project` that same writer recorded, so the two can never disagree.
 */
export function resolveCloseScope(hypoDir, opts = {}, marker = null) {
  // `direct` is the subset attributable to THIS close attempt: explicit
  // --project/closeScope, this session's transcript close-file edits, and the
  // resolved attributionScope. A marker's `projects` is PAST evidence of a close
  // that already happened, so it belongs in the partition scope (it must not be
  // demoted as foreign debt) but NOT in the mandatory-evaluation set: a 7-day-TTL
  // marker naming a project that is no longer today-active would otherwise make
  // that project's stale close block an unrelated close today (codex round 2,
  // reproduced with a 24h-old marker). The returned Set carries `direct` as a
  // property so the caller does not re-derive it, and the transcript is parsed once.
  // Every slug enters the sets in NFC: valid project directories are NFC and NFD ones are refused, so
  // NFC is the key the evaluation targets and `scope.has(p.project)` use. A transcript path spelled
  // in NFD would otherwise make this session's own project look foreign.
  const nfc = (p) => (typeof p === 'string' ? p.normalize('NFC') : p);
  const scope = new Set((opts.closeScope || []).map(nfc));
  for (const p of projectsFromTouchedCloseFiles(opts.transcriptPath, hypoDir)) scope.add(nfc(p));
  // Marker attribution (session-close attribution). A v4 marker carries `projects` — the
  // evidence-based set it closed (never recency) — trusted directly. A pre-v4
  // legacy marker carries only `project` with no provenance, and that value may be
  // recency-derived (the P1 bug). An uncorroborated legacy attribution must NOT
  // enable partitioning, or a stale/wrong slug could demote a real failure to
  // foreign debt. So a legacy `project` enters scope only when the direct signals
  // above (explicit close scope or transcript close-file edits) already corroborate
  // the SAME slug; otherwise it stays a display hint. This narrow gap self-heals as
  // pre-v4 markers expire (7-day TTL).
  // opts.attributionScope (session-close-scope-boundary spec §2/§3): a fourth
  // signal, one slug, from resolveGateProjectOverride. A cwd that unambiguously
  // owns one project, or an explicit --project the caller already validated, is
  // evidence this session is closing THAT project — the same standing the three
  // signals above already have. It is the opt key the four marker-writing paths
  // (PreCompact, Stop, --mark-session-closed, apply's auto-marker) pass instead
  // of `opts.projectOverride`: that key stays the check-only diagnostic's (it
  // also narrows sessionCloseGlobalStatus's own evaluation and turns off the
  // partition below), while this one only widens the set the partition demotes
  // everything outside of.
  if (opts.attributionScope) scope.add(nfc(opts.attributionScope));
  // Snapshot the direct signals BEFORE the marker union below widens the set.
  scope.direct = new Set(scope);

  if (Array.isArray(marker?.projects)) {
    for (const p of marker.projects) if (p) scope.add(nfc(p));
  }
  return scope;
}

// ── PreCompact gate — single source of truth ────────────────────────────────

// One monotonic deadline for the whole gate, below the smallest caller limit (the Stop
// stage's 10000 ms) minus the work a caller does before and after the gate. Every wait
// the gate starts (git, the touched-paths lock, lint, feedback-sync) is cut to the time
// left on it. No environment knob: a stale value in a user's environment would switch
// the checks off or block every close. Tests inject `opts.deadline` instead. Exported only so
// PreCompact can build the same deadline for its follow-up calls.
export const GATE_DEADLINE_MS = 7000;

/**
 * How a child process ended: 'timeout' (the `timeout` the gate gave spawnSync killed it, Node
 * reports `error.code === 'ETIMEDOUT'`), 'spawn-error' (it never ran), 'signal' (killed from
 * outside, such as an OOM kill), 'exit' (a non-zero exit) or 'ok'. Same order as `stageFailure`
 * in hypo-stop.mjs, which cannot import this module (it uses Node built-ins only): keep the two
 * orders equal.
 *
 * @param {{error?: {code?: string}, status?: number|null, signal?: string|null}} res
 * @returns {'ok'|'timeout'|'spawn-error'|'signal'|'exit'}
 */
function spawnEndKind(res) {
  if (res.error?.code === 'ETIMEDOUT') return 'timeout';
  if (res.error) return 'spawn-error';
  if (res.signal) return 'signal';
  return res.status === 0 ? 'ok' : 'exit';
}

// The lint and feedback-sync runner of the gate. `opts.runCheck` replaces it in tests.
const defaultRunCheck = (name, args, spawnOpts) =>
  spawnSync(name === 'lint' ? 'node' : process.execPath, args, spawnOpts);

/**
 * The full PreCompact gate decision as a READ-ONLY status. This is the single
 * source of truth for "is the wiki compact-ready?": both hypo-personal-check.mjs
 * (the PreCompact hook) and `crystallize --check-session-close` call it, so a
 * green status means /compact will not block on a human-fixable issue.
 *
 * Read-only: feedback projection PURE drift is reported as a non-blocking notice
 * with its targets in `driftTargets` (an "effect requirement"), NOT a blocker —
 * the hook self-heals it with `feedback-sync --write` before continuing,
 * and a verify caller needs no human action for it. over-cap and conflict
 * DO block (human demote/import required).
 *
 * Faithfulness caveats (why "compact-ready", not "guaranteed pass"): the hook
 * has paths outside this status — a context-≥70% early block, HYPO_SKIP_GATE
 * bypass, and a fail-closed if the self-heal `--write` itself errors. And without
 * a transcript the lint scope is the mandatory close files only; pass
 * opts.transcriptPath to widen it to the session's edited files exactly as the
 * hook does.
 *
 * opts.projectOverride (CHECK-ONLY) narrows BOTH the close status and the lint
 * scope to a single project, for `--check-session-close --project=<slug>`. A
 * green result is then a project-scoped diagnostic, NOT the global compact-ready
 * verdict: the caller must surface the scope. The four marker-writing paths
 * (--mark / apply auto-marker / PreCompact / Stop) never set this — they pass
 * `opts.attributionScope` instead, which only feeds resolveCloseScope's set and
 * leaves this status evaluating every project, so the mine/foreign partition
 * below can tell their own incomplete close from someone else's debt. The
 * invariant that once justified keeping those paths fully unscoped ("marker ==
 * compact-ready", codex design review) is replaced by that partition, not
 * restored by it — a marker's own `verified_scope`, attesting exactly what
 * this status's caller evaluated (never the marker's `projects`, which is
 * evidence-based attribution), now ships (session-close-scope-boundary
 * spec §3). The writer is `scripts/lib/crystallize-close-apply.mjs`
 * (`runMarkSessionClosed` and `runMarkerPhase`); the reader is
 * `markerCoversArtifact` in `scripts/doctor.mjs`.
 * The git axis is the same for every caller, and does not read the
 * transcript. A dirty file blocks when this session's touched-paths record says
 * it wrote it, or a failure flag says a record of it was lost; the whole
 * project folder being closed blocks only when the record lost paths it cannot
 * name, or when the call has no session id to read a record of. Any other dirty
 * file is a notice (`unresolved`, `foreign-entry`, `foreign-append`,
 * `local-entry`). projectOverride and attributionScope only name the project
 * folder being closed. When a log-only marker governs the session, log-only
 * mode wins for the close-status and lint scope (scope selection above).
 *
 * @param {string} hypoDir
 * opts.sessionCwd (session-cwd close check): the authoritative cwd of the session being
 * gated (hook payload.cwd, or the CLI --session-cwd flag — never process.cwd(),
 * which is post-`cd` non-authoritative). When set and not log-only, the project
 * that owns this cwd is checked for close-completeness as an INDEPENDENT blocker,
 * catching a session whose own project close was never started. Unmatched/ambiguous
 * cwd yields a best-effort notice, not a block. apply never passes it (its launch
 * cwd may differ from the authoritative payload.project).
 * That check proves THIS session's close (sessionCloseFileStatus scope
 * 'session'), so it needs the close id the session's close pin names, which
 * depends on whether a new close signal is open: `opts.closeOpen`
 * (`closeGateStatus(...).ok`) and `opts.resolvedAtIndex`
 * (`closeGateStatus(...).resolvedAtIndex`). The caller computes both, the same
 * way it injects `opts.closeMarker`: close-gate-store.mjs imports this module.
 * A call that reaches the check without them throws (sessionProofCloseId).
 *
 * Internal opts, not set by an operating caller: `opts.deadline` (`{end}`, default one built
 * from GATE_DEADLINE_MS at entry; PreCompact passes its own so its follow-up calls share the
 * budget) and `opts.runCheck(name, args, spawnOpts)` (the lint / feedback-sync runner, tests
 * inject results). A wait that outlives the deadline is a time limit: the check is skipped
 * and said so in a notice, never a blocker. A check that ended by an error (a crash, an
 * outside kill, output that does not parse) is a `check-skipped` blocker for every caller,
 * `checkpointMode` or not. `skippedWhy` names the cause of each skip.
 *
 * @param {{lintScope?: Iterable<string>, transcriptPath?: string|null, claudeHome?: string, projectOverride?: string|null, attributionScope?: string|null, sessionCwd?: string|null, sessionId?: string|null, checkpointMode?: boolean, closeMarker?: object|null, logOnly?: boolean, closeScope?: string[], closeOpen?: boolean, resolvedAtIndex?: number|null, deadline?: {end: number}, runCheck?: (name: 'lint'|'feedback', args: string[], spawnOpts: object) => object}} [opts]
 * @returns {{ok: boolean, close: object, blockers: {type:string,reason:string}[], notices: {type:string,reason:string,file?:string}[], driftTargets: string[], skipped: {lint:boolean, feedback:boolean}, skippedWhy: {lint?: string, feedback?: string}}}
 */
export function precompactGateStatus(hypoDir, opts = {}) {
  const blockers = [];
  const notices = [];
  const driftTargets = [];
  const skipped = { lint: false, feedback: false };
  const skippedWhy = {};
  const deadline = opts.deadline ?? { end: performance.now() + GATE_DEADLINE_MS };
  const cut = () => remainingSpawnTimeoutMs(deadline) === 0;
  const runCheck = opts.runCheck ?? defaultRunCheck;
  // Starts one lint / feedback-sync run under the time left, or reports that none is left.
  const startCheck = (name, args, spawnOpts) => {
    const left = remainingSpawnTimeoutMs(deadline);
    if (left === 0) return { kind: 'deadline' };
    const t0 = performance.now();
    const res = runCheck(name, args, { ...spawnOpts, timeout: Math.min(30000, left) });
    return { res, kind: spawnEndKind(res), ms: Math.round(performance.now() - t0) };
  };
  // A time limit (the child hit its timeout, or no time was left to start it): a notice.
  const checkTimeLimit = (check, run) => {
    skipped[check] = true;
    const why =
      run.kind === 'deadline'
        ? `the gate deadline (${GATE_DEADLINE_MS} ms) was used up before it could start`
        : `it was still running after ${run.ms} ms (gate deadline ${GATE_DEADLINE_MS} ms)`;
    skippedWhy[check] = `time limit: ${why}`;
    notices.push({ type: check, reason: `${check} skipped (time limit, fail-open): ${why}` });
  };
  // An error: the check did not run to a verdict, so this close has no verified lint /
  // feedback state. Blocks every caller, so no receipt is issued for it.
  const checkFailed = (check, msg) => {
    skipped[check] = true;
    skippedWhy[check] = `error: ${msg}`;
    blockers.push({
      type: 'check-skipped',
      check,
      reason: `${check} check could not run to a result: ${msg} (${check === 'lint' ? 'lint' : '`feedback-sync --check`'} 를 직접 돌려 원인을 고친 뒤 close 를 다시 하면 된다. 영수증이 없으면 Stop 이 계속 close 를 요구한다)`,
    });
  };

  // log-only synthetic close mode. A non-project (tooling / wiki-only)
  // session has no project to close. Activated either by the explicit writer flag
  // (opts.logOnly, from `--mark-session-closed --log-only`) or by a log-only marker
  // for opts.sessionId (the PreCompact / --check-session-close readers). In this
  // mode the project-close invariant is replaced by a today log.md entry (minimum
  // proof), and — critically — the active/phantom project is NEVER put in
  // close.projects, because that set ALSO drives the lint scope and W8 ownership
  // below. Exempting only the close blocker would still let an unrelated project's
  // stale design-history / lint block the non-project session (codex design
  // BLOCKER). git / hot / lint(self) / feedback all still apply — not a bypass.
  // opts.closeMarker, when the key is set, is the marker the caller already
  // judged with closeCheckpointState (hooks/close-receipt.mjs): the marker of a
  // finished close, or null when the close is broken or open. Stop, PreCompact
  // and --check-session-close pass it, so a marker whose receipt is missing or
  // invalid never sets log-only mode or attribution here. It is injected rather
  // than computed because close-receipt.mjs imports this module. Without it the
  // raw marker is read as before (the apply paths, which invalidate this
  // session's marker before they reach this gate).
  const marker =
    opts.closeMarker !== undefined
      ? opts.closeMarker
      : opts.sessionId
        ? readSessionClosedMarker(hypoDir, opts.sessionId)
        : null;
  const logOnly = opts.logOnly === true || marker?.scope === 'log-only';

  // Paths this session is accountable for at THIS close: the signals the lint
  // partition below trusts for the question "is this file mine or pre-existing
  // debt". Base = the mandatory close-target files (opts.lintScope
  // override, else the log-only shared root files, else one project's close
  // files under projectOverride, else every today-active project's); widened by
  // every file this session's transcript shows it editing directly.
  const closeAccountableScope = new Set(
    opts.lintScope ||
      (logOnly
        ? ['hot.md', 'log.md']
        : opts.projectOverride
          ? closeFileTargetsForProject(hypoDir, opts.projectOverride)
          : closeFileTargetsGlobal(hypoDir)),
  );
  // The transcript widens the lint scope to the wiki files this session edited
  // directly. It plays no part in the git axis below, which judges by the
  // session's touched-paths record.
  if (opts.transcriptPath) {
    for (const f of extractTouchedWikiFiles(opts.transcriptPath, hypoDir)) {
      closeAccountableScope.add(f);
    }
  }

  // 1. wiki git state. An uncommitted file blocks only when this session's
  //    touched-paths record (or its failure flag) says the write is this
  //    session's. A DIFFERENT session sharing this vault can leave the working
  //    tree non-empty with its own dirty file (the 2026-08-03 multi-session
  //    block). That file is human-fixable by whoever owns it, not by this
  //    session, so it demotes to a notice (listed by path, never silently
  //    dropped) instead of refusing this session. "Cannot attribute" is not
  //    "clean" either: an enumeration failure (dirty.length === 0 despite
  //    git.uncommitted === true) blocks, and so does every file of the project
  //    folder being closed when the record lost paths it cannot name.
  //    Unpushed commits (ahead) DEMOTE to a notice regardless of scope: push is
  //    automatic (auto-commit Stop hook) and its failures are already non-fatal, so
  //    "ahead" is a transient sync state, not a human-fixable blocker. Demoting it
  //    here (the shared gate) keeps the marker == compact-ready invariant:
  //    a committed-but-unpushed close marks AND compacts, instead of the close writer
  //    committing its own payload and then being blocked by its own (unpushed) commit.
  const git = hypoIsClean(hypoDir, { deadline });
  // One git axis for every caller (Stop, PreCompact, check, --mark, apply): the
  // question is "is there an uncommitted write THIS session recorded (or failed
  // to record)". The project folder being closed blocks only what the record
  // says is this session's, and every file in it only when the record itself
  // lost paths it cannot name (or there is no session to read a record of).
  // Everything else is another session's or nobody's, and is listed as a
  // notice. The other axes (close files, cwd, hot structure, lint, W8,
  // feedback) are untouched below. checkpointMode, set by the two marker
  // writers, adds one thing: a session id that fails validation is a blocker of
  // its own instead of reading as "no session".
  if (opts.checkpointMode && !isValidSessionId(opts.sessionId)) {
    blockers.push({
      type: 'checkpoint-session',
      reason: 'checkpointMode requires a validated sessionId',
    });
  } else if (git.uncommitted) {
    const dirty = gitDirtyFiles(hypoDir, { deadline });
    if (dirty.length === 0) {
      // Enumeration itself failed (or nothing is actually dirty despite the
      // porcelain status): "cannot attribute" is not "clean", so fail closed.
      // One exception: the gate deadline ran out, so there is no file list to
      // judge. That blocks only when this session has a record of writing
      // anything (touched-paths or a failure flag), else it is a notice.
      const timedOut = cut();
      const recorded =
        isValidSessionId(opts.sessionId) &&
        (readTouchedPathsStrict(hypoDir, opts.sessionId, touchedLockBudget(deadline)).state !==
          'empty' ||
          readTouchedPathsFailed(hypoDir, opts.sessionId).failed);
      if (timedOut && !recorded) {
        notices.push({
          type: 'unresolved',
          reason: `could not list the uncommitted files within the gate deadline (${GATE_DEADLINE_MS} ms), and this session has no record of writing (마감 안에 미커밋 파일을 열거하지 못함)`,
        });
      } else {
        blockers.push({
          type: 'git',
          reason: timedOut
            ? `could not list the uncommitted files within the gate deadline (${GATE_DEADLINE_MS} ms) and this session has a record of writing (마감 안에 미커밋 파일을 열거하지 못함, 이 세션의 기록이 있다. 다시 시도하면 된다)`
            : git.reason,
        });
      }
    } else {
      // No valid session id (a check run without --session-id): there is no
      // record to read, so nothing can be told apart as this session's and
      // the project folder rule below applies to every file in it.
      const hasSession = isValidSessionId(opts.sessionId);
      const touched = hasSession
        ? readTouchedPathsStrict(hypoDir, opts.sessionId, touchedLockBudget(deadline))
        : { state: 'empty', paths: [] };
      if (touched.state === 'locked') {
        // Another writer holds this session's touched-paths lock right now
        // (usually this session's own Stop auto-commit). Transient, so
        // block: the retry reads the real set instead of guessing.
        blockers.push({
          type: 'known-session-write',
          reason: 'touched-paths lock timed out (다른 쓰기가 끝난 뒤 다시 시도하면 된다)',
        });
      } else {
        // An unreadable set reads as "no record" and would read the same on
        // every retry, so it is not a blocker of its own (that refused every
        // close for good). It widens the project folder rule instead
        // (folderWide below): the record can no longer say which files in the
        // folder are this session's, so all of them block, with the way out
        // in the reason.
        if (touched.state === 'unreadable') {
          notices.push({
            type: 'touched-paths-unreadable',
            reason:
              'touched-paths unreadable: ownership of dirty files outside the project folder being closed was not judged (touched-paths 기록을 읽지 못해 프로젝트 폴더 밖 파일의 소유를 판정하지 못했다)',
          });
        }
        // A record that failed to land leaves a failure flag
        // (touched-paths-failed.json, see markTouchedPathsFailed). A flagged
        // path blocks wherever it sits until its record lands, HEAD moves
        // past it, or the flag is removed. A flag that lost paths it cannot
        // name (pathsUnknown), or an unreadable record, makes the whole
        // project folder being closed block (folderWide): another session's
        // dirty file there stays a notice only while the record is complete.
        // With no project named (a --mark without --project), whose folder
        // it is cannot be told, so every projects/ file counts. A log-only
        // close names no project by design, so none does.
        const failed = hasSession
          ? readTouchedPathsFailed(hypoDir, opts.sessionId)
          : { failed: false, entries: {}, pathsUnknown: false, reasons: [] };
        const flagged = (pf) =>
          Object.hasOwn(failed.entries, pf) &&
          flaggedPathStillPending(hypoDir, pf, failed.entries[pf], { deadline });
        const folderWide = !hasSession || failed.pathsUnknown || touched.state === 'unreadable';
        const cacheDir = hasSession ? `.cache/sessions/${sanitizeSessionId(opts.sessionId)}` : '';
        const folderWideExit = [
          !hasSession
            ? '이 호출에는 세션 id 가 없어 쓰기 기록을 읽지 못했다. 세션 id 를 알려 주면(--session-id) 이 세션이 쓴 파일만 막는다'
            : null,
          failed.pathsUnknown
            ? `${cacheDir}/touched-paths-failed.json 을 지우면 이 세션의 표시가 풀린다. 지우기 전에 잃은 경로가 이미 커밋됐는지 git status 로 확인한다`
            : null,
          touched.state === 'unreadable' && touched.cause === 'corrupt'
            ? `손상된 ${cacheDir}/touched-paths.json 을 살펴보고 지우면 풀린다. 지우기 전에 이 세션이 쓴 파일이 이미 커밋됐는지 git status 로 확인한다`
            : null,
          touched.state === 'unreadable' && touched.cause === 'lock-failed'
            ? `${cacheDir}/ 디렉터리의 권한과 디스크 공간을 점검한다 (파일을 지워도 고쳐지지 않는다)`
            : null,
        ]
          .filter(Boolean)
          .join('. ');
        const closeSlug = opts.projectOverride || opts.attributionScope || null;
        const inClosedProject = (f) =>
          closeSlug
            ? f.startsWith(`projects/${closeSlug}/`)
            : !logOnly && f.startsWith('projects/');
        const touchedSet = new Set((touched.paths || []).map(posixPath));
        const driftedSet = new Set(
          hasSession
            ? readTouchedPathsDrifted(hypoDir, opts.sessionId, touchedLockBudget(deadline)).map(
                posixPath,
              )
            : [],
        );
        const ignorePatterns = loadHypoIgnore(hypoDir);
        // A session entry of a `.hypoignore` project is never committed by
        // anything, so it is dirty for good and would refuse every close of
        // that project. This session's own one is proven by its close pin's
        // local proof instead (the receipt checks the same bytes); another
        // session's is that session's to prove. Only an own entry whose bytes
        // no longer match its proof still blocks, below.
        const provenLocal = new Set(
          Object.values(hasSession ? readClosePin(hypoDir, opts.sessionId).localProofs : {})
            .filter((p) => fileSha256(join(hypoDir, p.entryRelPath)) === p.entrySha256)
            .map((p) => posixPath(p.entryRelPath)),
        );
        for (const f of dirty) {
          const pf = posixPath(f);
          // First, ahead of the local-entry and foreign-append exceptions:
          // an active flag means a record of this path was lost, so who owns
          // the bytes is not left to those exceptions.
          if (flagged(pf)) {
            blockers.push({
              type: 'known-session-write',
              file: f,
              reason: `이 세션의 쓰기 기록이 실패한 파일이 아직 미커밋이다: ${f} (기록 실패 표시 ${cacheDir}/touched-paths-failed.json 이 이 경로를 가리킨다. 커밋하거나 되돌리면 풀린다)`,
            });
            continue;
          }
          if (
            ignorePatterns.length > 0 &&
            isSessionEntryPath(pf) &&
            isIgnored(join(hypoDir, f), hypoDir, ignorePatterns) &&
            (provenLocal.has(pf) || !touchedSet.has(pf))
          ) {
            notices.push({
              type: 'local-entry',
              file: f,
              reason: provenLocal.has(pf)
                ? `${f} stays out of git (.hypoignore); this session's close pin proves its bytes`
                : `${f} stays out of git (.hypoignore) and belongs to another session's close`,
            });
            continue;
          }
          // Past the deadline the ownership exceptions below (another session's
          // append or entry) cannot be judged, so they are not applied: a file
          // this session recorded still blocks, any other is an unresolved notice.
          if (!cut() && isForeignAppendOnlyShard(hypoDir, pf, opts.sessionId, { deadline })) {
            // Ahead of the touched-set check: the shard this session's close
            // committed stays in its set until Stop, and the later close of the
            // same project appends to it before this marker gate is done.
            notices.push({ type: 'foreign-append', file: f, reason: FOREIGN_APPEND_NOTICE(f) });
            continue;
          }
          if (touchedSet.has(posixPath(f))) {
            // A touched file .hypoignore keeps out of every commit stays
            // dirty forever on its own: say how to get out. A file whose
            // bytes changed after this session recorded it is kept out of
            // the auto-commit (commitTouchedPaths), so say that too.
            const pathHint = emptyNewIndexHint(hypoDir, pf, { deadline })
              ? ' (빈 파일이다. 이 세션의 close 가 만들다 멈춘 것이니 지우고 close 를 다시 하면 된다)'
              : ignorePatterns.length > 0 && isIgnored(join(hypoDir, f), hypoDir, ignorePatterns)
                ? ' (.hypoignore 대상이라 자동 커밋되지 않는다. 손으로 커밋하거나 .hypoignore 에서 빼야 close 가 된다)'
                : driftedSet.has(posixPath(f))
                  ? ' (이 세션이 기록한 뒤 다른 쓰기가 이 파일을 바꿔서 자동 커밋에서 빠진다. 지금 내용이 맞는지 확인하고 손으로 커밋해야 close 가 된다)'
                  : '';
            blockers.push({
              type: 'known-session-write',
              file: f,
              reason: `this session's own write is still uncommitted: ${f}${pathHint}`,
            });
          } else if (
            !cut() &&
            isForeignUncommittedEntry(hypoDir, pf, opts.sessionId, { deadline })
          ) {
            // Two sessions closing one project at once: the other one's entry
            // is published and its commit has not landed yet.
            notices.push({ type: 'foreign-entry', file: f, reason: FOREIGN_ENTRY_NOTICE(f) });
          } else if (folderWide && inClosedProject(posixPath(f))) {
            blockers.push({
              type: 'git',
              file: f,
              reason: `${
                closeSlug
                  ? `uncommitted file in the project folder being closed: ${f}`
                  : `uncommitted file under projects/ and this close names no project: ${f}`
              } (이 세션의 쓰기 기록이 불완전해서(잃은 경로를 모름) close 하는 프로젝트 폴더의 미커밋 파일을 모두 막는다. ${folderWideExit}. 커밋하거나 되돌려도 풀린다)`,
            });
          } else {
            notices.push({
              type: 'unresolved',
              file: f,
              reason: cut()
                ? `uncommitted changes, ownership not judged within the gate deadline (${GATE_DEADLINE_MS} ms): ${f} (마감 안에 귀속을 정하지 못함)`
                : `uncommitted changes, ownership unknown: ${f}`,
            });
          }
        }
      }
    }
  } else if (git.ahead) {
    notices.push({
      type: 'git-sync',
      reason: `unpushed commits in ${hypoDir} (push deferred to Stop hook)`,
    });
  }

  // 2. root hot.md structure
  const hot = hotMdIsClean(hypoDir);
  if (!hot.clean) blockers.push({ type: 'hot', reason: hot.reason });

  // 3. session-close files (global invariant); in log-only mode,
  //    the minimum proof (a today log.md entry) with NO project attribution.
  let close;
  if (logOnly) {
    const hasLog = hasAnyTodayLogEntry(hypoDir);
    close = {
      ok: hasLog,
      projects: [],
      dates: freshDates(),
      fallback: false,
      primary: null,
      project: null,
      stale: [],
      missing: hasLog ? [] : ['log.md (no today session entry)'],
    };
    if (!hasLog) {
      blockers.push({
        type: 'close',
        reason: 'log-only close: log.md has no today session entry (minimum proof)',
      });
    }
  } else {
    // projectOverride narrows the close status to one project (check-only); a
    // marker-writing caller never sets it. It attributes instead through
    // opts.attributionScope, consumed a few lines down by resolveCloseScope, so
    // the status computed here stays global and only the partition below scopes it.
    // scopeSet is computed BEFORE the status so the attributed slugs become
    // mandatory evaluation targets (sessionCloseGlobalStatus's mustEvaluate).
    // Computing it after would let a slug reach the marker that the status never
    // looked at, which is the false-green this ordering exists to stop.
    const attributedScope = resolveCloseScope(hypoDir, opts, marker);
    close = sessionCloseGlobalStatus(hypoDir, {
      projectOverride: opts.projectOverride,
      // direct only: a past marker's projects must not become mandatory
      // evaluation targets (codex round 2). They stay in attributedScope so the
      // partition still treats them as this session's, not foreign debt.
      mustEvaluate: attributedScope.direct,
    });
    // A project that a pre-entry writer closed today: never a blocker, only said.
    for (const n of close.notices || []) notices.push(n);

    // Attribute the close debt before blocking on it. An incomplete close belongs
    // to whichever session performed it; charging it to an unrelated session is the
    // false block this partition exists to stop. The gate already draws exactly this
    // line for LINT debt (partitionLintScope: errors in files THIS session touched
    // block, pre-existing debt elsewhere is a notice) — close-file debt was the one
    // check still hard-blocking globally on another session's work.
    //
    // Two fail-closed guards keep the partition from eating a real blocker:
    //   - close.fallback: no project closed today, so this is the "you have not
    //     closed this session AT ALL" path. It must block unconditionally; demoting
    //     it would gut the gate's whole purpose.
    //   - empty scope: no positive attribution signal, so we cannot tell whose debt
    //     it is. Never demote on a guess — fall back to today's global block.
    //   - projectOverride: the caller asked "is THIS project close-complete?".
    //     Demoting the very project it named would answer a question nobody asked.
    //
    // Bounded tradeoff (codex design review, accepted rather than closed). A
    // scripted close that CRASHES mid-write leaves no marker and no transcript trace
    // (it writes from inside a Bash call), so its own project carries no attribution.
    // If that same session had also hand-edited SOME OTHER project's close files, the
    // scope is non-empty but omits the torn project, and its debt is demoted. The
    // window is narrow and self-limiting: apply writes the project files, then the
    // session-log, then the root log entry, so the only torn state that reaches this
    // partition at all is a missing log.md entry — which deriveRootLogEntries
    // regenerates from the session-log heading. A crash before the session-log is not
    // detected as today-active by hasTodayCloseActivity in the first place (the
    // pre-existing tradeoff documented there). And the marker is never written, so the
    // Stop hook still refuses to end the session. Closing this properly needs a
    // durable close-attempt record; it is not worth a new state-file lifecycle here.
    const scopeSet = attributedScope;
    const failed = (close.projects || []).filter((p) => !p.ok);
    const partition =
      !close.fallback && !opts.projectOverride && scopeSet.size > 0 && failed.length > 0;

    close.scope = [...scopeSet];
    close.debt = [];
    // Re-project the flat aliases onto what actually BLOCKS, so `ok` and
    // `stale`/`missing` can never contradict each other (a reader that treats a
    // non-empty `missing` as failure stays correct). Demoted debt moves to its own
    // `debt` field instead of masquerading as this session's unfinished work.
    //
    // ONLY when partitioning. Deriving `ok` from the per-project rows unconditionally
    // would silently drop the failures that have NO project row to be derived from:
    // an unresolvable active project yields `projects: []` with
    // `missing: ['hot.md (no active project in pointer table)']`, so an empty `failed`
    // would read as "nothing failed" and flip a red gate green (codex pre-commit
    // BLOCKER, reproduced on a vault with no active-project row). Outside the
    // partition the close status stands exactly as sessionCloseGlobalStatus computed it.
    if (partition) {
      const mine = failed.filter((p) => scopeSet.has(p.project));
      const foreign = failed.filter((p) => !scopeSet.has(p.project));
      close.debt = foreign.map((p) => ({ project: p.project, stale: p.stale, missing: p.missing }));
      close.stale = [...new Set(mine.flatMap((p) => p.stale))];
      close.missing = [...new Set(mine.flatMap((p) => p.missing))];
      close.ok = mine.length === 0;
      // The flat `project` alias must follow the scope too: it names the project the
      // rest of this status describes, and every consumer that renders a per-file
      // checklist builds it from that name. Left as the global `primary` it can point
      // at a DEMOTED foreign project, and the checklist then reports ✓ for files the
      // debt list simultaneously calls missing (codex pre-commit CONCERN).
      if (!scopeSet.has(close.project)) {
        close.project = mine[0]?.project ?? [...scopeSet][0] ?? close.project;
      }
    }

    if (!close.ok) {
      blockers.push({
        type: 'close',
        reason: `memory files not updated this session: ${[
          ...close.missing.map((f) => `${f} (missing)`),
          ...close.stale.map((f) => `${f} (stale)`),
        ].join(', ')}`,
      });
    }
    for (const p of close.debt) {
      notices.push({
        type: 'close-debt',
        project: p.project,
        reason: `${p.project}: incomplete session close from another session (${[
          ...p.missing.map((f) => `${f} (missing)`),
          ...p.stale.map((f) => `${f} (stale)`),
        ].join(', ')}) — not blocking; that project's next close will fix it`,
      });
    }
  }

  // 3b. session-cwd close (session-cwd close check). The current session's cwd project is an
  // INDEPENDENT close responsibility. sessionCloseGlobalStatus above only sees
  // projects that left an authoritative close-activity trace (a session-log
  // heading / log.md entry), so a project whose close was NEVER STARTED is
  // invisible — and if the recency project was closed the same day, the gate would
  // go green while this session's real project stays unclosed (the false-green this
  // closes). Evaluate it here, AFTER the partition and OUTSIDE scopeSet /
  // close.projects, so it can neither be demoted to foreign debt (partition) nor
  // spawn a W8 design-history blocker (which derives from close.projects). log-only
  // sessions are exempt (no project to close). apply never passes sessionCwd (its
  // launch cwd may differ from the authoritative payload.project — a supported
  // cross-project close), so this runs only on the read / mark paths.
  if (!logOnly && opts.sessionCwd) {
    const cwdProject = pickProjectByCwd(collectProjectWorkingDirs(hypoDir), opts.sessionCwd, {
      rejectAmbiguous: true,
    });
    if (cwdProject) {
      // THIS session's close, proven by its own close id: a fresh close of the
      // same project by another session, or this session's earlier close while
      // a new close request is open, does not count.
      const s = sessionCloseFileStatus(hypoDir, {
        scope: 'session',
        closeId: sessionProofCloseId(hypoDir, opts.sessionId, {
          closeOpen: opts.closeOpen,
          resolvedAtIndex: opts.resolvedAtIndex,
          project: cwdProject,
        }),
        projectOverride: cwdProject,
        deadline,
      });
      // The notices of the session-scope check (a project with no log lines under the
      // entry's date) belong to the gate result: a caller that reads only `notices[]` would
      // never see them otherwise.
      for (const n of s.notices || []) notices.push(n);
      if (!s.ok) {
        // ALWAYS emit the typed close-cwd blocker when the cwd project's close is
        // incomplete — never suppress it as a duplicate of the global `close`
        // blocker. The Stop hook keys its marker re-check on this exact type, so
        // hiding it (even when a `close` blocker names the same project) would let
        // Stop honor a stale marker and end the session green (codex pre-commit
        // BLOCKER). A second entry for the same slug is merely noisy, never wrong.
        blockers.push({
          type: 'close-cwd',
          project: cwdProject,
          reason: s.incomplete
            ? `could not finish proving this session's close of '${cwdProject}' within the gate deadline (${GATE_DEADLINE_MS} ms, slow git). The close did not fail; try again (마감 안에 이 세션의 close 증명을 마치지 못함)`
            : `session cwd project '${cwdProject}' has an incomplete session close: ${[
                ...s.missing.map((f) => `${f} (missing)`),
                ...s.stale.map((f) => `${f} (stale)`),
              ].join(', ')}`,
        });
        // If the partition demoted this project to foreign debt, it is NOT another
        // session's work — it is THIS session's, and we just BLOCKED on it. Remove
        // it from BOTH the debt notice and close.debt so the status cannot report
        // the same project as non-blocking debt and a blocker at once (codex
        // pre-commit CONCERN: crystallize renders close_debt from close.debt).
        for (let i = notices.length - 1; i >= 0; i--) {
          if (notices[i].type === 'close-debt' && notices[i].project === cwdProject)
            notices.splice(i, 1);
        }
        if (Array.isArray(close.debt))
          close.debt = close.debt.filter((d) => d.project !== cwdProject);
      }
    } else {
      // cwd is under no project working_dir, or ambiguously under several (a
      // monorepo tie pickProjectByCwd declined): we cannot attribute a close
      // responsibility, so we do NOT hard-block (nothing proves there is anything
      // to close). Surface a best-effort notice so the coverage gap is visible.
      // This reason names --project / --log-only, the crystallize CLI flags:
      // correct for a --check-session-close caller, but not a lever a
      // PreCompact hook reader has. The hook renderer (hypo-personal-check.mjs)
      // builds its own sentence for this notice type instead of echoing this
      // one verbatim; keep both in sync if the underlying condition changes.
      notices.push({
        type: 'close-cwd-unresolved',
        reason:
          'session cwd did not resolve to a unique project — the P2 cwd close check is best-effort here; pass --project or --log-only to be explicit',
      });
    }
  }

  // 4. lint blockers + W8 design-history (scoped). Mirrors hypo-personal-check.
  const lintPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'lint.mjs') : null;
  if (!lintPath || !existsSync(lintPath)) {
    skipped.lint = true; // no package → fail-open (never block on missing tooling)
    skippedWhy.lint = 'tool missing: scripts/lint.mjs not found (no package root or no such file)';
  } else {
    try {
      // Pass --hypo-dir explicitly: lint.mjs resolves the vault via HYPO_DIR /
      // home dirs and ignores cwd, so a --hypo-dir caller (crystallize, tests)
      // would otherwise lint the ambient wiki, not the one under test.
      // maxBuffer matches crystallize's runLint (64 MiB): warn-heavy output on a
      // large wiki easily exceeds Node's 1 MiB default, which would truncate
      // stdout and (via the catch below) silently fail-open this gate.
      const run = startCheck('lint', [lintPath, '--json', `--hypo-dir=${hypoDir}`], {
        encoding: 'utf-8',
        cwd: hypoDir,
        maxBuffer: 64 * 1024 * 1024,
      });
      const r = run.res;
      // The time limit the gate gave (or none left to start): a notice, handled
      // in the catch below, never a blocker.
      if (run.kind === 'deadline' || run.kind === 'timeout') {
        throw Object.assign(new Error('lint hit the gate time limit'), { timeLimit: run });
      }
      // A spawn failure (ENOENT), an outside kill (a signal), or a crash that
      // produced no stdout must NOT be parsed as `{}` and treated as a clean
      // lint — that path leaves skipped.lint=false with no notice, an INVISIBLE
      // fail-open. Throw instead so the catch below records skipped.lint=true and
      // a `check-skipped` blocker.
      if (run.kind === 'spawn-error' || run.kind === 'signal') {
        throw new Error(`lint spawn failed: ${r.error?.code || `signal ${r.signal}`}`);
      }
      if (!r.stdout || !r.stdout.trim()) {
        throw new Error(
          `lint produced no stdout (exit=${r.status})${r.stderr ? `: ${r.stderr.slice(-500)}` : ''}`,
        );
      }
      const parsed = JSON.parse(r.stdout);
      const allErrors = parsed.errors || [];
      const allW8 = (parsed.warns || []).filter((w) => w.id === 'W8');
      // Lint scope = closeAccountableScope, hoisted above step 1 so the git
      // check can partition on the same "is this mine" answer. See that
      // hoisted comment for what feeds it (opts.lintScope override, else
      // log-only's shared root files, else one project's close files under
      // projectOverride, else the global set, widened by transcript-touched
      // files).
      const scope = closeAccountableScope;
      const part = partitionLintScope(allErrors, scope);
      if (part.blocking.length > 0) {
        blockers.push({
          type: 'lint',
          reason: `lint blockers: ${[...new Set(part.blocking.map((b) => b.id || b.file))].join(', ')}`,
        });
      }
      for (const n of part.notice)
        notices.push({
          type: 'lint',
          file: n.file,
          reason: `${n.file}${n.id ? ` (${n.id})` : ''}`,
        });
      // W8 (design-history stale) is each today-active project's own close
      // responsibility; others' are non-blocking notices. In log-only
      // mode there is NO project this session is accountable for, so every W8 is a
      // notice — a non-project session must never be blocked by some project's
      // stale design-history (codex design BLOCKER: the attribution leak this fix
      // closes).
      const activeSlugs = logOnly
        ? []
        : (close.projects || []).map((p) => p.project).filter(Boolean);
      const mine = new Set(activeSlugs.map((s) => `projects/${s}/design-history.md`));
      const w8Blocking = logOnly
        ? []
        : activeSlugs.length > 0
          ? allW8.filter((w) => mine.has(w.file))
          : allW8;
      const w8Notice = logOnly
        ? allW8
        : activeSlugs.length > 0
          ? allW8.filter((w) => !mine.has(w.file))
          : [];
      if (w8Blocking.length > 0) {
        blockers.push({
          type: 'design-history',
          reason: `design-history stale: ${w8Blocking.map((w) => w.file.split('/')[1]).join(', ')}`,
        });
      }
      for (const w of w8Notice)
        notices.push({ type: 'design-history', file: w.file, reason: w.file });
    } catch (e) {
      // Only a time limit fails open (a notice). Anything else (a crash, an
      // outside kill, no or broken stdout) blocks, with the cause in the reason.
      if (e.timeLimit) checkTimeLimit('lint', e.timeLimit);
      else checkFailed('lint', e.message || e.code || 'unknown error');
    }
  }

  // 5. feedback projection. over-cap/conflict block; pure
  //    drift is a self-healable notice (driftTargets = effect requirement the
  //    hook runs as --write). Classification mirrors hypo-personal-check exactly.
  const feedbackPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'feedback-sync.mjs') : null;
  const claudeHome = opts.claudeHome || join(HOME, '.claude');
  if (!feedbackPath || !existsSync(feedbackPath)) {
    skipped.feedback = true;
    skippedWhy.feedback =
      'tool missing: scripts/feedback-sync.mjs not found (no package root or no such file)';
  } else {
    try {
      const run = startCheck(
        'feedback',
        [
          feedbackPath,
          '--check',
          '--strict',
          '--no-input',
          '--json',
          `--hypo-dir=${hypoDir}`,
          `--claude-home=${claudeHome}`,
        ],
        { encoding: 'utf-8' },
      );
      const r = run.res;
      if (run.kind === 'deadline' || run.kind === 'timeout') {
        checkTimeLimit('feedback', run); // a time limit: notice, fail-open
      } else if (run.kind === 'spawn-error' || run.kind === 'signal') {
        throw new Error(`feedback-sync spawn failed: ${r.error?.code || `signal ${r.signal}`}`);
      } else {
        // A non-zero exit carries an actionable issue. A clean check exits 0 and is NOT
        // skipped, just nothing to do, except that its report can still carry
        // sideWarnings (a hand-written feedback_<slug>.md in the way): those exit 0, so
        // the report is read for them too.
        let report = null;
        try {
          report = JSON.parse(r.stdout || '');
        } catch {
          /* unparseable: an error, thrown below */
        }
        // Output that does not parse, or a report that says `error`, is an error
        // whatever the exit code (a broken or empty report on exit 0 included).
        // A parsed report without `error` and without anything to act on stays
        // fail-open below, even on a non-zero (strict) exit.
        if (!report || typeof report !== 'object' || report.error) {
          throw new Error(
            report?.error
              ? `feedback-sync reported an error: ${report.error}`
              : `feedback-sync output did not parse (exit=${r.status})${r.stderr ? `: ${String(r.stderr).slice(-500)}` : ''}`,
          );
        }
        const entries = report ? Object.entries(report.targets || {}) : [];
        const conflictedT = entries
          .filter(
            ([, t]) =>
              t.intruder ||
              t.unpaired ||
              t.outOfContainer ||
              (t.conflicts && t.conflicts.length) ||
              (t.sideEdited && t.sideEdited.length),
          )
          .map(([n]) => n);
        const overCapT = entries.filter(([, t]) => t.overCap).map(([n]) => n);
        const driftedT = entries.filter(([, t]) => t.dirty).map(([n]) => n);
        // A target whose file EXISTS but cannot be projected into (its
        // <learned_behaviors> container is gone) reports dirty:false with no
        // conflict flag — it cannot be built, so nothing "would change". That
        // shape used to fall into the non-actionable branch below and fail OPEN,
        // the worst possible reading: a projection that loads ZERO rules on this
        // machine was classified as "nothing to do" and waved through. It is a
        // blocker, not a shrug.
        //
        // ONLY kind 'build-failed'. A 'target-missing' buildError (no ~/.claude/
        // CLAUDE.md yet) is the ordinary first-run state and must keep failing
        // OPEN, or the gate blocks every new user on their first /compact.
        const buildErrT = entries
          .filter(([, t]) => t.buildError && t.buildErrorKind === 'build-failed')
          .map(([n]) => n);
        // Side-file I/O trouble (an unreadable feedback_<slug>.md under the
        // project memory dir) is a NOTICE, never a blocker: the primary
        // projection still loads every rule, and the only fix is a permission
        // bit on that path — `--ensure-container` cannot touch it. A gate that
        // blocks on a condition its own named remedy cannot clear is a gate that
        // gets bypassed.
        const sideWarnT = entries.filter(([, t]) => (t.sideWarnings || []).length);
        if (
          r.status !== 0 &&
          (!report ||
            !(
              conflictedT.length ||
              overCapT.length ||
              driftedT.length ||
              buildErrT.length ||
              sideWarnT.length
            ))
        ) {
          skipped.feedback = true; // parsed, no error, nothing actionable → fail-open
          skippedWhy.feedback = `not actionable: feedback-sync --strict exited ${r.status} with nothing to act on`;
        } else if (buildErrT.length) {
          // Name the EXACT target file and the remedy for THIS cause. "Restore
          // the managed container" with no path is a dead end, and so is naming
          // `--ensure-container` for a permission error or a dangling symlink,
          // which it cannot fix — a blocker with no way through gets bypassed
          // rather than obeyed. t.buildError carries the target's absolute path
          // and t.buildErrorRemedy the cause-specific way out; feedback-sync
          // makes that judgment once, at the branch that detects the cause.
          const failed = entries.filter(([n]) => buildErrT.includes(n));
          const details = failed.map(([n, t]) => `${n}: ${t.buildError}`).join('; ');
          const remedies = [
            ...new Set(failed.map(([, t]) => t.buildErrorRemedy).filter(Boolean)),
          ].join(' ');
          blockers.push({
            type: 'feedback',
            reason: `feedback projection cannot be built — ${details} — no rules are loaded from it. ${remedies}`,
          });
        } else if (conflictedT.length) {
          // The remedy text comes from the report (feedback-sync names the real
          // slugs and leaves out --accept-wiki for an unpaired file). A report from an
          // older installed script has none, and this hook cannot tell from the report
          // which of its shapes is the right way out (the import command it used to
          // fall back to does nothing for an intruder-only target), so that target gets
          // a generic pointer and no state-specific command.
          const remedies = [
            ...new Set(
              entries
                .filter(([n]) => conflictedT.includes(n))
                .map(([, t]) =>
                  typeof t.conflictRemedy === 'string' && t.conflictRemedy
                    ? t.conflictRemedy
                    : 'the installed feedback-sync sent no remedy for this target (its version differs from this hook): run `hypomnema feedback-sync --check` for the details, and update Hypomnema so the hook and the script match.',
                ),
            ),
          ].join(' ');
          blockers.push({
            type: 'feedback',
            // reasons are rendered with an appended period and joined with ', ', so
            // the full-sentence remedy loses its own final period here (CLI and doctor keep it)
            reason:
              `feedback projection conflict (manual edit of ${conflictedT.join(', ')}): ` +
              remedies.replace(/\.$/, ''),
          });
        } else if (overCapT.length) {
          blockers.push({
            type: 'feedback',
            reason: `feedback projection over cap (${overCapT.join(', ')}) — demote/archive feedback pages`,
          });
        } else if (driftedT.length) {
          driftTargets.push(...driftedT); // pure drift → self-healable, not a blocker
          notices.push({
            type: 'feedback',
            reason: `feedback projection drift (${driftedT.join(', ')}) — will self-heal at /compact`,
          });
        }
        // Additive, and deliberately outside the chain above: a side-file problem
        // is orthogonal to the primary target's health, so it is a notice whatever
        // else is (or is not) going on. Two kinds reach here. "cannot read side
        // file" is an I/O error whose only way out is a permission bit on that
        // path (`--ensure-container` cannot touch it), so only that kind carries
        // the permissions advice. "not overwriting ..." is feedback-sync declining
        // to replace a hand-written file that lacks its provenance header; the
        // warning text already says to rename or delete it, and calling it
        // unreadable or pointing at permissions would be wrong. The reason has no
        // trailing period: the hook that renders it appends one.
        for (const [n, t] of sideWarnT) {
          const unreadable = t.sideWarnings.some((w) => w.startsWith('cannot read side file'));
          notices.push({
            type: 'feedback',
            reason:
              `feedback projection side file warning (${n}): ${t.sideWarnings.join('; ')}. ` +
              'The primary projection still loads every rule' +
              (unreadable
                ? '. Fix the permissions on that path; --ensure-container does not fix this'
                : ''),
          });
        }
      }
    } catch (e) {
      checkFailed('feedback', e.message || e.code || 'unknown error');
    }
  }

  return { ok: blockers.length === 0, close, blockers, notices, driftTargets, skipped, skippedWhy };
}

// ── session-close checklist ────────────────────────────────────────────────

/**
 * Read the session-close checklist from hypo-guide.md.
 * Falls back to null if the guide is unavailable or the section can't be parsed.
 */
export function readChecklist(today) {
  if (!existsSync(GUIDE_PATH)) return null;
  try {
    const lines = readFileSync(GUIDE_PATH, 'utf-8').split('\n');
    let collecting = false;
    const result = [];
    for (const line of lines) {
      if (!collecting && /^\[ \] 0\./.test(line.trim())) collecting = true;
      if (collecting) {
        if (/^─+$/.test(line.trim()) || line.trim() === '```') break;
        result.push(line);
      }
    }
    if (result.length === 0) return null;
    return result.join('\n').replace(/YYYY-MM-DD/g, today);
  } catch {
    return null;
  }
}

// ── session-state schema ───────────────────────────────────────────────────

/**
 * Accepted heading aliases for the "next task" section in session-state.md. The list lives in
 * session-entries.mjs (the baseline split reads it too); this is the name lint imports.
 */
export const SESSION_STATE_NEXT_HEADINGS = NEXT_UP_HEADINGS;

// ── misc helpers ───────────────────────────────────────────────────────────

/** Returns true if the prompt is a /compact command invocation. */
export function isCompactCommand(prompt) {
  return prompt === '/compact' || /^\/compact(\s|$)/.test(prompt);
}

/** Returns true if the prompt is a /clear command invocation. */
export function isClearCommand(prompt) {
  return prompt === '/clear' || /^\/clear(\s|$)/.test(prompt);
}

/** Returns true if the prompt is either /compact or /clear (Layer 2). */
export function isCompactOrClearCommand(prompt) {
  return isCompactCommand(prompt) || isClearCommand(prompt);
}

/**
 * Extract recent user-role message text from a JSONL transcript (last `tailN`
 * lines). Promoted from hypo-personal-check.mjs so both the
 * PreCompact gate and the Stop-chain Layer 3 hook share one close-intent
 * signal source. Claude Code transcript format: each line is
 * `{ type:"user", message:{ role:"user", content: ... } }`; the older
 * top-level `{ role, content }` shape is also accepted. tool_result blocks
 * (also role:'user') are excluded so tool output never feeds the close-intent
 * gate — only top-level `type:'text'` blocks and string content count.
 *
 * @param {string} transcriptPath
 * @param {number} tailN  how many trailing lines to scan (default 30)
 * @returns {string} newline-joined user text, or '' on any failure (fail-open)
 */
export function extractUserMessages(transcriptPath, tailN = 30) {
  return extractUserMessageRecords(transcriptPath, tailN, { keepEmpty: true }).join('\n');
}

/**
 * Same extraction as {@link extractUserMessages}, but ONE STRING PER TRANSCRIPT
 * RECORD instead of one flat blob. The message boundary is the point: a gate that
 * asks "did the user say exactly X" cannot ask it of text that has been joined
 * across turns, because any line of any message then looks like a whole message.
 * {@link hasTypedUserApproval} needs that boundary; the close-intent readers, which
 * only ever ask "does this text contain a close phrase", do not.
 *
 * @param {string} transcriptPath
 * @param {number} tailN  how many trailing lines to scan (Infinity → whole file)
 * @param {{keepEmpty?: boolean}} [opts]  keepEmpty preserves a '' per dropped record,
 *   so the joined form stays byte-identical to what extractUserMessages always returned.
 * @returns {string[]} user-typed text per record, or [] on any failure (fail-open)
 */
export function extractUserMessageRecords(transcriptPath, tailN = 30, { keepEmpty } = {}) {
  const records = extractUserRecordTexts(transcriptPath, tailN);
  return keepEmpty ? records : records.filter((t) => t !== '');
}

function extractUserRecordTexts(transcriptPath, tailN) {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    // tailN === Infinity → whole transcript (the marker-write hard gate needs the
    // full prefix; a close request can precede the marker by the entire close
    // checklist). The Stop hook keeps the 30-line default so a stale old close
    // signal doesn't re-trigger every turn.
    const tail = Number.isFinite(tailN) ? lines.slice(-tailN) : lines;
    return tail.map((line) => {
      try {
        const obj = JSON.parse(line);
        // Skill-injection vector: drop system-injected role:user
        // messages before they pollute the close-intent signal.
        //  • isMeta:true   — slash-command bodies, skill bodies, local-command
        //    caveats. Their text is docs/specs, often full of close vocabulary
        //    (e.g. the /hypo:crystallize spec literally contains close phrases),
        //    which would let the gate self-satisfy the moment the model invokes
        //    a close command. Confirmed isMeta:true in the transcript.
        //  • promptSource system|sdk — task-notifications (system) and
        //    SDK / QA-harness synthetic prompts (sdk). Neither is user-typed.
        if (obj.isMeta === true) return '';
        if (obj.promptSource === 'system' || obj.promptSource === 'sdk') return '';
        const msg = obj.message ?? obj;
        const role = msg.role ?? obj.role ?? obj.type;
        if (role !== 'user') return '';
        const content = msg.content ?? obj.content;
        if (typeof content === 'string') {
          // Stop-hook block feedback is recorded as a role:user string. It is
          // the hook's OWN nudge ("[WIKI_AUTOCLOSE] … Run crystallize …"), not
          // user intent — counting it would be circular (the hook that prods the
          // model to close would become proof the user wanted to close).
          return content.startsWith('Stop hook feedback') ? '' : content;
        }
        if (Array.isArray(content)) {
          // Only genuine user-typed text blocks. tool_result blocks are also
          // recorded with role:'user' in the Claude Code transcript; slurping
          // them via JSON.stringify let tool output (e.g. close-pattern example
          // strings read out of code/docs) trip the close-intent gate.
          // Do NOT recurse into tool_result.content, or the pollution returns.
          return content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n');
        }
        return '';
      } catch {
        return '';
      }
    });
  } catch {
    return [];
  }
}

/**
 * Returns true if the text contains a natural-language session-close signal.
 * Scans Korean and English close patterns. Designed for transcript user-message
 * text — favours low false-positive rate over recall.
 *
 * Examples that match: "세션 마무리하자", "오늘 여기까지", "wrap up", "signing off".
 * Examples that do NOT match: "이 함수 마무리하자", "wrap up this PR".
 */
export function isClosePattern(text) {
  if (!text || typeof text !== 'string') return false;
  const krPatterns = [
    // 끝: bare terminal noun, boundary-guarded so "세션 끝내는 방법" /
    // "세션 끝나면" don't trip.
    /세션\s*끝(?![가-힣])/,
    // 세션 마무리/종료: the OLD pattern required a fixed verb suffix
    // (하자/할게/했어) and missed the most common real phrasings — "세션 마무리
    // 해줘" (imperative), bare "세션 마무리", "세션마무리" (no space). A
    // blacklist lookahead (excluding 조건/로직/여부/…) is whack-a-mole because
    // noun-modifiers are an open class. WHITELIST instead: match only when
    // 마무리/종료 is followed by a close-intent verb suffix OR sentence-end. This
    // structurally rejects noun-modifiers (세션 종료 여부/로직/작업 정리) and
    // negations (세션 종료 안 해도 돼, 세션 마무리하지 않아도) without enumerating.
    // The suffixes are COMPLETE terminal forms followed by a non-Hangul boundary
    // (?![가-힣]), so connective continuations die: 해주는/해주기 (해 alone, then
    // 주 follows), 해야 하는 / 해도 되는지 (해 alone, then 야/도 follows). 하고 is
    // deliberately dropped — "마무리하고 블로그"(close) and "마무리하고 싶은지"(not)
    // are structurally identical, and over-close is the worse failure, so we accept
    // the rare FN over the FP. The residual: connective forms that happen to put a
    // space after a complete terminal can't be separated by regex without a
    // morphological parser — that's bounded by the compound gate (precompact-green
    // + signal) and the unambiguous /compact and AskUserQuestion channels (threat
    // boundary), not chased further.
    /세션\s*(?:마무리|종료)(?:\s*(?:해줘|해주세요|해요|해|하자|하죠|했어|했다|했음|했지|합시다|합니다|할게|할께|할래|할까|할까요|한\s?거(?:지|야|니)?|함)(?![가-힣])|\s*[)\].,!?~。…]|\s*$)/m,
    /오늘\s*은?\s*(여기|작업|세션).*(끝|마치|마무리|종료)/,
    // 여기까지: requires no continuation action word (e.g. 여기까지 구현해줘 is not a close signal)
    /여기(서)?까지(?!\s*(?:구현|작성|완성|수정|변경|추가|삭제|테스트|확인|검토|해줘|해야|하고|하면))/,
    /이만\s*(마치|끝|종료|마무리)/,
    // 작업 종료/마무리: requires verb ending, not noun modifier (e.g. 작업 종료 조건을 is not a close signal)
    /작업\s*(?:마무리|종료)\s*(?:하자|할게|하겠|했어|임)/,
    /오늘은?\s*여기/,
    /그만\s*(하자|할게|하겠|합시다)/,
    /슬슬\s*(마무리|종료)/,
    /오늘은?\s*이만/,
  ];
  const enPatterns = [
    // wrap up: requires session-level context or sentence-end, not code-level
    // objects. The review/analysis/debug/audit/investigation nouns were added
    // for 6a — read-only review sessions are now "substantial", so "wrap up the
    // review" must read as a task-level signal, not a session-close one.
    // Leading \b on each pattern so an EN close phrase embedded as a
    // substring of a longer token can't trip the gate (e.g. "designing off…").
    /\bwrap(?:ping)?\s+up(?!\s+(?:this|the)\s+(?:pr|issue|bug|task|function|component|module|feature|code|test|review|analysis|investigation|debugging|debug|audit|refactor)\b)/i,
    /\bdone\s+for\s+(?:today|now|the\s+day)\b/i,
    /\bthat'?s?\s+(?:all|it)\s+for\s+(?:today|now|the\s+day)\b/i,
    /\bsigning\s+off\b/i,
    /\bend(?:ing)?\s+(?:the|this)\s+(?:session|work|day)\b/i,
    /\bclose\s+(?:the|this)\s+session\b/i,
  ];
  return [...krPatterns, ...enPatterns].some((re) => re.test(text));
}

/**
 * Retraction TRIPWIRE for the close gate — a mitigation that can only CLOSE the
 * gate, never open it. The gate no longer has its old per-turn overwrite (any
 * typed text that was not a close phrase used to expire the approval outright),
 * because an unknown typed phrase must not silently retract an approval the
 * user actually gave — that is what turned the close skill's own "did you mean
 * X or Y" reflection question into a false retraction. Under the new
 * rule, typed text that is neither a close phrase nor a retraction phrase is
 * NEUTRAL: it leaves the gate exactly where it was.
 *
 * This function is the one deliberate exception, and its asymmetry is the
 * safety property: a phrase MISSING from the corpus below just falls through
 * to neutral, which is the ordinary, already-accepted behaviour of an unknown
 * typed message. So the corpus can be grown at any time without weakening an
 * existing guarantee — the worst case of a miss is a gate that stays open,
 * not one that opens when it should not. That asymmetry is also why this is
 * NOT a counterexample to the rule that a defence is written as an effect,
 * not a name list: a name list is dangerous exactly when it backs a GRANT,
 * because the one name missing from it is a silent bypass. Here the missing
 * name is a silent no-op.
 *
 * If this function is ever consumed by an opening decision instead of a
 * closing one, that asymmetry disappears and the rule for an unknown
 * value (route to the cautious branch) applies again — do not repurpose it
 * without re-deriving the corpus under that rule.
 */
export function isCloseRetractionPattern(text) {
  if (!text || typeof text !== 'string') return false;
  const patterns = [/아\s*잠깐,?\s*이(?:것도|거)\s*(?:먼저\s*)?고쳐줘/, /하나만\s*더\s*해줘/];
  return patterns.some((re) => re.test(text));
}

// ── close ARTIFACTS, not the marker (issue: close gate lives on one writer) ──
//
// isCloseGateOpen/isClosePattern answer "did the user ask to close" — the
// input side of the gate. This answers a different question: "does this file
// or commit message already READ as closed to a human", independent of
// whether any marker writer ever ran. The 2026-07-28 incident produced a
// closing session-state.md heading, a rewritten hot.md, and a close-worded
// commit WITHOUT writing a session-closed marker at all — the hard gate on
// the marker writer never fired because the model never called it. Closing
// is a set of user-visible artifacts, not one internal file.
//
// Narrowed scope — this is a PARTIAL defense, not the completed artifact-set
// gate: hot.md's REPLACEMENT is a diff against the prior version, which a
// pure function taking only current content cannot see. This only catches a
// hot.md that carries close vocabulary in its own bold heading — a hot.md
// rewritten with a closing narrative that happens not to use 마감/종료
// literally (as the incident's own hot.md rewrite did) will NOT trip this
// signal. That is a real, known false-negative, not a corner this slice
// closes: catching it needs a diff-aware check (comparing against the prior
// committed hot.md, or a PreToolUse guard that sees the edit as it happens),
// which is future work, not something reusing isClosePattern's heuristics
// would fix either. The session-state heading and commit-message signals
// still catch the one incident on record, so today's gap is documented, not
// silent — but it is a gap, not a boundary this slice was designed to hold.
//
// A close word used as a NOUN-MODIFIER is not an announcement — "마감
// 조건을/여부/로직/절차/정책" all describe something ABOUT closing, not a close
// that happened. Enumerating the modifiers (blacklist, round 1) and then the
// verb suffixes that ARE an announcement (whitelist, round 2) both kept
// finding new words each review round — neither converges, because both are
// open lexical classes. The convergent rule is a WORD-BOUNDARY, not a word
// list: Korean verb conjugation attaches directly with no space (마감했다,
// 마감되었습니다, 마감했습니다, 마감됨 — see the corpus in
// tests/close-signals.test.mjs), while a noun-modifier is a SEPARATE word
// after a space (마감 조건, 마감 정책, 종료 여부, 종료 절차). So: a close word
// followed immediately (no space) by more Hangul is a conjugation and
// announces a close; a close word followed by whitespace THEN Hangul is a
// modifier and does not. `CLOSE_WORD_TAIL` consumes the (possibly empty)
// directly-attached conjugation run, then requires the close word to be
// effectively the LAST content in its heading: only a parenthetical, ":" +
// trailing narrative, terminal punctuation, or the bold-heading's end may
// follow — a bare space-separated Hangul word after it fails to match any of
// those and rejects. Known accepted limit: a same-word-no-space compound like
// "마감일" (deadline-date, a noun) would match — over the FN/FP asymmetry this
// check is built on (a missed real close is the exact failure mode it exists
// to catch; a stray warn is mild noise), that's the accepted direction.
const CLOSE_WORD_TAIL = '[가-힣]*(?:\\s*:[^*\\n]*|(?:\\([^)]*\\))?[.,]?\\s*)';
const SESSION_STATE_CLOSE_HEADING = new RegExp(
  `\\*\\*(\\d{4}-\\d{2}-\\d{2})[^*\\n]*?마감${CLOSE_WORD_TAIL}\\*\\*`,
);
const HOT_CLOSE_NARRATIVE = new RegExp(
  `\\*\\*(\\d{4}-\\d{2}-\\d{2})[^*\\n]*?(?:마감|세션\\s*종료)${CLOSE_WORD_TAIL}\\*\\*`,
);
// EN: requires the CLOSE's object to actually be "session" ("close the
// session" / "close the Nth session" — an ORDINAL or digit-ordinal, the only
// forms a real close commit uses), not any noun ("close the database
// session", "close the browser session" are technical commits, not a
// session-close). KR: same word-boundary rule as the heading patterns above,
// applied as a lookahead only (a commit subject isn't bold-wrapped, so there
// is no terminal structure to consume into) — reject only when a bare SPACE
// separates the close word from a following Hangul word; a directly-attached
// conjugation (세션을 종료했다) still matches. "을/를" is the object particle
// Korean puts between "세션" and its verb.
const ORDINAL =
  '(?:\\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|' +
  'eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth)';
const CLOSE_COMMIT_MESSAGE = new RegExp(
  `\\b(?:session:\\s*)?close(?:s|d)?\\s+(?:the|this)\\s+(?:${ORDINAL}\\s+)?session\\b|` +
    `세션(?:을|를)?\\s*(?:마무리|마감|종료)(?!\\s+[가-힣])`,
  'i',
);

/**
 * Pure predicate: is this file content, or this commit message, a
 * session-close ARTIFACT (something a human would read as "this session was
 * closed")? Never reads the filesystem — callers own IO. `path`'s basename
 * selects which pattern applies (`session-state.md` vs `hot.md`); pass
 * `commitMessage` instead for a git log entry.
 *
 * Consumed today by doctor's post-hoc check: an artifact with no matching
 * session-closed marker for its date is a signature of a hand-made close
 * that never went through the gate. Meant to also back a future PreToolUse
 * guard on the same definition, so the two defenses can't drift apart on
 * what "close" means.
 *
 * @param {{path?: string|null, content?: string|null, commitMessage?: string|null}} input
 * @returns {{matched: boolean, kind: string|null, date: string|null}} `date`
 *   is the YYYY-MM-DD captured from the artifact's own heading, or null for a
 *   commit-message match (the caller already has the commit's date).
 */
export function detectSessionCloseArtifact({
  path = null,
  content = null,
  commitMessage = null,
} = {}) {
  if (typeof commitMessage === 'string' && CLOSE_COMMIT_MESSAGE.test(commitMessage)) {
    return { matched: true, kind: 'commit-message', date: null };
  }
  if (typeof path === 'string' && typeof content === 'string') {
    const base = path.split(/[\\/]/).pop();
    if (base === 'session-state.md') {
      const m = SESSION_STATE_CLOSE_HEADING.exec(content);
      if (m) return { matched: true, kind: 'session-state-heading', date: m[1] };
    }
    if (base === 'hot.md') {
      const m = HOT_CLOSE_NARRATIVE.exec(content);
      if (m) return { matched: true, kind: 'hot-narrative', date: m[1] };
    }
  }
  return { matched: false, kind: null, date: null };
}

/**
 * Resolve a session's transcript path from its (globally-unique) session id by
 * globbing every Claude project dir: ~/.claude/projects/<slug>/<id>.jsonl.
 *
 * Why glob, not cwd-derive: the transcript lives under a slug built from the cwd
 * AT SESSION START, but the marker-writer subprocess can run from a DIFFERENT cwd
 * (the real over-close ran `cd ~/hypomnema && crystallize …`), so a cwd-derived
 * slug would miss the file. The session id is a UUID, so the glob disambiguates
 * without needing the slug — verified globally unique across all project dirs.
 *
 * Fail-closed on ambiguity (codex review): returns the single resolved
 * path, or null when ZERO or MORE-THAN-ONE distinct files match (realpath-deduped
 * so a symlink to the same file is not "multiple"). The caller treats null as
 * "refuse the marker".
 *
 * `projectsRoot` defaults to the real ~/.claude/projects; tests pass a controlled
 * root so they exercise the real resolver instead of a forgeable path override.
 */
export function resolveTranscriptBySessionId(
  sessionId,
  projectsRoot = join(HOME, '.claude', 'projects'),
) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  // Session ids are UUID-shaped; reject anything with path separators / glob
  // chars so a crafted id can't escape the projects root or match siblings.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  try {
    const base = projectsRoot;
    const seen = new Set();
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = join(base, ent.name, `${sessionId}.jsonl`);
      if (!existsSync(p)) continue;
      try {
        seen.add(realpathSync(p));
      } catch {
        seen.add(p);
      }
    }
    return seen.size === 1 ? [...seen][0] : null;
  } catch {
    return null;
  }
}

/**
 * Internal walk: does this transcript's typed/queued/answered event history
 * currently leave the close gate OPEN? This is the TRANSCRIPT axis only — a
 * resolution recorded separately in the vault (`close-gate-store.mjs`)
 * can only narrow this result further, never widen it, and is computed
 * elsewhere entirely.
 *
 * Classification (structural fields only — never content heuristics for producer):
 *   • OPEN    a genuine user close: an NL close phrase in user text that
 *             survives {@link eventUserText}'s exclusions; a `/compact`
 *             queue-op; a remove-path queued_command attachment carrying a
 *             close with an audited human producer (origin.kind "human"); a
 *             correlated, non-error AskUserQuestion answer naming a close.
 *   • CLOSE   a fresh user intent that closes the gate: `/clear`, `popAll`, a
 *             non-close queued_command, a decline answering an AskUserQuestion
 *             whose own prompt carried {@link CLOSE_RECONFIRM_MARK} (ours, so
 *             the decline rejects OUR close question and nobody else's), or
 *             typed text matching {@link isCloseRetractionPattern} (the
 *             retraction tripwire). Two things that used to close no longer do:
 *             plain typed text that is merely not a close phrase, and an
 *             ordinary non-close answer to an unmarked question. Both are
 *             NEUTRAL below.
 *   • NEUTRAL everything the model can produce or the harness injects: system/
 *             sdk replay, isMeta bodies, sidechain, interruptedMessageId
 *             companions, a command-invocation record, assistant,
 *             tool_result, task-notification — and, under the current rule, any typed
 *             text that is neither a close phrase nor a retraction phrase. An
 *             unrecognized message must not silently close a gate the user
 *             already opened; that per-turn overwrite (`granted =
 *             isClosePattern(userText)` on every typed record) is exactly what
 *             produced the close skill's own reflection question reading as a
 *             retraction, and is what this walk replaces.
 *   • FATAL   an unparseable line — the transcript is being appended to or is
 *             corrupt, so refuse rather than read a half-written record.
 *
 * The last OPEN/CLOSE event wins, so a stale close (Defect B), a queued "keep
 * working" after a close, and a non-close AskUserQuestion selection all
 * correctly read as not open. Abandoned-branch staleness is a known limit (no
 * leaf pointer exists to resolve it — see the branch note in the body),
 * mitigated the same way: any later live user intent, on any branch, still
 * closes it.
 *
 * The typed `apply-proposals <nonce>` approval line no longer needs its own
 * carve-out. It used to: the old per-turn rule closed on ANY typed text that
 * was not itself a close phrase, and the approval line the close procedure
 * instructs the user to type can never BE a close phrase — so following that
 * instruction closed the gate the instruction was for (measured 2026-08-06:
 * three round trips to close because of it). With the per-turn overwrite gone,
 * the approval line is ordinary typed text — neither a close phrase nor a
 * retraction phrase — so it falls to NEUTRAL by the same rule every other
 * unrecognized message gets, with no special case required.
 *
 * Threat model: an honest-but-drifting model that does not forge the
 * transcript. This is a safety interlock, not an authorization boundary — a
 * model that forges records is out of scope and documented so.
 *
 * Fail-closed: any read/parse error → not open.
 *
 * @returns {{open: boolean, openedAtIndex: number, retractedByUnknownTagName: string|null, neutralizedHostTagName: string|null}}
 *   `openedAtIndex` is the position, in the FATAL-filtered record array this
 *   walk builds internally (blank lines dropped, non-object JSON values
 *   dropped, first parse failure returns early), of the most recent event
 *   that opened the gate, or -1 if none ever did. `close-gate-store.mjs`'s
 *   `resolutionStamp` counts records by the same definition, so the two
 *   indices are comparable. `retractedByUnknownTagName` names the tag (e.g.
 *   `"any-new-host-tag"`) when the CURRENT `open: false` came from a
 *   tag-shaped queue enqueue that is not one of `HOST_TAG_NAMES`, so a caller
 *   can tell a maintainer which name to add; null whenever the current state
 *   has another explanation or the gate is open. `neutralizedHostTagName`
 *   names a `HOST_TAG_NAMES` tag (e.g. `"agent-message"`) that most recently
 *   read as neutral, rather than a retraction, since the LAST event that
 *   opened the gate, so a caller can warn that the close now in effect
 *   survived a shape a person could also have pasted verbatim. Reset to null
 *   by every event that (re)opens the gate, so it never survives past the
 *   open it describes; null when nothing neutral has happened since that
 *   open. Do NOT read it when `open` is false: the events that CLOSE the
 *   gate (popAll, `/clear`, an unregistered tag, an attachment retraction, a
 *   declined reconfirm) leave this field untouched, so on a closed gate it
 *   can still name a tag from the open that was already retracted. Every
 *   consumer today reads it only on an open gate.
 */
// Genuine user text of a record, or null when the record is on a channel the
// honest-but-drifting model can reach (so it is never user intent — NEUTRAL).
// role:user is the boundary the model cannot cross: it authors role:assistant,
// so a user record that survives every exclusion below is genuine user text.
// The exclusions are exactly the model-reachable channels:
//   • isMeta            slash-command / skill bodies and local-command caveats
//   • promptSource system|sdk   queue replay of injected text, SDK prompts
//   • isSidechain       subagent context (a subagent must not close the session)
//   • interruptedMessageId  the harness cut the model off; user-SHAPED, not a
//                       user decision (e.g. the [Request interrupted by user]
//                       companion of a delivered /compact)
//   • Stop-hook feedback  the hook's own close nudge — circular
//   • tool_result blocks  tool output, not typed text
//   • a command-invocation tag (<command-name>/<command-message>/<command-args>)
//     anywhere in the text. Claude Code routes a model-issued Skill
//     call through the same processPromptSlashCommand path a human's typed
//     `/hypo:crystallize` goes through, and both land as this identical
//     non-meta role:user record — so a tag proves nothing about who produced
//     it. Excluding the whole text, not just the tag substring, means a close
//     phrase riding along in <command-args> (e.g. `/hypo:crystallize 세션
//     마무리해줘`) cannot open the gate either; the user still opens it by
//     saying the same words in plain text.
// No promptSource allowlist is required: requiring `typed` would drop the
// legacy absent-promptSource close the older gate has always honoured, while the
// dangerous replay/injection paths carry system|sdk|isMeta|isSidechain and are
// excluded here anyway.
const COMMAND_INVOCATION_TAG = /<command-(?:name|message|args)>/;

// Text out of a content-block array, or null when the array carries a command
// invocation (which is a host artifact, not something the user typed as prose).
// Extracted so the queued_command attachment branch in walkCloseGate can reuse
// the exact same rule: a queued prompt arrives as this array shape whenever the
// user pasted an image alongside their words (measured: 8 such deliveries, all
// origin.kind "human", host versions 2.1.226 through 2.1.263). Reading only
// `typeof prompt === 'string'` there dropped those to '' and read a real change
// of mind as nothing at all.
function contentBlocksText(content) {
  const texts = content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text);
  const text = texts.length ? texts.join('\n') : null;
  // A command-invocation tag split across adjacent text blocks (e.g.
  // '<command-na' + 'me>/hypo:crystallize</command-name>') would survive the
  // '\n'-joined `text` above with a newline spliced into the middle of the
  // tag name, so the plain check below can miss it entirely. Today's actual
  // host format sends the whole invocation as ONE string, so this exact
  // split is not reproducible against a live session yet — but a check for
  // "did the host format ever put the tag exactly on a block boundary"
  // should not depend on where a future host happens to cut the blocks. So
  // also test each run of CONSECUTIVE text blocks joined with no separator.
  // This must stay scoped to consecutive text blocks only, never the whole
  // array: joining across a non-text block in between (an image, say) would
  // synthesize a tag that never existed in the real content, and that is a
  // different bug, not a fix — it would throw away a genuine close spoken
  // next to an unrelated attachment. So a non-text block ends the current
  // run and starts a new one; it never bridges two runs into one string.
  let tightRun = '';
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') {
      tightRun += b.text;
      continue;
    }
    if (COMMAND_INVOCATION_TAG.test(tightRun)) return null;
    tightRun = '';
  }
  if (COMMAND_INVOCATION_TAG.test(tightRun)) return null;
  return text;
}

function eventUserText(obj) {
  if (obj.isMeta === true) return null;
  if (obj.promptSource === 'system' || obj.promptSource === 'sdk') return null;
  if (obj.isSidechain === true) return null;
  if (obj.interruptedMessageId) return null;
  const msg = obj.message ?? obj;
  const role = msg.role ?? obj.role ?? obj.type;
  if (role !== 'user') return null;
  const content = msg.content ?? obj.content;
  let text = null;
  if (typeof content === 'string') {
    text = content.startsWith('Stop hook feedback') ? null : content;
  } else if (Array.isArray(content)) {
    // null from either cause (no text blocks, or a command invocation) means
    // "no user prose here", which is exactly what this function returns anyway.
    text = contentBlocksText(content);
  }
  if (text != null && COMMAND_INVOCATION_TAG.test(text)) return null;
  return text;
}

// A record on a channel the honest-but-drifting model can reach, so it can never
// be a user decision. Used to keep injected / replayed / subagent records out of
// BOTH the user-text and the AskUserQuestion-answer classifiers.
function isModelReachableRecord(obj) {
  return (
    obj.isMeta === true ||
    obj.promptSource === 'system' ||
    obj.promptSource === 'sdk' ||
    obj.isSidechain === true
  );
}

// Queue content that carries no fresh USER decision: empty, or a background-task
// notification the host injects on the model's behalf. Shared by the enqueue
// branch and the remove-path (queued_command attachment) branch below so a
// task notification reads as neutral on BOTH delivery shapes of the same host
// event. Before this was extracted, only the enqueue branch filtered it: the
// attachment branch treated any non-close prompt, including a task
// notification, as a change-of-mind close, so a close typed by the user
// opened the gate and the notification for an unrelated background task then
// flipped it shut again.
//
// The prefix check used to be a literal `<task-notification>` string, which
// missed two other host-minted tags this file had never been taught by name:
// a subagent hand-back (`<agent-message from="...">`) and a cross-session
// message (`<cross-session-message from="...">`). Measured 2026-09-17
// against ~4.6K enqueue records across 431 transcripts (the corpus is live
// and grows every session, so these counts are a snapshot, not a
// reproducible figure; the ratios are what hold): task-notification (no
// attributes) ~3890, agent-message (attributed) ~166, cross-session-message
// (attributed) ~27, plain user prose ~518, slash commands ~53. Of the
// records that start with `<` (~4.1K), exactly these three distinct tag
// names occur, all host-minted.
//
// A first attempt widened the match to ANY leading tag name (`<name ...>` or
// `<name>`, attributes optional), on the reasoning that a fourth host tag
// would then read as neutral without a code change. That widening was
// reverted: a queue-operation enqueue has no `origin` or `commandMode` field
// to fall back on, so a leading-tag check is the ONLY signal this branch has,
// and it cannot tell a host tag from a person's own bracketed text. Two
// shapes a person can plausibly type or paste both matched the wide version:
// a label like `<TODO> 계속 작업해줘`, and an unterminated prefix such as
// `<please keep working` (the regex needed only a following space, not a
// closing `>`). Both would have read as model-caused and neutral, silently
// dropping a real change of mind instead of closing the gate. So the match
// stays a closed allowlist of the three names this corpus has actually
// produced (HOST_TAG_NAMES below), not a name-shaped pattern. A fourth host
// tag this file has not been taught by name still falls through to the
// enqueue branch's `else open = false` and retracts a close; that is the same
// residual the enqueue branch's own comment already carries for any
// unrecognized shape, not a new one this allowlist introduces.
//
// The slash-command ~53 does NOT mean "handled above, never reaches here".
// Only `/clear` (~3) is caught by the branch above this one. The other ~50
// (`/hypo:resume` ~40, `/reload-plugins` ~8, `/resume` ~1, `/operations…`
// ~1) DO reach this filter, read as not-machine (no leading `<`), and fall
// through to the enqueue branch's `else open = false`, same as any other
// unrecognized non-close text. That classification is not obviously wrong
// for `/hypo:resume` (typed by a human resuming work), but a queued
// `/reload-plugins` right after a close retracts that close the same way,
// and this file has never separately reasoned about whether that one
// should. Confirmed against `walkCloseGate` directly: `close, then enqueue
// "/reload-plugins"` reads false (closed), same as `/hypo:resume` and
// `/clear`; only `/compact` reads true.
//
// None of the ~518 plain-prose records carry any of six known
// machine-marker substrings (`[Subagent`, `hand-back`, `SYSTEM
// NOTIFICATION`, `task-notification`, `Caveat:`, `automated`) in their first
// 200 characters; some are as short as "reply with ok". So on the ENQUEUE
// channel, in this corpus, one of these three leading tags separates
// machine-caused content from user prose with zero false positives and zero
// false negatives at this sample, but that separation is scoped to the
// three names it checks, by design: it says nothing about a tag this corpus
// has not produced.
//
// This predicate must not be reused on the typed (eventUserText) channel
// either. 61 records that channel accepts as genuine user prose start with a
// host tag too (`<bash-input>` ~24, `<bash-stdout>` ~24,
// `<local-command-stdout>` ~13); `<bash-input>` is the user's own `!`
// command. Those shapes do not occur on the queue channel today, so the two
// channels read the same prefix in opposite directions and must stay on
// separate predicates.
//
// Attachment-side note: this same function backstops the queued_command
// branch below, but that branch now only reaches it when it has no producer
// signal at all. `origin.kind` "human" overrides this body check there
// entirely (see that branch's comment) rather than being weighed against it,
// because a human-authored prompt can start with one of these three strings
// too, by coincidence or by paste, and a producer field the host stamps is
// stronger evidence than a string the host also mints. Measured: of 1796
// queued_command attachments, 0 carry both a host-tag-shaped prefix and
// origin.kind "human", so this ordering changes 0 outcomes at this sample;
// it is a defense against a shape the corpus has not produced yet.
//
// ENQUEUE-BRANCH REVERSION (2026-09-18): a prior pass (codex cross-review
// round 5, blocker) changed this branch to close on every non-empty,
// non-close body, tag-shaped or not. Its reasoning still holds as a fact:
// `queue-operation enqueue` carries no `origin` or `commandMode` field, so a
// HOST_TAG_NAMES match here was never PROOF of a host producer, only a
// corpus fact that no other producer had used the shape yet. What moved is
// the judgment about which mistake costs more, once the corpus this file
// actually runs against was measured. Of 433 sessions carrying a close
// signal, 95 (21.9%, snapshot of a live and growing corpus, so the count
// drifts but the ratio held at measurement time) hit that retraction, and 66
// of those repeated the reconfirm five times or more, a friction this
// file's own users hit daily. The event that retraction was defending
// against, a person typing or pasting a HOST_TAG_NAMES shape verbatim, has
// not been observed in this corpus at all; the trade was a confirmed daily
// cost against an unmeasured one. A codex design consultation split the two
// failure directions by recoverability instead of by which reading is more
// often right: a commit opened by mistake is auditable and revertable in
// git, while a permission closed by mistake just keeps asking the same user
// to reconfirm a decision they already made. So the enqueue branch below
// calls this function again and reads a HOST_TAG_NAMES match as neutral, the
// same shape it read before the amendment. The residual that reopens, a
// pasted tag keeping a spent close alive, is not guessed against on every
// gate read; it is named once, via `neutralizedHostTagName` below, and
// surfaced once at commit time by crystallize-close-apply.mjs rather than on
// every read that would otherwise repeat the same nag the measurement above
// found costly. This function's host-tag branch was already authoritative
// for the queued_command attachment branch below (it never adopted the
// amendment), which has `origin.kind` and `commandMode` to weigh a tag match
// against, signals the enqueue shape does not carry.
//
// Exported so close-gate-store.mjs's `closeGateStatus` can tell a KNOWN host
// tag apart from an unrecognized one when it names the culprit in its
// `no-open` reason string: the advice differs (a known tag closing the gate
// is the enqueue-branch fix above working as intended; an unrecognized one is
// the "which tag to add" diagnostic that already existed).
export const HOST_TAG_NAMES = ['task-notification', 'agent-message', 'cross-session-message'];
// Capturing, not `(?:`, so hostTagNameOf below reads the matched name off the
// same regex that decides neutrality. Two places in walkCloseGate need that
// name, and giving either one its own pattern is how HOST_TAG_NAMES grows in
// one of them and not the other.
const HOST_TAG_PREFIX = new RegExp(`^<(${HOST_TAG_NAMES.join('|')})(?=[\\s>])`);
function isModelCausedQueueContent(text) {
  const c = typeof text === 'string' ? text.trim() : '';
  return !c || HOST_TAG_PREFIX.test(c);
}

// The allowlisted tag name a queued body starts with, or null when it starts
// with anything else. Diagnostic only, exactly like TAG_SHAPE_PREFIX below:
// it never decides the gate, it only lets walkCloseGate say WHICH tag read as
// neutral. Both neutral enqueue branches call this rather than re-deriving
// the name, so adding a fourth name to HOST_TAG_NAMES moves both at once.
function hostTagNameOf(text) {
  const m = HOST_TAG_PREFIX.exec(typeof text === 'string' ? text.trim() : '');
  return m ? m[1] : null;
}

// Diagnostic only, never a gate decision on its own. HOST_TAG_PREFIX above is
// the closed allowlist that actually decides neutrality; this is deliberately
// wider, so it also matches a name the allowlist has not been taught
// (`<any-new-host-tag ...>`) and a human's own bracketed paste (`<TODO>`,
// `<please keep working`). It exists so the enqueue branch below can NAME a
// retraction's shape in closeGateStatus's `no-open` reason string, closing a
// gap a codex cross-review named: nothing today tells a maintainer the
// allowlist has gone stale, so a fourth host tag silently retracts real
// closes until someone reads this corpus by hand and notices.
const TAG_SHAPE_PREFIX = /^<([A-Za-z][\w-]*)(?:[\s>]|$)/;

/**
 * The tag name of a tag-shaped body whose name is NOT in HOST_TAG_NAMES, or
 * null (no tag shape at all, or a registered one). This is the fail-closed
 * judgment the enqueue branch runs FIRST, ahead of the close-phrase check:
 * see that branch for why an unregistered tag must retract even when its body
 * reads like a close.
 *
 * Deliberately not the negation of hostTagNameOf: that one requires `[\s>]`
 * after the name, so a bare `<task-notification` (no bracket, nothing after)
 * misses it. Matching TAG_SHAPE_PREFIX and then checking the NAME against the
 * allowlist keeps such a body out of this retraction, leaving it to the same
 * final `else` that already closed on it before this function existed.
 */
function unregisteredTagNameOf(text) {
  const m = TAG_SHAPE_PREFIX.exec(typeof text === 'string' ? text.trim() : '');
  if (!m) return null;
  return HOST_TAG_NAMES.includes(m[1]) ? null : m[1];
}

// The fail-closed shape of this walk's return, built fresh on every call.
// A shared module-level constant would hand every caller the same object, so
// one caller stashing or mutating what it got back would reach into the next
// call's answer. The three early returns below all use this so a caller
// destructuring the two diagnostic fields gets `null`, not `undefined`, on
// the paths that never walk a record (see this function's @returns).
function closedGateResult() {
  return {
    open: false,
    openedAtIndex: -1,
    retractedByUnknownTagName: null,
    neutralizedHostTagName: null,
  };
}

export function walkCloseGate(transcriptPath) {
  if (!transcriptPath) return closedGateResult();
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return closedGateResult();
  }
  // FATAL: a non-empty line that will not parse means the transcript is being
  // appended to (a half-written record) or is corrupt. Skipping it would let a
  // stale prior open survive past an event we cannot read, so refuse. A line
  // that parses to a non-object (a bare null / string / number) is valid JSON but
  // not a record — noise, not corruption — so it is skipped, not fatal, and never
  // reaches the field reads below.
  const recs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return closedGateResult();
    }
    if (o === null || typeof o !== 'object') continue;
    recs.push(o);
  }

  // Walk the transcript in line order and track whether the LATEST event opened
  // or closed the gate — last event wins, so a stale open and a queued
  // change-of-mind both correctly read as closed.
  //
  // Branch note: line order mixes an abandoned branch's records with the live
  // ones. A leaf-pointer ancestry filter was tried and withdrawn — the transcript
  // carries no authoritative leaf pointer (measured: 0 leafUuid / summary
  // records), so a heuristic leaf can skip the real closing event and PRESERVE a
  // stale open (a fail-open, not a conservative filter). Until such a pointer
  // exists, an open on a branch abandoned under a neutral tail is a known
  // staleness limit, mitigated the same way: any later live user intent, on any
  // branch, still closes it.
  const askIds = new Set();
  // Subset of askIds whose tool_use input carries CLOSE_RECONFIRM_MARK, i.e.
  // it IS our close-reconfirm prompt, not some unrelated question the model
  // happens to ask around the same time. Same correlation guard
  // isCloseReconfirmDeclined uses (see its doc comment below), reimplemented
  // here rather than calling that function: its re-arm rule only recognizes a
  // typed close phrase, which misses the three new openers this walk already
  // tracks (a queued /compact, a human-origin queued delivery, an
  // AskUserQuestion close answer). Driving decline off this walk instead means
  // any of those already reopens the gate for free, with no separate re-arm
  // rule to keep in sync.
  const markedAskIds = new Set();
  let open = false;
  let openedAtIndex = -1;
  // Names the tag-shaped queue item that most recently retracted a close (one
  // NOT in HOST_TAG_NAMES, the only shape that still retracts), so
  // closeGateStatus's `no-open` reason can surface it instead of leaving it as
  // a fact only a transcript dump reveals. Cleared at every OTHER state change
  // so it never survives past the retraction it explains; see the enqueue
  // branch's final `else` for where it is set.
  let retractedByUnknownTagName = null;
  // Names a HOST_TAG_NAMES tag that most recently read as neutral, rather
  // than a retraction, since the last event that opened the gate: the
  // residual the enqueue-branch reversion above accepts. Reset to null by
  // every `open = true` assignment below so it only ever describes the close
  // currently in effect, never one already resolved by a later close phrase.
  // Read once, at commit time, by crystallize-close-apply.mjs's warn-once
  // path; see closeGateStatus for where it turns into a message.
  let neutralizedHostTagName = null;

  for (let i = 0; i < recs.length; i++) {
    const o = recs[i];
    // Genuine user text of this record, or null when the record is on a channel
    // the model can reach (including a command-invocation record).
    const userText = eventUserText(o);

    // Queue operations. The queue carries no correlation key (measured), so the
    // ENQUEUE content is the decision — not a later contentless dequeue, which
    // would need pairing we cannot do. Reading the enqueue also keeps the live
    // PreCompact gate working (it sees the enqueue) and avoids double-counting the
    // replay companion of an already-decided item (the /compact replay is not a
    // fresh decision). popAll cancels the queue → close. Delivery ops
    // (dequeue, remove) carry no fresh decision here — a content-bearing remove of
    // an NL queued command is handled by its queued_command attachment below.
    if (o.type === 'queue-operation') {
      if (o.operation === 'popAll') {
        // Unconditional close, and that is deliberate. A 2026-09-17 attempt to
        // read this branch's content the way the enqueue branch below does was
        // reverted: the measurement behind it was truncated and wrong.
        //
        // What the corpus actually holds (~66 popAll records, live corpus so a
        // snapshot): 0 have missing or empty content, 63 carry content identical
        // to the preceding enqueue, 2 follow an enqueue with different content,
        // 1 follows a `remove`. None start with a host tag, so a content check
        // would change the outcome of exactly 0 of them while newly letting a
        // user's own `<TODO> ...` paste through as neutral.
        //
        // The one record that looked machine-authored is worse than useless as
        // evidence. Read untruncated it is 465 chars: this hook's own relayed
        // notice with the USER'S question appended by the host after a blank
        // line ("...back in sync.\n\n업데이트했는데 이렇게 에러 뜨는 이유는?").
        // All 4 records carrying that relay prefix are such composites. Treating
        // the prefix as proof of machine authorship reads a real retraction as
        // neutral, which keeps a spent close alive and lets crystallize apply
        // writes the user already took back. Condition-hit accuracy was 0 of 5.
        //
        // This channel cannot do better: a queue-operation record's keys are
        // content/operation/sessionId/timestamp/type, with no origin and no
        // promptSource, so there is nothing here that attests a producer. Until
        // the host stamps one, popAll closes and the user re-confirms.
        open = false;
        retractedByUnknownTagName = null; // a fully-understood close, no diagnostic needed
        continue;
      }
      if (o.operation !== 'enqueue') continue;
      const c = typeof o.content === 'string' ? o.content.trim() : '';
      // Judged ahead of the branch chain so the fail-closed branch below can
      // read it without running the regex twice.
      const unregisteredTag = unregisteredTagNameOf(c);
      if (/^\/compact(?:\s|$)/.test(c)) {
        open = true; // a user compaction preserves the work → open
        openedAtIndex = i;
        retractedByUnknownTagName = null;
        neutralizedHostTagName = null;
      } else if (/^\/clear(?:\s|$)/.test(c)) {
        open = false; // abandons context → close
        retractedByUnknownTagName = null;
      } else if (!c) {
        /* empty: neutral. Empty content names no producer in either
           direction: there is no text to be a host tag, a close phrase, or a
           person's own words, so this is one of the two cases the enqueue
           branch grants for free; see the HOST_TAG_NAMES branch below for the
           other. */
      } else if (unregisteredTag) {
        /* MAJOR fix (fail-closed): a tag-shaped body whose name is NOT in
           HOST_TAG_NAMES retracts the close, and that judgment now runs
           BEFORE the close-phrase branch below. It used to run after, in the
           final `else`, which meant an unregistered tag whose body happened
           to carry close wording (`<future-host>오늘은 여기까지 하자</future-host>`)
           fell into the isClosePattern branch instead and did neither: it
           left the previous close standing AND named nothing, so
           closeGateStatus returned no warning on any of its three surfaces
           and the apply that followed looked ordinary.

           Fail-closed means the unknown shape is treated as the user's own
           retraction until someone proves otherwise by registering the tag.
           What that opens: a genuine host notification from a tag this build
           has never heard of now costs the user one re-confirmation of their
           close. The reason string names the tag so the fix (add it to
           HOST_TAG_NAMES) is one edit away; see closeGateStatus's `no-open`
           wording. */
        retractedByUnknownTagName = unregisteredTag;
        open = false;
      } else if (isClosePattern(c)) {
        /* NL close via the queue: the open dequeue gap. The producer cannot be
           attributed (a peer/model enqueue wears the same shape), so no open.

           Ordered AHEAD of the host-tag branch below on purpose. A body that
           is both host-tag shaped and close worded must not open the gate off
           a shape a person can paste, and this is the branch that refuses to
           open; putting the host-tag branch first would change nothing about
           that outcome but would spread the no-open reasoning over two
           places. What the order did cost is a warning that never fired:
           isClosePattern is an unanchored substring match, so a genuine host
           notification whose body happens to carry close wording
           (`<agent-message from="worker">오늘은 여기까지 진행했습니다</agent-message>`)
           lands here rather than below, and left neutralizedHostTagName unset.
           So name the tag here too. The gate decision is untouched (both
           branches are no-ops on `open`); only the naming widens.

           What that accepts: a real host notification with close-worded prose
           now also raises the commit-time warning, which is a false alarm.
           That is one line per apply, not the per-read nag the enqueue-branch
           reversion note above was measured against, so the two costs are not
           the same size, and the alternative (an anchored close match here)
           would trade a false alarm for a missed one. */
        const hostTag = hostTagNameOf(c);
        if (hostTag) neutralizedHostTagName = hostTag;
      } else if (isModelCausedQueueContent(c)) {
        /* a body shaped like one of HOST_TAG_NAMES: neutral, the same filter
           the queued_command attachment branch below applies to the same
           host event on its other delivery shape. This branch has no
           `origin` field, so a host tag's own shape is not PROOF of a host
           producer, it only reflects what this corpus has actually produced
           on this channel (see the doc comment above
           isModelCausedQueueContent, and the enqueue-branch reversion note
           right above it for why this reads neutral again rather than
           closing). Name the tag so a caller can warn once, at commit time,
           that this close survived a shape a person could also have pasted;
           see neutralizedHostTagName's own doc comment above. */
        // isModelCausedQueueContent above matched HOST_TAG_PREFIX on a body
        // the empty-content branch has already excluded, so this is never
        // null here; the guard only avoids clobbering a live value on a
        // mismatch that should not occur.
        const hostTag = hostTagNameOf(c);
        if (hostTag) neutralizedHostTagName = hostTag;
      } else {
        // Every other non-empty, non-close, non-host-tag-shaped queued item
        // → close (change of mind). Name the tag here, if there is one, so
        // closeGateStatus's `no-open` reason can tell a maintainer which
        // shape closed it: see this field's own doc comment above.
        const tagShape = TAG_SHAPE_PREFIX.exec(c);
        retractedByUnknownTagName = tagShape ? tagShape[1] : null;
        open = false;
      }
      continue;
    }

    // remove-path delivery of a queued natural-language command (measured: the
    // item leaves the queue as it is handed to the model, landing as an
    // `attachment` of type queued_command with the prompt verbatim). This opens
    // the gate ONLY with an audited human producer — origin.kind "human", present
    // on every 2.1.181+ user delivery (measured). A legacy origin-absent delivery
    // cannot attest a producer, so it does not open (fail-closed). Closing asks
    // for the same proof: a NON-close queued command (e.g. "keep working") is a
    // fresh user intent and retracts a prior open, but only with that same
    // audited human producer. This branch used to close by default instead,
    // on the theory that anything the model-caused list did not recognise had
    // to be the user. That default is what let an unrelated background-task
    // notification flip a just-opened gate shut, and every new machine-minted
    // event would have needed its own line in that list to stay safe. Requiring
    // a positive producer means an event this filter has never seen is neutral
    // rather than hostile. `modelCaused` below still runs first, so a
    // recognised notification never reaches either decision.
    //
    // The enqueue branch above does NOT share this rule: those records carry no
    // `origin` at all, so requiring one would stop them closing anything. It
    // keeps the old enumerate-the-machine default, and the re-close hole (a
    // queued "continue" after a close leaving the stale open live) is closed
    // there rather than here. The two delivery shapes of one user action are
    // therefore judged differently on purpose; see the residual noted on the
    // queue-operation branch.
    //
    // Scope of "both shapes classify alike": it holds for task notifications and
    // for empty content, which is what this fix is about. It does not hold for
    // slash commands. The enqueue branch reads a queued `/compact` as an opener
    // and `/clear` as a close, and nothing here mirrors that, so the same
    // command would close the gate if it ever arrived on this path. Measured
    // 0 of 1321 attachment deliveries carry a slash prompt, so the divergence
    // is unreachable today rather than fixed; mirroring it would mean copying
    // an opener that tests already mark a fail-open defect.
    if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command') {
      // Same channel guard the typed path applies, for the same reason. This
      // branch can OPEN the gate, and `origin.kind` alone does not say which
      // channel the record came in on: a sidechain, injected, sdk or meta
      // record could carry a human origin and close text and mint an approval
      // the user never gave in this conversation. eventUserText has refused
      // those channels all along; the opener next to it did not, so one
      // classifier trusted a record the other threw away. Measured 0 of 1340
      // queued_command attachments carry any of these flags, so this closes a
      // shape the corpus has not produced rather than an observed failure.
      // `interruptedMessageId` rides along because eventUserText refuses it too.
      if (isModelReachableRecord(o) || o.interruptedMessageId) continue;
      // A queued prompt arrives as a content-block array whenever the user
      // pasted an image alongside their words. Reading only the string shape
      // dropped those to '' and threw away a real change of mind: the gate
      // stayed open and the close went through anyway. Measured 8 such
      // deliveries, every one origin.kind "human", host 2.1.226 to 2.1.263.
      const rawPrompt = o.attachment.prompt;
      const prompt =
        typeof rawPrompt === 'string'
          ? rawPrompt
          : Array.isArray(rawPrompt)
            ? (contentBlocksText(rawPrompt) ?? '')
            : '';
      const humanOrigin = !!(o.attachment.origin && o.attachment.origin.kind === 'human');
      // The host labels these deliveries on the record itself, and that label
      // is the authoritative one: every measured task-notification attachment
      // (1040 of 1040) carries commandMode 'task-notification'. Keying only on
      // the '<task-notification>' body prefix would leave the whole filter
      // resting on a string the host owns and can restyle, and a body that
      // merely gains a line before the tag would slip past it. It is checked
      // first, ahead of `humanOrigin` too: it is the strongest signal this
      // record has, host-stamped rather than read out of prose either side
      // could shape.
      const modelCaused = o.attachment.commandMode === 'task-notification';
      // A codex cross-review on this exact branch found that a prior pass
      // (meant to close a DIFFERENT major finding, an over-wide tag regex)
      // left `humanOrigin` never winning here at all: `isModelCausedQueueContent`
      // ran first for every case, so an audited human prompt that merely
      // STARTS WITH one of the three known tag names (`<agent-message ...>`,
      // `<cross-session-message ...>`) still read as neutral and a real
      // change of mind was silently dropped. The old "0 of 1796 carry both"
      // count was an observed-corpus fact, not a schema guarantee: a user
      // can paste one of these three strings verbatim without any host
      // change, so "it hasn't happened yet" was never a structural argument.
      //
      // This branch closes that gap for the half of it that carries no new
      // risk: a human origin paired with text that is NOT a close phrase
      // always retracts, whatever the body looks like, because retracting is
      // the safe direction (worst case: the user re-confirms a close they
      // still want).
      //
      // It deliberately does NOT extend the same reordering to a close-phrase
      // body: `isModelCausedQueueContent(prompt)` still runs, further down,
      // before `isClosePattern` gets to open anything, exactly as the enqueue
      // branch above does. A body that both matches a known tag shape AND a
      // close phrase (a task-notification's own `<summary>` can legitimately
      // say "wrap up") stays neutral there even with a stray human origin.
      // That ordering is what `close-signals.test.mjs`'s "task-notification
      // whose body matches a close pattern opens nothing" fixture pins, and
      // it exists to stop a mislabeled host notification from manufacturing
      // an open nobody asked for. Reordering that direction too would trade a
      // same-severity gap (a dropped close) for a worse one (a granted close
      // nobody typed), so it stays as it was.
      if (modelCaused) {
        /* strongest signal, host-stamped: decided before either heuristic
           below, and before humanOrigin gets a say */
      } else if (humanOrigin && !isClosePattern(prompt)) {
        open = false; // an audited human change of mind → close, whatever the body looks like
        retractedByUnknownTagName = null;
      } else if (isModelCausedQueueContent(prompt)) {
        /* model-caused / empty, OR a human-origin close-phrase body that still
           reads as one of the three known tag shapes (see the comment above):
           neutral, the same filter the enqueue branch above applies to the
           same host event on its other delivery shape */
      } else if (isClosePattern(prompt)) {
        if (humanOrigin) {
          open = true;
          openedAtIndex = i;
          retractedByUnknownTagName = null;
          neutralizedHostTagName = null;
        }
        /* else: no open, producer cannot be attributed */
      }
      // else: not caught by the known-machine shapes above, not a close
      // phrase, and no audited human producer either — a host event this
      // filter does not yet recognize. The old rule closed here by default
      // (anything not on the model-caused list must be the user), which is
      // exactly the shape of bug #289 fixed for <task-notification>: a new
      // kind of unattributed host event would silently retract a close the
      // user already granted, and every future one would need its own line
      // in isModelCausedQueueContent to avoid repeating that. Requiring a
      // POSITIVE human producer to close, instead of enumerating every way to
      // recognize a machine one, means an event this filter has never seen
      // still cannot close the gate on its own.
      continue;
    }

    // Record AskUserQuestion tool_use ids (assistant record, always precedes its
    // answer in line order), and separately mark the ones that ARE our
    // close-reconfirm prompt (input carries CLOSE_RECONFIRM_MARK).
    const content = (o.message ?? o).content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== 'object' || b.type !== 'tool_use' || !b.id) continue;
        if (b.name !== 'AskUserQuestion') continue;
        askIds.add(b.id);
        if (JSON.stringify(b.input ?? null).includes(CLOSE_RECONFIRM_MARK)) markedAskIds.add(b.id);
      }
    }

    // Genuine typed user text. A close phrase opens the gate; the retraction
    // tripwire closes it; everything else is neutral (an
    // unrecognized phrase must not silently close a gate the user opened, so
    // there is no default "else close" branch here the way there used to be).
    if (userText != null && userText !== '') {
      if (isClosePattern(userText)) {
        open = true;
        openedAtIndex = i;
        retractedByUnknownTagName = null;
        neutralizedHostTagName = null;
      } else if (isCloseRetractionPattern(userText)) {
        open = false;
        retractedByUnknownTagName = null;
      }
      continue;
    }

    // AskUserQuestion answer, correlated to a recorded AskUserQuestion, EXCLUDED
    // and HARDENED. isModelReachableRecord keeps an injected / sdk / sidechain
    // record from reaching the answer parser. is_error:false AND the host's
    // success marker are required because a malformed AskUserQuestion echoes the
    // raw input back in an is_error result, and the model authors the option
    // labels.
    //
    // T5: a close phrase in the answer opens the gate, same as before. But a
    // decline no longer closes it on its own: only a decline answering a
    // MARKED prompt (ours, see markedAskIds above) does. Every other answer,
    // including a non-close, non-decline click and a decline to an unmarked
    // question, is neutral. The old default (any other real selection closed
    // the gate) let a reflection question the close skill's own Step 1a asks
    // mid-procedure cancel the approval that started that procedure: the
    // model asks something adjacent, the user answers plainly, and the answer
    // was not a close phrase, so the old rule read it as a change of mind.
    // The loss this buys: an unmarked question answered with "지금 종료하지
    // 말아 줘" (a real request to keep going, just not phrased as a decline
    // to OUR prompt) now passes through neutral instead of closing the gate.
    if (Array.isArray(content) && !isModelReachableRecord(o)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type !== 'tool_result' || !b.tool_use_id || !askIds.has(b.tool_use_id)) continue;
        if (b.is_error === true) continue;
        const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        if (!/have been answered/.test(s)) continue;
        let sawClose = false;
        let sawDecline = false;
        for (const m of s.matchAll(/="([^"]*)"/g)) {
          // Independent checks, not else-if: a marked prompt's decline option
          // can itself contain close wording (the model authors the text),
          // and the decline-wins priority below only works if sawDecline gets
          // set even when the same string also matches isClosePattern.
          if (isClosePattern(m[1])) sawClose = true;
          if (CLOSE_RECONFIRM_DECLINE_WORDS.test(m[1])) sawDecline = true;
        }
        // A decline on a MARKED prompt wins over a close match checked on the
        // same answer. The model authors the option text, and a marked prompt
        // exists precisely to ask "close now, yes or no", so an answer that
        // reads as a decline of THAT question must not be overridable by a
        // close phrase riding along elsewhere in the same answer string. If
        // the close check ran first, the model could word a decline option to
        // also contain a close phrase and force the gate open on its own
        // rejection.
        if (sawDecline && markedAskIds.has(b.tool_use_id)) {
          open = false;
          retractedByUnknownTagName = null;
        } else if (sawClose) {
          open = true;
          openedAtIndex = i;
          retractedByUnknownTagName = null;
          neutralizedHostTagName = null;
        }
      }
    }
  }
  return { open, openedAtIndex, retractedByUnknownTagName, neutralizedHostTagName };
}

/**
 * Public opening-axis predicate: does this transcript's typed/queued/answered
 * event history currently leave the close gate open? A thin boolean wrapper
 * over {@link walkCloseGate} — every caller that only needs the verdict uses
 * this. `close-gate-store.mjs`'s `closeGateStatus` imports `walkCloseGate`
 * directly instead, because it also needs `openedAtIndex` to order the open
 * against a recorded resolution.
 */
export function isCloseGateOpen(transcriptPath) {
  return walkCloseGate(transcriptPath).open;
}

/** The literal the user must type to approve a parked-overwrite batch. */
export const APPROVAL_PHRASE = 'apply-proposals';

/**
 * True iff the transcript carries a user's TYPED approval of the batch this nonce
 * was minted for — the authorization gate for a transcript-approved apply.
 *
 * Deliberately NOT isCloseGateOpen. That function answers "did the user want to
 * end the session", and it accepts a correlated AskUserQuestion answer as evidence
 * (see above). Reusing it here would let a SESSION-CLOSE approval spend itself as an
 * OVERWRITE approval: different authority, different question. Two gates, two
 * matchers.
 *
 * Typed text only, and an AskUserQuestion click is refused ON PURPOSE. The model
 * authors the option labels, and it authors them AFTER it has seen the nonce — so
 * it could place `apply-proposals <nonce>` on a "no" option, on every option, or
 * under a question that asks something else entirely. A click would prove a click.
 * Typing the nonce proves the user produced THIS phrase.
 *
 * The nonce carries the freshness: it is minted (crypto-random) only once the diff
 * has been re-read from disk and shown, so a turn that predates the diff cannot
 * contain it, and `resolve` spends the challenge BEFORE it writes, so it cannot be
 * replayed.
 *
 * extractUserMessageRecords does the de-pollution: it drops `isMeta` bodies
 * (slash-command and skill text, so a doc that quotes this phrase cannot satisfy the
 * gate), `promptSource: system|sdk`, Stop-hook feedback, and `tool_result` blocks (so
 * neither a tool's output nor a Read of a file that contains the phrase counts).
 * The model's own words are role:assistant and never reach it.
 *
 * Fail-closed: no path, a nonce that is not the minted shape, or an unreadable
 * transcript all return false.
 *
 * @param {string} transcriptPath
 * @param {string} nonce hex, as minted by `proposal challenge`
 */
export function hasTypedUserApproval(transcriptPath, nonce) {
  if (!transcriptPath || typeof nonce !== 'string') return false;
  // Pin the shape rather than accept any string: a caller that passed '' or a
  // regex-ish value would otherwise turn the match into a wildcard.
  if (!/^[a-f0-9]{32,}$/.test(nonce)) return false;
  // A MESSAGE that IS the phrase, not a message that has the phrase somewhere in it.
  // Line-exactness is not enough, because the user is TOLD to type this phrase and so
  // it is natural to quote it back while hesitating:
  //
  //     I do not consent; I am only quoting the command:
  //         apply-proposals <nonce>
  //
  // Every line-level matcher reads that as approval, and the user has authorized an
  // overwrite by refusing one. The whole eligible message must be the phrase and
  // nothing else, which is the bar the TTY channel has always held (`apply <id>`,
  // alone, on the prompt). The two channels must not disagree about what consent
  // looks like.
  //
  // Measured, not assumed: across 468 eligible user records in this project's
  // transcripts, none carried a second text block and none carried injected
  // system-reminder text, so a turn whose only content is the phrase survives
  // extraction as exactly the phrase. A false negative costs a retype; a false
  // positive costs the user's file.
  const want = `${APPROVAL_PHRASE} ${nonce}`;
  const records = extractUserMessageRecords(transcriptPath, Infinity);
  return records.some((msg) => msg.trim() === want);
}

/**
 * True iff the Stop payload shows work still pending in the background —
 * either a non-terminal `background_tasks` entry OR a scheduled `session_crons`
 * wake. Read-only: used to widen the autoclose reconfirm trigger (see
 * hypo-auto-minimal-crystallize.mjs) to "work is demonstrably still running",
 * not just "the wiki has uncommitted changes".
 *
 * ANY non-terminal `background_tasks` entry counts, not just delegated
 * subagents. A Stop payload captured from a real session confirmed the field
 * is genuinely sent (the older "grep turns up nothing / may not be sent" note
 * is retired): a background Bash appears as
 * `{id, type:'shell', status:'running', description, command}`, alongside
 * `type:'subagent'` for delegations. Restricting to `type==='subagent'` missed
 * shell background work (e.g. a `git push` / CI wait deferred behind a close
 * signal), letting the reconfirm branch mis-classify the session as idle and
 * re-nag every Stop turn.
 *
 * Defined as the NEGATION of a terminal status, not an enumeration of
 * "running" states: the observed non-terminal status is "running", and a
 * finished task is removed from the array entirely (it does NOT linger in a
 * terminal state — the next Stop simply reports `background_tasks:[]`). An
 * unrecognized/absent status is therefore treated as in-flight; only a
 * recognized terminal status clears an entry that is still present.
 *
 * `session_crons`: a non-empty array means the session is waiting on a
 * scheduled wake, which is itself pending work. A missing / non-array
 * `session_crons` is ignored (fail-open).
 *
 * Fail-open overall: a missing or non-array `background_tasks` contributes no
 * pending signal, so detection degrades gracefully to the git-uncommitted
 * signal alone rather than spuriously blocking.
 */
export function hasPendingBackgroundWork(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const TERMINAL = /^(completed|complete|done|finished|failed|error|errored|cancelled|canceled)$/i;
  const tasks = payload.background_tasks;
  if (
    Array.isArray(tasks) &&
    tasks.some((t) => t && (t.status == null || !TERMINAL.test(String(t.status))))
  ) {
    return true;
  }
  const crons = payload.session_crons;
  if (Array.isArray(crons) && crons.length > 0) return true;
  return false;
}

// The reconfirm reason (hypo-auto-minimal-crystallize.mjs emitBlock's
// reconfirm branch) instructs the close-now option under this exact label —
// used below to correlate an AskUserQuestion tool_use to OUR close-reconfirm
// prompt specifically, not just any AskUserQuestion the model happens to ask.
// Exported so the hook builds its reason text off this SAME literal instead
// of a second hardcoded copy: two independent literals would let a reworded
// reason silently break this correlation with no test to catch it.
export const CLOSE_RECONFIRM_MARK = '지금 닫기';

// The decline vocabulary shared by walkCloseGate's marked-reconfirm click
// branch and isCloseReconfirmDeclined below. One constant so the two walks
// cannot drift into recognizing different words for the same "not now"
// answer: they stay separate WALKS on purpose (isCloseReconfirmDeclined's
// re-arm rule only recognizes a typed close phrase, which is too narrow for
// walkCloseGate's other openers), but the vocabulary they match against is
// one value, not two copies that a future edit could update in only one
// place.
const CLOSE_RECONFIRM_DECLINE_WORDS = /(아직|나중|not\s?yet|later)/i;

/**
 * True iff the LATEST correlated AskUserQuestion answer in the transcript
 * declined an autoclose reconfirm prompt ("아직" / "나중" / "not yet" /
 * "later") — order-sensitive so a decline is suppressed again once the user
 * signals a NEW close intent afterward (re-arm).
 *
 * Read-only, forward scan over the FULL transcript (no tail truncation — a
 * decline can precede the next Stop by any number of turns). Reuses the same
 * askIds + tool_use_id correlation `walkCloseGate` (above) uses to bind
 * an AskUserQuestion answer to its own tool_use, so an unrelated tool_result
 * string can't forge a decline. Unlike `walkCloseGate` (which is already a
 * latest-event-wins walk, not an "any evidence, ever" OR), this tracks a
 * separate single latest-wins boolean as it
 * scans: a decline answer sets it true, and any later GENUINE USER close
 * signal resets it to false — the user asked to close again, so the prior
 * decline no longer applies.
 *
 * Two correlation guards (the same input-boundary concern class as
 * extractUserMessages' tool_result/injection exclusion above):
 *
 *  1. Re-arm is gated to a real user-typed close signal ONLY — mirrors
 *     extractUserMessages' own boundary filter (isMeta / promptSource
 *     system|sdk / tool_result exclusion, see extractUserMessages above)
 *     instead of re-deriving a separate policy. Without this, the MODEL'S
 *     OWN assistant reasoning text (which can itself contain "세션 마무리"),
 *     or a tool_result (e.g. a Read of a file that happens to quote a close
 *     phrase), could silently clear a recorded decline and re-nag the user
 *     who already said "아직" — the opposite of what a decline means.
 *  2. The AskUserQuestion tool_use is only added to `askIds` when its input
 *     carries CLOSE_RECONFIRM_MARK — i.e. it IS the close-reconfirm prompt,
 *     not some unrelated question the model asked around the same time. An
 *     unrelated question whose answer happens to contain a decline word
 *     ("나중"/"later") must not correlate.
 *
 * Fail-open: a missing/unreadable transcript → false (do not suppress; keep
 * reconfirming) — the caller stays on the safe (nag, not silent-close) side.
 */
export function isCloseReconfirmDeclined(transcriptPath) {
  if (!transcriptPath) return false;
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n');
  } catch {
    return false;
  }
  const askIds = new Set();
  let declined = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj.message ?? obj;
    const content = msg.content ?? obj.content;

    // Re-arm boundary (guard 1): only a genuine user-typed close signal may
    // re-arm. Same exclusions as extractUserMessages — isMeta injection,
    // system/sdk synthetic prompts, and (via the array-content branch below)
    // tool_result blocks, which are role:'user' in the transcript but are NOT
    // user-typed text.
    const isInjected =
      obj.isMeta === true || obj.promptSource === 'system' || obj.promptSource === 'sdk';
    const role = msg.role ?? obj.role ?? obj.type;
    if (!isInjected && role === 'user') {
      if (typeof content === 'string') {
        if (!content.startsWith('Stop hook feedback') && isClosePattern(content)) declined = false;
      } else if (Array.isArray(content)) {
        for (const b of content) {
          // Only type:'text' blocks are genuine user-typed text — a
          // tool_result block (also role:'user') is tool output, not
          // something the user typed, and must not re-arm.
          if (b && b.type === 'text' && typeof b.text === 'string' && isClosePattern(b.text)) {
            declined = false;
          }
        }
      }
    }

    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) {
        // Correlation guard 2: only OUR close-reconfirm prompt counts.
        const inputStr = JSON.stringify(b.input ?? null);
        if (inputStr.includes(CLOSE_RECONFIRM_MARK)) askIds.add(b.id);
        continue;
      }
      if (b.type === 'tool_result' && b.tool_use_id && askIds.has(b.tool_use_id)) {
        const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        for (const m of s.matchAll(/="([^"]*)"/g)) {
          if (CLOSE_RECONFIRM_DECLINE_WORDS.test(m[1])) declined = true;
        }
      }
    }
  }
  return declined;
}

// Events Claude Code actually reads additionalContext from, per the "Add
// context for Claude" docs. A hookEventName outside this set has no
// documented injection path, so buildOutput still emits the nested shape
// (the caller may be adding a NEW event later) but warns to stderr.
const INJECTABLE_EVENTS = new Set(['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'Stop']);

/**
 * Build hook output for Claude Code (nested hookSpecificOutput.additionalContext
 * channel). Codex hooks write systemMessage directly in their own files.
 *
 * @param {string} hookEventName - the event this hook fires on, e.g. 'UserPromptSubmit'.
 * @param {string} context - the text to inject.
 * @param {object} [extra] - control fields (continue, suppressOutput, ...) that
 *   stay top-level siblings of hookSpecificOutput.
 */
export function buildOutput(hookEventName, context, extra = {}) {
  if (!INJECTABLE_EVENTS.has(hookEventName)) {
    process.stderr.write(
      `[hypo] buildOutput: ${hookEventName} has no documented context-injection path\n`,
    );
  }
  // `extra` carries control fields, never context. Dropping the key here is
  // what makes the nested shape the only channel: without it a caller could
  // pass `{ additionalContext }` and the spread would put a top-level copy
  // right back, which is the exact bug this function exists to prevent.
  const { additionalContext: _shadowed, ...control } = extra;
  return {
    ...control,
    hookSpecificOutput: { hookEventName, additionalContext: context },
  };
}

// ── growth metrics (F2 + E4) ───────────────────────────────────────────────
// Single formatter used by Stop (hot-rebuild) and SessionStart hooks so the
// "[hypo] +N pages, ~M updated, K wikilinks" line stays consistent at both
// ends of a session. See Lane B.

/**
 * Format a growth-metrics one-liner. Returns '' when all counts are 0 so
 * callers can no-op silently.
 *
 * @param {'stop'|'start'} mode
 * @param {{addedPages?:number, updatedPages?:number, newWikilinks?:number}} stats
 * @returns {string}
 */
export function formatGrowthMetrics(mode, stats) {
  const a = Number(stats?.addedPages) || 0;
  const u = Number(stats?.updatedPages) || 0;
  const w = Number(stats?.newWikilinks) || 0;
  if (a === 0 && u === 0 && w === 0) return '';
  const body = `+${a} pages, ~${u} updated, ${w} wikilinks`;
  if (mode === 'stop') return `[hypo] ${body}`;
  if (mode === 'start') return `[hypo] 직전 세션: ${body}. 이어서 볼까요?`;
  return '';
}

/**
 * Compute session growth by inspecting the wiki repo's working tree against
 * HEAD. Counts every modified/added/untracked markdown file under `pages/`
 * or `projects/` and totals net-new `[[wikilink]]` occurrences in the diff.
 *
 * @param {string} hypoDir
 * @returns {{addedPages:number, updatedPages:number, newWikilinks:number}}
 */
export function computeSessionGrowth(hypoDir) {
  const empty = { addedPages: 0, updatedPages: 0, newWikilinks: 0 };
  if (!existsSync(join(hypoDir, '.git'))) return empty;
  try {
    // Single `git status --porcelain` enumerates tracked + untracked. On a
    // clean tree (no .md changes at all) we return early and skip the much
    // more expensive `git diff HEAD --unified=0` — Stop hook P95 win.
    // `-uall` expands untracked directories so a brand-new `pages/new.md`
    // isn't hidden behind a single `?? pages/` line.
    // `-z`: NUL-separated, verbatim paths (see commitWikiChanges). The old
    // newline/quote-strip parser left octal escapes in place, so Korean page
    // names silently failed the `pages/`·`projects/` scope match and dropped
    // out of the growth count.
    // `-z`: NUL-separated, verbatim paths (see commitWikiChanges). The old
    // newline/quote-strip parser left octal escapes in place, so Korean page
    // names silently failed the `pages/`·`projects/` scope match and dropped
    // out of the growth count.
    const porcelain = spawnSync(
      'git',
      ['--no-optional-locks', '-C', hypoDir, 'status', '--porcelain', '-uall', '-z'],
      {
        encoding: 'utf-8',
        timeout: 5000,
      },
    );
    if (porcelain.status !== 0) return empty;
    let addedPages = 0,
      updatedPages = 0;
    let hasTrackedMdChange = false;
    const untrackedMd = [];
    // Growth metrics describe wiki page activity, so restrict to the two
    // page-bearing trees. Top-level files like README.md or root hot.md are
    // intentionally excluded — they're scaffolding, not page growth.
    const inPagesScope = (file) =>
      file.endsWith('.md') && (file.startsWith('pages/') || file.startsWith('projects/'));
    const records = (porcelain.stdout || '').split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      const xy = rec.slice(0, 2);
      const file = rec.slice(3); // destination path for a rename/copy
      // A rename OR copy emits two records (`to\0from`); consume the trailing `from`.
      if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') i++;
      if (!inPagesScope(file)) continue;
      if (xy === '??') {
        untrackedMd.push(file);
        addedPages++;
        continue;
      }
      hasTrackedMdChange = true;
      // A copy's destination is a brand-new page, so it counts as added like `A`.
      if (xy.includes('A') || xy.includes('C')) addedPages++;
      else if (xy.includes('M') || xy.includes('R')) updatedPages++;
    }
    if (!hasTrackedMdChange && untrackedMd.length === 0) return empty;

    let plus = 0,
      minus = 0;
    if (hasTrackedMdChange) {
      // pathspec keeps non-Markdown / out-of-scope diffs from polluting the
      // wikilink count. Without it, a `[[…]]` string in a script.js diff was
      // being credited as a new wikilink.
      const diff = spawnSync(
        'git',
        ['-C', hypoDir, 'diff', 'HEAD', '--unified=0', '--', 'pages/', 'projects/'],
        { encoding: 'utf-8', timeout: 10000 },
      );
      if (diff.status === 0) {
        for (const line of (diff.stdout || '').split('\n')) {
          if (line.startsWith('+++') || line.startsWith('---')) continue;
          const matches = line.match(/\[\[[^\]\n]+\]\]/g);
          if (!matches) continue;
          if (line.startsWith('+')) plus += matches.length;
          else if (line.startsWith('-')) minus += matches.length;
        }
      }
    }
    for (const f of untrackedMd) {
      try {
        const body = readFileSync(join(hypoDir, f), 'utf-8');
        const matches = body.match(/\[\[[^\]\n]+\]\]/g);
        if (matches) plus += matches.length;
      } catch {}
    }
    return { addedPages, updatedPages, newWikilinks: Math.max(0, plus - minus) };
  } catch {
    return empty;
  }
}

// ── .hypoignore support ────────────────────────────────────────────────────
// Inlined here so deployed hooks (~/.claude/hooks/) don't need scripts/lib/.

function _globToRegex(glob) {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\x00/g, '.*') +
      '$',
  );
}

/**
 * Whether `commitWikiChanges` leaves this vault-relative path out of every commit because
 * `.hypoignore` matches it. The one place that rule is composed: the commit and the
 * session close's take-back of uncommitted appends both ask it. `patterns` lets a caller
 * that already loaded the list skip a second read.
 */
export function isExcludedFromCommit(hypoDir, relPath, patterns = loadHypoIgnore(hypoDir)) {
  return patterns.length > 0 && isIgnored(join(hypoDir, relPath), hypoDir, patterns);
}

/**
 * Whether git's own ignore rules (`.gitignore`, `info/exclude`, `core.excludesFile`) keep this
 * vault-relative path out of every commit. `git check-ignore` leaves tracked files out of its
 * answer, so only an untracked, matched path is true. `commitWikiChanges` never sees such a
 * path (`git status` does not list it), so it is not folded into `isExcludedFromCommit`.
 * Exit 0 is ignored; 1 and any error (128) read as not ignored.
 */
export function isIgnoredByGit(hypoDir, relPath) {
  const r = spawnSync('git', ['-C', hypoDir, 'check-ignore', '-q', '--', relPath], {
    timeout: 30000,
  });
  return r.status === 0;
}

export function loadHypoIgnore(hypoDir) {
  const ignorePath = join(hypoDir, '.hypoignore');
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// A session entry (`projects/<p>/sessions/<file>.md`) is ignored when the pattern list ignores the
// entry itself or either generated view of its project: the entry is the source of those views,
// so a project hidden from git by its view paths must not leak through its source files.
// scripts/lib/hypo-ignore.mjs carries the same second look; keep the two in step.
export function isIgnored(filePath, hypoDir, patterns) {
  if (matchesIgnorePatterns(filePath, hypoDir, patterns)) return true;
  const views = sessionViewPathsOf(relative(hypoDir, filePath).replace(/\\/g, '/'));
  return (
    views !== null &&
    views.some((view) => matchesIgnorePatterns(join(hypoDir, view), hypoDir, patterns))
  );
}

function matchesIgnorePatterns(filePath, hypoDir, patterns) {
  const rel = relative(hypoDir, filePath).replace(/\\/g, '/');
  const base = basename(filePath);
  for (const pattern of patterns) {
    const isDir = pattern.endsWith('/');
    if (isDir) {
      const dir = pattern.slice(0, -1);
      const isAnchored = dir.includes('/');
      if (isAnchored) {
        const re = _globToRegex(dir);
        const parts = rel.split('/');
        for (let i = dir.split('/').length; i <= parts.length; i++) {
          if (re.test(parts.slice(0, i).join('/'))) return true;
        }
      } else {
        const re = _globToRegex(dir);
        for (const part of rel.split('/')) {
          if (re.test(part)) return true;
        }
      }
      continue;
    }
    const hasSlash = pattern.includes('/');
    const target = hasSlash ? rel : base;
    if (_globToRegex(pattern).test(target)) return true;
  }
  return false;
}

// ── visibility scope ─────────────────────────────────────────────────────────
// The machine-scoped visibility namespace (`visibility_scope: machine:<device>`)
// requires that the SAME device string is produced at write time (audit device
// stamps) and at lookup time (the visibility filter) — otherwise a page never
// matches its own machine. So this is the single source for both. NOT cached:
// each call reads env fresh so in-process tests can override via HYPO_DEVICE
// (os.hostname is not mockable). CR/LF are stripped so the value stays a single
// frontmatter token.
export function currentDevice() {
  // Strip CR/LF BEFORE the fallback chain, not after: a HYPO_DEVICE of only
  // CR/LF is truthy, so stripping after `||` would yield '' and make
  // scopeVisible('machine:', '') pass — the empty-owner page must hide
  // everywhere. Stripping first collapses such a value to '' so it falls through
  // to hostname, keeping the result non-empty on every path.
  const env = String(process.env.HYPO_DEVICE || '').replace(/[\r\n]/g, '');
  if (env) return env;
  const host = String(hostname() || '').replace(/[\r\n]/g, '');
  return host || 'unknown';
}

// A top-level frontmatter scalar from a page's raw content: top-level only, first-wins, a
// whitespace-led trailing YAML comment and surrounding quotes stripped. Mirrors
// scripts/lib/frontmatter.mjs normalization rather than importing it: hooks deploy to
// ~/.claude/hooks/ with no external imports. `null` when the key is absent. Every key read this
// way (`visibility_scope`, `entry_scope`) goes through here, so they cannot drift apart.
export function frontmatterScalar(raw, key) {
  const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || /^-(\s|$)/.test(line)) continue; // nested / list item
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    return line
      .slice(idx + 1)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
  }
  return null;
}

// Extract the top-level `visibility_scope` from a page's raw content. The five consumers must
// call this instead of a local last-wins/no-comment parser, else a `machine:devA # note` value
// fails to match on its own machine. Returns '' when absent (which scopeVisible treats as shared).
export function readVisibilityScope(raw) {
  return frontmatterScalar(raw, 'visibility_scope') ?? '';
}

// The single visibility decision, shared by lookup / query / file-watch /
// page-usage / crystallize. Its definition lives in session-entries.mjs, which
// the generated views need and which cannot import this file; re-exported here
// so every existing caller keeps its import.
export { scopeVisible };
