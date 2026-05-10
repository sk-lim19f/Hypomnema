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
import { HYPO_DIR, buildOutput, SESSION_STATE_NEXT_HEADINGS } from './hypo-shared.mjs';

const PROJECTS_DIR = join(HYPO_DIR, 'projects');

function gitPull(dir) {
  if (!existsSync(join(dir, '.git'))) return;
  spawnSync('git', ['-C', dir, 'pull', '--ff-only', '--quiet'], { stdio: 'pipe', timeout: 10000 });
}
const GLOBAL_HOT   = join(HYPO_DIR, 'hot.md');
const HOT_CHARS    = 2000;
const STATE_CHARS  = 2000;

function parseFrontmatterField(content, key) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find(l => l.startsWith(`${key}:`));
  if (!line) return null;
  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
}

function findProjectFiles(cwd) {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const projDir  = join(PROJECTS_DIR, proj);
    if (!statSync(projDir).isDirectory()) continue;
    const indexPath = join(projDir, 'index.md');
    if (!existsSync(indexPath)) continue;
    const content    = readFileSync(indexPath, 'utf-8');
    const workingDir = parseFrontmatterField(content, 'working_dir');
    if (!workingDir) continue;
    const resolved = workingDir.startsWith('~/')
      ? join(homedir(), workingDir.slice(2))
      : workingDir;
    if (cwd === resolved || cwd.startsWith(resolved + '/')) {
      const hotPath   = join(projDir, 'hot.md');
      const statePath = join(projDir, 'session-state.md');
      return {
        proj,
        hotPath:   existsSync(hotPath)   ? hotPath   : null,
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
  const next = nextFromState
    ?? extractSection(hotContent ?? '', SESSION_STATE_NEXT_HEADINGS);
  const prev = hotContent
    ? (extractSection(hotContent, '직전 세션 \\([^)]+\\)')
        ?? extractSection(hotContent, '직전 세션.*')
        ?? extractSection(hotContent, 'Last Session.*'))
    : null;
  const lines = ['', `\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${proj}\x1b[0m`];
  if (prev) lines.push(`  prev: ${prev.split('\n')[0].replace(/^\*\*|\*\*$/g, '')}`);
  if (next) {
    lines.push('  next:');
    next.split('\n').slice(0, 20).forEach(l => lines.push(`    ${l}`));
  }
  lines.push('');
  process.stderr.write(lines.join('\n'));
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    gitPull(HYPO_DIR);
    const cwd = data.cwd || data.directory || process.cwd();
    const sessionId = data.session_id || 'default';
    const MARKER_FILE = join(tmpdir(), `hypo-session-marker-${sessionId}.json`);
    const hit = findProjectFiles(cwd);

    if (hit) {
      const hotContent   = hit.hotPath   ? readFileSync(hit.hotPath,   'utf-8').slice(0, HOT_CHARS)   : null;
      const stateContent = hit.statePath ? readFileSync(hit.statePath, 'utf-8').slice(0, STATE_CHARS) : null;

      if (hotContent || stateContent) {
        printTerminalSummary(hit.proj, hotContent, stateContent);
        writeFileSync(MARKER_FILE, JSON.stringify({ proj: hit.proj, hotPath: hit.hotPath, statePath: hit.statePath, hasSnapshot: true, ts: Date.now() }));
        const parts = [];
        if (hotContent)   parts.push(`[HOT]\n${hotContent}`);
        if (stateContent) parts.push(`[SESSION STATE — 다음 작업]\n${stateContent}`);
        console.log(JSON.stringify(
          buildOutput(`[WIKI HOT CACHE: project=${hit.proj}]\n\n${parts.join('\n\n')}`, { continue: true, suppressOutput: true })
        ));
      } else {
        process.stderr.write(`\n\x1b[36m[Hypomnema]\x1b[0m project: \x1b[1m${hit.proj}\x1b[0m (no snapshot yet)\n\n`);
        writeFileSync(MARKER_FILE, JSON.stringify({ proj: hit.proj, hotPath: null, ts: Date.now() }));
        console.log(JSON.stringify(
          buildOutput(`[WIKI HOT CACHE: project=${hit.proj}, no snapshot yet]`, { continue: true, suppressOutput: true })
        ));
      }
      return;
    }

    if (!existsSync(GLOBAL_HOT)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const globalContent = readFileSync(GLOBAL_HOT, 'utf-8').slice(0, HOT_CHARS);
    console.log(JSON.stringify(
      buildOutput(`[WIKI HOT CACHE: global — no project matched cwd=${cwd}]\n\n${globalContent}`, { continue: true, suppressOutput: true })
    ));

  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
