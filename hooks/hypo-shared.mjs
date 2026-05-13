#!/usr/bin/env node
/**
 * hypo-shared.mjs — shared utilities for Hypomnema hooks
 *
 * Imported by personal-wiki-check.mjs, wiki-compact-guard.mjs, and others.
 * Hooks are deployed to ~/.claude/hooks/ — no external imports allowed.
 */

import { readFileSync, existsSync } from 'fs';
import { join, relative, basename } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';

const HOME = homedir();

// ── wiki root resolution ────────────────────────────────────────────────────

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2));
  return p;
}

/**
 * Resolve Hypomnema root: HYPO_DIR env → hypo-config.md scan → ~/hypomnema default.
 * @returns {string}
 */
function resolveHypoRoot() {
  if (process.env.HYPO_DIR) return expandHome(process.env.HYPO_DIR);

  const candidates = [
    join(HOME, 'hypomnema'),
    join(HOME, 'wiki'),
    join(HOME, 'notes'),
    join(HOME, 'knowledge'),
    join(HOME, 'Documents', 'hypomnema'),
    join(HOME, 'Documents', 'wiki'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'hypo-config.md'))) return c;
  }
  return join(HOME, 'hypomnema');
}

export const HYPO_DIR   = resolveHypoRoot();
export const LOG_PATH   = join(HYPO_DIR, 'log.md');
export const HOT_PATH   = join(HYPO_DIR, 'hot.md');
export const GUIDE_PATH = join(HYPO_DIR, 'hypo-guide.md');

// Package root: written by init/upgrade to ~/.claude/hypo-pkg.json
function resolvePkgRoot() {
  const p = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(p)) return null;
  try { const v = JSON.parse(readFileSync(p, 'utf-8')).pkgRoot; return typeof v === 'string' && v ? v : null; } catch { return null; }
}
export const PKG_ROOT = resolvePkgRoot();

// Optional H2 allowlist for hot.md validation.
// Set HYPO_ALLOWED_HOT_H2=comma,separated,headings to enable.
const _allowedH2Env = process.env.HYPO_ALLOWED_HOT_H2;
export const ALLOWED_HOT_H2 = _allowedH2Env
  ? new Set(_allowedH2Env.split(',').map(s => s.trim()))
  : null;

// ── skip-gate helper ───────────────────────────────────────────────────────

/** Returns true if the wiki gate should be bypassed. */
export function isGateSkipped() {
  return process.env.HYPO_SKIP_GATE === '1';
}

// ── state checkers ─────────────────────────────────────────────────────────

