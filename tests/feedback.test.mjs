// tests/feedback.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
  statSync,
  lstatSync,
  chmodSync,
  cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// static import (no top-level await) — feedback-sync.mjs guards main() behind an
// entry check, so importing it for unit tests does not run the CLI.
import { resolveProjectId as fbResolveProjectId } from '../scripts/feedback-sync.mjs';
import { test, testAsync, suite } from './harness.mjs';
import {
  FB_GLOBAL_L1,
  FB_PROJECT_L2,
  HOME,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  fbPage,
  run,
  runHook,
  withFeedbackEnv,
  withWiki,
} from './helpers.mjs';

// ── hypo-personal-check.mjs — feedback projection gate ──────
// The PreCompact gate runs `feedback-sync --check --strict` when PKG_ROOT
// resolves (a custom HOME with hypo-pkg.json). Per ADR 0045, PURE projection
// drift self-heals (the gate runs --write and continues); conflict and over-cap
// still block (human decision required). The single-blocking-gate invariant
// (spec §7.5) means this is integrated into hypo-personal-check, not a separate
// hook.
suite('hypo-personal-check.mjs — feedback projection gate (fix #37 Phase C)');

test('feedback projection pure drift → self-heal (auto --write) + continue, not block (ADR 0045)', () => {
  withWiki(
    (dir) => {
      // A global-L1 page is a CLAUDE projection candidate; the controlled
      // CLAUDE.md below has an empty <learned_behaviors> with no managed region
      // yet, so `--check` sees the projection as stale → pure drift (exit 1).
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      // Custom HOME so the hook's PKG_ROOT resolves (enabling the feedback
      // check) and the projection target is a controlled empty CLAUDE.md.
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-home-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        const claudePath = join(home, '.claude', 'CLAUDE.md');
        writeFileSync(claudePath, '# Global\n<learned_behaviors>\n</learned_behaviors>\n');
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        // Pure drift self-heals: the gate runs --write and proceeds.
        assert.equal(out.continue, true, `pure drift must self-heal, not block: ${r.stdout}`);
        assert.notEqual(out.decision, 'block', `must not block on pure drift: ${r.stdout}`);
        assert.ok(
          /re-synced/.test(out.systemMessage || ''),
          `continue must carry the self-heal notice: ${r.stdout}`,
        );
        // The write actually resolved the drift: the managed block now exists.
        assert.ok(
          readFileSync(claudePath, 'utf-8').includes('HYPO:FEEDBACK-SYNC:START source=rule-a'),
          'self-heal must have written the managed projection block',
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback projection conflict (hand-edited block) → still blocks, no auto-merge (ADR 0045)', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-conflict-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        const claudePath = join(home, '.claude', 'CLAUDE.md');
        writeFileSync(claudePath, '# Global\n<learned_behaviors>\n</learned_behaviors>\n');
        // First, materialize the projection, then hand-edit the managed block so
        // its hash no longer matches → conflict (ADR 0031 rule 6).
        spawnSync(
          process.execPath,
          [
            join(REPO, 'scripts', 'feedback-sync.mjs'),
            '--write',
            '--no-input',
            `--hypo-dir=${dir}`,
            `--claude-home=${join(home, '.claude')}`,
          ],
          { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME } },
        );
        writeFileSync(
          claudePath,
          readFileSync(claudePath, 'utf-8').replace('always do A', 'HAND EDITED'),
        );
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.equal(out.decision, 'block', `conflict must still block: ${r.stdout}`);
        assert.ok(
          /conflict/.test(out.reason || ''),
          `block reason must name the conflict: ${r.stdout}`,
        );
        // Never auto-merged over the hand edit.
        assert.ok(
          readFileSync(claudePath, 'utf-8').includes('HAND EDITED'),
          'conflict must not be auto-merged by the gate',
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback projection over cap → still blocks, never auto-writes (ADR 0045)', () => {
  withWiki(
    (dir) => {
      // 11 distinct global-L1 pages → CLAUDE projection has 11 candidates > the
      // 10-entry cap (ADR 0031 rule 3) → over-cap. A human must demote/archive,
      // so the gate must block and must NOT invoke the self-heal --write.
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      for (let i = 0; i < 11; i++) {
        writeFileSync(
          join(dir, 'pages', 'feedback', `rule-${i}.md`),
          fbPage({
            ...FB_GLOBAL_L1,
            title: `Rule ${i}`,
            global_summary: `always do thing number ${i}`,
            memory_summary: `do ${i}`,
          }),
        );
      }
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-overcap-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        const claudePath = join(home, '.claude', 'CLAUDE.md');
        writeFileSync(claudePath, '# Global\n<learned_behaviors>\n</learned_behaviors>\n');
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.equal(out.decision, 'block', `over-cap must still block: ${r.stdout}`);
        assert.ok(
          /over cap/.test(out.reason || ''),
          `block reason must name the over-cap: ${r.stdout}`,
        );
        // Self-heal must NOT have run --write: no managed block was materialized.
        assert.ok(
          !readFileSync(claudePath, 'utf-8').includes('HYPO:FEEDBACK-SYNC:START'),
          'over-cap must not trigger auto-write',
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback gate: CLAUDE.md present but WITHOUT its container → BLOCKS (was a silent fail-open)', () => {
  // The projection cannot be built, so NOT ONE L1 rule is loaded on this machine
  // and every sync is a silent no-op. The buildError shape is dirty:false with no
  // conflict flag, so the gate used to classify it as "nothing to do" and fail
  // OPEN — structurally broken, and nothing anywhere said so. It must block.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-nocontainer-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        // The file EXISTS (so this is NOT the benign first-run case) but the
        // managed <learned_behaviors> container is gone.
        writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Global\n\nNo container here.\n');
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.equal(out.decision, 'block', `unbuildable projection must block: ${r.stdout}`);
        assert.ok(
          /cannot be built/.test(out.reason || ''),
          `block reason must name the build failure: ${r.stdout}`,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback gate: CLAUDE.md exists but is UNREADABLE → BLOCKS, not fail-open (BLOCKER 5)', () => {
  // BLOCKER 5: existsSync sees the file, readFileSync throws (mode 000), and an
  // uncaught throw used to crash feedback-sync entirely — no JSON report at all.
  // The PreCompact gate's "unparseable stdout" branch then read that as
  // "nothing to project" and failed OPEN: an ordinary filesystem error
  // reproduced the exact failure mode (rules not loaded, gate stays green) this
  // whole system exists to prevent. It must block, the same as a missing
  // container.
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-unreadable-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
        writeFileSync(claudeMdPath, '# Global\n<learned_behaviors>\n</learned_behaviors>\n');
        chmodSync(claudeMdPath, 0o000);
        try {
          const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
          const out = JSON.parse(r.stdout);
          assert.equal(
            out.decision,
            'block',
            `unreadable target must block, not fail-open: ${r.stdout}`,
          );
          assert.ok(
            /cannot be built/.test(out.reason || ''),
            `block reason must name the build failure: ${r.stdout}`,
          );
        } finally {
          chmodSync(claudeMdPath, 0o644); // restore so cleanup (rmSync) can remove the tree
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback gate: CLAUDE.md file absent entirely → still fail-open (first-run, not a break)', () => {
  // Counterpart of the unreadable-target test above: a file that does not
  // exist AT ALL is the ordinary first-run state, not a broken one, and must
  // keep failing open — 'target-missing' stays distinct from 'build-failed'.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-missing-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        // No CLAUDE.md at all.
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.equal(
          out.continue,
          true,
          `a missing (not unreadable) target must still fail-open: ${r.stdout}`,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('feedback gate: no container AND no feedback pages → still fail-open (nothing to project)', () => {
  // The other side of the promotion above: a user whose CLAUDE.md has no managed
  // container and who has no feedback pages yet has NOTHING to project, so there
  // is no build error and nothing to block on. A gate that blocked here would hit
  // every user who keeps a plain global CLAUDE.md.
  withWiki(null, (dir) => {
    const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-nocontainer-empty-'));
    try {
      mkdirSync(join(home, '.claude'), { recursive: true });
      writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Global\n\nNo container here.\n');
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, true, `no candidates must not block: ${r.stdout}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('feedback gate: memory clean + missing CLAUDE.md → fail-open (no false block)', () => {
  // Regression: the prior `every(buildError)` predicate blocked
  // when the memory target was clean but the claude target only had a buildError
  // (e.g. ~/.claude/CLAUDE.md never created). With no feedback pages the memory
  // target has 0 candidates (clean) and the missing CLAUDE.md is benign — the
  // gate must fail-open, not report drift.
  withWiki(null, (dir) => {
    const home = mkdtempSync(join(tmpdir(), 'hypo-fbgate-home-'));
    try {
      const derivedId = process.cwd().replace(/[/.]/g, '-');
      const memDir = join(home, '.claude', 'projects', derivedId, 'memory');
      mkdirSync(memDir, { recursive: true });
      writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
      writeFileSync(join(memDir, 'MEMORY.md'), '# Memory Index\n');
      // intentionally NO CLAUDE.md → claude target buildError
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
      const out = JSON.parse(r.stdout);
      assert.equal(out.continue, true, `missing CLAUDE.md must not block: ${r.stdout}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

suite('feedback-sync.mjs — ADR 0031 / fix #37 Phase A');

test('feedback-sync-check-detects-drift: fresh projection targets are dirty → exit 1', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    const r = runFb(['--check', '--json']);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.targets.claude.dirty, true);
    assert.equal(rep.targets.memory.dirty, true);
  });
});

test('feedback-sync-write-idempotent: second --write is byte-identical + post-check clean', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-b': FB_PROJECT_L2 },
    ({ claudeHome, memDir, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const claude1 = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const mem1 = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(claude1.includes('- manual entry'), 'manual entry must survive');
      assert.ok(claude1.includes('HYPO:FEEDBACK-SYNC:START source=rule-a'));
      assert.equal(runFb(['--write']).status, 0);
      assert.equal(
        readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8'),
        claude1,
        'CLAUDE.md not byte-identical',
      );
      assert.equal(
        readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'),
        mem1,
        'MEMORY.md not byte-identical',
      );
      assert.equal(runFb(['--check']).status, 0, 'post-write check must be clean');
    },
  );
});

test('feedback-sync-conflict-fails-without-merge: hand-edited block → exit 3, no overwrite', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    runFb(['--write']);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    assert.equal(runFb(['--check']).status, 3, 'check must report conflict');
    assert.equal(runFb(['--write']).status, 3, 'write must refuse');
    assert.ok(
      readFileSync(p, 'utf-8').includes('HAND EDITED'),
      'conflict block must not be auto-merged',
    );
  });
});

test('feedback-sync-scope-project-rejected-from-claude: project scope only reaches memory', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ runFb }) => {
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.claude.candidates, 0, 'scope:project:* must be rejected from CLAUDE');
    assert.equal(rep.targets.memory.candidates, 1, 'project scope still projects to memory');
  });
});

// Track D 3rd stage (projection): a cwd-derived project-id round-trips through
// projection. The page scope and the resolved project-id are matched by exact
// string equality (feedback-sync.mjs:222 — unchanged by D), so a relaxed-lint
// leading-dash id projects into the matching project's MEMORY exactly like a
// short slug. Completes the create → lint → projection consistency chain.
test('feedback-sync-scope-cwd-derived-id-projects: leading-dash mixed-case id reaches its MEMORY', () => {
  const pid = '-Users-you-Workspace-Project';
  const page = { ...FB_PROJECT_L2, scope: `project:${pid}`, memory_summary: 'do derived' };
  withFeedbackEnv(
    { derived: page },
    ({ memDir, runFb }) => {
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(
        rep.targets.memory.candidates,
        1,
        `cwd-derived scope must project to memory: got ${rep.targets.memory.candidates}`,
      );
      const w = runFb(['--write']);
      assert.equal(w.status, 0, `--write should succeed: ${w.stderr}`);
      const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(
        mem.includes('feedback_derived.md'),
        `derived-id page must appear in MEMORY: ${mem}`,
      );
    },
    { projectId: pid },
  );
});

// Cross-project pollution guard (ADR 0031 cwd-scoped projection invariant):
// memoryTarget.filter previously accepted any `scope: project:*` regardless of
// the resolved project-id, so a `scope: project:other` page was silently
// projected into `~/.claude/projects/<this-project>/memory/`. The fix tightens
// the filter to an exact match against the resolved project-id, and renders /
// sideFiles share the same desired set so MEMORY index + feedback_<slug>.md
// stay consistent.
test('feedback-sync-scope-project-mismatch-excluded: other-project scope never reaches this memory', () => {
  const otherPage = { ...FB_PROJECT_L2, scope: 'project:other', memory_summary: 'do other' };
  withFeedbackEnv({ mine: FB_PROJECT_L2, other: otherPage }, ({ memDir, runFb }) => {
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(
      rep.targets.memory.candidates,
      1,
      `only the matching-project page should project to memory (got ${rep.targets.memory.candidates})`,
    );
    const w = runFb(['--write']);
    assert.equal(w.status, 0, `--write should succeed: ${w.stderr}`);
    const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    assert.ok(mem.includes('feedback_mine.md'), 'matching-project page must appear in MEMORY');
    assert.ok(
      !mem.includes('feedback_other.md'),
      `other-project page must not appear in MEMORY: ${mem}`,
    );
    assert.ok(
      existsSync(join(memDir, 'feedback_mine.md')),
      'matching-project sideFile must be written',
    );
    assert.ok(
      !existsSync(join(memDir, 'feedback_other.md')),
      'other-project sideFile must NOT be written',
    );
  });
});

test('feedback-sync-scope-global-still-projects-to-memory: global scope is project-agnostic', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ memDir, runFb }) => {
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.memory.candidates, 1, 'global scope still reaches memory');
    runFb(['--write']);
    assert.ok(
      readFileSync(join(memDir, 'MEMORY.md'), 'utf-8').includes('feedback_rule-a.md'),
      'global page must appear in MEMORY index',
    );
  });
});

