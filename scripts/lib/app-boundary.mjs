/**
 * app-boundary.mjs: the body of `scripts/app-boundary.mjs`.
 *
 * An app that works beside the main session leaves one wiki entry per task boundary as a local
 * commit. It does not wait for a close signal and never runs git itself: the vault commit lock and
 * the commit scope stay here. This module touches no remote. A person's Stop pushes the commit.
 *
 * The app hands over five codes (`taskKind`, `decision`, `status`, `team`, `boundaryKind`) and a
 * boundary id. The wiki gets only sentences from a pinned code book, never the boundary id: that
 * is reduced to a close id by hashing. A marker under `.cache/app-boundaries/` records the bytes
 * of the entry before it is written, so a call that dies at any step finishes the same entry next
 * time instead of writing a second one.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from '../../hooks/atomic-write.mjs';
import {
  commitWikiChanges,
  vaultCommitLockTarget,
  vaultOperationInProgress,
  withFileLock,
} from '../../hooks/hypo-shared.mjs';
import { entryFileName, formatSessionEntry } from '../../hooks/session-entries.mjs';

export const CAPABILITIES = ['app-boundary/1'];

// Fixed on every commit this entry point makes, through the git child environment only.
export const COMMIT_IDENTITY = {
  name: '임상규',
  email: '139614336+sk-lim19f@users.noreply.github.com',
};

// stdin field -> the code book table that holds its codes.
const PAYLOAD_TABLES = {
  taskKind: 'taskKind',
  decision: 'decision',
  status: 'status',
  team: 'teams',
  boundaryKind: 'boundaryKind',
};
const PAYLOAD_FIELDS = Object.keys(PAYLOAD_TABLES);
const CODEBOOK_TABLES = ['projects', 'teams', 'taskKind', 'decision', 'status', 'boundaryKind'];
const CODE_RE = /^[a-z]+(?:-[a-z]+)*$/;
// The same rule the app applies to its own code book (`isPublishableText` in its contract.ts), so
// a code book that file and this one both accept carries nothing that could name an account, a
// range or a host. A digit of any script, `.`, `:`, `/`, `@`, `_` and the default-ignorable code
// points (invisible characters) are refused, in the text as written and after NFKC, which folds
// full-width digits and signs back to ASCII. Control characters are refused too: they would break
// the entry's line layout. A template holds at most 200 characters and a code 32.
const FORBIDDEN_TEMPLATE_RE = /[\p{N}.:/@_\p{Default_Ignorable_Code_Point}\p{Cc}]/u;
const MAX_TEMPLATE_LENGTH = 200;
const MAX_CODE_LENGTH = 32;
const publishable = (text) => {
  const folded = text.normalize('NFKC');
  return (
    folded.trim() !== '' &&
    text.length <= MAX_TEMPLATE_LENGTH &&
    folded.length <= MAX_TEMPLATE_LENGTH &&
    !FORBIDDEN_TEMPLATE_RE.test(text) &&
    !FORBIDDEN_TEMPLATE_RE.test(folded)
  );
};
const MARKER_DIR = '.cache/app-boundaries';

class BoundaryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
// Run `fn` with these environment variables set, then put every one back as it was.
function withEnv(patch, fn) {
  const saved = Object.entries(patch).map(([k]) => [k, process.env[k]]);
  Object.assign(process.env, patch);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// `commitWikiChanges` starts its git children with this process's environment. With rename
// detection on, a staged deletion of a file whose bytes equal the entry reads as the entry's
// rename source, and the helper then commits that deletion too. Two config entries turn detection
// off for the commit call only, added after any GIT_CONFIG_COUNT entries the caller already set.
function noRenameDetection() {
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: 'status.renames',
    [`GIT_CONFIG_VALUE_${n}`]: 'false',
    [`GIT_CONFIG_KEY_${n + 1}`]: 'diff.renames',
    [`GIT_CONFIG_VALUE_${n + 1}`]: 'false',
  };
}

const refuse = (code) => {
  throw new BoundaryError(code);
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function git(hypoDir, args, opts = {}) {
  return spawnSync('git', ['-C', hypoDir, ...args], { timeout: 30000, ...opts });
}

/** `ade-` plus the first 24 hex digits of the boundary id's sha256. */
export function closeIdFor(boundaryId) {
  return `ade-${sha256(boundaryId).slice(0, 24)}`;
}

// The sha256 of the payload with sorted keys and no whitespace: two calls agree on it only when
// every code (and the project) agrees.
function payloadHash(project, payload) {
  const all = { project, ...payload };
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(all).sort())));
}

function checkPayload(payload) {
  const keys =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : null;
  if (
    !keys ||
    keys.length !== PAYLOAD_FIELDS.length ||
    !PAYLOAD_FIELDS.every((k) => typeof payload[k] === 'string')
  ) {
    refuse('invalid_payload');
  }
}

