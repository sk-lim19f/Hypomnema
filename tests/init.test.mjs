// tests/init.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  symlinkSync,
  cpSync,
  realpathSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { test, suite } from './harness.mjs';
import { PROVENANCE_FILENAME } from '../scripts/lib/pkg-provenance.mjs';
import {
  hooksDirForInstall,
  SHELL_MARKER_START,
  SHELL_MARKER_END,
  SHELL_FUNCTION_BODY,
} from '../scripts/lib/git-hooks-dir.mjs';
import {
  HOME,
  HOOKS,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  deriveCoreHookBasenames,
  gitRepo,
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

test('init creates .hyposcanignore scaffold (scan-only sibling of .hypoignore, A안)', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const dest = join(hypoDir, '.hyposcanignore');
    assert.ok(existsSync(dest), '.hyposcanignore should be created');
    const content = readFileSync(dest, 'utf8');
    assert.ok(/scan/i.test(content), 'header should describe scan-only scope');
    assert.ok(
      /NOT a privacy boundary|does NOT block commit/i.test(content),
      'header should make clear this is not a commit-blocking privacy file, unlike .hypoignore',
    );
  });
});

test('init does not overwrite an existing .hyposcanignore', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    mkdirSync(hypoDir, { recursive: true });
    writeFileSync(join(hypoDir, '.hyposcanignore'), 'custom-pattern/\n');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const content = readFileSync(join(hypoDir, '.hyposcanignore'), 'utf8');
    assert.equal(content, 'custom-pattern/\n');
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

// ── templates/hypo-automation.md hook table vs hooks.json (drift guard, ISSUE-92) ──
// The doc's `| hook | event | purpose |` table is a hand-maintained mirror of
// hooks.json. Nothing regenerates it, so a hook added to hooks.json (or an event
// typo'd in the doc) drifts silently. Reuses readCoreHooksConfig/deriveCoreHookBasenames
// (already proven above against the real hooks.json) instead of re-parsing it here.

suite('templates/hypo-automation.md hook table');

function actualEventByBasename() {
  const res = readCoreHooksConfig(REPO);
  assert.equal(res.ok, true, `real hooks.json should load: ${res.error}`);
  const eventOf = new Map();
  for (const [event, groups] of Object.entries(res.cfg.hooks)) {
    // Scope the derive call to one event at a time (shared:[] so no shared
    // basenames leak in) so the union helper still does the extraction/
    // lowercasing, but per-event instead of flattened.
    for (const name of deriveCoreHookBasenames({ hooks: { [event]: groups }, shared: [] })) {
      eventOf.set(name, event);
    }
  }
  return eventOf;
}

function readAutomationDoc() {
  return readFileSync(join(REPO, 'templates', 'hypo-automation.md'), 'utf-8');
}

test('doc table lists exactly the hooks.json hooks, with matching events', () => {
  const eventOf = actualEventByBasename();
  const doc = readAutomationDoc();

  const rowRe = /^\|\s*`([\w.-]+\.mjs)`\s*\|\s*`([A-Za-z]+)`\s*\|/gm;
  const docEventOf = new Map();
  let m;
  while ((m = rowRe.exec(doc)) !== null) {
    docEventOf.set(m[1].toLowerCase(), m[2]);
  }
  assert.ok(docEventOf.size > 0, 'expected to parse at least one hook row from the doc table');

  const actualNames = new Set(eventOf.keys());
  const docNames = new Set(docEventOf.keys());

  const missingFromDoc = [...actualNames].filter((n) => !docNames.has(n));
  const extraInDoc = [...docNames].filter((n) => !actualNames.has(n));
  assert.deepEqual(
    missingFromDoc,
    [],
    `hooks.json hooks missing from the doc table: ${missingFromDoc}`,
  );
  assert.deepEqual(
    extraInDoc,
    [],
    `doc table lists hooks that hooks.json does not register: ${extraInDoc}`,
  );

  for (const [name, event] of docEventOf) {
    assert.equal(
      event,
      eventOf.get(name),
      `doc lists ${name} under ${event}, hooks.json says ${eventOf.get(name)}`,
    );
  }
});

test('doc states the current hook count, matching hooks.json', () => {
  const eventOf = actualEventByBasename();
  const doc = readAutomationDoc();
  const m = /All (\d+) hooks registered in `hooks\/hooks\.json`/.exec(doc);
  assert.ok(m, 'expected a stated hook count sentence in the doc');
  assert.equal(Number(m[1]), eventOf.size, 'stated hook count must match hooks.json');
});

// The two hooks known to reach the network as of this commit, plus the fact that the
// vault's own git remote is one of the two destinations. Deriving "reaches the network"
// from source is not something a test can do, so this pins the shape that kept getting
// written wrong rather than the property in general.
//
// Two rewrites of this paragraph shipped false claims before this assertion took its
// current form. First "no network requests" while the hook table four lines above said
// hypo-auto-commit "pushes". Then "one exception: SessionStart's update check", which
// missed that SessionStart ALSO runs a blocking `git pull --ff-only`
// (hypo-session-start.mjs:537, unconditional; isOptedOut only guards the notice
// builders). So the git-sync verbs are asserted too: dropping them is how both misses
// happened.
test('doc names every hook that reaches the network', () => {
  const doc = readAutomationDoc();
  // Bound the slice to the network paragraph itself. Slicing to end of file instead
  // let the Session Flow block below it satisfy the check: that block names the same
  // hooks for an unrelated reason, so the assertion passed with the network paragraph
  // stripped of every hook name.
  const start = doc.search(/^.*reach the network.*$/m);
  assert.ok(start >= 0, 'expected a network paragraph in the doc');
  const rest = doc.slice(start);
  const end = rest.search(/\n---\n|\n## /);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  for (const hook of ['hypo-auto-commit.mjs', 'hypo-session-start.mjs']) {
    assert.ok(
      section.includes(hook),
      `network section must name ${hook}: it makes network calls (auto-commit runs ` +
        `git pull/push via syncRemote; session-start spawns the update check)`,
    );
  }
  for (const verb of ['git pull', 'git push']) {
    assert.ok(
      section.includes(verb),
      `network section must name \`${verb}\`: the vault's own remote is one of the two ` +
        `network destinations, and it has no opt-out flag`,
    );
  }
  assert.ok(
    !/no network requests/i.test(doc),
    'doc must not blanket-claim no network requests',
  );
});

// The facts inside the network section, not just which hooks it names. Version 3 shortened
// the marketplace URL to its host and wrote "set to any value" for the opt-out; both were
// wrong and both passed the name-and-verb check above. So read the URLs out of
// version-check-fetch.mjs and require the document to carry them verbatim, and require the
// opt-out sentence to name all three variables the implementation actually reads.
test('doc carries the update-check URLs verbatim and names every opt-out variable', () => {
  const doc = readAutomationDoc();
  const fetchSrc = readFileSync(join(REPO, 'hooks', 'version-check-fetch.mjs'), 'utf-8');
  const urls = [...fetchSrc.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2, `expected the fetch URLs in version-check-fetch.mjs, got ${urls.length}`);
  for (const u of urls) {
    assert.ok(doc.includes(u), `doc must carry the fetched URL verbatim: ${u}`);
  }

  const checkSrc = readFileSync(join(REPO, 'hooks', 'version-check.mjs'), 'utf-8');
  const optOut = /Boolean\(([^)]*)\)/.exec(checkSrc.slice(checkSrc.indexOf('isOptedOut')));
  assert.ok(optOut, 'expected the isOptedOut expression in version-check.mjs');
  const vars = [...optOut[1].matchAll(/env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(vars.length >= 3, `expected the opt-out variables, got ${vars}`);
  for (const v of vars) {
    assert.ok(doc.includes(v), `doc must name the opt-out variable ${v}`);
  }
  // `Boolean(a || b || c)` means an empty string is NOT an opt-out. The document said
  // "set to any value" until this was caught; keep the distinction stated.
  assert.match(
    doc,
    /non-empty value/,
    'doc must say the opt-out needs a non-empty value, not merely being set',
  );
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

// ── CLI surface: unknown args / --version / help-dispatch consistency ───────
//
// An unrecognized argument used to fall through the parseArgs loop silently
// and run the default init flow (scaffold + hook install + settings.json
// merge) — a destructive write triggered by what read like a query. `--version`
// was the concrete case: never implemented, looks like an inspection flag, and
// a typo landed on a live wiki's pre-commit hook instead of printing anything.

suite('init.mjs — unknown args / --version / help-dispatch consistency');

test('an unrecognized flag exits 2 with a usage hint and does not run init', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--version-typo']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}. stdout: ${r.stdout}`);
    assert.ok(
      r.stderr.includes('Unknown option: --version-typo'),
      `stderr should name the bad flag: ${r.stderr}`,
    );
    assert.ok(r.stderr.includes('--help'), `stderr should point at --help: ${r.stderr}`);
    assert.ok(!existsSync(hypoDir), 'an unknown flag must not scaffold a wiki');
  });
});

test('--version prints the package version and exits 0 without scaffolding', () => {
  withTmpDir((dir) => {
    const hypoDir = join(dir, 'wiki');
    const pkgVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version;
    const r = run('init.mjs', [`--hypo-dir=${hypoDir}`, '--version']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout.trim(), pkgVersion, `stdout: ${r.stdout}`);
    assert.ok(!existsSync(hypoDir), '--version must not scaffold a wiki');
  });
});

test('--help lists exactly the dispatchable subcommand set (regression for the missing "proposal" entry)', () => {
  const r = run('init.mjs', ['--help']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const src = readFileSync(join(SCRIPTS, 'init.mjs'), 'utf-8');
  const known = src.match(/const KNOWN_SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(known, 'could not locate KNOWN_SUBCOMMANDS in scripts/init.mjs source');
  const dispatched = new Set(
    known[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean),
  );

  // Command names in the printed help: exactly 2 leading spaces, a lowercase
  // (hyphenated) word, then 2+ spaces before the description. Continuation
  // lines are indented past column 2 and the "Running ..." prose line starts
  // uppercase, so both are excluded by construction rather than by an
  // explicit denylist.
  const listed = new Set([...r.stdout.matchAll(/^ {2}([a-z][a-z-]+)\s{2,}\S/gm)].map((m) => m[1]));

  assert.ok(dispatched.size > 0, 'KNOWN_SUBCOMMANDS parsed as empty — regex likely stale');
  assert.ok(listed.size > 0, 'help text parsed as empty — regex likely stale');
  assert.deepEqual(
    [...listed].sort(),
    [...dispatched].sort(),
    `help-listed commands must exactly match the dispatch set.\nlisted:     ${JSON.stringify([...listed].sort())}\ndispatched: ${JSON.stringify([...dispatched].sort())}`,
  );
  assert.ok(listed.has('proposal'), 'help must list the proposal subcommand (PR #185)');
});

// codex review finding (post-merge cross-check): --version was implemented
// but never added to --help's own option list — the same shape of gap as the
// "proposal" subcommand fix above, just one level down (an option instead of
// a command). Same fix, same kind of drift test.

test('--help lists --version among the Init options', () => {
  const r = run('init.mjs', ['--help']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(/^ {2}--version(?:\s|,)/m.test(r.stdout), `--help should list --version: ${r.stdout}`);
});

test('--help option list matches every flag parseArgs actually recognizes', () => {
  const r = run('init.mjs', ['--help']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const src = readFileSync(join(SCRIPTS, 'init.mjs'), 'utf-8');
  // Exact-match flags: `arg === '--word'` (picks up --help, --version,
  // --no-hooks, etc; the bare '-h' alias is intentionally not a member of
  // this set — it is documented as ", -h" alongside --help, not as its own
  // line). Prefix flags: `arg.startsWith('--word=')`, normalized by dropping
  // the trailing '='.
  const exact = [...src.matchAll(/arg\s*===\s*'(--[a-zA-Z-]+)'/g)].map((m) => m[1]);
  const prefixed = [...src.matchAll(/arg\.startsWith\('(--[a-zA-Z-]+)='\)/g)].map((m) => m[1]);
  const recognized = new Set([...exact, ...prefixed]);

  // Flag names in the printed "Init options:" block: 2 leading spaces, the
  // flag, an optional `=<placeholder>` or `, -h` alias, then 2+ spaces before
  // the description. Continuation lines (indented past column 2) don't match.
  const listed = new Set(
    [...r.stdout.matchAll(/^ {2}(--[a-zA-Z-]+)(?:=\S+)?(?:,\s*-h)?\s{2,}\S/gm)].map((m) => m[1]),
  );

  assert.ok(
    recognized.size > 0,
    'no recognized flags parsed from init.mjs source — regex likely stale',
  );
  assert.ok(listed.size > 0, 'no flags parsed from --help output — regex likely stale');
  assert.deepEqual(
    [...listed].sort(),
    [...recognized].sort(),
    `--help's option list must exactly match the flags parseArgs recognizes.\nlisted:     ${JSON.stringify([...listed].sort())}\nrecognized: ${JSON.stringify([...recognized].sort())}`,
  );
});

// ── ISSUE-80: installHooks writes/refreshes the provenance sidecar ────────────
// `.hypo-provenance.json` (scripts/lib/pkg-provenance.mjs) is what
// hooks/hypo-shared.mjs's resolvePkgRoot() falls back to on a standalone
// (manual/npm) hooks copy once self-location can't resolve. installHooks is
// the writer for the manual/npm channel's ~/.claude/hooks.
suite('init.mjs — provenance sidecar (ISSUE-80)');

function repoHypoSharedSha256() {
  return createHash('sha256')
    .update(readFileSync(join(HOOKS, 'hypo-shared.mjs')))
    .digest('hex');
}

test('installHooks writes a provenance sidecar that verifies against this package', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-commands', '--no-shell', '--no-git-init'],
        home,
      );
      assert.equal(r.status, 0, `init failed: ${r.stderr}`);

      const sidecarPath = join(home, '.claude', 'hooks', PROVENANCE_FILENAME);
      assert.ok(existsSync(sidecarPath), 'installHooks must write the provenance sidecar');
      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      assert.equal(sidecar.pkgRoot, REPO, 'sidecar pkgRoot must point at this package');
      assert.equal(
        sidecar.hypoSharedSha256,
        repoHypoSharedSha256(),
        'sidecar hash must match the hypo-shared.mjs actually copied',
      );
    });
  });
});

