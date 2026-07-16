// tests/doctor.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test, suite } from './harness.mjs';
import {
  HOOKS,
  NONEXISTENT_WIKI,
  REPO,
  SCRIPTS,
  run,
  runWithHome,
  withTmpDir,
  withTmpHome,
} from './helpers.mjs';

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

test('doctor-sync-state-warn: conflict entry → manual-merge guidance, not generic hint', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({
        timestamp: '2026-06-19T00:00:00Z',
        op: 'conflict',
        error: 'CONFLICT (content): Merge conflict in page.md',
        host: 'test',
      }) + '\n',
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(
      /diverged|pull --no-rebase/.test(check.detail),
      `conflict must get manual-merge guidance, not the generic hint: ${check.detail}`,
    );
  });
});

suite('doctor.mjs — per-project index.md working_dir anchor coverage');

function doctorAnchorCheck(dir) {
  const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(r.stdout);
  return out.find((c) => c.label === 'Project index anchors');
}

test('doctor-project-anchors: no projects/ dir → check absent (not reported)', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const check = doctorAnchorCheck(dir);
    assert.equal(check, undefined, 'anchor check should not run without projects/');
  });
});

test('doctor-project-anchors: project with working_dir index.md → pass', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'index.md'),
      '---\ntitle: demo\ntype: project-index\nupdated: 2026-06-01\nworking_dir: /repo/demo\n---\n# demo\n',
    );
    writeFileSync(join(projDir, 'hot.md'), '# hot\n');
    const check = doctorAnchorCheck(dir);
    assert.ok(check, 'anchor check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('doctor-project-anchors: session artifacts but no index.md → warn', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const projDir = join(dir, 'projects', 'legacy');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'session-state.md'), '## Next\nbody\n');
    const check = doctorAnchorCheck(dir);
    assert.ok(check, 'anchor check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(check.detail.includes('legacy'), `expected slug named: ${check.detail}`);
    assert.ok(check.detail.includes('no index.md'), `expected reason named: ${check.detail}`);
  });
});

test('doctor-project-anchors: index.md present but missing working_dir → warn', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const projDir = join(dir, 'projects', 'no-anchor');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'index.md'),
      '---\ntitle: no-anchor\ntype: project-index\nupdated: 2026-06-01\n---\n# no-anchor\n',
    );
    writeFileSync(join(projDir, 'hot.md'), '# hot\n');
    const check = doctorAnchorCheck(dir);
    assert.ok(check, 'anchor check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(check.detail.includes('no-anchor'), `expected slug named: ${check.detail}`);
    assert.ok(
      check.detail.includes('missing working_dir'),
      `expected reason named: ${check.detail}`,
    );
  });
});

// The runtime hooks (hooks/hypo-shared.mjs collectProjectWorkingDirs) only
// recognize the exact `working_dir:` form (no space before the colon) — a
// lenient parseFrontmatter-style reader would accept `working_dir : /repo`
// and wrongly report this project as anchored, even though cwd-first resume
// still can't match it. Doctor must agree with the runtime matcher, not the
// lenient one.
test('doctor-project-anchors: `working_dir :` (space before colon) is NOT recognized as an anchor → warn', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    const projDir = join(dir, 'projects', 'space-colon');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'index.md'),
      '---\ntitle: space-colon\ntype: project-index\nupdated: 2026-06-01\nworking_dir : /repo/space-colon\n---\n# space-colon\n',
    );
    writeFileSync(join(projDir, 'hot.md'), '# hot\n');
    const check = doctorAnchorCheck(dir);
    assert.ok(check, 'anchor check not found');
    assert.equal(
      check.status,
      'warn',
      `space-before-colon working_dir must not false-pass as anchored: ${check.detail}`,
    );
    assert.ok(check.detail.includes('space-colon'), `expected slug named: ${check.detail}`);
  });
});

