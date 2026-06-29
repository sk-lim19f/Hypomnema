#!/usr/bin/env node
/**
 * Hypomnema resume script
 *
 * Reads the session-state.md for a project and outputs the next-tasks section.
 * Used by /hypo:resume to surface what was left off before Claude continues.
 *
 * Usage:
 *   node scripts/resume.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>     Hypomnema root. When omitted, resolveHypoRoot()
 *                         (see lib/hypo-root.mjs) resolves it in priority order:
 *                           1. $HYPO_DIR if set — returned immediately; the
 *                              hypo-config.md scan below is then skipped.
 *                           2. else the first of 7 fixed candidates
 *                              (~/{hypomnema,wiki,notes,knowledge},
 *                              ~/Documents/{hypomnema,wiki,notes}) that contains
 *                              a hypo-config.md marker.
 *                           3. else the default ~/hypomnema.
 *   --project=<name>      Project name. When omitted, resolveActiveProject()
 *                         prefers the project whose working_dir contains the
 *                         current directory (cwd-first), and only falls back to
 *                         the most recently active hot.md row when nothing under
 *                         cwd matches.
 *   --json                Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { join } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { pickProjectByCwd, collectProjectWorkingDirs } from './lib/wd-match.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, project: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--project=')) args.project = arg.slice(10);
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── active project from hot.md ───────────────────────────────────────────────

// Parse a single frontmatter scalar (mirrors the hook helpers in
// hypo-session-start.mjs / hypo-cwd-change.mjs — kept local per the hook
// self-contained convention rather than shared, to avoid script↔hook coupling).
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

// Return the project (among `slugs`) that owns cwd: a longest-prefix
// working_dir match, or — when no absolute path matches because the vault was
// synced from another machine — a cwd ancestor whose directory name is a
// globally-unique project basename. Uniqueness is judged over EVERY project on
// disk (not just `slugs`), so a shared dirname declines and falls back to
// recency. resume gives this authority over recency: a cwd↔project match wins
// regardless of which hot.md row is newest.
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

// When cwd is set but no project's working_dir matches it, resume falls back to
// recency silently — the user lands in an unrelated project with no clue why.
// Emit a one-line stderr diagnostic (stdout `Project:`/`--json` contract is untouched)
// naming why each candidate failed: missing index.md, missing working_dir, or a
// working_dir that simply doesn't contain cwd. Logic mirrors pickByCwd's lookup.
function warnCwdFallback(hypoDir, slugs, cwd) {
  // No cwd, or no candidate rows at all (fresh-init / no real project): there is
  // nothing to "fall back to most-recent" toward, so stay silent — the caller
  // surfaces the real "no active project found" error instead.
  if (!cwd || slugs.length === 0) return;
  const reasons = [];
  for (const slug of slugs) {
    const indexPath = join(hypoDir, 'projects', slug, 'index.md');
    if (!existsSync(indexPath)) {
      reasons.push(`${slug} (no index.md)`);
      continue;
    }
    const wd = parseFrontmatterField(readFileSync(indexPath, 'utf-8'), 'working_dir');
    if (!wd) reasons.push(`${slug} (no working_dir)`);
    // else: has working_dir but didn't contain cwd — expected, not flagged.
  }
  const detail = reasons.length ? ` Candidates missing cwd metadata: ${reasons.join(', ')}.` : '';
  process.stderr.write(
    `note: cwd "${cwd}" matched no project working_dir; falling back to most-recent.${detail}\n`,
  );
}

function resolveActiveProject(hypoDir, cwd = null) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return null;

  // Strip HTML comments before parsing so the canonical-format example row
  // in templates/hot.md (`<!-- Row format: ... -->`) is not picked up as data.
  const content = readFileSync(hotPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
  // Canonical hot.md uses wikilinks: | name | date | [[projects/slug/hot]] |
  // Pick the most recent row by the date column when present.
  const wikiRows = [
    ...content.matchAll(
      /\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g,
    ),
  ].map((m) => ({ name: m[1].trim(), date: m[2] || '', slug: m[3] }));
  if (wikiRows.length > 0) {
    // cwd-first: a cwd↔working_dir match wins over recency, across
    // ALL rows (not just a same-date tie). The user is physically in that
    // project, so cwd is a stronger intent signal than "some other project was
    // touched more recently". This reverses the earlier tie-breaker-only
    // semantics now that resume=cwd-positive. Tradeoff: a stale cwd
    // match can mask a genuinely newer project; `--project` overrides. close
    // callers pass null → recency path below (resume=cwd-positive / close=no-pick).
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
    if (cwd)
      warnCwdFallback(
        hypoDir,
        wikiRows.map((r) => r.slug),
        cwd,
      );
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
    return wikiRows[0].slug;
  }
  // Legacy markdown-link rows: | [name](projects/name/...) | ...
  const mdSlugs = [...content.matchAll(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/g)].map((m) => m[2]);
  if (mdSlugs.length > 0) {
    if (cwd) {
      const picked = pickByCwd(hypoDir, mdSlugs, cwd);
      if (picked) return picked;
      warnCwdFallback(hypoDir, mdSlugs, cwd);
    }
    return mdSlugs[0]; // legacy: first table row
  }

  // fallback: a cwd-matched project, else the most recently modified one with a
  // session-state.md. (mtime is only a heuristic once hot.md can't name a
  // project — an explicit working_dir match is safer, so cwd-first here too.)
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return null;

  // Skip the scaffold project init.mjs writes — it isn't a real active project.
  const candidates = readdirSync(projectsDir).filter(
    (p) => p !== '_template' && existsSync(join(projectsDir, p, 'session-state.md')),
  );
  if (cwd) {
    const picked = pickByCwd(hypoDir, candidates, cwd);
    if (picked) return picked;
    warnCwdFallback(hypoDir, candidates, cwd);
  }
  let latest = null;
  let latestMtime = 0;
  for (const p of candidates) {
    const mtime = statSync(join(projectsDir, p, 'session-state.md')).mtimeMs;
    if (mtime > latestMtime) {
      latestMtime = mtime;
      latest = p;
    }
  }
  return latest;
}

// ── read session state ────────────────────────────────────────────────────────

function readSessionState(hypoDir, project) {
  const ssPath = join(hypoDir, 'projects', project, 'session-state.md');
  if (!existsSync(ssPath)) return null;
  return readFileSync(ssPath, 'utf-8');
}

function readHot(hypoDir, project) {
  const hotPath = join(hypoDir, 'projects', project, 'hot.md');
  if (!existsSync(hotPath)) return null;
  return readFileSync(hotPath, 'utf-8');
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const project = args.project || resolveActiveProject(args.hypoDir, process.cwd());

if (!project) {
  console.error('Error: no active project found. Use --project=<name> or create a hot.md entry.');
  process.exit(1);
}

const sessionState = readSessionState(args.hypoDir, project);
if (!sessionState) {
  console.error(`Error: no session-state.md found for project "${project}"`);
  process.exit(1);
}

const hotContent = readHot(args.hypoDir, project);

if (args.json) {
  console.log(JSON.stringify({ project, sessionState, hot: hotContent }, null, 2));
  process.exit(0);
}

console.log(`Project: ${project}`);
console.log(`State: projects/${project}/session-state.md\n`);
console.log('─'.repeat(60));
console.log(sessionState.trim());

if (hotContent) {
  console.log('\n' + '─'.repeat(60));
  console.log('Background (hot.md):');
  console.log(hotContent.trim());
}
