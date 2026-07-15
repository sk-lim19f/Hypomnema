// tests/proposal-base.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashContent as bsHashContent,
  hashFile as bsHashFile,
  basePath as bsBasePath,
  snapshotBase,
  readBaseEntry,
  advanceBase,
  advanceBaseForWrite,
  overwriteTargets,
} from '../hooks/base-store.mjs';
import {
  writeProposal as psWriteProposal,
  listProposals as psListProposals,
  readProposal as psReadProposal,
  deleteProposal as psDeleteProposal,
  makeProposalId as psMakeProposalId,
  proposalsDir as psProposalsDir,
  hashProposalContent,
  consumeChallenge,
  readChallenge as psReadChallenge,
} from '../hooks/proposal-store.mjs';
// proposal.mjs guards its CLI dispatch behind isMain(), so importing these pure
// functions + result-returning actors for unit tests does not run the CLI.
import {
  planApplyAction,
  classifyFreshness,
  resolveTargetPath as propResolveTargetPath,
  applyProposal,
  challengeProposals,
  resolveProposals,
  discardProposal,
  listPending,
} from '../scripts/proposal.mjs';
import { test, testAsync, suite } from './harness.mjs';
import {
  HOME,
  HOOKS,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  gitHead,
  hasTypedUserApproval,
  payloadForCleanWiki,
  resolveTranscriptBySessionId,
  run,
  runApply,
  runHook,
  seedCloseTranscript,
  withTmpDir,
  withWiki,
} from './helpers.mjs';

// ── FEAT-11 T6: proposal artifacts + proposal-pending close contract ──────────
// These drive the REAL close path. An OVERWRITE drift withholds the target AND
// parks its bytes in `.cache/proposals/`; an APPEND conflict withholds but parks
// NOTHING (transient — the next close re-appends).

// The direct unit surface of the store: round-trip, supersede-by-target (matched
// on the parsed `target` field, not the filename slug), idempotent reuse, delete,
// and malformed-artifact tolerance on the read side.
suite('FEAT-11 T6 — proposal artifacts + proposal-pending close contract');

test('FEAT-11 T6: proposal-store round-trip, supersede-by-target, idempotent reuse, delete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-ps-'));
  try {
    const a = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'c1',
      proposedContent: 'AAA',
      sessionId: 's1',
      device: 'dev1',
    });
    assert.ok(a.id && a.path, 'writeProposal returns an id + path');
    assert.equal(psListProposals(dir).length, 1);
    const read = psReadProposal(dir, a.id);
    assert.equal(read.proposedContent, 'AAA');
    assert.equal(read.target, 'hot.md');
    assert.equal(read.baseHash, 'b1');

    // Same target, NEW bytes → the old artifact is superseded (one remains).
    const b = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'c2',
      proposedContent: 'BBB',
      sessionId: 's1',
      device: 'dev1',
    });
    assert.notEqual(b.id, a.id, 'a genuinely different withhold mints a new id');
    const list2 = psListProposals(dir);
    assert.equal(list2.length, 1, 'same-target supersede keeps exactly one artifact');
    assert.equal(list2[0].proposedContent, 'BBB');

    // A DIFFERENT target coexists — supersede is per-target, not global.
    psWriteProposal(dir, {
      target: join('pages', 'open-questions.md'),
      baseHash: null,
      currentAtProposalHash: 'x',
      proposedContent: 'Q',
      sessionId: 's1',
      device: 'dev1',
    });
    assert.equal(psListProposals(dir).length, 2, 'a different target is not superseded');

    // Identical fields → id reuse, no second artifact.
    const b2 = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'c2',
      proposedContent: 'BBB',
      sessionId: 's1',
      device: 'dev1',
    });
    assert.equal(b2.id, b.id, 'identical re-write reuses the existing id');
    assert.equal(psListProposals(dir).length, 2, 'idempotent re-write adds no artifact');

    assert.equal(psDeleteProposal(dir, b.id), true);
    assert.equal(psReadProposal(dir, b.id), null);
    assert.equal(psListProposals(dir).length, 1);

    // A corrupt artifact is skipped by listing, never fatal.
    writeFileSync(join(psProposalsDir(dir), 'junk.json'), '{ not json');
    assert.equal(psListProposals(dir).length, 1, 'malformed artifact is skipped, not fatal');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Supersede is scoped to the writing session. Two concurrent sessions that both
// withhold bytes for ONE target each hold a distinct payload, and the artifact is
// its only durable copy (crystallize never puts withheld bytes on disk). Deleting
// across sessions destroys the first session's work — the very clobber this gate
// exists to prevent. Regression for the target-only supersede that shipped in T6.
test('FEAT-11 T6: a concurrent session does not supersede another session proposal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-ps-'));
  try {
    // Session A and session B both drift off the same base for the same target.
    const a = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'cX',
      proposedContent: 'A-BYTES',
      sessionId: 's-A',
      device: 'dev1',
    });
    const b = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'cX',
      proposedContent: 'B-BYTES',
      sessionId: 's-B',
      device: 'dev1',
    });

    assert.notEqual(b.id, a.id, 'a different session mints its own artifact');
    assert.equal(psListProposals(dir).length, 2, "session B must not delete session A's payload");
    assert.equal(psReadProposal(dir, a.id)?.proposedContent, 'A-BYTES', "A's bytes survive");
    assert.equal(psReadProposal(dir, b.id)?.proposedContent, 'B-BYTES', "B's bytes survive");

    // Session A re-closes with new bytes: it replaces its OWN earlier attempt only.
    const a2 = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'cY',
      proposedContent: 'A-BYTES-2',
      sessionId: 's-A',
      device: 'dev1',
    });
    assert.equal(psReadProposal(dir, a.id), null, "A's own earlier attempt is superseded");
    assert.equal(psReadProposal(dir, b.id)?.proposedContent, 'B-BYTES', "B survives A's re-close");
    assert.equal(psListProposals(dir).length, 2, 'one artifact per (target, session)');
    assert.equal(psReadProposal(dir, a2.id)?.proposedContent, 'A-BYTES-2');

    // An unknown session id proves ownership of nothing, so it deletes nothing.
    const anon = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'cZ',
      proposedContent: 'ANON',
      sessionId: null,
      device: 'dev1',
    });
    assert.equal(psListProposals(dir).length, 3, 'a null session id supersedes nothing');
    assert.equal(psReadProposal(dir, anon.id)?.proposedContent, 'ANON');
    assert.equal(psReadProposal(dir, a2.id)?.proposedContent, 'A-BYTES-2');
    assert.equal(psReadProposal(dir, b.id)?.proposedContent, 'B-BYTES');

    // The artifact body is hand-editable and only its `id` is validated, so a
    // non-string owner must not coerce into a match: `["s-B"]` stringifies to
    // "s-B" and would otherwise let session s-B delete it.
    const spoofPath = psReadProposal(dir, b.id) && join(psProposalsDir(dir), `${b.id}.json`);
    const spoofBody = JSON.parse(readFileSync(spoofPath, 'utf-8'));
    spoofBody.sessionId = ['s-B'];
    writeFileSync(spoofPath, JSON.stringify(spoofBody, null, 2));
    psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'cW',
      proposedContent: 'B-BYTES-3',
      sessionId: 's-B',
      device: 'dev1',
    });
    assert.equal(
      psReadProposal(dir, b.id)?.proposedContent,
      'B-BYTES',
      'a non-string owner is unidentifiable, so it is never superseded',
    );

    // The reverse of the null case above: a KNOWN session writing the same target
    // must not sweep up the anonymous artifact either. Ownership runs both ways.
    psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b1',
      currentAtProposalHash: 'cV',
      proposedContent: 'A-BYTES-3',
      sessionId: 's-A',
      device: 'dev1',
    });
    assert.equal(
      psReadProposal(dir, anon.id)?.proposedContent,
      'ANON',
      'a named session does not supersede an artifact with no owner',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-11 T6: readProposal/deleteProposal reject path-traversal ids (no escape from the store)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-ps-'));
  try {
    // A sentinel two levels above the proposals dir: `../../hot` from
    // <dir>/.cache/proposals resolves to <dir>/hot.json. The T7 CLI takes an id
    // straight off the command line, so an unvalidated id here would read or
    // unlink this file outside the store.
    const sentinel = join(dir, 'hot.json');
    writeFileSync(sentinel, 'DO NOT DELETE');
    for (const bad of ['../../hot', '../hot', '..', '/etc/passwd', 'a/b', '']) {
      assert.equal(psReadProposal(dir, bad), null, `readProposal rejects ${JSON.stringify(bad)}`);
      assert.equal(
        psDeleteProposal(dir, bad),
        false,
        `deleteProposal rejects ${JSON.stringify(bad)}`,
      );
    }
    assert.ok(existsSync(sentinel), 'a file outside the store is never unlinked');
    assert.equal(readFileSync(sentinel, 'utf-8'), 'DO NOT DELETE', 'sentinel bytes untouched');
    // A normally generated id still round-trips (no regression on the happy path).
    const saved = psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: null,
      currentAtProposalHash: null,
      proposedContent: 'x',
      sessionId: 's',
      device: 'd',
    });
    assert.ok(psReadProposal(dir, saved.id), 'a valid generated id still reads back');
    assert.equal(psDeleteProposal(dir, saved.id), true, 'a valid generated id still deletes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-11 T6: a symlinked proposals dir cannot escape the vault (read/delete)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-ps-'));
  const outside = mkdtempSync(join(tmpdir(), 'hypo-outside-'));
  try {
    // Point .cache/proposals at a directory OUTSIDE the vault and drop a
    // validly-named artifact inside it. A lexical guard would let a valid id
    // read/delete through the symlink; realpath containment must reject it.
    mkdirSync(join(dir, '.cache'), { recursive: true });
    symlinkSync(outside, join(dir, '.cache', 'proposals'));
    const sentinel = join(outside, 'safeid.json');
    writeFileSync(sentinel, JSON.stringify({ id: 'safeid', target: 'x' }));
    assert.equal(psReadProposal(dir, 'safeid'), null, 'no read through a symlinked store');
    assert.equal(psDeleteProposal(dir, 'safeid'), false, 'no delete through a symlinked store');
    assert.ok(existsSync(sentinel), 'the file outside the vault survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('FEAT-11 T6: makeProposalId is filename-safe and carries the target slug', () => {
  const id = psMakeProposalId('2026-07-09T12:34:56.789Z', join('projects', 'p', 'hot.md'));
  assert.ok(/^[A-Za-z0-9-]+$/.test(id), `id must be filename-safe: ${id}`);
  assert.ok(id.includes('projects-p-hot-md'), `id must carry the target slug: ${id}`);
});

// spec success criterion: an overwrite conflict parks a `.cache/proposals/`
// artifact carrying every required field, the close reports proposal-pending, and
// the marker is NOT written.
test('FEAT-11 T6: overwrite conflict parks an artifact with all required fields, marker withheld', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    // No base snapshot for this session → the overwrite guard sees base-unknown and
    // withholds rootHot (hot.md) rather than clobber. Only rootHot differs from disk;
    // the other overwrite fields are byte-identical (idempotent skip, no conflict).
    payload.rootHot = { content: `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot DRIFTED\n` };
    const r = runApply(dir, payload, { sessionId: 's-t6-artifact' });
    assert.notEqual(
      r.status,
      0,
      `a withheld overwrite must exit non-zero: ${r.stdout}\n${r.stderr}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'proposal-pending');
    assert.equal(out.markerWritten, false, 'the marker must NOT be written on a withheld close');
    assert.equal(
      out.proposals.length,
      1,
      `exactly one proposal expected: ${JSON.stringify(out.proposals)}`,
    );
    assert.equal(out.proposals[0].target, 'hot.md');

    const dirp = join(dir, '.cache', 'proposals');
    const files = readdirSync(dirp).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, `exactly one artifact on disk: ${files}`);
    const art = JSON.parse(readFileSync(join(dirp, files[0]), 'utf-8'));
    for (const k of [
      'id',
      'target',
      'baseHash',
      'currentAtProposalHash',
      'proposedContent',
      'sessionId',
      'device',
      'createdAt',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(art, k),
        `artifact must carry ${k}: ${JSON.stringify(art)}`,
      );
    }
    assert.equal(art.target, 'hot.md');
    assert.equal(art.sessionId, 's-t6-artifact');
    assert.ok(art.device, 'device must be stamped from currentDevice()');
    assert.ok(art.proposedContent.includes('DRIFTED'), 'proposedContent holds the withheld bytes');
    assert.ok(
      !readFileSync(join(dir, 'hot.md'), 'utf-8').includes('DRIFTED'),
      'the withheld target must stay unclobbered on disk',
    );
  });
});

// spec success criterion: partial conflict is per-target — non-drifted overwrites
// write directly, only the drifted one parks, and the result says so honestly.
test('FEAT-11 T6: partial conflict — non-drifted overwrites write, drifted one parks', () => {
  withWiki(null, (dir, today) => {
    const sid = 's-t6-partial';
    // Snapshot the base from the committed clean tree.
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    // Another writer drifts ONE target (project hot.md) AFTER the snapshot.
    const projHot = join(dir, 'projects', 'test-project', 'hot.md');
    writeFileSync(
      projHot,
      `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot DRIFTED BY OTHER\n`,
    );
    const driftedBytes = readFileSync(projHot, 'utf-8');

    const payload = payloadForCleanWiki(dir, today);
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- new next\n`,
    };
    payload.rootHot = {
      content: readFileSync(join(dir, 'hot.md'), 'utf-8').replace('# Hot', '# Hot UPDATED'),
    };
    payload.projectHot = {
      content: `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot FROM PAYLOAD\n`,
    };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.notEqual(r.status, 0, `a partial conflict must exit non-zero: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'proposal-pending');
    assert.equal(out.partialConflict, true, `partialConflict expected: ${r.stdout}`);
    assert.ok(
      Array.isArray(out.appliedUncommitted) && out.appliedUncommitted.length > 0,
      'appliedUncommitted lists the writes that landed but are not committed',
    );
    assert.equal(out.proposals.length, 1, `exactly one proposal: ${JSON.stringify(out.proposals)}`);
    assert.equal(out.proposals[0].target, join('projects', 'test-project', 'hot.md'));
    assert.ok(
      readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8').includes(
        'new next',
      ),
      'the non-drifted sessionState was written directly',
    );
    assert.ok(
      readFileSync(join(dir, 'hot.md'), 'utf-8').includes('UPDATED'),
      'the non-drifted rootHot was written directly',
    );
    assert.equal(
      readFileSync(projHot, 'utf-8'),
      driftedBytes,
      'the drifted target keeps the other writer bytes — the payload must not clobber it',
    );
    assert.equal(out.markerWritten, false);
  });
});

// spec success criterion (fail-closed): a proposal-store WRITE failure must not
// write the target, must surface loudly, and must stage proposal-store-failed.
test('FEAT-11 T6: proposal-store write failure → proposal-store-failed, fail-loud, target unwritten', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.rootHot = { content: `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot DRIFTED\n` };
    // Occupy `.cache/proposals` with a regular FILE so writeProposal's mkdir fails.
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(join(dir, '.cache', 'proposals'), 'blocker');
    const r = runApply(dir, payload, { sessionId: 's-t6-failloud' });
    assert.notEqual(r.status, 0, `store failure must exit non-zero: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'proposal-store-failed');
    assert.ok(
      Array.isArray(out.proposalStoreFailures) && out.proposalStoreFailures.length === 1,
      `proposalStoreFailures expected: ${r.stdout}`,
    );
    assert.equal(out.proposalStoreFailures[0].target, 'hot.md');
    assert.equal(out.proposals.length, 0, 'no proposal is recorded when the store write fails');
    assert.ok(/PROPOSAL STORE FAILED/.test(r.stderr), `loud stderr expected: ${r.stderr}`);
    assert.ok(
      !readFileSync(join(dir, 'hot.md'), 'utf-8').includes('DRIFTED'),
      'the target must stay unwritten when its proposal could not be parked',
    );
  });
});

