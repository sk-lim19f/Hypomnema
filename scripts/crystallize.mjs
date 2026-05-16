#!/usr/bin/env node
/**
 * Hypomnema crystallize script
 *
 * Finds synthesis candidates: pages that share tags, unlinked pages,
 * and draft pages that could be crystallized into stable knowledge.
 * Used by /hypo:crystallize to surface what Claude should synthesize.
 *
 * Usage:
 *   node scripts/crystallize.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>        Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --min-group=<n>          Min pages per tag group to report (default: 2)
 *   --check-session-close    Verify the strict session-close memory files — 5 mandatory + open-questions conditional (fix #17)
 *   --apply-session-close    Apply a JSON payload that updates the 5 mandatory memory files
 *                            (+ optional open-questions). Idempotent — re-running with the same
 *                            payload is a no-op. Always finishes with the strict gate check.
 *
 *                            Without --payload, runs as a cheap "already complete?" probe:
 *                            if the strict gate is ok, exits 0 with alreadyComplete:true;
 *                            otherwise exits 1 with "payload is required". Fix #39 (option D):
 *                            payload presence = explicit close intent → always full apply
 *                            (fix #38's per-entry idempotency keeps re-apply cheap).
 *   --payload=<path|->       Path to JSON payload (file or `-` for stdin). Required for any
 *                            apply work; omit only for the probe path above.
 *   --force                  Bypass the no-payload probe early-exit. Payload is still required
 *                            for any apply work — --force only opts out of the alreadyComplete
 *                            shortcut. Reserved for explicit diagnostics / scripted recovery.
 *   --json                   Output as JSON
 *
 * Payload schema (fix #38):
 *   {
 *     "project":      "<slug>",                       // optional — defaults to resolveActiveProject()
 *     "date":         "YYYY-MM-DD",                   // optional — defaults to today (local)
 *     "sessionState": { "content": "<full file>" },   // overwrite (idempotent: identical bytes → skip)
 *     "projectHot":   { "content": "<full file>" },   // overwrite
 *     "rootHot":      { "content": "<full file>" },   // overwrite
 *     "sessionLog":   { "entry":   "## [date] ..." }, // append, skip if heading already present
 *     "log":          { "entry":   "## [date] session | <project> ..." }, // append, skip if entry present
 *     "openQuestions":{ "content": "<full file>" }    // optional overwrite
 *   }
 *
 * The helper does NOT auto-fix `updated:` frontmatter. If a payload field carries a
 * stale date, the final sessionCloseFileStatus check fails with a clear error so the
 * caller fixes the payload and retries. Silent rewrites would mask payload bugs.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from 'fs';
import { join, relative, extname, dirname } from 'path';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { loadHypoIgnore, isIgnored } from './lib/hypo-ignore.mjs';
import { sessionCloseFileStatus } from '../hooks/hypo-shared.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    hypoDir: null,
    minGroup: 2,
    json: false,
    checkSessionClose: false,
    applySessionClose: false,
    payload: null,
    force: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--min-group=')) args.minGroup = parseInt(arg.slice(12), 10) || 2;
    else if (arg === '--check-session-close') args.checkSessionClose = true;
    else if (arg === '--apply-session-close') args.applySessionClose = true;
    else if (arg.startsWith('--payload=')) args.payload = arg.slice(10);
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── session-close check (fix #17, spec §5.2.7 / §8.3) ────────────────────────
// Mirrors the hard gate in hypo-personal-check.mjs so the /hypo:crystallize
// flow can self-verify before /compact triggers PreCompact.

function runSessionCloseCheck(args) {
  const status = sessionCloseFileStatus(args.hypoDir);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: status.ok,
          project: status.project,
          dates: status.dates,
          stale: status.stale,
          missing: status.missing,
        },
        null,
        2,
      ),
    );
    process.exit(status.ok ? 0 : 1);
  }

  const proj = status.project || '(unresolved)';
  console.log(`Session-close check (project: ${proj}, date: ${status.dates.join(' / ')}):\n`);

  const required = status.project
    ? [
        `projects/${status.project}/session-state.md`,
        `projects/${status.project}/hot.md`,
        'hot.md',
        `projects/${status.project}/session-log/${status.dates[0].slice(0, 7)}.md`,
        'log.md',
      ]
    : [];
  for (const f of required) {
    const bad = status.missing.includes(f) ? 'missing' : status.stale.includes(f) ? 'stale' : '';
    console.log(`  ${bad ? '✗' : '✓'} ${f}${bad ? ` — ${bad}` : ''}`);
  }
  // Surface anything not covered by the canonical list (e.g. unresolved project).
  for (const f of [...status.missing, ...status.stale]) {
    if (!required.includes(f)) console.log(`  ✗ ${f}`);
  }
  console.log('');
  console.log(
    status.ok
      ? '✓ All required memory files updated this session. (open-questions.md: conditional, not checked)'
      : '✗ Session close incomplete — update the files marked above, then retry.',
  );
  process.exit(status.ok ? 0 : 1);
}

// ── session-close apply (fix #38) ────────────────────────────────────────────
// Idempotent payload-driven application of the 5 mandatory session-close memory
// files (+ optional open-questions). Used by the LLM session-close flow as the
// canonical entrypoint instead of issuing 5+ Write tool calls by hand.
//
// Idempotency:
//   • full-content fields (sessionState/projectHot/rootHot/openQuestions): write
//     only when on-disk bytes differ — re-running with same payload is a no-op.
//   • append fields (sessionLog/log): skip when the dated heading/entry is
//     already present (regex shared with sessionCloseFileStatus via hypo-shared).
//
// Validation: never auto-fixes the payload. The final sessionCloseFileStatus
// check fails fast on stale `updated:` or missing entries so the caller fixes
// the payload and retries — silent rewrites would hide payload bugs (advisor #3).

function readPayload(source) {
  if (!source)
    throw new Error('--payload is required with --apply-session-close (path or `-` for stdin)');
  let raw;
  if (source === '-') {
    // Synchronous stdin read; payloads are tiny (a few hundred KB at most).
    raw = readFileSync(0, 'utf-8');
  } else {
    const path = expandHome(source);
    if (!existsSync(path)) throw new Error(`payload file not found: ${path}`);
    raw = readFileSync(path, 'utf-8');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`payload is not valid JSON: ${e.message}`);
  }
}

/** Atomic write via tmp+rename. `<path>.<pid>.<rand>.tmp` so concurrent helpers
 * don't fight over the same shared `<path>.tmp` slot. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Atomic write that skips when on-disk bytes already match `content`. */
