// tests/pr-pack-surface.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  moduleImports,
  relativeImports,
  resolveFrom,
  surfaceDiff,
  closureViolations,
  parsePackJson,
} from '../scripts/lib/pack-surface.mjs';
import {
  scanText,
  BLOCKED_PATTERNS,
  DECISION_PATTERNS,
  TAG_BODY_PATTERNS,
  ATTRIBUTION_PATTERNS,
} from '../scripts/lib/check-tracker-ids.mjs';
import { checkPrSurface } from '../scripts/lib/check-pr-surface.mjs';
import { parseChangelogBlock } from '../scripts/lib/collect-changelog.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  gitRepo,
  runChecker,
  withTmpDir,
} from './helpers.mjs';

suite('Ship surface gate (pack-surface)');

test('relativeImports finds static, re-export, side-effect, and literal dynamic imports', () => {
  const src = [
    `import { a } from './lib/one.mjs';`,
    `import {`,
    `  b,`,
    `} from '../scripts/lib/two.mjs';`,
    `export * from './three.mjs';`,
    `const m = await import('./lib/four.mjs');`,
    `import './five.mjs';`,
    `import pkg from 'node:fs';`, // bare specifier: not ours
    `const s = './lib/not-an-import.mjs';`, // a path in a string is not an import
  ].join('\n');
  assert.deepEqual(relativeImports(src).sort(), [
    '../scripts/lib/two.mjs',
    './five.mjs',
    './lib/four.mjs',
    './lib/one.mjs',
    './three.mjs',
  ]);
});

// A regex over raw text cannot tell code from prose. Both of these would have been
// reported as real imports, and each false positive blocks an honest PR.
test('the scanner ignores imports written inside comments and strings', () => {
  assert.deepEqual(relativeImports(`// import './ghost.mjs'\nconst a = 1;`), []);
  assert.deepEqual(relativeImports(`/* import './ghost.mjs' */`), []);
  assert.deepEqual(relativeImports("const doc = `import './ghost.mjs'`;"), []);
});

// The hole that makes "closure integrity" a lie if left open: the module is loaded
// for real at runtime, but no static reading of the source can say which one.
test('a dynamic import with a computed target is reported, not silently skipped', () => {
  const tpl = moduleImports('const n = k;\nawait import(`./lib/${n}.mjs`);');
  assert.equal(tpl.unanalyzable.length, 1);
  assert.equal(tpl.specifiers.length, 0);

  const variable = moduleImports('await import(target);');
  assert.equal(variable.unanalyzable.length, 1);

  // A literal is analyzable, template quotes or not.
  assert.deepEqual(moduleImports('await import(`./lib/ok.mjs`);').unanalyzable, []);
  assert.deepEqual(moduleImports("await import('node:fs');").specifiers, ['node:fs']);
});

test('resolveFrom walks . and .. relative to the importer', () => {
  assert.equal(resolveFrom('scripts/a.mjs', './lib/x.mjs'), 'scripts/lib/x.mjs');
  assert.equal(resolveFrom('scripts/lib/a.mjs', './b.mjs'), 'scripts/lib/b.mjs');
  assert.equal(resolveFrom('hooks/h.mjs', '../scripts/lib/x.mjs'), 'scripts/lib/x.mjs');
  assert.equal(resolveFrom('scripts/lib/a.mjs', '../b.mjs'), 'scripts/b.mjs');
});

// Climbing past the package root can never resolve inside a tarball. Normalizing it
// to a bare filename would invent a path that happens to be in the shipped set.
test('resolveFrom returns null when the specifier escapes the package root', () => {
  assert.equal(resolveFrom('scripts/lib/a.mjs', '../../../escape.mjs'), null);
  assert.equal(resolveFrom('scripts/a.mjs', '../../x.mjs'), null);
});

test('closureViolations flags an import that escapes the package root', () => {
  const v = closureViolations(['scripts/lib/a.mjs'], () => `import x from '../../../out.mjs';`);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, 'escapes-root');
});

test('parsePackJson survives a lifecycle line printing a stray bracket first', () => {
  const noisy = `> hypomnema@1.0.0 prepare\n[some hook] ok\n[{"files":[{"path":"a"}],"entryCount":1}]`;
  assert.deepEqual(parsePackJson(noisy).files, [{ path: 'a' }]);
});

test('surfaceDiff reports both drift directions', () => {
  const d = surfaceDiff(['a', 'b', 'leaked'], ['a', 'b', 'dropped']);
  assert.deepEqual(d.added, ['leaked']);
  assert.deepEqual(d.removed, ['dropped']);
});

test('surfaceDiff is clean when the sets match regardless of order', () => {
  const d = surfaceDiff(['b', 'a'], ['a', 'b']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test('closureViolations catches a shipped module importing an unshipped file', () => {
  const sources = {
    'scripts/product.mjs': `import { x } from './lib/secret.mjs';`,
  };
  const v = closureViolations(Object.keys(sources), (p) => sources[p]);
  assert.equal(v.length, 1);
  assert.equal(v[0].from, 'scripts/product.mjs');
  assert.equal(v[0].resolved, 'scripts/lib/secret.mjs');
});

test('closureViolations passes when every import is itself shipped', () => {
  const sources = {
    'scripts/product.mjs': `import { x } from './lib/dep.mjs';`,
    'scripts/lib/dep.mjs': `export const x = 1;`,
  };
  const v = closureViolations(Object.keys(sources), (p) => sources[p]);
  assert.deepEqual(v, []);
});

test('closureViolations skips non-.mjs shipped files (docs, templates)', () => {
  const sources = { 'docs/GUIDE.md': `see ./lib/nope.mjs` };
  const v = closureViolations(Object.keys(sources), (p) => sources[p]);
  assert.deepEqual(v, []);
});

// The invariant the gate exists to protect: package.json's `files` is an
// allow-list, so a product script left off it silently vanishes from the tarball.
// These two read the real manifest and the real import graph, so they fail the
// moment the two disagree — no snapshot to regenerate, nothing to remember.
test('package.json files: every listed scripts/ path exists on disk', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  const listed = pkg.files.filter((f) => f.startsWith('scripts/'));
  assert.ok(listed.length > 0, 'files must enumerate scripts/ explicitly, not glob the directory');
  for (const rel of listed) {
    assert.ok(
      existsSync(new URL(`../${rel}`, import.meta.url)),
      `package.json "files" lists a script that does not exist: ${rel}`,
    );
  }
});

test('package.json files: no shipped script imports a script that is not shipped', () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf-8'));
  // hooks/ ships as a whole directory and reaches into scripts/lib, so it counts
  // as an importer even though it is not enumerated file-by-file.
  const hookFiles = readdirSync(new URL('hooks/', root))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `hooks/${f}`);
  const shipped = [...pkg.files.filter((f) => f.endsWith('.mjs')), ...hookFiles];
  const v = closureViolations(shipped, (p) => readFileSync(new URL(p, root), 'utf-8'));
  assert.deepEqual(
    v,
    [],
    `shipped modules import unshipped files (they would crash on npm install):\n` +
      v.map((x) => `  ${x.from} → ${x.resolved}`).join('\n'),
  );
});

