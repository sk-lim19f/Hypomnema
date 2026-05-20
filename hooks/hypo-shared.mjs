#!/usr/bin/env node
/**
 * hypo-shared.mjs — shared utilities for Hypomnema hooks
 *
 * Imported by personal-wiki-check.mjs, wiki-compact-guard.mjs, and others.
 * Hooks are deployed to ~/.claude/hooks/ — no external imports allowed.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from 'fs';
import { join, relative, basename } from 'path';
import { homedir, hostname } from 'os';
import { spawnSync } from 'child_process';

const HOME = homedir();

// ── wiki root resolution ────────────────────────────────────────────────────

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2));
  return p;
}

/**
 * Resolve Hypomnema root: HYPO_DIR env → hypo-config.md scan → ~/hypomnema default.
 * @returns {string}
 */
function resolveHypoRoot() {
  if (process.env.HYPO_DIR) return expandHome(process.env.HYPO_DIR);

  const candidates = [
    join(HOME, 'hypomnema'),
    join(HOME, 'wiki'),
    join(HOME, 'notes'),
    join(HOME, 'knowledge'),
    join(HOME, 'Documents', 'hypomnema'),
    join(HOME, 'Documents', 'wiki'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'hypo-config.md'))) return c;
  }
  return join(HOME, 'hypomnema');
}

export const HYPO_DIR = resolveHypoRoot();
export const LOG_PATH = join(HYPO_DIR, 'log.md');
export const HOT_PATH = join(HYPO_DIR, 'hot.md');
export const GUIDE_PATH = join(HYPO_DIR, 'hypo-guide.md');

// Package root: written by init/upgrade to ~/.claude/hypo-pkg.json
function resolvePkgRoot() {
  const p = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, 'utf-8')).pkgRoot;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}
export const PKG_ROOT = resolvePkgRoot();

// Optional H2 allowlist for hot.md validation.
// Set HYPO_ALLOWED_HOT_H2=comma,separated,headings to enable.
const _allowedH2Env = process.env.HYPO_ALLOWED_HOT_H2;
export const ALLOWED_HOT_H2 = _allowedH2Env
  ? new Set(_allowedH2Env.split(',').map((s) => s.trim()))
  : null;

// ── skip-gate helper ───────────────────────────────────────────────────────

/** Returns true if the wiki gate should be bypassed. */
export function isGateSkipped() {
  return process.env.HYPO_SKIP_GATE === '1';
}

// ── state checkers ─────────────────────────────────────────────────────────

export function lastSubstantialOpIsSession() {
  if (!existsSync(LOG_PATH)) return true;
  const log = readFileSync(LOG_PATH, 'utf-8');
  const substantial = log
    .split('\n')
    .filter((l) => /^## \[\d{4}-\d{2}-\d{2}\] (session|ingest)/.test(l));
  if (substantial.length === 0) return true;
  return /^## \[\d{4}-\d{2}-\d{2}\] session/.test(substantial[substantial.length - 1]);
}

export function hypoIsClean(dir = HYPO_DIR) {
  try {
    const porcelain = spawnSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf-8',
    });
    if (porcelain.status !== 0) return { clean: false, reason: `git check failed in ${dir}` };
    if (porcelain.stdout.trim() !== '')
      return { clean: false, reason: `uncommitted changes in ${dir}` };
    const ahead = spawnSync('git', ['-C', dir, 'status', '--branch', '--porcelain'], {
      encoding: 'utf-8',
    });
    if (/\[ahead \d+\]/.test(ahead.stdout || ''))
      return { clean: false, reason: `unpushed commits in ${dir}` };
    return { clean: true };
  } catch {
    return { clean: false, reason: `git check failed in ${dir}` };
  }
}

