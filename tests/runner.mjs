#!/usr/bin/env node
/**
 * tests/runner.mjs — Hypomnema test runner (no external deps)
 *
 * Runs unit tests for lib functions and smoke tests for CLI scripts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  statSync,
  unlinkSync,
  cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// static import (no top-level await) — feedback-sync.mjs guards main() behind an
// entry check, so importing it for unit tests does not run the CLI.
import { resolveProjectId as fbResolveProjectId } from '../scripts/feedback-sync.mjs';
import { createProject, substituteTokens, insertHotRow } from '../scripts/lib/project-create.mjs';
import { buildProjectSuggestionLine } from '../hooks/hypo-shared.mjs';

const HOME = homedir();
const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCRIPTS = join(REPO, 'scripts');
const NONEXISTENT_WIKI = join(tmpdir(), `hypo-no-wiki-${process.pid}`);

// Session-wide tmp HOME: every child process launched via run() inherits this
// HOME so scripts like init.mjs cannot write to the real ~/.claude/. Tests that
// need a specific HOME use runWithHome() to override.
const SESSION_TMP_HOME = mkdtempSync(join(tmpdir(), 'hypo-session-home-'));
process.on('exit', () => {
  try {
    rmSync(SESSION_TMP_HOME, { recursive: true, force: true });
  } catch {}
});

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

function suite(label) {
  console.log(`\n${label}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function run(script, args = []) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
  });
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTmpHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-home-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    assert.ok(
      isDefault || hasMarker,
      `resolveHypoRoot returned "${result}" which is neither the default nor has hypo-config.md`,
    );
  } finally {
    if (orig !== undefined) process.env.HYPO_DIR = orig;
  }
});

// ── init.mjs smoke tests ─────────────────────────────────────────────────────

suite('init.mjs --dry-run');

test('exits 0 with --dry-run --no-hooks --no-git-init', () => {
  withTmpDir((dir) => {
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
  withTmpDir((dir) => {
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
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const sub of ['pages', 'projects', 'sources', 'pages/observability']) {
      assert.ok(existsSync(join(hypoDir, sub)), `missing: ${sub}/`);
    }
  });
});

test('init creates pages/observability/_index.md stub', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const stubPath = join(hypoDir, 'pages', 'observability', '_index.md');
    assert.ok(existsSync(stubPath), 'pages/observability/_index.md should be created');
    const content = readFileSync(stubPath, 'utf8');
    assert.ok(
      content.includes('autonomy score'),
      '_index.md should contain autonomy score section',
    );
  });
});

test('--no-hooks succeeds without touching hook config', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `--no-hooks should exit 0: ${r.stderr}`);
    assert.ok(existsSync(join(hypoDir, 'index.md')), 'wiki files should still be created');
  });
});

test('init creates .gitignore with .cache/ entry', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const gitignorePath = join(hypoDir, '.gitignore');
    assert.ok(existsSync(gitignorePath), '.gitignore should be created');
    const content = readFileSync(gitignorePath, 'utf8');
    assert.ok(content.includes('.cache/'), '.gitignore should exclude .cache/');
  });
});

// init-creates-extensions-baseline (§8.12, ADR 0024 fix #28)
test('init-creates-extensions-baseline', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    for (const t of ['hooks', 'commands', 'skills', 'agents']) {
      const extDir = join(hypoDir, 'extensions', t);
      assert.ok(existsSync(extDir), `extensions/${t}/ should be created`);
      assert.ok(
        existsSync(join(extDir, '.gitkeep')),
        `extensions/${t}/.gitkeep should be created (git-trackable empty dir)`,
      );
    }
  });
});

test('init installs .git/hooks/pre-commit with hypo marker', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const hookPath = join(hypoDir, '.git', 'hooks', 'pre-commit');
    assert.ok(existsSync(hookPath), '.git/hooks/pre-commit should be created');
    const content = readFileSync(hookPath, 'utf8');
    assert.ok(
      content.includes('# hypo-managed:pre-commit:start'),
      'hook should contain hypo marker',
    );
    assert.ok(content.includes('hypo-pre-commit.mjs'), 'hook should reference worker script');
  });
});

test('pre-commit hook blocks staged .env file via git commit', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.email', 'test@hypo.test'], {
      stdio: 'ignore',
    });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.name', 'Hypo Test'], { stdio: 'ignore' });
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    // Make an initial commit so the repo is non-empty
    spawnSync('git', ['-C', hypoDir, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

    // Stage a file matching .env* pattern
    writeFileSync(join(hypoDir, '.env.local'), 'SECRET=abc\n');
    spawnSync('git', ['-C', hypoDir, 'add', '.env.local'], { stdio: 'ignore' });

    // git commit must be blocked by the pre-commit hook
    const commitR = spawnSync('git', ['-C', hypoDir, 'commit', '-m', 'should be blocked'], {
      encoding: 'utf-8',
    });
    assert.notEqual(commitR.status, 0, 'git commit should fail when .env.local is staged');
    assert.ok(
      (commitR.stdout + commitR.stderr).includes('.env.local'),
      `expected .env.local in git output: ${commitR.stdout}${commitR.stderr}`,
    );
  });
});

// ── test-hermeticity guard (Stage 2 #3) ──────────────────────────────────────
// Regression guard: tests must never write to the real ~/.claude/. Snapshot
// the real-HOME paths init.mjs would touch, invoke init.mjs via the default
// run() helper, and assert nothing under real HOME changed. If a future test
// accidentally uses runWithHome(home=homedir()) or a script gains a new
// HOME-derived write path not covered by SESSION_TMP_HOME, this test fails.

suite('test hermeticity — run() must not touch real HOME');

test('init.mjs invoked via run() does not write to real ~/.claude/', () => {
  const realPaths = [
    join(HOME, '.claude', 'commands', 'hypo'),
    join(HOME, '.claude', 'hypo-pkg.json'),
    join(HOME, '.claude', 'settings.json'),
    join(HOME, '.claude', 'hooks'),
  ];
  const snapshot = realPaths.map((p) => {
    if (!existsSync(p)) return { p, exists: false };
    const s = statSync(p);
    return { p, exists: true, mtimeMs: s.mtimeMs, size: s.size, ino: s.ino };
  });

  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init']);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  });

  for (const before of snapshot) {
    const nowExists = existsSync(before.p);
    assert.equal(
      nowExists,
      before.exists,
      `real HOME path existence changed: ${before.p} (was ${before.exists}, now ${nowExists})`,
    );
    if (before.exists) {
      const s = statSync(before.p);
      assert.equal(s.mtimeMs, before.mtimeMs, `real HOME path mutated (mtime): ${before.p}`);
      assert.equal(s.ino, before.ino, `real HOME path replaced (inode): ${before.p}`);
    }
  }
});

test('run() exports a HOME under tmpdir() that differs from real homedir()', () => {
  // Spawn a tiny probe script via run() and assert the child sees the injected
  // HOME, not the real one. This exercises run()'s env wiring directly instead
  // of only asserting the SESSION_TMP_HOME constant.
  withTmpDir((dir) => {
    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, "process.stdout.write(process.env.HOME ?? '')\n");
    const r = spawnSync(process.execPath, [probe], {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    assert.equal(r.stdout, SESSION_TMP_HOME, 'child must see SESSION_TMP_HOME');
    assert.notEqual(r.stdout, HOME, 'child must not see real homedir()');
    assert.ok(
      r.stdout.startsWith(tmpdir()),
      `child HOME must live under tmpdir(), got ${r.stdout}`,
    );
  });
});

// ── doctor.mjs smoke tests ───────────────────────────────────────────────────

suite('doctor.mjs --json');

test('exits without crashing on non-existent wiki dir', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  // doctor may exit 1 (failures found) but should not crash (exit 2+)
  assert.ok(r.status !== null, 'process did not exit cleanly');
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}\n${r.stderr}`);
});

test('--json output is valid JSON', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout not JSON: ${r.stdout}`);
});

test('JSON output is an array of check objects', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out), 'expected top-level array');
  assert.ok(out.length > 0, 'expected at least one check');
  assert.ok('status' in out[0], 'expected status field');
  assert.ok('label' in out[0], 'expected label field');
});

// fix #28: doctor gates on extensions baseline existence (ADR 0024)
test('doctor flags missing extensions baseline dir as failure', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

    // freshly-inited wiki: extensions baseline present → doctor check passes
    let r = run('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json']);
    let checks = JSON.parse(r.stdout);
    const extCheck = checks.find((c) => c.label === 'Directory: extensions/hooks/');
    assert.ok(extCheck, 'doctor should report a Directory: extensions/hooks/ check');
    assert.equal(extCheck.status, 'pass', 'extensions/hooks/ should pass on a fresh wiki');

    // remove one baseline dir → doctor must fail that check
    rmSync(join(hypoDir, 'extensions', 'hooks'), { recursive: true, force: true });
    r = run('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json']);
    checks = JSON.parse(r.stdout);
    const missing = checks.find((c) => c.label === 'Directory: extensions/hooks/');
    assert.equal(missing.status, 'fail', 'missing extensions/hooks/ should fail doctor');
  });
});

// fix #6: doctor-checks-node-git-shell-npm
suite('doctor.mjs — fix #6: external deps');

test('doctor-checks-node-git-shell-npm: Node.js check passes (running on ≥18)', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const nodeCheck = out.find((c) => c.label === 'Node.js ≥ 18');
  assert.ok(nodeCheck, 'Node.js ≥ 18 check not found');
  assert.equal(
    nodeCheck.status,
    'pass',
    `expected pass, got ${nodeCheck.status}: ${nodeCheck.detail}`,
  );
});

test('doctor-checks-node-git-shell-npm: git check present', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const gitCheck = out.find((c) => c.label === 'git');
  assert.ok(gitCheck, 'git check not found');
  assert.ok(['pass', 'fail'].includes(gitCheck.status), `unexpected status: ${gitCheck.status}`);
});

test('doctor-checks-node-git-shell-npm: npm check present', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const npmCheck = out.find((c) => c.label === 'npm');
  assert.ok(npmCheck, 'npm check not found');
  assert.ok(['pass', 'fail'].includes(npmCheck.status), `unexpected status: ${npmCheck.status}`);
});

test('doctor-checks-node-git-shell-npm: shell check present', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const shellCheck = out.find((c) => c.label === 'Shell (zsh/bash)');
  assert.ok(shellCheck, 'Shell check not found');
  assert.ok(
    ['pass', 'warn', 'fail'].includes(shellCheck.status),
    `unexpected status: ${shellCheck.status}`,
  );
});

// fix #7: doctor-settings-integrity
suite('doctor.mjs — fix #7: settings integrity');

test('doctor-settings-integrity: no stale entries → pass', () => {
  withTmpHome((home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const staleCheck = out.find((c) => c.label === 'settings.json stale hypo-* entries');
    assert.ok(staleCheck, 'stale check not found');
    assert.equal(staleCheck.status, 'pass', `expected pass: ${staleCheck.detail}`);
  });
});

test('doctor-settings-integrity: stale hypo-* entry → warn', () => {
  withTmpHome((home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const staleSetting = {
      hooks: {
        PostToolUse: [
          {
            hooks: [{ type: 'command', command: `node $HOME/.claude/hooks/hypo-old-removed.mjs` }],
          },
        ],
      },
    };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(staleSetting));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const staleCheck = out.find((c) => c.label === 'settings.json stale hypo-* entries');
    assert.ok(staleCheck, 'stale check not found');
    assert.equal(staleCheck.status, 'warn', `expected warn: ${staleCheck.detail}`);
  });
});

test('doctor-settings-integrity: duplicate hypo-* entry → warn', () => {
  withTmpHome((home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const dupeSetting = {
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: `node $HOME/.claude/hooks/hypo-auto-commit.mjs` }],
          },
          {
            hooks: [{ type: 'command', command: `node $HOME/.claude/hooks/hypo-auto-commit.mjs` }],
          },
        ],
      },
    };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(dupeSetting));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const dupeCheck = out.find((c) => c.label === 'settings.json duplicate hypo-* entries');
    assert.ok(dupeCheck, 'duplicate check not found');
    assert.equal(dupeCheck.status, 'warn', `expected warn: ${dupeCheck.detail}`);
  });
});

// fix #11: doctor-sync-state-warn
suite('doctor.mjs — fix #11: sync-state warn');

test('doctor-sync-state-warn: no .cache/sync-state.json → pass', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('doctor-sync-state-warn: open sync-state.json entries → warn', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({
        timestamp: '2026-05-14T00:00:00Z',
        op: 'push',
        error: 'network timeout',
        host: 'test',
      }) + '\n',
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
  });
});

// fix #23: doctor-project-suggestions skip-persistence schema check
suite('doctor.mjs — fix #23: auto-project skip-persistence');

function withDoctorWiki(fn) {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    fn(dir);
  });
}

test('doctor-project-suggestions: no file → pass', () => {
  withDoctorWiki((dir) => {
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Auto-project suggestions');
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('doctor-project-suggestions: valid skips[] → pass', () => {
  withDoctorWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'project-suggestions.json'),
      JSON.stringify({
        skips: [{ cwd: '/x/y', declined_at: '2026-05-21T00:00:00Z' }],
        cooldowns: {},
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Auto-project suggestions');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('doctor-project-suggestions: malformed skip entry → warn', () => {
  withDoctorWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'project-suggestions.json'),
      JSON.stringify({ skips: [{ declined_at: '2026-05-21T00:00:00Z' }], cooldowns: {} }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Auto-project suggestions');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
  });
});

test('doctor-project-suggestions: corrupt JSON → warn', () => {
  withDoctorWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'project-suggestions.json'), '{not json');
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Auto-project suggestions');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
  });
});

// codex review 2026-05-22 (MAJOR): a non-array `skips` (which the hook helper
// silently normalizes to []) must still be flagged by doctor, since it breaks
// permanent "N" suppression.
test('doctor-project-suggestions: non-array skips → warn', () => {
  withDoctorWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'project-suggestions.json'),
      JSON.stringify({ skips: { cwd: '/x' }, cooldowns: {} }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Auto-project suggestions');
    assert.equal(check.status, 'warn', `expected warn for non-array skips: ${check.detail}`);
  });
});

test('doctor-project-suggestions: non-object cooldowns → warn', () => {
  withDoctorWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'project-suggestions.json'),
      JSON.stringify({ skips: [], cooldowns: [] }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Auto-project suggestions');
    assert.equal(check.status, 'warn', `expected warn for array cooldowns: ${check.detail}`);
  });
});

// fix #8: doctor-codex-paths
suite('doctor.mjs — fix #8: codex paths');

test('doctor-codex-paths: no codex checks without --codex flag', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const codexChecks = out.filter((c) => c.label.includes('Codex'));
  assert.equal(codexChecks.length, 0, 'expected no Codex checks without --codex flag');
});

test('doctor-codex-paths: --codex flag triggers codex hook file check', () => {
  withTmpHome((home) => {
    const r = runWithHome(
      'doctor.mjs',
      [`--hypo-dir=${NONEXISTENT_WIKI}`, '--codex', '--json'],
      home,
    );
    const out = JSON.parse(r.stdout);
    const hookCheck = out.find((c) => c.label === 'Codex hook files installed');
    assert.ok(hookCheck, 'Codex hook files check not found');
    assert.equal(
      hookCheck.status,
      'fail',
      `expected fail when ~/.codex/hooks is empty: ${hookCheck.detail}`,
    );
  });
});

test('doctor-codex-paths: --codex flag triggers codex settings.json check', () => {
  withTmpHome((home) => {
    const r = runWithHome(
      'doctor.mjs',
      [`--hypo-dir=${NONEXISTENT_WIKI}`, '--codex', '--json'],
      home,
    );
    const out = JSON.parse(r.stdout);
    const settingsCheck = out.find((c) => c.label === 'Codex settings.json hook registrations');
    assert.ok(settingsCheck, 'Codex settings.json check not found');
  });
});

// ── hook contract tests ───────────────────────────────────────────────────────

const HOOKS = join(REPO, 'hooks');

const {
  isCompactCommand,
  isClearCommand,
  isCompactOrClearCommand,
  isGateSkipped,
  buildOutput,
  isClosePattern,
} = await import(join(HOOKS, 'hypo-shared.mjs'));

function runHook(hookFile, stdinData, extraEnv = {}) {
  // Hermeticity invariant (mirrors run() helper, PR #30 / stage-2-#3): child hook
  // must NOT see the developer's real $HOME. Default HOME to SESSION_TMP_HOME so
  // any hook that reads ~/.claude/state/, ~/.claude/, or homedir() lands in the
  // tmp scratch dir. extraEnv may still override HOME explicitly.
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: '/tmp/nonexistent-hypo-99999',
      ...extraEnv,
    },
  });
}

// Build a fully session-closed wiki tree: root hot.md + log.md plus the 4
// project memory files (session-state, project hot.md, session-log) all
// carrying today's date. Mirrors the strict session-close gate (5 mandatory
// files; open-questions.md stays conditional per fix #17 / spec §5.2.7).
function buildCleanWikiTree(dir, today) {
  const ym = today.slice(0, 7);
  const projDir = join(dir, 'projects', 'test-project');
  mkdirSync(join(projDir, 'session-log'), { recursive: true });
  writeFileSync(join(dir, 'hypo-config.md'), '# config');
  writeFileSync(join(dir, 'log.md'), `## [${today}] session | test-project\n`);
  writeFileSync(
    join(dir, 'hot.md'),
    `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
      `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
      `| test-project | ${today} | [[projects/test-project/hot]] |\n`,
  );
  writeFileSync(
    join(projDir, 'session-state.md'),
    `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`,
  );
  writeFileSync(
    join(projDir, 'hot.md'),
    `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`,
  );
  writeFileSync(
    join(projDir, 'session-log', `${ym}.md`),
    `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] test session\n`,
  );
}

// Build a clean wiki tree, optionally mutate it before the initial commit,
// then run `fn(dir, today)`. `mutate` runs pre-commit so tests can make a
// file stale without leaving the git tree dirty (which would block on a
// different reason).
function withWiki(mutate, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-wiki-'));
  try {
    const today = new Date().toISOString().slice(0, 10);
    buildCleanWikiTree(dir, today);
    if (mutate) mutate(dir, today);
    spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8' });
    fn(dir, today);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withCleanWiki(fn) {
  withWiki(null, (dir) => fn(dir));
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

suite('isClearCommand() (fix #25)');

test('/clear → true', () => {
  assert.equal(isClearCommand('/clear'), true);
});

test('/clear with trailing args → true', () => {
  assert.equal(isClearCommand('/clear --all'), true);
});

test('non-clear prompt → false', () => {
  assert.equal(isClearCommand('hello'), false);
  assert.equal(isClearCommand('/clearfoo'), false);
  assert.equal(isClearCommand('/compact'), false);
});

suite('isCompactOrClearCommand() (fix #25)');

test('/compact → true', () => {
  assert.equal(isCompactOrClearCommand('/compact'), true);
});

test('/clear → true', () => {
  assert.equal(isCompactOrClearCommand('/clear'), true);
});

test('other prompt → false', () => {
  assert.equal(isCompactOrClearCommand('hello'), false);
});

suite('isClosePattern()');

test('한국어 세션 마무리 패턴 → true', () => {
  assert.equal(isClosePattern('세션 마무리하자'), true);
  assert.equal(isClosePattern('세션 종료할게'), true);
  assert.equal(isClosePattern('세션 끝'), true);
});

test('한국어 여기까지/이만 패턴 → true', () => {
  assert.equal(isClosePattern('오늘 여기까지'), true);
  assert.equal(isClosePattern('오늘은 여기'), true);
  assert.equal(isClosePattern('여기까지'), true);
  assert.equal(isClosePattern('이만 마치자'), true);
  assert.equal(isClosePattern('이만 종료'), true);
});

test('한국어 작업/그만/슬슬/이만 패턴 → true', () => {
  assert.equal(isClosePattern('오늘 작업 마무리하자'), true);
  assert.equal(isClosePattern('작업 마무리 할게'), true);
  assert.equal(isClosePattern('작업 종료 하자'), true);
  assert.equal(isClosePattern('그만 하자'), true);
  assert.equal(isClosePattern('그만 할게'), true);
  assert.equal(isClosePattern('슬슬 마무리하자'), true);
  assert.equal(isClosePattern('오늘은 이만'), true);
});

test('영어 close 패턴 → true', () => {
  assert.equal(isClosePattern('wrap up'), true);
  assert.equal(isClosePattern('wrapping up'), true);
  assert.equal(isClosePattern('done for today'), true);
  assert.equal(isClosePattern("that's all for today"), true);
  assert.equal(isClosePattern('signing off'), true);
  assert.equal(isClosePattern('ending the session'), true);
  assert.equal(isClosePattern('close the session'), true);
});

test('일반 작업 문장 → false (false-positive 방지)', () => {
  assert.equal(isClosePattern('이 함수 마무리하자'), false);
  assert.equal(isClosePattern('버그 종료하자'), false);
  assert.equal(isClosePattern('코드 정리'), false);
  assert.equal(isClosePattern('다음 작업 시작하자'), false);
  assert.equal(isClosePattern('여기까지 구현하고 테스트해줘'), false); // Codex P2
  assert.equal(isClosePattern('작업 종료 조건을 바꿔줘'), false); // Codex P2
  assert.equal(isClosePattern('wrap up this PR'), false); // Codex P2
  assert.equal(isClosePattern('wrap up this feature'), false); // Codex P2
  assert.equal(isClosePattern(''), false);
  assert.equal(isClosePattern(null), false);
});

test('혼합 텍스트(트랜스크립트)에서도 패턴 감지', () => {
  const transcript = '이 PR 리뷰 마저 봐줘\n오늘은 여기까지 하자\n내일 다시 볼게';
  assert.equal(isClosePattern(transcript), true);
});

suite('isGateSkipped()');

test('HYPO_SKIP_GATE=1 → true', () => {
  const orig = process.env.HYPO_SKIP_GATE;
  process.env.HYPO_SKIP_GATE = '1';
  try {
    assert.equal(isGateSkipped(), true);
  } finally {
    orig === undefined ? delete process.env.HYPO_SKIP_GATE : (process.env.HYPO_SKIP_GATE = orig);
  }
});

test('no env var → false', () => {
  const o1 = process.env.HYPO_SKIP_GATE;
  delete process.env.HYPO_SKIP_GATE;
  try {
    assert.equal(isGateSkipped(), false);
  } finally {
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
  withCleanWiki((dir) => {
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

// ── replay-compact-guard-detects-slash-clear (fix #25, ADR 0022 Layer 2) ──

test('replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear' });
  const out = JSON.parse(r.stdout);
  assert.ok('additionalContext' in out, 'missing additionalContext field on /clear');
  assert.equal(out.continue, true);
  assert.ok(out.additionalContext.includes('WIKI_AUTOCLOSE'), 'missing WIKI_AUTOCLOSE marker');
  assert.ok(out.additionalContext.includes('/clear'), 'message must reference /clear');
});

test('/clear with trailing args → still detected', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear something' });
  const out = JSON.parse(r.stdout);
  assert.ok('additionalContext' in out);
  assert.ok(out.additionalContext.includes('/clear'));
});

test('HYPO_SKIP_GATE=1 + /clear → pass-through', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear' }, { HYPO_SKIP_GATE: '1' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

test('/clear with clean wiki → pass-through', () => {
  withCleanWiki((dir) => {
    const r = runHook('hypo-compact-guard.mjs', { prompt: '/clear' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(out.suppressOutput, true);
  });
});

test('/clearfoo (no word boundary) → pass-through (not /clear)', () => {
  const r = runHook('hypo-compact-guard.mjs', { prompt: '/clearfoo' });
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
});

suite('hypo-personal-check.mjs — close-intent enrichment (#20)');

test('close intent in transcript → block message includes close-intent note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-close-'));
  try {
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ message: { role: 'user', content: '세션 마무리하자' } }) + '\n',
    );
    const r = runHook('hypo-personal-check.mjs', { transcript_path: transcript });
    const out = JSON.parse(r.stdout);
    assert.ok(out.decision === 'block', 'should still block when session close is incomplete');
    assert.ok(
      out.reason.includes('Close intent'),
      'block reason should mention close intent detection',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no close intent → block message does NOT include close-intent note', () => {
  const r = runHook('hypo-personal-check.mjs', {});
  const out = JSON.parse(r.stdout);
  assert.ok(out.decision === 'block');
  assert.ok(
    !out.reason.includes('Close intent'),
    'block reason should not mention close intent when absent',
  );
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
  assert.ok(
    !('additionalContext' in out),
    'PreCompact must not use unsupported additionalContext field',
  );
});

test('clean wiki → suppressOutput:true', () => {
  withCleanWiki((dir) => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.suppressOutput, true);
    assert.equal(out.continue, true);
  });
});

suite('hypo-personal-check.mjs — strict session-close gate (#17)');

test('5 mandatory memory files fresh → suppressOutput:true', () => {
  withWiki(null, (dir) => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `expected pass, got: ${r.stdout}`);
    assert.equal(out.suppressOutput, true);
  });
});

test('project hot.md not updated today → block, reason names the file', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'hot.md'),
        '---\ntitle: hot\ntype: reference\nupdated: 2020-01-01\n---\n\n# Hot\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
      assert.ok(
        out.reason.includes('projects/test-project/hot.md'),
        `block reason should name the stale file: ${out.reason}`,
      );
    },
  );
});

test('session-log missing a today-dated heading → block', () => {
  withWiki(
    (dir, today) => {
      const ym = today.slice(0, 7);
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-log', `${ym}.md`),
        '---\ntitle: Session Log\ntype: session-log\nupdated: 2020-01-01\n---\n\n## [2020-01-01] old session\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
      assert.ok(
        out.reason.includes('session-log'),
        `block reason should name the session-log file: ${out.reason}`,
      );
    },
  );
});

test('open-questions.md absent/stale → still passes (conditional, not gated)', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'open-questions.md'),
        '---\ntitle: Open Questions\ntype: open-questions\nupdated: 2020-01-01\n---\n\n# Open Questions\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.continue,
        true,
        `open-questions is conditional — should not gate: ${r.stdout}`,
      );
    },
  );
});

test('log.md missing a today-dated session entry → block', () => {
  withWiki(
    (dir) => {
      // log.md exists but its session entry is stale-dated.
      writeFileSync(join(dir, 'log.md'), '## [2020-01-01] session | test-project — old\n');
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
      assert.ok(out.reason.includes('log.md'), `block reason should name log.md: ${out.reason}`);
    },
  );
});

test('log.md session entry for a different project → block', () => {
  withWiki(
    (dir, today) => {
      // A fresh session entry, but for some other project — must not satisfy
      // the gate for the resolved project (test-project).
      writeFileSync(join(dir, 'log.md'), `## [${today}] session | other-project — done\n`);
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, 'block', `cross-project log entry must not pass: ${r.stdout}`);
      assert.ok(out.reason.includes('log.md'), `block reason should name log.md: ${out.reason}`);
    },
  );
});

test('HYPO_SKIP_GATE=1 bypasses an incomplete session close', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
      );
    },
    (dir) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HYPO_SKIP_GATE: '1' });
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, true, `HYPO_SKIP_GATE should bypass: ${r.stdout}`);
      assert.ok(
        out.systemMessage.includes('memory files not updated'),
        `bypass message should still surface the incomplete files: ${out.systemMessage}`,
      );
    },
  );
});

// ── replay-personal-check-bypass-order (fix #26, ADR 0022 amendment 2026-05-13) ──
// Capacity bypass (wiki-context-critical.json ≥90%) was removed. Spec §7.5:
// the only bypass paths are HYPO_SKIP_GATE env / transcript user-role message.

test('replay-personal-check-bypass-order: wiki-context-critical.json does NOT bypass (fix #26 negative control)', () => {
  withWiki(
    (dir) => {
      // Make session-close stale so the gate would normally block.
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
      );
    },
    (dir) => {
      // Write the (now-defunct) capacity marker into the session-scoped tmp HOME,
      // and force the child hook to see THAT HOME — never the developer's real
      // ~/.claude/state/. This mirrors the test-hermeticity invariant established
      // by PR #30 (stage-2-#3): every hook test must scope HOME to SESSION_TMP_HOME.
      const stateDir = join(SESSION_TMP_HOME, '.claude', 'state');
      mkdirSync(stateDir, { recursive: true });
      const criticalPath = join(stateDir, 'wiki-context-critical.json');
      writeFileSync(criticalPath, JSON.stringify({ percent: 95 }));

      try {
        const r = runHook('hypo-personal-check.mjs', '', {
          HYPO_DIR: dir,
          HOME: SESSION_TMP_HOME,
        });
        const out = JSON.parse(r.stdout);

        // Pre-fix: would have continue:true + "gate auto-bypassed (context ≥90% critical)".
        // Post-fix: capacity flag is ignored → normal block path runs.
        assert.equal(
          out.decision,
          'block',
          `CRITICAL_FILE must NOT bypass — gate should still block: ${r.stdout}`,
        );
        assert.ok(
          !(out.systemMessage || '').includes('context ≥90% critical'),
          'capacity-bypass message must no longer appear',
        );

        // Negative control: the file MUST remain — fix #26 removed the unlink path too.
        // If it's gone, the old bypass code is still wired somewhere.
        assert.ok(
          existsSync(criticalPath),
          'wiki-context-critical.json should not be consumed (bypass path removed)',
        );
      } finally {
        if (existsSync(criticalPath)) {
          try {
            unlinkSync(criticalPath);
          } catch {}
        }
      }
    },
  );
});

suite('crystallize.mjs --check-session-close (#17)');

test('clean session close → exit 0 + ok:true', () => {
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.project, 'test-project');
  });
});

test('stale memory file → exit 1 + ok:false + names the file', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        out.stale.includes('projects/test-project/session-state.md'),
        `stale list should name the file: ${JSON.stringify(out.stale)}`,
      );
    },
  );
});

test('--check-session-close reads log.md from --hypo-dir, not the ambient wiki', () => {
  withWiki(
    (dir) => {
      // log.md whose last substantial op is an ingest, not a session close.
      writeFileSync(join(dir, 'log.md'), '## [2020-01-01] ingest | some-source\n');
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        out.stale.includes('log.md'),
        `log.md check must target --hypo-dir and flag it stale: ${r.stdout}`,
      );
    },
  );
});

test('missing log.md → exit 1 + log.md in missing list', () => {
  withWiki(
    (dir) => {
      rmSync(join(dir, 'log.md'));
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(out.missing.includes('log.md'), `missing list should name log.md: ${r.stdout}`);
    },
  );
});

// ── fix #38: --apply-session-close --payload <json> ───────────────────────────
// Idempotent payload-driven entrypoint that writes the 5 mandatory memory files
// (+ optional open-questions) and finishes with the strict gate. ADR 0029 Phase A.

suite('crystallize.mjs --apply-session-close (#38)');

// Helper: build a payload that re-asserts today's already-clean state on a wiki
// produced by buildCleanWikiTree(). Used to test idempotency without changing
// any fixture content.
function payloadForCleanWiki(dir, today) {
  const ym = today.slice(0, 7);
  return {
    project: 'test-project',
    date: today,
    sessionState: {
      content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
    },
    projectHot: { content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8') },
    rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
    sessionLog: { entry: `## [${today}] re-applied session\n` },
    log: { entry: `## [${today}] session | test-project — re-applied\n` },
  };
}

function runApply(dir, payload, { force = false } = {}) {
  // Fix #39 (option D): payload presence = explicit close intent → always runs
  // full apply. --force only matters for the no-payload probe path, so tests
  // that supply a payload do NOT need --force.
  const payloadPath = join(dir, '.payload.json');
  writeFileSync(payloadPath, JSON.stringify(payload));
  const flags = [
    `--hypo-dir=${dir}`,
    '--apply-session-close',
    `--payload=${payloadPath}`,
    '--json',
  ];
  if (force) flags.push('--force');
  return run('crystallize.mjs', flags);
}

test('clean-wiki payload → ok:true, new entries appended (apply dedup is exact-entry, not date-based)', () => {
  withWiki(null, (dir, today) => {
    // payloadForCleanWiki uses NEW entry text ("re-applied"), not the fixture's
    // existing "test session" entry. Apply must append the new entries — using
    // the freshness gate as a dedup signal would silently drop a legitimate
    // same-day second close (codex review of fix #38, Worker 1 finding 2).
    const r = runApply(dir, payloadForCleanWiki(dir, today));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    const appliedSlots = out.applied.join(' ');
    assert.ok(
      /sessionLog/.test(appliedSlots),
      `sessionLog should be appended (new entry): ${JSON.stringify(out)}`,
    );
    assert.ok(
      /log \(log\.md\)/.test(appliedSlots),
      `log.md should be appended (new entry): ${JSON.stringify(out)}`,
    );
  });
});

test('idempotent: re-running same payload produces no new bytes (file mtimes unchanged)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const r1 = runApply(dir, payload);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);
    const sl = join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`);
    const sizeBefore = readFileSync(sl, 'utf-8').length;
    const logBefore = readFileSync(join(dir, 'log.md'), 'utf-8').length;

    const r2 = runApply(dir, payload);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);
    const sizeAfter = readFileSync(sl, 'utf-8').length;
    const logAfter = readFileSync(join(dir, 'log.md'), 'utf-8').length;
    assert.equal(
      sizeAfter,
      sizeBefore,
      'session-log must not grow on re-apply (idempotent append)',
    );
    assert.equal(logAfter, logBefore, 'log.md must not grow on re-apply (idempotent append)');
  });
});

test('--hypo-dir isolation: overwrite fields land in the supplied dir', () => {
  // run() forces HYPO_DIR='' in env, so any write that lands inside `dir` is
  // proof --hypo-dir was honored. Use an overwrite field (sessionState) with a
  // unique sentinel — append fields are per-day deduped so they're a poor
  // isolation probe.
  withWiki(null, (dir, today) => {
    const sentinel = `<!-- isolation-probe-${Date.now()} -->`;
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## 다음 작업\n\n- next\n`,
    };
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `apply failed: ${r.stdout}\n${r.stderr}`);
    const onDisk = readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8');
    assert.ok(onDisk.includes(sentinel), 'sentinel must land in --hypo-dir, proving isolation');
  });
});

test('open-questions absent in payload → still passes (conditional, ungated)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.openQuestions; // explicitly omit
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, 'open-questions is conditional — apply must succeed without it');
    assert.ok(
      !out.applied.some((a) => /openQuestions/.test(a)),
      'openQuestions slot should not appear when omitted',
    );
  });
});

test('open-questions stale on disk → still passes (apply does not gate it)', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'open-questions.md'),
        '---\ntitle: Open Questions\ntype: open-questions\nupdated: 2020-01-01\n---\n\n# Open Questions\n',
      );
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      delete payload.openQuestions;
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `stale open-questions must not gate: ${r.stdout}`);
    },
  );
});

test('payload with stale `updated:` → exit 1, no auto-fix (advisor rule)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    // Inject a stale-dated session-state. Helper must NOT silently rewrite it.
    payload.sessionState = {
      content:
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
    };
    const r = runApply(dir, payload);
    assert.equal(
      r.status,
      1,
      `stale payload must fail final gate, got status=${r.status}\n${r.stdout}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      out.verification.stale.includes('projects/test-project/session-state.md'),
      `stale field should be flagged: ${JSON.stringify(out.verification)}`,
    );
  });
});

test('missing payload → exit 1 with clear error', () => {
  // With fix #39 (option D) the probe early-exit only fires on a clean wiki.
  // Mark hot.md stale so the gate fails → no early-exit → payload-required
  // error is reachable as the original test intends.
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'hot.md'),
        '---\ntitle: Hot\nupdated: 2020-01-01\n---\n# Hot\n\n## Active Projects\n\n' +
          '| Project | Last Session | Hot Cache |\n|---|---|---|\n' +
          '| test-project | 2020-01-01 | [[projects/test-project/hot]] |\n',
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        /payload is required/.test(out.error),
        `error should mention payload: ${out.error}`,
      );
    },
  );
});

test('same-day second close: distinct entries are both appended (W1 regression)', () => {
  // Sub-session within the same day must produce a second log entry, not be
  // silently deduped because today's heading already exists. This was the
  // major flaw codex review surfaced — apply dedup vs freshness gate.
  withWiki(null, (dir, today) => {
    const p1 = payloadForCleanWiki(dir, today);
    p1.sessionLog.entry = `## [${today}] morning sub-session\n\nbody A\n`;
    p1.log.entry = `## [${today}] session | test-project — morning\n`;
    const r1 = runApply(dir, p1);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);

    const p2 = payloadForCleanWiki(dir, today);
    p2.sessionLog.entry = `## [${today}] afternoon sub-session\n\nbody B\n`;
    p2.log.entry = `## [${today}] session | test-project — afternoon\n`;
    const r2 = runApply(dir, p2);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);

    const sl = readFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`),
      'utf-8',
    );
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.ok(sl.includes('morning sub-session'), `session-log should keep morning entry: ${sl}`);
    assert.ok(
      sl.includes('afternoon sub-session'),
      `session-log should append afternoon entry: ${sl}`,
    );
    assert.ok(log.includes('— morning'), `log.md should keep morning entry: ${log}`);
    assert.ok(log.includes('— afternoon'), `log.md should append afternoon entry: ${log}`);
  });
});

test('payload schema: missing mandatory field → exit 1 with named field (W1 fail-loud)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.projectHot; // drop a mandatory slot
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `missing mandatory must fail, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      /projectHot/.test(JSON.stringify(out.details || out.error)),
      `error must name the missing field: ${r.stdout}`,
    );
  });
});

test('payload schema: invalid date format → exit 1', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.date = '2026/05/15';
    const r = runApply(dir, payload);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.ok(
      /YYYY-MM-DD/.test(JSON.stringify(out.details || out.error)),
      `error must mention date format: ${r.stdout}`,
    );
  });
});

test('hasLogEntry: project "foo" must NOT match "foo-bar" (W2 boundary regression)', () => {
  // Pre-existing bug in sessionCloseFileStatus that the helper extraction
  // inherited. \b after "foo" matches before "-" (non-word char), so the
  // bounded regex must use (?=\\s|$) instead.
  withWiki(
    (dir, today) => {
      // Replace root hot.md to declare project "foo" as the active project,
      // and seed log.md with a session entry for "foo-bar" only.
      writeFileSync(
        join(dir, 'hot.md'),
        `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
          `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
          `| foo | ${today} | [[projects/foo/hot]] |\n`,
      );
      mkdirSync(join(dir, 'projects', 'foo', 'session-log'), { recursive: true });
      writeFileSync(
        join(dir, 'projects', 'foo', 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`,
      );
      writeFileSync(
        join(dir, 'projects', 'foo', 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`,
      );
      writeFileSync(
        join(dir, 'projects', 'foo', 'session-log', `${today.slice(0, 7)}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] foo session\n`,
      );
      // log.md only carries an entry for the LOOK-ALIKE project name.
      writeFileSync(
        join(dir, 'log.md'),
        `## [${today}] session | foo-bar — should not satisfy "foo" gate\n`,
      );
    },
    (dir) => {
      // Plain --check-session-close must reject "foo" because no foo entry exists.
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(
        r.status,
        1,
        `foo must not match foo-bar in log.md, got status=${r.status}\n${r.stdout}`,
      );
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.stale.includes('log.md') || out.missing.includes('log.md'),
        `log.md must be flagged stale/missing for foo: ${JSON.stringify(out)}`,
      );
    },
  );
});

// ── fix #39: probe early-exit (option D) ─────────────────────────────────────

test('probe (#39): no payload + gate ok → exit 0 with alreadyComplete', () => {
  // buildCleanWikiTree() leaves the wiki in a passing-gate state for `today`.
  // With no --payload, the helper runs as a cheap "already complete?" probe:
  // gate ok → exit 0 alreadyComplete:true, no payload required.
  withWiki(null, (dir, today) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    assert.equal(r.status, 0, `probe must succeed, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.alreadyComplete, true, `alreadyComplete flag must be set: ${r.stdout}`);
    assert.equal(out.date, today);
  });
});

test('apply (#39): payload supplied + gate ok → still full apply (W1-2 guard, no --force)', () => {
  // Option D core invariant: payload presence = explicit close intent.
  // Same-day second close with a NEW sessionLog entry must land WITHOUT
  // requiring --force. fix #38's exact-entry dedup is the only safety net,
  // and a probe-style short-circuit here would re-introduce W1-2 silent drop.
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog.entry = `## [${today}] 2nd close\n\nnew body\n`;
    payload.log.entry = `## [${today}] session | test-project — 2nd\n`;
    const r = runApply(dir, payload); // no --force
    assert.equal(r.status, 0, `payload apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.ok(!out.alreadyComplete, 'payload path must run full apply, not probe');
    const sl = readFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`),
      'utf-8',
    );
    assert.ok(sl.includes('2nd close'), `2nd-close entry must land on disk: ${sl}`);
  });
});

test('probe (#39): --force without --payload → payload-required (force does NOT bypass payload gate)', () => {
  // Lock the documented contract: --force only bypasses the alreadyComplete
  // probe shortcut. Payload is always required for apply work. (Codex W1
  // single-worker review — missing edge-case lock.)
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      '--force',
      '--json',
    ]);
    assert.equal(r.status, 1, `--force alone must error, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(/payload is required/.test(out.error), `must surface payload-required: ${out.error}`);
  });
});

test('probe (#39): gate NOT ok + no payload → falls through to payload-required (no skip)', () => {
  // Stale gate must NOT trigger the alreadyComplete probe — fallthrough
  // surfaces the "payload is required" error so the caller knows to supply
  // close content.
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: 2020-01-01\n---\n\n# Hot\n`,
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
      assert.equal(r.status, 1, `stale gate + no payload must error, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        /payload is required/.test(out.error),
        `must surface payload-required: ${out.error}`,
      );
    },
  );
});

test('payload via stdin (`--payload=-`) works the same as a file', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const r = spawnSync(
      process.execPath,
      [
        join(REPO, 'scripts', 'crystallize.mjs'),
        `--hypo-dir=${dir}`,
        '--apply-session-close',
        '--payload=-',
        '--json',
      ],
      { input: JSON.stringify(payload), encoding: 'utf-8' },
    );
    assert.equal(r.status, 0, `stdin apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
  });
});

// ── fix #40: helper lint preflight + post-apply check ───────────────────────

test('preflight (#40): pre-existing lint blocker → exit 1 stage=preflight-lint, payload NOT applied', () => {
  // Inject a malformed-frontmatter page (unclosed ---) under projects/. lint.mjs
  // raises an 'error' for that, which must abort apply before any byte is
  // written. Verify by checking session-state.md still carries the fixture's
  // original "- next" body (payload sentinel did not land).
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'broken.md'),
        '---\ntitle: broken\ntype: concept\n\nbody (frontmatter never closes)\n',
      );
    },
    (dir, today) => {
      const sentinel = `<!-- preflight-sentinel-${Date.now()} -->`;
      const payload = payloadForCleanWiki(dir, today);
      payload.sessionState = {
        content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## 다음 작업\n\n- next\n`,
      };
      const r = runApply(dir, payload);
      assert.equal(r.status, 1, `preflight must abort, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.stage, 'preflight-lint', `stage should be preflight-lint: ${r.stdout}`);
      const onDisk = readFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        'utf-8',
      );
      assert.ok(
        !onDisk.includes(sentinel),
        'preflight failure must NOT have written payload sentinel',
      );
    },
  );
});

test('post-apply (#40): payload introduces lint blocker → exit 1 stage=post-apply-lint, bytes written', () => {
  // Payload writes a session-state body that omits the required "## 다음 작업"
  // heading — lint raises an error, but freshness gate still passes (updated:
  // today). Apply DID write (sentinel present on disk), but final result is
  // ok:false with stage=post-apply-lint so caller distinguishes "wiki was
  // damaged" from "frontmatter stale".
  withWiki(null, (dir, today) => {
    const sentinel = `<!-- post-apply-sentinel-${Date.now()} -->`;
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## random heading without required label\n\n- next\n`,
    };
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `post-apply lint must fail, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'post-apply-lint', `stage should be post-apply-lint: ${r.stdout}`);
    assert.equal(out.verification.ok, true, 'freshness gate should still pass');
    const onDisk = readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8');
    assert.ok(onDisk.includes(sentinel), 'post-apply path must have written the payload sentinel');
  });
});

test('preflight (#40 codex-P2): post-apply-lint failure + fixed payload retry → succeeds (no dead-lock)', () => {
  // Codex review of fix #40 caught a dead-lock: a payload that fails
  // post-apply-lint leaves the broken file on disk, and the retry hits
  // preflight on that same broken file → "fix payload and retry" is
  // impossible. Preflight must filter errors in files this apply will
  // overwrite. Lock the documented recovery path.
  withWiki(null, (dir, today) => {
    // 1. Apply a bad payload (session-state missing required heading)
    const bad = payloadForCleanWiki(dir, today);
    bad.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## wrong heading\n\n- next\n`,
    };
    const r1 = runApply(dir, bad);
    assert.equal(r1.status, 1, `bad payload must fail: ${r1.stdout}`);
    assert.equal(JSON.parse(r1.stdout).stage, 'post-apply-lint');

    // 2. Retry with corrected payload — must succeed (was dead-locked before fix)
    const good = payloadForCleanWiki(dir, today);
    good.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- fixed\n`,
    };
    good.sessionLog.entry = `## [${today}] retry after fix\n`;
    good.log.entry = `## [${today}] session | test-project — retry\n`;
    const r2 = runApply(dir, good);
    assert.equal(
      r2.status,
      0,
      `retry must succeed (P2 dead-lock regression), got ${r2.status}\n${r2.stdout}`,
    );
    const out = JSON.parse(r2.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.lint.postApply.ok, true, 'post-apply lint should now pass');
  });
});

// ── upgrade.mjs smoke tests ───────────────────────────────────────────────────

suite('upgrade.mjs --json');

test('exits without crashing on non-existent wiki dir', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  assert.ok(r.status !== null, 'process did not exit cleanly');
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}\n${r.stderr}`);
});

test('--json output is valid JSON', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout not JSON: ${r.stdout}`);
});

test('JSON output has required top-level fields', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok('schema' in out, 'missing schema field');
  assert.ok('hooks' in out, 'missing hooks field');
  assert.ok('settings' in out, 'missing settings field');
  assert.ok('applied' in out, 'missing applied field');
});

test('schema object has installed/current/bump fields', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { schema } = JSON.parse(r.stdout);
  assert.ok('installed' in schema, 'schema missing installed');
  assert.ok('current' in schema, 'schema missing current');
  assert.ok('bump' in schema, 'schema missing bump');
});

test('hooks is an array of file/status objects', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { hooks } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(hooks), 'hooks should be an array');
  assert.ok(hooks.length > 0, 'expected at least one hook entry');
  assert.ok('file' in hooks[0], 'hook entry missing file');
  assert.ok('status' in hooks[0], 'hook entry missing status');
});

test('settings is an array of event/file/status objects', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { settings } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(settings), 'settings should be an array');
  assert.ok(settings.length > 0, 'expected at least one settings entry');
  assert.ok('event' in settings[0], 'settings entry missing event');
  assert.ok('file' in settings[0], 'settings entry missing file');
  assert.ok('status' in settings[0], 'settings entry missing status');
});

test('applied object has hooks and settings arrays', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { applied } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(applied.hooks), 'applied.hooks should be array');
  assert.ok(Array.isArray(applied.settings), 'applied.settings should be array');
});

test('schema.installed is null and bump is "unknown" for non-existent wiki', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { schema } = JSON.parse(r.stdout);
  // No SCHEMA.md → installed=null, version comparison impossible → bump='unknown'
  assert.equal(schema.installed, null, 'missing SCHEMA.md should yield installed=null');
  assert.equal(schema.bump, 'unknown', 'unresolvable versions should yield bump=unknown');
  // Exit code is 0 or 1 depending on installed hook/settings state (environment-dependent)
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}`);
});

test('--apply on tmp wiki exits 0 after applying available changes', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
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
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Simulate a pre-existing user .hypoignore from an older Hypomnema version
      // (no `.cache/` entry). Strip any matching line that may be present from
      // the freshly-scaffolded file.
      const hypoignorePath = join(hypoDir, '.hypoignore');
      const original = readFileSync(hypoignorePath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '.cache/')
        .join('\n');
      writeFileSync(hypoignorePath, original);

      // First --apply: should append .cache/
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first --apply failed: ${r1.stderr}`);
      const out1 = JSON.parse(r1.stdout);
      assert.deepEqual(
        out1.applied.hypoignore,
        ['.cache/'],
        'expected .cache/ to be appended on first run',
      );
      const afterFirst = readFileSync(hypoignorePath, 'utf-8');
      assert.ok(
        afterFirst.includes('.cache/'),
        '.cache/ missing from .hypoignore after first --apply',
      );
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
      assert.equal(
        out2.hypoignore.status,
        'up-to-date',
        'hypoignore status should be up-to-date on second run',
      );
      const afterSecond = readFileSync(hypoignorePath, 'utf-8');
      assert.equal(
        afterSecond,
        afterFirst,
        '.hypoignore content drifted across idempotent --apply',
      );
    });
  });
});

test('--apply generates migration report for major SCHEMA bump', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
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
      assert.ok(
        existsSync(out.migrationReport),
        `migration report file not found: ${out.migrationReport}`,
      );
      const content = readFileSync(out.migrationReport, 'utf-8');
      assert.ok(content.includes('0.9'), 'migration report should reference old version');
      assert.ok(content.includes('1.0'), 'migration report should reference new version');
    });
  });
});

// ── extensions companion sync (ADR 0024, fix #29 + #30) ──────────────────────

suite('extensions companion sync (upgrade.mjs, ADR 0024)');

function writeExt(hypoDir, type, name, content, manifest) {
  const dir = join(hypoDir, 'extensions', type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  if (manifest !== undefined) {
    const stem = name.replace(/\.[^.]+$/, '');
    writeFileSync(join(dir, `${stem}.manifest.json`), JSON.stringify(manifest, null, 2));
  }
}

// §8.12 (a) new extension → hard copy + manifest parse + settings.json entry +
// 3-way SHA record; §8.12 (b) re-run is idempotent (no diff, settings stable).
test('upgrade-extensions-hard-copy-and-manifest-register', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-mywatcher.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write|Edit',
        timeout: 10000,
      });

      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first --apply failed: ${r1.stderr}`);
      const out1 = JSON.parse(r1.stdout);

      // (a-1) hard copy of the hook AND its manifest into ~/.claude/hooks/
      const copyDir = join(home, '.claude', 'hooks');
      assert.ok(
        existsSync(join(copyDir, 'hypo-ext-mywatcher.mjs')),
        'extension hook not hard-copied to ~/.claude/hooks/',
      );
      assert.ok(
        existsSync(join(copyDir, 'hypo-ext-mywatcher.manifest.json')),
        'extension manifest not hard-copied alongside the hook',
      );

      // (a-2) settings.json registered the hook with a command WE constructed
      // (never sourced from the manifest), plus matcher + timeout from manifest.
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const groups = (settings.hooks?.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-mywatcher.mjs')),
      );
      assert.equal(groups.length, 1, 'exactly one PostToolUse entry expected for the extension');
      assert.equal(groups[0].matcher, 'Write|Edit', 'matcher from manifest not applied');
      assert.equal(
        groups[0].hooks[0].command,
        'node $HOME/.claude/hooks/hypo-ext-mywatcher.mjs',
        'command must be constructed by us, not sourced from manifest',
      );
      assert.equal(groups[0].hooks[0].timeout, 10000, 'timeout from manifest not applied');

      // (a-3) per-target SHA recorded WITHOUT clobbering the commands map.
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(pkg.commands && Object.keys(pkg.commands).length > 0, 'commands map was dropped');
      assert.ok(pkg.extensions?.claude, 'extensions.claude per-target map missing');
      assert.ok(
        pkg.extensions.claude['hooks/hypo-ext-mywatcher.mjs'],
        'hook SHA not recorded under extensions.claude',
      );
      assert.ok(
        pkg.extensions.claude['hooks/hypo-ext-mywatcher.manifest.json'],
        'manifest SHA not recorded under extensions.claude',
      );

      // (b) idempotency — second --apply syncs nothing and leaves settings stable.
      const settingsBefore = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const out2 = JSON.parse(r2.stdout);
      const synced2 = out2.applied.extensions.actions.filter((a) =>
        ['create', 'update', 'force-update'].includes(a.action),
      );
      assert.equal(synced2.length, 0, 'second --apply should sync nothing (idempotent)');
      assert.equal(
        out2.applied.extensions.settingsChanged,
        false,
        'second --apply must not rewrite settings.json',
      );
      assert.equal(out2.extensions.needsWork, false, 'no drift expected on second check');
      const settingsAfter = readFileSync(join(home, '.claude', 'settings.json'), 'utf-8');
      assert.equal(
        settingsAfter,
        settingsBefore,
        'settings.json drifted across idempotent --apply',
      );
    });
  });
});

// §8.12 (6) .hypoignore-matched files are excluded from discovery/sync.
test('extensions-respects-hypoignore', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // One synced extension and one that .hypoignore must exclude.
      writeExt(hypoDir, 'hooks', 'hypo-ext-keep.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      writeExt(hypoDir, 'hooks', 'hypo-ext-skipme.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      const hypoignorePath = join(hypoDir, '.hypoignore');
      writeFileSync(
        hypoignorePath,
        readFileSync(hypoignorePath, 'utf-8') + '\n# test exclusion\n*skipme*\n',
      );

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);

      const copyDir = join(home, '.claude', 'hooks');
      assert.ok(
        existsSync(join(copyDir, 'hypo-ext-keep.mjs')),
        'non-ignored extension should be synced',
      );
      assert.ok(
        !existsSync(join(copyDir, 'hypo-ext-skipme.mjs')),
        '.hypoignore-matched extension must NOT be synced',
      );
      assert.ok(
        !existsSync(join(copyDir, 'hypo-ext-skipme.manifest.json')),
        '.hypoignore-matched extension manifest must NOT be synced',
      );

      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions.claude['hooks/hypo-ext-keep.mjs'],
        'kept extension SHA should be recorded',
      );
      assert.ok(
        !pkg.extensions.claude['hooks/hypo-ext-skipme.mjs'],
        'ignored extension SHA must not be recorded',
      );
    });
  });
});

// D2 ordering: a malformed manifest (unknown event) must skip the extension
// entirely — no orphaned, unregistered hook copy left behind.
test('extensions: malformed manifest leaves no orphan hard-copy', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-bad.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'BogusEvent',
      });

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      assert.ok(
        !existsSync(join(home, '.claude', 'hooks', 'hypo-ext-bad.mjs')),
        'malformed-manifest extension must NOT be hard-copied (D2: validate before copy)',
      );
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const registered = JSON.stringify(settings.hooks || {}).includes('hypo-ext-bad');
      assert.ok(!registered, 'malformed-manifest extension must NOT be registered');
    });
  });
});

// Security #9: a hostile `command` field in the manifest must be ignored — the
// settings entry command is always constructed locally.
test('extensions: manifest command field cannot inject a command path', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-evil.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
        command: 'rm -rf /',
      });

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const group = (settings.hooks?.Stop || []).find((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-evil.mjs')),
      );
      assert.ok(group, 'extension should still be registered');
      assert.equal(
        group.hooks[0].command,
        'node $HOME/.claude/hooks/hypo-ext-evil.mjs',
        'command must be constructed locally, never sourced from the manifest',
      );
      assert.ok(
        !JSON.stringify(settings).includes('rm -rf'),
        'manifest command field must never reach settings.json',
      );
    });
  });
});

// HIGH (codex E2 review): a pre-existing unowned hook copy must NOT be wired up.
// We refuse to overwrite it, so we must also refuse to copy its manifest or
// register a settings entry that would activate a file we don't own.
test('extensions: conflict on main file blocks manifest copy + registration', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // A foreign, unowned file already sits where our extension would land.
      const claudeHooks = join(home, '.claude', 'hooks');
      mkdirSync(claudeHooks, { recursive: true });
      writeFileSync(join(claudeHooks, 'hypo-ext-conflict.mjs'), '// not ours\n');

      writeExt(hypoDir, 'hooks', 'hypo-ext-conflict.mjs', '#!/usr/bin/env node\n// ours\n', {
        type: 'hook',
        event: 'PostToolUse',
      });

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      // E3 (#31): a hard conflict blocks install with exit 1 even under --apply.
      assert.equal(r.status, 1, `conflict must block with exit 1: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.extensions.conflicts.some((c) => c.file === 'hooks/hypo-ext-conflict.mjs'),
        'conflict must be reported in extensions.conflicts',
      );

      // Foreign file left untouched.
      assert.equal(
        readFileSync(join(claudeHooks, 'hypo-ext-conflict.mjs'), 'utf-8'),
        '// not ours\n',
        'foreign file must not be overwritten',
      );
      // Manifest NOT copied (we do not own the main file).
      assert.ok(
        !existsSync(join(claudeHooks, 'hypo-ext-conflict.manifest.json')),
        'manifest must not be copied for an unowned/conflicted main file',
      );
      // NOT registered in settings.json.
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      assert.ok(
        !JSON.stringify(settings.hooks || {}).includes('hypo-ext-conflict.mjs'),
        'conflicted extension must NOT be registered in settings.json',
      );
    });
  });
});

// fix #31: the init.mjs conflict path must also block (exit 1) and report the
// recovery — not throw. (Guards against the errors-bucket name typo.)
test('extensions: init blocks on a hard conflict (exit 1, no throw)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `first init failed: ${initR.stderr}`);

      // A foreign, unowned file occupies the target; author the extension.
      const claudeHooks = join(home, '.claude', 'hooks');
      writeFileSync(join(claudeHooks, 'hypo-ext-foreign.mjs'), '// not ours\n');
      writeExt(hypoDir, 'hooks', 'hypo-ext-foreign.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
      });

      const r = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 1, 'init must exit 1 on a hard extension conflict');
      const combined = `${r.stdout}\n${r.stderr}`;
      assert.ok(
        combined.includes('existing file conflicts'),
        'init must surface the conflict recovery message',
      );
      assert.equal(
        readFileSync(join(claudeHooks, 'hypo-ext-foreign.mjs'), 'utf-8'),
        '// not ours\n',
        'foreign file must remain untouched',
      );
    });
  });
});

// §8.12 (c) — fix #31: a user-edited owned copy is DRIFT (warn + check-mode exit 1,
// not a hard --apply block); --force-extensions backs it up (.bak) and overwrites.
// A foreign symlink at the target is a conflict that --force-extensions never
// follows (it stays exit 1).
test('extensions-conflict-detected-blocks-without-force', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const claudeHooks = join(home, '.claude', 'hooks');
      const installed = join(claudeHooks, 'hypo-ext-drift.mjs');

      // Author + install an extension we own.
      writeExt(hypoDir, 'hooks', 'hypo-ext-drift.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(r1.status, 0, `initial sync failed: ${r1.stderr}`);
      assert.ok(existsSync(installed), 'extension should be installed');

      // The user edits the installed copy → drift (we own it, recorded SHA ≠ disk).
      writeFileSync(installed, '#!/usr/bin/env node\n// hand-edited\n');

      // (a) --check (no apply) → exit 1, reported as drift, file untouched.
      const rc = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      assert.equal(rc.status, 1, 'drift must fail check mode (exit 1)');
      const checkOut = JSON.parse(rc.stdout);
      assert.ok(
        checkOut.extensions.drifts.some((d) => d.file === 'hooks/hypo-ext-drift.mjs'),
        'drift must be reported in extensions.drifts',
      );
      assert.equal(checkOut.extensions.conflicts.length, 0, 'drift is not a hard conflict');
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// hand-edited\n',
        'check mode must not overwrite a drifted file',
      );

      // Non-JSON summary must stay consistent with the exit code: drift is pending
      // work, so the summary must NOT claim "up to date" while exiting 1.
      const rcText = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.equal(rcText.status, 1, 'drift must fail check mode (non-JSON)');
      assert.ok(
        !rcText.stdout.includes('Hypomnema is up to date'),
        'summary must not say "up to date" when drift is pending',
      );
      assert.ok(
        rcText.stdout.includes('drift detected'),
        'summary must surface the drift recovery message',
      );

      // (b) --apply WITHOUT force → drift is advisory, NOT a hard block (exit 0),
      // and the user's edit is preserved (mirrors slash-command drift semantics).
      const ra = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(ra.status, 0, `drift must not hard-block --apply: ${ra.stderr}`);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// hand-edited\n',
        'apply without --force-extensions must not overwrite a drifted file',
      );

      // (c) --apply --force-extensions → backup (.bak) + overwrite from source.
      const rf = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--force-extensions'],
        home,
      );
      assert.equal(rf.status, 0, `force apply failed: ${rf.stderr}`);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// v1\n',
        '--force-extensions must overwrite with the source content',
      );
      assert.ok(existsSync(`${installed}.bak`), '--force-extensions must back up the prior file');
      assert.equal(
        readFileSync(`${installed}.bak`, 'utf-8'),
        '#!/usr/bin/env node\n// hand-edited\n',
        'backup must hold the user-edited content',
      );

      // (d) a symlink at the target is a conflict --force-extensions never follows.
      const decoy = join(dir, 'decoy.mjs');
      writeFileSync(decoy, '// decoy\n');
      writeExt(hypoDir, 'hooks', 'hypo-ext-link.mjs', '#!/usr/bin/env node\n// linked\n', {
        type: 'hook',
        event: 'Stop',
      });
      symlinkSync(decoy, join(claudeHooks, 'hypo-ext-link.mjs'));
      const rl = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--force-extensions'],
        home,
      );
      assert.equal(rl.status, 1, 'a symlink target must stay a conflict even under --force');
      const linkOut = JSON.parse(rl.stdout);
      assert.ok(
        linkOut.extensions.conflicts.some(
          (c) => c.file === 'hooks/hypo-ext-link.mjs' && c.action === 'skip-non-regular',
        ),
        'symlink must be reported as a non-regular conflict',
      );
      assert.equal(readFileSync(decoy, 'utf-8'), '// decoy\n', 'symlink target must be untouched');
    });
  });
});

// MEDIUM (codex E2 review, §8.12 b): a manifest matcher/timeout change must be
// reflected in the existing settings entry; an event change must migrate it
// (no orphaned entry left in the old event).
test('extensions: manifest change re-registers settings entry', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const manifestPath = join(hypoDir, 'extensions', 'hooks', 'hypo-ext-edit.manifest.json');
      writeExt(hypoDir, 'hooks', 'hypo-ext-edit.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 5000,
      });
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);

      // Change matcher + timeout → expect the existing entry updated in place.
      writeFileSync(
        manifestPath,
        JSON.stringify({ type: 'hook', event: 'PostToolUse', matcher: 'Edit', timeout: 9000 }),
      );
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const s2 = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const post = (s2.hooks.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-edit.mjs')),
      );
      assert.equal(post.length, 1, 'exactly one entry expected after matcher change');
      assert.equal(post[0].matcher, 'Edit', 'matcher should be updated');
      assert.equal(post[0].hooks[0].timeout, 9000, 'timeout should be updated');

      // Change event → migrate (old event entry removed, new event entry added).
      writeFileSync(manifestPath, JSON.stringify({ type: 'hook', event: 'Stop' }));
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      const s3 = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      const stillPost = (s3.hooks.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-edit.mjs')),
      );
      const nowStop = (s3.hooks.Stop || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-edit.mjs')),
      );
      assert.equal(stillPost.length, 0, 'old-event entry must be removed on event migration');
      assert.equal(nowStop.length, 1, 'entry must move to the new event');
    });
  });
});

// MEDIUM (codex E2 review): a .hypoignore-matched manifest must be excluded too
// — the hook then has no manifest (warns, hard-copy proceeds, not registered).
test('extensions: .hypoignore-matched manifest is not copied or recorded', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-partial.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });
      const hypoignorePath = join(hypoDir, '.hypoignore');
      writeFileSync(hypoignorePath, readFileSync(hypoignorePath, 'utf-8') + '\n*.manifest.json\n');

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      const claudeHooks = join(home, '.claude', 'hooks');
      assert.ok(existsSync(join(claudeHooks, 'hypo-ext-partial.mjs')), 'hook should still copy');
      assert.ok(
        !existsSync(join(claudeHooks, 'hypo-ext-partial.manifest.json')),
        'ignored manifest must not be copied',
      );
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        !pkg.extensions.claude['hooks/hypo-ext-partial.manifest.json'],
        'ignored manifest SHA must not be recorded',
      );
      const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8'));
      assert.ok(
        !JSON.stringify(settings.hooks || {}).includes('hypo-ext-partial.mjs'),
        'without a manifest the hook must not auto-register',
      );
    });
  });
});

// §8.12 (5) --codex mirrors the extensions sync into ~/.codex (hooks + commands
// only; skills/agents skipped with a notice). Covers BOTH entry points (upgrade
// here, init below) — the E3 review showed a shared sync fn can still leak
// per-entry-point wiring bugs.
test('extensions-codex-sync', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // A hook (registrable), a command, and a skill (Codex-unsupported → skip).
      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxwatch.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'PostToolUse',
        matcher: 'Write',
        timeout: 8000,
      });
      writeExt(hypoDir, 'commands', 'hypo-ext-cdxcmd.md', '# codex command\n');
      writeExt(hypoDir, 'skills', 'hypo-ext-cdxskill.md', '# claude-only skill\n');

      // (sanity) a plain --apply must NEVER touch ~/.codex.
      const rNoCdx = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(rNoCdx.status, 0, `claude-only apply failed: ${rNoCdx.stderr}`);
      assert.ok(
        !existsSync(join(home, '.codex', 'hooks', 'hypo-ext-cdxwatch.mjs')),
        'without --codex nothing must be written into ~/.codex',
      );

      // ── entry point 1: upgrade --codex --apply ──
      const rUp = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--codex'],
        home,
      );
      assert.equal(rUp.status, 0, `upgrade --codex failed: ${rUp.stderr}`);
      const up = JSON.parse(rUp.stdout);

      const cdxHooks = join(home, '.codex', 'hooks');
      const cdxCmds = join(home, '.codex', 'commands');
      assert.ok(
        existsSync(join(cdxHooks, 'hypo-ext-cdxwatch.mjs')),
        'hook not hard-copied to ~/.codex/hooks',
      );
      assert.ok(
        existsSync(join(cdxHooks, 'hypo-ext-cdxwatch.manifest.json')),
        'manifest not hard-copied to ~/.codex/hooks',
      );
      assert.ok(
        existsSync(join(cdxCmds, 'hypo-ext-cdxcmd.md')),
        'command not hard-copied to ~/.codex/commands',
      );
      assert.ok(
        !existsSync(join(home, '.codex', 'skills', 'hypo-ext-cdxskill.md')),
        'skill extension must be skipped for the codex target',
      );

      // ~/.codex/settings.json entry uses a command WE constructed, pointing at ~/.codex.
      const cdxSettings = JSON.parse(readFileSync(join(home, '.codex', 'settings.json'), 'utf-8'));
      const grp = (cdxSettings.hooks?.PostToolUse || []).filter((g) =>
        (g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-cdxwatch.mjs')),
      );
      assert.equal(grp.length, 1, 'exactly one codex PostToolUse entry expected');
      assert.equal(
        grp[0].hooks[0].command,
        'node $HOME/.codex/hooks/hypo-ext-cdxwatch.mjs',
        'codex command must point at ~/.codex and be constructed by us',
      );
      assert.equal(grp[0].matcher, 'Write', 'codex matcher from manifest not applied');

      // per-target SHA: BOTH claude and codex maps must survive (regression guard).
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions?.claude?.['hooks/hypo-ext-cdxwatch.mjs'],
        'claude per-target SHA was dropped by the codex sync',
      );
      assert.ok(
        pkg.extensions?.codex?.['hooks/hypo-ext-cdxwatch.mjs'],
        'codex hook SHA not recorded',
      );
      assert.ok(
        pkg.extensions.codex['commands/hypo-ext-cdxcmd.md'],
        'codex command SHA not recorded',
      );
      assert.ok(
        !pkg.extensions.codex['skills/hypo-ext-cdxskill.md'],
        'skipped skill must not be recorded under codex',
      );

      // skip notice surfaced on the codex result — and NOT on the claude result.
      assert.ok(
        up.extensionsCodex.warnings.some((w) => /skipped for Codex/i.test(w)),
        'a skill/agent skip notice was expected for the codex target',
      );
      assert.ok(
        !up.extensions.warnings.some((w) => /skipped for Codex/i.test(w)),
        'the claude target must not emit a codex skip notice',
      );

      // idempotency: a second --codex --apply syncs nothing new.
      const rUp2 = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--codex'],
        home,
      );
      assert.equal(rUp2.status, 0, `second --codex apply failed: ${rUp2.stderr}`);
      const up2 = JSON.parse(rUp2.stdout);
      const synced2 = up2.applied.extensionsCodex.actions.filter((a) =>
        ['create', 'update', 'force-update'].includes(a.action),
      );
      assert.equal(synced2.length, 0, 'second --codex apply should sync nothing (idempotent)');
    });
  });
});

// §8.12 (5) the OTHER entry point: init --codex must run the same codex sync
// (E3 lesson — wiring bugs surface per entry point even with a shared fn).
test('extensions-codex-sync: init --codex entry point', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-icdx.mjs', '#!/usr/bin/env node\n', {
        type: 'hook',
        event: 'Stop',
      });

      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-git-init', '--codex'],
        home,
      );
      assert.equal(r.status, 0, `init --codex failed: ${r.stderr}`);
      assert.ok(
        existsSync(join(home, '.codex', 'hooks', 'hypo-ext-icdx.mjs')),
        'init --codex must hard-copy the extension into ~/.codex/hooks',
      );
      const cdxSettings = JSON.parse(readFileSync(join(home, '.codex', 'settings.json'), 'utf-8'));
      assert.ok(
        JSON.stringify(cdxSettings.hooks || {}).includes('hypo-ext-icdx.mjs'),
        'init --codex must register the extension in ~/.codex/settings.json',
      );
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.extensions?.codex?.['hooks/hypo-ext-icdx.mjs'],
        'init --codex must record the codex per-target SHA',
      );
      // init writes the claude target (step 4b) before the codex target (6b) — the
      // codex write must not clobber the claude per-target SHA map.
      assert.ok(
        pkg.extensions?.claude?.['hooks/hypo-ext-icdx.mjs'],
        'init --codex must preserve the claude per-target SHA',
      );
    });
  });
});

// §8.12 (5) + (c): a codex hard conflict (foreign file at the ~/.codex target)
// must block even under --apply (exit 1), leave the file untouched, and never
// report "up to date" — the message/exit consistency the E3 review enforced.
test('extensions-codex-sync: hard conflict blocks even under --apply', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxconf.mjs', '#!/usr/bin/env node\n// source\n', {
        type: 'hook',
        event: 'Stop',
      });
      // Pre-existing UNOWNED file occupying the codex target → hard conflict.
      const cdxHooks = join(home, '.codex', 'hooks');
      mkdirSync(cdxHooks, { recursive: true });
      const target = join(cdxHooks, 'hypo-ext-cdxconf.mjs');
      writeFileSync(target, '// foreign — not ours\n');

      const r = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--json', '--apply', '--codex'],
        home,
      );
      assert.equal(r.status, 1, 'a codex hard conflict must exit 1 even under --apply');
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.extensionsCodex.conflicts.some((c) => c.file === 'hooks/hypo-ext-cdxconf.mjs'),
        'codex conflict must be reported in extensionsCodex.conflicts',
      );
      assert.equal(
        readFileSync(target, 'utf-8'),
        '// foreign — not ours\n',
        'a conflicting codex file must be left untouched',
      );

      // The human-readable summary must not contradict the exit code (E3 review).
      const rh = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(rh.status, 1, 'non-JSON codex conflict must also exit 1');
      // The verdict line must not claim everything is settled (E3 message/exit
      // consistency) — per-check "up to date" lines are fine, only the Result is.
      assert.ok(
        !/Result: Hypomnema is up to date/.test(rh.stdout),
        'the summary verdict must not read "up to date" while a codex conflict exists',
      );
    });
  });
});

// §8.12 (5) + 검증 4: --force-extensions resolves a drifted codex copy (backup +
// overwrite). Both entry points forward the flag; this guards the codex wiring.
test('extensions-codex-sync: --force-extensions overwrites a drifted codex copy', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxforce.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'Stop',
      });
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(r1.status, 0, `initial codex sync failed: ${r1.stderr}`);
      const installed = join(home, '.codex', 'hooks', 'hypo-ext-cdxforce.mjs');

      // User edits the installed codex copy (drift) and the source advances to v2.
      writeFileSync(installed, '#!/usr/bin/env node\n// user edit\n');
      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxforce.mjs', '#!/usr/bin/env node\n// v2\n', {
        type: 'hook',
        event: 'Stop',
      });

      // Plain --apply must NOT overwrite a drifted (owned-but-edited) codex copy.
      runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// user edit\n',
        'apply without --force must not overwrite a drifted codex file',
      );

      // --force-extensions backs up (.bak) and overwrites from source.
      const r3 = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex', '--force-extensions'],
        home,
      );
      assert.equal(r3.status, 0, `--force-extensions codex apply failed: ${r3.stderr}`);
      assert.equal(
        readFileSync(installed, 'utf-8'),
        '#!/usr/bin/env node\n// v2\n',
        '--force-extensions must overwrite the codex copy with the source',
      );
      assert.ok(
        existsSync(`${installed}.bak`),
        '--force-extensions must back up the prior codex copy',
      );
    });
  });
});

// §8.12 (7) doctor extensions integrity (fix #33, ADR 0024 E5). Detects
// (a) hard-copy SHA mismatch, (b) settings-entry mismatch + orphan, (c) manifest
// missing (warn) / malformed (fail). Malformed = FAIL is what makes doctor's
// `fails=0` ship gate (§5.1.3) actually cover §8.12-7(c).
test('doctor-extensions-integrity', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const doctorLabel = 'Extensions integrity';
      const findExt = (out) => out.find((c) => c.label === doctorLabel);

      // Author + sync a healthy hook extension.
      writeExt(hypoDir, 'hooks', 'hypo-ext-watch.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'PostToolUse',
      });
      const sync = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(sync.status, 0, `sync failed: ${sync.stderr}`);

      // (clean) all consistent → pass.
      let r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      let ext = findExt(JSON.parse(r.stdout));
      assert.ok(ext, 'extensions integrity check not found');
      assert.equal(ext.status, 'pass', `expected pass when consistent: ${ext.detail}`);

      // (a) user edits the installed copy → recorded SHA ≠ on-disk → warn (not fail).
      const installed = join(home, '.claude', 'hooks', 'hypo-ext-watch.mjs');
      writeFileSync(installed, '#!/usr/bin/env node\n// hand-edited\n');
      r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      ext = findExt(JSON.parse(r.stdout));
      assert.equal(ext.status, 'warn', `SHA drift must warn: ${ext.detail}`);
      assert.ok(/drift/i.test(ext.detail), `drift detail expected: ${ext.detail}`);
      assert.notEqual(r.status, 1, 'a recoverable drift must not fail the doctor gate');

      // (b) restore the copy, then strip the settings entry → expected-missing → warn.
      const resync = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--force-extensions'],
        home,
      );
      assert.equal(resync.status, 0, `resync failed: ${resync.stderr}`);
      const settingsPath = join(home, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      settings.hooks.PostToolUse = (settings.hooks.PostToolUse || []).filter(
        (g) => !(g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-watch.mjs')),
      );
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      ext = findExt(JSON.parse(r.stdout));
      assert.equal(ext.status, 'warn', `missing settings entry must warn: ${ext.detail}`);
      assert.ok(/not registered/i.test(ext.detail), `registration detail expected: ${ext.detail}`);

      // (b-orphan) settings entry whose source extension was removed → warn.
      // E4 excludes hypo-ext-* from the core stale checker, so checkExtensions is
      // the only place this is caught.
      withTmpHome((home2) => {
        const hypoDir2 = join(dir, 'wiki2');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir2}`, '--no-git-init'], home2);
        const s2 = {
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: 'node $HOME/.claude/hooks/hypo-ext-gone.mjs' }],
              },
            ],
          },
        };
        writeFileSync(join(home2, '.claude', 'settings.json'), JSON.stringify(s2, null, 2));
        const ro = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir2}`, '--json'], home2);
        const eo = findExt(JSON.parse(ro.stdout));
        assert.equal(eo.status, 'warn', `orphan entry must warn: ${eo.detail}`);
        assert.ok(/orphan/i.test(eo.detail), `orphan detail expected: ${eo.detail}`);
      });

      // (c-warn) hook with no manifest → warn ("will not auto-register").
      withTmpHome((home3) => {
        const hypoDir3 = join(dir, 'wiki3');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir3}`, '--no-git-init'], home3);
        writeExt(hypoDir3, 'hooks', 'hypo-ext-nomani.mjs', '#!/usr/bin/env node\n'); // no manifest
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir3}`, '--apply'], home3);
        const rm = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir3}`, '--json'], home3);
        const em = findExt(JSON.parse(rm.stdout));
        assert.equal(em.status, 'warn', `missing manifest must warn: ${em.detail}`);
        assert.ok(/missing/i.test(em.detail), `missing-manifest detail expected: ${em.detail}`);
        assert.notEqual(rm.status, 1, 'a missing manifest must not fail the gate');
      });

      // (c-fail) malformed manifest → FAIL + non-zero exit (ship gate covers §8.12-7c).
      withTmpHome((home4) => {
        const hypoDir4 = join(dir, 'wiki4');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir4}`, '--no-git-init'], home4);
        const extHooks = join(hypoDir4, 'extensions', 'hooks');
        mkdirSync(extHooks, { recursive: true });
        writeFileSync(join(extHooks, 'hypo-ext-bad.mjs'), '#!/usr/bin/env node\n');
        // Unknown event → parseManifest !ok → malformed → fail.
        writeFileSync(
          join(extHooks, 'hypo-ext-bad.manifest.json'),
          JSON.stringify({ type: 'hook', event: 'NotARealEvent' }),
        );
        const rf = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir4}`, '--json'], home4);
        const ef = findExt(JSON.parse(rf.stdout));
        assert.equal(ef.status, 'fail', `malformed manifest must fail: ${ef.detail}`);
        assert.equal(rf.status, 1, 'malformed manifest must fail the doctor gate (exit 1)');
      });

      // (b-shape) command registered but matcher/timeout differs from the manifest.
      // upgrade --apply silently self-heals this (extensions.mjs:544), so doctor is
      // the only surface that reports it (the mismatch E3 deferred to E5).
      withTmpHome((home5) => {
        const hypoDir5 = join(dir, 'wiki5');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir5}`, '--no-git-init'], home5);
        writeExt(hypoDir5, 'hooks', 'hypo-ext-shape.mjs', '#!/usr/bin/env node\n', {
          type: 'hook',
          event: 'PostToolUse',
          matcher: 'Write',
          timeout: 5000,
        });
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir5}`, '--apply'], home5);
        // User hand-edits the matcher in settings.json (recorded SHA path untouched).
        const sp = join(home5, '.claude', 'settings.json');
        const s = JSON.parse(readFileSync(sp, 'utf-8'));
        for (const g of s.hooks.PostToolUse) {
          if ((g.hooks || []).some((h) => (h.command || '').includes('hypo-ext-shape.mjs'))) {
            g.matcher = 'Edit'; // diverge from manifest's "Write"
          }
        }
        writeFileSync(sp, JSON.stringify(s, null, 2));
        const r5 = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir5}`, '--json'], home5);
        const e5 = findExt(JSON.parse(r5.stdout));
        assert.equal(e5.status, 'warn', `settings shape drift must warn: ${e5.detail}`);
        assert.ok(/differs from manifest/i.test(e5.detail), `shape-drift detail: ${e5.detail}`);
      });

      // (b-missing-file) codex 2-worker review: a synced hook whose settings.json was
      // deleted (or has no hooks object) must still warn "not registered" — a matching
      // SHA must not mask the absent registration (§8.12-7(b)). Regression for the
      // pre-fix guard that skipped the entry check unless settings.hooks existed.
      withTmpHome((home6) => {
        const hypoDir6 = join(dir, 'wiki6');
        runWithHome('init.mjs', [`--hypo-dir=${hypoDir6}`, '--no-git-init'], home6);
        writeExt(hypoDir6, 'hooks', 'hypo-ext-noreg.mjs', '#!/usr/bin/env node\n', {
          type: 'hook',
          event: 'Stop',
        });
        runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir6}`, '--apply'], home6);
        // Delete settings.json — the installed copy + recorded SHA still match.
        rmSync(join(home6, '.claude', 'settings.json'), { force: true });
        const r6 = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir6}`, '--json'], home6);
        const e6 = findExt(JSON.parse(r6.stdout));
        assert.equal(e6.status, 'warn', `missing settings.json must still warn: ${e6.detail}`);
        assert.ok(
          /not registered/i.test(e6.detail),
          `not-registered detail expected: ${e6.detail}`,
        );
      });
    });
  });
});

// §8.12 (7) codex target: doctor --codex runs the same integrity check against
// ~/.codex, and skills/agents recorded under claude do not false-flag there.
test('doctor-extensions-integrity: --codex target', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      writeExt(hypoDir, 'hooks', 'hypo-ext-cdxdoc.mjs', '#!/usr/bin/env node\n// v1\n', {
        type: 'hook',
        event: 'Stop',
      });
      const sync = runWithHome(
        'upgrade.mjs',
        [`--hypo-dir=${hypoDir}`, '--apply', '--codex'],
        home,
      );
      assert.equal(sync.status, 0, `codex sync failed: ${sync.stderr}`);

      // Clean → codex check passes.
      let r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--codex', '--json'], home);
      let ext = JSON.parse(r.stdout).find((c) => c.label === 'Codex extensions integrity');
      assert.ok(ext, 'codex extensions integrity check not found');
      assert.equal(ext.status, 'pass', `expected codex pass: ${ext.detail}`);

      // Edit the installed codex copy → drift warn on the codex target.
      writeFileSync(join(home, '.codex', 'hooks', 'hypo-ext-cdxdoc.mjs'), '// edited\n');
      r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--codex', '--json'], home);
      ext = JSON.parse(r.stdout).find((c) => c.label === 'Codex extensions integrity');
      assert.equal(ext.status, 'warn', `codex drift must warn: ${ext.detail}`);
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
  assert.ok(
    !fixed.slice(fixed.indexOf('\n---\n') + 5).includes('updated:'),
    'updated inserted outside frontmatter',
  );
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
  assert.ok(
    updatedPos > 0 && updatedPos < fmEnd,
    `updated at ${updatedPos}, fm closes at ${fmEnd}`,
  );
});

test('--fix skips file with no frontmatter', () => {
  const { fixed } = lintFix('# No frontmatter here\nbody\n');
  assert.ok(!fixed.includes('updated:'), 'should not insert updated into file without frontmatter');
});

test('--json output omits internal path field', () => {
  const { r } = lintFix('---\ntitle: T\ntype: concept\n---\nbody\n');
  const out = JSON.parse(r.stdout);
  const allIssues = [...(out.errors || []), ...(out.warns || [])];
  assert.ok(
    allIssues.every((i) => !('path' in i)),
    'path field leaked into JSON output',
  );
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
  const { r, out } = lintSessionState(
    '---\ntitle: Session State\ntype: session-state\nupdated: 2026-05-07\n---\n# Session State\n\n## 다음 작업\n\n- Continue\n',
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.deepEqual(out.errors, []);
});

test('errors when project session-state lacks a next heading', () => {
  const { r, out } = lintSessionState(
    '---\ntitle: Session State\ntype: session-state\nupdated: 2026-05-07\n---\n# Session State\n\n## Background\n\n- Missing next section\n',
  );
  assert.equal(r.status, 1, `expected lint error\nstdout: ${r.stdout}`);
  assert.ok(
    out.errors.some(
      (i) =>
        i.file === 'projects/proj/session-state.md' &&
        i.message.includes('Missing required session-state heading'),
    ),
    `missing session-state heading error: ${r.stdout}`,
  );
});

// ── lint.mjs type-conditional + tag vocab tests (fix #15 + #36) ─────────────

suite('lint.mjs type-conditional required fields');

const VOCAB_SCHEMA =
  '---\ntitle: SCHEMA\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n`wiki` `project` `prd` `adr` `concept` `learning` `feedback`\n\n## 5. Next\n';

function lintWithSchema(pageRel, content, schemaContent = VOCAB_SCHEMA) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-cond-'));
  writeFileSync(join(dir, 'SCHEMA.md'), schemaContent);
  const fullPath = join(dir, pageRel);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(dir, { recursive: true, force: true });
  return { r, out };
}

test('prd missing started → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/prd.md',
    '---\ntitle: T\ntype: prd\nstatus: active\nupdated: 2026-05-18\ntags: [prd]\n---\nbody\n',
  );
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Missing required field for type "prd": started')),
    `started error missing: ${r.stdout}`,
  );
});

test('adr missing source → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/decisions/0001-x.md',
    '---\ntitle: T\ntype: adr\nstatus: accepted\ndate: 2026-05-18\nupdated: 2026-05-18\ntags: [adr]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Missing required field for type "adr": source')),
  );
});

test('project-index missing working_dir → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "project-index": working_dir'),
    ),
  );
});

test('postmortem missing outcome → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/postmortems/2026-05-18-x.md',
    '---\ntitle: T\ntype: postmortem\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "postmortem": outcome'),
    ),
  );
});

test('prd with invalid status enum → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/prd.md',
    '---\ntitle: T\ntype: prd\nstatus: in-progress\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [prd]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(out.errors.some((e) => e.message.includes('Invalid value for status on type "prd"')));
});

test('all type-conditional fields present → green', () => {
  const { r } = lintWithSchema(
    'projects/p/prd.md',
    '---\ntitle: T\ntype: prd\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [prd]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `expected green, got ${r.status}`);
});

test('weekly-journal under journal/weekly missing week → error (scanDirs covers journal/)', () => {
  const { r, out } = lintWithSchema(
    'journal/weekly/2026-W19.md',
    '---\ntitle: T\ntype: weekly-journal\nupdated: 2026-05-18\ntags: [wiki]\n---\nbody\n',
  );
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "weekly-journal": week'),
    ),
    `weekly-journal week error missing: ${r.stdout}`,
  );
});

// feedback type — ADR 0031 / fix #37 conditional schema (#8)
const FB_FM_OK =
  '---\ntitle: T\ntype: feedback\nstatus: active\nscope: global\ntier: L1\n' +
  'targets: [project-memory, claude-learned]\nsensitivity: public\npriority: 3\n' +
  'memory_summary: m\nglobal_summary: g\npromote_to_global: true\nreason: r\n' +
  'source: session:2026-05-20\nupdated: 2026-05-20\ntags: [feedback]\n---\nbody\n';

test('feedback fully populated → no error', () => {
  const { r } = lintWithSchema('pages/feedback/ok.md', FB_FM_OK);
  assert.equal(r.status, 0, `expected clean, got ${r.status}: ${r.stdout}`);
});

test('feedback missing tier → error', () => {
  const { r, out } = lintWithSchema('pages/feedback/x.md', FB_FM_OK.replace('tier: L1\n', ''));
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Missing required field for type "feedback": tier')),
    `tier error missing: ${r.stdout}`,
  );
});

test('feedback sensitivity:private → error (forbidden vocabulary)', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('sensitivity: public', 'sensitivity: private'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid value for sensitivity')),
    `private sensitivity must error: ${r.stdout}`,
  );
});

test('feedback claude-learned target without global_summary → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('global_summary: g\n', ''),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('targets:claude-learned: global_summary')),
    `conditional global_summary error missing: ${r.stdout}`,
  );
});

test('feedback project-memory-only target does NOT require global_summary', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('targets: [project-memory, claude-learned]', 'targets: [project-memory]')
      .replace('global_summary: g\n', '')
      .replace('promote_to_global: true\n', '')
      .replace('scope: global', 'scope: project:hypomnema')
      .replace('tier: L1', 'tier: L2'),
  );
  assert.equal(r.status, 0, `project-memory-only feedback should be clean: ${r.stdout}`);
});

test('feedback invalid scope → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('scope: global', 'scope: team'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid feedback scope')),
    `invalid scope must error: ${r.stdout}`,
  );
});

test('feedback status:superseded + sensitivity:sanitized → no error (allowed enums)', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('status: active', 'status: superseded').replace(
      'sensitivity: public',
      'sensitivity: sanitized',
    ),
  );
  assert.equal(r.status, 0, `superseded+sanitized must be clean: ${r.stdout}`);
});

test('feedback invalid tier → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('tier: L1', 'tier: L3'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid value for tier')),
    `invalid tier must error: ${r.stdout}`,
  );
});

test('feedback claude-learned target without promote_to_global → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('promote_to_global: true\n', ''),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('targets:claude-learned: promote_to_global')),
    `conditional promote_to_global error missing: ${r.stdout}`,
  );
});

test('feedback missing targets → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('targets: [project-memory, claude-learned]\n', ''),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "feedback": targets'),
    ),
    `missing targets error: ${r.stdout}`,
  );
});

suite('lint.mjs tag vocabulary + forbidden patterns');

test('PascalCase tag → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [Jenkins]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Forbidden tag pattern (PascalCase)')),
    `expected PascalCase error: ${r.stdout}`,
  );
});

test('plural tag (learnings) → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [learnings]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(out.errors.some((e) => e.message.includes('Forbidden tag pattern (plural)')));
});

test('generic tag (todo) → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [todo]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(out.errors.some((e) => e.message.includes('Forbidden tag pattern (generic)')));
});

test('unknown tag (not in vocab) → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [zzz-unknown]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Unknown tag: "zzz-unknown"')),
    `expected unknown tag error: ${r.stdout}`,
  );
});

test('valid tag in vocab → green', () => {
  const { r } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [wiki, concept]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `expected green, got ${r.status}`);
});

test('vocab parser excludes prose backticks and Forbidden table examples', () => {
  // Codex P3: prior parser accepted every backtick in the section, so `lint`
  // appearing in explanatory prose and `Jenkins` in the Forbidden table row
  // were silently added to the vocabulary.
  const schema =
    '---\ntitle: SCHEMA\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n' +
    'Use lowercase, hyphenated tags. `lint` blocks unknown tags.\n\n' +
    '**Meta**: `wiki`, `concept`\n\n' +
    '### Forbidden patterns\n\n' +
    '| Pattern | Reason | Use instead |\n' +
    '|---------|--------|-------------|\n' +
    '| PascalCase (`Jenkins`) | Inconsistent | `jenkins` |\n\n' +
    '## 5. Next\n';
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [lint]\n---\nbody\n',
    schema,
  );
  assert.equal(r.status, 1, `expected error for prose-only tag, got ${r.status}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Unknown tag: "lint"')),
    `parser leaked prose token "lint" into vocab: ${r.stdout}`,
  );
});

test('vocab check skipped when SCHEMA.md absent (back-compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-novocab-'));
  const pageDir = join(dir, 'pages');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(
    join(pageDir, 'x.md'),
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [Jenkins]\n---\nbody\n',
  );
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `expected green when SCHEMA.md missing, got ${r.status}: ${r.stdout}`);
});

// ── lint.mjs pages/ directory whitelist (B6 — SCHEMA dir typo guard) ─────────

suite('lint.mjs pages/ directory whitelist');

const DIR_SCHEMA = [
  '---',
  'title: SCHEMA',
  'type: schema',
  '---',
  '# Schema',
  '',
  '## 1. Page Type Taxonomy',
  '',
  '| type | directory | desc |',
  '|------|-----------|------|',
  '| `learning` | `pages/learnings/` | gotchas |',
  '| `feedback` | `pages/feedback/` | corrections |',
  '',
  '## 4. Tag Vocabulary',
  '',
  '`wiki` `concept`',
  '',
  '## 5. Next',
  '',
].join('\n');

// type: concept has no conditional-required fields and no tags → isolates B6 as
// the only possible error, since the check keys off the path, not frontmatter.
const PLAIN_PAGE = '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\n---\nbody\n';

test('typo directory (pages/learning/) → error', () => {
  const { r, out } = lintWithSchema('pages/learning/x.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Undefined pages/ directory: "pages/learning/"')),
    `expected undefined-dir error: ${r.stdout}`,
  );
});

test('canonical directory (pages/learnings/) → green', () => {
  const { r } = lintWithSchema('pages/learnings/x.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 0, `expected green, got ${r.status}: ${r.stdout}`);
});

test('root-level pages/ file (no subdir) → green', () => {
  const { r } = lintWithSchema('pages/x.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 0, `expected green, got ${r.status}: ${r.stdout}`);
});

test('dir check skipped when Page Type Taxonomy table absent (back-compat)', () => {
  // VOCAB_SCHEMA has no "## 1. Page Type Taxonomy" table → whitelist empty → skip.
  const { r } = lintWithSchema('pages/learning/x.md', PLAIN_PAGE);
  assert.equal(r.status, 0, `expected green when table absent, got ${r.status}: ${r.stdout}`);
});

test('_index.md in an undefined dir → green (scaffold exemption)', () => {
  // pages/observability/ ships via init but is a topical grouping, not a page
  // *type*, so it is absent from the taxonomy table. Its _index.md scaffold must
  // not trip the guard.
  const { r } = lintWithSchema('pages/observability/_index.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 0, `expected green for _index scaffold, got ${r.status}: ${r.stdout}`);
});

test('content file in an undefined dir still errors despite the _index exemption', () => {
  // The exemption must not blunt the guard: a real content page (no `_` prefix)
  // in a typo dir is still the original bug we are catching.
  const { r, out } = lintWithSchema('pages/learning/real-content.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Undefined pages/ directory: "pages/learning/"')),
    `expected undefined-dir error: ${r.stdout}`,
  );
});

test('fresh init wiki passes lint (regression: observability scaffold vs B6)', () => {
  // Worker-1 caught that B6 would fail a freshly initialized wiki because
  // init.mjs scaffolds pages/observability/_index.md, a dir absent from the
  // taxonomy table. Drive the real init.mjs + lint.mjs, not a fixture.
  const dir = mkdtempSync(join(tmpdir(), 'hypo-init-lint-'));
  const initR = run('init.mjs', [`--hypo-dir=${dir}`, '--no-hooks', '--no-git-init']);
  assert.equal(initR.status, 0, `init failed: ${initR.stderr || initR.stdout}`);
  const lintR = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(lintR.stdout);
  rmSync(dir, { recursive: true, force: true });
  const dirErrors = out.errors.filter((e) => /Undefined pages\/ directory/.test(e.message));
  assert.equal(dirErrors.length, 0, `B6 fired on fresh init wiki: ${JSON.stringify(dirErrors)}`);
  assert.equal(
    lintR.status,
    0,
    `fresh init wiki should lint green, got ${lintR.status}: ${lintR.stdout}`,
  );
});

// ── Lane B: formatGrowthMetrics + growth echo regressions ─────────────────

const { formatGrowthMetrics, computeSessionGrowth } = await import(join(HOOKS, 'hypo-shared.mjs'));

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
  assert.equal(
    formatGrowthMetrics('stop', { addedPages: 0, updatedPages: 0, newWikilinks: 0 }),
    '',
  );
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
    writeFileSync(
      join(dir, 'hot.md'),
      '---\ntitle: Hot\nupdated: today\n---\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n',
    );
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
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages', 'new.md'),
      '---\ntitle: New\n---\nrefs [[other]] and [[third]]\n',
    );
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stderr.includes('[hypo] +1 pages'), `expected growth line in stderr: ${r.stderr}`);
    const cache = JSON.parse(
      readFileSync(join(dir, '.cache', 'last-session-growth.json'), 'utf-8'),
    );
    assert.equal(cache.addedPages, 1);
    assert.ok(cache.newWikilinks >= 2);
  });
});

test('hot-rebuild emits no growth line when wiki is clean', () => {
  withGrowthWiki((dir) => {
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!r.stderr.includes('[hypo] +'), `unexpected growth line: ${r.stderr}`);
  });
});

suite('hypo-hot-rebuild.mjs — parsePointerRows row format');

test('valid wikilink row is preserved in rebuilt hot.md', () => {
  withTmpDir((dir) => {
    const hotContent = [
      '---',
      'title: Hot Cache — Pointer',
      'type: reference',
      'updated: 2026-01-01',
      'tags: [wiki, operations]',
      '---',
      '',
      '# Hot Cache',
      '',
      '> Read at session start',
      '',
      '## Active Projects',
      '',
      '| Project | Last Session | Hot Cache |',
      '|---|---|---|',
      '| my-project | 2026-01-01 | [[projects/my-project/hot]] |',
      '',
      '## Session Start Checklist',
      '',
      '1. Check this file',
    ].join('\n');
    writeFileSync(join(dir, 'hot.md'), hotContent);
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const result = readFileSync(join(dir, 'hot.md'), 'utf-8');
    assert.ok(
      result.includes('[[projects/my-project/hot]]'),
      'valid wikilink row must be preserved',
    );
  });
});

test('markdown link row is silently excluded when mixed with a valid wikilink row', () => {
  withTmpDir((dir) => {
    // mixed table: one valid wikilink row + one markdown link row
    const hotContent = [
      '---',
      'title: Hot Cache — Pointer',
      'type: reference',
      'updated: 2026-01-01',
      'tags: [wiki, operations]',
      '---',
      '',
      '# Hot Cache',
      '',
      '> Read at session start',
      '',
      '## Active Projects',
      '',
      '| Project | Last Session | Hot Cache |',
      '|---|---|---|',
      '| valid-project | 2026-01-01 | [[projects/valid-project/hot]] |',
      '| bad-project | 2026-01-01 | [projects/bad-project/hot](projects/bad-project/hot.md) |',
      '',
      '## Session Start Checklist',
      '',
      '1. Check this file',
    ].join('\n');
    writeFileSync(join(dir, 'hot.md'), hotContent);
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const result = readFileSync(join(dir, 'hot.md'), 'utf-8');
    assert.ok(
      result.includes('[[projects/valid-project/hot]]'),
      'valid wikilink row must be preserved',
    );
    assert.ok(
      !result.includes('bad-project'),
      'markdown link row must be excluded from rebuilt output',
    );
  });
});

suite('hypo-auto-commit.mjs / hypo-auto-stage.mjs — .hypoignore honor');

test('auto-commit skips .hypoignore-listed .cache paths', () => {
  withGrowthWiki((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    mkdirSync(join(dir, '.cache', 'sessions'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'sessions', 'index.jsonl'), '{"session_id":"x"}\n');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'note.md'), '# note\n');
    const r = runStop('hypo-auto-commit.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const tracked = spawnSync('git', ['-C', dir, 'ls-files', '.cache'], {
      encoding: 'utf-8',
    }).stdout;
    assert.equal(tracked.trim(), '', `expected .cache to be excluded, got: ${tracked}`);
    const trackedPages = spawnSync('git', ['-C', dir, 'ls-files', 'pages'], {
      encoding: 'utf-8',
    }).stdout;
    assert.ok(trackedPages.includes('pages/note.md'), 'pages/ should still be committed');
  });
});

test('auto-stage skips .hypoignore-listed file_path', () => {
  withGrowthWiki((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'a.json'), '{}\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-stage.mjs')], {
      input: JSON.stringify({ tool_input: { file_path: join(dir, '.cache', 'a.json') } }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0);
    const staged = spawnSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], {
      encoding: 'utf-8',
    }).stdout;
    assert.equal(staged.trim(), '', `unexpected staged: ${staged}`);
  });
});

suite('hypo-file-watch.mjs — .hypoignore privacy guard (fix #48)');

test('file-watch refuses to inject .hypoignore-matched file (e.g. .env)', () => {
  withGrowthWiki((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const secretPath = join(dir, '.env');
    writeFileSync(secretPath, 'OPENAI_API_KEY=sk-leakedvalue\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-file-watch.mjs')], {
      input: JSON.stringify({ file_path: secretPath }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true);
    assert.equal(
      out.additionalContext,
      undefined,
      `.hypoignore-matched secret leaked into additionalContext: ${out.additionalContext}`,
    );
    assert.ok(!/sk-leakedvalue/.test(r.stdout), `secret value leaked in stdout: ${r.stdout}`);
  });
});

test('file-watch still injects non-ignored wiki file (e.g. hot.md)', () => {
  withGrowthWiki((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.env*\n');
    const hotPath = join(dir, 'hot.md');
    writeFileSync(hotPath, '# hot\n\nactive project state\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-file-watch.mjs')], {
      input: JSON.stringify({ file_path: hotPath }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(
      out.additionalContext && /active project state/.test(out.additionalContext),
      `expected hot.md injection, got: ${out.additionalContext}`,
    );
  });
});

suite('hypo-session-start.mjs / hypo-cwd-change.mjs — .hypoignore injection guard (fix #48)');

function withPrivateProject(fn) {
  withGrowthWiki((dir) => {
    const work = mkdtempSync(join(tmpdir(), 'hypo-priv-work-'));
    const projDir = join(dir, 'projects', 'private');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'index.md'),
      `---\ntitle: private\ntype: project-index\nupdated: 2026-05-18\nworking_dir: "${work}"\n---\n# Private\n`,
    );
    writeFileSync(join(projDir, 'hot.md'), '# hot\nSECRET_HOT_VALUE\n');
    writeFileSync(join(projDir, 'session-state.md'), '# state\nSECRET_STATE_VALUE\n');
    try {
      fn(dir, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test('session-start refuses to inject .hypoignore-matched project hot/state', () => {
  withPrivateProject((dir, work) => {
    writeFileSync(
      join(dir, '.hypoignore'),
      'projects/private/hot.md\nprojects/private/session-state.md\n',
    );
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-session-start.mjs')], {
      input: JSON.stringify({ cwd: work, session_id: 'test-fix48-ss' }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      !/SECRET_HOT_VALUE|SECRET_STATE_VALUE/.test(r.stdout),
      `secret leaked through session-start: ${r.stdout}`,
    );
  });
});

test('session-start still injects non-ignored project hot/state', () => {
  withPrivateProject((dir, work) => {
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-session-start.mjs')], {
      input: JSON.stringify({ cwd: work, session_id: 'test-fix48-ss-ok' }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0);
    assert.ok(
      /SECRET_HOT_VALUE/.test(r.stdout) && /SECRET_STATE_VALUE/.test(r.stdout),
      `expected legitimate hot/state injection, got: ${r.stdout}`,
    );
  });
});

test('cwd-change refuses to inject .hypoignore-matched project hot.md', () => {
  withPrivateProject((dir, work) => {
    writeFileSync(join(dir, '.hypoignore'), 'projects/private/hot.md\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-cwd-change.mjs')], {
      input: JSON.stringify({ new_cwd: work, old_cwd: '/tmp/other' }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!/SECRET_HOT_VALUE/.test(r.stdout), `secret leaked through cwd-change: ${r.stdout}`);
  });
});

test('cwd-change refuses to inject .hypoignore-matched global hot.md', () => {
  withGrowthWiki((dir) => {
    writeFileSync(join(dir, '.hypoignore'), 'hot.md\n');
    writeFileSync(join(dir, 'hot.md'), '# global\nSECRET_GLOBAL_VALUE\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-cwd-change.mjs')], {
      input: JSON.stringify({ new_cwd: '/tmp/nowhere-no-project', old_cwd: '/tmp/other' }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      !/SECRET_GLOBAL_VALUE/.test(r.stdout),
      `global secret leaked through cwd-change: ${r.stdout}`,
    );
  });
});

// ── auto-project suggestion (fix #23 / ADR 0023) ──────────────────────────────
suite('hypo-session-start.mjs / hypo-cwd-change.mjs — auto-project suggestion (fix #23)');

const AP_OFFER_RE = /매칭되는 프로젝트가 없습니다.*자동 생성할까요/;

// A wiki root (non-git is fine — session-start's git pull is best-effort) plus a
// scratch "work" dir the hook will treat as the user's cwd.
function withAutoProjectEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-ap-wiki-'));
  const work = mkdtempSync(join(tmpdir(), 'hypo-ap-work-'));
  try {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(join(dir, 'hot.md'), '---\ntitle: Hot\nupdated: 2026-05-21\n---\n# Hot\n');
    mkdirSync(join(dir, 'projects'), { recursive: true });
    fn(dir, work);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

// Turn `work` into a trigger-worthy project dir: git repo (.git present) + a
// recognized marker. shouldSuggestProjectCreation only stats `.git`, so an empty
// dir is enough — no real `git init` needed.
function makeTriggerCwd(work) {
  mkdirSync(join(work, '.git'), { recursive: true });
  writeFileSync(join(work, 'package.json'), '{}');
}

function runSessionStart(dir, work, sessionId = 'ap-ss') {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-session-start.mjs')], {
    input: JSON.stringify({ cwd: work, session_id: sessionId }),
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: dir, HOME: SESSION_TMP_HOME },
  });
}

// §8.11 case 1: new git+marker cwd with no matching project → offer emitted.
// Canonical Coverage Matrix id (spec §9.1.1): replay-session-start-suggests-auto-project
test('replay-session-start-suggests-auto-project: unmatched git+marker cwd → offer', () => {
  withAutoProjectEnv((dir, work) => {
    makeTriggerCwd(work);
    const r = runSessionStart(dir, work);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(AP_OFFER_RE.test(r.stdout), `expected offer, got: ${r.stdout}`);
    // cooldown was recorded
    assert.ok(
      existsSync(join(dir, '.cache', 'project-suggestions.json')),
      'expected cooldown to be persisted',
    );
  });
});

// §8.11 case 4: git repo but no project marker → no offer.
test('session-start does NOT offer when cwd lacks a project marker', () => {
  withAutoProjectEnv((dir, work) => {
    mkdirSync(join(work, '.git'), { recursive: true }); // git but no marker
    const r = runSessionStart(dir, work);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!AP_OFFER_RE.test(r.stdout), `unexpected offer: ${r.stdout}`);
  });
});

// §8.11 case 5 (trigger condition a): not a git repo → no offer.
test('session-start does NOT offer when cwd is not a git repo', () => {
  withAutoProjectEnv((dir, work) => {
    writeFileSync(join(work, 'package.json'), '{}'); // marker but no .git
    const r = runSessionStart(dir, work);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!AP_OFFER_RE.test(r.stdout), `unexpected offer: ${r.stdout}`);
  });
});

// §8.11 case 2: cwd already maps to a project (HIT branch) → no offer.
test('session-start does NOT offer when cwd matches an existing project', () => {
  withAutoProjectEnv((dir, work) => {
    makeTriggerCwd(work);
    const projDir = join(dir, 'projects', 'existing');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'index.md'),
      `---\ntitle: existing\ntype: project-index\nupdated: 2026-05-21\nworking_dir: "${work}"\n---\n# existing\n`,
    );
    writeFileSync(join(projDir, 'hot.md'), '# hot\nbackground\n');
    const r = runSessionStart(dir, work);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!AP_OFFER_RE.test(r.stdout), `unexpected offer for matched project: ${r.stdout}`);
  });
});

// §8.11 case 5 (persistence): a declined cwd in skips[] → silent forever.
test('session-start does NOT offer when cwd is in skips[] (declined)', () => {
  withAutoProjectEnv((dir, work) => {
    makeTriggerCwd(work);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'project-suggestions.json'),
      JSON.stringify({
        skips: [{ cwd: work, declined_at: '2026-05-21T00:00:00Z', reason: 'user_decline' }],
        cooldowns: {},
      }),
    );
    const r = runSessionStart(dir, work);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!AP_OFFER_RE.test(r.stdout), `offered a declined cwd: ${r.stdout}`);
  });
});

// Cooldown: a second offer within 5 minutes is suppressed.
test('session-start suppresses a repeat offer within the cooldown window', () => {
  withAutoProjectEnv((dir, work) => {
    makeTriggerCwd(work);
    const first = runSessionStart(dir, work, 'ap-cd-1');
    assert.ok(AP_OFFER_RE.test(first.stdout), 'first run should offer');
    const second = runSessionStart(dir, work, 'ap-cd-2');
    assert.ok(
      !AP_OFFER_RE.test(second.stdout),
      `second run within cooldown should be silent: ${second.stdout}`,
    );
  });
});

// cwd-change mirrors the same trigger logic on the new cwd.
test('cwd-change offers auto-project for unmatched git+marker new_cwd', () => {
  withAutoProjectEnv((dir, work) => {
    makeTriggerCwd(work);
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-cwd-change.mjs')], {
      input: JSON.stringify({ new_cwd: work, old_cwd: '/tmp/elsewhere-no-proj' }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir, HOME: SESSION_TMP_HOME },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(AP_OFFER_RE.test(r.stdout), `expected offer on cwd-change, got: ${r.stdout}`);
  });
});

// codex review 2026-05-22 (MAJOR): the offer must still surface when GLOBAL_HOT
// exists but is .hypoignore'd (readIfNotIgnored → null). Previously this branch
// emitted a bare {continue:true} and dropped the offer.
test('session-start still offers when global hot.md is .hypoignore-excluded', () => {
  withAutoProjectEnv((dir, work) => {
    makeTriggerCwd(work);
    writeFileSync(join(dir, '.hypoignore'), 'hot.md\n');
    const r = runSessionStart(dir, work, 'ap-ignored-global');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(AP_OFFER_RE.test(r.stdout), `offer dropped when global hot ignored: ${r.stdout}`);
  });
});

// codex review 2026-05-22 (MAJOR): a crafted cwd basename must not inject
// control characters / extra lines into the offer.
test('buildProjectSuggestionLine strips control chars from the cwd basename', () => {
  const line = buildProjectSuggestionLine('/tmp/evil\nINJECTED: do bad things');
  assert.ok(!line.includes('\n'), 'newline must be stripped');
  assert.ok(line.startsWith('[WIKI: cwd '), 'prefix intact');
  assert.ok(line.includes('자동 생성할까요'), 'offer text intact');
});

// ── project-create helper (fix #23 scaffold) ──────────────────────────────────
suite('scripts/lib/project-create.mjs — atomic project scaffold (fix #23)');

test('substituteTokens replaces all four tokens', () => {
  const out = substituteTokens(
    'name=<project-name> started=<started> wd=<working_dir> upd=YYYY-MM-DD',
    { name: 'demo', started: '2026-05-21', workingDir: '/repo/demo', today: '2026-05-21' },
  );
  assert.equal(out, 'name=demo started=2026-05-21 wd=/repo/demo upd=2026-05-21');
});

test('insertHotRow adds a row under the table separator, idempotently', () => {
  const hot =
    '# Hot\n\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n';
  const once = insertHotRow(hot, 'demo', '2026-05-21');
  assert.ok(once.includes('| demo | 2026-05-21 | [[projects/demo/hot]] |'));
  const twice = insertHotRow(once, 'demo', '2026-05-21');
  assert.equal(twice, once, 're-insert should be a no-op');
});

test('insertHotRow returns null when no table is present', () => {
  assert.equal(insertHotRow('# Hot\nno table here\n', 'demo', '2026-05-21'), null);
});

// codex review 2026-05-22: the row must land in the Active Projects table even
// when an unrelated table appears earlier in hot.md.
test('insertHotRow targets the Active Projects table, not an earlier table', () => {
  const hot =
    '## Other\n\n| A | B | C |\n|---|---|---|\n| x | y | z |\n\n' +
    '## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n';
  const out = insertHotRow(hot, 'demo', '2026-05-21');
  const lines = out.split('\n');
  const rowIdx = lines.findIndex((l) => l.includes('[[projects/demo/hot]]'));
  const apIdx = lines.findIndex((l) => /^##\s+Active Projects/.test(l));
  assert.ok(rowIdx > apIdx, 'row must be inside the Active Projects section');
  // the earlier "## Other" table must be untouched
  assert.ok(out.includes('| x | y | z |'), 'unrelated table preserved');
});

test('insertHotRow returns null when Active Projects has no table in scope', () => {
  // a table exists, but it is above Active Projects (which has no table of its own)
  const hot = '## Other\n\n| A |\n|---|\n\n## Active Projects\n\n(no table yet)\n';
  assert.equal(insertHotRow(hot, 'demo', '2026-05-21'), null);
});

test('createProject scaffolds files, hot row, and log entry with substitution', () => {
  withGrowthWiki((dir) => {
    // withGrowthWiki ships templates-less; copy the _template into the package
    // is unnecessary — createProject reads from the real package templates dir.
    writeFileSync(join(dir, 'log.md'), '# Log\n');
    const res = createProject({
      hypoDir: dir,
      name: 'newproj',
      workingDir: '/Users/x/code/newproj',
      started: '2026-05-21',
      today: '2026-05-21',
    });
    const index = readFileSync(join(dir, 'projects', 'newproj', 'index.md'), 'utf-8');
    assert.ok(index.includes('working_dir: /Users/x/code/newproj'), 'working_dir substituted');
    assert.ok(index.includes('started: 2026-05-21'), 'started substituted');
    assert.ok(!index.includes('<project-name>'), 'no leftover name token');
    assert.ok(existsSync(join(dir, 'projects', 'newproj', 'decisions')), 'decisions dir created');
    assert.ok(
      existsSync(join(dir, 'projects', 'newproj', 'session-log')),
      'session-log dir created',
    );
    const hot = readFileSync(join(dir, 'hot.md'), 'utf-8');
    assert.ok(hot.includes('[[projects/newproj/hot]]'), 'hot row added');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.ok(log.includes('## [2026-05-21] project-create | newproj'), 'log entry added');
    assert.ok(res.created.length > 0);
  });
});

test('createProject is idempotent on re-run', () => {
  withGrowthWiki((dir) => {
    writeFileSync(join(dir, 'log.md'), '# Log\n');
    const opts = {
      hypoDir: dir,
      name: 'idem',
      workingDir: '/x',
      started: '2026-05-21',
      today: '2026-05-21',
    };
    createProject(opts);
    const res2 = createProject(opts);
    assert.ok(res2.skipped.includes('projects/idem/index.md'), 'files skipped on re-run');
    assert.ok(res2.skipped.includes('hot.md row'), 'hot row skipped on re-run');
    assert.ok(res2.skipped.includes('log.md entry'), 'log entry skipped on re-run');
    const hot = readFileSync(join(dir, 'hot.md'), 'utf-8');
    assert.equal(
      (hot.match(/\[\[projects\/idem\/hot\]\]/g) || []).length,
      1,
      'no duplicate hot row',
    );
  });
});

test('createProject rejects an invalid project name', () => {
  withGrowthWiki((dir) => {
    assert.throws(
      () => createProject({ hypoDir: dir, name: '../evil', workingDir: '/x' }),
      /invalid project name/,
    );
  });
});

// codex review 2026-05-22 (BLOCKER, both workers): dot-only names pass the
// charset regex but resolve outside projects/<name>. Must be rejected.
test('createProject rejects path-escape dot names (.., ., ...)', () => {
  withGrowthWiki((dir) => {
    for (const evil of ['..', '.', '...']) {
      assert.throws(
        () => createProject({ hypoDir: dir, name: evil, workingDir: '/x' }),
        /invalid project name|escapes projects/,
        `name ${JSON.stringify(evil)} must be rejected`,
      );
    }
    // a name with no alphanumeric char is also rejected
    assert.throws(
      () => createProject({ hypoDir: dir, name: '_-_', workingDir: '/x' }),
      /invalid project name/,
    );
    // sanity: the wiki root was not scaffolded by the rejected attempts
    assert.ok(!existsSync(join(dir, 'decisions')), 'wiki root must not be scaffolded');
  });
});

// ── first-prompt forced resume summary (fix #3) + cwd-change re-trigger (#13) ──
suite('hypo-first-prompt.mjs — forced resume summary (fix #3 / #13)');

// first-prompt reads its marker from os.tmpdir(), independent of HOME/HYPO_DIR.
// Tests use a unique session_id so the marker path never collides.
function markerPath(sessionId) {
  return join(tmpdir(), `hypo-session-marker-${sessionId}.json`);
}
function writeMarker(sessionId, marker) {
  writeFileSync(markerPath(sessionId), JSON.stringify({ ts: Date.now(), ...marker }));
}
function runFirstPrompt(sessionId) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-first-prompt.mjs')], {
    input: JSON.stringify({ session_id: sessionId, prompt: 'unrelated weather question' }),
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '/tmp/nonexistent-hypo-99999' },
  });
}

test('replay-first-prompt-forces-summary: fresh marker forces unconditional summary line', () => {
  const sid = `fp-force-${process.pid}-${Date.now()}`;
  writeMarker(sid, { proj: 'demo', hotPath: null, hasSnapshot: true });
  try {
    const r = runFirstPrompt(sid);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout).additionalContext || '';
    assert.match(out, /Previously working on demo/, 'must force the resume summary line');
    assert.match(out, /unconditionally/, 'directive must be unconditional (fix #3)');
    // The old "answer only if related / no mention" escape must be gone.
    assert.doesNotMatch(out, /answer only, no mention/, 'old conditional hint must be removed');
  } finally {
    if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
  }
});

test('replay-first-prompt-forces-summary: cwd-change marker says "Resuming"', () => {
  const sid = `fp-resume-${process.pid}-${Date.now()}`;
  writeMarker(sid, { proj: 'demo', hotPath: null, hasSnapshot: true, source: 'cwd-change' });
  try {
    const r = runFirstPrompt(sid);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout).additionalContext || '';
    assert.match(out, /Resuming demo/, 'cwd-change source must phrase as Resuming (fix #13)');
    assert.doesNotMatch(out, /Previously working on/, 'must not use the session-start verb');
  } finally {
    if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
  }
});

test('replay-first-prompt-forces-summary: no marker → silent pass-through', () => {
  const sid = `fp-none-${process.pid}-${Date.now()}`;
  const r = runFirstPrompt(sid); // no marker written
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.additionalContext, undefined, 'no marker → no injected directive');
  assert.equal(out.suppressOutput, true);
});

test('replay-first-prompt-forces-summary: expired marker (>10min) → no directive, cleaned up', () => {
  const sid = `fp-exp-${process.pid}-${Date.now()}`;
  writeFileSync(
    markerPath(sid),
    JSON.stringify({ proj: 'demo', hasSnapshot: true, ts: Date.now() - 11 * 60 * 1000 }),
  );
  const r = runFirstPrompt(sid);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).additionalContext, undefined, 'expired marker injects nothing');
  assert.equal(existsSync(markerPath(sid)), false, 'expired marker is unlinked');
});

test('replay-cwd-change-triggers-first-prompt: entering a project arms the marker', () => {
  const sid = `cwd-arm-${process.pid}-${Date.now()}`;
  withPrivateProject((dir, work) => {
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-cwd-change.mjs')], {
      input: JSON.stringify({ new_cwd: work, old_cwd: '/tmp/other-nonproject', session_id: sid }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    try {
      assert.ok(
        existsSync(markerPath(sid)),
        'cwd-change must write a first-prompt marker (fix #13)',
      );
      const m = JSON.parse(readFileSync(markerPath(sid), 'utf-8'));
      assert.equal(m.proj, 'private');
      assert.equal(m.source, 'cwd-change');
      // The armed marker drives first-prompt to force a "Resuming" line.
      const fp = runFirstPrompt(sid);
      const out = JSON.parse(fp.stdout).additionalContext || '';
      assert.match(out, /Resuming private/, 'armed marker forces Resuming on next prompt');
    } finally {
      if (existsSync(markerPath(sid))) unlinkSync(markerPath(sid));
    }
  });
});

const sharedMod = await import(`${REPO}/hooks/hypo-shared.mjs`);

test('sessionMarkerPath: sanitizes path separators and empty ids (codex fix #3/#13)', () => {
  const { sessionMarkerPath } = sharedMod;
  // A crafted id with separators / traversal must collapse to a flat filename
  // inside tmpdir — never escape it.
  const evil = sessionMarkerPath('../../etc/passwd');
  assert.equal(dirname(evil), tmpdir(), 'must stay directly under tmpdir');
  assert.doesNotMatch(evil, /\/etc\/passwd/, 'separators must not survive');
  // Empty / missing id falls back to a stable default, never a bare marker name.
  assert.match(sessionMarkerPath(''), /hypo-session-marker-default\.json$/);
  assert.match(sessionMarkerPath(undefined), /hypo-session-marker-default\.json$/);
  // A normal UUID-ish id is preserved verbatim.
  assert.match(sessionMarkerPath('abc-123_DEF'), /hypo-session-marker-abc-123_DEF\.json$/);
});

test('replay-cwd-change-triggers-first-prompt: ignored hot.md does NOT arm the marker', () => {
  const sid = `cwd-ignored-${process.pid}-${Date.now()}`;
  withPrivateProject((dir, work) => {
    // hot.md is .hypoignore'd → cwd-change injects a placeholder, so there is
    // nothing to summarize and the marker must NOT be armed (codex finding #2).
    writeFileSync(join(dir, '.hypoignore'), 'projects/private/hot.md\n');
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-cwd-change.mjs')], {
      input: JSON.stringify({ new_cwd: work, old_cwd: '/tmp/other-nonproject', session_id: sid }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    if (existsSync(markerPath(sid))) {
      unlinkSync(markerPath(sid));
      assert.fail('ignored/absent hot content must not arm a "Resuming" marker');
    }
  });
});

test('replay-cwd-change-triggers-first-prompt: same-project move does NOT arm the marker', () => {
  const sid = `cwd-same-${process.pid}-${Date.now()}`;
  withPrivateProject((dir, work) => {
    const sub = join(work, 'subdir');
    mkdirSync(sub, { recursive: true });
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-cwd-change.mjs')], {
      input: JSON.stringify({ new_cwd: sub, old_cwd: work, session_id: sid }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    if (existsSync(markerPath(sid))) {
      unlinkSync(markerPath(sid));
      assert.fail('same-project cwd move must skip and not arm a marker');
    }
  });
});

test('file-watch ignores file outside HYPO_DIR even without .hypoignore', () => {
  withGrowthWiki((dir) => {
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-file-watch.mjs')], {
      input: JSON.stringify({ file_path: '/etc/passwd' }),
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: dir },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.additionalContext, undefined);
  });
});

suite('ingest.mjs — .hypoignore privacy guard (#14)');

test('ingest-rejects-hypoignore: --check=.env refuses (spec §8.10 verification #2)', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=.env']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
    assert.ok(/Refused/.test(r.stderr), `expected refusal message, got: ${r.stderr}`);
    assert.ok(/\.env\*/.test(r.stderr), `expected matched pattern in message, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: --check=sources/<slug> refuses renamed secret (rename-bypass)', () => {
  withTmpDir((dir) => {
    // A user could rename `.env` to an innocuous slug; the destination path
    // sources/<slug>.<ext> must still be blocked by a content-pattern match.
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=sources/my-secrets.md']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
    assert.ok(/Refused/.test(r.stderr), `expected refusal message, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: --check on a non-ignored path exits 0 silently', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=sources/openai-swarm-paper.md']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
    assert.equal(r.stdout.trim(), '', `expected no stdout, got: ${r.stdout}`);
    assert.equal(r.stderr.trim(), '', `expected no stderr, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: --check with no .hypoignore file exits 0', () => {
  withTmpDir((dir) => {
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=.env']);
    assert.equal(
      r.status,
      0,
      `expected exit 0 with no .hypoignore, got ${r.status} (stderr: ${r.stderr})`,
    );
  });
});

test('ingest-rejects-hypoignore: symlink with innocuous name pointing at ignored target is refused', () => {
  withTmpDir((dir) => {
    // A symlink `innocent-note.md` → `.env` would otherwise pass the lexical
    // check (its own basename is not ignored) and let `/hypo:ingest` read the
    // secret it points at. The guard follows the symlink via realpath.
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    writeFileSync(join(dir, '.env'), 'API_KEY=xxx\n');
    symlinkSync(join(dir, '.env'), join(dir, 'innocent-note.md'));
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=innocent-note.md']);
    assert.equal(
      r.status,
      1,
      `expected exit 1 (symlink bypass), got ${r.status} (stderr: ${r.stderr})`,
    );
    assert.ok(/Refused/.test(r.stderr), `expected refusal message, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: ../ traversal is still caught by basename patterns', () => {
  withTmpDir((dir) => {
    // `join(hypoDir, '../foo/.env')` resolves outside the wiki; anchored
    // patterns no longer apply, but basename patterns (`.env*`) still must.
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=../foo/.env']);
    assert.equal(
      r.status,
      1,
      `expected exit 1 (basename match through traversal), got ${r.status} (stderr: ${r.stderr})`,
    );
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
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'last-session-growth.json'),
      JSON.stringify({ addedPages: 4, updatedPages: 2, newWikilinks: 7, ts: Date.now() }),
    );
    const r = runStart(dir);
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext || '';
    assert.ok(
      ctx.includes('직전 세션: +4 pages, ~2 updated, 7 wikilinks'),
      `growth prefix missing in additionalContext: ${ctx}`,
    );
  });
});

