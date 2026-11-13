#!/usr/bin/env node
/**
 * Hypomnema app boundary CLI
 *
 * Usage:
 *   node scripts/app-boundary.mjs write --project=<alias> --boundary-id=<id> --codebook=<path>
 *        --codebook-sha256=<hex> --hypo-dir=<vault> --json   (five codes as JSON on stdin)
 *   node scripts/app-boundary.mjs --capabilities --json
 *
 * write           Leave one wiki entry for an app task boundary as a local commit under the vault
 *                 commit lock. Prints `{closeId, entryPath, committedSha, reused, state}`, or
 *                 `{error: <code>}` (exit 1). It never touches a remote: a person's Stop pushes.
 * --capabilities  Print the protocol versions this package speaks, as a JSON array.
 *
 * stdin is exactly `{taskKind, decision, status, team, boundaryKind}`. An unknown flag, a missing
 * argument or an unknown subcommand prints `{error: 'invalid_args'}` and exits 2.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CAPABILITIES, writeBoundary } from './lib/app-boundary.mjs';

const FLAGS = {
  '--project': 'project',
  '--boundary-id': 'boundaryId',
  '--codebook': 'codebookPath',
  '--codebook-sha256': 'codebookSha256',
  '--hypo-dir': 'hypoDir',
};

function out(value, code = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = code;
}

function main(argv) {
  const [first, ...rest] = argv;
  if (first === '--capabilities' && rest.every((a) => a === '--json')) return out(CAPABILITIES);
  if (first !== 'write') return out({ error: 'invalid_args' }, 2);
  const args = {};
  for (const a of rest) {
    const eq = a.indexOf('=');
    const key = FLAGS[eq === -1 ? a : a.slice(0, eq)];
    if (a === '--json') continue;
    if (!key || eq === -1) return out({ error: 'invalid_args' }, 2);
    args[key] = a.slice(eq + 1);
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return out({ error: 'invalid_payload' }, 1);
  }
  try {
    const result = writeBoundary({ ...args, payload });
    return out(result, result.error ? 1 : 0);
  } catch {
    // Whatever threw may hold a path or an id: the caller gets a code, never its text.
    return out({ error: 'internal_error' }, 1);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
}

if (isMain()) main(process.argv.slice(2));
