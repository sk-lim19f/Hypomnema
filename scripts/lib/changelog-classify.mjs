/**
 * lib/changelog-classify.mjs — pure classifier + surface sanitizer for the
 * section-model CHANGELOG (changelog-pr-guide, format.md §3 / §5).
 *
 * Two responsibilities, both pure (no fs/git/process) so tests/runner.mjs can
 * exercise them on synthetic strings:
 *
 *   1. classifyChange(commitTitle) -> { section, basis }
 *      Decide which of the three migrated sections a change belongs to.
 *      Precedence (format.md §3): tracker ID first, Conventional-Commit type
 *      second, the legacy heading hint third, a safe Chores fallback last.
 *        - tracker:  FEAT-* -> New Features, ISSUE-* -> Bug Fixes,
 *                    IMPR-* / PRAC-* -> Chores.  Tracker wins over type, so a
 *                    `feat(...)` commit tagged IMPR-N lands in Chores, and a
 *                    `docs(...)` commit tagged ISSUE-N lands in Bug Fixes.
 *                    (IDs in this comment use an `N` placeholder, not a real
 *                    digit, so check-tracker-ids does not flag this file.)
 *        - type:     feat -> New Features, fix -> Bug Fixes, and the
 *                    non-user-visible types (chore/refactor/docs/ci/perf/...) ->
 *                    Chores.
 *        - heading:  an ID-less, type-less pre-convention item maps by the
 *                    legacy heading it sits under (Added -> New Features,
 *                    Fixed -> Bug Fixes, Changed/Internal/... -> Chores), passed
 *                    via opts.legacyHeading.
 *        - fallback: nothing resolves -> Chores (basis tells the caller it was a
 *                    guess, so a human can re-check).
 *
 *   2. sanitizeTrackerIds(text) -> text
 *      Strip every wiki tracker ID (FEAT-/IMPR-/ISSUE-/PRAC-N) from public
 *      surface, leaving the PR number (`#N`) as the only identifier
 *      (format.md §5, "표면 ID 0"). It also cleans the `(FEAT-N)` parens the ID
 *      left empty. NOTE: `fix #N` (the wiki fix-tracker) is NOT handled here —
 *      that pattern is the domain of check-tracker-ids; the classifier output
 *      never produces it. ADR anchors (`ADR NNNN`, `decisions/NNNN`) are left
 *      intact: CHANGELOG history keeps them (format.md §10).
 *
 * Section keys are stable machine strings; the human heading text
 * (`New Features` etc.) is mapped by SECTION_TITLE for callers that render.
 */

// Stable section keys. Order is the canonical render order (format.md §1).
export const SECTION = {
  NEW_FEATURES: 'new-features',
  BUG_FIXES: 'bug-fixes',
  CHORES: 'chores',
};

export const SECTION_TITLE = {
  'new-features': 'New Features',
  'bug-fixes': 'Bug Fixes',
  'chores': 'Chores',
};

// Tracker-ID -> section, in precedence order. A change carries one tracker in
// practice; if two ever co-occur, the earlier rule wins (FEAT > ISSUE > IMPR >
// PRAC), so a feature-with-cleanup is surfaced as a feature.
export const TRACKER_RULES = [
  { prefix: 'FEAT', re: /\bFEAT-\d+\b/i, section: SECTION.NEW_FEATURES },
  { prefix: 'ISSUE', re: /\bISSUE-\d+\b/i, section: SECTION.BUG_FIXES },
  { prefix: 'IMPR', re: /\bIMPR-\d+\b/i, section: SECTION.CHORES },
  { prefix: 'PRAC', re: /\bPRAC-\d+\b/i, section: SECTION.CHORES },
];

// Conventional-Commit type -> section (secondary signal). feat/fix are the two
// user-facing buckets; everything else is internal -> Chores (format.md §4:
// Chores is defined by KIND, not by visibility).
export const TYPE_SECTION = {
  feat: SECTION.NEW_FEATURES,
  fix: SECTION.BUG_FIXES,
  chore: SECTION.CHORES,
  refactor: SECTION.CHORES,
  docs: SECTION.CHORES,
  ci: SECTION.CHORES,
  perf: SECTION.CHORES,
  build: SECTION.CHORES,
  test: SECTION.CHORES,
  style: SECTION.CHORES,
};

// Legacy CHANGELOG heading -> section (format.md §6, the section-bound rows
// only). The hint used when neither a tracker ID nor a Conventional-Commit type
// resolves a change (a pre-convention prose item under an old `### Added` etc.).
// Headings that map to NON-section blocks (Highlights, Breaking, Upgrading,
// Known Issues, Notes) are deliberately absent: they are structural, not one of
// the three sections this function returns, so the caller routes them (§6/§8).
export const HEADING_SECTION = {
  added: SECTION.NEW_FEATURES,
  fixed: SECTION.BUG_FIXES,
  changed: SECTION.CHORES,
  internal: SECTION.CHORES,
  maintenance: SECTION.CHORES,
  documentation: SECTION.CHORES,
};

