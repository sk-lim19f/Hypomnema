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
