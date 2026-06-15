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
 *     "project":      "<slug>",                       // optional — defaults to resolveActiveProject()
 *     "date":         "YYYY-MM-DD",                   // optional — defaults to today (local)
 *     "sessionState": { "content": "<full file>" },   // overwrite (idempotent: identical bytes → skip)
 *     "projectHot":   { "content": "<full file>" },   // overwrite
 *     "rootHot":      { "content": "<full file>" },   // overwrite
 *     "sessionLog":   { "entry":   "## [date] ..." }, // append, skip if heading already present
 *     "log":          { "entry":   "## [date] session | <project> ..." }, // append, skip if entry present
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

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'fs';
import { join, relative, extname, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';
import {
  sessionCloseFileStatus,
  sessionCloseGlobalStatus,
  precompactGateStatus,
  writeSessionClosedMarker,
  sessionClosedMarkerPath,
  readSessionClosedMarker,
  partitionLintScope,
  sessionLogShardPath,
  sessionLogReadCandidates,
  sessionLogScopePath,
} from '../hooks/hypo-shared.mjs';

const LINT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'lint.mjs');

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
    sessionId: null,
    payload: null,
    force: false,
    transcriptPath: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--min-group=')) args.minGroup = parseInt(arg.slice(12), 10) || 2;
    else if (arg === '--check-session-close') args.checkSessionClose = true;
    else if (arg === '--apply-session-close') args.applySessionClose = true;
    else if (arg === '--mark-session-closed') args.markSessionClosed = true;
    else if (arg.startsWith('--session-id=')) args.sessionId = arg.slice(13);
    else if (arg.startsWith('--payload=')) args.payload = arg.slice(10);
    else if (arg.startsWith('--transcript-path=')) args.transcriptPath = expandHome(arg.slice(18));
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
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
  const status = precompactGateStatus(args.hypoDir, { transcriptPath: args.transcriptPath });
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
  const markerPresent = args.sessionId
    ? readSessionClosedMarker(args.hypoDir, args.sessionId) !== null
    : null;

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
          ...(args.sessionId ? { session_id: args.sessionId, marker_present: markerPresent } : {}),
        },
        null,
        2,
      ),
    );
    process.exit(status.ok ? 0 : 1);
  }

  const proj = close.project || '(unresolved)';
  console.log(`Compact-ready check (project: ${proj}, date: ${close.dates.join(' / ')}):\n`);

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
        : `  · session-closed marker absent (session_id: ${args.sessionId}) — the Stop hook will block until it is written. Run \`crystallize --mark-session-closed --session-id=${args.sessionId}${args.transcriptPath ? ` --transcript-path=${args.transcriptPath}` : ''}\`.`,
    );
  }
  console.log('');
  console.log(
    status.ok
      ? '✓ Compact-ready — no PreCompact gate blocker needs a human fix. (open-questions.md: conditional, not checked. The live /compact can still differ on a context-≥70% prompt, HYPO_SKIP_GATE, or a transcript-scoped lint error this check did not see — pass --transcript-path to include the latter.)'
      : '✗ Not compact-ready — resolve the ✗ items above, then retry. /compact would block on these.',
  );
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

