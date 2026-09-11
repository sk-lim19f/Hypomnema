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
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'fs';
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
// pre-commit body has TWO recognized shapes now:
//
//   - the OLD, version-pinned shape: `node '<absolute-root>/hooks/
//     hypo-pre-commit.mjs' || exit 1`. An install root baked in like this goes
//     stale every release — the plugin channel moves PKG_ROOT to a new
//     version directory on every upgrade, and nothing ever re-writes an
//     already-installed hook, so it keeps calling whatever release happened
//     to be current the day the hook was written.
//   - the NEW, runtime-resolving shape this issue introduces: `node -e
//     '<resolver script>' || exit 1`, where the resolver script (built by
//     buildPreCommitResolverJs below) looks up the install root itself, at
//     COMMIT TIME, from ~/.claude/hypo-pkg.json or the plugin registry. No
//     root is ever baked in, so there is nothing here for a release to make
//     stale.
//
// Both shapes are matched structurally, not byte-for-byte: the OLD shape by
// checking the referenced worker script ends in `/hooks/hypo-pre-commit.mjs`
// (not which root it lives under, subject to isValidOldFormRoot below) and,
// when a lint step is present, that its path is EXACTLY that same root's
// `/scripts/lint.mjs` — not merely a path ending in that suffix under some
// OTHER root, which no writer here has ever produced (codex reproduction,
// 2026-09-11 — see isOwnedWikiPreCommitBody); the NEW shape by
// reconstructing the exact resolver script buildPreCommitResolverJs would
// have produced and comparing it byte-for-byte against what is embedded (see
// isNewFormWorkerStep/isNewFormLintStep below) — loose substring matching on
// a resolver script would let a forged marker pair around arbitrary content
// through the same way a forged marker pair around a plain path once did
// (codex reproduction, 2026-08-27).
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

// The NEW, runtime-resolving shape: `node -e '<script>' || exit 1`, where
// `<script>` is shell-single-quoted the same way PRE_COMMIT_WORKER_LINE's
// path is — via shellSingleQuote() — so unescapeShellSingleQuoted() below
// recovers it the same way.
export const PRE_COMMIT_RESOLVER_LINE = /^node -e '(.+)' \|\| exit 1$/;

// Reverses shellSingleQuote()'s escaping (a literal `'` becomes `'\''`) so the
// captured path can be compared against the suffix it must end in.
export function unescapeShellSingleQuoted(s) {
  return s.split("'\\''").join("'");
}

// The two scripts a vault's pre-commit hook ever resolves through, relative to
// the install root. Shared between the OLD form's suffix checks and the NEW
// form's resolver script (buildPreCommitResolverJs), so the two can never name
// a different worker/lint path without this file itself failing to load.
const WORKER_SUFFIX = '/hooks/hypo-pre-commit.mjs';
const LINT_SUFFIX = '/scripts/lint.mjs';

