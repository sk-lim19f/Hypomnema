import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const VOCAB_HEADER_RE = /^##\s+(?:\d+\.\s+)?Tag\s+(?:Vocabulary|Taxonomy)\s*$/m;
const NEXT_H2_RE = /^##\s+/m;
const BACKTICK_TOKEN_RE = /`([^`\n]+)`/g;

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
  for (const m of section.matchAll(BACKTICK_TOKEN_RE)) {
    const token = m[1].trim();
    if (!token) continue;
    if (token.includes(' ')) continue;
    vocab.add(token);
  }
  return vocab;
}
