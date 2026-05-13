#!/usr/bin/env node
/**
 * session-audit.mjs — Hypomnema autonomy/observability audit
 *
 * Reads completed session transcripts and emits per-session metrics
 * (search count, ingest count, URLs mentioned, feedback count) so the
 * weekly observability report (Lane E) can compute autonomy scores.
 *
 * Transcript dual-source (ADR 0019):
 *   1) Primary: <hypo-dir>/.cache/sessions/index.jsonl
 *      Written by hooks/hypo-session-record.mjs (Stop hook).
 *   2) Fallback: ~/.claude/projects/<encoded>/*.jsonl
 *      Scanned directly when the index is missing/empty.
 *
 * The audit is heuristic. Classification rules:
 *   - staleness-skip: transcript older than --max-age-days (default 30)
 *   - search-0:      0 search/query tool uses
 *   - search-many:   >= 5 search/query tool uses
 *   - ingest-missed: >= 2 URLs in transcript and 0 ingest calls
 *   - normal:        otherwise
 *
 * Usage:
 *   node scripts/session-audit.mjs [--hypo-dir=<path>] [--limit N]
 *                                  [--max-age-days N] [--json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';

const HOME = homedir();

function parseArgs(argv) {
  const args = { hypoDir: null, limit: 50, maxAgeDays: 30, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir='))      args.hypoDir     = expandHome(arg.slice(11));
    else if (arg.startsWith('--limit='))    args.limit       = parseInt(arg.slice(8), 10) || 50;
    else if (arg.startsWith('--max-age-days=')) args.maxAgeDays = parseInt(arg.slice(15), 10) || 30;
    else if (arg === '--json')              args.json        = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── transcript discovery ─────────────────────────────────────────────────────

function readIndexEntries(hypoDir) {
  const path = join(hypoDir, '.cache', 'sessions', 'index.jsonl');
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed);
      if (e && e.transcript_path && e.session_id) entries.push(e);
    } catch { /* skip malformed lines */ }
  }
  // Deduplicate by session_id, keeping the latest entry.
  const bySession = new Map();
  for (const e of entries) bySession.set(e.session_id, e);
  return [...bySession.values()];
}

function scanFallback(claudeProjectsDir = join(HOME, '.claude', 'projects')) {
  if (!existsSync(claudeProjectsDir)) return [];
  const entries = [];
  for (const dir of readdirSync(claudeProjectsDir)) {
    const full = join(claudeProjectsDir, dir);
    if (!statSync(full).isDirectory()) continue;
    for (const file of readdirSync(full)) {
      if (!file.endsWith('.jsonl')) continue;
      const transcriptPath = join(full, file);
      entries.push({
        session_id: file.replace(/\.jsonl$/, ''),
        transcript_path: transcriptPath,
        recorded_at: statSync(transcriptPath).mtime.toISOString(),
        source: 'fallback',
      });
    }
  }
  return entries;
}

export function loadSessionEntries(hypoDir, opts = {}) {
  const primary = readIndexEntries(hypoDir);
  if (primary.length > 0) return primary.map(e => ({ ...e, source: e.source || 'index' }));
  const fallbackDir = opts.fallbackDir ?? join(HOME, '.claude', 'projects');
  return scanFallback(fallbackDir);
}

// ── transcript parsing & metrics ─────────────────────────────────────────────

const SEARCH_TOOLS  = new Set(['Grep', 'WebSearch', 'WebFetch']);
const SEARCH_CMDS   = ['/hypo:query', '/query'];
const INGEST_CMDS   = ['/hypo:ingest', '/ingest'];
const FEEDBACK_CMDS = ['/hypo:feedback', '/feedback'];

function readTranscriptLines(transcriptPath) {
  if (!existsSync(transcriptPath)) return [];
  const out = [];
  for (const line of readFileSync(transcriptPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip */ }
  }
  return out;
}

function extractText(entry) {
  if (!entry) return '';
  if (typeof entry.content === 'string') return entry.content;
  if (Array.isArray(entry.content)) {
    return entry.content
      .map(c => (typeof c === 'string' ? c : c?.text || ''))
      .join('\n');
  }
  if (entry.message?.content) return extractText({ content: entry.message.content });
  return '';
}

