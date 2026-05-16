#!/usr/bin/env node
/**
 * Hypomnema graph script
 *
 * Generates a wikilink dependency graph from wiki pages.
 * Outputs adjacency list (default) or Mermaid diagram.
 *
 * Usage:
 *   node scripts/graph.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --format=<fmt>      Output format: json | mermaid | dot  (default: json)
 *   --min-edges=<n>     Only include nodes with at least N edges (default: 0)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, format: 'json', minEdges: 0 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--format=')) args.format = arg.slice(9);
    else if (arg.startsWith('--min-edges=')) args.minEdges = parseInt(arg.slice(12), 10) || 0;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── page collector ────────────────────────────────────────────────────────────

function collectPages(dir, root, pages = [], ignorePatterns = []) {
  if (!existsSync(dir)) return pages;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectPages(full, root, pages, ignorePatterns);
    } else if (extname(entry) === '.md' && !entry.startsWith('.')) {
      const slug = relative(root, full).replace(/\.md$/, '').replace(/\\/g, '/');
      pages.push({ path: full, slug, bare: basename(full, '.md') });
    }
  }
  return pages;
}

// ── slug resolver ─────────────────────────────────────────────────────────────

function buildSlugIndex(pages) {
  const index = new Map();
  for (const p of pages) {
    index.set(p.slug, p.slug);
    if (!index.has(p.bare)) index.set(p.bare, p.slug);
  }
  return index;
}

// ── wikilink extractor ────────────────────────────────────────────────────────

function extractWikilinks(content) {
  const links = [];
  for (const m of content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)) {
    links.push(m[1].trim());
  }
  return links;
}

// ── graph builder ─────────────────────────────────────────────────────────────

function buildGraph(pages, slugIndex) {
  const edges = [];
  const inDegree = new Map();
  const outDegree = new Map();

  for (const p of pages) {
    inDegree.set(p.slug, 0);
    outDegree.set(p.slug, 0);
  }

  for (const p of pages) {
    let content;
    try {
      content = readFileSync(p.path, 'utf-8');
    } catch {
      continue;
    }
    for (const link of extractWikilinks(content)) {
      const target = slugIndex.get(link);
      if (target && target !== p.slug) {
        edges.push({ from: p.slug, to: target });
        outDegree.set(p.slug, (outDegree.get(p.slug) || 0) + 1);
        inDegree.set(target, (inDegree.get(target) || 0) + 1);
      }
    }
  }

  return { edges, inDegree, outDegree };
}

// ── label escapers ────────────────────────────────────────────────────────────

function escapeMermaid(s) {
  return s.replace(/"/g, '#quot;');
}
function escapeDot(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── formatters ────────────────────────────────────────────────────────────────

function formatJson(pages, graph, minEdges) {
  const nodes = pages
    .map((p) => ({
      slug: p.slug,
      in: graph.inDegree.get(p.slug) || 0,
      out: graph.outDegree.get(p.slug) || 0,
    }))
    .filter((n) => minEdges === 0 || n.in + n.out >= minEdges)
    .sort((a, b) => b.in + b.out - (a.in + a.out));

  const edges = graph.edges.filter((e) => {
    const fn = nodes.find((n) => n.slug === e.from);
    const tn = nodes.find((n) => n.slug === e.to);
    return fn && tn;
  });

  return JSON.stringify({ nodes, edges }, null, 2);
}

function formatMermaid(pages, graph, minEdges) {
  const activeNodes = new Set(
    pages
      .filter((p) => {
        const total = (graph.inDegree.get(p.slug) || 0) + (graph.outDegree.get(p.slug) || 0);
        return total >= minEdges;
      })
      .map((p) => p.slug),
  );

  const lines = ['graph TD'];
  for (const { from, to } of graph.edges) {
    if (activeNodes.has(from) && activeNodes.has(to)) {
      const f = from.replace(/[^a-zA-Z0-9_]/g, '_');
      const t = to.replace(/[^a-zA-Z0-9_]/g, '_');
      lines.push(`  ${f}["${escapeMermaid(from)}"] --> ${t}["${escapeMermaid(to)}"]`);
    }
  }
  return lines.join('\n');
}

function formatDot(pages, graph, minEdges) {
  const activeNodes = new Set(
    pages
      .filter((p) => {
        const total = (graph.inDegree.get(p.slug) || 0) + (graph.outDegree.get(p.slug) || 0);
        return total >= minEdges;
      })
      .map((p) => p.slug),
  );

  const lines = ['digraph wiki {', '  rankdir=LR;'];
  for (const { from, to } of graph.edges) {
    if (activeNodes.has(from) && activeNodes.has(to)) {
      lines.push(`  "${escapeDot(from)}" -> "${escapeDot(to)}";`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const scanDirs = ['pages', 'projects'].map((d) => join(args.hypoDir, d));
const pages = scanDirs.flatMap((d) => collectPages(d, args.hypoDir, [], ignorePatterns));
const slugIndex = buildSlugIndex(pages);
const graph = buildGraph(pages, slugIndex);

switch (args.format) {
  case 'mermaid':
    console.log(formatMermaid(pages, graph, args.minEdges));
    break;
  case 'dot':
    console.log(formatDot(pages, graph, args.minEdges));
    break;
  default:
    console.log(formatJson(pages, graph, args.minEdges));
}
