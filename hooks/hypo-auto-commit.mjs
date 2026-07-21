#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs — Stop hook
 *
 * At session end: stage this session's touched paths, commit if any, then
 * pull+push to sync remote.
 *
 * Scoped, not whole-tree: this no longer sweeps the entire working tree. The
 * scope is this session's accumulated touched-paths set (hypo-auto-stage.mjs
 * writes, plus whatever the earlier Stop-chain generators, hot-rebuild and
 * session-record, appended for the same session_id). No session_id means
 * nothing was ever accumulated, so the scoped commit is skipped cleanly;
 * never a whole-tree fallback.
 *
 * PEEK, don't drain, and hold ONE lock across peek+commit+clear
 * (commitTouchedPaths, hypo-shared.mjs): a drain-then-requeue-on-failure
 * design was tried and dropped — the requeue write is itself a fallible
 * operation (lock-timeout, I/O), so a commit failure could still lose the
 * scope in the narrow window between the drain and the requeue. A peek
 * that released its lock before the commit, then a SEPARATE clear
 * afterward, was also tried and dropped — a `recordTouchedPaths` for a
 * path already in the just-peeked set could land in the window between the
 * commit and the clear and be silently wiped out by it (the set only
 * tracks path presence, not a version, so that write is indistinguishable
 * from the one already peeked). commitTouchedPaths holds ONE per-session
 * lock across the whole peek → commit → clear window, so neither loss mode
 * is possible: nothing is deleted until the commit has actually succeeded,
 * and no accumulate can land inside the window at all.
 */

import { spawnSync } from 'child_process';
import {
  HYPO_DIR,
  syncRemote,
  commitWikiChanges,
  commitTouchedPaths,
  vaultCommitLockTarget,
  withFileLock,
} from './hypo-shared.mjs';

function hasRemote() {
  const r = spawnSync('git', ['-C', HYPO_DIR, 'remote'], { encoding: 'utf-8', timeout: 30000 });
  return (r.stdout || '').trim().length > 0;
}

// Overridable so a test can force a fast lock-timeout instead of waiting out
// the real default (mirrors crystallize.mjs's HYPO_APPEND_LOCK_TIMEOUT_MS).
const VAULT_LOCK_TIMEOUT_MS = Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000;

let input = {};
try {
  const raw = await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });
  input = JSON.parse(raw || '{}') || {};
} catch {
  input = {};
}
const sessionId = input.session_id || input.sessionId || null;

// Stage + commit + sync as one critical section, serialized against every
// other writer of this vault (the crystallize.mjs --apply-session-close path
// holds the SAME lock around its own stage+commit). Without this, two
// concurrent sessions on a shared vault could interleave `git add`/`git
// commit`/`git pull`/`git push`. This does NOT gate pushes on whole-tree
// cleanliness: a scoped commit may legitimately leave other sessions' dirty
// files behind, and a `git pull --no-rebase` failure from that residual is
// already logged via appendSyncFailure and surfaced by doctor/session-start.
// Full cross-session isolation is out of scope (it needs separate worktrees).
//
// The vault lock (shared with crystallize.mjs's apply commit) serializes
// git operations across concurrent sessions on this vault; the per-session
// touched-paths lock commitTouchedPaths takes internally is a DIFFERENT
// lock file, so the two nest without any ordering conflict (vault lock is
// always acquired first here; accumulation elsewhere only ever takes the
// per-session lock, never the vault lock).
try {
  withFileLock(
    vaultCommitLockTarget(HYPO_DIR),
    () => {
      // Peek this session's scope, run the scoped commit, and — only on
      // success — clear exactly what committed, ALL under one hold of the
      // per-session lock. See commitTouchedPaths's docstring for why a
      // commit failure or a same-path race can't lose anything under this.
      const result = commitTouchedPaths(HYPO_DIR, sessionId, (paths) =>
        commitWikiChanges(HYPO_DIR, paths),
      );
      if (!result.committed) return;

      if (hasRemote()) {
        // pull/push failures must not stop the session, but they can no longer be
        // swallowed silently — syncRemote records each to .cache/sync-state.json and,
        // on a merge conflict, aborts the merge so the tree is never left half-merged
        // (part of the v1.4 sync hardening). session-start + doctor surface the result next session.
        syncRemote(HYPO_DIR);
      }
    },
    { timeoutMs: VAULT_LOCK_TIMEOUT_MS },
  );
} catch {
  // Lock-timeout (or an unexpected lock error) on the OUTER vault lock: we
  // never entered the critical section, so commitTouchedPaths never ran —
  // the touched-paths file is untouched on disk, and the next Stop retries
  // this session's commit from the same scope. Best-effort, like every
  // other step in this hook.
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
