// Detect whether the Hypomnema Claude Code plugin is enabled in a settings.json.
//
// Dual-install guard: the manual/npm `upgrade.mjs` must know when the
// plugin is ALSO enabled, because the plugin loader already provides the core
// hooks/commands/settings — copying+registering them from a manual/npm `--apply`
// would double-register every hook.
//
// This parser is INTENTIONALLY conservative. The asymmetric cost is: a false
// positive blocks/alters a legitimate npm-only user's upgrade, which is worse
// than the rare dual-install double-register it guards against. So it fails open
// (returns false) on every uncertainty and only fires on an exact, well-formed
// `enabledPlugins` entry whose plugin name is precisely `hypo` (the current
// plugin name) or `hypomnema` (the legacy name, pre-rename). Both are matched so
// the guard survives the rename's migration window: an existing user keeps the
// legacy `hypomnema@<marketplace>` key in `enabledPlugins` until they reinstall
// as `hypo@<marketplace>`, and the guard must hold across that gap.

import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * @param {string} settingsPath  path to a Claude Code settings.json (e.g. ~/.claude/settings.json)
 * @returns {boolean} true iff `enabledPlugins` contains a key shaped
 *   `hypo@<marketplace>` (or the legacy `hypomnema@<marketplace>`) whose value
 *   is strictly `true`.
 */
