#!/usr/bin/env node
/**
 * hypo-shared.mjs — shared utilities for Hypomnema hooks
 *
 * Imported by personal-wiki-check.mjs, wiki-compact-guard.mjs, and others.
 * Hooks are deployed to ~/.claude/hooks/ — no external imports allowed.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  realpathSync,
} from 'fs';
import { join, relative, basename } from 'path';
import { homedir, hostname, tmpdir } from 'os';
import { spawnSync } from 'child_process';

const HOME = homedir();

// ── session marker path ─────────────────────────────────────────────────────
// hypo-session-start / hypo-cwd-change WRITE this marker; hypo-first-prompt
// READS + unlinks it. The session_id comes from the Claude Code runtime (a
// UUID), but we sanitize defensively so a malformed id with path separators or
// `..` can never escape tmpdir or collide on an empty value. Non-alphanumeric
// chars collapse to `_`.
export function sessionMarkerPath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return join(tmpdir(), `hypo-session-marker-${safe}.json`);
}

// ── project name sanitizer for prompt-facing interpolation ─────────────────
// marker.proj is read from a wiki directory name (findProjectFiles) and
// interpolated into LLM-facing additionalContext strings by multiple hooks.
// A manually-crafted directory name could otherwise close a wrapping tag,
// smuggle a newline, or inject conflicting instructions. Centralized so the
// three injection sites stay in lock-step (codex v2 review 2026-05-26 —
// addresses shared-helper concern across hypo-first-prompt / hypo-session-start
// / hypo-cwd-change).
//
// Strips: angle brackets, control chars (C0 + C1), Unicode line separators
// (U+2028 / U+2029), then collapses whitespace and caps length.
export function sanitizeProjForPrompt(raw, fallback = 'unknown') {
  const cleaned = String(raw || fallback)
    .replace(/[<>\[\]]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

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

// Returns the wiki's git state split into its two independent axes (ADR 0056):
//   uncommitted — working-tree changes (real unsaved work; a human-fixable blocker)
//   ahead       — committed-but-unpushed commits (a soft, auto-synced state: the
//                 auto-commit Stop hook pushes, and push failures are non-fatal —
//                 see hypo-auto-commit.mjs / appendSyncFailure)
// `clean` stays `!uncommitted && !ahead` for back-compat with callers that only
// read it. Callers that gate session-close / compact distinguish the two: they
// block on `uncommitted` and demote `ahead` to a notice (precompactGateStatus,
// hypo-compact-guard) so a committed-but-unpushed close is still "compact-ready".
export function hypoIsClean(dir = HYPO_DIR) {
  try {
    const porcelain = spawnSync('git', ['-C', dir, 'status', '--porcelain'], {
      encoding: 'utf-8',
    });
    if (porcelain.status !== 0)
      return {
        clean: false,
        uncommitted: true,
        ahead: false,
        reason: `git check failed in ${dir}`,
      };
    const uncommitted = porcelain.stdout.trim() !== '';
    const aheadRes = spawnSync('git', ['-C', dir, 'status', '--branch', '--porcelain'], {
      encoding: 'utf-8',
    });
    const ahead = /\[ahead \d+\]/.test(aheadRes.stdout || '');
    const reasons = [];
    if (uncommitted) reasons.push(`uncommitted changes in ${dir}`);
    if (ahead) reasons.push(`unpushed commits in ${dir}`);
    return {
      clean: !uncommitted && !ahead,
      uncommitted,
      ahead,
      reason: reasons.length ? reasons.join('; ') : undefined,
    };
  } catch {
    return { clean: false, uncommitted: true, ahead: false, reason: `git check failed in ${dir}` };
  }
}

export function hotMdIsClean(dir = HYPO_DIR) {
  const hotPath = dir === HYPO_DIR ? HOT_PATH : join(dir, 'hot.md');
  if (!existsSync(hotPath)) return { clean: true };
  const content = readFileSync(hotPath, 'utf-8');
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

// ── strict session-close verification ────────────────────────────
// spec §5.2.7 / §8.3 (updated 2026-05-15): session-close = steps 1~6 of the
// 11-step crystallize checklist (synthesis is steps 7~11). The hard gate
// (sessionCloseFileStatus) confirms the 5 mandatory files — session-state.md,
// project hot.md, root hot.md, session-log/YYYY-MM-DD.md, and log.md.
// pages/open-questions.md (step 5) is conditional ("변경 시") — it is a
// cross-project queue, so a session that raises no questions should not be
// forced to touch it. Gating it would produce false-blocks; spec §5.2.7
// records this as the intended policy.
//
// Known limitation: freshness is date-based per spec §8.3 ("timestamp가 같음"),
// so a second session on the same day that skips updating a file still passes
// if an earlier close that day already stamped it. freshDates() accepting both
// local and UTC dates widens that window by up to one UTC offset. A per-session
// boundary is out of scope for the strict session-close check.

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
 * Canonical session-log shard path (repo-relative POSIX) for a single day.
 * ADR 0050 / option D: the date IS the filename (`YYYY-MM-DD.md`), so no
 * "current part" resolver is needed and the per-session write touches a small
 * file instead of a multi-thousand-line monthly log. This is the WRITE target.
 */
export function sessionLogShardPath(project, date) {
  return `projects/${project}/session-log/${date}.md`;
}

/**
 * Read candidates for a date's session-log entry, in priority order:
 *   1. the daily shard `YYYY-MM-DD.md` (canonical, small)
 *   2. the legacy monthly `YYYY-MM.md` (pre-shard history is never split)
 * Callers iterate and short-circuit on the first file carrying the dated
 * heading, so once a daily shard exists the large monthly file is never read —
 * which is where the per-close token saving comes from. The monthly fallback
 * keeps pre-cutover months (and a hybrid cutover month) resolving correctly
 * without a retroactive split.
 */
export function sessionLogReadCandidates(project, date) {
  return [
    sessionLogShardPath(project, date),
    `projects/${project}/session-log/${date.slice(0, 7)}.md`,
  ];
}

/**
 * The session-log file the close gate should hold accountable for `date` — i.e.
 * the read candidate that ACTUALLY carries a today-dated heading (daily shard
 * preferred), or the daily write target when none does yet. The freshness gate
 * accepts a today-heading found in the legacy monthly file via fallback; if the
 * lint scope only ever named the daily shard, a close could pass on a *corrupt*
 * monthly evidence file while that file's lint error was demoted to a
 * non-blocking notice (out of scope). Scoping to the resolved evidence file
 * closes that gap: whatever file the gate trusts as proof, lint judges too.
 */