// Spec §5.2.7 / §8.3 + ADR 0029: 5 mandatory + 1 conditional. The payload
// shape MUST mirror that contract — missing a mandatory field is a payload
// bug, not a no-op. Caller is the LLM session-close flow, which composes the
// payload deliberately; partial payloads must fail loudly so caller fixes them
// rather than silently relying on yesterday's freshness state. (Codex review
// of the apply path — Worker 1 finding 1.)
const REQUIRED_PAYLOAD_FIELDS = [
  ['sessionState', 'content'],
  ['projectHot', 'content'],
  ['rootHot', 'content'],
  ['sessionLog', 'entry'],
  ['log', 'entry'],
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
  const gate = precompactGateStatus(
    args.hypoDir,
    args.transcriptPath ? { transcriptPath: args.transcriptPath } : {},
  );
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
  writeSessionClosedMarker(args.hypoDir, args.sessionId, { project: status.project });
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
    project: status.project,
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
      `✓ session-closed marker written (session_id: ${args.sessionId}, project: ${status.project}).`,
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

  // Resolve project: explicit payload.project wins; else fall back to active project.
  // Done via sessionCloseFileStatus to keep one source of truth (and so a
  // missing pointer table surfaces the same error shape as --check-session-close).
  // Resolved BEFORE preflight because preflight needs overwrite-target paths
  // (which require the project slug) to filter out errors in files this apply
  // is about to replace — see the filter rationale below.
  const probe = sessionCloseFileStatus(args.hypoDir);
  const project = payload.project || probe.project;
  if (!project) {
    const msg =
      'no project resolved (payload.project missing and root hot.md has no active-project row)';
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  // The freshness verification below (and at the post-apply check) already honors
  // payload.project — `project` wins over the inferred active project, and the
  // post-apply sessionCloseFileStatus call passes it as projectOverride. But when the
  // payload targets a DIFFERENT project than the one active-project resolution infers
  // (probe.project), that divergence used to be silent, so an operator couldn't tell
  // which project the close actually verified. Surface it on stderr (the stdout JSON
  // contract is untouched) so the verified/closed project is always explicit.
  if (payload.project && probe.project && probe.project !== payload.project) {
    process.stderr.write(
      `note: payload.project="${payload.project}" differs from the inferred active ` +
        `project "${probe.project}"; verifying and closing "${payload.project}".\n`,
    );
  }
  const date = payload.date || todayLocal();

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
      const header =
        `---\ntitle: Session Log ${date} (${project})\n` +
        `type: session-log\nupdated: ${date}\n---\n\n` +
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

  {
    const wrote = appendIfAbsent(
      join(args.hypoDir, 'log.md'),
      payload.log.entry,
      entryAlreadyPresent(payload.log.entry),
    );
    (wrote ? applied : skipped).push('log (log.md)');
  }

  // Same-date-tie fix: verify against the SAME project this apply just wrote
  // (`project` = payload.project || probe.project, resolved at the top). Without
  // the override, sessionCloseFileStatus re-derives via resolveActiveProject and,
  // on a same-date root-hot.md tie, can pick a different project — false-failing
  // a completed close (the 2026-06-09 security-ops-kb incident).
  const verification = sessionCloseFileStatus(args.hypoDir, { projectOverride: project });

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
  // divergence codex flagged). git-clean is subsumed by the gate's git blocker.
  if (ok && args.sessionId) {
    const markerGate = precompactGateStatus(
      args.hypoDir,
      args.transcriptPath ? { transcriptPath: args.transcriptPath } : {},
    );
    if (markerGate.ok) {
      writeSessionClosedMarker(args.hypoDir, args.sessionId, { project });
    }
    // gate not ok → silent skip: caller's `result.ok` already reflects the
    // file/lint state; surfacing a "marker skipped" warning here would
    // confuse the close-applied success path. Next Stop re-blocks until the
    // remaining blocker (git/feedback/W8/hot/lint) is resolved.
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
    lint: { preflight: preflightLint, postApply: postApplyLint },
    // Pre-existing lint debt in files this close did not author (Bug B): surfaced
    // for visibility, never gated. Empty on a clean vault.
    notices: [...new Set(postNotice.map((e) => e.file))],
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Session-close apply (project: ${project}, date: ${date}):`);
    for (const a of applied) console.log(`  ✓ wrote ${a}`);
    for (const s of skipped) console.log(`  · skipped ${s} (already current)`);
    if (ok) {
      console.log('\n✓ session-close verified — all 5 mandatory files fresh, lint clean.');
    } else {
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
    if (postNotice.length > 0) {
      console.log(
        `\n· ${postNotice.length} pre-existing lint issue(s) in untouched files (not blocking): ${[
          ...new Set(postNotice.map((e) => e.file)),
        ]
          .slice(0, 5)
          .join(', ')}${postNotice.length > 5 ? ', …' : ''}`,
      );
    }
  }
  process.exit(ok ? 0 : 1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectPages(dir, root, acc = [], ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectPages(full, root, acc, ignorePatterns);
    else if (extname(entry) === '.md') {
      acc.push({ path: full, rel: relative(root, full) });
    }
  }
  return acc;
}

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

function extractWikilinks(content) {
  return [...content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)].map((m) => m[1].trim());
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
const pages = collectPages(pagesDir, args.hypoDir, [], ignorePatterns);

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
