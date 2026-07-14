// tests/query-resume.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveActiveProject } from '../hooks/hypo-shared.mjs';
import { test, suite } from './harness.mjs';
import { HOME, SCRIPTS, SESSION_TMP_HOME, run, withTmpDir } from './helpers.mjs';

// ── query.mjs smoke tests ────────────────────────────────────────────────────

suite('query.mjs — no-results ingest prompt');

test('no results: shows ingest suggestion', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const r = run('query.mjs', [`--hypo-dir=${dir}`, '--q=xyzzy-nonexistent-term']);
    assert.equal(r.status, 0, `should exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes('/hypo:ingest'), `expected ingest prompt in stdout: ${r.stdout}`);
  });
});

test('no results: ingest prompt absent in --json mode', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const r = run('query.mjs', [`--hypo-dir=${dir}`, '--q=xyzzy-nonexistent-term', '--json']);
    assert.equal(r.status, 0, `should exit 0: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed), 'JSON output should be an array');
    assert.equal(parsed.length, 0, 'should be empty array');
  });
});

test('with results: ingest prompt not shown', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages', 'test-page.md'),
      '---\ntitle: test\ntype: note\n---\nfoo bar baz content here\n',
    );
    const r = run('query.mjs', [`--hypo-dir=${dir}`, '--q=foo']);
    assert.equal(r.status, 0, `should exit 0: ${r.stderr}`);
    assert.ok(
      !r.stdout.includes('/hypo:ingest'),
      `ingest prompt should not appear when results exist: ${r.stdout}`,
    );
  });
});

// ── resume.mjs smoke tests ───────────────────────────────────────────────────

suite('resume.mjs — fresh-init + commented-example hot.md');

test('resume on fresh-init vault: graceful "no active project found" — no slug leak', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    // Sanity: the template comment example IS present in the generated hot.md.
    const hot = readFileSync(join(hypoDir, 'hot.md'), 'utf-8');
    assert.ok(/<!--[\s\S]*?Row format[\s\S]*?-->/.test(hot), 'expected comment in hot.md');
    const r = run('resume.mjs', [`--hypo-dir=${hypoDir}`]);
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('no active project found'),
      `expected matrix message in stderr: ${r.stderr}`,
    );
    assert.ok(
      !r.stdout.includes('slug') && !r.stderr.includes('"slug"'),
      `slug placeholder must not leak: stdout=${r.stdout} stderr=${r.stderr}`,
    );
    // The mtime-fallback branch runs with zero candidate projects here (_template is
    // skipped). warnCwdFallback must stay silent — there is nothing to "fall back to
    // most-recent" toward, so the misleading note must NOT appear alongside the real
    // "no active project found" error.
    assert.ok(
      !/falling back to most-recent/.test(r.stderr),
      `empty-candidate fresh-init must not emit a fallback note: ${JSON.stringify(r.stderr)}`,
    );
  });
});

test('resume picks real project over _template fallback (even when _template is newer)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    // Add a real project alongside the scaffold _template, then make
    // _template's session-state.md NEWER than foo's so mtime alone would pick
    // _template. The explicit skip in resolveActiveProject must override that.
    mkdirSync(join(hypoDir, 'projects', 'foo'), { recursive: true });
    writeFileSync(
      join(hypoDir, 'projects', 'foo', 'session-state.md'),
      '---\ntitle: session-state — foo\ntype: session-state\nupdated: 2026-05-26\n---\n\n## 다음 이어받기\n- task A\n',
    );
    // Touch _template/session-state.md to be 1 second newer than foo's.
    const templateSS = join(hypoDir, 'projects', '_template', 'session-state.md');
    assert.ok(existsSync(templateSS), 'fixture: _template/session-state.md must exist after init');
    const fooSS = join(hypoDir, 'projects', 'foo', 'session-state.md');
    const fooMtime = statSync(fooSS).mtimeMs;
    const newer = new Date(fooMtime + 5000);
    utimesSync(templateSS, newer, newer);
    const r = run('resume.mjs', [`--hypo-dir=${hypoDir}`]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
    assert.ok(r.stdout.startsWith('Project: foo'), `expected 'Project: foo', got: ${r.stdout}`);
  });
});

