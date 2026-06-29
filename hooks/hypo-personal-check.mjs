#!/usr/bin/env node
/**
 * hypo-personal-check.mjs — PreCompact hook
 *
 * Hard gate before /compact. Blocks if:
 *   - the session-close memory files were not updated this session
 *     (session-state.md, project hot.md, root hot.md, session-log, log.md)
 *   - wiki git repo has uncommitted/unpushed changes
 *   - hot.md has forbidden structure
 *   - lint blockers exist
 *
 * Bypass options (checked in order, per spec §7.5):
 *   1. HYPO_SKIP_GATE=1 env var
 *   2. HYPO_SKIP_GATE=1 in a recent *user-role* transcript message
 *      (assistant/tool output is excluded to prevent self-triggering from block reason text)
 *
 * NOTE: capacity bypass (wiki-context-critical.json ≥90%) was REMOVED
 * (amendment 2026-05-13). Spec §7.5: even at full context, minimal
 * session-close is mandatory — auto-bypass on capacity caused silent state loss.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import {
  HYPO_DIR,
  PKG_ROOT,
  precompactGateStatus,
  readChecklist,
  isGateSkipped,
  isClosePattern,
  extractUserMessages,
  isUnderProjectDirs,
} from './hypo-shared.mjs';

const WARNING_FILE = join(homedir(), '.claude', 'state', 'wiki-context-warning.json');

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let transcriptPath = null;
  let sessionId = null;
  try {
    const input = JSON.parse(raw || '{}');
    transcriptPath = input.transcript_path ?? null;
    // A log-only marker for this session activates log-only gate
    // semantics (no project attribution) so /compact does not block a closed
    // non-project session on the active/phantom project's files.
    sessionId = input.session_id ?? input.sessionId ?? null;
  } catch {
    /* fail-open */
  }

  // ── Capacity bypass (≥90%) REMOVED: amendment 2026-05-13.
  //    Even at full context, minimal session-close is mandatory (spec §7.5).
  //    Bypass paths are now only: HYPO_SKIP_GATE env / HYPO_SKIP_GATE in transcript.

  // ── Block 1.5: context warning (≥70%) — request session-compact before compact ──
  if (existsSync(WARNING_FILE)) {
    try {
      unlinkSync(WARNING_FILE);
    } catch {}
    console.log(
      JSON.stringify({
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
      }),
    );
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

  // The full PreCompact gate decision, single-sourced. The SAME
  // function backs `crystallize --check-session-close`, so a green self-check
  // there means this hook will not block. precompactGateStatus runs git-clean +
  // hot.md structure + session-close files (global invariant) + scoped
  // lint + W8 design-history + feedback projection. The transcript widens the
  // lint scope to this session's edited files; without one the scope
  // is the mandatory close files. Read-only: pure feedback drift comes back as
  // gate.driftTargets, a self-heal effect requirement we run as --write below.
  let gate;
  try {
    gate = precompactGateStatus(HYPO_DIR, {
      transcriptPath,
      ...(sessionId ? { sessionId } : {}),
    });
  } catch (err) {
    // Defense-in-depth: precompactGateStatus fails open per-check, but if it ever
    // throws, never crash the PreCompact hook — fail open (continue) so a tooling
    // fault can't wedge /compact.
    process.stderr.write(`[hypo-personal-check] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Self-heal pure feedback projection drift: the one mutation the
  // read-only gate leaves to the caller. Fails CLOSED — if the --write errors we
  // turn the (otherwise non-blocking) drift into a blocker, since real drift is
  // confirmed and silently passing it would defeat the gate. --write only applies
  // when no target conflicts/over-caps (code===0 across ALL targets), so a late
  // race exits non-zero and blocks here. It is semantic-preflight atomic but not
  // filesystem-atomic (concurrent edit / mid-write I/O fault is best-effort) —
  // pre-existing engine behavior, not introduced by the self-heal.
  let feedbackHealed = '';
  if (gate.ok && gate.driftTargets.length > 0) {
    const feedbackPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'feedback-sync.mjs') : null;
    const w = feedbackPath
      ? spawnSync(
          process.execPath,
          [
            feedbackPath,
            '--write',
            '--no-input',
            `--hypo-dir=${HYPO_DIR}`,
            `--claude-home=${join(homedir(), '.claude')}`,
          ],
          { encoding: 'utf-8', timeout: 30000 },
        )
      : { status: 1 };
    if (w.error || w.status === null || w.status !== 0) {
      gate.ok = false;
      gate.blockers.push({
        type: 'feedback',
        reason: `feedback projection drift (${gate.driftTargets.join(', ')}) — auto-sync failed; run \`hypomnema feedback-sync --write\` manually`,
      });
    } else {
      feedbackHealed = `[WIKI CHECK] feedback projection re-synced (${gate.driftTargets.join(', ')}); MEMORY.md body may be unchanged — drift was in the managed block / side-files.`;
    }
  }

  // Non-blocking heads-up about pre-existing lint / out-of-scope design-history
  // debt in untouched files. Surfaced so it is visible but never blocks compact.
  // Scoped to the close-target (today-active) projects: debt under one of their
  // dirs stays listed by filename; debt elsewhere (other projects, shared pages,
  // root files) folds into a count so the same untouched-file debt does not
  // re-list its filenames on every compact. Non-file diagnostics (a fail-open
  // "lint skipped" notice carries no path) are preserved verbatim, never folded.
  const debtNotices = gate.notices.filter((n) => n.type === 'lint' || n.type === 'design-history');
  const activeSlugs = (gate.close?.projects || []).map((p) => p.project).filter(Boolean);
  const nonFileNotices = debtNotices.filter((n) => !n.file);
  const fileNotices = debtNotices.filter((n) => n.file);
  const inScopeNotices = fileNotices.filter((n) => isUnderProjectDirs(n.file, activeSlugs));
  const otherDebtCount = fileNotices.length - inScopeNotices.length;
  const listed = [
    ...nonFileNotices.map((n) => n.reason),
    ...new Set(inScopeNotices.map((n) => n.reason.replace(/ \([^)]*\)$/, ''))),
  ];
  let noticeText = '';
  if (listed.length > 0) {
    noticeText = `[WIKI CHECK] ${listed.length} pre-existing lint issue(s) in files this session did not touch (not blocking): ${listed
      .slice(0, 5)
      .join(', ')}${listed.length > 5 ? ', …' : ''} — clean up when convenient.`;
  }
  if (otherDebtCount > 0) {
    const fold = `+${otherDebtCount} pre-existing lint issue(s) elsewhere in the vault (other projects / shared pages, not blocking) — run \`/hypo:lint\` for the full list.`;
    noticeText = noticeText ? `${noticeText}\n${fold}` : `[WIKI CHECK] ${fold}`;
  }
  // Surface the self-heal so a re-synced projection is not a silent mutation of
  // the user's MEMORY.md / CLAUDE.md (transparency).
  if (feedbackHealed) noticeText = noticeText ? `${noticeText}\n${feedbackHealed}` : feedbackHealed;

  if (gate.ok) {
    console.log(
      JSON.stringify(
        noticeText
          ? { continue: true, systemMessage: noticeText }
          : { continue: true, suppressOutput: true },
      ),
    );
    return;
  }

  // ── Bypass 3: HYPO_SKIP_GATE ──
  if (isGateSkipped()) {
    const skipped = [
      ...gate.blockers.map((b) => b.reason),
      gate.skipped.lint ? 'lint skipped (hypo-pkg.json missing)' : '',
      gate.skipped.feedback ? 'feedback-sync skipped (hypo-pkg.json missing)' : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      JSON.stringify({
        continue: true,
        systemMessage: `[WIKI CHECK] gate bypassed via HYPO_SKIP_GATE=1 (incomplete: ${skipped}).`,
      }),
    );
    return;
  }

  // ── Block ──
  // gate.blockers already carry per-type reasons in the canonical order
  // (git, hot, close, lint, design-history, feedback) — same strings as before
  // Now sourced from the shared gate instead of inline checks.
  const reasons = [
    ...gate.blockers.map((b) => b.reason),
    gate.skipped.lint ? 'lint skipped (run `hypomnema init` to enable lint gate)' : '',
  ].filter(Boolean);

  const checklist = readChecklist(today);
  const checklistText =
    checklist ??
    [
      `  [ ] 0. Read SCHEMA.md + hypo-guide.md (required before wiki work)`,
      `  [ ] 1. PRD       — create projects/<name>/prd.md if missing`,
      `  [ ] 2. ADR       — decide yes/no on 5 types. Design change → append to projects/<name>/design-history.md.`,
      `           If none, note the literal marker "ADR 없음 — reason: <why>" in the session-log entry`,
      `           (machine-readable; suppresses the W8 design-history gate for no-design sessions).`,
      `  [ ] 3. Ingest    — if new external knowledge, save to sources/ and ingest`,
      `  [ ] 4. Pages     — extract new concepts/patterns to pages/`,
      `  [ ] 5. Synthesis — if 3+ cross-page analysis results, save to pages/syntheses/`,
      `  [ ] 6. session-log — append to projects/<name>/session-log/YYYY-MM-DD.md (daily shard)`,
      `  [ ] 7. index.md  — update Projects section if needed`,
      `  [ ] 8. log.md    — append ## [${today}] session | <project-name>`,
      `  [ ] 9. hot.md    — update projects/<name>/hot.md (no exceptions)`,
      `  [ ] 10. root hot.md — update ~/hypomnema/hot.md active project table`,
      `  [ ] 11. updated: field — verify today's date on all touched .md files`,
      `  [ ] 12. lint — run /hypo:lint; fix errors in files YOU touched`,
      `           (other projects' / shared-page debt is reported as non-blocking notice)`,
      `  [ ] 13. git commit & push`,
      `  [ ] 14. verify — run /hypo:crystallize (--check-session-close mode); only declare`,
      `           the session closed once it prints "Compact-ready" (= this gate passes).`,
    ].join('\n');

  const closeIntentNote = hasCloseIntent
    ? `[Close intent detected in recent messages — completing session close first.]\n`
    : '';

  console.log(
    JSON.stringify({
      decision: 'block',
      reason: [
        `${closeIntentNote}[WIKI CHECK — BLOCKING] Session close incomplete. (${reasons.join(', ')})`,
        `Run the checklist below in order, then retry /compact:`,
        ``,
        checklistText,
        ...(noticeText ? ['', noticeText] : []),
        ``,
        `Trivial session? Bypass with HYPO_SKIP_GATE=1`,
      ].join('\n'),
      continue: false,
      stopReason: `Session close incomplete: ${reasons.join(', ')}`,
    }),
  );
});
