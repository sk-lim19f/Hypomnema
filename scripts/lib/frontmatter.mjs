// A YAML block sequence entry: `-` followed by whitespace or end-of-line.
// Narrower than `startsWith('-')` so a (nonstandard) plain key like `-key:` is
// still read rather than mistaken for a list item.
export const SEQUENCE_ENTRY_RE = /^-(\s|$)/;

// Lenient, top-level-only frontmatter field extractor (NOT a YAML parser).
// Reads only unindented `key: value` lines, skipping indented lines and list
// items, so a nested mapping (e.g. a `type:` inside a `relations:` list) cannot
// clobber the page's real top-level field. Without this a `learning` page
// carrying a relations block was mis-read as `type: depends_on` and silently
// dropped by type-routed consumers (doctor's verify-freshness scan, lint's
// type check). First-wins on a repeated top-level key. Assumes the Hypomnema
// convention of unindented root fields (templates/SCHEMA.md §3). scripts/lint.mjs
// imports this and adds a separate W9 pass for invalid-YAML classes a real
// parser would reject.
export function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || SEQUENCE_ENTRY_RE.test(line)) continue; // nested / list item
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || Object.hasOwn(fm, key)) continue; // first-wins
    fm[key] = line
      .slice(idx + 1)
      .trim()
      // strip a trailing YAML comment: `#` must follow whitespace to start one,
      // so `concept#bad` stays literal (and still trips lint's unknown-type W2)
      // while `concept # note` loses the comment.
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
  }
  return fm;
}

// A `sources_consulted:` key written as a YAML block sequence (`- item` on
// its own line, any indentation) rather than the single-line flow-list this
// repo requires (`sources_consulted: [a, b]`). parseFrontmatter above reads
// only the unindented key line itself, so a block list under it parses to an
// empty value: indistinguishable from the field never being set at all.
// lint.mjs uses this to tell "wrote it, wrong syntax" apart from "never
// wrote it" and report the former instead of silently comparing zero
// sources. Copies parseFrontmatter's top-level-key test (the `/^\s/` and
// SEQUENCE_ENTRY_RE line above) rather than calling it, so the two are not
// actually one shared check and can read the same line differently. They do,
// for `sources_consulted: # note`: parseFrontmatter's comment strip
// (`.replace(/\s+#.*$/, '')`) requires whitespace BEFORE the `#`, which the
// already-trimmed value here does not have, so parseFrontmatter keeps
// `"# note"` as a real (truthy) value while this function sees a
// comment-only value and looks for a block list below it instead. A
// comment-only or blank line between the key and its first item is skipped;
// the scan stops at the next top-level key (or a plain mapping), so a block
// list belonging to a LATER field is never attributed to this one.
export function hasBlockListSourcesConsulted(frontmatterBlock) {
  const lines = String(frontmatterBlock ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line) || SEQUENCE_ENTRY_RE.test(line)) continue; // not a top-level key line
    const idx = line.indexOf(':');
    if (idx < 0 || line.slice(0, idx).trim() !== 'sources_consulted') continue;
    const value = line.slice(idx + 1).trim();
    if (value !== '' && !value.startsWith('#')) return false; // a real scalar or flow-list: not this shape
    for (let j = i + 1; j < lines.length; j++) {
      const rest = lines[j].trim();
      if (rest === '' || rest.startsWith('#')) continue;
      // `rest` is already trimmed, so this catches a `- item` at any
      // indentation, including column 0.
      return SEQUENCE_ENTRY_RE.test(rest);
    }
    return false;
  }
  return false;
}
