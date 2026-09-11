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
import { execFileSync, spawnSync } from 'node:child_process';
import { test, suite } from './harness.mjs';
import {
  resolveGitHooksDir,
  hooksDirForInstall,
  unsafeHookTargetReason,
  parseWikiPreCommitRoot,
  wikiPreCommitContent,
  WIKI_PRE_COMMIT_MARKER_START,
  WIKI_PRE_COMMIT_MARKER_END,
  PRE_COMMIT_RESOLVER_LINE,
  unescapeShellSingleQuoted,
  isOwnedWikiPreCommitBody,
  findMarkerSpan,
} from '../scripts/lib/git-hooks-dir.mjs';
import { runWithHome, withTmpHome, legacyWikiPreCommitContent } from './helpers.mjs';

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

// ── parseWikiPreCommitRoot ───────────────────────────────────────────────────
// Reads back what wikiPreCommitContent() wrote, so upgrade.mjs's migration and
// doctor.mjs's report can trust it. Untested until now: no ok:false
// input had a single assertion anywhere in the suite, despite this being the
// one function standing between a hostile/hand-edited hook and upgrade.mjs
// deciding it is safe to rewrite.

suite('git-hooks-dir.mjs — parseWikiPreCommitRoot');

test('parseWikiPreCommitRoot: recognizes a freshly generated (non --lint-strict) hook, with no root baked in', () => {
  const content = wikiPreCommitContent('/home/me/hypomnema', false);
  const parsed = parseWikiPreCommitRoot(content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.root, null, 'the runtime-resolving form never bakes an install root');
  assert.equal(parsed.lintStrict, false);
  assert.equal(parsed.hypoDir, null, 'a plain hook never bakes in a --hypo-dir');
});

test('parseWikiPreCommitRoot: recognizes a --lint-strict hook and round-trips the embedded --hypo-dir, with no root baked in', () => {
  const content = wikiPreCommitContent('/home/me/vault', true);
  const parsed = parseWikiPreCommitRoot(content);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.root, null, 'the runtime-resolving form never bakes an install root');
  assert.equal(parsed.lintStrict, true);
  assert.equal(
    parsed.hypoDir,
    '/home/me/vault',
    'the --lint-strict step must give back the exact --hypo-dir it was built with',
  );
});

test('parseWikiPreCommitRoot: rejects a duplicated marker pair', () => {
  const once = wikiPreCommitContent('/home/me/vault', false);
  // Two full copies concatenated: findMarkerSpan sees two starts and two
  // ends, the exact forged-marker shape a hand-edited/merged hook can produce.
  const doubled = once + once;
  assert.equal(parseWikiPreCommitRoot(doubled).ok, false);
});

