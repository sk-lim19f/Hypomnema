// tests/doctor.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  cpSync,
  readFileSync,
  renameSync,
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
  SESSION_TMP_HOME,
  gitHead,
  gitRepo,
  run,
  runWithHome,
  withTmpDir,
  withTmpHome,
} from './helpers.mjs';
import { PROVENANCE_FILENAME, EXPECTED_PKG_NAME } from '../scripts/lib/pkg-provenance.mjs';
import {
  resolveEnabledPluginRoot,
  resolveEnabledPluginEntry,
  resolvePluginChannel,
  leafVersionDrift,
} from '../scripts/lib/plugin-detect.mjs';

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

// A안: .hyposcanignore is optional — presence/absence is info-level (pass
// either way), never warn/fail.
suite('doctor.mjs — .hyposcanignore info-level check (A안)');

test('doctor passes File: .hyposcanignore when absent (optional file)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    rmSync(join(hypoDir, '.hyposcanignore'), { force: true });
    const r = run('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json']);
    const checks = JSON.parse(r.stdout);
    const check = checks.find((c) => c.label === 'File: .hyposcanignore');
    assert.ok(check, 'doctor should report a File: .hyposcanignore check');
    assert.equal(check.status, 'pass', `absent .hyposcanignore must not warn/fail: ${r.stdout}`);
  });
});

test('doctor passes File: .hyposcanignore when present', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const initR = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
    assert.ok(existsSync(join(hypoDir, '.hyposcanignore')), 'init should scaffold it');
    const r = run('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json']);
    const checks = JSON.parse(r.stdout);
    const check = checks.find((c) => c.label === 'File: .hyposcanignore');
    assert.equal(check.status, 'pass');
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

// A merge --abort that itself fails ('conflict-unresolved', syncRemote) is the
// MORE dangerous of the two conflict ops: the tree may still be half-merged
// (unmerged index entries / an in-progress MERGE_HEAD). It must NOT get the
// plain-conflict wording, which (a) claims "your local work is committed" —
// untrue when the abort itself failed — and (b) tells the user to run
// `git pull --no-rebase`, which git would simply refuse mid-merge. Distinct,
// dedicated guidance is required, matching hypo-session-start.mjs's
// syncStateNotice so the two surfaces never contradict each other.
test('doctor-sync-state-warn: conflict-unresolved entry → dedicated half-merged-tree guidance, distinct from a clean conflict', () => {
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
        op: 'conflict-unresolved',
        error: 'fatal: merge --abort failed',
        host: 'test',
      }) + '\n',
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(
      /diverged/.test(check.detail) && /half-merged/.test(check.detail),
      `conflict-unresolved must warn about a possibly half-merged tree, not the plain-conflict wording: ${check.detail}`,
    );
    assert.ok(
      // /i: doctor.mjs capitalizes the sentence ("Your local work is
      // committed"), so a case-sensitive negative match here would pass
      // unconditionally and catch nothing if the swallow were reintroduced.
      !/your local work is committed/i.test(check.detail),
      `conflict-unresolved must NOT reuse the clean-conflict "committed and safe" claim (the abort itself failed): ${check.detail}`,
    );
    assert.ok(
      !/pull --no-rebase/.test(check.detail),
      `conflict-unresolved must not advise a plain \`git pull --no-rebase\` — git would refuse it mid-merge: ${check.detail}`,
    );
  });
});

// A `conflict*` op this check has no dedicated branch for (a future
// syncRemote failure mode, neither 'conflict' nor 'conflict-unresolved')
// must not default into the plain-conflict "committed" reassurance via a
// startsWith('conflict') fallback — that claim is not known to hold for an
// unrecognized op, and neither is 'conflict-unresolved''s "the abort failed".
// Report the state as unknown and treat it as unresolved instead.
test('doctor-sync-state-warn: unrecognized conflict-* op → conservative unresolved guidance, no borrowed claim', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({
        timestamp: '2026-08-05T00:00:00Z',
        op: 'conflict-future-op',
        error: 'unrecognized failure mode',
        host: 'test',
      }) + '\n',
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(
      /diverged/.test(check.detail) && /unresolved/.test(check.detail),
      `unrecognized conflict-* op must warn as unresolved: ${check.detail}`,
    );
    assert.ok(
      !/your local work is committed/i.test(check.detail),
      `unrecognized conflict-* op must NOT borrow the clean-conflict "committed" claim: ${check.detail}`,
    );
    assert.ok(
      !/automatic merge-abort failed/i.test(check.detail),
      `unrecognized conflict-* op must NOT borrow the conflict-unresolved "abort failed" claim: ${check.detail}`,
    );
  });
});

// FEAT-34: last-success timestamp visibility in the sync-state check.
suite('doctor.mjs — FEAT-34: sync-last-success visibility');

function syncFixtureWiki(dir) {
  writeFileSync(join(dir, 'hypo-config.md'), '# config');
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  mkdirSync(join(dir, 'sources'), { recursive: true });
}

test('doctor-sync-last-success: no success file, no failures → never synced (not unqualified healthy)', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
    assert.ok(
      /never synced/.test(check.detail),
      `absent success record must say "never synced", not an unqualified healthy message: ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: pull-only record → reports pull time, notes push missing', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-last-success.json'),
      JSON.stringify({ pull: { timestamp: '2026-07-20T00:00:00.000Z', host: 'test-host' } }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
    assert.ok(
      check.detail.includes('2026-07-20T00:00:00.000Z') && check.detail.includes('test-host'),
      `pull success time/host must be reported: ${check.detail}`,
    );
    assert.ok(
      /push: none recorded/.test(check.detail),
      `push-absent must be called out distinctly, not implied: ${check.detail}`,
    );
    assert.ok(
      !/never synced/.test(check.detail),
      `a pull-only record is not "never synced": ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: push-only record → reports push time, notes pull missing', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-last-success.json'),
      JSON.stringify({ push: { timestamp: '2026-07-19T12:00:00.000Z', host: 'other-host' } }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
    assert.ok(
      check.detail.includes('2026-07-19T12:00:00.000Z') && check.detail.includes('other-host'),
      `push success time/host must be reported: ${check.detail}`,
    );
    assert.ok(
      /pull: none recorded/.test(check.detail),
      `pull-absent must be called out distinctly: ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: corrupt sync-last-success.json → warn, not crash', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'sync-last-success.json'), 'not-json{{{');
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    assert.ok(r.status !== null && r.status <= 1, `doctor must not crash: exit ${r.status}`);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `corrupt success file must warn: ${check.detail}`);
    assert.ok(
      /sync-last-success\.json/.test(check.detail),
      `warn must name the offending file: ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: malformed pull/push record (schema-valid JSON, wrong shape) → warn, not "undefined (undefined)"', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    // Parseable JSON, but `pull` is a string instead of {timestamp, host} —
    // must not render as `pull undefined (undefined)`.
    writeFileSync(
      join(dir, '.cache', 'sync-last-success.json'),
      JSON.stringify({ pull: 'not-a-record' }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `malformed success record must warn: ${check.detail}`);
    assert.ok(
      !/undefined/.test(check.detail),
      `malformed record must never render "undefined": ${check.detail}`,
    );
    assert.ok(
      /sync-last-success\.json/.test(check.detail),
      `warn must name the offending file: ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: empty-string timestamp/host → warn, not a false "pull ()" pass', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    // typeof === 'string' is true for '', so a naive check would accept this
    // and render "pull  ()" as a healthy pass.
    writeFileSync(
      join(dir, '.cache', 'sync-last-success.json'),
      JSON.stringify({ pull: { timestamp: '', host: '' } }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `empty timestamp/host must warn, not pass: ${check.detail}`);
    assert.ok(
      !/pull \(\)|pull\s*$/.test(check.detail),
      `must not render an empty "pull ()" as if it were a real record: ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: unrecognized top-level key → warn, not silently ignored', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-last-success.json'),
      JSON.stringify({
        pull: { timestamp: '2026-07-20T00:00:00.000Z', host: 'test-host' },
        unexpectedKey: 'hand-edit or foreign writer',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(
      check.status,
      'warn',
      `an unrecognized top-level key must warn, not be silently ignored: ${check.detail}`,
    );
  });
});

test('doctor-sync-last-success: unresolved failure keeps its core message and now also names the last success', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'sync-last-success.json'),
      JSON.stringify({ pull: { timestamp: '2026-07-20T00:00:00.000Z', host: 'test-host' } }),
    );
    writeFileSync(
      join(dir, '.cache', 'sync-state.json'),
      JSON.stringify({
        timestamp: '2026-07-20T01:00:00Z',
        op: 'push',
        error: 'network timeout',
        host: 'test',
      }) + '\n',
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    // FEAT-34 originally left this branch silent about last-success (a push
    // failure hid an otherwise-healthy pull). The core message shape from the
    // pre-existing "open sync-state.json entries → warn" test still holds —
    // this only asserts the ADDITION, not a replacement.
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(
      /unresolved failure\(s\) — last: push at 2026-07-20T01:00:00Z/.test(check.detail),
      `unresolved-failure core message must survive unchanged: ${check.detail}`,
    );
    assert.ok(
      check.detail.includes('Last success') &&
        check.detail.includes('2026-07-20T00:00:00.000Z') &&
        check.detail.includes('test-host'),
      `a failing op must not hide that the OTHER op last succeeded: ${check.detail}`,
    );
  });
});