export function sessionLogScopePath(hypoDir, project, date) {
  for (const rel of sessionLogReadCandidates(project, date)) {
    const full = join(hypoDir, rel);
    if (!existsSync(full)) continue;
    try {
      if (hasSessionLogHeading(readFileSync(full, 'utf-8'), date)) return rel;
    } catch {
      /* unreadable candidate — keep looking */
    }
  }
  return sessionLogShardPath(project, date);
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
 * (Was a pre-existing bug in sessionCloseFileStatus that the helper extraction
 * inherited.)
 */
export function hasLogEntry(content, date, project) {
  return new RegExp(
    '^## \\[' + escapeRegExp(date) + '\\] session \\| ' + escapeRegExp(project) + '(?=\\s|$)',
    'm',
  ).test(content || '');
}

/**
 * True when log.md carries ANY `## [<freshDate>] session | <slug>` heading —
 * project-agnostic. The minimum proof for a log-only close: a
 * non-project (tooling/wiki-only) session has no project mandatory files, but it
 * MUST still leave a today log.md trace so the close is not a content-free bypass.
 * Uses the same canonical heading parser as hasLogEntry (not a loose substring —
 * codex design review: keep the fresh-date/canonical-heading style) so a stray
 * mention of the date elsewhere cannot satisfy it.
 * @param {string} hypoDir
 * @returns {boolean}
 */
export function hasAnyTodayLogEntry(hypoDir) {
  const logPath = join(hypoDir, 'log.md');
  if (!existsSync(logPath)) return false;
  let content = '';
  try {
    content = readFileSync(logPath, 'utf-8');
  } catch {
    return false;
  }
  return freshDates().some((d) =>
    new RegExp('^## \\[' + escapeRegExp(d) + '\\] session \\| \\S', 'm').test(content),
  );
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

// Parse a single frontmatter scalar (mirrors hypo-session-start.mjs /
// hypo-cwd-change.mjs; local copy per the hook self-contained convention).
function parseFrontmatterField(content, key) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

// Among `slugs`, return the one whose projects/<slug>/index.md `working_dir`
// is the LONGEST prefix of cwd (so /repo/sub wins over /repo). Returns null
// when cwd is falsy or matches none. resume gives this authority OVER recency
// (ADR 0044); close callers never pass cwd, so it stays inert for them.
function pickByCwd(hypoDir, slugs, cwd) {
  if (!cwd) return null;
  let best = null;
  let bestLen = -1;
  for (const slug of slugs) {
    const indexPath = join(hypoDir, 'projects', slug, 'index.md');
    if (!existsSync(indexPath)) continue;
    const wd = parseFrontmatterField(readFileSync(indexPath, 'utf-8'), 'working_dir');
    if (!wd) continue;
    let resolved = wd.startsWith('~/') ? join(homedir(), wd.slice(2)) : wd;
    resolved = resolved.replace(/\/+$/, ''); // trailing-slash normalize
    if ((cwd === resolved || cwd.startsWith(resolved + '/')) && resolved.length > bestLen) {
      bestLen = resolved.length;
      best = slug;
    }
  }
  return best;
}

/**
 * Resolve the active project slug from root hot.md. With a cwd, a project whose
 * working_dir contains it wins (cwd-first, ADR 0044); otherwise the
 * most-recently-active row is returned.
 * The cwd helpers (parseFrontmatterField / pickByCwd) and the cwd-first body
 * are kept in sync with scripts/resume.mjs by hand; the surrounding wrapper
 * intentionally differs (resume.mjs adds an mtime fallback, this does not).
 * `cwd` is an optional cwd-first selector (ADR 0044): a cwd↔working_dir match
 * wins over recency. resume passes process.cwd(); session-close callers
 * (sessionCloseFileStatus / closeFileTargets) intentionally pass null — close
 * has a different authority (payload.project / freshness, the global invariant
 * of ADR 0043), so it never picks by cwd. When cwd is omitted, behavior is
 * identical to the legacy recency version.
 * @param {string} hypoDir
 * @param {string|null} [cwd]
 * @returns {string|null}
 */
export function resolveActiveProject(hypoDir, cwd = null) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return null;
  let content;
  try {
    // Strip HTML comments before parsing so the canonical-format example row
    // in templates/hot.md (`<!-- Row format: ... -->`) is not picked up as data.
    content = readFileSync(hotPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
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
    // cwd-first (ADR 0044): a cwd↔working_dir match wins over recency, across
    // ALL rows. Kept in sync with scripts/resume.mjs. close callers pass null →
    // recency path below (resume=cwd-positive / close=no-pick).
    if (cwd) {
      const picked = pickByCwd(
        hypoDir,
        wikiRows.map((r) => r.slug),
        cwd,
      );
      if (picked) return picked;
    }
    // No cwd match → most recent by date (stable-sort keeps the first table row
    // on a tie, the legacy behavior).
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
    return wikiRows[0].slug;
  }
  // Legacy markdown-link rows: | [name](projects/name/...) | ...
  const mdSlugs = [...content.matchAll(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/g)].map((m) => m[2]);
  if (mdSlugs.length > 0) {
    if (cwd) {
      const picked = pickByCwd(hypoDir, mdSlugs, cwd);
      if (picked) return picked;
    }
    return mdSlugs[0]; // legacy: first table row
  }
  return null;
}

/**
 * Strict session-close verification (spec §5.2.7 / §8.3).
 * Confirms the memory files a session close must touch were updated today:
 *   - projects/<project>/session-state.md       — frontmatter `updated:` is today
 *   - projects/<project>/hot.md                 — frontmatter `updated:` is today
 *   - hot.md (root)                             — frontmatter `updated:` is today
 *   - projects/<project>/session-log/YYYY-MM-DD.md — has a `## [today]` heading
 *     (daily shard, ADR 0050; legacy YYYY-MM.md is still accepted as fallback)
 *   - log.md                                    — has a `## [today] session | <project>` entry
 * The log.md check is project-scoped so a session close left incomplete for
 * project A can't be masked by a fresh close of project B (and vice versa).
 * open-questions.md (file #5) is conditional and not gated.
 *
 * `projectOverride` (same-date-tie fix): when the caller already holds the
 * authoritative project being closed (e.g. crystallize apply derives it from
 * `payload.project`), it passes that slug so verification checks the SAME
 * project it just wrote — instead of re-deriving via resolveActiveProject(),
 * which on a same-date root-hot.md tie can resolve a DIFFERENT project and
 * false-fail a completed close. When omitted, behavior is byte-identical to the
 * legacy single-arg version (resolve from root hot.md).
 *
 * @param {string} hypoDir
 * @param {{projectOverride?: string|null}} [opts]
 * @returns {{ok: boolean, project: string|null, dates: string[], stale: string[], missing: string[]}}
 */
export function sessionCloseFileStatus(hypoDir, { projectOverride = null } = {}) {
  const dates = freshDates();
  const project = projectOverride || resolveActiveProject(hypoDir);
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

  // session-log: daily shard (ADR 0050), with legacy monthly fallback — must
  // carry a today-dated heading in whichever file holds it. Daily-first read
  // order short-circuits on the small shard. When no match is found, the gap is
  // reported under the canonical daily shard for the local date (dates[0]).
  let sessionLogOk = false;
  for (const date of dates) {
    for (const rel of sessionLogReadCandidates(project, date)) {
      const full = join(hypoDir, rel);
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
    if (sessionLogOk) break;
  }
  if (!sessionLogOk) {
    const logRel = sessionLogShardPath(project, dates[0]);
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

// ── global session-close gate (ADR 0043) ────
// The no-payload close paths must NOT pick one project (recency / cwd) and check
// it — that re-derivation is the prior session-close false-block, and a cwd
// tie-break here would let a fresh cwd mask a DIFFERENT project's dangling
// close. Instead the gate enforces a global invariant: no project may end a
// session with a partial close. resume stays cwd-positive (ADR 0044); close
// never picks. The two copies of resolveActiveProject share the cwd-first body
// but the resume.mjs copy adds an mtime fallback this one omits — see resume.mjs.

// Root hot.md Active-Projects rows as {slug, date}. The per-row date column is
// project-scoped (unlike the shared frontmatter `updated:`), so a today-dated
// row is a legitimate close-activity signal. Mirrors resolveActiveProject's regex.
function rootHotRows(hypoDir) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return [];
  let content;
  try {
    content = readFileSync(hotPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
  } catch {
    return [];
  }
  return [
    ...content.matchAll(
      /\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g,
    ),
  ].map((m) => ({ slug: m[3], date: m[2] || '' }));
}

// Candidate slugs the global gate must consider: real project dirs (with a
// session-state.md, skip _template) ∪ slugs in a today-dated `## [today] session
// | P` log.md entry ∪ slugs in a today-dated root hot.md row. The log/row unions
// catch a dangling close whose own project files are missing —
// sessionCloseFileStatus(projectOverride) reports those as `missing` correctly.
function closeCandidateSlugs(hypoDir, dates) {
  const slugs = new Set();
  const projectsDir = join(hypoDir, 'projects');
  if (existsSync(projectsDir)) {
    let entries = [];
    try {
      entries = readdirSync(projectsDir);
    } catch {
      entries = [];
    }
    for (const p of entries) {
      if (p === '_template') continue;
      if (existsSync(join(projectsDir, p, 'session-state.md'))) slugs.add(p);
    }
  }
  for (const r of rootHotRows(hypoDir)) {
    if (r.date && dates.includes(r.date)) slugs.add(r.slug);
  }
  const logPath = join(hypoDir, 'log.md');
  if (existsSync(logPath)) {
    let content = '';
    try {
      content = readFileSync(logPath, 'utf-8');
    } catch {
      content = '';
    }
    for (const d of dates) {
      const re = new RegExp('^## \\[' + escapeRegExp(d) + '\\] session \\| (\\S+)', 'gm');
      for (const m of content.matchAll(re)) slugs.add(m[1]);
    }
  }
  return slugs;
}

// True when project P shows ANY today close-activity signal: session-state or
// project hot.md frontmatter `updated:` today, a today-dated session-log heading,
// a today log.md `session | P` entry, or a today-dated root hot.md row for P.
// (Root hot.md *frontmatter* is shared and is NOT a signal; the per-project ROW
// date is.)
function hasTodayCloseActivity(hypoDir, project, dates) {
  const fresh = (rel) => {
    const full = join(hypoDir, rel);
    if (!existsSync(full)) return false;
    try {
      return dates.includes(frontmatterUpdated(readFileSync(full, 'utf-8')));
    } catch {
      return false;
    }
  };
  if (fresh(join('projects', project, 'session-state.md'))) return true;
  if (fresh(join('projects', project, 'hot.md'))) return true;
  for (const d of dates) {
    for (const rel of sessionLogReadCandidates(project, d)) {
      const sl = join(hypoDir, rel);
      if (!existsSync(sl)) continue;
      try {
        if (hasSessionLogHeading(readFileSync(sl, 'utf-8'), d)) return true;
      } catch {
        /* skip */
      }
    }
  }
  const logPath = join(hypoDir, 'log.md');
  if (existsSync(logPath)) {
    try {
      const c = readFileSync(logPath, 'utf-8');
      if (dates.some((d) => hasLogEntry(c, d, project))) return true;
    } catch {
      /* skip */
    }
  }
  for (const r of rootHotRows(hypoDir)) {
    if (r.slug === project && r.date && dates.includes(r.date)) return true;
  }
  return false;
}

/**
 * Global session-close status for the no-payload close paths (ADR 0043).
 * Checks EVERY project with today close-activity; ok only when all are complete.
 * When no project has today activity, falls back to the legacy single recency
 * project (preserves "force the initial close" behavior, byte-identical gate).
 *
 * stale/missing entries are self-describing paths — project-specific files carry
 * `projects/<slug>/…`, root files (`hot.md`/`log.md`) are shared — so the flat
 * aliases need no project prefix and a single-project session is byte-identical
 * to sessionCloseFileStatus (back-compat for the flat-field readers).
 *
 * @param {string} hypoDir
 * @returns {{ok: boolean, projects: Array<{project:string, ok:boolean, stale:string[], missing:string[]}>,
 *            dates: string[], fallback: boolean, primary: string|null,
 *            project: string|null, stale: string[], missing: string[]}}
 */
export function sessionCloseGlobalStatus(hypoDir) {
  const dates = freshDates();
  const recency = resolveActiveProject(hypoDir); // no cwd — close never picks by cwd
  const todayActive = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );

  if (todayActive.length === 0) {
    const legacy = sessionCloseFileStatus(hypoDir);
    return {
      ok: legacy.ok,
      projects: legacy.project
        ? [{ project: legacy.project, ok: legacy.ok, stale: legacy.stale, missing: legacy.missing }]
        : [],
      dates,
      fallback: true,
      primary: legacy.project,
      project: legacy.project,
      stale: legacy.stale,
      missing: legacy.missing,
    };
  }

  // primary = the recency project when it is itself today-active, else the first
  // today-active slug (stable order from the candidate set). Used only as the
  // single-slug alias (marker `project` field, message header) — never to gate.
  const primary = recency && todayActive.includes(recency) ? recency : todayActive[0];
  const ordered = [primary, ...todayActive.filter((p) => p !== primary)];

  const projects = ordered.map((p) => {
    const s = sessionCloseFileStatus(hypoDir, { projectOverride: p });
    return { project: p, ok: s.ok, stale: s.stale, missing: s.missing };
  });
  const ok = projects.every((x) => x.ok);
  const stale = [...new Set(projects.flatMap((x) => x.stale))];
  const missing = [...new Set(projects.flatMap((x) => x.missing))];
  return { ok, projects, dates, fallback: false, primary, project: primary, stale, missing };
}

// ── derivable-artifact auto-derive: root log.md session entry ──────────────────
// The root log.md `## [date] session | <slug>` entry is a DERIVABLE artifact —
// it restates a project's session-log heading, which the close already authored.
// root hot.md is already auto-derived here (rebuild() above); log.md was the only
// derivable still left as a manual checklist step, so a hand-edited close that
// skipped it left the global gate (sessionCloseGlobalStatus) hard-blocking /compact
// for EVERY today-active project — cross-session, looking like a fresh bug each
// time. This derives the missing entry from the session-log heading so the gate
// never blocks on a purely-derivable gap. The session-closed MARKER is NOT derived
// here: it is a proof artifact the close gate actually ran (ADR 0022 invariant).
//
// Safety guard (codex design review): derive ONLY for a project whose close is
// otherwise complete — i.e. its sole gate problem is log.md. If session-state /
// project hot / session-log are also stale/missing, the authored close is genuinely
// incomplete and MUST keep blocking; deriving log.md then would mask it.

// Build the canonical root log.md heading from a raw session-log heading tail.
// The gate's session-log freshness check accepts ANY `## [date] ...` heading, but
// the log.md check requires `## [date] session | <slug>` — so normalise to that
// shape rather than copying a heading that might not carry `session | <slug>`.
function deriveLogTitle(tail) {
  let t = (tail || '').trim();
  t = t.replace(/^session\b\s*/i, ''); // drop a leading "session" token
  if (t.startsWith('|')) {
    // Drop a leading "| <old label/slug>" segment up to the first em-dash, so a
    // renamed-project heading (`| oldslug — title`) does not leak its old slug
    // into the derived title. A pipe segment with no separator is a bare label
    // (e.g. `| slug`) → no title.
    const dash = t.indexOf('—');
    t = dash === -1 ? '' : t.slice(dash);
  }
  return t.replace(/^\s*[—:-]\s*/, '').trim(); // drop a leading separator
}

/**
 * Append any missing root log.md `## [date] session | <slug>` entries derived from
 * each today-active project's session-log heading(s). Idempotent: dedups on the
 * exact generated heading line, so re-running (or a same-day apply that already
 * wrote the entry) is a no-op, and multiple same-day sessions each get their own
 * entry. Best-effort and read-mostly: returns the number of entries appended.
 *
 * @param {string} hypoDir
 * @returns {number} count of entries appended to log.md
 */
export function deriveRootLogEntries(hypoDir) {
  const logPath = join(hypoDir, 'log.md');
  if (!existsSync(logPath)) return 0;
  const dates = freshDates();
  const todayActive = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );
  if (todayActive.length === 0) return 0;

  let logContent;
  try {
    logContent = readFileSync(logPath, 'utf-8');
  } catch {
    return 0;
  }

  // Exact-LINE dedup: a titleless heading (`## [d] session | a`) is a substring/
  // prefix of a titled one (`## [d] session | a — first`), so substring checks
  // would wrongly drop a distinct same-day session. Track whole heading lines.
  const seenHeadings = new Set((logContent || '').split(/\r?\n/));
  const additions = [];
  for (const slug of todayActive) {
    // Guard: only the log.md entry may be the gap; an otherwise-incomplete close
    // must keep blocking (do not mask missing authored files).
    const st = sessionCloseFileStatus(hypoDir, { projectOverride: slug });
    const problems = [...st.stale, ...st.missing];
    if (!(problems.length === 1 && problems[0] === 'log.md')) continue;

    for (const date of dates) {
      // Pick the candidate that actually CARRIES this date's heading (daily shard
      // preferred), mirroring the freshness gate's resolution. Selecting merely
      // the first *existing* file would diverge from freshness: a header-only
      // daily shard (e.g. a seeded-but-not-yet-appended file) would be chosen and
      // the real heading in the legacy monthly fallback missed — freshness would
      // pass while derive failed to recover the log.md entry.
      let slog = null;
      for (const rel of sessionLogReadCandidates(slug, date)) {
        const slogPath = join(hypoDir, rel);
        if (!existsSync(slogPath)) continue;
        let content;
        try {
          content = readFileSync(slogPath, 'utf-8');
        } catch {
          continue;
        }
        if (!hasSessionLogHeading(content, date)) continue;
        slog = content;
        break;
      }
      if (slog === null) continue;
      const headingRe = new RegExp('^#{1,6} \\[' + escapeRegExp(date) + '\\]\\s*(.*)$', 'gm');
      let m;
      while ((m = headingRe.exec(slog)) !== null) {
        const title = deriveLogTitle(m[1]);
        const heading = `## [${date}] session | ${slug}` + (title ? ` — ${title}` : '');
        if (seenHeadings.has(heading)) continue; // exact-line dedup (log.md + queued)
        seenHeadings.add(heading);
        additions.push(`${heading}\n→ [[projects/${slug}/hot]]`);
      }
    }
  }

  if (additions.length === 0) return 0;
  const sep = logContent.endsWith('\n') ? '\n' : '\n\n';
  try {
    writeFileSync(logPath, logContent + sep + additions.join('\n\n') + '\n');
  } catch {
    return 0;
  }
  return additions.length;
}

// ── sync-state ────────────────────────────────────────────
// `.cache/sync-state.json` is JSONL: one {timestamp, op, error, host} entry per
// line. hypo-auto-commit appends on pull/push failure; hypo-session-start
// surfaces open entries and clears them once sync is healthy again;
// doctor warns while entries remain. Keep the schema defined here only.

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
 * Stage + commit every non-.hypoignore change in the wiki. Does NOT pull/push —
 * remote sync stays in the auto-commit Stop hook (commit is local + cheap; sync is
 * network + soft-fail). Shared by hypo-auto-commit.mjs and crystallize.mjs's
 * --apply-session-close path so the .hypoignore staging filter cannot diverge
 * between the two commit loci (ADR 0056).
 *
 * "Nothing to commit" (clean tree, or only .hypoignore'd changes) is SUCCESS, not
 * failure — the caller's tree is already in the committed state it wanted.
 *
 * @param {string} hypoDir
 * @returns {{committed: boolean, reason?: string}} committed:true when a commit was
 *   created OR nothing needed committing; committed:false (with reason) on a real
 *   failure: not a git repo, or git status/add/commit erroring.
 */
export function commitWikiChanges(hypoDir) {
  const git = (...args) =>
    spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', timeout: 30000 });
  if (git('rev-parse', '--is-inside-work-tree').status !== 0)
    return { committed: false, reason: `not a git repository: ${hypoDir}` };
  const porcelain = git('status', '--porcelain', '-uall');
  if (porcelain.status !== 0)
    return { committed: false, reason: `git status failed in ${hypoDir}` };
  // `.hypoignore` is the project privacy boundary. `git add -A` ignores it, so
  // enumerate changed paths, drop ignored ones, then stage explicitly.
  const ignorePatterns = loadHypoIgnore(hypoDir);
  const paths = [];
  for (const line of (porcelain.stdout || '').split('\n')) {
    if (!line) continue;
    const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop().trim();
    if (!file) continue;
    if (ignorePatterns.length > 0 && isIgnored(join(hypoDir, file), hypoDir, ignorePatterns))
      continue;
    paths.push(file);
  }
  if (paths.length > 0) {
    const add = git('add', '--', ...paths);
    if (add.status !== 0)
      return {
        committed: false,
        reason: `git add failed: ${(add.stderr || '').trim() || 'unknown'}`,
      };
  }
  const staged = git('diff', '--cached', '--name-only').stdout?.trim() || '';
  if (!staged) return { committed: true }; // nothing to commit = success (idempotent)
  const today = new Date().toISOString().slice(0, 10);
  const commit = git('commit', '-m', `auto: ${today} wiki update`);
  if (commit.status !== 0)
    return {
      committed: false,
      reason: `git commit failed: ${(commit.stderr || '').trim() || 'unknown'}`,
    };
  return { committed: true };
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

// ── auto-project suggestion (ADR 0023) ────────────────────────────
// `.cache/project-suggestions.json` is a single JSON object:
//   { "skips": [{cwd, declined_at, reason}], "cooldowns": {"<cwd>": "<iso>"} }
// `skips` is written by the LLM (Layer-1 behavioral rule) when the user answers
// "N" to an auto-project offer — permanent per-cwd suppression (no TTL).
// `cooldowns` is written by the hook each time it emits an offer — a 5-minute
// same-cwd noise guard. The two live in one file so doctor validates a single
// schema. Both reads/writes are best-effort; a failure only loses the offer,
// never breaks SessionStart/CwdChanged.

const PROJECT_MARKERS = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
];
const SUGGESTION_COOLDOWN_MS = 5 * 60 * 1000;

/** @returns {string} path to the project-suggestions file for a wiki root. */
export function projectSuggestionsPath(hypoDir) {
  return join(hypoDir, '.cache', 'project-suggestions.json');
}

/**
 * Read the project-suggestions store.
 * @param {string} hypoDir
 * @returns {{skips: object[], cooldowns: Record<string,string>, parseError: boolean}}
 */
export function readProjectSuggestions(hypoDir) {
  const path = projectSuggestionsPath(hypoDir);
  if (!existsSync(path)) return { skips: [], cooldowns: {}, parseError: false };
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return {
      skips: Array.isArray(data.skips) ? data.skips : [],
      cooldowns: data.cooldowns && typeof data.cooldowns === 'object' ? data.cooldowns : {},
      parseError: false,
    };
  } catch {
    return { skips: [], cooldowns: {}, parseError: true };
  }
}

/**
 * Record that an offer was just emitted for `cwd`, starting the cooldown.
 * Preserves the existing skips array. Best-effort.
 */
export function recordSuggestionCooldown(hypoDir, cwd, now = new Date()) {
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const { skips, cooldowns } = readProjectSuggestions(hypoDir);
    cooldowns[cwd] = now.toISOString();
    writeFileSync(
      projectSuggestionsPath(hypoDir),
      JSON.stringify({ skips, cooldowns }, null, 2) + '\n',
    );
  } catch {
    // best-effort
  }
}

/** True when `cwd` carries one of the recognized project-root markers. */
export function cwdHasProjectMarker(cwd) {
  return PROJECT_MARKERS.some((m) => existsSync(join(cwd, m)));
}

/**
 * Decide whether SessionStart/CwdChanged should offer to create a project for
 * `cwd`. The caller MUST have already confirmed `cwd` matches no project's
 * `working_dir` (the hook's MISS branch); this evaluates the remaining ADR 0023
 * trigger conditions: (a) cwd is a git repo, (b) carries a project marker
 * (`.git` alone is a weak signal — §8.11), (c) not in cooldown, (d) not a cwd
 * the user previously declined. A corrupt store stays silent (doctor surfaces).
 *
 * @param {string} cwd
 * @param {string} [hypoDir]
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {boolean}
 */
export function shouldSuggestProjectCreation(cwd, hypoDir = HYPO_DIR, now = Date.now()) {
  if (!cwd) return false;
  if (!existsSync(join(cwd, '.git'))) return false;
  if (!cwdHasProjectMarker(cwd)) return false;
  const { skips, cooldowns, parseError } = readProjectSuggestions(hypoDir);
  if (parseError) return false;
  if (skips.some((s) => s && s.cwd === cwd)) return false;
  const ts = cooldowns[cwd];
  if (ts) {
    const t = Date.parse(ts);
    if (Number.isFinite(t) && now - t < SUGGESTION_COOLDOWN_MS) return false;
  }
  return true;
}

/**
 * Build the §8.11 auto-project offer line for a cwd. The display name is the
 * cwd basename, which is attacker-influenced (a directory name can contain
 * newlines/control chars on Unix). Strip control characters and length-cap it
 * so a crafted dir name cannot spoof extra instructions in additionalContext.
 */
export function buildProjectSuggestionLine(cwd) {
  // Replace any control char (code < 0x20 or === 0x7F) with a space so a
  // crafted dir name cannot inject newlines/instructions into additionalContext.
  // Done by codepoint to keep control bytes out of this source file.
  const sanitized = Array.from(basename(cwd))
    .map((ch) => {
      const code = ch.codePointAt(0);
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
  const safe = sanitized.slice(0, 80).trim() || 'project';
  return `[WIKI: cwd '${safe}'에 매칭되는 프로젝트가 없습니다. 자동 생성할까요? (Y/n)]`;
}

// ── clear-marker (ADR 0022 amendment 2026-05-14) ────────────
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

// ── session-closed marker (ADR 0022 amendment 2026-05-19) ────
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
  return String(sessionId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 128);
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
 * @param {{project?: string, scope?: string, transcript_path?: string}} info
 */
export function writeSessionClosedMarker(hypoDir, sessionId, info = {}) {
  if (!sessionId) return;
  try {
    const cacheDir = join(hypoDir, '.cache');
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    // scope distinguishes a project close (the 5 mandatory files were verified
    // fresh) from a log-only close (a non-project session, no project
    // attribution). Readers (precompactGateStatus / --check-session-close) key
    // the gate semantics on this field, so it must be recorded.
    const scope = info.scope === 'log-only' ? 'log-only' : 'project';
    const payload = {
      session_id: sessionId,
      project: info.project || null,
      scope,
      transcript_path: info.transcript_path || null,
      closed_at: new Date().toISOString(),
      verification: scope === 'log-only' ? 'log-only-close:ok' : 'session-close-file-status:ok',
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

// ── transcript activity heuristic (ADR 0022 amendment 2026-05-19; 6a 2026-06-14) ──
// Substantial-session gate for the Stop hook: a session "worth" blocking on for
// session-close is either (a) any mutation (Edit/Write/MultiEdit/NotebookEdit)
// or (b) a high-volume read-only investigation (≥ READONLY_SUBSTANTIAL_THRESHOLD
// Read/Grep/Glob/Bash calls). Pure Q&A / incidental lookups skip the block.
//
// 6a rationale: code-review / debugging sessions reach real conclusions worth
// crystallizing while touching only read-only tools. The original gate keyed
// purely on mutation tools, so those sessions were never nudged to close. The
// investigation threshold (5) mirrors session-audit.mjs's "search-many" cutoff
// (scripts/session-audit.mjs:206) and sits in the empirical gap between
// incidental lookups (0–3 calls) and real investigation (16–22 calls). Bash is
// now counted (it is the dominant signal in read-only sessions); over-firing is
// bounded by the close-intent gate (the Stop hook only blocks when the user also
// signalled wrap-up) — see hypo-auto-minimal-crystallize.mjs.
//
// NOTE: counting a Bash call here does NOT widen the lint scope. Lint scoping
// (precompactGateStatus) still seeds only Edit/Write-touched files plus the
// mandatory close files — a Bash-written wiki file is not auto-scoped.

const MUTATING_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Read-only investigation tools. Bash included: read-only sessions are
// Bash-dominant (git/grep/cat), so excluding it would leave most of them
// undetectable (a real session had read=0, bash=16).
const INVESTIGATION_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'Bash']);
// Investigation-volume cutoff for a read-only session to count as substantial.
const READONLY_SUBSTANTIAL_THRESHOLD = 5;

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
 * Single-pass tool-use census over a JSONL transcript. Both public predicates
 * (`hasMutatingTranscriptActivity`, `isSubstantialSession`) derive from this one
 * census so the mutation leg stays identical between them. (They still diverge
 * on read-only ≥ threshold sessions, where only `isSubstantialSession` is true.)
 *
 * Granularity (shared contract):
 *   • Whole-file unreadable / missing path → all counts 0 (fail-open).
 *   • Per-line malformed JSON → that line is skipped, scan continues. Real
 *     transcripts occasionally carry truncated lines; one bad line must not
 *     hide a clearly-active session that follows. (Codex Worker-2 CONCERN
 *     resolved 2026-05-19: line-level skip is the intended contract.)
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {{ mutationCount: number, investigationCount: number }}
 */
function transcriptActivityStats(transcriptPath) {
  const stats = { mutationCount: 0, investigationCount: 0 };
  if (!transcriptPath || typeof transcriptPath !== 'string') return stats;
  if (!existsSync(transcriptPath)) return stats;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return stats;
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
      if (MUTATING_TOOL_NAMES.has(name)) stats.mutationCount++;
      else if (INVESTIGATION_TOOL_NAMES.has(name)) stats.investigationCount++;
    }
  }
  return stats;
}

/**
 * True if the JSONL transcript at `transcriptPath` contains ≥1 mutation
 * tool_use (Edit/Write/MultiEdit/NotebookEdit). Kept as a precise, standalone
 * helper (and regression oracle) even though the Stop hook now gates on the
 * broader `isSubstantialSession`.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function hasMutatingTranscriptActivity(transcriptPath) {
  return transcriptActivityStats(transcriptPath).mutationCount > 0;
}

/**
 * True if the session is "substantial" enough to nudge a session-close:
 * any mutation, OR a read-only investigation of at least
 * READONLY_SUBSTANTIAL_THRESHOLD Read/Grep/Glob/Bash calls (6a). The mutation
 * leg is identical to `hasMutatingTranscriptActivity`, so mutating sessions
 * behave exactly as before; only high-volume read-only sessions are newly
 * caught. Over-firing on read-only sessions is bounded downstream by the
 * close-intent gate in hypo-auto-minimal-crystallize.mjs.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
export function isSubstantialSession(transcriptPath) {
  const { mutationCount, investigationCount } = transcriptActivityStats(transcriptPath);
  return mutationCount > 0 || investigationCount >= READONLY_SUBSTANTIAL_THRESHOLD;
}

// ── session-scoped lint classification ──────────────────────────────────────
// Bug A/B fix: the close gate must judge a session on the files IT touched, not
// the whole vault. Lint debt from another project/session (often in shared
// pages/) must not block this session's close/compact. Two scope builders feed
// one shared classifier: transcript-derived (hooks + standalone marker) and
// close-file/payload-derived (the documented apply path writes via Bash, so its
// files never appear as Edit/Write file_paths and must be seeded explicitly).

const MUTATING_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Pull file_path/notebook_path args from mutating tool_use blocks in one
 *  transcript entry. Mirrors extractTranscriptToolNames' shape handling
 *  (top-level tool_use + nested message.content[] blocks). */
function extractTranscriptToolFilePaths(entry) {
  const paths = [];
  if (!entry || typeof entry !== 'object') return paths;
  const pull = (name, input) => {
    if (!name || !MUTATING_FILE_TOOLS.has(name) || !input || typeof input !== 'object') return;
    const fp = input.file_path || input.notebook_path;
    if (typeof fp === 'string' && fp) paths.push(fp);
  };
  if (entry.type === 'tool_use') pull(entry.name || entry.tool_name, entry.input);
  const content = entry.message?.content ?? (Array.isArray(entry.content) ? entry.content : null);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool_use') {
        pull(block.name || block.tool_name, block.input);
      }
    }
  }
  return paths;
}

