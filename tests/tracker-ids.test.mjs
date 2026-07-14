// tests/tracker-ids.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scanText,
  stripScissors,
  messageHasGitTemplate,
  BLOCKED_PATTERNS,
  DECISION_PATTERNS,
  TAG_BODY_PATTERNS,
  ATTRIBUTION_PATTERNS,
} from '../scripts/lib/check-tracker-ids.mjs';
import { test, suite } from './harness.mjs';
import { HOME, REPO, SESSION_TMP_HOME, runChecker, withTmpDir } from './helpers.mjs';

// ── session-close advisory reflections (#41~#44) — surface-drift guard ───────
// The four advisories are prompt text, not script logic. The defect class is
// "a shipped session-close surface drifts and silently loses an advisory" — so
// these tests assert each advisory + each identity-guard phrase is present on
// every IN-SCOPE shipped close surface. hypo-guide.md is intentionally out of
// scope (ADR 0019/0022 auto-layer, not 0029 advisory-layer; not machine-read by
// readChecklist — no `[ ] 0.` marker). Reconciling it is logged as #47.
suite('session-close advisory reflections (#41~#44) — present on shipped surfaces');

const ADVISORY_SURFACES = [
  join(REPO, 'commands', 'crystallize.md'),
  join(REPO, 'skills', 'crystallize', 'SKILL.md'),
];

// Markers that must appear on every in-scope surface. Keyed by advisory.
const ADVISORY_MARKERS = {
  '#44 trivial': ['(#44)', 'Trivial-session check'],
  '#41 ADR-candidate': ['(#41)', 'ADR-candidate check', 'Never auto-write an ADR'],
  '#42 design-history': ['(#42)', 'design-history staleness check'],
  '#43 ingest': ['(#43)', 'Ingest check', '/hypo:ingest'],
};

// Identity-guard phrases (ADR 0029): advisory-only, no auto-action, no gate
// bypass. The no-auto contract asserts the actual contract sentence — not just
// the word "advisory" — so a future surface that keeps "advisory" while
// permitting an auto-action (auto-ingest, auto-update) still fails this gate.
const GUARD_PHRASES = [
  'advisory', // advisory-only framing
  'none performs an automatic action', // no-auto contract (not merely the word "advisory")
  'writes on its own', // closing reminder: none writes on its own
  'must not run `--mark-session-closed`', // #44 must not bypass the gate
  'Any real close still requires all 5 mandatory files', // gate still applies
];

for (const surface of ADVISORY_SURFACES) {
  const rel = surface.slice(REPO.length + 1);
  test(`${rel}: all four advisories (#41~#44) present`, () => {
    const txt = readFileSync(surface, 'utf-8');
    for (const [advisory, needles] of Object.entries(ADVISORY_MARKERS)) {
      for (const needle of needles) {
        assert.ok(
          txt.includes(needle),
          `${rel} missing ${advisory} marker: ${JSON.stringify(needle)}`,
        );
      }
    }
  });

  test(`${rel}: identity-guard phrases (advisory-only, no gate bypass) present`, () => {
    const txt = readFileSync(surface, 'utf-8');
    for (const phrase of GUARD_PHRASES) {
      assert.ok(txt.includes(phrase), `${rel} missing guard phrase: ${JSON.stringify(phrase)}`);
    }
  });
}

// hypo-guide.md is the deliberately-excluded auto-layer surface. Pin that it is
// NOT in the in-scope list so a future edit that "helpfully" adds it here has to
// consciously remove this assertion (and address the #47 backstop reconcile).
test('hypo-guide.md intentionally excluded from advisory surfaces (#47 follow-up)', () => {
  const guidePath = join(REPO, 'templates', 'hypo-guide.md');
  assert.ok(
    !ADVISORY_SURFACES.includes(guidePath),
    'templates/hypo-guide.md must stay out of ADVISORY_SURFACES until #47 reconciles its auto-layer wording',
  );
});