test('feedback-sync-over-cap-exits-2: >10 CLAUDE candidates → exit 2', () => {
  const pages = {};
  for (let i = 1; i <= 11; i++) {
    pages[`cap-${i}`] = {
      ...FB_GLOBAL_L1,
      title: `Cap ${i}`,
      global_summary: `g${i}`,
      memory_summary: `m${i}`,
    };
  }
  withFeedbackEnv(pages, ({ runFb }) => {
    const r = runFb(['--check', '--json']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).targets.claude.overCap, true);
  });
});

test('feedback-sync-write-atomic-on-conflict: stale target not written when another conflicts', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, memDir, runFb }) => {
    runFb(['--write']); // both projections clean now
    const memBefore = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    // make MEMORY genuinely stale (memory_summary change only affects MEMORY render)
    const pagePath = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(
      pagePath,
      readFileSync(pagePath, 'utf-8').replace('memory_summary: do A', 'memory_summary: do A v2'),
    );
    // create a CLAUDE conflict by hand-editing its managed block
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(cp, readFileSync(cp, 'utf-8').replace('always do A', 'HAND EDITED'));
    const r = runFb(['--write']);
    assert.equal(r.status, 3, `expected conflict exit 3, got ${r.status}: ${r.stderr}`);
    assert.equal(
      readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'),
      memBefore,
      'stale MEMORY must NOT be written when CLAUDE conflicts (atomicity)',
    );
  });
});

test('feedback-sync-intruder-in-region-refuses: hand line between blocks → exit 3, preserved', () => {
  withFeedbackEnv(
    {
      'rule-a': FB_GLOBAL_L1,
      'cap-x': { ...FB_GLOBAL_L1, title: 'X', global_summary: 'gx', memory_summary: 'mx' },
    },
    ({ claudeHome, runFb }) => {
      runFb(['--write']);
      const cp = join(claudeHome, 'CLAUDE.md');
      // inject a manual line between the two managed END/START boundaries
      const content = readFileSync(cp, 'utf-8').replace(
        '<!-- HYPO:FEEDBACK-SYNC:END -->\n<!-- HYPO:FEEDBACK-SYNC:START',
        '<!-- HYPO:FEEDBACK-SYNC:END -->\n- intruder line\n<!-- HYPO:FEEDBACK-SYNC:START',
      );
      writeFileSync(cp, content);
      assert.equal(runFb(['--check']).status, 3, 'intruder must be flagged');
      assert.equal(runFb(['--write']).status, 3, 'write must refuse with intruder present');
      assert.ok(
        readFileSync(cp, 'utf-8').includes('- intruder line'),
        'intruder must be preserved',
      );
    },
  );
});

test('feedback-sync-project-id-unknown-skips-memory: derived dir missing → no hard fail', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome }) => {
    const r = run('feedback-sync.mjs', [
      '--check',
      '--json',
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      `--cwd=${join(tmpdir(), 'no-such-cwd-xyz')}`,
    ]);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.projectIdResolved, false);
    assert.equal(rep.targets.memory, undefined, 'memory target skipped when project-id unresolved');
    assert.ok('claude' in rep.targets, 'claude target still evaluated');
  });
});

test('feedback-sync --check --json: an UNREADABLE target file reports build-failed, no crash (BLOCKER 5)', () => {
  // existsSync sees the file; readFileSync throws (mode 000). This used to be
  // an UNCAUGHT exception: the process crashed before writing any JSON to
  // stdout, so every downstream consumer (doctor, the PreCompact gate) saw "no
  // report" and treated it as "nothing to project" — fail OPEN on an ordinary
  // filesystem error. Caught now and reported like any other structural
  // failure: valid JSON, buildErrorKind 'build-failed'.
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    const claudeMdPath = join(claudeHome, 'CLAUDE.md');
    chmodSync(claudeMdPath, 0o000);
    try {
      const r = runFb(['--check', '--json']);
      const rep = JSON.parse(r.stdout); // must not throw: a report must still come out
      assert.equal(
        rep.targets.claude.buildErrorKind,
        'build-failed',
        `an unreadable (not missing) target must be 'build-failed': ${r.stdout}`,
      );
      assert.match(rep.targets.claude.buildError, /cannot read target file/);
      assert.notEqual(r.status, 0, 'an unreadable target must not exit clean');
    } finally {
      chmodSync(claudeMdPath, 0o644); // restore so withFeedbackEnv cleanup can remove it
    }
  });
});

test('feedback-sync --check --json: a target file that is simply MISSING stays target-missing', () => {
  // The counterpart of the unreadable case above: no file at all is the
  // ordinary first-run state and must keep its own distinct classification, not
  // collapse into 'build-failed'.
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    rmSync(join(claudeHome, 'CLAUDE.md'), { force: true });
    const r = runFb(['--check', '--json']);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.targets.claude.buildErrorKind, 'target-missing');
  });
});

// ── feedback-sync hardening regressions ──────────────────────────────────────
suite('feedback-sync hardening regressions');

test('feedback-sync-crlf-block-idempotent: CRLF managed block is recognized, no duplicate region', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    runFb(['--write']);
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(cp, readFileSync(cp, 'utf-8').replace(/\n/g, '\r\n')); // simulate CRLF editor
    // must NOT treat CRLF block as "no blocks" and append a second region
    assert.equal(runFb(['--write']).status, 0);
    const after = readFileSync(cp, 'utf-8');
    const starts = (after.match(/HYPO:FEEDBACK-SYNC:START/g) || []).length;
    assert.equal(starts, 1, `CRLF block duplicated: ${starts} START markers`);
  });
});

test('feedback-sync-unpaired-marker-refuses: stray START marker → exit 3', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    runFb(['--write']);
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(
      cp,
      readFileSync(cp, 'utf-8') +
        '\n<!-- HYPO:FEEDBACK-SYNC:START source=ghost sha256=deadbeef -->\n',
    );
    assert.equal(runFb(['--check']).status, 3, 'unpaired START must be flagged');
    assert.equal(runFb(['--write']).status, 3, 'write must refuse with unpaired marker');
  });
});

test('feedback-sync-anchor-outside-container-ignored: region stays inside <learned_behaviors>', () => {
  // anchor placed OUTSIDE the container — must NOT be used as insertion point
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const open = c.indexOf('<learned_behaviors>');
      const close = c.indexOf('</learned_behaviors>');
      const block = c.indexOf('HYPO:FEEDBACK-SYNC:START');
      assert.ok(block > open && block < close, 'managed block must land inside the container');
      assert.ok(c.indexOf('ANCHOR') < open, 'out-of-container anchor must remain untouched');
    },
    {
      claudeMd:
        '# Global\n<!-- HYPO:FEEDBACK-SYNC:ANCHOR -->\n<learned_behaviors>\n- manual entry\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-missing-container-no-partial-write: MEMORY untouched when CLAUDE has no container', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, memDir, runFb }) => {
      const memBefore = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      const sideBefore = existsSync(join(memDir, 'feedback_rule-a.md'));
      const r = runFb(['--write']);
      assert.notEqual(r.status, 0, 'write must fail when CLAUDE lacks <learned_behaviors>');
      assert.equal(
        readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'),
        memBefore,
        'MEMORY index must NOT be written (atomic preflight)',
      );
      assert.equal(
        existsSync(join(memDir, 'feedback_rule-a.md')),
        sideBefore,
        'MEMORY side-file must NOT be written',
      );
    },
    { claudeMd: '# Global\n(no learned_behaviors block here)\n' },
  );
});

test('feedback-sync-zero-candidate-idempotent: no candidates → --write does not grow the file', () => {
  // a page that matches NO target (status archived) → zero candidates
  withFeedbackEnv(
    { 'rule-x': { ...FB_GLOBAL_L1, status: 'archived' } },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c1 = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.equal(runFb(['--write']).status, 0);
      const c2 = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.equal(c1, c2, 'zero-candidate --write must be byte-identical (no appended newline)');
      assert.ok(!c1.includes('HYPO:FEEDBACK-SYNC'), 'no managed block when no candidates');
    },
  );
});

test('feedback-sync-stale-side-file-removed: demoting a page deletes its feedback_<slug>.md copy', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, memDir, runFb }) => {
    runFb(['--write']);
    assert.ok(existsSync(join(memDir, 'feedback_rule-a.md')), 'side-file created on first write');
    // demote: flip status to archived so the page is no longer a candidate
    const pagePath = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(
      pagePath,
      readFileSync(pagePath, 'utf-8').replace('status: active', 'status: archived'),
    );
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(
      !existsSync(join(memDir, 'feedback_rule-a.md')),
      'stale side-file must be removed when page is demoted',
    );
  });
});

// ── second-pass review fixes (HIGH cap / HIGH provenance / MEDIUM container / LOW) ──
suite('second-pass review fixes (HIGH cap / HIGH provenance / MEDIUM container / LOW)');

test('feedback-sync-stale-skips-non-sync-file: hand-written feedback_*.md is NOT deleted', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ memDir, runFb }) => {
    // a user's own memory file with the same naming pattern but no provenance header
    const manual = join(memDir, 'feedback_my_manual_note.md');
    writeFileSync(manual, '# my own note, not from sync\n');
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(existsSync(manual), 'non-sync (no provenance header) file must be preserved');
    // and the generated one carries the provenance header
    assert.ok(
      readFileSync(join(memDir, 'feedback_rule-a.md'), 'utf-8').startsWith(
        '<!-- HYPO:FEEDBACK-SYNC source=',
      ),
      'generated side-file must carry provenance header',
    );
  });
});

test('feedback-sync-memory-cap-counts-index-lines-only: 100 one-line entries not over-cap', () => {
  const pages = {};
  for (let i = 1; i <= 100; i++) {
    // project-scoped → MEMORY only (not CLAUDE), one-line index entry each
    pages[`m-${i}`] = { ...FB_PROJECT_L2, title: `M ${i}`, memory_summary: `s${i}` };
  }
  withFeedbackEnv(pages, ({ runFb }) => {
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.memory.candidates, 100);
    assert.equal(
      rep.targets.memory.overCap,
      false,
      '100 one-line index entries (< 200) must not over-cap (markers excluded)',
    );
  });
});

test('feedback-sync-block-outside-container-refuses: managed block outside <learned_behaviors> → exit 3', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      assert.equal(runFb(['--check']).status, 3, 'block outside container must be flagged');
      assert.equal(runFb(['--write']).status, 3, 'write must refuse');
    },
    {
      // a managed block sitting BEFORE the container (drifted/hand-moved)
      claudeMd:
        '# Global\n<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=' +
        '0'.repeat(64) +
        ' -->\n- stray\n<!-- HYPO:FEEDBACK-SYNC:END -->\n<learned_behaviors>\n- manual\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-marker-in-prose-not-counted: mid-line marker text does not trip unpaired', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      // a clean write must still succeed; the prose mention must not be seen as a marker
      assert.equal(runFb(['--write']).status, 0, 'mid-line marker-looking text must be ignored');
    },
    {
      claudeMd:
        '# Global\nExample doc: <!-- HYPO:FEEDBACK-SYNC:START source=x --> appears mid-line here.\n<learned_behaviors>\n- manual\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-write-strict-refuses-before-write: strict warning blocks the write', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, priv: { ...FB_PROJECT_L2, sensitivity: 'private' } },
    ({ claudeHome, runFb }) => {
      const before = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const r = runFb(['--write', '--strict']);
      assert.notEqual(r.status, 0, 'strict warning (private page) must fail');
      assert.equal(
        readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8'),
        before,
        'strict --write must NOT write before failing',
      );
    },
  );
});