/** Normalize an absolute path to a repo-relative POSIX path under hypoDir, or
 *  null if it resolves outside the wiki. */
function toHypoRel(absPath, hypoDir) {
  let rel;
  try {
    rel = relative(hypoDir, absPath);
  } catch {
    return null;
  }
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null;
  return rel.split('\\').join('/');
}

/**
 * Repo-relative POSIX paths of wiki files this session edited via direct
 * Edit/Write/MultiEdit/NotebookEdit tool_use. Returns a Set; empty when the
 * transcript is missing/unreadable (callers decide the fallback). A per-line
 * JSON parse error skips that line only (transcripts occasionally truncate).
 */
export function extractTouchedWikiFiles(transcriptPath, hypoDir) {
  const out = new Set();
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    return out;
  }
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let entry;
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    for (const fp of extractTranscriptToolFilePaths(entry)) {
      const rel = toHypoRel(fp, hypoDir);
      if (rel) out.add(rel);
    }
  }
  return out;
}

/**
 * The mandatory session-close files (repo-relative POSIX). The documented close
 * path `crystallize.mjs --apply-session-close` writes these from inside a Bash
 * call, so they never surface as Edit/Write file_paths — they must seed the
 * scoped-lint set explicitly or a close-introduced error would escape the gate.
 * Mirrors the file list in sessionCloseFileStatus.
 */
