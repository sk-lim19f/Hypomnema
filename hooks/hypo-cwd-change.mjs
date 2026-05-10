#!/usr/bin/env node
/**
 * hypo-cwd-change.mjs — CwdChanged hook
 *
 * When the working directory changes mid-session, re-inject the matching
 * project hot.md. Skips if still within the same project subtree.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { HYPO_DIR, buildOutput } from './hypo-shared.mjs';

const PROJECTS_DIR = join(HYPO_DIR, 'projects');
const GLOBAL_HOT   = join(HYPO_DIR, 'hot.md');
const MAX_CHARS    = 3000;

function parseFrontmatterField(content, key) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const line = match[1].split('\n').find(l => l.startsWith(`${key}:`));
  if (!line) return null;
  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
}

function findProjectHot(cwd) {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const proj of readdirSync(PROJECTS_DIR)) {
    const projDir = join(PROJECTS_DIR, proj);
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
      const hotPath = join(projDir, 'hot.md');
      return { proj, hotPath: existsSync(hotPath) ? hotPath : null, resolved };
    }
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', () => {
  try {
    let data = {};
    try { data = JSON.parse(raw); } catch {}

    const newCwd = data.new_cwd || data.new_directory || data.cwd || process.cwd();
    const oldCwd = data.old_cwd || data.old_directory || data.previous_cwd || '';

    // Skip re-injection if still in the same project
    const oldHit = oldCwd ? findProjectHot(oldCwd) : null;
    const newHit = findProjectHot(newCwd);

    if (oldHit && newHit && oldHit.proj === newHit.proj) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (newHit) {
      const content = newHit.hotPath
        ? readFileSync(newHit.hotPath, 'utf-8').slice(0, MAX_CHARS)
        : '(no hot.md yet — will be created at session close)';
      console.log(JSON.stringify(
        buildOutput(`[WIKI: cwd changed → project=${newHit.proj}]\n\n${content}`, { continue: true, suppressOutput: true })
      ));
      return;
    }

    if (!existsSync(GLOBAL_HOT)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const globalContent = readFileSync(GLOBAL_HOT, 'utf-8').slice(0, MAX_CHARS);
    console.log(JSON.stringify(
      buildOutput(`[WIKI: cwd changed → no project match, injecting global hot]\n\n${globalContent}`, { continue: true, suppressOutput: true })
    ));

  } catch (err) {
    process.stderr.write(`[wiki-cwd-change] error: ${err.message}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
