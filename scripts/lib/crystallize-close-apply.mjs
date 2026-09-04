import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  writeSync,
  closeSync,
} from 'fs';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { expandHome } from './hypo-root.mjs';
import { isValidProjectName, substituteTokens, TEMPLATE_DIR } from './project-create.mjs';
import { appendPendingTags, checkForbidden } from './schema-vocab.mjs';
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
  hashContent,
  readBaseEntry,
  advanceBase,
  readObservedHash,
  wasObservedTruncated,
} from '../../hooks/base-store.mjs';
import { writeProposal } from '../../hooks/proposal-store.mjs';
import {
  recordGateClosed,
  resolutionStamp,
  closeGateStatus,
} from '../../hooks/close-gate-store.mjs';
import { requireProjectDir } from './crystallize-close-gate.mjs';
import { summarizeLintForOutput } from './crystallize-helpers.mjs';

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
// Idempotent payload-driven application of the 5 mandatory session-close memory
// files (+ optional open-questions). Used by the LLM session-close flow as the
// canonical entrypoint instead of issuing 5+ Write tool calls by hand.
//
// Idempotency:
//   • full-content fields (sessionState/projectHot/rootHot/openQuestions): write
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

/** Atomic write via tmp+rename. `<path>.<pid>.<rand>.tmp` so concurrent helpers
 * don't fight over the same shared `<path>.tmp` slot. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

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
 * @returns {string|null} a conflict reason, or null when this session may write
 */
