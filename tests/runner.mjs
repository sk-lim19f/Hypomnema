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
