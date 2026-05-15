#!/usr/bin/env node
/**
 * hypo-personal-check.mjs — PreCompact hook
 *
 * Hard gate before /compact. Blocks if:
 *   - the session-close memory files were not updated this session (fix #17:
 *     session-state.md, project hot.md, root hot.md, session-log, log.md)
 *   - wiki git repo has uncommitted/unpushed changes
 *   - hot.md has forbidden structure
 *   - lint blockers exist
 *
 * Bypass options (checked in order, short-circuits before heavy checks):
 *   1. wiki-context-critical.json exists (context ≥ 90% — hard limit imminent)
 *   2. HYPO_SKIP_GATE=1 env var
 *   3. HYPO_SKIP_GATE=1 in a recent *user-role* transcript message
 *      (assistant/tool output is excluded to prevent self-triggering from block reason text)
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import {
  HYPO_DIR,
  PKG_ROOT,
  hypoIsClean,
  hotMdIsClean,
  sessionCloseFileStatus,
  readChecklist,
  isGateSkipped,
  isClosePattern,
} from './hypo-shared.mjs';

const CRITICAL_FILE = join(homedir(), '.claude', 'state', 'wiki-context-critical.json');
const WARNING_FILE  = join(homedir(), '.claude', 'state', 'wiki-context-warning.json');

/** Parse JSONL transcript and return concatenated text of user-role messages only.
 *
 * Claude Code transcript format: each line is `{ type: "user", message: { role: "user", content: ... } }`.
 * Older shape (`{ role, content }` at top level) is also accepted for forward compatibility.
 */
