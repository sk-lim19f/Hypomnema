import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const VOCAB_HEADER_RE = /^##\s+(?:\d+\.\s+)?Tag\s+(?:Vocabulary|Taxonomy)\s*$/m;
const TYPE_TAXONOMY_HEADER_RE = /^##\s+(?:\d+\.\s+)?Page\s+Type\s+Taxonomy\s*$/m;
const PAGE_DIR_TOKEN_RE = /`pages\/([a-z0-9-]+)\//g;
const NEXT_H2_RE = /^##\s+/m;
const CATEGORY_PREFIX_RE = /^\s*\*\*[^*]+\*\*:\s*/;
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

const FORBIDDEN_PATTERNS = [
  { name: 'PascalCase', test: (t) => /[A-Z]/.test(t) },
  { name: 'whitespace', test: (t) => /\s/.test(t) },
  {
    name: 'generic',
    test: (t) => ['general', 'misc', 'other', 'todo'].includes(t),
  },
  {
    name: 'plural',
    test: (t) => ['learnings', 'tips', 'feedbacks', 'concepts', 'playbooks'].includes(t),
  },
];

export function checkForbidden(tag) {
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.test(tag)) return rule.name;
  }
  return null;
}

// Extract only backtick tokens from canonical vocabulary lines.
// A vocabulary line is one whose non-backtick residue (after stripping an
// optional `**Category**:` prefix) contains only separators (whitespace, commas).
// This excludes prose like "...`lint` blocks unknown tags..." and table rows
// in the Forbidden patterns section that mention example tokens.
function vocabLineTokens(rawLine) {
  const line = rawLine.replace(CATEGORY_PREFIX_RE, '').trim();
  if (!line) return [];
  const residue = line.replace(/`[^`]+`/g, '').trim();
  if (!/^[\s,]*$/.test(residue)) return [];
  const tokens = [];
  for (const m of line.matchAll(BACKTICK_TOKEN_RE)) {
    const t = m[1].trim();
    if (t && !t.includes(' ')) tokens.push(t);
  }
  return tokens;
}

export function parseSchemaVocab(hypoDir) {
  const path = join(hypoDir, 'SCHEMA.md');
  if (!existsSync(path)) return new Set();
  const content = readFileSync(path, 'utf-8');

  const headerMatch = VOCAB_HEADER_RE.exec(content);
  if (!headerMatch) return new Set();

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const rest = content.slice(sectionStart);
  const nextH2 = NEXT_H2_RE.exec(rest);
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest;

  const vocab = new Set();
  for (const rawLine of section.split('\n')) {
    for (const token of vocabLineTokens(rawLine)) vocab.add(token);
  }
  return vocab;
}

// Derive the set of valid immediate subdirectories under pages/ from the
// SCHEMA "Page Type Taxonomy" table (e.g. learnings, feedback, people). Single
// source of truth — adding a type+dir row to SCHEMA automatically widens the
// whitelist. Returns an empty Set when SCHEMA.md or the table is absent, which
// callers treat as "skip the check" for back-compat with minimal wikis.
export function parseSchemaPageDirs(hypoDir) {
  const path = join(hypoDir, 'SCHEMA.md');
  if (!existsSync(path)) return new Set();
  const content = readFileSync(path, 'utf-8');

  const headerMatch = TYPE_TAXONOMY_HEADER_RE.exec(content);
  if (!headerMatch) return new Set();

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const rest = content.slice(sectionStart);
  const nextH2 = NEXT_H2_RE.exec(rest);
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest;

  // Only scan table rows (lines starting with `|`) so a backticked path that
  // appears in surrounding prose (e.g. an example of a *wrong* dir) can never
  // leak into the whitelist.
  const dirs = new Set();
  for (const rawLine of section.split('\n')) {
    if (!rawLine.trimStart().startsWith('|')) continue;
    for (const m of rawLine.matchAll(PAGE_DIR_TOKEN_RE)) dirs.add(m[1]);
  }
  return dirs;
}