export function closeFileTargets(hypoDir) {
  const out = new Set(['hot.md', 'log.md']);
  const project = resolveActiveProject(hypoDir);
  if (project) {
    out.add(`projects/${project}/session-state.md`);
    out.add(`projects/${project}/hot.md`);
    out.add(sessionLogScopePath(hypoDir, project, freshDates()[0]));
  }
  return out;
}

/**
 * Global variant of closeFileTargets for the no-payload lint-scope callers
 * (ADR 0043). Union of the close files over every today-active project
 * (fallback: the recency project when none is active). Includes the session-log
 * evidence file for EVERY freshDate (not just dates[0]) so the lint scope matches
 * what sessionCloseFileStatus actually checks across a local/UTC date boundary.
 */
export function closeFileTargetsGlobal(hypoDir) {
  const dates = freshDates();
  const out = new Set(['hot.md', 'log.md']);
  let active = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );
  if (active.length === 0) {
    const recency = resolveActiveProject(hypoDir);
    if (recency) active = [recency];
  }
  for (const p of active) {
    out.add(`projects/${p}/session-state.md`);
    out.add(`projects/${p}/hot.md`);
    // Scope to the file each date's freshness is PROVEN by (daily shard or, via
    // fallback, the legacy monthly), so a corrupt evidence file can't pass the
    // gate while its lint error is demoted to an out-of-scope notice.
    for (const d of dates) out.add(sessionLogScopePath(hypoDir, p, d));
  }
  return out;
}

