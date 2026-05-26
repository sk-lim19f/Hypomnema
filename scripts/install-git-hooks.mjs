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

function shimBody(root, gitDir) {
  return `#!/bin/sh
# hypomnema-pre-commit-marker v1
# Fail-open at every guard. Only the .mjs (after identity checks) can exit nonzero.
set +e
HYPOMNEMA_ROOT=${shellSingleQuote(root)}
HYPOMNEMA_GIT_DIR=${shellSingleQuote(gitDir)}
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -z "$TOPLEVEL" ] && exit 0
[ "$TOPLEVEL" = "$HYPOMNEMA_ROOT" ] || exit 0
ABSGITDIR="$(git rev-parse --absolute-git-dir 2>/dev/null)" || exit 0
[ "$ABSGITDIR" = "$HYPOMNEMA_GIT_DIR" ] || exit 0
SCRIPT="$HYPOMNEMA_ROOT/scripts/pre-commit-format.mjs"
[ -f "$SCRIPT" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
# Sentinel: tells the .mjs it is running under our trusted shim (not direct
# attacker invocation). The .mjs preserves inherited GIT_INDEX_FILE only when
# this sentinel is present — direct invocation drops it and falls back to the
# default \`.git/index\`. This closes prefix-matching attacks on the index
# whitelist (e.g. attacker-crafted .git/next-index-attack.lock).
HYPOMNEMA_HOOK_INVOCATION=1 exec node "$SCRIPT"
`;
}

function writeShim(target, root, gitDir) {
  try {
    fs.writeFileSync(target, shimBody(root, gitDir), { mode: 0o755 });
    try {
      fs.chmodSync(target, 0o755);
    } catch {}
    return exitSilent(`installed pre-commit hook for ${root}`);
  } catch (e) {
    return exitSilent(`write hook failed: ${e.code || e.message}; skipping`);
  }
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

    // (7) Existing pre-commit logic.
    const target = path.join(absHooksDir, 'pre-commit');
    let existing;
    try {
      existing = fs.lstatSync(target);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return writeShim(target, expectedRoot, absGitDir);
      }
      return exitSilent(`stat target failed: ${e.code}; skipping`);
    }
    if (existing.isSymbolicLink()) {
      return exitSilent('pre-commit is symlink; not overwriting');
    }
    let head;
    try {
      head = fs.readFileSync(target, 'utf-8').split('\n').slice(0, 3).join('\n');
    } catch {
      return exitSilent('read existing pre-commit failed; skipping');
    }
    if (head.includes('hypomnema-pre-commit-marker v1')) {
      // Same marker — regenerate (refreshes embedded root if checkout moved).
      return writeShim(target, expectedRoot, absGitDir);
    }
    return exitSilent('existing non-marker pre-commit; not overwriting');
  } catch (e) {
    return exitSilent(`unexpected: ${e.code || e.message}; skipping`);
  }
}

main();