export function isHypomnemaPluginEnabled(settingsPath) {
  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch {
    return false; // missing / unreadable → cannot prove enabled → fail open
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // corrupt JSON → fail open
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  return enabledKeyFrom(parsed.enabledPlugins) !== null;
}

// The exact enabledPlugins KEY (`hypo@<marketplace>` / legacy
// `hypomnema@<marketplace>`) whose value is strictly true, or null. Same matching
// rules as isHypomnemaPluginEnabled, but returns the identifier so a caller can
// look that exact plugin up in the install registry rather than guessing among all
// hypo-named entries.
function enabledKeyFrom(enabled) {
  // enabledPlugins is an object map `{ "<name>@<marketplace>": true|false }`.
  // Anything else (absent, array, scalar) → not enabled.
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return null;
  for (const [key, value] of Object.entries(enabled)) {
    if (value !== true) continue; // strictly true only — no truthy coercion
    // Require a real `name@marketplace` shape: an `@` that is neither the first
    // nor the last char. A bare `"hypo": true` / `"hypomnema": true` (no
    // marketplace) must NOT trigger — that is not a valid enabledPlugins
    // identifier.
    const at = key.indexOf('@');
    if (at <= 0 || at === key.length - 1) continue;
    const name = key.slice(0, at);
    // Match the current plugin name and the legacy one (pre-rename) so the
    // guard holds across the migration window. Exact, case-sensitive.
    if (name === 'hypo' || name === 'hypomnema') return key;
  }
  return null;
}

/**
 * @param {string} settingsPath  path to a Claude Code settings.json
 * @returns {string|null} the exact `enabledPlugins` key of the enabled Hypomnema
 *   plugin (`hypo@<marketplace>` or legacy `hypomnema@<marketplace>`), or null.
 */
export function enabledHypomnemaPluginKey(settingsPath) {
  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return enabledKeyFrom(parsed.enabledPlugins);
}

function readPkgVersionAt(root) {
  try {
    const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// A pkgRoot is "usable" as a DURABLE install root only if it is an ABSOLUTE path to
// a real package directory whose package.json carries a version. A relative path
// (e.g. installPath ".") would be resolved against the caller's cwd and break the
// vault git hook from any other directory; a version-less package.json cannot be
// attributed a version without lying. A bare path that merely exists is a pointer
// the runtime cannot resolve scripts through. Shared by init's registry resolution,
// its durable-root fallback, and upgrade's dualSkip provenance correction so they
// all agree on what is real.
export function usablePkgRoot(pkgRoot) {
  return (
    typeof pkgRoot === 'string' &&
    pkgRoot.length > 0 &&
    isAbsolute(pkgRoot) &&
    existsSync(join(pkgRoot, 'package.json')) &&
    readPkgVersionAt(pkgRoot) !== null
  );
}

// The version-shaped leaf of a plugin cache path (its last path component), or
// null when that leaf does not look like a version. Claude Code names a plugin
// cache directory after the release it copied in (`cache/<marketplace>/<name>/
// <version>/`, per the plugin-channel invariant in this repo's CLAUDE.md), but
// not every usable install root is shaped that way (a dev checkout or an npm
// global root has no version-named leaf), so this returns null rather than
// forcing a comparison that would misfire on those.
function cacheLeafVersion(pkgRoot) {
  if (typeof pkgRoot !== 'string' || !pkgRoot) return null;
  const leaf = pkgRoot.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  // Anchored at BOTH ends. Unanchored at the end, a directory that merely starts
  // with a version ("1.7.4-hypomnema-backup") reads as version-shaped, and its
  // package.json version can never equal the whole leaf string, so a healthy root
  // reports drift forever. Erring toward `checked: false` is the safe direction:
  // a prerelease leaf goes unchecked rather than falsely flagged.
  return leaf && /^\d+\.\d+\.\d+$/.test(leaf) ? leaf : null;
}

// Does a plugin cache root's leaf directory name (the version Claude Code named
// it after) match what the package actually installed there declares in its own
// package.json? A mismatch means every hook and script reading through that root
// silently runs a different release than the directory name claims, with no
// signal anywhere.
//
// Provenance, stated precisely because it bounds what this may do: the 2026-08-29
// v1.7.4 pre-ship QA CONSTRUCTED this combination (a worker wrote a registry
// entry whose leaf read "1.7.3" over a package.json reading "1.7.4"). This exact
// shape, one registry-named path whose leaf disagrees with its own package.json,
// has not been seen arising on its own, and check-versions.mjs forces
// package.json, plugin.json and marketplace.json to agree at release time, so the
// installer names the directory from the same gated commit it copies inside. That
// is why this reports and never excludes: a constructed hazard does not justify
// dropping a working install root (see resolveEnabledPluginRoot below).
//
// A DIFFERENT and real shape is out of scope here: several stale leaf directories
// left behind beside the current one, each internally consistent, with something
// outside the registry (a slash command's substituted plugin root) still pointing
// at an old one. Measured 2026-08-31: five leaves 1.7.0 through 1.7.4 all matching
// their own package.json, the registry naming only 1.7.4, and a command handing an
// agent the 1.7.3 scripts path. This function compares registry-named paths, so it
// reports pass there and is right to.
//
// `checked: false` means pkgRoot's leaf is not version-shaped, so there is
// nothing to compare (not every usable root is a plugin cache path).
export function leafVersionDrift(pkgRoot) {
  const leaf = cacheLeafVersion(pkgRoot);
  if (!leaf) return { checked: false, drift: false, leaf: null, manifestVersion: null };
  const manifestVersion = readPkgVersionAt(pkgRoot);
  // Unreadable package.json, or one with no version, is a judgment FAILURE, not a clean
  // result. Returning `{checked: true, drift: false}` there would read as "compared and
  // matched" and contradicts the sibling rule above (err toward `checked: false`).
  // doctor happens to gate on usablePkgRoot first, which requires a readable version, so
  // this is unreachable today; it is closed here because this is an exported API and the
  // next caller will not know to add that gate.
  if (manifestVersion === null) return { checked: false, drift: false, leaf, manifestVersion: null };
  return { checked: true, drift: manifestVersion !== leaf, leaf, manifestVersion };
}

// Resolve the enabled Hypomnema plugin's REAL install root from the plugin
// registry (~/.claude/plugins/installed_plugins.json). POSITIVE attribution: it
// looks up the EXACT key that settingsPath marks enabled (via
// enabledHypomnemaPluginKey), not just any hypo-named entry — a disabled legacy or
// other-marketplace entry must never be selected. Among that key's registry
// entries it prefers the user-scope install (the one a plugin-enabled user runs),
// falling back to any usable entry. Returns a usable absolute install root, or
// null when the registry is absent/unreadable, names no entry for the enabled key,
// or that entry is not a usable package dir. Fails open (null) on every
// uncertainty; callers must treat null as "cannot positively resolve", never as
// "resolved to nothing usable exists".
//
// Leaf-version drift does NOT exclude a candidate here, deliberately. An earlier
// pass filtered on `!leafVersionDrift(p).drift`, and that turns a reporting
// problem into a breaking one: when this returns null, resolveDurableRoot (init.mjs)
// falls through to the recorded pkgRoot in hypo-pkg.json and, if that is not usable
// either, to PKG_ROOT. In a dual install PKG_ROOT is the
// manual/npm checkout the dual-install notice tells the user to remove. That path
// gets written into the vault's pre-commit hook, so removing the npm copy leaves
// the hook dangling and breaks every wiki commit (the failure init.mjs's own
// `durableRoot` comment exists to prevent). It also silences upgrade's
// dualSkipWouldCorrect trigger, disabling the very self-heal that fixes a stale
// pointer. Drift is surfaced by doctor's checkPluginLeafVersion instead.
export function resolveEnabledPluginRoot(settingsPath, registryPath) {
  const key = enabledHypomnemaPluginKey(settingsPath);
  if (!key) return null;
  let reg;
  try {
    reg = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    return null;
  }
  const plugins =
    reg && typeof reg.plugins === 'object' && !Array.isArray(reg.plugins) ? reg.plugins : null;
  const entries = plugins && Array.isArray(plugins[key]) ? plugins[key] : null;
  if (!entries) return null;
  const paths = (scope) =>
    entries
      .filter((e) => e && (scope === undefined || e.scope === scope))
      .map((e) => (typeof e.installPath === 'string' ? e.installPath : null))
      .filter((p) => usablePkgRoot(p));
  // Prefer the user-scope install, then any usable entry for this exact key.
  return paths('user')[0] ?? paths(undefined)[0] ?? null;
}