// ── doctor.mjs — feedback projection ────────────────────────────

// Build a wiki + claude-home with feedback pages, then run doctor wired to the
// same --claude-home/--project-id used by feedback-sync. Returns the parsed
// `Feedback projection` check entries (doctor's other checks fire on the
// synthetic wiki, so assert on the entry, not the process exit code).
function withDoctorFeedbackEnv(pages, fn, { claudeMd, memoryMd } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-doc-fb-'));
  const wiki = join(base, 'wiki');
  const claudeHome = join(base, 'claude');
  const projectId = 'proj';
  const memDir = join(claudeHome, 'projects', projectId, 'memory');
  try {
    mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '# config');
    for (const [slug, fields] of Object.entries(pages)) {
      writeFileSync(join(wiki, 'pages', 'feedback', `${slug}.md`), fbPage(fields));
    }
    writeFileSync(
      join(claudeHome, 'CLAUDE.md'),
      claudeMd ?? '# Global\n<learned_behaviors>\n- manual entry\n</learned_behaviors>\n',
    );
    writeFileSync(join(memDir, 'MEMORY.md'), memoryMd ?? '# Memory Index\n');
    const runFb = (args) =>
      run('feedback-sync.mjs', [
        ...args,
        `--hypo-dir=${wiki}`,
        `--claude-home=${claudeHome}`,
        `--project-id=${projectId}`,
      ]);
    const runDoctor = () => {
      const r = run('doctor.mjs', [
        `--hypo-dir=${wiki}`,
        `--claude-home=${claudeHome}`,
        `--project-id=${projectId}`,
        '--json',
      ]);
      const checks = JSON.parse(r.stdout);
      return {
        r,
        checks,
        fb: checks.filter((c) => c.label.startsWith('Feedback projection')),
      };
    };
    fn({ base, wiki, claudeHome, projectId, memDir, runFb, runDoctor });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

suite('doctor.mjs — feedback projection (fix #37 #9)');

test('clean (post --write) projection → pass, no fail entry', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb, runDoctor }) => {
    assert.equal(runFb(['--write']).status, 0, 'seed write must succeed');
    const { fb } = runDoctor();
    assert.ok(fb.length >= 1, 'expected a Feedback projection check entry');
    assert.ok(
      fb.every((c) => c.status !== 'fail'),
      `clean projection must not fail: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      fb.some((c) => c.status === 'pass' && c.label === 'Feedback projection'),
      `clean projection should pass: ${JSON.stringify(fb)}`,
    );
  });
});

test('no feedback pages → pass with "no projection candidates"', () => {
  withDoctorFeedbackEnv({}, ({ runDoctor }) => {
    const { fb } = runDoctor();
    assert.ok(
      fb.some((c) => c.status === 'pass' && c.detail.includes('no projection candidates')),
      `expected no-candidates pass: ${JSON.stringify(fb)}`,
    );
  });
});

test('drifted projection (never written) → warn, never fail', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runDoctor }) => {
    const { fb } = runDoctor();
    assert.ok(
      fb.every((c) => c.status !== 'fail'),
      `drift must be warn not fail: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      fb.some((c) => c.status === 'warn' && c.detail.includes('feedback-sync --write')),
      `expected stale-projection warn: ${JSON.stringify(fb)}`,
    );
  });
});

test('tampered managed block (conflict) → fail Feedback projection integrity', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb, claudeHome, runDoctor }) => {
    runFb(['--write']);
    const cp = join(claudeHome, 'CLAUDE.md');
    writeFileSync(cp, readFileSync(cp, 'utf-8').replace('always do A', 'HAND EDITED'));
    const { r, fb } = runDoctor();
    assert.ok(
      fb.some((c) => c.status === 'fail' && c.label === 'Feedback projection integrity'),
      `conflict must fail: ${JSON.stringify(fb)}`,
    );
    assert.equal(r.status, 1, 'doctor exits 1 when any check fails');
  });
});

test('CLAUDE.md without its <learned_behaviors> container → FAIL, not warn (no rules load)', () => {
  // Was a warn. A target that cannot be built loads ZERO L1 rules on that machine
  // and every sync is a silent no-op — nothing else in the system reports it, and
  // it went unnoticed on a real machine. doctor must fail, not murmur.
  withDoctorFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runDoctor }) => {
      const { r, fb } = runDoctor();
      assert.ok(
        fb.some((c) => c.status === 'fail' && /container not found/.test(c.detail)),
        `unbuildable projection must fail: ${JSON.stringify(fb)}`,
      );
      assert.ok(
        fb.some((c) => c.status === 'fail' && /feedback-sync --write/.test(c.detail)),
        `the fail must name the way out: ${JSON.stringify(fb)}`,
      );
      assert.equal(r.status, 1, 'doctor exits 1 when any check fails');
    },
    { claudeMd: '# Global\n\nSomeone deleted the managed container.\n' },
  );
});

test('a build-failed target is never masked by a target-missing one (fail wins over warn)', () => {
  // doctor used to take the FIRST buildError of any kind. With more than one
  // container target, a benign 'target-missing' earlier in iteration order would
  // downgrade a structurally broken target to a warn — re-hiding exactly what this
  // check exists to surface. Latent today (only `claude` has a container), so this
  // pins the selection rule before a second container target makes it live.
  withDoctorFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runDoctor }) => {
      const { fb } = runDoctor();
      assert.ok(
        fb.some((c) => c.status === 'fail' && /container not found/.test(c.detail)),
        `a build-failed target must fail even alongside other buildErrors: ${JSON.stringify(fb)}`,
      );
    },
    { claudeMd: '# Global\n\nNo container.\n' },
  );
});

test('CLAUDE.md file absent entirely → still a WARN (first-run state, not a break)', () => {
  // The counterpart of the promotion above: no ~/.claude/CLAUDE.md yet is the
  // ordinary first-run state. Failing here would fail every new user's doctor run,
  // so buildErrorKind splits it from the structural 'build-failed' case.
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runDoctor }) => {
    rmSync(join(claudeHome, 'CLAUDE.md'), { force: true });
    const { fb } = runDoctor();
    assert.ok(
      fb.every((c) => c.status !== 'fail'),
      `a missing target file must not fail doctor: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      fb.some((c) => c.status === 'warn' && /target file missing/.test(c.detail)),
      `expected a target-missing warn: ${JSON.stringify(fb)}`,
    );
  });
});

test('CLAUDE.md exists but is UNREADABLE (mode 000) → doctor FAILS as build-failed (BLOCKER 5)', () => {
  // existsSync sees the file; readFileSync throws. That used to be an uncaught
  // exception inside feedback-sync.mjs, so `--check --json` produced NO stdout
  // at all — doctor's "feedback-sync produced no JSON report" branch then only
  // warned. An unreadable target must be treated exactly like a missing
  // container: a hard doctor failure, not a shrug.
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runDoctor }) => {
    const claudeMdPath = join(claudeHome, 'CLAUDE.md');
    chmodSync(claudeMdPath, 0o000);
    try {
      const { r, fb } = runDoctor();
      assert.ok(
        fb.some((c) => c.status === 'fail' && /cannot read target file/.test(c.detail)),
        `unreadable target must fail as build-failed: ${JSON.stringify(fb)}`,
      );
      assert.equal(r.status, 1, 'doctor exits 1 when any check fails');
    } finally {
      chmodSync(claudeMdPath, 0o644); // restore so withDoctorFeedbackEnv cleanup can remove it
    }
  });
});

// ── feedback-sync.mjs — project-id fallback ─────────────────────

suite('feedback-sync.mjs — project-id fallback (fix #37 #10)');

// Non-TTY / hook / CI path: derived dir missing → skip MEMORY, exit 0, NO prompt,
// NO hang. The child has no controlling TTY under spawnSync, so this IS the
// non-interactive proof. --no-input makes it explicit + belt-and-suspenders.
test('feedback-sync-no-input-non-tty: derived-missing project-id skips MEMORY, exit 0, no hang', () => {
  // MEMORY-only fixture (project-scoped, no CLAUDE candidate) so the clean run
  // genuinely exits 0 — proving the non-TTY skip path AND a clean exit code.
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome }) => {
    const r = run('feedback-sync.mjs', [
      '--check',
      '--no-input',
      '--json',
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      `--cwd=${join(tmpdir(), 'no-such-cwd-xyz')}`,
    ]);
    // spawnSync returns (no timeout), proving the non-TTY path never blocks.
    assert.equal(r.signal, null, 'process must exit on its own (no hang/kill)');
    assert.equal(r.status, 0, `clean MEMORY-only run must exit 0: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.projectIdResolved, false);
    assert.equal(rep.skipMemory, true, 'skipMemory flag surfaced in report');
    assert.equal(rep.targets.memory, undefined, 'MEMORY skipped on unresolved project-id');
    assert.ok('claude' in rep.targets, 'claude target still evaluated');
  });
});

// --strict must NOT escalate the skip-MEMORY warning. A fresh / external user
// whose ~/.claude/projects/<id>/memory does not exist yet runs the PreCompact
// gate (#3: `--check --strict`); contract §5 step 4 promises this never hard-
// fails. skipMemory is an environmental state, not actionable drift.
test('feedback-sync-strict-does-not-escalate-skip-memory: derived-missing + --strict → exit 0', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome }) => {
    const r = run('feedback-sync.mjs', [
      '--check',
      '--strict',
      '--no-input',
      '--json',
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      `--cwd=${join(tmpdir(), 'no-such-cwd-xyz')}`,
    ]);
    assert.equal(r.signal, null, 'process must exit on its own (no hang)');
    assert.equal(r.status, 0, `skip-MEMORY warning must not be escalated by --strict: ${r.stderr}`);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.skipMemory, true, 'skipMemory still surfaced in report');
  });
});

// Explicit --project-id always wins, no prompt, MEMORY present even on TTY-less run.
test('feedback-sync-explicit-project-id-wins: MEMORY target present, no prompt path', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    const r = runFb(['--check', '--json']); // withFeedbackEnv passes a valid --project-id
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.projectIdResolved, true);
    assert.equal(rep.skipMemory, undefined, 'no skip for explicit project-id');
    assert.ok('memory' in rep.targets, 'MEMORY target present for explicit project-id');
  });
});

// ── feedback-sync.mjs — bootstrap + import ──────────────────

suite('feedback-sync.mjs — bootstrap + import (fix #37 Phase D)');

test('feedback-sync-bootstrap-creates-drafts: legacy surfaces → _drafts scaffolds, idempotent', () => {
  const claudeMd =
    '# Global\n<learned_behaviors>\n' +
    '- [2026-05-20] always run the formatter before commit — 이유: consistency\n' +
    '- [2026-05-19] push after every wiki commit — 이유: hook only pushes staged\n' +
    '</learned_behaviors>\n';
  const memoryMd =
    '# Memory Index\n' +
    '- [Teams usage](feedback_omc_teams_usage.md) — heavy tasks use teams\n' +
    '- [Plain note](some_other_note.md) — not a feedback projection (skipped)\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const r = runFb(['--bootstrap', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const rep = JSON.parse(r.stdout);
      // 2 learned_behaviors + 1 feedback_* memory entry = 3; non-feedback_ entry ignored
      assert.equal(rep.created.length, 3, `expected 3 drafts, got ${rep.created.length}`);
      const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
      const files = readdirSync(draftsDir);
      assert.ok(
        files.some((f) => f.startsWith('legacy-claude-20260520-')),
        'claude draft slug',
      );
      assert.ok(files.includes('omc-teams-usage.md'), 'memory slug: feedback_ stripped, _→-');
      assert.ok(!files.some((f) => f.includes('some-other-note')), 'non-feedback_ entry skipped');
      const draft = readFileSync(join(draftsDir, 'omc-teams-usage.md'), 'utf-8');
      assert.ok(draft.startsWith('<!-- HYPO:FEEDBACK-SYNC:DRAFT'), 'provenance marker present');
      assert.ok(/^type: feedback$/m.test(draft) && /^scope:/m.test(draft), 'frontmatter scaffold');
      // idempotent: second run creates nothing, all skipped as draft-exists
      const r2 = JSON.parse(runFb(['--bootstrap', '--json']).stdout);
      assert.equal(r2.created.length, 0, 'second bootstrap creates nothing');
      assert.ok(
        r2.skipped.length >= 3 && r2.skipped.every((s) => s.reason === 'draft-exists'),
        'all skipped as draft-exists',
      );
    },
    { claudeMd, memoryMd },
  );
});

