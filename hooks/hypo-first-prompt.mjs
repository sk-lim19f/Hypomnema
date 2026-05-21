#!/usr/bin/env node
/**
 * hypo-first-prompt.mjs — UserPromptSubmit hook
 *
 * Consumes the marker written by hypo-session-start.mjs (source omitted /
 * 'session-start') or hypo-cwd-change.mjs (source 'cwd-change', fix #13).
 * On the FIRST user prompt after the marker is written, FORCES a one-line
 * resume summary into the reply (fix #3 — the old "answer only if related"
 * conditional is removed; the line is injected unconditionally).
 *
 * hot.md / session-state.md content is NOT re-injected here — the upstream
 * hook already placed it in additionalContext. This hook only forces the LLM
 * to lead with the summary line drawn from that context.
 * Marker expires after 10 minutes.
 */

import { readFileSync, unlinkSync, existsSync } from 'fs';
import { buildOutput, sessionMarkerPath } from './hypo-shared.mjs';

const MARKER_TTL = 10 * 60 * 1000; // 10 min

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}
    const MARKER_FILE = sessionMarkerPath(data.session_id);

    if (!existsSync(MARKER_FILE)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const marker = JSON.parse(readFileSync(MARKER_FILE, 'utf-8'));
    const age = Date.now() - (marker.ts || 0);

    try {
      unlinkSync(MARKER_FILE);
    } catch {}

    if (age > MARKER_TTL) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const hasSnapshot = marker.hasSnapshot ?? (marker.hotPath && existsSync(marker.hotPath));
    const snapshotNote = hasSnapshot ? '' : ' (no snapshot yet — first session)';
    // fix #13: a cwd-change re-trigger says "Resuming"; a fresh session start
    // (default source) says "Previously working on".
    const verb = marker.source === 'cwd-change' ? 'Resuming' : 'Previously working on';

    console.log(
      JSON.stringify(
        buildOutput(
          `[WIKI SESSION START: project=${marker.proj}${snapshotNote}]\n` +
            `Before addressing the user's message, lead your FIRST reply with exactly one line:\n` +
            `"${verb} ${marker.proj}: <one-line summary>. Continue with <next task>?"\n` +
            `Draw <one-line summary> and <next task> from the [HOT] / [SESSION STATE] ` +
            `context already injected this session. Inject this line unconditionally — ` +
            `even if the user's first message is unrelated or a simple question — then answer normally.`,
          { continue: true, suppressOutput: true },
        ),
      ),
    );
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
