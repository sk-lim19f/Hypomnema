#!/usr/bin/env node
/**
 * hypo-session-record.mjs — Stop hook
 *
 * Appends an entry to ~/hypomnema/.cache/sessions/index.jsonl for each
 * completed session. The index.jsonl is the **primary** source for
 * scripts/session-audit.mjs (which falls back to ~/.claude/projects/<encoded>/
 * if the index is empty or missing).
 *
 * Silent: never blocks, never emits user-visible output.
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { hostname } from 'os';
import { HYPO_DIR } from './hypo-shared.mjs';

const INDEX_PATH = join(HYPO_DIR, '.cache', 'sessions', 'index.jsonl');

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

    const transcriptPath = payload.transcript_path || payload.transcriptPath || null;
    const sessionId = payload.session_id || payload.sessionId || null;
    if (!transcriptPath || !sessionId) {
      // Older Claude Code (no transcript_path) — fallback path in
      // scripts/session-audit.mjs handles this case.
      emitContinue();
      return;
    }

    if (!existsSync(HYPO_DIR)) {
      emitContinue();
      return;
    }
    mkdirSync(dirname(INDEX_PATH), { recursive: true });

    const entry = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      recorded_at: new Date().toISOString(),
      cwd: payload.cwd || process.cwd(),
      // machine identity for multi-machine audit. index.jsonl lives
      // under .cache/ (gitignored in a normal vault), so this is a LOCAL-only
      // per-session record — accurate for every session, no sync/privacy cost.
      device: hostname() || 'unknown',
    };
    appendFileSync(INDEX_PATH, JSON.stringify(entry) + '\n');
  } catch (err) {
    // Audit is best-effort observability — never let it block session close.
    process.stderr.write(`[hypo-session-record] error: ${err?.message ?? String(err)}\n`);
  }
  emitContinue();
});
