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
 * Blocked (examples use an `N` placeholder, NOT a real digit, so this file
 * itself scans clean and is NOT exempted from --all):
 *   - /\bISSUE-\d+\b/i      → the wiki issue tracker, any case (e.g. ISSUE-N)
 *   - /\bfix[ \t ]+#\d+\b/i → the wiki fix tracker, any case (e.g. fix #N)
 *
 * Accepted edge cases (documented, not bugs):
 *   - FALSE POSITIVE: `FOO-ISSUE-N` matches (the `-` gives a word boundary
 *     before ISSUE). Such a string in this repo would still be a tracker ref.
 *   - The `fix #N` matcher requires the literal word `fix` immediately before the
 *     `#`, so `prefix #N`, `suffix #N`, `PR #N`, `(#N)`, and bare `#N` are all
 *     safe — none start the word `fix` right before the `#`.
 */

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
];

/**
 * Scan a blob of text. Returns an array of hits:
 *   { pattern, label, match, line, col, lineText }
 * `line`/`col` are 1-based. Empty array => clean.
 */
export function scanText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const { name, label, re } of BLOCKED_PATTERNS) {
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
