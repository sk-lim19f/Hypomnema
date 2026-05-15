#!/usr/bin/env node
/**
 * tests/runner.mjs — Hypomnema test runner (no external deps)
 *
 * Runs unit tests for lib functions and smoke tests for CLI scripts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
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
    for (const sub of ['pages', 'projects', 'sources', 'pages/observability']) {
      assert.ok(existsSync(join(hypoDir, sub)), `missing: ${sub}/`);
    }
  });
});

test('init creates pages/observability/_index.md stub', () => {
  withTmpDir(dir => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [
      `--hypo-dir=${hypoDir}`,
      '--no-hooks',
      '--no-git-init',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const stubPath = join(hypoDir, 'pages', 'observability', '_index.md');
    assert.ok(existsSync(stubPath), 'pages/observability/_index.md should be created');
    const content = readFileSync(stubPath, 'utf8');
    assert.ok(content.includes('autonomy score'), '_index.md should contain autonomy score section');
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

test('init creates .gitignore with .cache/ entry', () => {
  withTmpDir(dir => {
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
  withTmpDir(dir => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const hookPath = join(hypoDir, '.git', 'hooks', 'pre-commit');
    assert.ok(existsSync(hookPath), '.git/hooks/pre-commit should be created');
    const content = readFileSync(hookPath, 'utf8');
    assert.ok(content.includes('# hypo-managed:pre-commit:start'), 'hook should contain hypo marker');
    assert.ok(content.includes('hypo-pre-commit.mjs'), 'hook should reference worker script');
  });
});

test('pre-commit hook blocks staged .env file via git commit', () => {
  withTmpDir(dir => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.email', 'test@hypo.test'], { stdio: 'ignore' });
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
    const commitR = spawnSync('git', ['-C', hypoDir, 'commit', '-m', 'should be blocked'], { encoding: 'utf-8' });
    assert.notEqual(commitR.status, 0, 'git commit should fail when .env.local is staged');
    assert.ok(
      (commitR.stdout + commitR.stderr).includes('.env.local'),
      `expected .env.local in git output: ${commitR.stdout}${commitR.stderr}`
    );
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

// fix #6: doctor-checks-node-git-shell-npm
suite('doctor.mjs — fix #6: external deps');

test('doctor-checks-node-git-shell-npm: Node.js check passes (running on ≥18)', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const nodeCheck = out.find(c => c.label === 'Node.js ≥ 18');
  assert.ok(nodeCheck, 'Node.js ≥ 18 check not found');
  assert.equal(nodeCheck.status, 'pass', `expected pass, got ${nodeCheck.status}: ${nodeCheck.detail}`);
});

test('doctor-checks-node-git-shell-npm: git check present', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const gitCheck = out.find(c => c.label === 'git');
  assert.ok(gitCheck, 'git check not found');
  assert.ok(['pass', 'fail'].includes(gitCheck.status), `unexpected status: ${gitCheck.status}`);
});

test('doctor-checks-node-git-shell-npm: npm check present', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const npmCheck = out.find(c => c.label === 'npm');
  assert.ok(npmCheck, 'npm check not found');
  assert.ok(['pass', 'fail'].includes(npmCheck.status), `unexpected status: ${npmCheck.status}`);
});

test('doctor-checks-node-git-shell-npm: shell check present', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const shellCheck = out.find(c => c.label === 'Shell (zsh/bash)');
  assert.ok(shellCheck, 'Shell check not found');
  assert.ok(['pass', 'warn', 'fail'].includes(shellCheck.status), `unexpected status: ${shellCheck.status}`);
});

// fix #7: doctor-settings-integrity
suite('doctor.mjs — fix #7: settings integrity');

test('doctor-settings-integrity: no stale entries → pass', () => {
  withTmpHome(home => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const staleCheck = out.find(c => c.label === 'settings.json stale hypo-* entries');
    assert.ok(staleCheck, 'stale check not found');
    assert.equal(staleCheck.status, 'pass', `expected pass: ${staleCheck.detail}`);
  });
});

test('doctor-settings-integrity: stale hypo-* entry → warn', () => {
  withTmpHome(home => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const staleSetting = {
      hooks: {
        PostToolUse: [{
          hooks: [{ type: 'command', command: `node $HOME/.claude/hooks/hypo-old-removed.mjs` }],
        }],
      },
    };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(staleSetting));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const staleCheck = out.find(c => c.label === 'settings.json stale hypo-* entries');
    assert.ok(staleCheck, 'stale check not found');
    assert.equal(staleCheck.status, 'warn', `expected warn: ${staleCheck.detail}`);
  });
});

test('doctor-settings-integrity: duplicate hypo-* entry → warn', () => {
  withTmpHome(home => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const dupeSetting = {
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: `node $HOME/.claude/hooks/hypo-auto-commit.mjs` }] },
          { hooks: [{ type: 'command', command: `node $HOME/.claude/hooks/hypo-auto-commit.mjs` }] },
        ],
      },
    };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(dupeSetting));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const dupeCheck = out.find(c => c.label === 'settings.json duplicate hypo-* entries');
    assert.ok(dupeCheck, 'duplicate check not found');
    assert.equal(dupeCheck.status, 'warn', `expected warn: ${dupeCheck.detail}`);
  });
});

// fix #11: doctor-sync-state-warn
suite('doctor.mjs — fix #11: sync-state warn');

test('doctor-sync-state-warn: no .cache/sync-state.json → pass', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find(c => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('doctor-sync-state-warn: open sync-state.json entries → warn', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({ timestamp: '2026-05-14T00:00:00Z', op: 'push', error: 'network timeout', host: 'test' }) + '\n'
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find(c => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
  });
});

// fix #8: doctor-codex-paths
suite('doctor.mjs — fix #8: codex paths');

test('doctor-codex-paths: no codex checks without --codex flag', () => {
  const r = run('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  const codexChecks = out.filter(c => c.label.includes('Codex'));
  assert.equal(codexChecks.length, 0, 'expected no Codex checks without --codex flag');
});

test('doctor-codex-paths: --codex flag triggers codex hook file check', () => {
  withTmpHome(home => {
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--codex', '--json'], home);
    const out = JSON.parse(r.stdout);
    const hookCheck = out.find(c => c.label === 'Codex hook files installed');
    assert.ok(hookCheck, 'Codex hook files check not found');
    assert.equal(hookCheck.status, 'fail', `expected fail when ~/.codex/hooks is empty: ${hookCheck.detail}`);
  });
});

test('doctor-codex-paths: --codex flag triggers codex settings.json check', () => {
  withTmpHome(home => {
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--codex', '--json'], home);
    const out = JSON.parse(r.stdout);
    const settingsCheck = out.find(c => c.label === 'Codex settings.json hook registrations');
    assert.ok(settingsCheck, 'Codex settings.json check not found');
  });
});

// ── hook contract tests ───────────────────────────────────────────────────────

const HOOKS = join(REPO, 'hooks');

const { isCompactCommand, isGateSkipped, buildOutput, isClosePattern } = await import(
  join(HOOKS, 'hypo-shared.mjs')
);

function runHook(hookFile, stdinData, extraEnv = {}) {
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '/tmp/nonexistent-hypo-99999', ...extraEnv },
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
  writeFileSync(join(dir, 'hot.md'),
    `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
    `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
    `| test-project | ${today} | [[projects/test-project/hot]] |\n`);
  writeFileSync(join(projDir, 'session-state.md'),
    `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`);
  writeFileSync(join(projDir, 'hot.md'),
    `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`);
  writeFileSync(join(projDir, 'session-log', `${ym}.md`),
    `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] test session\n`);
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
  withWiki(null, dir => fn(dir));
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
  assert.equal(isClosePattern('여기까지 구현하고 테스트해줘'), false);   // Codex P2
  assert.equal(isClosePattern('작업 종료 조건을 바꿔줘'), false);         // Codex P2
  assert.equal(isClosePattern('wrap up this PR'), false);               // Codex P2
  assert.equal(isClosePattern('wrap up this feature'), false);          // Codex P2
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

suite('hypo-personal-check.mjs — close-intent enrichment (#20)');

test('close intent in transcript → block message includes close-intent note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-close-'));
  try {
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({ message: { role: 'user', content: '세션 마무리하자' } }) + '\n');
    const r = runHook('hypo-personal-check.mjs', { transcript_path: transcript });
    const out = JSON.parse(r.stdout);
    assert.ok(out.decision === 'block', 'should still block when session close is incomplete');
    assert.ok(out.reason.includes('Close intent'), 'block reason should mention close intent detection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no close intent → block message does NOT include close-intent note', () => {
  const r = runHook('hypo-personal-check.mjs', {});
  const out = JSON.parse(r.stdout);
  assert.ok(out.decision === 'block');
  assert.ok(!out.reason.includes('Close intent'), 'block reason should not mention close intent when absent');
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

suite('hypo-personal-check.mjs — strict session-close gate (#17)');

test('5 mandatory memory files fresh → suppressOutput:true', () => {
  withWiki(null, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `expected pass, got: ${r.stdout}`);
    assert.equal(out.suppressOutput, true);
  });
});

test('project hot.md not updated today → block, reason names the file', () => {
  withWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'test-project', 'hot.md'),
      '---\ntitle: hot\ntype: reference\nupdated: 2020-01-01\n---\n\n# Hot\n');
  }, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
    assert.ok(out.reason.includes('projects/test-project/hot.md'),
      `block reason should name the stale file: ${out.reason}`);
  });
});

test('session-log missing a today-dated heading → block', () => {
  withWiki((dir, today) => {
    const ym = today.slice(0, 7);
    writeFileSync(join(dir, 'projects', 'test-project', 'session-log', `${ym}.md`),
      '---\ntitle: Session Log\ntype: session-log\nupdated: 2020-01-01\n---\n\n## [2020-01-01] old session\n');
  }, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
    assert.ok(out.reason.includes('session-log'),
      `block reason should name the session-log file: ${out.reason}`);
  });
});

test('open-questions.md absent/stale → still passes (conditional, not gated)', () => {
  withWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'open-questions.md'),
      '---\ntitle: Open Questions\ntype: open-questions\nupdated: 2020-01-01\n---\n\n# Open Questions\n');
  }, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `open-questions is conditional — should not gate: ${r.stdout}`);
  });
});

test('log.md missing a today-dated session entry → block', () => {
  withWiki((dir) => {
    // log.md exists but its session entry is stale-dated.
    writeFileSync(join(dir, 'log.md'), '## [2020-01-01] session | test-project — old\n');
  }, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `expected block, got: ${r.stdout}`);
    assert.ok(out.reason.includes('log.md'), `block reason should name log.md: ${out.reason}`);
  });
});

test('log.md session entry for a different project → block', () => {
  withWiki((dir, today) => {
    // A fresh session entry, but for some other project — must not satisfy
    // the gate for the resolved project (test-project).
    writeFileSync(join(dir, 'log.md'), `## [${today}] session | other-project — done\n`);
  }, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir });
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `cross-project log entry must not pass: ${r.stdout}`);
    assert.ok(out.reason.includes('log.md'), `block reason should name log.md: ${out.reason}`);
  });
});

test('HYPO_SKIP_GATE=1 bypasses an incomplete session close', () => {
  withWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'test-project', 'session-state.md'),
      '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n');
  }, dir => {
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HYPO_SKIP_GATE: '1' });
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `HYPO_SKIP_GATE should bypass: ${r.stdout}`);
    assert.ok(out.systemMessage.includes('memory files not updated'),
      `bypass message should still surface the incomplete files: ${out.systemMessage}`);
  });
});

suite('crystallize.mjs --check-session-close (#17)');

test('clean session close → exit 0 + ok:true', () => {
  withWiki(null, dir => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.project, 'test-project');
  });
});

test('stale memory file → exit 1 + ok:false + names the file', () => {
  withWiki((dir) => {
    writeFileSync(join(dir, 'projects', 'test-project', 'session-state.md'),
      '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n');
  }, dir => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.stale.includes('projects/test-project/session-state.md'),
      `stale list should name the file: ${JSON.stringify(out.stale)}`);
  });
});

test('--check-session-close reads log.md from --hypo-dir, not the ambient wiki', () => {
  withWiki((dir) => {
    // log.md whose last substantial op is an ingest, not a session close.
    writeFileSync(join(dir, 'log.md'), '## [2020-01-01] ingest | some-source\n');
  }, dir => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.stale.includes('log.md'),
      `log.md check must target --hypo-dir and flag it stale: ${r.stdout}`);
  });
});

test('missing log.md → exit 1 + log.md in missing list', () => {
  withWiki((dir) => {
    rmSync(join(dir, 'log.md'));
  }, dir => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.missing.includes('log.md'), `missing list should name log.md: ${r.stdout}`);
  });
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
    sessionState: { content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8') },
    projectHot:   { content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'),           'utf-8') },
    rootHot:      { content: readFileSync(join(dir, 'hot.md'),                                       'utf-8') },
    sessionLog:   { entry:   `## [${today}] re-applied session\n` },
    log:          { entry:   `## [${today}] session | test-project — re-applied\n` },
  };
}

function runApply(dir, payload) {
  const payloadPath = join(dir, '.payload.json');
  writeFileSync(payloadPath, JSON.stringify(payload));
  return run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', `--payload=${payloadPath}`, '--json']);
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
    assert.ok(/sessionLog/.test(appliedSlots), `sessionLog should be appended (new entry): ${JSON.stringify(out)}`);
    assert.ok(/log \(log\.md\)/.test(appliedSlots), `log.md should be appended (new entry): ${JSON.stringify(out)}`);
  });
});

test('idempotent: re-running same payload produces no new bytes (file mtimes unchanged)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const r1 = runApply(dir, payload);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);
    const sl = join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`);
    const sizeBefore = readFileSync(sl, 'utf-8').length;
    const logBefore  = readFileSync(join(dir, 'log.md'), 'utf-8').length;

    const r2 = runApply(dir, payload);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);
    const sizeAfter = readFileSync(sl, 'utf-8').length;
    const logAfter  = readFileSync(join(dir, 'log.md'), 'utf-8').length;
    assert.equal(sizeAfter, sizeBefore, 'session-log must not grow on re-apply (idempotent append)');
    assert.equal(logAfter,  logBefore,  'log.md must not grow on re-apply (idempotent append)');
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
    delete payload.openQuestions;  // explicitly omit
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, 'open-questions is conditional — apply must succeed without it');
    assert.ok(!out.applied.some(a => /openQuestions/.test(a)), 'openQuestions slot should not appear when omitted');
  });
});

test('open-questions stale on disk → still passes (apply does not gate it)', () => {
  withWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'open-questions.md'),
      '---\ntitle: Open Questions\ntype: open-questions\nupdated: 2020-01-01\n---\n\n# Open Questions\n');
  }, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.openQuestions;
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `stale open-questions must not gate: ${r.stdout}`);
  });
});

test('payload with stale `updated:` → exit 1, no auto-fix (advisor rule)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    // Inject a stale-dated session-state. Helper must NOT silently rewrite it.
    payload.sessionState = {
      content: '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
    };
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `stale payload must fail final gate, got status=${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(out.verification.stale.includes('projects/test-project/session-state.md'),
      `stale field should be flagged: ${JSON.stringify(out.verification)}`);
  });
});

test('missing payload → exit 1 with clear error', () => {
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(/payload is required/.test(out.error), `error should mention payload: ${out.error}`);
  });
});

test('same-day second close: distinct entries are both appended (W1 regression)', () => {
  // Sub-session within the same day must produce a second log entry, not be
  // silently deduped because today's heading already exists. This was the
  // major flaw codex review surfaced — apply dedup vs freshness gate.
  withWiki(null, (dir, today) => {
    const p1 = payloadForCleanWiki(dir, today);
    p1.sessionLog.entry = `## [${today}] morning sub-session\n\nbody A\n`;
    p1.log.entry        = `## [${today}] session | test-project — morning\n`;
    const r1 = runApply(dir, p1);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);

    const p2 = payloadForCleanWiki(dir, today);
    p2.sessionLog.entry = `## [${today}] afternoon sub-session\n\nbody B\n`;
    p2.log.entry        = `## [${today}] session | test-project — afternoon\n`;
    const r2 = runApply(dir, p2);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);

    const sl  = readFileSync(join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`), 'utf-8');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.ok(sl.includes('morning sub-session'),   `session-log should keep morning entry: ${sl}`);
    assert.ok(sl.includes('afternoon sub-session'), `session-log should append afternoon entry: ${sl}`);
    assert.ok(log.includes('— morning'),   `log.md should keep morning entry: ${log}`);
    assert.ok(log.includes('— afternoon'), `log.md should append afternoon entry: ${log}`);
  });
});

test('payload schema: missing mandatory field → exit 1 with named field (W1 fail-loud)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.projectHot;  // drop a mandatory slot
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `missing mandatory must fail, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(/projectHot/.test(JSON.stringify(out.details || out.error)),
      `error must name the missing field: ${r.stdout}`);
  });
});

test('payload schema: invalid date format → exit 1', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.date = '2026/05/15';
    const r = runApply(dir, payload);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.ok(/YYYY-MM-DD/.test(JSON.stringify(out.details || out.error)),
      `error must mention date format: ${r.stdout}`);
  });
});

test('hasLogEntry: project "foo" must NOT match "foo-bar" (W2 boundary regression)', () => {
  // Pre-existing bug in sessionCloseFileStatus that the helper extraction
  // inherited. \b after "foo" matches before "-" (non-word char), so the
  // bounded regex must use (?=\\s|$) instead.
  withWiki((dir, today) => {
    // Replace root hot.md to declare project "foo" as the active project,
    // and seed log.md with a session entry for "foo-bar" only.
    writeFileSync(join(dir, 'hot.md'),
      `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
      `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
      `| foo | ${today} | [[projects/foo/hot]] |\n`);
    mkdirSync(join(dir, 'projects', 'foo', 'session-log'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'foo', 'session-state.md'),
      `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`);
    writeFileSync(join(dir, 'projects', 'foo', 'hot.md'),
      `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`);
    writeFileSync(join(dir, 'projects', 'foo', 'session-log', `${today.slice(0, 7)}.md`),
      `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] foo session\n`);
    // log.md only carries an entry for the LOOK-ALIKE project name.
    writeFileSync(join(dir, 'log.md'), `## [${today}] session | foo-bar — should not satisfy "foo" gate\n`);
  }, dir => {
    // Plain --check-session-close must reject "foo" because no foo entry exists.
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    assert.equal(r.status, 1, `foo must not match foo-bar in log.md, got status=${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.stale.includes('log.md') || out.missing.includes('log.md'),
      `log.md must be flagged stale/missing for foo: ${JSON.stringify(out)}`);
  });
});

test('payload via stdin (`--payload=-`) works the same as a file', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const r = spawnSync(process.execPath,
      [join(REPO, 'scripts', 'crystallize.mjs'), `--hypo-dir=${dir}`, '--apply-session-close', '--payload=-', '--json'],
      { input: JSON.stringify(payload), encoding: 'utf-8' });
    assert.equal(r.status, 0, `stdin apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
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

suite('hypo-hot-rebuild.mjs — parsePointerRows row format');

test('valid wikilink row is preserved in rebuilt hot.md', () => {
  withTmpDir(dir => {
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
    assert.ok(result.includes('[[projects/my-project/hot]]'), 'valid wikilink row must be preserved');
  });
});

test('markdown link row is silently excluded when mixed with a valid wikilink row', () => {
  withTmpDir(dir => {
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
    assert.ok(result.includes('[[projects/valid-project/hot]]'), 'valid wikilink row must be preserved');
    assert.ok(!result.includes('bad-project'), 'markdown link row must be excluded from rebuilt output');
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

suite('ingest.mjs — .hypoignore privacy guard (#14)');

test('ingest-rejects-hypoignore: --check=.env refuses (spec §8.10 verification #2)', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=.env']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
    assert.ok(/Refused/.test(r.stderr), `expected refusal message, got: ${r.stderr}`);
    assert.ok(/\.env\*/.test(r.stderr), `expected matched pattern in message, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: --check=sources/<slug> refuses renamed secret (rename-bypass)', () => {
  withTmpDir(dir => {
    // A user could rename `.env` to an innocuous slug; the destination path
    // sources/<slug>.<ext> must still be blocked by a content-pattern match.
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=sources/my-secrets.md']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status} (stderr: ${r.stderr})`);
    assert.ok(/Refused/.test(r.stderr), `expected refusal message, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: --check on a non-ignored path exits 0 silently', () => {
  withTmpDir(dir => {
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=sources/openai-swarm-paper.md']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status} (stderr: ${r.stderr})`);
    assert.equal(r.stdout.trim(), '', `expected no stdout, got: ${r.stdout}`);
    assert.equal(r.stderr.trim(), '', `expected no stderr, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: --check with no .hypoignore file exits 0', () => {
  withTmpDir(dir => {
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=.env']);
    assert.equal(r.status, 0, `expected exit 0 with no .hypoignore, got ${r.status} (stderr: ${r.stderr})`);
  });
});

test('ingest-rejects-hypoignore: symlink with innocuous name pointing at ignored target is refused', () => {
  withTmpDir(dir => {
    // A symlink `innocent-note.md` → `.env` would otherwise pass the lexical
    // check (its own basename is not ignored) and let `/hypo:ingest` read the
    // secret it points at. The guard follows the symlink via realpath.
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    writeFileSync(join(dir, '.env'), 'API_KEY=xxx\n');
    symlinkSync(join(dir, '.env'), join(dir, 'innocent-note.md'));
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=innocent-note.md']);
    assert.equal(r.status, 1, `expected exit 1 (symlink bypass), got ${r.status} (stderr: ${r.stderr})`);
    assert.ok(/Refused/.test(r.stderr), `expected refusal message, got: ${r.stderr}`);
  });
});

test('ingest-rejects-hypoignore: ../ traversal is still caught by basename patterns', () => {
  withTmpDir(dir => {
    // `join(hypoDir, '../foo/.env')` resolves outside the wiki; anchored
    // patterns no longer apply, but basename patterns (`.env*`) still must.
    writeFileSync(join(dir, '.hypoignore'), '# Secrets\n.env*\n*secret*\n');
    const r = run('ingest.mjs', [`--hypo-dir=${dir}`, '--check=../foo/.env']);
    assert.equal(r.status, 1, `expected exit 1 (basename match through traversal), got ${r.status} (stderr: ${r.stderr})`);
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

// ── sync-state replay (fix #9/#10) ───────────────────────────────────────────

// A wiki repo wired to a working bare remote and pushed in sync — the baseline
// for exercising session-start's clear/preserve logic.
function withSyncedWiki(fn) {
  const base   = mkdtempSync(join(tmpdir(), 'hypo-sync-'));
  const dir    = join(base, 'wiki');
  const remote = join(base, 'remote.git');
  try {
    spawnSync('git', ['init', '--bare', '-q', remote]);
    spawnSync('git', ['init', '-q', dir]);
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(join(dir, 'hot.md'),
      '---\ntitle: Hot\nupdated: today\n---\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n');
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
    .split('\n').filter(Boolean).map(l => JSON.parse(l));
}

suite('hypo-auto-commit.mjs / hypo-session-start.mjs — sync-state replay');

test('replay-auto-commit-writes-sync-state: pull/push failure appends entries', () => {
  withGrowthWiki(dir => {
    // a remote that does not exist → both pull and push fail
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', join(dir, 'no-such-remote.git')]);
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'note.md'), '# note\n');
    const r = runStop('hypo-auto-commit.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(dir, '.cache', 'sync-state.json')),
      'sync-state.json must be created on sync failure');
    const entries = readSyncEntries(dir);
    assert.ok(entries.length >= 1, `expected ≥1 failure entry, got ${entries.length}`);
    assert.ok(entries.every(e => e.op === 'pull' || e.op === 'push'),
      `unexpected op: ${JSON.stringify(entries)}`);
    assert.ok(entries.every(e => e.timestamp && e.host && e.error),
      `entries must carry timestamp/host/error: ${JSON.stringify(entries)}`);
  });
});

test('replay-session-start-exposes-sync-state: open entry surfaces in additionalContext', () => {
  withGrowthWiki(dir => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({ timestamp: '2026-05-14T00:00:00Z', op: 'push', error: 'network timeout', host: 'test' }) + '\n');
    const r = runStart(dir);
    const ctx = (JSON.parse(r.stdout).additionalContext) || '';
    assert.ok(ctx.includes('last sync failed'), `sync notice missing: ${ctx}`);
    assert.ok(ctx.includes('network timeout'), `error detail missing: ${ctx}`);
  });
});

test('replay-session-start-clears-resolved-sync-state: healthy repo clears the entry', () => {
  withSyncedWiki(dir => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'sync-state.json');
    writeFileSync(p, JSON.stringify({ timestamp: '2026-05-14T00:00:00Z', op: 'pull', error: 'network timeout', host: 'test' }) + '\n');
    const r = runStart(dir);
    const ctx = (JSON.parse(r.stdout).additionalContext) || '';
    assert.ok(!ctx.includes('last sync failed'), `resolved sync should not surface: ${ctx}`);
    assert.ok(!existsSync(p), 'sync-state.json must be cleared once sync is healthy');
  });
});

test('replay-session-start-surfaces-unreadable-sync-state: corrupt JSONL is not silently hidden', () => {
  withGrowthWiki(dir => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'sync-state.json');
    writeFileSync(p, JSON.stringify({ timestamp: '2026-05-14T00:00:00Z', op: 'push', error: 'x', host: 'test' }) + '\nnot-json\n');
    const r = runStart(dir);
    const ctx = (JSON.parse(r.stdout).additionalContext) || '';
    assert.ok(ctx.includes('last sync failed'), `corrupt sync-state must still surface: ${ctx}`);
    assert.ok(existsSync(p), 'unreadable sync-state.json must be preserved for inspection');
  });
});

test('replay-session-start-preserves-sync-state-when-ahead: unpushed commit keeps the entry', () => {
  withSyncedWiki(dir => {
    // simulate a prior failed push: a local commit not on the remote
    writeFileSync(join(dir, 'unpushed.md'), '# unpushed\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'unpushed work']);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const p = join(dir, '.cache', 'sync-state.json');
    writeFileSync(p, JSON.stringify({ timestamp: '2026-05-14T00:00:00Z', op: 'push', error: 'connection refused', host: 'test' }) + '\n');
    const r = runStart(dir);
    const ctx = (JSON.parse(r.stdout).additionalContext) || '';
    assert.ok(ctx.includes('last sync failed'), `unresolved push failure must stay surfaced: ${ctx}`);
    assert.ok(existsSync(p), 'sync-state.json must not be cleared while local is ahead of remote');
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

suite('hypo-lookup.mjs — type-prior boost');

test('output is always valid JSON', () => {
  const r = runHook('hypo-lookup.mjs', { prompt: 'hello world' });
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout: ${r.stdout}`);
});