// The whole point of the fix: a re-run where every hooks/*.mjs file is
// already-present (and therefore skipped, per scripts/init.mjs's own
// installHooks comment) must still refresh the sidecar, not leave a stale
// one behind. copiedAt is a fresh timestamp per write, so it changing across
// runs is the observable proof the sidecar was actually rewritten, not just
// left untouched because the hook files themselves were untouched.
test('a second init run, with every hook file skipped as already-present, still refreshes the sidecar', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const args = [`--hypo-dir=${hypoDir}`, '--no-commands', '--no-shell', '--no-git-init'];
      const first = runWithHome('init.mjs', args, home);
      assert.equal(first.status, 0, `first init failed: ${first.stderr}`);
      const sidecarPath = join(home, '.claude', 'hooks', PROVENANCE_FILENAME);
      const afterFirst = JSON.parse(readFileSync(sidecarPath, 'utf-8'));

      const second = runWithHome('init.mjs', args, home);
      assert.equal(second.status, 0, `second init failed: ${second.stderr}`);
      assert.match(
        second.stdout,
        /skipped/i,
        `second run must report the hook files as skipped (already-present): ${second.stdout}`,
      );
      const afterSecond = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      assert.equal(
        afterSecond.pkgRoot,
        REPO,
        'the refreshed sidecar must still point at the current package',
      );
      assert.equal(
        afterSecond.hypoSharedSha256,
        repoHypoSharedSha256(),
        'the refreshed sidecar must still hash-match the current hypo-shared.mjs',
      );
      assert.notEqual(
        afterSecond.copiedAt,
        afterFirst.copiedAt,
        'a skip-everything re-run must still rewrite the sidecar (fresh copiedAt), not leave it untouched',
      );
    });
  });
});