// supersede across closes: a drift BETWEEN two closes changes currentAtProposalHash,
// forcing a genuinely new artifact that must supersede (not accumulate beside) the
// first — otherwise every close would leave a stale artifact and inflate the count.
test('FEAT-11 T6: repeated closes on a re-drifting target keep exactly one artifact', () => {
  withWiki(null, (dir, today) => {
    const sid = 's-t6-supersede';
    const rootHotPath = join(dir, 'hot.md');
    const dirp = join(dir, '.cache', 'proposals');

    const p1 = payloadForCleanWiki(dir, today);
    p1.rootHot = { content: `${readFileSync(rootHotPath, 'utf-8')}\n<!-- close1 -->\n` };
    const r1 = runApply(dir, p1, { sessionId: sid });
    assert.notEqual(r1.status, 0);
    assert.equal(
      readdirSync(dirp).filter((f) => f.endsWith('.json')).length,
      1,
      'one artifact after close 1',
    );
    const id1 = JSON.parse(r1.stdout).proposals[0].id;

    // Another writer drifts the disk so the next close withholds FRESH bytes.
    writeFileSync(rootHotPath, `${readFileSync(rootHotPath, 'utf-8')}\n<!-- other drift -->\n`);
    const p2 = payloadForCleanWiki(dir, today);
    p2.rootHot = { content: `${readFileSync(rootHotPath, 'utf-8')}\n<!-- close2 -->\n` };
    const r2 = runApply(dir, p2, { sessionId: sid });
    assert.notEqual(r2.status, 0);
    const files2 = readdirSync(dirp).filter((f) => f.endsWith('.json'));
    assert.equal(files2.length, 1, `still one artifact after close 2 (supersede): ${files2}`);
    const art = JSON.parse(readFileSync(join(dirp, files2[0]), 'utf-8'));
    assert.ok(
      art.proposedContent.includes('close2'),
      'the surviving artifact is the newest withhold',
    );
    assert.notEqual(
      JSON.parse(r2.stdout).proposals[0].id,
      id1,
      'a genuinely new withhold gets a new id (supersede, not reuse)',
    );
  });
});

// idempotent-reuse (the OTHER supersede path): an identical re-close — same base,
// same disk, same bytes — reuses the existing id and writes no second artifact.
test('FEAT-11 T6: identical re-close reuses the artifact id (idempotent, one file)', () => {
  withWiki(null, (dir, today) => {
    const sid = 's-t6-idem';
    const payload = payloadForCleanWiki(dir, today);
    payload.rootHot = {
      content: readFileSync(join(dir, 'hot.md'), 'utf-8').replace('# Hot', '# Hot DRIFT'),
    };
    const r1 = runApply(dir, payload, { sessionId: sid });
    const r2 = runApply(dir, payload, { sessionId: sid });
    const dirp = join(dir, '.cache', 'proposals');
    assert.equal(
      readdirSync(dirp).filter((f) => f.endsWith('.json')).length,
      1,
      'an identical re-close must not add a second artifact',
    );
    assert.equal(
      JSON.parse(r1.stdout).proposals[0].id,
      JSON.parse(r2.stdout).proposals[0].id,
      'the same id is reused for an identical withhold',
    );
  });
});

// D1: an append lock-timeout blocks the close (proposal-pending) but parks NO
// artifact — proposals stays empty and `.cache/proposals/` has no files.
test('FEAT-11 T6: append lock-timeout makes NO artifact (proposals empty, still pending)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] append-only lockout\n\nbody\n` };
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(`${shard}.lock`, '');
    process.env.HYPO_APPEND_LOCK_TIMEOUT_MS = '300';
    let r;
    try {
      r = runApply(dir, payload, { sessionId: 's-t6-append-only' });
    } finally {
      delete process.env.HYPO_APPEND_LOCK_TIMEOUT_MS;
      try {
        unlinkSync(`${shard}.lock`);
      } catch {
        /* already gone */
      }
    }
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'proposal-pending');
    assert.deepEqual(
      out.proposals,
      [],
      `an append conflict must not create a proposal: ${JSON.stringify(out.proposals)}`,
    );
    const dirp = join(dir, '.cache', 'proposals');
    const files = existsSync(dirp) ? readdirSync(dirp).filter((f) => f.endsWith('.json')) : [];
    assert.equal(files.length, 0, `no artifact must be written for an append conflict: ${files}`);
  });
});

// ── FEAT-11 T7: proposal CLI (list / apply / discard) ────────────────────────
// The human-in-the-loop gate. Every path to a target write runs through a fresh
// diff, a TTY gate, an explicit confirm, and a post-confirm re-read. The pure
// decision functions are table-tested; the actors are driven in-process with
// injected TTY / prompt / clock seams.

// A stream stand-in that accumulates writes, so a test can assert on what the
// actor emitted without a real stdout/stderr.
suite('FEAT-11 T7 — proposal CLI (list / apply / discard)');

function capStream() {
  const chunks = [];
  return { write: (s) => chunks.push(String(s)), text: () => chunks.join('') };
}

test('FEAT-11 T7: planApplyAction table (unreadable aborts regardless of confirm)', () => {
  assert.deepEqual(planApplyAction({ confirmed: true, freshness: 'unreadable' }), {
    action: 'abort',
    reason: 'target-unreadable',
  });
  assert.deepEqual(planApplyAction({ confirmed: false, freshness: 'unreadable' }), {
    action: 'abort',
    reason: 'target-unreadable',
  });
  assert.deepEqual(planApplyAction({ confirmed: false, freshness: 'fresh' }), {
    action: 'abort',
    reason: 'not-confirmed',
  });
  assert.deepEqual(planApplyAction({ confirmed: true, freshness: 'fresh' }), {
    action: 'apply',
    reason: null,
    warned: false,
  });
  assert.deepEqual(planApplyAction({ confirmed: true, freshness: 'drifted' }), {
    action: 'apply',
    reason: null,
    warned: true,
  });
});

test('FEAT-11 T7: classifyFreshness (fresh / drifted / unreadable / absent-null / absent-nonnull)', () => {
  const h = bsHashContent('AAA');
  assert.equal(classifyFreshness({ current: 'AAA', currentAtProposalHash: h }), 'fresh');
  assert.equal(classifyFreshness({ current: 'BBB', currentAtProposalHash: h }), 'drifted');
  assert.equal(classifyFreshness({ current: undefined, currentAtProposalHash: h }), 'unreadable');
  // absent now + null at park → fresh (nothing on disk to clobber).
  assert.equal(classifyFreshness({ current: null, currentAtProposalHash: null }), 'fresh');
  // absent now + a real park hash → drifted (the file was there at park, gone now).
  assert.equal(classifyFreshness({ current: null, currentAtProposalHash: h }), 'drifted');
});

