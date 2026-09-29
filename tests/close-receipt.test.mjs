// tests/close-receipt.test.mjs, hooks/close-receipt.mjs (ISSUE-171 wave 1).
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not, that is what lets the runner shard.
//
// This wave covers only the reader/writer/verifier primitives themselves
// (readReceiptStrict, verifyEntriesInCommit, writeReceiptAtomic,
// invalidateCloseArtifacts). The writers that PRODUCE a receipt
// (crystallize-close-apply.mjs, --mark-session-closed) are a later wave and
// are not exercised here.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { test, suite } from './harness.mjs';
import {
  RECEIPT_SCHEMA_VERSION,
  CERT_CHECKPOINT,
  CERT_CLOSE_FILES,
  receiptPath,
  readReceiptStrict,
  verifyEntriesInCommit,
  writeReceiptAtomic,
  invalidateCloseArtifacts,
} from '../hooks/close-receipt.mjs';
import {
  sessionClosedMarkerPath,
  writeSessionClosedMarker,
  sanitizeSessionId,
} from '../hooks/hypo-shared.mjs';

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-close-receipt-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir, args, opts = {}) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', ...opts });
}

function gitRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t.test']);
  git(dir, ['config', 'user.name', 'test']);
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  // --allow-empty: several fixtures below just need SOME commit to exist
  // (a repo/session/schema-version check, not a file-content one) and never
  // write a file first.
  const res = git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  assert.equal(res.status, 0, `fixture commit failed: ${res.stderr}`);
  return git(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function toplevel(dir) {
  return git(dir, ['rev-parse', '--show-toplevel']).stdout.trim();
}

function hashOf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function blobOid(dir, commit, relPath) {
  const line = git(dir, ['ls-tree', '-r', '--full-tree', commit, '--', relPath]).stdout.trim();
  const m = /^(\d+)\s+\S+\s+([0-9a-f]{40,64})\t/.exec(line);
  assert.ok(m, `fixture: expected an ls-tree entry for ${relPath}, got: ${line}`);
  return { mode: m[1], oid: m[2] };
}

function baseReceipt(dir, sessionId, commit, entries) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    certification: CERT_CHECKPOINT,
    sessionId,
    repo: { toplevel: toplevel(dir), prefix: '' },
    commit,
    scope: { mode: 'project', projects: ['demo'] },
    entries,
    skipped: { lint: false, feedback: false },
    createdAt: new Date().toISOString(),
  };
}

suite('close-receipt.mjs, receiptPath');

test('receiptPath: a valid session id resolves under .cache/sessions/<id>/, an invalid one is null', () => {
  withTmpDir((dir) => {
    assert.equal(
      receiptPath(dir, 'sess-abc123'),
      join(dir, '.cache', 'sessions', 'sess-abc123', 'close-receipt.json'),
    );
    assert.equal(receiptPath(dir, 'has a space'), null, 'a shape isValidSessionId rejects is null');
    assert.equal(receiptPath(dir, 'has.dot'), null, 'a dot is rejected, same as isValidSessionId');
    assert.equal(receiptPath(dir, ''), null);
    assert.equal(receiptPath(dir, null), null);
  });
});

test('receiptPath: an id longer than 128 characters lands in the same directory sanitizeSessionId names (the rule hypo-shared.mjs uses for the session cache dir)', () => {
  withTmpDir((dir) => {
    const longId = 'a'.repeat(200);
    assert.equal(
      receiptPath(dir, longId),
      join(dir, '.cache', 'sessions', sanitizeSessionId(longId), 'close-receipt.json'),
    );
    assert.equal(sanitizeSessionId(longId).length, 128, 'fixture: the id must actually be capped');
    assert.notEqual(
      receiptPath(dir, longId),
      join(dir, '.cache', 'sessions', longId, 'close-receipt.json'),
    );
  });
});

suite('close-receipt.mjs, readReceiptStrict: missing vs. invalid vs. valid');

test('readReceiptStrict: no file at all is missing, never invalid', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.md'), '# a\n');
    commitAll(dir, 'init');
    assert.deepEqual(readReceiptStrict(dir, 'sess-none'), { status: 'missing' });
  });
});

