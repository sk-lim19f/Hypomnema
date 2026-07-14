// tests/fix-status-verify.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { test, suite } from './harness.mjs';
import {
  FSV_FIX_MANIFEST,
  FSV_NO_ADR,
  FSV_NO_AUTO_TEST,
  HOME,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  fsvBuildCorpusSearch,
  fsvCheckAdrLines,
  fsvCheckManifestCoverage,
  fsvIsReferenceStub,
  fsvParseAnchors,
  fsvParseRunnerOutput,
  fsvParseStatus,
  fsvValidateManifest,
  fsvVerifyMatrix,
  withTmpDir,
} from './helpers.mjs';

suite('fix-status-verify — parseAnchors');

test('parseAnchors: extracts @fix anchors with full test name (no comma split)', () => {
  const text = [
    'some prose',
    '// @fix #15: all type-conditional fields present → green',
    'more code',
    '// @fix #17: project hot.md not updated today → block, reason names the file',
  ].join('\n');
  const a = fsvParseAnchors(text);
  assert.deepEqual(a.get(15), ['all type-conditional fields present → green']);
  assert.deepEqual(a.get(17), ['project hot.md not updated today → block, reason names the file']);
});

test('parseAnchors: ignores prose comments missing @ prefix', () => {
  const text = [
    '// fix #28: doctor gates on extensions baseline existence',
    '// @fix #28: real anchor here',
  ].join('\n');
  const a = fsvParseAnchors(text);
  assert.deepEqual(a.get(28), ['real anchor here']);
});

test('parseAnchors: accumulates multiple anchors per fix #, dedupes', () => {
  const text = ['// @fix #27: case A', '// @fix #27: case B', '// @fix #27: case A'].join('\n');
  const a = fsvParseAnchors(text);
  assert.deepEqual(a.get(27), ['case A', 'case B']);
});

test('parseAnchors: NO_AUTO_TEST sentinel preserved as-is', () => {
  const a = fsvParseAnchors('// @fix #20: NO_AUTO_TEST');
  assert.deepEqual(a.get(20), ['NO_AUTO_TEST']);
});

suite('fix-status-verify — isReferenceStub');

test('isReferenceStub: true for type: reference frontmatter', () => {
  const spec = [
    '---',
    'title: moved',
    'type: reference',
    'status: archived',
    '---',
    '',
    '# moved',
  ].join('\n');
  assert.equal(fsvIsReferenceStub(spec), true);
});

test('isReferenceStub: false for a normal spec (type: spec)', () => {
  const spec = ['---', 'title: real spec', 'type: spec', '---', '', '| #1 | merged |'].join('\n');
  assert.equal(fsvIsReferenceStub(spec), false);
});

test('isReferenceStub: false when no frontmatter at all', () => {
  assert.equal(fsvIsReferenceStub('# just a body\n| #1 | merged |'), false);
});

suite('fix-status-verify — parseStatus');

test('parseStatus: table-row form | #N | … TRUE_MERGED', () => {
  const spec = '| #15 | merged | **TRUE_MERGED (PR #28)** — body |';
  const s = fsvParseStatus(spec);
  assert.equal(s.get(15), 'TRUE_MERGED');
});

test('parseStatus: inline prose form "fix #N (resolved)"', () => {
  const spec = '✅ v1.2.x fix #38 (resolved PR #23): payload entrypoint';
  const s = fsvParseStatus(spec);
  assert.equal(s.get(38), 'resolved');
});

test('parseStatus: STALE_MERGED does NOT match (negative compound)', () => {
  const spec = '| #25 | merged | **STALE_MERGED** — code grep 0 |';
  const s = fsvParseStatus(spec);
  // The cell has "merged" (positive) AND "STALE_MERGED" (negative compound).
  // proximity scan picks up "merged" first (within 120 chars), so #25 maps to
  // merged. The negative compound is a substring of STALE_MERGED only — the
  // word-boundary regex on "merged" matches the plain "merged" cell.
  assert.equal(s.get(25), 'merged');
});

test('parseStatus: pure STALE_MERGED line (no positive token) → not detected', () => {
  const spec = 'fix #99 STALE_MERGED — placeholder';
  const s = fsvParseStatus(spec);
  assert.equal(s.has(99), false);
});

