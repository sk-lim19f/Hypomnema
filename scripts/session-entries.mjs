#!/usr/bin/env node
/**
 * Hypomnema session entries CLI
 *
 * Usage:
 *   node scripts/session-entries.mjs rollback --at=<commit> [--hypo-dir=<path>]
 *   node scripts/session-entries.mjs render --project=<name> [--hypo-dir=<path>]
 *
 * rollback  Go back from session entries to the flat `hot.md` / `session-state.md` files. They are
 *           rendered from the entries as the tree of <commit> holds them (never from the working
 *           tree), tracked again, and a marker file (`.hypo-session-entries-off`) is added, all in
 *           one new commit applied with a fast-forward. Nothing under `sessions/` is deleted.
 *           A rollback that cannot be applied now is deferred: the reason is printed and the exit
 *           code is 1. Turning the entries back on is `/hypo:upgrade --migrate-sessions`.
 * render    Print the two views of one project, as the generator would write them, to stdout.
 *
 * --hypo-dir=<path> is the vault. When omitted, resolveHypoRoot() picks it (see lib/hypo-root.mjs).
 * An unknown flag or subcommand exits 2.
 */

import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  renderViews,
  GITIGNORE_BLOCK,
  PREVIOUS_GITIGNORE_BLOCKS,
  missingBlockLines,
} from '../hooks/session-entries.mjs';
import {
  SESSION_ENTRIES_OFF_MARKER,
  afterFastForward,
  buildCommitInTempIndex,
  fastForwardTo,
  listSessionProjects,
  loadSessionModel,
  loadSessionModelsAt,
  migrationState,
} from '../hooks/session-views.mjs';
import {
  currentDevice,
  revPathArg,
  vaultCommitLockTarget,
  withFileLock,
} from '../hooks/hypo-shared.mjs';
import { expandHome, resolveHypoRoot } from './lib/hypo-root.mjs';

/** What a rollback does not give back, printed after every successful one. */
export const ROLLBACK_LIMITS = [
  '지정한 커밋 뒤에 추가된 원본은 평면 파일에 들어 있지 않습니다.',
  '구버전 Hypomnema는 sessions/를 읽지 못합니다.',
  `${SESSION_ENTRIES_OFF_MARKER}가 있는 동안 새 버전 기계는 이행 전처럼 동작하므로, 같은 내용이 원본과 평면 파일에 겹쳐 보일 수 있습니다.`,
  '세션 원본을 다시 켜려면 /hypo:upgrade --migrate-sessions를 실행하세요.',
];

const gitText = (hypoDir, args) => {
  const r = spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', timeout: 30000 });
  return r.status === 0 ? r.stdout : null;
};

const deferred = (reason, detail) => ({
  rolledBack: false,
  commit: null,
  deferred: reason,
  notices: [`롤백을 미뤘습니다: ${detail ?? reason}`],
});

// `text` without the Hypomnema block (the current edition or a known earlier one), or `null` when
// the block's first line is there but the lines around it were edited, so the block cannot be cut
// out whole. A user line outside the block stays as it is. The block's `/.cache/` line goes with
// it, and the backups and records under `.cache/` must stay out of `git add -A`, so an ignore for
// the cache is put back unless the user's own lines have one.
function withoutBlock(text) {
  let out = text;
  const found = [GITIGNORE_BLOCK, ...PREVIOUS_GITIGNORE_BLOCKS].find((b) => out.includes(b));
  if (found) out = out.replace(found, '');
  else if (missingBlockLines(out, GITIGNORE_BLOCK) !== null) return null;
  const keepsCache = out
    .split('\n')
    .some((l) => ['.cache/', '/.cache/', '.cache'].includes(l.trim()));
  if (keepsCache) return out;
  return `${out}${out === '' || out.endsWith('\n') ? '' : '\n'}.cache/\n`;
}

/**
 * The rollback, for a caller that holds the vault commit lock. `at` is a commit in the history of
 * HEAD whose tree is already on the scheme. Returns `{rolledBack, commit, deferred?, notices[]}`;
 * a deferred rollback changed nothing (`fastForwardTo` takes back what it moved when the merge
 * does not happen). `testHooks` goes to `buildCommitInTempIndex` and `fastForwardTo`.
 */