export function hotMdIsClean() {
  if (!existsSync(HOT_PATH)) return { clean: true };
  const content = readFileSync(HOT_PATH, 'utf-8');
  const reasons = [];

  // Optional: check H2 allowlist if HYPO_ALLOWED_HOT_H2 is set
  if (ALLOWED_HOT_H2) {
    const h2s = [...content.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    const extra = h2s.filter((h) => !ALLOWED_HOT_H2.has(h));
    if (extra.length > 0) reasons.push(`hot.md has unexpected H2 sections: ${extra.join(', ')}`);
  }

  // Always check for forbidden frontmatter fields
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch && /^last_session:/m.test(fmMatch[1])) {
    reasons.push('hot.md frontmatter has forbidden field: last_session');
  }

  return reasons.length === 0 ? { clean: true } : { clean: false, reason: reasons.join(' / ') };
}

// ── strict session-close verification (fix #17) ────────────────────────────
// spec §5.2.7 / §8.3 (updated 2026-05-15): session-close = steps 1~6 of the
// 11-step crystallize checklist (synthesis is steps 7~11). The hard gate
// (sessionCloseFileStatus) confirms the 5 mandatory files — session-state.md,
// project hot.md, root hot.md, session-log/YYYY-MM.md, and log.md.
// pages/open-questions.md (step 5) is conditional ("변경 시") — it is a
// cross-project queue, so a session that raises no questions should not be
// forced to touch it. Gating it would produce false-blocks; spec §5.2.7
// records this as the intended policy.
//
// Known limitation: freshness is date-based per spec §8.3 ("timestamp가 같음"),
// so a second session on the same day that skips updating a file still passes
// if an earlier close that day already stamped it. freshDates() accepting both
// local and UTC dates widens that window by up to one UTC offset. A per-session
// boundary is out of scope for fix #17.

