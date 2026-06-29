#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs — Stop hook
 *
 * At session end: stage all changes, commit if any, then pull+push to sync remote.
 */

import { spawnSync } from 'child_process';
import { HYPO_DIR, syncRemote, commitWikiChanges } from './hypo-shared.mjs';

function hasRemote() {
  const r = spawnSync('git', ['-C', HYPO_DIR, 'remote'], { encoding: 'utf-8', timeout: 30000 });
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
  // swallowed silently — syncRemote records each to .cache/sync-state.json and,
  // on a merge conflict, aborts the merge so the tree is never left half-merged
  // (part of the v1.4 sync hardening). session-start + doctor surface the result next session.
  syncRemote(HYPO_DIR);
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