// ── PR surface gate ──────────────────────────────────────────────────────────
// The PR title/body is a public artifact that is not a file in the repo, so no
// file-scanning gate ever saw it: a tracker id shipped in a PR title past a green
// Tracker-id gate, and 8 of 47 post-ban commits carried an attribution trailer.
suite('PR surface gate (check-pr-surface)');

// The template's OWN instructional comment used to quote a "Generated with"
// footer, which is why the reworded version below carries NO banned literal:
// the attribution scan now reads the RAW body (comments included, BLOCKER 1),
// so a fixture that still quoted the old phrasing would self-trip.
const PR_TEMPLATE_COMMENT = [
  '<!--',
  'PR title: Conventional Commits plus a scope. Keep any internal tracker id',
  '(FEAT-/IMPR-/ISSUE-/PRAC-) out of the title and body.',
  '',
  'Body language: write the full body TWICE, once under `# English` and once',
  'under `# 한국어`. Do NOT add a tool-attribution footer or a session URL of',
  'any kind.',
  '-->',
].join('\n');

// Every required subheading per .github/PULL_REQUEST_TEMPLATE.md, matched by
// checkPrSurface's own EN_SUBHEADINGS/KO_SUBHEADINGS lists.
const EN_SUBHEADINGS = ['What changed', 'Why', 'How', 'Manual verification', 'Migration notes'];

const KO_SUBHEADINGS = ['변경 내용', '이유', '방법', '수동 검증', '마이그레이션 노트'];

// A single language block, fully filled by default (every required subheading,
// each with real content) — a fixture built from this is what "actually filled
// the template" means, not just "carries the H1". `omit` drops named
// subheadings; `empty` keeps every subheading but writes no content under any
// of them (the unfilled-template shape).
function languageBlock(h1, subheadings, { omit = [], empty = false } = {}) {
  const lines = [`# ${h1}`, ''];
  for (const s of subheadings) {
    if (omit.includes(s)) continue;
    lines.push(`## ${s}`, '');
    if (!empty) lines.push(`Detail for ${s}.`, '');
  }
  return lines;
}

function changelogBlock(changelog) {
  return changelog === null ? [] : ['## Changelog', '', ...changelog, ''];
}

function checklistBlock(checklist) {
  return checklist ? ['## Checklist', '', '- [x] `npm test` passes locally', ''] : [];
}

// Compose a PR body from named blocks, in a given ORDER — the default order
// matches the template exactly. Passing a reordered `order` array is how the
// section-order regression tests build an out-of-order body without
// duplicating the whole block-construction logic.
function prBody({
  english = true,
  korean = true,
  changelog = null,
  checklist = true,
  engOpts = {},
  korOpts = {},
  order = ['english', 'korean', 'changelog', 'checklist'],
} = {}) {
  const blocks = {
    english: english ? languageBlock('English', EN_SUBHEADINGS, engOpts) : [],
    korean: korean ? languageBlock('한국어', KO_SUBHEADINGS, korOpts) : [],
    changelog: changelogBlock(changelog),
    checklist: checklistBlock(checklist),
  };
  const lines = [PR_TEMPLATE_COMMENT, ''];
  for (const key of order) lines.push(...blocks[key]);
  return lines.join('\n');
}

const GOOD_CHANGELOG = ['- EN: Add a PR surface gate.', '- KO: PR 표면 게이트를 추가한다.'];

const GOOD_TITLE = 'feat(ci): gate the PR title and body';

// A body that is ACTUALLY a filled template: both language blocks carry every
// required subheading with real content, in the right order.
const goodBody = () => prBody({ changelog: GOOD_CHANGELOG });

function rulesOf(res) {
  return res.violations.map((v) => v.rule);
}

test('PR surface: a template-compliant title/body passes (no false positive)', () => {
  const res = checkPrSurface({ title: GOOD_TITLE, body: goodBody() });
  assert.equal(
    res.ok,
    true,
    `expected clean, got: ${res.violations.map((v) => `${v.rule}/${v.detail}`).join(' | ')}`,
  );
  assert.equal(res.violations.length, 0);
});

test('PR surface: the reworded template instructional comment does not self-trip any rule', () => {
  // The comment used to quote "Generated with ..." and relied on a
  // comment-stripping exemption to avoid tripping the attribution scan
  // (BLOCKER 1). The exemption is gone; the fix is that the comment no longer
  // carries any banned literal, so the RAW scan finds nothing here.
  const res = checkPrSurface({ title: GOOD_TITLE, body: goodBody() });
  assert.equal(
    res.violations.filter((v) => v.rule === 'attribution').length,
    0,
    'reworded template instructional comment must not self-trip the attribution scan',
  );
});

test('PR surface: an attribution trailer hidden inside an HTML comment is REJECTED (BLOCKER 1)', () => {
  // The exact hole that shipped: comment-stripping the body before the
  // attribution scan let `<!-- Co-Authored-By: ... -->` through clean, because
  // GitHub does not RENDER an HTML comment — but the raw body text (what
  // `gh pr create --body-file` actually submits) still carries it.
  const body = goodBody() + '\n<!-- Co-Authored-By: Claude <noreply@anthropic.com> -->\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(
    res.ok,
    false,
    'an attribution trailer inside an HTML comment must still be rejected',
  );
  const hit = res.violations.find((v) => v.rule === 'attribution');
  assert.ok(hit, 'expected an attribution violation even though the trailer is commented out');
  assert.equal(hit.surface, 'body');
});

test('PR surface: Co-Authored-By trailer in the body is caught', () => {
  const body = goodBody() + '\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'attribution');
  assert.ok(hit, 'expected an attribution violation');
  assert.equal(hit.surface, 'body');
  assert.match(hit.detail, /Co-Authored-By:/i);
});

