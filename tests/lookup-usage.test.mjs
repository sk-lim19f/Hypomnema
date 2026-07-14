// tests/lookup-usage.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPageUsage, aggregateColdCandidates } from '../scripts/lib/page-usage.mjs';
import { test, suite } from './harness.mjs';
import { run, runHook, withTmpDir } from './helpers.mjs';

suite('hypo-lookup.mjs — type-prior boost');

test('output is always valid JSON', () => {
  const r = runHook('hypo-lookup.mjs', { prompt: 'hello world' });
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout: ${r.stdout}`);
});

test('PRD entry ranked above plain entry with same keyword', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'prd-search.md'), '# PRD\n');
    writeFileSync(join(dir, 'pages', 'search-notes.md'), '# Notes\n');
    const indexContent = [
      '# Index',
      '- [[prd-search]] — search feature product requirements',
      '- [[search-notes]] — search feature general notes',
    ].join('\n');
    writeFileSync(join(dir, 'index.md'), indexContent);
    const r = runHook('hypo-lookup.mjs', { prompt: 'search feature' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    const prdPos = ctx.indexOf('prd-search');
    const plainPos = ctx.indexOf('search-notes');
    assert.ok(prdPos !== -1, 'PRD entry should appear in context');
    assert.ok(prdPos < plainPos || plainPos === -1, 'PRD should rank before plain entry');
  });
});

test('ADR entry ranked above plain entry with same keyword', () => {
  withTmpDir((dir) => {
    // pageMap searches pages/ and projects/ subdirs; put both files there
    mkdirSync(join(dir, 'pages', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'decisions', '0001-use-bm25.md'), '# ADR\n');
    writeFileSync(join(dir, 'pages', 'bm25-notes.md'), '# BM25 Notes\n');
    const indexContent = [
      '# Index',
      '- [[decisions/0001-use-bm25]] — bm25 scoring decision adr',
      '- [[bm25-notes]] — bm25 scoring general notes',
    ].join('\n');
    writeFileSync(join(dir, 'index.md'), indexContent);
    const r = runHook('hypo-lookup.mjs', { prompt: 'bm25 scoring' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    const adrPos = ctx.indexOf('decisions/0001-use-bm25');
    const plainPos = ctx.indexOf('bm25-notes');
    assert.ok(adrPos !== -1, 'ADR entry should appear in context');
    assert.ok(adrPos < plainPos || plainPos === -1, 'ADR should rank before plain entry');
  });
});

// ── A2: STALE marker at lookup injection ─────────────────────────────────────
suite('hypo-lookup.mjs — STALE marker at injection (A2)');

function stalePageVault(dir, verifyByDateLine) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  const fm = ['---', 'type: page', 'title: Overdue Notes', verifyByDateLine, '---']
    .filter(Boolean)
    .join('\n');
  writeFileSync(
    join(dir, 'pages', 'freshness-notes.md'),
    `${fm}\n# body about widget calibration\n`,
  );
  writeFileSync(
    join(dir, 'index.md'),
    ['# Index', '- [[freshness-notes]] — widget calibration freshness notes'].join('\n'),
  );
}

