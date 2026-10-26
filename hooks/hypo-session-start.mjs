#!/usr/bin/env node
/**
 * hypo-session-start.mjs — SessionStart hook
 *
 * On session start, in this order: pull (and catch up to a migrated remote), finish a leftover
 * pull archive, move a remote-less vault to session entries (or tell the user why not), write the
 * root `hot.md`, then
 *   HIT  → cwd matches a project's working_dir → inject that project's heads, built in memory
 *          from its session entries (4000 chars), then write its two generated views
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
  consumeRootHotHealthNotice,
  isUntrackedLockArtifact,
  incomingChangesViewTracking,
  migrationState,
  projectHiddenByHypoignore,
  resumePullArchive,
  setAsideNotices,
  upstreamIsMigrated,
  vaultHasNoGit,
  stampSessionRecord,
} from './hypo-shared.mjs';
import { buildInjection, entryVisible, isBaselineId, nextUpItems } from './session-entries.mjs';
import {
  MIGRATION_START_DEADLINE_MS,
  fastForwardTo,
  loadSessionModel,
  migrateVaultToSessionEntries,
  recordObservedHeads,
  writeGeneratedViews,
} from './session-views.mjs';
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
import { snapshotBase, overwriteTargets, beginObservedGeneration } from './base-store.mjs';
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

// The STALE marker of an old hot/state file's text (each baseline entry carries one file whole,
// frontmatter included), or '' for no verify_by_date, an unparseable one, or an error: the derived summaries of
// later entries carry no such field and pass through unchanged.
function staleMarkerForText(text, today) {
  try {
    return text ? staleMarkerFor(text, today) : '';
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
    `(close payload로 원본 기록).`
  );
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
// A path-prefix signal of the same kind the close gate used to compute for
// its own git check. The gate now judges that axis by the session's
// touched-paths record instead (hypo-shared.mjs), so this notice is no longer
// the same judgment as the gate's. It is surfaced here for the AGENT
// reading additionalContext: a project this session isn't scoped to may
// still have uncommitted changes sitting in the shared vault, and without
// this line the agent has no way to tell those apart from its own
// unfinished work. Cannot import hypo-shared.mjs's
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
    // A live close's `.lock` (or a waiter's staging file) is not work to attribute.
    const rel = toVaultRelative(file);
    if (rel && !isUntrackedLockArtifact(xy, rel)) out.push(rel);
    const relFrom = toVaultRelative(fromFile);
    if (relFrom && !isUntrackedLockArtifact(xy, relFrom)) out.push(relFrom);
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

// Characters of project context the hook injects (the old pair of 2000-character files).
const INJECTION_BUDGET = 4000;

// `{state, date}` of the last session-entries notice shown: the same state on the same day is not
// shown again (`.cache/session-entries-notice.json`, see `announceOncePerDay`).
const NOTICE_REL = join('.cache', 'session-entries-notice.json');

const REMOTE_NOT_MIGRATED_NOTICE =
  '이 볼트는 아직 옛 세션 현황 형식입니다. 같은 볼트를 쓰는 모든 기계를 이 버전 이상으로 올린 뒤, ' +
  '한 기계에서 `/hypo:upgrade --migrate-sessions`를 한 번 실행하세요. 그 전까지 이 기계의 close는 ' +
  '원본만 쓰고, 파일로 보는 현황(`hot.md`, `session-state.md`)은 갱신되지 않습니다.';

const OPTED_OUT_NOTICE =
  '이 볼트는 세션 원본 형식을 끈 상태(롤백)입니다. 평면 파일은 롤백 지점 이후 구버전 기계의 쓰기까지 ' +
  '포함합니다. 같은 내용이 원본과 평면 파일에서 두 번 보일 수 있습니다. 다시 켜려면 ' +
  '`/hypo:upgrade --migrate-sessions`를 실행하세요.';

const DEADLINE_NOTICE =
  '이번 세션은 시간이 부족해 이행을 다음 세션으로 미뤘습니다. 그 세션은 이행 전 동작을 합니다.';

// The clock of this run. A test sets HYPO_TEST_NOW (an ISO time) to fix the first reading and
// HYPO_TEST_NOW_STEP_MS to move each later reading on by that much, which is how a spawned hook
// is made to pass the migration start deadline or to see another calendar day. Unset, it is the
// real clock. It only reads two environment variables and writes nothing.
function makeClock() {
  const start = Date.parse(process.env.HYPO_TEST_NOW ?? '');
  if (Number.isNaN(start)) return () => Date.now();
  const step = Number(process.env.HYPO_TEST_NOW_STEP_MS) || 0;
  let reads = 0;
  return () => start + step * reads++;
}

function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A record that cannot be read counts as "not shown yet": more notices, never fewer.
function sessionNoticeDue(state, day) {
  try {
    const rec = JSON.parse(readFileSync(join(HYPO_DIR, NOTICE_REL), 'utf-8'));
    return !(rec && rec.state === state && rec.date === day);
  } catch {
    return true;
  }
}

function recordSessionNotice(state, day) {
  try {
    atomicWrite(join(HYPO_DIR, NOTICE_REL), JSON.stringify({ state, date: day }));
  } catch {
    // best-effort: a failed record only means the notice shows again
  }
}

const vaultGit = (args) =>
  spawnSync('git', ['-C', HYPO_DIR, ...args], { encoding: 'utf-8', timeout: 10000 });

// A vault with any remote never moves itself: another machine may still run the old scheme. When
// git cannot say, assume a remote.
function vaultHasRemote() {
  const r = vaultGit(['remote']);
  return r.status !== 0 || (r.stdout || '').trim() !== '';
}

/**
 * With the upstream fetched: when it is ahead of HEAD (HEAD is its ancestor) and taking it in
 * changes how the generated views are tracked (a migration commit, a rollback commit, or the
 * `.gitignore` block arriving), move HEAD there with `fastForwardTo`, which sets aside what would
 * block the merge or be overwritten without a word and puts it back if the merge fails. A plain
 * fast-forward is not enough for these commits: it deletes a clean view of a project `.hypoignore`
 * hides with no copy, and a rollback commit overwrites an ignored local file. A diverged history
 * is left to the Stop hook's pull. Returns whether it handled the range (moved or refused); after
 * a refusal the caller must not fall back to a plain merge, which would do the unsafe thing.
 * Records into `out`: `pullOk`, `notices`, `announced` (backup paths already named in a notice, so
 * the archive resume does not name them twice).
 */