// ── over-close guard (ISSUE-31) — proactive-offer path scoping ──────────────
// Forensic (session d8d6ecd0): the model self-ran close (session-closed marker
// write + "session ended" declaration) with NO user close signal — it skipped
// the AskUserQuestion gate, pushed by a competing global instruction. The fix
// is prose-only on shipped surfaces, so the defect class is "guard text drifts
// out and a surface silently permits self-close again". Pin the scoping phrases
// per surface, and pin REMOVAL of the over-trigger "wrapping up a session"
// description wording that PR #127 introduced (which read as task-wrap-up).
suite('over-close guard (ISSUE-31) — proactive path scoping on shipped surfaces');

const OVERCLOSE_SURFACES = [
  {
    file: join(REPO, 'templates', 'hypo-guide.md'),
    present: ['Proactive offer means offer, not close', 'Task completion is not a close trigger'],
    absent: [],
  },
  {
    file: join(REPO, 'commands', 'crystallize.md'),
    present: [
      'Task completion alone is not a close signal', // description
      'Task completion alone does not put you in close mode', // body trigger
    ],
    absent: ['Use when the user is wrapping up a session'], // PR #127 over-trigger wording
  },
  {
    file: join(REPO, 'skills', 'crystallize', 'SKILL.md'),
    present: [
      'Task completion alone is not a close signal',
      'Task completion alone does not put you in close mode',
    ],
    absent: ['Use when the user signals they are wrapping up'],
  },
];

for (const { file, present, absent } of OVERCLOSE_SURFACES) {
  const rel = file.slice(REPO.length + 1);
  test(`${rel}: over-close scoping present, over-trigger wording absent`, () => {
    const txt = readFileSync(file, 'utf-8');
    for (const needle of present) {
      assert.ok(txt.includes(needle), `${rel} missing over-close guard: ${JSON.stringify(needle)}`);
    }
    for (const needle of absent) {
      assert.ok(
        !txt.includes(needle),
        `${rel} still has over-trigger wording (PR #127 regression): ${JSON.stringify(needle)}`,
      );
    }
  });
}

// ── tracker-id gate (no-internal-tracker-ids-in-oss-artifacts) ───────────────
suite('tracker-id gate (check-tracker-ids)');

test('scanText flags ISSUE-N and fix #N (case + tab/space tolerant)', () => {
  assert.equal(scanText('see ISSUE-7 here').length, 1);
  assert.equal(scanText('issue-42 lowercase').length, 1);
  assert.equal(scanText('(fix #68)')[0].match, 'fix #68');
  assert.equal(scanText('Fix\t#40').length, 1);
  assert.equal(scanText('fix  #3 multi-space').length, 1);
  assert.equal(scanText('ISSUE-1 and fix #2').length, 2); // two hits on one line
});

test('scanText allows GitHub refs and lookalikes', () => {
  for (const s of [
    'PR #50',
    'PRs #53~#56',
    '(#101)',
    'see #48',
    'prefix #7',
    'suffix #3',
    'ADR 0040',
    'decisions/0040',
    'https://github.com/x/y/issues/3',
  ]) {
    assert.equal(scanText(s).length, 0, `should not flag: ${s}`);
  }
});

test('scanText with DECISION_PATTERNS flags ADR (space/tab/hyphen) and decisions pointers', () => {
  const docPatterns = [...BLOCKED_PATTERNS, ...DECISION_PATTERNS];
  assert.equal(scanText('see ADR 0040 for rationale', docPatterns).length, 1);
  assert.equal(scanText('ADR\t0019 detail', docPatterns)[0].match, 'ADR\t0019');
  assert.equal(scanText('hyphen form ADR-0018 here', docPatterns)[0].match, 'ADR-0018');
  assert.equal(scanText('lives in decisions/0031-foo.md', docPatterns)[0].match, 'decisions/0031');
  // GitHub refs and tracker ids still behave: PR #N safe, ISSUE-N still caught.
  assert.equal(scanText('PR #50 and (#9)', docPatterns).length, 0);
  assert.equal(scanText('ISSUE-7 and ADR 0040', docPatterns).length, 2);
  // The bare scanText default (BLOCKED_PATTERNS) still never flags ADR refs — only
  // the CLI's patternsFor() layers DECISION_PATTERNS on for non-CHANGELOG files.
  assert.equal(scanText('ADR 0040 and decisions/0031 anchor').length, 0);
});

