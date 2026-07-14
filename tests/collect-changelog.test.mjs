// tests/collect-changelog.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyChange,
  sanitizeTrackerIds,
  hasTrackerId,
  detectInternalLabels,
  SECTION,
} from '../scripts/lib/changelog-classify.mjs';
import {
  parsePrNumber,
  isMergeBoilerplate,
  parseChangelogBlock,
  normalizeIndexTitle,
  assembleSections,
  renderDraft,
  repoUrlToPrBase,
  prRef,
} from '../scripts/lib/collect-changelog.mjs';
import { test, suite } from './harness.mjs';
import { HOME, REPO, SCRIPTS, SESSION_TMP_HOME, withTmpDir } from './helpers.mjs';

// ── changelog-classify (changelog-pr-guide T2) ───────────────────────────────

suite('changelog-classify (changelog-pr-guide T2)');

test('classifyChange: tracker ID beats Conventional-Commit type', () => {
  // feat(...) typed, but IMPR-/PRAC- tracker → Chores (the real 1.4.0 cases).
  assert.deepEqual(classifyChange('feat(release): version floor gate (IMPR-14) (#138)'), {
    section: SECTION.CHORES,
    basis: 'tracker',
  });
  assert.deepEqual(classifyChange('feat(audit): stamp session_id/device (PRAC-17) (#136)'), {
    section: SECTION.CHORES,
    basis: 'tracker',
  });
  // FEAT- tracker → New Features.
  assert.deepEqual(classifyChange('feat(feedback): add failure_type (FEAT-1) (#141)'), {
    section: SECTION.NEW_FEATURES,
    basis: 'tracker',
  });
  // docs(...) typed, but ISSUE- tracker → Bug Fixes (real 1.3.1 case).
  assert.deepEqual(classifyChange('docs(resume): correct comment (ISSUE-2) (#93)'), {
    section: SECTION.BUG_FIXES,
    basis: 'tracker',
  });
});

test('classifyChange: type when no tracker, Chores fallback otherwise', () => {
  assert.deepEqual(classifyChange('fix(catalog): dedup injection (#133)'), {
    section: SECTION.BUG_FIXES,
    basis: 'type',
  });
  assert.deepEqual(classifyChange('feat(rename): subtree rename (#125)'), {
    section: SECTION.NEW_FEATURES,
    basis: 'type',
  });
  // refactor/docs/ci/chore are all internal → Chores by KIND (format.md §4).
  assert.deepEqual(classifyChange('refactor(lib): extract resolver (#139)'), {
    section: SECTION.CHORES,
    basis: 'type',
  });
  assert.deepEqual(classifyChange('docs(readme): document install paths'), {
    section: SECTION.CHORES,
    basis: 'type',
  });
  // breaking-change bang in the type prefix still parses.
  assert.deepEqual(classifyChange('feat(api)!: drop legacy flag'), {
    section: SECTION.NEW_FEATURES,
    basis: 'type',
  });
  // no tracker, unrecognized/absent type → Chores fallback (flagged as a guess).
  assert.deepEqual(classifyChange('random prose with no prefix'), {
    section: SECTION.CHORES,
    basis: 'fallback',
  });
  assert.deepEqual(classifyChange(''), { section: SECTION.CHORES, basis: 'fallback' });
});

test('classifyChange: legacy heading hint for ID-less, type-less prose (format.md §3 step 3)', () => {
  // a pre-convention `### Added` item with no tracker and no `feat:` prefix
  // maps by its heading, not the Chores default.
  assert.deepEqual(
    classifyChange('add resolveWikiRoot() and OSS utilities', { legacyHeading: '### Added' }),
    {
      section: SECTION.NEW_FEATURES,
      basis: 'heading',
    },
  );
  assert.deepEqual(classifyChange('lint no longer false-flags links', { legacyHeading: 'Fixed' }), {
    section: SECTION.BUG_FIXES,
    basis: 'heading',
  });
  assert.deepEqual(classifyChange('bump deps', { legacyHeading: '### Internal' }), {
    section: SECTION.CHORES,
    basis: 'heading',
  });
  // heading-variant normalization: `### Fixed (한글)` and `⚠ Breaking`.
  assert.deepEqual(classifyChange('한국어 항목', { legacyHeading: '### Fixed (한글)' }), {
    section: SECTION.BUG_FIXES,
    basis: 'heading',
  });
  // a non-section heading (Breaking/Highlights) does NOT resolve → fallback.
  assert.deepEqual(classifyChange('drop legacy flag', { legacyHeading: '⚠ Breaking' }), {
    section: SECTION.CHORES,
    basis: 'fallback',
  });
  // tracker / type still win over the heading hint.
  assert.deepEqual(classifyChange('feat: add thing', { legacyHeading: 'Fixed' }), {
    section: SECTION.NEW_FEATURES,
    basis: 'type',
  });
  assert.deepEqual(classifyChange('docs: tweak (ISSUE-2)', { legacyHeading: 'Changed' }), {
    section: SECTION.BUG_FIXES,
    basis: 'tracker',
  });
});

