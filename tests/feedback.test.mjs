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
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// static import (no top-level await) — feedback-sync.mjs guards main() behind an
// entry check, so importing it for unit tests does not run the CLI.
import {
  resolveProjectId as fbResolveProjectId,
  parseArgs as fbParseArgs,
  run as fbRun,
  evaluateTarget,
  applyTarget,
  runAccept,
  memoryTarget,
  loadFeedbackPages,
} from '../scripts/feedback-sync.mjs';
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

// where --bootstrap and --import-target-change write their drafts
const fbDraftsDir = (wiki) => join(wiki, '.cache', 'feedback-drafts');

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

test('feedback projection conflict (hand-edited block) → named in the notice, no auto-merge (ADR 0045)', () => {
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
        // scope-boundary §1: PreCompact no longer blocks. What must survive is that
        // the condition is DETECTED and NAMED — a silent pass is the regression.
        assert.notEqual(out.decision, 'block', `PreCompact must not block: ${r.stdout}`);
        assert.ok(
          /conflict/.test(out.systemMessage || ''),
          `notice must name the conflict: ${r.stdout}`,
        );
        // the remedy is the report's text: --from for the copy, the real slug for accept
        assert.match(out.systemMessage, /--import-target-change --from=claude/, r.stdout);
        assert.match(out.systemMessage, /--accept-wiki=rule-a/, r.stdout);
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
        assert.notEqual(out.decision, 'block', `PreCompact must not block: ${r.stdout}`);
        assert.ok(
          /over cap/.test(out.systemMessage || ''),
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
        assert.notEqual(out.decision, 'block', `PreCompact must not block: ${r.stdout}`);
        assert.ok(
          /cannot be built/.test(out.systemMessage || ''),
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
          assert.notEqual(out.decision, 'block', `PreCompact must not block: ${r.stdout}`);
          // The point of this case is NOT fail-open: an unreadable target must still
          // be reported, just as a notice rather than a block (scope-boundary §1).
          assert.ok(
            /cannot be built/.test(out.systemMessage || ''),
            `notice must name the build failure: ${r.stdout}`,
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

// The separators feedback-sync writes carry no em dash: a model that reads the
// projected lines copies their shape by hand, and a dash separator collides with
// dashes inside a summary.
// A summary that itself holds one still carries it; that is wiki content, not format.
const FB_EM = '—';
const fbBlock = (slug, line) => {
  const hash = createHash('sha256').update(line, 'utf-8').digest('hex');
  return (
    `<!-- HYPO:FEEDBACK-SYNC:START source=${slug} sha256=${hash} -->\n${line}\n` +
    '<!-- HYPO:FEEDBACK-SYNC:END -->\n'
  );
};

test('feedback-sync-projected-lines-have-no-em-dash: colon index line, period before 근거', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const claude = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
    const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    assert.ok(mem.split('\n').includes('- [Rule A](feedback_rule-a.md): do A'), mem);
    assert.ok(claude.split('\n').includes('- [2026-05-20] always do A. 근거: [[rule-a]]'), claude);
    assert.ok(!mem.includes(FB_EM) && !claude.includes(FB_EM), 'no em dash in either projection');
  });
});

test('feedback-sync-projected-lines-edge: no doubled period, no dangling separator', () => {
  const page = { ...FB_GLOBAL_L1, global_summary: 'always do A.', memory_summary: '' };
  withFeedbackEnv({ 'rule-a': page }, ({ claudeHome, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const claude = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
    const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
    assert.ok(claude.split('\n').includes('- [2026-05-20] always do A. 근거: [[rule-a]]'), claude);
    assert.ok(mem.split('\n').includes('- [Rule A](feedback_rule-a.md)'), mem);
  });
});

test('feedback-sync-legacy-dash-blocks-migrate: old-format managed blocks rewrite, never exit 3', () => {
  // Blocks projected before the separator change match their own sha256, so they
  // are an ordinary stale projection, not a manual edit.
  const claudeMd =
    '# Global\n<learned_behaviors>\n- manual entry\n' +
    fbBlock('rule-a', `- [2026-05-20] always do A ${FB_EM} 근거: [[rule-a]]`) +
    '</learned_behaviors>\n';
  const memoryMd =
    '# Memory Index\n' + fbBlock('rule-a', `- [Rule A](feedback_rule-a.md) ${FB_EM} do A`);
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, memDir, runFb }) => {
      const check = runFb(['--check', '--json']);
      assert.equal(check.status, 1, `legacy blocks are drift, not conflict: ${check.stderr}`);
      const rep = JSON.parse(check.stdout);
      assert.deepEqual(rep.targets.claude.conflicts, []);
      assert.deepEqual(rep.targets.memory.conflicts, []);
      const w = runFb(['--write']);
      assert.equal(w.status, 0, `--write must rewrite, got ${w.status}: ${w.stderr}`);
      const claude = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(claude.includes('- [2026-05-20] always do A. 근거: [[rule-a]]'), claude);
      assert.ok(claude.includes('- manual entry'), 'manual entry must survive the rewrite');
      assert.ok(mem.includes('- [Rule A](feedback_rule-a.md): do A'), mem);
      assert.ok(!mem.includes(FB_EM) && !claude.includes(FB_EM), 'legacy dash fully replaced');
      assert.equal(runFb(['--check']).status, 0, 'post-migration check must be clean');
    },
    { claudeMd, memoryMd },
  );
});

test('feedback-sync-bootstrap-reads-both-index-forms: colon and legacy dash lines both draft', () => {
  const memoryMd =
    '# Memory Index\n' +
    '- [New form](feedback_new_form.md): colon summary\n' +
    `- [Old form](feedback_old_form.md) ${FB_EM} dash summary\n` +
    '- [Bare](feedback_bare.md)\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const draftsDir = fbDraftsDir(wiki);
      const read = (f) => readFileSync(join(draftsDir, f), 'utf-8');
      assert.ok(read('new-form.md').includes('memory_summary: colon summary'));
      assert.ok(read('old-form.md').includes('memory_summary: dash summary'));
      assert.ok(existsSync(join(draftsDir, 'bare.md')), 'summary-less line still drafts');
    },
    { memoryMd },
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

// ── managed-block markers quoted as documentation ───────────────────────────────
// A marker pair shown in a code fence or in inline code is an example, not a block.
// Before this, --write read it as a block and replaced the text between the quoted
// markers with the projection.

const FB_EXAMPLE_LINE = '- [2026-01-01] quoted example rule';
const FB_FENCED_EXAMPLE = '```md\n' + fbBlock('quoted', FB_EXAMPLE_LINE) + '```\n';
const fbContainer = (body) =>
  `# Global\n<learned_behaviors>\n- manual entry\n${body}</learned_behaviors>\n`;

test('feedback-sync-fenced-marker-example-untouched: --write leaves a quoted START/END pair and the text between byte for byte', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.ok(c.includes(FB_FENCED_EXAMPLE), `fenced example must survive verbatim:\n${c}`);
      assert.ok(c.includes('- manual entry'), c);
      assert.ok(c.includes('source=rule-a'), 'the real block is still projected');
    },
    { claudeMd: fbContainer(FB_FENCED_EXAMPLE) },
  );
});

test('feedback-sync-inline-marker-example-untouched: a START quoted mid-line in inline code is not a block', () => {
  const hash = createHash('sha256').update(FB_EXAMPLE_LINE, 'utf-8').digest('hex');
  // the inline code span opens before the START marker and closes after the END line
  const example =
    `Write \`<!-- HYPO:FEEDBACK-SYNC:START source=quoted sha256=${hash} -->\n` +
    `${FB_EXAMPLE_LINE}\n<!-- HYPO:FEEDBACK-SYNC:END -->\` to pin a rule.\n`;
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.ok(c.includes(example), `inline example must survive verbatim:\n${c}`);
      assert.ok(c.includes('source=rule-a'), 'the real block is still projected');
    },
    { claudeMd: fbContainer(example) },
  );
});

test('feedback-sync-real-block-beside-fenced-example: only the real block is rewritten', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const c = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
      assert.ok(c.includes(FB_FENCED_EXAMPLE), `fenced example must survive verbatim:\n${c}`);
      assert.ok(c.includes('- [2026-05-20] always do A. 근거: [[rule-a]]'), c);
      assert.ok(!c.includes('stale projected text'), 'the real block was rewritten in place');
      assert.equal((c.match(/source=rule-a/g) || []).length, 1, 'one real block, not a copy');
    },
    {
      claudeMd: fbContainer(
        FB_FENCED_EXAMPLE + fbBlock('rule-a', '- [2026-05-20] stale projected text'),
      ),
    },
  );
});

test('feedback-sync-check-ignores-fenced-marker-example: --check reports no conflict or intruder for a quoted pair', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ runFb }) => {
      assert.notEqual(runFb(['--check']).status, 3, 'a quoted pair is not a conflict');
      assert.equal(runFb(['--write']).status, 0);
      assert.equal(runFb(['--check']).status, 0, 'in sync, with the example still in the file');
    },
    {
      // a hand-edited hash inside the fence would be a conflict if it were read as a block
      claudeMd: fbContainer(FB_FENCED_EXAMPLE.replace(FB_EXAMPLE_LINE, '- [2026-01-01] edited')),
    },
  );
});

