// tests/close-hooks-gate.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, suite } from './harness.mjs';
import {
  HOME,
  SESSION_TMP_HOME,
  buildCleanWikiTree,
  extractTouchedWikiFiles,
  payloadForCleanWiki,
  run,
  runApply,
  runHook,
  sessionCloseFileStatus,
  sessionLogReadCandidates,
  sessionLogShardPath,
  todayLocal,
  withCleanWiki,
  withTmpDir,
  withWiki,
} from './helpers.mjs';

suite('session-log daily shard (ADR 0050)');

test('sessionLogShardPath: date is the filename (daily canonical, POSIX)', () => {
  assert.equal(
    sessionLogShardPath('proj', '2026-06-15'),
    'projects/proj/session-log/2026-06-15.md',
  );
});

test('sessionLogReadCandidates: daily shard first, legacy monthly fallback', () => {
  assert.deepEqual(sessionLogReadCandidates('proj', '2026-06-15'), [
    'projects/proj/session-log/2026-06-15.md',
    'projects/proj/session-log/2026-06.md',
  ]);
});

test('freshness: a today-dated heading in the daily shard (no monthly file) passes the gate', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    buildCleanWikiTree(dir, today);
    // Remove the monthly file the fixture seeds; put the entry in the daily shard only.
    rmSync(join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`));
    writeFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
      `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] daily-shard session\n`,
    );
    const st = sessionCloseFileStatus(dir, { projectOverride: 'test-project' });
    assert.ok(
      !st.stale.some((f) => f.includes('session-log')) &&
        !st.missing.some((f) => f.includes('session-log')),
      `daily shard should satisfy freshness: ${JSON.stringify(st)}`,
    );
  });
});

test('freshness: legacy monthly file (no daily shard) still passes via fallback', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    buildCleanWikiTree(dir, today); // seeds the monthly file only
    assert.ok(
      !existsSync(join(dir, 'projects', 'test-project', 'session-log', `${today}.md`)),
      'no daily shard should exist for this fixture',
    );
    const st = sessionCloseFileStatus(dir, { projectOverride: 'test-project' });
    assert.ok(
      !st.stale.some((f) => f.includes('session-log')) &&
        !st.missing.some((f) => f.includes('session-log')),
      `legacy monthly fallback should satisfy freshness: ${JSON.stringify(st)}`,
    );
  });
});

test('freshness: when NEITHER daily nor monthly carries today, the gap is reported as the daily shard', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    buildCleanWikiTree(dir, today);
    // Make the monthly file carry an OLD date (no today heading) and no daily shard.
    writeFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`),
      `---\ntitle: Session Log\ntype: session-log\nupdated: 2020-01-01\n---\n\n## [2020-01-01] old session\n`,
    );
    const st = sessionCloseFileStatus(dir, { projectOverride: 'test-project' });
    const reported = [...st.stale, ...st.missing].filter((f) => f.includes('session-log'));
    assert.ok(
      reported.length === 1 && /\/\d{4}-\d{2}-\d{2}\.md$/.test(reported[0]),
      `gap must be reported as the daily shard, got: ${JSON.stringify(reported)}`,
    );
  });
});

test('apply: a new daily shard is created with seeded frontmatter (lint-clean, not monthly)', () => {
  withWiki(null, (dir, today) => {
    // buildCleanWikiTree seeds the monthly file with today's heading; the payload
    // carries a DISTINCT entry, so the apply must create the daily shard.
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] brand-new daily entry\n\nbody\n` };
    payload.log = { entry: `## [${today}] session | test-project — daily\n` };
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `apply must succeed: ${r.stdout}\n${r.stderr}`);
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    assert.ok(existsSync(shard), 'daily shard must be created');
    const body = readFileSync(shard, 'utf-8');
    assert.ok(/^---\n/.test(body), 'shard must start with seeded frontmatter');
    assert.ok(/\ntype: session-log\n/.test(body), 'shard frontmatter must carry type');
    assert.ok(/\ntitle: /.test(body), 'shard frontmatter must carry title');
    assert.ok(body.includes('brand-new daily entry'), 'entry must be appended after the header');
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `post-apply lint on the seeded shard must be clean: ${r.stdout}`);
  });
});

