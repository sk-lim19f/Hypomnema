import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DAY_MS, parseStrictDate } from './time.mjs';

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

// Two separate date validators, one per side of the comparison, because a
// filter that is too eager to REJECT does opposite things to the two sides:
// dropping a design-history heading only removes a candidate for lastDH
// (pushes the verdict toward MORE staleness, safe), but dropping a
// session-log heading can empty sessionDates entirely and erase the finding
// altogether (an actually-stale or actually-missing project reads as clean).
// Both filters stay conservative in the direction that never hides a real
// gap: reject on the design-history side, accept on the session-log side.

// design-history heading dates: strict. `new Date('2026-13-01')` is an
// Invalid Date (would crash `toISOString()` with RangeError and poison `>`
// comparisons inside maxDate), but `new Date('2026-02-30')` silently
// normalizes to March 2 instead of failing, so a plain Invalid-Date check let
// a calendar-overflow heading through looking like a real, later date and
// made a stale design-history read as caught up. parseStrictDate (lib/time.mjs)
// rejects both classes by round-tripping year/month/day through a UTC Date and
// checking they come back unchanged.
function isValidDesignHistoryDate(literal) {
  return parseStrictDate(literal) != null;
}

// session-log heading dates: the pre-strict-parser check, kept on purpose.
// Tightening this side to parseStrictDate looked like the same fix, but a
// project whose only design-relevant entry carries a calendar-overflow
// heading (`## [2026-02-30]`) would then filter out of sessionDates
// entirely, and with it BOTH the W8 stale verdict and the W14 missing
// verdict that depend on sessionDates being non-empty (reviewer repro: a
// project stale at base with lastSession 2026-03-02 > design-history
// 2026-02-20 produced no finding at all once this side went strict). This
// side accepts anything `new Date` can parse at all, so it still errs toward
// reporting rather than toward silence.
function isValidSessionLogDate(literal) {
  return !Number.isNaN(new Date(literal).getTime());
}

function parseDates(text, pattern) {
  const dates = [];
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    if (isValidDesignHistoryDate(m[1])) dates.push(new Date(m[1]));
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
    if (isValidSessionLogDate(headings[i].literal)) dates.push(new Date(headings[i].literal));
  }
  return dates;
}

function maxDate(dates) {
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

// Returns findings: { project, kind, lastSession, lastDesignHistory, diffDays }.
// `kind` is 'stale' (the file exists but session-log has moved past it) or
// 'missing' (the file does not exist at all, yet session-log carries at least
// one design-relevant entry). Date source is body section headings
// (## YYYY-MM-DD), not frontmatter `updated:` — auto-stage hooks bump the
// frontmatter on unrelated edits, so it can't signal staleness on its own.
export function findDesignHistoryStale(hypoDir) {
  const stale = [];

  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return stale;

  for (const name of readdirSync(projectsDir)) {
    if (name.startsWith('_')) continue; // e.g. templates/projects/_template — not a real project
    const projectDir = join(projectsDir, name);
    if (!statSync(projectDir).isDirectory()) continue;

    const dhPath = join(projectDir, 'design-history.md');

    // session-log can live as a flat `session-log.md` (legacy) or a directory of
    // daily shards `session-log/YYYY-MM-DD.md` (canonical; legacy
    // monthly `YYYY-MM.md` files still appear pre-cutover). This globs every
    // `.md` in the directory, so daily and monthly shapes are both aggregated —
    // the staleness check needs to see all of them. Gathered before the
    // existsSync(dhPath) branch below, since a project with zero design-history
    // file still needs this to decide whether it has a design-relevant entry.
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

    if (!existsSync(dhPath)) {
      // The file was never created, so there is nothing to compare dates
      // against — but parseSessionDates already excluded pure "ADR 없음"
      // entries, so a non-empty sessionDates here means at least one entry
      // recorded (or implied) a design change with nowhere to land. This is a
      // bootstrap gap, not a staleness gap: `lastDesignHistory`/`diffDays` stay
      // null and callers must key off `kind` to avoid conflating the two.
      stale.push({
        project: name,
        kind: 'missing',
        lastSession: maxDate(sessionDates).toISOString().slice(0, 10),
        lastDesignHistory: null,
        diffDays: null,
      });
      continue;
    }

    const dhText = readFileSync(dhPath, 'utf-8');
    const lastSession = maxDate(sessionDates);
    const lastDH = maxDate(parseDates(dhText, DESIGN_HISTORY_DATE_RE));

    if (!lastDH || lastSession > lastDH) {
      const diffDays = lastDH ? Math.round((lastSession - lastDH) / DAY_MS) : null;
      stale.push({
        project: name,
        kind: 'stale',
        lastSession: lastSession.toISOString().slice(0, 10),
        lastDesignHistory: lastDH ? lastDH.toISOString().slice(0, 10) : '(없음)',
        diffDays,
      });
    }
  }

  return stale;
}