test('readReceiptStrict: an invalid session id is invalid, not missing (receiptPath itself refuses it)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    commitAll(dir, 'init');
    assert.deepEqual(readReceiptStrict(dir, 'bad.id'), {
      status: 'invalid',
      reason: 'invalid-session-id',
    });
  });
});

test('readReceiptStrict: corrupt JSON is invalid, not silently missing', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    commitAll(dir, 'init');
    const p = receiptPath(dir, 'sess-corrupt');
    mkdirSync(join(dir, '.cache', 'sessions', 'sess-corrupt'), { recursive: true });
    writeFileSync(p, '{ this is not json');
    assert.deepEqual(readReceiptStrict(dir, 'sess-corrupt'), {
      status: 'invalid',
      reason: 'parse-error',
    });
  });
});

test('readReceiptStrict: a receipt filed under a DIFFERENT session id than the one the file itself carries is invalid', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const commit = commitAll(dir, 'init');
    const receipt = baseReceipt(dir, 'sess-owner', commit, []);
    const w = writeReceiptAtomic(dir, 'sess-owner', receipt);
    assert.equal(w.ok, true, JSON.stringify(w));
    // Copy the exact bytes into a DIFFERENT session's directory, the file
    // path says 'sess-other' but the JSON body still says 'sess-owner'.
    mkdirSync(join(dir, '.cache', 'sessions', 'sess-other'), { recursive: true });
    writeFileSync(receiptPath(dir, 'sess-other'), readFileSync(w.path, 'utf-8'));
    assert.deepEqual(readReceiptStrict(dir, 'sess-other'), {
      status: 'invalid',
      reason: 'session-id-mismatch',
    });
  });
});

test('readReceiptStrict: an unknown schemaVersion is invalid, never assumed forward-compatible', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const commit = commitAll(dir, 'init');
    const receipt = { ...baseReceipt(dir, 'sess-v', commit, []), schemaVersion: 999 };
    writeReceiptAtomic(dir, 'sess-v', receipt);
    assert.deepEqual(readReceiptStrict(dir, 'sess-v'), {
      status: 'invalid',
      reason: 'schema-version-mismatch',
    });
  });
});

test('readReceiptStrict: repo.toplevel not matching this git repo is invalid (a receipt copied from another vault)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const commit = commitAll(dir, 'init');
    const receipt = baseReceipt(dir, 'sess-repo', commit, []);
    receipt.repo.toplevel = '/nonexistent/other/vault';
    writeReceiptAtomic(dir, 'sess-repo', receipt);
    assert.deepEqual(readReceiptStrict(dir, 'sess-repo'), {
      status: 'invalid',
      reason: 'repo-mismatch',
    });
  });
});

test('readReceiptStrict: a commit dropped from branch history (reset --hard) is commit-unreachable', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    commitAll(dir, 'init');
    writeFileSync(join(dir, 'b.md'), '# b\n');
    const droppedCommit = commitAll(dir, 'second');
    git(dir, ['reset', '--hard', 'HEAD~1']); // droppedCommit is no longer on any branch
    const receipt = baseReceipt(dir, 'sess-dropped', droppedCommit, []);
    writeReceiptAtomic(dir, 'sess-dropped', receipt);
    assert.deepEqual(readReceiptStrict(dir, 'sess-dropped'), {
      status: 'invalid',
      reason: 'commit-unreachable',
    });
  });
});

test('readReceiptStrict: a well-formed receipt whose commit is HEAD itself is valid', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const commit = commitAll(dir, 'init');
    const receipt = baseReceipt(dir, 'sess-valid', commit, [
      { path: 'a.md', kind: 'absent', expected: {} },
    ]);
    writeReceiptAtomic(dir, 'sess-valid', receipt);
    const result = readReceiptStrict(dir, 'sess-valid');
    assert.equal(result.status, 'valid', JSON.stringify(result));
    assert.equal(result.receipt.sessionId, 'sess-valid');
  });
});

