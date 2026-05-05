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
 *   --wiki-dir=<path>    Wiki root directory (default: resolved via HYPO_DIR / hypo-config.md scan / ~/wiki)
 *   --json               Output results as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';

const HOME     = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT   = join(SCRIPT_DIR, '..');

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wikiDir: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir=')) args.wikiDir = expandHome(arg.slice(11));
    else if (arg === '--json')         args.json = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

// ── result tracking ──────────────────────────────────────────────────────────

const checks = [];

function pass(label, detail = '') { checks.push({ status: 'pass', label, detail }); }
function warn(label, detail = '') { checks.push({ status: 'warn', label, detail }); }
function fail(label, detail = '') { checks.push({ status: 'fail', label, detail }); }

// ── hook map (must match init.mjs) ───────────────────────────────────────────

const HOOK_MAP = {
  SessionStart:     ['wiki-session-start.mjs'],
  UserPromptSubmit: ['wiki-first-prompt.mjs', 'wiki-lookup.mjs', 'wiki-compact-guard.mjs'],
  PreCompact:       ['personal-wiki-check.mjs'],
  PostToolUse:      ['wiki-auto-stage.mjs'],
  Stop:             ['wiki-hot-rebuild.mjs', 'wiki-auto-commit.mjs'],
  CwdChanged:       ['wiki-cwd-change.mjs'],
  FileChanged:      ['wiki-file-watch.mjs'],
};

// ── checks ───────────────────────────────────────────────────────────────────

function checkWikiRoot(wikiDir) {
  if (!existsSync(wikiDir)) {
    fail('Wiki root exists', wikiDir);
    return false;
  }
  pass('Wiki root exists', wikiDir);

  if (existsSync(join(wikiDir, 'hypo-config.md'))) {
    pass('hypo-config.md marker');
  } else {
    warn('hypo-config.md marker', 'Missing — wiki root resolution may fall back to default');
  }
  return true;
}

function checkDirectories(wikiDir) {
  const required = ['pages', 'projects', 'sources', 'decisions', 'learnings'];
  for (const d of required) {
    if (existsSync(join(wikiDir, d))) {
      pass(`Directory: ${d}/`);
    } else {
      fail(`Directory: ${d}/`, `Run /hypo:init to create missing directories`);
    }
  }
}

function checkFiles(wikiDir) {
  const required = ['index.md', 'hot.md', 'log.md', '.wikiignore'];
  for (const f of required) {
    if (existsSync(join(wikiDir, f))) {
      pass(`File: ${f}`);
    } else {
      warn(`File: ${f}`, 'Expected baseline file is missing');
    }
  }
}

function checkHooks() {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  const allFiles = Object.values(HOOK_MAP).flat();

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
      const found = (settings.hooks?.[event] || [])
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

function checkGit(wikiDir) {
  if (!existsSync(join(wikiDir, '.git'))) {
    warn('Git repository', 'Not a git repo — run /hypo:init with git-remote option for sync/backup');
    return;
  }
  pass('Git repository');

  const remote = spawnSync('git', ['-C', wikiDir, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  if (remote.status === 0 && remote.stdout.trim()) {
    pass('Git remote origin', remote.stdout.trim());
  } else {
    warn('Git remote origin', 'No remote configured — wiki will not sync/backup automatically');
  }
}

function checkBrokenLinks(wikiDir) {
  const mdFiles = collectMdFiles(wikiDir);
  const slugSet = buildSlugSet(mdFiles, wikiDir);
  const broken = [];

  for (const file of mdFiles) {
    const content = readFileSync(file, 'utf-8');
    const links = [...content.matchAll(/\[\[([^\]|#\n]+?)(?:[|#][^\]]*?)?\]\]/g)].map(m => m[1].trim());
    for (const link of links) {
      // skip object-path references (e.g. [[hooks.SessionStart]]) and single-word placeholders
      if (link.includes('.') && !link.endsWith('.md')) continue;
      if (/^[a-z_-]+$/.test(link) && link.length <= 10) continue;
      const slug = link.replace(/\.md$/, '');
      if (!slugSet.has(slug) && !slugSet.has(slug.toLowerCase())) {
        broken.push({ file: relative(wikiDir, file), link });
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

function collectMdFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st   = statSync(full);
    if (st.isDirectory()) collectMdFiles(full, acc);
    else if (extname(entry) === '.md') acc.push(full);
  }
  return acc;
}

function buildSlugSet(files, wikiDir) {
  const set = new Set();
  for (const f of files) {
    const rel = relative(wikiDir, f).replace(/\.md$/, '');
    set.add(rel);
    set.add(rel.toLowerCase());
    const base = rel.split('/').pop();
    set.add(base);
    set.add(base.toLowerCase());
  }
  return set;
}

function checkVerifyBy(wikiDir) {
  const today    = new Date().toISOString().slice(0, 10);
  const mdFiles  = collectMdFiles(wikiDir);
  const overdue  = [];
  const missing  = [];

  for (const file of mdFiles) {
    const content = readFileSync(file, 'utf-8');
    const fm      = parseFrontmatter(content);
    if (!fm) continue;

    const type = fm.type || '';
    if (!['adr', 'page', 'learning'].includes(type)) continue;

    if (!fm.verify_by) {
      missing.push(relative(wikiDir, file));
    } else if (fm.verify_by < today) {
      overdue.push({ file: relative(wikiDir, file), due: fm.verify_by });
    }
  }

  if (overdue.length > 0) {
    const sample = overdue.slice(0, 3).map(o => `${o.file} (due ${o.due})`).join(', ');
    const extra  = overdue.length > 3 ? ` (+${overdue.length - 3} more)` : '';
    warn('verify_by overdue', `${overdue.length} overdue: ${sample}${extra}`);
  } else {
    pass('verify_by overdue', 'No overdue pages');
  }

  if (missing.length > 0) {
    warn('verify_by coverage', `${missing.length} pages (adr/page/learning) missing verify_by`);
  } else {
    pass('verify_by coverage', 'All tracked pages have verify_by');
  }
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    fm[key] = val;
  }
  return fm;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const rootOk = checkWikiRoot(args.wikiDir);
if (rootOk) {
  checkDirectories(args.wikiDir);
  checkFiles(args.wikiDir);
  checkBrokenLinks(args.wikiDir);
  checkVerifyBy(args.wikiDir);
}
checkHooks();
checkSettingsJson();
checkGit(args.wikiDir);

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
