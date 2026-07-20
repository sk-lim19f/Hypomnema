/**
 * Resolve a repository's active git hooks directory by asking git, never by
 * assuming the on-disk layout.
 *
 * The layout assumption this replaces (`join(root, '.git', 'hooks')`) is wrong
 * in two ways that both showed up in practice:
 *
 *   1. In a linked worktree `.git` is a regular FILE holding `gitdir: <path>`,
 *      so `existsSync` passes and `mkdirSync` dies with ENOTDIR.
 *   2. When `core.hooksPath` is set, git does not read `.git/hooks` at all, so
 *      a hook written there is inert.
 *
 * `git rev-parse --git-path hooks` handles both: it follows the worktree's
 * gitdir pointer AND substitutes `core.hooksPath` (verified on git 2.50.1 —
 * `/dev/null` stays `/dev/null`, a relative value stays relative, and `~` is
 * expanded). That makes rev-parse the single authority here; reading
 * `core.hooksPath` out of the config ourselves would be strictly worse, since
 * it would leave `~` unexpanded and could not tell an empty-but-set value from
 * an unset one.
 *
 * Two things rev-parse does NOT give us, so we add them:
 *
 *   - `git -C <root>` does not neutralize ambient git environment variables.
 *     `GIT_DIR` + `GIT_WORK_TREE` redirect the probe at a foreign repository,
 *     and `GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS` redirect it at an
 *     arbitrary hooks path. Every probe therefore runs under a scrubbed env,
 *     with the scrub list taken from git's own `--local-env-vars` when
 *     available.
 *   - `core.hooksPath` may point at a directory SHARED by many repositories
 *     (the documented centralized-hooks pattern). Auto-installing there would
 *     put our hook in front of unrelated repositories' commits, and our
 *     post-commit executes `$REPO_ROOT/scripts/upgrade.mjs` dynamically. So the
 *     result carries an `owned` flag, and callers that WRITE must refuse when
 *     it is false. Callers that only READ (doctor) may report the path.
 */

import { execFileSync } from 'child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path';

// Fallback scrub list for git versions without `rev-parse --local-env-vars`.
// Mirrors scripts/install-git-hooks.mjs, which established this trust model.
const STATIC_LOCAL_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_PREFIX',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
];

function buildScrubbedEnv(localEnvList) {
  const scrub = new Set([
    ...(localEnvList || STATIC_LOCAL_ENV_VARS),
    'GIT_NAMESPACE',
    'GIT_CEILING_DIRECTORIES',
    // GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n inject config
    // wholesale and are not always listed by --local-env-vars.
    ...Object.keys(process.env).filter((k) => /^GIT_CONFIG_/.test(k)),
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !scrub.has(k)));
}

// Canonicalize a path that may not exist yet: realpath the deepest existing
// ancestor and re-append the rest. Without this, a hooks dir git will create
// lazily could evade the containment check via an unresolved symlinked parent.
function canonicalize(p) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p); // hit the root; nothing to resolve
      // basename, not a slice: when the parent IS the root it already ends in a
      // separator, so `parent.length + 1` would eat the first real character
      // ("/Nope/x" -> "ope/x") and could rewrite an external path into one that
      // looks repository-owned.
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * @param {string} repoRoot        working tree root to probe
 * @param {{timeoutMs?: number}} [opts]
 * @returns {{ok: true, path: string, owned: boolean, gitDir: string, commonDir: string}
 *          |{ok: false, reason: string, detail?: string, path?: string}}
 *
 * Failure reasons are deliberately distinct so callers can react differently:
 *   not-a-repo        no `.git` entry (also the case for a bare repo — matches
 *                     the pre-existing behavior of every call site)
 *   git-unavailable   git is not on PATH / not executable
 *   probe-failed      git ran but could not resolve the repo (stale `.git`
 *                     pointer, dubious ownership, timeout, ...)
 *   hooks-disabled    the active hooks path is `/dev/null` or an existing
 *                     non-directory — git's documented way to disable hooks
 */
