#!/usr/bin/env node
/**
 * hypo-lookup.mjs — UserPromptSubmit hook
 *
 * On every user prompt:
 *   1. Extract keywords from the prompt
 *   2. BM25-score against ~/hypomnema/index.md entries
 *   HIT  → read matched pages, inject as additionalContext
 *   MISS → inject top-3 closest slugs as a research signal
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { HYPO_DIR, buildOutput, loadHypoIgnore, isIgnored } from './hypo-shared.mjs';

const INDEX_PATH = join(HYPO_DIR, 'index.md');
const MAX_HITS   = 3;
const MAX_CHARS  = 2000;

// ── helpers ─────────────────────────────────────────────────────────────────

function buildPageMap(dir, root = dir, map = {}, ignorePatterns = [], hypoDir = root) {
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isIgnored(full, hypoDir, ignorePatterns)) continue;
    if (statSync(full).isDirectory()) {
      buildPageMap(full, root, map, ignorePatterns, hypoDir);
    } else if (entry.endsWith('.md')) {
      const rel = full.slice(root.length + 1).replace(/\.md$/, '');
      map[rel] = full;
      const bare = basename(entry, '.md');
      if (!map[bare]) map[bare] = full;
    }
  }
  return map;
}

function extractKeywords(prompt) {
  const stop = new Set([
    'the','and','for','with','this','that','have','from','are','was','were',
    'what','when','where','how','why','who','can','could','should','would',
    'does','did','will','not','but','its','also','just','more','any','all',
    '어떤','어떻게','무엇','이런','그런','하는','하고','해서','있어','없어',
    '되는','이거','저거','그거','이건','그건','저건','같은','하면','되면',
    '인지','에서','으로','까지','부터','에게','한테','에도','에만','에는',
  ]);
  return [...new Set(
    prompt.toLowerCase()
      .split(/[\s,，.。?？!！()\[\]{}'"\/\\:;=+*&%$#@~`|<>]+/)
      .filter(w => w.length >= 3 && !stop.has(w))
  )];
}

function tokenize(text) {
  return text.toLowerCase()
    .split(/[\s\-_/.,，。?？!！()\[\]{}'"\\:;=+*&%$#@~`|<>]+/)
    .filter(w => w.length >= 2);
}

function bm25Score(queryTerms, entries, k1 = 1.5, b = 0.75) {
  const N = entries.length;
  if (N === 0) return [];
  const docTokens = entries.map(e => tokenize(e.slug + ' ' + e.desc));
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / N;
  const df = {};
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df[t] = (df[t] || 0) + 1;
  }
  const idf = t => Math.log(1 + (N - (df[t] || 0) + 0.5) / ((df[t] || 0) + 0.5));

  return entries.map((e, i) => {
    const tokens = docTokens[i];
    const dl = tokens.length || 1;
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    let score = 0;
    for (const q of queryTerms) {
      const f = tf[q] || 0;
      if (f === 0) continue;
      const norm = 1 - b + b * dl / avgdl;
      score += idf(q) * (f * (k1 + 1)) / (f + k1 * norm);
    }
    return { ...e, score };
  }).sort((a, c) => c.score - a.score);
}

function typePrior(slug) {
  if (/\/decisions\/|^decisions\//.test(slug)) return 1.5;
  if (/\bprd\b|spec-v/.test(slug))             return 1.3;
  if (/\/session-log\/|\/session-log$/.test(slug)) return 1.2;
  if (/^sources\//.test(slug))                  return 1.2;
  return 1.0;
}

function parseIndexEntries(indexContent) {
  const entries = [];
  for (const line of indexContent.split('\n')) {
    if (line.trimStart().startsWith('<!--')) continue;
    if (line.trimStart().startsWith('>')) continue;
    const m = line.match(/\[\[([^\]]+)\]\]\s*[—\-]+\s*(.+)/);
    if (!m) continue;
    const raw  = m[1].trim();
    const desc = m[2].trim();
    const slug = raw.includes('|') ? raw.split('|')[0].trim() : raw;
    entries.push({ slug, desc });
  }
  return entries;
}

// ── main ─────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data   = JSON.parse(input);
    const prompt = (data.prompt || '').trim();

    if (!prompt || !existsSync(INDEX_PATH)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const keywords = extractKeywords(prompt);
    if (keywords.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const entries  = parseIndexEntries(readFileSync(INDEX_PATH, 'utf-8'));
    const scored   = bm25Score(keywords, entries)
      .map(e => ({ ...e, score: e.score * typePrior(e.slug) }))
      .sort((a, c) => c.score - a.score)
      .filter(e => e.score > 0);
    const topScore = scored[0]?.score ?? 0;
    const matched  = scored.filter(e => e.score >= topScore * 0.5);

    if (matched.length === 0) {
      const topic   = keywords.slice(0, 5).join(', ');
      const closest = bm25Score(keywords, entries)
        .map(e => ({ ...e, score: e.score * typePrior(e.slug) }))
        .sort((a, c) => c.score - a.score)
        .slice(0, 3).map(e => `[[${e.slug}]]`).join(', ');
      console.log(JSON.stringify(
        buildOutput(
          `[WIKI LOOKUP: miss] "${topic}" — no match. Closest: ${closest || 'none'}`,
          { continue: true, suppressOutput: true }
        )
      ));
      return;
    }

    const ignorePatterns = loadHypoIgnore(HYPO_DIR);
    const pageMap = {
      ...buildPageMap(join(HYPO_DIR, 'pages'), join(HYPO_DIR, 'pages'), {}, ignorePatterns, HYPO_DIR),
      ...buildPageMap(join(HYPO_DIR, 'projects'), join(HYPO_DIR, 'projects'), {}, ignorePatterns, HYPO_DIR),
    };

    const injected = [];
    for (const { slug } of matched.slice(0, MAX_HITS)) {
      const path = pageMap[slug]
        ?? pageMap[slug.replace(/^(pages|projects)\//, '')]
        ?? pageMap[basename(slug)];
      if (path && existsSync(path)) {
        injected.push(`=== [[${slug}]] ===\n${readFileSync(path, 'utf-8').slice(0, MAX_CHARS)}`);
      }
    }

    if (injected.length === 0) {
      const slugs = matched.slice(0, MAX_HITS).map(e => e.slug).join(', ');
      console.log(JSON.stringify(
        buildOutput(`[WIKI LOOKUP: index hit but files missing] ${slugs}`, { continue: true, suppressOutput: true })
      ));
      return;
    }

    const overflow = matched.length > MAX_HITS
      ? `\n(+${matched.length - MAX_HITS} more matches — search wiki index for more)` : '';

    console.log(JSON.stringify(
      buildOutput(
        `[WIKI LOOKUP: ${injected.length} page(s) matched]\n\n` + injected.join('\n\n') + overflow,
        { continue: true, suppressOutput: true }
      )
    ));

  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
