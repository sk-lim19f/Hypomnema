#!/usr/bin/env node
/**
 * tests/runner.mjs — the entry point. It owns no tests.
 *
 * Tests live in tests/<area>.test.mjs, one file per production area. The split
 * is not about speed (sharding already bought that); it is about two branches
 * being able to add tests without colliding in the same file, and about a suite
 * being findable from the thing it tests.
 *
 *   node tests/runner.mjs                     # everything, one process
 *   node tests/runner.mjs --file=extensions   # one area
 *   node tests/runner.mjs --grep=proposal     # matching tests, seconds not minutes
 *   node tests/runner.mjs --shard=2/8         # suites 2, 10, 18, ... (see parallel.mjs)
 *
 * Files are imported in sorted order, so the suite index a --shard selects on is
 * the same on every machine and every run.
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHILD, FILES, JSON_OUT, SHARD, TIMING, summary } from './harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const available = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

if (!available.length) {
  console.error('no tests/*.test.mjs found — did the split get half-applied?');
  process.exit(2);
}

let selectedFiles = available;
if (FILES) {
  const unknown = FILES.filter((n) => !available.includes(`${n}.test.mjs`));
  if (unknown.length) {
    console.error(`unknown --file: ${unknown.join(', ')}`);
    console.error(`known: ${available.map((f) => f.replace(/\.test\.mjs$/, '')).join(' ')}`);
    process.exit(2);
  }
  selectedFiles = FILES.map((n) => `${n}.test.mjs`).sort();
}

// Sequential, not Promise.all: suite() assigns shard membership by a counter, so
// the import order IS the suite order. Racing the imports would make --shard
// select a different set of suites on every run.
for (const f of selectedFiles) {
  await import(pathToFileURL(join(HERE, f)).href);
}

const { passed, failed, skipped, failures, timings } = summary();

if (!CHILD) {
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} not selected` : ''}`);
}

if (TIMING && !CHILD) {
  const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 25);
  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  console.log(`\n  slowest 25 of ${timings.length} (${(total / 1000).toFixed(1)}s in test bodies)`);
  for (const { name, ms } of slowest) {
    console.log(`  ${(ms / 1000).toFixed(2).padStart(7)}s  ${name}`);
  }
}

// The parent in tests/parallel.mjs merges these files rather than parsing our
// stdout, so a shard's verdict survives interleaved output and truncation.
if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({
      shard: `${SHARD.index + 1}/${SHARD.total}`,
      files: selectedFiles,
      passed,
      failed,
      skipped,
      failures: failures.map(({ name, err }) => ({ name, message: err.message })),
      timings,
    }),
  );
}

if (failed > 0) {
  if (!CHILD) {
    console.error(`\nFailed tests:`);
    for (const { name, err } of failures) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }
  process.exit(1);
}