test('feedback-sync-bootstrap-dry-run-writes-nothing: --dry-run reports but creates no files', () => {
  const claudeMd =
    '# Global\n<learned_behaviors>\n- [2026-05-20] a rule — 이유: x\n</learned_behaviors>\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const rep = JSON.parse(runFb(['--bootstrap', '--dry-run', '--json']).stdout);
      assert.equal(rep.dryRun, true);
      assert.ok(rep.created.length >= 1, 'dry-run still reports planned drafts');
      assert.ok(!existsSync(join(wiki, 'pages', 'feedback', '_drafts')), 'no _drafts dir written');
    },
    { claudeMd },
  );
});

test('feedback-sync-import-target-change: hand-edited block → draft, SoT page untouched', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    runFb(['--write']); // project rule-a into CLAUDE.md
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED externally'));
    assert.equal(runFb(['--check']).status, 3, 'precondition: conflict detected');
    const r = runFb(['--import-target-change', '--from=claude', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.imported.length, 1);
    assert.equal(rep.imported[0].slug, 'rule-a');
    const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
    const f = readdirSync(draftsDir).find((x) => x.startsWith('rule-a.import-'));
    assert.ok(f, 'import draft created with import-<date> suffix');
    assert.ok(
      readFileSync(join(draftsDir, f), 'utf-8').includes('HAND EDITED externally'),
      'draft captures the hand-edited content',
    );
    assert.ok(
      !readFileSync(join(wiki, 'pages', 'feedback', 'rule-a.md'), 'utf-8').includes('HAND EDITED'),
      'pages/feedback/rule-a.md (SoT) must not be modified',
    );
  });
});

test('feedback-sync-import-no-conflict-noop: clean target imports nothing, exit 0', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    runFb(['--write']);
    const r = runFb(['--import-target-change', '--from=claude', '--json']);
    assert.equal(r.status, 0);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.imported.length, 0, 'no conflict → nothing imported');
    // report shape contract: `skipped` is added only in the conflict path
    // (loadImportConflicts/runImport), so the no-conflict report must NOT grow it.
    assert.ok(!('skipped' in rep), 'no-conflict import report must not carry a skipped field');
  });
});

test('feedback-sync-import-bad-from-errors: missing/invalid --from → exit 1', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb }) => {
    assert.equal(runFb(['--import-target-change']).status, 1, 'missing --from rejected');
    assert.equal(
      runFb(['--import-target-change', '--from=bogus']).status,
      1,
      'invalid --from rejected',
    );
  });
});

test('feedback-sync-bootstrap-traversal-slug-stays-in-drafts: MEMORY ../ neutralized, pure-dots rejected', () => {
  // codex BLOCKER regression: a crafted `feedback_../escaped.md` must NOT escape
  // _drafts into pages/feedback/. basename() collapses traversal to the final
  // segment; a slug that reduces to nothing (`..`) is rejected as unsafe-slug.
  const memoryMd =
    '# Memory Index\n' +
    '- [Evil](feedback_../escaped.md) — traversal collapses to basename\n' +
    '- [Dots](feedback_...md) — reduces to nothing, rejected\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const rep = JSON.parse(runFb(['--bootstrap', '--json']).stdout);
      assert.ok(
        !existsSync(join(wiki, 'pages', 'feedback', 'escaped.md')),
        'must not escape into pages/feedback/',
      );
      assert.ok(
        existsSync(join(wiki, 'pages', 'feedback', '_drafts', 'escaped.md')),
        'traversal neutralized to a draft under _drafts',
      );
      assert.ok(
        rep.skipped.some((s) => s.reason === 'unsafe-slug'),
        'pure-dots slug rejected as unsafe-slug',
      );
    },
    { memoryMd },
  );
});

test('feedback-sync-bootstrap-skips-managed-memory-block: projected MEMORY entries not re-drafted', () => {
  // codex IMPORTANT regression: parseMemoryIndex must scrub HYPO:FEEDBACK-SYNC
  // managed regions (parity with parseLearnedBehaviors) so already-projected
  // index lines are not resurrected as legacy drafts.
  const memoryMd =
    '# Memory Index\n' +
    `<!-- HYPO:FEEDBACK-SYNC:START source=managed-x sha256=${'a'.repeat(64)} -->\n` +
    '- [Managed X](feedback_managed_x.md) — already projected\n' +
    '<!-- HYPO:FEEDBACK-SYNC:END -->\n' +
    '- [Loose Y](feedback_loose_y.md) — legacy hand entry\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      runFb(['--bootstrap']);
      const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
      const drafts = existsSync(draftsDir) ? readdirSync(draftsDir) : [];
      assert.ok(drafts.includes('loose-y.md'), 'loose legacy MEMORY entry is drafted');
      assert.ok(!drafts.includes('managed-x.md'), 'managed-block entry must NOT be re-drafted');
    },
    { memoryMd },
  );
});

test('feedback-sync-import-traversal-source-stays-in-drafts: tampered source= neutralized', () => {
  // codex BLOCKER regression: a tampered `source=../escaped` managed marker must
  // not let --import write outside _drafts.
  const claudeMd =
    '# Global\n<learned_behaviors>\n' +
    `<!-- HYPO:FEEDBACK-SYNC:START source=../escaped sha256=${'0'.repeat(64)} -->\n` +
    'tampered inner content\n' +
    '<!-- HYPO:FEEDBACK-SYNC:END -->\n' +
    '</learned_behaviors>\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      const r = runFb(['--import-target-change', '--from=claude', '--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(
        !readdirSync(join(wiki, 'pages', 'feedback')).some((f) => f.includes('escaped')),
        'nothing named escaped at pages/feedback top level',
      );
      assert.ok(
        readdirSync(join(wiki, 'pages', 'feedback', '_drafts')).some((f) =>
          f.startsWith('escaped.import-claude-'),
        ),
        'tampered source neutralized into _drafts',
      );
    },
    { claudeMd },
  );
});

test('feedback-sync-import-no-clobber: re-import same day preserves the prior draft', () => {
  // codex IMPORTANT regression: a same-day re-import (or human-edited draft) must
  // not be overwritten — the writer picks a collision-free numbered name.
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    runFb(['--write']);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    runFb(['--import-target-change', '--from=claude']);
    const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
    const first = readdirSync(draftsDir).find((x) => x.startsWith('rule-a.import-claude-'));
    writeFileSync(join(draftsDir, first), 'HUMAN RECONCILED');
    runFb(['--import-target-change', '--from=claude']); // second import, same day
    assert.equal(
      readFileSync(join(draftsDir, first), 'utf-8'),
      'HUMAN RECONCILED',
      'prior (human-edited) draft must be preserved',
    );
    assert.equal(
      readdirSync(draftsDir).filter((x) => x.startsWith('rule-a.import-claude-')).length,
      2,
      'second import created a new numbered draft, not a clobber',
    );
  });
});

// ── Track B: per-mode source-loader golden (byte-identical characterization) ──
// Locks the complete observable output of each mode so the source-loader refactor
// (Track B) can be proven byte-identical: same fixture → same golden before and
// after the extraction. Each mode runs twice in fresh envs — once with --json,
// once plain — and BOTH streams are captured for each run (exit code, stdout,
// stderr), so the snapshot also pins that --json emits nothing to stderr and the
// plain run emits nothing to stdout. The plain run additionally snapshots every
// on-disk artifact (files + draft listing). Volatile bytes (tmp base path, import
// draft date-stamp) are masked.
const fbNorm = (base) => (s) =>
  String(s)
    .split(base)
    .join('<BASE>')
    .replace(/import-(claude|memory)-\d{8}/g, 'import-$1-<STAMP>');

function fbSnapshotFiles(norm, wiki, claudeHome, memDir) {
  const out = [];
  const collect = (label, p) => {
    if (existsSync(p)) out.push(`### FILE ${label}\n${norm(readFileSync(p, 'utf-8'))}`);
  };
  collect('CLAUDE.md', join(claudeHome, 'CLAUDE.md'));
  collect('MEMORY.md', join(memDir, 'MEMORY.md'));
  for (const f of (existsSync(memDir) ? readdirSync(memDir) : [])
    .filter((f) => /^feedback_.+\.md$/.test(f))
    .sort())
    collect(f, join(memDir, f));
  const draftsDir = join(wiki, 'pages', 'feedback', '_drafts');
  const draftList = (existsSync(draftsDir) ? readdirSync(draftsDir) : []).sort();
  out.push(`### DRAFT_LIST\n${draftList.map(norm).join('\n')}`);
  for (const f of draftList)
    out.push(`### DRAFT ${norm(f)}\n${norm(readFileSync(join(draftsDir, f), 'utf-8'))}`);
  return out;
}

function fbGolden(pages, opts, setup, baseArgs) {
  let jsonPart, plainPart;
  withFeedbackEnv(
    pages,
    (ctx) => {
      setup(ctx);
      const norm = fbNorm(ctx.base);
      const res = ctx.runFb([...baseArgs, '--json']);
      jsonPart = [
        '=== JSON-RUN ===',
        `STATUS ${res.status}`,
        `STDOUT\n${norm(res.stdout)}`,
        `STDERR\n${norm(res.stderr)}`,
      ];
    },
    opts,
  );
  withFeedbackEnv(
    pages,
    (ctx) => {
      setup(ctx);
      const norm = fbNorm(ctx.base);
      const res = ctx.runFb(baseArgs);
      plainPart = [
        '=== PLAIN-RUN ===',
        `STATUS ${res.status}`,
        `STDOUT\n${norm(res.stdout)}`,
        `STDERR\n${norm(res.stderr)}`,
        ...fbSnapshotFiles(norm, ctx.wiki, ctx.claudeHome, ctx.memDir),
      ];
    },
    opts,
  );
  return [...jsonPart, ...plainPart].join('\n');
}

const FB_GOLDEN_WRITE = `=== JSON-RUN ===
STATUS 0
STDOUT
{
  "mode": "write",
  "projectId": "proj",
  "projectIdResolved": true,
  "targets": {
    "memory": {
      "candidates": 2,
      "conflicts": [],
      "unpaired": false,
      "intruder": false,
      "outOfContainer": false,
      "overCap": false,
      "dirty": true
    },
    "claude": {
      "candidates": 1,
      "conflicts": [],
      "unpaired": false,
      "intruder": false,
      "outOfContainer": false,
      "overCap": false,
      "dirty": true
    }
  }
}

STDERR

=== PLAIN-RUN ===
STATUS 0
STDOUT

STDERR
[feedback-sync] projections written.

### FILE CLAUDE.md
# Global
<learned_behaviors>
- manual entry
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=829952d557370646323ab1630c165ce8d6edcd45d5a1a5836f79bb631a944032 -->
- [2026-05-20] always do A — 근거: [[rule-a]]
<!-- HYPO:FEEDBACK-SYNC:END -->
</learned_behaviors>

### FILE MEMORY.md
# Memory Index
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=1b742d57d519e1715e7d3e36ccac73617147022a5ab69cbaf2f09f525ca379aa -->
- [Rule A](feedback_rule-a.md) — do A
<!-- HYPO:FEEDBACK-SYNC:END -->
<!-- HYPO:FEEDBACK-SYNC:START source=rule-b sha256=7a8c12be4e66e219b61ebb46543f84cf8935386fe2b8dcb1d351c37fd55e59e1 -->
- [Rule B](feedback_rule-b.md) — do B
<!-- HYPO:FEEDBACK-SYNC:END -->

### FILE feedback_rule-a.md
<!-- HYPO:FEEDBACK-SYNC source=rule-a -->
---
title: Rule A
type: feedback
status: active
scope: global
tier: L1
targets: [project-memory, claude-learned]
sensitivity: public
priority: 5
memory_summary: do A
global_summary: always do A
promote_to_global: true
reason: because A
source: session:2026-05-20
updated: 2026-05-20
---
body

### FILE feedback_rule-b.md
<!-- HYPO:FEEDBACK-SYNC source=rule-b -->
---
title: Rule B
type: feedback
status: active
scope: project:proj
tier: L2
targets: [project-memory]
sensitivity: public
priority: 2
memory_summary: do B
reason: because B
source: session:2026-05-19
updated: 2026-05-19
---
body

### DRAFT_LIST
`;