test('readReceiptStrict: a 64-hex commit id from a sha256 repository is valid, and its entries verify', () => {
  withTmpDir((dir) => {
    const init = git(dir, ['init', '-q', '--object-format=sha256']);
    assert.equal(init.status, 0, `fixture: this git cannot create a sha256 repo: ${init.stderr}`);
    git(dir, ['config', 'user.email', 't@t.test']);
    git(dir, ['config', 'user.name', 'test']);
    writeFileSync(join(dir, 'a.md'), '# a\n');
    const commit = commitAll(dir, 'init');
    assert.equal(commit.length, 64, `fixture: expected a sha256 commit id, got ${commit}`);
    const { mode, oid } = blobOid(dir, commit, 'a.md');
    assert.equal(oid.length, 64);
    const entries = [{ path: 'a.md', kind: 'overwrite', expected: { blob: oid, mode } }];
    writeReceiptAtomic(dir, 'sess-sha256', baseReceipt(dir, 'sess-sha256', commit, entries));
    const result = readReceiptStrict(dir, 'sess-sha256');
    assert.equal(result.status, 'valid', JSON.stringify(result));
    assert.deepEqual(verifyEntriesInCommit(dir, commit, entries), { ok: true, mismatches: [] });
  });
});

test('readReceiptStrict: a commit that is neither 40 nor 64 hex is malformed-commit', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    commitAll(dir, 'init');
    for (const bad of ['a'.repeat(41), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(40)]) {
      writeReceiptAtomic(dir, 'sess-oid', baseReceipt(dir, 'sess-oid', bad, []));
      assert.deepEqual(
        readReceiptStrict(dir, 'sess-oid'),
        { status: 'invalid', reason: 'malformed-commit' },
        `commit ${bad.length} chars must be rejected`,
      );
    }
  });
});

suite(
  'close-receipt.mjs, verifyEntriesInCommit: what distinguishes a match from each mismatch reason',
);

test('overwrite: byte-identical content passes; a body change under the SAME path is a blob-mismatch', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'state.md'), '# v1\n');
    const commit = commitAll(dir, 'v1');
    const { mode, oid } = blobOid(dir, commit, 'state.md');

    const okEntries = [{ path: 'state.md', kind: 'overwrite', expected: { blob: oid, mode } }];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, okEntries), { ok: true, mismatches: [] });

    const wrongBlob = [
      { path: 'state.md', kind: 'overwrite', expected: { blob: '0'.repeat(40), mode } },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, wrongBlob), {
      ok: false,
      mismatches: [{ path: 'state.md', reason: 'blob-mismatch' }],
    });
  });
});

test('mode: an executable bit difference is a mode-mismatch even though the bytes are identical (d)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'script.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(dir, 'script.sh'), 0o755);
    const commit = commitAll(dir, 'executable');
    const { mode, oid } = blobOid(dir, commit, 'script.sh');
    assert.equal(mode, '100755', `fixture: expected an executable mode, got ${mode}`);

    const entries = [
      { path: 'script.sh', kind: 'overwrite', expected: { blob: oid, mode: '100644' } },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, entries), {
      ok: false,
      mismatches: [{ path: 'script.sh', reason: 'mode-mismatch' }],
    });
  });
});

test('overwrite bytesSha256: a blob differing only by an invalid-UTF-8 byte is a blob-mismatch (raw bytes, never decoded) (c)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const good = Buffer.from([0x23, 0x20, 0xe2, 0x9c, 0x93, 0x0a]); // "# ✓\n", valid UTF-8
    writeFileSync(join(dir, 'raw.md'), good);
    const commit = commitAll(dir, 'good-utf8');
    const { oid, mode } = blobOid(dir, commit, 'raw.md');

    // A single invalid continuation byte in place of the valid one. Decoding
    // either to a JS string before hashing can collapse both to the same
    // replacement-character string; hashing the raw Buffer must not.
    const bad = Buffer.from([0x23, 0x20, 0xe2, 0x28, 0xa1, 0x0a]);
    const badSha = hashOf(bad);

    const okEntries = [
      { path: 'raw.md', kind: 'overwrite', expected: { bytesSha256: hashOf(good), mode } },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, okEntries), { ok: true, mismatches: [] });

    const wrongEntries = [
      { path: 'raw.md', kind: 'overwrite', expected: { bytesSha256: badSha, mode } },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, wrongEntries), {
      ok: false,
      mismatches: [{ path: 'raw.md', reason: 'blob-mismatch' }],
    });
    void oid;
  });
});

