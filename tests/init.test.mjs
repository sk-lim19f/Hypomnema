// tests/init.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  cpSync,
  realpathSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
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
  runWithHome,
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

suite('init.mjs --lint-strict opt-in gate (ISSUE-59)');

test('default init: wiki pre-commit hook does not wire lint --strict', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const content = readFileSync(join(hypoDir, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.ok(
      !content.includes('lint.mjs'),
      `--lint-strict was not requested; hook must not reference lint.mjs: ${content}`,
    );
  });
});

test('--lint-strict init: wiki pre-commit hook sequences lint --strict after the .hypoignore guard', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    const r = run('init.mjs', [
      `--hypo-dir=${hypoDir}`,
      '--no-hooks',
      '--no-git-init',
      '--lint-strict',
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const content = readFileSync(join(hypoDir, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.ok(content.includes('lint.mjs'), `hook should reference lint.mjs: ${content}`);
    assert.ok(content.includes('--strict'), `hook should pass --strict: ${content}`);
    // Sequential, not the old "exit $?" tail-call that made a second step
    // unreachable dead code.
    assert.ok(!content.includes('exit $?'), `hook must not tail-call exit $?: ${content}`);
    const workerIdx = content.indexOf('hypo-pre-commit.mjs');
    const lintIdx = content.indexOf('lint.mjs');
    assert.ok(
      workerIdx !== -1 && lintIdx !== -1 && workerIdx < lintIdx,
      `.hypoignore guard must run before the lint --strict gate: ${content}`,
    );
  });
});

test('--lint-strict init: commit is blocked when a staged page fails lint --strict (W1 no-frontmatter)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.email', 'test@hypo.test'], {
      stdio: 'ignore',
    });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.name', 'Hypo Test'], { stdio: 'ignore' });
    const r = run('init.mjs', [
      `--hypo-dir=${hypoDir}`,
      '--no-hooks',
      '--no-git-init',
      '--lint-strict',
    ]);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    spawnSync('git', ['-C', hypoDir, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

    writeFileSync(join(hypoDir, 'pages', 'broken.md'), 'no frontmatter here\n');
    spawnSync('git', ['-C', hypoDir, 'add', 'pages/broken.md'], { stdio: 'ignore' });

    const commitR = spawnSync(
      'git',
      ['-C', hypoDir, 'commit', '-m', 'add page missing frontmatter'],
      { encoding: 'utf-8' },
    );
    assert.notEqual(
      commitR.status,
      0,
      `git commit should be blocked by lint --strict: ${commitR.stdout}${commitR.stderr}`,
    );
  });
});

test('default init (no --lint-strict): the same lint violation does NOT block the commit', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.email', 'test@hypo.test'], {
      stdio: 'ignore',
    });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.name', 'Hypo Test'], { stdio: 'ignore' });
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    spawnSync('git', ['-C', hypoDir, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

    writeFileSync(join(hypoDir, 'pages', 'broken.md'), 'no frontmatter here\n');
    spawnSync('git', ['-C', hypoDir, 'add', 'pages/broken.md'], { stdio: 'ignore' });

    const commitR = spawnSync(
      'git',
      ['-C', hypoDir, 'commit', '-m', 'add page missing frontmatter'],
      { encoding: 'utf-8' },
    );
    assert.equal(
      commitR.status,
      0,
      `--lint-strict was not opted in; commit must not be blocked: ${commitR.stdout}${commitR.stderr}`,
    );
  });
});