export function resolveGitHooksDir(repoRoot, { timeoutMs = 5000 } = {}) {
  if (!existsSync(join(repoRoot, '.git'))) return { ok: false, reason: 'not-a-repo' };

  let env = buildScrubbedEnv(null);
  const run = (args) =>
    execFileSync('git', args, {
      encoding: 'utf-8',
      env,
      cwd: repoRoot,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }).trim();

  try {
    // Enrich the scrub list from git's own truth when this git supports it.
    try {
      env = buildScrubbedEnv(run(['rev-parse', '--local-env-vars']).split(/\r?\n/).filter(Boolean));
    } catch {
      // Old git without --local-env-vars; the static list already applied.
    }

    const gitDir = canonicalize(run(['rev-parse', '--absolute-git-dir']));
    const rawCommon = run(['rev-parse', '--git-common-dir']);
    // A relative --git-common-dir is relative to the command's cwd, which we
    // pinned to repoRoot.
    const commonDir = canonicalize(isAbsolute(rawCommon) ? rawCommon : join(repoRoot, rawCommon));
    const topLevel = canonicalize(run(['rev-parse', '--show-toplevel']));

    // --path-format is git 2.31+. Fall back to the plain form, whose output is
    // relative to cwd (= repoRoot) when core.hooksPath is relative.
    let raw;
    try {
      raw = run(['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
    } catch {
      raw = run(['rev-parse', '--git-path', 'hooks']);
    }
    if (!raw) return { ok: false, reason: 'probe-failed', detail: 'empty hooks path' };

    const hooksPath = canonicalize(isAbsolute(raw) ? raw : join(repoRoot, raw));

    // git documents core.hooksPath=/dev/null as "disable all hooks". Treat any
    // existing non-directory the same way rather than failing on mkdir later.
    if (existsSync(hooksPath) && !statSync(hooksPath).isDirectory()) {
      return { ok: false, reason: 'hooks-disabled', path: hooksPath };
    }

    // Repository-owned means: inside this repo's git directory (the normal
    // `.git/hooks`, and in a linked worktree the shared common dir) or inside
    // the working tree itself (the `core.hooksPath=.githooks` convention).
    // Anything else is a location we do not own and must not write into.
    const owned =
      isInside(hooksPath, commonDir) ||
      isInside(hooksPath, gitDir) ||
      isInside(hooksPath, topLevel);

    return { ok: true, path: hooksPath, owned, gitDir, commonDir };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'git-unavailable' };
    return { ok: false, reason: 'probe-failed', detail: e && (e.code || e.message) };
  }
}

/**
 * Guard the final hook ENTRY, not just the directory it lives in.
 *
 * An owned hooks directory can still contain a symlink pointing anywhere, and
 * `writeFileSync` follows symlinks. Three ways that escapes the boundary the
 * directory check appears to establish:
 *   - a live symlink to an external file gets its TARGET overwritten;
 *   - if that target happens to carry our managed marker, it is rewritten even
 *     without --force-commands;
 *   - a DANGLING symlink reads as absent through `existsSync`, so the "not
 *     installed yet" path creates the external target outright.
 * So refuse to write through any symlink, and refuse anything that is not a
 * regular file. Callers log the reason and move on.
 *
 * @returns {null | string} null when writing is safe, else a reason to log
 */
export function unsafeHookTargetReason(hookPath) {
  let st;
  try {
    st = lstatSync(hookPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null; // genuinely absent — safe to create
    return `cannot stat (${e.code || e.message})`;
  }
  if (st.isSymbolicLink()) return 'is a symlink — refusing to write through it';
  if (!st.isFile()) return 'exists but is not a regular file';
  return null;
}

/**
 * Write-side wrapper: the hooks directory only if it is safe to install into.
 * Returns `{dir}` when installing is allowed, otherwise `{skip}` carrying a
 * human-readable reason for the caller to log.
 */
export function hooksDirForInstall(repoRoot, opts) {
  const r = resolveGitHooksDir(repoRoot, opts);
  if (!r.ok) {
    if (r.reason === 'not-a-repo') return { skip: null }; // silent, as before
    if (r.reason === 'hooks-disabled') {
      // Do not name core.hooksPath here: the same branch fires for a plain
      // .git/hooks that happens to be a regular file, where no such setting
      // exists and naming it would send the user hunting for a phantom config.
      return { skip: `hooks path is not a directory, so git runs no hooks (${r.path})` };
    }
    if (r.reason === 'git-unavailable') return { skip: 'git not available on PATH' };
    return { skip: `could not resolve hooks dir (${r.detail || r.reason})` };
  }
  if (!r.owned) {
    return {
      skip: `core.hooksPath points outside this repository (${r.path}) — refusing to install into a shared hooks directory`,
    };
  }
  return { dir: r.path };
}
