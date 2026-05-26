/**
 * lib/pre-commit-format.mjs — pure logic for the auto-format-on-commit hook.
 *
 * Rule source: CLAUDE.md <formatting> directive. Pre-commit hook auto-runs the
 * project formatter on STAGED files only. Formatter failure is non-blocking;
 * only `git add` failure on restage is a true commit block.
 *
 * Why pure: lets tests construct synthetic staged sets without touching real
 * git or invoking prettier. The CLI shim in scripts/pre-commit-format.mjs
 * handles env resolution / repo-identity guards / process exit codes.
 *
 * Env discipline: every `git` spawn here MUST receive a caller-supplied `env`.
 * The lib never reads `process.env` for git operations — that defence is what
 * blocks GIT_DIR / GIT_WORK_TREE override attacks (see CONTRIBUTING.md).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const STATUS_FILTER = 'ACMR';

/**
 * Parse the NUL-token stream emitted by `git diff --cached --name-status -z`.
 *
 * Token shape (verified live against git 2.50): records are NUL-separated.
 *   A\0path\0          (added)
 *   M\0path\0          (modified)
 *   D\0path\0          (deleted — filtered out by --diff-filter)
 *   T\0path\0          (type change — filtered out)
 *   R<score>\0old\0new\0   (rename)
 *   C<score>\0old\0new\0   (copy)
 *
 * Paths containing TAB are valid — TAB is not a separator here (it appears in
 * the non-`-z` output, never in `-z`). Only NUL separates records.
 *
 * @param {string} buf  Raw stdout from `git diff --cached --name-status -z`.
 * @returns {Array<{path: string, status: string}>}
 */
export function parseNameStatus(buf) {
  const tokens = buf.split('\0');
  // Trailing NUL leaves an empty token; drop it (and any stray empties).
  while (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) continue;
    const head = status[0];
    if (head === 'R' || head === 'C') {
      // Two-path record. Old is irrelevant for formatting — only the new path
      // exists in the staged tree.
      i++; // consume old
      const next = tokens[i++];
      if (next) out.push({ path: next, status: head });
    } else if (head === 'A' || head === 'M') {
      const p = tokens[i++];
      if (p) out.push({ path: p, status: head });
    } else {
      // D, T, U, X — consume one path, drop. --diff-filter should exclude
      // these but we defensively skip.
      i++;
    }
  }
  return out;
}

/**
 * Parse `git ls-files --stage -z` output to map paths → file mode strings.
 * Output shape: `<mode> <hash> <stage>\t<path>\0`
 */
export function parseLsFilesStage(buf) {
  const map = new Map();
  const records = buf.split('\0');
  for (const rec of records) {
    if (!rec) continue;
    const tabIdx = rec.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = rec.slice(0, tabIdx);
    const path = rec.slice(tabIdx + 1);
    const mode = meta.split(' ')[0];
    map.set(path, mode);
  }
  return map;
}

/**
 * Drop symlinks (120000) and gitlinks/submodules (160000). Regular file modes
 * (100644, 100755) are kept.
 */
export function filterRegularFiles(entries, modeMap) {
  return entries.filter((e) => {
    const m = modeMap.get(e.path);
    if (!m) return false; // not in index — defensively skip
    return m !== '120000' && m !== '160000';
  });
}

/**
 * Partition staged paths into safe vs partial (also has unstaged hunks).
 * Partial files are skipped to avoid swallowing unstaged work.
 */
export function partitionStagedFiles(entries, unstagedDirty) {
  const safe = [];
  const partial = [];
  for (const e of entries) {
    if (unstagedDirty.has(e.path)) partial.push(e);
    else safe.push(e);
  }
  return { safe, partial };
}

/**
 * Formatter dispatch table. Other entries (eslint, black, gofmt, cargo fmt)
 * are placeholders — the table is data, not a branch tree. Activate by
 * filling in an entry similar to `prettier`.
 *
 * Critically: NEVER use `npx` here. `npx prettier` may try a network install
 * on a cold machine; we want a local-only binary or no-op.
 */
export function selectFormatter(repoRoot) {
  const prettierBin = join(repoRoot, 'node_modules', '.bin', 'prettier');
  if (existsSync(prettierBin)) {
    return {
      name: 'prettier',
      bin: prettierBin,
      buildArgs: (files) => ['--write', '--', ...files],
    };
  }
  return null;
}

