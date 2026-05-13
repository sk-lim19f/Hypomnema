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
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';

const HOME     = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT   = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT = '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json')         args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── result tracking ──────────────────────────────────────────────────────────

const checks = [];

function pass(label, detail = '') { checks.push({ status: 'pass', label, detail }); }
function warn(label, detail = '') { checks.push({ status: 'warn', label, detail }); }
function fail(label, detail = '') { checks.push({ status: 'fail', label, detail }); }

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
if (!_hookConfig.hooks || typeof _hookConfig.hooks !== 'object' || Array.isArray(_hookConfig.hooks)) {
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
  return group &&
    typeof group === 'object' &&
    !Array.isArray(group) &&
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every(hook =>
      hook &&
      typeof hook === 'object' &&
      !Array.isArray(hook) &&
      hook.type === 'command' &&
      _extractCommandFileName(hook.command)
    );
}

// Extract .mjs file names from both old format (string[]) and new format (hook-group object[])
function _extractFileNames(groups) {
  return groups.flatMap(group => {
    if (typeof group === 'string') return [group.trim()];
    return group.hooks.map(hook => _extractCommandFileName(hook.command));
  });
}

for (const [event, groups] of Object.entries(_hookConfig.hooks)) {
  const valid = Array.isArray(groups) &&
    groups.length > 0 &&
    groups.every(group => _isHookFileName(group) || _isHookGroup(group)) &&
    _extractFileNames(groups).length > 0;
  if (!valid) {
    console.error(`Error: hooks/hooks.json "hooks.${event}" must be a non-empty array of .mjs file names or Claude hook groups`);
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
}
if (_hookConfig.shared !== undefined && (!Array.isArray(_hookConfig.shared) || !_hookConfig.shared.every(f => _isHookFileName(f)))) {
  console.error('Error: hooks/hooks.json "shared" must be an array of .mjs file names');
  console.error(PKG_INTEGRITY_HINT);
  process.exit(1);
}

const HOOK_MAP     = Object.fromEntries(Object.entries(_hookConfig.hooks).map(([e, gs]) => [e, _extractFileNames(gs)]));
const SHARED_FILES = _hookConfig.shared ?? [];

// ── checks ───────────────────────────────────────────────────────────────────

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
  const required = ['pages', 'projects', 'sources'];
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
        .flatMap(g => g.hooks || [])
        .some(h => h.command === cmd);
      if (found) registered++;
    }
  }

  if (registered === total) {
    pass('settings.json hook registrations', `${registered}/${total} registered`);
  } else if (registered > 0) {
    warn('settings.json hook registrations', `${registered}/${total} registered — run /hypo:init to merge missing entries`);
  } else {
    fail('settings.json hook registrations', `0/${total} registered — run /hypo:init`);
  }
}

function checkGit(hypoDir) {
  if (!existsSync(join(hypoDir, '.git'))) {
    warn('Git repository', 'Not a git repo — run /hypo:init with git-remote option for sync/backup');
    return;
  }
  pass('Git repository');

  const remote = spawnSync('git', ['-C', hypoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  if (remote.status === 0 && remote.stdout.trim()) {
    pass('Git remote origin', remote.stdout.trim());
  } else {
    warn('Git remote origin', 'No remote configured — wiki will not sync/backup automatically');
  }
}

function checkBrokenLinks(hypoDir, ignorePatterns = []) {
  const mdFiles = collectMdFiles(hypoDir, [], hypoDir, ignorePatterns);
  const slugSet = buildSlugSet(mdFiles, hypoDir);
  const broken = [];

  for (const file of mdFiles) {
    const raw = readFileSync(file, 'utf-8');
    const content = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/`[^`\n]+`/g, '');
    const links = [...content.matchAll(/\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g)].map(m => m[1].trim());
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
    const sample = broken.slice(0, 5).map(b => `${b.file} → [[${b.link}]]`).join(', ');
    const extra  = broken.length > 5 ? ` (+${broken.length - 5} more)` : '';
    warn('Broken wiki links', `${broken.length} broken: ${sample}${extra}`);
  }
}

function collectMdFiles(dir, acc = [], hypoDir = '', ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (hypoDir && isIgnored(full, hypoDir, ignorePatterns)) continue;
    const st   = statSync(full);
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
  const today    = new Date().toISOString().slice(0, 10);
  const mdFiles  = collectMdFiles(hypoDir, [], hypoDir, ignorePatterns);
  const overdue  = [];
  const missing  = [];

  for (const file of mdFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm      = parseFrontmatter(content);
    if (!fm) continue;

    const type = fm.type || '';
    if (!['adr', 'page', 'learning'].includes(type)) continue;

    // verify_by = natural-language question; verify_by_date = ISO date deadline
    if (!fm.verify_by) {
      missing.push(relative(hypoDir, file));
    }
    if (fm.verify_by_date && /^\d{4}-\d{2}-\d{2}$/.test(fm.verify_by_date) && fm.verify_by_date < today) {
      overdue.push({ file: relative(hypoDir, file), due: fm.verify_by_date });
    }
  }

  if (overdue.length > 0) {
    const sample = overdue.slice(0, 3).map(o => `${o.file} (due ${o.due})`).join(', ');
    const extra  = overdue.length > 3 ? ` (+${overdue.length - 3} more)` : '';
    warn('verify_by_date overdue', `${overdue.length} overdue: ${sample}${extra}`);
  } else {
    pass('verify_by_date overdue', 'No overdue pages');
  }

  if (missing.length > 0) {
    warn('verify_by coverage', `${missing.length} pages (adr/page/learning) missing verify_by question`);
  } else {
    pass('verify_by coverage', 'All tracked pages have verify_by question');
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

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

  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  const passes = checks.filter(c => c.status === 'pass').length;

  console.log('');
  console.log(`Result: ${passes} passed, ${warns} warnings, ${fails} failed`);
  if (fails > 0) console.log('Run /hypo:init to repair installation issues.');
}

if (checks.some(c => c.status === 'fail')) process.exit(1);