test('feedback-sync-unclosed-fence-does-not-hide-real-block: a fence that never closes is read as text', () => {
  const unclosed = '# Memory Index\n```\nexample that never closes\n';
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ memDir, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const m = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(m.startsWith(unclosed), m);
      assert.ok(m.includes('- [Rule A](feedback_rule-a.md): do A'), m);
      assert.ok(!m.includes('stale'), 'the real block below the unclosed fence was rewritten');
      assert.equal((m.match(/source=rule-a/g) || []).length, 1, 'rewritten in place, not appended');
    },
    {
      memoryMd: unclosed + fbBlock('rule-a', '- [Rule A](feedback_rule-a.md): stale'),
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

test('feedback-sync-bootstrap-creates-drafts: legacy surfaces → draft scaffolds, idempotent', () => {
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
      const draftsDir = fbDraftsDir(wiki);
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
      assert.ok(!existsSync(fbDraftsDir(wiki)), 'no drafts dir written');
      const t = runFb(['--bootstrap', '--dry-run']);
      assert.match(t.stderr, /would create/);
      assert.doesNotMatch(t.stderr, /The drafts are in/, 'no pointer to drafts that were not made');
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
    const draftsDir = fbDraftsDir(wiki);
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

// ── hand-edited block: auto-accept when the wiki matches, explicit --accept-wiki otherwise ──

// stored vs recomputed hash of one managed block in a projected file
function fbBlockHashes(text, slug) {
  const m = text.match(
    new RegExp(
      `<!-- HYPO:FEEDBACK-SYNC:START source=${slug} sha256=([0-9a-f]{64}) -->\n([\\s\\S]*?)\n<!-- HYPO:FEEDBACK-SYNC:END -->`,
    ),
  );
  assert.ok(m, `managed block for ${slug} present`);
  return { declared: m[1], actual: createHash('sha256').update(m[2], 'utf-8').digest('hex') };
}

const FB_GLOBAL_C = {
  ...FB_GLOBAL_L1,
  title: 'Rule C',
  priority: 4,
  memory_summary: 'do C',
  global_summary: 'always do C',
};

test('feedback-sync-conflict-auto-accept: hand edit matched by the wiki page → --write rewrites the hash, check clean', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    const before = fbBlockHashes(readFileSync(p, 'utf-8'), 'rule-a');
    assert.notEqual(before.declared, before.actual, 'precondition: stored hash is stale');
    assert.equal(runFb(['--check']).status, 3, 'precondition: wiki still differs, conflict');
    // the wiki side now says the same thing, byte for byte
    const page = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(page, readFileSync(page, 'utf-8').replace('always do A', 'HAND EDITED'));
    assert.equal(
      runFb(['--check']).status,
      1,
      'matched block is drift (hash to rewrite), not conflict',
    );
    assert.equal(runFb(['--write']).status, 0, 'matched block must not block --write');
    const after = fbBlockHashes(readFileSync(p, 'utf-8'), 'rule-a');
    assert.equal(after.declared, after.actual, 'marker hash rewritten to match the content');
    assert.notEqual(after.declared, before.declared);
    assert.ok(readFileSync(p, 'utf-8').includes('HAND EDITED'), 'content kept');
    assert.equal(runFb(['--check']).status, 0, 'following --check is clean');
  });
});

test('feedback-sync-conflict-differs-from-wiki-still-exit-3: auto-accept does not swallow a differing hand edit', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    // wiki edited to something else, so the two sides differ
    const page = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(page, readFileSync(page, 'utf-8').replace('always do A', 'WIKI EDITED'));
    const h = fbBlockHashes(readFileSync(p, 'utf-8'), 'rule-a');
    assert.notEqual(h.declared, h.actual, 'precondition: stored hash is stale');
    for (const mode of ['--check', '--write']) {
      const r = runFb([mode, '--json']);
      assert.equal(r.status, 3, `${mode} must stay a conflict: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout).targets.claude.conflicts, ['rule-a']);
    }
    assert.ok(readFileSync(p, 'utf-8').includes('HAND EDITED'), 'hand edit not overwritten');
  });
});

test('feedback-sync-accept-wiki: resolves only the named conflicted block, refuses non-conflicted sources', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C },
    ({ claudeHome, memDir, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const p = join(claudeHome, 'CLAUDE.md');
      writeFileSync(
        p,
        readFileSync(p, 'utf-8')
          .replace('always do A', 'HAND EDITED A')
          .replace('always do C', 'HAND EDITED C'),
      );
      const mem = join(memDir, 'MEMORY.md');
      const memBefore = readFileSync(mem, 'utf-8');
      for (const slug of ['rule-a', 'rule-c']) {
        const h = fbBlockHashes(readFileSync(p, 'utf-8'), slug);
        assert.notEqual(h.declared, h.actual, `precondition: ${slug} hash is stale`);
      }
      assert.equal(runFb(['--check']).status, 3, 'precondition: conflict');

      const r = runFb(['--accept-wiki=rule-a', '--json']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(
        JSON.parse(r.stdout).accepted.map((a) => a.target),
        ['claude'],
      );
      const text = readFileSync(p, 'utf-8');
      assert.ok(text.includes('always do A'), 'wiki rendering restored for rule-a');
      assert.ok(!text.includes('HAND EDITED A'), 'hand edit for rule-a discarded');
      const a = fbBlockHashes(text, 'rule-a');
      assert.equal(a.declared, a.actual, 'rule-a hash rewritten');
      assert.ok(text.includes('HAND EDITED C'), 'rule-c hand edit untouched');
      const c = fbBlockHashes(text, 'rule-c');
      assert.notEqual(c.declared, c.actual, 'rule-c still conflicted on disk');
      assert.equal(readFileSync(mem, 'utf-8'), memBefore, 'other target untouched');
      const chk = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.deepEqual(chk.targets.claude.conflicts, ['rule-c'], 'only rule-c remains in conflict');

      // refusals: already resolved, unknown source, empty slug; the file stays as is
      for (const flag of ['--accept-wiki=rule-a', '--accept-wiki=nope', '--accept-wiki=']) {
        const bad = runFb([flag]);
        assert.equal(bad.status, 1, `${flag} must be refused`);
        assert.equal(readFileSync(p, 'utf-8'), text, `${flag} must not write`);
      }
      assert.match(runFb(['--accept-wiki=rule-a']).stderr, /not in conflict/);
    },
  );
});

// A START whose END was deleted by hand: BLOCK_RE pairs it with the NEXT block's END,
// so the "block" spans the neighbor and the note between them. Accept would splice
// that whole span. It must refuse, leave every byte alone, and not advertise itself.
test('feedback-sync-accept-wiki-refuses-unpaired-file: a deleted END marker cannot make accept eat the neighbor block and a hand note', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    const END = '<!-- HYPO:FEEDBACK-SYNC:END -->';
    // rule-a sorts first (priority 5 over 4): its END is the first one in the file
    const damaged = readFileSync(p, 'utf-8')
      .replace('always do A', 'HAND EDITED A')
      .replace(END, '- my personal note I want to keep');
    writeFileSync(p, damaged);

    const chk = runFb(['--check', '--json']);
    assert.equal(chk.status, 3, 'precondition: conflict exit');
    const rep = JSON.parse(chk.stdout).targets.claude;
    assert.deepEqual(rep.conflicts, ['rule-a'], 'precondition: rule-a reads as conflicted');
    assert.equal(rep.unpaired, true, 'precondition: the file is unpaired');
    assert.ok(
      !runFb(['--check']).stderr.includes('--accept-wiki'),
      'the accept hint must not be offered for an unpaired file',
    );

    const r = runFb(['--accept-wiki=rule-a']);
    assert.equal(r.status, 1, `accept must refuse: ${r.stderr}`);
    assert.match(r.stderr, /malformed or unpaired managed marker/);
    assert.ok(r.stderr.includes(p), 'the refusal names the file');
    assert.equal(readFileSync(p, 'utf-8'), damaged, 'file is byte-identical after the refusal');
    assert.ok(damaged.includes('- my personal note I want to keep') && damaged.includes('rule-c'));
  });
});

test('feedback-sync-accept-wiki-removes-block-of-archived-page: no wiki rendering left, the block goes, nothing else does', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C },
    ({ wiki, claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const p = join(claudeHome, 'CLAUDE.md');
      writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED A'));
      // the page is archived after the hand edit: the wiki projects nothing for rule-a now
      writeFileSync(
        join(wiki, 'pages', 'feedback', 'rule-a.md'),
        fbPage({ ...FB_GLOBAL_L1, status: 'archived' }),
      );
      assert.equal(runFb(['--check']).status, 3, 'precondition: stuck in conflict');

      const r = runFb(['--accept-wiki=rule-a', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const rep = JSON.parse(r.stdout);
      assert.deepEqual(
        rep.accepted.map((a) => [a.target, a.action]),
        [['claude', 'remove']],
      );
      const text = readFileSync(p, 'utf-8');
      assert.ok(!text.includes('source=rule-a') && !text.includes('HAND EDITED A'), 'block gone');
      assert.ok(text.includes('source=rule-c'), 'neighbor block intact');
      assert.ok(text.includes('- manual entry'), 'hand line intact');
      assert.ok(!text.includes('\n\n'), 'no blank line left behind');
      // the claude side is clean; the MEMORY projection of the archived page is ordinary drift
      const chk = JSON.parse(runFb(['--check', '--json']).stdout);
      assert.deepEqual(chk.targets.claude.conflicts, []);
      assert.equal(chk.targets.claude.dirty, false);
      assert.equal(runFb(['--write']).status, 0);
      assert.equal(runFb(['--check']).status, 0, 'fully clean after the next write');
    },
  );
});

test('feedback-sync-accept-wiki-dry-run-and-usage: --dry-run writes nothing, a space-separated slug is a usage error', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED A'));
    const before = readFileSync(p, 'utf-8');
    const hint = runFb(['--check']).stderr;
    assert.match(hint, /--import-target-change --from=claude/);
    assert.match(
      hint,
      /run that import first, then `hypomnema feedback-sync --accept-wiki=rule-a`/,
    );

    const r = runFb(['--accept-wiki=rule-a', '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(
      rep.planned.map((a) => [a.target, a.action]),
      [['claude', 'replace']],
    );
    assert.deepEqual(rep.accepted, [], 'nothing reported as written');
    assert.equal(readFileSync(p, 'utf-8'), before, 'dry run leaves the file byte-identical');

    // the space form used to be read as --check
    const sp = runFb(['--accept-wiki', 'rule-a']);
    assert.equal(sp.status, 1, 'bare --accept-wiki is a usage error');
    assert.match(sp.stderr, /--accept-wiki=rule-a/, 'the message shows the = form');
    assert.equal(readFileSync(p, 'utf-8'), before, 'and writes nothing');
  });
});

test('feedback-sync-conflict-remedy: the report carries one remedy text naming --from and the real slugs; an unpaired file gets no accept part', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    const clean = readFileSync(p, 'utf-8');
    assert.equal(
      JSON.parse(runFb(['--check', '--json']).stdout).targets.claude.conflictRemedy,
      undefined,
      'a clean target carries no remedy',
    );
    writeFileSync(
      p,
      clean.replace('always do A', 'HAND EDITED A').replace('always do C', 'HAND EDITED C'),
    );
    const t = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude;
    assert.match(t.conflictRemedy, /--import-target-change --from=claude/);
    assert.match(t.conflictRemedy, /--accept-wiki=rule-a/);
    assert.match(t.conflictRemedy, /--accept-wiki=rule-c/);
    assert.ok(!/[\u2014\u2013]| -- /.test(t.conflictRemedy), 'no dash in the text');
    assert.ok(
      runFb(['--check']).stderr.includes(t.conflictRemedy),
      'the CLI prints the report text, not its own',
    );

    // unpaired: rule-a's END deleted, so --accept-wiki would refuse; the remedy must not offer it
    writeFileSync(
      p,
      clean
        .replace('always do A', 'HAND EDITED A')
        .replace('<!-- HYPO:FEEDBACK-SYNC:END -->', '- note'),
    );
    const u = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude;
    assert.equal(u.unpaired, true, 'precondition');
    assert.match(u.conflictRemedy, /--import-target-change --from=claude/);
    assert.ok(!u.conflictRemedy.includes('--accept-wiki'), `unpaired: ${u.conflictRemedy}`);
  });
});

test('feedback-sync-conflict-remedy-by-shape: an intruder-only target is told to move the lines, not to import', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(
      p,
      readFileSync(p, 'utf-8').replace(
        '<!-- HYPO:FEEDBACK-SYNC:END -->\n<!-- HYPO:FEEDBACK-SYNC:START',
        '<!-- HYPO:FEEDBACK-SYNC:END -->\n- intruder line\n<!-- HYPO:FEEDBACK-SYNC:START',
      ),
    );
    const t = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude;
    assert.equal(t.intruder, true, 'precondition: intruder only');
    assert.equal(t.conflicts.length, 0, 'precondition: no conflicting block');
    assert.ok(!t.conflictRemedy.includes('--accept-wiki'), t.conflictRemedy);
    assert.match(t.conflictRemedy, /Move the hand-written lines outside the HYPO blocks/);
    assert.match(t.conflictRemedy, /--write/);
    // import has nothing to offer here: the text may say so, but must not tell the reader to run it
    assert.ok(!/Run `[^`]*--import-target-change/.test(t.conflictRemedy), t.conflictRemedy);
    assert.ok(!/[\u2014\u2013]| -- /.test(t.conflictRemedy), 'no dash in the text');
  });
});

test('feedback-sync-conflict-remedy-quotes-nothing-unsafe: a marker slug with shell syntax gets no accept command', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(
      p,
      readFileSync(p, 'utf-8')
        .replace('always do A', 'HAND EDITED A')
        .replace('START source=rule-a', 'START source=x$(id)')
        .replace('always do C', 'HAND EDITED C'),
    );
    const t = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude;
    assert.ok(
      t.conflicts.includes('x$(id)'),
      `precondition: the odd slug conflicts: ${t.conflicts}`,
    );
    assert.ok(!t.conflictRemedy.includes('x$(id)'), `no shell syntax pasted: ${t.conflictRemedy}`);
    assert.match(t.conflictRemedy, /--import-target-change --from=claude/);
    assert.match(t.conflictRemedy, /--accept-wiki=rule-c/, 'a plain slug still gets its command');
  });
});

test('doctor-conflict-remedy: doctor prints the report text; an unpaired target gets no accept part', () => {
  withDoctorFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C },
    ({ runFb, claudeHome, runDoctor }) => {
      assert.equal(runFb(['--write']).status, 0);
      const p = join(claudeHome, 'CLAUDE.md');
      const clean = readFileSync(p, 'utf-8');
      writeFileSync(p, clean.replace('always do A', 'HAND EDITED A'));
      const remedy = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude.conflictRemedy;
      const hit = runDoctor().fb.find((c) => c.label === 'Feedback projection integrity');
      assert.ok(hit && hit.status === 'fail', 'precondition: doctor fails the conflict');
      assert.ok(hit.detail.includes(remedy), `doctor must print the report's text: ${hit.detail}`);
      assert.ok(
        hit.detail.includes('--from=claude') && hit.detail.includes('--accept-wiki=rule-a'),
      );
      assert.ok(!/[\u2014\u2013]/.test(hit.detail), 'no dash in the doctor line');

      writeFileSync(
        p,
        clean
          .replace('always do A', 'HAND EDITED A')
          .replace('<!-- HYPO:FEEDBACK-SYNC:END -->', '- note'),
      );
      const un = runDoctor().fb.find((c) => c.label === 'Feedback projection integrity');
      assert.ok(un && un.status === 'fail', 'precondition: doctor still fails');
      assert.ok(un.detail.includes('--from=claude'), un.detail);
      assert.ok(!un.detail.includes('--accept-wiki'), `unpaired: no accept offered: ${un.detail}`);
    },
  );
});

test('feedback-sync-accept-discarded: accept reports the exact inner text it replaces (json and stderr), dry-run included', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    const innerOf = (text, slug) =>
      new RegExp(
        `<!-- HYPO:FEEDBACK-SYNC:START source=${slug} [^\\n]*-->\\n([\\s\\S]*?)\\n<!-- HYPO:FEEDBACK-SYNC:END -->`,
      ).exec(text)[1];
    const clean = readFileSync(p, 'utf-8');
    const edited = clean.replace('always do A', 'HAND EDITED A');
    writeFileSync(p, edited);
    const expected = innerOf(edited, 'rule-a');
    assert.ok(expected.includes('HAND EDITED A'), 'precondition');

    const dry = JSON.parse(runFb(['--accept-wiki=rule-a', '--dry-run', '--json']).stdout);
    assert.equal(dry.planned[0].discarded, expected, 'dry-run shows what would go');
    const dryErr = runFb(['--accept-wiki=rule-a', '--dry-run']).stderr;
    assert.ok(dryErr.includes(`would discard hand edit in ${p} for rule-a:\n${expected}`), dryErr);
    assert.equal(readFileSync(p, 'utf-8'), edited, 'dry-run wrote nothing');

    const r = runFb(['--accept-wiki=rule-a']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`discarded hand edit in ${p} for rule-a:\n${expected}`), r.stderr);
    assert.equal(readFileSync(p, 'utf-8'), clean, 'the wiki rendering is back');

    // rule-a's END and rule-c's START both deleted: the marker counts still pair and the
    // two blocks read as one. While rule-c's entry is still recognizable inside the span
    // accept refuses (see feedback-sync-accept-refuses-two-fused-blocks). Once the
    // neighbor's text was edited past recognition it cannot tell, and the report is
    // the only place the swallowed span stays visible.
    const fused = clean
      .replace('always do A', 'HAND EDITED A')
      .replace('always do C', 'HAND EDITED C')
      .replace('근거: [[rule-c]]', 'a note of mine')
      .replace('<!-- HYPO:FEEDBACK-SYNC:END -->\n', '')
      .replace(/<!-- HYPO:FEEDBACK-SYNC:START source=rule-c [^\n]*-->\n/, '');
    writeFileSync(p, fused);
    const rep = JSON.parse(runFb(['--accept-wiki=rule-a', '--json']).stdout);
    const got = rep.accepted[0].discarded;
    assert.ok(got.includes('HAND EDITED A') && got.includes('HAND EDITED C'), got);
  });
});

test('feedback-sync-accept-wiki-partial-failure: the error names the targets already accepted', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ claudeHome, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const edit = (f) =>
      writeFileSync(f, readFileSync(f, 'utf-8').replace(/do A|always do A/, 'HAND EDITED A'));
    const mem = join(memDir, 'MEMORY.md');
    const cl = join(claudeHome, 'CLAUDE.md');
    edit(mem);
    edit(cl);
    chmodSync(claudeHome, 0o500); // memory (written first) succeeds, claude's tmp file cannot be created
    try {
      const r = runFb(['--accept-wiki=rule-a', '--json']);
      assert.equal(r.status, 1);
      const out = JSON.parse(r.stdout);
      assert.match(out.error, /Already accepted before this failure: memory/);
      assert.deepEqual(
        out.accepted.map((a) => a.target),
        ['memory'],
      );
    } finally {
      chmodSync(claudeHome, 0o700);
    }
    assert.ok(!readFileSync(mem, 'utf-8').includes('HAND EDITED A'), 'memory was rewritten');
    assert.ok(readFileSync(cl, 'utf-8').includes('HAND EDITED A'), 'claude was not');
  });
});

test('feedback-sync-claude-auto-accept-compares-the-date: an /hypo:feedback append bumps updated, so the block stays a conflict until --accept-wiki', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    const page = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(page, readFileSync(page, 'utf-8').replace('always do A', 'HAND EDITED'));
    assert.equal(runFb(['--check']).status, 1, 'control: raw page edit matches byte for byte');

    // the supported reconcile path: append mode bumps `updated` to today
    const w = run('feedback.mjs', [
      '--topic=rule-a',
      '--entry=reconciled with the hand edit.',
      '--no-sync',
      `--hypo-dir=${wiki}`,
    ]);
    assert.equal(w.status, 0, w.stderr);
    assert.ok(!readFileSync(page, 'utf-8').includes('updated: 2026-05-20'), 'updated was bumped');

    const chk = runFb(['--check', '--json']);
    assert.equal(chk.status, 3, 'the date prefix now differs: still a conflict');
    assert.deepEqual(JSON.parse(chk.stdout).targets.claude.conflicts, ['rule-a']);
    assert.equal(runFb(['--accept-wiki=rule-a']).status, 0, 'accept resolves it');
    assert.equal(runFb(['--write']).status, 0);
    assert.equal(runFb(['--check']).status, 0);
    assert.ok(readFileSync(p, 'utf-8').includes('HAND EDITED. 근거: [[rule-a]]'));
  });
});

