#!/usr/bin/env node
/**
 * wiki-auto-stage.mjs — PostToolUse hook
 *
 * When a file inside the wiki directory is written, stage it automatically.
 */

import { spawnSync } from 'child_process';
import { WIKI_DIR } from './wiki-shared.mjs';

let input = {};
try {
  const raw = await new Promise(r => {
    let d = '';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => r(d));
  });
  input = JSON.parse(raw);
} catch {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

const filePath = input.tool_input?.file_path ?? '';

if (filePath.startsWith(WIKI_DIR + '/') || filePath === WIKI_DIR) {
  spawnSync('git', ['-C', WIKI_DIR, 'add', filePath], { stdio: 'ignore' });
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