test("parseWikiPreCommitRoot: rejects a marker pair wrapped around a user's own hook body", () => {
  // The forged-marker precedent this mirrors (2026-08-27): a marker pair is
  // trivial to wrap around arbitrary content, and nothing about the markers
  // themselves proves the body inside is ours.
  const forged = `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\necho USER_OWNED_DEPLOY_CHECK\nexit 0\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
  assert.equal(parseWikiPreCommitRoot(forged).ok, false);
});

test('parseWikiPreCommitRoot: rejects a body missing the trailing exit 0', () => {
  const content = wikiPreCommitContent('/home/me/vault', false);
  const mangled = content.replace('exit 0\n', '');
  const parsed = parseWikiPreCommitRoot(mangled);
  assert.equal(parsed.ok, false);
  // Our START marker is still in the content; only the body inside it fails
  // to parse. doctor.mjs/upgrade.mjs use this to tell "our marker, broken
  // body" (warn) apart from "not our hook at all" (say nothing).
  assert.equal(parsed.hasMarker, true, 'a present-but-unrecognized body must report hasMarker');
});

test('parseWikiPreCommitRoot: rejects a worker step whose resolved script does not match byte-for-byte', () => {
  // Same "node -e '…' || exit 1" shape, but the FIRST occurrence of the
  // referenced suffix (inside the resolver's usable() check) is mutated while
  // the later occurrence (in the actual spawnSync argv) is not — the two no
  // longer agree, so the exact-reconstruction check in isOwnedWikiPreCommitBody
  // must catch it even though the line still parses as "node -e '…' || exit 1".
  const content = wikiPreCommitContent('/home/me/vault', false).replace(
    'hooks/hypo-pre-commit.mjs',
    'hooks/some-other-script.mjs',
  );
  const parsed = parseWikiPreCommitRoot(content);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.hasMarker, true);
});

test('parseWikiPreCommitRoot: rejects content with no marker at all', () => {
  const parsed = parseWikiPreCommitRoot('#!/bin/sh\necho hi\n');
  assert.equal(parsed.ok, false);
  assert.equal(
    parsed.hasMarker,
    false,
    'a hook with no Hypomnema marker must report hasMarker: false',
  );
});

// ── backward compatibility: the OLD, version-pinned form (ISSUE-137) ────────
// wikiPreCommitContent() no longer generates this shape (it always emits the
// runtime-resolving form now), but a real vault may still carry a hook an
// older Hypomnema release wrote. parseWikiPreCommitRoot must keep reading it
// so upgrade.mjs can migrate it and doctor.mjs can report on it.
//
// codex reproduced (2026-09-11) that the OLD-form check trusted an
// arbitrary root just because the worker path ended in
// `/hooks/hypo-pre-commit.mjs`, with nothing verifying the root was ever a
// real Hypomnema install. The fix requires the referenced root to exist,
// contain that worker script, and carry a package.json named "hypomnema",
// so these tests now build a REAL directory on disk shaped that way instead
// of pointing at a literal path like `/opt/hypomnema/1.7.3` that was never
// created and would now be correctly rejected as not-ours.
function withRealOldFormInstallRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'hypo-legacy-install-'));
  try {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'hypomnema' }));
    writeFileSync(join(root, 'hooks', 'hypo-pre-commit.mjs'), '// stub\n');
    writeFileSync(join(root, 'scripts', 'lint.mjs'), '// stub\n');
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

suite('git-hooks-dir.mjs — parseWikiPreCommitRoot backward compatibility (pre-resolver hooks)');

test('still reads the version-pinned root out of a hook an older Hypomnema release wrote', () => {
  withRealOldFormInstallRoot((root) => {
    const content = legacyWikiPreCommitContent(root, '/home/me/vault', false);
    const parsed = parseWikiPreCommitRoot(content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.root, root);
    assert.equal(parsed.lintStrict, false);
    assert.equal(parsed.hypoDir, null);
  });
});

test('still reads the embedded --hypo-dir out of an older --lint-strict hook', () => {
  withRealOldFormInstallRoot((root) => {
    const content = legacyWikiPreCommitContent(root, '/home/me/vault', true);
    const parsed = parseWikiPreCommitRoot(content);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.root, root);
    assert.equal(parsed.lintStrict, true);
    assert.equal(parsed.hypoDir, '/home/me/vault');
  });
});

test('rejects a body that mixes an old-form worker step with a new-form lint step', () => {
  withRealOldFormInstallRoot((root) => {
    // Neither writer this codebase has ever shipped produces a mixed body —
    // isOwnedWikiPreCommitBody must require the same form on every step, not
    // "old OR new, checked independently per line".
    const oldWorkerOnly = legacyWikiPreCommitContent(root, '/home/me/vault', false)
      .split('\n')
      .find((l) => l.startsWith('node '));
    const newLintOnly = wikiPreCommitContent('/home/me/vault', true)
      .split('\n')
      .filter((l) => l.startsWith('node '))[1];
    const mixed = `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\n${oldWorkerOnly}\n${newLintOnly}\nexit 0\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
    assert.equal(parseWikiPreCommitRoot(mixed).ok, false);
  });
});

