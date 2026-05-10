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
 *   --hypo-dir=<path>    Hypomnema root directory (default: resolved via HYPO_DIR / hypo-config.md scan / ~/hypomnema)
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
import { expandHome, resolveHypoRoot } from './lib/hypo-root.mjs';

const HOME     = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT   = join(SCRIPT_DIR, '..');
const HOOKS_SRC  = join(PKG_ROOT, 'hooks');
const TEMPLATES  = join(PKG_ROOT, 'templates');

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    hypoDir:    resolveHypoRoot(),
    privacy:    'personal',
    hooks:      true,
    codex:      false,
    gitRemote:  null,
    gitInit:    true,
    dryRun:     false,
    fromRemote: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/init.mjs [options]

Options:
  --hypo-dir=<path>      Hypomnema root directory (default: ~/hypomnema)
  --privacy=<mode>       personal | shared | public  (default: personal)
  --no-hooks             Skip hook installation
  --codex                Also install Codex hooks (~/.codex/hooks/)
  --git-remote=<url>     Git remote URL
  --no-git-init          Skip git initialization
  --from-remote=<url>    Clone existing wiki from remote and install hooks
  --dry-run              Show what would be done without making changes
  --help, -h             Show this help message`);
      process.exit(0);
    }
    else if (arg.startsWith('--hypo-dir='))     args.hypoDir    = expandHome(arg.slice(11));
    else if (arg.startsWith('--privacy='))       args.privacy    = arg.slice(10);
    else if (arg === '--no-hooks')               args.hooks      = false;
    else if (arg === '--codex')                  args.codex      = true;
    else if (arg.startsWith('--git-remote='))    args.gitRemote  = arg.slice(13);
    else if (arg === '--no-git-init')            args.gitInit    = false;
    else if (arg.startsWith('--from-remote='))   args.fromRemote = arg.slice(14);
    else if (arg === '--dry-run')                args.dryRun     = true;
  }
  return args;
}

// ── result tracking ──────────────────────────────────────────────────────────

const results = { created: [], skipped: [], merged: [], errors: [] };

function log(action, path) { results[action].push(path); }

// ── directory structure ──────────────────────────────────────────────────────

const HYPO_DIRS = ['pages', 'projects', 'sources', 'journal/daily', 'journal/weekly', 'journal/monthly'];

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

function writeHypoConfig(hypoDir, privacy, dryRun) {
  const dest = join(hypoDir, 'hypo-config.md');
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

// ── .hypoignore ──────────────────────────────────────────────────────────────

const SHARED_EXTRA = `
# shared/public mode: block personal identifiers
*personal*
*private*
journal/
`;

const PUBLIC_EXTRA = `
# public mode: maximum redaction — also block raw sources and drafts
sources/
drafts/
`;

function writeWikiignore(hypoDir, privacy, dryRun) {
  const dest = join(hypoDir, '.hypoignore');
  if (existsSync(dest)) { log('skipped', dest); return; }
  const src  = join(TEMPLATES, '.hypoignore');
  let content = existsSync(src) ? readFileSync(src, 'utf-8') : '';
  if (privacy === 'shared' || privacy === 'public') content += SHARED_EXTRA;
  if (privacy === 'public') content += PUBLIC_EXTRA;
  if (!dryRun) writeFileSync(dest, content);
  log('created', dest);
}

// ── hook installation ────────────────────────────────────────────────────────

function loadHookMap() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  } catch {
    console.error(`Error: cannot read hooks/hooks.json from package root: ${PKG_ROOT}`);
    process.exit(1);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    console.error('Error: hooks/hooks.json must be a JSON object');
    process.exit(1);
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) {
    console.error('Error: hooks/hooks.json must contain a "hooks" object');
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

  for (const [event, groups] of Object.entries(cfg.hooks)) {
    const valid = Array.isArray(groups) &&
      groups.length > 0 &&
      groups.every(group => _isHookFileName(group) || _isHookGroup(group)) &&
      _extractFileNames(groups).length > 0;
    if (!valid) {
      console.error(`Error: hooks/hooks.json "hooks.${event}" must be a non-empty array of .mjs file names or Claude hook groups`);
      process.exit(1);
    }
  }
  if (cfg.shared !== undefined && (!Array.isArray(cfg.shared) || !cfg.shared.every(f => _isHookFileName(f)))) {
    console.error('Error: hooks/hooks.json "shared" must be an array of .mjs file names');
    process.exit(1);
  }
  return Object.fromEntries(Object.entries(cfg.hooks).map(([event, groups]) => [event, _extractFileNames(groups)]));
}

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

function mergeSettingsJson(settingsPath, hooksDir, dryRun, hookMap) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {
      log('errors', `settings.json is not valid JSON — fix or back it up before re-running: ${settingsPath}`);
      return;
    }
  }
  if (!settings.hooks) settings.hooks = {};

  let changed = false;
  for (const [event, files] of Object.entries(hookMap)) {
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

// ── pkg git hook ────────────────────────────────────────────────────────────

const PKG_GIT_HOOK_CONTENT = `#!/bin/sh
# Auto-sync hooks/ to ~/.claude/hooks/ when hook files change.
REPO_ROOT="$(git rev-parse --show-toplevel)"
changed=$(git diff --name-only HEAD~1 HEAD 2>/dev/null | grep '^hooks/')
if [ -z "$changed" ]; then
  exit 0
