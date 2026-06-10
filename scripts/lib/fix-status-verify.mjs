/**
 * fix-status-verify (lib) — pure functions for verifying fix→test linkage.
 *
 * Phase 1 of CLAUDE.md learned_behavior #6 (2026-05-16): "merged 표기 전
 * (1) ADR 핵심 결정 라인 grep + (2) replay/integration test green 양쪽 충족".
 * This module automates the *test green* half. ADR core decision grep is out
 * of scope (Phase 2 / v1.3.0 manifest PR).
 *
 * SoT split (after codex 3-worker review 2026-05-27):
 *  - fix→test mapping SoT: `// @fix #N: <full test name>` anchor comments in
 *    tests/runner.mjs (sits next to the assertion that verifies the fix).
 *  - fix status SoT: wiki spec-v1.2.md word-boundary grep
 *    (\bfix\s*#N\b ... \b(TRUE_MERGED|merged|resolved)\b).
 *
 * Word-boundary on status terms is required so STALE_MERGED / partial /
 * retired are NOT matched as positive claims.
 */

import { parseFrontmatter } from './frontmatter.mjs';

const POSITIVE_STATUSES = new Set(['merged', 'TRUE_MERGED', 'resolved']);

// Words that disqualify a line as a positive claim (case-sensitive).
// STALE_MERGED contains "MERGED" as a substring but is the opposite signal.
const NEGATIVE_STATUS_TOKENS = ['STALE_MERGED', 'partial', 'retired'];

/**
 * Parse anchor comments out of runner.mjs source text.
 *
 *   // @fix #N: all type-conditional fields present → green
 *   // @fix #N: another test name
 *
 * The `@fix` prefix is mandatory — distinguishes anchors from prose comments
 * that mention "fix #N" in passing. Each anchor line maps ONE fix # to ONE
 * test name (whole captured group is the name, no comma-splitting). Multiple
 * anchors for the same fix # accumulate (union, order-preserving, dedupe).
 *
 * Sentinel: NAME = "NO_AUTO_TEST" declares the fix has no automated test by
 * design (behavioral / prompt-driven). Verified upstream in verifyMatrix.
 */
export function parseAnchors(runnerText) {
  const out = new Map();
  const re = /^\s*\/\/\s*@fix\s*#(\d+)\s*:\s*(.+?)\s*$/gim;
  let m;
  while ((m = re.exec(runnerText)) !== null) {
    const fixNum = Number(m[1]);
    const name = m[2].trim();
    if (!name) continue;
    if (!out.has(fixNum)) out.set(fixNum, []);
    const list = out.get(fixNum);
    if (!list.includes(name)) list.push(name);
  }
  return out;
}

/**
 * Detect a redirect-stub spec: a page whose frontmatter declares
 * `type: reference`. These are placeholders left behind after an archive move
 * (e.g. spec-v1.2.md → archive/spec-v1.2.md) and carry zero fix-status claims.
 * Pointing the verifier at one yields a vacuous green, so verifyMatrix rejects
 * it up front.
 */
export function isReferenceStub(specText) {
  const fm = parseFrontmatter(specText);
  return fm?.type === 'reference';
}

/**
 * Parse fix status claims out of wiki spec-v1.2.md.
 *
 * Returns Map<fixNum:number, status:string>. status is the most recent
 * positive status token in the file (last mention wins so `merged → resolved`
 * narrative normalises to `resolved`). Fixes whose only mentions are negative
 * (STALE_MERGED / partial / retired) are NOT added — they're considered
 * incomplete claims and skipped by verifyMatrix.
 */
