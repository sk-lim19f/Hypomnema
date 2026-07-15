// tests/audit-report.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, suite } from './harness.mjs';
import { run, runStop, runWithHome, withGrowthWiki, withTmpDir, withTmpHome } from './helpers.mjs';

// ── weekly-report.mjs (Lane E) ───────────────────────────────────────────────

suite('weekly-report.mjs');

test('--write produces journal/weekly/<YYYY-Www>.md with autonomy score', () => {
  withTmpDir((dir) => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    const transcriptPath = join(cacheDir, 'w.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n');
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'w1',
        transcript_path: transcriptPath,
        recorded_at: '2026-05-06T12:00:00Z',
        cwd: dir,
      }) + '\n',
    );
    mkdirSync(join(dir, 'pages'), { recursive: true });

    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-W19', '--write']);
    assert.equal(r.status, 0, `weekly-report failed: ${r.stderr}\nstdout: ${r.stdout}`);

    const reportPath = join(dir, 'journal', 'weekly', '2026-W19.md');
    assert.ok(existsSync(reportPath), `report file not written: ${reportPath}`);
    const content = readFileSync(reportPath, 'utf-8');
    assert.ok(content.includes('Autonomy score'), 'report missing autonomy score header');
    assert.ok(content.includes('| w1 |'), 'report should list session w1');
    assert.ok(/^---\n[\s\S]*?\n---\n/.test(content), 'report missing frontmatter');
  });
});

test('weekly heuristic wikilink only emitted when _index page exists', () => {
  withTmpDir((dir) => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    const transcriptPath = join(cacheDir, 'w.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n');
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'w1',
        transcript_path: transcriptPath,
        recorded_at: '2026-05-06T12:00:00Z',
        cwd: dir,
      }) + '\n',
    );

    // (a) target page absent → plain-text fallback, no broken wikilink
    let r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-W19']);
    assert.equal(r.status, 0, `weekly-report failed: ${r.stderr}`);
    assert.ok(
      !r.stdout.includes('[[pages/observability/_index]]'),
      'absent target must not emit a wikilink',
    );
    assert.ok(
      r.stdout.includes('`pages/observability/_index.md` (not present in this vault)'),
      'absent target should fall back to plain text',
    );

    // (b) target page present → wikilink restored
    mkdirSync(join(dir, 'pages', 'observability'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'observability', '_index.md'), '# index\n');
    r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-W19']);
    assert.equal(r.status, 0, `weekly-report failed: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('[[pages/observability/_index]]'),
      'present target should emit the wikilink',
    );
  });
});

test('autonomy score: clamped to 100 with ingest-heavy session', () => {
  withTmpDir((dir) => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    // Single session w/ ingest commands and no URL penalty — numerator should
    // exceed denominator so the clamp kicks in.
    const transcriptPath = join(cacheDir, 'heavy.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ type: 'text', role: 'assistant', content: '/hypo:ingest source-' + i });
    }
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'heavy',
        transcript_path: transcriptPath,
        recorded_at: '2026-05-06T12:00:00Z',
        cwd: dir,
      }) + '\n',
    );
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-W19', '--json']);
    assert.equal(r.status, 0, `weekly-report --json failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.score <= 100, `score must be clamped to 100, got ${out.score}`);
    assert.ok(out.score >= 0, `score must be ≥0, got ${out.score}`);
    assert.equal(out.count, 1);
  });
});

