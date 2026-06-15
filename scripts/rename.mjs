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
  statSync,
} from 'fs';
import { join, relative, extname, basename, dirname, normalize, isAbsolute } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';

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

// ── page collection (mirrors graph.mjs / crystallize.mjs collectPages) ──────────

function collectPages(dir, root, pages = [], ignorePatterns = []) {
  if (!existsSync(dir)) return pages;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      collectPages(full, root, pages, ignorePatterns);
    } else if (extname(entry) === '.md' && !entry.startsWith('.')) {
      const rel = relative(root, full).replace(/\\/g, '/');
      pages.push({ path: full, rel, slug: rel.replace(/\.md$/, ''), bare: basename(full, '.md') });
    }
  }
  return pages;
}

// ── preserved (append-only / immutable) link-source paths ──────────────────────
// These are skipped as link SOURCES: their content is a frozen record. Rewriting
// a [[old]] reference inside a past journal/session-log/weekly/archive/postmortem
// snapshot (or root log.md) would falsify that moment. sources/* is immutable
// captured material. decisions/ and other-project handoffs are NOT preserved here
// (they were kept in the read-side triage for renumber/ownership reasons, not
// because they are time records — a forward rename should update their live
// cross-references). Matches a path SEGMENT so `pages/journal/x.md` and
// `projects/p/session-log/2026-06.md` both qualify.
function isPreservedSource(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p === 'log.md') return true; // root append-only log
  return /(^|\/)(journal|session-log|weekly|archive|postmortems|sources)(\/|$)/.test(p);
}

// ── slug-form index (resolution with collision detection) ──────────────────────
// Unlike lint's buildSlugMap (a Set that silently dedups collisions), rename
// needs to KNOW when a form is shared, so it maps each form → the set of page
// rels that expose it. precedence forms per page: full noExt slug, bare
// basename, dir-relative (drop the leading scan-dir segment).
function dirRelForm(slug) {
  const slash = slug.indexOf('/');
  return slash === -1 ? null : slug.slice(slash + 1);
}

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

// ── main ────────────────────────────────────────────────────────────────────

function run(args) {
  if (!args.from || !args.to) {
    fail(args, '--from=<slug|rel> and --to=<slug|rel> are required');
  }
  const ignorePatterns = loadHypoIgnore(args.hypoDir);
  const pages = collectPages(args.hypoDir, args.hypoDir, [], ignorePatterns);
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