/** Normalize a path's separators to POSIX so scope membership is OS-independent.
 *  lint.mjs emits `file` via path.relative (back-slashes on Windows) while the
 *  scope builders produce forward-slash paths — normalize both sides. */
function posixPath(p) {
  return (p || '').split('\\').join('/');
}

/**
 * Partition lint findings into `blocking` (a file this session is accountable
 * for) vs `notice` (pre-existing debt elsewhere — surfaced, not blocking).
 *
 * `scope` = iterable of repo-relative paths the session is accountable for.
 * Membership is exact on the normalized path. Only findings passed in are
 * classified — callers pass lint ERRORS; broken wikilinks (lint W4 warnings) are
 * intentionally warn-only (forward references to planned pages are normal in a
 * wiki) and are NOT promoted to blocking by this gate.
 */
export function partitionLintScope(findings, scope) {
  const normScope = new Set([...scope].map(posixPath));
  const blocking = [];
  const notice = [];
  for (const f of findings || []) {
    if (normScope.has(posixPath(f.file))) blocking.push(f);
    else notice.push(f);
  }
  return { blocking, notice };
}

// ── PreCompact gate — single source of truth ────────────────────────────────
/**
 * The full PreCompact gate decision as a READ-ONLY status. This is the single
 * source of truth for "is the wiki compact-ready?": both hypo-personal-check.mjs
 * (the PreCompact hook) and `crystallize --check-session-close` call it, so a
 * green status means /compact will not block on a human-fixable issue.
 *
 * Read-only: feedback projection PURE drift is reported as a non-blocking notice
 * with its targets in `driftTargets` (an "effect requirement"), NOT a blocker —
 * the hook self-heals it with `feedback-sync --write` before continuing (ADR
 * 0045) and a verify caller needs no human action for it. over-cap and conflict
 * DO block (ADR 0031 rules 3 & 6 — human demote/import required).
 *
 * Faithfulness caveats (why "compact-ready", not "guaranteed pass"): the hook
 * has paths outside this status — a context-≥70% early block, HYPO_SKIP_GATE
 * bypass, and a fail-closed if the self-heal `--write` itself errors. And without
 * a transcript the lint scope is the mandatory close files only; pass
 * opts.transcriptPath to widen it to the session's edited files exactly as the
 * hook does.
 *
 * @param {string} hypoDir
 * @param {{lintScope?: Iterable<string>, transcriptPath?: string|null, claudeHome?: string}} [opts]
 * @returns {{ok: boolean, close: object, blockers: {type:string,reason:string}[], notices: {type:string,reason:string}[], driftTargets: string[], skipped: {lint:boolean, feedback:boolean}}}
 */
