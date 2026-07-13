/**
 * lib/check-pr-surface.mjs — pure scanner for the PR title/body public surface.
 *
 * The PR title and body are a public artifact that lives OUTSIDE the repo, so no
 * file-based gate can see them. Two rules leak through that hole today:
 *
 *   1. Tool attribution. The harness system prompt instructs the agent to append
 *      a `Co-Authored-By:` / `Generated with ...` footer; this repo forbids it.
 *      Conflicting instructions do not resolve in the gate's favor on their own.
 *   2. Wiki-internal tracker ids. `check-tracker-ids.mjs` gates files, staged
 *      blobs, commit messages and tag bodies — not a PR title. An `ISSUE-N` in a
 *      PR title has already shipped past a green `Tracker-id gate`.
 *
 * A third rule is structural: `gh pr create --body` REPLACES the body outright,
 * so `.github/PULL_REQUEST_TEMPLATE.md` never loads on the path an agent actually
 * uses. The template's bilingual blocks, `## Changelog` and `## Checklist` are
 * therefore silently skipped every time. The release collector assembles
 * CHANGELOG.md from the `## Changelog` block of merged PR bodies, so a missing
 * block is not cosmetic: the change vanishes from the next release notes.
 *
 * This module is PURE (no fs, no git, no process) so it is unit-testable; the CLI
 * wrapper (scripts/check-pr-surface.mjs) does the file / GitHub-event I/O.
 *
 * Every violation carries a `fix`: a gate that reports a violation without a way
 * out gets bypassed rather than obeyed, so each `fix` names the concrete command
 * that makes the PR pass (`gh pr edit <N> --title ...` / `--body-file <file>`).
 */

import {
  scanText,
  BLOCKED_PATTERNS,
  DECISION_PATTERNS,
  ATTRIBUTION_PATTERNS,
} from './check-tracker-ids.mjs';

// Wiki tracker ids (`ISSUE-N`, `fix #N`, `FEAT-N`, ...): blocked on the whole
// title and the whole body, no exemption.
const PR_TRACKER_PATTERNS = BLOCKED_PATTERNS;

// Wiki ADR pointers (`ADR NNNN`, `decisions/NNNN`) are blocked here too — CLAUDE.md
// names them as forbidden on a public surface, and a PR title/body is as public as
// it gets. They were left out of this gate entirely, which meant the ONE rule that
// spells out `decisions/NNNN` had no enforcement on the ONE surface an agent
// authors by hand.
//
// With ONE exemption, and it is not a hedge: the `## Changelog` block of a merged
// PR body is collected VERBATIM into CHANGELOG.md, and CHANGELOG.md is itself
// ADR-exempt in the file gate (a version-history line may cite the decision behind
// a release). Blocking an ADR ref inside that block would make a line the file gate
// explicitly allows unwritable through the only path that writes it. So the ADR
// scan reads a body with exactly that section blanked (maskChangelogSection) — the
// same carve-out the file gate already makes, in the same place, for the same
// reason.
//
// The COMMIT-MESSAGE gate keeps letting `ADR NNNN` through (judgeMessage scans
// BLOCKED_PATTERNS only); that is existing, tested behavior and this change does
// not touch it.
const PR_DECISION_PATTERNS = DECISION_PATTERNS;

// Tracker ids AND attribution are BOTH scanned on the RAW body (no comment
// stripping). A body written from the template used to keep an HTML comment
// that quoted the very phrase this scan blocks ("Generated with ..."), so an
// earlier version of this gate stripped HTML comments before the attribution
// scan to avoid tripping on that quote. That created a real hole: an
// `<!-- Co-Authored-By: ... -->` trailer, invisible on GitHub's rendered view
// but still present in the body text `gh pr create --body-file` actually
// submits, sailed through untouched. The rule is "no attribution ANYWHERE in
// the body", comments included — a comment does not render, but it still ships.
//
// The fix on the template side: `.github/PULL_REQUEST_TEMPLATE.md`'s
// instructional comment no longer quotes any banned literal (reworded to "Do
// NOT add a tool-attribution footer or a session URL of any kind."), so the RAW
// scan no longer self-trips on a compliant, template-derived body.
//
// Structural checks (bilingual headings, required subheadings, `## Changelog`,
// `## Checklist`) still read a STRIPPED view — see `structuralBody` below — but
// that stripping now removes comments AND fenced code / inline code, because a
// heading that only exists inside a code fence (```# English```) is example
// text, not a real section, and must not satisfy the template-compliance check.

