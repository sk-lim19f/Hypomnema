#!/usr/bin/env node
/**
 * hypo-auto-commit.mjs — Stop hook
 *
 * At session end: stage all changes, commit if any, then pull+push to sync remote.
 */

import { spawnSync } from 'child_process';
import { HYPO_DIR } from './hypo-shared.mjs';

function git(...args) {
  return spawnSync('git', ['-C', HYPO_DIR, ...args], { encoding: 'utf-8', timeout: 30000 });
}

function hasRemote() {
  const r = git('remote');
  return (r.stdout || '').trim().length > 0;
}

git('add', '-A');
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
  git('pull', '--no-rebase', '-q');
  git('push');
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
