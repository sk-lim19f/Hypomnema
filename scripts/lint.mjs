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
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --json              Output results as JSON
 *   --fix               Auto-add missing `updated` field (safe repairs only)
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { SESSION_STATE_NEXT_HEADINGS } from '../hooks/hypo-shared.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';
import { parseSchemaVocab, checkForbidden, parseSchemaPageDirs } from './lib/schema-vocab.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false, fix: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json') args.json = true;
    else if (arg === '--fix') args.fix = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
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
    fm[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return fm;
}

function parseTagsField(rawValue) {
  if (rawValue == null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return trimmed
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// type-conditional required fields (spec §6.3, SCHEMA.md §2)
const TYPE_CONDITIONAL_FIELDS = {
  prd: ['status', 'started'],
  adr: ['source', 'status', 'date'],
  'project-index': ['working_dir', 'status', 'started'],
  'tool-eval': ['status'],
  postmortem: ['outcome'],
  learning: ['source'],
  // feedback: ADR 0031 / fix #37 — projection SoT requires full classification
  feedback: [
    'status',
    'scope',
    'tier',
    'targets',
    'sensitivity',
    'priority',
    'memory_summary',
    'reason',
    'source',
  ],
  'prompt-pattern': ['source'],
  'source-summary': ['sources'],
  'weekly-journal': ['week'],
};

const TYPE_ENUM_FIELDS = {
  prd: { status: ['draft', 'active', 'completed', 'cancelled', 'archived'] },
  adr: { status: ['proposed', 'accepted', 'deprecated', 'superseded'] },
  'tool-eval': { status: ['adopted', 'evaluating', 'rejected'] },
  // feedback: ADR 0031 / fix #37 — sensitivity:private is forbidden (wiki is a
  // git-pushed public surface)
  feedback: {
    status: ['active', 'superseded', 'archived'],
    tier: ['L1', 'L2'],
    sensitivity: ['public', 'sanitized'],
  },
};

// ── page collector ────────────────────────────────────────────────────────────

function collectPages(dir, root, pages = [], ignorePatterns = []) {
  if (!existsSync(dir)) return pages;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      // `_`-prefixed dirs (e.g. pages/feedback/_drafts) hold scaffolds / scratch
      // not yet promoted to content — skip so incomplete frontmatter never errors
      // (mirrors loadFeedbackPages in feedback-sync.mjs). `_`-prefixed *files*
      // (e.g. _index.md) are still linted.
      if (entry.startsWith('_')) continue;
      collectPages(full, root, pages, ignorePatterns);
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

// Strip regions where wikilinks are not real references:
//   - fenced code blocks (``` or ~~~ anchored to line start; markdown allows
//     up to 3 spaces of indent and pairs the same fence character)
//   - inline code spans (``...`` then `...`, so double-tick spans aren't split)
//   - HTML comments (<!-- ... -->)
// Replacement preserves newline positions so future line-aware checks still
// line up. Fences are anchored to line starts because the previous version
// matched any two backtick triples in prose, which could silently hide real
// wikilinks between them.
function stripNonWikilinkRegions(content) {
  let out = content;
  out = out.replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/^[ \t]{0,3}~~~[\s\S]*?^[ \t]{0,3}~~~/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/``[^`\n]*``/g, (m) => ' '.repeat(m.length));
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

function extractWikilinks(content) {
  const stripped = stripNonWikilinkRegions(content);
  const links = [];
  for (const m of stripped.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)) {
    links.push(m[1].trim());
  }
  return links;
}

// ── lint checks ───────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['title', 'type'];
const VALID_TYPES = [
  'concept',
  'source-summary',
  'entity',
  'tool-eval',
  'prompt-pattern',
  'playbook',
  'learning',
  'tip',
  'feedback',
  'reference',
  'synthesis',
  'weekly-journal',
  'prd',
  'adr',
  'session-log',
  'session-state',
  'project-index',
  'postmortem',
  'open-questions',
  'schema',
  'source',
];

const issues = [];

function issue(severity, rel, msg, fullPath = null) {
  issues.push({ severity, file: rel, message: msg, path: fullPath });
}

function hasHeading(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}\\s*$`, 'm').test(content);
}

function lintSessionStateHeadings(content, rel) {
  if (!rel.match(/^projects\/[^/]+\/session-state\.md$/)) return;

  if (!SESSION_STATE_NEXT_HEADINGS.some((heading) => hasHeading(content, heading))) {
    issue(
      'error',
      rel,
      `Missing required session-state heading: one of ${SESSION_STATE_NEXT_HEADINGS.map((h) => `## ${h}`).join(', ')}`,
    );
  }
}

function lintPage({ path, rel }, slugMap, tagVocab, pageDirs) {
  // Directory whitelist: a content page under pages/<subdir>/ must live in a
  // SCHEMA-defined directory. Catches typo'd dirs (e.g. pages/learning/ vs the
  // canonical pages/learnings/) regardless of frontmatter, since a directory
  // absent from SCHEMA breaks wikilink resolution and crystallize routing.
  // `_`-prefixed files (e.g. pages/observability/_index.md) are scaffold/section
  // markers, not content — exempt them so packaged scaffold dirs that aren't a
  // page *type* (e.g. observability, a topical grouping of reference pages) don't
  // trip the guard. A real typo dir is created with content, not just an index.
  // Skipped entirely when pageDirs is empty (SCHEMA.md or the table absent) for
  // back-compat with minimal wikis — mirrors the tag-vocab check.
  if (pageDirs && pageDirs.size > 0 && !basename(rel).startsWith('_')) {
    const segs = rel.replace(/\\/g, '/').split('/');
    if (segs[0] === 'pages' && segs.length > 2 && !pageDirs.has(segs[1])) {
      issue(
        'error',
        rel,
        `Undefined pages/ directory: "pages/${segs[1]}/" not in SCHEMA.md (likely a typo — defined: ${[...pageDirs].sort().join(', ')})`,
      );
    }
  }

  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return;
  }

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

  // type-conditional required fields (fix #15)
  if (fm.type && TYPE_CONDITIONAL_FIELDS[fm.type]) {
    for (const field of TYPE_CONDITIONAL_FIELDS[fm.type]) {
      if (!fm[field]) {
        issue('error', rel, `Missing required field for type "${fm.type}": ${field}`);
      }
    }
  }

  // type-specific enum validation
  if (fm.type && TYPE_ENUM_FIELDS[fm.type]) {
    for (const [field, allowed] of Object.entries(TYPE_ENUM_FIELDS[fm.type])) {
      if (fm[field] && !allowed.includes(fm[field])) {
        issue(
          'error',
          rel,
          `Invalid value for ${field} on type "${fm.type}": "${fm[field]}" (allowed: ${allowed.join(', ')})`,
        );
      }
    }
  }

  // feedback: scope vocabulary + conditional claude-learned fields (ADR 0031 / fix #37)
  if (fm.type === 'feedback') {
    const scope = fm.scope || '';
    if (scope && scope !== 'global' && !/^project:[a-z0-9][a-z0-9-]*$/.test(scope)) {
      issue('error', rel, `Invalid feedback scope: "${scope}" (allowed: global | project:<slug>)`);
    }
    const fbTargets = parseTagsField(fm.targets) || [];
    if (fbTargets.includes('claude-learned')) {
      for (const field of ['global_summary', 'promote_to_global']) {
        if (!fm[field]) {
          issue(
            'error',
            rel,
            `Missing required field for feedback with targets:claude-learned: ${field}`,
          );
        }
      }
    }
  }

  // tag vocabulary + forbidden patterns (fix #36)
  const tags = parseTagsField(fm.tags);
  if (tags && tagVocab && tagVocab.size > 0) {
    for (const tag of tags) {
      const forbidden = checkForbidden(tag);
      if (forbidden) {
        issue('error', rel, `Forbidden tag pattern (${forbidden}): "${tag}"`);
        continue;
      }
      if (!tagVocab.has(tag)) {
        issue('error', rel, `Unknown tag: "${tag}" (not in SCHEMA.md Tag Vocabulary)`);
      }
    }
  }

  lintSessionStateHeadings(content, rel);

  for (const link of extractWikilinks(content)) {
    if (!slugMap.has(link)) {
      issue('warn', rel, `Broken wikilink: [[${link}]]`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const scanDirs = ['pages', 'projects', 'journal'].map((d) => join(args.hypoDir, d));
const pages = scanDirs.flatMap((d) => collectPages(d, args.hypoDir, [], ignorePatterns));
const slugMap = buildSlugMap(pages);
const tagVocab = parseSchemaVocab(args.hypoDir);
const pageDirs = parseSchemaPageDirs(args.hypoDir);

for (const page of pages) lintPage(page, slugMap, tagVocab, pageDirs);

if (args.fix) {
  const today = new Date().toISOString().slice(0, 10);
  const fixed = new Set();
  for (const iss of issues) {
    if (
      iss.severity === 'warn' &&
      iss.message === 'Missing frontmatter field: updated' &&
      iss.path
    ) {
      const content = readFileSync(iss.path, 'utf-8');
      const fmMatch = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
      if (fmMatch) {
        const lineEnding = fmMatch[0].includes('\r\n') ? '\r\n' : '\n';
        const closingTag = `${lineEnding}---`;
        const insertAt = fmMatch.index + fmMatch[0].lastIndexOf(closingTag);
        if (insertAt < 0) continue;
        const fixedContent =
          content.slice(0, insertAt) + `${lineEnding}updated: ${today}` + content.slice(insertAt);
        writeFileSync(iss.path, fixedContent);
        fixed.add(iss.path);
      }
    }
  }
  if (fixed.size > 0) {
    issues.splice(
      0,
      issues.length,
      ...issues.filter(
        (i) =>
          !(
            i.severity === 'warn' &&
            i.message === 'Missing frontmatter field: updated' &&
            fixed.has(i.path)
          ),
      ),
    );
  }
}

const errors = issues.filter((i) => i.severity === 'error');
const warns = issues.filter((i) => i.severity === 'warn');

if (args.json) {
  const toOut = ({ severity, file, message }) => ({ severity, file, message });
  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        errors: errors.map(toOut),
        warns: warns.map(toOut),
        total: issues.length,
      },
      null,
      2,
    ),
  );
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
