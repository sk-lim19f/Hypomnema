#!/usr/bin/env node
/**
 * hypo-auto-stage.mjs — PostToolUse hook
 *
 * When a file inside the wiki directory is written, stage it automatically.
 */

import { spawnSync } from 'child_process';
import { relative } from 'path';
import { HYPO_DIR, loadHypoIgnore, isIgnored } from './hypo-shared.mjs';
import { advanceBaseForWrite, hashContent } from './base-store.mjs';

// Tools that REPLACE file bytes. The base advance below must fire only for these:
// this hook has no matcher in hooks.json (it runs on every PostToolUse), and a
// read-only tool like Read also carries `tool_input.file_path`. Without this
// allowlist, merely Reading a target another session had drifted would advance
// the base to that other session's bytes — silently defeating the write=proposal
// guard at close. tool_name, not file_path, is the write signal.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

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

  // Write=proposal gate provenance: when this session's own write lands on one of
  // the overwrite targets it snapshotted at start, advance that target's base so
  // the close guard reads the change as "I wrote this", not "someone else did"
  // (which would fail safe into a false proposal against the session's own edit).
  // Self-scoping — a no-op unless the path is a tracked base key — so it runs
  // regardless of .hypoignore (provenance is independent of privacy). Best-effort.
  //
  // The Write tool carries its full `content`, so advance to the bytes THIS
  // session wrote (race-safe: a concurrent write landing between the tool and
  // this hook cannot be adopted as our base). Edit/MultiEdit have no full content
  // in the payload, so they fall back to a post-write disk read.
  if (WRITE_TOOLS.has(input.tool_name) && input.session_id) {
    const rel = relative(HYPO_DIR, filePath);
    const known =
      input.tool_name === 'Write' && typeof input.tool_input?.content === 'string'
        ? hashContent(input.tool_input.content)
        : null;
    advanceBaseForWrite(HYPO_DIR, input.session_id, rel, filePath, known);
  }
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
