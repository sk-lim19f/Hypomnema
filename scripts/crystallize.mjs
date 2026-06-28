#!/usr/bin/env node
/**
 * Hypomnema crystallize script
 *
 * Finds synthesis candidates: pages that share tags, unlinked pages,
 * and draft pages that could be crystallized into stable knowledge.
 * Used by /hypo:crystallize to surface what Claude should synthesize.
 *
 * Usage:
 *   node scripts/crystallize.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>        Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --min-group=<n>          Min pages per tag group to report (default: 2)
 *   --check-session-close    Verify the strict session-close memory files — 5 mandatory + open-questions conditional
 *   --project=<slug>         Override the recency-inferred project on --check / --mark (single segment
 *                            [A-Za-z0-9._-]+, projects/<slug>/ must exist). On --check it NARROWS the
 *                            gate to that one project — a project-scoped diagnostic, NOT a global
 *                            compact-ready verdict. On --mark it is ATTRIBUTION only; the gate stays
 *                            global (the marker == compact-ready invariant). Ignored on --apply.
 *   --apply-session-close    Apply a JSON payload that updates the 5 mandatory memory files
 *                            (+ optional open-questions). Idempotent — re-running with the same
 *                            payload is a no-op. Always finishes with the strict gate check.
 *
 *                            Without --payload, runs as a cheap "already complete?" probe:
 *                            if the strict gate is ok, exits 0 with alreadyComplete:true;
 *                            otherwise exits 1 with "payload is required". Option D:
 *                            payload presence = explicit close intent → always full apply
 *                            (the per-entry idempotency keeps re-apply cheap).
 *   --payload=<path|->       Path to JSON payload (file or `-` for stdin). Required for any
 *                            apply work; omit only for the probe path above.
 *   --force                  Bypass the no-payload probe early-exit. Payload is still required
 *                            for any apply work — --force only opts out of the alreadyComplete
 *                            shortcut. Reserved for explicit diagnostics / scripted recovery.
 *   --json                   Output as JSON
 *
 * Payload schema:
 *   {
 *     "project":      "<slug>",                       // REQUIRED — single segment [A-Za-z0-9._-]+ (≥1 alnum, not dot-only), projects/<slug>/ dir must exist (B-3: no recency fallback for apply)
 *     "date":         "YYYY-MM-DD",                   // optional — defaults to today (local)
 *     "sessionState": { "content": "<full file>" },   // overwrite (idempotent: identical bytes → skip)
 *     "projectHot":   { "content": "<full file>" },   // overwrite
 *     "rootHot":      { "content": "<full file>" },   // overwrite
 *     "sessionLog":   { "entry":   "## [date] ..." }, // append, skip if heading already present
 *     "log":          { "entry":   "## [date] session | <project> ..." }, // OPTIONAL (B-1): omit it and apply derives the root log.md entry from this close's sessionLog heading; supply it only for a deliberately custom log line
 *     "openQuestions":{ "content": "<full file>" }    // optional overwrite
 *   }
 *
 * The helper does NOT auto-fix `updated:` frontmatter. If a payload field carries a
 * stale date, the final sessionCloseFileStatus check fails with a clear error so the
 * caller fixes the payload and retries. Silent rewrites would mask payload bugs.
 *
 * Lint gates:
 *   • Preflight — runs `lint.mjs --json` BEFORE any payload byte is written.
 *     Errors in files this payload will OVERWRITE (sessionState/projectHot/
 *     rootHot/openQuestions) are filtered out — they're about to be replaced,
 *     and not filtering them dead-locks the documented "fix payload and retry"
 *     recovery after a post-apply-lint failure (codex P2). Errors in any other
 *     file → exit 1 with stage='preflight-lint', no apply occurs. PreCompact's
 *     hypo-personal-check is still the final enforcement.
 *   • Post-apply — runs after the writes. Surfaces as stage='post-apply-lint'
 *     (or 'post-apply-verification+lint' if freshness also fails). Catches
 *     payloads that introduce a malformed body / bad frontmatter (error-level);
 *     broken wikilinks are lint W4 warnings and are not gated. A lint crash
 *     hard-fails regardless of scope.
 */

import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { hostname } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore } from './lib/hypo-ignore.mjs';
import { collectPagesCrystallize, extractWikilinks } from './lib/wikilink.mjs';
import { isValidProjectName } from './lib/project-create.mjs';
import { appendPendingTags, checkForbidden } from './lib/schema-vocab.mjs';
import {
  sessionCloseFileStatus,
  sessionCloseGlobalStatus,
  precompactGateStatus,
  writeSessionClosedMarker,
  sessionClosedMarkerPath,
  readSessionClosedMarker,
  partitionLintScope,
  isUnderProjectDirs,
  sessionLogShardPath,
  sessionLogReadCandidates,
  sessionLogScopePath,
  rootLogEntry,
  resolveTranscriptBySessionId,
  hasUserCloseSignal,
  commitWikiChanges,
} from '../hooks/hypo-shared.mjs';

// This script's own absolute path. Used to print copy-pasteable recovery
// commands as `node <SELF_SCRIPT> ...` rather than a bare `crystallize` bin,
// which is not on PATH in a Claude Code plugin install (only in an npm global).
const SELF_SCRIPT = fileURLToPath(import.meta.url);
const LINT_SCRIPT = join(dirname(SELF_SCRIPT), 'lint.mjs');

