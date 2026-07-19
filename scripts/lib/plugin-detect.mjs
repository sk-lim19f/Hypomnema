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

// Resolve the enabled Hypomnema plugin's REAL install root from the plugin
// registry (~/.claude/plugins/installed_plugins.json). POSITIVE attribution: it
// looks up the EXACT key that settingsPath marks enabled (via
// enabledHypomnemaPluginKey), not just any hypo-named entry — a disabled legacy or
// other-marketplace entry must never be selected. Among that key's registry
// entries it prefers the user-scope install (the one a plugin-enabled user runs),
// falling back to any usable entry. Returns a usable absolute install root, or
// null when the registry is absent/unreadable, names no entry for the enabled key,
// or that entry is not a usable package dir. Fails open (null) on every
// uncertainty — callers must treat null as "cannot positively resolve", never as
// "resolved to nothing usable exists".
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
