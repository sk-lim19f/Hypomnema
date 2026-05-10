#!/usr/bin/env node
/**
 * personal-wiki-check.mjs — PreCompact hook
 *
 * Hard gate before /compact. Blocks if:
 *   - last substantial wiki op is not a session close
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
  lastSubstantialOpIsSession,
  hypoIsClean,
  hotMdIsClean,
  readChecklist,
  isGateSkipped,
} from './hypo-shared.mjs';

const CRITICAL_FILE = join(homedir(), '.claude', 'state', 'wiki-context-critical.json');

/** Parse JSONL transcript and return concatenated text of user-role messages only. */
function extractUserMessages(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    const tail = lines.slice(-30); // last 30 lines is enough
    return tail.map(line => {
      try {
        const obj = JSON.parse(line);
        if (obj.role !== 'user') return '';
        return typeof obj.content === 'string'
          ? obj.content
          : JSON.stringify(obj.content);
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

  // ── Bypass 2: env var ──
  if (!isGateSkipped() && transcriptPath && existsSync(transcriptPath)) {
    // Only scan user-role messages to avoid matching the block reason text
    // which itself contains "Bypass with HYPO_SKIP_GATE=1"
    const userText = extractUserMessages(transcriptPath);
    if (/HYPO_SKIP_GATE=1/.test(userText)) {
      process.env.HYPO_SKIP_GATE = '1';
    }
  }

  // ── Heavy checks ──
  const today = new Date().toISOString().slice(0, 10);

  const hasSession = lastSubstantialOpIsSession();
  const gitStatus  = hypoIsClean();
  const hotStatus  = hotMdIsClean();

  const lintPath = join(PKG_ROOT ?? HYPO_DIR, 'scripts', 'lint.mjs');
  let lintBlockers = [];
  let lintW8 = [];
  try {
    const r = spawnSync('node', [lintPath, '--json'], {
      encoding: 'utf-8',
      cwd: HYPO_DIR,
      timeout: 30000,
    });
    const parsed = JSON.parse(r.stdout || '{}');
    lintBlockers = parsed.blockers || [];
    lintW8 = (parsed.warnings || []).filter(w => w.id === 'W8');
  } catch { /* fail-open */ }

  const lintOk          = lintBlockers.length === 0;
  const designHistoryOk = lintW8.length === 0;

  if (hasSession && gitStatus.clean && hotStatus.clean && lintOk && designHistoryOk) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // ── Bypass 3: HYPO_SKIP_GATE ──
  if (isGateSkipped()) {
    const skipped = [
      !hasSession      ? 'session log missing'                      : '',
      !gitStatus.clean ? gitStatus.reason                           : '',
      !hotStatus.clean ? hotStatus.reason                           : '',
      !designHistoryOk ? `design-history stale (${lintW8.length})` : '',
    ].filter(Boolean).join(', ');
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[WIKI CHECK] gate bypassed via HYPO_SKIP_GATE=1 (incomplete: ${skipped}).`,
    }));
    return;
  }

  // ── Block ──
  const reasons = [
    !hasSession      ? 'session log entry missing'                                                   : '',
    !gitStatus.clean ? gitStatus.reason                                                              : '',
    !hotStatus.clean ? hotStatus.reason                                                              : '',
    !lintOk          ? `lint blockers: ${lintBlockers.map(b => b.id).join(', ')}`                   : '',
    !designHistoryOk ? `design-history stale: ${lintW8.map(w => w.file.split('/')[1]).join(', ')}` : '',
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
    `  [ ] 10. root hot.md — update ~/wiki/hot.md active project table`,
    `  [ ] 11. updated: field — verify today's date on all touched .md files`,
    `  [ ] 12. git commit & push`,
  ].join('\n');

  console.log(JSON.stringify({
    decision: 'block',
    reason: [
      `[WIKI CHECK — BLOCKING] Session close incomplete. (${reasons.join(', ')})`,
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
