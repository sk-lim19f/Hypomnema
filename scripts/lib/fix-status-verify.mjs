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

const POSITIVE_STATUSES = new Set(['merged', 'TRUE_MERGED', 'resolved']);

// Words that disqualify a line as a positive claim (case-sensitive).
// STALE_MERGED contains "MERGED" as a substring but is the opposite signal.
const NEGATIVE_STATUS_TOKENS = ['STALE_MERGED', 'partial', 'retired'];

/**
 * Parse anchor comments out of runner.mjs source text.
 *
 *   // @fix #15: all type-conditional fields present → green
 *   // @fix #15: another test name
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
  // tokens that only apply to some of them (e.g. "fix #38 (resolved); fix #41
  // (v1.3.0 advisory)" — only #38 should be picked up).
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
 *
 * Returns { ok, findings: [...] }. ok=false if any ERROR-level finding.
 * ORPHAN_ANCHOR is WARN-only.
 */
export function verifyMatrix({ anchors, status, testResults }) {
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

export { POSITIVE_STATUSES, NEGATIVE_STATUS_TOKENS };
