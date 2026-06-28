/**
 * scripts/lib/wd-match.mjs — shared cwd ↔ working_dir project matcher.
 *
 * The four readers (resume.mjs, hooks/hypo-shared.mjs, hooks/hypo-session-start.mjs,
 * hooks/hypo-cwd-change.mjs) each used to inline the same prefix-match. This
 * module is the single source of truth they delegate the path logic to, so the
 * cross-machine basename fallback below is implemented (and tested) once.
 *
 * The cross-machine problem: a git-synced vault carries one machine's absolute
 * working_dir to every machine, so on a second machine cwd never prefix-matches
 * and cwd-first resume silently degrades to recency. The basename tier recovers
 * the match WITHOUT a synced map or a writer: when the absolute prefix fails, a
 * cwd ancestor whose directory name is a GLOBALLY unique project working_dir
 * basename identifies the project. Unique-only, so a shared repo dirname fails
 * closed back to recency (the original prefix-only behavior).
 *
 * The matcher (pickProjectByCwd) is PURE — no fs. collectProjectWorkingDirs is
 * the disk companion that builds the project universe the matcher reasons over.
 */

import { homedir } from 'os';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.mjs';

// Expand a leading `~`/`~/`, strip trailing slashes. Mirrors the inline
// expansion the readers did, kept here so every caller normalizes identically.
// Returns null for empty/falsy input.
export function normalizeWorkingDir(p) {
  if (!p) return null;
  let s = String(p).trim();
  if (s === '~') s = homedir();
  else if (s.startsWith('~/')) s = `${homedir()}/${s.slice(2)}`;
  s = s.replace(/\/+$/, '');
  return s || null;
}

// macOS (APFS/HFS+ default) and Windows match paths case-insensitively, so a
// case-only difference between cwd and a recorded working_dir is the SAME dir
// there and a genuinely different dir on Linux. Fold only on those platforms:
// on Linux folding stays off, preserving the exact original comparison.
export function isCaseInsensitiveFs(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

function casefold(s, ci) {
  return ci ? s.toLowerCase() : s;
}

// Trailing path segment (basename) without importing path — paths here are
// already normalized (no trailing slash). Returns '' for a bare root.
function lastSegment(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * Resolve which project a cwd belongs to.
 *
 * @param {{slug:string, workingDir:string|null|undefined}[]} projects
 *   EVERY project with an index.md (the universe). The basename-uniqueness gate
 *   is computed over all of them, so an unrelated project sharing a dirname
 *   correctly disqualifies the basename tier (fail closed).
 * @param {string} cwd  process.cwd()
 * @param {object} [opts]
 * @param {string[]|null} [opts.eligible]  restrict the ANSWER to these slugs
 *   (e.g. resume's hot.md rows); uniqueness is still judged over all `projects`.
 *   null = any project is an acceptable answer.
 * @param {string|null} [opts.realpathCwd]  realpathSync(cwd), if the caller
 *   resolved symlinks. Tried in addition to the raw cwd.
 * @param {boolean} [opts.caseInsensitive]  override FS case sensitivity (tests).
 * @returns {string|null} matched slug, or null when nothing matches.
 */
export function pickProjectByCwd(projects, cwd, opts = {}) {
  const { eligible = null, realpathCwd = null, caseInsensitive = isCaseInsensitiveFs() } = opts;
  if (!cwd && !realpathCwd) return null;

  const eligibleSet = eligible ? new Set(eligible) : null;
  const isEligible = (slug) => !eligibleSet || eligibleSet.has(slug);

  // Universe of normalized (slug, path) entries with a real working_dir.
  const entries = [];
  for (const p of projects) {
    const path = normalizeWorkingDir(p.workingDir);
    if (path) entries.push({ slug: p.slug, path });
  }
  if (entries.length === 0) return null;

  // cwd variants in PRIORITY order: raw first, realpath (symlink-resolved) only
  // as a fallback. A raw-cwd match must not be overridden by a realpath match
  // (preserves the original single-cwd behavior; realpath only rescues misses).
  const cwds = [];
  for (const c of [cwd, realpathCwd]) {
    const n = normalizeWorkingDir(c);
    if (n && !cwds.includes(n)) cwds.push(n);
  }

  // ── Tier 1: longest absolute prefix (the original behavior) ────────────────
  // cwd === path or cwd under path/. Longest path wins so /repo/sub beats /repo.
  // The FIRST cwd variant that yields any prefix match wins (raw before realpath).
  for (const c of cwds) {
    const cf = casefold(c, caseInsensitive);
    let bestSlug = null;
    let bestLen = -1;
    for (const e of entries) {
      if (!isEligible(e.slug)) continue;
      const pf = casefold(e.path, caseInsensitive);
      if ((cf === pf || cf.startsWith(`${pf}/`)) && e.path.length > bestLen) {
        bestLen = e.path.length;
        bestSlug = e.slug;
      }
    }
    if (bestSlug) return bestSlug;
  }

  // ── Tier 2: globally-unique basename of a cwd ancestor (cross-machine) ─────
  // Count basenames across the WHOLE universe. A basename is usable only when
  // exactly one project carries it, so a shared dirname falls through to null.
  const byBasename = new Map(); // folded basename -> { slug, count }
  for (const e of entries) {
    const b = casefold(lastSegment(e.path), caseInsensitive);
    if (!b) continue;
    const hit = byBasename.get(b);
    if (hit) hit.count += 1;
    else byBasename.set(b, { slug: e.slug, count: 1 });
  }

  // For each cwd variant (raw first), collect every ancestor whose basename is a
  // globally-unique, eligible project basename. Use it ONLY when the whole chain
  // points at exactly ONE project: if two different projects match along the
  // path (e.g. cwd /x/monorepo/api with both `monorepo` and `api` registered),
  // cwd alone can't disambiguate, so decline and let the caller fall back to
  // recency (fail closed, no wrong-project guess).
  for (const c of cwds) {
    const matched = new Set();
    let cur = c;
    while (cur && cur.includes('/')) {
      const b = casefold(lastSegment(cur), caseInsensitive);
      const hit = b && byBasename.get(b);
      if (hit && hit.count === 1 && isEligible(hit.slug)) matched.add(hit.slug);
      cur = cur.slice(0, cur.lastIndexOf('/'));
    }
    if (matched.size === 1) return [...matched][0];
  }
  return null;
}

/**
 * Scan projects/<slug>/index.md and return [{slug, workingDir}] for every real
 * project. Skips `_template` and dirs without an index.md. The full set is the
 * uniqueness universe for tier 2, so callers should pass ALL projects here even
 * when they later restrict the answer via `opts.eligible`.
 *
 * @param {string} hypoDir
 * @returns {{slug:string, workingDir:string|null}[]}
 */
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
      const fm = parseFrontmatter(readFileSync(indexPath, 'utf-8'));
      workingDir = fm?.working_dir ?? null;
    } catch {
      workingDir = null;
    }
    out.push({ slug, workingDir });
  }
  return out;
}