test('FEAT-11 T7: resolveTargetPath rejects traversal, absolute, empty, non-string; passes a clean rel path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const ok = propResolveTargetPath(dir, join('pages', 'note.md'));
    assert.ok(ok && ok.endsWith(join('pages', 'note.md')), `clean rel path resolves: ${ok}`);
    assert.equal(
      propResolveTargetPath(dir, join('..', '..', '.zshrc')),
      null,
      'traversal rejected',
    );
    assert.equal(propResolveTargetPath(dir, join('pages', '..', '..', 'x')), null, '.. segment');
    assert.equal(propResolveTargetPath(dir, '/etc/passwd'), null, 'absolute rejected');
    assert.equal(propResolveTargetPath(dir, ''), null, 'empty rejected');
    assert.equal(propResolveTargetPath(dir, 123), null, 'non-string rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-11 T7: resolveTargetPath fails closed on a symlinked target and a vault-escaping ancestor', () => {
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  const outside = mkdtempSync(join(tmpdir(), 'hypo-t7-out-'));
  try {
    // Target file itself a symlink (pointing INSIDE the vault so the ancestor
    // check passes and the lstat branch is what rejects it): the diff would
    // follow the link but atomicWrite would replace it, so refuse.
    writeFileSync(join(dir, 'real.md'), 'real');
    symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'));
    assert.equal(propResolveTargetPath(dir, 'link.md'), null, 'symlinked target rejected');

    // A parent dir that is a symlink OUT of the vault: a rename would land
    // outside, so the nearest-ancestor realpath check must reject it.
    symlinkSync(outside, join(dir, 'sub'));
    assert.equal(
      propResolveTargetPath(dir, join('sub', 'note.md')),
      null,
      'escaping-ancestor symlink rejected',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('FEAT-11 T7: no bypass tokens in scripts/proposal.mjs (no auto-apply, no env override)', () => {
  const src = readFileSync(join(SCRIPTS, 'proposal.mjs'), 'utf-8');
  const hits = src.match(/--yes|process\.env/g);
  assert.equal(hits, null, `proposal.mjs must carry no bypass token, found: ${hits}`);
});

test('FEAT-11 T7: no hook imports the apply path (no unattended auto-apply)', () => {
  const importers = readdirSync(HOOKS)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => /proposal\.mjs/.test(readFileSync(join(HOOKS, f), 'utf-8')));
  assert.deepEqual(
    importers,
    [],
    `hooks must never reach the apply path (fires unattended): ${importers.join(', ')}`,
  );
});

// Applying one id no longer empties the target's queue: a concurrent session's
// proposal for the same file survives (one artifact per (target, session)), and the
// write we just made drifted it. A silent "✓ applied" would read as done.
await testAsync(
  'FEAT-11 T7: apply warns that a concurrent session proposal still targets the file, and keeps it',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'ORIGINAL');
      const rel = join('pages', 'note.md');
      const mine = psWriteProposal(dir, {
        target: rel,
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'FROM SESSION A',
        sessionId: 's-A',
        device: 'd7',
      });
      const theirs = psWriteProposal(dir, {
        target: rel,
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'FROM SESSION B',
        sessionId: 's-B',
        device: 'd7',
      });

      const err = capStream();
      const r = await applyProposal(
        { hypoDir: dir, id: mine.id },
        {
          isTTY: true,
          stdout: capStream(),
          stderr: err,
          prompt: async () => `apply ${mine.id}`,
          now: () => '2026-07-12T00:00:00.000Z',
        },
      );

      assert.equal(r.ok, true, `apply should succeed: ${JSON.stringify(r)}`);
      assert.equal(r.siblingsPending, 1, "session B's proposal is still pending");
      assert.equal(readFileSync(target, 'utf-8'), 'FROM SESSION A', 'the applied bytes landed');
      assert.equal(
        psReadProposal(dir, theirs.id)?.proposedContent,
        'FROM SESSION B',
        'apply never deletes another session payload',
      );
      assert.match(err.text(), /still target/, 'the leftover is announced, not silent');
      assert.ok(err.text().includes(theirs.id), 'the warning names the leftover id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: non-TTY apply is refused: target bytes unchanged, proposal preserved',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'ORIGINAL');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'PROPOSED',
        sessionId: 's7',
        device: 'd7',
      });
      const out = capStream();
      const err = capStream();
      const r = await applyProposal(
        { hypoDir: dir, id: saved.id },
        { isTTY: false, stdout: out, stderr: err, prompt: async () => `apply ${saved.id}` },
      );
      assert.equal(r.ok, false);
      assert.notEqual(r.code, 0, 'non-TTY apply exits non-zero');
      assert.equal(readFileSync(target, 'utf-8'), 'ORIGINAL', 'target bytes untouched');
      assert.ok(psReadProposal(dir, saved.id), 'proposal preserved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: apply success: whole-file replace, proposal removed, one audit line with pre-apply hash',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'ORIGINAL');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'PROPOSED CONTENT',
        sessionId: 's7',
        device: 'd7',
      });
      const out = capStream();
      const r = await applyProposal(
        { hypoDir: dir, id: saved.id },
        {
          isTTY: true,
          stdout: out,
          stderr: capStream(),
          prompt: async () => `apply ${saved.id}`,
          now: () => '2026-07-10T00:00:00.000Z',
        },
      );
      assert.equal(r.ok, true, `apply should succeed: ${JSON.stringify(r)}`);
      assert.equal(r.code, 0);
      assert.equal(readFileSync(target, 'utf-8'), 'PROPOSED CONTENT', 'target replaced wholesale');
      assert.equal(psReadProposal(dir, saved.id), null, 'proposal artifact removed');

      const logPath = join(psProposalsDir(dir), 'applied.log');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      assert.equal(lines.length, 1, 'exactly one audit line');
      const rec = JSON.parse(lines[0]);
      assert.equal(rec.id, saved.id);
      assert.equal(rec.target, join('pages', 'note.md'));
      assert.equal(
        rec.currentHash,
        bsHashContent('ORIGINAL'),
        'currentHash is the pre-apply disk hash',
      );
      assert.equal(rec.appliedAt, '2026-07-10T00:00:00.000Z', 'appliedAt from injected clock');
      // The audit log must NOT leak into the proposal listing (.json filter).
      assert.equal(listProposalsCount(dir), 0, 'applied.log is not counted as a proposal');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: freshness warning path: a re-drifted target warns, then applies on confirm',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'ORIGINAL');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'PROPOSED',
        sessionId: 's7',
        device: 'd7',
      });
      // Someone drifts the target AFTER it was parked.
      writeFileSync(target, 'DRIFTED SINCE PARK');
      const out = capStream();
      const r = await applyProposal(
        { hypoDir: dir, id: saved.id },
        {
          isTTY: true,
          stdout: out,
          stderr: capStream(),
          prompt: async () => `apply ${saved.id}`,
          now: () => '2026-07-10T00:00:00.000Z',
        },
      );
      assert.equal(r.ok, true, 'a confirmed drift still applies');
      assert.equal(r.warned, true, 'the result records that a drift warning was surfaced');
      assert.match(out.text(), /changed since this proposal was parked/, 'drift warning printed');
      assert.equal(readFileSync(target, 'utf-8'), 'PROPOSED', 'target replaced after review');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: concurrent mutation during the prompt aborts: target keeps its bytes, proposal preserved',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'ORIGINAL');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'PROPOSED',
        sessionId: 's7',
        device: 'd7',
      });
      const err = capStream();
      const r = await applyProposal(
        { hypoDir: dir, id: saved.id },
        {
          isTTY: true,
          stdout: capStream(),
          stderr: err,
          // A concurrent close writes the target while the human is at the prompt.
          prompt: async () => {
            writeFileSync(target, 'CONCURRENT WRITE');
            return `apply ${saved.id}`;
          },
        },
      );
      assert.equal(r.ok, false, 'apply must abort on a post-confirm change');
      assert.equal(r.reason, 'concurrent-mutation');
      assert.equal(
        readFileSync(target, 'utf-8'),
        'CONCURRENT WRITE',
        'the concurrent bytes are preserved, not overwritten',
      );
      assert.ok(psReadProposal(dir, saved.id), 'proposal preserved for re-apply');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: apply abort (no confirm) preserves target and proposal, exits non-zero',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'ORIGINAL');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: bsHashContent('ORIGINAL'),
        proposedContent: 'PROPOSED',
        sessionId: 's7',
        device: 'd7',
      });
      const r = await applyProposal(
        { hypoDir: dir, id: saved.id },
        { isTTY: true, stdout: capStream(), stderr: capStream(), prompt: async () => 'no' },
      );
      assert.equal(r.ok, false);
      assert.notEqual(r.code, 0);
      assert.equal(r.reason, 'not-confirmed');
      assert.equal(readFileSync(target, 'utf-8'), 'ORIGINAL', 'target preserved');
      assert.ok(psReadProposal(dir, saved.id), 'proposal preserved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('FEAT-11 T7: discard removes the proposal and leaves the target unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const target = join(dir, 'pages', 'note.md');
    writeFileSync(target, 'ORIGINAL');
    const saved = psWriteProposal(dir, {
      target: join('pages', 'note.md'),
      baseHash: null,
      currentAtProposalHash: bsHashContent('ORIGINAL'),
      proposedContent: 'PROPOSED',
      sessionId: 's7',
      device: 'd7',
    });
    const r = discardProposal(
      { hypoDir: dir, id: saved.id },
      { stdout: capStream(), stderr: capStream() },
    );
    assert.equal(r.ok, true);
    assert.equal(psReadProposal(dir, saved.id), null, 'proposal removed');
    assert.equal(readFileSync(target, 'utf-8'), 'ORIGINAL', 'target unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FEAT-11 T7: list is oldest-first and reports the empty case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  try {
    const empty = capStream();
    const r0 = listPending({ hypoDir: dir }, { stdout: empty });
    assert.equal(r0.count, 0);
    assert.match(empty.text(), /no pending proposals/);

    psWriteProposal(dir, {
      target: 'a.md',
      baseHash: null,
      currentAtProposalHash: null,
      proposedContent: 'A',
      sessionId: 's7',
      device: 'd7',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    psWriteProposal(dir, {
      target: 'b.md',
      baseHash: null,
      currentAtProposalHash: null,
      proposedContent: 'B',
      sessionId: 's7',
      device: 'd7',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    const j = capStream();
    const r = listPending({ hypoDir: dir }, { stdout: j, json: true });
    assert.equal(r.count, 2);
    const arr = JSON.parse(j.text());
    assert.deepEqual(
      arr.map((x) => x.target),
      ['b.md', 'a.md'],
      'sorted oldest createdAt first',
    );
    // Assert the identifying fields too: a listing that dropped `id` or `createdAt`
    // would still satisfy a target-only check while being useless to `apply`.
    for (const entry of arr) {
      assert.ok(entry.id && typeof entry.id === 'string', 'each entry carries its id');
      assert.ok(entry.createdAt, 'each entry carries its createdAt');
    }
    assert.deepEqual(
      arr.map((x) => x.createdAt),
      ['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync('FEAT-11 T7: a successful apply leaves the session base untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  try {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const rel = join('pages', 'note.md');
    const target = join(dir, rel);
    writeFileSync(target, 'ORIGINAL');
    const sessionId = 'sess-apply-base';
    snapshotBase(dir, sessionId, [rel]);
    const before = readBaseEntry(dir, sessionId, rel);
    assert.equal(before.hash, bsHashContent('ORIGINAL'), 'base captured the pre-apply bytes');

    const saved = psWriteProposal(dir, {
      target: rel,
      baseHash: bsHashContent('ORIGINAL'),
      currentAtProposalHash: hashProposalContent('ORIGINAL'),
      proposedContent: 'PROPOSED',
      sessionId,
      device: 'd',
    });
    const res = await applyProposal(
      { hypoDir: dir, id: saved.id },
      {
        isTTY: true,
        stdout: capStream(),
        stderr: capStream(),
        now: () => '2026-07-10T00:00:00.000Z',
        prompt: () => `apply ${saved.id}`,
      },
    );
    assert.equal(res.ok, true);
    assert.equal(readFileSync(target, 'utf-8'), 'PROPOSED');

    // apply is an out-of-band human override, not a session write, so the base
    // this session observed at start must not move. Advancing it would let the
    // same session's next close overwrite the page without ever re-checking it.
    // Breaking the apply-then-reclose loop is crystallize's idempotent-skip
    // (disk === payload), not a base advance here.
    assert.deepEqual(readBaseEntry(dir, sessionId, rel), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The three attacks a pre-commit review reproduced against the first cut of this
// CLI. Each one exited 0 while either destroying the withheld bytes or writing
// outside the vault, so each is pinned here rather than only fixed.

test('FEAT-11 T7: a target pointing back into the proposal store is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  try {
    const saved = psWriteProposal(dir, {
      target: join('pages', 'note.md'),
      baseHash: null,
      currentAtProposalHash: null,
      proposedContent: 'WITHHELD',
      sessionId: 's',
      device: 'd',
    });
    // Applying this would write the bytes over the artifact, then unlink it.
    assert.equal(propResolveTargetPath(dir, join('.cache', 'proposals', `${saved.id}.json`)), null);
    assert.equal(propResolveTargetPath(dir, join('.cache', 'proposals', 'applied.log')), null);
    assert.equal(propResolveTargetPath(dir, join('.cache', 'proposals')), null);
    // A normal target is unaffected by the store guard.
    assert.ok(propResolveTargetPath(dir, join('pages', 'note.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync(
  'FEAT-11 T7: an ancestor that becomes a symlink during the prompt aborts the write',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    const outside = mkdtempSync(join(tmpdir(), 'hypo-t7-outside-'));
    try {
      const saved = psWriteProposal(dir, {
        target: join('new', 'leaf.md'),
        baseHash: null,
        currentAtProposalHash: null, // target absent at park time
        proposedContent: 'WITHHELD',
        sessionId: 's',
        device: 'd',
      });
      const err = capStream();
      const res = await applyProposal(
        { hypoDir: dir, id: saved.id },
        {
          isTTY: true,
          stdout: capStream(),
          stderr: err,
          now: () => '2026-07-10T00:00:00.000Z',
          // A concurrent process plants the escape while the human reads the diff.
          prompt: () => {
            symlinkSync(outside, join(dir, 'new'), 'dir');
            return `apply ${saved.id}`;
          },
        },
      );
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'unsafe-target');
      assert.equal(
        existsSync(join(outside, 'leaf.md')),
        false,
        'nothing written outside the vault',
      );
      assert.equal(psReadProposal(dir, saved.id)?.id, saved.id, 'proposal preserved');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: a symlinked audit log is refused and the proposal survives',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    const outside = mkdtempSync(join(tmpdir(), 'hypo-t7-outside-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'note.md'), 'ORIGINAL');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: hashProposalContent('ORIGINAL'),
        proposedContent: 'PROPOSED',
        sessionId: 's',
        device: 'd',
      });
      const sentinel = join(outside, 'stolen.log');
      symlinkSync(sentinel, join(dir, '.cache', 'proposals', 'applied.log'));

      const err = capStream();
      const res = await applyProposal(
        { hypoDir: dir, id: saved.id },
        {
          isTTY: true,
          stdout: capStream(),
          stderr: err,
          now: () => '2026-07-10T00:00:00.000Z',
          prompt: () => `apply ${saved.id}`,
        },
      );
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'log-failed');
      assert.equal(existsSync(sentinel), false, 'audit record never left the vault');
      assert.equal(psReadProposal(dir, saved.id)?.id, saved.id, 'proposal kept for a retry');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: the diff is rendered against current disk bytes, not the parked base',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      const target = join(dir, 'pages', 'note.md');
      writeFileSync(target, 'BASE_BYTES');
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: hashProposalContent('BASE_BYTES'),
        currentAtProposalHash: hashProposalContent('BASE_BYTES'),
        proposedContent: 'PROPOSED_BYTES',
        sessionId: 's',
        device: 'd',
      });
      // Someone else wrote the page after the artifact was parked.
      writeFileSync(target, 'OTHER_SESSION_BYTES');

      const out = capStream();
      await applyProposal(
        { hypoDir: dir, id: saved.id },
        { isTTY: false, stdout: out, stderr: capStream() },
      );
      const shown = out.text();
      assert.match(shown, /- OTHER_SESSION_BYTES/, 'removed side is the CURRENT disk bytes');
      assert.match(shown, /\+ PROPOSED_BYTES/);
      assert.doesNotMatch(shown, /BASE_BYTES$/m, 'the parked base is never the diff baseline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  'FEAT-11 T7: terminal control characters in the artifact never reach the diff output',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'note.md'), 'ORIGINAL');
      const esc = String.fromCharCode(27);
      // U+009B is the C1 CSI: a single byte that introduces a control sequence
      // exactly like ESC-[ does. A C0-only sanitizer would let it through.
      const c1csi = String.fromCharCode(0x9b);
      const saved = psWriteProposal(dir, {
        target: join('pages', 'note.md'),
        baseHash: null,
        currentAtProposalHash: hashProposalContent('ORIGINAL'),
        proposedContent: `${esc}[2J${esc}[H${c1csi}2J SPOOFED`,
        sessionId: 's',
        device: 'd',
      });
      const out = capStream();
      await applyProposal(
        { hypoDir: dir, id: saved.id },
        { isTTY: false, stdout: out, stderr: capStream() },
      );
      assert.doesNotMatch(out.text(), new RegExp(esc), 'no ESC byte reaches the terminal');
      assert.doesNotMatch(out.text(), new RegExp(c1csi), 'no C1 CSI byte reaches the terminal');
      assert.match(out.text(), /SPOOFED/, 'the text itself is still shown, just neutralized');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('FEAT-11 T7: an in-vault symlink alias into the store is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t7-'));
  try {
    const saved = psWriteProposal(dir, {
      target: join('pages', 'note.md'),
      baseHash: null,
      currentAtProposalHash: null,
      proposedContent: 'WITHHELD',
      sessionId: 's',
      device: 'd',
    });
    // `alias/` resolves to the store, so `alias/<id>.json` is lexically outside the
    // store yet the real write lands on the artifact itself and would destroy it.
    symlinkSync(join(dir, '.cache', 'proposals'), join(dir, 'alias'), 'dir');
    assert.equal(propResolveTargetPath(dir, join('alias', `${saved.id}.json`)), null);
    assert.equal(propResolveTargetPath(dir, join('alias', 'applied.log')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Count proposals via the store the CLI reads through, so the assertion tracks the
// exact `.json`-only scan (applied.log's `.log` suffix must never inflate it).
function listProposalsCount(dir) {
  return psListProposals(dir).length;
}

// appendIfAbsent data-loss fix: a PERSISTENT read error (EACCES/EISDIR/...) on an
// append target that already has content must hard-fail the close, not silently
// fall back to content='' and let atomicWrite's rename replace the file with just
// the new entry. Unlike the lock-timeout case above (transient — the next close
// retries), a persistent read error never resolves on retry, so this must throw
// past the ELOCKTIMEOUT-only catch and crash the close instead of masking data
// loss as success. root ignores the file's own permission bits (can still read
// with mode 0), so this repro is skipped there — same rationale as the
// withFileLock un-removable-stale-lock test above.
test('append read failure (EACCES) hard-fails the close, log.md bytes preserved (FEAT-11 T5)', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const logPath = join(dir, 'log.md');
    const before = readFileSync(logPath, 'utf-8');
    chmodSync(logPath, 0o000); // unreadable, but the parent dir stays writable
    let r;
    try {
      r = runApply(dir, payload, { sessionId: 's-unreadable-log' });
    } finally {
      chmodSync(logPath, 0o644); // restore so cleanup (rmSync) can remove the tree
    }
    assert.notEqual(
      r.status,
      0,
      `an unreadable log.md must hard-fail, not exit 0: ${r.stdout}\n${r.stderr}`,
    );
    const after = readFileSync(logPath, 'utf-8');
    assert.equal(
      after,
      before,
      'log.md must be byte-untouched — a swallowed read error must not let atomicWrite replace it with just the new entry',
    );
  });
});

// Sibling regression pin for the ENOENT branch of the same catch: a target that
// simply does not exist yet (the common case, not the read-failure case above)
// must still be created normally — the fix must not turn "no file yet" into a
// hard-fail.
test('append target absent (no prior log.md) → close still creates it (ENOENT stays tolerated)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    rmSync(join(dir, 'log.md'));
    const r = runApply(dir, payload, { sessionId: 's-absent-log' });
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `expected ok:true: ${r.stdout}`);
    assert.ok(existsSync(join(dir, 'log.md')), 'log.md must be created fresh when absent');
    assert.ok(
      readFileSync(join(dir, 'log.md'), 'utf-8').includes(payload.log.entry.trim()),
      'the freshly created log.md must carry the new entry',
    );
  });
});

test('clean-wiki payload → ok:true, new entries appended (apply dedup is exact-entry, not date-based)', () => {
  withWiki(null, (dir, today) => {
    // payloadForCleanWiki uses NEW entry text ("re-applied"), not the fixture's
    // existing "test session" entry. Apply must append the new entries — using
    // the freshness gate as a dedup signal would silently drop a legitimate
    // same-day second close.
    const r = runApply(dir, payloadForCleanWiki(dir, today));
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    const appliedSlots = out.applied.join(' ');
    assert.ok(
      /sessionLog/.test(appliedSlots),
      `sessionLog should be appended (new entry): ${JSON.stringify(out)}`,
    );
    assert.ok(
      /log \(log\.md\)/.test(appliedSlots),
      `log.md should be appended (new entry): ${JSON.stringify(out)}`,
    );
  });
});

test('idempotent: re-running same payload produces no new bytes (file mtimes unchanged)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    const r1 = runApply(dir, payload);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);
    const sl = join(dir, 'projects', 'test-project', 'session-log', `${today.slice(0, 7)}.md`);
    const sizeBefore = readFileSync(sl, 'utf-8').length;
    const logBefore = readFileSync(join(dir, 'log.md'), 'utf-8').length;

    const r2 = runApply(dir, payload);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);
    const sizeAfter = readFileSync(sl, 'utf-8').length;
    const logAfter = readFileSync(join(dir, 'log.md'), 'utf-8').length;
    assert.equal(
      sizeAfter,
      sizeBefore,
      'session-log must not grow on re-apply (idempotent append)',
    );
    assert.equal(logAfter, logBefore, 'log.md must not grow on re-apply (idempotent append)');
  });
});

// PRAC-17: the test above measures the LEGACY MONTHLY shard path; the apply code
// writes the DAILY shard for a distinct entry. This dedicated test targets the
// daily shard and pins both (a) the new audit frontmatter (device present once,
// no session_id when --session-id is not passed) and (b) byte-equal idempotency
// on the daily shard — the gap the monthly-path test cannot catch.
test('PRAC-17: daily shard seeds device frontmatter once + byte-equal on re-apply', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] prac17 daily entry\n\nbody\n` };
    const r1 = runApply(dir, payload);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    assert.ok(existsSync(shard), 'daily shard must be created');
    const fm1 = readFileSync(shard, 'utf-8');
    // device is always seeded; appears exactly once (in the seeded header).
    assert.ok(/\ndevice: \S+\n/.test(fm1), `shard frontmatter must carry device: ${fm1}`);
    assert.equal((fm1.match(/^device: /gm) || []).length, 1, 'device must appear exactly once');
    // The close-authority gate now requires --session-id on every apply (runApply's
    // default seeds a throwaway authorized one), so the shard always carries a
    // session_id — unlike the old legacy path where omitting it left the field absent.
    assert.ok(/^session_id: \S+$/m.test(fm1), `shard frontmatter must carry a session_id: ${fm1}`);
    // Post-apply lint stays clean with the extra fields (lint requires only title+type).
    assert.equal(JSON.parse(r1.stdout).ok, true, `post-apply lint must be clean: ${r1.stdout}`);

    const r2 = runApply(dir, payload);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);
    assert.equal(
      readFileSync(shard, 'utf-8'),
      fm1,
      'daily shard must be byte-equal on re-apply (frontmatter not regenerated)',
    );
  });
});

test('PRAC-17: --session-id seeds the session_id frontmatter line on the daily shard', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] prac17 session-id entry\n\nbody\n` };
    const sid = '0c9d1234-aaaa-bbbb-cccc-0123456789ab';
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(r.status, 0, `apply failed: ${r.stdout}\n${r.stderr}`);
    const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
    const fm = readFileSync(shard, 'utf-8');
    assert.ok(
      new RegExp(`^session_id: ${sid}$`, 'm').test(fm),
      `shard frontmatter must carry the passed session_id: ${fm}`,
    );
    assert.ok(/^device: \S+$/m.test(fm), `device must still be present: ${fm}`);
    assert.equal(JSON.parse(r.stdout).ok, true, `post-apply lint must be clean: ${r.stdout}`);
  });
});

// PRAC-17: the OTHER write site — the per-session index.jsonl. This store is
// local-only (.cache/ gitignored) and accurate for every session, so it pins
// that the Stop hook stamps `device` on every recorded entry.
test('PRAC-17: hypo-session-record stamps device on the index.jsonl entry', () => {
  withTmpDir((dir) => {
    const r = runHook(
      'hypo-session-record.mjs',
      { session_id: 'rec-prac17', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/work' },
      { HYPO_DIR: dir },
    );
    assert.equal(r.status, 0, `hook failed: ${r.stderr}`);
    const idx = join(dir, '.cache', 'sessions', 'index.jsonl');
    assert.ok(existsSync(idx), 'index.jsonl must be written');
    const entry = JSON.parse(readFileSync(idx, 'utf-8').trim().split('\n').pop());
    assert.equal(entry.session_id, 'rec-prac17');
    assert.ok(
      typeof entry.device === 'string' && entry.device.length > 0,
      `device must be recorded on the index entry: ${JSON.stringify(entry)}`,
    );
  });
});

// currentDevice() routing: both audit write sites must now emit the SAME device
// string that the visibility filter reads at lookup time. Proven by overriding
// HYPO_DEVICE and asserting the written stamp equals it — one assert per write
// site so a divergence on either path is caught.
test('scope: index.jsonl device stamp is routed through currentDevice (HYPO_DEVICE honored)', () => {
  withTmpDir((dir) => {
    const r = runHook(
      'hypo-session-record.mjs',
      { session_id: 'rec-dev', transcript_path: '/tmp/t.jsonl', cwd: '/tmp/work' },
      { HYPO_DIR: dir, HYPO_DEVICE: 'dev-index' },
    );
    assert.equal(r.status, 0, `hook failed: ${r.stderr}`);
    const idx = join(dir, '.cache', 'sessions', 'index.jsonl');
    const entry = JSON.parse(readFileSync(idx, 'utf-8').trim().split('\n').pop());
    assert.equal(
      entry.device,
      'dev-index',
      `currentDevice() must route the index device stamp: ${JSON.stringify(entry)}`,
    );
  });
});

test('scope: daily shard device stamp is routed through currentDevice (HYPO_DEVICE honored)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionLog = { entry: `## [${today}] scope device entry\n\nbody\n` };
    // run() inherits process.env (only HYPO_DIR/HOME are overridden), so the
    // spawned crystallize sees this HYPO_DEVICE. Save/restore to keep it hermetic.
    const prev = process.env.HYPO_DEVICE;
    try {
      process.env.HYPO_DEVICE = 'dev-shard';
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `apply failed: ${r.stdout}\n${r.stderr}`);
      const shard = join(dir, 'projects', 'test-project', 'session-log', `${today}.md`);
      const fm = readFileSync(shard, 'utf-8');
      assert.ok(
        /^device: dev-shard$/m.test(fm),
        `currentDevice() must route the shard device stamp: ${fm}`,
      );
    } finally {
      if (prev === undefined) delete process.env.HYPO_DEVICE;
      else process.env.HYPO_DEVICE = prev;
    }
  });
});