test('feedback-sync-import-skips-auto-accepted-block: a hand edit the page already matches is not imported as a conflict', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED'));
    const ctl = JSON.parse(
      runFb(['--import-target-change', '--from=claude', '--dry-run', '--json']).stdout,
    );
    assert.equal(ctl.imported.length, 1, 'control: a differing hand edit is imported');

    const page = join(wiki, 'pages', 'feedback', 'rule-a.md');
    writeFileSync(page, readFileSync(page, 'utf-8').replace('always do A', 'HAND EDITED'));
    const r = runFb(['--import-target-change', '--from=claude', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).imported.length, 0, 'matched block: no draft');
    assert.ok(!existsSync(fbDraftsDir(wiki)), 'no drafts dir created');
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
  // the drafts dir into pages/feedback/. basename() collapses traversal to the final
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
        existsSync(join(fbDraftsDir(wiki), 'escaped.md')),
        'traversal neutralized to a draft under the drafts dir',
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
      const draftsDir = fbDraftsDir(wiki);
      const drafts = existsSync(draftsDir) ? readdirSync(draftsDir) : [];
      assert.ok(drafts.includes('loose-y.md'), 'loose legacy MEMORY entry is drafted');
      assert.ok(!drafts.includes('managed-x.md'), 'managed-block entry must NOT be re-drafted');
    },
    { memoryMd },
  );
});

// ── bootstrap records the hand lines it drafted from; promotion + --write removes them ──

// The hand line links feedback_rule-b.md, the file the managed entry links too.
// (A hand line that links a different file, e.g. feedback_rule_b.md, is kept: see
// the underscore test below.) Its text differs from the managed line so the two
// can be told apart.
const FB_HAND_COLON = '- [Rule B](feedback_rule-b.md): written by hand';
const FB_HAND_DASH = `- [Rule B](feedback_rule-b.md) ${FB_EM} written by hand`;
const FB_MANAGED_B = '- [Rule B](feedback_rule-b.md): do B';
const fbHandRecord = (wiki) => join(wiki, '.cache', 'feedback-bootstrap-lines.json');
// every index line that names rule b, hand-written or managed
const fbBLines = (memDir) =>
  readFileSync(join(memDir, 'MEMORY.md'), 'utf-8')
    .split('\n')
    .filter((l) => /^- \[.*\]\(feedback_rule[_-]b\.md\)/.test(l));
// a promoted bootstrap draft keeps its bootstrap_origin key; the hand-line removal needs it
const fbPromoteB = (wiki) =>
  writeFileSync(
    join(wiki, 'pages', 'feedback', 'rule-b.md'),
    fbPage({ ...FB_PROJECT_L2, bootstrap_origin: 'memory-index' }),
  );

for (const [form, handLine] of [
  ['colon', FB_HAND_COLON],
  ['dash', FB_HAND_DASH],
]) {
  test(`feedback-sync-bootstrap-hand-line-removed-on-promotion (${form} form): one managed entry remains, check clean`, () => {
    const memoryMd = `# Memory Index\n${handLine}\n- unrelated manual note\n`;
    withFeedbackEnv(
      {},
      ({ wiki, memDir, runFb }) => {
        assert.equal(runFb(['--bootstrap']).status, 0);
        assert.ok(existsSync(join(fbDraftsDir(wiki), 'rule-b.md')), 'drafted');
        assert.ok(existsSync(fbHandRecord(wiki)), 'bootstrap recorded the line in the vault');
        fbPromoteB(wiki);
        assert.deepEqual(fbBLines(memDir), [handLine], 'precondition: only the hand line yet');
        assert.equal(runFb(['--check']).status, 1, 'precondition: managed entry not written yet');

        const r = runFb(['--write']);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(fbBLines(memDir), [FB_MANAGED_B], 'hand line gone, managed entry alone');
        const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
        assert.ok(mem.includes('- unrelated manual note'), 'unrelated line untouched');
        assert.equal(runFb(['--check']).status, 0, 'check clean');
        assert.ok(!existsSync(fbHandRecord(wiki)), 'record entry cleared after the removal');
      },
      { memoryMd },
    );
  });
}

test('feedback-sync-bootstrap-record-failure-is-a-warning: an unwritable line record does not abort bootstrap', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, runFb }) => {
      // a directory where the record file should be makes its rename throw; the drafts,
      // beside it under .cache/, are still written
      mkdirSync(fbHandRecord(wiki), { recursive: true });
      const r = runFb(['--bootstrap']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(fbDraftsDir(wiki), 'rule-b.md')), 'drafted');
      assert.match(r.stderr, /could not record hand lines; they will not be removed on promotion/);
      rmSync(join(fbDraftsDir(wiki), 'rule-b.md'));
      const j = runFb(['--bootstrap', '--json']);
      assert.equal(j.status, 0, j.stderr);
      assert.ok(
        (JSON.parse(j.stdout).warnings || []).some((w) => /could not record hand lines/.test(w)),
        'the --json report carries the same warning',
      );
    },
    { memoryMd },
  );
});

test('feedback-sync-bootstrap-hand-line-edited-is-kept: changed line survives, notice printed, managed entry added', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const p = join(memDir, 'MEMORY.md');
      writeFileSync(p, readFileSync(p, 'utf-8').replace('written by hand', 'reworded by hand'));
      fbPromoteB(wiki);
      assert.equal(fbBLines(memDir).length, 1, 'precondition: edited hand line present');

      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line in .*MEMORY\.md.*"rule-b"/);
      assert.ok(r.stderr.includes(FB_HAND_COLON), 'notice names the line as bootstrap saw it');
      assert.deepEqual(
        fbBLines(memDir),
        ['- [Rule B](feedback_rule-b.md): reworded by hand', FB_MANAGED_B],
        'edited line kept, managed entry added',
      );
      assert.ok(!existsSync(fbHandRecord(wiki)), 'noticed once, then the record is dropped');
    },
    { memoryMd },
  );
});

test('feedback-sync-hand-line-kept-and-removed-reach-the-json-report: --write --json carries handKept / handRemoved per target', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const p = join(memDir, 'MEMORY.md');
      writeFileSync(p, readFileSync(p, 'utf-8').replace('written by hand', 'reworded by hand'));
      fbPromoteB(wiki);
      const kept = JSON.parse(runFb(['--write', '--json']).stdout).targets.memory;
      assert.deepEqual(kept.handKept, [{ slug: 'rule-b', file: p, line: FB_HAND_COLON }]);
      assert.equal(kept.handRemoved, undefined);
    },
    { memoryMd },
  );
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      fbPromoteB(wiki);
      const t = JSON.parse(runFb(['--write', '--json']).stdout).targets.memory;
      assert.deepEqual(t.handRemoved, [
        { slug: 'rule-b', file: join(memDir, 'MEMORY.md'), line: FB_HAND_COLON },
      ]);
      assert.equal(t.handKept, undefined);
    },
    { memoryMd },
  );
});

test('feedback.mjs post-step prints the kept hand line even though feedback-sync exits 0', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, claudeHome, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const p = join(memDir, 'MEMORY.md');
      writeFileSync(p, readFileSync(p, 'utf-8').replace('written by hand', 'reworded by hand'));
      fbPromoteB(wiki);
      const w = run('feedback.mjs', [
        '--topic=rule-b',
        '--entry=still true.',
        `--hypo-dir=${wiki}`,
        `--claude-home=${claudeHome}`,
        '--project-id=proj',
      ]);
      assert.equal(w.status, 0, w.stderr);
      assert.match(w.stdout, /Projection refreshed/);
      assert.match(w.stderr, /kept the hand-written line in .*MEMORY\.md.*"rule-b"/);
    },
    { memoryMd },
  );
});

test('PreCompact self-heal surfaces the hand line the --write kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-kept-'));
  try {
    const id = process.cwd().replace(/[/.]/g, '-');
    const claudeHome = join(home, '.claude');
    const memDir = join(claudeHome, 'projects', id, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(claudeHome, 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
    writeFileSync(
      join(claudeHome, 'CLAUDE.md'),
      '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
    );
    const edited = '- [Rule B](feedback_rule-b.md): reworded by hand';
    writeFileSync(join(memDir, 'MEMORY.md'), `# Memory Index\n${edited}\n`);
    withWiki(
      (dir) => {
        // committed with the wiki, so the gate sees a clean tree and reaches the self-heal
        mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
        writeFileSync(
          join(dir, 'pages', 'feedback', 'rule-b.md'),
          fbPage({ ...FB_PROJECT_L2, scope: `project:${id}`, bootstrap_origin: 'memory-index' }),
        );
        mkdirSync(join(dir, '.cache'), { recursive: true });
        writeFileSync(
          fbHandRecord(dir),
          JSON.stringify({
            version: 1,
            lines: [
              {
                slug: 'rule-b',
                target: 'memory',
                file: join(memDir, 'MEMORY.md'),
                line: FB_HAND_COLON,
              },
            ],
          }),
        );
      },
      (dir) => {
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        assert.match(
          out.systemMessage || '',
          /re-synced/,
          `precondition: self-healed: ${r.stdout}`,
        );
        assert.match(
          out.systemMessage,
          /kept the hand-written line in .*MEMORY\.md.*"rule-b"/,
          `the notice must reach the user: ${r.stdout}`,
        );
        assert.ok(
          out.systemMessage.includes(FB_HAND_COLON),
          'it names the line as bootstrap saw it',
        );
        assert.ok(
          !existsSync(fbHandRecord(dir)),
          'the record entry is gone: this was the only chance',
        );
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('feedback-sync-side-file-without-provenance-is-not-overwritten: a hand-written feedback_<slug>.md survives, marked copies still refresh', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ memDir, runFb }) => {
    const side = join(memDir, 'feedback_rule-b.md');
    const mine = '# My own rule B\n\nA full body the wiki page does not have.\n';
    writeFileSync(side, mine);
    const r = runFb(['--write', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(side, 'utf-8'), mine, 'byte-identical after --write');
    const t = JSON.parse(r.stdout).targets.memory;
    assert.ok(
      (t.sideWarnings || []).some((w) => w.includes(side) && /not overwriting/.test(w)),
      `reported with the file named: ${r.stdout}`,
    );
    assert.ok(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8').includes('feedback_rule-b.md'));

    writeFileSync(side, '<!-- HYPO:FEEDBACK-SYNC source=rule-b -->\nstale copy\n');
    const r2 = runFb(['--write', '--json']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!readFileSync(side, 'utf-8').includes('stale copy'), 'a marked copy is refreshed');
    assert.equal(JSON.parse(r2.stdout).targets.memory.sideWarnings, undefined);
  });
});

test('feedback-sync-bootstrap-hand-line-ambiguous-is-kept: two identical hand lines, neither is deleted', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.deepEqual(
        fbBLines(memDir),
        [FB_HAND_COLON, FB_HAND_COLON],
        'precondition: two copies',
      );
      assert.equal(runFb(['--bootstrap']).status, 0);
      const rec = JSON.parse(readFileSync(fbHandRecord(wiki), 'utf-8'));
      assert.equal(rec.lines.length, 1, 'precondition: the second copy is a duplicate-in-batch');
      assert.equal(rec.lines[0].line, FB_HAND_COLON);
      fbPromoteB(wiki);

      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line in .*MEMORY\.md.*"rule-b"/);
      assert.deepEqual(
        fbBLines(memDir),
        [FB_HAND_COLON, FB_HAND_COLON, FB_MANAGED_B],
        'both hand lines kept, managed entry added',
      );
    },
    { memoryMd },
  );
});

test('feedback-sync-bootstrap-unrecorded-line-untouched: only the recorded line is ever deleted', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  // (a) a line added after bootstrap has no record
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const p = join(memDir, 'MEMORY.md');
      const other = '- [Other](feedback_other.md): keep me';
      writeFileSync(p, readFileSync(p, 'utf-8') + `${other}\n`);
      fbPromoteB(wiki);
      assert.equal(runFb(['--write']).status, 0);
      const mem = readFileSync(p, 'utf-8');
      assert.ok(mem.includes(other), 'unrecorded line survives');
      assert.deepEqual(fbBLines(memDir), [FB_MANAGED_B], 'recorded line is the one removed');
    },
    { memoryMd },
  );
  // (b) no bootstrap at all: the same promotion leaves the hand line (duplicate stays)
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      fbPromoteB(wiki);
      assert.equal(runFb(['--write']).status, 0);
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON, FB_MANAGED_B], 'no record, no deletion');
    },
    { memoryMd },
  );
});

test('feedback-sync-bootstrap-hand-line-between-blocks: dead end before promotion, removed and clean after', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ wiki, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(memDir, 'MEMORY.md');
    const endMark = '<!-- HYPO:FEEDBACK-SYNC:END -->\n';
    const text = readFileSync(p, 'utf-8');
    const at = text.indexOf(endMark) + endMark.length;
    writeFileSync(p, `${text.slice(0, at)}${FB_HAND_COLON}\n${text.slice(at)}`);
    assert.equal(runFb(['--check']).status, 3, 'precondition: intruder between blocks');

    assert.equal(runFb(['--bootstrap']).status, 0);
    assert.ok(existsSync(fbHandRecord(wiki)), 'precondition: line recorded');
    // not promoted yet: today's behavior is kept, the line is still an intruder
    assert.equal(runFb(['--check']).status, 3, 'unpromoted recorded line stays an intruder');
    assert.equal(runFb(['--write']).status, 3, 'and write still refuses');
    assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON], 'nothing was removed');

    fbPromoteB(wiki);
    assert.equal(runFb(['--check']).status, 1, 'promoted: pending drift, no longer an intruder');
    const r = runFb(['--write']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fbBLines(memDir), [FB_MANAGED_B], 'hand line removed, managed entry added');
    assert.equal(runFb(['--check']).status, 0, 'the former dead end is clean');
    const after = readFileSync(p, 'utf-8');
    assert.ok(after.includes('(feedback_rule-a.md)') && after.includes('(feedback_rule-c.md)'));
  });
});

test('feedback-sync-bootstrap-hand-line-underscore-link-is-kept: a user memory file keeps its index line', () => {
  // slug no-mocks => managed entry links feedback_no-mocks.md, a different file than
  // the hand line's feedback_no_mocks.md. Removing the hand line would orphan it.
  const hand = '- [No mocks](feedback_no_mocks.md): never mock the database';
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      const own = join(memDir, 'feedback_no_mocks.md');
      writeFileSync(own, '---\nname: no mocks\n---\nnever mock the database\n');
      assert.equal(runFb(['--bootstrap']).status, 0);
      assert.ok(existsSync(join(fbDraftsDir(wiki), 'no-mocks.md')), 'drafted');
      writeFileSync(
        join(wiki, 'pages', 'feedback', 'no-mocks.md'),
        fbPage({ ...FB_PROJECT_L2, title: 'No mocks', bootstrap_origin: 'memory-index' }),
      );
      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line in .*MEMORY\.md.*"no-mocks"/);
      const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(mem.split('\n').includes(hand), 'the hand line still points at the original file');
      assert.ok(mem.includes('(feedback_no-mocks.md)'), 'managed entry added beside it');
      assert.equal(
        readFileSync(own, 'utf-8'),
        '---\nname: no mocks\n---\nnever mock the database\n',
        'the user memory file is untouched',
      );
      assert.ok(!existsSync(fbHandRecord(wiki)), 'noticed once, then the record is dropped');
    },
    { memoryMd: `# Memory Index\n${hand}\n` },
  );
});

