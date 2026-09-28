#!/usr/bin/env node
/**
 * hypo-stop.mjs: the ONLY Stop hook registered in hooks/hooks.json.
 *
 * Claude Code runs every hook matched by an event in PARALLEL. Stop used to
 * carry four separate registrations (hot-rebuild, session-record, auto-commit,
 * auto-minimal-crystallize), so the order they ran in was whatever the four
 * processes happened to reach first. hypo-hot-rebuild.mjs was written against
 * an order it did not have: it writes root hot.md and log.md and only THEN
 * claims those paths into the session's touched-paths set, and hypo-auto-commit
 * could take the vault lock in between and commit without them. The rebuild
 * still succeeded, so no health notice fired either, and the fresh bytes just
 * sat uncommitted.
 *
 * One registration, four stages, run in order. The order is the contract now,
 * and STAGES below is the only place it is written down.
 *
 * Stages are spawned as child processes, not imported as functions. Each of the
 * four is a standalone script whose work happens at module top level: it reads
 * the hook payload off its own stdin and prints one hook-protocol JSON object to
 * its own stdout. Importing them would mean rewriting all four into exported
 * functions (auto-minimal-crystallize alone is ~300 lines of top-level decision
 * flow) and would put four sets of module state, and any process.exit or throw,
 * inside one process. A child per stage costs four Node startups, roughly 50ms
 * each against a 110s budget, and buys back the property serialization would
 * otherwise cost: a stage that dies, hangs, or writes garbage cannot take the
 * rest of the chain with it. That was free when the four ran in parallel, and
 * this is what keeps it.
 *
 * Node built-ins only (architecture invariant: hooks never import from
 * scripts/, and a hook's own directory is the only place it may reach).
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The Stop chain, in the order it must run.
 *
 * - hot-rebuild first: it writes root hot.md and log.md and claims them into
 *   the session's touched-paths set, which is the scope auto-commit later
 *   commits. Anything that runs before it contributes nothing to that scope.
 * - session-record next: it only appends to a gitignored cache file, so its
 *   position is free; it sits here because it is cheap and cannot fail the
 *   ones after it.
 * - auto-commit third: it has to see everything the two above claimed.
 * - auto-minimal-crystallize last: it is the only stage that can emit
 *   `decision: "block"`, and its close gate reads the committed state the
 *   stage before it produced.
 *
 * `timeoutMs` is each stage's own share of the budget, enforced here rather
 * than by the single hooks.json timeout. Serializing four hooks under one
 * registration makes one registration's timeout the ceiling for all four, so
 * without a per-stage kill a single hung stage would eat the whole budget and
 * the stages after it would never run at all. The values are the per-hook
 * timeouts these four carried in hooks.json before the merge, unchanged.
 */
const STAGES = [
  { file: 'hypo-hot-rebuild.mjs', timeoutMs: 30000 },
  { file: 'hypo-session-record.mjs', timeoutMs: 10000 },
  { file: 'hypo-auto-commit.mjs', timeoutMs: 60000 },
  { file: 'hypo-auto-minimal-crystallize.mjs', timeoutMs: 10000 },
];

/**
 * A stage's hook-protocol object, or null when it printed nothing usable.
 *
 * The last non-empty line, not the whole stream: a stage is free to write
 * diagnostics before its result (none do today), and the protocol object is
 * always the last thing out. A parse failure is null, which the caller treats
 * as "this stage said nothing", never as a reason to stop the chain.
 *
 * @param {string} stdout
 * @returns {object|null}
 */
