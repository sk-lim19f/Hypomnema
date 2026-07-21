// tests/close-global.test.mjs
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
  appendFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
// crystallize.mjs guards its CLI dispatch behind isMain(), so importing these
// pure close-pipeline functions does not run the CLI.
import { planMarkerDecision, closeResultContradiction } from '../scripts/crystallize.mjs';
import { test, suite } from './harness.mjs';
import {
  CLOSE_RECONFIRM_MARK,
  FB_GLOBAL_L1,
  HOME,
  HOOKS,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  askCloseReconfirmToolUse,
  buildCleanWikiTree,
  closeFileTargetsForProject,
  closeFileTargetsGlobal,
  deriveRootLogEntries,
  fbPage,
  gitHead,
  makeMultiProjectWiki,
  markerPath,
  partitionLintScope,
  precompactGateStatus,
  run,
  runStop,
  runWithHome,
  seedCloseTranscript,
  sessionCloseGlobalStatus,
  todayLocal,
  withCleanWiki,
  withGrowthWiki,
  withSyncedWiki,
  withTmpDir,
  withWiki,
  writeSessionClosedMarker,
} from './helpers.mjs';

// ── sessionCloseGlobalStatus — global close invariant (ADR 0043) ──────────────
suite('sessionCloseGlobalStatus — global close invariant (ADR 0043)');

test('no-payload incident form: fully-closed B passes even though stale A is the top hot.md row', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // A is the recency/top row but has NO today activity (last touched long ago).
    // B is fully closed today. Legacy recency pick would resolve A and false-block.
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: '2020-01-01' }, // top row, all stale, zero today activity
      { slug: 'beta', date: today }, // fully closed today
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(
      s.ok,
      true,
      `beta is fully closed; alpha has no today activity → ok. got ${JSON.stringify(s)}`,
    );
    assert.deepEqual(
      s.projects.map((p) => p.project),
      ['beta'],
      'only beta is today-active',
    );
  });
});

test('masking guard: a DIFFERENT project with a partial close still blocks (no single-pick mask)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha fully closed; beta has a today log.md entry (activity) but stale own files.
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      {
        slug: 'beta',
        date: today,
        sessionState: '2020-01-01',
        projectHot: '2020-01-01',
        sessionLog: false,
      },
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, false, 'beta has a dangling close → block');
    const beta = s.projects.find((p) => p.project === 'beta');
    assert.ok(beta && !beta.ok, 'beta reported incomplete');
    assert.ok(
      s.stale.some((f) => f.includes('projects/beta/')),
      `block names beta's stale files: ${JSON.stringify(s.stale)}`,
    );
  });
});

test('from-zero fallback: no project has today activity → legacy force-close of the recency project blocks', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: '2020-01-01', hotRow: '2020-01-01' },
      { slug: 'beta', date: '2020-01-01', hotRow: '2020-01-01' },
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.fallback, true, 'no today activity → fallback path');
    assert.equal(s.ok, false, 'recency project is stale → still blocks (force initial close)');
    assert.ok(s.primary, 'a recency primary is resolved');
  });
});

test('multi today-active: both complete → ok; one partial → block only the partial one', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      { slug: 'beta', date: today },
    ]);
    assert.equal(sessionCloseGlobalStatus(dir).ok, true, 'both complete → ok');

    // now break beta's session-state
    writeFileSync(
      join(dir, 'projects', 'beta', 'session-state.md'),
      `---\ntitle: ss\ntype: session-state\nupdated: 2020-01-01\n---\n\n## next\n`,
    );
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, false, 'beta now incomplete → block');
    assert.ok(s.projects.find((p) => p.project === 'alpha').ok, 'alpha still ok');
    assert.ok(!s.projects.find((p) => p.project === 'beta').ok, 'beta blocked');
    assert.ok(
      s.stale.some((f) => f === 'projects/beta/session-state.md'),
      'names beta session-state',
    );
    assert.ok(!s.stale.some((f) => f.startsWith('projects/alpha/')), 'does not flag alpha files');
  });
});

test('back-compat: single today-active project → flat aliases byte-identical (unprefixed paths)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'solo', date: today, logEntry: '2020-01-01' }]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, false, 'solo log.md entry stale → block');
    assert.equal(s.project, 'solo', 'flat .project alias = the single project');
    assert.ok(
      s.missing.concat(s.stale).includes('log.md'),
      'log.md flagged unprefixed (root file)',
    );
  });
});

test('project-dir-only candidate is gated (readdirSync leg) — guards the swallowed-import false-pass', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha is fully closed and visible via root hot.md row + log.md entry.
    // gamma's only authoritative today signal is its own session-log heading
    // (ADR 0057); it is absent from both the root hot.md rows and log.md, so ONLY
    // the project-dirs leg (readdirSync over projects/* for session-state.md) can
    // surface it as a candidate. If that leg silently drops (e.g. an unimported
    // readdirSync swallowed by the try/catch), gamma's dangling close is missed
    // and the gate false-passes. (session-state exists but is stale — it is the
    // discovery handle, not the activity signal.)
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      {
        slug: 'gamma',
        date: today,
        hotRow: false,
        logEntry: false,
        sessionState: '2020-01-01',
        projectHot: '2020-01-01',
      },
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.ok(
      s.projects.some((p) => p.project === 'gamma'),
      `gamma must be found via the project-dirs leg: ${JSON.stringify(s.projects.map((p) => p.project))}`,
    );
    assert.equal(s.ok, false, 'gamma has a dangling close → block (must not false-pass)');
  });
});

test('ADR 0057: bookkeeping-only freshness is NOT today close-activity (session-state bump must not cross-block)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha: a real, fully-closed session today. beta: ONLY soft state is fresh —
    // session-state.md bumped today by tracker bookkeeping; no session-log heading,
    // no log.md `session | beta` entry, stale hot.md + root row. beta must NOT be
    // today-active, so alpha's completed close passes instead of cross-blocking.
    // (Before ADR 0057 this asserted false — session-state freshness false-blocked.)
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      {
        slug: 'beta',
        date: today,
        projectHot: '2020-01-01',
        hotRow: '2020-01-01',
        sessionLog: false,
        logEntry: false,
        // sessionState defaults to today — the bookkeeping bump
      },
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, true, `beta is bookkeeping-only → not today-active: ${JSON.stringify(s)}`);
    assert.deepEqual(
      s.projects.map((p) => p.project),
      ['alpha'],
      'only alpha is today-active; beta (session-state-only) excluded',
    );
  });
});

test('ADR 0057: project-create artifacts are NOT today close-activity (soft state + non-session log entry)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // newproj looks fresh the way project-create leaves a project — today hot.md +
    // today root row + a `## [today] project-create | newproj` log entry (NOT a
    // `session | …` close entry) + no session-log heading. None is authoritative.
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      {
        slug: 'newproj',
        date: today,
        sessionLog: false,
        logEntry: false,
        // session-state + project hot + root row default to today (project-create stamps)
      },
    ]);
    const logPath = join(dir, 'log.md');
    writeFileSync(
      logPath,
      readFileSync(logPath, 'utf-8') + `## [${today}] project-create | newproj\n`,
    );
    const s = sessionCloseGlobalStatus(dir);
    assert.deepEqual(
      s.projects.map((p) => p.project),
      ['alpha'],
      'project-create (non-session log entry) must not make newproj today-active',
    );
    assert.equal(s.ok, true);
  });
});

test('ADR 0057 no-regress: a real incomplete close still blocks (session-log heading present, log.md gap)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // beta had a genuine session (today session-log heading) but the root log.md
    // entry is missing and session-state is stale. Still today-active via the
    // session-log heading → still blocks. Dropping the soft-state signals (ISSUE-14
    // family) must not lose this.
    makeMultiProjectWiki(dir, today, [
      {
        slug: 'beta',
        date: today,
        sessionState: '2020-01-01',
        projectHot: '2020-01-01',
        hotRow: '2020-01-01',
        logEntry: false,
      },
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(
      s.ok,
      false,
      'real incomplete close (session-log present, log.md gap) must still block',
    );
    assert.ok(
      s.projects.some((p) => p.project === 'beta' && !p.ok),
      'beta detected as today-active via its session-log heading despite stale soft state',
    );
  });
});

test('closeFileTargetsGlobal: union over today-active projects, all freshDate months', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      { slug: 'beta', date: today },
    ]);
    const t = closeFileTargetsGlobal(dir);
    assert.ok(t.has('hot.md') && t.has('log.md'), 'root files always in scope');
    for (const p of ['alpha', 'beta']) {
      assert.ok(t.has(`projects/${p}/session-state.md`), `${p} session-state in scope`);
      assert.ok(t.has(`projects/${p}/hot.md`), `${p} hot in scope`);
      assert.ok(
        [...t].some((f) => new RegExp(`^projects/${p}/session-log/`).test(f)),
        `${p} session-log in scope`,
      );
    }
  });
});

test('regression (ADR 0050): the legacy monthly file that PROVES freshness is in lint scope (no false-pass)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    const ym = today.slice(0, 7);
    // alpha's freshness evidence is the legacy monthly file; there is NO daily
    // shard. If the scope only ever named the daily shard, a corrupt monthly
    // evidence file would pass the gate with its lint error demoted to a notice.
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today }]);
    const scope = closeFileTargetsGlobal(dir);
    assert.ok(
      scope.has(`projects/alpha/session-log/${ym}.md`),
      `the monthly evidence file must be in scope, got: ${JSON.stringify([...scope])}`,
    );
    // A lint error in that evidence file must therefore be classified blocking.
    const { blocking } = partitionLintScope(
      [
        {
          file: `projects/alpha/session-log/${ym}.md`,
          message: 'Malformed frontmatter (unclosed ---)',
          severity: 'error',
        },
      ],
      scope,
    );
    assert.equal(
      blocking.length,
      1,
      'an error in the file the gate trusts as freshness proof must block, not be a notice',
    );
  });
});

test('regression (ADR 0050): once a daily shard carries today, IT (not the monthly) is the scoped evidence', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    const ym = today.slice(0, 7);
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today }]);
    // Add a daily shard that carries today's heading → it becomes the evidence.
    writeFileSync(
      join(dir, 'projects', 'alpha', 'session-log', `${today}.md`),
      `---\ntitle: Session Log ${today} (alpha)\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] session\n`,
    );
    const scope = closeFileTargetsGlobal(dir);
    assert.ok(scope.has(`projects/alpha/session-log/${today}.md`), 'daily shard is the evidence');
    assert.ok(
      !scope.has(`projects/alpha/session-log/${ym}.md`),
      'the monthly file is no longer the evidence, so it is out of scope (its stale debt does not block)',
    );
  });
});

// ── B-3 T2: --project=<slug> override (close-gate-hardening) ──────────────────
suite('--project=<slug> override (B-3 T2: scoped check + global-gate mark attribution)');

// projectOverride narrows the close status to ONE project, bypassing recency /
// today-active discovery. Key invariant: a scoped-green status must NOT imply
// global compact-readiness (the contract caveat behind the redesign).
test('sessionCloseGlobalStatus(projectOverride): scoped-green while global is red', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha fully closed today; beta today-active but with a dangling session-state.
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      { slug: 'beta', date: today, sessionState: '2020-01-01' },
    ]);
    assert.equal(sessionCloseGlobalStatus(dir).ok, false, 'global blocks on beta');
    const a = sessionCloseGlobalStatus(dir, { projectOverride: 'alpha' });
    assert.equal(a.ok, true, 'scoped to alpha → green even though beta is dangling');
    assert.deepEqual(
      a.projects.map((p) => p.project),
      ['alpha'],
      'only alpha reported',
    );
    assert.equal(a.project, 'alpha');
    assert.equal(a.fallback, false);
    assert.equal(
      sessionCloseGlobalStatus(dir, { projectOverride: 'beta' }).ok,
      false,
      'scoped to beta → red (its own files are stale)',
    );
  });
});

test('sessionCloseGlobalStatus(projectOverride): overrides the recency pick, not just the top hot row', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha is the recency/top row but stale + no today activity; beta is closed.
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: '2020-01-01' },
      { slug: 'beta', date: today },
    ]);
    const s = sessionCloseGlobalStatus(dir, { projectOverride: 'alpha' });
    assert.equal(s.project, 'alpha', 'override picks alpha regardless of activity');
    assert.equal(s.ok, false, 'alpha is stale → red');
  });
});

test('closeFileTargetsForProject: root baseline + that project only', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      { slug: 'beta', date: today },
    ]);
    const t = closeFileTargetsForProject(dir, 'alpha');
    assert.ok(t.has('hot.md') && t.has('log.md'), 'root files in scope');
    assert.ok(
      t.has('projects/alpha/session-state.md') && t.has('projects/alpha/hot.md'),
      'alpha files in scope',
    );
    assert.ok(
      [...t].some((f) => /^projects\/alpha\/session-log\//.test(f)),
      'alpha session-log in scope',
    );
    assert.ok(![...t].some((f) => f.includes('projects/beta/')), 'beta files NOT in scope');
  });
});

// codex design finding 1 regression: the closeFileTargetsGlobal refactor MUST keep
// the recency fallback when no project closed today. Dropping it to a root-only
// scope would make lint narrower than the close status — a false-pass reopener.
test('closeFileTargetsGlobal: no today-active project → recency-fallback files still in scope (not root-only)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // nobody closed today (all old dates); alpha is the recency project.
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: '2020-01-01', hotRow: '2020-01-01' }]);
    const scope = closeFileTargetsGlobal(dir);
    assert.ok(scope.has('hot.md') && scope.has('log.md'), 'root baseline present');
    assert.ok(
      scope.has('projects/alpha/session-state.md') && scope.has('projects/alpha/hot.md'),
      `recency fallback must keep alpha's files in scope, got ${JSON.stringify([...scope])}`,
    );
  });
});