export function overwriteConflictReason(entry, disk, observed = { hash: null, truncated: false }) {
  // Cannot read what we are about to replace: fail safe, never assume unchanged.
  if (disk === undefined) return 'target-unreadable';
  const observedHash = observed && observed.hash;
  const observedTruncated = !!(observed && observed.truncated);
  switch (entry.state) {
    case 'unknown':
      // No snapshot for this (session, target). Someone else's edits could be
      // sitting on disk and we would have no way to tell.
      return 'base-unknown';
    case 'absent':
      // We observed no file. Creating it is safe; finding one now means another
      // writer got there first, UNLESS this session was later shown exactly
      // those bytes by a resume/compact SessionStart.
      if (disk === null) return null;
      if (observedHash && observedHash === hashContent(disk)) return null;
      return observedTruncated
        ? 'base-mismatch-truncated-observation'
        : 'base-absent-target-exists';
    case 'hash':
      if (disk === null) return 'base-hash-target-missing';
      if (hashContent(disk) === entry.hash) return null;
      // Drifted from the original base — still allowed when this session was
      // shown these exact drifted bytes by a later SessionStart. A truncated
      // injection never reaches `observedHash` (readObservedHash refuses it),
      // so it falls through here and gets its own reason instead of the plain
      // `base-mismatch` a no-observation-at-all case reports.
      if (observedHash && observedHash === hashContent(disk)) return null;
      return observedTruncated ? 'base-mismatch-truncated-observation' : 'base-mismatch';
    default:
      return 'base-unknown';
  }
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

// Spec §5.2.7 / §8.3: 4 mandatory + 2 optional (`log`, `openQuestions`).
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
  ['rootHot', 'content'],
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
  if (payload.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) {
    errs.push('payload.date, when present, must be YYYY-MM-DD');
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
  // signal (after the PreCompact gate and `--check-session-close`). It must use
  // the SAME gate that governs /compact — precompactGateStatus — so the marker
  // can never attest "closed" while /compact would still block. This subsumes
  // the prior (sessionCloseGlobalStatus + hypoIsClean + scoped-lint) gate and
  // additionally enforces feedback projection (over-cap/conflict), W8 design-
  // history staleness, and root hot.md structure — the checks that the narrower
  // marker gate skipped (the divergence behind this fix). git-clean is now a
  // `git` blocker inside the gate. Pass --transcript-path to widen the lint
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
  const gate = precompactGateStatus(args.hypoDir, {
    ...(args.project && !args.logOnly ? { closeScope: [args.project] } : {}),
    ...(closeTranscript ? { transcriptPath: closeTranscript } : {}),
    ...(args.logOnly ? { logOnly: true } : {}),
    // P2 (session-close attribution): the marker gate must refuse to attest compact-ready while the
    // session's cwd project has an unstarted close. logOnly exempts it in-gate.
    ...(args.sessionCwd ? { sessionCwd: args.sessionCwd } : {}),
    ...(attributionScope ? { attributionScope } : {}),
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
  if (!closeTranscript || !isCloseGateOpen(closeTranscript)) {
    const reason = !closeTranscript
      ? `cannot resolve a transcript for session ${args.sessionId} — the session-closed marker requires a verifiable user close signal`
      : "no user close signal in this session's transcript — marker refused (the user did not signal session close)";
    const result = {
      ok: false,
      session_id: args.sessionId,
      project: status.project,
      skipReason: 'no-user-close-signal',
      error: reason,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : `✗ ${reason}`);
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
  writeSessionClosedMarker(args.hypoDir, args.sessionId, {
    project: markerProject,
    projects: args.logOnly ? [] : markerProjects,
    ...(args.logOnly ? { scope: 'log-only' } : {}),
  });
  // Marker writer swallows IO errors (best-effort, see hypo-shared.mjs). Verify
  // the file actually landed before claiming success — otherwise CLI exits 0
  // while next Stop re-blocks, hiding a permission/disk problem.
  // Codex Worker-2 CONCERN (pre-commit review).
  if (!existsSync(sessionClosedMarkerPath(args.hypoDir, args.sessionId))) {
    const err = 'marker file did not land after write (likely .cache permission/disk issue)';
    console.log(
      args.json
        ? JSON.stringify({ ok: false, session_id: args.sessionId, error: err }, null, 2)
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
 *   { ok: true }
 *   { ok: false, reason, error }   reason: session-id-required | transcript-unresolved
 *                                          | no-user-close-signal
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
      error:
        "session-close apply refused before any wiki write or commit: this session's transcript " +
        'carries no user close signal. The user did not ask to close. ' +
        `Gate detail: ${gateStatus.reason}`,
    };
  }
  return { ok: true };
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
export function ensureProjectIndex(hypoDir, project, relPath, today) {
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
// it stopped before this section was a function of its own.
function refuseUnlessCloseRequested(args) {
  const closeAuth = args.payload
    ? verifyCloseAuthority(args.sessionId, args.hypoDir)
    : { ok: true };
  if (!closeAuth.ok) {
    const out = {
      ok: false,
      stage: 'no-user-close-signal',
      reason: closeAuth.reason,
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
  if (payload.rootHot) overwriteTargets.add('hot.md');
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
  if (blockingErrors.length > 0) {
    const out = {
      ok: false,
      stage: 'preflight-lint',
      error: 'lint preflight failed — apply aborted (no payload bytes written)',
      lint: { ...summarizeLintForOutput(preflightLint), blockingErrors },
    };
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log('✗ lint preflight failed — apply aborted (no payload bytes written):');
      for (const e of blockingErrors) console.log(`  ✗ ${e.file}: ${e.message}`);
      console.log('  Fix the wiki (run `node scripts/lint.mjs`) and retry.');
    }
    process.exit(1);
  }

  return { preflightLint, payloadScope, indexRelPath, indexMissing };
}

/**
 * Replace every whole-page overwrite target, then fill a missing project index.
 *
 * `acc` is the shared accumulator bag (`applied` / `skipped` / `appliedPaths` /
 * `conflicts`) the caller owns; every write phase pushes into the same arrays
 * rather than returning partial lists for the caller to merge, so the ordering
 * of the report lines is the call order, exactly as it was inline.
 *
 * The step order inside `overwrite` is load-bearing, not stylistic:
 *
 *   1. idempotent skip (disk already equals the payload)
 *   2. conflict (base unknown, or disk drifted away from base)
 *   3. direct write, then advance the base
 *
 * Step 1 must come first for two reasons. It keeps every existing
 * `--apply-session-close --session-id` test green (they read the payload
 * straight off disk, so they land here before any base lookup). And it breaks
 * the apply-then-reclose loop: once a human applies proposal P, disk == proposed
 * == payload.content, so the next close skips before it can re-raise a conflict.
 *
 * There is no caller here without a `--session-id`. verifyCloseAuthority refuses
 * that at the door, before a byte is written, so a session id is always present
 * by the time this runs and the base lookup always has something to look up.
 */
function applyOverwrites(args, payload, project, date, indexRelPath, indexMissing, acc) {
  const { applied, skipped, appliedPaths, conflicts } = acc;

  const overwrite = (key, relPath, field) => {
    if (!field || typeof field.content !== 'string') return; // optional / absent
    const full = join(args.hypoDir, relPath);
    const disk = readTarget(full);

    // (1) idempotent skip — preserves writeIfChanged's contract
    if (disk === field.content) {
      skipped.push(`${key} (${relPath})`);
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
      const reason = overwriteConflictReason(entry, disk, {
        hash: observedHash,
        truncated: observedTruncated,
      });
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

    // (3) write, then the content we just wrote IS this session's new base
    atomicWrite(full, field.content);
    if (args.sessionId)
      advanceBase(args.hypoDir, args.sessionId, relPath, hashContent(field.content));
    applied.push(`${key} (${relPath})`);
    appliedPaths.push(relPath);
  };

  overwrite('sessionState', join('projects', project, 'session-state.md'), payload.sessionState);
  overwrite('projectHot', join('projects', project, 'hot.md'), payload.projectHot);
  overwrite('rootHot', 'hot.md', payload.rootHot);
  overwrite('openQuestions', join('pages', 'open-questions.md'), payload.openQuestions);

  // A-1: fill a missing project index as part of this close's writes (after
  // preflight passed, so an aborted close never leaves a half-applied side
  // effect on disk).
  if (indexMissing) {
    const createdIndex = ensureProjectIndex(args.hypoDir, project, indexRelPath, date);
    if (createdIndex) {
      applied.push(`projectIndex (${createdIndex})`);
      appliedPaths.push(createdIndex);
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
  const { applied, skipped, appliedPaths, conflicts } = acc;
  const rel = join('projects', project, 'session-log', `${date}.md`);
  const full = join(args.hypoDir, rel);
  const isPresent = entryAlreadyPresent(payload.sessionLog.entry);
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
            if (isPresent(readFileSync(cf, 'utf-8'))) return 'skipped';
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
    if (outcome !== 'skipped') appliedPaths.push(rel);
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
function appendRootLogEntry(args, payload, project, date, acc) {
  const { applied, skipped, appliedPaths, conflicts } = acc;
  const logFull = join(args.hypoDir, 'log.md');
  if (payload.log) {
    try {
      const wrote = withFileLock(
        logFull,
        () => appendIfAbsent(logFull, payload.log.entry, entryAlreadyPresent(payload.log.entry)),
        { timeoutMs: APPEND_LOCK_TIMEOUT_MS },
      );
      (wrote ? applied : skipped).push('log (log.md)');
      if (wrote) appliedPaths.push('log.md');
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
    try {
      const wroteAny = withFileLock(
        logFull,
        () => {
          let w = false;
          for (const m of (payload.sessionLog.entry || '').matchAll(headingRe)) {
            const { heading, block } = rootLogEntry(project, date, m[1]);
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
      if (wroteAny) appliedPaths.push('log.md');
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
          `    This close WITHHELD the target (it drifted from your observed base) but\n` +
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

function registerPendingTags(args, preflightLint, hasConflicts) {
  const pendingTags = [];
  for (const w of preflightLint.warns || []) {
    const m = unknownTagRe.exec(w.message || '');
    if (m && !checkForbidden(m[1])) pendingTags.push(m[1]);
  }
  // Withheld a target? Then register nothing. This close is going to be re-run
  // once a human resolves the conflict, and its `ok:false` skips the commit below
  // (`if (ok && args.sessionId)`) — so registering here would leave SCHEMA.md
  // mutated, uncommitted, and absent from `applied`, i.e. a silent side effect of
  // a close whose whole point was to write nothing. Registration is
  // eventually-consistent by design, so deferring it to the next close costs
  // nothing (codex W2 CONCERN).
  if (pendingTags.length > 0 && !hasConflicts) {
    appendPendingTags(args.hypoDir, pendingTags);
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
    ({ blocking: postBlocking, notice: postNotice } = partitionLintScope(
      postApplyLint.errors || [],
      payloadScope,
    ));
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
function runMarkerPhase(args, project, appliedPaths, ok) {
  let markerWritten = false;
  let markerSkipReason = null;
  let commitOutcome = null;
  if (ok && args.sessionId) {
    // Close-gate resolution: apply succeeding (`ok`) IS the resolution, not
    // whether the per-session marker below happens to land. The marker can
    // be withheld for reasons that have nothing to do with whether this
    // apply's own writes were valid (a stale git tree, a feedback-projection
    // cap, W8 design-history staleness) — none of that should leave the
    // resolution unrecorded, because the wiki writes already happened, and
    // re-running the SAME apply with no fresh user close signal is exactly
    // what this record exists to block. So this sits OUTSIDE and ahead of
    // the marker's own commit-gated logic below, resolving its own
    // transcript rather than sharing the marker's `closeTranscript` (which
    // stays null whenever the commit fails) — a commit failure withholds
    // the marker but must not also withhold the resolution.
    //
    // Best-effort like every other write in this store: resolutionStamp
    // returns null on anything it cannot read as a Buffer, recordGateClosed
    // refuses a null stamp, and both fail silently, so a transcript that
    // vanishes mid-read (or a cache-write failure) can never turn an
    // otherwise-successful apply into a failure.
    try {
      const resolutionTranscriptPath = resolveTranscriptBySessionId(args.sessionId);
      if (resolutionTranscriptPath) {
        recordGateClosed(
          args.hypoDir,
          args.sessionId,
          resolutionStamp(readFileSync(resolutionTranscriptPath)),
        );
      }
    } catch {
      // Unreadable at the moment of a successful close is not this apply's
      // problem to surface — the resolution just stays unrecorded, same as
      // if this session had never resolved at all (NO_CONSTRAINT).
    }

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
    try {
      commitOutcome = withFileLock(vaultCommitLockTarget(args.hypoDir), () =>
        commitWikiChanges(args.hypoDir, appliedPaths),
      );
    } catch (err) {
      commitOutcome = { committed: false, reason: `vault-commit-lock: ${err?.message || err}` };
    }
    let closeTranscript = null;
    let gateOk = false;
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
      gateOk = precompactGateStatus(args.hypoDir, {
        closeScope: [project],
        ...(closeTranscript ? { transcriptPath: closeTranscript } : {}),
        ...(autoMarkerOverride ? { attributionScope: autoMarkerOverride } : {}),
      }).ok;
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
      // Reads the raw walkCloseGate open, not closeGateStatus: this apply's
      // OWN recordGateClosed call above already ran with this transcript's
      // full record count as closedAtIndex, and openedAtIndex can never reach
      // or pass a count taken from the very same transcript (see
      // closeGateStatus's doc comment) — so gating this diagnostic on .ok
      // would read false on every apply, unconditionally, not just a stale
      // one. This field asks a narrower question than closeGateStatus
      // answers: "did the transcript carry a close signal", not "is this
      // apply itself still authorized" (verifyCloseAuthority already settled
      // that, before any byte was written).
      hasUserSignal: gateOk && !!closeTranscript && isCloseGateOpen(closeTranscript),
    });
    markerSkipReason = decision.skipReason;
    if (decision.write) {
      // apply KNOWS its authoritative payload.project — stamp it as the v4
      // evidence set so PreCompact trusts this marker's scope directly (session-close attribution).
      writeSessionClosedMarker(args.hypoDir, args.sessionId, { project, projects: [project] });
      // Codex CONCERN: the writer swallows IO errors (best-effort).
      // Verify the file actually landed — mirroring the standalone path — instead of
      // asserting markerWritten=true, so a .cache permission/disk problem surfaces
      // rather than the caller reporting "closed" while the next Stop re-blocks.
      if (existsSync(sessionClosedMarkerPath(args.hypoDir, args.sessionId))) {
        markerWritten = true;
      } else {
        markerSkipReason = 'marker-did-not-land';
      }
    }
  }
  return { markerWritten, markerSkipReason, commitOutcome };
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
  verification,
  sessionId,
  markerWritten,
  markerSkipReason,
  preflightLint,
  postApplyLint,
  closeScopeNotice,
  otherDebtCount,
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
    conflicts: conflicts.map(({ proposedContent: _drop, ...rest }) => rest),
    // Parked overwrite proposals (id/target/path), one per drifted overwrite
    // target. Empty when only append conflicts (or none) occurred. The T7 CLI
    // lists and applies these; append conflicts never appear here.
    proposals,
    ...(proposalStoreFailed ? { proposalStoreFailures } : {}),
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
    // caller can tell "closed" from "applied but not marked".
    ...(sessionId ? { markerWritten, markerSkipReason } : {}),
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
    notices: [...new Set(closeScopeNotice.map((e) => e.file))],
    otherDebtCount,
  };
}

// The human-readable (non --json) rendering of the same settled state.
function printCloseReport({
  project,
  date,
  applied,
  skipped,
  conflicts,
  proposals,
  ok,
  markerWritten,
  markerSkipReason,
  verification,
  postLintOk,
  postBlocking,
  closeScopeNotice,
  otherDebtCount,
}) {
  console.log(`Session-close apply (project: ${project}, date: ${date}):`);
  for (const a of applied) console.log(`  ✓ wrote ${a}`);
  for (const s of skipped) console.log(`  · skipped ${s} (already current)`);
  // Never let a withheld target read as a skip: `skipped` means "already current",
  // this means "your bytes are NOT on disk". Overwrite conflicts drifted from base;
  // an append conflict is a lock-timeout (someone else held the file's lock), which
  // is transient — the next close re-applies.
  for (const c of conflicts) {
    const why =
      c.kind === 'append'
        ? 'could not acquire the append lock in time; the next close re-applies'
        : 'the page changed since this session read it';
    console.log(`  ⚠ WITHHELD ${c.key} (${c.target}) — ${c.reason}; ${why}`);
  }
  for (const p of proposals) {
    console.log(`  · parked proposal ${p.id} for ${p.target} (review with \`hypomnema proposal\`)`);
  }
  if (applied.length > 0 && conflicts.length > 0) {
    console.log(
      '\n· partial close: the writes above ARE on disk but NOT committed — this close is\n' +
        '  ok:false, so no commit and no session-close marker run until the withheld\n' +
        '  target(s) are resolved and the close re-runs.',
    );
  }
  if (ok) {
    // When the marker was withheld, qualify the success line so a reader scanning
    // stdout alone cannot mistake "verified" for "fully closed". markerSkipReason
    // is non-null exactly when args.sessionId is set and the marker did not land.
    if (markerSkipReason) {
      console.log(
        '\n✓ session-close files verified (all 5 mandatory files fresh, lint clean).' +
          '\n  session NOT fully closed: the Stop-chain marker was not written (see warning below).',
      );
    } else {
      console.log('\n✓ session-close verified — all 5 mandatory files fresh, lint clean.');
    }
  }
  // When ok:true but the session-close marker was NOT written, the Stop-chain
  // still sees an open session and will re-prompt at the next Stop. Surface this
  // loudly so neither the human nor a skill-following model reads "ok:true" as
  // "session fully closed". Gate on `!markerWritten` too so this "marker NOT
  // written" line cannot fire on the contradiction-B path (a written marker that
  // also carried a skip reason) — there the invariant's own 🛑 line already
  // explains the failure, and this message would contradict markerWritten:true.
  if (markerSkipReason && !markerWritten) {
    process.stderr.write(
      `\n⚠️  session-close marker NOT written (reason: ${markerSkipReason})\n` +
        `    The 5 mandatory files were applied and verified (ok:true), but the\n` +
        `    per-session Stop-chain marker was withheld. The session is NOT fully\n` +
        `    closed: the Stop hook will re-prompt until the marker is present.\n` +
        `    To fix: re-run with the correct main-conversation --session-id (NOT\n` +
        `    a background task or Agent UUID from a /tmp/... path).\n` +
        `    Example: crystallize.mjs --apply-session-close --payload=<path>\n` +
        `             --session-id=<main-conversation-id> --hypo-dir=<path>\n`,
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
    if (probe.ok) {
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

  refuseUnlessCloseRequested(args);
  const payload = loadValidatedPayload(args);
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
  // One bag for the four accumulators, passed to every write phase below. They
  // push into it in call order; nothing is merged back afterwards, so the
  // report lines keep the exact order the inline version produced.
  const acc = { applied, skipped, appliedPaths, conflicts };

  applyOverwrites(args, payload, project, date, indexRelPath, indexMissing, acc);
  appendSessionLogEntry(args, payload, project, date, acc);
  appendRootLogEntry(args, payload, project, date, acc);

  const { proposals, proposalStoreFailures } = parkOverwriteConflicts(args, conflicts);
  const proposalStoreFailed = proposalStoreFailures.length > 0;

  // Same-date-tie fix: verify against the SAME project this apply just wrote
  // (`project` = payload.project || probe.project, resolved at the top). Without
  // the override, sessionCloseFileStatus re-derives via resolveActiveProject and,
  // on a same-date root-hot.md tie, can pick a different project — false-failing
  // a completed close (the 2026-06-09 security-ops-kb incident).
  const verification = sessionCloseFileStatus(args.hypoDir, { projectOverride: project });

  registerPendingTags(args, preflightLint, conflicts.length > 0);

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

  const { markerWritten, markerSkipReason, commitOutcome } = runMarkerPhase(
    args,
    project,
    appliedPaths,
    ok,
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
    verification,
    sessionId: args.sessionId,
    markerWritten,
    markerSkipReason,
    preflightLint,
    postApplyLint,
    closeScopeNotice,
    otherDebtCount,
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
      ok,
      markerWritten,
      markerSkipReason,
      verification,
      postLintOk,
      postBlocking,
      closeScopeNotice,
      otherDebtCount,
    });
  }
  process.exit(ok ? 0 : 1);
}
