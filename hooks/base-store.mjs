// base-store.mjs: per-session observed-base hash snapshot
//
// Lives in hooks/ rather than scripts/lib/ because hypo-session-start.mjs must
// stay self-contained within this directory (an npm consumer may vendor hooks/
// alone). scripts/ already imports from hooks/, never the reverse.
//
// The write=proposal gate needs to know what a session OBSERVED on disk when it
// started, so crystallize can tell "nobody touched this page" from "someone else
// wrote it while this session was alive". crystallize runs as a separate process
// from the session, so the observation has to be parked somewhere both can read:
// `<hypoDir>/.cache/sessions/<sessionId>/base.json` (gitignored, never synced).
//
// SessionStart writes it, crystallize reads it. Two invariants carry the design:
//
//   1. Existence-check, not overwrite. SessionStart fires again on resume and on
//      compact with the SAME session_id (verified by spike). Re-snapshotting
//      there would advance the base to whatever another session had just written,
//      so close would compare base-to-itself, see no drift, and clobber the other
//      session's edits. Single-session tests pass either way, which is exactly
//      why this is pinned by a regression test and not left to reviewer memory.
//      `/clear` mints a NEW session_id, so it gets a fresh snapshot, which is right:
//      a cleared session restarts its observation from disk.
//
//   2. Advance after a successful direct write. Once crystallize legitimately
//      overwrites a target, that content IS the new observed base. Without this,
//      a second close in the same session would diff against the stale original
//      and raise a false-positive proposal against its own first write.
//
// Everything here is best-effort: a hook must never fail a session start because
// a cache write did not land. Read failures degrade to "base unknown", which the
// caller treats as fail-safe (proposal), never as "no conflict".
//
// Every mutator below (snapshotBase, advanceBase, advanceBaseForWrite,
// beginObservedGeneration, recordObserved, recordAppliedHash, clearAppliedHash,
// advanceBaseAndRecordApplied) wraps its read-modify-write in `withFileLock`
// (review r5-w3 major 1): SessionStart, a PostToolUse hand-edit hook, and
// crystallize's own apply can all touch the SAME session's base.json around the
// same time, and a plain `readBaseFile` → mutate → `atomicWrite` sequence with
// no lock lets a later writer's read start before an earlier writer's write
// lands, so the later one then republishes the whole file from its stale copy and
// silently reverts the earlier writer's field. `atomicWrite`'s rename already
// guarantees a reader never sees a torn/partial file, so this lock exists for
// lost-update races between writers, not for read tearing. A lock timeout
// degrades to the same fail-safe as any other write failure here: the field
// that could not be recorded is simply left as it was.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, closeSync, openSync, writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { withFileLock } from './hypo-shared.mjs';

