#!/usr/bin/env node
/**
 * hypo-first-prompt.mjs — UserPromptSubmit hook
 *
 * Consumes the marker written by wiki-session-start.mjs.
 * On the FIRST user prompt of a new session, injects a lightweight decision
 * instruction so the LLM can decide whether to announce the resume context.
 *
 * hot.md content is NOT re-injected here — wiki-session-start.mjs already
 * injected it on SessionStart. Only the decision hint is added.
 * Marker expires after 10 minutes.
 */

import { readFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildOutput } from './hypo-shared.mjs';

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
    const sessionId = data.session_id || 'default';
    const MARKER_FILE = join(tmpdir(), `hypo-session-marker-${sessionId}.json`);

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

    console.log(
      JSON.stringify(
        buildOutput(
          `[WIKI SESSION START: project=${marker.proj}${snapshotNote}]\nDecision hint: if the first message relates to this project → answer first, then add one line "Previously working on ${marker.proj} — continue?" If unrelated / simple Q&A → answer only, no mention.`,
          { continue: true, suppressOutput: true },
        ),
      ),
    );
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