function extractUserMessages(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    const tail = lines.slice(-30); // last 30 lines is enough
    return tail.map(line => {
      try {
        const obj = JSON.parse(line);
        const msg = obj.message ?? obj;
        const role = msg.role ?? obj.role ?? obj.type;
        if (role !== 'user') return '';
        const content = msg.content ?? obj.content;
        return typeof content === 'string' ? content : JSON.stringify(content);
      } catch { return ''; }
    }).join('\n');
  } catch { return ''; }
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  let transcriptPath = null;
  try {
    const input = JSON.parse(raw || '{}');
    transcriptPath = input.transcript_path ?? null;
  } catch { /* fail-open */ }

  // ── Bypass 1: context critical (≥90%) — short-circuit BEFORE all checks ──
  if (existsSync(CRITICAL_FILE)) {
    try { unlinkSync(CRITICAL_FILE); } catch {}
    console.log(JSON.stringify({
      continue: true,
      systemMessage: '[WIKI CHECK] gate auto-bypassed (context ≥90% critical). Session close pending next session.',
    }));
    return;
  }

  // ── Block 1.5: context warning (≥70%) — request session-compact before compact ──
  if (existsSync(WARNING_FILE)) {
    try { unlinkSync(WARNING_FILE); } catch {}
    console.log(JSON.stringify({
      decision: 'block',
      reason: [
        `[WIKI CHECK — BLOCKING] Context ≥70%: run /session-compact before compacting.`,
        `STOP. Do NOT compact yet.`,
        `1. If Skill tool is available: call it with skill="session-compact" immediately.`,
        `2. If Skill tool is unavailable: perform the full session-close checklist from hypo-guide.md.`,
        `After session close completes, compact will proceed normally.`,
        ``,
        `To skip: set HYPO_SKIP_GATE=1`,
      ].join('\n'),
    }));
    return;
  }

  // ── Transcript scan (Bypass 2 + #20 close-intent detection) ──
  let hasCloseIntent = false;
  if (transcriptPath && existsSync(transcriptPath)) {
    const userText = extractUserMessages(transcriptPath);
    // Bypass 2: user-role "HYPO_SKIP_GATE=1" (scan before gate so bypass takes effect)
    if (!isGateSkipped() && /HYPO_SKIP_GATE=1/.test(userText)) {
      process.env.HYPO_SKIP_GATE = '1';
    }
    // #20: natural-language close-intent detection (informational — enriches block message)
    hasCloseIntent = isClosePattern(userText);
  }

  // ── Heavy checks ──
  const today = new Date().toISOString().slice(0, 10);

  const gitStatus  = hypoIsClean();
  const hotStatus  = hotMdIsClean();
  // fix #17: strict session-close (steps 1~6 of the 11-step crystallize
  // checklist). closeFiles gates the 5 mandatory files (steps 1-4 + log.md);
  // open-questions.md (step 5) is conditional ("변경 시") and intentionally
  // ungated — see hypo-shared.mjs sessionCloseFileStatus and spec §5.2.7.
  const closeFiles = sessionCloseFileStatus(HYPO_DIR);
  const closeFilesReason = closeFiles.ok ? '' : `memory files not updated this session: ${
    [
      ...closeFiles.missing.map(f => `${f} (missing)`),
      ...closeFiles.stale.map(f => `${f} (stale)`),
    ].join(', ')
  }`;

  const lintPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'lint.mjs') : null;
  let lintBlockers = [];
  let lintW8 = [];
  let lintSkipped = false;
  if (!lintPath || !existsSync(lintPath)) {
    lintSkipped = true;
  } else {
    try {
      const r = spawnSync('node', [lintPath, '--json'], {
        encoding: 'utf-8',
        cwd: HYPO_DIR,
        timeout: 30000,
      });
      const parsed = JSON.parse(r.stdout || '{}');
      lintBlockers = parsed.errors || [];
      lintW8 = (parsed.warns || []).filter(w => w.id === 'W8');
    } catch { /* fail-open */ }
  }

  const lintOk          = lintBlockers.length === 0;
  const designHistoryOk = lintW8.length === 0;

  if (gitStatus.clean && hotStatus.clean && lintOk && designHistoryOk && closeFiles.ok) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // ── Bypass 3: HYPO_SKIP_GATE ──
  if (isGateSkipped()) {
    const skipped = [
      !gitStatus.clean ? gitStatus.reason                           : '',
      !hotStatus.clean ? hotStatus.reason                           : '',
      !closeFiles.ok   ? closeFilesReason                           : '',
      !designHistoryOk ? `design-history stale (${lintW8.length})` : '',
      lintSkipped      ? 'lint skipped (hypo-pkg.json missing)'     : '',
    ].filter(Boolean).join(', ');
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[WIKI CHECK] gate bypassed via HYPO_SKIP_GATE=1 (incomplete: ${skipped}).`,
    }));
    return;
  }

  // ── Block ──
  const reasons = [
    !gitStatus.clean ? gitStatus.reason                                                              : '',
    !hotStatus.clean ? hotStatus.reason                                                              : '',
    !closeFiles.ok   ? closeFilesReason                                                              : '',
    !lintOk          ? `lint blockers: ${lintBlockers.map(b => b.id).join(', ')}`                   : '',
    !designHistoryOk ? `design-history stale: ${lintW8.map(w => w.file.split('/')[1]).join(', ')}` : '',
    lintSkipped      ? 'lint skipped (run `hypomnema init` to enable lint gate)'                    : '',
  ].filter(Boolean);

  const checklist     = readChecklist(today);
  const checklistText = checklist ?? [
    `  [ ] 0. Read SCHEMA.md + hypo-guide.md (required before wiki work)`,
    `  [ ] 1. PRD       — create projects/<name>/prd.md if missing`,
    `  [ ] 2. ADR       — decide yes/no on 5 types; if all N, note "no ADR — reason: <why>"`,
    `  [ ] 3. Ingest    — if new external knowledge, save to sources/ and ingest`,
    `  [ ] 4. Pages     — extract new concepts/patterns to pages/`,
    `  [ ] 5. Synthesis — if 3+ cross-page analysis results, save to pages/syntheses/`,
    `  [ ] 6. session-log — append to projects/<name>/session-log/YYYY-MM.md`,
    `  [ ] 7. index.md  — update Projects section if needed`,
    `  [ ] 8. log.md    — append ## [${today}] session | <project-name>`,
    `  [ ] 9. hot.md    — update projects/<name>/hot.md (no exceptions)`,
    `  [ ] 10. root hot.md — update ~/hypomnema/hot.md active project table`,
    `  [ ] 11. updated: field — verify today's date on all touched .md files`,
    `  [ ] 12. git commit & push`,
  ].join('\n');

  const closeIntentNote = hasCloseIntent
    ? `[Close intent detected in recent messages — completing session close first.]\n`
    : '';

  console.log(JSON.stringify({
    decision: 'block',
    reason: [
      `${closeIntentNote}[WIKI CHECK — BLOCKING] Session close incomplete. (${reasons.join(', ')})`,
      `Run the checklist below in order, then retry /compact:`,
      ``,
      checklistText,
      ``,
      `Trivial session? Bypass with HYPO_SKIP_GATE=1`,
    ].join('\n'),
    continue: false,
    stopReason: `Session close incomplete: ${reasons.join(', ')}`,
  }));
});
