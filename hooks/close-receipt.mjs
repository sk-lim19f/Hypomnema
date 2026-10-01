// hooks/close-receipt.mjs, commit-based close receipt: read, write, verify.
//
// Design lives in the maintainer's private wiki (a close-marker redesign
// spec: a name/shape contract plus its follow-up rounds). Not reproduced
// here since this file ships publicly and the spec does not.
//
// What this replaces: a session-close marker used to infer "this session's
// work is saved" from git cleanliness at close time (a clean tree was read
// as nothing left to save). Cleanliness is a property of the whole tree at
// one instant, so another session's commit or edit changes the answer
// without this session's own bytes being saved or lost. This module
// certifies a narrower, provable claim instead: "the file versions named in this receipt are all present, byte-for-byte,
// in commit C, which is reachable from the current branch history". It says
// nothing about files it does not name, and nothing about whether the rest
// of the session's work was ever saved at all, callers (Stop, PreCompact,
// doctor) must keep surfacing unresolved changes separately, never read a
// valid receipt as "the vault is clean".
//
// Node built-ins only, per the hooks/ convention (this file is copied
// standalone into `~/.claude/hooks/` on install; `scripts/` may import it,
// never the reverse). Listed in `hooks/shared.json`.
//
// Session id validation reuses `isValidSessionId` (hooks/proposal-store.mjs)
// rather than re-deriving a shape check: a session id reaches this module the
// same way it reaches the proposal store, straight off `--session-id`, and it
// becomes a filename component here exactly as it does there. The receipt
// directory name (`.cache/sessions/<id>/`) follows the same rule as
// hypo-shared.mjs's per-session cache directory: `sanitizeSessionId`, which
// caps the id at 128 characters. `isValidSessionId` has no length cap, so an
// id longer than 128 maps to a truncated directory name; two such ids that
// share their first 128 characters share a directory, and
// `readReceiptStrict`'s session id comparison rejects the other session's
// receipt.

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicWrite } from './atomic-write.mjs';
import {
  sessionClosedMarkerPath,
  sanitizeSessionId,
  readSessionClosedMarker,
} from './hypo-shared.mjs';
import { isValidSessionId } from './proposal-store.mjs';

export const RECEIPT_SCHEMA_VERSION = 1;
/** Certification value an apply-path (full close, expected-bytes verified) issues. */
export const CERT_CHECKPOINT = 'committed-close-checkpoint';
/** Certification value `--mark-session-closed` (no payload, weaker proof) issues. */
export const CERT_CLOSE_FILES = 'committed-close-files';

// A full object id: 40 hex (sha1) or 64 hex (sha256 repositories). One
// pattern for the receipt's commit field and for a tree entry's blob oid.
const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
// A git tree entry mode as ls-tree prints it (100644, 100755, 120000, ...).
const TREE_MODE_RE = /^[0-7]{6}$/;

// The proof kinds a receipt WRITER actually emits (scripts/lib/
// crystallize-close-apply.mjs: the apply path's write phases and
// buildMarkCloseProof). verifyEntriesInCommit also understands 'absent', but no
// writer files one, so a stored receipt that names it was not written by us.
const RECEIPT_ENTRY_KINDS = new Set(['overwrite', 'create', 'append', 'schema-pending']);