// Spawn lint.mjs --json against `hypoDir` and return parsed result.
// We shell out instead of refactoring lint.mjs into a library because lint.mjs
// keeps issues in module scope (scripts/lint.mjs:139,250) — a programmatic
// extraction is its own chore. spawnSync is the minimum-invasive path for #40.
// Throws only on JSON parse failure (lint crashed mid-run); a lint that exits 1
// with valid JSON is a normal "errors present" signal, not a crash.
// maxBuffer raised to 64 MiB: warn-only output on a large wiki can otherwise
// trip Node's 1 MiB default, truncate stdout, and turn a clean wiki into a
// JSON.parse crash (codex P3 follow-up).
function runLint(hypoDir) {
  const r = spawnSync(process.execPath, [LINT_SCRIPT, `--hypo-dir=${hypoDir}`, '--json'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    // Report diagnostic metadata (sizes, exit/signal, spawn error code, a stderr
    // tail) instead of dumping the whole — possibly huge, possibly truncated —
    // stdout. lint.mjs now sets exitCode and exits naturally so its stdout is no
    // longer cut at the 64 KiB pipe boundary; if this still fires it signals a
    // genuine crash, and these fields say which kind.
    const stderrTail = (r.stderr || '').slice(-2000);
    throw new Error(
      `lint helper produced unparseable output ` +
        `(exit=${r.status}, signal=${r.signal || 'none'}, ` +
        `stdoutBytes=${(r.stdout || '').length}, spawnError=${r.error?.code || 'none'})` +
        (stderrTail ? `\nstderr tail:\n${stderrTail}` : ''),
    );
  }
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    hypoDir: null,
    minGroup: 2,
    json: false,
    checkSessionClose: false,
    applySessionClose: false,
    markSessionClosed: false,
    logOnly: false,
    sessionId: null,
    payload: null,
    force: false,
    transcriptPath: null,
    project: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--min-group=')) args.minGroup = parseInt(arg.slice(12), 10) || 2;
    else if (arg === '--check-session-close') args.checkSessionClose = true;
    else if (arg === '--apply-session-close') args.applySessionClose = true;
    else if (arg === '--mark-session-closed') args.markSessionClosed = true;
    else if (arg === '--log-only') args.logOnly = true;
    else if (arg.startsWith('--session-id=')) args.sessionId = arg.slice(13);
    else if (arg.startsWith('--payload=')) args.payload = arg.slice(10);
    else if (arg.startsWith('--transcript-path=')) args.transcriptPath = expandHome(arg.slice(18));
    else if (arg.startsWith('--project=')) args.project = arg.slice(10);
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  // --project=<slug> override (check/mark only). Validate the SYNTAX here so a
  // traversal/charset attack (`--project=../x`) is rejected before any path is
  // built from it — sessionCloseFileStatus(projectOverride) joins it directly.
  // isValidProjectName is the SHARED validator (project-create.mjs), so the
  // override accepts exactly the namespace createProject can scaffold. Existence
  // (a real projects/<slug>/ directory) is checked in the run functions, where
  // hypoDir is resolved and only the check/mark paths consume --project.
  if (args.project != null && !isValidProjectName(args.project)) {
    const msg = `--project "${args.project}" is not a valid project name (need a single segment with ≥1 alnum, charset A-Za-z0-9._-, not "."/"..")`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  return args;
}

// ── session-close hard gate (ADR 0055) ───────────────────────────────────────
// The marker attests "the USER closed this session". Its evidence transcript is
// resolved STRICTLY from the session id (a globally-unique UUID) by globbing the
// Claude project dirs — never from a CLI arg. A model owns the whole subprocess
// invocation, so trusting a `--transcript-path` it supplies would let it point at
// a forged `<session-id>.jsonl` it just wrote with a fake close phrase. Resolving
// from the id alone closes that: the only file the glob finds is the live
// transcript the harness itself maintains, which the model cannot author. (If the
// model drops a second `<id>.jsonl` elsewhere the glob returns >1 and fails
// closed.) `--transcript-path` survives ONLY for `--check-session-close`'s lint
// scope, which writes no marker and so cannot cause an over-close.

// Validate that an explicit --project=<slug> override names a real project
// DIRECTORY. Syntax was already checked in parseArgs; this is the existence half,
// mirroring apply's payload.project check — a regular file or an absent dir at
// projects/<slug> is a hard error so the override never silently resolves to an
// all-missing status (which a reader would misread as "exists but incomplete").
function requireProjectDir(args, slug) {
  const projectDir = join(args.hypoDir, 'projects', slug);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    const msg = `--project "${slug}" does not exist as a directory (no projects/${slug}/ directory)`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
}

// ── session-close check (spec §5.2.7 / §8.3) ────────────────────────
// Mirrors the hard gate in hypo-personal-check.mjs so the /hypo:crystallize
// flow can self-verify before /compact triggers PreCompact.

function runSessionCloseCheck(args) {
  // ADR 0046: the check mirrors the FULL PreCompact gate via the shared
  // precompactGateStatus (close files + lint + design-history + feedback
  // projection), not just the close files — so a green check means /compact
  // won't block on a human-fixable issue. Pass --transcript-path to widen the
  // lint scope to the session's edited files exactly as the interactive hook
  // does (without it, the scope is the mandatory close files only).
  // Pass --session-id so a log-only marker activates log-only gate
  // semantics here too. Without it the check would read the marker as present
  // (marker_present:true) while `ok` still reflected the stale active project —
  // the completion-signal trio (PreCompact / --check / marker) would diverge
  // (codex design Finding 2).
  //
  // --project=<slug> narrows BOTH the close status and the lint scope to that one
  // project: a project-scoped DIAGNOSTIC, NOT the global compact-ready verdict
  // (ADR 0046 caveat below). It is check-only — the marker writers stay global so
  // the marker == compact-ready invariant holds (ADR 0047). When narrowed, the
  // transcript widening is suppressed: a transcript touch in some OTHER project
  // would re-add that project's files to the lint scope and re-block the scoped
  // check, defeating the point. The global (no --project) check keeps widening.
  if (args.project) requireProjectDir(args, args.project);
  const status = precompactGateStatus(args.hypoDir, {
    ...(args.project
      ? { projectOverride: args.project }
      : args.transcriptPath
        ? { transcriptPath: args.transcriptPath }
        : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  });
  const close = status.close;

  // ADR 0047: when a --session-id is supplied, report whether THIS session's
  // per-session marker (the Stop-chain completion signal) exists. This is a
  // separate field, NOT folded into `ok` — `ok` stays the ADR 0046 compact-
  // readiness verdict. A green gate with marker_present=false is exactly the
  // hand-edit close state: close is compact-ready but the Stop hook will
  // still block until the marker is written.
  //
  // Use the SAME reader the Stop hook gates on (readSessionClosedMarker), not
  // raw file existence: a stale/corrupt marker file exists on disk but the hook
  // rejects (and unlinks) it, so raw existsSync would report marker_present=true
  // while /compact's Stop still blocks — the exact incoherence this ADR closes
  // (codex pre-commit CONCERN). readSessionClosedMarker unlinks an invalid
  // marker as it reads, matching the hook's behavior on the next Stop.
  const markerObj = args.sessionId ? readSessionClosedMarker(args.hypoDir, args.sessionId) : null;
  const markerPresent = args.sessionId ? markerObj !== null : null;

  // Scope of this check (codex design review finding 2 — the scope must be
  // explicit in JSON + prose, not implied). `global` = the full PreCompact mirror
  // (green ⇒ compact-ready). `project` = narrowed to --project=<slug> (green ⇒
  // only THAT project is close-complete, NOT global compact-readiness). When a
  // log-only marker governs the session, the gate runs in log-only mode and the
  // --project override is IGNORED — surface that rather than implying X was
  // checked (it was not).
  const logOnlyWon = args.project != null && markerObj?.scope === 'log-only';
  const scope = args.project ? (logOnlyWon ? 'log-only' : 'project') : 'global';

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: status.ok,
          // flat close fields preserved for back-compat with prior readers
          project: close.project,
          dates: close.dates,
          stale: close.stale,
          missing: close.missing,
          blockers: status.blockers,
          notices: status.notices,
          skipped: status.skipped,
          // scope is additive; `global` keeps prior semantics for existing readers
          scope,
          ...(args.project
            ? {
                scoped_project: args.project,
                ...(logOnlyWon ? { project_override_ignored: true } : {}),
              }
            : {}),
          ...(args.sessionId ? { session_id: args.sessionId, marker_present: markerPresent } : {}),
        },
        null,
        2,
      ),
    );
    process.exit(status.ok ? 0 : 1);
  }

  if (logOnlyWon) {
    console.log(
      `Note: a log-only session-closed marker governs session ${args.sessionId}, so the gate ran in log-only mode and --project=${args.project} was IGNORED (no project was checked).\n`,
    );
  } else if (scope === 'project') {
    console.log(
      `Note: --project=${args.project} — this is a PROJECT-SCOPED diagnostic, not the global /compact gate. A green result means only ${args.project} is close-complete; another project can still block /compact.\n`,
    );
  }

  const proj = close.project || '(unresolved)';
  console.log(
    `Compact-ready check (${scope === 'global' ? `project: ${proj}` : `scope: ${scope}, project: ${proj}`}, date: ${close.dates.join(' / ')}):\n`,
  );

  const required = close.project
    ? [
        `projects/${close.project}/session-state.md`,
        `projects/${close.project}/hot.md`,
        'hot.md',
        sessionLogShardPath(close.project, close.dates[0]),
        'log.md',
      ]
    : [];
  for (const f of required) {
    const bad = close.missing.includes(f) ? 'missing' : close.stale.includes(f) ? 'stale' : '';
    console.log(`  ${bad ? '✗' : '✓'} ${f}${bad ? ` — ${bad}` : ''}`);
  }
  // Surface anything not covered by the canonical list (e.g. unresolved project).
  for (const f of [...close.missing, ...close.stale]) {
    if (!required.includes(f)) console.log(`  ✗ ${f}`);
  }
  // Beyond the close files: the rest of the PreCompact gate (lint, design-history,
  // feedback over-cap/conflict). These are what made a "close-complete" check
  // disagree with the real /compact gate before ADR 0046.
  for (const b of status.blockers) {
    if (b.type !== 'close') console.log(`  ✗ ${b.reason}`);
  }
  if (status.notices.length > 0) {
    console.log('');
    for (const n of status.notices) console.log(`  · ${n.reason}`);
  }
  // ADR 0047: surface the per-session marker state (separate from compact-
  // readiness) so a green-but-unmarked close is visible at verify time.
  if (args.sessionId) {
    console.log('');
    console.log(
      markerPresent
        ? `  ✓ session-closed marker present (session_id: ${args.sessionId}).`
        : `  · session-closed marker absent (session_id: ${args.sessionId}) — the Stop hook will block until it is written. Run \`node "${SELF_SCRIPT}" --mark-session-closed --session-id=${args.sessionId}${args.transcriptPath ? ` --transcript-path="${args.transcriptPath}"` : ''}\`.`,
    );
  }
  console.log('');
  if (scope === 'project') {
    // Project-scoped diagnostic: green means ONLY this project is close-complete.
    // Do NOT claim global compact-readiness (the whole point of the narrow).
    console.log(
      status.ok
        ? `✓ ${args.project} is close-complete (project-scoped). This is NOT a global /compact guarantee — run \`--check-session-close\` without --project for that.`
        : `✗ ${args.project} is not close-complete — resolve the ✗ items above.`,
    );
  } else {
    console.log(
      status.ok
        ? '✓ Compact-ready — no PreCompact gate blocker needs a human fix. (open-questions.md: conditional, not checked. The live /compact can still differ on a context-≥70% prompt, HYPO_SKIP_GATE, or a transcript-scoped lint error this check did not see — pass --transcript-path to include the latter.)'
        : '✗ Not compact-ready — resolve the ✗ items above, then retry. /compact would block on these.',
    );
  }
  process.exit(status.ok ? 0 : 1);
}