test('parseStatus: proximity rejects far-apart fix # / status pair', () => {
  // fix #17 resolved early, fix #41 mentioned later w/o status word nearby.
  const spec =
    '**✅ fix #17 (resolved PR #21)**: foo. … long body … Phase B(v1.3.0 fix #41~#44) advisory.';
  const s = fsvParseStatus(spec);
  assert.equal(s.get(17), 'resolved');
  assert.equal(s.has(41), false);
});

test('parseStatus: TRUE_MERGED > resolved > merged priority within line', () => {
  const spec = '| #26 | merged → **resolved (2026-05-19)** | **TRUE_MERGED later** |';
  const s = fsvParseStatus(spec);
  assert.equal(s.get(26), 'TRUE_MERGED');
});

suite('fix-status-verify — parseRunnerOutput');

test('parseRunnerOutput: ✓ marks pass, ✗ marks fail', () => {
  const out = [
    '  ✓ test A passes',
    '  ✗ test B fails',
    '    AssertionError: …',
    '  ✓ test C passes',
  ].join('\n');
  const r = fsvParseRunnerOutput(out);
  assert.equal(r.get('test A passes'), 'pass');
  assert.equal(r.get('test B fails'), 'fail');
  assert.equal(r.get('test C passes'), 'pass');
});

test('parseRunnerOutput: duplicate name with any fail → sticky fail', () => {
  const out = ['  ✓ shared name', '  ✗ shared name', '  ✓ shared name'].join('\n');
  const r = fsvParseRunnerOutput(out);
  assert.equal(r.get('shared name'), 'fail');
});

suite('fix-status-verify — verifyMatrix');

test('verifyMatrix: NO_ANCHOR error when status claim has no anchor', () => {
  const anchors = new Map();
  const status = new Map([[42, 'resolved']]);
  const testResults = new Map();
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, 'NO_ANCHOR');
  assert.equal(findings[0].fixNum, 42);
});

test('verifyMatrix: MISSING_TEST when anchor names non-existent test', () => {
  const anchors = new Map([[42, ['ghost-test']]]);
  const status = new Map([[42, 'resolved']]);
  const testResults = new Map([['other-test', 'pass']]);
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.class === 'MISSING_TEST' && f.fixNum === 42));
});

test('verifyMatrix: FAILING_TEST when anchor names a failed test', () => {
  const anchors = new Map([[42, ['t1']]]);
  const status = new Map([[42, 'resolved']]);
  const testResults = new Map([['t1', 'fail']]);
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.class === 'FAILING_TEST' && f.fixNum === 42));
});

test('verifyMatrix: NO_AUTO_TEST sentinel → info finding, not error', () => {
  const anchors = new Map([[20, ['NO_AUTO_TEST']]]);
  const status = new Map([[20, 'resolved']]);
  const testResults = new Map();
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, true);
  assert.ok(findings.some((f) => f.class === 'NO_AUTO_TEST' && f.level === 'info'));
});

test('verifyMatrix: ORPHAN_ANCHOR is warn-only, does not break ok', () => {
  // status must hold ≥1 positive claim — an empty status with anchors is now a
  // STUB_SPEC error (vacuous gate), not a warn. #15 is claimed+green; #99 is the
  // orphan whose warn-only semantics this test guards.
  const anchors = new Map([
    [15, ['real-test']],
    [99, ['orphan-test']],
  ]);
  const status = new Map([[15, 'TRUE_MERGED']]);
  const testResults = new Map([
    ['real-test', 'pass'],
    ['orphan-test', 'pass'],
  ]);
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, true);
  assert.ok(
    findings.some((f) => f.class === 'ORPHAN_ANCHOR' && f.level === 'warn' && f.fixNum === 99),
  );
  assert.ok(!findings.some((f) => f.class === 'STUB_SPEC'));
});

test('verifyMatrix: STUB_SPEC error when spec is a type:reference stub', () => {
  const anchors = new Map([[15, ['real-test']]]);
  const status = new Map([[15, 'TRUE_MERGED']]);
  const testResults = new Map([['real-test', 'pass']]);
  // Even with otherwise-green inputs, a stub spec short-circuits to one error.
  const { ok, findings } = fsvVerifyMatrix({
    anchors,
    status,
    testResults,
    specIsStub: true,
  });
  assert.equal(ok, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, 'STUB_SPEC');
  assert.equal(findings[0].level, 'error');
});

