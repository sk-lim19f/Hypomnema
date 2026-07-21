#!/usr/bin/env node
/**
 * hypo-hot-rebuild.mjs — Stop hook
 *
 * Rebuilds root hot.md in canonical format on every session end.
 * Preserves the project pointer table rows while refreshing dates
 * from each project's hot.md frontmatter `updated:` field.
 *
 * Claude manages: adding/removing project rows in the pointer table.
 * This script manages: frontmatter, H2 structure, date fields.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  computeSessionGrowth,
  formatGrowthMetrics,
  deriveRootLogEntries,
  recordTouchedPaths,
} from './hypo-shared.mjs';

const HOT_PATH = join(HYPO_DIR, 'hot.md');
const GROWTH_CACHE = join(HYPO_DIR, '.cache', 'last-session-growth.json');

// This Stop hook runs BEFORE hypo-auto-commit and can write hot.md
// (rebuild) and log.md (deriveRootLogEntries), both hook-generated, not user
// Write/Edit, so hypo-auto-stage never sees them. Read session_id off stdin so
// whatever this hook writes still lands in the scoped commit's set; without
// this, a scope built from Write/Edit alone would silently drop these files
// from every session's auto-commit.
let sessionId = null;
try {
  const raw = await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });
  const payload = JSON.parse(raw || '{}') || {};
  sessionId = payload.session_id || payload.sessionId || null;
} catch {
  sessionId = null;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const result = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

function getProjectDate(slug) {
  const hotPath = join(HYPO_DIR, 'projects', slug, 'hot.md');
  if (!existsSync(hotPath)) return null;
  try {
    return parseFrontmatter(readFileSync(hotPath, 'utf-8')).updated || null;
  } catch {
    return null;
  }
}

function parsePointerRows(content) {
  const rows = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\|\s*(.+?)\s*\|\s*.+?\s*\|\s*\[\[projects\/(.+?)\/hot\]\]\s*\|/);
    if (m) rows.push({ name: m[1].trim(), slug: m[2].trim() });
  }
  return rows;
}

/** @returns {boolean} true when hot.md was actually rewritten. */
function rebuild() {
  if (!existsSync(HOT_PATH)) return false;

  const current = readFileSync(HOT_PATH, 'utf-8');
  const rows = parsePointerRows(current);
  if (rows.length === 0) return false;

  const today = new Date().toISOString().slice(0, 10);

  const tableRows = rows
    .map(({ name, slug }) => {
      const date = getProjectDate(slug) || today;
      return `| ${name} | ${date} | [[projects/${slug}/hot]] |`;
    })
    .join('\n');

  const canonical = `---
title: Hot Cache — Pointer
type: reference
updated: ${today}
tags: [wiki, operations]
---

# Hot Cache

> Read at session start → navigate to the relevant project session-state.md and hot.md.
> Update at session close: project session-state.md, project hot.md, and this file's "Active Projects" table.

## Active Projects

| Project | Last Session | Hot Cache |
|---|---|---|
${tableRows}

## Session Start Checklist

1. Check this file for the relevant project link
2. Read \`projects/<name>/session-state.md\` for next tasks if it exists
3. Read \`projects/<name>/hot.md\` for project background
`;

  if (canonical !== current) {
    writeFileSync(HOT_PATH, canonical);
    return true;
  }
  return false;
}

function emitGrowth() {
  if (!existsSync(HYPO_DIR)) return;
  const stats = computeSessionGrowth(HYPO_DIR);
  const line = formatGrowthMetrics('stop', stats);
  if (line) process.stderr.write(`${line}\n`);
  try {
    mkdirSync(join(HYPO_DIR, '.cache'), { recursive: true });
    writeFileSync(GROWTH_CACHE, JSON.stringify({ ...stats, ts: Date.now() }));
  } catch {}
}

let hotWritten = false;
try {
  hotWritten = rebuild();
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] error: ${err?.message ?? String(err)}\n`);
}
// Auto-derive the root log.md session entry from each project's session-log
// heading (runs AFTER rebuild() so root hot.md is already fresh and isn't itself
// counted as the project's open gate problem). Best-effort: own try/catch.
let logEntriesAdded = 0;
try {
  logEntriesAdded = deriveRootLogEntries(HYPO_DIR);
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] log-derive error: ${err?.message ?? String(err)}\n`);
}
try {
  emitGrowth();
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] error: ${err?.message ?? String(err)}\n`);
}

// Feed this hook's own writes into the session's scoped auto-commit
// set (see the sessionId comment above). No-op without a session_id.
try {
  const touched = [];
  if (hotWritten) touched.push('hot.md');
  if (logEntriesAdded > 0) touched.push('log.md');
  if (touched.length > 0) recordTouchedPaths(HYPO_DIR, sessionId, touched);
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] touched-paths error: ${err?.message ?? String(err)}\n`);
}

try {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
} catch {}
