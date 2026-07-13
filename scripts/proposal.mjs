#!/usr/bin/env node
/**
 * proposal.mjs: `hypomnema proposal list|apply|discard|challenge|resolve`, the
 * human-in-the-loop gate for parked overwrite-conflict artifacts (the write=proposal
 * store).
 *
 * When crystallize's close path finds an OVERWRITE target drifted from the base
 * this session observed, it withholds the bytes and parks them under
 * `.cache/proposals/<id>.json` rather than clobber the other writer. This CLI is
 * the only sanctioned way those bytes ever reach the target again, and no path to a
 * write skips a human approval: there is no confirmation-bypass flag, no
 * environment-variable override, and no background auto-apply. An apply is a
 * WHOLE-FILE replacement, so the human reviews a fresh current-vs-proposed diff
 * (that review IS the merge) before approving.
 *
 * The approval reaches us over TWO channels, and both are a human:
 *
 *   • `apply <id>` — a person at a shell types the confirm phrase on a TTY.
 *   • `challenge` → the user types `apply-proposals <nonce>` in the conversation →
 *     `resolve` — the approval is verified in the session TRANSCRIPT.
 *
 * The second channel exists because an AGENT has no TTY, so a drifted close used to
 * dead-end: the only way to finish was to bypass this store entirely with a direct
 * write, which taught the model that the gate is optional. The transcript channel
 * does not weaken the gate, it RELOCATES it: a hook cannot forge a user turn, and
 * the model's own words are role:assistant and are never counted (see
 * hasTypedUserApproval). A click is refused on purpose — the model authors the
 * option labels, so a click proves a click, not approval of this phrase.
 *
 * Every byte that reaches a target goes through writeApprovedProposal(), which does
 * NOT decide authorization; its two callers do, and they pass the outcome in. That
 * is what keeps the two channels from drifting apart.
 *
 * The decision helpers (planApplyAction, classifyFreshness, renderDiff are pure;
 * resolveTargetPath touches the filesystem to resolve symlinks) and the
 * result-returning actors are exported so the runner can drive them in-process with
 * injected TTY / prompt / clock seams. Injecting those seams is a TEST convention,
 * not a supported way to apply unattended: the shipped CLI path carries no bypass,
 * and a regression test pins that no hook reaches this module. main() sits behind an
 * isMain() guard so a static import never runs the CLI (feedback-sync precedent).
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  appendFileSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve, isAbsolute, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import {
  listProposals,
  readProposal,
  deleteProposal,
  isValidProposalId,
  isValidSessionId,
  hashProposalContent,
  proposalsDir,
  writeChallenge,
  readChallenge,
  consumeChallenge,
} from '../hooks/proposal-store.mjs';
import {
  APPROVAL_PHRASE,
  hasTypedUserApproval,
  resolveTranscriptBySessionId,
} from '../hooks/hypo-shared.mjs';

// ── target-path hardening ─────────────────────────────────────────────────────

/**
 * Resolve an artifact's `target` (vault-relative) to a safe absolute path inside
 * the vault, or null when it is unsafe.
 *
 * The `target` field is UNTRUSTED: `.cache/proposals/<id>.json` is plaintext and
 * hand-editable, and the store validates only the id, never the body's target. A
 * body carrying `target: "../../.zshrc"` would drive a whole-file replacement
 * outside the vault. This mirrors, on the target axis, the id hardening the store
 * applies on the filename axis. Every rejection fails CLOSED (returns null).
 *
 * Callers must re-run this immediately before writing, not only before showing the
 * diff: nothing is locked while the human reads, so an ancestor can become a
 * symlink out of the vault between those two moments.
 */
export function resolveTargetPath(hypoDir, target) {
  if (typeof target !== 'string' || target === '' || isAbsolute(target)) return null;
  // A `..` segment can walk out even when the lexical resolve below lands back
  // inside, so reject it outright.
  if (target.split(/[/\\]/).includes('..')) return null;

  const root = resolve(hypoDir);
  const full = resolve(join(hypoDir, target));
  // Lexical containment: the resolved path is the vault root or sits under it.
  if (full !== root && !full.startsWith(root + sep)) return null;

  // The store never writes to itself. A target pointing back into
  // `.cache/proposals/` would have apply write the withheld bytes over a SIBLING
  // artifact (destroying its payload), or over this very artifact and then unlink
  // it, or over the audit log. Each of those exits 0 while losing the only
  // off-disk copy of the bytes. This is an invariant of the store, not an
  // enumeration of crystallize's targets, so it couples to nothing.
  const store = resolve(proposalsDir(hypoDir));
  if (full === store || full.startsWith(store + sep)) return null;

  // Symlink containment: a lexical check cannot see a parent dir that is a symlink
  // pointing OUT of the vault (a rename target would then land outside). Require
  // the nearest EXISTING ancestor's real (symlink-resolved) path to stay within
  // the vault's own real path. The nearest ancestor is used because the target
  // file itself is usually absent (a fresh create).
  let ancestor = full;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    const realAncestor = realpathSync(ancestor);
    const realRoot = realpathSync(hypoDir);
    if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) return null;

    // The lexical store guard above compares lexical paths, so an in-vault symlink
    // alias (`alias -> .cache/proposals`, target `alias/<id>.json`) slips past it:
    // `alias/...` is not lexically under the store, yet the real write lands inside
    // it and would destroy an artifact. Re-run the store check on the REAL ancestor.
    // This is a static footgun (a pre-planted alias), not the unbounded write-time
    // race; closing it costs one comparison. If the store does not exist yet there
    // is nothing to alias into.
    try {
      const realStore = realpathSync(store);
      if (realAncestor === realStore || realAncestor.startsWith(realStore + sep)) return null;
    } catch {
      /* store absent: no alias target exists */
    }
  } catch {
    return null;
  }

  // The target itself being a symlink is fail-closed: readTarget follows the link
  // to build the diff the human reviews, but atomicWrite is tmp+rename and
  // REPLACES the link, so the bytes shown and the bytes written would diverge. An
  // absent target is the normal create case and is not a symlink.
  try {
    if (lstatSync(full).isSymbolicLink()) return null;
  } catch {
    /* absent target: nothing to be a symlink, proceed */
  }
  return full;
}

