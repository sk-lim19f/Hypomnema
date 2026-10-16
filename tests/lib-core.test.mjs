// tests/lib-core.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, suite } from './harness.mjs';
import {
  HOME,
  HOOKS,
  SCRIPTS,
  SESSION_TMP_HOME,
  checkVaultOrExit,
  expandHome,
  resolveHypoRoot,
  resolveHypoRootInfo,
  run,
  settingsWriteFaultPreload,
  withTmpDir,
} from './helpers.mjs';
import { atomicWrite } from '../hooks/atomic-write.mjs';
import { writeSettingsJson } from '../scripts/lib/settings-write.mjs';
import { formatSessionEntry, renderViews } from '../hooks/session-entries.mjs';

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

// ── ISSUE-51: fail-open resolveHypoRoot → resolveHypoRootInfo + checkVaultOrExit ──
//
// A no-marker "default" path is not the same failure as a no-marker "env"
// path: the former is CI's normal, intentional shape (lint-runner, release.yml
// run without a vault at all and must keep exiting 0); the latter is a user
// pointing HYPO_DIR at nothing, which should fail loud instead of silently
// reporting an empty wiki as "no issues found" / "no results".

suite('resolveHypoRootInfo()');

test('HYPO_DIR env var → source "env"', () => {
  const orig = process.env.HYPO_DIR;
  process.env.HYPO_DIR = '/tmp/custom-wiki-info';
  try {
    const info = resolveHypoRootInfo();
    assert.equal(info.root, '/tmp/custom-wiki-info');
    assert.equal(info.source, 'env');
  } finally {
    if (orig === undefined) delete process.env.HYPO_DIR;
    else process.env.HYPO_DIR = orig;
  }
});

