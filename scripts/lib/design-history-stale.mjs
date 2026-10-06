import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DAY_MS, parseStrictDate } from './time.mjs';
import { maskNonProse } from './code-fence.mjs';

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

// design-history heading dates: a calendar-overflow literal (`2026-02-30`,
// month 13) is dropped. `new Date('2026-02-30')` silently normalizes to March
// 2 instead of failing, so a plain Invalid-Date check let it through looking
// like a real, later date and made a stale design-history read as caught up.
// Dropping only removes a candidate for lastDH (pushes the verdict toward MORE
// staleness, safe). parseStrictDate (lib/time.mjs) round-trips year/month/day
// through a UTC Date to catch both classes.
//
// The session-log side must NOT drop such a literal: a project whose only
// design-relevant entry carries one would then have an empty sessionDates, and
// BOTH the W8 stale verdict and the W14 missing verdict would vanish. It must
// not normalize it either, which would invent a day difference. So
// parseSessionDates keeps it apart, as a literal, in `overflow`: the verdict
// is still reported, and no diffDays is derived from it.
function isValidDesignHistoryDate(literal) {
  return parseStrictDate(literal) != null;
}

function parseDates(text, pattern) {
  const dates = [];
  // A fenced or commented `## 2026-12-31` is example text, not a design-history
  // entry; counting it would push lastDH forward and silence W8.
  const live = maskNonProse(text);
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(live)) !== null) {
    if (isValidDesignHistoryDate(m[1])) dates.push(new Date(m[1]));
  }
  return dates;
}

// Parse session-log dates entry-by-entry, skipping no-design-change entries.
// Entries are sliced by heading start-index (not a single `$`-anchored block
// regex — multiline `$` terminates at line ends, not true EOF, so the last
// entry would be truncated). The last entry runs to EOF.
// Returns { dates, overflow }: real dates as Date (no-design entries left out),
// and every calendar-overflow literal in source order as { literal, excluded }.
// An `excluded` literal sits in an `ADR 없음` entry: it cannot make W8 or W14,
// but it is still a heading typo, so W19 reports it.
function parseSessionDates(text) {
  const headings = [];
  // Length-preserving copy with fenced code and HTML comments blanked. A heading
  // in it is a real entry start; a heading in a fence is example text. The
  // marker test below reads this copy too, so a fenced example's `ADR 없음`
  // cannot exclude the real entry around it. Blocking W8 depends on that.
  const live = maskNonProse(text);
  SESSION_LOG_HEADING_RE.lastIndex = 0;
  let m;
  while ((m = SESSION_LOG_HEADING_RE.exec(live)) !== null) {
    headings.push({ literal: m[1] ?? m[2], start: m.index });
  }
  const dates = [];
  const overflow = [];
  for (let i = 0; i < headings.length; i++) {
    const end = headings[i + 1]?.start ?? text.length;
    // Exclude only an explicit no-design-change entry. An entry carrying both
    // the marker and an ADR reference is treated as a design entry (included).
    // The marker is read from the live copy, the ADR reference from the raw
    // text: a fenced ADR reference keeps the entry included (the safe side).
    const excluded =
      NO_ADR_MARKER_RE.test(live.slice(headings[i].start, end)) &&
      !ADR_REF_RE.test(text.slice(headings[i].start, end));
    const { literal } = headings[i];
    if (parseStrictDate(literal) != null) {
      if (!excluded) dates.push(new Date(literal));
    } else overflow.push({ literal, excluded });
  }
  return { dates, overflow };
}

function isoDay(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

function maxDate(dates) {
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (a > b ? a : b));
}

// Returns findings:
// { project, kind, lastSession, lastDesignHistory, diffDays, calendarOverflow,
//   realLater }. `kind` 'overflow' carries no W8/W14 verdict: the only finding
// is a calendar-overflow heading, which lint reports as W19 alone. `realLater` (kind 'stale' only) is true when a REAL date, not
// an overflow literal, makes the project stale; false means the overflow
// literals alone raised the finding.
// `calendarOverflow` lists session-log headings, as { literal, file } with file
// vault-relative, whose literal names a day that
// does not exist, `ADR 없음` entries included. Any such literal makes a finding
// (it cannot be compared, so it is never read as caught up). `lastSession` is the latest REAL date, null
// when every heading overflowed, and `diffDays` is null unless that real date
// is itself later than design-history.
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
    const calendarOverflow = [];
    let verdictOverflow = 0; // overflow headings in entries that count toward W8/W14
    const addSession = (text, file) => {
      const r = parseSessionDates(text);
      sessionDates.push(...r.dates);
      for (const { literal, excluded } of r.overflow) {
        calendarOverflow.push({ literal, file });
        if (!excluded) verdictOverflow++;
      }
    };
    const flatSlPath = join(projectDir, 'session-log.md');
    if (existsSync(flatSlPath)) {
      addSession(readFileSync(flatSlPath, 'utf-8'), `projects/${name}/session-log.md`);
    }
    const dirSlPath = join(projectDir, 'session-log');
    if (existsSync(dirSlPath) && statSync(dirSlPath).isDirectory()) {
      for (const entry of readdirSync(dirSlPath)) {
        if (!entry.endsWith('.md')) continue;
        addSession(
          readFileSync(join(dirSlPath, entry), 'utf-8'),
          `projects/${name}/session-log/${entry}`,
        );
      }
    }
    if (calendarOverflow.length === 0 && sessionDates.length === 0) continue;

    // Only `ADR 없음` entries are left: W8 and W14 have nothing to say, but a
    // calendar-overflow heading among them is still a typo W19 must show.
    if (sessionDates.length === 0 && verdictOverflow === 0) {
      stale.push({
        project: name,
        kind: 'overflow',
        lastSession: null,
        lastDesignHistory: null,
        diffDays: null,
        calendarOverflow,
      });
      continue;
    }

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
        lastSession: isoDay(maxDate(sessionDates)),
        lastDesignHistory: null,
        diffDays: null,
        calendarOverflow,
      });
      continue;
    }

    const dhText = readFileSync(dhPath, 'utf-8');
    const lastSession = maxDate(sessionDates);
    const lastDH = maxDate(parseDates(dhText, DESIGN_HISTORY_DATE_RE));

    const pastDH = lastSession != null && lastDH != null && lastSession > lastDH;
    if (!lastDH || lastSession == null || pastDH || verdictOverflow > 0) {
      stale.push({
        project: name,
        kind: 'stale',
        lastSession: isoDay(lastSession),
        lastDesignHistory: lastDH ? lastDH.toISOString().slice(0, 10) : '(없음)',
        diffDays: pastDH ? Math.round((lastSession - lastDH) / DAY_MS) : null,
        calendarOverflow,
        realLater: pastDH || (!lastDH && lastSession != null),
      });
    } else if (calendarOverflow.length > 0) {
      // Verdict is clean, but an `ADR 없음` entry carries a heading typo.
      stale.push({
        project: name,
        kind: 'overflow',
        lastSession: isoDay(lastSession),
        lastDesignHistory: isoDay(lastDH),
        diffDays: null,
        calendarOverflow,
      });
    }
  }

  return stale;
}