test('PR surface: a full-width-colon confusable attribution trailer (CONCERN 4) is still rejected', () => {
  // \uFF1A (fullwidth colon) NFKC-folds to ASCII ':' — written as an explicit
  // escape, never a literal confusable byte, in this source file.
  const body = goodBody() + `\nCo-Authored-By\uFF1A Claude <noreply@anthropic.com>\n`;
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false, 'full-width colon confusable must not bypass the PR-surface gate');
  assert.ok(res.violations.some((v) => v.rule === 'attribution'));
});

test('PR surface: Claude-Session trailer in the body is caught', () => {
  const body = goodBody() + '\nClaude-Session: https://claude.ai/code/session_01Urs3\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false);
  const attribution = res.violations.filter((v) => v.rule === 'attribution');
  // Trips two patterns: the trailer key and the session URL.
  assert.ok(attribution.some((v) => /Claude-Session:/i.test(v.detail)));
  assert.ok(attribution.some((v) => /claude\.ai\/code\/session/i.test(v.detail)));
});

test('PR surface: the robot-emoji "Generated with" footer is caught (both patterns)', () => {
  const body = goodBody() + '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false);
  const attribution = res.violations.filter((v) => v.rule === 'attribution');
  assert.ok(
    attribution.some((v) => /Generated with/i.test(v.detail)),
    'expected "Generated with"',
  );
  assert.ok(
    attribution.some((v) => /🤖/.test(v.detail)),
    'expected the robot-emoji marker',
  );
});

test('PR surface: attribution in the TITLE is caught', () => {
  const res = checkPrSurface({
    title: 'feat(ci): gate the PR surface 🤖 Generated with [Claude Code]',
    body: goodBody(),
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.rule === 'attribution' && v.surface === 'title'));
});

test('PR surface: a tracker id in the PR TITLE is caught (the hole that shipped)', () => {
  // This exact shape passed CI: the Tracker-id gate scans the checkout, and a PR
  // title is not a file in the checkout.
  const res = checkPrSurface({ title: 'feat(gate): close ISSUE-49', body: goodBody() });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'tracker-ids');
  assert.ok(hit, 'expected a tracker-id violation');
  assert.equal(hit.surface, 'title');
  assert.match(hit.detail, /ISSUE-49/);
});

test('PR surface: tracker ids in the body are caught (all wiki prefixes)', () => {
  for (const id of ['ISSUE-49', 'FEAT-12', 'IMPR-3', 'PRAC-7', 'fix #37']) {
    const body = goodBody() + `\nImplements ${id} from the wiki.\n`;
    const res = checkPrSurface({ title: GOOD_TITLE, body });
    assert.equal(res.ok, false, `${id} should be blocked`);
    assert.ok(
      res.violations.some((v) => v.rule === 'tracker-ids' && v.surface === 'body'),
      `${id} should be a body tracker-id violation`,
    );
  }
});

test('PR surface: a legitimate GitHub ref (#123 / PR #50) is NOT flagged', () => {
  const body = goodBody() + '\nFollows up on #123 and PR #50.\n';
  const res = checkPrSurface({ title: 'feat(ci): gate the PR surface (#194)', body });
  assert.equal(res.ok, true, 'GitHub refs are legitimate and must never be flagged');
});

test('PR surface: a CRLF body (GitHub web-UI edit) still passes — no false positive', () => {
  // The `edited` trigger fires on web-UI edits, whose bodies come back CRLF, so
  // CRLF is a COMMON input to this gate rather than an edge case. A compliant body
  // must pass whatever the line endings are, and a dirty one must still be caught.
  const crlf = (s) => s.replace(/\n/g, '\r\n');
  const clean = checkPrSurface({ title: GOOD_TITLE, body: crlf(goodBody()) });
  assert.equal(
    clean.ok,
    true,
    `CRLF body must not false-positive: ${clean.violations.map((v) => v.rule).join(', ')}`,
  );
  const dirty = checkPrSurface({
    title: GOOD_TITLE,
    body: crlf(goodBody() + '\nCo-Authored-By: Claude\n'),
  });
  assert.equal(dirty.ok, false, 'CRLF must not smuggle an attribution trailer through');
});

test('PR surface: a missing `# English` block is caught', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ english: false, changelog: GOOD_CHANGELOG }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'bilingual');
  assert.ok(hit);
  assert.match(hit.detail, /English/);
});

test('PR surface: a missing `# 한국어` block is caught', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ korean: false, changelog: GOOD_CHANGELOG }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'bilingual');
  assert.ok(hit);
  assert.match(hit.detail, /한국어/);
});

test('PR surface: a missing `## Changelog` section is caught', () => {
  const res = checkPrSurface({ title: GOOD_TITLE, body: prBody({ changelog: null }) });
  assert.equal(res.ok, false);
  assert.ok(rulesOf(res).includes('changelog'));
});

test('PR surface: `## Changelog` with an unfilled `- EN:` / `- KO:` is caught', () => {
  // The template ships these lines EMPTY; an unedited template must not pass.
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: ['- EN:', '- KO:'] }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'changelog');
  assert.ok(hit);
  assert.match(hit.detail, /empty EN line/);
});

test('PR surface: `## Changelog` missing only the KO line is caught', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: ['- EN: Add a PR surface gate.'] }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'changelog');
  assert.ok(hit);
  assert.match(hit.detail, /missing or empty KO line/);
});

test('PR surface: `## Changelog` of `None` passes (internal-only change)', () => {
  assert.equal(
    checkPrSurface({ title: GOOD_TITLE, body: prBody({ changelog: ['None'] }) }).ok,
    true,
  );
  assert.equal(
    checkPrSurface({ title: GOOD_TITLE, body: prBody({ changelog: ['- None'] }) }).ok,
    true,
  );
});

test('PR surface: a missing `## Checklist` section is caught', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: GOOD_CHANGELOG, checklist: false }),
  });
  assert.equal(res.ok, false);
  assert.ok(rulesOf(res).includes('checklist'));
});

// ── BLOCKER 2: template compliance was a heading-existence check, not a
// structure check ─────────────────────────────────────────────────────────
suite('BLOCKER 2: template compliance is a structure check, not heading-existence');

test('PR surface: headings that exist ONLY inside a code fence are rejected (not real headings)', () => {
  // A body that wraps its entire structure in a fenced code block used to pass:
  // hasHeading() scanned raw text and did not know it was looking at example
  // text inside ``` fences.
  const fenced = ['```', goodBody(), '```'].join('\n');
  const res = checkPrSurface({ title: GOOD_TITLE, body: fenced });
  assert.equal(res.ok, false, 'fenced-only headings must not satisfy the template check');
  assert.ok(
    rulesOf(res).includes('bilingual'),
    'a fence-only body has no REAL # English / # 한국어',
  );
});