suite('crystallize.mjs --project= override (B-3 T2 CLI)');

test('--check-session-close --project=<traversal> → exit 1 (syntax rejected in parseArgs)', () => {
  withTmpDir((dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--project=../etc',
      '--json',
    ]);
    assert.equal(r.status, 1, r.stdout);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.match(out.error, /not a valid project name/);
  });
});

test('--check-session-close --project=<absent> → exit 1 (does not exist as a directory)', () => {
  withTmpDir((dir) => {
    mkdirSync(join(dir, 'projects'), { recursive: true }); // valid syntax, no ghost dir
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--project=ghost',
      '--json',
    ]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(JSON.parse(r.stdout).error, /does not exist as a directory/);
  });
});

test('--check-session-close --project=<real>: JSON carries scope:project + scoped_project', () => {
  withCleanWiki((dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--project=test-project',
      '--json',
    ]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scope, 'project', `scope must be project: ${r.stdout}`);
    assert.equal(out.scoped_project, 'test-project');
    assert.equal(out.ok, true, 'test-project is fully closed → scoped green');
  });
});

test('--check-session-close (no --project): JSON scope is global, no scoped_project', () => {
  withCleanWiki((dir) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--check-session-close', '--json']);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scope, 'global');
    assert.ok(!('scoped_project' in out), 'no scoped_project on the global path');
  });
});

test('--mark-session-closed --project=<absent> → exit 1 before the gate (existence check)', () => {
  withCleanWiki((dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-ghost',
      '--project=ghost',
      '--json',
    ]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(JSON.parse(r.stdout).error, /does not exist as a directory/);
  });
});

test('--mark-session-closed --project=<real>: global gate passes + marker attributed to the slug', () => {
  withCleanWiki((dir) => {
    const cleanup = seedCloseTranscript('s-attr');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-attr',
      '--project=test-project',
      '--json',
    ]);
    cleanup();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.project, 'test-project', 'result attributed to --project slug');
    const marker = JSON.parse(
      readFileSync(join(dir, '.cache', 'session-closed-s-attr.marker'), 'utf-8'),
    );
    assert.equal(marker.project, 'test-project', 'marker carries the attribution slug');
  });
});

// log-only marker governs the session → log-only mode wins and --project is
// IGNORED (no project is checked). The JSON must say so, not imply X was checked.
test('--check-session-close --project=<X> with a log-only marker → scope:log-only, override ignored', () => {
  withCleanWiki((dir) => {
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      join(dir, '.cache', 'session-closed-s-logonly.marker'),
      JSON.stringify({
        session_id: 's-logonly',
        project: null,
        scope: 'log-only',
        transcript_path: null,
        closed_at: new Date().toISOString(),
        verification: 'log-only-close:ok',
      }) + '\n',
    );
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--project=test-project',
      '--session-id=s-logonly',
      '--json',
    ]);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scope, 'log-only', `log-only marker must win: ${r.stdout}`);
    assert.equal(out.scoped_project, 'test-project');
    assert.equal(out.project_override_ignored, true);
  });
});

test('regression: the close path never passes cwd into resolveActiveProject (resume=cwd / close=no-pick split)', () => {
  // ADR 0043: close callers must not import a cwd-aware project pick. Guard the
  // source so a future "re-sync" with resume.mjs cannot reintroduce cwd masking.
  const shared = readFileSync(join(HOOKS, 'hypo-shared.mjs'), 'utf-8');
  // Every CALL to resolveActiveProject in hypo-shared.mjs (the close-side module)
  // must be single-arg. The 2-arg form lives only in the function DEFINITION
  // (for resume.mjs, a separate file) — exclude that line, then assert no call
  // passes a 2nd (cwd) argument.
  const cwdCalls = shared
    .split('\n')
    .filter((l) => !/function resolveActiveProject/.test(l))
    .filter((l) => /resolveActiveProject\([^)]*,/.test(l));
  assert.equal(
    cwdCalls.length,
    0,
    `close-side resolveActiveProject calls must be single-arg (no cwd); found: ${JSON.stringify(cwdCalls)}`,
  );
});

// ── deriveRootLogEntries — auto-derive root log.md session entry ──────────────
suite('deriveRootLogEntries — root log.md derivable auto-fill');

test('derives the canonical log.md entry when only log.md is the gap', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha: fully closed today except the root log.md entry is missing.
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    assert.equal(sessionCloseGlobalStatus(dir).ok, false, 'precondition: gate blocks on log.md');
    const n = deriveRootLogEntries(dir);
    assert.equal(n, 1, 'one entry derived');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(log, new RegExp(`^## \\[${today}\\] session \\| alpha`, 'm'));
    assert.equal(sessionCloseGlobalStatus(dir).ok, true, 'gate now passes after derive');
  });
});

test('regression (ADR 0050): derive recovers from the legacy monthly when the daily shard is header-only', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha's real today heading lives in the legacy monthly; a daily shard
    // exists but is HEADER-ONLY (a seeded-but-interrupted write). log.md is the
    // only gap. Derive must skip the header-only shard and read the monthly —
    // matching freshness, which also accepts the monthly via fallback. Stopping
    // at the first *existing* candidate would silently fail to recover log.md.
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    writeFileSync(
      join(dir, 'projects', 'alpha', 'session-log', `${today}.md`),
      `---\ntitle: Session Log ${today} (alpha)\ntype: session-log\nupdated: ${today}\n---\n\n# Session Log ${today} (alpha)\n`,
    );
    const n = deriveRootLogEntries(dir);
    assert.equal(
      n,
      1,
      'derive must recover the entry from the legacy monthly, not stop at the header-only shard',
    );
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(log, new RegExp(`^## \\[${today}\\] session \\| alpha`, 'm'));
  });
});

test('is idempotent — a second run appends nothing', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    assert.equal(deriveRootLogEntries(dir), 1);
    assert.equal(deriveRootLogEntries(dir), 0, 'no duplicate on re-run');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.equal((log.match(/session \| alpha/g) || []).length, 1, 'exactly one alpha entry');
  });
});

test('guard: does NOT derive when the authored close is otherwise incomplete', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // beta is today-active (fresh session-log heading) but session-state is stale
    // AND log.md missing → incomplete authored close, must keep blocking.
    makeMultiProjectWiki(dir, today, [
      { slug: 'beta', date: today, sessionState: '2020-01-01', logEntry: false },
    ]);
    assert.equal(deriveRootLogEntries(dir), 0, 'log.md not masked while session-state stale');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.doesNotMatch(log, /session \| beta/, 'no beta entry derived');
    assert.equal(sessionCloseGlobalStatus(dir).ok, false, 'gate still blocks the real gap');
  });
});

test('guard: does NOT derive when the session-log heading is the gap (T5 AC)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha is a today close candidate via its log.md entry, but its session-log
    // carries NO today heading (stale). log.md is therefore not the SOLE gap, and
    // there is no today heading to derive a line from — derive must return 0.
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, sessionLog: false }]);
    assert.equal(
      deriveRootLogEntries(dir),
      0,
      'no derive while the session-log heading is missing (guard unmet)',
    );
    assert.equal(
      sessionCloseGlobalStatus(dir).ok,
      false,
      'gate still blocks the stale session-log',
    );
  });
});

// ── B-1: closeCandidateSlugs disk-gates log.md slugs (ghost-slug fix) ──────────
suite('B-1: closeCandidateSlugs disk-gates log.md slugs');
test('B-1: a log.md slug with no projects/<slug>/ dir is not a close candidate', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha is fully closed today; on its own the gate passes.
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today }]);
    assert.equal(sessionCloseGlobalStatus(dir).ok, true, 'precondition: alpha alone is complete');
    // A ghost entry (`hypomnema:` has no projects/ directory). Before the disk
    // gate, closeCandidateSlugs unioned it in and sessionCloseFileStatus reported
    // it all-missing → the gate false-blocked a finished session.
    const logPath = join(dir, 'log.md');
    writeFileSync(logPath, readFileSync(logPath, 'utf-8') + `## [${today}] session | hypomnema:\n`);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, true, 'ghost slug must not be treated as a dangling close');
    assert.ok(
      !s.projects.some((p) => p.project === 'hypomnema:'),
      'ghost slug must not appear in the close-candidate set',
    );
  });
});

test('B-1: a log.md slug that exists as a FILE (not a directory) is excluded', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today }]);
    // projects/notdir is a regular file, not a project directory.
    writeFileSync(join(dir, 'projects', 'notdir'), 'x');
    const logPath = join(dir, 'log.md');
    writeFileSync(logPath, readFileSync(logPath, 'utf-8') + `## [${today}] session | notdir\n`);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, true, 'a file (not directory) slug must not gate a close');
    assert.ok(
      !s.projects.some((p) => p.project === 'notdir'),
      'file slug excluded from candidates',
    );
  });
});

test('B-1: a real project dir keeps its log.md slug as a close candidate (disk gate keeps reals)', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    // alpha fully closed; beta has a today log.md entry + real dir but is
    // INCOMPLETE (no session-state). The disk gate must still include beta so
    // the gate keeps blocking — the fix excludes ghosts, not real directories.
    makeMultiProjectWiki(dir, today, [
      { slug: 'alpha', date: today },
      { slug: 'beta', date: today, sessionState: false },
    ]);
    const s = sessionCloseGlobalStatus(dir);
    assert.equal(s.ok, false, 'beta is an incomplete real close → gate blocks');
    assert.ok(
      s.projects.some((p) => p.project === 'beta'),
      'real-dir slug stays a candidate',
    );
  });
});

test('normalises a non-"session | slug" heading into the canonical entry', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    // Overwrite the session-log with a titled, non-canonical heading shape.
    writeFileSync(
      join(dir, 'projects', 'alpha', 'session-log', `${today.slice(0, 7)}.md`),
      `---\ntitle: log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] Refactor the parser\n`,
    );
    assert.equal(deriveRootLogEntries(dir), 1);
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(
      log,
      new RegExp(`^## \\[${today}\\] session \\| alpha — Refactor the parser`, 'm'),
    );
  });
});

test('derives one entry per same-day session-log heading', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    writeFileSync(
      join(dir, 'projects', 'alpha', 'session-log', `${today.slice(0, 7)}.md`),
      `---\ntitle: log\ntype: session-log\nupdated: ${today}\n---\n\n` +
        `## [${today}] session | alpha — first\n\n## [${today}] session | alpha — second\n`,
    );
    assert.equal(deriveRootLogEntries(dir), 2, 'both same-day sessions derived');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(log, /session \| alpha — first/);
    assert.match(log, /session \| alpha — second/);
  });
});

test('does not leak a renamed-project old slug into the derived title', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'newslug', date: today, logEntry: false }]);
    writeFileSync(
      join(dir, 'projects', 'newslug', 'session-log', `${today.slice(0, 7)}.md`),
      `---\ntitle: log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] session | oldslug — Migrate\n`,
    );
    assert.equal(deriveRootLogEntries(dir), 1);
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(log, new RegExp(`^## \\[${today}\\] session \\| newslug — Migrate$`, 'm'));
    assert.doesNotMatch(log, /oldslug/, 'old slug must not appear in the derived entry');
  });
});

test('exact-line dedup keeps a titleless heading distinct from a titled one', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    // A titleless and a titled same-day heading: a substring dedup would drop the
    // titleless one (it is a prefix of the titled one); exact-line keeps both.
    writeFileSync(
      join(dir, 'projects', 'alpha', 'session-log', `${today.slice(0, 7)}.md`),
      `---\ntitle: log\ntype: session-log\nupdated: ${today}\n---\n\n` +
        `## [${today}] session | alpha — first\n\n## [${today}] session | alpha\n`,
    );
    assert.equal(deriveRootLogEntries(dir), 2, 'both the titled and titleless entries derived');
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(log, new RegExp(`^## \\[${today}\\] session \\| alpha — first$`, 'm'));
    assert.match(log, new RegExp(`^## \\[${today}\\] session \\| alpha$`, 'm'));
  });
});

test('hypo-hot-rebuild Stop hook fills the missing log.md entry end-to-end', () => {
  withTmpDir((dir) => {
    const today = todayLocal();
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    makeMultiProjectWiki(dir, today, [{ slug: 'alpha', date: today, logEntry: false }]);
    const r = runStop('hypo-hot-rebuild.mjs', dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const log = readFileSync(join(dir, 'log.md'), 'utf-8');
    assert.match(log, new RegExp(`^## \\[${today}\\] session \\| alpha`, 'm'));
    assert.equal(sessionCloseGlobalStatus(dir).ok, true, 'gate passes after the Stop hook ran');
  });
});

// ── hypo-auto-minimal-crystallize.mjs (ADR 0022 Layer 3) ─────
// @fix #27: replay-auto-minimal-crystallize-on-incomplete-close: mutating + no marker + close-intent → block
// @fix #27: replay-auto-minimal-crystallize-on-incomplete-close: valid marker → continue (even with close-intent)

suite('hypo-auto-minimal-crystallize.mjs — Stop chain replay');

function runAutoMinimal(dir, payload) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-minimal-crystallize.mjs')], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir },
  });
}

