#!/usr/bin/env node
/**
 * rename.mjs — rename a wiki page and rewrite inbound wikilinks.
 *
 * A bare `git mv` leaves every `[[old]]` / `[[old|alias]]` / `[[old#anchor]]` /
 * `[[dir/old]]` pointing at a now-missing target — broken links accumulate on
 * every rename. This helper moves the page AND content-aware rewrites every
 * inbound reference across the vault so a rename never breaks a link.
 *
 *   node rename.mjs --hypo-dir=<dir> --from=<slug|rel> --to=<slug|rel> [--apply] [--json]
 *
 * Default is a dry-run (report only); --apply performs the move + rewrites.
 *
 * Two modes, auto-detected from --from:
 *   • page mode — --from resolves to a .md page (the original behavior below).
 *   • directory mode — --from is an existing directory: the whole subtree is
 *     relocated (renameSync, carrying non-.md assets) and inbound full-slug /
 *     dir-relative links are rewritten across the vault. See runDirectory.
 *
 * Two design invariants:
 *
 * 1. Resolution, not string-match. A link `[[foo]]` (bare basename) can be
 *    shared by two pages; a blind text replace would break the wrong one. Each
 *    link target is resolved with the SAME precedence lint uses (full noExt →
 *    bare basename → dir-relative drop). A reference is rewritten only when it
 *    resolves UNAMBIGUOUSLY to the from-page. An ambiguous bare form (the slug
 *    maps to >1 file) is reported, never auto-rewritten — which also makes the
 *    ADR-renumber guard free: a `--to` that is not a unique destination is
 *    rejected.
 *
 * 2. Preserve append-only time records. journal / session-log / weekly / archive
 *    / postmortems (and root log.md) are frozen snapshots — rewriting a `[[old]]`
 *    inside a past entry would falsify that moment's record. They are skipped as
 *    link SOURCES. sources/* is likewise immutable. This tool's value is "update
 *    live links at rename time", not "retroactively churn old snapshots".
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'fs';
import { join, basename, dirname, normalize, isAbsolute, sep } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore } from './lib/hypo-ignore.mjs';
import { collectPagesRename, slugForms } from './lib/wikilink.mjs';

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, from: null, to: null, apply: false, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--from=')) args.from = arg.slice(7);
    else if (arg.startsWith('--to=')) args.to = arg.slice(5);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── preservation class of a link-source path ───────────────────────────────────
// Two distinct reasons a file is normally skipped as a link SOURCE, kept separate
// because directory mode treats them differently (codex design BLOCKER):
//
//   'timerecord' — append-only snapshots (journal / session-log / weekly / archive
//      / postmortems + root log.md). Rewriting a [[old]] inside a past entry would
//      falsify that moment. BUT a directory move relocates the whole subtree, so a
//      time-record INSIDE the moved subtree that links a moving sibling must update
//      that intra-subtree path label (the page genuinely moved); see runDirectory.
//
//   'sources'    — sources/* immutable CAPTURED material. Never rewritten, not even
//      inside a moved subtree: a directory move must not claim ownership over the
//      bytes of an external source we transcribed verbatim.
//
// Matches a path SEGMENT so `pages/journal/x.md` and `projects/p/session-log/y.md`
// both qualify. Returns null for ordinary live pages.
function preservationClass(rel) {
  const p = rel.replace(/\\/g, '/');
  if (/(^|\/)sources(\/|$)/.test(p)) return 'sources';
  if (p === 'log.md') return 'timerecord';
  if (/(^|\/)(journal|session-log|weekly|archive|postmortems)(\/|$)/.test(p)) return 'timerecord';
  return null;
}

// Single-page mode preserves BOTH classes as link sources (unchanged behavior): a
// rename elsewhere in the vault must never churn a frozen snapshot or a source.
function isPreservedSource(rel) {
  return preservationClass(rel) !== null;
}

// ── slug-form index (resolution with collision detection) ──────────────────────
// Unlike lint's buildSlugMap (a Set that silently dedups collisions), rename
// needs to KNOW when a form is shared, so it maps each form → the set of page
// rels that expose it. precedence forms per page: full noExt slug, bare
// basename, dir-relative (drop the leading scan-dir segment).
const dirRelForm = (slug) => slugForms(slug).dirRel;

function buildFormIndex(pages) {
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
    // source file. Adding their bare/dir-relative aliases here would make a real
    // page's bare link look ambiguous and skip a legitimate rewrite.
    if (/(^|\/)sources(\/|$)/.test(p.rel)) continue;
    add(p.bare, p.rel);
    add(dirRelForm(p.slug), p.rel);
  }
  return index;
}

// Classify a link target against the from-page. Returns the form KIND when the
// target points at from-page, plus whether that form is ambiguous (shared with
// another page → unsafe to auto-rewrite).
function classifyTarget(target, fromPage, formIndex) {
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
function newTargetFor(kind, toPage) {
  if (kind === 'full') return toPage.slug;
  if (kind === 'dirrel') return dirRelForm(toPage.slug) ?? toPage.bare;
  return toPage.bare; // bare
}

// ── wikilink masking (mirror lint.mjs stripNonWikilinkRegions) ──────────────────
// Blank out fenced code, inline code, and HTML comments WITHOUT changing length,
// so a [[ref]] match index in the mask aligns with the same index in the source.
// Rewriting then edits the source at those exact spans, never touching a link
// that only appears inside a code sample.
function maskNonWikilinkRegions(content) {
  let out = content;
  out = out.replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/^[ \t]{0,3}~~~[\s\S]*?^[ \t]{0,3}~~~/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/``[^`\n]*``/g, (m) => ' '.repeat(m.length));
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

// Parse the inside of a `[[ ... ]]` into { target, suffix } where suffix is the
// alias/anchor tail to preserve verbatim (including a table-escaped `\|`). The
// target capture stops before an optional `\` preceding the `|`/`#` delimiter,
// matching lint's extractor exactly.
function splitLinkBody(body) {
  const m = body.match(/^([^|#\\]+?)(\\?[|#][\s\S]*)?$/);
  if (!m) return null;
  return { target: m[1].trim(), suffix: m[2] || '' };
}

// Rewrite every inbound reference to fromPage in `content`. Returns
// { content, rewrites, ambiguous } where rewrites/ambiguous list the links
// changed / skipped-as-ambiguous (with their 1-based line numbers).
function rewriteContent(content, fromPage, toPage, formIndex) {
  const mask = maskNonWikilinkRegions(content);
  const re = /\[\[([^\]]+?)\]\]/g;
  const edits = []; // { start, end, replacement }
  const rewrites = [];
  const ambiguous = [];
  let m;
  while ((m = re.exec(mask)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const body = content.slice(start + 2, end - 2); // real body from source
    const parsed = splitLinkBody(body);
    if (!parsed) continue;
    const { kind, ambiguous: amb } = classifyTarget(parsed.target, fromPage, formIndex);
    if (!kind) continue; // does not resolve to from-page
    const line = content.slice(0, start).split('\n').length;
    if (amb) {
      ambiguous.push({ link: m[0], line, target: parsed.target });
      continue; // shared form — report, never auto-rewrite
    }
    const replacement = `[[${newTargetFor(kind, toPage)}${parsed.suffix}]]`;
    edits.push({ start, end, replacement });
    rewrites.push({ from: m[0], to: replacement, line });
  }
  // Apply edits back-to-front so earlier indices stay valid.
  let out = content;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return { content: out, rewrites, ambiguous };
}

// ── resolve a --from / --to argument to a page rel + forms ──────────────────────
// Accepts a full rel ("pages/foo.md" / "pages/foo"), a noExt slug, or a bare
// basename when unambiguous. Returns { rel, slug, bare } or null.
function resolveArgToPage(arg, pages, formIndex) {
  const norm = arg.replace(/\\/g, '/').replace(/\.md$/, '');
  // exact full-slug match first
  const direct = pages.find((p) => p.slug === norm);
  if (direct) return direct;
  const owners = formIndex.get(norm);
  if (owners && owners.size === 1) {
    const rel = [...owners][0];
    return pages.find((p) => p.rel === rel) || null;
  }
  return null; // missing or ambiguous
}

function fail(args, msg) {
  if (args.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── directory mode ─────────────────────────────────────────────────────────────
// A directory rename relocates a whole subtree (`projects/old/**` → `projects/new/**`)
// and rewrites inbound links across the vault. Key facts that shape the algorithm:
//
//  • A directory move does NOT change basenames, only the path prefix. So bare
//    `[[0052]]` links keep resolving to the relocated page automatically and need
//    NO rewrite — only the FULL-slug and 1-seg DIR-RELATIVE forms encode the moved
//    prefix and break. (Forms that drop ≥2 segments, e.g. `[[decisions/NNNN]]`, do
//    not encode the renamed prefix either: lint cannot resolve them today and they
//    survive a move unchanged — out of scope, matching lint's buildSlugMap.)
//  • Every moved page is BOTH a target (it relocates) and a source (its links to
//    moving siblings must update). The move is done with one renameSync of the
//    whole directory — which also carries non-.md assets (logo svg/png, etc.) — and
//    rewritten page bodies are written at their NEW paths afterward.

// Recursively detect any symlink under a directory (lstat, never follows). A moved
// subtree containing a symlink is refused: renameSync would move the link verbatim
// and statSync-based page collection could otherwise pull external pages in.
function subtreeHasSymlink(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) return true;
    if (st.isDirectory() && subtreeHasSymlink(full)) return true;
  }
  return false;
}

// Classify a link target against the SET of moving pages. Only FULL / DIR-RELATIVE
// kinds are rewritten (bare survives a dir move untouched). Returns:
//   { kind: null }                              → not (uniquely) a moving target
//   { kind: null, ambiguous: true, target }     → form shared by >1 page, a mover
//                                                  among them → report, never rewrite
//   { kind, fromPage, toPage }                  → unambiguous moving target
function classifyMovedTarget(target, movedByRel, formIndex) {
  const owners = formIndex.get(target);
  if (!owners) return { kind: null };
  const movingOwners = [...owners].filter((rel) => movedByRel.has(rel));
  if (movingOwners.length === 0) return { kind: null }; // link unrelated to this move
  if (owners.size > 1) {
    // Shared form. Bare collisions are irrelevant (bare is never rewritten in dir
    // mode); only a shared full/dirrel form is worth reporting. full slugs are
    // unique, so this realistically only guards an exotic dir-relative clash.
    const rel = movingOwners[0];
    const { fromPage } = movedByRel.get(rel);
    if (target === fromPage.slug || target === dirRelForm(fromPage.slug)) {
      return { kind: null, ambiguous: true, target };
    }
    return { kind: null };
  }
  const rel = movingOwners[0];
  const { fromPage, toPage } = movedByRel.get(rel);
  let kind = null;
  if (target === fromPage.slug) kind = 'full';
  else if (target === dirRelForm(fromPage.slug)) kind = 'dirrel';
  // bare (target === fromPage.bare) → intentionally null: unchanged by a dir move.
  if (!kind) return { kind: null };
  return { kind, fromPage, toPage };
}

// Rewrite inbound references to any moving page in `content`. aliasPreserve keeps
// the original rendered label via `[[new|old]]` for unaliased links — used for
// time-record files inside the moved subtree so a relocated snapshot still reads
// with its original path label while linking to the live page.
function rewriteContentDir(content, movedByRel, formIndex, aliasPreserve) {
  const mask = maskNonWikilinkRegions(content);
  const re = /\[\[([^\]]+?)\]\]/g;
  const edits = [];
  const rewrites = [];
  const ambiguous = [];
  let m;
  while ((m = re.exec(mask)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const body = content.slice(start + 2, end - 2);
    const parsed = splitLinkBody(body);
    if (!parsed) continue;
    const cls = classifyMovedTarget(parsed.target, movedByRel, formIndex);
    const line = content.slice(0, start).split('\n').length;
    if (cls.ambiguous) {
      ambiguous.push({ link: m[0], line, target: parsed.target });
      continue;
    }
    if (!cls.kind) continue;
    const newTarget = newTargetFor(cls.kind, cls.toPage);
    const replacement =
      aliasPreserve && parsed.suffix === ''
        ? `[[${newTarget}|${parsed.target}]]`
        : `[[${newTarget}${parsed.suffix}]]`;
    edits.push({ start, end, replacement });
    rewrites.push({ from: m[0], to: replacement, line });
  }
  let out = content;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return { content: out, rewrites, ambiguous };
}

// Verify a path resolves — following any symlink ANCESTOR — to a location inside
// the real vault root. A lexical ../-check cannot catch this: `projects/link/new`
// where `projects/link` → /tmp/outside is lexically in-vault, yet renameSync would
// follow the symlink and write across the vault boundary. The destination may not
// exist, so the deepest existing prefix is resolved (its realpath is where a write
// would actually land). Fail-closed: returns false on any resolution error.
//
// The walk uses lstat (NOT existsSync) so a DANGLING symlink prefix is detected as
// present-but-unresolvable rather than skipped as absent — otherwise the walk would
// step past it to an in-vault parent and wrongly report containment, letting an
// external rewrite land before renameSync crashes on the dangling target.
function realContainedInVault(absPath, realRoot) {
  let probe = absPath;
  // Walk up to the deepest path component that exists as a link-or-real entry.
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

// The destination's deepest existing ancestor must be a directory. Otherwise
// mkdirSync(dirname, {recursive}) fails with ENOTDIR — but only AFTER the inbound
// rewrites were already written, leaving a partial mutation on a move that can
// never complete (e.g. `--to=projects/file/sub` where `projects/file` is a regular
// file). Refuse up front so a failed move never churns the vault. Runs after the
// realpath-containment check, so a symlink-to-dir ancestor is already in-vault.
function destinationHostable(absPath) {
  let probe = dirname(absPath);
  for (;;) {
    let st;
    try {
      st = statSync(probe);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
      continue;
    }
    return st.isDirectory();
  }
}

function runDirectory(args, fromDirRel, ignorePatterns) {
  const fromAbs = join(args.hypoDir, fromDirRel);
  if (lstatSync(fromAbs).isSymbolicLink()) {
    fail(args, `--from '${args.from}' is a symlink — refusing to rename a linked directory`);
  }
  // Real-root containment: reject a --from whose realpath (after following any
  // symlink ancestor) lands outside the vault — else the move would drag an
  // outside-the-vault directory in.
  let realRoot;
  try {
    realRoot = realpathSync(args.hypoDir);
  } catch {
    fail(args, `wiki root cannot be resolved: ${args.hypoDir}`);
  }
  if (!realContainedInVault(fromAbs, realRoot)) {
    fail(args, `--from '${args.from}' resolves outside the wiki root (symlink escape)`);
  }

  // Destination: normalize + keep inside the vault (mirrors page mode's --to guard).
  const toNorm = args.to.replace(/\\/g, '/').replace(/\.md$/, '').replace(/\/+$/, '');
  const toDirRel = normalize(toNorm).replace(/\\/g, '/');
  if (toDirRel === '..' || toDirRel.startsWith('../') || isAbsolute(toDirRel) || toDirRel === '.') {
    fail(args, `--to escapes the wiki root: ${args.to}`);
  }
  if (toDirRel === fromDirRel) {
    fail(args, `--from and --to are the same directory (${toDirRel}) — nothing to rename`);
  }
  // Same top-level segment only. A move that changes the leading scan-dir segment
  // (e.g. journal/x → pages/x) would change the targetability class and the
  // dir-relative form semantics; that is out of scope for this increment.
  const fromTop = fromDirRel.split('/')[0];
  const toTop = toDirRel.split('/')[0];
  if (fromTop !== toTop) {
    fail(
      args,
      `--to '${toDirRel}' changes the top-level area ('${fromTop}' → '${toTop}'). ` +
        `Cross-area directory moves are not supported (they change link resolution).`,
    );
  }
  // No nesting either way: renaming a dir into its own subtree (or vice versa) is
  // undefined.
  if (toDirRel === fromDirRel || toDirRel.startsWith(`${fromDirRel}/`)) {
    fail(args, `--to '${toDirRel}' is nested inside --from '${fromDirRel}'`);
  }
  if (fromDirRel.startsWith(`${toDirRel}/`)) {
    fail(args, `--from '${fromDirRel}' is nested inside --to '${toDirRel}'`);
  }
  // Real-root containment for the destination: a symlinked --to ancestor (e.g.
  // `projects/link` → /tmp/outside) is lexically in-vault but renameSync would
  // follow it and write outside the vault. Resolve the deepest existing prefix.
  const toAbs = join(args.hypoDir, toDirRel);
  if (!realContainedInVault(toAbs, realRoot)) {
    fail(args, `--to '${args.to}' resolves outside the wiki root (symlink escape)`);
  }
  if (!destinationHostable(toAbs)) {
    fail(args, `--to '${args.to}' has a non-directory ancestor — destination cannot be created`);
  }
  if (subtreeHasSymlink(fromAbs)) {
    fail(args, `--from subtree contains a symlink — refusing (move could escape the vault)`);
  }

  const pages = collectPagesRename(args.hypoDir, args.hypoDir, ignorePatterns);
  const formIndex = buildFormIndex(pages);

  // The moving pages: every collected page whose rel is under the from-directory.
  const prefix = `${fromDirRel}/`;
  const movedByRel = new Map(); // rel → { fromPage, toPage }
  for (const p of pages) {
    if (!p.rel.startsWith(prefix)) continue;
    const toRel = `${toDirRel}/${p.rel.slice(prefix.length)}`;
    const toPage = {
      rel: toRel,
      slug: toRel.replace(/\.md$/, ''),
      bare: basename(toRel, '.md'),
      path: join(args.hypoDir, toRel),
    };
    movedByRel.set(p.rel, { fromPage: p, toPage });
  }
  if (movedByRel.size === 0) {
    fail(args, `--from '${fromDirRel}' contains no wiki pages to rename`);
  }

  // Renumber / merge report: a destination that already exists means this is not a
  // clean 1:1 move. Rather than a terse hard-fail, report exactly which destination
  // paths collide and refuse --apply, leaving the merge/renumber for manual handling.
  if (existsSync(toAbs)) {
    const collisions = [];
    for (const { toPage } of movedByRel.values()) {
      if (existsSync(toPage.path)) collisions.push(toPage.rel);
    }
    const report = {
      ok: false,
      error: `--to '${toDirRel}' already exists — directory rename requires a fresh destination`,
      reason: 'renumber-or-merge',
      from: fromDirRel,
      to: toDirRel,
      destination_collisions: collisions,
    };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.error(`✗ ${report.error}`);
      console.error(
        `  This is a renumber/merge: ${collisions.length} destination page(s) already exist.`,
      );
      for (const c of collisions) console.error(`    · ${c}`);
      console.error(`  Resolve manually (merge or renumber), then retry into a fresh directory.`);
    }
    process.exit(1);
  }

  // Post-move form index: validate that no moved page's GENERATED full/dir-relative
  // form collides with a different page in the post-move world. (Bare forms and
  // full slugs cannot collide here — the destination dir is fresh — so this guards
  // the exotic dir-relative clash, per the codex design BLOCKER.)
  const postIndex = new Map(); // form → Set<post-rel>
  const addPost = (form, rel) => {
    if (!form) return;
    if (!postIndex.has(form)) postIndex.set(form, new Set());
    postIndex.get(form).add(rel);
  };
  for (const p of pages) {
    const mv = movedByRel.get(p.rel);
    const target = mv ? mv.toPage : p;
    addPost(target.slug, target.rel);
    if (/(^|\/)sources(\/|$)/.test(target.rel)) continue;
    addPost(target.bare, target.rel);
    addPost(dirRelForm(target.slug), target.rel);
  }
  const formCollisions = [];
  for (const { toPage } of movedByRel.values()) {
    for (const form of [toPage.slug, dirRelForm(toPage.slug)]) {
      if (!form) continue;
      const owners = postIndex.get(form);
      if (owners && [...owners].some((rel) => rel !== toPage.rel)) {
        formCollisions.push({ form, page: toPage.rel });
      }
    }
  }
  if (formCollisions.length > 0) {
    const report = {
      ok: false,
      error: 'directory rename would create ambiguous link forms',
      reason: 'form-collision',
      from: fromDirRel,
      to: toDirRel,
      form_collisions: formCollisions,
    };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.error(`✗ ${report.error}`);
      for (const fc of formCollisions) console.error(`    · '${fc.form}' (${fc.page})`);
    }
    process.exit(1);
  }

  // Rewrite inbound references across the vault.
  const externalWrites = new Map(); // abs path → content (non-moved source files)
  const movedBodies = new Map(); // new rel → content (moved page bodies, written post-move)
  const fileResults = [];
  const ambiguities = [];
  let totalRewrites = 0;
  for (const p of pages) {
    const cls = preservationClass(p.rel);
    const inSubtree = movedByRel.has(p.rel);
    // Eligibility:
    //  sources/*            → never rewritten (immutable), even inside the subtree.
    //  time-record outside  → frozen (a snapshot elsewhere must not change).
    //  time-record inside   → rewrite intra-subtree links, preserving the rendered
    //                         label via [[new|old]] (the page genuinely relocated).
    //  ordinary page        → rewrite normally.
    if (cls === 'sources') continue;
    if (cls === 'timerecord' && !inSubtree) continue;
    const aliasPreserve = cls === 'timerecord' && inSubtree;
    let raw;
    try {
      raw = readFileSync(p.path, 'utf-8');
    } catch {
      continue;
    }
    const { content, rewrites, ambiguous } = rewriteContentDir(
      raw,
      movedByRel,
      formIndex,
      aliasPreserve,
    );
    if (rewrites.length > 0) {
      const landRel = inSubtree ? movedByRel.get(p.rel).toPage.rel : p.rel;
      fileResults.push({ file: landRel, rewrites });
      totalRewrites += rewrites.length;
      if (inSubtree) movedBodies.set(movedByRel.get(p.rel).toPage.rel, content);
      else externalWrites.set(p.path, content);
    }
    if (ambiguous.length > 0) ambiguities.push({ file: p.rel, ambiguous });
  }

  // Apply: external rewrites in place → renameSync the whole subtree (carries
  // non-.md assets) → write rewritten moved bodies at their new paths.
  let moved = false;
  if (args.apply) {
    for (const [path, content] of externalWrites) writeFileSync(path, content);
    mkdirSync(dirname(toAbs), { recursive: true });
    renameSync(fromAbs, toAbs);
    for (const [newRel, content] of movedBodies) {
      writeFileSync(join(args.hypoDir, newRel), content);
    }
    moved = true;
  }

  const result = {
    ok: true,
    applied: args.apply,
    mode: 'directory',
    from: fromDirRel,
    to: toDirRel,
    moved,
    pages_moved: movedByRel.size,
    files_rewritten: fileResults.length,
    links_rewritten: totalRewrites,
    rewrites: fileResults,
    ambiguous: ambiguities,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mode = args.apply ? 'Renamed directory' : 'Dry-run (no changes written)';
    console.log(`${mode}: ${fromDirRel}/ → ${toDirRel}/ (${movedByRel.size} page(s))`);
    console.log(`  ${totalRewrites} inbound link(s) across ${fileResults.length} file(s).`);
    for (const f of fileResults) {
      console.log(`  · ${f.file}: ${f.rewrites.map((r) => `${r.from}→${r.to}`).join(', ')}`);
    }
    if (ambiguities.length > 0) {
      console.log('\n  ⚠ ambiguous links NOT rewritten (form shared by >1 page):');
      for (const a of ambiguities) {
        for (const x of a.ambiguous) console.log(`    · ${a.file}:${x.line} ${x.link}`);
      }
    }
    if (!args.apply) console.log('\n  Re-run with --apply to write the move + rewrites.');
  }
  process.exit(0);
}

// ── main ────────────────────────────────────────────────────────────────────

function run(args) {
  if (!args.from || !args.to) {
    fail(args, '--from=<slug|rel> and --to=<slug|rel> are required');
  }
  const ignorePatterns = loadHypoIgnore(args.hypoDir);

  // Directory mode: --from points at an existing directory → relocate the subtree.
  const fromNorm = args.from.replace(/\\/g, '/').replace(/\.md$/, '').replace(/\/+$/, '');
  const fromAbs = join(args.hypoDir, fromNorm);
  const fromIsDir = existsSync(fromAbs) && statSync(fromAbs).isDirectory();
  if (fromIsDir) {
    // A literal `foo/` directory AND a `foo.md` page both present → ambiguous intent.
    if (existsSync(`${fromAbs}.md`)) {
      fail(
        args,
        `--from '${args.from}' is ambiguous: both a directory and a page exist. Pass a more specific path.`,
      );
    }
    return runDirectory(args, fromNorm, ignorePatterns);
  }

  const pages = collectPagesRename(args.hypoDir, args.hypoDir, ignorePatterns);
  const formIndex = buildFormIndex(pages);

  const fromPage = resolveArgToPage(args.from, pages, formIndex);
  if (!fromPage) {
    fail(args, `--from did not resolve to a unique existing page: ${args.from}`);
  }

  // Compute the destination rel. --to may be a full rel (move across dirs) or a
  // bare new name (rename in place within from-page's directory).
  const toNorm = args.to.replace(/\\/g, '/').replace(/\.md$/, '');
  const toRelRaw = toNorm.includes('/')
    ? `${toNorm}.md`
    : `${dirname(fromPage.rel)}/${toNorm}.md`.replace(/^\.\//, '');
  // Normalize away ./ and ../ segments, then require the result stays inside the
  // vault: a `--to` like `../moved` must not move a page out of the wiki, and
  // `pages/../pages/bar` must not become a non-canonical `[[pages/../pages/bar]]`
  // link target.
  const toRel = normalize(toRelRaw).replace(/\\/g, '/');
  if (toRel === '..' || toRel.startsWith('../') || isAbsolute(toRel)) {
    fail(args, `--to escapes the wiki root: ${args.to}`);
  }
  const toSlug = toRel.replace(/\.md$/, '');
  const toPath = join(args.hypoDir, toRel);

  // Real-root containment: a symlinked --to ancestor (e.g. `projects/link` →
  // /tmp/outside) is lexically in-vault, yet writeFileSync(toPath) would follow it
  // and write the moved page outside the wiki. Resolve the deepest existing prefix
  // (lstat-based, fail-closed on a dangling link) and require it to stay in-vault.
  let realRoot;
  try {
    realRoot = realpathSync(args.hypoDir);
  } catch {
    fail(args, `wiki root cannot be resolved: ${args.hypoDir}`);
  }
  if (!realContainedInVault(toPath, realRoot)) {
    fail(args, `--to '${args.to}' resolves outside the wiki root (symlink escape)`);
  }
  if (!destinationHostable(toPath)) {
    fail(args, `--to '${args.to}' has a non-directory ancestor — destination cannot be created`);
  }

  // Guard: never overwrite an existing destination (an ADR-renumber / merge would
  // land here — that is a report-only case, not a blind move).
  if (existsSync(toPath) && toRel !== fromPage.rel) {
    fail(
      args,
      `--to already exists: ${toRel}. Rename cannot overwrite a live page (renumber/merge is manual).`,
    );
  }
  if (toRel === fromPage.rel) {
    fail(args, `--from and --to resolve to the same page (${toRel}) — nothing to rename`);
  }

  const toPage = {
    rel: toRel,
    slug: toSlug,
    bare: basename(toRel, '.md'),
    path: toPath,
  };

  // Destination must be a UNIQUE link destination: existsSync(toPath) above only
  // catches a same-path clobber, not a cross-directory basename collision
  // (pages/bar.md vs projects/bar.md). If the new bare or dir-relative form
  // already resolves to a DIFFERENT existing page, the rewritten `[[new]]` links
  // would be ambiguous — the same contract that bars rewriting an ambiguous
  // source link. Refuse rather than emit ambiguous links.
  for (const form of [toPage.bare, dirRelForm(toPage.slug)]) {
    if (!form) continue;
    const owners = formIndex.get(form);
    if (owners && [...owners].some((rel) => rel !== fromPage.rel)) {
      fail(
        args,
        `--to '${args.to}' collides with an existing page on form '${form}' — rewritten links would be ambiguous. Pick a unique name.`,
      );
    }
  }

  // Rewrite inbound references across every NON-preserved page (skip the moved
  // page itself — self-references are rewritten on its own content separately).
  const fileResults = [];
  let totalRewrites = 0;
  const ambiguities = [];
  for (const p of pages) {
    if (isPreservedSource(p.rel)) continue;
    let raw;
    try {
      raw = readFileSync(p.path, 'utf-8');
    } catch {
      continue;
    }
    const { content, rewrites, ambiguous } = rewriteContent(raw, fromPage, toPage, formIndex);
    if (rewrites.length > 0) {
      fileResults.push({ file: p.rel, rewrites });
      totalRewrites += rewrites.length;
      if (args.apply && content !== raw) {
        // The from-page is about to move; write its rewritten body to the NEW
        // path below, not the old one.
        if (p.rel === fromPage.rel) {
          fromPage._rewritten = content;
        } else {
          writeFileSync(p.path, content);
        }
      } else if (p.rel === fromPage.rel) {
        fromPage._rewritten = content;
      }
    }
    if (ambiguous.length > 0) {
      ambiguities.push({ file: p.rel, ambiguous });
    }
  }

  // Move the file (--apply only): write the (possibly self-rewritten) body at the
  // new path, then drop the old one. Done as write-then-remove rather than a raw
  // rename so the carried-over self-reference rewrites are preserved.
  let moved = false;
  if (args.apply) {
    mkdirSync(dirname(toPath), { recursive: true });
    const body = fromPage._rewritten ?? readFileSync(fromPage.path, 'utf-8');
    writeFileSync(toPath, body);
    if (toPath !== fromPage.path) rmSync(fromPage.path, { force: true });
    moved = true;
  }

  const result = {
    ok: true,
    applied: args.apply,
    from: fromPage.rel,
    to: toRel,
    moved,
    files_rewritten: fileResults.length,
    links_rewritten: totalRewrites,
    rewrites: fileResults,
    ambiguous: ambiguities,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mode = args.apply ? 'Renamed' : 'Dry-run (no changes written)';
    console.log(`${mode}: ${fromPage.rel} → ${toRel}`);
    console.log(`  ${totalRewrites} inbound link(s) across ${fileResults.length} file(s).`);
    for (const f of fileResults) {
      console.log(`  · ${f.file}: ${f.rewrites.map((r) => `${r.from}→${r.to}`).join(', ')}`);
    }
    if (ambiguities.length > 0) {
      console.log('\n  ⚠ ambiguous links NOT rewritten (bare slug shared by >1 page):');
      for (const a of ambiguities) {
        for (const x of a.ambiguous) console.log(`    · ${a.file}:${x.line} ${x.link}`);
      }
      console.log('    Resolve these manually (use a dir-relative or full-slug form).');
    }
    if (!args.apply) console.log('\n  Re-run with --apply to write the move + rewrites.');
  }
  process.exit(0);
}

run(parseArgs(process.argv));