test('PR surface: a body with sections out of order is rejected', () => {
  // # 한국어 before # English.
  const swapped = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({
      changelog: GOOD_CHANGELOG,
      order: ['korean', 'english', 'changelog', 'checklist'],
    }),
  });
  assert.equal(swapped.ok, false);
  assert.ok(rulesOf(swapped).includes('order'), 'Korean-before-English must be an order violation');

  // ## Changelog before # 한국어.
  const changelogFirst = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({
      changelog: GOOD_CHANGELOG,
      order: ['english', 'changelog', 'korean', 'checklist'],
    }),
  });
  assert.equal(changelogFirst.ok, false);
  assert.ok(rulesOf(changelogFirst).includes('order'));

  // ## Checklist before ## Changelog.
  const checklistFirst = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({
      changelog: GOOD_CHANGELOG,
      order: ['english', 'korean', 'checklist', 'changelog'],
    }),
  });
  assert.equal(checklistFirst.ok, false);
  assert.ok(rulesOf(checklistFirst).includes('order'));
});

test('PR surface: correctly-ordered sections do not trip the order rule', () => {
  assert.ok(!rulesOf(checkPrSurface({ title: GOOD_TITLE, body: goodBody() })).includes('order'));
});

test('PR surface: a language block missing a required subheading is rejected', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: GOOD_CHANGELOG, engOpts: { omit: ['Why'] } }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'template-sections');
  assert.ok(hit, 'expected a template-sections violation');
  assert.match(hit.detail, /English/);
  assert.match(hit.detail, /Why/);
});

test('PR surface: the Korean block missing a required subheading is rejected', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: GOOD_CHANGELOG, korOpts: { omit: ['이유'] } }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'template-sections');
  assert.ok(hit, 'expected a template-sections violation');
  assert.match(hit.detail, /한국어/);
  assert.match(hit.detail, /이유/);
});

test('PR surface: a language block with every subheading but NO content is rejected (empty)', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: GOOD_CHANGELOG, engOpts: { empty: true } }),
  });
  assert.equal(res.ok, false);
  const hit = res.violations.find((v) => v.rule === 'template-sections');
  assert.ok(hit, 'headings-only English block must be rejected as empty');
  assert.match(hit.detail, /no content/);
});

test('PR surface: a fully filled template (every subheading, real content, correct order) passes', () => {
  const res = checkPrSurface({ title: GOOD_TITLE, body: goodBody() });
  assert.equal(
    res.ok,
    true,
    `expected clean: ${res.violations.map((v) => `${v.rule}/${v.detail}`).join(' | ')}`,
  );
});

test('PR surface: an empty body reports the structural rules, does not throw', () => {
  for (const body of ['', null, undefined]) {
    const res = checkPrSurface({ title: GOOD_TITLE, body });
    assert.equal(res.ok, false);
    for (const rule of ['bilingual', 'changelog', 'checklist']) {
      assert.ok(rulesOf(res).includes(rule), `empty body should report ${rule}`);
    }
  }
});

test('PR surface: EVERY violation carries a non-empty, actionable fix', () => {
  // A gate that reports a violation with no way through gets worked around
  // instead of obeyed, so the fix field is load-bearing, not decoration.
  const res = checkPrSurface({
    title: 'feat(gate): close ISSUE-49 🤖 Generated with [Claude Code]',
    body: 'Co-Authored-By: Claude <noreply@anthropic.com>\n',
  });
  assert.equal(res.ok, false);
  assert.ok(res.violations.length >= 5, 'fixture should trip every rule');
  for (const v of res.violations) {
    assert.equal(typeof v.fix, 'string', `${v.rule}: fix must be a string`);
    assert.ok(v.fix.trim().length > 0, `${v.rule}: fix must not be empty`);
    assert.ok(typeof v.detail === 'string' && v.detail.length > 0, `${v.rule}: detail required`);
    assert.ok(['title', 'body'].includes(v.surface), `${v.rule}: surface must be title|body`);
    // Every fix names a concrete command the author can run.
    assert.match(v.fix, /gh pr edit/, `${v.rule}: fix must name the command that resolves it`);
  }
});

test('ATTRIBUTION_PATTERNS is a separate export, NOT merged into BLOCKED_PATTERNS', () => {
  // BLOCKED_PATTERNS is applied by `--all` to the whole shipped tree, where docs
  // (CLAUDE.md, the PR template) legitimately QUOTE an attribution trailer while
  // telling you not to write one. Merging the two sets would fail the repo scan.
  const blockedNames = new Set(BLOCKED_PATTERNS.map((p) => p.name));
  for (const p of ATTRIBUTION_PATTERNS) {
    assert.ok(!blockedNames.has(p.name), `${p.name} must not leak into BLOCKED_PATTERNS`);
  }
  assert.ok(!TAG_BODY_PATTERNS.some((p) => ATTRIBUTION_PATTERNS.includes(p)));
  // The doc line that QUOTES a trailer stays clean under the file-scan patterns.
  const doc = 'Do NOT add any "Generated with ..." footer, no Co-Authored-By: line.';
  assert.equal(scanText(doc, BLOCKED_PATTERNS).length, 0);
  assert.equal(scanText(doc, [...BLOCKED_PATTERNS, ...DECISION_PATTERNS]).length, 0);
  // ...and is caught by the attribution set, which only authored surfaces use.
  assert.ok(scanText(doc, ATTRIBUTION_PATTERNS).length > 0);
});

test('ATTRIBUTION_PATTERNS: every regex is global (a non-global re hangs scanText)', () => {
  // scanText drives re.exec() in a while loop with manual lastIndex handling: a
  // non-global regex never advances, so the loop spins forever — the suite hangs
  // instead of failing.
  for (const p of ATTRIBUTION_PATTERNS) {
    assert.ok(p.re.global, `${p.name}: regex must carry the /g flag`);
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.label, 'string');
  }
});

test('CLI --commit-msg: rejects an attribution trailer (exit 1)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(
      f,
      'feat(gate): add the PR surface gate\n\nBody prose.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
    );
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Co-Authored-By:/i);
    assert.match(r.stderr, /no attribution/i); // the way out is printed
  });
});