test('default gate AND tag body flag all five tracker prefixes; FEAT/IMPR/PRAC now block in code comments too', () => {
  // FEAT-/IMPR-/PRAC- were promoted into BLOCKED_PATTERNS, so the DEFAULT file
  // gate (shipped code, commit msgs) now flags them, not just the tag body.
  for (const id of ['ISSUE-7', 'fix #7', 'FEAT-1', 'IMPR-3', 'PRAC-17']) {
    assert.equal(scanText(`leak ${id} here`).length, 1, `default gate must flag ${id}`);
    assert.equal(
      scanText(`leak ${id} here`, TAG_BODY_PATTERNS).length,
      1,
      `tag body must flag ${id}`,
    );
  }
  // A code comment that once cited three trackers is now three hits.
  assert.equal(scanText('// FEAT-17 hardening, see PRAC-18 and IMPR-13').length, 3);
  // GitHub refs, bare prefixes (no digit), and ADR anchors stay legitimate.
  assert.equal(scanText('PR #50 (#9) ADR 0040 FEAT- IMPR- PRAC-').length, 0);
  assert.equal(scanText('PR #50 (#9) ADR 0040', TAG_BODY_PATTERNS).length, 0);
  // TAG_BODY_PATTERNS now equals BLOCKED_PATTERNS (the surface set was folded in).
  assert.deepEqual(
    TAG_BODY_PATTERNS.map((p) => p.name),
    BLOCKED_PATTERNS.map((p) => p.name),
  );
});

test('CHANGELOG.md is tracker-ID-0 across all four prefixes (surface ID 0 regression, §5)', () => {
  const cl = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf-8');
  const hits = scanText(cl, TAG_BODY_PATTERNS);
  assert.equal(
    hits.length,
    0,
    `CHANGELOG.md carries tracker IDs: ${hits.map((h) => `${h.line}:${h.match}`).join(', ')}`,
  );
});

test('scanText reports 1-based line/col', () => {
  const hits = scanText('clean\nleak ISSUE-9 here');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].col, 6);
});

test('scanText catches a tracker token that line-wraps inside a comment', () => {
  const docPatterns = [...BLOCKED_PATTERNS, ...DECISION_PATTERNS];
  // ADR wrapped across a JSDoc continuation: prefix on line 1, digits on line 2.
  const wrapped = ' * before continuing (ADR\n * 0045) and after';
  const h = scanText(wrapped, docPatterns);
  assert.equal(h.length, 1, 'wrapped ADR must be caught');
  assert.equal(h[0].match, 'ADR 0045');
  assert.equal(h[0].line, 1, 'reported at the prefix line');
  // Space-form wraps (the break stands in for a space).
  assert.equal(scanText('truth (fix\n // #37) projection').length, 1, 'fix #N word-wrap');
  // Separator-flush wraps: the break falls right at `-` / `/` / `#`, where the
  // digit must sit flush — the no-gap join catches these.
  assert.equal(scanText('see ISSUE-\n * 9 here').length, 1, 'ISSUE- separator wrap');
  assert.equal(
    scanText('lives in decisions/\n // 0031-foo', docPatterns).length,
    1,
    'decisions/ wrap',
  );
  assert.equal(scanText('blocks (fix #\n * 37)').length, 1, 'fix #<wrap>N separator wrap');
  assert.equal(scanText('per FEAT-\n // 1 detail', docPatterns).length, 1, 'FEAT- separator wrap');
  // The ADR hyphen form can match in BOTH joins; it must be de-duplicated to one.
  assert.equal(scanText('ref ADR\n -0045 end', docPatterns).length, 1, 'ADR hyphen wrap deduped');
  // A non-wrapped token is still counted exactly once (no double-count from the
  // join pass), and a token split by a blank line (not an adjacent wrap) is ignored.
  assert.equal(scanText('one ISSUE-9 here\nplain next line').length, 1);
  assert.equal(scanText('trailing ADR\n\n0045 far away', docPatterns).length, 0);
});