// Builds the body of a `node -e '<this>'` step that resolves the Hypomnema
// install root AT COMMIT TIME instead of embedding one — the fix for the root
// this issue removes. No single quotes appear anywhere in this JS: the whole
// result is wrapped in shell single quotes by the caller (shellSingleQuote,
// same as the OLD form's path), and sh single quotes have no escape mechanism
// of their own, so a stray `'` in the FIXED part of this script would corrupt
// the surrounding shell line no matter how it were JS-escaped. Values that are
// NOT fixed (the --hypo-dir path for the lint step) are instead embedded via
// JSON.stringify and passed in through `extraArgvJs`; shellSingleQuote() is
// applied to the finished script as a whole, so any single quote inside such a
// value is escaped once, at the one place that can actually do it safely.
//
// Resolution order (must match the resolution chain commands/*.md already
// documents for resolving CLAUDE_PLUGIN_ROOT by hand):
//   1. ~/.claude/hypo-pkg.json's `pkgRoot`, but only when it is usable (see
//      below). A stale/wrong/relative pkgRoot must not be trusted just
//      because the file parses.
//   2. ~/.claude/plugins/installed_plugins.json's `hypo@hypomnema` AND the
//      legacy pre-rename `hypomnema@hypomnema` entries, searched TOGETHER as
//      one combined list: every user-scope row first, then any usable row.
//      A prior version searched `hypo@hypomnema` alone and only fell back to
//      the legacy key when that key was entirely absent, so a `hypo@hypomnema`
//      array present but full of unusable rows (a half-migrated registry)
//      hid a perfectly good `hypomnema@hypomnema` row forever (codex
//      reproduction, 2026-09-11: exit 1 with a real legacy row on disk).
//   3. Neither resolves: print what was checked and how to fix it, then exit 1.
//      A commit that silently skips the .hypoignore guard is worse than one
//      that refuses outright.
//
// A candidate root is "usable" only when it is an ABSOLUTE string, its
// `package.json` parses with a non-empty string `version`, AND
// `<root><targetSuffix>` exists. Checking existence of the target alone (the
// prior behavior) let a RELATIVE pkgRoot such as `"."` pass by resolving
// against whatever the hook's cwd happened to be at commit time (the
// vault's own working-tree root), so a vault carrying its own
// `hooks/hypo-pre-commit.mjs` was silently accepted as "the install" and its
// (attacker-controlled) contents ran instead of the real .hypoignore guard,
// letting an ignored file commit clean (codex reproduction, 2026-09-11:
// `pkgRoot: "."` + a forged `hooks/hypo-pre-commit.mjs` inside the vault
// exited 0 with `.hypoignore`'d `.env` staged). Requiring an absolute path
// closes that: a relative value can never satisfy `path.isAbsolute`, so it
// is skipped in favor of the registry, and if nothing else resolves the
// commit is refused (exit 1) rather than silently let through.
function buildPreCommitResolverJs(targetSuffix, extraArgvJs = '') {
  return (
    'var fs=require("fs"),os=require("os"),cp=require("child_process"),path=require("path");' +
    'function usable(r){' +
    'if(typeof r!=="string"||!r||!path.isAbsolute(r))return false;' +
    // name AND version. This one runs at commit time in the user's vault and
    // EXECUTES whatever it adopts, so version alone was not enough: any
    // absolute directory carrying a package.json and the target path was
    // accepted, and its script ran. The name check closes that.
    //
    // Not every root judgment here checks the name, and the difference is
    // what each one licenses. isRealOldFormInstallRoot and
    // isRewritableOldFormInstallRoot (below) and hypo-shared.mjs's sidecar
    // proof do check it — they gate deleting, rewriting, executing.
    // plugin-detect.mjs's usablePkgRoot does NOT (it answers the narrower
    // "can scripts be resolved through this pointer at all"), which is why
    // that file now also exports isHypomnemaInstallRoot, the strong form that
    // DOES check the name. Its callers split accordingly: init.mjs's
    // resolveDurableRoot and selectEntry (the registry-row picker behind
    // resolveEnabledPluginEntry) RECORD what they accept, so both moved onto
    // the strong predicate; doctor.mjs's per-row leaf-drift scan only reads
    // for display and deliberately stays on the weak one (narrowing it would
    // silence a foreign registry row doctor exists to surface). Do not cite
    // this comment as proof the name is checked everywhere; check the
    // specific predicate.
    'try{var p=JSON.parse(fs.readFileSync(r+"/package.json","utf-8"));' +
    'if(p.name!=="hypomnema")return false;' +
    'if(typeof p.version!=="string"||!p.version)return false}catch(e){return false}' +
    'try{return fs.existsSync(r+"' +
    targetSuffix +
    '")}catch(e){return false}' +
    '}' +
    'function readJson(p){try{return JSON.parse(fs.readFileSync(p,"utf-8"))}catch(e){return null}}' +
    'var home=os.homedir();var root=null;' +
    'var pkg=readJson(home+"/.claude/hypo-pkg.json");' +
    'if(pkg&&usable(pkg.pkgRoot)){root=pkg.pkgRoot}' +
    'if(!root){' +
    'var reg=readJson(home+"/.claude/plugins/installed_plugins.json");' +
    'var plugins=reg&&reg.plugins;' +
    'var arr=[];' +
    'if(plugins&&Array.isArray(plugins["hypo@hypomnema"]))arr=arr.concat(plugins["hypo@hypomnema"]);' +
    'if(plugins&&Array.isArray(plugins["hypomnema@hypomnema"]))arr=arr.concat(plugins["hypomnema@hypomnema"]);' +
    'var entry=arr.find(function(e){return e&&e.scope==="user"&&usable(e.installPath)})||' +
    'arr.find(function(e){return e&&usable(e.installPath)});' +
    'if(entry){root=entry.installPath}' +
    '}' +
    'if(!root){' +
    'console.error("hypomnema: could not resolve the install root for ' +
    targetSuffix +
    '.");' +
    'console.error("Checked ~/.claude/hypo-pkg.json (pkgRoot) and ~/.claude/plugins/installed_plugins.json (hypo@hypomnema installPath, legacy hypomnema@hypomnema).");' +
    'console.error("Fix: run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install), or reinstall Hypomnema.");' +
    'process.exit(1)' +
    '}' +
    'var r=cp.spawnSync(process.execPath,[root+"' +
    targetSuffix +
    '"' +
    extraArgvJs +
    '],{stdio:"inherit"});' +
    'if(r.error){console.error(String(r.error.message||r.error))}' +
    'process.exit(r.status===null?1:r.status)'
  );
}

