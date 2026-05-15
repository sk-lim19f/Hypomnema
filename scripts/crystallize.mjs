#!/usr/bin/env node
/**
 * Hypomnema crystallize script
 *
 * Finds synthesis candidates: pages that share tags, unlinked pages,
 * and draft pages that could be crystallized into stable knowledge.
 * Used by /hypo:crystallize to surface what Claude should synthesize.
 *
 * Usage:
 *   node scripts/crystallize.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>        Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --min-group=<n>          Min pages per tag group to report (default: 2)
 *   --check-session-close    Verify the strict session-close memory files — 5 mandatory + open-questions conditional (fix #17)
 *   --json                   Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';
import { sessionCloseFileStatus } from '../hooks/hypo-shared.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, minGroup: 2, json: false, checkSessionClose: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir='))    args.hypoDir  = expandHome(arg.slice(11));
    else if (arg.startsWith('--min-group=')) args.minGroup = parseInt(arg.slice(12), 10) || 2;
    else if (arg === '--check-session-close') args.checkSessionClose = true;
    else if (arg === '--json')             args.json     = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── session-close check (fix #17, spec §5.2.7 / §8.3) ────────────────────────
// Mirrors the hard gate in hypo-personal-check.mjs so the /hypo:crystallize
// flow can self-verify before /compact triggers PreCompact.

function runSessionCloseCheck(args) {
  const status = sessionCloseFileStatus(args.hypoDir);

  if (args.json) {
    console.log(JSON.stringify({
      ok: status.ok,
      project: status.project,
      dates: status.dates,
      stale: status.stale,
      missing: status.missing,
    }, null, 2));
    process.exit(status.ok ? 0 : 1);
  }

  const proj = status.project || '(unresolved)';
  console.log(`Session-close check (project: ${proj}, date: ${status.dates.join(' / ')}):\n`);

  const required = status.project ? [
    `projects/${status.project}/session-state.md`,
    `projects/${status.project}/hot.md`,
    'hot.md',
    `projects/${status.project}/session-log/${status.dates[0].slice(0, 7)}.md`,
    'log.md',
  ] : [];
  for (const f of required) {
    const bad = status.missing.includes(f) ? 'missing' : status.stale.includes(f) ? 'stale' : '';
    console.log(`  ${bad ? '✗' : '✓'} ${f}${bad ? ` — ${bad}` : ''}`);
  }
  // Surface anything not covered by the canonical list (e.g. unresolved project).
  for (const f of [...status.missing, ...status.stale]) {
    if (!required.includes(f)) console.log(`  ✗ ${f}`);
  }
  console.log('');
  console.log(status.ok
    ? '✓ All required memory files updated this session. (open-questions.md: conditional, not checked)'
    : '✗ Session close incomplete — update the files marked above, then retry.');
  process.exit(status.ok ? 0 : 1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectPages(dir, root, acc = [], ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectPages(full, root, acc, ignorePatterns);
    else if (extname(entry) === '.md') {
      acc.push({ path: full, rel: relative(root, full) });
    }
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
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function parseTags(fm) {
  if (!fm.tags) return [];
  const raw = fm.tags.trim().replace(/^\[|\]$/g, '');
  return raw.split(',').map(t => t.trim()).filter(Boolean);
}

function extractWikilinks(content) {
  return [...content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)].map(m => m[1].trim());
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.checkSessionClose) {
  runSessionCloseCheck(args);   // exits
}

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const pagesDir = join(args.hypoDir, 'pages');
const pages = collectPages(pagesDir, args.hypoDir, [], ignorePatterns);

const tagGroups  = {};  // tag → [{ slug, title }]
const unlinked   = [];  // pages with no outbound wikilinks
const drafts     = [];  // pages tagged draft

for (const { path, rel } of pages) {
  let content;
  try { content = readFileSync(path, 'utf-8'); } catch { continue; }
  const fm = parseFrontmatter(content);
  if (!fm) continue;

  const slug  = rel.replace(/\.md$/, '');
  const title = fm.title || slug;
  const tags  = parseTags(fm);

  // tag groups
  for (const tag of tags) {
    if (!tagGroups[tag]) tagGroups[tag] = [];
    tagGroups[tag].push({ slug, title });
  }

  // draft detection
  if (tags.includes('draft') || fm.confidence === 'speculative') {
    drafts.push({ slug, title, confidence: fm.confidence });
  }

  // unlinked (no outbound wikilinks in body)
  const body  = content.replace(/^---[\s\S]*?---/, '');
  const links = extractWikilinks(body);
  if (links.length === 0) unlinked.push({ slug, title });
}

// filter tag groups by min-group
const synthesisGroups = Object.entries(tagGroups)
  .filter(([, pages]) => pages.length >= args.minGroup)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([tag, pages]) => ({ tag, pages }));

if (args.json) {
  console.log(JSON.stringify({ synthesisGroups, unlinked, drafts }, null, 2));
  process.exit(0);
}

let found = false;

if (synthesisGroups.length > 0) {
  found = true;
  console.log(`Synthesis candidates by tag (${synthesisGroups.length} group(s)):\n`);
  for (const { tag, pages: grp } of synthesisGroups) {
    console.log(`  [${tag}] (${grp.length} pages):`);
    for (const p of grp) console.log(`    [[${p.slug}]] — ${p.title}`);
  }
  console.log('');
}

if (unlinked.length > 0) {
  found = true;
  console.log(`Unlinked pages (no outbound [[wikilinks]]) — ${unlinked.length}:`);
  for (const p of unlinked) console.log(`  [[${p.slug}]] — ${p.title}`);
  console.log('');
}

if (drafts.length > 0) {
  found = true;
  console.log(`Draft/speculative pages ready to crystallize — ${drafts.length}:`);
  for (const p of drafts) console.log(`  [[${p.slug}]] — ${p.title}`);
  console.log('');
}

if (!found) {
  console.log('✓ No crystallization candidates found — Hypomnema looks well-connected.');
}
