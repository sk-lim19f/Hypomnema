#!/usr/bin/env node
/**
 * hypo-compact-guard.mjs — UserPromptSubmit hook
 *
 * Scope: detects "/compact" or "/clear" typed in chat only (Layer 2).
 * The CLI built-in /compact does NOT fire UserPromptSubmit. The PreCompact hook
 * (hypo-personal-check.mjs) covers that path, but it only REPORTS: since the
 * session-close-scope-boundary change it never blocks /compact. /clear has no
 * PreCompact event at all, so this hook is the only chat-side gate that can
 * prompt session-close before a context wipe.
 *
 * Behavior: if session close is incomplete, tell Claude so (a description, not
 * an instruction — session-close-scope-boundary spec §5) before /compact or
 * /clear runs.
 *
 * This hook never calls precompactGateStatus: its own hooks.json timeout is
 * 10s and the gate's lint spawn alone budgets 30s, three times over. Instead
 * it re-checks only the cheap axes (session log, git, hot.md) directly, and
 * narrows the git axis with the SAME project-vs-foreign path rule the gate
 * uses (isForeignProjectFile / classifyForeignOnlyDirty in hypo-shared.mjs), so
 * a different project's dangling close file does not fire a false alarm here
 * either. Unlike the gate, this hook never passes transcriptTouched into that
 * rule: parsing the transcript is exactly the evidence spec §5 excludes to
 * stay inside the 10s budget, so only the cheap path-prefix axis runs here.
 */

import {
  lastSubstantialOpIsSession,
  hypoIsClean,
  gitDirtyFiles,
  hotMdIsClean,
  readChecklist,
  isClearCommand,
  isCompactOrClearCommand,
  isGateSkipped,
  resolveGateProjectOverride,
  classifyForeignOnlyDirty,
  buildOutput,
  HYPO_DIR,
} from './hypo-shared.mjs';

// A fixed slice of this hook's own 10s hooks.json budget (hooks.json:60),
// shared as ONE deadline across every git spawn hypoIsClean and
// gitDirtyFiles make below (up to four): each call re-checks the time left
// and skips its own spawn once the shared budget is spent, so no NEW spawn
// starts once this budget is gone. That bounds the git-spawn total, not the
// hook's wall-clock time end to end: measured 145ms on a normal run and
// 6273ms with a slow fsmonitor in the mix, both inside the 10s hooks.json
// timeout, but a spawnSync child that outlives a SIGTERM has no coded upper
// bound here.
const GIT_DEADLINE_BUDGET_MS = 6000;

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

    // These two run on EVERY /compact or /clear, unlike resolveGateProjectOverride
    // below (which only runs when gitStatus.uncommitted is already true). A
    // throw here would reach the outermost catch on every single prompt, not
    // just the git-dirty ones, so the exposure is wider than the resolveGate
    // case: fail closed locally instead ("reason present"), never fail open
    // ("looks clean"). A read failure on either file is not the same fact as
    // that file being genuinely absent or well-formed, so the fallback reason
    // says "unreadable", not "missing" or "invalid", to keep the two causes
    // tellable apart from the additionalContext text alone.
    // lastSubstantialOpIsSession() now reads a MISSING log.md (ENOENT) as
    // `false`, and reads only via a single readFileSync call (no separate
    // existsSync precheck), so there is no check-then-read window where the
    // file is deleted between the two and falls back to the old fail-open
    // `true`. That keeps state-table row 1 (spec §5, "session log entry
    // missing") surfaced: a brand-new vault with an all-foreign dirty tree
    // and a clean hot.md still reports the missing log instead of going
    // fully silent. Any OTHER read failure (EISDIR, EACCES, ...) is a real
    // problem, so the function rethrows it, and the try/catch below turns
    // that into the same fail-closed `hasSession = false` plus a stderr line.
    let hasSession;
    try {
      hasSession = lastSubstantialOpIsSession();
    } catch (err) {
      process.stderr.write(
        `[hypo-compact-guard] error: lastSubstantialOpIsSession failed, treating as session log entry missing: ${err?.message ?? String(err)}\n`,
      );
      hasSession = false;
    }
    const deadline = { end: performance.now() + GIT_DEADLINE_BUDGET_MS };
    const gitStatus = hypoIsClean(undefined, { deadline });
    let hotStatus;
    try {
      hotStatus = hotMdIsClean();
    } catch (err) {
      process.stderr.write(
        `[hypo-compact-guard] error: hotMdIsClean failed, treating as hot.md unreadable: ${err?.message ?? String(err)}\n`,
      );
      hotStatus = { clean: false, reason: `hot.md unreadable: ${err?.message ?? String(err)}` };
    }

    // Uncommitted (real unsaved work) blocks; unpushed commits (ahead) are a
    // soft, auto-synced state and never reach `gitStatus.reason` here, since
    // `uncommitted` is what gates it — mirrors the precompactGateStatus
    // demote so the chat-side gate stays consistent.
    let gitReason = gitStatus.uncommitted ? gitStatus.reason : '';
    if (gitStatus.uncommitted) {
      // resolveGateProjectOverride (session-close-scope-boundary spec §2):
      // the same cwd-to-project resolution PreCompact and Stop already use.
      // null just means "no project this cwd unambiguously owns" — that
      // keeps the git axis judged globally, exactly like today. Scoped
      // inside `uncommitted` on purpose: it only narrows the git notice, so
      // a clean /compact has no reason to pay for a projects/ scan.
      //
      // Unlike classifyForeignOnlyDirty, this call is NOT contract-bound to
      // stay silent: it walks through collectProjectWorkingDirs' own
      // readdirSync, which sits outside that function's try/catch. Left
      // uncaught here, that throw would escape past this hook's git-axis
      // logic into the outermost catch and come back as a FULLY suppressed
      // {suppressOutput:true} — silently dropping the session-log and
      // hot.md reasons too, not just this one. Catch it locally and demote
      // to null (its own "no project" sentinel) so a broken vault still
      // gets every reason it is due.
      let attributionScope = null;
      try {
        attributionScope = resolveGateProjectOverride(HYPO_DIR, {
          sessionCwd: data.cwd ?? null,
        });
      } catch (err) {
        process.stderr.write(
          `[hypo-compact-guard] error: resolveGateProjectOverride failed, treating as no override: ${err?.message ?? String(err)}\n`,
        );
      }
      if (attributionScope) {
        const dirty = gitDirtyFiles(HYPO_DIR, { deadline });
        const classification = classifyForeignOnlyDirty(HYPO_DIR, dirty, {
          effectiveOverride: attributionScope,
        });
        if (classification === 'foreign-only') gitReason = '';
      }
    }

    const reasons = [
      !hasSession ? 'session log entry missing' : '',
      gitReason,
      !hotStatus.clean ? hotStatus.reason : '',
    ].filter(Boolean);

    if (reasons.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const checklist = readChecklist(today);
    const body = checklist
      ? `Checklist:\n${checklist}`
      : 'See hypo-guide.md for the session-close checklist.';

    console.log(
      JSON.stringify(
        buildOutput(
          'UserPromptSubmit',
          [
            `[WIKI_AUTOCLOSE] ${detected} detected: session close incomplete (${reasons.join(', ')}).`,
            ``,
            body,
            ``,
            `To bypass: set HYPO_SKIP_GATE=1`,
          ].join('\n'),
          { continue: true },
        ),
      ),
    );
  } catch (err) {
    // Fail-open: any parse/runtime error must not block the user's prompt.
    process.stderr.write(`[hypo-compact-guard] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
