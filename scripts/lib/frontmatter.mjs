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
