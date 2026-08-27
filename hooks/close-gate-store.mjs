// hooks/close-gate-store.mjs — the close-gate resolution record.
//
// Lives in hooks/ because scripts/ already imports from hooks/, never the
// reverse (a hook copied standalone into ~/.claude/hooks/ cannot resolve a
// scripts/ import). Node built-ins only.
//
// This file can only ever make close harder to invoke, never easier. Whether
// the gate is open is decided entirely from the session transcript, which the
// model cannot forge without also forging a human-authored role:user record.
// This store adds the one fact a transcript alone cannot carry: "the close
// this session opened has already gone through". Writing that fact CLOSES the
// gate. Nothing this file reads can OPEN it: `readResolution` never returns a
// value that widens a caller's decision, and it does not even look at keys
// like `open`, `granted`, `humanTurnAt`, or `fresh`. A forged file containing
// any of them falls back to the same "no constraint" answer an absent file
// gives, because none of those keys is ever read.
//
// `resolutionStamp` is the one place that decides what counts as a "record" in
// a raw transcript, for both the writer (close time) and the reader
// (verification time). Definition: split on newlines, skip a blank line, fail
// the whole computation on the first non-blank line that does not parse (a
// half-written or corrupt transcript looks like this), and skip a line that
// parses to something other than a non-null object (bare `null`, a string, a
// number are valid JSON but not a record). `prefixSha` hashes the raw BYTES
// from the start of the transcript through the end of the line that produced
// the target record, so an append after that point never changes it (those
// bytes are untouched) while a rewrite before it always does. Hashing bytes,
// not a decoded string, matters: two different invalid-UTF-8 byte sequences
// can decode to the identical JS string (both fold to U+FFFD), which would
// hide a rewrite from a string-based hash. `resolutionStamp` therefore walks
// a `Buffer`, never a decoded string, when it wants that guarantee — see its
// own doc comment for the caller contract.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `<hypoDir>/.cache/close-gate/<session-id>.json`. */
export function closeGatePath(hypoDir, sessionId) {
  return join(hypoDir, '.cache', 'close-gate', `${sessionId}.json`);
}

// Only a `Buffer` is byte-faithful. A `string` was accepted here once, but a
// string has already been decoded by SOMEONE — this function has no way to
// tell an honest string apart from one a lossy decode already quietly
// rewrote to look like something else (two distinct invalid-UTF-8 byte
// sequences can both fold to U+FFFD and re-encode identically, which is
// exactly the collision this file exists to catch). So accepting a string at
// all just moves that hole one call deeper instead of closing it: whichever
// caller builds the stamp from a decoded string bakes the loss into the
// stamp itself, and every later comparison inherits it. Anything that is not
// a `Buffer` returns `null` here, the same "not a fatal transcript, an
// invalid call" answer a caller must already treat as unusable.
function toBuffer(rawTranscript) {
  return Buffer.isBuffer(rawTranscript) ? rawTranscript : null;
}

/**
 * Walk a raw transcript and compute `{ index, prefixSha }`. `index` is the
 * count of object records found (see the file header for what counts as one).
 * `prefixSha` is the sha256 (hex) of the raw BYTES through the end of the line
 * that produced the `upToIndex`-th record (default: the last one found).
 *
 * Passing a smaller `upToIndex` is how a reader re-derives the SAME prefix a
 * writer once hashed, out of a transcript that may have grown since: the walk
 * stops counting at that record instead of hashing whatever came after, so an
 * append never changes the answer.
 *
 * Returns `null` on a fatal parse: a non-blank line that does not parse as
 * JSON at all, which is what a transcript being appended to mid-write looks
 * like. A caller must not read a `null` stamp as "no records". Also `null`
 * when `rawTranscript` is not a `Buffer` — a decoded `string` included; see
 * `toBuffer`'s doc comment above for why that path was removed rather than
 * merely documented against.
 *
 * @param {Buffer} rawTranscript the un-decoded result of
 *   `readFileSync(transcriptPath)`. Anything else (a `string` included)
 *   returns `null`.
 * @param {number} [upToIndex]
 * @returns {{index: number, prefixSha: string}|null}
 */
