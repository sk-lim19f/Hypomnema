#!/usr/bin/env node
/**
 * Hypomnema doctor script
 *
 * Verifies the health of a Hypomnema wiki installation.
 *
 * Usage:
 *   node scripts/doctor.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>    Hypomnema root directory (default: resolved via HYPO_DIR / hypo-config.md scan / ~/hypomnema)
 *   --json               Output results as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isScanIgnored } from './lib/hypo-ignore.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { readSyncState, projectSuggestionsPath } from '../hooks/hypo-shared.mjs';
import {
  discoverExtensions,
  parseManifest,
  buildExpectedSettingsEntries,
  readExtensionPkgStateNoMutate,
  collectOurOccurrences,
  pickCanonicalOccurrence,
  EXT_TYPES,
  CODEX_TYPES,
} from './lib/extensions.mjs';
import { sha256, readFileIfRegular, readPkgJson } from './lib/pkg-json.mjs';
import { resolveCliOnPath, classifyInstall } from '../hooks/version-check.mjs';

const HOME = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT =
  '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false, codex: false, claudeHome: null, projectId: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json') args.json = true;
    else if (arg === '--codex') args.codex = true;
    else if (arg.startsWith('--claude-home=')) args.claudeHome = expandHome(arg.slice(14));
    else if (arg.startsWith('--project-id=')) args.projectId = arg.slice(13);
  }
  if (!args.claudeHome) args.claudeHome = join(HOME, '.claude');
  // projectId intentionally left null when not user-supplied — let feedback-sync
  // derive it and exercise its own "derived dir missing → skip MEMORY" path so
  // doctor reports "unresolved/skipped" rather than a misleading stale warning.
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── result tracking ──────────────────────────────────────────────────────────

const checks = [];

function pass(label, detail = '') {
  checks.push({ status: 'pass', label, detail });
}
function warn(label, detail = '') {
  checks.push({ status: 'warn', label, detail });
}
function fail(label, detail = '') {
  checks.push({ status: 'fail', label, detail });
}

// ── hook map (loaded from hooks/hooks.json — single source of truth) ─────────

let _hookConfig;
try {
  _hookConfig = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
} catch {
  console.error(`Error: cannot read hooks/hooks.json from package root: ${PKG_ROOT}`);
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}
if (!_hookConfig || typeof _hookConfig !== 'object' || Array.isArray(_hookConfig)) {
  console.error('Error: hooks/hooks.json must be a JSON object');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}
if (
  !_hookConfig.hooks ||
  typeof _hookConfig.hooks !== 'object' ||
  Array.isArray(_hookConfig.hooks)
) {
  console.error('Error: hooks/hooks.json must contain a "hooks" object');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}
function _extractCommandFileName(command) {
  if (typeof command !== 'string') return null;
  const matches = [...command.matchAll(/(?:^|[\/\\])([^\/\\\s"'`]+\.mjs)(?=$|[\s"'`])/g)];
  if (matches.length > 0) return matches[matches.length - 1][1];
  const bare = command.match(/(?:^|\s)([^\/\\\s"'`]+\.mjs)(?=$|[\s"'`])/);
  return bare ? bare[1] : null;
}

function _isHookFileName(file) {
  return typeof file === 'string' && /^[^/\\\s]+\.mjs$/.test(file.trim());
}

function _isHookGroup(group) {
  return (
    group &&
    typeof group === 'object' &&
    !Array.isArray(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every(
      (hook) =>
        hook &&
        typeof hook === 'object' &&
        !Array.isArray(hook) &&
        hook.type === 'command' &&
        _extractCommandFileName(hook.command),
    )
  );
}

// Extract .mjs file names from both old format (string[]) and new format (hook-group object[])
function _extractFileNames(groups) {
  return groups.flatMap((group) => {
    if (typeof group === 'string') return [group.trim()];
    return group.hooks.map((hook) => _extractCommandFileName(hook.command));
  });
}

for (const [event, groups] of Object.entries(_hookConfig.hooks)) {
  const valid =
    Array.isArray(groups) &&
    groups.length > 0 &&
    groups.every((group) => _isHookFileName(group) || _isHookGroup(group)) &&
    _extractFileNames(groups).length > 0;
  if (!valid) {
    console.error(
      `Error: hooks/hooks.json "hooks.${event}" must be a non-empty array of .mjs file names or Claude hook groups`,
    );
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
}
if (
  _hookConfig.shared !== undefined &&
  (!Array.isArray(_hookConfig.shared) || !_hookConfig.shared.every((f) => _isHookFileName(f)))
) {
  console.error('Error: hooks/hooks.json "shared" must be an array of .mjs file names');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}

const HOOK_MAP = Object.fromEntries(
  Object.entries(_hookConfig.hooks).map(([e, gs]) => [e, _extractFileNames(gs)]),
);
const SHARED_FILES = _hookConfig.shared ?? [];

// ── checks ───────────────────────────────────────────────────────────────────

function checkExternalDeps() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor >= 18) {
    pass('Node.js ≥ 18', `v${process.versions.node}`);
  } else {
    fail('Node.js ≥ 18', `v${process.versions.node} — upgrade to Node.js 18+`);
  }

  const npm = spawnSync('npm', ['--version'], { encoding: 'utf-8' });
  if (npm.status === 0) {
    pass('npm', `v${npm.stdout.trim()}`);
  } else {
    fail('npm', 'Not found — install npm');
  }

  const git = spawnSync('git', ['--version'], { encoding: 'utf-8' });
  if (git.status === 0) {
    pass('git', git.stdout.trim().replace('git version ', 'v'));
  } else {
    fail('git', 'Not found — install git');
  }

  const shell = process.env.SHELL || '';
  if (shell.endsWith('zsh') || shell.endsWith('bash')) {
    pass('Shell (zsh/bash)', shell);
  } else if (!shell) {
    warn('Shell (zsh/bash)', '$SHELL not set');
  } else {
    warn('Shell (zsh/bash)', `${shell} — zsh or bash recommended`);
  }
}

function checkHypoRoot(hypoDir) {
  if (!existsSync(hypoDir)) {
    fail('Wiki root exists', hypoDir);
    return false;
  }
  pass('Wiki root exists', hypoDir);

  if (existsSync(join(hypoDir, 'hypo-config.md'))) {
    pass('hypo-config.md marker');
  } else {
    warn('hypo-config.md marker', 'Missing — wiki root resolution may fall back to default');
  }
  return true;
}

function checkDirectories(hypoDir) {
  const required = [
    'pages',
    'projects',
    'sources',
    // Extensions baseline (ADR 0024). Existence only — SHA / settings /
    // manifest integrity is E5.
    'extensions/hooks',
    'extensions/commands',
    'extensions/skills',
    'extensions/agents',
  ];
  for (const d of required) {
    if (existsSync(join(hypoDir, d))) {
      pass(`Directory: ${d}/`);
    } else {
      fail(`Directory: ${d}/`, `Run /hypo:init to create missing directories`);
    }
  }
}

function checkFiles(hypoDir) {
  const required = ['index.md', 'hot.md', 'log.md', '.hypoignore', 'SCHEMA.md', 'hypo-guide.md'];
  for (const f of required) {
    if (existsSync(join(hypoDir, f))) {
      pass(`File: ${f}`);
    } else {
      warn(`File: ${f}`, 'Expected baseline file is missing');
    }
  }
}

function checkHooks() {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  const allFiles = [...Object.values(HOOK_MAP).flat(), ...SHARED_FILES];

  let missing = 0;
  for (const file of allFiles) {
    if (!existsSync(join(claudeHooks, file))) missing++;
  }

  if (missing === 0) {
    pass('Hook files installed', claudeHooks);
  } else if (missing < allFiles.length) {
    warn('Hook files installed', `${missing}/${allFiles.length} missing in ${claudeHooks}`);
  } else {
    fail('Hook files installed', `No hook files found in ${claudeHooks} — run /hypo:init`);
  }
}

function checkSettingsJson() {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    warn('settings.json hook registrations', 'settings.json not found');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    fail('settings.json hook registrations', 'settings.json is not valid JSON');
    return;
  }

  const hooksDir = join(HOME, '.claude', 'hooks');
  let registered = 0;
  let total = 0;

  for (const [event, files] of Object.entries(HOOK_MAP)) {
    for (const file of files) {
      total++;
      const cmd = `node ${hooksDir.replace(HOME, '$HOME')}/${file}`;
      const found = (Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [])
        .flatMap((g) => g.hooks || [])
        .some((h) => h.command === cmd);
      if (found) registered++;
    }
  }

  if (registered === total) {
    pass('settings.json hook registrations', `${registered}/${total} registered`);
  } else if (registered > 0) {
    warn(
      'settings.json hook registrations',
      `${registered}/${total} registered — run /hypo:init to merge missing entries`,
    );
  } else {
    fail('settings.json hook registrations', `0/${total} registered — run /hypo:init`);
  }

  // stale hypo-* entries (uninstall remnants).
  // hypo-ext-* commands are user-extension entries (ADR 0024) — not core hooks,
  // so they are intentionally absent from HOOK_MAP. Excluded here; their
  // integrity (SHA + manifest + entry match) is checked separately in E5.
  const isExtCommand = (cmd) => /(?:^|[/\s])hypo-ext-[^/\s]+\.mjs(?=$|["'\s])/.test(cmd);
  const expectedCmds = new Set(
    Object.entries(HOOK_MAP).flatMap(([, files]) =>
      files.map((f) => `node ${hooksDir.replace(HOME, '$HOME')}/${f}`),
    ),
  );
  const stale = [];
  for (const [, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      for (const h of g.hooks || []) {
        if (
          typeof h.command === 'string' &&
          /hypo-[^/]+\.mjs/.test(h.command) &&
          !isExtCommand(h.command) &&
          !expectedCmds.has(h.command)
        ) {
          stale.push(h.command);
        }
      }
    }
  }
  if (stale.length > 0) {
    warn(
      'settings.json stale hypo-* entries',
      `${stale.length} unrecognised hypo-* command(s) — run /hypo:uninstall then /hypo:init: ${stale.slice(0, 3).join(', ')}`,
    );
  } else {
    pass('settings.json stale hypo-* entries', 'None');
  }

  // duplicate hypo-* entries per event
  const dupes = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    const seen = new Set();
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      for (const h of g.hooks || []) {
        if (typeof h.command !== 'string' || !/hypo-[^/]+\.mjs/.test(h.command)) continue;
        if (isExtCommand(h.command)) continue; // ext duplicates are E5's concern
        if (seen.has(h.command)) dupes.push(`${event}:${h.command}`);
        else seen.add(h.command);
      }
    }
  }
  if (dupes.length > 0) {
    warn(
      'settings.json duplicate hypo-* entries',
      `${dupes.length} duplicate(s) — run /hypo:init to repair: ${dupes.slice(0, 2).join(', ')}`,
    );
  } else {
    pass('settings.json duplicate hypo-* entries', 'None');
  }
}

function checkGit(hypoDir) {
  if (!existsSync(join(hypoDir, '.git'))) {
    warn(
      'Git repository',
      'Not a git repo — run /hypo:init with git-remote option for sync/backup',
    );
    return;
  }
  pass('Git repository');

  const remote = spawnSync('git', ['-C', hypoDir, 'remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
  });
  if (remote.status === 0 && remote.stdout.trim()) {
    pass('Git remote origin', remote.stdout.trim());
  } else {
    warn('Git remote origin', 'No remote configured — wiki will not sync/backup automatically');
  }

  const preCommitPath = join(hypoDir, '.git', 'hooks', 'pre-commit');
  if (existsSync(preCommitPath)) {
    const content = readFileSync(preCommitPath, 'utf-8');
    if (content.includes('# hypo-managed:pre-commit:start')) {
      pass('.git/hooks/pre-commit', 'Hypomnema .hypoignore guard installed');
    } else {
      warn(
        '.git/hooks/pre-commit',
        'Exists but not managed by Hypomnema — manual git add can bypass .hypoignore',
      );
    }
  } else {
    warn('.git/hooks/pre-commit', 'Not installed — run /hypo:init to install .hypoignore guard');
  }
}

function checkBrokenLinks(hypoDir, ignorePatterns = []) {
  const mdFiles = collectMdFiles(hypoDir, [], hypoDir, ignorePatterns);
  const slugSet = buildSlugSet(mdFiles, hypoDir);
  const broken = [];

  for (const file of mdFiles) {
    const raw = readFileSync(file, 'utf-8');
    const content = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/`[^`\n]+`/g, '');
    const links = [...content.matchAll(/\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g)].map((m) =>
      m[1].trim(),
    );
    for (const link of links) {
      // skip object-path references (e.g. [[hooks.SessionStart]])
      if (link.includes('.') && !link.endsWith('.md')) continue;
      // skip template placeholders (e.g. [[projects/<project-name>/prd]])
      if (link.includes('<') || link.includes('>')) continue;
      const slug = link.replace(/\.md$/, '');
      if (!slugSet.has(slug) && !slugSet.has(slug.toLowerCase())) {
        broken.push({ file: relative(hypoDir, file), link });
      }
    }
  }

  if (broken.length === 0) {
    pass('Broken wiki links', `Scanned ${mdFiles.length} files`);
  } else {
    const sample = broken
      .slice(0, 5)
      .map((b) => `${b.file} → [[${b.link}]]`)
      .join(', ');
    const extra = broken.length > 5 ? ` (+${broken.length - 5} more)` : '';
    warn('Broken wiki links', `${broken.length} broken: ${sample}${extra}`);
  }
}

function collectMdFiles(dir, acc = [], hypoDir = '', ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (hypoDir && isScanIgnored(full, hypoDir, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectMdFiles(full, acc, hypoDir, ignorePatterns);
    else if (extname(entry) === '.md') acc.push(full);
  }
  return acc;
}

function buildSlugSet(files, hypoDir) {
  const set = new Set();
  for (const f of files) {
    const rel = relative(hypoDir, f).replace(/\.md$/, '');
    // add all path suffixes: pages/learnings/foo → also learnings/foo, foo
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      set.add(suffix);
      set.add(suffix.toLowerCase());
    }
  }
  return set;
}

function checkVerifyBy(hypoDir, ignorePatterns = []) {
  const today = new Date().toISOString().slice(0, 10);
  const mdFiles = collectMdFiles(hypoDir, [], hypoDir, ignorePatterns);
  const overdue = [];
  const missing = [];

  for (const file of mdFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const type = fm.type || '';
    if (!['adr', 'page', 'learning'].includes(type)) continue;

    // verify_by = natural-language question; verify_by_date = ISO date deadline
    if (!fm.verify_by) {
      missing.push(relative(hypoDir, file));
    }
    if (
      fm.verify_by_date &&
      /^\d{4}-\d{2}-\d{2}$/.test(fm.verify_by_date) &&
      fm.verify_by_date < today
    ) {
      overdue.push({ file: relative(hypoDir, file), due: fm.verify_by_date });
    }
  }

  if (overdue.length > 0) {
    const sample = overdue
      .slice(0, 3)
      .map((o) => `${o.file} (due ${o.due})`)
      .join(', ');
    const extra = overdue.length > 3 ? ` (+${overdue.length - 3} more)` : '';
    warn('verify_by_date overdue', `${overdue.length} overdue: ${sample}${extra}`);
  } else {
    pass('verify_by_date overdue', 'No overdue pages');
  }

  if (missing.length > 0) {
    warn(
      'verify_by coverage',
      `${missing.length} pages (adr/page/learning) missing verify_by question`,
    );
  } else {
    pass('verify_by coverage', 'All tracked pages have verify_by question');
  }
}

function checkSyncState(hypoDir) {
  // "open" = file exists with ≥1 entries; session-start clears once
  // sync is healthy again. Schema + parsing live in hooks/hypo-shared.mjs.
  const { entries, parseError } = readSyncState(hypoDir);

  if (parseError) {
    warn('Sync state', 'Cannot parse .cache/sync-state.json — inspect manually');
    return;
  }

  if (entries.length === 0) {
    pass('Sync state', 'No unresolved sync failures');
  } else {
    const last = entries[entries.length - 1];
    warn(
      'Sync state',
      `${entries.length} unresolved failure(s) — last: ${last.op || '?'} at ${last.timestamp || '?'}. Inspect .cache/sync-state.json or push/pull manually to clear.`,
    );
  }
}

function checkProjectSuggestions(hypoDir) {
  // ADR 0023: the auto-project skip-persistence store. Absent file is
  // healthy (no offers declined yet). Validate the RAW JSON shape here rather
  // than via readProjectSuggestions(): that helper deliberately normalizes a
  // non-array `skips` to [] for fail-open hook reads, which would mask a
  // malformed file and silently break permanent "N" suppression. Doctor must
  // catch the malformation the helper hides.
  const path = projectSuggestionsPath(hypoDir);
  if (!existsSync(path)) {
    pass('Auto-project suggestions', 'No skip-persistence file (clean)');
    return;
  }
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    warn(
      'Auto-project suggestions',
      'Cannot parse .cache/project-suggestions.json — inspect manually',
    );
    return;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    warn('Auto-project suggestions', 'project-suggestions.json must be a JSON object');
    return;
  }
  if (!Array.isArray(data.skips)) {
    warn(
      'Auto-project suggestions',
      '`skips` must be an array — declined-cwd suppression will not work',
    );
    return;
  }
  if (
    data.cooldowns !== undefined &&
    (typeof data.cooldowns !== 'object' || data.cooldowns === null || Array.isArray(data.cooldowns))
  ) {
    warn('Auto-project suggestions', '`cooldowns` must be a plain object');
    return;
  }
  const bad = data.skips.filter((s) => !s || typeof s.cwd !== 'string' || !s.cwd);
  if (bad.length > 0) {
    warn(
      'Auto-project suggestions',
      `${bad.length} malformed skip entr(ies) missing a string \`cwd\` in .cache/project-suggestions.json`,
    );
  } else {
    pass('Auto-project suggestions', `${data.skips.length} declined cwd(s) recorded`);
  }
}

function checkCodexPaths() {
  const codexHooks = join(HOME, '.codex', 'hooks');
  const allFiles = [...Object.values(HOOK_MAP).flat(), ...SHARED_FILES];

  let missing = 0;
  for (const file of allFiles) {
    if (!existsSync(join(codexHooks, file))) missing++;
  }

  if (missing === 0) {
    pass('Codex hook files installed', codexHooks);
  } else if (missing < allFiles.length) {
    warn(
      'Codex hook files installed',
      `${missing}/${allFiles.length} missing in ${codexHooks} — run /hypo:init --codex`,
    );
  } else {
    fail(
      'Codex hook files installed',
      `No hook files found in ${codexHooks} — run /hypo:init --codex`,
    );
  }

  const settingsPath = join(HOME, '.codex', 'settings.json');
  if (!existsSync(settingsPath)) {
    warn(
      'Codex settings.json hook registrations',
      'settings.json not found — run /hypo:init --codex',
    );
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    fail('Codex settings.json hook registrations', 'settings.json is not valid JSON');
    return;
  }

  const hooksDir = codexHooks;
  let registered = 0;
  let total = 0;

  for (const [event, files] of Object.entries(HOOK_MAP)) {
    for (const file of files) {
      total++;
      const cmd = `node ${hooksDir.replace(HOME, '$HOME')}/${file}`;
      const found = (Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [])
        .flatMap((g) => g.hooks || [])
        .some((h) => h.command === cmd);
      if (found) registered++;
    }
  }

  if (registered === total) {
    pass('Codex settings.json hook registrations', `${registered}/${total} registered`);
  } else if (registered > 0) {
    warn(
      'Codex settings.json hook registrations',
      `${registered}/${total} registered — run /hypo:init --codex`,
    );
  } else {
    fail(
      'Codex settings.json hook registrations',
      `0/${total} registered — run /hypo:init --codex`,
    );
  }
}

// ── extensions integrity (ADR 0024, E5) ───────────────────────────

// Detect drift between the user's `~/hypomnema/extensions/` source, the recorded
// per-target SHA map (`hypo-pkg.json`), and the installed copies + settings.json
// entries under `~/.claude` (or `~/.codex` with --codex). Reuses E2's read-only
// helpers (plan §5 D4) — never re-derives discovery/manifest/SHA logic.
//
// Severity taxonomy (plan §5 #4 pins manifest; the rest mirror the slash-command
// / settings-stale precedent that recoverable drift is a warn, not a ship blocker):
//   manifest malformed (parse fail / unknown event) → FAIL (won't self-heal; §5 #4)
//   manifest missing                                → warn (hook just won't register; §5 #4)
//   installed copy SHA ≠ recorded (user-modified)   → warn (--force-extensions recovers)
//   recorded entry but copy absent / non-regular    → warn (upgrade --apply recovers)
//   expected settings entry missing                 → warn (upgrade --apply recovers)
//   orphan settings entry (source removed)          → warn (uninstall recovers; boost #2)
// A malformed manifest failing here is what makes the §5.1.3 `fails=0` ship gate
// actually cover §8.12-7(c) — asserted by the doctor-extensions-integrity test.
//
// E5 is doctor SURFACE for extensions integrity. The mixed-group surgical
// *write* (preserve sibling-plugin hooks, swap only ours) used to be deferred
// here; ADR 0024 amendment 2026-05-23 lifted that deferral —
// registerSettings (extensions.mjs:478 docstring) now does occurrence-first +
// 8-rank canonical write, and the (b) loop below mirrors that read-path via
// collectOurOccurrences so a valid mixed-group occurrence is no longer warned
// as `not registered`.
function checkExtensions(hypoDir, claudeHome, target = 'claude') {
  const extDir = join(hypoDir, 'extensions');
  // E1 baseline absent (e.g. --from-remote clone, plan §5 #8) → nothing to check.
  if (!existsSync(extDir)) return;

  const root = target === 'codex' ? join(HOME, '.codex') : claudeHome;
  const label = target === 'codex' ? 'Codex extensions integrity' : 'Extensions integrity';
  // The per-target SHA map lives in ~/.claude/hypo-pkg.json under
  // `extensions.{claude,codex}` (sync writes both targets into the one file —
  // upgrade.mjs:681), so the pkg path is always claude regardless of target.
  const pkgPath = join(claudeHome, 'hypo-pkg.json');
  const settingsPath = join(root, 'settings.json');
  const hooksDir = join(root, 'hooks');
  const types = target === 'codex' ? CODEX_TYPES : EXT_TYPES;

  const patterns = loadHypoIgnore(hypoDir);
  const discovered = discoverExtensions(extDir, patterns, hypoDir);

  const problems = [];

  // (c) manifest health — hooks only (plan §0 D3: non-hook manifests don't register).
  for (const ext of discovered.hooks) {
    if (!ext.manifestPath) {
      problems.push({
        severity: 'warn',
        msg: `${ext.name}.manifest.json missing — hook will not auto-register`,
      });
      continue;
    }
    const parsed = parseManifest(ext.manifestPath);
    if (!parsed.ok) {
      problems.push({ severity: 'fail', msg: `${ext.manifestName} malformed (${parsed.error})` });
    }
  }

  // (a) hard-copy SHA: recorded SHA vs the installed copy on disk.
  const recorded = readExtensionPkgStateNoMutate(pkgPath, target);
  for (const [key, recSHA] of Object.entries(recorded)) {
    // Skip keys outside this target's covered types (defensive: a Claude run records
    // skills/agents that a codex target never installs — don't false-flag them).
    if (!types.includes(key.split('/')[0])) continue;
    const destPath = join(root, key);
    if (!existsSync(destPath)) {
      problems.push({
        severity: 'warn',
        msg: `${key} recorded but not installed — run upgrade --apply`,
      });
      continue;
    }
    const onDisk = readFileIfRegular(destPath);
    if (onDisk === null) {
      problems.push({ severity: 'warn', msg: `${key} is not a regular file — left untouched` });
      continue;
    }
    if (sha256(onDisk) !== recSHA) {
      problems.push({
        severity: 'warn',
        msg: `${key} modified since install (drift) — use --force-extensions`,
      });
    }
  }

  // (b) settings.json entries. Distinguish three states:
  //   - malformed JSON      → skip (checkSettingsJson / checkCodexPaths already FAILs it;
  //                            piling on a misleading "not registered" warn helps no one)
  //   - missing file / no `hooks` object → treat as an EMPTY hooks map, so a synced
  //     extension whose registration is absent still surfaces as expected-but-missing
  //     (§8.12-7(b)). A missing file alone with no extensions yields no problem (gate-safe).
  let settingsParseFailed = false;
  let hooksObj = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (
        parsed &&
        parsed.hooks &&
        typeof parsed.hooks === 'object' &&
        !Array.isArray(parsed.hooks)
      ) {
        hooksObj = parsed.hooks;
      }
    } catch {
      settingsParseFailed = true;
    }
  }
  if (!settingsParseFailed) {
    const expected = buildExpectedSettingsEntries(discovered.hooks, hooksDir);

    // (b) for each registrable hook: locate every occurrence of our command
    // (single-hook OR mixed group) and pick the canonical via the
    // SAME 8-rank logic registerSettings uses.
    // Without this mirror, doctor picked the first traversal-order occurrence
    // under the target event and warned "differs" even when a later
    // occurrence was the rank-1 canonical that upgrade --apply silently
    // accepts — a confusing gap between report and action.
    //
    // Outcomes:
    //   - no occurrence in any event       → warn `not registered`
    //   - canonical on a non-target event  → warn `not registered under <event>`
    //   - canonical rank 1/2 (exact)       → no drift; pass through
    //     (ext-command duplicates are surfaced separately below — core
    //     duplicate-warn at line ~344 excludes hypo-ext-* on purpose)
    //   - canonical rank 3/4/5 on target   → warn `settings entry differs`
    //
    // Mixed-group: a foreign sibling sharing our matcher group does NOT itself
    // count as drift — only our own hook fields ({type, command, timeout?}) and
    // the group's matcher are compared. Doctor never inspects foreign hook
    // shape (no peering into `if`/`args`/`async`/`statusMessage` etc.).
    for (const entry of expected) {
      const desiredHook = { type: 'command', command: entry.command };
      if (entry.timeout) desiredHook.timeout = entry.timeout;

      const occurrences = collectOurOccurrences(hooksObj, entry.command);
      const picked = pickCanonicalOccurrence(occurrences, entry, desiredHook);
      if (!picked) {
        problems.push({
          severity: 'warn',
          msg: `${entry.name} not registered under ${entry.event} — run upgrade --apply`,
        });
        continue;
      }
      if (picked.occ.event !== entry.event) {
        problems.push({
          severity: 'warn',
          msg: `${entry.name} not registered under ${entry.event} — run upgrade --apply`,
        });
      } else if (picked.rank >= 3) {
        // ranks 3/4/5 — on target event, but hook or matcher drifted.
        // The manifest boundary normalize
        // (extensions.mjs:178) collapses `matcher: ""` → absent only on the
        // manifest path. A hand-edited settings.json with `matcher: ""` still
        // mismatches an absent manifest matcher (rankOccurrence treats "" vs
        // undefined as non-equal). Surface the empty-string-vs-absent
        // equivalence ONLY when the hook itself is otherwise exact —
        // otherwise the specific message would hide a co-occurring hook /
        // timeout drift. The hookExact
        // comparison mirrors rankOccurrence's own canonical check
        // (extensions.mjs ~580) so doctor's report tracks --apply intent.
        const hookExact = JSON.stringify(picked.occ.hook) === JSON.stringify(desiredHook);
        if (picked.occ.group.matcher === '' && entry.matcher === undefined && hookExact) {
          problems.push({
            severity: 'warn',
            msg: `${entry.name} settings has matcher: "" (equivalent to absent) — run upgrade --apply to normalize`,
          });
        } else {
          problems.push({
            severity: 'warn',
            msg: `${entry.name} settings entry differs from manifest (matcher/hook/timeout) — run upgrade --apply`,
          });
        }
      }
      // ext-aware duplicate surface: core duplicate-warn at checkSettingsJson
      // intentionally skips hypo-ext-* (line ~353 isExtCommand guard). With
      // the canonical-pick above, exact rank-1 duplicates would otherwise be
      // invisible to doctor until upgrade --apply runs cleanup. Surface them
      // here so the report still names the work that --apply will do.
      if (occurrences.length > 1) {
        problems.push({
          severity: 'warn',
          msg: `${entry.name} has ${occurrences.length} occurrences in settings — run upgrade --apply to clean up`,
        });
      }
    }

    // orphan (boost #2): a hypo-ext-* command in settings with no source extension.
    // E4 excluded hypo-ext-* from the core stale checker (doctor.mjs:302), so this
    // is the ONLY place orphaned extension entries are caught.
    //
    // Two distinct orphan classes:
    //   - source-removed: settings entry whose source file is gone → uninstall
    //   - unregistrable : source file present but manifest malformed/non-hook,
    //                     so (b) above skipped it and (c) only FAIL/warned the
    //                     manifest itself, never naming the stale settings entry.
    //                     Surfaced separately so the user knows the lingering
    //                     entry needs cleanup independent of the manifest fix.
    const cmdFor = (ext) => `node ${hooksDir.replace(HOME, '$HOME')}/${ext.file}`;
    const sourceCmds = new Set(discovered.hooks.map(cmdFor));
    const unregistrableCmds = new Set();
    for (const ext of discovered.hooks) {
      if (!ext.manifestPath) continue; // (c-warn) already names this case
      const parsed = parseManifest(ext.manifestPath);
      if (!parsed.ok || !parsed.registrable) unregistrableCmds.add(cmdFor(ext));
    }
    // A single hypo-ext-* command can appear
    // in multiple groups/events when settings.json was hand-edited or migrated
    // across events. The registrable-entry duplicate surface above
    // (`occurrences.length > 1`) only iterates `expected`, so orphan-class
    // duplicates were silently de-duped to a single warn. Count occurrences per
    // orphan command and append `(N occurrences)` when count > 1.
    //
    // Order: check `unregistrableCmds` BEFORE `sourceCmds` — a malformed or
    // non-hook manifest still has the source file present, so the
    // `sourceCmds.has` check would otherwise misclassify them as non-orphan.
    const orphanInfo = new Map(); // command → { kind, count }
    for (const groups of Object.values(hooksObj)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        if (!Array.isArray(g.hooks)) continue;
        for (const h of g.hooks) {
          if (typeof h.command !== 'string') continue;
          if (!/(?:^|[/\s])hypo-ext-[^/\s]+\.mjs(?=$|["'\s])/.test(h.command)) continue;
          let kind = null;
          if (unregistrableCmds.has(h.command)) kind = 'unregistrable';
          else if (!sourceCmds.has(h.command)) kind = 'source-removed';
          else continue;
          const info = orphanInfo.get(h.command);
          if (info) info.count += 1;
          else orphanInfo.set(h.command, { kind, count: 1 });
        }
      }
    }
    for (const [cmd, { kind, count }] of orphanInfo) {
      const suffix = count > 1 ? ` (${count} occurrences)` : '';
      const msg =
        kind === 'unregistrable'
          ? `orphan settings entry (${cmd}) — manifest unregistrable${suffix}; run uninstall`
          : `orphan settings entry (${cmd}) — source extension removed${suffix}; run uninstall`;
      problems.push({ severity: 'warn', msg });
    }
  }

  if (problems.length === 0) {
    pass(label, 'All extensions consistent');
    return;
  }
  const hasFail = problems.some((p) => p.severity === 'fail');
  const sample = problems
    .slice(0, 4)
    .map((p) => p.msg)
    .join('; ');
  const extra = problems.length > 4 ? ` (+${problems.length - 4} more)` : '';
  if (hasFail) fail(label, `${sample}${extra}`);
  else warn(label, `${sample}${extra}`);
}

// ── feedback projection (ADR 0031) ──────────────────────────────

// Spawn feedback-sync.mjs --check --json and map its drift report onto doctor's
// pass/warn/fail. Integrity violations (exit-3 class: conflict / unpaired marker
// / intruder line / block out of container) are FAIL. Plain drift, build errors,
// over-cap, and an unresolved project-id are WARN — a fresh system that has not
// run `feedback-sync --write` yet is normal and must not block doctor.
function checkFeedbackProjection(hypoDir, claudeHome, projectId) {
  const cliPath = join(PKG_ROOT, 'scripts', 'feedback-sync.mjs');
  const cliArgs = [
    cliPath,
    '--check',
    '--json',
    '--no-input', // never let the child block on a TTY prompt under doctor
    `--hypo-dir=${hypoDir}`,
    `--claude-home=${claudeHome}`,
  ];
  // forward --project-id ONLY when the user supplied one; otherwise let
  // feedback-sync derive it and run its derived-missing → skip-MEMORY path
  if (projectId) cliArgs.push(`--project-id=${projectId}`);
  const r = spawnSync(process.execPath, cliArgs, { encoding: 'utf-8' });

  // feedback-sync exits non-zero on drift/over-cap/conflict — that is expected
  // and still prints a JSON report on stdout. Only treat a missing process or
  // unparseable stdout as a doctor-level problem (warn, never crash).
  if (r.error || r.status === null) {
    warn(
      'Feedback projection',
      `feedback-sync could not run: ${r.error?.message || 'no exit code'}`,
    );
    return;
  }
  let report;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    warn('Feedback projection', 'feedback-sync produced no JSON report — inspect manually');
    return;
  }
  if (report.error) {
    warn('Feedback projection', report.error);
    return;
  }

  const targets = Object.entries(report.targets || {});

  // 1) integrity violations → FAIL
  const broken = targets.find(
    ([, t]) => (t.conflicts && t.conflicts.length) || t.unpaired || t.intruder || t.outOfContainer,
  );
  if (broken) {
    const [name, t] = broken;
    const reason =
      t.conflicts && t.conflicts.length
        ? `conflict (${t.conflicts.join(', ')})`
        : t.unpaired
          ? 'unpaired managed marker'
          : t.intruder
            ? 'hand-edited line inside managed region'
            : 'managed block outside its container';
    fail(
      'Feedback projection integrity',
      `${name}: ${reason} — run \`hypomnema feedback-sync --import-target-change\` to reconcile`,
    );
  } else {
    // 2) build error → WARN
    const buildErr = targets.find(([, t]) => t.buildError);
    if (buildErr) {
      warn('Feedback projection', buildErr[1].buildError);
    } else if (targets.find(([, t]) => t.overCap)) {
      warn('Feedback projection', 'projection over cap — demote/archive feedback pages');
    } else if (targets.find(([, t]) => t.dirty)) {
      warn('Feedback projection', 'projections stale — run `hypomnema feedback-sync --write`');
    } else {
      const candidates = targets.reduce((n, [, t]) => n + (t.candidates || 0), 0);
      if (candidates > 0) pass('Feedback projection', 'in sync');
      else pass('Feedback projection', 'no projection candidates');
    }
  }

  // 3) unresolved project-id is a separate, non-fatal concern (MEMORY skipped)
  if (report.projectIdResolved === false) {
    warn(
      'Feedback projection',
      `project-id ${report.projectId} unresolved — MEMORY projection skipped; pass --project-id`,
    );
  }
}

// ── stale sibling install (ADR 0038, D) ──────────────────────────────────────
//
// Detect a SECOND, older Hypomnema that owns the `hypomnema` bin on PATH while a
// newer copy owns the active hooks. That sibling is a footgun: `hypomnema init` /
// `upgrade --apply` routed through it downgrades the active hooks. This is a
// detective backstop to the preventive init/upgrade guard — but it must NOT be
// the only surface, since `hypomnema doctor` invoked via the stale CLI would run
// the OLD doctor (the active-hook notifier covers that live case). fs-only.
function checkStaleSibling() {
  const active = readPkgJson(join(HOME, '.claude', 'hypo-pkg.json'));
  if (!active || !active.pkgVersion) {
    pass('PATH CLI vs active install', 'no active metadata (skipped)');
    return;
  }
  const cli = resolveCliOnPath('hypomnema');
  if (!cli) {
    pass('PATH CLI vs active install', `no \`hypomnema\` on PATH (active v${active.pkgVersion})`);
    return;
  }
  const verdict = classifyInstall(
    { pkgRoot: cli.pkgRoot, version: cli.version },
    { pkgRoot: active.pkgRoot, version: active.pkgVersion },
  );
  if (verdict === 'downgrade') {
    warn(
      'PATH CLI vs active install',
      `stale sibling: \`${cli.binPath}\` is v${cli.version}, active is v${active.pkgVersion} — ` +
        `running it would DOWNGRADE hooks. Remove with \`npm uninstall -g hypomnema\``,
    );
  } else {
    pass('PATH CLI vs active install', `v${cli.version} (active v${active.pkgVersion})`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

checkExternalDeps();
const ignorePatterns = loadHypoIgnore(args.hypoDir);
const rootOk = checkHypoRoot(args.hypoDir);
if (rootOk) {
  checkDirectories(args.hypoDir);
  checkFiles(args.hypoDir);
  checkBrokenLinks(args.hypoDir, ignorePatterns);
  checkVerifyBy(args.hypoDir, ignorePatterns);
}
checkHooks();
checkSettingsJson();
checkStaleSibling();
if (args.codex) checkCodexPaths();
if (rootOk) checkExtensions(args.hypoDir, args.claudeHome, 'claude');
if (rootOk && args.codex) checkExtensions(args.hypoDir, args.claudeHome, 'codex');
if (rootOk) checkSyncState(args.hypoDir);
if (rootOk) checkProjectSuggestions(args.hypoDir);
if (rootOk) checkFeedbackProjection(args.hypoDir, args.claudeHome, args.projectId);
checkGit(args.hypoDir);

// ── report ───────────────────────────────────────────────────────────────────

if (args.json) {
  console.log(JSON.stringify(checks, null, 2));
} else {
  const icons = { pass: '✓', warn: '⚠', fail: '✗' };
  for (const c of checks) {
    const detail = c.detail ? `  — ${c.detail}` : '';
    console.log(`${icons[c.status]} ${c.label}${detail}`);
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const passes = checks.filter((c) => c.status === 'pass').length;

  console.log('');
  console.log(`Result: ${passes} passed, ${warns} warnings, ${fails} failed`);
  if (fails > 0) console.log('Run /hypo:init to repair installation issues.');
}

if (checks.some((c) => c.status === 'fail')) process.exit(1);