test('session-start emits no growth line when cache absent', () => {
  withGrowthWiki((dir) => {
    const r = runStart(dir);
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext || '';
    assert.ok(!ctx.includes('직전 세션'), `unexpected growth line: ${ctx}`);
  });
});

// ── sync-state replay (fix #9/#10) ───────────────────────────────────────────

// A wiki repo wired to a working bare remote and pushed in sync — the baseline
// for exercising session-start's clear/preserve logic.
function withSyncedWiki(fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-sync-'));
  const dir = join(base, 'wiki');
  const remote = join(base, 'remote.git');
  try {
    spawnSync('git', ['init', '--bare', '-q', remote]);
    spawnSync('git', ['init', '-q', dir]);
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(
      join(dir, 'hot.md'),
      '---\ntitle: Hot\nupdated: today\n---\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n',
    );
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    spawnSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'HEAD']);
    fn(dir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function readSyncEntries(dir) {
  return readFileSync(join(dir, '.cache', 'sync-state.json'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

suite('hypo-auto-commit.mjs / hypo-session-start.mjs — sync-state replay');

test('replay-auto-commit-writes-sync-state: pull/push failure appends entries', () => {
  withGrowthWiki((dir) => {
    // a remote that does not exist → both pull and push fail
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', join(dir, 'no-such-remote.git')]);
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'note.md'), '# note\n');
    const r = runStop('hypo-auto-commit.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      existsSync(join(dir, '.cache', 'sync-state.json')),
      'sync-state.json must be created on sync failure',
    );
    const entries = readSyncEntries(dir);
    assert.ok(entries.length >= 1, `expected ≥1 failure entry, got ${entries.length}`);
    assert.ok(
      entries.every((e) => e.op === 'pull' || e.op === 'push'),
      `unexpected op: ${JSON.stringify(entries)}`,
    );
    assert.ok(
      entries.every((e) => e.timestamp && e.host && e.error),
      `entries must carry timestamp/host/error: ${JSON.stringify(entries)}`,
    );
  });
});

test('replay-session-start-exposes-sync-state: open entry surfaces in additionalContext', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({
        timestamp: '2026-05-14T00:00:00Z',
        op: 'push',
        error: 'network timeout',
        host: 'test',
      }) + '\n',
    );
    const r = runStart(dir);
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(ctx.includes('last sync failed'), `sync notice missing: ${ctx}`);
    assert.ok(ctx.includes('network timeout'), `error detail missing: ${ctx}`);
  });
});

