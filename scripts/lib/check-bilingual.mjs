/**
 * lib/check-bilingual.mjs — pure validators for the bilingual release-doc rule.
 *
 * Rule source: CLAUDE.md learned_behaviors release-doc-bilingual (2026-05-24).
 * Every Hypomnema OSS ship must carry an English body PLUS a Korean summary
 * block in both the CHANGELOG section and the git tag annotation. This module
 * exports the parsing/validation primitives; the CLI wrapper in
 * scripts/check-bilingual.mjs handles I/O and exit codes.
 *
 * Scope (deliberate): this gate only enforces the KOREAN half. The English
 * half has been historically present in every ship — the rule exists because
 * the Korean half is what gets silently dropped under time pressure (see
 * release-doc-bilingual feedback page). A tag body of "---" + Korean with an
 * empty English section would technically pass these validators, but that's
 * acceptable because such a body is not a realistic failure mode for a
 * maintainer who already wrote the English release notes. If "English missing"
 * ever becomes a real regression vector, add an English-half threshold.
 *
 * Why pure functions: lets tests/runner.mjs construct synthetic CHANGELOG /
 * tag-body strings without touching real git or real CHANGELOG.md.
 */

// AC00–D7A3 covers all precomposed Hangul syllables. We NFC-normalize the
// input before counting so jamo-only inputs (decomposed) still match after
// composition.
export const HANGUL_RE = /[가-힣]/g;
export const HANGUL_BODY_THRESHOLD = 10;

export function countHangul(text) {
  return (text.normalize('NFC').match(HANGUL_RE) || []).length;
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate that CHANGELOG.md content has a "## [<version>]" section containing
 * a "### 한글 요약" sub-section with >= HANGUL_BODY_THRESHOLD Hangul chars.
 *
 * @param {string} content  CHANGELOG.md raw content (CRLF tolerated).
 * @param {string} version  Semver string to look up (e.g. "1.2.1").
 * @returns {{ok: true, hangulCount: number} | {ok: false, reason: string}}
 */
export function validateChangelog(content, version) {
  if (!version) return { ok: false, reason: 'no version supplied' };
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const versionEsc = escapeRegex(version);
  // Anchor closing bracket so 1.2.1 does NOT match the prefix of 1.2.10.
  // Allow trailing " - YYYY-MM-DD" or nothing.
  const sectionRe = new RegExp(`^## \\[${versionEsc}\\](\\s.*)?$`);

  const startIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (sectionRe.test(lines[i])) startIndices.push(i);
  }
  if (startIndices.length === 0) {
    return { ok: false, reason: `no "## [${version}]" section in CHANGELOG.md` };
  }
  if (startIndices.length > 1) {
    return {
      ok: false,
      reason: `duplicate "## [${version}]" sections (${startIndices.length}) in CHANGELOG.md`,
    };
  }

  const start = startIndices[0];
  let sectionEnd = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  const sectionLines = lines.slice(start, sectionEnd);

  const koreanHeadIdx = sectionLines.findIndex((l) => l.trim() === '### 한글 요약');
  if (koreanHeadIdx === -1) {
    return { ok: false, reason: `section [${version}] missing "### 한글 요약" sub-section` };
  }

  // Bound the Korean block: stop at the next H2 OR H3. CHANGELOG.md has
  // sibling H3s like "### Internal", "### Fixed" — Hangul in those sections
  // does not count toward the "### 한글 요약" requirement.
  let koreanEnd = sectionLines.length;
  for (let i = koreanHeadIdx + 1; i < sectionLines.length; i++) {
    if (/^(##|###) /.test(sectionLines[i])) {
      koreanEnd = i;
      break;
    }
  }
  const body = sectionLines.slice(koreanHeadIdx + 1, koreanEnd).join('\n');
  const count = countHangul(body);
  if (count < HANGUL_BODY_THRESHOLD) {
    return {
      ok: false,
      reason:
        `section [${version}] "### 한글 요약" body has ${count} Hangul chars ` +
        `(threshold: ${HANGUL_BODY_THRESHOLD}). Heading alone does not count — write real Korean summary.`,
    };
  }
  return { ok: true, hangulCount: count };
}

/**
 * Validate that a git tag annotation body has a "---" separator with Korean
 * text after the LAST such separator. Tolerates earlier "---" markdown
 * horizontal rules in the English body.
 *
 * @param {string} body  Tag annotation body, as returned by
 *                       `git tag -l --format='%(contents)' <ref>`.
 * @returns {{ok: true, hangulCount: number} | {ok: false, reason: string}}
 */
export function validateTagBody(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let lastSepIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '---') {
      lastSepIdx = i;
      break;
    }
  }
  if (lastSepIdx === -1) {
    return {
      ok: false,
      reason:
        'tag annotation has no "---" separator line (expected: English body + "---" + Korean)',
    };
  }
  const tail = lines.slice(lastSepIdx + 1).join('\n');
  const count = countHangul(tail);
  if (count < HANGUL_BODY_THRESHOLD) {
    return {
      ok: false,
      reason:
        `tag body after the last "---" has only ${count} Hangul chars ` +
        `(threshold: ${HANGUL_BODY_THRESHOLD}). Write a real Korean summary after the separator.`,
    };
  }
  return { ok: true, hangulCount: count };
}