const FB_GOLDEN_BOOTSTRAP = `=== JSON-RUN ===
STATUS 0
STDOUT
{
  "mode": "bootstrap",
  "dryRun": false,
  "created": [
    {
      "slug": "legacy-claude-20260501-legacy-rule-one",
      "origin": "claude-learned",
      "path": "<BASE>/wiki/pages/feedback/_drafts/legacy-claude-20260501-legacy-rule-one.md"
    },
    {
      "slug": "loose-y",
      "origin": "memory-index",
      "path": "<BASE>/wiki/pages/feedback/_drafts/loose-y.md"
    }
  ],
  "skipped": []
}

STDERR

=== PLAIN-RUN ===
STATUS 0
STDOUT

STDERR
[feedback-sync] created draft: pages/feedback/_drafts/legacy-claude-20260501-legacy-rule-one.md (claude-learned)
[feedback-sync] created draft: pages/feedback/_drafts/loose-y.md (memory-index)
[feedback-sync] bootstrap: 2 created, 0 skipped. Fill scope/tier/targets/promote_to_global and move into pages/feedback/.

### FILE CLAUDE.md
# Global
<learned_behaviors>
- [2026-05-01] legacy rule one
</learned_behaviors>

### FILE MEMORY.md
# Memory Index
- [Loose Y](feedback_loose_y.md) — legacy hand entry

### DRAFT_LIST
legacy-claude-20260501-legacy-rule-one.md
loose-y.md
### DRAFT legacy-claude-20260501-legacy-rule-one.md
<!-- HYPO:FEEDBACK-SYNC:DRAFT origin=claude-learned -->
---
title: legacy rule one
type: feedback
status: draft
scope: TODO              # global | project:<project-id>
tier: TODO               # L1 (CLAUDE.md <learned_behaviors> candidate) | L2
targets: [project-memory]   # + claude-learned for a global L1 rule
sensitivity: public      # public | sanitized (private is forbidden)
priority: 3              # 1-5, higher wins over-cap
memory_summary: legacy rule one
global_summary: legacy rule one
promote_to_global: false # set true to project into <learned_behaviors>
reason: TODO
source: session:2026-05-01
created: 2026-05-01
updated: 2026-05-01
bootstrap_origin: claude-learned
---

# legacy rule one

legacy rule one

### DRAFT loose-y.md
<!-- HYPO:FEEDBACK-SYNC:DRAFT origin=memory-index -->
---
title: Loose Y
type: feedback
status: draft
scope: TODO              # global | project:<project-id>
tier: TODO               # L1 (CLAUDE.md <learned_behaviors> candidate) | L2
targets: [project-memory]   # + claude-learned for a global L1 rule
sensitivity: public      # public | sanitized (private is forbidden)
priority: 3              # 1-5, higher wins over-cap
memory_summary: legacy hand entry
global_summary: legacy hand entry
promote_to_global: false # set true to project into <learned_behaviors>
reason: TODO
source: TODO
bootstrap_origin: memory-index
---

# Loose Y

legacy hand entry
`;

const FB_GOLDEN_IMPORT = `=== JSON-RUN ===
STATUS 0
STDOUT
{
  "mode": "import",
  "from": "claude",
  "dryRun": false,
  "imported": [
    {
      "slug": "rule-a",
      "path": "<BASE>/wiki/pages/feedback/_drafts/rule-a.import-claude-<STAMP>.md"
    }
  ],
  "skipped": []
}

STDERR

=== PLAIN-RUN ===
STATUS 0
STDOUT

STDERR
[feedback-sync] imported rule-a → <BASE>/wiki/pages/feedback/_drafts/rule-a.import-claude-<STAMP>.md
[feedback-sync] import: 1 draft(s). Reconcile into the SoT page, then feedback-sync --write.

### FILE CLAUDE.md
# Global
<learned_behaviors>
- manual entry
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=829952d557370646323ab1630c165ce8d6edcd45d5a1a5836f79bb631a944032 -->
- [2026-05-20] HAND EDITED — 근거: [[rule-a]]
<!-- HYPO:FEEDBACK-SYNC:END -->
</learned_behaviors>

### FILE MEMORY.md
# Memory Index
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=1b742d57d519e1715e7d3e36ccac73617147022a5ab69cbaf2f09f525ca379aa -->
- [Rule A](feedback_rule-a.md) — do A
<!-- HYPO:FEEDBACK-SYNC:END -->

### FILE feedback_rule-a.md
<!-- HYPO:FEEDBACK-SYNC source=rule-a -->
---
title: Rule A
type: feedback
status: active
scope: global
tier: L1
targets: [project-memory, claude-learned]
sensitivity: public
priority: 5
memory_summary: do A
global_summary: always do A
promote_to_global: true
reason: because A
source: session:2026-05-20
updated: 2026-05-20
---
body

### DRAFT_LIST
rule-a.import-claude-<STAMP>.md
### DRAFT rule-a.import-claude-<STAMP>.md
<!-- HYPO:FEEDBACK-SYNC:DRAFT origin=import-claude -->
---
title: imported rule-a
type: feedback
status: draft
scope: TODO
tier: TODO
targets: [project-memory]
sensitivity: public
priority: 3
memory_summary: - [2026-05-20] HAND EDITED — 근거: [[rule-a]]
global_summary: - [2026-05-20] HAND EDITED — 근거: [[rule-a]]
promote_to_global: false
reason: imported from claude <learned_behaviors>/MEMORY managed block (hand-edited)
source: TODO
imported_from: claude
---

# imported rule-a

> The managed block below was edited outside the wiki. Reconcile it into
> pages/feedback/rule-a.md (the SoT), then re-run feedback-sync --write.

- [2026-05-20] HAND EDITED — 근거: [[rule-a]]
`;

// ── CONCERN 6: --ensure-container — the provisioning path a blocker can
// actually name. A gate that detects a missing container but names no way to
// create one gets bypassed, not obeyed; --ensure-container is that way.
suite('feedback-sync.mjs — --ensure-container (CONCERN 6 provisioning path)');

test('--ensure-container: file exists WITHOUT a container → appends an empty pair, preserves content', () => {
  withFeedbackEnv(
    {},
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      const before = '# Global\n\nSome hand-written prose the user cares about.\n';
      writeFileSync(claudeMdPath, before);
      const r = runFb(['--ensure-container', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const rep = JSON.parse(r.stdout);
      assert.equal(rep.action, 'created');
      const after = readFileSync(claudeMdPath, 'utf-8');
      assert.ok(after.startsWith(before), 'existing content must be preserved verbatim, untouched');
      assert.ok(after.includes('<learned_behaviors>'));
      assert.ok(after.includes('</learned_behaviors>'));
      assert.ok(
        after.indexOf('<learned_behaviors>') < after.indexOf('</learned_behaviors>'),
        'open tag must precede close tag',
      );
    },
    { claudeMd: '# placeholder' }, // overwritten before --ensure-container runs
  );
});

test('--ensure-container: a container the file ALREADY has → no-op (idempotent, byte-identical)', () => {
  withFeedbackEnv({}, ({ claudeHome, runFb }) => {
    const claudeMdPath = join(claudeHome, 'CLAUDE.md');
    const before = readFileSync(claudeMdPath, 'utf-8'); // withFeedbackEnv default already has a container
    const r = runFb(['--ensure-container', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.action, 'noop-already-present');
    assert.equal(readFileSync(claudeMdPath, 'utf-8'), before, 'no bytes must change');
  });
});

test('--ensure-container: file does not exist at all → no-op, no file created (first-run stays first-run)', () => {
  withFeedbackEnv({}, ({ claudeHome, runFb }) => {
    const claudeMdPath = join(claudeHome, 'CLAUDE.md');
    rmSync(claudeMdPath, { force: true });
    const r = runFb(['--ensure-container', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.action, 'target-missing');
    assert.ok(
      !existsSync(claudeMdPath),
      '--ensure-container must not create the file from nothing',
    );
  });
});

test('--ensure-container is idempotent across TWO real runs (created, then no-op, same bytes)', () => {
  withFeedbackEnv(
    {},
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      writeFileSync(claudeMdPath, '# Global\n\nprose\n');
      assert.equal(runFb(['--ensure-container']).status, 0);
      const afterFirst = readFileSync(claudeMdPath, 'utf-8');
      assert.equal(runFb(['--ensure-container']).status, 0);
      assert.equal(
        readFileSync(claudeMdPath, 'utf-8'),
        afterFirst,
        'a second run must change nothing',
      );
    },
    { claudeMd: '# placeholder' },
  );
});

test('--ensure-container then --write succeeds (the container it created is a valid placement target)', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      writeFileSync(claudeMdPath, '# Global\n\nprose\n');
      assert.equal(runFb(['--ensure-container']).status, 0);
      assert.equal(
        runFb(['--write']).status,
        0,
        'write must succeed into the just-created container',
      );
      const content = readFileSync(claudeMdPath, 'utf-8');
      assert.ok(content.includes('HYPO:FEEDBACK-SYNC:START'));
      assert.ok(
        content.includes('prose'),
        'original content must survive the whole ensure+write flow',
      );
    },
    { claudeMd: '# placeholder' },
  );
});

test('the hook blocker for a build-failed target names --ensure-container and the exact path/tag', () => {
  // CONCERN 6: "restore the managed container in the target file" alone names
  // neither WHICH file nor WHAT tag — this pins that the reason string a real
  // session sees carries both, plus the executable remedy command.
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-ensure-msg-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
        writeFileSync(claudeMdPath, '# Global\n\nNo container here.\n');
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.equal(out.decision, 'block');
        assert.ok(
          out.reason.includes(claudeMdPath),
          `blocker reason must name the exact target path: ${out.reason}`,
        );
        assert.ok(
          out.reason.includes('<learned_behaviors></learned_behaviors>'),
          `blocker reason must name the literal container tag pair: ${out.reason}`,
        );
        assert.match(
          out.reason,
          /--ensure-container/,
          'blocker reason must name the remedy command',
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('doctor names --ensure-container and the exact path for a build-failed target', () => {
  withDoctorFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runDoctor }) => {
      const { fb } = runDoctor();
      const hit = fb.find((c) => c.status === 'fail' && /container not found/.test(c.detail));
      assert.ok(hit, `expected a build-failed fail entry: ${JSON.stringify(fb)}`);
      assert.ok(
        hit.detail.includes(join(claudeHome, 'CLAUDE.md')),
        `doctor detail must name the exact target path: ${hit.detail}`,
      );
      assert.match(hit.detail, /--ensure-container/, 'doctor remedy must name the command');
    },
    { claudeMd: '# Global\n\nNo container.\n' },
  );
});

// ── BLOCKER 1: --ensure-container overwrote the user's global config with a
// truncating writeFileSync. The ONE command that promises "existing content is
// never touched" was the one that could shred it: a crash / a full disk between
// the truncate and the write leaves ~/.claude/CLAUDE.md cut in half. Every write
// goes through tmp+rename now.
suite('feedback-sync.mjs — atomic writes + symlink safety (BLOCKER 1)');

test('--ensure-container writes via tmp+rename (the target inode CHANGES, no tmp left behind)', () => {
  // The direct, unfakeable signature of tmp+rename: rename(2) swaps a NEW inode
  // into the path. An in-place writeFileSync keeps the old inode. Turn atomicWrite
  // back into writeFileSync and this assertion goes red immediately.
  if (process.platform === 'win32') return;
  withFeedbackEnv(
    {},
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      const before = '# Global\n\nProse the user cares about.\n';
      writeFileSync(claudeMdPath, before);
      const inoBefore = statSync(claudeMdPath).ino;
      assert.equal(runFb(['--ensure-container']).status, 0);
      const after = readFileSync(claudeMdPath, 'utf-8');
      assert.ok(after.startsWith(before), 'every existing byte must survive verbatim');
      assert.notEqual(
        statSync(claudeMdPath).ino,
        inoBefore,
        'a tmp+rename write replaces the inode; an in-place overwrite would keep it',
      );
      assert.deepEqual(
        readdirSync(claudeHome).filter((f) => f.endsWith('.tmp')),
        [],
        'no tmp file may be left behind',
      );
    },
    { claudeMd: '# placeholder' },
  );
});

test('--write writes the projection via tmp+rename too (inode changes, content correct)', () => {
  if (process.platform === 'win32') return;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, memDir, runFb }) => {
    const claudeMdPath = join(claudeHome, 'CLAUDE.md');
    const inoBefore = statSync(claudeMdPath).ino;
    assert.equal(runFb(['--write']).status, 0);
    assert.notEqual(statSync(claudeMdPath).ino, inoBefore, 'projection write must be atomic too');
    assert.ok(readFileSync(claudeMdPath, 'utf-8').includes('HYPO:FEEDBACK-SYNC:START'));
    assert.deepEqual(
      readdirSync(claudeHome).filter((f) => f.endsWith('.tmp')),
      [],
      'no tmp file left in the claude home',
    );
    assert.deepEqual(
      readdirSync(memDir).filter((f) => f.endsWith('.tmp')),
      [],
      'no tmp file left in the memory dir',
    );
  });
});

