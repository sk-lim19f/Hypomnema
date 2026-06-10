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
 *   --project=<name>      Project name (default: most recently active from hot.md)
 *   --json                Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';

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

// Among `slugs`, return the one whose projects/<slug>/index.md `working_dir`
// is the LONGEST prefix of cwd (so /repo/sub wins over /repo). Returns null
// when cwd is falsy or matches none. Used only as a same-date tie-breaker.
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
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
    // Same-date tie-break: when the top date is shared by >1 row,
    // prefer the project whose working_dir contains cwd. No cwd / no match →
    // keep the stable-sort winner (the legacy "first table row" behavior).
    const topDate = wikiRows[0].date;
    const tied = wikiRows.filter((r) => r.date === topDate);
    if (cwd && tied.length > 1) {
      const picked = pickByCwd(
        hypoDir,
        tied.map((r) => r.slug),
        cwd,
      );
      if (picked) return picked;
    }
    return wikiRows[0].slug;
  }
  // Legacy markdown-link rows: | [name](projects/name/...) | ...
  const mdRow = content.match(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/);
  if (mdRow) return mdRow[2];

  // fallback: most recently modified project with a session-state.md
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return null;

  let latest = null;
  let latestMtime = 0;
  for (const p of readdirSync(projectsDir)) {
    // Skip the scaffold project init.mjs writes — it isn't a real active project.
    if (p === '_template') continue;
    const ssPath = join(projectsDir, p, 'session-state.md');
    if (!existsSync(ssPath)) continue;
    const mtime = statSync(ssPath).mtimeMs;
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