test('apply: identical entry already in the legacy monthly file → no duplicate, no daily shard (hybrid no-op)', () => {
  withWiki(null, (dir, today) => {
    // The fixture's monthly file already carries `## [today] test session`.
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] test session\n` }; // identical to the seeded monthly heading
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `apply must succeed: ${r.stdout}\n${r.stderr}`);
    assert.ok(
      !existsSync(join(dir, 'projects', 'test-project', 'session-log', `${today}.md`)),
      'no daily shard should be created when the identical entry already lives in the monthly file',
    );
  });
});

test('apply (ADR 0050 regression): a CORRUPT monthly evidence file in the no-op path blocks (no false-pass)', () => {
  withWiki(
    (dir, today) => {
      // Pre-commit: corrupt the monthly file's frontmatter (--- never closes) but
      // keep today's heading, so freshness still accepts it via the fallback.
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`),
        `---\ntitle: sl\ntype: session-log\n\n## [${today}] test session\n`,
      );
    },
    (dir, today) => {
      // Identical entry → fallback-aware idempotency would skip the daily write,
      // leaving the corrupt monthly as the freshness evidence. Because that file
      // is now the resolved evidence, it is IN payloadScope and its malformed
      // frontmatter must abort preflight — not pass with an out-of-scope notice.
      const payload = payloadForCleanWiki(dir, today);
      payload.sessionLog = { entry: `## [${today}] test session\n` };
      const r = runApply(dir, payload);
      assert.equal(
        r.status,
        1,
        `corrupt monthly evidence must block, got ${r.status}\n${r.stdout}`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.stage, 'preflight-lint', `stage should be preflight-lint: ${r.stdout}`);
    },
  );
});

test('apply (ADR 0050): a corrupt monthly is OUT of scope (a notice) once the daily shard is the evidence (Bug B preserved)', () => {
  withWiki(
    (dir, today) => {
      // The daily shard carries today's heading → IT is the evidence, not the
      // monthly. The monthly is corrupt but unrelated debt: it must stay a
      // non-blocking notice (Bug B), exactly like any other out-of-scope file.
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
        `---\ntitle: Session Log ${today} (test-project)\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] daily session\n`,
      );
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`),
        `---\ntitle: sl\ntype: session-log\n\n## [2020-01-01] old\n`,
      );
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      payload.sessionLog = { entry: `## [${today}] another distinct entry\n` };
      const r = runApply(dir, payload);
      assert.equal(
        r.status,
        0,
        `corrupt monthly debt must NOT block when the daily shard is the evidence: ${r.stdout}\n${r.stderr}`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.ok,
        true,
        `apply ok; the monthly error is an out-of-scope notice: ${r.stdout}`,
      );
    },
  );
});

test('extractTouchedWikiFiles: pulls Edit/Write file_paths under hypoDir, ignores outside paths', () => {
  withTmpDir((dir) => {
    const inside = join(dir, 'projects', 'p', 'session-state.md');
    const transcript = join(dir, 't.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: inside } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/etc/outside.md' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      }),
      'truncated-bad-json-line{',
    ];
    writeFileSync(transcript, lines.join('\n'));
    const touched = extractTouchedWikiFiles(transcript, dir);
    assert.ok(touched.has('projects/p/session-state.md'));
    assert.equal(touched.has('/etc/outside.md'), false);
    assert.equal(touched.size, 1);
  });
});

test('extractTouchedWikiFiles: missing transcript → empty set (caller falls back)', () => {
  assert.equal(extractTouchedWikiFiles('/no/such/transcript.jsonl', '/tmp').size, 0);
  assert.equal(extractTouchedWikiFiles(null, '/tmp').size, 0);
});

suite('hypo-compact-guard.mjs — contract');

test('invalid JSON input → fail-open {continue:true}', () => {
  const r = runHook('hypo-compact-guard.mjs', 'not-json');
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('non-compact prompt → pass-through', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: 'hello world' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('HYPO_SKIP_GATE=1 + /compact → pass-through', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' }, { HYPO_SKIP_GATE: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('/compact with incomplete wiki → additionalContext, not systemMessage', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' });
  const out = JSON.parse(r.stdout);
  assert.ok('additionalContext' in out, 'missing additionalContext field');
  assert.ok(!('systemMessage' in out), 'must not use deprecated systemMessage field');
});

test('/compact with incomplete wiki → continue:true (soft nudge, not block)', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
});

test('/compact with incomplete wiki → additionalContext contains WIKI_AUTOCLOSE', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' });
  const out = JSON.parse(r.stdout);
  assert.ok(out.additionalContext.includes('WIKI_AUTOCLOSE'), 'missing WIKI_AUTOCLOSE marker');
});