test('--ensure-container: a FAILED write leaves the original file byte-identical', () => {
  // The whole point of tmp+rename. The tmp write fails (read-only directory), so
  // the rename never runs and the target keeps every byte it had. The old
  // writeFileSync path would have opened the EXISTING file for writing (the
  // directory mode does not gate that), truncated it, and written the new content.
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withFeedbackEnv(
    {},
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      const before = '# Global\n\nIrreplaceable hand-written prose.\n';
      writeFileSync(claudeMdPath, before);
      chmodSync(claudeHome, 0o500); // dir not writable → the tmp file cannot be created
      try {
        const r = runFb(['--ensure-container']);
        assert.notEqual(r.status, 0, 'a write that cannot complete must fail loudly');
        assert.equal(
          readFileSync(claudeMdPath, 'utf-8'),
          before,
          'a failed atomic write must not have touched the original file',
        );
      } finally {
        chmodSync(claudeHome, 0o700);
      }
    },
    { claudeMd: '# placeholder' },
  );
});

test('--ensure-container follows a SYMLINKED CLAUDE.md and writes the real file (link survives)', () => {
  // A dotfile repo linking ~/.claude/CLAUDE.md into a git checkout is a common
  // setup. The tmp must land beside the REAL file (same filesystem → the rename is
  // atomic) and must replace the real file, not clobber the link with a regular one.
  if (process.platform === 'win32') return;
  withFeedbackEnv(
    {},
    ({ base, claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      const realPath = join(base, 'dotfiles-CLAUDE.md');
      const before = '# Global (kept in a dotfile repo)\n';
      writeFileSync(realPath, before);
      rmSync(claudeMdPath, { force: true });
      symlinkSync(realPath, claudeMdPath);
      assert.equal(runFb(['--ensure-container']).status, 0);
      assert.ok(lstatSync(claudeMdPath).isSymbolicLink(), 'the symlink must still be a symlink');
      const real = readFileSync(realPath, 'utf-8');
      assert.ok(real.startsWith(before), 'the real file keeps its content');
      assert.ok(real.includes('<learned_behaviors>'), 'the container lands in the REAL file');
    },
    { claudeMd: '# placeholder' },
  );
});

test('a DANGLING symlink target is build-failed, not target-missing (existsSync lies about it)', () => {
  // existsSync FOLLOWS the link and finds nothing, so a broken link read as the
  // benign first-run state: the gate stayed green with zero rules loaded, and a
  // --write would have replaced the link with a regular file.
  if (process.platform === 'win32') return;
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ base, claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      rmSync(claudeMdPath, { force: true });
      symlinkSync(join(base, 'no-such-file.md'), claudeMdPath);
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(
        rep.targets.claude.buildErrorKind,
        'build-failed',
        `a dangling symlink must not pass as the benign first-run state: ${JSON.stringify(rep.targets.claude)}`,
      );
      assert.match(rep.targets.claude.buildError, /dangling symlink/);
      // and --ensure-container must not silently no-op on it either
      const ens = runFb(['--ensure-container']);
      assert.notEqual(ens.status, 0, '--ensure-container must fail on a dangling symlink');
      assert.match(ens.stderr, /dangling symlink/);
      assert.ok(
        !existsSync(join(base, 'no-such-file.md')),
        '--ensure-container must not materialize the missing link target',
      );
    },
    { claudeMd: '# placeholder' },
  );
});

// ── BLOCKER 2: the container predicate was a first-occurrence substring search.
// Inverted tags made it read false FOREVER (so --ensure-container appended pair
// after pair and --write never succeeded — a state the tool created and could not
// leave), and a pair inside a comment or a fence made it read true (so the region
// was written into inert text).
suite('feedback-sync.mjs — container classification (BLOCKER 2)');

const LB_PAIR = '<learned_behaviors>\n</learned_behaviors>';

test('INVERTED tags (close before open) are build-failed, and --ensure-container REFUSES to append', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      const before = readFileSync(claudeMdPath, 'utf-8');
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(
        rep.targets.claude.buildErrorKind,
        'build-failed',
        `inverted tags are corruption, not "no container": ${JSON.stringify(rep.targets.claude)}`,
      );
      assert.match(rep.targets.claude.buildError, /corrupt/i);
      const ens = runFb(['--ensure-container']);
      assert.notEqual(ens.status, 0, '--ensure-container must FAIL rather than append');
      assert.match(ens.stderr, /refusing to append/i);
      assert.match(ens.stderr, /BY HAND/);
      assert.equal(
        readFileSync(claudeMdPath, 'utf-8'),
        before,
        'a refusing --ensure-container must not add a single byte (a blind append is unfixable)',
      );
    },
    { claudeMd: '# Global\n</learned_behaviors>\n<learned_behaviors>\n' },
  );
});

test('the corrupt-container remedy is a HAND repair, never `--ensure-container` (it refuses)', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      const remedy = rep.targets.claude.buildErrorRemedy || '';
      assert.match(remedy, /BY HAND/, `remedy must send the human to a hand repair: ${remedy}`);
      assert.ok(
        !/Run `hypomnema feedback-sync --ensure-container`/.test(remedy),
        `remedy must not name a command that refuses this exact case: ${remedy}`,
      );
    },
    { claudeMd: '# Global\n</learned_behaviors>\n<learned_behaviors>\n' },
  );
});

test('DUPLICATE container pairs are build-failed (which pair owns the region is unanswerable)', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(rep.targets.claude.buildErrorKind, 'build-failed');
      assert.match(rep.targets.claude.buildError, /2 opening and 2 closing/);
    },
    { claudeMd: `# Global\n${LB_PAIR}\n\n## Later\n${LB_PAIR}\n` },
  );
});

test('an UNPAIRED open tag is build-failed (a CLAUDE.md that merely quotes the tag in prose)', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(rep.targets.claude.buildErrorKind, 'build-failed');
      assert.match(rep.targets.claude.buildError, /no closing/);
    },
    { claudeMd: '# Global\n<learned_behaviors>\n- a rule with no closing tag\n' },
  );
});

test('a container inside an HTML COMMENT does not count as present (scenario B)', () => {
  // --ensure-container used to no-op ("already there") and placement wrote the
  // managed region INSIDE the comment, where nothing reads it — and the hook then
  // saw that as ordinary drift and kept rewriting it, forever.
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      const claudeMdPath = join(claudeHome, 'CLAUDE.md');
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(
        rep.targets.claude.buildErrorKind,
        'build-failed',
        'a commented-out pair is not a container',
      );
      assert.match(rep.targets.claude.buildError, /container not found/);
      // ensure-container must PROVISION a real one, not no-op
      assert.equal(runFb(['--ensure-container']).status, 0);
      const after = readFileSync(claudeMdPath, 'utf-8');
      assert.equal(runFb(['--write']).status, 0, 'the provisioned container must be writable');
      const written = readFileSync(claudeMdPath, 'utf-8');
      const block = written.indexOf('HYPO:FEEDBACK-SYNC:START');
      const commentEnd = written.indexOf('-->');
      assert.ok(block > commentEnd, 'the managed region must land OUTSIDE the HTML comment');
      assert.ok(after.includes('<!-- example:'), 'the example comment itself is left alone');
    },
    {
      claudeMd:
        '# Global\n<!-- example: <learned_behaviors></learned_behaviors> goes here -->\n\nprose\n',
    },
  );
});

test('a container inside a CODE FENCE does not count as present', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(rep.targets.claude.buildErrorKind, 'build-failed');
      assert.match(rep.targets.claude.buildError, /container not found/);
    },
    { claudeMd: `# Global\n\n\`\`\`md\n${LB_PAIR}\n\`\`\`\n` },
  );
});

test('a container quoted in INLINE CODE does not make a real container look duplicated', () => {
  // A CLAUDE.md that mentions the tag in prose (`<learned_behaviors>`) alongside
  // the real container must still be PRESENT, not corrupt — otherwise documenting
  // the mechanism breaks it.
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0, 'a prose mention must not break the container');
      const c = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const open = c.indexOf('\n<learned_behaviors>');
      const block = c.indexOf('HYPO:FEEDBACK-SYNC:START');
      assert.ok(
        block > open,
        'the region lands inside the REAL container, not at the prose mention',
      );
    },
    {
      claudeMd:
        '# Global\n\nNever hand-edit `<learned_behaviors>` or `</learned_behaviors>` — it is a projection.\n\n<learned_behaviors>\n</learned_behaviors>\n',
    },
  );
});

// ── CONCERN 7: a side-file I/O error hard-blocked /compact and the blocker named
// `--ensure-container`, a command that only ever touches CLAUDE.md and could not
// fix a permission bit if it tried. A gate whose own named remedy cannot open it.
suite('feedback-sync.mjs — side-file I/O is a warning, not a blocker (CONCERN 7)');

test('an unreadable side file is a sideWarning, NOT build-failed', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const side = join(memDir, 'feedback_rule-a.md');
    chmodSync(side, 0o000);
    try {
      const r = runFb(['--check', '--json']);
      const rep = JSON.parse(r.stdout);
      assert.equal(
        rep.targets.memory.buildError,
        undefined,
        `a side-file permission error must not be a build failure: ${r.stdout}`,
      );
      assert.ok(
        (rep.targets.memory.sideWarnings || []).some((w) => /cannot read side file/.test(w)),
        `it must still be REPORTED, never swallowed: ${r.stdout}`,
      );
      assert.match(
        rep.targets.memory.sideWarnings.join(' '),
        /feedback_rule-a\.md/,
        'the warning must name the exact path whose permissions need fixing',
      );
    } finally {
      chmodSync(side, 0o644);
    }
  });
});

test('an unreadable side file does NOT block /compact (the hook reports a notice)', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-sidefile-'));
      const projectId = process.cwd().replace(/[/.]/g, '-');
      const memDir = join(home, '.claude', 'projects', projectId, 'memory');
      try {
        mkdirSync(memDir, { recursive: true });
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
        writeFileSync(
          join(home, '.claude', 'CLAUDE.md'),
          '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
        );
        writeFileSync(join(memDir, 'MEMORY.md'), '# Memory Index\n');
        // a sync-owned side file the process cannot read
        const side = join(memDir, 'feedback_rule-a.md');
        writeFileSync(side, '<!-- HYPO:FEEDBACK-SYNC source=rule-a -->\nstale\n');
        chmodSync(side, 0o000);
        try {
          const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
          const out = JSON.parse(r.stdout);
          assert.notEqual(
            out.decision,
            'block',
            `a side-file permission error must not block /compact: ${r.stdout}`,
          );
          // Non-vacuity: prove the MEMORY target really was evaluated here (a
          // skipped target would make the assertion above pass for free). The
          // unreadable side file reads as drift, so the gate's self-heal --write
          // rewrites it — atomically, over a file it could not even read.
          chmodSync(side, 0o644);
          assert.match(
            readFileSync(side, 'utf-8'),
            /HYPO:FEEDBACK-SYNC source=rule-a/,
            'the memory target must actually have been evaluated and re-synced',
          );
        } finally {
          chmodSync(side, 0o644);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('a PRIMARY target I/O error still BLOCKS, and its remedy is the permission fix (not --ensure-container)', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    const claudeMdPath = join(claudeHome, 'CLAUDE.md');
    chmodSync(claudeMdPath, 0o000);
    try {
      const rep = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.equal(
        rep.targets.claude.buildErrorKind,
        'build-failed',
        'the primary target still hard-fails',
      );
      const remedy = rep.targets.claude.buildErrorRemedy || '';
      assert.match(remedy, /permissions/i, `remedy must be the permission fix: ${remedy}`);
      assert.match(remedy, /chmod/, 'remedy must name the concrete command');
      assert.ok(
        !/Run `hypomnema feedback-sync --ensure-container`/.test(remedy),
        `remedy must not prescribe a command that cannot fix a permission bit: ${remedy}`,
      );
    } finally {
      chmodSync(claudeMdPath, 0o644);
    }
  });
});

test('doctor WARNS (never fails) on a side-file permission error and names the path', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ memDir, runFb, runDoctor }) => {
    assert.equal(runFb(['--write']).status, 0);
    const side = join(memDir, 'feedback_rule-a.md');
    chmodSync(side, 0o000);
    try {
      const { fb } = runDoctor();
      const hit = fb.find((c) => /side file/i.test(c.label));
      assert.ok(hit, `expected a side-file entry: ${JSON.stringify(fb)}`);
      assert.equal(hit.status, 'warn', 'a side-file I/O error must warn, not fail');
      assert.match(hit.detail, /feedback_rule-a\.md/, 'the exact path must be named');
      assert.match(hit.detail, /permissions/i, 'the permission fix must be named');
      assert.ok(
        !fb.some((c) => c.status === 'fail'),
        `a side-file error must not produce a doctor FAIL: ${JSON.stringify(fb)}`,
      );
    } finally {
      chmodSync(side, 0o644);
    }
  });
});