/** Parse the frontmatter `updated:` field. Returns the trimmed value or null. */
function frontmatterUpdated(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const u = m[1].match(/^updated:\s*(.+)$/m);
  return u ? u[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** Escape a string for safe literal use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `content` carries an ATX heading dated `date` (YYYY-MM-DD), e.g.
 *   `## [2026-05-15] something`. Matches H1-H6.
 * Shared by sessionCloseFileStatus() and the crystallize apply helper so both
 * use the same definition of "session-log already updated for today".
 */
export function hasSessionLogHeading(content, date) {
  return new RegExp('^#{1,6} \\[' + escapeRegExp(date) + '\\]', 'm').test(content || '');
}

/**
 * True if `content` carries a today-dated `## [date] session | <project>` entry
 * in log.md.
 *
 * Bounded with an explicit `(?=\s|$)` lookahead, NOT `\b`: a regex word boundary
 * matches between word and non-word chars, so `\b` after "foo" still matches in
 * "foo-bar" (hyphen is non-word). The canonical log format always separates the
 * project slug from anything that follows by whitespace or end-of-line, so the
 * lookahead correctly rejects "session | foo-bar" when looking for "foo".
 * (Reported by codex review of fix #38 — was a pre-existing bug in
 * sessionCloseFileStatus that the helper extraction inherited.)
 */
export function hasLogEntry(content, date, project) {
  return new RegExp(
    '^## \\[' + escapeRegExp(date) + '\\] session \\| ' + escapeRegExp(project) + '(?=\\s|$)',
    'm',
  ).test(content || '');
}

/**
 * Date strings that count as "today" for freshness checks. Both the local and
 * UTC dates are accepted: Claude writes file dates in the user's local zone,
 * while hypo-hot-rebuild stamps root hot.md with the UTC date. Accepting both
 * removes the ~timezone-offset window where a correctly closed session would
 * otherwise false-block.
 * @returns {string[]} 1-2 ISO dates (YYYY-MM-DD), most-relevant first.
 */
export function freshDates() {
  const d = new Date();
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const utc = d.toISOString().slice(0, 10);
  return local === utc ? [local] : [local, utc];
}

/**
 * Resolve the most-recently-active project slug from root hot.md.
 * Mirrors scripts/resume.mjs resolveActiveProject — kept in sync by hand.
 * @param {string} hypoDir
 * @returns {string|null}
 */
export function resolveActiveProject(hypoDir) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return null;
  let content;
  try {
    content = readFileSync(hotPath, 'utf-8');
  } catch {
    return null;
  }
  // Canonical hot.md uses wikilinks: | name | date | [[projects/slug/hot]] |
  const wikiRows = [
    ...content.matchAll(
      /\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g,
    ),
  ].map((m) => ({ name: m[1].trim(), date: m[2] || '', slug: m[3] }));
  if (wikiRows.length > 0) {
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
    return wikiRows[0].slug;
  }
  // Legacy markdown-link rows: | [name](projects/name/...) | ...
  const mdRow = content.match(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/);
  if (mdRow) return mdRow[2];
  return null;
}

/**
 * Strict session-close verification (fix #17, spec §5.2.7 / §8.3).
 * Confirms the memory files a session close must touch were updated today:
 *   - projects/<project>/session-state.md       — frontmatter `updated:` is today
 *   - projects/<project>/hot.md                 — frontmatter `updated:` is today
 *   - hot.md (root)                             — frontmatter `updated:` is today
 *   - projects/<project>/session-log/YYYY-MM.md — has a `## [today]` heading
 *   - log.md                                    — has a `## [today] session | <project>` entry
 * The log.md check is project-scoped so a session close left incomplete for
 * project A can't be masked by a fresh close of project B (and vice versa).
 * open-questions.md (file #5) is conditional and not gated.
 *
 * @param {string} hypoDir
 * @returns {{ok: boolean, project: string|null, dates: string[], stale: string[], missing: string[]}}
 */
export function sessionCloseFileStatus(hypoDir) {
  const dates = freshDates();
  const project = resolveActiveProject(hypoDir);
  if (!project) {
    return {
      ok: false,
      project: null,
      dates,
      stale: [],
      missing: ['hot.md (no active project in pointer table)'],
    };
  }

  const stale = []; // exists but not updated this session
  const missing = []; // file does not exist

  const checkUpdated = (relPath) => {
    const full = join(hypoDir, relPath);
    if (!existsSync(full)) {
      missing.push(relPath);
      return;
    }
    let content;
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      missing.push(relPath);
      return;
    }
    if (!dates.includes(frontmatterUpdated(content))) stale.push(relPath);
  };

  checkUpdated(join('projects', project, 'session-state.md'));
  checkUpdated(join('projects', project, 'hot.md'));
  checkUpdated('hot.md');

  // session-log: monthly append-only file — must carry a today-dated heading.
  // Reported under the local date's month (dates[0]) when no match is found.
  let sessionLogOk = false;
  for (const date of dates) {
    const full = join(hypoDir, 'projects', project, 'session-log', `${date.slice(0, 7)}.md`);
    if (!existsSync(full)) continue;
    let content = '';
    try {
      content = readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    if (hasSessionLogHeading(content, date)) {
      sessionLogOk = true;
      break;
    }
  }
  if (!sessionLogOk) {
    const logRel = join('projects', project, 'session-log', `${dates[0].slice(0, 7)}.md`);
    (existsSync(join(hypoDir, logRel)) ? stale : missing).push(logRel);
  }

  // log.md: must carry a today-dated `session` entry for the resolved project.
  const logFull = join(hypoDir, 'log.md');
  if (!existsSync(logFull)) {
    missing.push('log.md');
  } else {
    let content = '';
    try {
      content = readFileSync(logFull, 'utf-8');
    } catch {
      missing.push('log.md');
    }
    const logFresh = content && dates.some((d) => hasLogEntry(content, d, project));
    if (content && !logFresh) stale.push('log.md');
  }

  return { ok: stale.length === 0 && missing.length === 0, project, dates, stale, missing };
}

// ── sync-state (fix #9/#10/#11) ────────────────────────────────────────────
// `.cache/sync-state.json` is JSONL: one {timestamp, op, error, host} entry per
// line. hypo-auto-commit (#9) appends on pull/push failure; hypo-session-start
// (#10) surfaces open entries and clears them once sync is healthy again;
// doctor (#11) warns while entries remain. Keep the schema defined here only.

/** @returns {string} path to the sync-state JSONL file for a wiki root. */
function syncStatePath(hypoDir) {
  return join(hypoDir, '.cache', 'sync-state.json');
}

/**
 * Append a sync failure entry. Best-effort — never throws, since a failed
 * failure-log must not break the Stop hook that calls it.
 *
 * @param {string} hypoDir
 * @param {'pull'|'push'} op
 * @param {string} error  raw stderr/stdout; first non-empty line is kept
 */
export function appendSyncFailure(hypoDir, op, error) {
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const firstLine =
      String(error || '')
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean) || 'unknown error';
    const entry = {
      timestamp: new Date().toISOString(),
      op,
      error: firstLine.slice(0, 200),
      host: hostname(),
    };
    appendFileSync(syncStatePath(hypoDir), JSON.stringify(entry) + '\n');
  } catch {
    // best-effort
  }
}

