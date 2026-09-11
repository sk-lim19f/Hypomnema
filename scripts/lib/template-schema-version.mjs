import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseFrontmatter } from './frontmatter.mjs';

// The SCHEMA version this package ships, read from templates/SCHEMA.md
// frontmatter. init.mjs / upgrade.mjs stamp it into hypo-pkg.json metadata;
// deriving it here (rather than hardcoding a literal at each write site) keeps
// the stamped value from going stale on a schema bump — the failure mode that
// the 2.0 → 2.1 schema bump would otherwise have introduced. Returns null only if
// the template is missing/unreadable (a broken package), in which case callers
// keep their prior literal default.
export function templateSchemaVersion(pkgRoot) {
  const p = join(pkgRoot, 'templates', 'SCHEMA.md');
  if (!existsSync(p)) return null;
  try {
    const v = (parseFrontmatter(readFileSync(p, 'utf-8')) || {}).version;
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

// One line per SCHEMA.md version bump, naming what that version added over the
// one before it. This is upgrade.mjs's only source for "what changed" text
// when it tells a user their installed SCHEMA.md is behind — without it, the
// notice can only name the two version numbers, and the two SCHEMA.md copies
// diverge (translation, local additions) far enough that a raw diff is
// dominated by noise unrelated to the actual upstream change. Add an entry
// here whenever templates/SCHEMA.md's `version:` frontmatter bumps; a version
// missing from this map falls back to the plain "review manually" notice
// (schemaVersionDeltas below returns nothing for it), so leaving one out is
// silent, not wrong.
// Quote any key with a trailing zero. An unquoted `2.10:` is a NUMBER literal
// and JS normalizes it to the string "2.1", so it would silently overwrite
// 2.1's line (or hand 2.10's text to somebody upgrading across 2.1). Verified:
// `Object.keys({2.10: 'x'})` is `['2.1']`. Prettier will not undo the quotes
// there — stripping them would change meaning, so it leaves "2.10" alone even
// though it rewrites '2.2' to 2.2. What prettier cannot save you from is
// writing 2.10 unquoted in the first place, which is why a test reads this
// file's text and rejects that shape rather than trusting the convention.
export const SCHEMA_VERSION_DELTAS = {
  2.2: 'documents `sources_consulted` on `type: synthesis` pages (lint W15/W16 read it to flag a synthesis that has fallen behind the pages it condenses)',
};

function parseMinorVersion(v) {
  const [major, minor] = String(v).split('.').map(Number);
  return { major, minor: Number.isFinite(minor) ? minor : 0 };
}

function compareMinorVersions(a, b) {
  return a.major - b.major || a.minor - b.minor;
}

// Returns one line per version strictly after `installed` and up to and
// including `current`, oldest first. `deltas` defaults to the real map above;
// tests pass their own to exercise the multi-version stepping logic without
// depending on how many real bumps have landed.
export function schemaVersionDeltas(installed, current, deltas = SCHEMA_VERSION_DELTAS) {
  if (!installed || !current) return [];
  const from = parseMinorVersion(installed);
  const to = parseMinorVersion(current);
  if (compareMinorVersions(to, from) <= 0) return [];
  return Object.keys(deltas)
    .map((v) => ({ v, mv: parseMinorVersion(v) }))
    .filter(({ mv }) => compareMinorVersions(mv, from) > 0 && compareMinorVersions(mv, to) <= 0)
    .sort((a, b) => compareMinorVersions(a.mv, b.mv))
    .map(({ v }) => `${v}: ${deltas[v]}`);
}
