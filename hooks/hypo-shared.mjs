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
  statSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
  realpathSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
} from 'fs';
import { join, relative, basename, dirname } from 'path';
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

// Returns the wiki's git state split into its two independent axes:
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
 * Option D: the date IS the filename (`YYYY-MM-DD.md`), so no
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
 * Bounded with an explicit `(?=[\s:]|$)` lookahead, NOT `\b`: a regex word
 * boundary matches between word and non-word chars, so `\b` after "foo" still
 * matches in "foo-bar" (hyphen is non-word). The canonical log format separates
 * the project slug from anything that follows by whitespace, a colon, or
 * end-of-line, so the lookahead correctly rejects "session | foo-bar" when
 * looking for "foo". Both delimiters are canonical: the derive path
 * (rootLogEntry) emits `<project> — <title>` (space), while the dominant
 * hand-written convention is `<project>: <title>` (colon, since the tone rule
 * banned the em dash). The colon must be accepted: without it, a close whose
 * only log.md evidence used the colon form was misread as "stale" and blocked
 * non-deterministically. (Was a pre-existing boundary bug in
 * sessionCloseFileStatus that the helper extraction inherited.)
 */
export function hasLogEntry(content, date, project) {
  return new RegExp(
    '^## \\[' + escapeRegExp(date) + '\\] session \\| ' + escapeRegExp(project) + '(?=[\\s:]|$)',
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

// ── freshness: overdue verify_by_date predicate + STALE injection marker ─────
// Authority is doctor.mjs:487-491 (D1). Same characters, same meaning: only a
// well-formed ISO date strictly before `today` is overdue. verify_by (the
// natural-language question) is never a date and is never consulted here.
// today is caller-supplied and must use the UTC convention (new Date()
// .toISOString().slice(0,10)) so this set matches doctor's.
export function isOverdueDate(dateStr, today) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && dateStr < today;
}

// Compute the injection marker for a page's raw content. Returns
// `[STALE verify_by_date=YYYY-MM-DD]` when overdue, otherwise an empty string
// (so non-targets pass through unchanged). Callers prepend the non-empty result
// at injection time.
//
// The value read here must be normalized exactly as scripts/lib/frontmatter.mjs
// does (doctor's parser), so the overdue set stays char-identical to doctor.mjs.
// In particular it strips a trailing YAML inline comment (`2020-01-01 # note`):
// the plain parseFrontmatterField does not, which would silently miss dates
// doctor flags overdue. Top-level line only (skip indented / list entries),
// first-wins, strip comment, then strip surrounding quotes.
export function staleMarkerFor(rawContent, today) {
  const m = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  let value = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || /^-(\s|$)/.test(line)) continue; // nested / list item
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() !== 'verify_by_date') continue; // key match (idx: tolerates `key : v`)
    value = line
      .slice(idx + 1)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
    break; // first-wins
  }
  return value && isOverdueDate(value, today) ? `[STALE verify_by_date=${value}]` : '';
}

// ── page-usage logging: commit-coverage guard + append (B, D6) ───────────────
// Logging which pages lookup injects is observability, never an injection path.
// The log lives at .cache/page-usage.jsonl and must never be committed. Before
// any append, prove that file cannot be staged/committed: it must be covered by
// BOTH git's ignore rules (check-ignore) AND .hypoignore (which is what gates
// hypo-auto-stage and commitWikiChanges). Missing either signal, or any error
// (no git, timeout, non-repo), returns false so nothing is written (fail-closed
// logging). Injection stays fail-open and is unaffected. The verdict is cached
// per session (keyed by session_id plus a vault-path hash so two vaults in one
// session can't cross-contaminate) so git runs at most once per session.
export const PAGE_USAGE_REL = '.cache/page-usage.jsonl';

export function pageUsageGuardCachePath(sessionId, hypoDir) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  // djb2 over the vault path so the cache key is per-(session, vault).
  let h = 5381;
  const s = String(hypoDir || '');
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return join(tmpdir(), `hypo-pageusage-guard-${safe}-${h.toString(36)}.json`);
}

export function pageUsageLoggingAllowed(hypoDir, sessionId) {
  // The load-bearing commit gate is .hypoignore: it is what hypo-auto-stage and
  // commitWikiChanges actually filter on. Re-check it FRESH on every call (it is
  // cheap, no subprocess) so that if coverage is removed mid-session the guard
  // flips closed immediately and can never leave logging armed against a
  // now-committable file. Only the expensive git check-ignore probe is cached
  // per session. Any error on either signal fails closed.
  let hypoIgnored = false;
  try {
    const target = join(hypoDir, PAGE_USAGE_REL);
    const patterns = loadHypoIgnore(hypoDir);
    hypoIgnored = patterns.length > 0 && isIgnored(target, hypoDir, patterns);
  } catch {
    hypoIgnored = false;
  }
  if (!hypoIgnored) return false;

  return gitIgnoresPageUsageCached(hypoDir, sessionId);
}

// git check-ignore is the belt signal (defends a manual `git add`); it spawns a
// subprocess, so cache its result per session. The verdict cached here is only
// the git signal, never the composite allow decision, so the fresh .hypoignore
// re-check above always still runs.
function gitIgnoresPageUsageCached(hypoDir, sessionId) {
  const cachePath = pageUsageGuardCachePath(sessionId, hypoDir);
  try {
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
      if (typeof cached.gitIgnored === 'boolean') return cached.gitIgnored;
    }
  } catch {
    // corrupt cache → recompute below
  }

  let gitIgnored = false;
  try {
    gitIgnored =
      spawnSync('git', ['-C', hypoDir, 'check-ignore', '-q', '--', PAGE_USAGE_REL], {
        timeout: 2000,
      }).status === 0;
  } catch {
    gitIgnored = false;
  }

  try {
    writeFileSync(cachePath, JSON.stringify({ gitIgnored }));
  } catch {
    // cache write failure is non-fatal; the git probe just reruns next prompt
  }
  return gitIgnored;
}

// Append one JSONL record per injected slug to .cache/page-usage.jsonl. Callers
// MUST gate this behind pageUsageLoggingAllowed first. Fully fail-open: any error
// (mkdir, disk, serialization) is swallowed so a logging failure never disturbs
// the lookup injection that already happened (mirrors hypo-session-record).
export function recordLookupUsage(hypoDir, { sessionId = null, slugs = [] } = {}) {
  try {
    if (!Array.isArray(slugs) || slugs.length === 0) return;
    const target = join(hypoDir, PAGE_USAGE_REL);
    mkdirSync(join(hypoDir, '.cache'), { recursive: true });
    const ts = new Date().toISOString();
    const lines = slugs
      .map((slug) => JSON.stringify({ ts, session_id: sessionId ?? null, slug, source: 'lookup' }))
      .join('\n');
    appendFileSync(target, lines + '\n');
  } catch {
    // logging is observability; never let it break injection (fail-open)
  }
}

