// tests/crystallize-apply.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  rmSync,
  statSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotBase, overwriteTargets, advanceBaseForWrite } from '../hooks/base-store.mjs';
import { closeGatePath, closeGateStatus } from '../hooks/close-gate-store.mjs';
import { readJournal } from '../hooks/close-journal.mjs';
import {
  GITATTRIBUTES_BLOCK,
  closeIdFor,
  formatSessionEntry,
  parseSessionEntry,
  renderViews,
  trackHeads,
} from '../hooks/session-entries.mjs';
import {
  loadSessionModel,
  migrateVaultToSessionEntries,
  readObservedHeads,
  recordObservedHeads,
} from '../hooks/session-views.mjs';
import {
  closePinPath,
  findBackfillCandidate,
  readClosePin,
  readTouchedPathsStrict,
  writeClosePin,
  sessionProofCloseId,
  rootLogEntry,
  sessionClosedMarkerPath,
  vaultCommitLockTarget,
  writeSessionClosedMarker,
} from '../hooks/hypo-shared.mjs';
import { ensureProjectIndex } from '../scripts/crystallize.mjs';
import { receiptPath, verifyEntriesInCommit } from '../hooks/close-receipt.mjs';
import {
  buildMarkCloseProof,
  classifyExistingEntry,
  landReceiptThenMarker,
  withdrawOwnReceipt,
  markerWriteGenuinelyFailed,
  commitShaForUndo,
  closeIntentPath,
  writeCloseIntent,
  clearCloseIntent,
} from '../scripts/lib/crystallize-close-apply.mjs';
import { test, testAsync, suite } from './harness.mjs';
import {
  HOME,
  REPO,
  SESSION_TMP_HOME,
  buildCleanWikiTree,
  gitHead,
  hasLogEntry,
  makeMultiProjectWiki,
  payloadForCleanWiki,
  run,
  runApply,
  seedCloseTranscript,
  sessionCloseGlobalStatus,
  todayLocal,
  withTmpDir,
  withWiki,
} from './helpers.mjs';

// The one overwrite target a close payload still carries is pages/open-questions.md.
// The guard tests below (base mismatch, local edit, section loss, lint) used to aim at
// the project's hot.md / session-state.md, which a close no longer writes.
const OQ_REL = join('pages', 'open-questions.md');
const openQuestionsText = (today, marker = 'initial') =>
  `---\ntitle: Open Questions\ntype: concept\nupdated: ${today}\n---\n\n## Questions\n\n- ${marker}\n`;
// A `withWiki` mutate step: the page exists (and is committed) before the close.
const seedOpenQuestions =
  (text = null) =>
  (dir, today) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, OQ_REL), text ?? openQuestionsText(today));
  };

// ── fix #38: --apply-session-close --payload=<path|-> ─────────────────────────
// @fix #38: clean-wiki payload → ok:true, new entries appended (apply dedup is exact-entry, not date-based)
// @fix #38: idempotent: re-running same payload produces no new bytes (file mtimes unchanged)
// Idempotent payload-driven entrypoint that writes the 5 mandatory memory files
// (+ optional open-questions) and finishes with the strict gate. ADR 0029 Phase A.

suite('crystallize.mjs --apply-session-close (#38)');

// The 2026-08-03 QA gap this closes: `applied: []` alone cannot tell an
// already-applied no-op re-run apart from a run that failed before writing
// anything. `skipped` (pre-existing) names every field that matched disk;
// `committed` (newly surfaced on this path, previously only present on the
// two early-refusal branches) tells apart a commit that ran and found
// nothing to stage (`true`) from one that never ran at all (`null`, a
// verification/lint failure) or that ran and failed (`false`).
test('a second close with an unchanged payload appends nothing twice and writes one new entry, committed:true', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const first = runApply(dir, payload);
    const firstOut = JSON.parse(first.stdout);
    assert.equal(firstOut.ok, true, `first apply must succeed: ${first.stdout}`);

    // runApply seeds a fresh session per call, so this is a second close request: it
    // gets its own entry, while the appends dedupe on their exact text.
    const second = runApply(dir, payload);
    const out = JSON.parse(second.stdout);
    assert.equal(out.ok, true, `second apply must still succeed: ${second.stdout}`);
    assert.equal(out.applied.length, 1, JSON.stringify(out.applied));
    assert.match(out.applied[0], /^sessionEntry \(projects\/test-project\/sessions\//);
    assert.ok(
      ['sessionLog', 'log'].every((k) => out.skipped.some((s) => s.startsWith(k))),
      `skipped must name every append the payload carries: ${JSON.stringify(out.skipped)}`,
    );
    assert.equal(out.committed, true, 'a commit outcome, not a skipped one');
  });
});

// FEAT-11 T5 fail-safe: drives the REAL close path (not a worker reimplementation
// of append). Pre-hold a fresh lock on the daily shard so crystallize's append
// cannot acquire it → the close must withhold to proposal-pending WITHOUT touching
// the shard, and the conflict must carry the T6 seam fields (kind:'append').
test('append lock-timeout → proposal-pending, shard byte-untouched (FEAT-11 T5)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] locked-out entry\n\nbody\n` };
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    const shardLock = `${shard}.lock`;
    mkdirSync(dirname(shard), { recursive: true });
    const shardBefore = existsSync(shard) ? readFileSync(shard, 'utf-8') : null;
    writeFileSync(shardLock, ''); // fresh lock "held" by another writer, never released
    process.env.HYPO_APPEND_LOCK_TIMEOUT_MS = '300'; // fast timeout instead of the 5s default
    let r;
    try {
      r = runApply(dir, payload, { sessionId: 's-lockout' });
    } finally {
      delete process.env.HYPO_APPEND_LOCK_TIMEOUT_MS;
      try {
        unlinkSync(shardLock);
      } catch {
        /* already gone */
      }
    }
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false, `lock-timeout must withhold (ok:false): ${r.stdout}`);
    assert.equal(out.stage, 'proposal-pending', `stage must be proposal-pending: ${r.stdout}`);
    const c = (out.conflicts || []).find((x) => x.key === 'sessionLog');
    assert.ok(c, `a sessionLog conflict is expected: ${JSON.stringify(out.conflicts)}`);
    assert.equal(c.kind, 'append', 'conflict.kind must be "append"');
    assert.equal(c.reason, 'append-lock-timeout', 'conflict.reason must be append-lock-timeout');
    assert.equal(
      c.proposedContent,
      undefined,
      'proposedContent must be dropped from the reported shape',
    );
    const shardAfter = existsSync(shard) ? readFileSync(shard, 'utf-8') : null;
    assert.equal(
      shardAfter,
      shardBefore,
      'the shard must be byte-untouched when the append is withheld',
    );
    if (shardAfter) {
      assert.ok(!shardAfter.includes('locked-out entry'), 'the withheld entry must not be written');
    }
  });
});

// ── ISSUE-42: freshness gate write/verify format contract ────────────────────
suite('ISSUE-42: colon-delimiter log entries + pre-apply format gate');

test('ISSUE-42a: a colon-delimiter log.md entry ALONE satisfies the close gate (2026-07-01 repro)', () => {
  // The dominant hand-written log convention is `## [date] session | <project>: title`
  // (colon, since the tone rule banned the em dash). Before the fix hasLogEntry
  // required whitespace/eol after the slug, so a close whose ONLY log.md evidence
  // used the colon form false-failed as "stale". Replace log.md with a single
  // colon-form entry (no space-form sibling to mask it) and require exit 0.
  withWiki(
    (dir, today) => {
      writeFileSync(
        join(dir, 'log.md'),
        `## [${today}] session | test-project: real work this session\n`,
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(
        r.status,
        0,
        `colon-form log entry must satisfy the gate, got status=${r.status}\n${r.stdout}`,
      );
      const out = JSON.parse(r.stdout);
      assert.ok(
        !out.stale.includes('log.md') && !out.missing.includes('log.md'),
        `log.md must not be flagged stale/missing for a colon entry: ${JSON.stringify(out)}`,
      );
    },
  );
});

test('ISSUE-42b: colon delimiter must NOT loosen the slug-prefix guard (foo vs foo-bar: title)', () => {
  const today = '2026-07-04';
  // Space form (derive path) — accepted.
  assert.ok(
    hasLogEntry(`## [${today}] session | foo — title\n`, today, 'foo'),
    'space/em-dash form must match',
  );
  // Colon form — accepted.
  assert.ok(
    hasLogEntry(`## [${today}] session | foo: title\n`, today, 'foo'),
    'colon form must match',
  );
  // Bare slug at EOL — accepted.
  assert.ok(hasLogEntry(`## [${today}] session | foo\n`, today, 'foo'), 'bare slug must match');
  // Look-alike longer slug must NOT satisfy "foo", with a colon after the tail.
  assert.ok(
    !hasLogEntry(`## [${today}] session | foo-bar: title\n`, today, 'foo'),
    'foo-bar: title must NOT match the "foo" gate (colon did not loosen the prefix guard)',
  );
});

test('ISSUE-42c: headingless sessionLog entry is rejected pre-apply, no bytes written', () => {
  withWiki(null, (dir, today) => {
    const before = {
      log: readFileSync(join(dir, 'log.md'), 'utf-8'),
      state: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
    };
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `no dated heading at all\n` };
    // Keep payload.log present so the payload.log branch message fires (not the
    // derive-precondition wording).
    payload.log = { entry: `## [${today}] session | test-project: x\n` };
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `headingless sessionLog must fail pre-apply: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 'pre-apply-verification', `stage must be pre-apply: ${r.stdout}`);
    // No bytes written: the append targets are byte-identical to before.
    assert.equal(
      readFileSync(join(dir, 'log.md'), 'utf-8'),
      before.log,
      'log.md must be untouched',
    );
    assert.equal(
      readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      before.state,
      'session-state.md must be untouched',
    );
  });
});

test('ISSUE-42d: non-canonical explicit payload.log is rejected pre-apply, no bytes written', () => {
  withWiki(null, (dir, today) => {
    const beforeLog = readFileSync(join(dir, 'log.md'), 'utf-8');
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] valid dated heading\n` };
    payload.log = { entry: `## [${today}] not a canonical session line\n` };
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `non-canonical payload.log must fail pre-apply: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.stage, 'pre-apply-verification', `stage must be pre-apply: ${r.stdout}`);
    assert.equal(readFileSync(join(dir, 'log.md'), 'utf-8'), beforeLog, 'log.md must be untouched');
  });
});

test('ISSUE-42 F1: a colon-form log entry is the sole today signal → dangling close still blocks', () => {
  // closeCandidateSlugs must extract the BARE slug from a colon entry (not `beta:`),
  // or a project whose only today evidence is a colon-form log line escapes the
  // dangling-close scan. beta has a real dir but stale own files and is absent from
  // the hot table, so its ONLY today signal is the colon log.md line.
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today }, // fully closed today
      {
        slug: 'beta',
        date: today,
        sessionState: '2020-01-01', // stale own files → incomplete close
        projectHot: '2020-01-01',
        sessionLog: false, // no today session-log heading
        hotRow: false, // not in today's hot table
        logEntry: false, // suppress the default space-form line; we write our own
      },
    ]);
    // beta's only today signal: a colon-delimiter log.md entry with a title.
    writeFileSync(
      join(dir, 'log.md'),
      `## [${today}] session | alpha\n## [${today}] session | beta: some real title\n`,
    );
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, false, `beta's colon-form dangling close must block: ${JSON.stringify(s)}`);
    const beta = s.projects.find((p) => p.project === 'beta');
    assert.ok(
      beta && !beta.ok,
      `beta must be a detected today-active candidate: ${JSON.stringify(s.projects)}`,
    );
  });
});

// ── fix #39: probe early-exit (option D) ─────────────────────────────────────
suite('fix #39: probe early-exit (option D)');

test('probe (#39): no payload + gate ok → exit 0 with alreadyComplete', () => {
  // buildCleanWikiTree() leaves the wiki in a passing-gate state for `today`.
  // With no --payload, the helper runs as a cheap "already complete?" probe:
  // gate ok → exit 0 alreadyComplete:true, no payload required.
  withWiki(null, (dir, today) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    assert.equal(r.status, 0, `probe must succeed, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.alreadyComplete, true, `alreadyComplete flag must be set: ${r.stdout}`);
    assert.equal(out.date, today);
  });
});

// major finding: applyOverwrites writes session-state.md, project hot.md, and
// open-questions.md as three separate atomicWrite calls; a SIGKILL between the
// first rename and the second leaves the set torn even though each individual
// write is itself torn-proof. If the untouched target already carried today's
// date for an unrelated reason, sessionCloseFileStatus's freshness check alone
// cannot see the gap. writeCloseIntent/clearCloseIntent leave a durable
// witness for exactly this: a leftover record from a run that never reached
// its own clear.
// Disabling the check: make hasTornCloseIntent always return false (the
// pre-fix behavior). This test goes red (alreadyComplete flips back to true)
// while the plain "no leftover record" probe test above stays green, which is
// the pair that isolates this one path from the general probe mechanics.
test('probe (#39): a leftover close-intent record refuses the alreadyComplete shortcut', () => {
  withWiki(null, (dir) => {
    const intentDir = join(dir, '.cache', 'close-intent');
    mkdirSync(intentDir, { recursive: true });
    // Shaped exactly like writeCloseIntent's own record, but for a hash that
    // cannot match whatever `hot.md` actually holds on disk: this is the
    // "died mid-set, one target never got its bytes" case the record exists
    // to catch, without needing a real crash to reproduce it.
    writeFileSync(
      join(intentDir, 'crashed-session.json'),
      JSON.stringify({
        v: 1,
        targets: [{ relPath: join('projects', 'test-project', 'hot.md'), hash: '0'.repeat(64) }],
      }),
    );

    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.ok(!out.alreadyComplete, `a torn close-intent must never read as complete: ${r.stdout}`);
    assert.equal(out.ok, false, `must fall through to the normal payload-required refusal`);
    assert.ok(
      /payload is required/.test(out.error || ''),
      `must surface the same refusal a stale gate does: ${r.stdout}`,
    );
  });
});

// Companion to the test above, flipped by the final cross-review: a live
// close-intent record whose hash DOES match disk used to read as clean. That
// is the state a close leaves when it dies after its writes and before its
// commit (or ends ok:false): every target already holds the new bytes, so a
// hash comparison alone cannot tell it from a finished close. A live record
// now blocks the probe on its presence; only an expired one stops counting
// (the expiry test below is the negative control that keeps "any file at all
// blocks forever" from passing).
// Disabling the check: in hasTornCloseIntent, return 'clean' instead of
// 'uncommitted' when every target matched. alreadyComplete flips back to true.
test('probe (#39): a live close-intent record whose hash matches disk still refuses alreadyComplete', () => {
  withWiki(null, (dir) => {
    const hotPath = join(dir, 'projects', 'test-project', 'hot.md');
    const hash = createHash('sha256').update(readFileSync(hotPath, 'utf-8'), 'utf-8').digest('hex');
    const intentDir = join(dir, '.cache', 'close-intent');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(
      join(intentDir, 'applied-not-committed.json'),
      JSON.stringify({
        v: 1,
        attemptId: 'abc',
        phase: 'applied',
        targets: [{ relPath: join('projects', 'test-project', 'hot.md'), hash }],
        startedAt: new Date().toISOString(),
      }),
    );

    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.ok(
      !out.alreadyComplete,
      `files that landed without their commit must never read as complete: ${r.stdout}`,
    );
    assert.ok(
      /payload is required/.test(out.error || ''),
      `must surface the same refusal a torn set does: ${r.stdout}`,
    );
  });
});

// Final cross-review finding: the record used to be cleared right after
// applyOverwrites, before the log appends and the commit. A close that got
// that far and no further left today-dated files, no record, and no commit,
// and the next probe answered alreadyComplete. An append lock timeout is a
// real close that stops in exactly that window (targets written, commit never
// run, ok:false), so it stands in for a crash there without killing a process.
// Disabling the check: move clearCloseIntent back to directly after
// applyOverwrites. The record is gone after the failed close and the probe
// answers alreadyComplete:true.
test('an ok:false close keeps its close-intent record (phase applied) and the probe refuses to call it complete', () => {
  withWiki(null, (dir, today) => {
    const sessionId = 's-intent-kept';
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] locked-out entry\n\nbody\n` };
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    const shardLock = `${shard}.lock`;
    writeFileSync(shardLock, '');
    process.env.HYPO_APPEND_LOCK_TIMEOUT_MS = '300';
    let r;
    try {
      r = runApply(dir, payload, { sessionId });
    } finally {
      delete process.env.HYPO_APPEND_LOCK_TIMEOUT_MS;
      rmSync(shardLock, { force: true });
    }
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false, `precondition: the close must end ok:false: ${r.stdout}`);
    assert.ok(
      out.applied.length > 0 && out.committed === null,
      `precondition: bytes were written and the commit never ran: ${r.stdout}`,
    );
    const intentPath = closeIntentPath(dir, sessionId);
    assert.ok(existsSync(intentPath), 'an ok:false close must leave its close-intent record');
    assert.equal(JSON.parse(readFileSync(intentPath, 'utf-8')).phase, 'applied');

    const probe = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const probeOut = JSON.parse(probe.stdout);
    assert.ok(
      !probeOut.alreadyComplete,
      `an uncommitted close must never read as complete: ${probe.stdout}`,
    );
  });
});

// The other half: a close whose commit landed retires its own record, so the
// record above really is "not committed" and not "every close leaves one".
// Disabling the check: drop the clearCloseIntent call after runMarkerPhase.
// The record survives this successful close and the assertion below fails.
test('a committed close removes its close-intent record', () => {
  withWiki(null, (dir, today) => {
    const sessionId = 's-intent-cleared';
    const r = runApply(dir, payloadForCleanWiki(dir, today), { sessionId });
    const out = JSON.parse(r.stdout);
    assert.equal(out.committed, true, `precondition: the commit must land: ${r.stdout}`);
    assert.ok(
      !existsSync(closeIntentPath(dir, sessionId)),
      'a close whose commit landed must remove its close-intent record',
    );
  });
});

// tier1 major finding 1a: hasTornCloseIntent used to fail OPEN on a directory
// it could not list at all (any readdirSync error, not just the ordinary
// "never written yet" ENOENT), so an EACCES/ENOTDIR on .cache/close-intent
// made a possibly-torn set look clean to the one check built to catch it. A
// file sitting where the directory should be reproduces the "cannot list"
// case without chmod (readdirSync throws ENOTDIR), so this holds under root too.
//
// Disabling the check: in hasTornCloseIntent's readdirSync catch, return
// 'clean' unconditionally instead of checking e.code === 'ENOENT'. This test
// goes red (alreadyComplete flips back to true) while the plain "no leftover
// record" probe test above stays green, isolating this path from ordinary
// probe mechanics.
test('probe (#39, tier1 major-1a): an unreadable .cache/close-intent never reads as clean, falls through to payload-required', () => {
  withWiki(null, (dir) => {
    const cacheDir = join(dir, '.cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'close-intent'), 'a file, not a directory');

    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.ok(
      !out.alreadyComplete,
      `an unreadable close-intent directory must never read as complete: ${r.stdout}`,
    );
    assert.equal(out.ok, false, `must fall through to the normal payload-required refusal`);
    assert.ok(
      /payload is required/.test(out.error || ''),
      `must surface the same refusal a torn set does: ${r.stdout}`,
    );
  });
});

// tier1 major finding 1b: a close-intent record survives forever if the
// session that wrote it crashed (it never calls clearCloseIntent), so
// without an expiry, one dead session's leftover record blocks every LATER
// session's no-payload probe permanently. A record older than
// CLOSE_INTENT_MAX_AGE_MS must stop counting as torn and get deleted, so the
// vault self-heals instead of staying stuck asking for a payload forever.
//
// Disabling the check: in hasTornCloseIntent, remove the `Date.now() -
// startedAt > CLOSE_INTENT_MAX_AGE_MS` branch (or hardcode it to `false`) so
// an old record is compared against disk like any other. This test goes red
// (alreadyComplete stays false, and the record is never deleted) while the
// unreadable-directory test above stays green.
test('probe (#39, tier1 major-1b): a close-intent record past its expiry window is deleted and does not block alreadyComplete', () => {
  withWiki(null, (dir, today) => {
    const intentDir = join(dir, '.cache', 'close-intent');
    mkdirSync(intentDir, { recursive: true });
    const recordPath = join(intentDir, 'dead-session.json');
    const staleStartedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString(); // just past the 30-minute window
    writeFileSync(
      recordPath,
      JSON.stringify({
        v: 1,
        // A hash that cannot match disk: if expiry did not fire, this would
        // read as torn, the same as the plain leftover-record test above.
        targets: [{ relPath: join('projects', 'test-project', 'hot.md'), hash: '0'.repeat(64) }],
        startedAt: staleStartedAt,
      }),
    );

    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `an expired record must not block the probe: ${r.stdout}`);
    assert.equal(
      out.alreadyComplete,
      true,
      `still eligible once its record has expired: ${r.stdout}`,
    );
    assert.equal(out.date, today);
    assert.ok(!existsSync(recordPath), 'the expired record must be deleted, not merely ignored');
  });
});

// codex 3rd-tier finding 4: hasTornCloseIntent's implementation already
// treats a truncated record and a non-array `targets` as `sawUnreadable`
// (never silently `clean`), but before these two tests, nothing in this
// suite pinned either shape: only a hash-mismatch ('torn') and an ENOTDIR
// directory ('unreadable', tier1 major-1a above) were covered. A regression
// that let a JSON.parse failure fall through to 'clean' (or dropped the
// `Array.isArray` guard) would pass every existing test in this file.
//
// Disabling the check: in hasTornCloseIntent, remove the `try { JSON.parse
// } catch { sawUnreadable = true }` branch (let a parse failure throw, or
// silently treat it as no record). This test goes red (alreadyComplete
// flips back to true) while the plain "no leftover record" probe test above
// stays green.
test('probe (#39, finding 4): a truncated close-intent record reads as unreadable, never clean', () => {
  withWiki(null, (dir) => {
    const intentDir = join(dir, '.cache', 'close-intent');
    mkdirSync(intentDir, { recursive: true });
    // Not valid JSON at all: exactly what a transcript half-written mid-crash
    // looks like on disk, not a shape any writer here ever intentionally produces.
    writeFileSync(
      join(intentDir, 'truncated-session.json'),
      '{"v":1,"attemptId":"abc","targets":[{"relPath":"pro',
    );

    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.ok(
      !out.alreadyComplete,
      `a truncated close-intent record must never read as complete: ${r.stdout}`,
    );
    assert.equal(out.ok, false, `must fall through to the normal payload-required refusal`);
    assert.ok(
      /payload is required/.test(out.error || ''),
      `must surface the same refusal a torn set does: ${r.stdout}`,
    );
  });
});

// Disabling the check: in hasTornCloseIntent, drop the `!Array.isArray(parsed.targets)`
// half of the shape guard (accept any `parsed.targets`, including `null`).
// This test goes red (alreadyComplete flips back to true, and the `for (const
// t of parsed.targets)` loop below it would throw on a real close instead) while
// the truncated-JSON test above stays green, isolating this specific shape gap.
test('probe (#39, finding 4): a close-intent record with targets:null reads as unreadable, never clean', () => {
  withWiki(null, (dir) => {
    const intentDir = join(dir, '.cache', 'close-intent');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(
      join(intentDir, 'null-targets-session.json'),
      JSON.stringify({
        v: 1,
        attemptId: 'abc',
        targets: null,
        startedAt: new Date().toISOString(),
      }),
    );

    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.ok(!out.alreadyComplete, `targets:null must never read as complete: ${r.stdout}`);
    assert.equal(out.ok, false, `must fall through to the normal payload-required refusal`);
    assert.ok(
      /payload is required/.test(out.error || ''),
      `must surface the same refusal a torn set does: ${r.stdout}`,
    );
  });
});

test('apply (#39): payload supplied + gate ok → still full apply (W1-2 guard, no --force)', () => {
  // Option D core invariant: payload presence = explicit close intent.
  // Same-day second close with a NEW sessionLog entry must land WITHOUT
  // requiring --force. fix #38's exact-entry dedup is the only safety net,
  // and a probe-style short-circuit here would re-introduce W1-2 silent drop.
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog.entry = `## [${today}] 2nd close\n\nnew body\n`;
    payload.log.entry = `## [${today}] session | test-project — 2nd\n`;
    const r = runApply(dir, payload); // no --force
    assert.equal(r.status, 0, `payload apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.ok(!out.alreadyComplete, 'payload path must run full apply, not probe');
    const sl = readFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
      'utf-8',
    );
    assert.ok(sl.includes('2nd close'), `2nd-close entry must land on disk: ${sl}`);
  });
});

test('probe (#39): --force without --payload → payload-required (force does NOT bypass payload gate)', () => {
  // Lock the documented contract: --force only bypasses the alreadyComplete
  // probe shortcut. Payload is always required for apply work. (Codex W1
  // single-worker review — missing edge-case lock.)
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      '--force',
      '--json',
    ]);
    assert.equal(r.status, 1, `--force alone must error, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(/payload is required/.test(out.error), `must surface payload-required: ${out.error}`);
  });
});

test('probe (#39): gate NOT ok + no payload → falls through to payload-required (no skip)', () => {
  // Stale gate must NOT trigger the alreadyComplete probe — fallthrough
  // surfaces the "payload is required" error so the caller knows to supply
  // close content. Stale here means no close today: the only session-log
  // heading is an old day's, and no entry is dated today (the generated
  // hot.md proves nothing either way).
  withWiki(
    (dir, today) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: 2020-01-01\n---\n\n## [2020-01-01] old session\n`,
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
      assert.equal(r.status, 1, `stale gate + no payload must error, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        /payload is required/.test(out.error),
        `must surface payload-required: ${out.error}`,
      );
    },
  );
});

test('payload via stdin (`--payload=-`) works the same as a file', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const sid = `stdin-apply-${process.pid}`;
    const cleanup = seedCloseTranscript(sid);
    let r;
    try {
      r = spawnSync(
        process.execPath,
        [
          join(REPO, 'scripts', 'crystallize.mjs'),
          `--hypo-dir=${dir}`,
          '--apply-session-close',
          '--payload=-',
          `--session-id=${sid}`,
          '--json',
        ],
        {
          input: JSON.stringify(payload),
          encoding: 'utf-8',
          env: { ...process.env, HOME: SESSION_TMP_HOME },
        },
      );
    } finally {
      cleanup();
    }
    assert.equal(r.status, 0, `stdin apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
  });
});