test('messageHasGitTemplate detects editor template / scissors, not -m messages', () => {
  assert.equal(messageHasGitTemplate('subject\n\nbody only\n'), false);
  assert.equal(messageHasGitTemplate('subject\n\n# a plain user comment\n'), false);
  assert.ok(
    messageHasGitTemplate('subject\n# Please enter the commit message for your changes.\n'),
  );
  assert.ok(messageHasGitTemplate('subject\n# On branch main\n'));
  assert.ok(
    messageHasGitTemplate('subject\n# ------------------------ >8 ------------------------\n'),
  );
});

test('stripScissors drops the --verbose diff from the >8 line onward', () => {
  const msg =
    'subject\n\nbody clean\n# ------------------------ >8 ------------------------\ndiff with fix #9 in it';
  const out = stripScissors(msg);
  assert.ok(out.includes('body clean'));
  assert.ok(!out.includes('fix #9'));
  assert.equal(stripScissors('plain\nmessage'), 'plain\nmessage'); // no scissors → unchanged
});

// ── CONCERN 4: unicode bypass tricks (zero-width chars, full-width confusables)
// must not slip an attribution trailer past the regex. Every fixture below is
// built from explicit \u escapes, never typed as a literal invisible/confusable
// byte in this source file — a copy-pasted zero-width character in a test
// fixture is invisible in a diff review, which is exactly the property this
// regression exists to catch, so the test itself must not rely on it either.
suite('scanText — unicode-bypass normalization (CONCERN 4)');

test('a zero-width character wedged inside "Co-Authored-By:" is still caught', () => {
  const withZWJ = 'Co\u200D-Authored-By: Claude <noreply@anthropic.com>';
  const hits = scanText(withZWJ, ATTRIBUTION_PATTERNS);
  assert.ok(
    hits.some((h) => h.pattern === 'Co-Authored-By:'),
    `zero-width-joiner bypass must still be caught: ${JSON.stringify(hits)}`,
  );
});

test('every zero-width character in the stripped set is defeated (U+200B/U+200C/U+200D/U+FEFF)', () => {
  for (const zw of ['\u200B', '\u200C', '\u200D', '\uFEFF']) {
    const trailer = `Co-${zw}Authored-By: Claude`;
    const hits = scanText(trailer, ATTRIBUTION_PATTERNS);
    assert.ok(
      hits.some((h) => h.pattern === 'Co-Authored-By:'),
      `U+${zw.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} must not defeat the scan`,
    );
  }
});

test('a full-width colon confusable ("Co-Authored-By\uFF1A") is still caught (NFKC fold)', () => {
  const fullwidth = 'Co-Authored-By\uFF1A Claude <noreply@anthropic.com>';
  const hits = scanText(fullwidth, ATTRIBUTION_PATTERNS);
  assert.ok(
    hits.some((h) => h.pattern === 'Co-Authored-By:'),
    `full-width colon confusable must NFKC-fold and still be caught: ${JSON.stringify(hits)}`,
  );
});

test('normalization adds no false positive on ordinary ASCII prose', () => {
  assert.equal(scanText('normal prose about co-authoring a book', ATTRIBUTION_PATTERNS).length, 0);
  assert.equal(scanText('see PR #50 and ADR 0040', BLOCKED_PATTERNS).length, 0);
});

test('a zero-width character inside a tracker id (ISSUE-N) is still caught', () => {
  // The bypass is not attribution-specific: scanText normalizes for every
  // caller, tracker-ids included, since both share the same function.
  const hits = scanText('see ISSUE\u200B-49 in the wiki');
  assert.ok(
    hits.some((h) => h.pattern === 'ISSUE-N'),
    `zero-width bypass inside a tracker id must still be caught: ${JSON.stringify(hits)}`,
  );
});

test('CLI --commit-msg: a zero-width-obfuscated attribution trailer is still rejected', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(
      f,
      Buffer.from(
        `feat(gate): thing\n\nCo\u200D-Authored-By: Claude <noreply@anthropic.com>\n`,
        'utf-8',
      ),
    );
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Co-Authored-By:/i);
  });
});