test('resume strips legacy [[projects/slug/hot]] HTML-comment example (back-compat with pre-fix vaults)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    // Simulate an older installed hot.md that still has the pre-fix wikilink-
    // shaped comment example (the exact form that produced the original leak).
    const legacyHot = `---
title: Hot Cache — Pointer
type: reference
updated: 2026-05-26
tags: [wiki, operations]
---

# Hot Cache

## Active Projects

| Project | Last Session | Hot Cache |
|---|---|---|
<!-- Row format: | Project Name | YYYY-MM-DD | [[projects/slug/hot]] | -->
`;
    writeFileSync(join(hypoDir, 'hot.md'), legacyHot);
    // Also remove _template so the fallback can't mask the parse-result.
    rmSync(join(hypoDir, 'projects', '_template'), { recursive: true, force: true });
    const r = run('resume.mjs', [`--hypo-dir=${hypoDir}`]);
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('no active project found'),
      `expected matrix message in stderr: ${r.stderr}`,
    );
    assert.ok(
      !r.stdout.includes('slug') && !r.stderr.includes('"slug"'),
      `slug placeholder must not leak: stdout=${r.stdout} stderr=${r.stderr}`,
    );
  });
});

// ── ISSUE-1 / ISSUE-12: resolveActiveProject cwd-first project selection ───────
// ISSUE-1 introduced cwd↔working_dir matching as a same-date tie-breaker; ISSUE-12
// (ADR 0044) promoted it to cwd-first — a cwd match wins over recency outright.

suite('resolveActiveProject — cwd-first project selection (ISSUE-1 / ISSUE-12)');

// Build a tmp wiki: root hot.md pointer table + per-project index.md working_dir.
// rows: [{ slug, date, workingDir? }]
function makeTieBreakWiki(wikiDir, rows) {
  mkdirSync(wikiDir, { recursive: true });
  const tableRows = rows.map((r) => `| ${r.slug} | ${r.date} | [[projects/${r.slug}/hot]] |`);
  const hot = `---
title: Hot
type: reference
updated: 2026-06-08
---

## Active Projects

| Project | Last Session | Hot Cache |
|---|---|---|
${tableRows.join('\n')}
`;
  writeFileSync(join(wikiDir, 'hot.md'), hot);
  for (const r of rows) {
    const pdir = join(wikiDir, 'projects', r.slug);
    mkdirSync(pdir, { recursive: true });
    if (r.workingDir) {
      writeFileSync(
        join(pdir, 'index.md'),
        `---\ntitle: ${r.slug}\ntype: project-index\nupdated: 2026-06-08\nworking_dir: "${r.workingDir}"\n---\n# ${r.slug}\n`,
      );
    }
  }
}

test('same-date tie → cwd-matched project wins over table order', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '2026-06-08' }, // table-top, no working_dir
      { slug: 'beta', date: '2026-06-08', workingDir: join(dir, 'code/beta') },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'code/beta')), 'beta');
    // sanity: without cwd, the legacy first-row winner stands
    assert.equal(resolveActiveProject(dir), 'alpha');
  });
});

test('cwd-first (ISSUE-12, ADR 0044): cwd-matched older row wins over a newer non-matching row', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '2026-06-08' },
      { slug: 'beta', date: '2026-06-07', workingDir: join(dir, 'code/beta') },
    ]);
    // ISSUE-12 repro: cwd matches the OLDER beta and a NEWER non-matching alpha
    // exists. Reverses ISSUE-1's tie-breaker-only semantics — beta must now win
    // because the user is physically in it (cwd-first, not recency-first).
    assert.equal(resolveActiveProject(dir, join(dir, 'code/beta')), 'beta');
    // sanity: without cwd, recency still wins (the newer alpha).
    assert.equal(resolveActiveProject(dir), 'alpha');
  });
});

test('cwd-first: a newer non-matching row no longer masks the cwd project (ISSUE-12 exact repro)', () => {
  withTmpDir((dir) => {
    // hypomnema(older, cwd-matched) vs security-ops-kb(newer, absent dir) — the
    // 2026-06-13 incident shape. cwd-first must load the project under the cwd.
    makeTieBreakWiki(dir, [
      { slug: 'security-ops-kb', date: '2026-06-12' }, // newer, no working_dir here
      { slug: 'hypomnema', date: '2026-06-11', workingDir: join(dir, 'repo') },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'repo')), 'hypomnema');
  });
});

