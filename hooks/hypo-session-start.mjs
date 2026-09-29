#!/usr/bin/env node
/**
 * hypo-session-start.mjs — SessionStart hook
 *
 * On session start:
 *   HIT  → cwd matches a project's working_dir → inject hot.md (2000 chars) + session-state.md (2000 chars)
 *   MISS → inject global hot.md pointer only (no fan-out to all projects)
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { atomicWrite } from './atomic-write.mjs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';
import {
  HYPO_DIR,
  buildOutput,
  SESSION_STATE_NEXT_HEADINGS,
  formatGrowthMetrics,
  readSyncState,
  clearSyncState,
  recordSyncSuccess,
  classifySyncOp,
  readClearMarker,
  clearClearMarker,
  loadHypoIgnore,
  isIgnored,
  sessionMarkerPath,
  shouldSuggestProjectCreation,
  buildProjectSuggestionLine,
  recordSuggestionCooldown,
  sanitizeProjForPrompt,
  pickProjectByCwd,
  collectProjectWorkingDirs,
  buildVaultOrientation,
  staleMarkerFor,
  currentDevice,
  scopeVisible,
  readVisibilityScope,
  pkgRootDriftStatus,
  PKG_ROOT,
  withFileLock,
  vaultCommitLockTarget,
  writeRootHotProjection,
  recordTouchedPaths,
  clearTouchedPaths,
  claimProjectionWrite,
  consumeRootHotHealthNotice,
  rootHotBackupRecoveryNotice,
} from './hypo-shared.mjs';
import {
  defaultCachePath,
  detectChannel,
  readCache,
  cacheIsFresh,
  computeNotice,
  markNotified,
  isOptedOut,
  resolveCliOnPath,
  computeSiblingNotice,
  siblingAlreadyNotified,
  markSiblingNotified,
  classifyInstall,
  parseSemver,
  pkgRootDriftAlreadyNotified,
  markPkgRootDriftNotified,
  clearPkgRootDriftNotified,
  pkgRootNullAlreadyNotified,
  markPkgRootNullNotified,
  clearPkgRootNullNotified,
  UPGRADE_APPLY_EITHER,
} from './version-check.mjs';
import {
  snapshotBase,
  overwriteTargets,
  beginObservedGeneration,
  recordObserved,
  hashContent,
} from './base-store.mjs';
import { listProposalsChecked } from './proposal-store.mjs';

// Privacy guard: refuse to read+inject .hypoignore-matched
// wiki files into additionalContext. Without this, a user who lists
// `projects/private/hot.md` in .hypoignore would still see SECRET emit because
// session-start reads hot/state paths directly.
//
// Visibility guard: a machine-scoped page (visibility_scope: machine:<owner>)
// must not be injected on a machine other than its owner. hypo-file-watch
// already filters these very files, so leaving session start unfiltered made the
// SAME file behave differently depending on which path opened it: the user sets
// the field, sees it honored on edit, and never learns that session start still
// ships the body. Read the scope from the RAW content before the maxChars slice:
// slicing first could cut the frontmatter off and silently fail open.
// The root hot.md is a frontmatter-less pointer table, so it reads as '' and
// passes (shared) unchanged.
// Returns `{raw, shown}` rather than just the sliced string: the observed-set
// record must hash the FULL bytes this call just read, not a fresh re-read at
// record time, or a write that lands in the window between this read and the
// record call would be credited to this session's observation without ever
// having been shown to it. `shown` stays the maxChars-sliced display string
// every existing caller already expects.
function readIfNotIgnored(path, maxChars, patterns) {
  if (!path) return null;
  if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return null;
  const raw = readFileSync(path, 'utf-8');
  if (!scopeVisible(readVisibilityScope(raw), currentDevice())) return null;
  return { raw, shown: raw.slice(0, maxChars) };
}

// Scoped-out is not the same as absent. Both make readIfNotIgnored return null,
// but telling the model "no snapshot yet / first session" when the snapshot merely
// belongs to another machine is a lie it will act on. Returns false for an ignored
// or missing file so only a real machine-scope hide reports true.
// The caller may name the project and the fact, never the withheld body: a message
// explaining the hide must not re-leak what it hid.
function isScopedOut(path, patterns) {
  try {
    if (!path || !existsSync(path)) return false;
    if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return false;
    return !scopeVisible(readVisibilityScope(readFileSync(path, 'utf-8')), currentDevice());
  } catch {
    return false;
  }
}

// Compute the STALE marker for a hot/state file from its RAW content (readIfNotIgnored
// already slices, which could truncate frontmatter). Honors the same .hypoignore
// privacy guard, and returns '' for any miss (no path, ignored, absent, no
// verify_by_date, or error) so derived summaries pass through unchanged.
function staleMarkerForPath(path, patterns, today) {
  try {
    if (!path) return '';
    if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return '';
    if (!existsSync(path)) return '';
    return staleMarkerFor(readFileSync(path, 'utf-8'), today);
  } catch {
    return '';
  }
}

// Directory of the running hook, and the install root one level up
// (<root>/hooks/...). The root is derived from the RUNNING hook path rather
// than ~/.claude/hypo-pkg.json so a dual install (npm + plugin) or a stale
// metadata file can't mislabel the channel (teams review (b), 2026-05-21).
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const ACTIVE_ROOT = dirname(HOOK_DIR);

function readInstalledVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Update-notifier (teams-reviewed 2026-05-21). Reads ONLY the cache — never a
 * synchronous network call. When the cache is stale, fires a detached worker to
 * refresh it (shown next session). Fully best-effort: any failure returns ''.
 */
function buildUpdateNotice() {
  try {
    if (isOptedOut()) return '';
    const cachePath = defaultCachePath();

    let root = ACTIVE_ROOT;
    let version = readInstalledVersion(root);
    if (!version) {
      try {
        const meta = JSON.parse(readFileSync(join(homedir(), '.claude', 'hypo-pkg.json'), 'utf-8'));
        root = meta.pkgRoot || root;
        version = meta.pkgVersion || readInstalledVersion(root);
      } catch {
        /* fallback unavailable */
      }
    }
    if (!version) return '';

    const channel = detectChannel(root);
    const cache = readCache(cachePath);

    if (!cacheIsFresh(cache)) {
      try {
        const worker = join(HOOK_DIR, 'version-check-fetch.mjs');
        if (existsSync(worker)) {
          const child = spawn(process.execPath, [worker, cachePath], {
            detached: true,
            stdio: 'ignore',
          });
          // spawn() failures (EAGAIN/EMFILE/ENOENT) surface ASYNChronously on
          // the child's 'error' event — the try/catch above only catches the
          // synchronous throw. Without this listener an unhandled 'error' would
          // crash SessionStart, violating the best-effort contract.
          child.on('error', () => {});
          child.unref();
        }
      } catch {
        /* spawn is best-effort */
      }
    }

    const notice = computeNotice(cache, channel, version);
    if (!notice) return '';
    markNotified(cachePath, channel, notice.latest);
    return notice.line;
  } catch {
    return '';
  }
}

/**
 * Stale-sibling notice (D3). The update-notifier above only knows
 * whether the ACTIVE install is behind latest — it is blind to an OLDER sibling
 * that owns the `hypomnema` bin on PATH. That sibling is the live footgun:
 * running `hypomnema init`/`upgrade` through it downgrades the active hooks.
 *
 * This is the ONLY surface that reaches a user already in that state, because it
 * runs from the (newer) active hook — `doctor` invoked via the stale CLI would
 * run the stale doctor. fs-only (no npm/which spawn). Throttled via the cache so
 * it nags once per (cliPath@cliVersion → activeVersion) tuple. Best-effort.
 */
function buildSiblingNotice() {
  try {
    if (isOptedOut()) return '';
    // Active install identity = hypo-pkg.json (what init/upgrade write). This is
    // the authoritative pkgRoot+version; ACTIVE_ROOT (~/.claude) has no package.json.
    let active = null;
    try {
      active = JSON.parse(readFileSync(join(homedir(), '.claude', 'hypo-pkg.json'), 'utf-8'));
    } catch {
      return ''; // no active metadata → nothing to compare a sibling against
    }
    if (!active || !active.pkgVersion) return '';
    const cli = resolveCliOnPath('hypomnema');
    const notice = computeSiblingNotice(cli, {
      pkgRoot: active.pkgRoot,
      version: active.pkgVersion,
    });
    if (!notice) return '';
    const cachePath = defaultCachePath();
    const cache = readCache(cachePath);
    if (siblingAlreadyNotified(cache, notice.key)) return '';
    markSiblingNotified(cachePath, notice.key);
    return notice.line;
  } catch {
    return '';
  }
}

