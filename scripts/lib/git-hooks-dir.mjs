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

// ── shared install/uninstall markers ────────────────────────────────────────
// init.mjs writes these when it installs the wiki's git pre-commit hook and
// the shell rc block; uninstall.mjs reads them back to remove exactly what
// init created. Defined once here, imported by both, so the two scripts can
// never drift into recognizing different markers.
export const WIKI_PRE_COMMIT_MARKER_START = '# hypo-managed:pre-commit:start';
export const WIKI_PRE_COMMIT_MARKER_END = '# hypo-managed:pre-commit:end';
export const SHELL_MARKER_START = '# hypo-managed:shell-setup:start';
export const SHELL_MARKER_END = '# hypo-managed:shell-setup:end';

// ── marker-span validation (shared by both the writer in init.mjs and both
// removal paths in uninstall.mjs) ───────────────────────────────────────────
//
// Two independent indexOf() calls cannot tell "well-formed" apart from
// "duplicated" or "swapped": if a file happens to hold two full copies of the
// block, indexOf finds only the first END, so slicing [firstStart, firstEnd]
// leaves the second copy's install behind with no report of it. If END
// precedes START (a hand-edited or corrupted file), slicing [start, end) with
// start > end does not error, it silently duplicates whatever sits between
// them into the "removed" (or, on the writer's side, the "replaced") span.
// Neither script has a way back from either outcome, so a span is only
// trusted when both markers appear EXACTLY once and START comes before END.
function countOccurrences(content, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = content.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

export function findMarkerSpan(content, startMarker, endMarker) {
  const startCount = countOccurrences(content, startMarker);
  const endCount = countOccurrences(content, endMarker);
  if (startCount !== 1 || endCount !== 1) {
    return {
      ok: false,
      reason: `expected exactly one start and one end marker, found ${startCount} start / ${endCount} end`,
    };
  }
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (!(startIdx < endIdx)) {
    return { ok: false, reason: 'the end marker appears before the start marker' };
  }
  return { ok: true, startIdx, endIdx };
}

// ── body-shape validation (shared by both removal paths in uninstall.mjs) ──
//
// findMarkerSpan proves the span itself is well-formed. It says nothing about
// what sits INSIDE that span. A well-formed marker pair is trivial to forge
// around arbitrary content — a user's own shell function, a user's own
// pre-commit check — and codex reproduced exactly that (2026-08-27): a marker
// pair wrapped around `echo USER_OWNED_DEPLOY_CHECK` passed every prior check
// (one start, one end, start before end, a leading shebang) and got deleted
// along with the user's line, because nothing ever looked at the body text
// itself. These two functions are that missing check.
//
// The shell block is fully static — init never bakes a path into it — so its
// body can be matched byte-for-byte against SHELL_FUNCTION_BODY below. The
// pre-commit body cannot: it embeds the absolute install root, which moves
// across machines and package versions, so requiring an exact match would
// refuse to remove a hook a real (older, or differently-installed) init.mjs
// actually wrote. It is matched structurally instead — the "one or two `node
// '<path>' ... || exit 1` steps, then `exit 0`" shape — checking only that
// the referenced script is ours (ends in `/hooks/hypo-pre-commit.mjs` or
// `/scripts/lint.mjs`), not which root it lives under.
//
// Both directions of a mismatch here are unequal: failing to recognize a
// hook init actually wrote costs a re-run with --force-*; deleting a file
// that was never ours has no recovery. So an unrecognized shape is always
// treated as "not ours" and left standing, never as "close enough".

export const PRE_COMMIT_WORKER_LINE = /^node '(.+)' \|\| exit 1$/;
// The second group used to be non-capturing: nothing here needed the embedded
// --hypo-dir value, only the lint script path in group 1. parseWikiPreCommitRoot
// below now reads it back (group 2) so upgrade.mjs's self-heal can preserve the
// --hypo-dir a --lint-strict install already had baked in, rather than
// substituting this run's args.hypoDir — those two can differ (upgrade run with
// a different --hypo-dir than the one init baked in), and substituting silently
// repoints the lint gate at the wrong vault.
export const PRE_COMMIT_LINT_LINE = /^node '(.+)' --hypo-dir='(.+)' --strict \|\| exit 1$/;

// Reverses shellSingleQuote()'s escaping (a literal `'` becomes `'\''`) so the
// captured path can be compared against the suffix it must end in.
export function unescapeShellSingleQuoted(s) {
  return s.split("'\\''").join("'");
}

/**
 * @param {string} content full pre-commit hook file content
 * @param {{startIdx: number, endIdx: number}} span a `findMarkerSpan` result
 *   already confirmed `ok: true` for WIKI_PRE_COMMIT_MARKER_START/END
 * @returns {boolean} true when the text between the markers is recognizable
 *   as a body init.mjs's wikiPreCommitContent() writes
 */
export function isOwnedWikiPreCommitBody(content, span) {
  const body = content.slice(span.startIdx + WIKI_PRE_COMMIT_MARKER_START.length, span.endIdx);
  const lines = body.split('\n');
  // wikiPreCommitContent() always places a bare "\n" right after START and
  // right before END, so the first and last split segments must be empty.
  if (lines[0] !== '' || lines[lines.length - 1] !== '') return false;
  const middle = lines.slice(1, -1);
  if (middle.length < 2 || middle.length > 3 || middle[middle.length - 1] !== 'exit 0') {
    return false;
  }
  const steps = middle.slice(0, -1);
  const worker = PRE_COMMIT_WORKER_LINE.exec(steps[0]);
  if (!worker || !unescapeShellSingleQuoted(worker[1]).endsWith('/hooks/hypo-pre-commit.mjs')) {
    return false;
  }
  if (steps.length === 2) {
    const lint = PRE_COMMIT_LINT_LINE.exec(steps[1]);
    if (!lint || !unescapeShellSingleQuoted(lint[1]).endsWith('/scripts/lint.mjs')) return false;
  }
  return true;
}

// Single-quote escaping prevents shell expansion of special chars (e.g. $HOME,
// backticks) in a path baked into the hook. Shared by wikiPreCommitContent
// (init.mjs's writer, upgrade.mjs's self-heal) and, via the regexes above,
// by isOwnedWikiPreCommitBody's reader — one escaping scheme, one place.
export function shellSingleQuote(p) {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

// `root` is the DURABLE install root the hook should resolve hypo-pre-commit.mjs
// (and, when opted in, lint.mjs) through — not necessarily PKG_ROOT. In a dual
// install (a manual/npm init while the plugin is enabled) PKG_ROOT is the
// manual/npm checkout the dual-install notice tells the user to uninstall;
// embedding it here would leave the vault's git hook dangling the moment they
// do, breaking every wiki commit. Callers pass the preserved/positively-resolved
// plugin root instead, so the hook points at the install that actually persists.
//
// The block runs its steps sequentially rather than tail-calling `exit $?` on
// the first one, so a second step (the opt-in --lint-strict gate below) can
// run after the .hypoignore guard instead of being unreachable dead code.
// `lintStrict` is baked into the generated shim at install time, so toggling it
// means re-running init with/without `--lint-strict` (or upgrade repointing an
// existing install), not editing the hook by hand.
//
// `hypoDir` MUST be absolutized before it is baked in. Git runs a pre-commit
// hook with cwd set to the wiki's own working-tree root, so a relative
// `--hypo-dir` (e.g. from `hypo init --hypo-dir=wiki` run from its parent) is
// re-resolved AT COMMIT TIME against that root instead of the directory the
// caller meant — `wiki` becomes `<wiki-root>/wiki`, a path that doesn't exist,
// and lint.mjs falls through to its own default resolution (HYPO_DIR/
// hypo-config.md scan) and may silently lint an unrelated vault. `root` needs
// no such treatment: every caller has already realpath'd it upstream, so it's
// absolute at every call site.
export function wikiPreCommitContent(root, hypoDir, lintStrict) {
  const absHypoDir = resolve(hypoDir);
  const worker = join(root, 'hooks', 'hypo-pre-commit.mjs');
  const steps = [`node ${shellSingleQuote(worker)} || exit 1`];
  if (lintStrict) {
    const lintScript = join(root, 'scripts', 'lint.mjs');
    steps.push(
      `node ${shellSingleQuote(lintScript)} --hypo-dir=${shellSingleQuote(absHypoDir)} --strict || exit 1`,
    );
  }
  return `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\n${steps.join('\n')}\nexit 0\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
}

// Read the install root, --lint-strict shape, and (when present) the embedded
// --hypo-dir currently baked into a wiki's pre-commit hook, so upgrade.mjs can
// self-heal it and doctor.mjs can report when it disagrees with the active
// install — without either duplicating the body-shape rules
// isOwnedWikiPreCommitBody already enforces. Returns `{ ok: false }` for
// anything that isn't a body wikiPreCommitContent() could have written: a
// missing/duplicated marker pair, a user's own hook, or one too malformed to
// trust. `ok: true` results always carry an absolute `root` (validated by the
// `/hooks/hypo-pre-commit.mjs` suffix check below, mirroring
// isOwnedWikiPreCommitBody), a `lintStrict` flag, and `hypoDir`: the embedded
// --hypo-dir value when `lintStrict` is true, else `null` (a plain hook never
// bakes one in). The caller that repoints `root` on --apply must reuse this
// `hypoDir` verbatim rather than the CURRENT run's --hypo-dir — the two are
// not guaranteed to be the same directory.
export function parseWikiPreCommitRoot(content) {
  const span = findMarkerSpan(content, WIKI_PRE_COMMIT_MARKER_START, WIKI_PRE_COMMIT_MARKER_END);
  if (!span.ok || !isOwnedWikiPreCommitBody(content, span)) return { ok: false };
  const body = content.slice(span.startIdx + WIKI_PRE_COMMIT_MARKER_START.length, span.endIdx);
  const steps = body.split('\n').slice(1, -2); // drop leading '', trailing 'exit 0' + ''
  const worker = PRE_COMMIT_WORKER_LINE.exec(steps[0]);
  const workerPath = unescapeShellSingleQuoted(worker[1]);
  const root = workerPath.slice(0, -'/hooks/hypo-pre-commit.mjs'.length);
  const lintStrict = steps.length === 2;
  let hypoDir = null;
  if (lintStrict) {
    // isOwnedWikiPreCommitBody already confirmed steps[1] matches this shape,
    // so the exec here cannot fail.
    const lint = PRE_COMMIT_LINT_LINE.exec(steps[1]);
    hypoDir = unescapeShellSingleQuoted(lint[2]);
  }
  return { ok: true, root, lintStrict, hypoDir };
}

// The exact text init.mjs's shellFunctionBlock() writes between the shell
// markers. Exported so init.mjs builds the block FROM this constant rather
// than a second copy of the same literal — the two can then never drift the
// way independent copies of the pre-commit worker line already could not
// (see the module-level comment on the markers above).
export const SHELL_FUNCTION_BODY = `
function claude() {
  echo "{\\"cwd\\":\\"$(pwd)\\"}" | node "$HOME/.claude/hooks/hypo-session-start.mjs" > /dev/null 2>&1
  command claude "$@"
}
`;

/**
 * @param {string} content full rc file content
 * @param {{startIdx: number, endIdx: number}} span a `findMarkerSpan` result
 *   already confirmed `ok: true` for SHELL_MARKER_START/END
 * @returns {boolean} true when the text between the markers is byte-identical
 *   to what init.mjs writes
 */
export function isOwnedShellFunctionBody(content, span) {
  const body = content.slice(span.startIdx + SHELL_MARKER_START.length, span.endIdx);
  return body === SHELL_FUNCTION_BODY;
}

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
export function canonicalize(p) {
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

export function isInside(child, parent) {
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
