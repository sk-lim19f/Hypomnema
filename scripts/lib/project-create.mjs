#!/usr/bin/env node
/**
 * project-create.mjs — atomic auto-project scaffold (ADR 0023)
 *
 * Invoked by the LLM (NOT a user-facing subcommand — ADR 0023 deprecated
 * `hypomnema project new`) after the user answers "Y" to a SessionStart /
 * CwdChanged auto-project offer. One call materializes a whole project:
 *
 *   1. mkdir projects/<name>/{decisions,session-log}
 *   2. copy templates/projects/_template/*.md with token substitution
 *        <project-name> → name, <started> → date, <working_dir> → cwd,
 *        YYYY-MM-DD     → today  (frontmatter `updated:` only)
 *   3. append a row to root hot.md "Active Projects" table
 *   4. append a `## [today] project-create | <name>` entry to log.md
 *
 * Idempotent: existing files/rows/entries are preserved, never overwritten or
 * duplicated, so a re-run after a partial failure converges.
 *
 * CLI:
 *   node scripts/lib/project-create.mjs --name <slug> --working-dir <path> \
 *        [--hypo-dir <path>] [--started <YYYY-MM-DD>] [--json]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { resolveHypoRoot, expandHome } from './hypo-root.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..', '..');
const TEMPLATE_DIR = join(PKG_ROOT, 'templates', 'projects', '_template');

const TEMPLATE_FILES = ['index.md', 'prd.md', 'hot.md', 'session-state.md'];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Substitute the project tokens in a template file's content.
 * @param {string} content
 * @param {{name: string, started: string, workingDir: string, today: string}} vars
 */
export function substituteTokens(content, { name, started, workingDir, today }) {
  return content
    .split('<project-name>')
    .join(name)
    .split('<started>')
    .join(started)
    .split('<working_dir>')
    .join(workingDir)
    .split('YYYY-MM-DD')
    .join(today);
}

/**
 * Insert a project row into the root hot.md "Active Projects" table.
 * Idempotent: returns the original content unchanged if a row already links
 * to `[[projects/<name>/hot]]`. Returns null if the table cannot be located.
 * @returns {string|null} new content, or null when no table marker is found
 */
export function insertHotRow(content, name, today) {
  const link = `[[projects/${name}/hot]]`;
  if (content.includes(link)) return content; // already present
  const lines = content.split('\n');
  // Scope the search to the "## Active Projects" section so a table appearing
  // earlier in hot.md can't capture the row. Start looking from the heading;
  // stop at the next H2 so we never cross sections.
  const headingIdx = lines.findIndex((l) => /^##\s+Active Projects\s*$/.test(l));
  if (headingIdx === -1) return null;
  let sepIdx = -1;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // next section — table not found in scope
    if (/^\|\s*-{2,}\s*\|/.test(lines[i])) {
      sepIdx = i;
      break;
    }
  }
  if (sepIdx === -1) return null;
  const row = `| ${name} | ${today} | ${link} |`;
  lines.splice(sepIdx + 1, 0, row);
  return lines.join('\n');
}

/**
 * Create a project. Idempotent and best-effort per side effect: a missing root
 * hot.md / log.md is reported in `warnings` rather than thrown, so the core
 * project files still land.
 *
 * @param {{hypoDir: string, name: string, workingDir: string, started?: string, today?: string}} opts
 * @returns {{created: string[], skipped: string[], warnings: string[], projectDir: string}}
 */
export function createProject(opts) {
  const { name, workingDir } = opts;
  // Name must be a single path segment with at least one alnum. The charset
  // alone is not enough: `.`, `..`, `...` all pass `[A-Za-z0-9._-]+` yet would
  // resolve `projects/<name>` to the wiki root or `projects/` itself (codex
  // review 2026-05-22, both workers). Reject dot-only names and require alnum.
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name) || !/[A-Za-z0-9]/.test(name)) {
    throw new Error(
      `invalid project name: ${JSON.stringify(name)} (need a single segment with ≥1 alnum, charset A-Za-z0-9._-, not "."/"..")`,
    );
  }
  if (!workingDir) throw new Error('workingDir is required');

  const hypoDir = opts.hypoDir || resolveHypoRoot();
  const today = opts.today || todayISO();
  const started = opts.started || today;
  const vars = { name, started, workingDir, today };

  const created = [];
  const skipped = [];
  const warnings = [];

  const projectsRoot = resolve(hypoDir, 'projects');
  const projectDir = join(projectsRoot, name);
  // Defense in depth: the resolved target must stay strictly inside projects/.
  if (
    resolve(projectDir) !== join(projectsRoot, name) ||
    !resolve(projectDir).startsWith(projectsRoot + sep)
  ) {
    throw new Error(`project name escapes projects/: ${JSON.stringify(name)}`);
  }
  for (const sub of ['decisions', 'session-log']) {
    mkdirSync(join(projectDir, sub), { recursive: true });
  }

  for (const file of TEMPLATE_FILES) {
    const src = join(TEMPLATE_DIR, file);
    const dest = join(projectDir, file);
    if (!existsSync(src)) {
      warnings.push(`template missing: ${file}`);
      continue;
    }
    if (existsSync(dest)) {
      skipped.push(`projects/${name}/${file}`);
      continue;
    }
    writeFileSync(dest, substituteTokens(readFileSync(src, 'utf-8'), vars));
    created.push(`projects/${name}/${file}`);
  }

  // root hot.md pointer row
  const hotPath = join(hypoDir, 'hot.md');
  if (existsSync(hotPath)) {
    const orig = readFileSync(hotPath, 'utf-8');
    const next = insertHotRow(orig, name, today);
    if (next === null) {
      warnings.push('root hot.md: no Active Projects table found — add row manually');
    } else if (next !== orig) {
      writeFileSync(hotPath, next);
      created.push('hot.md row');
    } else {
      skipped.push('hot.md row');
    }
  } else {
    warnings.push('root hot.md missing — skipped pointer row');
  }

  // log.md entry
  const logPath = join(hypoDir, 'log.md');
  const entry = `## [${today}] project-create | ${name}`;
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf-8');
    if (log.includes(entry)) {
      skipped.push('log.md entry');
    } else {
      writeFileSync(logPath, log.replace(/\s*$/, '\n') + `\n${entry}\n`);
      created.push('log.md entry');
    }
  } else {
    warnings.push('log.md missing — skipped activity entry');
  }

  return { created, skipped, warnings, projectDir };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--working-dir') args.workingDir = expandHome(argv[++i]);
    else if (a === '--hypo-dir') args.hypoDir = expandHome(argv[++i]);
    else if (a === '--started') args.started = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = `Usage: project-create.mjs --name <slug> --working-dir <path> [--hypo-dir <path>] [--started YYYY-MM-DD] [--json]`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.name || !args.workingDir) {
    console.error(`Error: --name and --working-dir are required\n${USAGE}`);
    process.exit(1);
  }
  let result;
  try {
    result = createProject(args);
  } catch (err) {
    console.error(`Error: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    result.created.forEach((c) => console.log(`✓ created ${c}`));
    result.skipped.forEach((s) => console.log(`· skipped ${s} (exists)`));
    result.warnings.forEach((w) => console.warn(`⚠ ${w}`));
    console.log(`\nProject '${args.name}' ready at ${result.projectDir}`);
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
