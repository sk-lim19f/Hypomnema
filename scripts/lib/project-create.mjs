#!/usr/bin/env node
/**
 * project-create.mjs — atomic auto-project scaffold
 *
 * Invoked by the LLM (NOT a user-facing subcommand; `hypomnema project new` is deprecated
 * `hypomnema project new`) after the user answers "Y" to a SessionStart /
 * CwdChanged auto-project offer. One call materializes a whole project:
 *
 *   1. mkdir projects/<name>/{decisions,session-log}
 *   2. copy templates/projects/_template/{index,prd}.md with token substitution
 *        <project-name> → name, <started> → date, <working_dir> → cwd,
 *        YYYY-MM-DD     → today  (frontmatter `updated:` only)
 *   3. regenerate this project's views and root hot.md's "Active Projects"
 *      table with the view generator (writeGeneratedViews,
 *      hooks/session-views.mjs), never a hand-inserted row. A direct table
 *      edit here (the old insertHotRow) left the ownership record pointing at
 *      whatever the generator last wrote, so the next SessionStart or Stop
 *      read this edit as external and backed it up with a false "손으로
 *      편집한 내용이 있었습니다" alarm on every normal project creation. A vault
 *      that is not migrated to session entries is left as it is.
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
import { resolveProjectDirName, rootHotBackupRecoveryNotice } from '../../hooks/hypo-shared.mjs';
import { writeGeneratedViews } from '../../hooks/session-views.mjs';
import { isValidProjectName } from '../../hooks/session-entries.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..', '..');
// Exported so other project-scaffolding call sites (crystallize.mjs's
// session-close apply, which fills a MISSING index.md on a project that
// bypassed createProject entirely) resolve the same template dir instead of
// re-deriving the path.
export const TEMPLATE_DIR = join(PKG_ROOT, 'templates', 'projects', '_template');

// `hot.md` and `session-state.md` are not here: they are generated views. The generator writes them
// (step 3 below), and a copy placed first would be bytes it did not write.
const TEMPLATE_FILES = ['index.md', 'prd.md'];

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
 * @param {{hypoDir: string, name: string, workingDir: string, started?: string, today?: string, testHooks?: {templateDir?: string}}} opts
 *   `testHooks.templateDir` replaces the shipped template directory (tests only).
 * @returns {{created: string[], skipped: string[], warnings: string[], projectDir: string}}
 */
// The project-name rule lives in hooks/session-entries.mjs (isValidProjectName), the one copy every
// gate shares. Re-exported so apply, the CLI parser and createProject accept exactly the same
// namespace: single segment, Unicode letters/marks/numbers plus `._-`, not dot-only.
export { isValidProjectName };

export function createProject(opts) {
  const { workingDir } = opts;
  if (!isValidProjectName(opts.name)) {
    throw new Error(
      `invalid project name: ${JSON.stringify(opts.name)} (need a single segment of letters, marks, numbers, ".", "_" or "-" with at least one letter or number, not "."/"..")`,
    );
  }
  if (!workingDir) throw new Error('workingDir is required');

  const hypoDir = opts.hypoDir || resolveHypoRoot();
  // NFC is the stored form; an existing directory keeps the spelling it has on disk, so an NFD
  // name never scaffolds a second directory beside an NFC one.
  const name = resolveProjectDirName(hypoDir, opts.name) ?? opts.name.normalize('NFC');
  const today = opts.today || todayISO();
  const started = opts.started || today;
  const vars = { name, started, workingDir, today };
  const templateDir = opts.testHooks?.templateDir ?? TEMPLATE_DIR;

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
    const src = join(templateDir, file);
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

  // root hot.md pointer row: regenerate through the view generator (n2 fix, see
  // this function's own doc comment above) rather than hand-inserting a row.
  // The generator lists the session projects itself, so the new row lands in
  // the same pass.
  let views = null;
  try {
    views = writeGeneratedViews(hypoDir, { projects: [name] });
  } catch (err) {
    skipped.push('hot.md row (views not rendered)');
    warnings.push(`세션 현황 파일을 만들지 못했습니다: ${err?.message ?? String(err)}`);
  }
  if (!views) {
    // reported just above
  } else if (views.notMigrated) {
    // Nothing is rendered in a vault that has not moved to session entries, and the generator
    // says nothing about it there. Without a reason the caller reads "hot.md row" as "already
    // current" and goes looking for a row that will not appear.
    if (views.state === 'not-migrated') {
      skipped.push('hot.md row (vault not migrated)');
      warnings.push(
        '이 저장소는 아직 세션 항목으로 옮기지 않아 세션 현황 파일(루트 hot.md 행 포함)을 만들지 않았습니다. `/hypo:upgrade --migrate-sessions` 뒤에 나타납니다.',
      );
    } else {
      skipped.push(`hot.md row (views not written: ${views.state})`);
    }
  } else if (views.lockTimeout) {
    // Distinct from the plain "already current" skip below: the row was never
    // even attempted this run because another session held the vault lock, not
    // because there was nothing new to write. The label is what lets a caller
    // reading only `skipped` tell "not created" apart from "could not check
    // whether it needed creating".
    skipped.push('hot.md row (lock timeout)');
    warnings.push(
      'root hot.md: 다른 세션이 저장소 잠금을 쥐고 있어 이번에는 갱신하지 않았습니다 (이전 내용을 그대로 둡니다).',
    );
  } else if (views.written.includes('hot.md')) {
    created.push('hot.md row');
  } else {
    skipped.push('hot.md row');
  }
  // A view whose unowned bytes the generator just backed up (a person's hand edit)
  // reaches the caller with the same recovery sentence the hooks use, not just
  // the generator's health notice for the next SessionStart.
  for (const b of views?.backedUp ?? [])
    warnings.push(rootHotBackupRecoveryNotice(b.relPath, b.backupPath));

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