test('/compact with clean wiki → pass-through', () => {
  withCleanWiki((dir) => {
    const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true);
  });
});

test('/compact with committed-but-unpushed (ahead) wiki → pass-through (ADR 0056)', () => {
  // The 3rd hypoIsClean consumer: ahead-only must NOT block /compact (mirrors the
  // precompactGateStatus demote — unpushed is a soft, auto-synced state).
  withCleanWiki((dir) => {
    const remote = mkdtempSync(join(tmpdir(), 'hypo-cg-remote-'));
    spawnSync('git', ['init', '--bare', '-q', remote]);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    spawnSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'HEAD']);
    writeFileSync(join(dir, 'extra.md'), '# extra\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'unpushed']);
    const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' }, { HYPO_DIR: dir });
    rmSync(remote, { recursive: true, force: true });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true, `ahead-only must not block /compact: ${r.stdout}`);
  });
});

test('/compact with uncommitted change → blocks (git axis still enforced, ADR 0056)', () => {
  withCleanWiki((dir) => {
    writeFileSync(join(dir, 'dirty.md'), '# dirty\n');
    const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.ok(
      /WIKI_AUTOCLOSE/.test(out.additionalContext || ''),
      `uncommitted work must still block /compact: ${r.stdout}`,
    );
  });
});

test('output is always valid JSON regardless of prompt', () => {
  for (const prompt of ['/compact', 'hello', '']) {
    const r = runHook('hypo-compact-guard.mjs', { prompt });
    assert.doesNotThrow(() => JSON.parse(r.stdout), `invalid JSON for prompt="${prompt}"`);
  }
});

// ── replay-compact-guard-detects-slash-clear (ADR 0022 Layer 2) ──
// @fix #25: replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE

test('replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear' });
  const out = JSON.parse(r.stdout);
  assert.ok('additionalContext' in out, 'missing additionalContext field on /clear');
  assert.equal(out.continue, true);
  assert.ok(out.additionalContext.includes('WIKI_AUTOCLOSE'), 'missing WIKI_AUTOCLOSE marker');
  assert.ok(out.additionalContext.includes('/clear'), 'message must reference /clear');
});

test('/clear with trailing args → still detected', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear something' });
  const out = JSON.parse(r.stdout);
  assert.ok('additionalContext' in out);
  assert.ok(out.additionalContext.includes('/clear'));
});

test('HYPO_SKIP_GATE=1 + /clear → pass-through', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear' }, { HYPO_SKIP_GATE: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('/clear with clean wiki → pass-through', () => {
  withCleanWiki((dir) => {
    const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true);
  });
});

test('/clearfoo (no word boundary) → pass-through (not /clear)', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clearfoo' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

suite('hypo-personal-check.mjs — close-intent enrichment (#20)');

test('close intent in transcript → block message includes close-intent note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-close-'));
  try {
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ message: { role: 'user', content: '세션 마무리하자' } }) + '\n',
    );
    const r = runHook('hypo-personal-check.mjs', { transcript_path: transcript });
    const out = JSON.parse(r.stdout);
    assert.ok(out.decision === 'block', 'should still block when session close is incomplete');
    assert.ok(
      out.reason.includes('Close intent'),
      'block reason should mention close intent detection',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no close intent → block message does NOT include close-intent note', () => {
  const r = runHook('hypo-personal-check.mjs', {});
  const out = JSON.parse(r.stdout);
  assert.ok(out.decision === 'block');
  assert.ok(
    !out.reason.includes('Close intent'),
    'block reason should not mention close intent when absent',
  );
});

suite('hypo-personal-check.mjs — contract');