// Full path to the file init/upgrade own writing (hypo-shared.mjs's
// readCachedPkgRoot reads it but does not export the path). Self-heal below
// reads and rewrites it directly rather than adding a write path into
// hypo-shared.mjs, which currently owns only the READ side of this file.
const HYPO_PKG_JSON_PATH = join(homedir(), '.claude', 'hypo-pkg.json');

// ── self-heal lock ───────────────────────────────────────────────────────────
// Two sessions can self-locate to two DIFFERENT install roots at once (a dual
// install, or one upgrade mid-flight while another session already started)
// and both hit this same homedir()-keyed hypo-pkg.json. Reading it once,
// comparing, then writing let whichever session finished SECOND clobber
// whatever the first had just written, even when its own incoming version
// was itself newer than the file's ORIGINAL value (Codex 3rd-round review,
// 2026-09-11: reproduced by running a 1.8.2 and a 1.8.1 install against the
// same HOME; both read the pre-existing 1.0.0, both judged themselves an
// improvement over it, and whichever wrote last won regardless of which
// incoming version was actually higher).
//
// This used to hand-roll its own `wx` lockfile (write-then-fill), which a
// Codex 3rd-round review caught publishing an empty lock before the pid was
// written: a holder preempted inside that window is indistinguishable from a
// pid-less legacy lock, so a second writer steals it and both run the
// critical section, which is the exact bug a liveness check is supposed to
// close. `withFileLock` (below, from hypo-shared.mjs) already exists in this
// repo, and its own docstring names that same failure mode as the reason it
// stages the pid into a private sibling first and `linkSync`s it into place
// atomically. Reuse it instead of repeating the mistake it was written to
// avoid. `timeoutMs: 150` keeps the bounded, best-effort wait this hook
// always had (long enough for a sibling session's heal, a handful of sync fs
// calls, to finish and release; short enough that SessionStart itself never
// stalls noticeably even under contention); `staleMs: 30000` keeps the same
// crashed-holder cutoff the old lock used.
//
// withFileLock throws ELOCKTIMEOUT when it cannot acquire in time, never a
// bare Error, so selfHealPkgRoot's caller can tell "lock contention" apart
// from "fn() itself failed". Either way this hook must fail OPEN: a
// SessionStart hook must never block or crash a session over a lock it
// couldn't get, so both outcomes collapse to the caller's `{ healed: false }`
// via the try/catch already wrapping the read-compare-write below.
//
// Known residue in withFileLock itself, inherited here rather than
// re-solved: a microscopic stat-then-unlink TOCTOU on the stale-steal path
// (a fresh holder can grab the path in that gap and have its lock removed by
// the stealer, bounded by staleMs being far above a normal close), a
// local-filesystem-only guarantee (no network FS atomicity), and a PID-reuse
// window where a live process happens to reuse a crashed holder's pid and
// gets treated as the still-alive original (an availability loss, the lock
// is never stolen from it, not a correctness bug, since two writers still
// never enter the critical section together).

/**
 * Self-heal `pkgRoot`/`pkgVersion` in `hypo-pkg.json` in place, once a session
 * has already detected they disagree with the code's own self-location
 * (`status`, from pkgRootDriftStatus()). Until now the user's only remaining
 * job was copying those two values into the file by hand; this does that copy
 * for them.
 *
 * Preserves every other key untouched (`schemaVersion`, `extensions`,
 * `commands`, ...): this file is shared with init/upgrade's own writes, so a
 * narrower op than "read the whole object, patch two keys, write the whole
 * object back" would silently drop state another lane depends on. Mirrors
 * scripts/lib/pkg-json.mjs's writeDualSkipProvenance in spirit, but cannot
 * import it — hooks never reach into scripts/.
 *
 * Fails closed to `{ healed: false }` on anything short of a verified,
 * complete write: a lock that could not be acquired (timeout or a genuine
 * fs error from `withFileLock`), an unreadable/corrupt existing file, a
 * non-object parse result, no resolvable-and-parseable version at the new
 * root, a DOWNGRADE (below), or the write itself throwing. The caller must
 * fall back to the manual `/hypo:upgrade` guidance rather than claim a fix
 * that never landed.
 *
 * Concurrency: the whole read-compare-write runs inside `withFileLock`
 * (hypo-shared.mjs), which re-reads `hypo-pkg.json` AFTER acquiring the
 * lock, not before, since a pre-lock snapshot is exactly what let two
 * concurrent installs race. Losing the lock (ELOCKTIMEOUT, or any other
 * throw from `withFileLock` or from `fn` itself) is caught by the outer
 * try/catch and treated as fail-open: this session simply skips the heal,
 * the same outcome as any other precondition miss below.
 *
 * The lock's reach is narrower than the sentence above about sharing this
 * file with init/upgrade might suggest: it serializes SessionStart heals
 * against each other, and nothing else. `writePkgJsonAtomic` (what init,
 * upgrade and writeDualSkipProvenance go through) does not take it, so an
 * `upgrade --apply` running while another session starts is still a lost
 * update. The damage is bounded rather than absent: heal refuses a
 * downgrade, so whichever write lands last leaves `pkgVersion` at the same
 * value or higher. That bound is the whole argument for leaving it, and it
 * dies the moment a heal path is allowed to lower the version.
 *
 * Downgrade guard: a dual install (e.g. a plugin-scope cache at 1.8.2 and a
 * project-scope cache at 1.8.1, both reading the SAME `hypo-pkg.json` because
 * that path is keyed on `homedir()`, not on scope) means a session that
 * happens to self-locate to the OLDER sibling would otherwise overwrite this
 * file's `pkgVersion` with a lower number — the one baseline
 * `scripts/upgrade.mjs`'s downgrade guard and `hooks/version-check.mjs`'s
 * `computeSiblingNotice` both compare against. `classifyInstall` is the same
 * judgment those two already trust, but this only blocks the `'downgrade'`
 * verdict: a comparison that resolves and comes out lower. On `'downgrade'`,
 * this returns `{ healed: false }` before touching the file, so the normal
 * failure fallback below fires the original manual-fix guidance instead of
 * quietly recording the sibling's older version as truth.
 *
 * Direction matters for the `'unknown'` verdict (one side's semver failed to
 * parse), which is why the INCOMING version is checked with `parseSemver`
 * up front rather than folded into the same `'unknown'` escape hatch as an
 * unparseable EXISTING value. An unparseable incoming version must never
 * heal: that would overwrite a good `pkgVersion` with garbage read from a
 * corrupt `package.json` (Codex 3rd-round review, 2026-09-11: reproduced with
 * `package.json.version: "not-semver"` against an existing `1.8.2`, which
 * used to heal to `"not-semver"`). An unparseable EXISTING value with a
 * valid incoming one is the opposite case, a good value replacing a
 * corrupted one, and is still allowed through by `classifyInstall`'s
 * `'unknown'` verdict: there is no valid comparison to protect against
 * there, and refusing it would leave a broken value in place forever with no
 * path back to a good one.
 */
function selfHealPkgRoot(status) {
  try {
    return withFileLock(
      HYPO_PKG_JSON_PATH,
      () => {
        const meta = JSON.parse(readFileSync(HYPO_PKG_JSON_PATH, 'utf-8'));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return { healed: false };
        const newVersion = readInstalledVersion(status.self);
        if (!newVersion || !parseSemver(newVersion)) return { healed: false };
        const oldVersion = typeof meta.pkgVersion === 'string' ? meta.pkgVersion : null;
        const incoming = { pkgRoot: status.self, version: newVersion };
        const active = { pkgRoot: meta.pkgRoot, version: oldVersion };

        if (classifyInstall(incoming, active) === 'downgrade') return { healed: false };
        const updated = { ...meta, pkgRoot: status.self, pkgVersion: newVersion };
        // temp + rename in the SAME directory: a crash mid-write leaves only a
        // throwaway temp file behind, never a torn hypo-pkg.json that the next
        // session's every hook read of this file would then choke on.
        // Shared writer rather than a local temp+rename: this one had no
        // cleanup, so a failed rename left its temp behind for good. The temp
        // name loses its leading dot in the trade, so a leaked one would now be
        // visible in a directory the user reads; that is the point, since the
        // shared writer is the one that does not leak.
        atomicWrite(HYPO_PKG_JSON_PATH, `${JSON.stringify(updated, null, 2)}\n`);
        return { healed: true, oldVersion, newVersion };
      },
      { timeoutMs: 150, staleMs: 30_000, pollMs: 20 },
    );
  } catch {
    // Fail open: a lock timeout (ELOCKTIMEOUT) or any other throw from
    // withFileLock/fn must not block or crash SessionStart. The caller
    // treats this exactly like any other heal precondition miss.
    return { healed: false };
  }
}