// ── the security fix itself: an OLD-form worker line is no longer trusted on
// a suffix match alone ──────────────────────────────────────────────────────

suite(
  'git-hooks-dir.mjs — OLD-form worker line requires a real install, not just a matching suffix',
);

// The exact codex reproduction (2026-09-11): a marker pair wrapping a worker
// line whose root is a user's own project (never a Hypomnema install at
// all), which the suffix-only check accepted as "ours", making it eligible
// for upgrade.mjs's rewrite and uninstall.mjs's delete.
test('rejects an old-form worker line whose root is not a Hypomnema install at all', () => {
  const foreign = mkdtempSync(join(tmpdir(), 'hypo-foreign-project-'));
  try {
    mkdirSync(join(foreign, 'hooks'), { recursive: true });
    writeFileSync(join(foreign, 'hooks', 'hypo-pre-commit.mjs'), '// not ours\n');
    writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'some-other-project' }));
    const content = legacyWikiPreCommitContent(foreign, '/home/me/vault', false);
    assert.equal(
      parseWikiPreCommitRoot(content).ok,
      false,
      'a package.json name other than "hypomnema" must not be recognized as ours',
    );
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

// codex reproduction (2026-09-11): the OLD-form lint step used to be checked
// only by suffix (endsWith('/scripts/lint.mjs')), never against the worker
// line's own root. A marker hook naming a REAL Hypomnema worker path and a
// SEPARATE, also-real Hypomnema install's lint path (mixing two roots the
// legacy writer never could have produced together — it always builds both
// lines from the SAME root) passed that check and was accepted as "ours",
// making it eligible for uninstall.mjs's delete and upgrade.mjs's rewrite.
test('rejects an old-form body whose worker and lint lines name two different (both otherwise-valid) roots', () => {
  withRealOldFormInstallRoot((rootA) => {
    withRealOldFormInstallRoot((rootB) => {
      const workerLine = legacyWikiPreCommitContent(rootA, '/home/me/vault', false)
        .split('\n')
        .find((l) => l.startsWith('node '));
      const lintLine = legacyWikiPreCommitContent(rootB, '/home/me/vault', true)
        .split('\n')
        .filter((l) => l.startsWith('node '))[1];
      const mixed = `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\n${workerLine}\n${lintLine}\nexit 0\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
      assert.equal(
        parseWikiPreCommitRoot(mixed).ok,
        false,
        'a lint path naming a DIFFERENT root than the worker line must not be recognized as ours',
      );
      const span = findMarkerSpan(mixed, WIKI_PRE_COMMIT_MARKER_START, WIKI_PRE_COMMIT_MARKER_END);
      assert.equal(span.ok, true);
      assert.equal(
        isOwnedWikiPreCommitBody(mixed, span),
        false,
        'the strict/delete-path predicate must also reject the mixed-root body',
      );
    });
  });
});

// A root a prior release used, since removed from disk entirely (no
// package.json, no worker script to check identity against): exactly what a
// moved-or-reinstalled Hypomnema leaves behind. parseWikiPreCommitRoot reads
// FOR REWRITE (upgrade.mjs's migration, doctor.mjs's report), never for
// deletion, so it now accepts this shape (isRewritableOldFormInstallRoot):
// refusing it left every vault git commit failing MODULE_NOT_FOUND with no
// in-product recovery (2026-09-11). uninstall.mjs's DELETE path is different:
// it still goes through isOwnedWikiPreCommitBody's strict default
// (isRealOldFormInstallRoot) and keeps refusing a root it cannot verify, see
// the test directly below.
test('parseWikiPreCommitRoot (rewrite path): accepts an old-form worker line whose root no longer exists on disk', () => {
  const gone = join(tmpdir(), `hypo-deleted-install-${process.pid}-${Date.now()}`);
  const content = legacyWikiPreCommitContent(gone, '/home/me/vault', false);
  assert.equal(existsSync(gone), false, 'fixture must not exist for this test to mean anything');
  const parsed = parseWikiPreCommitRoot(content);
  assert.equal(parsed.ok, true, 'a gone root must not block the non-destructive rewrite path');
  assert.equal(parsed.root, gone);
});

test('isOwnedWikiPreCommitBody (strict/delete path, default predicate): still rejects an old-form worker line whose root no longer exists on disk', () => {
  const gone = join(tmpdir(), `hypo-deleted-install-strict-${process.pid}-${Date.now()}`);
  const content = legacyWikiPreCommitContent(gone, '/home/me/vault', false);
  assert.equal(existsSync(gone), false, 'fixture must not exist for this test to mean anything');
  const span = findMarkerSpan(content, WIKI_PRE_COMMIT_MARKER_START, WIKI_PRE_COMMIT_MARKER_END);
  assert.equal(span.ok, true);
  assert.equal(
    isOwnedWikiPreCommitBody(content, span),
    false,
    'uninstall.mjs must not delete a hook naming a root it cannot verify still exists',
  );
});

// ── runtime install-root resolver (no baked root) ────────────────────────────
// The judgment criterion this issue is measured against: the generated hook
// body must never contain an install root string, and the resolver embedded
// in it must actually find and run an install described only by
// ~/.claude/hypo-pkg.json or ~/.claude/plugins/installed_plugins.json.

suite('git-hooks-dir.mjs — runtime install-root resolver (no baked root)');

test('wikiPreCommitContent never bakes an absolute install root into the generated hook body', () => {
  const content = wikiPreCommitContent('/home/me/vault', true);
  assert.doesNotMatch(
    content,
    /'\/[^']*\/hooks\/hypo-pre-commit\.mjs'/,
    'must not bake a single-quoted absolute worker path — the version-pinned shape this issue removes',
  );
  assert.doesNotMatch(
    content,
    /'\/[^']*\/scripts\/lint\.mjs'/,
    'must not bake a single-quoted absolute lint script path',
  );
  assert.match(
    content,
    /node -e '/,
    'the worker step must resolve the install root at commit time, not embed one',
  );
});

// buildPreCommitResolverJs's own doc comment warns that a stray single quote
// in its FIXED JS (an error message, say) would corrupt the shell line no
// matter how it were JS-escaped, since sh single quotes have no escape
// mechanism of their own — but nothing enforced that warning. The worker step
// has zero dynamic input (no --hypo-dir), so its resolver script IS that
// fixed text with no exceptions to carve out. This is a pin, not a runtime
// guard: buildPreCommitResolverJs never throws today, and this must not
// become the first path that does.
test('buildPreCommitResolverJs: the fixed worker script (no dynamic input) contains no single quote', () => {
  const content = wikiPreCommitContent('/home/me/vault', false);
  const workerLine = content.split('\n').find((l) => l.startsWith('node -e '));
  const m = PRE_COMMIT_RESOLVER_LINE.exec(workerLine);
  assert.ok(m, `expected a new-form resolver line: ${workerLine}`);
  const js = unescapeShellSingleQuoted(m[1]);
  assert.doesNotMatch(js, /'/, `resolver script must contain no single quote: ${js}`);
});

// Builds an isolated HOME + fake install root + vault under one tmp dir, so the
// generated hook can actually be run by /bin/sh with HOME pinned there (CLAUDE.md:
// "every process a test spawns gets HOME pinned to a session temp dir").
function withResolverFixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-resolver-'));
  try {
    const home = join(base, 'home');
    const pkgRoot = join(base, 'pkg');
    const vault = join(base, 'vault');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(pkgRoot, 'hooks'), { recursive: true });
    mkdirSync(vault, { recursive: true });
    // usable() now requires an absolute root whose package.json carries a
    // version, on top of the target script existing — the fix for the
    // relative-pkgRoot bypass below, so the fixture must look like a real
    // install even for tests that only care about the worker step.
    writeFileSync(
      join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '1.0.0' }),
    );
    writeFileSync(
      join(pkgRoot, 'hooks', 'hypo-pre-commit.mjs'),
      'console.log("STUB_PRE_COMMIT_RAN");\n',
    );
    fn({ base, home, pkgRoot, vault });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runGeneratedHook(base, vault, content, home) {
  const hookFile = join(base, 'pre-commit');
  writeFileSync(hookFile, content, { mode: 0o755 });
  const syntaxCheck = spawnSync('/bin/sh', ['-n', hookFile], { encoding: 'utf-8' });
  assert.equal(syntaxCheck.status, 0, `generated hook is not valid sh:\n${syntaxCheck.stderr}`);
  return spawnSync('/bin/sh', [hookFile], {
    encoding: 'utf-8',
    cwd: vault,
    env: { PATH: process.env.PATH, HOME: home },
  });
}

test('the resolver locates and runs a stubbed install via hypo-pkg.json pkgRoot', () => {
  withResolverFixture(({ base, home, pkgRoot, vault }) => {
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot }));
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.equal(run.status, 0, `hook did not exit 0:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /STUB_PRE_COMMIT_RAN/);
  });
});

test('a pkgRoot whose package.json names a DIFFERENT package is refused, not run', () => {
  withResolverFixture(({ base, home, pkgRoot, vault }) => {
    // Everything else about this root checks out: absolute, a parseable
    // package.json with a version, and the target worker script sitting right
    // where the resolver looks for it. Only the name says it belongs to
    // somebody else. Every other install-identity judgment in this codebase
    // checks that name; this resolver, the one that runs in the user's vault
    // on every commit, used not to — so it would adopt the root and run its
    // script. There is no registry fallback seeded here, so a refusal is the
    // only way this can exit non-zero.
    const foreign = join(base, 'someone-elses-tool');
    mkdirSync(join(foreign, 'hooks'), { recursive: true });
    writeFileSync(
      join(foreign, 'package.json'),
      JSON.stringify({ name: 'someone-elses-tool', version: '3.0.0' }),
    );
    writeFileSync(
      join(foreign, 'hooks', 'hypo-pre-commit.mjs'),
      'console.log("FOREIGN_SCRIPT_RAN");',
    );
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: foreign }));

    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.notEqual(
      run.status,
      0,
      `a root named for another package must not be adopted:\n${run.stdout}${run.stderr}`,
    );
    assert.ok(
      !run.stdout.includes('FOREIGN_SCRIPT_RAN'),
      `the foreign script must never execute: ${run.stdout}`,
    );
    assert.ok(
      !run.stdout.includes('STUB_PRE_COMMIT_RAN'),
      `and our own stub is not reachable here either (pkgRoot points away from it): ${run.stdout}`,
    );
  });
});

