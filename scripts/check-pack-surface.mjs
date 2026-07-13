#!/usr/bin/env node
/**
 * scripts/check-pack-surface.mjs — the ship-surface gate.
 *
 * MAINTAINER-ONLY. Deliberately absent from package.json `files`: being in the repo
 * and being in the product are different things, and this tool is only the former.
 *
 * Asserts that what `npm pack` actually ships equals the checked-in snapshot at
 * tests/fixtures/npm-pack.files.json, and that no shipped module imports a file
 * that is not itself shipped.
 *
 * Usage:
 *   node scripts/check-pack-surface.mjs              verify (exit 1 on drift)
 *   node scripts/check-pack-surface.mjs --update     rewrite the snapshot
 *
 * Invoke by PATH, not by `npm run` — a PR that edits package.json's `scripts`
 * could otherwise redefine the gate to a no-op in the very commit it should block.
 *
 * The snapshot records each path plus whether it is executable. It deliberately
 * does NOT record size, hash, or the raw mode:
 *   - size/hash churn on every content edit, which trains the reflex of
 *     regenerating the snapshot without reading it, and that reflex is exactly
 *     what lets a leak through.
 *   - the raw mode is a function of the checkout's umask, so comparing it fails
 *     honest PRs on a differently-configured machine. Only the executable bit
 *     carries meaning here, and only it is compared.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceDiff, closureViolations, parsePackJson } from './lib/pack-surface.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SNAPSHOT = join(REPO, 'tests', 'fixtures', 'npm-pack.files.json');
const UPDATE = process.argv.includes('--update');

/**
 * The tarball's contents, as npm itself computes them.
 *
 * `--ignore-scripts` keeps the `prepare` lifecycle from running: it cannot change
 * which files ship (it only installs git hooks into the checkout), but anything it
 * prints lands on the same stdout we have to parse. Suppressing it removes a whole
 * class of flake. As a second belt, the parse walks candidate `[` positions rather
 * than trusting the first one.
 */
function packFiles() {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO,
    encoding: 'utf-8',
  });
  if (res.status !== 0) {
    process.stderr.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    throw new Error(`npm pack --dry-run exited ${res.status}`);
  }
  const meta = parsePackJson(res.stdout);
  return meta.files
    .map((f) => ({ path: f.path, exec: (f.mode & 0o111) !== 0 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const actual = packFiles();

if (UPDATE) {
  writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n');
  console.log(`✓ snapshot updated: ${actual.length} files`);
  console.log(`  Read the diff before committing. Every added path is a public API.`);
  process.exit(0);
}

if (!existsSync(SNAPSHOT)) {
  console.error(`✗ snapshot missing: ${SNAPSHOT}`);
  console.error(`  Run: node scripts/check-pack-surface.mjs --update`);
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf-8'));
const execOf = new Map(snapshot.map((f) => [f.path, f.exec]));

const { added, removed } = surfaceDiff(
  actual.map((f) => f.path),
  snapshot.map((f) => f.path),
);
const execChanged = actual
  .filter((f) => execOf.has(f.path) && execOf.get(f.path) !== f.exec)
  .map(
    (f) =>
      `${f.path} (${execOf.get(f.path) ? 'executable' : 'not executable'} → ${f.exec ? 'executable' : 'not executable'})`,
  );

const violations = closureViolations(
  actual.map((f) => f.path),
  (p) => readFileSync(join(REPO, p), 'utf-8'),
);

let failed = false;

if (added.length) {
  failed = true;
  console.error(`\n✗ ${added.length} file(s) newly SHIPPING to every user:\n`);
  for (const p of added) console.error(`    + ${p}`);
  console.error(`
  If these are product, add them to package.json "files" and re-run with --update.
  If they are maintainer tooling (a release check, an authoring gate, a CI helper),
  they must NOT ship: leave "files" alone and they stay out by default.`);
}

if (removed.length) {
  failed = true;
  console.error(`\n✗ ${removed.length} file(s) NO LONGER shipping:\n`);
  for (const p of removed) console.error(`    - ${p}`);
  console.error(`
  A product file dropping out of the tarball breaks users silently. If the removal
  is intended, re-run with --update.`);
}

if (execChanged.length) {
  failed = true;
  console.error(`\n✗ executable bit changed on shipped file(s):\n`);
  for (const m of execChanged) console.error(`    ~ ${m}`);
}

const missing = violations.filter((v) => v.kind === 'missing' || v.kind === 'escapes-root');
const unanalyzable = violations.filter((v) => v.kind === 'unanalyzable');

if (missing.length) {
  failed = true;
  console.error(`\n✗ ${missing.length} shipped module(s) import a file that is NOT shipped:\n`);
  for (const v of missing) console.error(`    ${v.from} → ${v.imports}  (${v.resolved})`);
  console.error(`
  This crashes at runtime for anyone who installs from npm. Either add the target
  to package.json "files", or move the import out of the shipped module.`);
}

if (unanalyzable.length) {
  failed = true;
  console.error(
    `\n✗ ${unanalyzable.length} shipped module(s) import a target computed at runtime:\n`,
  );
  for (const v of unanalyzable) console.error(`    ${v.from} ${v.resolved}: ${v.imports}`);
  console.error(`
  The gate cannot prove where these land, so it cannot certify the tarball is
  complete — a lazily-imported module left out of "files" would crash only for
  users, and only on the branch that loads it. Use a literal specifier (a switch
  over static imports is fine), or hoist it to a static import.`);
}

if (failed) {
  console.error(`\nGate: scripts/check-pack-surface.mjs`);
  process.exit(1);
}

console.log(`✓ ship surface matches snapshot (${actual.length} files, 0 closure violations)`);
