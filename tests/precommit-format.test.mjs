// tests/precommit-format.test.mjs
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
  statSync,
  cpSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { test, suite } from './harness.mjs';
import {
  HOME,
  SCRIPTS,
  SESSION_TMP_HOME,
  filterRegularFiles,
  makeGitRepo,
  parseLsFilesStage,
  parseNameStatus,
  partitionStagedFiles,
  selectFormatter,
  withTmpDir,
} from './helpers.mjs';

suite('pre-commit-format: parseNameStatus (NUL token stream)');

test('parser: A/M single-path records', () => {
  const buf = 'A\0a.txt\0M\0b.txt\0';
  assert.deepEqual(parseNameStatus(buf), [
    { path: 'a.txt', status: 'A' },
    { path: 'b.txt', status: 'M' },
  ]);
});

test('parser: R<score> rename — only new path returned', () => {
  const buf = 'R100\0old.txt\0new.txt\0';
  assert.deepEqual(parseNameStatus(buf), [{ path: 'new.txt', status: 'R' }]);
});

test('parser: C<score> copy — only new path returned', () => {
  const buf = 'C75\0src.txt\0copy.txt\0';
  assert.deepEqual(parseNameStatus(buf), [{ path: 'copy.txt', status: 'C' }]);
});

test('parser: R000 (zero-score rename) handled', () => {
  const buf = 'R000\0a.txt\0b.txt\0';
  assert.deepEqual(parseNameStatus(buf), [{ path: 'b.txt', status: 'R' }]);
});

test('parser: paths starting with R or C do not collide with status tokens', () => {
  // status and path are separate NUL tokens, so a path literally named "R100"
  // never ambiguates against a rename status.
  const buf = 'A\0R100\0A\0Cfile\0';
  assert.deepEqual(parseNameStatus(buf), [
    { path: 'R100', status: 'A' },
    { path: 'Cfile', status: 'A' },
  ]);
});

test('parser: D and T are skipped defensively', () => {
  const buf = 'D\0deleted.txt\0A\0kept.txt\0T\0typechange.txt\0';
  assert.deepEqual(parseNameStatus(buf), [{ path: 'kept.txt', status: 'A' }]);
});

