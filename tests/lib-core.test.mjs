// tests/lib-core.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, suite } from './harness.mjs';
import { HOME, SCRIPTS, expandHome, resolveHypoRoot } from './helpers.mjs';

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