test('verifyMatrix: STUB_SPEC error when anchors exist but 0 status claims (vacuous)', () => {
  const anchors = new Map([[15, ['real-test']]]);
  const status = new Map();
  const testResults = new Map([['real-test', 'pass']]);
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, 'STUB_SPEC');
  assert.match(findings[0].detail, /vacuous/);
});

test('verifyMatrix: no STUB_SPEC when status has ≥1 claim', () => {
  const anchors = new Map([[15, ['real-test']]]);
  const status = new Map([[15, 'TRUE_MERGED']]);
  const testResults = new Map([['real-test', 'pass']]);
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, true);
  assert.ok(!findings.some((f) => f.class === 'STUB_SPEC'));
});

test('verifyMatrix: no STUB_SPEC when both status and anchors empty (custom/empty matrix)', () => {
  const { ok, findings } = fsvVerifyMatrix({
    anchors: new Map(),
    status: new Map(),
    testResults: new Map(),
  });
  assert.equal(ok, true);
  assert.ok(!findings.some((f) => f.class === 'STUB_SPEC'));
});

test('verifyMatrix: all-green case → ok:true with no error findings', () => {
  const anchors = new Map([[15, ['real-test']]]);
  const status = new Map([[15, 'TRUE_MERGED']]);
  const testResults = new Map([['real-test', 'pass']]);
  const { ok, findings } = fsvVerifyMatrix({ anchors, status, testResults });
  assert.equal(ok, true);
  assert.equal(findings.filter((f) => f.level === 'error').length, 0);
});

// ── fix-status-verify — manifest (Phase 2, A-sot) ────────────────────────────

suite('fix-status-verify — validateManifest');

test('validateManifest: real FIX_MANIFEST is structurally clean', () => {
  assert.deepEqual(fsvValidateManifest(FSV_FIX_MANIFEST), []);
});

test('validateManifest: duplicate fixId → MANIFEST_DUP_FIXID', () => {
  const m = [
    { fixId: 1, testNames: ['t'], adrPath: null, adrKeyLine: FSV_NO_ADR },
    { fixId: 1, testNames: ['u'], adrPath: null, adrKeyLine: FSV_NO_ADR },
  ];
  const f = fsvValidateManifest(m);
  assert.ok(f.some((x) => x.class === 'MANIFEST_DUP_FIXID' && x.fixNum === 1));
});

test('validateManifest: empty testNames → MANIFEST_EMPTY_TESTS', () => {
  const m = [{ fixId: 2, testNames: [], adrPath: null, adrKeyLine: FSV_NO_ADR }];
  const f = fsvValidateManifest(m);
  assert.ok(f.some((x) => x.class === 'MANIFEST_EMPTY_TESTS' && x.fixNum === 2));
});

test('validateManifest: NO_AUTO_TEST mixed with real name → MANIFEST_SENTINEL_MIX', () => {
  const m = [
    { fixId: 3, testNames: [FSV_NO_AUTO_TEST, 'real'], adrPath: null, adrKeyLine: FSV_NO_ADR },
  ];
  const f = fsvValidateManifest(m);
  assert.ok(f.some((x) => x.class === 'MANIFEST_SENTINEL_MIX' && x.fixNum === 3));
});

test('validateManifest: lone NO_AUTO_TEST is allowed (no sentinel-mix)', () => {
  const m = [{ fixId: 4, testNames: [FSV_NO_AUTO_TEST], adrPath: null, adrKeyLine: FSV_NO_ADR }];
  const f = fsvValidateManifest(m);
  assert.ok(!f.some((x) => x.class === 'MANIFEST_SENTINEL_MIX'));
});

test('validateManifest: blank adrKeyLine → MANIFEST_EMPTY_KEYLINE', () => {
  const m = [{ fixId: 5, testNames: ['t'], adrPath: 'decisions/x.md', adrKeyLine: '   ' }];
  const f = fsvValidateManifest(m);
  assert.ok(f.some((x) => x.class === 'MANIFEST_EMPTY_KEYLINE' && x.fixNum === 5));
});