test('overdue verify_by_date page gets STALE marker injected', () => {
  withTmpDir((dir) => {
    stalePageVault(dir, 'verify_by_date: 2020-01-01');
    const r = runHook('hypo-lookup.mjs', { prompt: 'widget calibration' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    assert.ok(ctx.includes('freshness-notes'), `page should be a HIT: ${ctx}`);
    assert.ok(
      ctx.includes('[STALE verify_by_date=2020-01-01]'),
      `expected STALE marker in injection: ${ctx}`,
    );
  });
});

test('future verify_by_date page gets no STALE marker', () => {
  withTmpDir((dir) => {
    stalePageVault(dir, 'verify_by_date: 2099-01-01');
    const r = runHook('hypo-lookup.mjs', { prompt: 'widget calibration' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    assert.ok(ctx.includes('freshness-notes'), `page should be a HIT: ${ctx}`);
    assert.ok(!/\[STALE/.test(ctx), `future date must not be STALE: ${ctx}`);
  });
});

test('legacy date in verify_by (not verify_by_date) gets no STALE marker', () => {
  withTmpDir((dir) => {
    // verify_by holds the question, never a date (D1). A date parked there must
    // not trigger STALE at injection.
    stalePageVault(dir, 'verify_by: 2020-01-01');
    const r = runHook('hypo-lookup.mjs', { prompt: 'widget calibration' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    assert.ok(ctx.includes('freshness-notes'), `page should be a HIT: ${ctx}`);
    assert.ok(!/\[STALE/.test(ctx), `verify_by date must not be STALE: ${ctx}`);
  });
});

// ── B2: page-usage logging at lookup injection ───────────────────────────────
suite('hypo-lookup.mjs — page-usage logging at injection (B2)');

function usageVault(dir, { git = true, gitignore = true, hypoignore = true } = {}) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(
    join(dir, 'pages', 'freshness-notes.md'),
    '---\ntype: page\ntitle: Notes\n---\n# body about widget calibration\n',
  );
  writeFileSync(
    join(dir, 'index.md'),
    ['# Index', '- [[freshness-notes]] — widget calibration freshness notes'].join('\n'),
  );
  if (git) {
    const opts = { cwd: dir, encoding: 'utf-8' };
    spawnSync('git', ['init', '-q'], opts);
    spawnSync('git', ['config', 'user.email', 't@t.test'], opts);
    spawnSync('git', ['config', 'user.name', 'test'], opts);
  }
  if (gitignore) writeFileSync(join(dir, '.gitignore'), '.cache/\n');
  if (hypoignore) writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
}

test('HIT in a guard-passing vault appends a well-formed page-usage record', () => {
  withTmpDir((dir) => {
    usageVault(dir);
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'widget calibration', session_id: 'b2-hit' },
      { HYPO_DIR: dir },
    );
    const out = JSON.parse(r.stdout);
    assert.ok((out.additionalContext ?? '').includes('freshness-notes'), 'expected HIT');
    const logPath = join(dir, '.cache', 'page-usage.jsonl');
    assert.ok(existsSync(logPath), 'page-usage.jsonl must be written on guarded HIT');
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1]);
    assert.equal(rec.slug, 'freshness-notes');
    assert.equal(rec.source, 'lookup');
    assert.equal(rec.session_id, 'b2-hit');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(rec.ts), `ts must be ISO: ${rec.ts}`);
  });
});

test('fail-closed logging: no coverage → no log, injection still succeeds', () => {
  withTmpDir((dir) => {
    // git repo but .gitignore does NOT cover .cache/ → guard denies logging.
    usageVault(dir, { gitignore: false });
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'widget calibration', session_id: 'b2-closed' },
      { HYPO_DIR: dir },
    );
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    assert.ok(
      (out.additionalContext ?? '').includes('freshness-notes'),
      'injection must still work',
    );
    assert.ok(
      !existsSync(join(dir, '.cache', 'page-usage.jsonl')),
      'no log may be written without commit coverage',
    );
  });
});

test('fail-open injection: append failure does not break the HIT', () => {
  withTmpDir((dir) => {
    usageVault(dir);
    // Make the append target a directory so appendFileSync throws (EISDIR).
    mkdirSync(join(dir, '.cache', 'page-usage.jsonl'), { recursive: true });
    const r = runHook(
      'hypo-lookup.mjs',
      { prompt: 'widget calibration', session_id: 'b2-open' },
      { HYPO_DIR: dir },
    );
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    assert.ok(
      (out.additionalContext ?? '').includes('freshness-notes'),
      'injection must survive a logging failure',
    );
  });
});

