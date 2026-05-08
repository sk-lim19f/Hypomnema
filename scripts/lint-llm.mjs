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
 *
 * TODO: implement per-page LLM evaluation pass (gh#tbd)
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';

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

const args = parseArgs(process.argv);

if (!process.env.ANTHROPIC_API_KEY) {
  const msg = 'lint-llm requires ANTHROPIC_API_KEY — set it or disable ENABLE_LLM_LINT';
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: msg, results: [] }));
  } else {
    console.error(`✗ ${msg}`);
  }
  process.exit(1);
}

const pages = collectMdFiles(join(args.wikiDir, 'pages'));

// TODO: replace stub with per-page Haiku evaluation pass
const result = {
  ok: true,
  model: args.model,
  wiki_dir: args.wikiDir,
  page_count: pages.length,
  results: [],
  note: 'LLM evaluation pass not yet implemented',
};

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`ℹ  lint-llm stub — ${pages.length} pages found, LLM pass not yet implemented`);
}