// Normalize a legacy heading to its HEADING_SECTION key: drop a leading `###`,
// the `⚠ ` warning glyph, and a trailing ` (한글)` variant marker, then
// lowercase. `### Fixed (한글)` and `⚠ Breaking` both reduce cleanly.
function normalizeHeading(heading) {
  return String(heading == null ? '' : heading)
    .replace(/^#+\s*/, '')
    .replace(/^[⚠️\s]+/, '')
    .replace(/\s*\(한글\)\s*$/, '')
    .trim()
    .toLowerCase();
}

// All four wiki tracker prefixes, as one alternation. Used by both the
// classifier (read) and the sanitizer (strip). Kept here as the single source
// so the two never drift.
export const TRACKER_ID_RE = /\b(?:FEAT|IMPR|ISSUE|PRAC)-\d+\b/gi;

// Internal labels that are NOT tracker IDs but must also leave the public
// surface (format.md §10): `Track A`, `Track A-sot`, `OQ-34`. These are NOT
// stripped by sanitizeTrackerIds — removing `Track A` cleanly needs a PR-number
// substitution, which is a human migration call (T5), not a regex. detect them
// so the migration can flag and replace them by hand rather than miss them.
export const INTERNAL_LABEL_RE = /\bTrack [A-Z](?:-[a-z]+)?\b|\bOQ-\d+\b/g;

// Parse the `type` out of a Conventional-Commit subject: `type(scope)!: rest`.
// Returns the lowercased type or null. The scope and the breaking-change `!`
// are optional.
function commitType(text) {
  const m = /^([a-zA-Z]+)(?:\([^)]*\))?!?:/.exec(String(text).trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Classify one change into a section, following format.md §3 precedence:
 * tracker ID first, Conventional-Commit type second, the legacy heading hint
 * third (for pre-convention prose items that carry neither), and a Chores
 * fallback last. Returns { section, basis } where basis is
 * 'tracker' | 'type' | 'heading' | 'fallback' — the basis is for the snapshot
 * fixture / human audit, not public surface.
 *
 * @param {string} text  commit subject / changelog line to classify
 * @param {{legacyHeading?: string}} [opts]  the `### Added` etc. the item sits
 *   under, used only when text alone is ambiguous (an ID-less, type-less line).
 * @returns {{section: string, basis: 'tracker'|'type'|'heading'|'fallback'}}
 */
export function classifyChange(text, opts = {}) {
  const s = String(text == null ? '' : text);
  // 1. tracker ID wins.
  for (const rule of TRACKER_RULES) {
    if (rule.re.test(s)) return { section: rule.section, basis: 'tracker' };
  }
  // 2. Conventional-Commit type.
  const type = commitType(s);
  if (type && TYPE_SECTION[type]) {
    return { section: TYPE_SECTION[type], basis: 'type' };
  }
  // 3. legacy heading hint (format.md §3 step 3 / §6) — an old `### Added` item
  //    with no conventional prefix maps by its heading, not the Chores default.
  if (opts && opts.legacyHeading != null) {
    const key = normalizeHeading(opts.legacyHeading);
    if (key in HEADING_SECTION) return { section: HEADING_SECTION[key], basis: 'heading' };
  }
  // 4. safe default — surfaced as a guess so a human can re-check.
  return { section: SECTION.CHORES, basis: 'fallback' };
}

/**
 * Remove every wiki tracker ID from `text`, leaving `#N` PR numbers untouched.
 * Cleans up the parens / stray whitespace the removed ID leaves behind so
 * `... (FEAT-N) (#N)` becomes `... (#N)`, not `... () (#N)`.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeTrackerIds(text) {
  if (text == null) return '';
  let s = String(text);
  // 1. drop the tracker IDs themselves.
  s = s.replace(TRACKER_ID_RE, '');
  // 2. parens the ID emptied: `()` or `(  )` -> gone.
  s = s.replace(/\(\s*\)/g, '');
  // 3. tidy whitespace the removal left: collapse runs, drop space hugging
  //    brackets/punctuation, strip per-line trailing space.
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/([([])[ \t]+/g, '$1');
  s = s.replace(/[ \t]+([)\].,;:])/g, '$1');
  // a removed leading label leaves orphaned punctuation at the start of a line
  // (e.g. `ISSUE-N: foo` -> `: foo`); drop it. NOTE: a tracker ID glued to other
  // text by a non-paren separator (`ISSUE-N/foo`) is not a CHANGELOG form and is
  // left minimally cleaned.
  s = s.replace(/^[ \t]*[:;,][ \t]*/gm, '');
  s = s.replace(/[ \t]+$/gm, '');
  return s.trim();
}

/**
 * Find internal labels (`Track A`, `OQ-NN`) that format.md §10 wants off the
 * public surface but that sanitizeTrackerIds intentionally does NOT auto-strip
 * (they need a PR-number substitution, a human call). Returns the matches so the
 * migration (T5) can flag and replace them rather than silently ship them.
 *
 * @param {string} text
 * @returns {string[]}  matched labels (empty if none)
 */
export function detectInternalLabels(text) {
  INTERNAL_LABEL_RE.lastIndex = 0;
  const out = String(text == null ? '' : text).match(INTERNAL_LABEL_RE);
  return out ? out : [];
}

/**
 * Does `text` still carry any wiki tracker ID? A cheap predicate for the
 * regression gate ("surface ID 0") — distinct from check-tracker-ids, which
 * only blocks ISSUE-/fix #. This sees all four prefixes.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasTrackerId(text) {
  TRACKER_ID_RE.lastIndex = 0;
  return TRACKER_ID_RE.test(String(text == null ? '' : text));
}
