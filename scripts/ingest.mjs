#!/usr/bin/env node
/**
 * Hypomnema ingest *listing* helper
 *
 * This script does NOT synthesize wiki pages — that step is LLM-driven by
 * `/hypo:ingest` inside Claude Code. The CLI helper only inspects the wiki
 * filesystem and reports:
 *   - files under `sources/` that have no matching `source-summary` page
 *   - pages whose `source:` frontmatter points at a missing `sources/` file
 *
 * Calling it from the shell will never modify the wiki; it is read-only.
 *
 * Usage:
 *   node scripts/ingest.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --json              Output as JSON
 *   --check=<path>      Privacy guard: exit 1 if <path> matches a `.hypoignore`
 *                       pattern, exit 0 silently otherwise. Used by `/hypo:ingest`
 *                       to refuse ingesting secrets before they reach `sources/`.
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { join, extname, basename, isAbsolute } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false, check: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--check=')) args.check = expandHome(arg.slice(8));
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// Find the first `.hypoignore` pattern that matches `target`, or null.
// `target` is resolved relative to `hypoDir` when not already absolute, so
// both wiki-relative destinations (`sources/<slug>.md`) and user-supplied
// input paths land inside the wiki tree for anchored-pattern matching.
//
// A symlink with an innocuous name (`note.md` → `.env`) must still be
// refused, so an existing target is also checked by its realpath. realpath
// throws ENOENT for a not-yet-created destination — fall back to the lexical
// path in that case. Both the lexical and resolved paths are tested, for
// defense-in-depth when only one of them matches a pattern.
function matchingIgnorePattern(target, hypoDir, patterns) {
  const lexical = isAbsolute(target) ? target : join(hypoDir, target);
  let resolved = lexical;
  try {
    resolved = realpathSync(lexical);
  } catch {
    /* not on disk — lexical only */
  }
  const candidates = resolved === lexical ? [lexical] : [lexical, resolved];
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      if (isIgnored(candidate, hypoDir, [pattern])) return pattern;
    }
  }
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectMdFiles(dir, acc = [], hypoDir = '', ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (hypoDir && isIgnored(full, hypoDir, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectMdFiles(full, acc, hypoDir, ignorePatterns);
    else if (extname(entry) === '.md') acc.push(full);
  }
  return acc;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return fm;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const ignorePatterns = loadHypoIgnore(args.hypoDir);

// ── --check guard ────────────────────────────────────────────────────────────
// Privacy boundary (spec §6.8 / §8.10): refuse to ingest a path that matches
// `.hypoignore` before it ever reaches `sources/`. Separate from the
// listing-mode filter below — this is the explicit-reject path.
if (args.check) {
  const matched = matchingIgnorePattern(args.check, args.hypoDir, ignorePatterns);
  if (matched) {
    console.error(
      `Refused: '${args.check}' matches .hypoignore pattern '${matched}' — not ingesting.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const sourcesDir = join(args.hypoDir, 'sources');
const allSources = existsSync(sourcesDir)
  ? readdirSync(sourcesDir).filter(
      (e) =>
        !e.startsWith('.') &&
        !statSync(join(sourcesDir, e)).isDirectory() &&
        !isIgnored(join(sourcesDir, e), args.hypoDir, ignorePatterns),
    )
  : [];

// collect all source: references in wiki pages
const pageFiles = collectMdFiles(join(args.hypoDir, 'pages'), [], args.hypoDir, ignorePatterns);
const referencedSources = new Set();

for (const f of pageFiles) {
  let content;
  try {
    content = readFileSync(f, 'utf-8');
  } catch {
    continue;
  }
  const fm = parseFrontmatter(content);
  if (fm.source && !fm.source.startsWith('session:')) {
    referencedSources.add(fm.source);
  }
}

// sources with no summary page
const orphaned = allSources.filter((s) => {
  const slug = basename(s, extname(s));
  return !referencedSources.has(s) && !referencedSources.has(slug);
});

// pages referencing sources that don't exist on disk
const missingSource = [];
for (const f of pageFiles) {
  let content;
  try {
    content = readFileSync(f, 'utf-8');
  } catch {
    continue;
  }
  const fm = parseFrontmatter(content);
  if (!fm.source || fm.source.startsWith('session:')) continue;
  const sourceFile = join(sourcesDir, fm.source);
  const sourceFileWithExt = allSources.find(
    (s) => s === fm.source || basename(s, extname(s)) === fm.source,
  );
  if (!sourceFileWithExt && !existsSync(sourceFile)) {
    missingSource.push({ page: f, source: fm.source });
  }
}

if (args.json) {
  console.log(
    JSON.stringify(
      {
        totalSources: allSources.length,
        orphaned,
        missingSource,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    '[hypomnema] Listing pending ingest targets — synthesis is performed by /hypo:ingest inside Claude Code.',
  );
  console.log(`Sources: ${allSources.length} total`);

  if (orphaned.length === 0) {
    console.log('✓ All sources have a corresponding source-summary page');
  } else {
    console.log(`\n⊘ ${orphaned.length} source(s) not yet ingested:`);
    for (const s of orphaned) console.log(`  sources/${s}`);
  }

  if (missingSource.length > 0) {
    console.log(`\n⚠ ${missingSource.length} page(s) reference a missing source file:`);
    for (const { page, source } of missingSource) {
      console.log(`  ${page}  →  source: ${source}`);
    }
  }

  if (orphaned.length > 0) {
    console.log('\nRun /hypo:ingest to synthesize the listed sources into wiki pages.');
  }
}
