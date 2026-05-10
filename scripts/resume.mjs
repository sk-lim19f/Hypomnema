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
 *   --hypo-dir=<path>     Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --project=<name>      Project name (default: most recently active from hot.md)
 *   --json                Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, project: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir='))  args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--project=')) args.project = arg.slice(10);
    else if (arg === '--json')           args.json    = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── active project from hot.md ───────────────────────────────────────────────

function resolveActiveProject(hypoDir) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return null;

  const content = readFileSync(hotPath, 'utf-8');
  // Canonical hot.md uses wikilinks: | name | date | [[projects/slug/hot]] |
  // Pick the most recent row by the date column when present.
  const wikiRows = [...content.matchAll(/\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g)]
    .map(m => ({ name: m[1].trim(), date: m[2] || '', slug: m[3] }));
  if (wikiRows.length > 0) {
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
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
    const ssPath = join(projectsDir, p, 'session-state.md');
    if (!existsSync(ssPath)) continue;
    const mtime = statSync(ssPath).mtimeMs;
    if (mtime > latestMtime) { latestMtime = mtime; latest = p; }
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

const project = args.project || resolveActiveProject(args.hypoDir);

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