test('output is always valid JSON', () => {
  const r = runHook('hypo-personal-check.mjs', '');
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout: ${r.stdout}`);
});

test('no wiki dir → block decision', () => {
  const r = runHook('hypo-personal-check.mjs', '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.continue, false);
});

test('block response includes stopReason string', () => {
  const r = runHook('hypo-personal-check.mjs', '');
  const out = JSON.parse(r.stdout);
  assert.ok(typeof out.stopReason === 'string' && out.stopReason.length > 0);
});

test('block reason contains WIKI CHECK marker', () => {
  const r = runHook('hypo-personal-check.mjs', '');
  const out = JSON.parse(r.stdout);
  assert.ok(out.reason.includes('WIKI CHECK'), 'missing WIKI CHECK marker in reason');
});

test('HYPO_SKIP_GATE=1 → continue:true + systemMessage (PreCompact has no additionalContext)', () => {
  const r = runHook('hypo-personal-check.mjs', '', { HYPO_SKIP_GATE: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  // PreCompact hook does not support additionalContext per Claude Code docs — systemMessage is the correct universal field.
  assert.ok('systemMessage' in out, 'missing systemMessage field');
  assert.ok(
    !('additionalContext' in out),
    'PreCompact must not use unsupported additionalContext field',
  );
});

test('clean wiki → suppressOutput:true', () => {
  withCleanWiki((dir) => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.suppressOutput, true);
    assert.equal(out.continue, true);
  });
});

suite('hypo-personal-check.mjs — strict session-close gate (#17)');

// @fix #17: 5 mandatory memory files fresh → suppressOutput:true
// @fix #17: project hot.md not updated today → block, reason names the file
// @fix #17: open-questions.md absent/stale → still passes (conditional, not gated)

test('5 mandatory memory files fresh → suppressOutput:true', () => {
  withWiki(null, (dir) => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `expected pass, got: ${r.stdout}`);
    assert.equal(out.suppressOutput, true);
  });
});

test('project hot.md not updated today → block, reason names the file', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'hot.md'),
        '---\ntitle: hot\ntype: reference\nupdated: 2020-01-01\n---\n\n# Hot\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
      assert.ok(
        out.reason.includes('projects/test-project/hot.md'),
        `block reason should name the stale file: ${out.reason}`,
      );
    },
  );
});

test('session-log missing a today-dated heading → block', () => {
  withWiki(
    (dir, today) => {
      const ym = today.slice(0, 7);
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${ym}.md`),
        '---\ntitle: Session Log\ntype: session-log\nupdated: 2020-01-01\n---\n\n## [2020-01-01] old session\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
      assert.ok(
        out.reason.includes('session-log'),
        `block reason should name the session-log file: ${out.reason}`,
      );
    },
  );
});

test('lint blockers without id field → reason names files, no empty placeholders', () => {
  // Regression: line 244 used `b.id` directly, but error-severity lint issues
  // never carry an id (only W8 warns do). The result was a reason like
  // `lint blockers: , , , , , , ,` — blocks correctly but tells the user
  // nothing actionable. Fix: fall back to file path + dedupe.
  //
  // The lint error must live in an IN-SCOPE close file (ADR 0041): a no-transcript
  // PreCompact scopes blocking lint to closeFileTargets, so an out-of-scope page
  // would only surface as a notice. session-state.md (a mandatory close file)
  // missing its required next-task heading is a SCHEMA-independent lint error.
  withWiki(
    (dir, today) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## Wrong Heading\n\n- next\n`,
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block: ${r.stdout}`);
      assert.ok(
        out.reason.includes('lint blockers: projects/test-project/session-state.md'),
        `lint blockers should name the file, got: ${out.reason}`,
      );
      assert.ok(
        !/lint blockers:\s*,/.test(out.reason),
        `lint blockers section must not start with empty commas: ${out.reason}`,
      );
    },
  );
});

test('no-transcript PreCompact: out-of-scope lint error → notice, not blocking (ADR 0041)', () => {
  // ADR 0041 (reverses ADR 0037's global fallback): a PreCompact with no
  // transcript scopes blocking lint to closeFileTargets. An error in a file this
  // session did not touch (other project / shared page) must NOT hold /compact
  // hostage — it surfaces as a non-blocking notice. Real interactive /compact
  // always carries a transcript, so this fallback only fires in headless /
  // apply-path / programmatic modes where closeFileTargets is the complete set
  // of session-accountable files.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'feedback', 'broken.md'),
        '---\ntitle: broken\ntype: feedback\nstatus: active\nscope: INVALID-SCOPE\nsensitivity: public\nupdated: 2026-05-26\n---\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.continue,
        true,
        `out-of-scope lint debt must not block a no-transcript compact: ${r.stdout}`,
      );
      // The debt lives in a shared page (pages/feedback/, not under an active
      // project dir), so it is surfaced as a folded count, not named per-file —
      // the same untouched-file debt must not re-list its filenames every compact.
      assert.ok(
        out.systemMessage &&
          /pre-existing lint issue\(s\) elsewhere in the vault/.test(out.systemMessage),
        `the out-of-scope shared-page error should surface as a folded notice: ${r.stdout}`,
      );
      assert.ok(
        !out.systemMessage.includes('pages/feedback/broken.md'),
        `out-of-scope shared-page debt must NOT be named per-file (it folds): ${r.stdout}`,
      );
    },
  );
});

test('PreCompact notice scope: debt UNDER an active project dir is named, not folded', () => {
  // The complement of the shared-page fold: lint debt under the close-target
  // (today-active) project's own dir is this close's neighborhood, so it stays
  // listed by filename rather than collapsing into the "+N elsewhere" count.
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'notes.md'),
        '---\ntitle: notes\ntype: concept\n\nbody (frontmatter never closes)\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, true, `in-project debt must not block compact: ${r.stdout}`);
      assert.ok(
        out.systemMessage && out.systemMessage.includes('projects/test-project/notes.md'),
        `debt under the active project dir should be named, not folded: ${r.stdout}`,
      );
    },
  );
});

test('PreCompact with transcript touching an out-of-scope file → that file blocks', () => {
  // The transcript widens the scope: a file the session actually edited via
  // Edit/Write is in-scope and its lint error blocks, even though it lives
  // outside closeFileTargets. This is the have-transcript half of ADR 0041.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'feedback', 'broken.md'),
        '---\ntitle: broken\ntype: feedback\nstatus: active\nscope: INVALID-SCOPE\nsensitivity: public\nupdated: 2026-05-26\n---\n',
      );
    },
    (dir) => {
      const transcript = join(dir, 'transcript.jsonl');
      writeFileSync(
        transcript,
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Edit',
                input: { file_path: join(dir, 'pages', 'feedback', 'broken.md') },
              },
            ],
          },
        }),
      );
      const r = runHook(
        'hypo-personal-check.mjs',
        { transcript_path: transcript },
        { HYPO_DIR: dir },
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `a touched file's lint error must block: ${r.stdout}`);
      assert.ok(
        out.reason.includes('lint blockers: pages/feedback/broken.md'),
        `block reason should name the touched file: ${out.reason}`,
      );
    },
  );
});