test('append: same heading, a DIFFERENT body underneath, is append-incomplete (a)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'log.md'), '## [2026-09-29] session | demo\n\ncommitted body\n');
    const commit = commitAll(dir, 'log');

    const matching = [
      {
        path: 'log.md',
        kind: 'append',
        expected: { entryBlocks: ['## [2026-09-29] session | demo\n\ncommitted body\n'] },
      },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, matching), { ok: true, mismatches: [] });

    const differentBody = [
      {
        path: 'log.md',
        kind: 'append',
        expected: { entryBlocks: ['## [2026-09-29] session | demo\n\nEXPECTED body\n'] },
      },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, differentBody), {
      ok: false,
      mismatches: [{ path: 'log.md', reason: 'append-incomplete' }],
    });
  });
});

test('append: two expected blocks, only one committed, is append-incomplete (b)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(
      join(dir, 'log.md'),
      '## [2026-09-29] session | demo\n\nblock one\n\n## [2026-09-29] session | other\n\nblock two\n',
    );
    const commit = commitAll(dir, 'log-two-blocks');

    const bothPresent = [
      {
        path: 'log.md',
        kind: 'append',
        expected: {
          entryBlocks: [
            '## [2026-09-29] session | demo\n\nblock one\n',
            '## [2026-09-29] session | other\n\nblock two\n',
          ],
        },
      },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, bothPresent), { ok: true, mismatches: [] });

    const oneMissing = [
      {
        path: 'log.md',
        kind: 'append',
        expected: {
          entryBlocks: [
            '## [2026-09-29] session | demo\n\nblock one\n',
            '## [2026-09-29] session | THIRD\n\nnever committed\n',
          ],
        },
      },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, oneMissing), {
      ok: false,
      mismatches: [{ path: 'log.md', reason: 'append-incomplete' }],
    });
  });
});

test('schema-pending: a committed Pending tag is recognized; an unregistered one is schema-pending-missing', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(
      join(dir, 'SCHEMA.md'),
      '## Tag Vocabulary\n\n### Pending (auto-registered)\n\nsome prose\n\n**Pending**: `new-tag`, `other-tag`\n',
    );
    const commit = commitAll(dir, 'schema');

    const present = [
      { path: 'SCHEMA.md', kind: 'schema-pending', expected: { tags: ['new-tag'] } },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, present), { ok: true, mismatches: [] });

    const missing = [
      { path: 'SCHEMA.md', kind: 'schema-pending', expected: { tags: ['never-registered'] } },
    ];
    assert.deepEqual(verifyEntriesInCommit(dir, commit, missing), {
      ok: false,
      mismatches: [{ path: 'SCHEMA.md', reason: 'schema-pending-missing' }],
    });
  });
});

test('absent: a path genuinely missing from the commit passes; a path that unexpectedly exists is expected-absent-but-present', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'present.md'), '# here\n');
    const commit = commitAll(dir, 'absent-fixture');

    assert.deepEqual(
      verifyEntriesInCommit(dir, commit, [
        { path: 'never-created.md', kind: 'absent', expected: {} },
      ]),
      { ok: true, mismatches: [] },
    );
    assert.deepEqual(
      verifyEntriesInCommit(dir, commit, [{ path: 'present.md', kind: 'absent', expected: {} }]),
      { ok: false, mismatches: [{ path: 'present.md', reason: 'expected-absent-but-present' }] },
    );
  });
});

test('create: a path expected present but missing from the commit is missing-entry', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, 'a.md'), '# a\n');
    const commit = commitAll(dir, 'create-fixture');
    assert.deepEqual(
      verifyEntriesInCommit(dir, commit, [
        { path: 'never-existed.md', kind: 'create', expected: { mode: '100644' } },
      ]),
      { ok: false, mismatches: [{ path: 'never-existed.md', reason: 'missing-entry' }] },
    );
  });
});

