#!/usr/bin/env node
/**
 * Hypomnema stats script
 *
 * Reports statistics about the wiki: page counts by type, project count,
 * source count, ADR count, and last activity date.
 *
 * Usage:
 *   node scripts/stats.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --json              Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectMdFiles(dir, acc = [], hypoDir = '', ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (hypoDir && isIgnored(full, hypoDir, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectMdFiles(full, acc, hypoDir, ignorePatterns);
    else if (extname(entry) === '.md') acc.push(full);
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

function listDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => {
    if (e.startsWith('.')) return false;
    return statSync(join(dir, e)).isDirectory();
  });
}

function getLastActivity(hypoDir) {
  const logPath = join(hypoDir, 'log.md');
  if (!existsSync(logPath)) return null;
  const content = readFileSync(logPath, 'utf-8');
  const dates = [...content.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
  return dates.length ? dates[dates.length - 1] : null;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const pageFiles = collectMdFiles(join(args.hypoDir, 'pages'), [], args.hypoDir, ignorePatterns);
const projects = listDirs(join(args.hypoDir, 'projects'));
const sources = existsSync(join(args.hypoDir, 'sources'))
  ? readdirSync(join(args.hypoDir, 'sources')).filter(
      (e) =>
        !e.startsWith('.') &&
        !isIgnored(join(args.hypoDir, 'sources', e), args.hypoDir, ignorePatterns),
    )
  : [];

const typeCounts = {};
let missingFrontmatter = 0;

for (const f of pageFiles) {
  let content;
  try {
    content = readFileSync(f, 'utf-8');
  } catch {
    continue;
  }
  const fm = parseFrontmatter(content);
  if (!fm) {
    missingFrontmatter++;
    continue;
  }
  const t = fm.type || 'unknown';
  typeCounts[t] = (typeCounts[t] || 0) + 1;
}

let adrCount = 0;
for (const p of projects) {
  const decisionsDir = join(args.hypoDir, 'projects', p, 'decisions');
  if (existsSync(decisionsDir)) {
    adrCount += readdirSync(decisionsDir).filter((f) => f.endsWith('.md')).length;
  }
}

const lastActivity = getLastActivity(args.hypoDir);

const stats = {
  pages: { total: pageFiles.length, byType: typeCounts, missingFrontmatter },
  projects: projects.length,
  sources: sources.length,
  adrs: adrCount,
  lastActivity,
};

if (args.json) {
  console.log(JSON.stringify(stats, null, 2));
} else {
  console.log(`Pages:    ${pageFiles.length} total`);
  const typeEntries = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length) {
    console.log(`  by type: ${typeEntries.map(([t, n]) => `${t} (${n})`).join(', ')}`);
  }
  if (missingFrontmatter) {
    console.log(`  missing frontmatter: ${missingFrontmatter}`);
  }
  console.log(`Projects: ${projects.length}`);
  console.log(`Sources:  ${sources.length}`);
  console.log(`ADRs:     ${adrCount}`);
  if (lastActivity) console.log(`Last activity: ${lastActivity}`);
}
