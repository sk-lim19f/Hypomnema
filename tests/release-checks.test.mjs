// tests/release-checks.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateChangelog,
  validateTagBody,
  countHangul,
  HANGUL_BODY_THRESHOLD,
  listChangelogVersions,
  meetsKoreanCutoff,
  parseSemver,
} from '../scripts/lib/check-bilingual.mjs';
import { test, suite } from './harness.mjs';
import { run, withTmpDir } from './helpers.mjs';

// ── check-bilingual: release-doc bilingual rule enforcement ─────────────────

suite('check-bilingual — CHANGELOG section validator');

const CHANGELOG_HEADER = `# Changelog

All notable changes to Hypomnema are documented in this file.

## [Unreleased]

`;

function makeChangelogFixture(sections) {
  return CHANGELOG_HEADER + sections.join('\n');
}

// Section-model fixtures (changelog-pr-guide T3). A gated section carries
// "#### English" + "#### 한국어" sub-blocks at/after the 1.2.0 cutoff.
function gatedSection(heading, english, korean) {
  let s = `### ${heading}\n\n#### English\n\n- ${english}\n`;
  if (korean != null) s += `\n#### 한국어\n\n- ${korean}\n`;
  return s;
}

const KO = '이번 릴리스에서 기능을 추가하고 버그를 고쳤습니다.';

const KO2 = '내부 정리와 리팩터를 진행했습니다 충분한 분량입니다.';

test('check-bilingual: cutoff+ version with bilingual gated sections passes', () => {
  const cl = makeChangelogFixture([
    `## [1.2.0] - 2026-05-24

${gatedSection('New Features', 'add a thing (#10)', '기능을 추가했습니다 (#10)')}
${gatedSection('Bug Fixes', 'fix a thing (#11)', '버그를 고쳤습니다 (#11)')}
### Changelog

- #10 add (@a)
`,
  ]);
  const r = validateChangelog(cl, '1.2.0');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.hangulCount >= HANGUL_BODY_THRESHOLD);
});

test('check-bilingual: cutoff+ gated section missing "#### 한국어" fails', () => {
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### New Features

#### English

- only english here (#1)
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing "#### 한국어"/);
});

test('check-bilingual: cutoff+ "#### 한국어" heading with no Korean text fails', () => {
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### Bug Fixes

#### English

- english (#1)

#### 한국어

- only english words here, no hangul
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no Korean text/);
});

test('check-bilingual: cutoff+ gated section missing "#### English" fails', () => {
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### Chores

#### 한국어

- ${KO2}
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing "#### English"/);
});

test('check-bilingual: cutoff+ with no gated section fails', () => {
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### Changelog

- #1 a change (@a)
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no gated section/);
});

test('check-bilingual: cutoff+ total Korean below threshold fails', () => {
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### Chores

#### English

- tidy (#1)

#### 한국어

- 정리함
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /threshold/);
});

test('check-bilingual: Highlights is a gated section (Korean enforced at cutoff)', () => {
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### Highlights

#### English

- a highlight (#1)
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false, 'Highlights must require a Korean sub-block at cutoff');
  assert.match(r.reason, /Highlights.*한국어/);
});