const GIT_TIMEOUT_MS = 30000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Run a git subcommand rooted at `hypoDir`, text mode. */
function gitText(hypoDir, args) {
  return spawnSync('git', ['-C', hypoDir, ...args], {
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/**
 * Run `git cat-file -p <oid>` and return its RAW bytes as a Buffer, no
 * `encoding` option, so spawnSync hands back stdout undecoded. A blob is
 * compared and hashed as bytes, never as a UTF-8 string: decoding first would
 * let two blobs that differ only in an invalid UTF-8 sequence collapse to the
 * same JS string (or throw away the offending bytes), hiding exactly the kind
 * of corruption a close receipt exists to catch.
 * @returns {Buffer|null} null on any git failure (timeout, bad oid, non-repo)
 */
function catFileBuffer(hypoDir, oid) {
  const res = spawnSync('git', ['-C', hypoDir, 'cat-file', '-p', oid], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (res.error || res.status !== 0 || !Buffer.isBuffer(res.stdout)) return null;
  return res.stdout;
}

/**
 * Look up one path's tree entry inside `commit`. `-r` so a nested path
 * resolves in one call without walking subtrees by hand. `--full-tree` is
 * deliberately absent: a receipt path is relative to the vault, and the vault
 * may be a subdirectory of the repository, so git must resolve the pathspec
 * against `-C hypoDir` (the vault), not the repository root. `-z` keeps a
 * non-ASCII path byte-exact (no quotepath escaping) and splits records on NUL.
 * The exact matching path is picked out of the (possibly multi-record, if the
 * pathspec were ambiguous) output rather than trusting "first record".
 * @returns {{ok: true, present: false}|{ok: true, present: true, mode: string, oid: string}|{ok: false, reason: string}}
 */
function lsTreeEntry(hypoDir, commit, path) {
  const res = gitText(hypoDir, ['ls-tree', '-r', '-z', commit, '--', path]);
  if (res.error) return { ok: false, reason: `git-error: ${res.error.message}` };
  if (res.status !== 0) {
    return { ok: false, reason: `ls-tree-failed: ${(res.stderr || '').trim() || 'unknown'}` };
  }
  const records = (res.stdout || '').split('\0').filter(Boolean);
  if (records.length === 0) return { ok: true, present: false };
  // `<mode> <type> <oid>\t<path>`, tab-separated path field, exact match only
  // (a pathspec that happened to match a sibling would otherwise silently pass).
  const record = records.find((r) => r.slice(r.indexOf('\t') + 1) === path);
  if (!record) return { ok: false, reason: 'ls-tree-path-mismatch' };
  const head = record.slice(0, record.indexOf('\t'));
  const m = /^(\d+) \S+ (\S+)$/.exec(head);
  if (!m || !OID_RE.test(m[2])) return { ok: false, reason: 'ls-tree-parse-failed' };
  return { ok: true, present: true, mode: m[1], oid: m[2] };
}

// Copy of `scripts/lib/schema-vocab.mjs`'s section bounds for the
// `**Pending**:` data line. `scripts/` cannot be imported from `hooks/`
// (dependency direction is one-way the other way), so the four patterns below
// are a separately-maintained duplicate and must be kept in step with it. The
// walk is the same: the "## Tag Vocabulary" H2 section (ended by the next
// H2), inside it the "### Pending" subsection (ended by the next H3), inside
// that the first `**Pending**:` data line. A `**Pending**:` line anywhere
// outside that subsection is not pending vocabulary and is ignored, so a
// receipt can never be satisfied by a line the real parser would not read.
const VOCAB_HEADER_RE = /^##\s+(?:\d+\.\s+)?Tag\s+(?:Vocabulary|Taxonomy)\s*$/m;
const NEXT_H2_RE = /^##\s+/m;
const PENDING_HEADING_RE = /^###[ \t]+Pending\b.*$/im;
const NEXT_H3_RE = /^###[ \t]+/m;
const PENDING_DATA_RE = /^\*\*Pending[^*]*\*\*:.*$/im;
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

function parsePendingTags(content) {
  const tags = new Set();
  const text = content || '';
  const header = VOCAB_HEADER_RE.exec(text);
  if (!header) return tags;
  const rest = text.slice(header.index + header[0].length);
  const nextH2 = NEXT_H2_RE.exec(rest);
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest;
  const heading = PENDING_HEADING_RE.exec(section);
  if (!heading) return tags;
  const afterHeading = section.slice(heading.index + heading[0].length);
  const nextH3 = NEXT_H3_RE.exec(afterHeading);
  const sub = nextH3 ? afterHeading.slice(0, nextH3.index) : afterHeading;
  const m = PENDING_DATA_RE.exec(sub);
  if (!m) return tags;
  for (const tok of m[0].matchAll(BACKTICK_TOKEN_RE)) {
    const t = tok[1].trim();
    if (t && !t.includes(' ')) tags.add(t);
  }
  return tags;
}

/**
 * `<hypoDir>/.cache/sessions/<sessionId>/close-receipt.json`. Returns `null`
 * for a session id `isValidSessionId` rejects, never falls back to a shared
 * path, since a receipt filed under a bad id would otherwise collide with
 * every other bad id.
 * @returns {string|null}
 */
export function receiptPath(hypoDir, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  return join(hypoDir, '.cache', 'sessions', sanitizeSessionId(sessionId), 'close-receipt.json');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyStringArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x);
}

/**
 * One receipt entry's shape: a vault-relative path that cannot climb out of
 * the vault, a kind a writer emits, and an `expected` that gives
 * verifyEntriesInCommit something to compare. An overwrite/create whose
 * `expected` names neither a sha256 nor a blob oid would verify as a match
 * against any committed bytes, so it is rejected here too.
 */
function isWellFormedEntry(entry) {
  if (!isPlainObject(entry)) return false;
  const { path, kind, expected } = entry;
  if (typeof path !== 'string' || !path || isAbsolute(path) || /^[\\/]/.test(path)) return false;
  if (path.split(/[\\/]/).includes('..')) return false;
  if (!RECEIPT_ENTRY_KINDS.has(kind) || !isPlainObject(expected)) return false;
  if (kind === 'overwrite' || kind === 'create') {
    const { bytesSha256, blob, mode } = expected;
    if (
      bytesSha256 !== undefined &&
      !(typeof bytesSha256 === 'string' && SHA256_HEX_RE.test(bytesSha256))
    )
      return false;
    if (blob !== undefined && !(typeof blob === 'string' && OID_RE.test(blob))) return false;
    if (mode !== undefined && !(typeof mode === 'string' && TREE_MODE_RE.test(mode))) return false;
    return bytesSha256 !== undefined || blob !== undefined;
  }
  if (kind === 'append') return isNonEmptyStringArray(expected.entryBlocks);
  return isNonEmptyStringArray(expected.tags); // schema-pending
}

/**
 * Read and strictly validate a session's close receipt: parse, schema
 * version, certification value, session id match, entry shape (see
 * isWellFormedEntry), repo identity, and commit reachability from the CURRENT
 * branch history. Any failure at any step is
 * `invalid`, never silently treated as `missing`, a caller must be able to
 * tell "no receipt was ever written" from "a receipt exists but cannot be
 * trusted", since the two call for different user-facing advice.
 *
 * @returns {{status: 'valid', receipt: object}
 *   | {status: 'missing'}
 *   | {status: 'invalid', reason: string}}
 */
export function readReceiptStrict(hypoDir, sessionId) {
  const path = receiptPath(hypoDir, sessionId);
  if (!path) return { status: 'invalid', reason: 'invalid-session-id' };
  if (!existsSync(path)) return { status: 'missing' };

  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { status: 'invalid', reason: 'parse-error' };
  }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { status: 'invalid', reason: 'malformed' };
  }
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    // Includes an unknown/future version, never assumed forward-compatible.
    return { status: 'invalid', reason: 'schema-version-mismatch' };
  }
  if (receipt.certification !== CERT_CHECKPOINT && receipt.certification !== CERT_CLOSE_FILES) {
    return { status: 'invalid', reason: 'unknown-certification' };
  }
  if (String(receipt.sessionId) !== String(sessionId)) {
    return { status: 'invalid', reason: 'session-id-mismatch' };
  }
  if (typeof receipt.commit !== 'string' || !OID_RE.test(receipt.commit)) {
    return { status: 'invalid', reason: 'malformed-commit' };
  }
  if (!Array.isArray(receipt.entries)) {
    return { status: 'invalid', reason: 'malformed-entries' };
  }
  // Shape only, no git objects: Stop reads this on every close-intent turn, and
  // the byte-level check belongs to verifyEntriesInCommit at write time. What
  // this rules out is a receipt that certifies nothing (no entries) or an entry
  // verifyEntriesInCommit would have waved through without checking anything.
  if (receipt.entries.length === 0) {
    return { status: 'invalid', reason: 'empty-entries' };
  }
  if (receipt.entries.some((e) => !isWellFormedEntry(e))) {
    return { status: 'invalid', reason: 'malformed-entry' };
  }
  if (
    !receipt.repo ||
    typeof receipt.repo !== 'object' ||
    typeof receipt.repo.toplevel !== 'string' ||
    !receipt.repo.toplevel
  ) {
    return { status: 'invalid', reason: 'malformed-repo' };
  }

  const toplevelRes = gitText(hypoDir, ['rev-parse', '--show-toplevel']);
  if (toplevelRes.error || toplevelRes.status !== 0) {
    return { status: 'invalid', reason: 'not-a-git-repository' };
  }
  // trim() on purpose, unlike the path outputs elsewhere: this value is only ever compared with
  // the toplevel the receipt was issued with, which repoIdentity trims the same way, so both
  // sides agree. Changing one side alone would void receipts issued by the other (an npm
  // install can run a newer issuer against an older deployed copy of this file). If something
  // ever uses this as a path, change both sides together.
  const actualToplevel = (toplevelRes.stdout || '').trim();
  if (actualToplevel !== receipt.repo.toplevel) {
    return { status: 'invalid', reason: 'repo-mismatch' };
  }

  // Reachability: a commit that reset/rebase dropped from history must not
  // keep certifying a close forever. `--is-ancestor` exits 0 only when
  // `commit` is an ancestor of (or equal to) HEAD; any other exit code
  // (not found, not an ancestor, git error) is "cannot stand behind this".
  const ancestry = gitText(hypoDir, ['merge-base', '--is-ancestor', receipt.commit, 'HEAD']);
  if (ancestry.error || ancestry.status !== 0) {
    return { status: 'invalid', reason: 'commit-unreachable' };
  }

  return { status: 'valid', receipt };
}

