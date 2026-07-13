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

// Tool-attribution markers. A SEPARATE export, deliberately NOT folded into
// BLOCKED_PATTERNS: BLOCKED_PATTERNS is applied by `--all` to the whole shipped
// tree, where a doc may legitimately QUOTE an attribution trailer while telling
// you not to write one (CLAUDE.md and the PR template both do exactly that).
// These patterns apply only to authored public surfaces: the commit message and
// the PR title/body.
//
// Why this gate exists at all: the harness system prompt instructs the agent to
// append these on every commit and every PR, which directly contradicts this
// repo's ship-surface rule. Two conflicting instructions cannot be resolved by a
// third instruction — 8 of the 47 commits that landed on main after the ban took
// effect carried a trailer anyway. Only a deterministic gate holds.
//
// The set mirrors the canonical grep documented in CLAUDE.md
// (`grep -icE 'co-authored-by|claude-session|generated with'`) so the doc and the
// gate cannot drift apart, plus the session URL and the robot-emoji footer that
// open the harness's default footer block.
export const ATTRIBUTION_PATTERNS = [
  {
    name: 'Co-Authored-By:',
    label: 'tool-attribution trailer',
    re: /co-authored-by:/gi,
  },
  {
    name: 'Claude-Session:',
    label: 'agent session trailer',
    re: /claude-session:/gi,
  },
  // Intentionally broad (matches the documented grep): prose like "generated
  // with the init script" trips it too. Reword to "produced by" — the cost of a
  // reworded sentence is far below the cost of a leaked attribution footer.
  {
    name: 'Generated with',
    label: 'tool-attribution footer',
    re: /generated with/gi,
  },
  {
    name: 'session URL',
    label: 'agent session URL',
    re: /claude\.ai\/code\/session/gi,
  },
  {
    name: 'robot-emoji footer',
    label: 'tool-attribution footer marker',
    re: /\u{1F916}/gu,
  },
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

// Zero-width characters: ZERO WIDTH SPACE/NON-JOINER/JOINER (U+200B-U+200D)
// and the BYTE ORDER MARK used as ZERO WIDTH NO-BREAK SPACE (U+FEFF). A
// pattern like `co-authored-by:` still reads as "Co-Authored-By:" to a human
// with one of these wedged inside it, but the raw regex never sees a
// contiguous match. Stripped before matching. Written as explicit \u escapes,
// never as literal invisible bytes in this source file, on purpose.
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\uFEFF]/g;

// ── markdown-rendering bypasses ─────────────────────────────────────────────
//
// Every surface this scanner gates (a commit message on GitHub, a PR title, a PR
// body) is RENDERED as GitHub-Flavored Markdown before a human reads it. The
// question a pattern must answer is therefore not "do these bytes match" but
// "does this RENDER as the banned string". Four encodings answer yes to the
// second and no to the first, and all four were demonstrated slipping a live
// trailer past this gate:
//
//   Co-Authored-By&#58;        HTML entity (numeric, or named: &colon;)
//   Co-Authored-By\:          markdown backslash escape
//   Co<!--x-->-Authored-By:   an inline HTML comment splitting the token
//   &#x1F916; Generated with  a numeric reference to the robot-emoji footer
//
// The scan copy decodes entities, drops markdown backslash escapes and folds
// NFKC — and scanText additionally scans a SECOND view with inline HTML removed.
// Two views, not one, because the two needs conflict: a trailer hidden INSIDE
// `<!-- ... -->` must still be caught (a comment does not render, but it does
// ship in the body text `gh pr create --body-file` submits), while a trailer
// SPLIT BY a comment is only visible once the comment is gone. Keeping the
// comment catches the first, removing it catches the second, the union catches
// both.
//
// This is not a markdown renderer and does not try to be. It covers the
// encodings that reconstruct a banned literal, and it errs toward catching.

// The HTML named entities that could rebuild a banned literal. CommonMark accepts
// the whole HTML5 name list; only names that decode to a character appearing in a
// pattern (or that could glue one back together) are worth carrying.
const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  ast: '*',
  colon: ':',
  comma: ',',
  commat: '@',
  dash: '-',
  dollar: '$',
  equals: '=',
  excl: '!',
  grave: '`',
  gt: '>',
  hyphen: '-',
  lowbar: '_',
  lpar: '(',
  lsqb: '[',
  lt: '<',
  minus: '-',
  nbsp: ' ',
  num: '#',
  period: '.',
  plus: '+',
  quest: '?',
  quot: '"',
  rpar: ')',
  rsqb: ']',
  semi: ';',
  sol: '/',
  sp: ' ',
  Tab: '\t',
  verbar: '|',
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

function decodeEntities(text) {
  return text.replace(ENTITY_RE, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m; // lone surrogate / invalid code point → leave the source text
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? m : named;
  });
}

