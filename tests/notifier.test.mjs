// tests/notifier.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

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
  unlinkSync,
  cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, suite } from './harness.mjs';
import {
  HOME,
  HOOKS,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  run,
  runHook,
  runWithHome,
  withTmpDir,
  withTmpHome,
} from './helpers.mjs';

// ── version-check (update notifier) ──────────────────────────────────────────

suite('version-check (update notifier)');

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

test('compareSemver: full SemVer §11 prerelease precedence (gates the guard)', () => {
  // numeric identifiers compare numerically, NOT lexically (the old bug: rc.10 < rc.2)
  assert.equal(vc.compareSemver('1.2.3-rc.2', '1.2.3-rc.10'), -1);
  assert.equal(vc.compareSemver('1.2.3-rc.10', '1.2.3-rc.2'), 1);
  // numeric identifiers rank LOWER than alphanumeric
  assert.equal(vc.compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
  // a larger set of fields outranks a strict prefix
  assert.equal(vc.compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(vc.compareSemver('1.0.0-alpha.beta', '1.0.0-alpha'), 1);
  // canonical SemVer example chain
  assert.equal(vc.compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(vc.compareSemver('1.0.0-beta', '1.0.0-beta.2'), -1);
  assert.equal(vc.compareSemver('1.0.0-rc.1', '1.0.0'), -1);
  // numeric identifiers beyond 2^53 must not collapse via Number() (codex re-review)
  assert.equal(vc.compareSemver('1.0.0-9007199254740992', '1.0.0-9007199254740993'), -1);
  assert.equal(vc.compareSemver('1.0.0-9007199254740993', '1.0.0-9007199254740992'), 1);
  assert.equal(vc.compareSemver('1.0.0-10', '1.0.0-9'), 1); // length-aware: 10 > 9
  // CORE major/minor/patch is precision-safe too (codex final-pass CONCERN)
  assert.equal(vc.compareSemver('9007199254740992.0.0', '9007199254740993.0.0'), -1);
  assert.equal(vc.compareSemver('2.0.0', '10.0.0'), -1); // length-aware core ordering
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

test('selectPluginVersion: resolves current name, legacy name, ordering, and bad input', () => {
  // current plugin name
  assert.equal(vc.selectPluginVersion([{ name: 'hypo', version: '1.3.2' }]), '1.3.2');
  // legacy name (stale/transitional marketplace.json)
  assert.equal(vc.selectPluginVersion([{ name: 'hypomnema', version: '1.3.1' }]), '1.3.1');
  // selects by name, not index — other plugins listed first must not win
  assert.equal(
    vc.selectPluginVersion([
      { name: 'other', version: '9.9.9' },
      { name: 'hypo', version: '1.3.2' },
    ]),
    '1.3.2',
  );
  // both aliases present → prefer `hypo` regardless of order (no legacy shadowing)
  assert.equal(
    vc.selectPluginVersion([
      { name: 'hypomnema', version: '1.3.1' },
      { name: 'hypo', version: '1.3.2' },
    ]),
    '1.3.2',
  );
  assert.equal(
    vc.selectPluginVersion([
      { name: 'hypo', version: '1.3.2' },
      { name: 'hypomnema', version: '1.3.1' },
    ]),
    '1.3.2',
  );
  // no matching entry → null
  assert.equal(vc.selectPluginVersion([{ name: 'other', version: '9.9.9' }]), null);
  // non-string / missing version → null
  assert.equal(vc.selectPluginVersion([{ name: 'hypo' }]), null);
  assert.equal(vc.selectPluginVersion([{ name: 'hypo', version: 42 }]), null);
  // not an array → null
  assert.equal(vc.selectPluginVersion(null), null);
  assert.equal(vc.selectPluginVersion(undefined), null);
  assert.equal(vc.selectPluginVersion({}), null);
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

// ── FEAT-1: stats.mjs failure_type aggregation ───────────────────────────────
suite('stats.mjs — failure_type aggregation (FEAT-1)');

function withStatsWiki(pages, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-stats-'));
  try {
    mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
    for (const [name, body] of Object.entries(pages)) {
      writeFileSync(join(dir, 'pages', 'feedback', name), body);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fbWithFt = (ft) =>
  `---\ntitle: T\ntype: feedback\nstatus: active\nfailure_type: ${ft}\nupdated: 2026-06-23\n---\nbody\n`;

test('stats: counts failure_type across feedback pages', () => {
  withStatsWiki(
    {
      'a.md': fbWithFt('incompleteness'),
      'b.md': fbWithFt('incompleteness'),
      'c.md': fbWithFt('overreach'),
      'd.md': '---\ntitle: T\ntype: feedback\nstatus: active\nupdated: 2026-06-23\n---\nno ft\n',
    },
    (dir) => {
      const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.failureTypes, { incompleteness: 2, overreach: 1 });
    },
  );
});

test('stats: strips trailing comment + ignores nested failure_type line', () => {
  withStatsWiki(
    {
      'a.md': fbWithFt('overreach # noted'),
      'b.md':
        '---\ntitle: T\ntype: feedback\nstatus: active\nrelations:\n  - failure_type: bogus\nupdated: 2026-06-23\n---\nnested must not count\n',
    },
    (dir) => {
      const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.failureTypes, { overreach: 1 }, `got: ${r.stdout}`);
    },
  );
});

test('stats: omits failureTypes key when no page is classified (OQ-4)', () => {
  withStatsWiki(
    { 'a.md': '---\ntitle: T\ntype: feedback\nstatus: active\nupdated: 2026-06-23\n---\nx\n' },
    (dir) => {
      const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
      const out = JSON.parse(r.stdout);
      assert.ok(!('failureTypes' in out), `failureTypes should be absent: ${r.stdout}`);
    },
  );
});

// ── stats.mjs — .hyposcanignore scan-only exclusion (A안) ────────────────────
suite('stats.mjs — .hyposcanignore scan-only exclusion');

function withScanIgnoreStatsWiki(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-stats-scanignore-'));
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'kept'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'hidden'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'kept', 'decisions'), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fbPage = '---\ntitle: T\ntype: feedback\nstatus: active\nupdated: 2026-06-23\n---\nbody\n';

test('stats: .hyposcanignore-listed source drops from the source count', () => {
  withScanIgnoreStatsWiki((dir) => {
    writeFileSync(join(dir, '.hyposcanignore'), 'sources/hidden.md\n');
    writeFileSync(join(dir, 'sources', 'hidden.md'), 'x');
    writeFileSync(join(dir, 'sources', 'kept.md'), 'x');
    const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sources, 1, `expected only kept.md counted: ${r.stdout}`);
  });
});

test('stats: .hyposcanignore-listed project dir drops from the project count and its ADRs', () => {
  withScanIgnoreStatsWiki((dir) => {
    writeFileSync(join(dir, '.hyposcanignore'), 'projects/hidden/\n');
    mkdirSync(join(dir, 'projects', 'hidden', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'hidden', 'decisions', '0001-x.md'), 'x');
    writeFileSync(join(dir, 'projects', 'kept', 'decisions', '0001-y.md'), 'x');
    const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.projects, 1, `expected hidden/ excluded: ${r.stdout}`);
    assert.equal(out.adrs, 1, `expected only kept's ADR counted: ${r.stdout}`);
  });
});

test('stats: a matching path stays in the count when only .hypoignore lists it not .hyposcanignore, and the same path is still committable (scope boundary)', () => {
  withScanIgnoreStatsWiki((dir) => {
    // No .hyposcanignore at all — parity with today when the file is absent.
    writeFileSync(join(dir, 'sources', 'plain.md'), 'x');
    const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.sources,
      1,
      `expected plain.md counted (no .hyposcanignore present): ${r.stdout}`,
    );
  });
});

test('stats: privacy .hypoignore match is still excluded (isScanIgnored widens, never narrows privacy)', () => {
  withScanIgnoreStatsWiki((dir) => {
    writeFileSync(join(dir, '.hypoignore'), 'sources/secret.md\n');
    writeFileSync(join(dir, 'sources', 'secret.md'), 'x');
    writeFileSync(join(dir, 'sources', 'kept.md'), 'x');
    const r = run('stats.mjs', ['--json', `--hypo-dir=${dir}`]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.sources, 1, `expected secret.md still excluded: ${r.stdout}`);
  });
});

// ── stale-sibling detection (ADR 0038) ────────────────────────────────────────
// Two Hypomnema installs coexist; an OLDER one owns the `hypomnema` bin on PATH
// while a newer one owns the active hooks. P = init/upgrade downgrade-guard,
// D3 = notifier sibling notice, D = doctor sibling scan. Shared logic lives in
// version-check.mjs (classifyInstall / resolveCliOnPath / computeSiblingNotice).

suite('stale-sibling: classifyInstall()');

test('classifyInstall: strictly older incoming → downgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-cl-'));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  try {
    assert.equal(
      vc.classifyInstall({ pkgRoot: a, version: '1.1.0' }, { pkgRoot: b, version: '1.2.1' }),
      'downgrade',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyInstall: same realpath root is never a downgrade (dev re-run / npm-link)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-cl-'));
  try {
    // identical pkgRoot even though versions differ → exempt
    assert.equal(
      vc.classifyInstall({ pkgRoot: dir, version: '1.1.0' }, { pkgRoot: dir, version: '9.9.9' }),
      'same',
    );
    // a symlink to the same dir must resolve equal, too
    const link = join(tmpdir(), `hypo-cl-link-${process.pid}`);
    try {
      symlinkSync(dir, link);
      assert.equal(
        vc.classifyInstall({ pkgRoot: link, version: '1.1.0' }, { pkgRoot: dir, version: '9.9.9' }),
        'same',
      );
    } finally {
      try {
        unlinkSync(link);
      } catch {}
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyInstall: newer-or-equal → ok; unparseable → unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-cl-'));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  try {
    assert.equal(
      vc.classifyInstall({ pkgRoot: a, version: '1.3.0' }, { pkgRoot: b, version: '1.2.1' }),
      'ok',
    );
    assert.equal(
      vc.classifyInstall({ pkgRoot: a, version: '1.2.1' }, { pkgRoot: b, version: '1.2.1' }),
      'ok',
    );
    assert.equal(
      vc.classifyInstall({ pkgRoot: a, version: 'garbage' }, { pkgRoot: b, version: '1.2.1' }),
      'unknown',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

suite('stale-sibling: resolveCliOnPath()');

// Build a fake npm-global layout: bin/hypomnema is a symlink into
// node_modules/hypomnema/scripts/init.mjs, mirroring a real `npm i -g` install.
function withFakeCli(version, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-cli-'));
  try {
    const pkgRoot = join(dir, 'lib', 'node_modules', 'hypomnema');
    mkdirSync(join(pkgRoot, 'scripts'), { recursive: true });
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version, bin: { hypomnema: 'scripts/init.mjs' } }),
    );
    writeFileSync(join(pkgRoot, 'scripts', 'init.mjs'), '#!/usr/bin/env node\n');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    symlinkSync(join(pkgRoot, 'scripts', 'init.mjs'), join(binDir, 'hypomnema'));
    fn({ dir, binDir, pkgRoot });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveCliOnPath: resolves symlinked bin → owning package version', () => {
  withFakeCli('1.1.0', ({ binDir, pkgRoot }) => {
    const info = vc.resolveCliOnPath('hypomnema', { PATH: binDir });
    assert.ok(info, 'expected a hit');
    assert.equal(info.version, '1.1.0');
    assert.equal(vc.realpathSafe(info.pkgRoot), vc.realpathSafe(pkgRoot));
  });
});

test('resolveCliOnPath: returns null when bin is absent from PATH', () => {
  const empty = mkdtempSync(join(tmpdir(), 'hypo-empty-'));
  try {
    assert.equal(vc.resolveCliOnPath('hypomnema', { PATH: empty }), null);
    assert.equal(vc.resolveCliOnPath('hypomnema', { PATH: '' }), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('resolveCliOnPath: first PATH hit wins (shell resolution order)', () => {
  withFakeCli('1.1.0', ({ binDir: oldBin }) => {
    withFakeCli('9.9.9', ({ binDir: newBin }) => {
      // old dir first → that's the one the shell runs
      const info = vc.resolveCliOnPath('hypomnema', { PATH: `${oldBin}:${newBin}` });
      assert.equal(info.version, '1.1.0');
    });
  });
});

suite('stale-sibling: computeSiblingNotice() + throttle');

test('computeSiblingNotice: older PATH CLI than active → notice with key + remediation', () => {
  const cli = { binPath: '/opt/homebrew/bin/hypomnema', pkgRoot: '/a', version: '1.1.0' };
  const notice = vc.computeSiblingNotice(cli, { pkgRoot: '/b', version: '1.2.1' });
  assert.ok(notice);
  assert.equal(notice.cliVersion, '1.1.0');
  assert.match(notice.line, /Stale install on PATH/);
  assert.match(notice.line, /npm uninstall -g hypomnema/);
  assert.match(notice.line, /DOWNGRADE/);
  assert.equal(notice.key, '/opt/homebrew/bin/hypomnema@1.1.0->1.2.1');
});

test('computeSiblingNotice: equal/newer/same-root/missing → null', () => {
  assert.equal(
    vc.computeSiblingNotice(
      { binPath: '/x', pkgRoot: '/a', version: '1.2.1' },
      { pkgRoot: '/b', version: '1.2.1' },
    ),
    null,
  );
  assert.equal(vc.computeSiblingNotice(null, { pkgRoot: '/b', version: '1.2.1' }), null);
  assert.equal(
    vc.computeSiblingNotice({ binPath: '/x', pkgRoot: '/a', version: '1.1.0' }, null),
    null,
  );
  assert.equal(
    vc.computeSiblingNotice({ binPath: '/x', pkgRoot: '/a', version: '1.1.0' }, { version: '' }),
    null,
  );
});

test('siblingNotified throttle: mark + read round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-sib-'));
  const path = join(dir, 'version-check.json');
  try {
    assert.equal(vc.siblingAlreadyNotified(vc.readCache(path), 'k1'), false);
    vc.markSiblingNotified(path, 'k1');
    assert.equal(vc.siblingAlreadyNotified(vc.readCache(path), 'k1'), true);
    assert.equal(vc.siblingAlreadyNotified(vc.readCache(path), 'k2'), false); // different tuple
    // mark preserves other cache fields
    vc.writeCacheAtomic(path, { latest: { npm: '1.2.0' }, siblingNotifiedFor: 'k1' });
    vc.markSiblingNotified(path, 'k3');
    const c = vc.readCache(path);
    assert.equal(c.siblingNotifiedFor, 'k3');
    assert.equal(c.latest.npm, '1.2.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downgradeGuardMessage: names both versions + the override flag', () => {
  const msg = vc.downgradeGuardMessage('1.1.0', '1.2.1', 'init');
  assert.match(msg, /Refusing to init/);
  assert.match(msg, /v1\.1\.0/);
  assert.match(msg, /v1\.2\.1/);
  assert.match(msg, /--allow-downgrade/);
});

suite('stale-sibling: init/upgrade downgrade guard (P, integration)');

// Seed a tmp HOME with ~/.claude/hypo-pkg.json describing the ACTIVE install.
function seedActivePkg(home, { pkgRoot, pkgVersion }) {
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'hypo-pkg.json'),
    JSON.stringify({ pkgRoot, pkgVersion, schemaVersion: '2.0' }, null, 2),
  );
}

test('init: refuses (exit 2) when active install is NEWER and a different root', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      // active = a different root at a far-future version → this repo would downgrade it
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell'],
        home,
      );
      assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, /Refusing to init/);
      // guard fired BEFORE writes: no hooks installed into the tmp HOME
      assert.equal(existsSync(join(home, '.claude', 'hooks')), false);
    });
  });
});

test('init: --allow-downgrade overrides the guard', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell', '--allow-downgrade'],
        home,
      );
      assert.notEqual(r.status, 2, `should not be refused\n${r.stderr}`);
    });
  });
});

