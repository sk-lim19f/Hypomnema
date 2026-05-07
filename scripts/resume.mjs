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
 *   --wiki-dir=<path>     Wiki root (default: resolved via HYPO_DIR / hypo-config.md / ~/wiki)
 *   --project=<name>      Project name (default: most recently active from hot.md)
 *   --json                Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wikiDir: null, project: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir='))  args.wikiDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--project=')) args.project = arg.slice(10);
    else if (arg === '--json')           args.json    = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

// ── active project from hot.md ───────────────────────────────────────────────

function resolveActiveProject(wikiDir) {
  const hotPath = join(wikiDir, 'hot.md');
  if (!existsSync(hotPath)) return null;

  const content = readFileSync(hotPath, 'utf-8');
  // look for table rows with project links: | [name](projects/name/...) | ...
  const tableRow = content.match(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/);
  if (tableRow) return tableRow[2];

  // fallback: most recently modified project with a session-state.md
  const projectsDir = join(wikiDir, 'projects');
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

function readSessionState(wikiDir, project) {
  const ssPath = join(wikiDir, 'projects', project, 'session-state.md');
  if (!existsSync(ssPath)) return null;
  return readFileSync(ssPath, 'utf-8');
}

function readHot(wikiDir, project) {
  const hotPath = join(wikiDir, 'projects', project, 'hot.md');
  if (!existsSync(hotPath)) return null;
  return readFileSync(hotPath, 'utf-8');
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const project = args.project || resolveActiveProject(args.wikiDir);

if (!project) {
  console.error('Error: no active project found. Use --project=<name> or create a hot.md entry.');
  process.exit(1);
}

const sessionState = readSessionState(args.wikiDir, project);
if (!sessionState) {
  console.error(`Error: no session-state.md found for project "${project}"`);
  process.exit(1);
}

const hotContent = readHot(args.wikiDir, project);

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
