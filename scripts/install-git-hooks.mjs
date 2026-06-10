#!/usr/bin/env node
/**
 * scripts/install-git-hooks.mjs — idempotent git pre-commit hook installer.
 *
 * Wired into package.json as the `prepare` script so it runs after every
 * `npm install` / `npm ci` in this checkout. The installer is FULLY fail-open:
 * any filesystem or git error → silent exit 0. The CLAUDE.md formatter rule
 * is best-effort; a failed install must never block contributor onboarding.
 *
 * Trust model:
 *   - `expectedRoot` is derived from THIS script's filesystem location (via
 *     `import.meta.url` → realpath), NOT from `git rev-parse`. Git probes
 *     can be redirected by ambient GIT_DIR/GIT_WORK_TREE; the script's own
 *     path cannot.
 *   - All git probes use a scrubbed env (every name from `--local-env-vars`
 *     plus GIT_NAMESPACE / GIT_CEILING_DIRECTORIES / GIT_CONFIG_*).
 *   - Probes run with `cwd: expectedRoot` so npm `--prefix` invocations
 *     can't redirect resolution either.
 *   - Generated shim embeds `HYPOMNEMA_ROOT` + `HYPOMNEMA_GIT_DIR`. Runtime
 *     shim refuses to exec unless both literals match the current values.
 *
 * Refusal conditions (all exit 0):
 *   - `CI=true` env (npm ci on CI runs prepare; we must not touch hooks)
 *   - `npm_command` in {pack, publish} or `npm_lifecycle_event=prepublishOnly`
 *   - `.git/` absent (consumer install of the published tarball)
 *   - linked worktree (--absolute-git-dir != --git-common-dir)
 *   - toplevel != expectedRoot
 *   - hooks dir / pre-commit file is a symlink
 *   - existing non-marker pre-commit (don't clobber the user's own hook)
 *   - any filesystem error (ENOENT, EPERM, EACCES, …)
 *
 * Verbose mode: set HYPOMNEMA_HOOK_VERBOSE=1 to see skip/install reasons.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function exitSilent(msg) {
  if (process.env.HYPOMNEMA_HOOK_VERBOSE === '1') {
    process.stderr.write(`[install-git-hooks] ${msg}\n`);
  }
  process.exit(0);
}

// Static fallback list for `--local-env-vars`. Used when we don't yet have a
// trusted git invocation (the installer is bootstrapping its own trust chain),
// and also when git is too old to support `--local-env-vars`.
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
    ...Object.keys(process.env).filter((k) => /^GIT_CONFIG_/.test(k)),
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !scrub.has(k)));
}

function shellSingleQuote(s) {
  // POSIX-safe: 'x' → 'x', x'y → 'x'\''y'
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

// Hook-specific gate body. Runs AFTER the shared identity guards, so everything
// here is already proven to be our trusted checkout. `set +e` is active, so the
// gate must explicitly `|| exit 1` to BLOCK a commit; a missing script is a
// fail-open skip (old checkout that predates the script).
function gateLines(kind) {
  // CHECK_TRACKER_ROOT is a test-only seam in check-tracker-ids.mjs. Clear any
  // inherited value so the real hook always gates THIS checkout's index, never a
  // redirected one.
  const unsetSeam = 'unset CHECK_TRACKER_ROOT';
  if (kind === 'pre-commit') {
    // 1) Auto-format staged files (its own exit 1 = a true git-add failure block).
    //    The sentinel tells pre-commit-format.mjs it runs under the trusted shim,
    //    so it preserves an inherited GIT_INDEX_FILE (index-whitelist defence).
    // 2) Tracker-id gate on the staged blobs — blocks the commit on a leak.
    return `${unsetSeam}
FMT="$HYPOMNEMA_ROOT/scripts/pre-commit-format.mjs"
[ -f "$FMT" ] && { HYPOMNEMA_HOOK_INVOCATION=1 node "$FMT" || exit 1; }
TRK="$HYPOMNEMA_ROOT/scripts/check-tracker-ids.mjs"
[ -f "$TRK" ] && { node "$TRK" --staged || exit 1; }
exit 0`;
  }
  // commit-msg: scan the message file (passed as $1) for wiki tracker ids.
  return `${unsetSeam}
TRK="$HYPOMNEMA_ROOT/scripts/check-tracker-ids.mjs"
[ -f "$TRK" ] || exit 0
node "$TRK" --commit-msg "$1" || exit 1
exit 0`;
}

function shimBody(kind, root, gitDir) {
  return `#!/bin/sh
# hypomnema-${kind}-marker v2
# Fail-open at every identity/setup guard. Only the gate below can exit nonzero.
set +e
HYPOMNEMA_ROOT=${shellSingleQuote(root)}
HYPOMNEMA_GIT_DIR=${shellSingleQuote(gitDir)}
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$TOPLEVEL" ] && exit 0
[ "$TOPLEVEL" = "$HYPOMNEMA_ROOT" ] || exit 0
ABSGITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
[ "$ABSGITDIR" = "$HYPOMNEMA_GIT_DIR" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
${gateLines(kind)}
`;
}

// Write a single hook shim. Returns true on success, false on write failure.
// Does NOT exit — the caller installs multiple hooks and reports once.
function writeShim(target, kind, root, gitDir) {
  try {
    fs.writeFileSync(target, shimBody(kind, root, gitDir), { mode: 0o755 });
    try {
      fs.chmodSync(target, 0o755);
    } catch {}
    return true;
  } catch {
    return false;
  }
}

// Install/refresh one hook of the given kind under absHooksDir. Returns a short
// status string (never throws, never exits). Refreshes our own marker (any
// version) so a checkout move or a shim-body change re-propagates; never
// clobbers a user's own non-marker hook or a symlink.
function installHook(kind, absHooksDir, root, gitDir) {
  const target = path.join(absHooksDir, kind);
  let existing;
  try {
    existing = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') {
      return writeShim(target, kind, root, gitDir) ? `installed ${kind}` : `write ${kind} failed`;
    }
    return `stat ${kind} failed: ${e.code}`;
  }
  if (existing.isSymbolicLink()) return `${kind} is symlink; not overwriting`;
  let head;
  try {
    head = fs.readFileSync(target, 'utf-8').split('\n').slice(0, 3).join('\n');
  } catch {
    return `read ${kind} failed; skipping`;
  }
  if (head.includes(`hypomnema-${kind}-marker`)) {
    return writeShim(target, kind, root, gitDir) ? `refreshed ${kind}` : `refresh ${kind} failed`;
  }
  return `existing non-marker ${kind}; not overwriting`;
}

async function main() {
  try {
    // (0) CI / lifecycle guards.
    if (process.env.CI === 'true') return exitSilent('CI=true; skipping');
    const lc = process.env.npm_command;
    if (lc === 'pack' || lc === 'publish') {
      return exitSilent(`npm_command=${lc}; skipping`);
    }
    if (process.env.npm_lifecycle_event === 'prepublishOnly') {
      return exitSilent('prepublishOnly; skipping');
    }

    // (1) Derive expectedRoot from THIS script's location, not from git.
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    let expectedRoot;
    try {
      expectedRoot = fs.realpathSync(path.resolve(here, '..'));
    } catch {
      return exitSilent('cannot resolve script location; skipping');
    }

    // (2) Bootstrap scrubbed env with the static fallback list, just enough to
    //     get a trusted git probe running. Then enrich from --local-env-vars at
    //     runtime (modern git) so the scrub list always tracks git's own truth.
    let cleanEnv = buildScrubbedEnv(null);
    let run = (args) =>
      execFileSync('git', args, {
        encoding: 'utf-8',
        env: cleanEnv,
        cwd: expectedRoot,
      }).trim();
    try {
      const list = run(['rev-parse', '--local-env-vars']).split(/\r?\n/).filter(Boolean);
      cleanEnv = buildScrubbedEnv(list);
      run = (args) =>
        execFileSync('git', args, {
          encoding: 'utf-8',
          env: cleanEnv,
          cwd: expectedRoot,
        }).trim();
    } catch {
      // Old git without --local-env-vars; keep static-list cleanEnv.
    }

    // (3) Probe git with sanitized env.
    let topR, absGitDir, commonDir;
    try {
      topR = fs.realpathSync(run(['rev-parse', '--show-toplevel']));
      absGitDir = fs.realpathSync(run(['rev-parse', '--absolute-git-dir']));
      const cd = run(['rev-parse', '--git-common-dir']);
      commonDir = fs.realpathSync(path.isAbsolute(cd) ? cd : path.join(absGitDir, '..', cd));
    } catch {
      return exitSilent('git probe failed; skipping');
    }

    // (4) Identity + worktree + containment.
    if (topR !== expectedRoot) {
      return exitSilent('toplevel != expectedRoot; skipping');
    }
    if (absGitDir !== commonDir) {
      return exitSilent('linked worktree; skipping');
    }
    if (!absGitDir.startsWith(expectedRoot + path.sep)) {
      return exitSilent('gitDir outside expectedRoot; skipping');
    }

    // (5) Resolve hooks dir (still under sanitized env).
    let rawHooksDir;
    try {
      rawHooksDir = run(['rev-parse', '--git-path', 'hooks']);
    } catch {
      return exitSilent('cannot resolve hooks dir; skipping');
    }
    if (!path.isAbsolute(rawHooksDir)) {
      rawHooksDir = path.resolve(expectedRoot, rawHooksDir);
    }

    if (!fs.existsSync(rawHooksDir)) {
      // Git creates .git/hooks lazily. Only create when it would land inside
      // absGitDir — protects against `core.hooksPath=/elsewhere`.
      if (!rawHooksDir.startsWith(absGitDir + path.sep)) {
        return exitSilent('hooks dir outside gitDir; skipping');
      }
      try {
        fs.mkdirSync(rawHooksDir, { recursive: true });
      } catch {
        return exitSilent('mkdir hooks dir failed; skipping');
      }
    }

    let absHooksDir;
    try {
      absHooksDir = fs.realpathSync(rawHooksDir);
    } catch {
      return exitSilent('realpath hooks dir failed; skipping');
    }

    // (6) Symlink rejection + containment.
    try {
      if (fs.lstatSync(rawHooksDir).isSymbolicLink()) {
        return exitSilent('hooks dir is symlink; skipping');
      }
    } catch {
      return exitSilent('lstat hooks dir failed; skipping');
    }
    const rel = path.relative(absGitDir, absHooksDir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return exitSilent('hooks dir outside .git/; skipping');
    }

    // (7) Install both hooks: pre-commit (format + tracker-id gate on staged
    //     blobs) and commit-msg (tracker-id gate on the message). Each is
    //     independently marker-detected so a user's own hook is never clobbered.
    const results = [
      installHook('pre-commit', absHooksDir, expectedRoot, absGitDir),
      installHook('commit-msg', absHooksDir, expectedRoot, absGitDir),
    ];
    return exitSilent(results.join('; '));
  } catch (e) {
    return exitSilent(`unexpected: ${e.code || e.message}; skipping`);
  }
}

main();
