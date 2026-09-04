#!/usr/bin/env node
/**
 * hypo-session-start.mjs — SessionStart hook
 *
 * On session start:
 *   HIT  → cwd matches a project's working_dir → inject hot.md (2000 chars) + session-state.md (2000 chars)
 *   MISS → inject global hot.md pointer only (no fan-out to all projects)
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
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
import { listProposals } from './proposal-store.mjs';

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

/**
 * pkgRoot drift notice. hypo-shared.mjs's resolvePkgRoot() already
 * self-corrects PKG_ROOT in memory whenever the code's own resolved location
 * disagrees with the cached hypo-pkg.json — but silent self-correction is the
 * exact failure this closes: the user's own `upgrade` habit stops mattering
 * and nothing ever tells them hypo-pkg.json fell behind. Surfaced once per
 * (cached → self-location) pair via the same notify-once cache the sibling
 * notice above uses — a fresh drift (new self-location) re-notifies, but
 * staying on the same drifted state doesn't nag every session.
 *
 * Tri-state (pkgRootDriftStatus): 'match' CLEARS any earlier mark (checked
 * FIRST, unconditionally — even under opt-out, so a drift that resolves while
 * opted out doesn't leave a stale mark that then suppresses a genuine
 * recurrence once opt-out is lifted); 'unknown' touches nothing (self-location
 * could not be resolved this session — the permanent steady state for the
 * npm/manual channel, not evidence either way); only 'drift' can produce a
 * banner, and opt-out is checked there so an opted-out session never marks a
 * pair as notified it never actually showed.
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
    markPkgRootDriftNotified(cachePath, key);
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
      `heads-up, not a blocker.\n${recoveryLine}`
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
 * reserved for the update/sibling notices). Pure read (listProposals never
 * mutates); best-effort so a store read failure never breaks SessionStart. '' when
 * there are no pending proposals, so nothing surfaces on the empty path.
 */
function pendingProposalNotice() {
  try {
    const n = listProposals(HYPO_DIR).length;
    if (n === 0) return '';
    return `[WIKI: 대기 proposal ${n}건 (검토: hypomnema proposal list)]`;
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

    const pullOk = gitPull(HYPO_DIR);
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

    // Observed-base snapshot for the write=proposal gate. Deliberately AFTER gitPull: the base must
    // describe the tree this session actually starts from, remote merges
    // included, or the first close would raise a proposal against content the
    // session never had a chance to conflict with. Once per session
    // (existence-check inside snapshotBase), so resume and compact leave it
    // alone. `data.session_id` is used raw rather than the 'default' fallback
    // above. A session with no id has no base and closes down the legacy
    // direct-write path.
    if (data.session_id) {
      snapshotBase(HYPO_DIR, data.session_id, overwriteTargets(hit ? hit.proj : null));
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
        console.log(JSON.stringify(buildOutput(notice, outExtra)));
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
        console.log(JSON.stringify(buildOutput(notice, outExtra)));
      } else {
        console.log(JSON.stringify(outExtra));
      }
      return;
    }
    console.log(
      JSON.stringify(
        buildOutput(
          `${noticePrefix}[WIKI HOT CACHE: global — no project matched cwd=${cwd}]\n\n${globalContent}`,
          outExtra,
        ),
      ),
    );
    // Observed-set record: the MISS branch's root hot.md injection is the one
    // place a project-less session observes anything at all. Recorded AFTER
    // the console.log above — see the HIT branch's comment for why (fail-open
    // ordering). Hashes `.raw`, not a fresh disk read, for the same reason
    // given there.
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