// homedir() is read once at hypo-root.mjs module load (`const HOME =
// homedir();`), so overriding process.env.HOME after this test file has
// already imported it has no effect in-process. Exercise the marker-scan
// branch in a fresh child process instead, where $HOME is read cold.
test('marker found (fresh process, $HOME override) → source "marker"', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'hypo-info-marker-'));
  try {
    const wikiDir = join(fakeHome, 'hypomnema');
    const script = `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      mkdirSync(${JSON.stringify(wikiDir)}, { recursive: true });
      writeFileSync(join(${JSON.stringify(wikiDir)}, 'hypo-config.md'), '# marker\\n');
      const { resolveHypoRootInfo } = await import(${JSON.stringify(join(SCRIPTS, 'lib/hypo-root.mjs'))});
      const info = resolveHypoRootInfo();
      console.log(JSON.stringify(info));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: fakeHome, HYPO_DIR: '' },
    });
    assert.equal(r.status, 0, `probe process should exit 0: ${r.stderr}`);
    const info = JSON.parse(r.stdout.trim());
    assert.equal(info.source, 'marker');
    assert.equal(info.root, wikiDir);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('no env, no marker anywhere → source "default", root is ~/hypomnema', () => {
  const orig = process.env.HYPO_DIR;
  delete process.env.HYPO_DIR;
  try {
    const info = resolveHypoRootInfo();
    if (info.source === 'default') {
      assert.equal(info.root, join(HOME, 'hypomnema'));
    } else {
      // a real vault exists on this machine at one of the candidate paths —
      // acceptable, mirrors the existing resolveHypoRoot() suite's tolerance.
      assert.equal(info.source, 'marker');
    }
  } finally {
    if (orig !== undefined) process.env.HYPO_DIR = orig;
  }
});

test('resolveHypoRoot() stays byte-identical to resolveHypoRootInfo().root', () => {
  const orig = process.env.HYPO_DIR;
  process.env.HYPO_DIR = '/tmp/back-compat-check';
  try {
    assert.equal(resolveHypoRoot(), resolveHypoRootInfo().root);
  } finally {
    if (orig === undefined) delete process.env.HYPO_DIR;
    else process.env.HYPO_DIR = orig;
  }
});

suite('checkVaultOrExit()');

test('marker present → returns false, does not exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-vault-ok-'));
  try {
    writeFileSync(join(dir, 'hypo-config.md'), '# marker\n');
    assert.equal(checkVaultOrExit(dir, 'marker'), false);
    assert.equal(checkVaultOrExit(dir, 'default'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no marker, source "default" → returns true, does not exit (CI-safe path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-vault-missing-'));
  try {
    // Must NOT throw / exit — this is the branch CI's lint-runner and
    // release.yml depend on staying exit-0 without a vault at all.
    assert.equal(checkVaultOrExit(dir, 'default'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The `source === 'env'` + no-marker branch calls process.exit(1) directly and
// so cannot be exercised in-process without killing the test runner — it is
// covered below via spawned child processes against the real CLIs instead.

suite('read CLIs (lint/stats/graph/query) — vault validation at the entry point');

function spawnCli(script, args, env) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('HYPO_DIR set to a marker-less path → lint.mjs exits 1 with a loud error', () => {
  const badDir = mkdtempSync(join(tmpdir(), 'hypo-env-nomarker-'));
  try {
    const r = spawnCli('lint.mjs', [], {
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: badDir,
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('Hypomnema vault not found at HYPO_DIR='),
      `expected loud HYPO_DIR error in stderr, got: ${r.stderr}`,
    );
  } finally {
    rmSync(badDir, { recursive: true, force: true });
  }
});

test('no HYPO_DIR, no vault found anywhere → lint.mjs exits 0 but warns on stderr (CI-safe)', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-'));
  try {
    const r = spawnCli('lint.mjs', [], {
      HOME: noVaultHome,
      HYPO_DIR: '',
    });
    assert.equal(r.status, 0, `expected exit 0 (CI-safe), got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('No Hypomnema vault found'),
      `expected visible vault-missing notice on stderr, got: ${r.stderr}`,
    );
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('query.mjs: no vault → does not claim "관련 페이지가 없습니다", shows vault notice instead', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-query-'));
  try {
    const r = spawnCli('query.mjs', ['--q=anything'], {
      HOME: noVaultHome,
      HYPO_DIR: '',
    });
    assert.equal(r.status, 0, `expected exit 0 (CI-safe), got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      !r.stdout.includes('관련 페이지가 없습니다'),
      `no-vault run must not claim "no matching pages" as if it had scanned one: ${r.stdout}`,
    );
    assert.ok(
      !r.stdout.includes('No results for'),
      `no-vault run must not print the "No results for:" line either, since nothing was scanned: ${r.stdout}`,
    );
    assert.ok(
      r.stderr.includes('No Hypomnema vault found'),
      `expected visible vault-missing notice on stderr, got: ${r.stderr}`,
    );
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('valid vault via HYPO_DIR (marker present) → all 4 read CLIs behave as before', () => {
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-valid-vault-'));
  try {
    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const env = { HOME: SESSION_TMP_HOME, HYPO_DIR: validDir };

    const lintR = spawnCli('lint.mjs', [], env);
    assert.equal(lintR.status, 0, `lint should exit 0: ${lintR.stderr}`);
    assert.ok(!lintR.stderr.includes('No Hypomnema vault found'));
    assert.ok(!lintR.stderr.includes('vault not found'));

    const statsR = spawnCli('stats.mjs', ['--json'], env);
    assert.equal(statsR.status, 0, `stats should exit 0: ${statsR.stderr}`);
    assert.ok(!statsR.stderr.includes('No Hypomnema vault found'));
    const statsJson = JSON.parse(statsR.stdout);
    assert.equal(typeof statsJson.pages.total, 'number');

    const graphR = spawnCli('graph.mjs', [], env);
    assert.equal(graphR.status, 0, `graph should exit 0: ${graphR.stderr}`);
    assert.ok(!graphR.stderr.includes('No Hypomnema vault found'));

    const queryR = spawnCli('query.mjs', ['--q=nothing-matches-this'], env);
    assert.equal(queryR.status, 0, `query should exit 0: ${queryR.stderr}`);
    assert.ok(!queryR.stderr.includes('No Hypomnema vault found'));
    assert.ok(
      queryR.stdout.includes('관련 페이지가 없습니다'),
      'a real (empty) vault should still show the normal ingest suggestion',
    );
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

// ── ISSUE-51 follow-up: vault-missing must not look like a real, clean scan ──
//
// checkVaultOrExit's exit-0 "default"/stale-"marker" path stays exit-0 (this
// repo's own `npm run lint` in CI relies on it, pinned above) — but the
// callers used to print their normal success shape regardless, so a piped
// `--json` consumer (or a plain stdout read) could not tell "genuinely
// scanned and empty" apart from "found no vault at all". Prove both halves:
// the human-facing success line is suppressed, and the machine-facing `--json`
// payload carries an explicit `vaultFound: false`.

test('lint.mjs: no vault → stdout does NOT claim "No lint issues found"', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-lint-'));
  try {
    const r = spawnCli('lint.mjs', [], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(r.status, 0, `expected exit 0 (CI-safe), got ${r.status}. stderr: ${r.stderr}`);
    assert.ok(
      !r.stdout.includes('No lint issues found'),
      `no-vault run must not claim a clean scan that never happened: ${r.stdout}`,
    );
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('lint.mjs --json: no vault → vaultFound:false; real (empty) vault → vaultFound:true', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-lint-json-'));
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-valid-vault-lint-json-'));
  try {
    const missing = spawnCli('lint.mjs', ['--json'], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(missing.status, 0, `stderr: ${missing.stderr}`);
    assert.equal(JSON.parse(missing.stdout).vaultFound, false, `stdout: ${missing.stdout}`);

    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const found = spawnCli('lint.mjs', ['--json'], { HOME: SESSION_TMP_HOME, HYPO_DIR: validDir });
    assert.equal(found.status, 0, `stderr: ${found.stderr}`);
    assert.equal(JSON.parse(found.stdout).vaultFound, true, `stdout: ${found.stdout}`);
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
    rmSync(validDir, { recursive: true, force: true });
  }
});

test('stats.mjs: no vault → stdout stays empty, not an all-zero stats block', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-stats-'));
  try {
    const r = spawnCli('stats.mjs', [], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(r.status, 0, `expected exit 0 (CI-safe), got ${r.status}. stderr: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(),
      '',
      `no-vault run must not print stats as if scanned: ${r.stdout}`,
    );
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('stats.mjs --json: no vault → vaultFound:false', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-stats-json-'));
  try {
    const r = spawnCli('stats.mjs', ['--json'], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).vaultFound, false, `stdout: ${r.stdout}`);
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('graph.mjs (default json format): no vault → vaultFound:false', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-graph-'));
  try {
    const r = spawnCli('graph.mjs', [], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).vaultFound, false, `stdout: ${r.stdout}`);
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

// mermaid/dot have no JSON envelope to carry vaultFound, so a vault-missing
// run must suppress the diagram outright rather than hand a renderer an
// empty-but-"real"-looking graph (codex review finding, following the
// --format=json fix above).
test('graph.mjs --format=mermaid: no vault → stdout stays empty, not an empty-but-valid diagram', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-graph-mermaid-'));
  try {
    const r = spawnCli('graph.mjs', ['--format=mermaid'], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '', `no-vault run must not render a diagram: ${r.stdout}`);
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('graph.mjs --format=dot: no vault → stdout stays empty, not an empty-but-valid diagram', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-default-novault-graph-dot-'));
  try {
    const r = spawnCli('graph.mjs', ['--format=dot'], { HOME: noVaultHome, HYPO_DIR: '' });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '', `no-vault run must not render a diagram: ${r.stdout}`);
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
  }
});

test('graph.mjs --format=mermaid: real (empty) vault still renders the normal diagram', () => {
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-valid-vault-graph-mermaid-'));
  try {
    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('graph.mjs', ['--format=mermaid'], {
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: validDir,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), 'graph TD', `stdout: ${r.stdout}`);
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

// ── reject unspecified flags (ISSUE-121 F2) ──────────────────────────────────
//
// Five SKILL.md files told models to pass --wiki-dir=<path>; no script here
// ever parsed that flag, so it was silently dropped and every call fell
// through to the default hypo-dir resolution instead. None of these five
// CLIs take positional arguments, so any unmatched argv item (a typo'd flag,
// not just a leading "--" one) is now a hard error (exit 2) rather than a
// silent no-op.

const { parseArgs: parseCrystallizeArgs } = await import(`${SCRIPTS}/lib/crystallize-args.mjs`);

suite('reject unspecified flags: exit 2, matching flags still work');

test('lint.mjs: typo flag (--wiki-dir) is rejected with exit 2', () => {
  const r = spawnCli('lint.mjs', ['--wiki-dir=/tmp/nonexistent'], { HOME: SESSION_TMP_HOME });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--wiki-dir'), `stderr should name the rejected flag: ${r.stderr}`);
  assert.ok(r.stderr.includes('--hypo-dir'), `stderr should list accepted flags: ${r.stderr}`);
});

test('lint.mjs: known flags (--hypo-dir, --json, --fix, --strict) still parse and exit 0', () => {
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-reject-flags-lint-'));
  try {
    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('lint.mjs', [`--hypo-dir=${validDir}`, '--json', '--fix', '--strict'], {
      HOME: SESSION_TMP_HOME,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

test('verify.mjs: typo flag (--wiki-dir) is rejected with exit 2', () => {
  const r = spawnCli('verify.mjs', ['--wiki-dir=/tmp/nonexistent'], { HOME: SESSION_TMP_HOME });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--wiki-dir'), `stderr should name the rejected flag: ${r.stderr}`);
});

test('verify.mjs: known flags (--hypo-dir, --json) still parse and exit 0', () => {
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-reject-flags-verify-'));
  try {
    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('verify.mjs', [`--hypo-dir=${validDir}`, '--json'], {
      HOME: SESSION_TMP_HOME,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

test('graph.mjs: typo flag (--wiki-dir) is rejected with exit 2', () => {
  const r = spawnCli('graph.mjs', ['--wiki-dir=/tmp/nonexistent'], { HOME: SESSION_TMP_HOME });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--wiki-dir'), `stderr should name the rejected flag: ${r.stderr}`);
});

test('graph.mjs: known flags (--hypo-dir, --format, --min-edges) still parse and exit 0', () => {
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-reject-flags-graph-'));
  try {
    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('graph.mjs', [`--hypo-dir=${validDir}`, '--format=json', '--min-edges=0'], {
      HOME: SESSION_TMP_HOME,
    });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

test('query.mjs: typo flag (--wiki-dir) is rejected with exit 2', () => {
  const r = spawnCli('query.mjs', ['--wiki-dir=/tmp/nonexistent', '--q=x'], {
    HOME: SESSION_TMP_HOME,
  });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--wiki-dir'), `stderr should name the rejected flag: ${r.stderr}`);
});

test('query.mjs: known flags (--hypo-dir, --q, --limit, --json) still parse and exit 0', () => {
  const validDir = mkdtempSync(join(tmpdir(), 'hypo-reject-flags-query-'));
  try {
    writeFileSync(join(validDir, 'hypo-config.md'), '# marker\n');
    const r = spawnCli(
      'query.mjs',
      [`--hypo-dir=${validDir}`, '--q=anything', '--limit=5', '--json'],
      { HOME: SESSION_TMP_HOME },
    );
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

test('crystallize-args.mjs parseArgs: typo flag (--wiki-dir) is rejected with exit 2', () => {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      `import('${SCRIPTS}/lib/crystallize-args.mjs').then(m => m.parseArgs(['node','crystallize.mjs','--wiki-dir=/tmp/nonexistent']))`,
    ],
    { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME } },
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--wiki-dir'), `stderr should name the rejected flag: ${r.stderr}`);
});

test('crystallize-args.mjs parseArgs: known flags still parse without exiting', () => {
  const args = parseCrystallizeArgs([
    'node',
    'crystallize.mjs',
    '--hypo-dir=/tmp/some-vault',
    '--min-group=3',
    '--json',
    '--force',
  ]);
  assert.equal(args.hypoDir, '/tmp/some-vault');
  assert.equal(args.minGroup, 3);
  assert.equal(args.json, true);
  assert.equal(args.force, true);
});

// A space-separated `--payload <path>` (two argv entries) is not a recognized
// flag spelling: argv[i] is the bare token `--payload`, which matches nothing
// in parseArgs' if/else chain and falls to the reject branch. Before this
// fix, the allowed-list string printed here still called it `--payload=<json>`,
// which never matched the script's actual contract (a file path, or `-` for
// stdin) either. Both must now read `<path|->`.
test('crystallize-args.mjs parseArgs: space-separated --payload <path> is rejected with exit 2, not silently dropped', () => {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      `import('${SCRIPTS}/lib/crystallize-args.mjs').then(m => m.parseArgs(['node','crystallize.mjs','--apply-session-close','--payload','/tmp/x.json']))`,
    ],
    { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME } },
  );
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes('--payload'), `stderr should name the rejected flag: ${r.stderr}`);
  assert.ok(
    r.stderr.includes('<path|->'),
    `stderr's allowed-flag list should describe --payload as <path|-> (file path or stdin), not <json>: ${r.stderr}`,
  );
});

// ── --hypo-dir actually overrides default resolution (not just parsed) ──────

test('lint.mjs --hypo-dir: the specified vault is read, not the default-resolved one', () => {
  const noVaultHome = mkdtempSync(join(tmpdir(), 'hypo-dir-wins-lint-home-'));
  const explicitVault = mkdtempSync(join(tmpdir(), 'hypo-dir-wins-lint-explicit-'));
  try {
    // HOME/HYPO_DIR resolve to nothing; only --hypo-dir points at a real vault.
    writeFileSync(join(explicitVault, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('lint.mjs', [`--hypo-dir=${explicitVault}`, '--json'], {
      HOME: noVaultHome,
      HYPO_DIR: '',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      JSON.parse(r.stdout).vaultFound,
      true,
      `--hypo-dir must be the vault actually scanned, not the unresolved default: ${r.stdout}`,
    );
  } finally {
    rmSync(noVaultHome, { recursive: true, force: true });
    rmSync(explicitVault, { recursive: true, force: true });
  }
});

test('crystallize-args.mjs parseArgs: --hypo-dir wins over HYPO_DIR env default', () => {
  const orig = process.env.HYPO_DIR;
  process.env.HYPO_DIR = '/tmp/default-vault-should-not-be-used';
  try {
    const args = parseCrystallizeArgs([
      'node',
      'crystallize.mjs',
      '--hypo-dir=/tmp/explicit-vault',
    ]);
    assert.equal(
      args.hypoDir,
      '/tmp/explicit-vault',
      'an explicit --hypo-dir must win over the HYPO_DIR env default',
    );
  } finally {
    if (orig === undefined) delete process.env.HYPO_DIR;
    else process.env.HYPO_DIR = orig;
  }
});

// ── empty --hypo-dir= must not silently fall back to the default vault ──────
//
// `--hypo-dir="$VAULT"` with VAULT unset (or `--hypo-dir=` typed directly)
// expands to the empty string. expandHome('') returns '' unchanged, and '' is
// falsey, so every one of these five parsers used to read that as "no
// --hypo-dir was given" and fall through to its own default resolution
// (HYPO_DIR env / marker scan / ~/hypomnema). A crystallize apply that hit
// this wrote its session close into the wrong vault. Each test below seeds a
// REAL, different vault at HYPO_DIR so a silent fallback would exit 0 against
// that vault instead of failing loudly; the fix requires exit 2 regardless.

test('lint.mjs --hypo-dir= (empty value): rejected with exit 2, not silently defaulted', () => {
  const defaultVault = mkdtempSync(join(tmpdir(), 'hypo-empty-hypodir-default-lint-'));
  try {
    writeFileSync(join(defaultVault, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('lint.mjs', ['--hypo-dir=', '--json'], {
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: defaultVault,
    });
    assert.equal(
      r.status,
      2,
      `expected exit 2 (empty --hypo-dir must not fall back to the HYPO_DIR default), got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`,
    );
    assert.ok(r.stderr.includes('--hypo-dir'), `stderr should name the flag: ${r.stderr}`);
  } finally {
    rmSync(defaultVault, { recursive: true, force: true });
  }
});

test('verify.mjs --hypo-dir= (empty value): rejected with exit 2, not silently defaulted', () => {
  const defaultVault = mkdtempSync(join(tmpdir(), 'hypo-empty-hypodir-default-verify-'));
  try {
    writeFileSync(join(defaultVault, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('verify.mjs', ['--hypo-dir=', '--json'], {
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: defaultVault,
    });
    assert.equal(
      r.status,
      2,
      `expected exit 2 (empty --hypo-dir must not fall back to the HYPO_DIR default), got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`,
    );
    assert.ok(r.stderr.includes('--hypo-dir'), `stderr should name the flag: ${r.stderr}`);
  } finally {
    rmSync(defaultVault, { recursive: true, force: true });
  }
});

test('graph.mjs --hypo-dir= (empty value): rejected with exit 2, not silently defaulted', () => {
  const defaultVault = mkdtempSync(join(tmpdir(), 'hypo-empty-hypodir-default-graph-'));
  try {
    writeFileSync(join(defaultVault, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('graph.mjs', ['--hypo-dir='], {
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: defaultVault,
    });
    assert.equal(
      r.status,
      2,
      `expected exit 2 (empty --hypo-dir must not fall back to the HYPO_DIR default), got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`,
    );
    assert.ok(r.stderr.includes('--hypo-dir'), `stderr should name the flag: ${r.stderr}`);
  } finally {
    rmSync(defaultVault, { recursive: true, force: true });
  }
});

test('query.mjs --hypo-dir= (empty value): rejected with exit 2, not silently defaulted', () => {
  const defaultVault = mkdtempSync(join(tmpdir(), 'hypo-empty-hypodir-default-query-'));
  try {
    writeFileSync(join(defaultVault, 'hypo-config.md'), '# marker\n');
    const r = spawnCli('query.mjs', ['--hypo-dir=', '--q=anything'], {
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: defaultVault,
    });
    assert.equal(
      r.status,
      2,
      `expected exit 2 (empty --hypo-dir must not fall back to the HYPO_DIR default), got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`,
    );
    assert.ok(r.stderr.includes('--hypo-dir'), `stderr should name the flag: ${r.stderr}`);
  } finally {
    rmSync(defaultVault, { recursive: true, force: true });
  }
});

test('crystallize-args.mjs parseArgs: --hypo-dir= (empty value) rejected with exit 2, not silently defaulted', () => {
  const defaultVault = mkdtempSync(join(tmpdir(), 'hypo-empty-hypodir-default-crystallize-'));
  try {
    writeFileSync(join(defaultVault, 'hypo-config.md'), '# marker\n');
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `import('${SCRIPTS}/lib/crystallize-args.mjs').then(m => m.parseArgs(['node','crystallize.mjs','--hypo-dir=']))`,
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: defaultVault },
      },
    );
    assert.equal(
      r.status,
      2,
      `expected exit 2 (empty --hypo-dir must not fall back to the HYPO_DIR default), got ${r.status}. stdout: ${r.stdout} stderr: ${r.stderr}`,
    );
    assert.ok(r.stderr.includes('--hypo-dir'), `stderr should name the flag: ${r.stderr}`);
  } finally {
    rmSync(defaultVault, { recursive: true, force: true });
  }
});

// ── lib/wd-match.mjs (cross-machine project matcher) ─────────────────────────

const { pickProjectByCwd, normalizeWorkingDir } = await import(`${SCRIPTS}/lib/wd-match.mjs`);
const { resolveCloseScope } = await import(`${HOOKS}/hypo-shared.mjs`);

suite('resolveCloseScope() — marker attribution (session-close attribution)');

test('a v4 marker `projects` is trusted directly as scope', () => {
  const scope = resolveCloseScope('/nonexistent-hypo', {}, { projects: ['alpha', 'beta'] });
  assert.deepEqual([...scope].sort(), ['alpha', 'beta']);
});

test('an uncorroborated pre-v4 legacy marker.project is NOT partition-enabling scope', () => {
  // Legacy marker carries only `project` (possibly recency-derived). With no
  // direct signal corroborating the same slug, it must stay out of scope so a
  // stale attribution cannot demote a real failure.
  const scope = resolveCloseScope('/nonexistent-hypo', {}, { project: 'stale-recency' });
  assert.equal(scope.has('stale-recency'), false, 'uncorroborated legacy project excluded');
});

test('explicit close scope is always honored regardless of marker shape', () => {
  const scope = resolveCloseScope('/nonexistent-hypo', { closeScope: ['mine'] }, { project: 'x' });
  assert.ok(scope.has('mine'));
  assert.equal(scope.has('x'), false);
});

suite('normalizeWorkingDir()');

test('expands ~ and ~/ and strips trailing slashes', () => {
  assert.equal(normalizeWorkingDir('~'), HOME);
  assert.equal(normalizeWorkingDir('~/foo/bar/'), join(HOME, 'foo/bar'));
  assert.equal(normalizeWorkingDir('/abs/path///'), '/abs/path');
  assert.equal(normalizeWorkingDir(''), null);
  assert.equal(normalizeWorkingDir(null), null);
});

suite('pickProjectByCwd() — tier 1 (absolute prefix, original behavior)');

const PJS = [
  { slug: 'hypomnema', workingDir: '/Users/sangkyu/Workspace/Hypomnema' },
  { slug: 'guardia', workingDir: '/Users/sangkyu/Workspace/guardia' },
];

test('exact cwd match', () => {
  assert.equal(pickProjectByCwd(PJS, '/Users/sangkyu/Workspace/Hypomnema'), 'hypomnema');
});

test('subdirectory of working_dir matches', () => {
  assert.equal(
    pickProjectByCwd(PJS, '/Users/sangkyu/Workspace/Hypomnema/scripts/lib'),
    'hypomnema',
  );
});

test('longest prefix wins (/repo/sub beats /repo)', () => {
  const nested = [
    { slug: 'outer', workingDir: '/Users/x/Workspace' },
    { slug: 'inner', workingDir: '/Users/x/Workspace/Hypomnema' },
  ];
  assert.equal(pickProjectByCwd(nested, '/Users/x/Workspace/Hypomnema/scripts'), 'inner');
});

test('no false prefix match on sibling (Hypomnema vs Hypomnema-old)', () => {
  const sib = [{ slug: 'h', workingDir: '/Users/x/Hypomnema' }];
  assert.equal(pickProjectByCwd(sib, '/Users/x/Hypomnema-old'), null);
});

test('rejectAmbiguous declines a shared-working_dir tie (monorepo)', () => {
  // Two DISTINCT projects mapped to the SAME working_dir: attributing a close to
  // either would be a guess (session-close attribution P2). Default keeps the
  // legacy first-match behavior; rejectAmbiguous declines to null.
  const mono = [
    { slug: 'api', workingDir: '/repo' },
    { slug: 'web', workingDir: '/repo' },
  ];
  assert.ok(['api', 'web'].includes(pickProjectByCwd(mono, '/repo/src')), 'default breaks the tie');
  assert.equal(
    pickProjectByCwd(mono, '/repo/src', { rejectAmbiguous: true }),
    null,
    'rejectAmbiguous returns null on an equal-length tie',
  );
  // A unique longest match is still returned under rejectAmbiguous.
  const uniq = [
    { slug: 'api', workingDir: '/repo/api' },
    { slug: 'web', workingDir: '/repo' },
  ];
  assert.equal(pickProjectByCwd(uniq, '/repo/api/src', { rejectAmbiguous: true }), 'api');
});

test('~ working_dir is expanded before compare', () => {
  const tilde = [{ slug: 'h', workingDir: '~/Workspace/Hypomnema' }];
  assert.equal(pickProjectByCwd(tilde, join(HOME, 'Workspace/Hypomnema/x')), 'h');
});

suite('pickProjectByCwd() — tier 2 (cross-machine unique basename)');

test('different machine path matches by unique basename', () => {
  // working_dir recorded on machine A; cwd is the same repo on machine B.
  assert.equal(pickProjectByCwd(PJS, '/Users/SKLIM/Workspace/Sangkyu/Hypomnema'), 'hypomnema');
});

test('basename match works from a subdirectory on the other machine', () => {
  assert.equal(
    pickProjectByCwd(PJS, '/Users/SKLIM/Workspace/Sangkyu/Hypomnema/scripts'),
    'hypomnema',
  );
});

test('shared basename across projects fails closed (no tier-2 match)', () => {
  const dup = [
    { slug: 'a', workingDir: '/Users/sangkyu/work/Hypomnema' },
    { slug: 'b', workingDir: '/Users/sangkyu/other/Hypomnema' },
  ];
  assert.equal(pickProjectByCwd(dup, '/Users/SKLIM/elsewhere/Hypomnema'), null);
});

test('uniqueness is judged over ALL projects, not just eligible ones', () => {
  // 'b' is not eligible to be the answer, but it shares the basename so the
  // tier-2 gate must still see it as a collision and decline.
  const dup = [
    { slug: 'a', workingDir: '/Users/sangkyu/work/Repo' },
    { slug: 'b', workingDir: '/Users/sangkyu/other/Repo' },
  ];
  assert.equal(pickProjectByCwd(dup, '/Users/SKLIM/x/Repo', { eligible: ['a'] }), null);
});

test('unique basename mapping to an ineligible slug yields null', () => {
  assert.equal(pickProjectByCwd(PJS, '/Users/SKLIM/x/Hypomnema', { eligible: ['guardia'] }), null);
});

test('tier 1 wins over tier 2 when an absolute prefix exists', () => {
  assert.equal(pickProjectByCwd(PJS, '/Users/sangkyu/Workspace/Hypomnema/sub'), 'hypomnema');
});

suite('pickProjectByCwd() — case folding + symlinks + edges');

test('case-insensitive FS folds case (macOS/Windows)', () => {
  assert.equal(
    pickProjectByCwd(PJS, '/Users/sangkyu/Workspace/hypomnema', { caseInsensitive: true }),
    'hypomnema',
  );
});

test('case-sensitive FS does not fold (Linux): case-only diff is no match', () => {
  // tier 1 fails (different case), tier 2 basename 'hypomnema' != 'Hypomnema'
  assert.equal(
    pickProjectByCwd(PJS, '/Users/sangkyu/Workspace/hypomnema', { caseInsensitive: false }),
    null,
  );
});

test('realpathCwd variant is tried in addition to raw cwd', () => {
  assert.equal(
    pickProjectByCwd(PJS, '/tmp/symlink', {
      realpathCwd: '/Users/sangkyu/Workspace/Hypomnema',
    }),
    'hypomnema',
  );
});

test('empty universe or no cwd yields null', () => {
  assert.equal(pickProjectByCwd([], '/Users/x/Hypomnema'), null);
  assert.equal(pickProjectByCwd(PJS, ''), null);
  assert.equal(pickProjectByCwd(PJS, null, { realpathCwd: null }), null);
});

test('projects without working_dir are skipped', () => {
  const mixed = [
    { slug: 'nowd', workingDir: null },
    { slug: 'hypomnema', workingDir: '/Users/sangkyu/Workspace/Hypomnema' },
  ];
  assert.equal(pickProjectByCwd(mixed, '/Users/SKLIM/y/Hypomnema'), 'hypomnema');
});

suite('pickProjectByCwd() — review-hardened edges (raw-first, fail-closed tier 2)');

test('raw cwd match wins over a longer realpath match (fallback, not race)', () => {
  const pjs = [
    { slug: 'a', workingDir: '/links/a' },
    { slug: 'b', workingDir: '/physical/deep/b' },
  ];
  // raw cwd is under /links/a; realpath resolves under the longer /physical/deep/b.
  // A naive global longest-prefix race would pick 'b'; raw-first must keep 'a'.
  assert.equal(pickProjectByCwd(pjs, '/links/a/x', { realpathCwd: '/physical/deep/b/sub' }), 'a');
});

test('realpath still rescues a tier-1 match when raw cwd matches nothing', () => {
  const pjs = [{ slug: 'b', workingDir: '/physical/b' }];
  assert.equal(pickProjectByCwd(pjs, '/links/b/x', { realpathCwd: '/physical/b/x' }), 'b');
});

test('tier 2 declines when two projects match along the cwd chain (fail closed)', () => {
  const pjs = [
    { slug: 'monorepo', workingDir: '/Users/A/monorepo' },
    { slug: 'api', workingDir: '/Users/A/services/api' },
  ];
  // cross-machine cwd: no absolute prefix; both `monorepo` and `api` are unique
  // basenames in the chain, so cwd cannot disambiguate → null (not a guess).
  assert.equal(pickProjectByCwd(pjs, '/Users/B/monorepo/api'), null);
});

test('tier 2 still matches when only one project sits in the cwd chain', () => {
  const pjs = [
    { slug: 'monorepo', workingDir: '/Users/A/monorepo' },
    { slug: 'other', workingDir: '/Users/A/other' },
  ];
  // `api` is not a project basename, only `monorepo` matches → single, so it wins.
  assert.equal(pickProjectByCwd(pjs, '/Users/B/monorepo/api'), 'monorepo');
});

suite('atomicWrite() (the one shared writer, hooks/atomic-write.mjs)');

test('a normal write lands the target and leaves no tmp file', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'nested', 'page.md');
    atomicWrite(target, 'hello');
    assert.equal(readFileSync(target, 'utf-8'), 'hello');
    // No stray `.<pid>.<rand>.tmp` sibling in the directory that received it.
    const leftovers = readdirSync(join(dir, 'nested')).filter((f) => f !== 'page.md');
    assert.deepEqual(leftovers, []);
  });
});

// The three tests around this one pin cleanup, not atomicity: a naive
// `writeFileSync(target)` with no temp at all throws on a directory target and
// creates nothing on an unwritable directory, so it passes them both. This one
// is the discriminator. A read-only FILE inside a writable directory can be
// replaced by a rename (rename needs write permission on the directory, not on
// the file) and cannot be opened for writing directly. So this succeeds only if
// the write really goes through a temp file and a rename.
//
// Disabling the check: replace the body of hooks/atomic-write.mjs's atomicWrite
// with a direct `writeFileSync(path, content)`. This test goes red with EACCES
// while the other three stay green, which is the whole point of adding it.
test('a read-only target is still replaced, which only a temp+rename write can do', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'locked.md');
    writeFileSync(target, 'old');
    chmodSync(target, 0o444);
    try {
      atomicWrite(target, 'new');
      assert.equal(readFileSync(target, 'utf-8'), 'new');
      const leftovers = readdirSync(dir).filter((f) => f !== 'locked.md');
      assert.deepEqual(leftovers, [], `no tmp may survive a success: ${leftovers.join(', ')}`);
    } finally {
      chmodSync(target, 0o644);
    }
  });
});

test('a failed rename leaves no tmp file behind (ISSUE-150 regression)', () => {
  // ISSUE-150: two of the five old per-file copies of this function only
  // cleaned up the tmp on a RENAME failure; that half is not new, so this
  // pins it against the shared function too. Force a rename failure without
  // touching permissions: renameSync(file, existingDirectory) always fails
  // with EISDIR, old being a file and new being a directory (POSIX rename(2)).
  withTmpDir((dir) => {
    const target = join(dir, 'blocked');
    mkdirSync(target); // target already exists AS A DIRECTORY, not a file
    assert.throws(() => atomicWrite(target, 'payload'));
    // The tmp write succeeded (the directory that receives it is writable);
    // only the rename failed. Nothing but the original directory may remain.
    assert.deepEqual(readdirSync(dir), ['blocked']);
    assert.equal(existsSync(target) && statSync(target).isDirectory(), true);
  });
});

test('a write that cannot open its tmp file throws and creates nothing', () => {
  // This is NOT the write-failure half of the tmp cleanup, and the name no
  // longer claims to be. An EACCES on the directory fails inside
  // writeFileSync's own open(), before any byte lands on disk, so no tmp
  // entry exists for the catch to remove and the assertion below passes
  // whether or not the catch runs at all. Measured: a reconstruction of the
  // old no-catch copies passes it too.
  //
  // What it does pin is worth having on its own. atomicWrite refuses as a
  // unit, leaving neither a tmp nor a half-made target, so it stays under a
  // name that says that and not more.
  //
  // The cleanup after a write that already put bytes on disk (ENOSPC, EDQUOT)
  // has no test. Neither Node v26 (argument validation runs before the file is
  // opened) nor a `ulimit -f` cap (SIGXFSZ kills the process before any catch
  // can run) gives a portable, in-process way to reach it, and a real
  // out-of-space filesystem is not something this suite builds. The rename
  // half above IS pinned, and that is the half both surviving copies already
  // had; this one is the half the shared function added, still unproven.
  //
  // Technique (stripping write permission from a repo-external tmp dir, never
  // the checkout) follows tests/feedback.test.mjs's `--ensure-container` test.
  withTmpDir((dir) => {
    const sub = join(dir, 'readonly');
    mkdirSync(sub, { recursive: true });
    const target = join(sub, 'page.md');
    chmodSync(sub, 0o500); // r-x: mkdirSync's existence check still passes, writeFileSync cannot
    try {
      assert.throws(() => atomicWrite(target, 'payload'));
      assert.deepEqual(readdirSync(sub), []); // no tmp, no target
    } finally {
      chmodSync(sub, 0o700); // restore so withTmpDir's cleanup can remove the tree
    }
  });
});

// ── writeSettingsJson (scripts/lib/settings-write.mjs) ───────────────────────

suite('writeSettingsJson() (the settings.json writer)');

const SETTINGS_WRITE_URL = pathToFileURL(join(SCRIPTS, 'lib', 'settings-write.mjs')).href;
const IS_ROOT = process.getuid?.() === 0;

// Runs writeSettingsJson(path, text) in a child with umask pinned to 0o022 (a runner umask of
// 0o077 would make the default mode 0o600 and hide a missing mode restore), HOME and HYPO_DIR
// pinned, CLAUDE_CONFIG_DIR unset. A thrown error comes back as `CAUGHT <code>|<written>|<message>`
// on stderr with exit 3; success prints the result as JSON on stdout.
function runSettingsWriter(dir, path, text, { preload, env = {} } = {}) {
  const script = join(dir, 'settings-writer-child.mjs');
  writeFileSync(
    script,
    `process.umask(0o022);
const { writeSettingsJson } = await import(${JSON.stringify(SETTINGS_WRITE_URL)});
try {
  console.log(JSON.stringify(writeSettingsJson(process.argv[2], process.argv[3])));
} catch (err) {
  console.error(\`CAUGHT \${err.code}|\${err.written}|\${err.message}\`);
  process.exit(3);
}
`,
  );
  const childEnv = { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir, ...env };
  delete childEnv.CLAUDE_CONFIG_DIR;
  const res = spawnSync(
    process.execPath,
    [...(preload ? ['-r', preload] : []), script, path, text],
    { encoding: 'utf8', timeout: 5000, env: childEnv },
  );
  return { ...res, json: res.status === 0 ? JSON.parse(res.stdout) : null };
}

// Makes chmodSync fail with EPERM, so the mode restore after the rename cannot happen.
function chmodFaultPreload(dir) {
  const preloadPath = join(dir, 'chmod-fault.cjs');
  writeFileSync(
    preloadPath,
    `const fs = require('node:fs');
fs.chmodSync = function () {
  const err = new Error('injected chmod failure');
  err.code = 'EPERM';
  throw err;
};
require('node:module').syncBuiltinESMExports();
`,
  );
  return preloadPath;
}

function skipAsRoot(name) {
  console.log(`  skipped (running as root, permissions are not enforced): ${name}`);
}

test('writeSettingsJson keeps a symlinked settings.json a link and updates its target', () => {
  withTmpDir((dir) => {
    const store = join(dir, 'store');
    mkdirSync(store);
    const real = join(store, 'settings.json');
    writeFileSync(real, 'old\n');
    const b = join(dir, 'b');
    const a = join(dir, 'a');
    symlinkSync(real, b);
    symlinkSync('b', a);
    const res = writeSettingsJson(a, 'new\n');
    assert.ok(lstatSync(a).isSymbolicLink());
    assert.ok(lstatSync(b).isSymbolicLink());
    assert.equal(readlinkSync(a), 'b');
    assert.equal(readlinkSync(b), real);
    assert.equal(readFileSync(real, 'utf8'), 'new\n');
    assert.deepEqual(readdirSync(store), ['settings.json']);
    assert.equal(res.viaLink, true);
    assert.equal(res.target, realpathSync(real));
  });
});

test('a relative .. link under a directory link writes the intended target and leaves the decoy', () => {
  withTmpDir((dir) => {
    const base = realpathSync(dir);
    const team = join(base, 'store', 'team');
    mkdirSync(team, { recursive: true });
    mkdirSync(join(base, 'cfg'));
    const real = join(base, 'store', 'settings.json');
    const decoy = join(base, 'cfg', 'settings.json');
    writeFileSync(real, 'old\n');
    writeFileSync(decoy, 'decoy-bytes\n');
    symlinkSync(team, join(base, 'cfg', 'alias'));
    symlinkSync('../settings.json', join(team, 'settings.json'));
    const res = writeSettingsJson(join(base, 'cfg', 'alias', 'settings.json'), 'new\n');
    assert.equal(readFileSync(real, 'utf8'), 'new\n');
    assert.equal(readFileSync(decoy, 'utf8'), 'decoy-bytes\n');
    assert.ok(lstatSync(join(base, 'cfg', 'alias')).isSymbolicLink());
    assert.equal(readlinkSync(join(team, 'settings.json')), '../settings.json');
    assert.equal(res.target, real);
    assert.equal(res.viaLink, true);
  });
});

test('dangling link into an existing directory is created through the link', () => {
  withTmpDir((dir) => {
    const claude = join(dir, 'claude');
    mkdirSync(claude);
    mkdirSync(join(dir, 'claude-work'));
    const link = join(dir, 'claude-work', 'settings.json');
    const real = join(claude, 'settings.json');
    symlinkSync(real, link);
    const res = writeSettingsJson(link, 'new\n');
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), real);
    assert.equal(readFileSync(real, 'utf8'), 'new\n');
    assert.equal(res.viaLink, true);
  });
});

test('a dangling link into a missing directory is refused and creates nothing', () => {
  withTmpDir((dir) => {
    const link = join(dir, 'settings.json');
    const missing = join(dir, 'nodir');
    symlinkSync(join(missing, 'settings.json'), link);
    assert.throws(
      () => writeSettingsJson(link, 'new\n'),
      (err) => err.code === 'ENOENT' && err.message.includes(link),
    );
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(missing), false);
  });
});

test('a settings.json link loop is refused with ELOOP', () => {
  withTmpDir((dir) => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    symlinkSync('b', a);
    symlinkSync('a', b);
    const res = runSettingsWriter(dir, a, 'new\n');
    assert.equal(res.error, undefined); // finished inside the 5s timeout
    assert.equal(res.status, 3);
    assert.ok(res.stderr.includes('CAUGHT ELOOP'), res.stderr);
    assert.ok(res.stderr.includes(a), res.stderr);
    assert.equal(readlinkSync(a), 'b');
    assert.equal(readlinkSync(b), 'a');
  });
});

test('writeSettingsJson falls back to an in-place write with a notice when atomicWrite is refused', () => {
  if (IS_ROOT) return skipAsRoot('in-place fallback');
  withTmpDir((dir) => {
    const ro = join(dir, 'ro');
    mkdirSync(ro);
    const file = join(ro, 'settings.json');
    writeFileSync(file, 'old\n');
    chmodSync(ro, 0o555);
    try {
      const res = runSettingsWriter(dir, file, 'new\n');
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json.atomic, false);
      assert.equal(readFileSync(file, 'utf8'), 'new\n');
      assert.match(res.stderr, /not writable for an atomic replace, wrote in place/);
      assert.equal(res.stderr.trim().split('\n').length, 1);
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});

test('a symlinked settings.json whose target directory is read-only keeps the link and gets the bytes in place', () => {
  if (IS_ROOT) return skipAsRoot('symlink into a read-only directory');
  withTmpDir((dir) => {
    const ro = join(dir, 'ro');
    mkdirSync(ro);
    const real = join(ro, 'settings.json');
    writeFileSync(real, 'old\n');
    const link = join(dir, 'settings.json');
    symlinkSync(real, link);
    chmodSync(ro, 0o555);
    try {
      const res = runSettingsWriter(dir, link, 'new\n');
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.json.atomic, false);
      assert.equal(res.json.viaLink, true);
      assert.ok(lstatSync(link).isSymbolicLink());
      assert.equal(readFileSync(real, 'utf8'), 'new\n');
      assert.match(res.stderr, /wrote in place/);
      assert.equal(res.stderr.trim().split('\n').length, 1);
    } finally {
      chmodSync(ro, 0o700);
    }
  });
});

test('writeSettingsJson keeps the file mode', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old\n');
    chmodSync(file, 0o600);
    const res = runSettingsWriter(dir, file, 'new\n');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(res.json.atomic, true);
    assert.equal(res.json.modeRestored, true);
  });
});

test('writeSettingsJson replaces a read-only settings.json and keeps it read-only', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old\n');
    chmodSync(file, 0o444);
    const res = runSettingsWriter(dir, file, 'new\n');
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
    assert.equal(statSync(file).mode & 0o777, 0o444);
    assert.equal(res.json.atomic, true);
  });
});

test('writeSettingsJson reports a mode it could not narrow back as an error that says the write happened', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old\n');
    chmodSync(file, 0o600);
    const res = runSettingsWriter(dir, file, 'new\n', { preload: chmodFaultPreload(dir) });
    assert.equal(res.status, 3, res.stderr);
    assert.match(
      res.stderr,
      /^CAUGHT SETTINGS_MODE_NOT_RESTORED\|true\|settings\.json was written, but/m,
    );
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
  });
});

test('writeSettingsJson keeps the write and only notes a mode it could not restore when the new mode is not wider', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'old\n');
    chmodSync(file, 0o666);
    const res = runSettingsWriter(dir, file, 'new\n', { preload: chmodFaultPreload(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.modeRestored, false);
    assert.match(res.stderr, /written, mode not restored/);
    assert.equal(readFileSync(file, 'utf8'), 'new\n');
  });
});

test('writeSettingsJson leaves settings.json whole when its write fails partway', () => {
  withTmpDir((dir) => {
    const file = join(dir, 'settings.json');
    const start = '{"hooks":{"a":[1,2,3]},"keep":"these bytes"}\n';
    writeFileSync(file, start);
    const { preloadPath, firedPath } = settingsWriteFaultPreload(dir);
    const res = runSettingsWriter(dir, file, '{"hooks":{"a":[4,5,6]},"new":"payload bytes"}\n', {
      preload: preloadPath,
      env: { HYPO_TEST_FAULT_CALLER: 'writeSettingsJson' },
    });
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /CAUGHT EIO/);
    assert.ok(existsSync(firedPath), 'the injected failure never fired');
    assert.ok(readFileSync(firedPath, 'utf8').includes('settings-write.mjs'));
    assert.equal(readFileSync(file, 'utf8'), start);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.endsWith('.tmp')),
      [],
    );
  });
});