test('init: same package root re-running itself is exempt (no false refusal)', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      // active pkgRoot == this repo (what init runs from) → realpath-equal → exempt
      seedActivePkg(home, { pkgRoot: REPO, pkgVersion: '99.0.0' });
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell'],
        home,
      );
      assert.notEqual(r.status, 2, `same-root must not be refused\n${r.stderr}`);
    });
  });
});

test('init: fresh HOME with no active metadata is not blocked', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell'],
        home,
      );
      assert.notEqual(r.status, 2, `fresh install must not be refused\n${r.stderr}`);
    });
  });
});

// Guard regression (codex pre-commit BLOCKER): the guard must NOT be gated on
// hooks/commands — init still writes the wiki pre-commit hook unconditionally and
// ~/.codex hooks under --codex, both of which downgrade-repoint to the stale root.
test('init: --no-hooks --no-commands is still guarded (wiki pre-commit repoint footgun)', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell', '--no-hooks', '--no-commands'],
        home,
      );
      assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, /Refusing to init/);
    });
  });
});

test('init: --codex --no-hooks --no-commands is guarded (no ~/.codex downgrade bypass)', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const r = runWithHome(
        'init.mjs',
        [
          `--hypo-dir=${wiki}`,
          '--no-git-init',
          '--no-shell',
          '--no-hooks',
          '--no-commands',
          '--codex',
        ],
        home,
      );
      assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}\n${r.stderr}`);
      // guard fired before the codex write block
      assert.equal(existsSync(join(home, '.codex', 'hooks')), false);
    });
  });
});

// codex re-review BLOCKER #1: a --no-hooks --no-commands install must STILL record
// the pkgVersion baseline, or a later stale sibling bypasses the guard (no baseline
// to compare). Prove init writes hypo-pkg.json.pkgVersion even with both off, and
// that a subsequent older init is then refused.
test('init: --no-hooks --no-commands still records pkgVersion baseline → guards later stale sibling', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      // 1st install: hooks+commands OFF, fresh HOME → must still write the baseline
      const first = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell', '--no-hooks', '--no-commands'],
        home,
      );
      assert.notEqual(
        first.status,
        2,
        `fresh --no-hooks --no-commands must not refuse\n${first.stderr}`,
      );
      const pkg = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.ok(
        pkg.pkgVersion,
        'baseline pkgVersion must be recorded even with hooks/commands off',
      );
      // 2nd install: simulate an OLDER sibling by bumping the recorded baseline to a
      // far-future version + a different root, then re-run → must now be refused.
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const second = runWithHome(
        'init.mjs',
        [`--hypo-dir=${wiki}`, '--no-git-init', '--no-shell', '--no-hooks', '--no-commands'],
        home,
      );
      assert.equal(second.status, 2, `stale re-init must be refused\n${second.stderr}`);
    });
  });
});

test('upgrade --apply: refuses (exit 2) when active install is NEWER and a different root', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(r.status, 2, `expected refusal exit 2, got ${r.status}\n${r.stderr}`);
      assert.match(r.stderr, /Refusing to upgrade --apply/);
    });
  });
});

test('upgrade --check: never blocked by the guard (report-only)', () => {
  withTmpHome((home) => {
    withTmpDir((wiki) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '99.0.0' });
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${wiki}`], home);
      assert.notEqual(r.status, 2, `check mode must not refuse\n${r.stderr}`);
    });
  });
});

