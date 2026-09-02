// tests/rename-wikilink.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  cpSync,
  chmodSync,
  statSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectPagesLint,
  collectPagesLinkable,
  collectPagesGraph,
  collectPagesRename,
  collectPagesCrystallize,
  slugForms,
  extractWikilinks,
} from '../scripts/lib/wikilink.mjs';
import { test, suite } from './harness.mjs';
import { run, withTmpDir, SCRIPTS, SESSION_TMP_HOME } from './helpers.mjs';

// ── rename.mjs (inbound wikilink rewrite) ─────────────────────────────────────

suite('rename.mjs');

// Rewrites go through a temp file and a rename, which means a brand new inode.
// A new inode carries new permissions, so without carrying the old mode over an
// inbound rewrite would quietly turn a 0600 page into 0644 and widen it.
test('an inbound rewrite keeps the page mode it found (no widening via temp+rename)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nself\n');
    const priv = join(dir, 'pages', 'private.md');
    writeFileSync(priv, '---\ntitle: private\n---\nsee [[foo]].\n');
    chmodSync(priv, 0o600);

    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(readFileSync(priv, 'utf-8').includes('[[bar]]'), 'the link was actually rewritten');
    assert.equal(statSync(priv).mode & 0o777, 0o600, 'a rewritten page keeps its original mode');
  });
});

test('rewrites bare / alias / anchor inbound links and moves the page', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nself\n');
    writeFileSync(
      join(dir, 'pages', 'a.md'),
      '---\ntitle: a\n---\nsee [[foo]] and [[foo|the foo]] and [[foo#sec]].\n',
    );
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.links_rewritten, 3, `all three forms rewritten: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'pages', 'bar.md')), 'page moved to bar.md');
    assert.ok(!existsSync(join(dir, 'pages', 'foo.md')), 'old foo.md removed');
    const a = readFileSync(join(dir, 'pages', 'a.md'), 'utf-8');
    assert.ok(
      a.includes('[[bar]]') && a.includes('[[bar|the foo]]') && a.includes('[[bar#sec]]'),
      `alias/anchor preserved with new target: ${a}`,
    );
  });
});

// advisor: the correctness axis — a bare basename shared by two pages must NOT
// be blind-rewritten; only the unambiguous (dir-relative) form is.
test('bare collision → ambiguous link reported, dir-relative form is rewritten', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages', 'x'), { recursive: true });
    mkdirSync(join(dir, 'pages', 'y'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x', 'foo.md'), 'x foo\n');
    writeFileSync(join(dir, 'pages', 'y', 'foo.md'), 'y foo\n');
    writeFileSync(join(dir, 'pages', 'ref.md'), 'bare [[foo]] and dirrel [[x/foo]]\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=pages/x/foo',
      '--to=baz',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    const ref = readFileSync(join(dir, 'pages', 'ref.md'), 'utf-8');
    assert.ok(ref.includes('[[foo]]'), `ambiguous bare link must be untouched: ${ref}`);
    assert.ok(ref.includes('[[x/baz]]'), `dir-relative link must be rewritten: ${ref}`);
    assert.ok(
      out.ambiguous.some((a) => a.file === 'pages/ref.md'),
      `ambiguity must be reported: ${r.stdout}`,
    );
  });
});

// advisor: preserve append-only time records — rewriting a [[old]] inside a past
// journal/session-log snapshot would falsify that moment.
test('preserved append-only sources (journal) are skipped', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'journal'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'pages', 'live.md'), 'live [[foo]]\n');
    writeFileSync(join(dir, 'journal', '2026-W01.md'), 'snapshot [[foo]]\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const live = readFileSync(join(dir, 'pages', 'live.md'), 'utf-8');
    const snap = readFileSync(join(dir, 'journal', '2026-W01.md'), 'utf-8');
    assert.ok(live.includes('[[bar]]'), 'live link rewritten');
    assert.ok(snap.includes('[[foo]]'), 'journal snapshot preserved (not rewritten)');
  });
});

test('links inside code fences are not rewritten', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'pages', 'doc.md'), 'real [[foo]]\n```\ncode [[foo]]\n```\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    const out = JSON.parse(r.stdout);
    const doc = readFileSync(join(dir, 'pages', 'doc.md'), 'utf-8');
    assert.ok(doc.includes('real [[bar]]'), 'prose link rewritten');
    assert.ok(doc.includes('code [[foo]]'), 'code-fenced link preserved');
    assert.equal(out.links_rewritten, 1, `only the prose link counts: ${r.stdout}`);
  });
});

test('--to already exists → refused (no blind overwrite of a live page)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'pages', 'bar.md'), 'bar\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `overwrite must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'from not moved on refusal');
  });
});

test('--from missing → refused', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'a.md'), 'a\n');
    const r = run('rename.mjs', [`--hypo-dir=${dir}`, '--from=nope', '--to=bar', '--json']);
    assert.equal(r.status, 1, `missing from must be refused: ${r.stdout}`);
  });
});

test('dry-run (no --apply) reports but writes nothing', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '[[foo]]\n');
    const r = run('rename.mjs', [`--hypo-dir=${dir}`, '--from=foo', '--to=bar', '--json']);
    const out = JSON.parse(r.stdout);
    assert.equal(out.applied, false);
    assert.equal(out.links_rewritten, 1);
    assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'dry-run does not move the page');
    assert.ok(
      readFileSync(join(dir, 'pages', 'a.md'), 'utf-8').includes('[[foo]]'),
      'dry-run does not rewrite',
    );
  });
});

// advisor minor: idempotency — after an apply, no inbound link to the old slug
// remains, and a second pass for the same target finds nothing to do.
test('idempotency: after apply, no stale link remains and re-pass is a no-op', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '[[foo]] [[foo]]\n');
    run('rename.mjs', [`--hypo-dir=${dir}`, '--from=foo', '--to=bar', '--apply', '--json']);
    const a = readFileSync(join(dir, 'pages', 'a.md'), 'utf-8');
    assert.ok(!a.includes('[[foo]]'), 'no stale [[foo]] remains');
    // A second pass targeting the new slug rewrites nothing (already current).
    const r2 = run('rename.mjs', [`--hypo-dir=${dir}`, '--from=bar', '--to=bar', '--json']);
    assert.equal(r2.status, 1, 'same from/to is rejected (nothing to rename)');
  });
});

