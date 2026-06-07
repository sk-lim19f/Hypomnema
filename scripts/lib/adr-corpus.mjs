/**
 * adr-corpus — fs-backed production-code corpus search for the ADR-line grep.
 *
 * Kept separate from the pure verifier (scripts/lib/fix-status-verify.mjs) so
 * that layer stays IO-free and unit-testable with injected searchFns. This
 * module is itself testable against real temp directories.
 *
 * CRITICAL (self-match): the manifest module (scripts/lib/fix-manifest.mjs)
 * lives *inside* the scripts/ corpus and holds every adrKeyLine as a literal.
 * If it were scanned, every line would self-match and ADR_LINE_MISSING could
 * never fire — the gate would be silently vacuous. The builder therefore
 * excludes caller-supplied paths, resolved absolute, BEFORE reading any file.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_EXTENSIONS = ['.mjs', '.js', '.md', '.json', '.cjs'];

function* walk(dir, excludeAbs, extensions) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing corpus dir is not fatal — other dirs may exist
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (excludeAbs.has(resolve(full))) continue;
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      yield* walk(full, excludeAbs, extensions);
    } else if (ent.isFile()) {
      if (extensions.some((e) => ent.name.endsWith(e))) yield full;
    }
  }
}

/**
 * Build a fixed-string corpus search function.
 *
 *   buildCorpusSearch({ repoRoot, includeDirs, excludePaths, extensions })
 *     → (literal:string) => boolean
 *
 * - includeDirs / excludePaths are resolved relative to repoRoot.
 * - excludePaths are matched by resolved absolute path (handles symlinks of the
 *   caller-supplied path consistently with the walk's resolve()).
 * - search is case-sensitive String.includes (fixed string, not regex).
 *
 * Files are read once and cached so repeated searches (one per manifest row)
 * do not re-walk the tree.
 */
export function buildCorpusSearch({
  repoRoot,
  includeDirs,
  excludePaths = [],
  extensions = DEFAULT_EXTENSIONS,
}) {
  const excludeAbs = new Set(excludePaths.map((p) => resolve(repoRoot, p)));
  const contents = [];
  for (const dir of includeDirs) {
    const abs = resolve(repoRoot, dir);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    for (const file of walk(abs, excludeAbs, extensions)) {
      try {
        contents.push(readFileSync(file, 'utf-8'));
      } catch {
        /* unreadable file — skip */
      }
    }
  }
  return (literal) => contents.some((text) => text.includes(literal));
}