// ── fix #40: helper lint preflight + post-apply check ───────────────────────
suite('fix #40: helper lint preflight + post-apply check');

test('preflight (Bug B): pre-existing blocker in a NON-payload file → does NOT abort, apply proceeds (scoped)', () => {
  // Bug B fix: lint debt OUTSIDE the files this close writes (here a malformed
  // page under projects/, not a file this close writes) must NOT block the
  // documented apply path. It is surfaced as a notice and the payload lands.
  withWiki(
    (dir, today) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'broken.md'),
        '---\ntitle: broken\ntype: concept\n\nbody (frontmatter never closes)\n',
      );
      seedOpenQuestions()(dir, today);
    },
    (dir, today) => {
      // The overwrite field only writes cleanly with an observed, matching base
      // (FEAT-11 T4); seed it under the session-id this apply uses, or the
      // sentinel write is refused as base-unknown before it reaches the
      // out-of-scope-debt logic this test is actually about.
      const sid = 'preflight-bug-b-session';
      snapshotBase(dir, sid, overwriteTargets('test-project'));
      const sentinel = `<!-- preflight-sentinel-${Date.now()} -->`;
      const payload = payloadForCleanWiki(dir, today);
      payload.openQuestions = { content: `${openQuestionsText(today)}\n${sentinel}\n` };
      const r = runApply(dir, payload, { sessionId: sid });
      assert.equal(
        r.status,
        0,
        `apply should proceed past out-of-scope debt, got ${r.status}\n${r.stdout}`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.ok(
        out.notices.some((f) => f.endsWith('broken.md')),
        `out-of-scope blocker should surface as a notice: ${r.stdout}`,
      );
      const onDisk = readFileSync(join(dir, OQ_REL), 'utf-8');
      assert.ok(onDisk.includes(sentinel), 'apply should have written the payload sentinel');
    },
  );
});

test('apply notice scope: debt OUTSIDE the close project folds into otherDebtCount, not notices', () => {
  // The close project is test-project. Pre-existing lint debt under a DIFFERENT
  // project dir is real out-of-scope debt that must surface (never silently
  // dropped) but must NOT be named per-file — it folds into otherDebtCount so the
  // same untouched-file debt does not re-list its filenames on every close.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'projects', 'other-proj'), { recursive: true });
      writeFileSync(
        join(dir, 'projects', 'other-proj', 'broken.md'),
        '---\ntitle: broken\ntype: concept\n\nbody (frontmatter never closes)\n',
      );
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `apply should proceed past other-project debt: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.ok(
        out.otherDebtCount >= 1,
        `other-project debt should be counted in otherDebtCount: ${r.stdout}`,
      );
      assert.ok(
        !out.notices.some((f) => f.endsWith('broken.md')),
        `other-project debt must NOT be named in notices[] (it folds): ${r.stdout}`,
      );
    },
  );
});

test('apply lint output caps the warn list (model-context guard): full count + sample + remainder', () => {
  // result.lint is serialized into the --json apply result the close path reads,
  // and lint runs twice (preflight + post-apply), so an un-capped warn list would
  // land in model context twice on every close. The warns must collapse to a
  // count + small sample; errors stay full. (Internal pending-tag / blocking
  // logic still sees the full warn list — covered by other tests.)
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'bulk'), { recursive: true });
      // 12 pages, each with one broken wikilink → 12 W4 warnings, over the sample cap.
      for (let i = 0; i < 12; i++) {
        writeFileSync(
          join(dir, 'pages', 'bulk', `p${i}.md`),
          `---\ntitle: p${i}\ntype: concept\nupdated: 2026-06-28\n---\n\nsee [[does-not-exist-${i}]]\n`,
        );
      }
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `apply should succeed past warn debt: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      for (const phase of ['preflight', 'postApply']) {
        const l = out.lint[phase];
        assert.ok(
          l.warnCount >= 12,
          `${phase}.warnCount should be the full count: ${JSON.stringify(l)}`,
        );
        assert.ok(
          l.warns.length <= 10,
          `${phase}.warns should be capped to the sample: ${l.warns.length}`,
        );
        assert.equal(
          l.warnsTruncated,
          l.warnCount - l.warns.length,
          `${phase}.warnsTruncated should be the remainder: ${JSON.stringify(l)}`,
        );
      }
    },
  );
});

test('preflight (#40 + Bug B): corrupt APPEND target (session-log) STILL blocks — appending cannot repair it', () => {
  // The scoping carve-out preserves the #40 guarantee for append targets: a
  // pre-existing malformed session-log file is in the payload scope and is NOT an
  // overwrite target, so it must still abort preflight before any byte is written.
  withWiki(null, (dir, today) => {
    // The append target is now the daily shard (ADR 0050), so a corrupt daily
    // file is the in-scope, non-overwrite append target that must still block.
    writeFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
      '---\ntitle: sl\ntype: session-log\n\nbody (frontmatter never closes)\n',
    );
    const sentinel = `<!-- append-block-sentinel-${Date.now()} -->`;
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## 다음 작업\n\n- next\n`,
    };
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `corrupt append target must abort, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'preflight-lint', `stage should be preflight-lint: ${r.stdout}`);
    const sessionsDir = join(dir, 'projects', 'test-project', 'sessions');
    assert.deepEqual(
      existsSync(sessionsDir) ? readdirSync(sessionsDir) : [],
      [],
      'preflight failure must NOT have written the entry',
    );
    assert.ok(
      !JSON.stringify(readdirSync(join(dir, 'projects', 'test-project'))).includes(sentinel),
      sentinel,
    );
  });
});

test('post-apply (#40): payload introduces lint blocker → exit 1 stage=post-apply-lint, bytes written', () => {
  // The payload's open-questions page omits the required `title`: lint raises an
  // error, but the freshness gate still passes. Apply DID write (sentinel present on
  // disk), but the final result is ok:false with stage=post-apply-lint so the caller
  // distinguishes "wiki was damaged" from "frontmatter stale".
  withWiki(null, (dir, today) => {
    // The overwrite only writes cleanly with an observed, matching base (FEAT-11 T4);
    // seed it under the session-id this apply uses, or the write is refused as
    // base-unknown before it ever reaches post-apply lint.
    const sid = 'post-apply-lint-session';
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const sentinel = `<!-- post-apply-sentinel-${Date.now()} -->`;
    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = {
      content: `---\ntype: concept\nupdated: ${today}\n---\n\n${sentinel}\n`,
    };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(r.status, 1, `post-apply lint must fail, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'post-apply-lint', `stage should be post-apply-lint: ${r.stdout}`);
    // Lint failed before the commit, so the verification (read after the commit
    // step) does not decide this close. What it still shows: the session-log and
    // log.md lines are in place, and only the entry waits for the commit lint withheld.
    assert.equal(out.committed, null, 'a lint failure stops before the commit');
    assert.deepEqual(out.verification.missing, [], JSON.stringify(out.verification));
    assert.deepEqual(
      out.verification.stale,
      [out.verification.entry],
      JSON.stringify(out.verification),
    );
    const onDisk = readFileSync(join(dir, OQ_REL), 'utf-8');
    assert.ok(onDisk.includes(sentinel), 'post-apply path must have written the payload sentinel');
  });
});

test('preflight (#40 codex-P2): post-apply-lint failure + fixed payload retry → succeeds (no dead-lock)', () => {
  // Codex review of fix #40 caught a dead-lock: a payload that fails
  // post-apply-lint leaves the broken file on disk, and the retry hits
  // preflight on that same broken file → "fix payload and retry" is
  // impossible. Preflight must filter errors in files this apply will
  // overwrite. Lock the documented recovery path.
  withWiki(null, (dir, today) => {
    // Same session-id across both calls: the first write becomes this session's
    // new observed base (FEAT-11 T4 advanceBase), so the retry's overwrite still
    // sees a matching base instead of base-unknown.
    const sid = 'post-apply-retry-session';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    // 1. Apply a bad payload (open-questions page without a title)
    const bad = payloadForCleanWiki(dir, today);
    bad.openQuestions = { content: `---\ntype: concept\nupdated: ${today}\n---\n\n- bad\n` };
    const r1 = runApply(dir, bad, { sessionId: sid });
    assert.equal(r1.status, 1, `bad payload must fail: ${r1.stdout}`);
    assert.equal(JSON.parse(r1.stdout).stage, 'post-apply-lint');

    // 2. Retry with corrected payload — must succeed (was dead-locked before fix)
    const good = payloadForCleanWiki(dir, today);
    good.openQuestions = { content: openQuestionsText(today, 'fixed') };
    good.sessionLog.entry = `## [${today}] retry after fix\n`;
    good.log.entry = `## [${today}] session | test-project — retry\n`;
    const r2 = runApply(dir, good, { sessionId: sid });
    assert.equal(
      r2.status,
      0,
      `retry must succeed (P2 dead-lock regression), got ${r2.status}\n${r2.stdout}`,
    );
    const out = JSON.parse(r2.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.lint.postApply.ok, true, 'post-apply lint should now pass');
  });
});

// ── W9 promotion: payload-scope invalid-YAML frontmatter blocks close ─────────
// W9 (invalid-YAML frontmatter) is warn-severity in lint.mjs's default
// classification, not error, so it never reached the errors-only preflight/
// post-apply gate above without an operator opting into --strict. A wiki with
// no --lint-strict pre-commit hook installed could reach ok:true and exit 0
// with corrupt frontmatter sitting in a file this very close just wrote.
// runPreflight/runPostApplyLint (crystallize-close-apply.mjs) now promote a
// W9 warn to a close-blocking finding, but ONLY inside this close's own
// payload scope: legacy debt elsewhere in the vault (or a legacy vault's
// frontmatter-less log.md, W1) must stay untouched.
suite('W9 promotion: payload-scope invalid-YAML frontmatter blocks close');

test('post-apply: broken YAML in a payload-scope file (open-questions page) → ok:false, exit 1', () => {
  // "title: hot: broken" is an unquoted top-level value containing ": ", the
  // exact shape lint.mjs's checkYamlInvalid (W9) narrow detector flags. Not
  // W1: the frontmatter block itself opens and closes cleanly, only its
  // content is invalid YAML. The axis the suite tests is in-payload-scope versus
  // out-of-scope; open-questions is the one page a payload still writes whole.
  withWiki(null, (dir, today) => {
    const sid = 'w9-promotion-session';
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = {
      content: `---\ntitle: hot: broken\ntype: concept\nupdated: ${today}\n---\n\nbody\n`,
    };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(
      r.status,
      1,
      `broken YAML in a payload-scope file must abort the close: ${r.stdout}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'post-apply-lint', `stage should be post-apply-lint: ${r.stdout}`);
    const onDisk = readFileSync(join(dir, OQ_REL), 'utf-8');
    assert.ok(
      onDisk.includes('title: hot: broken'),
      'apply still writes the payload bytes to disk (post-apply lint runs AFTER the write)',
    );
  });
});

test('post-apply: pre-existing W9 debt OUTSIDE payload scope does not block close', () => {
  // The promotion is scoped exactly like the existing errors-only gate: a W9
  // warn under pages/ (this close never wrote there) must stay a non-blocking
  // notice, never swept into ok:false. Guards the promotion's own scope from
  // silently widening to the whole vault.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'w9-debt.md'),
        '---\ntitle: pre-existing debt\ntype: concept\nupdated: 2026-06-28\nnote: has: a colon\n---\n\nbody\n',
      );
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `out-of-scope W9 debt must not block the close: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    },
  );
});

test('append target with no frontmatter at all (W1, legacy log.md) still does not block close', () => {
  // The promotion matches ONLY the W9 message prefix. A legacy vault's
  // frontmatter-less log.md (W1, "No closed frontmatter block found") is a
  // documented, intentionally-unpromoted shape; this close path must keep
  // accepting it exactly as before.
  withWiki(
    (dir) => {
      writeFileSync(join(dir, 'log.md'), '# Wiki Log\n\nlegacy, no frontmatter\n');
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload);
      assert.equal(
        r.status,
        0,
        `W1 in a payload-scope append target must not block the close: ${r.stdout}`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    },
  );
});

// ── ISSUE-61: payload↔session binding (cross-session guard) ───────────────────
// The session-close payload temp path used to be date-based, so two same-day
// sessions clobbered each other's file; the winner's payload then applied under
// the loser's --session-id marker, and the loser's record vanished. Part 1 moves
// the documented path to a session-scoped name; this optional `sessionId` field
// is the second line of defense: when present it must equal --session-id, so a
// payload authored by another session is refused before any write. Absent → fail
// open (older payloads; Part 1 already prevents the collision).

suite('crystallize.mjs payload↔session binding (ISSUE-61)');

test('payload.sessionId ≠ --session-id → session-id-mismatch, zero bytes', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionId = 'authored-by-another-session';
    // A distinct entry a successful apply WOULD append. Its absence proves the
    // guard blocked the write — and proves the test red: strip the guard and the
    // unknown field is simply ignored, so this entry lands and the assert fails.
    // The payload also carries an entry that a successful apply writes BEFORE the
    // shard append. Assert the whole
    // committed tree is untouched — not just the shard — so a future guard misplaced
    // after the overwrites but before the append can't pass this vacuously. `git
    // diff --quiet` ignores the untracked .payload.json runApply drops in.
    const marker = `MISMATCH-MUST-NOT-APPEAR-${today}`;
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- ${marker}\n`,
    };
    payload.sessionLog = { entry: `## [${today}] ${marker}\n` };
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    const before = existsSync(shard) ? readFileSync(shard, 'utf-8') : '';

    const r = runApply(dir, payload, { sessionId: 'this-real-session' });
    assert.equal(r.status, 1, `mismatch must exit 1: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(
      out.stage,
      'session-id-mismatch',
      `stage must be session-id-mismatch: ${r.stdout}`,
    );
    assert.deepEqual(out.applied, [], 'nothing may be reported applied');
    // `null`, not `false`: this refusal fires before the commit step is ever
    // reached. `false` is reserved for a commit that ran and failed.
    assert.equal(out.committed, null, 'refused before the commit step ever ran');
    const tracked = spawnSync('git', ['diff', '--quiet'], { cwd: dir });
    assert.equal(tracked.status, 0, 'no committed file may be modified on reject');
    const after = existsSync(shard) ? readFileSync(shard, 'utf-8') : '';
    assert.equal(after, before, 'shard must be byte-untouched');
    assert.ok(!after.includes(marker), 'the payload entry must not have been appended');
  });
});

test('payload.sessionId == --session-id → proceeds past the guard', () => {
  withWiki(null, (dir, today) => {
    const sid = 'matching-session';
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionId = sid;
    payload.sessionLog = { entry: `## [${today}] match-entry\n` };
    payload.log = { entry: `## [${today}] session | test-project — match\n` };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(r.status, 0, `matching id must succeed: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.notEqual(out.stage, 'session-id-mismatch');
  });
});

test('payload without sessionId → guard fails open, apply proceeds', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    assert.equal(payload.sessionId, undefined, 'baseline payload carries no sessionId');
    payload.sessionLog = { entry: `## [${today}] no-sessionid-entry\n` };
    payload.log = { entry: `## [${today}] session | test-project — nosid\n` };
    const r = runApply(dir, payload, { sessionId: 'any-session' });
    assert.equal(r.status, 0, `absent sessionId must not block: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).ok, true);
  });
});

test('payload.sessionId non-string → payload schema invalid', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionId = 12345;
    const r = runApply(dir, payload, { sessionId: 'sid' });
    assert.equal(r.status, 1, `non-string sessionId must fail: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error, 'payload schema invalid');
    assert.ok(
      (out.details || []).some((d) => /sessionId/.test(d)),
      `details must flag sessionId: ${r.stdout}`,
    );
  });
});

test('payload.date calendar overflow (2026-09-31) → payload schema invalid, log.md untouched', () => {
  // A format-only regex reads 2026-09-31 as a valid YYYY-MM-DD literal, but
  // September has 30 days: `new Date('2026-09-31')` silently normalizes to
  // October 1 instead of failing, so the check used to let it through to
  // stamp a session-log heading and shard filename with a date that never
  // happened.
  withWiki(null, (dir, today) => {
    const before = readFileSync(join(dir, 'log.md'), 'utf-8');
    const payload = payloadForCleanWiki(dir, today);
    payload.date = '2026-09-31';
    const r = runApply(dir, payload, { sessionId: 'sid' });
    assert.equal(r.status, 1, `calendar-overflow date must fail: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error, 'payload schema invalid');
    assert.ok(
      (out.details || []).some((d) => /payload\.date/.test(d) && /real calendar date/.test(d)),
      `details must say the date does not exist, not only name the format: ${r.stdout}`,
    );
    assert.equal(readFileSync(join(dir, 'log.md'), 'utf-8'), before, 'log.md must be untouched');
  });
});

test('payload.sessionId null → treated as absent, guard fails open', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionId = null;
    payload.sessionLog = { entry: `## [${today}] null-sessionid-entry\n` };
    payload.log = { entry: `## [${today}] session | test-project — null\n` };
    const r = runApply(dir, payload, { sessionId: 'any-session' });
    assert.equal(r.status, 0, `null sessionId must fail open, not block: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).ok, true);
  });
});

test('payload.sessionId empty string → mismatches any real id, refused', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    // "" is a valid string (passes schema) but equals no real --session-id, so it
    // must reject rather than sneak through: an empty id is a bug, not a close.
    payload.sessionId = '';
    const r = runApply(dir, payload, { sessionId: 'real-session' });
    assert.equal(r.status, 1, `empty-string sessionId must be refused: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).stage, 'session-id-mismatch');
  });
});

suite('ISSUE-69: apply commits only the paths it actually wrote, not payloadScope');

// The apply-time commit (crystallize.mjs's own commitWikiChanges call, at the
// marker-write step) must be scoped to `appliedPaths` — the paths THIS close
// actually wrote a byte to — never the broader `payloadScope` it also builds
// (which additionally names lint/evidence candidates like the legacy monthly
// session-log fallback). A pre-existing, unrelated dirty file in the same
// working tree must not ride along in the commit this apply creates.
test('apply commit excludes an unrelated pre-existing dirty file outside the payload', () => {
  withWiki(null, (dir, today) => {
    // A dirty file this close's payload never names — simulates lint/evidence
    // debt elsewhere in the vault that must not be swept into THIS commit.
    writeFileSync(join(dir, 'unrelated-debt.md'), '# pre-existing, unrelated debt\n');

    const payload = payloadForCleanWiki(dir, today);
    // The close writes its entry, the session-log shard and log.md, and must
    // commit exactly those: the scoped commit is what this test pins.
    const r = runApply(dir, payload, { sessionId: 'sess-issue69-apply' });
    assert.equal(r.status, 0, `apply must succeed: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `expected ok:true: ${r.stdout}`);

    const committedAtHead = spawnSync(
      'git',
      ['-C', dir, 'show', '--name-only', '--pretty=format:', 'HEAD'],
      { encoding: 'utf-8' },
    ).stdout;
    assert.ok(
      /log\.md/.test(committedAtHead),
      `log.md (an actual apply write) must be committed: ${committedAtHead}`,
    );
    assert.ok(
      !/unrelated-debt\.md/.test(committedAtHead),
      `unrelated-debt.md must NOT be swept into the apply's commit: ${committedAtHead}`,
    );

    // The dirty file must be left exactly as apply found it: uncommitted,
    // not silently staged either.
    const status = spawnSync('git', ['-C', dir, 'status', '--porcelain', 'unrelated-debt.md'], {
      encoding: 'utf-8',
    }).stdout;
    assert.ok(
      /unrelated-debt\.md/.test(status),
      `unrelated-debt.md must remain dirty, untouched by apply: ${status}`,
    );
  });
});

suite('A-1 (project index lifecycle): apply creates a missing index.md');

// SCHEMA.md declares project-index at projects/*/index.md and
// templates/projects/_template/ ships one, but nothing wrote it for a project
// created outside createProject (buildCleanWikiTree's test-project has no
// index.md, mirroring that gap). apply now fills it on the project's first
// close, substituting only the three tokens the template defines.
test('apply on a project with no index.md creates one from the template, tokens substituted', () => {
  withWiki(null, (dir, today) => {
    const indexPath = join(dir, 'projects', 'test-project', 'index.md');
    assert.ok(!existsSync(indexPath), 'fixture must start without an index.md');

    const payload = payloadForCleanWiki(dir, today);
    const r = runApply(dir, payload, { sessionId: 'sess-index-create' });
    assert.equal(r.status, 0, `apply must succeed: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `expected ok:true: ${r.stdout}`);
    assert.ok(
      out.applied.some((a) => a.startsWith('projectIndex (')),
      `applied must record the created index: ${JSON.stringify(out.applied)}`,
    );

    assert.ok(existsSync(indexPath), 'index.md must now exist');
    const content = readFileSync(indexPath, 'utf-8');
    assert.ok(
      content.includes('title: test-project — Index'),
      `slug not substituted into title: ${content}`,
    );
    assert.ok(content.includes('# test-project'), `slug not substituted into heading: ${content}`);
    assert.ok(content.includes(`started: ${today}`), `started not substituted: ${content}`);
    assert.ok(content.includes(`updated: ${today}`), `updated not substituted: ${content}`);
    assert.ok(
      !content.includes('<project-name>') &&
        !content.includes('<started>') &&
        !content.includes('<working_dir>'),
      `unsubstituted template token leaked: ${content}`,
    );
    // working_dir must be EMPTY, not a placeholder string. A truthy placeholder
    // reads as "already anchored" to the collector/backfill logic below and
    // would permanently swallow the real anchor-recovery path (the bug this
    // pins — a prior version filled this with prose text).
    assert.match(
      content,
      /^working_dir:\s*$/m,
      `working_dir must be empty, not a fake placeholder: ${content}`,
    );

    // BLOCKER regression (a): the auto-created index must be lint-clean on its
    // own merits, independent of apply's internal post-apply-lint scoping.
    const lintOut = JSON.parse(run('lint.mjs', [`--hypo-dir=${dir}`, '--json']).stdout);
    const indexErrors = (lintOut.errors || []).filter(
      (e) => e.file === 'projects/test-project/index.md',
    );
    assert.deepEqual(
      indexErrors,
      [],
      `auto-created index must not trip lint errors: ${JSON.stringify(indexErrors)}`,
    );
    // CONCERN 1 (2nd round): a missing anchor is expected to surface as a
    // visible W13 WARNING (not silence, not an error) so it doesn't sit
    // invisible until a manual `doctor` run. Matched by message (not `id`):
    // non-strict --json deliberately omits the `id` field on every
    // warning class except W8 and W19 (lint.mjs's byte-identical-default guarantee).
    assert.ok(
      (lintOut.warns || []).some(
        (w) =>
          w.file === 'projects/test-project/index.md' && w.message.includes('working_dir anchor'),
      ),
      `auto-created index with an empty anchor must surface a working_dir-anchor warning: ${JSON.stringify(lintOut.warns)}`,
    );

    // BLOCKER regression (b): the empty working_dir must NOT read as
    // "already anchored" — findBackfillCandidate must still offer to backfill
    // this project's real cwd.
    const candidate = findBackfillCandidate('/Users/dev/test-project', dir);
    assert.ok(
      candidate,
      'an auto-created index with an empty working_dir must still be a backfill candidate',
    );
    assert.equal(candidate.slug, 'test-project');
    assert.equal(candidate.hasIndex, true);
  });
});

test('apply aborted at preflight-lint never creates the index (no side effect on a failed close)', () => {
  withWiki(null, (dir, today) => {
    // Reuses the proven "corrupt APPEND target still blocks" preflight-abort
    // shape: a session-log daily shard with an unclosed frontmatter fence is an
    // in-scope, non-overwrite append target preflight cannot filter out — here
    // to prove the SAME abort leaves the index untouched.
    writeFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
      '---\ntitle: sl\ntype: session-log\n\nbody (frontmatter never closes)\n',
    );
    const indexPath = join(dir, 'projects', 'test-project', 'index.md');
    assert.ok(!existsSync(indexPath), 'fixture must start without an index.md');
    const payload = payloadForCleanWiki(dir, today);
    const r = runApply(dir, payload, { sessionId: 'sess-index-preflight-abort' });
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false, `expected preflight to abort: ${r.stdout}`);
    assert.equal(out.stage, 'preflight-lint', `expected preflight-lint stage: ${r.stdout}`);
    assert.ok(
      !existsSync(indexPath),
      'a preflight abort must not create the index as a side effect',
    );
  });
});

// CONCERN 2 (TOCTOU): the caller's `indexMissing` flag is snapshotted early
// (before preflight lint), then acted on later. Reproduce the race directly at
// ensureProjectIndex's own boundary — a file lands at the destination between
// when a caller last observed "missing" and this call — and assert the
// winner's bytes survive. A plain existsSync-then-atomicWrite (tmp+rename)
// would clobber it: rename replaces whatever sits at the destination the
// instant it fires, existing or not.
test("ensureProjectIndex: a file created after the caller's missing-check survives untouched (no-replace create)", () => {
  withTmpDir((dir) => {
    const relPath = join('projects', 'race-project', 'index.md');
    const dest = join(dir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    const winnerContent =
      '---\ntitle: race — Index\ntype: project-index\nstatus: active\nstarted: 2026-01-01\nupdated: 2026-01-01\nworking_dir: /real/path\n---\n\nwinner bytes, written after the caller believed this was missing\n';
    // Simulates: caller checked indexMissing (got true), THEN another writer
    // (human or a concurrent close) created the file, THEN this call runs.
    writeFileSync(dest, winnerContent);
    const result = ensureProjectIndex(dir, 'race-project', relPath, '2026-06-01');
    assert.equal(
      result,
      null,
      'ensureProjectIndex must report a no-op, not a create, on this race',
    );
    assert.equal(
      readFileSync(dest, 'utf-8'),
      winnerContent,
      "the winner's bytes must survive byte-for-byte, never clobbered by the losing create",
    );
  });
});

test('apply on a project that already has an index.md leaves it byte-for-byte untouched', () => {
  const existingIndex =
    '---\ntitle: test-project — Index\ntype: project-index\nstatus: active\nstarted: 2026-01-01\nupdated: 2026-01-01\nworking_dir: /real/path\n---\n\n# test-project\n\nhand-written content\n';
  withWiki(
    (dir) => writeFileSync(join(dir, 'projects', 'test-project', 'index.md'), existingIndex),
    (dir, today) => {
      const indexPath = join(dir, 'projects', 'test-project', 'index.md');
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload, { sessionId: 'sess-index-keep' });
      assert.equal(r.status, 0, `apply must succeed: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `expected ok:true: ${r.stdout}`);
      assert.ok(
        !out.applied.some((a) => a.startsWith('projectIndex (')),
        `an existing index must never be reported as applied: ${JSON.stringify(out.applied)}`,
      );
      assert.equal(
        readFileSync(indexPath, 'utf-8'),
        existingIndex,
        'a pre-existing index.md must be left byte-for-byte untouched',
      );
    },
  );
});

