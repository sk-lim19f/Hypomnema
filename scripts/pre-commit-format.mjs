#!/usr/bin/env node
/**
 * scripts/pre-commit-format.mjs — Node-side entry for the pre-commit hook.
 *
 * Invoked by the shell shim installed at <git-dir>/hooks/pre-commit. The shim
 * already verifies HYPOMNEMA_ROOT + HYPOMNEMA_GIT_DIR; this script is the
 * second layer of identity defence and the only place that may exit nonzero
 * (only when `git add` fails on restage).
 *
 * Env discipline:
 *   - probes git twice with ambient env to learn what Git thinks the repo is
 *   - builds `cleanEnv` by stripping every name from `git rev-parse --local-env-vars`
 *     plus GIT_NAMESPACE / GIT_CEILING_DIRECTORIES / GIT_CONFIG_* (belt-and-suspenders)
 *   - validates inherited GIT_INDEX_FILE: preserve if inside HYPOMNEMA_GIT_DIR
 *     (Git exports this for commit -am / commit -- path / commit --amend);
 *     otherwise refuse — that's a foreign-index attack vector
 *   - lib spawns get `cleanEnv` only; lib never touches process.env directly
 *
 * Why dynamic import: keeping the lib import behind every guard makes the
 * fail-open story water-tight. A static import at file head would throw at
 * module load if the lib were missing or syntactically broken, before any
 * identity check could exit 0.
 *
 * Why pathToFileURL for the import: absolute filesystem paths fed to
 * `import()` break when the checkout path contains URL-significant characters
 * (#, %). pathToFileURL is the canonical Node way to bridge.
 */