test('--dry-run does not write the provenance sidecar', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--dry-run', '--no-commands', '--no-shell', '--no-git-init'],
        home,
      );
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const sidecarPath = join(home, '.claude', 'hooks', PROVENANCE_FILENAME);
      assert.ok(!existsSync(sidecarPath), '--dry-run must not write the provenance sidecar');
    });
  });
});

// ── uninstall.mjs: wiki pre-commit hook + shell setup block ──────────────────
//
// uninstall.mjs must remove exactly the two vault-adjacent artifacts init.mjs
// creates outside ~/.claude: the git pre-commit hook and the shell rc block.
// Neither is a Claude-hooks-dir concern, so these are separate from the
// --hooks-dir suites above.

suite('uninstall.mjs: wiki pre-commit hook + shell setup');

test('dry-run leaves the wiki pre-commit hook in place; --apply removes it', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      // init's own gitSetup/firstCommit only run --no-git-init-free in every other
      // test in this file because they need a global git identity this process
      // does not have. Pre-creating the repo with one sidesteps that and still
      // exercises the real installWikiPreCommitHook path against a real repo.
      mkdirSync(hypoDir, { recursive: true });
      gitRepo(hypoDir);
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-shell'],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      const hookPath = join(hooksDir, 'pre-commit');
      assert.ok(existsSync(hookPath), 'fixture: init must install the pre-commit hook');

      const dryR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.equal(dryR.status, 0, `stderr: ${dryR.stderr}`);
      assert.ok(existsSync(hookPath), 'dry-run must not delete the hook');
      assert.ok(
        dryR.stdout.includes(hookPath),
        'dry-run report must name the hook it would remove',
      );

      // uninstall --apply also touches HOME/.claude (hypo-pkg.json, commands),
      // so it must run against a per-test HOME, not the process-shared one:
      // otherwise it deletes hypo-pkg.json out from under every other shard.
      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(!existsSync(hookPath), '--apply must remove the Hypomnema-managed hook');
    });
  });
});

