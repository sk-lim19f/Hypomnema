#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs — Stop hook
 *
 * At session end: stage all changes, commit if any, then pull+push to sync remote.
 */

import { spawnSync } from 'child_process';
import { HYPO_DIR, loadHypoIgnore, isIgnored, appendSyncFailure } from './hypo-shared.mjs';
import { join } from 'path';

function git(...args) {
  return spawnSync('git', ['-C', HYPO_DIR, ...args], { encoding: 'utf-8', timeout: 30000 });
}

function hasRemote() {
  const r = git('remote');
  return (r.stdout || '').trim().length > 0;
}

// `.hypoignore` is the project privacy boundary. `git add -A` ignores it, so
// enumerate changed paths, drop ignored ones, then stage explicitly.
const ignorePatterns = loadHypoIgnore(HYPO_DIR);
const porcelain = git('status', '--porcelain', '-uall');
const paths = [];
for (const line of (porcelain.stdout || '').split('\n')) {
  if (!line) continue;
  const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop().trim();
  if (!file) continue;
  if (ignorePatterns.length > 0 && isIgnored(join(HYPO_DIR, file), HYPO_DIR, ignorePatterns))
    continue;
  paths.push(file);
}
if (paths.length > 0) git('add', '--', ...paths);
const staged = git('diff', '--cached', '--name-only').stdout?.trim() || '';
if (staged) {
  const today = new Date().toISOString().slice(0, 10);
  const commit = git('commit', '-m', `auto: ${today} wiki update`);
  if (commit.status !== 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }
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
