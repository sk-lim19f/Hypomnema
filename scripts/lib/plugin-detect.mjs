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
  if (manifestVersion === null)
    return { checked: false, drift: false, leaf, manifestVersion: null };
  return { checked: true, drift: manifestVersion !== leaf, leaf, manifestVersion };
}

// Among a key's registry entries, the exact row resolveEnabledPluginEntry (and
// therefore resolveEnabledPluginRoot) picks: the user-scope install first (the
// one a plugin-enabled user runs), falling back to any usable entry. A caller
// that needs a FIELD off that row (not just its path — e.g. checkPluginInstallDrift
// wants gitCommitSha) must get the same row this returns, or it re-derives the
// selection rule itself and the two can disagree the moment a project-scope row
// sits ahead of the user row on the same installPath (measured 2026-09-02: PR
// #269 reimplemented this exact filter-then-prefer-scope rule at its call site,
// in the opposite order, which silently swaps rows whenever the user row has no
// gitCommitSha).
function selectEntry(entries, scope) {
  return (
    entries.find(
      (e) => e && (scope === undefined || e.scope === scope) && usablePkgRoot(e.installPath),
    ) ?? null
  );
}

// Resolve the enabled Hypomnema plugin's registry row and its REAL install root
// in one lookup, from the plugin registry (~/.claude/plugins/installed_plugins.json).
// POSITIVE attribution: it looks up the EXACT key that settingsPath marks enabled
// (via enabledHypomnemaPluginKey), not just any hypo-named entry — a disabled
// legacy or other-marketplace entry must never be selected.
//
// Returns `{ key, reason, entry, root }`. `reason` distinguishes WHY `entry`/`root`
// came back null, which is the distinction resolveEnabledPluginRoot's plain
// null could not make and callers used to re-derive by hand:
//   - 'not-enabled':         no enabledPlugins key is enabled — there is no
//                            plugin-channel question to answer here at all.
//   - 'registry-unreadable': the key IS enabled, but the registry file could not
//                            be read or parsed — a judgment FAILURE, not "no
//                            plugin installed".
//   - 'unresolved':          the key is enabled and the registry parsed, but no
//                            entry for that key is a usable package dir — also a
//                            judgment failure, never "confirmed absent".
//   - 'resolved':            a usable entry was found; `entry` and `root` are set.
//
// Every non-'resolved' reason means "cannot positively resolve" — never read it
// as "resolved to nothing usable exists".
//
// Leaf-version drift does NOT exclude a candidate here, deliberately. An earlier
// pass filtered on `!leafVersionDrift(p).drift`, and that turns a reporting
// problem into a breaking one: when this returns no usable entry, resolveDurableRoot
// (init.mjs) falls through to the recorded pkgRoot in hypo-pkg.json and, if that is
// not usable either, to PKG_ROOT. In a dual install PKG_ROOT is the manual/npm
// checkout the dual-install notice tells the user to remove. That path gets written
// into the vault's pre-commit hook, so removing the npm copy leaves the hook
// dangling and breaks every wiki commit (the failure init.mjs's own `durableRoot`
// comment exists to prevent). It also silences upgrade's dualSkipWouldCorrect
// trigger, disabling the very self-heal that fixes a stale pointer. Drift is
// surfaced by doctor's checkPluginLeafVersion instead.
export function resolveEnabledPluginEntry(settingsPath, registryPath) {
  const key = enabledHypomnemaPluginKey(settingsPath);
  if (!key) return { key: null, reason: 'not-enabled', entry: null, root: null };
  let reg;
  try {
    reg = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    return { key, reason: 'registry-unreadable', entry: null, root: null };
  }
  const plugins =
    reg && typeof reg.plugins === 'object' && !Array.isArray(reg.plugins) ? reg.plugins : null;
  const entries = plugins && Array.isArray(plugins[key]) ? plugins[key] : null;
  // Prefer the user-scope install, then any usable entry for this exact key.
  const entry = entries ? (selectEntry(entries, 'user') ?? selectEntry(entries)) : null;
  if (!entry) return { key, reason: 'unresolved', entry: null, root: null };
  return { key, reason: 'resolved', entry, root: entry.installPath };
}

// Thin projection of resolveEnabledPluginEntry for callers that only need the
// path. Kept as its own export (rather than inlining `.root` everywhere) because
// it is the one most callers actually want, and because it is the name this
// repo's existing callers already know.
export function resolveEnabledPluginRoot(settingsPath, registryPath) {
  return resolveEnabledPluginEntry(settingsPath, registryPath).root;
}

// Single-computation answer to "is Claude's core hook/command surface
// plugin-managed for THIS process, and if that requires a registry lookup, what
// did it find?" doctor.mjs, init.mjs and upgrade.mjs each used to compute
// `pluginMode` / `hypomnemaPluginEnabled` / `coreManagedByPlugin` independently
// (three copies of the same three lines), and upgrade.mjs additionally called
// resolveEnabledPluginRoot on its own without ever computing coreManagedByPlugin
// at all. Same inputs everywhere:
//   pkgRoot       — the caller's own PKG_ROOT (this script's own install root)
//   settingsPath  — ~/.claude/settings.json
//   registryPath  — ~/.claude/plugins/installed_plugins.json
//
// Returns `{ pluginMode, hypomnemaPluginEnabled, coreManagedByPlugin, enabledKey,
// root, rootReason }`. `rootReason` is resolveEnabledPluginEntry's `reason`
// field for the dual-install case, or 'self' when pluginMode is true (root is
// pkgRoot itself — no registry lookup is needed or even meaningful there).
// Why detectChannel (hooks/version-check.mjs) is NOT reused here: its bare
// `/plugins/` substring is deliberately broader because that judgment is
// display-only for the notifier, while pluginMode below gates install behavior
// and needs the narrower `.claude/plugins/` match. The full rationale is at
// scripts/upgrade.mjs (the "generic /plugins/ substring" comment above its own
// channel block). The direction is not the obstacle: scripts/ importing hooks/
// is the legal one and doctor.mjs already does it.
//
// NOTE for a future consolidator: `enabledKey` is null whenever pluginMode is
// true (the short-circuit below). doctor.mjs's checkPluginLeafVersion therefore
// asks the settings file directly instead of reading it from here, and it walks
// EVERY registry row while resolveEnabledPluginEntry returns one. Two assertions
// in tests/doctor.test.mjs pin both facts.
export function resolvePluginChannel({ pkgRoot, settingsPath, registryPath }) {
  const pluginMode = pkgRoot.replace(/\\/g, '/').includes('/.claude/plugins/');
  if (pluginMode) {
    return {
      pluginMode: true,
      hypomnemaPluginEnabled: false,
      coreManagedByPlugin: true,
      enabledKey: null,
      root: pkgRoot,
      rootReason: 'self',
    };
  }
  const resolved = resolveEnabledPluginEntry(settingsPath, registryPath);
  const hypomnemaPluginEnabled = resolved.reason !== 'not-enabled';
  return {
    pluginMode: false,
    hypomnemaPluginEnabled,
    coreManagedByPlugin: hypomnemaPluginEnabled,
    enabledKey: resolved.key,
    root: resolved.root,
    rootReason: resolved.reason,
  };
}
