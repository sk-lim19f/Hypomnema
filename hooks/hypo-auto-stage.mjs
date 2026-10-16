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
  indexAndHeadBlobs,
  isAutoStagedBlob,
  isStagedDeletion,
  readAutoStagedRecord,
  recordAutoStagedBlob,
  recordTouchedPaths,
  remainingSpawnTimeoutMs,
  vaultCommitLockTarget,
  withFileLock,
} from './hypo-shared.mjs';
import { advanceBaseForWrite, hashContent } from './base-store.mjs';

// Tools that REPLACE file bytes. The add and the base advance below fire only for these:
// this hook has no matcher in hooks.json (it runs on every PostToolUse), and a
// read-only tool like Read also carries `tool_input.file_path`. Without this
// allowlist, merely Reading a target another session had drifted would advance
// the base to that other session's bytes — silently defeating the write=proposal
// guard at close. tool_name, not file_path, is the write signal.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// One time budget for every wait in this hook. hooks.json gives the hook 10 seconds and kills it
// after that, so waits that each ran to their own limit (vault lock, git, cache lock, session lock,
// base lock: 5 seconds apiece) could be cut off before the failure flag was written. The budget is
// split so the evidence comes first: the ownership record and, if it fails, the failure flag keep
// their share, the report keeps its own, and the side work (staging, the auto-staged cache, the
// base advance) uses only what is left of the rest. Dropped side work is redone or harmless:
// Stop stages again, a missing cache entry only means one more backup, a missing base advance
// parks the close on a proposal (the safe direction).
const AUTO_STAGE_BUDGET_MS = 8000;
const RECORD_SHARE_MS = 1000; // kept for recordTouchedPaths and, on failure, the flag write
const REPORT_SHARE_MS = 1000; // kept for the output that must still be printed
const deadline = { end: performance.now() + AUTO_STAGE_BUDGET_MS };
const until = (shareMs) => ({ end: deadline.end - shareMs });

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
  // Only a write stages: a Read of a vault file must not change the index.
  if (
    WRITE_TOOLS.has(input.tool_name) &&
    (patterns.length === 0 || !isIgnored(filePath, HYPO_DIR, patterns))
  ) {
    // Under the vault commit lock, like every other writer of the index: the catch-up pre-step
    // (clearGeneratedPathsBlockingPull) reads and releases the index while it holds that lock, and
    // an add landing in between would stage bytes it is about to set aside. A lock that cannot be
    // taken skips the add: the session's scoped auto-commit stages its own paths, so nothing is
    // lost. Every wait below is cut to the staging slice of the hook budget; with no time left the
    // add is skipped the same way.
    const staging = until(REPORT_SHARE_MS + RECORD_SHARE_MS);
    const lockWaitMs = Math.min(
      Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000,
      remainingSpawnTimeoutMs(staging),
    );
    try {
      if (lockWaitMs > 0)
        withFileLock(
          vaultCommitLockTarget(HYPO_DIR),
          () => {
            const rel = relative(HYPO_DIR, filePath);
            // A merge in progress (open conflict, or a resolution waiting for its commit): staging
            // now would change that resolution. The path is still in the session's touched set
            // below, so Stop commits it once the merge is done. A check that got no answer in time
            // is treated the same: staging on a guess could change the resolution.
            const mergeTimeout = remainingSpawnTimeoutMs(staging);
            if (mergeTimeout === 0) return;
            const merging = spawnSync(
              'git',
              ['-C', HYPO_DIR, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'],
              { stdio: 'ignore', timeout: mergeTimeout },
            );
            if (merging.status === 0 || merging.error) return;
            // A version a person already staged for this path must reach the commit intact, so that
            // it can be backed up there: `git add` would put the tool's bytes over it first. The
            // path is left unstaged (it is still in the session's touched set below, so Stop commits
            // it). A staged deletion (`git rm`) is skipped the same way: `git add` would turn it into a
            // modification. With no answer from git about the index, skip too: Stop stages it either
            // way.
            const before = indexAndHeadBlobs(HYPO_DIR, rel, { deadline: staging });
            if (
              !before ||
              isStagedDeletion(before.head, before.indexed) ||
              (before.index &&
                before.index !== before.head &&
                !isAutoStagedBlob(readAutoStagedRecord(HYPO_DIR), rel, before.index, before.head))
            )
              return;
            const addTimeout = remainingSpawnTimeoutMs(staging);
            if (addTimeout === 0) return;
            const add = spawnSync('git', ['-C', HYPO_DIR, 'add', filePath], {
              stdio: 'ignore',
              timeout: addTimeout,
            });
            if (add.status !== 0) return;
            // Record the blob this hook staged (and the HEAD blob it sat on), so the commit can tell
            // it from one a person staged later and does not back up Claude's own write.
            // Best-effort: with no record the commit saves the blob as it would for a person's.
            const after = indexAndHeadBlobs(HYPO_DIR, rel, { deadline: staging });
            const cacheWaitMs = Math.min(5000, remainingSpawnTimeoutMs(staging));
            if (after?.index && cacheWaitMs > 0)
              recordAutoStagedBlob(HYPO_DIR, rel, after.index, before.head, {
                timeoutMs: cacheWaitMs,
              });
          },
          { timeoutMs: lockWaitMs },
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
    // The record and a failure flag may use everything up to the report share.
    const recorded = recordTouchedPaths(HYPO_DIR, input.session_id, rel, {
      deadline: until(REPORT_SHARE_MS),
    });
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
      // Only what is left after the report share; none left skips the advance.
      const baseWaitMs = remainingSpawnTimeoutMs(until(REPORT_SHARE_MS));
      if (baseWaitMs > 0)
        advanceBaseForWrite(HYPO_DIR, input.session_id, rel, filePath, known, {
          timeoutMs: Math.min(5000, baseWaitMs),
        });
    }
  }
}

console.log(JSON.stringify({ continue: true, suppressOutput: true }));