test('--lint-strict init with a RELATIVE --hypo-dir bakes an absolute path into the hook (codex BLOCKER)', () => {
  withTmpDir((parentDir) => {
    const hypoDir = join(parentDir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'init.mjs'),
        '--hypo-dir=wiki',
        '--no-hooks',
        '--no-git-init',
        '--lint-strict',
      ],
      {
        cwd: parentDir,
        encoding: 'utf-8',
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const content = readFileSync(join(hypoDir, '.git', 'hooks', 'pre-commit'), 'utf8');
    // Git runs the hook with cwd = the wiki's own working-tree root. A
    // relative --hypo-dir baked in verbatim re-resolves at commit time
    // against THAT root, not the directory the caller meant — 'wiki' would
    // become '<hypoDir>/wiki', a path that does not exist.
    //
    // Compare against the realpath, not the mkdtempSync path verbatim: macOS
    // TMPDIR is itself a symlink (/var/folders/... -> /private/var/...), and
    // a child process's process.cwd() resolves it, so `resolve()` inside
    // init.mjs bakes in the physical path — that's still correct and
    // absolute, just not byte-identical to the pre-realpath string.
    const realHypoDir = realpathSync(hypoDir);
    assert.ok(
      content.includes(`--hypo-dir=${shellSingleQuoteForTest(realHypoDir)}`),
      `--hypo-dir must be baked in absolute (${realHypoDir}): ${content}`,
    );
    assert.ok(
      !content.includes(`--hypo-dir='wiki'`) && !content.includes('wiki/wiki'),
      `--hypo-dir must not stay relative or double up against cwd: ${content}`,
    );
  });
});

function shellSingleQuoteForTest(p) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

test('--lint-strict init with a RELATIVE --hypo-dir still blocks a real lint violation at commit time', () => {
  withTmpDir((parentDir) => {
    const hypoDir = join(parentDir, 'wiki');
    spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.email', 'test@hypo.test'], {
      stdio: 'ignore',
    });
    spawnSync('git', ['-C', hypoDir, 'config', 'user.name', 'Hypo Test'], { stdio: 'ignore' });
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'init.mjs'),
        '--hypo-dir=wiki',
        '--no-hooks',
        '--no-git-init',
        '--lint-strict',
      ],
      {
        cwd: parentDir,
        encoding: 'utf-8',
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    assert.equal(r.status, 0, `init failed: ${r.stderr}`);

    spawnSync('git', ['-C', hypoDir, 'add', '.'], { stdio: 'ignore' });
    spawnSync('git', ['-C', hypoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

    writeFileSync(join(hypoDir, 'pages', 'broken.md'), 'no frontmatter here\n');
    spawnSync('git', ['-C', hypoDir, 'add', 'pages/broken.md'], { stdio: 'ignore' });

    // git invokes the hook with cwd = hypoDir (the wiki's own toplevel) —
    // exactly the case a relative --hypo-dir at init time gets re-resolved
    // against wrong.
    const commitR = spawnSync(
      'git',
      ['-C', hypoDir, 'commit', '-m', 'add page missing frontmatter'],
      { encoding: 'utf-8' },
    );
    assert.notEqual(
      commitR.status,
      0,
      `relative --hypo-dir at init must not defeat --lint-strict at commit time: ${commitR.stdout}${commitR.stderr}`,
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

// ── ISSUE-53: dry-run write-set must equal the real write-set ────────────────
// writePkgJson() used to gate BOTH the write and the "Created" log entry
// behind `if (!dryRun)` — every other write path in this file only gates the
// write, and always logs, so dry-run can preview it. That meant a dry-run
// never mentioned ~/.claude/hypo-pkg.json at all, so the reported write-set
// was smaller than what the real run actually wrote — exactly the property
// `--dry-run` promises never to have.
suite('init.mjs — dry-run write-set parity (ISSUE-53)');

function parseCreated(stdout) {
  const m = stdout.match(/✓ Created \(\d+\):\n([\s\S]*?)(?:\n\n|$)/);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*/, ''))
    .filter(Boolean);
}

test('dry-run reports the exact same write-set as a real run', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const commonArgs = [
        `--hypo-dir=${hypoDir}`,
        '--no-hooks',
        '--no-commands',
        '--no-shell',
        '--no-git-init',
      ];

      const dry = runWithHome('init.mjs', [...commonArgs, '--dry-run'], home);
      assert.equal(dry.status, 0, `dry-run failed: ${dry.stderr}`);
      const dryCreated = parseCreated(dry.stdout)
        .map((p) => p.replace(hypoDir, '<hypoDir>').replace(home, '<home>'))
        .sort();

      // real run needs its own untouched hypoDir + home so it starts from the
      // identical fresh state the dry-run measured.
      const real = runWithHome('init.mjs', commonArgs, home);
      assert.equal(real.status, 0, `real run failed: ${real.stderr}`);
      const realCreated = parseCreated(real.stdout)
        .map((p) => p.replace(hypoDir, '<hypoDir>').replace(home, '<home>'))
        .sort();

      assert.deepEqual(
        dryCreated,
        realCreated,
        `dry-run write-set must equal the real write-set.\ndry: ${JSON.stringify(dryCreated)}\nreal: ${JSON.stringify(realCreated)}`,
      );
      assert.ok(
        dryCreated.some((p) => p.includes('hypo-pkg.json')),
        `dry-run must preview the hypo-pkg.json write: ${JSON.stringify(dryCreated)}`,
      );
      assert.ok(
        existsSync(join(home, '.claude', 'hypo-pkg.json')),
        'real run must have actually written hypo-pkg.json',
      );
    });
  });
});