/**
 * Read sync-state entries.
 * @param {string} hypoDir
 * @returns {{entries: object[], parseError: boolean}}
 */
export function readSyncState(hypoDir) {
  const path = syncStatePath(hypoDir);
  if (!existsSync(path)) return { entries: [], parseError: false };
  try {
    const entries = readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    return { entries, parseError: false };
  } catch {
    return { entries: [], parseError: true };
  }
}

/** Remove the sync-state file. Called once sync is healthy again. Best-effort. */
export function clearSyncState(hypoDir) {
  try {
    rmSync(syncStatePath(hypoDir), { force: true });
  } catch {
    // best-effort
  }
}

// ── clear-marker (fix #25 PR-A2, ADR 0022 amendment 2026-05-14) ────────────
// `/clear` cannot be blocked (no UserPromptSubmit fire). The only intervention
// point is the SessionEnd(reason='clear') → SessionStart(source='clear') pair:
// SessionEnd writes `.cache/clear-marker.json` with the dying session's id +
// transcript path; SessionStart on `source=clear` reads, injects a recovery
// nudge into additionalContext, and unlinks (one-shot). A 7-day stale guard
// prevents an orphaned marker (SessionEnd fired but new session never began)
// from polluting an unrelated later session.

const CLEAR_MARKER_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** @returns {string} path to the clear-marker file for a wiki root. */
function clearMarkerPath(hypoDir) {
  return join(hypoDir, '.cache', 'clear-marker.json');
}

/**
 * Persist the dying session's identity so the next SessionStart(source=clear)
 * can issue a recovery nudge. Single-file by design (see ADR 0022 amendment):
 * /clear is a single-client UX action, multi-marker disambiguation buys no
 * safety and breaks the 1-of-1 read-and-unlink contract.
 *
 * Best-effort: a failure here only loses the recovery nudge, never the user's
 * `/clear` itself.
 *
 * @param {string} hypoDir
 * @param {{prev_session_id: string, prev_transcript_path: string, prev_cwd?: string}} info
 */
export function writeClearMarker(hypoDir, info) {
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const payload = {
      prev_session_id: info.prev_session_id || null,
      prev_transcript_path: info.prev_transcript_path || null,
      prev_cwd: info.prev_cwd || null,
      ts: new Date().toISOString(),
    };
    writeFileSync(clearMarkerPath(hypoDir), JSON.stringify(payload) + '\n');
  } catch (err) {
    process.stderr.write(`[hypo] clear-marker write failed: ${err?.message || err}\n`);
  }
}

/**
 * Read the clear-marker if present and not stale (>7 days). Returns null when
 * absent, unreadable, or expired. Stale markers are unlinked here so a single
 * SessionStart cleans them up — no separate cron needed.
 *
 * @param {string} hypoDir
 * @returns {object|null}
 */
export function readClearMarker(hypoDir) {
  const path = clearMarkerPath(hypoDir);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const ts = Date.parse(data?.ts || '');
    if (!Number.isFinite(ts) || Date.now() - ts > CLEAR_MARKER_STALE_MS) {
      rmSync(path, { force: true });
      return null;
    }
    return data;
  } catch (err) {
    // Corrupt marker: emit a debug line AND unlink so the next SessionStart
    // does not log the same parse error forever (self-cleanup invariant).
    process.stderr.write(`[hypo] clear-marker read failed: ${err?.message || err}\n`);
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort
    }
    return null;
  }
}

/** Delete the clear-marker. One-shot contract — caller is SessionStart. */
export function clearClearMarker(hypoDir) {
  try {
    rmSync(clearMarkerPath(hypoDir), { force: true });
  } catch {
    // best-effort
  }
}