/**
 * pkgRoot drift notice. hypo-shared.mjs's resolvePkgRoot() already
 * self-corrects PKG_ROOT in memory whenever the code's own resolved location
 * disagrees with the cached hypo-pkg.json — but silent self-correction used
 * to leave the FILE itself stale forever, with nothing but a "please copy
 * these two values in yourself" notice to show for it. This now does that
 * copy itself (selfHealPkgRoot above), on the spot, in the same session that
 * detected the drift.
 *
 * Notify-once cache: a successful heal marks the (cached → self-location)
 * pair notified, but next session's pkgRootDriftStatus() reads back 'match'
 * from the now-fixed file regardless and clears it on its own — the mark here
 * only prevents a duplicate "fixed" line within a session that re-checks
 * drift more than once. A FAILED heal must NOT mark the pair: marking would
 * suppress the only guidance the user has (the manual `/hypo:upgrade` line)
 * for a drift that never actually got fixed, on every later session that
 * hits the same stale pair.
 *
 * Tri-state (pkgRootDriftStatus): 'match' CLEARS any earlier mark (checked
 * FIRST, unconditionally — even under opt-out, so a drift that resolves while
 * opted out doesn't leave a stale mark that then suppresses a genuine
 * recurrence once opt-out is lifted); 'unknown' touches nothing (self-location
 * could not be resolved this session — the permanent steady state for the
 * npm/manual channel, not evidence either way); only 'drift' can produce a
 * banner (or attempt a heal), and opt-out is checked there so an opted-out
 * session never writes a fix — or marks a pair notified — it never actually
 * showed.
 */
function buildPkgRootDriftNotice() {
  try {
    const status = pkgRootDriftStatus();
    const cachePath = defaultCachePath();
    if (status.status === 'match') {
      clearPkgRootDriftNotified(cachePath);
      return '';
    }
    if (status.status === 'unknown') return '';
    if (isOptedOut()) return '';
    const key = `${status.cached || '(none)'}->${status.self}`;
    const cache = readCache(cachePath);
    if (pkgRootDriftAlreadyNotified(cache, key)) return '';

    const heal = selfHealPkgRoot(status);
    if (heal.healed) {
      markPkgRootDriftNotified(cachePath, key);
      return (
        `[Hypomnema] Package metadata drift fixed: hypo-pkg.json pointed at ` +
        `\`${status.cached || '(none)'}\`` +
        `${heal.oldVersion ? ` (version ${heal.oldVersion})` : ''}, now synced to ` +
        `\`${status.self}\` (version ${heal.newVersion}).\n` +
        `  This was corrected automatically for this session — no action needed.`
      );
    }

    // Heal did not land (unreadable/corrupt hypo-pkg.json, no resolvable
    // version at the new root, or the write itself failed). Do NOT mark this
    // pair notified here — see the docstring above — and fall back to the
    // original manual-fix guidance.
    //
    // status.cached is null both for a genuinely fresh install (never ran
    // /hypo:init) AND for the channel-judgment-failure guard (init/upgrade
    // positively decided to leave pkgRoot unset; see scripts/init.mjs's
    // resolveDurableRoot). "run /hypo:upgrade and confirm the apply step" is a
    // dead end in the second case: apply skips the same write until the
    // registry itself is fixed. Point at that fix directly rather than send the
    // user in a loop.
    const recoveryLine = status.cached
      ? '  → run `/hypo:upgrade` and confirm the apply step to bring hypo-pkg.json back in sync.'
      : '  → if `/hypo:upgrade` keeps leaving this unwritten, the plugin channel itself cannot be ' +
        'resolved: repair `~/.claude/plugins/installed_plugins.json` first (reinstall the plugin, or ' +
        'run `/plugin marketplace update hypomnema` then `/reload-plugins`), then re-run `/hypo:upgrade`.';
    return (
      `[Hypomnema] Package metadata drift: hypo-pkg.json still points at ` +
      `\`${status.cached || '(none)'}\`, but the code actually running resolves to ` +
      `\`${status.self}\`.\n` +
      `  Hooks already resolved the correct root for this session — this is a ` +
      `heads-up, not a blocker (the automatic fix did not take — see below).\n${recoveryLine}`
    );
  } catch {
    return '';
  }
}

/**
 * PKG_ROOT-null notice. A different failure than the drift banner above:
 * drift only fires when self-location DID resolve (PKG_ROOT is non-null,
 * just disagreeing with the cache). This fires when hooks/hypo-shared.mjs's
 * resolvePkgRoot() came up with nothing at all — self-location failed AND no
 * verified provenance sidecar covered it — which is exactly the state where
 * PreCompact's lint/feedback calls silently no-op (they have no root to
 * shell scripts through). The two conditions cannot both hold in the same
 * session (drift requires a non-null self-location), so there is no overlap
 * to arbitrate — they use separate notify-once cache fields regardless, so
 * neither one depends on that being true forever.
 *
 * Same notify-once shape as the drift banner: shown once, cleared as soon as
 * PKG_ROOT resolves again so a later recurrence re-notifies instead of
 * staying suppressed by a mark from a different install state.
 */
function buildPkgRootNullNotice() {
  try {
    const cachePath = defaultCachePath();
    if (PKG_ROOT) {
      clearPkgRootNullNotified(cachePath);
      return '';
    }
    if (isOptedOut()) return '';
    const cache = readCache(cachePath);
    if (pkgRootNullAlreadyNotified(cache)) return '';
    markPkgRootNullNotified(cachePath);
    return (
      `[Hypomnema] Package root unresolved: this install's hooks cannot locate ` +
      `their own package, so PreCompact's lint/feedback checks are silently ` +
      `skipped this session.\n` +
      `  → run ${UPGRADE_APPLY_EITHER} to sync this install's hook copies ` +
      `with the current package. \`/hypo:init\` will ` +
      `NOT fix this — it skips every hook file that already exists.\n` +
      `  → or run \`hypomnema doctor\` to see what's missing.`
    );
  } catch {
    return '';
  }
}

const PROJECTS_DIR = join(HYPO_DIR, 'projects');
const GROWTH_CACHE = join(HYPO_DIR, '.cache', 'last-session-growth.json');

function readLastGrowthLine() {
  if (!existsSync(GROWTH_CACHE)) return '';
  try {
    const stats = JSON.parse(readFileSync(GROWTH_CACHE, 'utf-8'));
    return formatGrowthMetrics('start', stats);
  } catch {
    return '';
  }
}

/**
 * Amendment 2026-05-14: if the prior session ended
 * via `/clear`, hypo-session-end stashed its identity in `.cache/clear-marker.json`.
 * Read it (with 7-day stale guard), unlink it (one-shot), and return a
 * `[WIKI_AUTOCLOSE]` recovery line for additionalContext + stderr.
 *
 * @param {string|undefined} source SessionStart payload `source` field
 * @returns {string} recovery line, or '' when no recovery is needed
 */
function buildClearRecoveryLine(source) {
  if (source !== 'clear') return '';
  const marker = readClearMarker(HYPO_DIR);
  if (!marker) return '';
  clearClearMarker(HYPO_DIR);
  const prevId = marker.prev_session_id || 'unknown';
  const prevTr = marker.prev_transcript_path || null;
  const prevCwd = marker.prev_cwd || null;
  const trLine = prevTr ? `\n  prev_transcript: ${prevTr}` : '';
  const cwdLine = prevCwd ? `\n  prev_cwd: ${prevCwd}` : '';
  return (
    `[WIKI_AUTOCLOSE] 이전 세션(${prevId})이 /clear로 강제 종료됨.${trLine}${cwdLine}\n` +
    `  session-close가 미완료라면 지금 즉시 실행할 것 ` +
    `(hot.md + session-state.md + log.md 최소 갱신).`
  );
}

/**
 * Pull the wiki repo. Returns true only when the pull actually succeeded. On
 * success, also records the last-success timestamp (silently — no notice; the
 * existing failure notice below is unchanged) so doctor never reports "never
 * synced" right after a healthy startup pull, even when no auto-commit Stop
 * hook has run yet this session.
 */
function gitPull(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  const r = spawnSync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], {
    stdio: 'pipe',
    timeout: 10000,
  });
  const ok = r.status === 0;
  if (ok) recordSyncSuccess(dir, 'pull');
  return ok;
}

/**
 * Surface unresolved sync failures recorded by a prior session's
 * Stop hook. The entry is cleared only once this session's pull has
 * succeeded AND there is no unpushed commit left behind by a failed push
 * (`[ahead N]`).
 *
 * Resolution deliberately checks only the ahead-of-remote state, not the full
 * working tree: uncommitted/untracked files are not a sync failure, and a
 * fresh `hypo init` wiki does not git-ignore `.cache/`, so a broader cleanliness
 * check would see the sync-state file itself and never clear.
 *
 * @returns {string} a `[WIKI: last sync failed: ...]` (or, for a conflict/
 *   conflict-unresolved entry, dedicated manual-merge guidance) line, or ''
 *   when clear.
 */