test('preserves a user pre-commit hook that carries no Hypomnema marker', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      writeFileSync(join(hypoDir, 'hypo-config.md'), '# config');
      gitRepo(hypoDir);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, 'pre-commit');
      const userContent = '#!/bin/sh\necho user hook\n';
      writeFileSync(hookPath, userContent, { mode: 0o755 });

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(existsSync(hookPath), 'a user pre-commit hook must survive uninstall');
      assert.equal(readFileSync(hookPath, 'utf-8'), userContent, 'its content must be untouched');
    });
  });
});

test('refuses to remove a symlinked pre-commit target', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      writeFileSync(join(hypoDir, 'hypo-config.md'), '# config');
      gitRepo(hypoDir);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      mkdirSync(hooksDir, { recursive: true });
      const outside = join(dir, 'outside-target');
      writeFileSync(
        outside,
        '#!/bin/sh\n# hypo-managed:pre-commit:start\nexit 0\n# hypo-managed:pre-commit:end\n',
      );
      const hookPath = join(hooksDir, 'pre-commit');
      symlinkSync(outside, hookPath);

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(existsSync(outside), 'the symlink target file must survive');
      assert.ok(
        lstatSync(hookPath).isSymbolicLink(),
        'the symlink itself must survive, never followed',
      );
    });
  });
});

