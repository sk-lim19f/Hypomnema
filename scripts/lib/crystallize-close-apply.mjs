import {
  existsSync,
  statSync,
  readFileSync,
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  readdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { randomBytes, createHash } from 'crypto';
import { expandHome } from './hypo-root.mjs';
import { parseStrictDate } from './time.mjs';
import { isValidProjectName, substituteTokens, TEMPLATE_DIR } from './project-create.mjs';
import { appendPendingTags, checkForbidden } from './schema-vocab.mjs';
import { atomicWrite } from '../../hooks/atomic-write.mjs';
import {
  sessionCloseFileStatus,
  sessionCloseGlobalStatus,
  precompactGateStatus,
  writeSessionClosedMarker,
  sessionClosedMarkerPath,
  partitionLintScope,
  isUnderProjectDirs,
  sessionLogReadCandidates,
  sessionLogScopePath,
  rootLogEntry,
  hasSessionLogHeading,
  hasLogEntry,
  resolveTranscriptBySessionId,
  isCloseGateOpen,
  commitWikiChanges,
  vaultCommitLockTarget,
  currentDevice,
  withFileLock,
  resolveGateProjectOverride,
} from '../../hooks/hypo-shared.mjs';
import {
  CERT_CHECKPOINT,
  CERT_CLOSE_FILES,
  RECEIPT_SCHEMA_VERSION,
  invalidateCloseArtifacts,
  receiptPath,
  verifyEntriesInCommit,
  writeReceiptAtomic,
} from '../../hooks/close-receipt.mjs';
import {
  hashContent,
  readBaseEntry,
  readObservedHash,
  wasObservedTruncated,
  readAppliedHash,
  advanceBaseAndRecordApplied,
} from '../../hooks/base-store.mjs';
import {
  writeProposal,
  listProposalsChecked,
  isValidSessionId,
} from '../../hooks/proposal-store.mjs';
import {
  recordGateClosed,
  resolutionStamp,
  closeGateStatus,
  hostTagWarningWithUndo,
} from '../../hooks/close-gate-store.mjs';
import { readJournal, recordJournalEntry, clearJournal } from '../../hooks/close-journal.mjs';
import { requireProjectDir } from './crystallize-close-gate.mjs';
import { summarizeLintForOutput } from './crystallize-helpers.mjs';

// Raw-byte sha256 of a string written to disk, hashed exactly the way
// close-receipt.mjs's verifyEntriesInCommit hashes the committed blob (a
// Buffer, never a decoded JS string): see that module's own comment on why
// an overwrite/create proof entry is never trusted on a UTF-8 round trip.
function bytesSha256(content) {
  return createHash('sha256').update(Buffer.from(content, 'utf-8')).digest('hex');
}

// The commit this apply's marker phase just made (or confirmed already
// clean), read under the SAME vault-commit lock the commit itself ran
// inside, never a second, unlocked `git rev-parse HEAD` afterwards, which a
// concurrent close landing in the gap could move out from under this read
// (the commit a receipt certifies is `commitOutcome.sha`, or, when the commit
// was a `scoped: 0` no-op, this locked HEAD read).
function readHeadShaLocked(hypoDir) {
  const res = spawnSync('git', ['-C', hypoDir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').trim() || null;
}

// LINT_SCRIPT is resolved relative to this lib file rather than via
// crystallize.mjs's own import.meta.url, so it keeps pointing at the sibling
// scripts/lint.mjs — same absolute path either way.
const LINT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lint.mjs');

// Spawn lint.mjs --json against `hypoDir` and return parsed result.
// We shell out instead of refactoring lint.mjs into a library because lint.mjs
// keeps issues in module scope (scripts/lint.mjs:139,250) — a programmatic
// extraction is its own chore. spawnSync is the minimum-invasive path for #40.
// Throws only on JSON parse failure (lint crashed mid-run); a lint that exits 1
// with valid JSON is a normal "errors present" signal, not a crash.
// maxBuffer raised to 64 MiB: warn-only output on a large wiki can otherwise
// trip Node's 1 MiB default, truncate stdout, and turn a clean wiki into a
// JSON.parse crash (codex P3 follow-up).
function runLint(hypoDir) {
  const r = spawnSync(process.execPath, [LINT_SCRIPT, `--hypo-dir=${hypoDir}`, '--json'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    // Report diagnostic metadata (sizes, exit/signal, spawn error code, a stderr
    // tail) instead of dumping the whole — possibly huge, possibly truncated —
    // stdout. lint.mjs now sets exitCode and exits naturally so its stdout is no
    // longer cut at the 64 KiB pipe boundary; if this still fires it signals a
    // genuine crash, and these fields say which kind.
    const stderrTail = (r.stderr || '').slice(-2000);
    throw new Error(
      `lint helper produced unparseable output ` +
        `(exit=${r.status}, signal=${r.signal || 'none'}, ` +
        `stdoutBytes=${(r.stdout || '').length}, spawnError=${r.error?.code || 'none'})` +
        (stderrTail ? `\nstderr tail:\n${stderrTail}` : ''),
    );
  }
}

// ── session-close apply ────────────────────────────────────────────
// Idempotent payload-driven application of the 4 mandatory session-close memory
// files (+ optional open-questions). Used by the LLM session-close flow as the
// canonical entrypoint instead of issuing 5+ Write tool calls by hand.
//
// The root pointer table (`hot.md`) used to be a fifth file here, composed by
// hand into every payload. It is now a projection the SessionStart and Stop
// hooks regenerate from `projects/*/hot.md`, so a close that wrote it would
// only be overwritten by its own turn's Stop hook. It left the payload, the
// overwrite set, and the base snapshot together; a payload that still carries
// `rootHot` is reported, not applied (see `obsoleteFieldNotices`).
//
// Idempotency:
//   • full-content fields (sessionState/projectHot/openQuestions): write
//     only when on-disk bytes differ — re-running with same payload is a no-op.
//   • append fields (sessionLog/log): skip when the dated heading/entry is
//     already present (regex shared with sessionCloseFileStatus via hypo-shared).
//
// Validation: never auto-fixes the payload. The final sessionCloseFileStatus
// check fails fast on stale `updated:` or missing entries so the caller fixes
// the payload and retries — silent rewrites would hide payload bugs (advisor #3).

function readPayload(source) {
  if (!source)
    throw new Error('--payload is required with --apply-session-close (path or `-` for stdin)');
  let raw;
  if (source === '-') {
    // Synchronous stdin read; payloads are tiny (a few hundred KB at most).
    raw = readFileSync(0, 'utf-8');
  } else {
    const path = expandHome(source);
    if (!existsSync(path)) throw new Error(`payload file not found: ${path}`);
    raw = readFileSync(path, 'utf-8');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`payload is not valid JSON: ${e.message}`);
  }
}

// How long an append waits for its per-target lock before withholding to the
// proposal-pending gate (see withFileLock). A withheld append blocks the close but
// is NOT parked as a proposal artifact — the next close re-appends. Default 5s is
// generous for a real close;
// the env override exists ONLY so tests can force a fast timeout instead of
// spinning the full 5s. Not a documented production knob.
const APPEND_LOCK_TIMEOUT_MS = Number(process.env.HYPO_APPEND_LOCK_TIMEOUT_MS) || 5000;

// atomicWrite is now the shared hooks/atomic-write.mjs implementation
// (imported above). Six byte-identical copies of this function used to live
// in hooks/ and scripts/lib/, and a fix landed in only two of them (#296).
// this file was one of the four that kept the bug (a rename failure leaked
// its tmp file forever, because the cleanup called `rmSync` without ever
// importing it). See hooks/atomic-write.mjs's own doc comment.

/**
 * Read a target's current bytes, distinguishing "absent" from "unreadable" the
 * same way base-store's hashFile does. The overwrite guard needs all three
 * answers: content to compare, `null` to know creating is safe, `undefined` to
 * refuse to guess.
 * @returns {string|null|undefined} bytes, `null` if absent, `undefined` if unreadable
 */
function readTarget(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Has the target drifted away from what this session observed at start?
 *
 * Branches on base-store's `state` discriminator, never on the truthiness of
 * `hash`: 'absent' and 'unknown' both carry `hash: null`, and collapsing them
 * would read never-observed as safe-to-write, defeating the guard entirely.
 *
 * `observed` is this session's observed set for THIS target: the
 * hash(es) a later SessionStart actually showed it, on top of the original
 * base. It only ever widens what may be written, never narrows or replaces
 * `entry` — a disk hash matching `entry.hash` still passes with `observed`
 * empty, exactly as before this parameter existed. `case 'unknown'` does not
 * consult it: with no snapshot at all there is no base for an observation to
 * extend.
 *
 * @param {{state: 'hash'|'absent'|'unknown', hash: string|null}} entry
 * @param {string|null|undefined} disk current bytes / absent / unreadable
 * @param {{hash: string|null, truncated: boolean}} observed what this session
 *   was shown for THIS target after its first snapshot: the exact hash (or
 *   `null` when it was never shown anything current), plus whether the one
 *   shown-but-not-licensing case (a truncated injection) applies — used only
 *   to pick which park reason to report, never to license a write on its own.
 * @param {string|null} appliedHash what THIS overwrite call itself last wrote
 *   for this target, this session (base-store's `readAppliedHash`): narrower
 *   than `entry.hash`, which also moves on a same-session hand edit
 *   (`advanceBaseForWrite`) and so cannot by itself tell "nothing moved since
 *   my own last apply" from "my own hand edit moved it and I re-observed my
 *   own bytes as the new base".
 * @param {string|null} payloadHash hash of the content THIS call is about to
 *   write. Unused by the guard below (kept as a parameter for callers and
 *   tests that already pass it, and because a future narrower predicate may
 *   need it again): see the guard's own comment for why r5-w3 blocker 2
 *   stopped comparing it to `appliedHash`.
 * @returns {string|null} a conflict reason, or null when this session may write
 */
export function overwriteConflictReason(
  entry,
  disk,
  observed = { hash: null, truncated: false },
  appliedHash = null,
  payloadHash = null,
) {
  // Cannot read what we are about to replace: fail safe, never assume unchanged.
  if (disk === undefined) return 'target-unreadable';
  const observedHash = observed && observed.hash;
  const observedTruncated = !!(observed && observed.truncated);
  let reason;
  switch (entry.state) {
    case 'unknown':
      // No snapshot for this (session, target): someone else's edits could be
      // sitting on disk with no way to tell, so this always parks. An earlier
      // cut of this guard let a session's own touched-paths record
      // (hooks/hypo-auto-stage.mjs) waive that park. It was removed
      // 2026-09-11: hypo-auto-commit clears touched-paths.json at every Stop
      // once a commit lands (even a no-op commit), so by the time a close
      // reads it here it is empty in every real session that has crossed a
      // Stop since its last Write/Edit — the escape never actually fired.
      reason = 'base-unknown';
      break;
    case 'absent':
      // We observed no file. Creating it is safe; finding one now means another
      // writer got there first, UNLESS this session was later shown exactly
      // those bytes by a resume/compact SessionStart.
      if (disk === null) {
        reason = null;
      } else if (observedHash && observedHash === hashContent(disk)) {
        reason = null;
      } else {
        reason = observedTruncated
          ? 'base-mismatch-truncated-observation'
          : 'base-absent-target-exists';
      }
      break;
    case 'hash':
      if (disk === null) {
        reason = 'base-hash-target-missing';
      } else if (hashContent(disk) === entry.hash) {
        reason = null;
      } else if (observedHash && observedHash === hashContent(disk)) {
        // Drifted from the original base: still allowed when this session was
        // shown these exact drifted bytes by a later SessionStart. A truncated
        // injection never reaches `observedHash` (readObservedHash refuses it),
        // so it falls through here and gets its own reason instead of the plain
        // `base-mismatch` a no-observation-at-all case reports.
        reason = null;
      } else {
        reason = observedTruncated ? 'base-mismatch-truncated-observation' : 'base-mismatch';
      }
      break;
    default:
      reason = 'base-unknown';
  }
  // `entry`/`disk` alone read this as clean whenever a same-session hand edit
  // is what last advanced the base: that write IS this session's own, so it
  // rightly does not park on its own account. But if THIS overwrite call
  // previously applied different bytes and disk has since moved away from
  // them (a hand edit landed AFTER that apply, with no new apply since), the
  // caller is about to write OVER that edit with no proposal, no notice,
  // nothing, whether or not the payload happens to be the exact old bytes.
  //
  // review r4-w4 major 1 narrowed this to `payloadHash === appliedHash` (only
  // the exact stale reapply parks), so that a payload which folds the hand
  // edit back in and adds a legitimate close on top would not also park.
  // review r5-w3 blocker 2 found the hole that narrowing opened: this
  // function cannot tell "folded the edit in" from "unrelated new bytes that
  // still ignore the edit" from the hashes alone, so ANY payload change at
  // all (including one that drops the edit entirely) passed the narrowed
  // check just by being different from the old applied bytes. Comparing
  // `payloadHash` here can only ever answer "is this the exact same payload
  // as before", never "does this payload account for the edit", so it is
  // dropped rather than replaced: there is no hash-only predicate between
  // those two questions for a whole-file markdown overwrite (the same
  // block-context problem the section-loss guard's own comment names above).
  // Reverting to "any drift from appliedHash parks" is a straight tradeoff,
  // not a fix without a cost: a close that DOES fold the edit in now also
  // parks, and needs the same human approval
  // (`hypomnema proposal challenge`/`proposal resolve`) as one that does not.
  // That friction is accepted because the alternative (a hand edit silently
  // discarded with no record it ever existed) is the worse failure for a
  // guard whose whole purpose is not losing someone's edit.
  if (
    reason === null &&
    typeof disk === 'string' &&
    appliedHash &&
    hashContent(disk) !== appliedHash
  ) {
    return 'will-overwrite-local-change';
  }
  return reason;
}

/**
 * Append `entry` to `path` only if `alreadyPresent(content)` is false.
 * Atomic: rebuilds the full file content and writes via atomicWrite — a crash
 * mid-append cannot leave log.md or session-log/YYYY-MM-DD.md half-written, which
 * matters for these append-only history files.
 */
function appendIfAbsent(path, entry, alreadyPresent) {
  let content = '';
  if (existsSync(path)) {
    try {
      content = readFileSync(path, 'utf-8');
    } catch (err) {
      // ENOENT here is a narrow existsSync-then-readFileSync race (the file
      // vanished between the two calls) — content='' is safe, we would create
      // it fresh anyway. Anything else (EACCES/EISDIR/...) is a PERSISTENT
      // read failure: retrying (the caller's lock-timeout conflict path) would
      // never fix it, and swallowing it here would fall through to the
      // atomicWrite below and silently replace the existing file's bytes with
      // just this one entry — a data-loss overwrite. So rethrow and let the
      // withFileLock/call-site catch hard-fail the close instead.
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  if (alreadyPresent(content)) return false;
  // Ensure single blank line between existing tail and new entry, no trailing dup.
  const sep =
    content === '' ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  const next = entry.endsWith('\n') ? entry : entry + '\n';
  atomicWrite(path, content + sep + next);
  return true;
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Spec §5.2.7 / §8.3: 3 mandatory + 2 optional (`log`, `openQuestions`).
// The payload shape MUST mirror that contract — missing a mandatory field is a
// payload bug, not a no-op. Caller is the LLM session-close flow, which composes
// the payload deliberately; partial payloads must fail loudly so caller fixes
// them rather than silently relying on yesterday's freshness state. (Codex review
// of the apply path — Worker 1 finding 1.) `log` left the mandatory set in B-1:
// the root log.md entry is a DERIVABLE artifact (rootLogEntry over this close's
// sessionLog heading), so apply auto-fills it when the field is absent.
const REQUIRED_PAYLOAD_FIELDS = [
  ['sessionState', 'content'],
  ['projectHot', 'content'],
  ['sessionLog', 'entry'],
];

function validatePayloadShape(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') {
    errs.push('payload must be a JSON object');
    return errs;
  }
  for (const [field, key] of REQUIRED_PAYLOAD_FIELDS) {
    const slot = payload[field];
    if (!slot || typeof slot !== 'object') {
      errs.push(`payload.${field} is required (object with .${key})`);
      continue;
    }
    if (typeof slot[key] !== 'string') {
      errs.push(`payload.${field}.${key} must be a string`);
    }
  }
  if (payload.openQuestions !== undefined) {
    if (
      !payload.openQuestions ||
      typeof payload.openQuestions !== 'object' ||
      typeof payload.openQuestions.content !== 'string'
    ) {
      errs.push('payload.openQuestions, when present, must be { content: string }');
    }
  }
  if (payload.log !== undefined) {
    if (!payload.log || typeof payload.log !== 'object' || typeof payload.log.entry !== 'string') {
      errs.push('payload.log, when present, must be { entry: string }');
    }
  }
  // A format-only check reads `2026-09-31` as a valid YYYY-MM-DD literal, but
  // there is no such day: `new Date('2026-09-31')` silently normalizes to
  // October 1 instead of failing, so the old regex-only check would have
  // let a calendar-overflow payload.date through to stamp a session-log
  // heading and shard filename with a date that does not exist.
  // parseStrictDate (lib/time.mjs) rejects that case too.
  if (payload.date !== undefined && parseStrictDate(payload.date) == null) {
    errs.push('payload.date, when present, must be a real calendar date in YYYY-MM-DD form');
  }
  if (
    payload.sessionId !== undefined &&
    payload.sessionId !== null &&
    typeof payload.sessionId !== 'string'
  ) {
    errs.push('payload.sessionId, when present, must be a string');
  }
  return errs;
}

// Payload fields this apply no longer applies. `rootHot` is the only one so far:
// the root pointer table became a hook-generated projection of `projects/*/hot.md`,
// so nothing composed by hand for it can survive the same turn's Stop hook.
//
// An installed copy that still carries the OLD `commands/crystallize.md` keeps
// sending the field, and that payload must neither fail (the close is otherwise
// correct, and refusing it would strand every not-yet-upgraded install) nor pass
// in silence (the author believed a file got written). One reported line is the
// middle: the close proceeds, and the reason the bytes are not on disk is in the
// result where the author looks for it.
//
// @returns {string[]} one line per obsolete field present, empty when there is none
function obsoleteFieldNotices(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const out = [];
  if (payload.rootHot !== undefined) {
    out.push(
      'payload.rootHot was ignored: the root hot.md pointer table is regenerated by the ' +
        'SessionStart and Stop hooks from projects/*/hot.md, so close no longer writes it. ' +
        'Drop the field from your payload.',
    );
  }
  return out;
}

// `--mark-session-closed` has no payload, so it has no operation-supplied
// expected bytes to prove against, only "a fresh version is committed"
// (CERT_CLOSE_FILES, weaker than the apply path's CERT_CHECKPOINT). This confirms exactly that for one path: worktree,
// index, and HEAD all agree (`git status --porcelain` empty means tracked,
// nothing staged, nothing unstaged, nothing untracked at this path), then
// hashes the disk bytes for the proof entry. `null` on anything else (dirty,
// untracked, unreadable, or not a git repo at all): the caller's contract is
// to treat that as "this target is not provably closed", never as "clean".
function markCloseWorktreeProofEntry(hypoDir, relPath) {
  const st = spawnSync('git', ['-C', hypoDir, 'status', '--porcelain', '--', relPath], {
    encoding: 'utf-8',
  });
  if (st.error || st.status !== 0 || (st.stdout || '').trim() !== '') return null;
  let content;
  try {
    content = readFileSync(join(hypoDir, relPath));
  } catch {
    return null;
  }
  return { path: relPath, kind: 'overwrite', expected: { bytesSha256: bytesSha256(content) } };
}

/**
 * The certification proof for `--mark-session-closed`. `--log-only` needs
 * only `log.md` committed fresh; a project mark needs, for EVERY project in
 * `markerProjects`, session-state.md, hot.md, the exact session-log evidence
 * file `sessionCloseFileStatus` accepted for freshness (never a different
 * hybrid-cutover candidate), and log.md, all committed, not merely present.
 * A project whose status is not ok, or that has no session-log evidence file
 * to name, is incomplete: dropping the session-log target from the proof
 * would certify a close whose session-log was never checked. One incomplete
 * project withholds the WHOLE certification and names which project failed;
 * this never partially certifies.
 * @returns {{ok: boolean, entries: object[], incompleteProjects: string[]}}
 */
export function buildMarkCloseProof(hypoDir, markerProjects, logOnly) {
  if (logOnly) {
    const e = markCloseWorktreeProofEntry(hypoDir, 'log.md');
    return e
      ? { ok: true, entries: [e], incompleteProjects: [] }
      : { ok: false, entries: [], incompleteProjects: ['(log-only)'] };
  }
  const byPath = new Map();
  const incompleteProjects = [];
  for (const p of markerProjects) {
    const status = sessionCloseFileStatus(hypoDir, { projectOverride: p });
    if (!status.ok || !status.sessionLogEvidence?.path) {
      incompleteProjects.push(p);
      continue;
    }
    const targets = [
      join('projects', p, 'session-state.md'),
      join('projects', p, 'hot.md'),
      status.sessionLogEvidence.path,
      'log.md',
    ];
    const projectEntries = [];
    let projectOk = true;
    for (const t of targets) {
      const e = markCloseWorktreeProofEntry(hypoDir, t);
      if (!e) {
        projectOk = false;
        break;
      }
      projectEntries.push(e);
    }
    if (!projectOk) {
      incompleteProjects.push(p);
      continue;
    }
    for (const e of projectEntries) byPath.set(e.path, e);
  }
  return {
    ok: incompleteProjects.length === 0 && markerProjects.length > 0,
    entries: [...byPath.values()],
    incompleteProjects,
  };
}

/**
 * Take back the receipt at this session's path, but only if it is the one this
 * close filed. A different `generation` on disk belongs to another close of the
 * same session that landed in the meantime, and removing it would undo a close
 * that did succeed. An absent file is left alone (nothing of ours to take back).
 * A file that cannot be read or parsed is treated as ours: the rename that put
 * it there is what made it unreadable to the re-read, and no other close writes
 * a partial receipt (all writers are temp+rename).
 * @returns {{ok: true, withdrawn: boolean} | {ok: false, reason: string}}
 */
export function withdrawOwnReceipt(hypoDir, sessionId, generation) {
  const path = receiptPath(hypoDir, sessionId);
  if (!path || !existsSync(path)) return { ok: true, withdrawn: false };
  try {
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof onDisk?.generation === 'string' && onDisk.generation !== generation) {
      return { ok: true, withdrawn: false };
    }
  } catch {
    // Unreadable or unparseable: fall through and withdraw.
  }
  const retracted = invalidateCloseArtifacts(hypoDir, sessionId);
  return retracted.ok ? { ok: true, withdrawn: true } : { ok: false, reason: retracted.reason };
}

/**
 * File the close checkpoint receipt, then the compat marker that projects it,
 * and take the receipt back if the marker does not land. The two writers
 * (`--apply-session-close` and `--mark-session-closed`) share this so they
 * cannot disagree about what a half-landed close looks like.
 *
 * Why the take-back: a receipt that stays valid while the run reports the
 * marker as not landed (exit 1, close signal unspent) splits the readers. A
 * receipt-first Stop reads the session as closed, a marker-only reader reads
 * it as open, and the operator who was told "not closed" is contradicted by
 * the newer reader. Withdrawing the receipt makes "marker did not land" mean
 * the same thing to every reader.
 *
 * `writeMarker` is injected so a test can make it fail deterministically. It
 * returns truthy when it wrote; a throw counts as not written. Landing also
 * requires the marker file to exist on disk: the writer says it wrote, the
 * disk says it is there, and a leftover file from an earlier attempt satisfies
 * neither on its own.
 *
 * A receipt write that reports failure after its rename (the re-read failed or
 * did not match) may still have left this close's receipt on disk, and a
 * transient re-read error would let it stand as valid with no marker. That
 * branch takes the receipt back too, through `withdrawOwnReceipt`.
 *
 * @returns {{ok: true} |
 *   {ok: false, reason: 'receipt-write-failed', writeReason: string, retractFailed?: string} |
 *   {ok: false, reason: 'marker-did-not-land', retractFailed?: string}}
 *   `retractFailed` is set only when withdrawing the receipt failed too, which
 *   leaves a valid receipt behind a run that reports failure.
 */
export function landReceiptThenMarker(hypoDir, sessionId, receipt, writeMarker) {
  const written = writeReceiptAtomic(hypoDir, sessionId, receipt);
  if (!written.ok) {
    // Only the re-read reasons mean the rename happened. 'write-failed' and
    // 'invalid-session-id' never put this close's bytes at the path.
    const withdrawal = written.reason.startsWith('reread-')
      ? withdrawOwnReceipt(hypoDir, sessionId, receipt.generation)
      : { ok: true };
    return {
      ok: false,
      reason: 'receipt-write-failed',
      writeReason: written.reason,
      ...(withdrawal.ok ? {} : { retractFailed: withdrawal.reason }),
    };
  }
  let wrote = false;
  try {
    wrote = !!writeMarker();
  } catch {
    // A writer that throws did not write. Same outcome as returning false.
  }
  if (wrote && existsSync(sessionClosedMarkerPath(hypoDir, sessionId))) return { ok: true };
  const retracted = invalidateCloseArtifacts(hypoDir, sessionId);
  return {
    ok: false,
    reason: 'marker-did-not-land',
    ...(retracted.ok ? {} : { retractFailed: retracted.reason }),
  };
}

// The commit a session's OLD close receipt certified, when that commit is no
// longer an ancestor of HEAD (a `git reset --hard` or rebase dropped it).
// Reads the receipt JSON itself instead of readReceiptStrict: that returns no
// receipt object once the commit is unreachable, which is exactly this case.
// A missing or unparsable file, a commit field that is not an object id, or a
// repository git cannot resolve HEAD in all return null, so --mark keeps its
// old behavior there.
function priorReceiptCommitRewritten(hypoDir, sessionId) {
  const path = receiptPath(hypoDir, sessionId);
  if (!path || !existsSync(path)) return null;
  let commit;
  try {
    commit = JSON.parse(readFileSync(path, 'utf-8'))?.commit;
  } catch {
    return null;
  }
  if (typeof commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) return null;
  const git = (...a) => spawnSync('git', ['-C', hypoDir, ...a], { encoding: 'utf-8' });
  if (git('rev-parse', '--verify', '--quiet', 'HEAD').status !== 0) return null;
  const ancestry = git('merge-base', '--is-ancestor', commit, 'HEAD');
  return ancestry.error || ancestry.status === 0 ? null : commit;
}

// ── session-close marker (amendment 2026-05-19) ───────────────
// Standalone marker writer. Used when the LLM closes the session via direct
// Write tool calls (not --apply-session-close). Hook `hypo-auto-minimal-
// crystallize` is the only Reader; writer authority is intentionally split
// between this CLI and the auto-write at the tail of applySessionClose.
//
// Contract: the marker is written only when the FULL /compact gate
// (precompactGateStatus) is green. A failed gate exits 1 with no
// marker — the next Stop hook re-blocks.

export function runMarkSessionClosed(args) {
  if (!args.sessionId) {
    const msg = '--session-id=<id> is required with --mark-session-closed';
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  // --project=<slug> on --mark names the project THIS session closed. It sets the
  // marker's `project` field AND enters the close scope, so an incomplete close in a
  // project this session did not touch is demoted to a notice instead of refusing the
  // marker. It is NOT a gate narrow in the old sense: the marker records the same slug
  // it scoped by, and PreCompact re-derives its own scope FROM that marker — so the
  // two can never disagree, which is what the earlier "attribution only, gate stays
  // global" rule was protecting (it assumed PreCompact stayed global; it no longer
  // does). Everything else the gate checks stays global. Validate the slug exists as a
  // directory, exactly as --check does, but only when it is actually used (a
  // --log-only mark attributes to no project, so --project is moot there).
  if (args.project && !args.logOnly) requireProjectDir(args, args.project);
  // The per-session marker is the THIRD session-close completion
  // signal (after the PreCompact gate and `--check-session-close`). It uses
  // precompactGateStatus, the gate /compact uses, with one deliberate
  // difference: `checkpointMode` (set below) replaces the git axis. /compact
  // blocks on any uncommitted vault change, while the checkpoint blocks only
  // on an uncommitted write THIS session still owns, so another session's
  // dirty file can make /compact wait while this checkpoint still lands.
  // Every other axis is the same, so the marker still enforces feedback
  // projection (over-cap/conflict), W8 design-history staleness, and root
  // hot.md structure, the checks the earlier narrower marker gate skipped.
  // Pass --transcript-path to widen the lint
  // scope to this session's edited files exactly as the interactive hook does;
  // without it the scope is the mandatory close files only.
  // --log-only marks a non-project (tooling / wiki-only) session as
  // closed without attributing it to any project. The gate runs in log-only mode
  // (project-close invariant → a today log.md entry; lint/W8 scoped to shared +
  // touched files, never the active/phantom project), but git / hot / feedback
  // still apply — log-only is NOT a global-gate bypass.
  // Resolve the close transcript once from the session id (glob, never a CLI
  // arg): it both widens the lint scope inside the gate AND is the evidence
  // source for the user-close hard gate below.
  const closeTranscript = resolveTranscriptBySessionId(args.sessionId);
  // resolveGateProjectOverride (session-close-scope-boundary spec §2/§3): closeScope
  // above only widens THIS session's accountability set (evidence union for the
  // marker's attribution) -- it does not narrow closeAccountableScope's base, so a
  // DIFFERENT project's dangling close files still land in the git-dirty check and
  // block a `--project=<mine>` mark. Passed below as `attributionScope`: this is
  // the value that feeds the mine/foreign partition in precompactGateStatus and
  // demotes the foreign project's own close-file debt to a notice instead of
  // block, and it also decides which projects the marker this call may go on to
  // write ends up attesting -- so passing `projectOverride` instead would narrow
  // sessionCloseGlobalStatus to args.project alone and turn the partition off,
  // which is the bug this key split fixes (a marker then claimed the demoted
  // foreign project was closed too, because close.scope was never narrowed).
  // --project has already passed requireProjectDir's slug + directory check above
  // when !args.logOnly, so resolveGateProjectOverride's own validation is a
  // formality here, not the only guard. The `sessionCwd` argument below is dead:
  // resolveGateProjectOverride returns from its `if (project)` branch before
  // sessionCwd is ever read, and that branch is exactly the one this ternary's
  // `args.project && !args.logOnly` guard takes. Kept only because removing it
  // would suggest sessionCwd narrows this call, which it never has. Scoped to
  // the explicit --project case only (matching closeScope's own condition
  // above): with no --project, this call has no attribution evidence to narrow
  // to yet (markerProjects is decided further down from the transcript), so
  // leaving attributionScope unset here keeps the global judgment that P2's
  // sessionCwd close-cwd check already depends on for a no-argument
  // `--mark-session-closed`.
  const attributionScope =
    args.project && !args.logOnly
      ? resolveGateProjectOverride(args.hypoDir, {
          project: args.project,
          sessionCwd: args.sessionCwd || null,
        })
      : null;
  // --mark invalidates right at its own gate call (there is no payload or
  // preflight to race, unlike the apply path's authority check). A prior
  // receipt/marker for THIS session must not keep certifying a close once a
  // fresh `--mark-session-closed` is attempted, whether or not this attempt
  // goes on to succeed.
  // The one exception is a prior receipt whose commit history no longer
  // contains (reset/rebase): invalidating it and certifying today's other
  // close files would report "closed" while the original close record is gone.
  // Refuse before anything is touched so the old receipt stays as evidence.
  const rewritten = priorReceiptCommitRewritten(args.hypoDir, args.sessionId);
  if (rewritten) {
    const msg =
      `--mark-session-closed refused: the commit this session's earlier close proved ` +
      `(${rewritten}) is no longer in the branch history. Restore that commit, or ask the ` +
      `user to close again and run --apply-session-close with a new payload.`;
    console.log(
      args.json
        ? JSON.stringify(
            {
              ok: false,
              session_id: args.sessionId,
              reason: 'prior-checkpoint-rewritten',
              prior_commit: rewritten,
              error: msg,
            },
            null,
            2,
          )
        : `✗ ${msg}`,
    );
    process.exit(1);
  }
  const invalidated = invalidateCloseArtifacts(args.hypoDir, args.sessionId);
  if (!invalidated.ok) {
    const msg =
      `--mark-session-closed refused before the gate ran: could not invalidate this session's ` +
      `prior close receipt/marker (${invalidated.reason}). Fix the underlying problem (usually a ` +
      `permission or disk issue under .cache/) and retry.`;
    console.log(
      args.json
        ? JSON.stringify({ ok: false, session_id: args.sessionId, error: msg }, null, 2)
        : `✗ ${msg}`,
    );
    process.exit(1);
  }
  const gate = precompactGateStatus(args.hypoDir, {
    ...(args.project && !args.logOnly ? { closeScope: [args.project] } : {}),
    ...(closeTranscript ? { transcriptPath: closeTranscript } : {}),
    ...(args.logOnly ? { logOnly: true } : {}),
    // P2 (session-close attribution): the marker gate must refuse to attest compact-ready while the
    // session's cwd project has an unstarted close. logOnly exempts it in-gate.
    ...(args.sessionCwd ? { sessionCwd: args.sessionCwd } : {}),
    ...(attributionScope ? { attributionScope } : {}),
    // One of the two marker-writing paths, which must share ONE `ok`
    // invariant with the apply path's own marker phase (see that call
    // site's identical comment).
    checkpointMode: true,
    sessionId: args.sessionId,
  });
  const status = gate.close;
  if (!gate.ok) {
    const result = {
      ok: false,
      session_id: args.sessionId,
      project: status.project,
      missing: status.missing,
      stale: status.stale,
      blockers: gate.blockers,
      error: 'session-close gate not satisfied — marker not written',
    };
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `✗ session-close gate not satisfied — marker not written (project: ${status.project || '(unresolved)'}):`,
      );
      for (const b of gate.blockers) console.log(`  ✗ ${b.reason}`);
    }
    process.exit(1);
  }
  // User-close hard gate: the compact gate above only proves the wiki
  // is compact-ready; it does NOT prove the USER asked to close. Refuse the marker
  // unless the transcript carries a genuine user close signal (NL close phrase,
  // /compact, or an AskUserQuestion close answer). This is the hard backstop for
  // model over-close, where prose guidance lost to a conflicting global rule.
  // Fail-closed when the transcript can't be resolved.
  // One call, read by BOTH paths below. It used to sit inside the refusal
  // branch, which left the success path with no way to see a hostTagWarning at
  // all: a close that survived a pasted host tag wrote its marker, unblocked
  // the Stop chain, and said nothing, on the one entry point a model reaches
  // after closing by hand. Hoisting changes no gate decision: the decision
  // below still reads the raw `isCloseGateOpen` boolean per this file's
  // "runMarkSessionClosed stays on isCloseGateOpen" contract, and this result
  // is only ever read for its two strings. `null` when there is no transcript
  // to read either from.
  const gateStatus = closeTranscript
    ? closeGateStatus({
        transcriptPath: closeTranscript,
        hypoDir: args.hypoDir,
        sessionId: args.sessionId,
      })
    : null;
  // This path writes one thing, the marker, and makes no commit, so the undo
  // it offers is the marker alone. A revert instruction here would point at
  // something this run never created. No 5th argument: kind 'marker-only'
  // never reads commitSha (its message names only the marker file, see
  // hostTagWarningWithUndo's own `undo` table), and this call site made no
  // commit at all to report one for, so leaving it `undefined` here is the
  // honest answer, not a shortcut.
  const hostTagWarning = hostTagWarningWithUndo(
    gateStatus?.hostTagWarning,
    'marker-only',
    args.hypoDir,
    args.sessionId,
  );
  if (!closeTranscript || !isCloseGateOpen(closeTranscript)) {
    const reason = !closeTranscript
      ? `cannot resolve a transcript for session ${args.sessionId} — the session-closed marker requires a verifiable user close signal`
      : "no user close signal in this session's transcript — marker refused (the user did not signal session close)";
    // This path used to collapse straight to the bare `no-user-close-signal`
    // string, so a stale HOST_TAG_NAMES allowlist was invisible here even
    // though verifyCloseAuthority's own refusal (the apply path, before any
    // write) already surfaces it via `gateReason`. Reusing that same field
    // name and the same source (closeGateStatus, hoisted above) closes the
    // gap. `null` when there is no transcript to read one from at all.
    const gateReason = gateStatus?.reason ?? null;
    const result = {
      ok: false,
      session_id: args.sessionId,
      project: status.project,
      skipReason: 'no-user-close-signal',
      ...(gateReason ? { gateReason } : {}),
      error: reason,
    };
    console.log(
      args.json
        ? JSON.stringify(result, null, 2)
        : `✗ ${reason}${gateReason ? `\nGate detail: ${gateReason}` : ''}`,
    );
    process.exit(1);
  }
  // Marker attribution comes from EVIDENCE, never from the gate's global
  // `primary` (which is recency-derived, hypo-shared.mjs). The marker is what
  // PreCompact later re-derives its own scope from, so attributing it to a project
  // this session did not close hands PreCompact a scope the marker never cleared.
  // The evidence set is the close scope — explicit --project ∪ the transcript's
  // touched close files ∪ any prior marker for this session — all of which
  // resolveCloseScope already unioned into status.scope. The recency primary is
  // deliberately excluded: an empty scope means this session has no proof it closed
  // any project (evidence-based close attribution), so we FAIL CLOSED rather than misattribute to recency.
  const closeScope = status.scope || [];
  const markerProjects = [
    ...new Set([...(!args.logOnly && args.project ? [args.project] : []), ...closeScope]),
  ];
  if (!args.logOnly && markerProjects.length === 0) {
    const err =
      'cannot attribute this close to a project — no evidence (no --project, no transcript close-file edits, no prior marker). ' +
      'Pass --project=<slug> for the project this session closed, or --log-only for a non-project (tooling/wiki-only) session.';
    console.log(
      args.json
        ? JSON.stringify(
            {
              ok: false,
              session_id: args.sessionId,
              skipReason: 'no-attribution-evidence',
              error: err,
            },
            null,
            2,
          )
        : `✗ ${err}`,
    );
    process.exit(1);
  }
  const markerProject = !args.logOnly && args.project ? args.project : markerProjects[0];
  // verified_scope (session-close-scope-boundary spec §3, revised 2026-09-07):
  // records the set the gate ABOVE actually made a row for and evaluated —
  // never `markerProjects` (evidence-based attribution, `projects` above).
  // `closeScope: [args.project]` widens resolveCloseScope's mine/foreign
  // partition (it feeds `opts.closeScope`, never `opts.projectOverride`), so
  // it does NOT narrow `sessionCloseGlobalStatus`: the gate ran unnarrowed
  // regardless of --project (resolveGateProjectOverride's own doc comment;
  // hypo-shared.mjs's sessionCloseGlobalStatus/precompactGateStatus doc
  // comments). `kind` is therefore always 'global' here. 'project' stays a
  // shape normalizeVerifiedScope and doctor's reader accept — for a future
  // writer that DOES pass opts.projectOverride, which none of the four
  // marker-writing paths do today. The earlier premise here (an explicit
  // --project earns 'project') was a doctor regression: a transcript-widened
  // scope can attribute a project the gate never put a row for, and stamping
  // markerProjects verbatim let that project's close artifacts pass doctor's
  // correlation unchecked.
  const evaluatedProjects = (status.projects || []).map((p) => p.project).filter(Boolean);
  const verifiedScope = args.logOnly
    ? { kind: 'log-only' }
    : { kind: 'global', projects: evaluatedProjects };
  // Build and verify the CERT_CLOSE_FILES proof, read the C this proof is
  // verified against, and land the receipt and its marker, all inside the
  // vault-commit lock, the same lock the apply path's own commit step holds,
  // so a concurrent close cannot land a commit in the gap between this
  // proof's worktree reads and the HEAD this call certifies against.
  // A lock timeout is contention, not a crash: it gets the same JSON and
  // exit 1 as every other refusal here (the apply path maps the same timeout
  // to commit-failed). Any other throw is a real fault and still propagates.
  let receiptResult;
  try {
    receiptResult = withFileLock(vaultCommitLockTarget(args.hypoDir), () => {
      const proof = buildMarkCloseProof(args.hypoDir, markerProjects, args.logOnly);
      if (!proof.ok)
        return { ok: false, reason: 'incomplete', incompleteProjects: proof.incompleteProjects };
      const head = readHeadShaLocked(args.hypoDir);
      const repo = head ? repoIdentity(args.hypoDir) : null;
      if (!head || !repo) return { ok: false, reason: 'no-commit-identity' };
      const verify = verifyEntriesInCommit(args.hypoDir, head, proof.entries);
      if (!verify.ok) return { ok: false, reason: 'mismatch', mismatches: verify.mismatches };
      const generation = randomBytes(16).toString('hex');
      const receipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        certification: CERT_CLOSE_FILES,
        generation,
        sessionId: args.sessionId,
        repo,
        commit: head,
        scope: args.logOnly
          ? { mode: 'log-only', projects: [] }
          : { mode: 'project', projects: markerProjects },
        entries: proof.entries,
        skipped: gate.skipped || { lint: false, feedback: false },
        createdAt: new Date().toISOString(),
      };
      const landed = landReceiptThenMarker(args.hypoDir, args.sessionId, receipt, () =>
        writeSessionClosedMarker(args.hypoDir, args.sessionId, {
          project: markerProject,
          projects: args.logOnly ? [] : markerProjects,
          ...(args.logOnly ? { scope: 'log-only' } : {}),
          verifiedScope,
          // Same residual the console line below reports, kept in the marker so a
          // reader auditing this close later sees the same thing the operator saw
          // at the time. The apply path stamps its own marker the same way.
          ...(hostTagWarning ? { hostTagWarning } : {}),
          // Names the receipt this marker projects. See writeSessionClosedMarker's
          // own doc comment for what a new Stop does with this field.
          receiptGeneration: generation,
        }),
      );
      if (landed.ok) return { ok: true };
      return landed.reason === 'receipt-write-failed'
        ? {
            ok: false,
            reason: 'write-failed',
            writeReason: landed.writeReason,
            ...(landed.retractFailed ? { retractFailed: landed.retractFailed } : {}),
          }
        : {
            ok: false,
            reason: 'marker-did-not-land',
            ...(landed.retractFailed ? { retractFailed: landed.retractFailed } : {}),
          };
    });
  } catch (e) {
    if (e?.code !== 'ELOCKTIMEOUT') throw e;
    receiptResult = { ok: false, reason: 'vault-commit-lock-timeout' };
  }
  if (!receiptResult.ok) {
    const detail =
      receiptResult.reason === 'incomplete'
        ? `incomplete for project(s): ${receiptResult.incompleteProjects.join(', ')} (session-state.md, hot.md, the session-log evidence file, and log.md must all be committed, not merely present)`
        : receiptResult.reason === 'mismatch'
          ? `proof mismatch: ${JSON.stringify(receiptResult.mismatches)}`
          : receiptResult.reason === 'write-failed'
            ? `receipt write failed: ${receiptResult.writeReason}` +
              (receiptResult.retractFailed
                ? `; withdrawing what it may have left failed too (${receiptResult.retractFailed}), so a stale receipt may remain`
                : '')
            : receiptResult.reason === 'vault-commit-lock-timeout'
              ? 'another close or commit held the vault-commit lock past the timeout; re-run shortly'
              : 'no commit identity (not a git repository, or no commit exists yet)';
    // A marker that did not land after a certified receipt keeps its own
    // wording: it is a disk problem under .cache/, not a proof problem, and the
    // receipt filed for it has already been withdrawn.
    const err =
      receiptResult.reason === 'marker-did-not-land'
        ? 'marker file did not land after write (likely .cache permission/disk issue); ' +
          'the close checkpoint receipt filed for it was withdrawn' +
          (receiptResult.retractFailed
            ? `, but withdrawing it failed (${receiptResult.retractFailed}), so a stale receipt may remain`
            : '')
        : `session-close checkpoint could not be certified, marker not written (${detail})`;
    console.log(
      args.json
        ? JSON.stringify(
            { ok: false, session_id: args.sessionId, error: err, ...receiptResult },
            null,
            2,
          )
        : `✗ ${err}`,
    );
    process.exit(1);
  }
  const result = {
    ok: true,
    session_id: args.sessionId,
    project: markerProject,
    scope: args.logOnly ? 'log-only' : 'project',
    date: status.dates[0],
    notices: gate.notices,
    // The close-time residual, on the success path this entry point owns.
    // Present exactly when closeGateStatus named a neutralized host tag, and
    // carrying the marker-only undo (no commit exists on this path).
    ...(hostTagWarning ? { hostTagWarning } : {}),
    // pure feedback-projection drift is a non-blocker: the marker
    // attests "compact-ready (no human-fixable blocker)", and the PreCompact
    // hook self-heals the projection (feedback-sync --write) at /compact. Surface
    // the deferral so the caller knows MEMORY/CLAUDE sync is pending, not lost.
    drift_deferred: gate.driftTargets,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      args.logOnly
        ? `✓ session-closed marker written (session_id: ${args.sessionId}, scope: log-only — no project attribution).`
        : `✓ session-closed marker written (session_id: ${args.sessionId}, project: ${markerProject}).`,
    );
    if (gate.driftTargets.length > 0) {
      console.log(
        `  · feedback projection drift (${gate.driftTargets.join(', ')}) — will self-heal at /compact.`,
      );
    }
    // Once per run, next to the marker this run just wrote. The apply path
    // prints the same string next to its own commit; both read one value
    // computed once per run, so neither repeats on a later gate read.
    if (hostTagWarning) console.log(`\n⚠ ${hostTagWarning}`);
  }
  process.exit(0);
}

// The close pipeline's marker decision as a PURE function of pre-resolved
// signals. The caller (applySessionClose) keeps the IO lazy (commit first, then
// transcript resolve, then gate, then user-signal scan only once the gate
// passes) and feeds the resulting booleans here; this function owns only the
// branch PRIORITY and the reason strings, so a deterministic table test can
// exercise the state machine without spawning the
// CLI. Returns { write, skipReason }: `write` true means the caller should
// attempt writeSessionClosedMarker; `skipReason` (non-null on every non-write
// branch) is the surfaced reason the marker was withheld.
//   - !ok / no session id     → not a marker-write path (skipReason null)
//   - commit failed           → commit-failed: <reason>
//   - compact gate not ok     → compact-gate-not-ok
//   - no transcript           → transcript-unresolved
//   - transcript, no signal   → no-user-close-signal
//   - all clear               → write:true
export function planMarkerDecision({
  ok,
  hasSessionId,
  committed,
  commitReason,
  gateOk,
  transcriptResolved,
  hasUserSignal,
}) {
  if (!ok || !hasSessionId) return { write: false, skipReason: null };
  if (!committed) return { write: false, skipReason: `commit-failed: ${commitReason}` };
  if (!gateOk) return { write: false, skipReason: 'compact-gate-not-ok' };
  if (!transcriptResolved || !hasUserSignal) {
    return {
      write: false,
      skipReason: transcriptResolved ? 'no-user-close-signal' : 'transcript-unresolved',
    };
  }
  return { write: true, skipReason: null };
}

// The runtime close-result invariant self-check. Given
// the settled marker fields, return a non-null contradiction tag when the result
// is internally inconsistent, else null. This is a REGRESSION GUARD: every
// non-write branch of planMarkerDecision already records a reason today, so the
// contradictions below are unreachable — the seam exists so a future branch that
// forgets to record a reason (or double-sets a written marker with a skip
// reason) fails LOUDLY (ok flipped false, exit 1) instead of silently emitting a
// misleading ok:true that a skill-following model reads as "session closed".
// A "real reason" is a non-blank STRING — every legitimate skip reason is one.
// Anything else (null, a blank string, or a non-string like false/0/{}) is not a
// surfaced reason and must not suppress the check, so a future bad assignment
// cannot hide a withheld marker behind a bogus value.
//   A: ok:true but the marker was withheld with no reason recorded.
//   B: a marker was written AND a skip reason was also set (mutually exclusive).
export function closeResultContradiction({ ok, markerWritten, markerSkipReason }) {
  const hasRealReason = typeof markerSkipReason === 'string' && markerSkipReason.trim() !== '';
  if (ok === true && markerWritten === false && !hasRealReason) {
    return 'internal-contradiction:marker-withheld-without-reason';
  }
  if (markerWritten === true && hasRealReason) {
    return 'internal-contradiction:marker-written-with-skip-reason';
  }
  return null;
}

// A withheld marker with a legitimate reason is not, by itself, a
// reason to fail the apply. Most of planMarkerDecision's skip branches
// (compact-gate-not-ok, no-user-close-signal, transcript-unresolved,
// commit-failed) name a condition THIS SAME SESSION can clear and retry,
// see the "a marker withheld by a real vault-commit failure leaves the close
// signal unspent for a retry" test, whose whole point is that ok stays true
// there and the close signal is not burned. Forcing ok:false on every one of
// those would resurrect that exact regression's failure mode from the other
// direction.
//
// 'marker-did-not-land' is not one of those. runMarkerPhase only reaches it
// after `planMarkerDecision` has already returned `write: true`, meaning the
// compact gate passed, a user close signal was present, and the commit
// landed. Every precondition `--mark-session-closed` also requires before
// writing the SAME marker was already satisfied here; the only thing that
// then failed is the write itself (a `.cache` permission/disk issue), which
// `--mark-session-closed` already treats as fatal (exit 1). Before this
// check, `--apply-session-close` was the one entry point that swallowed that
// exact failure as ok:true. The same failure landing on two different exit
// codes depending on which command hit it.
export function markerWriteGenuinelyFailed({ markerWritten, markerSkipReason }) {
  // The two new receipt-stage skip reasons are exactly as fatal
  // as 'marker-did-not-land': every precondition cleared (gate, commit,
  // user signal) and the close still could not certify itself. A caller
  // reading only `$?` must see this as unclosed, same as a marker write
  // that never landed.
  return (
    markerWritten !== true &&
    (markerSkipReason === 'marker-did-not-land' ||
      markerSkipReason === 'receipt-proof-mismatch' ||
      markerSkipReason === 'receipt-write-failed')
  );
}

// What the model should do when the close is refused. Deliberately does NOT name
// a flag: the way out of this gate cannot be an argument the model can add, or
// the gate is decorative. The way out is the user, which is the one input the
// model does not author.
const CLOSE_REFUSAL_HELP = [
  'Nothing was written and nothing was committed.',
  '',
  'Do NOT add a bypass flag, and do NOT write the close files directly with an editor',
  'or a shell — that is the same close without the check, and it is the thing this gate',
  'exists to stop.',
  '',
  'If the user has not asked to close: do not close. Session-close is not a reward for',
  'finishing a task, and a long session is not a close signal. Keep working, or ask ONCE',
  'whether to wrap up, and take no for an answer.',
  '',
  'If the user HAS asked: pass the current main-conversation --session-id (not a',
  'background-task or agent uuid from a /tmp path) and re-run this exact payload. The',
  'writes are idempotent.',
].join('\n');

/**
 * May this session apply a close at all?
 *
 * Authority comes from the transcript, because the transcript is the one input the
 * model cannot author: the user's own words are in it, and nothing the model says
 * counts (extractUserMessages drops injected, tool, and hook-feedback text).
 *
 *   { ok: true, hostTagWarning? }   `hostTagWarning` is present only when
 *     closeGateStatus reported one: this close survived a HOST_TAG_NAMES-shaped
 *     queue item reading as neutral rather than a retraction (see that field's
 *     own doc comment). Threaded through by the caller so it is surfaced once,
 *     at commit time, rather than guessed against on every gate read.
 *   { ok: false, reason, error, gateReason? }   reason: session-id-required |
 *     transcript-unresolved | no-user-close-signal. `gateReason` is only present
 *     when `reason` is `no-user-close-signal`, and carries closeGateStatus's own
 *     reason string (no-open / transcript-rewrite-detected /
 *     no-new-open-since-resolution) for a caller that wants to tell those three
 *     apart without parsing `error`.
 */
function verifyCloseAuthority(sessionId, hypoDir) {
  if (!sessionId) {
    return {
      ok: false,
      reason: 'session-id-required',
      error:
        'session-close apply refused before any wiki write or commit: --session-id is required, ' +
        "because the close signal is verified against that session's transcript. Omitting it does " +
        'not skip the check, it fails it.',
    };
  }
  const transcript = resolveTranscriptBySessionId(sessionId);
  if (!transcript) {
    return {
      ok: false,
      reason: 'transcript-unresolved',
      error:
        `session-close apply refused before any wiki write or commit: no transcript resolves for ` +
        `session ${sessionId}. Pass the MAIN conversation's session id — a uuid taken from a ` +
        `background-task output path or an agent thread is not it, and --transcript-path is not ` +
        `authority here.`,
    };
  }
  const gateStatus = closeGateStatus({ transcriptPath: transcript, hypoDir, sessionId });
  if (!gateStatus.ok) {
    return {
      ok: false,
      reason: 'no-user-close-signal',
      // The user-facing `reason` above stays the single collapsed string
      // tests and downstream tooling already key on (see this function's own
      // doc comment). `gateReason` carries closeGateStatus's actual reason
      // (no-open / transcript-rewrite-detected / no-new-open-since-resolution)
      // as a separate, machine-readable field, so a caller can tell the three
      // apart without parsing the "Gate detail: ..." substring out of `error`.
      gateReason: gateStatus.reason,
      error:
        "session-close apply refused before any wiki write or commit: this session's transcript " +
        'carries no user close signal. The user did not ask to close. ' +
        `Gate detail: ${gateStatus.reason}`,
    };
  }
  return {
    ok: true,
    ...(gateStatus.hostTagWarning ? { hostTagWarning: gateStatus.hostTagWarning } : {}),
  };
}

// A-1 (project index lifecycle): seed projects/<project>/index.md from the
// template the first time this project closes without one. SCHEMA.md declares
// project-index at projects/*/index.md and templates/projects/_template/ ships
// one, but createProject (the auto-project-offer path) is the only writer of
// it today — a project directory created any other way (a manual mkdir, an
// older vault, direct Write tool calls) never gets one. Idempotent: an
// existing index.md is left untouched; this only fills the gap, and only the
// three tokens the template defines are substituted — the rest (one-line
// description, Progress checklist) stays human-authored prose exactly as
// createProject already leaves it.
//
// `working_dir` has no authoritative source in this flow: apply never
// receives the session's cwd (see hooks/hypo-shared.mjs's precompactGateStatus
// doc — process.cwd() is explicitly non-authoritative here, since it reflects
// this script's own launch directory, not the session's). It is left EMPTY,
// not filled with a placeholder string: hooks/hypo-shared.mjs's collector
// (collectProjectWorkingDirs) and findBackfillCandidate both treat any truthy
// `working_dir` as "already anchored" and stop offering to backfill the real
// cwd — a fake placeholder is truthy, so it would silently and permanently
// swallow the exact anchor-recovery path a human would otherwise get. Empty
// stays falsy there, so the project surfaces as a genuine backfill candidate
// until a person (or the auto-project-offer flow) fills in a real path. The
// key itself stays present in the frontmatter (substituted to an empty value,
// not omitted) so the shape matches every other index.md and a human sees
// exactly where to type the answer.
// "Never overwrite an existing index" is this feature's explicit contract, so
// creation uses an EXCLUSIVE create (`wx`), not the existsSync-then-atomicWrite
// shape every other target in this file uses. atomicWrite's tmp+rename
// replaces whatever sits at `dest` the instant rename fires — existing or not —
// so a plain `if (existsSync(dest)) return null` beforehand only narrows the
// race, it does not close it: another writer (a human, or a concurrent close)
// can land real bytes at `dest` between that check and this function's rename.
// `wx` makes the OS do the check-and-create atomically, mirroring
// hooks/base-store.mjs's snapshotBase (`openSync(path, 'wx')` + EEXIST ==
// "someone already got there, leave it"). No tmp+rename is needed here: unlike
// atomicWrite's use case (replacing bytes a reader might already be mid-read
// of), a `wx` create can never observably tear — the file either doesn't
// exist yet (nothing to tear) or the open fails outright.
// `sessionId` (optional, added for the close journal) records this create in
// hooks/close-journal.mjs immediately after the bytes land, so a retry of the
// SAME close that finds index.md already present (applyOverwrites' retry
// branch) can tell "I created this and it is still exactly what I left it"
// apart from a hand edit. Omitted entirely by callers outside a close
// (tests/crystallize-apply.test.mjs's race-condition check), where there is
// no session to journal against and recordJournalEntry's own `!sessionId`
// guard makes the call a no-op.
export function ensureProjectIndex(hypoDir, project, relPath, today, sessionId) {
  const dest = join(hypoDir, relPath);
  const src = join(TEMPLATE_DIR, 'index.md');
  if (!existsSync(src)) return null; // template missing — nothing to scaffold from
  const content = substituteTokens(readFileSync(src, 'utf-8'), {
    name: project,
    started: today,
    workingDir: '',
    today,
  });
  mkdirSync(dirname(dest), { recursive: true });
  let fd;
  try {
    fd = openSync(dest, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') return null; // another writer already created it
    throw e;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  recordJournalEntry(hypoDir, sessionId, relPath, hashContent(content));
  return relPath;
}

// ── close authority: BEFORE any write ──────────────────────────────────────
// A payload is a claim that the user asked to close. Verify it here, ahead of
// readPayload and every byte that follows, because everything after this point
// is authoritative: session-state.md and the hot files are overwritten, the
// session-log and log.md are appended, and hypo-auto-commit lands the lot in git
// on the next Stop whether or not this command commits.
//
// The gate used to stand at the END, next to the marker (planMarkerDecision).
// It refused the MARKER on a close the user never asked for, and let the writes
// and the commit through. Worse, it was opt-in BY THE CALLER: with no
// --session-id there was no transcript to check, so the check simply did not
// run, and the apply reported ok:true with no skip reason at all. The model
// chose whether the model got checked. A model that has already decided to close
// does not reach for the flag that would stop it.
//
// So: no verifiable close signal, no close. Zero bytes, no commit, exit 1.
//
// What this does and does not promise. It promises that THIS entrypoint refuses
// a close with no recognized transcript evidence behind it. It does not promise
// the model cannot write these files at all: Write and Bash remain outside this
// gate, and the evidence predicate itself is coarse (any close signal anywhere in
// the transcript counts, so a stale one from earlier in a long session still
// passes, and it is the model that authors the AskUserQuestion option labels the
// user picks from). Narrowing that (current-turn binding, revocation, consent
// that the model did not word) is the follow-up this ADR names; it is not a
// reason to leave the default open in the meantime.
// Only a payload-bearing call can write. A payload-less one falls through to the
// "payload is required" error below without touching a byte, so gating it here
// would just replace one refusal with a less accurate one.
//
// Refuses in place (console.log + process.exit(1)) instead of returning a
// verdict: process.exit never returns, so the caller's flow stops exactly where
// it stopped before this section was a function of its own. On success it
// returns `hostTagWarning` (string, or null) instead of exiting, so the
// caller can carry it through the rest of this apply and surface it exactly
// once, alongside the commit it is now about to make, rather than here
// before anything has actually happened yet.
function refuseUnlessCloseRequested(args) {
  const closeAuth = args.payload
    ? verifyCloseAuthority(args.sessionId, args.hypoDir)
    : { ok: true };
  if (!closeAuth.ok) {
    const out = {
      ok: false,
      stage: 'no-user-close-signal',
      reason: closeAuth.reason,
      // Only set when `reason` is 'no-user-close-signal' (undefined otherwise,
      // and JSON.stringify drops an undefined-valued key). Lets a caller tell
      // apart the three closeGateStatus refusals collapsed into that one
      // `reason` string, without parsing "Gate detail: ..." out of `error`.
      gateReason: closeAuth.gateReason,
      applied: [],
      // `null`, not `false`: this refusal fires before the commit step is ever
      // reached (see the general result's own `committed` contract below).
      // `false` is reserved for a commit that actually ran and failed.
      committed: null,
      error: closeAuth.error,
    };
    console.log(
      args.json ? JSON.stringify(out, null, 2) : `✗ ${closeAuth.error}\n\n${CLOSE_REFUSAL_HELP}`,
    );
    process.exit(1);
  }
  // Invalidate this session's prior close receipt and compat marker the
  // moment a NEW close is authorized, before payload validation or preflight,
  // not later at writeCloseIntent. A close authorized now that later fails preflight must not leave a stale
  // "closed" proof standing for Stop to trust; the user asked to close again,
  // so the old proof is spent the instant that request is accepted, whether
  // or not this particular attempt goes on to succeed. `--mark-session-closed`
  // invalidates at its own gate call instead (no payload/preflight to race).
  if (args.payload && args.sessionId) {
    const invalidated = invalidateCloseArtifacts(args.hypoDir, args.sessionId);
    if (!invalidated.ok) {
      const msg =
        `session-close apply refused before any wiki write or commit: could not invalidate ` +
        `this session's prior close receipt/marker (${invalidated.reason}). Fix the underlying ` +
        `problem (usually a permission or disk issue under .cache/) and retry; nothing was written.`;
      const out = {
        ok: false,
        stage: 'invalidate-failed',
        error: msg,
        applied: [],
        committed: null,
      };
      console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${msg}`);
      process.exit(1);
    }
  }
  return closeAuth.hostTagWarning || null;
}

// Read the payload, check its shape, and bind it to THIS session. Exits 1 on any
// of the three failures; returns the parsed payload otherwise.
function loadValidatedPayload(args) {
  let payload;
  try {
    payload = readPayload(args.payload);
  } catch (e) {
    const out = { ok: false, error: e.message };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${e.message}`);
    process.exit(1);
  }

  const schemaErrs = validatePayloadShape(payload);
  if (schemaErrs.length > 0) {
    const out = { ok: false, error: 'payload schema invalid', details: schemaErrs };
    console.log(
      args.json
        ? JSON.stringify(out, null, 2)
        : `✗ payload schema invalid:\n  ${schemaErrs.join('\n  ')}`,
    );
    process.exit(1);
  }

  // Payload↔session binding (cross-session payload collision). The payload temp
  // file is now written to a session-scoped path (see commands/crystallize.md), so
  // two same-day sessions no longer share a file. This is the belt to that
  // suspenders: if the payload names
  // the session it was authored for, it must be THIS one — the --session-id whose
  // transcript already cleared close authority above. A mismatch means the file on
  // disk is not this session's close (a stray or hand-reused path handed us another
  // session's payload), and applying it would stamp that content with this session's
  // marker while the original session's record vanishes — the exact loss this
  // guard exists to prevent. Refuse before a byte is written.
  //
  // Absent field → fail open: older payloads predate this field, and Part 1's unique
  // path already prevents the collision. So the check only ever tightens; it never
  // rejects a close it would otherwise have allowed on a matching (or absent) id. It
  // is deliberately identity-based, not cwd-based: closing project B from a session
  // whose cwd is project A stays supported (payload.project is authoritative), so a
  // legitimately cross-project close is untouched.
  if (
    payload.sessionId !== undefined &&
    payload.sessionId !== null &&
    payload.sessionId !== args.sessionId
  ) {
    const msg =
      `payload.sessionId ${JSON.stringify(payload.sessionId)} does not match --session-id ` +
      `${JSON.stringify(args.sessionId)}: this payload was authored for a different session, so ` +
      `it is not this session's close. Refusing before any write (cross-session guard).`;
    const out = {
      ok: false,
      stage: 'session-id-mismatch',
      error: msg,
      applied: [],
      // `null`, not `false` — refused before the commit step, same contract as
      // the `no-user-close-signal` refusal above.
      committed: null,
    };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }

  return payload;
}

// Resolve project: payload.project is REQUIRED (B-3, close-gate-hardening). The
// old recency fallback (payload.project || probe.project) could, on a same-date
// root-hot.md tie, resolve a DIFFERENT project than the one the payload's files
// belong to — apply would then write the close into the wrong project (silent
// data loss). Validate fail-fast, BEFORE the probe is consulted:
//   - missing      → no target to write; abort rather than infer.
//   - invalid name → reject (non-string, wrong charset, or dot-only) BEFORE the
//                    existsSync(join(...)) path build, so a `../`-style value
//                    never reaches a path builder (traversal guard — order is
//                    the guard). isValidProjectName is SHARED with createProject
//                    so apply accepts exactly the namespace the repo can
//                    scaffold (A-Za-z0-9._-, single segment) — no narrower.
//   - non-existent → projects/<slug>/ absent; abort rather than create.
// A payload.project that merely DIFFERS from the inferred active project is NOT an
// error — it is surfaced as a stderr note below and the close proceeds.
function resolveCloseProject(args, payload) {
  if (payload.project === undefined || payload.project === null) {
    const msg = 'payload.project is required (apply must not infer the close target project)';
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  if (!isValidProjectName(payload.project)) {
    const msg = `payload.project ${JSON.stringify(payload.project)} is not a valid project name (single segment, charset A-Za-z0-9._-, ≥1 alnum, not "."/"..")`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  // existsSync alone is not enough: a regular FILE at projects/<slug> would pass,
  // then apply would build child paths under it and fail with an unstructured
  // filesystem error (codex re-review). Require it to be a directory.
  const projectDir = join(args.hypoDir, 'projects', payload.project);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    const msg = `payload.project "${payload.project}" does not exist as a directory (no projects/${payload.project}/ directory)`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  const project = payload.project;
  // probe (the recency-inferred active project) is now consulted ONLY to surface a
  // divergence note — never to resolve the target. Computed AFTER validation so a
  // malformed/missing payload.project fails fast without a pointer-table read.
  // Resolved BEFORE preflight because preflight needs overwrite-target paths
  // (which require the project slug) to filter out errors in files this apply
  // is about to replace — see the filter rationale below.
  const probe = sessionCloseFileStatus(args.hypoDir);
  // The freshness verification below (and at the post-apply check) already honors
  // payload.project — `project` wins over the inferred active project, and the
  // post-apply sessionCloseFileStatus call passes it as projectOverride. But when the
  // payload targets a DIFFERENT project than the one active-project resolution infers
  // (probe.project), that divergence used to be silent, so an operator couldn't tell
  // which project the close actually verified. Surface it on stderr (the stdout JSON
  // contract is untouched) so the verified/closed project is always explicit.
  if (probe.project && probe.project !== payload.project) {
    process.stderr.write(
      `note: payload.project="${payload.project}" differs from the inferred active ` +
        `project "${probe.project}"; verifying and closing "${payload.project}".\n`,
    );
  }
  return project;
}

// Pre-apply freshness-contract gate: the post-apply verification holds
// sessionCloseFileStatus's hasSessionLogHeading / hasLogEntry as the
// definition of "closed today". Enforce that SAME contract on the payload
// BEFORE writing a byte, so a heading the gate won't recognize is rejected
// here as a format mismatch — not written and then misdiagnosed downstream as
// "stale" (the "not updated" vs "format mismatch" conflation). All checks
// exit 1 with stage='pre-apply-verification' and leave the tree untouched.
function assertPayloadFreshnessContract(args, payload, project, date) {
  const failPreApply = (msg) => {
    console.log(
      args.json
        ? JSON.stringify({ ok: false, stage: 'pre-apply-verification', error: msg }, null, 2)
        : `✗ ${msg}`,
    );
    process.exit(1);
  };
  // (a) The session-log entry must carry a dated `## [<date>] …` ATX heading. The
  // post-apply gate checks the session-log file for exactly this heading, so a
  // headingless entry would write then false-fail as "stale". This also doubles
  // as the B-1 derive precondition: when `log` is omitted the root log.md entry
  // is reconstructed from THIS heading, and on a same-day SECOND close the
  // date-level verifier would still pass on the earlier entry, so a no-derive
  // would slip through as ok:true. The `!payload.log` branch keeps the original
  // derive-specific wording (a test asserts it).
  if (!hasSessionLogHeading(payload.sessionLog.entry || '', date)) {
    failPreApply(
      !payload.log
        ? `payload.sessionLog.entry has no "## [${date}] …" heading to derive the log.md ` +
            `entry from. Give it a dated heading, or supply payload.log explicitly.`
        : `payload.sessionLog.entry has no "## [${date}] …" heading. The close gate ` +
            `identifies a session-log by its dated ATX heading; give the entry a ` +
            `"## [${date}] <title>" heading (the brackets are required).`,
    );
  }
  // (b) An explicit payload.log entry must match the canonical
  // `## [<date>] session | <project>` line the gate looks for (colon or space
  // delimiter after the slug). Otherwise the write lands but post-apply
  // verification reports log.md as stale. When `log` is omitted the line is
  // derived canonically (rootLogEntry) so this cannot mismatch.
  if (payload.log && !hasLogEntry(payload.log.entry || '', date, project)) {
    failPreApply(
      `payload.log.entry has no "## [${date}] session | ${project}" heading that the ` +
        `close gate recognizes. Fix the entry heading, or omit payload.log to derive it.`,
    );
  }
}

// Preflight: lint the wiki BEFORE writing any payload bytes. If lint
// has blockers (errors) in files this apply WON'T overwrite, the wiki is in
// a degraded state and apply would mask the root cause — abort fail-fast.
//
// Overwrite-target filter (codex P2 follow-up): errors in files we're about
// to fully replace are IGNORED at preflight. Otherwise a bad payload
// (post-apply-lint fail) would leave the broken file on disk and the very
// next retry — even with a corrected payload — gets dead-locked here. The
// post-apply lint is the authoritative check on payload content.
//
// Append targets (session-log, log.md) are NOT filtered: appending can't
// repair existing corruption, so a corrupt session-log must still block.
// Warns are informational (not gated) in either pass.
//
// The filter says "about to be replaced", and the observed-base guard can later
// decline to replace one of these. Preflight runs before the guard, so it cannot
// know. Harmless: post-apply lint re-scopes the same file and blocks on it there.
//
// Returns the payload scope and the A-1 index facts alongside the lint result:
// both are derived here (before any write) and consumed by the write and
// post-apply phases.
function runPreflight(args, payload, project, date) {
  const overwriteTargets = new Set();
  if (payload.sessionState) overwriteTargets.add(join('projects', project, 'session-state.md'));
  if (payload.projectHot) overwriteTargets.add(join('projects', project, 'hot.md'));
  if (payload.openQuestions) overwriteTargets.add(join('pages', 'open-questions.md'));

  // Bug B: the documented close path must not be blocked by lint debt OUTSIDE
  // the files it writes (other projects, shared pages this close did not author).
  // payloadScope = every file this apply writes or appends. Both lint passes are
  // judged against it; errors elsewhere are surfaced as notices, never blocking.
  //
  // session-log needs TWO entries: the daily WRITE target (what this
  // apply creates/appends, judged by post-apply lint) AND the freshness EVIDENCE
  // file. They coincide except in the hybrid cutover month, where a fallback-
  // aware no-op (the identical entry already lives in the legacy monthly file)
  // writes no daily shard, leaving the monthly as the proof of freshness. Scope
  // must then include that monthly file, or a CORRUPT monthly evidence file would
  // pass the gate with its lint error demoted to a non-blocking notice.
  // sessionLogScopePath returns the monthly ONLY when it carries today's heading
  // (otherwise the daily write target), so unrelated monthly debt stays a notice.
  // join() (platform-native), not the POSIX helper output: payloadScope membership
  // is tested against lint's raw `e.file` (path.relative) WITHOUT posix
  // normalization, so it must use the OS-native separator the sibling entries use.
  const sessionLogWriteTarget = join('projects', project, 'session-log', `${date}.md`);
  const sessionLogEvidence = join(...sessionLogScopePath(args.hypoDir, project, date).split('/'));
  // A-1: known here (read-only check, no write yet) so a freshly-scaffolded
  // index.md is scoped to THIS close's own payloadScope below, rather than
  // showing up as an unrelated pre-existing-content notice.
  const indexRelPath = join('projects', project, 'index.md');
  const indexMissing = !existsSync(join(args.hypoDir, indexRelPath));
  const payloadScope = new Set([
    join('projects', project, 'session-state.md'),
    join('projects', project, 'hot.md'),
    'hot.md',
    sessionLogWriteTarget,
    sessionLogEvidence, // == write target, except a hybrid-month monthly fallback
    'log.md',
    ...(payload.openQuestions ? [join('pages', 'open-questions.md')] : []),
    ...(indexMissing ? [indexRelPath] : []),
  ]);

  let preflightLint;
  try {
    preflightLint = runLint(args.hypoDir);
  } catch (e) {
    const out = { ok: false, stage: 'preflight-lint', error: e.message };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${e.message}`);
    process.exit(1);
  }
  // Block only on errors in payload files we are NOT about to overwrite (append
  // targets — session-log, log.md — can't be repaired by appending, so existing
  // corruption there must block). Overwrite targets are about to be replaced;
  // out-of-scope debt is not this close's concern (Bug B).
  const blockingErrors = preflightLint.errors.filter(
    (e) => payloadScope.has(e.file) && !overwriteTargets.has(e.file),
  );
  // W9 (invalid-YAML frontmatter) legacy-debt policy: the SAME append-target
  // rule as blockingErrors above, applied to W9 specifically. A pre-existing
  // broken frontmatter block on an append target (log.md, the session-log
  // shard) can never be healed by this close, because appendIfAbsent only adds
  // bytes below the block and never rewrites it. Leaving it unblocked would let
  // every future close keep appending onto (and reporting success over) a file
  // post-apply lint can never certify clean, so it is blocked HERE, before a
  // single byte is written, exactly like a pre-existing lint ERROR in an
  // append target already does two lines above. Overwrite targets are exempt
  // for the same reason blockingErrors exempts them: this close is about to
  // replace their bytes outright, so their PRE-existing frontmatter is moot
  // (the post-apply check below is what catches a payload that writes its own
  // broken YAML into one of those). Out-of-scope W9 debt elsewhere in the
  // vault (this repo's own maintainer vault carries one, under
  // pages/feedback/) is untouched by this filter and stays a plain warn.
  //
  // W9 carries no `id` in the default (non-strict) --json warns lint.mjs
  // returns, only W8 does (see lint.mjs's `toOut`), so it is matched by its
  // fixed message prefix instead, the same technique registerPendingTags
  // above already uses for W10.
  const blockingW9 = (preflightLint.warns || []).filter(
    (w) =>
      INVALID_YAML_WARN_RE.test(w.message || '') &&
      payloadScope.has(w.file) &&
      !overwriteTargets.has(w.file),
  );
  const allPreflightBlocking = [...blockingErrors, ...blockingW9];
  if (allPreflightBlocking.length > 0) {
    const out = {
      ok: false,
      stage: 'preflight-lint',
      error: 'lint preflight failed — apply aborted (no payload bytes written)',
      lint: { ...summarizeLintForOutput(preflightLint), blockingErrors: allPreflightBlocking },
    };
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log('✗ lint preflight failed — apply aborted (no payload bytes written):');
      for (const e of allPreflightBlocking) console.log(`  ✗ ${e.file}: ${e.message}`);
      console.log('  Fix the wiki (run `node scripts/lint.mjs`) and retry.');
    }
    process.exit(1);
  }

  return { preflightLint, payloadScope, indexRelPath, indexMissing };
}

// ── section-loss guard (2026-08-10 incident) ────────────────────────────────
//
// The base-store guard above answers "did someone ELSE change this page since
// I looked at it". It cannot answer "did the payload I am about to write throw
// away structure that was already here" — a session that legitimately observed
// its own prior base (no drift, no conflict) can still overwrite a multi-track
// session-state.md or hot.md with a payload that only carries the ONE track it
// was working on, silently dropping the others. That is exactly what happened
// to security-backoffice: three tracks, two of them vanished, and the base
// guard had nothing to say about it because it was never a conflict in the
// guard's sense — it was a normal, unopposed overwrite.
//
// This is deliberately a COUNT of `##` headings that vanish between disk and
// payload, not a markdown-aware diff. The block-parser lesson from the base
// guard above applies here too: a predicate that reads content and claims to
// know what was "provably" preserved is the thing four review rounds already
// broke. Counting exact-line survival is cheap, has no false negatives worth
// chasing (a heading either survives verbatim or it does not), and its one
// failure mode (a legitimately reworded heading reads as "lost") is exactly
// what the escape hatch below is for.
// A ratio floor alone gets LOOSER as a file grows, exactly backwards from what
// this guard is for: a file running more tracks in parallel is bigger (a bigger
// denominator), and that is the one where losing a fixed handful of sections
// should trip sooner, not later. A distribution was counted against the real
// vault on 2026-09-11 with `grep -c '^## ' <file>` (every LINE starting with
// `## `, duplicates included) against every hot.md / session-state.md /
// open-questions.md: project hot.md ran 4-9 such lines (harness's was 9),
// project session-state.md ran 1-12 (harness's was 12), pages/open-questions.md
// had 8, root hot.md had 2. That is a different measurement than this guard's
// own denominator: `h2Headings` below dedupes into a `Set`, so a file that
// repeats one `## ` heading verbatim reports a smaller count here than the grep
// tally did. The two agree on every file this repo actually has (none repeats a
// heading), but the grep number is not proof of what `h2Headings` counts.
//
// At a ratio-only gate, losing 4 of a real 12-section session-state.md
// (4/12 = 0.333) or 3 of a real 9-section hot.md (3/9 = 0.333) both stayed just
// under a 0.34 floor and passed through untouched — real files, real sizes, a
// real miss. An absolute floor was added so a bigger file could not buy a bigger
// free pass just by being bigger, but the first cut of that floor (3) missed the
// shape it was named for: the security-backoffice incident itself lost 2 of 3
// tracks, and 2 lost sections clears neither a 3-floor nor, on a 6-12 section
// file, the 0.34 ratio (2/12 = 0.167). So the floor is 2, matching
// SECTION_LOSS_MIN_COUNT below — and once the two are equal, the ratio branch
// can no longer change the outcome: past the MIN_COUNT guard, `lost.length` is
// always >= 2, which trips the absolute floor unconditionally, so
// `!ratioTrips && !absTrips` can never be true. The two thresholds and the ratio
// check that used to sit between them are folded into the one count check below
// rather than kept as a branch that reads as live but never decides anything.
const SECTION_LOSS_MIN_COUNT = 2; // an ordinary single-section edit (finishing one track,
// retiring one open question) stays under this and must not park; 2 or more is
// the incident's own shape and always trips, at any file size.

// A fence marker line: 0-3 leading spaces (CommonMark still calls that "unindented"),
// then a run of 3+ backticks or 3+ tildes, then the rest of the line. `m[1]` is the
// marker run itself (so its first char and length identify what closes it); `m[2]` is
// whatever follows, an info string on the opening line, and required to be blank
// (after trim) on a line being checked as a close.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Which line indices are inside a fenced code block, for one file's lines.
 *
 * A fence opens on any line FENCE_RE matches while not already inside one, and
 * closes only on a later line whose marker is the SAME character and AT LEAST as
 * long (a 4-backtick open is not closed by 3 backticks, a CommonMark rule, and the
 * one this guard's predecessor ignored: the section-loss bypass this closes moved
 * two `##` headings into a properly-closed ```md fence and the old line-scan still
 * counted them as real headings because it never looked for a fence at all).
 *
 * An opening fence that never finds a matching close before EOF is treated as
 * NEVER HAVING OPENED (every line from that marker to EOF is unhidden here). That
 * is the safe direction for a guard whose entire job is "did content silently
 * disappear": the same function extracts headings from both disk and payload, so
 * treating an unclosed run as fenced would let it swallow real headings on
 * whichever side has the malformed markdown: undercounting disk (hiding sections
 * the guard should have protected) or undercounting payload (reporting a section
 * as lost when the payload never actually removed it). Treating it as prose
 * instead only risks the opposite: an occasional false park on a document with a
 * genuinely broken fence, which is recoverable through the same
 * `restructure: true` / proposal-resolve door every other park in this guard
 * already uses, not a silent loss.
 *
 * Declined on purpose, not CommonMark-complete: an opening line's info string is
 * never checked for a stray backtick (CommonMark forbids one in a backtick fence's
 * info string; this scan does not care), and a fence inside a blockquote or list
 * item is scanned exactly like a top-level one. Both would need block-context
 * tracking this guard's own doc comment (above, the base-conflict guard section)
 * already argues against building here. Getting the two reproduced bypasses closed
 * cheaply matters more than a complete parser.
 *
 * @returns {boolean[]} same length as `lines`, true where the line is fenced
 */
function fencedLineMask(lines) {
  const hidden = new Array(lines.length).fill(false);
  let openIdx = -1;
  let fenceChar = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1) {
      const m = lines[i].match(FENCE_RE);
      if (m) {
        openIdx = i;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        hidden[i] = true; // tentative, unhidden below if this never closes
      }
      continue;
    }
    hidden[i] = true; // tentative, unhidden below if this never closes
    const m = lines[i].match(FENCE_RE);
    if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && m[2].trim() === '') {
      openIdx = -1;
      fenceChar = null;
      fenceLen = 0;
    }
  }
  if (openIdx !== -1) {
    for (let i = openIdx; i < lines.length; i++) hidden[i] = false;
  }
  return hidden;
}

/**
 * Extract this file's `##` section headings, in order, as a MULTISET (every
 * occurrence kept, none deduped) with fenced-code lines excluded. Only `##`
 * (not `#`/`###`), the granularity the section-loss incident was measured at.
 *
 * Multiset, not a `Set`, because a dedup here silently halves the denominator
 * a file that legitimately repeats one `## ` heading twice: the old `Set`-based
 * version counted "## TODO" appearing twice on disk as ONE section, so a
 * payload that kept only one copy compared as "the heading is still present"
 * with nothing lost at all: the second bypass this pass closes.
 *
 * Known limit, left as-is (see fencedLineMask's own doc comment for the fuller
 * case against building a real parser here): this still reads every non-fenced
 * line as prose, so a `## ` line inside an indented (non-fenced) code block, a
 * blockquote, or a list item is still counted as a real heading. That is a
 * false positive (an occasional unnecessary park), not the silent-loss failure
 * mode this guard exists to close, so it is accepted rather than fixed here.
 * @returns {string[]}
 */
function h2Headings(content) {
  const lines = (content || '').split(/\r?\n/);
  const hidden = fencedLineMask(lines);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!hidden[i] && /^##\s+\S/.test(lines[i])) out.push(lines[i]);
  }
  return out;
}

/**
 * Whether `payloadContent` drops enough of `diskContent`'s `##` sections to
 * warrant withholding the write. Compared as a multiset: each disk occurrence
 * is matched off against one still-unconsumed payload occurrence of the exact
 * same line, in disk order, so losing one copy of a heading that appears twice
 * on disk is visible even though the same title still appears once in the
 * payload. A "lost" occurrence is one with no remaining payload copy to match,
 * reworded, split, or genuinely deleted headings all read the same way here
 * (see the module doc comment above for why that is the accepted
 * false-positive, not a defect to fix), and a heading moved into a fenced code
 * block no longer counts as a payload occurrence at all (h2Headings excludes
 * fenced lines on both sides).
 *
 * An ordinary edit that drops a single section (finishing one track, retiring
 * one open question) must not park; losing 2 or more is the incident's own
 * shape (security-backoffice lost 2 of its 3 tracks) and trips regardless of
 * how big the file is. See SECTION_LOSS_MIN_COUNT's comment above for why this
 * is now a single count check rather than a count-and-ratio pair.
 *
 * @returns {{lost: string[], diskCount: number}|null} the lost occurrences
 *   (duplicates repeated once per lost copy) and how many `##` heading
 *   occurrences disk had (also a multiset count, not deduped; see
 *   h2Headings), or null when the write is fine
 */
export function sectionLossReason(diskContent, payloadContent) {
  const diskHeadings = h2Headings(diskContent);
  if (diskHeadings.length === 0) return null; // nothing to lose
  const payloadHeadings = h2Headings(payloadContent);
  const remaining = new Map();
  for (const h of payloadHeadings) remaining.set(h, (remaining.get(h) || 0) + 1);
  const lost = [];
  for (const h of diskHeadings) {
    const n = remaining.get(h) || 0;
    if (n > 0) {
      remaining.set(h, n - 1);
    } else {
      lost.push(h);
    }
  }
  if (lost.length < SECTION_LOSS_MIN_COUNT) return null;
  return { lost, diskCount: diskHeadings.length };
}

/**
 * Replace every whole-page overwrite target, then fill a missing project index.
 *
 * `acc` is the shared accumulator bag (`applied` / `skipped` / `appliedPaths` /
 * `conflicts`) the caller owns; every write phase pushes into the same arrays
 * rather than returning partial lists for the caller to merge, so the ordering
 * of the report lines is the call order, exactly as it was inline.
 *
 * Replace a whole page, guarded by the base this session observed at start.
 *
 * The step order inside `overwrite` is load-bearing, not stylistic:
 *
 *   1. idempotent skip (disk already equals the payload)
 *   2. conflict (base unknown, or disk drifted away from base)
 *   3. section-loss guard (payload drops most of disk's `## `
 *      sections: parks either way; `restructure: true` only changes WHICH
 *      park reason is recorded, it no longer lets the write through)
 *   4. direct write, then advance the base
 *
 * Step 1 must come first for two reasons. It keeps every existing
 * `--apply-session-close --session-id` test green (they read the payload
 * straight off disk, so they land here before any base lookup). And it breaks
 * the apply-then-reclose loop: once a human applies proposal P, disk == proposed
 * == payload.content, so the next close skips before it can re-raise a conflict.
 *
 * Step 3 runs only once step 2 has already cleared: a base conflict already
 * withholds the write on its own, and reporting BOTH reasons for the same
 * withheld byte would tell a resolving human two different stories about why
 * their proposal review matters.
 *
 * There is no caller here without a `--session-id`. verifyCloseAuthority refuses
 * that at the door, before a byte is written, so a session id is always present
 * by the time this runs and the base lookup always has something to look up.
 */
// ── close-intent durability (major finding: close's file set is not atomic) ──
// applyOverwrites below writes up to 3 target files (session-state.md,
// project hot.md, open-questions.md) as 3 SEPARATE atomicWrite calls. Each
// individual write is torn-proof (temp + rename), but the SET is not: a
// SIGKILL between the first rename and the second write leaves one target
// holding new bytes and the next holding whatever was there before, with
// nothing on disk saying this is an in-progress set rather than a finished
// one. sessionCloseFileStatus's freshness check is content-blind by design,
// so if the untouched target already happened to carry today's date (an
// unrelated earlier edit, not this close), a later freshness-only read sees
// the set as complete when it never was.
//
// This intent file is the missing witness. `writeCloseIntent` records every
// target this apply is about to attempt and the hash each one is expected to
// land at, BEFORE the first overwrite runs, with `phase: 'writing'`.
// `markCloseIntentApplied` moves it to `phase: 'applied'` once applyOverwrites
// has returned, and `clearCloseIntent` removes it only once the commit that
// follows has landed. It used to be cleared right after applyOverwrites,
// before the log appends and the commit: a process that died in that window
// left every target at today's date with no record and no commit, and the
// next probe read that as a finished close. A leftover record therefore means
// the LAST close that started this set never got its bytes committed, whether
// it died mid-write or later. `hasTornCloseIntent` is what the no-payload
// probe branch (`alreadyComplete`) checks before trusting a green freshness
// read, since that is the one path in THIS file that could otherwise report
// success purely on freshness.
//
// A close that ends ok:false (a withheld conflict, a lint failure, a failed
// commit) never reaches the commit, so it leaves its record behind on
// purpose. Its bytes are on disk and uncommitted, and that is exactly what
// the probe must not call complete. The cost is bounded: the retry that
// re-runs the payload writes its own record over this one and clears it once
// its commit lands, and CLOSE_INTENT_MAX_AGE_MS expires it otherwise.
//
// Every record also carries an `attemptId` (major fix): the path this file
// lives at is keyed on `sessionId` alone, so a retry of the SAME session
// (a resume after a crash, or an overlapping second apply) writes a SECOND
// record to the exact same path a first attempt is still holding open. With
// no identity beyond the path, the first attempt's own `clearCloseIntent`
// (or `hasTornCloseIntent`'s expiry sweep) cannot tell "the record I am
// about to delete is still the one I wrote" from "someone else's live
// record now sits where mine used to be": deleting on path alone would
// silently erase a second attempt's still-in-progress witness. `attemptId`
// is this call's own identity: a clear only ever removes the file when a
// FRESH re-read, taken under the same lock, still shows this exact
// `attemptId`. A record with no `attemptId` at all (written by a build of
// this file from before this fix) is handled by the same comparison, not a
// special case: `undefined === undefined` still matches, so a legacy record
// clears exactly when nothing newer has since overwritten it, and stops
// matching the instant a NEW (attemptId-bearing) record replaces it, the
// same protection this fix gives every record going forward.
export function closeIntentPath(hypoDir, sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  return join(hypoDir, '.cache', 'close-intent', `${sessionId}.json`);
}

function closeIntentTargetsFor(payload, project) {
  const targets = [
    {
      relPath: join('projects', project, 'session-state.md'),
      hash: hashContent(payload.sessionState.content),
    },
    {
      relPath: join('projects', project, 'hot.md'),
      hash: hashContent(payload.projectHot.content),
    },
  ];
  if (payload.openQuestions) {
    targets.push({
      relPath: join('pages', 'open-questions.md'),
      hash: hashContent(payload.openQuestions.content),
    });
  }
  return targets;
}

// MAJOR fix: this used to swallow every failure (lock timeout, EACCES, a
// full disk under .cache/) and let applyOverwrites start writing target
// files anyway. The witness this record exists to provide never got
// written, and the first target rename could still be the last thing this
// process does before it dies, leaving hasTornCloseIntent's next probe
// with literally nothing to find, so a torn set reads as a clean, finished
// close. The whole point of writing this BEFORE the first byte moves is
// defeated if a failure to write it is not itself fatal to the close: the
// caller now checks `.ok` and refuses before applyOverwrites ever runs (see
// applySessionClose's own call site), so a transient lock/permission/disk
// problem here blocks the close instead of silently disabling its own
// safety net.
// @returns {{ok: true, attemptId: string} | {ok: false, reason: string}}
export function writeCloseIntent(hypoDir, sessionId, targets) {
  const path = closeIntentPath(hypoDir, sessionId);
  // No usable session id: there is no path to key a witness to, the same
  // gap `isValidSessionId` has always left open elsewhere in this file. Not
  // a failure of THIS write: there was nothing for it to attempt, so it
  // reports ok, degrading this run back to freshness-alone exactly as
  // before this fix, never worse.
  if (!path) return { ok: true, attemptId: null };
  const attemptId = randomBytes(8).toString('hex');
  try {
    withFileLock(path, () => {
      // Carry the PRIOR record's `sideEffects` forward into this new
      // attempt, before overwriting it. A side effect (SCHEMA.md's
      // Pending registration, a seeded projects/*/index.md) an earlier,
      // uncommitted attempt at this SAME close already wrote survives this
      // rewrite so a retry can still recognize it and restage it; only the
      // read below (not a write) happens on the OLD bytes, so a corrupt or
      // missing prior record just starts this attempt with none, same as
      // if it had never existed.
      let priorSideEffects = [];
      try {
        const prior = JSON.parse(readFileSync(path, 'utf-8'));
        if (prior && Array.isArray(prior.sideEffects)) priorSideEffects = prior.sideEffects;
      } catch {
        // no prior record, or unreadable: nothing to carry forward
      }
      atomicWrite(
        path,
        JSON.stringify({
          v: 1,
          attemptId,
          phase: 'writing',
          targets,
          sideEffects: priorSideEffects,
          startedAt: new Date().toISOString(),
        }),
      );
    });
    return { ok: true, attemptId };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

/**
 * Every side-effect entry `readCloseIntentSideEffects`/`recordCloseIntentSideEffect`
 * carry: `{ path, kind: 'create' | 'schema-pending', bytesSha256, tags?: string[] }`.
 * `tags` is present only for `kind: 'schema-pending'` (the exact tags a prior
 * attempt registered into SCHEMA.md's Pending block, needed to rebuild the
 * proof entry on restage without re-parsing anything).
 *
 * Record one side effect this attempt just made, under the SAME
 * attemptId-matching discipline as `markCloseIntentApplied`: a write here
 * only lands when the record at this path still shows the attemptId this
 * call was given, so a newer attempt (or a stale one racing after its own
 * clear) can never have its record corrupted by an older writer. Best-effort:
 * a lost side-effect record just means a later retry treats this path as
 * unexplained dirt again, the same fail-closed outcome as no record at all.
 * @param {{path: string, kind: 'create'|'schema-pending', bytesSha256: string, tags?: string[]}} entry
 */
export function recordCloseIntentSideEffect(hypoDir, sessionId, attemptId, entry) {
  const path = closeIntentPath(hypoDir, sessionId);
  if (!path) return;
  try {
    withFileLock(path, () => {
      let current;
      try {
        current = JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        return;
      }
      if (!current || current.attemptId !== attemptId) return; // a newer record owns this path now
      const rest = (Array.isArray(current.sideEffects) ? current.sideEffects : []).filter(
        (e) => e && e.path !== entry.path,
      );
      atomicWrite(path, JSON.stringify({ ...current, sideEffects: [...rest, entry] }));
    });
  } catch {
    // best-effort, see doc comment above
  }
}

/**
 * This session's own close-intent record's `sideEffects`, whatever attempt
 * (this one, or one carried forward by `writeCloseIntent`) last wrote them.
 * `[]` on any read failure or when no record exists, never thrown: a caller
 * treats an empty result exactly like "no side effect to restage", which is
 * the safe, fail-closed default.
 * @returns {Array<{path: string, kind: string, bytesSha256: string, tags?: string[]}>}
 */
export function readCloseIntentSideEffects(hypoDir, sessionId) {
  const path = closeIntentPath(hypoDir, sessionId);
  if (!path) return [];
  try {
    const current = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(current?.sideEffects) ? current.sideEffects : [];
  } catch {
    return [];
  }
}

// Records that applyOverwrites returned: every target is now written, skipped,
// or withheld, and what is still missing is the commit. Rewrites this call's
// OWN record only (same attemptId check as the clear below), so a newer
// attempt's record at the same path is left alone. Best-effort: a failed
// rewrite leaves `phase: 'writing'`, which blocks the probe just the same.
export function markCloseIntentApplied(hypoDir, sessionId, attemptId) {
  const path = closeIntentPath(hypoDir, sessionId);
  if (!path) return;
  try {
    withFileLock(path, () => {
      const current = JSON.parse(readFileSync(path, 'utf-8'));
      if (!current || current.attemptId !== attemptId) return;
      atomicWrite(path, JSON.stringify({ ...current, phase: 'applied' }));
    });
  } catch {
    // see above: the record stays at 'writing', still a live record
  }
}

// Shared by `clearCloseIntent` (a finished apply removing its own record)
// and `hasTornCloseIntent`'s expiry sweep (deleting a record too old to
// trust): both need the SAME protection, re-read `path` UNDER THE SAME LOCK
// a write would take and unlink only when the bytes still show exactly
// `attemptId`, never on the strength of what an earlier, lock-free read
// already saw. Without this, a second writer racing in between that earlier
// read and the unlink (a same-session retry sharing this path, major fix
// 3, or simply a session that starts a brand-new close on the same
// sessionId right as an old record expires) has its still-live record
// deleted as collateral by a caller that only ever meant to remove the
// stale bytes it originally read.
// `expectedAttemptId` compares with `===`, so `undefined` matches
// `undefined`: a record from before this fix shipped (no `attemptId` field
// at all) still clears correctly as long as nothing newer has since
// overwritten it. That is the legacy-record policy this file's header
// comment documents, not a special case bolted on here.
function unlinkCloseIntentIfMatching(path, expectedAttemptId) {
  withFileLock(path, () => {
    let current;
    try {
      current = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return; // gone, or unreadable/corrupt: not provably still the record we read, leave it
    }
    if (!current || current.attemptId !== expectedAttemptId) return; // a newer record owns this path now
    try {
      unlinkSync(path);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  });
}

// Removes this call's OWN record, never a path on trust alone (major fix,
// same-session-retry race). Two attempts for the SAME sessionId share one
// path (`closeIntentPath` keys on sessionId, not on attempt): if a first
// attempt's clear ran on the path alone, a second attempt's still-live
// record sitting at that same path afterwards would be deleted as
// collateral the instant the first attempt finishes, even though the
// second attempt never crashed and is still relying on that witness.
export function clearCloseIntent(hypoDir, sessionId, attemptId) {
  const path = closeIntentPath(hypoDir, sessionId);
  if (!path) return;
  try {
    unlinkCloseIntentIfMatching(path, attemptId);
  } catch {
    // A leftover record after a run that actually finished reads back as
    // "died mid-set" by the next check: a false alarm, not a silent pass,
    // which is the safe direction for a best-effort clear to fail in.
  }
}

// A record older than this never gets a second chance to finish: the session
// that wrote it is treated as dead, not merely slow. applyOverwrites (the
// only writer between writeCloseIntent and clearCloseIntent) is a bounded
// sequence of small synchronous file writes that normally lands in low
// seconds; this is not tuned to that, it is tuned to the failure mode a
// missed expiry causes. Without one, a single crashed session's leftover
// record blocks EVERY later no-payload probe for this vault forever (the
// writing session never retries, so nothing ever calls clearCloseIntent for
// it). 30 minutes is arbitrary, chosen only to be comfortably longer than any
// real apply (even a slow disk or a huge payload) while still bounding that
// "every close treated as torn" window to well under a day. Same role as
// PROPOSAL_TMP_GRACE_MS in hooks/proposal-store.mjs, different scale because
// this window is bounding a stuck DIAGNOSIS, not a stuck RENAME.
const CLOSE_INTENT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Scan `.cache/close-intent/` for a leftover record whose promised targets no
 * longer match disk. Returns one of three states, not a boolean, because
 * "cannot tell" and "confirmed clean" are different answers a caller must not
 * collapse into each other:
 *
 * - `'torn'`: some earlier close began writing this set and never reached
 *   `clearCloseIntent`, exactly the case a bare freshness check cannot tell
 *   apart from a normal finished close.
 * - `'unreadable'`: the directory, a record, or one of a record's targets
 *   could not be read or parsed, so no comparison against disk was possible
 *   for it. This used to read as `false` (fail open, like every other cache
 *   read in this file), but this function exists SPECIFICALLY to catch what
 *   freshness alone cannot, so failing open here means an EACCES or a
 *   half-written record makes a torn set look clean to the one check built to
 *   catch it. A caller must treat this the same as `'torn'`: fall through to
 *   a real apply rather than trust the freshness probe.
 * - `'uncommitted'`: a live record whose targets all match disk. The files
 *   landed but the commit that clears the record never did (a crash after
 *   the writes, or a close that ended ok:false). This used to read as
 *   `'clean'`, which is how a close that died between its writes and its
 *   commit passed the probe. A caller treats it like `'torn'`.
 * - `'clean'`: every record read fine and had expired, or there were no
 *   records at all.
 *
 * A record older than CLOSE_INTENT_MAX_AGE_MS is treated as neither torn nor
 * unreadable and is deleted here: the session that wrote it is gone, and
 * without this an EACCES-free crash from months ago would still be judged
 * torn (or worse, unreadable, if it happens to also be malformed) on every
 * single close from here on. Deletion is best-effort; a failed unlink just
 * means the next call tries again.
 *
 * MAJOR fix (same-session-retry race, #3): the delete used to unlink `path`
 * straight off the bytes this scan already read, with no lock held between
 * the read and the unlink. If a NEW session (or the same sessionId retrying)
 * writes a fresh record at that exact path in that window, this deletes the
 * new, still-live record as collateral: the file this scan judged expired
 * is not necessarily the file still sitting there by the time the unlink
 * runs. `unlinkCloseIntentIfMatching` closes that window: it re-reads under
 * the same lock a write would take and only unlinks when the bytes still
 * show the exact `attemptId` this scan read a moment ago.
 */
function hasTornCloseIntent(hypoDir) {
  const dir = join(hypoDir, '.cache', 'close-intent');
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    // ENOENT means no close has ever written a record here: the ordinary,
    // overwhelmingly common state, and genuinely clean, not merely
    // unreadable. Every other errno (EACCES, ENOTDIR, ...) means the
    // directory exists but this could not examine it, which is the case
    // this function must not fail open on (see the doc comment above).
    return e && e.code === 'ENOENT' ? 'clean' : 'unreadable';
  }
  let sawUnreadable = false;
  let sawLive = false;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      sawUnreadable = true;
      continue;
    }
    if (!parsed || !Array.isArray(parsed.targets)) {
      sawUnreadable = true;
      continue;
    }
    const startedAt = Date.parse(parsed.startedAt);
    if (Number.isFinite(startedAt) && Date.now() - startedAt > CLOSE_INTENT_MAX_AGE_MS) {
      try {
        unlinkCloseIntentIfMatching(path, parsed.attemptId);
      } catch {
        // best-effort: a leftover expired record just gets re-evaluated (and
        // re-attempted) on the next call
      }
      continue;
    }
    for (const t of parsed.targets) {
      if (!t || typeof t.relPath !== 'string' || typeof t.hash !== 'string') {
        sawUnreadable = true;
        continue;
      }
      const disk = readTarget(join(hypoDir, t.relPath));
      if (typeof disk !== 'string' || hashContent(disk) !== t.hash) return 'torn';
    }
    sawLive = true;
  }
  if (sawUnreadable) return 'unreadable';
  return sawLive ? 'uncommitted' : 'clean';
}

function applyOverwrites(args, payload, project, date, indexRelPath, indexMissing, acc, attemptId) {
  const { applied, skipped, appliedPaths, conflicts, restructureWaivers, proofEntries } = acc;
  // Read once per close, not once per field: it is a single small JSON read,
  // and every skip branch below needs the same session-scoped record.
  const journal = readJournal(args.hypoDir, args.sessionId);

  const overwrite = (key, relPath, field) => {
    if (!field || typeof field.content !== 'string') return; // optional / absent
    const full = join(args.hypoDir, relPath);
    const disk = readTarget(full);

    // (1) idempotent skip — preserves writeIfChanged's contract. "Already
    // current" collapses two different histories that look identical from
    // here: disk always held these bytes, or THIS session wrote them in an
    // earlier, uncommitted attempt at this same close. Only the journal tells
    // them apart. A record for this path whose hash still matches what is on
    // disk means the second history — restage it so the retry's commit picks
    // up bytes an earlier attempt already paid for. No record, or a hash that
    // no longer matches (someone touched the file since), leaves it out: the
    // gate should keep blocking on drift it cannot attribute to this close.
    if (disk === field.content) {
      const journalHash = journal[relPath];
      if (journalHash && journalHash === hashContent(field.content)) {
        appliedPaths.push(relPath);
      }
      skipped.push(`${key} (${relPath})`);
      // Already current: the close proof still needs an entry naming this
      // target (skipped targets are included), since the receipt
      // certifies the payload's own version is IN the commit, not that this
      // apply wrote it just now.
      proofEntries.push({
        path: relPath,
        kind: 'overwrite',
        expected: { bytesSha256: bytesSha256(field.content) },
      });
      return;
    }

    // (2) conflict, only where a session context makes a base observable
    if (args.sessionId) {
      const entry = readBaseEntry(args.hypoDir, args.sessionId, relPath);
      // EVERY mismatch parks. A drifted whole-file overwrite is resolved by a
      // human through `proposal challenge` and `proposal resolve`, which writes
      // exactly the bytes that were shown.
      //
      // Five predicates were written to skip the park when the payload "provably"
      // lost nothing, and four rounds of review broke all five against the real
      // vault: table rows only, a trimmed multiset, an ordered verbatim
      // subsequence, that plus a row-shaped-insert rule, and that plus a placement
      // rule. Each fell to the same thing. A markdown document's meaning is set by
      // block context that starts far above the line being judged, so a predicate
      // reading lines and their neighbours cannot see a payload that preserves
      // every byte and still fences the file into code, merges two paragraphs,
      // invalidates the frontmatter, or cuts a table off from its separator.
      // Proving it needs a block parser, and this guard is not where a markdown
      // parser should live.
      //
      // The narrowing is not coming back in this shape. The pointer table it was
      // built for should stop being a shared whole-file overwrite target at all and
      // become a locally generated projection of the project files that already own
      // those facts; then two machines never contend over it.
      const observedHash = readObservedHash(args.hypoDir, args.sessionId, relPath);
      // A truncated observation never comes back as `observedHash` (readObservedHash
      // refuses it), so this second read is what lets the park reason below tell
      // "never shown anything current" apart from "shown, but only a slice of it" —
      // see base-store.mjs's recordObserved/readObservedHash docs.
      const observedTruncated =
        !observedHash && wasObservedTruncated(args.hypoDir, args.sessionId, relPath);
      const appliedHash = readAppliedHash(args.hypoDir, args.sessionId, relPath);
      const reason = overwriteConflictReason(
        entry,
        disk,
        { hash: observedHash, truncated: observedTruncated },
        appliedHash,
        hashContent(field.content),
      );
      if (reason) {
        conflicts.push({
          key,
          target: relPath,
          reason,
          baseHash: entry.hash,
          currentHash: typeof disk === 'string' ? hashContent(disk) : null,
          proposedContent: field.content,
        });
        return; // target bytes untouched
      }
    }

    // (3) Section-loss guard: this overwrite would drop most of disk's `## ` sections.
    // Computed regardless of `restructure`, so a `true` value set on a field that
    // tripped a REAL loss can be told apart from one set on a field that never had
    // a loss to waive.
    //
    // `field.restructure === true` used to be a full escape hatch: it let the
    // write through immediately, with only `restructureWaivers` left behind as an
    // after-the-fact audit trail. That made the flag self-approving:
    // the party the guard exists to check (the model composing the payload) was
    // also the only party who could clear it, with no human between the claim and
    // the disk write. `restructure: true` no longer bypasses anything. It only
    // picks WHICH park reason applies; either way the bytes are withheld and go
    // through the SAME human-approval door a base conflict already uses
    // (`hypomnema proposal challenge` / `proposal resolve`, a nonce a human types
    // after reviewing the diff). A field that never had a loss to waive still adds
    // no entry to `restructureWaivers`. The flag did nothing there, which is not
    // this field's job to flag.
    if (typeof disk === 'string') {
      const loss = sectionLossReason(disk, field.content);
      if (loss) {
        const restructureRequested = field.restructure === true;
        conflicts.push({
          key,
          target: relPath,
          reason: restructureRequested
            ? 'section-loss-guard-restructure-pending'
            : 'section-loss-guard',
          lostSections: loss.lost,
          diskSectionCount: loss.diskCount,
          baseHash: args.sessionId
            ? readBaseEntry(args.hypoDir, args.sessionId, relPath).hash
            : null,
          currentHash: hashContent(disk),
          proposedContent: field.content,
        });
        if (restructureRequested) {
          // The model's claim is still worth recording, just not as approval:
          // it tells the human reviewing the parked proposal that the payload
          // author believed this restructure was intentional, which is exactly
          // the context `hypomnema proposal challenge` shows them before they
          // type the nonce.
          restructureWaivers.push({ target: relPath, lostSections: loss.lost });
        }
        return; // target bytes untouched either way
      }
    }

    // (4) write, then the content we just wrote IS this session's new base.
    // This target's expected post-write hash is already recorded in this
    // session's close-intent file (written before applyOverwrites started,
    // see closeIntentPath above), so a crash right here (between this
    // rename landing and a sibling field's own write) leaves that record
    // behind for hasTornCloseIntent to find, rather than a silent gap.
    atomicWrite(full, field.content);
    if (args.sessionId) {
      // Base and applied-hash move together, in ONE base.json write
      // (advanceBaseAndRecordApplied), not two calls back to back. Two
      // separate writes (advanceBase, then recordAppliedHash) had a window
      // where the first landed and the second failed, leaving the base moved
      // but the applied record stale (review r4-w4 major 2's silent
      // fall-back to the pre-guard overwrite). A merged write either lands
      // whole or leaves both fields exactly as they were, so a failure here
      // is a normal fail-safe: the base does not move, and the next look at
      // this target sees the same base-mismatch a foreign write would get.
      //
      // The page bytes above are already on disk by the time either call
      // below runs, so neither failure can be undone from here: the guard
      // this section exists to keep honest depends on base.json, not on the
      // page itself. review r5-w3 major 1 named the silent-ignore of these
      // two return values; surfaced to stderr rather than to the result JSON,
      // since the latter is a wider change to `acc`'s shape than this
      // overwrite step owns. A failure here is loud but not fatal: the next
      // close on this target degrades to `base-unknown`/a journal-less retry,
      // both of which already fail safe into a park rather than a silent
      // overwrite.
      if (
        !advanceBaseAndRecordApplied(
          args.hypoDir,
          args.sessionId,
          relPath,
          hashContent(field.content),
        )
      ) {
        process.stderr.write(
          `[crystallize] warning: wrote ${relPath} but could not record its new base/applied hash (base.json write failed): the next close on this target may park as base-unknown\n`,
        );
      }
      // Record what THIS write just put down, so a retry after a partial
      // close (a sibling field conflicts, the commit fails, the process
      // dies) can tell its own uncommitted bytes apart from someone else's —
      // see the journal read in step (1) above and the doc comment on
      // hooks/close-journal.mjs. `recordJournalEntry` itself returns nothing
      // to check (best-effort, swallows its own failures): that function
      // lives in hooks/close-journal.mjs, outside this fix's write scope, so
      // its silent-ignore half of review r5-w3 major 1 is not closed here.
      recordJournalEntry(args.hypoDir, args.sessionId, relPath, hashContent(field.content));
    }
    applied.push(`${key} (${relPath})`);
    appliedPaths.push(relPath);
    proofEntries.push({
      path: relPath,
      kind: 'overwrite',
      expected: { bytesSha256: bytesSha256(field.content) },
    });
  };

  overwrite('sessionState', join('projects', project, 'session-state.md'), payload.sessionState);
  overwrite('projectHot', join('projects', project, 'hot.md'), payload.projectHot);
  overwrite('openQuestions', join('pages', 'open-questions.md'), payload.openQuestions);

  // A-1: fill a missing project index as part of this close's writes (after
  // preflight passed, so an aborted close never leaves a half-applied side
  // effect on disk).
  if (indexMissing) {
    const createdIndex = ensureProjectIndex(
      args.hypoDir,
      project,
      indexRelPath,
      date,
      args.sessionId,
    );
    if (createdIndex) {
      applied.push(`projectIndex (${createdIndex})`);
      appliedPaths.push(createdIndex);
      // Read the bytes back rather than re-deriving substituteTokens' output a
      // second time here: ensureProjectIndex just landed them via atomic
      // create, and re-reading is the same "trust what's actually on disk"
      // discipline every other proof entry in this file follows.
      const createdContent = readTarget(join(args.hypoDir, createdIndex));
      if (typeof createdContent === 'string') {
        const bytesSha = bytesSha256(createdContent);
        proofEntries.push({
          path: createdIndex,
          kind: 'create',
          expected: { bytesSha256: bytesSha },
        });
        // Witness this create as a close-intent side effect
        // too, alongside the journal record ensureProjectIndex already wrote.
        // A retry that (for any reason) cannot trust the journal still has
        // this to fall back on.
        recordCloseIntentSideEffect(args.hypoDir, args.sessionId, attemptId, {
          path: createdIndex,
          kind: 'create',
          bytesSha256: bytesSha,
        });
      }
    }
  } else {
    // The retry path. A first attempt that seeds index.md and then fails to
    // commit leaves it dirty; this run finds it already there, so the branch
    // above does nothing and the file would drop out of the commit scope
    // entirely, blocking the gate forever with no retry ever picking it back
    // up. Restaging it is only safe when the journal says THIS session wrote
    // exactly the bytes still on disk — the same rule step (1)'s idempotent
    // skip applies, reused here because ensureProjectIndex never reaches
    // step (1) at all (it is a template-seeded create, not a payload
    // overwrite field). A hand-edited index.md (no journal record, or a
    // journal record whose hash no longer matches) is left OUT of
    // appliedPaths on purpose: those are bytes this close never wrote, and
    // sweeping them into its commit would ship an edit the payload never
    // carried.
    const full = join(args.hypoDir, indexRelPath);
    const disk = readTarget(full);
    const journalHash = journal[indexRelPath];
    if (journalHash && typeof disk === 'string' && journalHash === hashContent(disk)) {
      appliedPaths.push(indexRelPath);
      proofEntries.push({
        path: indexRelPath,
        kind: 'create',
        expected: { bytesSha256: bytesSha256(disk) },
      });
    } else if (typeof disk === 'string') {
      // Fallback witness: no journal record (or a stale one), but
      // this session's own close-intent still names this exact create as a
      // side effect, and the bytes on disk still match it byte for byte.
      // Same restage judgment as the journal branch above, from a second
      // witness.
      const priorIndex = readCloseIntentSideEffects(args.hypoDir, args.sessionId).find(
        (e) => e && e.path === indexRelPath && e.kind === 'create',
      );
      if (priorIndex && bytesSha256(disk) === priorIndex.bytesSha256) {
        appliedPaths.push(indexRelPath);
        proofEntries.push({
          path: indexRelPath,
          kind: 'create',
          expected: { bytesSha256: priorIndex.bytesSha256 },
        });
      }
    }
  }
}

// Append idempotency: dedup by exact-entry presence, not by "any heading
// dated today". The freshness gate (sessionCloseFileStatus) is what answers
// "was this file touched today?"; that's a different concern and must not
// be reused for apply-time dedup, or a legitimate same-day second close gets
// silently dropped (Codex review of the apply path — Worker 1 finding 2).
const entryAlreadyPresent = (entry) => (content) =>
  content.includes(entry.endsWith('\n') ? entry.replace(/\n+$/, '') : entry);

// Append this close's entry to the project's daily session-log shard, pushing the
// outcome into the shared `acc` bag.
function appendSessionLogEntry(args, payload, project, date, acc) {
  const { applied, skipped, appliedPaths, conflicts, proofEntries } = acc;
  const rel = join('projects', project, 'session-log', `${date}.md`);
  const full = join(args.hypoDir, rel);
  const isPresent = entryAlreadyPresent(payload.sessionLog.entry);
  const journal = readJournal(args.hypoDir, args.sessionId);
  // Which file actually carries this close's entry: the daily shard `rel`
  // on a create/append, or whichever hybrid-cutover candidate the "already
  // present" scan below matched. The proof entry must name THAT path: an
  // append proof against `rel` when the entry in fact lives in the legacy
  // monthly file would never verify against the commit.
  let evidencePath = rel;
  // Serialize dedup + create/append on the daily shard so two concurrent
  // closes never lose an entry: the second closer takes the lock only after
  // the first committed, re-reads the shard under the lock, and appends onto
  // the committed bytes (temp+rename write-isolation is preserved — a partial
  // write never tears the target). Create and append share ONE lock, so the
  // "seed a new shard" and "append to an existing shard" branches can't race
  // each other — only one closer is ever in the create path (closes the
  // wx-window a bare exclusive-create would leave open).
  try {
    const outcome = withFileLock(
      full,
      () => {
        // Fallback-aware idempotency (hybrid cutover): during the month the
        // shard takes over, today's entry may already live in the legacy monthly
        // file from an earlier (pre-cutover) close. Treat presence in EITHER the
        // daily shard or the legacy monthly file as "already written" so a same-day
        // second close does not duplicate an identical entry across both files —
        // and so an idempotent re-apply stays a true no-op (no shard is created).
        for (const cand of sessionLogReadCandidates(project, date)) {
          const cf = join(args.hypoDir, cand);
          if (!existsSync(cf)) continue;
          try {
            if (isPresent(readFileSync(cf, 'utf-8'))) {
              evidencePath = cand; // the candidate that actually carries the entry
              return 'skipped';
            }
          } catch {
            /* unreadable candidate — fall through to the write path */
          }
        }
        if (!existsSync(full)) {
          // A daily shard is a new file most days. Seed minimal valid frontmatter
          // (title + type, the two REQUIRED_FIELDS) so the shard is a first-class
          // wiki page rather than a W1 "no frontmatter" warning, and write the header
          // AND the first entry in ONE atomic write — never leave a header-only shard
          // on disk, which freshness would skip (no dated heading) while derive could
          // otherwise mistake it for the evidence file. The dated `## [date] ...`
          // heading lives inside the entry, so freshness / derive / design-history
          // are unchanged.
          // Audit fields (device, session_id). The shard frontmatter is git-tracked and synced, so
          // `device` is an INTENTIONAL synced multi-machine identifier (privacy note:
          // docs/ARCHITECTURE.md). It is a CREATOR-only stamp — only the session/
          // machine that first seeds the daily shard is recorded; later same-day
          // appends do not touch it. The per-session-accurate store is the LOCAL
          // (.cache/, gitignored) index.jsonl written by hypo-session-record.mjs.
          // `session_id` is honest naming: the value is the Claude session UUID, and
          // it is present only on the Stop-chain close path that passes --session-id.
          const device = currentDevice();
          const auditFm =
            (args.sessionId
              ? `session_id: ${String(args.sessionId).replace(/[\r\n]/g, '')}\n`
              : '') + `device: ${device}\n`;
          const header =
            `---\ntitle: Session Log ${date} (${project})\n` +
            `type: session-log\nupdated: ${date}\n${auditFm}---\n\n` +
            `# Session Log ${date} (${project})\n`;
          const entry = payload.sessionLog.entry;
          const body = entry.endsWith('\n') ? entry : `${entry}\n`;
          atomicWrite(full, `${header}\n${body}`);
          return 'created';
        }
        return appendIfAbsent(full, payload.sessionLog.entry, isPresent) ? 'appended' : 'skipped';
      },
      { timeoutMs: APPEND_LOCK_TIMEOUT_MS },
    );
    (outcome === 'skipped' ? skipped : applied).push(`sessionLog (${rel})`);
    if (outcome !== 'skipped') {
      appliedPaths.push(rel);
      // Same journal contract as applyOverwrites: record the FULL file's hash
      // right after this write, not just the entry, since a retry's own
      // "already present" skip below reads the whole file back to compare.
      const written = readTarget(full);
      if (typeof written === 'string')
        recordJournalEntry(args.hypoDir, args.sessionId, rel, hashContent(written));
    } else {
      // "Already present" collapses the same two histories the overwrite
      // guard's step (1) does: this entry could have sat in the shard since
      // before this close ever ran, or THIS session appended it in an
      // earlier, uncommitted attempt at the same close. Restage only the
      // second — a journal record whose hash still matches the shard on
      // disk. (A hybrid-month fallback hit above never reaches here with
      // `full` matching the journal's recorded target, since the evidence in
      // that case lives in the legacy monthly file instead — nothing to
      // restore for the daily shard because this close never wrote one.)
      const journalHash = journal[rel];
      if (journalHash) {
        const disk = readTarget(full);
        if (typeof disk === 'string' && journalHash === hashContent(disk)) {
          appliedPaths.push(rel);
        }
      }
    }
    // session-log evidence (always included): the exact path
    // sessionCloseFileStatus's freshness check would accept for THIS
    // close's entry, whichever of the hybrid candidates actually carries it.
    proofEntries.push({
      path: evidencePath,
      kind: 'append',
      expected: { entryBlocks: [payload.sessionLog.entry] },
    });
  } catch (err) {
    // Only a lock-TIMEOUT is withheld as a conflict. A real fn() write error
    // (disk-full, EACCES, mkdir failure) must NOT be masked as a proposal-
    // pending timeout — rethrow so it hard-fails like the overwrite path does.
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    // Lock-timeout: withhold rather than lose the entry. Recorded as a conflict
    // so the close goes proposal-pending (ok:false, no marker) and the next
    // close re-applies. `kind: 'append'` is what T6 branches on to SKIP parking
    // this: an append conflict never becomes a `.cache/proposals/` artifact —
    // the lock-timeout is transient and the next close self-heals by
    // re-appending, whereas a whole-file re-apply would drop this shard's other
    // entries. It still blocks the close; it just gets no artifact.
    conflicts.push({
      key: 'sessionLog',
      target: rel,
      reason: 'append-lock-timeout',
      kind: 'append',
      baseHash: null,
      currentHash: null,
      proposedContent: payload.sessionLog.entry,
    });
  }
}

// log.md: `payload.log` is OPTIONAL (B-1). When the caller supplies it, keep
// the explicit appendIfAbsent path (backward-compat: a custom log line, with
// the same idempotent dedup). When it is ABSENT, the root log.md entry is a
// DERIVABLE artifact: reconstruct the canonical `## [date] session | <project>`
// line directly from THIS close's session-log heading (`payload.sessionLog`),
// not by re-reading the session-log files. Deriving from the payload is what
// makes the per-close entry exact: a same-day second close lands its distinct
// heading, and a hybrid daily/monthly session-log split can't hide it (apply
// never reads those files for this). The global scan-based deriveRootLogEntries
// (the Stop hook) still backfills OTHER projects; calling it here would either
// miss the current entry (single-candidate read) or, with a loosened guard,
// append onto a deliberately custom payload.log (codex pre-commit review). The
// two payload paths are mutually exclusive: deriving on top of a present-but-
// malformed payload.log would mask it and weaken the verifier's fail-loud.
// log.md is shared across projects and also written by deriveRootLogEntries
// (the Stop-hook backfill in hypo-shared.mjs). Both take the SAME lock on
// log.md, so a concurrent close's append and this close's append serialize
// instead of overwriting each other.
// log.md is a single shared file both branches below append to, so a
// "wrote nothing new" outcome from either one needs the same journal-based
// restore-vs-leave-dirty judgment applyOverwrites' step (1) already makes:
// this session's own prior, uncommitted append restages; anything else does
// not. Centralized here rather than duplicated per branch, and rather than
// merely commented twice, because a fix to one copy silently drifting from
// the other is exactly the failure mode two near-identical blocks invite.
function restageOrRecordLogMd(args, logFull, journal, wroteNew, acc) {
  const { appliedPaths } = acc;
  if (wroteNew) {
    appliedPaths.push('log.md');
    const written = readTarget(logFull);
    if (typeof written === 'string')
      recordJournalEntry(args.hypoDir, args.sessionId, 'log.md', hashContent(written));
    return;
  }
  const journalHash = journal['log.md'];
  if (journalHash) {
    const disk = readTarget(logFull);
    if (typeof disk === 'string' && journalHash === hashContent(disk)) {
      appliedPaths.push('log.md');
    }
  }
}

function appendRootLogEntry(args, payload, project, date, acc) {
  const { applied, skipped, conflicts, proofEntries } = acc;
  const logFull = join(args.hypoDir, 'log.md');
  const journal = readJournal(args.hypoDir, args.sessionId);
  if (payload.log) {
    try {
      const wrote = withFileLock(
        logFull,
        () => appendIfAbsent(logFull, payload.log.entry, entryAlreadyPresent(payload.log.entry)),
        { timeoutMs: APPEND_LOCK_TIMEOUT_MS },
      );
      (wrote ? applied : skipped).push('log (log.md)');
      restageOrRecordLogMd(args, logFull, journal, wrote, acc);
      // Append proof is the ENTRY, never just a heading: a sibling body
      // under the same heading must not verify.
      proofEntries.push({
        path: 'log.md',
        kind: 'append',
        expected: { entryBlocks: [payload.log.entry] },
      });
    } catch (err) {
      if (err?.code !== 'ELOCKTIMEOUT') throw err;
      // proposedContent is append-ready root-log bytes (the custom log line).
      conflicts.push({
        key: 'log',
        target: 'log.md',
        reason: 'append-lock-timeout',
        kind: 'append',
        baseHash: null,
        currentHash: null,
        proposedContent: payload.log.entry,
      });
    }
  } else {
    // matchAll (not exec) mirrors deriveRootLogEntries: a payload that carried
    // more than one dated heading derives one canonical line each, symmetric with
    // the global path. Exact-line dedup on the heading keeps a second apply (or a
    // titleless vs titled same-day pair) from duplicating.
    const headingRe = new RegExp(`^#{1,6} \\[${date}\\]\\s*(.*)$`, 'gm');
    // A payload can carry more than one dated heading, and
    // each derives its OWN root-log block, the proof must cover every one,
    // not just the first, or a second heading's block could be missing from
    // the commit with nothing here to catch it.
    const derivedBlocks = [];
    try {
      const wroteAny = withFileLock(
        logFull,
        () => {
          let w = false;
          for (const m of (payload.sessionLog.entry || '').matchAll(headingRe)) {
            const { heading, block } = rootLogEntry(project, date, m[1]);
            derivedBlocks.push(block);
            const wrote = appendIfAbsent(logFull, block, (c) =>
              (c || '').split(/\r?\n/).includes(heading),
            );
            w = w || wrote;
          }
          return w;
        },
        { timeoutMs: APPEND_LOCK_TIMEOUT_MS },
      );
      (wroteAny ? applied : skipped).push('log (log.md, derived)');
      restageOrRecordLogMd(args, logFull, journal, wroteAny, acc);
      if (derivedBlocks.length > 0) {
        proofEntries.push({
          path: 'log.md',
          kind: 'append',
          expected: { entryBlocks: derivedBlocks },
        });
      }
    } catch (err) {
      if (err?.code !== 'ELOCKTIMEOUT') throw err;
      // `derived: true` discriminates this from the payload.log conflict above:
      // here proposedContent is the session-log entry to RE-DERIVE root-log lines
      // from (via rootLogEntry over its dated headings), NOT append-ready bytes.
      // Like every `kind: 'append'` conflict, this is NOT parked as an artifact —
      // it blocks the close and the next close re-derives + re-appends. The derived
      // shape only matters to the retry, never to T6's overwrite proposal store.
      conflicts.push({
        key: 'log',
        target: 'log.md',
        reason: 'append-lock-timeout',
        kind: 'append',
        derived: true,
        baseHash: null,
        currentHash: null,
        proposedContent: payload.sessionLog.entry,
      });
    }
  }
}

// T6: park drifted OVERWRITE targets as `.cache/proposals/` artifacts.
//
// Runs regardless of --json AND regardless of args.sessionId: writing the
// artifact is a SIDE EFFECT, not output, so it is conditioned on neither the
// report format nor a session context. (In practice an overwrite conflict only
// arises with a session id, so a session-less apply just finds no overwrite
// conflicts to park — but the loop is unconditional to match that contract.)
// Only overwrite conflicts (`kind !== 'append'`) become artifacts. An append
// conflict is a transient lock-timeout the NEXT close self-heals by
// re-appending; parking it as a whole-file artifact and later re-applying it
// (T7 replaces the whole target) would drop every OTHER entry in that
// append-only history file. Append conflicts still sit in `conflicts`, so the
// close still goes proposal-pending — they just get no artifact and no
// human-apply step.
// Human-readable park reason, keyed by `c.reason`. Add a line here for every
// new reason string a `conflicts.push(...)` call introduces (applyOverwrites,
// the append-lock-timeout sites below) — before this lookup existed, the report
// only branched on `c.kind === 'append'` and printed one fixed sentence
// ("the page changed since this session read it") for every other reason,
// which is a flat lie for `section-loss-guard`: nothing external changed
// there, the PAYLOAD dropped its own sections. A reason with no entry here
// falls through to the default below, worded to admit it does not know the
// cause rather than repeat a specific wrong one.
const CONFLICT_WHY = {
  'append-lock-timeout': () =>
    'could not acquire the append lock in time; the next close re-applies',
  'base-unknown': () =>
    'no base snapshot exists for this target for this session, so another writer could be sitting on disk with no way to tell',
  'base-hash-target-missing': () =>
    'the page changed since this session read it (it existed at base, and is missing now)',
  'base-mismatch': () => 'the page changed since this session read it',
  'base-mismatch-truncated-observation': () =>
    'the page changed since this session read it, and the last resume/compact only showed a truncated slice of it',
  'base-absent-target-exists': () =>
    'the page changed since this session read it (nothing existed at base, another writer created it since)',
  'target-unreadable': () =>
    'the target could not be read just now; failing safe rather than assuming it is unchanged',
  'will-overwrite-local-change': () =>
    'this session applied a payload to this target before, and the disk bytes have since changed (a hand edit, most likely): writing this payload now, unmodified or not, would silently discard that edit, because there is no way from here to tell a payload that folds the edit in from one that does not. A human must review the diff and approve it with `proposal challenge` / `proposal resolve` (`/hypo:crystallize` runs them for you), whether the payload already accounts for the edit or not',
  // This message used to end with "or set \"restructure\": true after confirming
  // with the user that dropping them is intended". That instruction stopped
  // being true the moment the flag stopped authorising the write, and a park
  // message that hands back a step which no longer lands the bytes is worse
  // than one that offers nothing. The two real ways out are below.
  'section-loss-guard': (c) =>
    `this payload drops ${c.lostSections.length} of ${c.diskSectionCount} \`##\` section(s) already on disk (${c.lostSections.join(', ')}). The page did not change, and the payload did not carry those sections forward. Either add the missing sections back into the payload, or, if dropping them is intended, have a human approve the parked write with \`proposal challenge\` / \`proposal resolve\` (\`/hypo:crystallize\` runs them for you). Setting "restructure": true records that intent for the reviewer; it does not land the write`,
  // `restructure: true` used to let this write straight through, a
  // model-set boolean approving its own destructive overwrite, with no human in
  // the loop. It still parks, exactly like the unset case above; the only
  // difference is this message, which tells the reviewing human the payload
  // author already claims the drop is intentional.
  'section-loss-guard-restructure-pending': (c) =>
    `this payload drops ${c.lostSections.length} of ${c.diskSectionCount} \`##\` section(s) already on disk (${c.lostSections.join(', ')}) and set "restructure": true. The payload's own claim is not authority to drop them. A human must review the diff and approve it with \`proposal challenge\` / \`proposal resolve\` (\`/hypo:crystallize\` runs them for you) before this write lands`,
};

export function conflictWhy(c) {
  const fn = CONFLICT_WHY[c.reason];
  if (!fn) return `unrecognized park reason "${c.reason}" — cause not determined`;
  // An entry reads whatever fields its own reason carries, and the section-loss
  // one needs two the others never set. That was harmless while this only fed
  // the text report; the JSON close path now calls it for every conflict, so a
  // future reason pushed without the fields its entry expects would throw
  // mid-close and take the whole apply with it. The explanation is the least
  // important thing happening here: degrade to the raw reason rather than lose
  // the close over a message.
  try {
    return fn(c);
  } catch {
    return `${c.reason} (details unavailable)`;
  }
}

function parkOverwriteConflicts(args, conflicts) {
  const proposals = [];
  const proposalStoreFailures = [];
  const device = currentDevice();
  for (const c of conflicts) {
    if (c.kind === 'append') continue; // append conflicts are never parked (see above)
    try {
      const saved = writeProposal(args.hypoDir, {
        target: c.target,
        baseHash: c.baseHash,
        currentAtProposalHash: c.currentHash,
        proposedContent: c.proposedContent, // internal (pre-drop) full page bytes
        sessionId: args.sessionId, // may be null; writeProposal coerces it
        device,
        // The same human-readable cause the JSON result's conflicts[].why now
        // carries (buildCloseResult) — stored here too because a proposal
        // artifact outlives this close's own stdout, and `hypomnema proposal
        // list`/`apply` reads only the artifact, never this run's JSON. Without
        // it, the reviewer sees the raw `reason` code and nothing else (codex
        // 3rd-pass finding: the park-reason wording fix never reached this file).
        parkReason: conflictWhy(c),
        // Section-loss detail: only meaningful for those two reasons, so only
        // sent for them. An absent field on every other conflict is the correct
        // shape, not a gap.
        ...(c.reason === 'section-loss-guard' ||
        c.reason === 'section-loss-guard-restructure-pending'
          ? { lostSections: c.lostSections, diskSectionCount: c.diskSectionCount }
          : {}),
      });
      proposals.push({ id: saved.id, target: saved.target, path: saved.path });
      // Supersede-delete failure is NON-fatal: the new artifact IS parked, only
      // a stale sibling lingers (superseded next close). Surface it, don't fail.
      for (const w of saved.supersedeWarnings) {
        process.stderr.write(`\n⚠️  ${w} (stale artifact left behind, not fatal)\n`);
      }
    } catch (err) {
      // fail-loud: the target was withheld AND its bytes are now on neither disk
      // NOR a proposal artifact — a genuine data-loss risk. Never swallow this.
      const error = (err && err.message) || String(err);
      proposalStoreFailures.push({ target: c.target, key: c.key, error });
      process.stderr.write(
        `\n🛑 PROPOSAL STORE FAILED for ${c.key} (${c.target}): ${error}\n` +
          `    This close WITHHELD the target (${conflictWhy(c)}) but\n` +
          `    could NOT write the .cache/proposals/ artifact either. The payload bytes\n` +
          `    are on NEITHER disk NOR a proposal — re-run the close once the .cache/\n` +
          `    directory is writable so the withheld content is not lost.\n`,
      );
    }
  }
  return { proposals, proposalStoreFailures };
}

// B-4 auto-register: lift unknown (non-forbidden) tags surfaced by the PREFLIGHT
// lint into SCHEMA.md's `### Pending` section so the post-apply lint sees them as
// known and the close never stalls on a vocabulary gap. The W10 id is hidden in
// non-strict --json output (lint.mjs toOut), so the unknown-tag warns are matched
// and the tag extracted from the message string itself — kept in lockstep with
// lint.mjs's W10 emit (a copy-edit there breaks this; the close-path round-trip
// test guards it). Forbidden patterns stay hard errors and are filtered out.
// SCOPE (eventual consistency, intended): this registers PRE-EXISTING wiki debt
// visible at preflight, NOT a novel tag this very close's payload introduces —
// that one would surface only at post-apply and lands on the NEXT close. The
// contract is "must not stall", which warns (not errors) already satisfy; the
// registration just keeps the vocabulary catching up.
// The capture is anchored on the FULL message suffix (not `[^"]+`) so a tag that
// itself contains a `"` — non-forbidden, so reachable — is captured whole rather
// than truncated at its first quote (codex stage-2 CONCERN).
const unknownTagRe = /^Unknown tag: "(.+)" \(not in SCHEMA\.md Tag Vocabulary\)/;

// W9 (invalid-YAML frontmatter) is warn-severity in lint.mjs's default,
// non-strict classification, and its `id` is stripped from the --json warns
// this apply reads (only W8 survives toOut without --strict, see lint.mjs).
// Matched by its fixed message prefix instead, same technique as
// unknownTagRe above. Shared by runPreflight's append-target legacy-debt
// check and runPostApplyLint's payload-scope promotion below.
const INVALID_YAML_WARN_RE = /^Invalid YAML frontmatter: /;

// SCHEMA.md registration is called from INSIDE runMarkerPhase's
// vault-commit lock, once `ok` is already settled, right before the commit
// that follows it, never at its old call site (before postApplyLint even
// ran). Registering earlier used to mutate SCHEMA.md on a close that was
// still going to fail (or park a conflict): the file changed, uncommitted,
// on a run whose whole point was to write nothing.
//
// Also requires SCHEMA.md to be CLEAN against HEAD (not dirty, not
// untracked) before touching it: a dirty SCHEMA.md may be someone else's
// uncommitted edit, and layering a registration onto it would (a) fold
// their bytes into THIS close's commit with no proof entry covering them,
// and (b) make the registration itself uncommitted right alongside it.
// Deferring costs nothing: the tag stays a non-blocking unknown-tag warn
// until a later close finds SCHEMA.md clean.
function registerPendingTagsLocked(
  args,
  preflightLint,
  hasConflicts,
  appliedPaths,
  proofEntries,
  attemptId,
) {
  const schemaPath = join(args.hypoDir, 'SCHEMA.md');
  if (!existsSync(schemaPath)) return;

  // Retry restage: a PRIOR attempt at this SAME close already
  // registered pending tags into SCHEMA.md and left the write uncommitted
  // (the commit that was supposed to land it failed, or the process died
  // between the write and the commit). Once those tags sit in the file,
  // `preflightLint` below no longer flags them as unknown at all, so the
  // normal registration path never even sees them again. Without this check
  // that dirty SCHEMA.md would sit unexplained forever, deferred every close
  // for a reason the SESSION ITSELF already resolved. A byte-for-byte match
  // against the recorded side effect is what tells "my own unfinished write"
  // apart from someone else's unrelated edit landing on the same file in the
  // meantime; only the first restages.
  let disk;
  try {
    disk = readFileSync(schemaPath);
  } catch {
    disk = null;
  }
  if (disk) {
    const priorSchema = readCloseIntentSideEffects(args.hypoDir, args.sessionId).find(
      (e) => e && e.path === 'SCHEMA.md' && e.kind === 'schema-pending',
    );
    if (priorSchema && bytesSha256(disk) === priorSchema.bytesSha256) {
      appliedPaths.push('SCHEMA.md');
      proofEntries.push({
        path: 'SCHEMA.md',
        kind: 'schema-pending',
        expected: { tags: priorSchema.tags },
      });
      return;
    }
  }

  const pendingTags = [];
  for (const w of preflightLint.warns || []) {
    const m = unknownTagRe.exec(w.message || '');
    if (m && !checkForbidden(m[1])) pendingTags.push(m[1]);
  }
  if (pendingTags.length === 0 || hasConflicts) return;
  const diffRes = spawnSync('git', [
    '-C',
    args.hypoDir,
    'diff',
    '--quiet',
    'HEAD',
    '--',
    'SCHEMA.md',
  ]);
  if (diffRes.error || diffRes.status !== 0) return; // dirty vs HEAD, or no HEAD yet: defer
  const statusRes = spawnSync(
    'git',
    ['-C', args.hypoDir, 'status', '--porcelain', '--', 'SCHEMA.md'],
    { encoding: 'utf-8' },
  );
  if (statusRes.error || /^\?\?/.test((statusRes.stdout || '').trim())) return; // untracked: defer
  const result = appendPendingTags(args.hypoDir, pendingTags);
  if (result.tags.length > 0 && typeof result.content === 'string') {
    appliedPaths.push('SCHEMA.md');
    proofEntries.push({
      path: 'SCHEMA.md',
      kind: 'schema-pending',
      expected: { tags: result.tags },
    });
    recordCloseIntentSideEffect(args.hypoDir, args.sessionId, attemptId, {
      path: 'SCHEMA.md',
      kind: 'schema-pending',
      bytesSha256: bytesSha256(result.content),
      tags: result.tags,
    });
  }
}

// Post-apply lint: payload may have introduced a malformed body or
// bad frontmatter. Surface as a distinct `stage` so caller can tell "lint
// broke" apart from "frontmatter stale". This runs even if the freshness gate
// also failed — both failure modes are useful to the caller.
function runPostApplyLint(args, payloadScope) {
  let postApplyLint;
  let postApplyCrashed = false;
  try {
    postApplyLint = runLint(args.hypoDir);
  } catch (e) {
    // A lint crash (unparseable output) after writes is NOT scopeable — there is
    // no reliable `file` to classify — and must stay a HARD failure, exactly as
    // before scoping was introduced.
    postApplyCrashed = true;
    postApplyLint = {
      ok: false,
      errors: [{ file: '(lint crash)', message: e.message }],
      warns: [],
    };
  }

  // Scope post-apply lint to payload files (Bug B): a payload-introduced error
  // lands in a file this apply wrote, so it blocks; pre-existing debt elsewhere
  // is a non-blocking notice. A lint crash bypasses scoping and blocks outright.
  let postBlocking;
  let postNotice;
  if (postApplyCrashed) {
    postBlocking = postApplyLint.errors;
    postNotice = [];
  } else {
    const { blocking: errBlocking, notice: errNotice } = partitionLintScope(
      postApplyLint.errors || [],
      payloadScope,
    );
    // W9 promotion (codex pre-commit review): invalid-YAML frontmatter is
    // warn-severity, not error, in lint.mjs's default classification, so it
    // never reached `errors` above without an operator opting into --strict.
    // A wiki with no --lint-strict pre-commit hook installed could then reach
    // ok:true and exit 0 with corrupt frontmatter sitting in a file this very
    // close just wrote. Promote it here to a close-blocking finding, but ONLY
    // inside payloadScope: this partition is the single source of "this
    // close's own neighborhood" already used for errors above, so a W9 warn
    // anywhere else in the vault (this repo's own maintainer vault carries
    // one, under pages/feedback/) is discarded outright below and never
    // folded into `postNotice` either. That is untouched, not merely
    // non-blocking, matching runPreflight's identical scope contract for the
    // append-target legacy-debt case above. W1 (no-frontmatter) is
    // deliberately NOT promoted here: a legacy vault's frontmatter-less
    // log.md is the documented shape --strict itself exempts, and this close
    // path must keep accepting it.
    const w9Blocking = partitionLintScope(
      (postApplyLint.warns || []).filter((w) => INVALID_YAML_WARN_RE.test(w.message || '')),
      payloadScope,
    ).blocking;
    postBlocking = [...errBlocking, ...w9Blocking];
    postNotice = errNotice;
  }
  const postLintOk = !postApplyCrashed && postBlocking.length === 0;
  return { postApplyLint, postBlocking, postNotice, postLintOk };
}

// Amendment 2026-05-19: auto-write the per-session
// closed marker on a verified close. Hook authority is read-only; this is
// one of the two writer paths (the other is --mark-session-closed standalone).
//
// The marker write is governed by the SAME gate as standalone
// --mark-session-closed and /compact (precompactGateStatus), NOT just apply's
// `ok` + git-clean. Apply's payload preflight/post-apply lint and `ok` still
// govern apply SUCCESS (exit code below), but the marker must additionally
// clear feedback projection / W8 design-history / hot.md structure, else this
// path could issue a marker the standalone path would refuse (the second
// divergence codex flagged).
//
// Apply just wrote the payload, so the tree is dirty by its OWN
// writes: the gate's `uncommitted` git blocker would always trip and the
// marker would be skipped, deferring the close to a manual --mark-session-closed
// ("done but still blocked" regression). Commit the payload HERE, via
// the SAME .hypoignore-aware helper the auto-commit Stop hook uses, so the gate sees
// a committed tree. Push stays deferred to the Stop hook; the resulting
// committed-but-unpushed state is a gate notice, not a blocker, so
// this still marks. A commit failure (not a repo / pre-commit reject / git error)
// skips the marker WITH a surfaced reason — today's behavior was also "no marker",
// but silently.
//
// Returns { markerWritten, markerSkipReason, commitOutcome }. `commitOutcome` is
// reported by the result JSON: `null` when this apply never reached the commit
// step at all (ok:false before the writes were even verified), distinct from a
// commit that ran and reported `committed:false`.
// Which undo advice this run has earned, or null when it left nothing to undo
// and so nothing to warn about. The hostTagWarning used to hang off `ok`,
// which got it backwards on the one path that matters most: 'marker-did-not-
// land' flips `ok` to false AFTER the payload is already committed, so a close
// that may not reflect the user's decision sat in the vault's history with the
// warning suppressed. What the warning is actually about is "this run put
// something on disk you may want back", so that is the condition it reads.
function hostTagUndoKind({ committed, markerWritten, wroteBytes }) {
  if (committed) return markerWritten ? 'commit-and-marker' : 'commit-only';
  return wroteBytes ? 'uncommitted-writes' : null;
}

// commitWikiChanges' own `sha` field collapses two different histories to
// the same falsy value: a real `scoped: 0` no-op (nothing was ever staged,
// so the field is `undefined`) and a REAL commit whose `rev-parse HEAD`
// afterwards failed (the field is `null`, per commitWikiChanges' own doc
// comment). hostTagWarningWithUndo needs those told apart: `null` says
// "nothing to revert", `undefined` says "a commit exists, look it up
// yourself", and `commitOutcome.sha` alone cannot tell them apart, since
// both land on a value that reads as "no sha". `scoped === 0` is the only
// signal that actually distinguishes them: it is `0` on the no-op path and
// a positive count on the failed-rev-parse path, regardless of what `sha`
// itself holds.
//
// MAJOR fix: this function used to return `commitOutcome.sha` verbatim on
// the `scoped !== 0` branch, so a real commit with a null `sha` (the
// failed-rev-parse case) fell through unchanged and hostTagWarningWithUndo
// read it exactly like the true no-op, "nothing needs reverting", for a
// commit that had, in fact, just landed. `?? undefined` is what remaps that
// one case: `sha` a string passes through untouched, `sha: null` (the only
// other value `commitWikiChanges` ever returns here) becomes `undefined` so
// the caller gets the honest "look it up yourself" wording instead of a
// false "there is nothing here".
export function commitShaForUndo(commitOutcome) {
  if (!commitOutcome) return undefined;
  if (commitOutcome.scoped === 0) return null;
  return commitOutcome.sha ?? undefined;
}

// `git rev-parse --show-toplevel` / `--show-prefix`, for the receipt's
// `repo` field. `null` on any git failure: the receipt writer treats a
// missing repo identity the same as any other reason not to issue one.
function repoIdentity(hypoDir) {
  const top = spawnSync('git', ['-C', hypoDir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
  });
  if (top.error || top.status !== 0) return null;
  const toplevel = (top.stdout || '').trim();
  if (!toplevel) return null;
  const pfx = spawnSync('git', ['-C', hypoDir, 'rev-parse', '--show-prefix'], {
    encoding: 'utf-8',
  });
  const prefix = !pfx.error && pfx.status === 0 ? (pfx.stdout || '').trim() : '';
  return { toplevel, prefix };
}

function runMarkerPhase(args, project, appliedPaths, ok, hostTagWarning, receiptCtx = {}) {
  const {
    preflightLint = null,
    hasConflicts = false,
    proofEntries = [],
    attemptId = null,
  } = receiptCtx;
  let markerWritten = false;
  let markerSkipReason = null;
  let markerGateReason = null;
  let commitOutcome = null;
  let receiptMismatches = null;
  // What the gate waved through on the way to the marker. The demotions are
  // only honest if the operator can see them, and this is the path that runs
  // on a real close: `--mark-session-closed` already reported them, while
  // `--apply-session-close` dropped them on the floor.
  let gateNotices = [];
  if (ok && args.sessionId) {
    // IO stays lazy so this preserves the exact side-effect order (codex design
    // review): commit first (the only mutation), then resolve the
    // transcript, then run the compact gate with that transcript, then scan the
    // user-close signal ONLY once the gate passes. planMarkerDecision owns the
    // branch priority + reason strings; the booleans below are computed in that
    // same short-circuiting order so no read runs earlier than it does today.
    // Scope this commit to the paths THIS apply actually wrote
    // (appliedPaths), never the broader payloadScope, which also
    // names lint/evidence candidates apply may not have touched a byte of.
    // Locked against the SAME target the auto-commit Stop hook holds, so a
    // concurrent Stop-chain commit on this vault can't interleave with this
    // apply's stage+commit. A lock-timeout is treated exactly like any other
    // commit failure below (skip the marker, surface the reason) rather than
    // crashing the apply.
    //
    // registerPendingTagsLocked runs INSIDE this same lock, right before the
    // commit: a SCHEMA.md registration it makes here
    // pushes 'SCHEMA.md' onto `appliedPaths` first, so commitWikiChanges below
    // picks it up in the SAME commit this apply is already making, atomically.
    // The HEAD read happens in this same critical section too, never a
    // second, unlocked `git rev-parse HEAD` afterwards, which a concurrent
    // close landing in the gap could move.
    let headAfterCommit = null;
    try {
      const locked = withFileLock(vaultCommitLockTarget(args.hypoDir), () => {
        registerPendingTagsLocked(
          args,
          preflightLint,
          hasConflicts,
          appliedPaths,
          proofEntries,
          attemptId,
        );
        const outcome = commitWikiChanges(args.hypoDir, appliedPaths);
        const head = readHeadShaLocked(args.hypoDir);
        return { outcome, head };
      });
      commitOutcome = locked.outcome;
      headAfterCommit = locked.head;
    } catch (err) {
      commitOutcome = { committed: false, reason: `vault-commit-lock: ${err?.message || err}` };
    }
    // Once these bytes are committed, the journal's only job (telling a
    // retry's own uncommitted work apart from someone else's) is done —
    // clear it rather than let a stale record outlive this close and later
    // match a coincidence it was never meant to license. A commit that
    // failed leaves the journal in place on purpose: that is exactly the
    // case the next retry needs it for.
    if (commitOutcome.committed) clearJournal(args.hypoDir, args.sessionId);
    let closeTranscript = null;
    let gateOk = false;
    // verified_scope evidence (session-close-scope-boundary spec §3, revised
    // 2026-09-07): the set the gate below actually put a row for, filled in
    // once the gate below runs. Stays [] on any path that never reaches it
    // (uncommitted, no transcript) — normalizeVerifiedScope drops an empty
    // 'global' scope to "field absent" rather than persist a false claim.
    let gateEvaluatedProjects = [];
    let gateSkipped = { lint: false, feedback: false };
    if (commitOutcome.committed) {
      closeTranscript = resolveTranscriptBySessionId(args.sessionId);
      // closeScope: apply KNOWS which project it just closed, and it wrote
      // that project's files from inside this process, they never appear in the
      // transcript as Edit/Write, so `payload.project` is the only signal that puts
      // this close in scope. Without it, apply's own incomplete close could be demoted
      // to a foreign-debt notice and marked green.
      //
      // attributionScope (session-close-scope-boundary spec §2/§3): the same
      // `payload.project` signal, resolved through the shared validator. apply's
      // launch cwd can differ from payload.project (a supported cross-project
      // close), so unlike PreCompact/Stop there is no cwd to fall back on here,
      // and passing one would risk narrowing to the wrong project. Passed as
      // `attributionScope`, never `projectOverride` — this is closeScope's own
      // project already, so it changes nothing about which projects end up in
      // scope, but it is what turns the mine/foreign partition ON: with
      // `projectOverride` the gate would also narrow sessionCloseGlobalStatus to
      // `project` alone, going green on a foreign project's incomplete close
      // instead of demoting it to a notice.
      const autoMarkerOverride = resolveGateProjectOverride(args.hypoDir, { project });
      const gateStatus = precompactGateStatus(args.hypoDir, {
        closeScope: [project],
        ...(closeTranscript ? { transcriptPath: closeTranscript } : {}),
        ...(autoMarkerOverride ? { attributionScope: autoMarkerOverride } : {}),
        // This is one of the two marker-writing paths that must share ONE
        // `ok` invariant with `--mark-session-closed`. checkpointMode narrows the git axis to "is
        // there an uncommitted write THIS session still owns" instead of
        // refusing on any unattributed dirty root file; every other axis
        // (close files, cwd, hot, lint, W8, feedback) is unchanged.
        checkpointMode: true,
        sessionId: args.sessionId,
      });
      gateOk = gateStatus.ok;
      gateNotices = gateStatus.notices || [];
      gateSkipped = gateStatus.skipped || gateSkipped;
      // `closeScope` above widens the partition, it never narrows
      // sessionCloseGlobalStatus (only opts.projectOverride does, and this
      // call never sets it) — so gate.close.projects is the actual evaluated
      // set, not necessarily just `[project]`.
      gateEvaluatedProjects = (gateStatus.close.projects || [])
        .map((p) => p.project)
        .filter(Boolean);
    }
    const decision = planMarkerDecision({
      ok,
      hasSessionId: true,
      committed: commitOutcome.committed,
      commitReason: commitOutcome.reason,
      gateOk,
      transcriptResolved: !!closeTranscript,
      // Scan the signal only when the gate passed AND a transcript resolved —
      // isCloseGateOpen never runs earlier than the original nested `else if`.
      // Reads the raw walkCloseGate open, not closeGateStatus: closeGateStatus
      // would also weigh this session's recorded resolution, and the
      // resolution below is now written ONLY once the marker itself lands
      // (this change). A retry after a withheld marker (dirty wiki, a
      // failed commit, a lock timeout) has no resolution recorded yet, but it
      // still needs THIS check to see the transcript's existing close phrase
      // as authorization, not a fresh one. This field asks a narrower
      // question than closeGateStatus answers: "did the transcript carry a
      // close signal", not "is this apply itself still authorized to run at
      // all" (verifyCloseAuthority already settled that, before any byte was
      // written).
      hasUserSignal: gateOk && !!closeTranscript && isCloseGateOpen(closeTranscript),
    });
    markerSkipReason = decision.skipReason;
    // MAJOR FIX (codex cross-review round 5): the marker phase reads the raw
    // walkCloseGate boolean above (`hasUserSignal`) on purpose: see that
    // field's own comment for why closeGateStatus's resolution-aware answer
    // would be the wrong question here. That deliberate choice is exactly why
    // this path had no access to WHICH tag, if any, retracted the close: the
    // boolean alone cannot say. Compute closeGateStatus's reason string
    // separately, purely for diagnostics, only on the branch that actually
    // withheld the marker for lack of a signal: `!open` is guaranteed true
    // here too (same transcript, same walk), so closeGateStatus's resolution
    // check never runs and this cannot silently change `decision` above.
    if (markerSkipReason === 'no-user-close-signal' && closeTranscript) {
      markerGateReason = closeGateStatus({
        transcriptPath: closeTranscript,
        hypoDir: args.hypoDir,
        sessionId: args.sessionId,
      }).reason;
    }
    if (decision.write) {
      // apply KNOWS its authoritative payload.project — stamp it as the v4
      // evidence set so PreCompact trusts this marker's scope directly (session-close attribution).
      // verified_scope (revised 2026-09-07): `closeScope: [project]` above
      // widens resolveCloseScope's partition, it does not narrow
      // sessionCloseGlobalStatus — only opts.projectOverride does, and this
      // call never sets it. The gate ran unnarrowed, so `kind` is 'global',
      // with `projects` the set gate.close actually evaluated
      // (gateEvaluatedProjects), never `[project]` verbatim.
      // The marker is only ever written on a run whose commit already landed
      // (that commit is a precondition of reaching here), so the copy stored
      // in the marker is the one that can honestly name both halves of the
      // undo: revert that commit, and delete this file.
      // commitShaForUndo(commitOutcome) here is a string (the commit that
      // just landed above) or `null` (this round's scope was `scoped: 0`,
      // so there is nothing to revert). Never `undefined`: the commit
      // already ran by this point, so "caller did not say" would be a
      // worse answer than the real one this call already has.
      const markerHostTagWarning = hostTagWarningWithUndo(
        hostTagWarning,
        'commit-and-marker',
        args.hypoDir,
        args.sessionId,
        commitShaForUndo(commitOutcome),
      );
      // Certify the close BEFORE writing the compat marker.
      // `commitOutcome.sha` is unset on a `scoped: 0` no-op (nothing this
      // apply wrote needed a fresh commit: every target was already
      // current), so C falls back to the HEAD this same lock read a moment
      // ago.
      const commitSha = commitOutcome.sha || headAfterCommit;
      const repo = commitSha ? repoIdentity(args.hypoDir) : null;
      if (commitSha && repo) {
        const verify = verifyEntriesInCommit(args.hypoDir, commitSha, proofEntries);
        if (verify.ok) {
          const receiptGeneration = randomBytes(16).toString('hex');
          const receipt = {
            schemaVersion: RECEIPT_SCHEMA_VERSION,
            certification: CERT_CHECKPOINT,
            generation: receiptGeneration,
            sessionId: args.sessionId,
            repo,
            commit: commitSha,
            // The project this apply proved, not the wider set the gate
            // evaluated: the entries above prove only this project's files.
            // The marker's verified_scope below still records the evaluated set.
            scope: { mode: 'project', projects: [project] },
            entries: proofEntries,
            skipped: gateSkipped,
            createdAt: new Date().toISOString(),
          };
          // Receipt, then marker, and the receipt comes back out if the marker
          // does not land (see landReceiptThenMarker). The writer swallows IO
          // errors (best-effort), so the helper checks the file actually
          // landed instead of this path asserting markerWritten=true: a
          // .cache permission/disk problem must surface rather than the
          // caller reporting "closed" while the next Stop re-blocks. That
          // check decides whether the close signal below gets spent, and
          // spending it on a marker this run did not write is the failure
          // this whole phase was reordered to avoid.
          const landed = landReceiptThenMarker(args.hypoDir, args.sessionId, receipt, () =>
            writeSessionClosedMarker(args.hypoDir, args.sessionId, {
              project,
              projects: [project],
              verifiedScope: { kind: 'global', projects: gateEvaluatedProjects },
              // Carried through from refuseUnlessCloseRequested's gate check,
              // computed once before any write in this apply and unchanged since:
              // this close survived a HOST_TAG_NAMES-shaped queue item reading as
              // neutral, so the marker records the same residual the console
              // output also warns about once.
              ...(markerHostTagWarning ? { hostTagWarning: markerHostTagWarning } : {}),
              // Names the receipt this marker is a compat projection
              // of. A new Stop refuses to trust this marker alone once it sees
              // this field: it must find the matching, valid receipt too.
              receiptGeneration,
            }),
          );
          if (landed.ok) {
            markerWritten = true;
            // Close-gate resolution: record it here, ONLY now that the RECEIPT
            // has landed (a close approval is spent only after the receipt
            // lands), not merely once the compat marker exists.
            // Recording it earlier used to sit right after `ok && args.sessionId`,
            // ahead of commit, gate, and marker entirely, on the theory that the
            // wiki writes already happened so the resolution should stick
            // regardless. That let a run which committed the payload but then
            // had its marker withheld (compact-gate-not-ok on a dirty wiki, a
            // lock timeout, a disk failure) burn the session's one close signal
            // anyway: the next run hit closeGateStatus's
            // `no-new-open-since-resolution` and refused, with no marker ever
            // written and no way back short of a brand-new user close phrase.
            // Tying the record to a landed receipt+marker means a withheld one
            // leaves the signal untouched, so a retry (once the wiki is clean,
            // the proof mismatch is fixed, or the transient failure clears) is
            // still authorized by the same close phrase. `closeTranscript` is
            // reused here rather than re-resolved: `decision.write` can only be
            // true when `transcriptResolved` was true in `planMarkerDecision`'s
            // inputs above, so it is guaranteed non-null at this point.
            //
            // Best-effort like every other write in this store: resolutionStamp
            // returns null on anything it cannot read as a Buffer, recordGateClosed
            // refuses a null stamp, and both fail silently, so a transcript that
            // vanishes mid-read (or a cache-write failure) can never turn an
            // otherwise-successful close into a failure.
            try {
              recordGateClosed(
                args.hypoDir,
                args.sessionId,
                resolutionStamp(readFileSync(closeTranscript)),
              );
            } catch {
              // Unreadable at the moment of a successful close is not this
              // apply's problem to surface, the resolution just stays
              // unrecorded, same as if this session had never resolved at all
              // (NO_CONSTRAINT).
            }
          } else if (landed.reason === 'receipt-write-failed') {
            markerSkipReason = 'receipt-write-failed';
            receiptMismatches = [
              { path: '(receipt)', reason: landed.writeReason },
              ...(landed.retractFailed
                ? [{ path: '(receipt)', reason: `retract-failed: ${landed.retractFailed}` }]
                : []),
            ];
          } else {
            markerSkipReason = 'marker-did-not-land';
            // The receipt was withdrawn. Only when even that failed is there
            // something to report beside the stage, because a valid receipt is
            // then left standing behind a run that exits 1.
            if (landed.retractFailed) {
              receiptMismatches = [
                { path: '(receipt)', reason: `retract-failed: ${landed.retractFailed}` },
              ];
            }
          }
        } else {
          markerSkipReason = 'receipt-proof-mismatch';
          receiptMismatches = verify.mismatches;
        }
      } else {
        markerSkipReason = 'receipt-proof-mismatch';
        receiptMismatches = [{ path: '(commit)', reason: 'no-commit-identity' }];
      }
    }
  }
  return {
    markerWritten,
    markerSkipReason,
    markerGateReason,
    commitOutcome,
    gateNotices,
    receiptMismatches,
  };
}

// A conflict outranks the downstream gates: verification and lint both describe
// a tree this apply declined to finish writing, so naming them would point the
// reader at the wrong repair. A proposal-STORE failure outranks even that: the
// withheld bytes never reached an artifact, so it is the most urgent repair.
function resolveCloseStage({ ok, proposalStoreFailed, conflicts, verification, postLintOk }) {
  return ok
    ? null
    : proposalStoreFailed
      ? 'proposal-store-failed'
      : conflicts.length > 0
        ? 'proposal-pending'
        : !verification.ok && !postLintOk
          ? 'post-apply-verification+lint'
          : !verification.ok
            ? 'post-apply-verification'
            : 'post-apply-lint';
}

// The stdout JSON contract of a payload-bearing apply. Takes one bag because it
// genuinely consumes the whole settled close state; every field below is read
// straight off it.
function buildCloseResult({
  ok,
  stage,
  project,
  date,
  applied,
  skipped,
  commitOutcome,
  conflicts,
  proposals,
  proposalStoreFailed,
  proposalStoreFailures,
  parkedTotal,
  parkedUnreadable,
  parkedOrphanTmp,
  verification,
  sessionId,
  markerWritten,
  markerSkipReason,
  markerGateReason,
  receiptMismatches,
  preflightLint,
  postApplyLint,
  closeScopeNotice,
  otherDebtCount,
  gateNotices,
  restructureWaivers,
  obsoleteNotices,
  hostTagWarning,
}) {
  return {
    ok,
    stage,
    project,
    date,
    applied,
    skipped,
    // Was the general-shape sibling of the two early-refusal `committed:null`
    // fields (no-user-close-signal / session-id-mismatch), which this path never
    // carried before: a reader of `applied:[]` on a no-op re-run had no
    // `committed` value to check against and no way to tell it apart from a run
    // that never reached the commit step. `null` here means exactly that: `ok`
    // came back false before the commit ever ran (see `stage` for which check
    // failed: post-apply-verification, post-apply-lint, or proposal-pending). It
    // does NOT mean nothing was written — an overwrite/append can already be on
    // disk (see `applied` / `appliedUncommitted`) while `committed` stays `null`.
    // `true` covers both an actual commit and the legitimate "nothing to stage"
    // no-op (commitWikiChanges' own contract, see hooks/hypo-shared.mjs); `false`
    // is a real commit failure, surfaced together with markerSkipReason below.
    committed: commitOutcome ? commitOutcome.committed : null,
    // Targets withheld: an overwrite drifted from this session's observed base, or
    // an append could not take the file lock in time (`kind: 'append'`). Two
    // channels resolve these, and `proposals` vs `conflicts[].kind` are the sole
    // discriminators: an OVERWRITE conflict is parked as a `.cache/proposals/`
    // artifact (below) for a human to review and re-apply; an APPEND conflict gets
    // NO artifact and is re-tried automatically by the next close. `proposedContent`
    // is dropped from the reported shape either way (the artifact / the next close
    // holds the bytes; a whole page or an append entry does not belong in the JSON).
    // `why` is the human-readable cause (conflictWhy), the same string
    // printCloseReport already prints in the non-JSON path — a `--json` close
    // used to carry only the raw `reason` code here, so the caller had no prose
    // to surface and the fix to conflictWhy's wording never reached a `--json`
    // close (which is how every real close runs; printCloseReport is a path a
    // normal apply never takes).
    conflicts: conflicts.map((c) => {
      const { proposedContent: _drop, ...rest } = c;
      return { ...rest, why: conflictWhy(c) };
    }),
    // Parked overwrite proposals (id/target/path), one per drifted overwrite
    // target. Empty when only append conflicts (or none) occurred. The T7 CLI
    // lists and applies these; append conflicts never appear here.
    proposals,
    ...(proposalStoreFailed ? { proposalStoreFailures } : {}),
    // Vault-wide count of every parked write-proposal artifact (this close's own
    // new ones included), same visibility contract as `otherDebtCount` below:
    // always present so a caller cannot mistake a missing key for zero, and
    // never gated (a growing pile of parks is a review backlog, not a close
    // failure). `null` means the inventory itself could not be enumerated, not
    // that it is empty; see the comment where this is computed. A caller must
    // check for `null` before treating this as a count.
    parkedTotal,
    // Filenames under `.cache/proposals` that exist as `.json` candidates but
    // could not be parsed into an artifact (see the comment where this is
    // computed). Always present, possibly empty, never folded into
    // parkedTotal above, and never allowed to silently disappear the way it
    // did before this field existed.
    parkedUnreadable,
    parkedOrphanTmp,
    // Partial close: some overwrite direct-writes (and/or appends) already landed
    // on disk while at least one conflict withheld the rest. Because the close is
    // ok:false, commitWikiChanges + the marker are skipped — so those written
    // files sit on disk UNCOMMITTED until the conflict is resolved and the close
    // re-runs. Named honestly: `appliedUncommitted` covers every write that landed
    // (overwrite or append), not overwrites alone.
    ...(applied.length > 0 && conflicts.length > 0
      ? { partialConflict: true, appliedUncommitted: [...applied] }
      : {}),
    verification,
    // Surface the marker outcome instead of skipping silently, so the
    // caller can tell "closed" from "applied but not marked". `markerGateReason`
    // (MAJOR FIX, codex cross-review round 5) is closeGateStatus's own reason
    // string, present only when `markerSkipReason` is 'no-user-close-signal'.
    // The raw-boolean decision this phase actually acts on (see runMarkerPhase's
    // `hasUserSignal` comment) stays unchanged; this only adds the diagnostic a
    // maintainer needs to tell a stale HOST_TAG_NAMES allowlist apart from an
    // ordinary retraction, the same detail verifyCloseAuthority's own
    // `gateReason` already carries for the earlier, whole-apply refusal.
    ...(sessionId
      ? {
          markerWritten,
          markerSkipReason,
          ...(markerGateReason ? { markerGateReason } : {}),
          // Present only when markerSkipReason is 'receipt-proof-mismatch'
          // or 'receipt-write-failed': the entries that failed to verify against
          // the commit, or the single reason the receipt write itself failed.
          ...(receiptMismatches ? { mismatches: receiptMismatches } : {}),
        }
      : {}),
    lint: {
      preflight: summarizeLintForOutput(preflightLint),
      postApply: summarizeLintForOutput(postApplyLint),
    },
    // Pre-existing lint debt in files this close did not author: surfaced for
    // visibility, never gated. Empty on a clean vault. Scoped to the close-target
    // project's own dir — debt under projects/<project>/ is this close's
    // neighborhood and stays listed; debt elsewhere (other projects, shared
    // pages, root files) folds into otherDebtCount so the same untouched-file
    // debt does not re-list its filenames on every close (run `node
    // scripts/lint.mjs` for the full list).
    // Obsolete-field lines lead, then the lint-debt filenames. The two share
    // this array because both mean "read this, nothing is blocked on it", and a
    // reader that expected only filenames still gets a string it can print.
    notices: [...(obsoleteNotices || []), ...new Set(closeScopeNotice.map((e) => e.file))],
    otherDebtCount,
    // Separate from `notices` above, which is lint debt. These are the close
    // GATE's demotions: what it declined to block on. `--mark-session-closed`
    // has always reported them and this path did not, so a demotion on the
    // canonical close path was invisible — the gate's promise is that it never
    // waves something through silently, and half the paths were breaking it.
    // A new key rather than a merge into `notices`, whose entries are filename
    // strings that an existing reader would choke on if they became objects.
    gateNotices: gateNotices || [],
    // Always present (possibly empty), same visibility contract as `notices`/
    // `otherDebtCount` above — a caller should not have to guess whether the
    // key's absence means "none" or "this apply predates the field". One entry
    // per overwrite field where `restructure: true` was claimed on a REAL
    // section-loss trip (a field that carried the flag but never had a loss to
    // waive adds no entry here). The claim no longer applies the write:
    // the matching target is still in `conflicts` above, withheld
    // pending human approval via `proposal challenge`/`proposal resolve`; this
    // is only the audit trail of what the payload author asserted.
    restructureWaivers,
    // Present when this close survived a HOST_TAG_NAMES-shaped queue item
    // reading as neutral (see closeGateStatus's own field doc comment) AND
    // this run left something on disk to take back. NOT gated on `ok`: the
    // caller settled that question with hostTagUndoKind and passed null when
    // there was nothing to undo, which is what lets the warning still reach a
    // reader on 'marker-did-not-land' (committed, ok:false). This is the
    // `--json` half of the warn-once contract; printCloseReport below carries
    // the same string to the console path, and the marker (runMarkerPhase)
    // carries its own wording to a reader of that file after the fact. All of
    // them descend from ONE walk result computed before any write in this
    // apply, so there is one warning per run, not one per gate read.
    ...(hostTagWarning ? { hostTagWarning } : {}),
  };
}

// Where to send a person for doctor. Both forms, no runtime guess: the
// `hypomnema` bin comes only with the npm install, so a plugin-only user has
// `/hypo:doctor` and nothing else, and a shell user may have only the bin.
const DOCTOR_HINT =
  'doctor (`/hypo:doctor` in Claude Code, or `hypomnema doctor` with the npm CLI)';

// The human-readable (non --json) rendering of the same settled state.
function printCloseReport({
  project,
  date,
  applied,
  skipped,
  conflicts,
  proposals,
  parkedTotal,
  parkedUnreadable,
  parkedOrphanTmp,
  ok,
  markerWritten,
  markerSkipReason,
  markerGateReason,
  verification,
  postLintOk,
  postBlocking,
  closeScopeNotice,
  otherDebtCount,
  restructureWaivers,
  obsoleteNotices,
  hostTagWarning,
}) {
  console.log(`Session-close apply (project: ${project}, date: ${date}):`);
  for (const a of applied) console.log(`  ✓ wrote ${a}`);
  for (const s of skipped) console.log(`  · skipped ${s} (already current)`);
  // Not a skip and not a conflict: a field this apply no longer has a target
  // for. Printed before the rest so an old payload's author sees it even when
  // the close otherwise succeeds and they stop reading at the ✓ line.
  for (const n of obsoleteNotices || []) console.log(`  · ${n}`);
  // Surfaced unconditionally, success or failure. `restructure: true` no
  // longer waives the guard: the target below is still WITHHELD
  // and shows up in the conflicts loop right after this one. This line only
  // flags that the payload author claimed the drop was intentional, so a human
  // reviewing the parked proposal has that context before typing the nonce.
  for (const w of restructureWaivers) {
    console.log(
      `  ⚠ restructure:true claimed for ${w.target}, parked pending human approval. Dropped: ${w.lostSections.join(', ')}`,
    );
  }
  // Never let a withheld target read as a skip: `skipped` means "already current",
  // this means "your bytes are NOT on disk".
  for (const c of conflicts) {
    console.log(`  ⚠ WITHHELD ${c.key} (${c.target}) — ${c.reason}; ${conflictWhy(c)}`);
  }
  for (const p of proposals) {
    console.log(
      `  · parked proposal ${p.id} for ${p.target} (review it through \`/hypo:crystallize\`, or \`hypomnema proposal list\` with the npm CLI)`,
    );
  }
  if (applied.length > 0 && conflicts.length > 0) {
    console.log(
      '\n· partial close: the writes above ARE on disk but NOT committed — this close is\n' +
        '  ok:false, so no commit and no session-close marker run until the withheld\n' +
        '  target(s) are resolved and the close re-runs.',
    );
  }
  // Surfaced unconditionally, success or failure. This used to sit inside the
  // `if (ok)` success branch below, so a close that just parked a NEW overwrite
  // conflict (`ok:false`, `stage: 'proposal-pending'`, exactly the case that
  // grows this total) never printed it: a terminal-only user saw the id(s)
  // this run just withheld (the `parked proposal <id>` lines above) but never
  // the vault-wide count they add to. `doctor`, not `proposal list`, is where
  // the breakdown lives: this total mixes pending, already-approved-but-
  // unreconciled, and evidence-broken artifacts (see `classifyProposals`), and
  // telling every one of them to "review" the whole number would send a human
  // back to artifacts `proposal reconcile` had already settled.
  if (parkedTotal === null) {
    console.log(
      `  · parked write-proposal count unavailable: \`.cache/proposals\` could not be listed (run ${DOCTOR_HINT}).`,
    );
  } else if (parkedTotal > 0) {
    console.log(
      `  · ${parkedTotal} parked write-proposal artifact(s) vault-wide: run ${DOCTOR_HINT} for a breakdown by state.`,
    );
  }
  // Surfaced unconditionally too, and NOT folded into the parkedTotal branch
  // above: this is exactly the case a reader would otherwise never see, a
  // vault whose only `.cache/proposals` contents are unreadable prints
  // `parkedTotal` as either 0 or null and, before this line existed, nothing
  // else. `doctor` is still where a human goes to act on this; `--json`
  // carries the same filenames in `parkedUnreadable`.
  if (parkedUnreadable.length > 0) {
    const shown = parkedUnreadable.slice(0, 3).join(', ');
    const rest = parkedUnreadable.length > 3 ? `, +${parkedUnreadable.length - 3} more` : '';
    console.log(
      `  ⚠ ${parkedUnreadable.length} file(s) in .cache/proposals could not be read or parsed (corrupt, permission-denied, or hand-edited): ${shown}${rest}. Not counted above; run ${DOCTOR_HINT} to inspect.`,
    );
    // This line is the one a person actually reads after a close; doctor is a
    // second command they may never run. Without this sentence the wording
    // above tells them a recoverable proposal body is corrupt, and the obvious
    // response to "corrupt" is to delete it. Naming the count here and the
    // exact restore command in doctor keeps this line short without leaving
    // the destructive reading as the only one available.
    if (parkedOrphanTmp.length > 0) {
      console.log(
        `    ↳ ${parkedOrphanTmp.length} of those are not corrupt: a writer finished but its rename never landed, so the body is probably intact. Do not delete them; ${DOCTOR_HINT} prints the command that restores each one.`,
      );
    }
  }
  if (ok) {
    // When the marker was withheld, qualify the success line so a reader scanning
    // stdout alone cannot mistake "verified" for "fully closed". markerSkipReason
    // is non-null exactly when args.sessionId is set and the marker did not land.
    if (markerSkipReason) {
      console.log(
        '\n✓ session-close files verified (all 4 mandatory files fresh, lint clean).' +
          '\n  session NOT fully closed: the Stop-chain marker was not written (see warning below).',
      );
    } else {
      console.log('\n✓ session-close verified (all 4 mandatory files fresh, lint clean).');
    }
  }
  // Warn once per run, not on every gate read, which is exactly the
  // repeated-nag cost the enqueue-branch reversion in hooks/hypo-shared.mjs
  // was measured against. Deliberately outside the `ok` block above: the
  // caller already decided whether this run left anything to take back
  // (hostTagUndoKind) and passed null when it did not, and the string it
  // passed names only what this run actually did. Gating on `ok` here is what
  // silenced the warning on 'marker-did-not-land', where the payload was
  // committed and only the marker write failed.
  if (hostTagWarning) {
    console.log(`\n⚠ ${hostTagWarning}`);
  }
  // When ok:true but the session-close marker was NOT written, the Stop-chain
  // still sees an open session and will re-prompt at the next Stop. Surface this
  // loudly so neither the human nor a skill-following model reads "ok:true" as
  // "session fully closed". Gate on `!markerWritten` too so this "marker NOT
  // written" line cannot fire on the contradiction-B path (a written marker that
  // also carried a skip reason) — there the invariant's own 🛑 line already
  // explains the failure, and this message would contradict markerWritten:true.
  //
  // Two shapes reach here now, and they need different words. A policy withhold
  // still leaves ok:true and asks for the right --session-id. A marker write
  // that genuinely failed flips ok to false, so claiming "(ok:true)" there
  // would contradict the JSON this same run printed, and pointing at
  // --session-id would send the user after a problem they do not have.
  //
  // Note this whole block only runs on the non-JSON path; the documented
  // production call is --json, which prints nothing here.
  if (markerSkipReason && !markerWritten) {
    const diskFailure = markerSkipReason === 'marker-did-not-land';
    // The two receipt stages also flip ok to false, and their recoveries are
    // opposite: one is about what is committed, the other about writing under
    // .cache/. Neither is the policy withhold the fallback text below describes,
    // and neither is the gate refusal (compact-gate-not-ok), which stays ok:true.
    const receiptFailure =
      markerSkipReason === 'receipt-proof-mismatch'
        ? `    The 4 mandatory files were applied, but the close checkpoint receipt\n` +
          `    could not prove them against the commit (see mismatches[] in --json\n` +
          `    output). This run reports ok:false and exits 1. The session is NOT closed.\n` +
          `    To fix: check the listed paths with git status, commit the ones you\n` +
          `    have reviewed, then re-run the same close. No fresh close phrase is needed.\n`
        : markerSkipReason === 'receipt-write-failed'
          ? `    The 4 mandatory files were applied and committed, but writing the close\n` +
            `    checkpoint receipt under .cache/sessions/<session-id>/ failed. This run\n` +
            `    reports ok:false and exits 1. The session is NOT closed.\n` +
            `    To fix: clear whatever blocks that directory (permissions, disk space),\n` +
            `    then re-run the same close. No fresh close phrase is needed.\n`
          : // A gate refusal keeps ok:true (the files verified) but the marker was denied
            // by a compact-gate blocker. It is not a session-id problem and not a receipt
            // problem, so it gets its own words.
            markerSkipReason === 'compact-gate-not-ok'
            ? `    The 4 mandatory files were applied and verified, but the compact gate\n` +
              `    refused the per-session Stop-chain marker because a gate blocker\n` +
              `    remains. The session is NOT fully closed: the Stop hook will re-prompt\n` +
              `    until the marker is present. This is not a --session-id problem.\n` +
              `    To fix: resolve the gate blocker (run git status in the vault: commit\n` +
              `    or revert an uncommitted file in the project folder being closed, or\n` +
              `    clear whichever other blocker the gate names), then re-run the same\n` +
              `    close. No fresh close phrase is needed: a close signal is spent only\n` +
              `    once the marker lands.\n`
            : null;
    process.stderr.write(
      `\n⚠️  session-close marker NOT written (reason: ${markerSkipReason})\n` +
        // MAJOR FIX (codex cross-review round 5): only present when the reason
        // is 'no-user-close-signal', and only when a tag-shaped retraction
        // named itself; see closeGateStatus's own reason string for what a
        // maintainer does with it. Without this line, the non-JSON path told
        // the user only that the marker was withheld, never why the gate read
        // the transcript that way.
        (markerGateReason ? `    Gate detail: ${markerGateReason}\n` : '') +
        (receiptFailure ??
          (diskFailure
            ? `    The 4 mandatory files were applied and committed, but writing the\n` +
              `    per-session Stop-chain marker itself failed. This run reports\n` +
              `    ok:false and exits 1. The session is NOT closed: the Stop hook\n` +
              `    will re-prompt until the marker is present.\n` +
              `    To fix: clear whatever blocks the marker path under .cache/\n` +
              `    (permissions, a directory sitting where the marker file goes,\n` +
              `    disk space), then re-run the same close. No fresh close phrase\n` +
              `    is needed: a close signal is spent only once the marker lands.\n`
            : `    The 4 mandatory files were applied and verified (ok:true), but the\n` +
              `    per-session Stop-chain marker was withheld. The session is NOT fully\n` +
              `    closed: the Stop hook will re-prompt until the marker is present.\n` +
              `    To fix: re-run with the correct main-conversation --session-id (NOT\n` +
              `    a background task or Agent UUID from a /tmp/... path).\n` +
              `    Example: crystallize.mjs --apply-session-close --payload=<path>\n` +
              `             --session-id=<main-conversation-id> --hypo-dir=<path>\n`)),
    );
  }
  if (!ok) {
    if (!verification.ok) {
      const bad = [
        ...verification.missing.map((f) => `${f} (missing)`),
        ...verification.stale.map((f) => `${f} (stale)`),
      ].join(', ');
      console.log(`\n✗ session-close still incomplete after apply: ${bad}`);
      console.log('  Fix the payload (likely an `updated:` field) and retry.');
    }
    if (!postLintOk) {
      console.log('\n✗ post-apply lint failed:');
      for (const e of postBlocking) console.log(`  ✗ ${e.file}: ${e.message}`);
      console.log('  Payload introduced a lint blocker — fix the payload content and retry.');
    }
  }
  if (closeScopeNotice.length > 0) {
    console.log(
      `\n· ${closeScopeNotice.length} pre-existing lint issue(s) in untouched files (not blocking): ${[
        ...new Set(closeScopeNotice.map((e) => e.file)),
      ]
        .slice(0, 5)
        .join(', ')}${closeScopeNotice.length > 5 ? ', …' : ''}`,
    );
  }
  if (otherDebtCount > 0) {
    console.log(
      `\n· +${otherDebtCount} pre-existing lint issue(s) elsewhere in the vault (other projects / shared pages, not blocking) — run \`node scripts/lint.mjs\` for the full list.`,
    );
  }
}

export function applySessionClose(args) {
  // Option D: early-exit fires only when NO payload was supplied.
  // Rationale: payload presence is explicit close intent and must always run
  // the full apply path — the per-entry idempotency (overwrite's step-1 skip +
  // exact-entry append dedup) keeps re-apply cheap without short-circuiting,
  // and avoids silent-success when a same-day second close brings new bytes.
  // Payload-less invocation is treated as a cheap "already complete?" probe.
  // --force opts out of that probe shortcut only — payload remains required
  // for any actual apply work (readPayload below surfaces "payload is
  // required" the same way it always has).
  if (!args.force && !args.payload) {
    // No-payload "already complete?" probe uses the
    // global invariant, not a recency pick.
    const probe = sessionCloseGlobalStatus(args.hypoDir);
    // A leftover close-intent record (see closeIntentPath's doc comment)
    // means some earlier apply began this file set and never finished it.
    // `probe.ok` is a freshness read alone, so trusting it here would be
    // exactly the silent "torn set with an already-todayed leftover file"
    // pass this record exists to catch. Only 'clean' clears the probe:
    // 'unreadable' and 'uncommitted' fall through the same as 'torn' (see
    // hasTornCloseIntent's doc comment). A judgment this function could not
    // make is not evidence of a finished close, and neither are files that
    // landed without the commit that would have cleared their record.
    if (probe.ok && hasTornCloseIntent(args.hypoDir) === 'clean') {
      const result = {
        ok: true,
        alreadyComplete: true,
        project: probe.project,
        date: probe.dates[0],
        message: '오늘 이미 close 완료로 보임 (probe 모드 — payload 미지정).',
      };
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✓ ${result.message}`);
        console.log(`  project: ${result.project} / date: ${result.date}`);
      }
      process.exit(0);
    }
    // gate not ok → fall through to readPayload, which surfaces
    // "payload is required" with the same error shape as before.
  }

  const hostTagWarning = refuseUnlessCloseRequested(args);
  const payload = loadValidatedPayload(args);
  // Computed off the payload as read, before any write phase can consume it.
  const obsoleteNotices = obsoleteFieldNotices(payload);
  const project = resolveCloseProject(args, payload);
  const date = payload.date || todayLocal();
  assertPayloadFreshnessContract(args, payload, project, date);
  const { preflightLint, payloadScope, indexRelPath, indexMissing } = runPreflight(
    args,
    payload,
    project,
    date,
  );

  const applied = [];
  const skipped = [];
  // The ACTUAL vault-relative paths this apply wrote, kept separate
  // from `applied` (whose entries are display strings like `key (relPath)`,
  // not bare paths). This is the scope handed to commitWikiChanges below;
  // never the broader `payloadScope` above, which also includes lint/evidence
  // candidates this apply may not have written a byte to.
  const appliedPaths = [];
  // Overwrite targets this apply refused to write because the page moved under
  // it. T6 turns these into `.cache/proposals/` artifacts; here they are already
  // enough to withhold the bytes and fail the close.
  const conflicts = [];
  // Overwrite fields where `restructure: true` was claimed on a REAL
  // section-loss trip (no longer a waiver, the matching target is
  // STILL in `conflicts` above, withheld pending human approval). Kept
  // separate so the audit trail of what the payload author asserted survives
  // even though it decided nothing.
  const restructureWaivers = [];
  // Close-receipt proof entries: one per write phase's own
  // target, whether this attempt wrote fresh bytes or found them already
  // current, never for a target withheld to `conflicts`. Consumed by
  // runMarkerPhase after the commit lands, to verify against the commit
  // itself rather than trust that a write happened.
  const proofEntries = [];
  // One bag for the six accumulators, passed to every write phase below. They
  // push into it in call order; nothing is merged back afterwards, so the
  // report lines keep the exact order the inline version produced.
  const acc = { applied, skipped, appliedPaths, conflicts, restructureWaivers, proofEntries };

  // Record this set's targets BEFORE the first byte is written (see
  // closeIntentPath's doc comment above applyOverwrites), and remove the
  // record only once the commit in runMarkerPhase has landed. A crash
  // anywhere before that, or a close that ends ok:false, leaves the record
  // behind on purpose, for hasTornCloseIntent to find on a later probe.
  //
  // MAJOR fix: a failed write here used to be swallowed (writeCloseIntent's
  // own try/catch) and applyOverwrites ran regardless. The one call meant
  // to leave a witness before any target byte moves left none, silently,
  // and a crash between the first and second target write then had nothing
  // for hasTornCloseIntent to find. Refuse the close here instead, before
  // applyOverwrites is ever reached: zero target bytes are written on this
  // path, same contract as every other pre-write refusal in this function.
  const intentResult = writeCloseIntent(
    args.hypoDir,
    args.sessionId,
    closeIntentTargetsFor(payload, project),
  );
  if (!intentResult.ok) {
    const msg =
      `session-close apply refused before any target file was written: could not record the ` +
      `close-intent witness under .cache/close-intent/ (${intentResult.reason}). This is usually ` +
      `a transient lock, permission, or disk problem: fix it and retry; nothing was written.`;
    const out = {
      ok: false,
      stage: 'close-intent-write-failed',
      error: msg,
      applied: [],
      committed: null,
    };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  applyOverwrites(
    args,
    payload,
    project,
    date,
    indexRelPath,
    indexMissing,
    acc,
    intentResult.attemptId,
  );
  markCloseIntentApplied(args.hypoDir, args.sessionId, intentResult.attemptId);
  appendSessionLogEntry(args, payload, project, date, acc);
  appendRootLogEntry(args, payload, project, date, acc);

  const { proposals, proposalStoreFailures } = parkOverwriteConflicts(args, conflicts);
  const proposalStoreFailed = proposalStoreFailures.length > 0;
  // Vault-wide total, not just what THIS close just parked: `proposals` above is
  // this run's own new artifacts, and a close that never parks anything can still
  // sit behind dozens accumulated by earlier sessions with no path here that says
  // so. This used to reuse `doctor`'s `classifyProposals` judgment so the two
  // surfaces could never disagree about the number, but that judgment reads the
  // WHOLE audit log and re-hashes every recoverable candidate's target file, on
  // every close, whether or not anything here needs the pending/recoverable/
  // evidence-broken breakdown. `listProposalsChecked` counts the SAME artifacts
  // (classifyProposals emits exactly one entry per valid artifact, so the totals
  // agree) without either cost: a directory listing plus each artifact's own
  // JSON, nothing from `applied.log` and no target re-read. The breakdown by
  // state still lives in `hypomnema doctor`, which is what actually tells a
  // human whether a parked artifact needs review or just a `proposal reconcile`.
  // `ok: false` here means the inventory itself could not be enumerated
  // (permissions, or a file sitting where the directory should be): a real
  // "unmeasured", not "empty", so `parkedTotal` stays `null` rather than lie
  // that the backlog is zero.
  const proposalInventory = listProposalsChecked(args.hypoDir);
  const parkedTotal = proposalInventory.ok ? proposalInventory.proposals.length : null;
  // Candidate `.json` files inside a LISTABLE `.cache/proposals` that
  // listProposalsChecked could not parse into an artifact (corrupt, permission-
  // denied, or hand-edited into an unrecognizable shape). These are not folded
  // into parkedTotal above (that count stays "artifacts this close's callers
  // can actually act on"), but a close must never let one sit invisible: before
  // this field, an unreadable artifact simply vanished from the count, and a
  // vault with nothing BUT unreadable ones reported `parkedTotal: 0` with no
  // line anywhere naming the file. Always an array (empty when nothing is
  // wrong, or when the whole directory could not even be listed, that failure
  // already reads as `parkedTotal: null`, not a lying zero here).
  const parkedUnreadable = proposalInventory.unreadable;
  // Subset of the line above whose bytes are probably intact: the writer
  // finished and only the rename never landed. Carried as its own field
  // rather than carved out of parkedUnreadable, so a `--json` consumer that
  // already counts unreadable files keeps counting the same set.
  const parkedOrphanTmp = proposalInventory.orphanTmp || [];

  // Same-date-tie fix: verify against the SAME project this apply just wrote
  // (`project` = payload.project || probe.project, resolved at the top). Without
  // the override, sessionCloseFileStatus re-derives via resolveActiveProject and,
  // on a same-date root-hot.md tie, can pick a different project — false-failing
  // a completed close (the 2026-06-09 security-ops-kb incident).
  const verification = sessionCloseFileStatus(args.hypoDir, { projectOverride: project });

  const { postApplyLint, postBlocking, postNotice, postLintOk } = runPostApplyLint(
    args,
    payloadScope,
  );

  // `let` (not const): the close-result invariant self-check below may flip this
  // to false when the settled close result is internally contradictory.
  //
  // A withheld conflict target must fail the close on its own, not merely via the
  // freshness gate. If the other session already touched that page TODAY, freshness
  // sees a fresh file and passes — and the close would report ok:true, write the
  // marker, and drop this session's payload silently. `conflicts` closes that hole.
  let ok = verification.ok && postLintOk && conflicts.length === 0;

  // Scope the non-blocking notice to the close-target project: debt under
  // projects/<project>/ stays listed; debt elsewhere folds to a count so the
  // same untouched-file debt does not re-list its filenames on every close.
  const closeScopeNotice = postNotice.filter((e) => isUnderProjectDirs(e.file, [project]));
  const otherDebtCount = postNotice.length - closeScopeNotice.length;

  const {
    markerWritten,
    markerSkipReason,
    markerGateReason,
    commitOutcome,
    gateNotices,
    receiptMismatches,
  } = runMarkerPhase(args, project, appliedPaths, ok, hostTagWarning, {
    preflightLint,
    hasConflicts: conflicts.length > 0,
    proofEntries,
    attemptId: intentResult.attemptId,
  });
  // Only a landed commit retires the close-intent record. Everything before
  // this point (the appends, a withheld conflict, a lint or commit failure)
  // leaves it in place: see closeIntentPath's doc comment for why an ok:false
  // close keeps its record.
  if (commitOutcome?.committed === true) {
    clearCloseIntent(args.hypoDir, args.sessionId, intentResult.attemptId);
  }
  // The residual named by the gate walk (one value, computed before any write
  // in this apply) paired with the undo THIS run can honestly offer. A run
  // that neither committed nor wrote a byte gets null back and says nothing:
  // there is nothing on disk to take back, so a warning would only send the
  // reader looking for a change that is not there.
  const hostTagNotice = hostTagWarningWithUndo(
    hostTagWarning,
    hostTagUndoKind({
      committed: commitOutcome?.committed === true,
      markerWritten,
      wroteBytes: appliedPaths.length > 0,
    }),
    args.hypoDir,
    args.sessionId,
    commitShaForUndo(commitOutcome),
  );

  let stage = resolveCloseStage({ ok, proposalStoreFailed, conflicts, verification, postLintOk });
  // Runtime close-result invariant self-check. When a
  // marker-write path (args.sessionId present) settles into an internally
  // contradictory shape — ok:true with the marker silently withheld and no
  // reason, or a written marker that also carries a skip reason — flip ok:false
  // and stage-tag it so the existing `process.exit(ok ? 0 : 1)` yields exit 1.
  // That non-zero exit is the discriminator that separates a genuine
  // contradiction (a code bug) from a legitimate withhold (exit 0, e.g.
  // no-user-close-signal). apply is idempotent, so a non-zero re-run is safe.
  // Unreachable today; this is a regression guard for future refactors.
  if (args.sessionId) {
    const contradiction = closeResultContradiction({ ok, markerWritten, markerSkipReason });
    if (contradiction) {
      ok = false;
      stage = contradiction;
      process.stderr.write(
        `\n🛑 INTERNAL CONTRADICTION in session-close result: ${contradiction}\n` +
          `    markerWritten=${markerWritten}, markerSkipReason=${JSON.stringify(markerSkipReason)}.\n` +
          `    This is a close-pipeline bug, not a normal withhold. Exiting non-zero so it\n` +
          `    cannot masquerade as a successful close. The applied payload files stand;\n` +
          `    re-running apply is idempotent once the pipeline is fixed.\n`,
      );
    } else if (ok && markerWriteGenuinelyFailed({ markerWritten, markerSkipReason })) {
      // Unlike the contradiction above this is not a pipeline bug.
      // every precondition cleared and the marker write itself still failed, the
      // one skip reason `--mark-session-closed` also treats as fatal. Unify the
      // exit code so a caller reading only `$?` cannot see this as a closed
      // session. The `⚠️ session-close marker NOT written` warning below still
      // fires unconditionally and names the same reason; this only changes
      // whether the process exits 0 or 1 over it.
      ok = false;
      stage = markerSkipReason;
    }
  }
  const result = buildCloseResult({
    ok,
    stage,
    project,
    date,
    applied,
    skipped,
    commitOutcome,
    conflicts,
    proposals,
    proposalStoreFailed,
    proposalStoreFailures,
    parkedTotal,
    parkedUnreadable,
    parkedOrphanTmp,
    verification,
    sessionId: args.sessionId,
    markerWritten,
    markerSkipReason,
    markerGateReason,
    receiptMismatches,
    preflightLint,
    postApplyLint,
    closeScopeNotice,
    otherDebtCount,
    gateNotices,
    restructureWaivers,
    obsoleteNotices,
    hostTagWarning: hostTagNotice,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printCloseReport({
      project,
      date,
      applied,
      skipped,
      conflicts,
      proposals,
      parkedTotal,
      parkedUnreadable,
      parkedOrphanTmp,
      ok,
      markerWritten,
      markerSkipReason,
      markerGateReason,
      verification,
      postLintOk,
      postBlocking,
      closeScopeNotice,
      otherDebtCount,
      restructureWaivers,
      obsoleteNotices,
      hostTagWarning: hostTagNotice,
    });
  }
  process.exit(ok ? 0 : 1);
}
