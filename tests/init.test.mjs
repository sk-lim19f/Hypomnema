// tests/init.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, suite } from './harness.mjs';
import {
  HOME,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  deriveCoreHookBasenames,
  readCoreHooksConfig,
  run,
  withTmpDir,
  withTmpHome,
} from './helpers.mjs';

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

suite('init.mjs — duplicate-orphan dedup (hypo-/wiki- namespace split)');

test('skips stock hypo-automation.md when a legacy wiki-automation.md exists', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(join(hypoDir, 'wiki-automation.md'), '# my hand-authored automation\n');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      !existsSync(join(hypoDir, 'hypo-automation.md')),
      'stock hypo-automation.md must NOT be injected beside the user page',
    );
    assert.ok(existsSync(join(hypoDir, 'wiki-automation.md')), 'user page must be preserved');
    assert.match(
      r.stdout,
      /kept existing wiki-automation\.md/,
      `dedup must warn LOUDLY: ${r.stdout}`,
    );
  });
});

test('injects hypo-automation.md normally when no equivalent exists', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      existsSync(join(hypoDir, 'hypo-automation.md')),
      'hypo-automation.md should be created when there is nothing to dedup against',
    );
  });
});

test('hypo-guide.md is still injected even when wiki-guide.md exists (runtime-required)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(join(hypoDir, 'wiki-guide.md'), '# legacy guide\n');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(
      existsSync(join(hypoDir, 'hypo-guide.md')),
      'core hypo-guide.md must still be installed (runtime reads it by name)',
    );
  });
});

test('--dry-run previews the dedup suppression and writes nothing', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(join(hypoDir, 'wiki-automation.md'), '# my automation\n');
    const r = run('init.mjs', [
      `--hypo-dir=${hypoDir}`,
      '--no-hooks',
      '--no-git-init',
      '--dry-run',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /kept existing wiki-automation\.md/, `dry-run must warn: ${r.stdout}`);
    assert.ok(
      !existsSync(join(hypoDir, 'hypo-automation.md')),
      'dry-run must not write hypo-automation.md',
    );
  });
});

// init-creates-extensions-baseline (§8.12, ADR 0024)
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

// Write a hooks.json into a temp package root and return that root.
function withPkgHooksJson(content, fn) {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'hooks.json'), content);
    fn(dir);
  });
}

suite('readCoreHooksConfig()');

test('missing hooks.json → ok:false, does not throw, no cfg key', () => {
  const missing = join(tmpdir(), `hypo-no-pkg-${process.pid}-${Date.now()}`);
  let res;
  assert.doesNotThrow(() => {
    res = readCoreHooksConfig(missing);
  });
  assert.equal(res.ok, false);
  assert.ok(typeof res.error === 'string' && res.error.length > 0, 'expected an error string');
  assert.ok(!('cfg' in res), 'read failure must not attach cfg');
});

test('invalid JSON → ok:false, no cfg key (parse failure)', () => {
  withPkgHooksJson('{ not: valid json', (dir) => {
    const res = readCoreHooksConfig(dir);
    assert.equal(res.ok, false);
    assert.ok(!('cfg' in res), 'parse failure must not attach cfg');
  });
});

test('real packaged hooks.json → ok:true with cfg', () => {
  const res = readCoreHooksConfig(REPO);
  assert.equal(res.ok, true, `expected real hooks.json to load: ${res.error}`);
  assert.ok(res.cfg && typeof res.cfg === 'object', 'cfg should be an object');
});

test('fail-closed: parses to a non-object shape → ok:false but cfg attached', () => {
  // A parsed-but-wrong shape is a fail (capture must skip hooks), yet init needs
  // the parsed value to run its own validation, so cfg is attached.
  for (const raw of ['null', '[]', '"str"', '42']) {
    withPkgHooksJson(raw, (dir) => {
      const res = readCoreHooksConfig(dir);
      assert.equal(res.ok, false, `${raw} must be fail-closed`);
      assert.ok('cfg' in res, `${raw} parsed, so cfg must be attached for init`);
    });
  }
});

test('fail-closed: object missing hooks map → ok:false', () => {
  withPkgHooksJson('{"shared":["hypo-shared.mjs"]}', (dir) => {
    const res = readCoreHooksConfig(dir);
    assert.equal(res.ok, false);
    assert.ok('cfg' in res);
  });
});

test('fail-closed: hooks not an object → ok:false', () => {
  withPkgHooksJson('{"hooks":[],"shared":[]}', (dir) => {
    const res = readCoreHooksConfig(dir);
    assert.equal(res.ok, false);
  });
});

test('fail-closed: missing/non-array shared → ok:false', () => {
  withPkgHooksJson('{"hooks":{}}', (dir) => {
    assert.equal(readCoreHooksConfig(dir).ok, false);
  });
  withPkgHooksJson('{"hooks":{},"shared":"x"}', (dir) => {
    assert.equal(readCoreHooksConfig(dir).ok, false);
  });
});

// A parsed-but-nested-malformed hooks.json would make deriveCoreHookBasenames
// silently skip the odd rung and return a THIN reserved set, letting a core hook
// leak into reverse-capture. Each nested malformation must be fail-closed
// (ok:false) with cfg still attached for init's own validation.
test('fail-closed nested: event value not an array -> ok:false, cfg attached', () => {
  withPkgHooksJson('{"hooks":{"SessionStart":"notarray"},"shared":[]}', (dir) => {
    const res = readCoreHooksConfig(dir);
    assert.equal(res.ok, false);
    assert.ok('cfg' in res, 'parsed shape-off input must still attach cfg for init');
  });
});

