// tests/query-resume.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveActiveProject } from '../hooks/hypo-shared.mjs';
import { test, suite } from './harness.mjs';
import { HOME, SCRIPTS, SESSION_TMP_HOME, run, withGrowthWiki, withTmpDir } from './helpers.mjs';

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
    // The commented example row is what makes the slug-leak assertion below
    // mean anything: resume.mjs strips HTML comments, so without a comment
    // holding the literal `<slug>` placeholder there is nothing left to leak
    // and the assertion passes for free. The template used to ship these two
    // lines; it no longer does, because root hot.md is now a generated
    // projection. Vaults scaffolded before that change still carry them, so
    // this fixture is the real back-compat input, written out by hand rather
    // than borrowed from whatever the template happens to say today.
    const hotPath = join(hypoDir, 'hot.md');
    // Two things decide whether stripping comments matters at all, and the
    // template's own example row had neither: the link has to be in wikilink
    // brackets, and the date column has to be a real date. `projects/<slug>/hot
    // (wikilink)` with a literal `YYYY-MM-DD` never matched resolveActiveProject's
    // row regex, so stripping it changed nothing and the leak assertion below
    // passed for free. Written the way a hand-kept vault actually writes an
    // example row, it parses, and `<slug>` reaches the output unless the strip
    // runs first.
    const legacyComment =
      '<!-- Row format: | Project Name | 2026-01-02 | [[projects/<slug>/hot]] | -->\n';
    writeFileSync(hotPath, readFileSync(hotPath, 'utf-8') + legacyComment);
    const hot = readFileSync(hotPath, 'utf-8');
    assert.ok(/<!--[\s\S]*?Row format[\s\S]*?-->/.test(hot), 'expected comment in hot.md');
    assert.ok(hot.includes('<slug>'), 'the fixture must carry a slug placeholder to leak');
    const r = run('resume.mjs', [`--hypo-dir=${hypoDir}`]);
    // Checked FIRST, and against the placeholder the fixture actually plants.
    // The earlier form looked for `"slug"`, which the real leak never contains,
    // and it sat behind the message assertion, so with the comment strip turned
    // off the test reddened on the message and this line never ran at all. The
    // property in the test's own name has to be the one that fails.
    assert.ok(
      !r.stdout.includes('<slug>') && !r.stderr.includes('<slug>'),
      `slug placeholder must not leak: stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.equal(
      r.status,
      1,
      `expected exit 1, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.ok(
      r.stderr.includes('no active project found'),
      `expected matrix message in stderr: ${r.stderr}`,
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
    // init no longer ships this file, so the fixture writes the stray one it is about.
    writeFileSync(templateSS, '---\ntitle: session-state\ntype: session-state\n---\n');
    const fooSS = join(hypoDir, 'projects', 'foo', 'session-state.md');
    const fooMtime = statSync(fooSS).mtimeMs;
    const newer = new Date(fooMtime + 5000);
    utimesSync(templateSS, newer, newer);
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir, and this fixture used --no-git-init above.
    // Commit a clean tree here (after the mtime tweak, since git commit does
    // not touch mtimes) so this unrelated _template-fallback test sees no
    // notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir); commit a clean
    // tree here so this unrelated cwd-tie-break test sees no notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir); commit a clean
    // tree here so this unrelated cwd-first-wins test sees no notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir); commit a clean
    // tree here so this unrelated mtime-fallback test sees no notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir); commit a clean
    // tree here so this unrelated project-resolution test sees no notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir); commit a clean
    // tree here so this unrelated project-resolution test sees no notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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
    // Committed to git here, not because a real vault must always be one
    // (init --no-git-init is a supported flag; see the non-git-vault
    // contract test below for what that case actually surfaces), but
    // because the ISSUE-99 foreign-notice check reports "cannot attribute"
    // for a non-repo hypoDir); commit a clean
    // tree here (after the mtime tweak above, since git commit does not touch
    // mtimes) so this unrelated project-resolution test sees no notice.
    spawnSync('git', ['init', '-q'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: hypoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: hypoDir });
    spawnSync('git', ['add', '-A'], { cwd: hypoDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: hypoDir });
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

// ── resume.mjs — foreign-project uncommitted notice (ISSUE-99) ─────────────
// A different project's own uncommitted work is not this session's to fix.
// resume never receives a session_id, so unlike the SessionStart hook it uses
// the resolved --project as the "own project" boundary instead of an
// accountable-scope from a transcript.

suite('resume.mjs — foreign-project uncommitted notice (ISSUE-99)');

function withTwoProjectResumeWiki(fn) {
  withGrowthWiki((dir) => {
    for (const slug of ['mine', 'theirs']) {
      const pdir = join(dir, 'projects', slug);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(
        join(pdir, 'session-state.md'),
        `---\ntitle: ss — ${slug}\ntype: session-state\nupdated: 2026-06-28\n---\n\n## 다음\n- t\n`,
      );
    }
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'projects'], { cwd: dir });
    fn(dir);
  });
}