function writeTranscript(dir, lines) {
  const path = join(dir, '.cache', `transcript-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

function writeSessionClosedMarkerFile(dir, sessionId, closedAt) {
  const path = join(dir, '.cache', `session-closed-${sessionId}.marker`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      session_id: sessionId,
      project: 'demo',
      closed_at: closedAt || new Date().toISOString(),
      verification: 'session-close-file-status:ok',
    }) + '\n',
  );
  return path;
}

test('replay-auto-minimal-crystallize-on-incomplete-close: hi-only transcript → continue', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', content: 'hi' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-trivial',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'no mutating tool_use → must continue');
    assert.equal(out.decision, undefined, 'must not block on trivial session');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: mutating + no marker + close-intent → block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', content: 'edit foo' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      // close-intent gate (2nd amendment): without an explicit wrap-up signal
      // the hook would silently continue. This user message trips isClosePattern.
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-substantial',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `must block, got: ${JSON.stringify(out)}`);
    assert.ok(
      /WIKI_AUTOCLOSE/.test(out.reason),
      `reason must mention WIKI_AUTOCLOSE: ${out.reason}`,
    );
    // ADR 0047: the recovery command is now `crystallize --mark-session-closed`
    // (gate-green / blockers branches) or `/hypo:crystallize` (generic fallback
    // when the read-only gate is unavailable). All paths name a crystallize
    // recovery action.
    assert.ok(
      /crystallize/.test(out.reason),
      `reason must point at a crystallize recovery command: ${out.reason}`,
    );
    assert.ok(out.reason.includes('s-substantial'), 'reason must embed the session_id to use');
  });
});

// 2nd amendment (close-intent gate): the core UX-regression fix from the
// codex 2-worker debate. A long mutating session with NO wrap-up signal must
// NOT be blocked on every turn.
test('replay-auto-minimal-crystallize-on-incomplete-close: mutating + no marker + NO close-intent → continue', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: '이 함수 좀 고쳐줘' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-midwork',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'mid-work session without close-intent must continue');
    assert.equal(out.decision, undefined, 'must NOT block mid-work (every-turn-block regression)');
  });
});

// False-positive guard: a generic completion phrase ("커밋했습니다", "작업 완료")
// is NOT a session-close signal. isClosePattern is deliberately low-FP.
test('replay-auto-minimal-crystallize-on-incomplete-close: generic "작업 완료" phrase → continue (no false-positive)', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: '이거 커밋했어? 작업 완료됐나 확인해줘' } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-fp',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'generic completion phrase must not trip close-intent gate');
    assert.equal(out.decision, undefined);
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: stop_hook_active=true → continue + no marker write', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-loop',
      transcript_path: transcript,
      stop_hook_active: true,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'loop guard must continue');
    const markerPath = join(dir, '.cache', `session-closed-s-loop.marker`);
    assert.ok(!existsSync(markerPath), 'hook must NOT write marker on loop guard branch');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: valid marker → continue (even with close-intent)', () => {
  withGrowthWiki((dir) => {
    // Include close-intent so we exercise the marker gate (5), not the
    // close-intent gate (4) — proves a valid marker overrides a wrap-up signal.
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'MultiEdit', input: {} }] },
      },
      { type: 'user', message: { role: 'user', content: '세션 마무리하자' } },
    ]);
    writeSessionClosedMarkerFile(dir, 's-closed');
    const r = runAutoMinimal(dir, {
      session_id: 's-closed',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'valid marker → continue');
    assert.equal(out.decision, undefined);
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: stale marker → cleanup + block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      { type: 'user', message: { role: 'user', content: '세션 종료하자' } },
    ]);
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const markerPath = writeSessionClosedMarkerFile(dir, 's-stale', stale);
    const r = runAutoMinimal(dir, {
      session_id: 's-stale',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', 'stale marker must be discarded → block');
    assert.ok(!existsSync(markerPath), 'stale marker must be unlinked during read');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: corrupt marker → cleanup + block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
      { type: 'user', message: { role: 'user', content: '오늘은 이만' } },
    ]);
    mkdirSync(join(dir, '.cache'), { recursive: true });
    const markerPath = join(dir, '.cache', `session-closed-s-corrupt.marker`);
    writeFileSync(markerPath, '{not valid json');
    const r = runAutoMinimal(dir, {
      session_id: 's-corrupt',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', 'corrupt marker must be discarded → block');
    assert.ok(!existsSync(markerPath), 'corrupt marker must be unlinked on read failure');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: missing transcript → continue (fail-open)', () => {
  withGrowthWiki((dir) => {
    const r = runAutoMinimal(dir, {
      session_id: 's-no-transcript',
      transcript_path: join(dir, '.cache', 'does-not-exist.jsonl'),
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'missing transcript → continue');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: HYPO_SKIP_GATE=1 → continue even with mutation+no marker', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
      },
    ]);
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-minimal-crystallize.mjs')], {
      input: JSON.stringify({
        session_id: 's-bypass',
        transcript_path: transcript,
        stop_hook_active: false,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir, HYPO_SKIP_GATE: '1' },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'HYPO_SKIP_GATE=1 → continue');
  });
});

// ── 6a: read-only investigation sessions reach the close-intent gate ──
// A read-only review/debug session (≥5 Read/Grep/Glob/Bash, no mutation) is now
// "substantial". The block still requires a wrap-up signal; pure-volume alone
// must NOT block (close-intent gate unchanged).
suite('6a: read-only investigation sessions reach the close-intent gate');
function readonlyInvestigationLines(n) {
  const tools = ['Read', 'Grep', 'Glob', 'Bash'];
  return Array.from({ length: n }, (_, i) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: tools[i % tools.length], input: {} }] },
  }));
}

test('replay-auto-minimal-crystallize-on-incomplete-close: read-only ≥5 + close-intent → block (6a)', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'user', content: '이 모듈 좀 리뷰해줘' },
      ...readonlyInvestigationLines(5),
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-readonly-close',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.decision,
      'block',
      `read-only investigation + wrap-up must block: ${JSON.stringify(out)}`,
    );
    assert.ok(out.reason.includes('s-readonly-close'), 'reason embeds session_id');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: read-only 4 (below threshold) + close-intent → continue (6a)', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      ...readonlyInvestigationLines(4),
      { type: 'user', message: { role: 'user', content: '세션 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-readonly-light',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.continue,
      true,
      '4 investigation calls < threshold → not substantial → continue',
    );
    assert.equal(out.decision, undefined, 'must NOT block a light read-only session');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: read-only ≥5, NO close-intent → continue (6a)', () => {
  withGrowthWiki((dir) => {
    // Substantial by volume, but no wrap-up signal → the close-intent gate must
    // still continue. This is the every-turn-nag guard that bounds 6a's reach.
    const transcript = writeTranscript(dir, [
      { type: 'user', message: { role: 'user', content: '이 함수 어떻게 동작하는지 설명해줘' } },
      ...readonlyInvestigationLines(6),
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-readonly-midwork',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'no close-intent → continue even when substantial');
    assert.equal(out.decision, undefined, 'close-intent gate bounds the 6a broadening');
  });
});

test('replay-auto-minimal-crystallize-on-incomplete-close: read-only ≥5 + close-intent + valid marker → continue (6a)', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      ...readonlyInvestigationLines(5),
      { type: 'user', message: { role: 'user', content: '세션 종료하자' } },
    ]);
    writeSessionClosedMarkerFile(dir, 's-readonly-closed');
    const r = runAutoMinimal(dir, {
      session_id: 's-readonly-closed',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, 'valid marker overrides a substantial read-only session');
    assert.equal(out.decision, undefined);
  });
});

// ── conditional-close-reconfirm ──────────────────────────────────────────
// The close-intent gate above (step 4) can't tell "close now" from
// "close once X is done" by regex alone — same sentence shape either way
// (see the hook's file-header note). When a close signal fires AND the
// session has a work-incomplete signal (uncommitted wiki changes, or an
// in-flight delegated subagent), the block reason is replaced with an
// AskUserQuestion instruction instead of a silent crystallize nudge.

suite('hypo-auto-minimal-crystallize.mjs — conditional close reconfirm');

test('uncommitted wiki + conditional close phrase, no decline → reconfirm block (not a silent nag)', () => {
  withGrowthWiki((dir) => {
    // Leave a real uncommitted change so the `git` blocker fires (not the
    // .cache phantom the fixture no longer produces).
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x.md'), '# wip\n');
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      {
        type: 'user',
        message: { role: 'user', content: '구현 완료하면 세션 마무리하자' },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-reconfirm',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `must still block, got: ${JSON.stringify(out)}`);
    assert.ok(
      /AskUserQuestion/.test(out.reason),
      `reason must instruct AskUserQuestion: ${out.reason}`,
    );
    assert.ok(
      !/crystallize/.test(out.reason),
      `reason must NOT name a crystallize recovery command before the user picks close-now: ${out.reason}`,
    );
    assert.ok(
      !/--mark-session-closed/.test(out.reason),
      `reason must NOT offer the marker-write command before the user picks close-now: ${out.reason}`,
    );
    assert.ok(out.reason.includes('s-reconfirm'), 'reason must embed the session_id');
    // Coupling guard: the reason's close-now option label and
    // isCloseReconfirmDeclined's correlation mark must be the SAME exported
    // constant, not two independently-hardcoded literals that could drift.
    assert.ok(
      out.reason.includes(CLOSE_RECONFIRM_MARK),
      `reason must use the exported CLOSE_RECONFIRM_MARK label, not a duplicated literal: ${out.reason}`,
    );
  });
});

test('a correlated "아직, 계속" decline suppresses the reconfirm → continue', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x.md'), '# wip\n');
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '구현 완료하면 세션 마무리하자' } },
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-declined',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `must suppress after decline, got: ${JSON.stringify(out)}`);
    assert.equal(out.decision, undefined);
  });
});

test('a NEW user close signal after a decline re-arms the reconfirm → block again', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x.md'), '# wip\n');
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '구현 완료하면 세션 마무리하자' } },
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 진짜 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-rearm',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.decision,
      'block',
      `a new close signal after the decline must re-arm reconfirm: ${JSON.stringify(out)}`,
    );
  });
});

test('decline label variants ("나중에" / "later") also suppress (label-drift defense)', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x.md'), '# wip\n');
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '구현 완료하면 세션 마무리하자' } },
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content: 'Your questions have been answered: "close now?"="later". continue.',
            },
          ],
        },
      },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-label-drift',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.continue, true, `label variant must still suppress: ${JSON.stringify(out)}`);
  });
});

test('genuine close-now + uncommitted, no decline → still reconfirm block (no over-suppress)', () => {
  // "다 끝났으면 세션 마무리하자" is an unambiguous close-now signal, not a
  // conditional one — but the hook can't tell that apart from the reported
  // conditional case by regex, so it must still reconfirm rather than
  // silently allow a close over uncommitted work. There is no decline
  // anywhere in this transcript, so suppression must not kick in either.
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x.md'), '# wip\n');
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '다 끝났으면 세션 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-close-now',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.decision,
      'block',
      `close-now with uncommitted work must still reconfirm: ${JSON.stringify(out)}`,
    );
    assert.ok(
      /AskUserQuestion/.test(out.reason),
      `must still instruct AskUserQuestion: ${out.reason}`,
    );
  });
});

test('non-work-incomplete blocker only (git-clean, close blocker) → existing crystallize wording, no reconfirm', () => {
  withGrowthWiki((dir) => {
    // git-clean tree (fixture is committed at init and nothing new is
    // written to it), no in-flight subagent. A close signal fires, and the
    // read-only precompact gate will surface SOME blocker (e.g. `close`,
    // since sessionCloseGlobalStatus has no fresh close files here) — but
    // that is not a work-incomplete (git/in-flight) signal, so the existing
    // crystallize wording must be preserved, not the reconfirm branch.
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-non-workincomplete',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /crystallize/.test(out.reason),
      `must keep the crystallize recovery command: ${out.reason}`,
    );
    assert.ok(
      !/AskUserQuestion/.test(out.reason),
      `must NOT reconfirm on a non-work-incomplete blocker: ${out.reason}`,
    );
  });
});

test('git-clean + in-flight subagent in background_tasks → reconfirm block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-inflight',
      transcript_path: transcript,
      stop_hook_active: false,
      background_tasks: [{ type: 'subagent', status: 'running' }],
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /AskUserQuestion/.test(out.reason),
      `in-flight subagent must trigger reconfirm: ${out.reason}`,
    );
    assert.ok(
      !/crystallize/.test(out.reason),
      `reconfirm must not name crystallize: ${out.reason}`,
    );
  });
});

test('git-clean + running shell background task → reconfirm block', () => {
  // The reported failure mode: "publish then wrap up" defers the close behind
  // a background Bash (e.g. a CI wait). Local tree is clean and there is no
  // delegated subagent, yet work is still pending — the shell task must be
  // recognized so this reconfirms instead of re-nagging with the plain marker
  // wording every Stop turn.
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '퍼블리시 하고 세션 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-shell-bg',
      transcript_path: transcript,
      stop_hook_active: false,
      background_tasks: [
        { id: 'b1', type: 'shell', status: 'running', description: 'ci', command: 'gh run watch' },
      ],
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /AskUserQuestion/.test(out.reason),
      `running shell task must trigger reconfirm: ${out.reason}`,
    );
    assert.ok(
      !/crystallize/.test(out.reason),
      `reconfirm must not name crystallize: ${out.reason}`,
    );
  });
});

test('git-clean + non-empty session_crons → reconfirm block', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-cron',
      transcript_path: transcript,
      stop_hook_active: false,
      session_crons: [{ id: 'c1', schedule: '0 9 * * *' }],
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /AskUserQuestion/.test(out.reason),
      `scheduled cron wake must trigger reconfirm: ${out.reason}`,
    );
  });
});

test('git-clean + only terminal shell background task → existing crystallize wording (no reconfirm)', () => {
  // A finished task normally drops out of the array, but if a terminal-status
  // entry is still present it must NOT be read as pending work.
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-shell-done',
      transcript_path: transcript,
      stop_hook_active: false,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'completed', command: 'gh run watch' }],
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /crystallize/.test(out.reason),
      `terminal shell task must keep crystallize wording: ${out.reason}`,
    );
    assert.ok(
      !/AskUserQuestion/.test(out.reason),
      `terminal shell task must NOT reconfirm: ${out.reason}`,
    );
  });
});

test('absent background_tasks + uncommitted → in-flight fails open, git alone still reconfirms', () => {
  withGrowthWiki((dir) => {
    mkdirSync(join(dir, 'pages'), { recursive: true });
    writeFileSync(join(dir, 'pages', 'x.md'), '# wip\n');
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    // No background_tasks key at all in the payload.
    const r = runAutoMinimal(dir, {
      session_id: 's-no-bg-tasks',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.equal(r.stderr, '', `no exception expected on absent background_tasks: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /AskUserQuestion/.test(out.reason),
      `uncommitted alone must still reconfirm: ${out.reason}`,
    );
  });
});