test('feedback-sync-bootstrap-hand-line-needs-bootstrap-origin: a lingering record never deletes a line for an unrelated page', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      assert.ok(existsSync(fbHandRecord(wiki)), 'precondition: recorded');
      // the draft was rejected, but its record lingers; later an unrelated page takes the slug
      rmSync(join(fbDraftsDir(wiki), 'rule-b.md'));
      const page = join(wiki, 'pages', 'feedback', 'rule-b.md');
      writeFileSync(page, fbPage(FB_PROJECT_L2));
      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON, FB_MANAGED_B], 'hand line survives');
      assert.ok(!r.stderr.includes('kept the hand-written line'), 'and it is not a kept notice');

      // once neither a draft nor a page is left, the record is pruned on the next write
      rmSync(page);
      assert.equal(runFb(['--write']).status, 0);
      assert.ok(!existsSync(fbHandRecord(wiki)), 'orphan record pruned');
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON], 'hand line still there');
    },
    { memoryMd },
  );
});

test('feedback-sync-import-traversal-source-stays-in-drafts: tampered source= neutralized', () => {
  // codex BLOCKER regression: a tampered `source=../escaped` managed marker must
  // not let --import write outside the drafts dir.
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
        readdirSync(fbDraftsDir(wiki)).some((f) => f.startsWith('escaped.import-claude-')),
        'tampered source neutralized into the drafts dir',
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
    const draftsDir = fbDraftsDir(wiki);
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
  const draftsDir = fbDraftsDir(wiki);
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
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=385307561ac01ec70b7890b5292503dd34db25b65800a955138c86b9a5de4524 -->
- [2026-05-20] always do A. 근거: [[rule-a]]
<!-- HYPO:FEEDBACK-SYNC:END -->
</learned_behaviors>

### FILE MEMORY.md
# Memory Index
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=be7aad44b99be849ab8fe781b4586559f04c42546f927eec592a70203aebc6de -->
- [Rule A](feedback_rule-a.md): do A
<!-- HYPO:FEEDBACK-SYNC:END -->
<!-- HYPO:FEEDBACK-SYNC:START source=rule-b sha256=fc9139eb4306741e179b9cea6e503f5945fc21614bc5ffeee1a894a74c7dd61c -->
- [Rule B](feedback_rule-b.md): do B
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
      "path": "<BASE>/wiki/.cache/feedback-drafts/legacy-claude-20260501-legacy-rule-one.md"
    },
    {
      "slug": "loose-y",
      "origin": "memory-index",
      "path": "<BASE>/wiki/.cache/feedback-drafts/loose-y.md"
    }
  ],
  "skipped": []
}

STDERR

=== PLAIN-RUN ===
STATUS 0
STDOUT

STDERR
[feedback-sync] created draft: .cache/feedback-drafts/legacy-claude-20260501-legacy-rule-one.md (claude-learned)
[feedback-sync] created draft: .cache/feedback-drafts/loose-y.md (memory-index)
[feedback-sync] bootstrap: 2 created, 0 skipped. Fill scope/tier/sensitivity/targets/promote_to_global and move into pages/feedback/. The drafts are in .cache/feedback-drafts/: not synced to other machines, and kept out of git when the vault is a git work tree (feedback-sync checked that git ignores .cache/).

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
sensitivity: TODO        # public | sanitized (private is forbidden); this draft holds your own text
priority: 3              # 1-5, higher wins over-cap
memory_summary: legacy rule one
global_summary: legacy rule one
promote_to_global: false # set true to project into <learned_behaviors>
reason: TODO
source: session:2026-05-01
created: 2026-05-01
updated: 2026-05-01
# keep the bootstrap_origin line below, it lets --write remove the hand line this draft came from
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
sensitivity: TODO        # public | sanitized (private is forbidden); this draft holds your own text
priority: 3              # 1-5, higher wins over-cap
memory_summary: legacy hand entry
global_summary: legacy hand entry
promote_to_global: false # set true to project into <learned_behaviors>
reason: TODO
source: TODO
# keep the bootstrap_origin line below, it lets --write remove the hand line this draft came from
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
      "path": "<BASE>/wiki/.cache/feedback-drafts/rule-a.import-claude-<STAMP>.md"
    }
  ],
  "skipped": []
}

STDERR

=== PLAIN-RUN ===
STATUS 0
STDOUT

STDERR
[feedback-sync] imported rule-a → <BASE>/wiki/.cache/feedback-drafts/rule-a.import-claude-<STAMP>.md
[feedback-sync] import: 1 draft(s). Reconcile into the SoT page, then feedback-sync --write.

### FILE CLAUDE.md
# Global
<learned_behaviors>
- manual entry
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=385307561ac01ec70b7890b5292503dd34db25b65800a955138c86b9a5de4524 -->
- [2026-05-20] HAND EDITED. 근거: [[rule-a]]
<!-- HYPO:FEEDBACK-SYNC:END -->
</learned_behaviors>

### FILE MEMORY.md
# Memory Index
<!-- HYPO:FEEDBACK-SYNC:START source=rule-a sha256=be7aad44b99be849ab8fe781b4586559f04c42546f927eec592a70203aebc6de -->
- [Rule A](feedback_rule-a.md): do A
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
sensitivity: TODO        # public | sanitized (private is forbidden); this draft holds your own text
priority: 3
memory_summary: - [2026-05-20] HAND EDITED. 근거: [[rule-a]]
global_summary: - [2026-05-20] HAND EDITED. 근거: [[rule-a]]
promote_to_global: false
reason: imported from claude <learned_behaviors>/MEMORY managed block (hand-edited)
source: TODO
imported_from: claude
---

# imported rule-a

> The managed block below was edited outside the wiki. Reconcile it into
> pages/feedback/rule-a.md (the SoT), then re-run feedback-sync --write.

- [2026-05-20] HAND EDITED. 근거: [[rule-a]]
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
        assert.notEqual(out.decision, 'block');
        const notice = out.systemMessage || '';
        assert.ok(
          notice.includes(claudeMdPath),
          `notice must name the exact target path: ${notice}`,
        );
        assert.ok(
          notice.includes('<learned_behaviors></learned_behaviors>'),
          `notice must name the literal container tag pair: ${notice}`,
        );
        assert.match(notice, /--ensure-container/, 'notice must name the remedy command');
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
          assert.match(
            out.systemMessage || '',
            /side file warning \(memory\): cannot read side file .*feedback_rule-a\.md.*Fix the permissions on that path; --ensure-container does not fix this/,
            `the unreadable kind keeps the permissions advice: ${r.stdout}`,
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

test('a hand-written side file notice names the warning and gives no permissions advice', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-handside-'));
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
        // a hand-written file under the name the wiki page would own: no provenance header
        const side = join(memDir, 'feedback_rule-a.md');
        const mine = '# My own rule A\n\nA body the wiki page does not have.\n';
        writeFileSync(side, mine);
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        const out = JSON.parse(r.stdout);
        const msg = out.systemMessage || '';
        assert.notEqual(
          out.decision,
          'block',
          `a hand-written side file must not block: ${r.stdout}`,
        );
        assert.match(
          msg,
          /feedback projection side file warning \(memory\): not overwriting .*feedback_rule-a\.md/,
          `the notice names the warning: ${r.stdout}`,
        );
        assert.match(msg, /The primary projection still loads every rule/);
        // the self-heal --write reports the same warning in its JSON: it must not be repeated
        assert.equal(msg.split('not overwriting').length - 1, 1, `shown once: ${msg}`);
        assert.ok(
          !/permissions|unreadable/i.test(msg),
          `a hand-written file is not a permission problem: ${r.stdout}`,
        );
        assert.equal(readFileSync(side, 'utf-8'), mine, 'the hand-written file is left alone');
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
    cpSync(join(REPO, 'hooks'), join(base, 'hooks'), { recursive: true }); // the vault lock lives there
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

test('feedback.mjs create: log.md line uses a colon separator, never an em dash', () => {
  withFeedbackWriterWiki((dir) => {
    writeFileSync(
      join(dir, 'log.md'),
      '# Log\n\n- 2026-01-01 feedback: [[pages/feedback/old]] \u2014 old line\n',
    );
    const r = run('feedback.mjs', [
      '--topic=log-sep',
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
    const lines = readFileSync(join(dir, 'log.md'), 'utf-8').trimEnd().split('\n');
    const line = lines[lines.length - 1];
    assert.ok(
      line.includes('feedback: [[pages/feedback/log-sep]]: 항상 X를 한다.'),
      `got: ${line}`,
    );
    assert.ok(!line.includes('\u2014'), `em dash in appended log line: ${line}`);
    assert.ok(
      lines.some((l) => l.includes('old line')),
      'pre-existing line must be left untouched',
    );
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

// ── hand-line removal keeps a copy and only takes the line that is still where it was ──

const fbKeptDir = (wiki) => join(wiki, '.cache', 'feedback-kept');

test('feedback-sync-hand-line-removal-keeps-a-copy: the removed line is saved under .cache/feedback-kept and named in the report', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      fbPromoteB(wiki);
      const r = runFb(['--write', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const t = JSON.parse(r.stdout).targets.memory;
      assert.deepEqual(fbBLines(memDir), [FB_MANAGED_B], 'precondition: the hand line is gone');
      assert.ok(t.handRemovedCopy && existsSync(t.handRemovedCopy), 'the report names the copy');
      assert.ok(t.handRemovedCopy.startsWith(fbKeptDir(wiki)), t.handRemovedCopy);
      assert.ok(readFileSync(t.handRemovedCopy, 'utf-8').includes(FB_HAND_COLON), 'line saved');
    },
    { memoryMd },
  );
  // the copy cannot be written: nothing is removed, nothing is written, exit 1
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      fbPromoteB(wiki);
      writeFileSync(fbKeptDir(wiki), 'a file where the copy directory should be');
      const before = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      const r = runFb(['--write']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /cannot keep a copy of the hand lines/);
      assert.equal(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'), before, 'MEMORY.md untouched');
    },
    { memoryMd },
  );
});

test('feedback-sync-hand-line-moved-is-kept: a recorded line moved under another heading is the user line now', () => {
  const memoryMd = `# Memory Index\n## Old\n${FB_HAND_COLON}\n## New\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const p = join(memDir, 'MEMORY.md');
      // same bytes, different place
      writeFileSync(p, `# Memory Index\n## Old\n## New\n${FB_HAND_COLON}\n`);
      fbPromoteB(wiki);
      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line in .*MEMORY\.md.*"rule-b"/);
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON, FB_MANAGED_B], 'the moved line survives');
      assert.deepEqual(
        readdirSync(fbKeptDir(wiki)).filter((f) => f.includes('hand-lines')),
        [],
        'nothing was removed, so no hand-line copy was made',
      );
    },
    { memoryMd },
  );
});

test('feedback-sync-hand-line-with-a-second-link-is-kept: the other file keeps its only index link', () => {
  const hand = `${FB_HAND_COLON}, see [detail](feedback_detail.md)`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      assert.ok(existsSync(fbHandRecord(wiki)), 'precondition: recorded');
      fbPromoteB(wiki);
      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line/);
      const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      assert.ok(mem.split('\n').includes(hand), 'the two-link line survives whole');
      assert.ok(mem.includes(FB_MANAGED_B), 'managed entry added beside it');
    },
    { memoryMd: `# Memory Index\n${hand}\n` },
  );
});

test('feedback-sync-hand-line-record-without-a-place-is-kept: an older record shape never deletes', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const rec = JSON.parse(readFileSync(fbHandRecord(wiki), 'utf-8'));
      for (const l of rec.lines) delete l.section;
      writeFileSync(fbHandRecord(wiki), JSON.stringify(rec));
      fbPromoteB(wiki);
      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line/);
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON, FB_MANAGED_B]);
    },
    { memoryMd },
  );
});

// ── accept: a copy first, an exit code that says so when a target is refused ──

test('feedback-sync-accept-keeps-the-original: the file as it was is copied before it is replaced, and an unwritable copy stops the write', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C },
    ({ wiki, claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const p = join(claudeHome, 'CLAUDE.md');
      const edited = readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED A');
      writeFileSync(p, edited);

      // the copy cannot be written: exit 1, the file keeps every byte
      mkdirSync(join(wiki, '.cache'), { recursive: true });
      rmSync(fbKeptDir(wiki), { recursive: true, force: true }); // the --write above kept copies
      writeFileSync(fbKeptDir(wiki), 'a file where the copy directory should be');
      const bad = runFb(['--accept-wiki=rule-a']);
      assert.equal(bad.status, 1, bad.stderr);
      assert.match(bad.stderr, /cannot keep a copy of .*CLAUDE\.md.*Nothing was written to it/);
      assert.equal(readFileSync(p, 'utf-8'), edited, 'not replaced without a copy');
      rmSync(fbKeptDir(wiki));

      const r = runFb(['--accept-wiki=rule-a', '--json']);
      assert.equal(r.status, 0, r.stderr);
      const a = JSON.parse(r.stdout).accepted[0];
      assert.ok(a.kept.startsWith(fbKeptDir(wiki)), a.kept);
      assert.equal(readFileSync(a.kept, 'utf-8'), edited, 'the copy is the whole file as it was');
      assert.ok(readFileSync(p, 'utf-8').includes('always do A'), 'and the file was replaced');
      // a dry run writes no copy
      writeFileSync(p, edited);
      const before = readdirSync(fbKeptDir(wiki)).length;
      assert.equal(runFb(['--accept-wiki=rule-a', '--dry-run']).status, 0);
      assert.equal(readdirSync(fbKeptDir(wiki)).length, before, 'dry run copies nothing');
    },
  );
});

test('feedback-sync-accept-partial-refusal-exits-3: one target accepted, another malformed, the exit code says it is not done', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C },
    ({ memDir, claudeHome, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const mem = join(memDir, 'MEMORY.md');
      writeFileSync(mem, readFileSync(mem, 'utf-8').replace('do A', 'HAND A'));
      const p = join(claudeHome, 'CLAUDE.md');
      const damaged = readFileSync(p, 'utf-8')
        .replace('always do A', 'HAND EDITED A')
        .replace('<!-- HYPO:FEEDBACK-SYNC:END -->', '- note');
      writeFileSync(p, damaged);

      const r = runFb(['--accept-wiki=rule-a', '--json']);
      assert.equal(r.status, 3, r.stderr);
      const rep = JSON.parse(r.stdout);
      assert.deepEqual(
        rep.accepted.map((a) => a.target),
        ['memory'],
      );
      assert.deepEqual(
        rep.refused.filter((x) => x.unresolved).map((x) => x.target),
        ['claude'],
      );
      assert.equal(readFileSync(p, 'utf-8'), damaged, 'the malformed file is untouched');
      assert.match(
        runFb(['--accept-wiki=rule-a']).stderr,
        /NOT accepted in claude|not in conflict/,
      );
      assert.equal(runFb(['--check']).status, 3, 'and it is indeed still blocked');
    },
  );
});