test('autonomy score: 0 when only staleness-skip sessions are in the week', () => {
  withTmpDir((dir) => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    const transcriptPath = join(cacheDir, 'old.jsonl');
    writeFileSync(transcriptPath, JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n');
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'old',
        transcript_path: transcriptPath,
        // Way in the past, but we ask for that exact week so the session
        // matches the filter; the audit's maxAgeDays=365 from buildReport
        // will mark it staleness-skip, which autonomyScore must ignore.
        recorded_at: '2020-01-06T12:00:00Z',
        cwd: dir,
      }) + '\n',
    );
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2020-W02', '--json']);
    assert.equal(r.status, 0, `weekly-report --json failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    // The session matched the week but should be staleness-skipped, so the
    // score numerator/denominator both stay 0 → score is 0.
    assert.equal(out.score, 0, `expected 0 score for staleness-only week, got ${out.score}`);
  });
});

test('--json returns valid report payload (week with no matching sessions)', () => {
  withTmpDir((dir) => {
    // Seed an index entry far in the past so the fallback (~/.claude/projects)
    // path is bypassed by the primary index check, and then ask for a
    // present-day week where nothing in the index will match.
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    const transcriptPath = join(cacheDir, 'old.jsonl');
    writeFileSync(transcriptPath, '');
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'old-1',
        transcript_path: transcriptPath,
        recorded_at: '1970-01-05T00:00:00Z',
        cwd: dir,
      }) + '\n',
    );

    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2099-W50', '--json']);
    assert.equal(r.status, 0, `weekly-report --json failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.week, '2099-W50');
    assert.equal(out.count, 0, `expected 0 sessions in 2099-W50, got ${out.count}`);
    assert.equal(typeof out.score, 'number');
  });
});

// ── session-audit.mjs fixtures ───────────────────────────────────────────────

suite('session-audit.mjs (transcript dual-source — ADR 0019)');

function setupAuditFixture(hypoDir, { transcriptLines, recordedAtIso }) {
  const cacheDir = join(hypoDir, '.cache', 'sessions');
  mkdirSync(cacheDir, { recursive: true });
  const transcriptPath = join(cacheDir, 'fixture-transcript.jsonl');
  writeFileSync(transcriptPath, transcriptLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const indexEntry = {
    session_id: 'fixture-session',
    transcript_path: transcriptPath,
    recorded_at: recordedAtIso,
    cwd: hypoDir,
  };
  writeFileSync(join(cacheDir, 'index.jsonl'), JSON.stringify(indexEntry) + '\n');
}

function runAudit(hypoDir) {
  const r = run('session-audit.mjs', [`--hypo-dir=${hypoDir}`, '--json']);
  assert.equal(r.status, 0, `audit failed: ${r.stderr}\nstdout: ${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.results.length, 1, `expected exactly one session, got ${out.results.length}`);
  return out.results[0];
}

const RECENT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

const STALE = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

test('fixture: normal — exactly one search, no urls, no ingest', () => {
  withTmpDir((dir) => {
    setupAuditFixture(dir, {
      recordedAtIso: RECENT,
      transcriptLines: [
        { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
        { type: 'text', role: 'assistant', content: 'looked it up.' },
      ],
    });
    const r = runAudit(dir);
    assert.equal(r.classification, 'normal');
    assert.equal(r.metrics.search_count, 1);
    assert.equal(r.metrics.ingest_count, 0);
    assert.equal(r.metrics.urls, 0);
  });
});

test('fixture: search-0 — zero search or query in session', () => {
  withTmpDir((dir) => {
    setupAuditFixture(dir, {
      recordedAtIso: RECENT,
      transcriptLines: [
        { type: 'text', role: 'user', content: 'hi' },
        { type: 'text', role: 'assistant', content: 'hello' },
      ],
    });
    const r = runAudit(dir);
    assert.equal(r.classification, 'search-0');
    assert.equal(r.metrics.search_count, 0);
  });
});

test('fixture: search-many — five or more searches → search-many', () => {
  withTmpDir((dir) => {
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push({ type: 'tool_use', name: 'Grep', input: { pattern: `q${i}` } });
    }
    setupAuditFixture(dir, { recordedAtIso: RECENT, transcriptLines: lines });
    const r = runAudit(dir);
    assert.equal(r.classification, 'search-many');
    assert.ok(r.metrics.search_count >= 5, `expected ≥5 searches, got ${r.metrics.search_count}`);
  });
});

test('fixture: ingest-missed — multiple urls in transcript but no ingest call', () => {
  withTmpDir((dir) => {
    setupAuditFixture(dir, {
      recordedAtIso: RECENT,
      transcriptLines: [
        {
          type: 'text',
          role: 'user',
          content: 'check https://example.com/a and https://example.com/b',
        },
        { type: 'text', role: 'assistant', content: 'done' },
      ],
    });
    const r = runAudit(dir);
    assert.equal(r.classification, 'ingest-missed');
    assert.ok(r.metrics.urls >= 2);
    assert.equal(r.metrics.ingest_count, 0);
  });
});

test('fixture: staleness-skip — session older than --max-age-days is staleness-skip', () => {
  withTmpDir((dir) => {
    setupAuditFixture(dir, {
      recordedAtIso: STALE,
      transcriptLines: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'old' } }],
    });
    const r = runAudit(dir);
    assert.equal(r.classification, 'staleness-skip');
    assert.ok(r.age_days > 30, `expected age > 30 days, got ${r.age_days}`);
  });
});

test('fallback: empty index falls back to ~/.claude/projects scan path', () => {
  withTmpDir((dir) => {
    // Index path is absent → loader uses fallback. We can't easily seed
    // ~/.claude/projects from a tmp HOME without running the script with
    // HOME override, so this test asserts the loader's graceful empty path.
    const r = run('session-audit.mjs', [`--hypo-dir=${dir}`, '--json']);
    assert.equal(r.status, 0, `audit failed on empty index: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.results), 'results should be an array even with no index');
  });
});