// ── BLOCKER: markdown-ENCODING bypasses. Every surface this gate reads is
// rendered as GFM before a human sees it, so the test is "does it RENDER as the
// banned string", not "do the bytes match". All five encodings below rendered as
// a live trailer / tracker id and walked straight through the raw regex.
suite('scanText — markdown-encoding bypasses (entities, escapes, inline HTML)');

test('a NUMERIC HTML entity cannot hide the trailing colon (Co-Authored-By&#58;)', () => {
  const hits = scanText('Co-Authored-By&#58; Claude <noreply@anthropic.com>', ATTRIBUTION_PATTERNS);
  assert.ok(
    hits.some((h) => h.pattern === 'Co-Authored-By:'),
    `&#58; renders as ":" — the trailer ships: ${JSON.stringify(hits)}`,
  );
});

test('a HEX entity cannot hide the robot-emoji footer marker (&#x1F916;)', () => {
  const hits = scanText('&#x1F916; Generated with [Claude Code]', ATTRIBUTION_PATTERNS);
  assert.ok(
    hits.some((h) => h.pattern === 'robot-emoji footer'),
    `&#x1F916; renders as the robot emoji: ${JSON.stringify(hits)}`,
  );
});

test('a NAMED HTML entity cannot hide a colon or a hash (&colon; / &num;)', () => {
  assert.ok(
    scanText('Co-Authored-By&colon; Claude', ATTRIBUTION_PATTERNS).length > 0,
    '&colon; must decode',
  );
  assert.ok(scanText('closes fix &num;37 now').length > 0, '&num; must decode to #');
});

test('an entity cannot hide a tracker id separator (ISSUE&#45;49)', () => {
  const hits = scanText('closes ISSUE&#45;49 in the wiki');
  assert.ok(
    hits.some((h) => h.pattern === 'ISSUE-N'),
    `&#45; renders as "-": ${JSON.stringify(hits)}`,
  );
});

test('an entity cannot hide a word gap (Generated&#32;with)', () => {
  assert.ok(
    scanText('Generated&#32;with [Claude Code]', ATTRIBUTION_PATTERNS).some(
      (h) => h.pattern === 'Generated with',
    ),
    '&#32; renders as a space',
  );
});

test('a markdown BACKSLASH escape cannot hide the colon (Co-Authored-By\\:)', () => {
  const hits = scanText('Co-Authored-By\\: Claude <noreply@anthropic.com>', ATTRIBUTION_PATTERNS);
  assert.ok(
    hits.some((h) => h.pattern === 'Co-Authored-By:'),
    `\\: renders as ":" in GFM: ${JSON.stringify(hits)}`,
  );
});

test('an inline HTML comment cannot SPLIT a trailer (Co<!--x-->-Authored-By:)', () => {
  const hits = scanText('Co<!--x-->-Authored-By: Claude', ATTRIBUTION_PATTERNS);
  assert.ok(
    hits.some((h) => h.pattern === 'Co-Authored-By:'),
    `a comment renders as nothing, so the trailer is contiguous to a reader: ${JSON.stringify(hits)}`,
  );
});

test('an inline HTML TAG cannot split a trailer or a tracker id (<span>, <b>)', () => {
  assert.ok(
    scanText('Co<span></span>-Authored-By: Claude', ATTRIBUTION_PATTERNS).length > 0,
    'a tag renders as nothing between the two halves',
  );
  assert.ok(scanText('closes ISSUE-<b></b>49 here').length > 0, 'same for a tracker id');
});

test('a trailer hidden INSIDE an HTML comment is STILL caught (the two views do not cancel)', () => {
  // The HTML-removed view deletes the comment — but the primary view keeps it, and
  // the union is what is reported. Deleting comments outright (a one-view fix)
  // would have re-opened the exact hole the PR-surface gate closed earlier.
  const hits = scanText(
    '<!-- Co-Authored-By: Claude <noreply@anthropic.com> -->',
    ATTRIBUTION_PATTERNS,
  );
  assert.ok(
    hits.some((h) => h.pattern === 'Co-Authored-By:'),
    `a comment does not render, but it still ships: ${JSON.stringify(hits)}`,
  );
});

