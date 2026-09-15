// hook-inventory.mjs — the one grammar every hooks.json/shared.json consumer reads
// through: smoke-plugin.mjs, init.mjs, upgrade.mjs, doctor.mjs, uninstall.mjs.
//
// Before this file existed, five scripts each grew their own regex for pulling a
// .mjs basename out of a hooks.json `command` string, and the five disagreed:
//   - smoke-plugin accepted ANY path after `${CLAUDE_PLUGIN_ROOT}/`, so a command
//     pointing at `${CLAUDE_PLUGIN_ROOT}/scripts/foo.mjs` (the wrong directory —
//     init only ever copies hooks/) passed smoke as long as that file happened to
//     exist, while init/upgrade/doctor/uninstall all resolve the same command to
//     `hooks/foo.mjs` and never look in scripts/ at all.
//   - init/upgrade/doctor took the LAST `.mjs` path segment in the command, so a
//     trailing argument like `--config bar.mjs` would have picked `bar.mjs` up as
//     the hook file instead of the hook itself.
//   - uninstall anchored on `/hooks/([^/\s]+\.mjs)$` — the command had to literally
//     END in `.mjs`, so the same trailing-argument shape it would silently ignore
//     instead of misreading.
// One parser closes all three gaps by only ever accepting one shape.
//
// This module also folds in the existence check that used to be missing entirely:
// loadHookInventory() only returns ok:true once every name on both lists resolves
// to a real regular file under `<pkgRoot>/hooks/`. A caller that runs this BEFORE
// its first write (as init.mjs now does) can never install a partial hook set from
// a package a file was dropped out of.
//
// Deliberately does NOT accept the legacy bare-filename group format
// (`"hooks.json"`: `{ "SomeEvent": ["foo.mjs"] }`) that ../core-hooks.mjs's
// readCoreHooksConfig still tolerates for reverse-capture's basename reservation.
// That tolerance exists so a stale or hand-edited hooks.json never lets a core
// hook slip into a user's captured extensions; it has nothing to do with what
// install/uninstall are willing to act on, so narrowing the grammar here does not
// need to touch core-hooks.mjs at all.

import { join } from 'node:path';
import { readCoreHooksConfig } from './core-hooks.mjs';
import { isRegularFile } from './pkg-json.mjs';

// A plain .mjs basename: word characters, dots, and hyphens only, no path
// separator (so a joined path can never climb out of the directory it is joined
// onto) and no leading dot (rules out a hidden file and `..`, which does not
// match `\w` but a bare `.` prefix like `.mjs` alone still would). Mirrors the
// basename check smoke-plugin.mjs already applied to hooks/shared.json entries.
const SAFE_MJS_BASENAME = /^[\w.-]+\.mjs$/;

export function isSafeMjsBasename(name) {
  return typeof name === 'string' && SAFE_MJS_BASENAME.test(name) && !name.startsWith('.');
}

// The one command shape this module accepts: `${CLAUDE_PLUGIN_ROOT}/hooks/<basename>.mjs`,
// optionally followed by more of the command (a trailing argument, a redirect —
// anything after whitespace or a closing quote). No sub-directory under hooks/,
// no other top-level directory, no bare filename with no `${CLAUDE_PLUGIN_ROOT}/hooks/`
// prefix at all.
const PLUGIN_HOOKS_TARGET = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s/"'`]+)(?=$|[\s"'`])/;

/**
 * Extract the hooks/<basename>.mjs a command string targets, or null when the
 * command does not match the one accepted shape (wrong directory, a
 * sub-directory, a basename that fails isSafeMjsBasename, or no
 * `${CLAUDE_PLUGIN_ROOT}/hooks/` segment at all).
 */
export function extractPluginHookBasename(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(PLUGIN_HOOKS_TARGET);
  if (!m) return null;
  return isSafeMjsBasename(m[1]) ? m[1] : null;
}

/**
 * Load, narrowly validate, and existence-check the hook inventory rooted at
 * `pkgRoot`: hooks/hooks.json's per-event basenames plus hooks/shared.json's
 * shared-module basenames. Fails closed on the FIRST problem, whether that is a
 * read/parse failure (delegated to readCoreHooksConfig), an empty hooks map, a
 * command that does not match the one accepted grammar, an unsafe shared.json
 * basename, or a named file that is not actually a regular file under
 * `<pkgRoot>/hooks/`.
 *
 * @param {string} pkgRoot
 * @returns {{ ok: true, hookMap: Record<string, string[]>, shared: string[] }
 *   | { ok: false, error: string }}
 */
