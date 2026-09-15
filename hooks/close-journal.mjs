// hooks/close-journal.mjs — the close journal: which relative paths THIS
// session's close actually wrote, and the hash it wrote each one as.
//
// Lives in hooks/ for the same reason close-gate-store.mjs does: scripts/
// imports hooks/, never the reverse, and a hook copied standalone into
// ~/.claude/hooks/ cannot resolve a scripts/ import. Node built-ins only.
//
// Why this exists: applySessionClose treats a payload field as "already
// current" (an overwrite whose disk bytes already match the payload, or an
// append whose entry is already present) and skips writing it — the whole
// point of that skip is to make a same-payload retry cheap. But a close that
// partially failed (one field conflicted, the commit itself failed, the
// process was killed between write and commit) can leave EARLIER fields
// already written to disk and still uncommitted. The retry's skip then drops
// those paths out of the commit scope entirely, because "already current"
// and "already committed" look identical from the skip branch alone — and
// nothing ever re-adds them, so the close gate blocks on the same dirty
// files forever. The journal is what tells the retry apart: a path recorded
// here, whose disk hash still matches what was recorded, is this session's
// own uncommitted work and safe to restage. A path with no record, or one
// whose disk hash has since moved, is not — somebody else's bytes are
// sitting there, and the gate should keep blocking on them, not silently
// fold them into this close's commit.
//
// Mirrors close-gate-store.mjs's shape: same `.cache/<name>/<sessionId>.json`
// path convention, same atomic tmp+rename write, same "unreadable or corrupt
// reads as empty" polarity. A journal this module cannot trust must only ever
// NARROW what a retry is allowed to restage, never widen it — the same
// direction close-gate-store's NO_CONSTRAINT keeps for its own file.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './atomic-write.mjs';
import { isValidSessionId } from './proposal-store.mjs';
import { withFileLock } from './hypo-shared.mjs';

/**
 * `<hypoDir>/.cache/close-journal/<sessionId>.json`, or null when the id is not
 * a shape that is safe to use as a filename.
 *
 * The check lives HERE, at the sink, not only at the CLI entry points that
 * happen to call this today. Every entry point did validate, and the hole
 * opened anyway the moment a new caller (reconcile) fed this an id read back
 * out of `.cache/proposals/applied.log` rather than typed by a person: a
 * `closeSessionId` of `../../../../../Users/<you>/.claude/settings` resolves
 * clean out of the vault, and the caller then atomically overwrites whatever
 * is there. Guarding each caller is what produced that gap; guarding the one
 * place the string becomes a path is what closes it for callers not written yet.
 *
 * Returns null rather than throwing so the read path can keep treating an
 * unusable journal as "nothing recorded", which is the direction it already
 * fails in for a corrupt or absent file.
 */
export function closeJournalPath(hypoDir, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  return join(hypoDir, '.cache', 'close-journal', `${sessionId}.json`);
}

/**
 * Read this session's journal. Absent, corrupt, or wrong-shaped reads as
 * `{}` — never partially trusted. A caller that widened a retry off a
 * malformed record here would be exactly the failure mode this file exists
 * to avoid, so any doubt about the shape falls back to "nothing recorded".
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @returns {Record<string, string>} relPath -> the hash this session wrote it as
 */
