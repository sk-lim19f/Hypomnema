import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// session-log headings appear in two shapes in the wild: bracketed
// `## [YYYY-MM-DD]` (spec convention) and bare `## YYYY-MM-DD` (some entries,
// e.g. the 2026-06-08 SHIP entry). Two explicit branches instead of an
// `\[?...\]?` optional — the optional form silently accepts malformed partial
// brackets like `## [2026-06-08` and `## 2026-06-08]`, which we don't want to
// treat as valid dated headings. The bare branch carries a `(?!\])` guard so a
// trailing-only bracket (`## 2026-06-08]`) is rejected too — without it the
// bare branch would match the date and ignore the stray `]` (codex review).
const SESSION_LOG_HEADING_RE = /^## (?:\[(\d{4}-\d{2}-\d{2})\]|(\d{4}-\d{2}-\d{2})(?!\]))/gm;
const DESIGN_HISTORY_DATE_RE = /^## (\d{4}-\d{2}-\d{2})/gm;

// W8 false-positive fix (issue①): a session-log entry that explicitly declares
// "no design change" (the crystallize #41 `ADR 없음` marker) must not count
// toward design-history staleness — otherwise a no-design session pushes the
// session-log date past design-history forever (treadmill), or a real design
// session that forgot to append blocks correctly. We exclude an entry ONLY when
// it carries the `ADR 없음` marker AND no ADR reference in the same block. If
// both coexist (an ambiguous/contradictory entry), we include it — excluding it
// would re-introduce the exact false-negative W8 exists to catch (codex review).
const NO_ADR_MARKER_RE = /ADR\s*없음/;
const ADR_REF_RE = /ADR\s+\d{4}|decisions\/\d{4}/;

function isValidDate(literal) {
  // The regex matches digit-shaped YYYY-MM-DD literals but cannot reject
  // semantically invalid ones like 2026-13-01 or 2026-02-30. JavaScript's Date
  // constructor returns an Invalid Date for those, which would later crash
  // `toISOString()` with RangeError and poison `>` comparisons inside maxDate.
  // Filter at the parse boundary so callers never see one.
  return !Number.isNaN(new Date(literal).getTime());
}

function parseDates(text, pattern) {
  const dates = [];
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (isValidDate(m[1])) dates.push(new Date(m[1]));
  }
  return dates;
}

// Parse session-log dates entry-by-entry, skipping no-design-change entries.
// Entries are sliced by heading start-index (not a single `$`-anchored block
// regex — multiline `$` terminates at line ends, not true EOF, so the last
// entry would be truncated). The last entry runs to EOF.
function parseSessionDates(text) {
  const headings = [];
  SESSION_LOG_HEADING_RE.lastIndex = 0;
  let m;
  while ((m = SESSION_LOG_HEADING_RE.exec(text)) !== null) {
    headings.push({ literal: m[1] ?? m[2], start: m.index });
  }
  const dates = [];
  for (let i = 0; i < headings.length; i++) {
    const body = text.slice(headings[i].start, headings[i + 1]?.start ?? text.length);
    // Exclude only an explicit no-design-change entry. An entry carrying both
    // the marker and an ADR reference is treated as a design entry (included).
    if (NO_ADR_MARKER_RE.test(body) && !ADR_REF_RE.test(body)) continue;
    if (isValidDate(headings[i].literal)) dates.push(new Date(headings[i].literal));
  }
  return dates;
}

function maxDate(dates) {
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

// Returns stale findings: { project, lastSession, lastDesignHistory, diffDays }
// Only includes projects where design-history.md exists AND is stale relative
// to the latest session-log entry. Date source is body section headings
// (## YYYY-MM-DD), not frontmatter `updated:` — auto-stage hooks bump the
// frontmatter on unrelated edits, so it can't signal staleness on its own.
export function findDesignHistoryStale(hypoDir) {
  const stale = [];

  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return stale;

  for (const name of readdirSync(projectsDir)) {
    const projectDir = join(projectsDir, name);
    if (!statSync(projectDir).isDirectory()) continue;

    const dhPath = join(projectDir, 'design-history.md');
    if (!existsSync(dhPath)) continue;

    // session-log can live as a flat `session-log.md` (legacy) or a directory
    // `session-log/YYYY-MM.md` (spec §5.2.7 canonical). Aggregate dates from
    // whichever shape is present — both forms appear in the wild and the
    // staleness check needs to see all of them.
    const sessionDates = [];
    const flatSlPath = join(projectDir, 'session-log.md');
    if (existsSync(flatSlPath)) {
      sessionDates.push(...parseSessionDates(readFileSync(flatSlPath, 'utf-8')));
    }
    const dirSlPath = join(projectDir, 'session-log');
    if (existsSync(dirSlPath) && statSync(dirSlPath).isDirectory()) {
      for (const entry of readdirSync(dirSlPath)) {
        if (!entry.endsWith('.md')) continue;
        const text = readFileSync(join(dirSlPath, entry), 'utf-8');
        sessionDates.push(...parseSessionDates(text));
      }
    }
    if (sessionDates.length === 0) continue;

    const dhText = readFileSync(dhPath, 'utf-8');
    const lastSession = maxDate(sessionDates);
    const lastDH = maxDate(parseDates(dhText, DESIGN_HISTORY_DATE_RE));

    if (!lastSession) continue;

    if (!lastDH || lastSession > lastDH) {
      const diffDays = lastDH ? Math.round((lastSession - lastDH) / (1000 * 60 * 60 * 24)) : null;
      stale.push({
        project: name,
        lastSession: lastSession.toISOString().slice(0, 10),
        lastDesignHistory: lastDH ? lastDH.toISOString().slice(0, 10) : '(없음)',
        diffDays,
      });
    }
  }

  return stale;
}