function writeIfChanged(path, content) {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf-8') === content) return false; // idempotent skip
    } catch {
      /* fall through to overwrite */
    }
  }
  atomicWrite(path, content);
  return true;
}

/**
 * Append `entry` to `path` only if `alreadyPresent(content)` is false.
 * Atomic: rebuilds the full file content and writes via atomicWrite — a crash
 * mid-append cannot leave log.md or session-log/YYYY-MM.md half-written, which
 * matters for these append-only history files (codex review of fix #38).
 */
function appendIfAbsent(path, entry, alreadyPresent) {
  let content = '';
  if (existsSync(path)) {
    try {
      content = readFileSync(path, 'utf-8');
    } catch {
      content = '';
    }
  }
  if (alreadyPresent(content)) return false;
  // Ensure single blank line between existing tail and new entry, no trailing dup.
  const sep =
    content === '' ? '' : content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  const next = entry.endsWith('\n') ? entry : entry + '\n';
  atomicWrite(path, content + sep + next);
  return true;
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Spec §5.2.7 / §8.3 + ADR 0029: 5 mandatory + 1 conditional. The payload
// shape MUST mirror that contract — missing a mandatory field is a payload
// bug, not a no-op. Caller is the LLM session-close flow, which composes the
// payload deliberately; partial payloads must fail loudly so caller fixes them
// rather than silently relying on yesterday's freshness state. (Codex review
// of fix #38 — Worker 1 finding 1.)
const REQUIRED_PAYLOAD_FIELDS = [
  ['sessionState', 'content'],
  ['projectHot', 'content'],
  ['rootHot', 'content'],
  ['sessionLog', 'entry'],
  ['log', 'entry'],
];

function validatePayloadShape(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') {
    errs.push('payload must be a JSON object');
    return errs;
  }
  for (const [field, key] of REQUIRED_PAYLOAD_FIELDS) {
    const slot = payload[field];
    if (!slot || typeof slot !== 'object') {
      errs.push(`payload.${field} is required (object with .${key})`);
      continue;
    }
    if (typeof slot[key] !== 'string') {
      errs.push(`payload.${field}.${key} must be a string`);
    }
  }
  if (payload.openQuestions !== undefined) {
    if (
      !payload.openQuestions ||
      typeof payload.openQuestions !== 'object' ||
      typeof payload.openQuestions.content !== 'string'
    ) {
      errs.push('payload.openQuestions, when present, must be { content: string }');
    }
  }
  if (payload.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(payload.date))) {
    errs.push('payload.date, when present, must be YYYY-MM-DD');
  }
  return errs;
}

