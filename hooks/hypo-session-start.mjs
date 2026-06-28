#!/usr/bin/env node
/**
 * hypo-session-start.mjs — SessionStart hook
 *
 * On session start:
 *   HIT  → cwd matches a project's working_dir → inject hot.md (2000 chars) + session-state.md (2000 chars)
 *   MISS → inject global hot.md pointer only (no fan-out to all projects)
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, spawn } from 'child_process';
import {
  HYPO_DIR,
  buildOutput,
  SESSION_STATE_NEXT_HEADINGS,
  formatGrowthMetrics,
  readSyncState,
  clearSyncState,
  readClearMarker,
  clearClearMarker,
  loadHypoIgnore,
  isIgnored,
  sessionMarkerPath,
  shouldSuggestProjectCreation,
  buildProjectSuggestionLine,
  recordSuggestionCooldown,
  sanitizeProjForPrompt,
  pickProjectByCwd,
  collectProjectWorkingDirs,
} from './hypo-shared.mjs';
import {
  defaultCachePath,
  detectChannel,
  readCache,
  cacheIsFresh,
  computeNotice,
  markNotified,
  isOptedOut,
  resolveCliOnPath,
  computeSiblingNotice,
  siblingAlreadyNotified,
  markSiblingNotified,
} from './version-check.mjs';

// Privacy guard: refuse to read+inject .hypoignore-matched
// wiki files into additionalContext. Without this, a user who lists
// `projects/private/hot.md` in .hypoignore would still see SECRET emit because
// session-start reads hot/state paths directly.
function readIfNotIgnored(path, maxChars, patterns) {
  if (!path) return null;
  if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return null;
  return readFileSync(path, 'utf-8').slice(0, maxChars);
}

// Directory of the running hook, and the install root one level up
// (<root>/hooks/...). The root is derived from the RUNNING hook path rather
// than ~/.claude/hypo-pkg.json so a dual install (npm + plugin) or a stale
// metadata file can't mislabel the channel (teams review (b), 2026-05-21).
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const ACTIVE_ROOT = dirname(HOOK_DIR);

function readInstalledVersion(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Update-notifier (teams-reviewed 2026-05-21). Reads ONLY the cache — never a
 * synchronous network call. When the cache is stale, fires a detached worker to
 * refresh it (shown next session). Fully best-effort: any failure returns ''.
 */
function buildUpdateNotice() {
  try {
    if (isOptedOut()) return '';
    const cachePath = defaultCachePath();

    let root = ACTIVE_ROOT;
    let version = readInstalledVersion(root);
    if (!version) {
      try {
        const meta = JSON.parse(readFileSync(join(homedir(), '.claude', 'hypo-pkg.json'), 'utf-8'));
        root = meta.pkgRoot || root;
        version = meta.pkgVersion || readInstalledVersion(root);
      } catch {
        /* fallback unavailable */
      }
    }
    if (!version) return '';

    const channel = detectChannel(root);
    const cache = readCache(cachePath);

    if (!cacheIsFresh(cache)) {
      try {
        const worker = join(HOOK_DIR, 'version-check-fetch.mjs');
        if (existsSync(worker)) {
          const child = spawn(process.execPath, [worker, cachePath], {
            detached: true,
            stdio: 'ignore',
          });
          // spawn() failures (EAGAIN/EMFILE/ENOENT) surface ASYNChronously on
          // the child's 'error' event — the try/catch above only catches the
          // synchronous throw. Without this listener an unhandled 'error' would
          // crash SessionStart, violating the best-effort contract.
          child.on('error', () => {});
          child.unref();
        }
      } catch {
        /* spawn is best-effort */
      }
    }

    const notice = computeNotice(cache, channel, version);
    if (!notice) return '';
    markNotified(cachePath, channel, notice.latest);
    return notice.line;
  } catch {
    return '';
  }
}

/**
 * Stale-sibling notice (ADR 0038, D3). The update-notifier above only knows
 * whether the ACTIVE install is behind latest — it is blind to an OLDER sibling
 * that owns the `hypomnema` bin on PATH. That sibling is the live footgun:
 * running `hypomnema init`/`upgrade` through it downgrades the active hooks.
 *
 * This is the ONLY surface that reaches a user already in that state, because it
 * runs from the (newer) active hook — `doctor` invoked via the stale CLI would
 * run the stale doctor. fs-only (no npm/which spawn). Throttled via the cache so
 * it nags once per (cliPath@cliVersion → activeVersion) tuple. Best-effort.
 */