test('CLI --commit-msg: rejects a Claude-Session trailer and a robot footer (exit 1)', () => {
  withTmpDir((dir) => {
    for (const trailer of [
      'Claude-Session: https://claude.ai/code/session_01Urs3',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ]) {
      const f = join(dir, 'MSG');
      writeFileSync(f, `feat(gate): thing\n\nBody prose.\n\n${trailer}\n`);
      assert.equal(runChecker(['--commit-msg', f]).status, 1, `${trailer} must be rejected`);
    }
  });
});

test('CLI --commit-msg: a clean message still passes (attribution scan adds no false positive)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(f, 'feat(ci): gate the PR title and body (#194)\n\nSee PR #50. ADR 0040.\n');
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 0, r.stderr);
  });
});

// ── --commit-range: the CI backstop (BLOCKER: commit-msg hook has no CI
// counterpart, so --no-verify + a clean PR body let a trailer reach `main`) ──
suite('--commit-range: the CI backstop');
function commitIn(dir, msg) {
  const opts = { cwd: dir, encoding: 'utf-8' };
  spawnSync('git', ['add', '-A'], opts);
  spawnSync('git', ['commit', '-q', '-m', msg], opts);
  return spawnSync('git', ['rev-parse', 'HEAD'], opts).stdout.trim();
}

test('CLI --commit-range: rejects an attribution trailer on ANY commit in the range', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const base = commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    commitIn(dir, 'feat: clean commit');
    writeFileSync(join(dir, 'c.txt'), 'three\n');
    // The dirty commit sits in the MIDDLE of the range, not just at HEAD — the
    // range scan must not stop at the tip.
    commitIn(dir, 'feat: dirty commit\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    writeFileSync(join(dir, 'd.txt'), 'four\n');
    const trueHead = commitIn(dir, 'chore: trailing clean commit');
    const r = runChecker(['--commit-range', `${base}..${trueHead}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Co-Authored-By:/i);
    assert.match(r.stderr, /no attribution/i); // the way out is printed
  });
});

test('CLI --commit-range: a tracker id in a commit message anywhere in the range is caught', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const base = commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const head = commitIn(dir, 'feat: thing\n\nImplements fix #99.');
    const r = runChecker(['--commit-range', `${base}..${head}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /fix #99/);
  });
});

test('CLI --commit-range: a clean range passes (exit 0)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const base = commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const head = commitIn(dir, 'feat: thing (#101)\n\nSee PR #50. ADR 0040.');
    const r = runChecker(['--commit-range', `${base}..${head}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 0, r.stderr);
  });
});

test('--commit-msg and --commit-range agree on the SAME message (one judgment, ADR 0046)', () => {
  // Proves the two entry points cannot drift: both must reject (or both must
  // accept) the identical message text, because both call judgeMessage().
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const base = commitIn(dir, 'chore: base');
    const msg = 'feat: thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>';
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const head = commitIn(dir, msg);

    const msgFile = join(dir, 'MSG');
    writeFileSync(msgFile, msg + '\n');
    const single = runChecker(['--commit-msg', msgFile], { CHECK_TRACKER_ROOT: dir });
    const range = runChecker(['--commit-range', `${base}..${head}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(single.status, 1, single.stderr);
    assert.equal(range.status, 1, range.stderr);
    assert.match(single.stderr, /Co-Authored-By:/i);
    assert.match(range.stderr, /Co-Authored-By:/i);
  });
});

test('CLI --commit-range: an unresolvable range exits 2 (git error), not a crash', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitIn(dir, 'chore: base');
    const r = runChecker(['--commit-range', 'deadbeefdead..cafebabecafe'], {
      CHECK_TRACKER_ROOT: dir,
    });
    assert.equal(r.status, 2);
  });
});

test('CLI --commit-range: missing range argument exits with usage (2)', () => {
  assert.equal(runChecker(['--commit-range']).status, 2);
});

// ── BLOCKER: SQUASH merge. The pr-surface job scans base.sha..head.sha — the PR
// BRANCH's commits. The message that actually lands on `main` is composed in the
// merge dialog, never existed on the branch, and was in NO range any job scanned.
// A trailer typed there ships to a public `main` with every check green.
suite('BLOCKER: squash-merge trailer escapes the branch-range scan (--push-range)');
test('CLI --push-range: an attribution trailer in the pushed (squash) commit is caught', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const before = commitIn(dir, 'chore: base');
    // the squash commit: its message exists ONLY on main, never on the PR branch
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const after = commitIn(
      dir,
      'feat: squashed (#194)\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    );
    const r = runChecker(['--push-range', `${before}..${after}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Co-Authored-By:/i);
    assert.match(r.stderr, /no attribution/i); // the way out is printed
  });
});

test('CLI --push-range: a tracker id in the pushed commit is caught', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const before = commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const after = commitIn(dir, 'feat: thing\n\nCloses ISSUE-49.');
    const r = runChecker(['--push-range', `${before}..${after}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ISSUE-49/);
  });
});

