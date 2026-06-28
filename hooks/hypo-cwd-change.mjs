#!/usr/bin/env node
/**
 * hypo-cwd-change.mjs — CwdChanged hook
 *
 * When the working directory changes mid-session, re-inject the matching
 * project hot.md. Skips if still within the same project subtree.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  buildOutput,
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

const PROJECTS_DIR = join(HYPO_DIR, 'projects');
const GLOBAL_HOT = join(HYPO_DIR, 'hot.md');
const MAX_CHARS = 3000;

// Privacy guard: a .hypoignore-matched hot.md must not be
// re-emitted into additionalContext on cwd change.
function readIfNotIgnored(path, patterns) {
  if (!path) return null;
  if (patterns.length > 0 && isIgnored(path, HYPO_DIR, patterns)) return null;
  return readFileSync(path, 'utf-8').slice(0, MAX_CHARS);
}

function findProjectHot(cwd) {
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
      // arm the first-prompt marker so the NEXT user prompt re-triggers
      // hypo-first-prompt, which forces a "Resuming <project>" summary line.
      // Only arm when real hot content was actually injected — if hot.md is
      // missing or .hypoignore'd (fromFile null), there is nothing for the LLM
      // to summarize, so forcing "Resuming" would be empty noise.
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
          buildOutput(
            `[WIKI: cwd changed → project=${sanitizeProjForPrompt(newHit.proj)}]\n\n${content}`,
            {
              continue: true,
              suppressOutput: true,
            },
          ),
        ),
      );
      return;
    }

    // MISS: cwd matches no project. ADR 0023 — offer to create one
    // when the trigger conditions hold. Same nudge-only model as session-start.
    let suggestPrefix = '';
    if (shouldSuggestProjectCreation(newCwd, HYPO_DIR)) {
      const suggestLine = buildProjectSuggestionLine(newCwd);
      suggestPrefix = `${suggestLine}\n\n`;
      recordSuggestionCooldown(HYPO_DIR, newCwd);
      process.stderr.write(`\n\x1b[33m${suggestLine}\x1b[0m\n`);
    }

    const globalContent = existsSync(GLOBAL_HOT)
      ? readIfNotIgnored(GLOBAL_HOT, ignorePatterns)
      : null;

    if (!globalContent) {
      if (suggestPrefix) {
        console.log(
          JSON.stringify(
            buildOutput(suggestPrefix.trimEnd(), { continue: true, suppressOutput: true }),
          ),
        );
      } else {
        console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      }
      return;
    }
    console.log(
      JSON.stringify(
        buildOutput(
          `${suggestPrefix}[WIKI: cwd changed → no project match, injecting global hot]\n\n${globalContent}`,
          { continue: true, suppressOutput: true },
        ),
      ),
    );
  } catch (err) {
    process.stderr.write(`[hypo-cwd-change] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