// ── catalog scanners and session entries ─────────────────────────────────────

suite('stats/graph/verify/lint catalogs vs projects/*/sessions/ entries');

const ENTRY_COUNT = 40;
const ENTRY_ONLY_WORD = 'ZZSESSIONONLY';

// One vault, two shapes: with the 40 entries on disk or without them. The generated hot.md is
// the same in both (it links to the newest older entries), so any difference in a scanner's
// output comes from the entry files alone. `verifyEntry` makes entry 0 carry an overdue
// `verify_by`, which verify.mjs would report if it looked at the file.
function scanVault(dir, { entries, verifyEntry = false, verifyPage = false }) {
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'projects', 'p', 'sessions'), { recursive: true });
  writeFileSync(
    join(dir, 'pages', 'a.md'),
    '---\ntitle: a\ntype: page\nverify_by: still true?\nverify_by_date: 2099-01-01\n---\nsee [[b]]\n',
  );
  writeFileSync(join(dir, 'pages', 'b.md'), '---\ntitle: b\ntype: page\n---\nback to [[a]]\n');
  writeFileSync(
    join(dir, 'projects', 'p', 'notes.md'),
    '---\ntitle: notes\ntype: reference\n---\nn\n',
  );
  const models = [];
  for (let i = 0; i < ENTRY_COUNT; i++) {
    const closeId = `c${String(i).padStart(2, '0')}`;
    const date = `2026-09-${String((i % 28) + 1).padStart(2, '0')}`;
    models.push({
      project: 'p',
      closeId,
      sessionId: null,
      date,
      updated: date,
      visibilityScope: null,
      tracks: [{ id: 'masking', title: 'Masking' }],
      summary: `summary of ${closeId} ${ENTRY_ONLY_WORD}`,
      bodies: { masking: `body of ${closeId}` },
    });
  }
  const model = {
    project: 'p',
    migrated: true,
    entries: models,
    unreadable: [],
    notes: null,
    entryScope: null,
  };
  writeFileSync(join(dir, 'projects', 'p', 'hot.md'), renderViews([model]).projects.p.hot);
  if (!entries) return;
  models.forEach((m, i) => {
    let text = formatSessionEntry(m);
    if (i === 0 && verifyEntry) {
      text = text.replace(
        'type: session-entry',
        'type: page\nverify_by: entry claim\nverify_by_date: 2020-01-01',
      );
    }
    writeFileSync(join(dir, 'projects', 'p', 'sessions', `${m.date}-${m.closeId}.md`), text);
  });
  if (verifyPage) {
    writeFileSync(
      join(dir, 'pages', 'z.md'),
      '---\ntitle: z\ntype: page\nverify_by: page claim\nverify_by_date: 2020-01-01\n---\nz\n',
    );
  }
}