// codex commit review: a cross-directory basename collision must be refused —
// existsSync(toPath) alone misses pages/bar.md vs projects/bar.md, and proceeding
// would emit ambiguous [[bar]] links.
test('--to colliding with another dir on bare form → refused (no ambiguous links)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'projects', 'bar.md'), 'bar\n');
    writeFileSync(join(dir, 'pages', 'ref.md'), '[[foo]]\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `collision must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'from not moved on collision');
    assert.ok(
      readFileSync(join(dir, 'pages', 'ref.md'), 'utf-8').includes('[[foo]]'),
      'no rewrite on refusal',
    );
  });
});

// codex commit review: sources/* are full-slug-only targets (lint parity), so a
// bare [[foo]] is NOT made ambiguous by a same-basename source file.
test('sources/* same-basename does not block a bare-link rewrite (full-slug-only parity)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'sources'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'sources', 'foo.md'), 'captured\n');
    writeFileSync(join(dir, 'pages', 'ref.md'), 'see [[foo]]\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=pages/foo',
      '--to=baz',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const ref = readFileSync(join(dir, 'pages', 'ref.md'), 'utf-8');
    assert.ok(ref.includes('[[baz]]'), `bare link must rewrite despite same-name source: ${ref}`);
  });
});

// codex commit review: --to must not escape the wiki root.
test('--to with ../ escaping the vault → refused', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=../evil',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `escaping --to must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'from not moved');
  });
});

// codex re-review BLOCKER: a symlinked --to ANCESTOR is lexically in-vault but
// writeFileSync(toPath) would follow it and write the moved page outside the vault
// — page mode must refuse it (same realpath containment as directory mode).
test('--to through a symlinked ancestor → refused (page mode, no escape)', () => {
  withTmpDir((dir) => {
    withTmpDir((outside) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      mkdirSync(join(dir, 'projects'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
      writeFileSync(join(dir, 'pages', 'ref.md'), 'see [[foo]]\n');
      try {
        symlinkSync(outside, join(dir, 'projects', 'link'));
      } catch {
        return; // no symlink support — skip
      }
      const r = run('rename.mjs', [
        `--hypo-dir=${dir}`,
        '--from=foo',
        '--to=projects/link/new',
        '--apply',
        '--json',
      ]);
      assert.equal(r.status, 1, `symlink-ancestor --to must be refused: ${r.stdout}`);
      assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'from not moved');
      assert.ok(!existsSync(join(outside, 'new.md')), 'nothing written outside the vault');
      assert.ok(
        readFileSync(join(dir, 'pages', 'ref.md'), 'utf-8').includes('[[foo]]'),
        'no inbound rewrite on refusal',
      );
    });
  });
});

// codex re-review CONCERN: a --to whose ancestor is a regular FILE passes realpath
// containment but mkdirSync(dirname) would fail ENOTDIR — after inbound rewrites
// already landed. Refuse up front so a failed move never churns the vault.
test('--to with a regular-file ancestor → refused before any rewrite (page mode)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), 'foo\n');
    writeFileSync(join(dir, 'pages', 'ref.md'), 'see [[foo]]\n');
    writeFileSync(join(dir, 'projects', 'regfile'), 'iamafile');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=projects/regfile/sub',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `file-ancestor destination must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'from not moved');
    assert.ok(
      readFileSync(join(dir, 'pages', 'ref.md'), 'utf-8').includes('[[foo]]'),
      'no inbound rewrite landed before refusal',
    );
  });
});

// Regression: the move step used to be write-to-new-path, then rmSync the old
// one — two syscalls with an observable gap between them. A crash landing in
// that gap left both paths on disk, and re-running hit the --to-already-exists
// guard forever (exit 1, no way out without a manual delete). The fix folds the
// move into a single renameSync, so the only two states reachable are "old path
// only" and "new path only" — never both.
//
// This proves it by actually killing a child process bracketing the real
// renameSync call — right before it and right after it — rather than before
// the unrelated body-write step. Killing before body-write would pass under a
// write-then-remove implementation too (nothing has moved yet either way), so
// it wouldn't tell the two implementations apart. Killing on the renameSync
// call itself is the only place that distinguishes "one syscall" from "two
// syscalls with a gap".
//
// The kill hook is NOT in the shipped script: this builds ONE throwaway copy
// of scripts/ with both anchors patched, and every crash test below spawns
// that copy. scripts/rename.mjs in the repo stays exactly as written above.
const KILL_COPY_ROOT = mkdtempSync(join(tmpdir(), 'hypo-rename-kill-'));
process.on('exit', () => {
  try {
    rmSync(KILL_COPY_ROOT, { recursive: true, force: true });
  } catch {}
});
const KILL_SCRIPTS = join(KILL_COPY_ROOT, 'scripts');
const KILL_RENAME = join(KILL_SCRIPTS, 'rename.mjs');
cpSync(SCRIPTS, KILL_SCRIPTS, { recursive: true });
{
  let src = readFileSync(KILL_RENAME, 'utf-8');
  const pageAnchor = 'renameSync(fromPage.path, toPath);';
  const dirAnchor = 'renameSync(fromAbs, toAbs);';
  // atomicWrite is the ONE place every mid-loop write (marker + every inbound
  // rewrite, in both modes) actually lands on disk, so counting its calls is
  // the one hook that can bracket "some rewrites landed, some didn't" without
  // caring which mode or which file is currently being written.
  const atomicWriteDecl = 'function atomicWrite(path, content) {';
  const atomicWriteAnchor = 'renameSync(tmp, path);';
  assert.ok(
    src.includes(pageAnchor),
    `page-mode renameSync anchor not found — did rename.mjs change?`,
  );
  assert.ok(
    src.includes(dirAnchor),
    `dir-mode renameSync anchor not found — did rename.mjs change?`,
  );
  assert.ok(
    src.includes(atomicWriteDecl),
    `atomicWrite declaration not found — did rename.mjs change?`,
  );
  assert.ok(
    src.includes(atomicWriteAnchor),
    `atomicWrite renameSync anchor not found — did rename.mjs change?`,
  );
  src = src.replace(
    pageAnchor,
    `if (process.env.HYPO_TEST_KILL_PAGE_PRE) process.kill(process.pid, 'SIGKILL');\n        ${pageAnchor}\n        if (process.env.HYPO_TEST_KILL_PAGE_POST) process.kill(process.pid, 'SIGKILL');`,
  );
  src = src.replace(
    dirAnchor,
    `if (process.env.HYPO_TEST_KILL_DIR_PRE) process.kill(process.pid, 'SIGKILL');\n      ${dirAnchor}\n      if (process.env.HYPO_TEST_KILL_DIR_POST) process.kill(process.pid, 'SIGKILL');`,
  );
  src = src.replace(atomicWriteDecl, `let __atomicWriteCalls = 0;\n${atomicWriteDecl}`);
  src = src.replace(
    atomicWriteAnchor,
    `${atomicWriteAnchor}\n    __atomicWriteCalls++;\n    if (process.env.HYPO_TEST_KILL_AFTER_N && __atomicWriteCalls >= Number(process.env.HYPO_TEST_KILL_AFTER_N)) process.kill(process.pid, 'SIGKILL');`,
  );
  writeFileSync(KILL_RENAME, src);
}

