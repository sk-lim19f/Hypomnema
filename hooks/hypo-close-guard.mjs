#!/usr/bin/env node
/**
 * hypo-close-guard.mjs — PreToolUse hook
 *
 * SCOPE: this guard closes the direct Write/Edit/MultiEdit bypass only. A write
 * executed via Bash (shell redirection, sed, a script) never reaches
 * PreToolUse's tool_input inspection and is out of scope. The regular
 * `/hypo:crystallize --apply-session-close` path runs via Bash, so it neither
 * trips this guard nor needs to.
 *
 * Two kinds of path are closed to a direct write, and the answer is a deny, not
 * an ask:
 *
 * - A generated view (`hot.md`, `projects/<slug>/hot.md`,
 *   `projects/<slug>/session-state.md`). The close apply renders these from the
 *   session entries, so a hand write is overwritten on the next close and
 *   forks the entries from what the view says. The deny holds in a vault that
 *   has not moved to session entries yet too: the apply does not write a
 *   tracked view there, so a direct write would not be rebuilt but would not be
 *   an entry either.
 * - A session entry (`projects/<slug>/sessions/<file>.md`). Only the close
 *   apply creates an entry and nothing edits one afterwards, so a create and an
 *   edit are both refused.
 *
 * Every other path passes without output. That includes a sub-track page such
 * as `projects/<slug>/platform/session-state.md`: it is an ordinary page the
 * model keeps by hand, not a generated view.
 *
 * CASE FOLDING: macOS's default volume is case-insensitive, so a write to
 * `projects/foo/HOT.md` targets the same file `hot.md` does. The path
 * predicates are case-sensitive, so the guard also asks them about the
 * lowercased path.
 *
 * NO EXPLICIT ALLOW: `permissionDecision: "allow"` is not "stay quiet". It
 * tells Claude Code to bypass the user's normal permission prompt for this tool
 * call outright. This hook has no matcher (see NO MATCHER below), so it runs in
 * front of every tool call, Bash included; an explicit allow anywhere would
 * auto-approve prompts this guard has no business touching. Every pass-through
 * path prints nothing and exits 0. Only a deny ever writes to stdout.
 *
 * A broken hook (unparseable stdin, an unexpected exception) also exits
 * silently: a broken guard must never block the user's actual work.
 *
 * NO MATCHER: this hook is registered under PreToolUse with no matcher (this
 * repo's installer does not carry matchers through to settings, see
 * scripts/init.mjs's `_extractFileNames`, and no other hook here uses one
 * either), so it runs on every tool call. The early-return order below exists
 * for exactly that: a non-write tool, or a write outside HYPO_DIR, returns
 * before anything else runs.
 */

import { realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'path';
import { HYPO_DIR, isGateSkipped } from './hypo-shared.mjs';
import { isGeneratedViewPath, isSessionEntryPath } from './session-entries.mjs';

// Mirrors hypo-auto-stage.mjs's WRITE_TOOLS: the tools that replace file bytes.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

const GENERATED_DENY =
  '생성 파일입니다. close payload의 summary/tracks로 기록하세요 (직접 쓰면 다음 close가 덮어씁니다).';
const ENTRY_DENY = '원본 항목은 close apply만 만들고 고치지 않습니다.';

// The vault-relative spellings of `filePath` that are inside `root`: the path as given and, when
// the files exist, their real paths (a symlinked vault written through its real path). A string
// prefix test is not used: a trailing separator on HYPO_DIR or a symlink would switch it off.
function insideRelatives(root, filePath) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const pairs = [[root, filePath]];
  const realRoot = real(root);
  // A file that does not exist yet (a create) is resolved through its parent directory.
  const realParent = real(dirname(filePath));
  const realFile =
    real(filePath) ?? (realParent === null ? null : join(realParent, basename(filePath)));
  if (realRoot !== null && realFile !== null) pairs.push([realRoot, realFile]);
  return pairs
    .map(([r, f]) => relative(r, f))
    .filter((rel) => rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel))
    .map((rel) => rel.replace(/\\/g, '/'));
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
  // The hook ITSELF failed to read its own input. Stay silent (see NO
  // EXPLICIT ALLOW above); never write a permission decision over garbage.
  process.stderr.write(`[hypo-close-guard] error: ${err?.message ?? String(err)}\n`);
  process.exit(0);
}

try {
  if (isGateSkipped() || !WRITE_TOOLS.has(input.tool_name)) {
    process.exit(0);
  }

  const filePath = input.tool_input?.file_path ?? '';
  if (!filePath || !isAbsolute(filePath)) process.exit(0);

  const root = HYPO_DIR.replace(/[\\/]+$/, '') || HYPO_DIR;
  let rel = null;
  let reason = null;
  for (const candidate of insideRelatives(root, filePath)) {
    const spellings = [candidate, candidate.toLowerCase()];
    reason = spellings.some(isGeneratedViewPath)
      ? GENERATED_DENY
      : spellings.some(isSessionEntryPath)
        ? ENTRY_DENY
        : null;
    if (reason !== null) {
      rel = candidate;
      break;
    }
  }
  if (reason === null) process.exit(0);

  console.log(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[WIKI CLOSE GUARD] ${rel}: ${reason}\nTo bypass: set HYPO_SKIP_GATE=1`,
      },
    }),
  );
} catch (err) {
  // The hook ITSELF broke (unexpected exception). Stay silent, same as the
  // stdin-parse failure above.
  process.stderr.write(`[hypo-close-guard] error: ${err?.message ?? String(err)}\n`);
}