test('detectInternalLabels: finds Track A / OQ-NN, ignores tracker IDs and PR numbers', () => {
  assert.deepEqual(detectInternalLabels('feat (Track A-sot) (OQ-34) (#82)'), [
    'Track A-sot',
    'OQ-34',
  ]);
  assert.deepEqual(detectInternalLabels('Track E gate'), ['Track E']);
  assert.deepEqual(detectInternalLabels('nothing here (FEAT-1) (#141)'), []);
  assert.deepEqual(detectInternalLabels(''), []);
  // /g regex is reset between calls.
  assert.deepEqual(detectInternalLabels('Track E gate'), ['Track E']);
});

test('sanitizeTrackerIds: strips tracker IDs, keeps #N, cleans empty parens', () => {
  assert.equal(
    sanitizeTrackerIds('feat(feedback): add failure_type (FEAT-1) (#141)'),
    'feat(feedback): add failure_type (#141)',
  );
  // bare ID, not parenthesized.
  assert.equal(sanitizeTrackerIds('IMPR-3 reconcile types'), 'reconcile types');
  // ID inside a larger paren keeps the rest, drops the leading gap.
  assert.equal(
    sanitizeTrackerIds('verify on tie (ISSUE-7 Part A) (#97)'),
    'verify on tie (Part A) (#97)',
  );
  // #N PR numbers and ADR anchors are untouched (format.md §10).
  assert.equal(
    sanitizeTrackerIds('whitelist activity (ADR 0057) (#131)'),
    'whitelist activity (ADR 0057) (#131)',
  );
  // a removed leading label leaves orphaned punctuation → dropped.
  assert.equal(sanitizeTrackerIds('ISSUE-7: starts with label'), 'starts with label');
  assert.equal(sanitizeTrackerIds(null), '');
});

test('hasTrackerId: detects all four prefixes, ignores #N / ADR', () => {
  assert.equal(hasTrackerId('foo (FEAT-1)'), true);
  assert.equal(hasTrackerId('foo (IMPR-14)'), true);
  assert.equal(hasTrackerId('foo (ISSUE-8)'), true);
  assert.equal(hasTrackerId('foo (PRAC-17)'), true);
  assert.equal(hasTrackerId('foo (#141) (ADR 0057)'), false);
  // /g regex is reset between calls — repeated calls stay correct.
  assert.equal(hasTrackerId('foo (FEAT-1)'), true);
});