test('replay-session-start-clears-resolved-sync-state: healthy repo clears the entry', () => {
  withSyncedWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'sync-state.json');
    writeFileSync(
      p,
      JSON.stringify({
        timestamp: '2026-05-14T00:00:00Z',
        op: 'pull',
        error: 'network timeout',
        host: 'test',
      }) + '\n',
    );
    const r = runStart(dir);
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(!ctx.includes('last sync failed'), `resolved sync should not surface: ${ctx}`);
    assert.ok(!existsSync(p), 'sync-state.json must be cleared once sync is healthy');
  });
});

test('replay-session-start-surfaces-unreadable-sync-state: corrupt JSONL is not silently hidden', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'sync-state.json');
    writeFileSync(
      p,
      JSON.stringify({ timestamp: '2026-05-14T00:00:00Z', op: 'push', error: 'x', host: 'test' }) +
        '\nnot-json\n',
    );
    const r = runStart(dir);
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(ctx.includes('last sync failed'), `corrupt sync-state must still surface: ${ctx}`);
    assert.ok(existsSync(p), 'unreadable sync-state.json must be preserved for inspection');
  });
});

test('replay-session-start-preserves-sync-state-when-ahead: unpushed commit keeps the entry', () => {
  withSyncedWiki((dir) => {
    // simulate a prior failed push: a local commit not on the remote
    writeFileSync(join(dir, 'unpushed.md'), '# unpushed\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'unpushed work']);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'sync-state.json');
    writeFileSync(
      p,
      JSON.stringify({
        timestamp: '2026-05-14T00:00:00Z',
        op: 'push',
        error: 'connection refused',
        host: 'test',
      }) + '\n',
    );
    const r = runStart(dir);
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(
      ctx.includes('last sync failed'),
      `unresolved push failure must stay surfaced: ${ctx}`,
    );
    assert.ok(existsSync(p), 'sync-state.json must not be cleared while local is ahead of remote');
  });
});

// ── hypo-session-end / clear-marker (fix #25 PR-A2, ADR 0022 amendment) ────

suite('hypo-session-end.mjs / hypo-session-start.mjs — clear-marker replay');

function runSessionEnd(dir, payload) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-session-end.mjs')], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir },
  });
}

