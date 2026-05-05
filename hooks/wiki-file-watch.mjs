#!/usr/bin/env node
/**
 * wiki-file-watch.mjs — FileChanged hook
 *
 * When a hot.md inside the wiki is modified externally (e.g. by a remote
 * agent or another Claude Code session), re-inject its contents.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { WIKI_DIR } from './wiki-shared.mjs';

const MAX_CHARS = 2000;

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    const filePath = data.file_path || data.path || '';

    if (!filePath.startsWith(WIKI_DIR + '/') && filePath !== WIKI_DIR) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (!existsSync(filePath)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const content = readFileSync(filePath, 'utf-8').slice(0, MAX_CHARS);
    const relPath = filePath.replace(WIKI_DIR + '/', '');

    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
      additionalContext: `[WIKI FILE UPDATED: ${relPath}]\n\n${content}`,
    }));

  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
