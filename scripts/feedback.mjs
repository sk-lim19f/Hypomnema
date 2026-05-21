#!/usr/bin/env node
/**
 * Hypomnema feedback script
 *
 * Creates or appends to pages/feedback/<topic>.md with a behaviour-correction
 * entry. The wiki feedback page is the single source of truth (ADR 0031 / fix
 * #37); MEMORY.md and CLAUDE.md <learned_behaviors> are one-way *projections*
 * derived from it. Never hand-edit those targets — this script writes the page
 * and then runs `feedback-sync --write` to refresh the projection automatically.
 *
 * Used by /hypo:feedback after Claude drafts the feedback content.
 *
 * Usage:
 *   node scripts/feedback.mjs --topic=<slug> --entry=<text> [classification flags]
 *
 * Page write:
 *   --topic=<slug>          Feedback topic slug (e.g. "response-length")
 *   --entry=<text>          Rule body (one-line rule or short paragraph)
 *   --title=<text>          Frontmatter title (default: topic)
 *
 * Classification (lint #8 schema — required on create):
 *   --scope=<v>             global | project:<slug>           (required)
 *   --tier=<v>              L1 | L2                            (required)
 *   --targets=<list>        comma list of project-memory,claude-learned (default: project-memory)
 *   --sensitivity=<v>       public | sanitized                (default: public)
 *   --priority=<1-5>        projection sort weight             (default: 3)
 *   --memory-summary=<t>    one-line MEMORY.md index summary   (required)
 *   --reason=<t>            why this rule exists               (required)
 *   --source=<t>            provenance (default: session:<today>)
 *   --behavior=<t>          optional: the behaviour being corrected
 *
 * Required only when --targets includes claude-learned:
 *   --global-summary=<t>    one-line CLAUDE.md learned-behaviour summary
 *   --promote-to-global     mark the page for global CLAUDE.md projection
 *
 * Modes:
 *   --hypo-dir=<path>       Hypomnema root (default: HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --claude-home=<path>    Projection target home for the post-step (default: ~/.claude)
 *   --project-id=<id>       Projection MEMORY project-id for the post-step (default: derived from cwd)
 *   --no-sync               Skip the automatic `feedback-sync --write` post-step
 *   --dry-run               Preview without writing (also skips projection)
 *   --list                  List existing feedback topics
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    hypoDir: null,
    topic: null,
    entry: null,
    title: null,
    scope: null,
    tier: null,
    targets: null,
    sensitivity: 'public',
    priority: '3',
    memorySummary: null,
    globalSummary: null,
    promoteToGlobal: false,
    reason: null,
    source: null,
    behavior: null,
    claudeHome: null,
    projectId: null,
    noSync: false,
    dryRun: false,
    list: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--topic=')) args.topic = arg.slice(8);
    else if (arg.startsWith('--entry=')) args.entry = arg.slice(8);
    else if (arg.startsWith('--title=')) args.title = arg.slice(8);
    else if (arg.startsWith('--scope=')) args.scope = arg.slice(8);
    else if (arg.startsWith('--tier=')) args.tier = arg.slice(7);
    else if (arg.startsWith('--targets=')) args.targets = arg.slice(10);
    else if (arg.startsWith('--sensitivity=')) args.sensitivity = arg.slice(14);
    else if (arg.startsWith('--priority=')) args.priority = arg.slice(11);
    else if (arg.startsWith('--memory-summary=')) args.memorySummary = arg.slice(17);
    else if (arg.startsWith('--global-summary=')) args.globalSummary = arg.slice(17);
    else if (arg === '--promote-to-global') args.promoteToGlobal = true;
    else if (arg.startsWith('--reason=')) args.reason = arg.slice(9);
    else if (arg.startsWith('--source=')) args.source = arg.slice(9);
    else if (arg.startsWith('--behavior=')) args.behavior = arg.slice(11);
    else if (arg.startsWith('--claude-home=')) args.claudeHome = expandHome(arg.slice(14));
    else if (arg.startsWith('--project-id=')) args.projectId = arg.slice(13);
    else if (arg === '--no-sync') args.noSync = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--list') args.list = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── list mode ────────────────────────────────────────────────────────────────

function listTopics(hypoDir) {
  const feedbackDir = join(hypoDir, 'pages', 'feedback');
  if (!existsSync(feedbackDir)) {
    console.log('No feedback pages found.');
    return;
  }
  const files = readdirSync(feedbackDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No feedback pages found.');
    return;
  }
  console.log(`Feedback topics (${files.length}):`);
  for (const f of files) console.log(`  ${f.replace(/\.md$/, '')}`);
}

// ── classification validation (mirrors lint #8 / ADR 0031 §6) ──────────────────

const SCOPE_RE = /^(global|project:[a-z0-9][a-z0-9-]*)$/;
const TIER_ENUM = ['L1', 'L2'];
const SENSITIVITY_ENUM = ['public', 'sanitized']; // private is forbidden (wiki is git-public)
const TARGET_ENUM = ['project-memory', 'claude-learned'];

function parseTargets(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

// Validate the create-mode classification. Returns an array of error strings.
function validateClassification(args, targets) {
  const errs = [];
  if (!args.scope) errs.push('--scope is required (global | project:<slug>)');
  else if (!SCOPE_RE.test(args.scope)) errs.push(`--scope invalid: "${args.scope}"`);
  if (!args.tier) errs.push('--tier is required (L1 | L2)');
  else if (!TIER_ENUM.includes(args.tier)) errs.push(`--tier invalid: "${args.tier}"`);
  if (!SENSITIVITY_ENUM.includes(args.sensitivity))
    errs.push(
      `--sensitivity invalid: "${args.sensitivity}" (public | sanitized; private is forbidden)`,
    );
  if (!targets.length) errs.push('--targets is required (project-memory[,claude-learned])');
  for (const t of targets)
    if (!TARGET_ENUM.includes(t)) errs.push(`--targets invalid member: "${t}"`);
  const pri = Number(args.priority);
  if (!Number.isInteger(pri) || pri < 1 || pri > 5)
    errs.push(`--priority must be an integer 1-5 (got "${args.priority}")`);
  if (!args.memorySummary) errs.push('--memory-summary is required');
  if (!args.reason) errs.push('--reason is required');

  // CLAUDE.md projection candidates must be global + L1 (ADR 0031 §6 filter), and
  // carry the two conditional fields (lint #8). Enforce here so we never write a
  // claude-learned page that lint rejects or that silently never projects.
  if (targets.includes('claude-learned')) {
    if (!args.globalSummary)
      errs.push('--global-summary is required when --targets includes claude-learned');
    if (!args.promoteToGlobal)
      errs.push('--promote-to-global is required when --targets includes claude-learned');
    if (args.scope !== 'global')
      errs.push('claude-learned projection requires --scope=global (ADR 0031 §6)');
    if (args.tier !== 'L1') errs.push('claude-learned projection requires --tier=L1 (ADR 0031 §6)');
  }
  return errs;
}

// ── frontmatter rendering ──────────────────────────────────────────────────────

// Frontmatter scalars are written one-per-line as `key: value`. A raw newline in
// a value would inject a forged frontmatter key (e.g. a `reason` containing
// "\nstatus: archived"), silently overriding classification AFTER validation.
// These fields are one-liners by contract, so collapse any whitespace run
// (including newlines / control chars) to a single space and trim.
function oneLine(v) {
  return String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderPage(args, targets, today) {
  const title = oneLine(args.title || args.topic);
  const lines = [
    '---',
    `title: ${title}`,
    'tags: [feedback]',
    'type: feedback',
    'status: active',
    `scope: ${args.scope}`,
    `tier: ${args.tier}`,
    `targets: [${targets.join(', ')}]`,
    `sensitivity: ${args.sensitivity}`,
    `priority: ${Number(args.priority)}`,
    `memory_summary: ${oneLine(args.memorySummary)}`,
  ];
  if (targets.includes('claude-learned')) {
    lines.push(`global_summary: ${oneLine(args.globalSummary)}`);
    lines.push(`promote_to_global: ${args.promoteToGlobal}`);
  }
  lines.push(`reason: ${oneLine(args.reason)}`);
  lines.push(`source: ${oneLine(args.source || `session:${today}`)}`);
  lines.push(`corrected_at: ${today}`);
  lines.push(`updated: ${today}`);
  lines.push(`created: ${today}`);
  if (args.behavior) lines.push(`behavior: ${oneLine(args.behavior)}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('## 규칙');
  lines.push('');
  lines.push(args.entry);
  lines.push('');
  return lines.join('\n');
}

// ── write feedback page ─────────────────────────────────────────────────────────

// Append-mode `updated:` bump: appending a dated entry to an existing page makes
// it the freshest correction, so it should sort first. Rewrite the `updated:`
// line ONLY inside the leading frontmatter block (between the first pair of
// `---` fences). A naive multiline replace would also rewrite any body line that
// happens to start with "updated:" (codex review) — so we scope to the fence.
function bumpUpdated(content, today) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return content; // no frontmatter → nothing to bump
  const fm = m[1];
  const bumped = /^updated:\s*/m.test(fm)
    ? fm.replace(/^(updated:\s*).*$/m, `$1${today}`)
    : `${fm}\nupdated: ${today}`;
  return content.replace(m[0], `---\n${bumped}\n---`);
}