test('CLI --push-range: an all-zero `before` (first push / force-push) falls back to the tip, not to nothing', () => {
  // GitHub sends 40 zeros as github.event.before on a branch's first push, and a
  // stale sha after a force-push. `before..after` would blow up (exit 2 — red for
  // the wrong reason) or scan nothing at all. Scanning the tip is less than the
  // full range and infinitely more than zero.
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const after = commitIn(
      dir,
      'feat: dirty tip\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    );
    const r = runChecker(['--push-range', `${'0'.repeat(40)}..${after}`], {
      CHECK_TRACKER_ROOT: dir,
    });
    assert.equal(r.status, 1, `the tip must still be scanned: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Co-Authored-By:/i);
  });
});

test('CLI --push-range: an unresolvable `before` (discarded by a force-push) falls back to the tip', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const after = commitIn(dir, 'feat: dirty tip\n\nCo-Authored-By: Claude');
    const r = runChecker(['--push-range', `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef..${after}`], {
      CHECK_TRACKER_ROOT: dir,
    });
    assert.equal(r.status, 1, `a stale before must not swallow the scan: ${r.stdout}${r.stderr}`);
  });
});

test('CLI --push-range: a ROOT commit (no parent) is scanned as a single commit, not a crash', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const root = commitIn(dir, 'chore: root\n\nCo-Authored-By: Claude');
    const r = runChecker(['--push-range', `${'0'.repeat(40)}..${root}`], {
      CHECK_TRACKER_ROOT: dir,
    });
    assert.equal(r.status, 1, `a root commit has no ^1 to fall back to: ${r.stdout}${r.stderr}`);
  });
});

test('CLI --push-range: a clean push passes (exit 0)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    const before = commitIn(dir, 'chore: base');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const after = commitIn(dir, 'feat: thing (#101)\n\nSee PR #50. ADR 0040.');
    const r = runChecker(['--push-range', `${before}..${after}`], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 0, r.stderr);
  });
});

test('CLI --push-range: missing / malformed argument exits with usage (2)', () => {
  assert.equal(runChecker(['--push-range']).status, 2);
  assert.equal(runChecker(['--push-range', 'not-a-range']).status, 2);
});

test('CI: a push to main scans the commit messages the push ADDED (squash-merge hole)', () => {
  // Without this job the squash-merge message — the one that actually lands on
  // `main` — is scanned by nothing at all: the pr-surface job only sees the PR
  // branch's own commits, and the push workflow only ran file scanners.
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf-8');
  assert.match(
    ci,
    /check-tracker-ids\.mjs --push-range/,
    'ci.yml must scan the commit messages a push to main adds',
  );
  assert.match(ci, /github\.event\.before/, 'the push range starts at github.event.before');
  assert.match(ci, /github\.event\.after/, 'the push range ends at github.event.after');
  // The job must actually run on push (the pr-surface job is skipped there).
  assert.match(
    ci,
    /if:\s*github\.event_name == 'push'/,
    'the commit-message scan must be gated on the push event',
  );
});

test('CI: pr-surface job checks out fetch-depth:0 and scans the PR commit range', () => {
  // Regression for BLOCKER 3: a shallow checkout (the default) does not have the
  // base commit locally, so `base..head` cannot resolve without fetch-depth:0.
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf-8');
  assert.match(
    ci,
    /fetch-depth:\s*0/,
    'pr-surface checkout must use fetch-depth: 0 to resolve base..head',
  );
  assert.match(
    ci,
    /check-tracker-ids\.mjs --commit-range/,
    'ci.yml must scan the PR commit range, not just the title/body',
  );
  assert.match(ci, /base\.sha/);
  assert.match(ci, /head\.sha/);
});

function runPrSurface(args, env = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'check-pr-surface.mjs'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, GITHUB_EVENT_PATH: '', ...env },
  });
}

test('CLI --github-event: a dirty PR payload exits 1 and prints every fix', () => {
  withTmpDir((dir) => {
    const ev = join(dir, 'event.json');
    writeFileSync(
      ev,
      JSON.stringify({
        pull_request: {
          title: 'feat(gate): close ISSUE-49',
          body: 'no template here\n\n🤖 Generated with [Claude Code]\n',
        },
      }),
    );
    const r = runPrSurface([`--github-event=${ev}`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ISSUE-49/);
    assert.match(r.stderr, /Generated with/i);
    assert.match(r.stderr, /fix:/); // the resolution path is printed, not just the verdict
    assert.match(r.stderr, /gh pr edit/);
  });
});

test('CLI --github-event: a compliant PR payload exits 0', () => {
  withTmpDir((dir) => {
    const ev = join(dir, 'event.json');
    writeFileSync(ev, JSON.stringify({ pull_request: { title: GOOD_TITLE, body: goodBody() } }));
    const r = runPrSurface([`--github-event=${ev}`]);
    assert.equal(r.status, 0, r.stderr);
  });
});

test('CLI --github-event: a null body (empty PR) is a violation, not a crash', () => {
  withTmpDir((dir) => {
    const ev = join(dir, 'event.json');
    writeFileSync(ev, JSON.stringify({ pull_request: { title: GOOD_TITLE, body: null } }));
    const r = runPrSurface([`--github-event=${ev}`, '--json']);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.violations.some((v) => v.rule === 'bilingual'));
  });
});

test('CLI --github-event: a non-pull_request payload passes through (push events)', () => {
  withTmpDir((dir) => {
    const ev = join(dir, 'event.json');
    writeFileSync(ev, JSON.stringify({ ref: 'refs/heads/main' }));
    assert.equal(runPrSurface([`--github-event=${ev}`]).status, 0);
  });
});

test('CLI --title/--body-file: local pre-flight mode works', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'BODY.md');
    writeFileSync(f, goodBody());
    assert.equal(runPrSurface([`--title=${GOOD_TITLE}`, `--body-file=${f}`]).status, 0);
    writeFileSync(f, goodBody() + '\nCo-Authored-By: Claude\n');
    assert.equal(runPrSurface([`--title=${GOOD_TITLE}`, `--body-file=${f}`]).status, 1);
  });
});

test('CI: the pull_request trigger lists `edited` (else a body edit bypasses the gate)', () => {
  // Default types are [opened, synchronize, reopened]. Without `edited`, an author
  // opens a clean PR, then edits an attribution footer into the body and NO job
  // re-runs. The gate would be a two-step bypass.
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf-8');
  const types = ci.match(/^\s*types:\s*\[(.+)\]\s*$/m);
  assert.ok(types, 'ci.yml pull_request trigger must declare types:');
  for (const t of ['opened', 'edited', 'reopened', 'synchronize']) {
    assert.match(types[1], new RegExp(`\\b${t}\\b`), `pull_request types must include ${t}`);
  }
  assert.match(ci, /check-pr-surface\.mjs/, 'ci.yml must run the pr-surface gate');
  // As a TRIGGER KEY (a prose mention in a comment explaining why it is not used
  // is fine). pull_request_target would run fork code with a write-scoped token
  // for no benefit: the title and body are already in the event payload.
  assert.ok(!/^\s*pull_request_target:/m.test(ci), 'pull_request_target must not be a trigger');
});

// ── BLOCKER: ADR / decisions pointers were left out of the PR-surface scan
// entirely, so the one rule that names `decisions/NNNN` had no enforcement on the
// one surface an agent writes by hand. The `## Changelog` block keeps the same
// exemption CHANGELOG.md has in the file gate — and only that block.
suite('PR surface gate — ADR pointers (BLOCKER 4)');

test('PR surface: `ADR NNNN` in the PR BODY is rejected', () => {
  const body = goodBody() + '\nRationale lives in ADR 0031.\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false, 'an ADR pointer resolves to nothing outside the private wiki');
  const hit = res.violations.find((v) => v.rule === 'tracker-ids' && /ADR/.test(v.detail));
  assert.ok(hit, `expected an ADR violation: ${JSON.stringify(res.violations)}`);
  assert.equal(hit.surface, 'body');
});

test('PR surface: `ADR-NNNN` and `decisions/NNNN` in the body are rejected', () => {
  for (const ref of ['ADR-0031', 'decisions/0031-foo.md']) {
    const res = checkPrSurface({ title: GOOD_TITLE, body: goodBody() + `\nSee ${ref}.\n` });
    assert.equal(res.ok, false, `${ref} must be blocked`);
    assert.ok(res.violations.some((v) => v.rule === 'tracker-ids' && v.surface === 'body'));
  }
});

test('PR surface: an ADR pointer in the TITLE is rejected', () => {
  const res = checkPrSurface({ title: 'feat(sync): implement ADR 0031', body: goodBody() });
  assert.equal(res.ok, false);
  assert.ok(
    res.violations.some((v) => v.rule === 'tracker-ids' && v.surface === 'title'),
    'the title has no changelog exemption',
  );
});

test('PR surface: an ADR pointer INSIDE the `## Changelog` block is ALLOWED', () => {
  // The release collector copies this block verbatim into CHANGELOG.md, which is
  // itself ADR-exempt in the file gate. Blocking it here would make a line the
  // file gate explicitly allows unwritable through the only path that writes it.
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({
      changelog: ['- EN: Adopt the projection model from ADR 0031.', '- KO: ADR 0031 반영.'],
    }),
  });
  assert.equal(
    res.ok,
    true,
    `the changelog block keeps CHANGELOG.md's ADR exemption: ${res.violations.map((v) => v.detail).join(' | ')}`,
  );
});

test('PR surface: the changelog exemption does NOT leak past the section boundary', () => {
  // Only the `## Changelog` body is exempt. The section ends at the next heading;
  // an ADR ref under `## Checklist` is as public as one anywhere else.
  const body = prBody({ changelog: GOOD_CHANGELOG }) + '\n- [x] filed ADR 0031\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false, 'the exemption must stop at the Changelog section boundary');
  assert.ok(res.violations.some((v) => /ADR/.test(v.detail)));
});

test('PR surface: a tracker id inside `## Changelog` is STILL rejected (only ADR is exempt)', () => {
  const res = checkPrSurface({
    title: GOOD_TITLE,
    body: prBody({ changelog: ['- EN: Close ISSUE-49.', '- KO: ISSUE-49 종료.'] }),
  });
  assert.equal(res.ok, false, 'the CHANGELOG exemption covers ADR refs only, never tracker ids');
  assert.ok(res.violations.some((v) => v.rule === 'tracker-ids' && /ISSUE-49/.test(v.detail)));
});

test('commit messages still ALLOW `ADR NNNN` (this change does not touch that judgment)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(f, 'feat: thing (#101)\n\nImplements ADR 0040.\n');
    assert.equal(
      runChecker(['--commit-msg', f]).status,
      0,
      'the commit-msg gate has always let ADR refs through — that stays true',
    );
  });
});

