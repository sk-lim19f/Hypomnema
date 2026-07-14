#!/usr/bin/env node
/**
 * tests/parallel.mjs — run the tests as N concurrent processes.
 *
 * Every test body carries its own fixture cost (tmp dirs, git repos, spawned
 * children), so the suite is bound by process startup and disk, not by anything
 * one Node process can overlap. Cutting the work across processes is the only
 * lever that moves wall clock.
 *
 * Two ways to cut it, and they answer different questions:
 *
 *   --shards=N   Round-robin whole SUITES across N processes. Balances well,
 *                because a slow suite and a fast one land in different shards.
 *                This is the default.
 *
 *   --by-file    One process per tests/<area>.test.mjs. Reads naturally and
 *                names the file in each line of progress, but the areas differ
 *                by an order of magnitude in size, so wall clock is whatever the
 *                biggest file takes and the small processes idle.
 *
 *   --shards=220 Every suite alone in a fresh process. This is the proof that no
 *                suite depends on another having run first — the thing that
 *                licenses sharding at all. Run it when you add or split a suite.
 *
 * Shards never share state: each selects whole suites and builds its own
 * fixtures under a HOME pinned to a tmp dir. Verdicts come back as JSON files
 * rather than parsed stdout, so an interleaved or truncated console cannot
 * change a verdict.
 *
 * Usage:
 *   node tests/parallel.mjs                  # cpu-count shards
 *   node tests/parallel.mjs --shards=4
 *   node tests/parallel.mjs --by-file
 *   node tests/parallel.mjs --grep=proposal  # pass-through to the runner
 *   node tests/parallel.mjs --timing
 *   node tests/parallel.mjs --json=<path>    # merged machine-readable report
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const RUNNER = join(HERE, 'runner.mjs');

const ARGV = process.argv.slice(2);

function die(msg) {
  console.error(msg);
  process.exit(2);
}

// Same reasoning as the runner's own check: a silently ignored `--shardz=4` or a
// bare `--grep` would run the default shape and report a green nobody asked for.
// Value flags demand a value; boolean flags refuse one; nothing repeats.
const VALUE_FLAGS = new Set(['shards', 'grep', 'json']);
const BOOL_FLAGS = new Set(['timing', 'by-file']);
const KNOWN = [...VALUE_FLAGS, ...BOOL_FLAGS];

const ARGS = new Map();
for (const arg of ARGV) {
  const m = /^--([a-zA-Z-]+)(?:=([\s\S]*))?$/.exec(arg);
  const name = m?.[1];
  if (!name || !KNOWN.includes(name)) {
    die(`unknown argument: ${arg}\nknown: ${KNOWN.map((f) => `--${f}`).join(' ')}`);
  }
  const value = m[2];
  if (VALUE_FLAGS.has(name) && !value) die(`--${name} needs a value: --${name}=<value>`);
  if (BOOL_FLAGS.has(name) && value !== undefined) die(`--${name} takes no value`);
  if (ARGS.has(name)) die(`--${name} given more than once`);
  ARGS.set(name, VALUE_FLAGS.has(name) ? value : true);
}

function argValue(name) {
  const v = ARGS.get(name);
  return typeof v === 'string' ? v : undefined;
}

const BY_FILE = ARGS.has('by-file');
if (BY_FILE && ARGS.has('shards')) die('--by-file and --shards choose different cuts; pick one');

// Not consulted in --by-file mode, so a stale HYPO_TEST_SHARDS in the
// environment must not fail a run that never reads it.
const SHARDS = (() => {
  if (BY_FILE) return 0;
  const raw = argValue('shards') ?? process.env.HYPO_TEST_SHARDS;
  if (raw === undefined) return Math.max(1, cpus().length);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) die(`--shards expects a positive integer, got: ${raw}`);
  return n;
})();

const FILES = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();
if (!FILES.length) die('no tests/*.test.mjs found');

// Each unit is one child process. In shard mode it owns a slice of the suites;
// in file mode it owns one area file.
const UNITS = BY_FILE
  ? FILES.map((f, i) => ({
      label: f.replace(/\.test\.mjs$/, ''),
      args: [`--file=${f.replace(/\.test\.mjs$/, '')}`],
      index: i + 1,
    }))
  : Array.from({ length: SHARDS }, (_, i) => ({
      label: `shard ${i + 1}/${SHARDS}`,
      args: [`--shard=${i + 1}/${SHARDS}`],
      index: i + 1,
    }));

// --shards, --by-file and --json are ours. --shard, --file, --child and the
// report path are ours to set, so a caller cannot fight us for them.
const PASSTHROUGH = ARGV.filter(
  (a) => !a.startsWith('--shards=') && !a.startsWith('--json=') && a !== '--by-file',
);
const TIMING = ARGS.has('timing');
const JSON_OUT = argValue('json');

const tmp = mkdtempSync(join(tmpdir(), 'hypo-shards-'));

function runUnit(unit) {
  return new Promise((resolve) => {
    const report = join(tmp, `unit-${unit.index}.json`);
    const args = [RUNNER, ...unit.args, `--json=${report}`, '--child', ...PASSTHROUGH];
    // HOME is deliberately inherited, not pinned. A child must see exactly what
    // `node tests/runner.mjs` sees, or the two stop being verdict-identical: the
    // hermeticity guard snapshots the real ~/.claude to prove no test wrote
    // there, and the manifest test reads the real wiki under ~/hypomnema. Pin
    // HOME here and both keep passing while testing nothing. The runner pins
    // HOME on the children *it* spawns, which is where the invariant belongs.
    const child = spawn(process.execPath, args);

    // Kept apart. The runner prints passes to stdout and failures to stderr, and
    // scripts/lib/fix-status-verify.mjs reads both; folding one into the other
    // would quietly rewrite which stream a failure arrives on.
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));

    const started = Date.now();
    const finish = (fields) =>
      resolve({ ...unit, seconds: (Date.now() - started) / 1000, out, err, ...fields });

    // A unit that cannot even be spawned resolves like a crash rather than
    // rejecting: one dead process must not take the whole run's report with it.
    child.on('error', (e) => finish({ crashed: true, code: null, crashReason: e.message }));

    child.on('close', (code, signal) => {
      if (!existsSync(report)) {
        // No report means it died before its summary: a crash, not a failing
        // assertion. A silent zero here would read as "nothing to run".
        finish({ crashed: true, code, crashReason: `exit ${code}, no report written` });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(report, 'utf-8'));
      } catch (e) {
        finish({ crashed: true, code, crashReason: `unreadable report: ${e.message}` });
        return;
      }
      // A readable report is not on its own a verdict. The runner's contract is
      // exit 1 when it failed and exit 0 when it did not; anything else (a
      // signal, an exit code from somewhere past the summary) means the process
      // did not end the way it says it did, and trusting the file would turn a
      // dead unit into a green one.
      const expected = parsed.failed > 0 ? 1 : 0;
      if (signal || code !== expected) {
        finish({
          crashed: true,
          code,
          crashReason: signal
            ? `killed by ${signal} after writing its report`
            : `exit ${code}, but its report says ${parsed.failed} failed (expected exit ${expected})`,
          ...parsed,
        });
        return;
      }
      finish({ crashed: false, code, ...parsed });
    });
  });
}

const wall = Date.now();
// Progress goes to stderr. It lands in completion order, which is inherently
// nondeterministic, and stdout is a contract: fix-status-verify parses it.
console.error(
  BY_FILE
    ? `running ${UNITS.length} test files, one process each`
    : `running ${SHARDS} shards over ${FILES.length} test files`,
);

const results = await Promise.all(
  UNITS.map((u) =>
    runUnit(u).then((r) => {
      const label = `  ${r.label.padEnd(BY_FILE ? 20 : 14)}`;
      if (r.crashed) {
        console.error(`${label}  CRASHED (${r.crashReason}) after ${r.seconds.toFixed(1)}s`);
      } else {
        const verdict = r.failed > 0 ? `${r.failed} failed` : 'green';
        console.error(
          `${label}  ${String(r.passed).padStart(4)} passed, ${verdict}  (${r.seconds.toFixed(1)}s)`,
        );
      }
      return r;
    }),
  ),
);

rmSync(tmp, { recursive: true, force: true });

results.sort((a, b) => a.index - b.index);

// Replay every unit's console, in order, on the stream it came from. This is not
// decoration: the `  ✓ name` / `  ✗ name` lines are a contract.
// scripts/lib/fix-status-verify.mjs parses them out of `npm test` output to map
// a fix number to its verdict, and swallowing them would make that tool see an
// empty test run and mis-report every fix as untested.
for (const r of results) {
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
}

const crashed = results.filter((r) => r.crashed);
const passed = results.reduce((n, r) => n + (r.passed ?? 0), 0);
const failed = results.reduce((n, r) => n + (r.failed ?? 0), 0);
const allFailures = results.flatMap((r) => r.failures ?? []);

console.log(`\n${'─'.repeat(40)}`);
console.log(
  `  ${passed} passed, ${failed} failed  (${((Date.now() - wall) / 1000).toFixed(1)}s wall)`,
);

if (TIMING) {
  const timings = results.flatMap((r) => r.timings ?? []);
  const slowest = timings.sort((a, b) => b.ms - a.ms).slice(0, 25);
  const bodySeconds = timings.reduce((sum, t) => sum + t.ms, 0) / 1000;
  console.log(
    `\n  slowest 25 of ${timings.length} (${bodySeconds.toFixed(1)}s inside test bodies)`,
  );
  for (const { name, ms } of slowest) {
    console.log(`  ${(ms / 1000).toFixed(2).padStart(7)}s  ${name}`);
  }
}

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    JSON.stringify({
      mode: BY_FILE ? 'by-file' : 'shards',
      units: UNITS.length,
      passed,
      failed,
      crashed: crashed.map((r) => ({ unit: r.label, code: r.code, reason: r.crashReason })),
      failures: allFailures,
    }),
  );
}

for (const r of crashed) {
  console.error(`\n─── ${r.label} crashed: ${r.crashReason} ───`);
}

if (allFailures.length > 0) {
  console.error(`\nFailed tests:`);
  for (const { name, message } of allFailures) {
    console.error(`  ✗ ${name}: ${message}`);
  }
}

if (failed > 0 || crashed.length > 0) process.exit(1);