test('--hypo-dir isolation: overwrite fields land in the supplied dir', () => {
  // run() forces HYPO_DIR='' in env, so any write that lands inside `dir` is
  // proof --hypo-dir was honored. Use an overwrite field (sessionState) with a
  // unique sentinel — append fields are per-day deduped so they're a poor
  // isolation probe. An overwrite field only writes cleanly when its base is
  // observed and matches disk (FEAT-11 T4), so snapshot that base first under
  // the same session-id the apply uses — otherwise this hits base-unknown and
  // never exercises the isolation this test is actually about.
  withWiki(null, (dir, today) => {
    const sid = 'isolation-probe-session';
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const sentinel = `<!-- isolation-probe-${Date.now()} -->`;
    const payload = payloadForCleanWiki(dir, today);
    payload.sessionState = {
      content: `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n${sentinel}\n\n## 다음 작업\n\n- next\n`,
    };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(r.status, 0, `apply failed: ${r.stdout}\n${r.stderr}`);
    const onDisk = readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8');
    assert.ok(onDisk.includes(sentinel), 'sentinel must land in --hypo-dir, proving isolation');
  });
});

test('open-questions absent in payload → still passes (conditional, ungated)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.openQuestions; // explicitly omit
    const r = runApply(dir, payload);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, 'open-questions is conditional — apply must succeed without it');
    assert.ok(
      !out.applied.some((a) => /openQuestions/.test(a)),
      'openQuestions slot should not appear when omitted',
    );
  });
});

test('open-questions stale on disk → still passes (apply does not gate it)', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'open-questions.md'),
        '---\ntitle: Open Questions\ntype: open-questions\nupdated: 2020-01-01\n---\n\n# Open Questions\n',
      );
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      delete payload.openQuestions;
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `stale open-questions must not gate: ${r.stdout}`);
    },
  );
});

test('payload with stale `updated:` → exit 1, no auto-fix (advisor rule)', () => {
  withWiki(null, (dir, today) => {
    // The stale content must actually LAND on disk for verification to flag it,
    // so the overwrite base must be observed and match disk first (FEAT-11 T4) —
    // otherwise the write is refused as base-unknown before it ever gets stale.
    const sid = 'stale-updated-session';
    snapshotBase(dir, sid, overwriteTargets('test-project'));
    const payload = payloadForCleanWiki(dir, today);
    // Inject a stale-dated session-state. Helper must NOT silently rewrite it.
    payload.sessionState = {
      content:
        '---\ntitle: session-state\ntype: session-state\nupdated: 2020-01-01\n---\n\n## 다음 작업\n\n- next\n',
    };
    const r = runApply(dir, payload, { sessionId: sid });
    assert.equal(
      r.status,
      1,
      `stale payload must fail final gate, got status=${r.status}\n${r.stdout}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      out.verification.stale.includes('projects/test-project/session-state.md'),
      `stale field should be flagged: ${JSON.stringify(out.verification)}`,
    );
  });
});

test('missing payload → exit 1 with clear error', () => {
  // With fix #39 (option D) the probe early-exit only fires on a clean wiki.
  // Mark hot.md stale so the gate fails → no early-exit → payload-required
  // error is reachable as the original test intends.
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'hot.md'),
        '---\ntitle: Hot\nupdated: 2020-01-01\n---\n# Hot\n\n## Active Projects\n\n' +
          '| Project | Last Session | Hot Cache |\n|---|---|---|\n' +
          '| test-project | 2020-01-01 | [[projects/test-project/hot]] |\n',
      );
    },
    (dir) => {
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--apply-session-close', '--json']);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.ok(
        /payload is required/.test(out.error),
        `error should mention payload: ${out.error}`,
      );
    },
  );
});

test('session-close: post-apply verify follows payload.project on same-date tie (no cross-project false-block)', () => {
  // Reproduces the 2026-06-09 security-ops-kb incident. The payload closes
  // project B, but root hot.md has A (table-top) and B tied on today's date.
  // Pre-fix, the post-apply check re-resolved via resolveActiveProject → picked
  // A (stable-sort top row) → flagged log.md stale (A has no entry) → returned a
  // false ok:false on a COMPLETED B close. With projectOverride, verification
  // checks B (the project actually written), so the completed close passes.
  withWiki(
    (dir, today) => {
      const ym = today.slice(0, 7);
      // Second project 'beta' (= B, the one actually being closed) — fresh files.
      const betaDir = join(dir, 'projects', 'beta');
      mkdirSync(join(betaDir, 'session-log'), { recursive: true });
      writeFileSync(
        join(betaDir, 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`,
      );
      writeFileSync(
        join(betaDir, 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`,
      );
      writeFileSync(
        join(betaDir, 'session-log', `${ym}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] beta session\n`,
      );
      // Root hot.md: test-project (A) on TOP, beta (B) below — both dated today
      // (same-date tie). Stable sort makes A the legacy resolveActiveProject win.
      writeFileSync(
        join(dir, 'hot.md'),
        `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
          `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
          `| test-project | ${today} | [[projects/test-project/hot]] |\n` +
          `| beta | ${today} | [[projects/beta/hot]] |\n`,
      );
      // log.md carries an unrelated project's entry — neither A nor B. So A's
      // close is genuinely incomplete (no A entry); pre-fix the verify resolves
      // to A and false-fails on the missing A entry.
      writeFileSync(join(dir, 'log.md'), `## [${today}] session | gamma\n`);
    },
    (dir, today) => {
      const payload = {
        project: 'beta',
        date: today,
        sessionState: {
          content: readFileSync(join(dir, 'projects', 'beta', 'session-state.md'), 'utf-8'),
        },
        projectHot: { content: readFileSync(join(dir, 'projects', 'beta', 'hot.md'), 'utf-8') },
        rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
        sessionLog: { entry: `## [${today}] beta close\n` },
        log: { entry: `## [${today}] session | beta\n` },
      };
      const r = runApply(dir, payload);
      assert.equal(
        r.status,
        0,
        `completed beta close must pass, got ${r.status}\n${r.stdout}\n${r.stderr}`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.ok,
        true,
        `same-date tie must not false-block a completed close: ${JSON.stringify(out.verification)}`,
      );
      assert.equal(
        out.verification.project,
        'beta',
        `verification must check payload.project (beta), not the table-top (test-project): ${JSON.stringify(out.verification)}`,
      );
      // ISSUE-17: the same payload≠inferred divergence must be surfaced on stderr so
      // the operator can see which project the close actually verified. stdout (parsed
      // above) stays pure JSON — the note must NOT leak there.
      assert.match(
        r.stderr,
        /payload\.project="beta" differs from the inferred active project "test-project"/,
        `ISSUE-17: payload targeting a project other than the inferred active one must emit a stderr note: ${JSON.stringify(r.stderr)}`,
      );
    },
  );
});

// B-3 (close-gate-hardening): apply must NOT infer the close target from recency.
// payload.project is REQUIRED and validated (slug shape + on-disk existence) so a
// same-date root-hot.md tie can never silently write the close into the wrong
// project. Each guard fails fast with a distinct, named error.
test('apply: payload.project missing → exit 1 (B-3 data-loss guard)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.project;
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `missing project must hard-fail: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.error,
      /payload\.project is required/,
      `error must name the missing field: ${r.stdout}`,
    );
  });
});

test('apply: payload.project malformed name → exit 1 (B-3 traversal/segment guard)', () => {
  // Path-traversal, separators, whitespace, dot-only: all rejected BEFORE any
  // existsSync/path build, so a `../`-style value never reaches a path builder.
  for (const bad of ['../escape', 'a/b', 'has space', '..', '.']) {
    withWiki(null, (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      payload.project = bad;
      const r = runApply(dir, payload);
      assert.equal(r.status, 1, `malformed name "${bad}" must hard-fail: ${r.stdout}\n${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.match(
        out.error,
        /not a valid project name/,
        `error must flag name validity for "${bad}": ${r.stdout}`,
      );
    });
  }
});

test('apply: payload.project non-string → exit 1 (B-3 regex-coercion guard)', () => {
  // A JS regex coerces non-strings (42 → "42"); isValidProjectName's typeof guard rejects first.
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.project = 42;
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `non-string project must hard-fail: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.error,
      /not a valid project name/,
      `error must reject non-string project: ${r.stdout}`,
    );
  });
});

test('apply: wide-charset valid name (A-Z/_/.) not rejected as malformed (B-3 namespace parity)', () => {
  // createProject accepts the namespace A-Za-z0-9._- (single segment). Apply must
  // accept exactly that, not a narrower one — else an existing Foo_Bar / foo.bar
  // project can be scaffolded and resumed but never closed (codex review). A
  // non-existent such name must fail as "does not exist", NOT "not a valid name".
  for (const name of ['Foo_Bar', 'foo.bar']) {
    withWiki(null, (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      payload.project = name;
      const r = runApply(dir, payload);
      assert.equal(r.status, 1, `non-existent dir still fails, got ${r.status}: ${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.match(
        out.error,
        /does not exist/,
        `valid wide-charset name must pass name-validity and fail only on existence: ${r.stdout}`,
      );
      assert.doesNotMatch(
        out.error,
        /not a valid project name/,
        `valid wide-charset name must NOT be rejected as malformed: ${r.stdout}`,
      );
    });
  }
});

test('apply: payload.project does not exist on disk → exit 1 (B-3)', () => {
  // A well-formed slug with no projects/<slug>/ directory: abort rather than create.
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.project = 'ghost-project';
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `non-existent project must hard-fail: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.match(out.error, /does not exist/, `error must flag the missing dir: ${r.stdout}`);
  });
});

test('apply: payload.project is a regular file, not a directory → exit 1 (B-3 dir guard)', () => {
  // A valid-name slug whose projects/<slug> is a FILE (not a dir) must be rejected
  // structurally here, not crash later building child paths (codex re-review).
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.project = 'filenode';
    writeFileSync(join(dir, 'projects', 'filenode'), 'not a dir\n');
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `file-at-path must hard-fail: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.match(
      out.error,
      /does not exist as a directory/,
      `error must flag the non-directory: ${r.stdout}`,
    );
  });
});

test('same-day second close: distinct entries are both appended (W1 regression)', () => {
  // Sub-session within the same day must produce a second log entry, not be
  // silently deduped because today's heading already exists — exact-entry dedup
  // is separate from the freshness gate.
  withWiki(null, (dir, today) => {
    const p1 = payloadForCleanWiki(dir, today);
    p1.sessionLog.entry = `## [${today}] morning sub-session\n\nbody A\n`;
    p1.log.entry = `## [${today}] session | test-project — morning\n`;
    const r1 = runApply(dir, p1);
    assert.equal(r1.status, 0, `first apply failed: ${r1.stdout}\n${r1.stderr}`);

    const p2 = payloadForCleanWiki(dir, today);
    p2.sessionLog.entry = `## [${today}] afternoon sub-session\n\nbody B\n`;
    p2.log.entry = `## [${today}] session | test-project — afternoon\n`;
    const r2 = runApply(dir, p2);
    assert.equal(r2.status, 0, `second apply failed: ${r2.stdout}\n${r2.stderr}`);

    const sl = readFileSync(
      join(dir, 'projects', 'test-project', 'session-log', `${today}.md`),
      'utf-8',
    );
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.ok(sl.includes('morning sub-session'), `session-log should keep morning entry: ${sl}`);
    assert.ok(
      sl.includes('afternoon sub-session'),
      `session-log should append afternoon entry: ${sl}`,
    );
    assert.ok(log.includes('— morning'), `log.md should keep morning entry: ${log}`);
    assert.ok(log.includes('— afternoon'), `log.md should append afternoon entry: ${log}`);
  });
});

test('payload schema: missing mandatory field → exit 1 with named field (W1 fail-loud)', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    delete payload.projectHot; // drop a mandatory slot
    const r = runApply(dir, payload);
    assert.equal(r.status, 1, `missing mandatory must fail, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      /projectHot/.test(JSON.stringify(out.details || out.error)),
      `error must name the missing field: ${r.stdout}`,
    );
  });
});

test('payload schema: invalid date format → exit 1', () => {
  withWiki(null, (dir, today) => {
    const payload = payloadForCleanWiki(dir, today);
    payload.date = '2026/05/15';
    const r = runApply(dir, payload);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.ok(
      /YYYY-MM-DD/.test(JSON.stringify(out.details || out.error)),
      `error must mention date format: ${r.stdout}`,
    );
  });
});

// ── B-1: payload.log optional + apply auto-derives the root log.md entry ──────
suite('B-1: payload.log optional + apply auto-derives the root log.md entry');
test('B-1: apply without payload.log auto-derives the canonical log.md entry (exit 0)', () => {
  withWiki(
    (dir) => {
      // Pre-apply: log.md carries NO fresh test-project entry, so the absent-log
      // path must reconstruct it via deriveRootLogEntries (not fail the gate).
      writeFileSync(join(dir, 'log.md'), `## [2020-01-01] session | old-project\n`);
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      delete payload.log; // optional field omitted (B-1)
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true, `apply must pass with log derived: ${r.stdout}`);
      const log = readFileSync(join(dir, 'log.md'), 'utf-8');
      assert.match(
        log,
        new RegExp(`^## \\[${today}\\] session \\| test-project`, 'm'),
        'apply must auto-derive the canonical log.md entry when payload.log is absent',
      );
      assert.ok(
        out.applied.join(' ').includes('log (log.md, derived)'),
        `derived log slot must be reported applied: ${r.stdout}`,
      );
    },
  );
});

test('B-1: apply WITH payload.log keeps the explicit append path (no double-write)', () => {
  withWiki(
    (dir) => {
      writeFileSync(join(dir, 'log.md'), `## [2020-01-01] session | old-project\n`);
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today); // includes log
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      const log = readFileSync(join(dir, 'log.md'), 'utf-8');
      // The explicit payload.log line is written once; the derive path is gated
      // behind `!payload.log`, so it must NOT append a second canonical line.
      const matches = (log.match(new RegExp(`\\[${today}\\] session \\| test-project`, 'g')) || [])
        .length;
      assert.equal(matches, 1, `exactly one test-project entry, got ${matches}:\n${log}`);
      assert.ok(out.applied.join(' ').includes('log (log.md)'), 'explicit log slot applied');
      assert.ok(
        !out.applied.join(' ').includes('derived'),
        'derive must not run alongside an explicit payload.log',
      );
    },
  );
});

test('B-1: payload.log present but malformed → exit 1 (fail-loud preserved, not silently derived)', () => {
  withWiki(
    (dir) => {
      writeFileSync(join(dir, 'log.md'), `## [2020-01-01] session | old-project\n`);
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      // A non-canonical log line (no `session | <project>` form). The old
      // behavior hard-fails verification; with derive gated to the absent path,
      // that fail-loud must survive — derive must not paper over a bad explicit
      // entry (codex design review).
      payload.log = { entry: `## [${today}] not a canonical session line\n` };
      const r = runApply(dir, payload);
      assert.equal(r.status, 1, `malformed explicit log must fail loud: ${r.stdout}`);
    },
  );
});

test('B-1: absent payload.log + sessionLog with no dated heading → exit 1 (no silent no-write)', () => {
  withWiki(
    (dir, today) => {
      // An earlier same-day close already satisfies date-level freshness, so the
      // post-apply verifier alone would NOT catch a current close that derives
      // nothing. The pre-write guard must fail loud instead of skipping silently.
      writeFileSync(join(dir, 'log.md'), `## [${today}] session | test-project — first\n`);
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      payload.sessionLog = { entry: `no dated heading here\n` };
      delete payload.log;
      const r = runApply(dir, payload);
      assert.equal(r.status, 1, `must fail loud when nothing is derivable: ${r.stdout}`);
      assert.match(
        JSON.stringify(JSON.parse(r.stdout)),
        /heading to derive the log\.md/,
        `error must name the un-derivable sessionLog heading: ${r.stdout}`,
      );
    },
  );
});

test('B-1: same-day second close without payload.log derives the distinct entry', () => {
  withWiki(
    (dir, today) => {
      // A first close already left a today entry for test-project. Now that
      // callers no longer hand-write log (SKILL/T6), the absent-log path must
      // still recover the SECOND close's distinct heading — the derive guard is
      // entry-level, not "log.md is wholly absent".
      writeFileSync(join(dir, 'log.md'), `## [${today}] session | test-project — first\n`);
    },
    (dir, today) => {
      const payload = payloadForCleanWiki(dir, today);
      payload.sessionLog = { entry: `## [${today}] session | test-project — second\n` };
      delete payload.log;
      const r = runApply(dir, payload);
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
      const log = readFileSync(join(dir, 'log.md'), 'utf-8');
      assert.match(log, /session \| test-project — first/, 'first close entry retained');
      assert.match(
        log,
        /session \| test-project — second/,
        'second same-day close must derive its own distinct root entry',
      );
    },
  );
});

