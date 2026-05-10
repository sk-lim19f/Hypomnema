#!/usr/bin/env node
/**
 * Hypomnema feedback script
 *
 * Creates or appends to pages/feedback/<topic>.md with a feedback entry.
 * Also appends a log entry to log.md.
 * Used by /hypo:feedback after Claude drafts the feedback content.
 *
 * Usage:
 *   node scripts/feedback.mjs --topic=<slug> --entry=<text> [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --topic=<slug>      Feedback topic slug (e.g. "response-length", "code-style")
 *   --entry=<text>      Feedback entry text (one-line rule or short paragraph)
 *   --dry-run           Preview without writing
 *   --list              List existing feedback topics
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve, sep } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, topic: null, entry: null, dryRun: false, list: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--topic='))   args.topic  = arg.slice(8);
    else if (arg.startsWith('--entry='))   args.entry  = arg.slice(8);
    else if (arg === '--dry-run')          args.dryRun = true;
    else if (arg === '--list')             args.list   = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── list mode ────────────────────────────────────────────────────────────────

function listTopics(hypoDir) {
  const feedbackDir = join(hypoDir, 'pages', 'feedback');
  if (!existsSync(feedbackDir)) {
    console.log('No feedback pages found.');
    return;
  }
  const files = readdirSync(feedbackDir).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No feedback pages found.');
    return;
  }
  console.log(`Feedback topics (${files.length}):`);
  for (const f of files) console.log(`  ${f.replace(/\.md$/, '')}`);
}

// ── write feedback entry ──────────────────────────────────────────────────────

function writeFeedback(hypoDir, topic, entry, dryRun) {
  const feedbackDir = join(hypoDir, 'pages', 'feedback');
  const filePath    = join(feedbackDir, `${topic}.md`);
  const today       = new Date().toISOString().slice(0, 10);

  let content;

  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf-8');
    const newEntry = `\n## ${today}\n\n${entry}\n`;
    content = content.trimEnd() + '\n' + newEntry;
  } else {
    content = `---
title: "Feedback: ${topic}"
type: feedback
updated: ${today}
tags: [feedback]
---

# Feedback: ${topic}

## ${today}

${entry}
`;
  }

  if (dryRun) {
    console.log('[DRY RUN — no changes made]\n');
    console.log(`Would write to: ${filePath}\n`);
    console.log(content);
    return;
  }

  if (!existsSync(feedbackDir)) mkdirSync(feedbackDir, { recursive: true });
  writeFileSync(filePath, content);
  console.log(`✓ Written: ${filePath}`);

  // append to log.md
  const logPath = join(hypoDir, 'log.md');
  const logEntry = `\n- ${today} feedback: [[pages/feedback/${topic}]] — ${entry.split('\n')[0].slice(0, 80)}\n`;
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, log.trimEnd() + logEntry);
    console.log(`↪ Appended to log.md`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.list) {
  listTopics(args.hypoDir);
  process.exit(0);
}

if (!args.topic) {
  console.error('Error: --topic=<slug> is required (or use --list)');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9._-]*$/i.test(args.topic)) {
  console.error('Error: --topic must be a simple slug (letters, digits, hyphen, dot, underscore)');
  process.exit(1);
}

if (!args.entry) {
  console.error('Error: --entry=<text> is required');
  process.exit(1);
}

writeFeedback(args.hypoDir, args.topic, args.entry, args.dryRun);