test('longest working_dir prefix wins on tie (/repo vs /repo/sub)', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'parent', date: '2026-06-08', workingDir: join(dir, 'repo') },
      { slug: 'child', date: '2026-06-08', workingDir: join(dir, 'repo/sub') },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'repo/sub/x')), 'child');
  });
});

test('cwd null → legacy stable-sort winner (no behavior change)', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '2026-06-08', workingDir: join(dir, 'code/alpha') },
      { slug: 'beta', date: '2026-06-08', workingDir: join(dir, 'code/beta') },
    ]);
    assert.equal(resolveActiveProject(dir), 'alpha');
  });
});

test('cross-machine: synced index.md (other-machine path) matches by unique basename', () => {
  withTmpDir((dir) => {
    // index.md carries another machine's absolute working_dir (the synced-vault
    // case): no absolute prefix matches this machine's cwd, but the repo dirname
    // is a globally-unique project basename, so tier 2 recovers the match.
    makeTieBreakWiki(dir, [
      { slug: 'other', date: '2026-06-09' }, // newer recency winner, no working_dir
      { slug: 'myrepo', date: '2026-06-07', workingDir: '/Users/OTHERMACHINE/ws/myrepo' },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'clones/myrepo')), 'myrepo');
    assert.equal(resolveActiveProject(dir, join(dir, 'clones/myrepo/scripts')), 'myrepo');
    // sanity: without cwd, recency (newer 'other') still wins.
    assert.equal(resolveActiveProject(dir), 'other');
  });
});

test('cross-machine: shared repo basename fails closed → recency wins (no false match)', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'newer', date: '2026-06-09', workingDir: '/Users/A/x/myrepo' },
      { slug: 'older', date: '2026-06-07', workingDir: '/Users/A/y/myrepo' },
    ]);
    // 'myrepo' basename is not unique → tier 2 declines → recency picks 'newer'.
    assert.equal(resolveActiveProject(dir, join(dir, 'z/myrepo')), 'newer');
  });
});

test('working_dir with a trailing YAML comment is stripped before matching', () => {
  withTmpDir((dir) => {
    // The hook-side collectProjectWorkingDirs must clean `working_dir: /repo # note`
    // identically to the script-side parser, or same-machine resume would miss.
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
    writeFileSync(
      join(dir, 'hot.md'),
      `---\ntitle: Hot\ntype: reference\nupdated: 2026-06-08\n---\n\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n| p | 2026-06-08 | [[projects/p/hot]] |\n`,
    );
    writeFileSync(
      join(dir, 'projects', 'p', 'index.md'),
      `---\ntitle: p\ntype: project-index\nupdated: 2026-06-08\nworking_dir: ${join(dir, 'repo')} # synced note\n---\n# p\n`,
    );
    assert.equal(resolveActiveProject(dir, join(dir, 'repo')), 'p');
  });
});

test('cwd matches no project on tie → legacy first row', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '2026-06-08' },
      { slug: 'beta', date: '2026-06-08', workingDir: join(dir, 'code/beta') },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'elsewhere')), 'alpha');
  });
});

test('all rows dateless → cwd still breaks the all-tie group', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '' },
      { slug: 'beta', date: '', workingDir: join(dir, 'code/beta') },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'code/beta')), 'beta');
  });
});

test('sibling-prefix is not a match (/repo does not match cwd /repoX)', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '2026-06-08' },
      { slug: 'beta', date: '2026-06-08', workingDir: join(dir, 'repo') },
    ]);
    // cwd is a sibling dir sharing a string prefix but not a path prefix →
    // must NOT match beta; legacy first row stands.
    assert.equal(resolveActiveProject(dir, join(dir, 'repoX')), 'alpha');
  });
});

test('trailing-slash working_dir is normalized before matching', () => {
  withTmpDir((dir) => {
    makeTieBreakWiki(dir, [
      { slug: 'alpha', date: '2026-06-08' },
      { slug: 'beta', date: '2026-06-08', workingDir: `${join(dir, 'code/beta')}/` },
    ]);
    assert.equal(resolveActiveProject(dir, join(dir, 'code/beta')), 'beta');
  });
});