suite('stale-sibling: doctor scan (D) + notifier notice (D3, integration)');

// Run a script with both a custom HOME and a custom PATH (for CLI resolution).
function runWithHomeAndPath(script, args, home, pathDir, extraEnv = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: home, PATH: pathDir, ...extraEnv },
  });
}

test('doctor: warns when an older `hypomnema` owns PATH vs the active install', () => {
  withTmpHome((home) => {
    withFakeCli('1.1.0', ({ binDir }) => {
      // active install is newer than the PATH CLI
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '1.2.1' });
      const r = runWithHomeAndPath('doctor.mjs', ['--json'], home, binDir);
      const checks = JSON.parse(r.stdout);
      const sib = checks.find((c) => c.label === 'PATH CLI vs active install');
      assert.ok(sib, 'expected a sibling check');
      assert.equal(sib.status, 'warn');
      assert.match(sib.detail, /stale sibling/);
      assert.match(sib.detail, /npm uninstall -g hypomnema/);
    });
  });
});

test('doctor: passes when PATH CLI matches/exceeds the active install', () => {
  withTmpHome((home) => {
    withFakeCli('9.9.9', ({ binDir }) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '1.2.1' });
      const r = runWithHomeAndPath('doctor.mjs', ['--json'], home, binDir);
      const checks = JSON.parse(r.stdout);
      const sib = checks.find((c) => c.label === 'PATH CLI vs active install');
      assert.equal(sib.status, 'pass');
    });
  });
});