export function rollbackSessionEntriesUnlocked(hypoDir, { at, testHooks, now = new Date() } = {}) {
  const state = migrationState(hypoDir);
  if (state !== 'migrated') {
    return deferred('not-migrated', `볼트가 세션 원본으로 옮겨진 상태가 아닙니다 (${state})`);
  }
  const point = gitText(hypoDir, ['rev-parse', '--verify', '--quiet', `${at}^{commit}`])?.trim();
  if (!point) return deferred('revision-unreadable', `${at}는 이 저장소의 커밋이 아닙니다`);
  const ancestor = spawnSync('git', ['-C', hypoDir, 'merge-base', '--is-ancestor', point, 'HEAD']);
  if (ancestor.status !== 0) {
    return deferred('not-in-history', `${point}는 HEAD의 이력에 없는 커밋입니다`);
  }
  const atIgnore = gitText(hypoDir, ['show', revPathArg(point, '.gitignore')]) ?? '';
  const incomplete = missingBlockLines(atIgnore, GITIGNORE_BLOCK);
  if (incomplete === null || incomplete.length) {
    return deferred(
      'at-not-migrated',
      `${point}는 아직 세션 원본으로 옮기기 전이라 렌더할 원본이 없습니다`,
    );
  }
  const headIgnore = gitText(hypoDir, ['show', revPathArg('HEAD', '.gitignore')]) ?? '';
  const cut = withoutBlock(headIgnore);
  if (cut === null) {
    return deferred(
      'block-edited',
      '.gitignore의 Hypomnema 블록이 고쳐져 있어 통째로 지우지 못했습니다. 블록을 원래대로 되돌리거나 지운 뒤 다시 시도하세요',
    );
  }

  let models;
  try {
    models = loadSessionModelsAt(hypoDir, point);
  } catch (err) {
    return deferred('tree-unreadable', err?.message);
  }
  // No device: the files are tracked, so every machine gets them, and an entry that only one
  // machine may see (`machine:` scope) must not be in them.
  const views = renderViews(models, {});
  const writes = [{ relPath: 'hot.md', text: views.root }];
  for (const { project } of models) {
    writes.push(
      { relPath: `projects/${project}/hot.md`, text: views.projects[project].hot },
      {
        relPath: `projects/${project}/session-state.md`,
        text: views.projects[project].sessionState,
      },
    );
  }
  writes.push(
    { relPath: '.gitignore', text: cut },
    {
      relPath: SESSION_ENTRIES_OFF_MARKER,
      text: `rolled back to ${point} on ${now.toISOString().slice(0, 10)}\n`,
    },
  );
  const commit = buildCommitInTempIndex(
    hypoDir,
    {
      message: `hypomnema: roll session entries back to flat files at ${point.slice(0, 12)}`,
      writes,
    },
    { testHooks },
  );
  if (!commit.ok) return deferred('commit-failed', commit.reason);

  // The commit tracks the three flat paths; `fastForwardTo` first sets aside what git would
  // overwrite without a word (the ignored generated files), backing up what this machine's
  // generator did not write.
  const applied = fastForwardTo(hypoDir, commit.sha, { testHooks });
  if (!applied.ok) {
    const reason = applied.deferred ?? applied.reason ?? 'ff-failed';
    return deferred(reason, applied.notice ?? reason);
  }
  const after = afterFastForward(hypoDir, applied.pre);
  return { rolledBack: true, commit: commit.sha, notices: after.notices };
}

/** `rollbackSessionEntriesUnlocked` under the vault commit lock; a busy lock defers. */
export function rollbackSessionEntries(hypoDir, opts = {}) {
  try {
    return withFileLock(
      vaultCommitLockTarget(hypoDir),
      () => rollbackSessionEntriesUnlocked(hypoDir, opts),
      { timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000 },
    );
  } catch (err) {
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    return deferred('lock-timeout', '다른 세션이 저장소 잠금을 쥐고 있습니다');
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: session-entries.mjs rollback --at=<commit> [--hypo-dir=<path>]\n' +
  '       session-entries.mjs render --project=<name> [--hypo-dir=<path>]';

const usageError = (msg) => {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(2);
};

function parseArgs(argv) {
  const [command, ...rest] = argv.slice(2);
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const own = { rollback: 'at', render: 'project' }[command];
  if (!own) usageError(command ? `unknown command: ${command}` : 'missing command');
  const args = { command, hypoDir: null, [own]: null };
  for (const arg of rest) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice('--hypo-dir='.length));
    // Literal per-command flags: the prompt-surface sweep reads parsed flags from the source text.
    else if (command === 'rollback' && arg.startsWith('--at=')) args.at = arg.slice('--at='.length);
    else if (command === 'render' && arg.startsWith('--project='))
      args.project = arg.slice('--project='.length);
    else usageError(`unknown option for ${command}: ${arg}`);
  }
  if (!args[own]) usageError(`${command} needs --${own}=<value>`);
  args.hypoDir ||= resolveHypoRoot();
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'render') {
    if (!listSessionProjects(args.hypoDir).includes(args.project)) {
      process.stderr.write(`no session project: ${args.project}\n`);
      process.exit(1);
    }
    const model = loadSessionModel(args.hypoDir, args.project);
    const { hot, sessionState } = renderViews([model], {
      device: currentDevice(),
      only: [args.project],
    }).projects[args.project];
    process.stdout.write(
      `==> projects/${args.project}/hot.md <==\n${hot}\n==> projects/${args.project}/session-state.md <==\n${sessionState}`,
    );
    return;
  }
  const result = rollbackSessionEntries(args.hypoDir, { at: args.at });
  for (const line of result.notices) process.stdout.write(`${line}\n`);
  if (!result.rolledBack) process.exit(1);
  process.stdout.write(`롤백했습니다: ${result.commit}\n`);
  for (const line of ROLLBACK_LIMITS) process.stdout.write(`- ${line}\n`);
}

function isMain() {
  if (!process.argv[1]) return false;
  return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
}

if (isMain()) main();