test('doctor-sync-state-warn: multiple unresolved entries are listed, not just the last one', () => {
  withTmpDir((dir) => {
    syncFixtureWiki(dir);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const lines = [
      { timestamp: '2026-07-20T01:00:00Z', op: 'push', error: 'network timeout', host: 'test' },
      { timestamp: '2026-07-20T02:00:00Z', op: 'pull', error: 'connection refused', host: 'test' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    writeFileSync(join(dir, '.cache', 'sync-state.json'), lines + '\n');
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Sync state');
    assert.ok(check, 'Sync state check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(
      check.detail.includes('push@2026-07-20T01:00:00Z') &&
        check.detail.includes('pull@2026-07-20T02:00:00Z'),
      `both unresolved entries must be named, not just the last: ${check.detail}`,
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

// Close is a set of user-visible artifacts (a 마감 heading, a closing hot.md
// narrative, a close-worded commit), not just the session-closed marker — a
// close done by hand, without crystallize, never trips the marker-writer hard
// gate. This is a post-hoc, warning-only surface, not a second gate.
suite('doctor.mjs — session-close artifacts without a matching marker');

// A real init (hooks installed, extensions baseline scaffolded) so doctor
// itself reports zero OTHER failures — the fixtures used elsewhere in this
// file skip that scaffold, which is fine for a check found by label, but
// leaves the whole run pre-failed and makes an exit-code assertion (CONCERN:
// warn-only must not exit nonzero) meaningless.
function baseWiki(dir) {
  const initR = run('init.mjs', [`--hypo-dir=${dir}`, '--no-git-init']);
  assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
}

function runDoctorJson(dir) {
  const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
  return { r, out: JSON.parse(r.stdout) };
}

function doctorCloseArtifactCheck(dir) {
  const { out } = runDoctorJson(dir);
  return out.find((c) => c.label === 'Session-close artifacts');
}

// Dates in this suite move with "now", never a fixed calendar date —
// production ignores any marker older than 7 days
// (SESSION_CLOSED_MARKER_STALE_MS, hooks/hypo-shared.mjs), so a fixture
// pinned to a past date silently stops covering its own artifact once that
// window passes (a "covering marker → pass" test would start reporting
// warn). UTC is the portable anchor: a file-content artifact's date only
// needs to equal ONE of the marker's {local, utc} days (localAndUtcDates,
// hooks/hypo-shared.mjs), and the UTC day is always one of them regardless
// of the host's own timezone — so pinning both the heading date and
// `closed_at` to the same UTC day needs no TZ control. The one test that
// specifically exercises the local/UTC boundary controls TZ explicitly
// instead (below).
function recentUtcIso(daysAgo, hourUtc = 12) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}
function recentUtcDate(daysAgo, hourUtc = 12) {
  return recentUtcIso(daysAgo, hourUtc).slice(0, 10);
}

test('doctor-close-artifacts: no close artifacts anywhere → pass', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('doctor-close-artifacts: session-state.md 마감 heading with no session-closed marker → warn, exit 0', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(13번째 세션).** 세 스트림을 처음으로 병렬로 굴렸다.\n`,
    );
    const { r, out } = runDoctorJson(dir);
    const check = out.find((c) => c.label === 'Session-close artifacts');
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check?.detail}`);
    assert.ok(
      check.detail.includes('session-state.md'),
      `expected the artifact file named: ${check.detail}`,
    );
    // warning-only contract: this check alone must never fail doctor's exit code.
    assert.equal(r.status, 0, `warn must not exit nonzero: ${r.stdout}\n${r.stderr}`);
  });
});

test('doctor-close-artifacts: v4 marker WITH a `projects` array covering the project + date → pass', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(13번째 세션).** 세 스트림을 처음으로 병렬로 굴렸다.\n`,
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-abc123.marker'),
      JSON.stringify({
        session_id: 'abc123',
        project: 'demo',
        projects: ['demo'],
        closed_at: recentUtcIso(1),
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check?.detail}`);
  });
});

// A legacy marker's flat `project` field can be a recency-derived
// misattribution (the same reason resolveCloseScope refuses to trust it
// uncorroborated — hooks/hypo-shared.mjs resolveCloseScope doc comment).
// doctor has no corroborating signal of its own, so a marker carrying ONLY
// the legacy field (no `projects` array) must NOT count as scope evidence —
// trusting it would silently re-open the exact masking BLOCKER this
// per-project correlation exists to close.
test('doctor-close-artifacts: legacy marker with ONLY a flat `project` (no `projects` array) does not count as evidence → warn', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(13번째 세션).** 세 스트림을 처음으로 병렬로 굴렸다.\n`,
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-legacy.marker'),
      JSON.stringify({
        session_id: 'legacy',
        project: 'demo', // flat field only — no `projects` array
        closed_at: recentUtcIso(1),
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'warn',
      `an uncorroborated legacy flat project must not vouch for scope: ${check?.detail}`,
    );
  });
});

// The marker exists specifically for per-session/per-project precision
// (hooks/hypo-shared.mjs SESSION_CLOSED_MARKER_STALE_MS comment) — a
// same-day marker for an UNRELATED project must not silence an unapproved
// close in THIS project. A date-only correlation would wrongly pass this.
test("doctor-close-artifacts: a DIFFERENT project's same-day marker does not mask this project's unapproved close → warn", () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    mkdirSync(join(dir, 'projects', 'project-a'), { recursive: true });
    const projB = join(dir, 'projects', 'project-b');
    mkdirSync(projB, { recursive: true });
    writeFileSync(
      join(projB, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(1번째 세션).** project-b를 마무리했다.\n`,
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    // A genuinely-gated close, same day, but for project-a — must not cover project-b.
    writeFileSync(
      join(dir, '.cache', 'session-closed-legit.marker'),
      JSON.stringify({
        session_id: 'legit',
        project: 'project-a',
        projects: ['project-a'],
        closed_at: recentUtcIso(1),
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'warn',
      `a different project's marker must not mask this one: ${check?.detail}`,
    );
    assert.ok(
      check.detail.includes('project-b'),
      `expected project-b's artifact named: ${check.detail}`,
    );
  });
});

// closed_at is UTC; a heading date is written in the user's LOCAL zone
// (crystallize.mjs todayLocal()). Force the child's TZ so the KST-midnight
// case (UTC day ≠ local day) is deterministic regardless of the host's own
// timezone.
function runDoctorJsonInTz(dir, tz) {
  const r = spawnSync(
    process.execPath,
    [join(SCRIPTS, 'doctor.mjs'), `--hypo-dir=${dir}`, '--json'],
    {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME, TZ: tz },
    },
  );
  return { r, out: JSON.parse(r.stdout) };
}

test('doctor-close-artifacts: KST-local-date marker for a UTC-previous-day closed_at → pass (no false warn)', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    // ~1 day ago, pinned to 15:30 UTC — in Asia/Seoul (UTC+9, no DST) that
    // instant is 00:30 the FOLLOWING calendar day, so its UTC day and its
    // KST day always differ by exactly one, regardless of what "now" is. A
    // real KST user closing right after midnight would stamp the KST
    // (local) date in the heading, computed here via Intl rather than a
    // fixed offset so it stays correct regardless of the HOST's own timezone.
    const instant = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    instant.setUTCHours(15, 30, 0, 0);
    const kstDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
    writeFileSync(
      join(projDir, 'session-state.md'),
      `> **${kstDate} 마감(1번째 세션).** 자정 직후 닫았다.\n`,
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-midnight.marker'),
      JSON.stringify({
        session_id: 'midnight',
        project: 'demo',
        projects: ['demo'],
        closed_at: instant.toISOString(), // UTC day = instant's day, KST day = +1
      }),
    );
    const { r, out } = runDoctorJsonInTz(dir, 'Asia/Seoul');
    const check = out.find((c) => c.label === 'Session-close artifacts');
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'pass',
      `local/UTC day mismatch must not false-warn a real close: ${check?.detail}`,
    );
    assert.equal(r.status, 0, `pass must exit 0: ${r.stdout}\n${r.stderr}`);
  });
});