test('validateManifest: NO_ADR with non-null adrPath → MANIFEST_NO_ADR_SHAPE', () => {
  const m = [{ fixId: 6, testNames: ['t'], adrPath: 'decisions/x.md', adrKeyLine: FSV_NO_ADR }];
  const f = fsvValidateManifest(m);
  assert.ok(f.some((x) => x.class === 'MANIFEST_NO_ADR_SHAPE' && x.fixNum === 6));
});

test('validateManifest: real adrKeyLine with null adrPath → MANIFEST_NO_ADR_SHAPE', () => {
  const m = [{ fixId: 7, testNames: ['t'], adrPath: null, adrKeyLine: 'some literal' }];
  const f = fsvValidateManifest(m);
  assert.ok(f.some((x) => x.class === 'MANIFEST_NO_ADR_SHAPE' && x.fixNum === 7));
});

suite('fix-status-verify — checkManifestCoverage');

test('checkManifestCoverage: clean when rows match anchors + claims', () => {
  const manifest = [{ fixId: 1, testNames: ['t1'], adrPath: null, adrKeyLine: FSV_NO_ADR }];
  const anchors = new Map([[1, ['t1']]]);
  const status = new Map([[1, 'merged']]);
  assert.deepEqual(fsvCheckManifestCoverage({ manifest, anchors, status }), []);
});

test('checkManifestCoverage: claimed+anchored without row → MANIFEST_MISSING_ROW', () => {
  const manifest = [];
  const anchors = new Map([[9, ['t9']]]);
  const status = new Map([[9, 'merged']]);
  const f = fsvCheckManifestCoverage({ manifest, anchors, status });
  assert.ok(f.some((x) => x.class === 'MANIFEST_MISSING_ROW' && x.fixNum === 9));
});

test('checkManifestCoverage: claimed but unanchored → no MISSING_ROW (NO_ANCHOR domain)', () => {
  const manifest = [];
  const anchors = new Map();
  const status = new Map([[9, 'merged']]);
  const f = fsvCheckManifestCoverage({ manifest, anchors, status });
  assert.ok(!f.some((x) => x.class === 'MANIFEST_MISSING_ROW'));
});

test('checkManifestCoverage: testNames ≠ anchors → MANIFEST_TEST_DRIFT', () => {
  const manifest = [
    { fixId: 1, testNames: ['t1', 'stale'], adrPath: null, adrKeyLine: FSV_NO_ADR },
  ];
  const anchors = new Map([[1, ['t1']]]);
  const status = new Map([[1, 'merged']]);
  const f = fsvCheckManifestCoverage({ manifest, anchors, status });
  assert.ok(f.some((x) => x.class === 'MANIFEST_TEST_DRIFT' && x.fixNum === 1));
});

test('checkManifestCoverage: NO_AUTO_TEST row set-equal to anchor → no drift', () => {
  const manifest = [
    { fixId: 20, testNames: [FSV_NO_AUTO_TEST], adrPath: null, adrKeyLine: FSV_NO_ADR },
  ];
  const anchors = new Map([[20, [FSV_NO_AUTO_TEST]]]);
  const status = new Map([[20, 'merged']]);
  assert.deepEqual(fsvCheckManifestCoverage({ manifest, anchors, status }), []);
});

test('checkManifestCoverage: drift is order-insensitive', () => {
  const manifest = [{ fixId: 1, testNames: ['b', 'a'], adrPath: null, adrKeyLine: FSV_NO_ADR }];
  const anchors = new Map([[1, ['a', 'b']]]);
  const status = new Map([[1, 'merged']]);
  assert.deepEqual(fsvCheckManifestCoverage({ manifest, anchors, status }), []);
});

suite('fix-status-verify — checkAdrLines');

test('checkAdrLines: clean when adrPath exists and literal found', () => {
  const manifest = [{ fixId: 1, testNames: ['t'], adrPath: 'decisions/x.md', adrKeyLine: 'LIT' }];
  const f = fsvCheckAdrLines({ manifest, searchFn: () => true, adrExistsFn: () => true });
  assert.deepEqual(f, []);
});