function syncStateNotice(pullOk) {
  const { entries, parseError } = readSyncState(HYPO_DIR);
  // A corrupt JSONL file is still an "open" failure — surface it (doctor warns
  // too) but never clear it, so the unreadable record survives for inspection.
  if (parseError) return '[WIKI: last sync failed: sync-state.json unreadable — inspect manually]';
  if (entries.length === 0) return '';
  let resolved = false;
  if (pullOk) {
    const r = spawnSync('git', ['-C', HYPO_DIR, 'status', '--branch', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    resolved = r.status === 0 && !/\[ahead \d+\]/.test(r.stdout || '');
  }
  if (resolved) {
    clearSyncState(HYPO_DIR);
    return '';
  }
  const last = entries[entries.length - 1];
  // classifySyncOp (hypo-shared.mjs) is the single judgment both this hook
  // and doctor.mjs's checkSyncState branch on, so the two surfaces cannot
  // silently diverge on WHICH op gets which treatment: this exact check used
  // to be an exact `=== 'conflict'` comparison here that missed
  // 'conflict-unresolved' — the MORE dangerous op, since the abort itself
  // failed and the tree may still be half-merged — while doctor already
  // caught it via startsWith('conflict').
  const cls = classifySyncOp(last.op);
  if (cls === 'conflict-unresolved') {
    return (
      `[WIKI: remote diverged AND the automatic merge-abort failed — the working ` +
      `tree may still be half-merged (unmerged paths or an in-progress merge). ` +
      `Do NOT commit or push yet. Inspect \`git -C ${HYPO_DIR} status\` first: if a ` +
      `merge is in progress, resolve the conflicts, then \`git -C ${HYPO_DIR} add <resolved paths>\` ` +
      `and \`git -C ${HYPO_DIR} commit\` (git refuses a commit while unmerged entries remain staged) ` +
      `— or run \`git -C ${HYPO_DIR} merge --abort\` to discard it instead, before continuing.]`
    );
  }
  if (cls === 'conflict') {
    return (
      `[WIKI: remote diverged — auto-merge was aborted to protect your edits ` +
      `(your local work is committed and safe; the other machine's version is on the remote). ` +
      `Resolve manually: \`git -C ${HYPO_DIR} pull --no-rebase\`, fix conflicts, then push.]`
    );
  }
  // An unrecognized `conflict*` op — some future syncRemote failure mode this
  // hook has no dedicated branch for. Neither the clean-conflict claim above
  // ("committed and safe") nor the conflict-unresolved claim ("the abort
  // failed") is known to be true here, so assert neither: say plainly that
  // the state is unknown and treat it as unresolved until a human checks.
  if (cls === 'unknown-conflict') {
    return (
      `[WIKI: remote diverged — an unrecognized conflict-related sync failure was recorded ` +
      `(op='${last.op}'). Its resolution state cannot be confirmed automatically, so treat it ` +
      `as unresolved: do NOT commit or push yet. Inspect \`git -C ${HYPO_DIR} status\` first for ` +
      `unmerged paths or an in-progress merge before continuing.]`
    );
  }
  return `[WIKI: last sync failed: ${last.op || '?'} — ${last.error || 'unknown'}]`;
}
/**
 * Surface the vault-wide count of parked write-proposals (T8). Routed
 * exactly like syncStateNotice: the line joins the `notices` array (→
 * additionalContext) and is also written to stderr, so both the model and the
 * user's transcript see it. NOT a systemMessage banner (that channel is
 * reserved for the update/sibling notices). Pure read (listProposalsChecked
 * never mutates); best-effort so a store read failure never breaks
 * SessionStart. '' when there are no pending proposals AND nothing is wrong
 * with the store, so nothing surfaces on the ordinary empty path.
 *
 * Uses listProposalsChecked rather than the plain listProposals this used to
 * call: a store that could not be listed at all (`ok: false`, permissions or
 * a file sitting where the directory should be) and a store with an
 * unparseable `.json` candidate both used to look identical to zero here,
 * silently, at the start of every session. Both get a short clause appended
 * to the SAME line rather than a line of their own, so a clean vault's
 * prompt budget does not grow by a byte.
 */
function pendingProposalNotice() {
  try {
    const inventory = listProposalsChecked(HYPO_DIR);
    if (!inventory.ok) return '[WIKI: 파킹 proposal 측정 불가 (hypomnema doctor 확인)]';
    const n = inventory.proposals.length;
    const u = inventory.unreadable.length;
    if (n === 0 && u === 0) return '';
    const parts = [];
    if (n > 0) parts.push(`대기 proposal ${n}건 (검토: hypomnema proposal list)`);
    if (u > 0) parts.push(`안 읽히는 후보 ${u}건 (hypomnema doctor 확인)`);
    return `[WIKI: ${parts.join(', ')}]`;
  } catch {
    return '';
  }
}
// ── foreign-project uncommitted notice ──────────────────────────────────────
// Same signal precompactGateStatus already computes for its own gate
// (closeAccountableScope / sessionTouchTrusted, hypo-shared.mjs), surfaced
// here instead for the AGENT reading additionalContext: a project this
// session isn't scoped to may still have uncommitted changes sitting in the
// shared vault, and without this line the agent has no way to tell those
// apart from its own unfinished work. Cannot import hypo-shared.mjs's
// `projectOfPath` / `gitDirtyFiles` here, not a technical constraint (both
// are simply not exported), but an ownership decision: hypo-shared.mjs
// belongs to a different lane, so this hook keeps a local, self-contained
// duplicate rather than adding an export for it. The cost is real: a future
// fix to gitDirtyFiles (e.g. its rename re-attribution) does not propagate
// here automatically.

const FOREIGN_GIT_TIMEOUT_MS = 3000;
// Cap on how many foreign project names the notice spells out. Past this the
// rest collapse into a count, so one session cannot grow the prompt by however
// many projects are dirty.
const FOREIGN_NAME_CAP = 5;

/** `projects/<slug>/...` → `<slug>`; everything else → null. `null` here does
 * not mean "not one project's work": the caller below folds every non-null
 * hit into a per-name foreign count and every null hit into a nameless
 * "unattributed" count, and both feed the same notice. Not the same
 * classification hypo-auto-commit.mjs's commit message uses for its own
 * "(N paths across M projects)" count (hypo-shared.mjs's private
 * `projectOfPath`): that one folds a non-`projects/` path to its first path
 * segment (`extensions`, `hot.md`, ...) for a tally; this one folds it to
 * `null` because attribution, not tallying, is the job here. A top-level
 * segment is not a project name, and this notice must not present it as
 * one.
 */
function projectOfPath(relPath) {
  const parts = relPath.split('/');
  return parts[0] === 'projects' && parts.length > 1 && parts[1] ? parts[1] : null;
}

/** Vault-relative dirty paths (tracked + untracked), normalized to be
 * relative to `hypoDir` itself via `git rev-parse --show-prefix` (empty when
 * `hypoDir` IS the repo top level), the same normalization
 * hypo-shared.mjs's `gitDirtyFiles` applies for staging correctness: without
 * it, a vault nested under a larger host repo reports paths relative to that
 * repo's top level, and every one of them would fail to classify as this
 * vault's own. NUL-separated porcelain so Korean project/page names survive
 * intact. This also re-attributes a rename/copy's `from` path (codex
 * 3rd-round review follow-up), the same as gitDirtyFiles does for
 * staging correctness, so a rename OUT of a foreign project is not silently
 * lost just because its destination happens to land under `ownProject`.
 *
 * Returns `null`, not `[]`, on any git failure (repo missing, `rev-parse` or
 * `status` non-zero, or a timeout): folding "cannot enumerate" into the same
 * empty array a truly clean repo returns would render the two identically,
 * which is the silent failure this notice exists to catch (mirrors
 * `gitDirtyFiles`'s own contract: "an empty return here just means 'cannot
 * attribute', not 'clean'"). A clean repo returns `[]`.
 */
function listDirtyPaths(hypoDir) {
  const prefixRes = spawnSync('git', ['-C', hypoDir, 'rev-parse', '--show-prefix'], {
    encoding: 'utf-8',
    timeout: FOREIGN_GIT_TIMEOUT_MS,
  });
  if (prefixRes.status !== 0) return null;
  // trimEnd(), not trim(): the prefix is a real path segment, and a leading
  // space or control char in a directory name is valid there. trim() would
  // strip it off the front, so the stripped prefix no longer matches the
  // (untouched) start of every path `git status` reports, and every path
  // under that directory would wrongly read as "outside the vault" (the
  // notice going silent for exactly the same reason a missing rename `from`
  // does below). Only the trailing `\n` `--show-prefix` always appends needs
  // stripping.
  const prefix = (prefixRes.stdout || '').trimEnd();

  const r = spawnSync('git', ['-C', hypoDir, 'status', '--porcelain', '-uall', '-z'], {
    encoding: 'utf-8',
    timeout: FOREIGN_GIT_TIMEOUT_MS,
  });
  if (r.status !== 0) return null;
  const out = [];
  const records = (r.stdout || '').split('\0');
  const toVaultRelative = (f) => {
    if (!f) return null;
    if (!prefix) return f; // hypoDir IS the repo top level, nothing to strip
    return f.startsWith(prefix) ? f.slice(prefix.length) : null; // outside the vault
  };
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3); // destination path for a rename/copy
    const isRenameOrCopy = xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C';
    // A rename/copy emits a paired `to\0from` record. Attribute BOTH: the
    // origin project lost a file just as surely as the destination gained
    // one, and dropping `from` (as this used to) silently loses that origin
    // whenever it differs from the destination's project (a rename INTO
    // ownProject from a foreign one would otherwise vanish entirely). One
    // rename/copy is therefore counted as up to 2 dirty paths, inflating
    // foreignCount/unattributedCount by one per cross-project rename; the
    // name Set below still de-dupes, so the project NAME list does not grow.
    let fromFile = null;
    if (isRenameOrCopy) {
      i++;
      fromFile = records[i] || null;
    }
    const rel = toVaultRelative(file);
    if (rel) out.push(rel);
    const relFrom = toVaultRelative(fromFile);
    if (relFrom) out.push(relFrom);
  }
  return out;
}