// ── every whole-file base-mismatch parks ─────────────────────────────────────
// Root hot.md is a shared pointer table, and two machines editing DIFFERENT rows
// produce a whole-file base-mismatch that reads as a collision even though nothing
// collided. Five predicates tried to recognise that case and skip the park; four
// review rounds broke all five against the real vault, the last by inserting a row
// between a table's header and its separator. So there is no escape any more: a
// mismatch parks, and a human resolves it through challenge and resolve.

suite('every whole-file base-mismatch parks');

test('an overwrite target parks on a mismatch even when the payload keeps every disk line', () => {
  // A foreign write lands after the snapshot, the payload carries every byte of it
  // plus one more, and the close still parks rather than write.
  withWiki(seedOpenQuestions(), (dir, today) => {
    const sid = 'mismatch-parks';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    const original = readFileSync(join(dir, OQ_REL), 'utf-8');
    const drifted = `${original.trimEnd()}\n\n## Added by the other machine\n`;
    writeFileSync(join(dir, OQ_REL), drifted);

    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = { content: `${drifted.trimEnd()}\n\n## And by this session\n` };

    const r = runApply(dir, payload, { sessionId: sid });
    assert.notEqual(r.status, 0, 'a drifted overwrite must not write');
    const out = JSON.parse(r.stdout);
    const c = out.conflicts.find((x) => x.target === OQ_REL);
    assert.ok(c, `${OQ_REL} must park: ${JSON.stringify(out.conflicts)}`);
    assert.equal(c.reason, 'base-mismatch');
    assert.equal(
      readFileSync(join(dir, OQ_REL), 'utf-8'),
      drifted,
      "the other machine's bytes are left exactly as they were",
    );
  });
});

// The other half of the same change: the root pointer table can no longer park,
// because nothing in a close writes it any more. An installed copy running the
// previous `commands/crystallize.md` still composes `rootHot` into every
// payload, and that payload must close cleanly while leaving the file alone.
//
// Three things are pinned at once, and they fail separately. A re-added
// `overwrite('rootHot', ...)` reddens the disk assertion. A re-added base
// snapshot for hot.md (plus that overwrite) reddens the conflicts assertion. A
// silent drop of the field, which is what a bare delete would have produced,
// reddens the notices assertion.
test('a legacy payload carrying rootHot closes clean, writes nothing to hot.md, and says so', () => {
  withWiki(null, (dir, today) => {
    const sid = 'legacy-roothot';
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const before = readFileSync(join(dir, 'hot.md'), 'utf-8');

    const payload = payloadForCleanWiki(dir, today);
    payload.rootHot = { content: `${before.trimEnd()}\n| ghost | ${today} | [[x]] |\n` };

    const r = runApply(dir, payload, { sessionId: sid });
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `an obsolete field must not fail the close: ${r.stdout}`);
    assert.deepEqual(out.conflicts ?? [], [], `rootHot must not park: ${r.stdout}`);
    assert.equal(
      readFileSync(join(dir, 'hot.md'), 'utf-8'),
      before,
      'the root pointer table must be left exactly as the hooks last wrote it',
    );
    assert.ok(
      !(out.applied ?? []).some((a) => a.startsWith('rootHot')),
      `rootHot must not be reported as written: ${JSON.stringify(out.applied)}`,
    );
    assert.ok(
      (out.notices ?? []).some((n) => /rootHot was ignored/.test(n)),
      `the ignored field must be reported, not dropped in silence: ${JSON.stringify(out.notices)}`,
    );
  });
});

// ── local edit protection: reapplying a payload must not bury a hand edit ────
// applySessionClose's overwrite guard already parks a FOREIGN write (a
// different session/machine moved the target since this session's base). A
// hand edit through THIS session's own Write/Edit tool legitimately advances
// the base too (advanceBaseForWrite, wired from hypo-auto-stage.mjs), by
// design, so a session that edits a target directly and then composes ITS
// NEXT payload from that edit does not park on its own work. The gap: reapply
// the SAME, now-stale payload after such an edit, and disk-equals-base reads
// as "nothing to protect": the edit is buried with no proposal, no notice.
// `readAppliedHash` (base-store's "applied set") closes it: it tracks what
// THIS overwrite call itself last wrote, which a hand edit never touches.

suite('local edit protection: reapplying a payload must not bury a hand edit');

test('a hand edit after a successful apply parks a reapply of the SAME payload, and survives it', () => {
  withWiki(seedOpenQuestions(), (dir, today) => {
    const sid = 'local-edit-reapply';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    const rel = OQ_REL;
    const target = join(dir, rel);
    const appliedContent = `---\ntitle: Open Questions\ntype: concept\nupdated: ${today}\n---\n\napplied by payload\n\n## Questions\n\n- next\n`;
    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = { content: appliedContent };

    const r1 = runApply(dir, payload, { sessionId: sid });
    assert.equal(r1.status, 0, `first apply must succeed: ${r1.stdout}\n${r1.stderr}`);
    assert.equal(readFileSync(target, 'utf-8'), appliedContent);

    // A hand edit through this session's own Write/Edit tool: it changes disk
    // AND advances the base, exactly as hypo-auto-stage.mjs's PostToolUse
    // hook does after a real Edit call (advanceBaseForWrite is the production
    // wiring; this test calls it directly instead of spawning that hook).
    // Committed via git before the reapply, mirroring the 2026-08-06
    // security-backoffice repro (workspace cleaned, then the same payload
    // re-applied).
    const handEdited = appliedContent.replace('applied by payload', 'hand-edited after apply');
    writeFileSync(target, handEdited);
    advanceBaseForWrite(dir, sid, rel, target);
    // HOME pinned to SESSION_TMP_HOME (review r5-w3 minor): every process a
    // test spawns must not see the developer's real $HOME, same rule
    // makeGitRepo() already follows elsewhere in this suite.
    spawnSync('git', ['add', '-A'], { cwd: dir, env: { ...process.env, HOME: SESSION_TMP_HOME } });
    spawnSync('git', ['commit', '-m', 'hand edit'], {
      cwd: dir,
      env: { ...process.env, HOME: SESSION_TMP_HOME },
    });

    // r1 already spent this session's one close signal (the marker landed).
    // A real second close needs a fresh close phrase from the user, so seed
    // one (a second transcript record past the one the first apply resolved)
    // rather than reuse r1's now-consumed seed. This is orthogonal to the
    // bug under test; without it the reapply refuses at the authority gate,
    // before ever reaching the overwrite guard this test means to exercise.
    const cleanup2 = seedCloseTranscript(sid, {
      toolUseLines: [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '수정 반영해서 다시 세션 마무리 해줘' },
        }),
      ],
    });
    try {
      // Reapply the SAME (now-stale) payload object: it still asks for
      // `appliedContent`, which is no longer what is on disk.
      const r2 = runApply(dir, payload, { sessionId: sid });
      assert.notEqual(r2.status, 0, 'a reapply that would bury a local edit must not exit 0');
      const out2 = JSON.parse(r2.stdout);
      const c = out2.conflicts.find((x) => x.target === rel);
      assert.ok(c, `openQuestions must park: ${JSON.stringify(out2.conflicts)}`);
      assert.equal(c.reason, 'will-overwrite-local-change');
      assert.equal(
        readFileSync(target, 'utf-8'),
        handEdited,
        'the hand edit must survive the reapply untouched',
      );
    } finally {
      cleanup2();
    }
  });
});

test('a reapply with NO intervening edit still writes a genuinely new payload through (no false park)', () => {
  withWiki(seedOpenQuestions(), (dir, today) => {
    const sid = 'local-edit-no-edit-inbetween';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    const rel = OQ_REL;
    const target = join(dir, rel);
    const appliedContent = `---\ntitle: Open Questions\ntype: concept\nupdated: ${today}\n---\n\napplied by payload\n\n## Questions\n\n- next\n`;
    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = { content: appliedContent };

    const r1 = runApply(dir, payload, { sessionId: sid });
    assert.equal(r1.status, 0, `first apply must succeed: ${r1.stdout}\n${r1.stderr}`);

    // A genuinely NEW payload for the same field, no hand edit in between --
    // the ordinary "second close in the same session" case invariant 2 exists
    // for. It must still write through. Needs its own fresh close phrase for
    // the same reason as the sibling test above: r1 already spent this
    // session's close signal.
    const cleanup2 = seedCloseTranscript(sid, {
      toolUseLines: [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '한 번 더 세션 마무리 해줘' },
        }),
      ],
    });
    try {
      const payload2 = payloadForCleanWiki(dir, today);
      const updatedContent = appliedContent.replace('applied by payload', 'second close, no edit');
      payload2.openQuestions = { content: updatedContent };
      const r2 = runApply(dir, payload2, { sessionId: sid });
      assert.equal(
        r2.status,
        0,
        `second, genuinely-new payload must apply: ${r2.stdout}\n${r2.stderr}`,
      );
      assert.equal(readFileSync(target, 'utf-8'), updatedContent);
    } finally {
      cleanup2();
    }
  });
});

test('a hand edit folded into a genuinely new payload STILL parks (review r5-w3 blocker 2 supersedes r4-w4 major 1)', () => {
  // r4-w4 major 1 narrowed the guard to `payloadHash === appliedHash` so that
  // a payload folding the hand edit in, plus a legitimate new close on top,
  // would pass with no park. This test used to assert exactly that (r2.status
  // === 0). review r5-w3 blocker 2 found the hole that narrowing opened: from
  // hashes alone, `overwriteConflictReason` cannot tell "this new payload
  // folds the edit in" from "this new payload is unrelated bytes that still
  // ignore the edit": both are simply "payload != old applied bytes". So ANY
  // payload change parked was the wrong fix in the other direction: it let an
  // ignored-edit payload through unchallenged. The guard now parks on ANY
  // drift from `appliedHash`, folded-in or not, and a human decides through
  // `proposal challenge`/`proposal resolve`: this is the accepted friction
  // cost, not a bug.
  withWiki(seedOpenQuestions(), (dir, today) => {
    const sid = 'local-edit-folded-payload';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    const rel = OQ_REL;
    const target = join(dir, rel);
    const appliedContent = `---\ntitle: Open Questions\ntype: concept\nupdated: ${today}\n---\n\napplied by payload\n\n## Questions\n\n- next\n`;
    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = { content: appliedContent };

    const r1 = runApply(dir, payload, { sessionId: sid });
    assert.equal(r1.status, 0, `first apply must succeed: ${r1.stdout}\n${r1.stderr}`);

    const handEdited = appliedContent.replace('applied by payload', 'hand-edited after apply');
    writeFileSync(target, handEdited);
    advanceBaseForWrite(dir, sid, rel, target);
    // HOME pinned to SESSION_TMP_HOME (review r5-w3 minor): every process a
    // test spawns must not see the developer's real $HOME, same rule
    // makeGitRepo() already follows elsewhere in this suite.
    spawnSync('git', ['add', '-A'], { cwd: dir, env: { ...process.env, HOME: SESSION_TMP_HOME } });
    spawnSync('git', ['commit', '-m', 'hand edit'], {
      cwd: dir,
      env: { ...process.env, HOME: SESSION_TMP_HOME },
    });

    const cleanup2 = seedCloseTranscript(sid, {
      toolUseLines: [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '수정 반영해서 다시 세션 마무리 해줘' },
        }),
      ],
    });
    try {
      // The new payload FOLDS the hand edit in (keeps "hand-edited after
      // apply") and adds a genuinely new close on top, neither identical to
      // the first apply's bytes nor to the hand edit alone. It still parks:
      // the guard has no way to credit it for folding the edit in.
      const folded = handEdited.replace('- next', '- next\n- folded the hand edit in, plus this');
      const payload2 = payloadForCleanWiki(dir, today);
      payload2.openQuestions = { content: folded };
      const r2 = runApply(dir, payload2, { sessionId: sid });
      assert.notEqual(
        r2.status,
        0,
        `a payload folding the hand edit in must still park, not apply: ${r2.stdout}\n${r2.stderr}`,
      );
      const out2 = JSON.parse(r2.stdout);
      const c = out2.conflicts.find((x) => x.target === rel);
      assert.ok(c, `openQuestions must park: ${JSON.stringify(out2.conflicts)}`);
      assert.equal(c.reason, 'will-overwrite-local-change');
      assert.equal(
        readFileSync(target, 'utf-8'),
        handEdited,
        'the hand edit must survive untouched: the folded payload never lands',
      );
    } finally {
      cleanup2();
    }
  });
});

test('a genuinely different payload that does NOT fold the hand edit in also parks (review r5-w3 blocker 2)', () => {
  // This is the actual hole review r5-w3 named: r4-w4's `payloadHash ===
  // appliedHash` narrowing only caught the exact stale reapply. A payload
  // that changed for some OTHER reason and simply never accounted for the
  // hand edit (unlike the sibling test above, this one does not even
  // contain the edit's text) used to pass the narrowed check by merely being
  // different from the old applied bytes, silently discarding the edit with
  // no proposal. It must now park exactly like the exact-reapply and the
  // folded-payload cases.
  withWiki(seedOpenQuestions(), (dir, today) => {
    const sid = 'local-edit-unrelated-payload';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    const rel = OQ_REL;
    const target = join(dir, rel);
    const appliedContent = `---\ntitle: Open Questions\ntype: concept\nupdated: ${today}\n---\n\napplied by payload\n\n## Questions\n\n- next\n`;
    const payload = payloadForCleanWiki(dir, today);
    payload.openQuestions = { content: appliedContent };

    const r1 = runApply(dir, payload, { sessionId: sid });
    assert.equal(r1.status, 0, `first apply must succeed: ${r1.stdout}\n${r1.stderr}`);

    const handEdited = appliedContent.replace('applied by payload', 'hand-edited after apply');
    writeFileSync(target, handEdited);
    advanceBaseForWrite(dir, sid, rel, target);
    spawnSync('git', ['add', '-A'], { cwd: dir, env: { ...process.env, HOME: SESSION_TMP_HOME } });
    spawnSync('git', ['commit', '-m', 'hand edit'], {
      cwd: dir,
      env: { ...process.env, HOME: SESSION_TMP_HOME },
    });

    const cleanup2 = seedCloseTranscript(sid, {
      toolUseLines: [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '완전히 다른 내용으로 다시 세션 마무리 해줘' },
        }),
      ],
    });
    try {
      // Different from BOTH the original apply and the hand edit, and does
      // NOT carry "hand-edited after apply" forward at all: the shape review
      // r5-w3 blocker 2 called out as unprotected.
      const unrelated = `---\ntitle: Open Questions\ntype: concept\nupdated: ${today}\n---\n\nunrelated new content, does not mention the edit\n\n## Questions\n\n- something else\n`;
      const payload2 = payloadForCleanWiki(dir, today);
      payload2.openQuestions = { content: unrelated };
      const r2 = runApply(dir, payload2, { sessionId: sid });
      assert.notEqual(
        r2.status,
        0,
        `an unrelated payload that ignores the hand edit must park, not apply: ${r2.stdout}\n${r2.stderr}`,
      );
      const out2 = JSON.parse(r2.stdout);
      const c = out2.conflicts.find((x) => x.target === rel);
      assert.ok(c, `openQuestions must park: ${JSON.stringify(out2.conflicts)}`);
      assert.equal(c.reason, 'will-overwrite-local-change');
      assert.equal(
        readFileSync(target, 'utf-8'),
        handEdited,
        'the hand edit must survive: the unrelated payload never lands, and is not silently discarded',
      );
    } finally {
      cleanup2();
    }
  });
});

// ── ISSUE-149: restructure:true is no longer a self-approved bypass ──────────
// A payload that drops most of an overwrite target's `## ` sections used to
// write straight through the moment `restructure: true` was set on that field
// (a boolean the SAME model composing the payload also controls), with no
// human between the claim and the disk write. It now parks exactly like a
// base conflict: the target is withheld, a `.cache/proposals/` artifact is
// written, and only `hypomnema proposal challenge` / `proposal resolve` (a
// human typing a nonce after reviewing the diff) can land it.

suite('ISSUE-149: restructure:true no longer self-approves a destructive overwrite');

test('a real section-loss trip parks whether or not restructure:true is set: the flag only changes the park reason', () => {
  withWiki(
    (dir, today) => {
      seedOpenQuestions(
        openQuestionsText(today) +
          `\n## Track A\nnote A\n\n## Track B\nnote B\n\n## Track C\nnote C\n`,
      )(dir, today);
    },
    (dir, today) => {
      const sid = 'issue149-restructure-park';
      snapshotBase(dir, sid, overwriteTargets('test-project'));
      const hotPath = join(dir, OQ_REL);
      const multiTrack = readFileSync(hotPath, 'utf-8');
      // Drops Track B and Track C, keeps Track A: the same 2-of-3 shape the
      // real incident (security-backoffice) tripped on.
      const onlyTrackA = multiTrack.replace(/\n## Track B[\s\S]*## Track C\nnote C\n/, '\n');
      const target = OQ_REL;

      // Phase 1: no `restructure` flag, the pre-existing guard, unchanged.
      const payload1 = payloadForCleanWiki(dir, today);
      payload1.openQuestions = { content: onlyTrackA };
      const r1 = runApply(dir, payload1, { sessionId: sid });
      const out1 = JSON.parse(r1.stdout);
      assert.notEqual(r1.status, 0, `dropping 2 of 3 sections must park: ${r1.stdout}`);
      const c1 = out1.conflicts.find((x) => x.target === target);
      assert.ok(c1, `must be reported as a conflict: ${JSON.stringify(out1.conflicts)}`);
      assert.equal(c1.reason, 'section-loss-guard');
      assert.equal(readFileSync(hotPath, 'utf-8'), multiTrack, 'target must stay untouched');

      // Phase 2: SAME session, SAME drop, but with `restructure: true` set,
      // this is the exact payload shape that used to write straight through.
      // The first attempt never reached the marker phase (ok:false), so it
      // recorded no close-gate resolution; the session's original close
      // signal is still open for this retry, mirroring every other
      // park-then-retry test in this suite.
      const payload2 = payloadForCleanWiki(dir, today);
      payload2.openQuestions = { content: onlyTrackA, restructure: true };
      payload2.sessionLog.entry = `## [${today}] restructure retry\n`;
      payload2.log.entry = `## [${today}] session | test-project — restructure retry\n`;
      const r2 = runApply(dir, payload2, { sessionId: sid });
      const out2 = JSON.parse(r2.stdout);
      assert.notEqual(
        r2.status,
        0,
        `restructure:true must NOT let the write through on its own (ISSUE-149): ${r2.stdout}`,
      );
      assert.equal(
        readFileSync(hotPath, 'utf-8'),
        multiTrack,
        'target must stay untouched even with restructure:true: a model-set flag is not human approval',
      );
      const c2 = out2.conflicts.find((x) => x.target === target);
      assert.ok(
        c2,
        `restructure:true must still be reported as a withheld conflict: ${JSON.stringify(out2.conflicts)}`,
      );
      assert.equal(c2.reason, 'section-loss-guard-restructure-pending');
      assert.ok(
        /proposal challenge/.test(c2.why),
        `the park reason must point at the human-approval door: ${c2.why}`,
      );
      const proposalEntry = out2.proposals.find((p) => p.target === target);
      assert.ok(
        proposalEntry,
        'the withheld restructure must still be parked as a reviewable proposal, same as any other conflict',
      );
      // The model's claim survives as an audit trail even though it no longer
      // decides anything. The human reviewing the parked proposal sees that
      // the payload author believed this drop was intentional.
      assert.deepEqual(
        out2.restructureWaivers,
        [{ target, lostSections: ['## Track B', '## Track C'] }],
        `the restructure claim must still be recorded verbatim: ${JSON.stringify(out2.restructureWaivers)}`,
      );
    },
  );
});

// ── ISSUE-153: a genuinely failed marker write must not exit 0 ───────────────
// `--mark-session-closed` already refuses (exit 1) when the marker file fails
// to land after every precondition (gate ok, user signal, a clean commit) has
// already cleared. `--apply-session-close` used to swallow that exact same
// failure as ok:true / exit 0. The same failure landing on two different
// exit codes depending on which command hit it. The fix is scoped to that one
// failure mode (`marker-did-not-land`): the OTHER skip reasons
// (compact-gate-not-ok, no-user-close-signal, transcript-unresolved,
// commit-failed) are conditions this session can clear and retry, and stay
// ok:true by design (see "a marker withheld by a real vault-commit failure
// leaves the close signal unspent for a retry" in tests/close-hooks-gate.test.mjs
// and the ISSUE-140 test in tests/close-global.test.mjs, both of which pin
// that ok:true must survive those).

suite('ISSUE-153: a marker write that genuinely fails must not exit 0');

test('markerWriteGenuinelyFailed only flags the disk-level reason, never a policy withhold', () => {
  assert.equal(
    markerWriteGenuinelyFailed({ markerWritten: false, markerSkipReason: 'marker-did-not-land' }),
    true,
  );
  for (const reason of [
    'compact-gate-not-ok',
    'no-user-close-signal',
    'transcript-unresolved',
    'commit-failed: not a repo',
  ]) {
    assert.equal(
      markerWriteGenuinelyFailed({ markerWritten: false, markerSkipReason: reason }),
      false,
      `${reason} must stay a legitimate, retryable withhold`,
    );
  }
  assert.equal(
    markerWriteGenuinelyFailed({ markerWritten: true, markerSkipReason: null }),
    false,
    'a landed marker is never a failure',
  );
});

// ISSUE-171 interaction: `refuseUnlessCloseRequested` now calls
// `invalidateCloseArtifacts` for THIS session's own marker path the moment a
// new close is authorized, before any write (design.md v5 §1). That call
// renames away whatever currently sits at `sessionClosedMarkerPath` (file
// or directory, contents irrelevant, a plain rename to a fresh name never
// cares about the source's type), so a directory pre-occupying the marker's
// own filename (ISSUE-153's original fixture) is cleared before this apply
// ever reaches the marker write. The scenario below is what that leaves
// behind: the stray directory self-heals and the close now succeeds, rather
// than the old disk-level EISDIR this test used to pin.
test('marker path pre-occupied by a directory is invalidated away before the marker write (ISSUE-171 self-heal)', () => {
  withWiki(null, (dir, today) => {
    const sessionId = 'issue153-marker-blocked';
    mkdirSync(sessionClosedMarkerPath(dir, sessionId), { recursive: true });
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog.entry = `## [${today}] issue-153 marker blocked\n`;
    payload.log.entry = `## [${today}] session | test-project — issue-153\n`;
    const r = runApply(dir, payload, { sessionId });
    const out = JSON.parse(r.stdout);
    assert.equal(
      r.status,
      0,
      `the stray directory is invalidated away before the marker write, so this close now succeeds: ${r.stdout}\n${r.stderr}`,
    );
    assert.equal(out.ok, true);
    assert.equal(out.markerWritten, true, `marker write must land: ${r.stdout}`);
    assert.equal(out.committed, true);
    // The invalidated directory is renamed aside, not deleted: the marker
    // filename itself is now a plain file again.
    assert.equal(statSync(sessionClosedMarkerPath(dir, sessionId)).isDirectory(), false);
  });
});

// ── hostTagWarning: one warning, three consumers, wired end to end ──────────
// closeGateStatus computes this once (see tests/close-gate-store.test.mjs's
// own "B residual" suite, which pins that it is present or absent there). What
// that suite does NOT reach is applySessionClose's own wiring: eleven call
// sites thread the same value from verifyCloseAuthority through
// runMarkerPhase, buildCloseResult, and printCloseReport, and nothing pinned
// that the value actually lands in the marker file, the --json result, and
// the console rendering it is supposed to reach. Three separate tests, one
// per consumer, plus a negative control, so cutting any one wire fails on its
// own rather than hiding behind the other two.

const HOST_TAG_ENQUEUE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<agent-message from="peer">still working</agent-message>',
});

// Mirrors helpers.mjs's runApply, minus the forced --json flag: the console
// (human-readable) rendering only ever prints on the non-json path, and
// runApply always adds --json. The caller seeds and cleans up its own
// transcript with seedCloseTranscript, same as runApply does internally; kept
// local since only this suite needs a non-json apply runner.
function runApplyConsole(dir, payload, sessionId) {
  const payloadPath = join(
    tmpdir(),
    `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
  );
  writeFileSync(payloadPath, JSON.stringify(payload));
  try {
    return run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      `--payload=${payloadPath}`,
      `--session-id=${sessionId}`,
    ]);
  } finally {
    // After run() returns, not before: the child reads this file. Left behind,
    // one payload per invocation accumulates in the session temp dir for the
    // life of the machine, which is the kind of litter a shard-parallel suite
    // multiplies.
    unlinkSync(payloadPath);
  }
}

suite('crystallize-close-apply: hostTagWarning reaches marker, json, and console exactly once');

test('marker file carries host_tag_warning naming the tag when the close survived a host-tag-shaped queue item', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `hosttag-marker-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    try {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload, { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `apply must succeed: ${r.stdout}\n${r.stderr}`);
      const marker = JSON.parse(readFileSync(sessionClosedMarkerPath(dir, sessionId), 'utf-8'));
      assert.match(
        marker.host_tag_warning,
        /<agent-message/,
        `marker must name the neutralized tag: ${JSON.stringify(marker)}`,
      );
      // This call site is a SEPARATE hostTagWarningWithUndo invocation from
      // the top-level one (runMarkerPhase's own, ahead of the marker write),
      // so wiring the top-level call alone does not prove this one is wired
      // too. Same real-commit-sha requirement as the --json test below.
      const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
      const sha = head.stdout.trim();
      assert.ok(
        marker.host_tag_warning.includes(`git -C ${dir} revert ${sha}`),
        `marker's own undo must name the real commit, not a generic lookup: ${marker.host_tag_warning}`,
      );
    } finally {
      cleanup();
    }
  });
});

