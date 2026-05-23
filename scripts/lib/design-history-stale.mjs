import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SESSION_LOG_DATE_RE = /^## \[(\d{4}-\d{2}-\d{2})\]/gm;
const DESIGN_HISTORY_DATE_RE = /^## (\d{4}-\d{2}-\d{2})/gm;

function parseDates(text, pattern) {
  const dates = [];
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    // The regex matches digit-shaped YYYY-MM-DD literals but cannot reject
    // semantically invalid ones like 2026-13-01 or 2026-02-30. JavaScript's
    // Date constructor returns an Invalid Date for those, which would later
    // crash `toISOString()` with RangeError and poison `>` comparisons inside
    // maxDate. Filter at the parse boundary so callers never see one.
    const d = new Date(m[1]);
    if (!Number.isNaN(d.getTime())) dates.push(d);
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
      sessionDates.push(...parseDates(readFileSync(flatSlPath, 'utf-8'), SESSION_LOG_DATE_RE));
    }
    const dirSlPath = join(projectDir, 'session-log');
    if (existsSync(dirSlPath) && statSync(dirSlPath).isDirectory()) {
      for (const entry of readdirSync(dirSlPath)) {
        if (!entry.endsWith('.md')) continue;
        const text = readFileSync(join(dirSlPath, entry), 'utf-8');
        sessionDates.push(...parseDates(text, SESSION_LOG_DATE_RE));
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