// The sibling notice (like the update notifier) honors isOptedOut() — so under CI
// it is suppressed. The CI runner sets CI=true, so these tests must explicitly opt
// back IN by clearing the opt-out vars in the child env (CI failure 2026-06-07).
const NOTIFY_ON = { CI: '', NO_UPDATE_NOTIFIER: '', HYPO_NO_UPDATE_CHECK: '' };

test('session-start (D3): stale PATH sibling surfaces a one-shot notice, then throttles', () => {
  withTmpHome((home) => {
    withFakeCli('1.1.0', ({ binDir }) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '1.2.1' });
      const payload = JSON.stringify({ cwd: home, session_id: 'sib-test' });
      const first = spawnSync(process.execPath, [join(REPO, 'hooks', 'hypo-session-start.mjs')], {
        input: payload,
        encoding: 'utf-8',
        env: { ...process.env, ...NOTIFY_ON, HYPO_DIR: '', HOME: home, PATH: binDir },
      });
      assert.match(first.stderr, /Stale install on PATH/);
      assert.match(first.stderr, /1\.1\.0/);
      // additionalContext (LLM-visible) carries it too
      const out = JSON.parse(first.stdout);
      assert.match(out.additionalContext || '', /Stale install on PATH/);
      // ISSUE-5: and the user-visible channel (systemMessage) carries it as well
      // — stderr alone is invisible on a SessionStart hook that exits 0.
      assert.match(out.systemMessage || '', /Stale install on PATH/);
      // second start: same tuple already notified → suppressed
      const second = spawnSync(process.execPath, [join(REPO, 'hooks', 'hypo-session-start.mjs')], {
        input: payload,
        encoding: 'utf-8',
        env: { ...process.env, ...NOTIFY_ON, HYPO_DIR: '', HOME: home, PATH: binDir },
      });
      assert.doesNotMatch(second.stderr, /Stale install on PATH/);
    });
  });
});