test('--json result carries hostTagWarning naming the tag and a revert path', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `hosttag-json-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    try {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload, { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `apply must succeed: ${r.stdout}\n${r.stderr}`);
      assert.match(out.hostTagWarning, /<agent-message/, `--json result: ${r.stdout}`);
      assert.match(
        out.hostTagWarning,
        /revert/,
        `--json result must point at the undo path: ${r.stdout}`,
      );
    } finally {
      cleanup();
    }
  });
});

// major finding: hostTagWarningWithUndo's `commit-and-marker` revert
// instruction is only actionable when it names a real commit sha. Before
// this call site was wired, applySessionClose's own top-level call never
// passed a 5th argument at all, so this always fell to the generic
// "find it with `git log -1`" fallback even though the exact sha this
// close's own commit made was sitting right there in `commitOutcome`.
// Disabling the check: pass `undefined` instead of `commitShaForUndo(commitOutcome)`
// at the top-level `hostTagWarningWithUndo` call site. This test goes red
// (the message falls back to the generic `git log -1` instruction) while the
// generic "/revert/" test above stays green, since that assertion cannot
// tell a real sha apart from the fallback wording.
test('--json result names the ACTUAL commit sha in its revert instruction, not a generic lookup', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `hosttag-sha-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    try {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload, { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `apply must succeed: ${r.stdout}\n${r.stderr}`);
      assert.equal(out.committed, true, `this close must have made a real commit: ${r.stdout}`);
      const head = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
      const sha = head.stdout.trim();
      assert.ok(
        out.hostTagWarning.includes(`git -C ${dir} revert ${sha}`),
        `must name THIS close's own commit, not fall back to a generic lookup: ${out.hostTagWarning}`,
      );
      assert.equal(
        /find it with/.test(out.hostTagWarning),
        false,
        `a known sha must never fall back to the "caller did not say" wording: ${out.hostTagWarning}`,
      );
    } finally {
      cleanup();
    }
  });
});

test('console output prints the warning exactly once, alongside the commit that just made it', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `hosttag-console-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    try {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApplyConsole(dir, payload, sessionId);
      assert.equal(r.status, 0, `apply must succeed: ${r.stdout}\n${r.stderr}`);
      const occurrences = (r.stdout.match(/this close was granted while a queued item/g) || [])
        .length;
      assert.equal(
        occurrences,
        1,
        `the warning must print exactly once, not on every gate read: ${r.stdout}`,
      );
    } finally {
      cleanup();
    }
  });
});

// The other marker writer. `--mark-session-closed` is the path a model takes
// after closing by hand, and it reached this suite with no warning wiring at
// all: the gate status was consulted only inside the refusal branch, so a
// close that survived a pasted host tag wrote its marker and said nothing.
// Its undo is also the one that differs most, since this entry point makes no
// commit for anyone to revert.
test('--mark-session-closed warns too, with the marker-only undo (it makes no commit)', () => {
  withWiki(null, (dir) => {
    const sessionId = `hosttag-mark-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    // --mark proves THIS session's close, so the session needs one to prove.
    pinCommittedClose(dir, sessionId, todayLocal());
    try {
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        `--session-id=${sessionId}`,
        '--project=test-project',
        '--json',
      ]);
      assert.equal(r.status, 0, `expected a clean mark: ${r.stdout}\n${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.match(
        out.hostTagWarning,
        /<agent-message/,
        `the standalone marker path must surface the residual too: ${r.stdout}`,
      );
      assert.ok(
        out.hostTagWarning.includes(sessionClosedMarkerPath(dir, sessionId)),
        `the undo must name the marker this run wrote: ${r.stdout}`,
      );
      assert.equal(
        /revert the commit/.test(out.hostTagWarning),
        false,
        `this path makes no commit, so it must not send anyone to revert one: ${r.stdout}`,
      );
      const marker = JSON.parse(readFileSync(sessionClosedMarkerPath(dir, sessionId), 'utf-8'));
      assert.match(
        marker.host_tag_warning,
        /<agent-message/,
        `the marker must record it too: ${JSON.stringify(marker)}`,
      );
    } finally {
      cleanup();
    }
  });
});

// The condition the warning hangs off is "this run put something on disk",
// not `ok`. 'marker-did-not-land' is where those two come apart: the payload
// is already committed to the vault's history and only the marker write
// failed, which flips ok to false. Gating on `ok` there silenced the warning
// on the one path where the bytes a user may not have asked for are already
// in git.
test('a landed commit with a blocked receipt still warns, and offers only the undo it can honor', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `hosttag-nomarker-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    try {
      // ISSUE-171 interaction: occupying the marker's OWN filename with a
      // directory (the old ISSUE-153 technique) no longer blocks anything:
      // `refuseUnlessCloseRequested` invalidates (renames away) whatever
      // sits at THIS session's own marker path the moment the close is
      // authorized, before any write, so the stray directory is cleared
      // long before the marker write runs (see the self-heal test above).
      // To reach the same SHAPE this test cares about (commit lands, the
      // compat marker never does, hostTagWarning still surfaces with no
      // marker-deletion instruction), block the RECEIPT write instead: a
      // plain file occupying `.cache/sessions/<sid>/` makes
      // `writeReceiptAtomic`'s directory create fail (ENOTDIR), which
      // withholds the marker exactly as a disk-level failure would, without
      // ever creating (or needing to survive) a directory at the marker path.
      const sessionCacheDir = join(dir, '.cache', 'sessions', sessionId);
      mkdirSync(dirname(sessionCacheDir), { recursive: true });
      writeFileSync(sessionCacheDir, 'occupied by a file, not a directory\n');
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload, { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false, `the blocked receipt must fail the close: ${r.stdout}`);
      assert.equal(out.stage, 'receipt-write-failed', `stage: ${r.stdout}`);
      assert.equal(out.committed, true, `the payload must still have committed: ${r.stdout}`);
      assert.match(
        out.hostTagWarning,
        /<agent-message/,
        `ok:false must not silence the warning once the commit landed: ${r.stdout}`,
      );
      assert.match(out.hostTagWarning, /revert/, `the commit is revertable: ${r.stdout}`);
      // No marker landed here, so the undo must not tell anyone to delete one.
      assert.equal(
        out.hostTagWarning.includes(sessionClosedMarkerPath(dir, sessionId)),
        false,
        `no marker was written on this path: ${r.stdout}`,
      );
    } finally {
      cleanup();
    }
  });
});

// The marker writer cannot be made to fail from outside once the close has
// started: the invalidation at the top of a close renames away whatever sits at
// the marker path, and the receipt lands before the marker is tried. A git
// post-commit hook runs in exactly the gap between the two (after that
// invalidation, after the commit this apply makes, before the receipt and the
// marker), so a hook that puts a directory at the marker path makes the marker
// write fail every time, through the real CLI and with no test seam in the
// production code.
function blockMarkerAfterCommit(dir, sessionId) {
  const markerPath = sessionClosedMarkerPath(dir, sessionId);
  const hookDir = join(dir, '.git', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hook = join(hookDir, 'post-commit');
  writeFileSync(hook, `#!/bin/sh\nmkdir -p '${dirname(markerPath)}' && mkdir '${markerPath}'\n`, {
    mode: 0o755,
  });
  return { markerPath, hook };
}

// Disabling the check: in landReceiptThenMarker delete the
// invalidateCloseArtifacts call in the marker-did-not-land branch. The receipt
// then stays behind, and the "no receipt" assertion below goes red.
test('a marker that cannot land after the commit fails with stage marker-did-not-land, withdraws the receipt, and the retry lands', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `mdnl-json-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId, { toolUseLines: [HOST_TAG_ENQUEUE] });
    try {
      const { markerPath, hook } = blockMarkerAfterCommit(dir, sessionId);
      const payload = payloadForCleanWiki(dir, today);
      const r = runApply(dir, payload, { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.equal(out.ok, false);
      assert.equal(out.stage, 'marker-did-not-land', `stage: ${r.stdout}`);
      assert.equal(out.markerSkipReason, 'marker-did-not-land');
      assert.equal(out.markerWritten, false);
      assert.equal(out.committed, true, `the payload still committed: ${r.stdout}`);
      assert.equal(
        existsSync(receiptPath(dir, sessionId)),
        false,
        'the receipt filed before the failed marker must be withdrawn',
      );
      assert.equal(existsSync(markerPath), false, 'the blocker at the marker path was cleared');
      assert.equal(
        out.mismatches,
        undefined,
        `the withdrawal worked, so nothing is reported beside the stage: ${r.stdout}`,
      );
      // The close signal is unspent, so the same close needs no fresh phrase.
      unlinkSync(hook);
      const retry = runApply(dir, payload, { sessionId });
      const retryOut = JSON.parse(retry.stdout);
      assert.equal(retryOut.ok, true, `retry: ${retry.stdout}\n${retry.stderr}`);
      assert.equal(retryOut.markerWritten, true);
      assert.ok(existsSync(receiptPath(dir, sessionId)), 'the retry files the receipt');
    } finally {
      cleanup();
    }
  });
});

test('the console report for marker-did-not-land names the marker, not the receipt or the policy withhold', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `mdnl-console-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    try {
      blockMarkerAfterCommit(dir, sessionId);
      const r = runApplyConsole(dir, payloadForCleanWiki(dir, today), sessionId);
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stderr, /session-close marker NOT written \(reason: marker-did-not-land\)/);
      assert.match(r.stderr, /Stop-chain marker itself failed/);
      assert.match(r.stderr, /a directory sitting where the marker file goes/);
      assert.match(r.stderr, /No fresh close phrase\s+is needed/);
      assert.equal(
        /receipt could not prove|checkpoint receipt under/.test(r.stderr),
        false,
        `it must not borrow the receipt-stage wording: ${r.stderr}`,
      );
      assert.equal(
        /re-run with the correct main-conversation --session-id/.test(r.stderr),
        false,
        `it must not send anyone after a --session-id problem: ${r.stderr}`,
      );
    } finally {
      cleanup();
    }
  });
});

// design.md v2 §C / test row c ("커밋 경합"): `.hypoignore` makes a REAL,
// deterministic version of "the committed bytes differ from what this close
// expected", without needing true process concurrency. hot.md's new content
// is written to disk like any ordinary overwrite, but `.hypoignore` makes
// `commitWikiChanges` permanently exclude it from staging, so the commit
// this apply makes still carries HEAD's OLD hot.md bytes. The receipt must
// catch that divergence and withhold, never certify a version that was
// never actually committed.
test('a .hypoignore-excluded target commits the OLD bytes, and the receipt is withheld (receipt-proof-mismatch)', () => {
  withWiki(null, (dir, today) => {
    // The ignored target is the vault-root log.md, not a file under
    // projects/test-project/. The checkpoint gate blocks any dirty file in the
    // project folder being closed before the receipt proof runs, so a hot.md
    // fixture no longer reaches receipt-proof-mismatch (the next test pins that
    // refusal). A root file with no touched-paths record only demotes to a
    // notice, which is what lets this proof still see the divergence.
    writeFileSync(join(dir, '.hypoignore'), 'log.md\n');
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = 's-hypoignore-mismatch';
    const r = runApply(dir, payload, { sessionId });
    const out = JSON.parse(r.stdout);
    assert.equal(
      r.status,
      1,
      `an ignored, never-committed append must withhold the receipt: ${r.stdout}\n${r.stderr}`,
    );
    assert.equal(out.ok, false);
    assert.equal(out.markerSkipReason, 'receipt-proof-mismatch', `stage: ${r.stdout}`);
    assert.ok(
      (out.mismatches || []).some((m) => m.path === 'log.md'),
      `the mismatch must name the ignored target: ${JSON.stringify(out.mismatches)}`,
    );
    assert.ok(
      !existsSync(join(dir, '.cache', `session-closed-${sessionId}.marker`)),
      'no compat marker may land on an uncertified close',
    );
  });
});

// The test above with a file inside the project folder being closed instead:
// the gate blocks any dirty file there, so the close is refused one step
// earlier, as compact-gate-not-ok, with no marker and no receipt. (Its original
// fixture, an ignored project's entry, now passes the gate on its local proof:
// see the .hypoignore suite below.)
test('a dirty file in the project folder being closed refuses the gate (compact-gate-not-ok), no marker, no receipt', () => {
  withWiki(null, (dir, today) => {
    // Not a .md page, so preflight lint has nothing to say about it.
    writeFileSync(join(dir, 'projects', 'test-project', 'scratch.txt'), 'unsaved work\n');
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = 's-hypoignore-gate-refusal';
    const r = runApply(dir, payload, { sessionId });
    const out = JSON.parse(r.stdout);
    assert.equal(out.committed, true, `the close itself committed: ${r.stdout}`);
    assert.equal(out.markerSkipReason, 'compact-gate-not-ok', `stage: ${r.stdout}\n${r.stderr}`);
    assert.equal(out.markerWritten, false);
    // The result names the checkpoint gate's own blocker, so a caller does not
    // have to reach for --check-session-close, which judges a wider git axis.
    assert.ok(
      (out.gateBlockers || []).some((b) => b.file === 'projects/test-project/scratch.txt'),
      `gateBlockers must name the refused file: ${JSON.stringify(out.gateBlockers)}`,
    );
    assert.ok(
      !existsSync(join(dir, '.cache', `session-closed-${sessionId}.marker`)),
      'no marker may land while the project folder has an uncommitted file',
    );
    assert.equal(
      existsSync(receiptPath(dir, sessionId)),
      false,
      'no receipt may be filed behind a refused gate',
    );
  });
});

// The console path reads the same stage and must not fall back to the policy
// withhold text, which claims ok:true and sends the user after --session-id.
test('the console report for receipt-proof-mismatch says ok:false and points at the commit, not at --session-id', () => {
  withWiki(null, (dir, today) => {
    // Root log.md ignored, for the reason given in the receipt-proof-mismatch
    // JSON test above: a project-folder file is refused at the gate instead.
    writeFileSync(join(dir, '.hypoignore'), 'log.md\n');
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = `s-hypoignore-mismatch-console-${process.pid}`;
    const cleanup = seedCloseTranscript(sessionId);
    let r;
    try {
      r = runApplyConsole(dir, payload, sessionId);
    } finally {
      cleanup();
    }
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /reason: receipt-proof-mismatch/);
    assert.match(r.stderr, /could not prove them against the commit/);
    assert.doesNotMatch(
      r.stderr,
      /\(ok:true\)/,
      'a failed receipt must not be reported as ok:true',
    );
    assert.doesNotMatch(r.stderr, /--session-id=<main-conversation-id>/);
  });
});

// A gate refusal is neither a policy withhold nor a receipt failure. The console
// report used to fall through to the policy text ("(ok:true) ... re-run with the
// correct --session-id"), which is wrong here: the session id is fine, a
// blocker in the vault is what stopped the marker.
test('the console report for compact-gate-not-ok names the gate blocker, not --session-id or a new close phrase', () => {
  withWiki(null, (dir, today) => {
    writeFileSync(join(dir, 'projects', 'test-project', 'scratch.txt'), 'unsaved work\n');
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = `s-hypoignore-gate-console-${process.pid}`;
    const cleanup = seedCloseTranscript(sessionId);
    let r;
    try {
      r = runApplyConsole(dir, payload, sessionId);
    } finally {
      cleanup();
    }
    assert.match(r.stderr, /reason: compact-gate-not-ok/, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /gate blocker/);
    assert.match(r.stderr, /commit\s+or revert/);
    assert.match(r.stderr, /No fresh close phrase/);
    assert.doesNotMatch(
      r.stderr,
      /\(ok:true\)/,
      'a gate refusal is not the ok:true policy withhold',
    );
    assert.doesNotMatch(r.stderr, /--session-id=<main-conversation-id>/);
  });
});

// design.md test 5 / row d, the positive half: a skipped (idempotent,
// disk-already-matches) target whose bytes are ALREADY IN THE COMMIT (this
// exact session's own prior, successful close) still certifies on a
// same-day re-apply. The negative half (a skip that matches only dirty
// disk, never committed) is
// "--apply-session-close: a retry leaves an unjournaled payload file uncommitted, receipt withheld"
// in tests/close-global.test.mjs.
test('a skipped target whose bytes are already committed (idempotent same-session re-apply) still issues a receipt', () => {
  withWiki(null, (dir, today) => {
    const sessionId = 's-skip-already-committed';
    const payload = payloadForCleanWiki(dir, today);
    const cleanup1 = seedCloseTranscript(sessionId);
    const r1 = runApply(dir, payload, { sessionId });
    cleanup1();
    const out1 = JSON.parse(r1.stdout);
    assert.equal(out1.ok, true, `first apply must succeed: ${r1.stdout}\n${r1.stderr}`);
    assert.equal(out1.markerWritten, true);

    // Re-apply the SAME payload. The append targets (session-log, log.md) are
    // already-present skips (the entry text is unchanged), and the entry is the
    // one this same close already committed.
    // A second, distinct close phrase (attempt 1 already spent the first):
    // seedCloseTranscript overwrites the file, so the fixture repeats the
    // same opening line and adds a fresh one after it.
    const cleanup2 = seedCloseTranscript(sessionId, {
      toolUseLines: [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '세션 마무리 해줘' } }),
      ],
    });
    const r2 = runApply(dir, payload, { sessionId });
    cleanup2();
    const out2 = JSON.parse(r2.stdout);
    assert.equal(
      out2.ok,
      true,
      `idempotent re-apply must still certify: ${r2.stdout}\n${r2.stderr}`,
    );
    assert.equal(out2.markerWritten, true, 'a fresh receipt must be issued for the re-apply');
  });
});

// design.md test 35 / row e: a payload whose session-log entry carries TWO
// dated headings derives TWO root-log blocks (design.md v5 §3), and the
// proof must cover both, not just the first. Here heading A's exact line
// already sits in log.md with a DIFFERENT body underneath (from an earlier,
// unrelated write): `appendIfAbsent`'s heading-only absence check treats A
// as already present and skips writing THIS close's own block for it, while
// heading B (untouched) writes normally. The commit lands with B's real
// block but never THIS close's own A block, so the receipt must withhold.
test('two derived log.md headings, one already occupied by a different body, withholds the receipt', () => {
  withWiki(null, (dir, today) => {
    const entryA = rootLogEntry('test-project', today, 'change A');
    const entryB = rootLogEntry('test-project', today, 'change B');
    const logPath = join(dir, 'log.md');
    // A different session's own block already sits under heading A's exact
    // line: the heading matches, the body (arrow-link target) does not.
    writeFileSync(
      logPath,
      `${readFileSync(logPath, 'utf-8')}\n${entryA.heading}\n${'→'} [[pages/unrelated]]\n`,
    );
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog.entry = `## [${today}] change A\nfirst\n\n## [${today}] change B\nsecond\n`;
    delete payload.log;
    const sessionId = 's-two-headings-one-missing';
    const r = runApply(dir, payload, { sessionId });
    const out = JSON.parse(r.stdout);
    assert.equal(
      r.status,
      1,
      `a derived block this close never actually wrote must withhold: ${r.stdout}\n${r.stderr}`,
    );
    assert.equal(out.ok, false);
    assert.equal(out.markerSkipReason, 'receipt-proof-mismatch', `stage: ${r.stdout}`);
    const logContent = readFileSync(logPath, 'utf-8');
    assert.ok(logContent.includes(entryB.block), 'block B must still have been written');
    assert.ok(
      !logContent.includes(entryA.block),
      "this close's own block A must never have landed (the heading was already taken)",
    );
  });
});

// design.md test 33 / row f: a session with a VALID receipt from an earlier
// close sends a newly-authorized close (a fresh user close phrase) with a
// malformed payload. Authorization is checked (and passes) before payload
// shape validation, so `refuseUnlessCloseRequested` invalidates the prior
// receipt and compat marker before the malformed payload is even parsed,
// a botched retry must never leave a stale "closed" proof standing.
test('a newly-authorized close with a malformed payload invalidates the prior receipt and marker', () => {
  withWiki(null, (dir, today) => {
    const sessionId = 's-invalidate-on-bad-retry';
    const payload = payloadForCleanWiki(dir, today);
    const cleanup1 = seedCloseTranscript(sessionId);
    const r1 = runApply(dir, payload, { sessionId });
    cleanup1();
    const out1 = JSON.parse(r1.stdout);
    assert.equal(out1.ok, true, `first apply must succeed: ${r1.stdout}\n${r1.stderr}`);
    const receiptDir = join(dir, '.cache', 'sessions', sessionId);
    const markerPath = sessionClosedMarkerPath(dir, sessionId);
    assert.ok(existsSync(join(receiptDir, 'close-receipt.json')), 'precondition: a receipt exists');
    assert.ok(existsSync(markerPath), 'precondition: a marker exists');

    const badPayloadPath = join(
      tmpdir(),
      `hypo-bad-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
    );
    writeFileSync(badPayloadPath, JSON.stringify({ project: 'test-project', date: today }));
    const cleanup2 = seedCloseTranscript(sessionId, {
      toolUseLines: [
        JSON.stringify({ type: 'user', message: { role: 'user', content: '세션 마무리 해줘' } }),
      ],
    });
    const r2 = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      `--payload=${badPayloadPath}`,
      `--session-id=${sessionId}`,
      '--json',
    ]);
    cleanup2();
    assert.equal(r2.status, 1, `a malformed payload must refuse: ${r2.stdout}\n${r2.stderr}`);

    assert.equal(
      existsSync(join(receiptDir, 'close-receipt.json')),
      false,
      'the old receipt must no longer sit at its plain path',
    );
    assert.equal(
      existsSync(markerPath),
      false,
      'the old marker must no longer sit at its plain path',
    );
    const invalidatedReceipts = readdirSync(receiptDir).filter((n) =>
      n.startsWith('close-receipt.json.invalidated-'),
    );
    assert.equal(
      invalidatedReceipts.length,
      1,
      `expected one invalidated receipt: ${readdirSync(receiptDir)}`,
    );
    const invalidatedMarkers = readdirSync(join(dir, '.cache')).filter((n) =>
      n.startsWith(`session-closed-${sessionId}.marker.invalidated-`),
    );
    assert.equal(invalidatedMarkers.length, 1, 'expected one invalidated marker');
  });
});

test('an ordinary close with no host-tag-shaped queue item carries the warning in none of marker, json, or console', () => {
  withWiki(null, (dir, today) => {
    const jsonSessionId = `hosttag-none-json-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const payloadJson = payloadForCleanWiki(dir, today);
    // No toolUseLines: runApply auto-seeds an ordinary close transcript for
    // this fresh id (see helpers.mjs's runApply doc comment), no host tag in it.
    const rJson = runApply(dir, payloadJson, { sessionId: jsonSessionId });
    const outJson = JSON.parse(rJson.stdout);
    assert.equal(outJson.ok, true, `apply must succeed: ${rJson.stdout}\n${rJson.stderr}`);
    assert.equal(
      'hostTagWarning' in outJson,
      false,
      `--json result must omit the key entirely on an ordinary close: ${rJson.stdout}`,
    );
    const marker = JSON.parse(readFileSync(sessionClosedMarkerPath(dir, jsonSessionId), 'utf-8'));
    assert.equal(
      'host_tag_warning' in marker,
      false,
      `marker must omit the key entirely on an ordinary close: ${JSON.stringify(marker)}`,
    );

    const consoleSessionId = `hosttag-none-console-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanupConsole = seedCloseTranscript(consoleSessionId);
    try {
      const payloadConsole = payloadForCleanWiki(dir, today);
      payloadConsole.sessionLog.entry = `## [${today}] second re-applied session (no host tag)\n`;
      payloadConsole.log.entry = `## [${today}] session | test-project: second re-applied (no host tag)\n`;
      const rConsole = runApplyConsole(dir, payloadConsole, consoleSessionId);
      assert.equal(
        rConsole.status,
        0,
        `apply must succeed: ${rConsole.stdout}\n${rConsole.stderr}`,
      );
      assert.doesNotMatch(
        rConsole.stdout,
        /this close was granted while a queued item/,
        `an ordinary close must not print the host-tag warning: ${rConsole.stdout}`,
      );
    } finally {
      cleanupConsole();
    }
  });
});