test('check-bilingual: Changelog/Known Issues are NOT gated (no Korean required)', () => {
  // A version with one bilingual gated section plus a language-neutral Changelog
  // and an English-only Known Issues note must still pass.
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

${gatedSection('New Features', 'add (#1)', '기능을 추가했고 분량을 채웁니다 (#1)')}
### Known Issues

- a known caveat, English only

### Changelog

- #1 add (@a)
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('check-bilingual: Korean in a sibling non-gated section does not satisfy the gate', () => {
  // Hangul lives only in a non-gated "### Notes"; the gated New Features has an
  // English-only "#### 한국어" → must fail (no leak across ### boundary).
  const cl = makeChangelogFixture([
    `## [1.3.0] - 2026-06-07

### New Features

#### English

- add (#1)

#### 한국어

- english only, no hangul

### Notes

- 여기에는 한국어가 가득합니다 임계값을 넘기고도 남습니다.
`,
  ]);
  const r = validateChangelog(cl, '1.3.0');
  assert.equal(r.ok, false, 'Korean in Notes must not count for the gated section');
});

test('check-bilingual: pre-cutoff (1.0.0/1.1.0) is English-only, Korean exempt', () => {
  for (const v of ['1.0.0', '1.1.0']) {
    const cl = makeChangelogFixture([
      `## [${v}] - 2026-01-01

### Added

- an English-only entry, no Korean at all (#1)
`,
    ]);
    const r = validateChangelog(cl, v);
    assert.equal(r.ok, true, `${v} must pass English-only: ${JSON.stringify(r)}`);
    assert.equal(r.koreanExempt, true);
    assert.equal(r.hangulCount, 0);
  }
});

test('check-bilingual: pre-cutoff with no content fails', () => {
  const cl = makeChangelogFixture([`## [1.0.0] - 2026-01-01\n\n`]);
  const r = validateChangelog(cl, '1.0.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no content/);
});

test('check-bilingual: version not in CHANGELOG fails', () => {
  const cl = makeChangelogFixture([`## [1.2.0] - 2026-05-24\n\n- stuff\n`]);
  const r = validateChangelog(cl, '9.9.9');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no "## \[9\.9\.9\]"/);
});

test('check-bilingual: [Unreleased] does NOT satisfy a version-target lookup', () => {
  const cl = makeChangelogFixture([]);
  const r = validateChangelog(cl, '1.2.0');
  assert.equal(r.ok, false);
});

test('check-bilingual: 1.2.1 does not match 1.2.10 (semver escape)', () => {
  const cl = makeChangelogFixture([
    `## [1.2.10] - 2026-06-01

${gatedSection('Bug Fixes', 'fix (#1)', '버그를 고쳤습니다 충분한 분량입니다 (#1)')}`,
  ]);
  const r = validateChangelog(cl, '1.2.1');
  assert.equal(r.ok, false, 'must not match 1.2.10 prefix as 1.2.1');
});

test('check-bilingual: prerelease (1.2.0-rc.1) is matched and treated as cutoff+', () => {
  const cl = makeChangelogFixture([
    `## [1.2.0-rc.1] - 2026-05-20

${gatedSection('New Features', 'add (#1)', '기능을 추가했습니다 충분한 분량입니다 (#1)')}`,
  ]);
  const r = validateChangelog(cl, '1.2.0-rc.1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(meetsKoreanCutoff('1.2.0-rc.1'), true);
});

test('check-bilingual: duplicate version sections fail', () => {
  const cl = makeChangelogFixture([
    `## [1.2.0] - 2026-05-24

${gatedSection('New Features', 'add (#1)', '기능을 추가 (#1)')}
## [1.2.0] - 2026-05-25

${gatedSection('Bug Fixes', 'fix (#2)', '버그 수정 (#2)')}`,
  ]);
  const r = validateChangelog(cl, '1.2.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /duplicate.*sections/);
});

test('check-bilingual: CRLF line endings normalized', () => {
  const block = `## [1.2.0] - 2026-05-24\n\n### New Features\n\n#### English\n\n- add (#1)\n\n#### 한국어\n\n- ${KO}\n`;
  const cl = (CHANGELOG_HEADER + block).replace(/\n/g, '\r\n');
  const r = validateChangelog(cl, '1.2.0');
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('check-bilingual: NFC normalizes decomposed Hangul jamo before counting', () => {
  const decomposed = '가나다라마바사아자차'.normalize('NFD');
  assert.notEqual(decomposed, '가나다라마바사아자차');
  const cl = makeChangelogFixture([
    `## [1.2.0] - 2026-05-24\n\n### Chores\n\n#### English\n\n- tidy (#1)\n\n#### 한국어\n\n${decomposed}\n`,
  ]);
  const r = validateChangelog(cl, '1.2.0');
  assert.equal(r.ok, true, `decomposed input must NFC-normalize; got: ${JSON.stringify(r)}`);
});

test('check-bilingual: parseSemver + meetsKoreanCutoff', () => {
  assert.deepEqual(parseSemver('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('1.2.0-rc.1'), [1, 2, 0]);
  assert.equal(parseSemver('nope'), null);
  assert.equal(meetsKoreanCutoff('1.1.0'), false);
  assert.equal(meetsKoreanCutoff('1.2.0'), true);
  assert.equal(meetsKoreanCutoff('1.4.0'), true);
  assert.equal(meetsKoreanCutoff('2.0.0'), true);
  assert.equal(meetsKoreanCutoff('1.0.1'), false);
});

test('check-bilingual: listChangelogVersions lists versions, skips Unreleased', () => {
  const cl = makeChangelogFixture([
    `## [1.2.0] - 2026-05-24\n\n- x\n`,
    `## [1.1.0] - 2026-05-13\n\n- y\n`,
  ]);
  assert.deepEqual(listChangelogVersions(cl), ['1.2.0', '1.1.0']);
});

test('check-bilingual: --all model passes a mixed pre/post-cutoff document', () => {
  const cl = makeChangelogFixture([
    `## [1.2.0] - 2026-05-24

${gatedSection('New Features', 'add (#1)', '기능을 추가했습니다 충분한 분량입니다 (#1)')}`,
    `## [1.1.0] - 2026-05-13

### Added

- english-only pre-cutoff (#0)
`,
  ]);
  const versions = listChangelogVersions(cl);
  for (const v of versions) {
    assert.equal(validateChangelog(cl, v).ok, true, `${v} must pass`);
  }
});

suite('check-bilingual — git tag annotation body validator');

test('check-bilingual tag: valid body with --- + Korean passes', () => {
  const body = `Hypomnema v1.0.0 — initial release\n\nEnglish summary body.\n\n---\n\n한국어 요약 본문입니다 여러 단어를 포함한 실제 한글 요약.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, true);
});

test('check-bilingual tag: body without --- separator fails', () => {
  const body = `Hypomnema v1.0.0\n\nEnglish only, no separator, but has 한국어 요약 inline.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no "---" separator/);
});

test('check-bilingual tag: --- present but no Korean after fails', () => {
  const body = `Hypomnema v1.0.0\n\nEnglish body.\n\n---\n\nMore English, no Korean here.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Hangul/);
});

test('check-bilingual tag: only the LAST --- counts (tolerates English markdown HR)', () => {
  // Earlier --- is a legit horizontal rule inside the English body. The Korean
  // summary block lives after the SECOND --- only.
  const body =
    `Hypomnema v1.0.0\n\n` +
    `English section A.\n\n---\n\nEnglish section B (still English, after first ---).\n\n` +
    `---\n\n한국어 요약 본문입니다 충분한 분량의 실제 한글 요약.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, true);
});

test('check-bilingual tag: --- present, only Hangul before it (header-only Korean) fails', () => {
  // Korean lives BEFORE the separator (mis-ordered). After-separator body is
  // English-only — must fail.
  const body = `한국어 요약 본문입니다 충분한 분량의 실제 한글 요약.\n\n---\n\nEnglish only after the separator.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, false);
});

test('check-bilingual tag: multiple --- + Korean after last passes', () => {
  const body = `A\n---\nB\n---\nC\n---\n한글 요약 본문 충분한 길이의 실제 한국어 요약입니다.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, true);
});

test('check-bilingual tag: short Korean (under threshold) fails', () => {
  const body = `English body.\n\n---\n\n한글.\n`;
  const r = validateTagBody(body);
  assert.equal(r.ok, false);
  assert.match(r.reason, /threshold: 10/);
});

test('check-bilingual: countHangul ignores non-Hangul Unicode (e.g. CJK, Hiragana)', () => {
  // 漢字 (CJK Han, not Hangul), ひらがな (Hiragana) — both should be 0.
  assert.equal(countHangul('漢字 ひらがな English'), 0);
  assert.equal(countHangul('한글 + 漢字'), 2);
});

// ── IMPR-12: release-channel version assert + plugin smoke ────────────────────
suite('check-versions.mjs (IMPR-12)');

// Build a minimal repo-shaped fixture where every version-carrying location holds
// `v`. Tests mutate one location to prove drift is caught.
function buildVersionFixture(dir, v) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'templates'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'hypomnema', version: v }, null, 2),
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'hypomnema',
        version: v,
        lockfileVersion: 3,
        packages: { '': { name: 'hypomnema', version: v } },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'hypo', version: v }, null, 2),
  );
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      { name: 'hypomnema', plugins: [{ name: 'hypo', source: './', version: v }] },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, 'templates', 'hypo-config.md'),
    `---\ntitle: cfg\ntype: config\nversion: "${v}"\n---\n`,
  );
}