test('an unusable hypo-pkg.json pkgRoot (its hooks/hypo-pre-commit.mjs does not exist) is skipped, falling through to the registry', () => {
  withResolverFixture(({ base, home, pkgRoot, vault }) => {
    // Points at a directory with no hooks/hypo-pre-commit.mjs at all — must not
    // be trusted just because hypo-pkg.json parses.
    writeFileSync(
      join(home, '.claude', 'hypo-pkg.json'),
      JSON.stringify({ pkgRoot: join(base, 'stale-pkg-root') }),
    );
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'hypo@hypomnema': [{ scope: 'user', installPath: pkgRoot }] } }),
    );
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.equal(run.status, 0, `hook did not exit 0:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /STUB_PRE_COMMIT_RAN/);
  });
});

test('the legacy hypomnema@hypomnema registry key is honored when hypo@hypomnema is absent', () => {
  withResolverFixture(({ base, home, pkgRoot, vault }) => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: { 'hypomnema@hypomnema': [{ scope: 'user', installPath: pkgRoot }] },
      }),
    );
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.equal(run.status, 0, `hook did not exit 0:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /STUB_PRE_COMMIT_RAN/);
  });
});

test('exits 1 with a helpful stderr message when neither source resolves', () => {
  withResolverFixture(({ base, home, vault }) => {
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.notEqual(run.status, 0, 'must refuse the commit rather than silently no-op');
    assert.match(run.stderr, /could not resolve the install root/);
  });
});