// ── markerGateReason: the late no-user-close-signal race actually reaches
// the --json result (2nd cross-review CONCERN n1) ──────────────────────────
// runMarkerPhase's `hasUserSignal` is computed from a SECOND, LATE read of the
// transcript (resolveTranscriptBySessionId + isCloseGateOpen, both called after
// the commit; see that field's own doc comment in crystallize-close-apply.mjs),
// deliberately distinct from verifyCloseAuthority's EARLY read before any byte
// is written. `markerGateReason` is filled in only when that late read finds
// the gate closed even though the early one found it open: a close signal that
// got retracted while this apply's own commit was landing. Before this test, a
// grep for `markerGateReason` and `Gate detail` across every `tests/*.test.mjs`
// turned up zero assertions, so the field could go back to always being `null`
// (the same failure shape hostTagWarning's own suite above exists to catch)
// and no test would notice.
//
// Reaching that late-closed state without a wall-clock guess: hold the same
// lock runMarkerPhase's commit step takes (`vaultCommitLockTarget`) before the
// child even starts. verifyCloseAuthority runs before any write and never
// touches that lock, so the child still passes it against the OPEN transcript
// and writes its payload files. Only afterwards does it try to acquire the
// commit lock we are holding, and it blocks there deterministically. That
// block is the signal to append an unregistered host-tag-shaped retraction to
// the transcript before releasing the lock, so the LATE read (after the
// child's own commit runs) sees a different transcript than the early one did.
function withHeldCommitLock(dir) {
  const lockPath = `${vaultCommitLockTarget(dir)}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(process.pid));
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already released, or never created */
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const UNREGISTERED_HOST_TAG_ENQUEUE = JSON.stringify({
  type: 'queue-operation',
  operation: 'enqueue',
  content: '<any-new-host-tag foo="x">something</any-new-host-tag>',
});

suite('crystallize-close-apply: markerGateReason (late no-user-close-signal race)');

await testAsync(
  '--json result carries markerGateReason matching closeGateStatus, naming the unregistered tag',
  async () => {
    // Built by hand rather than withWiki/withTmpDir: both clean up with a
    // synchronous `finally` right after invoking the callback, which would run
    // before this async body's awaited work (the spawned child, the poll loop)
    // ever finishes.
    const dir = mkdtempSync(join(tmpdir(), 'hypo-wiki-gatereason-'));
    const today = todayLocal();
    try {
      buildCleanWikiTree(dir, today);
      spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf-8' });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8' });

      const sessionId = `gatereason-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      const cleanupTranscript = seedCloseTranscript(sessionId);
      const transcriptPath = join(
        SESSION_TMP_HOME,
        '.claude',
        'projects',
        'hypo-test-proj',
        `${sessionId}.jsonl`,
      );
      const payload = payloadForCleanWiki(dir, today);
      const sentinel = `## [${today}] gate-reason re-applied\n`;
      payload.sessionLog.entry = sentinel;
      const payloadPath = join(
        tmpdir(),
        `hypo-payload-gatereason-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
      );
      writeFileSync(payloadPath, JSON.stringify(payload));

      const releaseLock = withHeldCommitLock(dir);
      try {
        const child = spawn(
          process.execPath,
          [
            join(REPO, 'scripts', 'crystallize.mjs'),
            `--hypo-dir=${dir}`,
            '--apply-session-close',
            `--payload=${payloadPath}`,
            `--session-id=${sessionId}`,
            '--json',
          ],
          { env: { ...process.env, HOME: SESSION_TMP_HOME } },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

        // The payload writes land before the child ever tries for the commit
        // lock (see this file's own ordering comment on runMarkerPhase), so
        // the session-log file carrying our sentinel is the deterministic
        // proof the child is now blocked on the lock we hold.
        const sessionLogPath = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
        const deadline = Date.now() + 4000;
        let landed = false;
        while (Date.now() < deadline) {
          if (
            existsSync(sessionLogPath) &&
            readFileSync(sessionLogPath, 'utf-8').includes('gate-reason')
          ) {
            landed = true;
            break;
          }
          await sleep(10);
        }
        assert.ok(
          landed,
          'timed out waiting for the child apply to write its payload before appending the retraction',
        );
        writeFileSync(transcriptPath, UNREGISTERED_HOST_TAG_ENQUEUE + '\n', { flag: 'a' });
        releaseLock();

        const code = await exited;
        assert.equal(
          code,
          0,
          `apply must still exit 0 (a withheld marker is not a failure): ${stdout}\n${stderr}`,
        );
        const out = JSON.parse(stdout);
        assert.equal(out.ok, true, `the payload commit itself must still succeed: ${stdout}`);
        assert.equal(
          out.committed,
          true,
          `the commit must have landed before the late re-read: ${stdout}`,
        );
        assert.equal(
          out.markerWritten,
          false,
          `the marker must be withheld once the late re-read finds the gate closed: ${stdout}`,
        );
        assert.equal(out.markerSkipReason, 'no-user-close-signal', `stdout: ${stdout}`);

        // Independently compute what closeGateStatus reports for this same
        // (now-retracted) transcript, and require markerGateReason to be
        // exactly that string, not just look similar to it.
        const independentStatus = closeGateStatus({
          transcriptPath,
          hypoDir: dir,
          sessionId,
        });
        assert.equal(
          out.markerGateReason,
          independentStatus.reason,
          `markerGateReason must be closeGateStatus's own reason string, verbatim: ${stdout}`,
        );
        assert.match(
          out.markerGateReason,
          /<any-new-host-tag\.\.\.>/,
          `an unregistered host-tag-shaped retraction must name the tag: ${stdout}`,
        );
      } finally {
        releaseLock();
        cleanupTranscript();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── codex 3rd-tier finding 1: sha:null must not collapse into "nothing to
// revert" ─────────────────────────────────────────────────────────────────
// commitWikiChanges' own `sha` field is `null` in two DIFFERENT histories: a
// genuine `scoped: 0` no-op never sets it at all (the key is absent, i.e.
// `undefined`), while a REAL commit whose `rev-parse HEAD` afterwards failed
// sets it to the literal `null` (commitWikiChanges' own doc comment).
// commitShaForUndo used to return `commitOutcome.sha` verbatim on any
// `scoped !== 0` outcome, so the failed-rev-parse case passed `null`
// straight through and hostTagWarningWithUndo read it exactly like the true
// no-op: "nothing needs reverting" for a commit that, in fact, just landed.
suite(
  'commitShaForUndo: a real commit with sha:null must not read as "nothing to revert" (finding 1)',
);

// Disabling the check: change `return commitOutcome.sha ?? undefined;` back
// to `return commitOutcome.sha;`. This test goes red (returns `null` instead
// of `undefined`) while the no-op and genuine-sha tests below stay green,
// which is the pair that isolates this one branch from the other two.
test('a real commit (scoped>0) whose sha came back null (failed rev-parse) returns undefined, not null', () => {
  assert.equal(
    commitShaForUndo({ committed: true, scoped: 3, sha: null }),
    undefined,
    'a real commit with an unreadable sha must fall to the "look it up yourself" wording, never the no-op one',
  );
});

test('a true no-op commit (scoped:0, no sha field at all) still returns null', () => {
  assert.equal(
    commitShaForUndo({ committed: true, scoped: 0 }),
    null,
    'the genuine no-op case must be untouched by this fix',
  );
});

test('a real commit with a genuine sha string passes it through unchanged', () => {
  assert.equal(
    commitShaForUndo({ committed: true, scoped: 2, sha: 'abc123deadbeef' }),
    'abc123deadbeef',
  );
});

test('no commitOutcome at all (apply never reached the commit step) returns undefined', () => {
  assert.equal(commitShaForUndo(null), undefined);
});

// ── codex 3rd-tier finding 2: a close-intent write failure must refuse the
// close before any target file is touched ──────────────────────────────────
// writeCloseIntent used to swallow every failure (lock timeout, EACCES, a
// full disk under .cache/) and applyOverwrites ran regardless. The witness
// this record exists to provide never landed, and a crash between the
// first and second target write then left hasTornCloseIntent's next probe
// with nothing to find, so a torn set read as a clean, finished close.
suite('close-intent write failure refuses the close before any target write (finding 2)');

// Disabling the check: after `writeCloseIntent(...)`, drop the `if
// (!intentResult.ok) { ...; process.exit(1); }` block (call it and ignore
// the result, the pre-fix behavior). This test goes red (`ok` flips to
// true, session-state.md is overwritten) while every ordinary apply test
// elsewhere in this file stays green, since none of them occupy the intent
// path with a directory.
test('an intent path occupied by a directory refuses the close before session-state.md is touched', () => {
  withWiki(null, (dir, today) => {
    const sessionId = 's-intent-blocked';
    const intentPath = closeIntentPath(dir, sessionId);
    // Occupies the EXACT path writeCloseIntent's atomicWrite must rename
    // onto: a plain file rename can never land on an existing directory
    // (EISDIR), forcing a real, reproducible write failure with no need to
    // wait out a lock timeout.
    mkdirSync(intentPath, { recursive: true });

    const statePath = join(dir, 'projects', 'test-project', 'session-state.md');
    const stateBefore = readFileSync(statePath, 'utf-8');

    const payload = payloadForCleanWiki(dir, today);
    const r = runApply(dir, payload, { sessionId });
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.ok,
      false,
      `a close-intent write failure must refuse the close, not proceed: ${r.stdout}`,
    );
    assert.equal(out.stage, 'close-intent-write-failed', `stage: ${r.stdout}`);
    assert.deepEqual(out.applied, [], 'nothing should have been written on this path');
    assert.equal(
      out.committed,
      null,
      'this refusal fires before the commit step, same contract as every other pre-write refusal',
    );
    assert.equal(
      readFileSync(statePath, 'utf-8'),
      stateBefore,
      'no target file may be touched once the witness itself failed to write',
    );
  });
});

// ── codex 3rd-tier finding 3: a same-session retry must not clear a NEWER
// live intent record ────────────────────────────────────────────────────────
// write and clear each hold the path lock only briefly, and (before this
// fix) carried no generation identifier at all. Attempt A writes an intent,
// attempt B (same sessionId, e.g. a retried apply after resume) overwrites
// the SAME path with its own newer intent, and when A finally finishes and
// clears, it used to remove whatever sat at that path, B's still-live
// record included, with no way to tell "my own record" from "someone
// else's that happens to share my path".
suite('a same-session retry must not clear a newer live close-intent record (finding 3)');

// Disabling the check: in clearCloseIntent, call `unlinkSync(path)` directly
// instead of `unlinkCloseIntentIfMatching(path, attemptId)` (the pre-fix
// path-only delete). This test goes red (B's record is deleted by A's
// clear) while the "own clear still works" test below stays green, which is
// the pair that isolates the match-before-delete guard from clearCloseIntent
// simply working at all.
test("attempt A's clear leaves attempt B's newer record on disk untouched", () => {
  withWiki(null, (dir) => {
    const sessionId = 's-retry-race';
    const path = closeIntentPath(dir, sessionId);
    const targetsA = [{ relPath: 'projects/test-project/hot.md', hash: '0'.repeat(64) }];
    const targetsB = [{ relPath: 'projects/test-project/session-state.md', hash: '1'.repeat(64) }];

    const attemptA = writeCloseIntent(dir, sessionId, targetsA);
    assert.equal(
      attemptA.ok,
      true,
      `attempt A's own write must succeed: ${JSON.stringify(attemptA)}`,
    );

    // Attempt B overwrites the SAME path (same sessionId ⇒ same
    // closeIntentPath) with its own newer intent, exactly as a retried
    // apply for this session would.
    const attemptB = writeCloseIntent(dir, sessionId, targetsB);
    assert.equal(
      attemptB.ok,
      true,
      `attempt B's own write must succeed: ${JSON.stringify(attemptB)}`,
    );
    assert.notEqual(
      attemptA.attemptId,
      attemptB.attemptId,
      'two writes must mint two distinct attempt identities',
    );

    // Attempt A finishes (or crashes and retries elsewhere) and clears with
    // its OWN (now stale) attemptId.
    clearCloseIntent(dir, sessionId, attemptA.attemptId);

    assert.ok(existsSync(path), "attempt B's still-live record must survive attempt A's clear");
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    assert.equal(
      onDisk.attemptId,
      attemptB.attemptId,
      "the surviving record must still be attempt B's own, byte for byte",
    );
  });
});

test("attempt B's own clear (with its own attemptId) does remove its own record", () => {
  withWiki(null, (dir) => {
    const sessionId = 's-retry-race-own-clear';
    const path = closeIntentPath(dir, sessionId);
    const targets = [{ relPath: 'projects/test-project/hot.md', hash: '0'.repeat(64) }];

    const attempt = writeCloseIntent(dir, sessionId, targets);
    assert.equal(attempt.ok, true);
    clearCloseIntent(dir, sessionId, attempt.attemptId);
    assert.ok(!existsSync(path), 'a matching attemptId must still clear its own record');
  });
});

// ── final cross-review finding: doctor guidance reaches a plugin-only user ──
// The close console and commands/crystallize.md told every user to run
// `hypomnema doctor`. That bin ships only with the npm install, so a person who
// installed the plugin alone was sent to a command they do not have. Both forms
// are named now, with no guess at runtime about which install this is.
suite('close points at doctor in both install forms');

// Disabling the check: set DOCTOR_HINT in crystallize-close-apply.mjs back to
// '`hypomnema doctor`'. The unreadable-proposal line loses `/hypo:doctor`.
test('the console close report names /hypo:doctor and hypomnema doctor for an unreadable proposal file', () => {
  withWiki(null, (dir, today) => {
    const proposalsDir = join(dir, '.cache', 'proposals');
    mkdirSync(proposalsDir, { recursive: true });
    writeFileSync(join(proposalsDir, 'broken.json'), '{not json');
    const sessionId = 's-doctor-hint';
    const cleanup = seedCloseTranscript(sessionId);
    const payloadPath = join(tmpdir(), `hypo-payload-doctor-${process.pid}.json`);
    writeFileSync(payloadPath, JSON.stringify(payloadForCleanWiki(dir, today)));
    let r;
    try {
      r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--apply-session-close',
        `--payload=${payloadPath}`,
        `--session-id=${sessionId}`,
      ]);
    } finally {
      cleanup();
      rmSync(payloadPath, { force: true });
    }
    const line = r.stdout.split('\n').find((l) => l.includes('could not be read or parsed'));
    assert.ok(line, `precondition: the unreadable-proposal line must print: ${r.stdout}`);
    assert.ok(
      line.includes('`/hypo:doctor`') && line.includes('`hypomnema doctor`'),
      `the line must name both the slash command and the npm bin: ${line}`,
    );
  });
});

// Disabling the check: put `hypomnema doctor` back as the only form in the
// parkedTotal / parkedUnreadable bullets of commands/crystallize.md.
test('commands/crystallize.md tells the model to offer /hypo:doctor alongside hypomnema doctor', () => {
  const md = readFileSync(join(REPO, 'commands', 'crystallize.md'), 'utf-8');
  for (const field of ['parkedTotal', 'parkedUnreadable']) {
    const bullet = md.split('\n').find((l) => l.startsWith(`- **\`${field}\`**`));
    assert.ok(bullet, `precondition: the ${field} bullet must exist`);
    assert.ok(
      bullet.includes('`/hypo:doctor`') && bullet.includes('`hypomnema doctor`'),
      `the ${field} bullet must name both doctor forms: ${bullet}`,
    );
  }
});

// ── close checkpoint receipt: a marker that fails must not leave the receipt valid ──
// `--apply-session-close` and `--mark-session-closed` both file the receipt
// first and the compat marker second. A marker that then fails to land makes
// the run report "not closed" (exit 1, close signal unspent) while a receipt
// that stays valid tells a receipt-first Stop the opposite. The shared helper
// takes the marker writer as an argument so this can be pinned in-process:
// there is no way to make the real writer fail after the receipt lands, since
// the invalidation at the start of a close clears anything sitting at the
// marker path.
suite(
  'close checkpoint receipt: marker failure withdraws the receipt, lock timeout, proof completeness',
);

function fakeReceipt(sessionId) {
  return {
    schemaVersion: 1,
    certification: 'committed-close-checkpoint',
    generation: 'g'.repeat(32),
    sessionId,
    createdAt: new Date().toISOString(),
  };
}

// Disabling the check: in landReceiptThenMarker (scripts/lib/crystallize-close-apply.mjs)
// delete the invalidateCloseArtifacts call in the marker-did-not-land branch.
test('a marker writer that returns false leaves no valid receipt behind', () => {
  withTmpDir((dir) => {
    const sid = `lrm-false-${process.pid}`;
    const rp = receiptPath(dir, sid);
    const out = landReceiptThenMarker(dir, sid, fakeReceipt(sid), () => {
      assert.ok(existsSync(rp), 'the receipt is filed BEFORE the marker is attempted');
      return false;
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'marker-did-not-land');
    assert.equal(out.retractFailed, undefined, 'the withdrawal itself worked');
    assert.equal(
      existsSync(rp),
      false,
      'the receipt must be withdrawn when the marker did not land',
    );
    assert.equal(existsSync(sessionClosedMarkerPath(dir, sid)), false);
  });
});

test('a marker writer that throws is treated as not written, and the receipt is withdrawn', () => {
  withTmpDir((dir) => {
    const sid = `lrm-throw-${process.pid}`;
    const out = landReceiptThenMarker(dir, sid, fakeReceipt(sid), () => {
      throw new Error('disk full');
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'marker-did-not-land');
    assert.equal(existsSync(receiptPath(dir, sid)), false);
  });
});

test('a writer that claims success but leaves no marker file on disk does not count as landed', () => {
  withTmpDir((dir) => {
    const sid = `lrm-claim-${process.pid}`;
    const out = landReceiptThenMarker(dir, sid, fakeReceipt(sid), () => true);
    assert.equal(out.ok, false, 'the writer says it wrote, the disk says it is not there');
    assert.equal(out.reason, 'marker-did-not-land');
    assert.equal(existsSync(receiptPath(dir, sid)), false);
  });
});

test('a marker that lands keeps its receipt (the negative control for the withdrawal)', () => {
  withTmpDir((dir) => {
    const sid = `lrm-ok-${process.pid}`;
    const receipt = fakeReceipt(sid);
    const out = landReceiptThenMarker(dir, sid, receipt, () =>
      writeSessionClosedMarker(dir, sid, {
        project: 'p',
        projects: ['p'],
        receiptGeneration: receipt.generation,
      }),
    );
    assert.deepEqual(out, { ok: true });
    assert.ok(existsSync(receiptPath(dir, sid)), 'a landed close keeps its receipt');
    assert.ok(existsSync(sessionClosedMarkerPath(dir, sid)));
  });
});

test('a receipt that cannot be written never reaches the marker writer', () => {
  withTmpDir((dir) => {
    const sid = `lrm-nowrite-${process.pid}`;
    const sessionCacheDir = dirname(receiptPath(dir, sid));
    mkdirSync(dirname(sessionCacheDir), { recursive: true });
    writeFileSync(sessionCacheDir, 'a file where the session directory should be\n');
    let called = false;
    const out = landReceiptThenMarker(dir, sid, fakeReceipt(sid), () => {
      called = true;
      return true;
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'receipt-write-failed');
    assert.equal(called, false, 'no marker may be written without a receipt behind it');
  });
});

// A receipt whose write reports failure AFTER the rename (the re-read failed)
// can still be on disk. umask 0o777 makes the temp file 0000, so the rename
// lands and the re-read gets EACCES: the write "failed" with the receipt in
// place. A transient re-read error would otherwise leave a valid receipt with
// no marker behind it.
// Disabling the check: in landReceiptThenMarker make the `reread-` branch return
// `{ ok: true }` instead of calling withdrawOwnReceipt.
test('a receipt whose re-read fails is withdrawn, and the marker writer is never reached', () => {
  if (process.getuid?.() === 0) return; // root reads a 0000 file, so the failure cannot be injected
  withTmpDir((dir) => {
    const sid = `lrm-reread-${process.pid}`;
    const rp = receiptPath(dir, sid);
    mkdirSync(dirname(rp), { recursive: true }); // created before the umask change, at a usable mode
    let called = false;
    const old = process.umask(0o777);
    let out;
    try {
      out = landReceiptThenMarker(dir, sid, fakeReceipt(sid), () => {
        called = true;
        return true;
      });
    } finally {
      process.umask(old);
    }
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'receipt-write-failed');
    assert.match(
      out.writeReason,
      /^reread-failed/,
      `the failure must be the re-read: ${out.writeReason}`,
    );
    assert.equal(out.retractFailed, undefined, 'the withdrawal itself worked');
    assert.equal(called, false);
    assert.equal(
      existsSync(rp),
      false,
      'a receipt the write could not confirm must not stay valid',
    );
    assert.ok(
      readdirSync(dirname(rp)).some((f) => f.startsWith('close-receipt.json.invalidated-')),
      'the withdrawn receipt is renamed aside, not deleted',
    );
  });
});

// Disabling the check: in withdrawOwnReceipt delete the `onDisk.generation !==
// generation` early return.
test('withdrawOwnReceipt leaves a receipt that another close of the same session filed', () => {
  withTmpDir((dir) => {
    const sid = `lrm-foreign-${process.pid}`;
    const rp = receiptPath(dir, sid);
    mkdirSync(dirname(rp), { recursive: true });
    const theirs = { ...fakeReceipt(sid), generation: 'o'.repeat(32) };
    writeFileSync(rp, JSON.stringify(theirs));
    const marker = sessionClosedMarkerPath(dir, sid);
    writeFileSync(marker, '{}');
    const out = withdrawOwnReceipt(dir, sid, 'g'.repeat(32));
    assert.deepEqual(out, { ok: true, withdrawn: false });
    assert.ok(existsSync(rp), 'the other close receipt must survive');
    assert.ok(existsSync(marker), 'and so must the marker that projects it');
  });
});

test('withdrawOwnReceipt takes back a receipt of the same generation, and treats an absent one as nothing to do', () => {
  withTmpDir((dir) => {
    const sid = `lrm-own-${process.pid}`;
    const rp = receiptPath(dir, sid);
    assert.deepEqual(withdrawOwnReceipt(dir, sid, 'g'.repeat(32)), { ok: true, withdrawn: false });
    mkdirSync(dirname(rp), { recursive: true });
    writeFileSync(rp, JSON.stringify(fakeReceipt(sid)));
    assert.deepEqual(withdrawOwnReceipt(dir, sid, 'g'.repeat(32)), { ok: true, withdrawn: true });
    assert.equal(existsSync(rp), false);
  });
});

// Disabling the check: in runMarkSessionClosed remove the try/catch around the
// withFileLock call (the pre-fix shape), so ELOCKTIMEOUT escapes as a stack.
test('--mark-session-closed reports a vault-commit lock timeout as JSON and exit 1, not a stack', () => {
  withWiki(null, (dir) => {
    const sessionId = `mark-locktimeout-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    const releaseLock = withHeldCommitLock(dir);
    try {
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        `--session-id=${sessionId}`,
        '--project=test-project',
        '--json',
      ]);
      assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      let out;
      assert.doesNotThrow(() => (out = JSON.parse(r.stdout)), `stdout must be JSON: ${r.stdout}`);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'vault-commit-lock-timeout');
      assert.equal(/ELOCKTIMEOUT|at withFileLock/.test(r.stderr), false, `no stack: ${r.stderr}`);
      assert.equal(existsSync(sessionClosedMarkerPath(dir, sessionId)), false);
      assert.equal(existsSync(receiptPath(dir, sessionId)), false);
    } finally {
      releaseLock();
      cleanup();
    }
  });
});

// Disabling the check: in buildMarkCloseProof delete the `if (!status.ok ||
// !status.sessionLogEvidence?.path)` early continue and restore the conditional
// spread `...(status.sessionLogEvidence?.path ? [status.sessionLogEvidence.path] : [])`
// in targets. The session-log target then silently drops out of the proof.
test('buildMarkCloseProof marks a project incomplete when it has no session-log evidence file', () => {
  withWiki(
    (dir, today) => {
      // No session-log file at all for the project: sessionCloseFileStatus then
      // has no evidence path to name, and every OTHER target is committed and clean.
      rmSync(join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`));
    },
    (dir, today) => {
      const closeId = closeIdFor('s-proof-nolog', 0);
      writeEntryFile(dir, { closeId, date: today, tracks: [{ id: 'main', new: true }] });
      const proof = buildMarkCloseProof(dir, ['test-project'], false, { closeId });
      assert.equal(
        proof.ok,
        false,
        `an uncheckable session-log must not certify: ${JSON.stringify(proof)}`,
      );
      assert.deepEqual(proof.incompleteProjects, ['test-project']);
      assert.deepEqual(proof.entries, []);
    },
  );
});

test('buildMarkCloseProof certifies a project whose session-log evidence is committed (negative control)', () => {
  withWiki(null, (dir, today) => {
    const closeId = closeIdFor('s-proof-ok', 0);
    const rel = writeEntryFile(dir, { closeId, date: today, tracks: [{ id: 'main', new: true }] });
    const proof = buildMarkCloseProof(dir, ['test-project'], false, { closeId });
    assert.equal(proof.ok, true, JSON.stringify(proof));
    assert.ok(
      proof.entries.some((e) => /session-log\//.test(e.path)),
      `the session-log evidence file must be among the proven paths: ${JSON.stringify(proof.entries)}`,
    );
    assert.ok(
      proof.entries.some((e) => e.path === rel && e.kind === 'create'),
      `this close's committed entry is proven as a create: ${JSON.stringify(proof.entries)}`,
    );
  });
});

// Disabling the check: in the apply receipt (runMarkerPhase) set scope.projects
// back to `gateEvaluatedProjects.length ? gateEvaluatedProjects : [project]`.
test('the apply receipt names the project it proved, not every project the gate evaluated', () => {
  withWiki(
    (dir, today) => {
      // A second project that is fully closed today, so the (global) gate
      // evaluates it alongside test-project.
      // Copied from test-project so it is as clean as that one: lint, freshness
      // and the root pointer table all have to pass for the marker to land.
      cpSync(join(dir, 'projects', 'test-project'), join(dir, 'projects', 'other-project'), {
        recursive: true,
      });
      const logPath = join(dir, 'log.md');
      writeFileSync(
        logPath,
        `${readFileSync(logPath, 'utf-8')}\n## [${today}] session | other-project\n`,
      );
      const rootHot = join(dir, 'hot.md');
      writeFileSync(
        rootHot,
        `${readFileSync(rootHot, 'utf-8')}| other-project | ${today} | [[projects/other-project/hot]] |\n`,
      );
    },
    (dir, today) => {
      const sessionId = `scope-proved-${process.pid}`;
      const r = runApply(dir, payloadForCleanWiki(dir, today), { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `precondition: the close must land: ${r.stdout}\n${r.stderr}`);
      assert.equal(out.markerWritten, true, `precondition: the marker must land: ${r.stdout}`);
      const marker = JSON.parse(readFileSync(sessionClosedMarkerPath(dir, sessionId), 'utf-8'));
      const evaluated = marker.verified_scope?.projects || [];
      assert.ok(
        evaluated.includes('other-project') && evaluated.includes('test-project'),
        `precondition: the gate must have evaluated both projects: ${JSON.stringify(marker)}`,
      );
      const receipt = JSON.parse(readFileSync(receiptPath(dir, sessionId), 'utf-8'));
      assert.deepEqual(receipt.scope, { mode: 'project', projects: ['test-project'] });
    },
  );
});

// Disabling the check: delete the stage rows for the three receipt-stage codes
// (or invalidate-failed) from the stage table in commands/crystallize.md.
test('commands/crystallize.md documents every failure stage the receipt path can raise, and mismatches[]', () => {
  const md = readFileSync(join(REPO, 'commands', 'crystallize.md'), 'utf-8');
  for (const stage of [
    'invalidate-failed',
    'receipt-proof-mismatch',
    'receipt-write-failed',
    'marker-did-not-land',
  ]) {
    const row = md.split('\n').find((l) => l.startsWith(`| \`${stage}\``));
    assert.ok(row, `the stage table needs a row for ${stage}`);
  }
  assert.ok(md.includes('mismatches[]'), 'the doc must explain mismatches[]');
});

// W19 fixture: design-history is as new as today and a session-log heading
// carries a date that is not on the calendar, so lint reports W19 (never W8).
// Local to this area; the same shape lives in the other close areas' tests.
function addW19Overflow(dir, today) {
  const proj = join(dir, 'projects', 'test-project');
  writeFileSync(
    join(proj, 'design-history.md'),
    `---\ntitle: dh\ntype: reference\nupdated: ${today}\n---\n\n## ${today}\nfoo\n`,
  );
  const shard = join(proj, 'session-log', `${today.slice(0, 7)}.md`);
  writeFileSync(shard, readFileSync(shard, 'utf-8') + '\n## [2026-02-30] heading typo\n');
}

suite('close surfaces W19 as a non-blocking notice, not as "lint clean"');

test('close with only a W19 finding succeeds, prints the notice, and does not claim "lint clean"', () => {
  withWiki(addW19Overflow, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = `w19-console-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const r = runApplyConsole(dir, payload, sessionId);
      assert.equal(r.status, 0, `W19 alone must not fail the close: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /session-close verified/, `close must succeed: ${r.stdout}`);
      assert.match(
        r.stdout,
        /not on the calendar[^\n]*2026-02-30[^\n]*\(not blocking\)/,
        `the W19 finding must be printed as a notice: ${r.stdout}`,
      );
      assert.ok(
        !r.stdout.includes('lint clean'),
        `"lint clean" must not be claimed over a shown W19 notice: ${r.stdout}`,
      );
      assert.match(r.stdout, /no lint blockers/, `success line says nothing blocks: ${r.stdout}`);
    } finally {
      cleanup();
    }
  });
});

test('--json close with only a W19 finding: ok, lintNotices lists it, and no blocker names it', () => {
  withWiki(addW19Overflow, (dir, today) => {
    const r = runApply(dir, payloadForCleanWiki(dir, today));
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `W19 alone must not fail the close: ${r.stdout}`);
    assert.equal(r.status, 0);
    assert.equal(out.lintNotices.length, 1, `one W19 notice: ${JSON.stringify(out.lintNotices)}`);
    assert.equal(out.lintNotices[0].id, 'W19');
    assert.equal(out.lintNotices[0].file, 'projects/test-project/design-history.md');
    assert.deepEqual(out.gateBlockers, [], 'W19 is never a gate blocker');
  });
});

// Same overflow heading, but in a project the close is not targeting.
function addW19OverflowElsewhere(dir, today) {
  const proj = join(dir, 'projects', 'other-project');
  mkdirSync(join(proj, 'session-log'), { recursive: true });
  writeFileSync(
    join(proj, 'design-history.md'),
    `---\ntitle: dh\ntype: reference\nupdated: ${today}\n---\n\n## ${today}\nfoo\n`,
  );
  writeFileSync(
    join(proj, 'session-log', `${today.slice(0, 7)}.md`),
    `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [2026-02-30] heading typo\n`,
  );
}

test('W19 in the closing project is printed per finding and not folded into a count', () => {
  withWiki(addW19Overflow, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = `w19-scope-in-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const j = JSON.parse(runApply(dir, payload).stdout);
      assert.deepEqual(
        j.lintNotices.map((w) => w.file),
        ['projects/test-project/design-history.md'],
        'fixture must put the W19 in the closing project',
      );
      const r = runApplyConsole(dir, payload, sessionId);
      assert.match(
        r.stdout,
        /⚠ projects\/test-project\/design-history\.md: [^\n]*2026-02-30[^\n]*\(not blocking\)/,
        `in-scope W19 is listed: ${r.stdout}`,
      );
      assert.ok(
        !r.stdout.includes('project(s) with calendar-overflow session-log headings'),
        `nothing is folded when the finding is in scope: ${r.stdout}`,
      );
    } finally {
      cleanup();
    }
  });
});

test('W19 only in another project folds to one count line, keeps "no lint blockers", stays in lintNotices', () => {
  withWiki(addW19OverflowElsewhere, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = `w19-scope-out-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const j = JSON.parse(runApply(dir, payload).stdout);
      const w19 = j.lintNotices.filter((w) => w.id === 'W19');
      assert.equal(w19.length, 1, `one W19 in lintNotices: ${JSON.stringify(j.lintNotices)}`);
      assert.ok(
        w19[0].file.startsWith('projects/other-project/'),
        `fixture must put the W19 in the other project: ${w19[0].file}`,
      );
      const r = runApplyConsole(dir, payload, sessionId);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.ok(
        !r.stdout.includes('⚠ projects/other-project'),
        `no per-finding line for another project: ${r.stdout}`,
      );
      assert.match(
        r.stdout,
        /\+1 project\(s\) with calendar-overflow session-log headings \(not blocking\)/,
        `folded count line: ${r.stdout}`,
      );
      assert.match(r.stdout, /no lint blockers/, `success line: ${r.stdout}`);
      assert.ok(!r.stdout.includes('lint clean'), `not clean while a W19 exists: ${r.stdout}`);
    } finally {
      cleanup();
    }
  });
});

test('two overflow headings in one other project fold to "+1 project(s)", not a heading count', () => {
  withWiki(
    (dir, today) => {
      addW19OverflowElsewhere(dir, today);
      appendFileSync(
        join(dir, 'projects', 'other-project', 'session-log', `${today.slice(0, 7)}.md`),
        '\n## [2026-02-31] second typo\n',
      );
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      const sessionId = `w19-two-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      const cleanup = seedCloseTranscript(sessionId);
      try {
        const j = JSON.parse(runApply(dir, payload).stdout);
        const w19 = j.lintNotices.filter((w) => w.id === 'W19');
        assert.equal(w19.length, 1, `one finding per project: ${JSON.stringify(w19)}`);
        assert.ok(
          w19[0].message.includes('2026-02-30') && w19[0].message.includes('2026-02-31'),
          `the message lists both headings: ${w19[0].message}`,
        );
        const r = runApplyConsole(dir, payload, sessionId);
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
        assert.match(
          r.stdout,
          /\+1 project\(s\) with calendar-overflow session-log headings \(not blocking\)/,
          `fold line counts projects: ${r.stdout}`,
        );
        assert.ok(!r.stdout.includes('+2 '), `not counted per heading: ${r.stdout}`);
      } finally {
        cleanup();
      }
    },
  );
});

test('a close with no W19 finding keeps "lint clean" and an empty lintNotices', () => {
  withWiki(null, (dir, today) => {
    const sessionId = `w19-none-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const payload = payloadForCleanWiki(dir, today);
      const r = runApplyConsole(dir, payload, sessionId);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /lint clean/, `no notice, so the clean claim stands: ${r.stdout}`);
      const j = JSON.parse(runApply(dir, payload).stdout);
      assert.deepEqual(j.lintNotices, []);
    } finally {
      cleanup();
    }
  });
});

