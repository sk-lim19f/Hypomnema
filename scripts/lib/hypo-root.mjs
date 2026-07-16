#!/usr/bin/env node
/**
 * hypo-root.mjs — resolve the Hypomnema root directory
 *
 * Resolution order:
 *   1. HYPO_DIR environment variable
 *   2. Scan common locations for hypo-config.md marker
 *   3. Default: ~/hypomnema
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();

/**
 * Expand leading ~/ to the user's home directory.
 * @param {string} p
 * @returns {string}
 */
export function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2));
  return p;
}

/**
 * Resolve the Hypomnema root directory, along with how it was resolved.
 * Checks HYPO_DIR env → hypo-config.md scan → ~/hypomnema default.
 *
 * The `source` lets a caller tell "the user pointed us somewhere and it's
 * empty" (an explicit misconfiguration worth failing loud on) apart from
 * "nobody configured anything and none of the usual spots had a vault
 * either" (a silent fallback, worth a quiet notice at most). resolveHypoRoot()
 * itself collapses both into the same path, on purpose, for every caller that
 * only ever wants a directory to hand to fs calls.
 * @returns {{ root: string, source: 'env'|'marker'|'default' }}
 */
export function resolveHypoRootInfo() {
  if (process.env.HYPO_DIR) {
    return { root: expandHome(process.env.HYPO_DIR), source: 'env' };
  }

  const candidates = [
    join(HOME, 'hypomnema'),
    join(HOME, 'wiki'),
    join(HOME, 'notes'),
    join(HOME, 'knowledge'),
    join(HOME, 'Documents', 'hypomnema'),
    join(HOME, 'Documents', 'wiki'),
    join(HOME, 'Documents', 'notes'),
  ];

  for (const c of candidates) {
    if (existsSync(join(c, 'hypo-config.md'))) return { root: c, source: 'marker' };
  }

  return { root: join(HOME, 'hypomnema'), source: 'default' };
}

/**
 * Resolve the Hypomnema root directory.
 * Checks HYPO_DIR env → hypo-config.md scan → ~/hypomnema default.
 * @returns {string} absolute path to Hypomnema root
 */
export function resolveHypoRoot() {
  return resolveHypoRootInfo().root;
}

/**
 * Validate a resolved root against the hypo-config.md marker, for the
 * read-only CLIs only (lint/stats/graph/query). Two failure classes need
 * different loudness:
 *   - `source === 'env'`: the caller pointed HYPO_DIR at a path with no
 *     vault there — an explicit misconfiguration. Fail loud: stderr + exit 1.
 *   - `source === 'default'` (or a stale `'marker'` hit): nobody configured
 *     anything and none of the usual spots had a vault. CI (lint-runner,
 *     release.yml) intentionally runs this way and must keep exiting 0 — but
 *     the CLI must stop silently reporting "no issues found" / "no results"
 *     as if it had actually scanned a wiki. Print a visible notice and tell
 *     the caller, so it can adjust its own empty-result copy, then continue.
 * A caller that received `hypoDir` from an explicit --hypo-dir=<path> flag
 * (tests, other tooling) never calls this — that path is not auto-resolved
 * and is trusted as-is, valid or not.
 * @param {string} root
 * @param {'env'|'marker'|'default'} source
 * @returns {boolean} true when the vault is missing (caller should suppress
 *   its own "nothing found" messaging in favor of this notice already
 *   printed); false when a real vault was found and normal scanning should
 *   proceed.
 */
export function checkVaultOrExit(root, source) {
  if (existsSync(join(root, 'hypo-config.md'))) return false;

  if (source === 'env') {
    console.error(`Hypomnema vault not found at HYPO_DIR=${root} (no hypo-config.md).`);
    process.exit(1);
  }

  console.error('No Hypomnema vault found. Set HYPO_DIR or run inside a vault; nothing to scan.');
  return true;
}
