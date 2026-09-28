#!/usr/bin/env node
/**
 * hypo-hot-rebuild.mjs: Stop chain stage 1 (spawned by hypo-stop.mjs)
 *
 * Rebuilds root hot.md as a projection on every session end: the row set and
 * every field come from a fresh directory scan of `projects/*\/hot.md`
 * (renderRootHotProjection in hypo-shared.mjs), never from parsing the
 * previous root file. Claude no longer manages this file by hand; a project
 * row exists exactly when that project has a hot.md, nothing more.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  computeSessionGrowth,
  formatGrowthMetrics,
  deriveRootLogEntries,
  recordTouchedPaths,
  writeRootHotProjection,
  writeRootHotHealthNotice,
  rootHotBackupRecoveryNotice,
} from './hypo-shared.mjs';

const GROWTH_CACHE = join(HYPO_DIR, '.cache', 'last-session-growth.json');

// This stage runs BEFORE hypo-auto-commit, and what guarantees that is
// hypo-stop.mjs: Stop carries ONE registration, and its STAGES list spawns the
// four stages in order, each one waited on before the next starts. The four
// used to be four separate Stop registrations, which Claude Code runs in
// parallel, so this sentence was false for as long as it stood: auto-commit
// could take the vault lock and commit between this file's write and the
// touched-paths claim at the bottom, leaving fresh hot.md/log.md bytes
// uncommitted with no failure anywhere to show for it.
//
// Put either of these four back into hooks.json as its own Stop registration
// and the guarantee is gone again, silently: this file still writes, still
// claims, and still reports success, and nothing about the order is checked at
// runtime. tests/session-hooks.test.mjs pins it from the outside instead, by
// asserting that this stage's hot.md reaches the commit auto-commit makes.
//
// This stage can write hot.md (rebuild) and log.md (deriveRootLogEntries), both
// hook-generated, not user Write/Edit, so hypo-auto-stage never sees them. Read
// session_id off stdin so whatever this stage writes still lands in the scoped
// commit's set; without this, a scope built from Write/Edit alone would
// silently drop these files from every session's auto-commit.
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
 * Rebuild root hot.md as a directory-scan projection. No
 * longer parses the previous root file's rows at all: the projection's row
 * set is decided entirely by `writeRootHotProjection` from
 * `projects/<slug>/hot.md` on disk, which is what lets a manually deleted row
 * come back. See hypo-shared.mjs's projection section for the generation
 * rules (blank date, not `|| today`; frontmatter `updated:` is the row-date
 * max, not today) and for the scanError / backup semantics this function
 * passes straight through.
 *
 * A scanError leaves a durable health notice for the next SessionStart to
 * surface, since this hook's own stdout is suppressed at the bottom of this
 * file and a Stop-time failure would otherwise be invisible until someone
 * went looking at stderr.
 * @param {string|null} sessionId
 * @returns {{written: boolean, scanError: boolean, lockTimeout: boolean, backedUp: boolean, backupPath: string|null, gitignoreUpdated: boolean, warnings: string[], content: string|null}}
 */
