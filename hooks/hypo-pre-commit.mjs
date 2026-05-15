#!/usr/bin/env node
/**
 * hypo-pre-commit.mjs — wiki git pre-commit hook worker (§6.8 fix #24)
 *
 * Blocks staged files that match .hypoignore patterns.
 * Installed by `hypo init` to <wiki>/.git/hooks/pre-commit.
 * The shell wrapper in that file calls: node <pkgRoot>/hooks/hypo-pre-commit.mjs
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import { loadHypoIgnore, isIgnored } from '../scripts/lib/hypo-ignore.mjs';

// Detect wiki root = git top-level of the wiki repo
const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
if (gitRoot.status !== 0) process.exit(0);

const hypoDir = gitRoot.stdout.replace(/\r?\n$/, '');

// Get staged files (NUL-separated for safe handling of special chars)
const staged = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf-8', cwd: hypoDir });
if (staged.status !== 0 || !staged.stdout) process.exit(0);

const files = staged.stdout.split('\0').filter(Boolean).map(f => join(hypoDir, f));
const patterns = loadHypoIgnore(hypoDir);

if (patterns.length === 0) process.exit(0);

const blocked = files.filter(f => isIgnored(f, hypoDir, patterns));
if (blocked.length === 0) process.exit(0);

const rel = blocked.map(f => f.slice(hypoDir.length + 1));
process.stderr.write(
  `[hypo] Commit blocked — staged files match .hypoignore patterns:\n` +
  rel.map(f => `  ${f}`).join('\n') + '\n' +
  `\nUnstage with: git restore --staged <file>\n` +
  `Override (at your own risk): git commit --no-verify\n`
);
process.exit(1);