test('all files agree → exit 0', () => {
  withTmpDir((dir) => {
    buildVersionFixture(dir, '1.4.0');
    const r = run('check-versions.mjs', ['--root', dir]);
    assert.equal(r.status, 0, `expected 0: ${r.stdout}\n${r.stderr}`);
  });
});

test('one file drifts → exit 1 (drift caught)', () => {
  withTmpDir((dir) => {
    buildVersionFixture(dir, '1.4.0');
    // bump-version does NOT touch the lockfile, so a stale lock is the realistic drift.
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify(
        {
          name: 'hypomnema',
          version: '1.3.9',
          lockfileVersion: 3,
          packages: { '': { version: '1.3.9' } },
        },
        null,
        2,
      ),
    );
    const r = run('check-versions.mjs', ['--root', dir]);
    assert.equal(r.status, 1, `expected 1 on drift: ${r.stdout}`);
    assert.ok(/drift/.test(r.stderr + r.stdout), 'should report drift');
  });
});

test('--tag matching the files → exit 0; mismatch → exit 1', () => {
  withTmpDir((dir) => {
    buildVersionFixture(dir, '1.4.0');
    assert.equal(
      run('check-versions.mjs', ['--root', dir, '--tag', 'v1.4.0']).status,
      0,
      'tag match → 0',
    );
    const bad = run('check-versions.mjs', ['--root', dir, '--tag', 'v1.4.1']);
    assert.equal(bad.status, 1, 'tag mismatch → 1');
    assert.ok(/does not match/.test(bad.stderr + bad.stdout), 'should report tag mismatch');
  });
});