export function precompactGateStatus(hypoDir, opts = {}) {
  const blockers = [];
  const notices = [];
  const driftTargets = [];
  const skipped = { lint: false, feedback: false };

  // log-only synthetic close mode. A non-project (tooling / wiki-only)
  // session has no project to close. Activated either by the explicit writer flag
  // (opts.logOnly, from `--mark-session-closed --log-only`) or by a log-only marker
  // for opts.sessionId (the PreCompact / --check-session-close readers). In this
  // mode the project-close invariant is replaced by a today log.md entry (minimum
  // proof), and — critically — the active/phantom project is NEVER put in
  // close.projects, because that set ALSO drives the lint scope and W8 ownership
  // below. Exempting only the close blocker would still let an unrelated project's
  // stale design-history / lint block the non-project session (codex design
  // BLOCKER). git / hot / lint(self) / feedback all still apply — not a bypass.
  const marker = opts.sessionId ? readSessionClosedMarker(hypoDir, opts.sessionId) : null;
  const logOnly = opts.logOnly === true || marker?.scope === 'log-only';

  // 1. wiki git state (ADR 0056). Uncommitted changes (real unsaved work) BLOCK —
  //    they are human-fixable. Unpushed commits (ahead) DEMOTE to a notice: push is
  //    automatic (auto-commit Stop hook) and its failures are already non-fatal, so
  //    "ahead" is a transient sync state, not a human-fixable blocker. Demoting it
  //    here (the shared gate) keeps the marker == compact-ready invariant (ADR 0047):
  //    a committed-but-unpushed close marks AND compacts, instead of the close writer
  //    committing its own payload and then being blocked by its own (unpushed) commit.
  const git = hypoIsClean(hypoDir);
  if (git.uncommitted) blockers.push({ type: 'git', reason: git.reason });
  else if (git.ahead)
    notices.push({
      type: 'git-sync',
      reason: `unpushed commits in ${hypoDir} (push deferred to Stop hook)`,
    });

  // 2. root hot.md structure
  const hot = hotMdIsClean(hypoDir);
  if (!hot.clean) blockers.push({ type: 'hot', reason: hot.reason });

  // 3. session-close files (global invariant, ADR 0043) — or, in log-only mode,
  //    the minimum proof (a today log.md entry) with NO project attribution.
  let close;
  if (logOnly) {
    const hasLog = hasAnyTodayLogEntry(hypoDir);
    close = {
      ok: hasLog,
      projects: [],
      dates: freshDates(),
      fallback: false,
      primary: null,
      project: null,
      stale: [],
      missing: hasLog ? [] : ['log.md (no today session entry)'],
    };
    if (!hasLog) {
      blockers.push({
        type: 'close',
        reason: 'log-only close: log.md has no today session entry (minimum proof)',
      });
    }
  } else {
    close = sessionCloseGlobalStatus(hypoDir);
    if (!close.ok) {
      blockers.push({
        type: 'close',
        reason: `memory files not updated this session: ${[
          ...close.missing.map((f) => `${f} (missing)`),
          ...close.stale.map((f) => `${f} (stale)`),
        ].join(', ')}`,
      });
    }
  }

  // 4. lint blockers + W8 design-history (scoped). Mirrors hypo-personal-check.
  const lintPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'lint.mjs') : null;
  if (!lintPath || !existsSync(lintPath)) {
    skipped.lint = true; // no package → fail-open (never block on missing tooling)
  } else {
    try {
      // Pass --hypo-dir explicitly: lint.mjs resolves the vault via HYPO_DIR /
      // home dirs and ignores cwd, so a --hypo-dir caller (crystallize, tests)
      // would otherwise lint the ambient wiki, not the one under test.
      // maxBuffer matches crystallize's runLint (64 MiB): warn-heavy output on a
      // large wiki easily exceeds Node's 1 MiB default, which would truncate
      // stdout and (via the catch below) silently fail-open this gate.
      const r = spawnSync('node', [lintPath, '--json', `--hypo-dir=${hypoDir}`], {
        encoding: 'utf-8',
        cwd: hypoDir,
        timeout: 30000,
        maxBuffer: 64 * 1024 * 1024,
      });
      // A spawn failure (ENOENT), a timeout/kill (status === null), or a crash
      // that produced no stdout must NOT be parsed as `{}` and treated as a clean
      // lint — that path leaves skipped.lint=false with no notice, an INVISIBLE
      // fail-open. Throw instead so the catch below records skipped.lint=true WITH
      // a reason notice.
      if (r.error || r.status === null) {
        throw new Error(`lint spawn failed: ${r.error?.code || `signal ${r.signal}`}`);
      }
      if (!r.stdout || !r.stdout.trim()) {
        throw new Error(
          `lint produced no stdout (exit=${r.status})${r.stderr ? `: ${r.stderr.slice(-500)}` : ''}`,
        );
      }
      const parsed = JSON.parse(r.stdout);
      const allErrors = parsed.errors || [];
      const allW8 = (parsed.warns || []).filter((w) => w.id === 'W8');
      // log-only base scope = the shared root files only (hot.md / log.md) — NOT
      // closeFileTargetsGlobal, which would fold the active/phantom project's
      // mandatory files in and re-introduce the cross-project attribution. The
      // session's own transcript-touched files are still added below (a log-only
      // session is accountable for the wiki files it actually edited).
      const scope = new Set(
        opts.lintScope || (logOnly ? ['hot.md', 'log.md'] : closeFileTargetsGlobal(hypoDir)),
      );
      if (opts.transcriptPath && existsSync(opts.transcriptPath)) {
        for (const f of extractTouchedWikiFiles(opts.transcriptPath, hypoDir)) scope.add(f);
      }
      const part = partitionLintScope(allErrors, scope);
      if (part.blocking.length > 0) {
        blockers.push({
          type: 'lint',
          reason: `lint blockers: ${[...new Set(part.blocking.map((b) => b.id || b.file))].join(', ')}`,
        });
      }
      for (const n of part.notice)
        notices.push({ type: 'lint', reason: `${n.file}${n.id ? ` (${n.id})` : ''}` });
      // W8 (design-history stale) is each today-active project's own close
      // responsibility; others' are non-blocking notices (ADR 0043). In log-only
      // mode there is NO project this session is accountable for, so every W8 is a
      // notice — a non-project session must never be blocked by some project's
      // stale design-history (codex design BLOCKER: the attribution leak this fix
      // closes).
      const activeSlugs = logOnly
        ? []
        : (close.projects || []).map((p) => p.project).filter(Boolean);
      const mine = new Set(activeSlugs.map((s) => `projects/${s}/design-history.md`));
      const w8Blocking = logOnly
        ? []
        : activeSlugs.length > 0
          ? allW8.filter((w) => mine.has(w.file))
          : allW8;
      const w8Notice = logOnly
        ? allW8
        : activeSlugs.length > 0
          ? allW8.filter((w) => !mine.has(w.file))
          : [];
      if (w8Blocking.length > 0) {
        blockers.push({
          type: 'design-history',
          reason: `design-history stale: ${w8Blocking.map((w) => w.file.split('/')[1]).join(', ')}`,
        });
      }
      for (const w of w8Notice) notices.push({ type: 'design-history', reason: w.file });
    } catch (e) {
      skipped.lint = true; // fail-open on tooling error
      // Surface WHY the gate skipped lint (truncated stdout, timeout, spawn error)
      // instead of silently dropping the check — a fail-open is invisible otherwise.
      notices.push({
        type: 'lint',
        reason: `lint skipped (fail-open): ${e.message || e.code || 'unknown error'}`,
      });
    }
  }

  // 5. feedback projection (ADR 0031 / 0045). over-cap/conflict block; pure
  //    drift is a self-healable notice (driftTargets = effect requirement the
  //    hook runs as --write). Classification mirrors hypo-personal-check exactly.
  const feedbackPath = PKG_ROOT ? join(PKG_ROOT, 'scripts', 'feedback-sync.mjs') : null;
  const claudeHome = opts.claudeHome || join(HOME, '.claude');
  if (!feedbackPath || !existsSync(feedbackPath)) {
    skipped.feedback = true;
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
          `--hypo-dir=${hypoDir}`,
          `--claude-home=${claudeHome}`,
        ],
        { encoding: 'utf-8', timeout: 30000 },
      );
      if (r.error || r.status === null) {
        skipped.feedback = true; // spawn failure → fail-open
      } else if (r.status !== 0) {
        // Only a non-zero exit carries an actionable issue. A clean check exits 0
        // (the implicit else below) — that is NOT skipped, just nothing to do.
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
          skipped.feedback = true; // buildError / unparseable / non-actionable → fail-open
        } else if (conflictedT.length) {
          blockers.push({
            type: 'feedback',
            reason: `feedback projection conflict (manual edit of ${conflictedT.join(', ')}) — run \`hypomnema feedback-sync --import-target-change --from=<memory|claude>\``,
          });
        } else if (overCapT.length) {
          blockers.push({
            type: 'feedback',
            reason: `feedback projection over cap (${overCapT.join(', ')}) — demote/archive feedback pages`,
          });
        } else {
          driftTargets.push(...driftedT); // pure drift → self-healable, not a blocker
          notices.push({
            type: 'feedback',
            reason: `feedback projection drift (${driftedT.join(', ')}) — will self-heal at /compact`,
          });
        }
      }
    } catch {
      skipped.feedback = true;
    }
  }

  return { ok: blockers.length === 0, close, blockers, notices, driftTargets, skipped };
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

