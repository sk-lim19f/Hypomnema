/**
 * tests/helpers.mjs — fixtures shared by more than one area file.
 *
 * A fixture lands here only because two or more <area>.test.mjs files name it.
 * Anything used by exactly one area lives in that area file, so the file two
 * branches both touch stays as small as it can be.
 *
 * SESSION_TMP_HOME is built once per process and every child a test spawns
 * inherits it. Hooks read AND WRITE under ~/.claude, so a child that inherits
 * the developer's real HOME pollutes their machine and races the other shards.
 * The hypo-pkg.json seeded below is not optional: without it hypo-shared hands
 * back a null PKG_ROOT, hypo-personal-check skips lint entirely, and the gate
 * reports clean — which is how five PreCompact tests once passed while
 * asserting nothing.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = homedir();

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SCRIPTS = join(REPO, 'scripts');

const NONEXISTENT_WIKI = join(tmpdir(), `hypo-no-wiki-${process.pid}`);

// Session-wide tmp HOME: every child process launched via run() inherits this
// HOME so scripts like init.mjs cannot write to the real ~/.claude/. Tests that
// need a specific HOME use runWithHome() to override.
const SESSION_TMP_HOME = mkdtempSync(join(tmpdir(), 'hypo-session-home-'));

process.on('exit', () => {
  try {
    rmSync(SESSION_TMP_HOME, { recursive: true, force: true });
  } catch {}
});

// Seed the session HOME with the one file the hooks need to find this checkout.
// hypo-shared reads `pkgRoot` out of it and hands back null without it, and a
// null PKG_ROOT makes hypo-personal-check skip lint entirely and report a clean
// gate. Until this was written here, the file existed only as a side effect of
// whichever init.mjs test happened to have run first in the same process, so
// the PreCompact tests passed by luck of ordering: they went green under
// --shards=8 and red under --shards=12, and red on their own under --grep.
mkdirSync(join(SESSION_TMP_HOME, '.claude'), { recursive: true });

writeFileSync(
  join(SESSION_TMP_HOME, '.claude', 'hypo-pkg.json'),
  JSON.stringify({ pkgRoot: REPO }),
);

// runApply's per-process session-id counter. Declared here (not next to runApply
// itself) because tests defined earlier in the file already call runApply, and this
// file executes top to bottom — a `let` declared at its point of use is in the TDZ
// for every call site above it.
let applySeq = 0;

// ── fix-status-verify anchors (Phase 1, learned_behavior #6 half) ────────────
// These declare fixes whose status is claimed positive in wiki spec but have
// no automated test by design (behavioral rules / prompt-driven). See
// scripts/lib/fix-status-verify.mjs for the SoT contract.
//
// @fix #20: NO_AUTO_TEST
// @fix #18: NO_AUTO_TEST

// ── helpers ──────────────────────────────────────────────────────────────────

function run(script, args = []) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
  });
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTmpHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-home-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWithHome(script, args = [], home) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: home },
  });
}

// ── lib/hypo-root.mjs ────────────────────────────────────────────────────────

const { expandHome, resolveHypoRoot, resolveHypoRootInfo, checkVaultOrExit } = await import(
  `${SCRIPTS}/lib/hypo-root.mjs`
);

// ── lib/core-hooks.mjs (exit-free hooks.json loader) ─────────────────────────

const { readCoreHooksConfig, deriveCoreHookBasenames } = await import(
  `${SCRIPTS}/lib/core-hooks.mjs`
);

// ── hook contract tests ───────────────────────────────────────────────────────

const HOOKS = join(REPO, 'hooks');

const {
  isCompactCommand,
  isClearCommand,
  isCompactOrClearCommand,
  isGateSkipped,
  buildOutput,
  isClosePattern,
  extractUserMessages,
  hasUserCloseSignal,
  hasTypedUserApproval,
  hasPendingBackgroundWork,
  isCloseReconfirmDeclined,
  CLOSE_RECONFIRM_MARK,
  resolveTranscriptBySessionId,
  hasMutatingTranscriptActivity,
  isSubstantialSession,
  extractTouchedWikiFiles,
  closeFileTargets,
  closeFileTargetsGlobal,
  closeFileTargetsForProject,
  sessionCloseGlobalStatus,
  deriveRootLogEntries,
  partitionLintScope,
  sessionLogShardPath,
  sessionLogReadCandidates,
  sessionCloseFileStatus,
  hasLogEntry,
  hypoIsClean,
  precompactGateStatus,
  writeSessionClosedMarker,
  commitWikiChanges,
  syncRemote,
  isOverdueDate,
  staleMarkerFor,
  pageUsageLoggingAllowed,
  pageUsageGuardCachePath,
  recordLookupUsage,
  PAGE_USAGE_REL,
  currentDevice,
  scopeVisible,
  readVisibilityScope,
  recordTouchedPaths,
  peekTouchedPaths,
  clearTouchedPaths,
  drainTouchedPaths,
  commitTouchedPaths,
  touchedPathsPath,
  vaultCommitLockTarget,
} = await import(join(HOOKS, 'hypo-shared.mjs'));

function runHook(hookFile, stdinData, extraEnv = {}) {
  // Hermeticity invariant (mirrors run() helper, PR #30 / stage-2-#3): child hook
  // must NOT see the developer's real $HOME. Default HOME to SESSION_TMP_HOME so
  // any hook that reads ~/.claude/state/, ~/.claude/, or homedir() lands in the
  // tmp scratch dir. extraEnv may still override HOME explicitly.
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: '/tmp/nonexistent-hypo-99999',
      ...extraEnv,
    },
  });
}

// Local-date "today" matching scripts/crystallize.mjs's todayLocal(). The
// session-close fixture models files Claude writes (session-state, project
// hot.md, root hot.md, session-log, log.md) — those are user-facing wiki
// content keyed to the harness's local `currentDate`. Using toISOString()
// (UTC) here flakes in KST early morning, where the fixture stamps yesterday
// (UTC) but crystallize returns today (local). See learnings/hook-utc-date-
// vs-local-file-dates.md and fix #39.
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Build a fully session-closed wiki tree: root hot.md + log.md plus the 4
// project memory files (session-state, project hot.md, session-log) all
// carrying today's date. Mirrors the strict session-close gate (5 mandatory
// files; open-questions.md stays conditional per fix #17 / spec §5.2.7).
function buildCleanWikiTree(dir, today) {
  const ym = today.slice(0, 7);
  const projDir = join(dir, 'projects', 'test-project');
  mkdirSync(join(projDir, 'session-log'), { recursive: true });
  writeFileSync(join(dir, 'hypo-config.md'), '# config');
  writeFileSync(join(dir, 'log.md'), `## [${today}] session | test-project\n`);
  writeFileSync(
    join(dir, 'hot.md'),
    `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
      `| Project | Last Session | Hot Cache |\n|---|---|---|\n` +
      `| test-project | ${today} | [[projects/test-project/hot]] |\n`,
  );
  writeFileSync(
    join(projDir, 'session-state.md'),
    `---\ntitle: session-state\ntype: session-state\nupdated: ${today}\n---\n\n## 다음 작업\n\n- next\n`,
  );
  writeFileSync(
    join(projDir, 'hot.md'),
    `---\ntitle: hot\ntype: reference\nupdated: ${today}\n---\n\n# Hot\n`,
  );
  writeFileSync(
    join(projDir, 'session-log', `${ym}.md`),
    `---\ntitle: Session Log\ntype: session-log\nupdated: ${today}\n---\n\n## [${today}] test session\n`,
  );
}

// Build a clean wiki tree, optionally mutate it before the initial commit,
// then run `fn(dir, today)`. `mutate` runs pre-commit so tests can make a
// file stale without leaving the git tree dirty (which would block on a
// different reason).
function withWiki(mutate, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-wiki-'));
  try {
    const today = todayLocal();
    buildCleanWikiTree(dir, today);
    if (mutate) mutate(dir, today);
    spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    spawnSync('git', ['add', '-A'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8' });
    fn(dir, today);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withCleanWiki(fn) {
  withWiki(null, (dir) => fn(dir));
}

// An AskUserQuestion tool_use whose input carries the reconfirm reason's
// distinctive close-now option label ("지금 닫기") — this is how
// isCloseReconfirmDeclined correlates an answer to OUR close-reconfirm
// prompt specifically, not just any AskUserQuestion.
function askCloseReconfirmToolUse(id) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'AskUserQuestion',
          id,
          input: {
            questions: [
              { question: '지금 세션을 닫을까요?', options: ['지금 닫기', '아직, 계속'] },
            ],
          },
        },
      ],
    },
  };
}

function gitRepo(dir) {
  const opts = { cwd: dir, encoding: 'utf-8' };
  spawnSync('git', ['init', '-q'], opts);
  spawnSync('git', ['config', 'user.email', 't@t.test'], opts);
  spawnSync('git', ['config', 'user.name', 'test'], opts);
}

// The commit tip. A refusal test asserts against this rather than a clean working
// tree, because the fixture drops its own payload file into the wiki and would
// otherwise be measuring itself.
function gitHead(dir) {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).stdout.trim();
}

// Helper: build a payload that re-asserts today's already-clean state on a wiki
// produced by buildCleanWikiTree(). Used to test idempotency without changing
// any fixture content.
function payloadForCleanWiki(dir, today) {
  const ym = today.slice(0, 7);
  return {
    project: 'test-project',
    date: today,
    sessionState: {
      content: readFileSync(join(dir, 'projects', 'test-project', 'session-state.md'), 'utf-8'),
    },
    projectHot: { content: readFileSync(join(dir, 'projects', 'test-project', 'hot.md'), 'utf-8') },
    rootHot: { content: readFileSync(join(dir, 'hot.md'), 'utf-8') },
    sessionLog: { entry: `## [${today}] re-applied session\n` },
    log: { entry: `## [${today}] session | test-project — re-applied\n` },
  };
}

// Apply a close payload. A payload-bearing apply now REQUIRES close authority
// (a --session-id whose transcript carries a user close signal) BEFORE it writes
// anything, so the default here seeds exactly that: a throwaway session whose
// transcript says the user asked to close. Without it every apply test would be
// testing the refusal path instead of the thing it means to test.
//
// The refusal path has its own tests. They opt out with `sessionId: false`
// (no --session-id at all) or name an id that resolves to nothing / to a
// transcript with no close signal.
function runApply(dir, payload, { force = false, sessionId = undefined } = {}) {
  // Fix #39 (option D): payload presence = explicit close intent → always runs
  // full apply. --force only matters for the no-payload probe path, so tests
  // that supply a payload do NOT need --force.
  //
  // ISSUE-69: the payload file must live OUTSIDE the vault's own git tree.
  // commitWikiChanges no longer sweeps the whole working tree, so a stray
  // `.payload.json` left inside `dir` is no longer silently absorbed into
  // apply's commit — it would sit there as a real "uncommitted changes" git
  // blocker and fail the close gate this same apply is trying to pass.
  const payloadPath = join(
    tmpdir(),
    `hypo-payload-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`,
  );
  writeFileSync(payloadPath, JSON.stringify(payload));
  const flags = [
    `--hypo-dir=${dir}`,
    '--apply-session-close',
    `--payload=${payloadPath}`,
    '--json',
  ];
  if (force) flags.push('--force');

  // sessionId: false      → omit --session-id entirely (the refusal tests).
  // sessionId: '<id>'     → use that id AND seed an authorized transcript for it,
  //                         unless one already exists (callers that name an id do
  //                         so for marker attribution or a lockout scenario, not to
  //                         test authority).
  // sessionId: undefined  → seed a throwaway authorized session.
  // A caller testing an id that must NOT resolve seeds nothing and passes
  // `noSeed: true` via the id itself (see the transcript-unresolved tests).
  let cleanup = null;
  let id = sessionId;
  if (id === undefined) id = `apply-auth-${process.pid}-${applySeq++}`;
  if (id && !resolveTranscriptBySessionId(id, join(SESSION_TMP_HOME, '.claude', 'projects'))) {
    cleanup = seedCloseTranscript(id);
  }
  if (id) flags.push(`--session-id=${id}`);
  try {
    return run('crystallize.mjs', flags);
  } finally {
    if (cleanup) cleanup();
  }
}

function writeExt(hypoDir, type, name, content, manifest) {
  const dir = join(hypoDir, 'extensions', type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  if (manifest !== undefined) {
    const stem = name.replace(/\.[^.]+$/, '');
    writeFileSync(join(dir, `${stem}.manifest.json`), JSON.stringify(manifest, null, 2));
  }
}

// ── Lane B: formatGrowthMetrics + growth echo regressions ─────────────────

const { formatGrowthMetrics, computeSessionGrowth } = await import(join(HOOKS, 'hypo-shared.mjs'));

function withGrowthWiki(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-growth-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(
      join(dir, 'hot.md'),
      '---\ntitle: Hot\nupdated: today\n---\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n',
    );
    // Match real init (see "init creates .gitignore with .cache/ entry" above):
    // without this, a test that writes a transcript under dir/.cache/ (as the
    // auto-minimal-crystallize replay tests do) makes the tree dirty by the
    // fixture's own bookkeeping — a phantom git blocker no real session has.
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `payload` becomes the hook's stdin JSON — most Stop hooks read session_id
// off it. Defaults to `{}` (no session_id) for callers that don't care.
function runStop(hookFile, dir, payload = {}) {
  return spawnSync(process.execPath, [join(HOOKS, hookFile)], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: dir },
  });
}

// first-prompt reads its marker from os.tmpdir(), independent of HOME/HYPO_DIR.
// Tests use a unique session_id so the marker path never collides.
function markerPath(sessionId) {
  return join(tmpdir(), `hypo-session-marker-${sessionId}.json`);
}

function writeMarker(sessionId, marker) {
  writeFileSync(markerPath(sessionId), JSON.stringify({ ts: Date.now(), ...marker }));
}

function runFirstPrompt(sessionId) {
  return spawnSync(process.execPath, [join(HOOKS, 'hypo-first-prompt.mjs')], {
    input: JSON.stringify({ session_id: sessionId, prompt: 'unrelated weather question' }),
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, HYPO_DIR: '/tmp/nonexistent-hypo-99999' },
  });
}

// ── sync-state replay ───────────────────────────────────────────

// A wiki repo wired to a working bare remote and pushed in sync — the baseline
// for exercising session-start's clear/preserve logic.
function withSyncedWiki(fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-sync-'));
  const dir = join(base, 'wiki');
  const remote = join(base, 'remote.git');
  try {
    spawnSync('git', ['init', '--bare', '-q', remote]);
    spawnSync('git', ['init', '-q', dir]);
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
    writeFileSync(join(dir, 'hypo-config.md'), '# config');
    writeFileSync(
      join(dir, 'hot.md'),
      '---\ntitle: Hot\nupdated: today\n---\n## Active Projects\n\n| Project | Last Session | Hot Cache |\n|---|---|---|\n',
    );
    spawnSync('git', ['-C', dir, 'add', '-A']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    spawnSync('git', ['-C', dir, 'push', '-q', '-u', 'origin', 'HEAD']);
    fn(dir);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// Build a wiki where each project's 5 close files can be independently fresh or
// stale. `projects`: [{ slug, date, sessionState?, projectHot?, sessionLog?,
// logEntry?, hotRow? }] — each optional field defaults to `date` (fresh) and can
// be set to an old date string (or false to omit). Root hot.md rows are built
// from `hotRow ?? date`; root hot.md frontmatter `updated:` is always today.
function makeMultiProjectWiki(dir, today, projects) {
  mkdirSync(dir, { recursive: true });
  const ym = today.slice(0, 7);
  const rows = [];
  const logLines = [];
  for (const p of projects) {
    const d = p.date ?? today;
    const pdir = join(dir, 'projects', p.slug);
    mkdirSync(join(pdir, 'session-log'), { recursive: true });
    const ss = p.sessionState === false ? null : (p.sessionState ?? d);
    if (ss !== null) {
      writeFileSync(
        join(pdir, 'session-state.md'),
        `---\ntitle: ss\ntype: session-state\nupdated: ${ss}\n---\n\n## next\n`,
      );
    }
    const ph = p.projectHot === false ? null : (p.projectHot ?? d);
    if (ph !== null) {
      writeFileSync(
        join(pdir, 'hot.md'),
        `---\ntitle: hot\ntype: reference\nupdated: ${ph}\n---\n\n# Hot\n`,
      );
    }
    const slDate = p.sessionLog === false ? null : (p.sessionLog ?? d);
    if (slDate !== null) {
      writeFileSync(
        join(pdir, 'session-log', `${slDate.slice(0, 7)}.md`),
        `---\ntitle: log\ntype: session-log\nupdated: ${slDate}\n---\n\n## [${slDate}] session\n`,
      );
    } else {
      // still create the current month's file (empty of today heading) so the
      // status reports it `stale`, not `missing`.
      writeFileSync(
        join(pdir, 'session-log', `${ym}.md`),
        `---\ntitle: log\ntype: session-log\nupdated: 2000-01-01\n---\n\n## [2000-01-01] old\n`,
      );
    }
    const le = p.logEntry === false ? null : (p.logEntry ?? d);
    if (le !== null) logLines.push(`## [${le}] session | ${p.slug}`);
    const hr = p.hotRow === false ? null : (p.hotRow ?? d);
    if (hr !== null) rows.push(`| ${p.slug} | ${hr} | [[projects/${p.slug}/hot]] |`);
  }
  writeFileSync(join(dir, 'log.md'), logLines.join('\n') + '\n');
  writeFileSync(
    join(dir, 'hot.md'),
    `---\ntitle: Hot\nupdated: ${today}\n---\n# Hot\n\n## Active Projects\n\n` +
      `| Project | Last Session | Hot Cache |\n|---|---|---|\n${rows.join('\n')}\n`,
  );
}

// ── crystallize.mjs --mark-session-closed ───────────────────

// The marker hard gate (ADR 0055) resolves its evidence transcript STRICTLY from
// the session id by globbing <home>/.claude/projects/<dir>/<id>.jsonl — there is
// no path override to forge. So a test seeds the transcript where the real
// resolver will find it (the spawned crystallize runs with HOME=SESSION_TMP_HOME
// via run(), or a controlled home passed explicitly). The transcript carries a
// genuine close phrase; optional assistant tool_use lines (e.g. Edit) also drive
// the lint scope. Returns a cleanup fn. This exercises the REAL resolver, not a
// bypass.
function seedCloseTranscript(sessionId, { home = SESSION_TMP_HOME, toolUseLines = [] } = {}) {
  const projDir = join(home, '.claude', 'projects', 'hypo-test-proj');
  mkdirSync(projDir, { recursive: true });
  const p = join(projDir, `${sessionId}.jsonl`);
  writeFileSync(
    p,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '세션 마무리 해줘' } }),
      ...toolUseLines,
    ].join('\n') + '\n',
  );
  return () => rmSync(p, { force: true });
}

// ── feedback-sync.mjs (ADR 0031) ─────────────────────────────

function fbPage(fields) {
  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return `---\n${fm}\n---\nbody\n`;
}

// Build a wiki + claude-home pair, seed feedback pages, run feedback-sync.
// `pages` is { slug: fieldsObject }. Returns { dir, claudeHome, projectId, runFb(args) }.
function withFeedbackEnv(pages, fn, { claudeMd, memoryMd, projectId = 'proj' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-fb-'));
  const wiki = join(base, 'wiki');
  const claudeHome = join(base, 'claude');
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
    fn({ base, wiki, claudeHome, projectId, memDir, runFb });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const FB_GLOBAL_L1 = {
  title: 'Rule A',
  type: 'feedback',
  status: 'active',
  scope: 'global',
  tier: 'L1',
  targets: '[project-memory, claude-learned]',
  sensitivity: 'public',
  priority: 5,
  memory_summary: 'do A',
  global_summary: 'always do A',
  promote_to_global: true,
  reason: 'because A',
  source: 'session:2026-05-20',
  updated: '2026-05-20',
};

const FB_PROJECT_L2 = {
  title: 'Rule B',
  type: 'feedback',
  status: 'active',
  scope: 'project:proj',
  tier: 'L2',
  targets: '[project-memory]',
  sensitivity: 'public',
  priority: 2,
  memory_summary: 'do B',
  reason: 'because B',
  source: 'session:2026-05-19',
  updated: '2026-05-19',
};

// ── fix #49: lint W8 design-history stale emit ───────────────────────────────

const { findDesignHistoryStale } = await import(`${SCRIPTS}/lib/design-history-stale.mjs`);

function setupDhProject(root, name, { dh, sessionLogMd, sessionLogDir }) {
  const dir = join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  if (dh != null) writeFileSync(join(dir, 'design-history.md'), dh);
  if (sessionLogMd != null) writeFileSync(join(dir, 'session-log.md'), sessionLogMd);
  if (sessionLogDir) {
    const slDir = join(dir, 'session-log');
    mkdirSync(slDir, { recursive: true });
    for (const [fname, body] of Object.entries(sessionLogDir)) {
      writeFileSync(join(slDir, fname), body);
    }
  }
}

// ── pre-commit-format ────────────────────────────────────────────────────────

const {
  parseNameStatus,
  parseLsFilesStage,
  filterRegularFiles,
  partitionStagedFiles,
  selectFormatter,
} = await import(`${SCRIPTS}/lib/pre-commit-format.mjs`);

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-precommit-'));
  const git = (args, opts = {}) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', ...opts });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  return { dir, git };
}

// ── scripts/lib/fix-status-verify.mjs ────────────────────────────────────────

const {
  parseAnchors: fsvParseAnchors,
  parseStatus: fsvParseStatus,
  parseRunnerOutput: fsvParseRunnerOutput,
  verifyMatrix: fsvVerifyMatrix,
  isReferenceStub: fsvIsReferenceStub,
  validateManifest: fsvValidateManifest,
  checkManifestCoverage: fsvCheckManifestCoverage,
  checkAdrLines: fsvCheckAdrLines,
  FIX_MANIFEST: FSV_FIX_MANIFEST,
  NO_ADR: FSV_NO_ADR,
  NO_AUTO_TEST: FSV_NO_AUTO_TEST,
} = await import(`${SCRIPTS}/lib/fix-status-verify.mjs`);

const { buildCorpusSearch: fsvBuildCorpusSearch } = await import(`${SCRIPTS}/lib/adr-corpus.mjs`);

function runChecker(args, env = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'check-tracker-ids.mjs'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, ...env },
  });
}

// ── reverse extension capture (ADR 0061) ────────────────────────

const {
  isValidInstallStem,
  resolveInstallFile,
  parseExtKey,
  buildHookCommand,
  parseCapturableHookCommand,
  scanSettingsHooks,
  isValidSkillDirSegment,
  parseSkillKey,
  normalizeSkillRelPath,
  isContainedUnder,
  hasSymlinkAncestor,
  parseSkillShaValue,
} = await import(`${SCRIPTS}/lib/extensions.mjs`);

const { planCapture, isCaptureCandidate, scanHookCandidates } = await import(
  `${SCRIPTS}/capture.mjs`
);

export {
  CLOSE_RECONFIRM_MARK,
  FB_GLOBAL_L1,
  FB_PROJECT_L2,
  FSV_FIX_MANIFEST,
  FSV_NO_ADR,
  FSV_NO_AUTO_TEST,
  HOME,
  HOOKS,
  NONEXISTENT_WIKI,
  PAGE_USAGE_REL,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  applySeq,
  askCloseReconfirmToolUse,
  buildCleanWikiTree,
  buildHookCommand,
  buildOutput,
  checkVaultOrExit,
  closeFileTargets,
  closeFileTargetsForProject,
  closeFileTargetsGlobal,
  commitWikiChanges,
  computeSessionGrowth,
  currentDevice,
  deriveCoreHookBasenames,
  deriveRootLogEntries,
  expandHome,
  extractTouchedWikiFiles,
  extractUserMessages,
  fbPage,
  filterRegularFiles,
  findDesignHistoryStale,
  formatGrowthMetrics,
  fsvBuildCorpusSearch,
  fsvCheckAdrLines,
  fsvCheckManifestCoverage,
  fsvIsReferenceStub,
  fsvParseAnchors,
  fsvParseRunnerOutput,
  fsvParseStatus,
  fsvValidateManifest,
  fsvVerifyMatrix,
  gitHead,
  gitRepo,
  hasLogEntry,
  hasMutatingTranscriptActivity,
  hasPendingBackgroundWork,
  hasSymlinkAncestor,
  hasTypedUserApproval,
  hasUserCloseSignal,
  hypoIsClean,
  isCaptureCandidate,
  isClearCommand,
  isClosePattern,
  isCloseReconfirmDeclined,
  isCompactCommand,
  isCompactOrClearCommand,
  isContainedUnder,
  isGateSkipped,
  isOverdueDate,
  isSubstantialSession,
  isValidInstallStem,
  isValidSkillDirSegment,
  makeGitRepo,
  makeMultiProjectWiki,
  markerPath,
  normalizeSkillRelPath,
  pageUsageGuardCachePath,
  pageUsageLoggingAllowed,
  parseCapturableHookCommand,
  parseExtKey,
  parseLsFilesStage,
  parseNameStatus,
  parseSkillKey,
  parseSkillShaValue,
  partitionLintScope,
  partitionStagedFiles,
  payloadForCleanWiki,
  planCapture,
  precompactGateStatus,
  readCoreHooksConfig,
  readVisibilityScope,
  recordLookupUsage,
  recordTouchedPaths,
  peekTouchedPaths,
  clearTouchedPaths,
  drainTouchedPaths,
  commitTouchedPaths,
  touchedPathsPath,
  vaultCommitLockTarget,
  resolveHypoRoot,
  resolveHypoRootInfo,
  resolveInstallFile,
  resolveTranscriptBySessionId,
  run,
  runApply,
  runChecker,
  runFirstPrompt,
  runHook,
  runStop,
  runWithHome,
  scanHookCandidates,
  scanSettingsHooks,
  scopeVisible,
  seedCloseTranscript,
  selectFormatter,
  sessionCloseFileStatus,
  sessionCloseGlobalStatus,
  sessionLogReadCandidates,
  sessionLogShardPath,
  setupDhProject,
  staleMarkerFor,
  syncRemote,
  todayLocal,
  withCleanWiki,
  withFeedbackEnv,
  withGrowthWiki,
  withSyncedWiki,
  withTmpDir,
  withTmpHome,
  withWiki,
  writeExt,
  writeMarker,
  writeSessionClosedMarker,
};