test('checkAdrLines: literal not in corpus → ADR_LINE_MISSING', () => {
  const manifest = [{ fixId: 1, testNames: ['t'], adrPath: 'decisions/x.md', adrKeyLine: 'LIT' }];
  const f = fsvCheckAdrLines({ manifest, searchFn: () => false, adrExistsFn: () => true });
  assert.ok(f.some((x) => x.class === 'ADR_LINE_MISSING' && x.fixNum === 1));
});

test('checkAdrLines: adrPath unresolved → ADR_PATH_MISSING', () => {
  const manifest = [{ fixId: 1, testNames: ['t'], adrPath: 'decisions/x.md', adrKeyLine: 'LIT' }];
  const f = fsvCheckAdrLines({ manifest, searchFn: () => true, adrExistsFn: () => false });
  assert.ok(f.some((x) => x.class === 'ADR_PATH_MISSING' && x.fixNum === 1));
});

test('checkAdrLines: NO_ADR row is skipped entirely', () => {
  const manifest = [{ fixId: 1, testNames: ['t'], adrPath: null, adrKeyLine: FSV_NO_ADR }];
  // Even with searchFn always false, a NO_ADR row produces no finding.
  const f = fsvCheckAdrLines({ manifest, searchFn: () => false, adrExistsFn: () => false });
  assert.deepEqual(f, []);
});

suite('fix-status-verify — buildCorpusSearch (self-match exclusion)');

test('buildCorpusSearch: finds a literal present in an included dir', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'foo.mjs'), 'const x = "UNIQUE_DECISION_LINE";\n');
    const search = fsvBuildCorpusSearch({ repoRoot: root, includeDirs: ['scripts'] });
    assert.equal(search('UNIQUE_DECISION_LINE'), true);
    assert.equal(search('not present anywhere'), false);
  });
});

test('buildCorpusSearch: CRITICAL — excluded manifest does NOT self-satisfy the grep', () => {
  withTmpDir((root) => {
    // Literal lives ONLY inside scripts/lib/fix-manifest.mjs (the manifest).
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'scripts', 'lib', 'fix-manifest.mjs'),
      "export const FIX_MANIFEST = [{ adrKeyLine: 'ONLY_IN_MANIFEST' }];\n",
    );
    writeFileSync(join(root, 'scripts', 'other.mjs'), '// no decision literal here\n');
    // With the manifest excluded, the literal is NOT found → ADR_LINE_MISSING
    // would correctly fire. This is the guard that keeps the gate non-vacuous.
    const excluded = fsvBuildCorpusSearch({
      repoRoot: root,
      includeDirs: ['scripts'],
      excludePaths: ['scripts/lib/fix-manifest.mjs'],
    });
    assert.equal(excluded('ONLY_IN_MANIFEST'), false);
    // Without the exclusion, it self-matches — proving exclusion is the mechanism.
    const notExcluded = fsvBuildCorpusSearch({ repoRoot: root, includeDirs: ['scripts'] });
    assert.equal(notExcluded('ONLY_IN_MANIFEST'), true);
  });
});

test('buildCorpusSearch: case-sensitive fixed-string match', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(join(root, 'hooks', 'h.mjs'), 'WIKI_AUTOCLOSE marker\n');
    const search = fsvBuildCorpusSearch({ repoRoot: root, includeDirs: ['hooks'] });
    assert.equal(search('WIKI_AUTOCLOSE'), true);
    assert.equal(search('wiki_autoclose'), false);
  });
});

test('buildCorpusSearch: missing include dir is tolerated (not fatal)', () => {
  withTmpDir((root) => {
    const search = fsvBuildCorpusSearch({ repoRoot: root, includeDirs: ['does-not-exist'] });
    assert.equal(search('anything'), false);
  });
});

