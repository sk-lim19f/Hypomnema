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