// ── session-closed marker (fix #27 PR-C, ADR 0022 amendment 2026-05-19) ────
// Per-session marker proving session-close completed. Stop hook
// (`hypo-auto-minimal-crystallize`) reads it; `scripts/crystallize.mjs` writes
// it after a verified close. Per-session (not per-day) precision resolves the
// codex BLOCKER from 2026-05-14: log.md date-level check false-passes when a
// later session reuses an earlier session's entry on the same day.
//
// Writer authority lives in crystallize, NOT this hook: the hook only checks
// presence. See ADR 0022 amendment 2026-05-19 Q2 for the split rationale.

const SESSION_CLOSED_MARKER_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Sanitize session_id for filesystem use — Claude session_ids are UUIDs but
 *  defend against accidental path traversal regardless. */
function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

/** @returns {string} path to the session-closed marker for a given session_id. */
export function sessionClosedMarkerPath(hypoDir, sessionId) {
  return join(hypoDir, '.cache', `session-closed-${sanitizeSessionId(sessionId)}.marker`);
}

/**
 * Persist a per-session close proof. Caller MUST verify
 * `sessionCloseFileStatus(hypoDir).ok` before invoking — this helper does NOT
 * re-check; that's the writer's contract (crystallize.mjs).
 *
 * Best-effort: stderr debug line on failure, no exception propagation.
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @param {{project?: string, transcript_path?: string}} info
 */
export function writeSessionClosedMarker(hypoDir, sessionId, info = {}) {
  if (!sessionId) return;
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const payload = {
      session_id: sessionId,
      project: info.project || null,
      transcript_path: info.transcript_path || null,
      closed_at: new Date().toISOString(),
      verification: 'session-close-file-status:ok',
    };
    writeFileSync(sessionClosedMarkerPath(hypoDir, sessionId), JSON.stringify(payload) + '\n');
  } catch (err) {
    process.stderr.write(`[hypo] session-closed marker write failed: ${err?.message || err}\n`);
  }
}

/**
 * Read the session-closed marker for `sessionId` if present and not stale
 * (>7 days). Returns null when absent, unreadable, or expired. Stale/corrupt
 * markers are unlinked here so a single Stop hook call cleans them up — no
 * separate sweeper needed (mirrors clear-marker self-cleanup invariant).
 *
 * @param {string} hypoDir
 * @param {string} sessionId
 * @returns {object|null}
 */
export function readSessionClosedMarker(hypoDir, sessionId) {
  if (!sessionId) return null;
  const path = sessionClosedMarkerPath(hypoDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    const ts = Date.parse(data?.closed_at || '');
    if (!Number.isFinite(ts) || Date.now() - ts > SESSION_CLOSED_MARKER_STALE_MS) {
      rmSync(path, { force: true });
      return null;
    }
    return data;
  } catch (err) {
    process.stderr.write(`[hypo] session-closed marker read failed: ${err?.message || err}\n`);
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort
    }
    return null;
  }
}

/** Delete a session-closed marker. Test/maintenance helper. */
export function clearSessionClosedMarker(hypoDir, sessionId) {
  if (!sessionId) return;
  try {
    rmSync(sessionClosedMarkerPath(hypoDir, sessionId), { force: true });
  } catch {
    // best-effort
  }
}

// ── transcript activity heuristic (fix #27 PR-C, ADR 0022 amendment 2026-05-19) ──
// Substantial-session gate for the Stop hook: a session that performed at least
// one mutation tool call (Edit / Write / MultiEdit / NotebookEdit) is "worth"
// blocking on for session-close. Pure Q&A / read-only sessions skip the block.
//
// Bash is intentionally excluded — running tests would otherwise trigger
// block. Future fix may broaden to read-heavy sessions (Grep ≥ N).

const MUTATING_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Mirror of `scripts/session-audit.mjs` extractToolNames: handles both top-level
 *  `tool_use` entries (legacy fixtures) and nested `message.content[].tool_use`
 *  blocks (real Claude Code transcripts). */