test('absent background_tasks + git-clean + close blocker only → existing crystallize wording', () => {
  withGrowthWiki((dir) => {
    const transcript = writeTranscript(dir, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    const r = runAutoMinimal(dir, {
      session_id: 's-no-bg-tasks-clean',
      transcript_path: transcript,
      stop_hook_active: false,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.equal(r.stderr, '', `no exception expected on absent background_tasks: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(
      /crystallize/.test(out.reason),
      `git-clean + absent background_tasks must keep crystallize wording: ${out.reason}`,
    );
  });
});

suite('crystallize.mjs --mark-session-closed');

test('--mark-session-closed without --session-id → exit 1', () => {
  withTmpDir((dir) => {
    const r = run('crystallize.mjs', [`--hypo-dir=${dir}`, '--mark-session-closed', '--json']);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(/session-id/.test(out.error), `error must mention --session-id: ${out.error}`);
  });
});

test('--mark-session-closed with failing gate → exit 1, no marker', () => {
  withTmpDir((dir) => {
    // empty wiki — sessionCloseFileStatus will fail
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-failgate',
      '--json',
    ]);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-failgate.marker')),
      'marker must not be written on failed gate',
    );
  });
});

// Codex pre-commit review BLOCKER (Worker-1): ADR Q2 says marker writer must
// require sessionCloseFileStatus.ok AND hypoIsClean.clean. Without the git
// check, a dirty wiki state would let a marker pass and unblock the Stop hook
// while close work is still uncommitted.
test('--mark-session-closed with ok gate but dirty git → exit 1, no marker (ADR Q2 regression)', () => {
  withWiki(null, (dir) => {
    // Introduce uncommitted change AFTER buildCleanWikiTree's commit.
    writeFileSync(join(dir, 'untracked.md'), 'dirty\n');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-dirty',
      '--json',
    ]);
    assert.equal(r.status, 1, `expected exit 1 on dirty git, stdout: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    // ADR 0047: git-clean is now a `git` blocker inside the unified gate
    // (precompactGateStatus), not a separate git_reason field.
    assert.ok(
      (out.blockers || []).some((b) => b.type === 'git'),
      `dirty-git result must carry a git blocker: ${JSON.stringify(out)}`,
    );
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-dirty.marker')),
      'marker must not land on dirty git',
    );
  });
});

// Codex pre-commit review CONCERN (both workers): writer success path was
// uncovered. Cover both writer entrypoints with a positive marker-creation
// assertion so a future change cannot silently break this path.
test('--mark-session-closed with ok gate + clean git → exit 0, marker created', () => {
  withWiki(null, (dir) => {
    const cleanup = seedCloseTranscript('s-success');
    // close attribution: attribution comes from evidence, never recency. A standalone
    // mark whose transcript touched no close file must name the project it closed.
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-success',
      '--project=test-project',
      '--json',
    ]);
    cleanup();
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.session_id, 's-success');
    const markerPath = join(dir, '.cache', 'session-closed-s-success.marker');
    assert.ok(existsSync(markerPath), 'marker file must be created on success');
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    assert.equal(marker.session_id, 's-success');
    assert.equal(marker.verification, 'session-close-file-status:ok');
    assert.ok(marker.closed_at, 'marker must carry closed_at timestamp');
  });
});

// session-close attribution P1: recency is no longer an attribution source. A
// standalone mark whose transcript touched no close file and names no --project
// has NO evidence of which project it closed, so it must FAIL CLOSED (exit 1, no
// marker) instead of silently attributing to the recency project. Old behavior
// wrote a marker attributed to test-project (recency); this pins the fix.
test('--mark-session-closed with no attribution evidence → fail closed, no marker', () => {
  withWiki(null, (dir) => {
    const cleanup = seedCloseTranscript('s-noevidence');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-noevidence',
      '--json',
    ]);
    cleanup();
    assert.equal(r.status, 1, `no evidence must fail closed, got ${r.status}\n${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.skipReason, 'no-attribution-evidence');
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-noevidence.marker')),
      'no marker may be attributed to the recency project',
    );
  });
});

// The v4 marker discriminator: an evidence-attributed marker carries `projects`,
// which resolveCloseScope trusts directly (a pre-v4 marker has only `project`).
test('--mark-session-closed stamps the v4 projects discriminator', () => {
  withWiki(null, (dir) => {
    const cleanup = seedCloseTranscript('s-disc');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-disc',
      '--project=test-project',
      '--json',
    ]);
    cleanup();
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const marker = JSON.parse(
      readFileSync(join(dir, '.cache', 'session-closed-s-disc.marker'), 'utf-8'),
    );
    assert.deepEqual(
      marker.projects,
      ['test-project'],
      'projects discriminator is the evidence set',
    );
    assert.equal(
      marker.project,
      'test-project',
      'flat project stays as projects[0] for back-compat',
    );
  });
});

// ADR 0055 (codex re-review): the exact prior bypass — a model forging
// <tmpdir>/<sessionId>.jsonl with a close phrase and passing it via
// --transcript-path. The marker gate resolves STRICTLY from the session id, so
// the forged path is ignored and the marker is refused (no real transcript for
// s-forge exists under HOME).
test('--mark-session-closed: forged --transcript-path is ignored → marker refused', () => {
  withWiki(null, (dir) => {
    const fdir = mkdtempSync(join(tmpdir(), 'hypo-forge-'));
    const forged = join(fdir, 's-forge.jsonl'); // basename == <sessionId>.jsonl
    writeFileSync(
      forged,
      JSON.stringify({ type: 'user', message: { role: 'user', content: '세션 마무리 해줘' } }) +
        '\n',
    );
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--session-id=s-forge',
      `--transcript-path=${forged}`,
      '--json',
    ]);
    rmSync(fdir, { recursive: true, force: true });
    assert.equal(r.status, 1, `forged path must not authorize the marker: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.skipReason, 'no-user-close-signal');
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-forge.marker')),
      'no marker may be written from a forged transcript path',
    );
  });
});

test('--mark-session-closed --transcript-path: lint error in a TOUCHED file → marker refused (Bug A)', () => {
  withWiki(
    (dir) => {
      // committed in mutate (before git commit) so git stays clean while the
      // lint error is present — the gate's freshness+git check passes and the
      // new scoped-lint check is what must refuse.
      writeFileSync(
        join(dir, 'projects', 'test-project', 'note.md'),
        '---\ntitle: note\ntype: concept\n\nbody never closes\n',
      );
    },
    (dir) => {
      const noteAbs = join(dir, 'projects', 'test-project', 'note.md');
      const cleanup = seedCloseTranscript('s-touch', {
        toolUseLines: [
          JSON.stringify({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'Edit', input: { file_path: noteAbs } }],
            },
          }),
        ],
      });
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        '--session-id=s-touch',
        '--json',
      ]);
      cleanup();
      assert.equal(r.status, 1, `expected marker refused, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      // ADR 0047: lint failures are now `lint` blockers in the unified gate.
      assert.ok(
        (out.blockers || []).some((b) => b.type === 'lint' && /note\.md/.test(b.reason)),
        `a lint blocker should name the touched file: ${r.stdout}`,
      );
      assert.ok(
        !existsSync(join(dir, '.cache', 'session-closed-s-touch.marker')),
        'marker must NOT be written when a touched file has lint errors',
      );
    },
  );
});

test('--mark-session-closed --transcript-path: lint error only in an UNTOUCHED file → marker still written (Bug B)', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'projects', 'test-project', 'note.md'),
        '---\ntitle: note\ntype: concept\n\nbody never closes\n',
      );
    },
    (dir) => {
      // transcript edited a clean close file, NOT the broken note.md
      const cleanAbs = join(dir, 'projects', 'test-project', 'session-state.md');
      const cleanup = seedCloseTranscript('s-untouch', {
        toolUseLines: [
          JSON.stringify({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', name: 'Edit', input: { file_path: cleanAbs } }],
            },
          }),
        ],
      });
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        '--session-id=s-untouch',
        '--json',
      ]);
      cleanup();
      assert.equal(r.status, 0, `expected marker written, got ${r.status}\n${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.ok(
        existsSync(join(dir, '.cache', 'session-closed-s-untouch.marker')),
        "marker must be written — the lint error is out of this session's scope",
      );
    },
  );
});

test('--apply-session-close --session-id with an unresolvable transcript → refused before any write (no partial commit)', () => {
  // ADR 0056 used to let apply commit its own payload first and only withhold the
  // marker on a bad transcript. The fix that closed the gate (verifyCloseAuthority,
  // this PR's subject) moved the check BEFORE any write: a session-id that resolves
  // to no transcript now refuses the WHOLE apply — no commit, no partial write, and
  // definitely no marker. The refusal is surfaced (reason, not a silent no-op).
  withWiki(null, (dir, today) => {
    const payload = {
      project: 'test-project',
      date: today,
      sessionState: {
        content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      },
      projectHot: {
        content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8'),
      },
      rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
      sessionLog: { entry: `## [${today}] auto-mark test\n` },
      log: { entry: `## [${today}] session | test-project — auto-mark\n` },
    };
    // ISSUE-69: outside the vault's own git tree — commitWikiChanges no
    // longer sweeps the whole working tree, so a payload file left inside
    // `dir` would sit there as a real git blocker instead of being silently
    // absorbed by the apply's own commit.
    const payloadPath = join(tmpdir(), `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`);
    writeFileSync(payloadPath, JSON.stringify(payload));
    const sessionStateBefore = readFileSync(
      join(dir, 'projects', 'test-project', 'session-state.md'),
      'utf-8',
    );
    const headBefore = gitHead(dir);
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      `--payload=${payloadPath}`,
      '--session-id=s-apply-unresolved', // never seeded — no transcript will resolve
      '--json',
    ]);
    assert.notEqual(r.status, 0, 'an unresolvable transcript must refuse the apply');
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'transcript-unresolved');
    assert.deepEqual(out.applied, []);
    assert.equal(out.committed, false);
    assert.equal(gitHead(dir), headBefore, 'refused before any write → no new commit');
    assert.equal(
      readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      sessionStateBefore,
      'refused before any write — session-state.md bytes must be untouched',
    );
    assert.equal(
      existsSync(join(dir, '.cache', 'session-closed-s-apply-unresolved.marker')),
      false,
      'marker must not land on a refused apply',
    );
  });
});