export function resolutionStamp(rawTranscript, upToIndex = Infinity) {
  const buf = toBuffer(rawTranscript);
  if (buf === null) return null;
  let index = 0;
  let prefixEnd = 0;
  let pos = 0;
  const len = buf.length;
  while (pos <= len) {
    const nl = buf.indexOf(0x0a, pos); // '\n' byte — a single ASCII byte under any encoding
    const lineEnd = nl === -1 ? len : nl;
    const consumedThrough = nl === -1 ? len : nl + 1;
    // Decoding the line to a string here is safe: it is used only to decide
    // blank/non-blank and to JSON.parse it, never to compute the hash below
    // (that reads straight off `buf`). A decode artifact (U+FFFD folding two
    // distinct invalid byte sequences together) can at most affect record
    // CLASSIFICATION, which this file already treats no differently for any
    // other reason a line might parse one way or another — it can never
    // affect the hash itself.
    const line = buf.toString('utf-8', pos, lineEnd);
    if (line.trim() !== '') {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return null; // fatal: unparseable non-blank line
      }
      // A record is a non-null object. A bare `null`, a string, or a number
      // parses fine but is noise, not a record, and does not move the prefix.
      if (obj !== null && typeof obj === 'object') {
        index += 1;
        prefixEnd = consumedThrough;
        if (index >= upToIndex) break;
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  const prefixSha = createHash('sha256').update(buf.subarray(0, prefixEnd)).digest('hex');
  return { index, prefixSha };
}

/** Atomic overwrite via tmp+rename, mirroring base-store's atomicWrite. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Record that this session's close gate is resolved, at the point `stamp`
 * describes. Best-effort: a hook must never fail a close over a cache write,
 * so any error here is swallowed.
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {{index: number, prefixSha: string}|null} stamp from `resolutionStamp`
 * @returns {boolean} true when the file was written
 */
export function recordGateClosed(hypoDir, sessionId, stamp) {
  if (
    !sessionId ||
    !stamp ||
    typeof stamp.index !== 'number' ||
    typeof stamp.prefixSha !== 'string'
  ) {
    return false;
  }
  const body = JSON.stringify(
    {
      v: 1,
      sessionId: String(sessionId),
      closedAt: new Date().toISOString(),
      closedAtIndex: stamp.index,
      closedPrefixSha: stamp.prefixSha,
    },
    null,
    2,
  );
  try {
    atomicWrite(closeGatePath(hypoDir, sessionId), body);
    return true;
  } catch {
    return false;
  }
}

// The single "no constraint" answer, shared so an absent file and an unusable
// one are byte-for-byte the same return value. That sameness is the polarity
// guarantee this file exists to keep: nothing written to the resolution file
// can ever read back as MORE permissive than the file not existing at all.
const NO_CONSTRAINT = Object.freeze({ closedAtIndex: null, prefixMatches: null });

// The "rejected" sentinel for closedAtIndex — see readResolution's doc table.
// `Infinity` reads clean in memory (no real openedAtIndex is ever `>=
// Infinity`) but does not survive a JSON round trip: `JSON.stringify` turns
// `Infinity` into the literal `null`, which is the EXACT value this module
// uses for "no constraint" — so a hook or script that reads this value back
// out of its own stdout JSON silently flips a rejection into no constraint at
// all. `Number.MAX_SAFE_INTEGER` (2**53 - 1) survives JSON untouched and
// keeps the same arithmetic property for any value an honest caller can ever
// produce: `openedAtIndex` is an index into an in-memory array built by
// reading a transcript one line at a time (walkCloseGate in hypo-shared.mjs),
// so reaching this many entries needs a running process holding more than
// 2**53 parsed record objects in memory at once — past any real machine's
// RAM by many orders of magnitude, not merely a large transcript. It is
// unreachable because the walk that produces `openedAtIndex` cannot survive
// long enough to get there, not because the number is merely "big enough".
const REJECTED_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * Answer only "does a recorded resolution constrain this session's gate",
 * never "is the gate open". Three possible shapes come back, and the table
 * below is the full contract a consumer (the closeGateStatus gate to be
 * built on top of this) needs — including what happens if it reads ONLY
 * `closedAtIndex` and never looks at `prefixMatches` at all, because a
 * consumer that only checks `openedAtIndex >= closedAtIndex` is a shape this
 * file has to stay safe under, not a shape it gets to assume away.
 *
 * | state              | shape                                        | survives `JSON.parse(JSON.stringify(...))` | what it means                                                              | an index-only consumer (`openedAtIndex >= closedAtIndex`) does |
 * |--------------------|-----------------------------------------------|:---:|-----------------------------------------------------------------------------|-----------------------------------------------------------------|
 * | no constraint      | `{closedAtIndex: null, prefixMatches: null}`   | yes | no valid resolution record exists at all (absent file, unparseable, wrong `v`, wrong `sessionId`, or a `closedAtIndex` that fails its own shape check) | must special-case `null` and treat it as "unconstrained" |
 * | verified           | `{closedAtIndex: N, prefixMatches: true}` (N a finite positive integer) | yes | a resolution WAS recorded at record N, and this transcript still carries the exact same bytes through record N | compares correctly: passes only once a later open reaches index N |
 * | rejected           | `{closedAtIndex: REJECTED_INDEX (Number.MAX_SAFE_INTEGER), prefixMatches: false}` | yes | a resolution claims to exist but this transcript cannot be trusted against it: wrong input type, a hash mismatch, or an index mismatch (the walk never actually reached record N) | rejects WITHOUT reading `prefixMatches` at all, because no real record index is ever `>= Number.MAX_SAFE_INTEGER` |
 *
 * The "survives JSON round trip" column is load-bearing, not incidental: this
 * value crosses a JSON boundary on the way out of a hook's stdout and out of
 * `crystallize`'s `--check-session-close` JSON output, so a state that only
 * holds up in memory is not actually held. An earlier version of the
 * "rejected" row used `Infinity` for the same arithmetic reasoning, and
 * `Infinity` DOES make an in-memory `>=` comparison fail on its own — but
 * `JSON.stringify(Infinity)` is the literal `null`, which is the EXACT value
 * this module uses for "no constraint". One JSON round trip silently flipped
 * a rejection into "unconstrained". See `REJECTED_INDEX`'s own comment above
 * for why `Number.MAX_SAFE_INTEGER` keeps the same guarantee without that
 * failure mode.
 *
 * The "rejected" row is what makes the index-only consumer safe even across
 * that boundary: this function never has to trust that some future caller
 * remembers to check `prefixMatches`, because setting `closedAtIndex` to
 * `REJECTED_INDEX` on every unverifiable input makes the plain `>=`
 * comparison fail on its own, by arithmetic, not by convention. This
 * replaces an earlier version of this function that returned the real
 * recorded `closedAtIndex` alongside `prefixMatches: false` for an
 * unverifiable input — correct for a caller that reads both fields, but
 * silently permissive for one that reads only the index, since the real N
 * can still satisfy `openedAtIndex >= N` for a later, unrelated open.
 *
 * Keys other than `v`, `sessionId`, `closedAtIndex`, `closedPrefixSha` are
 * never read, on purpose: `open`, `granted`, `humanTurnAt`, `fresh` sitting in
 * the file have zero effect here.
 *
 * `closedAtIndex` must be a positive safe integer (`Number.isSafeInteger` and
 * `>= 1`) before anything else runs — a record index of 0 or below names no
 * real record, and is exactly the shape a forged file would carry to
 * trivially satisfy a downstream `openedAtIndex >= closedAtIndex`
 * comparison. A `closedAtIndex` that fails this shape check falls into "no
 * constraint", the same bucket as every other malformed field above: it
 * never had a value this file could act on, so falling back to "as if the
 * file were absent" cannot widen anything.
 *
 * Everything that PASSES the shape check but cannot be positively verified
 * lands in "rejected", not "no constraint" — undecidable must not fold into
 * permissive. That covers three different reasons, deliberately treated the
 * same way: (1) `rawTranscript` is not a `Buffer` (a `string` has already
 * been decoded by the caller, and re-encoding it here cannot recover
 * whatever an invalid-UTF-8 rewrite destroyed on the way through that
 * decode); (2) the recomputed `stamp.index` does not come back EQUAL to
 * `parsed.closedAtIndex` (walking with `upToIndex = closedAtIndex` can stop
 * EARLY, at whatever the transcript's actual last record is, if the
 * transcript never reaches that many records — so a forged `closedAtIndex`
 * larger than the real record count could otherwise land on a prefix that
 * happens to hash-match a shorter, genuine one); (3) the hash itself does
 * not match (a genuine rewrite).
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {Buffer} rawTranscript the current transcript's raw bytes. Callers
 *   MUST pass what `readFileSync(transcriptPath)` returns with NO encoding
 *   argument. Anything else (a decoded string included) lands in "rejected"
 *   above.
 * @returns {{closedAtIndex: number|null, prefixMatches: boolean|null}}
 */
export function readResolution(hypoDir, sessionId, rawTranscript) {
  if (!sessionId) return NO_CONSTRAINT;
  const path = closeGatePath(hypoDir, sessionId);
  if (!existsSync(path)) return NO_CONSTRAINT;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return NO_CONSTRAINT;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_CONSTRAINT;
  if (parsed.v !== 1) return NO_CONSTRAINT;
  if (typeof parsed.sessionId !== 'string' || parsed.sessionId !== String(sessionId)) {
    return NO_CONSTRAINT;
  }
  if (
    typeof parsed.closedAtIndex !== 'number' ||
    !Number.isSafeInteger(parsed.closedAtIndex) ||
    parsed.closedAtIndex < 1 ||
    typeof parsed.closedPrefixSha !== 'string'
  ) {
    return NO_CONSTRAINT;
  }

  // `resolutionStamp` itself now returns `null` for anything that is not a
  // Buffer (a string included), so a wrong-typed `rawTranscript` and a
  // genuine hash/index mismatch both land here without a separate type
  // check: `verified` is false either way, and "rejected" (REJECTED_INDEX,
  // never the real recorded index) is the one answer every failure mode
  // gets. See the doc comment's table above for why that shape, not the
  // real index, is what makes an index-only consumer safe, and why it has
  // to be a value that survives a JSON round trip.
  const stamp = resolutionStamp(rawTranscript, parsed.closedAtIndex);
  const verified =
    stamp !== null &&
    stamp.index === parsed.closedAtIndex &&
    stamp.prefixSha === parsed.closedPrefixSha;
  return verified
    ? { closedAtIndex: parsed.closedAtIndex, prefixMatches: true }
    : { closedAtIndex: REJECTED_INDEX, prefixMatches: false };
}