// ── session-close apply ────────────────────────────────────────────
// Idempotent payload-driven application of the 5 mandatory session-close memory
// files (+ optional open-questions). Used by the LLM session-close flow as the
// canonical entrypoint instead of issuing 5+ Write tool calls by hand.
//
// Idempotency:
//   • full-content fields (sessionState/projectHot/rootHot/openQuestions): write
//     only when on-disk bytes differ — re-running with same payload is a no-op.
//   • append fields (sessionLog/log): skip when the dated heading/entry is
//     already present (regex shared with sessionCloseFileStatus via hypo-shared).
//
// Validation: never auto-fixes the payload. The final sessionCloseFileStatus
// check fails fast on stale `updated:` or missing entries so the caller fixes
// the payload and retries — silent rewrites would hide payload bugs (advisor #3).

function readPayload(source) {
  if (!source)
    throw new Error('--payload is required with --apply-session-close (path or `-` for stdin)');
  let raw;
  if (source === '-') {
    // Synchronous stdin read; payloads are tiny (a few hundred KB at most).
    raw = readFileSync(0, 'utf-8');
  } else {
    const path = expandHome(source);
    if (!existsSync(path)) throw new Error(`payload file not found: ${path}`);
    raw = readFileSync(path, 'utf-8');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`payload is not valid JSON: ${e.message}`);
  }
}

/** Atomic write via tmp+rename. `<path>.<pid>.<rand>.tmp` so concurrent helpers
 * don't fight over the same shared `<path>.tmp` slot. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Atomic write that skips when on-disk bytes already match `content`. */
function writeIfChanged(path, content) {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf-8') === content) return false; // idempotent skip
    } catch {
      /* fall through to overwrite */
    }
  }
  atomicWrite(path, content);
  return true;
}

/**
 * Append `entry` to `path` only if `alreadyPresent(content)` is false.
 * Atomic: rebuilds the full file content and writes via atomicWrite — a crash
 * mid-append cannot leave log.md or session-log/YYYY-MM-DD.md half-written, which
 * matters for these append-only history files.
 */
function appendIfAbsent(path, entry, alreadyPresent) {
  let content = '';
  if (existsSync(path)) {
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      content = '';
    }
  }
  if (alreadyPresent(content)) return false;
  // Ensure single blank line between existing tail and new entry, no trailing dup.
  const sep =
    content === '' ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  const next = entry.endsWith('\n') ? entry : entry + '\n';
  atomicWrite(path, content + sep + next);
  return true;
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Spec §5.2.7 / §8.3 + ADR 0029: 4 mandatory + 2 optional (`log`, `openQuestions`).
// The payload shape MUST mirror that contract — missing a mandatory field is a
// payload bug, not a no-op. Caller is the LLM session-close flow, which composes
// the payload deliberately; partial payloads must fail loudly so caller fixes
// them rather than silently relying on yesterday's freshness state. (Codex review
// of the apply path — Worker 1 finding 1.) `log` left the mandatory set in B-1:
// the root log.md entry is a DERIVABLE artifact (rootLogEntry over this close's
// sessionLog heading), so apply auto-fills it when the field is absent.
const REQUIRED_PAYLOAD_FIELDS = [
  ['sessionState', 'content'],
  ['projectHot', 'content'],
  ['rootHot', 'content'],
  ['sessionLog', 'entry'],
];

function validatePayloadShape(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') {
    errs.push('payload must be a JSON object');
    return errs;
  }
  for (const [field, key] of REQUIRED_PAYLOAD_FIELDS) {
    const slot = payload[field];
    if (!slot || typeof slot !== 'object') {
      errs.push(`payload.${field} is required (object with .${key})`);
      continue;
    }
    if (typeof slot[key] !== 'string') {
      errs.push(`payload.${field}.${key} must be a string`);
    }
  }
  if (payload.openQuestions !== undefined) {
    if (
      !payload.openQuestions ||
      typeof payload.openQuestions !== 'object' ||
      typeof payload.openQuestions.content !== 'string'
    ) {
      errs.push('payload.openQuestions, when present, must be { content: string }');
    }
  }
  if (payload.log !== undefined) {
    if (!payload.log || typeof payload.log !== 'object' || typeof payload.log.entry !== 'string') {
      errs.push('payload.log, when present, must be { entry: string }');
    }
  }
  if (payload.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) {
    errs.push('payload.date, when present, must be YYYY-MM-DD');
  }
  return errs;
}