function catchUpToUpstream(out) {
  const target = (
    vaultGit(['rev-parse', '--verify', '--quiet', '@{u}^{commit}']).stdout || ''
  ).trim();
  const head = (
    vaultGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).stdout || ''
  ).trim();
  if (!target || !head || target === head) return false;
  if (vaultGit(['merge-base', '--is-ancestor', 'HEAD', target]).status !== 0) return false;
  // Enter when the range itself changes how views are tracked, or when the remote has moved and
  // this vault has not: `upstreamIsMigrated` stays true for good once the remote moved, so on its
  // own it would send every ordinary pull of a migrated vault through the catch-up and report a
  // dirty file as a missed migration commit.
  if (
    !incomingChangesViewTracking(HYPO_DIR, target) &&
    !(upstreamIsMigrated(HYPO_DIR) && migrationState(HYPO_DIR) !== 'migrated')
  ) {
    return false;
  }
  const moved = fastForwardTo(HYPO_DIR, target);
  if (!moved.ok) {
    out.notices.push(
      `원격의 세션 현황 이행 커밋을 받지 못했습니다: ${moved.notice ?? moved.reason ?? 'unknown'}`,
    );
    return true;
  }
  out.pullOk = true;
  recordSyncSuccess(HYPO_DIR, 'pull');
  const { localOnly, unowned, cleared } = moved.pre;
  out.announced.push(...[...localOnly, ...unowned, ...cleared].map((v) => v.backupPath));
  out.notices.push(...setAsideNotices(HYPO_DIR, moved.pre));
  return true;
}

