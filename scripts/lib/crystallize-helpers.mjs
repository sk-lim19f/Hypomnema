// ── helpers ──────────────────────────────────────────────────────────────────

// Cap the warn list in MODEL-FACING lint output. `result.lint` is serialized
// into the --json apply result the documented close path reads, and lint runs
// twice per close (preflight + post-apply), so an un-capped warn list (e.g.
// hundreds of broken-wikilink warnings) lands in model context twice on every
// close. Errors stay full (few, actionable); warns collapse to a count plus a
// small sample for quick diagnosis. The INTERNAL preflightLint / postApplyLint
// objects are untouched — the blocking filter and the pending-tag scan still
// read the full warn list. lint.mjs --json itself also stays full: its
// programmatic consumers (the pending-tag scan, the PreCompact W8 filter, tests)
// need every warn.
export function summarizeLintForOutput(l) {
  const SAMPLE = 10;
  const warns = l.warns || [];
  const out = {
    ok: l.ok,
    errors: l.errors || [],
    warnCount: warns.length,
    warns: warns.slice(0, SAMPLE),
  };
  if (warns.length > SAMPLE) out.warnsTruncated = warns.length - SAMPLE;
  return out;
}

// Deliberately NOT the canonical parser. scripts/lib/frontmatter.mjs is that,
// and it skips indented lines and sequence items so a nested `relations:` block
// cannot overwrite a top-level key. This one does not, and reads last-wins, so
// a page whose relations block carries its own tags is read from the wrong
// half. It is kept because moving it here was a pure relocation of a private
// function, and its one consumer is an advisory candidate list, not a gate.
// New code takes lib/frontmatter.mjs.
export function parseFrontmatterLoose(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return fm;
}

export function parseTags(fm) {
  if (!fm.tags) return [];
  const raw = fm.tags.trim().replace(/^\[|\]$/g, '');
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}