// ── session-close marker (ADR 0022 amendment 2026-05-19) ──────
// Standalone marker writer. Used when the LLM closes the session via direct
// Write tool calls (not --apply-session-close). Hook `hypo-auto-minimal-
// crystallize` is the only Reader; writer authority is intentionally split
// between this CLI and the auto-write at the tail of applySessionClose.
//
// Contract: the marker is written only when the FULL /compact gate
// (precompactGateStatus, ADR 0046) is green. A failed gate exits 1 with no
// marker — the next Stop hook re-blocks.

function runMarkSessionClosed(args) {
  if (!args.sessionId) {
    const msg = '--session-id=<id> is required with --mark-session-closed';
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  // --project=<slug> on --mark is ATTRIBUTION ONLY (the marker's `project` field).
  // The gate stays GLOBAL — never narrowed — because a marker that narrowed its
  // gate could attest compact-ready while PreCompact re-checks all of today's
  // projects and stays red (the marker == compact-ready invariant, ADR 0047 /
  // codex design finding 1/2). Validate the attribution slug exists as a
  // directory, exactly as --check does, but only when it is actually used (a
  // --log-only mark attributes to no project, so --project is moot there).
  if (args.project && !args.logOnly) requireProjectDir(args, args.project);
  // ADR 0047: the per-session marker is the THIRD session-close completion
  // signal (after the PreCompact gate and `--check-session-close`). It must use
  // the SAME gate that governs /compact — precompactGateStatus — so the marker
  // can never attest "closed" while /compact would still block. This subsumes
  // the prior (sessionCloseGlobalStatus + hypoIsClean + scoped-lint) gate and
  // additionally enforces feedback projection (over-cap/conflict), W8 design-
  // history staleness, and root hot.md structure — the checks that the narrower
  // marker gate skipped (the divergence behind this fix). git-clean is now a
  // `git` blocker inside the gate. Pass --transcript-path to widen the lint
  // scope to this session's edited files exactly as the interactive hook does;
  // without it the scope is the mandatory close files only.
  // --log-only marks a non-project (tooling / wiki-only) session as
  // closed without attributing it to any project. The gate runs in log-only mode
  // (project-close invariant → a today log.md entry; lint/W8 scoped to shared +
  // touched files, never the active/phantom project), but git / hot / feedback
  // still apply — log-only is NOT a global-gate bypass.
  // Resolve the close transcript once from the session id (glob, never a CLI
  // arg): it both widens the lint scope inside the gate AND is the evidence
  // source for the user-close hard gate below.
  const closeTranscript = resolveTranscriptBySessionId(args.sessionId);
  const gate = precompactGateStatus(args.hypoDir, {
    ...(closeTranscript ? { transcriptPath: closeTranscript } : {}),
    ...(args.logOnly ? { logOnly: true } : {}),
  });
  const status = gate.close;
  if (!gate.ok) {
    const result = {
      ok: false,
      session_id: args.sessionId,
      project: status.project,
      missing: status.missing,
      stale: status.stale,
      blockers: gate.blockers,
      error: 'session-close gate not satisfied — marker not written',
    };
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `✗ session-close gate not satisfied — marker not written (project: ${status.project || '(unresolved)'}):`,
      );
      for (const b of gate.blockers) console.log(`  ✗ ${b.reason}`);
    }
    process.exit(1);
  }
  // User-close hard gate (ADR 0055): the compact gate above only proves the wiki
  // is compact-ready; it does NOT prove the USER asked to close. Refuse the marker
  // unless the transcript carries a genuine user close signal (NL close phrase,
  // /compact, or an AskUserQuestion close answer). This is the hard backstop for
  // model over-close, where prose guidance lost to a conflicting global rule.
  // Fail-closed when the transcript can't be resolved.
  if (!closeTranscript || !hasUserCloseSignal(closeTranscript)) {
    const reason = !closeTranscript
      ? `cannot resolve a transcript for session ${args.sessionId} — the session-closed marker requires a verifiable user close signal`
      : "no user close signal in this session's transcript — marker refused (the user did not signal session close)";
    const result = {
      ok: false,
      session_id: args.sessionId,
      project: status.project,
      skipReason: 'no-user-close-signal',
      error: reason,
    };
    console.log(args.json ? JSON.stringify(result, null, 2) : `✗ ${reason}`);
    process.exit(1);
  }
  // --project attributes the marker to that slug (gate stayed global); falls back
  // to the gate's resolved primary. log-only marks attribute to no project. Used
  // for the marker, the JSON result, and the success message so all three agree.
  const markerProject = !args.logOnly && args.project ? args.project : status.project;
  writeSessionClosedMarker(args.hypoDir, args.sessionId, {
    project: markerProject,
    ...(args.logOnly ? { scope: 'log-only' } : {}),
  });
  // Marker writer swallows IO errors (best-effort, see hypo-shared.mjs). Verify
  // the file actually landed before claiming success — otherwise CLI exits 0
  // while next Stop re-blocks, hiding a permission/disk problem.
  // Codex Worker-2 CONCERN (pre-commit review).
  if (!existsSync(sessionClosedMarkerPath(args.hypoDir, args.sessionId))) {
    const err = 'marker file did not land after write (likely .cache permission/disk issue)';
    console.log(
      args.json
        ? JSON.stringify({ ok: false, session_id: args.sessionId, error: err }, null, 2)
        : `✗ ${err}`,
    );
    process.exit(1);
  }
  const result = {
    ok: true,
    session_id: args.sessionId,
    project: markerProject,
    scope: args.logOnly ? 'log-only' : 'project',
    date: status.dates[0],
    notices: gate.notices,
    // ADR 0047: pure feedback-projection drift is a non-blocker — the marker
    // attests "compact-ready (no human-fixable blocker)", and the PreCompact
    // hook self-heals the projection (feedback-sync --write) at /compact. Surface
    // the deferral so the caller knows MEMORY/CLAUDE sync is pending, not lost.
    drift_deferred: gate.driftTargets,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      args.logOnly
        ? `✓ session-closed marker written (session_id: ${args.sessionId}, scope: log-only — no project attribution).`
        : `✓ session-closed marker written (session_id: ${args.sessionId}, project: ${markerProject}).`,
    );
    if (gate.driftTargets.length > 0) {
      console.log(
        `  · feedback projection drift (${gate.driftTargets.join(', ')}) — will self-heal at /compact.`,
      );
    }
  }
  process.exit(0);
}