/**
 * Verify every proof entry against the actual git objects in `commit`. This
 * is the one place bytes/mode/append/pending claims get checked against
 * reality, a caller must never accept `appliedPaths.length === 0` or a
 * commit helper's bare success as content proof; this function is what
 * closes that gap by reading the committed tree itself.
 *
 * @param {string} hypoDir
 * @param {string} commit a commit-ish (full sha expected in practice)
 * @param {Array<{path: string, kind: 'overwrite'|'create'|'append'|'schema-pending'|'absent',
 *   expected?: {blob?: string, mode?: string, bytesSha256?: string, entryBlocks?: string[], tags?: string[]}}>} entries
 * @returns {{ok: boolean, mismatches: Array<{path: string, reason: string}>}}
 */
export function verifyEntriesInCommit(hypoDir, commit, entries) {
  const mismatches = [];
  for (const entry of entries || []) {
    const path = entry && entry.path;
    const kind = entry && entry.kind;
    const expected = (entry && entry.expected) || {};
    if (typeof path !== 'string' || !path) {
      mismatches.push({
        path: typeof path === 'string' ? path : '(missing path)',
        reason: 'invalid-entry',
      });
      continue;
    }

    const lookup = lsTreeEntry(hypoDir, commit, path);
    if (!lookup.ok) {
      mismatches.push({ path, reason: lookup.reason });
      continue;
    }

    if (kind === 'absent') {
      if (lookup.present) mismatches.push({ path, reason: 'expected-absent-but-present' });
      continue;
    }

    if (!lookup.present) {
      mismatches.push({ path, reason: 'missing-entry' });
      continue;
    }

    if (kind === 'overwrite' || kind === 'create') {
      if (typeof expected.mode === 'string' && expected.mode && lookup.mode !== expected.mode) {
        mismatches.push({ path, reason: 'mode-mismatch' });
        continue;
      }
      if (typeof expected.blob === 'string' && expected.blob && lookup.oid !== expected.blob) {
        mismatches.push({ path, reason: 'blob-mismatch' });
        continue;
      }
      if (typeof expected.bytesSha256 === 'string' && expected.bytesSha256) {
        const buf = catFileBuffer(hypoDir, lookup.oid);
        if (buf === null) {
          mismatches.push({ path, reason: 'object-unreadable' });
          continue;
        }
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== expected.bytesSha256) {
          mismatches.push({ path, reason: 'blob-mismatch' });
          continue;
        }
      }
      continue;
    }

    if (kind === 'append') {
      const blocks = Array.isArray(expected.entryBlocks) ? expected.entryBlocks : [];
      if (blocks.length === 0) {
        mismatches.push({ path, reason: 'append-incomplete' });
        continue;
      }
      const buf = catFileBuffer(hypoDir, lookup.oid);
      if (buf === null) {
        mismatches.push({ path, reason: 'object-unreadable' });
        continue;
      }
      // Search as text: an append block is prose (a log/session-log entry),
      // not a byte-exact whole-file claim, so containment is checked against
      // the decoded string. This does not weaken the raw-byte rule above ,
      // overwrite/create still hash the untouched Buffer, it only means an
      // append entry cannot detect a change OUTSIDE the block it names, which
      // is the documented limit of "append" as a proof kind (containment of
      // the named blocks, not equality of the whole file).
      const text = buf.toString('utf-8');
      const missing = blocks.some((b) => typeof b !== 'string' || !b || !text.includes(b));
      if (missing) mismatches.push({ path, reason: 'append-incomplete' });
      continue;
    }

    if (kind === 'schema-pending') {
      const tags = Array.isArray(expected.tags) ? expected.tags : [];
      if (tags.length === 0) {
        mismatches.push({ path, reason: 'schema-pending-missing' });
        continue;
      }
      const buf = catFileBuffer(hypoDir, lookup.oid);
      if (buf === null) {
        mismatches.push({ path, reason: 'object-unreadable' });
        continue;
      }
      const pending = parsePendingTags(buf.toString('utf-8'));
      const missing = tags.some((t) => !pending.has(t));
      if (missing) mismatches.push({ path, reason: 'schema-pending-missing' });
      continue;
    }

    mismatches.push({ path, reason: `unknown-kind: ${String(kind)}` });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Write a receipt via temp+rename, then re-read and re-parse it to confirm
 * the bytes that landed are the bytes intended, `atomicWrite`'s rename
 * already rules out a torn file, but not a filesystem that silently
 * truncates/rejects a write the process itself did not detect as an error.
 * A caller (the close-authority holder) must not proceed as if a receipt
 * exists when this returns `ok: false`; the write may or may not have
 * landed, and only the caller's own retry/backoff policy decides what to
 * do next.
 * @returns {{ok: true, path: string} | {ok: false, path?: string, reason: string}}
 */
export function writeReceiptAtomic(hypoDir, sessionId, receipt) {
  const path = receiptPath(hypoDir, sessionId);
  if (!path) return { ok: false, reason: 'invalid-session-id' };
  const body = JSON.stringify(receipt, null, 2);
  try {
    atomicWrite(path, body);
  } catch (e) {
    return { ok: false, path, reason: `write-failed: ${e && e.message}` };
  }
  try {
    const reread = readFileSync(path, 'utf-8');
    if (reread !== body) return { ok: false, path, reason: 'reread-mismatch' };
    JSON.parse(reread); // re-parse: catch anything a byte-equal check would miss (belt only)
  } catch (e) {
    return { ok: false, path, reason: `reread-failed: ${e && e.message}` };
  }
  return { ok: true, path };
}

/** Rename `path` to `<path>.invalidated-<ts>`. Absent is success: there was
 * nothing to invalidate under this name. */
function invalidateOne(path) {
  if (!existsSync(path)) return { ok: true };
  const dest = `${path}.invalidated-${Date.now()}`;
  try {
    renameSync(path, dest);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `rename-failed: ${e && e.message}` };
  }
}