function extractTranscriptToolNames(entry) {
  const names = [];
  if (!entry || typeof entry !== 'object') return names;
  if (entry.type === 'tool_use') {
    const n = entry.name || entry.tool_name;
    if (n) names.push(n);
  } else if (entry.tool_name || entry.name) {
    if (entry.type === undefined || entry.type === 'tool_use') {
      const n = entry.tool_name || entry.name;
      if (n) names.push(n);
    }
  }
  const content = entry.message?.content ?? (Array.isArray(entry.content) ? entry.content : null);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        const n = block.name || block.tool_name;
        if (n) names.push(n);
      }
    }
  }
  return names;
}

/**
 * True if the JSONL transcript at `transcriptPath` contains ≥1 mutation
 * tool_use (Edit/Write/MultiEdit/NotebookEdit).
 *
 * Granularity:
 *   • Whole-file unreadable / missing path → returns false (fail-open).
 *   • Per-line malformed JSON → that line is skipped, scan continues. Real
 *     transcripts occasionally carry truncated lines; one bad line must not
 *     hide a clearly-mutating session that follows. (Codex Worker-2 CONCERN
 *     resolved 2026-05-19: line-level skip is the intended contract.)
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function hasMutatingTranscriptActivity(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return false;
  if (!existsSync(transcriptPath)) return false;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const name of extractTranscriptToolNames(entry)) {
      if (MUTATING_TOOL_NAMES.has(name)) return true;
    }
  }
  return false;
}

// ── session-close checklist ────────────────────────────────────────────────

/**
 * Read the session-close checklist from hypo-guide.md.
 * Falls back to null if the guide is unavailable or the section can't be parsed.
 */
export function readChecklist(today) {
  if (!existsSync(GUIDE_PATH)) return null;
  try {
    const lines = readFileSync(GUIDE_PATH, 'utf-8').split('\n');
    let collecting = false;
    const result = [];
    for (const line of lines) {
      if (!collecting && /^\[ \] 0\./.test(line.trim())) collecting = true;
      if (collecting) {
        if (/^─+$/.test(line.trim()) || line.trim() === '```') break;
        result.push(line);
      }
    }
    if (result.length === 0) return null;
    return result.join('\n').replace(/YYYY-MM-DD/g, today);
  } catch {
    return null;
  }
}

// ── session-state schema ───────────────────────────────────────────────────

/** Accepted heading aliases for the "next task" section in session-state.md. */
export const SESSION_STATE_NEXT_HEADINGS = ['다음 이어받기', '다음 작업', 'Next Up', 'Next'];

// ── misc helpers ───────────────────────────────────────────────────────────

/** Returns true if the prompt is a /compact command invocation. */
export function isCompactCommand(prompt) {
  return prompt === '/compact' || /^\/compact(\s|$)/.test(prompt);
}

/** Returns true if the prompt is a /clear command invocation. */
export function isClearCommand(prompt) {
  return prompt === '/clear' || /^\/clear(\s|$)/.test(prompt);
}

/** Returns true if the prompt is either /compact or /clear (ADR 0022 Layer 2, fix #25). */
export function isCompactOrClearCommand(prompt) {
  return isCompactCommand(prompt) || isClearCommand(prompt);
}

/**
 * Extract recent user-role message text from a JSONL transcript (last `tailN`
 * lines). Promoted from hypo-personal-check.mjs (fix #27 PR-C) so both the
 * PreCompact gate and the Stop-chain Layer 3 hook share one close-intent
 * signal source. Claude Code transcript format: each line is
 * `{ type:"user", message:{ role:"user", content: ... } }`; the older
 * top-level `{ role, content }` shape is also accepted.
 *
 * @param {string} transcriptPath
 * @param {number} tailN  how many trailing lines to scan (default 30)
 * @returns {string} newline-joined user text, or '' on any failure (fail-open)
 */
export function extractUserMessages(transcriptPath, tailN = 30) {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    const tail = lines.slice(-tailN);
    return tail
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          const msg = obj.message ?? obj;
          const role = msg.role ?? obj.role ?? obj.type;
          if (role !== 'user') return '';
          const content = msg.content ?? obj.content;
          return typeof content === 'string' ? content : JSON.stringify(content);
        } catch {
          return '';
        }
      })
      .join('\n');
  } catch {
    return '';
  }
}

