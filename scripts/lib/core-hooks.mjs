// core-hooks.mjs - read the packaged hooks/hooks.json without side effects.
//
// The init installer (init.mjs loadHookMap) reads hooks.json, validates it, and
// calls process.exit(1) on any malformation. That exit-on-error behavior is
// correct for init but fatal for other consumers: reverse-capture wants to
// reserve the core hook basenames so it never captures a core hook by mistake,
// and it must not die because someone else's hooks.json is malformed.
//
// So this module owns only the read+parse step, exit-free. It returns a result
// object; the caller decides what to do with a failure. init.mjs keeps its own
// detailed validation + exit wrapper on top; reverse-capture skips the whole
// hooks type when the result is not ok (better to capture nothing than to
// capture a core hook).
//
// fail-closed: a result is ok only when the file reads, parses, AND has the
// expected shape (a hooks registration map plus a shared array). A parsed but
// oddly shaped hooks.json would yield a thin basename set, which is exactly the
// gap through which a core hook could leak into capture. When the shape is off
// we still attach the parsed cfg so init can run its own validation and emit its
// own specific error, but ok is false so capture stays conservative.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read and JSON-parse hooks/hooks.json from a package root. No process.exit, no
 * top-level side effects.
 *
 * @param {string} pkgRoot  absolute path to the package root (contains hooks/)
 * @returns {{ ok: true, cfg: object }
 *   | { ok: false, error: string }
 *   | { ok: false, error: string, cfg: * }}
 *   On read or parse failure the `cfg` key is absent. On a successful parse the
 *   `cfg` key is always present (even for null/array/scalar/shape-off inputs),
 *   so a caller can discriminate read/parse failure from shape failure by the
 *   presence of the `cfg` key. `ok` is true only when the shape is as expected.
 */
export function readCoreHooksConfig(pkgRoot) {
  let raw;
  try {
    raw = readFileSync(join(pkgRoot, 'hooks', 'hooks.json'), 'utf-8');
  } catch (err) {
    return { ok: false, error: `cannot read hooks/hooks.json: ${err.message}` };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `hooks/hooks.json is not valid JSON: ${err.message}` };
  }
  // Parse succeeded: attach cfg unconditionally so init can run its own checks.
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, error: 'hooks/hooks.json must be a JSON object', cfg };
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) {
    return { ok: false, error: 'hooks/hooks.json must contain a "hooks" object', cfg };
  }
  if (!Array.isArray(cfg.shared)) {
    return { ok: false, error: 'hooks/hooks.json must contain a "shared" array', cfg };
  }
  // Nested shape: a structurally odd rung (event not an array, a group without a
  // hooks array, a hook entry with no string command, a non-string shared element)
  // is silently skipped by deriveCoreHookBasenames, yielding a THIN reserved set.
  // That is the gap through which a core hook could leak into reverse-capture, so
  // validate every rung and fail closed. cfg is still attached so init can run its
  // own detailed validation and emit its own specific error.
  for (const groups of Object.values(cfg.hooks)) {
    if (!Array.isArray(groups)) {
      return { ok: false, error: 'each hooks event must map to an array of groups', cfg };
    }
    for (const group of groups) {
      if (typeof group === 'string') continue; // legacy bare-filename group
      if (!group || typeof group !== 'object' || Array.isArray(group)) {
        return { ok: false, error: 'each hook group must be an object or a filename string', cfg };
      }
      if (!Array.isArray(group.hooks)) {
        return { ok: false, error: 'each hook group must contain a "hooks" array', cfg };
      }
      for (const hook of group.hooks) {
        if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
          return { ok: false, error: 'each hook entry must be an object', cfg };
        }
        if (typeof hook.command !== 'string') {
          return { ok: false, error: 'each hook entry must have a string command', cfg };
        }
      }
    }
  }
  for (const file of cfg.shared) {
    if (typeof file !== 'string') {
      return { ok: false, error: 'each "shared" entry must be a string', cfg };
    }
  }
  return { ok: true, cfg };
}

// Match a bare .mjs basename with no path separators, whitespace, or quoting.
// Applied to the LAST path segment only, so a command like
// `node ${CLAUDE_PLUGIN_ROOT}/hooks/hypo-lookup.mjs` yields `hypo-lookup.mjs`.
const MJS_BASENAME = /^[^\s/\\'"`]+\.mjs$/i;

/**
 * Extract the strict .mjs basename from a value that is either a bare filename
 * or a full command string. Takes the last path segment (split on / and \) and
 * accepts it only when it is a clean .mjs name. Returns null otherwise.
 * @param {*} value
 * @returns {string | null}
 */
function strictMjsBasename(value) {
  if (typeof value !== 'string') return null;
  const segments = value.trim().split(/[/\\]/);
  const last = segments[segments.length - 1];
  return MJS_BASENAME.test(last) ? last : null;
}

/**
 * Derive the set of core hook .mjs basenames reserved by hooks.json: the union
 * of every registered event command's basename and every `shared` array
 * basename, lowercased. Walks defensively so a partially odd cfg yields a
 * partial (never throwing) set; the fatal shape gate lives in
 * readCoreHooksConfig.
 *
 * @param {object} cfg  parsed hooks.json (as returned in readCoreHooksConfig().cfg)
 * @returns {Set<string>} lowercase .mjs basenames
 */
export function deriveCoreHookBasenames(cfg) {
  const names = new Set();
  const add = (value) => {
    const base = strictMjsBasename(value);
    if (base) names.add(base.toLowerCase());
  };

  if (cfg && typeof cfg === 'object' && cfg.hooks && typeof cfg.hooks === 'object') {
    for (const groups of Object.values(cfg.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (typeof group === 'string') {
          // Legacy format: the group is a bare .mjs filename.
          add(group);
          continue;
        }
        if (group && typeof group === 'object' && Array.isArray(group.hooks)) {
          for (const hook of group.hooks) {
            if (hook && typeof hook === 'object') add(hook.command);
          }
        }
      }
    }
  }

  if (cfg && Array.isArray(cfg.shared)) {
    for (const file of cfg.shared) add(file);
  }

  return names;
}
