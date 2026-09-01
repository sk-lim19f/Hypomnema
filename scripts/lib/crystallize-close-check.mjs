import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  precompactGateStatus,
  resolveTranscriptBySessionId,
  readSessionClosedMarker,
  sessionLogShardPath,
} from '../../hooks/hypo-shared.mjs';
import { requireProjectDir, deriveTouchedProject } from './crystallize-close-gate.mjs';

// This script's own absolute path. Used to print copy-pasteable recovery
// commands as `node <SELF_SCRIPT> ...` rather than a bare `crystallize` bin,
// which is not on PATH in a Claude Code plugin install (only in an npm global).
// Resolved relative to this lib file rather than via this
// module's own import.meta.url, so the printed path still names the CLI
// entrypoint (scripts/crystallize.mjs), not this lib module — same absolute
// path `fileURLToPath(import.meta.url)` produced from crystallize.mjs itself.
const SELF_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'crystallize.mjs');

// ── session-close check (spec §5.2.7 / §8.3) ────────────────────────
// Mirrors the hard gate in hypo-personal-check.mjs so the /hypo:crystallize
// flow can self-verify before /compact triggers PreCompact.

export function runSessionCloseCheck(args) {
  // The check mirrors the FULL PreCompact gate via the shared
  // precompactGateStatus (close files + lint + design-history + feedback
  // projection), not just the close files — so a green check means /compact
  // won't block on a human-fixable issue. Pass --transcript-path to widen the
  // lint scope to the session's edited files exactly as the interactive hook
  // does (without it, the scope is the mandatory close files only).
  // Pass --session-id so a log-only marker activates log-only gate
  // semantics here too. Without it the check would read the marker as present
  // (marker_present:true) while `ok` still reflected the stale active project —
  // the completion-signal trio (PreCompact / --check / marker) would diverge
  // (codex design Finding 2).
  //
  // --project=<slug> narrows BOTH the close status and the lint scope to that one
  // project: a project-scoped DIAGNOSTIC, NOT the global compact-ready verdict.
  // It is check-only: the marker writers stay global so
  // the marker == compact-ready invariant holds. When narrowed, the
  // transcript widening is suppressed: a transcript touch in some OTHER project
  // would re-add that project's files to the lint scope and re-block the scoped
  // check, defeating the point. The global (no --project) check keeps widening.
  if (args.project) requireProjectDir(args, args.project);
  // Resolve the transcript from --session-id when --transcript-path was not given,
  // exactly as --mark and the apply auto-marker already do. The transcript is what
  // attributes the close as well as widening the lint scope, and PreCompact
  // always has one from its hook payload. A check without it would compute an EMPTY
  // close scope, fall back to the global block, and report RED for debt that /compact
  // demotes. Checklist step 14 tells the model to trust this command, so an over-red
  // check is as harmful as an over-green one.
  const checkTranscript =
    args.transcriptPath ||
    (args.sessionId ? resolveTranscriptBySessionId(args.sessionId) : null) ||
    null;
  let status = precompactGateStatus(args.hypoDir, {
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
        projectOverride: inferredProject,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      });
    }
  }
  const close = status.close;
  const scopedProject = args.project || inferredProject;

  // When a --session-id is supplied, report whether THIS session's
  // per-session marker (the Stop-chain completion signal) exists. This is a
  // separate field, NOT folded into `ok`: `ok` stays the compact-
  // readiness verdict. A green gate with marker_present=false is exactly the
  // hand-edit close state: close is compact-ready but the Stop hook will
  // still block until the marker is written.
  //
  // Use the SAME reader the Stop hook gates on (readSessionClosedMarker), not
  // raw file existence: a stale/corrupt marker file exists on disk but the hook
  // rejects (and unlinks) it, so raw existsSync would report marker_present=true
  // while /compact's Stop still blocks — the exact incoherence this ADR closes
  // (codex pre-commit CONCERN). readSessionClosedMarker unlinks an invalid
  // marker as it reads, matching the hook's behavior on the next Stop.
  const markerObj = args.sessionId ? readSessionClosedMarker(args.hypoDir, args.sessionId) : null;
  const markerPresent = args.sessionId ? markerObj !== null : null;

  // Scope of this check (codex design review finding 2 — the scope must be
  // explicit in JSON + prose, not implied). `global` = the full PreCompact mirror
  // (green ⇒ compact-ready). `project` = narrowed to --project=<slug> (green ⇒
  // only THAT project is close-complete, NOT global compact-readiness). When a
  // log-only marker governs the session, the gate runs in log-only mode and the
  // --project override is IGNORED — surface that rather than implying X was
  // checked (it was not).
  const logOnlyWon = scopedProject != null && markerObj?.scope === 'log-only';
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
          ...(args.sessionId ? { session_id: args.sessionId, marker_present: markerPresent } : {}),
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
      `Note: ${scopedProjectLabel} — this is a PROJECT-SCOPED diagnostic, not the global /compact gate. A green result means only ${scopedProject} is close-complete; another project can still block /compact.\n`,
    );
  }

  const proj = close.project || '(unresolved)';
  console.log(
    `Compact-ready check (${scope === 'global' ? `project: ${proj}` : `scope: ${scope}, project: ${proj}`}, date: ${close.dates.join(' / ')}):\n`,
  );

  const required = close.project
    ? [
        `projects/${close.project}/session-state.md`,
        `projects/${close.project}/hot.md`,
        'hot.md',
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
  // disagree with the real /compact gate before this check was added.
  for (const b of status.blockers) {
    if (b.type !== 'close') console.log(`  ✗ ${b.reason}`);
  }
  if (status.notices.length > 0) {
    console.log('');
    for (const n of status.notices) console.log(`  · ${n.reason}`);
  }
  // Surface the per-session marker state (separate from compact-
  // readiness) so a green-but-unmarked close is visible at verify time.
  if (args.sessionId) {
    console.log('');
    console.log(
      markerPresent
        ? `  ✓ session-closed marker present (session_id: ${args.sessionId}).`
        : `  · session-closed marker absent (session_id: ${args.sessionId}) — the Stop hook will block until it is written. Run \`node "${SELF_SCRIPT}" --mark-session-closed --session-id=${args.sessionId}${args.transcriptPath ? ` --transcript-path="${args.transcriptPath}"` : ''}\`.`,
    );
  }
  console.log('');
  if (scope === 'project') {
    // Project-scoped diagnostic: green means ONLY this project is close-complete.
    // Do NOT claim global compact-readiness (the whole point of the narrow).
    console.log(
      status.ok
        ? `✓ ${scopedProject} is close-complete (project-scoped). This is NOT a global /compact guarantee — run \`--check-session-close\` without --project for that.`
        : `✗ ${scopedProject} is not close-complete — resolve the ✗ items above.`,
    );
  } else {
    console.log(
      status.ok
        ? '✓ Compact-ready — no PreCompact gate blocker needs a human fix. (open-questions.md: conditional, not checked. The live /compact can still differ on a context-≥70% prompt, HYPO_SKIP_GATE, or a transcript-scoped lint error this check did not see — pass --transcript-path to include the latter.)'
        : '✗ Not compact-ready — resolve the ✗ items above, then retry. /compact would block on these.',
    );
  }
  process.exit(status.ok ? 0 : 1);
}