// Root session-state.md carries the same 마감-heading convention as a
// project's (init.mjs installs one at the wiki root) — a hand-made root
// close must not have a blind spot just because it isn't under projects/.
test('doctor-close-artifacts: ROOT session-state.md 마감 heading, no marker, no project files → warn', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    writeFileSync(
      join(dir, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(1번째 세션).** 루트에서 손으로 닫았다.\n`,
    );
    const { r, out } = runDoctorJson(dir);
    const check = out.find((c) => c.label === 'Session-close artifacts');
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check?.detail}`);
    assert.equal(r.status, 0, `warn must not exit nonzero: ${r.stdout}\n${r.stderr}`);
  });
});

// Real close never writes root session-state.md (closeFileTargets in
// hooks/hypo-shared.mjs only lists hot.md/log.md + the active project's own
// files) — so unlike root hot.md, NO marker legitimately corroborates it,
// even a real, same-day, properly-scoped one for an actual project.
test('doctor-close-artifacts: ROOT session-state.md is never covered by ANY marker, even a real same-day one → warn', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    writeFileSync(
      join(dir, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(1번째 세션).** 루트에서 손으로 닫았다.\n`,
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-real.marker'),
      JSON.stringify({
        session_id: 'real',
        projects: ['some-project'],
        closed_at: recentUtcIso(1),
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'warn',
      `root session-state.md must never be covered by any marker: ${check?.detail}`,
    );
  });
});

// A merge or a multi-project commit can touch more than one project — the
// close-worded message must then be verified against ALL of them, not
// silently attributed to whichever one a marker happens to name.
function commitTouchingProjects(dir, projects, message, isoDate) {
  for (const p of projects) {
    mkdirSync(join(dir, 'projects', p), { recursive: true });
    writeFileSync(join(dir, 'projects', p, 'hot.md'), `# ${p}\n`);
  }
  spawnSync('git', ['-C', dir, 'add', '-A']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', message], {
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

test('doctor-close-artifacts: a commit touching TWO projects, marker covers only ONE → warn', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    gitRepo(dir);
    commitTouchingProjects(
      dir,
      ['project-a', 'project-b'],
      'session: close the session for project-a and project-b',
      recentUtcIso(1),
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-partial.marker'),
      JSON.stringify({
        session_id: 'partial',
        projects: ['project-a'], // project-b is NOT covered
        closed_at: recentUtcIso(1),
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'warn',
      `partial project coverage must still warn (project-b uncovered): ${check?.detail}`,
    );
  });
});

test('doctor-close-artifacts: a commit touching TWO projects, marker covers BOTH → pass', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    gitRepo(dir);
    commitTouchingProjects(
      dir,
      ['project-a', 'project-b'],
      'session: close the session for project-a and project-b',
      recentUtcIso(1),
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-full.marker'),
      JSON.stringify({
        session_id: 'full',
        projects: ['project-a', 'project-b'],
        closed_at: recentUtcIso(1),
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'pass', `both projects covered must pass: ${check?.detail}`);
  });
});

// A `projects/project-a/... → projects/project-b/...` RENAME is reported by
// git as touching only the DESTINATION under a plain `--name-only` diff — the
// origin project silently drops out of scope, and a marker naming only the
// destination would then wrongly cover the whole commit. deriveCommitProjects
// must see BOTH sides of a rename (git show --name-status -M).
test('doctor-close-artifacts: a commit that RENAMES a file from project-a to project-b requires BOTH projects covered → warn', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    gitRepo(dir);
    mkdirSync(join(dir, 'projects', 'project-a'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'project-a', 'hot.md'), '# project-a\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    const seedIso = recentUtcIso(2);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed'], {
      env: { ...process.env, GIT_AUTHOR_DATE: seedIso, GIT_COMMITTER_DATE: seedIso },
    });
    mkdirSync(join(dir, 'projects', 'project-b'), { recursive: true });
    renameSync(
      join(dir, 'projects', 'project-a', 'hot.md'),
      join(dir, 'projects', 'project-b', 'hot.md'),
    );
    spawnSync('git', ['-C', dir, 'add', '-A']);
    const renameIso = recentUtcIso(1);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'session: close the session'], {
      env: { ...process.env, GIT_AUTHOR_DATE: renameIso, GIT_COMMITTER_DATE: renameIso },
    });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    // Names only the destination — project-a (the rename's origin) is NOT covered.
    writeFileSync(
      join(dir, '.cache', 'session-closed-rename.marker'),
      JSON.stringify({
        session_id: 'rename',
        projects: ['project-b'],
        closed_at: renameIso,
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'warn',
      `a rename's origin project (project-a) must still require coverage: ${check?.detail}`,
    );
  });
});

// doctor reads marker files directly (not through readSessionClosedMarker),
// so its OWN staleness enforcement is a separate code path from the shared
// reader's — this exercises that path specifically, not the shared one
// close-signals.test.mjs already covers.
test('doctor-close-artifacts: a raw marker older than the 7-day staleness window is not usable evidence → warn', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldDate = eightDaysAgo.toISOString().slice(0, 10);
    writeFileSync(
      join(projDir, 'session-state.md'),
      `> **${oldDate} 마감(1번째 세션).** 오래 전에 닫았다.\n`,
    );
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-stale.marker'),
      JSON.stringify({
        session_id: 'stale',
        projects: ['demo'],
        closed_at: eightDaysAgo.toISOString(), // same day as the artifact, but >7d old
      }),
    );
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(
      check.status,
      'warn',
      `an expired marker must not vouch for a same-age artifact: ${check?.detail}`,
    );
  });
});

test('doctor-close-artifacts: close-worded commit message with no marker → warn (git-history signal)', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    gitRepo(dir);
    writeFileSync(join(dir, 'note.md'), '# note\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', [
      '-C',
      dir,
      'commit',
      '-q',
      '-m',
      'session: close the thirteenth session, first parallel three-stream run',
    ]);
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check?.detail}`);
  });
});

test('doctor-close-artifacts: an ordinary commit message never matches → pass', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    gitRepo(dir);
    writeFileSync(join(dir, 'note.md'), '# note\n');
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'docs: fix a typo in note.md']);
    const check = doctorCloseArtifactCheck(dir);
    assert.ok(check, 'check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check?.detail}`);
  });
});