test('crash bracketing the single-file renameSync converges, two paths never coexist (page mode)', () => {
  for (const [envVar, label] of [
    ['HYPO_TEST_KILL_PAGE_PRE', 'pre-rename'],
    ['HYPO_TEST_KILL_PAGE_POST', 'post-rename'],
  ]) {
    withTmpDir((base) => {
      const wiki = join(base, 'wiki');
      const home = join(base, 'home');
      mkdirSync(join(wiki, 'pages'), { recursive: true });
      mkdirSync(home, { recursive: true });
      // Self-referential link forces fromPage._rewritten, so the pre-rename
      // write actually runs before the PRE kill point.
      writeFileSync(join(wiki, 'pages', 'foo.md'), '---\ntitle: foo\n---\nsee [[foo]] itself.\n');

      const cmd = [
        KILL_RENAME,
        `--hypo-dir=${wiki}`,
        '--from=foo',
        '--to=bar',
        '--apply',
        '--json',
      ];
      const killed = spawnSync(process.execPath, cmd, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, [envVar]: '1' },
      });
      assert.equal(
        killed.signal,
        'SIGKILL',
        `[${label}] expected the kill hook to fire: ${killed.stderr}`,
      );

      const fooPath = join(wiki, 'pages', 'foo.md');
      const barPath = join(wiki, 'pages', 'bar.md');
      const fooExists = existsSync(fooPath);
      const barExists = existsSync(barPath);
      // The property the fix pins: renameSync is one syscall, so no kill point
      // can observe both the old and the new path at once.
      assert.ok(
        !(fooExists && barExists),
        `[${label}] old and new path must never coexist after a crash`,
      );
      assert.ok(fooExists || barExists, `[${label}] exactly one path must survive the crash`);

      const rerun = spawnSync(process.execPath, cmd, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
      });
      if (fooExists) {
        // Killed before the rename: --from still resolves, re-run finishes the move.
        assert.equal(
          rerun.status,
          0,
          `[${label}] re-run from the pre-rename state must converge: ${rerun.stdout}${rerun.stderr}`,
        );
        assert.ok(existsSync(barPath), `[${label}] bar.md exists after re-run`);
        assert.ok(!existsSync(fooPath), `[${label}] foo.md gone after re-run`);
        const bar = readFileSync(barPath, 'utf-8');
        assert.ok(
          bar.includes('[[bar]]'),
          `[${label}] self-reference rewrite carried through: ${bar}`,
        );
      } else {
        // Killed after the rename: the move already landed, --from correctly
        // no longer resolves — nothing left to converge.
        assert.equal(
          rerun.status,
          1,
          `[${label}] already-moved re-run must report --from missing, not redo anything: ${rerun.stdout}`,
        );
      }
    });
  }
});

// Same property, directory mode (BLOCKER: moved-body content used to be written
// AFTER renameSync, so a crash between them left the relocated subtree's own
// internal links pointing at the pre-move prefix forever — --from no longer
// resolved once the directory had moved, so re-run couldn't repair it. The fix
// writes moved bodies at their OLD paths before the rename, so the content
// travels with the directory instead of racing it.
test('crash bracketing the directory renameSync converges, two dirs never coexist (directory mode)', () => {
  for (const [envVar, label] of [
    ['HYPO_TEST_KILL_DIR_PRE', 'pre-rename'],
    ['HYPO_TEST_KILL_DIR_POST', 'post-rename'],
  ]) {
    withTmpDir((base) => {
      const wiki = join(base, 'wiki');
      const home = join(base, 'home');
      mkdirSync(join(wiki, 'projects', 'old'), { recursive: true });
      mkdirSync(home, { recursive: true });
      // a → b is an intra-subtree full-slug link: it MUST be rewritten to the
      // new prefix, so a non-empty moved-body write actually happens.
      writeFileSync(
        join(wiki, 'projects', 'old', 'a.md'),
        '---\ntitle: a\n---\nsee [[projects/old/b]].\n',
      );
      writeFileSync(join(wiki, 'projects', 'old', 'b.md'), '---\ntitle: b\n---\nb page\n');

      const cmd = [
        KILL_RENAME,
        `--hypo-dir=${wiki}`,
        '--from=projects/old',
        '--to=projects/new',
        '--apply',
        '--json',
      ];
      const killed = spawnSync(process.execPath, cmd, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, [envVar]: '1' },
      });
      assert.equal(
        killed.signal,
        'SIGKILL',
        `[${label}] expected the kill hook to fire: ${killed.stderr}`,
      );

      const oldDir = join(wiki, 'projects', 'old');
      const newDir = join(wiki, 'projects', 'new');
      const oldExists = existsSync(oldDir);
      const newExists = existsSync(newDir);
      assert.ok(
        !(oldExists && newExists),
        `[${label}] old and new directory must never coexist after a crash`,
      );
      assert.ok(oldExists || newExists, `[${label}] exactly one directory must survive the crash`);

      const rerun = spawnSync(process.execPath, cmd, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
      });
      if (oldExists) {
        assert.equal(
          rerun.status,
          0,
          `[${label}] re-run from the pre-rename state must converge: ${rerun.stdout}${rerun.stderr}`,
        );
        assert.ok(
          existsSync(join(newDir, 'a.md')),
          `[${label}] a.md exists at the new path after re-run`,
        );
        assert.ok(!existsSync(oldDir), `[${label}] projects/old gone after re-run`);
        const a = readFileSync(join(newDir, 'a.md'), 'utf-8');
        assert.ok(
          a.includes('[[projects/new/b]]'),
          `[${label}] intra-subtree link rewritten to the new prefix: ${a}`,
        );
      } else {
        assert.equal(
          rerun.status,
          1,
          `[${label}] already-moved re-run must report --from missing, not redo anything: ${rerun.stdout}`,
        );
      }
    });
  }
});