test('the two views never double-report the same hit', () => {
  // `Co<!--x-->-Authored-By:` is found once (in the HTML-removed view); a plain
  // trailer is found once (in the primary view). Neither is counted twice.
  assert.equal(scanText('Co<!--x-->-Authored-By: Claude', ATTRIBUTION_PATTERNS).length, 1);
  assert.equal(scanText('Co-Authored-By: Claude', ATTRIBUTION_PATTERNS).length, 1);
  // two genuine hits on one line stay two
  assert.equal(scanText('ISSUE-1 and ISSUE-2 here').length, 2);
  assert.equal(scanText('ISSUE-1 and ISSUE-1 twice').length, 2);
});

test('the new normalization adds no false positive on ordinary prose or code', () => {
  assert.equal(scanText('A&B, 100% &amp; more — see PR #50 and (#9)').length, 0);
  assert.equal(scanText('const re = /\\bISSUE-\\d+\\b/gi; // matcher, no literal id').length, 0);
  assert.equal(scanText('<https://example.com/issues> and <br/> line break').length, 0);
  assert.equal(scanText('an unknown &entity; stays put').length, 0);
  assert.equal(scanText('prose about co-authoring a book', ATTRIBUTION_PATTERNS).length, 0);
});

test('CLI --commit-msg: an entity-encoded attribution trailer is rejected', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(f, 'feat(gate): thing\n\nCo-Authored-By&#58; Claude <noreply@anthropic.com>\n');
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /Co-Authored-By:/i);
  });
});

test('CLI --commit-msg: blocks a leak (exit 1)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(f, 'feat: thing\n\nImplements fix #99.\n');
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /fix #99/);
  });
});

test('CLI --commit-msg: clean with GitHub refs (exit 0)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(f, 'feat: thing (#101)\n\nSee PR #50 and #48. ADR 0040.\n');
    assert.equal(runChecker(['--commit-msg', f]).status, 0);
  });
});

test('CLI --commit-msg: a #-comment leak IS flagged when git has no template (commit -m / whitespace keeps it)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    // No git template present → this is a `commit -m` / whitespace-style message,
    // where git KEEPS the `#` line. Must be flagged (closes the false-negative).
    writeFileSync(f, 'clean subject\n\n# ISSUE-7 kept by whitespace cleanup\nreal body\n');
    assert.equal(runChecker(['--commit-msg', f]).status, 1);
  });
});

test('CLI --commit-msg: a leak after a bare ">8" line IS flagged with no template (git keeps it in -m)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    // No git template (commit -m / -F style). A bare ">8" line is NOT a git
    // scissors marker (git only honors a comment-prefixed one in editor mode),
    // so git keeps the line below it — the checker must scan it.
    writeFileSync(
      f,
      'subject\n\n------------------------ >8 ------------------------\nafter fix #55\n',
    );
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /fix #55/);
  });
});

test('CLI --commit-msg: a #-comment leak is ignored when git WILL strip it (editor template present)', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    // Editor/strip mode: git appends its instructional template and strips ALL
    // `#` lines, so a tracker id in a comment never reaches the commit → not flagged.
    writeFileSync(
      f,
      'clean subject\n\n# ISSUE-7 in an editor comment\n' +
        '# Please enter the commit message for your changes. Lines starting\n' +
        '# with "#" will be ignored, and an empty message aborts the commit.\n' +
        '# On branch feat/x\n',
    );
    assert.equal(runChecker(['--commit-msg', f]).status, 0);
  });
});