/** One-line notice covering two counts: uncommitted paths under a named
 * project other than `ownProject` (`projects/<slug>/...`, or, when
 * `ownProject` is null, no cwd-matched project this session, so ANY named
 * project counts), and uncommitted paths this classifier cannot attribute to
 * any project at all (everything else, root vault infra, `extensions/`,
 * `_specs/`, ...). This is attribution, not narrowing, so the
 * unattributed bucket is surfaced with a count rather than silently dropped
 * just because it has no project name to show. '' only when enumeration
 * succeeded and both counts are zero, so the quiet path stays quiet exactly
 * there. A `null` from `listDirtyPaths` (enumeration failed) gets its own
 * distinct line instead: the caller must not read "could not tell" as
 * "nothing foreign".
 */
function foreignUncommittedNotice(hypoDir, ownProject) {
  const dirty = listDirtyPaths(hypoDir);
  if (dirty === null) {
    return '[WIKI: 미커밋 변경의 귀속을 확인하지 못했습니다. git 상태를 근거로 작업 범위를 정하지 마십시오.]';
  }
  const foreignProjects = new Set();
  let foreignCount = 0;
  let unattributedCount = 0;
  for (const f of dirty) {
    const slug = projectOfPath(f);
    if (slug === ownProject) continue;
    if (slug) {
      foreignProjects.add(slug);
      foreignCount++;
    } else {
      unattributedCount++;
    }
  }
  if (foreignCount === 0 && unattributedCount === 0) return '';
  const clauses = [];
  if (foreignCount > 0) {
    // The slug comes from a directory name in `git status` output, so it is
    // untrusted text on its way into a prompt. sanitizeProjForPrompt is the same
    // guard the hot-cache notices in this file already use; skipping it here would
    // let a newline or a control char in a project directory name break the
    // one-line notice apart and inject into the surrounding context. The name list
    // is also capped, because an unbounded one grows the context by however many
    // projects happen to be dirty.
    const all = [...foreignProjects].sort();
    const shown = all.slice(0, FOREIGN_NAME_CAP).map((s) => `projects/${sanitizeProjForPrompt(s)}`);
    const names =
      all.length > FOREIGN_NAME_CAP
        ? `${shown.join(', ')} 외 ${all.length - FOREIGN_NAME_CAP}개`
        : shown.join(', ');
    clauses.push(`현재 프로젝트 외 ${names} 변경 ${foreignCount}건`);
  }
  if (unattributedCount > 0) clauses.push(`귀속 불명 변경 ${unattributedCount}건`);
  return `[WIKI: ${clauses.join(', ')}이 있습니다. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오.]`;
}

const GLOBAL_HOT = join(HYPO_DIR, 'hot.md');
const HOT_CHARS = 2000;
const STATE_CHARS = 2000;

function findProjectFiles(cwd) {
  if (!existsSync(PROJECTS_DIR)) return null;
  let realpathCwd = null;
  try {
    realpathCwd = realpathSync(cwd);
  } catch {
    realpathCwd = null;
  }
  // Two-tier match (absolute prefix, then cross-machine unique basename) so a
  // vault synced from another machine still resolves the cwd to its project.
  const proj = pickProjectByCwd(collectProjectWorkingDirs(HYPO_DIR), cwd, { realpathCwd });
  if (!proj) return null;
  const projDir = join(PROJECTS_DIR, proj);
  const hotPath = join(projDir, 'hot.md');
  const statePath = join(projDir, 'session-state.md');
  return {
    proj,
    hotPath: existsSync(hotPath) ? hotPath : null,
    statePath: existsSync(statePath) ? statePath : null,
  };
}