// CONCERN: an unreadable .cache/ must not crash the check (and flip the exit
// code via an uncaught throw) — it should read as "no usable marker
// evidence", i.e. same as no markers at all.
test('doctor-close-artifacts: unreadable .cache/ does not crash — degrades to no-marker-evidence', () => {
  withTmpDir((dir) => {
    baseWiki(dir);
    const projDir = join(dir, 'projects', 'demo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'session-state.md'),
      `> **${recentUtcDate(1)} 마감(13번째 세션).** 세 스트림을 처음으로 병렬로 굴렸다.\n`,
    );
    const cacheDir = join(dir, '.cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'session-closed-x.marker'), '{}');
    chmodSync(cacheDir, 0o000);
    try {
      const { r, out } = runDoctorJson(dir);
      assert.ok(r.status === 0 || r.status === 1, `doctor must not crash: ${r.stderr}`);
      const check = out.find((c) => c.label === 'Session-close artifacts');
      assert.ok(check, 'check not found');
      assert.equal(
        check.status,
        'warn',
        `unreadable cache degrades to no evidence: ${check?.detail}`,
      );
    } finally {
      chmodSync(cacheDir, 0o755);
    }
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

// ── 'Incomplete rename' — .cache/rename-in-progress.json detection ────────────
//
// rename.mjs writes this marker before its first inbound-link rewrite and
// removes it after the terminal move (see tests/rename-wikilink.test.mjs's
// "crash-recovery marker" suite, which owns rename.mjs's write/clear side).
// This suite owns doctor.mjs's READ side: report shape when the marker is
// absent, well-formed, or present-but-broken.

suite("doctor.mjs — 'Incomplete rename' marker detection");

function markerFixtureWiki(dir) {
  writeFileSync(join(dir, 'hypo-config.md'), '# config');
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  mkdirSync(join(dir, 'sources'), { recursive: true });
  mkdirSync(join(dir, '.cache'), { recursive: true });
}

test('no marker file → Incomplete rename passes', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Incomplete rename');
    assert.ok(check, 'Incomplete rename check not found');
    assert.equal(check.status, 'pass', `expected pass with no marker: ${check.detail}`);
  });
});

test('a well-formed marker → warn naming from/to and a runnable re-run command', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    // codex BLOCKER 2: doctor now cross-checks from/to against the filesystem to
    // tell a genuinely-stuck rename apart from a finished one whose marker just
    // never got cleared. `from` present + `to` absent is what "genuinely
    // mid-rename, --from still resolves" actually looks like — without this the
    // fixture named neither path and fell into the (correct, but different)
    // "cannot tell" branch instead of the re-run branch this test means to pin.
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-08-04T00:00:00.000Z',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Incomplete rename');
    assert.ok(check, 'Incomplete rename check not found');
    assert.equal(check.status, 'warn', `expected warn with a marker present: ${check.detail}`);
    assert.ok(
      check.detail.includes('pages/foo.md'),
      `detail must name the from-page: ${check.detail}`,
    );
    assert.ok(
      check.detail.includes('pages/bar.md'),
      `detail must name the to-page: ${check.detail}`,
    );
    assert.ok(
      /node .*rename\.mjs .*--from=pages\/foo\.md .*--to=pages\/bar\.md .*--apply/.test(
        check.detail,
      ),
      `detail must include an exact runnable re-run command: ${check.detail}`,
    );
  });
});

// The fail-open case the coordinator caught: readRenameMarker collapses "no
// file" and "unreadable file" to the same null, so checkIncompleteRename must
// ask existsSync() separately and never let a present-but-broken marker fall
// through to the "no marker" pass branch.
test('marker file exists but is invalid JSON → warn, not pass', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    writeFileSync(join(dir, '.cache', 'rename-in-progress.json'), '{oops');
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Incomplete rename');
    assert.ok(check, 'Incomplete rename check not found');
    assert.equal(
      check.status,
      'warn',
      `a present-but-corrupt marker must warn, not silently pass: ${check.detail}`,
    );
  });
});

test('marker file parses but is missing from/to → warn, not pass', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    writeFileSync(join(dir, '.cache', 'rename-in-progress.json'), JSON.stringify({}));
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Incomplete rename');
    assert.ok(check, 'Incomplete rename check not found');
    assert.equal(
      check.status,
      'warn',
      `a present marker missing from/to must warn, not silently pass: ${check.detail}`,
    );
  });
});

// codex BLOCKER 2 (three-state read side): a marker whose `from` no longer
// exists but whose `to` does is a FINISHED rename, not a stuck one — the move
// (renameSync) is the terminal step and the marker only clears after it, so a
// crash right there is exactly the "done, marker leftover" state. The prior
// single-branch warn always said "re-run", which fails here (--from no longer
// resolves). Reproducing the real SIGKILL window is covered in
// rename-wikilink.test.mjs (owns the KILL_RENAME harness); this pins doctor's
// own read-side classification directly off a hand-built marker + fs state.
test('marker present, from gone, to exists (move finished, marker leftover) → warn "clean up", not "re-run"', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    writeFileSync(join(dir, 'pages', 'bar.md'), '---\ntitle: bar\n---\nbar page\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-08-01T00:00:00.000Z',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Incomplete rename');
    assert.ok(check, 'Incomplete rename check not found');
    assert.equal(
      check.status,
      'warn',
      `stale-but-finished marker must still warn: ${check.detail}`,
    );
    assert.ok(
      !/re-run/i.test(check.detail),
      `must not suggest a re-run that would fail (--from no longer resolves): ${check.detail}`,
    );
    assert.ok(
      /delete|clean|remove/i.test(check.detail),
      `must point at deleting the leftover marker: ${check.detail}`,
    );
  });
});

// The genuine in-progress case still gets the re-run guidance — this pins the
// OTHER branch of the three-state split so a fix to the stale branch can't
// silently regress this one.
test('marker present, from exists, to absent (genuinely mid-rename) → warn with a re-run command', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-08-01T00:00:00.000Z',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Incomplete rename');
    assert.equal(check.status, 'warn');
    assert.ok(
      /re-run/i.test(check.detail) && /--apply/.test(check.detail),
      `genuinely-stuck marker must still suggest the re-run: ${check.detail}`,
    );
  });
});

// codex CONCERN 3: a legacy/custom vault whose .gitignore predates
// templates/gitignore's `.cache/` entry can let `git add -A` commit this
// marker, producing a ghost warning on a machine that never ran a rename.
// Advisory only, and additive to whichever branch above fires.
suite("doctor.mjs — 'Incomplete rename' gitignore advisory (CONCERN 3)");

test('marker in a git repo that does NOT ignore .cache/ → doctor appends a gitignore hint', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    gitRepo(dir);
    // No .gitignore at all — .cache/ is not excluded.
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-08-01T00:00:00.000Z',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Incomplete rename');
    assert.equal(check.status, 'warn');
    assert.ok(
      /gitignore/i.test(check.detail) && check.detail.includes('.cache/'),
      `un-ignored .cache/ in a git repo must get a gitignore hint: ${check.detail}`,
    );
  });
});

test('marker in a git repo that DOES ignore .cache/ → no gitignore hint', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir);
    gitRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-08-01T00:00:00.000Z',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Incomplete rename');
    assert.equal(check.status, 'warn');
    assert.ok(
      !/gitignore/i.test(check.detail),
      `a properly-ignored .cache/ must not get the gitignore hint: ${check.detail}`,
    );
  });
});

test('marker in a non-git vault → no gitignore hint, no crash', () => {
  withTmpDir((dir) => {
    markerFixtureWiki(dir); // no gitRepo(dir) — no .git at all
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-08-01T00:00:00.000Z',
      }),
    );
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    assert.ok(
      r.status !== null && r.status <= 1,
      `doctor must not crash on a non-git vault: ${r.stdout}${r.stderr}`,
    );
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Incomplete rename');
    assert.equal(check.status, 'warn');
    assert.ok(
      !/gitignore/i.test(check.detail),
      `non-git vault must get no gitignore hint: ${check.detail}`,
    );
  });
});

// ── ISSUE-80: provenance sidecar check (scripts/doctor.mjs's checkProvenanceSidecar) ──
// Absent is a normal, silent state (plugin/dev channels never write one; so does
// a manual install predating this check). Present is either verified (pass) or
// broken (warn, never fail — a broken sidecar just degrades PKG_ROOT to null,
// which the SessionStart PKG_ROOT-null banner surfaces instead).
suite('doctor.mjs — provenance sidecar check (ISSUE-80)');

test('no sidecar at all (fresh install) → no check reported', () => {
  withTmpHome((home) => {
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
    assert.equal(check, undefined, 'an absent sidecar must not be reported at all');
  });
});

test('a verified sidecar (written by init) → pass', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
      assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
      assert.equal(check.status, 'pass', `a freshly-written sidecar must verify: ${check.detail}`);
      assert.match(check.detail, /verified/);
    });
  });
});

test('corrupt sidecar JSON → warn', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const sidecarPath = join(home, '.claude', 'hooks', '.hypo-provenance.json');
      writeFileSync(sidecarPath, '{not json');
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
      assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
      assert.equal(check.status, 'warn', `corrupt JSON must warn, not pass/fail: ${check.detail}`);
      assert.match(check.detail, /not valid JSON/);
    });
  });
});

test('sidecar pkgRoot package.json name != "hypomnema" → warn', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const foreignRoot = mkdtempSync(join(tmpdir(), 'hypo-foreign-root-'));
      try {
        writeFileSync(
          join(foreignRoot, 'package.json'),
          JSON.stringify({ name: 'not-hypomnema', version: '1.0.0' }),
        );
        const sidecarPath = join(home, '.claude', 'hooks', '.hypo-provenance.json');
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
        sidecar.pkgRoot = foreignRoot;
        writeFileSync(sidecarPath, JSON.stringify(sidecar));
        const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
        const out = JSON.parse(r.stdout);
        const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
        assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
        assert.equal(check.status, 'warn', `a foreign pkgRoot must warn: ${check.detail}`);
        assert.match(check.detail, /is not this package/);
      } finally {
        rmSync(foreignRoot, { recursive: true, force: true });
      }
    });
  });
});