// The lint step's `--hypo-dir` value is the only dynamic input to the resolver
// script. Embedding it via JSON.stringify (rather than string-concatenating it
// raw into the script) means it round-trips exactly through extractLintHypoDir
// below, including any character that would otherwise need JS escaping.
function lintExtraArgvJs(hypoDir) {
  return `,${JSON.stringify(`--hypo-dir=${hypoDir}`)},"--strict"`;
}

// Recovers the `--hypo-dir` value baked into a NEW-form lint step's resolver
// script, or null when the script does not have this exact shape. Matched
// against the literal argv array text buildPreCommitResolverJs(LINT_SUFFIX, …)
// produces — `[root+"/scripts/lint.mjs",<json-string>,"--strict"]` — so a
// script that merely CONTAINS these substrings somewhere else does not count.
function extractLintHypoDir(js) {
  const m = /\[root\+"\/scripts\/lint\.mjs",("(?:[^"\\]|\\.)*"),"--strict"\]/.exec(js);
  if (!m) return null;
  let arg;
  try {
    arg = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const prefix = '--hypo-dir=';
  return typeof arg === 'string' && arg.startsWith(prefix) ? arg.slice(prefix.length) : null;
}

// Is `step` a NEW-form worker line whose resolver script is EXACTLY the one
// buildPreCommitResolverJs(WORKER_SUFFIX) would generate? Exact comparison
// (not a substring/suffix check) because the worker step has no dynamic
// input at all — anything less than byte-identical is not a script this
// writer could have produced, and per the module comment above an
// unrecognized shape must never be treated as "close enough".
function isNewFormWorkerStep(step) {
  const m = PRE_COMMIT_RESOLVER_LINE.exec(step);
  if (!m) return false;
  return unescapeShellSingleQuoted(m[1]) === buildPreCommitResolverJs(WORKER_SUFFIX);
}

// Is `root` a real, on-disk Hypomnema install that could actually have
// produced an OLD-form worker line naming it? The suffix check on the worker
// path alone (endsWith(WORKER_SUFFIX)) proves nothing about the path BEFORE
// the suffix: any root, including one no writer in this codebase ever
// touched, satisfies it. codex reproduced this (2026-09-11): a marker pair
// wrapping `node '<arbitrary-root>/hooks/hypo-pre-commit.mjs' || exit 1`,
// where `<arbitrary-root>` was a user's own project, was accepted as "ours"
// and became eligible for upgrade.mjs's rewrite and uninstall.mjs's delete,
// neither of which this repo ever wrote. This requires the referenced root
// to be an absolute path to a package literally named "hypomnema" (the same
// producer-identity check hooks/hypo-shared.mjs applies to a cached pkgRoot)
// that still contains the worker script the line names.
//
// This is the STRICT form: a root that no longer exists on disk cannot be
// verified this way and reads as NOT ours. That is the right call for a
// DESTRUCTIVE consumer (uninstall.mjs's delete, the only caller left on this
// predicate, see isRewritableOldFormInstallRoot below for the non-destructive
// one, because deleting a hook this check cannot actually verify would be
// deleting on a guess. It is the wrong call for a REWRITE consumer: an install
// that moved or was reinstalled leaves its OLD root gone by construction, and
// refusing to rewrite there left every vault git commit failing
// `MODULE_NOT_FOUND` with no recovery path in the product (2026-09-11).
function isRealOldFormInstallRoot(root) {
  if (!isAbsolute(root) || !existsSync(join(root, WORKER_SUFFIX))) return false;
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name === 'hypomnema';
  } catch {
    return false;
  }
}