test('schema-pending: a **Pending**: line outside the Tag Vocabulary / Pending subsection proves nothing', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(
      join(dir, 'SCHEMA.md'),
      [
        '**Pending**: `before-vocab`',
        '',
        '## Tag Vocabulary',
        '',
        '### Pending (auto-registered)',
        '',
        '**Pending**: `real-tag`',
        '',
        '### Notes',
        '',
        '**Pending**: `sibling-h3-tag`',
        '',
        '## Later',
        '',
        '**Pending**: `later-h2-tag`',
        '',
      ].join('\n'),
    );
    const commit = commitAll(dir, 'schema');
    const check = (tag) =>
      verifyEntriesInCommit(dir, commit, [
        { path: 'SCHEMA.md', kind: 'schema-pending', expected: { tags: [tag] } },
      ]);
    assert.deepEqual(check('real-tag'), { ok: true, mismatches: [] });
    for (const stray of ['before-vocab', 'sibling-h3-tag', 'later-h2-tag']) {
      assert.deepEqual(
        check(stray),
        { ok: false, mismatches: [{ path: 'SCHEMA.md', reason: 'schema-pending-missing' }] },
        `${stray} sits outside the Pending subsection and must not count`,
      );
    }

    // The subsection ends at the next H3: an empty Pending block followed by a
    // sibling H3 that carries a data line registers nothing.
    writeFileSync(
      join(dir, 'SCHEMA.md'),
      '## Tag Vocabulary\n\n### Pending (auto-registered)\n\nprose only\n\n### Notes\n\n**Pending**: `sibling-h3-tag`\n',
    );
    const emptyPendingCommit = commitAll(dir, 'schema-empty-pending');
    assert.deepEqual(
      verifyEntriesInCommit(dir, emptyPendingCommit, [
        { path: 'SCHEMA.md', kind: 'schema-pending', expected: { tags: ['sibling-h3-tag'] } },
      ]),
      { ok: false, mismatches: [{ path: 'SCHEMA.md', reason: 'schema-pending-missing' }] },
    );
  });
});

suite('close-receipt.mjs, verifyEntriesInCommit: a vault nested inside a larger repository');

// The vault is `<repo>/vault/`, so `git rev-parse --show-prefix` is `vault/`.
// A receipt path is relative to the vault; a lookup that resolved it against
// the repository root would report every entry as missing.
function withNestedVault(fn) {
  withTmpDir((repo) => {
    gitRepo(repo);
    const vault = join(repo, 'vault');
    mkdirSync(vault);
    fn(repo, vault);
  });
}

test('nested vault: vault-relative overwrite, append, and absent entries verify against the commit', () => {
  withNestedVault((repo, vault) => {
    writeFileSync(join(vault, 'state.md'), '# v1\n');
    mkdirSync(join(vault, 'projects'));
    writeFileSync(join(vault, 'projects', 'log.md'), '## entry\n\nbody\n');
    writeFileSync(join(repo, 'state.md'), '# a DIFFERENT file at the repo root\n');
    const commit = commitAll(repo, 'nested');
    assert.equal(git(vault, ['rev-parse', '--show-prefix']).stdout.trim(), 'vault/');

    const oid = git(vault, ['rev-parse', `${commit}:./state.md`]).stdout.trim();
    const result = verifyEntriesInCommit(vault, commit, [
      { path: 'state.md', kind: 'overwrite', expected: { blob: oid, mode: '100644' } },
      {
        path: 'projects/log.md',
        kind: 'append',
        expected: { entryBlocks: ['## entry\n\nbody\n'] },
      },
      { path: 'never-there.md', kind: 'absent', expected: {} },
    ]);
    assert.deepEqual(result, { ok: true, mismatches: [] });

    // The repo-root file of the same name is a different blob: the lookup must
    // be the vault's, not the root's.
    const rootOid = git(repo, ['rev-parse', `${commit}:state.md`]).stdout.trim();
    assert.notEqual(rootOid, oid, 'fixture: the two state.md files must differ');
    assert.deepEqual(
      verifyEntriesInCommit(vault, commit, [
        { path: 'state.md', kind: 'overwrite', expected: { blob: rootOid, mode: '100644' } },
      ]),
      { ok: false, mismatches: [{ path: 'state.md', reason: 'blob-mismatch' }] },
    );
  });
});

