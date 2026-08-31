// tests/crystallize-apply.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { snapshotBase, overwriteTargets } from '../hooks/base-store.mjs';
import { findBackfillCandidate } from '../hooks/hypo-shared.mjs';
import { ensureProjectIndex } from '../scripts/crystallize.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
  REPO,
  SESSION_TMP_HOME,
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

// ── fix #38: --apply-session-close --payload <json> ───────────────────────────
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
test('a second apply of an unchanged payload: applied:[], skipped names every field, committed:true', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const first = runApply(dir, payload);
    const firstOut = JSON.parse(first.stdout);
    assert.equal(firstOut.ok, true, `first apply must succeed: ${first.stdout}`);

    const second = runApply(dir, payload);
    const out = JSON.parse(second.stdout);
    assert.equal(out.ok, true, `second apply must still succeed: ${second.stdout}`);
    assert.deepEqual(out.applied, [], 'nothing new to write on an identical re-run');
    assert.ok(
      ['sessionState', 'projectHot', 'rootHot', 'sessionLog', 'log'].every((k) =>
        out.skipped.some((s) => s.startsWith(k)),
      ),
      `skipped must name every field the payload carries: ${JSON.stringify(out.skipped)}`,
    );
    assert.equal(out.committed, true, 'nothing to stage is still a successful commit outcome');
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
  // close content.
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: 2020-01-01\n---\n\n# Hot\n`,
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
  // page under projects/, not one of the 5 mandatory close files) must NOT block
  // the documented apply path. It is surfaced as a notice and the payload lands.
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'broken.md'),
        '---\ntitle: broken\ntype: concept\n\nbody (frontmatter never closes)\n',
      );
    },
    (dir, today) => {
      // Overwrite fields only write cleanly with an observed, matching base
      // (FEAT-11 T4); seed it under the session-id this apply uses, or the
      // sentinel write is refused as base-unknown before it reaches the
      // out-of-scope-debt logic this test is actually about.
      const sid = 'preflight-bug-b-session';
      snapshotBase(dir, sid, overwriteTargets('test-project'));
      const sentinel = `<!-- preflight-sentinel-${Date.now()} -->`;
      const payload = payloadForCleanWiki(dir, today);
      payload.sessionState = {
        content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## 다음 작업\n\n- next\n`,
      };
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
      const onDisk = readFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        'utf-8',
      );
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
    const onDisk = readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8');
    assert.ok(
      !onDisk.includes(sentinel),
      'preflight failure must NOT have written payload sentinel',
    );
  });
});

test('post-apply (#40): payload introduces lint blocker → exit 1 stage=post-apply-lint, bytes written', () => {
  // Payload writes a session-state body that omits the required "## 다음 작업"
  // heading — lint raises an error, but freshness gate still passes (updated:
  // today). Apply DID write (sentinel present on disk), but final result is
  // ok:false with stage=post-apply-lint so caller distinguishes "wiki was
  // damaged" from "frontmatter stale".
  withWiki(null, (dir, today) => {
    // Overwrite fields only write cleanly with an observed, matching base
    // (FEAT-11 T4); seed it under the session-id this apply uses, or the write
    // is refused as base-unknown before it ever reaches post-apply lint.
    const sid = 'post-apply-lint-session';
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const sentinel = `<!-- post-apply-sentinel-${Date.now()} -->`;
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## random heading without required label\n\n- next\n`,
    };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(r.status, 1, `post-apply lint must fail, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'post-apply-lint', `stage should be post-apply-lint: ${r.stdout}`);
    assert.equal(out.verification.ok, true, 'freshness gate should still pass');
    const onDisk = readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8');
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

    // 1. Apply a bad payload (session-state missing required heading)
    const bad = payloadForCleanWiki(dir, today);
    bad.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## wrong heading\n\n- next\n`,
    };
    const r1 = runApply(dir, bad, { sessionId: sid });
    assert.equal(r1.status, 1, `bad payload must fail: ${r1.stdout}`);
    assert.equal(JSON.parse(r1.stdout).stage, 'post-apply-lint');

    // 2. Retry with corrected payload — must succeed (was dead-locked before fix)
    const good = payloadForCleanWiki(dir, today);
    good.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- fixed\n`,
    };
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
    // The payload also rewrites overwrite targets (session-state, both hot files)
    // that a successful apply touches BEFORE the shard append. Assert the whole
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
    // sessionState/projectHot/rootHot re-assert identical content (idempotent
    // skip); sessionLog + log carry fresh entries, so this close DOES write
    // bytes — session-log/<ym>.md and log.md — while leaving the three
    // overwrite targets untouched. That is exactly the mixed applied/skipped
    // shape the scoped commit must handle correctly.
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
    // non-W8/non-strict --json deliberately omits the `id` field on every
    // other warning class (lint.mjs's byte-identical-default guarantee).
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

// ── ISSUE-63: pointer-table superset auto-advance (end to end) ───────────────
// Root hot.md is a shared pointer table: one row per project, edited by
// appending or updating a row. Two machines editing DIFFERENT rows produce a
// whole-file base-mismatch that reads as a collision even though nothing
// collided. `overwrite()` now escapes exactly that one reason through
// advanceBaseIfRowInsertion (hooks/base-store.mjs); every other conflict reason,
// including base-unknown, must still park unchanged.
suite('ISSUE-63: pointer-table superset auto-advance escapes base-mismatch only');

test('a base-mismatch on root hot.md auto-resolves when the payload preserves every disk row (superset)', () => {
  withWiki(null, (dir, today) => {
    const sid = 'issue63-superset';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    // A different machine appends its own row directly on disk, after the base
    // snapshot: the normal multi-machine pointer-table pattern.
    const betaRow = `| beta-project | ${today} | [[projects/beta-project/hot]] |`;
    const original = readFileSync(join(dir, 'hot.md'), 'utf-8');
    const drifted = `${original.trimEnd()}\n${betaRow}\n`;
    writeFileSync(join(dir, 'hot.md'), drifted);

    // This session's own close carries every line the other writer left, in the
    // order they are in on disk, and adds its own row after them. That is the
    // multi-machine pointer-table pattern the auto-advance exists for: appending
    // shifts nobody, so nothing anyone wrote can be lost by this write.
    const gammaRow = `| gamma-project | ${today} | [[projects/gamma-project/hot]] |`;
    const payload = payloadForCleanWiki(dir, today);
    payload.rootHot = { content: `${drifted.trimEnd()}\n${gammaRow}\n` };

    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(
      r.status,
      0,
      `a superset overwrite must not fail the close: ${r.stdout}\n${r.stderr}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.conflicts, [], 'no conflict when the new content is a superset of disk');
    assert.equal(
      readFileSync(join(dir, 'hot.md'), 'utf-8'),
      payload.rootHot.content,
      'the payload content is written directly, not withheld',
    );
  });
});