function applySessionClose(args) {
  // Option D: early-exit fires only when NO payload was supplied.
  // Rationale: payload presence is explicit close intent and must always run
  // the full apply path — the per-entry idempotency (writeIfChanged +
  // exact-entry append dedup) keeps re-apply cheap without short-circuiting,
  // and avoids silent-success when a same-day second close brings new bytes.
  // Payload-less invocation is treated as a cheap "already complete?" probe.
  // --force opts out of that probe shortcut only — payload remains required
  // for any actual apply work (readPayload below surfaces "payload is
  // required" the same way it always has).
  if (!args.force && !args.payload) {
    // ADR 0043: no-payload "already complete?" probe uses the
    // global invariant, not a recency pick.
    const probe = sessionCloseGlobalStatus(args.hypoDir);
    if (probe.ok) {
      const result = {
        ok: true,
        alreadyComplete: true,
        project: probe.project,
        date: probe.dates[0],
        message: '오늘 이미 close 완료로 보임 (probe 모드 — payload 미지정).',
      };
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✓ ${result.message}`);
        console.log(`  project: ${result.project} / date: ${result.date}`);
      }
      process.exit(0);
    }
    // gate not ok → fall through to readPayload, which surfaces
    // "payload is required" with the same error shape as before.
  }

  let payload;
  try {
    payload = readPayload(args.payload);
  } catch (e) {
    const out = { ok: false, error: e.message };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${e.message}`);
    process.exit(1);
  }

  const schemaErrs = validatePayloadShape(payload);
  if (schemaErrs.length > 0) {
    const out = { ok: false, error: 'payload schema invalid', details: schemaErrs };
    console.log(
      args.json
        ? JSON.stringify(out, null, 2)
        : `✗ payload schema invalid:\n  ${schemaErrs.join('\n  ')}`,
    );
    process.exit(1);
  }

  // Resolve project: payload.project is REQUIRED (B-3, close-gate-hardening). The
  // old recency fallback (payload.project || probe.project) could, on a same-date
  // root-hot.md tie, resolve a DIFFERENT project than the one the payload's files
  // belong to — apply would then write the close into the wrong project (silent
  // data loss). Validate fail-fast, BEFORE the probe is consulted:
  //   - missing      → no target to write; abort rather than infer.
  //   - invalid name → reject (non-string, wrong charset, or dot-only) BEFORE the
  //                    existsSync(join(...)) path build, so a `../`-style value
  //                    never reaches a path builder (traversal guard — order is
  //                    the guard). isValidProjectName is SHARED with createProject
  //                    so apply accepts exactly the namespace the repo can
  //                    scaffold (A-Za-z0-9._-, single segment) — no narrower.
  //   - non-existent → projects/<slug>/ absent; abort rather than create.
  // A payload.project that merely DIFFERS from the inferred active project is NOT an
  // error — it is surfaced as a stderr note below and the close proceeds.
  if (payload.project === undefined || payload.project === null) {
    const msg = 'payload.project is required (apply must not infer the close target project)';
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  if (!isValidProjectName(payload.project)) {
    const msg = `payload.project ${JSON.stringify(payload.project)} is not a valid project name (single segment, charset A-Za-z0-9._-, ≥1 alnum, not "."/"..")`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  // existsSync alone is not enough: a regular FILE at projects/<slug> would pass,
  // then apply would build child paths under it and fail with an unstructured
  // filesystem error (codex re-review). Require it to be a directory.
  const projectDir = join(args.hypoDir, 'projects', payload.project);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    const msg = `payload.project "${payload.project}" does not exist as a directory (no projects/${payload.project}/ directory)`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  const project = payload.project;
  // probe (the recency-inferred active project) is now consulted ONLY to surface a
  // divergence note — never to resolve the target. Computed AFTER validation so a
  // malformed/missing payload.project fails fast without a pointer-table read.
  // Resolved BEFORE preflight because preflight needs overwrite-target paths
  // (which require the project slug) to filter out errors in files this apply
  // is about to replace — see the filter rationale below.
  const probe = sessionCloseFileStatus(args.hypoDir);
  // The freshness verification below (and at the post-apply check) already honors
  // payload.project — `project` wins over the inferred active project, and the
  // post-apply sessionCloseFileStatus call passes it as projectOverride. But when the
  // payload targets a DIFFERENT project than the one active-project resolution infers
  // (probe.project), that divergence used to be silent, so an operator couldn't tell
  // which project the close actually verified. Surface it on stderr (the stdout JSON
  // contract is untouched) so the verified/closed project is always explicit.
  if (probe.project && probe.project !== payload.project) {
    process.stderr.write(
      `note: payload.project="${payload.project}" differs from the inferred active ` +
        `project "${probe.project}"; verifying and closing "${payload.project}".\n`,
    );
  }
  const date = payload.date || todayLocal();

  // B-1 derive precondition: when `log` is omitted, apply reconstructs the root
  // log.md entry from THIS close's sessionLog heading. If sessionLog.entry has no
  // `## [<date>] …` heading there is nothing to derive — and on a same-day SECOND
  // close the date-level freshness verifier would still pass on the earlier
  // close's entry, so the no-write would slip through as ok:true. Fail loud here,
  // before any writes (codex pre-commit review).
  if (
    !payload.log &&
    !new RegExp(`^#{1,6} \\[${date}\\]`, 'm').test(payload.sessionLog.entry || '')
  ) {
    const msg =
      `payload.sessionLog.entry has no "## [${date}] …" heading to derive the log.md ` +
      `entry from. Give it a dated heading, or supply payload.log explicitly.`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }

  // Preflight: lint the wiki BEFORE writing any payload bytes. If lint
  // has blockers (errors) in files this apply WON'T overwrite, the wiki is in
  // a degraded state and apply would mask the root cause — abort fail-fast.
  //
  // Overwrite-target filter (codex P2 follow-up): errors in files we're about
  // to fully replace are IGNORED at preflight. Otherwise a bad payload
  // (post-apply-lint fail) would leave the broken file on disk and the very
  // next retry — even with a corrected payload — gets dead-locked here. The
  // post-apply lint is the authoritative check on payload content.
  //
  // Append targets (session-log, log.md) are NOT filtered: appending can't
  // repair existing corruption, so a corrupt session-log must still block.
  // Warns are informational (not gated) in either pass.
  const overwriteTargets = new Set();
  if (payload.sessionState) overwriteTargets.add(join('projects', project, 'session-state.md'));
  if (payload.projectHot) overwriteTargets.add(join('projects', project, 'hot.md'));
  if (payload.rootHot) overwriteTargets.add('hot.md');
  if (payload.openQuestions) overwriteTargets.add(join('pages', 'open-questions.md'));

  // Bug B: the documented close path must not be blocked by lint debt OUTSIDE
  // the files it writes (other projects, shared pages this close did not author).
  // payloadScope = every file this apply writes or appends. Both lint passes are
  // judged against it; errors elsewhere are surfaced as notices, never blocking.
  //
  // session-log needs TWO entries (ADR 0050): the daily WRITE target (what this
  // apply creates/appends, judged by post-apply lint) AND the freshness EVIDENCE
  // file. They coincide except in the hybrid cutover month, where a fallback-
  // aware no-op (the identical entry already lives in the legacy monthly file)
  // writes no daily shard, leaving the monthly as the proof of freshness. Scope
  // must then include that monthly file, or a CORRUPT monthly evidence file would
  // pass the gate with its lint error demoted to a non-blocking notice.
  // sessionLogScopePath returns the monthly ONLY when it carries today's heading
  // (otherwise the daily write target), so unrelated monthly debt stays a notice.
  // join() (platform-native), not the POSIX helper output: payloadScope membership
  // is tested against lint's raw `e.file` (path.relative) WITHOUT posix
  // normalization, so it must use the OS-native separator the sibling entries use.
  const sessionLogWriteTarget = join('projects', project, 'session-log', `${date}.md`);
  const sessionLogEvidence = join(...sessionLogScopePath(args.hypoDir, project, date).split('/'));
  const payloadScope = new Set([
    join('projects', project, 'session-state.md'),
    join('projects', project, 'hot.md'),
    'hot.md',
    sessionLogWriteTarget,
    sessionLogEvidence, // == write target, except a hybrid-month monthly fallback
    'log.md',
    ...(payload.openQuestions ? [join('pages', 'open-questions.md')] : []),
  ]);

  let preflightLint;
  try {
    preflightLint = runLint(args.hypoDir);
  } catch (e) {
    const out = { ok: false, stage: 'preflight-lint', error: e.message };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${e.message}`);
    process.exit(1);
  }
  // Block only on errors in payload files we are NOT about to overwrite (append
  // targets — session-log, log.md — can't be repaired by appending, so existing
  // corruption there must block). Overwrite targets are about to be replaced;
  // out-of-scope debt is not this close's concern (Bug B).
  const blockingErrors = preflightLint.errors.filter(
    (e) => payloadScope.has(e.file) && !overwriteTargets.has(e.file),
  );
  if (blockingErrors.length > 0) {
    const out = {
      ok: false,
      stage: 'preflight-lint',
      error: 'lint preflight failed — apply aborted (no payload bytes written)',
      lint: { ...preflightLint, blockingErrors },
    };
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log('✗ lint preflight failed — apply aborted (no payload bytes written):');
      for (const e of blockingErrors) console.log(`  ✗ ${e.file}: ${e.message}`);
      console.log('  Fix the wiki (run `node scripts/lint.mjs`) and retry.');
    }
    process.exit(1);
  }

  const applied = [];
  const skipped = [];

  const overwrite = (key, relPath, field) => {
    if (!field || typeof field.content !== 'string') return; // optional / absent
    const wrote = writeIfChanged(join(args.hypoDir, relPath), field.content);
    (wrote ? applied : skipped).push(`${key} (${relPath})`);
  };

  overwrite('sessionState', join('projects', project, 'session-state.md'), payload.sessionState);
  overwrite('projectHot', join('projects', project, 'hot.md'), payload.projectHot);
  overwrite('rootHot', 'hot.md', payload.rootHot);
  overwrite('openQuestions', join('pages', 'open-questions.md'), payload.openQuestions);

  // Append idempotency: dedup by exact-entry presence, not by "any heading
  // dated today". The freshness gate (sessionCloseFileStatus) is what answers
  // "was this file touched today?"; that's a different concern and must not
  // be reused for apply-time dedup, or a legitimate same-day second close gets
  // silently dropped (Codex review of the apply path — Worker 1 finding 2).
  const entryAlreadyPresent = (entry) => (content) =>
    content.includes(entry.endsWith('\n') ? entry.replace(/\n+$/, '') : entry);

  {
    const rel = join('projects', project, 'session-log', `${date}.md`);
    const full = join(args.hypoDir, rel);
    const isPresent = entryAlreadyPresent(payload.sessionLog.entry);
    // Fallback-aware idempotency (ADR 0050 hybrid cutover): during the month the
    // shard takes over, today's entry may already live in the legacy monthly
    // file from an earlier (pre-cutover) close. Treat presence in EITHER the
    // daily shard or the legacy monthly file as "already written" so a same-day
    // second close does not duplicate an identical entry across both files —
    // and so an idempotent re-apply stays a true no-op (no shard is created).
    let alreadyThere = false;
    for (const cand of sessionLogReadCandidates(project, date)) {
      const cf = join(args.hypoDir, cand);
      if (!existsSync(cf)) continue;
      try {
        if (isPresent(readFileSync(cf, 'utf-8'))) {
          alreadyThere = true;
          break;
        }
      } catch {
        /* unreadable candidate — fall through to the write path */
      }
    }
    if (alreadyThere) {
      skipped.push(`sessionLog (${rel})`);
    } else if (!existsSync(full)) {
      // A daily shard is a new file most days. Seed minimal valid frontmatter
      // (title + type, the two REQUIRED_FIELDS) so the shard is a first-class
      // wiki page rather than a W1 "no frontmatter" warning, and write the header
      // AND the first entry in ONE atomic write — never leave a header-only shard
      // on disk, which freshness would skip (no dated heading) while derive could
      // otherwise mistake it for the evidence file. The dated `## [date] ...`
      // heading lives inside the entry, so freshness / derive / design-history
      // are unchanged.
      // PRAC-17 audit fields. The shard frontmatter is git-tracked and synced, so
      // `device` is an INTENTIONAL synced multi-machine identifier (privacy note:
      // docs/ARCHITECTURE.md). It is a CREATOR-only stamp — only the session/
      // machine that first seeds the daily shard is recorded; later same-day
      // appends do not touch it. The per-session-accurate store is the LOCAL
      // (.cache/, gitignored) index.jsonl written by hypo-session-record.mjs.
      // `session_id` is honest naming: the value is the Claude session UUID, and
      // it is present only on the Stop-chain close path that passes --session-id.
      const device = String(hostname() || 'unknown').replace(/[\r\n]/g, '');
      const auditFm =
        (args.sessionId ? `session_id: ${String(args.sessionId).replace(/[\r\n]/g, '')}\n` : '') +
        `device: ${device}\n`;
      const header =
        `---\ntitle: Session Log ${date} (${project})\n` +
        `type: session-log\nupdated: ${date}\n${auditFm}---\n\n` +
        `# Session Log ${date} (${project})\n`;
      const entry = payload.sessionLog.entry;
      const body = entry.endsWith('\n') ? entry : `${entry}\n`;
      atomicWrite(full, `${header}\n${body}`);
      applied.push(`sessionLog (${rel})`);
    } else {
      const wrote = appendIfAbsent(full, payload.sessionLog.entry, isPresent);
      (wrote ? applied : skipped).push(`sessionLog (${rel})`);
    }
  }

  // log.md: `payload.log` is OPTIONAL (B-1). When the caller supplies it, keep
  // the explicit appendIfAbsent path (backward-compat: a custom log line, with
  // the same idempotent dedup). When it is ABSENT, the root log.md entry is a
  // DERIVABLE artifact: reconstruct the canonical `## [date] session | <project>`
  // line directly from THIS close's session-log heading (`payload.sessionLog`),
  // not by re-reading the session-log files. Deriving from the payload is what
  // makes the per-close entry exact: a same-day second close lands its distinct
  // heading, and a hybrid daily/monthly session-log split can't hide it (apply
  // never reads those files for this). The global scan-based deriveRootLogEntries
  // (the Stop hook) still backfills OTHER projects; calling it here would either
  // miss the current entry (single-candidate read) or, with a loosened guard,
  // append onto a deliberately custom payload.log (codex pre-commit review). The
  // two payload paths are mutually exclusive: deriving on top of a present-but-
  // malformed payload.log would mask it and weaken the verifier's fail-loud.
  if (payload.log) {
    const wrote = appendIfAbsent(
      join(args.hypoDir, 'log.md'),
      payload.log.entry,
      entryAlreadyPresent(payload.log.entry),
    );
    (wrote ? applied : skipped).push('log (log.md)');
  } else {
    // matchAll (not exec) mirrors deriveRootLogEntries: a payload that carried
    // more than one dated heading derives one canonical line each, symmetric with
    // the global path. Exact-line dedup on the heading keeps a second apply (or a
    // titleless vs titled same-day pair) from duplicating.
    const logFull = join(args.hypoDir, 'log.md');
    const headingRe = new RegExp(`^#{1,6} \\[${date}\\]\\s*(.*)$`, 'gm');
    let wroteAny = false;
    for (const m of (payload.sessionLog.entry || '').matchAll(headingRe)) {
      const { heading, block } = rootLogEntry(project, date, m[1]);
      const wrote = appendIfAbsent(logFull, block, (c) =>
        (c || '').split(/\r?\n/).includes(heading),
      );
      wroteAny = wroteAny || wrote;
    }
    (wroteAny ? applied : skipped).push('log (log.md, derived)');
  }

  // Same-date-tie fix: verify against the SAME project this apply just wrote
  // (`project` = payload.project || probe.project, resolved at the top). Without
  // the override, sessionCloseFileStatus re-derives via resolveActiveProject and,
  // on a same-date root-hot.md tie, can pick a different project — false-failing
  // a completed close (the 2026-06-09 security-ops-kb incident).
  const verification = sessionCloseFileStatus(args.hypoDir, { projectOverride: project });

  // B-4 auto-register: lift unknown (non-forbidden) tags surfaced by the PREFLIGHT
  // lint into SCHEMA.md's `### Pending` section so the post-apply lint sees them as
  // known and the close never stalls on a vocabulary gap. The W10 id is hidden in
  // non-strict --json output (lint.mjs toOut), so the unknown-tag warns are matched
  // and the tag extracted from the message string itself — kept in lockstep with
  // lint.mjs's W10 emit (a copy-edit there breaks this; the close-path round-trip
  // test guards it). Forbidden patterns stay hard errors and are filtered out.
  // SCOPE (eventual consistency, intended): this registers PRE-EXISTING wiki debt
  // visible at preflight, NOT a novel tag this very close's payload introduces —
  // that one would surface only at post-apply and lands on the NEXT close. The
  // contract is "must not stall", which warns (not errors) already satisfy; the
  // registration just keeps the vocabulary catching up.
  // The capture is anchored on the FULL message suffix (not `[^"]+`) so a tag that
  // itself contains a `"` — non-forbidden, so reachable — is captured whole rather
  // than truncated at its first quote (codex stage-2 CONCERN).
  const unknownTagRe = /^Unknown tag: "(.+)" \(not in SCHEMA\.md Tag Vocabulary\)/;
  const pendingTags = [];
  for (const w of preflightLint.warns || []) {
    const m = unknownTagRe.exec(w.message || '');
    if (m && !checkForbidden(m[1])) pendingTags.push(m[1]);
  }
  if (pendingTags.length > 0) appendPendingTags(args.hypoDir, pendingTags);

  // Post-apply lint: payload may have introduced a malformed body or
  // bad frontmatter. Surface as a distinct `stage` so caller can tell "lint
  // broke" apart from "frontmatter stale". This runs even if the freshness gate
  // also failed — both failure modes are useful to the caller.
  let postApplyLint;
  let postApplyCrashed = false;
  try {
    postApplyLint = runLint(args.hypoDir);
  } catch (e) {
    // A lint crash (unparseable output) after writes is NOT scopeable — there is
    // no reliable `file` to classify — and must stay a HARD failure, exactly as
    // before scoping was introduced.
    postApplyCrashed = true;
    postApplyLint = {
      ok: false,
      errors: [{ file: '(lint crash)', message: e.message }],
      warns: [],
    };
  }

  // Scope post-apply lint to payload files (Bug B): a payload-introduced error
  // lands in a file this apply wrote, so it blocks; pre-existing debt elsewhere
  // is a non-blocking notice. A lint crash bypasses scoping and blocks outright.
  let postBlocking;
  let postNotice;
  if (postApplyCrashed) {
    postBlocking = postApplyLint.errors;
    postNotice = [];
  } else {
    ({ blocking: postBlocking, notice: postNotice } = partitionLintScope(
      postApplyLint.errors || [],
      payloadScope,
    ));
  }
  const postLintOk = !postApplyCrashed && postBlocking.length === 0;
  const ok = verification.ok && postLintOk;

  // Scope the non-blocking notice to the close-target project: debt under
  // projects/<project>/ stays listed; debt elsewhere folds to a count so the
  // same untouched-file debt does not re-list its filenames on every close.
  const closeScopeNotice = postNotice.filter((e) => isUnderProjectDirs(e.file, [project]));
  const otherDebtCount = postNotice.length - closeScopeNotice.length;

  // ADR 0022 amendment 2026-05-19: auto-write the per-session
  // closed marker on a verified close. Hook authority is read-only; this is
  // one of the two writer paths (the other is --mark-session-closed standalone).
  //
  // ADR 0047: the marker write is governed by the SAME gate as standalone
  // --mark-session-closed and /compact (precompactGateStatus), NOT just apply's
  // `ok` + git-clean. Apply's payload preflight/post-apply lint and `ok` still
  // govern apply SUCCESS (exit code below), but the marker must additionally
  // clear feedback projection / W8 design-history / hot.md structure, else this
  // path could issue a marker the standalone path would refuse (the second
  // divergence codex flagged).
  //
  // ADR 0056: apply just wrote the payload, so the tree is dirty by its OWN
  // writes — the gate's `uncommitted` git blocker would always trip and the
  // marker would be skipped, deferring the close to a manual --mark-session-closed
  // (the ADR 0047 "done but still blocked" regression). Commit the payload HERE, via
  // the SAME .hypoignore-aware helper the auto-commit Stop hook uses, so the gate sees
  // a committed tree. Push stays deferred to the Stop hook; the resulting
  // committed-but-unpushed state is a gate notice, not a blocker (ADR 0056), so
  // this still marks. A commit failure (not a repo / pre-commit reject / git error)
  // skips the marker WITH a surfaced reason — today's behavior was also "no marker",
  // but silently.
  let markerWritten = false;
  let markerSkipReason = null;
  if (ok && args.sessionId) {
    const commitOutcome = commitWikiChanges(args.hypoDir);
    if (!commitOutcome.committed) {
      markerSkipReason = `commit-failed: ${commitOutcome.reason}`;
    } else {
      const closeTranscript = resolveTranscriptBySessionId(args.sessionId);
      const markerGate = precompactGateStatus(
        args.hypoDir,
        closeTranscript ? { transcriptPath: closeTranscript } : {},
      );
      if (!markerGate.ok) {
        // compact gate not ok → skip. Caller's `result.ok` already reflects the
        // file/lint state; next Stop re-blocks until the remaining blocker
        // (feedback/W8/hot/lint — git is now committed) is resolved.
        markerSkipReason = 'compact-gate-not-ok';
      } else if (!closeTranscript || !hasUserCloseSignal(closeTranscript)) {
        // User-close hard gate (ADR 0055): apply succeeded (payload files written)
        // but the user never signalled session close, so the marker — which attests
        // "user closed" — is withheld. The wiki record stands; the session is simply
        // not marked closed. Surfaced (not silent) so the caller knows.
        markerSkipReason = closeTranscript ? 'no-user-close-signal' : 'transcript-unresolved';
      } else {
        writeSessionClosedMarker(args.hypoDir, args.sessionId, { project });
        // Codex CONCERN (ADR 0055/0056): the writer swallows IO errors (best-effort).
        // Verify the file actually landed — mirroring the standalone path — instead of
        // asserting markerWritten=true, so a .cache permission/disk problem surfaces
        // rather than the caller reporting "closed" while the next Stop re-blocks.
        if (existsSync(sessionClosedMarkerPath(args.hypoDir, args.sessionId))) {
          markerWritten = true;
        } else {
          markerSkipReason = 'marker-did-not-land';
        }
      }
    }
  }
  const stage = ok
    ? null
    : !verification.ok && !postLintOk
      ? 'post-apply-verification+lint'
      : !verification.ok
        ? 'post-apply-verification'
        : 'post-apply-lint';
  const result = {
    ok,
    stage,
    project,
    date,
    applied,
    skipped,
    verification,
    // ADR 0055: surface the marker outcome instead of skipping silently, so the
    // caller can tell "closed" from "applied but not marked".
    ...(args.sessionId ? { markerWritten, markerSkipReason } : {}),
    lint: { preflight: preflightLint, postApply: postApplyLint },
    // Pre-existing lint debt in files this close did not author: surfaced for
    // visibility, never gated. Empty on a clean vault. Scoped to the close-target
    // project's own dir — debt under projects/<project>/ is this close's
    // neighborhood and stays listed; debt elsewhere (other projects, shared
    // pages, root files) folds into otherDebtCount so the same untouched-file
    // debt does not re-list its filenames on every close (run `node
    // scripts/lint.mjs` for the full list).
    notices: [...new Set(closeScopeNotice.map((e) => e.file))],
    otherDebtCount,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Session-close apply (project: ${project}, date: ${date}):`);
    for (const a of applied) console.log(`  ✓ wrote ${a}`);
    for (const s of skipped) console.log(`  · skipped ${s} (already current)`);
    if (ok) {
      // When the marker was withheld, qualify the success line so a reader scanning
      // stdout alone cannot mistake "verified" for "fully closed". markerSkipReason
      // is non-null exactly when args.sessionId is set and the marker did not land.
      if (markerSkipReason) {
        console.log(
          '\n✓ session-close files verified (all 5 mandatory files fresh, lint clean).' +
            '\n  session NOT fully closed: the Stop-chain marker was not written (see warning below).',
        );
      } else {
        console.log('\n✓ session-close verified — all 5 mandatory files fresh, lint clean.');
      }
    }
    // When ok:true but the session-close marker was NOT written, the Stop-chain
    // still sees an open session and will re-prompt at the next Stop. Surface this
    // loudly so neither the human nor a skill-following model reads "ok:true" as
    // "session fully closed". Gate on markerSkipReason (non-null exactly when
    // args.sessionId is present and the marker was withheld).
    if (markerSkipReason) {
      process.stderr.write(
        `\n⚠️  session-close marker NOT written (reason: ${markerSkipReason})\n` +
          `    The 5 mandatory files were applied and verified (ok:true), but the\n` +
          `    per-session Stop-chain marker was withheld. The session is NOT fully\n` +
          `    closed: the Stop hook will re-prompt until the marker is present.\n` +
          `    To fix: re-run with the correct main-conversation --session-id (NOT\n` +
          `    a background task or Agent UUID from a /tmp/... path).\n` +
          `    Example: crystallize.mjs --apply-session-close --payload=<path>\n` +
          `             --session-id=<main-conversation-id> --hypo-dir=<path>\n`,
      );
    }
    if (!ok) {
      if (!verification.ok) {
        const bad = [
          ...verification.missing.map((f) => `${f} (missing)`),
          ...verification.stale.map((f) => `${f} (stale)`),
        ].join(', ');
        console.log(`\n✗ session-close still incomplete after apply: ${bad}`);
        console.log('  Fix the payload (likely an `updated:` field) and retry.');
      }
      if (!postLintOk) {
        console.log('\n✗ post-apply lint failed:');
        for (const e of postBlocking) console.log(`  ✗ ${e.file}: ${e.message}`);
        console.log('  Payload introduced a lint blocker — fix the payload content and retry.');
      }
    }
    if (closeScopeNotice.length > 0) {
      console.log(
        `\n· ${closeScopeNotice.length} pre-existing lint issue(s) in untouched files (not blocking): ${[
          ...new Set(closeScopeNotice.map((e) => e.file)),
        ]
          .slice(0, 5)
          .join(', ')}${closeScopeNotice.length > 5 ? ', …' : ''}`,
      );
    }
    if (otherDebtCount > 0) {
      console.log(
        `\n· +${otherDebtCount} pre-existing lint issue(s) elsewhere in the vault (other projects / shared pages, not blocking) — run \`node scripts/lint.mjs\` for the full list.`,
      );
    }
  }
  process.exit(ok ? 0 : 1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return fm;
}

