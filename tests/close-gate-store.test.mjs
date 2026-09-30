// tests/close-gate-store.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, suite } from './harness.mjs';
import { withTmpDir } from './helpers.mjs';
import {
  closeGatePath,
  closeGateStatus,
  hostTagWarningWithUndo,
  readResolution,
  recordGateClosed,
  resolutionStamp,
} from '../hooks/close-gate-store.mjs';
import { sessionClosedMarkerPath } from '../hooks/hypo-shared.mjs';
import { receiptPath } from '../hooks/close-receipt.mjs';

const SESSION = 'sess-1';

/** Build a raw transcript from a list of records (each JSON.stringify'd, one per line). */
function raw(...records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function writeRawFile(hypoDir, sessionId, obj) {
  const path = closeGatePath(hypoDir, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof obj === 'string' ? obj : JSON.stringify(obj));
}

suite('close-gate-store (resolution record, deny-only)');

test('closeGatePath: <hypoDir>/.cache/close-gate/<sessionId>.json', () => {
  assert.equal(
    closeGatePath('/vault', 'sess-1'),
    join('/vault', '.cache', 'close-gate', 'sess-1.json'),
  );
});

// --- record definition (must match the walk in hooks/hypo-shared.mjs) ---

test('resolutionStamp: bare null and blank lines do not advance the index', () => {
  const t = raw({ a: 1 }) + '\n' + 'null\n' + raw({ a: 2 });
  const stamp = resolutionStamp(Buffer.from(t, 'utf-8'));
  assert.equal(stamp.index, 2);
});

test('resolutionStamp: a non-object line (string, number) is skipped, not counted', () => {
  const t = '"hello"\n42\n' + raw({ a: 1 });
  const stamp = resolutionStamp(Buffer.from(t, 'utf-8'));
  assert.equal(stamp.index, 1);
});

test('resolutionStamp: an unparseable non-blank line is a fatal failure (null)', () => {
  const t = raw({ a: 1 }) + 'not json{\n' + raw({ a: 2 });
  assert.equal(resolutionStamp(Buffer.from(t, 'utf-8')), null);
});

// --- round trip, append safety, rewrite detection (b/c/d/e from the task) ---

test('readResolution: writing then reading a resolution round-trips and matches', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 }, { a: 3 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    assert.equal(recordGateClosed(hypoDir, SESSION, stamp), true);

    const resolved = readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8'));
    assert.equal(resolved.closedAtIndex, stamp.index);
    assert.equal(resolved.prefixMatches, true);
  });
});

test('readResolution: appending records after the resolution keeps prefixMatches true', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    recordGateClosed(hypoDir, SESSION, stamp);

    const appended = transcript + raw({ a: 3 }, { a: 4 });
    const resolved = readResolution(hypoDir, SESSION, Buffer.from(appended, 'utf-8'));
    assert.equal(resolved.closedAtIndex, stamp.index);
    assert.equal(resolved.prefixMatches, true, 'append is not a rewrite');
  });
});

test('readResolution: mutating a byte inside the resolved prefix flips prefixMatches to false', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    recordGateClosed(hypoDir, SESSION, stamp);

    const mutated = raw({ a: 999 }, { a: 2 }); // same shape, different byte in record 1
    const resolved = readResolution(hypoDir, SESSION, Buffer.from(mutated, 'utf-8'));
    assert.equal(resolved.prefixMatches, false);
  });
});

test('readResolution: inserting a record ahead of the resolved prefix flips prefixMatches to false', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    recordGateClosed(hypoDir, SESSION, stamp);

    const rewritten = raw({ summary: true }) + transcript; // e.g. a compaction summary line
    const resolved = readResolution(hypoDir, SESSION, Buffer.from(rewritten, 'utf-8'));
    assert.equal(resolved.prefixMatches, false);
  });
});

// --- (a) absence, (b) corruption/version/session mismatch: all "no constraint" ---

const NO_CONSTRAINT = { closedAtIndex: null, prefixMatches: null };