function applySessionClose(args) {
  // Fix #39 (option D): early-exit fires only when NO payload was supplied.
  // Rationale: payload presence is explicit close intent and must always run
  // the full apply path — fix #38's per-entry idempotency (writeIfChanged +
  // exact-entry append dedup) keeps re-apply cheap without short-circuiting,
  // and avoids silent-success when a same-day second close brings new bytes.
  // Payload-less invocation is treated as a cheap "already complete?" probe.
  // --force opts out of that probe shortcut only — payload remains required
  // for any actual apply work (readPayload below surfaces "payload is
  // required" the same way it always has).
  if (!args.force && !args.payload) {
    const probe = sessionCloseFileStatus(args.hypoDir);
    if (probe.ok) {
      const result = {
        ok: true,
        alreadyComplete: true,
        project: probe.project,
        date: probe.dates[0],
        message: '오늘 이미 close 완료로 보임 (probe 모드 — payload 미지정).',
      };
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✓ ${result.message}`);
        console.log(`  project: ${result.project} / date: ${result.date}`);
      }
      process.exit(0);
    }
    // gate not ok → fall through to readPayload, which surfaces
    // "payload is required" with the same error shape as before.
  }

  let payload;
  try {
    payload = readPayload(args.payload);
  } catch (e) {
    const out = { ok: false, error: e.message };
    console.log(args.json ? JSON.stringify(out, null, 2) : `✗ ${e.message}`);
    process.exit(1);
  }

  const schemaErrs = validatePayloadShape(payload);
  if (schemaErrs.length > 0) {
    const out = { ok: false, error: 'payload schema invalid', details: schemaErrs };
    console.log(
      args.json
        ? JSON.stringify(out, null, 2)
        : `✗ payload schema invalid:\n  ${schemaErrs.join('\n  ')}`,
    );
    process.exit(1);
  }

  // Resolve project: explicit payload.project wins; else fall back to active project.
  // Done via sessionCloseFileStatus to keep one source of truth (and so a
  // missing pointer table surfaces the same error shape as --check-session-close).
  const probe = sessionCloseFileStatus(args.hypoDir);
  const project = payload.project || probe.project;
  if (!project) {
    const msg =
      'no project resolved (payload.project missing and root hot.md has no active-project row)';
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  const date = payload.date || todayLocal();
  const ym = date.slice(0, 7);

  const applied = [];
  const skipped = [];

  const overwrite = (key, relPath, field) => {
    if (!field || typeof field.content !== 'string') return; // optional / absent
    const wrote = writeIfChanged(join(args.hypoDir, relPath), field.content);
    (wrote ? applied : skipped).push(`${key} (${relPath})`);
  };

  overwrite('sessionState', join('projects', project, 'session-state.md'), payload.sessionState);
  overwrite('projectHot', join('projects', project, 'hot.md'), payload.projectHot);
  overwrite('rootHot', 'hot.md', payload.rootHot);
  overwrite('openQuestions', join('pages', 'open-questions.md'), payload.openQuestions);

  // Append idempotency: dedup by exact-entry presence, not by "any heading
  // dated today". The freshness gate (sessionCloseFileStatus) is what answers
  // "was this file touched today?"; that's a different concern and must not
  // be reused for apply-time dedup, or a legitimate same-day second close gets
  // silently dropped (Codex review of fix #38 — Worker 1 finding 2).
  const entryAlreadyPresent = (entry) => (content) =>
    content.includes(entry.endsWith('\n') ? entry.replace(/\n+$/, '') : entry);

  {
    const rel = join('projects', project, 'session-log', `${ym}.md`);
    const wrote = appendIfAbsent(
      join(args.hypoDir, rel),
      payload.sessionLog.entry,
      entryAlreadyPresent(payload.sessionLog.entry),
    );
    (wrote ? applied : skipped).push(`sessionLog (${rel})`);
  }

  {
    const wrote = appendIfAbsent(
      join(args.hypoDir, 'log.md'),
      payload.log.entry,
      entryAlreadyPresent(payload.log.entry),
    );
    (wrote ? applied : skipped).push('log (log.md)');
  }

  const verification = sessionCloseFileStatus(args.hypoDir);
  const result = { ok: verification.ok, project, date, applied, skipped, verification };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Session-close apply (project: ${project}, date: ${date}):`);
    for (const a of applied) console.log(`  ✓ wrote ${a}`);
    for (const s of skipped) console.log(`  · skipped ${s} (already current)`);
    if (verification.ok) {
      console.log('\n✓ session-close verified — all 5 mandatory files fresh.');
    } else {
      const bad = [
        ...verification.missing.map((f) => `${f} (missing)`),
        ...verification.stale.map((f) => `${f} (stale)`),
      ].join(', ');
      console.log(`\n✗ session-close still incomplete after apply: ${bad}`);
      console.log('  Fix the payload (likely an `updated:` field) and retry.');
    }
  }
  process.exit(verification.ok ? 0 : 1);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function collectPages(dir, root, acc = [], ignorePatterns = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (isIgnored(full, root, ignorePatterns)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collectPages(full, root, acc, ignorePatterns);
    else if (extname(entry) === '.md') {
      acc.push({ path: full, rel: relative(root, full) });
    }
  }
  return acc;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fm[line.slice(0, idx).trim()] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return fm;
}

function parseTags(fm) {
  if (!fm.tags) return [];
  const raw = fm.tags.trim().replace(/^\[|\]$/g, '');
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractWikilinks(content) {
  return [...content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g)].map((m) => m[1].trim());
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.applySessionClose) {
  applySessionClose(args); // exits
}

if (args.checkSessionClose) {
  runSessionCloseCheck(args); // exits
}

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const pagesDir = join(args.hypoDir, 'pages');
const pages = collectPages(pagesDir, args.hypoDir, [], ignorePatterns);

const tagGroups = {}; // tag → [{ slug, title }]
const unlinked = []; // pages with no outbound wikilinks
const drafts = []; // pages tagged draft

for (const { path, rel } of pages) {
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    continue;
  }
  const fm = parseFrontmatter(content);
  if (!fm) continue;

  const slug = rel.replace(/\.md$/, '');
  const title = fm.title || slug;
  const tags = parseTags(fm);

  // tag groups
  for (const tag of tags) {
    if (!tagGroups[tag]) tagGroups[tag] = [];
    tagGroups[tag].push({ slug, title });
  }

  // draft detection
  if (tags.includes('draft') || fm.confidence === 'speculative') {
    drafts.push({ slug, title, confidence: fm.confidence });
  }

  // unlinked (no outbound wikilinks in body)
  const body = content.replace(/^---[\s\S]*?---/, '');
  const links = extractWikilinks(body);
  if (links.length === 0) unlinked.push({ slug, title });
}

