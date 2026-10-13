#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs: Stop chain stage 3 (spawned by hypo-stop.mjs)
 *
 * At session end: finish a merge this tool left open, stage this session's touched paths, commit
 * if any, then pull+push to sync remote. A pull that moves HEAD is followed by a regeneration
 * of the (untracked) session views, inside the same lock. The push is withheld when the pull did
 * not land (conflict, deferral, failure) and when the tree tracks generated views under a
 * migrated upstream.
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
  finishOwnedMerge,
  listRetrackedViews,
  vaultCommitLockTarget,
  withFileLock,
  writeRootHotHealthNotice,
} from './hypo-shared.mjs';
import { writeGeneratedViewsUnlocked } from './session-views.mjs';

function hasRemote() {
  const r = spawnSync('git', ['-C', HYPO_DIR, 'remote'], { encoding: 'utf-8', timeout: 30000 });
  return (r.stdout || '').trim().length > 0;
}

const isGitRepo = () =>
  spawnSync('git', ['-C', HYPO_DIR, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf-8',
    timeout: 30000,
  }).status === 0;

const headSha = () => {
  const r = spawnSync('git', ['-C', HYPO_DIR, 'rev-parse', '--verify', '-q', 'HEAD'], {
    encoding: 'utf-8',
    timeout: 30000,
  });
  return r.status === 0 ? (r.stdout || '').trim() : null;
};

// A pull that moved HEAD (or a merge finished here) may have brought session entries other
// machines closed, so the views are rendered again from what is on disk now. The vault lock is
// held by the caller (it is not reentrant), hence the unlocked writer. The views are not tracked,
// so this adds nothing to a commit or push.
function renderViewsIfHeadMoved(before) {
  if (headSha() === before) return;
  try {
    writeGeneratedViewsUnlocked(HYPO_DIR);
  } catch (err) {
    writeRootHotHealthNotice(
      HYPO_DIR,
      `세션 현황 파일을 pull 뒤에 다시 만들지 못했습니다: ${err?.message ?? String(err)}`,
    );
  }
}

// In a migrated vault the generated views stay untracked. An old-version machine can push a
// commit that tracks them again; once a pull has merged it in, a push would hand that state to
// every machine and switch the session views off for them. A rollback on purpose (the off marker
// in HEAD) tracks them by design and is exempt, or its commit could never be pushed. Returns the
// reason to withhold the push, or null. Fails closed: when git cannot list the tracked paths the
// push is withheld too.
function retrackedViewsToWithhold() {
  let tracked;
  try {
    tracked = listRetrackedViews(HYPO_DIR);
  } catch (err) {
    return `세션 현황 파일의 추적 여부를 확인하지 못해 push하지 않았습니다 (${err?.message ?? err}).`;
  }
  if (!tracked.length) return null;
  const list = tracked.map((p) => `'${p}'`).join(' ');
  return (
    `이 볼트는 이미 세션 항목 방식으로 옮겨졌는데 이 브랜치가 생성 파일을 추적합니다: ${tracked.join(', ')}. ` +
    '이대로 push하면 모든 기계에서 세션 현황이 꺼지므로 push하지 않았습니다. ' +
    `git -C ${HYPO_DIR} rm --cached -- ${list} 를 커밋한 뒤 다시 시도하세요 (파일은 디스크에 남고 무시됩니다).`
  );
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
// SessionStart needs that same lock TWICE (its own `git pull` and the
// generated view write) at 5s each, out of a 30s hook budget. The pushable
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
      const startHead = headSha();
      // A merge this tool started and a killed run left open is finished before anything is
      // committed: a commit on top of it would either fail (a partial commit during a merge) or
      // sweep the half-resolved index into the merge commit. One that is not ours, or not safe to
      // finish, stops this Stop (commit and sync): the touched paths stay for the next one, and
      // the notice says what to do.
      if (isGitRepo()) {
        const merge = finishOwnedMerge(HYPO_DIR);
        if (merge.notices.length) writeRootHotHealthNotice(HYPO_DIR, merge.notices.join('\n'));
        if (merge.state === 'external' || merge.state === 'stuck') return;
        renderViewsIfHeadMoved(startHead);
      }

      // Peek this session's scope, run the scoped commit, and — only on
      // success — clear exactly what committed, ALL under one hold of the
      // per-session lock. See commitTouchedPaths's docstring for why a
      // commit failure or a same-path race can't lose anything under this.
      const result = commitTouchedPaths(HYPO_DIR, sessionId, (paths) =>
        commitWikiChanges(HYPO_DIR, paths),
      );
      if (!result.committed) return;
      // The commit landed but its paths' index entries did not all move to the new HEAD. Stop's
      // own output is suppressed, so the next SessionStart is where the person reads the fix.
      if (typeof result.indexWarning === 'string') {
        writeRootHotHealthNotice(HYPO_DIR, result.indexWarning);
      }

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
        //
        // A pull that moved HEAD may have brought session entries other machines closed.
        const before = headSha();
        const pulled = pullRemote(HYPO_DIR);
        renderViewsIfHeadMoved(before);
        // The push follows only a pull that landed. After a conflict, a deferral or a failed
        // pull, pullRemote has already recorded the cause as the last sync-state entry, and a
        // push attempt would add a second failure on top of it (a rejected push) that
        // SessionStart would show instead of the conflict guidance.
        if (pulled.pulled) {
          const blocked = retrackedViewsToWithhold();
          if (blocked) writeRootHotHealthNotice(HYPO_DIR, blocked);
          else pushTarget = resolvePushTarget(HYPO_DIR);
        }
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
// target resolved only after a successful commit and a pull that landed,
// so the set of cases that push is exactly the set that pushed before this
// split, and what each one sends is fixed before the lock goes.
if (pushTarget) pushRemote(HYPO_DIR, pushTarget);

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