test('fixture: nested tool_use in message.content[] is counted (real transcript shape)', () => {
  withTmpDir((dir) => {
    setupAuditFixture(dir, {
      recordedAtIso: RECENT,
      transcriptLines: [
        // Real Claude Code transcript shape: tool_use lives inside
        // message.content[], top-level has no type/name field.
        {
          parentUuid: 'a',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } }],
          },
        },
        {
          parentUuid: 'b',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 't2',
                name: 'WebFetch',
                input: { url: 'https://example.com' },
              },
            ],
          },
        },
      ],
    });
    const r = runAudit(dir);
    assert.equal(
      r.metrics.search_count,
      2,
      `expected search_count=2 for two nested tool_use blocks, got ${r.metrics.search_count}`,
    );
  });
});

suite('session-audit.mjs — fallback scope');

test('fallback scope: unrelated ~/.claude/projects subdirs are skipped by default', () => {
  withTmpDir((dir) => {
    withTmpHome((home) => {
      // Seed two unrelated encoded project dirs — neither matches `dir`.
      const unrelated1 = join(home, '.claude', 'projects', '-other-project-a');
      const unrelated2 = join(home, '.claude', 'projects', '-other-project-b');
      mkdirSync(unrelated1, { recursive: true });
      mkdirSync(unrelated2, { recursive: true });
      writeFileSync(
        join(unrelated1, 'sess-x.jsonl'),
        JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n',
      );
      writeFileSync(
        join(unrelated2, 'sess-y.jsonl'),
        JSON.stringify({ type: 'tool_use', name: 'WebFetch' }) + '\n',
      );
      const r = runWithHome('session-audit.mjs', [`--hypo-dir=${dir}`, '--json'], home);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.count,
        0,
        `default fallback must skip unrelated dirs, got ${out.count} sessions`,
      );
    });
  });
});

test('fallback scope: --fallback-all-projects opts in to full scan', () => {
  withTmpDir((dir) => {
    withTmpHome((home) => {
      const other = join(home, '.claude', 'projects', '-some-other');
      mkdirSync(other, { recursive: true });
      writeFileSync(
        join(other, 'sess-z.jsonl'),
        JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n',
      );
      const r = runWithHome(
        'session-audit.mjs',
        [`--hypo-dir=${dir}`, '--fallback-all-projects', '--json'],
        home,
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.count >= 1,
        `expected ≥1 session with --fallback-all-projects, got ${out.count}`,
      );
    });
  });
});

suite('weekly-report.mjs — privacy contract');