test('reports a pre-commit.bak without touching it', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      gitRepo(hypoDir);
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-shell'],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      const bakPath = join(hooksDir, 'pre-commit.bak');
      const bakContent = '#!/bin/sh\necho original user hook\n';
      writeFileSync(bakPath, bakContent);

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.equal(
        readFileSync(bakPath, 'utf-8'),
        bakContent,
        'pre-commit.bak must survive untouched',
      );
      assert.ok(applyR.stdout.includes('pre-commit.bak'), 'report must mention the backup');
    });
  });
});

test('preserves the whole hook when the user appended a line after the Hypomnema block', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      gitRepo(hypoDir);
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-shell'],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      const hookPath = join(hooksDir, 'pre-commit');
      const userLine = '\necho "my own check" && exit 1\n';
      const withUserLine = readFileSync(hookPath, 'utf-8') + userLine;
      writeFileSync(hookPath, withUserLine);

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(existsSync(hookPath), 'the hook must survive since it is no longer fully ours');
      assert.equal(
        readFileSync(hookPath, 'utf-8'),
        withUserLine,
        'the user line appended after the block must be untouched',
      );
    });
  });
});

test('preserves a shebang-less hook even when it carries a well-formed marker span', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      gitRepo(hypoDir);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, 'pre-commit');
      // A well-formed marker span with no leading shebang is NOT what init ever
      // writes (wikiPreCommitContent always emits "#!/bin/sh\n" first), so this
      // must never be treated as "fully ours" on marker presence alone.
      const content =
        '# hypo-managed:pre-commit:start\nsome_users_own_command || exit 1\nexit 0\n# hypo-managed:pre-commit:end\n';
      writeFileSync(hookPath, content, { mode: 0o755 });

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(existsSync(hookPath), 'a marker span with no shebang must never be deleted');
      assert.equal(readFileSync(hookPath, 'utf-8'), content, 'its content must be untouched');
    });
  });
});

test('still finds and removes the original hook after core.hooksPath moves elsewhere', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      gitRepo(hypoDir);
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-shell'],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      const originalHookPath = join(hypoDir, '.git', 'hooks', 'pre-commit');
      assert.ok(
        existsSync(originalHookPath),
        'fixture: init must install into the plain .git/hooks',
      );

      // Redirect core.hooksPath so the CURRENT resolution no longer points at
      // the file init actually wrote — the exact drift this fallback exists for.
      const elsewhere = join(dir, 'elsewhere-hooks');
      mkdirSync(elsewhere, { recursive: true });
      const cfg = spawnSync('git', ['config', 'core.hooksPath', elsewhere], {
        cwd: hypoDir,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, HYPO_DIR: '' },
      });
      assert.equal(cfg.status, 0, `git config stderr: ${cfg.stderr}`);

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(
        !existsSync(originalHookPath),
        'the original .git/hooks/pre-commit must still be found and removed via the fallback candidate',
      );
    });
  });
});

test('reports a leftover hook instead of going silent when core.hooksPath moved custom-to-custom', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      gitRepo(hypoDir);
      // Relative paths INSIDE the working tree, git's own `.githooks`
      // convention — both count as "owned" (resolveGitHooksDir's `owned`
      // check), unlike a shared directory outside the repo.
      const cfg1 = spawnSync('git', ['config', 'core.hooksPath', '.hooks-before'], {
        cwd: hypoDir,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, HYPO_DIR: '' },
      });
      assert.equal(cfg1.status, 0, `git config stderr: ${cfg1.stderr}`);

      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-shell'],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      const firstHookPath = join(hypoDir, '.hooks-before', 'pre-commit');
      assert.ok(existsSync(firstHookPath), 'fixture: init must install into the first custom path');

      // Move core.hooksPath a SECOND time, to a different custom path. Neither
      // the primary candidate (resolves the CURRENT config) nor the legacy
      // `.git/hooks` fallback (recovers only the default-to-custom drift, not
      // custom-to-custom) can reach `.hooks-before` any more.
      const cfg2 = spawnSync('git', ['config', 'core.hooksPath', '.hooks-after'], {
        cwd: hypoDir,
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, HYPO_DIR: '' },
      });
      assert.equal(cfg2.status, 0, `git config stderr: ${cfg2.stderr}`);

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(
        existsSync(firstHookPath),
        'the hook at the abandoned custom path is unreachable and must be left in place',
      );
      assert.ok(
        applyR.stdout.includes('earlier path') && applyR.stdout.includes('fail commits'),
        `report must warn the leftover hook can fail future commits: ${applyR.stdout}`,
      );
    });
  });
});