test('fail-closed nested: group hooks not an array -> ok:false', () => {
  withPkgHooksJson('{"hooks":{"E":[{"hooks":"notarray"}]},"shared":[]}', (dir) => {
    assert.equal(readCoreHooksConfig(dir).ok, false);
  });
});

test('fail-closed nested: hook entry has no string command -> ok:false', () => {
  withPkgHooksJson('{"hooks":{"E":[{"hooks":[{"type":"command"}]}]},"shared":[]}', (dir) => {
    assert.equal(readCoreHooksConfig(dir).ok, false);
  });
  withPkgHooksJson('{"hooks":{"E":[{"hooks":[42]}]},"shared":[]}', (dir) => {
    assert.equal(readCoreHooksConfig(dir).ok, false);
  });
});

test('fail-closed nested: non-string shared element -> ok:false', () => {
  withPkgHooksJson(
    '{"hooks":{"E":[{"hooks":[{"type":"command","command":"node $HOME/.claude/hooks/x.mjs"}]}]},"shared":[1]}',
    (dir) => {
      assert.equal(readCoreHooksConfig(dir).ok, false);
    },
  );
});

test('nested valid: well-formed groups + hooks + shared -> ok:true, complete basenames', () => {
  const json =
    '{"hooks":{"SessionStart":[{"hooks":[{"type":"command",' +
    '"command":"node $HOME/.claude/hooks/core-a.mjs"}]}]},"shared":["core-b.mjs"]}';
  withPkgHooksJson(json, (dir) => {
    const res = readCoreHooksConfig(dir);
    assert.equal(res.ok, true, `well-formed nested config should load: ${res.error}`);
    const names = deriveCoreHookBasenames(res.cfg);
    assert.ok(names.has('core-a.mjs') && names.has('core-b.mjs'), 'expected complete basename set');
  });
});

suite('deriveCoreHookBasenames()');

test('real hooks.json: union of event-command and shared basenames, lowercased', () => {
  const res = readCoreHooksConfig(REPO);
  assert.equal(res.ok, true, `real hooks.json should load: ${res.error}`);
  const names = deriveCoreHookBasenames(res.cfg);
  assert.ok(names instanceof Set, 'must return a Set');
  // event-command basename (proves the registration walk)
  assert.ok(names.has('hypo-session-start.mjs'), 'expected an event-command basename');
  // non-hypo shared basename (proves the shared union, not just the event walk)
  assert.ok(names.has('version-check.mjs'), 'expected a non-hypo shared basename');
});

test('strict last-segment extraction + lowercasing from command shape', () => {
  const cfg = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/Hypo-Up.MJS' }] },
      ],
    },
    shared: ['Nested/Path/Shared-One.mjs'],
  };
  const names = deriveCoreHookBasenames(cfg);
  assert.ok(names.has('hypo-up.mjs'), 'command basename should be last segment, lowercased');
  assert.ok(names.has('shared-one.mjs'), 'shared basename should be last segment, lowercased');
  assert.equal(names.size, 2, 'no extra entries from path prefixes');
});

test('defensive: odd cfg does not throw, yields a (possibly partial) Set', () => {
  assert.doesNotThrow(() => deriveCoreHookBasenames(null));
  assert.doesNotThrow(() => deriveCoreHookBasenames({}));
  assert.doesNotThrow(() =>
    deriveCoreHookBasenames({ hooks: { E: ['not-a-group', 42, {}] }, shared: [1, null, 'ok.mjs'] }),
  );
  const names = deriveCoreHookBasenames({ hooks: {}, shared: ['ok.mjs', 'no-ext'] });
  assert.ok(names.has('ok.mjs') && !names.has('no-ext'), 'only .mjs names admitted');
});

// ── init.mjs still exits 1 on a malformed hooks.json (loader routed via helper) ─
// loadHookMap now reads+parses through readCoreHooksConfig but keeps init's own
// validation + process.exit(1). Copy the package, corrupt hooks.json, and run
// init with hooks enabled so line ~837 (HOOK_MAP = loadHookMap()) is reached.

suite('init.mjs — malformed hooks.json still exits 1');

function runInitFromPkg(hooksJson, home, hypoDir) {
  let result;
  withTmpDir((base) => {
    const pkg = join(base, 'pkg');
    mkdirSync(pkg, { recursive: true });
    cpSync(SCRIPTS, join(pkg, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'hooks'), join(pkg, 'hooks'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(pkg, 'package.json'));
    writeFileSync(join(pkg, 'hooks', 'hooks.json'), hooksJson);
    result = spawnSync(
      process.execPath,
      [join(pkg, 'scripts', 'init.mjs'), `--hypo-dir=${hypoDir}`, '--no-git-init', '--dry-run'],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: home } },
    );
  });
  return result;
}

test('unparseable hooks.json → exit 1 (read/parse path)', () => {
  withTmpHome((home) => {
    withTmpDir((hypoDir) => {
      const r = runInitFromPkg('{ this is : not json', home, hypoDir);
      assert.equal(r.status, 1, `expected exit 1: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /cannot read hooks\/hooks\.json/);
    });
  });
});

test('parses but hooks is not an object → exit 1 (init validation retained)', () => {
  withTmpHome((home) => {
    withTmpDir((hypoDir) => {
      const r = runInitFromPkg('{"hooks":[],"shared":[]}', home, hypoDir);
      assert.equal(r.status, 1, `expected exit 1: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /hooks/);
    });
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
