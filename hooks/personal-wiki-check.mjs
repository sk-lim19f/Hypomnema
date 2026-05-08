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
 * Bypass: set HYPO_SKIP_GATE=1.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  WIKI_DIR,
  PKG_ROOT,
  lastSubstantialOpIsSession,
  wikiIsClean,
  hotMdIsClean,
  readChecklist,
  isGateSkipped,
} from './wiki-shared.mjs';

const today = new Date().toISOString().slice(0, 10);

const hasSession = lastSubstantialOpIsSession();
const gitStatus  = wikiIsClean();
const hotStatus  = hotMdIsClean();

// Lint blocker check (non-fatal if lint script missing)
const lintPath = join(PKG_ROOT ?? WIKI_DIR, 'scripts', 'lint.mjs');
let lintBlockers = [];
let lintW8 = [];
try {
  const r = spawnSync('node', [lintPath, '--json'], {
    encoding: 'utf-8',
    cwd: WIKI_DIR,
    timeout: 30000,
  });
  const parsed = JSON.parse(r.stdout || '{}');
  lintBlockers = parsed.blockers || [];
  lintW8 = (parsed.warnings || []).filter(w => w.id === 'W8');
} catch {
  // Fail-open: lint script missing or broken must not block compaction.
}
const lintOk           = lintBlockers.length === 0;
const designHistoryOk  = lintW8.length === 0;

if (hasSession && gitStatus.clean && hotStatus.clean && lintOk && designHistoryOk) {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
} else {
  if (isGateSkipped()) {
    const skipped = [
      !hasSession          ? 'session log missing'    : '',
      !gitStatus.clean     ? gitStatus.reason         : '',
      !hotStatus.clean     ? hotStatus.reason         : '',
      !designHistoryOk     ? `design-history stale (${lintW8.length})` : '',
    ].filter(Boolean).join(', ');
    // PreCompact does not support additionalContext — use systemMessage (universal field).
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[WIKI CHECK] gate bypassed via HYPO_SKIP_GATE=1 (incomplete: ${skipped}).`,
    }));
  } else {
    const reasons = [
      !hasSession      ? 'session log entry missing'  : '',
      !gitStatus.clean ? gitStatus.reason             : '',
      !hotStatus.clean ? hotStatus.reason             : '',
      !lintOk          ? `lint blockers: ${lintBlockers.map(b => b.id).join(', ')}` : '',
      !designHistoryOk ? `design-history stale: ${lintW8.map(w => w.file.split('/')[1]).join(', ')}` : '',
    ].filter(Boolean);

    const checklist     = readChecklist(today);
    const checklistText = checklist ?? [
      `  [ ] 0. Read SCHEMA.md + wiki-guide.md (required before wiki work)`,
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
  }
}