test('manifest integration: real FIX_MANIFEST verifies clean against the real corpus', () => {
  // Regression guard for the adrKeyLine curation: every non-NO_ADR row's literal
  // must still exist in the production corpus (excluding the manifest itself),
  // and every adrPath must resolve under the wiki. Skips if the wiki is absent.
  const f1 = fsvValidateManifest(FSV_FIX_MANIFEST);
  assert.deepEqual(f1, []);
  const search = fsvBuildCorpusSearch({
    repoRoot: REPO,
    includeDirs: ['scripts', 'hooks', 'commands', 'skills', 'templates'],
    excludePaths: ['scripts/lib/fix-manifest.mjs'],
  });
  const wikiDecisions = join(homedir(), 'hypomnema', 'projects', 'hypomnema');
  const adrExists = (p) => existsSync(join(wikiDecisions, p));
  const haveWiki = FSV_FIX_MANIFEST.every(
    (r) => r.adrPath == null || existsSync(join(wikiDecisions, r.adrPath)),
  );
  // ADR-line grep is corpus-only (no wiki dependency); always assert it.
  const lineFindings = fsvCheckAdrLines({
    manifest: FSV_FIX_MANIFEST,
    searchFn: search,
    adrExistsFn: () => true,
  }).filter((x) => x.class === 'ADR_LINE_MISSING');
  assert.deepEqual(lineFindings, [], `ADR_LINE_MISSING: ${JSON.stringify(lineFindings)}`);
  if (haveWiki) {
    const pathFindings = fsvCheckAdrLines({
      manifest: FSV_FIX_MANIFEST,
      searchFn: search,
      adrExistsFn: adrExists,
    }).filter((x) => x.class === 'ADR_PATH_MISSING');
    assert.deepEqual(pathFindings, [], `ADR_PATH_MISSING: ${JSON.stringify(pathFindings)}`);
  }
});

// ── fix-status-verify CLI integration ────────────────────────────────────────

suite('fix-status-verify — CLI integration');

test('CLI: green fixture → exit 0', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, '# spec\n| #100 | merged | **TRUE_MERGED (PR #1)** — body |\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      [
        '#!/usr/bin/env node',
        '// @fix #100: green-fixture-test',
        "console.log('  ✓ green-fixture-test');",
      ].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(
      manifestPath,
      "export const FIX_MANIFEST = [{ fixId: 100, testNames: ['green-fixture-test'], adrPath: null, adrKeyLine: 'NO_ADR' }];\n",
    );
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /verified/);
    assert.match(r.stdout, /ADR-line grep \(Phase 2\)/);
  });
});

test('CLI: type:reference stub spec → exit 1 with STUB_SPEC', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(
      specPath,
      ['---', 'title: moved', 'type: reference', '---', '', '# moved to archive/'].join('\n'),
    );
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    // Anchor present so the stub is the only reason to fail.
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', '// @fix #100: t', "console.log('  ✓ t');"].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(manifestPath, 'export const FIX_MANIFEST = [];\n');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
        '--json',
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.ok(
      j.findings.some((f) => f.class === 'STUB_SPEC'),
      `expected STUB_SPEC finding: ${JSON.stringify(j.findings)}`,
    );
  });
});

test('CLI: vacuous spec (anchors but 0 claims) → exit 1 with STUB_SPEC', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    // Real (non-stub) spec but no positive status claim → vacuous gate.
    writeFileSync(specPath, '# spec with no merged/resolved claims\nsome prose\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', '// @fix #100: t', "console.log('  ✓ t');"].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(manifestPath, 'export const FIX_MANIFEST = [];\n');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
        '--json',
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.ok(j.findings.some((f) => f.class === 'STUB_SPEC'));
  });
});

test('CLI: missing anchor → exit 1 with NO_ANCHOR finding', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, '| #200 | merged | **resolved (PR #1)** — body |\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(runnerPath, '// no anchor for #200\n');
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(manifestPath, 'export const FIX_MANIFEST = [];\n');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /NO_ANCHOR/);
  });
});

test('CLI: anchor names test that does not run → exit 1 with MISSING_TEST', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, 'fix #300 (resolved PR #1): body\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      [
        '#!/usr/bin/env node',
        '// @fix #300: ghost-test-name',
        "console.log('  ✓ different-name');",
      ].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(
      manifestPath,
      "export const FIX_MANIFEST = [{ fixId: 300, testNames: ['ghost-test-name'], adrPath: null, adrKeyLine: 'NO_ADR' }];\n",
    );
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MISSING_TEST/);
  });
});