test('fallback candidate never crosses a symlinked .git/hooks into an external directory', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      writeFileSync(join(hypoDir, 'hypo-config.md'), '# config');
      gitRepo(hypoDir);

      const gitHooksDir = join(hypoDir, '.git', 'hooks');
      rmSync(gitHooksDir, { recursive: true, force: true });
      const external = join(dir, 'user-owned-hooks');
      mkdirSync(external, { recursive: true });
      const externalHook = join(external, 'pre-commit');
      // A REGULAR file at the external location, wearing a well-formed marker
      // pair — the codex reproduction (2026-08-27): the primary path already
      // refuses to write through a `.git/hooks` that resolves outside the
      // repo, but a leaf-only safety check on the fallback candidate cannot
      // see that `.git/hooks` ITSELF is the symlink that got it there.
      writeFileSync(
        externalHook,
        '#!/bin/sh\n# hypo-managed:pre-commit:start\necho user data\nexit 0\n# hypo-managed:pre-commit:end\n',
        { mode: 0o755 },
      );
      symlinkSync(external, gitHooksDir);

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(
        existsSync(externalHook),
        'the external hook reached through the symlinked hooks dir must survive',
      );
      assert.ok(
        lstatSync(gitHooksDir).isSymbolicLink(),
        'the symlinked .git/hooks entry itself must survive',
      );
    });
  });
});

test('preserves a pre-commit hook whose marker span wraps user content, not what init writes', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      mkdirSync(hypoDir, { recursive: true });
      writeFileSync(join(hypoDir, 'hypo-config.md'), '# config');
      gitRepo(hypoDir);
      const { dir: hooksDir } = hooksDirForInstall(hypoDir);
      mkdirSync(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, 'pre-commit');
      // Every OLD check passes: exactly one start and one end marker, in
      // order, a leading shebang, nothing after. Only the body between the
      // markers gives it away — it is the user's own command, not the
      // `node '<...>/hooks/hypo-pre-commit.mjs' || exit 1` step init writes
      // (codex reproduction, 2026-08-27).
      const content =
        '#!/bin/sh\n# hypo-managed:pre-commit:start\necho USER_OWNED_DEPLOY_CHECK\n# hypo-managed:pre-commit:end\n';
      writeFileSync(hookPath, content, { mode: 0o755 });

      const applyR = runWithHome('uninstall.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(existsSync(hookPath), 'a marker span wrapping user content must never be deleted');
      assert.equal(readFileSync(hookPath, 'utf-8'), content, 'its content must be untouched');
    });
  });
});

test('warns before acting when --hooks-dir is passed without --keep-shell/--keep-wiki-hook', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const rcPath = join(home, '.zshrc');
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init', `--shell-config=${rcPath}`],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      assert.ok(
        existsSync(rcPath),
        'fixture: init must install the shell block at the default path',
      );

      const applyR = runWithHome(
        'uninstall.mjs',
        [`--hooks-dir=${join(dir, 'throwaway-hooks')}`, `--hypo-dir=${hypoDir}`, '--apply'],
        home,
      );
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.ok(
        applyR.stderr.includes('--hooks-dir') && applyR.stderr.includes('--keep-shell'),
        `must warn before acting that --hooks-dir alone still touches shell/wiki cleanup: ${applyR.stderr}`,
      );
      assert.ok(
        !existsSync(rcPath) || !readFileSync(rcPath, 'utf-8').includes('hypo-managed:shell-setup'),
        'the warning does not change behavior: the real rc block is still removed since --keep-shell was not passed',
      );
    });
  });
});

test('dry-run leaves the shell marker block; --apply strips only that block', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const rcPath = join(dir, 'zshrc');
      const before = 'export PATH=$PATH:/opt/tool\n\nalias ll="ls -la"\n';
      writeFileSync(rcPath, before);

      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome(
        'init.mjs',
        [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-git-init', `--shell-config=${rcPath}`],
        home,
      );
      assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
      const withBlock = readFileSync(rcPath, 'utf-8');
      assert.ok(
        withBlock.includes('# hypo-managed:shell-setup:start'),
        'fixture: init must install the shell block',
      );

      const dryR = runWithHome(
        'uninstall.mjs',
        [`--hypo-dir=${hypoDir}`, `--shell-config=${rcPath}`],
        home,
      );
      assert.equal(dryR.status, 0, `stderr: ${dryR.stderr}`);
      assert.equal(readFileSync(rcPath, 'utf-8'), withBlock, 'dry-run must not modify the rc file');

      const applyR = runWithHome(
        'uninstall.mjs',
        [`--hypo-dir=${hypoDir}`, `--shell-config=${rcPath}`, '--apply'],
        home,
      );
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      const after = readFileSync(rcPath, 'utf-8');
      assert.ok(
        !after.includes('hypo-managed:shell-setup'),
        '--apply must remove the marker block',
      );
      assert.ok(
        after.includes('export PATH=$PATH:/opt/tool'),
        'the line before the block must survive',
      );
      assert.ok(after.includes('alias ll="ls -la"'), 'the line after the block must survive');
    });
  });
});

