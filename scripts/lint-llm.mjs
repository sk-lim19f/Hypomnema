#!/usr/bin/env node
/**
 * Hypomnema LLM lint — L2 quality review via Claude Haiku
 *
 * Evaluates wiki pages for clarity, completeness, and staleness using
 * the Anthropic API. Intended for nightly CI runs.
 *
 * Usage:
 *   node scripts/lint-llm.mjs --wiki-dir=<path> [--model=haiku] [--json]
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';

const MODEL_ALIASES = {
  haiku:  'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-7',
};

const EVAL_PROMPT = content => `You are a wiki quality reviewer. Evaluate this wiki page.

Respond with JSON only — no explanation, no markdown:
{"clarity":<1-5>,"completeness":<1-5>,"staleness_risk":"<low|medium|high>","issues":[<string>,...]}

- clarity: how clear and readable is the writing? (1=very poor, 5=excellent)
- completeness: how complete is the content for its stated topic? (1=very incomplete, 5=very complete)
- staleness_risk: how likely is this to become outdated within 6 months? (low/medium/high)
- issues: specific problems found; empty array if none

PAGE:
${content}`;

function parseArgs(argv) {
  const args = { wikiDir: null, model: 'haiku', json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir='))  args.wikiDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--model=')) args.model   = arg.slice(8);
    else if (arg === '--json')           args.json    = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

function collectMdFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectMdFiles(full, acc);
    else if (extname(entry) === '.md') acc.push(full);
  }
  return acc;
}

async function evaluatePage(filePath, modelId, apiKey) {
  const content = readFileSync(filePath, 'utf-8').slice(0, 3000);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 256,
      messages: [{ role: 'user', content: EVAL_PROMPT(content) }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text ?? '';
  try {
    return { ok: true, ...JSON.parse(text) };
  } catch {
    return { ok: false, issues: [`parse error: ${text.slice(0, 100)}`] };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  const msg = 'lint-llm requires ANTHROPIC_API_KEY — set it or disable ENABLE_LLM_LINT';
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: msg, results: [] }));
  } else {
    console.error(`✗ ${msg}`);
  }
  process.exit(1);
}

const modelId = MODEL_ALIASES[args.model] ?? args.model;
const pages = collectMdFiles(join(args.wikiDir, 'pages'));

if (!args.json) console.log(`Evaluating ${pages.length} pages with ${modelId}…`);

const results = [];
let errors = 0;

for (const filePath of pages) {
  try {
    const evaluation = await evaluatePage(filePath, modelId, apiKey);
    if (evaluation.ok === false) errors++;
    results.push({ file: filePath, ...evaluation });
    if (!args.json) {
      const good = evaluation.ok !== false && evaluation.clarity >= 4 && evaluation.completeness >= 4;
      console.log(`  ${evaluation.ok === false ? '✗' : good ? '✓' : '⚠'} ${filePath.split('/').at(-1)}`);
    }
  } catch (err) {
    errors++;
    results.push({ file: filePath, ok: false, issues: [err.message] });
    if (!args.json) console.error(`  ✗ ${filePath.split('/').at(-1)}: ${err.message}`);
  }
}

const summary = {
  ok: errors === 0,
  model: modelId,
  wiki_dir: args.wikiDir,
  page_count: pages.length,
  error_count: errors,
  results,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`\n${errors === 0 ? '✓' : '✗'} ${pages.length} pages evaluated, ${errors} errors`);
}

if (errors > 0) process.exit(1);
