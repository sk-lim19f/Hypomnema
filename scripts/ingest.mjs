#!/usr/bin/env node
/**
 * Hypomnema ingest helper script
 *
 * Lists files in sources/ that have no corresponding source-summary page,
 * and reports pages that reference missing source files.
 * Used by /hypo:ingest to surface what needs ingestion before Claude synthesizes.
 *
 * Usage:
 *   node scripts/ingest.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --json              Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json')         args.json = true;
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
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const sourcesDir = join(args.hypoDir, 'sources');
const allSources = existsSync(sourcesDir)
  ? readdirSync(sourcesDir).filter(e => !e.startsWith('.') && !statSync(join(sourcesDir, e)).isDirectory() && !isIgnored(join(sourcesDir, e), args.hypoDir, ignorePatterns))
  : [];

// collect all source: references in wiki pages
const pageFiles = collectMdFiles(join(args.hypoDir, 'pages'), [], args.hypoDir, ignorePatterns);
const referencedSources = new Set();

for (const f of pageFiles) {
  let content;
  try { content = readFileSync(f, 'utf-8'); } catch { continue; }
  const fm = parseFrontmatter(content);
  if (fm.source && !fm.source.startsWith('session:')) {
    referencedSources.add(fm.source);
  }
}

// sources with no summary page
const orphaned = allSources.filter(s => {
  const slug = basename(s, extname(s));
  return !referencedSources.has(s) && !referencedSources.has(slug);
});

// pages referencing sources that don't exist on disk
const missingSource = [];
for (const f of pageFiles) {
  let content;
  try { content = readFileSync(f, 'utf-8'); } catch { continue; }
  const fm = parseFrontmatter(content);
  if (!fm.source || fm.source.startsWith('session:')) continue;
  const sourceFile = join(sourcesDir, fm.source);
  const sourceFileWithExt = allSources.find(s => s === fm.source || basename(s, extname(s)) === fm.source);
  if (!sourceFileWithExt && !existsSync(sourceFile)) {
    missingSource.push({ page: f, source: fm.source });
  }
}

if (args.json) {
  console.log(JSON.stringify({
    totalSources: allSources.length,
    orphaned,
    missingSource,
  }, null, 2));
} else {
  console.log(`Sources: ${allSources.length} total`);

  if (orphaned.length === 0) {
    console.log('✓ All sources have a corresponding source-summary page');
  } else {
    console.log(`\n⊘ ${orphaned.length} source(s) not yet ingested:`);
    for (const s of orphaned) console.log(`  sources/${s}`);
  }

  if (missingSource.length > 0) {
    console.log(`\n⚠ ${missingSource.length} page(s) reference a missing source file:`);
    for (const { page, source } of missingSource) {
      console.log(`  ${page}  →  source: ${source}`);
    }
  }

  if (orphaned.length > 0) {
    console.log('\nRun /hypo:ingest to synthesize the listed sources into wiki pages.');
  }
}
