// Shared wikilink primitives — the ONE source of truth for vault traversal,
// slug-form generation, and bare wikilink extraction.
//
// Consumed by:
//   - scripts/lint.mjs        (slug map, page collection, link-target scan)
//   - scripts/rename.mjs      (form index with collision detection, page scan)
//   - scripts/graph.mjs       (slug index, page collection, link extraction)
//   - scripts/crystallize.mjs (page collection, link extraction)
//
// IMPR-13 consolidation. Before this lib, each script carried its own copy of
// collectPages + a slug-form deriver, drifting in subtle ways. The four
// collectPages variants are NOT interchangeable — they differ deliberately in
// traversal/security/output-shape policy (codex design review, CONCERN):
//
//   - rename uses lstat + skips symlinks   → a vault scan can never escape via a
//     symlinked dir/file (security boundary).
//   - lint skips `_`-prefixed DIRECTORIES  → pages/feedback/_drafts scaffolds
//     stay out of the lint set, while `_`-prefixed FILES (e.g. _index.md) lint.
//   - crystallize skips ANY `.`-prefixed entry (dir AND file).
//   - graph/lint/rename skip only `.`-prefixed FILES.
//   - graph/crystallize emit raw `rel`/`slug`; lint keeps OS-native `rel`
//     (its own buildSlugMap POSIX-normalizes downstream); rename/graph
//     POSIX-normalize the slug at scan time.
//
// So this lib exposes ONE walker core plus four NAMED PRESETS, not a pile of
// boolean flags — each preset pins exactly one caller's historical behavior and
// is fixed by a unit test. readdirSync order is preserved verbatim (NO sort):
// graph's bare-first slug index is order-sensitive (first page wins a shared
// bare form), so adding a sort would silently change resolution.
//
// Collision RESOLUTION is intentionally NOT shared: lint dedups into a Set
// (membership), rename detects ambiguity to refuse unsafe auto-rewrites, graph
// is first-wins. Each caller builds its own structure from slugForms(); only the
// form GENERATION lives here.

import { existsSync, readdirSync, statSync, lstatSync } from 'fs';
import { join, relative, extname, basename } from 'path';
import { isScanIgnored } from './hypo-ignore.mjs';

// ── markdown page walker (shared core) ─────────────────────────────────────────
// `policy` keys (all optional):
//   lstat            — stat with lstatSync and skip symlinks (rename's security
//                      boundary). Default: statSync, symlinks followed.
//   skipDotEntry     — skip ANY entry (dir or file) whose name starts with `.`
//                      BEFORE the ignore check (crystallize).
//   skipUnderscoreDir— skip directories whose name starts with `_` (lint).
//   skipDotFile      — among `.md` files, skip names starting with `.`.
//   shape(full)      — build the per-page record pushed onto the accumulator.
function walkMarkdown(dir, root, ignorePatterns, policy, acc) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (policy.skipDotEntry && entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (isScanIgnored(full, root, ignorePatterns)) continue;
    const st = policy.lstat ? lstatSync(full) : statSync(full);
    if (policy.lstat && st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (policy.skipUnderscoreDir && entry.startsWith('_')) continue;
      walkMarkdown(full, root, ignorePatterns, policy, acc);
    } else if (extname(entry) === '.md' && !(policy.skipDotFile && entry.startsWith('.'))) {
      acc.push(policy.shape(full));
    }
  }
  return acc;
}

const posixSlug = (full, root) => relative(root, full).replace(/\.md$/, '').replace(/\\/g, '/');

// lint: `_`-dir skip + `_`-file kept; OS-native `rel` (buildSlugMap normalizes).
export function collectPagesLint(dir, root, ignorePatterns = []) {
  return walkMarkdown(
    dir,
    root,
    ignorePatterns,
    {
      skipDotFile: true,
      skipUnderscoreDir: true,
      shape: (full) => ({ path: full, rel: relative(root, full) }),
    },
    [],
  );
}

// graph: POSIX slug + bare, no `rel`.
export function collectPagesGraph(dir, root, ignorePatterns = []) {
  return walkMarkdown(
    dir,
    root,
    ignorePatterns,
    {
      skipDotFile: true,
      shape: (full) => ({ path: full, slug: posixSlug(full, root), bare: basename(full, '.md') }),
    },
    [],
  );
}

// rename: lstat + symlink skip (security); POSIX rel/slug/bare.
export function collectPagesRename(dir, root, ignorePatterns = []) {
  return walkMarkdown(
    dir,
    root,
    ignorePatterns,
    {
      lstat: true,
      skipDotFile: true,
      shape: (full) => {
        const rel = relative(root, full).replace(/\\/g, '/');
        return { path: full, rel, slug: rel.replace(/\.md$/, ''), bare: basename(full, '.md') };
      },
    },
    [],
  );
}

// crystallize: skip ANY `.`-prefixed entry; OS-native `rel`.
export function collectPagesCrystallize(dir, root, ignorePatterns = []) {
  return walkMarkdown(
    dir,
    root,
    ignorePatterns,
    { skipDotEntry: true, shape: (full) => ({ path: full, rel: relative(root, full) }) },
    [],
  );
}

// ── slug-form generation ───────────────────────────────────────────────────────
// From a POSIX no-extension slug (e.g. `pages/learnings/foo`), derive the three
// link forms a [[wikilink]] may use:
//   full   — the whole slug                       [[pages/learnings/foo]]
//   bare   — the basename                         [[foo]]
//   dirRel — slug minus the leading scan-dir seg  [[learnings/foo]]  (null if the
//            slug has no `/`, i.e. nothing to drop)
// Callers pick which forms to register and own their own collision policy. Do NOT
// apply this to link-target-only slugs (lint's root-md/sources extraTargets,
// rename's sources/*) — those resolve VERBATIM, with no derived alias, so a bare
// form can't mask an unrelated broken link or block a safe rewrite.
export function slugForms(slug) {
  const slash = slug.indexOf('/');
  return { full: slug, bare: basename(slug), dirRel: slash === -1 ? null : slug.slice(slash + 1) };
}

// ── bare wikilink extraction (graph/crystallize variant) ───────────────────────
// Raw extraction: matches [[target]] / [[target|alias]] / [[target#anchor]]
// anywhere, INCLUDING inside code fences (graph counts those as edges, and
// crystallize counts them for unlinked-page detection — preserving that is
// behavior-stable). lint uses a DIFFERENT extractor (strips code regions and
// handles table-escaped `\|`); rename uses length-preserving masking. Neither
// shares this one.
export function extractWikilinks(content) {
  const links = [];
  for (const m of content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)) {
    links.push(m[1].trim());
  }
  return links;
}