function parseCodebook(bytes) {
  let book;
  try {
    book = JSON.parse(bytes.toString('utf-8'));
  } catch {
    refuse('codebook_invalid');
  }
  if (!book || typeof book !== 'object' || Array.isArray(book)) refuse('codebook_invalid');
  for (const table of CODEBOOK_TABLES) {
    const codes = book[table];
    if (!codes || typeof codes !== 'object' || Array.isArray(codes)) refuse('codebook_invalid');
    for (const [code, template] of Object.entries(codes)) {
      if (!CODE_RE.test(code) || code.length > MAX_CODE_LENGTH) refuse('codebook_invalid');
      if (typeof template !== 'string' || !publishable(template)) refuse('codebook_invalid');
    }
  }
  return book;
}

const markerPath = (hypoDir, closeId) => join(hypoDir, MARKER_DIR, `${closeId}.json`);

function readMarker(path) {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8'));
    if (m && (m.state === 'writing' || m.state === 'committed') && typeof m.entryPath === 'string')
      return m;
  } catch {
    /* falls through to the refusal */
  }
  return refuse('marker_invalid');
}

const writeMarker = (path, marker) => atomicWrite(path, `${JSON.stringify(marker)}\n`);

// sha256 of the entry file as HEAD holds it, `null` when HEAD has no such blob. A lookup that
// fails is not "absent": the answer is unknown, and an unknown answer never leads to a rewrite.
function headEntryHash(hypoDir, entryPath) {
  const head = git(hypoDir, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (head.status === 1) return null; // no commit yet
  if (head.status !== 0) refuse('entry_not_committed');
  const tree = git(hypoDir, ['ls-tree', '-z', 'HEAD', '--', entryPath], { encoding: 'utf-8' });
  if (tree.status !== 0) refuse('entry_not_committed');
  if (tree.stdout === '') return null;
  const blob = git(hypoDir, ['cat-file', 'blob', `HEAD:./${entryPath}`]);
  if (blob.status !== 0) refuse('entry_not_committed');
  return sha256(blob.stdout);
}

// Was this path ever committed, on any branch or in any reflog entry? A commit a person reset away
// is no longer in HEAD's history but stays in the reflog. A failed lookup counts as "yes".
function everCommitted(hypoDir, entryPath) {
  const r = git(hypoDir, ['log', '--all', '--reflog', '--format=%H', '--', entryPath], {
    encoding: 'utf-8',
  });
  return r.status !== 0 || r.stdout.trim() !== '';
}

const lastCommitOf = (hypoDir, entryPath) => {
  const r = git(hypoDir, ['log', '-1', '--format=%H', '--', entryPath], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

const headSha = (hypoDir) => {
  const r = git(hypoDir, ['rev-parse', 'HEAD'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

// The marker says `committed` only after the commit was seen in HEAD, but a person may have moved
// HEAD since. A marker update that fails after a verified commit does not undo the commit: the
// marker stays `writing` and the next call finishes it from HEAD.
function markCommitted(path, marker, sha) {
  const done = { ...marker, state: 'committed', committedSha: sha };
  try {
    writeMarker(path, done);
  } catch {
    /* the commit is real; the marker is brought up to date by the next call */
  }
  return done;
}

const reusedResult = (marker) => ({
  closeId: marker.closeId,
  entryPath: marker.entryPath,
  committedSha: marker.committedSha,
  reused: true,
  state: 'committed',
});

function writeLocked({ hypoDir, project, boundaryId, payload, codebookPath, codebookSha256 }) {
  if (vaultOperationInProgress(hypoDir)) refuse('vault_operation_in_progress');
  // The marker directory must never reach a commit or a push.
  const ignored = git(hypoDir, ['check-ignore', '-q', `${MARKER_DIR}/`]);
  if (ignored.status !== 0) refuse('marker_tracked');

  const closeId = closeIdFor(boundaryId);
  const path = markerPath(hypoDir, closeId);
  const payloadSha256 = payloadHash(project, payload);
  const marker = readMarker(path);
  // An entry that already landed answers before the code book is looked at: a code book that
  // changed since cannot turn a boundary that was committed into a refusal.
  if (marker) {
    if (marker.payloadSha256 !== payloadSha256) refuse('boundary_payload_mismatch');
    const inHead = headEntryHash(hypoDir, marker.entryPath);
    if (marker.state === 'committed') {
      // HEAD was moved back past the commit, or the entry was rewritten: not a boundary to report.
      if (inHead !== marker.renderedSha256) refuse('entry_not_committed');
      return reusedResult(marker);
    }
    if (inHead === marker.renderedSha256) {
      return reusedResult(markCommitted(path, marker, lastCommitOf(hypoDir, marker.entryPath)));
    }
    // The entry was committed once and is gone from HEAD: a person took it back (a reset). The
    // stored bytes are not written again.
    if (inHead === null && everCommitted(hypoDir, marker.entryPath)) refuse('entry_not_committed');
    // A different entry at this path (in HEAD, or edited in the work tree) is a person's: the
    // stored bytes are never written over it.
    const file = join(hypoDir, marker.entryPath);
    if (
      inHead !== null ||
      (existsSync(file) && sha256(readFileSync(file)) !== marker.renderedSha256)
    ) {
      refuse('entry_conflict');
    }
  }

  let bytes;
  try {
    bytes = readFileSync(codebookPath);
  } catch {
    return refuse('codebook_mismatch');
  }
  if (sha256(bytes) !== String(codebookSha256).toLowerCase()) refuse('codebook_mismatch');
  const book = parseCodebook(bytes);
  if (!Object.hasOwn(book.projects, project)) refuse('code_not_in_codebook');
  for (const field of PAYLOAD_FIELDS) {
    if (!Object.hasOwn(book[PAYLOAD_TABLES[field]], payload[field])) refuse('code_not_in_codebook');
  }

  let own = marker;
  if (!own) {
    const closedAt = new Date().toISOString();
    const summary = ['boundaryKind', 'taskKind', 'decision', 'status']
      .map((f) => book[PAYLOAD_TABLES[f]][payload[f]])
      .join('\n');
    const entryPath = `projects/${project}/sessions/${entryFileName(closedAt.slice(0, 10), closeId)}`;
    const rendered = formatSessionEntry({
      project,
      closeId,
      date: closedAt.slice(0, 10),
      closedAt,
      tracks: [{ id: payload.team }],
      summary,
    });
    own = {
      state: 'writing',
      closeId,
      entryPath,
      rendered,
      renderedSha256: sha256(rendered),
      closedAt,
      payloadSha256,
      codebookSha256: sha256(bytes),
    };
    writeMarker(path, own);
  }

  atomicWrite(join(hypoDir, own.entryPath), own.rendered);
  const outcome = withEnv(noRenameDetection(), () => commitWikiChanges(hypoDir, [own.entryPath]));
  if (!outcome.committed) refuse('entry_not_committed');
  const candidate = outcome.sha || headSha(hypoDir);
  if (
    !candidate ||
    headEntryHash(hypoDir, own.entryPath) !== own.renderedSha256 ||
    lastCommitOf(hypoDir, own.entryPath) !== candidate
  ) {
    refuse('entry_not_committed');
  }
  markCommitted(path, own, candidate);
  return {
    closeId,
    entryPath: own.entryPath,
    committedSha: candidate,
    reused: false,
    state: 'committed',
  };
}

/**
 * Write the entry for one boundary. `payload` is the five codes. Returns
 * `{closeId, entryPath, committedSha, reused, state}` or `{error}`; neither holds the boundary id.
 * `lockTimeoutMs` bounds the wait for the vault commit lock.
 */
export function writeBoundary({ lockTimeoutMs, ...args }) {
  try {
    const { hypoDir, project, boundaryId, payload, codebookPath, codebookSha256 } = args;
    if (
      ![hypoDir, project, boundaryId, codebookPath, codebookSha256].every(
        (v) => typeof v === 'string' && v,
      )
    ) {
      refuse('invalid_args');
    }
    checkPayload(payload);
    // Nothing may create `.cache/` inside a directory that is not a vault.
    const inside =
      existsSync(hypoDir) && git(hypoDir, ['rev-parse', '--is-inside-work-tree']).status === 0;
    if (!inside) refuse('vault_not_git_repo');

    const saved = {};
    const identity = {
      GIT_AUTHOR_NAME: COMMIT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: COMMIT_IDENTITY.email,
      GIT_COMMITTER_NAME: COMMIT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: COMMIT_IDENTITY.email,
    };
    // The lock helper prints the lock path when it takes over an old lock, and the path may name
    // what the code book keeps out of the vault. Its diagnostics become one fixed line.
    const realError = console.error;
    console.error = () => realError('[app-boundary] vault commit lock: diagnostic omitted');
    try {
      return withFileLock(
        vaultCommitLockTarget(hypoDir),
        () => {
          // Held only while the lock is, then put back (the tests call this in-process).
          for (const [k, v] of Object.entries(identity)) {
            saved[k] = process.env[k];
            process.env[k] = v;
          }
          return writeLocked(args);
        },
        lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs },
      );
    } finally {
      console.error = realError;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  } catch (err) {
    if (err instanceof BoundaryError) return { error: err.code };
    if (err?.code === 'ELOCKTIMEOUT') return { error: 'vault_lock_timeout' };
    throw err;
  }
}