test('a base-mismatch on root hot.md still parks when the payload drops a disk row', () => {
  withWiki(null, (dir, today) => {
    const sid = 'issue63-dropped-row';
    snapshotBase(dir, sid, overwriteTargets('test-project'));

    const betaRow = `| beta-project | ${today} | [[projects/beta-project/hot]] |`;
    const original = readFileSync(join(dir, 'hot.md'), 'utf-8');
    writeFileSync(join(dir, 'hot.md'), `${original.trimEnd()}\n${betaRow}\n`);

    // This session's write is unaware of the other machine's row: it would
    // silently drop beta-project's row, so it is not a superset.
    const payload = payloadForCleanWiki(dir, today);
    payload.rootHot = { content: `${original.trimEnd()}\n<!-- own edit -->\n` };

    const r = runApply(dir, payload, { sessionId: sid });
    assert.notEqual(r.status, 0, `a dropped row must still park: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'proposal-pending');
    const rootHotConflict = out.conflicts.find((c) => c.target === 'hot.md');
    assert.ok(rootHotConflict, `hot.md must be in conflicts: ${JSON.stringify(out.conflicts)}`);
    assert.equal(rootHotConflict.reason, 'base-mismatch');
    assert.ok(
      !readFileSync(join(dir, 'hot.md'), 'utf-8').includes('own edit'),
      'the target must stay unclobbered on disk',
    );
  });
});

test('a base-unknown target still parks even for a superset payload (the escape is base-mismatch only)', () => {
  withWiki(null, (dir, today) => {
    // No snapshotBase call: this session never observed hot.md, so its entry
    // state is 'unknown' no matter what the payload contains.
    const sid = 'issue63-base-unknown';
    const betaRow = `| beta-project | ${today} | [[projects/beta-project/hot]] |`;
    const original = readFileSync(join(dir, 'hot.md'), 'utf-8');
    const originalRow = original.split('\n').find((l) => l.startsWith('| test-project'));

    // A genuine superset of the current disk content: it carries the existing
    // row and only adds a new one.
    const payload = payloadForCleanWiki(dir, today);
    payload.rootHot = { content: original.replace(originalRow, `${originalRow}\n${betaRow}`) };

    const r = runApply(dir, payload, { sessionId: sid });
    assert.notEqual(
      r.status,
      0,
      `base-unknown must still park even for a superset write: ${r.stdout}\n${r.stderr}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    const rootHotConflict = out.conflicts.find((c) => c.target === 'hot.md');
    assert.ok(
      rootHotConflict,
      `hot.md must still be in conflicts: ${JSON.stringify(out.conflicts)}`,
    );
    assert.equal(
      rootHotConflict.reason,
      'base-unknown',
      'the superset escape must not touch base-unknown',
    );
  });
});