test('marketplace entry selected by name, not position (parity enforced)', () => {
  withTmpDir((dir) => {
    buildVersionFixture(dir, '1.4.0');
    // A first entry with a DIFFERENT name must not be treated as the authority.
    writeFileSync(
      join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(
        {
          plugins: [
            { name: 'other', source: './x', version: '9.9.9' },
            { name: 'hypo', source: './', version: '1.4.0' },
          ],
        },
        null,
        2,
      ),
    );
    const r = run('check-versions.mjs', ['--root', dir]);
    assert.equal(
      r.status,
      0,
      `name-matched entry (1.4.0) should win over positional 9.9.9: ${r.stdout}\n${r.stderr}`,
    );
  });
});

test('--tag bare "v" (normalizes to empty) → exit 1 (gate not bypassed)', () => {
  withTmpDir((dir) => {
    buildVersionFixture(dir, '1.4.0');
    const r = run('check-versions.mjs', ['--root', dir, '--tag', 'v']);
    assert.equal(r.status, 1, 'a bare v tag must hard-fail, not be read as "no tag"');
    assert.ok(/valid semver/.test(r.stderr + r.stdout), 'should report invalid tag');
  });
});

test('an unreadable version file → exit 1 (no silent pass)', () => {
  withTmpDir((dir) => {
    buildVersionFixture(dir, '1.4.0');
    rmSync(join(dir, 'templates', 'hypo-config.md'));
    const r = run('check-versions.mjs', ['--root', dir]);
    assert.equal(r.status, 1, 'a missing version source must fail');
    assert.ok(/unreadable/.test(r.stderr + r.stdout), 'should report unreadable source');
  });
});