/**
 * Run the formatter once with all safe files. Captures exit status; never
 * throws.
 */
export function formatFiles(safe, formatter, { env, cwd } = {}) {
  if (!safe.length || !formatter) {
    return { ran: false, formatterFailed: false, reason: 'noop' };
  }
  const paths = safe.map((e) => e.path);
  const res = spawnSync(formatter.bin, formatter.buildArgs(paths), {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ran: true,
    formatterFailed: res.status !== 0,
    exitCode: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

/**
 * Re-stage the formatted files. Returns `{gitAddFailed: bool, stderr}`.
 * Prettier `--write` only writes on actual content change, so re-adding
 * unchanged files is a cheap no-op. Doing it unconditionally avoids a
 * before/after hash comparison.
 */
export function restageFormatted(files, { env, cwd } = {}) {
  if (!files.length) return { gitAddFailed: false };
  const res = spawnSync('git', ['add', '--', ...files], {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    gitAddFailed: res.status !== 0,
    stderr: res.stderr || '',
  };
}

/**
 * Top-level orchestrator used by the CLI shim. The caller supplies `cwd`
 * (the Hypomnema toplevel) and a sanitized `env` (no inherited `GIT_*`
 * except optionally a validated `GIT_INDEX_FILE`).
 *
 * @returns {{gitAddFailed: boolean, summary: string}}
 */
export async function runPreCommitFormat({ cwd, env }) {
  const summary = [];
  const stagedRes = spawnSync(
    'git',
    ['diff', '--cached', '--name-status', '-z', `--diff-filter=${STATUS_FILTER}`, '--'],
    { cwd, env, encoding: 'utf-8' },
  );
  if (stagedRes.status !== 0) {
    return { gitAddFailed: false, summary: 'git diff --cached failed; skipping' };
  }
  const staged = parseNameStatus(stagedRes.stdout || '');
  if (!staged.length) return { gitAddFailed: false, summary: 'no staged files' };

  // Filter out symlinks / submodules.
  const lsRes = spawnSync(
    'git',
    ['ls-files', '--stage', '-z', '--', ...staged.map((e) => e.path)],
    { cwd, env, encoding: 'utf-8' },
  );
  let regular = staged;
  if (lsRes.status === 0) {
    const modeMap = parseLsFilesStage(lsRes.stdout || '');
    regular = filterRegularFiles(staged, modeMap);
  }
  if (!regular.length) return { gitAddFailed: false, summary: 'no regular staged files' };

  // Unstaged-dirty set for partition.
  const unstRes = spawnSync('git', ['diff', '--name-only', '-z', '--'], {
    cwd,
    env,
    encoding: 'utf-8',
  });
  const unstaged = new Set();
  if (unstRes.status === 0) {
    for (const p of (unstRes.stdout || '').split('\0')) {
      if (p) unstaged.add(p);
    }
  }
  const { safe, partial } = partitionStagedFiles(regular, unstaged);
  if (partial.length) {
    summary.push(`skipped ${partial.length} partially-staged file(s)`);
  }
  if (!safe.length) return { gitAddFailed: false, summary: summary.join('; ') || 'no safe files' };

  const formatter = selectFormatter(cwd);
  if (!formatter) {
    return {
      gitAddFailed: false,
      summary: [...summary, 'no formatter (node_modules/.bin/prettier missing)'].join('; '),
    };
  }
  const fmt = formatFiles(safe, formatter, { env, cwd });
  if (fmt.formatterFailed) {
    summary.push(`${formatter.name} exit ${fmt.exitCode} (non-blocking)`);
    return { gitAddFailed: false, summary: summary.join('; ') };
  }
  const restage = restageFormatted(
    safe.map((e) => e.path),
    { env, cwd },
  );
  if (restage.gitAddFailed) {
    return {
      gitAddFailed: true,
      summary: `git add failed: ${restage.stderr.trim()}`,
    };
  }
  summary.push(`formatted ${safe.length} file(s) via ${formatter.name}`);
  return { gitAddFailed: false, summary: summary.join('; ') };
}
