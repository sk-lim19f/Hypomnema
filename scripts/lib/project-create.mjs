#!/usr/bin/env node
/**
 * project-create.mjs — atomic auto-project scaffold
 *
 * Invoked by the LLM (NOT a user-facing subcommand; `hypomnema project new` is deprecated
 * `hypomnema project new`) after the user answers "Y" to a SessionStart /
 * CwdChanged auto-project offer. One call materializes a whole project:
 *
 *   1. mkdir projects/<name>/{decisions,session-log}
 *   2. copy templates/projects/_template/*.md with token substitution
 *        <project-name> → name, <started> → date, <working_dir> → cwd,
 *        YYYY-MM-DD     → today  (frontmatter `updated:` only)
 *   3. regenerate root hot.md's "Active Projects" table via the canonical
 *      projection (writeRootHotProjection, hooks/hypo-shared.mjs), which
 *      picks up this project's own row from the directory scan step 2 just
 *      wrote, never a hand-inserted row. A direct table edit here (the old
 *      insertHotRow) left the ownership hash pointing at whatever a
 *      session's projection write last produced, so the next SessionStart or
 *      Stop read this edit as external and backed it up with a false "손으로
 *      편집한 내용이 있었습니다" alarm on every normal project creation.
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
import { writeRootHotProjection, rootHotBackupRecoveryNotice } from '../../hooks/hypo-shared.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..', '..');
// Exported so other project-scaffolding call sites (crystallize.mjs's
// session-close apply, which fills a MISSING index.md on a project that
// bypassed createProject entirely) resolve the same template dir instead of
// re-deriving the path.
export const TEMPLATE_DIR = join(PKG_ROOT, 'templates', 'projects', '_template');

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
 * Create a project. Idempotent and best-effort per side effect: a missing root
 * hot.md / log.md is reported in `warnings` rather than thrown, so the core
 * project files still land.
 *
 * @param {{hypoDir: string, name: string, workingDir: string, started?: string, today?: string}} opts
 * @returns {{created: string[], skipped: string[], warnings: string[], projectDir: string}}
 */
/**
 * A project name must be a SINGLE path segment with at least one alnum. The
 * charset alone is not enough: `.`, `..`, `...` all pass `[A-Za-z0-9._-]+` yet
 * would resolve `projects/<name>` to the wiki root or `projects/` itself (codex
 * review 2026-05-22, both workers) — so dot-only names are rejected and ≥1 alnum
 * required. The leading `typeof` guard lets non-CLI callers (e.g. a JSON payload
 * where the value could be a number) reuse this without a JS regex coercing a
 * non-string into a "valid" name. Shared so the apply path (crystallize.mjs B-3)
 * accepts exactly the namespace createProject can scaffold — no wider, no narrower.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidProjectName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    !/^\.+$/.test(name) &&
    /[A-Za-z0-9]/.test(name)
  );
}

export function createProject(opts) {
  const { name, workingDir } = opts;
  if (!isValidProjectName(name)) {
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

  // root hot.md pointer row: regenerate via the canonical projection (n2 fix,
  // see this function's own doc comment above) rather than hand-inserting a
  // row. The directory scan already sees this project's own hot.md, written
  // by the TEMPLATE_FILES loop above, so the new row lands in the same pass.
  const hotResult = writeRootHotProjection(hypoDir);
  if (hotResult.scanError) {
    warnings.push('root hot.md: projects/ 디렉터리를 읽지 못해 표를 갱신하지 못했습니다');
  } else if (hotResult.lockTimeout) {
    // Distinct from the plain "already current" skip below: the row was
    // never even attempted this run because another session held the vault
    // lock, not because there was nothing new to write. `warnings` already
    // carries writeRootHotProjection's own lock-busy message; this label is
    // what lets a caller reading only `skipped` tell "not created" apart
    // from "could not check whether it needed creating".
    skipped.push('hot.md row (lock timeout)');
  } else if (hotResult.written) {
    created.push('hot.md row');
  } else {
    skipped.push('hot.md row');
  }
  if (hotResult.warnings.length > 0) warnings.push(...hotResult.warnings);
  // MAJOR fix (codex 3rd-tier finding 6): a hand-authored root hot.md this
  // scaffold's own writeRootHotProjection call just backed up never reached
  // the user at all here. `backedUp`/`backupPath` were read by
  // SessionStart and the Stop-hook rebuild but silently dropped on this
  // third writer, the one call site with the least excuse for it (`main`'s
  // own CLI output prints every entry in `warnings`). Same shared sentence
  // the other two writers use, so a person who created a project right
  // after hand-editing root hot.md gets the SAME recovery guidance, not a
  // silently vanished edit.
  if (hotResult.backedUp && hotResult.backupPath) {
    warnings.push(rootHotBackupRecoveryNotice(hotResult.backupPath));
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