// Same vault with and without the entries, the CLI's stdout for each.
function withAndWithout(script, args, opts = {}) {
  let withOut;
  let withoutOut;
  withTmpDir((a) => {
    scanVault(a, { entries: true, ...opts });
    withOut = run(script, [`--hypo-dir=${a}`, ...args]);
  });
  withTmpDir((b) => {
    scanVault(b, { entries: false, ...opts });
    withoutOut = run(script, [`--hypo-dir=${b}`, ...args]);
  });
  return { withOut, withoutOut };
}

test('stats: 40 session entries do not change the page or project counts', () => {
  const { withOut, withoutOut } = withAndWithout('stats.mjs', ['--json']);
  assert.equal(withOut.status, 0, withOut.stderr);
  const stats = JSON.parse(withOut.stdout);
  assert.equal(stats.pages.total, 2, 'the two pages/ files are the whole page count');
  assert.equal(stats.projects, 1);
  assert.equal(withOut.stdout, withoutOut.stdout);
});

test('graph: 40 session entries add no nodes and no edges', () => {
  const { withOut, withoutOut } = withAndWithout('graph.mjs', ['--format=json']);
  assert.equal(withOut.status, 0, withOut.stderr);
  const graph = JSON.parse(withOut.stdout);
  assert.ok(
    graph.nodes.some((n) => n.slug === 'pages/a'),
    'the graph still lists real pages',
  );
  assert.ok(
    !graph.nodes.some((n) => n.slug.includes('/sessions/')),
    `entries leaked into nodes: ${withOut.stdout}`,
  );
  assert.equal(withOut.stdout, withoutOut.stdout);
});

