// Fenced-code and HTML-comment detection, the one place in this repo that decides
// which text is prose. Callers: the close apply's section-loss guard
// (crystallize-close-apply.mjs) and the design-history lint (design-history-stale.mjs).
// Pure, node built-ins only: hooks may copy it, and scripts/ imports it.
//
// Public API, both take the whole file text:
//   fencedLineMask(text)  boolean[] per `\n`-split line, true on a fence line
//                         (opener, body, closer)
//   maskNonProse(text)    copy of `text` with fences and HTML comments blanked

// A fence marker line: 0-3 leading spaces (CommonMark still calls that "unindented"),
// then a run of 3+ backticks or 3+ tildes, then the rest of the line. `m[1]` is the
// marker run itself (so its first char and length identify what closes it); `m[2]` is
// whatever follows, an info string on the opening line, and required to be blank
// (after trim) on a line being checked as a close.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// One pass over the lines, fences and comments tracked together so neither can be
// read out of the other: a marker inside a comment is not a fence, and a comment
// opener inside a fence is not a comment. `skip` holds openers that turned out to
// never close; they are read as plain text on the rescan (see scan).
function scanOnce(text, skip) {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  // A leading frontmatter block is not scanned, so a ``` inside a YAML block scalar
  // cannot open a fence that swallows the body. A BOM does not hide the opener.
  let from = 0;
  if (lines[0].replace(/^﻿/, '') === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) from = close + 1;
  }
  const fenced = new Array(lines.length).fill(false);
  const spans = lines.map(() => []); // comment [start, end) columns per line
  let fence = null; // { ch, len, key }
  let comment = null; // { key }
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      fenced[i] = true;
      const m = line.match(FENCE_RE);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      continue;
    }
    // Only a line that starts outside a comment can open a fence. CommonMark also
    // refuses a backtick fence whose info string holds a backtick (that line is
    // inline code), so ```js`x` is plain text, not an opener.
    const key = `f${i}`;
    const m = comment || skip.has(key) ? null : line.match(FENCE_RE);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length, key };
      fenced[i] = true;
      continue;
    }
    let col = 0;
    for (;;) {
      let start = col;
      if (!comment) {
        let s = line.indexOf('<!--', col);
        while (s >= 0 && skip.has(`c${i}:${s}`)) s = line.indexOf('<!--', s + 4);
        if (s < 0) break;
        comment = { key: `c${i}:${s}` };
        start = s;
        col = s + 4;
      }
      const e = line.indexOf('-->', col);
      if (e < 0) {
        spans[i].push([start, line.length]);
        break;
      }
      spans[i].push([start, e + 3]);
      comment = null;
      col = e + 3;
    }
  }
  return { lines, fenced, spans, unclosed: (fence || comment)?.key ?? null };
}

/**
 * Scan `text`. A fence closes only on a later line whose marker is the SAME
 * character and AT LEAST as long (a 4-backtick open is not closed by 3 backticks),
 * with nothing after it. An HTML comment runs from `<!--` to the next `-->`, across
 * lines.
 *
 * An opener that never finds its close before EOF is treated as NEVER HAVING
 * OPENED: the scan reruns with that opener read as plain text, so every line from
 * it to EOF is visible again. That is the safe direction for both callers. The
 * section-loss guard extracts headings from disk and payload with the same
 * function, so an unclosed run swallowing real headings would undercount one side
 * and either hide a loss or report one that never happened; reading it as prose
 * costs at most a false park, recoverable through `restructure: true`. The
 * design-history lint reads the same direction: a heading it wrongly hid would
 * drop a W8 that blocks the close, while an example it wrongly reads as live only
 * adds a warning the author can see and fix.
 *
 * Not CommonMark-complete: a fence inside a blockquote or list item is scanned
 * like a top-level one, and an indented code block is not recognised. Both would
 * need block-context tracking that a complete parser needs and these callers do
 * not.
 */
function scan(text) {
  const skip = new Set();
  for (;;) {
    const r = scanOnce(text, skip);
    if (r.unclosed === null) return r;
    skip.add(r.unclosed); // each rescan retires one opener, so this terminates
  }
}

/**
 * Which lines are fence lines (opener, body, closer). Lines are the `\n` split of
 * `text`, so index i is line i of the file. Frontmatter lines are never fenced.
 * A fence marker inside an HTML comment does not count, and a comment inside a
 * fence is just fence content, which makes this the right mask for ignoring
 * markers that are themselves comments (`<!-- ... -->`) when they sit in a fence.
 *
 * @param {string} text
 * @returns {boolean[]}
 */
export function fencedLineMask(text) {
  return scan(text).fenced;
}

const blank = (s) => s.replace(/[^\n]/g, ' ');

/**
 * A copy of `text` with fenced code and HTML comments blanked to spaces, same
 * length and same newline positions, so a match index in the copy is the same
 * index in `text`. Frontmatter text is left as written. A comment is blanked from
 * its `<!--` to its `-->` only, so the rest of a line stays readable.
 *
 * A CRLF line is matched without its `\r`; the `\r` stays in the copy, except on a
 * fence line, where the whole line (its `\r` too) becomes spaces.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskNonProse(text) {
  const { lines, fenced, spans } = scan(text);
  const raw = text.split('\n');
  return raw
    .map((l, i) => {
      if (fenced[i]) return blank(l);
      let out = lines[i];
      for (const [s, e] of spans[i]) out = out.slice(0, s) + blank(out.slice(s, e)) + out.slice(e);
      return out + l.slice(lines[i].length);
    })
    .join('\n');
}
