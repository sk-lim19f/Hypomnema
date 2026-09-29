// time.mjs: shared time constants for scripts/. Imports nothing, so a script
// that only needs a day length does not pull in the modules it would otherwise
// share a file with (page-usage.mjs loads hooks/hypo-shared.mjs, for one).
//
// hooks/ keeps its own copies: hooks may not import scripts/ (they are copied
// standalone into ~/.claude/hooks/).

export const DAY_MS = 86400000;

// The strict YYYY-MM-DD parser used by lint.mjs (W15/W16), the design-history
// heading check, and the close-path payload.date check. `new Date(literal)`
// accepts more than a format check implies: a calendar-overflow value like
// `2026-02-30` silently normalizes to March 2 instead of failing, so a bare
// regex test on the shape (`/^\d{4}-\d{2}-\d{2}$/`) lets it through looking
// validated. Returns a comparable UTC timestamp for a literal that is exactly
// YYYY-MM-DD and round-trips to the same calendar date through a UTC Date, or
// null otherwise (wrong shape or calendar overflow).
//
// verify/doctor and the hook date checks (e.g. isOverdueDate in
// hooks/hypo-shared.mjs) do NOT use this: doctor.mjs and hypo-shared.mjs
// agree to read the same literal with the same characters and same meaning,
// and hooks may not import scripts/ (they are copied standalone into
// ~/.claude/hooks/), so those stayed on the plain format check rather than
// pull this file's logic across that boundary.
const STRICT_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseStrictDate(literal) {
  if (literal == null) return null;
  const m = STRICT_DATE_RE.exec(String(literal));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 onto 1900-1999,
  // so a valid `0001-01-01` would fail the round-trip below and be rejected.
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  const ts = check.getTime();
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null; // calendar overflow, e.g. month 13 or Feb 30
  }
  return ts;
}