export function readJournal(hypoDir, sessionId) {
  if (!sessionId) return {};
  const path = closeJournalPath(hypoDir, sessionId);
  // An id that cannot be a filename has no journal, which reads the same as an
  // absent one. Same direction this function already fails in.
  if (path === null || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if (parsed.v !== 1 || !parsed.paths || typeof parsed.paths !== 'object') return {};
    const out = {};
    for (const [relPath, hash] of Object.entries(parsed.paths)) {
      if (typeof hash === 'string') out[relPath] = hash;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record that this session wrote `relPath` as `hash`. Callers must call this
 * AFTER the byte write it describes, never before: the journal is read to
 * decide whether a write already landed, and a record ahead of the write it
 * names would let a crash between the two claim credit for bytes that were
 * never actually put down.
 *
 * Read-modify-write, not append-only: one close touches several paths across
 * several call sites in one process, and each call needs the earlier ones'
 * entries still present when it re-saves the file. Best-effort like every
 * other write in this store — a journal write failure must never fail a close
 * over bytes that already landed; it only costs that one path its fast
 * restage on a future retry, which falls back to the ordinary gate block, the
 * safe direction to fail toward.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {string} relPath vault-relative path, exactly as it appears in
 *   `appliedPaths` / `commitWikiChanges`
 * @param {string} hash sha256 hex of the bytes just written (hashContent)
 */
/**
 * The read half of a read-modify-write, for callers that already hold the
 * journal's lock. Public readJournal takes no lock: atomicWrite's rename means
 * a reader sees one whole version or another, never a torn one. Re-entering the
 * lock from inside it would deadlock the writers below.
 */
function readJournalAt(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    if (parsed.v !== 1 || !parsed.paths || typeof parsed.paths !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed.paths)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordJournalEntry(hypoDir, sessionId, relPath, hash) {
  if (!sessionId) return;
  const path = closeJournalPath(hypoDir, sessionId);
  // Unusable id: nothing to record against, and nowhere safe to put it. This
  // one is best-effort by contract, so it declines the same way it declines a
  // failed write.
  if (path === null) return;
  try {
    // Read-modify-write under the journal's own lock. atomicWrite already stops
    // a reader seeing a torn file; what it cannot stop is two writers each
    // reading the same `paths` and the second saving a copy that never had the
    // first one's entry. Every mutator here takes the same lock, so they
    // serialise against each other and against clearJournal.
    withFileLock(path, () => {
      const paths = readJournalAt(path);
      paths[relPath] = hash;
      atomicWrite(path, JSON.stringify({ v: 1, sessionId: String(sessionId), paths }, null, 2));
    });
  } catch {
    // best-effort — see doc comment above
  }
}

/**
 * Record ONE close handoff receipt: a target that a DIFFERENT session's
 * approved `proposal resolve` just wrote, credited back to the close whose
 * park produced it.
 *
 * Same on-disk shape as recordJournalEntry (readJournal reads either one the
 * same way), but not best-effort. recordJournalEntry swallows a write
 * failure on purpose: the bytes it describes were ALSO written by this same
 * close's own overwrite step moments earlier, so a lost entry only costs a
 * future retry its fast restage and falls back to the ordinary gate block,
 * the safe direction to fail toward. A handoff receipt has no such fallback.
 * The bytes it describes were written by a HUMAN approval in a possibly
 * unrelated session, and the proposal artifact that once pointed at them is
 * deleted the moment that write succeeds (the T7 CLI's writeApprovedProposal,
 * step 12), so if this call fails silently, the owning close's retry can
 * never find those bytes again by any means. The T7 CLI must see the failure
 * and hold the artifact and audit entry instead of deleting them
 * (`close-receipt-failed`), or the failure disappears along with the
 * artifact.
 *
 * @param {string} hypoDir
 * @param {string} closeSessionId the ORIGINATING close's session id, not the
 *   session that approved the resolve. Legacy challenges/artifacts that
 *   predate this field are read as this being the SAME session that resolved
 *   them (see the T7 CLI), so this parameter is never called with
 *   an empty value from that path.
 * @param {string} relPath vault-relative path, exactly as it appears in the
 *   proposal artifact's `target`
 * @param {string} hash sha256 hex of the bytes just written, the SAME
 *   hashContent() crystallize's own overwrite step hashes with (base-store.mjs),
 *   so the retry's `journalHash === hashContent(disk)` comparison in
 *   crystallize-close-apply.mjs trusts a receipt exactly as much as its own
 *   same-session entries.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function recordHandoffReceipt(hypoDir, closeSessionId, relPath, hash) {
  if (!closeSessionId) return { ok: false, error: 'no closeSessionId to journal against' };
  const path = closeJournalPath(hypoDir, closeSessionId);
  // Strict by contract, so an unusable id is a reported failure rather than a
  // quiet decline. This is the call reconcile makes with an id it read out of
  // the audit log, so it is the one that must not treat a hostile string as
  // merely unlucky.
  if (path === null) {
    return {
      ok: false,
      error: `closeSessionId is not a usable session id: ${JSON.stringify(closeSessionId)}`,
    };
  }
  try {
    // Same lock as every other mutator. Without it, two resolves handing off to
    // the same close, or a resolve racing that close's own clearJournal, could
    // each return ok:true while one receipt silently vanished. The artifact is
    // deleted the moment this returns ok, and reconcile only ever considers
    // artifacts, so a lost receipt would have no way back.
    withFileLock(path, () => {
      const paths = readJournalAt(path);
      paths[relPath] = hash;
      atomicWrite(
        path,
        JSON.stringify({ v: 1, sessionId: String(closeSessionId), paths }, null, 2),
      );
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Clear this session's journal once its close has actually committed. A
 * journal entry that outlives a successful commit would keep offering to
 * restage bytes for a path this SAME session might legitimately touch again
 * later in an unrelated close — the hash comparison alone cannot tell "still
 * my uncommitted work" from "coincidentally the same bytes, much later" once
 * the first close is done. Best-effort: a leftover file after a successful
 * close is at worst a future no-op restore attempt (the hash still has to
 * match), never a data-loss risk on its own.
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 */
export function clearJournal(hypoDir, sessionId) {
  if (!sessionId) return;
  const path = closeJournalPath(hypoDir, sessionId);
  // An id that never produced a path never produced a file to remove, and an
  // rmSync on a traversed path would be the destructive half of the same hole.
  if (path === null) return;
  try {
    // Under the same lock: a clear landing between another writer's read and
    // its save would be undone by that save, resurrecting a journal the close
    // had already consumed.
    withFileLock(path, () => {
      rmSync(path, { force: true });
    });
  } catch {
    // best-effort — see doc comment above
  }
}
