#!/usr/bin/env node
/**
 * hypo-compact-guard.mjs — UserPromptSubmit hook
 *
 * Scope: detects "/compact" or "/clear" typed in chat only (Layer 2).
 * The CLI built-in /compact does NOT fire UserPromptSubmit — use personal-wiki-check.mjs
 * (PreCompact hook) as the hard gate for that path. /clear has no PreCompact event, so
 * this hook is the only chat-side gate that can prompt session-close before context wipe.
 *
 * Behavior: if session close is incomplete → instruct Claude to run session close
 * immediately before /compact or /clear.
 */

import {
  lastSubstantialOpIsSession,
  hypoIsClean,
  hotMdIsClean,
  readChecklist,
  isClearCommand,
  isCompactOrClearCommand,
  isGateSkipped,
} from './hypo-shared.mjs';

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = (data.prompt || '').trim();

    if (!isCompactOrClearCommand(prompt) || isGateSkipped()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const detected = isClearCommand(prompt) ? '/clear' : '/compact';

    const hasSession = lastSubstantialOpIsSession();
    const gitStatus = hypoIsClean();
    const hotStatus = hotMdIsClean();

    // Block on uncommitted (real unsaved work); unpushed commits (ahead)
    // are a soft, auto-synced state and must not block /compact or /clear — mirrors
    // the precompactGateStatus demote so the chat-side gate stays consistent.
    if (hasSession && !gitStatus.uncommitted && hotStatus.clean) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const reasons = [
      !hasSession ? 'session log entry missing' : '',
      gitStatus.uncommitted ? gitStatus.reason : '',
      !hotStatus.clean ? hotStatus.reason : '',
    ].filter(Boolean);

    const today = new Date().toISOString().slice(0, 10);
    const checklist = readChecklist(today);
    const body = checklist
      ? `Checklist:\n${checklist}`
      : 'See hypo-guide.md for the session-close checklist.';

    console.log(
      JSON.stringify({
        continue: true,
        additionalContext: [
          `[WIKI_AUTOCLOSE] ${detected} detected — session close incomplete (${reasons.join(', ')}).`,
          `Do NOT wait for user input. Run wiki session close NOW, then retry ${detected}.`,
          ``,
          body,
          ``,
          `To bypass: set HYPO_SKIP_GATE=1`,
        ].join('\n'),
      }),
    );
  } catch (err) {
    // Fail-open: any parse/runtime error must not block the user's prompt.
    process.stderr.write(`[hypo-compact-guard] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
