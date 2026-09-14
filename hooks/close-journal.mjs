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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `<hypoDir>/.cache/close-journal/<sessionId>.json`. */
export function closeJournalPath(hypoDir, sessionId) {
  return join(hypoDir, '.cache', 'close-journal', `${sessionId}.json`);
}

/** Atomic overwrite via tmp+rename, mirroring close-gate-store's atomicWrite. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
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
  if (!existsSync(path)) return {};
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
export function recordJournalEntry(hypoDir, sessionId, relPath, hash) {
  if (!sessionId) return;
  try {
    const paths = readJournal(hypoDir, sessionId);
    paths[relPath] = hash;
    atomicWrite(
      closeJournalPath(hypoDir, sessionId),
      JSON.stringify({ v: 1, sessionId: String(sessionId), paths }, null, 2),
    );
  } catch {
    // best-effort — see doc comment above
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
  try {
    rmSync(closeJournalPath(hypoDir, sessionId), { force: true });
  } catch {
    // best-effort — see doc comment above
  }
}