test('--apply-session-close --session-id WITH user-close signal → commits payload AND marker lands (ISSUE-27 fix, ADR 0056)', () => {
  // The core regression fix: apply commits its payload (so the git axis clears) and
  // then writes the marker in the SAME process — no manual --mark-session-closed.
  withWiki(null, (dir, today) => {
    const payload = {
      project: 'test-project',
      date: today,
      sessionState: {
        content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      },
      projectHot: {
        content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8'),
      },
      rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
      sessionLog: { entry: `## [${today}] auto-mark landed test\n` },
      log: { entry: `## [${today}] session | test-project — auto-mark landed\n` },
    };
    // ISSUE-69: outside the vault's own git tree — commitWikiChanges no
    // longer sweeps the whole working tree, so a payload file left inside
    // `dir` would sit there as a real git blocker instead of being silently
    // absorbed by the apply's own commit.
    const payloadPath = join(tmpdir(), `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`);
    writeFileSync(payloadPath, JSON.stringify(payload));
    // Plant a transcript resolvable by session-id that carries a user-close signal.
    const cleanup = seedCloseTranscript('s-apply-land');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--apply-session-close',
      `--payload=${payloadPath}`,
      '--session-id=s-apply-land',
      '--json',
    ]);
    cleanup();
    assert.equal(r.status, 0, `apply failed: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.markerWritten, true, `marker must land: ${JSON.stringify(out)}`);
    assert.equal(out.markerSkipReason, null, `no skip reason expected: ${out.markerSkipReason}`);
    assert.ok(
      existsSync(join(dir, '.cache', 'session-closed-s-apply-land.marker')),
      'marker file must exist after a verified close with a user-close signal',
    );
  });
});

test('IMPR-15: no-user-close-signal → after an AskUserQuestion 세션 마무리 answer, a re-run lands the marker', () => {
  // The documented recovery (crystallize.md Step 4) still exists, but its shape
  // changed with the close-authority gate (this PR's subject): a transcript that
  // resolves but carries no close signal used to let apply write everything and
  // withhold only the marker. Now verifyCloseAuthority refuses the WHOLE apply —
  // no write, no commit, no marker — for that same reason. Confirming once with
  // AskUserQuestion [세션 마무리] still injects a recognized close answer into the
  // transcript, so re-running the SAME idempotent apply now succeeds FULLY (not
  // just the marker) — no script change, no matcher edit.
  const sid = 's-impr15-rerun';
  const projDir = join(SESSION_TMP_HOME, '.claude', 'projects', 'hypo-test-proj');
  const tpath = join(projDir, `${sid}.jsonl`);
  mkdirSync(projDir, { recursive: true });
  try {
    withWiki(null, (dir, today) => {
      const payload = {
        project: 'test-project',
        date: today,
        sessionState: {
          content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
        },
        projectHot: {
          content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8'),
        },
        rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
        sessionLog: { entry: `## [${today}] impr15 rerun test\n` },
        log: { entry: `## [${today}] session | test-project: impr15 rerun\n` },
      };
      // ISSUE-69: outside the vault's own git tree — see the comment on the
      // earlier two payloadPath sites in this file for why.
      const payloadPath = join(
        tmpdir(),
        `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
      );
      writeFileSync(payloadPath, JSON.stringify(payload));
      const args = [
        `--hypo-dir=${dir}`,
        '--apply-session-close',
        `--payload=${payloadPath}`,
        `--session-id=${sid}`,
        '--json',
      ];
      const sessionStateBefore = readFileSync(
        join(dir, 'projects', 'test-project', 'session-state.md'),
        'utf-8',
      );

      // (1) Transcript resolves but carries NO close signal → the whole apply is
      // refused before any write, not just the marker.
      writeFileSync(
        tpath,
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '코드 리뷰 계속 부탁해' },
        }) + '\n',
      );
      const headBefore = gitHead(dir);
      const r1 = run('crystallize.mjs', args);
      assert.notEqual(r1.status, 0, `first run must be refused: ${r1.stdout}\n${r1.stderr}`);
      const o1 = JSON.parse(r1.stdout);
      assert.equal(o1.ok, false, `apply must not proceed without a close signal: ${r1.stdout}`);
      assert.equal(
        o1.reason,
        'no-user-close-signal',
        `expected the no-signal reason (not transcript-unresolved): ${JSON.stringify(o1)}`,
      );
      assert.deepEqual(o1.applied, []);
      assert.equal(o1.committed, false);
      assert.equal(gitHead(dir), headBefore, 'refused before any write → no new commit');
      assert.equal(
        readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
        sessionStateBefore,
        'refused before any write — session-state.md bytes must be untouched',
      );

      // (2) The user picks [세션 마무리] in an AskUserQuestion; that answer value
      // lands in the transcript as a correlated tool_result. Append it and re-run.
      const askLines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'ask-1' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'ask-1',
                content: 'Your questions have been answered: "세션?"="세션 마무리".',
              },
            ],
          },
        }),
      ];
      appendFileSync(tpath, askLines.join('\n') + '\n');
      const r2 = run('crystallize.mjs', args);
      assert.equal(r2.status, 0, `re-run must exit 0: ${r2.stdout}\n${r2.stderr}`);
      const o2 = JSON.parse(r2.stdout);
      assert.equal(o2.ok, true, `re-run ok expected: ${r2.stdout}`);
      assert.equal(
        o2.markerWritten,
        true,
        `marker must land after the close answer: ${JSON.stringify(o2)}`,
      );
      assert.equal(
        o2.markerSkipReason,
        null,
        `no skip reason on the re-run: ${o2.markerSkipReason}`,
      );
      assert.ok(
        existsSync(join(dir, '.cache', `session-closed-${sid}.marker`)),
        'marker file must exist after the AskUserQuestion close answer + re-run',
      );
    });
  } finally {
    rmSync(tpath, { force: true });
  }
});

// ── precompactGateStatus / crystallize --check-session-close — single source ──
// ADR 0046: `crystallize --check-session-close` now runs the FULL PreCompact gate
// (via precompactGateStatus), so it can no longer report a clean close while
// /compact blocks on a feedback over-cap or a lint error in a close file. The
// feedback classification itself (over-cap/conflict block, pure drift self-heals)
// is already locked hermetically by the spawned hypo-personal-check.mjs tests
// above (which set a controlled HOME with hypo-pkg.json so PKG_ROOT resolves);
// the gap this ADR closes is that the CHECK reflects that gate too. We exercise
// it through the real CLI with a controlled HOME — a direct precompactGateStatus
// import would resolve PKG_ROOT from the ambient ~/.claude and skip the feedback
// path under a clean CI HOME, making the test a no-op (or fail).
suite('crystallize --check-session-close — full gate, single source of truth (ADR 0046)');

test('check-session-close surfaces a feedback over-cap as a gate blocker (not just close files)', () => {
  withTmpDir((dir) => {
    const wiki = join(dir, 'wiki');
    mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '# config');
    // 11 distinct global-L1 pages → CLAUDE projection over the 10-entry cap.
    for (let i = 0; i < 11; i++) {
      writeFileSync(
        join(wiki, 'pages', 'feedback', `rule-${i}.md`),
        fbPage({
          ...FB_GLOBAL_L1,
          title: `R${i}`,
          global_summary: `do thing ${i}`,
          memory_summary: `m ${i}`,
        }),
      );
    }
    // Controlled HOME so the crystallize child resolves PKG_ROOT (→ REPO) and
    // reads a real claude-home — hermetic regardless of the CI runner's HOME.
    const home = join(dir, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
    writeFileSync(
      join(home, '.claude', 'CLAUDE.md'),
      '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
    );
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'crystallize.mjs'), '--check-session-close', `--hypo-dir=${wiki}`, '--json'],
      { encoding: 'utf-8', env: { ...process.env, HOME: home, HYPO_DIR: '' } },
    );
    assert.equal(r.status, 1, `over-cap must make the check not compact-ready: ${r.stdout}`);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false, 'ok must reflect the full gate, not just close files');
    assert.ok(
      (report.blockers || []).some((b) => b.type === 'feedback' && /over cap/.test(b.reason)),
      `feedback over-cap must appear in the check's blockers (proves the feedback path ran): ${r.stdout}`,
    );
  });
});

// ── ADR 0047: both marker writers share the /compact gate ────────────────────
// The per-session marker is the THIRD session-close completion signal. It used
// to gate on a NARROWER check (close files + git + optional scoped-lint) than
// the real /compact gate (precompactGateStatus also enforces feedback
// projection over-cap/conflict, W8 design-history, and hot.md structure). That
// divergence let a marker attest "closed" while /compact would still block.
// These tests lock the writer⟺gate coherence for BOTH writer paths (standalone
// --mark-session-closed and --apply-session-close), the pure-drift carve-out,
// the verify marker field, and the refined Stop message. They use a controlled
// HOME with hypo-pkg.json so the crystallize/hook child resolves PKG_ROOT and
// actually runs the lint + feedback subprocesses (under a clean CI HOME those
// paths skip, making the test a no-op) — same hermetic pattern as the
// check-session-close over-cap test above.
suite('ADR 0047 — marker writers share the /compact gate (precompactGateStatus)');

function adr47CommitWiki(dir) {
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

function adr47ControlledHome(dir) {
  const home = join(dir, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
  writeFileSync(
    join(home, '.claude', 'CLAUDE.md'),
    '# Global\n<learned_behaviors>\n</learned_behaviors>\n',
  );
  return home;
}

function adr47SeedFeedback(wiki, count) {
  mkdirSync(join(wiki, 'pages', 'feedback'), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(wiki, 'pages', 'feedback', `rule-${i}.md`),
      fbPage({
        ...FB_GLOBAL_L1,
        title: `R${i}`,
        global_summary: `do thing ${i}`,
        memory_summary: `m ${i}`,
      }),
    );
  }
}

test('--mark-session-closed refuses the marker on a feedback over-cap even when close files are fresh + git clean', () => {
  withTmpDir((dir) => {
    const wiki = join(dir, 'wiki');
    const today = todayLocal();
    mkdirSync(wiki, { recursive: true });
    buildCleanWikiTree(wiki, today); // 5 close files fresh
    adr47SeedFeedback(wiki, 11); // 11 global-L1 → CLAUDE projection over the 10 cap
    adr47CommitWiki(wiki); // git clean
    const home = adr47ControlledHome(dir);
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'crystallize.mjs'),
        '--mark-session-closed',
        '--session-id=s-overcap',
        `--hypo-dir=${wiki}`,
        '--json',
      ],
      { encoding: 'utf-8', env: { ...process.env, HOME: home, HYPO_DIR: '' } },
    );
    assert.equal(r.status, 1, `over-cap must refuse the marker: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      (out.blockers || []).some((b) => b.type === 'feedback' && /over cap/.test(b.reason)),
      `marker must be refused on the feedback over-cap (the check the narrow gate skipped): ${r.stdout}`,
    );
    assert.ok(
      !existsSync(join(wiki, '.cache', 'session-closed-s-overcap.marker')),
      'marker must not land while the gate blocks',
    );
  });
});

test('--apply-session-close text output: markerWritten:false prints loud stderr warning (not silent)', () => {
  // The close-authority gate now refuses the WHOLE apply (before any write) for
  // session-id-required / transcript-unresolved / no-user-close-signal, so those
  // three reasons can no longer reach this later "apply succeeded, marker withheld"
  // path — see the rewritten "NO user-close signal" tests below. What still reaches
  // it is a gate failure INDEPENDENT of close authority: an authorized transcript
  // with a real close signal, but a feedback-over-cap blocker that fails the
  // precompact gate (compact-gate-not-ok). The human-facing text output (no --json)
  // must still print a loud warning to stderr so neither the user nor a model
  // mis-reads "ok:true" as "session fully closed".
  withTmpDir((dir) => {
    const wiki = join(dir, 'wiki');
    const today = todayLocal();
    mkdirSync(wiki, { recursive: true });
    buildCleanWikiTree(wiki, today);
    adr47SeedFeedback(wiki, 11); // over the 10-entry cap → compact-gate-not-ok
    adr47CommitWiki(wiki);
    const home = adr47ControlledHome(dir);
    const closeCleanup = seedCloseTranscript('s-text-warn', { home });
    const payload = {
      project: 'test-project',
      date: today,
      sessionState: {
        content: readFileSync(join(wiki, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      },
      projectHot: {
        content: readFileSync(join(wiki, 'projects', 'test-project', 'hot.md'), 'utf-8'),
      },
      rootHot: { content: readFileSync(join(wiki, 'hot.md'), 'utf-8') },
      sessionLog: { entry: `## [${today}] marker-warning text test\n` },
      log: { entry: `## [${today}] session | test-project: marker-warning text\n` },
    };
    const payloadPath = join(dir, '.payload.json'); // outside the wiki git tree
    writeFileSync(payloadPath, JSON.stringify(payload));
    // Run WITHOUT --json so the human text path is exercised.
    let r;
    try {
      r = spawnSync(
        process.execPath,
        [
          join(SCRIPTS, 'crystallize.mjs'),
          `--hypo-dir=${wiki}`,
          '--apply-session-close',
          `--payload=${payloadPath}`,
          '--session-id=s-text-warn',
        ],
        { encoding: 'utf-8', env: { ...process.env, HOME: home, HYPO_DIR: '' } },
      );
    } finally {
      closeCleanup();
    }
    assert.equal(r.status, 0, `apply must exit 0 even when marker is withheld: ${r.stderr}`);
    assert.ok(
      r.stderr.includes('session-close marker NOT written'),
      `stderr must contain the marker-not-written warning: ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      r.stderr.includes('reason: compact-gate-not-ok'),
      `stderr must include the surfaced skip reason: ${JSON.stringify(r.stderr)}`,
    );
    assert.ok(
      r.stderr.includes('Stop-chain'),
      `stderr must mention Stop-chain so the reader knows the session is not closed: ${JSON.stringify(r.stderr)}`,
    );
  });
});

test('--apply-session-close routes the marker write through the full gate — refuses on feedback over-cap', () => {
  withTmpDir((dir) => {
    const wiki = join(dir, 'wiki');
    const today = todayLocal();
    mkdirSync(wiki, { recursive: true });
    buildCleanWikiTree(wiki, today);
    adr47SeedFeedback(wiki, 11);
    adr47CommitWiki(wiki);
    const home = adr47ControlledHome(dir);
    // Idempotent payload: full-content fields echo current bytes, append entries
    // match the existing headings → apply writes NOTHING → git stays clean. So
    // the only thing that can refuse the marker is the new gate (feedback), not
    // a git-dirty masking it.
    const payload = {
      project: 'test-project',
      date: today,
      sessionState: {
        content: readFileSync(join(wiki, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
      },
      projectHot: {
        content: readFileSync(join(wiki, 'projects', 'test-project', 'hot.md'), 'utf-8'),
      },
      rootHot: { content: readFileSync(join(wiki, 'hot.md'), 'utf-8') },
      sessionLog: { entry: `## [${today}] test session\n` },
      log: { entry: `## [${today}] session | test-project\n` },
    };
    const payloadPath = join(dir, 'payload.json'); // outside the wiki git tree
    writeFileSync(payloadPath, JSON.stringify(payload));
    // The close-authority gate runs before the feedback-cap gate this test is
    // about, so the session-id needs a resolvable, authorized transcript in the
    // controlled home or the apply is refused for the wrong reason.
    const closeCleanup = seedCloseTranscript('s-apply-oc', { home });
    let r;
    try {
      r = spawnSync(
        process.execPath,
        [
          join(SCRIPTS, 'crystallize.mjs'),
          '--apply-session-close',
          `--payload=${payloadPath}`,
          '--session-id=s-apply-oc',
          `--hypo-dir=${wiki}`,
          '--json',
        ],
        { encoding: 'utf-8', env: { ...process.env, HOME: home, HYPO_DIR: '' } },
      );
    } finally {
      closeCleanup();
    }
    assert.equal(
      r.status,
      0,
      `apply itself must succeed (idempotent no-op): ${r.stdout}\n${r.stderr}`,
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true, `apply ok (files fresh, lint clean): ${r.stdout}`);
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: wiki, encoding: 'utf-8' });
    assert.equal(
      st.stdout.trim(),
      '',
      `payload must be a no-op so git stays clean (else git, not feedback, masks the test): ${st.stdout}`,
    );
    assert.ok(
      !existsSync(join(wiki, '.cache', 'session-closed-s-apply-oc.marker')),
      'apply must NOT write the marker while the full gate blocks on feedback over-cap',
    );
  });
});