test('CLI --commit-msg: a real prose leak is flagged even with an editor template', () => {
  withTmpDir((dir) => {
    const f = join(dir, 'MSG');
    writeFileSync(
      f,
      'feat: thing\n\nImplements fix #99 in the body.\n' +
        '# Please enter the commit message for your changes.\n# On branch main\n',
    );
    const r = runChecker(['--commit-msg', f]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /fix #99/);
  });
});

// Synthetic git repo isolates --staged from the real index (CHECK_TRACKER_ROOT
// test seam). Covers the staged-blob-vs-working-tree distinction codex flagged.
function withSyntheticRepo(fn) {
  withTmpDir((dir) => {
    const env0 = {
      ...process.env,
      HOME: SESSION_TMP_HOME,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', env: env0 });
    g(['init', '-q']);
    g(['config', 'user.email', 't@t']);
    g(['config', 'user.name', 't']);
    g(['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(dir, 'docs'), { recursive: true });
    fn({ dir, g });
  });
}

test('CLI --staged: blocks a staged leak, passes when clean', () => {
  withSyntheticRepo(({ dir, g }) => {
    writeFileSync(join(dir, 'docs', 'a.md'), 'clean see PR #5 and (#9)\n');
    g(['add', 'docs/a.md']);
    assert.equal(
      runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'clean staged set should pass',
    );
    writeFileSync(join(dir, 'docs', 'b.md'), 'leak fix #9 here\n');
    g(['add', 'docs/b.md']);
    const r = runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'staged leak should block');
    assert.match(r.stderr, /fix #9/);
  });
});

test('CLI --staged: a working-tree-only leak is NOT gated (only the staged blob)', () => {
  withSyntheticRepo(({ dir, g }) => {
    writeFileSync(join(dir, 'docs', 'c.md'), 'clean\n');
    g(['add', 'docs/c.md']);
    writeFileSync(join(dir, 'docs', 'c.md'), 'clean\nfix #7 unstaged\n'); // working tree only
    assert.equal(
      runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'unstaged leak must not block — only the staged blob is gated',
    );
  });
});

test('CLI --staged: a leak in an EXCLUDED path (tests/) is not gated', () => {
  withSyntheticRepo(({ dir, g }) => {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 't.mjs'), '// ISSUE-7 legit test anchor\n');
    g(['add', 'tests/t.mjs']);
    assert.equal(
      runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'tests/ is excluded maintainer scope',
    );
  });
});

test('CLI --staged: the fix-verify subsystem is excluded (git slash paths normalize the same as --all)', () => {
  withSyntheticRepo(({ dir, g }) => {
    // git feeds --staged a slash path; EXCLUDED_FILES is stored slash-style and
    // toPosix() normalizes, so the verifier files are excluded in BOTH modes.
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'lib', 'fix-manifest.mjs'), '// FEAT-99 manifest row\n');
    g(['add', 'scripts/lib/fix-manifest.mjs']);
    assert.equal(
      runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'staged verifier file is excluded',
    );
    // A non-excluded staged script with the same id still blocks (scope intact).
    writeFileSync(join(dir, 'scripts', 'other.mjs'), '// FEAT-99 leak\n');
    g(['add', 'scripts/other.mjs']);
    const r = runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'a non-excluded staged script must still flag FEAT-99');
    assert.match(r.stderr, /FEAT-99/);
  });
});

test('CLI --all: package.json IS in scope (npm auto-ships it); a stray root file is NOT', () => {
  withTmpDir((dir) => {
    // package.json leak → flagged
    writeFileSync(join(dir, 'package.json'), '{ "description": "leak fix #123" }\n');
    assert.equal(
      runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status,
      1,
      'package.json leak must be caught',
    );
  });
  withTmpDir((dir) => {
    // an out-of-scope root file → NOT flagged (matches --staged scope)
    writeFileSync(join(dir, 'NOTES.md'), 'random fix #123 in an unshipped root file\n');
    assert.equal(
      runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'stray root file is out of scope',
    );
  });
});

test('CLI --staged: package.json leak is gated (scope agrees with --all)', () => {
  withSyntheticRepo(({ dir, g }) => {
    writeFileSync(join(dir, 'package.json'), '{ "description": "leak fix #7" }\n');
    g(['add', 'package.json']);
    const r = runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'staged package.json leak must block');
    assert.match(r.stderr, /fix #7/);
  });
});