// ── rename.mjs directory mode (subtree relocation) ────────────────────────────

suite('rename.mjs directory mode');

// Build a project-shaped subtree with the four source classes plus a non-.md asset.
function dirFixture(dir) {
  mkdirSync(join(dir, 'projects', 'old', 'decisions'), { recursive: true });
  mkdirSync(join(dir, 'projects', 'old', 'session-log'), { recursive: true });
  mkdirSync(join(dir, 'projects', 'old', 'sources'), { recursive: true });
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'journal'), { recursive: true });
  writeFileSync(
    join(dir, 'projects', 'old', 'index.md'),
    '---\ntitle: idx\n---\nsee [[projects/old/decisions/0001]] and bare [[0001]]\n',
  );
  writeFileSync(
    join(dir, 'projects', 'old', 'decisions', '0001.md'),
    '---\ntitle: d1\n---\nref [[projects/old/index]]\n',
  );
  writeFileSync(
    join(dir, 'projects', 'old', 'session-log', '2026-06.md'),
    '---\ntitle: log\n---\ntouched [[projects/old/decisions/0001]]\n',
  );
  writeFileSync(
    join(dir, 'projects', 'old', 'sources', 'cap.md'),
    '---\ntitle: src\n---\ncaptured [[projects/old/index]] verbatim\n',
  );
  writeFileSync(join(dir, 'projects', 'old', 'logo.png'), 'PNGDATA');
  writeFileSync(
    join(dir, 'pages', 'ext.md'),
    '---\ntitle: ext\n---\nlive [[projects/old/index]] and bare [[0001]]\n',
  );
  writeFileSync(
    join(dir, 'journal', '2026-W01.md'),
    '---\ntitle: j\n---\nsnap [[projects/old/index]]\n',
  );
}

test('directory move: subtree relocated, non-.md asset carried, external full-slug rewritten', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode, 'directory');
    assert.equal(out.pages_moved, 4, `4 .md pages moved: ${r.stdout}`);
    assert.ok(!existsSync(join(dir, 'projects', 'old')), 'old dir removed');
    assert.ok(existsSync(join(dir, 'projects', 'new', 'logo.png')), 'non-.md asset carried');
    const ext = readFileSync(join(dir, 'pages', 'ext.md'), 'utf-8');
    assert.ok(ext.includes('[[projects/new/index]]'), 'external full-slug rewritten');
    assert.ok(ext.includes('bare [[0001]]'), 'bare link untouched (survives a dir move)');
  });
});

test('directory move: intra-subtree links in moved page bodies land at new paths', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    const idx = readFileSync(join(dir, 'projects', 'new', 'index.md'), 'utf-8');
    assert.ok(idx.includes('[[projects/new/decisions/0001]]'), 'moved page intra-link rewritten');
    assert.ok(idx.includes('bare [[0001]]'), 'bare intra-link untouched');
    const d1 = readFileSync(join(dir, 'projects', 'new', 'decisions', '0001.md'), 'utf-8');
    assert.ok(d1.includes('[[projects/new/index]]'), 'sibling back-reference rewritten');
  });
});

test('directory move: time-record inside subtree rewrites with alias-preserved label', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    const log = readFileSync(join(dir, 'projects', 'new', 'session-log', '2026-06.md'), 'utf-8');
    assert.ok(
      log.includes('[[projects/new/decisions/0001|projects/old/decisions/0001]]'),
      `time-record link rewritten with old label preserved: ${log}`,
    );
  });
});

test('directory move: sources/* body inside subtree is never rewritten', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    const cap = readFileSync(join(dir, 'projects', 'new', 'sources', 'cap.md'), 'utf-8');
    assert.ok(
      cap.includes('[[projects/old/index]]'),
      `sources body must stay immutable (not rewritten): ${cap}`,
    );
  });
});

test('directory move: time-record OUTSIDE subtree stays frozen', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    const j = readFileSync(join(dir, 'journal', '2026-W01.md'), 'utf-8');
    assert.ok(j.includes('[[projects/old/index]]'), 'outside journal snapshot frozen');
  });
});

test('directory move: 2-segment dir-relative link is left untouched (out of scope, survives)', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    // `[[decisions/0001]]` drops two segments — not a registered form (lint parity).
    // It does not encode the renamed prefix, so a dir move leaves it valid as-is.
    writeFileSync(join(dir, 'pages', 'two.md'), '---\ntitle: two\n---\n[[decisions/0001]]\n');
    run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    const two = readFileSync(join(dir, 'pages', 'two.md'), 'utf-8');
    assert.ok(two.includes('[[decisions/0001]]'), 'unregistered 2-seg form untouched');
  });
});

