#!/usr/bin/env node
/**
 * Hypomnema lint script
 *
 * Validates wiki pages for frontmatter correctness and broken wikilinks.
 *
 * Usage:
 *   node scripts/lint.mjs [options]
 *
 * Options:
 *   --wiki-dir=<path>   Wiki root (default: resolved via HYPO_DIR / hypo-config.md / ~/wiki)
 *   --json              Output results as JSON
 *   --fix               Auto-add missing `updated` field (safe repairs only)
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wikiDir: null, json: false, fix: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir=')) args.wikiDir = expandHome(arg.slice(11));
    else if (arg === '--json')         args.json = true;
    else if (arg === '--fix')          args.fix  = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

// ── frontmatter parser ────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

// ── page collector ────────────────────────────────────────────────────────────

function collectPages(dir, root, pages = []) {
  if (!existsSync(dir)) return pages;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectPages(full, root, pages);
    } else if (extname(entry) === '.md' && !entry.startsWith('.')) {
      pages.push({ path: full, rel: relative(root, full) });
    }
  }
  return pages;
}

// ── slug map ─────────────────────────────────────────────────────────────────

function buildSlugMap(pages) {
  const map = new Set();
  for (const { rel } of pages) {
    map.add(rel.replace(/\.md$/, '').replace(/\\/g, '/'));
    map.add(basename(rel, '.md'));
  }
  return map;
}

// ── wikilink extractor ────────────────────────────────────────────────────────

function extractWikilinks(content) {
  const links = [];
  for (const m of content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)) {
    links.push(m[1].trim());
  }
  return links;
}

// ── lint checks ───────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['title', 'type'];
const VALID_TYPES = [
  'concept', 'source-summary', 'entity', 'tool-eval', 'prompt-pattern',
  'playbook', 'learning', 'tip', 'feedback', 'reference', 'synthesis',
  'weekly-journal', 'prd', 'adr', 'session-log', 'session-state',
  'project-index', 'postmortem', 'open-questions', 'schema', 'source',
];

const issues = [];

function issue(severity, rel, msg, fullPath = null) {
  issues.push({ severity, file: rel, message: msg, path: fullPath });
}

function lintPage({ path, rel }, slugMap) {
  let content;
  try { content = readFileSync(path, 'utf-8'); } catch { return; }

  if (!content.match(/^---\r?\n/)) {
    issue('warn', rel, 'No frontmatter found');
    return;
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    issue('error', rel, 'Malformed frontmatter (unclosed ---)');
    return;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) issue('error', rel, `Missing required frontmatter field: ${field}`);
  }

  if (fm.type && !VALID_TYPES.includes(fm.type)) {
    issue('warn', rel, `Unknown type: "${fm.type}"`);
  }

  if (!fm.updated) {
    issue('warn', rel, 'Missing frontmatter field: updated', path);
  }

  for (const link of extractWikilinks(content)) {
    if (!slugMap.has(link) && !slugMap.has(link.replace(/\//g, path.sep))) {
      issue('warn', rel, `Broken wikilink: [[${link}]]`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const scanDirs = ['pages', 'projects'].map(d => join(args.wikiDir, d));
const pages = scanDirs.flatMap(d => collectPages(d, args.wikiDir));
const slugMap = buildSlugMap(pages);

for (const page of pages) lintPage(page, slugMap);

if (args.fix) {
  const today = new Date().toISOString().slice(0, 10);
  const fixed = new Set();
  for (const iss of issues) {
    if (iss.severity === 'warn' && iss.message === 'Missing frontmatter field: updated' && iss.path) {
      const content = readFileSync(iss.path, 'utf-8');
      const fmMatch = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
      if (fmMatch) {
        const lineEnding = fmMatch[0].includes('\r\n') ? '\r\n' : '\n';
        const closingTag = `${lineEnding}---`;
        const insertAt = fmMatch.index + fmMatch[0].lastIndexOf(closingTag);
        if (insertAt < 0) continue;
        const fixedContent = content.slice(0, insertAt) + `${lineEnding}updated: ${today}` + content.slice(insertAt);
        writeFileSync(iss.path, fixedContent);
        fixed.add(iss.path);
      }
    }
  }
  if (fixed.size > 0) {
    issues.splice(0, issues.length, ...issues.filter(
      i => !(i.severity === 'warn' && i.message === 'Missing frontmatter field: updated' && fixed.has(i.path))
    ));
  }
}

const errors = issues.filter(i => i.severity === 'error');
const warns  = issues.filter(i => i.severity === 'warn');

if (args.json) {
  const toOut = ({ severity, file, message }) => ({ severity, file, message });
  console.log(JSON.stringify({ ok: errors.length === 0, errors: errors.map(toOut), warns: warns.map(toOut), total: issues.length }, null, 2));
} else {
  if (issues.length === 0) {
    console.log('✓ No lint issues found');
  } else {
    for (const { severity, file, message } of issues) {
      const icon = severity === 'error' ? '✗' : '⚠';
      console.log(`${icon} ${file}: ${message}`);
    }
    console.log(`\n${errors.length} error(s), ${warns.length} warning(s)`);
  }
}

process.exit(errors.length > 0 ? 1 : 0);