function runStartWithSource(dir, source) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-session-start.mjs')], {
    input: JSON.stringify({ cwd: dir, session_id: 'new-session', source }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir },
  });
}

function readMarker(dir) {
  const p = join(dir, '.cache', 'clear-marker.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

test('replay-session-end-writes-clear-marker-on-clear: reason=clear stashes session identity', () => {
  withGrowthWiki((dir) => {
    const r = runSessionEnd(dir, {
      reason: 'clear',
      session_id: 'dying-session',
      transcript_path: '/tmp/transcript-xyz.jsonl',
      cwd: '/Users/x/Workspace/foo',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const marker = readMarker(dir);
    assert.ok(marker, 'clear-marker.json must be written');
    assert.equal(marker.prev_session_id, 'dying-session');
    assert.equal(marker.prev_transcript_path, '/tmp/transcript-xyz.jsonl');
    assert.equal(marker.prev_cwd, '/Users/x/Workspace/foo');
    assert.ok(marker.ts, 'ts must be present');
  });
});

test('replay-session-end-skips-marker-on-non-clear-reason: prompt_input_exit is a deliberate exit', () => {
  withGrowthWiki((dir) => {
    const r = runSessionEnd(dir, {
      reason: 'prompt_input_exit',
      session_id: 'normal-exit',
      transcript_path: '/tmp/t.jsonl',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readMarker(dir), null, 'non-clear reason must not write marker');
  });
});

test('replay-session-end-skips-marker-on-logout: any non-clear reason is skipped', () => {
  withGrowthWiki((dir) => {
    runSessionEnd(dir, { reason: 'logout', session_id: 's', transcript_path: '/t' });
    assert.equal(readMarker(dir), null);
  });
});

test('replay-session-start-injects-clear-recovery-on-source-clear: marker drives [WIKI_AUTOCLOSE]', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'clear-marker.json'),
      JSON.stringify({
        prev_session_id: 'dying-session-42',
        prev_transcript_path: '/tmp/transcript-42.jsonl',
        prev_cwd: '/Users/x/repo',
        ts: new Date().toISOString(),
      }) + '\n',
    );
    const r = runStartWithSource(dir, 'clear');
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(ctx.includes('[WIKI_AUTOCLOSE]'), `recovery line missing: ${ctx}`);
    assert.ok(ctx.includes('dying-session-42'), `prev_session_id missing: ${ctx}`);
    assert.ok(ctx.includes('/tmp/transcript-42.jsonl'), `prev_transcript_path missing: ${ctx}`);
    assert.ok(ctx.includes('/Users/x/repo'), `prev_cwd missing from recovery line: ${ctx}`);
  });
});

