#!/usr/bin/env node
/**
 * hypo-auto-stage.mjs — PostToolUse hook
 *
 * When a file inside the wiki directory is written, stage it automatically.
 */

import { spawnSync } from 'child_process';
import { relative } from 'path';
import {
  HYPO_DIR,
  loadHypoIgnore,
  isIgnored,
  recordTouchedPaths,
  vaultCommitLockTarget,
  withFileLock,
} from './hypo-shared.mjs';
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
    // Under the vault commit lock, like every other writer of the index: the catch-up pre-step
    // (clearGeneratedPathsBlockingPull) reads and releases the index while it holds that lock, and
    // an add landing in between would stage bytes it is about to set aside. A lock that cannot be
    // taken skips the add: the session's scoped auto-commit stages its own paths, so nothing is
    // lost.
    try {
      withFileLock(
        vaultCommitLockTarget(HYPO_DIR),
        () => spawnSync('git', ['-C', HYPO_DIR, 'add', filePath], { stdio: 'ignore' }),
        { timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000 },
      );
    } catch (err) {
      process.stderr.write(
        `[hypo-auto-stage] 볼트 잠금을 못 잡아 ${filePath} 의 git add 를 건너뛰었습니다 (${err?.code ?? err?.message})\n`,
      );
    }
  }

  if (WRITE_TOOLS.has(input.tool_name)) {
    const rel = relative(HYPO_DIR, filePath);

    // Accumulate this write into the session's scoped auto-commit
    // set, keyed by session_id (no-op without one; never a shared bucket).
    // hypo-auto-commit.mjs drains this at Stop instead of sweeping the whole
    // working tree, so another session's concurrent writes to this vault
    // never land in THIS session's commit.
    const recorded = recordTouchedPaths(HYPO_DIR, input.session_id, rel);
    if (!recorded) {
      // A lock-timeout or write failure here leaves the file just written
      // with nothing in ANY session's touched-paths set to bring it into an
      // auto-commit: it sits dirty until an unrelated later write to the
      // same path happens to succeed. This hook's stdout is not suppressed
      // wholesale like the Stop hooks, but its own output is a fixed
      // continue/suppressOutput payload below, so stderr is the only channel
      // available to surface this.
      process.stderr.write(
        `[hypo-auto-stage] ${rel} 를 이번 세션의 커밋 범위에 기록하지 못했습니다\n`,
      );
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
    if (input.session_id) {
      const known =
        input.tool_name === 'Write' && typeof input.tool_input?.content === 'string'
          ? hashContent(input.tool_input.content)
          : null;
      advanceBaseForWrite(HYPO_DIR, input.session_id, rel, filePath, known);
    }
  }
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