test('resume.mjs honors process.cwd() for same-date tie (ISSUE-1 wiring)', () => {
  withTmpDir((dir) => {
    // process.cwd() reports the realpath, so the fixture working_dir must use
    // the realpath too (tmpdir is /var → /private/var on macOS).
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    const betaWd = join(realDir, 'code/beta');
    makeTieBreakWiki(hypoDir, [
      { slug: 'alpha', date: '2026-06-08' },
      { slug: 'beta', date: '2026-06-08', workingDir: betaWd },
    ]);
    for (const s of ['alpha', 'beta']) {
      writeFileSync(
        join(hypoDir, 'projects', s, 'session-state.md'),
        `---\ntitle: ss — ${s}\ntype: session-state\nupdated: 2026-06-08\n---\n\n## 다음\n- t\n`,
      );
    }
    const cwd = betaWd;
    mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`], {
      encoding: 'utf-8',
      cwd,
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(r.stdout.startsWith('Project: beta'), `expected 'Project: beta', got: ${r.stdout}`);
  });
});

test('resume.mjs cwd-first: cwd-matched older project wins over a newer non-matching row (ISSUE-12 e2e)', () => {
  withTmpDir((dir) => {
    // End-to-end through the real resume.mjs process: cwd matches the OLDER
    // project, a NEWER non-matching project exists. Pre-ADR-0044 this loaded the
    // newer one (and dead-ended when its working_dir was absent); now cwd wins.
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    const betaWd = join(realDir, 'code/beta');
    makeTieBreakWiki(hypoDir, [
      { slug: 'alpha', date: '2026-06-12' }, // newer, no working_dir → cannot match cwd
      { slug: 'beta', date: '2026-06-11', workingDir: betaWd }, // older, cwd-matched
    ]);
    for (const s of ['alpha', 'beta']) {
      writeFileSync(
        join(hypoDir, 'projects', s, 'session-state.md'),
        `---\ntitle: ss — ${s}\ntype: session-state\nupdated: 2026-06-11\n---\n\n## 다음\n- t\n`,
      );
    }
    mkdirSync(betaWd, { recursive: true });
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`], {
      encoding: 'utf-8',
      cwd: betaWd,
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(r.stdout.startsWith('Project: beta'), `expected 'Project: beta', got: ${r.stdout}`);
    // Negative: a successful cwd match must NOT emit the fallback diagnostic.
    assert.ok(
      !/matched no project working_dir/.test(r.stderr),
      `cwd-matched resume must stay silent on stderr: ${JSON.stringify(r.stderr)}`,
    );
  });
});

test('resume.mjs cwd no-match: emits a stderr fallback diagnostic, --json stdout stays pure (ISSUE-15)', () => {
  withTmpDir((dir) => {
    // cwd is an unrelated repo: NO project's working_dir contains it. alpha (newest)
    // has no index.md at all; beta's working_dir points elsewhere. Pre-fix this fell
    // back to recency SILENTLY — the user couldn't tell why an unrelated project
    // loaded. Now resolveActiveProject emits a one-line stderr note naming the gap.
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    makeTieBreakWiki(hypoDir, [
      { slug: 'alpha', date: '2026-06-12' }, // newest, no working_dir → no index.md
      { slug: 'beta', date: '2026-06-11', workingDir: join(realDir, 'code/beta') },
    ]);
    for (const s of ['alpha', 'beta']) {
      writeFileSync(
        join(hypoDir, 'projects', s, 'session-state.md'),
        `---\ntitle: ss — ${s}\ntype: session-state\nupdated: 2026-06-11\n---\n\n## 다음\n- t\n`,
      );
    }
    const unrelatedCwd = join(realDir, 'code/elsewhere');
    mkdirSync(unrelatedCwd, { recursive: true });
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`, '--json'],
      {
        encoding: 'utf-8',
        cwd: unrelatedCwd,
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    // stdout stays pure JSON (the diagnostic must NOT leak onto stdout) and recency
    // fallback resolves to the newest project, alpha.
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.project,
      'alpha',
      `expected recency fallback to alpha, got: ${JSON.stringify(out.project)}`,
    );
    // stderr carries the diagnostic, naming the candidate that lacks cwd metadata.
    assert.match(
      r.stderr,
      /matched no project working_dir; falling back to most-recent/,
      `expected fallback note on stderr: ${JSON.stringify(r.stderr)}`,
    );
    assert.match(
      r.stderr,
      /alpha \(no index\.md\)/,
      `expected per-candidate reason for alpha: ${JSON.stringify(r.stderr)}`,
    );
  });
});

test('resume.mjs mtime-fallback branch cwd no-match: emits the fallback diagnostic (ISSUE-15)', () => {
  withTmpDir((dir) => {
    // hot.md has NO project rows → resolveActiveProject reaches the mtime fallback,
    // the THIRD warnCwdFallback call site. A real project (gamma) exists with a
    // session-state but no index.md, and cwd is unrelated → it warns yet still
    // resolves gamma by mtime (candidates is non-empty, so the guard lets it speak).
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(
      join(hypoDir, 'hot.md'),
      `---\ntitle: Hot\ntype: reference\nupdated: 2026-06-08\n---\n\n## Active Projects\n\n(none)\n`,
    );
    mkdirSync(join(hypoDir, 'projects', 'gamma'), { recursive: true });
    writeFileSync(
      join(hypoDir, 'projects', 'gamma', 'session-state.md'),
      `---\ntitle: ss — gamma\ntype: session-state\nupdated: 2026-06-08\n---\n\n## 다음\n- t\n`,
    );
    const unrelatedCwd = join(realDir, 'code/elsewhere');
    mkdirSync(unrelatedCwd, { recursive: true });
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`], {
      encoding: 'utf-8',
      cwd: unrelatedCwd,
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(
      r.stdout.startsWith('Project: gamma'),
      `expected mtime fallback to gamma, got: ${r.stdout}`,
    );
    assert.match(
      r.stderr,
      /matched no project working_dir; falling back to most-recent/,
      `expected mtime branch fallback note: ${JSON.stringify(r.stderr)}`,
    );
    assert.match(
      r.stderr,
      /gamma \(no index\.md\)/,
      `expected per-candidate reason for gamma: ${JSON.stringify(r.stderr)}`,
    );
  });
});

test('cwd-first applies to the legacy markdown-link row branch (ADR 0044)', () => {
  withTmpDir((dir) => {
    // No wikilink rows → resolveActiveProject falls to the legacy md-link branch.
    // cwd-first must hold there too (matchAll over all rows, not just the first).
    const hot = `---\ntitle: Hot\ntype: reference\nupdated: 2026-06-08\n---\n