test('--mark-session-closed writes the marker on PURE feedback drift and surfaces drift_deferred', () => {
  withTmpDir((dir) => {
    const wiki = join(dir, 'wiki');
    const today = todayLocal();
    mkdirSync(wiki, { recursive: true });
    buildCleanWikiTree(wiki, today);
    adr47SeedFeedback(wiki, 2); // under the cap → pure drift (CLAUDE.md not yet synced)
    adr47CommitWiki(wiki);
    const home = adr47ControlledHome(dir);
    const cleanup = seedCloseTranscript('s-drift', { home });
    const r = spawnSync(
      process.execPath,
      [
        join(SCRIPTS, 'crystallize.mjs'),
        '--mark-session-closed',
        '--session-id=s-drift',
        '--project=test-project',
        `--hypo-dir=${wiki}`,
        '--json',
      ],
      { encoding: 'utf-8', env: { ...process.env, HOME: home, HYPO_DIR: '' } },
    );
    cleanup();
    assert.equal(r.status, 0, `pure drift must NOT block the marker: ${r.stdout}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.ok(
      existsSync(join(wiki, '.cache', 'session-closed-s-drift.marker')),
      'marker must land on pure drift (non-blocker)',
    );
    assert.ok(
      Array.isArray(out.drift_deferred) && out.drift_deferred.length > 0,
      `drift_deferred must surface the pending projection sync (self-heals at /compact): ${r.stdout}`,
    );
  });
});

test('--check-session-close --session-id reports marker presence without altering ok', () => {
  withWiki(null, (dir) => {
    const r1 = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--session-id=s-mp',
      '--json',
    ]);
    const o1 = JSON.parse(r1.stdout);
    assert.equal(o1.session_id, 's-mp');
    assert.equal(o1.marker_present, false, `marker absent must report false: ${r1.stdout}`);
    // `ok` is the compact-ready verdict and must NOT require the marker: a clean
    // close is compact-ready even before the marker exists (that IS the hand-edit
    // state). Prove independence directly rather than across two runs.
    assert.equal(
      o1.ok,
      true,
      `a clean close must be compact-ready without the marker: ${r1.stdout}`,
    );
    writeSessionClosedMarkerFile(dir, 's-mp');
    // Commit the marker file so the second run's git tree stays clean (otherwise
    // the new .cache/ file would dirty git and flip ok via the git blocker —
    // unrelated to marker_present).
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-m', 'marker'], { cwd: dir });
    const r2 = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--session-id=s-mp',
      '--json',
    ]);
    const o2 = JSON.parse(r2.stdout);
    assert.equal(o2.marker_present, true, `marker present must report true: ${r2.stdout}`);
    assert.equal(o1.ok, o2.ok, 'marker_present must not change the compact-ready ok verdict');
  });
});

test('--check-session-close text output: marker-absent recovery is a runnable node command, not a bare bin', () => {
  withWiki(null, (dir) => {
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--session-id=s-recover',
    ]);
    // ISSUE-40: `crystallize` is a package.json bin not on PATH in a plugin
    // install. The marker-absent recovery line must spell out a runnable
    // `node <pkg>/scripts/crystallize.mjs --mark-session-closed ...`.
    assert.ok(
      /Run `node "\S*crystallize\.mjs" --mark-session-closed --session-id=s-recover`/.test(
        r.stdout,
      ),
      `recovery command must be a runnable, path-quoted node invocation: ${r.stdout}`,
    );
  });
});

// ── ISSUE-10: --log-only first-class non-project close path ───────────────────
suite('crystallize.mjs --mark-session-closed --log-only (ISSUE-10)');

// A non-project (tooling / wiki-only) session leaves a today log.md entry but
// closes NO project. The current marker gate resolves the active project via
// sessionCloseGlobalStatus and demands its mandatory files — trapping the session
// and pushing it to clobber an unrelated project's handoff. --log-only is the
// first-class signal: exempt the project-close blocker, still require git/hot/lint
// clean + a today log.md entry (the log-only minimum proof), record project:null.
test('--log-only: active project not closed today → marker written, project:null, scope log-only', () => {
  withWiki(
    (dir) => {
      // Backdate the project's mandatory files so sessionCloseGlobalStatus would
      // block on them, but keep the today log.md entry (the log-only session's own
      // trace) so the gate still has its minimum proof.
      const stale = '2000-01-01';
      const projDir = join(dir, 'projects', 'test-project');
      writeFileSync(
        join(projDir, 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${stale}\n---\n\n## 다음 작업\n\n- next\n`,
      );
      writeFileSync(
        join(projDir, 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${stale}\n---\n\n# Hot\n`,
      );
      const ym = todayLocal().slice(0, 7);
      writeFileSync(
        join(projDir, 'session-log', `${ym}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: ${stale}\n---\n\n## [${stale}] old session\n`,
      );
    },
    (dir) => {
      const cleanup = seedCloseTranscript('s-logonly');
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        '--log-only',
        '--session-id=s-logonly',
        '--json',
      ]);
      cleanup();
      assert.equal(
        r.status,
        0,
        `--log-only must close a non-project session despite a stale active project: ${r.stdout}\n${r.stderr}`,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.equal(out.scope, 'log-only');
      const markerPath = join(dir, '.cache', 'session-closed-s-logonly.marker');
      assert.ok(existsSync(markerPath), 'log-only marker must be written');
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
      assert.equal(
        marker.project,
        null,
        'log-only marker must NOT attribute to a project (clobber-safe)',
      );
      assert.equal(marker.scope, 'log-only');
    },
  );
});

// log-only is NOT a global-gate bypass: git must still be clean.
test('--log-only: dirty git still blocks (not a global bypass)', () => {
  withWiki(null, (dir) => {
    writeFileSync(join(dir, 'untracked.md'), 'dirty\n');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--mark-session-closed',
      '--log-only',
      '--session-id=s-lo-dirty',
      '--json',
    ]);
    assert.equal(r.status, 1, `log-only must still block on dirty git: ${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, false);
    assert.ok(
      (out.blockers || []).some((b) => b.type === 'git'),
      `dirty-git log-only result must carry a git blocker: ${JSON.stringify(out)}`,
    );
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-lo-dirty.marker')),
      'log-only marker must not land on dirty git',
    );
  });
});

// log-only requires its minimum proof: a today log.md entry. Without one the
// session left no trace and the marker is refused.
test('--log-only: no today log.md entry → marker refused (minimum proof)', () => {
  withWiki(
    (dir) => {
      // Wipe log.md to its header so there is NO today session entry at all.
      writeFileSync(join(dir, 'log.md'), '# Log\n');
    },
    (dir) => {
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        '--log-only',
        '--session-id=s-lo-nolog',
        '--json',
      ]);
      assert.equal(r.status, 1, `log-only with no today log entry must block: ${r.stdout}`);
      assert.ok(
        !existsSync(join(dir, '.cache', 'session-closed-s-lo-nolog.marker')),
        'log-only marker must not land without a today log.md entry',
      );
    },
  );
});

// Completion-signal trio coherence (codex design Finding 2): after a log-only
// marker, --check-session-close --session-id must read the SAME log-only gate —
// marker_present:true AND ok:true — even though the active project is stale.
// Without passing sessionId into the gate it would report marker_present:true
// while ok:false from the stale project (the divergence this guards).
test('--check-session-close --session-id: log-only marker → ok:true, marker_present:true (trio coherence)', () => {
  withWiki(
    (dir) => {
      const stale = '2000-01-01';
      const projDir = join(dir, 'projects', 'test-project');
      writeFileSync(
        join(projDir, 'session-state.md'),
        `---\ntitle: session-state\ntype: session-state\nupdated: ${stale}\n---\n\n## 다음 작업\n\n- next\n`,
      );
      writeFileSync(
        join(projDir, 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${stale}\n---\n\n# Hot\n`,
      );
      const ym = todayLocal().slice(0, 7);
      writeFileSync(
        join(projDir, 'session-log', `${ym}.md`),
        `---\ntitle: Session Log\ntype: session-log\nupdated: ${stale}\n---\n\n## [${stale}] old session\n`,
      );
    },
    (dir) => {
      // First write the log-only marker, then commit it so git stays clean.
      const cleanup = seedCloseTranscript('s-trio');
      const m = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--mark-session-closed',
        '--log-only',
        '--session-id=s-trio',
        '--json',
      ]);
      cleanup();
      assert.equal(m.status, 0, `log-only marker write must succeed: ${m.stdout}\n${m.stderr}`);
      spawnSync('git', ['add', '-A'], { cwd: dir });
      spawnSync('git', ['commit', '-m', 'marker'], { cwd: dir });
      const r = run('crystallize.mjs', [
        `--hypo-dir=${dir}`,
        '--check-session-close',
        '--session-id=s-trio',
        '--json',
      ]);
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.marker_present,
        true,
        `the log-only marker must be reported present: ${r.stdout}`,
      );
      assert.equal(
        out.ok,
        true,
        `log-only check must be compact-ready despite the stale project: ${r.stdout}`,
      );
    },
  );
});

test('--check-session-close --session-id: a STALE marker reports marker_present:false (matches the Stop hook reader, not raw existsSync)', () => {
  withWiki(null, (dir) => {
    // A marker file exists on disk but is stale → the Stop hook would reject and
    // unlink it, so /compact's Stop still blocks. marker_present must agree
    // (codex pre-commit CONCERN: raw existsSync would falsely report true).
    writeSessionClosedMarkerFile(dir, 's-stale-mp', '2020-01-01T00:00:00.000Z');
    const r = run('crystallize.mjs', [
      `--hypo-dir=${dir}`,
      '--check-session-close',
      '--session-id=s-stale-mp',
      '--json',
    ]);
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.marker_present,
      false,
      `a stale marker must report marker_present:false: ${r.stdout}`,
    );
    // The shared reader unlinks the invalid marker as it reads (same as the hook).
    assert.ok(
      !existsSync(join(dir, '.cache', 'session-closed-s-stale-mp.marker')),
      'stale marker should be unlinked by the validity check',
    );
  });
});

test('Stop hook: close gate green but marker absent → precise "close gate green" message', () => {
  withTmpDir((dir) => {
    const wiki = join(dir, 'wiki');
    const today = todayLocal();
    mkdirSync(wiki, { recursive: true });
    buildCleanWikiTree(wiki, today); // no feedback pages → gate fully green once committed
    adr47CommitWiki(wiki);
    const home = adr47ControlledHome(dir); // PKG_ROOT resolves so the hook's read-only gate runs
    const transcript = join(dir, 'stop.jsonl');
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Edit', input: { file_path: join(wiki, 'hot.md') } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: '오늘은 이만 마무리하자' },
        }),
      ].join('\n') + '\n',
    );
    const r = spawnSync(process.execPath, [join(HOOKS, 'hypo-auto-minimal-crystallize.mjs')], {
      input: JSON.stringify({
        session_id: 's-green',
        transcript_path: transcript,
        stop_hook_active: false,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, HYPO_DIR: wiki },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block', `must block while the marker is absent: ${r.stdout}`);
    assert.ok(
      /close gate green/.test(out.reason),
      `a green gate must produce the precise marker-missing message: ${out.reason}`,
    );
    assert.ok(/--mark-session-closed/.test(out.reason), 'message must give the exact mark command');
    // ISSUE-40: the marker command must be a runnable `node <pkg>/.../crystallize.mjs`
    // invocation, never a bare `crystallize` bin (not on PATH in a plugin install).
    assert.ok(
      /node "\S*crystallize\.mjs" --mark-session-closed/.test(out.reason),
      `marker command must be a runnable, path-quoted node invocation, not a bare bin (ISSUE-40): ${out.reason}`,
    );
    assert.ok(out.reason.includes('s-green'), 'message must embed the session_id');
  });
});

// ── close-pipeline state machine: planMarkerDecision + closeResultContradiction ─
// Deterministic table tests for the two pure close-pipeline functions. The close
// marker decision is deterministic given its input signals; these tables exercise
// that state machine directly (no CLI spawn). Fixtures are distilled from the
// real session-close failures that motivated the safety net:
//   ISSUE-27 (git-dirty self-block)   → commit-failed skip
//   ISSUE-28 (cross-block bookkeeping) → compact-gate-not-ok skip
//   ISSUE-33 (wrong --session-id)      → transcript-unresolved / no-user-close-signal
//   ISSUE-1/7/12 (project resolution)  → upstream of gateOk (which project the gate scores)
suite('close-pipeline: planMarkerDecision (deterministic state machine)');