test('feedback-sync-conflict-remedy-mixed-shape: a conflict that is also an intruder names the move step, and accept alone leaves it blocked', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C }, ({ claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    writeFileSync(
      p,
      readFileSync(p, 'utf-8')
        .replace('always do A', 'HAND EDITED A')
        .replace(
          '<!-- HYPO:FEEDBACK-SYNC:END -->\n<!-- HYPO:FEEDBACK-SYNC:START',
          '<!-- HYPO:FEEDBACK-SYNC:END -->\n- intruder line\n<!-- HYPO:FEEDBACK-SYNC:START',
        ),
    );
    const t = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude;
    assert.deepEqual([t.conflicts, t.intruder], [['rule-a'], true], 'precondition: mixed');
    assert.match(t.conflictRemedy, /--import-target-change --from=claude/);
    assert.match(t.conflictRemedy, /--accept-wiki=rule-a/);
    assert.match(t.conflictRemedy, /Move the hand-written lines outside the HYPO blocks/);
    assert.ok(!/[—–]| -- /.test(t.conflictRemedy), 'no dash in the text');

    assert.equal(runFb(['--import-target-change', '--from=claude']).status, 0);
    assert.equal(runFb(['--accept-wiki=rule-a']).status, 0);
    const after = JSON.parse(runFb(['--check', '--json']).stdout).targets.claude;
    assert.deepEqual([after.conflicts, after.intruder], [[], true], 'accept did not clear it');
    assert.match(after.conflictRemedy, /Move the hand-written lines/);
  });
});

test('feedback-sync-accept-remove-block-at-eof-in-a-crlf-file: the line ending before the block goes with it, no lone CR is left', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const mem = join(memDir, 'MEMORY.md');
    const crlf = readFileSync(mem, 'utf-8')
      .replace('do A', 'HAND A')
      .replace(/\n/g, '\r\n')
      .replace(/\r\n$/, '');
    writeFileSync(mem, crlf);
    writeFileSync(
      join(wiki, 'pages', 'feedback', 'rule-a.md'),
      fbPage({ ...FB_GLOBAL_L1, status: 'archived' }),
    );
    assert.ok(crlf.startsWith('# Memory Index\r\n') && !crlf.endsWith('\n'), 'precondition');
    const r = runFb(['--accept-wiki=rule-a', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).accepted.find((a) => a.target === 'memory').action, 'remove');
    assert.equal(readFileSync(mem, 'utf-8'), '# Memory Index', 'no \\r left on the line before');
  });
});

// ── the gate and doctor read the report shapes they can get ──

test('PreCompact notices a side-file warning that comes with a clean (exit 0) check', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-cleanside-'));
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
        const side = join(memDir, 'feedback_rule-a.md');
        writeFileSync(side, '# My own rule A\n');
        const fb = (mode) =>
          spawnSync(
            process.execPath,
            [
              join(REPO, 'scripts', 'feedback-sync.mjs'),
              mode,
              '--json',
              '--no-input',
              `--hypo-dir=${dir}`,
              `--claude-home=${join(home, '.claude')}`,
              `--project-id=${projectId}`,
            ],
            { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME } },
          );
        assert.equal(fb('--write').status, 0, 'precondition: projected');
        const chk = fb('--check');
        assert.equal(chk.status, 0, 'precondition: the check is clean');
        assert.ok(
          (JSON.parse(chk.stdout).targets.memory.sideWarnings || []).length,
          'precondition: and still carries the side warning',
        );
        const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
        assert.match(
          JSON.parse(r.stdout).systemMessage || '',
          /side file warning \(memory\): not overwriting .*feedback_rule-a\.md/,
          r.stdout,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

test('PreCompact conflict notice for an older script report: no state-specific command, a generic pointer', () => {
  withWiki(
    (dir) => {
      mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'feedback', 'rule-a.md'), fbPage(FB_GLOBAL_L1));
    },
    (dir) => {
      const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-oldscript-'));
      const pkg = mkdtempSync(join(tmpdir(), 'hypo-fbhook-oldpkg-'));
      try {
        mkdirSync(join(home, '.claude'), { recursive: true });
        mkdirSync(join(pkg, 'scripts'), { recursive: true });
        // an older feedback-sync: an intruder-only target, and no conflictRemedy field
        writeFileSync(
          join(pkg, 'scripts', 'feedback-sync.mjs'),
          'console.log(JSON.stringify({ targets: { claude: { candidates: 1, conflicts: [], unpaired: false, intruder: true, outOfContainer: false, overCap: false, dirty: false } } }));\nprocess.exit(3);\n',
        );
        writeFileSync(
          join(pkg, 'package.json'),
          JSON.stringify({ name: 'hypomnema', version: '1.0.0' }),
        );
        writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: pkg }));
        // the hook as an installed copy: with no package beside it, the provenance file
        // beside the copy is what points it at the stub script (self-location would find
        // this checkout instead)
        const hooks = join(home, '.claude', 'hooks');
        cpSync(join(REPO, 'hooks'), hooks, { recursive: true });
        writeFileSync(
          join(hooks, '.hypo-provenance.json'),
          JSON.stringify({
            pkgRoot: pkg,
            hypoSharedSha256: createHash('sha256')
              .update(readFileSync(join(hooks, 'hypo-shared.mjs')))
              .digest('hex'),
          }),
        );
        const r = spawnSync(process.execPath, [join(hooks, 'hypo-personal-check.mjs')], {
          input: '',
          encoding: 'utf-8',
          env: { ...process.env, HOME: home, HYPO_DIR: dir },
        });
        const msg = JSON.parse(r.stdout).systemMessage || '';
        assert.match(msg, /feedback projection conflict \(manual edit of claude\)/, r.stdout);
        assert.match(msg, /sent no remedy for this target/, r.stdout);
        assert.ok(!msg.includes('--import-target-change'), `no import advice: ${msg}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
        rmSync(pkg, { recursive: true, force: true });
      }
    },
  );
});

test('doctor-side-file-advice-by-kind: a hand-written side file is told to rename or delete, not to fix permissions', () => {
  withDoctorFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ runFb, runDoctor, memDir }) => {
    writeFileSync(join(memDir, 'feedback_rule-a.md'), '# My own rule A\n');
    assert.equal(runFb(['--write']).status, 0, 'precondition: projected around the hand file');
    const hit = runDoctor().fb.find((c) => c.label === 'Feedback projection side file');
    assert.ok(hit, 'the warning reaches doctor');
    assert.match(hit.detail, /not overwriting .*feedback_rule-a\.md.*Rename or delete it/);
    assert.ok(!/permissions/i.test(hit.detail), `no permission advice: ${hit.detail}`);
  });
});

// ── F2: user work in generated files, concurrent writers, a kept copy that must stay local ──

// the managed side-file copy of rule b, with the provenance header on line 1
const fbSideB = (memDir) => join(memDir, 'feedback_rule-b.md');
const fbRuleBV2 = { ...FB_PROJECT_L2, reason: 'because B, second version' };

test('feedback-sync-side-file-edited-after-generation-is-not-overwritten: user text appended under the provenance header blocks the rewrite, exit 3, bytes kept', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const side = fbSideB(memDir);
    assert.ok(readFileSync(side, 'utf-8').startsWith('<!-- HYPO:FEEDBACK-SYNC source=rule-b -->'));
    const edited = readFileSync(side, 'utf-8') + '\nMY OWN NOTES ON RULE B\n';
    writeFileSync(side, edited);
    // the wiki page moves on, so the copy would be rewritten
    writeFileSync(join(wiki, 'pages', 'feedback', 'rule-b.md'), fbPage(fbRuleBV2));
    const mem = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');

    const r = runFb(['--write', '--json']);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    const t = JSON.parse(r.stdout).targets.memory;
    assert.deepEqual(t.sideEdited, [side]);
    assert.match(t.conflictRemedy, /Copy your edits out of .*feedback_rule-b\.md/);
    assert.ok(
      (t.sideWarnings || []).some((w) => /not overwriting/.test(w) && w.includes(side)),
      JSON.stringify(t.sideWarnings),
    );
    assert.equal(readFileSync(side, 'utf-8'), edited, 'the edited file keeps every byte');
    assert.equal(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'), mem, 'nothing else was written');
    assert.equal(runFb(['--check']).status, 3, 'check says so too');

    // the way out the message names: move the edits, delete the file, write again
    rmSync(side);
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(readFileSync(side, 'utf-8').includes('because B, second version'));
    assert.equal(runFb(['--check']).status, 0, 'recorded again, clean');
  });
});

test('feedback-sync-side-file-edited-after-generation-is-not-removed: a demoted page keeps the copy that holds user text', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const side = fbSideB(memDir);
    const edited = readFileSync(side, 'utf-8') + '\nMY OWN NOTES\n';
    writeFileSync(side, edited);
    writeFileSync(
      join(wiki, 'pages', 'feedback', 'rule-b.md'),
      fbPage({ ...FB_PROJECT_L2, status: 'archived' }),
    );
    const r = runFb(['--write', '--json']);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout).targets.memory.sideEdited, [side]);
    assert.equal(readFileSync(side, 'utf-8'), edited, 'not removed');
  });
});

test('feedback-sync-side-file-without-a-record-is-trusted-once: an older generated copy is refreshed and recorded', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const record = join(wiki, '.cache', 'feedback-side-files.json');
    assert.ok(existsSync(record), 'the write recorded the hash of what it generated');
    rmSync(record);
    writeFileSync(fbSideB(memDir), '<!-- HYPO:FEEDBACK-SYNC source=rule-b -->\nolder copy\n');
    assert.equal(runFb(['--write']).status, 0, 'no record: trusted this once');
    assert.ok(readFileSync(fbSideB(memDir), 'utf-8').includes('body'));
    assert.ok(existsSync(record), 'and recorded by that write');
    writeFileSync(fbSideB(memDir), readFileSync(fbSideB(memDir), 'utf-8') + 'late edit\n');
    assert.equal(runFb(['--write']).status, 3, 'from then on it is protected');
  });
});

test('feedback-sync-write-reads-each-file-again-before-replacing-it: a target changed after preflight is not overwritten', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome, memDir }) => {
    const target = memoryTarget({ claudeHome }, 'proj');
    const res = evaluateTarget(loadFeedbackPages(wiki), target, [], {});
    assert.ok(res.dirty, 'precondition: a write is planned');
    // somebody edits MEMORY.md after the plan was made
    const edited = '# Memory Index\n- my own line, added a moment ago\n';
    writeFileSync(join(memDir, 'MEMORY.md'), edited);
    assert.throws(
      () => applyTarget(target, res),
      (err) => err.code === 'ECHANGED' && /MEMORY\.md changed after it was read/.test(err.message),
    );
    assert.equal(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'), edited, 'not overwritten');
  });
});

test('feedback-sync-writes-hold-a-vault-lock: a held lock stops a write with exit 1, a normal run leaves no lock behind', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    const lock = join(wiki, '.cache', 'feedback-sync.lock');
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(!existsSync(lock), 'released after the run');
    const claude = readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8');
    // a live holder (this test process) with a fresh lock file
    writeFileSync(lock, String(process.pid));
    const r = runFb(['--write']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /another feedback-sync run holds the vault lock/);
    assert.equal(readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8'), claude);
    assert.equal(runFb(['--check']).status, 0, 'a read-only check does not wait for the lock');
  });
});

// A vault whose own .gitignore lacks .cache/: the copies of the user's files would be
// staged by the auto-commit, so nothing is written there.
const fbGitInit = (wiki, ignore) => {
  const env = { ...process.env, HOME: SESSION_TMP_HOME };
  assert.equal(spawnSync('git', ['init', '-q', wiki], { env }).status, 0);
  if (ignore !== null) writeFileSync(join(wiki, '.gitignore'), ignore);
};

test('feedback-sync-kept-copy-needs-an-ignored-cache: a vault git that would stage .cache/ gets no copy and the write is refused', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      fbGitInit(wiki, '.cache/\n');
      assert.equal(runFb(['--bootstrap']).status, 0);
      assert.ok(
        existsSync(fbHandRecord(wiki)),
        'precondition: the record is written while ignored',
      );
      fbPromoteB(wiki);
      const before = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
      // the vault's own .gitignore does not name .cache/
      writeFileSync(join(wiki, '.gitignore'), 'node_modules/\n');
      const r = runFb(['--write']);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /cannot keep a copy .*not ignored by the vault's git/);
      assert.equal(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8'), before, 'nothing written');
      assert.ok(!existsSync(fbKeptDir(wiki)), 'and no copy of the file was made');
      // ignoring it is the way out
      writeFileSync(join(wiki, '.gitignore'), '/.cache/\n');
      assert.equal(runFb(['--write']).status, 0);
      assert.ok(readdirSync(fbKeptDir(wiki)).length > 0, 'the copy is made once git ignores it');
    },
    { memoryMd },
  );
});

test('feedback-sync-kept-copy-needs-an-ignored-cache: accept and the bootstrap line record are held to the same rule', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const p = join(claudeHome, 'CLAUDE.md');
    const edited = readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED A');
    writeFileSync(p, edited);
    fbGitInit(wiki, '# no cache rule\n');
    const copies = readdirSync(fbKeptDir(wiki)).length;
    const r = runFb(['--accept-wiki=rule-a']);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not ignored by the vault's git/);
    assert.equal(readFileSync(p, 'utf-8'), edited, 'not replaced without a copy');
    assert.equal(readdirSync(fbKeptDir(wiki)).length, copies, 'no copy was made');
  });
  withFeedbackEnv(
    {},
    ({ wiki, runFb }) => {
      // only the drafts dir is ignored: the record beside it, and the temp file a draft is
      // written to before it is linked into place, would not be, so nothing is written at all
      for (const rule of ['.cache/feedback-drafts/\n', '/.cache/feedback-drafts/*.md\n']) {
        fbGitInit(wiki, rule);
        const r = runFb(['--bootstrap']);
        assert.equal(r.status, 1, `${rule}: ${r.stderr}`);
        assert.match(r.stderr, /no draft was written: \.cache\/ is not ignored by the vault's git/);
        assert.ok(!existsSync(fbHandRecord(wiki)), 'the hand lines are not copied under .cache/');
        assert.ok(!existsSync(fbDraftsDir(wiki)), 'and no draft or temp file was made');
      }
    },
    { memoryMd: `# Memory Index\n${FB_HAND_COLON}\n` },
  );
});

// ── drafts hold the user's own text: they go where git does not look, and are never replaced ──

// A run of one mode in this process, with the test-only hooks that stand in for a second
// run (or a crash) landing between two steps.
const fbInProcess = ({ wiki, claudeHome }, flags, testHooks) =>
  fbRun({
    ...fbParseArgs([
      'node',
      'feedback-sync.mjs',
      ...flags,
      `--hypo-dir=${wiki}`,
      `--claude-home=${claudeHome}`,
      '--project-id=proj',
    ]),
    testHooks,
  });
