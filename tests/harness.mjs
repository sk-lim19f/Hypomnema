/**
 * tests/harness.mjs — test(), testAsync(), suite(), and how a run is selected.
 *
 * No framework, no per-test isolation, no dependencies. Every test body carries
 * its own fixture cost (a tmp dir, a git repo, a spawned child), so skipping a
 * body skips its cost — which is the whole reason selection is worth anything.
 *
 * Selection is per-SUITE, never per-test. A suite whose tests build on each
 * other therefore always lands in one process, in order. Suites do not build on
 * each other, and `node tests/parallel.mjs --shards=220` proves it by running
 * each one alone in a fresh process.
 *
 * Flags are parsed at import, before any *.test.mjs module body runs, because
 * ESM evaluates a module's imports before the module itself.
 */

const ARGV = process.argv.slice(2);

function die(msg) {
  console.error(msg);
  process.exit(2);
}

// Every malformed flag exits 2. The failure mode being bought off here is not a
// crash, it is a green: `--grepp=close` or a bare `--grep` would select
// everything, run for minutes, and answer a question nobody asked.
const VALUE_FLAGS = new Set(['shard', 'grep', 'json', 'file']);
const BOOL_FLAGS = new Set(['timing', 'child']);

const ARGS = (() => {
  const known = [...VALUE_FLAGS, ...BOOL_FLAGS];
  const out = new Map();
  for (const arg of ARGV) {
    const m = /^--([a-zA-Z-]+)(?:=([\s\S]*))?$/.exec(arg);
    const name = m?.[1];
    if (!name || !known.includes(name)) {
      die(`unknown argument: ${arg}\nknown: ${known.map((f) => `--${f}`).join(' ')}`);
    }
    const value = m[2];
    if (VALUE_FLAGS.has(name) && !value) die(`--${name} needs a value: --${name}=<value>`);
    if (BOOL_FLAGS.has(name) && value !== undefined) die(`--${name} takes no value`);
    if (out.has(name)) die(`--${name} given more than once`);
    out.set(name, VALUE_FLAGS.has(name) ? value : true);
  }
  return out;
})();

function argValue(name) {
  const v = ARGS.get(name);
  return typeof v === 'string' ? v : undefined;
}

export const SHARD = (() => {
  const raw = argValue('shard');
  if (raw === undefined) return { index: 0, total: 1 };
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  if (!m) die(`--shard expects i/n (1-based), got: ${raw}`);
  const index = Number(m[1]) - 1;
  const total = Number(m[2]);
  if (total < 1 || index < 0 || index >= total) die(`--shard out of range: ${raw}`);
  return { index, total };
})();

export const GREP = (() => {
  const raw = argValue('grep');
  if (raw === undefined) return null;
  try {
    return new RegExp(raw, 'i');
  } catch (err) {
    die(`--grep is not a valid regex: ${err.message}`);
  }
})();

// Which *.test.mjs files to import. A comma-separated list of basenames without
// the suffix: `--file=extensions,lint`. The runner resolves and validates them;
// an unknown name is a typo, and a typo that silently ran everything would be a
// green nobody asked for.
//
// It cannot be combined with --shard. The suite counter runs over the files that
// were actually imported, so `--file=lint --shard=2/220` would select lint's own
// second suite rather than the global suite 2, and report it as if it were the
// latter. Refuse rather than quietly mean something else.
export const FILES = (() => {
  const raw = argValue('file');
  if (raw === undefined) return null;
  if (ARGS.has('shard')) {
    die(
      '--file and --shard cannot be combined: --shard numbers suites across every file, and --file changes which files exist',
    );
  }
  const names = raw
    .split(',')
    .map((s) => s.trim().replace(/\.test\.mjs$/, ''))
    .filter(Boolean);
  if (!names.length) die('--file needs at least one name');
  return names;
})();

export const TIMING = ARGS.has('timing');
export const JSON_OUT = argValue('json');
// Set by tests/parallel.mjs: our per-test lines still print (fix-status-verify
// parses them), but the parent owns the one summary the reader should trust.
export const CHILD = ARGS.has('child');

// ── the harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const timings = [];

let suiteIndex = -1;
// A test declared before the first suite() belongs to shard 1, so a sharded run
// covers it exactly once rather than once per shard. Nothing declares tests
// there any more, but the rule is cheap to keep and expensive to rediscover.
let suiteSelected = SHARD.index === 0;

// Headings print lazily, on a suite's first selected test, so a --grep run is a
// list of what ran rather than 220 headings over three results.
let pendingHeading = null;

function selected(name) {
  if (!suiteSelected) return false;
  if (GREP && !GREP.test(name)) return false;
  if (pendingHeading !== null) {
    console.log(`\n${pendingHeading}`);
    pendingHeading = null;
  }
  return true;
}

// `  ✓ name` and `  ✗ name` are a contract, not decoration:
// scripts/lib/fix-status-verify.mjs parses them out of `npm test` output to map
// a fix number to its verdict.
function record(name, err, ms) {
  timings.push({ name, ms });
  if (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failures.push({ name, err });
    failed++;
  } else {
    console.log(`  ✓ ${name}`);
    passed++;
  }
}

export function test(name, fn) {
  if (!selected(name)) {
    skipped++;
    return;
  }
  const t0 = performance.now();
  try {
    const result = fn();
    // test() cannot await. Hand it an async body and the promise is dropped:
    // every assertion inside runs after this checkmark is printed, and a
    // rejection can never fail the test. There are ~1500 test() calls next to a
    // couple dozen testAsync() ones, so the wrong one is always right there to
    // copy. Fail loudly instead of passing vacuously.
    if (result !== null && typeof result?.then === 'function') {
      result.catch(() => {}); // the body still runs; do not surface it as an unhandled rejection
      throw new Error(
        'async body passed to test() — its assertions are never awaited; use await testAsync(...)',
      );
    }
    record(name, null, performance.now() - t0);
  } catch (err) {
    record(name, err, performance.now() - t0);
  }
}

export async function testAsync(name, fn) {
  if (!selected(name)) {
    skipped++;
    return;
  }
  const t0 = performance.now();
  try {
    await fn();
    record(name, null, performance.now() - t0);
  } catch (err) {
    record(name, err, performance.now() - t0);
  }
}

// suiteIndex counts across every imported file, in import order. That is why
// --shard and --file are mutually exclusive: --shard numbers the suites of the
// files that got imported, so changing which files those are changes what a
// shard number means.
export function suite(label) {
  suiteIndex++;
  suiteSelected = suiteIndex % SHARD.total === SHARD.index;
  pendingHeading = suiteSelected ? label : null;
}

export function summary() {
  return { passed, failed, skipped, failures, timings, suites: suiteIndex + 1 };
}