// ── the security fix itself: a relative pkgRoot must not resolve against the
// commit-time cwd ───────────────────────────────────────────────────────────

suite('git-hooks-dir.mjs: the resolver refuses a relative pkgRoot');

// The exact codex reproduction (2026-09-11): `pkgRoot: "."` plus a forged
// `hooks/hypo-pre-commit.mjs` placed INSIDE THE VAULT itself. Before the fix,
// `usable(".")` resolved against the hook's cwd (the vault's own working
// tree at commit time) and found the forged script, so the resolver ran the
// attacker's script instead of refusing, and the real .hypoignore guard never
// ran at all.
test('a relative pkgRoot ("." aimed at the vault itself) is refused, not resolved against the commit-time cwd', () => {
  withResolverFixture(({ base, home, vault }) => {
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: '.' }));
    // The forged worker script an attacker controls, planted where a
    // relative pkgRoot would resolve it: the vault's own working tree.
    mkdirSync(join(vault, 'hooks'), { recursive: true });
    writeFileSync(join(vault, 'hooks', 'hypo-pre-commit.mjs'), 'console.log("FORGED_RAN");\n');
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.notEqual(run.status, 0, 'must refuse the commit rather than run the forged script');
    assert.doesNotMatch(run.stdout, /FORGED_RAN/, 'the forged in-vault script must never run');
    assert.match(run.stderr, /could not resolve the install root/);
  });
});