test('sidecar hypoSharedSha256 mismatch → warn', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const sidecarPath = join(home, '.claude', 'hooks', '.hypo-provenance.json');
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      sidecar.hypoSharedSha256 = 'deadbeef'.repeat(8);
      writeFileSync(sidecarPath, JSON.stringify(sidecar));
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
      assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
      assert.equal(check.status, 'warn', `a hash mismatch must warn: ${check.detail}`);
      assert.match(check.detail, /does not match the installed hypo-shared\.mjs/);
    });
  });
});

test('--codex flag: a verified codex-side sidecar (written by upgrade --apply --codex) → pass', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const upR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(upR.status, 0, `upgrade --apply --codex failed: ${upR.stderr}`);
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--codex', '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'Codex hooks/.hypo-provenance.json');
      assert.ok(check, 'expected a Codex hooks/.hypo-provenance.json check');
      assert.equal(check.status, 'pass', `codex sidecar must verify: ${check.detail}`);
    });
  });
});

// CONCERN 1 (fix/pkgroot-provenance codex review): the sidecar filename and
// producer-name check are duplicated byte-for-byte between
// hooks/hypo-shared.mjs (a private const — hooks can't import scripts/) and
// scripts/lib/pkg-provenance.mjs (the exported source of truth). A source
// scan, not a shared import, is the only way to bind them: importing
// hooks/hypo-shared.mjs's PKG_ROOT here would run selfLocationPkgRoot()
// against THIS test file's own checkout, an unrelated side effect. Follows
// the same read-source-as-text pattern as tests/proposal-base.test.mjs's
// "publishes the lock by linking" test.
test('CONCERN 1: PROVENANCE_FILENAME/EXPECTED_PKG_NAME stay byte-identical between hooks/hypo-shared.mjs and scripts/lib/pkg-provenance.mjs', () => {
  const sharedSrc = readFileSync(join(REPO, 'hooks', 'hypo-shared.mjs'), 'utf-8');
  const filenameMatch = sharedSrc.match(/const PROVENANCE_FILENAME = '([^']+)'/);
  const nameMatch = sharedSrc.match(/const EXPECTED_PKG_NAME = '([^']+)'/);
  assert.ok(
    filenameMatch,
    'hooks/hypo-shared.mjs must define PROVENANCE_FILENAME as a plain string literal',
  );
  assert.ok(
    nameMatch,
    'hooks/hypo-shared.mjs must define EXPECTED_PKG_NAME as a plain string literal',
  );
  assert.equal(
    filenameMatch[1],
    PROVENANCE_FILENAME,
    'sidecar filename diverged between the runtime reader and scripts/lib/pkg-provenance.mjs',
  );
  assert.equal(
    nameMatch[1],
    EXPECTED_PKG_NAME,
    'producer-name check diverged between the runtime reader and scripts/lib/pkg-provenance.mjs',
  );
});

// ── BLOCKER A: hooksDigest (aggregate hash over every hook.json-wired file) ──
suite('doctor.mjs — hooksDigest + self-location checks (fix/pkgroot-provenance)');

test('a hook file other than hypo-shared.mjs changed after copy → hooksDigest mismatch names it', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const hooksDir = join(home, '.claude', 'hooks');
      const target = join(hooksDir, 'hypo-personal-check.mjs');
      // hypo-shared.mjs itself is untouched — the runtime SHA check alone
      // would still verify this install; only the aggregate hooksDigest sees
      // this file drift.
      writeFileSync(target, readFileSync(target, 'utf-8') + '\n// tampered for test\n');
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
      assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
      assert.equal(
        check.status,
        'warn',
        `a changed non-hypo-shared hook file must surface as a hooksDigest warn: ${check.detail}`,
      );
      assert.match(check.detail, /hooksDigest mismatch/);
      assert.match(check.detail, /hypo-personal-check\.mjs/);
    });
  });
});

test('sidecar predating hooksDigest (no such field) → doctor skips the digest check silently', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const hooksDir = join(home, '.claude', 'hooks');
      const sidecarPath = join(hooksDir, '.hypo-provenance.json');
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      delete sidecar.hooksDigest;
      writeFileSync(sidecarPath, JSON.stringify(sidecar));
      // Tamper a hook file too — if the digest check ran anyway, this would warn.
      const target = join(hooksDir, 'hypo-personal-check.mjs');
      writeFileSync(target, readFileSync(target, 'utf-8') + '\n// tampered for test\n');
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
      assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
      assert.equal(
        check.status,
        'pass',
        `a pre-hooksDigest sidecar must still verify on name+hash+usable alone: ${check.detail}`,
      );
    });
  });
});

test('sidecar pkgRoot package.json has no version → doctor warns, does not PASS', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const versionlessRoot = mkdtempSync(join(tmpdir(), 'hypo-versionless-root-'));
      try {
        writeFileSync(
          join(versionlessRoot, 'package.json'),
          JSON.stringify({ name: 'hypomnema' }), // name matches; no "version" field
        );
        const sidecarPath = join(home, '.claude', 'hooks', '.hypo-provenance.json');
        const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
        sidecar.pkgRoot = versionlessRoot;
        writeFileSync(sidecarPath, JSON.stringify(sidecar));
        const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
        const out = JSON.parse(r.stdout);
        const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
        assert.ok(check, 'expected a hooks/.hypo-provenance.json check');
        assert.equal(
          check.status,
          'warn',
          `a version-less root must not PASS — isUsablePkgRootLocal (the same predicate ` +
            `the runtime resolver requires) rejects it too: ${check.detail}`,
        );
        assert.match(check.detail, /not a usable package root/);
      } finally {
        rmSync(versionlessRoot, { recursive: true, force: true });
      }
    });
  });
});

test('hooks installed, self-location fails, no sidecar at all → doctor warns, not silent', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      // A standalone `init` copy has no package.json alongside it, so
      // self-location for this hooksDir always fails — same steady state
      // documented on selfLocationPkgRootFrom in hooks/hypo-shared.mjs.
      const sidecarPath = join(home, '.claude', 'hooks', '.hypo-provenance.json');
      rmSync(sidecarPath, { force: true });
      const r = runWithHome('doctor.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      const check = out.find((c) => c.label === 'hooks/.hypo-provenance.json');
      assert.ok(
        check,
        'an installed-but-unresolvable hook copy with no sidecar must not stay silent',
      );
      assert.equal(check.status, 'warn', `must not stay silent: ${check.detail}`);
      assert.match(check.detail, /PKG_ROOT resolves to null/);
    });
  });
});

// ── plugin cache leaf version (plugin channel) ──────────────────────────────
//
// ISSUE-113: `/plugin marketplace update` names its cache directory after the
// release it copies in and skips the copy once that version string stops
// moving, so the leaf can end up naming an older release than the
// package.json actually sitting inside it. Registry shape mirrors upgrade.mjs
// dualSkip's own fixtures (tests/upgrade.test.mjs writeRegistry/withRegistryRoot):
// `{ plugins: { "<key>": [{ installPath, scope }] } }`.

suite('doctor.mjs: plugin cache leaf version (ISSUE-113)');

const PLUGIN_KEY = 'hypo@hypomnema';

function enablePlugin(home) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { [PLUGIN_KEY]: true } }),
  );
}

// Builds a plugin cache root shaped like Claude Code's own
// `cache/<marketplace>/hypo/<leafVersion>/` and points installed_plugins.json
// at it, with a package.json inside carrying `manifestVersion`. Passing
// `leafVersion !== manifestVersion` reproduces the exact QA fixture (leaf
// "1.7.3", package.json "1.7.4").
// `scopes` mirrors the real registry shape: a live machine carries BOTH a
// user-scope and a project-scope row for one key, and both name the SAME
// installPath (verified on this machine 2026-08-31). The default stays single so
// the existing tests read unchanged.
function registerPluginCache(home, leafVersion, manifestVersion, scopes = ['user']) {
  const root = join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', leafVersion);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'hypomnema', version: manifestVersion }),
  );
  const registryDir = join(home, '.claude', 'plugins');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    join(registryDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: { [PLUGIN_KEY]: scopes.map((scope) => ({ installPath: root, scope })) },
    }),
  );
  return root;
}

