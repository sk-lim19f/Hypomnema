// tests/git-hooks-dir.test.mjs
//
// Pins the hooks-directory resolution against the layouts that broke the old
// `join(root, '.git', 'hooks')` guess: linked worktrees, core.hooksPath in all
// of its documented forms, and a hostile ambient git environment.

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { test, suite } from './harness.mjs';
import {
  resolveGitHooksDir,
  hooksDirForInstall,
  unsafeHookTargetReason,
} from '../scripts/lib/git-hooks-dir.mjs';
import { runWithHome, withTmpHome } from './helpers.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

// A developer whose own ~/.gitconfig sets core.hooksPath would flip the
// default-layout expectations below into the external-path case. The resolver
// deliberately scrubs GIT_CONFIG_* (that injection is the attack it blocks), so
// hermeticity cannot be forced through the environment. Detect the ambient
// value instead and assert the layout only when there is none. The ownership
// and worktree assertions run either way.
const AMBIENT_HOOKS_PATH = (() => {
  try {
    return execFileSync('git', ['config', '--global', '--get', 'core.hooksPath'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return ''; // exit 1 = key not set
  }
})();

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-hooksdir-'));
  git(dir, ['init', '-q', '.']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  git(dir, ['add', 'f.txt']);
  // --no-verify: building the fixture must not execute a developer's global
  // hooks. The local core.hooksPath below is set AFTER this commit by the tests
  // that need it, so it cannot suppress them here.
  git(dir, ['commit', '-q', '--no-verify', '-m', 'init']);
  return dir;
}

suite('git-hooks-dir: layout resolution');

test('plain checkout resolves to the repo .git/hooks and is repo-owned', () => {
  const repo = newRepo();
  try {
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, true);
    if (!AMBIENT_HOOKS_PATH) {
      assert.equal(r.owned, true);
      assert.equal(r.path, join(realpathSync(repo), '.git', 'hooks'));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// The original defect: in a linked worktree `.git` is a FILE, so the old
// `join(root,'.git','hooks')` guess produced a path under a regular file and
// mkdir died with ENOTDIR.
test('linked worktree resolves to the shared common dir, not <worktree>/.git/hooks', () => {
  const repo = newRepo();
  const wt = `${repo}-wt`;
  try {
    git(repo, ['worktree', 'add', '-q', '-b', 'wt', wt]);
    assert.equal(statSync(join(wt, '.git')).isFile(), true, '.git must be a file here');

    const r = resolveGitHooksDir(wt);
    assert.equal(r.ok, true);
    assert.equal(r.owned, true);
    if (!AMBIENT_HOOKS_PATH) assert.equal(r.path, join(r.commonDir, 'hooks'));
    assert.ok(!r.path.startsWith(join(wt, '.git') + '/'), 'must not point under the .git file');

    // The whole point: the install-side path is usable, i.e. mkdir succeeds.
    const { dir } = hooksDirForInstall(wt);
    mkdirSync(dir, { recursive: true });
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('non-repo yields not-a-repo and a silent install skip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-norepo-'));
  try {
    assert.equal(resolveGitHooksDir(dir).reason, 'not-a-repo');
    const r = hooksDirForInstall(dir);
    assert.equal(r.dir, undefined);
    assert.equal(r.skip, null, 'not-a-repo stays silent, as it was before');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

suite('git-hooks-dir: core.hooksPath');

test('relative core.hooksPath resolves inside the worktree and stays owned', () => {
  const repo = newRepo();
  try {
    git(repo, ['config', 'core.hooksPath', '.githooks']);
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, true);
    assert.equal(r.owned, true);
    assert.equal(r.path, join(realpathSync(repo), '.githooks'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// git documents core.hooksPath=/dev/null as "disable every hook". The old
// code would have tried to mkdir under it and thrown a second ENOTDIR.
test('core.hooksPath=/dev/null reports hooks-disabled instead of throwing', () => {
  const repo = newRepo();
  try {
    git(repo, ['config', 'core.hooksPath', '/dev/null']);
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'hooks-disabled');
    const { skip } = hooksDirForInstall(repo);
    assert.match(skip, /not a directory/);
    // The same branch fires for a plain .git/hooks that is a regular file, so
    // the message must not blame a setting that may not exist.
    assert.doesNotMatch(skip, /core\.hooksPath/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A hooks dir shared across repositories is a documented pattern, and our
// post-commit executes $REPO_ROOT/scripts/upgrade.mjs — installing there
// would run one repo's script from another repo's commit.
test('core.hooksPath outside the repo resolves but refuses installation', () => {
  const repo = newRepo();
  const shared = mkdtempSync(join(tmpdir(), 'hypo-shared-hooks-'));
  try {
    git(repo, ['config', 'core.hooksPath', shared]);
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, true, 'still resolvable — doctor needs to report it');
    assert.equal(r.owned, false);

    const inst = hooksDirForInstall(repo);
    assert.equal(inst.dir, undefined, 'must not hand back a shared dir to write into');
    assert.match(inst.skip, /outside this repository/);
  } finally {
    rmSync(shared, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

suite('git-hooks-dir: ambient environment cannot redirect the probe');

// `git -C <root>` does NOT neutralize these; without scrubbing, a stray
// GIT_DIR/GIT_WORK_TREE in the environment silently retargets resolution at
// a foreign repository, and GIT_CONFIG_* injects an arbitrary hooks path.
test('GIT_DIR/GIT_WORK_TREE pointing elsewhere do not move the result', () => {
  const repo = newRepo();
  const foreign = newRepo();
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = join(foreign, '.git');
    process.env.GIT_WORK_TREE = foreign;
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, true);
    assert.ok(!r.path.startsWith(foreign), `resolution leaked into the foreign repo: ${r.path}`);
    if (!AMBIENT_HOOKS_PATH) assert.equal(r.path, join(r.commonDir, 'hooks'));
  } finally {
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE']) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(foreign, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('GIT_CONFIG_COUNT injection cannot set core.hooksPath', () => {
  const repo = newRepo();
  const evil = mkdtempSync(join(tmpdir(), 'hypo-evil-hooks-'));
  const saved = { ...process.env };
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    process.env.GIT_CONFIG_VALUE_0 = evil;
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, true);
    assert.ok(!r.path.startsWith(evil), `injected hooks path was honored: ${r.path}`);
    if (!AMBIENT_HOOKS_PATH) assert.equal(r.owned, true);
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
    rmSync(evil, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

suite('git-hooks-dir: the hook entry itself is guarded, not just its directory');

// writeFileSync follows symlinks, so an owned hooks dir containing a symlinked
// hook entry would still write to wherever that link points.
test('a symlinked hook entry is refused', () => {
  const repo = newRepo();
  const outside = mkdtempSync(join(tmpdir(), 'hypo-outside-'));
  const target = join(outside, 'victim.sh');
  try {
    writeFileSync(target, 'original\n');
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const link = join(hooks, 'pre-commit');
    symlinkSync(target, link);

    assert.match(unsafeHookTargetReason(link), /symlink/);
    assert.equal(readFileSync(target, 'utf-8'), 'original\n', 'target must be untouched');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// A dangling symlink reads as absent through existsSync, so the "not installed
// yet" branch would have created the external target outright.
test('a dangling symlink is refused rather than read as absent', () => {
  const repo = newRepo();
  const outside = mkdtempSync(join(tmpdir(), 'hypo-outside-'));
  const target = join(outside, 'not-yet-there.sh');
  try {
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const link = join(hooks, 'post-commit');
    symlinkSync(target, link);

    assert.equal(existsSync(link), false, 'existsSync alone would say "absent"');
    assert.match(unsafeHookTargetReason(link), /symlink/);
    assert.equal(existsSync(target), false, 'must not have created the external target');
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('an absent hook entry is writable, a directory in its place is not', () => {
  const repo = newRepo();
  try {
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    assert.equal(unsafeHookTargetReason(join(hooks, 'pre-commit')), null);

    mkdirSync(join(hooks, 'post-commit'));
    assert.match(unsafeHookTargetReason(join(hooks, 'post-commit')), /not a regular file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// canonicalize() walks up to the deepest existing ancestor. When that ancestor
// is the filesystem root, a length-based slice ate the first character and
// could turn an external path into one that looks repository-owned.
test('a path whose deepest existing ancestor is the root survives canonicalization', () => {
  const repo = newRepo();
  try {
    git(repo, ['config', 'core.hooksPath', '/Nonexistent-hypo-probe-1234/hooks']);
    const r = resolveGitHooksDir(repo);
    assert.equal(r.ok, true);
    assert.equal(r.path, '/Nonexistent-hypo-probe-1234/hooks', 'no character may be dropped');
    assert.equal(r.owned, false);
    assert.equal(hooksDirForInstall(repo).dir, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

suite('git-hooks-dir: init.mjs actually installs into a linked worktree');

// The end-to-end case the module tests cannot prove: reverting the init.mjs
// integration while keeping the module would leave every other test green.
//
// The VAULT is the linked worktree here, deliberately. Pointing this at the
// package root instead would only exercise the worktree path when the suite
// itself happens to be running from a worktree, and would prove nothing on a
// normal CI checkout.
test('init installs the vault pre-commit hook when the vault is a linked worktree', () => {
  const repo = newRepo();
  const wt = `${repo}-wt`;
  try {
    git(repo, ['worktree', 'add', '-q', '-b', 'wt', wt]);
    assert.equal(statSync(join(wt, '.git')).isFile(), true, 'vault .git must be a file');

    withTmpHome((home) => {
      const r = runWithHome('init.mjs', [`--hypo-dir=${wt}`, '--no-commands'], home);
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.ok(!/ENOTDIR/.test(out), `init crashed with ENOTDIR:\n${out}`);
      assert.equal(r.status, 0, `init exited ${r.status}:\n${out}`);

      // It must land in the shared common dir, which is the whole point.
      const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
      assert.equal(existsSync(hookPath), true, `hook not installed at ${hookPath}:\n${out}`);
      assert.match(readFileSync(hookPath, 'utf-8'), /hypo-managed:pre-commit:start/);
      assert.equal(existsSync(join(wt, '.git', 'hooks')), false, 'nothing under the .git file');
    });
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// The .bak is a second write to a different path, so guarding the hook entry
// says nothing about it. Unguarded, --force-commands overwrote whatever the
// pre-commit.bak symlink pointed at.
test('--force-commands does not write the backup through a symlinked .bak', () => {
  const repo = newRepo();
  const outside = mkdtempSync(join(tmpdir(), 'hypo-outside-'));
  const victim = join(outside, 'victim.txt');
  try {
    writeFileSync(victim, 'PRECIOUS\n');
    const hooks = join(repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    // A real, unmanaged pre-commit: the case that takes the force branch.
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
    symlinkSync(victim, join(hooks, 'pre-commit.bak'));

    withTmpHome((home) => {
      const r = runWithHome(
        'init.mjs',
        [`--hypo-dir=${repo}`, '--no-commands', '--force-commands'],
        home,
      );
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      assert.equal(readFileSync(victim, 'utf-8'), 'PRECIOUS\n', `backup escaped:\n${out}`);
      // Also pin that the refusal happens BEFORE the hook write. Without this,
      // moving the guard between the two writes would still pass above while
      // leaving the unmanaged hook overwritten and its only backup lost.
      assert.equal(
        readFileSync(join(hooks, 'pre-commit'), 'utf-8'),
        '#!/bin/sh\necho mine\n',
        `the unmanaged hook was overwritten with no usable backup:\n${out}`,
      );
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