// ── cwd ↔ project matcher ────────────────────────────────────────────────────
// Hand-synced with scripts/lib/wd-match.mjs: hooks deploy to ~/.claude/hooks/
// without scripts/, so this cannot import the lib and must mirror it. Keep the
// two in step; the lib carries the unit tests.

// Expand a leading ~/ (or bare ~), strip trailing slashes. null for empty.
export function normalizeWorkingDir(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (s === '~') s = homedir();
  else if (s.startsWith('~/')) s = `${homedir()}/${s.slice(2)}`;
  s = s.replace(/\/+$/, '');
  return s || null;
}

// macOS/Windows match paths case-insensitively; Linux does not. Fold only there.
export function isCaseInsensitiveFs(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function _fold(s, ci) {
  return ci ? s.toLowerCase() : s;
}
function _lastSeg(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

// Resolve which project owns cwd. Tier 1: longest absolute working_dir prefix
// (the original behavior). Tier 2 (cross-machine): when the synced vault holds
// another machine's absolute path, a cwd ancestor whose directory name is a
// GLOBALLY unique project basename identifies the project; a shared dirname
// declines (null) so the caller falls back to recency. `projects` is the whole
// universe (for the uniqueness gate); `eligible` restricts the answer.
export function pickProjectByCwd(projects, cwd, opts = {}) {
  const { eligible = null, realpathCwd = null, caseInsensitive = isCaseInsensitiveFs() } = opts;
  if (!cwd && !realpathCwd) return null;
  const eligibleSet = eligible ? new Set(eligible) : null;
  const isEligible = (slug) => !eligibleSet || eligibleSet.has(slug);

  const entries = [];
  for (const p of projects) {
    const path = normalizeWorkingDir(p.workingDir);
    if (path) entries.push({ slug: p.slug, path });
  }
  if (entries.length === 0) return null;

  // raw cwd first, realpath only as a fallback (a raw match must not be
  // overridden by a longer realpath match).
  const cwds = [];
  for (const c of [cwd, realpathCwd]) {
    const n = normalizeWorkingDir(c);
    if (n && !cwds.includes(n)) cwds.push(n);
  }

  // Tier 1: first cwd variant with any longest-prefix match wins.
  for (const c of cwds) {
    const cf = _fold(c, caseInsensitive);
    let bestSlug = null;
    let bestLen = -1;
    for (const e of entries) {
      if (!isEligible(e.slug)) continue;
      const pf = _fold(e.path, caseInsensitive);
      if ((cf === pf || cf.startsWith(`${pf}/`)) && e.path.length > bestLen) {
        bestLen = e.path.length;
        bestSlug = e.slug;
      }
    }
    if (bestSlug) return bestSlug;
  }

  // Tier 2: unique-basename ancestor, but only when the chain points at exactly
  // ONE project (two distinct matches along the path → decline, fail closed).
  const byBasename = new Map();
  for (const e of entries) {
    const b = _fold(_lastSeg(e.path), caseInsensitive);
    if (!b) continue;
    const hit = byBasename.get(b);
    if (hit) hit.count += 1;
    else byBasename.set(b, { slug: e.slug, count: 1 });
  }

  for (const c of cwds) {
    const matched = new Set();
    let cur = c;
    while (cur && cur.includes('/')) {
      const b = _fold(_lastSeg(cur), caseInsensitive);
      const hit = b && byBasename.get(b);
      if (hit && hit.count === 1 && isEligible(hit.slug)) matched.add(hit.slug);
      cur = cur.slice(0, cur.lastIndexOf('/'));
    }
    if (matched.size === 1) return [...matched][0];
  }
  return null;
}

// Disk companion: [{slug, workingDir}] for every real project (skips _template
// and dirs without index.md). The full set is the tier-2 uniqueness universe.
// working_dir is cleaned exactly like scripts/lib/frontmatter.mjs parseFrontmatter
// (strip a trailing ` # comment`, then surrounding quotes) so this stays in step
// with the script-side collector — parseFrontmatterField alone skips the comment.
export function collectProjectWorkingDirs(hypoDir) {
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return [];
  const out = [];
  for (const slug of readdirSync(projectsDir)) {
    if (slug === '_template') continue;
    const dir = join(projectsDir, slug);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const indexPath = join(dir, 'index.md');
    if (!existsSync(indexPath)) continue;
    let workingDir = null;
    try {
      const fm = readFileSync(indexPath, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const line = fm && fm[1].split(/\r?\n/).find((l) => /^working_dir:/.test(l));
      if (line) {
        workingDir = line
          .slice('working_dir:'.length)
          .trim()
          .replace(/\s+#.*$/, '')
          .replace(/^['"]|['"]$/g, '');
      }
    } catch {
      workingDir = null;
    }
    out.push({ slug, workingDir: workingDir || null });
  }
  return out;
}

// A project without a working_dir anchor (no index.md, or an index.md missing
// the field) never enters collectProjectWorkingDirs' universe, so cwd-first
// resume always MISSes for it — the SessionStart/CwdChanged MISS branch would
// otherwise only ever offer to create a brand-new (duplicate) project. Match
// the cwd's LEAF basename only (not every ancestor): the anchor being written
// is `working_dir: <cwd>` itself, so matching an ancestor directory would
// backfill the wrong (parent) path. Since projects/<slug>/ names are unique on
// disk, a leaf-basename match identifies at most one project — no separate
// uniqueness gate is needed here (unlike pickProjectByCwd's cross-machine tier
// 2, which reasons over synced *paths* that can collide).
//
// Known bound: a session whose cwd is a SUBDIRECTORY of the anchorless
// project's root (rather than the root itself) will not match — this is a
// deliberate scope limit, not a bug: guessing the project from a mid-tree cwd
// would risk writing an anchor to the wrong (non-root) path.
//
// @param {string} cwd
// @param {string} [hypoDir=HYPO_DIR]
// @returns {{slug: string, hasIndex: boolean}|null} the anchorless project
//   this cwd's leaf basename names, or null when there is no match, no
//   session artifacts, or the project already carries a working_dir.
export function findBackfillCandidate(cwd, hypoDir = HYPO_DIR) {
  const n = normalizeWorkingDir(cwd);
  if (!n) return null;
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return null;
  const leaf = _lastSeg(n);
  if (!leaf) return null;

  const ci = isCaseInsensitiveFs();
  let entries;
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return null;
  }
  const slug = entries.find((e) => e !== '_template' && _fold(e, ci) === _fold(leaf, ci));
  if (!slug) return null;

  const dir = join(projectsDir, slug);
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const hasArtifacts =
    existsSync(join(dir, 'session-state.md')) ||
    existsSync(join(dir, 'hot.md')) ||
    existsSync(join(dir, 'session-log'));
  if (!hasArtifacts) return null;

  const indexPath = join(dir, 'index.md');
  const hasIndex = existsSync(indexPath);
  let workingDir = null;
  if (hasIndex) {
    try {
      const fmBlock = readFileSync(indexPath, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const line = fmBlock && fmBlock[1].split(/\r?\n/).find((l) => /^working_dir:/.test(l));
      if (line) {
        workingDir = line
          .slice('working_dir:'.length)
          .trim()
          .replace(/\s+#.*$/, '')
          .replace(/^['"]|['"]$/g, '');
      }
    } catch {
      workingDir = null;
    }
  }
  if (hasIndex && workingDir) return null; // already anchored — not a backfill case

  return { slug, hasIndex };
}

/**
 * When the session cwd is a project working_dir distinct from the vault root,
 * the wiki/knowledge files live in the VAULT, not in this cwd. SessionStart and
 * CwdChanged inject hot.md/session-state content but never the vault's absolute
 * path, so the AI re-discovers it each session and can wrongly conclude a wiki
 * file is missing after checking only the code repo (a real misjudgment seen in
 * a dev-repo session, 2026-06-23).
 *
 * Returns a one-line "look in the vault, not here" orientation carrying the
 * absolute vault path, or '' when cwd is anywhere inside the vault tree (the
 * "wiki files live in the vault, not here" framing would be false there) or
 * hypoDir is unset. The HIT matcher is prefix-based, so a project whose
 * working_dir is the vault root can match a vault SUBDIRECTORY; checking only
 * exact root-equality would wrongly fire for those. Compared via realpath so a
 * symlinked cwd or vault still matches.
 *
 * Containment uses the SAME normalize + case-fold + prefix policy as
 * pickProjectByCwd so the two never disagree: on a case-insensitive FS the
 * matcher case-folds, so a cwd differing only in case is still a HIT and must be
 * suppressed here too (otherwise a false orientation leaks).
 *
 * @param {string} cwd  the session cwd (already known to be a project HIT)
 * @param {string} [hypoDir=HYPO_DIR]
 * @param {{caseInsensitive?: boolean}} [opts]  override FS case policy (tests)
 * @returns {string}
 */
export function buildVaultOrientation(cwd, hypoDir = HYPO_DIR, opts = {}) {
  if (!cwd || !hypoDir) return '';
  const { caseInsensitive = isCaseInsensitiveFs() } = opts;
  let realCwd = cwd;
  let realVault = hypoDir;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    /* keep raw path when cwd is unreadable */
  }
  try {
    realVault = realpathSync(hypoDir);
  } catch {
    /* keep raw path when vault is unreadable */
  }
  // Suppress when cwd is the vault root OR a descendant of it.
  const c = _fold(normalizeWorkingDir(realCwd) || '', caseInsensitive);
  const v = _fold(normalizeWorkingDir(realVault) || '', caseInsensitive);
  if (!c || !v) return '';
  if (c === v || c.startsWith(`${v}/`)) return '';
  return (
    `[WIKI VAULT: ${hypoDir}] 이 cwd는 작업/코드 레포이고 vault가 아니다. ` +
    `wiki·knowledge·세션로그 파일은 여기가 아니라 vault(${hypoDir})에서 조회한다.`
  );
}

// resume/close entry: match `slugs` against cwd via the two-tier matcher.
// Uniqueness is judged over EVERY project on disk, not just `slugs`. close
// callers pass no cwd, so it stays inert for them.
function pickByCwd(hypoDir, slugs, cwd) {
  if (!cwd) return null;
  let realpathCwd = null;
  try {
    realpathCwd = realpathSync(cwd);
  } catch {
    realpathCwd = null;
  }
  return pickProjectByCwd(collectProjectWorkingDirs(hypoDir), cwd, {
    eligible: slugs,
    realpathCwd,
  });
}

/**
 * Resolve the active project slug from root hot.md. With a cwd, a project whose
 * working_dir contains it wins (cwd-first); otherwise the
 * most-recently-active row is returned.
 * The cwd helpers (parseFrontmatterField / pickByCwd) and the cwd-first body
 * are kept in sync with scripts/resume.mjs by hand; the surrounding wrapper
 * intentionally differs (resume.mjs adds an mtime fallback, this does not).
 * `cwd` is an optional cwd-first selector: a cwd↔working_dir match
 * wins over recency. resume passes process.cwd(); session-close callers
 * (sessionCloseFileStatus / closeFileTargets) intentionally pass null — close
 * has a different authority (payload.project / freshness, the global invariant),
 * so it never picks by cwd. When cwd is omitted, behavior is
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
    // cwd-first: a cwd↔working_dir match wins over recency, across
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
 *     (daily shard; legacy YYYY-MM.md is still accepted as fallback)
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

  // session-log: daily shard, with legacy monthly fallback: must
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

// ── global session-close gate ────────────────
// The no-payload close paths must NOT pick one project (recency / cwd) and check
// it — that re-derivation is the prior session-close false-block, and a cwd
// tie-break here would let a fresh cwd mask a DIFFERENT project's dangling
// close. Instead the gate enforces a global invariant: no project may end a
// session with a partial close. resume stays cwd-positive; close
// never picks. The two copies of resolveActiveProject share the cwd-first body
// but the resume.mjs copy adds an mtime fallback this one omits — see resume.mjs.

// Root hot.md Active-Projects rows as {slug, date}. The per-row date column is
// project-scoped (unlike the shared frontmatter `updated:`). Used for candidate
// DISCOVERY in closeCandidateSlugs, not as close-activity evidence: the row date
// was dropped as an activity signal because project-create and
// hypo-hot-rebuild both stamp rows today without a real session. Mirrors
// resolveActiveProject's regex.
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
      // Capture the slug up to the first whitespace OR colon so both canonical
      // log delimiters resolve to the same bare slug: `session | beta — t` and
      // `session | beta: t` both yield `beta`. This parser shares the
      // colon-delimiter contract with hasLogEntry, so a colon-form entry for a
      // real project is a close candidate, not a ghost. `[^\s:]+` cannot span
      // the colon, so a stale/typo heading still yields a token that fails the
      // on-disk directory gate below.
      const re = new RegExp('^## \\[' + escapeRegExp(d) + '\\] session \\| ([^\\s:]+)', 'gm');
      for (const m of content.matchAll(re)) {
        // B-1: only real projects are close candidates. A stale or misspelled
        // slug yields a token that no longer maps to a `projects/<slug>/`
        // directory — gating on disk keeps it out of the dangling-close set.
        // Directory (not bare-exists) mirrors the apply-path project check
        // (crystallize.mjs:193).
        const dir = join(projectsDir, m[1]);
        if (existsSync(dir) && statSync(dir).isDirectory()) slugs.add(m[1]);
      }
    }
  }
  return slugs;
}

// True when project P shows an AUTHORITATIVE today close-activity signal: a
// today-dated session-log heading, or a today-dated `## [today] session | P`
// log.md entry. These are written ONLY by a real session close (apply, or its
// auto-derived root log).
//
// Soft state files are EXCLUDED, because each is bumped to today by
// non-session tooling and is therefore indistinguishable from a real close:
//   - session-state.md `updated:`  — tracker bookkeeping mirrors a new item into
//     the "next tasks" section (a cross-block incident: editing one project's
//     tracker bumped session-state and blocked an unrelated project's /compact).
//   - project hot.md `updated:`    — project-create stamps the template `updated: today`.
//   - root hot.md ROW date         — project-create inserts a today-dated row, and
//     hypo-hot-rebuild defaults a row to today when a project hot.md is missing.
// (Root hot.md *frontmatter* was already never a signal — it is shared and
// hypo-hot-rebuild stamps it today every session.)
//
// Tradeoff (documented, accepted): apply writes session-state.md FIRST, then the
// project files, then the session-log + log entry. A process crash before the
// session-log write leaves a torn close that this gate no longer flags. Accepted:
// a torn close never reached apply's ok=true so it wrote no marker;
// the surviving session-state is the resume pointer the next session overwrites;
// what is lost is a narrative log entry, not continuity.
function hasTodayCloseActivity(hypoDir, project, dates) {
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
  return false;
}

/**
 * Global session-close status for the no-payload close paths.
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
export function sessionCloseGlobalStatus(hypoDir, opts = {}) {
  // projectOverride (check-only): the caller (`crystallize --check-session-close
  // --project=<slug>`) wants THIS project's close status, not the recency pick —
  // bypass discovery and report the single project, preserving the global return
  // shape. NEVER threaded from a marker-writing path (--mark / apply auto-marker /
  // PreCompact): those stay global so the marker == compact-ready invariant holds
  // (codex design review). A green status here is a project-scoped
  // diagnostic, not the global compact-readiness verdict.
  if (opts.projectOverride) {
    const s = sessionCloseFileStatus(hypoDir, { projectOverride: opts.projectOverride });
    return {
      ok: s.ok,
      projects: s.project
        ? [{ project: s.project, ok: s.ok, stale: s.stale, missing: s.missing }]
        : [],
      dates: freshDates(),
      fallback: false,
      primary: s.project,
      project: s.project,
      stale: s.stale,
      missing: s.missing,
    };
  }
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
// here: it is a proof artifact the close gate actually ran.
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
 * Build the canonical root log.md entry for ONE session-log heading. Single
 * source of truth for the derived-entry format, shared by the global Stop-hook
 * derive (deriveRootLogEntries) and apply's direct per-close write (B-1), so the
 * two paths never drift on the `→ [[projects/<slug>/hot]]` pointer or spacing.
 * `headingTail` is the text AFTER `## [date]` in the authored session-log heading.
 * @returns {{ heading: string, block: string }} heading = the `## [date] session
 *   | <slug>` line used for exact-line dedup; block = the full two-line entry.
 */
export function rootLogEntry(slug, date, headingTail) {
  const title = deriveLogTitle(headingTail);
  const heading = `## [${date}] session | ${slug}` + (title ? ` — ${title}` : '');
  return { heading, block: `${heading}\n→ [[projects/${slug}/hot]]` };
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
// ── append-only file lock ───────────────────────────────────────────────────
// Serializes the read → dedup → rebuild → temp+rename sequence on append-only
// history files (session-log shards, log.md) so two concurrent session closes
// never lose an entry. The lock does NOT replace the existing write-isolation:
// each writer still rebuilds the full content and commits via atomicWrite
// (temp write + rename), so a partial write lands on a throwaway temp and the
// target is never torn. The lock only makes the read-modify-write exclusive, so
// the second closer re-reads the first's committed bytes and appends onto them
// (last-writer-wins can no longer drop the earlier entry), and exact-entry dedup
// becomes precise rather than best-effort.
//
// Why not O_APPEND: an in-place append that short-writes (ENOSPC / EDQUOT /
// RLIMIT_FSIZE / a split write() killed mid-loop) leaves a torn dated heading on
// the real file that the freshness gate mis-reads as valid close evidence, and
// it cannot be rolled back once a concurrent appender has written past it. That
// is a normal-operation regression temp+rename does not have (a failed temp
// write never runs the rename, so the target stays untouched). Confirmed against
// Node/libuv write-loop behavior and POSIX write(2) partial-write semantics.
//
// Local-FS only: `openSync(lock, 'wx')` is not atomic on NFS — the same caveat
// the vault already carries. Power-loss durability is unchanged from today
// (atomicWrite never fsync'd), so it is out of scope here.
function sleepSync(ms) {
  // Synchronous sleep with no busy-spin: block this thread on an Atomics.wait
  // against a private SharedArrayBuffer that is never signaled, so it always
  // times out after `ms`. Hooks run in a short-lived sync context.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
}

// Commit `content` via temp write + rename so a partial/failed write lands on a
// throwaway temp and the target is never torn (mirrors crystallize.mjs's
// atomicWrite). Rename atomicity swaps the directory entry; it is NOT power-loss
// durable (no fsync) — same as everything else in the vault.
function atomicWriteShared(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Run `fn` while holding an exclusive lock on `<targetPath>.lock`.
 *
 * Acquire is a spin on `openSync(lock, 'wx')`: EEXIST means another writer holds
 * it, so poll until it frees. A lock whose holder looks dead (mtime older than
 * `staleMs`) is stolen. Steal is recoverable friction in the normal case (the
 * stealer re-reads the committed bytes before writing), but NOT loss-free in two
 * edge cases, both requiring the lock to sit untouched for `staleMs`: (1) a LIVE
 * holder preempted past `staleMs` gets stolen from, so two writers run the
 * critical section and one update is lost; (2) between the stale `statSync` and
 * the `unlinkSync`, the holder can release and a fresh holder grab the same path,
 * whose lock we then remove. `staleMs` is set well above a normal close (seconds)
 * to make both extreme-low-probability. If the lock cannot be acquired within
 * `timeoutMs`, throw so the caller can fall back to the write=proposal gate
 * (architecturally consistent with the existing fail-safe).
 *
 * @param {string} targetPath file being guarded (lock is a sibling `.lock`)
 * @param {() => T} fn critical section
 * @param {{timeoutMs?: number, staleMs?: number, pollMs?: number}} [opts]
 * @returns {T} whatever `fn` returns
 * @template T
 */
export function withFileLock(targetPath, fn, opts = {}) {
  const { timeoutMs = 5000, staleMs = 30000, pollMs = 50 } = opts;
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Held by another writer. Steal ONLY a demonstrably stale lock; otherwise
      // wait and eventually time out. The stat and the unlink are handled
      // separately on purpose: an un-removable stale lock (EACCES/EPERM/EBUSY)
      // and a fresh lock must both fall through to the timeout check — never
      // `continue` past it, or an un-unlinkable lock spins forever and violates
      // the timeoutMs → ELOCKTIMEOUT contract (caller falls to the proposal gate).
      let stale = false;
      try {
        // Steal a lock whose holder looks dead. Loss-free unless the holder is
        // actually live-but-preempted past staleMs (see JSDoc edge cases).
        stale = Date.now() - statSync(lockPath).mtimeMs > staleMs;
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // lock vanished; retry create now
        throw statErr; // unexpected stat failure — surface it, don't mask
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
          continue; // stole it; retry the create immediately
        } catch (unlinkErr) {
          if (unlinkErr.code === 'ENOENT') continue; // another stealer won; retry
          // Cannot remove it: do NOT spin — fall through to timeout/sleep so
          // acquisition eventually throws ELOCKTIMEOUT instead of hanging.
        }
      }
      if (Date.now() - start > timeoutMs) {
        // Tagged so callers can distinguish "could not get the lock" (fall to the
        // proposal gate) from a real fn() write error (mkdir/openSync/disk-full),
        // which must NOT be masked as a timeout.
        const e = new Error(`lock-timeout: ${lockPath}`);
        e.code = 'ELOCKTIMEOUT';
        throw e;
      }
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already gone */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* lock already stolen/removed */
    }
  }
}

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
        const { heading, block } = rootLogEntry(slug, date, m[1]);
        if (seenHeadings.has(heading)) continue; // exact-line dedup (log.md + queued)
        seenHeadings.add(heading);
        additions.push({ heading, block });
      }
    }
  }

  if (additions.length === 0) return 0;

  // Serialize the read-modify-write on log.md: a concurrent session close (its
  // own crystallize apply, or another project's derive) may commit between the
  // read above and the write below. Under the lock we RE-READ the latest
  // committed log.md and re-run exact-heading dedup, so this derive appends onto
  // the other writer's entry instead of a full-file overwrite dropping it. The
  // same lock guards crystallize.mjs's per-close log.md append, so the two
  // paths never race. On lock-timeout, skip (best-effort backfill; the next
  // close re-derives) rather than risk a lost update.
  try {
    return withFileLock(logPath, () => {
      let current;
      try {
        current = readFileSync(logPath, 'utf-8');
      } catch {
        return 0;
      }
      const seen = new Set((current || '').split(/\r?\n/));
      const fresh = additions.filter(({ heading }) => {
        if (seen.has(heading)) return false;
        seen.add(heading);
        return true;
      });
      if (fresh.length === 0) return 0;
      const sep = current.endsWith('\n') ? '\n' : '\n\n';
      atomicWriteShared(logPath, current + sep + fresh.map((a) => a.block).join('\n\n') + '\n');
      return fresh.length;
    });
  } catch {
    // lock-timeout or unexpected lock error: skip this backfill pass.
    return 0;
  }
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
 * @param {'pull'|'push'|'conflict'|'conflict-unresolved'} op  'conflict' = a
 *   merge conflict was detected and aborted (the tree was left clean at the
 *   local commit); 'conflict-unresolved' = the abort itself failed and the tree
 *   may still be half-merged (rare). See syncRemote.
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
 * Pull + push the wiki against its remote, guaranteeing the working tree is
 * never left half-merged. Called by the auto-commit Stop hook after a local
 * commit succeeds.
 *
 * Failure policy (v1.4 "sync hardening"):
 *   - clean fast-forward / conflict-free merge → push.
 *   - MERGE CONFLICT (`git pull --no-rebase` leaves unmerged paths): abort the
 *     merge so the tree returns to the just-committed local state ("ours"),
 *     record op='conflict', and do NOT push (a diverged branch cannot
 *     fast-forward, so the push would only add a noisy second failure). No data
 *     is lost: ours stays committed locally, "theirs" stays on the remote, and
 *     the divergence is surfaced by session-start + doctor until the user merges
 *     manually. Inline auto-resolution (preserving the losing version as a
 *     `.conflict-*` sibling) is deferred.
 *   - non-conflict pull failure (network/auth: no unmerged paths) → record
 *     op='pull', then still attempt push (a transient pull blip should not block
 *     an otherwise-pushable commit); record op='push' if that also fails.
 *
 * Best-effort: never throws — a sync failure must not break the Stop hook.
 *
 * @param {string} hypoDir
 * @returns {{pulled: boolean, pushed: boolean, conflict: boolean}}
 */
export function syncRemote(hypoDir) {
  const git = (...args) =>
    spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', timeout: 30000 });
  const result = { pulled: false, pushed: false, conflict: false };
  try {
    const pull = git('pull', '--no-rebase', '-q');
    if (pull.status === 0) {
      result.pulled = true;
    } else {
      // A merge conflict leaves unmerged index entries; a network/auth failure
      // leaves none. Only the former must be aborted to keep the tree clean.
      const unmerged = git('ls-files', '-u');
      const hasConflict = unmerged.status === 0 && (unmerged.stdout || '').trim().length > 0;
      if (hasConflict) {
        // Abort to return the tree to the just-committed local state. Verify the
        // abort actually cleaned up: if it fails (filesystem/concurrent-mutation
        // edge), the tree may still be half-merged, so record that distinctly
        // ('conflict-unresolved') rather than masking it as a clean abort.
        const abort = git('merge', '--abort');
        const stillUnmerged = git('ls-files', '-u');
        const aborted = abort.status === 0 && (stillUnmerged.stdout || '').trim().length === 0;
        appendSyncFailure(
          hypoDir,
          aborted ? 'conflict' : 'conflict-unresolved',
          pull.stderr || pull.stdout,
        );
        result.conflict = true;
        return result; // do not push from a diverged branch
      }
      appendSyncFailure(hypoDir, 'pull', pull.stderr || pull.stdout);
    }
    const push = git('push');
    if (push.status === 0) result.pushed = true;
    else appendSyncFailure(hypoDir, 'push', push.stderr || push.stdout);
  } catch {
    // best-effort — never break the Stop hook
  }
  return result;
}

/**
 * Stage + commit every non-.hypoignore change in the wiki. Does NOT pull/push —
 * remote sync stays in the auto-commit Stop hook (commit is local + cheap; sync is
 * network + soft-fail). Shared by hypo-auto-commit.mjs and crystallize.mjs's
 * --apply-session-close path so the .hypoignore staging filter cannot diverge
 * between the two commit loci.
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

// ── auto-project suggestion ────────────────────────────────────────
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

// Shared cooldown/skip gate for BOTH the new-project offer and the backfill
// offer below — same store (.cache/project-suggestions.json), same key (cwd),
// so a user who just answered one kind of offer for a cwd doesn't immediately
// get re-prompted with the other. A corrupt store stays silent (doctor
// surfaces the malformation separately).
function suggestionNotSuppressed(cwd, hypoDir, now) {
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
 * Decide whether SessionStart/CwdChanged should offer to create a project for
 * `cwd`. The caller MUST have already confirmed `cwd` matches no project's
 * `working_dir` (the hook's MISS branch); this evaluates the remaining
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
  return suggestionNotSuppressed(cwd, hypoDir, now);
}

/**
 * Decide whether SessionStart/CwdChanged should offer to BACKFILL a
 * working_dir anchor for `cwd`. The caller MUST have already located a
 * findBackfillCandidate() match; this only applies the same cooldown/skip
 * gate shouldSuggestProjectCreation uses, so the two offers share one
 * suppression store. No git/marker gate here — the project directory
 * already existing is itself the trigger condition.
 *
 * @param {string} cwd
 * @param {string} [hypoDir]
 * @param {number} [now] epoch ms, injectable for tests
 * @returns {boolean}
 */
export function shouldSuggestBackfill(cwd, hypoDir = HYPO_DIR, now = Date.now()) {
  if (!cwd) return false;
  return suggestionNotSuppressed(cwd, hypoDir, now);
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

// Neutralize a PATH value for additionalContext injection without truncating
// it — unlike sanitizeProjForPrompt (built for a short display name), a path
// must render in full or the backfilled working_dir would be wrong. Only
// newline/control chars are stripped (the injection vector); everything else,
// including shell metacharacters, passes through untouched because this value
// is NEVER assembled into a runnable command (see buildBackfillSuggestionLine)
// — it is purely descriptive text for the LLM/user to read.
function stripControlCharsForPath(raw) {
  // Per-codepoint (not a regex escape range) so no control byte is written
  // literally into this source file (the source-corruption trap hit earlier
  // in this same change). Mirrors sanitizeProjForPrompt's coverage EXACTLY —
  // C0 (0x00-0x1F), DEL+C1 (0x7F-0x9F, which folds in U+0085 NEL), and the
  // U+2028/U+2029 line separators. Deliberately does NOT strip bidi format
  // controls: sanitizeProjForPrompt doesn't either, and matching its exact
  // decision (rather than inventing a wider one here) is the principled
  // choice so the two sanitizers never silently diverge in coverage.
  return Array.from(String(raw == null ? '' : raw))
    .map((ch) => {
      const code = ch.codePointAt(0);
      const isC0OrDelOrC1 = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      const isLineSep = code === 0x2028 || code === 0x2029;
      return isC0OrDelOrC1 || isLineSep ? ' ' : ch;
    })
    .join('');
}

/**
 * Build the working_dir-backfill offer line for a cwd that names an EXISTING
 * `projects/<slug>/` directory (findBackfillCandidate already confirmed it
 * carries session artifacts but no anchor). `slug` (short, display-only)
 * routes through sanitizeProjForPrompt; `cwd` (a real path that must not be
 * corrupted) routes through stripControlCharsForPath instead — truncating a
 * path would silently backfill the WRONG working_dir. Neither branch
 * assembles a runnable shell command from either value (codex pre-commit
 * review: embedding untrusted path/slug text into a copy-paste `node ...`
 * invocation is a shell-injection vector); both branches are purely
 * descriptive guidance for the LLM/user to act on.
 *
 * The two cases still need different WORDING: a MISSING index.md has nothing
 * to edit yet, so the offer describes creating a fresh one anchored to the
 * current cwd (the agent constructs the actual project-create.mjs invocation
 * itself, safely, outside this string). An index.md that already EXISTS but
 * simply omits working_dir needs a direct frontmatter addition instead.
 *
 * @param {string} slug the matching projects/<slug>/ directory name
 * @param {string} cwd the session cwd (the value that would become working_dir)
 * @param {boolean} hasIndex whether projects/<slug>/index.md already exists
 * @returns {string}
 */
export function buildBackfillSuggestionLine(slug, cwd, hasIndex) {
  const safeSlug = sanitizeProjForPrompt(slug);
  const safeCwd = stripControlCharsForPath(cwd);
  const action = hasIndex
    ? `projects/${safeSlug}/index.md의 frontmatter에 working_dir: ${safeCwd}를 추가할까요?`
    : `projects/${safeSlug}/index.md가 없습니다. 현재 세션의 cwd(${safeCwd})를 working_dir로 삼아 index.md를 새로 만들까요?`;
  return `[WIKI: cwd가 기존 프로젝트 'projects/${safeSlug}/'와 이름이 일치하지만 working_dir 앵커가 없습니다. ${action} (Y/n)]`;
}

// ── clear-marker (amendment 2026-05-14) ──────────────────────
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
 * can issue a recovery nudge. Single-file by design (see the amendment):
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

// ── session-closed marker (amendment 2026-05-19) ─────────────
// Per-session marker proving session-close completed. Stop hook
// (`hypo-auto-minimal-crystallize`) reads it; `scripts/crystallize.mjs` writes
// it after a verified close. Per-session (not per-day) precision resolves the
// codex BLOCKER from 2026-05-14: log.md date-level check false-passes when a
// later session reuses an earlier session's entry on the same day.
//
// Writer authority lives in crystallize, NOT this hook: the hook only checks
// presence. See amendment 2026-05-19 Q2 for the split rationale.

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

// ── transcript activity heuristic (amendment 2026-05-19; 6a 2026-06-14) ─────────
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
 * Union of the close files over every today-active project
 * (fallback: the recency project when none is active). Includes the session-log
 * evidence file for EVERY freshDate (not just dates[0]) so the lint scope matches
 * what sessionCloseFileStatus actually checks across a local/UTC date boundary.
 */
// The lint-scope target set for ONE project's close: the shared root files
// (hot.md / log.md) plus that project's mandatory close files — session-state,
// project hot, and each fresh date's session-log evidence file. Used both by
// `--check-session-close --project=<slug>` (a project-scoped diagnostic — see
// precompactGateStatus opts.projectOverride) and as the per-project building
// block of closeFileTargetsGlobal, so the two scopes stay identical per project.
export function closeFileTargetsForProject(hypoDir, slug) {
  const dates = freshDates();
  const out = new Set(['hot.md', 'log.md']);
  out.add(`projects/${slug}/session-state.md`);
  out.add(`projects/${slug}/hot.md`);
  // Scope to the file each date's freshness is PROVEN by (daily shard or, via
  // fallback, the legacy monthly), so a corrupt evidence file can't pass the
  // gate while its lint error is demoted to an out-of-scope notice.
  for (const d of dates) out.add(sessionLogScopePath(hypoDir, slug, d));
  return out;
}

export function closeFileTargetsGlobal(hypoDir) {
  const dates = freshDates();
  const out = new Set(['hot.md', 'log.md']);
  let active = [...closeCandidateSlugs(hypoDir, dates)].filter((p) =>
    hasTodayCloseActivity(hypoDir, p, dates),
  );
  // No project closed today → fall back to the recency project (mirrors
  // sessionCloseGlobalStatus's own fallback at the top of this file), so the lint
  // scope never narrows below the close-status scope. Dropping this (root-only
  // when active=[]) would re-open the very gap closeFileTargetsForProject closes.
  if (active.length === 0) {
    const recency = resolveActiveProject(hypoDir);
    if (recency) active = [recency];
  }
  for (const p of active) {
    for (const f of closeFileTargetsForProject(hypoDir, p)) out.add(f);
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

/**
 * True if a repo-relative file lives under any of the given project dirs
 * (`projects/<slug>/...`, or the dir itself). Both surfaces that surface
 * pre-existing lint-debt NOTICES use this to decide what to LIST vs fold: debt
 * under a close-target project is the close's own neighborhood and stays listed;
 * debt elsewhere (other projects, shared `pages/`, root `hot.md`/`log.md`) folds
 * to a count so the same untouched-file debt does not re-list its filenames on
 * every close. Same path policy as the lint-scope matcher above: separators
 * normalized to POSIX, exact prefix at a segment boundary.
 */
export function isUnderProjectDirs(file, slugs) {
  const f = posixPath(file);
  return (slugs || []).some((s) => s && (f === `projects/${s}` || f.startsWith(`projects/${s}/`)));
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
 * the hook self-heals it with `feedback-sync --write` before continuing,
 * and a verify caller needs no human action for it. over-cap and conflict
 * DO block (human demote/import required).
 *
 * Faithfulness caveats (why "compact-ready", not "guaranteed pass"): the hook
 * has paths outside this status — a context-≥70% early block, HYPO_SKIP_GATE
 * bypass, and a fail-closed if the self-heal `--write` itself errors. And without
 * a transcript the lint scope is the mandatory close files only; pass
 * opts.transcriptPath to widen it to the session's edited files exactly as the
 * hook does.
 *
 * opts.projectOverride (CHECK-ONLY) narrows BOTH the close status and the lint
 * scope to a single project, for `--check-session-close --project=<slug>`. A
 * green result is then a project-scoped diagnostic, NOT the global compact-ready
 * verdict: the caller must surface the scope. It is NEVER passed from
 * a marker-writing path (--mark / apply auto-marker / PreCompact); those stay
 * global so a marker can't attest compact-ready while PreCompact re-checks red
 * (the marker == compact-ready invariant, codex design review). When a
 * log-only marker governs the session, log-only mode wins and projectOverride is
 * ignored.
 *
 * @param {string} hypoDir
 * @param {{lintScope?: Iterable<string>, transcriptPath?: string|null, claudeHome?: string, projectOverride?: string|null}} [opts]
 * @returns {{ok: boolean, close: object, blockers: {type:string,reason:string}[], notices: {type:string,reason:string,file?:string}[], driftTargets: string[], skipped: {lint:boolean, feedback:boolean}}}
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

  // 1. wiki git state. Uncommitted changes (real unsaved work) BLOCK:
  //    they are human-fixable. Unpushed commits (ahead) DEMOTE to a notice: push is
  //    automatic (auto-commit Stop hook) and its failures are already non-fatal, so
  //    "ahead" is a transient sync state, not a human-fixable blocker. Demoting it
  //    here (the shared gate) keeps the marker == compact-ready invariant:
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

  // 3. session-close files (global invariant); in log-only mode,
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
    // projectOverride narrows the close status to one project (check-only); a
    // marker-writing caller never sets it, so the marker path stays global.
    close = sessionCloseGlobalStatus(hypoDir, { projectOverride: opts.projectOverride });
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
      // Lint scope: explicit opts.lintScope wins; else log-only uses the shared
      // root files only; else projectOverride narrows to that one project's close
      // files (matching the narrowed close status above); else the global set.
      const scope = new Set(
        opts.lintScope ||
          (logOnly
            ? ['hot.md', 'log.md']
            : opts.projectOverride
              ? closeFileTargetsForProject(hypoDir, opts.projectOverride)
              : closeFileTargetsGlobal(hypoDir)),
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
        notices.push({
          type: 'lint',
          file: n.file,
          reason: `${n.file}${n.id ? ` (${n.id})` : ''}`,
        });
      // W8 (design-history stale) is each today-active project's own close
      // responsibility; others' are non-blocking notices. In log-only
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
      for (const w of w8Notice)
        notices.push({ type: 'design-history', file: w.file, reason: w.file });
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

  // 5. feedback projection. over-cap/conflict block; pure
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

/** Returns true if the prompt is either /compact or /clear (Layer 2). */
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
          // Skill-injection vector: drop system-injected role:user
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
    // 세션 마무리/종료: the OLD pattern required a fixed verb suffix
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
    // + signal) and the unambiguous /compact and AskUserQuestion channels (threat
    // boundary), not chased further.
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
    // Leading \b on each pattern so an EN close phrase embedded as a
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
 * Fail-closed on ambiguity (codex review): returns the single resolved
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
 * the hard gate for the session-closed marker writers. Scans the FULL
 * transcript: a close request can precede the marker write by the entire close
 * checklist, so the Stop hook's 30-line tail would miss it.
 *
 * Evidence (any one is sufficient):
 *   1. a de-polluted NL close phrase — isClosePattern over extractUserMessages,
 *      which already drops injected / tool / hook-feedback text;
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
 * True iff the Stop payload shows work still pending in the background —
 * either a non-terminal `background_tasks` entry OR a scheduled `session_crons`
 * wake. Read-only: used to widen the autoclose reconfirm trigger (see
 * hypo-auto-minimal-crystallize.mjs) to "work is demonstrably still running",
 * not just "the wiki has uncommitted changes".
 *
 * ANY non-terminal `background_tasks` entry counts, not just delegated
 * subagents. A Stop payload captured from a real session confirmed the field
 * is genuinely sent (the older "grep turns up nothing / may not be sent" note
 * is retired): a background Bash appears as
 * `{id, type:'shell', status:'running', description, command}`, alongside
 * `type:'subagent'` for delegations. Restricting to `type==='subagent'` missed
 * shell background work (e.g. a `git push` / CI wait deferred behind a close
 * signal), letting the reconfirm branch mis-classify the session as idle and
 * re-nag every Stop turn.
 *
 * Defined as the NEGATION of a terminal status, not an enumeration of
 * "running" states: the observed non-terminal status is "running", and a
 * finished task is removed from the array entirely (it does NOT linger in a
 * terminal state — the next Stop simply reports `background_tasks:[]`). An
 * unrecognized/absent status is therefore treated as in-flight; only a
 * recognized terminal status clears an entry that is still present.
 *
 * `session_crons`: a non-empty array means the session is waiting on a
 * scheduled wake, which is itself pending work. A missing / non-array
 * `session_crons` is ignored (fail-open).
 *
 * Fail-open overall: a missing or non-array `background_tasks` contributes no
 * pending signal, so detection degrades gracefully to the git-uncommitted
 * signal alone rather than spuriously blocking.
 */
export function hasPendingBackgroundWork(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const TERMINAL = /^(completed|complete|done|finished|failed|error|errored|cancelled|canceled)$/i;
  const tasks = payload.background_tasks;
  if (
    Array.isArray(tasks) &&
    tasks.some((t) => t && (t.status == null || !TERMINAL.test(String(t.status))))
  ) {
    return true;
  }
  const crons = payload.session_crons;
  if (Array.isArray(crons) && crons.length > 0) return true;
  return false;
}

// The reconfirm reason (hypo-auto-minimal-crystallize.mjs emitBlock's
// reconfirm branch) instructs the close-now option under this exact label —
// used below to correlate an AskUserQuestion tool_use to OUR close-reconfirm
// prompt specifically, not just any AskUserQuestion the model happens to ask.
// Exported so the hook builds its reason text off this SAME literal instead
// of a second hardcoded copy: two independent literals would let a reworded
// reason silently break this correlation with no test to catch it.
export const CLOSE_RECONFIRM_MARK = '지금 닫기';

/**
 * True iff the LATEST correlated AskUserQuestion answer in the transcript
 * declined an autoclose reconfirm prompt ("아직" / "나중" / "not yet" /
 * "later") — order-sensitive so a decline is suppressed again once the user
 * signals a NEW close intent afterward (re-arm).
 *
 * Read-only, forward scan over the FULL transcript (no tail truncation — a
 * decline can precede the next Stop by any number of turns). Reuses the same
 * askIds + tool_use_id correlation `hasUserCloseSignal` (above) uses to bind
 * an AskUserQuestion answer to its own tool_use, so an unrelated tool_result
 * string can't forge a decline. Unlike `hasUserCloseSignal` (which is a
 * "any evidence, ever" OR), this tracks a single latest-wins boolean as it
 * scans: a decline answer sets it true, and any later GENUINE USER close
 * signal resets it to false — the user asked to close again, so the prior
 * decline no longer applies.
 *
 * Two correlation guards (the same input-boundary concern class as
 * extractUserMessages' tool_result/injection exclusion above):
 *
 *  1. Re-arm is gated to a real user-typed close signal ONLY — mirrors
 *     extractUserMessages' own boundary filter (isMeta / promptSource
 *     system|sdk / tool_result exclusion, see extractUserMessages above)
 *     instead of re-deriving a separate policy. Without this, the MODEL'S
 *     OWN assistant reasoning text (which can itself contain "세션 마무리"),
 *     or a tool_result (e.g. a Read of a file that happens to quote a close
 *     phrase), could silently clear a recorded decline and re-nag the user
 *     who already said "아직" — the opposite of what a decline means.
 *  2. The AskUserQuestion tool_use is only added to `askIds` when its input
 *     carries CLOSE_RECONFIRM_MARK — i.e. it IS the close-reconfirm prompt,
 *     not some unrelated question the model asked around the same time. An
 *     unrelated question whose answer happens to contain a decline word
 *     ("나중"/"later") must not correlate.
 *
 * Fail-open: a missing/unreadable transcript → false (do not suppress; keep
 * reconfirming) — the caller stays on the safe (nag, not silent-close) side.
 */
export function isCloseReconfirmDeclined(transcriptPath) {
  if (!transcriptPath) return false;
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf-8').split('\n');
  } catch {
    return false;
  }
  const DECLINE = /(아직|나중|not\s?yet|later)/i;
  const askIds = new Set();
  let declined = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj.message ?? obj;
    const content = msg.content ?? obj.content;

    // Re-arm boundary (guard 1): only a genuine user-typed close signal may
    // re-arm. Same exclusions as extractUserMessages — isMeta injection,
    // system/sdk synthetic prompts, and (via the array-content branch below)
    // tool_result blocks, which are role:'user' in the transcript but are NOT
    // user-typed text.
    const isInjected = obj.isMeta === true || obj.promptSource === 'system' || obj.promptSource === 'sdk';
    const role = msg.role ?? obj.role ?? obj.type;
    if (!isInjected && role === 'user') {
      if (typeof content === 'string') {
        if (!content.startsWith('Stop hook feedback') && isClosePattern(content)) declined = false;
      } else if (Array.isArray(content)) {
        for (const b of content) {
          // Only type:'text' blocks are genuine user-typed text — a
          // tool_result block (also role:'user') is tool output, not
          // something the user typed, and must not re-arm.
          if (b && b.type === 'text' && typeof b.text === 'string' && isClosePattern(b.text)) {
            declined = false;
          }
        }
      }
    }

    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.name === 'AskUserQuestion' && b.id) {
        // Correlation guard 2: only OUR close-reconfirm prompt counts.
        const inputStr = JSON.stringify(b.input ?? null);
        if (inputStr.includes(CLOSE_RECONFIRM_MARK)) askIds.add(b.id);
        continue;
      }
      if (b.type === 'tool_result' && b.tool_use_id && askIds.has(b.tool_use_id)) {
        const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        for (const m of s.matchAll(/="([^"]*)"/g)) {
          if (DECLINE.test(m[1])) declined = true;
        }
      }
    }
  }
  return declined;
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
// ends of a session. See Lane B.

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

// ── visibility scope ─────────────────────────────────────────────────────────
// The machine-scoped visibility namespace (`visibility_scope: machine:<device>`)
// requires that the SAME device string is produced at write time (audit device
// stamps) and at lookup time (the visibility filter) — otherwise a page never
// matches its own machine. So this is the single source for both. NOT cached:
// each call reads env fresh so in-process tests can override via HYPO_DEVICE
// (os.hostname is not mockable). CR/LF are stripped so the value stays a single
// frontmatter token.
export function currentDevice() {
  // Strip CR/LF BEFORE the fallback chain, not after: a HYPO_DEVICE of only
  // CR/LF is truthy, so stripping after `||` would yield '' and make
  // scopeVisible('machine:', '') pass — the empty-owner page must hide
  // everywhere. Stripping first collapses such a value to '' so it falls through
  // to hostname, keeping the result non-empty on every path.
  const env = String(process.env.HYPO_DEVICE || '').replace(/[\r\n]/g, '');
  if (env) return env;
  const host = String(hostname() || '').replace(/[\r\n]/g, '');
  return host || 'unknown';
}

// Extract the top-level `visibility_scope` from a page's raw content. Mirrors
// scripts/lib/frontmatter.mjs normalization (top-level only, first-wins, strip a
// whitespace-led trailing YAML comment, strip surrounding quotes) rather than
// importing it: hooks deploy to ~/.claude/hooks/ with no external imports. The
// five consumers must call this instead of a local last-wins/no-comment parser,
// else a `machine:devA # note` value fails to match on its own machine. Returns
// '' when absent (which scopeVisible treats as shared).
export function readVisibilityScope(raw) {
  const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || /^-(\s|$)/.test(line)) continue; // nested / list item
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() !== 'visibility_scope') continue;
    return line
      .slice(idx + 1)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
  }
  return '';
}

// The single visibility decision, shared by lookup / query / file-watch /
// page-usage / crystallize. `scopeValue` is a readVisibilityScope() output,
// `device` a currentDevice() output. Prefix dispatch, fail-open on anything
// unrecognized so the field is purely additive:
//   ''/'shared'       → visible (the implicit default of every pre-existing page)
//   'machine:<owner>' → visible only on the owning machine. Empty owner
//                       (`machine:`) hides everywhere: '' can never equal
//                       currentDevice()'s non-empty fallback.
//   'agent:<id>'      → visible; value space reserved, no writer yet (forward-compat)
//   anything else     → visible (fail-open)
export function scopeVisible(scopeValue, device) {
  const v = String(scopeValue || '').trim();
  if (v === '' || v === 'shared') return true;
  if (v.startsWith('machine:')) return v.slice('machine:'.length) === device;
  if (v.startsWith('agent:')) return true;
  return true;
}
