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
  readResolution,
  recordGateClosed,
  resolutionStamp,
} from '../hooks/close-gate-store.mjs';

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