function parseTags(fm) {
  if (!fm.tags) return [];
  const raw = fm.tags.trim().replace(/^\[|\]$/g, '');
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.markSessionClosed) {
  runMarkSessionClosed(args); // exits
}

if (args.applySessionClose) {
  applySessionClose(args); // exits
}

if (args.checkSessionClose) {
  runSessionCloseCheck(args); // exits
}

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const pagesDir = join(args.hypoDir, 'pages');
const pages = collectPagesCrystallize(pagesDir, args.hypoDir, ignorePatterns);

const tagGroups = {}; // tag → [{ slug, title }]
const unlinked = []; // pages with no outbound wikilinks
const drafts = []; // pages tagged draft

for (const { path, rel } of pages) {
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    continue;
  }
  const fm = parseFrontmatter(content);
  if (!fm) continue;

  const slug = rel.replace(/\.md$/, '');
  const title = fm.title || slug;
  const tags = parseTags(fm);

  // tag groups
  for (const tag of tags) {
    if (!tagGroups[tag]) tagGroups[tag] = [];
    tagGroups[tag].push({ slug, title });
  }

  // draft detection
  if (tags.includes('draft') || fm.confidence === 'speculative') {
    drafts.push({ slug, title, confidence: fm.confidence });
  }

  // unlinked (no outbound wikilinks in body)
  const body = content.replace(/^---[\s\S]*?---/, '');
  const links = extractWikilinks(body);
  if (links.length === 0) unlinked.push({ slug, title });
}