// [label, input, expected]
const MARKER_DECISION_CASES = [
  [
    'apply not ok → not a marker path (no reason)',
    {
      ok: false,
      hasSessionId: true,
      committed: true,
      gateOk: true,
      transcriptResolved: true,
      hasUserSignal: true,
    },
    { write: false, skipReason: null },
  ],
  [
    'no session id → not a marker path (no reason)',
    {
      ok: true,
      hasSessionId: false,
      committed: true,
      gateOk: true,
      transcriptResolved: true,
      hasUserSignal: true,
    },
    { write: false, skipReason: null },
  ],
  [
    'ISSUE-27: commit failed → commit-failed skip',
    {
      ok: true,
      hasSessionId: true,
      committed: false,
      commitReason: 'uncommitted',
      gateOk: false,
      transcriptResolved: false,
      hasUserSignal: false,
    },
    { write: false, skipReason: 'commit-failed: uncommitted' },
  ],
  [
    'ISSUE-28: compact gate not ok → compact-gate-not-ok',
    {
      ok: true,
      hasSessionId: true,
      committed: true,
      gateOk: false,
      transcriptResolved: true,
      hasUserSignal: true,
    },
    { write: false, skipReason: 'compact-gate-not-ok' },
  ],
  [
    'ISSUE-33: transcript unresolved → transcript-unresolved',
    {
      ok: true,
      hasSessionId: true,
      committed: true,
      gateOk: true,
      transcriptResolved: false,
      hasUserSignal: false,
    },
    { write: false, skipReason: 'transcript-unresolved' },
  ],
  [
    'ISSUE-33: transcript resolved but no user signal → no-user-close-signal',
    {
      ok: true,
      hasSessionId: true,
      committed: true,
      gateOk: true,
      transcriptResolved: true,
      hasUserSignal: false,
    },
    { write: false, skipReason: 'no-user-close-signal' },
  ],
  [
    'all clear → write the marker',
    {
      ok: true,
      hasSessionId: true,
      committed: true,
      gateOk: true,
      transcriptResolved: true,
      hasUserSignal: true,
    },
    { write: true, skipReason: null },
  ],
];

for (const [label, input, expected] of MARKER_DECISION_CASES) {
  test(label, () => {
    assert.deepEqual(planMarkerDecision(input), expected);
  });
}

test('branch priority: commit-failed wins over a would-be gate/signal skip', () => {
  // Even with gateOk:false and no signal, a commit failure is reported FIRST
  // (the tree was never committed, so the downstream gate never ran).
  assert.deepEqual(
    planMarkerDecision({
      ok: true,
      hasSessionId: true,
      committed: false,
      commitReason: 'not a repo',
      gateOk: false,
      transcriptResolved: false,
      hasUserSignal: false,
    }),
    { write: false, skipReason: 'commit-failed: not a repo' },
  );
});

suite('close-pipeline: closeResultContradiction (runtime invariant self-check)');

// Every legitimate withhold (marker not written, but a real reason recorded) is
// a VALID outcome, not a contradiction → null.
const LEGIT_WITHHOLDS = [
  'commit-failed: uncommitted',
  'compact-gate-not-ok',
  'transcript-unresolved',
  'no-user-close-signal',
  'marker-did-not-land',
];

for (const reason of LEGIT_WITHHOLDS) {
  test(`legit withhold (${reason}) → no contradiction`, () => {
    assert.equal(
      closeResultContradiction({ ok: true, markerWritten: false, markerSkipReason: reason }),
      null,
    );
  });
}

test('normal write (marker written, no reason) → no contradiction', () => {
  assert.equal(
    closeResultContradiction({ ok: true, markerWritten: true, markerSkipReason: null }),
    null,
  );
});

test('apply failed (ok:false, no marker, no reason) → no contradiction', () => {
  // ok is already false for a file/lint reason; a withheld marker with no reason
  // is expected here (the marker block never ran), so this is NOT the invariant's
  // target — it only fires on ok:true.
  assert.equal(
    closeResultContradiction({ ok: false, markerWritten: false, markerSkipReason: null }),
    null,
  );
});

test('contradiction A: ok:true, marker withheld, no reason → flagged', () => {
  assert.equal(
    closeResultContradiction({ ok: true, markerWritten: false, markerSkipReason: null }),
    'internal-contradiction:marker-withheld-without-reason',
  );
});

for (const blank of ['', '   ']) {
  test(`contradiction A: a blank-string reason (${JSON.stringify(blank)}) counts as reasonless`, () => {
    // The stderr warning path gates on truthiness, so a blank reason would evade
    // a naive `== null` check while surfacing nothing to the reader.
    assert.equal(
      closeResultContradiction({ ok: true, markerWritten: false, markerSkipReason: blank }),
      'internal-contradiction:marker-withheld-without-reason',
    );
  });
}

for (const bogus of [false, 0, [], {}]) {
  test(`contradiction A: a non-string reason (${JSON.stringify(bogus)}) does not count as a real reason`, () => {
    // A real reason is a non-blank string; a future bad assignment must not be
    // able to hide a withheld marker behind a bogus non-string value.
    assert.equal(
      closeResultContradiction({ ok: true, markerWritten: false, markerSkipReason: bogus }),
      'internal-contradiction:marker-withheld-without-reason',
    );
  });
}

test('contradiction B: marker written AND a skip reason set → flagged', () => {
  assert.equal(
    closeResultContradiction({
      ok: true,
      markerWritten: true,
      markerSkipReason: 'no-user-close-signal',
    }),
    'internal-contradiction:marker-written-with-skip-reason',
  );
});

test('marker written with a blank reason → not contradiction B (blank is no reason)', () => {
  assert.equal(
    closeResultContradiction({ ok: true, markerWritten: true, markerSkipReason: '' }),
    null,
  );
});

suite('crystallize.mjs entry guard (import must not run the CLI)');

test('importing crystallize.mjs runs no CLI and exposes exactly the pure exports', () => {
  // The pure close-pipeline exports are usable only because the CLI dispatch is
  // guarded behind isMain(). A regressed guard that let the CLI run on import
  // would either crash (process.exit) or leak crystallize output here — assert
  // the import is silent and yields exactly the two exported names.
  const script = join(REPO, 'scripts', 'crystallize.mjs');
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(script)}).then((m) => process.stdout.write(Object.keys(m).sort().join(',')))`,
    ],
    { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME } },
  );
  assert.equal(r.status, 0, `import must exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(
    r.stdout,
    'closeResultContradiction,planMarkerDecision',
    `import must print only the pure exports (no CLI output): ${JSON.stringify(r.stdout)}`,
  );
});

// ── IMPR-34 — close-debt attribution (foreign incomplete close must not block) ──
suite('IMPR-34 — close-debt attribution');

