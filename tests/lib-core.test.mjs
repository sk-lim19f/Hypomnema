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

// ── lib/wd-match.mjs (cross-machine project matcher) ─────────────────────────

const { pickProjectByCwd, normalizeWorkingDir } = await import(`${SCRIPTS}/lib/wd-match.mjs`);

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
