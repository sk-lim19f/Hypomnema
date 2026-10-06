import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  precompactGateStatus,
  resolveTranscriptBySessionId,
  sessionLogShardPath,
} from '../../hooks/hypo-shared.mjs';
import { requireProjectDir, deriveTouchedProject } from './crystallize-close-gate.mjs';
import { closeCheckpointState, isCloseComplete } from '../../hooks/close-receipt.mjs';
import { closeGateStatus } from '../../hooks/close-gate-store.mjs';

// This script's own absolute path. Used to print copy-pasteable recovery
// commands as `node <SELF_SCRIPT> ...` rather than a bare `crystallize` bin,
// which is not on PATH in a Claude Code plugin install (only in an npm global).
// Resolved relative to this lib file rather than via this
// module's own import.meta.url, so the printed path still names the CLI
// entrypoint (scripts/crystallize.mjs), not this lib module — same absolute
// path `fileURLToPath(import.meta.url)` produced from crystallize.mjs itself.
const SELF_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'crystallize.mjs');

// ── session-close check (spec §5.2.7 / §8.3) ────────────────────────
// Runs the same gate decision hypo-personal-check.mjs uses for its PreCompact
// notice, so the /hypo:crystallize flow can self-verify the close. /compact is
// never blocked by this verdict: PreCompact only shows a notice.

