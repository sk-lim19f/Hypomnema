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
  const {
    eligible = null,
    realpathCwd = null,
    caseInsensitive = isCaseInsensitiveFs(),
    rejectAmbiguous = false,
  } = opts;
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

  // Tier 1: first cwd variant with any longest-prefix match wins. With
  // rejectAmbiguous (session-cwd close check), two DISTINCT projects sharing the same
  // longest matching working_dir (a monorepo config with no uniqueness invariant)
  // is a genuine tie we must NOT break arbitrarily — silently picking the first
  // would attribute a close to the wrong project and either mask a real failure
  // (false-green) or block the wrong one (false-block). Decline the tie → null,
  // so the caller degrades to the unresolved-cwd path instead of guessing.
  for (const c of cwds) {
    const cf = _fold(c, caseInsensitive);
    let bestSlug = null;
    let bestLen = -1;
    let bestTied = false;
    for (const e of entries) {
      if (!isEligible(e.slug)) continue;
      const pf = _fold(e.path, caseInsensitive);
      if (cf === pf || cf.startsWith(`${pf}/`)) {
        if (e.path.length > bestLen) {
          bestLen = e.path.length;
          bestSlug = e.slug;
          bestTied = false;
        } else if (e.path.length === bestLen && e.slug !== bestSlug) {
          bestTied = true;
        }
      }
    }
    if (bestSlug) {
      if (bestTied && rejectAmbiguous) return null;
      return bestSlug;
    }
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
  // single-slug alias for the message header and the flat `close.project` field.
  // It is NEVER an attribution source: the marker is stamped from close evidence
  // (explicit --project, transcript close-files, apply's payload.project), so this
  // recency-derived value cannot leak into a marker and back into the next gate.
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
 * `timeoutMs`, throw so the caller can fall back to the write=proposal gate — for
 * an append that means blocking the close (proposal-pending) with no artifact; the
 * next close re-appends (architecturally consistent with the existing fail-safe).
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
      recordSyncSuccess(hypoDir, 'pull');
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
    if (push.status === 0) {
      result.pushed = true;
      recordSyncSuccess(hypoDir, 'push');
    } else appendSyncFailure(hypoDir, 'push', push.stderr || push.stdout);
  } catch {
    // best-effort — never break the Stop hook
  }
  return result;
}

// ── touched-paths (scope the auto-commit to session-touched paths) ───────────
//
// The old commitWikiChanges swept the ENTIRE working tree: in a shared
// multi-project vault with concurrent Claude Code sessions, another session's
// staged/dirty files got committed and pushed by THIS session's Stop hook, and
// the human-authored commit message was clobbered. The fix is to accumulate,
// per session_id, the vault-relative paths this session actually touched, and
// have commitWikiChanges commit only that scope.
//
// Sources that feed the accumulator:
//   - hypo-auto-stage.mjs (PostToolUse): every Write/Edit/MultiEdit to a file
//     under the vault.
//   - hypo-hot-rebuild.mjs (Stop, runs BEFORE auto-commit): hot.md and log.md,
//     which are hook-generated, not user Write/Edit — without this a scope
//     built from Write/Edit alone would drop them from the scoped commit.
//
// No session_id → never accumulate, and never fall back to a shared "default"
// bucket: a path recorded under the wrong key could leak between sessions.

/** Directory holding one session's cache artifacts, incl. touched-paths.json. */
function sessionCacheDir(hypoDir, sessionId) {
  return join(hypoDir, '.cache', 'sessions', sanitizeSessionId(sessionId));
}

/** @returns {string} path to a session's accumulated touched-paths JSON array. */
export function touchedPathsPath(hypoDir, sessionId) {
  return join(sessionCacheDir(hypoDir, sessionId), 'touched-paths.json');
}

/**
 * Read the raw touched-paths JSON array off disk. Caller's responsibility to
 * hold the per-session lock first — this has no locking of its own.
 *
 * Absent and unreadable are different answers, and callers MUST branch on
 * the difference: a genuinely absent (or genuinely empty) file returns `[]`
 * — safe to treat as "nothing accumulated". A file that exists but fails to
 * read or parse returns `null` — NOT the same as empty. A caller that
 * conflates the two (codex FIX 1) and then does a set-difference clear on
 * `null`-as-`[]` will compute "nothing left" and delete the file outright,
 * silently losing every pending path to a transient I/O or parse error.
 *
 * @returns {string[]|null} the array, or `null` on a read/parse failure
 */
function readTouchedPathsFile(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p) : null;
  } catch {
    return null; // corrupt/unreadable — NOT the same as empty; see above
  }
}

/**
 * Accumulate vault-relative touched paths for `sessionId`. Best-effort,
 * dedup-on-insert, JSON array (not delimiter-joined — survives non-ASCII and
 * any byte a filename can legally hold). No-op without a session_id: never
 * accumulate into a shared bucket.
 *
 * Read-merge-write is guarded by the per-session file lock (the SAME lock
 * `drainTouchedPaths` takes), so a PostToolUse hook accumulating concurrently
 * with the Stop-chain drain can never lose a path to either a lost update
 * (two writers merging from the same stale read) or a drain racing between
 * this function's read and its write.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {string|string[]} relPaths one or more vault-relative paths
 */
export function recordTouchedPaths(hypoDir, sessionId, relPaths) {
  if (!sessionId) return;
  const incoming = (Array.isArray(relPaths) ? relPaths : [relPaths]).filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  if (incoming.length === 0) return;
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    withFileLock(path, () => {
      const current = readTouchedPathsFile(path);
      // A corrupt/unreadable file (current === null) is recovered from here,
      // not preserved: an accumulate is additive by nature (there is nothing
      // salvageable to merge with), so starting fresh from `incoming` is the
      // correct best-effort behavior — unlike clearTouchedPaths, where the
      // same `null` MUST NOT be treated as empty (see readTouchedPathsFile).
      const merged = new Set(current === null ? [] : current);
      for (const p of incoming) merged.add(p);
      atomicWriteShared(path, JSON.stringify([...merged]));
    });
  } catch {
    // best-effort: a hook must never fail a tool call over a cache write
    // (includes a lock-timeout — a dropped accumulation here is the same
    // fail-safe shape as every other best-effort cache write in this file).
  }
}

/**
 * Read and clear a session's accumulated touched paths in one step — "drain",
 * not "read", because the caller is expected to consume the WHOLE set
 * unconditionally. Kept for callers that genuinely want that (e.g. a
 * probe/inspection path); the Stop-chain auto-commit does NOT use this —
 * see commitTouchedPaths below, which holds ONE lock across a peek, the
 * commit itself, and a clear scoped to exactly what committed, so neither a
 * commit failure nor a same-path race loses anything.
 *
 * Guarded by the SAME per-session file lock every touched-paths mutation
 * takes: the read-then-remove here is mutually exclusive with a concurrent
 * accumulate or commitTouchedPaths call.
 *
 * A read/parse failure is NOT treated as an empty set to be cleared: like
 * clearTouchedPaths and commitTouchedPaths, a corrupt/unreadable file
 * (readTouchedPathsFile returns `null`) is left on disk untouched — never
 * deleted — so a transient I/O or parse error can't erase a set that a human
 * or a later pass could still recover. Drain returns `[]` in that case
 * (nothing safely consumable), but does not remove the file.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @returns {string[]} vault-relative paths, deduped; [] when absent, corrupt, or no session_id
 */