try {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { pathToFileURL, fileURLToPath } = await import('node:url');

  const probe = (args, env) => execFileSync('git', args, { encoding: 'utf8', env }).trim();

  // (0) Derive expectedRoot from THIS script's filesystem location. The shell
  //     shim already verifies HYPOMNEMA_ROOT/HYPOMNEMA_GIT_DIR before exec'ing
  //     us, but a direct `node scripts/pre-commit-format.mjs` invocation with
  //     hostile GIT_DIR/GIT_WORK_TREE pointing at another repo that ALSO calls
  //     itself "hypomnema" would bypass the package.json identity check unless
  //     we anchor on the script's own location. import.meta.url cannot be
  //     redirected by ambient env.
  let expectedRoot;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    expectedRoot = fs.realpathSync(path.resolve(here, '..'));
  } catch {
    process.exit(0);
  }

  // (1) Probe with ambient env to learn what Git thinks the repo is.
  let toplevel, absGitDir, commonDir;
  try {
    toplevel = probe(['rev-parse', '--show-toplevel'], process.env);
    absGitDir = probe(['rev-parse', '--absolute-git-dir'], process.env);
    commonDir = probe(['rev-parse', '--git-common-dir'], process.env);
  } catch {
    process.exit(0);
  }

  // (2) Realpath-resolve for stable comparison.
  let absGitDirR, commonDirR, toplevelR;
  try {
    absGitDirR = fs.realpathSync(absGitDir);
    const cdAbs = path.isAbsolute(commonDir) ? commonDir : path.join(absGitDir, '..', commonDir);
    commonDirR = fs.realpathSync(cdAbs);
    toplevelR = fs.realpathSync(toplevel);
  } catch {
    process.exit(0);
  }

  // (3) Trust anchor — refuse to run against any toplevel other than this
  //     script's own checkout. Closes the GIT_DIR/GIT_WORK_TREE attack where a
  //     foreign hypomnema-named repo would otherwise pass the package.json check.
  if (toplevelR !== expectedRoot) process.exit(0);

  // (3a) Anchor the git dir to the expected location too. Without this, a
  //      mixed-env attack — GIT_DIR=/foreign/.git + GIT_WORK_TREE=expectedRoot
  //      + GIT_INDEX_FILE=/foreign/.git/index — would let `absGitDirR` point at
  //      the foreign repo while `--show-toplevel` reports expectedRoot. The
  //      subsequent GIT_INDEX_FILE check would then pass relative to the
  //      foreign git dir, and the lib would operate on a foreign index while
  //      mutating real files. (Live-verified by codex round 7.)
  let expectedGitDirR;
  try {
    expectedGitDirR = fs.realpathSync(path.join(expectedRoot, '.git'));
  } catch {
    process.exit(0);
  }
  if (absGitDirR !== expectedGitDirR) process.exit(0);

  // (4) Linked worktree → main-worktree only (documented limitation).
  if (absGitDirR !== commonDirR) process.exit(0);

  // (5) Repo identity check — package.json name must be "hypomnema" (defence in
  //     depth alongside the expectedRoot anchor above).
  const pkgPath = path.join(toplevelR, 'package.json');
  if (!fs.existsSync(pkgPath)) process.exit(0);
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    process.exit(0);
  }
  if (pkg?.name !== 'hypomnema') process.exit(0);

  // (5) Build trusted env from --local-env-vars + GIT_CONFIG_* belt.
  let localEnvList;
  try {
    localEnvList = probe(['rev-parse', '--local-env-vars'], process.env)
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    // Static fallback (Git versions where --local-env-vars is unavailable).
    localEnvList = [
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
  }
  const scrub = new Set([
    ...localEnvList,
    'GIT_NAMESPACE',
    'GIT_CEILING_DIRECTORIES',
    ...Object.keys(process.env).filter((k) => /^GIT_CONFIG_/.test(k)),
  ]);
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !scrub.has(k)));

  // (6) GIT_INDEX_FILE preservation gated on shim invocation. Git legitimately
  //     exports this for these commit shapes (verified live by codex round 5/9
  //     on Git 2.50.1):
  //       - .git/index             normal commit, commit --amend, merge commit
  //       - .git/index.lock        commit -am, commit -p, commit --interactive
  //       - .git/next-index-*.lock commit -- <pathspec>, rebase partial commit
  //     The basename whitelist used in v8/v9 had a residual gap: a crafted
  //     .git/next-index-attack.lock matches the `next-index-*` prefix even
  //     though Git itself uses `next-index-<pid>.lock` (codex round 9 live
  //     replay). Closing that prefix gap by tightening pattern just invites
  //     more attacker iteration.
  //
  //     The cleaner defence: only honour inherited GIT_INDEX_FILE when we
  //     were invoked from our own trusted shell shim (HYPOMNEMA_HOOK_INVOCATION
  //     sentinel set there). Direct invocation — which is the only path an
  //     attacker can use to plant a crafted index — drops the inherited value
  //     and lets git fall back to the default `.git/index`, i.e. the real
  //     staged set. The hook then either has nothing to do (no real stage) or
  //     formats the real stage (correct behaviour). An attacker that can also
  //     set HYPOMNEMA_HOOK_INVOCATION already has full env control and can
  //     mutate files directly without going through the hook gadget.
  const fromShim = process.env.HYPOMNEMA_HOOK_INVOCATION === '1';
  if (fromShim && process.env.GIT_INDEX_FILE) {
    // Even when trusted, sanity-check that the path lives inside our git dir.
    // Belt-and-suspenders against shim invocation with an inherited but
    // misdirected GIT_INDEX_FILE (e.g. by a wrapper that exec'd our shim).
    const inherited = process.env.GIT_INDEX_FILE;
    const lexical = path.isAbsolute(inherited) ? inherited : path.join(toplevelR, inherited);
    let absIdx;
    try {
      absIdx = fs.realpathSync(lexical);
    } catch {
      absIdx = path.resolve(lexical);
    }
    if (path.dirname(absIdx) === absGitDirR) {
      cleanEnv.GIT_INDEX_FILE = inherited;
    }
  }
  // If !fromShim, GIT_INDEX_FILE stays scrubbed → lib uses default .git/index.

  // (7) Dynamic-import the lib through a file:// URL so checkout paths with
  //     URL-significant chars (#, %) don't break ESM resolution. We import
  //     from expectedRoot, not toplevel — the script's own location is the
  //     anchor of trust.
  const libPath = path.join(expectedRoot, 'scripts/lib/pre-commit-format.mjs');
  let lib;
  try {
    lib = await import(pathToFileURL(libPath).href);
  } catch {
    process.exit(0);
  }

  const result = await lib.runPreCommitFormat({ cwd: toplevelR, env: cleanEnv });
  if (result.summary) process.stderr.write(`[pre-commit-format] ${result.summary}\n`);
  process.exit(result.gitAddFailed ? 1 : 0);
} catch {
  process.exit(0);
}