export function parseStatus(specText) {
  const out = new Map();
  // For each line, find every fix # mention and check whether a positive
  // status token sits within a small proximity window AFTER the mention. This
  // avoids false positives when a line mentions multiple fix #s with status
  // tokens that only apply to some of them (e.g. a line where the first
  // mention is "(resolved)" and a later one is "(advisory)" — only the first
  // should be picked up).
  const lines = specText.split('\n');
  const PROXIMITY = 120; // chars after fix # to scan for status
  for (const line of lines) {
    // Quick reject: line must mention a positive status token at all.
    const hasPositive =
      /\bTRUE_MERGED\b/.test(line) ||
      /\bresolved\b/.test(line) ||
      /(?<![A-Z_])merged(?![A-Z_])/.test(line);
    if (!hasPositive) continue;
    // Two accepted fix # forms:
    //   (a) inline prose: "fix #N" (word-boundary)
    //   (b) table cell start: "| #N |" (§9.1.0 status correction table)
    const matches = [];
    let m2;
    const inlineRe = /\bfix\s*#(\d+)\b/gi;
    while ((m2 = inlineRe.exec(line)) !== null) {
      matches.push({ fixNum: Number(m2[1]), end: m2.index + m2[0].length });
    }
    const tableRe = /\|\s*#(\d+)\s*\|/g;
    while ((m2 = tableRe.exec(line)) !== null) {
      matches.push({ fixNum: Number(m2[1]), end: m2.index + m2[0].length });
    }
    for (const { fixNum, end } of matches) {
      const window = line.slice(end, end + PROXIMITY);
      // Determine the strongest status in the proximity window. Priority:
      // TRUE_MERGED > resolved > merged.
      let status = null;
      if (/\bTRUE_MERGED\b/.test(window)) status = 'TRUE_MERGED';
      else if (/\bresolved\b/.test(window)) status = 'resolved';
      else if (/(?<![A-Z_])merged(?![A-Z_])/.test(window)) status = 'merged';
      if (status) out.set(fixNum, status); // last positive mention wins
    }
  }
  return out;
}

/**
 * Parse runner.mjs stdout to map test names → "pass" | "fail".
 *
 * The harness prints `  ✓ <name>` on pass and `  ✗ <name>` on fail.
 */
export function parseRunnerOutput(stdout) {
  const out = new Map();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const passM = line.match(/^\s*✓\s+(.+?)\s*$/);
    if (passM) {
      // Sticky pass — only set if no prior result. A later fail must NOT be
      // overridden, and a prior fail must not be flipped back to pass.
      if (!out.has(passM[1])) out.set(passM[1], 'pass');
      continue;
    }
    const failM = line.match(/^\s*✗\s+(.+?)\s*$/);
    if (failM) {
      // Fail is sticky: once a name has any failure, the verdict stays fail
      // even if a duplicate test() with the same name passed elsewhere.
      out.set(failM[1], 'fail');
    }
  }
  return out;
}

/**
 * Cross-check anchors × status × test results.
 *
 * Finding classes:
 *   NO_ANCHOR       — fix claimed positive in spec, no anchor in runner.
 *   MISSING_TEST    — anchor names a test, runner output does not contain it.
 *   FAILING_TEST    — anchor names a test, runner output marks it failed.
 *   ORPHAN_ANCHOR   — anchor exists, no positive status claim in spec (warn).
 *   STUB_SPEC       — spec is unusable: a `type: reference` redirect stub, or
 *                     it parses zero positive status claims while anchors exist
 *                     (the vacuous-gate the tool exists to prevent). Error.
 *
 * Returns { ok, findings: [...] }. ok=false if any ERROR-level finding.
 * ORPHAN_ANCHOR is WARN-only.
 *
 * STUB_SPEC is a precondition failure, so it short-circuits: when the spec is
 * unusable there is nothing meaningful to cross-check, and the per-anchor
 * ORPHAN noise would only bury the one decisive error.
 */