test('CLI: --json emits machine-readable report with ok flag', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, '| #400 | merged | **TRUE_MERGED** — body |\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', '// @fix #400: t', "console.log('  ✓ t');"].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(
      manifestPath,
      "export const FIX_MANIFEST = [{ fixId: 400, testNames: ['t'], adrPath: null, adrKeyLine: 'NO_ADR' }];\n",
    );
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
        '--json',
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 0);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.statusClaims, 1);
    assert.equal(j.anchorCount, 1);
    // Mandatory note string is identical in human and JSON outputs.
    assert.equal(
      j.note,
      'test-linkage + green + ADR-line grep (Phase 2): manifest evidence checked against production corpus',
    );
  });
});

test('CLI: anchored test fails → exit 1 with FAILING_TEST', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, 'fix #500 (resolved PR #1): body\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', '// @fix #500: real-test', "console.log('  ✗ real-test');"].join(
        '\n',
      ),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(
      manifestPath,
      "export const FIX_MANIFEST = [{ fixId: 500, testNames: ['real-test'], adrPath: null, adrKeyLine: 'NO_ADR' }];\n",
    );
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILING_TEST/);
  });
});

test('CLI: test command exits nonzero → exit 1 with TEST_RUN_NONZERO_EXIT', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    // No status claim, so no anchor-related errors. Only exit-code flip.
    writeFileSync(specPath, '# empty spec\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', "console.log('  ✓ a test passed');", 'process.exit(7);'].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(manifestPath, 'export const FIX_MANIFEST = [];\n');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
        '--json',
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.testExitCode, 7);
    assert.ok(
      j.findings.some((f) => f.class === 'TEST_RUN_NONZERO_EXIT'),
      `expected TEST_RUN_NONZERO_EXIT finding: ${JSON.stringify(j.findings)}`,
    );
  });
});

test('CLI: manifest adrKeyLine absent from corpus → exit 1 with ADR_LINE_MISSING', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, '| #600 | merged | **TRUE_MERGED** — body |\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', '// @fix #600: t600', "console.log('  ✓ t600');"].join('\n'),
    );
    // adrPath resolves (temp wiki has the file) so the ONLY failure is the
    // missing corpus literal.
    mkdirSync(join(wikiDir, 'projects', 'hypomnema', 'decisions'), { recursive: true });
    writeFileSync(join(wikiDir, 'projects', 'hypomnema', 'decisions', 'real.md'), '# adr\n');
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(
      manifestPath,
      "export const FIX_MANIFEST = [{ fixId: 600, testNames: ['t600'], adrPath: 'decisions/real.md', adrKeyLine: 'ZZ_LITERAL_NOT_IN_ANY_PRODUCTION_FILE_zz' }];\n",
    );
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--hypo-dir',
        wikiDir,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
        '--json',
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.ok(
      j.findings.some((f) => f.class === 'ADR_LINE_MISSING' && f.fixNum === 600),
      `expected ADR_LINE_MISSING: ${JSON.stringify(j.findings)}`,
    );
    assert.ok(!j.findings.some((f) => f.class === 'ADR_PATH_MISSING'));
  });
});

test('CLI: claimed+anchored fix with no manifest row → exit 1 with MANIFEST_MISSING_ROW', () => {
  withTmpDir((wikiDir) => {
    const specPath = join(wikiDir, 'spec.md');
    writeFileSync(specPath, '| #700 | merged | **TRUE_MERGED** — body |\n');
    const runnerPath = join(wikiDir, 'fixture-runner.mjs');
    writeFileSync(
      runnerPath,
      ['#!/usr/bin/env node', '// @fix #700: t700', "console.log('  ✓ t700');"].join('\n'),
    );
    const manifestPath = join(wikiDir, 'manifest.mjs');
    writeFileSync(manifestPath, 'export const FIX_MANIFEST = [];\n');
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'fix-status-verify.mjs'),
        '--spec',
        specPath,
        '--runner',
        runnerPath,
        '--manifest',
        manifestPath,
        '--test-command',
        `${process.execPath} ${runnerPath}`,
        '--json',
      ],
      { encoding: 'utf-8', cwd: REPO, env: { ...process.env, HOME: SESSION_TMP_HOME } },
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.ok(
      j.findings.some((f) => f.class === 'MANIFEST_MISSING_ROW' && f.fixNum === 700),
      `expected MANIFEST_MISSING_ROW: ${JSON.stringify(j.findings)}`,
    );
  });
});