suite('smoke-plugin.mjs (IMPR-12)');

function buildPluginFixture(dir) {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'commands'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      { name: 'hypo', version: '1.4.0', commands: './commands/', skills: './skills/' },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'hypo', source: './', version: '1.4.0' }] }, null, 2),
  );
  writeFileSync(join(dir, 'commands', 'foo.md'), '# foo\n');
  writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '# demo\n');
  writeFileSync(join(dir, 'hooks', 'h.mjs'), '// hook\n');
  writeFileSync(join(dir, 'hooks', 'shared-lib.mjs'), '// shared\n');
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/h.mjs' }] },
          ],
        },
        shared: ['shared-lib.mjs'],
      },
      null,
      2,
    ),
  );
}

test('valid plugin surfaces → exit 0', () => {
  withTmpDir((dir) => {
    buildPluginFixture(dir);
    const r = run('smoke-plugin.mjs', ['--root', dir]);
    assert.equal(r.status, 0, `expected 0: ${r.stdout}\n${r.stderr}`);
  });
});

test('missing hook target → exit 1', () => {
  withTmpDir((dir) => {
    buildPluginFixture(dir);
    rmSync(join(dir, 'hooks', 'h.mjs')); // hooks.json still references it
    const r = run('smoke-plugin.mjs', ['--root', dir]);
    assert.equal(r.status, 1, `expected 1 on missing hook target: ${r.stdout}`);
    assert.ok(/is not a file/.test(r.stderr + r.stdout), 'should report missing target');
  });
});

test('empty commands (.gitkeep only) → exit 1', () => {
  withTmpDir((dir) => {
    buildPluginFixture(dir);
    rmSync(join(dir, 'commands', 'foo.md'));
    writeFileSync(join(dir, 'commands', '.gitkeep'), '');
    const r = run('smoke-plugin.mjs', ['--root', dir]);
    assert.equal(r.status, 1, 'a placeholder-only commands/ must fail');
    assert.ok(/command files/.test(r.stderr + r.stdout), 'should report no command files');
  });
});

test('empty skills (.gitkeep only) → exit 1', () => {
  withTmpDir((dir) => {
    buildPluginFixture(dir);
    rmSync(join(dir, 'skills', 'demo', 'SKILL.md'));
    const r = run('smoke-plugin.mjs', ['--root', dir]);
    assert.equal(r.status, 1, 'a placeholder-only skills/ must fail');
    assert.ok(/SKILL\.md/.test(r.stderr + r.stdout), 'should report no skills');
  });
});

test('missing shared hook file → exit 1', () => {
  withTmpDir((dir) => {
    buildPluginFixture(dir);
    rmSync(join(dir, 'hooks', 'shared-lib.mjs')); // hooks.json.shared still lists it
    const r = run('smoke-plugin.mjs', ['--root', dir]);
    assert.equal(r.status, 1, 'a missing shared file must fail');
    assert.ok(/shared/.test(r.stderr + r.stdout), 'should report missing shared file');
  });
});

test('marketplace name mismatch → exit 1', () => {
  withTmpDir((dir) => {
    buildPluginFixture(dir);
    writeFileSync(
      join(dir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'WRONG', source: './', version: '1.4.0' }] }, null, 2),
    );
    const r = run('smoke-plugin.mjs', ['--root', dir]);
    assert.equal(r.status, 1, 'name parity must be enforced');
  });
});