suite('feedback-sync.mjs — Track B source-loader golden (byte-identical)');

test('feedback-sync-golden-write: check/write loader full output is byte-identical', () => {
  assert.equal(
    fbGolden({ 'rule-a': FB_GLOBAL_L1, 'rule-b': FB_PROJECT_L2 }, {}, () => {}, ['--write']),
    FB_GOLDEN_WRITE,
  );
});

test('feedback-sync-golden-bootstrap: bootstrap loader full output is byte-identical', () => {
  const claudeMd =
    '# Global\n<learned_behaviors>\n- [2026-05-01] legacy rule one\n</learned_behaviors>\n';
  const memoryMd = '# Memory Index\n- [Loose Y](feedback_loose_y.md) — legacy hand entry\n';
  assert.equal(
    fbGolden({ 'rule-a': FB_GLOBAL_L1 }, { claudeMd, memoryMd }, () => {}, ['--bootstrap']),
    FB_GOLDEN_BOOTSTRAP,
  );
});

test('feedback-sync-golden-import: import loader full output is byte-identical', () => {
  assert.equal(
    fbGolden(
      { 'rule-a': FB_GLOBAL_L1 },
      {},
      (ctx) => {
        ctx.runFb(['--write']);
        const p = join(ctx.claudeHome, 'CLAUDE.md');
        writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
      },
      ['--import-target-change', '--from=claude'],
    ),
    FB_GOLDEN_IMPORT,
  );
});

test('feedback-sync-existing-9-pages-pass-new-schema: schema-complete pages lint green + parse', () => {
  // 9 schema-complete feedback pages (mirroring the canonical frontmatter the
  // real wiki ships) must pass the new feedback conditional-required lint AND be
  // parsed by feedback-sync without error. Hermetic — no dependency on ~/hypomnema
  // (§8.13 verification #4 dogfooding, expressed as a hermetic regression guard).
  const pages = {};
  for (let i = 1; i <= 7; i++)
    pages[`global-${i}`] = {
      ...FB_GLOBAL_L1,
      title: `Global ${i}`,
      global_summary: `g${i}`,
      memory_summary: `m${i}`,
    };
  for (let i = 1; i <= 2; i++)
    pages[`proj-${i}`] = { ...FB_PROJECT_L2, title: `Proj ${i}`, memory_summary: `pm${i}` };
  withFeedbackEnv(pages, ({ wiki, runFb }) => {
    const lint = run('lint.mjs', [`--hypo-dir=${wiki}`]);
    assert.equal(
      lint.status,
      0,
      `lint must pass schema-complete feedback pages:\n${lint.stdout}${lint.stderr}`,
    );
    const rep = JSON.parse(runFb(['--check', '--json']).stdout);
    assert.equal(rep.targets.claude.candidates, 7, 'L1 global pages reach CLAUDE');
    assert.equal(rep.targets.memory.candidates, 9, 'all 9 reach MEMORY');
  });
});

// Injected-prompt unit tests: drive resolveProjectId() directly with isTTY:true
// and a fake prompt, exercising the interactive branches without a real TTY.
await testAsync(
  'resolveProjectId: explicit --project-id resolves without calling prompt',
  async () => {
    let called = false;
    const r = await fbResolveProjectId(
      { projectId: 'explicit-id', claudeHome: '/no/such', cwd: '/x', noInput: false },
      {
        isTTY: true,
        prompt: () => {
          called = true;
          return { action: 'confirm' };
        },
      },
    );
    assert.equal(r.id, 'explicit-id');
    assert.equal(r.skipMemory, false);
    assert.equal(called, false, 'explicit project-id must not prompt');
  },
);

await testAsync('resolveProjectId: derived dir exists resolves without prompting', async () => {
  const base = mkdtempSync(join(tmpdir(), 'hypo-rpid-'));
  try {
    const claudeHome = join(base, 'claude');
    const id = '-x'; // matches cwd "/x" → "/x".replace(/[/.]/g,'-') === "-x"
    mkdirSync(join(claudeHome, 'projects', id), { recursive: true });
    const r = await fbResolveProjectId(
      { projectId: null, claudeHome, cwd: '/x', noInput: false },
      {
        isTTY: true,
        prompt: () => {
          throw new Error('prompt must not be called when derived dir exists');
        },
      },
    );
    assert.equal(r.id, id);
    assert.equal(r.exists, true);
    assert.equal(r.skipMemory, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

await testAsync(
  'resolveProjectId: prompt "confirm" accepts derived id, MEMORY not skipped',
  async () => {
    const r = await fbResolveProjectId(
      { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
      { isTTY: true, prompt: () => ({ action: 'confirm' }) },
    );
    assert.equal(r.id, '-some-path');
    assert.equal(r.skipMemory, false, 'confirm includes MEMORY despite missing dir');
  },
);

await testAsync('resolveProjectId: prompt "id" returns chosen id, MEMORY not skipped', async () => {
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
    { isTTY: true, prompt: () => ({ action: 'id', id: 'chosen-id' }) },
  );
  assert.equal(r.id, 'chosen-id');
  assert.equal(r.derived, false, 'user-entered id is treated as explicit');
  assert.equal(r.skipMemory, false, 'chosen id still projects MEMORY (created on --write)');
});

await testAsync('resolveProjectId: prompt "skip" sets skipMemory', async () => {
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
    { isTTY: true, prompt: () => ({ action: 'skip' }) },
  );
  assert.equal(r.skipMemory, true);
});

await testAsync('resolveProjectId: --no-input never prompts even with isTTY true', async () => {
  let called = false;
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: true },
    {
      isTTY: true,
      prompt: () => {
        called = true;
        return { action: 'confirm' };
      },
    },
  );
  assert.equal(called, false, '--no-input must short-circuit before prompting');
  assert.equal(r.skipMemory, true);
});

await testAsync('resolveProjectId: non-TTY never prompts (hook/CI safety)', async () => {
  let called = false;
  const r = await fbResolveProjectId(
    { projectId: null, claudeHome: '/no/such', cwd: '/some/path', noInput: false },
    {
      isTTY: false,
      prompt: () => {
        called = true;
        return { action: 'confirm' };
      },
    },
  );
  assert.equal(called, false, 'non-TTY must never call prompt');
  assert.equal(r.skipMemory, true);
});

// ── integration-review fixes (entry guard, doctor project-id) ────────────────

suite('feedback-sync.mjs / doctor.mjs — integration review fixes (fix #37)');

test('feedback-sync-entry-guard-tolerates-space-in-path: CLI runs, not a silent no-op', () => {
  // a path with a space: raw `file://${argv[1]}` mismatches the percent-encoded
  // import.meta.url, so the pre-fix entry guard skipped main() and exited 0 silently.
  const base = mkdtempSync(join(tmpdir(), 'hypo fb space-'));
  try {
    cpSync(SCRIPTS, join(base, 'scripts'), { recursive: true }); // incl. lib/ for relative imports
    const wiki = join(base, 'wiki');
    mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '# config');
    const r = spawnSync(
      process.execPath,
      [
        join(base, 'scripts', 'feedback-sync.mjs'),
        '--check',
        '--json',
        '--no-input',
        `--hypo-dir=${wiki}`,
        `--claude-home=${join(base, 'claude')}`,
        `--cwd=${join(tmpdir(), 'no-such-cwd')}`,
      ],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
    );
    assert.ok(
      r.stdout.trim().length > 0,
      `CLI must produce output even from a spaced path (entry guard): ${JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr })}`,
    );
    const rep = JSON.parse(r.stdout);
    assert.ok('claude' in rep.targets, 'a real report must be produced');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('doctor-derived-missing-project-id: unresolved warn, not a misleading stale warn', () => {
  withDoctorFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome }) => {
    // run doctor from a cwd whose derived project dir does not exist, WITHOUT
    // --project-id — doctor must forward neither, letting feedback-sync skip MEMORY.
    const noCwd = mkdtempSync(join(tmpdir(), 'hypo-doc-nocwd-'));
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'doctor.mjs'), `--hypo-dir=${wiki}`, `--claude-home=${claudeHome}`, '--json'],
      {
        encoding: 'utf-8',
        cwd: noCwd,
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    rmSync(noCwd, { recursive: true, force: true });
    const fb = JSON.parse(r.stdout).filter((c) => c.label.startsWith('Feedback projection'));
    assert.ok(
      fb.some((c) => c.status === 'warn' && /unresolved|skipped/i.test(c.detail || '')),
      `expected unresolved/skipped warn: ${JSON.stringify(fb)}`,
    );
    assert.ok(
      !fb.some((c) => /feedback-sync --write/.test(c.detail || '')),
      `must NOT emit a stale-projection warn when project-id is unresolved: ${JSON.stringify(fb)}`,
    );
  });
});

// ── feedback.mjs — /hypo:feedback page writer ───────────────
// feedback.mjs must emit lint #8-complete frontmatter so the page is a valid
// projection SoT, and must reject incomplete classification rather than write a
// page lint would later block. --no-sync keeps these tests from touching
// ~/.claude (the projection post-step is exercised manually / in feedback-sync).
suite('feedback.mjs — /hypo:feedback page writer (fix #37 Phase C)');

function withFeedbackWriterWiki(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-fbw-'));
  try {
    mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('feedback.mjs create: full classification → page written + lint-clean', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=test-rule',
      '--entry=항상 X를 한다.',
      '--scope=global',
      '--tier=L1',
      '--targets=project-memory,claude-learned',
      '--priority=4',
      '--memory-summary=X를 항상 수행',
      '--global-summary=항상 X 수행',
      '--promote-to-global',
      '--reason=Y 실수 방지',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `feedback create failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'test-rule.md'), 'utf-8');
    for (const f of [
      'type: feedback',
      'status: active',
      'scope: global',
      'tier: L1',
      'targets: [project-memory, claude-learned]',
      'sensitivity: public',
      'priority: 4',
      'memory_summary:',
      'global_summary:',
      'promote_to_global: true',
      'reason:',
      'source:',
    ]) {
      assert.ok(page.includes(f), `frontmatter missing "${f}":\n${page}`);
    }
    // lint #8 must accept the generated page (zero errors)
    const lint = run('lint.mjs', ['--json', `--hypo-dir=${dir}`]);
    const report = JSON.parse(lint.stdout);
    assert.equal(report.errors.length, 0, `lint errors on generated page: ${lint.stdout}`);
  });
});

// Track D 1st stage (create): /hypo:feedback accepts a cwd-derived project scope
// at create time (feedback.mjs --scope validation shares FEEDBACK_SCOPE_RE), and
// the generated page lints clean — so create → lint is consistent end-to-end.
test('feedback.mjs create: cwd-derived project scope → page written + lint-clean (Track D)', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=derived-scope-rule',
      '--entry=프로젝트 한정 규칙.',
      '--scope=project:-Users-you-Workspace-Project',
      '--tier=L2',
      '--targets=project-memory',
      '--priority=2',
      '--memory-summary=프로젝트 규칙 수행',
      '--reason=정합 확인',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `cwd-derived scope create failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'derived-scope-rule.md'), 'utf-8');
    assert.ok(
      page.includes('scope: project:-Users-you-Workspace-Project'),
      `derived scope not written: ${page}`,
    );
    const lint = run('lint.mjs', ['--json', `--hypo-dir=${dir}`]);
    const report = JSON.parse(lint.stdout);
    assert.equal(report.errors.length, 0, `lint errors on generated page: ${lint.stdout}`);
  });
});

test('feedback.mjs create: invalid scope vocabulary (project:.) → exit 1 (Track D edge)', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=bad-scope',
      '--entry=x.',
      '--scope=project:.',
      '--tier=L2',
      '--targets=project-memory',
      '--priority=2',
      '--memory-summary=x',
      '--reason=x',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 1, `project:. must be rejected at create time: ${r.stdout}`);
  });
});

// ── FEAT-1: --failure-type create + append rules ────────────────────────────
suite('FEAT-1: --failure-type create + append rules');
const FB_BASE_ARGS = (dir, topic) => [
  `--topic=${topic}`,
  '--entry=항상 X를 한다.',
  '--scope=project:hypomnema',
  '--tier=L2',
  '--targets=project-memory',
  '--priority=3',
  '--memory-summary=X 수행',
  '--reason=Y 방지',
  '--no-sync',
  `--hypo-dir=${dir}`,
];