test('hasLogEntry: project "foo" must NOT match "foo-bar" (W2 boundary regression)', () => {
  // Pre-existing bug in sessionCloseFileStatus that the helper extraction
  // inherited. \b after "foo" matches before "-" (non-word char), so the
  // bounded regex must use (?=\\s|$) instead.
  withWiki(
    (dir, today) => {
      // Replace root hot.md to declare project "foo" as the active project,
      // and seed log.md with a session entry for "foo-bar" only.
      writeFileSync(
        join(dir, 'hot.md'),
        `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
          `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
          `| foo | ${today} | [[projects/foo/hot]] |\n`,
      );
      mkdirSync(join(dir, 'projects', 'foo', 'session-log'), { recursive: true });
      writeFileSync(
        join(dir, 'projects', 'foo', 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`,
      );
      writeFileSync(
        join(dir, 'projects', 'foo', 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`,
      );
      writeFileSync(
        join(dir, 'projects', 'foo', 'session-log', `${today.slice(0, 7)}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] foo session\n`,
      );
      // log.md only carries an entry for the LOOK-ALIKE project name.
      writeFileSync(
        join(dir, 'log.md'),
        `## [${today}] session | foo-bar — should not satisfy "foo" gate\n`,
      );
    },
    (dir) => {
      // Plain --check-session-close must reject "foo" because no foo entry exists.
      const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
      assert.equal(
        r.status,
        1,
        `foo must not match foo-bar in log.md, got status=${r.status}\n${r.stdout}`,
      );
      const out = JSON.parse(r.stdout);
      assert.ok(
        out.stale.includes('log.md') || out.missing.includes('log.md'),
        `log.md must be flagged stale/missing for foo: ${JSON.stringify(out)}`,
      );
    },
  );
});

// ── hooks.json shared coverage ───────────────────────────────────────────────

suite('hooks/hooks.json — "shared" covers every intra-hooks import');

test('every relative import of a registered hook resolves to a file upgrade actually copies', () => {
  // `init.mjs installHooks` readdir-copies every hooks/*.mjs, but `upgrade.mjs
  // checkHookFiles` only walks HOOK_MAP command targets + hooks.json "shared".
  // A helper missing from "shared" therefore installs fine on a FRESH vault and
  // breaks only on `upgrade --apply` for existing users: the refreshed hook lands
  // without its import and Node dies on module resolution, before any best-effort
  // guard can run. The list is hand-maintained, so pin it mechanically.
  const cfg = JSON.parse(readFileSync(join(HOOKS, 'hooks.json'), 'utf-8'));
  const commandFiles = new Set();
  for (const groups of Object.values(cfg.hooks)) {
    for (const group of groups) {
      const hooks = typeof group === 'string' ? [{ command: group }] : group.hooks;
      for (const h of hooks) {
        const m = String(h.command).match(/([\w.-]+\.mjs)/);
        if (m) commandFiles.add(m[1]);
      }
    }
  }
  const covered = new Set([...commandFiles, ...cfg.shared]);
  const missing = [];
  for (const file of covered) {
    const src = join(HOOKS, file);
    if (!existsSync(src)) continue;
    const text = readFileSync(src, 'utf-8');
    for (const m of text.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)) {
      if (!covered.has(m[1])) missing.push(`${file} imports ./${m[1]}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `intra-hooks imports not covered by hooks.json (add to "shared"): ${missing.join(', ')}`,
  );
});

// ── FEAT-11 base-store (T2) ──────────────────────────────────────────────────

suite('base-store.mjs — per-session observed-base snapshot (FEAT-11 T2)');

function withBaseWiki(fn) {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    mkdirSync(join(dir, 'projects', 'p1'), { recursive: true });
    writeFileSync(join(dir, 'hypo-config.md'), '# config\n');
    writeFileSync(join(dir, 'hot.md'), '# root hot\n');
    writeFileSync(join(dir, 'pages', 'open-questions.md'), '# open questions\n');
    writeFileSync(join(dir, 'projects', 'p1', 'hot.md'), '# p1 hot\n');
    writeFileSync(join(dir, 'projects', 'p1', 'session-state.md'), '# p1 state\n');
    fn(dir);
  });
}

test('hashContent is stable and hashFile returns null for an absent file', () => {
  assert.equal(bsHashContent('abc'), bsHashContent('abc'));
  assert.notEqual(bsHashContent('abc'), bsHashContent('abd'));
  withBaseWiki((dir) => {
    assert.equal(bsHashFile(join(dir, 'nope.md')), null, 'absent file must hash to null');
    assert.equal(bsHashFile(join(dir, 'hot.md')), bsHashContent('# root hot\n'));
  });
});

test('overwriteTargets covers the four overwrite pages, and omits project pages with no project', () => {
  assert.deepEqual(overwriteTargets('p1').sort(), [
    'hot.md',
    join('pages', 'open-questions.md'),
    join('projects', 'p1', 'hot.md'),
    join('projects', 'p1', 'session-state.md'),
  ]);
  assert.deepEqual(overwriteTargets(null), ['hot.md', join('pages', 'open-questions.md')]);
});

test('snapshotBase records a hash per target and an observed-absent target as null', () => {
  withBaseWiki((dir) => {
    rmSync(join(dir, 'pages', 'open-questions.md'));
    const r = snapshotBase(dir, 's1', overwriteTargets('p1'));
    assert.equal(r.created, true);
    const parsed = JSON.parse(readFileSync(bsBasePath(dir, 's1'), 'utf-8'));
    assert.equal(parsed.session_id, 's1');
    assert.equal(parsed.targets['hot.md'], bsHashContent('# root hot\n'));
    assert.equal(
      parsed.targets[join('pages', 'open-questions.md')],
      null,
      'observed-absent target must be recorded as null, not omitted',
    );
  });
});

test('snapshotBase is existence-checked: a second call does not move the base (정합성 요건)', () => {
  withBaseWiki((dir) => {
    snapshotBase(dir, 's1', overwriteTargets('p1'));
    const before = readBaseEntry(dir, 's1', 'hot.md').hash;
    // another session (or another machine's pull) rewrites the page
    writeFileSync(join(dir, 'hot.md'), '# rewritten by someone else\n');
    const r = snapshotBase(dir, 's1', overwriteTargets('p1'));
    assert.equal(r.created, false);
    assert.equal(r.reason, 'already-snapshotted');
    assert.equal(
      readBaseEntry(dir, 's1', 'hot.md').hash,
      before,
      'resume/compact must NOT re-snapshot: doing so silently clobbers the other writer',
    );
  });
});

test('snapshotBase with no session id is a no-op', () => {
  withBaseWiki((dir) => {
    const r = snapshotBase(dir, '', overwriteTargets('p1'));
    assert.equal(r.created, false);
    assert.equal(r.reason, 'no-session-id');
    assert.equal(existsSync(join(dir, '.cache', 'sessions')), false);
  });
});

test('readBaseEntry discriminates hash / absent / unknown so consumers cannot collapse them', () => {
  withBaseWiki((dir) => {
    rmSync(join(dir, 'pages', 'open-questions.md'));
    snapshotBase(dir, 's1', overwriteTargets('p1'));
    assert.deepEqual(readBaseEntry(dir, 's1', join('pages', 'open-questions.md')), {
      state: 'absent',
      hash: null,
    });
    assert.equal(readBaseEntry(dir, 's1', join('projects', 'p1', 'hot.md')).state, 'hash');
    assert.equal(readBaseEntry(dir, 's1', 'projects/other/hot.md').state, 'unknown');
    assert.equal(readBaseEntry(dir, 'no-such-session', 'hot.md').state, 'unknown');
    assert.equal(readBaseEntry(dir, '', 'hot.md').state, 'unknown');
    // the whole point of the discriminator: both non-'hash' states carry
    // hash === null, so a consumer must never branch on hash truthiness
    assert.equal(readBaseEntry(dir, 's1', join('pages', 'open-questions.md')).hash, null);
    assert.equal(readBaseEntry(dir, 's1', 'projects/other/hot.md').hash, null);
  });
});

test('readBaseEntry treats a malformed base.json as unknown, not as unchanged', () => {
  withBaseWiki((dir) => {
    const p = bsBasePath(dir, 's1');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, 'not json at all');
    assert.equal(readBaseEntry(dir, 's1', 'hot.md').state, 'unknown');
    // a structurally valid file whose entry is not a hash is equally untrusted
    writeFileSync(p, JSON.stringify({ targets: { 'hot.md': 42, 'log.md': '' } }));
    assert.equal(readBaseEntry(dir, 's1', 'hot.md').state, 'unknown');
    assert.equal(readBaseEntry(dir, 's1', 'log.md').state, 'unknown');
  });
});

test('advanceBase moves one target and no-ops when the session has no snapshot', () => {
  withBaseWiki((dir) => {
    snapshotBase(dir, 's1', overwriteTargets('p1'));
    const next = bsHashContent('# written by this session\n');
    assert.equal(advanceBase(dir, 's1', 'hot.md', next), true);
    assert.equal(readBaseEntry(dir, 's1', 'hot.md').hash, next);
    assert.equal(
      readBaseEntry(dir, 's1', join('projects', 'p1', 'hot.md')).hash,
      bsHashContent('# p1 hot\n'),
      'advancing one target must not disturb the others',
    );
    assert.equal(advanceBase(dir, 'no-snapshot-session', 'hot.md', next), false);
  });
});

test('advanceBaseForWrite advances a tracked target to its current on-disk bytes', () => {
  withBaseWiki((dir) => {
    snapshotBase(dir, 's1', overwriteTargets('p1'));
    const oq = join(dir, 'pages', 'open-questions.md');
    writeFileSync(oq, '# open questions\n\n## edited directly by this session\n');
    assert.equal(advanceBaseForWrite(dir, 's1', join('pages', 'open-questions.md'), oq), true);
    assert.equal(
      readBaseEntry(dir, 's1', join('pages', 'open-questions.md')).hash,
      bsHashFile(oq),
      "the session's own direct edit becomes the new observed base",
    );
    assert.equal(
      readBaseEntry(dir, 's1', 'hot.md').hash,
      bsHashContent('# root hot\n'),
      'advancing one target must not disturb the others',
    );
  });
});

test('advanceBaseForWrite no-ops for an untracked path — it never mints a new base key', () => {
  // The scoping guard. A write to any wiki file that is NOT one of the four
  // snapshotted targets must leave the base map exactly as it was, so this can
  // never widen the guard's surface. Mutation target: dropping the hasOwnProperty
  // check makes this fail.
  withBaseWiki((dir) => {
    snapshotBase(dir, 's1', overwriteTargets('p1'));
    const before = readFileSync(bsBasePath(dir, 's1'), 'utf-8');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const other = join(dir, 'pages', 'some-note.md');
    writeFileSync(other, '# an unrelated page\n');
    assert.equal(advanceBaseForWrite(dir, 's1', join('pages', 'some-note.md'), other), false);
    assert.equal(
      readFileSync(bsBasePath(dir, 's1'), 'utf-8'),
      before,
      'an untracked write must not touch base.json at all',
    );
  });
});

test('advanceBaseForWrite no-ops with no session, no snapshot, or a vanished target', () => {
  withBaseWiki((dir) => {
    const oq = join(dir, 'pages', 'open-questions.md');
    // no session id → outside the guard lifecycle
    assert.equal(advanceBaseForWrite(dir, '', join('pages', 'open-questions.md'), oq), false);
    // session with no snapshot on record
    assert.equal(
      advanceBaseForWrite(dir, 'no-snap', join('pages', 'open-questions.md'), oq),
      false,
    );

    snapshotBase(dir, 's1', overwriteTargets('p1'));
    const before = readBaseEntry(dir, 's1', join('pages', 'open-questions.md')).hash;
    rmSync(oq);
    // a tracked target that is absent post-write must NOT advance the base to
    // null — a vanished file is a real divergence the close should still see
    assert.equal(advanceBaseForWrite(dir, 's1', join('pages', 'open-questions.md'), oq), false);
    assert.equal(
      readBaseEntry(dir, 's1', join('pages', 'open-questions.md')).hash,
      before,
      'an absent post-write file must leave the base untouched, not advance to null',
    );
  });
});

test('advanceBaseForWrite with a knownHash advances to it, ignoring on-disk bytes', () => {
  // The Write race-safe path: the caller supplies the hash of the exact bytes the
  // tool wrote, so the base tracks those even if disk already drifted.
  withBaseWiki((dir) => {
    snapshotBase(dir, 's1', overwriteTargets('p1'));
    const oq = join(dir, 'pages', 'open-questions.md');
    writeFileSync(oq, '# a concurrent write already on disk\n');
    const intended = bsHashContent('# what my Write actually wrote\n');
    assert.equal(
      advanceBaseForWrite(dir, 's1', join('pages', 'open-questions.md'), oq, intended),
      true,
    );
    assert.equal(
      readBaseEntry(dir, 's1', join('pages', 'open-questions.md')).hash,
      intended,
      'knownHash wins over the on-disk hash',
    );
    // untracked scoping still applies even with a knownHash
    assert.equal(
      advanceBaseForWrite(dir, 's1', join('pages', 'nope.md'), oq, intended),
      false,
      'a knownHash must not let an untracked path mint a base key',
    );
  });
});

// ── FEAT-11 SessionStart base snapshot (T3) ──────────────────────────────────

suite('hypo-session-start.mjs — observed-base snapshot once per session (FEAT-11 T3)');

function withBaseProject(fn) {
  withBaseWiki((dir) => {
    const work = mkdtempSync(join(tmpdir(), 'hypo-base-work-'));
    writeFileSync(
      join(dir, 'projects', 'p1', 'index.md'),
      `---\ntitle: p1\ntype: project-index\nupdated: 2026-07-08\nworking_dir: "${work}"\n---\n# P1\n`,
    );
    try {
      fn(dir, work);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

test('first SessionStart snapshots all four overwrite targets', () => {
  withBaseProject((dir, work) => {
    const r = runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'ss-1' },
      { HYPO_DIR: dir },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(readFileSync(bsBasePath(dir, 'ss-1'), 'utf-8'));
    assert.deepEqual(Object.keys(parsed.targets).sort(), [
      'hot.md',
      join('pages', 'open-questions.md'),
      join('projects', 'p1', 'hot.md'),
      join('projects', 'p1', 'session-state.md'),
    ]);
    assert.equal(parsed.targets[join('projects', 'p1', 'hot.md')], bsHashContent('# p1 hot\n'));
  });
});

test('resume (same session_id) after an external write does NOT re-snapshot the base', () => {
  // The whole gate hinges on this. T1's spike showed SessionStart fires again on
  // resume AND on compact with the same session_id; re-snapshotting there would
  // adopt the other writer's content as this session's base, so close would see
  // no drift and overwrite it. A single-session test passes either way, which is
  // why this regression exists.
  withBaseProject((dir, work) => {
    runHook('hypo-session-start.mjs', { cwd: work, session_id: 'ss-2' }, { HYPO_DIR: dir });
    const before = readBaseEntry(dir, 'ss-2', 'hot.md').hash;
    writeFileSync(join(dir, 'hot.md'), '# the OTHER session wrote this\n');
    const r = runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'ss-2', source: 'resume' },
      { HYPO_DIR: dir },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(
      readBaseEntry(dir, 'ss-2', 'hot.md').hash,
      before,
      'resume must not move the base',
    );
    assert.notEqual(
      readBaseEntry(dir, 'ss-2', 'hot.md').hash,
      bsHashContent('# the OTHER session wrote this\n'),
    );
  });
});

test('a NEW session_id (what /clear mints) snapshots fresh from disk', () => {
  withBaseProject((dir, work) => {
    runHook('hypo-session-start.mjs', { cwd: work, session_id: 'ss-3a' }, { HYPO_DIR: dir });
    writeFileSync(join(dir, 'hot.md'), '# post-clear disk state\n');
    runHook(
      'hypo-session-start.mjs',
      { cwd: work, session_id: 'ss-3b', source: 'clear' },
      { HYPO_DIR: dir },
    );
    assert.equal(
      readBaseEntry(dir, 'ss-3b', 'hot.md').hash,
      bsHashContent('# post-clear disk state\n'),
      'a cleared session restarts its observation from disk',
    );
  });
});

test('SessionStart with no session_id writes no base and still succeeds', () => {
  withBaseProject((dir, work) => {
    const r = runHook('hypo-session-start.mjs', { cwd: work }, { HYPO_DIR: dir });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(existsSync(join(dir, '.cache', 'sessions')), false);
  });
});

test('SessionStart outside any project still snapshots the two global targets', () => {
  withBaseProject((dir) => {
    const outside = mkdtempSync(join(tmpdir(), 'hypo-base-nowhere-'));
    try {
      runHook('hypo-session-start.mjs', { cwd: outside, session_id: 'ss-4' }, { HYPO_DIR: dir });
      const parsed = JSON.parse(readFileSync(bsBasePath(dir, 'ss-4'), 'utf-8'));
      assert.deepEqual(Object.keys(parsed.targets).sort(), [
        'hot.md',
        join('pages', 'open-questions.md'),
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── FEAT-11 overwrite observed-base guard (T4) ───────────────────────────────

suite('crystallize.mjs — overwrite observed-base guard (FEAT-11 T4)');

const T4_PROJECT = 'test-project';

const t4ProjectHot = (dir) => join(dir, 'projects', T4_PROJECT, 'hot.md');

const t4Rel = join('projects', T4_PROJECT, 'hot.md');

/**
 * An apply payload whose sessionState / rootHot mirror disk (so they hit the
 * idempotent skip and stay out of the way) and whose projectHot carries
 * `projectHotContent` — the single target each T4 test exercises.
 */
function t4Payload(dir, today, projectHotContent, tag) {
  return {
    project: T4_PROJECT,
    date: today,
    sessionState: {
      content: readFileSync(join(dir, 'projects', T4_PROJECT, 'session-state.md'), 'utf-8'),
    },
    projectHot: { content: projectHotContent },
    rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
    sessionLog: { entry: `## [${today}] ${tag}\n` },
    log: { entry: `## [${today}] session | ${T4_PROJECT} — ${tag}\n` },
  };
}

// A payload-bearing apply requires close authority before it writes anything
// (see runApply's comment above), so any t4Apply call that passes a sessionId
// must have an authorized transcript for it to resolve, or the gate refuses
// before the base-store logic these tests actually exercise ever runs.
function t4Apply(dir, payload, sessionId) {
  const payloadPath = join(dir, `.payload-${sessionId || 'none'}.json`);
  writeFileSync(payloadPath, JSON.stringify(payload));
  const argv = [`--hypo-dir=${dir}`, '--apply-session-close', `--payload=${payloadPath}`, '--json'];
  let cleanup = null;
  if (sessionId) {
    argv.push(`--session-id=${sessionId}`);
    if (!resolveTranscriptBySessionId(sessionId, join(SESSION_TMP_HOME, '.claude', 'projects'))) {
      cleanup = seedCloseTranscript(sessionId);
    }
  }
  try {
    const r = run('crystallize.mjs', argv);
    return { r, out: JSON.parse(r.stdout) };
  } finally {
    if (cleanup) cleanup();
  }
}

test('base matches disk → direct write, no conflict, and the base advances', () => {
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-clean', overwriteTargets(T4_PROJECT));
    const next = `${readFileSync(t4ProjectHot(dir), 'utf-8')}\nthis session wrote this.\n`;
    const { out } = t4Apply(dir, t4Payload(dir, today, next, 'clean write'), 's-clean');

    assert.deepEqual(out.conflicts, [], `no drift → no conflict: ${JSON.stringify(out.conflicts)}`);
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), next, 'payload bytes must land');
    assert.equal(
      readBaseEntry(dir, 's-clean', t4Rel).hash,
      bsHashContent(next),
      'a successful direct write becomes the new observed base',
    );
  });
});

test('base snapshotted, then another session writes the page → conflict, target untouched', () => {
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-conf', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');
    const otherSession = `${observed}\nthe OTHER session wrote this.\n`;
    writeFileSync(t4ProjectHot(dir), otherSession);

    const mine = `${observed}\nMY payload, built from the stale read.\n`;
    const { r, out } = t4Apply(dir, t4Payload(dir, today, mine, 'conflict'), 's-conf');

    assert.notEqual(r.status, 0, 'a withheld target must fail the close');
    assert.equal(
      readFileSync(t4ProjectHot(dir), 'utf-8'),
      otherSession,
      "the other session's edit must survive",
    );
    const c = out.conflicts.find((x) => x.target === t4Rel);
    assert.ok(c, `conflicts must name the target: ${JSON.stringify(out.conflicts)}`);
    assert.equal(c.reason, 'base-mismatch');
    assert.ok(!('proposedContent' in c), 'the reported shape must not echo the whole payload');
    assert.equal(
      existsSync(join(dir, '.cache', 'session-closed-s-conf.marker')),
      false,
      'a conflicted close must not mark the session closed',
    );
  });
});

test('session-id present but NO snapshot → fail-safe conflict (base-unknown, not "no base = safe")', () => {
  // Guards the discriminated union. `readBaseEntry` returns hash:null for BOTH
  // observed-absent and never-observed; a consumer branching on `if (!entry.hash)`
  // would treat never-observed as safe-to-write and silently defeat the gate.
  withWiki(null, (dir, today) => {
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');
    const mine = `${observed}\nwritten with no base on record.\n`;
    const { r, out } = t4Apply(dir, t4Payload(dir, today, mine, 'no base'), 's-nobase');

    assert.notEqual(r.status, 0);
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), observed, 'target must stay untouched');
    const c = out.conflicts.find((x) => x.target === t4Rel);
    assert.ok(c, `an unobserved base must fail safe: ${JSON.stringify(out.conflicts)}`);
    assert.equal(c.reason, 'base-unknown');
  });
});

test('idempotent-first: payload equals disk → no write, no conflict, even with no base', () => {
  // Pins the guard ORDER. The six existing --apply-session-close --session-id tests
  // read their payload straight off disk and carry no base, so they only stay green
  // while the idempotent skip runs BEFORE the base check. It also breaks the
  // apply-then-reclose loop: after a human applies a proposal, disk == payload.
  withWiki(null, (dir, today) => {
    const onDisk = readFileSync(t4ProjectHot(dir), 'utf-8');
    const { out } = t4Apply(dir, t4Payload(dir, today, onDisk, 'idempotent'), 's-idem');

    assert.deepEqual(out.conflicts, [], 'identical bytes are not a conflict');
    assert.ok(
      out.skipped.some((s) => s.includes('projectHot')),
      `projectHot must be skipped as already-current: ${JSON.stringify(out.skipped)}`,
    );
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), onDisk);
  });
});