function writeFeedback(args, today) {
  const feedbackDir = join(args.hypoDir, 'pages', 'feedback');
  const filePath = join(feedbackDir, `${args.topic}.md`);
  const targets = parseTargets(args.targets || 'project-memory');

  let content;
  let mode;
  if (existsSync(filePath)) {
    // Append a dated entry; preserve existing frontmatter classification.
    mode = 'append';
    const existing = readFileSync(filePath, 'utf-8');
    const appended = existing.trimEnd() + `\n\n## ${today}\n\n${args.entry}\n`;
    content = bumpUpdated(appended, today);
  } else {
    mode = 'create';
    const errs = validateClassification(args, targets);
    if (errs.length) {
      console.error('Error: feedback classification incomplete:');
      for (const e of errs) console.error(`  - ${e}`);
      process.exit(1);
    }
    content = renderPage(args, targets, today);
  }

  if (args.dryRun) {
    console.log('[DRY RUN — no changes made]\n');
    console.log(`Would ${mode}: ${filePath}\n`);
    console.log(content);
    return { wrote: false };
  }

  if (!existsSync(feedbackDir)) mkdirSync(feedbackDir, { recursive: true });
  writeFileSync(filePath, content);
  console.log(`✓ ${mode === 'create' ? 'Created' : 'Updated'}: ${filePath}`);

  // append to log.md
  const logPath = join(args.hypoDir, 'log.md');
  const logEntry = `\n- ${today} feedback: [[pages/feedback/${args.topic}]] — ${args.entry
    .split('\n')[0]
    .slice(0, 80)}\n`;
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf-8');
    writeFileSync(logPath, log.trimEnd() + logEntry);
    console.log(`↪ Appended to log.md`);
  }
  return { wrote: true };
}