// ── ISSUE-52 (init side): plugin-channel install must not lay hooks/settings/
// commands on top of a plugin install ────────────────────────────────────────
// Mirrors upgrade.mjs's own plugin-mode guard (ISSUE-6): run a COPY of
// init.mjs from a fake root whose path matches the plugin-cache shape
// (`.claude/plugins/…`) so the channel detector (gated on init.mjs's own
// script location) fires, and confirm the Claude core hook/settings/command
// surface is skipped rather than double-installed.
suite('init.mjs — plugin channel gating (ISSUE-52)');

function withFakeInitInstall(underPlugins, fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-init-plugin-'));
  try {
    const root = underPlugins
      ? join(base, '.claude', 'plugins', 'cache', 'mp', 'hypomnema', '1.3.0')
      : join(base, 'lib', 'node_modules', 'hypomnema');
    mkdirSync(root, { recursive: true });
    cpSync(SCRIPTS, join(root, 'scripts'), { recursive: true });
    cpSync(join(REPO, 'hooks'), join(root, 'hooks'), { recursive: true });
    cpSync(join(REPO, 'commands'), join(root, 'commands'), { recursive: true });
    cpSync(join(REPO, 'templates'), join(root, 'templates'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(root, 'package.json'));
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    fn({ init: join(root, 'scripts', 'init.mjs'), root, home });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runInitFrom(init, args, home) {
  return spawnSync(process.execPath, [init, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: home },
  });
}

test('plugin mode: does not install ~/.claude/hooks, settings.json entries, or commands', () => {
  withFakeInitInstall(true, ({ init, home }) => {
    const hypoDir = join(tmpdir(), `hypo-init-plugin-wiki-${process.pid}-${Date.now()}`);
    try {
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `plugin-mode init should exit 0: ${r.stderr}`);
      assert.equal(
        existsSync(join(home, '.claude', 'hooks')),
        false,
        'plugin mode must NOT create ~/.claude/hooks (double-registration footgun)',
      );
      assert.equal(
        existsSync(join(home, '.claude', 'commands', 'hypo')),
        false,
        'plugin mode must NOT create ~/.claude/commands/hypo',
      );
      const settingsPath = join(home, '.claude', 'settings.json');
      if (existsSync(settingsPath)) {
        assert.doesNotMatch(
          readFileSync(settingsPath, 'utf-8'),
          /hypo-session-start/,
          'plugin mode must NOT register hook events into settings.json',
        );
      }
      assert.match(
        r.stdout,
        /provided by the plugin loader/,
        'plugin mode must log a skip explaining hooks/settings/commands are plugin-provided',
      );
    } finally {
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

test('regression baseline: npm/manual channel still installs hooks + settings', () => {
  withFakeInitInstall(false, ({ init, home }) => {
    const hypoDir = join(tmpdir(), `hypo-init-npm-wiki-${process.pid}-${Date.now()}`);
    try {
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `npm/manual init should exit 0: ${r.stderr}`);
      assert.equal(
        existsSync(join(home, '.claude', 'hooks', 'hypo-session-start.mjs')),
        true,
        'npm/manual channel must still install core hooks (baseline unaffected)',
      );
      const settingsPath = join(home, '.claude', 'settings.json');
      assert.ok(existsSync(settingsPath), 'npm/manual channel must still write settings.json');
      assert.match(
        readFileSync(settingsPath, 'utf-8'),
        /hypo-session-start/,
        'npm/manual channel must still register hook events',
      );
    } finally {
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// ── ISSUE-52 follow-up: dual-install pointer preservation ────────────────────
// A manual/npm init run while the Hypomnema plugin is ALSO enabled is a dual
// install: init.mjs is NOT under `.claude/plugins/` (so pluginMode is off), but
// isHypomnemaPluginEnabled fires on settings.json. The plugin owns the active
// runtime hooks, which resolve lint/feedback through hypo-pkg.json.pkgRoot. So
// init must skip the core surface AND preserve a valid plugin-owned pkgRoot
// instead of clobbering it with the npm path — mirroring upgrade.mjs's dualSkip.
// These exercise the settings-based branch the ISSUE-52 tests above (path-based
// pluginMode) do not reach.
suite('init.mjs — dual-install pointer preservation (ISSUE-52)');

// The enabled key must match what registerPlugin puts in the registry: durable-root
// resolution looks up the EXACT enabled identifier, not any hypo-named entry.
const ENABLED_PLUGIN_KEY = 'hypo@marketplace';
function enablePlugin(home) {
  const claude = join(home, '.claude');
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    join(claude, 'settings.json'),
    JSON.stringify({ enabledPlugins: { [ENABLED_PLUGIN_KEY]: true } }),
  );
}

// A stand-in for the plugin cache root the pointer already names: a real package
// directory (has package.json), which is what the preserve predicate requires —
// a bare/empty dir is not a usable root and must fall through to the fallback.
function makePluginRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-plugin-root-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hypomnema', version: '1.0.0' }));
  return dir;
}

test('dual install preserves an existing plugin-owned pkgRoot', () => {
  withFakeInitInstall(false, ({ init, root, home }) => {
    const pluginRoot = makePluginRoot();
    const hypoDir = join(tmpdir(), `hypo-init-dual-wiki-${process.pid}-${Date.now()}`);
    try {
      enablePlugin(home);
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: pluginRoot, pkgVersion: '1.0.0' }),
      );
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      // Same core-surface skip as plugin mode (the plugin loader owns the hooks).
      assert.equal(
        existsSync(join(home, '.claude', 'hooks')),
        false,
        'dual install must NOT create ~/.claude/hooks (plugin owns them)',
      );
      const meta = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.equal(
        meta.pkgRoot,
        pluginRoot,
        `dual install must preserve the plugin-owned pkgRoot, not clobber it with the npm root (${root})`,
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// Register the plugin in BOTH settings.json (enabledPlugins) and the plugin
// registry (installed_plugins.json) so init can POSITIVELY resolve the plugin's
// real cache root, rather than trusting whatever pkgRoot is recorded.
function registerPlugin(home, pluginRoot, extraEntries = []) {
  enablePlugin(home);
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        [ENABLED_PLUGIN_KEY]: [...extraEntries, { scope: 'user', installPath: pluginRoot }],
      },
    }),
  );
}

// Provenance: the recorded pointer is NOT trusted as plugin-owned. In an npm-first
// sequence the pointer on disk is the manual/npm root itself; init must still send
// the durable identity + pre-commit hook to the plugin's REAL registry root, or the
// recommended npm uninstall dangles them.
test('dual install corrects a stale npm pointer to the registry plugin root', () => {
  withFakeInitInstall(false, ({ init, root, home }) => {
    const pluginRoot = makePluginRoot();
    const stalePointer = makePluginRoot(); // a usable dir standing in for the npm root
    const hypoDir = mkdtempSync(join(tmpdir(), 'hypo-init-provenance-'));
    try {
      spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      registerPlugin(home, pluginRoot);
      // A pre-existing pointer at the (usable) npm root — the npm-first footgun.
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: stalePointer, pkgVersion: '0.5.0' }),
      );
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      const meta = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.equal(
        meta.pkgRoot,
        pluginRoot,
        'pkgRoot must be corrected to the positively-resolved registry plugin root, not the stale/npm pointer',
      );
      assert.notEqual(meta.pkgRoot, stalePointer, 'the stale pointer must not survive');
      const hook = readFileSync(join(hypoDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
      assert.ok(
        hook.includes(join(pluginRoot, 'hooks', 'hypo-pre-commit.mjs')),
        `pre-commit must reference the registry plugin root: ${hook}`,
      );
      assert.ok(
        !hook.includes(join(realpathSync(root), 'hooks', 'hypo-pre-commit.mjs')),
        'pre-commit must not reference the manual/npm root',
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(stalePointer, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// Idempotency / no silent rewrite: once the durable identity is on disk, a second
// run is a genuine no-op — reported skipped, bytes untouched. This is the finding-#2
// lock under the durable-identity model (a real run must not silently reformat a
// file it reports as skipped). --no-hooks so writePkgJson is the sole writer.
test('dual install is idempotent: a second run leaves hypo-pkg.json untouched', () => {
  withFakeInitInstall(false, ({ init, home }) => {
    const pluginRoot = makePluginRoot();
    const hypoDir = join(tmpdir(), `hypo-init-idem-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      registerPlugin(home, pluginRoot);
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const args = [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init'];
      const first = runInitFrom(init, args, home);
      assert.equal(first.status, 0, `first init should exit 0: ${first.stderr}`);
      const afterFirst = readFileSync(pkgPath, 'utf-8');
      const second = runInitFrom(init, args, home);
      assert.equal(second.status, 0, `second init should exit 0: ${second.stderr}`);
      assert.equal(
        readFileSync(pkgPath, 'utf-8'),
        afterFirst,
        'a second run must not rewrite/reformat an already-correct hypo-pkg.json',
      );
      assert.match(
        second.stdout,
        /durable pkgRoot unchanged/,
        'the no-op write must be reported as skipped, not created',
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// Provenance must resolve the EXACT enabled key and prefer the user-scope install:
// a non-user entry preceding the user one for the same key must not be selected.
test('dual install prefers the user-scope registry entry over a preceding local entry', () => {
  withFakeInitInstall(false, ({ init, home }) => {
    const userRoot = makePluginRoot();
    const localRoot = makePluginRoot(); // a DIFFERENT project's local install, listed first
    const hypoDir = join(tmpdir(), `hypo-init-scope-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      registerPlugin(home, userRoot, [
        { scope: 'local', projectPath: '/some/other/project', installPath: localRoot },
      ]);
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      const meta = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.equal(
        meta.pkgRoot,
        userRoot,
        'the user-scope install must win over another scope listed first',
      );
      assert.notEqual(
        meta.pkgRoot,
        localRoot,
        "another project's local install must not be selected",
      );
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
      rmSync(localRoot, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// A relative installPath (e.g. ".") would resolve against the caller's cwd and
// break the vault hook from any other directory, so it is not a usable durable
// root; resolution falls back rather than recording a relative pointer.
test('dual install rejects a relative registry installPath and falls back', () => {
  withFakeInitInstall(false, ({ init, root, home }) => {
    const hypoDir = join(tmpdir(), `hypo-init-relpath-${process.pid}-${Date.now()}`);
    try {
      enablePlugin(home);
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      writeFileSync(
        join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 2,
          plugins: { [ENABLED_PLUGIN_KEY]: [{ scope: 'user', installPath: '.' }] },
        }),
      );
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      const meta = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.notEqual(
        meta.pkgRoot,
        '.',
        'a relative installPath must never be recorded as pkgRoot',
      );
      assert.ok(isAbsolute(meta.pkgRoot), `recorded pkgRoot must be absolute: ${meta.pkgRoot}`);
      assert.equal(
        realpathSync(meta.pkgRoot),
        realpathSync(root),
        'with no usable registry root, resolution falls back to PKG_ROOT',
      );
    } finally {
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// Downgrade protection must see the DURABLE (plugin) install, not just the recorded
// metadata. In an npm-first dual install the recorded pkgVersion is the stale npm
// one, so comparing only against it would let an older npm init run against a newer
// plugin. The guard must refuse (exit 2) when this package is older than the plugin.
test('dual install refuses to run an older npm init against a newer registry plugin', () => {
  withFakeInitInstall(false, ({ init, home }) => {
    const pluginRoot = mkdtempSync(join(tmpdir(), 'hypo-plugin-newer-'));
    // A plugin far newer than this package (the fake install copies the repo's
    // package.json, whose version is well below 9.9.9).
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '9.9.9' }),
    );
    const hypoDir = join(tmpdir(), `hypo-init-downgrade-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      registerPlugin(home, pluginRoot);
      // Stale npm-first metadata whose recorded version alone would NOT trip the
      // guard (it is older than this package), so only the durable-root comparison
      // catches the downgrade.
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: pluginRoot, pkgVersion: '0.1.0' }),
      );
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init'], home);
      assert.equal(
        r.status,
        2,
        `init must refuse (exit 2) as a downgrade vs the plugin: ${r.stdout}`,
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

test('dual install falls back when the recorded pkgRoot is not a usable package dir', () => {
  withFakeInitInstall(false, ({ init, root, home }) => {
    // An existing directory that is NOT a package (no package.json): the runtime
    // cannot resolve scripts through it, so preservation must NOT bless it.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'hypo-empty-root-'));
    const hypoDir = join(tmpdir(), `hypo-init-dual-unusable-${process.pid}-${Date.now()}`);
    try {
      enablePlugin(home);
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: emptyRoot, pkgVersion: '1.0.0' }),
      );
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      const meta = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
      assert.equal(
        realpathSync(meta.pkgRoot),
        realpathSync(root),
        'an existing-but-unusable pkgRoot (no package.json) must fall back to PKG_ROOT, not be preserved',
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

test('dual install writes fallback metadata when no prior pointer exists', () => {
  withFakeInitInstall(false, ({ init, root, home }) => {
    const hypoDir = join(tmpdir(), `hypo-init-dual-fresh-${process.pid}-${Date.now()}`);
    try {
      enablePlugin(home); // plugin enabled, but no hypo-pkg.json on disk yet
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      assert.ok(
        existsSync(pkgPath),
        'runtime needs a resolvable pointer — fallback must be written',
      );
      const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      // init derives PKG_ROOT from its own real script path; realpath both sides so
      // the macOS /var → /private/var symlink does not make an equal path look unequal.
      assert.equal(
        realpathSync(meta.pkgRoot),
        realpathSync(root),
        'with no prior pointer to preserve, dual install falls back to its own PKG_ROOT so resolution is not left empty',
      );
    } finally {
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});

// The vault's git pre-commit hook embeds an absolute path to hypo-pre-commit.mjs.
// In a dual install that path must be the DURABLE (plugin) root, not the manual/npm
// PKG_ROOT the dual-install notice tells the user to uninstall — otherwise the hook
// dangles the moment they do and every wiki commit fails.
test('dual install points the wiki pre-commit hook at the durable plugin root', () => {
  withFakeInitInstall(false, ({ init, root, home }) => {
    const pluginRoot = makePluginRoot();
    const hypoDir = mkdtempSync(join(tmpdir(), 'hypo-init-dual-hook-'));
    try {
      spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
      enablePlugin(home);
      writeFileSync(
        join(home, '.claude', 'hypo-pkg.json'),
        JSON.stringify({ pkgRoot: pluginRoot, pkgVersion: '1.0.0' }),
      );
      const r = runInitFrom(init, [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(r.status, 0, `dual-install init should exit 0: ${r.stderr}`);
      const hook = readFileSync(join(hypoDir, '.git', 'hooks', 'pre-commit'), 'utf-8');
      assert.ok(
        hook.includes(join(pluginRoot, 'hooks', 'hypo-pre-commit.mjs')),
        `pre-commit must reference the durable plugin root's worker: ${hook}`,
      );
      assert.ok(
        !hook.includes(join(realpathSync(root), 'hooks', 'hypo-pre-commit.mjs')),
        `pre-commit must NOT reference the manual/npm root that will be uninstalled: ${hook}`,
      );
    } finally {
      rmSync(pluginRoot, { recursive: true, force: true });
      rmSync(hypoDir, { recursive: true, force: true });
    }
  });
});