test('readResolution: a missing file is no constraint', () => {
  withTmpDir((hypoDir) => {
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(raw({ a: 1 }), 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: malformed JSON in the file is no constraint', () => {
  withTmpDir((hypoDir) => {
    writeRawFile(hypoDir, SESSION, 'not json at all{');
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(raw({ a: 1 }), 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: v !== 1 is no constraint', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    writeRawFile(hypoDir, SESSION, {
      v: 2,
      sessionId: SESSION,
      closedAtIndex: stamp.index,
      closedPrefixSha: stamp.prefixSha,
    });
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: a resolution recorded for a different sessionId is no constraint', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    recordGateClosed(hypoDir, 'sess-other', stamp);
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

// --- (f) polarity: a forged file with only an "open" key answers like no file at all ---

test('readResolution: {open:true} alone is no constraint, same as an absent file', () => {
  withTmpDir((hypoDir) => {
    writeRawFile(hypoDir, SESSION, { open: true });
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(raw({ a: 1 }), 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: {granted:true} alone is no constraint, same as an absent file', () => {
  withTmpDir((hypoDir) => {
    writeRawFile(hypoDir, SESSION, { granted: true });
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(raw({ a: 1 }), 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: a future humanTurnAt alone is no constraint, same as an absent file', () => {
  withTmpDir((hypoDir) => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    writeRawFile(hypoDir, SESSION, { humanTurnAt: future });
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(raw({ a: 1 }), 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: {fresh:true} alone is no constraint, same as an absent file', () => {
  withTmpDir((hypoDir) => {
    writeRawFile(hypoDir, SESSION, { fresh: true });
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(raw({ a: 1 }), 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: a valid record ignores an extra open:true key riding along with it', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    writeRawFile(hypoDir, SESSION, {
      v: 1,
      sessionId: SESSION,
      closedAtIndex: stamp.index,
      closedPrefixSha: stamp.prefixSha,
      open: true, // must have zero effect
    });
    const resolved = readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8'));
    assert.equal(resolved.closedAtIndex, stamp.index);
    assert.equal(resolved.prefixMatches, true);
  });
});

// --- F1 (BLOCKER fix): closedAtIndex must be a verified positive integer,
// not merely a number `resolutionStamp` happens to accept as upToIndex ---

test('readResolution: a forged closedAtIndex:0, even with the hash resolutionStamp(t,0) actually produces, is no constraint', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 });
    // Before the fix, resolutionStamp(t, 0) broke immediately after counting
    // record 1 (`index (1) >= upToIndex (0)`), so its prefixSha equalled the
    // FULL, honest one-record stamp — closedAtIndex:0 forged with that hash
    // used to read back as prefixMatches:true, i.e. the same sha as a real
    // close of the whole transcript. closedAtIndex must reject 0 outright.
    const zeroStamp = resolutionStamp(Buffer.from(transcript, 'utf-8'), 0);
    writeRawFile(hypoDir, SESSION, {
      v: 1,
      sessionId: SESSION,
      closedAtIndex: 0,
      closedPrefixSha: zeroStamp.prefixSha,
    });
    assert.deepEqual(
      readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8')),
      NO_CONSTRAINT,
    );
  });
});

test('readResolution: a forged closedAtIndex naming more records than the transcript actually has is denied, not granted', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }); // exactly 1 real record
    // resolutionStamp(Buffer.from(transcript, 'utf-8'), 3) cannot reach record 3 (there is only 1),
    // so it exhausts the transcript and returns index:1 — a forger who hashes
    // that same walk and claims closedAtIndex:3 must not read back as valid.
    const threeStamp = resolutionStamp(Buffer.from(transcript, 'utf-8'), 3);
    writeRawFile(hypoDir, SESSION, {
      v: 1,
      sessionId: SESSION,
      closedAtIndex: 3,
      closedPrefixSha: threeStamp.prefixSha,
    });
    const resolved = readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8'));
    assert.equal(resolved.prefixMatches, false);
  });
});

test('readResolution: a negative or non-integer closedAtIndex is no constraint', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      writeRawFile(hypoDir, SESSION, {
        v: 1,
        sessionId: SESSION,
        closedAtIndex: bad,
        closedPrefixSha: stamp.prefixSha,
      });
      assert.deepEqual(
        readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8')),
        NO_CONSTRAINT,
        `closedAtIndex=${bad}`,
      );
    }
  });
});

// --- F2 (BLOCKER fix): the hash is over raw BYTES, not a decoded string ---