test('doctor-project-anchors: bare scaffold (no session artifacts) is not flagged', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    // A freshly-scaffolded project dir with no session-state.md/hot.md/session-log
    // yet has nothing for cwd-first resume to lose — must not be flagged.
    mkdirSync(join(dir, 'projects', 'empty'), { recursive: true });
    const check = doctorAnchorCheck(dir);
    assert.ok(check, 'anchor check not found');
    assert.equal(check.status, 'pass', `expected pass (nothing to anchor yet): ${check.detail}`);
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

// A non-array `skips` (which the hook helper silently normalizes to []) must
// still be flagged by doctor, since it breaks permanent "N" suppression.
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

// ── ISSUE-52: install-channel awareness (plugin channel false-negative) ───────
// A plugin-channel install registers its core hooks straight out of the
// package's own hooks/hooks.json — never into ~/.claude/hooks, never into
// ~/.claude/settings.json. doctor used to treat that empty state as "missing"
// and prescribe `/hypo:init`, which then double-registered every hook. Run a
// COPY of doctor.mjs from a fake root whose path matches the plugin-cache
// shape (`.claude/plugins/…`) so the channel detector (gated on doctor.mjs's
// OWN script location, mirroring upgrade.mjs) actually fires.
suite('doctor.mjs — plugin channel (ISSUE-52)');

function withFakeDoctorInstall(underPlugins, fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-doc-'));
  try {
    const root = underPlugins
      ? join(base, '.claude', 'plugins', 'cache', 'mp', 'hypomnema', '1.3.0')
      : join(base, 'lib', 'node_modules', 'hypomnema');
    mkdirSync(root, { recursive: true });
    cpSync(SCRIPTS, join(root, 'scripts'), { recursive: true });
    cpSync(HOOKS, join(root, 'hooks'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(root, 'package.json'));
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const wiki = join(base, 'wiki');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '---\ntitle: config\ntype: reference\n---\n');
    fn({ doctor: join(root, 'scripts', 'doctor.mjs'), root, home, wiki });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runDoctorFrom(doctor, args, home) {
  return spawnSync(process.execPath, [doctor, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: home },
  });
}

test('plugin mode: empty ~/.claude/hooks passes, not fails', () => {
  withFakeDoctorInstall(true, ({ doctor, home, wiki }) => {
    const r = runDoctorFrom(doctor, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const hookCheck = out.find((c) => c.label === 'Hook files installed');
    assert.ok(hookCheck, 'Hook files installed check not found');
    assert.equal(
      hookCheck.status,
      'pass',
      `plugin channel with empty ~/.claude/hooks must pass: ${JSON.stringify(hookCheck)}`,
    );
  });
});

test('plugin mode: 0/N settings.json registrations passes, not fails', () => {
  withFakeDoctorInstall(true, ({ doctor, home, wiki }) => {
    const r = runDoctorFrom(doctor, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const settingsCheck = out.find((c) => c.label === 'settings.json hook registrations');
    assert.ok(settingsCheck, 'settings.json hook registrations check not found');
    assert.equal(
      settingsCheck.status,
      'pass',
      `plugin channel with 0 settings.json registrations must pass: ${JSON.stringify(settingsCheck)}`,
    );
  });
});

test('regression baseline: npm/manual channel with empty hooks still fails', () => {
  withFakeDoctorInstall(false, ({ doctor, home, wiki }) => {
    const r = runDoctorFrom(doctor, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const hookCheck = out.find((c) => c.label === 'Hook files installed');
    const settingsCheck = out.find((c) => c.label === 'settings.json hook registrations');
    assert.equal(
      hookCheck.status,
      'fail',
      'npm/manual channel with empty ~/.claude/hooks must still fail (baseline unaffected)',
    );
    assert.notEqual(
      settingsCheck.status,
      'pass',
      'npm/manual channel with 0 settings.json registrations must not silently pass',
    );
  });
});

// ── ISSUE-54: hypo-pkg.json integrity (stale / dev-repo pointer) ─────────────
suite('doctor.mjs — hypo-pkg.json integrity (ISSUE-54)');

test('no hypo-pkg.json yet → no integrity checks reported (fresh install, non-actionable)', () => {
  withTmpHome((home) => {
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const anyPkgCheck = out.find((c) => c.label.startsWith('hypo-pkg.json'));
    assert.equal(anyPkgCheck, undefined, 'a fresh install with no metadata must report nothing');
  });
});

test('pkgRoot does not exist on disk → warn, not fail', () => {
  withTmpHome((home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'hypo-pkg.json'),
      JSON.stringify({ pkgRoot: '/nonexistent/hypo-pkg-root', pkgVersion: '9.9.9' }),
    );
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const rootCheck = out.find((c) => c.label === 'hypo-pkg.json pkgRoot exists');
    assert.ok(rootCheck, 'hypo-pkg.json pkgRoot exists check not found');
    assert.equal(rootCheck.status, 'warn', `missing pkgRoot must warn, not fail: ${r.stdout}`);
  });
});

test('pkgVersion mismatch vs pkgRoot package.json → warn', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-'));
    try {
      cpSync(join(REPO, 'package.json'), join(base, 'package.json'));
      const actualVersion = JSON.parse(readFileSync(join(base, 'package.json'), 'utf-8')).version;
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '0.0.1-definitely-stale' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const versionCheck = out.find((c) => c.label === 'hypo-pkg.json version match');
      assert.ok(versionCheck, 'hypo-pkg.json version match check not found');
      assert.equal(
        versionCheck.status,
        'warn',
        `version mismatch (recorded 0.0.1-definitely-stale vs actual ${actualVersion}) must warn: ${r.stdout}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('pkgRoot is a dirty git working tree → warn about dev checkout', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-git-'));
    try {
      initGitRepo(base); // committed, clean, signing/hooks neutralized
      // leave an uncommitted change → dirty working tree
      writeFileSync(join(base, 'WIP.md'), 'work in progress');

      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '1.0.0' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const kindCheck = out.find((c) => c.label === 'hypo-pkg.json pkgRoot install kind');
      assert.ok(kindCheck, 'hypo-pkg.json pkgRoot install kind check not found');
      assert.equal(
        kindCheck.status,
        'warn',
        `dirty/untagged pkgRoot must warn as a dev checkout: ${r.stdout}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// The version-match check must emit a line in EVERY reachable state — a silent
// skip reads as "verified" on the health report when nothing was checked.
test('pkgRoot package.json has no version field → warn, not silence', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-nover-'));
    try {
      writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'hypomnema' }));
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '1.0.0' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const versionCheck = out.find((c) => c.label === 'hypo-pkg.json version match');
      assert.ok(
        versionCheck,
        'a package.json with no version must still report a version-match line',
      );
      assert.equal(
        versionCheck.status,
        'warn',
        `unverifiable version (no version field) must warn, not silently skip: ${r.stdout}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('metadata records no pkgVersion → warn, not silence', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-nopkgver-'));
    try {
      writeFileSync(
        join(base, 'package.json'),
        JSON.stringify({ name: 'hypomnema', version: '1.0.0' }),
      );
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base }), // pkgRoot present, pkgVersion absent
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const versionCheck = out.find((c) => c.label === 'hypo-pkg.json version match');
      assert.ok(versionCheck, 'metadata with no pkgVersion must still report a version-match line');
      assert.equal(
        versionCheck.status,
        'warn',
        `unverifiable version (no recorded pkgVersion) must warn, not silently skip: ${r.stdout}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('matching pkgVersion vs pkgRoot package.json → pass (no false warn)', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-match-'));
    try {
      writeFileSync(
        join(base, 'package.json'),
        JSON.stringify({ name: 'hypomnema', version: '2.3.4' }),
      );
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '2.3.4' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const versionCheck = out.find((c) => c.label === 'hypo-pkg.json version match');
      assert.ok(versionCheck, 'version match check not found');
      assert.equal(versionCheck.status, 'pass', `a healthy version match must pass: ${r.stdout}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// A hypo-pkg.json that is PRESENT but has no pkgRoot is incomplete metadata that
// breaks runtime resolution — it must warn, not read as a healthy silent state.
// (A wholly absent file is the fresh-install case and stays silent.)
test('metadata file present but no pkgRoot field → warn (not silent)', () => {
  withTmpHome((home) => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgVersion: '1.0.0' }));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'hypo-pkg.json pkgRoot');
    assert.ok(check, 'a present-but-incomplete hypo-pkg.json must report a pkgRoot line');
    assert.equal(check.status, 'warn', `incomplete metadata (no pkgRoot) must warn: ${r.stdout}`);
  });
});

// ── ISSUE-54 follow-up: dev-repo install-kind classification is locked per state.
// The prior single dirty+untagged test could stay green even if untagged
// classification regressed (dirtiness alone supplies the warn) or git failed to
// run. These pin clean-tagged (pass), clean-untagged (warn, tag reason), and
// git-unavailable (cannot classify) independently.
function initGitRepo(base, { tag } = {}) {
  writeFileSync(
    join(base, 'package.json'),
    JSON.stringify({ name: 'hypomnema', version: '1.0.0' }),
  );
  const q = { stdio: 'ignore' };
  spawnSync('git', ['-C', base, 'init'], q);
  spawnSync('git', ['-C', base, 'config', 'user.email', 'test@test.com'], q);
  spawnSync('git', ['-C', base, 'config', 'user.name', 'Test'], q);
  // Neutralize a host that globally sets commit/tag signing or a hooks path, so the
  // fixture commit succeeds regardless of the maintainer's git config.
  spawnSync('git', ['-C', base, 'config', 'commit.gpgsign', 'false'], q);
  spawnSync('git', ['-C', base, 'config', 'tag.gpgsign', 'false'], q);
  spawnSync('git', ['-C', base, 'config', 'core.hooksPath', '/dev/null'], q);
  spawnSync('git', ['-C', base, 'add', '-A'], q);
  const commit = spawnSync('git', ['-C', base, 'commit', '--no-verify', '-m', 'init'], {
    encoding: 'utf-8',
  });
  assert.equal(commit.status, 0, `fixture commit must succeed: ${commit.stderr}`);
  if (tag) {
    const t = spawnSync('git', ['-C', base, 'tag', tag], { encoding: 'utf-8' });
    assert.equal(t.status, 0, `fixture tag must succeed: ${t.stderr}`);
  }
}

test('clean tagged pkgRoot → pass (not a dev checkout)', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-tagged-'));
    try {
      initGitRepo(base, { tag: 'v1.0.0' });
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '1.0.0' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const kindCheck = out.find((c) => c.label === 'hypo-pkg.json pkgRoot install kind');
      assert.ok(kindCheck, 'install kind check not found');
      assert.equal(kindCheck.status, 'pass', `a clean tagged checkout must pass: ${r.stdout}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('clean but untagged pkgRoot → warn on the tag reason alone (not dirtiness)', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-untagged-'));
    try {
      initGitRepo(base); // committed, clean tree, no tag
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '1.0.0' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const kindCheck = out.find((c) => c.label === 'hypo-pkg.json pkgRoot install kind');
      assert.ok(kindCheck, 'install kind check not found');
      assert.equal(kindCheck.status, 'warn', `a clean untagged checkout must warn: ${r.stdout}`);
      assert.match(kindCheck.detail, /release tag/, 'the reason must be the missing tag');
      assert.doesNotMatch(
        kindCheck.detail,
        /uncommitted/,
        'a clean tree must not be reported as having uncommitted changes',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test('pkgRoot has .git but git cannot be run → warn "cannot classify" (not mislabeled untagged)', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-nogit-'));
    try {
      writeFileSync(
        join(base, 'package.json'),
        JSON.stringify({ name: 'hypomnema', version: '1.0.0' }),
      );
      mkdirSync(join(base, '.git')); // enters the dev-repo branch, but git can't run
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '1.0.0' }),
      );
      // Empty PATH so the child's `git` spawn fails with ENOENT. doctor runs via an
      // absolute node path, so it still starts; other external-dep probes just
      // report missing without crashing.
      const emptyPath = mkdtempSync(join(tmpdir(), 'hypo-emptypath-'));
      const r = spawnSync(
        process.execPath,
        [join(SCRIPTS, 'doctor.mjs'), `--hypo-dir=${NONEXISTENT_WIKI}`, '--json'],
        {
          encoding: 'utf-8',
          env: { ...process.env, HYPO_DIR: '', HOME: home, PATH: emptyPath },
        },
      );
      rmSync(emptyPath, { recursive: true, force: true });
      const out = JSON.parse(r.stdout);
      const kindCheck = out.find((c) => c.label === 'hypo-pkg.json pkgRoot install kind');
      assert.ok(kindCheck, 'install kind check not found');
      assert.equal(kindCheck.status, 'warn', `git-unavailable must warn: ${r.stdout}`);
      assert.match(
        kindCheck.detail,
        /cannot classify/,
        'must say it cannot classify, not mislabel as untagged',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

// The distinct branch from the ENOENT case above: git IS runnable, but `git status`
// itself exits nonzero because the repo is corrupt/inaccessible (an invalid .git).
// That must also be "cannot classify", not a mislabel as an untagged dev checkout.
test('pkgRoot .git is corrupt so git status exits nonzero → warn "cannot classify"', () => {
  withTmpHome((home) => {
    const base = mkdtempSync(join(tmpdir(), 'hypo-pkgroot-corruptgit-'));
    try {
      writeFileSync(
        join(base, 'package.json'),
        JSON.stringify({ name: 'hypomnema', version: '1.0.0' }),
      );
      mkdirSync(join(base, '.git')); // an empty .git dir → `git status` exits 128
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: base, pkgVersion: '1.0.0' }),
      );
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const kindCheck = out.find((c) => c.label === 'hypo-pkg.json pkgRoot install kind');
      assert.ok(kindCheck, 'install kind check not found');
      assert.equal(kindCheck.status, 'warn', `corrupt-repo git status must warn: ${r.stdout}`);
      assert.match(
        kindCheck.detail,
        /cannot classify/,
        'a nonzero git status (corrupt repo) must be cannot-classify, not untagged',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