function extractSection(content, heading) {
  const headings = Array.isArray(heading) ? heading : [heading];
  for (const h of headings) {
    const re = new RegExp(`## ${h}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
    const m = content.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function printTerminalSummary(proj, hotContent, stateContent) {
  const nextFromState = stateContent
    ? extractSection(stateContent, SESSION_STATE_NEXT_HEADINGS)
    : null;
  const next = nextFromState ?? extractSection(hotContent ?? '', SESSION_STATE_NEXT_HEADINGS);
  const prev = hotContent
    ? (extractSection(hotContent, '직전 세션 \\([^)]+\\)') ??
      extractSection(hotContent, '직전 세션.*') ??
      extractSection(hotContent, 'Last Session.*'))
    : null;
  const lines = ['', `\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${proj}\x1b[0m`];
  if (prev) lines.push(`  prev: ${prev.split('\n')[0].replace(/^\*\*|\*\*$/g, '')}`);
  if (next) {
    lines.push('  next:');
    next
      .split('\n')
      .slice(0, 20)
      .forEach((l) => lines.push(`    ${l}`));
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  // Declared before the try so every emit branch — including the outer
  // catch — carries the same `systemMessage` (the user-visible update/sibling
  // banner). Reassigned once below after the notices are computed.
  let outExtra = { continue: true, suppressOutput: true };
  try {
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    // BLOCKER fix: serialized against every other writer of this vault
    // (hypo-auto-commit.mjs's stage+commit+sync, crystallize.mjs's apply, and
    // writeRootHotProjection below) on the SAME lock. A fast-forward pull
    // rewrites hot.md as surely as the projection writer does, so locking the
    // writer alone would just move the unguarded overwrite onto this line.
    // Not reentrant: this hold is released before the projection call below
    // takes the same lock for itself, and nothing between them holds it.
    //
    // A lock timeout leaves pullOk false, which is the same state a failed
    // pull produces: the sync-state notice stays unresolved for one more
    // session rather than being cleared on a pull that never ran.
    //
    // The `.git` check is gitPull's own precondition, hoisted out so the lock
    // is never taken for a call that cannot pull: withFileLock creates the
    // lock's parent directory, which on an install with no vault would mint
    // `.cache/` under a wiki root that does not exist.
    let pullOk = false;
    if (existsSync(join(HYPO_DIR, '.git'))) {
      try {
        pullOk = withFileLock(vaultCommitLockTarget(HYPO_DIR), () => gitPull(HYPO_DIR), {
          timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000,
        });
      } catch {
        pullOk = false;
      }
    }
    const syncLine = syncStateNotice(pullOk);
    const proposalLine = pendingProposalNotice();
    const growthLine = readLastGrowthLine();
    // On source='clear', surface the dying
    // session's identity that hypo-session-end stashed so Claude can recover
    // session-close work that /clear skipped. One-shot: marker is unlinked
    // immediately after read.
    const clearRecoveryLine = buildClearRecoveryLine(data.source);
    const updateLine = buildUpdateNotice();
    const siblingLine = buildSiblingNotice();
    const pkgDriftLine = buildPkgRootDriftNotice();
    // pkgDriftLine and pkgNullLine can never both be non-empty in the same
    // session: drift requires PKG_ROOT to have resolved (non-null) via
    // self-location, while the null notice fires exactly when it did not.
    // Listed together below on that basis, not because one is chosen over
    // the other.
    const pkgNullLine = buildPkgRootNullNotice();
    // The update + stale-sibling + pkgRoot-drift/null banners must reach the
    // USER. On a SessionStart hook that exits 0, stderr is invisible in the
    // normal TUI (only shown on exit 2 / --verbose) and additionalContext is
    // model-only — `systemMessage` is the documented user-visible channel.
    // Route those banners there. They ALSO stay in noticePrefix →
    // additionalContext below, so the model and the user start the session
    // looking at the same state. (The other stderr notices —
    // sync/growth/clear/suggest — are intentionally transcript/--verbose only
    // and out of this banner's scope.)
    const userMessage = [updateLine, siblingLine, pkgDriftLine, pkgNullLine]
      .filter(Boolean)
      .join('\n\n');
    if (userMessage) outExtra = { ...outExtra, systemMessage: userMessage };
    const notices = [
      syncLine,
      proposalLine,
      growthLine,
      clearRecoveryLine,
      updateLine,
      siblingLine,
      pkgDriftLine,
      pkgNullLine,
    ].filter(Boolean);
    let noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
    if (syncLine) process.stderr.write(`\n\x1b[33m${syncLine}\x1b[0m\n`);
    if (proposalLine) process.stderr.write(`\n\x1b[33m${proposalLine}\x1b[0m\n`);
    if (growthLine) process.stderr.write(`\n\x1b[36m${growthLine}\x1b[0m\n`);
    if (clearRecoveryLine)
      process.stderr.write(`\n\x1b[33m${clearRecoveryLine.split('\n')[0]}\x1b[0m\n`);
    if (updateLine) process.stderr.write(`\n\x1b[33m${updateLine}\x1b[0m\n`);
    if (siblingLine) process.stderr.write(`\n\x1b[33m${siblingLine}\x1b[0m\n`);
    if (pkgDriftLine) process.stderr.write(`\n\x1b[33m${pkgDriftLine}\x1b[0m\n`);
    if (pkgNullLine) process.stderr.write(`\n\x1b[33m${pkgNullLine}\x1b[0m\n`);
    const cwd = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || 'default';
    const MARKER_FILE = sessionMarkerPath(sessionId);
    const hit = findProjectFiles(cwd);

    // ownProject = the cwd-matched project (or null on a MISS, per
    // foreignUncommittedNotice's docstring). Late-appended into `notices` /
    // `noticePrefix`, same pattern the MISS branch's suggestLine uses below —
    // both need `hit` first, which isn't resolved until this line.
    const foreignNotice = foreignUncommittedNotice(HYPO_DIR, hit ? hit.proj : null);
    if (foreignNotice) {
      notices.push(foreignNotice);
      noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
      process.stderr.write(`\n\x1b[33m${foreignNotice}\x1b[0m\n`);
    }

    // Root hot.md projection. Must run AFTER gitPull (so it
    // reflects the merged tree) and BEFORE snapshotBase below (so this
    // session's base for 'hot.md' is the freshly generated bytes, not
    // whatever was on disk before this write). Also deliberately AFTER
    // foreignUncommittedNotice above: that check reads `git status` on the
    // wiki tree, and this session's OWN regeneration of hot.md is not a
    // foreign or unattributed change: running the write first would make the
    // projection's own necessary write show up in that scan and misreport as
    // one. resolveActiveProject, closeCandidateSlugs, and the HIT/MISS
    // injection later in this hook all read hot.md, so the write still has to
    // land before any of those.
    // recordTouchedPaths here is the ONLY thing that gets this write into a
    // scoped hypo-auto-commit at Stop. Without it: SessionStart writes fresh
    // bytes, Stop's own rebuild sees disk already equals the projection
    // (writeRootHotProjection's no-op branch) and records nothing touched, and
    // hypo-auto-commit only ever commits its touched-paths set, so the write
    // this hook just made would never be staged or committed by ANY path, and
    // would sit as an unattributable dirty file (closeFileTargetsGlobal scopes
    // hot.md as close-owned; classifyForeignOnlyDirty cannot demote it to
    // foreign) blocking both the close gate and PreCompact. TODO(wave 3): this
    // whole call disappears the moment hot.md comes out of overwriteTargets /
    // the commit path, since a projection target no longer needs a commit.
    //
    // The touched-paths record is claimed BEFORE the write, not after: it is
    // itself best-effort (a lock timeout can fail it), and recording it after
    // the fact means a failure there leaves a real disk write with nothing in
    // any session's touched-paths set, the exact orphan this comment already
    // described, just moved from "Stop's rebuild is a no-op" to "the record
    // call itself failed." Claiming it first and skipping the write on a
    // failed claim means hot.md is never rewritten without something able to
    // account for that rewrite at close time.
    if (existsSync(HYPO_DIR)) {
      // claimProjectionWrite, not recordTouchedPaths: a missing session_id
      // must read as "not claimed" here, unlike every other best-effort
      // accumulate call, or this write proceeds with nothing able to ever
      // bring it into a commit (see claimProjectionWrite's own doc comment).
      const claimed = claimProjectionWrite(HYPO_DIR, data.session_id, ['hot.md']);
      if (!claimed.ok) {
        const msg =
          '루트 hot.md 갱신을 건너뛰었습니다: 이번 세션의 커밋 범위에 기록하지 못해 갱신 후 미커밋 파일로 남을 수 있었습니다.';
        notices.push(msg);
        noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
        outExtra = {
          ...outExtra,
          systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
        };
        process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
      } else {
        try {
          // n1 fix: pass session_id so this session's own digest lands in
          // ITS OWN receipt, not just the shared global ownership record --
          // see writeRootHotProjection's doc comment.
          const result = writeRootHotProjection(HYPO_DIR, undefined, data.session_id);
          if (result.lockTimeout) {
            // BLOCKER fix, the other half: the projection writer now holds the
            // vault lock, so a vault busy with another session's commit can
            // leave this session on the previous pointer table. Say so instead
            // of starting the session on a stale table with no explanation,
            // and drop the pre-write claim: no write happened, so an
            // uncleared 'hot.md' claim would later sweep in whatever the
            // session that DID hold the lock wrote. Only when THIS call is
            // the one that added the claim: a resumed session_id whose
            // earlier SessionStart already claimed 'hot.md' (still
            // unresolved from that run) must not have its own claim erased
            // by this run's failure.
            if (claimed.added) clearTouchedPaths(HYPO_DIR, data.session_id, ['hot.md']);
            const msg =
              '루트 hot.md 를 갱신하지 못했습니다: 다른 세션이 이 저장소를 쓰는 중이라 잠금을 얻지 못했습니다. 이번 세션은 이전 포인터 표를 그대로 읽습니다 (다음 세션 시작이나 종료 때 다시 시도합니다).';
            notices.push(msg);
            noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
            outExtra = {
              ...outExtra,
              systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
            };
            process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
          } else if (result.scanError) {
            const msg =
              '루트 hot.md 갱신 실패: projects/ 디렉터리를 읽을 수 없어 이전 파일을 그대로 두었습니다.' +
              ` 권한과 경로를 확인하고(\`ls -ld ${join(HYPO_DIR, 'projects')}\`), 고치면 다음 세션 시작이나 종료 때 자동으로 다시 시도합니다.`;
            notices.push(msg);
            noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
            outExtra = {
              ...outExtra,
              systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
            };
            process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
          } else if (result.warnings.length > 0) {
            // major-1/3: a per-project read failure no longer disappears
            // silently: it kept its row (blank date) in the table already
            // written above, but the reason must still reach a human.
            const msg =
              `루트 hot.md 갱신 중 일부 프로젝트를 읽지 못했습니다:\n${result.warnings.join('\n')}\n` +
              '해당 파일의 권한과 경로를 확인하면 다음 세션 시작이나 종료 때 자동으로 다시 읽습니다.';
            notices.push(msg);
            noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
            outExtra = {
              ...outExtra,
              systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
            };
            process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
          }
          if (result.gitignoreUpdated) {
            // Best-effort: the gitignore change itself already landed on
            // disk (writeRootHotProjection would have thrown otherwise); a
            // failure to also claim it only risks THIS one infra file
            // showing up as an unattributed dirty file at close, not the
            // backup it protects (which is gitignored either way).
            const gClaimed = recordTouchedPaths(HYPO_DIR, data.session_id, ['.gitignore']);
            if (!gClaimed) {
              process.stderr.write(
                '[hypo-session-start] .gitignore 갱신(백업 유출 방지 패턴)을 커밋 범위에 기록하지 못했습니다\n',
              );
            }
          }
          if (result.backedUp && result.backupPath) {
            // MAJOR fix: the backup itself was never in question (it lands
            // on disk and is gitignored either way), only whether a human
            // ever learns it exists. Before this, `backedUp`/`backupPath`
            // reached neither `notices` nor `systemMessage`: the backup file
            // is gitignored, so it does not even show up in `git status`, and
            // a person who had just hand-edited root hot.md would see their
            // edit silently replaced with no trace of where it went. Naming
            // only the file (basename), not its full path: the vault root is
            // already implied by the session, and nothing else here leaks a
            // full filesystem path into a notice. This branch should be rare
            // once rootHot leaves the close payload/overwrite targets: with
            // no scripted writer left that targets this file, a backup only
            // happens when a person edits it by hand, so this notice does
            // not become noise on every session.
            // Naming the file is not a recovery path on its own: copying the
            // backup back onto root hot.md just gets it replaced again on the
            // next rebuild. rootHotBackupRecoveryNotice (hooks/hypo-shared.mjs)
            // is the one sentence that says what actually recovers the
            // content, shared with the Stop-hook rebuild and project-create so
            // the three writers cannot drift into different wordings.
            const msg = rootHotBackupRecoveryNotice(result.backupPath);
            notices.push(msg);
            noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
            outExtra = {
              ...outExtra,
              systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
            };
            process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
          }
        } catch (err) {
          // BLOCKER fix: writeRootHotProjection now throws instead of
          // silently treating an unreadable existing hot.md as absent, so
          // this session's own pre-claim above is stale: no write actually
          // happened. Clear it: an uncleared 'hot.md' claim left in this
          // session's touched-paths set would sweep in whatever ANOTHER
          // session or a human writes to hot.md next as if this session had
          // made that change. Only when THIS call is the one that added the
          // claim (see the lockTimeout branch above for why).
          if (claimed.added) clearTouchedPaths(HYPO_DIR, data.session_id, ['hot.md']);
          // catch-message-accuracy fix (r5-w1.md): writeRootHotProjection can
          // throw from several different steps here (reading the existing
          // file, writing the migration backup, updating .gitignore, or the
          // final atomic write itself), not only a read failure: wording
          // this as "읽을 수 없어" (could not read) misnamed a disk-full or
          // backup-write failure as something it was not. What stays true
          // regardless of which step failed is that the atomic write never
          // ran, so the old file is untouched.
          const msg = `루트 hot.md 갱신에 실패해 이전 파일을 그대로 두었습니다: ${err?.message ?? String(err)}`;
          notices.push(msg);
          noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
          outExtra = {
            ...outExtra,
            systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
          };
          process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
        }
      }
    }

    // A prior Stop's rebuild may have failed invisibly (its own stdout is
    // suppressed) and left a note for the next SessionStart to show. One-shot:
    // consumed (and deleted) the moment it is read, so it surfaces exactly
    // once instead of repeating on every future session.
    const staleProjectionNotice = consumeRootHotHealthNotice(HYPO_DIR);
    if (staleProjectionNotice) {
      notices.push(staleProjectionNotice);
      noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
      outExtra = {
        ...outExtra,
        systemMessage: [outExtra.systemMessage, staleProjectionNotice].filter(Boolean).join('\n\n'),
      };
      process.stderr.write(`\n\x1b[33m${staleProjectionNotice}\x1b[0m\n`);
    }

    // Observed-base snapshot for the write=proposal gate. Deliberately AFTER gitPull: the base must
    // describe the tree this session actually starts from, remote merges
    // included, or the first close would raise a proposal against content the
    // session never had a chance to conflict with. Once per session
    // (existence-check inside snapshotBase), so resume and compact leave it
    // alone. `data.session_id` is used raw rather than the 'default' fallback
    // above. A session with no id has no base and closes down the legacy
    // direct-write path.
    //
    // Only the root-only targets (hot.md, open-questions.md) are snapshotted
    // HERE, unconditionally. They carry no .hypoignore/visibility gate of
    // their own, so hashing them before any injection decision costs
    // nothing a later read would have refused anyway. The current project's
    // OWN two targets (hit.proj's hot.md / session-state.md) used to be
    // snapshotted right here too, blind to whether the HIT branch below was
    // about to actually show them (review r4-w4 major 3): that let a
    // .hypoignore'd or machine-scoped-out project target mint a "clean" base
    // from bytes this session was never shown a single line of, and for a
    // LATE HIT (this session's cwd only resolves to a project on a later
    // resume/compact, not its first SessionStart), that base came from
    // whatever was on disk at that arbitrary later moment, with no relation
    // to what injection actually revealed. Enrollment for those two moved
    // down to right after the HIT branch's own reads decide that question
    // (see the call there).
    if (data.session_id) {
      snapshotBase(HYPO_DIR, data.session_id, overwriteTargets(null));
      // Bumps the observed generation on EVERY SessionStart (first run and
      // resume/compact alike), before the injections below record into it. A
      // resume that ends up injecting nothing (ignored, scoped out, absent)
      // still bumps, which is what lets a stale observation from an earlier
      // resume expire instead of staying licensed for the rest of the session.
      beginObservedGeneration(HYPO_DIR, data.session_id);
    }

    const ignorePatterns = loadHypoIgnore(HYPO_DIR);

    // When cwd is a project working_dir that is NOT the vault itself, tell the
    // AI where the vault lives so it does not re-discover the path or look for
    // wiki files in the code repo. '' when cwd === vault root.
    const vaultOrientation = hit ? buildVaultOrientation(cwd) : '';
    const hitPrefix = vaultOrientation ? `${vaultOrientation}\n\n` : '';

    if (hit) {
      // project hot/state only. root/global hot (below) is a derived pointer
      // table with no per-page frontmatter, so it is never a STALE target and
      // gets no marker logic. TODAY is UTC to match doctor.mjs (D1/D2). The
      // marker is computed on raw content (staleMarkerForPath), then prepended
      // onto the sliced display content; a no-op when there is no verify_by_date.
      const TODAY = new Date().toISOString().slice(0, 10);
      const hotRead = readIfNotIgnored(hit.hotPath, HOT_CHARS, ignorePatterns);
      const stateRead = readIfNotIgnored(hit.statePath, STATE_CHARS, ignorePatterns);
      // Enroll THIS project's two overwrite targets now, right next to the
      // reads that just decided whether this session is actually about to be
      // shown them (review r4-w4 major 3: see the top-of-hook snapshotBase
      // call's comment for why this moved here instead of running blind
      // before this decision existed). A target `readIfNotIgnored` refused
      // (.hypoignore, machine-scoped-out) but that still exists on disk is
      // left OUT of `relPaths` on purpose: `snapshotBase` would otherwise
      // hash it anyway (it re-reads disk itself, not these `Read`s) and mint
      // a base from bytes this session was never shown, so the key stays
      // 'unknown' and this session's closes keep failing safe on it, same as
      // before late enrollment existed. A target genuinely absent on disk
      // (no file yet) is still safe to enroll as `null` (nothing was hidden
      // from anyone, there is simply nothing there yet), so `existsSync`
      // lets that case through even though `readIfNotIgnored` also returns
      // null for it.
      //
      // `knownHashes` (review r5-w3 blocker 1): the root-only snapshotBase
      // call above (line ~999) always creates base.json before this HIT
      // branch runs, so this call would otherwise ALWAYS take snapshotBase's
      // "enroll" branch and hash `hit.hotPath`/`hit.statePath` off disk again,
      // a SEPARATE read from `hotRead`/`stateRead` above. A writer landing in
      // that window mints a base from bytes this session was never shown, and
      // a later close built from `hotRead.raw`/`stateRead.raw` reads
      // disk-equals-base and overwrites that writer's change with no park.
      // Passing the hash of the bytes `hotRead`/`stateRead` ALREADY read pins
      // the base to what this session was actually shown, not to whatever a
      // second, independent read happens to find.
      if (data.session_id) {
        // Test-only barrier, the other half of the enroll probe below. The
        // dump alone catches a call that drops `knownHashes`, but not one
        // that re-reads disk here and hashes that: with nothing changing the
        // file, the re-read and the shown bytes agree. When
        // HYPO_TEST_ENROLL_BARRIER is a non-empty string, the hook says so on
        // stderr and waits until that path exists (10s at most), which gives
        // a test the gap between the reads above and the hashing below to
        // change the file in. It only waits and reads: it writes no file,
        // inside the vault or out, for the reason the dump comment gives.
        const barrier = process.env.HYPO_TEST_ENROLL_BARRIER;
        if (typeof barrier === 'string' && barrier.length > 0) {
          process.stderr.write('[hypo-test] enroll-barrier-ready\n');
          const deadline = Date.now() + 10000;
          while (!existsSync(barrier) && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
        }
        const relPaths = [];
        const knownHashes = {};
        const hotRelPath = join('projects', hit.proj, 'hot.md');
        const stateRelPath = join('projects', hit.proj, 'session-state.md');
        if (hotRead) {
          relPaths.push(hotRelPath);
          knownHashes[hotRelPath] = hashContent(hotRead.raw);
        } else if (!existsSync(hit.hotPath)) {
          relPaths.push(hotRelPath);
          knownHashes[hotRelPath] = null; // observed-absent, not unread
        }
        if (stateRead) {
          relPaths.push(stateRelPath);
          knownHashes[stateRelPath] = hashContent(stateRead.raw);
        } else if (!existsSync(hit.statePath)) {
          relPaths.push(stateRelPath);
          knownHashes[stateRelPath] = null;
        }
        // Test-only wiring probe (review r5-w4 blocker 1,
        // tests/proposal-base.test.mjs). It replaced a seam that wrote
        // `process.env.HYPO_TEST_RACE_HOT_WRITE` straight into `hit.hotPath`
        // to fake a concurrent writer: every file under hooks/ is copied into
        // every install, that path is a real person's project hot.md, and the
        // guard was `!== undefined`, so an empty value truncated the file to
        // zero bytes. Nothing here writes inside the vault any more.
        //
        // What is left is the half the seam was actually needed for. Whether
        // `snapshotBase` honors a hash it is told is a property of
        // `snapshotBase`, and a direct unit test covers it; whether THIS call
        // site hands it the hashes of the bytes it just showed is only
        // observable here, and dropping the argument leaves every other
        // real-hook test green (with no writer in the gap, a fresh disk read
        // and the shown bytes agree). So when HYPO_TEST_ENROLL_DUMP names a
        // path, the arguments this call actually passes are written there as
        // JSON, and a test reads them back. `args`, not the local
        // `knownHashes`: reading the local would report the map as passed even
        // when the call below stopped passing it, which is precisely the
        // regression this exists to catch. An argument list of three shows up
        // as `argc: 3` with no `knownHashes` key at all.
        //
        // Best-effort, like every other cache write in these hooks: a bad
        // dump path must not take down a SessionStart.
        const enroll = (...args) => {
          const dumpPath = process.env.HYPO_TEST_ENROLL_DUMP;
          if (dumpPath) {
            try {
              writeFileSync(
                dumpPath,
                JSON.stringify({ argc: args.length, relPaths: args[2], knownHashes: args[3] }),
              );
            } catch {
              // ignore: the probe is diagnostics, never a precondition
            }
          }
          return snapshotBase(...args);
        };
        if (relPaths.length) enroll(HYPO_DIR, data.session_id, relPaths, knownHashes);
      }
      let hotContent = hotRead ? hotRead.shown : null;
      let stateContent = stateRead ? stateRead.shown : null;
      const hotMarker = staleMarkerForPath(hit.hotPath, ignorePatterns, TODAY);
      const stateMarker = staleMarkerForPath(hit.statePath, ignorePatterns, TODAY);
      if (hotContent && hotMarker) hotContent = `${hotMarker}\n${hotContent}`;
      if (stateContent && stateMarker) stateContent = `${stateMarker}\n${stateContent}`;

      if (hotContent || stateContent) {
        printTerminalSummary(hit.proj, hotContent, stateContent);
        writeFileSync(
          MARKER_FILE,
          JSON.stringify({
            proj: hit.proj,
            hotPath: hit.hotPath,
            statePath: hit.statePath,
            hasSnapshot: true,
            ts: Date.now(),
          }),
        );
        const parts = [];
        if (hotContent) parts.push(`[HOT]\n${hotContent}`);
        if (stateContent) parts.push(`[SESSION STATE — 다음 작업]\n${stateContent}`);
        console.log(
          JSON.stringify(
            buildOutput(
              'SessionStart',
              `${noticePrefix}${hitPrefix}[WIKI HOT CACHE: project=${sanitizeProjForPrompt(hit.proj)}]\n\n${parts.join('\n\n')}`,
              outExtra,
            ),
          ),
        );
        // Observed-set record: this is the actual injection point, so this is
        // where "this session was SHOWN these bytes" becomes true. Recorded
        // AFTER the marker write and the console.log above (fail-open
        // ordering): if this throws, the model has already been shown the
        // bytes above but no observed-entry lands, so the guard just fails
        // safe into a park later, rather than the reverse — an entry on disk
        // claiming an observation the injection never actually emitted.
        // Gated on `hotContent`/`stateContent` (the same predicate that put
        // each into `parts` above), not on `hotRead`/`stateRead` alone: an
        // empty-but-not-ignored file makes `hotRead` a truthy `{raw:'',
        // shown:''}`, and recording against that would create an observed
        // entry for bytes the model was never actually shown a line of.
        // Hash `.raw` (the full file this call just read), never a fresh
        // `readFileSync` here — that would credit a write landing between the
        // read above and this line to an observation that never happened.
        if (data.session_id) {
          if (hotContent) {
            recordObserved(
              HYPO_DIR,
              data.session_id,
              join('projects', hit.proj, 'hot.md'),
              hashContent(hotRead.raw),
              hotRead.raw.length > HOT_CHARS,
            );
          }
          if (stateContent) {
            recordObserved(
              HYPO_DIR,
              data.session_id,
              join('projects', hit.proj, 'session-state.md'),
              hashContent(stateRead.raw),
              stateRead.raw.length > STATE_CHARS,
            );
          }
        }
      } else {
        // A snapshot that exists but is scoped to another machine must not be
        // reported as "no snapshot yet": the model would treat a resumed project
        // as a first session. Say which it is, and say nothing of the contents.
        const scopedOut =
          isScopedOut(hit.hotPath, ignorePatterns) || isScopedOut(hit.statePath, ignorePatterns);
        const reason = scopedOut ? 'snapshot scoped to another machine' : 'no snapshot yet';
        process.stderr.write(
          `\n\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${hit.proj}\x1b[0m (${reason})\n\n`,
        );
        // Carry the reason into the marker, not just this hook's output.
        // hypo-first-prompt derives its resume line from the marker alone, so a
        // marker that says only `hotPath: null` makes the NEXT prompt announce
        // "first session" for a project that merely belongs to another machine.
        // That lie is what invites the model to author a fresh hot.md over one
        // that already exists elsewhere.
        writeFileSync(
          MARKER_FILE,
          JSON.stringify({ proj: hit.proj, hotPath: null, scopedOut, ts: Date.now() }),
        );
        console.log(
          JSON.stringify(
            buildOutput(
              'SessionStart',
              `${noticePrefix}${hitPrefix}[WIKI HOT CACHE: project=${sanitizeProjForPrompt(hit.proj)}, ${reason}]`,
              outExtra,
            ),
          ),
        );
      }
      return;
    }

    // MISS: cwd matches no project. Offer to create one
    // when the trigger conditions hold (git repo + project marker + no
    // cooldown + not previously declined). The actual scaffold is the LLM's
    // job on a "Y" reply (scripts/lib/project-create.mjs); the hook only nudges.
    if (shouldSuggestProjectCreation(cwd, HYPO_DIR)) {
      const suggestLine = buildProjectSuggestionLine(cwd);
      notices.push(suggestLine);
      noticePrefix = `${notices.join('\n\n')}\n\n`;
      recordSuggestionCooldown(HYPO_DIR, cwd);
      process.stderr.write(`\n\x1b[33m${suggestLine}\x1b[0m\n`);
    }

    if (!existsSync(GLOBAL_HOT)) {
      const notice = notices.join('\n\n');
      if (notice) {
        console.log(JSON.stringify(buildOutput('SessionStart', notice, outExtra)));
      } else {
        console.log(JSON.stringify(outExtra));
      }
      return;
    }

    const globalRead = readIfNotIgnored(GLOBAL_HOT, HOT_CHARS, ignorePatterns);
    const globalContent = globalRead ? globalRead.shown : null;
    if (!globalContent) {
      // GLOBAL_HOT exists but is empty or .hypoignore'd — still surface any
      // pending notices (sync state, growth, AND the auto-project offer), which
      // would otherwise be silently dropped here.
      const notice = notices.join('\n\n');
      if (notice) {
        console.log(JSON.stringify(buildOutput('SessionStart', notice, outExtra)));
      } else {
        console.log(JSON.stringify(outExtra));
      }
      return;
    }
    console.log(
      JSON.stringify(
        buildOutput(
          'SessionStart',
          `${noticePrefix}[WIKI HOT CACHE: global — no project matched cwd=${cwd}]\n\n${globalContent}`,
          outExtra,
        ),
      ),
    );
    // Observed-set record: the MISS branch's root hot.md injection is the one
    // place a project-less session observes anything at all. Recorded AFTER
    // the console.log above. See the HIT branch's comment for why (fail-open
    // ordering). Hashes `.raw`, not a fresh disk read, for the same reason
    // given there.
    //
    // This call records nothing any more. overwriteTargets() stopped returning
    // 'hot.md' when the root pointer table became a hook-generated projection,
    // and recordObserved only writes for keys the base snapshot is tracking, so
    // the guard rejects this one every time. It is kept here, rather than
    // deleted, because this file is being rewritten in another lane at the same
    // time and a deletion would widen that merge. Delete it when the two lanes
    // land together.
    if (data.session_id) {
      recordObserved(
        HYPO_DIR,
        data.session_id,
        'hot.md',
        hashContent(globalRead.raw),
        globalRead.raw.length > HOT_CHARS,
      );
    }
  } catch (err) {
    process.stderr.write(`[hypo-session-start] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify(outExtra));
  }
});