/**
 * Returns true if the text contains a natural-language session-close signal.
 * Scans Korean and English close patterns. Designed for transcript user-message
 * text — favours low false-positive rate over recall.
 *
 * Examples that match: "세션 마무리하자", "오늘 여기까지", "wrap up", "signing off".
 * Examples that do NOT match: "이 함수 마무리하자", "wrap up this PR".
 */
export function isClosePattern(text) {
  if (!text || typeof text !== 'string') return false;
  const krPatterns = [
    /세션\s*(끝|종료|마무리)/,
    /오늘\s*은?\s*(여기|작업|세션).*(끝|마치|마무리|종료)/,
    // 여기까지: requires no continuation action word (e.g. 여기까지 구현해줘 is not a close signal)
    /여기(서)?까지(?!\s*(?:구현|작성|완성|수정|변경|추가|삭제|테스트|확인|검토|해줘|해야|하고|하면))/,
    /이만\s*(마치|끝|종료|마무리)/,
    // 작업 종료/마무리: requires verb ending, not noun modifier (e.g. 작업 종료 조건을 is not a close signal)
    /작업\s*(?:마무리|종료)\s*(?:하자|할게|하겠|했어|임)/,
    /오늘은?\s*여기/,
    /그만\s*(하자|할게|하겠|합시다)/,
    /슬슬\s*(마무리|종료)/,
    /오늘은?\s*이만/,
  ];
  const enPatterns = [
    // wrap up: requires session-level context or sentence-end, not code-level objects
    /wrap(?:ping)?\s+up(?!\s+(?:this|the)\s+(?:pr|issue|bug|task|function|component|module|feature|code|test)\b)/i,
    /done\s+for\s+(?:today|now|the\s+day)/i,
    /that'?s?\s+(?:all|it)\s+for\s+(?:today|now|the\s+day)/i,
    /signing\s+off/i,
    /end(?:ing)?\s+(?:the|this)\s+(?:session|work|day)/i,
    /close\s+(?:the|this)\s+session/i,
  ];
  return [...krPatterns, ...enPatterns].some((re) => re.test(text));
}

/**
 * Build hook output for Claude Code (additionalContext channel).
 * Codex hooks write systemMessage directly in their own files.
 */
export function buildOutput(context, extra = {}) {
  return { ...extra, additionalContext: context };
}

// ── growth metrics (F2 + E4) ───────────────────────────────────────────────
// Single formatter used by Stop (hot-rebuild) and SessionStart hooks so the
// "[hypo] +N pages, ~M updated, K wikilinks" line stays consistent at both
// ends of a session. See ADR-0018 / Lane B.

/**
 * Format a growth-metrics one-liner. Returns '' when all counts are 0 so
 * callers can no-op silently.
 *
 * @param {'stop'|'start'} mode
 * @param {{addedPages?:number, updatedPages?:number, newWikilinks?:number}} stats
 * @returns {string}
 */
export function formatGrowthMetrics(mode, stats) {
  const a = Number(stats?.addedPages) || 0;
  const u = Number(stats?.updatedPages) || 0;
  const w = Number(stats?.newWikilinks) || 0;
  if (a === 0 && u === 0 && w === 0) return '';
  const body = `+${a} pages, ~${u} updated, ${w} wikilinks`;
  if (mode === 'stop') return `[hypo] ${body}`;
  if (mode === 'start') return `[hypo] 직전 세션: ${body}. 이어서 볼까요?`;
  return '';
}

/**
 * Compute session growth by inspecting the wiki repo's working tree against
 * HEAD. Counts every modified/added/untracked markdown file under `pages/`
 * or `projects/` and totals net-new `[[wikilink]]` occurrences in the diff.
 *
 * @param {string} hypoDir
 * @returns {{addedPages:number, updatedPages:number, newWikilinks:number}}
 */