// filter tag groups by min-group
const synthesisGroups = Object.entries(tagGroups)
  .filter(([, pages]) => pages.length >= args.minGroup)
  .sort((a, b) => b[1].length - a[1].length)
  .map(([tag, pages]) => ({ tag, pages }));

if (args.json) {
  console.log(JSON.stringify({ synthesisGroups, unlinked, drafts }, null, 2));
  process.exit(0);
}

let found = false;

if (synthesisGroups.length > 0) {
  found = true;
  console.log(`Synthesis candidates by tag (${synthesisGroups.length} group(s)):\n`);
  for (const { tag, pages: grp } of synthesisGroups) {
    console.log(`  [${tag}] (${grp.length} pages):`);
    for (const p of grp) console.log(`    [[${p.slug}]] — ${p.title}`);
  }
  console.log('');
}

if (unlinked.length > 0) {
  found = true;
  console.log(`Unlinked pages (no outbound [[wikilinks]]) — ${unlinked.length}:`);
  for (const p of unlinked) console.log(`  [[${p.slug}]] — ${p.title}`);
  console.log('');
}

if (drafts.length > 0) {
  found = true;
  console.log(`Draft/speculative pages ready to crystallize — ${drafts.length}:`);
  for (const p of drafts) console.log(`  [[${p.slug}]] — ${p.title}`);
  console.log('');
}

if (!found) {
  console.log('✓ No crystallization candidates found — Hypomnema looks well-connected.');
}
