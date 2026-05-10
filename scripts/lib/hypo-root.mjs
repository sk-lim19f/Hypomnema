#!/usr/bin/env node
/**
 * hypo-root.mjs — resolve the Hypomnema wiki root directory
 *
 * Resolution order:
 *   1. HYPO_DIR environment variable
 *   2. Scan common locations for hypo-config.md marker
 *   3. Default: ~/wiki
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
 * Resolve the Hypomnema root directory.
 * Checks HYPO_DIR env → hypo-config.md scan → ~/hypomnema default.
 * @returns {string} absolute path to Hypomnema root
 */
export function resolveHypoRoot() {
  if (process.env.HYPO_DIR) {
    return expandHome(process.env.HYPO_DIR);
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
    if (existsSync(join(c, 'hypo-config.md'))) return c;
  }

  return join(HOME, 'hypomnema');
}