// ── B3: read-only page-usage aggregation (cold-start guard) ──────────────────
suite('page-usage.mjs — cold-candidate aggregation (B3)');

const B3_NOW = Date.parse('2026-07-04T00:00:00Z');

const B3_DAY = 86400000;

function coldVault(dir, logLines) {
  mkdirSync(join(dir, 'pages', 'learnings'), { recursive: true });
  // hub links out to a nested page (bare/prefix mismatch) and a flat page.
  writeFileSync(
    join(dir, 'pages', 'hub.md'),
    '---\ntype: page\ntitle: Hub\n---\n# Hub\n[[cold-page]] and [[learnings/warm-page]]\n',
  );
  writeFileSync(join(dir, 'pages', 'cold-page.md'), '---\ntype: page\ntitle: Cold\n---\n# Cold\n');
  writeFileSync(
    join(dir, 'pages', 'learnings', 'warm-page.md'),
    '---\ntype: page\ntitle: Warm\n---\n# Warm\n',
  );
  mkdirSync(join(dir, '.cache'), { recursive: true });
  writeFileSync(join(dir, '.cache', 'page-usage.jsonl'), logLines.join('\n') + '\n');
}

test('readPageUsage skips malformed lines, keeps valid records', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'page-usage.jsonl'),
      [
        '{"ts":"2026-07-01T00:00:00Z","slug":"a","source":"lookup"}',
        'not json',
        '',
        '{"slug":"b"}',
      ].join('\n') + '\n',
    );
    const recs = readPageUsage(dir);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].slug, 'a');
  });
});

test('readPageUsage drops non-object JSON values (null/number/array)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'page-usage.jsonl'),
      ['null', '42', '["x"]', '{"slug":"ok","ts":"2026-07-01T00:00:00Z"}'].join('\n') + '\n',
    );
    const recs = readPageUsage(dir);
    assert.equal(recs.length, 1, 'only the object record survives');
    assert.equal(recs[0].slug, 'ok');
  });
});

test('aggregateColdCandidates does not crash on a poisoned null record', () => {
  withTmpDir((dir) => {
    coldVault(dir, [
      'null',
      JSON.stringify({
        ts: new Date(B3_NOW - 20 * B3_DAY).toISOString(),
        slug: 'hub',
        source: 'lookup',
      }),
      JSON.stringify({
        ts: new Date(B3_NOW - 1 * B3_DAY).toISOString(),
        slug: 'warm-page',
        source: 'lookup',
      }),
    ]);
    const out = aggregateColdCandidates(dir, { now: B3_NOW });
    assert.equal(out.status, 'ok', 'a null line must be skipped, not crash aggregation');
  });
});

test('insufficient-data when the observed log span is under minLogSpanDays', () => {
  withTmpDir((dir) => {
    coldVault(dir, [
      JSON.stringify({
        ts: new Date(B3_NOW - 2 * B3_DAY).toISOString(),
        slug: 'hub',
        source: 'lookup',
      }),
      JSON.stringify({
        ts: new Date(B3_NOW - 1 * B3_DAY).toISOString(),
        slug: 'warm-page',
        source: 'lookup',
      }),
    ]);
    const out = aggregateColdCandidates(dir, { now: B3_NOW });
    assert.equal(out.status, 'insufficient-data');
  });
});