test('CLI --all: ADR / decisions pointers are gated everywhere except CHANGELOG', () => {
  withTmpDir((dir) => {
    // README.md → ADR pointer flagged.
    writeFileSync(join(dir, 'README.md'), 'rationale lives in ADR 0031.\n');
    const r = runChecker(['--all'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'README ADR pointer must be gated');
    assert.match(r.stderr, /ADR 0031/);
  });
  withTmpDir((dir) => {
    // README.ko.md too (the bilingual surface).
    writeFileSync(join(dir, 'README.ko.md'), '근거는 decisions/0031 참고.\n');
    assert.equal(runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status, 1);
  });
  withTmpDir((dir) => {
    // docs/ tree → flagged.
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'ARCHITECTURE.md'), '## Section (ADR 0019)\n');
    assert.equal(runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status, 1);
  });
  withTmpDir((dir) => {
    // Shipped CODE comments now block ADR anchors too (space and hyphen forms).
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'x.mjs'), '// cwd-first (ADR 0044), see ADR-0018\n');
    const r = runChecker(['--all'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'code comment ADR anchors must now be gated');
    assert.match(r.stderr, /ADR 0044/);
    assert.match(r.stderr, /ADR-0018/);
  });
  withTmpDir((dir) => {
    // A decisions/ path in shipped code → flagged.
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'y.mjs'), '// see decisions/0052-foo.md\n');
    assert.equal(runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status, 1);
  });
  withTmpDir((dir) => {
    // CHANGELOG keeps version-history ADR / decisions refs → NOT flagged.
    writeFileSync(
      join(dir, 'CHANGELOG.md'),
      '- gate single SoT (ADR 0046), see decisions/0046-foo.md\n',
    );
    assert.equal(
      runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'CHANGELOG ADR / decisions refs must NOT be gated',
    );
  });
});

test('CLI --all: the fix-verify subsystem is excluded from the scan, but the same id is flagged elsewhere', () => {
  withTmpDir((dir) => {
    // The verifier trio + helper is maintainer-only (un-shipped from npm) and
    // carries decisions/ paths as runtime data, so EXCLUDED_FILES keeps the gate
    // off them. A now-blocked FEAT id sitting in them must NOT be flagged.
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'lib', 'fix-manifest.mjs'), '// FEAT-99 manifest row\n');
    writeFileSync(join(dir, 'scripts', 'fix-status-verify.mjs'), '// FEAT-99 verifier\n');
    writeFileSync(join(dir, 'scripts', 'lib', 'fix-status-verify.mjs'), '// FEAT-99 lib\n');
    writeFileSync(join(dir, 'scripts', 'lib', 'adr-corpus.mjs'), '// FEAT-99 corpus\n');
    assert.equal(
      runChecker(['--all'], { CHECK_TRACKER_ROOT: dir }).status,
      0,
      'fix-verify subsystem files are excluded from the scan',
    );
    // The SAME id in an ordinary shipped script IS flagged — proves it is the
    // exclusion at work, not a missing pattern.
    writeFileSync(join(dir, 'scripts', 'other.mjs'), '// FEAT-99 leak\n');
    const r = runChecker(['--all'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'a non-excluded script must still flag FEAT-99');
    assert.match(r.stderr, /FEAT-99/);
    assert.doesNotMatch(r.stderr, /fix-manifest|fix-status-verify|adr-corpus/);
  });
});

test('CLI --all: shipped docs/ SVG assets are scanned (.svg in TEXT_EXT)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'docs', 'assets'), { recursive: true });
    writeFileSync(
      join(dir, 'docs', 'assets', 'logo.svg'),
      '<svg><title>logo</title><!-- ISSUE-7 --></svg>\n',
    );
    const r = runChecker(['--all'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'a tracker id in a shipped SVG must be gated');
    assert.match(r.stderr, /ISSUE-7/);
  });
});

test('CLI --staged: a staged ADR pointer in README is gated', () => {
  withSyntheticRepo(({ dir, g }) => {
    writeFileSync(join(dir, 'README.md'), 'see ADR 0024 inside your wiki\n');
    g(['add', 'README.md']);
    const r = runChecker(['--staged'], { CHECK_TRACKER_ROOT: dir });
    assert.equal(r.status, 1, 'staged README ADR pointer must block');
    assert.match(r.stderr, /ADR 0024/);
  });
});

test('CLI checker source files are NOT exempt — they scan clean via N placeholders', () => {
  // Regression guard for the self-exclusion blocker: the shipped checker files
  // must be scanned by --all and must be clean.
  const r = runChecker(['--all']);
  assert.equal(r.status, 0, `repo has tracker-id leaks:\n${r.stdout}${r.stderr}`);
});
