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
 * Bypass options (checked in order, per ADR 0022 / spec §7.5):
 *   1. HYPO_SKIP_GATE=1 env var
 *   2. HYPO_SKIP_GATE=1 in a recent *user-role* transcript message
 *      (assistant/tool output is excluded to prevent self-triggering from block reason text)
 *
 * NOTE: capacity bypass (wiki-context-critical.json ≥90%) was REMOVED
 * (ADR 0022 amendment 2026-05-13). Spec §7.5: even at full context, minimal
 * session-close is mandatory — auto-bypass on capacity caused silent state loss.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import {
  HYPO_DIR,
  PKG_ROOT,
  hypoIsClean,
  hotMdIsClean,
  sessionCloseGlobalStatus,
  readChecklist,
  isGateSkipped,
  isClosePattern,
  extractUserMessages,
  extractTouchedWikiFiles,
  closeFileTargetsGlobal,
  partitionLintScope,
} from './hypo-shared.mjs';

const WARNING_FILE = join(homedir(), '.claude', 'state', 'wiki-context-warning.json');

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let transcriptPath = null;
  try {
    const input = JSON.parse(raw || '{}');
    transcriptPath = input.transcript_path ?? null;
  } catch {
    /* fail-open */
  }

  // ── Capacity bypass (≥90%) REMOVED — ADR 0022 amendment 2026-05-13.
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

  const gitStatus = hypoIsClean();
  const hotStatus = hotMdIsClean();
  // strict session-close (steps 1~6 of the 11-step crystallize
  // checklist). closeFiles gates the 5 mandatory files (steps 1-4 + log.md);
  // open-questions.md (step 5) is conditional ("변경 시") and intentionally
  // ungated — see hypo-shared.mjs sessionCloseFileStatus and spec §5.2.7.
  // ADR 0043: global invariant — block if ANY today-active project has a
  // dangling close, never a single recency/cwd pick. Flat aliases
  // (.missing/.stale/.project) keep a single-project session byte-identical.
  const closeFiles = sessionCloseGlobalStatus(HYPO_DIR);
  const closeFilesReason = closeFiles.ok
    ? ''
    : `memory files not updated this session: ${[
        ...closeFiles.missing.map((f) => `${f} (missing)`),
        ...closeFiles.stale.map((f) => `${f} (stale)`),
      ].join(', ')}`;

  const lintPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'lint.mjs') : null;
  let lintBlockers = [];
  let lintW8 = [];
  let lintNotices = []; // pre-existing debt in files this session did not touch
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
      const allErrors = parsed.errors || [];
      const allW8 = (parsed.warns || []).filter((w) => w.id === 'W8');
      // Bug B: judge this session on the files IT touched, not the whole vault.
      // Scope = the mandatory close files (always derivable without a transcript)
      // plus the files this session edited (only knowable with a transcript). A
      // readable transcript widens the scope to the session's Edit/Write targets.
      // Without one (headless, apply-path close, or programmatic invocation) the
      // scope is exactly closeFileTargets, the mandatory close files and the only
      // files derivable without a transcript. (crystallize --apply-session-close
      // can also write an optional pages/open-questions.md, but PreCompact cannot
      // locate that without a transcript or payload and the apply path gates it
      // on its own.) Cross-project or shared-page debt the
      // session did not touch becomes a non-blocking notice either way, so an
      // unrelated lint error elsewhere never holds /compact hostage. See ADR 0041,
      // which reverses ADR 0037's conservative global fallback (real interactive
      // /compact always carries a transcript, so the old fallback only ever fired
      // in transcript-less modes where closeFileTargets is already complete).
      const haveTranscript = !!(transcriptPath && existsSync(transcriptPath));
      const scope = new Set(closeFileTargetsGlobal(HYPO_DIR));
      if (haveTranscript) {
        for (const f of extractTouchedWikiFiles(transcriptPath, HYPO_DIR)) scope.add(f);
      }
      const part = partitionLintScope(allErrors, scope);
      lintBlockers = part.blocking;
      lintNotices = part.notice;
      // W8 (design-history stale) is each today-active project's own close
      // responsibility, not cross-project debt: block on every today-active
      // project's design-history, surface others' as notices (ADR 0043 —
      // multiple projects can be closing in one session).
      const activeSlugs = (closeFiles.projects || []).map((p) => p.project).filter(Boolean);
      if (activeSlugs.length > 0) {
        const mine = new Set(activeSlugs.map((s) => `projects/${s}/design-history.md`));
        lintW8 = allW8.filter((w) => mine.has(w.file));
        lintNotices.push(...allW8.filter((w) => !mine.has(w.file)));
      } else {
        lintW8 = allW8;
      }
    } catch (err) {
      /* fail-open */
      process.stderr.write(`[hypo-personal-check] error: ${err?.message ?? String(err)}\n`);
    }
  }

  const lintOk = lintBlockers.length === 0;
  const designHistoryOk = lintW8.length === 0;
  // Non-blocking heads-up about pre-existing lint debt in untouched files (other
  // projects / shared pages). Surfaced so it is visible but never blocks compact.
  let noticeText =
    lintNotices.length > 0
      ? `[WIKI CHECK] ${lintNotices.length} pre-existing lint issue(s) in files this session did not touch (not blocking): ${[
          ...new Set(lintNotices.map((b) => b.file)),
        ]
          .slice(0, 5)
          .join(', ')}${lintNotices.length > 5 ? ', …' : ''} — clean up when convenient.`
      : '';

  // ── Phase C: feedback projection drift (ADR 0031) ──
  // Single blocking gate invariant (spec §7.5): integrate into THIS hook, never
  // add a separate PreCompact hook. `feedback-sync --check --strict` reports
  // projection drift (wiki feedback SoT vs MEMORY / CLAUDE.md learned-behaviors
  // projection). `--no-input` keeps this non-TTY hook from ever blocking on a
  // prompt, and the engine's skip-MEMORY warning is *soft* (never escalated by
  // --strict) so a fresh / external user whose ~/.claude/projects/<id> dir does
  // not exist yet is never gated (contract §5 step 4). The --check spawn
  // fails open on any error, exactly like the lint check above; the self-heal
  // --write below fails CLOSED (blocks transparently) because by then real
  // drift is confirmed and silently passing it would defeat the gate.
  const feedbackPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'feedback-sync.mjs') : null;
  let feedbackOk = true;
  let feedbackReason = '';
  let feedbackHealed = ''; // self-heal notice when pure drift was auto-resolved (ADR 0045)
  let feedbackSkipped = false;
  if (!feedbackPath || !existsSync(feedbackPath)) {
    feedbackSkipped = true;
  } else {
    try {
      const r = spawnSync(
        process.execPath,
        [
          feedbackPath,
          '--check',
          '--strict',
          '--no-input',
          '--json',
          `--hypo-dir=${HYPO_DIR}`,
          `--claude-home=${join(homedir(), '.claude')}`,
        ],
        { encoding: 'utf-8', timeout: 30000 },
      );
      if (r.error || r.status === null) {
        feedbackSkipped = true; // spawn failure → fail-open (never block on tooling)
      } else if (r.status !== 0) {
        // exit≠0 alone is ambiguous. A *missing* target file (e.g. a system
        // whose ~/.claude/CLAUDE.md was never created) reports buildError +
        // exit 1, which is benign — there is nothing to gate. Decide from the
        // JSON report's per-target state instead of the raw exit code: block
        // ONLY when some target has a genuine, actionable issue (drift,
        // conflict, over-cap, or a malformed managed region). buildError is
        // never actionable here, so any mix that lacks a real issue fails open
        // — including memory:clean + claude:buildError, where the prior
        // `every(buildError)` predicate wrongly blocked that case. Mirrors
        // doctor's buildError→warn (non-fatal) handling.
        let report = null;
        try {
          report = JSON.parse(r.stdout || '');
        } catch {
          /* unparseable → fail-open below */
        }
        const entries = report ? Object.entries(report.targets || {}) : [];
        const conflictedT = entries
          .filter(
            ([, t]) =>
              t.intruder || t.unpaired || t.outOfContainer || (t.conflicts && t.conflicts.length),
          )
          .map(([n]) => n);
        const overCapT = entries.filter(([, t]) => t.overCap).map(([n]) => n);
        const driftedT = entries.filter(([, t]) => t.dirty).map(([n]) => n);
        if (!report || !(conflictedT.length || overCapT.length || driftedT.length)) {
          feedbackSkipped = true; // missing target / pure warning / unparseable → fail-open
        } else if (conflictedT.length || overCapT.length) {
          // Genuine human-decision cases (ADR 0031 rules 3 & 6) — always surface,
          // never auto-resolve. Name the target so the block reason is actionable.
          feedbackOk = false;
          feedbackReason = conflictedT.length
            ? `feedback projection conflict (manual edit of ${conflictedT.join(', ')}) — run \`hypomnema feedback-sync --import-target-change --from=<memory|claude>\``
            : `feedback projection over cap (${overCapT.join(', ')}) — demote/archive feedback pages`;
        } else {
          // Pure projection drift (deterministic derive, byte-identical per ADR
          // 0031 rule 5). Self-heal: regenerate the projection so the gate does
          // not block on a mechanical, auto-resolvable diff (ADR 0045). The write
          // touches managed blocks / per-feedback side-files; the visible
          // MEMORY.md body is often unchanged (the drift lives in the side-file
          // copies). Effect = gate unblock + next-session coherence, NOT an
          // in-context memory refresh (MEMORY.md is injected at session start).
          // --write is NOT --strict and only applies when nothing blocks
          // (code===0 across ALL targets), so a late conflict/over-cap (race vs
          // the --check above) exits non-zero and we block transparently rather
          // than passing on unresolved drift. Note: --write is semantic-preflight
          // atomic (it refuses to write any target when one conflicts/over-caps),
          // but not filesystem-atomic — a concurrent edit between eval and apply,
          // or an I/O fault mid-write, is best-effort, same as any feedback-sync
          // --write. Hardening that is out of scope here (pre-existing engine
          // behavior, not introduced by the self-heal).
          const w = spawnSync(
            process.execPath,
            [
              feedbackPath,
              '--write',
              '--no-input',
              `--hypo-dir=${HYPO_DIR}`,
              `--claude-home=${join(homedir(), '.claude')}`,
            ],
            { encoding: 'utf-8', timeout: 30000 },
          );
          if (w.error || w.status === null || w.status !== 0) {
            feedbackOk = false;
            feedbackReason = `feedback projection drift (${driftedT.join(', ')}) — auto-sync failed; run \`hypomnema feedback-sync --write\` manually`;
          } else {
            feedbackHealed = `[WIKI CHECK] feedback projection re-synced (${driftedT.join(', ')}); MEMORY.md body may be unchanged — drift was in the managed block / side-files.`;
          }
        }
      }
    } catch (err) {
      feedbackSkipped = true;
      process.stderr.write(`[hypo-personal-check] error: ${err?.message ?? String(err)}\n`);
    }
  }

  // Surface the self-heal so a re-synced projection is not a silent mutation of
  // the user's MEMORY.md / CLAUDE.md (ADR 0045 transparency).
  if (feedbackHealed) noticeText = noticeText ? `${noticeText}\n${feedbackHealed}` : feedbackHealed;

  if (
    gitStatus.clean &&
    hotStatus.clean &&
    lintOk &&
    designHistoryOk &&
    closeFiles.ok &&
    feedbackOk
  ) {
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
      !gitStatus.clean ? gitStatus.reason : '',
      !hotStatus.clean ? hotStatus.reason : '',
      !closeFiles.ok ? closeFilesReason : '',
      !designHistoryOk ? `design-history stale (${lintW8.length})` : '',
      !feedbackOk ? feedbackReason : '',
      lintSkipped ? 'lint skipped (hypo-pkg.json missing)' : '',
      feedbackSkipped ? 'feedback-sync skipped (hypo-pkg.json missing)' : '',
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
  const reasons = [
    !gitStatus.clean ? gitStatus.reason : '',
    !hotStatus.clean ? hotStatus.reason : '',
    !closeFiles.ok ? closeFilesReason : '',
    !lintOk
      ? `lint blockers: ${[...new Set(lintBlockers.map((b) => b.id || b.file))].join(', ')}`
      : '',
    !designHistoryOk
      ? `design-history stale: ${lintW8.map((w) => w.file.split('/')[1]).join(', ')}`
      : '',
    !feedbackOk ? feedbackReason : '',
    lintSkipped ? 'lint skipped (run `hypomnema init` to enable lint gate)' : '',
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
      `  [ ] 6. session-log — append to projects/<name>/session-log/YYYY-MM.md`,
      `  [ ] 7. index.md  — update Projects section if needed`,
      `  [ ] 8. log.md    — append ## [${today}] session | <project-name>`,
      `  [ ] 9. hot.md    — update projects/<name>/hot.md (no exceptions)`,
      `  [ ] 10. root hot.md — update ~/hypomnema/hot.md active project table`,
      `  [ ] 11. updated: field — verify today's date on all touched .md files`,
      `  [ ] 12. lint — run scripts/lint.mjs; fix errors in files YOU touched`,
      `           (other projects' / shared-page debt is reported as non-blocking notice)`,
      `  [ ] 13. git commit & push`,
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