test('parser: live git --name-status -z token shape (real repo)', () => {
  const { dir, git } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git(['add', 'a.txt']);
    git(['commit', '-q', '-m', 'init']);
    git(['mv', 'a.txt', 'b space.txt']);
    writeFileSync(join(dir, 'c.txt'), 'hello\n');
    git(['add', 'c.txt']);
    const r = git(['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR']);
    assert.equal(r.status, 0);
    const parsed = parseNameStatus(r.stdout);
    // Expect one rename (a.txt -> "b space.txt") and one add (c.txt).
    const paths = parsed.map((e) => e.path).sort();
    assert.deepEqual(paths, ['b space.txt', 'c.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: filename with TAB (NUL is only separator)', () => {
  const buf = 'A\0with\ttab.txt\0';
  assert.deepEqual(parseNameStatus(buf), [{ path: 'with\ttab.txt', status: 'A' }]);
});

suite('pre-commit-format: ls-files mode filter');

test('filter: drops symlink (120000) and gitlink (160000)', () => {
  const entries = [
    { path: 'reg.txt', status: 'A' },
    { path: 'link.txt', status: 'A' },
    { path: 'sub', status: 'A' },
  ];
  const modeMap = new Map([
    ['reg.txt', '100644'],
    ['link.txt', '120000'],
    ['sub', '160000'],
  ]);
  const kept = filterRegularFiles(entries, modeMap);
  assert.deepEqual(kept, [{ path: 'reg.txt', status: 'A' }]);
});

test('filter: missing from index → defensively excluded', () => {
  const entries = [{ path: 'phantom.txt', status: 'A' }];
  const kept = filterRegularFiles(entries, new Map());
  assert.deepEqual(kept, []);
});

test('parseLsFilesStage: roundtrips mode for paths with spaces', () => {
  const buf = '100644 hash 0\twith space.txt\x00120000 hash 0\tlink.txt\x00';
  const m = parseLsFilesStage(buf);
  assert.equal(m.get('with space.txt'), '100644');
  assert.equal(m.get('link.txt'), '120000');
});

suite('pre-commit-format: partition (safe vs partial)');

test('partition: file in both staged + unstaged dirty → partial', () => {
  const staged = [
    { path: 'a.txt', status: 'M' },
    { path: 'b.txt', status: 'A' },
  ];
  const unstaged = new Set(['a.txt']);
  const { safe, partial } = partitionStagedFiles(staged, unstaged);
  assert.deepEqual(safe, [{ path: 'b.txt', status: 'A' }]);
  assert.deepEqual(partial, [{ path: 'a.txt', status: 'M' }]);
});

test('partition: empty unstaged dirty → everything is safe', () => {
  const staged = [{ path: 'a.txt', status: 'A' }];
  const { safe, partial } = partitionStagedFiles(staged, new Set());
  assert.equal(safe.length, 1);
  assert.equal(partial.length, 0);
});

suite('pre-commit-format: selectFormatter dispatch');

test('selectFormatter: returns null when node_modules/.bin/prettier absent', () => {
  withTmpDir((dir) => {
    assert.equal(selectFormatter(dir), null);
  });
});

test('selectFormatter: returns prettier entry when bin exists', () => {
  withTmpDir((dir) => {
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'prettier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const f = selectFormatter(dir);
    assert.ok(f, 'should detect prettier');
    assert.equal(f.name, 'prettier');
    assert.deepEqual(f.buildArgs(['x.js']), ['--write', '--', 'x.js']);
  });
});

test('selectFormatter: NEVER uses npx (verify bin path is local)', () => {
  withTmpDir((dir) => {
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'prettier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const f = selectFormatter(dir);
    assert.equal(f.bin, join(bin, 'prettier'));
    assert.ok(!/npx/.test(f.bin));
  });
});

suite('pre-commit-format: end-to-end via shim');

const SHIM_PATH = join(SCRIPTS, 'pre-commit-format.mjs');

const INSTALLER_PATH = join(SCRIPTS, 'install-git-hooks.mjs');

function setupHypomnemaFixture() {
  const { dir, git } = makeGitRepo();
  // Mirror Hypomnema layout: package.json + scripts/ + node_modules/.bin/prettier.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'hypomnema', version: '0.0.0', type: 'module' }) + '\n',
  );
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(SHIM_PATH, join(dir, 'scripts', 'pre-commit-format.mjs'));
  cpSync(INSTALLER_PATH, join(dir, 'scripts', 'install-git-hooks.mjs'));
  cpSync(
    join(SCRIPTS, 'lib', 'pre-commit-format.mjs'),
    join(dir, 'scripts', 'lib', 'pre-commit-format.mjs'),
  );
  // Synthetic prettier that lowercases the file (deterministic, no real prettier).
  const binDir = join(dir, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'prettier'),
    '#!/bin/sh\n# fake prettier: lowercase --write args\n' +
      'while [ $# -gt 0 ]; do\n' +
      '  case "$1" in\n' +
      '    --write|--) shift; continue;;\n' +
      '    *) f="$1"; tr "A-Z" "a-z" < "$f" > "$f.tmp" && mv "$f.tmp" "$f"; shift;;\n' +
      '  esac\n' +
      'done\nexit 0\n',
    { mode: 0o755 },
  );
  git(['commit', '--allow-empty', '-q', '-m', 'init']);
  return { dir, git };
}

function runShim(dir, extraEnv = {}) {
  return spawnSync(process.execPath, [join(dir, 'scripts', 'pre-commit-format.mjs')], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, ...extraEnv },
  });
}