test('resolutionStamp: two different invalid-UTF-8 byte sequences that decode to the SAME string (both fold to U+FFFD) hash differently', () => {
  const b80 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0x80]), Buffer.from('"}\n')]);
  const b81 = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0x81]), Buffer.from('"}\n')]);
  // Both invalid bytes decode to the identical JS string (U+FFFD replacement
  // character), so a hash computed over the DECODED string would collide.
  assert.equal(b80.toString('utf-8'), b81.toString('utf-8'));
  const stamp80 = resolutionStamp(b80);
  const stamp81 = resolutionStamp(b81);
  assert.equal(stamp80.index, 1);
  assert.equal(stamp81.index, 1);
  assert.notEqual(stamp80.prefixSha, stamp81.prefixSha);
});

// --- S1 (codex round 3 BLOCKER fix): the WRITE side must refuse a lossy
// stamp too, not only the read side. A stamp built from a decoded string
// already points at whatever a lossy decode folded the bytes into, so no
// amount of Buffer-only checking on the READ side can undo it once such a
// stamp is on disk. ---

test('resolutionStamp: a string input is refused (null), the same answer any other non-Buffer gets', () => {
  assert.equal(resolutionStamp('{"a":1}\n'), null);
});

test('recordGateClosed: a stamp built from a string can never land on disk, so the original bytes are never denied in favor of a string-folded rewrite', () => {
  withTmpDir((hypoDir) => {
    // The exact a/b pair from the report: two distinct invalid-UTF-8 bytes
    // that both decode to U+FFFD under 'utf-8'.
    const a = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0x80]), Buffer.from('"}\n')]);
    const b = Buffer.from(a.toString('utf8'), 'utf8'); // the string-folded rewrite of `a`
    assert.notDeepEqual(a, b, 'a rewrite must actually change the bytes on disk');

    // Attempting to build the stamp from a DECODED STRING of `a` must fail:
    // resolutionStamp(string) is null, so recordGateClosed's own null-stamp
    // guard refuses to write anything at all.
    const lossyStamp = resolutionStamp(a.toString('utf8'));
    assert.equal(lossyStamp, null);
    assert.equal(recordGateClosed(hypoDir, SESSION, lossyStamp), false);

    // With nothing on disk, verifying against EITHER the rewritten bytes or
    // the original ones reads as "no constraint", never as a false match on
    // the rewrite.
    assert.deepEqual(readResolution(hypoDir, SESSION, b), NO_CONSTRAINT);
    assert.deepEqual(readResolution(hypoDir, SESSION, a), NO_CONSTRAINT);

    // The only way to get a real resolution on disk is to stamp the ACTUAL
    // bytes, and that must deny the rewrite while accepting the original.
    recordGateClosed(hypoDir, SESSION, resolutionStamp(a));
    assert.equal(readResolution(hypoDir, SESSION, b).prefixMatches, false);
    assert.equal(readResolution(hypoDir, SESSION, a).prefixMatches, true);
  });
});

// --- R1 (codex round 2 BLOCKER fix): a string rawTranscript must never reach
// prefixMatches:true, because re-encoding a string back to a Buffer cannot
// recover a genuine invalid-UTF-8 rewrite that a lossy decode already erased ---

test('readResolution: a string rawTranscript is refused (prefixMatches:false) even when the record it is compared to used the SAME lossy round trip', () => {
  withTmpDir((hypoDir) => {
    // Two byte sequences that both decode to U+FFFD under 'utf-8', so a
    // string-based comparison sees them as identical text.
    const a = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d, 0x0a]);
    const b = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0x81, 0x22, 0x7d, 0x0a]);
    assert.equal(a.toString('utf8'), b.toString('utf8'));
    recordGateClosed(hypoDir, SESSION, resolutionStamp(Buffer.from(a.toString('utf8'), 'utf-8')));
    // Passing a STRING here (not the Buffer b) must never read as a match,
    // regardless of what the stored resolution was computed from.
    const resolved = readResolution(hypoDir, SESSION, b.toString('utf8'));
    assert.equal(resolved.prefixMatches, false);
  });
});

test('readResolution: accepts a Buffer transcript and round-trips exactly like a string one', () => {
  withTmpDir((hypoDir) => {
    const transcriptStr = raw({ a: 1 }, { a: 2 });
    const transcriptBuf = Buffer.from(transcriptStr, 'utf-8');
    const stamp = resolutionStamp(transcriptBuf);
    recordGateClosed(hypoDir, SESSION, stamp);
    const resolved = readResolution(hypoDir, SESSION, transcriptBuf);
    assert.equal(resolved.closedAtIndex, stamp.index);
    assert.equal(resolved.prefixMatches, true);
  });
});

