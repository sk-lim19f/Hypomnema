#!/usr/bin/env node
/**
 * hypo-close-guard.mjs — PreToolUse hook
 *
 * SCOPE: this guard closes the direct Write/Edit/MultiEdit bypass only — it is
 * not a general unauthorized-close catcher. A write executed via Bash (shell
 * redirection, sed, a script) never reaches PreToolUse's tool_input inspection
 * and is out of scope. The regular `/hypo:crystallize --apply-session-close`
 * path runs via Bash and already validates the transcript's close signal
 * before it writes, so it neither trips this guard nor needs to.
 *
 * Intercepts a Write/Edit/MultiEdit BEFORE it lands, when it targets one of the
 * two close-artifact files (session-state.md, hot.md). doctor's
 * detectSessionCloseArtifact (hypo-shared.mjs, post-hoc) only ever sees a file
 * AFTER the write, and only fires on 마감/종료 vocabulary — a wordless full
 * rewrite (the 2026-07-28 hot.md incident) reads clean to it, because there is
 * no prior version to diff against.
 *
 * Here there is no such blind spot: the PRIMARY signal is structural, not
 * lexical. recordTouchedPaths (populated by hypo-auto-stage's PostToolUse,
 * which has already run for every earlier write this session) already tracks
 * which close-artifact file(s) this session wrote. If the write in front of us
 * targets one of a project's pair (projects/<slug>/session-state.md,
 * projects/<slug>/hot.md) and the OTHER one is already in that set, this
 * session is rewriting both — regardless of what either file's text says. The
 * pair is scoped to the SAME project directory on purpose: pairing by basename
 * alone would fire on the root hot.md (which every session's Stop-chain
 * hypo-hot-rebuild.mjs legitimately rewrites) against an unrelated project's
 * session-state.md — a false positive, not a close. Root hot.md is therefore
 * never a structural pair member; it can still trip the lexical signal below
 * if it is literally rewritten with 마감/종료 wording.
 *
 * KNOWN WINDOW: the structural signal is only alive for one turn. Stop's
 * auto-commit chain (hypo-auto-commit.mjs → commitTouchedPaths) commits and
 * then CLEARS a session's touched-paths set every time Stop runs. Write
 * session-state.md in turn 1 and hot.md in turn 2 (Stop runs in between) and
 * the touched-paths file no longer has the first path — structuralHit reads
 * false. This is accepted, not fixed: a real close writes both files in the
 * same turn (see the JSDoc coverage note in hypo-shared.mjs's
 * detectSessionCloseArtifact), so the main path is still caught; a fresh
 * cross-turn persistence store is out of this guard's scope. Once the window
 * closes, only the lexical signal (detectSessionCloseArtifact on the write's
 * own new text) can still catch a close. See the test that pins this window
 * (using the real commitTouchedPaths path, not a bare drain) in
 * tests/close-hooks-gate.test.mjs.
 *
 * CASE FOLDING: the basename gate and the structural pairing comparison below
 * are lowercase-folded. macOS's default volume is case-insensitive, so a write
 * to `projects/foo/HOT.md` targets the same file `hot.md` does, and comparing
 * basenames verbatim would read it as "not a close-artifact file" and skip the
 * structural check entirely. This folding covers only OUR OWN comparisons;
 * detectSessionCloseArtifact (hypo-shared.mjs, untouched here) does its own
 * case-sensitive basename check internally, so a case-varied write can still
 * dodge the LEXICAL signal — but the structural signal does not depend on file
 * content at all, so it still catches it.
 *
 * detectSessionCloseArtifact runs as a SECONDARY trigger regardless of the
 * structural outcome, so a lone wordy close is caught before its pair even
 * lands, and the two defenses share one definition of "close" instead of
 * drifting apart.
 *
 * UNDECIDABLE vs BROKEN: the structural signal reads the session's
 * touched-paths cache directly (readTouchedPathsOrUndecidable below), not via
 * hypo-shared's peekTouchedPaths, because peekTouchedPaths collapses a lock
 * timeout, a corrupt cache file, AND a genuinely-empty session into the exact
 * same `[]` — indistinguishable from the caller's side. Folding all three into
 * "no structural signal, allow" would let a wordless close slip through
 * exactly when this guard's own bookkeeping is unreliable, which is the worst
 * moment for it to go quiet. So an undecidable read (lock timeout / corrupt
 * cache / no session_id) is instead treated as a HIT — it folds into the same
 * `ask` branch as a genuine structural match. This is deliberately distinct
 * from the hook ITSELF breaking (unparseable stdin, an unexpected exception):
 * that still exits silently below, because a broken guard must never block
 * the user's actual work. readTouchedPathsOrUndecidable is built from the same
 * exported primitives peekTouchedPaths itself uses (withFileLock,
 * touchedPathsPath) — no new read-only API was added to hypo-shared.mjs for
 * this.
 *
 * NO EXPLICIT ALLOW: `permissionDecision: "allow"` is not "stay quiet" — it
 * tells Claude Code to bypass the user's NORMAL permission prompt for this
 * tool call outright. This hook has no matcher (see NO MATCHER below), so it
 * runs in front of every tool call, Bash included; printing an explicit allow
 * anywhere would auto-approve permission prompts this guard has no business
 * touching, which is the opposite of what a "confirm before a close" guard is
 * for. So every pass-through path below prints NOTHING and exits 0, leaving
 * Claude Code's normal permission policy exactly as it was. Only a genuine
 * `ask` hit ever writes to stdout.
 *
 * A hit is never a deny. The hook only ASKS
 * (hookSpecificOutput.permissionDecision = "ask") — the harness turns that into
 * a confirmation in front of the write; approval stays with the human.
 *
 * NO MATCHER: this hook is registered under PreToolUse with no matcher (this
 * repo's installer does not carry matchers through to settings — see
 * scripts/init.mjs's `_extractFileNames` — and no other hook here uses one
 * either), so it runs on every tool call. The early-return order below exists
 * for exactly that: a non-write tool, or a write outside HYPO_DIR, returns
 * before anything else runs.
 */