test('shim: no staged files → exit 0', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const r = runShim(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: formats staged file + re-stages', () => {
  const { dir, git } = setupHypomnemaFixture();
  try {
    writeFileSync(join(dir, 'sample.txt'), 'HELLO WORLD\n');
    git(['add', 'sample.txt']);
    const r = runShim(dir);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    // Staged content should now be lowercased (re-staged after format).
    const showed = git(['show', ':sample.txt']);
    assert.equal(showed.stdout, 'hello world\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: skips partially-staged file (preserves unstaged hunks)', () => {
  const { dir, git } = setupHypomnemaFixture();
  try {
    writeFileSync(join(dir, 'sample.txt'), 'STAGED\n');
    git(['add', 'sample.txt']);
    // Add unstaged change on top.
    writeFileSync(join(dir, 'sample.txt'), 'STAGED\nUNSTAGED\n');
    const r = runShim(dir);
    assert.equal(r.status, 0);
    // Staged version should be unchanged (partial-staging guard).
    const showed = git(['show', ':sample.txt']);
    assert.equal(showed.stdout, 'STAGED\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: foreign repo (package.json name != "hypomnema") → exit 0, no format', () => {
  const { dir, git } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'other' }) + '\n');
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    cpSync(SHIM_PATH, join(dir, 'scripts', 'pre-commit-format.mjs'));
    cpSync(
      join(SCRIPTS, 'lib', 'pre-commit-format.mjs'),
      join(dir, 'scripts', 'lib', 'pre-commit-format.mjs'),
    );
    writeFileSync(join(dir, 'a.txt'), 'KEEP\n');
    git(['commit', '--allow-empty', '-q', '-m', 'init']);
    git(['add', 'a.txt']);
    const r = runShim(dir);
    assert.equal(r.status, 0);
    // Confirm no format ran (no prettier in node_modules anyway, but identity
    // guard should exit before lib even imports).
    const showed = git(['show', ':a.txt']);
    assert.equal(showed.stdout, 'KEEP\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: missing package.json → exit 0', () => {
  const { dir, git } = makeGitRepo();
  try {
    git(['commit', '--allow-empty', '-q', '-m', 'init']);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(SHIM_PATH, join(dir, 'scripts', 'pre-commit-format.mjs'));
    const r = runShim(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: missing lib (scripts/lib/pre-commit-format.mjs) → exit 0 (fail-open)', () => {
  const { dir, git } = makeGitRepo();
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hypomnema' }) + '\n');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    cpSync(SHIM_PATH, join(dir, 'scripts', 'pre-commit-format.mjs'));
    git(['commit', '--allow-empty', '-q', '-m', 'init']);
    const r = runShim(dir);
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: GIT_INDEX_FILE pointing outside .git/ → exit 0 (foreign index attack)', () => {
  const { dir } = setupHypomnemaFixture();
  const foreignIdx = join(tmpdir(), `foreign-idx-${process.pid}`);
  try {
    writeFileSync(foreignIdx, '');
    const r = runShim(dir, { GIT_INDEX_FILE: foreignIdx });
    assert.equal(r.status, 0);
  } finally {
    rmSync(foreignIdx, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: GIT_DIR=/foreign attack (different absolute-git-dir than ours) → exit 0', () => {
  const { dir } = setupHypomnemaFixture();
  const { dir: foreign } = makeGitRepo();
  try {
    const r = runShim(dir, {
      GIT_DIR: join(foreign, '.git'),
      GIT_WORK_TREE: dir,
    });
    // Either the guard catches mismatch (absGitDir != commonDir handled) or
    // identity check fails. Either way exit 0, no formatting.
    assert.equal(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('shim: invocation WITH sentinel honours GIT_INDEX_FILE (legitimate commit -am path)', () => {
  // Counterpart to the direct-invocation drop test: when the installed shim
  // sets HYPOMNEMA_HOOK_INVOCATION=1, the .mjs preserves GIT_INDEX_FILE so
  // that git's own commit-mode index files (index.lock, next-index-*.lock)
  // continue to drive formatting. This protects the `commit -am` and
  // `commit -- path` flows from accidentally losing inherited index state.
  const { dir: real, git } = setupHypomnemaFixture();
  try {
    writeFileSync(join(real, 'sample.txt'), 'HELLO\n');
    git(['add', 'sample.txt']);
    // Snapshot the real index to next-index-12345.lock (mimicking git's
    // commit -- path behaviour) and point GIT_INDEX_FILE at it.
    const indexLock = join(real, '.git', 'next-index-12345.lock');
    cpSync(join(real, '.git', 'index'), indexLock);
    const r = spawnSync(process.execPath, [join(real, 'scripts', 'pre-commit-format.mjs')], {
      cwd: real,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: SESSION_TMP_HOME,
        GIT_INDEX_FILE: indexLock,
        HYPOMNEMA_HOOK_INVOCATION: '1',
      },
    });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    // The lib should have used the inherited index and formatted sample.txt.
    const after = readFileSync(join(real, 'sample.txt'), 'utf-8');
    assert.equal(after, 'hello\n', 'inherited index must be honoured under shim sentinel');
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test('shim: direct invocation drops inherited GIT_INDEX_FILE (closes alternate-index attacks)', () => {
  // Regression test for codex rounds 8 & 9. Both attacks (crafted .git/attack-
  // index in round 8, .git/next-index-attack.lock prefix-bypass in round 9)
  // worked by setting GIT_INDEX_FILE to an attacker-crafted alternate index and
  // invoking the .mjs directly. The v10 defence is the HYPOMNEMA_HOOK_INVOCATION
  // sentinel: only the installed shell shim sets it. Without it, .mjs drops
  // GIT_INDEX_FILE and git falls back to the default `.git/index`.
  //
  // This test populates the attack-index with a victim file but leaves the
  // real index empty. Direct invocation must NOT format the victim, because
  // the default index has nothing staged.
  const { dir: real, git } = setupHypomnemaFixture();
  try {
    writeFileSync(join(real, 'victim.txt'), 'VICTIM UPPER\n');
    // Stage victim, snapshot index to attack file, then UNSTAGE — so the real
    // .git/index is empty but the attack-index has victim staged.
    git(['add', 'victim.txt']);
    const attackIdx = join(real, '.git', 'next-index-attack.lock');
    cpSync(join(real, '.git', 'index'), attackIdx);
    git(['reset', 'HEAD', 'victim.txt']);
    const before = readFileSync(join(real, 'victim.txt'), 'utf-8');
    const r = spawnSync(process.execPath, [join(real, 'scripts', 'pre-commit-format.mjs')], {
      cwd: real,
      encoding: 'utf-8',
      // Note: no HYPOMNEMA_HOOK_INVOCATION. Direct invocation must drop the
      // attacker-controlled GIT_INDEX_FILE.
      env: { ...process.env, HOME: SESSION_TMP_HOME, GIT_INDEX_FILE: attackIdx },
    });
    assert.equal(r.status, 0);
    const after = readFileSync(join(real, 'victim.txt'), 'utf-8');
    assert.equal(after, before, 'victim must NOT be mutated — attacker-controlled index ignored');
  } finally {
    rmSync(real, { recursive: true, force: true });
  }
});

test('shim: mixed-env (foreign GIT_DIR + real GIT_WORK_TREE + foreign GIT_INDEX_FILE) → no mutation', () => {
  // Regression test for codex round-7 CONCERN. Attack shape:
  //   GIT_DIR=/foreign/.git GIT_WORK_TREE=$expectedRoot
  //   GIT_INDEX_FILE=/foreign/.git/index
  // Without the (3a) expectedGitDirR guard, --show-toplevel returned
  // expectedRoot (passing the anchor) while --absolute-git-dir resolved to
  // foreign. The lib then ran with cwd=expectedRoot but using the foreign
  // index, mutating real files (codex live-verified VICTIM UPPER → victim upper).
  const { dir: real } = setupHypomnemaFixture();
  const foreign = mkdtempSync(join(tmpdir(), 'hypo-mixed-env-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: foreign });
    spawnSync('git', ['config', 'user.email', 't@x'], { cwd: foreign });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: foreign });
    spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: foreign });
    writeFileSync(join(real, 'victim.txt'), 'VICTIM UPPER\n');
    spawnSync('git', ['add', 'victim.txt'], { cwd: real });
    const before = readFileSync(join(real, 'victim.txt'), 'utf-8');
    const r = spawnSync(process.execPath, [join(real, 'scripts', 'pre-commit-format.mjs')], {
      cwd: real,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: SESSION_TMP_HOME,
        GIT_DIR: join(foreign, '.git'),
        GIT_WORK_TREE: real,
        GIT_INDEX_FILE: join(foreign, '.git', 'index'),
      },
    });
    assert.equal(r.status, 0);
    const after = readFileSync(join(real, 'victim.txt'), 'utf-8');
    assert.equal(after, before, 'victim file must NOT be mutated by foreign-index attack');
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('shim: foreign hypomnema-named repo via GIT_DIR/GIT_WORK_TREE → does NOT run foreign lib', () => {
  // Regression test for codex round-6 CONCERN: a malicious repo could claim to
  // be "hypomnema" (matching package.json.name) and have its own
  // scripts/lib/pre-commit-format.mjs. Without the expectedRoot anchor, the
  // shim would execute that foreign lib. We assert that the shim refuses to
  // run when toplevel != expectedRoot.
  const { dir: real } = setupHypomnemaFixture();
  // Build a fully-formed "foreign" hypomnema clone in another tmpdir with its
  // own malicious lib (writes a sentinel file). The real shim lives at
  // `real/scripts/pre-commit-format.mjs`; we invoke that directly with env
  // pointing at the foreign repo.
  const foreign = mkdtempSync(join(tmpdir(), 'hypo-foreign-fixture-'));
  const sentinel = join(foreign, 'foreign-lib-ran.marker');
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: foreign });
    spawnSync('git', ['config', 'user.email', 't@x'], { cwd: foreign });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: foreign });
    writeFileSync(
      join(foreign, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '0.0.0', type: 'module' }) + '\n',
    );
    mkdirSync(join(foreign, 'scripts', 'lib'), { recursive: true });
    writeFileSync(
      join(foreign, 'scripts', 'lib', 'pre-commit-format.mjs'),
      `import fs from 'node:fs';
       export async function runPreCommitFormat() {
         fs.writeFileSync(${JSON.stringify(sentinel)}, 'foreign lib ran\\n');
         return { gitAddFailed: false, summary: 'foreign' };
       }
      `,
    );
    writeFileSync(join(foreign, 'a.txt'), 'X\n');
    spawnSync('git', ['add', 'a.txt'], { cwd: foreign });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: foreign });
    writeFileSync(join(foreign, 'b.txt'), 'Y\n');
    spawnSync('git', ['add', 'b.txt'], { cwd: foreign });

    // Direct invoke of the REAL shim with hostile env pointing at foreign.
    const r = spawnSync(process.execPath, [join(real, 'scripts', 'pre-commit-format.mjs')], {
      cwd: foreign,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: SESSION_TMP_HOME,
        GIT_DIR: join(foreign, '.git'),
        GIT_WORK_TREE: foreign,
      },
    });
    assert.equal(r.status, 0);
    assert.ok(
      !existsSync(sentinel),
      'foreign lib must NOT have run — expectedRoot anchor should block',
    );
  } finally {
    rmSync(real, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

suite('pre-commit-format: installer');

function runInstaller(dir, extraEnv = {}) {
  // Drop CI/npm lifecycle envs from the parent process so the installer's
  // skip guards (CI=true, npm_command=pack/publish, prepublishOnly) don't
  // fire under GitHub Actions (where CI=true is always set). Tests that
  // exercise those guards override via extraEnv explicitly.
  const { CI, npm_command, npm_lifecycle_event, ...cleanParent } = process.env;
  void CI;
  void npm_command;
  void npm_lifecycle_event;
  return spawnSync(process.execPath, [join(dir, 'scripts', 'install-git-hooks.mjs')], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...cleanParent, HOME: SESSION_TMP_HOME, ...extraEnv },
  });
}

test('installer: fresh repo → installs shim with marker + 0755', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const r = runInstaller(dir);
    assert.equal(r.status, 0);
    const target = join(dir, '.git', 'hooks', 'pre-commit');
    assert.ok(existsSync(target));
    const content = readFileSync(target, 'utf-8');
    assert.ok(content.includes('hypomnema-pre-commit-marker v2'));
    assert.ok(content.includes('HYPOMNEMA_ROOT='));
    assert.ok(content.includes('HYPOMNEMA_GIT_DIR='));
    // pre-commit chains the format step AND the tracker-id gate on staged blobs.
    assert.ok(content.includes('pre-commit-format.mjs'));
    assert.ok(content.includes('check-tracker-ids.mjs'));
    assert.ok(content.includes('"$TRK" --staged'));
    const mode = statSync(target).mode & 0o777;
    assert.equal(mode & 0o100, 0o100, 'should be executable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: fresh repo → also installs commit-msg hook (tracker gate)', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const r = runInstaller(dir);
    assert.equal(r.status, 0);
    const target = join(dir, '.git', 'hooks', 'commit-msg');
    assert.ok(existsSync(target), 'commit-msg hook installed');
    const content = readFileSync(target, 'utf-8');
    assert.ok(content.includes('hypomnema-commit-msg-marker v2'));
    assert.ok(content.includes('check-tracker-ids.mjs'));
    assert.ok(content.includes('"$TRK" --commit-msg "$1"'));
    assert.equal(statSync(target).mode & 0o100, 0o100, 'should be executable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: existing non-marker commit-msg → not overwritten', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const target = join(dir, '.git', 'hooks', 'commit-msg');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\n# user commit-msg hook\nexit 0\n');
    const before = readFileSync(target, 'utf-8');
    const r = runInstaller(dir);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(target, 'utf-8'), before, 'user commit-msg hook preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: existing non-marker pre-commit → does not overwrite', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const target = join(dir, '.git', 'hooks', 'pre-commit');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/sh\n# user hook\nexit 0\n');
    const before = readFileSync(target, 'utf-8');
    const r = runInstaller(dir);
    assert.equal(r.status, 0);
    const after = readFileSync(target, 'utf-8');
    assert.equal(before, after, 'user hook preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: marker file → regenerated (idempotent re-run safe)', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    runInstaller(dir);
    const target = join(dir, '.git', 'hooks', 'pre-commit');
    const first = readFileSync(target, 'utf-8');
    const r = runInstaller(dir);
    assert.equal(r.status, 0);
    const second = readFileSync(target, 'utf-8');
    assert.equal(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: existing symlinked pre-commit → not overwritten', () => {
  const { dir } = setupHypomnemaFixture();
  const tgt = mkdtempSync(join(tmpdir(), 'hypo-symlink-tgt-'));
  const real = join(tgt, 'real-hook.sh');
  try {
    writeFileSync(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const hookFile = join(dir, '.git', 'hooks', 'pre-commit');
    mkdirSync(dirname(hookFile), { recursive: true });
    symlinkSync(real, hookFile);
    runInstaller(dir);
    // Should still be a symlink, pointing at the original target.
    const st = statSync(hookFile);
    assert.ok(st.isFile(), 'symlink resolves to file');
    const lst = spawnSync('readlink', [hookFile], { encoding: 'utf-8' });
    assert.equal(lst.stdout.trim(), real);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tgt, { recursive: true, force: true });
  }
});

test('installer: CI=true → skips, no hook written', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const r = runInstaller(dir, { CI: 'true' });
    assert.equal(r.status, 0);
    assert.ok(!existsSync(join(dir, '.git', 'hooks', 'pre-commit')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: npm_command=pack → skips', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const r = runInstaller(dir, { npm_command: 'pack', CI: '' });
    assert.equal(r.status, 0);
    assert.ok(!existsSync(join(dir, '.git', 'hooks', 'pre-commit')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: linked worktree → skips', () => {
  const { dir, git } = setupHypomnemaFixture();
  let wt = null;
  try {
    git(['branch', 'feat']);
    wt = mkdtempSync(join(tmpdir(), 'hypo-wt-'));
    // git worktree wants a path that does not yet exist; remove then add.
    rmSync(wt, { recursive: true, force: true });
    const wtAdd = spawnSync('git', ['-C', dir, 'worktree', 'add', wt, 'feat'], {
      encoding: 'utf-8',
    });
    assert.equal(wtAdd.status, 0, `worktree add failed: ${wtAdd.stderr}`);
    // Copy the installer into the linked worktree under the same scripts path
    // so its `import.meta.url` resolves to a valid file inside the worktree.
    mkdirSync(join(wt, 'scripts'), { recursive: true });
    cpSync(INSTALLER_PATH, join(wt, 'scripts', 'install-git-hooks.mjs'));
    // Drop CI/lifecycle envs so the test exercises the linked-worktree guard,
    // not the CI=true skip (always present on GitHub Actions).
    const { CI, npm_command, npm_lifecycle_event, ...cleanParent } = process.env;
    void CI;
    void npm_command;
    void npm_lifecycle_event;
    const r = spawnSync(process.execPath, [join(wt, 'scripts', 'install-git-hooks.mjs')], {
      cwd: wt,
      encoding: 'utf-8',
      env: { ...cleanParent, HOME: SESSION_TMP_HOME, HYPOMNEMA_HOOK_VERBOSE: '1' },
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /linked worktree|toplevel != expectedRoot/);
  } finally {
    if (wt) rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer: foreign repo via GIT_DIR override → no hook written in foreign repo', () => {
  const { dir } = setupHypomnemaFixture();
  const foreign = mkdtempSync(join(tmpdir(), 'hypo-foreign-'));
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: foreign });
    spawnSync('git', ['config', 'user.email', 't@x'], { cwd: foreign });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: foreign });
    spawnSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: foreign });
    // Run installer from Hypomnema cwd but with GIT_DIR pointing at foreign.
    const r = runInstaller(dir, {
      GIT_DIR: join(foreign, '.git'),
      GIT_WORK_TREE: dir,
      HYPOMNEMA_HOOK_VERBOSE: '1',
    });
    assert.equal(r.status, 0);
    // Foreign repo must not have our hook.
    assert.ok(!existsSync(join(foreign, '.git', 'hooks', 'pre-commit')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  }
});

test('installer: HYPOMNEMA_HOOK_VERBOSE=1 surfaces skip reason on stderr', () => {
  const { dir } = setupHypomnemaFixture();
  try {
    const r = runInstaller(dir, { CI: 'true', HYPOMNEMA_HOOK_VERBOSE: '1' });
    assert.match(r.stderr, /CI=true|skipping/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