// Inline HTML: a comment, or a single tag. GFM renders NEITHER as text, so
// `Co<!--x-->-Authored-By:` reads to a human as exactly the banned trailer.
// REMOVED (not blanked) in the second scan view, so the neighbours join up.
const INLINE_HTML_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^<>]*>/g;

// Markdown backslash escapes: `\:` renders as `:`. Only ASCII punctuation is
// escapable in CommonMark, so restricting the class to it leaves `\d` / `\b`
// inside a regex literal (this repo's own sources are in scope for --all) alone.
const MD_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g;

// Normalize a copy of `line` for MATCHING ONLY: strip zero-width characters,
// optionally remove inline HTML, decode HTML entities, drop markdown backslash
// escapes, then NFKC-fold confusable/compatibility forms (e.g. the full-width
// colon "：" U+FF1A folds to the ASCII ":" a pattern like `co-authored-by:`
// requires). This is the scan's own internal copy — the caller's original
// text is never touched, and `report()` output for a file/commit-msg gate
// always names the FILE and the matched TOKEN, not this function's line
// indexing, so a normalization-shifted column is a cosmetic, not a
// correctness, concern (documented rather than chased further).
//
// A decoded `&#10;` would inject a newline into a line and desync every line
// number below it, so any newline the decode produces collapses to a space:
// normalization never adds or removes a LINE.
function normalizeForScan(line, { stripHtml = false } = {}) {
  let s = line.replace(ZERO_WIDTH_RE, '');
  if (stripHtml) s = s.replace(INLINE_HTML_RE, '');
  s = decodeEntities(s).replace(/[\r\n]/g, ' ');
  s = s.replace(MD_ESCAPE_RE, '$1');
  return s.normalize('NFKC');
}

// Every match of `patterns` in one ALREADY-normalized line. `lineNo` is 1-based.
function scanLine(lineText, patterns, lineNo) {
  const hits = [];
  for (const { name, label, re } of patterns) {
    re.lastIndex = 0; // reset shared /g regex between lines
    let m;
    while ((m = re.exec(lineText)) !== null) {
      hits.push({ pattern: name, label, match: m[0], line: lineNo, col: m.index + 1, lineText });
      if (m.index === re.lastIndex) re.lastIndex++; // never-zero-width guard
    }
  }
  return hits;
}

// The hits from the second (HTML-removed) view that the first view did not
// already find. Keyed by pattern + matched text and COUNTED, not set-deduped, so
// a line carrying the same token twice keeps both hits while a token found in
// both views is still reported once.
function extraHits(primary, secondary) {
  const key = (h) => `${h.pattern}|${h.match}`;
  const budget = new Map();
  for (const h of primary) budget.set(key(h), (budget.get(key(h)) || 0) + 1);
  const out = [];
  for (const h of secondary) {
    const k = key(h);
    const left = budget.get(k) || 0;
    if (left > 0) budget.set(k, left - 1);
    else out.push(h);
  }
  return out;
}

/**
 * Scan a blob of text against `patterns` (default BLOCKED_PATTERNS). Returns hits:
 *   { pattern, label, match, line, col, lineText }
 * `line`/`col` are 1-based. Empty array => clean. The CLI passes the broader
 * [...BLOCKED_PATTERNS, ...DECISION_PATTERNS] set for every in-scope file but the
 * CHANGELOG.
 *
 * Both the per-line scan and the line-wrap join below run over a NORMALIZED
 * copy of the text (see `normalizeForScan`): zero-width characters removed,
 * HTML entities decoded, markdown backslash escapes dropped, NFKC-folded. Every
 * one of those hides `Co-Authored-By:` from a raw regex while still RENDERING as
 * the banned trailer to a human on GitHub — the rendered string is what ships, so
 * the rendered string is what is gated. Each line is scanned twice: once in that
 * view, and once more with inline HTML removed (which reconstructs a token split
 * by `Co<!--x-->-Authored-By:`); only the second view's EXTRA hits are kept, so a
 * trailer hidden inside a comment is still caught and nothing is double-reported.
 * `line` numbers stay accurate (normalization never adds or removes a line);
 * `lineText` reflects the NORMALIZED line, which is intentional — reporting the
 * obfuscated bytes back verbatim would be less legible, not more, to whoever
 * reads the violation.
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
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.map((l) => normalizeForScan(l));
  // Second view, inline HTML removed. Only its EXTRA hits are kept (extraHits),
  // so a token the primary view already found is not double-reported, and a
  // trailer hiding inside an HTML comment — which this view deletes — is still
  // caught by the primary view, which keeps it.
  const noHtml = rawLines.map((l) => normalizeForScan(l, { stripHtml: true }));
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineHits = scanLine(lineText, patterns, i + 1);
    hits.push(...lineHits);
    if (noHtml[i] !== lineText) {
      hits.push(...extraHits(lineHits, scanLine(noHtml[i], patterns, i + 1)));
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