// The REWRITE-safe counterpart to isRealOldFormInstallRoot above. Rewriting an
// OLD-form hook onto the new, runtime-resolving form is non-destructive (it
// only changes what the hook calls next commit, never deletes anything), so a
// root that no longer exists is not treated as suspicious the way it is for
// deletion: it is exactly what a moved-or-reinstalled Hypomnema looks like,
// and there is nothing left at that path to impersonate. A root that DOES
// exist is still checked against package.json's name, so the forged case
// codex reproduced (a real path, but someone else's project) is rejected the
// same as above; only the "root is gone" branch differs between the two
// predicates. Keep both in sync: a change to one's package.json/name check
// almost certainly belongs in the other too.
// The first free `<hookPath>.bak`, `<hookPath>.bak.1`, `<hookPath>.bak.2`, ...
// Never overwrites an EARLIER backup: a collision there means something has
// already been preserved once, and clobbering it would defeat the entire point
// of taking a backup at all. Shared by upgrade's migration and init's
// force/marker overwrite so the two cannot disagree about what a backup is.
export function uniqueBakPath(hookPath) {
  let candidate = `${hookPath}.bak`;
  for (let n = 1; existsSync(candidate); n += 1) {
    // A symlink (or anything that is not a regular file) sitting on a backup
    // name is not a collision to route around — it is the attack the caller's
    // symlink guard exists to stop, and stepping to `.bak.1` would walk past it
    // silently while the guard then inspects the wrong path. Refuse, and let
    // the caller decline the whole write rather than overwrite the hook with
    // its backup gone somewhere unverified.
    if (unsafeHookTargetReason(candidate)) return null;
    candidate = `${hookPath}.bak.${n}`;
  }
  return unsafeHookTargetReason(candidate) ? null : candidate;
}

export function isRewritableOldFormInstallRoot(root) {
  if (!isAbsolute(root)) return false;
  if (!existsSync(root)) return true;
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name === 'hypomnema';
  } catch {
    return false;
  }
}

// Is `step` a NEW-form lint line whose resolver script is EXACTLY the one
// buildPreCommitResolverJs(LINT_SUFFIX, …) would generate for SOME --hypo-dir?
// Extracts the embedded --hypo-dir, rebuilds the expected script around it,
// and compares byte-for-byte — the only way to validate a script with one
// dynamic input without loosening the check into a substring match.
function isNewFormLintStep(step) {
  const m = PRE_COMMIT_RESOLVER_LINE.exec(step);
  if (!m) return false;
  const js = unescapeShellSingleQuoted(m[1]);
  const hypoDir = extractLintHypoDir(js);
  if (hypoDir === null) return false;
  return js === buildPreCommitResolverJs(LINT_SUFFIX, lintExtraArgvJs(hypoDir));
}

