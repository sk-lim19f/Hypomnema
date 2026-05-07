#!/usr/bin/env node
/**
 * Hypomnema query script
 *
 * Full-text search across wiki pages and projects.
 * Returns matching files with a context excerpt and frontmatter summary.
 * Used by /hypo:query to surface relevant pages before Claude synthesizes.
 *
 * Usage:
 *   node scripts/query.mjs --q="<search terms>" [options]
 *
 * Options:
 *   --wiki-dir=<path>   Wiki root (default: resolved via HYPO_DIR / hypo-config.md / ~/wiki)
 *   --q=<query>         Search query (required)
 *   --limit=<n>         Max results (default: 10)
 *   --json              Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';
import { loadWikiIgnore, isIgnored } from './lib/wiki-ignore.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wikiDir: null, query: null, limit: 10, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir=')) args.wikiDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--q='))     args.query  = arg.slice(4);
    else if (arg.startsWith('--limit=')) args.limit  = parseInt(arg.slice(8), 10) || 10;
    else if (arg === '--json')           args.json   = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectMdFiles(dir, root, acc = [], ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectMdFiles(full, root, acc, ignorePatterns);
    else if (extname(entry) === '.md') acc.push({ path: full, rel: relative(root, full) });
  }
  return acc;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function scoreAndExcerpt(content, terms) {
  const lower = content.toLowerCase();
  let score = 0;
  for (const t of terms) score += (lower.match(new RegExp(escapeRegex(t), 'g')) || []).length;

  // find first matching line for excerpt
  const lines = content.split('\n');
  let excerpt = '';
  for (const line of lines) {
    if (terms.some(t => line.toLowerCase().includes(t))) {
      excerpt = line.trim().slice(0, 120);
      break;
    }
  }
  return { score, excerpt };
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (!args.query) {
  console.error('Error: --q=<query> is required');
  process.exit(1);
}

const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
const ignorePatterns = loadWikiIgnore(args.wikiDir);
const scanDirs = ['pages', 'projects'].map(d => join(args.wikiDir, d));
const files = scanDirs.flatMap(d => collectMdFiles(d, args.wikiDir, [], ignorePatterns));

const results = [];

for (const { path, rel } of files) {
  let content;
  try { content = readFileSync(path, 'utf-8'); } catch { continue; }
  const { score, excerpt } = scoreAndExcerpt(content, terms);
  if (score === 0) continue;
  const fm = parseFrontmatter(content);
  results.push({ slug: rel.replace(/\.md$/, ''), title: fm.title || rel, type: fm.type || '', score, excerpt });
}

results.sort((a, b) => b.score - a.score);
const top = results.slice(0, args.limit);

if (args.json) {
  console.log(JSON.stringify(top, null, 2));
} else {
  if (top.length === 0) {
    console.log(`No results for: ${args.query}`);
  } else {
    console.log(`Found ${results.length} result(s) for "${args.query}" (showing ${top.length}):\n`);
    for (const r of top) {
      console.log(`[[${r.slug}]] — ${r.title}${r.type ? ` (${r.type})` : ''} [score: ${r.score}]`);
      if (r.excerpt) console.log(`  ${r.excerpt}`);
    }
  }
}
