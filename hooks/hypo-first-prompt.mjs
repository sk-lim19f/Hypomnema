#!/usr/bin/env node
/**
 * hypo-first-prompt.mjs — UserPromptSubmit hook
 *
 * Consumes the marker written by hypo-session-start.mjs (source omitted /
 * 'session-start') or hypo-cwd-change.mjs (source 'cwd-change').
 * On the FIRST user prompt after the marker is written, FORCES a one-line
 * resume summary into the reply (the old "answer only if related"
 * conditional is removed; the line is injected unconditionally).
 *
 * hot.md / session-state.md content is NOT re-injected here — the upstream
 * hook already placed it in additionalContext. This hook only forces the LLM
 * to lead with the summary line drawn from that context.
 * Marker expires after 10 minutes.
 */

import { readFileSync, unlinkSync, existsSync } from 'fs';
import { buildOutput, sessionMarkerPath, sanitizeProjForPrompt } from './hypo-shared.mjs';

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
    // a cwd-change re-trigger says "Resuming"; a fresh session start
    // (default source) says "Previously working on".
    const verb = marker.source === 'cwd-change' ? 'Resuming' : 'Previously working on';
    // marker.proj originates from a wiki directory name read by findProjectFiles;
    // sanitize via the shared helper so a hand-crafted project name cannot close
    // the wrapper tag, smuggle newlines/control chars, or inject conflicting
    // directives into the resume contract (codex v2 review 2026-05-26).
    const projSafe = sanitizeProjForPrompt(marker.proj);
    // When there is no snapshot, the [HOT] / [SESSION STATE] context has nothing
    // for the model to fill the placeholders with. Provide a concrete fallback
    // line so the model doesn't leak literal `[one-line summary]` text on a
    // first-ever session (codex v2 review 2026-05-26).
    const exampleLine = hasSnapshot
      ? `${verb} ${projSafe}: [one-line summary]. Continue with [next task]?`
      : `${verb} ${projSafe}: no prior snapshot yet — first session. What would you like to start with?`;
    const fillNote = hasSnapshot
      ? `Replace the bracketed placeholders using the [HOT] / [SESSION STATE] ` +
        `context already injected this session — do NOT emit the literal brackets.`
      : `Use the line above verbatim — there is no prior snapshot to summarize.`;

    console.log(
      JSON.stringify(
        buildOutput(
          `<hypomnema-session-resume>\n` +
            `[WIKI SESSION START: project=${projSafe}${snapshotNote}]\n` +
            `\n` +
            `Lead your FIRST reply this session with exactly one line in this shape:\n` +
            `\n` +
            `${exampleLine}\n` +
            `\n` +
            `${fillNote}\n` +
            `\n` +
            `Emit this line unconditionally on the first prompt, including when the ` +
            `user's message is:\n` +
            `  • a simple greeting ("안녕", "hi", "hello")\n` +
            `  • a trivial question or unrelated topic\n` +
            `  • a one-word reply\n` +
            `\n` +
            `Do not skip it, do not decide it is "not relevant", do not shorten the ` +
            `reply to omit it. After the line, answer the user's actual message on the ` +
            `following line(s) as normal.\n` +
            `\n` +
            `This is the Hypomnema session-resume contract — the user relies on this ` +
            `line to confirm which project context is loaded.\n` +
            `</hypomnema-session-resume>`,
          { continue: true, suppressOutput: true },
        ),
      ),
    );
  } catch (err) {
    process.stderr.write(`[hypo-first-prompt] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
