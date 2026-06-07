/**
 * fix-manifest — evidence mapping for claimed-merged fixes (Phase 2, A-sot).
 *
 * ADR 0036: this module is the *evidence* SoT (fix → test + ADR-line), NOT the
 * *status* SoT. "Is fix N merged?" is answered solely by the wiki spec
 * (parseStatus). A manifest row says "if the spec claims N merged, here is the
 * test that proves the behavior and the production-code line that proves the
 * ADR's core decision shipped."
 *
 * Shape (ADR 0036 decision 2 — NO `status` field):
 *   { fixId:number, testNames:string[], adrPath:string|null, adrKeyLine:string }
 *
 *  - testNames: MUST set-equal the `// @fix #N:` anchors in tests/runner.mjs
 *    (drift is an error — MANIFEST_TEST_DRIFT). Multiple anchors → multiple
 *    names. The NO_AUTO_TEST sentinel is the ONLY allowed lone entry; it may
 *    not be mixed with real test names.
 *  - adrPath: path (relative to the wiki root) of the ADR whose core decision
 *    this fix implements. `null` iff adrKeyLine is the NO_ADR sentinel.
 *  - adrKeyLine: a maintainer-curated literal that embodies the fix's shipped
 *    decision and exists verbatim in production code (scripts/ hooks/ commands/
 *    skills/ templates/). Verified by fixed-string grep — 0 hits is
 *    ADR_LINE_MISSING. The NO_ADR sentinel exempts a fix that has no ADR (small
 *    / doctor fixes); the test-green check still applies. NO_ADR is NOT for
 *    fixes that have an ADR but whose evidence lives outside the corpus.
 *
 * Coverage contract: every fix that is BOTH claimed-merged in the spec AND
 * anchored in the runner must have exactly one row here (MANIFEST_MISSING_ROW
 * is an error). Fixes anchored but not claimed (e.g. #18) are ORPHAN_ANCHOR
 * warnings and need no row.
 *
 * Corpus note (spec §A amendment, 2026-06-07): the ADR-line grep corpus is
 * scripts/ hooks/ commands/ skills/ AND templates/. templates/ ships via npm
 * `files`, so prompt-driven fixes whose decision is installed as template text
 * (e.g. #20 proactive close offer) are honestly verifiable there.
 */

export const NO_ADR = 'NO_ADR';
export const NO_AUTO_TEST = 'NO_AUTO_TEST';

export const FIX_MANIFEST = [
  {
    fixId: 15,
    testNames: ['all type-conditional fields present → green'],
    adrPath: 'decisions/0030-hypoignore-enforce-all-injection-hooks.md',
    adrKeyLine: 'isIgnored(path, HYPO_DIR, patterns)',
  },
  {
    fixId: 17,
    testNames: [
      '5 mandatory memory files fresh → suppressOutput:true',
      'project hot.md not updated today → block, reason names the file',
      'open-questions.md absent/stale → still passes (conditional, not gated)',
    ],
    adrPath: 'decisions/0022-session-close-ux-automation.md',
    adrKeyLine: 'sessionCloseFileStatus',
  },
  {
    // Behavioral / prompt-driven: no automated test, evidence is the installed
    // template prompt (templates/hypo-guide.md). Has an ADR (0022), so NOT
    // NO_ADR — the adrKeyLine greps the shipped template text.
    fixId: 20,
    testNames: [NO_AUTO_TEST],
    adrPath: 'decisions/0022-session-close-ux-automation.md',
    adrKeyLine: '이 작업이 마무리되었나요? 세션을 정리(crystallize)할까요?',
  },
  {
    fixId: 25,
    testNames: [
      'replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE',
    ],
    adrPath: 'decisions/0022-session-close-ux-automation.md',
    adrKeyLine: '[WIKI_AUTOCLOSE]',
  },
  {
    // Removal fix (capacity bypass deleted). The shipped evidence is the
    // deliberate removal-marker comment + the negative-control test.
    fixId: 26,
    testNames: [
      'replay-personal-check-bypass-order: wiki-context-critical.json does NOT bypass (fix #26 negative control)',
    ],
    adrPath: 'decisions/0022-session-close-ux-automation.md',
    adrKeyLine: 'Capacity bypass (≥90%) REMOVED — fix #26',
  },
  {
    fixId: 27,
    testNames: [
      'replay-auto-minimal-crystallize-on-incomplete-close: mutating + no marker + close-intent → block',
      'replay-auto-minimal-crystallize-on-incomplete-close: valid marker → continue (even with close-intent)',
    ],
    adrPath: 'decisions/0022-session-close-ux-automation.md',
    adrKeyLine: 'The hook NEVER writes the marker',
  },
  {
    // No dedicated ADR (schema-vocab tag validation); test-green only.
    fixId: 36,
    testNames: ['PascalCase tag → error', 'unknown tag (not in vocab) → error'],
    adrPath: null,
    adrKeyLine: NO_ADR,
  },
  {
    fixId: 38,
    testNames: [
      'clean-wiki payload → ok:true, new entries appended (apply dedup is exact-entry, not date-based)',
      'idempotent: re-running same payload produces no new bytes (file mtimes unchanged)',
    ],
    adrPath: 'decisions/0029-crystallize-session-close-depth-expansion.md',
    adrKeyLine: 'exact-entry append dedup',
  },
];