test('directory move: existing destination → renumber report, refused, no move', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old', 'decisions'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'new', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'decisions', '0001.md'), 'a\n');
    writeFileSync(join(dir, 'projects', 'new', 'decisions', '0001.md'), 'b\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `merge into existing must be refused: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reason, 'renumber-or-merge');
    assert.ok(
      out.destination_collisions.includes('projects/new/decisions/0001.md'),
      `collision listed: ${r.stdout}`,
    );
    assert.ok(existsSync(join(dir, 'projects', 'old')), 'from not moved on refusal');
  });
});

test('directory move: cross-area --to (changes top-level segment) → refused', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'a.md'), 'a\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=pages/old',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `cross-area move must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'projects', 'old')), 'from not moved');
  });
});

test('directory move: --to nested inside --from → refused', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'a.md'), 'a\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/old/sub',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `nested move must be refused: ${r.stdout}`);
  });
});

test('directory move: subtree containing a symlink → refused', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'a.md'), 'a\n');
    try {
      symlinkSync(join(dir, 'projects', 'old', 'a.md'), join(dir, 'projects', 'old', 'link.md'));
    } catch {
      return; // platform without symlink support — skip
    }
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `symlinked subtree must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'projects', 'old')), 'from not moved');
  });
});

// codex commit review BLOCKER: a symlinked --to ANCESTOR is lexically in-vault
// but renameSync would follow it and move data outside the vault. realpath
// containment must refuse it.
test('directory move: --to through a symlinked ancestor → refused (no escape)', () => {
  withTmpDir((dir) => {
    withTmpDir((outside) => {
      mkdirSync(join(dir, 'projects', 'old'), { recursive: true });
      writeFileSync(join(dir, 'projects', 'old', 'a.md'), 'a\n');
      try {
        symlinkSync(outside, join(dir, 'projects', 'link'));
      } catch {
        return; // no symlink support — skip
      }
      const r = run('rename.mjs', [
        `--hypo-dir=${dir}`,
        '--from=projects/old',
        '--to=projects/link/new',
        '--apply',
        '--json',
      ]);
      assert.equal(r.status, 1, `symlink-ancestor --to must be refused: ${r.stdout}`);
      assert.ok(existsSync(join(dir, 'projects', 'old')), 'from not moved');
      assert.ok(!existsSync(join(outside, 'new')), 'nothing written outside the vault');
    });
  });
});

// codex commit review BLOCKER (symmetric): a --from below a symlinked ancestor
// would drag an outside-the-vault directory IN. Must be refused.
test('directory move: --from below a symlinked ancestor → refused (no outside dir pulled in)', () => {
  withTmpDir((dir) => {
    withTmpDir((outside) => {
      mkdirSync(join(outside, 'old'), { recursive: true });
      writeFileSync(join(outside, 'old', 'b.md'), 'ext\n');
      mkdirSync(join(dir, 'projects'), { recursive: true });
      try {
        symlinkSync(outside, join(dir, 'projects', 'link'));
      } catch {
        return; // no symlink support — skip
      }
      const r = run('rename.mjs', [
        `--hypo-dir=${dir}`,
        '--from=projects/link/old',
        '--to=projects/new',
        '--apply',
        '--json',
      ]);
      assert.equal(r.status, 1, `symlink-ancestor --from must be refused: ${r.stdout}`);
      assert.ok(!existsSync(join(dir, 'projects', 'new')), 'no outside dir pulled into the vault');
    });
  });
});

// codex re-review BLOCKER: a DANGLING symlink destination ancestor must be
// fail-closed (existsSync would treat it as absent and step past it). No external
// rewrite may land before the move is refused.
test('directory move: dangling-symlink destination → refused before any write', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'a.md'), '---\ntitle: a\n---\nx\n');
    writeFileSync(join(dir, 'projects', 'ext.md'), '---\ntitle: e\n---\next [[projects/old/a]]\n');
    try {
      symlinkSync(join(dir, 'projects', 'NO_SUCH_TARGET'), join(dir, 'projects', 'dangling'));
    } catch {
      return; // no symlink support — skip
    }
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/dangling/sub',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `dangling-symlink destination must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'projects', 'old')), 'from not moved');
    assert.ok(
      readFileSync(join(dir, 'projects', 'ext.md'), 'utf-8').includes('[[projects/old/a]]'),
      'no external rewrite landed before refusal (fail-closed)',
    );
  });
});

test('directory move: --to with a regular-file ancestor → refused before any rewrite', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'a.md'), '---\ntitle: a\n---\nx\n');
    writeFileSync(join(dir, 'projects', 'ext.md'), '---\ntitle: e\n---\next [[projects/old/a]]\n');
    writeFileSync(join(dir, 'projects', 'regfile'), 'iamafile');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/regfile/sub',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 1, `file-ancestor destination must be refused: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'projects', 'old')), 'from not moved');
    assert.ok(
      readFileSync(join(dir, 'projects', 'ext.md'), 'utf-8').includes('[[projects/old/a]]'),
      'no external rewrite landed before refusal',
    );
  });
});

// A second directory rename over an already alias-preserved [[new|old]] time-record
// link updates the target but keeps the ORIGINAL label frozen (suffix present →
// kind-preserving path, no re-aliasing). Pins the multi-rename guarantee.
test('directory move: second rename keeps the original alias-preserved label frozen', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects', 'old', 'session-log'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'old', 'decisions'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'old', 'decisions', '0001.md'), '---\ntitle: d\n---\nx\n');
    writeFileSync(
      join(dir, 'projects', 'old', 'session-log', '2026-06.md'),
      '---\ntitle: log\n---\ntouched [[projects/old/decisions/0001]]\n',
    );
    run('rename.mjs', [`--hypo-dir=${dir}`, '--from=projects/old', '--to=projects/mid', '--apply']);
    run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/mid',
      '--to=projects/final',
      '--apply',
    ]);
    const log = readFileSync(join(dir, 'projects', 'final', 'session-log', '2026-06.md'), 'utf-8');
    assert.ok(
      log.includes('[[projects/final/decisions/0001|projects/old/decisions/0001]]'),
      `target follows to final, original label frozen: ${log}`,
    );
  });
});