function rebuild(sessionId) {
  // Mirrors hypo-session-start.mjs's own existsSync(HYPO_DIR) guard around its
  // projection call. Without this, an install with no wiki at all (HYPO_DIR
  // unresolved or absent) hits ENOENT on every Stop, forever, since this hook
  // runs on every session end regardless of whether a wiki exists. The old
  // rebuild() had the same guard in spirit (`if (!existsSync(HOT_PATH)) return
  // false`), just against the file instead of the directory.
  if (!existsSync(HYPO_DIR)) {
    return {
      written: false,
      scanError: false,
      lockTimeout: false,
      backedUp: false,
      backupPath: null,
      gitignoreUpdated: false,
      warnings: [],
      content: null,
    };
  }
  // A read-error on the existing hot.md (BLOCKER fix) throws out of
  // writeRootHotProjection instead of silently overwriting it; the outer
  // try/catch around this whole rebuild() call already leaves a health
  // notice for that case, same as any other unexpected error here.
  // n1 fix: pass sessionId so this session's own digest lands in ITS OWN
  // receipt, not just the shared global ownership record (see
  // writeRootHotProjection's doc comment).
  const result = writeRootHotProjection(HYPO_DIR, undefined, sessionId);

  if (result.lockTimeout) {
    // BLOCKER fix: the projection writer holds the vault lock now, so a Stop
    // that overlaps another session's commit can find it taken. Nothing was
    // written and nothing is claimed below (that is gated on
    // `result.written`), so the only thing left to do is say so.
    writeRootHotHealthNotice(
      HYPO_DIR,
      '이전 세션 종료 시 루트 hot.md 를 갱신하지 못했습니다: 다른 세션이 이 저장소를 쓰는 중이라 잠금을 얻지 못했습니다. 이전 내용을 그대로 두었고, 다음 세션 시작이나 종료 때 다시 시도합니다.',
    );
  } else if (result.scanError) {
    writeRootHotHealthNotice(
      HYPO_DIR,
      `이전 세션 종료 시 루트 hot.md 갱신에 실패했습니다: projects/ 디렉터리를 읽을 수 없어 이전 파일을 그대로 두었습니다. 권한과 경로를 확인하고(\`ls -ld ${join(HYPO_DIR, 'projects')}\`), 고치면 다음 세션 시작이나 종료 때 자동으로 다시 시도합니다.`,
    );
  } else {
    // scanError and a written result never coexist (writeRootHotProjection
    // skips the write outright on a scanError), but a per-project warning and
    // a migration backup CAN both be true on the same write, so both must
    // land in the SAME notice call. writeRootHotHealthNotice holds exactly
    // one pending message: a second call before the first is ever consumed
    // silently replaces it (atomicWrite overwrites, it does not append), so
    // issuing it twice here would drop whichever ran first instead of
    // surfacing both.
    const lines = [];
    if (result.warnings.length > 0) {
      // major-1/3: a per-project read failure kept its row (blank date), but
      // Stop's own stdout is suppressed, so the reason still needs a durable
      // notice or it never reaches anyone.
      lines.push(
        `이전 세션 종료 시 루트 hot.md 갱신 중 일부 프로젝트를 읽지 못했습니다:\n${result.warnings.join('\n')}\n` +
          '해당 파일의 권한과 경로를 확인하면 다음 세션 시작이나 종료 때 자동으로 다시 읽습니다.',
      );
    }
    if (result.backedUp && result.backupPath) {
      // MAJOR fix (codex 3rd-tier finding 6): this used to name only the
      // backup filename, with no recovery guidance at all. The reader had
      // to already know NOT to copy it back onto root hot.md, and where the
      // content actually goes. Stop's own stdout is suppressed, so a backup
      // made here has no channel of its own besides this health notice,
      // consumed at the next SessionStart (same delivery path already used
      // for a scanError or a per-project warning above); before this fix
      // that was the ONE surface where the guidance never arrived.
      // rootHotBackupRecoveryNotice is the same sentence SessionStart's own
      // write site uses, verbatim, so the two writers cannot drift apart.
      lines.push(rootHotBackupRecoveryNotice(result.backupPath));
    }
    if (lines.length > 0) writeRootHotHealthNotice(HYPO_DIR, lines.join('\n\n'));
  }

  // This write used to advance the session's observed base for hot.md right
  // here, because the write bypasses the Write/Edit tool and hypo-auto-stage's
  // PostToolUse advanceBaseForWrite never sees it. That call is gone with root
  // hot.md itself: the file is no longer one of base-store's
  // `overwriteTargets`, so no session snapshots it, no close payload writes it,
  // and there is no base for this regeneration to keep honest. Advancing one
  // from here would MINT a guarded key that nothing ever compares, which is the
  // exact shape that produced a `base-mismatch` park on a file no human had
  // touched. If root hot.md ever needs a base again, it comes back through
  // `overwriteTargets`, not through a hook's own write.
  return result;
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

let hotResult = {
  written: false,
  scanError: false,
  lockTimeout: false,
  backedUp: false,
  backupPath: null,
  gitignoreUpdated: false,
  warnings: [],
  content: null,
};
try {
  hotResult = rebuild(sessionId);
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] error: ${err?.message ?? String(err)}\n`);
  writeRootHotHealthNotice(
    HYPO_DIR,
    `이전 세션 종료 시 루트 hot.md 갱신 중 오류가 발생했습니다: ${err?.message ?? String(err)}`,
  );
}
// Auto-derive the root log.md session entry from each project's session-log
// heading (runs AFTER rebuild() so root hot.md is already fresh and isn't itself
// counted as the project's open gate problem). Best-effort: own try/catch.
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
  const touched = [];
  if (hotResult.written) touched.push('hot.md');
  // The backup file itself is never claimed here: it is gitignored the
  // moment writeRootHotProjection creates it (ensureVaultGitignorePattern),
  // so nothing would ever stage or commit it anyway, and claiming a path git
  // will never see as changed just leaves a permanently-dropped stale entry.
  if (hotResult.gitignoreUpdated) touched.push('.gitignore');
  if (logEntriesAdded > 0) touched.push('log.md');
  if (touched.length > 0) {
    const claimed = recordTouchedPaths(HYPO_DIR, sessionId, touched);
    // A failed claim here means this hook's own writes just landed on disk
    // with nothing in this session's touched-paths set to bring them into
    // the auto-commit that runs right after this hook, the same orphan
    // hypo-session-start.mjs's own claim guards against, just on the Stop
    // side. There is no earlier point to claim it from at Stop (unlike
    // SessionStart, the touched paths are only known after rebuild() has
    // already run), so this leaves a health notice instead of a pre-write
    // guard.
    if (!claimed && hotResult.written) {
      writeRootHotHealthNotice(
        HYPO_DIR,
        `루트 hot.md 갱신 후 이번 세션의 커밋 범위 기록에 실패했습니다: ${touched.join(', ')} 가 미커밋 파일로 남을 수 있습니다.`,
      );
    }
  }
} catch (err) {
  process.stderr.write(`[hypo-hot-rebuild] touched-paths error: ${err?.message ?? String(err)}\n`);
}

try {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
} catch {}