/**
 * Invalidate this session's prior close artifacts before a new close
 * request is accepted: the compat MARKER first, the RECEIPT second. If the process dies between the two renames, only the
 * receipt is left, never a marker with no backing receipt, which would let
 * an old-Stop reader treat a stale marker as fresh. `<name>.invalidated-<ts>`
 * (not `.marker` at the end) so doctor's marker-file scan and the
 * legacy-closed acceptance path (which only look at names ending `.marker`)
 * never pick an invalidated file back up.
 *
 * `testHooks.afterFirstRename` runs between the two renames. It exists so a
 * test can stop the process at that exact point and see which artifact is
 * already gone; production callers never pass it.
 * @param {{afterFirstRename?: () => void}} [testHooks]
 * @returns {{ok: boolean, reason?: string}}
 */
export function invalidateCloseArtifacts(hypoDir, sessionId, testHooks = {}) {
  const markerResult = invalidateOne(sessionClosedMarkerPath(hypoDir, sessionId));
  if (!markerResult.ok) return markerResult;
  testHooks.afterFirstRename?.();
  const receipt = receiptPath(hypoDir, sessionId);
  if (!receipt) return { ok: true }; // invalid session id: nothing filed under it to invalidate
  return invalidateOne(receipt);
}

/** The two states that count as "this session's close is done". */
const CLOSE_COMPLETE_STATES = new Set(['closed', 'legacy-closed']);