test('a swapped marker (END before START) leaves the rc file byte-for-byte untouched', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const rcPath = join(dir, 'zshrc');
      // END literally precedes START — a hand-edited or corrupted file, not
      // anything init would ever produce. Two bare indexOf() calls would slice
      // [startIdx, endIdx) with startIdx > endIdx and DUPLICATE this content
      // instead of raising anything.
      const swapped =
        'before\n# hypo-managed:shell-setup:end\nfunction claude() { true; }\n# hypo-managed:shell-setup:start\nafter\n';
      writeFileSync(rcPath, swapped);

      const applyR = runWithHome(
        'uninstall.mjs',
        [`--hypo-dir=${join(dir, 'wiki')}`, `--shell-config=${rcPath}`, '--apply'],
        home,
      );
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.equal(
        readFileSync(rcPath, 'utf-8'),
        swapped,
        '--apply must not write a single byte to a swapped-marker rc',
      );
    });
  });
});

test('preserves an rc marker block whose body carries a user function alongside the markers', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const rcPath = join(dir, 'zshrc');
      // A well-formed span (one start, one end, in order) is not enough: the
      // body between them is the user's own function, not the `claude()`
      // wrapper init.mjs installs (codex reproduction, 2026-08-27 — the same
      // shape as the pre-commit-body attack, applied to the rc block).
      const content =
        'before\n# hypo-managed:shell-setup:start\nfunction my_deploy() { echo USER_OWNED; }\n# hypo-managed:shell-setup:end\nafter\n';
      writeFileSync(rcPath, content);

      const applyR = runWithHome(
        'uninstall.mjs',
        [`--hypo-dir=${join(dir, 'wiki')}`, `--shell-config=${rcPath}`, '--apply'],
        home,
      );
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.equal(
        readFileSync(rcPath, 'utf-8'),
        content,
        'a marker block whose body is not the exact function Hypomnema installs must survive untouched',
      );
    });
  });
});

test('a duplicated block (two full START/END pairs) is preserved, not partially stripped', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const rcPath = join(dir, 'zshrc');
      const oneBlock =
        '# hypo-managed:shell-setup:start\nfunction claude() { true; }\n# hypo-managed:shell-setup:end\n';
      const duplicated = `${oneBlock}\n${oneBlock}`;
      writeFileSync(rcPath, duplicated);

      const applyR = runWithHome(
        'uninstall.mjs',
        [`--hypo-dir=${join(dir, 'wiki')}`, `--shell-config=${rcPath}`, '--apply'],
        home,
      );
      assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
      assert.equal(
        readFileSync(rcPath, 'utf-8'),
        duplicated,
        'a duplicated block must be preserved whole, not have only the first copy stripped',
      );
      assert.ok(applyR.stdout.includes('preserved'), 'report must explain the block was preserved');
    });
  });
});

test('checks both ~/.zshrc and ~/.bashrc by default, not just $SHELL', () => {
  withTmpHome((home) => {
    // Must be the REAL block, not a stand-in: isOwnedShellFunctionBody()
    // compares the marker span's body byte-for-byte against what init.mjs
    // actually installs, so a fixture that only fakes the marker shape (as
    // this one used to) is now, correctly, left untouched rather than
    // stripped — this test is about the "both files checked" behavior, not
    // about body validation, so the fixture has to be the genuine article.
    const fakeBlock = `${SHELL_MARKER_START}${SHELL_FUNCTION_BODY}${SHELL_MARKER_END}\n`;
    const zshrc = join(home, '.zshrc');
    const bashrc = join(home, '.bashrc');
    writeFileSync(zshrc, `# zsh stuff\n\n${fakeBlock}`);
    writeFileSync(bashrc, `# bash stuff\n\n${fakeBlock}`);

    const applyR = runWithHome('uninstall.mjs', ['--apply'], home);
    assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
    assert.ok(
      !readFileSync(zshrc, 'utf-8').includes('hypo-managed:shell-setup'),
      '.zshrc block must be stripped even without --shell-config',
    );
    assert.ok(
      !readFileSync(bashrc, 'utf-8').includes('hypo-managed:shell-setup'),
      '.bashrc block must be stripped even without --shell-config',
    );
    assert.ok(
      readFileSync(zshrc, 'utf-8').includes('# zsh stuff'),
      '.zshrc other content must survive',
    );
    assert.ok(
      readFileSync(bashrc, 'utf-8').includes('# bash stuff'),
      '.bashrc other content must survive',
    );
  });
});