export function computeSessionGrowth(hypoDir) {
  const empty = { addedPages: 0, updatedPages: 0, newWikilinks: 0 };
  if (!existsSync(join(hypoDir, '.git'))) return empty;
  try {
    // Single `git status --porcelain` enumerates tracked + untracked. On a
    // clean tree (no .md changes at all) we return early and skip the much
    // more expensive `git diff HEAD --unified=0` — Stop hook P95 win.
    // `-uall` expands untracked directories so a brand-new `pages/new.md`
    // isn't hidden behind a single `?? pages/` line.
    const porcelain = spawnSync('git', ['-C', hypoDir, 'status', '--porcelain', '-uall'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (porcelain.status !== 0) return empty;
    let addedPages = 0,
      updatedPages = 0;
    let hasTrackedMdChange = false;
    const untrackedMd = [];
    // Growth metrics describe wiki page activity, so restrict to the two
    // page-bearing trees. Top-level files like README.md or root hot.md are
    // intentionally excluded — they're scaffolding, not page growth.
    const inPagesScope = (file) =>
      file.endsWith('.md') && (file.startsWith('pages/') || file.startsWith('projects/'));
    for (const line of (porcelain.stdout || '').split('\n')) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop().trim();
      if (!inPagesScope(file)) continue;
      if (xy === '??') {
        untrackedMd.push(file);
        addedPages++;
        continue;
      }
      hasTrackedMdChange = true;
      if (xy.includes('A')) addedPages++;
      else if (xy.includes('M') || xy.includes('R')) updatedPages++;
    }
    if (!hasTrackedMdChange && untrackedMd.length === 0) return empty;

    let plus = 0,
      minus = 0;
    if (hasTrackedMdChange) {
      // pathspec keeps non-Markdown / out-of-scope diffs from polluting the
      // wikilink count. Without it, a `[[…]]` string in a script.js diff was
      // being credited as a new wikilink.
      const diff = spawnSync(
        'git',
        ['-C', hypoDir, 'diff', 'HEAD', '--unified=0', '--', 'pages/', 'projects/'],
        { encoding: 'utf-8', timeout: 10000 },
      );
      if (diff.status === 0) {
        for (const line of (diff.stdout || '').split('\n')) {
          if (line.startsWith('+++') || line.startsWith('---')) continue;
          const matches = line.match(/\[\[[^\]\n]+\]\]/g);
          if (!matches) continue;
          if (line.startsWith('+')) plus += matches.length;
          else if (line.startsWith('-')) minus += matches.length;
        }
      }
    }
    for (const f of untrackedMd) {
      try {
        const body = readFileSync(join(hypoDir, f), 'utf-8');
        const matches = body.match(/\[\[[^\]\n]+\]\]/g);
        if (matches) plus += matches.length;
      } catch {}
    }
    return { addedPages, updatedPages, newWikilinks: Math.max(0, plus - minus) };
  } catch {
    return empty;
  }
}

// ── .hypoignore support ────────────────────────────────────────────────────
// Inlined here so deployed hooks (~/.claude/hooks/) don't need scripts/lib/.

function _globToRegex(glob) {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\x00/g, '.*') +
      '$',
  );
}

export function loadHypoIgnore(hypoDir) {
  const ignorePath = join(hypoDir, '.hypoignore');
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function isIgnored(filePath, hypoDir, patterns) {
  const rel = relative(hypoDir, filePath).replace(/\\/g, '/');
  const base = basename(filePath);
  for (const pattern of patterns) {
    const isDir = pattern.endsWith('/');
    if (isDir) {
      const dir = pattern.slice(0, -1);
      const isAnchored = dir.includes('/');
      if (isAnchored) {
        const re = _globToRegex(dir);
        const parts = rel.split('/');
        for (let i = dir.split('/').length; i <= parts.length; i++) {
          if (re.test(parts.slice(0, i).join('/'))) return true;
        }
      } else {
        const re = _globToRegex(dir);
        for (const part of rel.split('/')) {
          if (re.test(part)) return true;
        }
      }
      continue;
    }
    const hasSlash = pattern.includes('/');
    const target = hasSlash ? rel : base;
    if (_globToRegex(pattern).test(target)) return true;
  }
  return false;
}