test('same session closing twice does not raise a false-positive against its own first write', () => {
  // The ONLY test that fails when advanceBase is removed. A single apply passes
  // either way, which is exactly why this exists:
  // [[pages/learnings/mutation-check-invariants-a-passing-suite-cannot-see]]
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-twice', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');

    const first = `${observed}\nfirst close.\n`;
    const a = t4Apply(dir, t4Payload(dir, today, first, 'first close'), 's-twice');
    assert.deepEqual(a.out.conflicts, [], 'first close writes cleanly');
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), first);

    const second = `${observed}\nsecond close, same session.\n`;
    const b = t4Apply(dir, t4Payload(dir, today, second, 'second close'), 's-twice');
    assert.deepEqual(
      b.out.conflicts,
      [],
      'without advanceBase the session diffs against its own stale base and self-conflicts',
    );
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), second);
  });
});

test('no --session-id → apply is refused before any write (no legacy escape hatch)', () => {
  // The legacy path this used to pin is gone: verifyCloseAuthority now runs
  // BEFORE any wiki write or commit, and refuses outright when --session-id is
  // absent. A caller can no longer opt out of the base-store guard by omitting
  // the flag; that omission is itself the thing that gets refused.
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-unused', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');
    const otherWrote = `${observed}\nsomeone else.\n`;
    writeFileSync(t4ProjectHot(dir), otherWrote);

    const mine = `${observed}\nlegacy manual apply.\n`;
    // `applied: []` is the apply path's own account of itself, and the bug this
    // guards was a write that happened anyway. Pin the two things the process
    // cannot talk its way out of: the bytes on disk and the commit tip.
    const headBefore = gitHead(dir);
    const { r, out } = t4Apply(dir, t4Payload(dir, today, mine, 'legacy'), null);

    assert.notEqual(r.status, 0, 'omitting --session-id must not succeed');
    assert.equal(out.reason, 'session-id-required');
    assert.deepEqual(out.applied, []);
    assert.equal(out.committed, false);
    assert.equal(gitHead(dir), headBefore, 'refused before any write → no new commit');
    assert.equal(
      readFileSync(t4ProjectHot(dir), 'utf-8'),
      otherWrote,
      "refused before any write — the other writer's bytes must be untouched",
    );
  });
});

test('a conflicted close registers no pending tags — no silent SCHEMA.md side effect', () => {
  // codex W2 CONCERN: a withheld close skips commitWikiChanges (ok:false), so any
  // SCHEMA.md write it made would sit mutated, uncommitted, and unlisted in
  // `applied`. The control arm proves the fixture really does drive a registration,
  // so this cannot pass by simply never registering.
  const seedUnknownTag = (dir, today) => {
    writeFileSync(
      join(dir, 'SCHEMA.md'),
      `---\ntitle: Wiki Schema\ntype: schema\nupdated: ${today}\nversion: 2.1\n---\n\n` +
        '## 3. Tag Taxonomy\n\n### Domain — Test\n`concept`\n\n### Forbidden Patterns\n',
    );
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(
      join(dir, 'pages', 'x.md'),
      `---\ntitle: X\ntype: concept\ntags: [zzz-unregistered-tag]\nupdated: ${today}\n---\n\n# X\n`,
    );
  };

  // control: a clean close DOES register the tag
  withWiki(seedUnknownTag, (dir, today) => {
    snapshotBase(dir, 's-tag-ok', overwriteTargets(T4_PROJECT));
    const next = `${readFileSync(t4ProjectHot(dir), 'utf-8')}\nclean.\n`;
    t4Apply(dir, t4Payload(dir, today, next, 'tag control'), 's-tag-ok');
    assert.ok(
      readFileSync(join(dir, 'SCHEMA.md'), 'utf-8').includes('zzz-unregistered-tag'),
      'control arm must actually register, else the assertion below is vacuous',
    );
  });

  // conflicted close: registers nothing
  withWiki(seedUnknownTag, (dir, today) => {
    snapshotBase(dir, 's-tag-conf', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');
    writeFileSync(t4ProjectHot(dir), `${observed}\nthe OTHER session.\n`);
    const schemaBefore = readFileSync(join(dir, 'SCHEMA.md'), 'utf-8');

    const { out } = t4Apply(
      dir,
      t4Payload(dir, today, `${observed}\nmine.\n`, 'tag'),
      's-tag-conf',
    );

    assert.equal(out.conflicts.length, 1, 'fixture must actually conflict');
    assert.equal(
      readFileSync(join(dir, 'SCHEMA.md'), 'utf-8'),
      schemaBefore,
      'a withheld close must not mutate SCHEMA.md behind the caller’s back',
    );
  });
});

// ── FEAT-11 self-edit provenance seam (PostToolUse → crystallize) ────────────
//
// The self-conflict a session hits when it edits an overwrite target DIRECTLY
// (Write/Edit tool) and then closes. SessionStart snapshots the base; the direct
// edit moves disk away from it; without provenance the close guard reads the
// session's own edit as another writer's and fails safe into a false proposal.
//
// This crosses the REAL process seam the unit tests skip: the actual
// hypo-auto-stage PostToolUse hook, invoked as a subprocess, is what must read
// `session_id` + `tool_input.file_path` from the payload and advance the base.
// The control arm (no hook run) reproduces the bug first, so the fix arm cannot
// pass for an unrelated reason.
// [[pages/learnings/mutation-check-invariants-a-passing-suite-cannot-see]]

suite('crystallize.mjs — self-edit provenance via PostToolUse hook (FEAT-11)');

// Run the real auto-stage hook the way Claude Code does: a subprocess fed a
// PostToolUse payload on stdin, with HYPO_DIR pinned to the test vault. toolName
// and content mirror what the real Write/Edit/Read payloads carry.
function runAutoStageHook(dir, sessionId, filePath, toolName = 'Edit', content = null) {
  const tool_input = { file_path: filePath };
  if (content !== null) tool_input.content = content;
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-stage.mjs')], {
    input: JSON.stringify({ session_id: sessionId, tool_name: toolName, tool_input }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir },
  });
}

test('session directly edits a target, the hook advances its base, close writes cleanly', () => {
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-selfedit', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');

    // the session edits the target itself, mid-session, with the Edit tool
    const edited = `${observed}\ndirectly edited by this session.\n`;
    writeFileSync(t4ProjectHot(dir), edited);
    const hook = runAutoStageHook(dir, 's-selfedit', t4ProjectHot(dir), 'Edit');
    assert.equal(hook.status, 0, `hook must not fail: ${hook.stderr}`);
    assert.equal(
      readBaseEntry(dir, 's-selfedit', t4Rel).hash,
      bsHashContent(edited),
      'the PostToolUse hook must advance the base to the bytes the session just wrote',
    );

    // close folds a further line onto that edit, so the payload differs from disk
    // and the guard is actually consulted (not short-circuited by idempotent skip)
    const closed = `${edited}\nand the close adds this.\n`;
    const { r, out } = t4Apply(dir, t4Payload(dir, today, closed, 'self-edit close'), 's-selfedit');

    assert.equal(
      r.status,
      0,
      `a provenance-backed close must succeed: ${JSON.stringify(out.conflicts)}`,
    );
    assert.deepEqual(out.conflicts, [], 'the session must not conflict against its own edit');
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), closed, 'the close payload must land');
  });
});

test('control: WITHOUT the hook the very same flow self-conflicts (bug reproduced)', () => {
  // Proves the hook subprocess is what prevents the conflict. Identical to the
  // test above except the auto-stage step is omitted, so the base never advances.
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-noprov', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');

    const edited = `${observed}\ndirectly edited by this session.\n`;
    writeFileSync(t4ProjectHot(dir), edited); // no hook → base stays at the pre-edit bytes

    const closed = `${edited}\nand the close adds this.\n`;
    const { r, out } = t4Apply(dir, t4Payload(dir, today, closed, 'no-prov close'), 's-noprov');

    assert.notEqual(r.status, 0, 'without provenance the close must fail safe');
    const c = out.conflicts.find((x) => x.target === t4Rel);
    assert.ok(c, `the self-edit must be misread as drift: ${JSON.stringify(out.conflicts)}`);
    assert.equal(c.reason, 'base-mismatch');
    assert.equal(
      readFileSync(t4ProjectHot(dir), 'utf-8'),
      edited,
      'a withheld close leaves the target at the session-edited bytes',
    );
  });
});

test('the hook does not advance the base for a write to a non-target wiki page', () => {
  // Scoping across the real process boundary: a Write/Edit to an ordinary wiki
  // page must not touch base.json, so the hook cannot widen the guard's surface.
  withWiki(null, (dir) => {
    snapshotBase(dir, 's-scope', overwriteTargets(T4_PROJECT));
    const before = readFileSync(bsBasePath(dir, 's-scope'), 'utf-8');
    mkdirSync(join(dir, 'pages'), { recursive: true });
    const note = join(dir, 'pages', 'a-random-note.md');
    writeFileSync(note, '# just a note\n');
    const hook = runAutoStageHook(dir, 's-scope', note, 'Edit');
    assert.equal(hook.status, 0, `hook must not fail: ${hook.stderr}`);
    assert.equal(
      readFileSync(bsBasePath(dir, 's-scope'), 'utf-8'),
      before,
      'a write to a non-target page must leave base.json byte-for-byte unchanged',
    );
  });
});

test('a NON-write tool (Read) on a drifted target must NOT advance the base', () => {
  // The guard-defeating path codex found: the hook has no matcher, so it fires on
  // every tool — including Read, whose tool_input also carries file_path. If Read
  // advanced the base, merely LOOKING at a page another session wrote would adopt
  // that other session's bytes as ours, and the close would clobber it with no
  // conflict. Only Write/Edit/MultiEdit may advance.
  withWiki(null, (dir, today) => {
    snapshotBase(dir, 's-read', overwriteTargets(T4_PROJECT));
    const observed = readFileSync(t4ProjectHot(dir), 'utf-8');
    const otherSession = `${observed}\nthe OTHER session wrote this.\n`;
    writeFileSync(t4ProjectHot(dir), otherSession); // B's write drifts disk from base

    // this session merely READS the drifted target
    const hook = runAutoStageHook(dir, 's-read', t4ProjectHot(dir), 'Read');
    assert.equal(hook.status, 0, `hook must not fail: ${hook.stderr}`);
    assert.equal(
      readBaseEntry(dir, 's-read', t4Rel).hash,
      bsHashContent(observed),
      'Read must leave the base at the pre-drift bytes — it is not a write',
    );

    // and the close must therefore still fail safe against B's write
    const mine = `${observed}\nmy stale payload.\n`;
    const { r, out } = t4Apply(dir, t4Payload(dir, today, mine, 'read-then-close'), 's-read');
    assert.notEqual(r.status, 0, 'a Read must not have licensed a clobber of B');
    const c = out.conflicts.find((x) => x.target === t4Rel);
    assert.ok(
      c && c.reason === 'base-mismatch',
      `B's write must still be protected: ${JSON.stringify(out.conflicts)}`,
    );
    assert.equal(readFileSync(t4ProjectHot(dir), 'utf-8'), otherSession, "B's write survives");
  });
});

