#!/usr/bin/env node
/**
 * hypo-file-watch.mjs — FileChanged hook
 *
 * When a hot.md inside the wiki is modified externally (e.g. by a remote
 * agent or another Claude Code session), build a notification of its
 * contents (n3 fix: Claude Code 2.1.276's `systemMessage` does not reach the
 * model, only a 5-second terminal toast, so "re-inject" overstated what this
 * hook can actually do).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  loadHypoIgnore,
  isIgnored,
  currentDevice,
  scopeVisible,
  readVisibilityScope,
} from './hypo-shared.mjs';

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

    // Privacy guard: refuse to emit .hypoignore-matched paths. Without this,
    // `.env*` or other secrets under HYPO_DIR are re-emitted in this hook's
    // output. The guard does not depend on which field carries that output:
    // where systemMessage goes on FileChanged is unmeasured, so the only safe
    // assumption is that a matched path must never be put in it.
    const patterns = loadHypoIgnore(HYPO_DIR);
    if (patterns.length > 0 && isIgnored(filePath, HYPO_DIR, patterns)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (!existsSync(filePath)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const fileRaw = readFileSync(filePath, 'utf-8');

    // Visibility guard: a machine-scoped page (visibility_scope: machine:<owner>)
    // must not be re-injected on a machine other than its owner. Read the scope
    // from the raw, unsliced content — slicing to MAX_CHARS first could cut the
    // frontmatter off and silently make every scoped page pass fail-open.
    const scope = readVisibilityScope(fileRaw);
    if (!scopeVisible(scope, currentDevice())) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const content = fileRaw.slice(0, MAX_CHARS);
    const relPath = filePath.replace(HYPO_DIR + '/', '');

    // Built inline rather than through buildOutput(): FileChanged's documented
    // output schema is watchPaths only, same as CwdChanged, so there is no
    // additionalContext path here and the notice rides systemMessage. Same
    // caveat as hypo-cwd-change: systemMessage is a common field whose handling
    // is stated per event, and that section has not been read for FileChanged. This
    // hook has no registered trigger at all today, because nothing in this
    // package returns watchPaths.
    console.log(
      JSON.stringify({
        continue: true,
        suppressOutput: true,
        systemMessage: `[WIKI FILE UPDATED: ${relPath}]\n\n${content}`,
      }),
    );
  } catch (err) {
    process.stderr.write(`[hypo-file-watch] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
