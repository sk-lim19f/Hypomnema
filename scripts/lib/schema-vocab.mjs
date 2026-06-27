import { existsSync, readFileSync, writeFileSync } from 'fs';
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

// Prose seeded into a freshly-created `### Pending` block. It carries NO
// backtick tokens, so parseSchemaVocab's vocabLineTokens never mistakes it for a
// vocabulary line — only the `**Pending**:` data line below it contributes tags.
const PENDING_HEADING = '### Pending (auto-registered)';
const PENDING_PROSE =
  'Tags auto-registered by a crystallize close because they were not yet in the ' +
  'vocabulary above. Review periodically: promote each into a category and delete ' +
  'it here, or drop the tag from the page.';
const PENDING_HEADING_RE = /^###[ \t]+Pending\b.*$/im; // prefix/word match
const PENDING_DATA_RE = /^\*\*Pending[^*]*\*\*:.*$/im;
const NEXT_H3_RE = /^###[ \t]+/m;
const FORBIDDEN_HEADING_RE = /^###[ \t]+Forbidden\b/im;

function backtickList(tags) {
  return tags.map((t) => `\`${t}\``).join(', ');
}

// Auto-register unknown (non-forbidden) tags into the vault SCHEMA.md `### Pending`
// section so a close never stalls on a vocabulary gap and the next lint sees them
// as known (B-4). Pending lives INSIDE the "## Tag Vocabulary" H2 section because
// parseSchemaVocab is H2-bounded — placing it elsewhere would not widen the vocab.
// No-ops (returns []) when SCHEMA.md or the Tag Vocabulary header is absent, when
// every tag is already in the vocabulary, or when a tag is forbidden — registering
// a forbidden pattern is pointless (lint errors on it before the vocab check) and
// would only pollute Pending. Idempotent: re-running with the same tags writes
// nothing (they are already in the parsed vocabulary on the second call).
export function appendPendingTags(hypoDir, tags) {
  const path = join(hypoDir, 'SCHEMA.md');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf-8');

  const headerMatch = VOCAB_HEADER_RE.exec(content);
  if (!headerMatch) return [];

  const current = parseSchemaVocab(hypoDir);
  const seen = new Set();
  const newTags = [];
  for (const raw of tags || []) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    // A literal backtick cannot be serialized inside the backtick-delimited
    // `**Pending**:` line — it would close the token early and make
    // parseSchemaVocab mis-tokenize (or blank) the whole line, taking valid
    // sibling tags down with it (codex stage-2 CONCERN). Skip it: the tag stays a
    // non-blocking unknown-tag warn the author can rename. (A `"` is safe — it
    // round-trips between backticks — so only the backtick is rejected.)
    if (!t || t.includes('`') || seen.has(t) || current.has(t) || checkForbidden(t)) continue;
    seen.add(t);
    newTags.push(t);
  }
  if (newTags.length === 0) return [];

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const rest = content.slice(sectionStart);
  const nextH2 = NEXT_H2_RE.exec(rest);
  const sectionEnd = nextH2 ? sectionStart + nextH2.index : content.length;
  const section = content.slice(sectionStart, sectionEnd);

  let newSection;
  const heading = PENDING_HEADING_RE.exec(section);
  if (heading) {
    // Pending subsection exists — bound it (heading → next H3 or section end) and
    // either extend its `**Pending**:` data line or seed one if the block is empty
    // (the template ships heading + prose with no tags yet).
    const subStart = heading.index;
    const after = section.slice(heading.index + heading[0].length);
    const nextH3 = NEXT_H3_RE.exec(after);
    const subEnd = nextH3 ? heading.index + heading[0].length + nextH3.index : section.length;
    const sub = section.slice(subStart, subEnd);

    const dataMatch = PENDING_DATA_RE.exec(sub);
    let newSub;
    if (dataMatch) {
      const existing = [];
      for (const m of dataMatch[0].matchAll(BACKTICK_TOKEN_RE)) {
        const t = m[1].trim();
        if (t && !t.includes(' ')) existing.push(t);
      }
      const merged = [...existing, ...newTags];
      const dataLine = `**Pending**: ${backtickList(merged)}`;
      newSub =
        sub.slice(0, dataMatch.index) + dataLine + sub.slice(dataMatch.index + dataMatch[0].length);
    } else {
      const dataLine = `**Pending**: ${backtickList(newTags)}`;
      newSub = `${sub.replace(/\s*$/, '')}\n\n${dataLine}\n`;
    }
    newSection = section.slice(0, subStart) + newSub + section.slice(subEnd);
  } else {
    // No Pending block yet — build one and place it before "### Forbidden patterns"
    // if present (Pending is vocabulary; Forbidden is a separate concern), else at
    // the end of the Tag Vocabulary section.
    const block = `${PENDING_HEADING}\n\n${PENDING_PROSE}\n\n**Pending**: ${backtickList(newTags)}\n`;
    const forbidden = FORBIDDEN_HEADING_RE.exec(section);
    if (forbidden) {
      newSection =
        section.slice(0, forbidden.index) + `${block}\n` + section.slice(forbidden.index);
    } else {
      newSection = `${section.replace(/\s*$/, '')}\n\n${block}\n`;
    }
  }

  writeFileSync(path, content.slice(0, sectionStart) + newSection + content.slice(sectionEnd));
  return newTags;
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

// Type-token shape: lowercase identifier (a-z, digits, hyphen). Excludes
// memory-layer rows whose first cell is a filename (`hot.md`, `log.md`) — those
// carry a `.` and never match — so only real type names survive.
const TYPE_TOKEN_RE = /^[a-z][a-z0-9-]+$/;

// Derive the set of valid page `type` values from the SCHEMA "Page Type
// Taxonomy" table — the FIRST backticked cell of each table row (the type
// column). Single source of truth, mirroring parseSchemaPageDirs: adding a type
// row to a vault's SCHEMA automatically widens the accepted types, so a
// vault-local extension (e.g. working-doc / draft / qa-run) stops tripping the
// W2 unknown-type warning without editing lint. Returns an empty Set when
// SCHEMA.md or the table is absent — callers union this with a hardcoded core so
// the core types never depend on a present/complete SCHEMA.
export function parseSchemaTypes(hypoDir) {
  const path = join(hypoDir, 'SCHEMA.md');
  if (!existsSync(path)) return new Set();
  const content = readFileSync(path, 'utf-8');

  const headerMatch = TYPE_TAXONOMY_HEADER_RE.exec(content);
  if (!headerMatch) return new Set();

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const rest = content.slice(sectionStart);
  const nextH2 = NEXT_H2_RE.exec(rest);
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest;

  const types = new Set();
  for (const rawLine of section.split('\n')) {
    if (!rawLine.trimStart().startsWith('|')) continue;
    const m = rawLine.match(/`([^`]+)`/); // first backtick token = type column
    if (m && TYPE_TOKEN_RE.test(m[1].trim())) types.add(m[1].trim());
  }
  return types;
}