test('directory move: dry-run reports but writes nothing', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--json',
    ]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.applied, false);
    assert.ok(out.links_rewritten > 0, 'dry-run still reports rewrites');
    assert.ok(existsSync(join(dir, 'projects', 'old', 'index.md')), 'dry-run does not move');
    assert.ok(!existsSync(join(dir, 'projects', 'new')), 'dry-run creates no destination');
    assert.ok(
      readFileSync(join(dir, 'pages', 'ext.md'), 'utf-8').includes('[[projects/old/index]]'),
      'dry-run does not rewrite',
    );
  });
});

// ── rename.mjs — crash-recovery marker (.cache/rename-in-progress.json) ───────
//
// The marker itself: written before the first inbound-link rewrite of an
// --apply run, removed right after the terminal renameSync. Pins the write/
// clear lifecycle, dry-run's no-write guarantee, fail-closed on a write
// failure, and (via KILL_RENAME) that a crash mid-loop leaves a genuinely
// partial, marker-recorded state a re-run converges from.

suite('rename.mjs — crash-recovery marker');

test('successful --apply clears the marker (page mode)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '---\ntitle: a\n---\nsee [[foo]].\n');
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(
      !existsSync(join(dir, '.cache', 'rename-in-progress.json')),
      'marker must be gone after a successful --apply',
    );
  });
});

test('successful --apply clears the marker (directory mode)', () => {
  withTmpDir((dir) => {
    dirFixture(dir);
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=projects/old',
      '--to=projects/new',
      '--apply',
      '--json',
    ]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(
      !existsSync(join(dir, '.cache', 'rename-in-progress.json')),
      'marker must be gone after a successful --apply',
    );
  });
});

test('dry-run writes no marker', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '---\ntitle: a\n---\nsee [[foo]].\n');
    const r = run('rename.mjs', [`--hypo-dir=${dir}`, '--from=foo', '--to=bar', '--json']);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(
      !existsSync(join(dir, '.cache', 'rename-in-progress.json')),
      'a dry-run (no --apply) must never write the marker',
    );
  });
});

// Fail-closed: if the marker itself cannot be written, --apply must not
// proceed to any other write — a detector with no reliable marker would be
// worse than no detector. Forces the failure by making .cache/ unwritable
// (pre-created so mkdirSync's recursive no-op succeeds, but atomicWrite's
// writeFileSync inside it cannot).
test('marker write failure is fail-closed: --apply aborts before any rewrite or move', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '---\ntitle: a\n---\nsee [[foo]].\n');
    chmodSync(join(dir, '.cache'), 0o500); // read+execute only — no write inside it
    try {
      const r = run('rename.mjs', [
        `--hypo-dir=${dir}`,
        '--from=foo',
        '--to=bar',
        '--apply',
        '--json',
      ]);
      assert.notEqual(
        r.status,
        0,
        `--apply must fail when the marker cannot be written: ${r.stdout}${r.stderr}`,
      );
      assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'foo.md must not have moved');
      assert.ok(!existsSync(join(dir, 'pages', 'bar.md')), 'bar.md must not exist');
      const a = readFileSync(join(dir, 'pages', 'a.md'), 'utf-8');
      assert.ok(a.includes('[[foo]]') && !a.includes('[[bar]]'), `a.md must be untouched: ${a}`);
    } finally {
      chmodSync(join(dir, '.cache'), 0o700); // let withTmpDir's cleanup remove it
    }
  });
});

// codex BLOCKER 1: writeRenameMarker used to atomicWrite unconditionally, so a
// SECOND rename's --apply would silently clobber a FIRST rename's still-open
// marker — erasing the only trace that the first rename is incomplete forever.
test('existing marker for a DIFFERENT rename → --apply refused, zero rewrites, zero moves', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(join(dir, 'pages', 'other.md'), '---\ntitle: other\n---\nother page\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '---\ntitle: a\n---\nsee [[foo]].\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/other.md',
        to: 'pages/moved.md',
        started_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(
      r.status,
      1,
      `a different in-progress marker must refuse --apply: ${r.stdout}${r.stderr}`,
    );
    assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'foo.md not moved (0 moves)');
    assert.ok(!existsSync(join(dir, 'pages', 'bar.md')), 'bar.md not created');
    const a = readFileSync(join(dir, 'pages', 'a.md'), 'utf-8');
    assert.ok(a.includes('[[foo]]') && !a.includes('[[bar]]'), '0 inbound rewrites happened');
    const marker = JSON.parse(
      readFileSync(join(dir, '.cache', 'rename-in-progress.json'), 'utf-8'),
    );
    assert.deepEqual(
      marker,
      {
        mode: 'page',
        from: 'pages/other.md',
        to: 'pages/moved.md',
        started_at: '2026-01-01T00:00:00.000Z',
      },
      "the OTHER rename's marker must survive untouched, not be overwritten",
    );
  });
});

