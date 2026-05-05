#!/usr/bin/env node
/**
 * wiki-compact-guard.mjs — UserPromptSubmit hook
 *
 * Scope: detects "/compact" typed in chat only.
 * The CLI built-in /compact does NOT fire UserPromptSubmit — use personal-wiki-check.mjs
 * (PreCompact hook) as the hard gate for that path.
 *
 * Behavior: if session close is incomplete → instruct Claude to run session close
 * immediately before /compact.
 */

import {
  lastSubstantialOpIsSession,
  wikiIsClean,
  hotMdIsClean,
  readChecklist,
  isCompactCommand,
  isGateSkipped,
} from './wiki-shared.mjs';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data   = JSON.parse(input);
    const prompt = (data.prompt || '').trim();

    if (!isCompactCommand(prompt) || isGateSkipped()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const hasSession = lastSubstantialOpIsSession();
    const gitStatus  = wikiIsClean();
    const hotStatus  = hotMdIsClean();

    if (hasSession && gitStatus.clean && hotStatus.clean) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const reasons = [
      !hasSession      ? 'session log entry missing' : '',
      !gitStatus.clean ? gitStatus.reason : '',
      !hotStatus.clean ? hotStatus.reason : '',
    ].filter(Boolean);

    const today     = new Date().toISOString().slice(0, 10);
    const checklist = readChecklist(today);
    const body      = checklist
      ? `Checklist:\n${checklist}`
      : 'See wiki-guide.md for the session-close checklist.';

    console.log(JSON.stringify({
      continue: true,
      systemMessage: [
        `[WIKI_AUTOCLOSE] /compact detected — session close incomplete (${reasons.join(', ')}).`,
        `Do NOT wait for user input. Run wiki session close NOW, then retry /compact.`,
        ``,
        body,
        ``,
        `To bypass: set HYPO_SKIP_GATE=1`,
      ].join('\n'),
    }));
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