test('replay-session-end-emits-suppressed-continue: stdout JSON is well-formed', () => {
  withGrowthWiki((dir) => {
    const r = runSessionEnd(dir, {
      reason: 'clear',
      session_id: 's',
      transcript_path: '/t',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'must emit continue:true');
    assert.equal(out.suppressOutput, true, 'must emit suppressOutput:true');
  });
});

test('replay-session-end-graceful-when-hypo-dir-missing: no marker created in nonexistent wiki', () => {
  const ghostDir = join(tmpdir(), `hypo-ghost-${process.pid}-${Date.now()}`);
  const r = runSessionEnd(ghostDir, { reason: 'clear', session_id: 's', transcript_path: '/t' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(!existsSync(ghostDir), 'hook must not create the wiki tree it is missing');
});

test('replay-session-start-removes-corrupt-marker: invalid JSON triggers self-cleanup', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'clear-marker.json');
    writeFileSync(p, '{not valid json');
    const r = runStartWithSource(dir, 'clear');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(!ctx.includes('[WIKI_AUTOCLOSE]'), `corrupt marker must not fire: ${ctx}`);
    assert.ok(!existsSync(p), 'corrupt marker must be unlinked on read failure');
  });
});

test('replay-session-start-removes-marker-after-read: one-shot contract', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'clear-marker.json');
    writeFileSync(
      p,
      JSON.stringify({
        prev_session_id: 's',
        prev_transcript_path: '/t',
        prev_cwd: '/c',
        ts: new Date().toISOString(),
      }) + '\n',
    );
    runStartWithSource(dir, 'clear');
    assert.ok(!existsSync(p), 'marker must be unlinked after read (one-shot)');
  });
});