// ── atomic write (exclusive tmp) ──────────────────────────────────────────────

/**
 * Atomic overwrite via tmp+rename, with the tmp path created EXCLUSIVELY (`wx`).
 * Exclusive create means a pre-planted tmp symlink cannot be followed out of the
 * vault. A random suffix keeps two applies from colliding on the tmp slot; a
 * failed rename cleans up the tmp it created.
 *
 * The parent directory is NOT created here. The caller creates it and then
 * re-validates containment, because `mkdirSync(recursive)` happily walks a symlink
 * that appeared after the last check.
 */
function atomicWrite(path, content) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { flag: 'wx' });
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/**
 * Read a target's current bytes, distinguishing absent (null) from unreadable
 * (undefined) so classifyFreshness can refuse to guess. Mirrors crystallize's own
 * readTarget, reimplemented here because that one is not exported.
 * @returns {string|null|undefined}
 */
function readTarget(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

// ── pure decision functions ───────────────────────────────────────────────────

/**
 * Classify the target's current bytes against the hash captured when the artifact
 * was parked: 'fresh' (unchanged), 'drifted' (changed since parked), or
 * 'unreadable' (cannot read what we would replace).
 *
 * NOTE on the null ambiguity: `currentAtProposalHash === null` means EITHER the
 * target was absent at park time OR it was unreadable then (crystallize records
 * `typeof disk === 'string' ? hashContent(disk) : null` for both). So "absent now
 * + null at park" classifies as 'fresh'. That is deliberate and loses no bytes: a
 * still-absent target has nothing to clobber, so it is not a data-loss case. The
 * shell separately announces "target absent, will be created" so the human is not
 * surprised by a create.
 *
 * @param {{current: string|null|undefined, currentAtProposalHash: string|null}} args
 * @returns {'fresh'|'drifted'|'unreadable'}
 */
export function classifyFreshness({ current, currentAtProposalHash }) {
  if (current === undefined) return 'unreadable';
  const nowHash = current === null ? null : hashProposalContent(current);
  return nowHash === (currentAtProposalHash ?? null) ? 'fresh' : 'drifted';
}

/**
 * The apply decision as a PURE function of the human's confirm and the target's
 * freshness. Kept separate (planMarkerDecision precedent) so a table test can
 * pin the branch priority without any IO.
 *
 * Order is load-bearing: 'unreadable' is checked BEFORE the confirm, so an
 * unreadable target aborts regardless of what the human typed (we must never
 * write over bytes we could not read). applyProposal returns early on
 * 'unreadable' rather than prompt into the void, so that branch is unreachable
 * from the CLI today; it stays because the refusal belongs to the decision
 * contract, not to one caller's ordering.
 *
 * @param {{confirmed: boolean, freshness: 'fresh'|'drifted'|'unreadable'}} args
 * @returns {{action: 'apply'|'abort', reason: string|null, warned?: boolean}}
 */
export function planApplyAction({ confirmed, freshness }) {
  if (freshness === 'unreadable') return { action: 'abort', reason: 'target-unreadable' };
  if (!confirmed) return { action: 'abort', reason: 'not-confirmed' };
  return { action: 'apply', reason: null, warned: freshness === 'drifted' };
}

/**
 * Replace terminal control characters with a visible placeholder.
 *
 * Both the proposed bytes and the target string come from a hand-editable
 * artifact, and the whole gate rests on the human trusting the diff they were
 * shown. Raw escape sequences could clear the screen, redraw a benign diff, or
 * hide added lines above the confirm prompt. Tabs and newlines are kept (they
 * carry real content); the rest of C0, DEL, and the C1 range are neutralized. C1
 * matters because it carries its own CSI introducer that redraws like ESC does.
 * Only the DISPLAY is sanitized: the bytes written to the target stay verbatim.
 */
function sanitizeForDisplay(text, { allowNewlines = true } = {}) {
  // eslint-disable-next-line no-control-regex
  const controls = allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/g
    : /[\u0000-\u001f\u007f\u0080-\u009f]/g;
  return String(text).replace(controls, '\ufffd');
}

/**
 * A minimal line diff of current vs proposed: common prefix/suffix are trimmed so
 * the human sees only the changed span, removed lines as `- ` and added as `+ `.
 * Not a full LCS; the goal is a legible review, not a patch format. Only
 * byte-equal line boundaries are trimmed, so the trim can neither hide a changed
 * line nor invent one.
 */
export function renderDiff(current, proposed) {
  const a = String(current ?? '').split('\n');
  const b = String(proposed).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out = [];
  for (let i = start; i < endA; i++) out.push(`- ${a[i]}`);
  for (let i = start; i < endB; i++) out.push(`+ ${b[i]}`);
  return out.length === 0 ? '(no textual difference)' : out.join('\n');
}

// ── audit log ─────────────────────────────────────────────────────────────────

/**
 * Append one JSONL line to `<hypoDir>/.cache/proposals/applied.log`. The `.log`
 * suffix keeps it out of listProposals' `.json`-only readdir scan. This is the
 * apply audit contract, so callers treat a failure here as FATAL, not
 * best-effort.
 *
 * appendFileSync follows a symlink, so a planted `applied.log -> /elsewhere` would
 * send the audit record out of the vault while apply still exits 0. Refuse a
 * symlinked log the same way the target path refuses one: throwing here is the
 * fail-loud the caller wants.
 */
function appendApplyLog(hypoDir, entry) {
  const logPath = join(proposalsDir(hypoDir), 'applied.log');
  mkdirSync(dirname(logPath), { recursive: true });
  try {
    if (lstatSync(logPath).isSymbolicLink()) {
      throw new Error(`audit log is a symlink, refusing to append: ${logPath}`);
    }
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e; // absent log is the normal first-apply case
  }
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

// ── interactive prompt ────────────────────────────────────────────────────────

/**
 * Default confirm prompt: readline over stdin, writing to stderr so stdout stays
 * clean for the diff / --json. Returns the typed line with surrounding whitespace
 * trimmed; the caller decides whether it matches the required `apply <id>` phrase.
 * Injectable so the runner can drive apply without a real TTY.
 */
async function defaultPrompt({ id, target }) {
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    process.stderr.write(
      `\nApply proposal ${id} to ${target}?\n` +
        `  This REPLACES the target with the proposed content shown above.\n` +
        `  Type exactly \`apply ${id}\` to confirm; anything else aborts.\n`,
    );
    return (await rl.question('confirm> ')).trim();
  } finally {
    rl.close();
  }
}

// ── actors (return { ok, code, ... }; main() maps code to exit) ────────────────

/**
 * Apply one proposal: whole-file replace the target with the parked content,
 * behind a fresh diff, a TTY gate, an explicit confirm, and a post-confirm
 * re-read guard. Returns a result object; never calls process.exit (that is
 * main()'s job, and the object is the test seam).
 *
 * @param {{hypoDir: string, id: string}} sel
 * @param {{isTTY?: boolean, prompt?: Function, stdout?: {write: Function},
 *          stderr?: {write: Function}, now?: () => string}} [io]
 */
export async function applyProposal({ hypoDir, id }, { isTTY, prompt, stdout, stderr, now } = {}) {
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  const clock = now ?? (() => new Date().toISOString());
  const tty = isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = prompt ?? defaultPrompt;

  // (1) validate + read the artifact: a bad id or missing artifact changes nothing
  if (!isValidProposalId(id)) {
    err.write(`✗ invalid proposal id: ${id}\n`);
    return { ok: false, code: 2, reason: 'invalid-id' };
  }
  const proposal = readProposal(hypoDir, id);
  if (!proposal) {
    err.write(`✗ no such proposal: ${id}\n`);
    return { ok: false, code: 2, reason: 'not-found' };
  }

  // (2) resolve + harden the target: null means unsafe, nothing is written
  const full = resolveTargetPath(hypoDir, proposal.target);
  if (!full) {
    const shown = sanitizeForDisplay(proposal.target, { allowNewlines: false });
    err.write(`✗ proposal target is unsafe or escapes the vault: ${shown}\n`);
    return { ok: false, code: 2, reason: 'unsafe-target' };
  }

  // Everything the artifact contributes to the terminal passes through this.
  const shownTarget = sanitizeForDisplay(proposal.target, { allowNewlines: false });

  // (3) FRESH re-read of the current bytes (spec: diff against current, not base)
  const current = readTarget(full);
  const freshness = classifyFreshness({
    current,
    currentAtProposalHash: proposal.currentAtProposalHash,
  });

  // Cannot read what we would replace: refuse before prompting.
  if (freshness === 'unreadable') {
    err.write(`✗ target is unreadable, refusing to apply: ${shownTarget}\n`);
    return { ok: false, code: 1, reason: 'target-unreadable' };
  }

  // (5) diff output: drift warning FIRST so the human re-reviews against fresh bytes.
  if (freshness === 'drifted') {
    out.write(`⚠️  target changed since this proposal was parked (${shownTarget}).\n`);
    out.write(`    The diff below is against the CURRENT on-disk bytes; applying REPLACES them.\n`);
  }
  if (current === null) {
    out.write(`(target absent, will be created: ${shownTarget})\n`);
  }
  out.write(`--- diff (current to proposed) for ${shownTarget} ---\n`);
  out.write(`${sanitizeForDisplay(renderDiff(current ?? '', proposal.proposedContent))}\n`);

  // (6) TTY gate BEFORE the prompt, so a non-interactive run rejects without hanging
  if (!tty) {
    err.write(
      `✗ apply requires an interactive terminal for confirmation. Aborted; target unchanged.\n`,
    );
    return { ok: false, code: 1, reason: 'not-tty' };
  }

  // (7) confirm: the human must type EXACTLY `apply <id>`: the sole write authority
  const typed = await ask({ id, target: shownTarget });
  const confirmed = typeof typed === 'string' && typed.trim() === `apply ${id}`;

  // (8) decide: abort preserves BOTH the target and the proposal
  const decision = planApplyAction({ confirmed, freshness });
  if (decision.action === 'abort') {
    err.write(`✗ apply aborted (${decision.reason}); target and proposal preserved.\n`);
    return { ok: false, code: 1, reason: decision.reason };
  }

  // (9+) the write itself, shared with the transcript-approved path. The approval
  // JUST established above is the only thing this path contributes; every byte that
  // reaches disk goes through the one primitive.
  return writeApprovedProposal(
    {
      hypoDir,
      id,
      proposal,
      full,
      displayedHash: current === null ? null : hashProposalContent(current),
    },
    {
      approval: { via: 'tty', nonce: null },
      warned: decision.warned,
      stdout: out,
      stderr: err,
      now: clock,
    },
  );
}

/**
 * Write ONE approved proposal to its target: the hardened write body, extracted so
 * the TTY path and the transcript-approved path cannot drift apart.
 *
 * This function does NOT decide whether the write is authorized. Its callers do, by
 * two different means (a typed `apply <id>` at a TTY; a typed, nonce-bound user turn
 * in the transcript), and they pass the outcome in as `approval`. What lives here is
 * everything that must hold no matter WHO approved: the post-approval re-validation,
 * the ordered write → audit-log → delete, and the sibling warning.
 *
 * The seams (`stdout`/`stderr`/`now`) stay injectable for tests, as before. They are
 * NOT an unattended-apply path: nothing here relaxes a check, and the callers are the
 * only authorization sites.
 *
 * @param {{hypoDir: string, id: string, proposal: object, full: string,
 *          displayedHash: string|null}} sel  `displayedHash` is the hash of the bytes
 *          whose diff the approver saw (null when the target was absent).
 * @param {{approval: {via: 'tty'|'transcript', nonce: string|null},
 *          warned?: boolean, stdout?: object, stderr?: object, now?: () => string}} io
 */
export function writeApprovedProposal(
  { hypoDir, id, proposal, full, displayedHash },
  { approval, warned, stdout, stderr, now } = {},
) {
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  const clock = now ?? (() => new Date().toISOString());
  const shownTarget = sanitizeForDisplay(proposal.target, { allowNewlines: false });

  // (9) POST-APPROVAL RE-VALIDATION. Nothing is locked while the approver reads, so
  // BOTH the path and the bytes can move between step 2/3 and the write. Checking
  // only the bytes would leave the path check stale: an ancestor that becomes a
  // symlink out of the vault during the prompt would still be walked by the write
  // below. So re-resolve first, then re-read.
  //
  // A residual race remains between these checks and the rename below. Re-resolving
  // NARROWS the window but does not close it: because every check operates on a
  // pathname and the write does too, an ancestor swapped to an out-of-vault symlink
  // in that final gap can still redirect the write. Closing it would need
  // component-wise openat / a lockfile, both of which the spec's guarantee scope
  // rules out (see the hostile-local-FS note there). An actor able to win that race
  // already has write access to every target directly, so it grants no new reach.
  const stillSafe = resolveTargetPath(hypoDir, proposal.target);
  if (!stillSafe || stillSafe !== full) {
    err.write(
      `✗ target path stopped resolving safely while you were reviewing; nothing written.\n`,
    );
    return { ok: false, code: 1, reason: 'unsafe-target' };
  }

  const afterConfirm = readTarget(full);
  const afterHash =
    afterConfirm === undefined
      ? undefined
      : afterConfirm === null
        ? null
        : hashProposalContent(afterConfirm);
  if (afterHash !== displayedHash) {
    err.write(
      `✗ target changed while you were reviewing; nothing written, proposal preserved. ` +
        `Re-run apply to review the fresh bytes.\n`,
    );
    return { ok: false, code: 1, reason: 'concurrent-mutation' };
  }

  // (10) write: a failure here is fail-loud and keeps the proposal for retry.
  // Creating the parent is its own hazard (`mkdirSync(recursive)` follows a symlink
  // planted since the check above), so containment is re-proven once the parent
  // exists and only then are the bytes written.
  try {
    mkdirSync(dirname(full), { recursive: true });
    if (resolveTargetPath(hypoDir, proposal.target) !== full) {
      throw new Error('target path escaped the vault while its parent was created');
    }
    atomicWrite(full, proposal.proposedContent);
  } catch (e) {
    // A filesystem error message embeds the path, so it can carry the artifact's
    // control characters back to the terminal; sanitize it like any shown field.
    const why = sanitizeForDisplay(e.message, { allowNewlines: false });
    err.write(`✗ failed to write ${shownTarget}: ${why}. Nothing changed; proposal preserved.\n`);
    return { ok: false, code: 1, reason: 'write-failed' };
  }

  // (11) audit log: FATAL on failure (it is the apply audit contract). Ordered
  // write→log→delete: the log never lies (recorded only after a real write), and a
  // log failure leaves the proposal alive so a re-apply self-heals the record.
  try {
    appendApplyLog(hypoDir, {
      id,
      target: proposal.target,
      currentHash: displayedHash,
      appliedAt: clock(),
      sessionId: proposal.sessionId ?? null,
      device: proposal.device ?? null,
      // Which authority approved this write, and (for the transcript channel) the
      // one-time nonce the user typed. The audit trail is the only place an
      // unattended apply, if one ever slipped in, would become visible — so the
      // channel is recorded on EVERY entry, not just the new one.
      via: approval?.via ?? 'tty',
      nonce: approval?.nonce ?? null,
    });
  } catch (e) {
    const why = sanitizeForDisplay(e.message, { allowNewlines: false });
    err.write(
      `✗ applied to disk but FAILED to write the audit log: ${why}. ` +
        `Proposal kept; re-run apply to complete the audit record.\n`,
    );
    return { ok: false, code: 1, reason: 'log-failed', applied: true };
  }

  // (12) remove the now-applied artifact: a leftover artifact is a non-zero exit
  if (!deleteProposal(hypoDir, id)) {
    err.write(`⚠️  applied and logged, but the proposal artifact was not removed: ${id}\n`);
    return { ok: false, code: 1, reason: 'artifact-not-removed', applied: true };
  }

  out.write(`✓ applied proposal ${id} to ${shownTarget}\n`);

  // (13) A target can carry one parked payload per session (plus any whose owner is
  // unidentifiable), so applying this id may leave another proposal for the same
  // file still pending. Say so, or the human reads "✓ applied" as done and meets the
  // leftover only via the next pending count. Never auto-delete it: destroying a
  // payload nobody reviewed is the clobber this store exists to prevent.
  const siblings = listProposals(hypoDir).filter((p) => p.target === proposal.target);
  if (siblings.length > 0) {
    const ids = siblings.map((p) => p.id).join(', ');
    err.write(
      `⚠️  ${siblings.length} other proposal(s) still target ${shownTarget}: ${ids}\n` +
        `    The write above changed that file, so each one now needs a fresh look. ` +
        `\`hypomnema proposal apply <id>\` re-reads the file and diffs against it; discard the ones you do not want.\n`,
    );
  }

  return {
    ok: true,
    code: 0,
    id,
    target: proposal.target,
    warned: Boolean(warned),
    siblingsPending: siblings.length,
  };
}

// ── transcript-approved batch (challenge → user types → resolve) ──────────────

/**
 * Mint an approval challenge for a batch of parked proposals: show the diffs the
 * user is being asked to approve, and record exactly what an approval would buy.
 *
 * The ids come from the CALLER (the close result), never from a scan of the store
 * by session. `writeProposal` reuses a byte-identical artifact across sessions and
 * the body's `sessionId` may then name a different session, so "the proposals of
 * this close" is not something the store can be asked for — only the close knows.
 *
 * The record binds, per item, the id AND the target path AND the proposed bytes AND
 * the target's current freshness. Binding fewer of those leaves a hole: the artifact
 * body is hand-editable and apply writes to whatever `target` says AT APPLY TIME, so
 * id+content alone would let the approved bytes land on a path the user never saw.
 *
 * An unreadable target refuses the whole batch rather than mint a challenge for a
 * diff nobody can be shown.
 *
 * @param {{hypoDir: string, sessionId: string, ids: string[]}} sel
 */
export function challengeProposals(
  { hypoDir, sessionId, ids },
  { stdout, stderr, now, nonce } = {},
) {
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  const clock = now ?? (() => new Date().toISOString());

  if (!isValidSessionId(sessionId)) {
    err.write(`✗ invalid --session-id\n`);
    return { ok: false, code: 2, reason: 'invalid-session-id' };
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    err.write(`✗ challenge needs --ids=<id,...> (the proposal ids the close reported)\n`);
    return { ok: false, code: 2, reason: 'no-ids' };
  }

  const items = [];
  for (const id of ids) {
    if (!isValidProposalId(id)) {
      err.write(`✗ invalid proposal id: ${id}\n`);
      return { ok: false, code: 2, reason: 'invalid-id' };
    }
    const proposal = readProposal(hypoDir, id);
    if (!proposal) {
      err.write(`✗ no such proposal: ${id}\n`);
      return { ok: false, code: 2, reason: 'not-found' };
    }
    const full = resolveTargetPath(hypoDir, proposal.target);
    if (!full) {
      const shown = sanitizeForDisplay(proposal.target, { allowNewlines: false });
      err.write(`✗ proposal target is unsafe or escapes the vault: ${shown}\n`);
      return { ok: false, code: 2, reason: 'unsafe-target' };
    }
    const current = readTarget(full);
    if (current === undefined) {
      const shown = sanitizeForDisplay(proposal.target, { allowNewlines: false });
      err.write(`✗ target is unreadable, refusing to mint a challenge for it: ${shown}\n`);
      return { ok: false, code: 1, reason: 'target-unreadable' };
    }

    const shownTarget = sanitizeForDisplay(proposal.target, { allowNewlines: false });
    if (current === null) out.write(`(target absent, will be created: ${shownTarget})\n`);
    out.write(`--- diff (current to proposed) for ${shownTarget} ---\n`);
    out.write(`${sanitizeForDisplay(renderDiff(current ?? '', proposal.proposedContent))}\n`);

    items.push({
      id,
      target: proposal.target,
      proposedHash: hashProposalContent(proposal.proposedContent),
      freshness:
        current === null
          ? { state: 'absent', hash: null }
          : { state: 'hash', hash: hashProposalContent(current) },
    });
  }

  // crypto-random, never Math.random: an approval token a hook could PREDICT would
  // let it pre-plant the phrase and spend an approval the user never gave.
  const minted = nonce ?? randomBytes(16).toString('hex');
  const record = { nonce: minted, sessionId, mintedAt: clock(), items };
  if (!writeChallenge(hypoDir, record)) {
    err.write(
      `✗ failed to store the approval challenge; nothing to approve.\n` +
        `    A stale challenge for this session may be undeletable. Check and clear:\n` +
        `        ${join(proposalsDir(hypoDir), 'challenges')}/${sessionId}.*.json\n`,
    );
    return { ok: false, code: 1, reason: 'challenge-store-failed' };
  }

  out.write(
    `\nTo approve the ${items.length} overwrite(s) above, the USER must type this line in the conversation:\n\n` +
      `    ${APPROVAL_PHRASE} ${minted}\n\n` +
      `Then run: hypomnema proposal resolve --session-id=${sessionId}\n`,
  );
  return {
    ok: true,
    code: 0,
    nonce: minted,
    items: items.map(({ id, target }) => ({ id, target })),
  };
}

/**
 * Apply a batch of parked proposals that the user approved by typing the challenge
 * phrase in the conversation.
 *
 * The authorization is the transcript, not this process's stdin: `hasTypedUserApproval`
 * requires a genuine user-typed turn carrying the nonce minted for THIS challenge. A
 * hook cannot forge a user turn, and the model's own output is role:assistant and is
 * never counted. That is the whole of the human gate; it is not weakened here, it is
 * relocated.
 *
 * Everything is preflighted before ANY byte is written, so a refusal is total. The
 * one partial case left is a failure part-way through the writes, and that is
 * reported per target rather than swallowed: a re-close idempotent-skips whatever
 * landed and re-parks the rest, so silence would be the only unrecoverable part.
 *
 * @param {{hypoDir: string, sessionId: string}} sel
 */
export function resolveProposals(
  { hypoDir, sessionId },
  { stdout, stderr, now, transcriptPath, hasApproval } = {},
) {
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  const clock = now ?? (() => new Date().toISOString());
  const approves = hasApproval ?? hasTypedUserApproval;

  if (!isValidSessionId(sessionId)) {
    err.write(`✗ invalid --session-id\n`);
    return { ok: false, code: 2, reason: 'invalid-session-id' };
  }

  // (1) the challenge. Absent / corrupt / not-owned all mean "no approval exists",
  // which is a REMINT, never a bypass.
  const challenge = readChallenge(hypoDir, sessionId);
  if (!challenge) {
    err.write(
      `✗ no valid approval challenge for this session. Run \`hypomnema proposal challenge\` first.\n`,
    );
    return { ok: false, code: 1, reason: 'no-challenge' };
  }

  // (2) the transcript approval. Resolve the transcript from the session id (fail-closed
  // on zero or multiple matches), then require the user's typed, nonce-bearing turn.
  const tPath = transcriptPath ?? resolveTranscriptBySessionId(sessionId);
  if (!tPath) {
    err.write(`✗ cannot resolve a transcript for session ${sessionId}; approval unverifiable.\n`);
    return { ok: false, code: 1, reason: 'transcript-unresolved' };
  }
  if (!approves(tPath, challenge.nonce)) {
    err.write(
      `✗ no user approval in this session's transcript.\n` +
        `    The user must TYPE this line in the conversation (a click does not count):\n` +
        `        ${APPROVAL_PHRASE} ${challenge.nonce}\n` +
        `    Nothing written; the proposals are preserved.\n`,
    );
    return { ok: false, code: 1, reason: 'not-approved' };
  }

  // (3) PREFLIGHT every item against what was approved. Any drift refuses the WHOLE
  // batch: the user approved a set, not a subset, and a partial write of a set they
  // reviewed as a unit is not what they said yes to.
  const plan = [];
  for (const item of challenge.items) {
    const proposal = readProposal(hypoDir, item.id);
    if (!proposal) {
      err.write(`✗ approved proposal ${item.id} is gone; re-run challenge. Nothing written.\n`);
      return { ok: false, code: 1, reason: 'proposal-missing' };
    }
    // The artifact body is untrusted and hand-editable. The user approved THESE bytes
    // going to THIS path; a body that changed either since the diff is a different
    // write than the one that was approved.
    if (proposal.target !== item.target) {
      err.write(
        `✗ proposal ${item.id} now targets a different path than the one approved; nothing written.\n`,
      );
      return { ok: false, code: 1, reason: 'target-changed' };
    }
    if (hashProposalContent(proposal.proposedContent) !== item.proposedHash) {
      err.write(`✗ proposal ${item.id} content changed since it was approved; nothing written.\n`);
      return { ok: false, code: 1, reason: 'content-changed' };
    }
    const full = resolveTargetPath(hypoDir, proposal.target);
    if (!full) {
      err.write(`✗ proposal ${item.id} target is unsafe or escapes the vault; nothing written.\n`);
      return { ok: false, code: 1, reason: 'unsafe-target' };
    }
    // Freshness: the bytes on disk must still be the bytes whose diff was shown.
    // absent and empty are DIFFERENT states and are not collapsed.
    const current = readTarget(full);
    const state = current === undefined ? 'unreadable' : current === null ? 'absent' : 'hash';
    const hash = state === 'hash' ? hashProposalContent(current) : null;
    if (state !== item.freshness.state || hash !== (item.freshness.hash ?? null)) {
      const shown = sanitizeForDisplay(proposal.target, { allowNewlines: false });
      err.write(
        `✗ ${shown} changed since you were shown its diff; nothing written.\n` +
          `    Re-run \`hypomnema proposal challenge\` to review the fresh bytes.\n`,
      );
      return { ok: false, code: 1, reason: 'stale-approval' };
    }
    plan.push({ item, proposal, full, displayedHash: hash });
  }

  // (4) SPEND THE CHALLENGE, THEN WRITE. The order is the security property, not a
  // style choice. The approval lives in the transcript, which is append-only: the
  // user's typed line never expires, so `hasTypedUserApproval` keeps returning true
  // for the rest of the session. Deleting the challenge is therefore the ONLY thing
  // that makes the approval single-use — and a delete that runs AFTER the writes has
  // already lost. If it failed there, the nonce stayed spendable and the model (whom
  // this whole gate exists not to trust) could re-run `resolve` on a later turn and
  // write again with no fresh human turn. Exiting non-zero announced that hole; it
  // did not close it.
  //
  // Spending first closes it: on any later failure the challenge is already gone, so
  // a re-run hits `no-challenge`, remints, and asks the user again. The cost is that
  // a transient write failure now costs a re-approval instead of a silent retry. For
  // a gate that guards someone's file, that is the right direction to fail.
  //
  // Nothing downstream reads the challenge: `plan` is fully resolved in memory above.
  //
  // consumeChallenge answers "did I spend THIS nonce", not "is the session's challenge
  // file gone" — the unlink is what makes concurrent resolvers mutually exclusive, and
  // only the one whose unlink SUCCEEDED may write. It is handed the nonce this run
  // actually read and verified, so it can never consume a fresher record that a
  // concurrent `challenge` minted in its place.
  if (!consumeChallenge(hypoDir, sessionId, challenge.nonce)) {
    err.write(
      `✗ could not consume the approval challenge for ${sessionId}; nothing written.\n` +
        `    Either it was already spent (or superseded by a newer challenge), or it could\n` +
        `    not be removed and would stay replayable. Either way this run has no approval\n` +
        `    to write against. If the file is still there, remove it by hand and re-run the\n` +
        `    close:\n` +
        `        ${join(proposalsDir(hypoDir), 'challenges', `${sessionId}.${challenge.nonce}.json`)}\n`,
    );
    return {
      ok: false,
      code: 1,
      reason: 'challenge-not-consumed',
      written: [],
      challengeSpent: false,
    };
  }

  // (5) write. Preflight passed for every item, so the only failure left is a write
  // that breaks mid-batch. Report exactly what landed: a re-close idempotent-skips
  // the written targets and re-parks the rest, so a reported partial recovers and a
  // SILENT one does not.
  const written = [];
  const failed = [];
  for (const { item, proposal, full, displayedHash } of plan) {
    const res = writeApprovedProposal(
      { hypoDir, id: item.id, proposal, full, displayedHash },
      {
        approval: { via: 'transcript', nonce: challenge.nonce },
        warned: false,
        stdout: out,
        stderr: err,
        now: clock,
      },
    );
    if (res.ok) written.push(item.target);
    else failed.push({ target: item.target, reason: res.reason, applied: Boolean(res.applied) });
  }

  // The challenge is already spent, so a partial batch cannot be finished by re-running
  // `resolve` — and it should not be. Re-running the CLOSE is the recovery path: it
  // idempotent-skips whatever landed and re-parks the rest for a fresh approval.
  if (failed.length > 0) {
    // Report by what HIT THE PAGE, not by what returned ok. A write can land and then
    // have its audit-log append or its artifact removal fail (`applied: true, ok: false`),
    // and reporting that item as unwritten would tell the user their file is untouched
    // when it has already been overwritten. This tool must never understate a write.
    const landed = [...written, ...failed.filter((f) => f.applied).map((f) => f.target)];
    err.write(
      `\n✗ batch partially applied.\n` +
        `    Landed on the page: ${landed.length ? landed.join(', ') : '(none)'}\n` +
        `    Failed: ${failed.map((f) => `${f.target} (${f.reason})`).join(', ')}\n` +
        `    A page can appear in both: its bytes landed, then a post-write step failed.\n` +
        `    The approval is spent. Re-run the session close: it skips what already landed\n` +
        `    and re-parks the rest, which mints a fresh challenge to approve.\n`,
    );
    return {
      ok: false,
      code: 1,
      reason: 'partial-apply',
      written,
      landed,
      failed,
      challengeSpent: true,
    };
  }

  out.write(`✓ applied ${written.length} approved proposal(s).\n`);
  out.write(`  The session is NOT closed yet: re-run the close and check markerWritten.\n`);
  return { ok: true, code: 0, written, challengeSpent: true };
}

/**
 * Discard one proposal: remove the artifact, leave the target untouched. No
 * confirm gate (the spec defines discard as a plain removal, and it writes nothing
 * to any page).
 */
export function discardProposal({ hypoDir, id }, { stdout, stderr } = {}) {
  const out = stdout ?? process.stdout;
  const err = stderr ?? process.stderr;
  if (!isValidProposalId(id)) {
    err.write(`✗ invalid proposal id: ${id}\n`);
    return { ok: false, code: 2, reason: 'invalid-id' };
  }
  const proposal = readProposal(hypoDir, id);
  if (!proposal) {
    err.write(`✗ no such proposal: ${id}\n`);
    return { ok: false, code: 2, reason: 'not-found' };
  }
  if (!deleteProposal(hypoDir, id)) {
    err.write(`✗ failed to remove proposal ${id}\n`);
    return { ok: false, code: 1, reason: 'delete-failed' };
  }
  const shown = sanitizeForDisplay(proposal.target, { allowNewlines: false });
  out.write(`✓ discarded proposal ${id} (target ${shown} left unchanged)\n`);
  return { ok: true, code: 0, id, target: proposal.target };
}

/**
 * List pending proposals (id, target, createdAt, plus session/device), oldest
 * first. `--json` emits the array; the human form prints one line each, or a
 * "no pending proposals" notice.
 */
export function listPending({ hypoDir }, { stdout, json } = {}) {
  const out = stdout ?? process.stdout;
  const items = listProposals(hypoDir)
    .map((p) => ({
      id: p.id,
      target: p.target,
      createdAt: p.createdAt ?? null,
      sessionId: p.sessionId ?? null,
      device: p.device ?? null,
    }))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  if (json) {
    out.write(`${JSON.stringify(items, null, 2)}\n`);
    return { ok: true, code: 0, count: items.length };
  }
  if (items.length === 0) {
    out.write('no pending proposals\n');
    return { ok: true, code: 0, count: 0 };
  }
  // Every field but `id` (validated by listProposals) comes from the artifact body
  // and is shown one line each, so all of them pass through the display sanitizer.
  const clean = (v) => sanitizeForDisplay(String(v), { allowNewlines: false });
  for (const it of items) {
    const who = it.sessionId
      ? `  (session ${clean(it.sessionId)}, ${clean(it.device ?? '?')})`
      : '';
    out.write(`${it.id}  ${clean(it.target)}  ${clean(it.createdAt)}${who}\n`);
  }
  return { ok: true, code: 0, count: items.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, cmd: null, id: null, json: false, sessionId: null, ids: [] };
  const positionals = [];
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--hypo-dir') args.hypoDir = expandHome(rest[++i] ?? '');
    else if (a.startsWith('--hypo-dir=')) args.hypoDir = expandHome(a.slice('--hypo-dir='.length));
    else if (a === '--json') args.json = true;
    else if (a === '--session-id') args.sessionId = rest[++i] ?? null;
    else if (a.startsWith('--session-id=')) args.sessionId = a.slice('--session-id='.length);
    else if (a === '--ids') args.ids = splitIds(rest[++i] ?? '');
    else if (a.startsWith('--ids=')) args.ids = splitIds(a.slice('--ids='.length));
    else positionals.push(a);
  }
  args.cmd = positionals[0] ?? null;
  args.id = positionals[1] ?? null;
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

/** `--ids=a,b,c` → ['a','b','c']; blanks dropped so a trailing comma is not an id. */
function splitIds(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv);
  let result;
  switch (args.cmd) {
    case 'list':
      result = listPending({ hypoDir: args.hypoDir }, { stdout: process.stdout, json: args.json });
      break;
    case 'apply':
      if (!args.id) {
        process.stderr.write('✗ usage: hypomnema proposal apply <id>\n');
        process.exit(2);
      }
      result = await applyProposal({ hypoDir: args.hypoDir, id: args.id }, {});
      break;
    case 'challenge':
      result = challengeProposals(
        { hypoDir: args.hypoDir, sessionId: args.sessionId, ids: args.ids },
        {},
      );
      break;
    case 'resolve':
      result = resolveProposals({ hypoDir: args.hypoDir, sessionId: args.sessionId }, {});
      break;
    case 'discard':
      if (!args.id) {
        process.stderr.write('✗ usage: hypomnema proposal discard <id>\n');
        process.exit(2);
      }
      result = discardProposal({ hypoDir: args.hypoDir, id: args.id }, {});
      break;
    default:
      process.stderr.write(
        'usage: hypomnema proposal <list|apply|discard> [id] [--json] [--hypo-dir <path>]\n' +
          '       hypomnema proposal challenge --session-id <id> --ids <id,...>\n' +
          '       hypomnema proposal resolve --session-id <id>\n',
      );
      process.exit(2);
  }
  process.exit(result.code ?? (result.ok ? 0 : 1));
}

function isMain() {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}