test('session-start (D3): no notice when CLI matches active (no false nag)', () => {
  withTmpHome((home) => {
    withFakeCli('9.9.9', ({ binDir }) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '1.2.1' });
      const r = spawnSync(process.execPath, [join(REPO, 'hooks', 'hypo-session-start.mjs')], {
        input: JSON.stringify({ cwd: home, session_id: 'sib-ok' }),
        encoding: 'utf-8',
        env: { ...process.env, ...NOTIFY_ON, HYPO_DIR: '', HOME: home, PATH: binDir },
      });
      assert.doesNotMatch(r.stderr, /Stale install on PATH/);
    });
  });
});

test('session-start (D3): opted out (CI/NO_UPDATE_NOTIFIER) suppresses the sibling notice', () => {
  withTmpHome((home) => {
    withFakeCli('1.1.0', ({ binDir }) => {
      seedActivePkg(home, { pkgRoot: home, pkgVersion: '1.2.1' });
      const r = spawnSync(process.execPath, [join(REPO, 'hooks', 'hypo-session-start.mjs')], {
        input: JSON.stringify({ cwd: home, session_id: 'sib-optout' }),
        encoding: 'utf-8',
        env: { ...process.env, HYPO_DIR: '', HOME: home, PATH: binDir, CI: 'true' },
      });
      assert.doesNotMatch(r.stderr, /Stale install on PATH/);
    });
  });
});