// Newlines inside the comment are preserved so any position-sensitive caller
// downstream keeps consistent line counts even though this module no longer
// scans this view for attribution.
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

// Remove fenced code blocks (``` or ~~~, 3+ chars, matching the same char at
// the close) from a STRUCTURAL view. A heading-like line inside a fence
// (```# English```) is example text, not a real section boundary, so the whole
// fenced span — delimiters included — is dropped entirely. An unterminated
// fence drops everything to the end of the text (fail toward MORE stripping,
// i.e. toward a violation being reported, never toward silently accepting
// content that never left the fence).
function stripCodeBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let fenceChar = null;
  let fenceLen = 0;
  for (const line of lines) {
    if (fenceChar) {
      const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue; // drop every line inside the fence, including this close line
    }
    const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (open) {
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      continue; // drop the opening fence line itself
    }
    out.push(line);
  }
  return out.join('\n');
}

// Remove inline code spans (`...`) from a STRUCTURAL view, so a heading-shaped
// inline example (`` `# English` ``, used in this file's own fix text and in
// the template's guidance prose) is not mistaken for a real heading and so
// prose that is ENTIRELY inline code does not count as "content" for the
// language-block emptiness check. Single-backtick spans only (the template
// never uses double-backtick code spans); does not cross a newline.
function stripInlineCode(text) {
  return text.replace(/`[^`\n]*`/g, '');
}

// Raw HTML BLOCKS. Inside one, GFM parses NO markdown: a `#` line inside
// `<pre> ... </pre>` is preformatted text, not a heading. The structural view was
// blind to this, so a body of `<pre>` + a perfectly-shaped template + `</pre>`
// passed every heading, subheading, changelog and checklist check while GitHub
// rendered not one of those headings — the whole template check satisfied by text
// that is, to a reader, a code listing.
//
// Two of GFM's seven block kinds cover this:
//   type 1   <pre|script|style|textarea ...> → runs to the matching CLOSE TAG
//            line. A blank line does NOT end it.
//   type 6/7 a known block tag (<div>, <table>, <details>, ...) or any complete
//            standalone tag on its own line (<code>) → runs to the next BLANK line.
// An unterminated block eats the rest of the text — the same fail-toward-more-
// stripping direction stripCodeBlocks takes (toward reporting a violation, never
// toward accepting content that never rendered).
const HTML_BLOCK_1_OPEN = /^ {0,3}<(?:pre|script|style|textarea)\b/i;
const HTML_BLOCK_1_CLOSE = /<\/(?:pre|script|style|textarea)>/i;
const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|' +
  'dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|' +
  'head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|' +
  'p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_6_OPEN = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[ \\t/>]|$)`, 'i');
// A complete open/close tag alone on its line (GFM type 7) — this is what makes
// `<code>` / `<span>` / any custom element behave as a block opener.
const HTML_BLOCK_7_OPEN = /^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/;

function stripHtmlBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let until = null; // 'close-tag' | 'blank'
  for (const line of lines) {
    if (until === 'close-tag') {
      if (HTML_BLOCK_1_CLOSE.test(line)) until = null;
      continue;
    }
    if (until === 'blank') {
      if (line.trim() === '') {
        until = null;
        out.push(line);
      }
      continue;
    }
    if (HTML_BLOCK_1_OPEN.test(line)) {
      until = HTML_BLOCK_1_CLOSE.test(line) ? null : 'close-tag'; // may open and close on one line
      continue;
    }
    if (HTML_BLOCK_6_OPEN.test(line) || HTML_BLOCK_7_OPEN.test(line)) {
      until = 'blank';
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

// 4-space (or tab) indented code blocks: `    # English` is preformatted text,
// not a heading, for the same reason a fenced one is not. A block can only START
// where a paragraph could not be continued (top of the text, or after a blank
// line) — an indented line INSIDE a paragraph is a lazy continuation, not code,
// so the `prevBlank` guard is load-bearing rather than defensive.
function stripIndentedCode(text) {
  const lines = text.split('\n');
  const out = [];
  let prevBlank = true;
  let inCode = false;
  for (const line of lines) {
    const blank = line.trim() === '';
    const indented = /^(?: {4}|\t)/.test(line);
    if (inCode) {
      if (indented || blank) continue; // a blank line does not close an indented block
      inCode = false;
    } else if (indented && prevBlank) {
      inCode = true;
      continue;
    }
    out.push(line);
    prevBlank = blank;
  }
  return out.join('\n');
}

// The full STRUCTURAL view: everything GFM does not render as live markdown is
// gone. Order matters — comments first (they can wrap anything), then fences,
// then HTML blocks, then indented code, then inline code spans.
function structuralView(rawBody) {
  return stripInlineCode(
    stripIndentedCode(stripHtmlBlocks(stripCodeBlocks(stripHtmlComments(rawBody)))),
  );
}

// A `## Changelog` / `## Checklist` heading, exactly two hashes (`### Changelog`
// is not the section the release collector reads).
function hasHeading(text, re) {
  return re.test(text);
}

// Non-global on purpose: a /g regex carries lastIndex across .test() calls and
// would alternate true/false on repeated use.
const H1_ENGLISH = /^#[ \t]+English[ \t]*$/im;
const H1_KOREAN = /^#[ \t]+한국어[ \t]*$/m;
const H2_CHANGELOG = /^##[ \t]+Changelog[ \t]*$/im;
const H2_CHECKLIST = /^##[ \t]+Checklist[ \t]*$/im;

// The line index (0-based) of the first line matching `re` in `text`, or -1.
// Reuses the SAME heading regex as `hasHeading` (single-line `.test()` on an
// embedded-newline-free string is unaffected by the regex's /m flag), so the
// "is it present" check and the "where is it" check can never disagree about
// what counts as a heading.
function headingLineIndex(text, re) {
  const lines = text.split(/\r?\n/);
  return lines.findIndex((l) => re.test(l));
}

// The body of the section starting at the first line matching `startRe`:
// everything from the line AFTER that heading up to (not including) the first
// line matching `isBoundary`, or end of text. Returns null when the start
// heading is absent, so a caller can distinguish "missing" (reported
// elsewhere) from "present but empty" (reported here).
function sectionBody(text, startRe, isBoundary) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBoundary(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

// Any ATX heading of any level (`#` through `######`) ends a section that has
// no nested structure of its own — used for `## Changelog`, whose body is a
// flat two-line list with no subheadings.
const ANY_HEADING = (line) => /^#{1,6}[ \t]+\S/.test(line);

// A language block (`# English` / `# 한국어`) DOES have nested structure — its
// own required `##` subheadings — so those must NOT end the section (that was
// the bug: treating "any heading" as the boundary truncated every language
// block down to its first blank line, before its first subheading). Only the
// NEXT top-level heading, or the language-neutral `## Changelog` / `##
// Checklist` that follow both language blocks, closes it.
const ANY_H1 = /^#[ \t]+\S/;
const isLanguageBlockBoundary = (line) =>
  ANY_H1.test(line) || H2_CHANGELOG.test(line) || H2_CHECKLIST.test(line);

// The `## Changelog` section body: everything from its heading to the next ATX
// heading of any level (in the template, `## Checklist`) or end of text.
function changelogSection(text) {
  return sectionBody(text, H2_CHANGELOG, ANY_HEADING);
}

// A LINE-PRESERVING structural view: HTML comments and fenced code blocks are
// blanked IN PLACE (the line stays, its content is emptied) instead of removed,
// so line index i here is line index i in the RAW body. `structuralView` above
// drops lines, which is fine where only relative ORDER matters (heading checks)
// and useless where raw positions do (the changelog carve-out below).
function maskedLines(rawBody) {
  const lines = stripHtmlComments(rawBody).split('\n');
  let fence = null;
  return lines.map((line) => {
    const delim = /^[ \t]*(`{3,}|~{3,})[ \t]*/.exec(line);
    if (fence) {
      if (delim && delim[1][0] === fence.char && delim[1].length >= fence.len) fence = null;
      return '';
    }
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) {
      const open = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      fence = { char: open[1][0], len: open[1].length };
      return '';
    }
    return line;
  });
}

// Blank out the BODY of the `## Changelog` section (the heading line stays, its
// content lines become empty) so the ADR scan can read everything ELSE in the PR
// body. Line count is preserved, so a violation's reported line number still
// points at the line the author wrote.
//
// This is the ADR carve-out, and it is exactly the file gate's: CHANGELOG.md is
// ADR-exempt there, and this block IS CHANGELOG.md's source text. A `## Changelog`
// heading that only exists inside a code fence is not the real section, so the
// heading is located on the masked view, not the raw one.
function maskChangelogSection(rawBody) {
  const view = maskedLines(rawBody);
  const start = view.findIndex((l) => H2_CHANGELOG.test(l));
  if (start === -1) return rawBody;
  let end = view.length;
  for (let i = start + 1; i < view.length; i++) {
    if (ANY_HEADING(view[i])) {
      end = i;
      break;
    }
  }
  const raw = rawBody.split('\n');
  for (let i = start + 1; i < end; i++) raw[i] = '';
  return raw.join('\n');
}

// `- EN: <something>` with actual content after the colon. The unfilled template
// ships a bare `- EN:` line, which must NOT count as filled.
const EN_LINE = /^[ \t]*-[ \t]*EN:[ \t]*(\S.*)$/im;
const KO_LINE = /^[ \t]*-[ \t]*KO:[ \t]*(\S.*)$/im;
// "None" on its own line (optionally as a list item) = an explicit, deliberate
// "this change is not user-visible", which the template blesses.
const NONE_LINE = /^[ \t]*(?:[-*][ \t]*)?None[.!]?[ \t]*$/im;

// The required `##` subheadings inside each language block, per
// .github/PULL_REQUEST_TEMPLATE.md. A body that carries the H1 but skips a
// subheading (or fills none of them) has not actually followed the template —
// the prior version of this gate only checked for the H1, which a body with
// TWO bare headings and no content would still pass.
const EN_SUBHEADINGS = ['What changed', 'Why', 'How', 'Manual verification', 'Migration notes'];
const KO_SUBHEADINGS = ['변경 내용', '이유', '방법', '수동 검증', '마이그레이션 노트'];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Does `sectionText` (a language block's body, already structural-stripped)
// carry any content besides its own `##` subheading lines and blank lines? A
// block that is nothing but empty subheadings (the unfilled template shape) is
// template-compliant in STRUCTURE only, not in substance — it never actually
// says anything.
function blockHasContent(sectionText) {
  return sectionText
    .split(/\r?\n/)
    .filter((l) => !/^#{1,6}[ \t]+\S/.test(l))
    .some((l) => l.trim().length > 0);
}

const BODY_FIX =
  'Write the corrected body to a file and re-upload it: `gh pr edit <N> --body-file <file>`.';
const TITLE_FIX = 'Re-set the title: `gh pr edit <N> --title "<corrected title>"`.';

// Check one language block: subheadings all present, block not empty. Called
// only when the block's H1 heading itself is present (a missing H1 is already
// reported as a `bilingual` violation — this would just be a confusing
// duplicate of the same underlying problem).
function checkLanguageBlock(structuralBody, h1Re, h1Label, requiredSubs, violations) {
  const sec = sectionBody(structuralBody, h1Re, isLanguageBlockBoundary);
  if (sec === null) return;
  const missingSubs = requiredSubs.filter(
    (name) => !new RegExp(`^##[ \\t]+${escapeRegExp(name)}[ \\t]*$`, 'm').test(sec),
  );
  const empty = !blockHasContent(sec);
  if (missingSubs.length === 0 && !empty) return;
  const parts = [];
  if (missingSubs.length) {
    parts.push(`missing subheading(s): ${missingSubs.map((s) => `\`## ${s}\``).join(', ')}`);
  }
  if (empty) parts.push('the block has no content beyond its headings');
  violations.push({
    rule: 'template-sections',
    surface: 'body',
    detail: `\`# ${h1Label}\` block: ${parts.join('; ')}`,
    fix:
      `Fill the \`# ${h1Label}\` block using EVERY subheading from .github/PULL_REQUEST_TEMPLATE.md ` +
      `(${requiredSubs.map((s) => `\`## ${s}\``).join(', ')}), each with real content underneath — ` +
      `headings alone do not count. ` +
      BODY_FIX,
  });
}

/**
 * Check a PR's public surface.
 *
 *   checkPrSurface({ title, body }) -> { ok, violations }
 *   Violation = { rule, surface: 'title'|'body', detail, fix }
 *
 * `rule` is one of: tracker-ids, attribution, bilingual, order, template-sections,
 * changelog, checklist.
 * A missing/non-string title or body is treated as empty (a PR can genuinely have
 * an empty body — that is a structural violation, not a crash).
 */
export function checkPrSurface({ title, body } = {}) {
  // Normalize CRLF first. A body edited in the GitHub web UI comes back CRLF, and
  // the `edited` trigger this gate depends on is exactly that path — so CRLF is
  // the COMMON input here, not an edge case. The `/m` anchors below already
  // tolerate it (JS `$` matches before CR as well as LF, so a compliant CRLF body
  // does pass today), but that is a subtlety no future edit should have to know:
  // one `.*$`-style pattern added later would silently capture a trailing `\r`.
  // Dropping the CR changes no line count, so reported line numbers still match
  // the body the author submitted.
  const rawTitle = (typeof title === 'string' ? title : '').replace(/\r/g, '');
  const rawBody = (typeof body === 'string' ? body : '').replace(/\r\n/g, '\n');
  // Structural view ONLY (headings, subheadings, changelog, checklist): drop
  // everything GFM does not render as live markdown — HTML comments, fenced code,
  // raw HTML blocks, indented code, inline code. Tracker-ids and attribution scan
  // the RAW body/title — see the comment above `PR_TRACKER_PATTERNS` and the block
  // comment before `stripHtmlComments`.
  const structuralBody = structuralView(rawBody);
  const violations = [];

  // ── tracker ids + ADR pointers ─────────────────────────────────────────────
  // Reuses the file gate's scanner and pattern sets, so the two surfaces can never
  // disagree about what a tracker id is. Three passes, because the ADR set has one
  // carve-out the tracker set does not: the `## Changelog` block (see
  // PR_DECISION_PATTERNS / maskChangelogSection).
  for (const [surface, text, patterns] of [
    ['title', rawTitle, [...PR_TRACKER_PATTERNS, ...PR_DECISION_PATTERNS]],
    ['body', rawBody, PR_TRACKER_PATTERNS],
    ['body', maskChangelogSection(rawBody), PR_DECISION_PATTERNS],
  ]) {
    for (const h of scanText(text, patterns)) {
      violations.push({
        rule: 'tracker-ids',
        surface,
        detail: `${h.match} (${h.label}) at line ${h.line}: ${h.lineText.trim()}`,
        fix:
          `Delete "${h.match}" — it is a pointer into the maintainer's private wiki and resolves to ` +
          `nothing for anyone else. Say what changed in plain prose, or cite the public PR number (e.g. #123). ` +
          (surface === 'title' ? TITLE_FIX : BODY_FIX),
      });
    }
  }

  // ── attribution: raw title + RAW body (no comment-stripping exemption) ─────
  for (const [surface, text] of [
    ['title', rawTitle],
    ['body', rawBody],
  ]) {
    for (const h of scanText(text, ATTRIBUTION_PATTERNS)) {
      violations.push({
        rule: 'attribution',
        surface,
        detail: `${h.match} (${h.label}) at line ${h.line}: ${h.lineText.trim()}`,
        fix:
          `Remove the "${h.match}" ${surface === 'title' ? 'text' : 'line and the whole attribution footer'} ` +
          `(even if it is inside an HTML comment — a comment does not render, but it still ships in the body ` +
          `text) — this repo ships no tool attribution, whatever the harness default says. ` +
          (surface === 'title' ? TITLE_FIX : BODY_FIX),
      });
    }
  }

  // ── bilingual body ─────────────────────────────────────────────────────────
  const hasEnglish = hasHeading(structuralBody, H1_ENGLISH);
  const hasKorean = hasHeading(structuralBody, H1_KOREAN);
  if (!hasEnglish || !hasKorean) {
    const missing = [!hasEnglish && '`# English`', !hasKorean && '`# 한국어`'].filter(Boolean);
    violations.push({
      rule: 'bilingual',
      surface: 'body',
      detail: `missing top-level heading: ${missing.join(' and ')}`,
      fix:
        `This repo ships bilingual docs, so the PR body carries the FULL body twice: once under a ` +
        `\`# English\` heading, once under \`# 한국어\`. Copy the section layout from ` +
        `.github/PULL_REQUEST_TEMPLATE.md (\`gh pr create --body\` bypasses that template, which is why ` +
        `it is missing here — and a heading inside a code fence does not count, either). ` +
        BODY_FIX,
    });
  }

  // ── language-block sections: every required subheading present, non-empty ──
  if (hasEnglish)
    checkLanguageBlock(structuralBody, H1_ENGLISH, 'English', EN_SUBHEADINGS, violations);
  if (hasKorean)
    checkLanguageBlock(structuralBody, H1_KOREAN, '한국어', KO_SUBHEADINGS, violations);

  // ── section order: # English → # 한국어 → ## Changelog → ## Checklist ──────
  // Only compared pairwise when BOTH headings of a pair are present — a missing
  // heading is already reported above (bilingual/changelog/checklist), and
  // reporting it again here as "out of order" would just be confusing noise.
  const engIdx = headingLineIndex(structuralBody, H1_ENGLISH);
  const korIdx = headingLineIndex(structuralBody, H1_KOREAN);
  const chgIdx = headingLineIndex(structuralBody, H2_CHANGELOG);
  const chkIdx = headingLineIndex(structuralBody, H2_CHECKLIST);
  const ORDER_FIX =
    `Reorder the body to match .github/PULL_REQUEST_TEMPLATE.md: \`# English\`, then \`# 한국어\`, then the ` +
    `language-neutral \`## Changelog\`, then \`## Checklist\`. ` +
    BODY_FIX;
  for (const [aLabel, aIdx, bLabel, bIdx] of [
    ['# English', engIdx, '# 한국어', korIdx],
    ['# 한국어', korIdx, '## Changelog', chgIdx],
    ['## Changelog', chgIdx, '## Checklist', chkIdx],
  ]) {
    if (aIdx !== -1 && bIdx !== -1 && aIdx > bIdx) {
      violations.push({
        rule: 'order',
        surface: 'body',
        detail: `\`${bLabel}\` appears before \`${aLabel}\` — expected order: # English → # 한국어 → ## Changelog → ## Checklist`,
        fix: ORDER_FIX,
      });
    }
  }

  // ── changelog block ────────────────────────────────────────────────────────
  const section = changelogSection(structuralBody);
  if (section === null) {
    violations.push({
      rule: 'changelog',
      surface: 'body',
      detail: 'missing `## Changelog` section',
      fix:
        `Add a language-neutral \`## Changelog\` section after both language blocks, holding one \`- EN:\` ` +
        `line and one \`- KO:\` line describing the user-visible change (or the single word \`None\` if the ` +
        `change is internal only). The release collector builds CHANGELOG.md from this block, so without it ` +
        `the change is missing from the next release notes. Never edit CHANGELOG.md directly in a feature PR. ` +
        BODY_FIX,
    });
  } else if (!NONE_LINE.test(section)) {
    const hasEn = EN_LINE.test(section);
    const hasKo = KO_LINE.test(section);
    if (!hasEn || !hasKo) {
      const missing = [!hasEn && '`- EN:`', !hasKo && '`- KO:`'].filter(Boolean);
      violations.push({
        rule: 'changelog',
        surface: 'body',
        detail: `\`## Changelog\` present but ${missing.join(' and ')} ${
          missing.length > 1 ? 'lines are' : 'line is'
        } missing or empty`,
        fix:
          `Fill both lines under \`## Changelog\` with real text, e.g. "- EN: Add a PR surface gate." and ` +
          `"- KO: PR 표면 게이트를 추가한다." (an empty \`- EN:\` from the template does not count). If the ` +
          `change is internal only (refactor, test, CI plumbing), replace both lines with the single word ` +
          `\`None\`. No em dashes, and cite PRs by number only (e.g. #123). ` +
          BODY_FIX,
      });
    }
  }

  // ── checklist block ────────────────────────────────────────────────────────
  if (!hasHeading(structuralBody, H2_CHECKLIST)) {
    violations.push({
      rule: 'checklist',
      surface: 'body',
      detail: 'missing `## Checklist` section',
      fix:
        `Add the \`## Checklist\` section from .github/PULL_REQUEST_TEMPLATE.md after \`## Changelog\` and ` +
        `tick the boxes you actually did (npm test, npm run lint, docs updated, both language blocks written, ` +
        `no attribution footer). ` +
        BODY_FIX,
    });
  }

  return { ok: violations.length === 0, violations };
}