// the files git would stage in the vault right now
const fbGitStaged = (wiki) => {
  const r = spawnSync('git', ['-C', wiki, 'status', '--porcelain', '--untracked-files=all'], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
};
// a managed block in CLAUDE.md that somebody edited by hand: --import-target-change has work
const fbHandEditClaude = (claudeHome, runFb) => {
  assert.equal(runFb(['--write']).status, 0);
  const p = join(claudeHome, 'CLAUDE.md');
  writeFileSync(p, readFileSync(p, 'utf-8').replace('always do A', 'HAND EDITED A'));
};

test('feedback-sync-drafts-are-invisible-to-git: bootstrap and import drafts land under an ignored .cache/ and git status does not list them', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, claudeHome, runFb }) => {
      fbGitInit(wiki, '.cache/\n');
      fbHandEditClaude(claudeHome, runFb);
      const rb = runFb(['--bootstrap', '--json']);
      assert.equal(rb.status, 0, rb.stderr);
      const ri = runFb(['--import-target-change', '--from=claude', '--json']);
      assert.equal(ri.status, 0, ri.stderr);
      const made = [
        ...JSON.parse(rb.stdout).created.map((c) => c.path),
        ...JSON.parse(ri.stdout).imported.map((c) => c.path),
      ];
      assert.equal(made.length, 2, 'one bootstrap draft and one import draft');
      for (const path of made) {
        assert.equal(join(path, '..'), fbDraftsDir(wiki), `${path} is in the drafts dir`);
        assert.ok(existsSync(path));
        const ignored = spawnSync('git', ['-C', wiki, 'check-ignore', '-q', path], {
          env: { ...process.env, HOME: SESSION_TMP_HOME },
        });
        assert.equal(ignored.status, 0, `git ignores ${path}`);
      }
      assert.ok(
        readFileSync(made[1], 'utf-8').includes('HAND EDITED A'),
        'the import draft holds the edited block',
      );
      assert.ok(
        !fbGitStaged(wiki).some((l) => /feedback-drafts|\.cache/.test(l)),
        `git sees no draft: ${fbGitStaged(wiki)}`,
      );
      assert.ok(
        !existsSync(join(wiki, 'pages', 'feedback', '_drafts')),
        'nothing is written to the old place',
      );
      // a draft is a copy of your own text and has no sensitivity decided yet
      assert.match(readFileSync(made[0], 'utf-8'), /^sensitivity: TODO\b/m);
      assert.match(readFileSync(made[1], 'utf-8'), /^sensitivity: TODO\b/m);
    },
    {
      claudeMd: '# Global\n<learned_behaviors>\n- [2026-05-20] a hand rule\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-drafts-need-an-ignored-cache: a vault whose git would stage .cache/ gets no draft, and the reason is reported', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, claudeHome, runFb }) => {
      fbHandEditClaude(claudeHome, runFb);
      fbGitInit(wiki, 'node_modules/\n');
      const reason = /no draft was written: .*not ignored by the vault's git/;
      for (const args of [
        ['--bootstrap'],
        ['--bootstrap', '--dry-run'],
        ['--import-target-change', '--from=claude'],
        ['--import-target-change', '--from=claude', '--dry-run'],
      ]) {
        const r = runFb(args);
        assert.equal(r.status, 1, `${args}: ${r.stderr}`);
        assert.match(r.stderr, reason, args.join(' '));
      }
      const j = runFb(['--bootstrap', '--json']);
      assert.equal(j.status, 1);
      assert.match(JSON.parse(j.stdout).error, reason, 'the --json report says why');
      assert.ok(!existsSync(join(wiki, '.cache', 'feedback-drafts')), 'no draft dir, no draft');
      assert.ok(!existsSync(fbHandRecord(wiki)), 'and no hand line record');
      // ignoring .cache/ is the way out
      writeFileSync(join(wiki, '.gitignore'), '.cache/\n');
      assert.equal(runFb(['--bootstrap']).status, 0);
      assert.equal(runFb(['--import-target-change', '--from=claude']).status, 0);
      assert.equal(readdirSync(fbDraftsDir(wiki)).length, 2);
    },
    {
      claudeMd: '# Global\n<learned_behaviors>\n- [2026-05-20] a hand rule\n</learned_behaviors>\n',
    },
  );
});

test('feedback-sync-draft-name-taken-meanwhile-is-not-overwritten: a draft that appears after the name was chosen keeps its bytes', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    (ctx) => {
      const { wiki, claudeHome, runFb } = ctx;
      // bootstrap: somebody creates rule-b's draft after it was found missing
      const theirs = join(fbDraftsDir(wiki), 'rule-b.md');
      const out = fbInProcess(ctx, ['--bootstrap'], {
        beforePublish: (tmp, file) => {
          mkdirSync(fbDraftsDir(wiki), { recursive: true });
          writeFileSync(file, 'THEIR DRAFT');
        },
      });
      assert.equal(out.code, 0, out.error);
      assert.equal(readFileSync(theirs, 'utf-8'), 'THEIR DRAFT', 'their bytes are untouched');
      assert.deepEqual(out.report.created, []);
      assert.deepEqual(out.report.skipped, [{ slug: 'rule-b', reason: 'draft-exists' }]);
      assert.ok(!existsSync(fbHandRecord(wiki)), 'a draft this run did not write records no line');
      assert.deepEqual(readdirSync(fbDraftsDir(wiki)), ['rule-b.md'], 'no tmp file is left');

      // import: the name that was picked is taken too, the draft goes to the next free one
      fbHandEditClaude(claudeHome, runFb);
      let taken = null;
      const imp = fbInProcess(ctx, ['--import-target-change', '--from=claude'], {
        beforePublish: (tmp, file) => {
          if (taken) return;
          taken = file;
          writeFileSync(file, 'THEIR IMPORT');
        },
      });
      assert.equal(imp.code, 0, imp.error);
      assert.equal(readFileSync(taken, 'utf-8'), 'THEIR IMPORT', 'their bytes are untouched');
      assert.equal(imp.report.imported.length, 1);
      assert.notEqual(imp.report.imported[0].path, taken, 'it moved on to another name');
      assert.ok(readFileSync(imp.report.imported[0].path, 'utf-8').includes('HAND EDITED A'));
    },
    { memoryMd },
  );
});

test('feedback-sync-draft-failed-before-publish-leaves-no-draft-and-no-tmp: a finished tmp file is removed when the step before the link throws, nothing is under the final name, and a re-run drafts it', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    (ctx) => {
      const { wiki } = ctx;
      const out = fbInProcess(ctx, ['--bootstrap'], {
        beforePublish: () => {
          throw new Error('disk gone');
        },
      });
      assert.equal(out.code, 1);
      assert.match(out.error, /cannot write the draft .*rule-b\.md: disk gone/);
      assert.deepEqual(readdirSync(fbDraftsDir(wiki)), [], 'no draft, no stray tmp file');
      assert.ok(!existsSync(fbHandRecord(wiki)), 'no line is recorded for a draft that failed');
      // the re-run is not told "draft-exists"
      const again = fbInProcess(ctx, ['--bootstrap']);
      assert.equal(again.code, 0, again.error);
      assert.deepEqual(
        again.report.created.map((c) => c.slug),
        ['rule-b'],
      );
      assert.match(readFileSync(join(fbDraftsDir(wiki), 'rule-b.md'), 'utf-8'), /written by hand/);
    },
    { memoryMd },
  );
});

test('feedback-sync-draft-write-cut-short-leaves-no-half-draft: a tmp file that fails part way through its own write is removed, the final name never appears, and a re-run drafts it', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    (ctx) => {
      const { wiki } = ctx;
      let tmpSeen = null;
      const out = fbInProcess(ctx, ['--bootstrap'], {
        // half of the bytes reach the disk, then the write fails
        writeTmp: (tmp, content) => {
          tmpSeen = tmp;
          writeFileSync(tmp, content.slice(0, Math.floor(content.length / 2)), { flag: 'wx' });
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        },
      });
      assert.equal(out.code, 1);
      assert.match(out.error, /cannot write the draft .*rule-b\.md: no space left/);
      assert.ok(tmpSeen, 'precondition: the injected write ran');
      assert.deepEqual(readdirSync(fbDraftsDir(wiki)), [], 'the half-written tmp file is gone');
      assert.ok(!existsSync(join(fbDraftsDir(wiki), 'rule-b.md')), 'and no half draft');
      assert.ok(!existsSync(fbHandRecord(wiki)), 'no line is recorded for a draft that failed');
      const again = fbInProcess(ctx, ['--bootstrap']);
      assert.equal(again.code, 0, again.error);
      assert.match(readFileSync(join(fbDraftsDir(wiki), 'rule-b.md'), 'utf-8'), /written by hand/);
    },
    { memoryMd },
  );
});

test('feedback-sync-legacy-drafts-are-still-read: a draft in the old pages/feedback/_drafts/ is neither redrafted nor lets its hand line record go', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      // a draft an earlier version wrote, with the record that goes with it
      assert.equal(runFb(['--bootstrap']).status, 0);
      const legacyDir = join(wiki, 'pages', 'feedback', '_drafts');
      mkdirSync(legacyDir, { recursive: true });
      const legacy = join(legacyDir, 'rule-b.md');
      const bytes = readFileSync(join(fbDraftsDir(wiki), 'rule-b.md'), 'utf-8');
      writeFileSync(legacy, bytes);
      rmSync(join(fbDraftsDir(wiki), 'rule-b.md'));
      // bootstrap sees it and drafts nothing
      const r = JSON.parse(runFb(['--bootstrap', '--json']).stdout);
      assert.deepEqual(r.created, []);
      assert.deepEqual(r.skipped, [
        { slug: 'rule-b', reason: 'draft-exists-legacy', path: legacy },
      ]);
      assert.equal(r.warnings, undefined, 'a vault that is not a git tree has nothing to warn of');
      assert.ok(!existsSync(join(fbDraftsDir(wiki), 'rule-b.md')), 'no second copy');
      // a write with neither page nor new-place draft keeps the record while the old draft is there
      assert.equal(runFb(['--write']).status, 0);
      assert.ok(existsSync(fbHandRecord(wiki)), 'the record waits for the old draft');
      assert.equal(readFileSync(legacy, 'utf-8'), bytes, 'and the old draft is not touched');
      // once the old draft is gone too, the record is pruned
      rmSync(legacy);
      assert.equal(runFb(['--write']).status, 0);
      assert.ok(!existsSync(fbHandRecord(wiki)), 'orphan record pruned');
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON], 'the hand line is still there');
    },
    { memoryMd },
  );
});

test('feedback-sync-ensure-container-reads-again-and-keeps-a-copy: a CLAUDE.md saved after it was read is not replaced, a normal run keeps the original', () => {
  const original = '# Global\n\nprose the user cares about\n';
  withFeedbackEnv(
    {},
    (ctx) => {
      const { wiki, claudeHome } = ctx;
      const p = join(claudeHome, 'CLAUDE.md');
      const edited = original + 'a line saved a moment ago\n';
      const out = fbInProcess(ctx, ['--ensure-container'], {
        beforeEnsureWrite: () => writeFileSync(p, edited),
      });
      assert.equal(out.code, 1);
      assert.match(
        out.error,
        /CLAUDE\.md changed after it was read for this write.*not overwritten/,
      );
      assert.equal(readFileSync(p, 'utf-8'), edited, 'the saved bytes are still there');
      // run from the start: the container is added, and the file as it was is kept
      const ok = fbInProcess(ctx, ['--ensure-container']);
      assert.equal(ok.code, 0, ok.error);
      assert.ok(readFileSync(p, 'utf-8').startsWith(edited));
      const copies = readdirSync(fbKeptDir(wiki)).filter((f) =>
        /claude-before-ensure-container/.test(f),
      );
      assert.equal(copies.length, 2, 'one copy per run that reached the write step');
      assert.ok(
        copies.some((f) => readFileSync(join(fbKeptDir(wiki), f), 'utf-8') === edited),
        'the copy holds the bytes the replace was about to cover',
      );
    },
    { claudeMd: original },
  );
  // a vault whose git would stage .cache/ gets no copy: the append goes on, with a warning
  withFeedbackEnv(
    {},
    ({ wiki, claudeHome, runFb }) => {
      // a child process, so the vault's git sees the pinned HOME and not the runner's
      // global excludes
      fbGitInit(wiki, 'node_modules/\n');
      const p = join(claudeHome, 'CLAUDE.md');
      const warned = /no copy of .*CLAUDE\.md was kept.*not ignored/;
      const j = runFb(['--ensure-container', '--json']);
      assert.equal(j.status, 0, j.stderr);
      assert.match(JSON.parse(j.stdout).warnings[0], warned, 'the --json report carries it');
      assert.ok(readFileSync(p, 'utf-8').includes('<learned_behaviors>'), 'the append went on');
      assert.ok(!existsSync(fbKeptDir(wiki)), 'nothing went under .cache/');
      // the text mode prints it
      writeFileSync(p, original);
      const t = runFb(['--ensure-container']);
      assert.equal(t.status, 0, t.stderr);
      assert.match(t.stderr, /warn: no copy of .*CLAUDE\.md was kept.*not ignored/);
    },
    { claudeMd: original },
  );
});

test('feedback-sync-legacy-drafts-visible-to-git-are-warned-about: an old _drafts file git could stage is named with the way out, and the pointer to the new place is not printed when nothing was drafted', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  const legacyBody = '<!-- HYPO:FEEDBACK-SYNC:DRAFT origin=memory-index -->\nsensitivity: public\n';
  const seed = (wiki) => {
    const dir = join(wiki, 'pages', 'feedback', '_drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rule-b.md'), legacyBody);
    return join(dir, 'rule-b.md');
  };
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1 },
    ({ wiki, claudeHome, runFb }) => {
      fbGitInit(wiki, '.cache/\n');
      const legacy = seed(wiki);
      assert.ok(
        fbGitStaged(wiki).some((l) => l.endsWith('pages/feedback/_drafts/rule-b.md')),
        'precondition: git sees the old draft',
      );
      const r = runFb(['--bootstrap']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(
        r.stderr,
        /warn: pages\/feedback\/_drafts\/rule-b\.md was written by an earlier version.*git add -A.*Move it to \.cache\/feedback-drafts\/ or delete it/,
      );
      assert.match(r.stderr, /skipped rule-b: draft-exists-legacy \(.*_drafts\/rule-b\.md\)/);
      assert.ok(!/The drafts are in/.test(r.stderr), 'no pointer when this run drafted nothing');
      assert.equal(readFileSync(legacy, 'utf-8'), legacyBody, 'the old draft is not touched');
      const rep = JSON.parse(runFb(['--bootstrap', '--json']).stdout);
      assert.deepEqual(rep.skipped, [
        { slug: 'rule-b', reason: 'draft-exists-legacy', path: legacy },
      ]);
      assert.equal(rep.warnings.length, 1, 'the --json report carries the warning');
      // --import-target-change says it too
      fbHandEditClaude(claudeHome, runFb);
      const i = runFb(['--import-target-change', '--from=claude']);
      assert.equal(i.status, 0, i.stderr);
      assert.match(
        i.stderr,
        /warn: pages\/feedback\/_drafts\/rule-b\.md was written by an earlier version/,
      );
      // moved to the new place, git no longer sees it, and the warning goes
      mkdirSync(fbDraftsDir(wiki), { recursive: true });
      writeFileSync(join(fbDraftsDir(wiki), 'rule-b.md'), legacyBody);
      rmSync(legacy);
      const moved = runFb(['--bootstrap']);
      assert.equal(moved.status, 0, moved.stderr);
      assert.ok(!/earlier version/.test(moved.stderr), 'no warning once it is moved');
      assert.match(
        moved.stderr,
        /skipped rule-b: draft-exists\b(?!-)/,
        'and the new place is recognised',
      );
    },
    { memoryMd, claudeMd: '# Global\n<learned_behaviors>\n- manual entry\n</learned_behaviors>\n' },
  );
  // the same file where git ignores it: nothing to warn of
  withFeedbackEnv(
    {},
    ({ wiki, runFb }) => {
      fbGitInit(wiki, '.cache/\npages/feedback/_drafts/\n');
      seed(wiki);
      const r = runFb(['--bootstrap']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!/earlier version/.test(r.stderr), r.stderr);
      assert.match(r.stderr, /draft-exists-legacy/);
    },
    { memoryMd },
  );
});