// A candidate whose target script exists but whose package.json is missing
// (or carries no version) must not be trusted just because the file check
// alone would have passed: the second half of the same hardening.
test('a pkgRoot whose package.json is missing is rejected even though its target script exists', () => {
  withResolverFixture(({ base, home, vault }) => {
    const noPkgJson = join(base, 'no-pkg-json-root');
    mkdirSync(join(noPkgJson, 'hooks'), { recursive: true });
    writeFileSync(
      join(noPkgJson, 'hooks', 'hypo-pre-commit.mjs'),
      'console.log("SHOULD_NOT_RUN");\n',
    );
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: noPkgJson }));
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.notEqual(
      run.status,
      0,
      'must refuse rather than run a script with no package.json proof',
    );
    assert.doesNotMatch(run.stdout, /SHOULD_NOT_RUN/);
  });
});

// ── the resolver bug: a present-but-unusable key hid a usable legacy key ────

suite('git-hooks-dir.mjs: combined registry search across both alias keys');

// Before the fix, `plugins["hypo@hypomnema"] || plugins["hypomnema@hypomnema"]`
// picked the FIRST key that was merely present, so a `hypo@hypomnema` array
// of entirely unusable rows hid a usable `hypomnema@hypomnema` row forever
// (codex reproduction, 2026-09-11: exit 1 with a real legacy row on disk).
test('a hypo@hypomnema array of only unusable rows still falls through to a usable hypomnema@hypomnema row', () => {
  withResolverFixture(({ base, home, pkgRoot, vault }) => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        plugins: {
          'hypo@hypomnema': [{ scope: 'user', installPath: join(base, 'does-not-exist') }],
          'hypomnema@hypomnema': [{ scope: 'user', installPath: pkgRoot }],
        },
      }),
    );
    const run = runGeneratedHook(base, vault, wikiPreCommitContent(vault, false), home);
    assert.equal(run.status, 0, `hook did not exit 0:\n${run.stdout}${run.stderr}`);
    assert.match(run.stdout, /STUB_PRE_COMMIT_RAN/);
  });
});