function buildSiblingNotice() {
  try {
    if (isOptedOut()) return '';
    // Active install identity = hypo-pkg.json (what init/upgrade write). This is
    // the authoritative pkgRoot+version; ACTIVE_ROOT (~/.claude) has no package.json.
    let active = null;
    try {
      active = JSON.parse(readFileSync(join(homedir(), '.claude', 'hypo-pkg.json'), 'utf-8'));
    } catch {
      return ''; // no active metadata → nothing to compare a sibling against
    }
    if (!active || !active.pkgVersion) return '';
    const cli = resolveCliOnPath('hypomnema');
    const notice = computeSiblingNotice(cli, {
      pkgRoot: active.pkgRoot,
      version: active.pkgVersion,
    });
    if (!notice) return '';
    const cachePath = defaultCachePath();
    const cache = readCache(cachePath);
    if (siblingAlreadyNotified(cache, notice.key)) return '';
    markSiblingNotified(cachePath, notice.key);
    return notice.line;
  } catch {
    return '';
  }
}

const PROJECTS_DIR = join(HYPO_DIR, 'projects');
const GROWTH_CACHE = join(HYPO_DIR, '.cache', 'last-session-growth.json');

function readLastGrowthLine() {
  if (!existsSync(GROWTH_CACHE)) return '';
  try {
    const stats = JSON.parse(readFileSync(GROWTH_CACHE, 'utf-8'));
    return formatGrowthMetrics('start', stats);
  } catch {
    return '';
  }
}

/**
 * ADR 0022 amendment 2026-05-14: if the prior session ended
 * via `/clear`, hypo-session-end stashed its identity in `.cache/clear-marker.json`.
 * Read it (with 7-day stale guard), unlink it (one-shot), and return a
 * `[WIKI_AUTOCLOSE]` recovery line for additionalContext + stderr.
 *
 * @param {string|undefined} source SessionStart payload `source` field
 * @returns {string} recovery line, or '' when no recovery is needed
 */
function buildClearRecoveryLine(source) {
  if (source !== 'clear') return '';
  const marker = readClearMarker(HYPO_DIR);
  if (!marker) return '';
  clearClearMarker(HYPO_DIR);
  const prevId = marker.prev_session_id || 'unknown';
  const prevTr = marker.prev_transcript_path || null;
  const prevCwd = marker.prev_cwd || null;
  const trLine = prevTr ? `\n  prev_transcript: ${prevTr}` : '';
  const cwdLine = prevCwd ? `\n  prev_cwd: ${prevCwd}` : '';
  return (
    `[WIKI_AUTOCLOSE] 이전 세션(${prevId})이 /clear로 강제 종료됨.${trLine}${cwdLine}\n` +
    `  session-close가 미완료라면 지금 즉시 실행할 것 ` +
    `(hot.md + session-state.md + log.md 최소 갱신).`
  );
}

/** Pull the wiki repo. Returns true only when the pull actually succeeded. */
function gitPull(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  const r = spawnSync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], {
    stdio: 'pipe',
    timeout: 10000,
  });
  return r.status === 0;
}

/**
 * Surface unresolved sync failures recorded by a prior session's
 * Stop hook. The entry is cleared only once this session's pull has
 * succeeded AND there is no unpushed commit left behind by a failed push
 * (`[ahead N]`).
 *
 * Resolution deliberately checks only the ahead-of-remote state, not the full
 * working tree: uncommitted/untracked files are not a sync failure, and a
 * fresh `hypo init` wiki does not git-ignore `.cache/`, so a broader cleanliness
 * check would see the sync-state file itself and never clear.
 *
 * @returns {string} a `[WIKI: last sync failed: ...]` line, or '' when clear.
 */
