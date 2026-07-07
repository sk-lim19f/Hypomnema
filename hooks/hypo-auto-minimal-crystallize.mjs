#!/usr/bin/env node
/**
 * hypo-auto-minimal-crystallize.mjs — Stop hook (Layer 3)
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
 *   5. readSessionClosedMarker(session_id) valid
 *                                  → continue       (close already verified)
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
 * (an uncommitted wiki, or an in-flight delegated subagent per
 * hasInFlightSubagent), step 6's block reason is replaced with an
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

import { existsSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  PKG_ROOT,
  isSubstantialSession,
  readSessionClosedMarker,
  extractUserMessages,
  isClosePattern,
  isGateSkipped,
  precompactGateStatus,
  hasInFlightSubagent,
  isCloseReconfirmDeclined,
  CLOSE_RECONFIRM_MARK,
} from './hypo-shared.mjs';

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
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
  if (opts.reconfirm) {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason:
          `[WIKI_AUTOCLOSE] close 신호가 잡혔지만 아직 커밋되지 않은 변경(또는 진행 중인 ` +
          `위임 작업)이 있어 지금 닫을지 뒤로 미룰지 모호합니다 (session_id=${sessionId}). ` +
          `임의로 닫지 말고 AskUserQuestion으로 사용자에게 지금 세션을 닫을지 물어보세요. ` +
          `선택지는 "${CLOSE_RECONFIRM_MARK}"와 "아직, 계속"으로 제시합니다. 사용자가 ` +
          `"${CLOSE_RECONFIRM_MARK}"를 고른 뒤에만 세션 마무리를 진행하세요. 그전에는 ` +
          `마커를 쓰거나 종료 명령을 실행하지 마세요.`,
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
  const cliBase = PKG_ROOT ? `node "${join(PKG_ROOT, 'scripts', 'crystallize.mjs')}"` : null;
  const markCmd = cliBase
    ? `${cliBase} --mark-session-closed --session-id=${sessionId}${transcriptHint}`
    : `/hypo:crystallize (session_id=${sessionId}${transcriptHint})`;
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
    if (gate.blockers.some((b) => b.type === 'close')) {
      reason += ` If this was a non-project (wiki/tooling-only) session with no project to close, run \`${logOnlyCmd}\` instead (log-only close, no project attribution).`;
    }
  } else {
    reason = `[WIKI_AUTOCLOSE] session-close 미완료 — /hypo:crystallize 실행으로 마무리 (session_id=${sessionId}${transcriptHint}).`;
  }
  console.log(
    JSON.stringify({
      decision: 'block',
      reason,
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

    // 5. close already verified for this session_id.
    if (sessionId && readSessionClosedMarker(HYPO_DIR, sessionId)) {
      emitContinue();
      return;
    }

    // 6. block — but only when we have a session_id to address the recovery
    // instruction to. Without one, the marker contract can't be honored, so
    // failing-open is safer than blocking forever.
    if (!sessionId) {
      emitContinue();
      return;
    }

    // Read-only /compact gate (same precompactGateStatus the real
    // PreCompact hook uses) sharpens the block message — distinguishes "close
    // is compact-ready, only the marker is missing" from "there are real
    // blockers". The hook NEVER writes the marker here (file-header invariant);
    // this is read-only. Any error → null → emitBlock falls back to the generic
    // message (fail-open).
    let gate = null;
    try {
      gate = precompactGateStatus(HYPO_DIR, transcriptPath ? { transcriptPath } : {});
    } catch {
      gate = null;
    }

    // Reconfirm decision (conditional-close-reconfirm): "close" and
    // "work-incomplete" together are exactly the case where the transcript's
    // NL close phrase can't tell "close now" from "close once X is done" —
    // regex can't disambiguate this (see spec background). Narrowed to the
    // two work-incomplete signals only: an uncommitted wiki (`git` blocker;
    // real unsaved work) OR an in-flight delegated subagent. `hot` / `lint` /
    // `close` / `design-history` / `feedback` blockers are real close
    // blockers but not evidence of "later" intent, so they keep the existing
    // wording (unchanged from before this feature).
    const workIncomplete =
      (gate && gate.blockers && gate.blockers.some((b) => b.type === 'git')) ||
      hasInFlightSubagent(payload);
    if (workIncomplete && isCloseReconfirmDeclined(transcriptPath)) {
      // The user already answered "아직" to the ambiguous close signal that
      // triggered this Stop turn — suppressing is a continue, not a
      // (differently-worded) block, so it cannot live inside emitBlock.
      emitContinue();
      return;
    }

    emitBlock(sessionId, transcriptPath, gate, { reconfirm: workIncomplete });
  } catch (err) {
    // Fail-open on any unexpected error.
    process.stderr.write(`[hypo-auto-minimal-crystallize] error: ${err?.message ?? String(err)}\n`);
    emitContinue();
  }
});
