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

// Section model (changelog-pr-guide format.md §1/§2). A version block carries
// gated sections, each split into "#### English" / "#### 한국어" sub-blocks at
// and after the Korean cutoff. Highlights is gated too (it has a curated Korean
// half); Changelog and the migration callout are NOT gated (language-neutral).
export const GATED_HEADINGS = ['Highlights', 'New Features', 'Bug Fixes', 'Chores'];

// Korean-summary cutoff: 1.2.0 is the first release that shipped a Korean half
// (empirically the first "### 한글 요약" in CHANGELOG.md). 1.0.0–1.1.0 are
// English-only; we never fabricate a Korean half for them (format.md §9).
export const KOREAN_CUTOFF = [1, 2, 0];

// Parse "major.minor.patch" (ignoring any prerelease/build suffix) into a number
// triple, or null if it does not look like semver.
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Is `version` at or past the Korean cutoff (>= 1.2.0)? A prerelease of a
// cutoff version (1.2.0-rc.1) counts as in-era. Unparseable → treated as not
// meeting the cutoff (the gate then only checks English presence).
export function meetsKoreanCutoff(version) {
  const s = parseSemver(version);
  if (!s) return false;
  for (let i = 0; i < 3; i++) {
    if (s[i] !== KOREAN_CUTOFF[i]) return s[i] > KOREAN_CUTOFF[i];
  }
  return true;
}

// Split `lines` into the sections introduced by a heading of exactly `hashes`
// '#'. A section ends at the next same-level heading OR any higher-level (fewer
// '#') heading; a deeper heading (more '#') stays inside the section body. So
// slicing a version block at level 3 keeps each "### Section" with its nested
// "#### English/한국어" lines, and re-slicing a section at level 4 yields those
// sub-blocks. Returns [{ title, body: string[] }].
function sliceSections(lines, hashes) {
  const headRe = new RegExp(`^#{${hashes}} (.+?)\\s*$`);
  const sameOrHigherRe = new RegExp(`^#{1,${hashes}} `);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = headRe.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { title: m[1].trim(), body: [] };
      continue;
    }
    if (cur) {
      // a same-or-higher level heading (that is not our own level) closes the
      // open section without opening a tracked one.
      if (sameOrHigherRe.test(line)) {
        out.push(cur);
        cur = null;
        continue;
      }
      cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// List the versions a CHANGELOG documents, in file order (skips "Unreleased").
export function listChangelogVersions(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const re = /^## \[([^\]]+)\](\s.*)?$/;
  const out = [];
  for (const l of lines) {
    const m = re.exec(l);
    if (m && m[1] !== 'Unreleased') out.push(m[1]);
  }
  return out;
}

/**
 * Validate one CHANGELOG version block against the section model.
 *
 * At/after the Korean cutoff (>= 1.2.0): the block must carry at least one gated
 * section, and EVERY gated section present must hold both a "#### English" and a
 * "#### 한국어" sub-block, the Korean one non-empty, with the version's total
 * Korean >= HANGUL_BODY_THRESHOLD. Before the cutoff (1.0.0–1.1.0): English-only
 * era — the block need only carry content; no Korean is required or fabricated.
 *
 * @param {string} content  CHANGELOG.md raw content (CRLF tolerated).
 * @param {string} version  Semver string to look up (e.g. "1.2.1").
 * @returns {{ok: true, hangulCount: number, koreanExempt?: boolean} | {ok: false, reason: string}}
 */
export function validateChangelog(content, version) {
  if (!version) return { ok: false, reason: 'no version supplied' };
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const versionEsc = escapeRegex(version);
  // Anchor closing bracket so 1.2.1 does NOT match the prefix of 1.2.10.
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
  const blockLines = lines.slice(start + 1, sectionEnd);
  const sections = sliceSections(blockLines, 3);
  const gated = sections.filter((s) => GATED_HEADINGS.includes(s.title));

  if (!meetsKoreanCutoff(version)) {
    // Pre-cutoff English-only era: require content (a non-heading body line),
    // never a Korean half.
    const hasContent = blockLines.some((l) => l.trim() && !/^#/.test(l));
    if (!hasContent) {
      return { ok: false, reason: `section [${version}] has no content` };
    }
    return { ok: true, hangulCount: 0, koreanExempt: true };
  }

  // Cutoff+: enforce the per-section bilingual structure.
  if (gated.length === 0) {
    return {
      ok: false,
      reason:
        `section [${version}] has no gated section ` +
        `(one of ${GATED_HEADINGS.join(' / ')} is required at >= 1.2.0)`,
    };
  }
  let total = 0;
  for (const sec of gated) {
    const subs = sliceSections(sec.body, 4);
    const hasEnglish = subs.some((s) => s.title === 'English');
    const korean = subs.find((s) => s.title === '한국어');
    if (!hasEnglish) {
      return { ok: false, reason: `[${version}] "${sec.title}" missing "#### English" sub-block` };
    }
    if (!korean) {
      return { ok: false, reason: `[${version}] "${sec.title}" missing "#### 한국어" sub-block` };
    }
    const koCount = countHangul(korean.body.join('\n'));
    if (koCount < 1) {
      return {
        ok: false,
        reason: `[${version}] "${sec.title}" "#### 한국어" has no Korean text (heading alone does not count)`,
      };
    }
    total += koCount;
  }
  if (total < HANGUL_BODY_THRESHOLD) {
    return {
      ok: false,
      reason:
        `section [${version}] total Korean is ${total} Hangul chars ` +
        `(threshold: ${HANGUL_BODY_THRESHOLD}). Write real Korean summaries in the "#### 한국어" sub-blocks.`,
    };
  }
  return { ok: true, hangulCount: total };
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