test('plugin not enabled: check is silent (not reported at all)', () => {
  withTmpHome((home) => {
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Plugin cache leaf version');
    assert.equal(check, undefined, 'no enabled plugin means nothing to verify');
  });
});

test('plugin enabled, leaf matches package.json version: passes', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    registerPluginCache(home, '1.7.4', '1.7.4');
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Plugin cache leaf version');
    assert.ok(check, 'expected a Plugin cache leaf version check');
    assert.equal(check.status, 'pass', `matching leaf must pass: ${check.detail}`);
  });
});

test('plugin enabled, leaf drifted from package.json version: warns and names the exact drift', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    // The measured 2026-08-29 QA shape: cache leaf "1.7.3", package.json "1.7.4".
    registerPluginCache(home, '1.7.3', '1.7.4');
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Plugin cache leaf version');
    assert.ok(check, 'expected a Plugin cache leaf version check');
    assert.equal(check.status, 'warn', `drifted leaf must warn, not pass: ${check.detail}`);
    assert.match(check.detail, /leaf says v1\.7\.3/);
    assert.match(check.detail, /package\.json says v1\.7\.4/);
  });
});

// Two registry rows, one directory. The real shape on a live machine: `hypo@hypomnema`
// carries a user-scope AND a project-scope entry pointing at the same installPath.
// Iterating rows instead of paths reported "2 plugin cache path(s)" and printed the
// identical path twice, so both the count and the list overstated the damage.
test('duplicate registry rows naming one path are reported once', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    registerPluginCache(home, '1.7.3', '1.7.4', ['user', 'project']);
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Plugin cache leaf version');
    assert.ok(check, 'expected a Plugin cache leaf version check');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /1 plugin cache path\(s\)/, `count must dedupe: ${check.detail}`);
    const hits = check.detail.match(/leaf says v1\.7\.3/g) || [];
    assert.equal(hits.length, 1, `path must be listed once, got ${hits.length}: ${check.detail}`);
  });
});

// A leaf that merely STARTS with a version is not a version-named cache dir. An
// unanchored test read it as one, and since package.json can never equal the whole
// leaf string, a perfectly healthy root warned forever.
test('a leaf that only starts with a version is not treated as version-named', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    registerPluginCache(home, '1.7.4-hypomnema-backup', '1.7.4');
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Plugin cache leaf version');
    assert.ok(check, 'expected a Plugin cache leaf version check');
    // Not `pass`: nothing was compared, and saying "matches" would state a fact nobody
    // established. Not the drift wording either — that is what an unanchored regex
    // produces here, so asserting on the detail is what makes this test distinguish the
    // two failure directions rather than just the status word.
    assert.equal(check.status, 'warn', `unverifiable must not read as verified: ${check.detail}`);
    assert.match(
      check.detail,
      /could be compared/,
      `expected the unverified wording: ${check.detail}`,
    );
    assert.doesNotMatch(
      check.detail,
      /leaf says v/,
      `a non-version leaf must not be reported as drifted: ${check.detail}`,
    );
  });
});

// The exclusion this feature deliberately does NOT do. Filtering drifted roots out
// of resolveEnabledPluginRoot makes it return null, and init.mjs's resolveDurableRoot
// then falls back to PKG_ROOT — in a dual install that is the npm checkout, which
// gets baked into the vault's pre-commit hook and dangles the moment the user removes
// it. Drift is a reporting concern; resolution must still hand back the working root.
test('a drifted leaf is still resolved as the plugin root (report, never exclude)', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    const root = registerPluginCache(home, '1.7.3', '1.7.4');
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    assert.equal(
      resolveEnabledPluginRoot(settingsPath, registryPath),
      root,
      'drift must not remove a usable root from resolution',
    );
    assert.equal(leafVersionDrift(root).drift, true, 'fixture must actually be drifted');
  });
});

// leafVersionDrift is exported, and doctor is not its only possible caller. doctor
// happens to gate on usablePkgRoot first (which requires a readable version), so an
// unreadable package.json cannot reach the comparison today. Pin the contract directly
// anyway: a version-shaped leaf over a package.json with no version is a judgment
// FAILURE, and reporting it as `checked: true, drift: false` would read as "compared
// and matched" — the same fail-open shape doctor's own `compared === 0` branch closes.
test('leafVersionDrift: unreadable manifest is checked:false, not a clean compare', () => {
  withTmpHome((home) => {
    const root = join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', '1.7.4');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hypomnema' })); // no version
    const d = leafVersionDrift(root);
    assert.equal(d.checked, false, 'a manifest with no version was never compared');
    assert.equal(d.drift, false, 'and an uncompared root must not be reported as drifted');
    assert.equal(d.manifestVersion, null);
  });
});

// ── Why checkPluginLeafVersion does NOT consume resolvePluginChannel ────────
//
// IMPR-45 pulled the channel judgment into one function, so the next reader
// meets a leaf-version check that still calls enabledHypomnemaPluginKey and
// reads the registry itself, and reasonably asks "is this the duplication we
// just removed?". It is not, for two reasons a comment cannot enforce, so both
// are pinned here. Consolidating would silently delete a diagnostic for exactly
// the users it exists to serve, and a silent deletion is what ADR 0097 already
// caught once by reading past a comment.

test('checkPluginLeafVersion needs EVERY registry row, not the one the resolver picks', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    // Two DISTINCT cache directories, both drifted. resolveEnabledPluginEntry
    // returns a single chosen row, so a caller built on it can only ever report
    // one of these. This assertion fails the moment someone rewrites the check
    // to consume that single entry.
    const mk = (leaf, manifest) => {
      const root = join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', leaf);
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'hypomnema', version: manifest }),
      );
      return root;
    };
    const a = mk('1.7.4', '1.7.9');
    const b = mk('1.8.0', '1.8.5');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          [PLUGIN_KEY]: [
            { installPath: a, scope: 'user' },
            { installPath: b, scope: 'project' },
          ],
        },
      }),
    );
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const check = JSON.parse(r.stdout).find((c) => c.label === 'Plugin cache leaf version');
    assert.ok(check, 'the leaf-version check must be reported at all');
    assert.ok(check.detail.includes(a), `both drifted paths must be named, missing ${a}`);
    assert.ok(check.detail.includes(b), `both drifted paths must be named, missing ${b}`);
  });
});

test('resolvePluginChannel short-circuits enabledKey to null in pluginMode', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    const root = registerPluginCache(home, '1.7.4', '1.7.4');
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');

    // Not in pluginMode: the key is there, so a consolidation would look safe.
    const outside = resolvePluginChannel({
      pkgRoot: join(home, 'checkout'),
      settingsPath,
      registryPath,
    });
    assert.ok(outside.enabledKey, 'outside pluginMode the key resolves, which is the trap');

    // In pluginMode (PKG_ROOT under ~/.claude/plugins/), the channel short-circuits
    // and enabledKey is null. checkPluginLeafVersion asks the settings file directly
    // BECAUSE of this: routing it through the channel would skip the diagnostic on
    // exactly the plugin-channel installs it is for.
    const inside = resolvePluginChannel({ pkgRoot: root, settingsPath, registryPath });
    assert.equal(inside.pluginMode, true);
    assert.equal(inside.enabledKey, null, 'pluginMode must not carry an enabledKey');
  });
});

// ── lib/plugin-detect.mjs: resolveEnabledPluginEntry reason discrimination ──
//
// A judge's null return must read as "cannot positively resolve", never as
// "resolved to nothing usable exists". resolveEnabledPluginEntry's `reason`
// field is what makes that distinction machine-checkable instead of a comment
// a caller can read past. Pinned here as a pure-function contract, independent
// of any one caller's response (doctor's own checkPluginInstallDrift/leaf-version
// suites, plus init's and upgrade's dual-install suites, cover how each caller
// reacts to it).

suite('lib/plugin-detect.mjs — resolveEnabledPluginEntry (reason discrimination)');

test('plugin not enabled: reason is not-enabled, not unresolved', () => {
  withTmpHome((home) => {
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const r = resolveEnabledPluginEntry(settingsPath, registryPath);
    assert.equal(r.reason, 'not-enabled');
    assert.equal(r.key, null);
    assert.equal(r.entry, null);
    assert.equal(r.root, null);
  });
});