test('replay-session-start-graceful-when-source-clear-but-no-marker: missing marker is silent', () => {
  withGrowthWiki((dir) => {
    const r = runStartWithSource(dir, 'clear');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(!ctx.includes('[WIKI_AUTOCLOSE]'), `recovery line should not fire: ${ctx}`);
  });
});

test('replay-session-start-ignores-clear-marker-on-source-startup: marker only consumed on source=clear', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'clear-marker.json');
    writeFileSync(
      p,
      JSON.stringify({
        prev_session_id: 's',
        prev_transcript_path: '/t',
        ts: new Date().toISOString(),
      }) + '\n',
    );
    const r = runStartWithSource(dir, 'startup');
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(!ctx.includes('[WIKI_AUTOCLOSE]'), `marker must not fire on source=startup: ${ctx}`);
    assert.ok(existsSync(p), 'marker must be preserved when source !== clear');
  });
});

test('replay-session-start-drops-stale-clear-marker: >7 day marker is discarded', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'clear-marker.json');
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      p,
      JSON.stringify({
        prev_session_id: 's',
        prev_transcript_path: '/t',
        ts: stale,
      }) + '\n',
    );
    const r = runStartWithSource(dir, 'clear');
    const ctx = JSON.parse(r.stdout).additionalContext || '';
    assert.ok(!ctx.includes('[WIKI_AUTOCLOSE]'), `stale marker must not fire: ${ctx}`);
    assert.ok(!existsSync(p), 'stale marker must be cleaned up');
  });
});

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

suite('hypo-lookup.mjs — type-prior boost');

test('output is always valid JSON', () => {
  const r = runHook('hypo-lookup.mjs', { prompt: 'hello world' });
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout: ${r.stdout}`);
});

test('PRD entry ranked above plain entry with same keyword', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'prd-search.md'), '# PRD\n');
    writeFileSync(join(dir, 'pages', 'search-notes.md'), '# Notes\n');
    const indexContent = [
      '# Index',
      '- [[prd-search]] — search feature product requirements',
      '- [[search-notes]] — search feature general notes',
    ].join('\n');
    writeFileSync(join(dir, 'index.md'), indexContent);
    const r = runHook('hypo-lookup.mjs', { prompt: 'search feature' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    const prdPos = ctx.indexOf('prd-search');
    const plainPos = ctx.indexOf('search-notes');
    assert.ok(prdPos !== -1, 'PRD entry should appear in context');
    assert.ok(prdPos < plainPos || plainPos === -1, 'PRD should rank before plain entry');
  });
});

test('ADR entry ranked above plain entry with same keyword', () => {
  withTmpDir((dir) => {
    // pageMap searches pages/ and projects/ subdirs; put both files there
    mkdirSync(join(dir, 'pages', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'decisions', '0001-use-bm25.md'), '# ADR\n');
    writeFileSync(join(dir, 'pages', 'bm25-notes.md'), '# BM25 Notes\n');
    const indexContent = [
      '# Index',
      '- [[decisions/0001-use-bm25]] — bm25 scoring decision adr',
      '- [[bm25-notes]] — bm25 scoring general notes',
    ].join('\n');
    writeFileSync(join(dir, 'index.md'), indexContent);
    const r = runHook('hypo-lookup.mjs', { prompt: 'bm25 scoring' }, { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    const ctx = out.additionalContext ?? '';
    const adrPos = ctx.indexOf('decisions/0001-use-bm25');
    const plainPos = ctx.indexOf('bm25-notes');
    assert.ok(adrPos !== -1, 'ADR entry should appear in context');
    assert.ok(adrPos < plainPos || plainPos === -1, 'ADR should rank before plain entry');
  });
});

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

// ── hypo-auto-minimal-crystallize.mjs (fix #27 PR-C, ADR 0022 Layer 3) ─────

suite('hypo-auto-minimal-crystallize.mjs — Stop chain replay');

function runAutoMinimal(dir, payload) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-minimal-crystallize.mjs')], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir },
  });
}

function writeTranscript(dir, lines) {
  const path = join(dir, '.cache', `transcript-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function writeSessionClosedMarkerFile(dir, sessionId, closedAt) {
  const path = join(dir, '.cache', `session-closed-${sessionId}.marker`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      session_id: sessionId,
      project: 'demo',
      closed_at: closedAt || new Date().toISOString(),
      verification: 'session-close-file-status:ok',
    }) + '\n',
  );
  return path;
}

test('replay-auto-minimal-crystallize-on-incomplete-close: hi-only transcript → continue', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', content: 'hi' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-trivial',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'no mutating tool_use → must continue');
    assert.equal(out.decision, undefined, 'must not block on trivial session');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: mutating + no marker + close-intent → block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', content: 'edit foo' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      // close-intent gate (2nd amendment): without an explicit wrap-up signal
      // the hook would silently continue. This user message trips isClosePattern.
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-substantial',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `must block, got: ${JSON.stringify(out)}`);
    assert.ok(
      /WIKI_AUTOCLOSE/.test(out.reason),
      `reason must mention WIKI_AUTOCLOSE: ${out.reason}`,
    );
    assert.ok(
      /\/hypo:crystallize/.test(out.reason),
      'reason must point at /hypo:crystallize skill',
    );
    assert.ok(out.reason.includes('s-substantial'), 'reason must embed the session_id to use');
  });
});

// 2nd amendment (close-intent gate): the core UX-regression fix from the
// codex 2-worker debate. A long mutating session with NO wrap-up signal must
// NOT be blocked on every turn.
test('replay-auto-minimal-crystallize-on-incomplete-close: mutating + no marker + NO close-intent → continue', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: '이 함수 좀 고쳐줘' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-midwork',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'mid-work session without close-intent must continue');
    assert.equal(out.decision, undefined, 'must NOT block mid-work (every-turn-block regression)');
  });
});

// False-positive guard: a generic completion phrase ("커밋했습니다", "작업 완료")
// is NOT a session-close signal. isClosePattern is deliberately low-FP.
test('replay-auto-minimal-crystallize-on-incomplete-close: generic "작업 완료" phrase → continue (no false-positive)', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: '이거 커밋했어? 작업 완료됐나 확인해줘' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-fp',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'generic completion phrase must not trip close-intent gate');
    assert.equal(out.decision, undefined);
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: stop_hook_active=true → continue + no marker write', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-loop',
      transcript_path: transcript,
      stop_hook_active: true,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'loop guard must continue');
    const markerPath = join(dir, '.cache', `session-closed-s-loop.marker`);
    assert.ok(!existsSync(markerPath), 'hook must NOT write marker on loop guard branch');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: valid marker → continue (even with close-intent)', () => {
  withGrowthWiki((dir) => {
    // Include close-intent so we exercise the marker gate (5), not the
    // close-intent gate (4) — proves a valid marker overrides a wrap-up signal.
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'MultiEdit', input: {} }] },
      },
      { type: 'user', message: { role: 'user', content: '세션 마무리하자' } },
    ]);
    writeSessionClosedMarkerFile(dir, 's-closed');
    const r = runAutoMinimal(dir, {
      session_id: 's-closed',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'valid marker → continue');
    assert.equal(out.decision, undefined);
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: stale marker → cleanup + block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      { type: 'user', message: { role: 'user', content: '세션 종료하자' } },
    ]);
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const markerPath = writeSessionClosedMarkerFile(dir, 's-stale', stale);
    const r = runAutoMinimal(dir, {
      session_id: 's-stale',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', 'stale marker must be discarded → block');
    assert.ok(!existsSync(markerPath), 'stale marker must be unlinked during read');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: corrupt marker → cleanup + block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      { type: 'user', message: { role: 'user', content: '오늘은 이만' } },
    ]);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const markerPath = join(dir, '.cache', `session-closed-s-corrupt.marker`);
    writeFileSync(markerPath, '{not valid json');
    const r = runAutoMinimal(dir, {
      session_id: 's-corrupt',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', 'corrupt marker must be discarded → block');
    assert.ok(!existsSync(markerPath), 'corrupt marker must be unlinked on read failure');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: missing transcript → continue (fail-open)', () => {
  withGrowthWiki((dir) => {
    const r = runAutoMinimal(dir, {
      session_id: 's-no-transcript',
      transcript_path: join(dir, '.cache', 'does-not-exist.jsonl'),
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'missing transcript → continue');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: HYPO_SKIP_GATE=1 → continue even with mutation+no marker', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
    ]);
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-minimal-crystallize.mjs')], {
      input: JSON.stringify({
        session_id: 's-bypass',
        transcript_path: transcript,
        stop_hook_active: false,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir, HYPO_SKIP_GATE: '1' },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'HYPO_SKIP_GATE=1 → continue');
  });
});

// ── crystallize.mjs --mark-session-closed (fix #27 PR-C) ───────────────────

suite('crystallize.mjs --mark-session-closed');

test('--mark-session-closed without --session-id → exit 1', () => {
  withTmpDir((dir) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--mark-session-closed', '--json']);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(/session-id/.test(out.error), `error must mention --session-id: ${out.error}`);
  });
});

test('--mark-session-closed with failing gate → exit 1, no marker', () => {
  withTmpDir((dir) => {
    // empty wiki — sessionCloseFileStatus will fail
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-failgate',
      '--json',
    ]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-failgate.marker')),
      'marker must not be written on failed gate',
    );
  });
});

// Codex pre-commit review BLOCKER (Worker-1): ADR Q2 says marker writer must
// require sessionCloseFileStatus.ok AND hypoIsClean.clean. Without the git
// check, a dirty wiki state would let a marker pass and unblock the Stop hook
// while close work is still uncommitted.
test('--mark-session-closed with ok gate but dirty git → exit 1, no marker (ADR Q2 regression)', () => {
  withWiki(null, (dir) => {
    // Introduce uncommitted change AFTER buildCleanWikiTree's commit.
    writeFileSync(join(dir, 'untracked.md'), 'dirty\n');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-dirty',
      '--json',
    ]);
    assert.equal(r.status, 1, `expected exit 1 on dirty git, stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.git_reason, `dirty-git result must carry git_reason: ${JSON.stringify(out)}`);
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-dirty.marker')),
      'marker must not land on dirty git',
    );
  });
});

// Codex pre-commit review CONCERN (both workers): writer success path was
// uncovered. Cover both writer entrypoints with a positive marker-creation
// assertion so a future change cannot silently break this path.
test('--mark-session-closed with ok gate + clean git → exit 0, marker created', () => {
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-success',
      '--json',
    ]);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.session_id, 's-success');
    const markerPath = join(dir, '.cache', 'session-closed-s-success.marker');
    assert.ok(existsSync(markerPath), 'marker file must be created on success');
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    assert.equal(marker.session_id, 's-success');
    assert.equal(marker.verification, 'session-close-file-status:ok');
    assert.ok(marker.closed_at, 'marker must carry closed_at timestamp');
  });
});

test('--apply-session-close --session-id leaves payload uncommitted → marker NOT written until git clean', () => {
  withWiki(null, (dir, today) => {
    const ym = today.slice(0, 7);
    const payload = {
      project: 'test-project',
      date: today,
      sessionState: {
        content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      },
      projectHot: {
        content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8'),
      },
      rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
      sessionLog: { entry: `## [${today}] auto-mark test\n` },
      log: { entry: `## [${today}] session | test-project — auto-mark\n` },
    };
    const payloadPath = join(dir, '.payload.json');
    writeFileSync(payloadPath, JSON.stringify(payload));
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      `--payload=${payloadPath}`,
      '--session-id=s-apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    // After apply, payload writes leave .payload.json + new file content
    // uncommitted — but the marker is written BEFORE that becomes a problem
    // because the post-apply branch happens inside the same process. The
    // assertion is just "marker file landed".
    const markerPath = join(dir, '.cache', 'session-closed-s-apply.marker');
    // git is "dirty" with payload bytes by the time hypoIsClean runs, so the
    // marker is intentionally NOT written in that branch. Document the
    // outcome rather than asserting marker presence.
    assert.equal(
      existsSync(markerPath),
      false,
      'apply leaves payload writes uncommitted → ADR Q2 git-clean gate skips marker until auto-commit lands',
    );
  });
});

// ── feedback-sync.mjs (ADR 0031, fix #37 Phase A) ─────────────────────────────

function fbPage(fields) {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${fm}\n---\nbody\n`;
}

// Build a wiki + claude-home pair, seed feedback pages, run feedback-sync.
// `pages` is { slug: fieldsObject }. Returns { dir, claudeHome, projectId, runFb(args) }.
function withFeedbackEnv(pages, fn, { claudeMd, memoryMd } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-fb-'));
  const wiki = join(base, 'wiki');
  const claudeHome = join(base, 'claude');
  const projectId = 'proj';
  const memDir = join(claudeHome, 'projects', projectId, 'memory');
  try {
    mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '# config');
    for (const [slug, fields] of Object.entries(pages)) {
      writeFileSync(join(wiki, 'pages', 'feedback', `${slug}.md`), fbPage(fields));
    }
    writeFileSync(
      join(claudeHome, 'CLAUDE.md'),
      claudeMd ?? '# Global\n<learned_behaviors>\n- manual entry\n</learned_behaviors>\n',
    );
    writeFileSync(join(memDir, 'MEMORY.md'), memoryMd ?? '# Memory Index\n');
    const runFb = (args) =>
      run('feedback-sync.mjs', [
        ...args,
        `--hypo-dir=${wiki}`,
        `--claude-home=${claudeHome}`,
        `--project-id=${projectId}`,
      ]);
    fn({ base, wiki, claudeHome, projectId, memDir, runFb });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const FB_GLOBAL_L1 = {
  title: 'Rule A',
  type: 'feedback',
  status: 'active',
  scope: 'global',
  tier: 'L1',
  targets: '[project-memory, claude-learned]',
  sensitivity: 'public',
  priority: 5,
  memory_summary: 'do A',
  global_summary: 'always do A',
  promote_to_global: true,
  reason: 'because A',
  source: 'session:2026-05-20',
  updated: '2026-05-20',
};

const FB_PROJECT_L2 = {
  title: 'Rule B',
  type: 'feedback',
  status: 'active',
  scope: 'project:hypomnema',
  tier: 'L2',
  targets: '[project-memory]',
  sensitivity: 'public',
  priority: 2,
  memory_summary: 'do B',
  reason: 'because B',
  source: 'session:2026-05-19',
  updated: '2026-05-19',
};

// ── hypo-personal-check.mjs — feedback projection gate (fix #37 Phase C) ──────
// The PreCompact gate runs `feedback-sync --check --strict`; projection drift
// must surface as a block, but only when PKG_ROOT resolves (a custom HOME with
// hypo-pkg.json). The single-blocking-gate invariant (spec §7.5) means this is
// integrated into hypo-personal-check, not a separate hook.
suite('hypo-personal-check.mjs — feedback projection gate (fix #37 Phase C)');

test('feedback projection drift → block names feedback projection', () => {
  withWiki(
    (dir) => {
      // A global-L1 page is a CLAUDE projection candidate; the controlled
      // CLAUDE.md below has an empty <learned_behaviors> with no managed region
      // yet, so `--check` sees the projection as stale → exit 1.
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      // Custom HOME so the hook's PKG_ROOT resolves (enabling the feedback
      // check) and the projection target is a controlled empty CLAUDE.md.
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-home-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        writeFileSync(
          join(home, '.claude', 'CLAUDE.md'),
          '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
        );
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
        assert.ok(
          out.reason.includes('feedback projection'),
          `block reason should name feedback projection: ${out.reason}`,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback gate: memory clean + missing CLAUDE.md → fail-open (no false block)', () => {
  // Regression (codex review): the prior `every(buildError)` predicate blocked
  // when the memory target was clean but the claude target only had a buildError
  // (e.g. ~/.claude/CLAUDE.md never created). With no feedback pages the memory
  // target has 0 candidates (clean) and the missing CLAUDE.md is benign — the
  // gate must fail-open, not report drift.
  withWiki(null, (dir) => {
    const home = mkdtempSync(join(tmpdir(), 'hypo-fbgate-home-'));
    try {
      const derivedId = process.cwd().replace(/[/.]/g, '-');
      const memDir = join(home, '.claude', 'projects', derivedId, 'memory');
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
      writeFileSync(join(memDir, 'MEMORY.md'), '# Memory Index\n');
      // intentionally NO CLAUDE.md → claude target buildError
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, true, `missing CLAUDE.md must not block: ${r.stdout}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

suite('feedback-sync.mjs — ADR 0031 / fix #37 Phase A');

test('feedback-sync-check-detects-drift: fresh projection targets are dirty → exit 1', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    const r = runFb(['--check', '--json']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.targets.claude.dirty, true);
    assert.equal(rep.targets.memory.dirty, true);
  });
});

