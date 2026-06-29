/**
 * lib/check-tracker-ids.mjs — pure scanner for wiki-internal tracker IDs.
 *
 * The OSS repo must not ship references to the maintainer's PRIVATE wiki issue
 * tracker (`ISSUE-N`) or fix tracker (`fix #N`) in public artifacts: an OSS user
 * who opens a shipped file or reads the README/CHANGELOG just sees a dangling
 * pointer into a tracker they cannot access. GitHub references (`PR #N`, `(#N)`,
 * bare `#N`, issue URLs) are legitimate and must NOT be flagged.
 *
 * This module is PURE (no fs, no git, no process) so it is unit-testable; the
 * CLI wrapper (scripts/check-tracker-ids.mjs) does the file/git/commit-msg I/O.
 *
 * Blocked everywhere in scope (examples use an `N` placeholder, NOT a real
 * digit, so this file itself scans clean and is NOT exempted from --all):
 *   - /\bISSUE-\d+\b/i      → the wiki issue tracker, any case (e.g. ISSUE-N)
 *   - /\bfix[ \t ]+#\d+\b/i → the wiki fix tracker, any case (e.g. fix #N)
 *   - /\bFEAT-\d+\b/i       → the wiki feature tracker, any case (e.g. FEAT-N)
 *   - /\bIMPR-\d+\b/i       → the wiki improvement tracker, any case (e.g. IMPR-N)
 *   - /\bPRAC-\d+\b/i       → the wiki practice tracker, any case (e.g. PRAC-N)
 *
 * FEAT-/IMPR-/PRAC- were once exempt inside shipped code comments; that exemption
 * shipped dangling pointers into the maintainer's private wiki to OSS users, so it
 * was removed. They now block everywhere in scope; the maintainer keeps them only
 * in tests/, qa-runs/, and local notes. The verifier subsystem that legitimately
 * carries `decisions/NNNN` runtime data is excluded from the scan instead (see the
 * CLI's EXCLUDED_FILES).
 *
 * `ADR NNNN` / `ADR-NNNN` / `decisions/NNNN` (DECISION_PATTERNS) are dangling
 * pointers into the maintainer's private wiki ADR set. They block everywhere in
 * scope EXCEPT CHANGELOG.md, whose version history legitimately cites the decision
 * behind a release line. The CLI applies these per-file via patternsFor().
 *
 * Accepted edge cases (documented, not bugs):
 *   - FALSE POSITIVE: `FOO-ISSUE-N` matches (the `-` gives a word boundary
 *     before ISSUE). Such a string in this repo would still be a tracker ref.
 *   - The `fix #N` matcher requires the literal word `fix` immediately before the
 *     `#`, so `prefix #N`, `suffix #N`, `PR #N`, `(#N)`, and bare `#N` are all
 *     safe — none start the word `fix` right before the `#`.
 */

// `ADR NNNN` / `ADR-NNNN` / `decisions/NNNN` point into the maintainer's private
// wiki ADR set, which an OSS user does not have. The CLI applies this set to every
// in-scope file EXCEPT CHANGELOG.md (version history may cite a decision); the
// verifier subsystem that carries decisions/ paths as runtime data is removed by
// EXCLUDED_FILES first. The ADR matcher tolerates a space, tab, or hyphen between
// `ADR` and the number. Examples below use `NNNN`, not real digits, so this file
// scans clean.
export const DECISION_PATTERNS = [
  {
    name: 'ADR NNNN',
    label: 'wiki ADR pointer',
    re: /\bADR[ \t-]+\d{3,4}\b/gi,
  },
  {
    name: 'decisions/NNNN',
    label: 'wiki decisions path',
    re: /\bdecisions\/\d{3,4}\b/gi,
  },
];

// Each entry: a named, /g/i regex over a single line of text.
export const BLOCKED_PATTERNS = [
  {
    name: 'ISSUE-N',
    label: 'wiki issue-tracker id',
    re: /\bISSUE-\d+\b/gi,
  },
  {
    name: 'fix #N',
    label: 'wiki fix-tracker id',
    re: /\bfix[ \t ]+#\d+\b/gi,
  },
  // FEAT-/IMPR-/PRAC- were a tag-body-only set until they were promoted here so
  // they block in shipped code comments too (the old exemption leaked dead wiki
  // pointers to OSS users). Examples below use `N`, not a real digit, so this
  // file scans clean and is NOT exempted from --all.
  { name: 'FEAT-N', label: 'wiki feature-tracker id', re: /\bFEAT-\d+\b/gi },
  { name: 'IMPR-N', label: 'wiki improvement-tracker id', re: /\bIMPR-\d+\b/gi },
  { name: 'PRAC-N', label: 'wiki practice-tracker id', re: /\bPRAC-\d+\b/gi },
];

// The full tracker-ID set for a no-code public surface (the annotated tag body,
// republished verbatim by `gh release create --notes-from-tag`). It equals
// BLOCKED_PATTERNS now that FEAT-/IMPR-/PRAC- live there; ADR/decisions anchors
// are intentionally allowed in the tag body (release notes cite decisions the way
// CHANGELOG history does). The CHANGELOG's own surface-ID-0 is held by the section
// migration + a grep regression test (changelog-pr-guide §5).
export const TAG_BODY_PATTERNS = [...BLOCKED_PATTERNS];