test('enabled but registry file missing: reason is registry-unreadable, not unresolved', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json'); // never written
    const r = resolveEnabledPluginEntry(settingsPath, registryPath);
    assert.equal(r.reason, 'registry-unreadable');
    assert.equal(r.key, PLUGIN_KEY, 'the key is still known even when the registry cannot be read');
    assert.equal(r.entry, null);
    assert.equal(r.root, null);
  });
});

test('enabled, registry present, no usable entry for the key: reason is unresolved', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    const registryDir = join(home, '.claude', 'plugins');
    mkdirSync(registryDir, { recursive: true });
    // installPath does not exist on disk, so no candidate is usable.
    writeFileSync(
      join(registryDir, 'installed_plugins.json'),
      JSON.stringify({
        plugins: { [PLUGIN_KEY]: [{ installPath: join(home, 'nowhere'), scope: 'user' }] },
      }),
    );
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(registryDir, 'installed_plugins.json');
    const r = resolveEnabledPluginEntry(settingsPath, registryPath);
    assert.equal(r.reason, 'unresolved');
    assert.equal(r.key, PLUGIN_KEY);
    assert.equal(r.entry, null);
    assert.equal(r.root, null);
  });
});

test('enabled, usable entry found: reason is resolved, and entry is the SAME row root came from', () => {
  withTmpHome((home) => {
    enablePlugin(home);
    const root = registerPluginCache(home, '1.7.4', '1.7.4');
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const r = resolveEnabledPluginEntry(settingsPath, registryPath);
    assert.equal(r.reason, 'resolved');
    assert.equal(r.root, root);
    assert.equal(r.entry.installPath, root, 'entry is the actual registry row, not just its path');
  });
});

// resolveEnabledPluginRoot must stay a pure projection of `.root`, never a
// second, independently-derived answer that could drift from resolveEnabledPluginEntry.
// Compares the two functions AGAINST EACH OTHER, not against literals: the thin
// projection can only be proven equivalent by calling both. Comparing
// resolveEnabledPluginRoot to a hardcoded null/root would still pass if someone
// re-implemented it independently and it drifted, which is the exact failure
// IMPR-45 exists to stop. All four reasons are walked.
test('resolveEnabledPluginRoot(...) === resolveEnabledPluginEntry(...).root, for every reason', () => {
  withTmpHome((home) => {
    const settingsPath = join(home, '.claude', 'settings.json');
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const bothAgree = (expectedReason) => {
      const entry = resolveEnabledPluginEntry(settingsPath, registryPath);
      assert.equal(entry.reason, expectedReason, `reason should be ${expectedReason}`);
      assert.equal(
        resolveEnabledPluginRoot(settingsPath, registryPath),
        entry.root,
        `projection diverged from the entry it projects (${expectedReason})`,
      );
      return entry;
    };

    bothAgree('not-enabled');

    enablePlugin(home);
    bothAgree('registry-unreadable');

    // unresolved: the key IS enabled and the registry parses, but no row points at
    // a usable package directory. Without this step the projection is never
    // compared on the one reason where a naive re-implementation is most likely
    // to return a path instead of null.
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify({
        plugins: {
          [PLUGIN_KEY]: [{ installPath: join(home, 'no', 'such', 'dir'), scope: 'user' }],
        },
      }),
    );
    bothAgree('unresolved');

    const root = registerPluginCache(home, '1.7.4', '1.7.4');
    const resolved = bothAgree('resolved');
    assert.equal(resolved.root, root);
  });
});

// ── doctor.mjs: installed cache vs marketplace HEAD ─────────────────────────
//
// `/plugin marketplace update <marketplace>` pulls the marketplace clone
// forward but only re-copies the plugin CACHE when the version string moved,
// so the cache can sit commits behind a marketplace clone under the same
// version string. installed_plugins.json's `gitCommitSha` records the commit
// each cache row was populated from; the marketplace clone's own `git
// rev-parse HEAD` is the other half of the comparison.

suite('doctor.mjs: installed cache vs marketplace HEAD');

const IPD_KEY = 'hypo@hypomnema';

function ipdEnablePlugin(home) {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { [IPD_KEY]: true } }),
  );
}

// A real git clone with `commitCount` commits, standing in for
// ~/.claude/plugins/marketplaces/hypomnema/. Returns every commit sha, oldest
// first, so a test can pin the installed cache to any point in the history.
// Every git child here gets HOME pinned to the fixture's own home and hooks
// switched off. gitRepo() from helpers.mjs does neither, and a developer with a
// global core.hooksPath would have this fixture's commits run their real hooks
// against a temp repo. The suite already sets core.hooksPath=/dev/null in its
// other git fixture; this brings the marketplace one in line.
function ipdGit(home, args, opts = {}) {
  return spawnSync('git', args, {
    encoding: 'utf-8',
    ...opts,
    env: {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

function ipdBuildMarketplace(home, commitCount) {
  const marketplaceDir = join(home, '.claude', 'plugins', 'marketplaces', 'hypomnema');
  mkdirSync(marketplaceDir, { recursive: true });
  const cwd = { cwd: marketplaceDir };
  ipdGit(home, ['init', '-q'], cwd);
  ipdGit(home, ['config', 'user.email', 't@t.test'], cwd);
  ipdGit(home, ['config', 'user.name', 'test'], cwd);
  ipdGit(home, ['config', 'commit.gpgsign', 'false'], cwd);
  ipdGit(home, ['config', 'core.hooksPath', '/dev/null'], cwd);
  const shas = [];
  for (let i = 0; i < commitCount; i++) {
    writeFileSync(join(marketplaceDir, 'f.txt'), String(i));
    ipdGit(home, ['add', '-A'], cwd);
    const c = ipdGit(home, ['commit', '-q', '-m', `c${i}`], cwd);
    assert.equal(c.status, 0, `fixture commit c${i} failed: ${c.stderr}`);
    shas.push(ipdGit(home, ['rev-parse', 'HEAD'], cwd).stdout.trim());
  }
  return { marketplaceDir, shas };
}

// installed_plugins.json entry shape, `gitCommitSha` included: the field
// this check reads and the older `registerPluginCache` fixture (leaf-version
// suite above) does not carry.
function ipdRegisterCache(home, installedSha, scopes = ['user']) {
  const root = join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', '1.7.4');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'hypomnema', version: '1.7.4' }),
  );
  const registryDir = join(home, '.claude', 'plugins');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(
    join(registryDir, 'installed_plugins.json'),
    JSON.stringify({
      plugins: {
        [IPD_KEY]: scopes.map((scope) => ({
          installPath: root,
          scope,
          gitCommitSha: installedSha,
        })),
      },
    }),
  );
  return root;
}

test('plugin not enabled: check is silent (not reported at all)', () => {
  withTmpHome((home) => {
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.equal(check, undefined, 'no enabled plugin means nothing to verify');
  });
});

// "not enabled" (above, silent) and "enabled but the registry cannot be read"
// (here, warns) must read differently to the actual production caller, not
// just to the resolver's own reason field: this is checkPluginInstallDrift
// itself, not a unit test of resolveEnabledPluginEntry in isolation.
test('plugin enabled, registry file missing: warns, and does not read as "not enabled"', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home); // enabledPlugins set, installed_plugins.json never written
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'an enabled plugin must produce a check, not silence');
    assert.equal(
      check.status,
      'warn',
      `an unreadable registry must not read as verified: ${check.detail}`,
    );
    assert.match(check.detail, /Cannot read/, check.detail);
  });
});

test('installed sha matches marketplace HEAD: passes', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home);
    const { shas } = ipdBuildMarketplace(home, 2);
    ipdRegisterCache(home, shas[1]); // shas[1] is HEAD
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.equal(check.status, 'pass', `matching sha must pass: ${check.detail}`);
  });
});

test('installed sha behind marketplace HEAD: warns and names the commit count', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home);
    const { shas } = ipdBuildMarketplace(home, 3);
    ipdRegisterCache(home, shas[0]); // two commits behind HEAD (shas[2])
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.equal(check.status, 'warn', `drifted sha must warn, not pass: ${check.detail}`);
    assert.match(check.detail, /2 commit\(s\) behind/, check.detail);
  });
});