test('feedback-sync-write-idempotent: second --write is byte-identical + post-check clean', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-b': FB_PROJECT_L2 },
    ({ claudeHome, memDir, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const claude1 = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const mem1 = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(claude1.includes('- manual entry'), 'manual entry must survive');
      assert.ok(claude1.includes('HYPO:FEEDBACK-SYNC:START source=rule-a'));
      assert.equal(runFb(['--write']).status, 0);
      assert.equal(
        readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8'),
        claude1,
        'CLAUDE.md not byte-identical',
      );
      assert.equal(
        readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'),
        mem1,
        'MEMORY.md not byte-identical',
      );
      assert.equal(runFb(['--check']).status, 0, 'post-write check must be clean');
    },
  );
});

test('feedback-sync-conflict-fails-without-merge: hand-edited block → exit 3, no overwrite', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    runFb(['--write']);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    assert.equal(runFb(['--check']).status, 3, 'check must report conflict');
    assert.equal(runFb(['--write']).status, 3, 'write must refuse');
    assert.ok(
      readFileSync(p, 'utf-8').includes('HAND EDITED'),
      'conflict block must not be auto-merged',
    );
  });
});

test('feedback-sync-scope-project-rejected-from-claude: project scope only reaches memory', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ runFb }) => {
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.claude.candidates, 0, 'scope:project:* must be rejected from CLAUDE');
    assert.equal(rep.targets.memory.candidates, 1, 'project scope still projects to memory');
  });
});

test('feedback-sync-over-cap-exits-2: >10 CLAUDE candidates → exit 2', () => {
  const pages = {};
  for (let i = 1; i <= 11; i++) {
    pages[`cap-${i}`] = {
      ...FB_GLOBAL_L1,
      title: `Cap ${i}`,
      global_summary: `g${i}`,
      memory_summary: `m${i}`,
    };
  }
  withFeedbackEnv(pages, ({ runFb }) => {
    const r = runFb(['--check', '--json']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).targets.claude.overCap, true);
  });
});

test('feedback-sync-write-atomic-on-conflict: stale target not written when another conflicts', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, memDir, runFb }) => {
    runFb(['--write']); // both projections clean now
    const memBefore = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    // make MEMORY genuinely stale (memory_summary change only affects MEMORY render)
    const pagePath = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(
      pagePath,
      readFileSync(pagePath, 'utf-8').replace('memory_summary: do A', 'memory_summary: do A v2'),
    );
    // create a CLAUDE conflict by hand-editing its managed block
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(cp, readFileSync(cp, 'utf-8').replace('always do A', 'HAND EDITED'));
    const r = runFb(['--write']);
    assert.equal(r.status, 3, `expected conflict exit 3, got ${r.status}: ${r.stderr}`);
    assert.equal(
      readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'),
      memBefore,
      'stale MEMORY must NOT be written when CLAUDE conflicts (atomicity)',
    );
  });
});

test('feedback-sync-intruder-in-region-refuses: hand line between blocks → exit 3, preserved', () => {
  withFeedbackEnv(
    {
      'rule-a': FB_GLOBAL_L1,
      'cap-x': { ...FB_GLOBAL_L1, title: 'X', global_summary: 'gx', memory_summary: 'mx' },
    },
    ({ claudeHome, runFb }) => {
      runFb(['--write']);
      const cp = join(claudeHome, 'CLAUDE.md');
      // inject a manual line between the two managed END/START boundaries
      const content = readFileSync(cp, 'utf-8').replace(
        '<!-- HYPO:FEEDBACK-SYNC:END -->\n<!-- HYPO:FEEDBACK-SYNC:START',
        '<!-- HYPO:FEEDBACK-SYNC:END -->\n- intruder line\n<!-- HYPO:FEEDBACK-SYNC:START',
      );
      writeFileSync(cp, content);
      assert.equal(runFb(['--check']).status, 3, 'intruder must be flagged');
      assert.equal(runFb(['--write']).status, 3, 'write must refuse with intruder present');
      assert.ok(
        readFileSync(cp, 'utf-8').includes('- intruder line'),
        'intruder must be preserved',
      );
    },
  );
});

test('feedback-sync-project-id-unknown-skips-memory: derived dir missing → no hard fail', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome }) => {
    const r = run('feedback-sync.mjs', [
      '--check',
      '--json',
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      `--cwd=${join(tmpdir(), 'no-such-cwd-xyz')}`,
    ]);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.projectIdResolved, false);
    assert.equal(rep.targets.memory, undefined, 'memory target skipped when project-id unresolved');
    assert.ok('claude' in rep.targets, 'claude target still evaluated');
  });
});

// ── codex review fixes (HIGH-1..4 / MEDIUM-1) ─────────────────────────────────

test('feedback-sync-crlf-block-idempotent: CRLF managed block is recognized, no duplicate region', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    runFb(['--write']);
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(cp, readFileSync(cp, 'utf-8').replace(/\n/g, '\r\n')); // simulate CRLF editor
    // must NOT treat CRLF block as "no blocks" and append a second region
    assert.equal(runFb(['--write']).status, 0);
    const after = readFileSync(cp, 'utf-8');
    const starts = (after.match(/HYPO:FEEDBACK-SYNC:START/g) || []).length;
    assert.equal(starts, 1, `CRLF block duplicated: ${starts} START markers`);
  });
});

test('feedback-sync-unpaired-marker-refuses: stray START marker → exit 3', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    runFb(['--write']);
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(
      cp,
      readFileSync(cp, 'utf-8') +
        '\n<!-- HYPO:FEEDBACK-SYNC:START source=ghost sha256=deadbeef -->\n',
    );
    assert.equal(runFb(['--check']).status, 3, 'unpaired START must be flagged');
    assert.equal(runFb(['--write']).status, 3, 'write must refuse with unpaired marker');
  });
});

test('feedback-sync-anchor-outside-container-ignored: region stays inside <learned_behaviors>', () => {
  // anchor placed OUTSIDE the container — must NOT be used as insertion point
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const open = c.indexOf('<learned_behaviors>');
      const close = c.indexOf('</learned_behaviors>');
      const block = c.indexOf('HYPO:FEEDBACK-SYNC:START');
      assert.ok(block > open && block < close, 'managed block must land inside the container');
      assert.ok(c.indexOf('ANCHOR') < open, 'out-of-container anchor must remain untouched');
    },
    {
      claudeMd:
        '# Global\n<!-- HYPO:FEEDBACK-SYNC:ANCHOR -->\n<learned_behaviors>\n- manual entry\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-missing-container-no-partial-write: MEMORY untouched when CLAUDE has no container', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, memDir, runFb }) => {
      const memBefore = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      const sideBefore = existsSync(join(memDir, 'feedback_rule-a.md'));
      const r = runFb(['--write']);
      assert.notEqual(r.status, 0, 'write must fail when CLAUDE lacks <learned_behaviors>');
      assert.equal(
        readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'),
        memBefore,
        'MEMORY index must NOT be written (atomic preflight)',
      );
      assert.equal(
        existsSync(join(memDir, 'feedback_rule-a.md')),
        sideBefore,
        'MEMORY side-file must NOT be written',
      );
    },
    { claudeMd: '# Global\n(no learned_behaviors block here)\n' },
  );
});

test('feedback-sync-zero-candidate-idempotent: no candidates → --write does not grow the file', () => {
  // a page that matches NO target (status archived) → zero candidates
  withFeedbackEnv(
    { 'rule-x': { ...FB_GLOBAL_L1, status: 'archived' } },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c1 = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.equal(runFb(['--write']).status, 0);
      const c2 = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.equal(c1, c2, 'zero-candidate --write must be byte-identical (no appended newline)');
      assert.ok(!c1.includes('HYPO:FEEDBACK-SYNC'), 'no managed block when no candidates');
    },
  );
});

test('feedback-sync-stale-side-file-removed: demoting a page deletes its feedback_<slug>.md copy', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, memDir, runFb }) => {
    runFb(['--write']);
    assert.ok(existsSync(join(memDir, 'feedback_rule-a.md')), 'side-file created on first write');
    // demote: flip status to archived so the page is no longer a candidate
    const pagePath = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(
      pagePath,
      readFileSync(pagePath, 'utf-8').replace('status: active', 'status: archived'),
    );
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(
      !existsSync(join(memDir, 'feedback_rule-a.md')),
      'stale side-file must be removed when page is demoted',
    );
  });
});

// ── second-pass review fixes (HIGH cap / HIGH provenance / MEDIUM container / LOW) ──

test('feedback-sync-stale-skips-non-sync-file: hand-written feedback_*.md is NOT deleted', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ memDir, runFb }) => {
    // a user's own memory file with the same naming pattern but no provenance header
    const manual = join(memDir, 'feedback_my_manual_note.md');
    writeFileSync(manual, '# my own note, not from sync\n');
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(existsSync(manual), 'non-sync (no provenance header) file must be preserved');
    // and the generated one carries the provenance header
    assert.ok(
      readFileSync(join(memDir, 'feedback_rule-a.md'), 'utf-8').startsWith(
        '<!-- HYPO:FEEDBACK-SYNC source=',
      ),
      'generated side-file must carry provenance header',
    );
  });
});

test('feedback-sync-memory-cap-counts-index-lines-only: 100 one-line entries not over-cap', () => {
  const pages = {};
  for (let i = 1; i <= 100; i++) {
    // project-scoped → MEMORY only (not CLAUDE), one-line index entry each
    pages[`m-${i}`] = { ...FB_PROJECT_L2, title: `M ${i}`, memory_summary: `s${i}` };
  }
  withFeedbackEnv(pages, ({ runFb }) => {
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.memory.candidates, 100);
    assert.equal(
      rep.targets.memory.overCap,
      false,
      '100 one-line index entries (< 200) must not over-cap (markers excluded)',
    );
  });
});

test('feedback-sync-block-outside-container-refuses: managed block outside <learned_behaviors> → exit 3', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      assert.equal(runFb(['--check']).status, 3, 'block outside container must be flagged');
      assert.equal(runFb(['--write']).status, 3, 'write must refuse');
    },
    {
      // a managed block sitting BEFORE the container (drifted/hand-moved)
      claudeMd:
        '# Global\n<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=' +
        '0'.repeat(64) +
        ' -->\n- stray\n<!-- HYPO:FEEDBACK-SYNC:END -->\n<learned_behaviors>\n- manual\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-marker-in-prose-not-counted: mid-line marker text does not trip unpaired', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      // a clean write must still succeed; the prose mention must not be seen as a marker
      assert.equal(runFb(['--write']).status, 0, 'mid-line marker-looking text must be ignored');
    },
    {
      claudeMd:
        '# Global\nExample doc: <!-- HYPO:FEEDBACK-SYNC:START source=x --> appears mid-line here.\n<learned_behaviors>\n- manual\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-write-strict-refuses-before-write: strict warning blocks the write', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, priv: { ...FB_PROJECT_L2, sensitivity: 'private' } },
    ({ claudeHome, runFb }) => {
      const before = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const r = runFb(['--write', '--strict']);
      assert.notEqual(r.status, 0, 'strict warning (private page) must fail');
      assert.equal(
        readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8'),
        before,
        'strict --write must NOT write before failing',
      );
    },
  );
});

// ── doctor.mjs — feedback projection (fix #37 #9) ────────────────────────────

// Build a wiki + claude-home with feedback pages, then run doctor wired to the
// same --claude-home/--project-id used by feedback-sync. Returns the parsed
// `Feedback projection` check entries (doctor's other checks fire on the
// synthetic wiki, so assert on the entry, not the process exit code).
function withDoctorFeedbackEnv(pages, fn, { claudeMd, memoryMd } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-doc-fb-'));
  const wiki = join(base, 'wiki');
  const claudeHome = join(base, 'claude');
  const projectId = 'proj';
  const memDir = join(claudeHome, 'projects', projectId, 'memory');
  try {
    mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '# config');
    for (const [slug, fields] of Object.entries(pages)) {
      writeFileSync(join(wiki, 'pages', 'feedback', `${slug}.md`), fbPage(fields));
    }
    writeFileSync(
      join(claudeHome, 'CLAUDE.md'),
      claudeMd ?? '# Global\n<learned_behaviors>\n- manual entry\n</learned_behaviors>\n',
    );
    writeFileSync(join(memDir, 'MEMORY.md'), memoryMd ?? '# Memory Index\n');
    const runFb = (args) =>
      run('feedback-sync.mjs', [
        ...args,
        `--hypo-dir=${wiki}`,
        `--claude-home=${claudeHome}`,
        `--project-id=${projectId}`,
      ]);
    const runDoctor = () => {
      const r = run('doctor.mjs', [
        `--hypo-dir=${wiki}`,
        `--claude-home=${claudeHome}`,
        `--project-id=${projectId}`,
        '--json',
      ]);
      const checks = JSON.parse(r.stdout);
      return {
        r,
        checks,
        fb: checks.filter((c) => c.label.startsWith('Feedback projection')),
      };
    };
    fn({ base, wiki, claudeHome, projectId, memDir, runFb, runDoctor });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

suite('doctor.mjs — feedback projection (fix #37 #9)');

test('clean (post --write) projection → pass, no fail entry', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb, runDoctor }) => {
    assert.equal(runFb(['--write']).status, 0, 'seed write must succeed');
    const { fb } = runDoctor();
    assert.ok(fb.length >= 1, 'expected a Feedback projection check entry');
    assert.ok(
      fb.every((c) => c.status !== 'fail'),
      `clean projection must not fail: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      fb.some((c) => c.status === 'pass' && c.label === 'Feedback projection'),
      `clean projection should pass: ${JSON.stringify(fb)}`,
    );
  });
});

test('no feedback pages → pass with "no projection candidates"', () => {
  withDoctorFeedbackEnv({}, ({ runDoctor }) => {
    const { fb } = runDoctor();
    assert.ok(
      fb.some((c) => c.status === 'pass' && c.detail.includes('no projection candidates')),
      `expected no-candidates pass: ${JSON.stringify(fb)}`,
    );
  });
});

test('drifted projection (never written) → warn, never fail', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runDoctor }) => {
    const { fb } = runDoctor();
    assert.ok(
      fb.every((c) => c.status !== 'fail'),
      `drift must be warn not fail: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      fb.some((c) => c.status === 'warn' && c.detail.includes('feedback-sync --write')),
      `expected stale-projection warn: ${JSON.stringify(fb)}`,
    );
  });
});

test('tampered managed block (conflict) → fail Feedback projection integrity', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb, claudeHome, runDoctor }) => {
    runFb(['--write']);
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(cp, readFileSync(cp, 'utf-8').replace('always do A', 'HAND EDITED'));
    const { r, fb } = runDoctor();
    assert.ok(
      fb.some((c) => c.status === 'fail' && c.label === 'Feedback projection integrity'),
      `conflict must fail: ${JSON.stringify(fb)}`,
    );
    assert.equal(r.status, 1, 'doctor exits 1 when any check fails');
  });
});

// ── feedback-sync.mjs — project-id fallback (fix #37 #10) ─────────────────────

suite('feedback-sync.mjs — project-id fallback (fix #37 #10)');

// Non-TTY / hook / CI path: derived dir missing → skip MEMORY, exit 0, NO prompt,
// NO hang. The child has no controlling TTY under spawnSync, so this IS the
// non-interactive proof. --no-input makes it explicit + belt-and-suspenders.
test('feedback-sync-no-input-non-tty: derived-missing project-id skips MEMORY, exit 0, no hang', () => {
  // MEMORY-only fixture (project-scoped, no CLAUDE candidate) so the clean run
  // genuinely exits 0 — proving the non-TTY skip path AND a clean exit code.
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome }) => {
    const r = run('feedback-sync.mjs', [
      '--check',
      '--no-input',
      '--json',
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      `--cwd=${join(tmpdir(), 'no-such-cwd-xyz')}`,
    ]);
    // spawnSync returns (no timeout), proving the non-TTY path never blocks.
    assert.equal(r.signal, null, 'process must exit on its own (no hang/kill)');
    assert.equal(r.status, 0, `clean MEMORY-only run must exit 0: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.projectIdResolved, false);
    assert.equal(rep.skipMemory, true, 'skipMemory flag surfaced in report');
    assert.equal(rep.targets.memory, undefined, 'MEMORY skipped on unresolved project-id');
    assert.ok('claude' in rep.targets, 'claude target still evaluated');
  });
});

// --strict must NOT escalate the skip-MEMORY warning. A fresh / external user
// whose ~/.claude/projects/<id>/memory does not exist yet runs the PreCompact
// gate (#3: `--check --strict`); contract §5 step 4 promises this never hard-
// fails. skipMemory is an environmental state, not actionable drift.
test('feedback-sync-strict-does-not-escalate-skip-memory: derived-missing + --strict → exit 0', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome }) => {
    const r = run('feedback-sync.mjs', [
      '--check',
      '--strict',
      '--no-input',
      '--json',
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      `--cwd=${join(tmpdir(), 'no-such-cwd-xyz')}`,
    ]);
    assert.equal(r.signal, null, 'process must exit on its own (no hang)');
    assert.equal(r.status, 0, `skip-MEMORY warning must not be escalated by --strict: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.skipMemory, true, 'skipMemory still surfaced in report');
  });
});

// Explicit --project-id always wins, no prompt, MEMORY present even on TTY-less run.
test('feedback-sync-explicit-project-id-wins: MEMORY target present, no prompt path', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    const r = runFb(['--check', '--json']); // withFeedbackEnv passes a valid --project-id
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.projectIdResolved, true);
    assert.equal(rep.skipMemory, undefined, 'no skip for explicit project-id');
    assert.ok('memory' in rep.targets, 'MEMORY target present for explicit project-id');
  });
});

// ── feedback-sync.mjs — bootstrap + import (fix #37 Phase D) ──────────────────

suite('feedback-sync.mjs — bootstrap + import (fix #37 Phase D)');

test('feedback-sync-bootstrap-creates-drafts: legacy surfaces → _drafts scaffolds, idempotent', () => {
  const claudeMd =
    '# Global\n<learned_behaviors>\n' +
    '- [2026-05-20] always run the formatter before commit — 이유: consistency\n' +
    '- [2026-05-19] push after every wiki commit — 이유: hook only pushes staged\n' +
    '</learned_behaviors>\n';
  const memoryMd =
    '# Memory Index\n' +
    '- [Teams usage](feedback_omc_teams_usage.md) — heavy tasks use teams\n' +
    '- [Plain note](some_other_note.md) — not a feedback projection (skipped)\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const r = runFb(['--bootstrap', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const rep = JSON.parse(r.stdout);
      // 2 learned_behaviors + 1 feedback_* memory entry = 3; non-feedback_ entry ignored
      assert.equal(rep.created.length, 3, `expected 3 drafts, got ${rep.created.length}`);
      const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
      const files = readdirSync(draftsDir);
      assert.ok(
        files.some((f) => f.startsWith('legacy-claude-20260520-')),
        'claude draft slug',
      );
      assert.ok(files.includes('omc-teams-usage.md'), 'memory slug: feedback_ stripped, _→-');
      assert.ok(!files.some((f) => f.includes('some-other-note')), 'non-feedback_ entry skipped');
      const draft = readFileSync(join(draftsDir, 'omc-teams-usage.md'), 'utf-8');
      assert.ok(draft.startsWith('<!-- HYPO:FEEDBACK-SYNC:DRAFT'), 'provenance marker present');
      assert.ok(/^type: feedback$/m.test(draft) && /^scope:/m.test(draft), 'frontmatter scaffold');
      // idempotent: second run creates nothing, all skipped as draft-exists
      const r2 = JSON.parse(runFb(['--bootstrap', '--json']).stdout);
      assert.equal(r2.created.length, 0, 'second bootstrap creates nothing');
      assert.ok(
        r2.skipped.length >= 3 && r2.skipped.every((s) => s.reason === 'draft-exists'),
        'all skipped as draft-exists',
      );
    },
    { claudeMd, memoryMd },
  );
});

test('feedback-sync-bootstrap-dry-run-writes-nothing: --dry-run reports but creates no files', () => {
  const claudeMd =
    '# Global\n<learned_behaviors>\n- [2026-05-20] a rule — 이유: x\n</learned_behaviors>\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const rep = JSON.parse(runFb(['--bootstrap', '--dry-run', '--json']).stdout);
      assert.equal(rep.dryRun, true);
      assert.ok(rep.created.length >= 1, 'dry-run still reports planned drafts');
      assert.ok(!existsSync(join(wiki, 'pages', 'feedback', '_drafts')), 'no _drafts dir written');
    },
    { claudeMd },
  );
});

test('feedback-sync-import-target-change: hand-edited block → draft, SoT page untouched', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    runFb(['--write']); // project rule-a into CLAUDE.md
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED externally'));
    assert.equal(runFb(['--check']).status, 3, 'precondition: conflict detected');
    const r = runFb(['--import-target-change', '--from=claude', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.imported.length, 1);
    assert.equal(rep.imported[0].slug, 'rule-a');
    const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
    const f = readdirSync(draftsDir).find((x) => x.startsWith('rule-a.import-'));
    assert.ok(f, 'import draft created with import-<date> suffix');
    assert.ok(
      readFileSync(join(draftsDir, f), 'utf-8').includes('HAND EDITED externally'),
      'draft captures the hand-edited content',
    );
    assert.ok(
      !readFileSync(join(wiki, 'pages', 'feedback', 'rule-a.md'), 'utf-8').includes('HAND EDITED'),
      'pages/feedback/rule-a.md (SoT) must not be modified',
    );
  });
});

test('feedback-sync-import-no-conflict-noop: clean target imports nothing, exit 0', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    runFb(['--write']);
    const r = runFb(['--import-target-change', '--from=claude', '--json']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).imported.length, 0, 'no conflict → nothing imported');
  });
});

test('feedback-sync-import-bad-from-errors: missing/invalid --from → exit 1', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    assert.equal(runFb(['--import-target-change']).status, 1, 'missing --from rejected');
    assert.equal(
      runFb(['--import-target-change', '--from=bogus']).status,
      1,
      'invalid --from rejected',
    );
  });
});

test('feedback-sync-bootstrap-traversal-slug-stays-in-drafts: MEMORY ../ neutralized, pure-dots rejected', () => {
  // codex BLOCKER regression: a crafted `feedback_../escaped.md` must NOT escape
  // _drafts into pages/feedback/. basename() collapses traversal to the final
  // segment; a slug that reduces to nothing (`..`) is rejected as unsafe-slug.
  const memoryMd =
    '# Memory Index\n' +
    '- [Evil](feedback_../escaped.md) — traversal collapses to basename\n' +
    '- [Dots](feedback_...md) — reduces to nothing, rejected\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const rep = JSON.parse(runFb(['--bootstrap', '--json']).stdout);
      assert.ok(
        !existsSync(join(wiki, 'pages', 'feedback', 'escaped.md')),
        'must not escape into pages/feedback/',
      );
      assert.ok(
        existsSync(join(wiki, 'pages', 'feedback', '_drafts', 'escaped.md')),
        'traversal neutralized to a draft under _drafts',
      );
      assert.ok(
        rep.skipped.some((s) => s.reason === 'unsafe-slug'),
        'pure-dots slug rejected as unsafe-slug',
      );
    },
    { memoryMd },
  );
});

test('feedback-sync-bootstrap-skips-managed-memory-block: projected MEMORY entries not re-drafted', () => {
  // codex IMPORTANT regression: parseMemoryIndex must scrub HYPO:FEEDBACK-SYNC
  // managed regions (parity with parseLearnedBehaviors) so already-projected
  // index lines are not resurrected as legacy drafts.
  const memoryMd =
    '# Memory Index\n' +
    `<!-- HYPO:FEEDBACK-SYNC:START source=managed-x sha256=${'a'.repeat(64)} -->\n` +
    '- [Managed X](feedback_managed_x.md) — already projected\n' +
    '<!-- HYPO:FEEDBACK-SYNC:END -->\n' +
    '- [Loose Y](feedback_loose_y.md) — legacy hand entry\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      runFb(['--bootstrap']);
      const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
      const drafts = existsSync(draftsDir) ? readdirSync(draftsDir) : [];
      assert.ok(drafts.includes('loose-y.md'), 'loose legacy MEMORY entry is drafted');
      assert.ok(!drafts.includes('managed-x.md'), 'managed-block entry must NOT be re-drafted');
    },
    { memoryMd },
  );
});

