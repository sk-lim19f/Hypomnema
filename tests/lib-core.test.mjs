// tests/lib-core.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from './helpers.mjs';

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