import { existsSync, readFileSync } from 'fs';
import { relative } from 'path';
import {
  HYPO_DIR,
  detectSessionCloseArtifact,
  isCloseGateOpen,
  isGateSkipped,
  touchedPathsPath,
  withFileLock,
} from './hypo-shared.mjs';

const CLOSE_ARTIFACT_BASENAMES = new Set(['session-state.md', 'hot.md']);
// Mirrors hypo-auto-stage.mjs's WRITE_TOOLS: the tools that replace file bytes.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

// The write's own new text. Write carries the whole file; Edit/MultiEdit carry
// only the replaced snippet(s) — good enough for detectSessionCloseArtifact,
// which matches a single bold heading line, not the whole document.
function newTextOf(toolName, toolInput) {
  if (toolName === 'Write') {
    return typeof toolInput?.content === 'string' ? toolInput.content : '';
  }
  if (toolName === 'Edit') {
    return typeof toolInput?.new_string === 'string' ? toolInput.new_string : '';
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput?.edits)) {
    return toolInput.edits
      .map((e) => (typeof e?.new_string === 'string' ? e.new_string : ''))
      .join('\n');
  }
  return '';
}

// See "UNDECIDABLE vs BROKEN" above. `{ok: true, paths}` on a clean read
// (including a genuinely absent file — never touched this session, not an
// error); `{ok: false}` when the read cannot be trusted (no session_id, a
// corrupt/non-array cache file, or a lock timeout).
function readTouchedPathsOrUndecidable(hypoDir, sessionId) {
  if (!sessionId) return { ok: false };
  const path = touchedPathsPath(hypoDir, sessionId);
  try {
    return withFileLock(path, () => {
      if (!existsSync(path)) return { ok: true, paths: [] };
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8'));
        if (!Array.isArray(parsed)) return { ok: false }; // corrupt shape
        return { ok: true, paths: parsed.filter((p) => typeof p === 'string' && p) };
      } catch {
        return { ok: false }; // corrupt/unreadable JSON
      }
    });
  } catch {
    return { ok: false }; // lock timeout
  }
}

let input = {};
try {
  const raw = await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });
  input = JSON.parse(raw);
} catch (err) {
  // The hook ITSELF failed to read its own input — stay silent (see NO
  // EXPLICIT ALLOW above); never write a permission decision over garbage.
  process.stderr.write(`[hypo-close-guard] error: ${err?.message ?? String(err)}\n`);
  process.exit(0);
}

try {
  if (isGateSkipped() || !WRITE_TOOLS.has(input.tool_name)) {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? '';
  if (!filePath || !(filePath === HYPO_DIR || filePath.startsWith(HYPO_DIR + '/'))) {
    process.exit(0);
  }

  const rel = relative(HYPO_DIR, filePath);
  const relParts = rel.split(/[\\/]/);
  const base = relParts[relParts.length - 1];
  const baseLower = base.toLowerCase();
  if (!CLOSE_ARTIFACT_BASENAMES.has(baseLower)) {
    process.exit(0);
  }

  // Structural signal (primary): the OTHER close-artifact file of the SAME
  // project already written this session — projects/<slug>/session-state.md
  // paired with projects/<slug>/hot.md ONLY (case-folded). A root hot.md
  // (relParts.length !== 3, or not under "projects/") is never a pair member.
  const otherBaseLower = baseLower === 'hot.md' ? 'session-state.md' : 'hot.md';
  let structuralHit = false;
  let structuralUndecidable = false;
  if (relParts.length === 3 && relParts[0].toLowerCase() === 'projects') {
    const otherPathLower = `${relParts[0].toLowerCase()}/${relParts[1].toLowerCase()}/${otherBaseLower}`;
    const touchedResult = readTouchedPathsOrUndecidable(HYPO_DIR, input.session_id);
    if (!touchedResult.ok) {
      structuralUndecidable = true; // see "UNDECIDABLE vs BROKEN" above
    } else {
      structuralHit = touchedResult.paths.some((p) => p.toLowerCase() === otherPathLower);
    }
  }

  // Lexical signal (secondary): same predicate doctor uses post-hoc, run here
  // on the write's own new text.
  const lexicalHit = detectSessionCloseArtifact({
    path: filePath,
    content: newTextOf(input.tool_name, input.tool_input),
  }).matched;

  if (!structuralHit && !structuralUndecidable && !lexicalHit) {
    process.exit(0);
  }

  if (isCloseGateOpen(input.transcript_path ?? null)) {
    process.exit(0);
  }

  const why = structuralUndecidable
    ? `whether session-state.md and hot.md are both being rewritten this session could not be determined (touched-paths cache unreadable or no session_id)`
    : structuralHit
      ? `both session-state.md and hot.md are being rewritten this session`
      : `this write reads as a close announcement (마감/종료 wording)`;

  console.log(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason:
          `[WIKI CLOSE GUARD] ${rel} — ${why}, but no user close signal was seen ` +
          `in this session. Confirm with the user before writing: did they actually ` +
          `ask to close the session?\n` +
          `To bypass: set HYPO_SKIP_GATE=1`,
      },
    }),
  );
} catch (err) {
  // The hook ITSELF broke (unexpected exception) — stay silent, same as the
  // stdin-parse failure above: a broken guard must never block real work.
  process.stderr.write(`[hypo-close-guard] error: ${err?.message ?? String(err)}\n`);
}