fi
echo "[post-commit] hooks/ changed — syncing to ~/.claude/hooks/ ..."
node "$REPO_ROOT/scripts/upgrade.mjs" --apply
`;

function writePkgJson(dryRun) {
  const dest = join(HOME, '.claude', 'hypo-pkg.json');
  if (!dryRun) {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(dest, JSON.stringify({ pkgRoot: PKG_ROOT }, null, 2) + '\n');
    log('created', dest);
  }
}

function installPkgGitHook(dryRun) {
  const gitDir = join(PKG_ROOT, '.git');
  if (!existsSync(gitDir)) return;
  const hooksDir = join(gitDir, 'hooks');
  const hookPath = join(hooksDir, 'post-commit');
  if (existsSync(hookPath)) { log('skipped', hookPath); return; }
  if (!dryRun) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookPath, PKG_GIT_HOOK_CONTENT, { mode: 0o755 });
  }
  log('created', hookPath);
}

// ── from-remote clone ────────────────────────────────────────────────────────

function readPrivacyFromConfig(hypoDir) {
  const cfgPath = join(hypoDir, 'hypo-config.md');
  if (!existsSync(cfgPath)) return 'personal';
  try {
    const m = readFileSync(cfgPath, 'utf-8').match(/^privacy:\s*(\S+)/m);
    return m ? m[1] : 'personal';
  } catch { return 'personal'; }
}

function cloneFromRemote(url, hypoDir, dryRun) {
  if (existsSync(hypoDir)) {
    log('errors', `--from-remote: target directory already exists: ${hypoDir}. Remove it or choose a different --hypo-dir.`);
    return false;
  }
  console.log(`Cloning ${url} → ${hypoDir} ...`);
  if (!dryRun) {
    const r = spawnSync('git', ['clone', url, hypoDir], { stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      log('errors', `git clone failed: ${url}`);
      return false;
    }
  }
  log('created', hypoDir);
  return true;
}

// ── git setup ────────────────────────────────────────────────────────────────

function git(hypoDir, args, opts = {}) {
  return spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', ...opts });
}

function gitSetup(hypoDir, remote, dryRun) {
  const isGit = existsSync(join(hypoDir, '.git'));
  if (!isGit) {
    if (!dryRun) {
      const r = spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
      if (r.error || r.status !== 0) {
        log('errors', `git init failed in ${hypoDir}`);
        return;
      }
    }
    log('created', join(hypoDir, '.git'));
  }
  if (remote) {
    const existing = git(hypoDir, ['remote', 'get-url', 'origin']);
    if (existing.status === 0) {
      const url = existing.stdout.trim();
      if (url !== remote) log('skipped', `remote origin already set to ${url}`);
    } else {
      if (!dryRun) git(hypoDir, ['remote', 'add', 'origin', remote], { stdio: 'ignore' });
      log('merged', `git remote origin → ${remote}`);
    }
  }
}

// ── first commit + push ──────────────────────────────────────────────────────

function firstCommit(hypoDir, remote, dryRun) {
  const logR = git(hypoDir, ['log', '--oneline', '-1']);
  if (logR.status === 0 && logR.stdout.trim()) {
    log('skipped', 'first commit (repo already has commits)');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!dryRun) {
    git(hypoDir, ['add', '-A'], { stdio: 'ignore' });
    const commitR = git(hypoDir, ['commit', '-m', `chore: init hypomnema (${today})`]);
    if (commitR.status !== 0) { log('errors', 'first commit failed'); return; }
    if (remote) {
      const actualOrigin = git(hypoDir, ['remote', 'get-url', 'origin']);
      const pushTarget = actualOrigin.status === 0 ? actualOrigin.stdout.trim() : remote;
      const pushR = git(hypoDir, ['push', '-u', 'origin', 'HEAD']);
      if (pushR.status !== 0) log('errors', `git push failed: ${(pushR.stderr || '').trim()}`);
      else log('merged', `pushed to ${pushTarget}`);
    }
  }
  log('created', `first commit (${today})`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

// Validate hooks.json before any file writes so a bad package leaves no partial state
const HOOK_MAP = (args.hooks || args.codex) ? loadHookMap() : null;

if (args.fromRemote) {
  // ── from-remote path: clone → read config → install hooks ──────────────────
  const cloned = cloneFromRemote(args.fromRemote, args.hypoDir, args.dryRun);
  if (!cloned) {
    console.error(results.errors.join('\n'));
    process.exit(1);
  }
  // Read privacy from the cloned hypo-config.md (override CLI default)
  if (!args.dryRun) args.privacy = readPrivacyFromConfig(args.hypoDir);
} else {
  // ── normal path: create structure + templates ───────────────────────────────
  // 1. wiki directory structure
  ensureDir(args.hypoDir, args.dryRun);
  for (const d of HYPO_DIRS) ensureDir(join(args.hypoDir, d), args.dryRun);

  // 2. template files
  copyTemplate('index.md',          join(args.hypoDir, 'index.md'),          args.dryRun);
  copyTemplate('hot.md',            join(args.hypoDir, 'hot.md'),            args.dryRun);
  copyTemplate('log.md',            join(args.hypoDir, 'log.md'),            args.dryRun);
  copyTemplate('SCHEMA.md',         join(args.hypoDir, 'SCHEMA.md'),         args.dryRun);
  copyTemplate('hypo-guide.md',     join(args.hypoDir, 'hypo-guide.md'),     args.dryRun);
  copyTemplate('Home.md',           join(args.hypoDir, 'Home.md'),           args.dryRun);
  copyTemplate('Overview.md',       join(args.hypoDir, 'Overview.md'),       args.dryRun);
  copyTemplate('hypo-help.md',      join(args.hypoDir, 'hypo-help.md'),      args.dryRun);
  copyTemplate('hypo-automation.md',join(args.hypoDir, 'hypo-automation.md'),args.dryRun);
  copyTemplate('session-state.md',  join(args.hypoDir, 'session-state.md'),  args.dryRun);
  copyTemplate(join('pages', '_index.md'), join(args.hypoDir, 'pages', '_index.md'), args.dryRun);

  // projects/_template structure
  ensureDir(join(args.hypoDir, 'projects', '_template'), args.dryRun);
  ensureDir(join(args.hypoDir, 'projects', '_template', 'decisions'), args.dryRun);
  ensureDir(join(args.hypoDir, 'projects', '_template', 'session-log'), args.dryRun);
  copyTemplate(join('projects', '_template', 'hot.md'),          join(args.hypoDir, 'projects', '_template', 'hot.md'),          args.dryRun);
  copyTemplate(join('projects', '_template', 'index.md'),        join(args.hypoDir, 'projects', '_template', 'index.md'),        args.dryRun);
  copyTemplate(join('projects', '_template', 'prd.md'),          join(args.hypoDir, 'projects', '_template', 'prd.md'),          args.dryRun);
  copyTemplate(join('projects', '_template', 'session-state.md'),join(args.hypoDir, 'projects', '_template', 'session-state.md'),args.dryRun);

  // 3. hypo-config.md + .hypoignore
  writeHypoConfig(args.hypoDir, args.privacy, args.dryRun);
  writeWikiignore(args.hypoDir, args.privacy, args.dryRun);
}

// 4. hooks

if (args.hooks) {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  installHooks(claudeHooks, args.dryRun);
  mergeSettingsJson(join(HOME, '.claude', 'settings.json'), claudeHooks, args.dryRun, HOOK_MAP);
  writePkgJson(args.dryRun);
}

// 5. codex hooks (optional)
if (args.codex) {
  const codexHooks = join(HOME, '.codex', 'hooks');
  installHooks(codexHooks, args.dryRun);
  mergeSettingsJson(join(HOME, '.codex', 'settings.json'), codexHooks, args.dryRun, HOOK_MAP);
}

// 6. git setup (skip when cloned from remote — already has .git + remote)
if (args.gitInit && !args.fromRemote) {
  gitSetup(args.hypoDir, args.gitRemote, args.dryRun);
}

// 7. pkg repo git hook (auto-sync hooks/ → ~/.claude/hooks/ on commit)
if (args.hooks) {
  installPkgGitHook(args.dryRun);
}

// 8. first commit + push (skip when cloned from remote — already has commits)
if (args.gitInit && !args.fromRemote) {
  firstCommit(args.hypoDir, args.gitRemote, args.dryRun);
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