test('feedback.mjs create: --failure-type written + lint-clean', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      ...FB_BASE_ARGS(dir, 'ft-rule'),
      '--failure-type=incompleteness',
    ]);
    assert.equal(r.status, 0, `create with failure-type failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'ft-rule.md'), 'utf-8');
    assert.ok(page.includes('failure_type: incompleteness'), `failure_type not written:\n${page}`);
    const lint = run('lint.mjs', ['--json', `--hypo-dir=${dir}`]);
    assert.equal(JSON.parse(lint.stdout).errors.length, 0, `lint errors: ${lint.stdout}`);
  });
});

test('feedback.mjs create: invalid --failure-type → exit 1', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [...FB_BASE_ARGS(dir, 'ft-bad'), '--failure-type=tool-misuse']);
    assert.equal(r.status, 1, `invalid failure-type must be rejected: ${r.stdout}`);
    assert.ok(/failure-type invalid/.test(r.stderr), `error message missing: ${r.stderr}`);
  });
});

test('feedback.mjs create: --failure-type omitted → no field (optional)', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', FB_BASE_ARGS(dir, 'ft-none'));
    assert.equal(r.status, 0, `create without failure-type failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'ft-none.md'), 'utf-8');
    assert.ok(!/^failure_type:/m.test(page), `failure_type should be absent:\n${page}`);
  });
});

test('feedback.mjs append: set-if-absent adds failure_type to existing page', () => {
  withFeedbackWriterWiki((dir) => {
    run('feedback.mjs', FB_BASE_ARGS(dir, 'ft-app')); // create without failure_type
    const r = run('feedback.mjs', [
      `--topic=ft-app`,
      '--entry=두 번째 교정.',
      '--no-sync',
      `--hypo-dir=${dir}`,
      '--failure-type=convention-violation',
    ]);
    assert.equal(r.status, 0, `append with failure-type failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'ft-app.md'), 'utf-8');
    assert.ok(
      page.includes('failure_type: convention-violation'),
      `append did not add failure_type:\n${page}`,
    );
    assert.ok(page.includes('두 번째 교정.'), 'dated entry not appended');
  });
});

// codex stage-2 CONCERN: an existing EMPTY `failure_type:` key must be filled by
// set-if-absent, not left blank (parseFrontmatter reads empty → "absent").
test('feedback.mjs append: empty failure_type key is filled, not left blank', () => {
  withFeedbackWriterWiki((dir) => {
    writeFileSync(
      join(dir, 'pages', 'feedback', 'ft-empty.md'),
      '---\ntitle: T\ntype: feedback\nstatus: active\nfailure_type:\nupdated: 2026-06-23\n---\nbody\n',
    );
    const r = run('feedback.mjs', [
      '--topic=ft-empty',
      '--entry=교정.',
      '--no-sync',
      `--hypo-dir=${dir}`,
      '--failure-type=overreach',
    ]);
    assert.equal(r.status, 0, `append over empty key failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'ft-empty.md'), 'utf-8');
    assert.ok(/^failure_type: overreach$/m.test(page), `empty key not filled:\n${page}`);
  });
});

// codex stage-2 CONCERN: CRLF frontmatter must be handled (the shared parser is
// CRLF-aware, so the injector must be too — an LF-only match silently skipped it).
test('feedback.mjs append: CRLF frontmatter still gets failure_type set', () => {
  withFeedbackWriterWiki((dir) => {
    writeFileSync(
      join(dir, 'pages', 'feedback', 'ft-crlf.md'),
      '---\r\ntitle: T\r\ntype: feedback\r\nstatus: active\r\nupdated: 2026-06-23\r\n---\r\nbody\r\n',
    );
    const r = run('feedback.mjs', [
      '--topic=ft-crlf',
      '--entry=교정.',
      '--no-sync',
      `--hypo-dir=${dir}`,
      '--failure-type=process-stall',
    ]);
    assert.equal(r.status, 0, `append on CRLF page failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'ft-crlf.md'), 'utf-8');
    assert.ok(/failure_type: process-stall/.test(page), `CRLF page not set:\n${page}`);
  });
});

test('feedback.mjs append: conflicting failure_type → exit 1 (no silent ignore)', () => {
  withFeedbackWriterWiki((dir) => {
    run('feedback.mjs', [...FB_BASE_ARGS(dir, 'ft-cnf'), '--failure-type=incompleteness']);
    const r = run('feedback.mjs', [
      `--topic=ft-cnf`,
      '--entry=다른 유형 교정.',
      '--no-sync',
      `--hypo-dir=${dir}`,
      '--failure-type=overreach',
    ]);
    assert.equal(r.status, 1, `mismatched failure_type must error: ${r.stdout}`);
    assert.ok(/failure_type mismatch/.test(r.stderr), `mismatch message missing: ${r.stderr}`);
  });
});

test('feedback.mjs append: no --failure-type → frontmatter unchanged (regression)', () => {
  withFeedbackWriterWiki((dir) => {
    run('feedback.mjs', FB_BASE_ARGS(dir, 'ft-reg'));
    const before = readFileSync(join(dir, 'pages', 'feedback', 'ft-reg.md'), 'utf-8');
    const fmBefore = before.match(/^---\n[\s\S]*?\n---/)[0];
    run('feedback.mjs', [`--topic=ft-reg`, '--entry=추가 교정.', '--no-sync', `--hypo-dir=${dir}`]);
    const after = readFileSync(join(dir, 'pages', 'feedback', 'ft-reg.md'), 'utf-8');
    const fmAfter = after.match(/^---\n[\s\S]*?\n---/)[0];
    // only `updated:` may change; failure_type must not appear and no other key added
    assert.ok(!/^failure_type:/m.test(fmAfter), `failure_type leaked into append:\n${fmAfter}`);
    assert.equal(
      fmBefore.replace(/^updated:.*$/m, 'updated:X'),
      fmAfter.replace(/^updated:.*$/m, 'updated:X'),
      'append mutated frontmatter beyond updated:',
    );
  });
});

test('feedback.mjs create: projection post-step targets --claude-home (no ~/.claude touch)', () => {
  withFeedbackWriterWiki((dir) => {
    // Isolated projection target: --claude-home keeps the post-step out of the
    // real ~/.claude. Proves the auto `feedback-sync --write` runs and projects.
    const cHome = mkdtempSync(join(tmpdir(), 'hypo-fbw-claude-'));
    try {
      mkdirSync(join(cHome, 'projects', 'pid', 'memory'), { recursive: true });
      writeFileSync(
        join(cHome, 'CLAUDE.md'),
        '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
      );
      writeFileSync(join(cHome, 'projects', 'pid', 'memory', 'MEMORY.md'), '# Memory Index\n');
      const r = run('feedback.mjs', [
        '--topic=proj-rule',
        '--entry=항상 P를 한다.',
        '--scope=global',
        '--tier=L1',
        '--targets=project-memory,claude-learned',
        '--priority=5',
        '--memory-summary=P 수행',
        '--global-summary=항상 P',
        '--promote-to-global',
        '--reason=Q 방지',
        `--claude-home=${cHome}`,
        '--project-id=pid',
        `--hypo-dir=${dir}`,
      ]);
      assert.equal(r.status, 0, `feedback create+sync failed: ${r.stderr}`);
      const claudeMd = readFileSync(join(cHome, 'CLAUDE.md'), 'utf-8');
      assert.ok(
        claudeMd.includes('HYPO:FEEDBACK-SYNC:START source=proj-rule'),
        `projection should write a managed block:\n${claudeMd}`,
      );
    } finally {
      rmSync(cHome, { recursive: true, force: true });
    }
  });
});

// FEAT-1: the failure_type field must not perturb the default (non-`--no-sync`)
// projection path. feedback-sync field-selects known keys, so an extra
// failure_type is ignored — assert the full create→auto-sync flow still projects.
test('feedback.mjs create: --failure-type page still projects clean (no --no-sync)', () => {
  withFeedbackWriterWiki((dir) => {
    const cHome = mkdtempSync(join(tmpdir(), 'hypo-fbw-claude-'));
    try {
      mkdirSync(join(cHome, 'projects', 'pid', 'memory'), { recursive: true });
      writeFileSync(
        join(cHome, 'CLAUDE.md'),
        '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
      );
      writeFileSync(join(cHome, 'projects', 'pid', 'memory', 'MEMORY.md'), '# Memory Index\n');
      const r = run('feedback.mjs', [
        '--topic=ft-proj',
        '--entry=항상 게이트를 돌린다.',
        '--scope=global',
        '--tier=L1',
        '--targets=project-memory,claude-learned',
        '--priority=4',
        '--memory-summary=게이트 수행',
        '--global-summary=항상 게이트',
        '--promote-to-global',
        '--reason=false-completion 방지',
        '--failure-type=false-completion',
        `--claude-home=${cHome}`,
        '--project-id=pid',
        `--hypo-dir=${dir}`,
      ]);
      assert.equal(r.status, 0, `create+sync with failure_type failed: ${r.stderr}`);
      const page = readFileSync(join(dir, 'pages', 'feedback', 'ft-proj.md'), 'utf-8');
      assert.ok(
        page.includes('failure_type: false-completion'),
        `failure_type not written:\n${page}`,
      );
      const claudeMd = readFileSync(join(cHome, 'CLAUDE.md'), 'utf-8');
      assert.ok(
        claudeMd.includes('HYPO:FEEDBACK-SYNC:START source=ft-proj'),
        `projection must still write a managed block:\n${claudeMd}`,
      );
      // the projected line carries the summary, not the failure_type key
      assert.ok(!claudeMd.includes('failure_type'), 'failure_type must not leak into projection');
    } finally {
      rmSync(cHome, { recursive: true, force: true });
    }
  });
});

test('feedback.mjs create: missing --memory-summary → exit 1, no page', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=incomplete',
      '--entry=무언가',
      '--scope=global',
      '--tier=L2',
      '--targets=project-memory',
      '--reason=이유',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 1, 'incomplete classification must fail');
    assert.ok(/memory-summary/.test(r.stderr), `error should name the missing field: ${r.stderr}`);
    assert.ok(
      !existsSync(join(dir, 'pages', 'feedback', 'incomplete.md')),
      'no page should be written on validation failure',
    );
  });
});

test('feedback.mjs create: claude-learned with project scope → exit 1 (ADR 0031 §6)', () => {
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=mis-scoped',
      '--entry=무언가',
      '--scope=project:foo',
      '--tier=L1',
      '--targets=project-memory,claude-learned',
      '--priority=3',
      '--memory-summary=요약',
      '--global-summary=전역요약',
      '--promote-to-global',
      '--reason=이유',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 1, 'claude-learned requires scope=global');
    assert.ok(/scope=global/.test(r.stderr), `error should explain the §6 filter: ${r.stderr}`);
  });
});

test('feedback.mjs create: newline in a scalar cannot inject a frontmatter key', () => {
  // Regression: raw interpolation let a value with an embedded
  // newline forge a frontmatter key (e.g. reason="legit\nstatus: archived").
  // oneLine() collapses whitespace so the injected text stays on the value line.
  withFeedbackWriterWiki((dir) => {
    const r = run('feedback.mjs', [
      '--topic=inject',
      '--entry=rule body',
      '--scope=global',
      '--tier=L2',
      '--targets=project-memory',
      '--priority=3',
      '--memory-summary=ok',
      '--reason=legit\nstatus: archived',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `create failed: ${r.stderr}`);
    const page = readFileSync(join(dir, 'pages', 'feedback', 'inject.md'), 'utf-8');
    const fm = page.split('---')[1];
    assert.ok(/^status: active$/m.test(fm), 'real status must stay active');
    assert.ok(!/^status: archived$/m.test(fm), 'injected key must NOT appear as its own line');
    assert.ok(/^reason: legit status: archived$/m.test(fm), 'newline collapsed into the value');
  });
});

test('feedback.mjs append: bumpUpdated leaves a body "updated:" line untouched', () => {
  // Regression: a multiline replace would rewrite a body line
  // starting with "updated:". bumpUpdated must only touch the frontmatter fence.
  withFeedbackWriterWiki((dir) => {
    const p = join(dir, 'pages', 'feedback', 'existing.md');
    writeFileSync(
      p,
      '---\ntitle: x\ntype: feedback\nupdated: 2020-01-01\n---\n\n# x\n\nupdated: 2019-12-31 (body line)\n',
    );
    const r = run('feedback.mjs', [
      '--topic=existing',
      '--entry=new dated entry',
      '--no-sync',
      `--hypo-dir=${dir}`,
    ]);
    assert.equal(r.status, 0, `append failed: ${r.stderr}`);
    const out = readFileSync(p, 'utf-8');
    assert.ok(out.includes('updated: 2019-12-31 (body line)'), 'body updated: line preserved');
    const today = new Date().toISOString().slice(0, 10);
    const fm = out.split('\n---')[0];
    assert.ok(
      new RegExp(`^updated: ${today}$`, 'm').test(fm),
      'frontmatter updated bumped to today',
    );
  });
});