// filter tag groups by min-group
const synthesisGroups = Object.entries(tagGroups)
  .filter(([, pages]) => pages.length >= args.minGroup)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([tag, pages]) => ({ tag, pages }));

if (args.json) {
  console.log(JSON.stringify({ synthesisGroups, unlinked, drafts }, null, 2));
  process.exit(0);
}

let found = false;

if (synthesisGroups.length > 0) {
  found = true;
  console.log(`Synthesis candidates by tag (${synthesisGroups.length} group(s)):\n`);
  for (const { tag, pages: grp } of synthesisGroups) {
    console.log(`  [${tag}] (${grp.length} pages):`);
    for (const p of grp) console.log(`    [[${p.slug}]] — ${p.title}`);
  }
  console.log('');
}

if (unlinked.length > 0) {
  found = true;
  console.log(`Unlinked pages (no outbound [[wikilinks]]) — ${unlinked.length}:`);
  for (const p of unlinked) console.log(`  [[${p.slug}]] — ${p.title}`);
  console.log('');
}

if (drafts.length > 0) {
  found = true;
  console.log(`Draft/speculative pages ready to crystallize — ${drafts.length}:`);
  for (const p of drafts) console.log(`  [[${p.slug}]] — ${p.title}`);
  console.log('');
}

if (!found) {
  console.log('✓ No crystallization candidates found — Hypomnema looks well-connected.');
}