test('changelog-classify snapshot: 11 versions lock to expected section/basis', () => {
  const fixture = JSON.parse(
    readFileSync(join(REPO, 'tests', 'fixtures', 'changelog-classify.snapshot.json'), 'utf-8'),
  );
  const entries = fixture.entries;
  assert.ok(Array.isArray(entries) && entries.length >= 30, 'fixture must be a non-trivial array');

  // every release is represented (regression: a dropped version goes unnoticed).
  const versions = new Set(entries.map((e) => e.version));
  for (const v of [
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '1.2.0',
    '1.2.1',
    '1.3.0',
    '1.3.1',
    '1.3.2',
    '1.3.3',
    '1.3.4',
    '1.4.0',
  ]) {
    assert.ok(versions.has(v), `fixture missing version ${v}`);
  }

  for (const e of entries) {
    const got = classifyChange(e.title);
    assert.equal(
      got.section,
      e.section,
      `[${e.version}] section drift: "${e.title}" → ${got.section} (expected ${e.section})`,
    );
    assert.equal(
      got.basis,
      e.basis,
      `[${e.version}] basis drift: "${e.title}" → ${got.basis} (expected ${e.basis})`,
    );
    // surface ID 0: after sanitize, no tracker ID survives but the PR number does.
    const clean = sanitizeTrackerIds(e.title);
    assert.equal(
      hasTrackerId(clean),
      false,
      `[${e.version}] tracker ID survived sanitize: "${clean}"`,
    );
    const pr = e.title.match(/\(#\d+\)/);
    if (pr)
      assert.ok(clean.includes(pr[0]), `[${e.version}] PR number dropped by sanitize: "${clean}"`);
  }

  // The fixture claims to hold REAL commit subjects — verify each title exists
  // verbatim in git history. Skipped (with a note) when full history is absent
  // (shallow clone / not a repo), so a CI shallow-checkout never false-fails.
  let realSubjects = null;
  try {
    const out = spawnSync('git', ['log', '--all', '--no-merges', '--format=%s'], {
      cwd: REPO,
      encoding: 'utf-8',
    });
    if (out.status === 0 && out.stdout) {
      realSubjects = new Set(out.stdout.split('\n').map((s) => s.trim()));
    }
  } catch {}
  if (realSubjects && realSubjects.size > 50) {
    for (const e of entries) {
      assert.ok(
        realSubjects.has(e.title.trim()),
        `[${e.version}] fixture title is not a verbatim git subject: "${e.title}"`,
      );
    }
  } else {
    console.log('    (note: git history unavailable — skipped verbatim-subject check)');
  }
});

// ── collect-changelog (T8) ───────────────────────────────────────────────────

suite('collect-changelog: parsePrNumber()');

test('squash subject: trailing (#N)', () => {
  assert.equal(parsePrNumber('docs: thing (#143)'), 143);
});

test('squash subject: last (#N) wins when prose mentions an earlier PR', () => {
  assert.equal(parsePrNumber('fix: follow-up to #41, done (#142)'), 142);
});

test('merge-commit subject', () => {
  assert.equal(parsePrNumber('Merge pull request #99 from sk-lim19f/feat/x'), 99);
});

test('no PR number → null', () => {
  assert.equal(parsePrNumber('chore: local tweak'), null);
});

test('mid-sentence (#N) is NOT a PR ref → null (a direct push is not faked as a PR)', () => {
  assert.equal(parsePrNumber('docs: explain the (#12) placeholder syntax'), null);
});

suite('collect-changelog: isMergeBoilerplate()');

test('merge-commit subject is boilerplate', () => {
  assert.equal(isMergeBoilerplate('Merge pull request #99 from a/b'), true);
});

test('squash Conventional subject is NOT boilerplate', () => {
  assert.equal(isMergeBoilerplate('feat: add x (#99)'), false);
});

suite('collect-changelog: parseChangelogBlock()');

test('both EN + KO present', () => {
  const body =
    '## What\nstuff\n\n## Changelog\n\n- EN: did a thing\n- KO: 무언가 했습니다\n\n## Migration notes\nNone';
  assert.deepEqual(parseChangelogBlock(body), { en: 'did a thing', ko: '무언가 했습니다' });
});

test('literal None → "none"', () => {
  assert.equal(parseChangelogBlock('## Changelog\n\nNone\n'), 'none');
});

test('heading absent → null', () => {
  assert.equal(parseChangelogBlock('## What\nno changelog section here'), null);
});

test('HTML comment instructions are stripped', () => {
  const body = '## Changelog\n<!-- one EN line + one KO line -->\n- EN: x\n- KO: 엑스\n';
  assert.deepEqual(parseChangelogBlock(body), { en: 'x', ko: '엑스' });
});

test('missing KO → malformed', () => {
  const r = parseChangelogBlock('## Changelog\n- EN: only english\n');
  assert.ok(r && r.malformed, 'should be malformed');
});

test('empty EN value → malformed (unfilled template)', () => {
  const r = parseChangelogBlock('## Changelog\n- EN:\n- KO:\n');
  assert.ok(r && r.malformed, 'should be malformed');
});

test('duplicate EN line → malformed', () => {
  const r = parseChangelogBlock('## Changelog\n- EN: a\n- EN: b\n- KO: 가\n');
  assert.ok(r && r.malformed, 'should be malformed');
});

test('None mixed with EN/KO → malformed', () => {
  const r = parseChangelogBlock('## Changelog\nNone\n- EN: a\n- KO: 가\n');
  assert.ok(r && r.malformed, 'should be malformed');
});

suite('collect-changelog: normalizeIndexTitle()');

test('strips a single trailing (#N)', () => {
  assert.equal(normalizeIndexTitle('docs: thing (#143)'), 'docs: thing');
});

test('strips tracker IDs off the surface', () => {
  assert.equal(hasTrackerId(normalizeIndexTitle('feat: x FEAT-1 (#5)')), false);
});

suite('collect-changelog: assembleSections()');

test('groups by section; none/null skip the body but still index + credit', () => {
  const entries = [
    {
      pr: 1,
      subject: 'feat: a (#1)',
      section: SECTION.NEW_FEATURES,
      basis: 'type',
      author: 'A',
      handle: 'gh-a',
      block: { en: 'added a', ko: 'a 추가' },
    },
    {
      pr: 2,
      subject: 'fix: b (#2)',
      section: SECTION.BUG_FIXES,
      basis: 'type',
      author: 'B',
      handle: 'gh-b',
      block: { en: 'fixed b', ko: 'b 수정' },
    },
    {
      pr: 3,
      subject: 'chore: c (#3)',
      section: SECTION.CHORES,
      basis: 'type',
      author: 'A',
      handle: 'gh-a',
      block: 'none',
    },
  ];
  const a = assembleSections(entries);
  assert.equal(a.sections[SECTION.NEW_FEATURES].en.length, 1);
  assert.equal(a.sections[SECTION.BUG_FIXES].ko.length, 1);
  assert.equal(a.sections[SECTION.CHORES].en.length, 0, 'none-block contributes no body line');
  assert.equal(a.index.length, 3, 'every PR is indexed, incl. the none-block one');
  assert.deepEqual(a.contributors, ['gh-a', 'gh-b'], 'de-duped, first-seen order');
});

test('sanitizes tracker IDs out of body lines', () => {
  const entries = [
    {
      pr: 5,
      subject: 'feat: x (#5)',
      section: SECTION.NEW_FEATURES,
      basis: 'type',
      author: 'A',
      handle: 'a',
      block: { en: 'x FEAT-1', ko: 'x IMPR-2' },
    },
  ];
  const a = assembleSections(entries);
  assert.equal(hasTrackerId(a.sections[SECTION.NEW_FEATURES].en[0]), false);
  assert.equal(hasTrackerId(a.sections[SECTION.NEW_FEATURES].ko[0]), false);
});

test('merge entry is indexed by titleSource, never its boilerplate subject', () => {
  const a = assembleSections([
    {
      pr: 99,
      subject: 'Merge pull request #99 from a/x',
      titleSource: 'feat: shiny thing',
      section: SECTION.NEW_FEATURES,
      basis: 'type',
      author: 'A',
      handle: 'gh-a',
      block: null,
    },
  ]);
  assert.equal(a.index[0].title, 'feat: shiny thing');
});

test('no verified handle → unresolved (TODO), never a fabricated @author', () => {
  const a = assembleSections([
    {
      pr: 7,
      subject: 'fix: x (#7)',
      titleSource: 'fix: x (#7)',
      section: SECTION.BUG_FIXES,
      basis: 'type',
      author: '임상규',
      handle: null,
      block: null,
    },
  ]);
  assert.equal(a.contributors.length, 0);
  assert.deepEqual(a.unresolved, ['임상규']);
  const md = renderDraft(a);
  assert.doesNotMatch(md, /@임상규/);
  assert.match(md, /TODO: add @handle for: 임상규/);
});

suite('collect-changelog: renderDraft()');

test('emits section model + bare index + Contributors, omits empty sections', () => {
  const entries = [
    {
      pr: 1,
      subject: 'feat: a (#1)',
      section: SECTION.NEW_FEATURES,
      basis: 'type',
      author: 'A',
      handle: 'gh-a',
      block: { en: 'added a', ko: 'a 추가' },
    },
  ];
  const md = renderDraft(assembleSections(entries));
  assert.match(md, /### New Features/);
  assert.match(md, /#### English\n- added a \(#1\)/);
  assert.match(md, /#### 한국어\n- a 추가 \(#1\)/);
  assert.match(md, /### Changelog\n- #1 feat: a/);
  assert.match(md, /Contributors: @gh-a/);
  assert.doesNotMatch(md, /### Bug Fixes/, 'empty section omitted');
});

suite('collect-changelog: repoUrlToPrBase()');

test('derives the /pull base from https, git+https, and ssh forms', () => {
  const want = 'https://github.com/sk-lim19f/Hypomnema/pull';
  assert.equal(repoUrlToPrBase('https://github.com/sk-lim19f/Hypomnema.git'), want);
  assert.equal(repoUrlToPrBase('git+https://github.com/sk-lim19f/Hypomnema.git'), want);
  assert.equal(repoUrlToPrBase('https://github.com/sk-lim19f/Hypomnema'), want);
  assert.equal(repoUrlToPrBase('git@github.com:sk-lim19f/Hypomnema.git'), want);
});

test('returns null on absent or non-GitHub URL so the caller falls back to bare #N', () => {
  assert.equal(repoUrlToPrBase(undefined), null);
  assert.equal(repoUrlToPrBase(''), null);
  assert.equal(repoUrlToPrBase('https://gitlab.com/x/y.git'), null);
});

test('declines a non-host github.com and a URL with extra path (anchored contract)', () => {
  // github.com in the path, not the host: must not be treated as GitHub
  assert.equal(repoUrlToPrBase('https://example.com/github.com/sk-lim19f/Hypomnema.git'), null);
  // owner/repo is not the whole path: decline rather than emit a /issues/pull base
  assert.equal(repoUrlToPrBase('https://github.com/sk-lim19f/Hypomnema/issues'), null);
  assert.equal(repoUrlToPrBase('https://github.com/sk-lim19f'), null);
});

suite('collect-changelog: prRef()');

test('links #N when a base is known, bare #N otherwise', () => {
  const base = 'https://github.com/sk-lim19f/Hypomnema/pull';
  assert.equal(prRef(141, base), '[#141](https://github.com/sk-lim19f/Hypomnema/pull/141)');
  assert.equal(prRef(141, null), '#141');
  assert.equal(prRef(141, undefined), '#141');
});

test('assembleSections + renderDraft inline-link #N when prUrlBase is passed', () => {
  const entries = [
    {
      pr: 156,
      subject: 'feat: vault path (#156)',
      section: SECTION.NEW_FEATURES,
      basis: 'type',
      author: 'A',
      handle: 'gh-a',
      block: { en: 'shows vault path', ko: '볼트 경로 표시' },
    },
  ];
  const base = 'https://github.com/sk-lim19f/Hypomnema/pull';
  const md = renderDraft(assembleSections(entries, { prUrlBase: base }));
  // body line carries the parenthesized inline link
  assert.match(
    md,
    /- shows vault path \(\[#156\]\(https:\/\/github\.com\/sk-lim19f\/Hypomnema\/pull\/156\)\)/,
  );
  // index line is the inline link, not a bare #156
  assert.match(
    md,
    /### Changelog\n- \[#156\]\(https:\/\/github\.com\/sk-lim19f\/Hypomnema\/pull\/156\) feat: vault path/,
  );
  assert.doesNotMatch(md, /\n- #156 /, 'index must not emit a bare #N when a base is known');
});

suite('collect-changelog CLI');

const COLLECT = join(SCRIPTS, 'collect-changelog.mjs');

function runCollect(args, extraEnv = {}) {
  return spawnSync(process.execPath, [COLLECT, ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, ...extraEnv },
  });
}

test('--help exits 0 with usage', () => {
  const r = runCollect(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /collect-changelog/);
});

test('--strict --no-api is a usage error (exit 2)', () => {
  const r = runCollect(['--strict', '--no-api']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /rejected/);
});

test('empty range exits 2 with a message', () => {
  const r = runCollect(['--range', 'HEAD..HEAD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty range/);
});

// Hermetic git repos via --repo so the CLI tests do not depend on the real
// repo's history (CI uses a shallow clone, so a fixed SHA or HEAD~1 may be
// absent). Each test builds its own repo and points the collector at it.
function withGitRepo(setup, fn) {
  withTmpDir((dir) => {
    const g = (args) =>
      spawnSync('git', args, {
        cwd: dir,
        encoding: 'utf-8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@e',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@e',
        },
      });
    g(['init', '-q']);
    g(['commit', '--allow-empty', '-qm', 'base']);
    setup(g, dir);
    fn(dir, g);
  });
}

test('--no-api offline: warns and still drafts an index', () => {
  withGitRepo(
    (g) => {
      g(['tag', 'v0.0.1']);
      g(['commit', '--allow-empty', '-qm', 'feat: a thing (#7)']);
    },
    (dir) => {
      const r = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD', '--no-api']);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /--no-api/);
      assert.match(
        r.stdout,
        /- \[#7\]\(https:\/\/github\.com\/sk-lim19f\/Hypomnema\/pull\/7\) feat: a thing/,
      );
    },
  );
});

test('fake gh success: CLI fills block bodies + @handle from the API', () => {
  withGitRepo(
    (g) => {
      g(['tag', 'v0.0.1']);
      g(['commit', '--allow-empty', '-qm', 'feat: a thing (#42)']);
    },
    (dir) => {
      const stub = join(dir, 'gh');
      // node stub → JSON.stringify handles \n escaping (a bash printf would
      // inject raw newlines and produce invalid JSON).
      writeFileSync(
        stub,
        '#!/usr/bin/env node\n' +
          "process.stdout.write(JSON.stringify({author:{login:'tester'},body:'## Changelog\\n- EN: stubbed entry\\n- KO: 스텁 항목\\n'}));\n",
        { mode: 0o755 },
      );
      const r = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD'], {
        PATH: `${dir}:${process.env.PATH}`,
      });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /stubbed entry/);
      assert.match(r.stdout, /스텁 항목/);
      assert.match(r.stdout, /Contributors: @tester/);
    },
  );
});

test('fake gh failure: flagged as apiError (warn exits 0, strict exits 1), never silent', () => {
  withGitRepo(
    (g) => {
      g(['tag', 'v0.0.1']);
      g(['commit', '--allow-empty', '-qm', 'feat: a thing (#42)']);
    },
    (dir) => {
      const stub = join(dir, 'gh');
      writeFileSync(
        stub,
        '#!/usr/bin/env node\nprocess.stderr.write("gh: rate limit exceeded\\n");process.exit(1);\n',
        { mode: 0o755 },
      );
      const env = { PATH: `${dir}:${process.env.PATH}` };
      const warn = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD'], env);
      assert.equal(warn.status, 0, 'warn mode tolerates an API failure');
      assert.match(warn.stderr, /gh API failed/);
      const strict = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD', '--strict'], env);
      assert.equal(strict.status, 1, 'strict fails on an API error');
    },
  );
});

test('CLI: merge commit indexed by body PR title; direct-push → TODO not a fake #N', () => {
  withGitRepo(
    (g) => {
      g(['tag', 'v0.0.1']);
      g(['commit', '--allow-empty', '-qm', 'Merge pull request #99 from a/x\n\nfeat: shiny thing']);
      g(['commit', '--allow-empty', '-qm', 'chore: a direct push']);
    },
    (dir) => {
      const r = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD', '--no-api']);
      assert.equal(r.status, 0);
      assert.match(
        r.stdout,
        /- \[#99\]\(https:\/\/github\.com\/sk-lim19f\/Hypomnema\/pull\/99\) feat: shiny thing/,
      );
      assert.doesNotMatch(r.stdout, /Merge pull request/);
      assert.match(r.stdout, /TODO: direct push/);
    },
  );
});

test('CLI --strict: a direct-push commit (no PR) exits 1', () => {
  withGitRepo(
    (g) => {
      g(['tag', 'v0.0.1']);
      g(['commit', '--allow-empty', '-qm', 'chore: a direct push, no PR']);
    },
    (dir) => {
      // no PR-bearing commit in range → no gh call → strict fails on directPush.
      const r = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD', '--strict']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /commit with no PR/);
    },
  );
});

test('CLI: no tags and no --range → exit 2 with "no tags found"', () => {
  withGitRepo(
    () => {
      /* leave the repo tagless */
    },
    (dir) => {
      const r = runCollect(['--repo', dir]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /no tags found/);
    },
  );
});

test('CLI --strict: a PR missing its ## Changelog block exits 1', () => {
  withGitRepo(
    (g) => {
      g(['tag', 'v0.0.1']);
      g(['commit', '--allow-empty', '-qm', 'feat: a thing (#42)']);
    },
    (dir) => {
      const stub = join(dir, 'gh');
      writeFileSync(
        stub,
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({author:{login:"t"},body:"no changelog block here"}));\n',
        { mode: 0o755 },
      );
      const r = runCollect(['--repo', dir, '--range', 'v0.0.1..HEAD', '--strict'], {
        PATH: `${dir}:${process.env.PATH}`,
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /no ## Changelog block/);
    },
  );
});

// Guards the package-root resolution contract across the shipped surfaces that
// INSTRUCT the model to run a bundled script: every slash command, every skill,
// and the operational wiki guide. When such a surface is read outside a plugin
// context (npm/init copies commands into ~/.claude/commands/hypo/; the guide is
// installed into ~/hypomnema/) the harness never expands ${CLAUDE_PLUGIN_ROOT}, so
// every script reference must route through ${CLAUDE_PLUGIN_ROOT}/scripts or the
// clause's <pkgRoot>/scripts; a bare `scripts/x.mjs`, `./scripts/x.mjs`, or a
// guessed `<package-root>`/`<pkg-root>` is cwd-dependent and breaks. Both inline
// code spans (e.g. "Run `scripts/lint.mjs`") and fenced blocks are scanned, since
// an imperative reference can appear either way. Wiki CONTENT template pages (e.g.
// observability dashboards) are not execution instructions and are out of scope.
test('prompt surfaces: bundled-script references resolve via CLAUDE_PLUGIN_ROOT/scripts or pkgRoot (no bare/placeholder paths)', () => {
  const surfaceFiles = [];
  const cmdDir = join(REPO, 'commands');
  for (const f of readdirSync(cmdDir).filter((x) => x.endsWith('.md'))) {
    surfaceFiles.push(join(cmdDir, f));
  }
  const skillsDir = join(REPO, 'skills');
  for (const d of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, d, 'SKILL.md');
    if (existsSync(skillMd)) surfaceFiles.push(skillMd);
  }
  surfaceFiles.push(join(REPO, 'templates', 'hypo-guide.md')); // the operational guide

  // Collect code-context text: fenced-block lines + inline `code` spans on prose lines.
  const codeText = (md) => {
    const out = [];
    let inFence = false;
    for (const line of md.split('\n')) {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      if (inFence) {
        out.push(line);
        continue;
      }
      const spans = line.match(/`[^`]+`/g);
      if (spans) out.push(spans.join(' '));
    }
    return out.join('\n');
  };

  // Known bundled-script basenames, derived from scripts/ so the gate stays current.
  // A reference is a violation when it names one of these but is NOT the accepted
  // ${CLAUDE_PLUGIN_ROOT}/scripts/... or <pkgRoot>/scripts/... form: that covers both a
  // path-prefixed `scripts/x.mjs` / `<package-root>/scripts/x.mjs` and a bare `x.mjs`
  // executable name (e.g. "run `crystallize.mjs --mark-session-closed`"). Hook basenames
  // live in hooks/, not scripts/, so a descriptive mention of one is not flagged.
  const scriptBasenames = new Set();
  const collectMjs = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) collectMjs(full);
      else if (e.name.endsWith('.mjs')) scriptBasenames.add(e.name);
    }
  };
  collectMjs(join(REPO, 'scripts'));

  // Remove the two ACCEPTED forms first; any bundled-script name surviving is bare/guessed.
  const stripResolved = (s) =>
    s
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[A-Za-z0-9._/-]+\.mjs/g, '')
      .replace(/<pkgRoot>\/scripts\/[A-Za-z0-9._/-]+\.mjs/g, '');
  const pluginInvokeRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//;

  const unresolved = [];
  const missingFallback = [];
  for (const p of surfaceFiles) {
    const text = readFileSync(p, 'utf8');
    const code = codeText(text);
    const rel = p.slice(REPO.length + 1);
    const hits = new Set();
    for (const m of stripResolved(code).match(/[A-Za-z0-9._/-]*\.mjs/g) || []) {
      if (scriptBasenames.has(m.split('/').pop())) hits.add(m);
    }
    if (hits.size) unresolved.push(`${rel} [${[...hits].join(', ')}]`);
    if (pluginInvokeRe.test(code) && !text.includes('hypo-pkg.json')) missingFallback.push(rel);
  }
  assert.equal(
    unresolved.length,
    0,
    `surfaces with a bundled-script reference not routed through CLAUDE_PLUGIN_ROOT/scripts or <pkgRoot>/scripts (cwd-dependent or model-guessed; breaks when read outside a plugin context): ${unresolved.join('; ')}`,
  );
  assert.equal(
    missingFallback.length,
    0,
    `surfaces invoking a bundled script but missing the hypo-pkg.json resolution fallback: ${missingFallback.join(', ')}`,
  );
});
