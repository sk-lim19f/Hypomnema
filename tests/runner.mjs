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
  existsSync,
  symlinkSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