// --- T1 (main-found BLOCKER fix): the "rejected" sentinel must survive a
// JSON round trip. Infinity does not: JSON.stringify(Infinity) is the
// literal null, which collides with this module's OWN "no constraint"
// sentinel. A hook's stdout and crystallize's --check-session-close JSON
// output both put this value through exactly that round trip, so an
// in-memory-only fix is not a fix. Every assertion below checks BEFORE and
// AFTER the round trip, because checking only "after" cannot tell a value
// that survived from one the round trip silently changed. ---

// The naive consumer named in the report: reads ONLY closedAtIndex, never
// prefixMatches. This is the shape a future closeGateStatus consumer must
// stay safe under even if it forgets to check the second field.
const naiveConsumerAllows = (r, openedAtIndex) =>
  r.closedAtIndex === null || openedAtIndex >= r.closedAtIndex;

function roundTrip(r) {
  return JSON.parse(JSON.stringify(r));
}

test('readResolution: an unverifiable (rejected) result stays a rejection for the index-only consumer, before AND after a JSON round trip', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 });
    recordGateClosed(hypoDir, SESSION, resolutionStamp(Buffer.from(transcript, 'utf-8')));
    // A string rawTranscript is unverifiable (S1/S2's fixed case).
    const rejected = readResolution(hypoDir, SESSION, transcript);
    assert.equal(rejected.prefixMatches, false);

    const before = naiveConsumerAllows(rejected, 1);
    const after = naiveConsumerAllows(roundTrip(rejected), 1);
    assert.equal(before, false, 'naive consumer must reject before the round trip');
    assert.equal(after, false, 'naive consumer must still reject after the round trip');
    // Also pin against a very large openedAtIndex, not just one equal to the
    // real record count — a naive consumer applies the SAME comparison
    // regardless of how far the transcript has grown since.
    assert.equal(naiveConsumerAllows(rejected, 999), false);
    assert.equal(naiveConsumerAllows(roundTrip(rejected), 999), false);
  });
});

test('readResolution: "no constraint" and "rejected" never collide across a JSON round trip', () => {
  withTmpDir((hypoDir) => {
    // No file at all → no constraint.
    const noConstraint = readResolution(hypoDir, SESSION, Buffer.from('irrelevant', 'utf-8'));
    assert.deepEqual(noConstraint, NO_CONSTRAINT);
    assert.deepEqual(roundTrip(noConstraint), NO_CONSTRAINT);
    // A no-constraint result stays PERMISSIVE (the naive consumer allows it)
    // on both sides of the round trip — this is the one state that SHOULD
    // read as unconstrained, and the round trip must not change that either.
    assert.equal(naiveConsumerAllows(noConstraint, 0), true);
    assert.equal(naiveConsumerAllows(roundTrip(noConstraint), 0), true);

    // A genuinely unverifiable file → rejected.
    const transcript = raw({ a: 1 });
    recordGateClosed(hypoDir, SESSION, resolutionStamp(Buffer.from(transcript, 'utf-8')));
    const rejected = readResolution(hypoDir, SESSION, transcript); // string → unverifiable
    assert.notDeepEqual(rejected, NO_CONSTRAINT);
    assert.notDeepEqual(roundTrip(rejected), roundTrip(noConstraint));
    // The two states must never compare equal after the round trip either —
    // that collision (closedAtIndex: Infinity → null) is exactly the T1 bug.
    // A naive consumer at the real record's own index (1) still rejects,
    // proving `rejected` did not quietly become permissive like NO_CONSTRAINT
    // would have been at this same openedAtIndex.
    assert.equal(naiveConsumerAllows(rejected, 1), false);
    assert.equal(naiveConsumerAllows(roundTrip(rejected), 1), false);
  });
});

test('readResolution: a verified match stays a verified match across a JSON round trip', () => {
  withTmpDir((hypoDir) => {
    const transcript = raw({ a: 1 }, { a: 2 });
    const stamp = resolutionStamp(Buffer.from(transcript, 'utf-8'));
    recordGateClosed(hypoDir, SESSION, stamp);
    const verified = readResolution(hypoDir, SESSION, Buffer.from(transcript, 'utf-8'));
    assert.equal(verified.closedAtIndex, stamp.index);
    assert.equal(verified.prefixMatches, true);

    const after = roundTrip(verified);
    assert.equal(after.closedAtIndex, stamp.index);
    assert.equal(after.prefixMatches, true);

    // The index-only consumer passes at the real index on both sides, and
    // still rejects an EARLIER open on both sides (the actual constraint
    // this state is supposed to enforce, not merely "some value survived").
    assert.equal(naiveConsumerAllows(verified, stamp.index), true);
    assert.equal(naiveConsumerAllows(after, stamp.index), true);
    assert.equal(naiveConsumerAllows(verified, stamp.index - 1), false);
    assert.equal(naiveConsumerAllows(after, stamp.index - 1), false);
  });
});

