#!/usr/bin/env node
/**
 * Hypomnema upgrade script
 *
 * Compares the installed wiki against the current package version.
 * Reports schema version drift, stale hook files, and missing settings.json
 * registrations — without overwriting anything unless --apply is passed.
 *
 * Usage:
 *   node scripts/upgrade.mjs [options]
 *
 * Options:
 *   --wiki-dir=<path>   Wiki root directory (default: resolved via HYPO_DIR / hypo-config.md scan / ~/wiki)
 *   --apply             Apply hook file updates and settings.json merges
 *   --json              Output results as JSON
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { resolveWikiRoot, expandHome } from './lib/wiki-root.mjs';
import { parseFrontmatter } from './lib/frontmatter.mjs';

const HOME       = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT   = join(SCRIPT_DIR, '..');
const HOOKS_SRC  = join(PKG_ROOT, 'hooks');
const TEMPLATES  = join(PKG_ROOT, 'templates');

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { wikiDir: null, apply: false, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--wiki-dir=')) args.wikiDir = expandHome(arg.slice(11));
    else if (arg === '--apply')        args.apply = true;
    else if (arg === '--json')         args.json  = true;
  }
  if (!args.wikiDir) args.wikiDir = resolveWikiRoot();
  return args;
}

// ── version helpers ──────────────────────────────────────────────────────────

function parseVersion(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: parseInt(m[1], 10), minor: parseInt(m[2] || '0', 10), raw: String(str) };
}

function bumpType(installed, current) {
  if (!installed || !current) return 'unknown';
  if (installed.major !== current.major) {
    return installed.major > current.major ? 'ahead' : 'major';
  }
  if (installed.minor !== current.minor) {
    return installed.minor > current.minor ? 'ahead' : 'minor';
  }
  return 'none';
}

// ── hook map (loaded from hooks/hooks.json — single source of truth) ─────────

let _hookConfig;
try {
  _hookConfig = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
} catch {
  console.error(`Error: cannot read hooks/hooks.json from package root: ${PKG_ROOT}`);
  process.exit(1);
}
if (!_hookConfig || typeof _hookConfig !== 'object' || Array.isArray(_hookConfig)) {
  console.error('Error: hooks/hooks.json must be a JSON object');
  process.exit(1);
}
if (!_hookConfig.hooks || typeof _hookConfig.hooks !== 'object' || Array.isArray(_hookConfig.hooks)) {
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

for (const [event, groups] of Object.entries(_hookConfig.hooks)) {
  const valid = Array.isArray(groups) &&
    groups.length > 0 &&
    groups.every(group => _isHookFileName(group) || _isHookGroup(group)) &&
    _extractFileNames(groups).length > 0;
  if (!valid) {
    console.error(`Error: hooks/hooks.json "hooks.${event}" must be a non-empty array of .mjs file names or Claude hook groups`);
    process.exit(1);
  }
}
if (_hookConfig.shared !== undefined && (!Array.isArray(_hookConfig.shared) || !_hookConfig.shared.every(f => _isHookFileName(f)))) {
  console.error('Error: hooks/hooks.json "shared" must be an array of .mjs file names');
  process.exit(1);
}

const HOOK_MAP     = Object.fromEntries(Object.entries(_hookConfig.hooks).map(([e, gs]) => [e, _extractFileNames(gs)]));
const SHARED_FILES = _hookConfig.shared ?? [];

// ── checks ───────────────────────────────────────────────────────────────────

function checkSchemaVersion(wikiDir) {
  const pkgPath  = join(TEMPLATES, 'SCHEMA.md');
  const wikiPath = join(wikiDir, 'SCHEMA.md');

  const pkgVersion  = existsSync(pkgPath)
    ? parseVersion((parseFrontmatter(readFileSync(pkgPath, 'utf-8')) ?? {}).version)
    : null;
  const wikiVersion = existsSync(wikiPath)
    ? parseVersion((parseFrontmatter(readFileSync(wikiPath, 'utf-8')) ?? {}).version)
    : null;

  return {
    installed: wikiVersion?.raw ?? null,
    current:   pkgVersion?.raw  ?? null,
    bump:      bumpType(wikiVersion, pkgVersion),
    wikiPath,
    pkgPath,
  };
}

function checkHookFiles() {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  const results = [];

  const allFiles = [...Object.values(HOOK_MAP).flat(), ...SHARED_FILES];
  for (const file of allFiles) {
    const installedPath = join(claudeHooks, file);
    const srcPath       = join(HOOKS_SRC, file);

    if (!existsSync(installedPath)) {
      results.push({ file, status: 'missing', installedPath, srcPath });
    } else if (!existsSync(srcPath)) {
      results.push({ file, status: 'src-missing', installedPath, srcPath });
    } else {
      const installedContent = readFileSync(installedPath, 'utf-8');
      const srcContent       = readFileSync(srcPath, 'utf-8');
      results.push({
        file,
        status: installedContent === srcContent ? 'up-to-date' : 'stale',
        installedPath,
        srcPath,
      });
    }
  }

  return results;
}

function checkSettingsJson() {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  const hooksDir     = join(HOME, '.claude', 'hooks');
  const results      = [];

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch {
      return [{ event: '*', file: '*', status: 'invalid-json', cmd: '' }];
    }
  }

  for (const [event, files] of Object.entries(HOOK_MAP)) {
    for (const file of files) {
      const cmd   = `node ${hooksDir.replace(HOME, '$HOME')}/${file}`;
      const found = (Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : [])
        .flatMap(g => g.hooks || [])
        .some(h => h.command === cmd);
      results.push({ event, file, status: found ? 'registered' : 'missing', cmd });
    }
  }

  return results;
}

// ── apply actions ────────────────────────────────────────────────────────────

function applyHookFiles(hookResults) {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  mkdirSync(claudeHooks, { recursive: true });

  const applied = [];
  for (const h of hookResults) {
    if ((h.status === 'stale' || h.status === 'missing') && existsSync(h.srcPath)) {
      copyFileSync(h.srcPath, h.installedPath);
      applied.push(h.file);
    }
  }
  return applied;
}

function applySettingsJson(settingsResults) {
  const settingsPath = join(HOME, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf-8')); } catch { return []; }
  }
  if (!settings.hooks) settings.hooks = {};

  const applied = [];
  for (const s of settingsResults) {
    if (s.status !== 'missing') continue;
    if (!Array.isArray(settings.hooks[s.event])) settings.hooks[s.event] = [];
    settings.hooks[s.event].push({ hooks: [{ type: 'command', command: s.cmd }] });
    applied.push(`${s.event}: ${s.file}`);
  }

  if (applied.length > 0) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return applied;
}

function writeMigrationReport(wikiDir, fromVersion, toVersion) {
  const today    = new Date().toISOString().slice(0, 10);
  const filename = `MIGRATION-v${toVersion}.md`;
  const dest     = join(wikiDir, filename);

  // Don't overwrite an existing report
  if (existsSync(dest)) return dest;

  const content = `---
title: Migration Report — v${fromVersion} → v${toVersion}
type: reference
updated: ${today}
tags: [wiki, migration, schema]
---

# Migration Report: v${fromVersion} → v${toVersion}

Generated by \`/hypo:upgrade\` on ${today}.

## What changed

This is a **major version bump** (v${fromVersion} → v${toVersion}).
Review the SCHEMA diff and update your wiki pages accordingly.

## Action items

- [ ] Compare your \`SCHEMA.md\` (v${fromVersion}) with the package template (v${toVersion}) and update manually
- [ ] Run \`/hypo:upgrade --apply\` to install updated hook files and settings.json entries
- [ ] Check all \`adr\` and \`learning\` pages for new required frontmatter fields
- [ ] Run \`/hypo:doctor\` after applying updates to verify installation health

## Notes

Add migration-specific notes here after reviewing the SCHEMA diff.
`;

  writeFileSync(dest, content);
  return dest;
}

function checkPkgJson() {
  const path = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(path)) return { status: 'missing', path };
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8')).pkgRoot;
    if (typeof v !== 'string' || !v) return { status: 'missing', path };
    if (v !== PKG_ROOT) return { status: 'stale', path, installed: v, current: PKG_ROOT };
    return { status: 'up-to-date', path };
  } catch {
    return { status: 'missing', path };
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const schema   = checkSchemaVersion(args.wikiDir);
const hooks    = checkHookFiles();
const settings = checkSettingsJson();
const pkgJson  = checkPkgJson();

const staleHooks      = hooks.filter(h => h.status === 'stale' || h.status === 'missing' || h.status === 'src-missing');
const missingSettings = settings.filter(s => s.status === 'missing');
const invalidSettings = settings.some(s => s.status === 'invalid-json');
const schemaDrift     = schema.bump !== 'none' && schema.bump !== 'unknown' && schema.bump !== 'ahead';
const pkgJsonDrift    = pkgJson.status !== 'up-to-date';

let migrationPath    = null;
let appliedHooks     = [];
let appliedSettings  = [];
let appliedPkgJson   = false;

if (args.apply) {
  if (schema.bump === 'major' && schema.installed && schema.current && existsSync(args.wikiDir)) {
    migrationPath = writeMigrationReport(args.wikiDir, schema.installed, schema.current);
  }
  appliedHooks    = applyHookFiles(hooks);
  appliedSettings = applySettingsJson(settings);
  const pkgJsonPath = join(HOME, '.claude', 'hypo-pkg.json');
  writeFileSync(pkgJsonPath, JSON.stringify({ pkgRoot: PKG_ROOT }, null, 2) + '\n');
  appliedPkgJson = true;
}

// ── output ───────────────────────────────────────────────────────────────────

const hasDrift = staleHooks.length > 0 || missingSettings.length > 0 || schemaDrift || invalidSettings || pkgJsonDrift;

if (args.json) {
  console.log(JSON.stringify({
    schema,
    hooks,
    settings,
    pkgJson,
    applied: { hooks: appliedHooks, settings: appliedSettings, pkgJson: appliedPkgJson },
    migrationReport: migrationPath,
  }, null, 2));
  process.exit(hasDrift && !args.apply ? 1 : 0);
}

// Human-readable report
const lines = [];

// Schema version
if (schema.bump === 'none') {
  lines.push(`✓ SCHEMA version    ${schema.installed} (up to date)`);
} else if (schema.bump === 'unknown') {
  lines.push(`⚠ SCHEMA version    installed=${schema.installed ?? 'not found'}, package=${schema.current ?? 'not found'} (cannot compare)`);
} else if (schema.bump === 'ahead') {
  lines.push(`⚠ SCHEMA version    ${schema.installed} (installed is ahead of package ${schema.current})`);
} else if (schema.bump === 'major') {
  lines.push(`✗ SCHEMA version    ${schema.installed} → ${schema.current}  [MAJOR — review MIGRATION report, update manually]`);
} else {
  lines.push(`⚠ SCHEMA version    ${schema.installed} → ${schema.current}  [minor update — review and update SCHEMA.md manually]`);
}

// Hook files
const upToDate   = hooks.filter(h => h.status === 'up-to-date').length;
const staleCount = hooks.filter(h => h.status === 'stale').length;
const missCount  = hooks.filter(h => h.status === 'missing').length;
const srcMiss    = hooks.filter(h => h.status === 'src-missing').length;

if (staleCount === 0 && missCount === 0 && srcMiss === 0) {
  lines.push(`✓ Hook files        ${upToDate}/${hooks.length} up to date`);
} else {
  lines.push(`⚠ Hook files        ${upToDate} up to date, ${staleCount} stale, ${missCount} missing, ${srcMiss} src-missing:`);
  for (const h of hooks) {
    if (h.status === 'up-to-date') {
      lines.push(`    ✓ ${h.file}`);
    } else if (h.status === 'stale') {
      lines.push(`    ⚠ ${h.file}  [stale — package has newer version]`);
    } else if (h.status === 'missing') {
      lines.push(`    ✗ ${h.file}  [not found in ~/.claude/hooks/]`);
    } else if (h.status === 'src-missing') {
      lines.push(`    ⚠ ${h.file}  [installed but missing from package — may be orphaned]`);
    }
  }
}

// settings.json
const regCount = settings.filter(s => s.status === 'registered').length;
const missReg  = settings.filter(s => s.status === 'missing').length;

if (invalidSettings) {
  lines.push(`✗ settings.json     invalid JSON — fix or back it up before re-running`);
} else if (missReg === 0) {
  lines.push(`✓ settings.json     ${regCount}/${settings.length} hook registrations present`);
} else {
  lines.push(`⚠ settings.json     ${regCount}/${settings.length} registrations present — ${missReg} missing:`);
  for (const s of settings) {
    if (s.status === 'missing') lines.push(`    + ${s.event}: ${s.file}`);
  }
}

// Package metadata
if (pkgJson.status === 'up-to-date') {
  lines.push(`✓ Package metadata  hypo-pkg.json up to date`);
} else if (pkgJson.status === 'stale') {
  lines.push(`⚠ Package metadata  hypo-pkg.json stale (${pkgJson.installed} → ${pkgJson.current}) — run --apply to update`);
} else {
  lines.push(`✗ Package metadata  hypo-pkg.json missing — run --apply to install`);
}

// Migration report notice
if (migrationPath) {
  lines.push('');
  lines.push(`📋 Migration report: ${migrationPath}`);
  lines.push(`   Review and update SCHEMA.md manually — auto-overwrite is intentionally disabled.`);
}

// Applied actions
if (appliedHooks.length > 0 || appliedSettings.length > 0 || appliedPkgJson) {
  lines.push('');
  if (appliedHooks.length > 0) {
    lines.push(`✓ Updated hook files (${appliedHooks.length}):`);
    for (const f of appliedHooks) lines.push(`    → ${f}`);
  }
  if (appliedSettings.length > 0) {
    lines.push(`✓ Merged settings.json entries (${appliedSettings.length}):`);
    for (const e of appliedSettings) lines.push(`    → ${e}`);
  }
  if (appliedPkgJson) {
    lines.push(`✓ Written package metadata: ~/.claude/hypo-pkg.json`);
  }
}

// Summary
lines.push('');
const totalDrift = staleHooks.length + missingSettings.length + (schemaDrift ? 1 : 0) + (invalidSettings ? 1 : 0) + (pkgJsonDrift ? 1 : 0);
if (totalDrift === 0) {
  lines.push('Result: wiki is up to date');
} else if (args.apply) {
  const total = appliedHooks.length + appliedSettings.length + (appliedPkgJson ? 1 : 0);
  lines.push(`Result: ${total} update(s) applied. Run /hypo:doctor to verify.`);
} else {
  lines.push(`Result: ${totalDrift} item(s) need updating — run with --apply to install`);
}

console.log(lines.join('\n'));

process.exit(hasDrift && !args.apply ? 1 : 0);
