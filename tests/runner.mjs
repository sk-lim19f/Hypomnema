#!/usr/bin/env node
/**
 * tests/runner.mjs — Hypomnema test runner (no external deps)
 *
 * Runs unit tests for lib functions and smoke tests for CLI scripts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME           = homedir();
const REPO           = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRIPTS        = join(REPO, 'scripts');
const NONEXISTENT_WIKI = join(tmpdir(), `hypo-no-wiki-${process.pid}`);

// ── minimal test harness ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(label) { console.log(`\n${label}`); }

// ── helpers ──────────────────────────────────────────────────────────────────

function run(script, args = []) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '' },
  });
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-test-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function withTmpHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-home-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function runWithHome(script, args = [], home) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: home },
  });
}

// ── lib/hypo-root.mjs ────────────────────────────────────────────────────────

const { expandHome, resolveHypoRoot } = await import(`${SCRIPTS}/lib/hypo-root.mjs`);

suite('expandHome()');

test('passthrough for non-tilde paths', () => {
  assert.equal(expandHome('/absolute/path'), '/absolute/path');
  assert.equal(expandHome('relative'), 'relative');
});

test('~ alone expands to HOME', () => {
  assert.equal(expandHome('~'), HOME);
});

test('~/foo expands to HOME/foo', () => {
  assert.equal(expandHome('~/foo/bar'), join(HOME, 'foo/bar'));
});

suite('resolveHypoRoot()');

test('HYPO_DIR env var takes precedence', () => {
  const orig = process.env.HYPO_DIR;
  process.env.HYPO_DIR = '/tmp/custom-wiki';
  try {
    assert.equal(resolveHypoRoot(), '/tmp/custom-wiki');
  } finally {
    if (orig === undefined) delete process.env.HYPO_DIR;
    else process.env.HYPO_DIR = orig;
  }
});

test('falls back to ~/hypomnema when no env or marker found', () => {
  const orig = process.env.HYPO_DIR;
  delete process.env.HYPO_DIR;
  try {
    const result = resolveHypoRoot();
    // Either found a real wiki (has hypo-config.md) or returned ~/hypomnema default
    assert.ok(typeof result === 'string' && result.length > 0);
    assert.ok(result.startsWith('/'));
  } finally {
    if (orig !== undefined) process.env.HYPO_DIR = orig;
  }
});

test('finds wiki by hypo-config.md marker', () => {
  const orig = process.env.HYPO_DIR;
  delete process.env.HYPO_DIR;
  try {
    const result = resolveHypoRoot();
    assert.ok(typeof result === 'string' && result.length > 0, 'should return non-empty string');
    assert.ok(result.startsWith('/'), 'should return an absolute path');
    // Either the returned path has hypo-config.md (marker scan worked), or it is the ~/hypomnema default
    const isDefault = result === join(HOME, 'hypomnema');
    const hasMarker = existsSync(join(result, 'hypo-config.md'));
    assert.ok(isDefault || hasMarker,
      `resolveHypoRoot returned "${result}" which is neither the default nor has hypo-config.md`);
  } finally {
    if (orig !== undefined) process.env.HYPO_DIR = orig;
  }
});

// ── init.mjs smoke tests ─────────────────────────────────────────────────────

suite('init.mjs --dry-run');

test('exits 0 with --dry-run --no-hooks --no-git-init', () => {
  withTmpDir(dir => {
    const r = run('init.mjs', [
      `--hypo-dir=${dir}/wiki`,
      '--dry-run',
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('[DRY RUN'), `stdout: ${r.stdout}`);
  });
});

test('--dry-run reports created dirs without writing them', () => {
  withTmpDir(dir => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [
      `--hypo-dir=${hypoDir}`,
      '--dry-run',
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!existsSync(hypoDir), 'wiki dir should not be created in dry-run');
  });
});

test('actual run creates expected directories', () => {
  withTmpDir(dir => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [
      `--hypo-dir=${hypoDir}`,
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const sub of ['pages', 'projects', 'sources']) {
      assert.ok(existsSync(join(hypoDir, sub)), `missing: ${sub}/`);
    }
  });
});

test('--no-hooks succeeds without touching hook config', () => {
  withTmpDir(dir => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `--no-hooks should exit 0: ${r.stderr}`);
    assert.ok(existsSync(join(hypoDir, 'index.md')), 'wiki files should still be created');
  });
});

// ── doctor.mjs smoke tests ───────────────────────────────────────────────────

suite('doctor.mjs --json');

test('exits without crashing on non-existent wiki dir', () => {
  const r = run('doctor.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  // doctor may exit 1 (failures found) but should not crash (exit 2+)
  assert.ok(r.status !== null, 'process did not exit cleanly');
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}\n${r.stderr}`);
});

test('--json output is valid JSON', () => {
  const r = run('doctor.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout not JSON: ${r.stdout}`);
});

test('JSON output is an array of check objects', () => {
  const r = run('doctor.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out), 'expected top-level array');
  assert.ok(out.length > 0, 'expected at least one check');
  assert.ok('status' in out[0], 'expected status field');
  assert.ok('label' in out[0], 'expected label field');
});

// ── hook contract tests ───────────────────────────────────────────────────────

const HOOKS = join(REPO, 'hooks');

const { isCompactCommand, isGateSkipped, buildOutput } = await import(
  join(HOOKS, 'hypo-shared.mjs')
);

function runHook(hookFile, stdinData, extraEnv = {}) {
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '/tmp/nonexistent-hypo-99999', ...extraEnv },
  });
}

function withCleanWiki(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-wiki-'));
  try {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(join(dir, 'log.md'), `## [${today}] session | test-project\n`);
    writeFileSync(join(dir, 'hot.md'), '---\ntitle: Hot\nupdated: today\n---\n# Hot\n');
    spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8' });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

suite('isCompactCommand()');

test('/compact → true', () => {
  assert.equal(isCompactCommand('/compact'), true);
});

test('/compact with trailing args → true', () => {
  assert.equal(isCompactCommand('/compact --all'), true);
});

test('non-compact prompt → false', () => {
  assert.equal(isCompactCommand('hello'), false);
  assert.equal(isCompactCommand('/other'), false);
});

suite('isGateSkipped()');

test('HYPO_SKIP_GATE=1 → true', () => {
  const orig = process.env.HYPO_SKIP_GATE;
  process.env.HYPO_SKIP_GATE = '1';
  try { assert.equal(isGateSkipped(), true); }
  finally { orig === undefined ? delete process.env.HYPO_SKIP_GATE : (process.env.HYPO_SKIP_GATE = orig); }
});

test('no env var → false', () => {
  const o1 = process.env.HYPO_SKIP_GATE;
  delete process.env.HYPO_SKIP_GATE;
  try { assert.equal(isGateSkipped(), false); }
  finally {
    if (o1 !== undefined) process.env.HYPO_SKIP_GATE = o1;
  }
});

suite('buildOutput()');

test('wraps context in additionalContext field', () => {
  const out = buildOutput('test context');
  assert.equal(out.additionalContext, 'test context');
});

test('merges extra fields alongside additionalContext', () => {
  const out = buildOutput('ctx', { continue: true });
  assert.equal(out.continue, true);
  assert.equal(out.additionalContext, 'ctx');
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
  withCleanWiki(dir => {
    const r = runHook('hypo-compact-guard.mjs', { prompt: '/compact' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true);
  });
});

test('output is always valid JSON regardless of prompt', () => {
  for (const prompt of ['/compact', 'hello', '']) {
    const r = runHook('hypo-compact-guard.mjs', { prompt });
    assert.doesNotThrow(() => JSON.parse(r.stdout), `invalid JSON for prompt="${prompt}"`);
  }
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
  assert.ok(!('additionalContext' in out), 'PreCompact must not use unsupported additionalContext field');
});

test('clean wiki → suppressOutput:true', () => {
  withCleanWiki(dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.suppressOutput, true);
    assert.equal(out.continue, true);
  });
});

// ── upgrade.mjs smoke tests ───────────────────────────────────────────────────

suite('upgrade.mjs --json');

test('exits without crashing on non-existent wiki dir', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  assert.ok(r.status !== null, 'process did not exit cleanly');
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}\n${r.stderr}`);
});

test('--json output is valid JSON', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout not JSON: ${r.stdout}`);
});

test('JSON output has required top-level fields', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const out = JSON.parse(r.stdout);
  assert.ok('schema'   in out, 'missing schema field');
  assert.ok('hooks'    in out, 'missing hooks field');
  assert.ok('settings' in out, 'missing settings field');
  assert.ok('applied'  in out, 'missing applied field');
});

test('schema object has installed/current/bump fields', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const { schema } = JSON.parse(r.stdout);
  assert.ok('installed' in schema, 'schema missing installed');
  assert.ok('current'   in schema, 'schema missing current');
  assert.ok('bump'      in schema, 'schema missing bump');
});

test('hooks is an array of file/status objects', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const { hooks } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(hooks), 'hooks should be an array');
  assert.ok(hooks.length > 0, 'expected at least one hook entry');
  assert.ok('file'   in hooks[0], 'hook entry missing file');
  assert.ok('status' in hooks[0], 'hook entry missing status');
});

test('settings is an array of event/file/status objects', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const { settings } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(settings), 'settings should be an array');
  assert.ok(settings.length > 0, 'expected at least one settings entry');
  assert.ok('event'  in settings[0], 'settings entry missing event');
  assert.ok('file'   in settings[0], 'settings entry missing file');
  assert.ok('status' in settings[0], 'settings entry missing status');
});

test('applied object has hooks and settings arrays', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const { applied } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(applied.hooks),    'applied.hooks should be array');
  assert.ok(Array.isArray(applied.settings), 'applied.settings should be array');
});

test('schema.installed is null and bump is "unknown" for non-existent wiki', () => {
  const r = run('upgrade.mjs', [
    `--hypo-dir=${NONEXISTENT_WIKI}`,
    '--json',
  ]);
  const { schema } = JSON.parse(r.stdout);
  // No SCHEMA.md → installed=null, version comparison impossible → bump='unknown'
  assert.equal(schema.installed, null, 'missing SCHEMA.md should yield installed=null');
  assert.equal(schema.bump, 'unknown', 'unresolvable versions should yield bump=unknown');
  // Exit code is 0 or 1 depending on installed hook/settings state (environment-dependent)
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}`);
});

test('--apply on tmp wiki exits 0 after applying available changes', () => {
  withTmpHome(home => {
    withTmpDir(dir => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.signal, null, `process killed with signal: ${r.signal}`);
      const out = JSON.parse(r.stdout);
      assert.ok('applied' in out, 'applied field missing after --apply');
      assert.ok(Array.isArray(out.applied.hooks), 'applied.hooks should be an array');
      assert.ok(Array.isArray(out.applied.settings), 'applied.settings should be an array');
      assert.equal(r.status, 0, `expected exit 0 after --apply: ${r.stderr}`);
    });
  });
});

test('--apply .hypoignore migration appends .cache/ and is idempotent', () => {
  withTmpHome(home => {
    withTmpDir(dir => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Simulate a pre-existing user .hypoignore from an older Hypomnema version
      // (no `.cache/` entry). Strip any matching line that may be present from
      // the freshly-scaffolded file.
      const hypoignorePath = join(hypoDir, '.hypoignore');
      const original = readFileSync(hypoignorePath, 'utf-8')
        .split('\n')
        .filter(line => line.trim() !== '.cache/')
        .join('\n');
      writeFileSync(hypoignorePath, original);

      // First --apply: should append .cache/
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first --apply failed: ${r1.stderr}`);
      const out1 = JSON.parse(r1.stdout);
      assert.deepEqual(out1.applied.hypoignore, ['.cache/'], 'expected .cache/ to be appended on first run');
      const afterFirst = readFileSync(hypoignorePath, 'utf-8');
      assert.ok(afterFirst.includes('.cache/'), '.cache/ missing from .hypoignore after first --apply');
      assert.equal(
        (afterFirst.match(/^\.cache\/$/gm) || []).length,
        1,
        '.cache/ should appear exactly once after first --apply',
      );

      // Second --apply: should be a no-op (idempotency)
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const out2 = JSON.parse(r2.stdout);
      assert.deepEqual(out2.applied.hypoignore, [], 'second --apply should not append anything');
      assert.equal(out2.hypoignore.status, 'up-to-date', 'hypoignore status should be up-to-date on second run');
      const afterSecond = readFileSync(hypoignorePath, 'utf-8');
      assert.equal(afterSecond, afterFirst, '.hypoignore content drifted across idempotent --apply');
    });
  });
});

test('--apply generates migration report for major SCHEMA bump', () => {
  withTmpHome(home => {
    withTmpDir(dir => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Patch SCHEMA.md to an older major version to simulate a major bump
      const schemaPath = join(hypoDir, 'SCHEMA.md');
      const schema = readFileSync(schemaPath, 'utf-8');
      writeFileSync(schemaPath, schema.replace(/^version: .+$/m, 'version: 0.9'));

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.signal, null, `process killed with signal: ${r.signal}`);
      const out = JSON.parse(r.stdout);
      assert.ok(out.migrationReport !== null, 'migrationReport should be set for major bump');
      assert.ok(typeof out.migrationReport === 'string', 'migrationReport should be a path string');
      assert.ok(existsSync(out.migrationReport), `migration report file not found: ${out.migrationReport}`);
      const content = readFileSync(out.migrationReport, 'utf-8');
      assert.ok(content.includes('0.9'), 'migration report should reference old version');
      assert.ok(content.includes('1.0'), 'migration report should reference new version');
    });
  });
});

// ── lint.mjs --fix tests ─────────────────────────────────────────────────────

suite('lint.mjs --fix');

function lintFix(content) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-'));
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir);
  writeFileSync(join(pagesDir, 'test.md'), content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--fix', '--json']);
  const fixed = readFileSync(join(pagesDir, 'test.md'), 'utf-8');
  rmSync(dir, { recursive: true, force: true });
  return { r, fixed };
}

test('--fix inserts updated into LF frontmatter', () => {
  const { fixed } = lintFix('---\ntitle: T\ntype: concept\n---\nbody\n');
  const fm = fixed.slice(0, fixed.indexOf('\n---\n') + 5);
  assert.ok(fm.includes('updated:'), 'updated not inserted into frontmatter');
  assert.ok(!fixed.slice(fixed.indexOf('\n---\n') + 5).includes('updated:'), 'updated inserted outside frontmatter');
});

test('--fix inserts updated into CRLF frontmatter', () => {
  const { fixed } = lintFix('---\r\ntitle: T\r\ntype: concept\r\n---\r\nbody\r\n');
  assert.ok(fixed.includes('updated:'), 'updated not inserted');
  const fmEnd = fixed.indexOf('\r\n---\r\n');
  assert.ok(fixed.indexOf('updated:') < fmEnd, 'updated inserted outside frontmatter');
});

test('--fix handles mixed line endings (LF frontmatter + CRLF body)', () => {
  const { fixed } = lintFix('---\ntitle: T\ntype: concept\n---\r\nbody\r\n');
  const fmEnd = fixed.indexOf('\n---\r\n');
  assert.ok(fmEnd > 0, 'frontmatter closing not found');
  const updatedPos = fixed.indexOf('updated:');
  assert.ok(updatedPos > 0 && updatedPos < fmEnd, `updated at ${updatedPos}, fm closes at ${fmEnd}`);
});

test('--fix skips file with no frontmatter', () => {
  const { fixed } = lintFix('# No frontmatter here\nbody\n');
  assert.ok(!fixed.includes('updated:'), 'should not insert updated into file without frontmatter');
});

test('--json output omits internal path field', () => {
  const { r } = lintFix('---\ntitle: T\ntype: concept\n---\nbody\n');
  const out = JSON.parse(r.stdout);
  const allIssues = [...(out.errors || []), ...(out.warns || [])];
  assert.ok(allIssues.every(i => !('path' in i)), 'path field leaked into JSON output');
});

suite('lint.mjs session-state schema');

function lintSessionState(content) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-state-'));
  const projectDir = join(dir, 'projects', 'proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'session-state.md'), content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(dir, { recursive: true, force: true });
  return { r, out };
}

test('accepts 다음 작업 as a session-state next heading alias', () => {
  const { r, out } = lintSessionState('---\ntitle: Session State\ntype: session-state\nupdated: 2026-05-07\n---\n# Session State\n\n## 다음 작업\n\n- Continue\n');
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.deepEqual(out.errors, []);
});

test('errors when project session-state lacks a next heading', () => {
  const { r, out } = lintSessionState('---\ntitle: Session State\ntype: session-state\nupdated: 2026-05-07\n---\n# Session State\n\n## Background\n\n- Missing next section\n');
  assert.equal(r.status, 1, `expected lint error\nstdout: ${r.stdout}`);
  assert.ok(out.errors.some(i =>
    i.file === 'projects/proj/session-state.md'
    && i.message.includes('Missing required session-state heading')
  ), `missing session-state heading error: ${r.stdout}`);
});

// ── Lane B: formatGrowthMetrics + growth echo regressions ─────────────────

const { formatGrowthMetrics, computeSessionGrowth } = await import(
  join(HOOKS, 'hypo-shared.mjs')
);

suite('formatGrowthMetrics()');

test('stop mode happy path', () => {
  const out = formatGrowthMetrics('stop', { addedPages: 2, updatedPages: 3, newWikilinks: 5 });
  assert.equal(out, '[hypo] +2 pages, ~3 updated, 5 wikilinks');
});

test('start mode happy path', () => {
  const out = formatGrowthMetrics('start', { addedPages: 1, updatedPages: 0, newWikilinks: 2 });
  assert.ok(out.startsWith('[hypo] 직전 세션: +1 pages, ~0 updated, 2 wikilinks'));
  assert.ok(out.includes('이어서 볼까요'));
});

test('stop mode edge: all zeros → empty string', () => {
  assert.equal(formatGrowthMetrics('stop', { addedPages: 0, updatedPages: 0, newWikilinks: 0 }), '');
  assert.equal(formatGrowthMetrics('stop', {}), '');
  assert.equal(formatGrowthMetrics('stop', null), '');
});

test('start mode edge: unknown mode or missing fields', () => {
  assert.equal(formatGrowthMetrics('weird', { addedPages: 1 }), '');
  const out = formatGrowthMetrics('start', { addedPages: 1 });
  assert.ok(out.includes('+1 pages, ~0 updated, 0 wikilinks'));
});

suite('hypo-hot-rebuild.mjs — growth echo regression');

function withGrowthWiki(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-growth-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(join(dir, 'hot.md'),
      '---\ntitle: Hot\nupdated: today\n---\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runStop(hookFile, dir) {
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: '{}',
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: dir },
  });
}

test('hot-rebuild writes growth cache when wiki has changes', () => {
  withGrowthWiki(dir => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'new.md'), '---\ntitle: New\n---\nrefs [[other]] and [[third]]\n');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('[hypo] +1 pages'), `expected growth line in stderr: ${r.stderr}`);
    const cache = JSON.parse(readFileSync(join(dir, '.cache', 'last-session-growth.json'), 'utf-8'));
    assert.equal(cache.addedPages, 1);
    assert.ok(cache.newWikilinks >= 2);
  });
});

test('hot-rebuild emits no growth line when wiki is clean', () => {
  withGrowthWiki(dir => {
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes('[hypo] +'), `unexpected growth line: ${r.stderr}`);
  });
});

suite('hypo-auto-commit.mjs / hypo-auto-stage.mjs — .hypoignore honor');

test('auto-commit skips .hypoignore-listed .cache paths', () => {
  withGrowthWiki(dir => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    mkdirSync(join(dir, '.cache', 'sessions'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'sessions', 'index.jsonl'), '{"session_id":"x"}\n');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'note.md'), '# note\n');
    const r = runStop('hypo-auto-commit.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const tracked = spawnSync('git', ['-C', dir, 'ls-files', '.cache'], { encoding: 'utf-8' }).stdout;
    assert.equal(tracked.trim(), '', `expected .cache to be excluded, got: ${tracked}`);
    const trackedPages = spawnSync('git', ['-C', dir, 'ls-files', 'pages'], { encoding: 'utf-8' }).stdout;
    assert.ok(trackedPages.includes('pages/note.md'), 'pages/ should still be committed');
  });
});

test('auto-stage skips .hypoignore-listed file_path', () => {
  withGrowthWiki(dir => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'a.json'), '{}\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-stage.mjs')], {
      input: JSON.stringify({ tool_input: { file_path: join(dir, '.cache', 'a.json') } }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0);
    const staged = spawnSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf-8' }).stdout;
    assert.equal(staged.trim(), '', `unexpected staged: ${staged}`);
  });
});

suite('hypo-session-start.mjs — growth echo regression');

function runStart(dir, cwd) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-session-start.mjs')], {
    input: JSON.stringify({ cwd: cwd || dir, session_id: 'test-growth' }),
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: dir },
  });
}

test('session-start injects growth line when cache exists', () => {
  withGrowthWiki(dir => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'last-session-growth.json'),
      JSON.stringify({ addedPages: 4, updatedPages: 2, newWikilinks: 7, ts: Date.now() }));
    const r = runStart(dir);
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext || '';
    assert.ok(ctx.includes('직전 세션: +4 pages, ~2 updated, 7 wikilinks'),
      `growth prefix missing in additionalContext: ${ctx}`);
  });
});

test('session-start emits no growth line when cache absent', () => {
  withGrowthWiki(dir => {
    const r = runStart(dir);
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext || '';
    assert.ok(!ctx.includes('직전 세션'), `unexpected growth line: ${ctx}`);
  });
});

// ── weekly-report.mjs (Lane E) ───────────────────────────────────────────────

suite('weekly-report.mjs');

test('--write produces pages/observability/<YYYY-WW>.md with autonomy score', () => {
  withTmpDir(dir => {
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

    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-19', '--write']);
    assert.equal(r.status, 0, `weekly-report failed: ${r.stderr}\nstdout: ${r.stdout}`);

    const reportPath = join(dir, 'pages', 'observability', '2026-19.md');
    assert.ok(existsSync(reportPath), `report file not written: ${reportPath}`);
    const content = readFileSync(reportPath, 'utf-8');
    assert.ok(content.includes('Autonomy score'), 'report missing autonomy score header');
    assert.ok(content.includes('| w1 |'), 'report should list session w1');
    assert.ok(/^---\n[\s\S]*?\n---\n/.test(content), 'report missing frontmatter');
  });
});

test('autonomy score: clamped to 100 with ingest-heavy session', () => {
  withTmpDir(dir => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    // Single session w/ ingest commands and no URL penalty — numerator should
    // exceed denominator so the clamp kicks in.
    const transcriptPath = join(cacheDir, 'heavy.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push({ type: 'text', role: 'assistant', content: '/hypo:ingest source-' + i });
    }
    writeFileSync(transcriptPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(
      join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'heavy',
        transcript_path: transcriptPath,
        recorded_at: '2026-05-06T12:00:00Z',
        cwd: dir,
      }) + '\n',
    );
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-19', '--json']);
    assert.equal(r.status, 0, `weekly-report --json failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.score <= 100, `score must be clamped to 100, got ${out.score}`);
    assert.ok(out.score >= 0, `score must be ≥0, got ${out.score}`);
    assert.equal(out.count, 1);
  });
});

test('autonomy score: 0 when only staleness-skip sessions are in the week', () => {
  withTmpDir(dir => {
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
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2020-02', '--json']);
    assert.equal(r.status, 0, `weekly-report --json failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    // The session matched the week but should be staleness-skipped, so the
    // score numerator/denominator both stay 0 → score is 0.
    assert.equal(out.score, 0, `expected 0 score for staleness-only week, got ${out.score}`);
  });
});

test('--json returns valid report payload (week with no matching sessions)', () => {
  withTmpDir(dir => {
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

    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2099-50', '--json']);
    assert.equal(r.status, 0, `weekly-report --json failed: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.week, '2099-50');
    assert.equal(out.count, 0, `expected 0 sessions in 2099-50, got ${out.count}`);
    assert.equal(typeof out.score, 'number');
  });
});

// ── session-audit.mjs fixtures ───────────────────────────────────────────────

suite('session-audit.mjs (transcript dual-source — ADR 0019)');

function setupAuditFixture(hypoDir, { transcriptLines, recordedAtIso }) {
  const cacheDir      = join(hypoDir, '.cache', 'sessions');
  mkdirSync(cacheDir, { recursive: true });
  const transcriptPath = join(cacheDir, 'fixture-transcript.jsonl');
  writeFileSync(
    transcriptPath,
    transcriptLines.map(l => JSON.stringify(l)).join('\n') + '\n',
  );
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
const STALE  = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago

test('fixture: normal — exactly one search, no urls, no ingest', () => {
  withTmpDir(dir => {
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
  withTmpDir(dir => {
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
  withTmpDir(dir => {
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
  withTmpDir(dir => {
    setupAuditFixture(dir, {
      recordedAtIso: RECENT,
      transcriptLines: [
        { type: 'text', role: 'user', content: 'check https://example.com/a and https://example.com/b' },
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
  withTmpDir(dir => {
    setupAuditFixture(dir, {
      recordedAtIso: STALE,
      transcriptLines: [
        { type: 'tool_use', name: 'Grep', input: { pattern: 'old' } },
      ],
    });
    const r = runAudit(dir);
    assert.equal(r.classification, 'staleness-skip');
    assert.ok(r.age_days > 30, `expected age > 30 days, got ${r.age_days}`);
  });
});

test('fallback: empty index falls back to ~/.claude/projects scan path', () => {
  withTmpDir(dir => {
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
  withTmpDir(dir => {
    setupAuditFixture(dir, {
      recordedAtIso: RECENT,
      transcriptLines: [
        // Real Claude Code transcript shape: tool_use lives inside
        // message.content[], top-level has no type/name field.
        { parentUuid: 'a', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' } },
        ] } },
        { parentUuid: 'b', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 't2', name: 'WebFetch', input: { url: 'https://example.com' } },
        ] } },
      ],
    });
    const r = runAudit(dir);
    assert.equal(r.metrics.search_count, 2,
      `expected search_count=2 for two nested tool_use blocks, got ${r.metrics.search_count}`);
  });
});

suite('session-audit.mjs — fallback scope');

test('fallback scope: unrelated ~/.claude/projects subdirs are skipped by default', () => {
  withTmpDir(dir => {
    withTmpHome(home => {
      // Seed two unrelated encoded project dirs — neither matches `dir`.
      const unrelated1 = join(home, '.claude', 'projects', '-other-project-a');
      const unrelated2 = join(home, '.claude', 'projects', '-other-project-b');
      mkdirSync(unrelated1, { recursive: true });
      mkdirSync(unrelated2, { recursive: true });
      writeFileSync(join(unrelated1, 'sess-x.jsonl'),
        JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n');
      writeFileSync(join(unrelated2, 'sess-y.jsonl'),
        JSON.stringify({ type: 'tool_use', name: 'WebFetch' }) + '\n');
      const r = runWithHome('session-audit.mjs', [`--hypo-dir=${dir}`, '--json'], home);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.count, 0,
        `default fallback must skip unrelated dirs, got ${out.count} sessions`);
    });
  });
});

test('fallback scope: --fallback-all-projects opts in to full scan', () => {
  withTmpDir(dir => {
    withTmpHome(home => {
      const other = join(home, '.claude', 'projects', '-some-other');
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, 'sess-z.jsonl'),
        JSON.stringify({ type: 'tool_use', name: 'Grep' }) + '\n');
      const r = runWithHome('session-audit.mjs',
        [`--hypo-dir=${dir}`, '--fallback-all-projects', '--json'], home);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(out.count >= 1, `expected ≥1 session with --fallback-all-projects, got ${out.count}`);
    });
  });
});

suite('weekly-report.mjs — privacy contract');

test('weekly report does not leak transcript text, URLs, or tool inputs', () => {
  withTmpDir(dir => {
    const cacheDir = join(dir, '.cache', 'sessions');
    mkdirSync(cacheDir, { recursive: true });
    const SECRET_URL    = 'https://internal.example.com/super-secret-path';
    const SECRET_TEXT   = 'PRIVATE_TRANSCRIPT_BODY_DO_NOT_LEAK';
    const SECRET_INPUT  = 'SECRET_TOOL_INPUT_DO_NOT_LEAK';
    const SECRET_CMD    = 'rm -rf /private/path/that/must/not/leak';
    const transcriptPath = join(cacheDir, 'leaky.jsonl');
    writeFileSync(transcriptPath, [
      JSON.stringify({ type: 'text', role: 'assistant', content: `${SECRET_TEXT} ${SECRET_URL}` }),
      JSON.stringify({ message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: SECRET_CMD, description: SECRET_INPUT } },
      ] } }),
    ].join('\n') + '\n');
    writeFileSync(join(cacheDir, 'index.jsonl'),
      JSON.stringify({
        session_id: 'leaky-session',
        transcript_path: transcriptPath,
        recorded_at: '2026-05-06T12:00:00Z',
        cwd: dir,
      }) + '\n');
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=2026-19', '--write']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const reportPath = join(dir, 'pages', 'observability', '2026-19.md');
    const report = readFileSync(reportPath, 'utf-8');
    for (const secret of [SECRET_URL, SECRET_TEXT, SECRET_INPUT, SECRET_CMD]) {
      assert.ok(!report.includes(secret),
        `weekly report leaked "${secret}" — privacy contract broken`);
    }
    // session_id and aggregate counts are the only per-session signal allowed.
    assert.ok(report.includes('leaky-session'), 'session_id should be present');
  });
});

suite('weekly-report.mjs — --week validation');

test('--week=invalid exits non-zero with a clear error', () => {
  withTmpDir(dir => {
    const r = run('weekly-report.mjs', [`--hypo-dir=${dir}`, '--week=not-a-week', '--json']);
    assert.notEqual(r.status, 0, 'should reject malformed --week');
    assert.ok(r.stderr.includes('invalid --week'), `stderr should explain: ${r.stderr}`);
  });
});

suite('hypo-shared.computeSessionGrowth — pages/projects scope');

test('growth ignores root README.md / hot.md (out of pages/projects scope)', () => {
  withGrowthWiki(dir => {
    // Touch a top-level scaffolding file. Should NOT count as page growth.
    writeFileSync(join(dir, 'README.md'), '# readme\n');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0);
    assert.ok(!r.stderr.includes('[hypo] +'),
      `unexpected growth line for root README: ${r.stderr}`);
  });
});

test('growth ignores wikilinks introduced outside pages/projects', () => {
  withGrowthWiki(dir => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'real.md'), '# real\n[[other]]\n');
    // A non-Markdown file with a wikilink-shaped string must not be counted.
    writeFileSync(join(dir, 'script.js'), '// see [[noise]] but not a wiki link\n');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0);
    const cache = JSON.parse(readFileSync(join(dir, '.cache', 'last-session-growth.json'), 'utf-8'));
    assert.equal(cache.addedPages, 1, 'only the pages/real.md should count');
    assert.equal(cache.newWikilinks, 1, 'wikilink-shaped string in script.js must be ignored');
  });
});

// ── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nFailed tests:`);
  for (const { name, err } of failures) {
    console.error(`  ✗ ${name}: ${err.message}`);
  }
  process.exit(1);
}