// A git-clean vault with two projects and a transcript. `projects` is passed
// straight to makeMultiProjectWiki; `touched` is the list of repo-relative files
// the fake transcript shows this session editing via Write.
function withClosePartitionWiki(projects, touched, fn) {
  withSyncedWiki((dir) => {
    const today = todayLocal();
    makeMultiProjectWiki(dir, today, projects);
    // makeMultiProjectWiki writes `## next`, which is not one of lint's required
    // session-state headings. Left as-is it puts a lint ERROR in EVERY project's
    // close files, so the gate would never be green and `gate.ok` could not be
    // asserted — the close partition would look proven while the marker still never
    // lands. Rewrite the heading so the close axis is the only thing under test.
    for (const p of projects) {
      const ss = join(dir, 'projects', p.slug, 'session-state.md');
      if (existsSync(ss))
        writeFileSync(ss, readFileSync(ss, 'utf-8').replace('## next', '## 다음 작업'));
    }
    const transcript = join(dir, '.cache', 'transcript.jsonl');
    mkdirSync(join(dir, '.cache'), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: touched.map((f) => ({
            type: 'tool_use',
            name: 'Write',
            input: { file_path: join(dir, f) },
          })),
        },
      }) + '\n',
    );
    // Commit so the gate's git axis is clean and only the close axis is under test.
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'close state']);
    spawnSync('git', ['-C', dir, 'push', '-q', 'origin', 'HEAD']);
    // A controlled HOME for the children these tests spawn. crystallize runs the
    // full gate, which resolves PKG_ROOT from <home>/.claude/hypo-pkg.json and the
    // feedback projection from <home>/.claude. Left ambient, the child reads the
    // DEVELOPER's real ~/.claude, and a close assertion then turns on whatever state
    // that happens to be in: an unreadable CLAUDE.md there is a feedback blocker, so
    // `ok` goes false while `missing` stays empty, which is the exact contradiction
    // the CLI test below exists to rule out. CI never catches it (no hypo-pkg.json
    // there, so PKG_ROOT is null and both axes skip), so it can only ever fail on a
    // maintainer's machine.
    //
    // hypo-pkg.json is present so lint still runs against the wiki under test;
    // CLAUDE.md is absent so the feedback axis fails open on target-missing. Same
    // neutralization the in-process tests take from `claudeHome: '.claude-none'`,
    // which a spawned child cannot be handed.
    const home = mkdtempSync(join(tmpdir(), 'hypo-close-home-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'hypo-pkg.json'), JSON.stringify({ pkgRoot: REPO }));
    try {
      fn(dir, transcript, home, today);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

// The incident: `mine` is fully closed, `foreign` was closed today by ANOTHER
// session and left its session-log without the dated heading the gate requires.
// Before the partition this refused `mine`'s marker with compact-gate-not-ok.
const INCIDENT = (today) => [
  { slug: 'mine', date: today },
  { slug: 'foreign', date: today, sessionLog: false },
];

test('IMPR-34: foreign incomplete close is a notice, not a blocker, when scope names mine', () => {
  withClosePartitionWiki(INCIDENT(todayLocal()), [], (dir) => {
    const gate = precompactGateStatus(dir, {
      closeScope: ['mine'],
      claudeHome: join(dir, '.claude-none'),
    });
    assert.equal(
      gate.blockers.some((b) => b.type === 'close'),
      false,
      `mine is complete → no close blocker. got ${JSON.stringify(gate.blockers)}`,
    );
    const debt = gate.notices.filter((n) => n.type === 'close-debt');
    assert.deepEqual(
      debt.map((n) => n.project),
      ['foreign'],
      'foreign debt is surfaced as a notice, never silently dropped',
    );
    assert.deepEqual(gate.close.missing, [], 'flat missing describes what BLOCKS, not the debt');
    assert.equal(gate.close.ok, true, 'close.ok cannot contradict the absence of a close blocker');
    // The actual win. Asserting only "no close blocker" would pass while the gate
    // stayed red for some other reason and the marker still never landed.
    assert.equal(gate.ok, true, `the gate is GREEN → the marker lands: ${JSON.stringify(gate)}`);
  });
});

// ── session-cwd close check (session-close attribution, P2) ──────────────────
// The false-green this closes: a secondary project whose close was NEVER STARTED
// leaves no today close-activity trace, so the recency-based global status can't
// see it. When the recency project was closed the same day, the gate goes green
// while the session's own project stays open. The independent cwd check catches it.
suite('session-cwd close check (P2)');

// Give a project an index.md working_dir so pickProjectByCwd can resolve a cwd.
function setWorkingDir(dir, slug, workingDir) {
  const idx = join(dir, 'projects', slug, 'index.md');
  writeFileSync(
    idx,
    `---\ntitle: ${slug}\ntype: index\nworking_dir: ${workingDir}\n---\n\n# ${slug}\n`,
  );
  // Commit so the gate's git axis stays clean (ahead-of-remote is only a notice).
  spawnSync('git', ['-C', dir, 'add', '-A']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'idx']);
}

test('P2: a never-started cwd project close is caught even when recency is green', () => {
  const CWD = '/tmp/cwdproj-workdir';
  withClosePartitionWiki(
    [
      // recency-proj: fully closed today → the only today-active project.
      { slug: 'recency-proj', date: todayLocal() },
      // cwd-proj: session-state fresh (a real project) but its close was never
      // started — stale session-log, no today log entry, no today hot row → it is
      // INVISIBLE to the today-active global status.
      { slug: 'cwd-proj', date: todayLocal(), sessionLog: false, logEntry: false, hotRow: false },
    ],
    [],
    (dir) => {
      setWorkingDir(dir, 'cwd-proj', CWD);
      // Without the cwd signal: the classic false-green. recency-proj is complete
      // and cwd-proj is invisible, so the global gate is green.
      const green = precompactGateStatus(dir, { claudeHome: join(dir, '.claude-none') });
      assert.equal(
        green.blockers.some((b) => b.type === 'close-cwd'),
        false,
        'no cwd signal → no cwd check (documents the pre-fix false-green surface)',
      );
      // The baseline must actually BE green — otherwise an unrelated blocker could
      // make both runs red while this test still "passes" (codex pre-commit CONCERN).
      assert.equal(
        green.ok,
        true,
        `baseline must be the genuine false-green: ${JSON.stringify(green.blockers)}`,
      );
      // With the authoritative session cwd: the independent check evaluates
      // cwd-proj's close, finds it incomplete, and blocks — no longer green.
      const gated = precompactGateStatus(dir, {
        claudeHome: join(dir, '.claude-none'),
        sessionCwd: CWD,
      });
      const cwdBlocker = gated.blockers.find((b) => b.type === 'close-cwd');
      assert.ok(
        cwdBlocker,
        `cwd-proj's unstarted close must block: ${JSON.stringify(gated.blockers)}`,
      );
      assert.equal(cwdBlocker.project, 'cwd-proj');
      assert.equal(gated.ok, false, 'the gate is RED once the cwd project is checked');
    },
  );
});

test('P2: close-cwd is emitted even when the cwd project is also a normal close blocker', () => {
  // The Stop hook keys its marker re-check on the close-cwd TYPE. If the cwd
  // project is today-active AND incomplete it also shows up as an ordinary `close`
  // blocker; the typed close-cwd must NOT be suppressed as a duplicate, or Stop
  // would honor a stale marker (codex pre-commit BLOCKER).
  const CWD = '/tmp/cwdproj-both';
  withClosePartitionWiki(
    // session-state stale → incomplete; session-log fresh → today-active.
    [{ slug: 'cwd-proj', date: todayLocal(), sessionState: '2000-01-01' }],
    [],
    (dir) => {
      setWorkingDir(dir, 'cwd-proj', CWD);
      const gate = precompactGateStatus(dir, {
        claudeHome: join(dir, '.claude-none'),
        sessionCwd: CWD,
      });
      assert.ok(
        gate.blockers.some((b) => b.type === 'close'),
        'the today-active incomplete project is a normal close blocker',
      );
      assert.ok(
        gate.blockers.some((b) => b.type === 'close-cwd' && b.project === 'cwd-proj'),
        'the typed close-cwd blocker is retained so Stop can key on it',
      );
    },
  );
});

test('P2: a complete cwd project close adds no blocker', () => {
  const CWD = '/tmp/cwdproj-done';
  withClosePartitionWiki([{ slug: 'cwd-proj', date: todayLocal() }], [], (dir) => {
    setWorkingDir(dir, 'cwd-proj', CWD);
    const gate = precompactGateStatus(dir, {
      claudeHome: join(dir, '.claude-none'),
      sessionCwd: CWD,
    });
    assert.equal(
      gate.blockers.some((b) => b.type === 'close-cwd'),
      false,
      'a completed cwd project close gains no new blocker',
    );
  });
});

test('P2: log-only exempts the cwd check', () => {
  const CWD = '/tmp/cwdproj-logonly';
  withClosePartitionWiki(
    [
      { slug: 'recency-proj', date: todayLocal() },
      { slug: 'cwd-proj', date: todayLocal(), sessionLog: false, logEntry: false, hotRow: false },
    ],
    [],
    (dir) => {
      setWorkingDir(dir, 'cwd-proj', CWD);
      const gate = precompactGateStatus(dir, {
        claudeHome: join(dir, '.claude-none'),
        sessionCwd: CWD,
        logOnly: true,
      });
      assert.equal(
        gate.blockers.some((b) => b.type === 'close-cwd'),
        false,
        'a non-project (log-only) session has nothing to close → cwd check is skipped',
      );
    },
  );
});

test('P2: an unmatched cwd is a notice, never a block', () => {
  withClosePartitionWiki([{ slug: 'recency-proj', date: todayLocal() }], [], (dir) => {
    const gate = precompactGateStatus(dir, {
      claudeHome: join(dir, '.claude-none'),
      sessionCwd: '/nowhere/unmatched/path',
    });
    assert.equal(
      gate.blockers.some((b) => b.type === 'close-cwd'),
      false,
      'a cwd under no project working_dir must not hard-block',
    );
    assert.ok(
      gate.notices.some((n) => n.type === 'close-cwd-unresolved'),
      'the coverage gap surfaces as a best-effort notice',
    );
  });
});

// The boundary of this fix, locked in on purpose. Close COMPLETENESS debt is now
// attributed to a session; a lint error in those same foreign close files is NOT —
// closeFileTargetsGlobal still seeds the lint scope from every today-active project,
// and W8 design-history ownership is still global. Same defect shape, tracked as
// sibling IMPRs. If a later change fixes them, this test is what should be updated
// to say so — and the fix's claim must not run ahead of it.
// Asserted on the lint SCOPE rather than on a lint blocker: whether the gate can
// actually run lint depends on the package being resolvable (it fails open and skips
// otherwise), which is an environment fact, not the coupling under test. The scope is
// the coupling — a foreign close file inside it is what a lint error there would block on.
test('IMPR-34 (boundary): the lint scope still seeds foreign close files (not yet attributed)', () => {
  const today = todayLocal();
  withClosePartitionWiki(
    [
      { slug: 'mine', date: today },
      { slug: 'foreign', date: today },
    ],
    [],
    (dir) => {
      const gate = precompactGateStatus(dir, {
        closeScope: ['mine'],
        claudeHome: join(dir, '.claude-none'),
      });
      assert.deepEqual(gate.close.scope, ['mine'], 'the CLOSE scope is attributed to this session');

      const lintScope = closeFileTargetsGlobal(dir);
      assert.ok(
        [...lintScope].some((f) => f.startsWith('projects/foreign/')),
        'but the LINT scope still seeds every today-active project, foreign included — a lint ' +
          'error there would still block, and the fix does not claim otherwise',
      );
      // Same shape for W8: design-history ownership is derived from the full
      // today-active list, which the partition deliberately leaves global.
      assert.ok(
        gate.close.projects.some((p) => p.project === 'foreign'),
        'close.projects stays global, so foreign W8 ownership is unchanged too',
      );
    },
  );
});

// Same wiki, attribution removed. If this passes, the test above proves nothing.
test('IMPR-34 (revert check): with NO attribution signal the foreign close still blocks', () => {
  withClosePartitionWiki(INCIDENT(todayLocal()), [], (dir) => {
    const gate = precompactGateStatus(dir, { claudeHome: join(dir, '.claude-none') });
    assert.equal(
      gate.blockers.some((b) => b.type === 'close'),
      true,
      'empty scope → fail closed → global block (today’s behavior, unchanged)',
    );
  });
});

test('IMPR-34: a hand-written close attributes via the transcript, not just opts', () => {
  withClosePartitionWiki(
    INCIDENT(todayLocal()),
    ['projects/mine/session-state.md'],
    (dir, transcript) => {
      const gate = precompactGateStatus(dir, {
        transcriptPath: transcript,
        claudeHome: join(dir, '.claude-none'),
      });
      assert.equal(
        gate.blockers.some((b) => b.type === 'close'),
        false,
        'editing mine’s close files puts mine (and only mine) in scope',
      );
    },
  );
});

// Over-attribution guard: touching some ordinary page under foreign/ says nothing
// about whose close is whose. If any path under projects/foreign/ counted, this
// session would be re-blocked for a close it never performed.
test('IMPR-34: a non-close file under the foreign project does NOT put it in scope', () => {
  withClosePartitionWiki(
    INCIDENT(todayLocal()),
    ['projects/mine/session-state.md', 'projects/foreign/design-history.md'],
    (dir, transcript) => {
      const gate = precompactGateStatus(dir, {
        transcriptPath: transcript,
        claudeHome: join(dir, '.claude-none'),
      });
      assert.equal(
        gate.close.scope.includes('foreign'),
        false,
        'only close files attribute a close',
      );
      assert.equal(
        gate.blockers.some((b) => b.type === 'close'),
        false,
        'so the foreign debt stays demoted',
      );
    },
  );
});

// The session's OWN incomplete close must still hard-block. This is the guard that
// keeps the partition from becoming a bypass.
test('IMPR-34: my own incomplete close blocks even while a foreign one is demoted', () => {
  const today = todayLocal();
  withClosePartitionWiki(
    [
      { slug: 'mine', date: today, sessionLog: false },
      { slug: 'foreign', date: today, logEntry: false },
    ],
    [],
    (dir) => {
      const gate = precompactGateStatus(dir, {
        closeScope: ['mine'],
        claudeHome: join(dir, '.claude-none'),
      });
      const close = gate.blockers.find((b) => b.type === 'close');
      assert.ok(close, 'mine is incomplete → close blocker');
      assert.match(close.reason, /projects\/mine\//, 'and it names MY files');
      assert.doesNotMatch(close.reason, /foreign/, 'not the foreign debt');
    },
  );
});

// "You have not closed this session at all" must never be demoted.
test('IMPR-34: the no-activity fallback still blocks unconditionally', () => {
  withClosePartitionWiki([{ slug: 'mine', date: '2020-01-01' }], [], (dir) => {
    const gate = precompactGateStatus(dir, {
      closeScope: ['mine'],
      claudeHome: join(dir, '.claude-none'),
    });
    assert.equal(gate.close.fallback, true, 'no project closed today → fallback path');
    assert.equal(
      gate.blockers.some((b) => b.type === 'close'),
      true,
      'the fallback is what forces the initial close — never partition it',
    );
  });
});

// marker == compact-ready: the marker must be attributed to a project the gate
// actually cleared, or PreCompact re-derives a scope the marker never covered.
test('IMPR-34: marker attribution comes from the close scope, not the global primary', () => {
  const today = todayLocal();
  withClosePartitionWiki(
    // `foreign` is the top hot.md row, so the global primary resolves to it while
    // its own close is incomplete. Attributing the marker to `primary` here would
    // hand PreCompact a scope that re-promotes foreign to a blocker.
    [
      { slug: 'foreign', date: today, sessionLog: false },
      { slug: 'mine', date: today },
    ],
    [],
    (dir) => {
      const gate = precompactGateStatus(dir, {
        closeScope: ['mine'],
        claudeHome: join(dir, '.claude-none'),
      });
      assert.equal(gate.close.primary, 'foreign', 'the global primary IS the foreign project');
      const scopeProject = gate.close.scope.includes(gate.close.primary)
        ? gate.close.primary
        : gate.close.scope[0];
      assert.equal(scopeProject, 'mine', 'marker must be attributed to mine, not the primary');
    },
  );
});

// The failure with NO project row to derive from. sessionCloseGlobalStatus reports
// `projects: []` + `missing: ['hot.md (no active project…)']`, so a partition that
// derived `ok` from the per-project rows unconditionally would see "nothing failed"
// and flip this red gate green. Reproduced by codex pre-commit review as a BLOCKER.
test('IMPR-34: an unresolvable active project still blocks (no rows to derive ok from)', () => {
  withSyncedWiki((dir) => {
    // withSyncedWiki's hot.md carries the Active Projects table with NO project row.
    const gate = precompactGateStatus(dir, {
      closeScope: ['whatever'],
      claudeHome: join(dir, '.claude-none'),
    });
    assert.equal(gate.close.ok, false, 'no active project → close is NOT ok');
    assert.equal(
      gate.blockers.some((b) => b.type === 'close'),
      true,
      'and it must still block — an empty projects[] is not "nothing failed"',
    );
  });
});

// The flat `project` alias names whatever the rest of the status describes. Left as
// the global primary it can name a DEMOTED project, and every consumer that renders a
// per-file checklist from it then prints ✓ for files close.debt calls missing (codex
// pre-commit CONCERN).
test('IMPR-34: close.project follows the scope, never a demoted primary', () => {
  const today = todayLocal();
  withClosePartitionWiki(
    [
      { slug: 'foreign', date: today, sessionLog: false }, // top hot.md row → global primary
      { slug: 'mine', date: today },
    ],
    [],
    (dir) => {
      const gate = precompactGateStatus(dir, {
        closeScope: ['mine'],
        claudeHome: join(dir, '.claude-none'),
      });
      assert.equal(gate.close.primary, 'foreign', 'primary is still the global pick');
      assert.equal(gate.close.project, 'mine', 'but `project` names what this status describes');
      assert.deepEqual(
        gate.close.debt.map((d) => d.project),
        ['foreign'],
        'and foreign is the demoted debt',
      );
    },
  );
});

// End to end through the CLI: the command the close checklist tells the model to trust
// must not print a per-file ✓ for a file it simultaneously reports as debt.
test('IMPR-34: --check-session-close renders demoted debt without contradicting itself', () => {
  const today = todayLocal();
  withClosePartitionWiki(
    [
      { slug: 'foreign', date: today, sessionLog: false },
      { slug: 'mine', date: today },
    ],
    ['projects/mine/session-state.md'],
    (dir, transcript, home) => {
      const r = runWithHome(
        'crystallize.mjs',
        ['--check-session-close', '--json', `--hypo-dir=${dir}`, `--transcript-path=${transcript}`],
        home,
      );
      const out = JSON.parse(r.stdout);
      assert.equal(out.project, 'mine', 'the checklist is rendered for the project in scope');
      assert.deepEqual(out.missing, [], 'flat missing carries only what blocks');
      assert.deepEqual(
        (out.close_debt || []).map((d) => d.project),
        ['foreign'],
        'the demoted close is reported as close_debt, not silently dropped',
      );
      assert.equal(out.ok, true, 'and ok never contradicts an empty missing');
    },
  );
});

// The reader that recovers the scope after a scripted close: marker.project.
test('IMPR-34: marker.project re-derives the same scope PreCompact needs', () => {
  withClosePartitionWiki(INCIDENT(todayLocal()), [], (dir) => {
    const sid = 'impr34-session';
    writeSessionClosedMarker(dir, sid, { project: 'mine' });
    const gate = precompactGateStatus(dir, {
      sessionId: sid,
      claudeHome: join(dir, '.claude-none'),
    });
    assert.ok(gate.close.scope.includes('mine'), 'the marker carries the attribution forward');
    assert.equal(
      gate.blockers.some((b) => b.type === 'close'),
      false,
      'so PreCompact reaches the same verdict the marker attested',
    );
  });
});

// --project is a "is THIS project close-complete?" diagnostic. Demoting the very
// project it named would answer a question nobody asked.
test('IMPR-34: --project override is never partitioned away', () => {
  withClosePartitionWiki(INCIDENT(todayLocal()), [], (dir) => {
    const gate = precompactGateStatus(dir, {
      projectOverride: 'foreign',
      closeScope: ['mine'],
      claudeHome: join(dir, '.claude-none'),
    });
    assert.equal(
      gate.blockers.some((b) => b.type === 'close'),
      true,
      'the named project is checked, not demoted',
    );
  });
});