function syncStateNotice(pullOk) {
  const { entries, parseError } = readSyncState(HYPO_DIR);
  // A corrupt JSONL file is still an "open" failure — surface it (doctor warns
  // too) but never clear it, so the unreadable record survives for inspection.
  if (parseError) return '[WIKI: last sync failed: sync-state.json unreadable — inspect manually]';
  if (entries.length === 0) return '';
  let resolved = false;
  if (pullOk) {
    const r = spawnSync('git', ['-C', HYPO_DIR, 'status', '--branch', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    resolved = r.status === 0 && !/\[ahead \d+\]/.test(r.stdout || '');
  }
  if (resolved) {
    clearSyncState(HYPO_DIR);
    return '';
  }
  const last = entries[entries.length - 1];
  if (last.op === 'conflict') {
    return (
      `[WIKI: remote diverged — auto-merge was aborted to protect your edits ` +
      `(your local work is committed and safe; the other machine's version is on the remote). ` +
      `Resolve manually: \`git -C ${HYPO_DIR} pull --no-rebase\`, fix conflicts, then push.]`
    );
  }
  return `[WIKI: last sync failed: ${last.op || '?'} — ${last.error || 'unknown'}]`;
}
const GLOBAL_HOT = join(HYPO_DIR, 'hot.md');
const HOT_CHARS = 2000;
const STATE_CHARS = 2000;

function findProjectFiles(cwd) {
  if (!existsSync(PROJECTS_DIR)) return null;
  let realpathCwd = null;
  try {
    realpathCwd = realpathSync(cwd);
  } catch {
    realpathCwd = null;
  }
  // Two-tier match (absolute prefix, then cross-machine unique basename) so a
  // vault synced from another machine still resolves the cwd to its project.
  const proj = pickProjectByCwd(collectProjectWorkingDirs(HYPO_DIR), cwd, { realpathCwd });
  if (!proj) return null;
  const projDir = join(PROJECTS_DIR, proj);
  const hotPath = join(projDir, 'hot.md');
  const statePath = join(projDir, 'session-state.md');
  return {
    proj,
    hotPath: existsSync(hotPath) ? hotPath : null,
    statePath: existsSync(statePath) ? statePath : null,
  };
}

function extractSection(content, heading) {
  const headings = Array.isArray(heading) ? heading : [heading];
  for (const h of headings) {
    const re = new RegExp(`## ${h}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
    const m = content.match(re);
    if (m) return m[1].trim();
  }
  return null;
}

function printTerminalSummary(proj, hotContent, stateContent) {
  const nextFromState = stateContent
    ? extractSection(stateContent, SESSION_STATE_NEXT_HEADINGS)
    : null;
  const next = nextFromState ?? extractSection(hotContent ?? '', SESSION_STATE_NEXT_HEADINGS);
  const prev = hotContent
    ? (extractSection(hotContent, '직전 세션 \\([^)]+\\)') ??
      extractSection(hotContent, '직전 세션.*') ??
      extractSection(hotContent, 'Last Session.*'))
    : null;
  const lines = ['', `\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${proj}\x1b[0m`];
  if (prev) lines.push(`  prev: ${prev.split('\n')[0].replace(/^\*\*|\*\*$/g, '')}`);
  if (next) {
    lines.push('  next:');
    next
      .split('\n')
      .slice(0, 20)
      .forEach((l) => lines.push(`    ${l}`));
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  // Declared before the try so every emit branch — including the outer
  // catch — carries the same `systemMessage` (the user-visible update/sibling
  // banner). Reassigned once below after the notices are computed.
  let outExtra = { continue: true, suppressOutput: true };
  try {
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    const pullOk = gitPull(HYPO_DIR);
    const syncLine = syncStateNotice(pullOk);
    const growthLine = readLastGrowthLine();
    // ADR 0022 amendment: on source='clear', surface the dying
    // session's identity that hypo-session-end stashed so Claude can recover
    // session-close work that /clear skipped. One-shot: marker is unlinked
    // immediately after read.
    const clearRecoveryLine = buildClearRecoveryLine(data.source);
    const updateLine = buildUpdateNotice();
    const siblingLine = buildSiblingNotice();
    // The update + stale-sibling banners must reach the USER. On a
    // SessionStart hook that exits 0, stderr is invisible in the normal TUI
    // (only shown on exit 2 / --verbose) and additionalContext is model-only —
    // `systemMessage` is the documented user-visible channel. Route those two
    // banners there. They ALSO stay in noticePrefix → additionalContext below,
    // so the model and the user start the session looking at the same state.
    // (The other stderr notices — sync/growth/clear/suggest — are intentionally
    // transcript/--verbose only and out of this banner's scope.)
    const userMessage = [updateLine, siblingLine].filter(Boolean).join('\n\n');
    if (userMessage) outExtra = { ...outExtra, systemMessage: userMessage };
    const notices = [syncLine, growthLine, clearRecoveryLine, updateLine, siblingLine].filter(
      Boolean,
    );
    let noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
    if (syncLine) process.stderr.write(`\n\x1b[33m${syncLine}\x1b[0m\n`);
    if (growthLine) process.stderr.write(`\n\x1b[36m${growthLine}\x1b[0m\n`);
    if (clearRecoveryLine)
      process.stderr.write(`\n\x1b[33m${clearRecoveryLine.split('\n')[0]}\x1b[0m\n`);
    if (updateLine) process.stderr.write(`\n\x1b[33m${updateLine}\x1b[0m\n`);
    if (siblingLine) process.stderr.write(`\n\x1b[33m${siblingLine}\x1b[0m\n`);
    const cwd = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || 'default';
    const MARKER_FILE = sessionMarkerPath(sessionId);
    const hit = findProjectFiles(cwd);

    const ignorePatterns = loadHypoIgnore(HYPO_DIR);

    if (hit) {
      const hotContent = readIfNotIgnored(hit.hotPath, HOT_CHARS, ignorePatterns);
      const stateContent = readIfNotIgnored(hit.statePath, STATE_CHARS, ignorePatterns);

      if (hotContent || stateContent) {
        printTerminalSummary(hit.proj, hotContent, stateContent);
        writeFileSync(
          MARKER_FILE,
          JSON.stringify({
            proj: hit.proj,
            hotPath: hit.hotPath,
            statePath: hit.statePath,
            hasSnapshot: true,
            ts: Date.now(),
          }),
        );
        const parts = [];
        if (hotContent) parts.push(`[HOT]\n${hotContent}`);
        if (stateContent) parts.push(`[SESSION STATE — 다음 작업]\n${stateContent}`);
        console.log(
          JSON.stringify(
            buildOutput(
              `${noticePrefix}[WIKI HOT CACHE: project=${sanitizeProjForPrompt(hit.proj)}]\n\n${parts.join('\n\n')}`,
              outExtra,
            ),
          ),
        );
      } else {
        process.stderr.write(
          `\n\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${hit.proj}\x1b[0m (no snapshot yet)\n\n`,
        );
        writeFileSync(
          MARKER_FILE,
          JSON.stringify({ proj: hit.proj, hotPath: null, ts: Date.now() }),
        );
        console.log(
          JSON.stringify(
            buildOutput(
              `${noticePrefix}[WIKI HOT CACHE: project=${sanitizeProjForPrompt(hit.proj)}, no snapshot yet]`,
              outExtra,
            ),
          ),
        );
      }
      return;
    }

    // MISS: cwd matches no project. ADR 0023 — offer to create one
    // when the ADR trigger conditions hold (git repo + project marker + no
    // cooldown + not previously declined). The actual scaffold is the LLM's
    // job on a "Y" reply (scripts/lib/project-create.mjs); the hook only nudges.
    if (shouldSuggestProjectCreation(cwd, HYPO_DIR)) {
      const suggestLine = buildProjectSuggestionLine(cwd);
      notices.push(suggestLine);
      noticePrefix = `${notices.join('\n\n')}\n\n`;
      recordSuggestionCooldown(HYPO_DIR, cwd);
      process.stderr.write(`\n\x1b[33m${suggestLine}\x1b[0m\n`);
    }

    if (!existsSync(GLOBAL_HOT)) {
      const notice = notices.join('\n\n');
      if (notice) {
        console.log(JSON.stringify(buildOutput(notice, outExtra)));
      } else {
        console.log(JSON.stringify(outExtra));
      }
      return;
    }

    const globalContent = readIfNotIgnored(GLOBAL_HOT, HOT_CHARS, ignorePatterns);
    if (!globalContent) {
      // GLOBAL_HOT exists but is empty or .hypoignore'd — still surface any
      // pending notices (sync state, growth, AND the auto-project offer), which
      // would otherwise be silently dropped here.
      const notice = notices.join('\n\n');
      if (notice) {
        console.log(JSON.stringify(buildOutput(notice, outExtra)));
      } else {
        console.log(JSON.stringify(outExtra));
      }
      return;
    }
    console.log(
      JSON.stringify(
        buildOutput(
          `${noticePrefix}[WIKI HOT CACHE: global — no project matched cwd=${cwd}]\n\n${globalContent}`,
          outExtra,
        ),
      ),
    );
  } catch (err) {
    process.stderr.write(`[hypo-session-start] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify(outExtra));
  }
});