export function lastSubstantialOpIsSession() {
  if (!existsSync(LOG_PATH)) return true;
  const log = readFileSync(LOG_PATH, 'utf-8');
  const substantial = log.split('\n')
    .filter(l => /^## \[\d{4}-\d{2}-\d{2}\] (session|ingest)/.test(l));
  if (substantial.length === 0) return true;
  return /^## \[\d{4}-\d{2}-\d{2}\] session/.test(substantial[substantial.length - 1]);
}

export function hypoIsClean() {
  try {
    const porcelain = spawnSync('git', ['-C', HYPO_DIR, 'status', '--porcelain'], { encoding: 'utf-8' });
    if (porcelain.status !== 0) return { clean: false, reason: `git check failed in ${HYPO_DIR}` };
    if (porcelain.stdout.trim() !== '') return { clean: false, reason: `uncommitted changes in ${HYPO_DIR}` };
    const ahead = spawnSync('git', ['-C', HYPO_DIR, 'status', '--branch', '--porcelain'], { encoding: 'utf-8' });
    if (/\[ahead \d+\]/.test(ahead.stdout || '')) return { clean: false, reason: `unpushed commits in ${HYPO_DIR}` };
    return { clean: true };
  } catch {
    return { clean: false, reason: `git check failed in ${HYPO_DIR}` };
  }
}

export function hotMdIsClean() {
  if (!existsSync(HOT_PATH)) return { clean: true };
  const content = readFileSync(HOT_PATH, 'utf-8');
  const reasons = [];

  // Optional: check H2 allowlist if HYPO_ALLOWED_HOT_H2 is set
  if (ALLOWED_HOT_H2) {
    const h2s = [...content.matchAll(/^## (.+)$/gm)].map(m => m[1].trim());
    const extra = h2s.filter(h => !ALLOWED_HOT_H2.has(h));
    if (extra.length > 0) reasons.push(`hot.md has unexpected H2 sections: ${extra.join(', ')}`);
  }

  // Always check for forbidden frontmatter fields
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch && /^last_session:/m.test(fmMatch[1])) {
    reasons.push('hot.md frontmatter has forbidden field: last_session');
  }

  return reasons.length === 0 ? { clean: true } : { clean: false, reason: reasons.join(' / ') };
}

// ── session-close checklist ────────────────────────────────────────────────

/**
 * Read the session-close checklist from hypo-guide.md.
 * Falls back to null if the guide is unavailable or the section can't be parsed.
 */
export function readChecklist(today) {
  if (!existsSync(GUIDE_PATH)) return null;
  try {
    const lines = readFileSync(GUIDE_PATH, 'utf-8').split('\n');
    let collecting = false;
    const result = [];
    for (const line of lines) {
      if (!collecting && /^\[ \] 0\./.test(line.trim())) collecting = true;
      if (collecting) {
        if (/^─+$/.test(line.trim()) || line.trim() === '```') break;
        result.push(line);
      }
    }
    if (result.length === 0) return null;
    return result.join('\n').replace(/YYYY-MM-DD/g, today);
  } catch {
    return null;
  }
}

// ── session-state schema ───────────────────────────────────────────────────

/** Accepted heading aliases for the "next task" section in session-state.md. */
export const SESSION_STATE_NEXT_HEADINGS = ['다음 이어받기', '다음 작업', 'Next Up', 'Next'];

// ── misc helpers ───────────────────────────────────────────────────────────

/** Returns true if the prompt is a /compact command invocation. */
export function isCompactCommand(prompt) {
  return prompt === '/compact' || /^\/compact(\s|$)/.test(prompt);
}

/**
 * Build hook output for Claude Code (additionalContext channel).
 * Codex hooks write systemMessage directly in their own files.
 */
export function buildOutput(context, extra = {}) {
  return { ...extra, additionalContext: context };
}

// ── growth metrics (F2 + E4) ───────────────────────────────────────────────
// Single formatter used by Stop (hot-rebuild) and SessionStart hooks so the
// "[hypo] +N pages, ~M updated, K wikilinks" line stays consistent at both
// ends of a session. See ADR-0018 / Lane B.

/**
 * Format a growth-metrics one-liner. Returns '' when all counts are 0 so
 * callers can no-op silently.
 *
 * @param {'stop'|'start'} mode
 * @param {{addedPages?:number, updatedPages?:number, newWikilinks?:number}} stats
 * @returns {string}
 */
export function formatGrowthMetrics(mode, stats) {
  const a = Number(stats?.addedPages)   || 0;
  const u = Number(stats?.updatedPages) || 0;
  const w = Number(stats?.newWikilinks) || 0;
  if (a === 0 && u === 0 && w === 0) return '';
  const body = `+${a} pages, ~${u} updated, ${w} wikilinks`;
  if (mode === 'stop')  return `[hypo] ${body}`;
  if (mode === 'start') return `[hypo] 직전 세션: ${body}. 이어서 볼까요?`;
  return '';
}

/**
 * Compute session growth by inspecting the wiki repo's working tree against
 * HEAD. Counts every modified/added/untracked markdown file under `pages/`
 * or `projects/` and totals net-new `[[wikilink]]` occurrences in the diff.
 *
 * @param {string} hypoDir
 * @returns {{addedPages:number, updatedPages:number, newWikilinks:number}}
 */
export function computeSessionGrowth(hypoDir) {
  const empty = { addedPages: 0, updatedPages: 0, newWikilinks: 0 };
  if (!existsSync(join(hypoDir, '.git'))) return empty;
  try {
    // Single `git status --porcelain` enumerates tracked + untracked. On a
    // clean tree (no .md changes at all) we return early and skip the much
    // more expensive `git diff HEAD --unified=0` — Stop hook P95 win.
    // `-uall` expands untracked directories so a brand-new `pages/new.md`
    // isn't hidden behind a single `?? pages/` line.
    const porcelain = spawnSync('git', ['-C', hypoDir, 'status', '--porcelain', '-uall'], { encoding: 'utf-8', timeout: 5000 });
    if (porcelain.status !== 0) return empty;
    let addedPages = 0, updatedPages = 0;
    let hasTrackedMdChange = false;
    const untrackedMd = [];
    for (const line of (porcelain.stdout || '').split('\n')) {
      if (!line) continue;
      const xy   = line.slice(0, 2);
      const file = line.slice(3).replace(/^"|"$/g, '').split(' -> ').pop().trim();
      if (!file.endsWith('.md')) continue;
      if (xy === '??') { untrackedMd.push(file); addedPages++; continue; }
      hasTrackedMdChange = true;
      if (xy.includes('A')) addedPages++;
      else if (xy.includes('M') || xy.includes('R')) updatedPages++;
    }
    if (!hasTrackedMdChange && untrackedMd.length === 0) return empty;

    let plus = 0, minus = 0;
    if (hasTrackedMdChange) {
      const diff = spawnSync('git', ['-C', hypoDir, 'diff', 'HEAD', '--unified=0'], { encoding: 'utf-8', timeout: 10000 });
      if (diff.status === 0) {
        for (const line of (diff.stdout || '').split('\n')) {
          if (line.startsWith('+++') || line.startsWith('---')) continue;
          const matches = line.match(/\[\[[^\]\n]+\]\]/g);
          if (!matches) continue;
          if (line.startsWith('+')) plus  += matches.length;
          else if (line.startsWith('-')) minus += matches.length;
        }
      }
    }
    for (const f of untrackedMd) {
      try {
        const body = readFileSync(join(hypoDir, f), 'utf-8');
        const matches = body.match(/\[\[[^\]\n]+\]\]/g);
        if (matches) plus += matches.length;
      } catch {}
    }
    return { addedPages, updatedPages, newWikilinks: Math.max(0, plus - minus) };
  } catch {
    return empty;
  }
}

