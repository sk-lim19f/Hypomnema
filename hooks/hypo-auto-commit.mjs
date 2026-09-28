#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs: Stop chain stage 3 (spawned by hypo-stop.mjs)
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
  pullRemote,
  pushRemote,
  resolvePushTarget,
  commitWikiChanges,
  commitTouchedPaths,
  vaultCommitLockTarget,
  withFileLock,
  rootHotProjectionIsCurrent,
  writeRootHotHealthNotice,
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
//
// The PUSH is deliberately not in here (review r5-w4 major 2). `git pull
// --no-rebase` rewrites working-tree files, so it stays under the lock with
// the commit. `git push` changes nothing locally, and it is a network round
// trip with a 30s spawn timeout: holding the vault lock across it let one
// session's Stop own the vault for up to a minute, while a sibling
// SessionStart needs that same lock TWICE (its own `git pull` and the root
// hot.md projection write) at 5s each, out of a 30s hook budget. The pushable
// decision is made inside the lock and acted on after it is released.
//
// "The push changes nothing locally" was the whole justification for that
// split, and it was only half true (codex major). What the push sends is
// decided at push time from HEAD, so a sibling session that commits in the
// window between the unlock and the push moves HEAD, and a bare `git push`
// sends THEIR commit instead of the one this hook just made and verified.
// So the target is pinned inside the lock, not just the decision to push:
// `pushTarget` names one commit object and one fully-qualified remote ref, and
// pushRemote sends exactly that or declines. See pushRemote's own comment for
// the half this does NOT close: a client-side pre-push hook still runs
// arbitrary code, from outside the lock, on this working tree.
let pushTarget = null;
try {
  withFileLock(
    vaultCommitLockTarget(HYPO_DIR),
    () => {
      // Peek this session's scope, run the scoped commit, and — only on
      // success — clear exactly what committed, ALL under one hold of the
      // per-session lock. See commitTouchedPaths's docstring for why a
      // commit failure or a same-path race can't lose anything under this.
      const result = commitTouchedPaths(HYPO_DIR, sessionId, (paths) => {
        // BLOCKER fix (r5-w1.md): 'hot.md' being IN this session's
        // touched-paths set only ever proves this session once intended to
        // write it, never that the bytes on disk right now are what it
        // actually wrote: a scan error at SessionStart, a lock-timeout on
        // the post-write record, or a claim simply outliving a later
        // mid-session edit can all leave the claim standing over content
        // this session never produced. Re-verify at this last possible
        // moment, right before staging, instead of trying to revoke the
        // claim on every branch that can go wrong upstream: a mismatch means
        // whatever is on disk did not come from this session's own write, so
        // it is dropped from THIS commit rather than swept in. It is not
        // lost: the next SessionStart/Stop that manages a successful scan
        // backs it up through the same ownership check before overwriting.
        // n1 fix: sessionId, not just HYPO_DIR, since a sibling session's write
        // updates the global ownership hash too, so this session's own
        // receipt must independently confirm it produced the current bytes.
        const scoped = rootHotProjectionIsCurrent(HYPO_DIR, sessionId)
          ? paths
          : paths.filter((p) => p !== 'hot.md');
        if (scoped.length !== paths.length) {
          writeRootHotHealthNotice(
            HYPO_DIR,
            '루트 hot.md이 이번 세션이 실제로 쓴 내용과 달라 이번 커밋에서 제외했습니다. 다음 세션 시작/종료 시 다시 확인됩니다.',
          );
        }
        return commitWikiChanges(HYPO_DIR, scoped);
      });
      if (!result.committed) return;

      if (hasRemote()) {
        // pull/push failures must not stop the session, but they can no longer be
        // swallowed silently: pullRemote/pushRemote record each to
        // .cache/sync-state.json and, on a merge conflict, the pull aborts the merge
        // so the tree is never left half-merged (part of the v1.4 sync hardening).
        // session-start + doctor surface the result next session.
        //
        // A conflicting pull leaves this branch diverged, so the push is
        // suppressed rather than deferred: the same ordering guarantee
        // syncRemote has always had, now carried across the lock boundary by
        // this target instead of by a `return`.
        //
        // Resolved AFTER the pull, not from `result.sha`: a clean
        // `git pull --no-rebase` can land a merge commit on top of ours, and
        // pushing the pre-merge sha would be rejected as a non-fast-forward.
        // HEAD here is still under the lock, so it is this session's commit
        // (plus whatever the pull brought down) and nothing a sibling added
        // after the unlock.
        if (!pullRemote(HYPO_DIR).conflict) pushTarget = resolvePushTarget(HYPO_DIR);
      }
    },
    { timeoutMs: VAULT_LOCK_TIMEOUT_MS },
  );
} catch {
  // Lock-timeout (or an unexpected lock error) on the OUTER vault lock: we
  // never entered the critical section, so commitTouchedPaths never ran —
  // the touched-paths file is untouched on disk, and the next Stop retries
  // this session's commit from the same scope. Best-effort, like every
  // other step in this hook. `pushTarget` is still null here, so a lock
  // we never took can never turn into a push.
}

// Outside the lock on purpose: see the note above the try block. Guarded by a
// target resolved only after a successful commit and a non-conflicting pull,
// so the set of cases that push is exactly the set that pushed before this
// split, and what each one sends is fixed before the lock goes.
if (pushTarget) pushRemote(HYPO_DIR, pushTarget);

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