/** Returns true if the prompt is either /compact or /clear (ADR 0022 Layer 2). */
export function isCompactOrClearCommand(prompt) {
  return isCompactCommand(prompt) || isClearCommand(prompt);
}

/**
 * Extract recent user-role message text from a JSONL transcript (last `tailN`
 * lines). Promoted from hypo-personal-check.mjs so both the
 * PreCompact gate and the Stop-chain Layer 3 hook share one close-intent
 * signal source. Claude Code transcript format: each line is
 * `{ type:"user", message:{ role:"user", content: ... } }`; the older
 * top-level `{ role, content }` shape is also accepted. tool_result blocks
 * (also role:'user') are excluded so tool output never feeds the close-intent
 * gate — only top-level `type:'text'` blocks and string content count.
 *
 * @param {string} transcriptPath
 * @param {number} tailN  how many trailing lines to scan (default 30)
 * @returns {string} newline-joined user text, or '' on any failure (fail-open)
 */
export function extractUserMessages(transcriptPath, tailN = 30) {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    // tailN === Infinity → whole transcript (the marker-write hard gate needs the
    // full prefix; a close request can precede the marker by the entire close
    // checklist). The Stop hook keeps the 30-line default so a stale old close
    // signal doesn't re-trigger every turn.
    const tail = Number.isFinite(tailN) ? lines.slice(-tailN) : lines;
    return tail
      .map((line) => {
        try {
          const obj = JSON.parse(line);
          // Skill-injection vector (ADR 0055): drop system-injected role:user
          // messages before they pollute the close-intent signal.
          //  • isMeta:true   — slash-command bodies, skill bodies, local-command
          //    caveats. Their text is docs/specs, often full of close vocabulary
          //    (e.g. the /hypo:crystallize spec literally contains close phrases),
          //    which would let the gate self-satisfy the moment the model invokes
          //    a close command. Confirmed isMeta:true in the transcript.
          //  • promptSource system|sdk — task-notifications (system) and
          //    SDK / QA-harness synthetic prompts (sdk). Neither is user-typed.
          if (obj.isMeta === true) return '';
          if (obj.promptSource === 'system' || obj.promptSource === 'sdk') return '';
          const msg = obj.message ?? obj;
          const role = msg.role ?? obj.role ?? obj.type;
          if (role !== 'user') return '';
          const content = msg.content ?? obj.content;
          if (typeof content === 'string') {
            // Stop-hook block feedback is recorded as a role:user string. It is
            // the hook's OWN nudge ("[WIKI_AUTOCLOSE] … Run crystallize …"), not
            // user intent — counting it would be circular (the hook that prods the
            // model to close would become proof the user wanted to close).
            return content.startsWith('Stop hook feedback') ? '' : content;
          }
          if (Array.isArray(content)) {
            // Only genuine user-typed text blocks. tool_result blocks are also
            // recorded with role:'user' in the Claude Code transcript; slurping
            // them via JSON.stringify let tool output (e.g. close-pattern example
            // strings read out of code/docs) trip the close-intent gate.
            // Do NOT recurse into tool_result.content, or the pollution returns.
            return content
              .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n');
          }
          return '';
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
    // 끝: bare terminal noun, boundary-guarded so "세션 끝내는 방법" /
    // "세션 끝나면" don't trip.
    /세션\s*끝(?![가-힣])/,
    // 세션 마무리/종료 (ADR 0055): the OLD pattern required a fixed verb suffix
    // (하자/할게/했어) and missed the most common real phrasings — "세션 마무리
    // 해줘" (imperative), bare "세션 마무리", "세션마무리" (no space). A
    // blacklist lookahead (excluding 조건/로직/여부/…) is whack-a-mole because
    // noun-modifiers are an open class. WHITELIST instead: match only when
    // 마무리/종료 is followed by a close-intent verb suffix OR sentence-end. This
    // structurally rejects noun-modifiers (세션 종료 여부/로직/작업 정리) and
    // negations (세션 종료 안 해도 돼, 세션 마무리하지 않아도) without enumerating.
    // The suffixes are COMPLETE terminal forms followed by a non-Hangul boundary
    // (?![가-힣]), so connective continuations die: 해주는/해주기 (해 alone, then
    // 주 follows), 해야 하는 / 해도 되는지 (해 alone, then 야/도 follows). 하고 is
    // deliberately dropped — "마무리하고 블로그"(close) and "마무리하고 싶은지"(not)
    // are structurally identical, and over-close is the worse failure, so we accept
    // the rare FN over the FP. The residual: connective forms that happen to put a
    // space after a complete terminal can't be separated by regex without a
    // morphological parser — that's bounded by the compound gate (precompact-green
    // + signal) and the unambiguous /compact and AskUserQuestion channels (ADR 0055
    // threat boundary), not chased further.
    /세션\s*(?:마무리|종료)(?:\s*(?:해줘|해주세요|해요|해|하자|하죠|했어|했다|했음|했지|합시다|합니다|할게|할께|할래|할까|할까요|한\s?거(?:지|야|니)?|함)(?![가-힣])|\s*[)\].,!?~。…]|\s*$)/m,
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
    // wrap up: requires session-level context or sentence-end, not code-level
    // objects. The review/analysis/debug/audit/investigation nouns were added
    // for 6a — read-only review sessions are now "substantial", so "wrap up the
    // review" must read as a task-level signal, not a session-close one.
    // Leading \b on each pattern (ADR 0055) so an EN close phrase embedded as a
    // substring of a longer token can't trip the gate (e.g. "designing off…").
    /\bwrap(?:ping)?\s+up(?!\s+(?:this|the)\s+(?:pr|issue|bug|task|function|component|module|feature|code|test|review|analysis|investigation|debugging|debug|audit|refactor)\b)/i,
    /\bdone\s+for\s+(?:today|now|the\s+day)\b/i,
    /\bthat'?s?\s+(?:all|it)\s+for\s+(?:today|now|the\s+day)\b/i,
    /\bsigning\s+off\b/i,
    /\bend(?:ing)?\s+(?:the|this)\s+(?:session|work|day)\b/i,
    /\bclose\s+(?:the|this)\s+session\b/i,
  ];
  return [...krPatterns, ...enPatterns].some((re) => re.test(text));
}

