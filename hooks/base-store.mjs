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

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  closeSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

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

/** Atomic overwrite via tmp+rename, mirroring crystallize's atomicWrite. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
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
 * Snapshot the observed base hashes for `relPaths`, ONCE per session.
 *
 * Existence-check (invariant 1): when base.json already exists for this session,
 * this is a no-op: resume and compact must not move the base.
 *
 * A target that does not exist on disk is recorded as `null` (observed-absent),
 * which is distinct from having no entry at all (observed-nothing). Close treats
 * the first as "I saw no file, creating it is safe" and the second as fail-safe.
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {string[]} relPaths vault-relative target paths
 * @returns {{created: boolean, reason?: string}}
 */
export function snapshotBase(hypoDir, sessionId, relPaths) {
  if (!sessionId) return { created: false, reason: 'no-session-id' };
  const path = basePath(hypoDir, sessionId);
  if (existsSync(path)) return { created: false, reason: 'already-snapshotted' };

  const targets = {};
  for (const rel of relPaths) {
    if (!rel) continue;
    const h = hashFile(join(hypoDir, rel));
    // `undefined` (unreadable) is left OUT of the map on purpose: no entry means
    // "unknown", and close fails safe into a proposal rather than assuming a
    // file it could not read was unchanged.
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
    // existsSync above and the write below when two hooks race on one session.
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
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return false;
  parsed.targets[relPath] = hash;
  try {
    atomicWrite(basePath(hypoDir, sessionId), JSON.stringify(parsed, null, 2));
    return true;
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
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return false;
  // Only a tracked target advances. hasOwnProperty, not truthiness: an
  // observed-absent entry is `null` but still a legitimate key to advance from.
  if (!Object.prototype.hasOwnProperty.call(parsed.targets, relPath)) return false;
  const hash = typeof knownHash === 'string' ? knownHash : hashFile(absPath);
  if (typeof hash !== 'string') return false; // absent/unreadable → leave base as-is
  parsed.targets[relPath] = hash;
  try {
    atomicWrite(basePath(hypoDir, sessionId), JSON.stringify(parsed, null, 2));
    return true;
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
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return false;
  const current = typeof parsed.observedGeneration === 'number' ? parsed.observedGeneration : 0;
  parsed.observedGeneration = current + 1;
  try {
    atomicWrite(basePath(hypoDir, sessionId), JSON.stringify(parsed, null, 2));
    return true;
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
 * four tracked overwrite targets (mirrors `advanceBaseForWrite`'s scoping —
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
  const parsed = readBaseFile(hypoDir, sessionId);
  if (!parsed) return false;
  if (!Object.prototype.hasOwnProperty.call(parsed.targets, relPath)) return false;
  if (typeof hash !== 'string') return false;
  const generation = typeof parsed.observedGeneration === 'number' ? parsed.observedGeneration : 0;
  if (!parsed.observed || typeof parsed.observed !== 'object' || Array.isArray(parsed.observed)) {
    parsed.observed = {};
  }
  parsed.observed[relPath] = { generation, hash, truncated: !!truncated };
  try {
    atomicWrite(basePath(hypoDir, sessionId), JSON.stringify(parsed, null, 2));
    return true;
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

// The four whole-file overwrite targets are prose-and-table markdown documents, and
// a base-mismatch on one of them always parks. Five predicates lived here that tried
// to skip the park when a payload "provably" lost nothing, and four rounds of review
// broke all five against the real vault. The last one accepted an insertion between a
// table's header and its separator, which keeps every byte and stops the table from
// being a table. They all failed the same way: a markdown document's meaning comes
// from block context that begins far above the line under judgement, and a hook that
// may use Node built-ins only is not the place to own a block parser.
//
// The pointer table this was built for should stop being a shared whole-file
// overwrite target and become a locally generated projection of the per-project files
// that already own those facts. Then two machines never contend over it, and nothing
// here needs to prove anything.

/**
 * The four overwrite targets crystallize replaces wholesale. `project` may be
 * null when cwd resolves to no project; the two project-scoped paths are then
 * omitted and close falls back to proposal for them.
 */
export function overwriteTargets(project) {
  const targets = ['hot.md', join('pages', 'open-questions.md')];
  if (project) {
    targets.unshift(join('projects', project, 'session-state.md'));
    targets.unshift(join('projects', project, 'hot.md'));
  }
  return targets;
}