export function runSessionCloseCheck(args) {
  // The check mirrors the FULL PreCompact gate via the shared
  // precompactGateStatus (close files + lint + design-history + feedback
  // projection), not just the close files, so a green check means no
  // human-fixable close item is left in the vault. Pass --transcript-path to widen the
  // lint scope to the session's edited files exactly as the interactive hook
  // does (without it, the scope is the mandatory close files only).
  // Pass --session-id so a log-only marker activates log-only gate
  // semantics here too. Without it the check would read the marker as present
  // (marker_present:true) while `ok` still reflected the stale active project —
  // the completion-signal trio (PreCompact / --check / marker) would diverge
  // (codex design Finding 2).
  //
  // --project=<slug> narrows BOTH the close status and the lint scope to that one
  // project: a project-scoped DIAGNOSTIC, NOT the global close verdict.
  // It is check-only: the marker writers stay global (the marker gate is the
  // global gate with only the git axis narrowed by checkpointMode). When narrowed, the
  // transcript widening is suppressed: a transcript touch in some OTHER project
  // would re-add that project's files to the lint scope and re-block the scoped
  // check, defeating the point. The global (no --project) check keeps widening.
  if (args.project) requireProjectDir(args, args.project);
  // Resolve the transcript from --session-id when --transcript-path was not given,
  // exactly as --mark and the apply auto-marker already do. The transcript is what
  // attributes the close as well as widening the lint scope, and PreCompact
  // always has one from its hook payload. A check without it would compute an EMPTY
  // close scope, fall back to the global block, and report RED for debt that the
  // PreCompact notice demotes. Checklist step 14 tells the model to trust this command, so an over-red
  // check is as harmful as an over-green one.
  const checkTranscript =
    args.transcriptPath ||
    (args.sessionId ? resolveTranscriptBySessionId(args.sessionId) : null) ||
    null;
  // This session's close verdict, the same closeCheckpointState Stop blocks on.
  // Read first, and only once: readSessionClosedMarker (inside it) unlinks an
  // expired or corrupt marker as it reads, exactly as the next Stop would.
  const checkpoint = args.sessionId ? closeCheckpointState(args.hypoDir, args.sessionId) : null;
  const closeComplete = isCloseComplete(checkpoint);
  // The gate takes the marker only from a finished close, so a marker whose
  // receipt is missing or invalid cannot switch it into log-only mode.
  const gateMarker = checkpoint ? { closeMarker: closeComplete ? checkpoint.marker : null } : {};
  // Which close id proves this session (the gate's cwd check reads it through
  // sessionProofCloseId): is a close signal open now, and where was the last one
  // resolved. Read once, for both gate calls below. Without a session id there
  // is no pin to read and nothing open.
  const closeGate = args.sessionId
    ? closeGateStatus({
        transcriptPath: checkTranscript,
        hypoDir: args.hypoDir,
        sessionId: args.sessionId,
      })
    : { ok: false, resolvedAtIndex: null };
  const closeFacts = { closeOpen: closeGate.ok, resolvedAtIndex: closeGate.resolvedAtIndex };
  let status = precompactGateStatus(args.hypoDir, {
    ...gateMarker,
    ...closeFacts,
    ...(args.project
      ? { projectOverride: args.project }
      : checkTranscript
        ? { transcriptPath: checkTranscript }
        : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    // The P2 cwd close check (session-close attribution) applies to the GLOBAL gate only. Under
    // --project the check is a project-scoped diagnostic, so a cwd blocker for a
    // DIFFERENT project would muddy that scoped answer — pass sessionCwd only for
    // the global form. process.cwd() is deliberately NOT a fallback: a check run
    // after `cd ~/hypomnema` would map to the vault, not the session (authoritative
    // enforcement lives in the PreCompact/Stop hooks, which carry payload.cwd).
    ...(args.sessionCwd && !args.project ? { sessionCwd: args.sessionCwd } : {}),
  });

  // check/apply divergence (2026-08-25 QA): a real apply never hits discovery
  // dead-ends because payload.project is required input, not an inference. This
  // check has no payload, so when discovery finds NO project at all (not even
  // the recency fallback), it retries scoped to whatever single project this
  // session's own transcript shows it touching. This is a diagnostic estimate,
  // not a preview of what a real apply will do: a payload's `project` field is
  // whatever the caller puts there and can legitimately name a project the
  // transcript never mentions. Only fires on a fully unresolved global result,
  // and only on a TRUSTED single-project reading (see deriveTouchedProject): an
  // already-successful discovery, an ambiguous/empty transcript, or one the walk
  // could not fully read is left untouched rather than guessed at.
  let inferredProject = null;
  if (!args.project && !status.close.project) {
    inferredProject = deriveTouchedProject(args.hypoDir, checkTranscript);
    if (inferredProject) {
      status = precompactGateStatus(args.hypoDir, {
        ...gateMarker,
        ...closeFacts,
        projectOverride: inferredProject,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      });
    }
  }
  const close = status.close;
  const scopedProject = args.project || inferredProject;

  // When a --session-id is supplied, report THIS session's close verdict. Two
  // separate fields, neither folded into `ok` (`ok` stays the global gate
  // verdict):
  //   close_state     closeCheckpointState's state, the one Stop blocks on.
  //                   Only 'closed' and 'legacy-closed' are a finished close;
  //                   'broken' means receipt and marker disagree.
  //   marker_present  kept byte-for-byte for existing readers: whether a
  //                   non-expired marker file exists, as readSessionClosedMarker
  //                   reads it. It does NOT mean the close is finished (a marker
  //                   whose receipt is gone still counts here); read close_state
  //                   for that.
  // A green gate with an unfinished close_state is the hand-edit close state:
  // gate green, but the Stop hook still blocks until the close is recorded.
  const markerObj = checkpoint ? checkpoint.marker : null;
  const markerPresent = args.sessionId ? markerObj !== null : null;

  // Scope of this check (codex design review finding 2 — the scope must be
  // explicit in JSON + prose, not implied). `global` = the full PreCompact mirror
  // (green ⇒ no close item left). `project` = narrowed to --project=<slug> (green ⇒
  // only THAT project is close-complete, NOT the global verdict). When a
  // log-only marker governs the session, the gate runs in log-only mode and the
  // --project override is IGNORED — surface that rather than implying X was
  // checked (it was not).
  const logOnlyWon =
    scopedProject != null && closeComplete && checkpoint.marker?.scope === 'log-only';
  const scope = scopedProject ? (logOnlyWon ? 'log-only' : 'project') : 'global';

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: status.ok,
          // flat close fields preserved for back-compat with prior readers. They now
          // describe what BLOCKS: a foreign project's incomplete close is demoted out
          // of stale/missing into close_debt, so a reader that treats a
          // non-empty `missing` as failure still agrees with `ok` instead of
          // contradicting it.
          project: close.project,
          dates: close.dates,
          stale: close.stale,
          missing: close.missing,
          ...(close.debt?.length ? { close_debt: close.debt } : {}),
          ...(close.scope ? { close_scope: close.scope } : {}),
          blockers: status.blockers,
          notices: status.notices,
          skipped: status.skipped,
          // scope is additive; `global` keeps prior semantics for existing readers
          scope,
          ...(scopedProject
            ? {
                scoped_project: scopedProject,
                // Distinguishes a user-typed --project from this check picking one
                // for itself off the transcript — a reader should not mistake the
                // latter for an explicit ask (see deriveTouchedProject above).
                ...(inferredProject ? { project_inferred_from_transcript: true } : {}),
                ...(logOnlyWon ? { project_override_ignored: true } : {}),
              }
            : {}),
          ...(args.sessionId
            ? {
                session_id: args.sessionId,
                marker_present: markerPresent,
                close_state: checkpoint.state,
                ...(checkpoint.reason ? { close_state_reason: checkpoint.reason } : {}),
              }
            : {}),
        },
        null,
        2,
      ),
    );
    process.exit(status.ok ? 0 : 1);
  }

  // Label the scoped project by how it was chosen — an explicit --project reads
  // as a flag the caller typed; an inferred one reads as this check's own guess
  // off the transcript, so a reader does not credit the caller with an ask
  // nobody made.
  const scopedProjectLabel = args.project
    ? `--project=${args.project}`
    : `project=${scopedProject} (inferred from the session transcript, no --project given)`;
  if (logOnlyWon) {
    console.log(
      `Note: a log-only session-closed marker governs session ${args.sessionId}, so the gate ran in log-only mode and ${scopedProjectLabel} was IGNORED (no project was checked).\n`,
    );
  } else if (scope === 'project') {
    console.log(
      `Note: ${scopedProjectLabel}: this is a PROJECT-SCOPED diagnostic, not the global close verdict. A green result means only ${scopedProject} is close-complete; another project can still have a close item left. /compact is never blocked either way.\n`,
    );
  }

  const proj = close.project || '(unresolved)';
  console.log(
    `Close check (${scope === 'global' ? `project: ${proj}` : `scope: ${scope}, project: ${proj}`}, date: ${close.dates.join(' / ')}):\n`,
  );

  // A close is proven by an entry under projects/<p>/sessions/, never by the
  // generated hot.md / session-state.md views.
  const required = close.project
    ? [
        `projects/${close.project}/sessions/${close.dates[0]}-<close id>.md`,
        sessionLogShardPath(close.project, close.dates[0]),
        'log.md',
      ]
    : [];
  for (const f of required) {
    const bad = close.missing.includes(f) ? 'missing' : close.stale.includes(f) ? 'stale' : '';
    console.log(`  ${bad ? '✗' : '✓'} ${f}${bad ? ` — ${bad}` : ''}`);
  }
  // Surface anything not covered by the canonical list (e.g. unresolved project).
  for (const f of [...close.missing, ...close.stale]) {
    if (!required.includes(f)) console.log(`  ✗ ${f}`);
  }
  // Beyond the close files: the rest of the PreCompact gate (lint, design-history,
  // feedback over-cap/conflict). These are what made a "close-complete" check
  // disagree with the real PreCompact gate before this check was added.
  for (const b of status.blockers) {
    if (b.type !== 'close') console.log(`  ✗ ${b.reason}`);
  }
  if (status.notices.length > 0) {
    console.log('');
    for (const n of status.notices) console.log(`  · ${n.reason}`);
  }
  // Surface the per-session close verdict (separate from the gate
  // verdict) so a green-but-unrecorded close is visible at verify time.
  if (args.sessionId) {
    const markCmd = `node "${SELF_SCRIPT}" --mark-session-closed --session-id=${args.sessionId}${args.transcriptPath ? ` --transcript-path="${args.transcriptPath}"` : ''}`;
    console.log('');
    console.log(
      closeComplete
        ? `  ✓ session close recorded (close_state: ${checkpoint.state}, session_id: ${args.sessionId}).`
        : checkpoint.state === 'broken'
          ? `  · session close checkpoint broken (close_state: ${checkpoint.state}, session_id: ${args.sessionId}): ${checkpoint.reason}. The Stop hook can hold a close open until it is recorded again. Run \`${markCmd}\`.`
          : `  · session-closed marker absent (close_state: ${checkpoint.state}, session_id: ${args.sessionId}): the Stop hook can hold a close open until it is written. Run \`${markCmd}\`.`,
    );
  }
  console.log('');
  if (scope === 'project') {
    // Project-scoped diagnostic: green means ONLY this project is close-complete.
    // Do NOT claim the global verdict (the whole point of the narrow).
    console.log(
      status.ok
        ? `✓ ${scopedProject} is close-complete (project-scoped). This is NOT a global verdict, run \`--check-session-close\` without --project for that.`
        : `✗ ${scopedProject} is not close-complete — resolve the ✗ items above.`,
    );
  } else {
    console.log(
      status.ok
        ? '✓ Close check clean: no blocking items in this check\'s scope; the notices listed above, if any, do not block it. Older hooks call this line "Compact-ready"; for this session, read the close_state line, shown with --session-id. (open-questions.md: conditional, not checked. The live PreCompact notice can still differ on a context-≥70% prompt, HYPO_SKIP_GATE, or a transcript-scoped lint error this check did not see. Pass --transcript-path to include the latter.)'
        : '✗ Close check found items a human still needs to fix: resolve the ✗ items above, then retry. This does not stop /compact; PreCompact only shows a notice. Older hooks call this line "Not compact-ready"; for this session, read the close_state line, shown with --session-id.',
    );
  }
  process.exit(status.ok ? 0 : 1);
}
