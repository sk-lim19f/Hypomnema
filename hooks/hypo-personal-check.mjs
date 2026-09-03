#!/usr/bin/env node
/**
 * hypo-personal-check.mjs — PreCompact hook
 *
 * NEVER blocks /compact (session-close-scope-boundary spec §1). It used to be
 * a hard gate here, but /compact was the only hard path that "compact-ready"
 * marker's invariant leaned on, and a hard block here meant every check
 * `precompactGateStatus` runs (git-clean, hot.md structure, session-close
 * files, scoped lint, W8 design-history, feedback projection) could hold
 * /compact hostage on a project this session never touched. That is the
 * scope-boundary bug this hook no longer causes. Session close is still
 * enforced, just not HERE: the Stop hook (hypo-auto-minimal-crystallize.mjs)
 * still blocks on close-intent + incomplete close, and `--mark-session-closed`
 * still refuses the marker on a red gate. What follows is now advisory: an
 * incomplete close surfaces as a systemMessage, never as decision:'block'.
 *
 * NOTE: capacity bypass (wiki-context-critical.json ≥90%) was REMOVED
 * (amendment 2026-05-13), and HYPO_SKIP_GATE is now moot for THIS hook since
 * nothing here blocks — it is kept only so an incomplete-close systemMessage
 * doesn't repeat the recommendation once bypassed.
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
  resolveGateProjectOverride,
} from './hypo-shared.mjs';

const WARNING_FILE = join(homedir(), '.claude', 'state', 'wiki-context-warning.json');

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let transcriptPath = null;
  let sessionId = null;
  let sessionCwd = null;
  try {
    const input = JSON.parse(raw || '{}');
    transcriptPath = input.transcript_path ?? null;
    // A log-only marker for this session activates log-only gate
    // semantics (no project attribution) so /compact does not block a closed
    // non-project session on the active/phantom project's files.
    sessionId = input.session_id ?? input.sessionId ?? null;
    // Authoritative session cwd for the session-cwd close check. This is the one
    // verified cwd source (mirrors hypo-session-record); it lets /compact block a
    // session whose own project close was never started, which the recency-based
    // global status cannot see.
    sessionCwd = input.cwd ?? null;
  } catch {
    /* fail-open */
  }

  // ── Capacity bypass (≥90%) REMOVED: amendment 2026-05-13.
  //    Even at full context, minimal session-close is mandatory (spec §7.5).
  //    Bypass paths are now only: HYPO_SKIP_GATE env / HYPO_SKIP_GATE in transcript.

  // ── Context warning (≥70%) — advisory nudge toward session-compact, never a block ──
  if (existsSync(WARNING_FILE)) {
    try {
      unlinkSync(WARNING_FILE);
    } catch {}
    console.log(
      JSON.stringify({
        continue: true,
        systemMessage: [
          `[WIKI CHECK] Context ≥70%: consider running /session-compact before compacting.`,
          `1. If Skill tool is available: call it with skill="session-compact".`,
          `2. If Skill tool is unavailable: perform the session-close checklist from hypo-guide.md.`,
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
  // resolveGateProjectOverride (session-close-scope-boundary spec §2/§3): PreCompact
  // gets no explicit --project, only the payload's sessionCwd, so this resolves
  // to the one project that cwd unambiguously owns (or null, which leaves the
  // gate global). Passed below as `attributionScope`, never `projectOverride`:
  // that key is the check-only diagnostic's and would also narrow
  // sessionCloseGlobalStatus to this one project, turning off the mine/foreign
  // partition that is what actually turns a foreign project's dangling close
  // into a notice instead of debt this session gets blamed for in the message.
  const attributionScope = resolveGateProjectOverride(HYPO_DIR, { sessionCwd });

  let gate;
  try {
    gate = precompactGateStatus(HYPO_DIR, {
      transcriptPath,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionCwd ? { sessionCwd } : {}),
      ...(attributionScope ? { attributionScope } : {}),
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
  // race exits non-zero and blocks here. Each FILE it writes is atomic (tmp+
  // rename, see feedback-sync's atomicWrite), so a mid-write fault can no longer
  // truncate a target; what is still not atomic is the write ACROSS targets (one
  // file can land before another fails), which the preflight narrows to genuine
  // fs errors and no further.
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

  // Non-blocking heads-up, one line per notice TYPE (session-close-scope-boundary
  // spec §4). gate.notices can carry any of seven types: git, git-sync,
  // close-debt, close-cwd-unresolved, lint, design-history, feedback. Folding
  // them all into one "pre-existing lint issue(s)" sentence (the old
  // renderer) mislabeled git/git-sync/close-cwd-unresolved as lint debt and
  // dropped close-cwd-unresolved plus most feedback notices outright: visible
  // but lying about what kind of issue it was and what fixes it. A count that
  // can grow unbounded (foreign git paths, close-debt projects) is capped and
  // the rest folds into "+N more", mirroring the existing lint/design-history
  // fold (a vault-wide lint sweep once produced 125 lines here).
  const NOTICE_LIST_CAP = 5;
  const foldNames = (items) =>
    items.length > NOTICE_LIST_CAP
      ? `${items.slice(0, NOTICE_LIST_CAP).join(', ')}, +${items.length - NOTICE_LIST_CAP} more`
      : items.join(', ');
  const byType = (t) => gate.notices.filter((n) => n.type === t);
  const noticeLines = [];

  // git: a dirty file outside this session's scope (§2b's structural demotion,
  // or the trusted-transcript foreign-file demotion above it).
  const foreignGit = byType('git');
  if (foreignGit.length > 0) {
    noticeLines.push(
      `[WIKI CHECK] ${foreignGit.length} uncommitted file(s) outside this session's scope (not blocking): ${foldNames(foreignGit.map((n) => n.file || n.reason))}.`,
    );
  }
  // git-sync / close-cwd-unresolved: single-fact notices, their own `reason`
  // is already the full sentence.
  for (const n of byType('git-sync')) noticeLines.push(`[WIKI CHECK] ${n.reason}.`);
  // close-cwd-unresolved's own `reason` (hypo-shared.mjs) names --project /
  // --log-only, crystallize CLI flags with no PreCompact-hook equivalent, so
  // it is not echoed here. This session's own sentence names the one thing a
  // /compact-time reader can actually do about it: nothing, this is
  // best-effort and non-blocking.
  for (const n of byType('close-cwd-unresolved')) {
    noticeLines.push(
      `[WIKI CHECK] session cwd did not resolve to a unique project (not blocking): close attribution for this session is best-effort here.`,
    );
  }

  // close-debt: some OTHER session left a project's close incomplete. It no
  // longer blocks this compact, but it must still be SEEN: a notice list that
  // the gate silently swallows (suppressOutput when nothing else surfaced)
  // would turn the demotion into a disappearance, and nobody would ever fix
  // the dangling close (codex design BLOCKER).
  const closeDebt = byType('close-debt');
  if (closeDebt.length > 0) {
    noticeLines.push(
      `[WIKI CHECK] ${closeDebt.length} project(s) with an incomplete session close from another session (not blocking this compact): ${foldNames(closeDebt.map((n) => n.project))}, each fixed by that project's next close.`,
    );
  }

  // lint / design-history: pre-existing debt in files this session did not
  // touch. Scoped to the close-target (today-active) projects: debt under one
  // of their dirs stays listed by filename; debt elsewhere (other projects,
  // shared pages, root files) folds into a count so the same untouched-file
  // debt does not re-list its filenames on every compact. Non-file
  // diagnostics (a fail-open "lint skipped" notice carries no path) are
  // preserved verbatim, never folded. lint and design-history each get their
  // own line now instead of sharing one "lint issue(s)" sentence.
  const activeSlugs = (gate.close?.projects || []).map((p) => p.project).filter(Boolean);
  for (const type of ['lint', 'design-history']) {
    const debtNotices = byType(type);
    const nonFileNotices = debtNotices.filter((n) => !n.file);
    const fileNotices = debtNotices.filter((n) => n.file);
    const inScopeNotices = fileNotices.filter((n) => isUnderProjectDirs(n.file, activeSlugs));
    const otherDebtCount = fileNotices.length - inScopeNotices.length;
    const listed = [
      ...nonFileNotices.map((n) => n.reason),
      ...new Set(inScopeNotices.map((n) => n.reason.replace(/ \([^)]*\)$/, ''))),
    ];
    if (listed.length > 0) {
      noticeLines.push(
        `[WIKI CHECK] ${listed.length} pre-existing ${type} issue(s) in files this session did not touch (not blocking): ${foldNames(listed)}. Clean up when convenient.`,
      );
    }
    if (otherDebtCount > 0) {
      noticeLines.push(
        `[WIKI CHECK] +${otherDebtCount} pre-existing ${type} issue(s) elsewhere in the vault (other projects / shared pages, not blocking); run \`/hypo:lint\` for the full list.`,
      );
    }
  }

  // feedback: side-file I/O warnings (a projection target's per-slug sidecar is
  // unreadable). A drift notice is skipped ONLY when this run actually healed
  // it (feedbackHealed non-empty, reported once below): when gate.ok is
  // false (another blocker fired), the self-heal above never runs at all, so
  // the drift itself was never reported anywhere and must not be dropped here.
  for (const n of byType('feedback')) {
    if (feedbackHealed && /^feedback projection drift/.test(n.reason)) continue;
    noticeLines.push(`[WIKI CHECK] ${n.reason}.`);
  }

  let noticeText = noticeLines.join('\n');
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

  // ── Advisory (never blocks — spec §1) ──
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
      `           If none, note the literal marker "ADR 없음: <reason>" in the session-log entry`,
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
      continue: true,
      systemMessage: [
        `${closeIntentNote}[WIKI CHECK] Session close incomplete. (${reasons.join(', ')})`,
        `Recommended before /compact — run the checklist below:`,
        ``,
        checklistText,
        ...(noticeText ? ['', noticeText] : []),
      ].join('\n'),
    }),
  );
});