/**
 * `pull --ff-only` in two steps, so a migration or rollback range can be told apart before it
 * lands: fetch, catch up when the range changes view tracking, else fast-forward to the upstream.
 * When the fetch fails (no remote, offline) the pull is not tried: it would reach the same remote
 * and fail the same way, after another timeout.
 */
function pullVault(out) {
  if (vaultGit(['fetch', '--quiet']).status !== 0) {
    out.pullOk = false;
    return;
  }
  if (catchUpToUpstream(out)) return;
  out.pullOk = vaultGit(['merge', '--ff-only', '--quiet', '@{u}']).status === 0;
  if (out.pullOk) recordSyncSuccess(HYPO_DIR, 'pull');
}

/**
 * Everything that moves the vault's history at session start, under the vault commit lock: the
 * pull (with the catch-up to a migrated or rolled-back upstream), and the finish of a pull archive
 * an earlier run left after its merge (independent of the migration state). Returns
 * `{pullOk, notices}`. A lock that cannot be had leaves `pullOk` false, like a failed pull.
 */
function syncVault() {
  const out = { pullOk: false, notices: [], announced: [] };
  // The archive resume needs only a repository somewhere above the vault (a vault in a
  // subdirectory of one has no `.git` of its own); the pull needs the vault's own `.git`. A vault
  // that does not exist gets neither: the lock would create `.cache/` under a missing root.
  if (!existsSync(HYPO_DIR) || vaultHasNoGit(HYPO_DIR)) return out;
  const ownGit = existsSync(join(HYPO_DIR, '.git'));
  try {
    withFileLock(
      vaultCommitLockTarget(HYPO_DIR),
      () => {
        try {
          if (ownGit) pullVault(out);
        } catch (err) {
          out.notices.push(`원격 변경을 받는 중 실패했습니다: ${err?.message ?? err}`);
        }
        try {
          out.notices.push(...resumePullArchive(HYPO_DIR, { announced: out.announced }).notices);
        } catch (err) {
          out.notices.push(`남은 보관 기록을 처리하지 못했습니다: ${err?.message ?? err}`);
        }
      },
      { timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000 },
    );
  } catch {
    // lock timeout or a failure outside the steps above: pullOk keeps what it had
  }
  return out;
}

/**
 * What one project's SessionStart injection is made of, built in memory from its session entries
 * (before the migration the model holds a virtual baseline of the old files, so nothing here reads
 * a generated view file). `{hidden: true}` for a project `.hypoignore` hides. Otherwise `{text,
 * observed, markers, items, hasSnapshot, scopedOut}`: `hasSnapshot` is whether this machine can see any
 * entry, `scopedOut` whether entries exist that only another machine can.
 */
function projectInjection(proj, state, patterns) {
  if (projectHiddenByHypoignore(HYPO_DIR, proj, patterns)) return { hidden: true };
  const device = currentDevice();
  const model = loadSessionModel(HYPO_DIR, proj, { state, localOld: true });
  const injection = buildInjection(model, INJECTION_BUDGET, { device });
  const seen = model.entries.filter((e) => entryVisible(model, e, device));
  // An entry file that cannot be read is not an absent one. Only the count is told: a hidden file's
  // name is not for the model. With nothing else readable the project is not called a first session.
  const unreadable = model.unreadable.length;
  if (unreadable > 0 && seen.length === 0) return { unavailable: true };
  const items = nextUpItems(model, { device });
  // TODAY is UTC to match doctor.mjs. The old files' dates survive in the baseline entries: the
  // summary of the hot baseline is the old `hot.md`, the frontmatter of the state baseline's
  // `legacy` head the old `session-state.md`.
  const today = new Date().toISOString().slice(0, 10);
  const markers = [
    seen
      .filter((e) => isBaselineId(e.closeId))
      .map((e) => staleMarkerForText(e.summary, today))
      .find(Boolean),
    items.map((i) => staleMarkerForText(i.legacyFrontmatter, today)).find(Boolean),
  ].filter(Boolean);
  const warning =
    unreadable > 0
      ? `[주의: 세션 원본 ${unreadable}개를 읽지 못해 아래 현황에 빠졌을 수 있습니다. 이 프로젝트를 첫 세션으로 단정하지 마세요. /hypo:doctor로 확인할 수 있습니다.]\n\n`
      : '';
  return {
    text: warning + injection.text,
    observed: injection.observed,
    markers,
    items,
    hasSnapshot: seen.length > 0,
    scopedOut: seen.length === 0 && model.entries.length > 0,
  };
}

