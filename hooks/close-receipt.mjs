// hooks/close-receipt.mjs, commit-based close receipt: read, write, verify.
//
// Design lives in the maintainer's private wiki (a close-marker redesign
// spec: a name/shape contract plus its follow-up rounds). Not reproduced
// here since this file ships publicly and the spec does not.
//
// What this replaces: a session-close marker used to certify "this session's
// work is saved" by comparing disk snapshots taken at different times, which
// a concurrent writer can always defeat (two sessions can rewrite the same
// bytes back to a snapshot-matching state with neither having saved anything
// the other didn't already have). This module certifies a narrower, provable
// claim instead: "the file versions named in this receipt are all present,
// byte-for-byte, in commit C, which is reachable from the current branch
// history". It says nothing about files it does not name, and nothing about
// whether the rest of the session's work was ever saved at all, callers
// (Stop, PreCompact, doctor) must keep surfacing unresolved changes
// separately, never read a valid receipt as "the vault is clean".
//
// Node built-ins only, per the hooks/ convention (this file is copied
// standalone into `~/.claude/hooks/` on install; `scripts/` may import it,
// never the reverse). Listed in `hooks/shared.json`.
//
// Session id validation reuses `isValidSessionId` (hooks/proposal-store.mjs)
// rather than re-deriving a shape check: a session id reaches this module the
// same way it reaches the proposal store, straight off `--session-id`, and it
// becomes a filename component here exactly as it does there. The receipt
// directory name (`.cache/sessions/<sessionId>/`) is deliberately the SAME
// convention `hooks/base-store.mjs`'s `basePath` uses (`String(sessionId)`,
// no separate sanitize step), for any id `isValidSessionId` accepts
// (`[A-Za-z0-9_-]+`, no dot), `sanitizeSessionId` (hypo-shared.mjs) is a
// no-op, so the two conventions already agree; this file just skips the
// redundant pass rather than importing a second sanitizer for the same
// no-op.

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicWrite } from './atomic-write.mjs';
import { sessionClosedMarkerPath } from './hypo-shared.mjs';
import { isValidSessionId } from './proposal-store.mjs';

export const RECEIPT_SCHEMA_VERSION = 1;
/** Certification value an apply-path (full close, expected-bytes verified) issues. */
export const CERT_CHECKPOINT = 'committed-close-checkpoint';
/** Certification value `--mark-session-closed` (no payload, weaker proof) issues. */
export const CERT_CLOSE_FILES = 'committed-close-files';

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
 * Look up one path's tree entry inside `commit`. `-r --full-tree` so a nested
 * path resolves in one call without walking subtrees by hand, and the exact
 * matching path is picked out of the (possibly multi-line, if pathspec were
 * ambiguous) output rather than trusting "first line".
 * @returns {{ok: true, present: false}|{ok: true, present: true, mode: string, oid: string}|{ok: false, reason: string}}
 */
function lsTreeEntry(hypoDir, commit, path) {
  const res = gitText(hypoDir, ['ls-tree', '-r', '--full-tree', commit, '--', path]);
  if (res.error) return { ok: false, reason: `git-error: ${res.error.message}` };
  if (res.status !== 0) {
    return { ok: false, reason: `ls-tree-failed: ${(res.stderr || '').trim() || 'unknown'}` };
  }
  const lines = (res.stdout || '').split('\n').filter(Boolean);
  if (lines.length === 0) return { ok: true, present: false };
  // `<mode> <type> <oid>\t<path>`, tab-separated path field, exact match only
  // (a pathspec that happened to match a sibling would otherwise silently pass).
  const line = lines.find((l) => l.slice(l.indexOf('\t') + 1) === path);
  if (!line) return { ok: false, reason: 'ls-tree-path-mismatch' };
  const head = line.slice(0, line.indexOf('\t'));
  const m = /^(\d+)\s+\S+\s+([0-9a-f]{40,64})$/.exec(head);
  if (!m) return { ok: false, reason: 'ls-tree-parse-failed' };
  return { ok: true, present: true, mode: m[1], oid: m[2] };
}

// Minimal, deliberately narrow mirror of `scripts/lib/schema-vocab.mjs`'s
// `**Pending**:` extraction. `scripts/` cannot be imported from `hooks/`
// (dependency direction is one-way the other way), so this is a small,
// separately-maintained duplicate scoped to exactly what a schema-pending
// entry needs: the backtick tokens on the FIRST `**Pending**:` data line
// found anywhere in the blob. It does not bound itself to the "## Tag
// Vocabulary" H2 section the way the real parser does, so it is strictly
// more permissive, acceptable here because it only ever WIDENS what counts
// as "already pending" for a verification check, never narrows a write.
const PENDING_DATA_RE = /^\*\*Pending[^*]*\*\*:.*$/im;
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

function parsePendingTags(content) {
  const tags = new Set();
  const m = PENDING_DATA_RE.exec(content || '');
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
  return join(hypoDir, '.cache', 'sessions', String(sessionId), 'close-receipt.json');
}

/**
 * Read and strictly validate a session's close receipt: parse, schema
 * version, certification value, session id match, repo identity, and commit
 * reachability from the CURRENT branch history. Any failure at any step is
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
  if (typeof receipt.commit !== 'string' || !/^[0-9a-f]{40}$/.test(receipt.commit)) {
    return { status: 'invalid', reason: 'malformed-commit' };
  }
  if (!Array.isArray(receipt.entries)) {
    return { status: 'invalid', reason: 'malformed-entries' };
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
 * commit helper's bare success as content proof (see design.md); this
 * function is what closes that gap by reading the committed tree itself.
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
      // is the documented limit of "append" as a proof kind (design.md v2 C).
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
 * request is accepted (design.md v5 §1): the compat MARKER first, the
 * RECEIPT second. If the process dies between the two renames, only the
 * receipt is left, never a marker with no backing receipt, which would let
 * an old-Stop reader treat a stale marker as fresh. `<name>.invalidated-<ts>`
 * (not `.marker` at the end) so doctor's marker-file scan and the
 * legacy-closed acceptance path (which only look at names ending `.marker`)
 * never pick an invalidated file back up.
 * @returns {{ok: boolean, reason?: string}}
 */
export function invalidateCloseArtifacts(hypoDir, sessionId) {
  const markerResult = invalidateOne(sessionClosedMarkerPath(hypoDir, sessionId));
  if (!markerResult.ok) return markerResult;
  const receipt = receiptPath(hypoDir, sessionId);
  if (!receipt) return { ok: true }; // invalid session id: nothing filed under it to invalidate
  return invalidateOne(receipt);
}
