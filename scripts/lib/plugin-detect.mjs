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

import { readFileSync } from 'node:fs';

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

  const enabled = parsed.enabledPlugins;
  // enabledPlugins is an object map `{ "<name>@<marketplace>": true|false }`.
  // Anything else (absent, array, scalar) → not enabled.
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) return false;

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
    if (name === 'hypo' || name === 'hypomnema') return true;
  }
  return false;
}
