#!/usr/bin/env node
/**
 * hypo-file-watch.mjs — FileChanged hook
 *
 * When a hot.md inside the wiki is modified externally (e.g. by a remote
 * agent or another Claude Code session), re-inject its contents.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { HYPO_DIR, loadHypoIgnore, isIgnored } from './hypo-shared.mjs';

const MAX_CHARS = 2000;

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    const filePath = data.file_path || data.path || '';

    if (!filePath.startsWith(HYPO_DIR + '/') && filePath !== HYPO_DIR) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Privacy guard (fix #48, Stage 1 Truth Reconciliation): refuse to inject
    // .hypoignore-matched paths. Without this, `.env*` or other secrets under
    // HYPO_DIR are re-emitted as additionalContext to the Claude provider.
    const patterns = loadHypoIgnore(HYPO_DIR);
    if (patterns.length > 0 && isIgnored(filePath, HYPO_DIR, patterns)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (!existsSync(filePath)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const content = readFileSync(filePath, 'utf-8').slice(0, MAX_CHARS);
    const relPath = filePath.replace(HYPO_DIR + '/', '');

    console.log(
      JSON.stringify({
        continue: true,
        suppressOutput: true,
        additionalContext: `[WIKI FILE UPDATED: ${relPath}]\n\n${content}`,
      }),
    );
  } catch (err) {
    process.stderr.write(`[hypo-file-watch] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
