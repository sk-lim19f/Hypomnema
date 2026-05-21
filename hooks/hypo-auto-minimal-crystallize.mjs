#!/usr/bin/env node
/**
 * hypo-auto-minimal-crystallize.mjs — Stop hook (fix #27 PR-C, ADR 0022 Layer 3)
 *
 * Last hook in the Stop chain: a final-line defense that blocks `Stop` when
 * the current session performed mutation work but never produced a verified
 * session-close. Forces Claude to run minimal session-close before the
 * conversation context evaporates.
 *
 * Decision flow (see ADR 0022 amendment 2026-05-19 Q1+Q2 + 2nd amendment Q-close-gate):
 *
 *   1. stop_hook_active === true  → continue       (loop guard; PoC 2026-05-14)
 *   2. wiki absent                 → continue       (fail-open)
 *   3. transcript has zero Edit/Write/MultiEdit/NotebookEdit tool_use
 *                                  → continue       (substantial-session gate)
 *   4. no recent user close-intent → continue       (close-intent gate, see below)
 *   5. readSessionClosedMarker(session_id) valid
 *                                  → continue       (close already verified)
 *   6. otherwise                   → decision:block
 *
 * Close-intent gate (added after PR-C dogfooding revealed every-turn block —
 * codex 2-worker debate 2026-05-19, both REQUEST_CHANGES). Stop fires after
 * EVERY assistant turn, not at session end; blocking on "mutation + no marker"
 * alone nags the user on every turn of a long mutating session. ADR 0022's
 * real intent is "block when the session is ENDING and close is incomplete".
 * We approximate the end signal by reusing isClosePattern() over recent
 * user-message text (the same low-false-positive signal PreCompact uses):
 * only block when the user actually signalled wrap-up ("이만 마치자",
 * "오늘 여기까지", "wrap up", "session close"). last_assistant_message is NOT
 * used — "커밋했습니다"/"작업 완료" type phrases produce false positives.
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
  hasMutatingTranscriptActivity,
  readSessionClosedMarker,
  extractUserMessages,
  isClosePattern,
  isGateSkipped,
} from './hypo-shared.mjs';

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function emitBlock(sessionId) {
  // One-line, skill-first. /hypo:crystallize is the documented session-close
  // alias; passing --session-id there writes the per-session marker that clears
  // this block. CLI fallback + bypass live in commands/crystallize.md, not here
  // — keep the Stop reason terse so the actionable instruction stands out.
  const reason = `[WIKI_AUTOCLOSE] session-close 미완료 — /hypo:crystallize 실행으로 마무리 (session_id=${sessionId}).`;
  console.log(
    JSON.stringify({
      decision: 'block',
      reason,
      stopReason: 'session-close incomplete (fix #27 PR-C / ADR 0022 Layer 3)',
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

    // 3. substantial-session gate. Read-only / Q&A sessions skip the block.
    if (!hasMutatingTranscriptActivity(transcriptPath)) {
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

    emitBlock(sessionId);
  } catch (err) {
    // Fail-open on any unexpected error.
    process.stderr.write(`[hypo-auto-minimal-crystallize] error: ${err?.message ?? String(err)}\n`);
    emitContinue();
  }
});