test('feedback-sync-accept-says-where-the-replaced-hand-edit-lives: after import then accept the edited text is only under .cache/, and the warning names the kept copy and the import draft', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    fbGitInit(wiki, '.cache/\n');
    fbHandEditClaude(claudeHome, runFb);
    const imp = JSON.parse(runFb(['--import-target-change', '--from=claude', '--json']).stdout);
    const draft = imp.imported[0].path;
    const j = runFb(['--accept-wiki=rule-a', '--json']);
    assert.equal(j.status, 0, j.stderr);
    const rep = JSON.parse(j.stdout);
    assert.equal(rep.warnings.length, 1, 'the --json report carries the warning');
    const [w] = rep.warnings;
    assert.match(w, /now only under \.cache\/.*move what you want to keep to pages\/feedback\//i);
    assert.ok(w.includes(rep.accepted[0].kept), `the kept copy is named: ${w}`);
    assert.ok(w.includes(draft), `the import draft is named: ${w}`);
    assert.ok(
      readFileSync(rep.accepted[0].kept, 'utf-8').includes('HAND EDITED A'),
      'the named copy holds the replaced text',
    );
    // the text mode prints it on stderr; no import draft exists for this edit, so none is named
    rmSync(draft);
    fbHandEditClaude(claudeHome, runFb);
    const t = runFb(['--accept-wiki=rule-a']);
    assert.equal(t.status, 0, t.stderr);
    const line = t.stderr.split('\n').find((l) => l.includes('warn: '));
    assert.ok(line, `a warning is printed: ${t.stderr}`);
    const kept = /is kept at (\S+\.txt)/.exec(t.stderr)[1];
    assert.ok(line.includes(kept), `the new kept copy is named: ${line}`);
    assert.ok(!line.includes('feedback-drafts'), `no draft, none named: ${line}`);
    // pair: an accept that replaces nothing (the block is not in conflict) warns of nothing
    const none = runFb(['--accept-wiki=rule-a', '--json']);
    assert.equal(none.status, 1, none.stderr);
    assert.deepEqual(JSON.parse(none.stdout).warnings, [], 'nothing was replaced, nothing to say');
    assert.ok(!/only under \.cache\//.test(runFb(['--accept-wiki=rule-a']).stderr));
  });
});

test('feedback-sync-write-warns-about-old-drafts-git-can-see: --write names an old _drafts file in text and in --json, a git-ignored one and --check stay quiet', () => {
  const legacyBody = '<!-- HYPO:FEEDBACK-SYNC:DRAFT origin=memory-index -->\nsensitivity: public\n';
  const seed = (wiki) => {
    const dir = join(wiki, 'pages', 'feedback', '_drafts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rule-b.md'), legacyBody);
  };
  const earlier = /pages\/feedback\/_drafts\/rule-b\.md was written by an earlier version/;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, runFb }) => {
    fbGitInit(wiki, '.cache/\n');
    seed(wiki);
    const j = runFb(['--write', '--json']);
    assert.equal(j.status, 0, j.stderr);
    const warnings = JSON.parse(j.stdout).warnings;
    assert.equal(warnings.length, 1, j.stdout);
    assert.match(warnings[0], earlier);
    const t = runFb(['--write']);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stderr, /warn: pages\/feedback\/_drafts\/rule-b\.md was written by an earlier/);
    assert.ok(!earlier.test(runFb(['--check']).stderr), '--check does not write, so it is quiet');
  });
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, runFb }) => {
    fbGitInit(wiki, '.cache/\npages/feedback/_drafts/\n');
    seed(wiki);
    const j = runFb(['--write', '--json']);
    assert.equal(j.status, 0, j.stderr);
    assert.equal(JSON.parse(j.stdout).warnings, undefined, 'git ignores it: nothing to warn of');
    assert.ok(!earlier.test(runFb(['--write']).stderr));
  });
});

test('feedback-sync-git-that-cannot-answer-is-not-a-non-git-vault: a broken .git/config refuses the draft and the line record, a directory that is not a repository still writes them', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    ({ wiki, runFb }) => {
      fbGitInit(wiki, null); // no .gitignore at all: git would stage .cache/
      const config = join(wiki, '.git', 'config');
      const good = readFileSync(config, 'utf-8');
      writeFileSync(config, '[core\n  broken\n');
      for (const args of [['--bootstrap'], ['--bootstrap', '--dry-run']]) {
        const r = runFb(args);
        assert.equal(r.status, 1, `${args}: ${r.stderr}`);
        assert.match(
          r.stderr,
          /no draft was written: .*is not ignored by the vault's git/,
          args.join(' '),
        );
      }
      assert.ok(!existsSync(fbDraftsDir(wiki)), 'no draft');
      assert.ok(!existsSync(fbHandRecord(wiki)), 'and no hand line record');
      // the config repaired and nothing ignoring .cache/: still refused, for the real reason
      writeFileSync(config, good);
      assert.equal(runFb(['--bootstrap']).status, 1, 'git answers now, and says unignored');
      writeFileSync(join(wiki, '.gitignore'), '.cache/\n');
      assert.equal(runFb(['--bootstrap']).status, 0);
      assert.ok(existsSync(fbHandRecord(wiki)));
    },
    { memoryMd },
  );
  // pair: git answers "not a git repository", so nothing can stage the copy and it is written
  withFeedbackEnv(
    {},
    ({ wiki, runFb }) => {
      assert.ok(!existsSync(join(wiki, '.git')), 'precondition: not a repository');
      const r = runFb(['--bootstrap']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(fbDraftsDir(wiki), 'rule-b.md')));
      assert.ok(existsSync(fbHandRecord(wiki)));
    },
    { memoryMd },
  );
});

test('feedback-sync-no-draft-to-write-needs-no-ignored-cache: a git vault whose .gitignore lacks .cache/ and that has nothing to draft exits 0 with nothing created', () => {
  withFeedbackEnv({}, ({ wiki, runFb }) => {
    fbGitInit(wiki, 'node_modules/\n');
    const r = runFb(['--bootstrap', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).created, []);
    assert.ok(!existsSync(fbDraftsDir(wiki)), 'nothing was written');
  });
  // pair: the same vault with something to draft is still refused
  withFeedbackEnv(
    {},
    ({ wiki, runFb }) => {
      fbGitInit(wiki, 'node_modules/\n');
      assert.equal(runFb(['--bootstrap']).status, 1);
    },
    { memoryMd: `# Memory Index\n${FB_HAND_COLON}\n` },
  );
});

test('feedback-sync-draft-tmp-name-collision-is-an-error-not-a-taken-name: a stray tmp file with the picked name makes the run fail instead of skipping the draft', () => {
  const memoryMd = `# Memory Index\n${FB_HAND_COLON}\n`;
  withFeedbackEnv(
    {},
    (ctx) => {
      const { wiki } = ctx;
      const real = Math.random;
      Math.random = () => 0.5;
      try {
        mkdirSync(fbDraftsDir(wiki), { recursive: true });
        const tmp = `.rule-b.md.${process.pid}.${(0.5).toString(36).slice(2, 10)}.tmp`;
        writeFileSync(join(fbDraftsDir(wiki), tmp), 'stray');
        const out = fbInProcess(ctx, ['--bootstrap']);
        assert.equal(out.code, 1, 'a failed write is not reported as an existing draft');
        assert.match(out.error, /cannot write the draft .*rule-b\.md: .*EEXIST/);
        assert.deepEqual(out.report.skipped, []);
        assert.equal(
          readFileSync(join(fbDraftsDir(wiki), tmp), 'utf-8'),
          'stray',
          'the file already under that tmp name is not ours to remove',
        );
      } finally {
        Math.random = real;
      }
    },
    { memoryMd },
  );
});

test('feedback-sync-bootstrap-partial-failure-keeps-what-it-made: the error report names the drafts already created, and the text mode prints the warnings before the error', () => {
  // the second draft's name is too long for the filesystem, so its write fails after the first
  const memoryMd = `# Memory Index\n- [Aaa](feedback_aaa.md): first\n- [Long](feedback_${'b'.repeat(300)}.md): second\n`;
  withFeedbackEnv(
    {},
    ({ wiki, claudeHome, runFb }) => {
      rmSync(join(claudeHome, 'CLAUDE.md')); // a warning of its own: no CLAUDE.md to read
      const j = runFb(['--bootstrap', '--json']);
      assert.equal(j.status, 1, j.stderr);
      const body = JSON.parse(j.stdout);
      assert.match(body.error, /cannot write the draft /);
      assert.deepEqual(
        body.created.map((c) => c.slug),
        ['aaa'],
        'the draft that was made is in the report',
      );
      assert.deepEqual(body.skipped, []);
      assert.ok(
        body.warnings.some((w) => /CLAUDE\.md not found/.test(w)),
        `the run's warnings survive the error: ${JSON.stringify(body.warnings)}`,
      );
      assert.ok(existsSync(join(fbDraftsDir(wiki), 'aaa.md')), 'and on disk');
      assert.ok(existsSync(fbHandRecord(wiki)), 'its hand line is recorded');
      const t = runFb(['--bootstrap']);
      assert.equal(t.status, 1);
      const warn = t.stderr.indexOf('warn: CLAUDE.md not found');
      const err = t.stderr.indexOf('cannot write the draft');
      assert.ok(warn >= 0 && err > warn, `warnings come before the error: ${t.stderr}`);
    },
    { memoryMd },
  );
});

test('feedback-sync-ensure-container-dry-run-writes-nothing: --dry-run reports the plan and leaves CLAUDE.md and .cache/ alone', () => {
  const original = '# Global\n\nprose\n';
  withFeedbackEnv(
    {},
    ({ wiki, claudeHome, runFb }) => {
      const p = join(claudeHome, 'CLAUDE.md');
      const j = runFb(['--ensure-container', '--dry-run', '--json']);
      assert.equal(j.status, 0, j.stderr);
      assert.deepEqual(JSON.parse(j.stdout), {
        mode: 'ensure-container',
        file: p,
        action: 'would-create',
        dryRun: true,
      });
      const t = runFb(['--ensure-container', '--dry-run']);
      assert.match(
        t.stderr,
        /would append an empty <learned_behaviors>.*Nothing written \(--dry-run\)/,
      );
      assert.equal(readFileSync(p, 'utf-8'), original, 'CLAUDE.md is byte-identical');
      assert.ok(!existsSync(fbKeptDir(wiki)), 'no copy was made');
      // without --dry-run the same call does append
      assert.equal(runFb(['--ensure-container']).status, 0);
      assert.ok(readFileSync(p, 'utf-8').includes('<learned_behaviors>'));
    },
    { claudeMd: original },
  );
});

test('feedback-sync-hand-line-record-without-a-place-is-kept (top of file): a line above every heading is not matched by the empty place', () => {
  // the first line of the file has no heading above it: its recorded place is ''. A
  // record from before places were recorded has none, and must not read as ''.
  const memoryMd = `${FB_HAND_COLON}\n\n# Memory Index\n`;
  withFeedbackEnv(
    {},
    ({ wiki, memDir, runFb }) => {
      assert.equal(runFb(['--bootstrap']).status, 0);
      const rec = JSON.parse(readFileSync(fbHandRecord(wiki), 'utf-8'));
      assert.equal(rec.lines[0].section, '', 'precondition: recorded with the empty place');
      for (const l of rec.lines) delete l.section;
      writeFileSync(fbHandRecord(wiki), JSON.stringify(rec));
      fbPromoteB(wiki);
      const r = runFb(['--write']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /kept the hand-written line/);
      assert.deepEqual(fbBLines(memDir), [FB_HAND_COLON, FB_MANAGED_B]);
    },
    { memoryMd },
  );
});

test('feedback-sync-accept-refuses-two-fused-blocks: a deleted END plus a deleted START keep the counts balanced, accept still refuses', () => {
  withFeedbackEnv(
    { 'rule-a': FB_GLOBAL_L1, 'rule-c': FB_GLOBAL_C },
    ({ wiki, claudeHome, memDir, runFb }) => {
      assert.equal(runFb(['--write']).status, 0);
      const p = join(claudeHome, 'CLAUDE.md');
      const lines = readFileSync(p, 'utf-8').split('\n');
      const end = lines.findIndex((l) => l === '<!-- HYPO:FEEDBACK-SYNC:END -->');
      const start = lines.findIndex(
        (l, i) => i > end && l.startsWith('<!-- HYPO:FEEDBACK-SYNC:START'),
      );
      assert.ok(end > 0 && start > end, 'precondition: two blocks');
      const fused = lines.filter((_, i) => i !== end && i !== start).join('\n');
      writeFileSync(p, fused);
      const first = /source=(\S+)/.exec(lines[lines.findIndex((l) => l.includes('START'))])[1];

      assert.equal(runFb(['--check']).status, 3, 'precondition: the fused block is a conflict');
      const copies = readdirSync(fbKeptDir(wiki)).length;
      const r = runFb([`--accept-wiki=${first}`, '--json']);
      assert.equal(r.status, 1, 'nothing could be accepted: ' + r.stderr + r.stdout);
      const rep = JSON.parse(r.stdout);
      assert.deepEqual(rep.accepted, []);
      const refusal = rep.refused.find((x) => x.target === 'claude');
      assert.equal(refusal.unresolved, true);
      assert.match(refusal.reason, /also holds the text of/);
      assert.equal(readFileSync(p, 'utf-8'), fused, 'not replaced');
      assert.equal(readdirSync(fbKeptDir(wiki)).length, copies, 'nothing was replaced or copied');

      // another target accepted in the same command: the fused one is still blocked, exit 3
      const mem = join(memDir, 'MEMORY.md');
      writeFileSync(mem, readFileSync(mem, 'utf-8').replace('do A', 'HAND A'));
      const r2 = runFb([`--accept-wiki=${first}`, '--json']);
      assert.equal(r2.status, 3, r2.stderr + r2.stdout);
      assert.deepEqual(
        JSON.parse(r2.stdout).accepted.map((a) => a.target),
        ['memory'],
      );
      assert.equal(readFileSync(p, 'utf-8'), fused, 'the fused file is still not replaced');
    },
  );
});

