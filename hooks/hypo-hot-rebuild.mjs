/**
 * hypo-hot-rebuild.mjs: Stop chain stage 1 (spawned by hypo-stop.mjs)
 *
 * Regenerates every generated view on each session end: `projects/<p>/hot.md`,
 * `projects/<p>/session-state.md` and the root `hot.md`, all rendered from the
 * session entries under `projects/*\/sessions/` (writeGeneratedViews in
 * session-views.mjs). SessionStart writes the root file and the current
 * project's views; this stage writes the rest, so a project another session
 * closed in the meantime is current by the time Stop finishes. The views are
 * untracked, so nothing here is claimed for the commit.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  computeSessionGrowth,
  formatGrowthMetrics,
  deriveRootLogEntries,
  recordTouchedPaths,
  writeRootHotHealthNotice,
} from './hypo-shared.mjs';
import { writeGeneratedViews } from './session-views.mjs';

const GROWTH_CACHE = join(HYPO_DIR, '.cache', 'last-session-growth.json');

// This stage runs BEFORE hypo-auto-commit, and what guarantees that is
// hypo-stop.mjs: Stop carries ONE registration, and its STAGES list spawns the
// four stages in order, each one waited on before the next starts. The four
// used to be four separate Stop registrations, which Claude Code runs in
// parallel, so this sentence was false for as long as it stood: auto-commit
// could take the vault lock and commit between this file's log.md write and the
// touched-paths claim at the bottom, leaving fresh log.md bytes uncommitted
// with no failure anywhere to show for it.
//
// Put either of these four back into hooks.json as its own Stop registration
// and the guarantee is gone again, silently: this file still writes, still
// claims, and still reports success, and nothing about the order is checked at
// runtime. tests/session-hooks.test.mjs pins it from the outside instead, by
// asserting that this stage's log.md reaches the commit auto-commit makes.
//
// This stage writes log.md (deriveRootLogEntries), which is hook-generated, not
// user Write/Edit, so hypo-auto-stage never sees it. Read session_id off stdin
// so whatever this stage writes still lands in the scoped commit's set; without
// this, a scope built from Write/Edit alone would silently drop it from every
// session's auto-commit.
let sessionId = null;
try {
  const raw = await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });
  const payload = JSON.parse(raw || '{}') || {};
  sessionId = payload.session_id || payload.sessionId || null;
} catch {
  sessionId = null;
}

/**
 * Regenerate every view. writeGeneratedViews owns the lock, the ownership check
 * and the health notices (a busy vault lock, a damaged `.gitignore` block, bytes
 * it did not write that it backed up), so there is nothing to report from its
 * result here. A vault that is not migrated is left alone. A thrown error is the
 * caller's to turn into a notice, since Stop's own stdout is suppressed and a
 * failure would otherwise be invisible until someone went looking at stderr.
 */
function rebuild() {
  // An install with no wiki at all (HYPO_DIR unresolved or absent) would hit
  // ENOENT on every Stop, forever, since this hook runs on every session end
  // regardless of whether a wiki exists.
  if (!existsSync(HYPO_DIR)) return;
  writeGeneratedViews(HYPO_DIR);
}

function emitGrowth() {
  if (!existsSync(HYPO_DIR)) return;
  const stats = computeSessionGrowth(HYPO_DIR);
  const line = formatGrowthMetrics('stop', stats);
  if (line) process.stderr.write(`${line}\n`);
  try {
    mkdirSync(join(HYPO_DIR, '.cache'), { recursive: true });
    writeFileSync(GROWTH_CACHE, JSON.stringify({ ...stats, ts: Date.now() }));
  } catch {}
}

try {
  rebuild();
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] error: ${err?.message ?? String(err)}\n`);
  writeRootHotHealthNotice(
    HYPO_DIR,
    `이전 세션 종료 시 세션 현황 파일 갱신 중 오류가 발생했습니다: ${err?.message ?? String(err)}`,
  );
}
// Auto-derive the root log.md session entry from each project's session-log
// heading (runs AFTER rebuild()). Best-effort: own try/catch.
let logEntriesAdded = 0;
try {
  logEntriesAdded = deriveRootLogEntries(HYPO_DIR);
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] log-derive error: ${err?.message ?? String(err)}\n`);
}
try {
  emitGrowth();
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] error: ${err?.message ?? String(err)}\n`);
}

// Feed this hook's own writes into the session's scoped auto-commit
// set (see the sessionId comment above). No-op without a session_id.
try {
  if (logEntriesAdded > 0) recordTouchedPaths(HYPO_DIR, sessionId, ['log.md']);
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] touched-paths error: ${err?.message ?? String(err)}\n`);
}

try {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
} catch {}