export function drainTouchedPaths(hypoDir, sessionId) {
  if (!sessionId) return [];
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const result = readTouchedPathsFile(path);
      if (result === null) return []; // corrupt/unreadable: leave the file for inspection, never delete
      try {
        rmSync(path, { force: true });
      } catch {
        // best-effort
      }
      return result;
    });
  } catch {
    // lock-timeout (or an unexpected lock error): fail closed to "nothing
    // drained" rather than risk reading concurrently with a writer. The set
    // stays on disk untouched, so it is still there for the next drain.
    return [];
  }
}

/**
 * Read a session's accumulated touched paths WITHOUT clearing them. Kept as
 * a standalone probe for callers that just want to inspect the set; the
 * Stop-chain auto-commit does NOT call this on its own — see
 * commitTouchedPaths, which performs an equivalent internal read but holds
 * the lock through the commit and clear that follow it too.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @returns {string[]} vault-relative paths, deduped; [] when absent, corrupt,
 *   no session_id, or a lock-timeout (fails closed to "nothing to commit" —
 *   the set stays on disk, untouched, for the next Stop)
 */
export function peekTouchedPaths(hypoDir, sessionId) {
  if (!sessionId) return [];
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const result = readTouchedPathsFile(path);
      return result === null ? [] : result;
    });
  } catch {
    return [];
  }
}

/**
 * Remove exactly `paths` from a session's touched-paths set — a set
 * difference, not a clear, and NOT a drain: any path a concurrent
 * PostToolUse (or Stop-chain generator) accumulated before this call is read
 * fresh under the SAME lock and therefore survives, because it was never in
 * `paths` to begin with.
 *
 * Called only after commitWikiChanges has ACTUALLY committed `paths` (or
 * confirmed there was nothing to commit) — never on a commit failure.
 *
 * Two failure modes this function must not turn into data loss (codex FIX 1
 * + FIX 2 review):
 *
 *   - A read/parse failure on the touched-paths file (readTouchedPathsFile
 *     returns `null`, NOT `[]`) must NOT be treated as "nothing left" — that
 *     would make the set difference below compute an empty remainder and
 *     DELETE the file outright on a transient I/O or parse error, losing
 *     every pending path. On `null`, this function does nothing at all:
 *     no write, no delete, the file is left exactly as it was.
 *   - If this clear itself fails (lock-timeout, I/O) after a successful
 *     read, the already-committed paths simply stay in the file: the next
 *     Stop re-peeks them and re-runs commitWikiChanges, which is a clean
 *     no-op (INTERSECT against a tree with no more changes at those paths
 *     yields an empty scoped set). Over-retention is safe by construction —
 *     it can never lose a path, only a commit failure (handled by leaving
 *     the file alone entirely, see commitTouchedPaths) can.
 *
 * Standalone use of peekTouchedPaths + clearTouchedPaths as two SEPARATE
 * lock acquisitions still carries the same-path race codex FIX 2 describes
 * (a write between the two calls is indistinguishable from the one already
 * peeked, since the set only tracks path presence, not a generation/version
 * per path) — that is exactly why the Stop hook uses commitTouchedPaths
 * instead, which holds ONE lock across the whole peek→commit→clear window
 * so no write can land inside it at all.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {string[]} paths the exact paths that were just committed
 */
export function clearTouchedPaths(hypoDir, sessionId, paths) {
  if (!sessionId) return;
  const toRemove = new Set((Array.isArray(paths) ? paths : []).filter(Boolean));
  if (toRemove.size === 0) return;
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    withFileLock(path, () => {
      const current = readTouchedPathsFile(path);
      if (current === null) return; // FIX 1: never delete/write on a read failure
      const remaining = current.filter((p) => !toRemove.has(p));
      if (remaining.length === 0) {
        try {
          rmSync(path, { force: true });
        } catch {
          // best-effort
        }
      } else {
        atomicWriteShared(path, JSON.stringify(remaining));
      }
    });
  } catch {
    // lock-timeout or unexpected error: leave the file as-is. Safe per the
    // over-retention argument above — the committed paths simply linger
    // until a later clear (or drain) removes them, at worst causing a
    // future no-op re-commit attempt, never a lost path.
  }
}

/**
 * Peek a session's touched paths, run `commitFn(paths)` (expected to be
 * `commitWikiChanges` or an equivalent), and — only when it reports
 * `committed: true` — clear `paths` from the touched-paths set, ALL under
 * ONE hold of the per-session file lock (codex FIX 2). This is what the
 * Stop-chain auto-commit uses instead of calling peekTouchedPaths,
 * commitFn, and clearTouchedPaths as three separate steps.
 *
 * Holding one lock across peek → commit → clear (rather than acquiring and
 * releasing it three times, with the commit itself unlocked in between)
 * closes a same-path race: without it, a `recordTouchedPaths` call for a
 * path already in the just-peeked set could land in the window between the
 * commit and the clear. Since the touched-paths set only tracks path
 * PRESENCE (no per-path version/generation), that accumulate call is
 * indistinguishable from the one already peeked — the clear would remove it
 * anyway, silently orphaning a real edit that was never actually committed
 * (it landed on disk after `git commit` already ran, but the touched-paths
 * record of it just got wiped). With one continuous lock hold, that
 * accumulate call either fully precedes the peek (so it's included in THIS
 * commit, since commitWikiChanges reads live git status, not a cached
 * snapshot) or fully follows the clear (so it's untouched, waiting for the
 * next Stop) — there is no window where it can land in between.
 *
 * Lock order stays vault → per-session everywhere in this codebase (the
 * Stop hook takes the vault lock before calling this; accumulation only
 * ever takes the per-session lock, never the vault lock), so holding the
 * per-session lock for the whole commit here introduces no new ordering and
 * no deadlock risk.
 *
 * FIX 1 (read/parse failure) applies here too: a corrupt/unreadable
 * touched-paths file is never treated as empty. `commitFn` still runs (with
 * an empty scope — a safe no-op through commitWikiChanges), but nothing is
 * ever written to the corrupt file; it is left exactly as it was for a
 * human or a future recovery pass to look at.
 *
 * @param {string} hypoDir
 * @param {string|null|undefined} sessionId
 * @param {(paths: string[]) => {committed: boolean, [k: string]: unknown}} commitFn
 * @returns {{committed: boolean, [k: string]: unknown}} whatever `commitFn` returned,
 *   or `{committed: false, reason: 'touched-paths-lock-timeout'}` if the lock
 *   itself could not be acquired (commitFn never ran; the file is untouched)
 */
export function commitTouchedPaths(hypoDir, sessionId, commitFn) {
  if (!sessionId) return commitFn([]);
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      const current = readTouchedPathsFile(path);
      if (current === null) {
        // FIX 1: a read/parse failure is not "empty" — commit nothing this
        // round (a safe no-op scope) and leave the corrupt file untouched,
        // rather than let a downstream clear compute "nothing left" and
        // delete it.
        return commitFn([]);
      }
      const result = commitFn(current);
      if (result && result.committed && current.length > 0) {
        // Still under the SAME lock acquired above: no recordTouchedPaths
        // call for this session can have landed since `current` was read
        // (it takes this exact lock too), so the set on disk right now is
        // EXACTLY `current` — clearing it needs no re-read or set
        // difference, just remove what we already know is the whole thing.
        try {
          rmSync(path, { force: true });
        } catch {
          // best-effort: the committed paths just linger on disk; the next
          // Stop re-peeks them and re-runs commitFn, a clean no-op.
        }
      }
      return result;
    });
  } catch {
    // Lock-timeout (or an unexpected lock error): never entered the
    // critical section, so commitFn never ran and nothing was peeked or
    // cleared. The touched-paths file is untouched on disk, and the next
    // Stop retries this session's commit from the same scope.
    return { committed: false, reason: 'touched-paths-lock-timeout' };
  }
}