// ── projection post-step (ADR 0031) ────────────────────────────────────────────

// Refresh the MEMORY.md / CLAUDE.md projection from the just-written page. This
// is best-effort and NON-blocking: a projection failure (over-cap, conflict,
// unresolved project-id) must not fail the page write — the SoT is already
// saved. We surface a one-line stderr warning and let the user reconcile.
function runProjection(args) {
  const cli = join(SCRIPT_DIR, 'feedback-sync.mjs');
  if (!existsSync(cli)) return;
  // Forward --claude-home / --project-id when given so the projection targets a
  // caller-controlled location (tests, CI) instead of always defaulting to the
  // real ~/.claude. Omitted → feedback-sync's own defaults (the production path:
  // ~/.claude + project-id derived from cwd).
  const cliArgs = [cli, '--write', '--no-input', `--hypo-dir=${args.hypoDir}`];
  if (args.claudeHome) cliArgs.push(`--claude-home=${args.claudeHome}`);
  if (args.projectId) cliArgs.push(`--project-id=${args.projectId}`);
  const r = spawnSync(process.execPath, cliArgs, { encoding: 'utf-8' });
  if (r.status === 0) {
    console.log('↪ Projection refreshed (MEMORY.md / CLAUDE.md learned-behaviors)');
    return;
  }
  const detail = (r.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`;
  console.error(
    `⚠ feedback-sync --write did not complete cleanly (${detail}). ` +
      `The page is saved; run \`hypomnema feedback-sync --check\` to reconcile the projection.`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if (args.list) {
  listTopics(args.hypoDir);
  process.exit(0);
}

if (!args.topic) {
  console.error('Error: --topic=<slug> is required (or use --list)');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9._-]*$/i.test(args.topic)) {
  console.error('Error: --topic must be a simple slug (letters, digits, hyphen, dot, underscore)');
  process.exit(1);
}

if (!args.entry) {
  console.error('Error: --entry=<text> is required');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const { wrote } = writeFeedback(args, today);

if (wrote && !args.noSync) runProjection(args);