// ── ISSUE-5: update-notifier banner routed to user-visible systemMessage ──────
// The update notice fires only for the npm/plugin channels (computeNotice skips
// 'unknown'), and the channel is derived from the RUNNING hook's install root
// (dirname(dirname(hook))). So copy the (self-contained) hooks/ tree into a fake
// `node_modules/hypomnema` root — making detectChannel() resolve to 'npm' — and
// run the COPIED hook with a seeded cache + fake HOME. Proves the banner reaches
// `systemMessage` (the user channel), not just stderr/additionalContext.
suite('update-notifier (ISSUE-5): banner routed to user-visible systemMessage');

function withFakeNpmInstall(installedVersion, fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-npm-'));
  try {
    const root = join(base, 'node_modules', 'hypomnema');
    mkdirSync(root, { recursive: true });
    cpSync(HOOKS, join(root, 'hooks'), { recursive: true }); // hooks are self-contained
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: installedVersion }),
    );
    const home = join(base, 'home');
    const cacheDir = join(home, '.claude', 'hypomnema', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    const wiki = join(base, 'wiki');
    mkdirSync(wiki, { recursive: true });
    fn({
      hook: join(root, 'hooks', 'hypo-session-start.mjs'),
      home,
      wiki,
      cachePath: join(cacheDir, 'version-check.json'),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runFakeStart(hook, home, wiki, sessionId, extraEnv = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: wiki, session_id: sessionId }),
    encoding: 'utf-8',
    env: { ...process.env, ...NOTIFY_ON, HOME: home, HYPO_DIR: wiki, ...extraEnv },
  });
}