function countUrls(text) {
  const matches = text.match(/https?:\/\/\S+/g);
  return matches ? matches.length : 0;
}

export function computeMetrics(transcriptLines) {
  const metrics = { search_count: 0, ingest_count: 0, feedback_count: 0, urls: 0, messages: 0 };
  for (const line of transcriptLines) {
    metrics.messages++;
    // Tool-use entries are scored solely via their tool name — skip the text
    // path below so a single transcript record can't double-count search.
    const isToolUse = line.type === 'tool_use' || line.tool_name || line.name;
    if (isToolUse) {
      const name = line.name || line.tool_name;
      if (name && SEARCH_TOOLS.has(name)) metrics.search_count++;
      continue;
    }
    const text = extractText(line);
    if (!text) continue;
    metrics.urls += countUrls(text);
    for (const cmd of SEARCH_CMDS)   if (text.includes(cmd)) metrics.search_count++;
    for (const cmd of INGEST_CMDS)   if (text.includes(cmd)) metrics.ingest_count++;
    for (const cmd of FEEDBACK_CMDS) if (text.includes(cmd)) metrics.feedback_count++;
  }
  return metrics;
}

export function classify(metrics, ageDays, maxAgeDays) {
  if (Number.isFinite(ageDays) && ageDays > maxAgeDays) return 'staleness-skip';
  if (metrics.urls >= 2 && metrics.ingest_count === 0) return 'ingest-missed';
  if (metrics.search_count >= 5) return 'search-many';
  if (metrics.search_count === 0) return 'search-0';
  return 'normal';
}

// ── main audit ───────────────────────────────────────────────────────────────

export function auditEntries(entries, { maxAgeDays = 30, limit = 50, now = Date.now() } = {}) {
  const sorted = [...entries].sort((a, b) =>
    (b.recorded_at || '').localeCompare(a.recorded_at || '')
  );
  const slice = sorted.slice(0, limit);
  const results = [];
  for (const entry of slice) {
    const lines   = readTranscriptLines(entry.transcript_path);
    const metrics = computeMetrics(lines);
    const recordedAt = entry.recorded_at ? Date.parse(entry.recorded_at) : NaN;
    const ageDays = Number.isFinite(recordedAt)
      ? (now - recordedAt) / (24 * 60 * 60 * 1000)
      : NaN;
    const classification = classify(metrics, ageDays, maxAgeDays);
    results.push({
      session_id: entry.session_id,
      source: entry.source,
      recorded_at: entry.recorded_at,
      age_days: Number.isFinite(ageDays) ? +ageDays.toFixed(2) : null,
      metrics,
      classification,
    });
  }
  return results;
}

function isMain() {
  try { return import.meta.url === `file://${process.argv[1]}`; }
  catch { return false; }
}

if (isMain()) {
  const args    = parseArgs(process.argv);
  const entries = loadSessionEntries(args.hypoDir);
  const results = auditEntries(entries, { maxAgeDays: args.maxAgeDays, limit: args.limit });

  if (args.json) {
    console.log(JSON.stringify({ hypo_dir: args.hypoDir, count: results.length, results }, null, 2));
    process.exit(0);
  }

  if (results.length === 0) {
    console.log('No sessions found.');
    console.log(`  Looked in: ${join(args.hypoDir, '.cache', 'sessions', 'index.jsonl')}`);
    console.log(`  Fallback:  ~/.claude/projects/<encoded>/*.jsonl`);
    process.exit(0);
  }

  const tally = {};
  for (const r of results) tally[r.classification] = (tally[r.classification] || 0) + 1;

  console.log(`Audited ${results.length} session(s) from ${results[0].source}:`);
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log('');
  console.log('Recent sessions:');
  for (const r of results.slice(0, 10)) {
    const m = r.metrics;
    console.log(`  [${r.classification.padEnd(14)}] ${r.session_id}  search=${m.search_count} ingest=${m.ingest_count} urls=${m.urls}`);
  }
}