test('weekly report does not leak transcript text, URLs, or tool inputs', () => {
  withTmpDir((dir) => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    const SECRET_URL = 'https://internal.example.com/super-secret-path';
    const SECRET_TEXT = 'PRIVATE_TRANSCRIPT_BODY_DO_NOT_LEAK';
    const SECRET_INPUT = 'SECRET_TOOL_INPUT_DO_NOT_LEAK';
    const SECRET_CMD = 'rm -rf /private/path/that/must/not/leak';
    const transcriptPath = join(cacheDir, 'leaky.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'text',
          role: 'assistant',
          content: `${SECRET_TEXT} ${SECRET_URL}`,
        }),
        JSON.stringify({
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: SECRET_CMD, description: SECRET_INPUT },
              },
            ],
          },
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'leaky-session',
        transcript_path: transcriptPath,
        recorded_at: '2026-05-06T12:00:00Z',
        cwd: dir,
      }) + '\n',
    );
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-W19', '--write']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const reportPath = join(dir, 'journal', 'weekly', '2026-W19.md');
    const report = readFileSync(reportPath, 'utf-8');
    for (const secret of [SECRET_URL, SECRET_TEXT, SECRET_INPUT, SECRET_CMD]) {
      assert.ok(
        !report.includes(secret),
        `weekly report leaked "${secret}" — privacy contract broken`,
      );
    }
    // session_id and aggregate counts are the only per-session signal allowed.
    assert.ok(report.includes('leaky-session'), 'session_id should be present');
  });
});

suite('weekly-report.mjs — --week validation');

test('--week=invalid exits non-zero with a clear error', () => {
  withTmpDir((dir) => {
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=not-a-week', '--json']);
    assert.notEqual(r.status, 0, 'should reject malformed --week');
    assert.ok(r.stderr.includes('invalid --week'), `stderr should explain: ${r.stderr}`);
  });
});

test('--week rejects out-of-range ISO weeks (W00, W54, W53 in 52-week year)', () => {
  withTmpDir((dir) => {
    // 2025 is a 52-week ISO year (Jan 1 = Wed, non-leap) — W53 is invalid.
    for (const bad of ['2025-W00', '2025-W54', '2025-W53']) {
      const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, `--week=${bad}`, '--json']);
      assert.notEqual(r.status, 0, `should reject ${bad}, got status ${r.status}`);
      assert.ok(
        r.stderr.includes('invalid --week'),
        `stderr should explain for ${bad}: ${r.stderr}`,
      );
    }
  });
});

test('--week=YYYY-WW (legacy, no W prefix) is rejected', () => {
  withTmpDir((dir) => {
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-19', '--json']);
    assert.notEqual(r.status, 0, 'legacy YYYY-WW must be rejected');
    assert.ok(r.stderr.includes('invalid --week'), `stderr: ${r.stderr}`);
  });
});

suite('hypo-shared.computeSessionGrowth — pages/projects scope');

test('growth ignores root README.md / hot.md (out of pages/projects scope)', () => {
  withGrowthWiki((dir) => {
    // Touch a top-level scaffolding file. Should NOT count as page growth.
    writeFileSync(join(dir, 'README.md'), '# readme\n');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0);
    assert.ok(
      !r.stderr.includes('[hypo] +'),
      `unexpected growth line for root README: ${r.stderr}`,
    );
  });
});

test('growth ignores wikilinks introduced outside pages/projects', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'real.md'), '# real\n[[other]]\n');
    // A non-Markdown file with a wikilink-shaped string must not be counted.
    writeFileSync(join(dir, 'script.js'), '// see [[noise]] but not a wiki link\n');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0);
    const cache = JSON.parse(
      readFileSync(join(dir, '.cache', 'last-session-growth.json'), 'utf-8'),
    );
    assert.equal(cache.addedPages, 1, 'only the pages/real.md should count');
    assert.equal(cache.newWikilinks, 1, 'wikilink-shaped string in script.js must be ignored');
  });
});
