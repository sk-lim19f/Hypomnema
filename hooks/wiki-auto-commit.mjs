#!/usr/bin/env node
/**
 * wiki-auto-commit.mjs — Stop hook
 *
 * At session end: stage all changes, commit if any, then pull+push to sync remote.
 */

import { execSync } from 'child_process';
import { WIKI_DIR } from './wiki-shared.mjs';

try {
  execSync(`git -C "${WIKI_DIR}" add -A`, { stdio: 'ignore' });
  const staged = execSync(`git -C "${WIKI_DIR}" diff --cached --name-only`, { encoding: 'utf-8' }).trim();
  if (staged) {
    const today = new Date().toISOString().slice(0, 10);
    execSync(`git -C "${WIKI_DIR}" commit -m "auto: ${today} wiki update"`, { stdio: 'ignore' });
  }
} catch {}

try { execSync(`git -C "${WIKI_DIR}" pull --no-rebase -q`, { stdio: 'ignore' }); } catch {}
try { execSync(`git -C "${WIKI_DIR}" push`, { stdio: 'ignore' }); } catch {}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