/**
 * The lock target both commit loci (hypo-auto-commit.mjs Stop hook,
 * crystallize.mjs --apply-session-close) hold while staging+committing (and,
 * for the Stop hook, syncing) the vault, so two concurrent sessions on a
 * shared vault never interleave `git add`/`git commit`/`git pull`/`git push`.
 * A stable, non-content path — withFileLock only ever touches its `.lock`
 * sibling, this file itself is never created.
 */
export function vaultCommitLockTarget(hypoDir) {
  return join(hypoDir, '.cache', 'vault-commit');
}

/** `projects/<slug>/...` → `<slug>`; anything else → its first path segment. */
function projectOfPath(relPath) {
  const parts = relPath.split('/');
  if (parts[0] === 'projects' && parts.length > 1 && parts[1]) return parts[1];
  return parts[0] || relPath;
}

/**
 * Stage + commit ONLY the caller-supplied `paths`, intersected with what is
 * actually changed on disk right now. Does NOT pull/push; remote
 * sync stays in the auto-commit Stop hook (commit is local + cheap; sync is
 * network + soft-fail). Shared by hypo-auto-commit.mjs and crystallize.mjs's
 * --apply-session-close path so the .hypoignore staging filter cannot diverge
 * between the two commit loci.
 *
 * The caller supplies the scope; this function never re-derives it from the
 * whole tree. `paths` absent/empty is a clean no-op (`scoped: 0`), not an
 * error and not a whole-tree fallback — this is how a caller with nothing to
 * contribute (e.g. no session_id, so nothing was accumulated) skips cleanly.
 *
 * The authoritative scope is INTERSECT(paths, currently-changed): a stale
 * entry (already committed elsewhere, or never actually changed) is dropped
 * silently rather than erroring. `.hypoignore` filtering, the staged
 * re-derivation, the commit-message count, and the final commit all use this
 * SAME scoped set — no step here may widen back to whole-tree, or another
 * session's dirty/staged files could slip back in through any one of them.
 *
 * "Nothing to commit" (empty scope, or only .hypoignore'd changes) is
 * SUCCESS, not failure — the caller's tree is already in the state it wanted.
 *
 * @param {string} hypoDir
 * @param {string[]} [paths] vault-relative paths this caller wrote/owns this close
 * @returns {{committed: boolean, scoped?: number, reason?: string}} committed:true
 *   when a commit was created OR nothing needed committing (scoped:0 in the
 *   latter case); committed:false (with reason) on a real failure: not a git
 *   repo, or git status/add/commit erroring.
 */
export function commitWikiChanges(hypoDir, paths) {
  const git = (...args) =>
    spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', timeout: 30000 });
  if (git('rev-parse', '--is-inside-work-tree').status !== 0)
    return { committed: false, reason: `not a git repository: ${hypoDir}` };

  const supplied = new Set(
    (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.length > 0),
  );
  if (supplied.size === 0) return { committed: true, scoped: 0 };

  // `-z`: NUL-separated records with verbatim paths — no surrounding quotes and
  // no octal escaping, so non-ASCII paths (Korean page names are normal input
  // here) survive intact. Without it, `core.quotepath=true` (the default) yields
  // `"pages/\355\225\234\352\270\200.md"` and the old quote-strip parser fed that
  // literal, non-existent path to `git add` — failing the whole commit.
  const porcelain = git('status', '--porcelain', '-uall', '-z');
  if (porcelain.status !== 0)
    return { committed: false, reason: `git status failed in ${hypoDir}` };
  // `.hypoignore` is the project privacy boundary. `git add -A` ignores it, so
  // enumerate changed paths, drop ignored ones, then stage explicitly.
  const ignorePatterns = loadHypoIgnore(hypoDir);
  const scoped = []; // pathspec for `git add -A` — worktree/index paths only
  const commitScope = []; // pathspec for the final diff/commit --only (superset)
  const records = (porcelain.stdout || '').split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3); // `XY <path>`; the destination path for a rename/copy
    const isRename = xy[0] === 'R' || xy[1] === 'R';
    // A rename OR copy emits two records (`to\0from`); consume the trailing
    // `from`. Copy `C` records only appear under `status.renames=copies`, but
    // when they do, missing this skip feeds the `from` path to `git add` as a
    // bogus pathspec — the exact auto-commit failure this parser fixes.
    let fromFile = null;
    if (isRename || xy[0] === 'C' || xy[1] === 'C') {
      i++;
      fromFile = records[i] || null;
    }
    if (!file) continue;
    if (!supplied.has(file)) continue; // out of this caller's scope
    if (ignorePatterns.length > 0 && isIgnored(join(hypoDir, file), hypoDir, ignorePatterns))
      continue;
    scoped.push(file);
    commitScope.push(file);
    // A rename's `from` path is the SAME change as its destination — without
    // it, `git commit --only` on the destination alone commits the addition
    // but leaves the source's deletion staged as residue (a git --only
    // quirk, verified). It is NOT added to `git add -A` (the deletion is
    // already staged by the rename itself, and its worktree entry is gone —
    // `git add -A -- <a gone-and-already-staged path>` errors "did not match
    // any files"), only to the commit's pathspec. A copy's `from` is
    // independently-owned, still-existing content, so it is NOT auto-pulled
    // in at all: the caller must name it explicitly if it wants it in scope.
    if (isRename && fromFile) commitScope.push(fromFile);
  }
  if (scoped.length === 0 && commitScope.length === 0) return { committed: true, scoped: 0 };

  if (scoped.length > 0) {
    const add = git('add', '-A', '--', ...scoped);
    if (add.status !== 0)
      return {
        committed: false,
        reason: `git add failed: ${(add.stderr || '').trim() || 'unknown'}`,
      };
  }

  // Re-derive from what actually landed in the index, bounded by the SAME
  // pathspec (commitScope, the rename-aware superset of `scoped`) — this step
  // must not widen back to whole-tree either, or another session's already-
  // staged file would slip into the commit here.
  const staged = git('diff', '--cached', '--name-only', '-z', '--', ...commitScope);
  const stagedFiles = (staged.stdout || '').split('\0').filter(Boolean);
  if (stagedFiles.length === 0) return { committed: true, scoped: 0 };

  const projects = new Set(stagedFiles.map(projectOfPath));
  const today = new Date().toISOString().slice(0, 10);
  const msg = `auto: ${today} wiki update (${stagedFiles.length} paths across ${projects.size} projects)`;

  // `git commit --only -- <paths>` (first use of --only in this repo): commits
  // ONLY the staged changes under this pathspec, ignoring anything else
  // staged in the index — e.g. another session's own staged-but-uncommitted
  // work sharing this working tree. A bare `git commit -m` would sweep in
  // every staged path, defeating the whole point of the scoped set above.
  //
  // Pathspec is `commitScope`, NOT `stagedFiles`: `git diff --name-only`
  // collapses a rename to its destination alone (rename detection folds the
  // pair into one line), so re-deriving the commit's own pathspec from that
  // output would silently drop the `from` path again and reproduce the
  // exact `--only`-leaves-the-deletion-staged residue this function's rename
  // handling exists to avoid (verified). `stagedFiles` still governs the
  // empty-scope check and the N/M count above — both correct as "how many
  // logical changes", where a rename is rightly one.
  const commit = git('commit', '--only', '-m', msg, '--', ...commitScope);
  if (commit.status !== 0)
    return {
      committed: false,
      reason: `git commit failed: ${(commit.stderr || '').trim() || 'unknown'}`,
    };
  return { committed: true, scoped: stagedFiles.length };
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

