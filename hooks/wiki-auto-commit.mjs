#!/usr/bin/env node
/**
 * wiki-auto-commit.mjs — Stop hook
 *
 * At session end: stage all changes, commit if any, then pull+push to sync remote.
 */

import { spawnSync } from 'child_process';
import { WIKI_DIR } from './wiki-shared.mjs';

function git(...args) {
  return spawnSync('git', ['-C', WIKI_DIR, ...args], { encoding: 'utf-8' });
}

git('add', '-A');
const staged = git('diff', '--cached', '--name-only').stdout?.trim() || '';
if (staged) {
  const today = new Date().toISOString().slice(0, 10);
  git('commit', '-m', `auto: ${today} wiki update`);
}
git('pull', '--no-rebase', '-q');
git('push');

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