// codex BLOCKER 1, convergence half: a marker naming THIS EXACT command is the
// legitimate re-run path the whole detector exists to let converge. If this
// regresses, the BLOCKER 1 fix broke the feature it was protecting.
test('existing marker for the SAME rename → --apply proceeds and converges (re-run path not blocked)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    writeFileSync(join(dir, 'pages', 'a.md'), '---\ntitle: a\n---\nsee [[foo]].\n');
    writeFileSync(
      join(dir, '.cache', 'rename-in-progress.json'),
      JSON.stringify({
        mode: 'page',
        from: 'pages/foo.md',
        to: 'pages/bar.md',
        started_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    const r = run('rename.mjs', [
      `--hypo-dir=${dir}`,
      '--from=foo',
      '--to=bar',
      '--apply',
      '--json',
    ]);
    assert.equal(
      r.status,
      0,
      `a same-command marker must not block the legitimate re-run: ${r.stdout}${r.stderr}`,
    );
    assert.ok(existsSync(join(dir, 'pages', 'bar.md')), 'bar.md exists');
    assert.ok(!existsSync(join(dir, 'pages', 'foo.md')), 'foo.md gone');
    assert.ok(
      readFileSync(join(dir, 'pages', 'a.md'), 'utf-8').includes('[[bar]]'),
      'inbound rewrite happened',
    );
    assert.ok(
      !existsSync(join(dir, '.cache', 'rename-in-progress.json')),
      'marker cleared after the same-command rename converges',
    );
  });
});