test('PRD entry ranked above plain entry with same keyword', () => {
  withTmpDir(dir => {
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
    const prdPos   = ctx.indexOf('prd-search');
    const plainPos = ctx.indexOf('search-notes');
    assert.ok(prdPos !== -1, 'PRD entry should appear in context');
    assert.ok(prdPos < plainPos || plainPos === -1, 'PRD should rank before plain entry');
  });
});

test('ADR entry ranked above plain entry with same keyword', () => {
  withTmpDir(dir => {
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
    const adrPos   = ctx.indexOf('decisions/0001-use-bm25');
    const plainPos = ctx.indexOf('bm25-notes');
    assert.ok(adrPos !== -1, 'ADR entry should appear in context');
    assert.ok(adrPos < plainPos || plainPos === -1, 'ADR should rank before plain entry');
  });
});

// ── query.mjs smoke tests ────────────────────────────────────────────────────

suite('query.mjs — no-results ingest prompt');

test('no results: shows ingest suggestion', () => {
  withTmpDir(dir => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const r = run('query.mjs', [`--hypo-dir=${dir}`, '--q=xyzzy-nonexistent-term']);
    assert.equal(r.status, 0, `should exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes('/hypo:ingest'), `expected ingest prompt in stdout: ${r.stdout}`);
  });
});

test('no results: ingest prompt absent in --json mode', () => {
  withTmpDir(dir => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const r = run('query.mjs', [`--hypo-dir=${dir}`, '--q=xyzzy-nonexistent-term', '--json']);
    assert.equal(r.status, 0, `should exit 0: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed), 'JSON output should be an array');
    assert.equal(parsed.length, 0, 'should be empty array');
  });
});

test('with results: ingest prompt not shown', () => {
  withTmpDir(dir => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'test-page.md'), '---\ntitle: test\ntype: note\n---\nfoo bar baz content here\n');
    const r = run('query.mjs', [`--hypo-dir=${dir}`, '--q=foo']);
    assert.equal(r.status, 0, `should exit 0: ${r.stderr}`);
    assert.ok(!r.stdout.includes('/hypo:ingest'), `ingest prompt should not appear when results exist: ${r.stdout}`);
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