export function verifyMatrix({ anchors, status, testResults, specIsStub = false }) {
  if (specIsStub) {
    return {
      ok: false,
      findings: [
        {
          level: 'error',
          class: 'STUB_SPEC',
          detail:
            'spec is a `type: reference` redirect stub (0 fix-status claims by design) — pass --spec pointing at the real spec',
        },
      ],
    };
  }
  // Vacuous-gate invariant: anchors exist in the runner but the spec yields no
  // positive status claim to verify them against. Greening here would defeat
  // the tool's purpose. (No anchors + no claims is an empty/custom matrix, not
  // a vacuous gate, so it is left to the normal path.)
  if (status.size === 0 && anchors.size > 0) {
    return {
      ok: false,
      findings: [
        {
          level: 'error',
          class: 'STUB_SPEC',
          detail: `${anchors.size} anchor(s) in runner but 0 positive status claims parsed from spec — gate would be vacuous`,
        },
      ],
    };
  }

  const findings = [];

  for (const [fixNum, statusValue] of status.entries()) {
    const anchored = anchors.get(fixNum);
    if (!anchored || anchored.length === 0) {
      findings.push({
        level: 'error',
        class: 'NO_ANCHOR',
        fixNum,
        status: statusValue,
        detail: `claimed ${statusValue} in spec but no // fix #${fixNum}: anchor in runner.mjs`,
      });
      continue;
    }
    // Sentinel: explicit "no automated test by design" (behavioral /
    // prompt-driven fixes). The fix is still claimed-merged but verifying it
    // is out of scope for an integration runner.
    if (anchored.length === 1 && anchored[0] === 'NO_AUTO_TEST') {
      findings.push({
        level: 'info',
        class: 'NO_AUTO_TEST',
        fixNum,
        status: statusValue,
        detail: `fix #${fixNum} declares NO_AUTO_TEST (behavioral / prompt-driven)`,
      });
      continue;
    }
    for (const testName of anchored) {
      const result = testResults.get(testName);
      if (result === undefined) {
        findings.push({
          level: 'error',
          class: 'MISSING_TEST',
          fixNum,
          status: statusValue,
          testName,
          detail: `anchor names "${testName}" but no such test ran`,
        });
      } else if (result === 'fail') {
        findings.push({
          level: 'error',
          class: 'FAILING_TEST',
          fixNum,
          status: statusValue,
          testName,
          detail: `test "${testName}" failed`,
        });
      }
    }
  }

  for (const [fixNum, names] of anchors.entries()) {
    if (!status.has(fixNum)) {
      findings.push({
        level: 'warn',
        class: 'ORPHAN_ANCHOR',
        fixNum,
        tests: names,
        detail: `anchor exists for fix #${fixNum} but no positive status claim in spec`,
      });
    }
  }

  const ok = !findings.some((f) => f.level === 'error');
  return { ok, findings };
}

// ── Phase 2 (A-sot) — manifest validation, coverage/drift, ADR-line grep ─────
// ADR 0036: manifest is the evidence SoT (fix → test + ADR-line). status SoT
// stays in the spec. These are pure functions; the CLI injects fs-backed
// searchFn / adrExistsFn so the corpus walk stays out of the pure layer.

import { FIX_MANIFEST, NO_ADR, NO_AUTO_TEST } from './fix-manifest.mjs';

/** Order-insensitive set equality over string arrays (deduped). */
function sameStringSet(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * Structural validation of the manifest shape (ADR 0036).
 *
 * Findings (all error):
 *   MANIFEST_DUP_FIXID       — two rows share a fixId.
 *   MANIFEST_EMPTY_TESTS     — testNames is empty.
 *   MANIFEST_SENTINEL_MIX    — NO_AUTO_TEST mixed with real test names.
 *   MANIFEST_EMPTY_KEYLINE   — adrKeyLine missing/blank.
 *   MANIFEST_NO_ADR_SHAPE    — NO_ADR row with non-null adrPath, or a non-NO_ADR
 *                              row with null adrPath.
 */
export function validateManifest(manifest = FIX_MANIFEST) {
  const findings = [];
  const seen = new Set();
  for (const row of manifest) {
    const fixNum = row.fixId;
    if (seen.has(fixNum)) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_DUP_FIXID',
        fixNum,
        detail: `duplicate manifest row for fix #${fixNum}`,
      });
    }
    seen.add(fixNum);

    const names = Array.isArray(row.testNames) ? row.testNames : [];
    if (names.length === 0) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_EMPTY_TESTS',
        fixNum,
        detail: `fix #${fixNum} manifest row has empty testNames`,
      });
    }
    if (names.includes(NO_AUTO_TEST) && names.length > 1) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_SENTINEL_MIX',
        fixNum,
        detail: `fix #${fixNum} mixes NO_AUTO_TEST sentinel with real test names`,
      });
    }

    const keyLine = typeof row.adrKeyLine === 'string' ? row.adrKeyLine.trim() : '';
    if (!keyLine) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_EMPTY_KEYLINE',
        fixNum,
        detail: `fix #${fixNum} manifest row has empty adrKeyLine`,
      });
      continue;
    }
    const isNoAdr = row.adrKeyLine === NO_ADR;
    if (isNoAdr && row.adrPath != null) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_NO_ADR_SHAPE',
        fixNum,
        detail: `fix #${fixNum} is NO_ADR but adrPath is not null`,
      });
    }
    if (!isNoAdr && row.adrPath == null) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_NO_ADR_SHAPE',
        fixNum,
        detail: `fix #${fixNum} has a real adrKeyLine but null adrPath`,
      });
    }
  }
  return findings;
}