// Disabling the check: in crystallize-close-apply.mjs printCloseReport, make
// lintWord depend on w19Notice.length only (drop the closeScopeNotice and
// otherDebtCount terms).
test('a close that prints pre-existing lint debt below does not claim "lint clean"', () => {
  const cases = [
    ['elsewhere in the vault', 'other-proj'],
    ['in untouched files of the closing project', 'test-project'],
  ];
  for (const [label, proj] of cases) {
    withWiki(
      (dir) => {
        mkdirSync(join(dir, 'projects', proj), { recursive: true });
        writeFileSync(
          join(dir, 'projects', proj, 'broken.md'),
          '---\ntitle: broken\ntype: concept\n\nbody (frontmatter never closes)\n',
        );
      },
      (dir, today) => {
        const sessionId = `lint-debt-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
        const cleanup = seedCloseTranscript(sessionId);
        try {
          const r = runApplyConsole(dir, payloadForCleanWiki(dir, today), sessionId);
          assert.equal(r.status, 0, `${label}: ${r.stdout}\n${r.stderr}`);
          assert.match(
            r.stdout,
            /pre-existing lint issue\(s\)/,
            `${label}: debt line shown: ${r.stdout}`,
          );
          assert.match(r.stdout, /no lint blockers/, `${label}: ${r.stdout}`);
          assert.ok(!r.stdout.includes('lint clean'), `${label}: not clean: ${r.stdout}`);
        } finally {
          cleanup();
        }
      },
    );
  }
});

// Disabling the check: put `node scripts/lint.mjs` back in the W19 fold line and
// the otherDebtCount line of printCloseReport.
test('the lint-debt fold lines point at /hypo:lint, not at a script path a vault does not have', () => {
  withWiki(
    (dir, today) => {
      addW19OverflowElsewhere(dir, today);
      mkdirSync(join(dir, 'projects', 'debt-proj'), { recursive: true });
      writeFileSync(
        join(dir, 'projects', 'debt-proj', 'broken.md'),
        '---\ntitle: broken\ntype: concept\n\nbody (frontmatter never closes)\n',
      );
    },
    (dir, today) => {
      const sessionId = `lint-hint-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
      const cleanup = seedCloseTranscript(sessionId);
      try {
        const r = runApplyConsole(dir, payloadForCleanWiki(dir, today), sessionId);
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
        const lines = r.stdout
          .split('\n')
          .filter((l) => /project\(s\) with calendar-overflow|elsewhere in the vault/.test(l));
        assert.equal(lines.length, 2, `both fold lines print: ${r.stdout}`);
        for (const l of lines) {
          assert.ok(l.includes('`/hypo:lint`'), `names /hypo:lint: ${l}`);
          assert.ok(!l.includes('scripts/lint.mjs'), `no script path: ${l}`);
        }
      } finally {
        cleanup();
      }
    },
  );
});

// Disabling the check: revert the lintNotices bullet and the post-apply lint
// line in commands/crystallize.md to the old unconditional "post-apply lint clean".
test('commands/crystallize.md documents lintNotices and does not instruct an unconditional "lint clean"', () => {
  const md = readFileSync(join(REPO, 'commands', 'crystallize.md'), 'utf-8');
  const bullet = md.split('\n').find((l) => l.startsWith('- **`lintNotices[]`**'));
  assert.ok(bullet, 'precondition: the lintNotices[] bullet must exist');
  assert.ok(
    bullet.includes('not blocking') || bullet.includes('never block'),
    `non-blocking: ${bullet}`,
  );
  assert.ok(bullet.includes('verbatim'), `report verbatim: ${bullet}`);
  assert.ok(!md.includes('✓ post-apply lint clean'), 'no unconditional "post-apply lint clean"');
  const line = md.split('\n').find((l) => l.startsWith('- ✓ post-apply lint'));
  assert.ok(line, 'precondition: the post-apply lint checklist line must exist');
  assert.ok(
    line.includes('no blockers') && line.includes('lintNotices'),
    `the line ties "lint clean" to an empty lintNotices: ${line}`,
  );
});

// A project with no design-history.md and a calendar-overflow heading: W14 has no
// default --json id, so close only sees it through the W19 that lint also emits.
function addOverflowWithoutDesignHistory(dir, today) {
  const proj = join(dir, 'projects', 'test-project');
  rmSync(join(proj, 'design-history.md'), { force: true });
  const shard = join(proj, 'session-log', `${today.slice(0, 7)}.md`);
  writeFileSync(shard, readFileSync(shard, 'utf-8') + '\n## [2026-02-30] heading typo\n');
}

// Disabling the check: remove the W19 issue() emitted in the `s.kind === 'missing'`
// branch of the design-history loop in scripts/lint.mjs.
test('overflow heading in a project without design-history.md: close lists it as a W19 notice', () => {
  withWiki(addOverflowWithoutDesignHistory, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const sessionId = `w19-missing-dh-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const j = JSON.parse(runApply(dir, payload).stdout);
      assert.equal(j.ok, true, `W19 alone must not fail the close: ${JSON.stringify(j)}`);
      assert.equal(j.lintNotices.length, 1, JSON.stringify(j.lintNotices));
      assert.equal(j.lintNotices[0].id, 'W19');
      assert.ok(j.lintNotices[0].message.includes('2026-02-30'), j.lintNotices[0].message);
      assert.ok(
        !j.lintNotices[0].message.includes('design-history와 날짜를 비교'),
        'the missing-file variant does not talk about comparing with design-history',
      );
      const r = runApplyConsole(dir, payload, sessionId);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /⚠ [^\n]*2026-02-30[^\n]*\(not blocking\)/, r.stdout);
      assert.ok(!r.stdout.includes('lint clean'), r.stdout);
    } finally {
      cleanup();
    }
  });
});

// ── close pin: one close id per close request ────────────────────────────────
// Until the original-entry writer lands, the observable face of "the same
// original path" is the id the pin hands out: the entry file name is
// `<date>-<closeId>.md`.

suite('crystallize.mjs close pin (one close id per close request)');

const PIN_CLOSE_PHRASE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '세션 마무리 해줘' },
});

function pinTranscriptPath(sessionId) {
  return join(SESSION_TMP_HOME, '.claude', 'projects', 'hypo-test-proj', `${sessionId}.jsonl`);
}

/** The user types the close phrase again: one more genuine close record. */
function typeCloseAgain(sessionId) {
  appendFileSync(pinTranscriptPath(sessionId), PIN_CLOSE_PHRASE + '\n');
}

function pinGate(dir, sessionId) {
  return closeGateStatus({
    transcriptPath: pinTranscriptPath(sessionId),
    hypoDir: dir,
    sessionId,
  });
}

/** What the PreCompact and `--mark-session-closed` verdict sites compute. */
function pinProofId(dir, sessionId) {
  const gate = pinGate(dir, sessionId);
  return sessionProofCloseId(dir, sessionId, {
    closeOpen: gate.ok,
    resolvedAtIndex: gate.resolvedAtIndex,
  });
}

// An apply that stops at payload validation: authority passed and the pin was
// taken, but nothing resolved, so the close request stays open.
function unresolvedApply(dir, today, sessionId) {
  const out = JSON.parse(
    runApply(dir, { project: 'test-project', date: today }, { sessionId }).stdout,
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /payload schema invalid/);
}

function newPinSession(label) {
  return `${label}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

// Disabling the check: in applying a close, skip the stored-pin lookup in
// pinCloseId (always build the pending from the current openedAtIndex).
test('a retry after the user typed the close phrase again keeps the first close id', () => {
  withWiki(null, (dir, today) => {
    const sessionId = newPinSession('pin-retype');
    const cleanup = seedCloseTranscript(sessionId);
    try {
      unresolvedApply(dir, today, sessionId);
      assert.equal(readClosePin(dir, sessionId).pending.closeId, closeIdFor(sessionId, 0));

      typeCloseAgain(sessionId);
      assert.equal(
        pinGate(dir, sessionId).openedAtIndex,
        1,
        'the fixture must move the signal, or this test pins nothing',
      );
      unresolvedApply(dir, today, sessionId);
      const pending = readClosePin(dir, sessionId).pending;
      assert.equal(pending.closeId, closeIdFor(sessionId, 0));
      assert.equal(pending.openedAtIndex, 0);

      // The close has not resolved: the open request's id is the pending one.
      assert.equal(pinProofId(dir, sessionId), closeIdFor(sessionId, 0));

      // The retry that finally carries a valid payload publishes under the FIRST id: the
      // entry path is what the pin pins, not a pending record the observable id stands for.
      const done = JSON.parse(runApply(dir, v2Payload(today), { sessionId }).stdout);
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.deepEqual(sessionFilesOf(dir), [`${today}-${closeIdFor(sessionId, 0)}.md`]);
    } finally {
      cleanup();
    }
  });
});

// Disabling the check: in pinCloseId, build the pending from `openedAtIndex`
// whenever the signal moved, or in resolveClosePin drop the lastResolved write.
test('a failed receipt after the commit (journal cleared) retries under the same id, and a resolved close hands out its id until a new request opens', () => {
  withWiki(null, (dir, today) => {
    const sessionId = newPinSession('pin-receipt');
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const sessionCacheDir = join(dir, '.cache', 'sessions', sessionId);
      mkdirSync(dirname(sessionCacheDir), { recursive: true });
      writeFileSync(sessionCacheDir, 'occupied by a file, not a directory\n');
      const payload = payloadForCleanWiki(dir, today);
      const first = JSON.parse(runApply(dir, payload, { sessionId }).stdout);
      assert.equal(first.stage, 'receipt-write-failed', JSON.stringify(first));
      assert.equal(first.committed, true);
      assert.deepEqual(
        readJournal(dir, sessionId),
        {},
        'the commit landed, so the journal is gone',
      );

      const id = closeIdFor(sessionId, 0);
      assert.equal(readClosePin(dir, sessionId).pending.closeId, id);
      assert.deepEqual(sessionFilesOf(dir), [`${today}-${id}.md`], 'the entry is under that id');
      assert.equal(
        pinProofId(dir, sessionId),
        id,
        'closeOpen:true still resolves to the pinned id',
      );

      unlinkSync(sessionCacheDir);
      typeCloseAgain(sessionId);
      const retry = JSON.parse(runApply(dir, payload, { sessionId }).stdout);
      assert.equal(retry.ok, true, JSON.stringify(retry));
      const resolved = readClosePin(dir, sessionId);
      assert.equal(resolved.pending, null);
      assert.equal(resolved.lastResolved, id, 'the retry kept the id although the signal moved');
      assert.deepEqual(
        sessionFilesOf(dir),
        [`${today}-${id}.md`],
        'the retry adopted the same entry file, it did not write a second one',
      );

      // Resolved, no open signal: the finished close vouches for itself.
      const afterGate = pinGate(dir, sessionId);
      assert.equal(afterGate.ok, false);
      assert.equal(pinProofId(dir, sessionId), id);

      // A new close request after the resolution gets a new id.
      typeCloseAgain(sessionId);
      const newGate = pinGate(dir, sessionId);
      assert.equal(newGate.ok, true);
      unresolvedApply(dir, today, sessionId);
      const next = readClosePin(dir, sessionId);
      assert.equal(next.pending.closeId, closeIdFor(sessionId, newGate.openedAtIndex));
      assert.notEqual(next.pending.closeId, id);
      assert.equal(next.lastResolved, id);
    } finally {
      cleanup();
    }
  });
});

// Disabling the check: in sessionProofCloseId delete the `closeOpen ? null :`
// branch (return lastResolved whenever there is no pending).
test('after a resolution, a second close signal that has not been applied yet is not proven by the earlier close id', () => {
  withWiki(null, (dir, today) => {
    const sessionId = newPinSession('pin-second-signal');
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const ok = JSON.parse(runApply(dir, payloadForCleanWiki(dir, today), { sessionId }).stdout);
      assert.equal(ok.ok, true, JSON.stringify(ok));
      const id = closeIdFor(sessionId, 0);
      assert.equal(readClosePin(dir, sessionId).lastResolved, id);

      typeCloseAgain(sessionId);
      assert.equal(pinGate(dir, sessionId).ok, true, 'the new signal is open');
      assert.equal(pinProofId(dir, sessionId), null);
      // Paired: the same pin with no open signal is the earlier close's proof.
      const gate = pinGate(dir, sessionId);
      assert.equal(
        sessionProofCloseId(dir, sessionId, {
          closeOpen: false,
          resolvedAtIndex: gate.resolvedAtIndex,
        }),
        id,
      );
    } finally {
      cleanup();
    }
  });
});

// Runs applySessionClose in a child with the seam that crashes a close between
// the gate resolution record and the pin move.
function applyCrashingAfterResolution(dir, payload, sessionId) {
  const payloadPath = join(
    tmpdir(),
    `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
  );
  writeFileSync(payloadPath, JSON.stringify(payload));
  const argv = [
    'node',
    'crystallize.mjs',
    `--hypo-dir=${dir}`,
    '--apply-session-close',
    `--payload=${payloadPath}`,
    '--json',
    `--session-id=${sessionId}`,
  ];
  const script = `
    import { parseArgs } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'lib', 'crystallize-args.mjs')).href)};
    import { applySessionClose } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'lib', 'crystallize-close-apply.mjs')).href)};
    applySessionClose(parseArgs(${JSON.stringify(argv)}), {
      afterResolutionBeforePin() {
        throw new Error('crash between resolution and pin');
      },
    });
  `;
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
  } finally {
    rmSync(payloadPath, { force: true });
  }
}

// Disabling the check: delete the normalizeClosePin call in pinCloseId and in
// sessionProofCloseId. The "new request gets a new id" assertion goes red; the
// retry-keeps-its-id test above stays green.
test('a close that crashed between its resolution record and the pin move does not lend its id to the next request', () => {
  withWiki(null, (dir, today) => {
    const sessionId = newPinSession('pin-crash');
    const cleanup = seedCloseTranscript(sessionId);
    try {
      const r = applyCrashingAfterResolution(dir, payloadForCleanWiki(dir, today), sessionId);
      assert.notEqual(r.status, 0, `the seam must crash the child: ${r.stdout}`);
      assert.match(r.stderr, /crash between resolution and pin/);
      assert.ok(existsSync(closeGatePath(dir, sessionId)), 'the resolution record landed first');
      const stale = closeIdFor(sessionId, 0);
      assert.equal(
        readClosePin(dir, sessionId).pending?.closeId,
        stale,
        'pending was left standing',
      );
      const staleFile = join(sessionsDirOf(dir), `${today}-${stale}.md`);
      const staleBytes = readFileSync(staleFile, 'utf-8');

      typeCloseAgain(sessionId);
      const gate = pinGate(dir, sessionId);
      assert.equal(gate.ok, true);
      // Before any apply: the already-resolved pending must not prove the new request.
      assert.equal(pinProofId(dir, sessionId), null);

      unresolvedApply(dir, today, sessionId);
      const pin = readClosePin(dir, sessionId);
      assert.equal(pin.pending.closeId, closeIdFor(sessionId, gate.openedAtIndex));
      assert.notEqual(pin.pending.closeId, stale);
      assert.equal(pin.lastResolved, stale);

      // The new request writes its own entry; the earlier close's bytes are untouched.
      const next = JSON.parse(
        runApply(
          dir,
          v2Payload(today, {
            tracks: [{ id: 'p2-track', new: true, next: '- p2' }],
            tag: 'p2 new request',
          }),
          { sessionId },
        ).stdout,
      );
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(
        existsSync(
          join(sessionsDirOf(dir), `${today}-${closeIdFor(sessionId, gate.openedAtIndex)}.md`),
        ),
        true,
        'the new request has its own entry path',
      );
      assert.equal(readFileSync(staleFile, 'utf-8'), staleBytes, 'the earlier entry is unchanged');
    } finally {
      cleanup();
    }
  });
});

// Disabling the check: in the `if (resolutionLanded)` guard, make it
// unconditional. Not reachable from outside (recordGateClosed cannot be made to
// fail while the receipt still lands), so it has no test of its own.

test('a pin that cannot be written stops the close before any wiki write, at stage close-pin', () => {
  withWiki(null, (dir, today) => {
    const sessionId = newPinSession('pin-unwritable');
    const cleanup = seedCloseTranscript(sessionId);
    try {
      // A plain file where the pin directory must go makes the durable write fail.
      mkdirSync(join(dir, '.cache'), { recursive: true });
      writeFileSync(dirname(closePinPath(dir, sessionId)), 'occupied by a file\n');
      const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
      const r = runApply(dir, payloadForCleanWiki(dir, today), { sessionId });
      const out = JSON.parse(r.stdout);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(out.stage, 'close-pin', r.stdout);
      assert.equal(out.committed, null);
      const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
      assert.equal(headAfter.stdout, headBefore.stdout, 'no commit was made');
      assert.equal(existsSync(closeGatePath(dir, sessionId)), false, 'nothing resolved');
    } finally {
      cleanup();
    }
  });
});

// ── original session entries: what a close writes ────────────────────────────
// A close writes one immutable `projects/<p>/sessions/<date>-<close_id>.md` and no state file.
// Helpers shared by the suites below. Each suite is its own selection unit.

function sessionsDirOf(dir, project = 'test-project') {
  return join(dir, 'projects', project, 'sessions');
}

function sessionFilesOf(dir, project = 'test-project') {
  const d = sessionsDirOf(dir, project);
  return existsSync(d)
    ? readdirSync(d)
        .filter((f) => f.endsWith('.md'))
        .sort()
    : [];
}

function entryAt(dir, file, project = 'test-project') {
  const parsed = parseSessionEntry(readFileSync(join(sessionsDirOf(dir, project), file), 'utf-8'));
  assert.equal(parsed.ok, true, `${file} must parse: ${parsed.reason}`);
  return parsed.entry;
}

/** A current-format payload; `tag` keeps each close's session-log entry distinct. */
function v2Payload(
  today,
  { summary = 'close summary', tracks, tag = 'entry close', ...rest } = {},
) {
  return {
    project: 'test-project',
    date: today,
    summary,
    tracks: tracks ?? [{ id: 'main', new: true, next: '- next step' }],
    sessionLog: { entry: `## [${today}] ${tag}\n` },
    ...rest,
  };
}

function applyJson(dir, payload, sessionId) {
  const r = runApply(dir, payload, { sessionId });
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    assert.fail(`apply printed no JSON (status ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
  return { r, out };
}

// A close of `sessionId` that committed its entry and stopped before its receipt:
// the pin still holds it as pending, which is what `--mark-session-closed` proves
// this session by while the close signal is still open.
function pinCommittedClose(dir, sessionId, date) {
  const closeId = closeIdFor(sessionId, 0);
  const rel = writeEntryFile(dir, { closeId, date, tracks: [{ id: 'main', new: true }] });
  writeClosePin(dir, sessionId, {
    pending: { closeId, openedAtIndex: 0, entryRelPath: rel, entrySha256s: [] },
    lastResolved: null,
    localProofs: {},
  });
  return closeId;
}

/** An entry file written (and committed) as if another session had closed. */
function writeEntryFile(dir, { closeId, date, tracks, summary = 'other session', bodies = {} }) {
  const text = formatSessionEntry({
    project: 'test-project',
    closeId,
    date,
    tracks,
    summary,
    bodies,
  });
  const rel = join('projects', 'test-project', 'sessions', `${date}-${closeId}.md`);
  mkdirSync(sessionsDirOf(dir), { recursive: true });
  writeFileSync(join(dir, rel), text);
  const env = { ...process.env, HOME: SESSION_TMP_HOME };
  spawnSync('git', ['add', '-A'], { cwd: dir, env });
  spawnSync('git', ['commit', '-m', `entry ${closeId}`], { cwd: dir, env });
  return rel;
}

function headsOf(dir, project = 'test-project') {
  const model = loadSessionModel(dir, project);
  return Object.fromEntries(
    trackHeads(model.entries).map((t) => [t.trackId, t.heads.map((h) => h.closeId)]),
  );
}

const commitCountOf = (dir) =>
  Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).stdout);

// A pre-commit hook that rejects every commit: the close commits nothing, which is the
// "commit failed" state a retry has to cope with.
function blockCommits(dir) {
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\necho blocked by test >&2\nexit 1\n', { mode: 0o755 });
  return () => rmSync(hook, { force: true });
}

/**
 * `applySessionClose` in a child with test seams: `hooksSource` is the source of the
 * `testHooks` object literal (it may use `writeFileSync`).
 */
function applyWithHooks(dir, payload, sessionId, hooksSource) {
  const payloadPath = join(
    tmpdir(),
    `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
  );
  writeFileSync(payloadPath, JSON.stringify(payload));
  const argv = [
    'node',
    'crystallize.mjs',
    `--hypo-dir=${dir}`,
    '--apply-session-close',
    `--payload=${payloadPath}`,
    '--json',
    `--session-id=${sessionId}`,
  ];
  const script = `
    import { writeFileSync } from 'node:fs';
    import { parseArgs } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'lib', 'crystallize-args.mjs')).href)};
    import { applySessionClose } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'lib', 'crystallize-close-apply.mjs')).href)};
    applySessionClose(parseArgs(${JSON.stringify(argv)}), ${hooksSource});
  `;
  try {
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
  } finally {
    rmSync(payloadPath, { force: true });
  }
}