// ── BLOCKER: a raw HTML block fooled the structural view. `<pre>` + a perfect
// template + `</pre>` passed every heading check while GitHub rendered a code
// listing with no headings in it at all.
// The structural check does NOT model raw HTML blocks, and these two tests pin
// that as a decision rather than leaving a silent gap for a later round to
// "fix". Wrapping a PR body in <pre> or <div> makes GitHub render it as a code
// listing, so strictly its `#` lines are not headings and the template check
// should reject it. An earlier round built a GFM block parser to say so, and
// paid for it with an unbounded stream of edge cases (block types 3-5, entity-
// encoded tags, `&Tab;`).
//
// It is not worth it, because it defends against nobody. This gate is
// maintainer-only tooling on trusted input; the actor is an agent following its
// harness, and no agent wraps a PR body in a div by accident. Someone who does
// it deliberately has only fooled themselves into an unreadable PR — self-harm,
// not a failure mode. The rule that actually matters survives untouched, and the
// third test here is what proves it: the banned-string scan reads the RAW body,
// so an attribution trailer inside <pre> is still rejected.
suite('PR surface gate — HTML blocks are not modeled (accepted, by design)');

test('PR surface: a body wrapped in <pre> SATISFIES the template check (accepted self-harm)', () => {
  const body = '<pre>\n' + goodBody() + '\n</pre>';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(
    res.ok,
    true,
    'the structural check reads the text, not GitHub rendering: an agent does not do this by accident',
  );
});

test('PR surface: <code> / <div> blocks are likewise not modeled', () => {
  const contiguous = [
    ...languageBlock('English', EN_SUBHEADINGS),
    ...languageBlock('한국어', KO_SUBHEADINGS),
    ...changelogBlock(GOOD_CHANGELOG),
    ...checklistBlock(true),
  ].filter((l) => l.trim() !== '');
  for (const tag of ['code', 'div']) {
    const body = `<${tag}>\n${contiguous.join('\n')}\n</${tag}>`;
    const res = checkPrSurface({ title: GOOD_TITLE, body });
    assert.equal(res.ok, true, `<${tag}>: no GFM block parser, by design`);
  }
});

test('PR surface: a 4-space-indented body does NOT satisfy the template check', () => {
  const indented = goodBody()
    .split('\n')
    .map((l) => (l.trim() === '' ? l : '    ' + l))
    .join('\n');
  const res = checkPrSurface({ title: GOOD_TITLE, body: indented });
  assert.equal(res.ok, false, 'a 4-space indent makes it a code block, not headings');
  assert.ok(rulesOf(res).includes('bilingual'));
});

test('PR surface: an attribution trailer inside <pre> is STILL rejected (structure ≠ scan)', () => {
  // Stripping HTML blocks is a STRUCTURAL concern only. The attribution/tracker
  // scan still reads the RAW body: hiding a trailer in a <pre> block does not
  // un-ship it.
  const body = goodBody() + '\n<pre>\nCo-Authored-By: Claude <noreply@anthropic.com>\n</pre>\n';
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.rule === 'attribution'));
});

test('PR surface: a compliant body that MENTIONS html/indentation still passes (no false positive)', () => {
  // Prose an author really writes: a wrapped line that happens to be indented, and
  // an inline `<br>`. Neither is structure, and neither may cost the author a
  // violation.
  const body = prBody({ changelog: GOOD_CHANGELOG }).replace(
    'Detail for Why.',
    'Detail for Why,\n    wrapped and indented as a lazy continuation with a <br> in it.',
  );
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(
    res.ok,
    true,
    `a compliant body must not trip the structural check: ${res.violations.map((v) => `${v.rule}/${v.detail}`).join(' | ')}`,
  );
});