// ── sync-last-success ────────────────────────────────────────
// `.cache/sync-last-success.json` is a single JSON object, PER-OPERATION:
//   { "pull": {"timestamp": "<ISO>", "host": "<os.hostname()>"},
//     "push": {"timestamp": "<ISO>", "host": "<...>"} }
// Either key may be absent (pull-only or push-only history). Deliberately
// separate from sync-state.json: that file is failure-only and gets wiped
// wholesale on recovery (clearSyncState), so a success record living there
// would be erased by the very thing it is meant to survive. syncRemote()
// records here on a successful pull/push; session-start's independent
// `git pull --ff-only` records a pull here too, so doctor never reports
// "never synced" right after a healthy startup pull. doctor reads it via
// readSyncLastSuccess; schema + parsing live here only.
//
// Scope: `.cache/` is gitignored (templates/gitignore), same as
// sync-state.json — this file never syncs across machines, so there is no
// cross-machine merge to protect. The lock below only has to cover the
// same-machine case: two concurrent processes on one machine (a pull-writer
// and a push-writer, or two overlapping sessions). `host` is kept per record
// purely for provenance (which machine last recorded the op), not because a
// remote write could ever land here.

/** @returns {string} path to the sync-last-success JSON file for a wiki root. */
function syncLastSuccessPath(hypoDir) {
  return join(hypoDir, '.cache', 'sync-last-success.json');
}

/**
 * A valid last-success record: `{timestamp: string, host: string}`. Anything
 * else (wrong type, missing field, non-object) is malformed.
 * @param {unknown} v
 * @returns {boolean}
 */
function isValidSyncSuccessRecord(v) {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof v.timestamp === 'string' &&
    v.timestamp.trim().length > 0 &&
    typeof v.host === 'string' &&
    v.host.trim().length > 0
  );
}

/**
 * Read last-success records. A missing file means "never synced" (not an
 * error) — the caller distinguishes that from a parse failure via
 * `parseError`. A present `pull`/`push` field that does not match the
 * `{timestamp, host}` shape (including an empty/whitespace-only timestamp or
 * host — a technically-typed but content-free record) is dropped from `data`
 * (never surfaced as if it were a real record) AND flags `parseError: true`,
 * so the caller warns ("cannot parse ... inspect manually") instead of
 * silently rendering `undefined` or an empty value — same corrupt-file
 * handling as sync-state.json. An unrecognized top-level key (anything other
 * than `pull`/`push`) likewise flags the whole file as corrupt: this schema
 * has exactly two legal keys, so a third one is evidence of a hand-edit or a
 * future/foreign writer, not a shape this reader should quietly tolerate.
 *
 * @param {string} hypoDir
 * @returns {{data: {pull?: {timestamp: string, host: string}, push?: {timestamp: string, host: string}}, parseError: boolean}}
 */
export function readSyncLastSuccess(hypoDir) {
  const path = syncLastSuccessPath(hypoDir);
  if (!existsSync(path)) return { data: {}, parseError: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { data: {}, parseError: true };
    let malformed = Object.keys(parsed).some((k) => k !== 'pull' && k !== 'push');
    const data = {};
    for (const op of ['pull', 'push']) {
      if (parsed[op] === undefined) continue;
      if (isValidSyncSuccessRecord(parsed[op])) data[op] = parsed[op];
      else malformed = true; // drop the bad field; flag the file as corrupt
    }
    return { data, parseError: malformed };
  } catch {
    return { data: {}, parseError: true };
  }
}

/**
 * Record a successful pull or push. Concurrency-safe on the same machine:
 * takes the vault file lock on the target path, re-reads the CURRENT file
 * under the lock, updates only the given op's field (the other op's existing
 * value survives — a same-machine concurrent pull-writer and push-writer must
 * not erase each other), then commits via temp-write + rename so a crash or a
 * concurrent read never sees a half-written file. `.cache/` is gitignored, so
 * this file never syncs across machines — there is no cross-machine case to
 * protect here. A pre-existing but unparseable file, or a sibling field that
 * does not match `{timestamp, host}` (including an empty/whitespace-only
 * value) or that carries an unrecognized key, is dropped rather than carried
 * forward (never preserve garbage into a freshly-written record) — the same
 * `isValidSyncSuccessRecord` predicate readSyncLastSuccess uses.
 *
 * Lock acquisition is best-effort — a timeout (or any other failure) is
 * swallowed, same as appendSyncFailure, since a failed success-log must never
 * break the caller (Stop hook / SessionStart).
 *
 * @param {string} hypoDir
 * @param {'pull'|'push'} op
 */