// The head titles and bodies come from the model, not from a re-parse of the rendered markdown (a
// baseline's body can hold `##` lines of its own).
function printTerminalSummary(proj, items) {
  const lines = ['', `\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${proj}\x1b[0m`];
  if (items.length) {
    lines.push('  next:');
    items
      .flatMap((i) => [`${i.title} (${i.date})`, ...i.body.split('\n')])
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
  // Declared before the try so every emit branch, including the outer
  // catch, carries the same `systemMessage` (the user-visible update/sibling
  // banner). Reassigned once below after the notices are computed.
  let outExtra = { continue: true, suppressOutput: true };
  try {
    const clock = makeClock();
    const startedAt = clock();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    // Serialized against every other writer of this vault (hypo-auto-commit.mjs's
    // stage-and-commit-and-sync, crystallize.mjs's apply, the generated-view writer) on the SAME
    // lock: a fast-forward pull rewrites tracked files as surely as the view writer does. The lock
    // is released before the writers below take it for themselves; it is not reentrant.
    // A lock timeout leaves pullOk false, the state a failed pull produces: the sync-state notice
    // stays unresolved for one more session rather than being cleared on a pull that never ran.
    // The vault checks in syncVault are its own precondition: withFileLock creates the lock's parent
    // directory, which on an install with no vault would mint `.cache/` under a wiki root that
    // does not exist.
    const sync = syncVault();
    const pullOk = sync.pullOk;
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
    // model-only: `systemMessage` is the documented user-visible channel.
    // Route those banners there. They ALSO stay in noticePrefix →
    // additionalContext below, so the model and the user start the session
    // looking at the same state. (The other stderr notices
    // sync/growth/clear/suggest are intentionally transcript/--verbose only
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

    // A notice the user must see (systemMessage) and the model should know (additionalContext).
    // A line already shown this start is not shown again: the migration's own notices and the
    // pending health notice name the same backup.
    const shownLines = new Set();
    const surface = (text) => {
      const msg = text
        .split('\n')
        .filter((l) => l.trim() === '' || !shownLines.has(l))
        .join('\n')
        .trim();
      for (const l of text.split('\n')) shownLines.add(l);
      if (!msg) return;
      notices.push(msg);
      noticePrefix = `${notices.join('\n\n')}\n\n`;
      outExtra = {
        ...outExtra,
        systemMessage: [outExtra.systemMessage, msg].filter(Boolean).join('\n\n'),
      };
      process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
    };
    for (const msg of sync.notices) surface(msg);

    // The vault's move to session entries. A vault with a remote is never moved from here, however
    // far along the others are; the one without a remote moves unless the hook already used up
    // its start allowance. A notice about the state shows once per state and local day.
    let state = existsSync(HYPO_DIR) ? migrationState(HYPO_DIR) : 'migrated';
    const day = localDay(startedAt);
    // The record is written after the foreign-change scan below, which would otherwise count the
    // record file itself in a vault that does not ignore `.cache/`.
    const shownKeys = [];
    const announceOncePerDay = (key, text) => {
      if (!sessionNoticeDue(key, day)) return;
      surface(text);
      shownKeys.push(key);
    };
    if (state === 'not-migrated') {
      if (vaultHasRemote()) {
        announceOncePerDay('not-migrated', REMOTE_NOT_MIGRATED_NOTICE);
      } else if (clock() - startedAt > MIGRATION_START_DEADLINE_MS) {
        announceOncePerDay('migration-deferred:deadline', DEADLINE_NOTICE);
      } else {
        // A throw from the move (a directory git or the filesystem will not let it read) must not
        // take the injection and the notices after it down with it: it defers the move like any
        // other reason, and the old files are injected as before.
        let moved;
        try {
          moved = migrateVaultToSessionEntries(HYPO_DIR);
        } catch (err) {
          moved = {
            deferred: 'error',
            notices: [`이행을 다음 세션으로 미뤘습니다: ${err?.message ?? String(err)}`],
          };
        }
        if (moved.deferred) {
          // One record per reason, so a passing reason (a busy lock, the deadline) does not hide
          // an actionable one the same day.
          announceOncePerDay(`migration-deferred:${moved.deferred}`, moved.notices.join('\n'));
        } else {
          if (moved.commit) {
            surface(
              '이 볼트의 세션 현황을 세션별 원본(projects/*/sessions/)으로 옮겼습니다. ' +
                '`hot.md`와 `session-state.md`는 이제 원본에서 만들어지는 파일이라 커밋되지 않습니다.',
            );
          }
          for (const msg of moved.notices) surface(msg);
        }
        state = migrationState(HYPO_DIR);
      }
    } else if (state === 'opted-out') {
      announceOncePerDay('opted-out', OPTED_OUT_NOTICE);
    }

    const cwd = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || 'default';
    const MARKER_FILE = sessionMarkerPath(sessionId);
    const hit = findProjectFiles(cwd);

    // ownProject = the cwd-matched project (or null on a MISS, per
    // foreignUncommittedNotice's docstring). Late-appended into `notices` /
    // `noticePrefix`, same pattern the MISS branch's suggestLine uses below:
    // both need `hit` first, which isn't resolved until this line.
    const foreignNotice = foreignUncommittedNotice(HYPO_DIR, hit ? hit.proj : null);
    if (foreignNotice) {
      notices.push(foreignNotice);
      noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
      process.stderr.write(`\n\x1b[33m${foreignNotice}\x1b[0m\n`);
    }

    for (const key of shownKeys) recordSessionNotice(key, day);

    // A prior Stop's write of a generated view may have backed up bytes it did not write, or have
    // failed invisibly (its own stdout is suppressed), and left a note for the next SessionStart.
    // One-shot: consumed (and deleted) the moment it is read, so it surfaces exactly once.
    const showHealthNotice = () => {
      const health = consumeRootHotHealthNotice(HYPO_DIR);
      if (health) surface(health);
    };

    // The root `hot.md` is written first, for every session: a fast-forward over a migration
    // commit deletes it from the working tree, and the MISS injection below reads it. The current
    // project's two views follow the injection (a slow or failed write must not block it); the
    // other projects' views wait for the Stop hook.
    if (existsSync(HYPO_DIR)) {
      try {
        writeGeneratedViews(HYPO_DIR, { projects: [], root: true });
      } catch (err) {
        surface(`세션 현황 파일 갱신에 실패했습니다: ${err?.message ?? String(err)}`);
      }
      showHealthNotice();
    }

    // Observed-base snapshot for the write=proposal gate. Deliberately AFTER the pull: the base
    // must describe the tree this session actually starts from, remote merges included. Once per
    // session (existence-check inside snapshotBase), so resume and compact leave it alone.
    // `data.session_id` is used raw rather than the 'default' fallback above. A session with no id
    // has no base and closes down the legacy direct-write path.
    if (data.session_id) {
      // Before the base snapshot: a session whose base already exists began under an older
      // version and is not stamped (see stampSessionRecord).
      stampSessionRecord(HYPO_DIR, data.session_id);
      snapshotBase(HYPO_DIR, data.session_id, overwriteTargets(null));
      // Bumps the observed generation on EVERY SessionStart (first run and resume/compact alike),
      // before the injections below record into it. A resume that ends up injecting nothing still
      // bumps, which is what lets a stale observation from an earlier resume expire instead of
      // staying licensed for the rest of the session.
      beginObservedGeneration(HYPO_DIR, data.session_id);
    }

    const ignorePatterns = loadHypoIgnore(HYPO_DIR);

    // When cwd is a project working_dir that is NOT the vault itself, tell the
    // AI where the vault lives so it does not re-discover the path or look for
    // wiki files in the code repo. '' when cwd === vault root.
    const vaultOrientation = hit ? buildVaultOrientation(cwd) : '';
    const hitPrefix = vaultOrientation ? `${vaultOrientation}\n\n` : '';

    if (hit) {
      // The injection is final before the views are written, so a slow or failed write cannot
      // change what the session is told.
      let view;
      try {
        view = projectInjection(hit.proj, state, ignorePatterns);
      } catch (err) {
        // The model could not be loaded: say so and keep everything else of this start.
        surface(
          `세션 현황을 읽지 못해 이번 세션에는 주입하지 못했습니다: ${err?.message ?? String(err)}`,
        );
        view = { unavailable: true };
      }
      try {
        writeGeneratedViews(HYPO_DIR, { projects: [hit.proj], root: false });
      } catch (err) {
        surface(`세션 현황 파일 갱신에 실패했습니다: ${err?.message ?? String(err)}`);
      }
      showHealthNotice();

      if (!view.hidden && view.text) {
        printTerminalSummary(hit.proj, view.items);
        writeFileSync(
          MARKER_FILE,
          JSON.stringify({
            proj: hit.proj,
            hotPath: hit.hotPath,
            statePath: hit.statePath,
            hasSnapshot: view.hasSnapshot,
            ts: Date.now(),
          }),
        );
        const body = [...view.markers, view.text].join('\n\n');
        console.log(
          JSON.stringify(
            buildOutput(
              'SessionStart',
              `${noticePrefix}${hitPrefix}[WIKI HOT CACHE: project=${sanitizeProjForPrompt(hit.proj)}]\n\n${body}`,
              outExtra,
            ),
          ),
        );
        // Observed heads: this is the actual injection point, so this is where "this session was
        // SHOWN these heads" becomes true. Recorded AFTER the marker write and the console.log
        // above (fail-open ordering): if this throws, the model has already been shown the heads
        // but nothing is recorded, so the next close just does not replace them, rather than the
        // reverse: a record claiming an observation the injection never emitted.
        if (data.session_id) {
          try {
            recordObservedHeads(HYPO_DIR, data.session_id, hit.proj, {
              level: 'full',
              heads: view.observed.heads,
            });
            recordObservedHeads(HYPO_DIR, data.session_id, hit.proj, {
              level: 'pointer',
              heads: view.observed.pointer,
            });
          } catch (err) {
            process.stderr.write(`[hypo-session-start] observed heads: ${err?.message ?? err}\n`);
          }
        }
      } else {
        // A snapshot that exists but is scoped to another machine must not be
        // reported as "no snapshot yet": the model would treat a resumed project
        // as a first session. Say which it is, and say nothing of the contents.
        const scopedOut = view.scopedOut === true;
        const unavailable = view.unavailable === true;
        const reason = unavailable
          ? 'session state could not be read'
          : scopedOut
            ? 'snapshot scoped to another machine'
            : 'no snapshot yet';
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
          JSON.stringify({
            proj: hit.proj,
            hotPath: null,
            hasSnapshot: false,
            scopedOut,
            unavailable,
            ts: Date.now(),
          }),
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
      // GLOBAL_HOT exists but is empty or .hypoignore'd: still surface any
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
  } catch (err) {
    process.stderr.write(`[hypo-session-start] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify(outExtra));
  }
});
