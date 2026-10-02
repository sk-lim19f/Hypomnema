// Fenced-code detection shared by the close apply's section-loss guard
// (crystallize-close-apply.mjs) and the design-history lint (design-history-stale.mjs).
// Pure, node built-ins only: hooks may copy it, and scripts/ imports it.

// A fence marker line: 0-3 leading spaces (CommonMark still calls that "unindented"),
// then a run of 3+ backticks or 3+ tildes, then the rest of the line. `m[1]` is the
// marker run itself (so its first char and length identify what closes it); `m[2]` is
// whatever follows, an info string on the opening line, and required to be blank
// (after trim) on a line being checked as a close.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Which line indices are inside a fenced code block, for one file's lines.
 *
 * A fence opens on any line FENCE_RE matches while not already inside one, and
 * closes only on a later line whose marker is the SAME character and AT LEAST as
 * long (a 4-backtick open is not closed by 3 backticks, a CommonMark rule, and the
 * one this guard's predecessor ignored: the section-loss bypass this closes moved
 * two `##` headings into a properly-closed ```md fence and the old line-scan still
 * counted them as real headings because it never looked for a fence at all).
 *
 * An opening fence that never finds a matching close before EOF is treated as
 * NEVER HAVING OPENED (every line from that marker to EOF is unhidden here). That
 * is the safe direction for a guard whose entire job is "did content silently
 * disappear": the same function extracts headings from both disk and payload, so
 * treating an unclosed run as fenced would let it swallow real headings on
 * whichever side has the malformed markdown: undercounting disk (hiding sections
 * the guard should have protected) or undercounting payload (reporting a section
 * as lost when the payload never actually removed it). Treating it as prose
 * instead only risks the opposite: an occasional false park on a document with a
 * genuinely broken fence, which is recoverable through the same
 * `restructure: true` / proposal-resolve door every other park in this guard
 * already uses, not a silent loss. The design-history lint reads the same
 * direction for its own reason: a heading it wrongly hid would drop a W8 that
 * blocks the close, while a fence example it wrongly reads as live only adds a
 * warning the author can see and fix.
 *
 * Declined on purpose, not CommonMark-complete: an opening line's info string is
 * never checked for a stray backtick (CommonMark forbids one in a backtick fence's
 * info string; this scan does not care), and a fence inside a blockquote or list
 * item is scanned exactly like a top-level one. Both would need block-context
 * tracking that a complete parser needs and a loss guard does not. Getting the two
 * reproduced bypasses closed cheaply matters more than a complete parser.
 *
 * @returns {boolean[]} same length as `lines`, true where the line is fenced
 */
export function fencedLineMask(lines) {
  const hidden = new Array(lines.length).fill(false);
  let openIdx = -1;
  let fenceChar = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (openIdx === -1) {
      const m = lines[i].match(FENCE_RE);
      if (m) {
        openIdx = i;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
        hidden[i] = true; // tentative, unhidden below if this never closes
      }
      continue;
    }
    hidden[i] = true; // tentative, unhidden below if this never closes
    const m = lines[i].match(FENCE_RE);
    if (m && m[1][0] === fenceChar && m[1].length >= fenceLen && m[2].trim() === '') {
      openIdx = -1;
      fenceChar = null;
      fenceLen = 0;
    }
  }
  if (openIdx !== -1) {
    for (let i = openIdx; i < lines.length; i++) hidden[i] = false;
  }
  return hidden;
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * A copy of `text` with fenced code and HTML comments blanked to spaces, same
 * length and same newline positions, so a match index in the copy is the same
 * index in `text`.
 *
 * Fences follow fencedLineMask exactly (an unclosed fence never opened). Scanning
 * starts after the closing `---` of a leading frontmatter block, so a ``` inside a
 * YAML block scalar cannot open a fence that swallows the body; frontmatter text
 * itself is left as written. A `<!-- ... -->` region is blanked after the fences
 * (so a comment opener inside a fence is not read), and an unclosed `<!--` is left
 * alone, the same never-opened direction. Like fencedLineMask this follows fence
 * rules only and does not track list or blockquote containers.
 *
 * A fence marker inside an HTML comment is still read as a fence (fences are
 * masked before comments); that is out of scope here. A leading UTF-8 BOM does
 * not hide the frontmatter opener (it is compared stripped, the text is untouched).
 *
 * A CRLF line is matched without its `\r`, which stays in the copy (or becomes a
 * space when the line is blanked).
 */
export function maskNonProse(text) {
  const lines = text.split('\n');
  const bare = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let from = 0;
  if (bare[0].replace(/^\uFEFF/, '') === '---') {
    const close = bare.indexOf('---', 1);
    if (close > 0) from = close + 1;
  }
  const offset = from ? lines.slice(0, from).join('\n').length + 1 : 0;
  const tailLines = text.slice(offset).split('\n');
  const mask = fencedLineMask(bare.slice(from));
  const tail = tailLines
    .map((l, i) => (mask[i] ? blank(l) : l))
    .join('\n')
    .replace(HTML_COMMENT_RE, blank);
  return text.slice(0, offset) + tail;
}