function runResume(dir, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${dir}`, '--project=mine', ...extraArgs],
    { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
  );
}

test('resume.mjs: a foreign project surfaces a one-line notice (count + name)', () => {
  withTwoProjectResumeWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'theirs', 'draft.md'), 'uncommitted draft\n');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 현재 프로젝트 외 projects\/theirs 변경 1건이 있습니다\. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오\.\]/,
      `expected foreign notice as the first line, got: ${r.stdout}`,
    );
  });
});

// A live close's lock file and a waiter's staging file are untracked, so they used to show up as
// a second foreign change next to the one real draft.
test('resume.mjs: a foreign lock artifact is not counted as a foreign change', () => {
  withTwoProjectResumeWiki((dir) => {
    const theirs = join(dir, 'projects', 'theirs');
    writeFileSync(join(theirs, 'draft.md'), 'uncommitted draft\n');
    // The two files a close locks inside the tracked tree live in a session-log shard.
    mkdirSync(join(theirs, 'session-log'), { recursive: true });
    writeFileSync(join(theirs, 'session-log', '2026-01-01.md.lock'), '');
    writeFileSync(join(theirs, 'session-log', '2026-01-01.md.lock.0123456789abcdef.tmp'), '');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 현재 프로젝트 외 projects\/theirs 변경 1건이 있습니다\./,
      `only the draft counts, got: ${r.stdout}`,
    );
  });
});

// Only the files a close locks are artifacts: a person's untracked `.lock` file counts.
test("resume.mjs: a person's untracked .lock file is counted as a foreign change", () => {
  withTwoProjectResumeWiki((dir) => {
    const theirs = join(dir, 'projects', 'theirs');
    writeFileSync(join(theirs, 'draft.md'), 'uncommitted draft\n');
    writeFileSync(join(theirs, 'draft.md.lock'), 'mine\n');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 현재 프로젝트 외 projects\/theirs 변경 2건이 있습니다\./,
      `both files count, got: ${r.stdout}`,
    );
  });
});

// The lock-artifact filter covers untracked records only: a tracked file that happens to end in
// `.lock` and is edited is a person's work.
test('resume.mjs: a tracked foreign .lock file that was edited is counted as a foreign change', () => {
  withTwoProjectResumeWiki((dir) => {
    const rel = join('projects', 'theirs', 'draft.md.lock');
    writeFileSync(join(dir, rel), 'tracked on purpose\n');
    const env = { ...process.env, HOME: SESSION_TMP_HOME };
    spawnSync('git', ['add', '-f', rel], { cwd: dir, env });
    spawnSync('git', ['commit', '-q', '-m', 'track a lock-named file'], { cwd: dir, env });
    writeFileSync(join(dir, rel), 'edited by a person\n');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 현재 프로젝트 외 projects\/theirs 변경 1건이 있습니다\./,
      `the tracked edit counts, got: ${r.stdout}`,
    );
  });
});

test('resume.mjs: own-project changes are excluded from the foreign count', () => {
  withTwoProjectResumeWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'mine', 'draft.md'), 'my own uncommitted work\n');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.ok(
      !/\[WIKI: 현재 프로젝트 외|\[WIKI: 귀속 불명/.test(r.stdout),
      `own uncommitted change must not read as foreign or unattributed: ${r.stdout}`,
    );
  });
});

test('resume.mjs --json: foreign notice carried as a notice field, absent when clean', () => {
  withTwoProjectResumeWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'theirs', 'draft.md'), 'uncommitted draft\n');
    const dirty = runResume(dir, ['--json']);
    assert.equal(dirty.status, 0, `expected exit 0; stderr=${dirty.stderr}`);
    const dirtyOut = JSON.parse(dirty.stdout);
    assert.match(
      dirtyOut.notice,
      /현재 프로젝트 외 projects\/theirs 변경 1건이 있습니다/,
      `expected notice field, got: ${JSON.stringify(dirtyOut)}`,
    );

    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'settle'], { cwd: dir });
    const clean = runResume(dir, ['--json']);
    assert.equal(clean.status, 0, `expected exit 0; stderr=${clean.stderr}`);
    const cleanOut = JSON.parse(clean.stdout);
    assert.ok(
      !('notice' in cleanOut),
      `clean vault must carry no notice field: ${JSON.stringify(cleanOut)}`,
    );
  });
});

// Reproduces the 2026-08-27 incident directly (extensions/ai-tone/, not a
// projects/<slug>/ path) via the resume.mjs CLI: before this fix
// projectOfPath's null return meant "not one project's work" and got
// dropped; now it feeds a nameless unattributed count instead.
test('resume.mjs: an extensions/ai-tone dirty file surfaces as unattributed, not silence', () => {
  withTwoProjectResumeWiki((dir) => {
    const toneDir = join(dir, 'extensions', 'ai-tone');
    mkdirSync(toneDir, { recursive: true });
    writeFileSync(join(toneDir, 'x.sh'), '#!/bin/sh\necho hi\n');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 귀속 불명 변경 1건이 있습니다\. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오\.\]/,
      `expected the original-incident file to surface as unattributed, got: ${r.stdout}`,
    );
  });
});

test('resume.mjs: git enumeration failure (not a git repo) yields a distinct notice, not silence', () => {
  const notARepo = mkdtempSync(join(tmpdir(), 'hypo-issue99-resume-notrepo-'));
  const pdir = join(notARepo, 'projects', 'mine');
  mkdirSync(pdir, { recursive: true });
  writeFileSync(
    join(pdir, 'session-state.md'),
    '---\ntitle: ss — mine\ntype: session-state\nupdated: 2026-06-28\n---\n\n## 다음\n- t\n',
  );
  try {
    const r = runResume(notARepo);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 미커밋 변경의 귀속을 확인하지 못했습니다\. git 상태를 근거로 작업 범위를 정하지 마십시오\.\]/,
      `expected a distinct enumeration-failure notice instead of silence, got: ${r.stdout}`,
    );
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

// codex 3rd-round review: `listDirtyPaths` used to skip a rename/copy's
// paired `from` record entirely, keeping only the destination path. A rename
// OUT of a foreign project and INTO ownProject then vanished completely: the
// destination reads as "own" and gets excluded, and the origin (the one path
// that WAS actually foreign) was never looked at.
test('resume.mjs: a rename OUT of a foreign project (into own) is not silently lost (codex 3rd-round review)', () => {
  withTwoProjectResumeWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'theirs', 'a.md'), 'seed\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
    spawnSync('git', ['mv', 'projects/theirs/a.md', 'projects/mine/a.md'], { cwd: dir });
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 현재 프로젝트 외 projects\/theirs 변경 1건이 있습니다\. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오\.\]/,
      `a rename OUT of a foreign project must still surface theirs, got: ${r.stdout}`,
    );
  });
});

// A leading space (or other control char) right above the vault is a valid
// path segment. `--show-prefix`'s output must only lose its trailing `\n`,
// never a leading byte that is actually part of the path. trim() strips both
// ends and would silently break every startsWith(prefix) match below it.
test('resume.mjs: a leading-space path component above the vault does not silence the notice (prefix trimEnd)', () => {
  const base = mkdtempSync(join(tmpdir(), 'hypo-issue99-resume-prefixspace-'));
  try {
    const vault = join(base, ' weird', 'vault');
    mkdirSync(join(vault, 'projects', 'mine'), { recursive: true });
    writeFileSync(
      join(vault, 'projects', 'mine', 'session-state.md'),
      '---\ntitle: ss — mine\ntype: session-state\nupdated: 2026-06-28\n---\n\n## 다음\n- t\n',
    );
    const theirsDir = join(vault, 'projects', 'theirs');
    mkdirSync(theirsDir, { recursive: true });
    writeFileSync(join(theirsDir, 'index.md'), '# theirs\n');
    spawnSync('git', ['init', '-q'], { cwd: base });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: base });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: base });
    spawnSync('git', ['add', '-A'], { cwd: base });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: base });
    writeFileSync(join(theirsDir, 'draft.md'), 'uncommitted draft\n');
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${vault}`, '--project=mine'],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 현재 프로젝트 외 projects\/theirs 변경 1건이 있습니다\. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오\.\]/,
      `expected the foreign notice despite the leading-space path component, got: ${r.stdout}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// A project directory name with a REAL embedded newline (shell command
// substitution swallows a trailing \n, so this must be built directly with
// mkdirSync, never `$(printf '\n')`). Without sanitizeProjForPrompt this
// splits the one-line notice into two printed lines, which is the injection
// surface the guard exists to close.
test('resume.mjs: a project directory name with a real newline stays a single-line notice (sanitizeProjForPrompt regression)', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'projects', 'mine'), { recursive: true });
    writeFileSync(
      join(dir, 'projects', 'mine', 'session-state.md'),
      '---\ntitle: ss — mine\ntype: session-state\nupdated: 2026-06-28\n---\n\n## 다음\n- t\n',
    );
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'mine'], { cwd: dir });
    const evilSlug = 'ev\nil';
    const evilDir = join(dir, 'projects', evilSlug);
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(evilDir, 'draft.md'), 'uncommitted draft\n');
    const r = runResume(dir);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    const firstLine = r.stdout.split('\n')[0];
    assert.match(
      firstLine,
      /^\[WIKI: 현재 프로젝트 외 projects\/ev il 변경 1건이 있습니다\. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오\.\]$/,
      `expected the whole notice on one line with the embedded newline sanitized, got: ${JSON.stringify(r.stdout)}`,
    );
  });
});

// ISSUE-99 follow-up (codex 2nd-round review): `init --no-git-init` is a
// documented, supported layout (scripts/init.mjs), not an edge case. This
// pins what resume.mjs actually shows on it today: the enumeration-failure
// notice fires on EVERY session for a non-git vault, not only when something
// is genuinely foreign, because `git status` cannot be asked at all. That is
// a deliberate, accepted tradeoff (see the sibling test above for why
// checking `.git` existence instead was tried and reverted: it re-silences a
// vault nested inside a larger host repo). This is not a claim that the
// behavior is right, only that it is current; changing it starts by making
// this assertion red.
test('resume.mjs: init --no-git-init vault reports "cannot attribute" on every session, not silence (documents the accepted tradeoff)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    assert.ok(
      !existsSync(join(hypoDir, '.git')),
      'fixture sanity: --no-git-init must not create .git',
    );
    mkdirSync(join(hypoDir, 'projects', 'mine'), { recursive: true });
    writeFileSync(
      join(hypoDir, 'projects', 'mine', 'session-state.md'),
      '---\ntitle: ss — mine\ntype: session-state\nupdated: 2026-06-28\n---\n\n## 다음\n- t\n',
    );
    const r = run('resume.mjs', [`--hypo-dir=${hypoDir}`, '--project=mine']);
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    assert.match(
      r.stdout,
      /^\[WIKI: 미커밋 변경의 귀속을 확인하지 못했습니다\. git 상태를 근거로 작업 범위를 정하지 마십시오\.\]/,
      `expected the cannot-attribute notice on a supported non-git vault, got: ${r.stdout}`,
    );
  });
});

// ── resume.mjs — renders from session entries ───────────────────────────────

import { closeIdFor, entryFileName, formatSessionEntry } from '../hooks/session-entries.mjs';
import { readObservedHeads } from '../hooks/session-views.mjs';
import { readdirSync } from 'node:fs';

suite('resume.mjs — renders from session entries');

const OLD_STATE_TEXT =
  '---\ntitle: ss — mine\ntype: session-state\nupdated: 2026-06-28\n---\n\n' +
  '## Next\n- OLD_STATE_TASK\n\n## Notes\nOLD_NOTES_TAIL\n';
const OLD_HOT_TEXT =
  '---\ntitle: hot — mine\ntype: reference\nupdated: 2026-06-28\n---\n\nOLD_HOT_BODY\n';

// A git vault that still tracks the old files (not migrated): the old state and hot are what
// resume has to show, as virtual baseline entries.
function withOldFilesVault(fn) {
  withGrowthWiki((dir) => {
    const pdir = join(dir, 'projects', 'mine');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'session-state.md'), OLD_STATE_TEXT);
    writeFileSync(join(pdir, 'hot.md'), OLD_HOT_TEXT);
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'old files'], { cwd: dir });
    fn(dir);
  });
}

function resumeIn(dir, args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'resume.mjs'), `--hypo-dir=${dir}`, ...args], {
    encoding: 'utf-8',
    cwd,
    env: {
      ...process.env,
      HYPO_DIR: dir,
      HOME: SESSION_TMP_HOME,
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      ...env,
    },
  });
}

test('이행 전 resume에 옛 본문', () => {
  withOldFilesVault((dir) => {
    const r = resumeIn(dir, ['--project=mine']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /OLD_STATE_TASK/, `the old session-state body is missing: ${r.stdout}`);
    assert.match(r.stdout, /OLD_HOT_BODY/, `the old hot body is missing: ${r.stdout}`);
    assert.match(r.stdout, /^Next up \(1\):\n- /m, `the summary list is missing: ${r.stdout}`);
  });
});

test('`## Notes`가 든 머리의 요약이 그 절에서 끊기지 않음', () => {
  withOldFilesVault((dir) => {
    const r = resumeIn(dir, ['--project=mine', '--json']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.nextUp.length, 1, r.stdout);
    assert.match(out.nextUp[0].body, /OLD_STATE_TASK/);
    assert.match(out.nextUp[0].body, /## Notes/);
    assert.match(
      out.nextUp[0].body,
      /OLD_NOTES_TAIL/,
      `the summary was cut at the first inner heading: ${JSON.stringify(out.nextUp[0].body)}`,
    );
  });
});

