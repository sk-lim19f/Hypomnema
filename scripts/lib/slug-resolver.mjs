// scripts/lib/slug-resolver.mjs — shared slug resolution, extracted from
// lint.mjs and rename.mjs so a future consumer does not grow its own copy.
//
// Exposes TWO modes, deliberately not folded into one:
//
//   - existence-check (lint)         — buildSlugMap: a Set, membership only.
//     Fast, but cannot say WHICH page owns a form or whether it is shared.
//   - collision-aware owner (rename) — buildFormIndex + classifyTarget +
//     newTargetFor: a form → Set<rel> map, so a caller can tell an
//     unambiguous resolution from a shared one and refuse to auto-rewrite
//     the latter.
//
// Folding these into one structure would be a regression: lint only needs to
// know a link resolves to SOMETHING, while rename must refuse to touch a link
// whose form is shared by more than one page. Collectors stay separate too —
// lint's target universe is pages/projects/journal plus root .md and
// sources/* (collectLinkTargets, still in lint.mjs); rename scans the whole
// vault root and treats journal/session-log/weekly/archive/postmortems and
// sources/* as immutable link SOURCES (preservationClass, below).
//
// Masking, link-body parsing, and the immutability/realpath-containment rules
// travel with owner mode because rename's rewrite pipeline needs all of them
// together: mask non-wikilink regions, parse a link body, classify it against
// the form index, and refuse a target that resolves outside the vault.

import { lstatSync, realpathSync } from 'fs';
import { dirname, sep } from 'path';
import { slugForms } from './wikilink.mjs';

// ── existence-check slug map (lint mode) ────────────────────────────────────
// `extraTargets` are link-target-only slugs (root *.md, sources/*) that
// resolve wikilinks but are not themselves linted — added verbatim, with NO
// derived basename/dir-relative aliases, so they can't mask an unrelated
// broken link.
export function buildSlugMap(pages, extraTargets = []) {
  const map = new Set();
  for (const { rel } of pages) {
    const noExt = rel.replace(/\.md$/, '').replace(/\\/g, '/');
    const { full, bare, dirRel } = slugForms(noExt);
    map.add(full);
    map.add(bare);
    if (dirRel) map.add(dirRel);
  }
  for (const t of extraTargets) map.add(t);
  return map;
}

// ── collision-aware form index (owner mode) ─────────────────────────────────
export const dirRelForm = (slug) => slugForms(slug).dirRel;

// Unlike buildSlugMap above (a Set that silently dedups collisions), owner
// mode needs to KNOW when a form is shared, so it maps each form to the SET
// of page rels that expose it. Precedence forms per page: full noExt slug,
// bare basename, dir-relative (drop the leading scan-dir segment).
export function buildFormIndex(pages) {
  const index = new Map(); // form → Set<rel>
  const add = (form, rel) => {
    if (!form) return;
    if (!index.has(form)) index.set(form, new Set());
    index.get(form).add(rel);
  };
  for (const p of pages) {
    add(p.slug, p.rel);
    // sources/* are full-slug-only link targets, exactly as lint's
    // collectLinkTargets treats them: a bare `[[name]]` must NOT resolve to a
    // source file. Adding their bare/dir-relative aliases here would make a
    // real page's bare link look ambiguous and skip a legitimate rewrite.
    if (/(^|\/)sources(\/|$)/.test(p.rel)) continue;
    add(p.bare, p.rel);
    add(dirRelForm(p.slug), p.rel);
  }
  return index;
}

// Classify a link target against the from-page. Returns the form KIND when
// the target points at from-page, plus whether that form is ambiguous
// (shared with another page → unsafe to auto-rewrite).
export function classifyTarget(target, fromPage, formIndex) {
  const owners = formIndex.get(target);
  if (!owners || !owners.has(fromPage.rel)) return { kind: null, ambiguous: false };
  const ambiguous = owners.size > 1;
  let kind = null;
  if (target === fromPage.slug) kind = 'full';
  else if (target === dirRelForm(fromPage.slug)) kind = 'dirrel';
  else if (target === fromPage.bare) kind = 'bare';
  return { kind, ambiguous };
}

// The new target string for a matched form kind — same kind, new page.
export function newTargetFor(kind, toPage) {
  if (kind === 'full') return toPage.slug;
  if (kind === 'dirrel') return dirRelForm(toPage.slug) ?? toPage.bare;
  return toPage.bare; // bare
}

// ── wikilink masking (owner mode) ───────────────────────────────────────────
// Blank out fenced code, inline code, and HTML comments WITHOUT changing
// length, so a [[ref]] match index in the mask aligns with the same index in
// the source. Rewriting then edits the source at those exact spans, never
// touching a link that only appears inside a code sample.
export function maskNonWikilinkRegions(content) {
  let out = content;
  out = out.replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/^[ \t]{0,3}~~~[\s\S]*?^[ \t]{0,3}~~~/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/``[^`\n]*``/g, (m) => ' '.repeat(m.length));
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

// Parse the inside of a `[[ ... ]]` into { target, suffix } where suffix is
// the alias/anchor tail to preserve verbatim (including a table-escaped
// `\|`). The target capture stops before an optional `\` preceding the
// `|`/`#` delimiter, matching lint's extractor exactly.
export function splitLinkBody(body) {
  const m = body.match(/^([^|#\\]+?)(\\?[|#][\s\S]*)?$/);
  if (!m) return null;
  return { target: m[1].trim(), suffix: m[2] || '' };
}

// ── preservation class of a link-source path (owner mode) ──────────────────
// Two distinct reasons a file is normally skipped as a link SOURCE, kept
// separate because directory-mode renames treat them differently:
//
//   'timerecord' — append-only snapshots (journal / session-log / weekly /
//      archive / postmortems + root log.md). Rewriting a [[old]] inside a
//      past entry would falsify that moment.
//   'sources'    — sources/* immutable CAPTURED material. Never rewritten,
//      not even inside a moved subtree.
//
// Matches a path SEGMENT so `pages/journal/x.md` and
// `projects/p/session-log/y.md` both qualify. Returns null for ordinary live
// pages.
export function preservationClass(rel) {
  const p = rel.replace(/\\/g, '/');
  if (/(^|\/)sources(\/|$)/.test(p)) return 'sources';
  if (p === 'log.md') return 'timerecord';
  if (/(^|\/)(journal|session-log|weekly|archive|postmortems)(\/|$)/.test(p)) return 'timerecord';
  return null;
}

// A rename elsewhere in the vault must never churn a frozen snapshot or a
// source — both preservation classes count as a preserved link SOURCE.
export function isPreservedSource(rel) {
  return preservationClass(rel) !== null;
}

// ── realpath containment (owner mode) ───────────────────────────────────────
// Verify a path resolves, following any symlink ANCESTOR, to a location
// inside the real vault root. A lexical ../-check cannot catch this: a
// symlinked directory that is lexically in-vault can still resolve outside
// it. The destination may not exist, so the deepest existing prefix is
// resolved (its realpath is where a write would actually land). Fail-closed:
// returns false on any resolution error.
//
// The walk uses lstat (NOT existsSync) so a DANGLING symlink prefix is
// detected as present-but-unresolvable rather than skipped as absent —
// otherwise the walk would step past it to an in-vault parent and wrongly
// report containment.
export function realContainedInVault(absPath, realRoot) {
  let probe = absPath;
  for (;;) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch {
      exists = false;
    }
    if (exists) break;
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  let real;
  try {
    real = realpathSync(probe); // follows links; throws on a dangling symlink
  } catch {
    return false;
  }
  return real === realRoot || real.startsWith(realRoot + sep);
}