// ── .hypoignore support ────────────────────────────────────────────────────
// Inlined here so deployed hooks (~/.claude/hooks/) don't need scripts/lib/.

function _globToRegex(glob) {
  return new RegExp('^' +
    glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\x00/g, '.*')
  + '$');
}

export function loadHypoIgnore(hypoDir) {
  const ignorePath = join(hypoDir, '.hypoignore');
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

export function isIgnored(filePath, hypoDir, patterns) {
  const rel = relative(hypoDir, filePath).replace(/\\/g, '/');
  const base = basename(filePath);
  for (const pattern of patterns) {
    const isDir = pattern.endsWith('/');
    if (isDir) {
      const dir = pattern.slice(0, -1);
      const isAnchored = dir.includes('/');
      if (isAnchored) {
        const re = _globToRegex(dir);
        const parts = rel.split('/');
        for (let i = dir.split('/').length; i <= parts.length; i++) {
          if (re.test(parts.slice(0, i).join('/'))) return true;
        }
      } else {
        const re = _globToRegex(dir);
        for (const part of rel.split('/')) {
          if (re.test(part)) return true;
        }
      }
      continue;
    }
    const hasSlash = pattern.includes('/');
    const target = hasSlash ? rel : base;
    if (_globToRegex(pattern).test(target)) return true;
  }
  return false;
}