// --- T6: closeGateStatus — the composite walkCloseGate + readResolution gate
// every consumer should call instead of wiring the two together itself ---

// A genuine typed close-phrase user record, in the same JSONL shape a real
// transcript carries (see helpers.mjs's seedCloseTranscript, which uses the
// same phrase against the real transcript resolver).
const CLOSE_TEXT = '세션 마무리 해줘';
function closeRecord(text = CLOSE_TEXT) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

/** Writes JSONL records (already-stringified lines) to a fresh transcript
 * file under `dir` and returns its path. */
function writeTranscript(dir, ...lines) {
  const path = join(dir, `transcript-${Math.random().toString(36).slice(2, 10)}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

suite('close-gate-store: closeGateStatus (T6, the composite gate)');

test('(a) an open with no recorded resolution passes', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(hypoDir, closeRecord());
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(result.open, true);
  });
});

test('(b) a resolved close with no NEW open since the resolution is rejected', () => {
  withTmpDir((hypoDir) => {
    const transcriptText = closeRecord() + '\n';
    const stamp = resolutionStamp(Buffer.from(transcriptText, 'utf-8'));
    assert.equal(recordGateClosed(hypoDir, SESSION, stamp), true);

    // Same bytes, no fresh close phrase appended since the resolution.
    const transcriptPath = writeTranscript(hypoDir, closeRecord());
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.equal(result.open, true, 'the transcript itself still opens — only the gate rejects');
    assert.match(result.reason, /no-new-open-since-resolution/);
  });
});

test('(c) a resolved close followed by a fresh close phrase passes', () => {
  withTmpDir((hypoDir) => {
    const transcriptText = closeRecord() + '\n';
    const stamp = resolutionStamp(Buffer.from(transcriptText, 'utf-8'));
    recordGateClosed(hypoDir, SESSION, stamp);

    // A second, later close phrase — a fresh user decision after the resolution.
    const transcriptPath = writeTranscript(hypoDir, closeRecord(), closeRecord());
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
  });
});

test('(d) a prefix-hash mismatch (transcript rewritten ahead of the resolved record) is rejected', () => {
  withTmpDir((hypoDir) => {
    const transcriptText = closeRecord() + '\n';
    const stamp = resolutionStamp(Buffer.from(transcriptText, 'utf-8'));
    recordGateClosed(hypoDir, SESSION, stamp);

    // A record inserted AHEAD of the resolved one shifts every byte the
    // resolution's hash was computed over — a rewrite, not an append.
    const transcriptPath = writeTranscript(
      hypoDir,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      closeRecord(),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.match(result.reason, /transcript-rewrite-detected/);
  });
});

test('(e) polarity invariant: a forged resolution file never passes MORE than an absent one does', () => {
  const forgedPayloads = [
    { open: true },
    { granted: true },
    { humanTurnAt: new Date(Date.now() + 86_400_000).toISOString() }, // future
    { fresh: true },
  ];
  // A transcript that never opens the gate at all — rule 1 of closeGateStatus
  // must reject it before ever reading a resolution file, so this is the ONE
  // shape where "no file" is NOT already the maximally permissive baseline
  // (withoutFile is false here, not true). A forged permissive-looking key
  // like {open:true} making withFile true here is exactly the bug this test
  // exists to catch — the earlier version of this test only ever exercised a
  // transcript that already passed on its own, where withoutFile is always
  // true and `withFile <= withoutFile` cannot fail for ANY withFile value.
  const NEUTRAL_TEXT = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hello, not a close phrase' },
  });

  for (const payload of forgedPayloads) {
    withTmpDir((hypoDir) => {
      writeRawFile(hypoDir, SESSION, payload);

      // Direct assertion on the mechanism, not just the outcome: the forged
      // file must read back as the exact same NO_CONSTRAINT shape an absent
      // file gives, regardless of which permissive-looking key it carries.
      const transcriptForRead = Buffer.from(closeRecord() + '\n', 'utf-8');
      assert.deepEqual(
        readResolution(hypoDir, SESSION, transcriptForRead),
        { closedAtIndex: null, prefixMatches: null },
        `forged payload must read as NO_CONSTRAINT: ${JSON.stringify(payload)}`,
      );

      const openPath = writeTranscript(hypoDir, closeRecord());
      const withFileOpen = closeGateStatus({
        transcriptPath: openPath,
        hypoDir,
        sessionId: SESSION,
      }).ok;
      assert.equal(
        withFileOpen,
        true,
        `an open transcript with only a forged (no-constraint) file must still pass: ${JSON.stringify(payload)}`,
      );

      const noOpenPath = writeTranscript(hypoDir, NEUTRAL_TEXT);
      const withFileNoOpen = closeGateStatus({
        transcriptPath: noOpenPath,
        hypoDir,
        sessionId: SESSION,
      }).ok;
      assert.equal(
        withFileNoOpen,
        false,
        `a forged file must not open a gate the transcript itself never opened: ${JSON.stringify(payload)}`,
      );
    });
  }

  // Baseline: no resolution file at all, same two transcript shapes. Both
  // scenarios above must match this exactly (open → true, no-open → false).
  withTmpDir((hypoDir) => {
    const openPath = writeTranscript(hypoDir, closeRecord());
    assert.equal(
      closeGateStatus({ transcriptPath: openPath, hypoDir, sessionId: SESSION }).ok,
      true,
    );
    const noOpenPath = writeTranscript(hypoDir, NEUTRAL_TEXT);
    assert.equal(
      closeGateStatus({ transcriptPath: noOpenPath, hypoDir, sessionId: SESSION }).ok,
      false,
    );
  });
});

// --- no-open reason: unrecognized-tag diagnostic (closeGateStatus's own
// assembly, not walkCloseGate's raw field. close-signals.test.mjs already
// pins that walkCloseGate returns the right tag name; this pins that
// closeGateStatus actually puts it in the reason string a caller reads) ---

suite('close-gate-store: closeGateStatus no-open reason, unrecognized-tag diagnostic');

test('no-open reason names the tag when an unregistered host-shaped tag retracted the close', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(
      hypoDir,
      closeRecord(),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<any-new-host-tag foo="x">something</any-new-host-tag>',
      }),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.equal(result.open, false);
    assert.match(result.reason, /^no-open:/); // existing consumers key on this prefix; must not move
    assert.match(result.reason, /<any-new-host-tag\.\.\.>/); // names the tag so a maintainer knows what to add
    assert.match(result.reason, /HOST_TAG_NAMES/);
  });
});

// MAJOR fix (fail-closed): the same unregistered tag, with close wording in
// its body. It used to hit the close-phrase branch first, which neither
// retracted nor named anything: the previous close stayed in effect and all
// three warning surfaces (marker, JSON, console) went quiet, so the apply and
// commit that followed looked like an ordinary close.
test('an unregistered tag retracts even when its own body reads like a close phrase', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(
      hypoDir,
      closeRecord(),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<future-host from="somewhere">오늘은 여기까지 하고 마무리하자</future-host>',
      }),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, false, `an unregistered tag must not leave the close standing`);
    assert.equal(result.open, false);
    assert.match(result.reason, /^no-open:/);
    assert.match(result.reason, /<future-host\.\.\.>/); // names the tag
    assert.match(result.reason, /HOST_TAG_NAMES/); // and where to register it
    // The cost this choice puts on the user is stated, not hidden: they have
    // to confirm the close again until the tag is registered.
    assert.match(result.reason, /confirm the close again/);
  });
});

test('a REGISTERED host tag with close wording still stays neutral (the fail-closed rule is about the allowlist)', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(
      hypoDir,
      closeRecord(),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<agent-message from="worker">오늘은 여기까지 진행했습니다</agent-message>',
      }),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, true, `a known host tag must keep reading as neutral`);
    assert.equal(result.open, true);
    assert.match(result.hostTagWarning, /<agent-message\.\.\.>/);
  });
});

test('no-open reason carries no tag diagnostic when the retraction is ordinary prose', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(
      hypoDir,
      closeRecord(),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: 'still working on this, keep going',
      }),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, false);
    assert.equal(result.open, false);
    assert.match(result.reason, /^no-open:/);
    assert.equal(/HOST_TAG_NAMES/.test(result.reason), false); // no tag-shaped culprit to name
  });
});

// A 2026-09 pass (codex cross-review round 5, blocker) made a KNOWN host tag
// retract a close on the enqueue channel too, and this test used to pin that
// (as a diagnostic requirement: name it differently from an unregistered
// tag). Reverted 2026-09-18; see hooks/hypo-shared.mjs's enqueue-branch
// reversion note for why a known host tag reads neutral again. The residual
// that reopens (a person could paste the same shape) is not a `no-open`
// reason anymore, because the close no longer fails: it is `hostTagWarning`
// on the `ok: true` result instead. See the suite below for that pin.
test('a KNOWN host tag no longer retracts on the enqueue channel (stays open, ok:true)', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(
      hypoDir,
      closeRecord(),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<task-notification>\n<status>completed</status>\n</task-notification>',
      }),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(result.open, true);
    assert.equal(result.reason, null);
  });
});

// --- hostTagWarning: the B residual, surfaced once instead of closed on ---
//
// B accepts that a person who types or pastes a HOST_TAG_NAMES shape
// verbatim reads the same as the host actually sending it (see
// hooks/hypo-shared.mjs's enqueue-branch reversion note for why that is
// judged cheaper than the alternative). This suite pins that the risk is not
// silently absorbed: closeGateStatus names it on the `ok: true` result, so a
// caller that only checks `.ok` still has a way to see it.

suite('close-gate-store: closeGateStatus, hostTagWarning (B residual, surfaced once)');

test('ok:true carries hostTagWarning naming the tag when a KNOWN host tag stayed neutral after the close', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(
      hypoDir,
      closeRecord(),
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '<agent-message from="peer">still working</agent-message>',
      }),
    );
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(result.open, true);
    assert.match(result.hostTagWarning, /<agent-message\.\.\.>/);
    // States WHAT happened and stops there. The undo is not baked in, because
    // what a run can take back depends on what that run did; see the
    // hostTagWarningWithUndo suite below for the half this one leaves out.
    assert.equal(/revert|delete/.test(result.hostTagWarning), false);
  });
});

test('ok:true carries no hostTagWarning on an ordinary close with no host-tag-shaped queue item', () => {
  withTmpDir((hypoDir) => {
    const transcriptPath = writeTranscript(hypoDir, closeRecord());
    const result = closeGateStatus({ transcriptPath, hypoDir, sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(result.open, true);
    assert.equal(result.hostTagWarning, undefined);
  });
});

// --- hostTagWarningWithUndo: the undo half, one wording per entry point ---
//
// The warning's first version carried its own undo, naming a
// `.cache/session-closed-<id>.json` file no writer has ever produced (the
// marker is `.marker`; the `.json` is this file's own resolution record under
// `.cache/close-gate/`). crystallize.md tells the model to relay that string
// verbatim, so the wrong path reached the user and was persisted into the
// marker. Nothing measured the path, because every assertion looked for
// /revert/. These do measure it, and they get the expected value from
// sessionClosedMarkerPath rather than re-typing it, so a change to the naming
// rule moves the test with the code instead of against it.

suite('close-gate-store: hostTagWarningWithUndo (per-path undo, derived marker path)');

// ISSUE-171: a close now files a close receipt (hooks/close-receipt.mjs)
// alongside the compat marker, and readReceiptStrict honors that receipt on
// its own -- deleting only the marker would leave a still-valid receipt
// behind, and a new Stop would keep treating the session as closed. Both
// writer entry points land the receipt before the marker, so undo must name
// BOTH paths, never the marker alone.
test('commit-and-marker names both the marker AND the receipt, and offers a revert', () => {
  const out = hostTagWarningWithUndo('WARN.', 'commit-and-marker', '/vault', 'sess-1');
  assert.match(out, /^WARN\. /);
  assert.match(out, /revert/);
  assert.ok(
    out.includes(sessionClosedMarkerPath('/vault', 'sess-1')),
    `must name the real marker path, got: ${out}`,
  );
  assert.ok(
    out.includes(receiptPath('/vault', 'sess-1')),
    `must also name the receipt path, got: ${out}`,
  );
  // The resolution record is a different file; pointing at it would send the
  // user to delete the wrong thing.
  assert.equal(out.includes(closeGatePath('/vault', 'sess-1')), false);
});

test('marker-only offers no revert (that path makes no commit) and names both the marker AND the receipt', () => {
  const out = hostTagWarningWithUndo('WARN.', 'marker-only', '/vault', 'sess-1');
  assert.ok(out.includes(sessionClosedMarkerPath('/vault', 'sess-1')), out);
  assert.ok(out.includes(receiptPath('/vault', 'sess-1')), out);
  // It may SAY there is nothing to revert; what it must never do is send the
  // reader after a commit this entry point does not make.
  assert.equal(/revert the commit/.test(out), false, out);
  assert.match(out, /nothing to revert/);
});

test('commit-only offers the revert and no marker to delete (the write never landed)', () => {
  const out = hostTagWarningWithUndo('WARN.', 'commit-only', '/vault', 'sess-1');
  assert.match(out, /revert/);
  assert.equal(
    out.includes(sessionClosedMarkerPath('/vault', 'sess-1')),
    false,
    `no marker landed on this path: ${out}`,
  );
  // No receipt landed either on a bare '/vault' (nothing on disk to find), so
  // 'commit-only' must not invent one to name.
  assert.equal(out.includes(receiptPath('/vault', 'sess-1')), false, out);
});

// commit-only's marker and receipt writes can fail independently (the
// marker write can fail on its own even after the receipt already landed,
// see crystallize-close-apply.mjs's `marker-did-not-land` branch): unlike
// the other two kinds, this one checks disk rather than assume either way.
test('commit-only names the receipt too when one actually landed on disk', () => {
  withTmpDir((dir) => {
    const rp = receiptPath(dir, SESSION);
    mkdirSync(dirname(rp), { recursive: true });
    writeFileSync(rp, '{}');
    const out = hostTagWarningWithUndo('WARN.', 'commit-only', dir, SESSION);
    assert.ok(out.includes(rp), `must name the landed receipt: ${out}`);
    assert.equal(
      out.includes(sessionClosedMarkerPath(dir, SESSION)),
      false,
      `still no marker on this path: ${out}`,
    );
  });
});

test('uncommitted-writes points at neither, and says the bytes are still uncommitted', () => {
  const out = hostTagWarningWithUndo('WARN.', 'uncommitted-writes', '/vault', 'sess-1');
  assert.equal(out.includes(sessionClosedMarkerPath('/vault', 'sess-1')), false, out);
  assert.match(out, /uncommitted/);
});

// MAJOR fix: "git revert" used to name no commit, so the only way to act on
// it was to guess HEAD, which on a shared vault is whatever session
// committed last, and reverting that undoes someone else's work.
test('a commit sha makes the undo a runnable command against THAT commit', () => {
  const sha = 'a'.repeat(40);
  const out = hostTagWarningWithUndo('WARN.', 'commit-and-marker', '/vault', 'sess-1', sha);
  assert.ok(out.includes(`git -C /vault revert ${sha}`), `must name the commit: ${out}`);
  assert.ok(out.includes(sessionClosedMarkerPath('/vault', 'sess-1')), out);
});

test('a no-op commit (scoped:0, sha null) says there is nothing to revert rather than naming one', () => {
  const out = hostTagWarningWithUndo('WARN.', 'commit-only', '/vault', 'sess-1', null);
  assert.match(out, /no tracked file/);
  assert.equal(/git -C \/vault revert [0-9a-f]/.test(out), false, `no target to invent: ${out}`);
});

test('an unknown sha sends the reader to identify the commit, never to a guessed one', () => {
  const out = hostTagWarningWithUndo('WARN.', 'commit-only', '/vault', 'sess-1');
  assert.match(out, /git -C \/vault log -1/);
  // HEAD is exactly the guess that undoes another session's commit, so it must
  // not appear as an instruction.
  assert.equal(/revert HEAD/.test(out), false, out);
});

test('no warning, or nothing this run can undo, returns null (the caller stays quiet)', () => {
  assert.equal(hostTagWarningWithUndo(null, 'commit-and-marker', '/vault', 'sess-1'), null);
  assert.equal(hostTagWarningWithUndo('WARN.', null, '/vault', 'sess-1'), null);
  // An unrecognized kind is the same answer: silence beats an undo instruction
  // this file cannot stand behind.
  assert.equal(hostTagWarningWithUndo('WARN.', 'made-up-kind', '/vault', 'sess-1'), null);
});