test('ok: inbound-but-unlogged page is a candidate, recently-logged is not', () => {
  withTmpDir((dir) => {
    coldVault(dir, [
      // 20-day span clears the 14-day cold-start guard.
      JSON.stringify({
        ts: new Date(B3_NOW - 20 * B3_DAY).toISOString(),
        slug: 'hub',
        source: 'lookup',
      }),
      // Logged as the BARE form 'warm-page' though the page is pages/learnings/warm-page:
      // slugForms normalization must still treat it as logged (excluded).
      JSON.stringify({
        ts: new Date(B3_NOW - 1 * B3_DAY).toISOString(),
        slug: 'warm-page',
        source: 'lookup',
      }),
    ]);
    const out = aggregateColdCandidates(dir, { now: B3_NOW });
    assert.equal(out.status, 'ok');
    const slugs = out.candidates.map((c) => c.slug);
    // slug is the hypoDir-relative path (pages/...), matching crystallize's convention.
    assert.ok(slugs.includes('pages/cold-page'), `cold-page must be a candidate: ${slugs}`);
    assert.ok(
      !slugs.some((s) => s.endsWith('warm-page')),
      `recently-logged warm-page must be excluded (slugForms normalization): ${slugs}`,
    );
    assert.ok(
      !slugs.some((s) => s.endsWith('hub')),
      `hub has no inbound link, must be excluded: ${slugs}`,
    );
  });
});

// ── B4: crystallize surfaces cold candidates (advisory, non-gating) ──────────
suite('crystallize.mjs — lookup-cold advisory (B4)');

test('scan surfaces cold candidates and exits 0', () => {
  withTmpDir((dir) => {
    const now = Date.now();
    coldVault(dir, [
      JSON.stringify({
        ts: new Date(now - 20 * B3_DAY).toISOString(),
        slug: 'hub',
        source: 'lookup',
      }),
      JSON.stringify({
        ts: new Date(now - 1 * B3_DAY).toISOString(),
        slug: 'warm-page',
        source: 'lookup',
      }),
    ]);
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`]);
    assert.equal(r.status, 0, `scan must stay non-blocking: ${r.stderr}`);
    assert.ok(/Lookup-cold pages/.test(r.stdout), `expected advisory section: ${r.stdout}`);
    assert.ok(/cold-page/.test(r.stdout), `expected cold-page candidate: ${r.stdout}`);
  });
});

test('--json carries coldCandidates status=ok with the candidate', () => {
  withTmpDir((dir) => {
    const now = Date.now();
    coldVault(dir, [
      JSON.stringify({
        ts: new Date(now - 20 * B3_DAY).toISOString(),
        slug: 'hub',
        source: 'lookup',
      }),
      JSON.stringify({
        ts: new Date(now - 1 * B3_DAY).toISOString(),
        slug: 'warm-page',
        source: 'lookup',
      }),
    ]);
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.coldCandidates.status, 'ok');
    assert.ok(
      out.coldCandidates.candidates.some((c) => c.slug === 'pages/cold-page'),
      `expected cold-page in json: ${r.stdout}`,
    );
  });
});

test('cold-start vault shows held advisory, still exits 0', () => {
  withTmpDir((dir) => {
    const now = Date.now();
    coldVault(dir, [
      JSON.stringify({
        ts: new Date(now - 2 * B3_DAY).toISOString(),
        slug: 'hub',
        source: 'lookup',
      }),
      JSON.stringify({
        ts: new Date(now - 1 * B3_DAY).toISOString(),
        slug: 'warm-page',
        source: 'lookup',
      }),
    ]);
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`]);
    assert.equal(r.status, 0);
    assert.ok(/held/.test(r.stdout), `expected held advisory: ${r.stdout}`);
    const rj = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']);
    assert.equal(JSON.parse(rj.stdout).coldCandidates.status, 'insufficient-data');
  });
});

test('vault with no page-usage log stays silent (no held noise)', () => {
  withTmpDir((dir) => {
    // No .cache/page-usage.jsonl at all (every current vault). The held advisory
    // must NOT print, or it becomes permanent noise on every crystallize run.
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'p.md'), '---\ntype: page\ntitle: P\n---\n# P\n');
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`]);
    assert.equal(r.status, 0);
    assert.ok(!/Lookup-cold scan held/.test(r.stdout), `no-log vault must be silent: ${r.stdout}`);
    const rj = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--json']);
    assert.equal(JSON.parse(rj.stdout).coldCandidates.status, 'insufficient-data');
  });
});