test('a Write advances the base to the bytes it wrote, not a racy disk re-read', () => {
  // Race-safety: the Write tool carries its full content, so the hook advances to
  // THAT, not to whatever is on disk when the subprocess gets around to reading.
  // Simulated by handing the hook a payload whose content differs from the bytes
  // currently on disk (as if a concurrent write landed in between). The base must
  // track the payload content, so a close still detects the concurrent bytes.
  withWiki(null, (dir) => {
    snapshotBase(dir, 's-write', overwriteTargets(T4_PROJECT));
    const myContent = `${readFileSync(t4ProjectHot(dir), 'utf-8')}\nwhat THIS session's Write wrote.\n`;
    const raced = `${readFileSync(t4ProjectHot(dir), 'utf-8')}\na concurrent write that landed first.\n`;
    writeFileSync(t4ProjectHot(dir), raced); // disk != my Write's content

    const hook = runAutoStageHook(dir, 's-write', t4ProjectHot(dir), 'Write', myContent);
    assert.equal(hook.status, 0, `hook must not fail: ${hook.stderr}`);
    assert.equal(
      readBaseEntry(dir, 's-write', t4Rel).hash,
      bsHashContent(myContent),
      'Write must advance to its own content hash, never to the raced disk bytes',
    );
    assert.notEqual(
      readBaseEntry(dir, 's-write', t4Rel).hash,
      bsHashContent(raced),
      'the concurrent bytes must not become our base',
    );
  });
});

// ── hypo-shared.mjs — withFileLock (FEAT-11 T5) ──────────────────────────────
// The lock's guarantee is mutual exclusion (mechanism), not a green test. These
// deterministic unit tests pin acquire/release/steal/timeout; the concurrent
// smoke below exercises no-loss + exact-dedup across real processes.

suite('hypo-shared.mjs — withFileLock (FEAT-11 T5)');

const { withFileLock: wfl } = await import(`${REPO}/hooks/hypo-shared.mjs`);

test('holds the lock during the critical section and removes it after', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'log.md');
    const lockPath = `${target}.lock`;
    let lockedDuring = false;
    const ret = wfl(target, () => {
      lockedDuring = existsSync(lockPath);
      return 'done';
    });
    assert.equal(ret, 'done', 'returns the critical section result');
    assert.equal(lockedDuring, true, 'lock file exists while fn runs');
    assert.equal(existsSync(lockPath), false, 'lock file removed after release');
  });
});

test('steals a stale lock whose holder died (mtime older than staleMs)', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'log.md');
    const lockPath = `${target}.lock`;
    writeFileSync(lockPath, ''); // a dead holder's leftover lock
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old); // backdate well past the stale threshold
    let ran = false;
    wfl(
      target,
      () => {
        ran = true;
      },
      { staleMs: 1000, timeoutMs: 500 },
    );
    assert.equal(ran, true, 'stole the stale lock and ran');
    assert.equal(existsSync(lockPath), false, 'lock cleaned up after the run');
  });
});

test('throws lock-timeout when a fresh lock is held past timeoutMs', () => {
  withTmpDir((dir) => {
    const target = join(dir, 'log.md');
    const lockPath = `${target}.lock`;
    writeFileSync(lockPath, ''); // fresh mtime, never released
    assert.throws(
      () => wfl(target, () => {}, { timeoutMs: 200, staleMs: 60_000, pollMs: 20 }),
      /lock-timeout/,
      'gives up after timeoutMs instead of blocking forever (caller falls to proposal)',
    );
    assert.equal(existsSync(lockPath), true, 'the held lock is left intact, not stolen');
  });
});

test('does not hang when a STALE lock cannot be removed — times out instead', () => {
  // root ignores directory perms, and Windows chmod-on-dir doesn't block unlink,
  // so the unlink would succeed and there'd be nothing to time out against —
  // skip rather than assert a false negative.
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withTmpDir((dir) => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const target = join(sub, 'log.md');
    const lockPath = `${target}.lock`;
    writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old); // make it stale (steal-eligible)
    chmodSync(sub, 0o555); // dir non-writable → unlinkSync(lockPath) fails EACCES
    try {
      // Before the fix this spun forever (the broad catch swallowed the unlink
      // failure and `continue`d past the timeout check). It must now fall through
      // to the timeout and throw ELOCKTIMEOUT.
      assert.throws(
        () => wfl(target, () => {}, { staleMs: 1000, timeoutMs: 300, pollMs: 20 }),
        /lock-timeout/,
        'an un-removable stale lock must time out, not hang',
      );
    } finally {
      chmodSync(sub, 0o755); // restore so withTmpDir cleanup can remove it
    }
  });
});

// ── crystallize — concurrent append no-loss + exact-dedup (FEAT-11 T5) ────────
// Barrier-synchronized real processes: N workers each take the SAME file lock
// and append a distinct entry, plus one duplicate to prove dedup. Under the lock
// every distinct entry survives (no last-writer-wins drop) and the duplicate
// collapses to one. This is a smoke check — the no-loss guarantee rests on the
// lock's serialization, not on this test always tripping the race.
const T5_WORKER_SRC = `
import { withFileLock } from ${JSON.stringify(join(REPO, 'hooks', 'hypo-shared.mjs'))};
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const [, , target, entry, barrier] = process.argv;
const t0 = Date.now();
while (!existsSync(barrier) && Date.now() - t0 < 10000) { /* spin to the barrier */ }
withFileLock(target, () => {
  const cur = existsSync(target) ? readFileSync(target, 'utf-8') : '';
  if (cur.includes(entry)) return; // exact-entry dedup (matches appendIfAbsent)
  const sep = cur === '' ? '' : cur.endsWith('\\n') ? '' : '\\n';
  writeFileSync(target, cur + sep + entry + '\\n');
});
`;

function spawnT5Worker(workerPath, target, entry, barrier) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [workerPath, target, entry, barrier], { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
    p.on('error', reject);
  });
}

suite('crystallize — concurrent append (FEAT-11 T5)');

await testAsync('N concurrent appends lose nothing and dedup an exact duplicate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-t5-'));
  try {
    const workerPath = join(dir, 'worker.mjs');
    writeFileSync(workerPath, T5_WORKER_SRC);
    const target = join(dir, 'session-log.md');
    const N = 12;
    const ROUNDS = 3;
    for (let r = 0; r < ROUNDS; r++) {
      // Alternate the starting state so BOTH races run: an absent target makes
      // workers contend on create-under-lock; an existing (empty) target makes
      // them contend on append-under-lock.
      if (r % 2 === 0) rmSync(target, { force: true });
      else writeFileSync(target, '');
      const barrier = join(dir, `barrier-${r}`);
      // Entries are [[e0]]..[[eN-1]] (none a substring of another) plus a repeat
      // of [[e0]] to exercise dedup under contention.
      const entries = [];
      for (let i = 0; i < N; i++) entries.push(`[[e${i}]]`);
      entries.push('[[e0]]');
      const procs = entries.map((e) => spawnT5Worker(workerPath, target, e, barrier));
      writeFileSync(barrier, 'go'); // release all workers together
      await Promise.all(procs);
      const content = readFileSync(target, 'utf-8');
      for (let i = 0; i < N; i++) {
        assert.ok(content.includes(`[[e${i}]]`), `round ${r}: [[e${i}]] must survive (no-loss)`);
      }
      const dupCount = content.split('[[e0]]').length - 1;
      assert.equal(dupCount, 1, `round ${r}: duplicate [[e0]] deduped to exactly one`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FEAT-11 pending-proposal surface (T8) ────────────────────────────────────

suite('doctor.mjs / hypo-session-start.mjs — pending-proposal surface (FEAT-11 T8)');

// A valid vault root (config + the three scanned dirs) so rootOk=true and
// checkProposals actually runs — otherwise the check is silently skipped and the
// assertion passes vacuously.
function scaffoldVaultRoot(dir) {
  writeFileSync(join(dir, 'hypo-config.md'), '# config');
  mkdirSync(join(dir, 'pages'), { recursive: true });
  mkdirSync(join(dir, 'projects'), { recursive: true });
  mkdirSync(join(dir, 'sources'), { recursive: true });
}

test('FEAT-11 T8: doctor passes when no proposals are parked', () => {
  withTmpDir((dir) => {
    scaffoldVaultRoot(dir);
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Pending proposals');
    assert.ok(check, 'Pending proposals check not found');
    assert.equal(check.status, 'pass', `expected pass: ${check.detail}`);
  });
});

test('FEAT-11 T8: doctor warns with the count when proposals are parked', () => {
  withTmpDir((dir) => {
    scaffoldVaultRoot(dir);
    psWriteProposal(dir, {
      target: 'hot.md',
      baseHash: 'b',
      currentAtProposalHash: 'c',
      proposedContent: 'A',
      sessionId: 's',
      device: 'd',
    });
    psWriteProposal(dir, {
      target: join('pages', 'open-questions.md'),
      baseHash: 'b',
      currentAtProposalHash: 'c',
      proposedContent: 'Q',
      sessionId: 's',
      device: 'd',
    });
    const r = run('doctor.mjs', [`--hypo-dir=${dir}`, '--json']);
    const out = JSON.parse(r.stdout);
    const check = out.find((c) => c.label === 'Pending proposals');
    assert.ok(check, 'Pending proposals check not found');
    assert.equal(check.status, 'warn', `expected warn: ${check.detail}`);
    assert.ok(/\b2\b/.test(check.detail), `count 2 should appear: ${check.detail}`);
    // Surface only — doctor must not change the store.
    assert.equal(psListProposals(dir).length, 2, 'doctor must not change the proposal count');
  });
});

test('FEAT-11 T8: session-start surfaces the count on stderr and mutates nothing', () => {
  withTmpDir((dir) => {
    scaffoldVaultRoot(dir);
    const targetRel = join('pages', 'open-questions.md');
    const targetAbs = join(dir, targetRel);
    writeFileSync(targetAbs, '# open questions original\n');
    psWriteProposal(dir, {
      target: targetRel,
      baseHash: 'b',
      currentAtProposalHash: 'c',
      proposedContent: '# proposed replacement\n',
      sessionId: 's',
      device: 'd',
    });
    const beforeStore = JSON.stringify(
      psListProposals(dir).map((p) => ({ id: p.id, content: p.proposedContent })),
    );
    // A cwd that matches no project → MISS path, which exercises the same
    // path-independent stderr write as HIT. No session_id, so snapshotBase is a
    // no-op and the invariance assertion stays honest.
    const outside = mkdtempSync(join(tmpdir(), 'hypo-t8-cwd-'));
    try {
      const r = runHook('hypo-session-start.mjs', { cwd: outside }, { HYPO_DIR: dir });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(/대기 proposal 1건/.test(r.stderr), `expected the count line: ${r.stderr}`);
      assert.equal(
        readFileSync(targetAbs, 'utf-8'),
        '# open questions original\n',
        'surface must not touch the target page',
      );
      assert.equal(
        JSON.stringify(psListProposals(dir).map((p) => ({ id: p.id, content: p.proposedContent }))),
        beforeStore,
        'surface must not change the proposal store',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('FEAT-11 T8: session-start emits no proposal line when none are parked', () => {
  withTmpDir((dir) => {
    scaffoldVaultRoot(dir);
    const outside = mkdtempSync(join(tmpdir(), 'hypo-t8-cwd-'));
    try {
      const r = runHook('hypo-session-start.mjs', { cwd: outside }, { HYPO_DIR: dir });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.ok(!/대기 proposal/.test(r.stderr), `no proposal line expected: ${r.stderr}`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── ISSUE-49: transcript-approved apply ──────────────────────────────────────
//
// A parked proposal could only be resolved on a TTY, so an agent-driven close
// dead-ended and the only way to finish was to bypass the store with a direct
// write. The approval now travels over the TRANSCRIPT instead of stdin. These
// tests pin the thing that makes that safe: the ONLY accepted approval is a turn
// the USER typed. Every other way the phrase can appear in a transcript — the
// model's own words, an injected skill body, a click — must refuse.
suite('ISSUE-49 — transcript-approved apply');

// One parked proposal + a challenge, with the transcript shapes each test needs.
function withParkedProposal(fn) {
  withTmpDir((dir) => {
    const rel = join('projects', 'demo', 'session-state.md');
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'THEIR bytes\n');
    const parked = psWriteProposal(dir, {
      target: rel,
      baseHash: null,
      currentAtProposalHash: hashProposalContent('THEIR bytes\n'),
      proposedContent: 'MY merged handoff\n',
      sessionId: 'sess-1',
      device: 'd7',
    });
    const ch = challengeProposals(
      { hypoDir: dir, sessionId: 'sess-1', ids: [parked.id] },
      { stdout: capStream(), stderr: capStream(), now: () => '2026-07-13T00:00:00.000Z' },
    );
    // The phrase reaches the transcript in five shapes; only one is a real user turn.
    const line = (o) => `${JSON.stringify(o)}\n`;
    const phrase = `apply-proposals ${ch.nonce}`;
    const transcripts = {
      user: line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: phrase }] },
      }),
      // The model tells the user WHAT to type. Its own message carries the phrase.
      assistant: line({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `Please type ${phrase}` }] },
      }),
      // A skill / slash-command body that quotes the phrase (isMeta).
      meta: line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: `docs: ${phrase}` }] },
      }),
      // An AskUserQuestion answer. The model authors the option labels AFTER seeing
      // the nonce, so a click is not approval of this phrase.
      click:
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'AskUserQuestion', input: {} }],
          },
        }) +
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: `Your questions have been answered: "Approve?"="${phrase}".`,
              },
            ],
          },
        }),
      // A tool_result that merely CONTAINS the phrase (e.g. a Read of a file).
      toolResult: line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: phrase }],
        },
      }),
      // A REFUSAL that quotes the phrase on its own line. The user is told to type this
      // phrase, so quoting it back while hesitating is the natural thing to do — and any
      // line-level matcher reads the indented line as consent, which turns a refusal into
      // an authorization. String content: the shape a genuinely typed turn actually takes.
      quoted: line({
        type: 'user',
        message: {
          role: 'user',
          content: `I do not consent; I am only quoting the command:\n    ${phrase}`,
        },
      }),
      // The same hole reached by asking rather than refusing. Block content, so both
      // extraction paths are covered.
      asking: line({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `Is this the command you mean?\n\n${phrase}` }],
        },
      }),
    };
    const paths = {};
    for (const [k, v] of Object.entries(transcripts)) {
      paths[k] = join(dir, `t-${k}.jsonl`);
      writeFileSync(paths[k], v);
    }
    const resolve = (tPath) =>
      resolveProposals(
        { hypoDir: dir, sessionId: 'sess-1' },
        { transcriptPath: tPath, stdout: capStream(), stderr: capStream() },
      );
    fn({ dir, rel, target, parked, nonce: ch.nonce, t: paths, resolve });
  });
}

test('ISSUE-49: a user-typed approval applies the batch (the dead-end is gone)', () => {
  withParkedProposal(({ target, parked, t, resolve, dir }) => {
    const r = resolve(t.user);
    assert.equal(r.ok, true, `should apply: ${JSON.stringify(r)}`);
    assert.equal(readFileSync(target, 'utf-8'), 'MY merged handoff\n', 'the approved bytes landed');
    assert.equal(psReadProposal(dir, parked.id), null, 'the artifact is consumed');
  });
});

// The gate's whole safety rests on this: every OTHER way the phrase can reach a
// transcript must refuse. If any of these ever flips to `true`, an unattended
// process (or the model itself) can approve its own overwrite.
for (const [shape, why] of [
  ['assistant', "the model's own words are not the user's"],
  ['meta', 'an injected skill/command body cannot self-satisfy the gate'],
  ['click', 'a click is not approval of a phrase the model authored'],
  ['toolResult', 'tool output that merely contains the phrase is not approval'],
  ['quoted', 'a refusal that quotes the phrase on its own line is not approval'],
  ['asking', 'a question whose body is the phrase is not approval'],
]) {
  test(`ISSUE-49: ${shape} phrase is refused — ${why}`, () => {
    withParkedProposal(({ target, t, resolve }) => {
      const r = resolve(t[shape]);
      assert.equal(r.ok, false, `${shape} must not approve`);
      assert.equal(r.reason, 'not-approved');
      assert.equal(
        readFileSync(target, 'utf-8'),
        'THEIR bytes\n',
        'the other session is preserved',
      );
    });
  });
}

