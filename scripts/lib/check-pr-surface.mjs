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
import {
  heading,
  stripHtmlComments,
  changelogSection,
  parseChangelogBody,
  H1_ENGLISH,
  H1_KOREAN,
  H2_CHANGELOG,
  H2_CHECKLIST,
} from './pr-body.mjs';

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

// The STRUCTURAL view: HTML comments, fenced code, and inline code spans are
// gone. Order matters: comments first (they can wrap anything), then fences,
// then inline spans.
//
// This view deliberately does NOT model raw HTML blocks or 4-space indented code
// blocks, and that is a reversal. Earlier rounds grew a GFM block parser here (a
// 60-tag list, HTML block types 1/6/7, an indented-code state machine with a
// lazy-continuation guard) chasing rendering fidelity: a body wrapped in `<pre>`
// renders as a code listing, so its `#` lines are not really headings, so the
// template check should not count them. Every round of that produced a new edge
// case (block types 3-5, `&Tab;`, entity-encoded tags) and no round ended.
//
// It was aimed at the wrong actor. This gate is maintainer-only tooling (it does
// not ship — see package.json `files`), and it runs on trusted input: this repo's
// CI and the maintainer's local hooks. The thing it exists to stop is an agent
// obeying its harness and appending an attribution trailer, or pasting a private
// wiki tracker id. Nobody is trying to evade it. A PR body wrapped in `<div>`
// therefore now SATISFIES the template check, and that is fine: it is self-harm,
// not a failure mode, and no agent does it by accident. The banned-string scan is
// unaffected, because it reads the RAW body — an attribution trailer inside
// `<pre>` is still rejected.
//
// What replaced the indented-code machine is the ` {0,3}` bound on every heading
// matcher below, which is where GFM actually draws the line: 0-3 spaces is an ATX
// heading, 4+ is code. That bound is load-bearing in the OTHER direction too. See
// the note on H1_ENGLISH.
function structuralView(rawBody) {
  return stripInlineCode(stripCodeBlocks(stripHtmlComments(rawBody)));
}

// A `## Changelog` / `## Checklist` heading, exactly two hashes (`### Changelog`
// is not the section the release collector reads).
function hasHeading(text, re) {
  return re.test(text);
}

// The heading matchers, the live-line view, and the changelog parse all come from
// lib/pr-body.mjs, because the release collector asks the same questions of the
// same text and its answers must be THESE answers. When the two had their own
// copies they drifted, and the drift was silent: the gate went green on a body
// whose changelog block the collector then failed to find (or found in a code
// fence, and shipped the example). See that module's header.

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

// A language block (`# English` / `# 한국어`) DOES have nested structure — its
// own required `##` subheadings — so those must NOT end the section (that was
// the bug: treating "any heading" as the boundary truncated every language
// block down to its first blank line, before its first subheading). Only the
// NEXT top-level heading, or the language-neutral `## Changelog` / `##
// Checklist` that follow both language blocks, closes it.
const ANY_H1 = /^ {0,3}#[ \t]+\S/;
const isLanguageBlockBoundary = (line) =>
  ANY_H1.test(line) || H2_CHANGELOG.test(line) || H2_CHECKLIST.test(line);

// Blank out the BODY of the `## Changelog` section (the heading line stays, its
// content lines become empty) so the ADR scan can read everything ELSE in the PR
// body. Line count is preserved, so a violation's reported line number still
// points at the line the author wrote.
//
// This is the ADR carve-out, and it is exactly the file gate's: CHANGELOG.md is
// ADR-exempt there, and this block IS CHANGELOG.md's source text. Its boundaries
// come from the shared reader, so the span exempted here is EXACTLY the span the
// collector will publish — no more (an ADR pointer outside the block would escape
// the scan) and no less.
function maskChangelogSection(rawBody) {
  const sec = changelogSection(rawBody);
  if (sec === null) return rawBody;
  const raw = rawBody.split('\n');
  for (let i = sec.start + 1; i < sec.end; i++) raw[i] = '';
  return raw.join('\n');
}

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
    .filter((l) => !/^ {0,3}#{1,6}[ \t]+\S/.test(l))
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
  const missingSubs = requiredSubs.filter((name) => !heading('##', escapeRegExp(name)).test(sec));
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
  // Structural view ONLY (headings, subheadings, changelog, checklist): HTML
  // comments, fenced code and inline code spans dropped, so a heading that only
  // exists as an EXAMPLE is not mistaken for a real section. Raw HTML blocks and
  // indented code are deliberately NOT modeled — see the note on `structuralView`.
  // Tracker-ids and attribution scan the RAW body/title instead, so nothing hidden
  // in a comment or a code block escapes them.
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
  // Judged with the release collector's OWN parse, on the RAW body, so a green
  // gate means exactly "the collector will publish this". The gate used to apply
  // its own, looser rules here, and the two disagreed: `None.` with a period, a
  // duplicated `- EN:` line — the gate waved them through and the collector then
  // called them malformed, at release time, when the PR could no longer be edited.
  // The author is told now, while it is still one `gh pr edit` away.
  const changelog = parseChangelogBody(rawBody);
  if (changelog === null) {
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
  } else if (changelog.malformed) {
    violations.push({
      rule: 'changelog',
      surface: 'body',
      detail: `\`## Changelog\` is present but the release collector cannot read it: ${changelog.reason}`,
      fix:
        `Fix the block so it holds exactly one \`- EN:\` line and one \`- KO:\` line, each with real text — ` +
        `e.g. "- EN: Add a PR surface gate." and "- KO: PR 표면 게이트를 추가한다." (an empty \`- EN:\` from ` +
        `the template does not count). If the change is internal only (refactor, test, CI plumbing), the whole ` +
        `block is the single word \`None\` instead, with no EN/KO lines beside it. This is the same parse the ` +
        `release collector runs, so what passes here is what lands in CHANGELOG.md. No em dashes, and cite PRs ` +
        `by number only (e.g. #123). ` +
        BODY_FIX,
    });
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
