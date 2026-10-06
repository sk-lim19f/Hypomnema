#!/usr/bin/env node
/**
 * hypo-auto-minimal-crystallize.mjs: Stop chain stage 4, last (Layer 3)
 *
 * Spawned by hypo-stop.mjs, which is the only Stop registration. This stage runs
 * last on purpose: it is the only one that can emit `decision: "block"`, and its
 * close gate reads the committed state stage 3 (hypo-auto-commit) produced.
 *
 * Last hook in the Stop chain: a final-line defense that blocks `Stop` when
 * the current session did substantial work (mutation, or a high-volume
 * read-only investigation — see step 3) but never produced a verified
 * session-close. Forces Claude to run minimal session-close before the
 * conversation context evaporates.
 *
 * Decision flow (see amendment 2026-05-19 Q1+Q2 + 2nd amendment Q-close-gate):
 *
 *   1. stop_hook_active === true  → continue       (loop guard; PoC 2026-05-14)
 *   2. wiki absent                 → continue       (fail-open)
 *   3. not a substantial session   → continue       (substantial-session gate)
 *        substantial = ≥1 mutation tool_use, OR ≥5 read-only investigation
 *        calls (Read/Grep/Glob/Bash) — 6a, so read-only review/debug sessions
 *        are also nudged to close. Pure Q&A / incidental lookups still skip.
 *   4. no recent user close-intent → continue       (close-intent gate, see below)
 *   5. close verdict for session_id, closeCheckpointState (close-receipt.mjs):
 *        a. closed: valid receipt + a marker naming its generation
 *                                               → continue (cwd/log-only exemption unchanged)
 *        b. legacy-closed: no receipt, marker with NO receiptGeneration
 *                                               → continue (marker's own 7-day TTL)
 *        c. broken: receipt and marker disagree (a marker promising a missing,
 *           invalid or different receipt, or a valid receipt with no marker or
 *           a mismatched one)                  → fall through to block, naming why
 *        d. open: neither                       → fall through to block
 *      A valid receipt only certifies the files it names (the checkpoint
 *      contract), so branch (a) also fires an unresolved-changes
 *      systemMessage once per receipt generation (see notifyUnresolved).
 *      This is never a block, only a notice riding along on the continue reply.
 *   6. otherwise                   → decision:block
 *
 * Close-intent gate (added after PR-C dogfooding revealed every-turn block —
 * codex 2-worker debate 2026-05-19, both REQUEST_CHANGES). Stop fires after
 * EVERY assistant turn, not at session end; blocking on "mutation + no marker"
 * alone nags the user on every turn of a long mutating session. The hook's
 * real intent is "block when the session is ENDING and close is incomplete".
 * We approximate the end signal by reusing isClosePattern() over recent
 * user-message text (the same low-false-positive signal PreCompact uses):
 * only block when the user actually signalled wrap-up ("이만 마치자",
 * "오늘 여기까지", "wrap up", "session close"). last_assistant_message is NOT
 * used — "커밋했습니다"/"작업 완료" type phrases produce false positives.
 *
 * Reconfirm branch (conditional-close-reconfirm, added after the close-intent
 * gate above was found to be unable to distinguish "close now" from "close
 * once X is done" by regex alone — same sentence shape either way). When the
 * close-intent gate above fires AND the session has a work-incomplete signal
 * (an uncommitted wiki, or pending background work — a non-terminal
 * background task or a scheduled cron wake — per hasPendingBackgroundWork),
 * step 6's block reason is replaced with an
 * AskUserQuestion instruction instead of a crystallize command — the model
 * asks the user "close now?" rather than deciding for them. A correlated
 * "아직"/"나중"/"not yet"/"later" answer (isCloseReconfirmDeclined) suppresses
 * the NEXT such block via `continue`, until a new user close signal re-arms
 * it. This does not touch step 4's isClosePattern gate itself, and does not
 * change the marker-writer's own close-file-status gate.
 *
 * The hook NEVER writes the marker — even in the loop-guard branch. Writer
 * authority lives in `scripts/crystallize.mjs` (`--apply-session-close
 * --session-id=X` or standalone `--mark-session-closed --session-id=X`),
 * which gates the write on sessionCloseFileStatus.ok. Doing the write here
 * would let a Claude that ignored the block (did other work, hit Stop again)
 * silently get a marker without performing the close — exactly the failure
 * mode the per-session marker was introduced to prevent.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import {
  HYPO_DIR,
  PKG_ROOT,
  isSubstantialSession,
  extractUserMessages,
  isClosePattern,
  isGateSkipped,
  precompactGateStatus,
  hasPendingBackgroundWork,
  isCloseReconfirmDeclined,
  CLOSE_RECONFIRM_MARK,
  resolveGateProjectOverride,
  gitDirtyFiles,
  isForeignAppendOnlyShard,
  isForeignUncommittedEntry,
} from './hypo-shared.mjs';
import { closeCheckpointState, isCloseComplete, receiptPath } from './close-receipt.mjs';
import { closeGateStatus } from './close-gate-store.mjs';
import { atomicWrite } from './atomic-write.mjs';

// Carrying a systemMessage does not turn this into a block: the session is
// still free to end, the message just rides along on the same continue reply
// (hooks/hypo-stop.mjs merges every stage's systemMessage into one).
function emitContinue(systemMessage) {
  const out = { continue: true, suppressOutput: !systemMessage };
  if (systemMessage) out.systemMessage = systemMessage;
  console.log(JSON.stringify(out));
}

// The checkpoint contract: a valid receipt proves only the files it names were
// committed at the receipt's commit, never that the rest of the session's work
// was saved, and never that a named file still has those bytes. Every dirty
// path is unresolved: a path outside the receipt's entries was never certified,
// and a path inside them differs from HEAD now, so the bytes on disk are
// committed nowhere (the receipt's commit is an ancestor of HEAD). The second
// kind is listed apart as changed after the close checkpoint. The notice fires
// once per receipt generation, or again once the dirty list itself changes,
// never on every Stop turn a long session produces. State lives next to the
// receipt it is keyed to (`.cache/sessions/<sid>/`), so an invalidated or
// replaced receipt (a fresh close attempt) starts this notice fresh too.
function notifyUnresolved(hypoDir, sessionId, receipt) {
  const certified = new Set((receipt.entries || []).map((e) => e && e.path));
  // Another session's close still committing (its new entry, its append to a
  // session-log shard) is not this session's to resolve.
  const dirty = gitDirtyFiles(hypoDir)
    .filter(
      (f) =>
        !isForeignUncommittedEntry(hypoDir, f, sessionId) &&
        !isForeignAppendOnlyShard(hypoDir, f, sessionId),
    )
    .sort();
  if (dirty.length === 0) return null;
  const rp = receiptPath(hypoDir, sessionId);
  if (!rp) return null;
  const notifyPath = join(dirname(rp), 'unresolved-notified.json');
  let prior = null;
  try {
    prior = JSON.parse(readFileSync(notifyPath, 'utf-8'));
  } catch {
    prior = null;
  }
  const sameList =
    prior &&
    prior.generation === receipt.generation &&
    Array.isArray(prior.files) &&
    prior.files.length === dirty.length &&
    prior.files.every((f, i) => f === dirty[i]);
  if (sameList) return null;
  try {
    atomicWrite(notifyPath, JSON.stringify({ generation: receipt.generation, files: dirty }));
  } catch {
    // Best-effort: a failed write only means this same notice repeats next
    // turn, never that it silently stops appearing.
  }
  const uncertified = dirty.filter((f) => !certified.has(f));
  const changedAfter = dirty.filter((f) => certified.has(f));
  const parts = [];
  if (uncertified.length > 0) parts.push(uncertified.join(', '));
  if (changedAfter.length > 0) {
    // No ownership test here: a shared append target such as log.md is in
    // nearly every receipt, and another session's append makes it dirty too.
    parts.push(
      `[close 체크포인트 뒤 바뀜(이 세션 또는 다른 세션), 지금 내용은 커밋되지 않음: ${changedAfter.join(', ')}]`,
    );
  }
  return (
    `[WIKI_AUTOCLOSE] close checkpoint 확인됨 (session_id=${sessionId}). 다만 이 체크포인트가 ` +
    `증명하지 않는 미해결 변경이 있습니다: ${parts.join(' ')}`
  );
}

function emitBlock(sessionId, transcriptPath, gate = null, opts = {}) {
  // Reconfirm branch (work-incomplete + close-intent, ambiguous "now" vs
  // "later"): the model must NOT decide unilaterally. Ask the user via
  // AskUserQuestion instead of naming a marker/crystallize command — doing
  // so here would let the model "resolve" the ambiguity by just running the
  // close, which is exactly the silent-close-on-uncommitted-work failure
  // mode this branch exists to stop. See spec/plan
  // (specs/conditional-close-reconfirm/). The close-now option label below
  // (CLOSE_RECONFIRM_MARK) must stay in sync with hypo-shared.mjs
  // isCloseReconfirmDeclined's correlation check — that coupling is
  // load-bearing (a differently-labeled option would leave the model's
  // AskUserQuestion uncorrelated, so even an explicit user decline could not
  // be recognized as such). Both sides import the same constant so a reworded
  // label can't drift out of sync silently. The decline label ("아직, 계속")
  // stays a literal here — it is matched by the tolerant DECLINE regex in
  // isCloseReconfirmDeclined, not by an exact-mark check.
  // A broken checkpoint (receipt and marker disagree) is not "never closed":
  // say so, whichever wording the block takes, so the rerun is understood as
  // re-issuing both artifacts rather than as a first close.
  const brokenNote = opts.brokenReason
    ? ` 이전 close 체크포인트가 깨져 있어 완료로 보지 않았습니다: ${opts.brokenReason}. close 를 다시 실행하면 영수증과 마커를 함께 새로 씁니다. --mark-session-closed 가 prior-checkpoint-rewritten 으로 거부되면 이전 close 가 증명한 커밋이 히스토리에서 사라진 것이니, 그 커밋을 되살리거나 사용자에게 다시 close 를 요청받아 /hypo:crystallize 로 새 close 를 적용하세요.`
    : '';
  if (opts.reconfirm) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason:
          `[WIKI_AUTOCLOSE] close 신호가 잡혔지만 아직 커밋되지 않은 변경 또는 진행 중인 ` +
          `백그라운드·위임 작업이 있어 지금 닫을지 뒤로 미룰지 모호합니다 (session_id=${sessionId}). ` +
          `임의로 닫지 말고 AskUserQuestion으로 사용자에게 지금 세션을 닫을지 물어보세요. ` +
          `선택지는 "${CLOSE_RECONFIRM_MARK}"와 "아직, 계속"으로 제시합니다. 사용자가 ` +
          `"${CLOSE_RECONFIRM_MARK}"를 고른 뒤에만 세션 마무리를 진행하세요. 그전에는 ` +
          `마커를 쓰거나 종료 명령을 실행하지 마세요.` +
          brokenNote,
        stopReason: 'session-close incomplete (Layer 3, reconfirm)',
      }),
    );
    return;
  }
  // One-line recovery action. The gate-precise branches below name an EXACT
  // command so "only the marker is missing" stays a one-shot fix — but that
  // command must be a runnable `node <pkg>/scripts/crystallize.mjs` invocation,
  // never a bare `crystallize` (a package.json `bin` that is NOT on PATH in a
  // plugin install → `command not found`). When PKG_ROOT is
  // unresolved we cannot build that path, so fall back to the /hypo:crystallize
  // skill, which resolves its own package root (the same alias the generic
  // branch uses). Passing --session-id writes the per-session marker that clears
  // this block. Surface the transcript path so the close can pass
  // --transcript-path=<path>, which scopes the marker's lint gate to this
  // session's own files (Bug A coherence: a marker written without lint would
  // only let Stop pass for /compact to immediately re-block on the same errors).
  // Quote the paths so the printed command stays copy-paste runnable even when
  // an install/transcript path contains spaces (display text only — never exec'd
  // here).
  const transcriptHint = transcriptPath ? ` --transcript-path="${transcriptPath}"` : '';
  // Recovery command carries EVIDENCE, never the recency-derived close.project.
  // The evidence-backed attribution is a singleton close scope (transcript
  // close-files ∪ this marker's projects); when it is unambiguous, embed it as
  // --project so the re-run is one-shot instead of failing closed for lack of
  // evidence. The session cwd (from the payload) rides along so the re-run's own
  // session-cwd close check runs against the same project this Stop evaluated.
  const scope = gate?.close?.scope || [];
  const evidenceProject = scope.length === 1 ? scope[0] : null;
  const projectHint = evidenceProject ? ` --project=${evidenceProject}` : '';
  const cwdHint = opts.sessionCwd ? ` --session-cwd="${opts.sessionCwd}"` : '';
  const cliBase = PKG_ROOT ? `node "${join(PKG_ROOT, 'scripts', 'crystallize.mjs')}"` : null;
  const markCmd = cliBase
    ? `${cliBase} --mark-session-closed --session-id=${sessionId}${projectHint}${transcriptHint}${cwdHint}`
    : `/hypo:crystallize (session_id=${sessionId}${projectHint}${transcriptHint})`;
  // The log-only escape hatch for a non-project (wiki/tooling-only)
  // session. Offered ONLY as an explicit alternative when a close blocker is
  // present — never as the default recovery, so a real project session is not
  // taught to bypass the close invariant (codex design Finding 3).
  const logOnlyCmd = cliBase
    ? `${cliBase} --mark-session-closed --log-only --session-id=${sessionId}${transcriptHint}`
    : `/hypo:crystallize --log-only (session_id=${sessionId}${transcriptHint})`;
  // Refine the message with the read-only /compact gate result.
  // - gate green → the close is compact-ready and ONLY the marker is missing
  //   (the hand-edit close case: files Written + committed directly, bypassing
  //   the marker writer). Say so precisely + give the one command, instead of
  //   the generic "미완료" that reads as "you never closed".
  // - gate has blockers → surface them so the user fixes the real issue first.
  // - gate null (tooling error/unavailable) → generic message (fail-open).
  let reason;
  if (gate && gate.ok) {
    reason = `[WIKI_AUTOCLOSE] close gate green — only the session-closed marker is missing. Run \`${markCmd}\` to finish (session_id=${sessionId}).`;
  } else if (gate && gate.blockers && gate.blockers.length > 0) {
    const blockers = gate.blockers.map((b) => b.reason).join('; ');
    reason = `[WIKI_AUTOCLOSE] session-close incomplete — resolve: ${blockers}. Then run \`${markCmd}\` (session_id=${sessionId}).`;
    // Only when a project-close blocker is what's holding the session: a
    // non-project session has nothing to close, so offer log-only as the way out
    // (Claude decides whether this session is project-scoped — no auto-attribution).
    // A session-cwd close blocker (the session's own cwd project is unstarted) is
    // the same kind of project-close hold, so it gets the same escape.
    if (gate.blockers.some((b) => b.type === 'close' || b.type === 'close-cwd')) {
      reason += ` If this was a non-project (wiki/tooling-only) session with no project to close, run \`${logOnlyCmd}\` instead (log-only close, no project attribution).`;
    }
  } else {
    reason = `[WIKI_AUTOCLOSE] session-close 미완료 — /hypo:crystallize 실행으로 마무리 (session_id=${sessionId}${transcriptHint}).`;
  }
  console.log(
    JSON.stringify({
      decision: 'block',
      reason: reason + brokenNote,
      stopReason: 'session-close incomplete (Layer 3)',
    }),
  );
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let payload = {};
    try {
      payload = JSON.parse(raw) || {};
    } catch (err) {
      // Any malformed payload is fail-open — we never want a parse error to
      // strand Claude in a blocked Stop with no recovery context.
      process.stderr.write(
        `[hypo-auto-minimal-crystallize] error: ${err?.message ?? String(err)}\n`,
      );
      emitContinue();
      return;
    }

    // 1. loop guard. NEVER write marker here (see file header).
    if (payload.stop_hook_active === true) {
      emitContinue();
      return;
    }

    if (isGateSkipped()) {
      emitContinue();
      return;
    }

    // 2. wiki absent → can't enforce anything meaningful.
    if (!existsSync(HYPO_DIR)) {
      emitContinue();
      return;
    }

    const sessionId = payload.session_id || payload.sessionId || null;
    const transcriptPath = payload.transcript_path || payload.transcriptPath || null;
    // Authoritative session cwd (the one verified cwd source) for the session-cwd
    // close check below. Absent on older Claude Code payloads → the check is skipped.
    const sessionCwd = payload.cwd || null;

    // 3. substantial-session gate. Pure Q&A / incidental-lookup sessions skip
    // the block; mutating sessions AND high-volume read-only investigations
    // (6a) pass through to the close-intent gate.
    if (!isSubstantialSession(transcriptPath)) {
      emitContinue();
      return;
    }

    // 4. close-intent gate. Stop fires every turn; only nudge when the user
    // actually signalled session wrap-up. Without this, a long mutating
    // session is blocked on every turn (PR-C dogfooding regression).
    const userText = transcriptPath ? extractUserMessages(transcriptPath) : '';
    if (!isClosePattern(userText)) {
      emitContinue();
      return;
    }

    // Read-only /compact gate (same precompactGateStatus the real PreCompact hook
    // uses) sharpens the block message and, with sessionCwd, backs the session-cwd
    // close check below. The hook NEVER writes the marker here (file-header
    // invariant); this is read-only. Any error → null → emitBlock falls back to the
    // generic message (fail-open). Computed lazily: the common closed-session path
    // (a project marker whose cwd project is complete) still short-circuits without
    // paying the gate cost, unless a cwd signal makes the cwd check meaningful.
    let gate = null;
    // This session's close verdict (step 5), read once and shared with the
    // gate so its log-only and attribution reading uses the same marker Stop
    // judged, never one the verdict rejected.
    let checkpoint = null;
    const computeGate = () => {
      try {
        // resolveGateProjectOverride (session-close-scope-boundary spec §2/§3): Stop
        // gets no explicit project, only sessionCwd, same as PreCompact. Passed
        // below as `attributionScope` (never `projectOverride`, which is the
        // check-only diagnostic's key and would also disable the mine/foreign
        // partition): this is what demotes a foreign project's dangling close to
        // a notice instead of holding this session's Stop hostage on debt it
        // never touched.
        const attributionScope = resolveGateProjectOverride(HYPO_DIR, { sessionCwd });
        // Which close id proves this session for the gate's cwd check (injected:
        // close-gate-store.mjs imports hypo-shared.mjs).
        const closeGate = closeGateStatus({ transcriptPath, hypoDir: HYPO_DIR, sessionId });
        return precompactGateStatus(HYPO_DIR, {
          closeOpen: closeGate.ok,
          resolvedAtIndex: closeGate.resolvedAtIndex,
          ...(transcriptPath ? { transcriptPath } : {}),
          ...(sessionCwd ? { sessionCwd } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(checkpoint
            ? { closeMarker: isCloseComplete(checkpoint) ? checkpoint.marker : null }
            : {}),
          ...(attributionScope ? { attributionScope } : {}),
        });
      } catch {
        return null;
      }
    };

    // 5. close verdict for this session_id (order in the file header), from
    // closeCheckpointState, the same verdict check, doctor and PreCompact use.
    // A finished close only attests the project(s)/scope it recorded: if THIS
    // session's cwd project still has an unstarted close, honoring it would end
    // the session green while that project stays open (the session-cwd
    // false-green), so the cwd re-check below still runs. A broken checkpoint
    // (receipt and marker disagree) falls through to block and says why.
    let brokenReason = null;
    if (sessionId) {
      checkpoint = closeCheckpointState(HYPO_DIR, sessionId);
      if (isCloseComplete(checkpoint)) {
        const { receipt, marker } = checkpoint;
        // A legacy close has no receipt, so no certified file list to compare
        // the dirty tree against: no unresolved-changes notice, same as before.
        const notice = () => (receipt ? notifyUnresolved(HYPO_DIR, sessionId, receipt) : undefined);
        const isLogOnly = receipt
          ? receipt.scope?.mode === 'log-only'
          : marker.scope === 'log-only';
        if (isLogOnly || !sessionCwd) {
          emitContinue(notice());
          return;
        }
        gate = computeGate();
        const cwdBlocked = !!gate?.blockers?.some((b) => b.type === 'close-cwd');
        if (!cwdBlocked) {
          emitContinue(notice());
          return;
        }
        // finished close, but the session's cwd project close is incomplete:
        // fall through to block, reusing the gate computed above.
      } else if (checkpoint.state === 'broken') {
        brokenReason = checkpoint.reason;
      }
    }

    // 6. block — but only when we have a session_id to address the recovery
    // instruction to. Without one, the marker contract can't be honored, so
    // failing-open is safer than blocking forever.
    if (!sessionId) {
      emitContinue();
      return;
    }

    if (!gate) gate = computeGate();

    // Reconfirm decision (conditional-close-reconfirm): "close" and
    // "work-incomplete" together are exactly the case where the transcript's
    // NL close phrase can't tell "close now" from "close once X is done" —
    // regex can't disambiguate this (see spec background). Narrowed to the
    // work-incomplete signals only: an uncommitted wiki (`git` blocker; real
    // unsaved work) OR pending background work — a non-terminal background task
    // (delegated subagent OR shell, e.g. a deferred push/CI wait) or a
    // scheduled cron wake (hasPendingBackgroundWork). `hot` / `lint` / `close`
    // / `design-history` / `feedback` blockers are real close blockers but not
    // evidence of "later" intent, so they keep the existing wording (unchanged
    // from before this feature).
    const workIncomplete =
      (gate && gate.blockers && gate.blockers.some((b) => b.type === 'git')) ||
      hasPendingBackgroundWork(payload);
    if (workIncomplete && isCloseReconfirmDeclined(transcriptPath)) {
      // The user already answered "아직" to the ambiguous close signal that
      // triggered this Stop turn — suppressing is a continue, not a
      // (differently-worded) block, so it cannot live inside emitBlock.
      emitContinue();
      return;
    }

    emitBlock(sessionId, transcriptPath, gate, {
      reconfirm: workIncomplete,
      sessionCwd,
      brokenReason,
    });
  } catch (err) {
    // Fail-open on any unexpected error.
    process.stderr.write(`[hypo-auto-minimal-crystallize] error: ${err?.message ?? String(err)}\n`);
    emitContinue();
  }
});