test('resume 뒤 observed heads에 머리 기록', () => {
  withOldFilesVault((dir) => {
    const r = resumeIn(dir, ['--project=mine', '--json', '--session-id=s-resume-obs']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const { nextUp } = JSON.parse(r.stdout);
    assert.equal(nextUp.length, 1, r.stdout);
    const heads = readObservedHeads(dir, 's-resume-obs', 'mine');
    assert.deepEqual(heads.full, { [nextUp[0].trackId]: [nextUp[0].closeId] });
    assert.deepEqual(heads.pointer, {});
  });
});

test('세션 id 가 없으면 observed heads 를 기록하지 않는다', () => {
  withOldFilesVault((dir) => {
    const r = resumeIn(dir, ['--project=mine']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(readObservedHeads(dir, 's-resume-obs', 'mine'), { full: {}, pointer: {} });
    const sessionsDir = join(dir, '.cache', 'sessions');
    const recorded = existsSync(sessionsDir)
      ? readdirSync(sessionsDir).filter((id) =>
          existsSync(join(sessionsDir, id, 'observed-heads.json')),
        )
      : [];
    assert.deepEqual(recorded, [], 'no observed-heads file may be written without a session id');
  });
});

test('세션 id 는 환경 변수 CLAUDE_CODE_SESSION_ID 에서도 읽는다', () => {
  withOldFilesVault((dir) => {
    const r = resumeIn(dir, ['--project=mine'], {
      env: { CLAUDE_CODE_SESSION_ID: 's-resume-env' },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(Object.keys(readObservedHeads(dir, 's-resume-env', 'mine').full).length, 1);
  });
});

// A vault with no `.git` counts as migrated, so only the session entries are on the page.
function writeEntry(dir, project, sessionId, date, { title, body, summary }) {
  const closeId = closeIdFor(sessionId, 0);
  mkdirSync(join(dir, 'projects', project, 'sessions'), { recursive: true });
  writeFileSync(
    join(dir, 'projects', project, 'sessions', entryFileName(date, closeId)),
    formatSessionEntry({
      project,
      closeId,
      date,
      tracks: [{ id: 'main', title, new: true }],
      summary,
      bodies: { main: body },
    }),
  );
  return closeId;
}

function withEntryVault(fn) {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    fn(hypoDir);
  });
}

test('원본 항목의 다음 할 일과 배경이 렌더되고 observed heads 에 그 close id 가 든다', () => {
  withEntryVault((dir) => {
    const closeId = writeEntry(dir, 'p1', 's-entry-1', '2026-09-01', {
      title: 'Main track',
      body: 'ENTRY_NEXT_TASK',
      summary: 'ENTRY_SUMMARY',
    });
    const r = resumeIn(dir, ['--project=p1', '--session-id=s-resume-entry']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /ENTRY_NEXT_TASK/);
    assert.match(r.stdout, /ENTRY_SUMMARY/);
    assert.match(r.stdout, /^- Main track \(2026-09-01\)$/m);
    assert.deepEqual(readObservedHeads(dir, 's-resume-entry', 'p1').full, { main: [closeId] });
  });
});

test('활성 프로젝트 대체는 파일 mtime 이 아니라 최신 원본 date', () => {
  withEntryVault((dir) => {
    writeEntry(dir, 'older', 's-old', '2026-01-01', {
      title: 'Old',
      body: 'OLDER_BODY',
      summary: 's',
    });
    writeEntry(dir, 'newer', 's-new', '2026-03-01', {
      title: 'New',
      body: 'NEWER_BODY',
      summary: 's',
    });
    // The older project's files are the freshest on disk: mtime would pick it.
    const future = new Date('2030-01-01T00:00:00Z');
    for (const f of [
      'sessions',
      `sessions/${entryFileName('2026-01-01', closeIdFor('s-old', 0))}`,
    ]) {
      utimesSync(join(dir, 'projects', 'older', f), future, future);
    }
    const r = resumeIn(dir, [], { cwd: dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^Project: newer$/m, r.stdout);
    assert.match(r.stdout, /NEWER_BODY/);
  });
});
