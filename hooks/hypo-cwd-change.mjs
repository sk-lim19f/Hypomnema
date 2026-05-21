#!/usr/bin/env node
/**
 * hypo-cwd-change.mjs — CwdChanged hook
 *
 * When the working directory changes mid-session, re-inject the matching
 * project hot.md. Skips if still within the same project subtree.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  HYPO_DIR,
  buildOutput,
  loadHypoIgnore,
  isIgnored,
  sessionMarkerPath,
} from './hypo-shared.mjs';

const PROJECTS_DIR = join(HYPO_DIR, 'projects');
const GLOBAL_HOT = join(HYPO_DIR, 'hot.md');
const MAX_CHARS = 3000;

// Privacy guard (fix #48, Stage 1): a .hypoignore-matched hot.md must not be
// re-emitted into additionalContext on cwd change.
function readIfNotIgnored(path, patterns) {
  if (!path) return null;
  if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return null;
  return readFileSync(path, 'utf-8').slice(0, MAX_CHARS);
}

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

function findProjectHot(cwd) {
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
        resolved,
      };
    }
  }
  return null;
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

    const newCwd = data.new_cwd || data.new_directory || data.cwd || process.cwd();
    const oldCwd = data.old_cwd || data.old_directory || data.previous_cwd || '';
    const sessionId = data.session_id || 'default';

    // Skip re-injection if still in the same project
    const oldHit = oldCwd ? findProjectHot(oldCwd) : null;
    const newHit = findProjectHot(newCwd);

    if (oldHit && newHit && oldHit.proj === newHit.proj) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const ignorePatterns = loadHypoIgnore(HYPO_DIR);

    if (newHit) {
      const fromFile = readIfNotIgnored(newHit.hotPath, ignorePatterns);
      const content = fromFile ?? '(no hot.md yet — will be created at session close)';
      // fix #13: arm the first-prompt marker so the NEXT user prompt re-triggers
      // hypo-first-prompt, which forces a "Resuming <project>" summary line.
      // Only arm when real hot content was actually injected — if hot.md is
      // missing or .hypoignore'd (fromFile null), there is nothing for the LLM
      // to summarize, so forcing "Resuming" would be empty noise (codex review).
      if (fromFile) {
        try {
          writeFileSync(
            sessionMarkerPath(sessionId),
            JSON.stringify({
              proj: newHit.proj,
              hotPath: newHit.hotPath,
              statePath: newHit.statePath,
              hasSnapshot: true,
              source: 'cwd-change',
              ts: Date.now(),
            }),
          );
        } catch (err) {
          process.stderr.write(
            `[hypo-cwd-change] marker write failed: ${err?.message ?? String(err)}\n`,
          );
        }
      }
      console.log(
        JSON.stringify(
          buildOutput(`[WIKI: cwd changed → project=${newHit.proj}]\n\n${content}`, {
            continue: true,
            suppressOutput: true,
          }),
        ),
      );
      return;
    }

    if (!existsSync(GLOBAL_HOT)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const globalContent = readIfNotIgnored(GLOBAL_HOT, ignorePatterns);
    if (!globalContent) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
    console.log(
      JSON.stringify(
        buildOutput(
          `[WIKI: cwd changed → no project match, injecting global hot]\n\n${globalContent}`,
          { continue: true, suppressOutput: true },
        ),
      ),
    );
  } catch (err) {
    process.stderr.write(`[hypo-cwd-change] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