/**
 * Resolve a session's transcript path from its (globally-unique) session id by
 * globbing every Claude project dir: ~/.claude/projects/<slug>/<id>.jsonl.
 *
 * Why glob, not cwd-derive: the transcript lives under a slug built from the cwd
 * AT SESSION START, but the marker-writer subprocess can run from a DIFFERENT cwd
 * (the real over-close ran `cd ~/hypomnema && crystallize …`), so a cwd-derived
 * slug would miss the file. The session id is a UUID, so the glob disambiguates
 * without needing the slug — verified globally unique across all project dirs.
 *
 * Fail-closed on ambiguity (ADR 0055, codex review): returns the single resolved
 * path, or null when ZERO or MORE-THAN-ONE distinct files match (realpath-deduped
 * so a symlink to the same file is not "multiple"). The caller treats null as
 * "refuse the marker".
 *
 * `projectsRoot` defaults to the real ~/.claude/projects; tests pass a controlled
 * root so they exercise the real resolver instead of a forgeable path override.
 */
export function resolveTranscriptBySessionId(
  sessionId,
  projectsRoot = join(HOME, '.claude', 'projects'),
) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  // Session ids are UUID-shaped; reject anything with path separators / glob
  // chars so a crafted id can't escape the projects root or match siblings.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  try {
    const base = projectsRoot;
    const seen = new Set();
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const p = join(base, ent.name, `${sessionId}.jsonl`);
      if (!existsSync(p)) continue;
      try {
        seen.add(realpathSync(p));
      } catch {
        seen.add(p);
      }
    }
    return seen.size === 1 ? [...seen][0] : null;
  } catch {
    return null;
  }
}

/**
 * Returns true iff the transcript carries a genuine USER session-close signal —
 * the hard gate for the session-closed marker writers (ADR 0055). Scans the FULL
 * transcript: a close request can precede the marker write by the entire close
 * checklist, so the Stop hook's 30-line tail would miss it.
 *
 * Evidence (any one is sufficient):
 *   1. a de-polluted NL close phrase — isClosePattern over extractUserMessages,
 *      which already drops injected / tool / hook-feedback text (ADR 0055);
 *   2. a `/compact` invocation (queue-operation). `/clear` is deliberately NOT
 *      counted: it abandons context, whereas a session-close PRESERVES the work
 *      to the wiki — a different intent;
 *   3. an AskUserQuestion answer whose SELECTED value names a close action (the
 *      canonical "offer [세션 마무리] → user picks it" flow).
 *
 * A Stop-hook block is NOT evidence: it is the hook's own nudge to close, so
 * counting it would be circular (the incident's block told the model to write the
 * marker). extractUserMessages already strips it.
 *
 * Fail-closed: any read error → false (caller refuses the marker).
 */
export function hasUserCloseSignal(transcriptPath) {
  if (!transcriptPath) return false;
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n');
  } catch {
    return false;
  }
  // (1) NL close over the full, de-polluted transcript.
  if (isClosePattern(extractUserMessages(transcriptPath, Infinity))) return true;
  // AskUserQuestion answers (3) must be correlated to a real AskUserQuestion
  // tool_use by id — otherwise ANY tool_result string containing "have been
  // answered" (e.g. a Read/Grep of this very file, or of a transcript) would
  // satisfy the gate, reintroducing the tool_result pollution the de-pollution
  // layer closes. First pass collects the genuine AskUserQuestion tool_use ids;
  // the tool_use (assistant) always precedes its tool_result (user) in the log,
  // so a single forward scan suffices.
  const askIds = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // (2) /compact (queue-operation). Not /clear — see doc above.
    if (
      obj.type === 'queue-operation' &&
      typeof obj.content === 'string' &&
      /^\/compact(?:\s|$)/.test(obj.content.trim())
    ) {
      return true;
    }
    const content = (obj.message ?? obj).content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      // record AskUserQuestion tool_use ids
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) {
        askIds.add(b.id);
        continue;
      }
      // (3) AskUserQuestion answer naming a close action — only when this
      // tool_result actually answers a recorded AskUserQuestion. The answer lands
      // in a role:user tool_result string: `… have been answered: "Q"="A". …`.
      // Match the answer value(s) (the `="…"` side), never the question text, and
      // run the SAME isClosePattern as the NL path so the two channels agree.
      if (b.type === 'tool_result' && b.tool_use_id && askIds.has(b.tool_use_id)) {
        const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        for (const m of s.matchAll(/="([^"]*)"/g)) {
          if (isClosePattern(m[1])) return true;
        }
      }
    }
  }
  return false;
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