test('no-transcript PreCompact: active project design-history stale → blocks (W8)', () => {
  // W8 (design-history stale) for the ACTIVE project is this session's close
  // responsibility and must block, in the no-transcript path too (ADR 0041
  // unifies the branches so W8 is scoped to the active project either way).
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'design-history.md'),
        '---\ntitle: design-history\ntype: design-history\nupdated: 2026-01-01\n---\n\n## 2026-01-01\n- old\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.decision,
        'block',
        `active-project stale design-history must block: ${r.stdout}`,
      );
      assert.ok(
        out.reason.includes('design-history stale'),
        `block reason should name design-history staleness: ${out.reason}`,
      );
    },
  );
});

test('no-transcript PreCompact: another project design-history stale → notice, not blocking (W8 scoped to active, ADR 0041)', () => {
  // A DIFFERENT project's stale design-history is cross-project debt, not this
  // session's responsibility. The old no-transcript branch gated on all
  // projects' W8 (lintW8 = allW8); the unified branch scopes W8 to the active
  // project, so another project's staleness surfaces as a notice, not a block.
  withWiki(
    (dir, today) => {
      const otherLog = join(dir, 'projects', 'other-proj', 'session-log');
      mkdirSync(otherLog, { recursive: true });
      writeFileSync(
        join(dir, 'projects', 'other-proj', 'design-history.md'),
        '---\ntitle: design-history\ntype: design-history\nupdated: 2026-01-01\n---\n\n## 2026-01-01\n- old\n',
      );
      writeFileSync(
        join(otherLog, `${today.slice(0, 7)}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] other session\n`,
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.continue,
        true,
        `another project's stale design-history must not block the active project's compact: ${r.stdout}`,
      );
    },
  );
});

test('open-questions.md absent/stale → still passes (conditional, not gated)', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'open-questions.md'),
        '---\ntitle: Open Questions\ntype: open-questions\nupdated: 2020-01-01\n---\n\n# Open Questions\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.continue,
        true,
        `open-questions is conditional — should not gate: ${r.stdout}`,
      );
    },
  );
});

test('log.md missing a today-dated session entry → block', () => {
  withWiki(
    (dir) => {
      // log.md exists but its session entry is stale-dated.
      writeFileSync(join(dir, 'log.md'), '## [2020-01-01] session | test-project — old\n');
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
      assert.ok(out.reason.includes('log.md'), `block reason should name log.md: ${out.reason}`);
    },
  );
});