test('feedback-sync-import-traversal-source-stays-in-drafts: tampered source= neutralized', () => {
  // codex BLOCKER regression: a tampered `source=../escaped` managed marker must
  // not let --import write outside _drafts.
  const claudeMd =
    '# Global\n<learned_behaviors>\n' +
    `<!-- HYPO:FEEDBACK-SYNC:START source=../escaped sha256=${'0'.repeat(64)} -->\n` +
    'tampered inner content\n' +
    '<!-- HYPO:FEEDBACK-SYNC:END -->\n' +
    '</learned_behaviors>\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const r = runFb(['--import-target-change', '--from=claude', '--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        !readdirSync(join(wiki, 'pages', 'feedback')).some((f) => f.includes('escaped')),
        'nothing named escaped at pages/feedback top level',
      );
      assert.ok(
        readdirSync(join(wiki, 'pages', 'feedback', '_drafts')).some((f) =>
          f.startsWith('escaped.import-claude-'),
        ),
        'tampered source neutralized into _drafts',
      );
    },
    { claudeMd },
  );
});

test('feedback-sync-import-no-clobber: re-import same day preserves the prior draft', () => {
  // codex IMPORTANT regression: a same-day re-import (or human-edited draft) must
  // not be overwritten — the writer picks a collision-free numbered name.
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    runFb(['--write']);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    runFb(['--import-target-change', '--from=claude']);
    const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
    const first = readdirSync(draftsDir).find((x) => x.startsWith('rule-a.import-claude-'));
    writeFileSync(join(draftsDir, first), 'HUMAN RECONCILED');
    runFb(['--import-target-change', '--from=claude']); // second import, same day
    assert.equal(
      readFileSync(join(draftsDir, first), 'utf-8'),
      'HUMAN RECONCILED',
      'prior (human-edited) draft must be preserved',
    );
    assert.equal(
      readdirSync(draftsDir).filter((x) => x.startsWith('rule-a.import-claude-')).length,
      2,
      'second import created a new numbered draft, not a clobber',
    );
  });
});

test('feedback-sync-existing-9-pages-pass-new-schema: schema-complete pages lint green + parse', () => {
  // 9 schema-complete feedback pages (mirroring the canonical frontmatter the
  // real wiki ships) must pass the new feedback conditional-required lint AND be
  // parsed by feedback-sync without error. Hermetic — no dependency on ~/hypomnema
  // (§8.13 verification #4 dogfooding, expressed as a hermetic regression guard).
  const pages = {};
  for (let i = 1; i <= 7; i++)
    pages[`global-${i}`] = {
      ...FB_GLOBAL_L1,
      title: `Global ${i}`,
      global_summary: `g${i}`,
      memory_summary: `m${i}`,
    };
  for (let i = 1; i <= 2; i++)
    pages[`proj-${i}`] = { ...FB_PROJECT_L2, title: `Proj ${i}`, memory_summary: `pm${i}` };
  withFeedbackEnv(pages, ({ wiki, runFb }) => {
    const lint = run('lint.mjs', [`--hypo-dir=${wiki}`]);
    assert.equal(
      lint.status,
      0,
      `lint must pass schema-complete feedback pages:\n${lint.stdout}${lint.stderr}`,
    );
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.claude.candidates, 7, 'L1 global pages reach CLAUDE');
    assert.equal(rep.targets.memory.candidates, 9, 'all 9 reach MEMORY');
  });
});

// Injected-prompt unit tests: drive resolveProjectId() directly with isTTY:true
// and a fake prompt, exercising the interactive branches without a real TTY.
await testAsync(
  'resolveProjectId: explicit --project-id resolves without calling prompt',
  async () => {
    let called = false;
    const r = await fbResolveProjectId(
      { projectId: 'explicit-id', claudeHome: '/no/such', cwd: '/x', noInput: false },
      {
        isTTY: true,
        prompt: () => {
          called = true;
          return { action: 'confirm' };
        },
      },
    );
    assert.equal(r.id, 'explicit-id');
    assert.equal(r.skipMemory, false);
    assert.equal(called, false, 'explicit project-id must not prompt');
  },
);

await testAsync('resolveProjectId: derived dir exists resolves without prompting', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hypo-rpid-'));
  try {
    const claudeHome = join(base, 'claude');
    const id = '-x'; // matches cwd "/x" → "/x".replace(/[/.]/g,'-') === "-x"
    mkdirSync(join(claudeHome, 'projects', id), { recursive: true });
    const r = await fbResolveProjectId(
      { projectId: null, claudeHome, cwd: '/x', noInput: false },
      {
        isTTY: true,
        prompt: () => {
          throw new Error('prompt must not be called when derived dir exists');
        },
      },
    );
    assert.equal(r.id, id);
    assert.equal(r.exists, true);
    assert.equal(r.skipMemory, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

await testAsync(
  'resolveProjectId: prompt "confirm" accepts derived id, MEMORY not skipped',
  async () => {
    const r = await fbResolveProjectId(
      { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
      { isTTY: true, prompt: () => ({ action: 'confirm' }) },
    );
    assert.equal(r.id, '-some-path');
    assert.equal(r.skipMemory, false, 'confirm includes MEMORY despite missing dir');
  },
);

await testAsync('resolveProjectId: prompt "id" returns chosen id, MEMORY not skipped', async () => {
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
    { isTTY: true, prompt: () => ({ action: 'id', id: 'chosen-id' }) },
  );
  assert.equal(r.id, 'chosen-id');
  assert.equal(r.derived, false, 'user-entered id is treated as explicit');
  assert.equal(r.skipMemory, false, 'chosen id still projects MEMORY (created on --write)');
});

await testAsync('resolveProjectId: prompt "skip" sets skipMemory', async () => {
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
    { isTTY: true, prompt: () => ({ action: 'skip' }) },
  );
  assert.equal(r.skipMemory, true);
});

await testAsync('resolveProjectId: --no-input never prompts even with isTTY true', async () => {
  let called = false;
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: true },
    {
      isTTY: true,
      prompt: () => {
        called = true;
        return { action: 'confirm' };
      },
    },
  );
  assert.equal(called, false, '--no-input must short-circuit before prompting');
  assert.equal(r.skipMemory, true);
});

await testAsync('resolveProjectId: non-TTY never prompts (hook/CI safety)', async () => {
  let called = false;
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
    {
      isTTY: false,
      prompt: () => {
        called = true;
        return { action: 'confirm' };
      },
    },
  );
  assert.equal(called, false, 'non-TTY must never call prompt');
  assert.equal(r.skipMemory, true);
});

// ── integration-review fixes (entry guard, doctor project-id) ────────────────

suite('feedback-sync.mjs / doctor.mjs — integration review fixes (fix #37)');

test('feedback-sync-entry-guard-tolerates-space-in-path: CLI runs, not a silent no-op', () => {
  // a path with a space: raw `file://${argv[1]}` mismatches the percent-encoded
  // import.meta.url, so the pre-fix entry guard skipped main() and exited 0 silently.
  const base = mkdtempSync(join(tmpdir(), 'hypo fb space-'));
  try {
    cpSync(SCRIPTS, join(base, 'scripts'), { recursive: true }); // incl. lib/ for relative imports
    const wiki = join(base, 'wiki');
    mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '# config');
    const r = spawnSync(
      process.execPath,
      [
        join(base, 'scripts', 'feedback-sync.mjs'),
        '--check',
        '--json',
        '--no-input',
        `--hypo-dir=${wiki}`,
        `--claude-home=${join(base, 'claude')}`,
        `--cwd=${join(tmpdir(), 'no-such-cwd')}`,
      ],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
    );
    assert.ok(
      r.stdout.trim().length > 0,
      `CLI must produce output even from a spaced path (entry guard): ${JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr })}`,
    );
    const rep = JSON.parse(r.stdout);
    assert.ok('claude' in rep.targets, 'a real report must be produced');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor-derived-missing-project-id: unresolved warn, not a misleading stale warn', () => {
  withDoctorFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome }) => {
    // run doctor from a cwd whose derived project dir does not exist, WITHOUT
    // --project-id — doctor must forward neither, letting feedback-sync skip MEMORY.
    const noCwd = mkdtempSync(join(tmpdir(), 'hypo-doc-nocwd-'));
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'doctor.mjs'), `--hypo-dir=${wiki}`, `--claude-home=${claudeHome}`, '--json'],
      {
        encoding: 'utf-8',
        cwd: noCwd,
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    rmSync(noCwd, { recursive: true, force: true });
    const fb = JSON.parse(r.stdout).filter((c) => c.label.startsWith('Feedback projection'));
    assert.ok(
      fb.some((c) => c.status === 'warn' && /unresolved|skipped/i.test(c.detail || '')),
      `expected unresolved/skipped warn: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      !fb.some((c) => /feedback-sync --write/.test(c.detail || '')),
      `must NOT emit a stale-projection warn when project-id is unresolved: ${JSON.stringify(fb)}`,
    );
  });
});

// ── feedback.mjs — /hypo:feedback page writer (fix #37 Phase C) ───────────────
// feedback.mjs must emit lint #8-complete frontmatter so the page is a valid
// projection SoT, and must reject incomplete classification rather than write a
// page lint would later block. --no-sync keeps these tests from touching
// ~/.claude (the projection post-step is exercised manually / in feedback-sync).
suite('feedback.mjs — /hypo:feedback page writer (fix #37 Phase C)');

function withFeedbackWriterWiki(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-fbw-'));
  try {
    mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('feedback.mjs create: full classification → page written + lint-clean', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=test-rule',
      '--entry=항상 X를 한다.',
      '--scope=global',
      '--tier=L1',
      '--targets=project-memory,claude-learned',
      '--priority=4',
      '--memory-summary=X를 항상 수행',
      '--global-summary=항상 X 수행',
      '--promote-to-global',
      '--reason=Y 실수 방지',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `feedback create failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'test-rule.md'), 'utf-8');
    for (const f of [
      'type: feedback',
      'status: active',
      'scope: global',
      'tier: L1',
      'targets: [project-memory, claude-learned]',
      'sensitivity: public',
      'priority: 4',
      'memory_summary:',
      'global_summary:',
      'promote_to_global: true',
      'reason:',
      'source:',
    ]) {
      assert.ok(page.includes(f), `frontmatter missing "${f}":\n${page}`);
    }
    // lint #8 must accept the generated page (zero errors)
    const lint = run('lint.mjs', ['--json', `--hypo-dir=${dir}`]);
    const report = JSON.parse(lint.stdout);
    assert.equal(report.errors.length, 0, `lint errors on generated page: ${lint.stdout}`);
  });
});

test('feedback.mjs create: projection post-step targets --claude-home (no ~/.claude touch)', () => {
  withFeedbackWriterWiki((dir) => {
    // Isolated projection target: --claude-home keeps the post-step out of the
    // real ~/.claude. Proves the auto `feedback-sync --write` runs and projects.
    const cHome = mkdtempSync(join(tmpdir(), 'hypo-fbw-claude-'));
    try {
      mkdirSync(join(cHome, 'projects', 'pid', 'memory'), { recursive: true });
      writeFileSync(
        join(cHome, 'CLAUDE.md'),
        '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
      );
      writeFileSync(join(cHome, 'projects', 'pid', 'memory', 'MEMORY.md'), '# Memory Index\n');
      const r = run('feedback.mjs', [
        '--topic=proj-rule',
        '--entry=항상 P를 한다.',
        '--scope=global',
        '--tier=L1',
        '--targets=project-memory,claude-learned',
        '--priority=5',
        '--memory-summary=P 수행',
        '--global-summary=항상 P',
        '--promote-to-global',
        '--reason=Q 방지',
        `--claude-home=${cHome}`,
        '--project-id=pid',
        `--hypo-dir=${dir}`,
      ]);
      assert.equal(r.status, 0, `feedback create+sync failed: ${r.stderr}`);
      const claudeMd = readFileSync(join(cHome, 'CLAUDE.md'), 'utf-8');
      assert.ok(
        claudeMd.includes('HYPO:FEEDBACK-SYNC:START source=proj-rule'),
        `projection should write a managed block:\n${claudeMd}`,
      );
    } finally {
      rmSync(cHome, { recursive: true, force: true });
    }
  });
});

test('feedback.mjs create: missing --memory-summary → exit 1, no page', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=incomplete',
      '--entry=무언가',
      '--scope=global',
      '--tier=L2',
      '--targets=project-memory',
      '--reason=이유',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 1, 'incomplete classification must fail');
    assert.ok(/memory-summary/.test(r.stderr), `error should name the missing field: ${r.stderr}`);
    assert.ok(
      !existsSync(join(dir, 'pages', 'feedback', 'incomplete.md')),
      'no page should be written on validation failure',
    );
  });
});

test('feedback.mjs create: claude-learned with project scope → exit 1 (ADR 0031 §6)', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=mis-scoped',
      '--entry=무언가',
      '--scope=project:foo',
      '--tier=L1',
      '--targets=project-memory,claude-learned',
      '--priority=3',
      '--memory-summary=요약',
      '--global-summary=전역요약',
      '--promote-to-global',
      '--reason=이유',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 1, 'claude-learned requires scope=global');
    assert.ok(/scope=global/.test(r.stderr), `error should explain the §6 filter: ${r.stderr}`);
  });
});

test('feedback.mjs create: newline in a scalar cannot inject a frontmatter key', () => {
  // Regression (codex review): raw interpolation let a value with an embedded
  // newline forge a frontmatter key (e.g. reason="legit\nstatus: archived").
  // oneLine() collapses whitespace so the injected text stays on the value line.
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=inject',
      '--entry=rule body',
      '--scope=global',
      '--tier=L2',
      '--targets=project-memory',
      '--priority=3',
      '--memory-summary=ok',
      '--reason=legit\nstatus: archived',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `create failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'inject.md'), 'utf-8');
    const fm = page.split('---')[1];
    assert.ok(/^status: active$/m.test(fm), 'real status must stay active');
    assert.ok(!/^status: archived$/m.test(fm), 'injected key must NOT appear as its own line');
    assert.ok(/^reason: legit status: archived$/m.test(fm), 'newline collapsed into the value');
  });
});

test('feedback.mjs append: bumpUpdated leaves a body "updated:" line untouched', () => {
  // Regression (codex review): a multiline replace would rewrite a body line
  // starting with "updated:". bumpUpdated must only touch the frontmatter fence.
  withFeedbackWriterWiki((dir) => {
    const p = join(dir, 'pages', 'feedback', 'existing.md');
    writeFileSync(
      p,
      '---\ntitle: x\ntype: feedback\nupdated: 2020-01-01\n---\n\n# x\n\nupdated: 2019-12-31 (body line)\n',
    );
    const r = run('feedback.mjs', [
      '--topic=existing',
      '--entry=new dated entry',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `append failed: ${r.stderr}`);
    const out = readFileSync(p, 'utf-8');
    assert.ok(out.includes('updated: 2019-12-31 (body line)'), 'body updated: line preserved');
    const today = new Date().toISOString().slice(0, 10);
    const fm = out.split('\n---')[0];
    assert.ok(
      new RegExp(`^updated: ${today}$`, 'm').test(fm),
      'frontmatter updated bumped to today',
    );
  });
});

// ── version-check (update notifier) ──────────────────────────────────────────

const vc = await import(`${REPO}/hooks/version-check.mjs`);

test('compareSemver: basic ordering', () => {
  assert.equal(vc.compareSemver('1.0.0', '1.0.1'), -1);
  assert.equal(vc.compareSemver('1.2.0', '1.1.9'), 1);
  assert.equal(vc.compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(vc.compareSemver('v1.1.0', '1.1.0'), 0); // tolerate leading v
});

test('compareSemver: release outranks prerelease, build metadata ignored', () => {
  assert.equal(vc.compareSemver('1.2.3-rc.1', '1.2.3'), -1);
  assert.equal(vc.compareSemver('1.2.3', '1.2.3-rc.1'), 1);
  assert.equal(vc.compareSemver('1.2.3+build9', '1.2.3'), 0);
});

test('compareSemver: invalid input returns null', () => {
  assert.equal(vc.compareSemver('not-a-version', '1.0.0'), null);
  assert.equal(vc.compareSemver('1.0.0', ''), null);
  assert.equal(vc.compareSemver('1.0', '1.0.0'), null);
});

test('detectChannel: npm / plugin / unknown', () => {
  assert.equal(vc.detectChannel('/usr/local/lib/node_modules/hypomnema'), 'npm');
  assert.equal(vc.detectChannel('/Users/x/.claude/plugins/cache/hypomnema'), 'plugin');
  assert.equal(vc.detectChannel('/Users/x/Workspace/hypomnema'), 'unknown');
  assert.equal(vc.detectChannel(''), 'unknown');
  assert.equal(vc.detectChannel(undefined), 'unknown');
});

test('detectChannel: plugin path containing node_modules still resolves to plugin', () => {
  assert.equal(
    vc.detectChannel('/Users/x/.claude/plugins/cache/hypomnema/node_modules/foo'),
    'plugin',
  );
});

test('buildUpdateLine: channel-specific update command', () => {
  assert.match(vc.buildUpdateLine('npm', '1.0.0', '1.1.0'), /npm install -g hypomnema/);
  assert.match(
    vc.buildUpdateLine('plugin', '1.0.0', '1.1.0'),
    /plugin marketplace update hypomnema/,
  );
  assert.match(vc.buildUpdateLine('plugin', '1.0.0', '1.1.0'), /reload-plugins/);
  assert.match(vc.buildUpdateLine('unknown', '1.0.0', '1.1.0'), /1\.0\.0 → 1\.1\.0/);
});

test('cacheIsFresh: fresh / stale / future / missing', () => {
  const now = 1_000_000_000_000;
  assert.equal(vc.cacheIsFresh({ checkedAt: now - 1000 }, now), true);
  assert.equal(vc.cacheIsFresh({ checkedAt: now - vc.TTL_MS - 1 }, now), false);
  assert.equal(vc.cacheIsFresh({ checkedAt: now + 5 * 60_000 }, now), false); // future skew
  assert.equal(vc.cacheIsFresh(null, now), false);
  assert.equal(vc.cacheIsFresh({}, now), false);
});

test('computeNotice: shows when latest is newer', () => {
  const cache = { latest: { npm: '1.2.0' }, notifiedFor: {} };
  const n = vc.computeNotice(cache, 'npm', '1.1.0');
  assert.ok(n);
  assert.equal(n.latest, '1.2.0');
  assert.match(n.line, /npm install -g hypomnema/);
});

test('computeNotice: skips when current >= latest (incl. local dev)', () => {
  assert.equal(vc.computeNotice({ latest: { npm: '1.2.0' } }, 'npm', '1.2.0'), null);
  assert.equal(vc.computeNotice({ latest: { npm: '1.2.0' } }, 'npm', '1.3.0'), null);
});

test('computeNotice: skips when already notified for this version', () => {
  const cache = { latest: { npm: '1.2.0' }, notifiedFor: { npm: '1.2.0' } };
  assert.equal(vc.computeNotice(cache, 'npm', '1.1.0'), null);
});

test('computeNotice: unknown channel / missing latest / invalid version → null', () => {
  assert.equal(vc.computeNotice({ latest: { npm: '1.2.0' } }, 'unknown', '1.1.0'), null);
  assert.equal(vc.computeNotice({ latest: {} }, 'npm', '1.1.0'), null);
  assert.equal(vc.computeNotice(null, 'npm', '1.1.0'), null);
  assert.equal(vc.computeNotice({ latest: { npm: 'garbage' } }, 'npm', '1.1.0'), null);
});

test('computeNotice: per-channel state is independent (channel switch)', () => {
  // npm already notified at 1.2.0, but plugin at 1.2.0 has NOT been notified.
  const cache = {
    latest: { npm: '1.2.0', plugin: '1.2.0' },
    notifiedFor: { npm: '1.2.0' },
  };
  assert.equal(vc.computeNotice(cache, 'npm', '1.1.0'), null); // suppressed
  assert.ok(vc.computeNotice(cache, 'plugin', '1.1.0')); // still shows
});

test('isOptedOut: respects HYPO_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER / CI', () => {
  assert.equal(vc.isOptedOut({}), false);
  assert.equal(vc.isOptedOut({ HYPO_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(vc.isOptedOut({ NO_UPDATE_NOTIFIER: '1' }), true);
  assert.equal(vc.isOptedOut({ CI: 'true' }), true);
});

test('cache I/O: atomic write/read round-trip + corrupt file → null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-vc-'));
  const path = join(dir, 'version-check.json');
  try {
    assert.equal(vc.readCache(path), null); // missing
    vc.writeCacheAtomic(path, { checkedAt: 42, latest: { npm: '1.0.0' } });
    assert.equal(vc.readCache(path).checkedAt, 42);
    writeFileSync(path, '{not json');
    assert.equal(vc.readCache(path), null); // corrupt
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markNotified: sets channel mark without erasing other fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-vc-'));
  const path = join(dir, 'version-check.json');
  try {
    vc.writeCacheAtomic(path, { checkedAt: 1, latest: { npm: '1.2.0', plugin: '1.1.0' } });
    vc.markNotified(path, 'npm', '1.2.0');
    const c = vc.readCache(path);
    assert.equal(c.notifiedFor.npm, '1.2.0');
    assert.equal(c.latest.npm, '1.2.0'); // preserved
    assert.equal(c.latest.plugin, '1.1.0'); // preserved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeLatest: refreshes latest but preserves notifiedFor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-vc-'));
  const path = join(dir, 'version-check.json');
  try {
    vc.writeCacheAtomic(path, { latest: { npm: '1.0.0' }, notifiedFor: { npm: '1.0.0' } });
    vc.mergeLatest(path, { npm: '1.3.0', plugin: '1.3.0' }, 999);
    const c = vc.readCache(path);
    assert.equal(c.checkedAt, 999);
    assert.equal(c.latest.npm, '1.3.0');
    assert.equal(c.latest.plugin, '1.3.0');
    assert.equal(c.notifiedFor.npm, '1.0.0'); // NOT erased by the fetch worker
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #12: unified hook stderr log format ────────────────────────────────────────
// spec §7.5: every lifecycle hook's fail-open path must emit `[hypo-<name>] error:
// <message>` to stderr (debugging, user-visible) while still returning the
// fail-open output. <name> = hook filename minus `.mjs` (proven by the
// wiki-cwd-change → hypo-cwd-change normalization).
suite('hooks-stderr-log-format — unified [hypo-<name>] error: logging (#12)');

const STDERR_LOG_HOOKS = [
  'hypo-session-start',
  'hypo-session-end',
  'hypo-session-record',
  'hypo-hot-rebuild',
  'hypo-cwd-change',
  'hypo-first-prompt',
  'hypo-compact-guard',
  'hypo-file-watch',
  'hypo-lookup',
  'hypo-personal-check',
  'hypo-auto-minimal-crystallize',
  'hypo-auto-stage',
];

for (const name of STDERR_LOG_HOOKS) {
  test(`hooks-stderr-log-format: ${name}.mjs carries the unified [${name}] error: tag`, () => {
    const src = readFileSync(join(HOOKS, `${name}.mjs`), 'utf-8');
    // Unified tag present in a stderr write.
    assert.ok(
      new RegExp(`process\\.stderr\\.write\\(\`\\[${name}\\] error: `).test(src),
      `${name}.mjs must log to stderr with the unified [${name}] error: format`,
    );
    // Hardened err access — bare `${err.message}` throws if a non-Error (null/
    // undefined) is ever thrown, which would break the fail-open invariant.
    assert.ok(
      !/\$\{err\.message\}/.test(src),
      `${name}.mjs must use \`err?.message ?? String(err)\`, not bare err.message`,
    );
    // No legacy [wiki-*] tag must survive the normalization (scoped to stderr
    // writes so legitimate [WIKI ...] injection markers never false-fail).
    assert.ok(
      !/process\.stderr\.write\(`\[wiki-/.test(src),
      `${name}.mjs must not retain a legacy [wiki-*] stderr tag`,
    );
  });
}

test('hooks-stderr-log-format: forced catch emits [hypo-compact-guard] error: + preserves fail-open', () => {
  const r = runHook('hypo-compact-guard.mjs', 'not-json');
  assert.match(r.stderr, /^\[hypo-compact-guard\] error: /m);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true); // fail-open invariant intact
});

test('hooks-stderr-log-format: forced catch emits [hypo-auto-stage] error: + preserves fail-open', () => {
  const r = runHook('hypo-auto-stage.mjs', 'not-json');
  assert.match(r.stderr, /^\[hypo-auto-stage\] error: /m);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(r.status, 0);
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