test('feedback-sync-write-keeps-the-primary-file-first: a write that changes CLAUDE.md copies it as it was, and a failed copy writes nothing', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    const p = join(claudeHome, 'CLAUDE.md');
    const before = readFileSync(p, 'utf-8');
    // the copy cannot be made: exit 1, the file keeps every byte
    mkdirSync(join(wiki, '.cache'), { recursive: true });
    writeFileSync(fbKeptDir(wiki), 'a file where the copy directory should be');
    const bad = runFb(['--write']);
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stderr, /cannot keep a copy of .* before replacing it.*Nothing was written/);
    assert.equal(readFileSync(p, 'utf-8'), before);
    rmSync(fbKeptDir(wiki));

    assert.equal(runFb(['--write']).status, 0);
    const copies = readdirSync(fbKeptDir(wiki)).filter((f) =>
      f.endsWith('claude-before-write.txt'),
    );
    assert.equal(copies.length, 1, 'one copy of CLAUDE.md');
    assert.equal(readFileSync(join(fbKeptDir(wiki), copies[0]), 'utf-8'), before, 'as it was');
    // nothing changes on a clean run, so nothing is copied again
    assert.equal(runFb(['--write']).status, 0);
    assert.equal(
      readdirSync(fbKeptDir(wiki)).filter((f) => f.endsWith('claude-before-write.txt')).length,
      1,
    );
  });
});

test('feedback-sync-kept-copies-are-capped-per-label: after the 11th changing write only the newest 10 before-write copies stay', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, runFb }) => {
    const beforeWrite = () =>
      readdirSync(fbKeptDir(wiki))
        .filter((f) => f.endsWith('-claude-before-write.txt'))
        .sort();
    let oldest = null;
    for (let i = 1; i <= 11; i++) {
      writeFileSync(
        join(wiki, 'pages', 'feedback', 'rule-a.md'),
        fbPage({ ...FB_GLOBAL_L1, global_summary: `always do A, version ${i}` }),
      );
      const r = runFb(['--write']);
      assert.equal(r.status, 0, `write ${i}: ${r.stderr}`);
      if (i === 1) {
        assert.equal(beforeWrite().length, 1);
        oldest = beforeWrite()[0];
      }
    }
    const left = beforeWrite();
    assert.equal(left.length, 10, left.join(', '));
    assert.ok(!left.includes(oldest), 'the oldest copy is the one that went');
    // the cap is per label: the MEMORY.md copies are counted on their own
    assert.ok(
      readdirSync(fbKeptDir(wiki)).filter((f) => f.endsWith('-memory-before-write.txt')).length <=
        10,
    );
  });
});

test('feedback-sync-kept-copy-needs-an-ignored-cache: an ordinary write still goes ahead without its before-write copy, with a warning', () => {
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    fbGitInit(wiki, 'node_modules/\n');
    const r = runFb(['--write', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(
      readFileSync(join(claudeHome, 'CLAUDE.md'), 'utf-8').includes('always do A'),
      'the projection was written',
    );
    const rep = JSON.parse(r.stdout);
    assert.ok(
      (rep.warnings || []).some((w) => /no copy of .*CLAUDE\.md was kept.*not ignored/.test(w)),
      JSON.stringify(rep.warnings),
    );
    assert.ok(!existsSync(fbKeptDir(wiki)), 'and nothing was copied under .cache/');
    // the same run without --json says so on stderr
    writeFileSync(
      join(wiki, 'pages', 'feedback', 'rule-a.md'),
      fbPage({ ...FB_GLOBAL_L1, global_summary: 'always do A, again' }),
    );
    const r2 = runFb(['--write']);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /warn: .*no copy of .*CLAUDE\.md was kept/);
  });
});

// ── F4: a side file with no hash record keeps a copy, accept reads again, the copy cap waits
// for a successful run, PreCompact and doctor see an edited side file, --json carries the
// write-time warnings ──

const fbSideCopies = (wiki) =>
  existsSync(fbKeptDir(wiki))
    ? readdirSync(fbKeptDir(wiki)).filter((f) => f.endsWith('-side-rule-b.txt'))
    : [];

test('feedback-sync-side-file-without-a-record-is-copied-first: a rewrite or a removal keeps the bytes it replaces', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, memDir, runFb }) => {
    const page = join(wiki, 'pages', 'feedback', 'rule-b.md');
    const record = join(wiki, '.cache', 'feedback-side-files.json');
    // rewrite
    assert.equal(runFb(['--write']).status, 0);
    const edited = readFileSync(fbSideB(memDir), 'utf-8') + '\nMY OWN LINE\n';
    writeFileSync(fbSideB(memDir), edited);
    rmSync(record);
    writeFileSync(page, fbPage(fbRuleBV2));
    assert.equal(runFb(['--write']).status, 0, 'no record: trusted once, as before');
    assert.ok(readFileSync(fbSideB(memDir), 'utf-8').includes('second version'));
    const [copy] = fbSideCopies(wiki);
    assert.ok(copy, 'the bytes it replaced are kept');
    assert.equal(readFileSync(join(fbKeptDir(wiki), copy), 'utf-8'), edited);
    // a recorded file matches its record: nothing of the user's to keep
    writeFileSync(page, fbPage({ ...FB_PROJECT_L2, reason: 'because B, third version' }));
    assert.equal(runFb(['--write']).status, 0);
    assert.equal(fbSideCopies(wiki).length, 1, 'a recorded file is not copied again');
    // removal
    const edited2 = readFileSync(fbSideB(memDir), 'utf-8') + '\nANOTHER LINE\n';
    writeFileSync(fbSideB(memDir), edited2);
    rmSync(record);
    writeFileSync(page, fbPage({ ...FB_PROJECT_L2, status: 'archived' }));
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(!existsSync(fbSideB(memDir)), 'the stale copy is removed');
    const kept = fbSideCopies(wiki).map((f) => readFileSync(join(fbKeptDir(wiki), f), 'utf-8'));
    assert.ok(kept.includes(edited2), 'and its last bytes are kept');
  });
});

test('feedback-sync-side-file-without-a-record-is-copied-first: when the copy cannot be kept the file is left alone, with a warning in the JSON report', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const edited = readFileSync(fbSideB(memDir), 'utf-8') + '\nMY OWN LINE\n';
    writeFileSync(fbSideB(memDir), edited);
    rmSync(join(wiki, '.cache', 'feedback-side-files.json'));
    writeFileSync(join(wiki, 'pages', 'feedback', 'rule-b.md'), fbPage(fbRuleBV2));
    fbGitInit(wiki, 'node_modules/\n'); // git would stage .cache/: no copy may go there
    const r = runFb(['--write', '--json']);
    assert.equal(r.status, 0, 'the primary write is not held up: ' + r.stderr + r.stdout);
    assert.equal(readFileSync(fbSideB(memDir), 'utf-8'), edited, 'the side file keeps every byte');
    assert.equal(fbSideCopies(wiki).length, 0, 'no copy of the side file went under .cache/');
    assert.ok(
      (JSON.parse(r.stdout).warnings || []).some((w) =>
        /left .*feedback_rule-b\.md as it is.*no copy of it could be kept/.test(w),
      ),
      r.stdout,
    );
    // the way out: git ignores .cache/, so the copy is made and the file rewritten
    writeFileSync(join(wiki, '.gitignore'), '.cache/\n');
    assert.equal(runFb(['--write']).status, 0);
    assert.ok(readFileSync(fbSideB(memDir), 'utf-8').includes('second version'));
    assert.equal(fbSideCopies(wiki).length, 1);
  });
});

test('feedback-sync-accept-reads-the-file-again: a target saved after preflight is neither copied nor replaced', () => {
  withFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ wiki, claudeHome, memDir, runFb }) => {
    assert.equal(runFb(['--write']).status, 0);
    const mem = join(memDir, 'MEMORY.md');
    writeFileSync(mem, readFileSync(mem, 'utf-8').replace('do B', 'HAND B'));
    const target = memoryTarget({ claudeHome }, 'proj');
    const evals = [{ target, res: evaluateTarget(loadFeedbackPages(wiki), target, [], {}) }];
    assert.equal(evals[0].res.conflicts.length, 1, 'precondition: a conflicting block');
    // an editor saves between the preflight and the accept
    const saved = readFileSync(mem, 'utf-8') + '- a line saved a moment ago\n';
    writeFileSync(mem, saved);
    const out = runAccept({ acceptSlug: 'rule-b', dryRun: false, hypoDir: wiki }, evals);
    assert.equal(out.code, 1);
    assert.match(out.error, /MEMORY\.md changed after it was read for this accept.*not replaced/);
    assert.equal(readFileSync(mem, 'utf-8'), saved, 'the saved bytes are still there');
    assert.ok(
      !existsSync(fbKeptDir(wiki)) || !readdirSync(fbKeptDir(wiki)).some((f) => /accept/.test(f)),
      'no copy of the stale bytes was made as if they were the file',
    );
    // run from the start it still accepts: the guard is about the read, not about the edit
    const ok = runFb(['--accept-wiki=rule-b']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(readFileSync(mem, 'utf-8').includes('do B'));
  });
});

test('feedback-sync-kept-copies-are-pruned-after-a-successful-run: a run that fails keeps the older copies, the next good run caps them at 10', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return;
  withFeedbackEnv({ 'rule-a': FB_GLOBAL_L1 }, ({ wiki, claudeHome, runFb }) => {
    const setSummary = (i) =>
      writeFileSync(
        join(wiki, 'pages', 'feedback', 'rule-a.md'),
        fbPage({ ...FB_GLOBAL_L1, global_summary: `always do A, version ${i}` }),
      );
    const beforeWrite = () =>
      readdirSync(fbKeptDir(wiki))
        .filter((f) => f.endsWith('-claude-before-write.txt'))
        .sort();
    for (let i = 1; i <= 10; i++) {
      setSummary(i);
      assert.equal(runFb(['--write']).status, 0, `write ${i}`);
    }
    const oldest = beforeWrite()[0];
    assert.equal(beforeWrite().length, 10);
    // the 11th write copies CLAUDE.md, then cannot replace it
    setSummary(11);
    chmodSync(claudeHome, 0o500);
    try {
      const bad = runFb(['--write']);
      assert.equal(bad.status, 1, bad.stderr);
      assert.equal(beforeWrite().length, 11, 'the failed run added its copy and removed none');
      assert.ok(beforeWrite().includes(oldest), 'the oldest copy is still there');
    } finally {
      chmodSync(claudeHome, 0o755); // so the cleanup can remove the tree
    }
    assert.equal(runFb(['--write']).status, 0);
    assert.equal(beforeWrite().length, 10, beforeWrite().join(', '));
    assert.ok(!beforeWrite().includes(oldest), 'the good run is the one that prunes');
  });
});

// PreCompact and doctor: an edited generated side file is exit 3 from feedback-sync, and
// neither consumer may call that state healthy.
const fbEditedSide = (memDir, runFb) => {
  assert.equal(runFb(['--write']).status, 0);
  const side = fbSideB(memDir);
  writeFileSync(side, readFileSync(side, 'utf-8') + '\nMY OWN NOTES ON RULE B\n');
  assert.equal(runFb(['--check']).status, 3, 'precondition: only the side file is edited');
  return side;
};

test('doctor-edited-side-file-is-an-integrity-failure: exit-3 sideEdited is neither "in sync" nor a bare warning, and it names the remedy', () => {
  withDoctorFeedbackEnv({ 'rule-b': FB_PROJECT_L2 }, ({ memDir, runFb, runDoctor }) => {
    const side = fbEditedSide(memDir, runFb);
    const { fb } = runDoctor();
    const hit = fb.find((c) => c.label === 'Feedback projection integrity');
    assert.ok(hit && hit.status === 'fail', JSON.stringify(fb));
    assert.ok(hit.detail.includes(side), hit.detail);
    assert.match(hit.detail, /Copy your edits out of .*feedback_rule-b\.md/);
    assert.ok(!fb.some((c) => c.status === 'pass'), 'nothing reads it as in sync');
  });
});

// A home with a pkg pointer, a project memory dir and one project-scoped page, run through
// the PreCompact hook. `setup` may add to the wiki; `check` gets the wiki dir.
function withPrecompactFeedbackHome(page, setup, check) {
  const home = mkdtempSync(join(tmpdir(), 'hypo-fbhook-f4-'));
  try {
    const id = process.cwd().replace(/[/.]/g, '-');
    const claudeHome = join(home, '.claude');
    const memDir = join(claudeHome, 'projects', id, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(claudeHome, 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
    writeFileSync(
      join(claudeHome, 'CLAUDE.md'),
      '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
    );
    writeFileSync(join(memDir, 'MEMORY.md'), '# Memory Index\n');
    withWiki(
      (dir) => {
        mkdirSync(join(dir, 'pages', 'feedback'), { recursive: true });
        writeFileSync(
          join(dir, 'pages', 'feedback', 'rule.md'),
          fbPage({ ...page, scope: page.scope === 'global' ? 'global' : `project:${id}` }),
        );
        setup?.(dir);
      },
      (dir) => check({ dir, home, id, claudeHome, memDir }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('precompact-edited-side-file-is-reported: the gate names the side file and the remedy instead of passing quietly', () => {
  withPrecompactFeedbackHome(FB_PROJECT_L2, null, ({ dir, home, id, claudeHome, memDir }) => {
    const fbArgs = [`--hypo-dir=${dir}`, `--claude-home=${claudeHome}`, `--project-id=${id}`];
    assert.equal(run('feedback-sync.mjs', ['--write', ...fbArgs]).status, 0);
    const side = join(memDir, 'feedback_rule.md');
    writeFileSync(side, readFileSync(side, 'utf-8') + '\nMY OWN NOTES\n');
    assert.equal(run('feedback-sync.mjs', ['--check', ...fbArgs]).status, 3, 'precondition');
    const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
    const msg = JSON.parse(r.stdout).systemMessage || '';
    assert.match(msg, /feedback projection conflict/, r.stdout);
    assert.ok(msg.includes(side), `names the side file: ${msg}`);
    assert.match(msg, /Copy your edits out of/, 'and the way out');
  });
});

test('precompact-self-heal-shows-write-time-warnings: the --write --json warnings reach the notice', () => {
  withPrecompactFeedbackHome(
    FB_GLOBAL_L1,
    // the vault's git does not ignore .cache/: the routine before-write copy is skipped
    (dir) => writeFileSync(join(dir, '.gitignore'), 'node_modules/\n'),
    ({ dir, home }) => {
      const r = runHook('hypo-personal-check.mjs', '', { HYPO_DIR: dir, HOME: home });
      const msg = JSON.parse(r.stdout).systemMessage || '';
      assert.match(msg, /re-synced/, `precondition: self-healed: ${r.stdout}`);
      assert.match(
        msg,
        /feedback-sync warning while re-syncing: .*no copy of .*CLAUDE\.md was kept/,
        msg,
      );
    },
  );
});