// The challenge for sess-1 EXISTS, so this reaches transcript resolution and fails
// there — the point of the test. (Naming an unknown session would have bailed at
// `no-challenge` and proved nothing about the transcript path.)
test('ISSUE-49: an unresolvable transcript refuses (never assumes approval)', () => {
  withParkedProposal(({ dir, target }) => {
    const r = resolveProposals(
      { hypoDir: dir, sessionId: 'sess-1' },
      // No transcriptPath, and the real resolver globs a ~/.claude/projects that has
      // no sess-1.jsonl, so it returns null.
      { stdout: capStream(), stderr: capStream() },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'transcript-unresolved', 'it failed AT transcript resolution');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n');
  });
});

test('ISSUE-49: the approval is spent once (replay of the same turn refuses)', () => {
  withParkedProposal(({ t, resolve, target }) => {
    assert.equal(resolve(t.user).ok, true, 'first resolve applies');
    const again = resolve(t.user);
    assert.equal(again.ok, false, 'the same transcript cannot buy a second write');
    assert.equal(again.reason, 'no-challenge', 'because the challenge was consumed');
    assert.equal(readFileSync(target, 'utf-8'), 'MY merged handoff\n');
  });
});

// Drive the REAL matcher (no injected hasApproval): a transcript where the user
// typed a perfectly well-formed approval line for a DIFFERENT challenge.
test('ISSUE-49: a nonce from another challenge does not approve this one', () => {
  withParkedProposal(({ dir, target }) => {
    const foreign = join(dir, 't-foreign.jsonl');
    writeFileSync(
      foreign,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `apply-proposals ${'f'.repeat(32)}` }],
        },
      })}\n`,
    );
    const r = resolveProposals(
      { hypoDir: dir, sessionId: 'sess-1' },
      { transcriptPath: foreign, stdout: capStream(), stderr: capStream() },
    );
    assert.equal(r.ok, false, 'only THIS challenge’s nonce counts');
    assert.equal(r.reason, 'not-approved');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n');
  });
});

// Containment would turn a REFUSAL into an approval. The TTY channel has always
// demanded an exact `apply <id>`; the transcript channel must not be looser.
test('ISSUE-49: a line that merely CONTAINS the phrase is not approval', () => {
  withParkedProposal(({ dir, nonce, target }) => {
    for (const said of [
      `do not apply-proposals ${nonce}`,
      `why would I type apply-proposals ${nonce}?`,
      `apply-proposals ${nonce} is the thing I am NOT doing`,
    ]) {
      const p = join(dir, `t-said-${said.length}.jsonl`);
      writeFileSync(
        p,
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: said }] },
        })}\n`,
      );
      assert.equal(
        hasTypedUserApproval(p, nonce),
        false,
        `"${said}" must not read as consent to overwrite`,
      );
      const r = resolveProposals(
        { hypoDir: dir, sessionId: 'sess-1' },
        { transcriptPath: p, stdout: capStream(), stderr: capStream() },
      );
      assert.equal(r.ok, false);
      assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n');
    }
  });
});

// The nonce IS the approval, so one that outlives its own resolve is a second key.
// "The pages are written" and "the approval is spent" are different claims; exiting
// 0 would assert both while only the first is true.
// The approval lives in an append-only transcript, so the user's typed line never
// expires: deleting the challenge is the ONLY thing that makes the approval single-use.
// Spending it AFTER the write would already have lost — a failed delete left a live
// nonce behind, and the model could re-run resolve later and write again with no fresh
// human turn. So the challenge is spent BEFORE the write, and a challenge that cannot
// be spent writes NOTHING.
test('ISSUE-49: a challenge that cannot be consumed writes nothing at all', () => {
  withParkedProposal(({ dir, t, target }) => {
    // Make the challenge undeletable by turning its parent into a read-only dir.
    const chDir = join(psProposalsDir(dir), 'challenges');
    chmodSync(chDir, 0o500);
    try {
      const r = resolveProposals(
        { hypoDir: dir, sessionId: 'sess-1' },
        { transcriptPath: t.user, stdout: capStream(), stderr: capStream() },
      );
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'challenge-not-consumed');
      assert.equal(r.challengeSpent, false);
      assert.deepEqual(r.written, [], 'nothing was written');
      assert.equal(
        readFileSync(target, 'utf-8'),
        'THEIR bytes\n',
        'the page is untouched: an approval that cannot be spent does not authorize a write',
      );
    } finally {
      chmodSync(chDir, 0o700);
    }
  });
});

// Isolates WHY a replay refuses. The spent-once test above leaves BOTH the target holding
// the applied bytes AND the artifact consumed, so freshness or a missing proposal would
// refuse a second apply even if the challenge had survived. Put the whole world back —
// target bytes and artifact — so every other check would PASS, leaving the spent challenge
// as the only thing between the append-only approval line and a second write. It has to be
// enough on its own.
test('ISSUE-49: a spent challenge refuses a replay even when the world is put back', () => {
  withParkedProposal(({ dir, parked, t, target, resolve }) => {
    const artifact = join(psProposalsDir(dir), `${parked.id}.json`);
    const artifactBytes = readFileSync(artifact, 'utf-8');

    const r = resolve(t.user);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(target, 'utf-8'), 'MY merged handoff\n');

    writeFileSync(target, 'THEIR bytes\n');
    writeFileSync(artifact, artifactBytes);
    const again = resolveProposals(
      { hypoDir: dir, sessionId: 'sess-1' },
      { transcriptPath: t.user, stdout: capStream(), stderr: capStream() },
    );
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'no-challenge', 'the nonce is spent; a second apply must remint');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n', 'no second write');
  });
});

// `unlink` is the mutual exclusion between concurrent resolvers: exactly one wins, the
// loser gets ENOENT. Reading "already gone" as a successful spend would tell BOTH they held
// the approval, and the user's single yes would buy two write batches. Only the caller
// whose unlink SUCCEEDED may write.
test('ISSUE-49: consuming a challenge twice succeeds once — ENOENT is a loss, not a win', () => {
  withParkedProposal(({ dir, nonce }) => {
    assert.equal(consumeChallenge(dir, 'sess-1', nonce), true, 'the winner spends it');
    assert.equal(
      consumeChallenge(dir, 'sess-1', nonce),
      false,
      'the loser must NOT read an absent challenge as its own successful spend',
    );
  });
});

// The consume must claim the NONCE it was authorized against, not whatever record happens
// to occupy the session's path. Keying the file by session alone, a resolver holding N1
// could unlink the record a concurrent `challenge` had just minted (N2) and then write the
// N1 batch anyway: one typed approval buys two write batches, and N2 is spent without ever
// being approved. It also has to honour supersession — the moment a fresh challenge is
// minted, the old nonce must stop working.
test('ISSUE-49: a superseded nonce cannot consume the challenge that replaced it', () => {
  withParkedProposal(({ dir, parked, nonce, target, t }) => {
    // A resolver is mid-flight holding N1 when `challenge` remints. N2 now stands.
    const second = challengeProposals(
      { hypoDir: dir, sessionId: 'sess-1', ids: [parked.id] },
      { stdout: capStream(), stderr: capStream(), now: () => '2026-07-13T01:00:00.000Z' },
    );
    assert.notEqual(second.nonce, nonce, 'a remint mints a different nonce');

    assert.equal(
      consumeChallenge(dir, 'sess-1', nonce),
      false,
      'the stale nonce must not consume the record that superseded it',
    );
    assert.equal(
      psReadChallenge(dir, 'sess-1')?.nonce,
      second.nonce,
      'and the fresh challenge is still standing, unspent',
    );

    // End to end: the old approval line in the transcript is now worthless.
    const r = resolveProposals(
      { hypoDir: dir, sessionId: 'sess-1' },
      { transcriptPath: t.user, stdout: capStream(), stderr: capStream() },
    );
    assert.equal(r.ok, false, 'the superseded approval buys nothing');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n', 'the page is untouched');
  });
});

// `hypoDir` arrives straight from `--hypo-dir` and may be relative (`.`). Every challenge
// path must be produced by one resolution or the same file gets two names: minted under the
// absolute path, looked for under the relative one, found nowhere. The gate then refuses a
// real approval forever — safe, but the feature is dead.
test('ISSUE-49: a relative --hypo-dir can still mint, read, and spend a challenge', () => {
  withParkedProposal(({ dir, parked, t }) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const ch = challengeProposals(
        { hypoDir: '.', sessionId: 'sess-1', ids: [parked.id] },
        { stdout: capStream(), stderr: capStream(), now: () => '2026-07-13T02:00:00.000Z' },
      );
      assert.equal(ch.ok, true, 'the mint works');
      assert.equal(psReadChallenge('.', 'sess-1')?.nonce, ch.nonce, 'and it can be read back');
      assert.equal(consumeChallenge('.', 'sess-1', ch.nonce), true, 'and spent');
    } finally {
      process.chdir(cwd);
    }
    // The original absolute-path challenge is unaffected by any of that.
    assert.equal(psReadChallenge(dir, 'sess-1'), null, 'the remint superseded the first one');
    assert.ok(t.user);
  });
});

// Two records under one session read as NO approval (readChallenge cannot know which nonce
// the user was shown). So a mint that cannot remove the record it supersedes must FAIL:
// announcing a fresh nonce on top of a stale one hands the user a nonce that can never be
// spent, and every later remint strands the session deeper.
test('ISSUE-49: a mint that cannot supersede the old record fails instead of stranding', () => {
  withParkedProposal(({ dir, parked, nonce }) => {
    // An undeletable stale record: a DIRECTORY where the old challenge file was.
    const chDir = join(psProposalsDir(dir), 'challenges');
    rmSync(join(chDir, `sess-1.${nonce}.json`));
    mkdirSync(join(chDir, `sess-1.${nonce}.json`), { recursive: true });

    const r = challengeProposals(
      { hypoDir: dir, sessionId: 'sess-1', ids: [parked.id] },
      { stdout: capStream(), stderr: capStream(), now: () => '2026-07-13T03:00:00.000Z' },
    );
    assert.equal(r.ok, false, 'the mint must not claim success');
    assert.equal(r.reason, 'challenge-store-failed');
  });
});

// The symlinked-store defense has to run BEFORE the scan reads the directory, not after it
// has already listed and parsed what it found there. And it must anchor to the VAULT, not
// to the store: a check that resolves the challenges dir against `realpath(proposalsDir)`
// follows a redirected `.cache/proposals` out of the vault and then agrees with itself.
for (const [what, redirect] of [
  ['challenges', (dir) => join(psProposalsDir(dir), 'challenges')],
  ['.cache/proposals', (dir) => psProposalsDir(dir)],
]) {
  test(`ISSUE-49: a redirected ${what} dir is never read from or consumed`, () => {
    withParkedProposal(({ dir, nonce }) => {
      const link = redirect(dir);
      const elsewhere = join(dir, 'elsewhere');
      // Stage a challenge that WOULD authorize the write, if the escape were followed.
      const planted = what === 'challenges' ? elsewhere : join(elsewhere, 'challenges');
      mkdirSync(planted, { recursive: true });
      writeFileSync(
        join(planted, `sess-1.${nonce}.json`),
        JSON.stringify({ nonce, sessionId: 'sess-1', items: [{ id: 'x' }] }),
      );
      rmSync(link, { recursive: true, force: true });
      symlinkSync(elsewhere, link);

      assert.equal(psReadChallenge(dir, 'sess-1'), null, 'nothing is read out of the redirect');
      assert.equal(
        consumeChallenge(dir, 'sess-1', nonce),
        false,
        'and nothing out there is consumed',
      );
      assert.equal(
        existsSync(join(planted, `sess-1.${nonce}.json`)),
        true,
        'the planted record is left untouched — it was never ours to unlink',
      );
    });
  });
}

// A write can land and then have its audit append or its artifact removal fail. Reporting
// that item as unwritten would tell the user their page is untouched when it has already
// been overwritten. Understating a write is the one lie this tool must never tell.
test('ISSUE-49: a post-write failure still reports the bytes as landed', () => {
  withParkedProposal(({ dir, t, target }) => {
    // Make the audit log unwritable: the target write lands, the log append does not.
    const log = join(psProposalsDir(dir), 'applied.log');
    mkdirSync(log, { recursive: true }); // a directory where a file must be appended

    const r = resolveProposals(
      { hypoDir: dir, sessionId: 'sess-1' },
      { transcriptPath: t.user, stdout: capStream(), stderr: capStream() },
    );
    assert.equal(readFileSync(target, 'utf-8'), 'MY merged handoff\n', 'the bytes DID land');
    assert.equal(r.ok, false, 'and the run is not clean');
    assert.deepEqual(r.landed, ['projects/demo/session-state.md'], 'the report says so');
  });
});

// The artifact body is hand-editable and apply writes to whatever `target` says AT
// APPLY TIME. Binding only the id and the bytes would let the approved payload land
// on a path the user never reviewed.
test('ISSUE-49: swapping the artifact target after approval refuses the batch', () => {
  withParkedProposal(({ dir, parked, t, resolve, target }) => {
    const artifact = join(psProposalsDir(dir), `${parked.id}.json`);
    const body = JSON.parse(readFileSync(artifact, 'utf-8'));
    body.target = 'hot.md'; // same id, same approved bytes, DIFFERENT page
    writeFileSync(artifact, JSON.stringify(body));

    const r = resolve(t.user);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'target-changed');
    assert.equal(existsSync(join(dir, 'hot.md')), false, 'the unapproved page was never created');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n');
  });
});

test('ISSUE-49: swapping the artifact content after approval refuses the batch', () => {
  withParkedProposal(({ dir, parked, t, resolve, target }) => {
    const artifact = join(psProposalsDir(dir), `${parked.id}.json`);
    const body = JSON.parse(readFileSync(artifact, 'utf-8'));
    body.proposedContent = 'BYTES THE USER NEVER SAW\n';
    writeFileSync(artifact, JSON.stringify(body));

    const r = resolve(t.user);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'content-changed');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n');
  });
});

// The approval names the bytes it was shown. If the page moves between the diff and
// the resolve, the approval no longer describes the write.
test('ISSUE-49: a target that moved after the diff refuses (stale approval)', () => {
  withParkedProposal(({ target, t, resolve }) => {
    writeFileSync(target, 'a THIRD session wrote here\n');
    const r = resolve(t.user);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'stale-approval');
    assert.equal(
      readFileSync(target, 'utf-8'),
      'a THIRD session wrote here\n',
      'the newest writer is preserved, not clobbered by a stale approval',
    );
  });
});

test('ISSUE-49: a missing or corrupt challenge is a remint, never a bypass', () => {
  withParkedProposal(({ dir, t, target }) => {
    const chPath = join(psProposalsDir(dir), 'challenges', 'sess-1.json');
    writeFileSync(chPath, '{ not json');
    const r = resolveProposals(
      { hypoDir: dir, sessionId: 'sess-1' },
      { transcriptPath: t.user, stdout: capStream(), stderr: capStream() },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-challenge');
    assert.equal(readFileSync(target, 'utf-8'), 'THEIR bytes\n');
  });
});

// hasTypedUserApproval must not become a wildcard when handed a degenerate nonce.
test('ISSUE-49: hasTypedUserApproval pins the nonce shape (no wildcard match)', () => {
  withParkedProposal(({ t, nonce }) => {
    assert.equal(hasTypedUserApproval(t.user, nonce), true, 'the real nonce matches');
    assert.equal(hasTypedUserApproval(t.user, ''), false, 'an empty nonce is not a wildcard');
    assert.equal(hasTypedUserApproval(t.user, 'short'), false, 'a non-nonce string is refused');
    assert.equal(hasTypedUserApproval(t.assistant, nonce), false, 'assistant text never counts');
  });
});

// The gate is only as good as the promise that nothing automated reaches it. Scan
// EXECUTABLE code, not prose: a doc comment naming the command is documentation, a
// call is a bypass. (hypo-shared legitimately DEFINES the approval matcher; what it
// must never do is drive an apply.)
test('ISSUE-49: no hook invokes an apply path — approval is a human’s, never a hook’s', () => {
  const hooksDir = join(REPO, 'hooks');
  for (const name of readdirSync(hooksDir)) {
    if (!name.endsWith('.mjs')) continue;
    const code = readFileSync(join(hooksDir, name), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.equal(
      /scripts\/proposal\.mjs/.test(code),
      false,
      `${name} must not reach into the apply CLI`,
    );
    assert.equal(
      /\b(resolveProposals|challengeProposals|applyProposal|writeApprovedProposal)\s*\(/.test(code),
      false,
      `${name} must not call an apply actor`,
    );
  }
});