test('verify: an overdue verify_by inside an entry is neither counted nor reported', () => {
  const { withOut, withoutOut } = withAndWithout('verify.mjs', ['--json'], { verifyEntry: true });
  assert.equal(withOut.status, 0, withOut.stderr);
  assert.ok(
    !withOut.stdout.includes('sessions/'),
    `entry path in verify output: ${withOut.stdout}`,
  );
  const report = JSON.parse(withOut.stdout);
  assert.equal(report.overdue.length, 0);
  assert.equal(report.ok.length, 1, 'pages/a.md is the one checked page');
  assert.equal(withOut.stdout, withoutOut.stdout);
});

test('verify: the same overdue field in pages/z.md is reported (verify does read the field)', () => {
  const { withOut } = withAndWithout('verify.mjs', ['--json'], {
    verifyEntry: true,
    verifyPage: true,
  });
  assert.equal(withOut.status, 1, `overdue page exits 1: ${withOut.stderr}`);
  const report = JSON.parse(withOut.stdout);
  assert.deepEqual(
    report.overdue.map((e) => e.file),
    [join('pages', 'z.md')],
  );
  assert.ok(!withOut.stdout.includes('sessions/'), withOut.stdout);
});

test('lint: the generated hot.md Older sessions links resolve to the entries', () => {
  withTmpDir((dir) => {
    scanVault(dir, { entries: true });
    const hot = readFileSync(join(dir, 'projects', 'p', 'hot.md'), 'utf-8');
    assert.ok(hot.includes('## Older sessions'), 'fixture must render an Older sessions section');
    const linked = hot.match(/\[\[projects\/p\/sessions\/[^\]]+\]\]/g) ?? [];
    assert.equal(linked.length, 20, 'twenty older entries are linked');
    writeFileSync(
      join(dir, 'pages', 'c.md'),
      '---\ntitle: c\ntype: page\n---\n[[projects/p/sessions/2026-09-01-nope]]\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const broken = [...out.errors, ...out.warns].filter((i) => /Broken wikilink/.test(i.message));
    // The pair: a link to an entry that does not exist is reported, so zero for the real ones means resolved.
    assert.deepEqual(
      broken.map((i) => i.message),
      ['Broken wikilink: [[projects/p/sessions/2026-09-01-nope]]'],
    );
  });
});