function parseStageOutput(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  try {
    const parsed = JSON.parse(lines[lines.length - 1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How a stage failed to finish normally, in words a person can act on, or null
 * when it exited 0. `error` is a spawn failure or the per-stage timeout (Node
 * reports the kill as ETIMEDOUT); `signal` without a timeout is a death from
 * outside, such as an OOM kill.
 *
 * @param {{file: string, timeoutMs: number}} stage
 * @param {{error?: Error, status: number|null, signal: string|null}} res
 * @returns {string|null}
 */
function stageFailure(stage, res) {
  if (res.error?.code === 'ETIMEDOUT') return `${stage.file} timed out after ${stage.timeoutMs}ms`;
  if (res.error) return `${stage.file} failed to run: ${res.error.message ?? String(res.error)}`;
  if (res.signal) return `${stage.file} was killed by ${res.signal}`;
  if (res.status !== 0) return `${stage.file} exited ${res.status}`;
  return null;
}

let raw = '';
try {
  raw = await new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => resolve(d));
  });
} catch {
  raw = '';
}

// The merged reply. The hook protocol gives one JSON object per registration,
// so four stage replies have to collapse into one:
//   - systemMessage: every non-empty one, joined. Dropping any would silence a
//     stage that has something to tell the user.
//   - suppressOutput: true only while nothing wants to be seen. One stage
//     asking for output, or contributing a systemMessage, turns it off.
//   - continue / decision: the first stage that says "do not continue" ends the
//     chain (see the loop).
const messages = [];
// Stages that did not finish normally. The chain still runs past them (see the
// fail-open note in the loop), but the reply must not read as a clean Stop:
// hot-rebuild dying after its rename and before it claims the path leaves a
// changed, uncommitted hot.md, and stderr alone is not something a person
// sees. So each one is also named in systemMessage, which turns suppressOutput
// off. Not a `decision: "block"`: a transient timeout would then keep the
// session from ending, over and over.
const failures = [];
let suppressOutput = true;
let blocked = null;
let halted = null;

for (const stage of STAGES) {
  let res;
  try {
    res = spawnSync(process.execPath, [join(HOOKS_DIR, stage.file)], {
      input: raw,
      encoding: 'utf-8',
      timeout: stage.timeoutMs,
    });
  } catch (err) {
    process.stderr.write(`[hypo-stop] error: ${stage.file}: ${err?.message ?? String(err)}\n`);
    failures.push(`${stage.file} failed to run: ${err?.message ?? String(err)}`);
    continue;
  }
  if (res.stderr) process.stderr.write(res.stderr);
  // Fail-open, deliberately, and this is the decision serialization would
  // otherwise reverse. In parallel, a stage that crashed or hung took nothing
  // with it; in a chain, "abort on a non-zero exit" would let a hot-rebuild
  // crash cancel the commit that saves the session's work. So a stage that
  // exits non-zero, gets killed at its timeout, or prints unparseable output is
  // logged, reported in the reply, and skipped, and the chain moves on. The
  // ONLY thing that ends the chain early is a stage explicitly asking for it
  // through the protocol.
  const failure = stageFailure(stage, res);
  if (failure) {
    process.stderr.write(`[hypo-stop] error: ${failure}\n`);
    failures.push(failure);
  }

  const out = parseStageOutput(res.stdout);
  if (!out) continue;

  if (typeof out.systemMessage === 'string' && out.systemMessage.length > 0) {
    messages.push(out.systemMessage);
  }
  if (out.suppressOutput === false) suppressOutput = false;

  if (out.decision === 'block') {
    // Only auto-minimal-crystallize emits this today, and it is last, so
    // nothing is actually cut short. The rule still has to be written down: a
    // block means Claude is not allowed to stop, and the protocol carries one
    // reason, so a later stage's reply would either be discarded or have to be
    // merged into a decision that is not a merge.
    blocked = { reason: out.reason, stopReason: out.stopReason };
    break;
  }
  if (out.continue === false) {
    halted = { stopReason: out.stopReason };
    break;
  }
}

if (failures.length > 0) {
  messages.push(
    `[hypo-stop] Stop step(s) did not finish normally: ${failures.join('; ')}. ` +
      'Their work may be partly on disk and uncommitted; the steps after them still ran.',
  );
}

const reply = blocked
  ? { decision: 'block', reason: blocked.reason, stopReason: blocked.stopReason }
  : { continue: !halted, suppressOutput: suppressOutput && messages.length === 0 };
if (!blocked && halted && halted.stopReason) reply.stopReason = halted.stopReason;
if (messages.length > 0) reply.systemMessage = messages.join('\n');

console.log(JSON.stringify(reply));