// GFM renders an ATX heading indented 0-3 spaces and treats 4+ as code. The gate
// used to anchor every heading at column 0, so a body whose headings carried a
// single stray space was rejected for `bilingual`, `changelog` and `checklist` at
// once — a legitimate, correctly-rendering PR blocked outright, which is the worst
// failure a gate has. The ` {0,3}` bound on every heading matcher is what fixes it,
// and it is also what lets the indented-code stripper go: at 4 spaces the matchers
// simply stop matching, so the heading is code again with no state machine to
// maintain.
suite('PR surface gate — GFM heading indent (0-3 renders, 4+ is code)');

test('PR surface: headings indented 0-3 spaces are headings (a stray space must not block a PR)', () => {
  for (const n of [0, 1, 2, 3]) {
    const indent = ' '.repeat(n);
    const body = goodBody()
      .split('\n')
      .map((l) => (/^#/.test(l) ? indent + l : l))
      .join('\n');
    const res = checkPrSurface({ title: GOOD_TITLE, body });
    assert.equal(
      res.ok,
      true,
      `${n}-space indent renders as a heading on GitHub, so it must pass: ${res.violations.map((v) => v.rule).join(',')}`,
    );
  }
});

// The other half of the ATX shape. A closing run of `#` is optional and means
// nothing to GFM, so `## Changelog ##` is the same H2 — and rejecting it is the
// same false positive as rejecting a one-space indent, wearing a different hat.
test('PR surface: optional closing hashes (`## Changelog ##`) are a heading, not a violation', () => {
  const body = goodBody()
    .split('\n')
    .map((l) => (/^#/.test(l) ? `${l} ${l.match(/^#+/)[0]}` : l))
    .join('\n');
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(
    res.ok,
    true,
    `GFM renders these as ordinary headings: ${res.violations.map((v) => v.rule).join(',')}`,
  );
  assert.deepEqual(
    parseChangelogBlock(body),
    { en: 'Add a PR surface gate.', ko: 'PR 표면 게이트를 추가한다.' },
    'and the collector reads the same heading',
  );
});

test('PR surface: a 4-space heading indent is code, not a heading (no stripper needed)', () => {
  const body = goodBody()
    .split('\n')
    .map((l) => (/^#/.test(l) ? '    ' + l : l))
    .join('\n');
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, false, '4 spaces makes it an indented code block');
  assert.ok(rulesOf(res).includes('bilingual'));
});

// The gate is what PROMISES the release collector will find the changelog block.
// If the two disagree about what counts as a `## Changelog` heading, the gate goes
// green and the change then vanishes from the release notes — the exact silent
// accident the gate exists to prevent. So they read the body through one shared
// parser (lib/pr-body.mjs), and these tests are what keep them in step.
//
// `usable` is deliberately strict: a `malformed` result is NOT a collected entry.
// An earlier version of this test asked only `!== null`, which counted every
// malformed object as a success and hid a whole class of disagreement.
const collectorUsable = (body) => {
  const r = parseChangelogBlock(body);
  return r !== null && r !== undefined && !r.malformed;
};

test('PR surface: the gate and the release collector agree on an indented `## Changelog`', () => {
  for (const n of [0, 1, 2, 3, 4]) {
    const indent = ' '.repeat(n);
    const body = goodBody()
      .split('\n')
      .map((l) => (/^#/.test(l) ? indent + l : l))
      .join('\n');
    const gateOk = checkPrSurface({ title: GOOD_TITLE, body }).ok;
    const usable = collectorUsable(body);
    assert.equal(
      gateOk,
      usable,
      `${n}-space indent: gate ${gateOk ? 'accepts' : 'rejects'} but the collector ` +
        `${usable ? 'reads' : 'CANNOT read'} the changelog — a green gate whose entry never reaches CHANGELOG.md`,
    );
  }
});

// The shapes the gate used to wave through and the collector then choked on at
// release time, when the PR could no longer be edited. The gate now runs the
// collector's own parse, so the author hears about it while it is still one
// `gh pr edit` away.
test('PR surface: a changelog block the collector calls malformed is rejected AT THE PR', () => {
  const malformed = [
    ['None with a period', ['None.']],
    ['a duplicated EN line', ['- EN: a', '- EN: b', '- KO: 가']],
    ['None mixed with EN/KO', ['None', '- EN: a', '- KO: 가']],
  ];
  for (const [what, changelog] of malformed) {
    const body = prBody({ changelog });
    const res = checkPrSurface({ title: GOOD_TITLE, body });
    assert.equal(
      res.ok,
      false,
      `${what}: the collector cannot read this, so the gate must not pass it`,
    );
    assert.ok(
      res.violations.some((v) => v.rule === 'changelog'),
      `${what}: reported as a changelog violation`,
    );
    assert.equal(
      collectorUsable(body),
      false,
      `${what}: (and the collector really does reject it)`,
    );
  }
});

test('PR surface: the shapes that DO collect still pass (- EN/- KO, None, - None, * None)', () => {
  for (const changelog of [['- EN: a thing', '- KO: 어떤 것'], ['None'], ['- None'], ['* None']]) {
    const body = prBody({ changelog });
    const res = checkPrSurface({ title: GOOD_TITLE, body });
    assert.equal(
      res.ok,
      true,
      `${JSON.stringify(changelog)} must pass: ${res.violations.map((v) => `${v.rule}/${v.detail}`).join(' | ')}`,
    );
    assert.equal(collectorUsable(body), true, `${JSON.stringify(changelog)}: and it collects`);
  }
});

// The bug that made the shared parser necessary. A PR whose body SHOWS a changelog
// block inside a fence — a PR about the template, or about the collector itself —
// used to hand the collector the EXAMPLE, which then shipped in CHANGELOG.md while
// the real note was never seen. The gate passed it, because the gate masks fences
// and found the real heading further down. Nobody was attacking anything; someone
// wrote documentation.
test('PR surface: a fenced changelog EXAMPLE does not become the release note', () => {
  const body = [
    ...languageBlock('English', EN_SUBHEADINGS),
    ...languageBlock('한국어', KO_SUBHEADINGS),
    '## How the block looks',
    '',
    '```markdown',
    '## Changelog',
    '- EN: Example only.',
    '- KO: 예시일 뿐.',
    '```',
    '',
    '## Changelog',
    '- EN: the real note',
    '- KO: 진짜 노트',
    '',
    ...checklistBlock(true),
  ].join('\n');
  const res = checkPrSurface({ title: GOOD_TITLE, body });
  assert.equal(res.ok, true, 'the real section is there, so the gate passes');
  assert.deepEqual(
    parseChangelogBlock(body),
    { en: 'the real note', ko: '진짜 노트' },
    'the collector must publish the REAL note, not the fenced example above it',
  );
});
