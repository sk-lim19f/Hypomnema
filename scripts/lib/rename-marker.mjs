// scripts/lib/rename-marker.mjs
//
// The crash-recovery marker for rename.mjs --apply. Shared read-only path/parse
// logic between the writer (rename.mjs) and the reader (doctor.mjs) so the two
// never drift on where the marker lives or what shape it is in.
//
// Kept under .cache/ deliberately, matching every other runtime marker this repo
// already writes there (sync-state.json, session-closed-*.marker, proposals/,
// project-suggestions.json). Two things fall out of that placement for free:
//   - it is JSON, not .md, so every vault walker (scripts/lib/wikilink.mjs) that
//     only ever collects .md files simply never sees it — no lint/rename/graph
//     scan needs to know this file exists.
//   - .cache/ ships in templates/.hypoignore's default pattern list, so a scan
//     that DOES walk directories rather than just filtering by extension
//     (doctor's own checkBrokenLinks walker) is also covered on any vault that
//     carries that baseline — which every vault already needs, since .cache/
//     holds the pre-commit secret-gate's own state.
// No .hyposcanignore entry or scan-logic change was needed to get this property;
// it comes from where the file lives, not from a new exclusion rule.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const RENAME_MARKER_REL = '.cache/rename-in-progress.json';

export function renameMarkerPath(hypoDir) {
  return join(hypoDir, RENAME_MARKER_REL);
}

// Best-effort read: a missing or corrupt marker both mean "nothing to report" —
// this runs inside doctor's health scan and must never throw.
export function readRenameMarker(hypoDir) {
  const path = renameMarkerPath(hypoDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}