export function recordSyncSuccess(hypoDir, op) {
  try {
    const path = syncLastSuccessPath(hypoDir);
    withFileLock(path, () => {
      let current = {};
      try {
        if (existsSync(path)) {
          const parsed = JSON.parse(readFileSync(path, 'utf-8'));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const k of ['pull', 'push']) {
              if (isValidSyncSuccessRecord(parsed[k])) current[k] = parsed[k];
            }
          }
        }
      } catch {
        // corrupt existing file: overwrite with a fresh object rather than
        // carry the corruption forward.
      }
      current[op] = { timestamp: new Date().toISOString(), host: hostname() };
      atomicWriteShared(path, JSON.stringify(current, null, 2) + '\n');
    });
  } catch {
    // best-effort: lock timeout or write failure must never break the caller
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
export function sanitizeSessionId(sessionId) {
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
    // v4 attribution discriminator (session-close attribution). `projects` is the evidence-based
    // set this session actually closed — explicit --project ∪ transcript
    // close-file edits ∪ apply's authoritative payload.project — and NEVER the
    // recency primary. Its PRESENCE marks a v4 marker whose scope resolveCloseScope
    // trusts directly; a pre-v4 marker carries only `project` and is treated as an
    // uncorroborated legacy hint (see resolveCloseScope). `project` stays as
    // projects[0] for back-compat with the flat-field readers.
    const projects = Array.isArray(info.projects)
      ? [...new Set(info.projects.filter(Boolean))]
      : info.project
        ? [info.project]
        : [];
    const payload = {
      session_id: sessionId,
      project: info.project || projects[0] || null,
      projects,
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

/**
 * The session-close FILES of some project, as a path matcher. Used to attribute a
 * close to a session: a transcript that edited `projects/<slug>/session-state.md`
 * (or that project's hot.md / a session-log shard) is evidence THIS session was
 * closing <slug>. Any other file under `projects/<slug>/` is NOT evidence — merely
 * editing a page or an ADR there says nothing about whose close is whose, and
 * treating it as attribution would re-block a session for a project it only read
 * around in (codex design review).
 */
const CLOSE_FILE_RE = /^projects\/([^/]+)\/(session-state\.md|hot\.md|session-log\/[^/]+\.md)$/;

/** Slugs whose close files this session edited directly (Write/Edit tool_use). */
function projectsFromTouchedCloseFiles(transcriptPath, hypoDir) {
  const out = new Set();
  if (!transcriptPath) return out;
  for (const f of extractTouchedWikiFiles(transcriptPath, hypoDir)) {
    const m = posixPath(f).match(CLOSE_FILE_RE);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * closeScope: the projects THIS session is accountable for closing. The union of
 * three signals, because no single one covers every close path:
 *
 *   1. `opts.closeScope` — the caller states it outright. `--apply-session-close`
 *      passes `payload.project` (it is the authority on what it just closed) and
 *      `--mark-session-closed --project=<slug>` passes its attribution slug. This
 *      signal is LOAD-BEARING, not a convenience: the documented close path writes
 *      its files from inside a Bash call, so they never surface as Edit/Write
 *      `file_path`s and signal 2 cannot see them (the same blind spot that forces
 *      closeFileTargets() to seed the lint scope explicitly).
 *   2. close files the transcript shows this session editing — the hand-written
 *      close, which bypasses the script entirely.
 *   3. `marker.project` — after a scripted close marked, this is how a later reader
 *      (PreCompact) recovers signal 1. It is what keeps the marker == compact-ready
 *      invariant: the writer scopes by `payload.project`, PreCompact re-scopes by
 *      the `project` that same writer recorded, so the two can never disagree.
 */
export function resolveCloseScope(hypoDir, opts = {}, marker = null) {
  const scope = new Set(opts.closeScope || []);
  for (const p of projectsFromTouchedCloseFiles(opts.transcriptPath, hypoDir)) scope.add(p);
  // Marker attribution (session-close attribution). A v4 marker carries `projects` — the
  // evidence-based set it closed (never recency) — trusted directly. A pre-v4
  // legacy marker carries only `project` with no provenance, and that value may be
  // recency-derived (the P1 bug). An uncorroborated legacy attribution must NOT
  // enable partitioning, or a stale/wrong slug could demote a real failure to
  // foreign debt. So a legacy `project` enters scope only when the direct signals
  // above (explicit close scope or transcript close-file edits) already corroborate
  // the SAME slug; otherwise it stays a display hint. This narrow gap self-heals as
  // pre-v4 markers expire (7-day TTL).
  if (Array.isArray(marker?.projects)) {
    for (const p of marker.projects) if (p) scope.add(p);
  }
  return scope;
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
 * opts.sessionCwd (session-cwd close check): the authoritative cwd of the session being
 * gated (hook payload.cwd, or the CLI --session-cwd flag — never process.cwd(),
 * which is post-`cd` non-authoritative). When set and not log-only, the project
 * that owns this cwd is checked for close-completeness as an INDEPENDENT blocker,
 * catching a session whose own project close was never started. Unmatched/ambiguous
 * cwd yields a best-effort notice, not a block. apply never passes it (its launch
 * cwd may differ from the authoritative payload.project).
 *
 * @param {{lintScope?: Iterable<string>, transcriptPath?: string|null, claudeHome?: string, projectOverride?: string|null, sessionCwd?: string|null, sessionId?: string|null, logOnly?: boolean, closeScope?: string[]}} [opts]
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

    // Attribute the close debt before blocking on it. An incomplete close belongs
    // to whichever session performed it; charging it to an unrelated session is the
    // false block this partition exists to stop. The gate already draws exactly this
    // line for LINT debt (partitionLintScope: errors in files THIS session touched
    // block, pre-existing debt elsewhere is a notice) — close-file debt was the one
    // check still hard-blocking globally on another session's work.
    //
    // Two fail-closed guards keep the partition from eating a real blocker:
    //   - close.fallback: no project closed today, so this is the "you have not
    //     closed this session AT ALL" path. It must block unconditionally; demoting
    //     it would gut the gate's whole purpose.
    //   - empty scope: no positive attribution signal, so we cannot tell whose debt
    //     it is. Never demote on a guess — fall back to today's global block.
    //   - projectOverride: the caller asked "is THIS project close-complete?".
    //     Demoting the very project it named would answer a question nobody asked.
    //
    // Bounded tradeoff (codex design review, accepted rather than closed). A
    // scripted close that CRASHES mid-write leaves no marker and no transcript trace
    // (it writes from inside a Bash call), so its own project carries no attribution.
    // If that same session had also hand-edited SOME OTHER project's close files, the
    // scope is non-empty but omits the torn project, and its debt is demoted. The
    // window is narrow and self-limiting: apply writes the project files, then the
    // session-log, then the root log entry, so the only torn state that reaches this
    // partition at all is a missing log.md entry — which deriveRootLogEntries
    // regenerates from the session-log heading. A crash before the session-log is not
    // detected as today-active by hasTodayCloseActivity in the first place (the
    // pre-existing tradeoff documented there). And the marker is never written, so the
    // Stop hook still refuses to end the session. Closing this properly needs a
    // durable close-attempt record; it is not worth a new state-file lifecycle here.
    const scopeSet = resolveCloseScope(hypoDir, opts, marker);
    const failed = (close.projects || []).filter((p) => !p.ok);
    const partition =
      !close.fallback && !opts.projectOverride && scopeSet.size > 0 && failed.length > 0;

    close.scope = [...scopeSet];
    close.debt = [];
    // Re-project the flat aliases onto what actually BLOCKS, so `ok` and
    // `stale`/`missing` can never contradict each other (a reader that treats a
    // non-empty `missing` as failure stays correct). Demoted debt moves to its own
    // `debt` field instead of masquerading as this session's unfinished work.
    //
    // ONLY when partitioning. Deriving `ok` from the per-project rows unconditionally
    // would silently drop the failures that have NO project row to be derived from:
    // an unresolvable active project yields `projects: []` with
    // `missing: ['hot.md (no active project in pointer table)']`, so an empty `failed`
    // would read as "nothing failed" and flip a red gate green (codex pre-commit
    // BLOCKER, reproduced on a vault with no active-project row). Outside the
    // partition the close status stands exactly as sessionCloseGlobalStatus computed it.
    if (partition) {
      const mine = failed.filter((p) => scopeSet.has(p.project));
      const foreign = failed.filter((p) => !scopeSet.has(p.project));
      close.debt = foreign.map((p) => ({ project: p.project, stale: p.stale, missing: p.missing }));
      close.stale = [...new Set(mine.flatMap((p) => p.stale))];
      close.missing = [...new Set(mine.flatMap((p) => p.missing))];
      close.ok = mine.length === 0;
      // The flat `project` alias must follow the scope too: it names the project the
      // rest of this status describes, and every consumer that renders a per-file
      // checklist builds it from that name. Left as the global `primary` it can point
      // at a DEMOTED foreign project, and the checklist then reports ✓ for files the
      // debt list simultaneously calls missing (codex pre-commit CONCERN).
      if (!scopeSet.has(close.project)) {
        close.project = mine[0]?.project ?? [...scopeSet][0] ?? close.project;
      }
    }

    if (!close.ok) {
      blockers.push({
        type: 'close',
        reason: `memory files not updated this session: ${[
          ...close.missing.map((f) => `${f} (missing)`),
          ...close.stale.map((f) => `${f} (stale)`),
        ].join(', ')}`,
      });
    }
    for (const p of close.debt) {
      notices.push({
        type: 'close-debt',
        project: p.project,
        reason: `${p.project}: incomplete session close from another session (${[
          ...p.missing.map((f) => `${f} (missing)`),
          ...p.stale.map((f) => `${f} (stale)`),
        ].join(', ')}) — not blocking; that project's next close will fix it`,
      });
    }
  }

  // 3b. session-cwd close (session-cwd close check). The current session's cwd project is an
  // INDEPENDENT close responsibility. sessionCloseGlobalStatus above only sees
  // projects that left an authoritative close-activity trace (a session-log
  // heading / log.md entry), so a project whose close was NEVER STARTED is
  // invisible — and if the recency project was closed the same day, the gate would
  // go green while this session's real project stays unclosed (the false-green this
  // closes). Evaluate it here, AFTER the partition and OUTSIDE scopeSet /
  // close.projects, so it can neither be demoted to foreign debt (partition) nor
  // spawn a W8 design-history blocker (which derives from close.projects). log-only
  // sessions are exempt (no project to close). apply never passes sessionCwd (its
  // launch cwd may differ from the authoritative payload.project — a supported
  // cross-project close), so this runs only on the read / mark paths.
  if (!logOnly && opts.sessionCwd) {
    const cwdProject = pickProjectByCwd(collectProjectWorkingDirs(hypoDir), opts.sessionCwd, {
      rejectAmbiguous: true,
    });
    if (cwdProject) {
      const s = sessionCloseFileStatus(hypoDir, { projectOverride: cwdProject });
      if (!s.ok) {
        // ALWAYS emit the typed close-cwd blocker when the cwd project's close is
        // incomplete — never suppress it as a duplicate of the global `close`
        // blocker. The Stop hook keys its marker re-check on this exact type, so
        // hiding it (even when a `close` blocker names the same project) would let
        // Stop honor a stale marker and end the session green (codex pre-commit
        // BLOCKER). A second entry for the same slug is merely noisy, never wrong.
        blockers.push({
          type: 'close-cwd',
          project: cwdProject,
          reason: `session cwd project '${cwdProject}' has an incomplete session close: ${[
            ...s.missing.map((f) => `${f} (missing)`),
            ...s.stale.map((f) => `${f} (stale)`),
          ].join(', ')}`,
        });
        // If the partition demoted this project to foreign debt, it is NOT another
        // session's work — it is THIS session's, and we just BLOCKED on it. Remove
        // it from BOTH the debt notice and close.debt so the status cannot report
        // the same project as non-blocking debt and a blocker at once (codex
        // pre-commit CONCERN: crystallize renders close_debt from close.debt).
        for (let i = notices.length - 1; i >= 0; i--) {
          if (notices[i].type === 'close-debt' && notices[i].project === cwdProject)
            notices.splice(i, 1);
        }
        if (Array.isArray(close.debt))
          close.debt = close.debt.filter((d) => d.project !== cwdProject);
      }
    } else {
      // cwd is under no project working_dir, or ambiguously under several (a
      // monorepo tie pickProjectByCwd declined): we cannot attribute a close
      // responsibility, so we do NOT hard-block (nothing proves there is anything
      // to close). Surface a best-effort notice so the coverage gap is visible.
      notices.push({
        type: 'close-cwd-unresolved',
        reason:
          'session cwd did not resolve to a unique project — the P2 cwd close check is best-effort here; pass --project or --log-only to be explicit',
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
        // A target whose file EXISTS but cannot be projected into (its
        // <learned_behaviors> container is gone) reports dirty:false with no
        // conflict flag — it cannot be built, so nothing "would change". That
        // shape used to fall into the non-actionable branch below and fail OPEN,
        // the worst possible reading: a projection that loads ZERO rules on this
        // machine was classified as "nothing to do" and waved through. It is a
        // blocker, not a shrug.
        //
        // ONLY kind 'build-failed'. A 'target-missing' buildError (no ~/.claude/
        // CLAUDE.md yet) is the ordinary first-run state and must keep failing
        // OPEN, or the gate blocks every new user on their first /compact.
        const buildErrT = entries
          .filter(([, t]) => t.buildError && t.buildErrorKind === 'build-failed')
          .map(([n]) => n);
        // Side-file I/O trouble (an unreadable feedback_<slug>.md under the
        // project memory dir) is a NOTICE, never a blocker: the primary
        // projection still loads every rule, and the only fix is a permission
        // bit on that path — `--ensure-container` cannot touch it. A gate that
        // blocks on a condition its own named remedy cannot clear is a gate that
        // gets bypassed.
        const sideWarnT = entries.filter(([, t]) => (t.sideWarnings || []).length);
        if (
          !report ||
          !(
            conflictedT.length ||
            overCapT.length ||
            driftedT.length ||
            buildErrT.length ||
            sideWarnT.length
          )
        ) {
          skipped.feedback = true; // unparseable / non-actionable → fail-open
        } else if (buildErrT.length) {
          // Name the EXACT target file and the remedy for THIS cause. "Restore
          // the managed container" with no path is a dead end, and so is naming
          // `--ensure-container` for a permission error or a dangling symlink,
          // which it cannot fix — a blocker with no way through gets bypassed
          // rather than obeyed. t.buildError carries the target's absolute path
          // and t.buildErrorRemedy the cause-specific way out; feedback-sync
          // makes that judgment once, at the branch that detects the cause.
          const failed = entries.filter(([n]) => buildErrT.includes(n));
          const details = failed.map(([n, t]) => `${n}: ${t.buildError}`).join('; ');
          const remedies = [
            ...new Set(failed.map(([, t]) => t.buildErrorRemedy).filter(Boolean)),
          ].join(' ');
          blockers.push({
            type: 'feedback',
            reason: `feedback projection cannot be built — ${details} — no rules are loaded from it. ${remedies}`,
          });
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
        } else if (driftedT.length) {
          driftTargets.push(...driftedT); // pure drift → self-healable, not a blocker
          notices.push({
            type: 'feedback',
            reason: `feedback projection drift (${driftedT.join(', ')}) — will self-heal at /compact`,
          });
        }
        // Additive, and deliberately outside the chain above: a side-file I/O
        // problem is orthogonal to the primary target's health, so it is a notice
        // whatever else is (or is not) going on. It names the path and the
        // permission fix, because that — not a command — is the way out.
        for (const [n, t] of sideWarnT) {
          notices.push({
            type: 'feedback',
            reason: `feedback projection side file unreadable (${n}): ${t.sideWarnings.join('; ')} — fix the permissions on that path; the primary projection still loads every rule (\`--ensure-container\` does not fix this)`,
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
  return extractUserMessageRecords(transcriptPath, tailN, { keepEmpty: true }).join('\n');
}

/**
 * Same extraction as {@link extractUserMessages}, but ONE STRING PER TRANSCRIPT
 * RECORD instead of one flat blob. The message boundary is the point: a gate that
 * asks "did the user say exactly X" cannot ask it of text that has been joined
 * across turns, because any line of any message then looks like a whole message.
 * {@link hasTypedUserApproval} needs that boundary; the close-intent readers, which
 * only ever ask "does this text contain a close phrase", do not.
 *
 * @param {string} transcriptPath
 * @param {number} tailN  how many trailing lines to scan (Infinity → whole file)
 * @param {{keepEmpty?: boolean}} [opts]  keepEmpty preserves a '' per dropped record,
 *   so the joined form stays byte-identical to what extractUserMessages always returned.
 * @returns {string[]} user-typed text per record, or [] on any failure (fail-open)
 */
export function extractUserMessageRecords(transcriptPath, tailN = 30, { keepEmpty } = {}) {
  const records = extractUserRecordTexts(transcriptPath, tailN);
  return keepEmpty ? records : records.filter((t) => t !== '');
}

function extractUserRecordTexts(transcriptPath, tailN) {
  try {
    const lines = readFileSync(transcriptPath, 'utf-8').split('\n');
    // tailN === Infinity → whole transcript (the marker-write hard gate needs the
    // full prefix; a close request can precede the marker by the entire close
    // checklist). The Stop hook keeps the 30-line default so a stale old close
    // signal doesn't re-trigger every turn.
    const tail = Number.isFinite(tailN) ? lines.slice(-tailN) : lines;
    return tail.map((line) => {
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
    });
  } catch {
    return [];
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
 * Returns true iff the transcript's LATEST live user decision is to close — the
 * hard gate for the session-closed marker writers. This is a state predicate, not
 * an existence one: "is close still approved right now", not "did a
 * close signal ever appear". Scans the FULL transcript in line order, classifies
 * each record, and tracks the approval as a LEASE.
 *
 * Classification (structural fields only — never content heuristics for producer):
 *   • GRANT      a genuine user close: an NL close phrase in user text that
 *                survives {@link eventUserText}'s exclusions; a `/compact`
 *                queue-op; a remove-path queued_command attachment carrying a
 *                close with an audited human producer (origin.kind "human"); a
 *                correlated, non-error AskUserQuestion answer naming a close.
 *   • INVALIDATE a fresh user intent that expires the lease: any other genuine
 *                user text, `/clear`, `popAll`, a non-close queued_command, a
 *                non-close AskUserQuestion selection.
 *   • NEUTRAL    everything the model can produce or the harness injects: system/
 *                sdk replay, isMeta bodies, sidechain, interruptedMessageId
 *                companions, assistant, tool_result, task-notification.
 *   • FATAL      an unparseable line — the transcript is being appended to or is
 *                corrupt, so refuse rather than read a half-written record.
 *
 * The last grant wins and a later invalidate expires it, so a stale close (Defect
 * B), a queued "keep working" after a close, and a non-close AskUserQuestion
 * selection all correctly read as NOT closed. Abandoned-branch staleness is a
 * known limit (no leaf pointer exists to resolve it — see the branch note on the
 * function), mitigated by the lease.
 *
 * Threat model: an honest-but-drifting model that does not forge the
 * transcript. This is a safety interlock, not an authorization boundary — a model
 * that forges records is out of scope and documented so.
 *
 * Fail-closed: any read/parse error, or an unresolvable branch, → false.
 */
// Genuine user text of a record, or null when the record is on a channel the
// honest-but-drifting model can reach (so it is never user intent — NEUTRAL).
// role:user is the boundary the model cannot cross: it authors role:assistant,
// so a user record that survives every exclusion below is genuine user text.
// The exclusions are exactly the model-reachable channels:
//   • isMeta            slash-command / skill bodies and local-command caveats
//   • promptSource system|sdk   queue replay of injected text, SDK prompts
//   • isSidechain       subagent context (a subagent must not close the session)
//   • interruptedMessageId  the harness cut the model off; user-SHAPED, not a
//                       user decision (e.g. the [Request interrupted by user]
//                       companion of a delivered /compact)
//   • Stop-hook feedback  the hook's own close nudge — circular
//   • tool_result blocks  tool output, not typed text
// No promptSource allowlist is required: requiring `typed` would drop the
// legacy absent-promptSource close the older gate has always honoured, while the
// dangerous replay/injection paths carry system|sdk|isMeta|isSidechain and are
// excluded here anyway.
function eventUserText(obj) {
  if (obj.isMeta === true) return null;
  if (obj.promptSource === 'system' || obj.promptSource === 'sdk') return null;
  if (obj.isSidechain === true) return null;
  if (obj.interruptedMessageId) return null;
  const msg = obj.message ?? obj;
  const role = msg.role ?? obj.role ?? obj.type;
  if (role !== 'user') return null;
  const content = msg.content ?? obj.content;
  if (typeof content === 'string') {
    return content.startsWith('Stop hook feedback') ? null : content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
    return texts.length ? texts.join('\n') : null;
  }
  return null;
}

// A record on a channel the honest-but-drifting model can reach, so it can never
// be a user decision. Used to keep injected / replayed / subagent records out of
// BOTH the user-text and the AskUserQuestion-answer classifiers.
function isModelReachableRecord(obj) {
  return (
    obj.isMeta === true ||
    obj.promptSource === 'system' ||
    obj.promptSource === 'sdk' ||
    obj.isSidechain === true
  );
}

export function hasUserCloseSignal(transcriptPath) {
  if (!transcriptPath) return false;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return false;
  }
  // FATAL: a non-empty line that will not parse means the transcript is being
  // appended to (a half-written record) or is corrupt. Skipping it would let a
  // stale prior grant survive past an event we cannot read, so refuse. A line
  // that parses to a non-object (a bare null / string / number) is valid JSON but
  // not a record — noise, not corruption — so it is skipped, not fatal, and never
  // reaches the field reads below.
  const recs = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return false;
    }
    if (o === null || typeof o !== 'object') continue;
    recs.push(o);
  }

  // The approval is a LEASE, not an existence fact: walk the transcript in line
  // order and track whether the LATEST user decision is a grant. Each grant sets
  // it true, each invalidate sets it false, neutral leaves it — so at the end
  // `granted` is "the most recent user decision was to close, and nothing has
  // expired it since", which is how a stale close and a queued change-of-mind
  // read as NOT closed.
  //
  // Branch note: line order mixes an abandoned branch's records with the live
  // ones. A leaf-pointer ancestry filter was tried and withdrawn — the transcript
  // carries no authoritative leaf pointer (measured: 0 leafUuid / summary
  // records), so a heuristic leaf can skip the real invalidator and PRESERVE a
  // stale grant (a fail-open, not a conservative filter). Until such a pointer
  // exists, a close on a branch abandoned under a neutral tail is a known
  // staleness limit, mitigated by the lease: any later live user intent, on any
  // branch, still expires it.
  const askIds = new Set();
  let granted = false;

  for (const o of recs) {
    // Queue operations. The queue carries no correlation key (measured), so the
    // ENQUEUE content is the decision — not a later contentless dequeue, which
    // would need pairing we cannot do. Reading the enqueue also keeps the live
    // PreCompact gate working (it sees the enqueue) and avoids double-counting the
    // replay companion of an already-decided item (the /compact replay is not a
    // fresh decision). popAll cancels the queue → invalidate. Delivery ops
    // (dequeue, remove) carry no fresh decision here — a content-bearing remove of
    // an NL queued command is handled by its queued_command attachment below.
    if (o.type === 'queue-operation') {
      if (o.operation === 'popAll') {
        granted = false;
        continue;
      }
      if (o.operation !== 'enqueue') continue;
      const c = typeof o.content === 'string' ? o.content.trim() : '';
      if (/^\/compact(?:\s|$)/.test(c))
        granted = true; // a user compaction preserves the work → grant
      else if (/^\/clear(?:\s|$)/.test(c))
        granted = false; // abandons context → invalidate
      else if (!c || c.startsWith('<task-notification>')) {
        /* model-caused / empty — neutral */
      } else if (isClosePattern(c)) {
        /* NL close via the queue — the open dequeue gap: the producer cannot be
           attributed (a peer/model enqueue wears the same shape), so no grant */
      } else granted = false; // a queued non-close user intent → invalidate (change of mind)
      continue;
    }

    // remove-path delivery of a queued natural-language command (measured: the
    // item leaves the queue as it is handed to the model, landing as an
    // `attachment` of type queued_command with the prompt verbatim). A close here
    // grants ONLY with an audited human producer — origin.kind "human", present
    // on every 2.1.181+ user delivery (measured). A legacy origin-absent delivery
    // cannot attest a producer, so it does not grant (fail-closed). A NON-close
    // queued command (e.g. "keep working") is a fresh user intent and INVALIDATES
    // a prior grant regardless of origin — that is what closes the re-close hole
    // where a queued "continue" after a close leaves the stale lease live.
    if (o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command') {
      const prompt = typeof o.attachment.prompt === 'string' ? o.attachment.prompt : '';
      const humanOrigin = !!(o.attachment.origin && o.attachment.origin.kind === 'human');
      if (isClosePattern(prompt)) {
        if (humanOrigin) granted = true;
      } else if (prompt) {
        granted = false;
      }
      continue;
    }

    // Record AskUserQuestion tool_use ids (assistant record, always precedes its
    // answer in line order).
    const content = (o.message ?? o).content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (
          b &&
          typeof b === 'object' &&
          b.type === 'tool_use' &&
          b.name === 'AskUserQuestion' &&
          b.id
        )
          askIds.add(b.id);
      }
    }

    // Genuine user text → grant on a close phrase, invalidate on anything else.
    const text = eventUserText(o);
    if (text != null && text !== '') {
      granted = isClosePattern(text);
      continue;
    }

    // AskUserQuestion answer, correlated to a recorded AskUserQuestion, EXCLUDED
    // and HARDENED. isModelReachableRecord keeps an injected / sdk / sidechain
    // record from reaching the answer parser. is_error:false AND the host's
    // success marker are required because a malformed AskUserQuestion echoes the
    // raw input back in an is_error result, and the model authors the option
    // labels. A close selection grants; any other real selection invalidates.
    if (Array.isArray(content) && !isModelReachableRecord(o)) {
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type !== 'tool_result' || !b.tool_use_id || !askIds.has(b.tool_use_id)) continue;
        if (b.is_error === true) continue;
        const s = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        if (!/have been answered/.test(s)) continue;
        let sawAnswer = false;
        let sawClose = false;
        for (const m of s.matchAll(/="([^"]*)"/g)) {
          sawAnswer = true;
          if (isClosePattern(m[1])) sawClose = true;
        }
        if (sawClose) granted = true;
        else if (sawAnswer) granted = false;
      }
    }
  }
  return granted;
}

/** The literal the user must type to approve a parked-overwrite batch. */
export const APPROVAL_PHRASE = 'apply-proposals';

/**
 * True iff the transcript carries a user's TYPED approval of the batch this nonce
 * was minted for — the authorization gate for a transcript-approved apply.
 *
 * Deliberately NOT hasUserCloseSignal. That function answers "did the user want to
 * end the session", and it accepts a correlated AskUserQuestion answer as evidence
 * (see above). Reusing it here would let a SESSION-CLOSE approval spend itself as an
 * OVERWRITE approval: different authority, different question. Two gates, two
 * matchers.
 *
 * Typed text only, and an AskUserQuestion click is refused ON PURPOSE. The model
 * authors the option labels, and it authors them AFTER it has seen the nonce — so
 * it could place `apply-proposals <nonce>` on a "no" option, on every option, or
 * under a question that asks something else entirely. A click would prove a click.
 * Typing the nonce proves the user produced THIS phrase.
 *
 * The nonce carries the freshness: it is minted (crypto-random) only once the diff
 * has been re-read from disk and shown, so a turn that predates the diff cannot
 * contain it, and `resolve` spends the challenge BEFORE it writes, so it cannot be
 * replayed.
 *
 * extractUserMessageRecords does the de-pollution: it drops `isMeta` bodies
 * (slash-command and skill text, so a doc that quotes this phrase cannot satisfy the
 * gate), `promptSource: system|sdk`, Stop-hook feedback, and `tool_result` blocks (so
 * neither a tool's output nor a Read of a file that contains the phrase counts).
 * The model's own words are role:assistant and never reach it.
 *
 * Fail-closed: no path, a nonce that is not the minted shape, or an unreadable
 * transcript all return false.
 *
 * @param {string} transcriptPath
 * @param {string} nonce hex, as minted by `proposal challenge`
 */
export function hasTypedUserApproval(transcriptPath, nonce) {
  if (!transcriptPath || typeof nonce !== 'string') return false;
  // Pin the shape rather than accept any string: a caller that passed '' or a
  // regex-ish value would otherwise turn the match into a wildcard.
  if (!/^[a-f0-9]{32,}$/.test(nonce)) return false;
  // A MESSAGE that IS the phrase, not a message that has the phrase somewhere in it.
  // Line-exactness is not enough, because the user is TOLD to type this phrase and so
  // it is natural to quote it back while hesitating:
  //
  //     I do not consent; I am only quoting the command:
  //         apply-proposals <nonce>
  //
  // Every line-level matcher reads that as approval, and the user has authorized an
  // overwrite by refusing one. The whole eligible message must be the phrase and
  // nothing else, which is the bar the TTY channel has always held (`apply <id>`,
  // alone, on the prompt). The two channels must not disagree about what consent
  // looks like.
  //
  // Measured, not assumed: across 468 eligible user records in this project's
  // transcripts, none carried a second text block and none carried injected
  // system-reminder text, so a turn whose only content is the phrase survives
  // extraction as exactly the phrase. A false negative costs a retype; a false
  // positive costs the user's file.
  const want = `${APPROVAL_PHRASE} ${nonce}`;
  const records = extractUserMessageRecords(transcriptPath, Infinity);
  return records.some((msg) => msg.trim() === want);
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
    const isInjected =
      obj.isMeta === true || obj.promptSource === 'system' || obj.promptSource === 'sdk';
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
    // `-z`: NUL-separated, verbatim paths (see commitWikiChanges). The old
    // newline/quote-strip parser left octal escapes in place, so Korean page
    // names silently failed the `pages/`·`projects/` scope match and dropped
    // out of the growth count.
    // `-z`: NUL-separated, verbatim paths (see commitWikiChanges). The old
    // newline/quote-strip parser left octal escapes in place, so Korean page
    // names silently failed the `pages/`·`projects/` scope match and dropped
    // out of the growth count.
    const porcelain = spawnSync('git', ['-C', hypoDir, 'status', '--porcelain', '-uall', '-z'], {
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
    const records = (porcelain.stdout || '').split('\0');
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      const xy = rec.slice(0, 2);
      const file = rec.slice(3); // destination path for a rename/copy
      // A rename OR copy emits two records (`to\0from`); consume the trailing `from`.
      if (xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C') i++;
      if (!inPagesScope(file)) continue;
      if (xy === '??') {
        untrackedMd.push(file);
        addedPages++;
        continue;
      }
      hasTrackedMdChange = true;
      // A copy's destination is a brand-new page, so it counts as added like `A`.
      if (xy.includes('A') || xy.includes('C')) addedPages++;
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
