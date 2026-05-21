#!/usr/bin/env node
/**
 * hypo-auto-stage.mjs — PostToolUse hook
 *
 * When a file inside the wiki directory is written, stage it automatically.
 */

import { spawnSync } from 'child_process';
import { HYPO_DIR, loadHypoIgnore, isIgnored } from './hypo-shared.mjs';

let input = {};
try {
  const raw = await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });
  input = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`[hypo-auto-stage] error: ${err?.message ?? String(err)}\n`);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

const filePath = input.tool_input?.file_path ?? '';

if (filePath.startsWith(HYPO_DIR + '/') || filePath === HYPO_DIR) {
  const patterns = loadHypoIgnore(HYPO_DIR);
  if (patterns.length === 0 || !isIgnored(filePath, HYPO_DIR, patterns)) {
    spawnSync('git', ['-C', HYPO_DIR, 'add', filePath], { stdio: 'ignore' });
  }
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
