#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs — Stop hook
 *
 * At session end: stage all changes, commit if any, then pull+push to sync remote.
 */

import { spawnSync } from 'child_process';
import { HYPO_DIR, appendSyncFailure, commitWikiChanges } from './hypo-shared.mjs';

function git(...args) {
  return spawnSync('git', ['-C', HYPO_DIR, ...args], { encoding: 'utf-8', timeout: 30000 });
}

function hasRemote() {
  const r = git('remote');
  return (r.stdout || '').trim().length > 0;
}

// Stage + commit via the shared helper (same .hypoignore filter the apply path
// uses — ADR 0056). A real commit failure short-circuits before sync, exactly as
// the inline logic did; "nothing to commit" is success and falls through to sync.
const result = commitWikiChanges(HYPO_DIR);
if (!result.committed) {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

if (hasRemote()) {
  // pull/push failures must not stop the session, but they can no longer be
  // swallowed silently — record each to .cache/sync-state.json so session-start
  // and doctor can surface them next session.
  const pull = git('pull', '--no-rebase', '-q');
  if (pull.status !== 0) appendSyncFailure(HYPO_DIR, 'pull', pull.stderr || pull.stdout);
  const push = git('push');
  if (push.status !== 0) appendSyncFailure(HYPO_DIR, 'push', push.stderr || push.stdout);
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