const CRASH_AFTER_PUBLISH = `{ afterPublish() { throw new Error('crash after publish'); } }`;
const CRASH_AFTER_PIN = `{ afterPinBeforeReplace() { throw new Error('crash after pin'); } }`;

suite('close entries: tracks, supersedes and heads');

test('two sessions close one project on different tracks one after the other: both ok, no proposal, no parked file', () => {
  withWiki(null, (dir, today) => {
    const a = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'track-a', new: true, next: '- a' }], tag: 'close a' }),
      newPinSession('seq-a'),
    );
    const b = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'track-b', new: true, next: '- b' }], tag: 'close b' }),
      newPinSession('seq-b'),
    );
    for (const { out } of [a, b]) {
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.deepEqual(out.proposals, []);
      assert.deepEqual(out.conflicts, []);
    }
    const parked = join(dir, '.cache', 'proposals');
    assert.deepEqual(existsSync(parked) ? readdirSync(parked) : [], [], 'nothing was parked');
    assert.equal(sessionFilesOf(dir).length, 2);
    const heads = headsOf(dir);
    assert.equal(heads['track-a'].length, 1);
    assert.equal(heads['track-b'].length, 1);
  });
});

await testAsync(
  'two processes closing the same project at the same moment both succeed with no proposal',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-wiki-'));
    try {
      const today = todayLocal();
      buildCleanWikiTree(dir, today);
      const env = { ...process.env, HOME: SESSION_TMP_HOME };
      spawnSync('git', ['init'], { cwd: dir, env });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, env });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, env });
      spawnSync('git', ['add', '-A'], { cwd: dir, env });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, env });

      const spawnClose = (label, trackId) => {
        const sessionId = newPinSession(label);
        const cleanup = seedCloseTranscript(sessionId);
        const payloadPath = join(tmpdir(), `hypo-payload-${sessionId}.json`);
        writeFileSync(
          payloadPath,
          JSON.stringify(
            v2Payload(today, {
              tracks: [{ id: trackId, new: true, next: `- ${trackId}` }],
              tag: `close ${trackId}`,
            }),
          ),
        );
        const child = spawn(
          process.execPath,
          [
            join(REPO, 'scripts', 'crystallize.mjs'),
            `--hypo-dir=${dir}`,
            '--apply-session-close',
            `--payload=${payloadPath}`,
            `--session-id=${sessionId}`,
            '--json',
          ],
          { env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        return new Promise((resolve) =>
          child.on('exit', (code) => {
            cleanup();
            rmSync(payloadPath, { force: true });
            resolve({ code, stdout, stderr });
          }),
        );
      };
      const [one, two] = await Promise.all([
        spawnClose('par-a', 'par-a'),
        spawnClose('par-b', 'par-b'),
      ]);
      for (const res of [one, two]) {
        const out = JSON.parse(res.stdout);
        assert.equal(out.ok, true, `${res.stdout}\n${res.stderr}`);
        assert.deepEqual(out.proposals, []);
        assert.deepEqual(out.conflicts, []);
      }
      assert.equal(sessionFilesOf(dir).length, 2);
      const parked = join(dir, '.cache', 'proposals');
      assert.deepEqual(existsSync(parked) ? readdirSync(parked) : [], []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('the 2026-10-01 shape: session 229 on track a, another project closes in between, session 230 on track b: no approval asked', () => {
  withWiki(
    (dir, today) => {
      const other = join(dir, 'projects', 'other-proj');
      mkdirSync(join(other, 'session-log'), { recursive: true });
      writeFileSync(
        join(other, 'session-state.md'),
        `---\ntitle: ss\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- n\n`,
      );
      writeFileSync(
        join(other, 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`,
      );
    },
    (dir, today) => {
      const s229 = applyJson(
        dir,
        v2Payload(today, { tracks: [{ id: 'a', new: true, next: '- a' }], tag: 'session 229' }),
        newPinSession('s229'),
      );
      const between = applyJson(
        dir,
        v2Payload(today, {
          project: 'other-proj',
          tracks: [{ id: 'x', new: true, next: '- x' }],
          tag: 'other project close',
        }),
        newPinSession('s-other'),
      );
      const s230 = applyJson(
        dir,
        v2Payload(today, { tracks: [{ id: 'b', new: true, next: '- b' }], tag: 'session 230' }),
        newPinSession('s230'),
      );
      for (const { out } of [s229, between, s230]) {
        assert.equal(out.ok, true, JSON.stringify(out));
        assert.deepEqual(out.proposals, [], 'no approval is asked for');
        assert.deepEqual(out.conflicts, []);
      }
    },
  );
});

test('an unregistered track id is refused before anything is written, and "new": true starts it', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('track-unknown');
    const bad = applyJson(dir, v2Payload(today, { tracks: [{ id: 'nope', next: '- x' }] }), sid);
    assert.equal(bad.out.ok, false);
    assert.equal(bad.out.stage, 'track-unknown', JSON.stringify(bad.out));
    assert.match(bad.out.error, /legacy/, 'the message lists the registered ids');
    assert.deepEqual(sessionFilesOf(dir), []);
    assert.deepEqual(readJournal(dir, sid), {}, 'no journal record either');

    const good = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'nope', new: true, next: '- x' }] }),
      sid,
    );
    assert.equal(good.out.ok, true, JSON.stringify(good.out));
  });
});

test('"new": true on a registered track is refused (track-exists), a plain update of it is accepted', () => {
  withWiki(null, (dir, today) => {
    const first = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'main', new: true, next: '- one' }], tag: 'first' }),
      newPinSession('exists-1'),
    );
    assert.equal(first.out.ok, true, JSON.stringify(first.out));
    const again = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'main', new: true, next: '- two' }], tag: 'second' }),
      newPinSession('exists-2'),
    );
    assert.equal(again.out.stage, 'track-exists', JSON.stringify(again.out));
    assert.equal(sessionFilesOf(dir).length, 1);
    const plain = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'main', next: '- two' }], tag: 'third' }),
      newPinSession('exists-3'),
    );
    assert.equal(plain.out.ok, true, JSON.stringify(plain.out));
  });
});

test('the same track id twice in one payload is refused (track-duplicate) with no file and no journal record; two different ids pass', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('dup');
    const dup = applyJson(
      dir,
      v2Payload(today, {
        tracks: [
          { id: 'a', new: true, next: '- one' },
          { id: 'a', done: true },
        ],
      }),
      sid,
    );
    assert.equal(dup.out.stage, 'track-duplicate', JSON.stringify(dup.out));
    assert.deepEqual(sessionFilesOf(dir), []);
    assert.deepEqual(readJournal(dir, sid), {});

    const ok = applyJson(
      dir,
      v2Payload(today, {
        tracks: [
          { id: 'a', new: true, next: '- one' },
          { id: 'b', new: true, next: '- two' },
        ],
      }),
      sid,
    );
    assert.equal(ok.out.ok, true, JSON.stringify(ok.out));
  });
});

test('an entry marker line of this close inside the summary is refused (payload-reserved-marker), a look-alike of another close passes', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('marker');
    const closeId = closeIdFor(sid, 0);
    const bad = applyJson(
      dir,
      v2Payload(today, { summary: `before\n<!-- hypomnema:summary ${closeId} -->\nafter` }),
      sid,
    );
    assert.equal(bad.out.stage, 'payload-reserved-marker', JSON.stringify(bad.out));
    assert.deepEqual(sessionFilesOf(dir), []);
    const fine = applyJson(
      dir,
      v2Payload(today, { summary: 'talks about <!-- hypomnema:summary other-close --> in prose' }),
      sid,
    );
    assert.equal(fine.out.ok, true, JSON.stringify(fine.out));
  });
});

test('supersedes: a unique prefix resolves and the file carries the full id, an ambiguous or unknown one is refused', () => {
  withWiki(null, (dir, today) => {
    const idA = 'aaaa1111-1';
    const idB = 'aaaa2222-1';
    writeEntryFile(dir, { closeId: idA, date: today, tracks: [{ id: 'main', new: true }] });
    writeEntryFile(dir, { closeId: idB, date: today, tracks: [{ id: 'main' }] });
    const sid = newPinSession('prefix');
    const ambiguous = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'main', supersedes: ['aaaa'], next: '- x' }] }),
      sid,
    );
    assert.equal(ambiguous.out.stage, 'supersedes-unknown', JSON.stringify(ambiguous.out));
    const unknown = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'main', supersedes: ['zzzz'], next: '- x' }] }),
      sid,
    );
    assert.equal(unknown.out.stage, 'supersedes-unknown');
    const ok = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'main', supersedes: ['aaaa1'], next: '- x' }] }),
      sid,
    );
    assert.equal(ok.out.ok, true, JSON.stringify(ok.out));
    const mine = sessionFilesOf(dir).find((f) => f.includes(sid));
    assert.deepEqual(entryAt(dir, mine).tracks[0].supersedes, [idA], 'the full id is written');
  });
});

test('an unambiguous baseline prefix is resolved and written as the full id', () => {
  withWiki(null, (dir, today) => {
    const baseline = loadSessionModel(dir, 'test-project').entries.find((e) =>
      e.closeId.startsWith('baseline-'),
    );
    assert.ok(baseline, 'the fixture tracks the old state files, so a virtual baseline exists');
    const sid = newPinSession('baseline-prefix');
    const { out } = applyJson(
      dir,
      v2Payload(today, {
        tracks: [
          {
            id: 'legacy',
            supersedes: [baseline.closeId.slice(0, 'baseline-'.length + 2)],
            done: true,
          },
        ],
      }),
      sid,
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    const mine = sessionFilesOf(dir).find((f) => f.includes(sid));
    assert.ok(entryAt(dir, mine).tracks[0].supersedes.includes(baseline.closeId));
    assert.deepEqual(headsOf(dir).legacy, [closeIdFor(sid, 0)]);
  });
});

test('the same session closing a track twice leaves one head: the second entry replaces the first without an observed record written by hand (N1)', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('n1');
    const cleanup = seedCloseTranscript(sid);
    try {
      const first = applyJson(
        dir,
        v2Payload(today, { tracks: [{ id: 'a', new: true, next: '- one' }], tag: 'n1 first' }),
        sid,
      );
      assert.equal(first.out.ok, true, JSON.stringify(first.out));
      typeCloseAgain(sid);
      const second = applyJson(
        dir,
        v2Payload(today, { tracks: [{ id: 'a', next: '- two' }], tag: 'n1 second' }),
        sid,
      );
      assert.equal(second.out.ok, true, JSON.stringify(second.out));
      const heads = headsOf(dir);
      assert.equal(heads.a.length, 1, JSON.stringify(heads));
      assert.notEqual(heads.a[0], closeIdFor(sid, 0), 'the head is the second entry');
      assert.equal(readObservedHeads(dir, sid, 'test-project').full.a.length, 2);
    } finally {
      cleanup();
    }
  });
});

test('a head this session saw only as a pointer is replaced by its close; a head another session wrote after is not (N1)', () => {
  withWiki(null, (dir, today) => {
    writeEntryFile(dir, { closeId: 'seen-1', date: today, tracks: [{ id: 'a', new: true }] });
    const sid = newPinSession('pointer');
    recordObservedHeads(dir, sid, 'test-project', { level: 'pointer', heads: { a: ['seen-1'] } });
    writeEntryFile(dir, { closeId: 'later-1', date: today, tracks: [{ id: 'a' }] });
    const { out } = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 'a', next: '- mine' }], tag: 'pointer close' }),
      sid,
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    const heads = headsOf(dir).a;
    assert.ok(!heads.includes('seen-1'), `the pointer-only head is replaced: ${heads}`);
    assert.ok(heads.includes('later-1'), `the head written after the observation stays: ${heads}`);
    assert.ok(heads.includes(closeIdFor(sid, 0)));
  });
});

test('"done" closes only the heads the session knew: a concurrent head stays active and out of Finished tracks (Q5)', () => {
  const render = (dir) =>
    renderViews([loadSessionModel(dir, 'test-project')], { device: 'dev-test' }).projects[
      'test-project'
    ].sessionState;
  withWiki(null, (dir, today) => {
    writeEntryFile(dir, {
      closeId: 'h1-1',
      date: today,
      tracks: [{ id: 't', new: true, title: 'T' }],
      bodies: { t: 'body h1' },
    });
    const sid = newPinSession('q5');
    recordObservedHeads(dir, sid, 'test-project', { level: 'pointer', heads: { t: ['h1-1'] } });
    writeEntryFile(dir, {
      closeId: 'h2-1',
      date: today,
      tracks: [{ id: 't' }],
      bodies: { t: 'body h2 concurrent' },
    });
    const { out } = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 't', done: true }], tag: 'q5 done' }),
      sid,
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(!headsOf(dir).t.includes('h1-1'), 'h1 is replaced');
    assert.ok(headsOf(dir).t.includes('h2-1'), 'h2 is still a head');
    const view = render(dir);
    const nextUp = view.slice(
      view.indexOf('## Next Up'),
      view.indexOf('## Finished tracks') === -1 ? undefined : view.indexOf('## Finished tracks'),
    );
    assert.ok(nextUp.includes('body h2 concurrent'), `h2 is in Next Up: ${view}`);
    assert.ok(!view.includes('## Finished tracks'), `t is not folded: ${view}`);
    assert.ok(
      !(out.notices ?? []).some((n) => /h2/.test(n)),
      `no notice about h2: ${JSON.stringify(out.notices)}`,
    );
  });
  // The pair: with no concurrent head the same close folds the track.
  withWiki(null, (dir, today) => {
    writeEntryFile(dir, {
      closeId: 'h1-1',
      date: today,
      tracks: [{ id: 't', new: true, title: 'T' }],
      bodies: { t: 'body h1' },
    });
    const sid = newPinSession('q5-pair');
    recordObservedHeads(dir, sid, 'test-project', { level: 'pointer', heads: { t: ['h1-1'] } });
    const { out } = applyJson(
      dir,
      v2Payload(today, { tracks: [{ id: 't', done: true }], tag: 'q5 done pair' }),
      sid,
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    const view = render(dir);
    assert.ok(view.includes('## Finished tracks'), `t is folded: ${view}`);
  });
});

test('a large legacy baseline seen only as a pointer is folded by "done" (Q5)', () => {
  withWiki(
    (dir, today) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n${'long body line\n'.repeat(400)}`,
      );
    },
    (dir, today) => {
      const model = loadSessionModel(dir, 'test-project');
      const baseline = model.entries.find((e) => e.closeId.startsWith('baseline-'));
      assert.ok(baseline.bodies.legacy.length > 5000);
      const sid = newPinSession('big-legacy');
      recordObservedHeads(dir, sid, 'test-project', {
        level: 'pointer',
        heads: { legacy: [baseline.closeId] },
      });
      const { out } = applyJson(
        dir,
        v2Payload(today, { tracks: [{ id: 'legacy', done: true }], tag: 'big legacy' }),
        sid,
      );
      assert.equal(out.ok, true, JSON.stringify(out));
      const view = renderViews([loadSessionModel(dir, 'test-project')], { device: 'dev-test' })
        .projects['test-project'].sessionState;
      assert.ok(view.includes('## Finished tracks'), view);
      assert.deepEqual(headsOf(dir).legacy, [closeIdFor(sid, 0)]);
    },
  );
});

test('a close in a vault that has not moved to entries writes only the entry and leaves the two old files byte-identical', () => {
  withWiki(null, (dir, today) => {
    const stateBefore = readFileSync(
      join(dir, 'projects', 'test-project', 'session-state.md'),
      'utf-8',
    );
    const hotBefore = readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8');
    const { out } = applyJson(dir, v2Payload(today), newPinSession('pre-migration'));
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(sessionFilesOf(dir).length, 1);
    assert.equal(
      readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      stateBefore,
    );
    assert.equal(readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8'), hotBefore);
  });
});

test('a close in a migrated vault regenerates the project views from the new entry', () => {
  withWiki(null, (dir, today) => {
    const moved = migrateVaultToSessionEntries(dir);
    assert.equal(moved.migrated, true, JSON.stringify(moved));
    const { out } = applyJson(
      dir,
      v2Payload(today, {
        summary: 'regen-summary-marker',
        tracks: [{ id: 'main', new: true, next: '- regen-next-marker' }],
      }),
      newPinSession('regen'),
    );
    assert.equal(out.ok, true, JSON.stringify(out));
    const hot = readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8');
    const state = readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8');
    assert.ok(hot.includes('regen-summary-marker'), hot);
    assert.ok(state.includes('regen-next-marker'), state);
  });
});

test('the new entry takes the narrowest scope: a shared index and a machine baseline give machine:devA (W1)', () => {
  withWiki(
    (dir, today) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'index.md'),
        `---\ntitle: test-project\ntype: project-index\nupdated: ${today}\nvisibility_scope: shared\n---\n# test-project\n`,
      );
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\nvisibility_scope: machine:devA\n---\n\n## 다음 작업\n\n- next\n`,
      );
    },
    (dir, today) => {
      const sid = newPinSession('scope');
      const { out } = applyJson(dir, v2Payload(today), sid);
      assert.equal(out.ok, true, JSON.stringify(out));
      const mine = sessionFilesOf(dir).find((f) => f.includes(sid));
      assert.equal(entryAt(dir, mine).visibilityScope, 'machine:devA');
    },
  );
});

test('legacy payload: the old two fields become the summary and a legacy track body, one notice says so, and a mix of both forms is refused', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const sid = newPinSession('legacy-form');
    const { out } = applyJson(dir, payload, sid);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(
      out.notices.some((n) => /구버전 형식 payload/.test(n)),
      JSON.stringify(out.notices),
    );
    const entry = entryAt(
      dir,
      sessionFilesOf(dir).find((f) => f.includes(sid)),
    );
    assert.ok(
      entry.summary.includes('# Hot'),
      'projectHot became the summary, frontmatter stripped',
    );
    assert.ok(!entry.summary.startsWith('---'));
    assert.ok(
      entry.bodies.legacy.includes('## 다음 작업'),
      'sessionState became the legacy track body',
    );

    const mixed = { ...payloadForCleanWiki(dir, today), summary: 'x', tracks: [] };
    const bad = applyJson(dir, mixed, newPinSession('legacy-mixed'));
    assert.equal(bad.out.ok, false);
    assert.match(JSON.stringify(bad.out.details), /both the old fields/);
    assert.equal(sessionFilesOf(dir).length, 1, 'the refused payload wrote nothing');
  });
});

// The Step 2 json block of commands/crystallize.md is what a model copies. It has to survive a
// real apply, not only the shape check: a duplicate track id or an unregistered track passes the
// shape check and is refused later, which is how the first version of the example got through.
// Disabling the check: put a `done` element for the same <track-id> back into that block (the
// real apply refuses it as track-duplicate), or add an `openQuestions` key to the block.
test('commands/crystallize.md Step 2 payload example applies for real against a registered track', () => {
  const md = readFileSync(join(REPO, 'commands', 'crystallize.md'), 'utf-8');
  const step2 = md.slice(md.indexOf('## Step 2'), md.indexOf('## Step 3'));
  const blocks = [...step2.matchAll(/```json\n([\s\S]*?)```/g)];
  assert.equal(blocks.length, 1, 'Step 2 must hold exactly one json example');
  const template = JSON.parse(blocks[0][1]);
  assert.ok(!('openQuestions' in template), 'the example must not carry openQuestions by default');

  const strings = (v) =>
    typeof v === 'string'
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(strings)
        : v && typeof v === 'object'
          ? Object.values(v).flatMap(strings)
          : [];

  withWiki(null, (dir, today) => {
    // Register track `main` the way a real earlier close does.
    const seed = applyJson(dir, v2Payload(today, { tag: 'seed close' }), newPinSession('doc-seed'));
    assert.equal(seed.out.ok, true, JSON.stringify(seed.out));
    const filesBefore = sessionFilesOf(dir).length;

    const sessionId = newPinSession('doc-example');
    const values = {
      '<slug>': 'test-project',
      '<current session id>': sessionId,
      '<what this session did and decided, markdown>': 'summary written from the doc example',
      '<track-id>': 'main',
      '<display title>': 'Main track',
      '<next steps and state, markdown>': '- next step written from the doc example',
      '<entry to append to projects/<slug>/session-log/YYYY-MM-DD.md>': `## [${today}] crystallize.md example\n`,
    };
    const fill = (v) =>
      typeof v === 'string'
        ? Object.hasOwn(values, v)
          ? values[v]
          : v
        : Array.isArray(v)
          ? v.map(fill)
          : v && typeof v === 'object'
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
            : v;
    const payload = fill(template);
    assert.deepEqual(
      strings(payload).filter((s) => s.startsWith('<')),
      [],
      'every placeholder in the example must have a value in this test',
    );

    const { out } = applyJson(dir, payload, sessionId);
    assert.equal(out.ok, true, `the doc example must apply: ${JSON.stringify(out)}`);
    assert.equal(out.committed, true, 'the doc example must commit its entry');
    assert.equal(sessionFilesOf(dir).length, filesBefore + 1, 'exactly one entry was created');
  });
});

// An old-format payload with bodies that make byte loss visible: Korean text, trailing
// spaces, an inner blank line, and frontmatter fields that must not reach the entry.
const LEGACY_HOT_BODY = '# 옛 hot\n\n- legacy-hot-line  \n\n- 두 번째 줄 legacy-hot-end';
const LEGACY_STATE_BODY = '## 다음 작업\n\n- legacy-state-line  \n\n- 두 번째 legacy-state-end';

// `legacy` is registered only through the baseline that HEAD's tracked old files make. Untrack
// both (they stay on disk, which the post-apply verification needs) and no baseline exists.
function untrackOldStateFiles(dir) {
  const env = { ...process.env, HOME: SESSION_TMP_HOME };
  const files = ['hot.md', 'session-state.md'].map((f) => join('projects', 'test-project', f));
  spawnSync('git', ['rm', '--cached', ...files], { cwd: dir, env });
  spawnSync('git', ['commit', '-m', 'untrack old files'], { cwd: dir, env });
  appendFileSync(join(dir, '.git', 'info', 'exclude'), `${files.join('\n')}\n`);
}

function legacyFormatPayload(today, tag) {
  return {
    project: 'test-project',
    date: today,
    sessionState: {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${LEGACY_STATE_BODY}\n`,
    },
    projectHot: {
      content: `---\ntitle: hot\ntype: hot\nupdated: ${today}\nlegacy-fm-marker: x\n---\n\n${LEGACY_HOT_BODY}\n`,
    },
    sessionLog: { entry: `## [${today}] ${tag}\n` },
  };
}

test('legacy payload: both old field bodies sit in the original entry byte for byte, frontmatter stripped, and exactly one notice says it was absorbed', () => {
  withWiki(null, (dir, today) => {
    untrackOldStateFiles(dir);
    const sid = newPinSession('legacy-bytes');
    const { out } = applyJson(dir, legacyFormatPayload(today, 'legacy bytes'), sid);
    assert.equal(out.ok, true, JSON.stringify(out));
    const file = sessionFilesOf(dir).find((f) => f.includes(sid));
    const text = readFileSync(join(sessionsDirOf(dir), file), 'utf-8');
    assert.ok(text.includes(LEGACY_HOT_BODY), 'the projectHot body is in the file as sent');
    assert.ok(text.includes(LEGACY_STATE_BODY), 'the sessionState body is in the file as sent');
    assert.ok(!text.includes('legacy-fm-marker'), 'the old frontmatter did not come along');
    const entry = entryAt(dir, file);
    assert.ok(entry.summary.includes(LEGACY_HOT_BODY), entry.summary);
    assert.ok(entry.bodies.legacy.includes(LEGACY_STATE_BODY), entry.bodies.legacy);
    assert.equal(entry.tracks.length, 1);
    assert.equal(entry.tracks[0].id, 'legacy');
    assert.equal(entry.tracks[0].new, true, 'legacy is registered by this close');
    const absorbed = (out.notices ?? []).filter((n) => /구버전 형식 payload/.test(n));
    assert.equal(absorbed.length, 1, JSON.stringify(out.notices));
  });
});

test('legacy payload: the same session closing in the old format twice leaves one legacy head, and the first entry is not it', () => {
  withWiki(null, (dir, today) => {
    untrackOldStateFiles(dir);
    const sid = newPinSession('legacy-twice');
    const cleanup = seedCloseTranscript(sid);
    try {
      const first = applyJson(dir, legacyFormatPayload(today, 'legacy twice first'), sid);
      assert.equal(first.out.ok, true, JSON.stringify(first.out));
      typeCloseAgain(sid);
      const second = applyJson(dir, legacyFormatPayload(today, 'legacy twice second'), sid);
      assert.equal(second.out.ok, true, JSON.stringify(second.out));
      assert.equal(sessionFilesOf(dir).length, 2, 'both closes wrote an entry');
      const heads = headsOf(dir);
      assert.equal(heads.legacy.length, 1, JSON.stringify(heads));
      assert.notEqual(heads.legacy[0], closeIdFor(sid, 0), 'the first entry is no longer a head');
      const secondEntry = entryAt(
        dir,
        sessionFilesOf(dir).find((f) => f.includes(heads.legacy[0])),
      );
      assert.deepEqual(secondEntry.tracks[0].supersedes, [closeIdFor(sid, 0)]);
      assert.ok(!secondEntry.tracks[0].new, 'legacy was already registered');
      assert.equal(readObservedHeads(dir, sid, 'test-project').full.legacy.length, 2);
    } finally {
      cleanup();
    }
  });
});

test('legacy payload: a payload mixing either old field with summary or tracks fails and writes nothing', () => {
  const mixes = [
    { summary: 'x' },
    { tracks: [{ id: 'main', new: true }] },
    { summary: 'x', tracks: [{ id: 'main', new: true }] },
  ];
  withWiki(null, (dir, today) => {
    const head = gitHead(dir);
    for (const [i, extra] of mixes.entries()) {
      for (const drop of ['projectHot', 'sessionState']) {
        const payload = { ...legacyFormatPayload(today, `legacy mixed ${i}`), ...extra };
        delete payload[drop];
        const { out } = applyJson(dir, payload, newPinSession(`legacy-mixed-${i}`));
        assert.equal(out.ok, false, JSON.stringify(out));
        assert.match(JSON.stringify(out.details), /both the old fields/);
      }
    }
    assert.equal(sessionFilesOf(dir).length, 0, 'no entry was written');
    assert.equal(gitHead(dir), head, 'no commit was made');
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' });
    assert.equal(status.stdout, '', 'the vault is untouched');
  });
});

suite('close entries: publishing and retrying one close');

// Occupy the receipt directory with a file: the commit lands, the receipt cannot.
function blockReceipt(dir, sessionId) {
  const blocker = join(dir, '.cache', 'sessions', sessionId);
  mkdirSync(dirname(blocker), { recursive: true });
  writeFileSync(blocker, 'occupied by a file, not a directory\n');
  return () => rmSync(blocker, { force: true });
}

test('a close that committed and failed at the receipt keeps its entry when retried with a fixed summary, says so, and issues the receipt (N2)', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('n2');
    const unblock = blockReceipt(dir, sid);
    const first = applyJson(dir, v2Payload(today, { summary: 'first summary' }), sid);
    assert.equal(first.out.stage, 'receipt-write-failed', JSON.stringify(first.out));
    assert.equal(first.out.committed, true);
    const file = sessionFilesOf(dir)[0];
    const bytes = readFileSync(join(sessionsDirOf(dir), file), 'utf-8');
    const head = gitHead(dir);

    unblock();
    const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
    assert.equal(retry.out.ok, true, JSON.stringify(retry.out));
    assert.equal(readFileSync(join(sessionsDirOf(dir), file), 'utf-8'), bytes, 'bytes unchanged');
    assert.ok(
      retry.out.notices.some((n) => /이번 payload의 요약은 반영되지 않았습니다/.test(n)),
      JSON.stringify(retry.out.notices),
    );
    assert.ok(existsSync(receiptPath(dir, sid)), 'the receipt was issued');
    assert.equal(gitHead(dir), head, 'no new commit');
  });
});

