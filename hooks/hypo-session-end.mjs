#!/usr/bin/env node
/**
 * hypo-session-end.mjs — SessionEnd hook (Layer 2)
 *
 * `/clear` cannot be blocked: it never fires UserPromptSubmit (Stage 0 PoC,
 * 2026-05-14). The only intervention point is the SessionEnd(reason='clear')
 * → SessionStart(source='clear') pair. This hook captures the dying session's
 * identity into `.cache/clear-marker.json` so hypo-session-start can issue a
 * recovery nudge on the next session.
 *
 * Scope: writing the marker on reason='clear' only. Other reasons
 * ('prompt_input_exit', 'logout', etc.) are deliberate user exits and need no
 * recovery — touching them would pollute the unrelated next session.
 *
 * Silent: never blocks, never emits user-visible output. Failures are stderr
 * debug lines only.
 */

import { HYPO_DIR, writeClearMarker } from './hypo-shared.mjs';
import { existsSync } from 'fs';

function emitContinue() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let payload = {};
    try {
      payload = JSON.parse(raw) || {};
    } catch {}

    const reason = payload.reason || '';
    if (reason !== 'clear') {
      emitContinue();
      return;
    }

    // Wiki absent → nothing to recover into; skip silently.
    if (!existsSync(HYPO_DIR)) {
      emitContinue();
      return;
    }

    writeClearMarker(HYPO_DIR, {
      prev_session_id: payload.session_id || payload.sessionId || null,
      prev_transcript_path: payload.transcript_path || payload.transcriptPath || null,
      prev_cwd: payload.cwd || null,
    });
  } catch (err) {
    // Best-effort: a marker failure must not break /clear itself.
    process.stderr.write(`[hypo-session-end] error: ${err?.message ?? String(err)}\n`);
  }
  emitContinue();
});
