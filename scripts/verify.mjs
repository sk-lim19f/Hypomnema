#!/usr/bin/env node
/**
 * Hypomnema verify script
 *
 * Checks verify_by and verify_by_date fields across wiki pages.
 * More detailed than the doctor check: shows the actual verify_by questions
 * and groups results by status.
 *
 * Usage:
 *   node scripts/verify.mjs [options]
 *
 * Options:
 *   --wiki-dir=<path>   Wiki root (default: resolved via HYPO_DIR / hypo-config.md / ~/wiki)
 *   --file=<path>       Check a single file only
 *   --json              Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wikiDir: null, file: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir=')) args.wikiDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--file='))    args.file   = expandHome(arg.slice(7));
    else if (arg === '--json')             args.json   = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectMdFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectMdFiles(full, acc);
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
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/\s*#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return fm;
}

const VERIFIED_TYPES = new Set(['adr', 'page', 'learning', 'concept', 'playbook', 'tool-eval']);

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
const today = new Date().toISOString().slice(0, 10);

let files;
if (args.file) {
  files = [args.file];
} else {
  const scanDirs = ['pages', 'projects'].map(d => join(args.wikiDir, d));
  files = scanDirs.flatMap(d => collectMdFiles(d));
}

const overdue  = [];
const upcoming = [];
const missing  = [];
const ok       = [];

for (const file of files) {
  let content;
  try { content = readFileSync(file, 'utf-8'); } catch { continue; }
  const fm = parseFrontmatter(content);
  if (!fm) continue;

  const type = fm.type || '';
  if (!VERIFIED_TYPES.has(type)) continue;

  const rel = args.wikiDir ? relative(args.wikiDir, file) : file;
  const entry = {
    file: rel,
    title: fm.title || rel,
    type,
    verify_by: fm.verify_by || null,
    verify_by_date: fm.verify_by_date || null,
  };

  if (!fm.verify_by) {
    missing.push(entry);
  } else if (fm.verify_by_date && /^\d{4}-\d{2}-\d{2}$/.test(fm.verify_by_date)) {
    const daysUntil = Math.ceil((new Date(fm.verify_by_date) - new Date(today)) / 86400000);
    if (fm.verify_by_date < today) {
      overdue.push({ ...entry, daysOverdue: -daysUntil });
    } else if (daysUntil <= 14) {
      upcoming.push({ ...entry, daysUntil });
    } else {
      ok.push(entry);
    }
  } else {
    ok.push(entry);
  }
}

if (args.json) {
  console.log(JSON.stringify({ overdue, upcoming, missing, ok }, null, 2));
  process.exit(overdue.length > 0 ? 1 : 0);
}

const total = overdue.length + upcoming.length + missing.length + ok.length;
console.log(`Scanned ${total} tracked page(s)\n`);

if (overdue.length > 0) {
  console.log(`✗ Overdue (${overdue.length}):`);
  for (const p of overdue) {
    console.log(`  ${p.file}  [${p.daysOverdue}d overdue]`);
    console.log(`    verify_by: ${p.verify_by}`);
  }
  console.log('');
}

if (upcoming.length > 0) {
  console.log(`⚠ Due soon (${upcoming.length}):`);
  for (const p of upcoming) {
    console.log(`  ${p.file}  [in ${p.daysUntil}d, ${p.verify_by_date}]`);
    console.log(`    verify_by: ${p.verify_by}`);
  }
  console.log('');
}

if (missing.length > 0) {
  console.log(`⚠ Missing verify_by (${missing.length}):`);
  for (const p of missing) console.log(`  ${p.file}`);
  console.log('');
}

if (ok.length > 0 && overdue.length === 0 && upcoming.length === 0) {
  console.log(`✓ All ${ok.length} page(s) verified and up to date`);
}

const summary = [
  overdue.length  ? `${overdue.length} overdue`  : '',
  upcoming.length ? `${upcoming.length} due soon` : '',
  missing.length  ? `${missing.length} missing verify_by` : '',
  ok.length       ? `${ok.length} ok` : '',
].filter(Boolean).join(', ');

console.log(`Result: ${summary || 'nothing to verify'}`);

if (overdue.length > 0) process.exit(1);