test('log.md session entry for a different project → block', () => {
  withWiki(
    (dir, today) => {
      // A fresh session entry, but for some other project — must not satisfy
      // the gate for the resolved project (test-project).
      writeFileSync(join(dir, 'log.md'), `## [${today}] session | other-project — done\n`);
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `cross-project log entry must not pass: ${r.stdout}`);
      assert.ok(out.reason.includes('log.md'), `block reason should name log.md: ${out.reason}`);
    },
  );
});

test('HYPO_SKIP_GATE=1 bypasses an incomplete session close', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HYPO_SKIP_GATE: '1' });
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, true, `HYPO_SKIP_GATE should bypass: ${r.stdout}`);
      assert.ok(
        out.systemMessage.includes('memory files not updated'),
        `bypass message should still surface the incomplete files: ${out.systemMessage}`,
      );
    },
  );
});

// ── replay-personal-check-bypass-order (ADR 0022 amendment 2026-05-13) ──
// @fix #26: replay-personal-check-bypass-order: wiki-context-critical.json does NOT bypass (negative control)
// Capacity bypass (wiki-context-critical.json ≥90%) was removed. Spec §7.5:
// the only bypass paths are HYPO_SKIP_GATE env / transcript user-role message.

test('replay-personal-check-bypass-order: wiki-context-critical.json does NOT bypass (negative control)', () => {
  withWiki(
    (dir) => {
      // Make session-close stale so the gate would normally block.
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
      );
    },
    (dir) => {
      // Write the (now-defunct) capacity marker into the session-scoped tmp HOME,
      // and force the child hook to see THAT HOME — never the developer's real
      // ~/.claude/state/. This mirrors the test-hermeticity invariant established
      // by PR #30 (stage-2-#3): every hook test must scope HOME to SESSION_TMP_HOME.
      const stateDir = join(SESSION_TMP_HOME, '.claude', 'state');
      mkdirSync(stateDir, { recursive: true });
      const criticalPath = join(stateDir, 'wiki-context-critical.json');
      writeFileSync(criticalPath, JSON.stringify({ percent: 95 }));

      try {
        const r = runHook('hypo-personal-check.mjs', '', {
          HYPO_DIR: dir,
          HOME: SESSION_TMP_HOME,
        });
        const out = JSON.parse(r.stdout);

        // Pre-fix: would have continue:true + "gate auto-bypassed (context ≥90% critical)".
        // Post-fix: capacity flag is ignored → normal block path runs.
        assert.equal(
          out.decision,
          'block',
          `CRITICAL_FILE must NOT bypass — gate should still block: ${r.stdout}`,
        );
        assert.ok(
          !(out.systemMessage || '').includes('context ≥90% critical'),
          'capacity-bypass message must no longer appear',
        );

        // Negative control: the file MUST remain — fix #26 removed the unlink path too.
        // If it's gone, the old bypass code is still wired somewhere.
        assert.ok(
          existsSync(criticalPath),
          'wiki-context-critical.json should not be consumed (bypass path removed)',
        );
      } finally {
        if (existsSync(criticalPath)) {
          try {
            unlinkSync(criticalPath);
          } catch {}
        }
      }
    },
  );
});

suite('crystallize.mjs --check-session-close (#17)');

test('clean session close → exit 0 + ok:true', () => {
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.project, 'test-project');
  });
});

test('stale memory file → exit 1 + ok:false + names the file', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        out.stale.includes('projects/test-project/session-state.md'),
        `stale list should name the file: ${JSON.stringify(out.stale)}`,
      );
    },
  );
});

test('--check-session-close reads log.md from --hypo-dir, not the ambient wiki', () => {
  withWiki(
    (dir) => {
      // log.md whose last substantial op is an ingest, not a session close.
      writeFileSync(join(dir, 'log.md'), '## [2020-01-01] ingest | some-source\n');
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        out.stale.includes('log.md'),
        `log.md check must target --hypo-dir and flag it stale: ${r.stdout}`,
      );
    },
  );
});

test('missing log.md → exit 1 + log.md in missing list', () => {
  withWiki(
    (dir) => {
      rmSync(join(dir, 'log.md'));
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(out.missing.includes('log.md'), `missing list should name log.md: ${r.stdout}`);
    },
  );
});