/** @returns {boolean} true when `checkpoint` (a closeCheckpointState result) is a finished close. */
export function isCloseComplete(checkpoint) {
  return !!checkpoint && CLOSE_COMPLETE_STATES.has(checkpoint.state);
}

/**
 * The one verdict on "is this session's close done", shared by Stop, the
 * `--check-session-close` diagnostic, doctor, and the PreCompact gate so the
 * four cannot drift apart. It pairs the receipt with the compat marker that
 * projects it:
 *
 *   closed         the receipt is valid, and a marker names that same receipt
 *                  generation.
 *   legacy-closed  no receipt, and a marker that names no receipt generation
 *                  (an older writer; the marker's own 7-day TTL still applies).
 *   broken         the two disagree: a marker promises a receipt that is
 *                  missing, invalid, or a different generation, or a valid
 *                  receipt has no marker or a mismatched one (a close that
 *                  stopped between its two writes, or an invalidation that
 *                  moved only one of them). An invalid receipt with no marker
 *                  is broken too: something was filed and cannot be trusted.
 *   open           neither a receipt nor a marker.
 *
 * Only `closed` and `legacy-closed` are a finished close (isCloseComplete).
 * `reason` is one human-readable line for `broken` and `open`, else null.
 *
 * A session id that isValidSessionId rejects has no receipt path at all, so
 * its receipt reads as missing rather than invalid: no receipt can ever be
 * filed under it, and a legacy marker for it stays legacy-closed.
 *
 * `opts.marker`, when the key is present, is used instead of reading the
 * marker: readSessionClosedMarker unlinks an expired or corrupt marker as it
 * reads, and doctor (a read-only health check) must not mutate the vault, so
 * it reads the raw file itself and passes the parsed object (or null) here.
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {{marker?: object|null}} [opts]
 * @returns {{state: 'closed'|'legacy-closed'|'broken'|'open', reason: string|null,
 *   receipt: object|null, marker: object|null}}
 */
