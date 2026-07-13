// pr-body.mjs — the one reading of a PR body's markdown, shared by the PR gate
// (check-pr-surface) and the release collector (collect-changelog).
//
// These two modules ask the same questions of the same text: where is the
// `## Changelog` heading, where does its section end, and is what is inside it a
// usable release note. They used to answer separately, and the answers drifted:
//
//   - The collector read the RAW body, so a PR that DEMONSTRATES a changelog
//     block inside a code fence (a PR about the template, or about this
//     collector) handed it the example. The example shipped in CHANGELOG.md and
//     the real note was never seen. The gate passed the PR, because the gate
//     masks fences and found the real heading further down.
//   - The gate had its own idea of a valid EN/KO block, looser than the
//     collector's, so shapes the gate called fine (`None.`, a duplicated `- EN:`)
//     came out of the collector as `malformed`.
//
// A green gate is a PROMISE that the entry below it will reach the changelog.
// Two parsers cannot keep that promise, so there is one, and it lives here.
//
// Maintainer-only, like both of its consumers: nothing here is in package.json
// `files`.

// ── headings ────────────────────────────────────────────────────────────────
//
// GFM's ATX heading, both halves of its shape:
//   - 0-3 spaces of leading indent still render as a heading; 4+ is an indented
//     code block. A gate anchored at column 0 rejects a body that renders
//     perfectly, which is the worst thing a gate can do.
//   - a closing run of `#` is optional and means nothing (`## Changelog ##` is
//     the same H2 as `## Changelog`), so demanding end-of-line right after the
//     text is the same false positive in a different disguise.
const ATX_TAIL = '[ \\t]*(?:#+[ \\t]*)?$';

/** An ATX heading matcher for `hashes` + `text` (a regex source fragment). */
export function heading(hashes, text, flags = 'm') {
  return new RegExp(`^ {0,3}${hashes}[ \\t]+${text}${ATX_TAIL}`, flags);
}

/** Any ATX heading, `#` through `######`. Ends a section. */
export const isAnyHeading = (line) => /^ {0,3}#{1,6}[ \t]+\S/.test(String(line ?? ''));

export const H1_ENGLISH = heading('#', 'English', 'im');
export const H1_KOREAN = heading('#', '한국어');
export const H2_CHANGELOG = heading('##', 'Changelog', 'im');
export const H2_CHECKLIST = heading('##', 'Checklist', 'im');

// ── the live view ───────────────────────────────────────────────────────────

/** HTML comments blanked in place (line count preserved). */
export function stripHtmlComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

/**
 * The body as an array of LIVE lines: HTML comments and fenced code blocks
 * blanked (emptied, not removed, so index i here is line i of the raw body).
 *
 * This is what "the text GFM actually renders as markdown" means for every
 * structural question either consumer asks. A heading inside a fence is an
 * example, not a section.
 *
 * An unterminated fence blanks everything after it — failing toward reporting a
 * missing section rather than toward silently accepting text that never rendered.
 */
export function maskedLines(rawBody) {
  const lines = stripHtmlComments(String(rawBody ?? '').replace(/\r\n/g, '\n')).split('\n');
  let fence = null;
  return lines.map((line) => {
    const delim = /^[ \t]*(`{3,}|~{3,})[ \t]*/.exec(line);
    if (fence) {
      if (delim && delim[1][0] === fence.char && delim[1].length >= fence.len) fence = null;
      return '';
    }
    const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      return '';
    }
    return line;
  });
}

// ── the changelog section ───────────────────────────────────────────────────

/**
 * The `## Changelog` section: its boundaries found on the LIVE view, its content
 * taken from the RAW lines between them.
 *
 * Returns { start, end, lines } (0-based, `end` exclusive, `lines` the raw content
 * lines), or null when the heading is absent. `start` is the heading's own line.
 */
export function changelogSection(rawBody) {
  const raw = String(rawBody ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const view = maskedLines(rawBody);
  const start = view.findIndex((l) => H2_CHANGELOG.test(l));
  if (start === -1) return null;
  let end = view.length;
  for (let i = start + 1; i < view.length; i++) {
    if (isAnyHeading(view[i])) {
      end = i;
      break;
    }
  }
  return { start, end, lines: raw.slice(start + 1, end) };
}

/**
 * Parse the content lines of a `## Changelog` section.
 *
 *   { en, ko }              both present and non-empty
 *   'none'                  a literal `None` (no changelog entry; still indexed)
 *   { malformed, reason }   present but unusable
 *
 * This is the ONE judgment of whether a changelog block is usable. The gate
 * reports its `reason` to the author while the PR can still be edited; the
 * collector relies on the gate having done so. They cannot disagree, because
 * this is the only place the question is answered.
 */
export function parseChangelogLines(contentLines) {
  const cleaned = (contentLines || []).join('\n').replace(/<!--[\s\S]*?-->/g, '');
  const enLines = [];
  const koLines = [];
  let noneSeen = false;
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const en = /^-?\s*EN\s*:\s*(.*)$/i.exec(line);
    const ko = /^-?\s*KO\s*:\s*(.*)$/i.exec(line);
    if (en) enLines.push(en[1].trim());
    else if (ko) koLines.push(ko[1].trim());
    else if (/^[-*]?\s*None\s*$/i.test(line)) noneSeen = true;
    // other prose lines are tolerated and ignored
  }

  if (noneSeen && (enLines.length || koLines.length)) {
    return { malformed: true, reason: 'None mixed with EN/KO lines' };
  }
  if (noneSeen) return 'none';
  if (enLines.length > 1 || koLines.length > 1) {
    return { malformed: true, reason: 'duplicate EN or KO line' };
  }
  if (enLines.length === 0 && koLines.length === 0) {
    return { malformed: true, reason: 'empty Changelog block (no EN/KO/None)' };
  }
  if (enLines.length === 0 || !enLines[0]) {
    return { malformed: true, reason: 'missing or empty EN line' };
  }
  if (koLines.length === 0 || !koLines[0]) {
    return { malformed: true, reason: 'missing or empty KO line' };
  }
  return { en: enLines[0], ko: koLines[0] };
}

/** parseChangelogLines applied to a whole PR body. null = the heading is absent. */
export function parseChangelogBody(rawBody) {
  const sec = changelogSection(rawBody);
  if (sec === null) return null;
  return parseChangelogLines(sec.lines);
}