test('session-start: fresh npm update → systemMessage carries the banner (dual-emit keeps additionalContext)', () => {
  withFakeNpmInstall('0.0.0', ({ hook, home, wiki, cachePath }) => {
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: Date.now(), latest: { npm: '999.0.0' }, notifiedFor: {} }),
    );
    const out = JSON.parse(runFakeStart(hook, home, wiki, 'upd-issue5').stdout);
    assert.match(
      out.systemMessage || '',
      /Update available! 0\.0\.0 → 999\.0\.0/,
      `update banner missing from systemMessage: ${JSON.stringify(out.systemMessage)}`,
    );
    // dual emit: the model still sees the same state via additionalContext
    assert.match(out.additionalContext || '', /Update available! 0\.0\.0 → 999\.0\.0/);
  });
});

test('session-start: already-notified version → no systemMessage (no nag)', () => {
  withFakeNpmInstall('0.0.0', ({ hook, home, wiki, cachePath }) => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        checkedAt: Date.now(),
        latest: { npm: '999.0.0' },
        notifiedFor: { npm: '999.0.0' },
      }),
    );
    const out = JSON.parse(runFakeStart(hook, home, wiki, 'upd-issue5-nonag').stdout);
    assert.ok(
      !('systemMessage' in out),
      `expected no systemMessage when already notified: ${JSON.stringify(out.systemMessage)}`,
    );
  });
});

test('session-start: opted out (CI) → update banner suppressed on every channel', () => {
  withFakeNpmInstall('0.0.0', ({ hook, home, wiki, cachePath }) => {
    writeFileSync(
      cachePath,
      JSON.stringify({ checkedAt: Date.now(), latest: { npm: '999.0.0' }, notifiedFor: {} }),
    );
    // CI:'true' overrides NOTIFY_ON's CI:'' → isOptedOut() true
    const out = JSON.parse(
      runFakeStart(hook, home, wiki, 'upd-issue5-optout', { CI: 'true' }).stdout,
    );
    assert.ok(!('systemMessage' in out), 'opted-out session must not surface an update banner');
  });
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
  'hypo-web-fetch-ingest',
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

// ── hypo-web-fetch-ingest.mjs — PostToolUse auto-ingest signal ──────
//
// Coverage Matrix id (spec §9.1.1): `hook replay (PostToolUse WebFetch)`.
// PostToolUse uses **nested** hookSpecificOutput.additionalContext (Claude
// Code docs "Add context for Claude" + 515458f per-event matrix), unlike the
// UserPromptSubmit hooks that use top-level additionalContext via buildOutput().
suite('hypo-web-fetch-ingest.mjs — PostToolUse auto-ingest signal (fix #2)');

function runWebFetchHook(payload, env = {}) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-web-fetch-ingest.mjs')], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: '', ...env },
  });
}