// codex BLOCKER 1, unreadable-marker half: "can't tell if it's the same
// command" must resolve to refuse, never to a silent overwrite.
test('existing marker that cannot be read (corrupt JSON, or missing from/to) → --apply refused', () => {
  for (const bad of ['{oops', JSON.stringify({ mode: 'page' })]) {
    withTmpDir((dir) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      mkdirSync(join(dir, '.cache'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
      writeFileSync(join(dir, '.cache', 'rename-in-progress.json'), bad);
      const r = run('rename.mjs', [
        `--hypo-dir=${dir}`,
        '--from=foo',
        '--to=bar',
        '--apply',
        '--json',
      ]);
      assert.equal(
        r.status,
        1,
        `an unreadable/incomplete marker must refuse --apply (cannot judge same-command): ${r.stdout}${r.stderr}`,
      );
      assert.ok(existsSync(join(dir, 'pages', 'foo.md')), 'foo.md not moved');
      assert.ok(!existsSync(join(dir, 'pages', 'bar.md')), 'bar.md not created');
    });
  }
});

// codex BLOCKER 2: renameSync is the terminal step; the marker is cleared only
// AFTER it. A crash bracketing that exact point (reusing the KILL_RENAME copy
// and its HYPO_TEST_KILL_PAGE_POST hook — see the "single-file renameSync
// converges" test above) leaves the marker present with `from` gone and `to`
// present: the rename is DONE, not stuck. doctor must tell the two apart —
// the old single-branch warn always said "re-run", which for this state is a
// command that fails (`--from` no longer resolves).
test('doctor.mjs after a post-renameSync crash: marker present + move done → "clean up the marker", not "re-run"', () => {
  withTmpDir((base) => {
    const wiki = join(base, 'wiki');
    const home = join(base, 'home');
    mkdirSync(join(wiki, 'pages'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(wiki, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');

    const cmd = [KILL_RENAME, `--hypo-dir=${wiki}`, '--from=foo', '--to=bar', '--apply', '--json'];
    const killed = spawnSync(process.execPath, cmd, {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, HYPO_TEST_KILL_PAGE_POST: '1' },
    });
    assert.equal(
      killed.signal,
      'SIGKILL',
      `expected the kill hook to fire post-rename: ${killed.stderr}`,
    );

    const markerPath = join(wiki, '.cache', 'rename-in-progress.json');
    assert.ok(existsSync(markerPath), 'the marker must survive a post-move crash');
    assert.ok(!existsSync(join(wiki, 'pages', 'foo.md')), 'from is gone (the move landed)');
    assert.ok(existsSync(join(wiki, 'pages', 'bar.md')), 'to exists (the move landed)');

    const doctorR = run('doctor.mjs', [`--hypo-dir=${wiki}`, '--json']);
    const checks = JSON.parse(doctorR.stdout);
    const check = checks.find((c) => c.label === 'Incomplete rename');
    assert.ok(check, 'Incomplete rename check not found');
    assert.equal(
      check.status,
      'warn',
      `stale-but-done marker must still warn (not pass): ${check.detail}`,
    );
    assert.ok(
      !/re-run/i.test(check.detail),
      `must NOT tell the user to re-run a command that would fail (--from no longer resolves): ${check.detail}`,
    );
    assert.ok(
      /delete|clean|remove/i.test(check.detail) && check.detail.includes(markerPath),
      `must point at deleting the stale marker: ${check.detail}`,
    );

    // Following doctor's own advice — deleting the marker — must leave a clean
    // report on the next run. No rerun of the rename itself: nothing to converge.
    rmSync(markerPath, { force: true });
    const doctorR2 = run('doctor.mjs', [`--hypo-dir=${wiki}`, '--json']);
    const check2 = JSON.parse(doctorR2.stdout).find((c) => c.label === 'Incomplete rename');
    assert.equal(
      check2.status,
      'pass',
      `following the guidance must leave doctor clean: ${check2.detail}`,
    );
  });
});

test('crash mid-rewrite-loop: marker records mode/from/to, page not yet moved, rewrite genuinely partial — re-run converges and clears the marker', () => {
  withTmpDir((base) => {
    const wiki = join(base, 'wiki');
    const home = join(base, 'home');
    mkdirSync(join(wiki, 'pages'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(wiki, 'pages', 'foo.md'), '---\ntitle: foo\n---\nfoo page\n');
    for (const name of ['a', 'b', 'c', 'd']) {
      writeFileSync(join(wiki, 'pages', `${name}.md`), `---\ntitle: ${name}\n---\nsee [[foo]].\n`);
    }
    const cmd = [KILL_RENAME, `--hypo-dir=${wiki}`, '--from=foo', '--to=bar', '--apply', '--json'];
    // atomicWrite call #1 is the marker itself; #2-#5 are the four inbound
    // rewrites. Killing after #3 lands the marker plus exactly two of the four
    // rewrites — a genuinely partial state — strictly before the terminal
    // renameSync, which does not go through atomicWrite at all.
    const killed = spawnSync(process.execPath, cmd, {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, HYPO_TEST_KILL_AFTER_N: '3' },
    });
    assert.equal(
      killed.signal,
      'SIGKILL',
      `expected the kill hook to fire: ${killed.stdout}${killed.stderr}`,
    );

    const markerPath = join(wiki, '.cache', 'rename-in-progress.json');
    assert.ok(existsSync(markerPath), 'marker must survive the crash');
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    assert.equal(marker.mode, 'page');
    assert.equal(marker.from, 'pages/foo.md');
    assert.equal(marker.to, 'pages/bar.md');
    assert.ok(marker.started_at, 'marker must record a started_at timestamp');

    assert.ok(existsSync(join(wiki, 'pages', 'foo.md')), 'foo.md must not have moved yet');
    assert.ok(!existsSync(join(wiki, 'pages', 'bar.md')), 'bar.md must not exist yet');
    const rewrittenCount = ['a', 'b', 'c', 'd'].filter((n) =>
      readFileSync(join(wiki, 'pages', `${n}.md`), 'utf-8').includes('[[bar]]'),
    ).length;
    assert.ok(
      rewrittenCount > 0 && rewrittenCount < 4,
      `rewrite must be genuinely partial, not all-or-nothing: ${rewrittenCount}/4 rewritten`,
    );

    // Re-running the SAME command (no kill env) must converge and clear the marker.
    const rerun = spawnSync(process.execPath, cmd, {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
    });
    assert.equal(rerun.status, 0, `re-run must converge: ${rerun.stdout}${rerun.stderr}`);
    assert.ok(existsSync(join(wiki, 'pages', 'bar.md')), 'bar.md must exist after re-run');
    assert.ok(!existsSync(join(wiki, 'pages', 'foo.md')), 'foo.md must be gone after re-run');
    for (const n of ['a', 'b', 'c', 'd']) {
      const body = readFileSync(join(wiki, 'pages', `${n}.md`), 'utf-8');
      assert.ok(body.includes('[[bar]]'), `${n}.md must be fully rewritten after re-run: ${body}`);
    }
    assert.ok(!existsSync(markerPath), 'marker must be removed after the re-run converges');
  });
});

// ── wikilink.mjs — shared resolver (IMPR-13) ──────────────────────────────────

suite('wikilink.mjs — shared resolver (IMPR-13)');

test('slugForms derives full / bare / dirRel', () => {
  assert.deepEqual(slugForms('pages/learnings/foo'), {
    full: 'pages/learnings/foo',
    bare: 'foo',
    dirRel: 'learnings/foo',
  });
  // no `/` → nothing to drop, dirRel is null (a page directly under a scan dir)
  assert.deepEqual(slugForms('hot'), { full: 'hot', bare: 'hot', dirRel: null });
});

test('extractWikilinks: target from [[t]] / [[t|alias]] / [[t#anchor]], code fences included (raw)', () => {
  // graph/crystallize variant is intentionally RAW — a [[link]] inside a fence
  // still counts (preserves pre-IMPR-13 edge/unlinked behavior). lint/rename use
  // their own strippers, so this must NOT strip.
  const md = 'x [[foo]] y [[bar/baz|label]] z [[qux#sec]]\n```\n[[in-fence]]\n```\n';
  assert.deepEqual(extractWikilinks(md), ['foo', 'bar/baz', 'qux', 'in-fence']);
});

test('collectPages presets enforce distinct traversal policy', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'sub'));
    mkdirSync(join(dir, '_drafts'));
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, 'a.md'), '');
    writeFileSync(join(dir, '_keep.md'), ''); // `_`-FILE: lint keeps it
    writeFileSync(join(dir, '.secret.md'), ''); // `.`-file: all skip
    writeFileSync(join(dir, 'sub', 'b.md'), '');
    writeFileSync(join(dir, '_drafts', 'c.md'), ''); // `_`-DIR: only lint skips
    writeFileSync(join(dir, '.hidden', 'h.md'), ''); // `.`-DIR: only crystallize skips
    symlinkSync(join(dir, 'a.md'), join(dir, 'link.md')); // symlink: only rename skips

    const names = (pages) =>
      pages.map((p) => basename((p.slug ?? p.rel).replace(/\\/g, '/'), '.md')).sort();

    // lint: `_`-dir skipped (no c), `_`-file kept, symlink + `.`-dir followed
    assert.deepEqual(names(collectPagesLint(dir, dir, [])), ['_keep', 'a', 'b', 'h', 'link']);
    // linkable: lint's set PLUS `_`-dir pages (c) — they are not linted but are
    // still real files, so a wikilink to one is not broken.
    assert.deepEqual(names(collectPagesLinkable(dir, dir, [])), [
      '_keep',
      'a',
      'b',
      'c',
      'h',
      'link',
    ]);
    // graph: most permissive — `_`-dir and `.`-dir and symlink all followed
    assert.deepEqual(names(collectPagesGraph(dir, dir, [])), ['_keep', 'a', 'b', 'c', 'h', 'link']);
    // rename: symlink skipped (security boundary), no link
    assert.deepEqual(names(collectPagesRename(dir, dir, [])), ['_keep', 'a', 'b', 'c', 'h']);
    // crystallize: `.`-dir skipped (no h), `.`-file skipped
    assert.deepEqual(names(collectPagesCrystallize(dir, dir, [])), [
      '_keep',
      'a',
      'b',
      'c',
      'link',
    ]);
  });
});

test('collectPages presets emit the historical output shape', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.md'), '');
    const norm = (s) => s.replace(/\\/g, '/');
    const [r] = collectPagesRename(dir, dir, []);
    assert.equal(norm(r.slug), 'sub/b');
    assert.equal(norm(r.rel), 'sub/b.md');
    assert.equal(r.bare, 'b');
    const [g] = collectPagesGraph(dir, dir, []);
    assert.equal(norm(g.slug), 'sub/b');
    assert.equal(g.bare, 'b');
    // lint/crystallize emit only { path, rel } (no slug/bare)
    const [l] = collectPagesLint(dir, dir, []);
    assert.equal(norm(l.rel), 'sub/b.md');
    assert.equal(l.slug, undefined);
  });
});
