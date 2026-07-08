// page-usage.mjs: read-only aggregation over .cache/page-usage.jsonl (B3)
//
// The lookup hook appends one JSONL record per injected page slug (see
// hooks/hypo-shared.mjs recordLookupUsage). This lib reads that log and derives
// "lookup-cold candidates": pages that have inbound wikilinks (so the graph
// treats them as live) but have not been injected by lookup within a recency
// window. It writes nothing and is only invoked from scripts (crystallize), so
// it never touches the per-prompt hook hot path.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { collectPagesCrystallize, extractWikilinks, slugForms } from './wikilink.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { currentDevice, scopeVisible, readVisibilityScope } from '../../hooks/hypo-shared.mjs';

const PAGE_USAGE_REL = '.cache/page-usage.jsonl';
const DAY_MS = 86400000;

// The distinct link forms a slug may appear as in a [[wikilink]] or in the log:
// its full path, its basename, and (when nested) the path minus its first
// segment. Matching by form-set intersection bridges the gap between the log's
// index-matched slug form and the reverse index's [[wikilink]] form.
function formSet(slug) {
  const f = slugForms(slug);
  const s = new Set([f.full, f.bare]);
  if (f.dirRel) s.add(f.dirRel);
  return s;
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// Read every record from the usage log, skipping malformed lines. Returns [] if
// the log is absent or unreadable (fail-soft: aggregation is advisory).
export function readPageUsage(hypoDir) {
  const path = join(hypoDir, PAGE_USAGE_REL);
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // Only keep plain objects. A bare `null`, number, string, or array is
      // valid JSON but not a record; keeping it would crash the field access in
      // aggregateColdCandidates (and crystallize calls that outside a try).
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed);
      }
    } catch {
      // malformed line → skip (log is append-only and may be partially written)
    }
  }
  return records;
}

// Derive lookup-cold candidates. Guards against cold-start: if there are no
// records, or the observed log span is shorter than minLogSpanDays, returns
// { status: 'insufficient-data' } so a fresh log doesn't flag the whole vault.
// Otherwise returns { status: 'ok', candidates: [{ slug, title }] } for pages
// that have >= 1 inbound wikilink from another page yet have not been logged
// within the last thresholdDays.
export function aggregateColdCandidates(
  hypoDir,
  {
    thresholdDays = 90,
    minLogSpanDays = 14,
    now = Date.now(),
    ignorePatterns = [],
    device = currentDevice(),
  } = {},
) {
  const records = readPageUsage(hypoDir);
  if (records.length === 0) return { status: 'insufficient-data', reason: 'no-records' };

  const times = records.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t));
  if (times.length === 0) return { status: 'insufficient-data', reason: 'no-timestamps' };
  const span = Math.max(...times) - Math.min(...times);
  if (span < minLogSpanDays * DAY_MS) {
    return { status: 'insufficient-data', reason: 'span-too-short' };
  }

  // Forms of every slug logged within the recency window.
  const recentCutoff = now - thresholdDays * DAY_MS;
  const recentForms = new Set();
  for (const r of records) {
    const t = Date.parse(r.ts);
    if (!Number.isFinite(t) || t < recentCutoff) continue;
    if (typeof r.slug !== 'string' || !r.slug) continue;
    for (const form of formSet(r.slug)) recentForms.add(form);
  }

  // Build the page list with slug, title, forms, and outbound links.
  const pagesDir = join(hypoDir, 'pages');
  const pageList = [];
  for (const { path, rel } of collectPagesCrystallize(pagesDir, hypoDir, ignorePatterns)) {
    let content;
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    const slug = rel.replace(/\.md$/, '');
    const body = content.replace(/^---[\s\S]*?---/, '');
    pageList.push({
      slug,
      title: fm.title || slug,
      forms: formSet(slug),
      links: extractWikilinks(body),
      scope: readVisibilityScope(content),
    });
  }

  // Reverse index: which page slugs receive >= 1 inbound link from another page.
  const formOwners = new Map(); // form → Set<page slug>
  for (const p of pageList) {
    for (const form of p.forms) {
      if (!formOwners.has(form)) formOwners.set(form, new Set());
      formOwners.get(form).add(p.slug);
    }
  }
  const hasInbound = new Set();
  for (const p of pageList) {
    for (const link of p.links) {
      const targets = new Set();
      for (const form of formSet(link)) {
        const owners = formOwners.get(form);
        if (owners) for (const o of owners) targets.add(o);
      }
      for (const t of targets) if (t !== p.slug) hasInbound.add(t);
    }
  }

  const candidates = pageList
    .filter(
      (p) =>
        hasInbound.has(p.slug) && !intersects(p.forms, recentForms) && scopeVisible(p.scope, device),
    )
    .map((p) => ({ slug: p.slug, title: p.title }));

  return { status: 'ok', candidates };
}