## Active Projects

| Project | Last Session |
|---|---|
| [alpha](projects/alpha/hot.md) | 2026-06-08 |
| [beta](projects/beta/hot.md) | 2026-06-08 |
`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hot.md'), hot);
    for (const s of ['alpha', 'beta']) {
      mkdirSync(join(dir, 'projects', s), { recursive: true });
    }
    writeFileSync(
      join(dir, 'projects', 'beta', 'index.md'),
      `---\ntitle: beta\ntype: project-index\nupdated: 2026-06-08\nworking_dir: "${join(dir, 'code/beta')}"\n---\n# beta\n`,
    );
    // cwd matches beta (the SECOND md-row) → cwd-first picks beta, not the first.
    assert.equal(resolveActiveProject(dir, join(dir, 'code/beta')), 'beta');
    // no cwd → legacy first row stands.
    assert.equal(resolveActiveProject(dir), 'alpha');
  });
});

test('resume.mjs md-link branch cwd no-match: emits the fallback diagnostic (ISSUE-15)', () => {
  withTmpDir((dir) => {
    // Legacy markdown-link rows (no wikilink rows) exercise the SECOND warnCwdFallback
    // call site. cwd is unrelated: alpha has no index.md, beta's working_dir points
    // elsewhere → md-link branch returns the first row (alpha) and warns.
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    const hot = `---\ntitle: Hot\ntype: reference\nupdated: 2026-06-08\n---\n
## Active Projects

| Project | Last Session |
|---|---|
| [alpha](projects/alpha/hot.md) | 2026-06-08 |
| [beta](projects/beta/hot.md) | 2026-06-08 |
`;
    writeFileSync(join(hypoDir, 'hot.md'), hot);
    for (const s of ['alpha', 'beta']) {
      mkdirSync(join(hypoDir, 'projects', s), { recursive: true });
      writeFileSync(
        join(hypoDir, 'projects', s, 'session-state.md'),
        `---\ntitle: ss — ${s}\ntype: session-state\nupdated: 2026-06-08\n---\n\n## 다음\n- t\n`,
      );
    }
    writeFileSync(
      join(hypoDir, 'projects', 'beta', 'index.md'),
      `---\ntitle: beta\ntype: project-index\nupdated: 2026-06-08\nworking_dir: "${join(realDir, 'code/beta')}"\n---\n# beta\n`,
    );
    const unrelatedCwd = join(realDir, 'code/elsewhere');
    mkdirSync(unrelatedCwd, { recursive: true });
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`], {
      encoding: 'utf-8',
      cwd: unrelatedCwd,
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(
      r.stdout.startsWith('Project: alpha'),
      `expected md-link first-row alpha, got: ${r.stdout}`,
    );
    assert.match(
      r.stderr,
      /matched no project working_dir; falling back to most-recent/,
      `expected md-link branch fallback note: ${JSON.stringify(r.stderr)}`,
    );
    assert.match(
      r.stderr,
      /alpha \(no index\.md\)/,
      `expected per-candidate reason for alpha: ${JSON.stringify(r.stderr)}`,
    );
  });
});

test('resume.mjs cwd-first applies to the legacy markdown-link branch (ADR 0044 e2e)', () => {
  withTmpDir((dir) => {
    // resume.mjs keeps its OWN hand-synced copy of the md-row branch, so prove it
    // end-to-end through the actual process (not just the hooks/hypo-shared copy).
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    const betaWd = join(realDir, 'code/beta');
    const hot = `---\ntitle: Hot\ntype: reference\nupdated: 2026-06-08\n---\n
## Active Projects

| Project | Last Session |
|---|---|
| [alpha](projects/alpha/hot.md) | 2026-06-08 |
| [beta](projects/beta/hot.md) | 2026-06-08 |
`;
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(join(hypoDir, 'hot.md'), hot);
    for (const s of ['alpha', 'beta']) {
      mkdirSync(join(hypoDir, 'projects', s), { recursive: true });
      writeFileSync(
        join(hypoDir, 'projects', s, 'session-state.md'),
        `---\ntitle: ss — ${s}\ntype: session-state\nupdated: 2026-06-08\n---\n\n## 다음\n- t\n`,
      );
    }
    writeFileSync(
      join(hypoDir, 'projects', 'beta', 'index.md'),
      `---\ntitle: beta\ntype: project-index\nupdated: 2026-06-08\nworking_dir: "${betaWd}"\n---\n# beta\n`,
    );
    mkdirSync(betaWd, { recursive: true });
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`], {
      encoding: 'utf-8',
      cwd: betaWd,
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(
      r.stdout.startsWith('Project: beta'),
      `md-row cwd-first must hold in resume.mjs; got: ${r.stdout}`,
    );
  });
});

test('resume.mjs cwd-first applies to the mtime fallback (no hot.md rows, ADR 0044)', () => {
  withTmpDir((dir) => {
    // hot.md present but with NO parseable rows → resume.mjs reaches the mtime
    // fallback. A cwd↔working_dir match must beat the newest-mtime project.
    const realDir = realpathSync(dir);
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(
      join(hypoDir, 'hot.md'),
      `---\ntitle: Hot\ntype: reference\nupdated: 2026-06-08\n---\n\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n`,
    );
    const betaWd = join(realDir, 'code/beta');
    for (const s of ['alpha', 'beta']) {
      const pdir = join(hypoDir, 'projects', s);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(
        join(pdir, 'session-state.md'),
        `---\ntitle: ss — ${s}\ntype: session-state\nupdated: 2026-06-08\n---\n\n## 다음\n- t\n`,
      );
    }
    writeFileSync(
      join(hypoDir, 'projects', 'beta', 'index.md'),
      `---\ntitle: beta\ntype: project-index\nupdated: 2026-06-08\nworking_dir: "${betaWd}"\n---\n# beta\n`,
    );
    // Make alpha's session-state NEWER so mtime alone would pick alpha.
    const betaMtime = statSync(join(hypoDir, 'projects', 'beta', 'session-state.md')).mtimeMs;
    const newer = new Date(betaMtime + 5000);
    utimesSync(join(hypoDir, 'projects', 'alpha', 'session-state.md'), newer, newer);
    mkdirSync(betaWd, { recursive: true });
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${hypoDir}`], {
      encoding: 'utf-8',
      cwd: betaWd,
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(
      r.stdout.startsWith('Project: beta'),
      `mtime fallback must honor cwd; got: ${r.stdout}`,
    );
  });
});