test('nested vault: a non-ASCII path is matched byte-exact (no quotepath escaping), and the receipt reads as valid', () => {
  withNestedVault((repo, vault) => {
    const rel = '프로젝트/상태.md';
    mkdirSync(join(vault, '프로젝트'));
    writeFileSync(join(vault, rel), '# 상태\n');
    const commit = commitAll(repo, 'non-ascii');
    const oid = git(vault, ['rev-parse', `${commit}:./${rel}`]).stdout.trim();
    const entries = [{ path: rel, kind: 'overwrite', expected: { blob: oid, mode: '100644' } }];
    assert.deepEqual(verifyEntriesInCommit(vault, commit, entries), { ok: true, mismatches: [] });

    writeReceiptAtomic(vault, 'sess-nested', baseReceipt(vault, 'sess-nested', commit, entries));
    const read = readReceiptStrict(vault, 'sess-nested');
    assert.equal(read.status, 'valid', JSON.stringify(read));
  });
});

suite('close-receipt.mjs, writeReceiptAtomic / invalidateCloseArtifacts');

test('writeReceiptAtomic: writes, and a re-read reproduces the exact receipt; an invalid session id refuses', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const commit = commitAll(dir, 'init');
    const receipt = baseReceipt(dir, 'sess-write', commit, []);
    const res = writeReceiptAtomic(dir, 'sess-write', receipt);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(JSON.parse(readFileSync(res.path, 'utf-8')), receipt);

    const bad = writeReceiptAtomic(dir, 'bad id', receipt);
    assert.deepEqual(bad, { ok: false, reason: 'invalid-session-id' });
  });
});

test('invalidateCloseArtifacts: absent files are a no-op success (nothing filed under this session yet)', () => {
  withTmpDir((dir) => {
    assert.deepEqual(invalidateCloseArtifacts(dir, 'sess-nothing-yet'), { ok: true });
  });
});

test('invalidateCloseArtifacts: renames the compat marker and the receipt, marker FIRST, both landing under .invalidated-<ts>', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    const commit = commitAll(dir, 'init');
    const sessionId = 'sess-invalidate';
    writeSessionClosedMarker(dir, sessionId, { project: 'demo' });
    const receipt = baseReceipt(dir, sessionId, commit, []);
    const written = writeReceiptAtomic(dir, sessionId, receipt);
    assert.equal(written.ok, true);

    const markerBefore = sessionClosedMarkerPath(dir, sessionId);
    const receiptBefore = receiptPath(dir, sessionId);

    const res = invalidateCloseArtifacts(dir, sessionId);
    assert.deepEqual(res, { ok: true }, JSON.stringify(res));

    assert.equal(existsSync(markerBefore), false, 'the marker must be gone from its original name');
    assert.equal(
      existsSync(receiptBefore),
      false,
      'the receipt must be gone from its original name',
    );
    const cacheEntries = readdirSync(join(dir, '.cache'));
    assert.ok(
      cacheEntries.some((f) => f.startsWith('session-closed-') && f.includes('.invalidated-')),
      `expected an invalidated marker file, got: ${JSON.stringify(cacheEntries)}`,
    );
    const sessionDirEntries = readdirSync(join(dir, '.cache', 'sessions', sessionId));
    assert.ok(
      sessionDirEntries.some((f) => f.startsWith('close-receipt.json.invalidated-')),
      `expected an invalidated receipt file, got: ${JSON.stringify(sessionDirEntries)}`,
    );
    // A NEW marker written after invalidation must not collide with, or be
    // shadowed by, the renamed-away one; readSessionClosedMarker must find
    // nothing at the canonical path until a fresh one is written there.
  });
});
