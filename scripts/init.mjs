#!/usr/bin/env node
/**
 * Hypomnema init script
 *
 * Sets up a new wiki directory, installs hooks, and merges settings.json.
 * Called by /hypo:init after collecting wizard answers.
 *
 * Usage:
 *   node scripts/init.mjs [options]
 *
 * Options:
 *   --wiki-dir=<path>    Wiki root directory (default: ~/wiki)
 *   --privacy=<mode>     personal | shared | public  (default: personal)
 *   --no-hooks           Skip hook installation
 *   --codex              Also install Codex hooks (~/.codex/hooks/)
 *   --git-remote=<url>   Git remote URL
 *   --no-git-init        Skip git initialization
 *   --dry-run            Show what would be done without making changes
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const HOME     = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT   = join(SCRIPT_DIR, '..');
const HOOKS_SRC  = join(PKG_ROOT, 'hooks');
const TEMPLATES  = join(PKG_ROOT, 'templates');

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    wikiDir:   join(HOME, 'wiki'),
    privacy:   'personal',
    hooks:     true,
    codex:     false,
    gitRemote: null,
    gitInit:   true,
    dryRun:    false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir='))   args.wikiDir   = expandHome(arg.slice(11));
    else if (arg.startsWith('--privacy=')) args.privacy  = arg.slice(10);
    else if (arg === '--no-hooks')        args.hooks     = false;
    else if (arg === '--codex')           args.codex     = true;
    else if (arg.startsWith('--git-remote=')) args.gitRemote = arg.slice(13);
    else if (arg === '--no-git-init')     args.gitInit   = false;
    else if (arg === '--dry-run')         args.dryRun    = true;
  }
  return args;
}

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2));
  return p;
}

// ── result tracking ──────────────────────────────────────────────────────────

const results = { created: [], skipped: [], merged: [], errors: [] };

function log(action, path) { results[action].push(path); }

// ── directory structure ──────────────────────────────────────────────────────

const WIKI_DIRS = ['pages', 'projects', 'sources'];

function ensureDir(dir, dryRun) {
  if (existsSync(dir)) return;
  if (!dryRun) mkdirSync(dir, { recursive: true });
  log('created', dir);
}

// ── template copy ────────────────────────────────────────────────────────────

function copyTemplate(srcName, destPath, dryRun, transform) {
  const src = join(TEMPLATES, srcName);
  if (!existsSync(src)) { log('errors', `template missing: ${srcName}`); return; }
  if (existsSync(destPath)) { log('skipped', destPath); return; }
  if (!dryRun) {
    let content = readFileSync(src, 'utf-8');
    content = content.replace(/YYYY-MM-DD/g, new Date().toISOString().slice(0, 10));
    if (transform) content = transform(content);
    writeFileSync(destPath, content);
  }
  log('created', destPath);
}

// ── hypo-config.md ───────────────────────────────────────────────────────────

function writeHypoConfig(wikiDir, privacy, dryRun) {
  const dest = join(wikiDir, 'hypo-config.md');
  if (existsSync(dest)) { log('skipped', dest); return; }
  const today = new Date().toISOString().slice(0, 10);
  const src   = join(TEMPLATES, 'hypo-config.md');
  const base  = existsSync(src) ? readFileSync(src, 'utf-8') : '';
  const content = base
    .replace(/YYYY-MM-DD/g, today)
    .replace(/^privacy: personal$/m, `privacy: ${privacy}`);
  if (!dryRun) writeFileSync(dest, content);
  log('created', dest);
}

// ── .wikiignore ──────────────────────────────────────────────────────────────

const SHARED_EXTRA = `
# Shared / public mode: also block personal identifiers
*personal*
*private*
journal/
`;

function writeWikiignore(wikiDir, privacy, dryRun) {
  const dest = join(wikiDir, '.wikiignore');
  if (existsSync(dest)) { log('skipped', dest); return; }
  const src  = join(TEMPLATES, '.wikiignore');
  let content = existsSync(src) ? readFileSync(src, 'utf-8') : '';
  if (privacy === 'shared' || privacy === 'public') content += SHARED_EXTRA;
  if (!dryRun) writeFileSync(dest, content);
  log('created', dest);
}

// ── hook installation ────────────────────────────────────────────────────────

const HOOK_MAP = {
  SessionStart:     ['wiki-session-start.mjs'],
  UserPromptSubmit: ['wiki-first-prompt.mjs', 'wiki-lookup.mjs', 'wiki-compact-guard.mjs'],
  PreCompact:       ['personal-wiki-check.mjs'],
  PostToolUse:      ['wiki-auto-stage.mjs'],
  Stop:             ['wiki-hot-rebuild.mjs', 'wiki-auto-commit.mjs'],
  CwdChanged:       ['wiki-cwd-change.mjs'],
  FileChanged:      ['wiki-file-watch.mjs'],
};

function installHooks(targetDir, dryRun) {
  if (!existsSync(HOOKS_SRC)) { log('errors', `hooks source missing: ${HOOKS_SRC}`); return; }
  if (!dryRun) mkdirSync(targetDir, { recursive: true });
  for (const file of readdirSync(HOOKS_SRC)) {
    if (!file.endsWith('.mjs')) continue;
    const dest = join(targetDir, file);
    if (existsSync(dest)) { log('skipped', dest); continue; }
    if (!dryRun) copyFileSync(join(HOOKS_SRC, file), dest);
    log('created', dest);
  }
}

function mergeSettingsJson(settingsPath, hooksDir, dryRun) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {
      log('errors', `settings.json is not valid JSON — fix or back it up before re-running: ${settingsPath}`);
      return;
    }
  }
  if (!settings.hooks) settings.hooks = {};

  let changed = false;
  for (const [event, files] of Object.entries(HOOK_MAP)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    for (const file of files) {
      const cmd = `node ${hooksDir.replace(HOME, '$HOME')}/${file}`;
      const already = settings.hooks[event]
        .flatMap(g => g.hooks || [])
        .some(h => h.command === cmd);
      if (already) continue;
      settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd }] });
      log('merged', `${event}: ${file}`);
      changed = true;
    }
  }

  if (changed && !dryRun) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}

// ── git setup ────────────────────────────────────────────────────────────────

function git(wikiDir, args, opts = {}) {
  return spawnSync('git', ['-C', wikiDir, ...args], { encoding: 'utf-8', ...opts });
}

function gitSetup(wikiDir, remote, dryRun) {
  const isGit = existsSync(join(wikiDir, '.git'));
  if (!isGit) {
    if (!dryRun) {
      const r = spawnSync('git', ['init', wikiDir], { stdio: 'ignore' });
      if (r.error || r.status !== 0) {
        log('errors', `git init failed in ${wikiDir}`);
        return;
      }
    }
    log('created', join(wikiDir, '.git'));
  }
  if (remote) {
    const existing = git(wikiDir, ['remote', 'get-url', 'origin']);
    if (existing.status === 0) {
      const url = existing.stdout.trim();
      if (url !== remote) log('skipped', `remote origin already set to ${url}`);
    } else {
      if (!dryRun) git(wikiDir, ['remote', 'add', 'origin', remote], { stdio: 'ignore' });
      log('merged', `git remote origin → ${remote}`);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

// 1. wiki directory structure
ensureDir(args.wikiDir, args.dryRun);
for (const d of WIKI_DIRS) ensureDir(join(args.wikiDir, d), args.dryRun);

// 2. template files
copyTemplate('index.md',     join(args.wikiDir, 'index.md'),     args.dryRun);
copyTemplate('hot.md',       join(args.wikiDir, 'hot.md'),       args.dryRun);
copyTemplate('log.md',       join(args.wikiDir, 'log.md'),       args.dryRun);
copyTemplate('SCHEMA.md',    join(args.wikiDir, 'SCHEMA.md'),    args.dryRun);
copyTemplate('wiki-guide.md',join(args.wikiDir, 'wiki-guide.md'),args.dryRun);

// 3. hypo-config.md + .wikiignore
writeHypoConfig(args.wikiDir, args.privacy, args.dryRun);
writeWikiignore(args.wikiDir, args.privacy, args.dryRun);

// 4. hooks
if (args.hooks) {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  installHooks(claudeHooks, args.dryRun);
  mergeSettingsJson(join(HOME, '.claude', 'settings.json'), claudeHooks, args.dryRun);
}

// 5. codex hooks (optional)
if (args.codex) {
  const codexHooks = join(HOME, '.codex', 'hooks');
  installHooks(codexHooks, args.dryRun);
  mergeSettingsJson(join(HOME, '.codex', 'settings.json'), codexHooks, args.dryRun);
}

// 6. git setup
if (args.gitInit) {
  gitSetup(args.wikiDir, args.gitRemote, args.dryRun);
}

// ── report ───────────────────────────────────────────────────────────────────

const lines = [];
if (results.created.length)  lines.push(`✓ Created (${results.created.length}):\n${results.created.map(p => `  ${p}`).join('\n')}`);
if (results.skipped.length)  lines.push(`⊘ Skipped / already exists (${results.skipped.length}):\n${results.skipped.map(p => `  ${p}`).join('\n')}`);
if (results.merged.length)   lines.push(`↪ Merged into settings.json:\n${results.merged.map(p => `  ${p}`).join('\n')}`);
if (results.errors.length)   lines.push(`✗ Errors:\n${results.errors.map(p => `  ${p}`).join('\n')}`);

if (args.dryRun) lines.unshift('[DRY RUN — no changes made]');

console.log(lines.join('\n\n'));
if (results.errors.length) process.exit(1);