test('replay-post-tool-use-web-fetch-injects-nested-additional-context: nudge under hookSpecificOutput', () => {
  const r = runWebFetchHook({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com/article' },
    tool_response: { ok: true },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
  // PostToolUse requires nested shape, not top-level.
  assert.equal(
    out.additionalContext,
    undefined,
    'top-level additionalContext is wrong for PostToolUse',
  );
  assert.ok(out.hookSpecificOutput, 'missing hookSpecificOutput');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /WebFetch/);
  assert.match(out.hookSpecificOutput.additionalContext, /https:\/\/example\.com\/article/);
  assert.match(out.hookSpecificOutput.additionalContext, /\/hypo:ingest/);
});

test('replay-post-tool-use-web-search-injects-weak-signal: WebSearch nudge without URL', () => {
  const r = runWebFetchHook({
    tool_name: 'WebSearch',
    tool_input: { query: 'claude code hooks docs' },
    tool_response: { ok: true },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out.hookSpecificOutput, 'expected nested hookSpecificOutput for WebSearch');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /WebSearch/);
  // Weak nudge: no specific URL echoed (tool_response shape isn't a stable contract).
  assert.ok(
    !/https?:\/\//.test(out.hookSpecificOutput.additionalContext),
    'weak nudge must not echo URLs from tool_response',
  );
});

test('replay-post-tool-use-skips-non-web-tools: Write/Edit/Bash → no signal', () => {
  for (const tool of ['Write', 'Edit', 'Bash', 'Read']) {
    const r = runWebFetchHook({ tool_name: tool, tool_input: { file_path: '/tmp/x' } });
    assert.equal(r.status, 0, `${tool} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `${tool}: continue must remain true`);
    assert.equal(out.suppressOutput, true);
    assert.equal(
      out.hookSpecificOutput,
      undefined,
      `${tool} must not produce hookSpecificOutput (only WebFetch/WebSearch do)`,
    );
  }
});

test('replay-post-tool-use-redacts-url-query-tokens: query/hash stripped before context injection', () => {
  const r = runWebFetchHook({
    tool_name: 'WebFetch',
    tool_input: {
      url: 'https://api.example.com/v1/users?token=sk-leakedvalue&session=abc#access_token=xyz',
    },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput?.additionalContext ?? '';
  // origin + pathname only; query/hash MUST be absent.
  assert.match(ctx, /https:\/\/api\.example\.com\/v1\/users/);
  assert.ok(!/sk-leakedvalue/.test(ctx), `query token leaked into context: ${ctx}`);
  assert.ok(!/access_token=xyz/.test(ctx), `hash token leaked into context: ${ctx}`);
  assert.ok(!/session=abc/.test(ctx), `session param leaked into context: ${ctx}`);
  // The full raw URL must never appear in stdout either (defense in depth).
  assert.ok(!/sk-leakedvalue/.test(r.stdout), `stdout leaked secret: ${r.stdout}`);
});

test('replay-post-tool-use-respects-skip-gate: HYPO_SKIP_GATE=1 → silent pass-through', () => {
  const r = runWebFetchHook(
    { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/page' } },
    { HYPO_SKIP_GATE: '1' },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(
    out.hookSpecificOutput,
    undefined,
    'gate-skipped run must not inject any additionalContext',
  );
});

// Robustness/edge-case suite (codex pre-commit review 2026-05-23 reinforcement).
// These cover the failure modes the happy-path tests don't hit: malformed stdin,
// missing fields, malformed URLs, userinfo leaks, and non-http schemes.

test('replay-post-tool-use-invalid-json-stdin: fail-open, stderr tagged', () => {
  const r = runWebFetchHook('not-json');
  assert.equal(r.status, 0, 'malformed stdin must still exit 0');
  assert.match(r.stderr, /^\[hypo-web-fetch-ingest\] error: /m);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(out.suppressOutput, true);
  assert.equal(out.hookSpecificOutput, undefined, 'no signal on parse error');
});

test('replay-post-tool-use-web-fetch-missing-url: silent skip (no signal)', () => {
  const r = runWebFetchHook({ tool_name: 'WebFetch', tool_input: {} });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.continue, true);
  assert.equal(
    out.hookSpecificOutput,
    undefined,
    'missing url must not produce a nudge (nothing meaningful to point at)',
  );
});

test('replay-post-tool-use-redacts-userinfo: user:pass@host stripped from origin', () => {
  const r = runWebFetchHook({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://alice:s3cret@internal.example.com/dashboard' },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput?.additionalContext ?? '';
  assert.match(ctx, /https:\/\/internal\.example\.com\/dashboard/);
  assert.ok(!/alice/.test(ctx), `userinfo leaked into context: ${ctx}`);
  assert.ok(!/s3cret/.test(ctx), `password leaked into context: ${ctx}`);
  assert.ok(!/alice|s3cret/.test(r.stdout), `userinfo leaked in stdout: ${r.stdout}`);
});

test('replay-post-tool-use-rejects-non-http-schemes: file:// / ftp:// / data: → no signal', () => {
  for (const url of [
    'file:///Users/secret/data.txt',
    'ftp://example.com/private.tar.gz',
    'data:text/plain;base64,aGVsbG8=',
    'javascript:alert(1)',
  ]) {
    const r = runWebFetchHook({ tool_name: 'WebFetch', tool_input: { url } });
    assert.equal(r.status, 0, `${url} stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.hookSpecificOutput,
      undefined,
      `non-http scheme ${url} must be rejected (no transcript echo)`,
    );
    assert.ok(
      !/Users\/secret|private\.tar\.gz|aGVsbG8|alert/.test(r.stdout),
      `non-http URL contents leaked in stdout: ${r.stdout}`,
    );
  }
});
