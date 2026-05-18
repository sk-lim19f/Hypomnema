#!/usr/bin/env node
/**
 * hypo-session-start.mjs — SessionStart hook
 *
 * On session start:
 *   HIT  → cwd matches a project's working_dir → inject hot.md (2000 chars) + session-state.md (2000 chars)
 *   MISS → inject global hot.md pointer only (no fan-out to all projects)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';
import {
  HYPO_DIR,
  buildOutput,
  SESSION_STATE_NEXT_HEADINGS,
  formatGrowthMetrics,
  readSyncState,
  clearSyncState,
  loadHypoIgnore,
  isIgnored,
} from './hypo-shared.mjs';

// Privacy guard (fix #48, Stage 1): refuse to read+inject .hypoignore-matched
// wiki files into additionalContext. Without this, a user who lists
// `projects/private/hot.md` in .hypoignore would still see SECRET emit because
// session-start reads hot/state paths directly.
function readIfNotIgnored(path, maxChars, patterns) {
  if (!path) return null;
  if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return null;
  return readFileSync(path, 'utf-8').slice(0, maxChars);
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
 * fix #10: surface unresolved sync failures recorded by a prior session's
 * Stop hook (#9). The entry is cleared only once this session's pull has
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
  return `[WIKI: last sync failed: ${last.op || '?'} — ${last.error || 'unknown'}]`;
}
const GLOBAL_HOT = join(HYPO_DIR, 'hot.md');
const HOT_CHARS = 2000;
const STATE_CHARS = 2000;

function parseFrontmatterField(content, key) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function findProjectFiles(cwd) {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const projDir = join(PROJECTS_DIR, proj);
    if (!statSync(projDir).isDirectory()) continue;
    const indexPath = join(projDir, 'index.md');
    if (!existsSync(indexPath)) continue;
    const content = readFileSync(indexPath, 'utf-8');
    const workingDir = parseFrontmatterField(content, 'working_dir');
    if (!workingDir) continue;
    const resolved = workingDir.startsWith('~/')
      ? join(homedir(), workingDir.slice(2))
      : workingDir;
    if (cwd === resolved || cwd.startsWith(resolved + '/')) {
      const hotPath = join(projDir, 'hot.md');
      const statePath = join(projDir, 'session-state.md');
      return {
        proj,
        hotPath: existsSync(hotPath) ? hotPath : null,
        statePath: existsSync(statePath) ? statePath : null,
      };
    }
  }
  return null;
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
  try {
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    const pullOk = gitPull(HYPO_DIR);
    const syncLine = syncStateNotice(pullOk);
    const growthLine = readLastGrowthLine();
    // Intentional dual emit: stderr (yellow/cyan) is the human-visible nudge in
    // the terminal; noticePrefix injects the same plain-text lines into the
    // LLM's additionalContext so model and user start the session looking at
    // the same state. ANSI escapes are kept out of additionalContext on purpose.
    const notices = [syncLine, growthLine].filter(Boolean);
    const noticePrefix = notices.length ? `${notices.join('\n\n')}\n\n` : '';
    if (syncLine) process.stderr.write(`\n\x1b[33m${syncLine}\x1b[0m\n`);
    if (growthLine) process.stderr.write(`\n\x1b[36m${growthLine}\x1b[0m\n`);
    const cwd = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || 'default';
    const MARKER_FILE = join(tmpdir(), `hypo-session-marker-${sessionId}.json`);
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
              `${noticePrefix}[WIKI HOT CACHE: project=${hit.proj}]\n\n${parts.join('\n\n')}`,
              { continue: true, suppressOutput: true },
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
            buildOutput(`${noticePrefix}[WIKI HOT CACHE: project=${hit.proj}, no snapshot yet]`, {
              continue: true,
              suppressOutput: true,
            }),
          ),
        );
      }
      return;
    }

    if (!existsSync(GLOBAL_HOT)) {
      const notice = notices.join('\n\n');
      if (notice) {
        console.log(JSON.stringify(buildOutput(notice, { continue: true, suppressOutput: true })));
      } else {
        console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      }
      return;
    }

    const globalContent = readIfNotIgnored(GLOBAL_HOT, HOT_CHARS, ignorePatterns);
    if (!globalContent) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
    console.log(
      JSON.stringify(
        buildOutput(
          `${noticePrefix}[WIKI HOT CACHE: global — no project matched cwd=${cwd}]\n\n${globalContent}`,
          { continue: true, suppressOutput: true },
        ),
      ),
    );
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
