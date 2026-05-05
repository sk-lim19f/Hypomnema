#!/usr/bin/env node
/**
 * wiki-hot-rebuild.mjs — Stop hook
 *
 * Rebuilds root hot.md in canonical format on every session end.
 * Preserves the project pointer table rows while refreshing dates
 * from each project's hot.md frontmatter `updated:` field.
 *
 * Claude manages: adding/removing project rows in the pointer table.
 * This script manages: frontmatter, H2 structure, date fields.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { WIKI_DIR } from './wiki-shared.mjs';

const HOT_PATH = join(WIKI_DIR, 'hot.md');

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
  const hotPath = join(WIKI_DIR, 'projects', slug, 'hot.md');
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

function rebuild() {
  if (!existsSync(HOT_PATH)) return;

  const current = readFileSync(HOT_PATH, 'utf-8');
  const rows = parsePointerRows(current);
  if (rows.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  const tableRows = rows.map(({ name, slug }) => {
    const date = getProjectDate(slug) || today;
    return `| ${name} | ${date} | [[projects/${slug}/hot]] |`;
  }).join('\n');

  const canonical = `---
title: Hot Cache — Pointer
type: reference
updated: ${today}
tags: [wiki, operations]
---

# Hot Cache

> Read at session start → navigate to relevant project hot.md.
> Update at session close: project hot.md + this file's "Active Projects" table.

## Active Projects

| Project | Last Session | Hot Cache |
|---|---|---|
${tableRows}

## Session Start Checklist

1. Check this file for the relevant project hot.md link
2. Read \`projects/<name>/hot.md\`
3. Check \`projects/<name>/session-log/YYYY-MM.md\` recent entries if needed
`;

  if (canonical !== current) writeFileSync(HOT_PATH, canonical);
}

try {
  rebuild();
} catch {}

try { console.log(JSON.stringify({ continue: true, suppressOutput: true })); } catch {}
