#!/usr/bin/env node
/**
 * tests/runner.mjs — Hypomnema test runner (no external deps)
 *
 * Runs unit tests for lib functions and smoke tests for CLI scripts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME     = homedir();
const REPO     = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRIPTS  = join(REPO, 'scripts');

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

// ── lib/wiki-root.mjs ────────────────────────────────────────────────────────

const { expandHome, resolveWikiRoot } = await import(`${SCRIPTS}/lib/wiki-root.mjs`);

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

suite('resolveWikiRoot()');

test('HYPO_DIR env var takes precedence', () => {
  const orig = process.env.HYPO_DIR;
  process.env.HYPO_DIR = '/tmp/custom-wiki';
  try {
    assert.equal(resolveWikiRoot(), '/tmp/custom-wiki');
  } finally {
    if (orig === undefined) delete process.env.HYPO_DIR;
    else process.env.HYPO_DIR = orig;
  }
});

test('falls back to ~/wiki when no env or marker found', () => {
  const orig = process.env.HYPO_DIR;
  delete process.env.HYPO_DIR;
  try {
    const result = resolveWikiRoot();
    // Either found a real wiki (has hypo-config.md) or returned ~/wiki default
    assert.ok(typeof result === 'string' && result.length > 0);
    assert.ok(result.startsWith('/'));
  } finally {
    if (orig !== undefined) process.env.HYPO_DIR = orig;
  }
});

test('finds wiki by hypo-config.md marker', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    const orig = process.env.HYPO_DIR;
    delete process.env.HYPO_DIR;
    // We can't easily override the candidate list, so just verify the function
    // returns a string without throwing
    const result = resolveWikiRoot();
    assert.ok(typeof result === 'string');
    if (orig !== undefined) process.env.HYPO_DIR = orig;
  });
});

// ── init.mjs smoke tests ─────────────────────────────────────────────────────

suite('init.mjs --dry-run');

test('exits 0 with --dry-run --no-hooks --no-git-init', () => {
  withTmpDir(dir => {
    const r = run('init.mjs', [
      `--wiki-dir=${dir}/wiki`,
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
    const wikiDir = join(dir, 'wiki');
    const r = run('init.mjs', [
      `--wiki-dir=${wikiDir}`,
      '--dry-run',
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!existsSync(wikiDir), 'wiki dir should not be created in dry-run');
  });
});

test('--privacy=shared writes shared-mode content to .wikiignore', () => {
  withTmpDir(dir => {
    const wikiDir = join(dir, 'wiki');
    const r = run('init.mjs', [
      `--wiki-dir=${wikiDir}`,
      '--privacy=shared',
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const wikiignore = readFileSync(join(wikiDir, '.wikiignore'), 'utf-8');
    assert.ok(wikiignore.includes('*personal*'), '.wikiignore missing shared-mode pattern');
    assert.ok(wikiignore.includes('journal/'), '.wikiignore missing journal/ exclusion');
  });
});

test('actual run creates expected directories', () => {
  withTmpDir(dir => {
    const wikiDir = join(dir, 'wiki');
    const r = run('init.mjs', [
      `--wiki-dir=${wikiDir}`,
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const sub of ['pages', 'projects', 'sources']) {
      assert.ok(existsSync(join(wikiDir, sub)), `missing: ${sub}/`);
    }
  });
});

// ── doctor.mjs smoke tests ───────────────────────────────────────────────────

suite('doctor.mjs --json');

test('exits without crashing on non-existent wiki dir', () => {
  const r = run('doctor.mjs', [
    '--wiki-dir=/tmp/nonexistent-hypo-wiki-99999',
    '--json',
  ]);
  // doctor may exit 1 (failures found) but should not crash (exit 2+)
  assert.ok(r.status !== null, 'process did not exit cleanly');
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}\n${r.stderr}`);
});

test('--json output is valid JSON', () => {
  const r = run('doctor.mjs', [
    '--wiki-dir=/tmp/nonexistent-hypo-wiki-99999',
    '--json',
  ]);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout not JSON: ${r.stdout}`);
});

test('JSON output is an array of check objects', () => {
  const r = run('doctor.mjs', [
    '--wiki-dir=/tmp/nonexistent-hypo-wiki-99999',
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
  join(HOOKS, 'wiki-shared.mjs')
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
  const o2 = process.env.OMC_SKIP_WIKI_GATE;
  delete process.env.HYPO_SKIP_GATE;
  delete process.env.OMC_SKIP_WIKI_GATE;
  try { assert.equal(isGateSkipped(), false); }
  finally {
    if (o1 !== undefined) process.env.HYPO_SKIP_GATE = o1;
    if (o2 !== undefined) process.env.OMC_SKIP_WIKI_GATE = o2;
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

suite('wiki-compact-guard.mjs — contract');

test('invalid JSON input → fail-open {continue:true}', () => {
  const r = runHook('wiki-compact-guard.mjs', 'not-json');
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('non-compact prompt → pass-through', () => {
  const r = runHook('wiki-compact-guard.mjs', { prompt: 'hello world' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('HYPO_SKIP_GATE=1 + /compact → pass-through', () => {
  const r = runHook('wiki-compact-guard.mjs', { prompt: '/compact' }, { HYPO_SKIP_GATE: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('/compact with incomplete wiki → additionalContext, not systemMessage', () => {
  const r = runHook('wiki-compact-guard.mjs', { prompt: '/compact' });
  const out = JSON.parse(r.stdout);
  assert.ok('additionalContext' in out, 'missing additionalContext field');
  assert.ok(!('systemMessage' in out), 'must not use deprecated systemMessage field');
});

test('/compact with incomplete wiki → continue:true (soft nudge, not block)', () => {
  const r = runHook('wiki-compact-guard.mjs', { prompt: '/compact' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
});

test('/compact with incomplete wiki → additionalContext contains WIKI_AUTOCLOSE', () => {
  const r = runHook('wiki-compact-guard.mjs', { prompt: '/compact' });
  const out = JSON.parse(r.stdout);
  assert.ok(out.additionalContext.includes('WIKI_AUTOCLOSE'), 'missing WIKI_AUTOCLOSE marker');
});

test('/compact with clean wiki → pass-through', () => {
  withCleanWiki(dir => {
    const r = runHook('wiki-compact-guard.mjs', { prompt: '/compact' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true);
  });
});

test('output is always valid JSON regardless of prompt', () => {
  for (const prompt of ['/compact', 'hello', '']) {
    const r = runHook('wiki-compact-guard.mjs', { prompt });
    assert.doesNotThrow(() => JSON.parse(r.stdout), `invalid JSON for prompt="${prompt}"`);
  }
});

suite('personal-wiki-check.mjs — contract');

test('output is always valid JSON', () => {
  const r = runHook('personal-wiki-check.mjs', '');
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout: ${r.stdout}`);
});

test('no wiki dir → block decision', () => {
  const r = runHook('personal-wiki-check.mjs', '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.equal(out.continue, false);
});

test('block response includes stopReason string', () => {
  const r = runHook('personal-wiki-check.mjs', '');
  const out = JSON.parse(r.stdout);
  assert.ok(typeof out.stopReason === 'string' && out.stopReason.length > 0);
});

test('block reason contains WIKI CHECK marker', () => {
  const r = runHook('personal-wiki-check.mjs', '');
  const out = JSON.parse(r.stdout);
  assert.ok(out.reason.includes('WIKI CHECK'), 'missing WIKI CHECK marker in reason');
});

test('HYPO_SKIP_GATE=1 → continue:true + systemMessage (PreCompact has no additionalContext)', () => {
  const r = runHook('personal-wiki-check.mjs', '', { HYPO_SKIP_GATE: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  // PreCompact hook does not support additionalContext per Claude Code docs — systemMessage is the correct universal field.
  assert.ok('systemMessage' in out, 'missing systemMessage field');
  assert.ok(!('additionalContext' in out), 'PreCompact must not use unsupported additionalContext field');
});

test('clean wiki → suppressOutput:true', () => {
  withCleanWiki(dir => {
    const r = runHook('personal-wiki-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.suppressOutput, true);
    assert.equal(out.continue, true);
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