test('--hypo-dir expands a leading ~ the same way init.mjs expands it', () => {
  withTmpHome((home) => {
    const hypoDir = join(home, 'vault');
    mkdirSync(hypoDir, { recursive: true });
    gitRepo(hypoDir);
    const initR = runWithHome(
      'init.mjs',
      [`--hypo-dir=${hypoDir}`, '--no-hooks', '--no-shell'],
      home,
    );
    assert.equal(initR.status, 0, `init stderr: ${initR.stderr}`);
    const { dir: hooksDir } = hooksDirForInstall(hypoDir);
    const hookPath = join(hooksDir, 'pre-commit');
    assert.ok(existsSync(hookPath), 'fixture: init must install the pre-commit hook');

    // The shell never expands "~" inside "--flag=value"; only the receiving
    // script's own expandHome() call does. init.mjs's parseArgs already calls
    // it (scripts/init.mjs), so uninstall must call the same function or this
    // literally never resolves to anything on disk.
    const applyR = runWithHome('uninstall.mjs', ['--hypo-dir=~/vault', '--apply'], home);
    assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
    assert.ok(
      !existsSync(hookPath),
      '--hypo-dir=~/vault must resolve to the real vault path and remove its hook',
    );
  });
});

test('a missing vault is skipped with a reason, not a crash', () => {
  withTmpHome((home) => {
    const applyR = runWithHome(
      'uninstall.mjs',
      [`--hypo-dir=${join(home, 'no-such-wiki')}`, '--apply'],
      home,
    );
    assert.equal(applyR.status, 0, `stderr: ${applyR.stderr}`);
    assert.ok(
      /vault/i.test(applyR.stdout),
      'report must explain why the pre-commit hook was skipped',
    );
  });
});

// ── init.mjs: shell function block marker-span validation ───────────────────
//
// installShellFunction() used to slice the rc file with two bare indexOf()
// calls, the exact damage shape cross-review flagged: a swapped marker
// duplicates whatever sits between END and START into the "replaced" span,
// and a duplicated block only ever finds the FIRST end, so a second full copy
// survives untouched while its sibling gets silently rewritten. Both cases
// must now be refused via the same findMarkerSpan() uninstall.mjs already
// uses (scripts/lib/git-hooks-dir.mjs), leaving the rc file byte-for-byte as
// it was.

test('init refuses a swapped marker rc block instead of duplicating the content between END and START', () => {
  withTmpDir((dir) => {
    const rcPath = join(dir, 'zshrc');
    // END literally precedes START, mirroring the uninstall-side regression
    // fixture. Two bare indexOf() calls would slice [firstStart, firstEnd)
    // with firstStart AFTER firstEnd here (since only START's own indexOf is
    // used for both), duplicating MY_OWN_SECRET_LINE into the merged output.
    const swapped =
      'before\n# hypo-managed:shell-setup:end\nMY_OWN_SECRET_LINE\n# hypo-managed:shell-setup:start\nafter\n';
    writeFileSync(rcPath, swapped);

    const r = run('init.mjs', [
      `--hypo-dir=${join(dir, 'wiki')}`,
      '--no-hooks',
      '--no-commands',
      '--no-git-init',
      `--shell-config=${rcPath}`,
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(rcPath, 'utf-8');
    assert.equal(
      after,
      swapped,
      'a swapped-marker rc must be left byte-for-byte untouched, not merged',
    );
    assert.equal(
      countOccurrences(after, 'MY_OWN_SECRET_LINE'),
      1,
      'the line between END and START must never be duplicated',
    );
    assert.match(
      r.stdout,
      /skipped/i,
      'report must say the block was skipped, not silently merged',
    );
  });
});

test('init refuses a duplicated marker rc block instead of overwriting only the first copy', () => {
  withTmpDir((dir) => {
    const rcPath = join(dir, 'zshrc');
    const oneBlock =
      '# hypo-managed:shell-setup:start\nfunction claude() { echo old; }\n# hypo-managed:shell-setup:end\n';
    const duplicated = `${oneBlock}\n${oneBlock}`;
    writeFileSync(rcPath, duplicated);

    const r = run('init.mjs', [
      `--hypo-dir=${join(dir, 'wiki')}`,
      '--no-hooks',
      '--no-commands',
      '--no-git-init',
      `--shell-config=${rcPath}`,
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const after = readFileSync(rcPath, 'utf-8');
    assert.equal(
      after,
      duplicated,
      'a duplicated block must be left whole; installing must not overwrite only the first copy',
    );
    assert.match(
      r.stdout,
      /skipped/i,
      'report must say the block was skipped, not partially replaced',
    );
  });
});

// A tiny local mirror of countOccurrences() (scripts/lib/git-hooks-dir.mjs is
// not exported for import here, this file only spawns the scripts as child
// processes) so the swapped-marker test above can assert the duplication
// count directly rather than eyeballing the string.
function countOccurrences(content, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