/**
 * Coverage + drift between manifest, runner anchors, and spec status claims.
 *
 *   MANIFEST_MISSING_ROW  — a fix claimed-merged AND anchored has no manifest
 *                           row (its ADR-line check would be silently skipped).
 *                           Error: a missing row bypasses the whole gate.
 *   MANIFEST_TEST_DRIFT   — a manifest row's testNames do not set-equal the
 *                           runner anchors for that fix (stale evidence).
 *
 * Both error-level. The claimed∩anchored requirement mirrors the manifest
 * scope (ADR 0036): rows exist to prove claims; anchors-without-claims are
 * ORPHAN_ANCHOR (handled in verifyMatrix), not manifest gaps.
 */
export function checkManifestCoverage({ manifest = FIX_MANIFEST, anchors, status }) {
  const findings = [];
  const byFix = new Map(manifest.map((r) => [r.fixId, r]));

  for (const fixNum of status.keys()) {
    if (!anchors.has(fixNum)) continue; // claimed but unanchored → NO_ANCHOR (verifyMatrix)
    if (!byFix.has(fixNum)) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_MISSING_ROW',
        fixNum,
        detail: `fix #${fixNum} is claimed-merged and anchored but has no manifest row`,
      });
    }
  }

  for (const row of manifest) {
    const fixNum = row.fixId;
    const anchored = anchors.get(fixNum) || [];
    const names = Array.isArray(row.testNames) ? row.testNames : [];
    if (!sameStringSet(names, anchored)) {
      findings.push({
        level: 'error',
        class: 'MANIFEST_TEST_DRIFT',
        fixNum,
        detail:
          `fix #${fixNum} manifest testNames ${JSON.stringify(names)} ` +
          `≠ runner anchors ${JSON.stringify(anchored)}`,
      });
    }
  }
  return findings;
}

/**
 * ADR-line grep: each non-NO_ADR manifest row must point at an existing ADR
 * file and its adrKeyLine must exist verbatim in the production-code corpus.
 *
 *   ADR_PATH_MISSING   — adrPath does not resolve to a file.
 *   ADR_LINE_MISSING   — adrKeyLine not found in the corpus (fixed-string).
 *
 * searchFn(literal) → boolean: true iff the literal appears in the corpus
 * (the corpus MUST exclude scripts/lib/fix-manifest.mjs, else every line
 * self-matches and the gate is vacuous — see the CLI corpus builder).
 * adrExistsFn(adrPath) → boolean. NO_ADR rows are skipped (test-green only).
 */
export function checkAdrLines({ manifest = FIX_MANIFEST, searchFn, adrExistsFn }) {
  const findings = [];
  for (const row of manifest) {
    if (row.adrKeyLine === NO_ADR) continue;
    const fixNum = row.fixId;
    if (row.adrPath != null && !adrExistsFn(row.adrPath)) {
      findings.push({
        level: 'error',
        class: 'ADR_PATH_MISSING',
        fixNum,
        detail: `fix #${fixNum} adrPath does not resolve: ${row.adrPath}`,
      });
    }
    if (!searchFn(row.adrKeyLine)) {
      findings.push({
        level: 'error',
        class: 'ADR_LINE_MISSING',
        fixNum,
        detail: `fix #${fixNum} adrKeyLine not found in production corpus: "${row.adrKeyLine}"`,
      });
    }
  }
  return findings;
}

export { POSITIVE_STATUSES, NEGATIVE_STATUS_TOKENS, FIX_MANIFEST, NO_ADR, NO_AUTO_TEST };