// Strip a leading comment-continuation marker (`*`, `//`, `#`) so a wrapped
// comment line can be re-joined to its predecessor as flowing text.
const COMMENT_CONT_RE = /^[ \t]*(?:\*|\/\/|#+)[ \t]?/;

/**
 * Scan a blob of text against `patterns` (default BLOCKED_PATTERNS). Returns hits:
 *   { pattern, label, match, line, col, lineText }
 * `line`/`col` are 1-based. Empty array => clean. The CLI passes the broader
 * [...BLOCKED_PATTERNS, ...DECISION_PATTERNS] set for every in-scope file but the
 * CHANGELOG.
 *
 * Tracker tokens also line-wrap inside comments (`... continuing (ADR\n * 0045)`).
 * A pure per-line scan misses those, so each line is ALSO scanned joined to the
 * next (with the next line's comment-continuation marker collapsed to a space);
 * only matches that START on the current line and CROSS the join are kept, so a
 * wrap is reported exactly once at its prefix line and non-wrapped tokens are
 * never double-counted.
 */
export function scanText(text, patterns = BLOCKED_PATTERNS) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const { name, label, re } of patterns) {
      re.lastIndex = 0; // reset shared /g regex between lines
      let m;
      while ((m = re.exec(lineText)) !== null) {
        hits.push({
          pattern: name,
          label,
          match: m[0],
          line: i + 1,
          col: m.index + 1,
          lineText,
        });
        if (m.index === re.lastIndex) re.lastIndex++; // never-zero-width guard
      }
    }
    // Wrapped-token guard: a token can line-wrap at two points — between its
    // prefix WORD and its number (`ADR\n0045`, where the break stands in for a
    // space) OR right at its separator (`ISSUE-\n9`, `decisions/\n0031`,
    // `fix #\n37`, where the digit must sit flush against `-`/`/`/`#`). So scan
    // this line joined to the next BOTH with a space (space-separated forms) and
    // with no gap (separator-flush forms), keeping only matches that begin on this
    // line and cross the join. A token reconstructed by both joins (e.g. the ADR
    // hyphen form) is de-duplicated by its whitespace-collapsed text.
    if (i + 1 < lines.length) {
      const lt = lineText.length;
      const tail = lines[i + 1].replace(COMMENT_CONT_RE, '');
      const seen = new Set();
      for (const [joined, tailAt] of [
        [lineText + ' ' + tail, lt + 1],
        [lineText + tail, lt],
      ]) {
        for (const { name, label, re } of patterns) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(joined)) !== null) {
            if (m.index < lt && m.index + m[0].length > tailAt) {
              const key = name + ':' + m[0].replace(/\s+/g, '');
              if (!seen.has(key)) {
                seen.add(key);
                hits.push({
                  pattern: name,
                  label,
                  match: m[0],
                  line: i + 1,
                  col: m.index + 1,
                  lineText: joined,
                });
              }
            }
            if (m.index === re.lastIndex) re.lastIndex++;
          }
        }
      }
    }
  }
  return hits;
}

/**
 * Strip a `--verbose` commit diff: everything from the scissors line onward is
 * dropped by git before the commit is recorded, so it must not be scanned. The
 * scissors art is comment-char-prefixed but the `>8` token is constant across
 * comment chars, so match on that. Returns the text up to (excluding) the
 * scissors line. If no scissors line is present, returns the input unchanged.
 */
// git's real scissors line is COMMENT-prefixed (`# ----- >8 -----`); a bare
// `--- >8 ---` line is NOT a scissors marker (git keeps it as body), so it must
// not trigger truncation. Require the leading comment char (default `#`, or `;`).
const SCISSORS_RE = /^[ \t]*[#;][ \t]*-{2,}[ \t]*>8[ \t]*-{2,}/;

export function stripScissors(text) {
  if (typeof text !== 'string') return '';
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => SCISSORS_RE.test(l));
  if (idx === -1) return text;
  return lines.slice(0, idx).join('\n');
}

/**
 * Does a commit-message file carry git's auto-generated template? git ONLY adds
 * the instructional / status comment block (and the --verbose scissors) when the
 * effective cleanup mode will STRIP comment lines (the editor default). In the
 * comment-PRESERVING modes (`git commit -m` → whitespace, `--cleanup=verbatim`)
 * git adds NO template, so a `#` line there is real committed content.
 *
 * The commit-msg hook therefore decides comment handling by template presence,
 * not by config alone: template present ⇒ scan the strip-comments view (matches
 * git, no false-positive on the template's branch/file names); template absent ⇒
 * scan the raw view so a `#`-prefixed tracker id git WILL keep is still caught.
 *
 * Markers cover the default English git template + the scissors line. Other
 * locales may miss the template and fall through to the raw (comment-keeping)
 * scan — which is the SAFE direction for a gate (catches more, never less).
 */
export function messageHasGitTemplate(text) {
  if (typeof text !== 'string') return false;
  if (SCISSORS_RE_M.test(text)) return true; // --verbose scissors (comment-prefixed)
  return /^[#;] *(Please enter the commit message|On branch |Changes to be committed:|Changes not staged for commit:|Untracked files:|Your branch (is|and))/m.test(
    text,
  );
}

// Multiline form of SCISSORS_RE for whole-message detection.
const SCISSORS_RE_M = /^[ \t]*[#;][ \t]*-{2,}[ \t]*>8[ \t]*-{2,}/m;