export function closeCheckpointState(hypoDir, sessionId, opts = {}) {
  const marker =
    'marker' in opts ? opts.marker || null : readSessionClosedMarker(hypoDir, sessionId);
  const read = receiptPath(hypoDir, sessionId)
    ? readReceiptStrict(hypoDir, sessionId)
    : { status: 'missing' };
  const receipt = read.status === 'valid' ? read.receipt : null;
  const markerGen = (marker && marker.receipt_generation) || null;
  const result = (state, reason = null) => ({ state, reason, receipt, marker });

  if (receipt) {
    if (!marker) {
      return result(
        'broken',
        'a valid close receipt has no session-closed marker (the close stopped before the marker landed, or only the marker was invalidated)',
      );
    }
    if (
      typeof receipt.generation !== 'string' ||
      !receipt.generation ||
      markerGen !== receipt.generation
    ) {
      return result(
        'broken',
        `the session-closed marker names receipt generation ${markerGen || '(none)'}, but the close receipt is generation ${receipt.generation || '(none)'}`,
      );
    }
    return result('closed');
  }
  if (read.status === 'invalid') {
    return result('broken', `the close receipt is invalid (${read.reason})`);
  }
  if (markerGen) {
    return result(
      'broken',
      `the session-closed marker names receipt generation ${markerGen}, but no close receipt exists`,
    );
  }
  if (marker) return result('legacy-closed');
  return result('open', 'no close receipt and no session-closed marker for this session');
}
