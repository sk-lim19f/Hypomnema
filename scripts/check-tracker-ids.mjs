#!/usr/bin/env node
/**
 * check-tracker-ids.mjs — CLI gate: no wiki-internal tracker IDs (ISSUE-N,
 * fix #N) in OSS-public artifacts.
 *
 * Rule source: CLAUDE.md learned_behaviors (no-internal-tracker-ids-in-oss-
 * artifacts, 2026-06-09). The repo ships through npm + a Claude Code plugin;
 * a `fix #N` / `ISSUE-N` in any shipped file or in README/CHANGELOG is a
 * dangling pointer into the maintainer's PRIVATE wiki tracker. GitHub refs
 * (`PR #N`, `(#N)`, `#N`, issue URLs) are legitimate and never flagged.
 *
 * Modes:
 *   --all (default)        Walk the public-artifact scope and scan every text
 *                          file. Wired into npm `prepublishOnly` and CI.
 *   --staged               Scan the STAGED blob of every in-scope file in the
 *                          index (git show :path), mirroring the pre-commit
 *                          formatter's name-status/-z/diff-filter plumbing so
 *                          deletes, type-changes, symlinks and submodules are
 *                          skipped. Used by the pre-commit hook.
 *   --commit-msg <file>    Scan a commit message. Drops the --verbose scissors
 *                          diff, then strips comment lines ONLY when git added
 *                          its template (editor/strip mode); for `commit -m` /
 *                          whitespace / verbatim (no template) it scans comment
 *                          lines too, since git keeps them. Used by the
 *                          commit-msg hook.
 *   --json                 Machine-readable output.
 *
 * Exit: 0 clean · 1 violations · 2 usage error.
 *
 * Scope (public): README.md, README.ko.md, CHANGELOG.md, package.json (npm
 * auto-ships it) + shipped trees commands/ hooks/ scripts/ skills/ templates/
 * docs/ .github/ .claude-plugin/. Excluded: tests/ and qa-runs/ (internal
 * maintainer artifacts — a tracker id in a test description aids traceability
 * and never reaches an installed user), node_modules/, .git/. The checker's OWN
 * sources are scanned (NOT exempt); their examples use `N` placeholders so they
 * stay clean.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep, extname } from 'node:path';
import { scanText, stripScissors, messageHasGitTemplate } from './lib/check-tracker-ids.mjs';
import {
  parseNameStatus,
  parseLsFilesStage,
  filterRegularFiles,
} from './lib/pre-commit-format.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Root resolves from this script's location (so --staged always gates the real
// Hypomnema index regardless of cwd). CHECK_TRACKER_ROOT is a TEST-ONLY seam;
// the installed git hooks `unset CHECK_TRACKER_ROOT` before invoking (see
// install-git-hooks.mjs gateLines) so an inherited/hostile value cannot redirect
// the real gate. Read-only either way (no writes), so it only changes what is
// scanned, never what is written.
const REPO_ROOT = process.env.CHECK_TRACKER_ROOT || join(__dirname, '..');

const RULE_REF =
  'Rule: CLAUDE.md learned_behaviors (no-internal-tracker-ids-in-oss-artifacts). ' +
  'OSS-public artifacts must not reference the private wiki tracker (ISSUE-N / fix #N). ' +
  'Use a GitHub ref (#N / PR #N) or drop the reference.';

// Top-level public-artifact entry points. Files are scanned directly; dirs are
// walked recursively. Anything outside this set is out of scope. package.json is
// here because npm auto-ships it (it is not in the `files` allowlist but is
// always packed), so a tracker id in its metadata is a public leak too.
const SCOPE_FILES = ['README.md', 'README.ko.md', 'CHANGELOG.md', 'package.json'];
const SCOPE_DIRS = [
  'commands',
  'hooks',
  'scripts',
  'skills',
  'templates',
  'docs',
  '.github',
  '.claude-plugin',
];

// Never scanned even when under a scope dir. tests/ and qa-runs/ are
// internal-maintainer artifacts (a tracker id in a test name aids traceability
// and never reaches an installed user). The checker's OWN sources are NOT
// excluded — they use `N` placeholders in their examples so they scan clean.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'qa-runs']);
const EXCLUDED_FILES = new Set();

// Only text artifacts. Binary / lockfiles add noise and never carry prose refs.
const TEXT_EXT = new Set(['.md', '.mjs', '.js', '.cjs', '.json', '.yml', '.yaml', '.sh', '.txt']);

function isExcludedRel(relPath) {
  const parts = relPath.split(sep);
  if (parts.some((p) => EXCLUDED_DIRS.has(p))) return true;
  if (EXCLUDED_FILES.has(relPath)) return true;
  return false;
}

function isTextFile(p) {
  return TEXT_EXT.has(extname(p).toLowerCase());
}

// Single public-scope predicate shared by --all and --staged so the two modes
// can never disagree on what counts as a public artifact (a root file like
// `foo.md` is out of scope for both; `package.json` and scope-dir files are in).
function isInScope(relPath) {
  if (isExcludedRel(relPath)) return false;
  if (!isTextFile(relPath)) return false;
  if (SCOPE_FILES.includes(relPath)) return true;
  return SCOPE_DIRS.includes(relPath.split(sep)[0]);
}

// Recursively collect in-scope text files under an absolute dir.
function walk(absDir, acc) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = join(absDir, ent.name);
    const rel = relative(REPO_ROOT, abs);
    if (isExcludedRel(rel)) continue;
    if (ent.isDirectory()) {
      walk(abs, acc);
    } else if (ent.isFile() && isTextFile(abs)) {
      acc.push(rel);
    }
  }
}

function collectAllScopeFiles() {
  const files = [];
  for (const f of SCOPE_FILES) {
    if (existsSync(join(REPO_ROOT, f))) files.push(f);
  }
  for (const d of SCOPE_DIRS) {
    walk(join(REPO_ROOT, d), files);
  }
  return files;
}

// ── violation reporting ──────────────────────────────────────────────────────

function report(violations, json) {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: violations.length === 0,
          count: violations.length,
          violations,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (violations.length === 0) {
    process.stdout.write('[check-tracker-ids] OK: no wiki-internal tracker ids found.\n');
  } else {
    process.stderr.write(
      `[check-tracker-ids] FAIL: ${violations.length} tracker-id reference(s):\n`,
    );
    for (const v of violations) {
      process.stderr.write(
        `  ${v.file}:${v.line}:${v.col}  ${v.match}  (${v.label})\n` +
          `      ${v.lineText.trim()}\n`,
      );
    }
    process.stderr.write(`${RULE_REF}\n`);
  }
  return violations.length === 0 ? 0 : 1;
}

// ── git helpers (scoped env not required: read-only, no GIT_DIR attack surface
//    here — the hook shim already pins identity before invoking) ──────────────

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', ...opts });
}

// ── modes ────────────────────────────────────────────────────────────────────

function runAll(json) {
  const files = collectAllScopeFiles();
  const violations = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    } catch {
      continue;
    }
    for (const h of scanText(text)) violations.push({ file: rel, ...h });
  }
  process.exit(report(violations, json));
}

function runStaged(json) {
  const diff = git(['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR', '--']);
  if (diff.status !== 0) {
    // Can't read the index → fail OPEN (don't block a commit on a git probe
    // failure); the --all CI gate is the hard backstop.
    process.stdout.write(
      '[check-tracker-ids] staged: git diff failed; skipping (CI is the backstop).\n',
    );
    process.exit(0);
  }
  const staged = parseNameStatus(diff.stdout || '');
  // Restrict to in-scope public artifacts (same predicate --all uses).
  const inScope = staged.filter((e) => isInScope(e.path));
  if (!inScope.length) {
    if (json) report([], json);
    process.exit(0);
  }
  // Drop symlinks / submodules via the staged mode bits.
  const ls = git(['ls-files', '--stage', '-z', '--', ...inScope.map((e) => e.path)]);
  let regular = inScope;
  if (ls.status === 0) {
    regular = filterRegularFiles(inScope, parseLsFilesStage(ls.stdout || ''));
  }
  const violations = [];
  for (const e of regular) {
    // Scan the STAGED blob, not the working tree — only what is actually being
    // committed is gated (partial stage safety).
    const show = git(['show', `:${e.path}`]);
    if (show.status !== 0) continue;
    for (const h of scanText(show.stdout || '')) violations.push({ file: e.path, ...h });
  }
  process.exit(report(violations, json));
}

function runCommitMsg(file, json) {
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `[check-tracker-ids] cannot read commit-msg file ${file}: ${err.message}\n`,
    );
    process.exit(2);
  }
  // Decide comment/scissors handling by whether git added its editor template
  // (NOT by config, which the hook can't fully resolve). Two branches:
  //
  //   template present (editor commit) → git honors the --verbose scissors AND,
  //     in the default cleanup, strips `#` comment lines. Replicate: cut the
  //     scissors diff, then `stripspace --strip-comments`. This matches what git
  //     records and avoids a false-positive on the template's own branch/file
  //     names (e.g. a ticket-numbered branch in `# On branch ...`).
  //
  //   template absent (`git commit -m` / `-F` / whitespace / verbatim) → git
  //     keeps `#` lines and does NOT treat a bare `>8` line as scissors, so scan
  //     the message VERBATIM. This is what closes both -m gaps (a `#`-prefixed
  //     tracker id, and content after a user-written `>8` line).
  //
  // KNOWN LIMITATION (documented, exotic): an EDITOR commit run with an explicit
  // non-default `--cleanup=whitespace`/`verbatim` does carry a template yet keeps
  // `#` lines, so a tracker id sitting in a comment line there is not caught.
  // This needs a non-default flag AND a `#`-prefixed id; the prose path (the real
  // risk) is always caught, and the file gate (--all/--staged/CI) is the hard
  // guarantee. commit-msg is best-effort.
  let text;
  if (messageHasGitTemplate(raw)) {
    const noScissors = stripScissors(raw);
    const strip = git(['stripspace', '--strip-comments'], { input: noScissors });
    text = strip.status === 0 ? strip.stdout || '' : noScissors;
  } else {
    text = raw;
  }
  const violations = scanText(text).map((h) => ({ file: relative(REPO_ROOT, file) || file, ...h }));
  process.exit(report(violations, json));
}

// ── arg parsing ────────────────────────────────────────────────────────────

function usage(code) {
  process.stdout.write(
    'Usage:\n' +
      '  node scripts/check-tracker-ids.mjs [--all] [--json]\n' +
      '  node scripts/check-tracker-ids.mjs --staged [--json]\n' +
      '  node scripts/check-tracker-ids.mjs --commit-msg <file> [--json]\n',
  );
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);
const json = argv.includes('--json');

if (argv.includes('--commit-msg')) {
  const i = argv.indexOf('--commit-msg');
  const file = argv[i + 1];
  if (!file || file.startsWith('--')) {
    process.stderr.write('[check-tracker-ids] --commit-msg requires a file path\n');
    usage(2);
  }
  runCommitMsg(file, json);
} else if (argv.includes('--staged')) {
  runStaged(json);
} else {
  // default + explicit --all
  runAll(json);
}