/**
 * @param {string} content full pre-commit hook file content
 * @param {{startIdx: number, endIdx: number}} span a `findMarkerSpan` result
 *   already confirmed `ok: true` for WIKI_PRE_COMMIT_MARKER_START/END
 * @param {(root: string) => boolean} [isValidOldFormRoot] which predicate
 *   decides an OLD-form worker line's root is really ours. Defaults to the
 *   STRICT one (isRealOldFormInstallRoot), the right default for the only
 *   direct caller besides parseWikiPreCommitRoot below, uninstall.mjs's
 *   delete path, where a root this check cannot verify must not be trusted.
 *   parseWikiPreCommitRoot passes the REWRITE-safe one instead, since its
 *   consumers (upgrade.mjs's migration, doctor.mjs's report) only ever read
 *   or rewrite, never delete.
 * @returns {boolean} true when the text between the markers is recognizable
 *   as a body wikiPreCommitContent() writes NOW (the runtime-resolving form)
 *   or COULD HAVE WRITTEN in an older release (the version-pinned form) — see
 *   the module comment above PRE_COMMIT_WORKER_LINE for both shapes. A body
 *   that mixes the two (one step old-form, the other new-form) is never
 *   ours: no writer this codebase has ever shipped produces that.
 */
export function isOwnedWikiPreCommitBody(
  content,
  span,
  isValidOldFormRoot = isRealOldFormInstallRoot,
) {
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

  const oldWorker = PRE_COMMIT_WORKER_LINE.exec(steps[0]);
  const oldWorkerPath = oldWorker ? unescapeShellSingleQuoted(oldWorker[1]) : null;
  const oldWorkerRoot =
    oldWorkerPath && oldWorkerPath.endsWith(WORKER_SUFFIX)
      ? oldWorkerPath.slice(0, -WORKER_SUFFIX.length)
      : null;
  const workerIsOld = oldWorkerRoot !== null && isValidOldFormRoot(oldWorkerRoot);
  const workerIsNew = isNewFormWorkerStep(steps[0]);
  if (!workerIsOld && !workerIsNew) return false;

  if (steps.length === 2) {
    if (workerIsOld) {
      const lint = PRE_COMMIT_LINT_LINE.exec(steps[1]);
      // The lint path must be EXACTLY this same root's lint script, not merely
      // END in LINT_SUFFIX — codex reproduction (2026-09-11): a marker hook
      // mixing a real Hypomnema worker path with an arbitrary user lint path
      // (also ending in /scripts/lint.mjs, just under a different root) passed
      // the old suffix-only check and was accepted as "ours", making it
      // eligible for uninstall.mjs's delete and upgrade.mjs's rewrite —
      // neither of which any writer in this codebase could have produced: the
      // legacy writer always built both lines from the SAME root, so this
      // mixed shape is not a form init.mjs's own history could leave behind,
      // and rejecting it costs nothing a real install ever had.
      if (!lint || unescapeShellSingleQuoted(lint[1]) !== oldWorkerRoot + LINT_SUFFIX) {
        return false;
      }
    } else if (!isNewFormLintStep(steps[1])) {
      return false;
    }
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

// No install root is passed in here anymore: the generated body
// resolves it itself, AT COMMIT TIME, via buildPreCommitResolverJs's lookup
// chain (~/.claude/hypo-pkg.json, then the plugin registry). That is what
// makes this immune to the failure the old, root-baking version of this
// function had — a plugin-channel upgrade moves PKG_ROOT to a new version
// directory on every release, and nothing ever re-writes an already-installed
// hook, so a baked root goes stale by construction, on a schedule the vault
// owner does not control. Dual installs (a manual/npm init while the plugin
// is enabled) no longer need special handling here either: there is no root
// to pick between "the plugin's real cache root" and "the manual/npm
// checkout" at write time, because the hook's own copy of the resolver picks
// between them itself, every time it runs.
//
// The block runs its steps sequentially rather than tail-calling `exit $?` on
// the first one, so a second step (the opt-in --lint-strict gate below) can
// run after the .hypoignore guard instead of being unreachable dead code.
// `lintStrict` is baked into the generated shim at install time, so toggling it
// means re-running init with/without `--lint-strict` (or upgrade migrating an
// existing install), not editing the hook by hand.
//
// `hypoDir` MUST be absolutized before it is baked in. Git runs a pre-commit
// hook with cwd set to the wiki's own working-tree root, so a relative
// `--hypo-dir` (e.g. from `hypo init --hypo-dir=wiki` run from its parent) is
// re-resolved AT COMMIT TIME against that root instead of the directory the
// caller meant — `wiki` becomes `<wiki-root>/wiki`, a path that doesn't exist,
// and lint.mjs falls through to its own default resolution (HYPO_DIR/
// hypo-config.md scan) and may silently lint an unrelated vault. That is a
// vault path, not an install path, so unlike the root above it never goes
// stale across a release — it only needs resolving once, here.
export function wikiPreCommitContent(hypoDir, lintStrict) {
  const absHypoDir = resolve(hypoDir);
  const steps = [`node -e ${shellSingleQuote(buildPreCommitResolverJs(WORKER_SUFFIX))} || exit 1`];
  if (lintStrict) {
    const lintJs = buildPreCommitResolverJs(LINT_SUFFIX, lintExtraArgvJs(absHypoDir));
    steps.push(`node -e ${shellSingleQuote(lintJs)} || exit 1`);
  }
  return `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\n${steps.join('\n')}\nexit 0\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
}

// Rebuilds the exact bytes an OLD-form (version-pinned) pre-commit hook holds
// for a given (root, hypoDir, lintStrict) — the shape a pre-issue release of
// this writer would have produced, and the shape parseWikiPreCommitRoot reads
// an OLD-form body back INTO. `hypoDir` is used verbatim (never re-resolved):
// callers pass the exact string parseWikiPreCommitRoot already extracted from
// the file being reconstructed, so re-resolving it here could silently paper
// over a relative value that was never valid in the first place.
//
// Exported so upgrade.mjs's applyWikiPreCommitRoot can compare a file ON DISK
// against this byte-for-byte before overwriting the WHOLE FILE with the
// migrated (new-form) content. That check exists because isOwnedWikiPreCommitBody
// only validates the SPAN between the markers, never what sits before the start
// marker or after the end one — a hand-crafted file combining a forged-but-valid
// marker span with real content outside it would pass every check up to that
// point, and an unconditional whole-file write would silently discard the
// outside content (codex reproduction, 2026-09-11). Requiring the CURRENT file
// to already equal this reconstruction proves there is nothing outside the span
// to lose before the overwrite is allowed to happen.
export function oldFormPreCommitContent(root, hypoDir, lintStrict) {
  const steps = [`node ${shellSingleQuote(root + WORKER_SUFFIX)} || exit 1`];
  if (lintStrict) {
    steps.push(
      `node ${shellSingleQuote(root + LINT_SUFFIX)} --hypo-dir=${shellSingleQuote(hypoDir)} --strict || exit 1`,
    );
  }
  return `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\n${steps.join('\n')}\nexit 0\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
}

// Read the install root (OLD form only — see below), --lint-strict shape, and
// (when present) the embedded --hypo-dir currently baked into a wiki's
// pre-commit hook, so upgrade.mjs can migrate it and doctor.mjs can report on
// it — without either duplicating the body-shape rules isOwnedWikiPreCommitBody
// already enforces. Returns `{ ok: false }` for anything that isn't a body
// wikiPreCommitContent() writes now or wrote in an older release (see the
// module comment above PRE_COMMIT_WORKER_LINE for both shapes): a
// missing/duplicated marker pair, a user's own hook, or one too malformed to
// trust.
//
// `ok: true` results always carry a `lintStrict` flag and `hypoDir` (the
// embedded --hypo-dir value when `lintStrict` is true, else `null` — a plain
// hook never bakes one in, in either form). `root` is where the two forms
// diverge: for an OLD-form body it is the absolute install root baked into the
// worker line (validated by the WORKER_SUFFIX check below, mirroring
// isOwnedWikiPreCommitBody). For a NEW-form body — the runtime-resolving
// shape this issue introduces — there is no baked root to return: the hook
// resolves it itself at commit time, so `root` is `null`. A caller must treat
// `root === null` as "already on the form that never goes stale", never as
// "root could not be determined" (that failure is `ok: false`).
//
// An OLD-form worker line is accepted here even when its root no longer
// exists on disk (isRewritableOldFormInstallRoot, not the strict
// isRealOldFormInstallRoot uninstall.mjs's delete path still uses): every
// caller of this function only reads or rewrites the hook, never deletes it,
// and a moved-or-reinstalled Hypomnema is exactly what a gone root looks like
// (2026-09-11: refusing to migrate there left every vault commit failing
// MODULE_NOT_FOUND with no in-product recovery).
//
// `ok: false` results still carry `hasMarker`: true when the content has our
// start marker at all (whatever is inside it failed to parse: a corrupted or
// hand-edited body), false when there is no marker here to begin with (not
// our hook). Callers that only care about migration can ignore it; doctor.mjs
// and upgrade.mjs use it to tell "nothing installed" apart from "installed
// but unreadable", which used to collapse into the same silent `ok: false`.
//
// The caller that migrates an OLD-form hook to the new one must reuse this
// `hypoDir` verbatim rather than the CURRENT run's --hypo-dir — the two are
// not guaranteed to be the same directory.
export function parseWikiPreCommitRoot(content) {
  const hasMarker = content.includes(WIKI_PRE_COMMIT_MARKER_START);
  const span = findMarkerSpan(content, WIKI_PRE_COMMIT_MARKER_START, WIKI_PRE_COMMIT_MARKER_END);
  if (!span.ok || !isOwnedWikiPreCommitBody(content, span, isRewritableOldFormInstallRoot)) {
    return { ok: false, hasMarker };
  }
  const body = content.slice(span.startIdx + WIKI_PRE_COMMIT_MARKER_START.length, span.endIdx);
  const steps = body.split('\n').slice(1, -2); // drop leading '', trailing 'exit 0' + ''
  const lintStrict = steps.length === 2;

  const oldWorker = PRE_COMMIT_WORKER_LINE.exec(steps[0]);
  if (oldWorker) {
    const workerPath = unescapeShellSingleQuoted(oldWorker[1]);
    const root = workerPath.slice(0, -WORKER_SUFFIX.length);
    let hypoDir = null;
    if (lintStrict) {
      // isOwnedWikiPreCommitBody already confirmed steps[1] matches this shape,
      // so the exec here cannot fail.
      const lint = PRE_COMMIT_LINT_LINE.exec(steps[1]);
      hypoDir = unescapeShellSingleQuoted(lint[2]);
    }
    return { ok: true, hasMarker: true, root, lintStrict, hypoDir };
  }

  // NEW form: isOwnedWikiPreCommitBody already confirmed steps[0] is an exact
  // resolver script and, when lintStrict, that steps[1] embeds a --hypo-dir
  // extractLintHypoDir can recover — so neither exec below needs a guard.
  let hypoDir = null;
  if (lintStrict) {
    const js = unescapeShellSingleQuoted(PRE_COMMIT_RESOLVER_LINE.exec(steps[1])[1]);
    hypoDir = extractLintHypoDir(js);
  }
  return { ok: true, hasMarker: true, root: null, lintStrict, hypoDir };
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
