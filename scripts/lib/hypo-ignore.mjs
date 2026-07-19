import { existsSync, readFileSync } from 'fs';
import { join, relative, basename, resolve } from 'path';

export function loadHypoIgnore(hypoDir) {
  const ignorePath = join(hypoDir, '.hypoignore');
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// .hyposcanignore: scan-only exclusions (lint/graph/stats/query/verify/doctor
// catalog scans). Deliberately NOT a privacy boundary: a match here is still
// committed and still readable by hooks. Only isScanIgnored() below reads this
// file. loadHypoIgnore()/isIgnored() must never see it, that is the whole
// point of the split, so do not thread it into the pre-commit gate or
// ingest --check.
export function loadScanIgnore(hypoDir) {
  const ignorePath = join(resolve(hypoDir), '.hyposcanignore');
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Parsed .hyposcanignore patterns, cached per vault for the process lifetime.
// The shared walker (wikilink.mjs) calls isScanIgnored() once per directory
// entry, so re-reading this file on every call would turn a vault scan into
// O(files) filesystem reads for one small file. Nothing writes
// .hyposcanignore mid-process, so a stale cache is not a real scenario.
//
// Keyed on path.resolve(hypoDir), NOT the raw argument: a raw-string key lets
// two different relative spellings of the SAME vault ('.', './') miss each
// other (harmless, just a wasted read), but it also lets a relative key like
// '.' collide ACROSS vaults when the caller cd's between them between calls —
// vault B would silently reuse vault A's scan patterns. Resolving to an
// absolute path first makes the key vault-identity-stable regardless of cwd
// or spelling.
const scanIgnoreCache = new Map();

function cachedScanIgnore(hypoDir) {
  const key = resolve(hypoDir);
  let patterns = scanIgnoreCache.get(key);
  if (patterns === undefined) {
    patterns = loadScanIgnore(key);
    scanIgnoreCache.set(key, patterns);
  }
  return patterns;
}

function globToRegex(glob) {
  return new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\x00') // placeholder before single-* replacement
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\x00/g, '.*') + // restore ** → .*
      '$',
  );
}

// Generated, regenerable tool artifacts that live at the WIKI ROOT and must not
// pollute the knowledge catalog. These are intentionally NOT added to
// .hypoignore: that list also drives the pre-commit secret gate
// (hooks/hypo-pre-commit.mjs), so listing them there would block the report's
// commit and freeze every auto-commit while it sits at root. Instead they are
// excluded from catalog/scan only, via isScanIgnored(). The patterns are
// anchored to the root-relative path (no '/'), so an equivalent name nested
// under pages/, projects/, or sources/ is left untouched.
const GENERATED_ARTIFACT_RES = [/^MIGRATION-v[^/]*\.md$/, /^GRAPH_REPORT\.md$/];

export function isGeneratedArtifact(filePath, hypoDir) {
  const rel = relative(hypoDir, filePath).replace(/\\/g, '/');
  return GENERATED_ARTIFACT_RES.some((re) => re.test(rel));
}

// Catalog/scan exclusion = privacy/.hypoignore patterns PLUS generated root
// artifacts PLUS scan-only/.hyposcanignore patterns (loaded and cached
// internally, so callers keep passing only their privacy `patterns` array).
// Use this in tools that build the knowledge catalog (lint, graph, stats,
// query, verify, crystallize, rename, doctor broken-links). Do NOT use it in
// the pre-commit gate or ingest --check, which are privacy boundaries that
// must stay on isIgnored()/.hypoignore alone — OR-ing in .hyposcanignore here
// only ever WIDENS what a scan skips, it can never make an .hypoignore match
// committable, so that separation holds by construction.
export function isScanIgnored(filePath, hypoDir, patterns) {
  return (
    isIgnored(filePath, hypoDir, patterns) ||
    isGeneratedArtifact(filePath, hypoDir) ||
    isIgnored(filePath, hypoDir, cachedScanIgnore(hypoDir))
  );
}

export function isIgnored(filePath, hypoDir, patterns) {
  const rel = relative(hypoDir, filePath).replace(/\\/g, '/');
  const base = basename(filePath);

  for (const pattern of patterns) {
    const isDir = pattern.endsWith('/');
    if (isDir) {
      const dir = pattern.slice(0, -1);
      const isAnchored = dir.includes('/');
      if (isAnchored) {
        // e.g. pages/journal/ — anchored to wiki root, match prefix
        const re = globToRegex(dir);
        const parts = rel.split('/');
        for (let i = dir.split('/').length; i <= parts.length; i++) {
          if (re.test(parts.slice(0, i).join('/'))) return true;
        }
      } else {
        // e.g. node_modules/ — unanchored, match any single component
        const re = globToRegex(dir);
        for (const part of rel.split('/')) {
          if (re.test(part)) return true;
        }
      }
      continue;
    }
    const hasSlash = pattern.includes('/');
    const target = hasSlash ? rel : base;
    if (globToRegex(pattern).test(target)) return true;
  }
  return false;
}