/** sha256 of a UTF-8 string, hex. */
export function hashContent(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Hash of a file's bytes. Absent and unreadable are different answers: an absent
 * file was genuinely observed as absent, while an unreadable one was not observed
 * at all, and only the first makes "create it at close" safe.
 * @returns {string|null|undefined} hex hash, `null` if absent, `undefined` if unreadable
 */
export function hashFile(path) {
  if (!existsSync(path)) return null;
  try {
    return hashContent(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** `<hypoDir>/.cache/sessions/<sessionId>/base.json`. */
export function basePath(hypoDir, sessionId) {
  return join(hypoDir, '.cache', 'sessions', String(sessionId), 'base.json');
}

/** Read and parse base.json. Returns null when absent, unreadable, or malformed. */
function readBaseFile(hypoDir, sessionId) {
  const path = basePath(hypoDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!parsed.targets || typeof parsed.targets !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Snapshot the observed base hashes for `relPaths`, ONCE PER KEY per session.
 *
 * Existence-check (invariant 1): when base.json already exists for this session,
 * an already-tracked key never moves: resume and compact must not move the
 * base for a target this session has already seen.
 *
 * Late enrollment: `relPaths` can differ across calls in the SAME session. The
 * caller that motivated this (hypo-session-start.mjs) resolves the project from
 * `cwd`, which can miss on the session's first SessionStart and hit on a later
 * resume or compact with the SAME session_id. `overwriteTargets(project)`
 * then names two more paths than the first call did. Without this, those two
 * targets would never get a key at all for the rest of the session (not even
 * an 'unknown' one): `advanceBaseForWrite` and `recordObserved` are both
 * scoped to `hasOwnProperty`, so an untracked key can never accept a write's
 * provenance, and close falls back to `base-unknown` forever. So a key this
 * call names that the session has NOT already seen is added now, hashed off
 * disk exactly like a fresh snapshot's targets are; a key already tracked,
 * present or 'absent', is left exactly as it was.
 *
 * A target that does not exist on disk is recorded as `null` (observed-absent),
 * which is distinct from having no entry at all (observed-nothing). Close treats
 * the first as "I saw no file, creating it is safe" and the second as fail-safe.
 *
 * `knownHashes` (review r5-w3 blocker 1): for a `relPath` this map covers, its
 * value is written as the base AS-IS (a hex hash, or `null` for observed-absent)
 * instead of a fresh `hashFile` disk read. Late enrollment (see above) is the
 * caller that needs this: hypo-session-start.mjs's HIT branch reads
 * `hit.hotPath`/`hit.statePath` to decide what to SHOW the model, then calls
 * this function to enroll those same two targets. Root targets are always
 * snapshotted first (line ~999 there), so `path` already exists by the time the
 * HIT branch's own call lands here, which used to always take the "enroll"
 * branch below and re-read disk fresh: a SEPARATE read from the one whose
 * bytes the model was just shown. Between those two reads, another writer can
 * change the file: the base would then describe bytes the model never saw, and
 * a close that reapplies a payload built from the shown bytes reads
 * disk-equals-base and overwrites the intervening write with no park. Passing
 * the hash of the exact bytes just shown closes that window: the base can only
 * ever describe what this session was actually shown, never a bystander read.
 * A `relPath` NOT in `knownHashes` still gets the old fresh-disk-read behavior
 * (the root-only call above has no "shown bytes" to pin to, since it runs
 * before any injection decision).
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {string[]} relPaths vault-relative target paths
 * @param {Record<string, string|null>|null} [knownHashes] exact-bytes hash (or
 *   `null` for observed-absent) to record for a `relPath`, bypassing the disk
 *   re-read that would otherwise risk racing a concurrent writer
 * @returns {{created: boolean, reason?: string, enrolled?: string[]}}
 */
export function snapshotBase(hypoDir, sessionId, relPaths, knownHashes = null) {
  if (!sessionId) return { created: false, reason: 'no-session-id' };
  const path = basePath(hypoDir, sessionId);
  // A hash this call was TOLD to use always wins over a disk read: `undefined`
  // (unreadable) is the disk-read fallback's own "leave this key out" signal, so
  // it must never mask an explicit known value.
  const resolveHash = (rel) =>
    knownHashes && Object.prototype.hasOwnProperty.call(knownHashes, rel)
      ? knownHashes[rel]
      : hashFile(join(hypoDir, rel));

  try {
    // Whole function under one lock (major 1, review r5-w3): the "does path
    // exist" branch below and the write that follows it must not interleave
    // with another RMW on this same session's base.json (resume, compact, and
    // this session's own close can all touch it concurrently).
    return withFileLock(path, () => {
      if (existsSync(path)) {
        const parsed = readBaseFile(hypoDir, sessionId);
        // Unreadable/malformed base.json: nothing safe to enroll into, same
        // fallback the pre-enrollment code always gave for an existing file.
        if (!parsed) return { created: false, reason: 'already-snapshotted' };
        const missing = (relPaths || []).filter(
          (rel) => rel && !Object.prototype.hasOwnProperty.call(parsed.targets, rel),
        );
        if (missing.length === 0) return { created: false, reason: 'already-snapshotted' };
        for (const rel of missing) {
          const h = resolveHash(rel);
          if (h !== undefined) parsed.targets[rel] = h;
        }
        try {
          atomicWrite(path, JSON.stringify(parsed, null, 2));
          return { created: false, reason: 'enrolled', enrolled: missing };
        } catch (e) {
          return { created: false, reason: `write-failed: ${e && e.message}` };
        }
      }

      const targets = {};
      for (const rel of relPaths) {
        if (!rel) continue;
        const h = resolveHash(rel);
        // `undefined` (unreadable) is left OUT of the map on purpose: no entry
        // means "unknown", and close fails safe into a proposal rather than
        // assuming a file it could not read was unchanged.
        if (h !== undefined) targets[rel] = h;
      }

      const body = JSON.stringify(
        { session_id: String(sessionId), created_at: new Date().toISOString(), targets },
        null,
        2,
      );

      try {
        mkdirSync(dirname(path), { recursive: true });
        // Exclusive create IS the existence-check, closing the gap between the
        // existsSync above and the write below when two hooks race on one
        // session. Redundant with the outer lock now, kept as a second,
        // cheaper guard: it costs nothing when the lock already serialized us.
        const fd = openSync(path, 'wx');
        try {
          writeSync(fd, body);
        } finally {
          closeSync(fd);
        }
        return { created: true };
      } catch (e) {
        if (e && e.code === 'EEXIST') return { created: false, reason: 'already-snapshotted' };
        // best-effort: a hook must never break a session start over a cache write
        return { created: false, reason: `write-failed: ${e && e.message}` };
      }
    });
  } catch (e) {
    // withFileLock throws on timeout/failure to acquire: best-effort, same as
    // every other outcome here: a hook must never break a session start over
    // a cache write.
    return { created: false, reason: `write-failed: ${e && e.message}` };
  }
}

/**
 * Look up one target's observed base, as a discriminated state.
 *
 *   'hash'     this session observed content; `hash` holds it
 *   'absent'   this session observed the file missing, so creating it is safe
 *   'unknown'  this session never observed it: no snapshot, wrong session,
 *              unreadable at snapshot time, or a target set that shifted
 *              mid-session because cwd moved
 *
 * `state` is the discriminator on purpose. An earlier shape returned
 * `{known, hash}` where BOTH 'absent' and 'unknown' carried `hash: null`, so a
 * consumer branching on `if (!entry.hash)` would read never-observed as
 * safe-to-write and quietly defeat the guard. Branch on `state`, never on the
 * truthiness of `hash`.
 *
 * @returns {{state: 'hash'|'absent'|'unknown', hash: string|null}}
 */
export function readBaseEntry(hypoDir, sessionId, relPath) {
  const unknown = { state: 'unknown', hash: null };
  if (!sessionId) return unknown;
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return unknown;
  if (!Object.prototype.hasOwnProperty.call(parsed.targets, relPath)) return unknown;
  const hash = parsed.targets[relPath];
  if (hash === null) return { state: 'absent', hash: null };
  if (typeof hash !== 'string' || hash === '') return unknown;
  return { state: 'hash', hash };
}

/**
 * Move one target's base to `hash` after this session legitimately wrote it
 * (invariant 2). No-op when the session has no snapshot: with no base there is
 * no guard to keep honest.
 *
 * @returns {boolean} true when the base file was updated
 */
export function advanceBase(hypoDir, sessionId, relPath, hash) {
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      parsed.targets[relPath] = hash;
      try {
        atomicWrite(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Advance a target's base to its current on-disk bytes after the session edited
 * it DIRECTLY (Write/Edit tool), not through crystallize. Invariant 2 covers
 * crystallize's own overwrites; this covers the other way a session legitimately
 * changes a guarded target.
 *
 * Without it, a direct edit looks — at close time — exactly like a DIFFERENT
 * session having written the page: base != disk, so the guard fails safe into a
 * false proposal against the session's own work. `open-questions.md` is the most
 * exposed target, because `/hypo:crystallize` tells the model to fold same-session
 * edits into the close payload. A PostToolUse hook calls this after each wiki
 * write to give the session's own edits provenance.
 *
 * Scoped by tracked-ness, NOT by a target list: `relPath` advances only when the
 * session already has a base entry for it (one of the four overwrite targets
 * snapshotted at start, for the active project). A write to any other wiki file
 * is a no-op, so this never mints a new base key and cannot widen the guard's
 * surface. The file is hashed only once the target is confirmed tracked, so an
 * unrelated write costs one small base.json read and no content hash.
 *
 * An absent or unreadable post-write file leaves the base untouched (returns
 * false) rather than advancing it to null: a target that vanished is a real
 * divergence the close should still fail safe on, not a provenance claim.
 *
 * `knownHash`: when the caller already has the exact bytes the tool wrote (the
 * Write tool carries its full `content`), pass their hash. The base then advances
 * to what the SESSION wrote, not to a fresh disk read — race-safe: if another
 * session overwrote the target in the window between the tool and this call,
 * base = my-bytes ≠ disk, so the close still sees drift and preserves the other
 * write. Callers without the full bytes (Edit/MultiEdit) pass null and take a
 * post-write disk read, which carries a narrow tool→hook race (documented
 * residual in the spec's 보증 범위).
 *
 * This does not weaken the base contract's "no read-just-before-write as base"
 * rule (spec line 40): only the session's OWN writes advance, so a concurrent
 * writer's change to the same target is still observed as drift.
 *
 * @returns {boolean} true when the base file was updated
 */
export function advanceBaseForWrite(hypoDir, sessionId, relPath, absPath, knownHash = null) {
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      // Only a tracked target advances. hasOwnProperty, not truthiness: an
      // observed-absent entry is `null` but still a legitimate key to advance from.
      if (!Object.prototype.hasOwnProperty.call(parsed.targets, relPath)) return false;
      const hash = typeof knownHash === 'string' ? knownHash : hashFile(absPath);
      if (typeof hash !== 'string') return false; // absent/unreadable → leave base as-is
      parsed.targets[relPath] = hash;
      try {
        atomicWrite(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// ── observed set ───────────────────────────────────────────────────────────
//
// `targets` never moves except through the two invariants above, so a session
// that outlives its first snapshot by days sees every intervening legitimate
// write from OTHER sessions as drift and parks all four overwrite targets.
// The observed set is a second, additive record: what this session was
// actually SHOWN by a later SessionStart (resume/compact), kept separate from
// `targets` so it can only ever widen what a close may write, never narrow or
// replace the original base. `readBaseEntry`'s shape and `targets`' meaning
// are unchanged; a consumer that never calls the functions below sees
// identical behavior to before this section existed.
//
// Two guards keep the widening bounded to "what this session was just shown":
//
//   - Generation. `observedGeneration` is a per-session counter, bumped once
//     per SessionStart by `beginObservedGeneration` (BEFORE the first read of
//     that SessionStart, so it covers everything that SessionStart injects).
//     `recordObserved` stamps each entry with the CURRENT generation but never
//     advances it — advancing on every record would put the two files a HIT
//     SessionStart injects (hot.md, session-state.md) into different
//     generations, since they are recorded one call apart, and the second call
//     would expire the first. `readObservedHash` only returns a hash whose
//     `generation` equals the CURRENT `observedGeneration`; a SessionStart
//     that bumps the generation and then injects nothing (ignored, scoped out,
//     absent, no session_id) leaves every existing entry one generation stale,
//     so it reads back as null everywhere. This is what makes "only the most
//     recent SessionStart's injection licenses a write" true without an
//     explicit expiry pass: staleness falls out of the generation compare.
//   - Tracked-key scoping. Exactly like `advanceBaseForWrite`, `recordObserved`
//     is a no-op for a key that is not already in `targets` — it cannot mint a
//     new guarded target, only add provenance to one that was already
//     snapshotted for this session.
//
// One entry per path, not an array: a later observation of the SAME path
// simply overwrites the old `{generation, hash}` pair, so there is no
// unbounded growth to cap or dedup.

/**
 * Bump this session's observed generation. Call once per SessionStart
 * invocation, before the first `recordObserved` of that invocation — this is
 * what makes an injection-free SessionStart (resume that hit no target, a
 * scoped-out file, .hypoignore) expire every prior observation instead of
 * leaving it licensed forever.
 *
 * No-op when the session has no snapshot yet: there is nothing to bump.
 *
 * @returns {boolean} true when base.json was updated
 */
export function beginObservedGeneration(hypoDir, sessionId) {
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      const current = typeof parsed.observedGeneration === 'number' ? parsed.observedGeneration : 0;
      parsed.observedGeneration = current + 1;
      try {
        atomicWrite(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Record that this session was just SHOWN `hash` for `relPath` (the exact
 * bytes a SessionStart injection read, not a fresh disk re-read — the caller
 * must pass the hash of the bytes it actually displayed).
 *
 * `truncated`: true when the injection sliced the file (2000-char HOT_CHARS /
 * STATE_CHARS) before showing it, i.e. the caller only passed `hash` of a
 * prefix's worth of trust even though `hash` itself is the FULL file's hash.
 * A truncated observation is stored, not dropped, so a parked close can name
 * the reason (`base-mismatch-truncated-observation`) instead of the plain
 * `base-mismatch` a bare no-op would produce — but `readObservedHash` below
 * refuses to hand it out as a licence: seeing 5% of a file is not seeing it.
 *
 * No-op, in order: no snapshot for this session; `relPath` is not one of the
 * tracked overwrite targets (mirrors `advanceBaseForWrite`'s scoping --
 * this must not be able to mint a new guarded key). Stamped with the CURRENT
 * `observedGeneration`, never advancing it: the caller advances once via
 * `beginObservedGeneration`, not once per recorded target.
 *
 * @returns {boolean} true when base.json was updated
 */
/**
 * A safe integer, or null. base.json is on disk and another writer (an older
 * release, a half-finished write, a hand edit) can leave any shape in it, so a
 * generation counter is only trusted when it is exactly that: `NaN`, `Infinity`,
 * `1.5` and `"1"` all read as absent rather than as a value to compare against.
 */
function safeGeneration(v) {
  return Number.isSafeInteger(v) ? v : null;
}

export function recordObserved(hypoDir, sessionId, relPath, hash, truncated = false) {
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      if (!Object.prototype.hasOwnProperty.call(parsed.targets, relPath)) return false;
      if (typeof hash !== 'string') return false;
      const generation =
        typeof parsed.observedGeneration === 'number' ? parsed.observedGeneration : 0;
      if (
        !parsed.observed ||
        typeof parsed.observed !== 'object' ||
        Array.isArray(parsed.observed)
      ) {
        parsed.observed = {};
      }
      parsed.observed[relPath] = { generation, hash, truncated: !!truncated };
      try {
        atomicWrite(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * The hash this session was shown for `relPath`, but ONLY when it was shown
 * IN FULL during the CURRENT observed generation — the actual enforcement
 * point of "only the most recent SessionStart's injection licenses a write".
 * Returns null for: no snapshot, a session whose observed-generation counter
 * was never created (see below), no observed entry, a malformed entry, a
 * generation that does not match (stale — superseded by a later SessionStart,
 * or never refreshed by one that injected nothing), or an entry the injection
 * itself marked `truncated`.
 *
 * The `observedGeneration` check is deliberately ASYMMETRIC with how
 * `recordObserved` reads the same field: that function normalizes a missing
 * counter to `0` only to pick a generation to STAMP an entry with. Doing the
 * same here — treating "no counter" as "generation 0" — would make a session
 * whose `beginObservedGeneration` call never ran (never bumped past 0) match
 * an entry `recordObserved` also stamped at 0, and the observed set would
 * license writes despite the expiry mechanism that is supposed to gate it
 * never having run at all. So here, "no counter" reads as "no current
 * generation for anything to match" — null, not 0.
 *
 * @returns {string|null}
 */
export function readObservedHash(hypoDir, sessionId, relPath) {
  if (!sessionId) return null;
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return null;
  const current = safeGeneration(parsed.observedGeneration);
  if (current === null) return null;
  const observed = parsed.observed;
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return null;
  const entry = observed[relPath];
  if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string' || !entry.hash) {
    return null;
  }
  if (safeGeneration(entry.generation) !== current) return null;
  // `truncated` is checked for a STRICT boolean, and any other shape refuses the
  // licence rather than falling through to `=== true` being false. A corrupt
  // `"true"` string used to pass that comparison and hand out a licence for a
  // sliced observation — the one thing this field exists to deny. Corruption
  // parks; it never widens.
  if (entry.truncated !== false) return null;
  return entry.hash;
}

/**
 * Whether this session has a CURRENT-generation observed entry for `relPath`
 * that exists but was marked `truncated` by `recordObserved` — the one bit
 * `readObservedHash`'s null collapses away. Consulted only to pick a park
 * reason (`base-mismatch-truncated-observation` vs plain `base-mismatch`),
 * never to license a write; a caller must keep treating `readObservedHash`'s
 * null as "no licence" regardless of what this returns.
 *
 * @returns {boolean}
 */
export function wasObservedTruncated(hypoDir, sessionId, relPath) {
  if (!sessionId) return false;
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return false;
  const current = safeGeneration(parsed.observedGeneration);
  if (current === null) return false;
  const observed = parsed.observed;
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false;
  const entry = observed[relPath];
  if (!entry || typeof entry !== 'object') return false;
  if (safeGeneration(entry.generation) !== current) return false;
  // Mirrors readObservedHash's strict check: anything that is not exactly `false`
  // counts as truncated here. This only picks the park REASON (readObservedHash
  // has already refused the licence), so erring toward "truncated" names a
  // narrower cause than the generic mismatch and never unblocks a write.
  return entry.truncated !== false;
}

// ── applied set ──────────────────────────────────────────────────────────────
//
// `targets` moves on TWO kinds of legitimate write: crystallize's own overwrite
// (invariant 2, `advanceBase`) and a direct hand edit through the session's own
// Write/Edit tool (`advanceBaseForWrite`, wired from hypo-auto-stage.mjs). Both
// are correct for the guard's original question, "did somebody ELSE change this
// since I last looked": a hand edit is this session's own work, not a foreign
// write, and must not park a close that folds it in.
//
// But the two are NOT the same fact, and `targets` alone cannot tell them
// apart after the fact: once a hand edit advances `targets[relPath]` to match
// its own new bytes, a stale close-apply payload from BEFORE that edit reads
// disk-equals-base and rewrites over the edit with no record it ever
// existed: the payload never touched the edit, and the edit was never
// re-checked against it. `applied` is the narrower, second fact this closes:
// not "what did any write show as the target's provenance", but "what did
// THIS OVERWRITE CALL itself last put down for this key, this session": a
// value only `recordAppliedHash` ever sets, so a hand edit through any other
// path leaves it exactly where the last successful apply left it. When disk no
// longer matches it, something moved the target after that apply without
// going through it again, and the next apply of the same (or same-shaped)
// payload must not silently bury that move.
//
// One entry per path, unconditionally overwritten by the next apply: there is
// no generation to expire here, only ever "what did I last apply", so the
// newest apply is always the only one that matters.

/**
 * Record that THIS session's own overwrite() just wrote `hash` for `relPath`.
 * Scoped by tracked-ness like `advanceBaseForWrite`/`recordObserved`: a no-op
 * for a key outside `targets`, so this can never mint a new guarded target.
 *
 * @returns {boolean} true when base.json was updated
 */
export function recordAppliedHash(hypoDir, sessionId, relPath, hash) {
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      if (!Object.prototype.hasOwnProperty.call(parsed.targets, relPath)) return false;
      if (typeof hash !== 'string') return false;
      if (
        !parsed.appliedHashes ||
        typeof parsed.appliedHashes !== 'object' ||
        Array.isArray(parsed.appliedHashes)
      ) {
        parsed.appliedHashes = {};
      }
      parsed.appliedHashes[relPath] = hash;
      try {
        atomicWrite(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Clear THIS session's recorded applied-hash for `relPath`, without touching
 * `targets`. For a writer that legitimately moves `targets[relPath]` (via
 * `advanceBase`) but has no "applied by an overwrite() call" fact of its own to
 * record.
 *
 * **No production caller right now.** The only one was
 * `hooks/hypo-hot-rebuild.mjs`'s canonical rebuild of the root `hot.md`, and
 * that file left `overwriteTargets` when it became a hook-generated projection,
 * taking the whole base-vs-rebuild contention with it. Kept, with its unit
 * coverage, for the next generated-file target that does get snapshotted; the
 * scenario below is what it is for. Left stale, such a rebuild's `advanceBase`
 * moves `targets`
 * to the rebuilt bytes while `appliedHashes` still names whatever crystallize
 * last applied; a retry of that same stale close payload then reads disk (the
 * rebuilt bytes) as diverged from `appliedHash`, and blocker 2's "any drift
 * from appliedHash parks" guard (`overwriteConflictReason`) mistakes the
 * hook's own routine rebuild for a hand edit and parks it. Clearing removes the
 * stale fact instead of leaving it to misfire: a retry after this sees no
 * `appliedHash` for the target at all, and falls back to the plain base-vs-disk
 * compare, same as a target crystallize has never applied to this session.
 *
 * The cost this accepts: a stale close payload that WOULD have been caught by
 * the applied-hash guard can now overwrite the rebuild's canonical bytes
 * outright, same as it could before blocker 2 existed. Rebuilt content is
 * regenerated on the next Stop hook regardless, so this only trades one park
 * for a page that self-heals a run later, not a real loss.
 *
 * @returns {boolean} true when base.json was updated
 */
export function clearAppliedHash(hypoDir, sessionId, relPath) {
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      if (
        !parsed.appliedHashes ||
        typeof parsed.appliedHashes !== 'object' ||
        Array.isArray(parsed.appliedHashes) ||
        !Object.prototype.hasOwnProperty.call(parsed.appliedHashes, relPath)
      ) {
        return false; // nothing recorded for this target: a no-op, not a failure
      }
      delete parsed.appliedHashes[relPath];
      try {
        atomicWrite(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * `advanceBase` and `recordAppliedHash`, done as ONE read-modify-write instead
 * of two. crystallize's own overwrite() used to call them back to back: if the
 * first write landed and the second then failed (disk full, a permissions
 * change mid-session, any `atomicWrite` failure), `targets[relPath]` had
 * already moved to the new bytes while `appliedHashes[relPath]` silently kept
 * its OLD value (the exact partial state `overwriteConflictReason`'s
 * `appliedHash` check exists to catch, except now self-inflicted): the next
 * apply would read disk-equals-base (base moved), see a stale `appliedHash`
 * that does not match either, and park a WRITE that should have gone through,
 * or (the direction review r4-w4 major 2 flagged) silently clear a
 * genuinely stale reapply's park because the failed record made `appliedHash`
 * read as if this call had never run at all. A `false` return here leaves
 * BOTH fields exactly where they were (the single `atomicWrite` either lands
 * whole or not at all): base does not move, so the next look sees the same
 * `base-mismatch`/`base-hash-target-missing` fail-safe a foreign write would
 * get, never a silent clean read. This is the only caller-visible difference
 * from calling `advanceBase` then `recordAppliedHash` separately: a failure
 * here now costs the base advance too, on purpose, because "recorded the
 * write but forgot who wrote it" is worse than "didn't record it at all".
 *
 * Not a replacement for either function: `advanceBase` alone is the right call
 * for a writer that moves a tracked target but has no "applied by THIS
 * overwrite call" fact to record and must not manufacture one. Its last such
 * caller was hypo-hot-rebuild.mjs, which stopped touching the base when the
 * root `hot.md` left `overwriteTargets`.
 *
 * @param {{ write?: (path: string, content: string) => void }} [testHooks]
 *   `write` is test-only: it stands in for `atomicWrite`, so a test can let the
 *   first save land and fail a second one. A regression back to two saves then
 *   shows up as a moved base with a stale applied hash. Production callers
 *   never pass this.
 * @returns {boolean} true when base.json was updated (both fields together)
 */
export function advanceBaseAndRecordApplied(hypoDir, sessionId, relPath, hash, testHooks) {
  const write = testHooks?.write ?? atomicWrite;
  if (!sessionId) return false;
  const path = basePath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const parsed = readBaseFile(hypoDir, sessionId);
      if (!parsed) return false;
      if (typeof hash !== 'string') return false;
      parsed.targets[relPath] = hash;
      if (
        !parsed.appliedHashes ||
        typeof parsed.appliedHashes !== 'object' ||
        Array.isArray(parsed.appliedHashes)
      ) {
        parsed.appliedHashes = {};
      }
      parsed.appliedHashes[relPath] = hash;
      try {
        write(path, JSON.stringify(parsed, null, 2));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * The hash THIS session's own overwrite() last wrote for `relPath`, or null
 * when it never has (no snapshot, no session, or no recorded entry).
 *
 * @returns {string|null}
 */
export function readAppliedHash(hypoDir, sessionId, relPath) {
  if (!sessionId) return null;
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return null;
  const applied = parsed.appliedHashes;
  if (!applied || typeof applied !== 'object' || Array.isArray(applied)) return null;
  const hash = applied[relPath];
  return typeof hash === 'string' && hash ? hash : null;
}

// The whole-file overwrite targets are prose-and-table markdown documents, and
// a base-mismatch on one of them always parks. Five predicates lived here that tried
// to skip the park when a payload "provably" lost nothing, and four rounds of review
// broke all five against the real vault. The last one accepted an insertion between a
// table's header and its separator, which keeps every byte and stops the table from
// being a table. They all failed the same way: a markdown document's meaning comes
// from block context that begins far above the line under judgement, and a hook that
// may use Node built-ins only is not the place to own a block parser.
//
// The pointer table those predicates were built for is gone from this list, which
// is the fix they were reaching for: the root `hot.md` is now a projection the
// SessionStart and Stop hooks regenerate from `projects/*/hot.md`, not a shared
// whole-file overwrite a close composes by hand. Two machines never contend over
// it, and nothing here needs to prove anything about it.

/**
 * The overwrite targets crystallize replaces wholesale: `pages/open-questions.md`
 * only. A close writes a project's state as a new original entry under
 * `projects/<p>/sessions/`, and `hot.md`/`session-state.md` are generated from
 * those, so none of them is a shared whole-file overwrite any more. `project` is
 * accepted for callers that still pass it and is not used.
 *
 * The root `hot.md` is deliberately NOT here. Snapshotting it made the hooks'
 * own regeneration look like a foreign edit, so a close parked a `base-mismatch`
 * on a file no human had touched. Off the list, there is no base for the guard
 * to compare and no park to false-raise; the projection self-heals on the next
 * Stop hook regardless. Do not add it back without first taking the regeneration
 * out of the hooks.
 */
export function overwriteTargets(project) {
  return [join('pages', 'open-questions.md')];
}