export function loadHookInventory(pkgRoot) {
  const res = readCoreHooksConfig(pkgRoot);
  if (!res.ok) return { ok: false, error: res.error };
  const cfg = res.cfg;

  if (Object.keys(cfg.hooks).length === 0) {
    return { ok: false, error: 'hooks/hooks.json "hooks" must not be empty' };
  }

  const hookMap = {};
  for (const [event, groups] of Object.entries(cfg.hooks)) {
    const basenames = [];
    for (const group of groups) {
      // readCoreHooksConfig still accepts a bare-filename group (the legacy
      // shape reverse-capture's basename reservation tolerates on purpose — see
      // the module header). Every real install/uninstall consumer of THIS
      // function only ever shipped the hook-group object form, so a bare string
      // reaching here is not something any of the five knows how to act on.
      if (typeof group === 'string') {
        return {
          ok: false,
          error: `hooks.${event}: a bare filename group ("${group}") is not accepted here — wrap it in a hook-group object with an explicit command`,
        };
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        return {
          ok: false,
          error: `hooks.${event}: a hook group must have a non-empty "hooks" array`,
        };
      }
      for (const hook of group.hooks) {
        if (hook.type !== 'command') {
          return { ok: false, error: `hooks.${event}: hook entry "type" must be "command"` };
        }
        const base = extractPluginHookBasename(hook.command);
        if (!base) {
          return {
            ok: false,
            error: `hooks.${event}: command does not match "\${CLAUDE_PLUGIN_ROOT}/hooks/<basename>.mjs": ${hook.command}`,
          };
        }
        basenames.push(base);
      }
    }
    if (basenames.length === 0) {
      return { ok: false, error: `hooks.${event} yields no hook files` };
    }
    hookMap[event] = basenames;
  }

  for (const file of cfg.shared) {
    if (!isSafeMjsBasename(file)) {
      return { ok: false, error: `hooks/shared.json: "${file}" is not a plain .mjs basename` };
    }
  }

  // Existence, checked last and over the UNION of both lists: a caller that
  // reaches this point has already paid for the grammar checks above, and a
  // missing file (dropped from `package.json`'s `files` allowlist, or from a
  // corrupted copy) is exactly the gap major C closed — nothing may be
  // installed, refreshed, or reported healthy on the strength of a name alone.
  const allBasenames = new Set([...Object.values(hookMap).flat(), ...cfg.shared]);
  for (const base of allBasenames) {
    if (!isRegularFile(join(pkgRoot, 'hooks', base))) {
      return { ok: false, error: `hooks/${base} is not a file` };
    }
  }

  return { ok: true, hookMap, shared: cfg.shared, ordered: installOrder(hookMap, cfg.shared) };
}

/**
 * The order the hook files must be written to an install, and the reverse of
 * the order they must be removed in.
 *
 * Shared modules first. An entry hook copied ahead of a module it imports is
 * live against something that may not be there yet if the run is interrupted,
 * and the session that would have run the repair is the one that then cannot
 * start. The reverse order leaves the harmless state instead: an updated shared
 * module under an entry hook that has not caught up.
 *
 * It lives here so init, upgrade and uninstall read one list rather than each
 * deriving its own. They did derive their own, and the three sets were not even
 * equal: init copied every `.mjs` in the directory, which pulled in
 * `hypo-pre-commit.mjs` (invoked from the package root, never from the install)
 * and left a copy in every install that upgrade would not refresh, doctor would
 * not report, and uninstall would not remove.
 *
 * Alphabetical order puts today's shared modules first by luck; a shared module
 * named later in the alphabet would take that away with nothing failing.
 */
export function installOrder(hookMap, shared) {
  const sharedList = Array.isArray(shared) ? shared.filter((f) => typeof f === 'string') : [];
  const sharedSet = new Set(sharedList);
  const entries = [];
  for (const file of Object.values(hookMap).flat()) {
    if (!sharedSet.has(file) && !entries.includes(file)) entries.push(file);
  }
  return [...sharedList, ...entries];
}