test('installed sha ahead of marketplace HEAD: says ahead, never tells the user to overwrite it', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home);
    const { marketplaceDir, shas } = ipdBuildMarketplace(home, 3);
    // Roll the clone back so the install (shas[2]) is a descendant of its HEAD.
    // `rev-list --count shas[2]..shas[0]` is 0 here, the same value a matching
    // pair would give, which is why the shas are compared for equality first.
    const reset = ipdGit(home, ['reset', '--hard', '-q', shas[0]], { cwd: marketplaceDir });
    assert.equal(reset.status, 0, `fixture reset failed: ${reset.stderr}`);
    ipdRegisterCache(home, shas[2]);
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.match(check.detail, /ahead of/, check.detail);
    assert.doesNotMatch(
      check.detail,
      /behind/,
      `an ahead install must not read as behind: ${check.detail}`,
    );
    assert.doesNotMatch(
      check.detail,
      /replace .* by hand/,
      `overwriting a newer cache with an older clone is a downgrade: ${check.detail}`,
    );
  });
});

// The marketplace clone on a real machine is shallow: `/plugin marketplace
// update` clones with a truncated history, so `.git/shallow` is present and a
// walk that has to cross the graft point simply stops. A full-clone fixture
// never exercises that, which is how a count-based direction check passed here
// while being wrong on the only clone shape that actually ships.
test('shallow marketplace clone: an undecidable direction is said, not guessed', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home);
    const { marketplaceDir, shas } = ipdBuildMarketplace(home, 3);
    // Re-clone at depth 1 over the same path, so HEAD is the tip and every
    // earlier commit is beyond the graft point.
    const upstream = join(home, 'upstream.git');
    const mv = ipdGit(home, ['clone', '-q', '--bare', marketplaceDir, upstream]);
    assert.equal(mv.status, 0, `fixture bare clone failed: ${mv.stderr}`);
    rmSync(marketplaceDir, { recursive: true, force: true });
    const cl = ipdGit(home, ['clone', '-q', '--depth', '1', `file://${upstream}`, marketplaceDir]);
    assert.equal(cl.status, 0, `fixture shallow clone failed: ${cl.stderr}`);
    assert.ok(
      existsSync(join(marketplaceDir, '.git', 'shallow')),
      'the fixture must actually be shallow, or it tests the same thing as the full-clone case',
    );

    // shas[0] is real upstream history but unreachable from this clone's graft
    // point, so git can place it in neither direction.
    ipdRegisterCache(home, shas[0]);
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.match(check.detail, /cannot be determined/, check.detail);
    assert.doesNotMatch(
      check.detail,
      /commit\(s\) behind/,
      `no count may be claimed when the direction is unknown: ${check.detail}`,
    );
    assert.doesNotMatch(
      check.detail,
      /replace .* by hand/,
      `overwriting on an unknown direction can be a downgrade: ${check.detail}`,
    );
  });
});

// The exact combination the task names: BOTH the current key (`hypo@hypomnema`)
// and the legacy key (`hypomnema@hypomnema`) present in one registry file, only
// the current one enabled. The legacy row is deliberately stale (an unrelated
// sha) — if the check ever picked the wrong key, this would read as drifted.
test('registry carries both the current and legacy plugin key: only the enabled key is compared', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home); // enables hypo@hypomnema only
    const { shas } = ipdBuildMarketplace(home, 2);
    ipdRegisterCache(home, shas[1]); // current key matches HEAD
    const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const reg = JSON.parse(readFileSync(registryPath, 'utf-8'));
    reg.plugins['hypomnema@hypomnema'] = [
      {
        installPath: join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', '1.6.0'),
        scope: 'user',
        gitCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
    ];
    writeFileSync(registryPath, JSON.stringify(reg));
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.equal(
      check.status,
      'pass',
      `must compare the enabled key's row, not the legacy one: ${check.detail}`,
    );
  });
});

// A registry from before gitCommitSha existed (or an entry missing it) — must
// degrade to an unverifiable warn, never read as a clean compare.
test('registry entry carries no gitCommitSha: warns, does not silently pass', () => {
  withTmpHome((home) => {
    enablePlugin(home); // shared fixture from the leaf-version suite, same key
    registerPluginCache(home, '1.7.4', '1.7.4'); // no gitCommitSha field
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.equal(
      check.status,
      'warn',
      `missing gitCommitSha must not read as verified: ${check.detail}`,
    );
    assert.match(check.detail, /gitCommitSha/, check.detail);
  });
});

// ── doctor.mjs: hook execution smoke test ───────────────────────────────────
//
// checkHooks/checkSettingsJson only prove a hook file exists and is
// registered. This proves it can actually run: spawn hypo-file-watch.mjs with
// a stdin payload it cannot match against HYPO_DIR, and check it exits 0 with
// parseable JSON. The broken-hook fixture below deletes the hook's own
// hypo-shared.mjs dependency so `node hypo-file-watch.mjs` dies at ESM
// resolution with `Cannot find module ... Require stack:` on stderr and exit
// 1 — the same shape (any node invocation of this file dies before its own
// code runs) as the measured incident's stale NODE_OPTIONS `--require`, without
// literally exporting that env: NODE_OPTIONS is inherited by doctor.mjs's own
// process too, so setting it globally kills doctor before it reaches this
// check at all (confirmed empirically), not just the hook subprocess.

suite('doctor.mjs: hook execution smoke test');
// The registry can carry a user row and a project row on the SAME installPath.
// resolveEnabledPluginRoot picks the user one; the drift check has to pick the
// same one or it reports a stale project sha as the state of a user install
// that is actually at HEAD, and answers a healthy cache with "replace it by
// hand". Ordering the project row first is what makes the two rules diverge.
// The order the two rules run in decides which row answers. Filtering for a sha
// first and preferring user scope second silently swaps rows when the user row
// has no gitCommitSha: the project row's older sha becomes the provenance of an
// install it does not describe, and the reader is told to replace a cache by
// hand. Choosing the row first and asking about its sha second cannot swap.
test('user row on the path has no sha: says unverifiable, does not borrow the project row sha', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home);
    const { shas } = ipdBuildMarketplace(home, 3);
    const root = join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', '1.7.4');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '1.7.4' }),
    );
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          [IPD_KEY]: [
            {
              scope: 'project',
              projectPath: join(home, 'some-project'),
              installPath: root,
              version: '1.7.4',
              gitCommitSha: shas[0],
            },
            // The row the resolver picks, and it carries no sha.
            { scope: 'user', installPath: root, version: '1.7.4' },
          ],
        },
      }),
    );
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.match(check.detail, /carries no gitCommitSha/, check.detail);
    assert.doesNotMatch(
      check.detail,
      /behind/,
      `an unverifiable row must not be answered with a drift verdict: ${check.detail}`,
    );
    assert.doesNotMatch(check.detail, /replace .* by hand/, check.detail);
  });
});

test('registry has user and project rows on one path: drift reads the user row, not whichever is first', () => {
  withTmpHome((home) => {
    ipdEnablePlugin(home);
    const { shas } = ipdBuildMarketplace(home, 3);
    const root = join(home, '.claude', 'plugins', 'cache', 'hypomnema', 'hypo', '1.7.4');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '1.7.4' }),
    );
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          [IPD_KEY]: [
            // Project row FIRST, carrying an older sha.
            {
              scope: 'project',
              projectPath: join(home, 'some-project'),
              installPath: root,
              version: '1.7.4',
              gitCommitSha: shas[0],
            },
            { scope: 'user', installPath: root, version: '1.7.4', gitCommitSha: shas[2] },
          ],
        },
      }),
    );
    const r = runWithHome('doctor.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Installed cache vs marketplace HEAD');
    assert.ok(check, 'expected an Installed cache vs marketplace HEAD check');
    assert.equal(
      check.status,
      'pass',
      `the user row is at HEAD, so this install is not behind: ${check.detail}`,
    );
    assert.doesNotMatch(check.detail, /behind/, check.detail);
  });
});
// ── doctor.mjs: feedback projection attributes "no JSON report" to a broken
// hook smoke test when one already fired ─────────────────────────────────────
//
// A copy of doctor's own scripts/hooks tree (mirrors ISSUE-52's
// withFakeDoctorInstall above) with scripts/feedback-sync.mjs replaced by a
// stub that prints nothing and exits 1 — reliably reproducing "no JSON
// report" without depending on a real feedback-sync crash path (the script's
// own defenses against filesystem errors are already hardened; see the
// build-failed comment in evaluateTarget).

suite('doctor.mjs: feedback projection attributes hook-broken');