test('a committed entry edited by hand is not adopted or replaced: the retry fails with entry-conflict and leaves the bytes alone', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('hand-edit');
    const unblock = blockReceipt(dir, sid);
    applyJson(dir, v2Payload(today), sid);
    const file = join(sessionsDirOf(dir), sessionFilesOf(dir)[0]);
    const edited = `${readFileSync(file, 'utf-8')}\nhand edit\n`;
    writeFileSync(file, edited);
    unblock();
    const retry = applyJson(dir, v2Payload(today), sid);
    assert.equal(retry.out.stage, 'entry-conflict', JSON.stringify(retry.out));
    assert.equal(readFileSync(file, 'utf-8'), edited);
  });
});

test('bytes another writer puts at the entry path just before the publish are never replaced (entry-conflict)', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('race');
    const cleanup = seedCloseTranscript(sid);
    try {
      const r = applyWithHooks(
        dir,
        v2Payload(today),
        sid,
        `{ beforePublish({ abs }) { writeFileSync(abs, 'foreign bytes\\n'); } }`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.stage, 'entry-conflict', `${r.stdout}\n${r.stderr}`);
      const files = sessionFilesOf(dir);
      assert.equal(files.length, 1);
      assert.equal(readFileSync(join(sessionsDirOf(dir), files[0]), 'utf-8'), 'foreign bytes\n');
    } finally {
      cleanup();
    }
  });
});

test('a commit failure then a retry with a fixed summary replaces the uncommitted entry and succeeds; touched-paths and the journal name the entry', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('commit-fail');
    const unblock = blockCommits(dir);
    const first = applyJson(dir, v2Payload(today, { summary: 'first summary' }), sid);
    assert.equal(first.out.committed, false, JSON.stringify(first.out));
    const rel = join('projects', 'test-project', 'sessions', sessionFilesOf(dir)[0]);
    const shard = join('projects', 'test-project', 'session-log', `${today}.md`);
    const touched = readTouchedPathsStrict(dir, sid);
    assert.ok(touched.paths.includes(rel), `touched-paths names the entry: ${touched.paths}`);
    assert.ok(touched.paths.includes(shard), `and the shard: ${touched.paths}`);
    assert.ok(readJournal(dir, sid)[rel], 'the close journal has the entry path as a key');

    unblock();
    const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
    assert.equal(retry.out.ok, true, JSON.stringify(retry.out));
    assert.equal(retry.out.committed, true);
    assert.equal(entryAt(dir, sessionFilesOf(dir)[0]).summary, 'fixed summary');
    const blob = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: dir, encoding: 'utf-8' }).stdout;
    assert.ok(blob.includes('fixed summary'), 'the committed bytes are the fixed ones');
  });
});

test('an uncommitted entry another process changed, matching neither the journal nor the pinned hashes, is a conflict', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('uncommitted-foreign');
    const unblock = blockCommits(dir);
    applyJson(dir, v2Payload(today), sid);
    const file = join(sessionsDirOf(dir), sessionFilesOf(dir)[0]);
    writeFileSync(file, 'someone else rewrote this\n');
    unblock();
    const retry = applyJson(dir, v2Payload(today, { summary: 'fixed' }), sid);
    assert.equal(retry.out.stage, 'entry-conflict', JSON.stringify(retry.out));
    assert.equal(readFileSync(file, 'utf-8'), 'someone else rewrote this\n');
  });
});

test('a crash right after the publish (before the journal) is repaired by a retry with a fixed summary: one commit, new bytes, with or without a journal (P1)', () => {
  for (const dropJournal of [false, true]) {
    withWiki(null, (dir, today) => {
      const sid = newPinSession(`p1-${dropJournal}`);
      const cleanup = seedCloseTranscript(sid);
      try {
        const crash = applyWithHooks(
          dir,
          v2Payload(today, { summary: 'first summary' }),
          sid,
          CRASH_AFTER_PUBLISH,
        );
        assert.notEqual(crash.status, 0, 'the seam crashes the child');
        assert.match(crash.stderr, /crash after publish/);
        const file = sessionFilesOf(dir)[0];
        const rel = join('projects', 'test-project', 'sessions', file);
        assert.equal(readJournal(dir, sid)[rel], undefined, 'the journal never heard of the entry');
        assert.equal(readClosePin(dir, sid).pending.entrySha256s.length, 1, 'the pin did');
        if (dropJournal)
          rmSync(join(dir, '.cache', 'close-journal', `${sid}.json`), { force: true });

        const before = commitCountOf(dir);
        const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
        assert.equal(retry.out.ok, true, JSON.stringify(retry.out));
        assert.equal(entryAt(dir, file).summary, 'fixed summary');
        assert.equal(commitCountOf(dir), before + 1, 'one commit');
      } finally {
        cleanup();
      }
    });
  }
});

test('a crash after the pin took the fixed bytes but before the replace leaves both hashes pinned: a third payload still replaces (P1)', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('p1-third');
    const cleanup = seedCloseTranscript(sid);
    try {
      applyWithHooks(dir, v2Payload(today, { summary: 'first summary' }), sid, CRASH_AFTER_PUBLISH);
      const file = sessionFilesOf(dir)[0];
      const second = applyWithHooks(
        dir,
        v2Payload(today, { summary: 'second summary' }),
        sid,
        CRASH_AFTER_PIN,
      );
      assert.match(second.stderr, /crash after pin/);
      assert.equal(entryAt(dir, file).summary, 'first summary', 'the replace never happened');
      assert.equal(readClosePin(dir, sid).pending.entrySha256s.length, 2);

      const third = applyJson(dir, v2Payload(today, { summary: 'third summary' }), sid);
      assert.equal(third.out.ok, true, JSON.stringify(third.out));
      assert.equal(entryAt(dir, file).summary, 'third summary');
    } finally {
      cleanup();
    }
  });
});

test('the pinned hashes license a replace only for the pinned path: a pin that names another path leaves the same disk bytes alone (P1)', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('p1-path');
    const cleanup = seedCloseTranscript(sid);
    try {
      applyWithHooks(dir, v2Payload(today, { summary: 'first summary' }), sid, CRASH_AFTER_PUBLISH);
      const file = join(sessionsDirOf(dir), sessionFilesOf(dir)[0]);
      const bytes = readFileSync(file, 'utf-8');
      const pin = readClosePin(dir, sid);
      writeClosePin(dir, sid, {
        ...pin,
        pending: { ...pin.pending, entryRelPath: 'projects/test-project/sessions/elsewhere.md' },
      });
      const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
      assert.equal(retry.out.stage, 'entry-conflict', JSON.stringify(retry.out));
      assert.equal(readFileSync(file, 'utf-8'), bytes);
    } finally {
      cleanup();
    }
  });
});

test('classifyExistingEntry: the same disk bytes are replaceable for the pinned close and path, and not for another close id or path (P1)', () => {
  withWiki(null, (dir) => {
    const text = 'new bytes\n';
    const disk = 'old bytes\n';
    const relPath = 'projects/test-project/sessions/2026-10-01-s-1.md';
    const pinFor = (closeId, entryRelPath) => ({
      pending: {
        closeId,
        openedAtIndex: 1,
        entryRelPath,
        entrySha256s: [createHash('sha256').update(disk).digest('hex')],
      },
      lastResolved: null,
      localProofs: {},
    });
    const base = { hypoDir: dir, sessionId: 'no-journal', relPath, text, disk, ignored: false };
    assert.equal(
      classifyExistingEntry({ ...base, closeId: 's-1', pin: pinFor('s-1', relPath) }).action,
      'replace',
    );
    assert.equal(
      classifyExistingEntry({ ...base, closeId: 's-2', pin: pinFor('s-1', relPath) }).action,
      'conflict',
    );
    assert.equal(
      classifyExistingEntry({
        ...base,
        closeId: 's-1',
        pin: pinFor('s-1', 'projects/test-project/sessions/other.md'),
      }).action,
      'conflict',
    );
  });
});

test('an unwritable close-pin directory stops the close at stage close-pin before anything is published', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores directory modes
  withWiki(null, (dir, today) => {
    const sid = newPinSession('pin-dir');
    const cleanup = seedCloseTranscript(sid);
    try {
      unresolvedApply(dir, today, sid); // takes the pin: later writes are the publish intent only
      const pinDir = dirname(closePinPath(dir, sid));
      chmodSync(pinDir, 0o500);
      try {
        const { out } = applyJson(dir, v2Payload(today), sid);
        assert.equal(out.stage, 'close-pin', JSON.stringify(out));
        assert.deepEqual(sessionFilesOf(dir), [], 'nothing was published');
      } finally {
        chmodSync(pinDir, 0o700);
      }
    } finally {
      cleanup();
    }
  });
});

test('a retry that crosses midnight keeps the first date: the same close id found under another date is the entry', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('date-move');
    const unblock = blockCommits(dir);
    applyJson(dir, v2Payload(today, { summary: 'first' }), sid);
    const file = sessionFilesOf(dir)[0];
    unblock();
    const [y, m, d] = today.split('-').map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const retry = applyJson(
      dir,
      v2Payload(tomorrow, { summary: 'second', tag: 'second day' }),
      sid,
    );
    assert.equal(retry.out.ok, true, JSON.stringify(retry.out));
    // The payload date moves, the entry stays under the date it was first published with.
    assert.deepEqual(sessionFilesOf(dir), [file], JSON.stringify(retry.out));
    assert.equal(entryAt(dir, file).date, today);
  });
});

test('a retry that crosses midnight with no close pin left still finds the entry on disk by its close id', () => {
  withWiki(null, (dir, today) => {
    const sid = newPinSession('date-move-nopin');
    const unblock = blockCommits(dir);
    applyJson(dir, v2Payload(today, { summary: 'first' }), sid);
    const file = sessionFilesOf(dir)[0];
    unblock();
    // the pin also names the path; without it only the scan of sessions/ can find the entry
    rmSync(closePinPath(dir, sid), { force: true });
    const [y, m, d] = today.split('-').map(Number);
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const retry = applyJson(
      dir,
      v2Payload(tomorrow, { summary: 'second', tag: 'second day' }),
      sid,
    );
    assert.equal(retry.out.ok, true, JSON.stringify(retry.out));
    assert.deepEqual(sessionFilesOf(dir), [file], JSON.stringify(retry.out));
    assert.equal(entryAt(dir, file).date, today);
  });
});

test('twelve closes over forty days, three of them superseding an earlier entry and one marking the track done: every close commit only adds one entry and never deletes (never deletes)', () => {
  withWiki(null, (dir, today) => {
    const [y, m, d] = today.split('-').map(Number);
    const daysAgo = (n) => {
      const t = new Date(y, m - 1, d - n);
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    };
    const offsets = [40, 37, 34, 30, 27, 24, 20, 17, 13, 9, 4, 0];
    const sessionsRel = join('projects', 'test-project', 'sessions');
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    const supersedingAt = new Set([3, 7, 9]);
    const doneAt = 10;

    const written = [];
    offsets.forEach((offset, i) => {
      const date = daysAgo(offset);
      const track = { id: 'main', next: `- step ${i}` };
      if (i === 0) track.new = true;
      if (supersedingAt.has(i)) track.supersedes = [entryAt(dir, written[i - 1]).closeId];
      if (i === doneAt) track.done = true;
      const before = commitCountOf(dir);
      const { out } = applyJson(
        dir,
        v2Payload(date, { tracks: [track], tag: `close ${i}`, summary: `summary ${i}` }),
        newPinSession(`never-deletes-${i}`),
      );
      assert.equal(out.ok, true, `close ${i} (${date}): ${JSON.stringify(out)}`);
      assert.equal(out.committed, true, `close ${i} (${date}) must commit`);
      assert.equal(commitCountOf(dir), before + 1, `close ${i} made exactly one commit`);

      const files = sessionFilesOf(dir);
      const fresh = files.filter((f) => !written.includes(f));
      assert.equal(fresh.length, 1, `close ${i} added exactly one entry file: ${files}`);
      assert.ok(fresh[0].startsWith(`${date}-`), `close ${i} entry is dated ${date}: ${fresh[0]}`);
      written.push(fresh[0]);

      const diff = git(
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        'HEAD',
        '--',
        sessionsRel,
      );
      assert.equal(diff.status, 0, diff.stderr);
      assert.deepEqual(
        diff.stdout.split('\n').filter(Boolean),
        [`A\t${join(sessionsRel, fresh[0])}`],
        `close ${i}'s commit changes sessions/ by one added entry and nothing else`,
      );

      // Every earlier entry is still on disk and in HEAD, however it was superseded.
      const inHead = git('ls-tree', '--name-only', 'HEAD', `${sessionsRel}/`)
        .stdout.split('\n')
        .filter(Boolean)
        .map((p) => p.slice(sessionsRel.length + 1))
        .sort();
      assert.deepEqual(inHead, files, `after close ${i} HEAD holds every entry written so far`);
      assert.deepEqual(files, [...written].sort());
    });

    assert.equal(written.length, 12);
    const dayNumber = (f) => Date.parse(`${f.slice(0, 10)}T00:00:00Z`) / 86400000;
    assert.equal(dayNumber(written[11]) - dayNumber(written[0]), 40, 'the closes span forty days');

    // The supersedes really point at the entry before them, and that entry stays a file.
    const closeIds = written.map((f) => entryAt(dir, f).closeId);
    for (const i of supersedingAt) {
      assert.deepEqual(entryAt(dir, written[i]).tracks[0].supersedes, [closeIds[i - 1]]);
      assert.ok(
        existsSync(join(sessionsDirOf(dir), written[i - 1])),
        `entry ${i - 1} stays on disk`,
      );
      assert.ok(!headsOf(dir).main.includes(closeIds[i - 1]), `entry ${i - 1} is no longer a head`);
    }
    assert.equal(entryAt(dir, written[doneAt]).tracks[0].done, true);
  });
});

suite('close entries: a project that .hypoignore keeps out of git');

test('an ignored project: the entry is never committed, the local proof outlives the commit step, and a fixed retry keeps the bytes (X2)', () => {
  withWiki(null, (dir, today) => {
    writeFileSync(join(dir, '.hypoignore'), 'projects/test-project/hot.md\n');
    const sid = newPinSession('ignored');
    // The receipt step fails throughout, so the close request stays open for the retries.
    blockReceipt(dir, sid);
    const first = applyJson(dir, v2Payload(today, { summary: 'first summary' }), sid);
    assert.equal(first.out.committed, true, JSON.stringify(first.out));
    assert.equal(first.out.stage, 'receipt-write-failed', JSON.stringify(first.out));
    assert.deepEqual(readJournal(dir, sid), {}, 'the commit step cleared the journal');
    const file = join(sessionsDirOf(dir), sessionFilesOf(dir)[0]);
    const bytes = readFileSync(file, 'utf-8');
    const rel = join('projects', 'test-project', 'sessions', sessionFilesOf(dir)[0]);
    const closeId = closeIdFor(sid, 0);
    const proof = readClosePin(dir, sid).localProofs[closeId];
    assert.equal(proof.entryRelPath, rel);
    assert.equal(proof.entrySha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(
      spawnSync('git', ['ls-files', '--', rel], { cwd: dir, encoding: 'utf-8' }).stdout.trim(),
      '',
      'the entry is not in git',
    );

    const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
    assert.equal(retry.out.stage, 'receipt-write-failed', JSON.stringify(retry.out));
    assert.equal(readFileSync(file, 'utf-8'), bytes, 'bytes unchanged');
    assert.ok(
      retry.out.notices.some((n) => /이번 payload의 요약은 반영되지 않았습니다/.test(n)),
      JSON.stringify(retry.out),
    );

    writeFileSync(file, `${bytes}\nhand edit\n`);
    const conflict = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
    assert.equal(conflict.out.stage, 'entry-conflict', JSON.stringify(conflict.out));
    assert.equal(readFileSync(file, 'utf-8'), `${bytes}\nhand edit\n`);
  });
});

// The two halves the gate and the receipt used to block: the ignored entry stays
// dirty for good (the checkpoint gate refused it as this session's own uncommitted
// write), and no commit holds it (the receipt had no kind to prove it with).
// Disabling the check: in precompactGateStatus drop the `provenLocal.has(pf) ||` term,
// or in close-receipt.mjs drop 'local-create' from RECEIPT_ENTRY_KINDS. Either way
// the retry ends compact-gate-not-ok or receipt-proof-mismatch, not ok.
test('an ignored project: a retry with a fixed summary after a failed receipt is ok:true and lands the marker (X2)', () => {
  withWiki(null, (dir, today) => {
    writeFileSync(join(dir, '.hypoignore'), 'projects/test-project/hot.md\n');
    const sid = newPinSession('ignored-fixed');
    const unblock = blockReceipt(dir, sid);
    const first = applyJson(dir, v2Payload(today, { summary: 'first summary' }), sid);
    assert.equal(first.out.stage, 'receipt-write-failed', JSON.stringify(first.out));
    assert.equal(first.out.committed, true);
    const file = join(sessionsDirOf(dir), sessionFilesOf(dir)[0]);
    const bytes = readFileSync(file, 'utf-8');

    unblock();
    const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
    assert.equal(retry.out.ok, true, JSON.stringify(retry.out));
    assert.equal(retry.out.committed, true);
    assert.equal(retry.out.markerWritten, true, JSON.stringify(retry.out));
    assert.equal(readFileSync(file, 'utf-8'), bytes, 'the proven bytes are kept');
    assert.ok(
      retry.out.notices.some((n) => /이번 payload의 요약은 반영되지 않았습니다/.test(n)),
      JSON.stringify(retry.out.notices),
    );
    assert.ok(existsSync(sessionClosedMarkerPath(dir, sid)), 'the marker landed');
  });
});

// Disabling the check: in close-receipt.mjs verifyEntriesInCommit, drop the hash
// comparison of the local-create branch (only the missing-file check stays): the
// disk-edit mismatch below disappears.
test('an ignored project: the receipt proves the entry as local-create with the hash of the bytes on disk (X2)', () => {
  withWiki(null, (dir, today) => {
    writeFileSync(join(dir, '.hypoignore'), 'projects/test-project/hot.md\n');
    const sid = newPinSession('ignored-receipt');
    const { out } = applyJson(dir, v2Payload(today, { summary: 'local summary' }), sid);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.markerWritten, true, JSON.stringify(out));
    const rel = join('projects', 'test-project', 'sessions', sessionFilesOf(dir)[0]);
    const receipt = JSON.parse(readFileSync(receiptPath(dir, sid), 'utf-8'));
    const entry = receipt.entries.find((e) => e.path === rel);
    assert.ok(entry, `the receipt names the entry: ${JSON.stringify(receipt.entries)}`);
    assert.equal(entry.kind, 'local-create');
    assert.equal(
      entry.expected.bytesSha256,
      createHash('sha256')
        .update(readFileSync(join(dir, rel)))
        .digest('hex'),
    );
    assert.equal(
      entry.expected.bytesSha256,
      readClosePin(dir, sid).localProofs[closeIdFor(sid, 0)].entrySha256,
      'the same hash the close pin records',
    );
    assert.equal(verifyEntriesInCommit(dir, receipt.commit, receipt.entries).ok, true);

    appendFileSync(join(dir, rel), 'edited after the close\n');
    assert.deepEqual(verifyEntriesInCommit(dir, receipt.commit, [entry]).mismatches, [
      { path: rel, reason: 'local-entry-mismatch' },
    ]);
  });
});

test('an ignored project whose close failed before the commit step can still correct its payload: the journal still names the bytes, so they are replaced', () => {
  withWiki(null, (dir, today) => {
    writeFileSync(join(dir, '.hypoignore'), 'projects/test-project/hot.md\n');
    const sid = newPinSession('ignored-precommit');
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const bad = applyJson(
      dir,
      v2Payload(today, {
        summary: 'first summary',
        openQuestions: { content: `---\ntype: concept\nupdated: ${today}\n---\n\n- no title\n` },
      }),
      sid,
    );
    assert.equal(bad.out.stage, 'post-apply-lint', JSON.stringify(bad.out));
    const file = sessionFilesOf(dir)[0];
    assert.ok(
      Object.keys(readJournal(dir, sid)).some((k) => k.endsWith(file)),
      'journal still has it',
    );
    const retry = applyJson(dir, v2Payload(today, { summary: 'fixed summary' }), sid);
    assert.equal(entryAt(dir, file).summary, 'fixed summary');
    assert.ok(!(retry.out.notices ?? []).some((n) => /반영되지 않았습니다/.test(n)));
  });
});

suite('close entries: the first session-log shard header');

function firstShardHeader(sessionId, device) {
  let header = null;
  const prev = process.env.HYPO_DEVICE;
  process.env.HYPO_DEVICE = device;
  try {
    withWiki(null, (dir, today) => {
      const payload = v2Payload(today, { tag: 'header probe' });
      // The fixture already has a monthly log; a daily shard for today is what a close creates.
      const { out } = applyJson(dir, payload, sessionId);
      assert.equal(out.ok, true, JSON.stringify(out));
      const text = readFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
        'utf-8',
      );
      header = text.slice(0, text.indexOf('\n## ')).replaceAll(today, '<today>');
    });
  } finally {
    if (prev === undefined) delete process.env.HYPO_DEVICE;
    else process.env.HYPO_DEVICE = prev;
  }
  return header;
}

test('the first shard of a day has the same header bytes whatever the session id and device', () => {
  const a = firstShardHeader(newPinSession('hdr-a'), 'device-one');
  const b = firstShardHeader(newPinSession('hdr-b'), 'device-two');
  assert.equal(a, b);
  assert.ok(!/session_id|device/.test(a), a);
});

test('two clones that each create the first shard of a day pull each other without session_id or device keys in the result', () => {
  const base = mkdtempSync(join(tmpdir(), 'hypo-clones-'));
  const env = { ...process.env, HOME: SESSION_TMP_HOME };
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf-8' });
  try {
    const today = todayLocal();
    const seed = join(base, 'seed');
    mkdirSync(seed);
    buildCleanWikiTree(seed, today);
    // log.md is shared by every close: the union driver keeps both sides' lines there too.
    writeFileSync(join(seed, '.gitattributes'), `${GITATTRIBUTES_BLOCK}log.md merge=union\n`);
    git(seed, 'init', '-q');
    git(seed, 'config', 'user.email', 't@t.test');
    git(seed, 'config', 'user.name', 'T');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'init');
    git(base, 'init', '--bare', '-q', 'remote.git');
    git(seed, 'remote', 'add', 'origin', join(base, 'remote.git'));
    git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const cloneOf = (name) => {
      const dir = join(base, name);
      git(base, 'clone', '-q', '-b', 'main', join(base, 'remote.git'), name);
      git(dir, 'config', 'user.email', 't@t.test');
      git(dir, 'config', 'user.name', 'T');
      return dir;
    };
    const one = cloneOf('one');
    const two = cloneOf('two');
    const closeIn = (dir, label, device) => {
      const prev = process.env.HYPO_DEVICE;
      process.env.HYPO_DEVICE = device;
      try {
        const { out } = applyJson(
          dir,
          v2Payload(today, { tag: `close ${label}` }),
          newPinSession(label),
        );
        assert.equal(out.ok, true, JSON.stringify(out));
      } finally {
        if (prev === undefined) delete process.env.HYPO_DEVICE;
        else process.env.HYPO_DEVICE = prev;
      }
    };
    closeIn(one, 'clone-one', 'device-one');
    closeIn(two, 'clone-two', 'device-two');
    assert.equal(git(one, 'push', '-q', 'origin', 'HEAD:main').status, 0);
    const pulled = git(two, 'pull', '--no-rebase', '--no-edit', 'origin', 'main');
    assert.equal(pulled.status, 0, `${pulled.stdout}\n${pulled.stderr}`);
    const shard = readFileSync(
      join(two, 'projects', 'test-project', 'session-log', `${today}.md`),
      'utf-8',
    );
    const frontmatter = shard.slice(0, shard.indexOf('\n---\n', 4));
    assert.ok(!/^session_id:/m.test(frontmatter) && !/^device:/m.test(frontmatter), frontmatter);
    assert.ok(shard.includes('close clone-one') && shard.includes('close clone-two'), shard);
    assert.equal((shard.match(/^---$/gm) || []).length, 2, 'one frontmatter block, not two merged');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
