#!/usr/bin/env node
/**
 * feedback-sync.mjs — project wiki feedback as SoT, external memory as projection
 *
 * Wiki `pages/feedback/<slug>.md` is the single source of truth for
 * learning/correction knowledge. Two Claude Code memory surfaces are derived
 * (one-way) from it:
 *   - Project memory:  <claude-home>/projects/<project-id>/memory/feedback_<slug>.md
 *                      + MEMORY.md index (managed region)
 *   - Global learned:  <claude-home>/CLAUDE.md  <learned_behaviors> managed region
 *
 * --check / --write engine: per-slug managed blocks + sha256 idempotency +
 * conflict (exit 3) + over-cap (exit 2) [Phase A]. --bootstrap / --import-target-
 * change: reverse one-time helpers that scaffold pages/feedback/_drafts/ for human
 * review — never write pages/feedback/<slug>.md directly [Phase D]. --ensure-
 * container: provisions the ONE thing --write can never create on its own — the
 * `<learned_behaviors>` container itself is a precondition for --write, not
 * something it can bootstrap into existence (that would mean guessing WHERE in
 * an arbitrary, possibly hand-authored CLAUDE.md to insert it).
 *
 * A hand-edited block (hash mismatch) normally exits 3. Two ways out:
 *   - automatic: when the block's content equals what the wiki renders now (the
 *     page was edited to match), --write accepts it and rewrites the stored hash.
 *     The comparison is byte for byte, so for the claude target it includes the
 *     `[YYYY-MM-DD]` prefix, which comes from the page's `updated`. A page edited
 *     through /hypo:feedback (append mode) gets `updated` bumped to today, so its
 *     rendering no longer equals an older hand edit and the block stays a conflict
 *     until --accept-wiki=<slug> resolves it. The comparison is not loosened to
 *     ignore the date.
 *   - explicit: `--accept-wiki=<slug>` overwrites that one conflicted block with
 *     the wiki's current rendering, discarding the hand edit, or removes the block
 *     when the wiki projects nothing for that source in that target any more.
 *     Run --import-target-change first to keep a copy of the edit as a draft.
 *     It refuses a block that is not in conflict, and refuses a file whose
 *     markers are malformed or unpaired (block extents are then unreliable).
 *     Otherwise it splices only that block's bytes: no other block, hand line,
 *     side-file or file is touched. `--dry-run` reports the plan and writes nothing.
 *
 * Contract: projects/hypomnema/fix-37-contract.md (per-slug managed block model,
 * sha256 over normalized inner content, sort key, exit matrix, project-id rule).
 *
 * Usage:
 *   node scripts/feedback-sync.mjs [--check|--write|--bootstrap|--import-target-change --from=<memory|claude>|--accept-wiki=<slug>|--ensure-container]
 *     --hypo-dir=<path>      Hypomnema root (default: HYPO_DIR / hypo-config.md / ~/hypomnema)
 *     --claude-home=<path>   Claude Code home (default: ~/.claude)
 *     --project-id=<id>      Override derived project-id (§5; always wins, no prompt)
 *     --no-input             Never prompt; treat unresolved project-id non-interactively
 *     --strict               Promote warnings to failures (PreCompact gate)
 *     --json                 Machine-readable output
 *     --accept-wiki=<slug>   keep the wiki version of one conflicted block (see above)
 *     --dry-run              (bootstrap/import/accept) report the plan, write nothing
 *
 * --ensure-container: the remedy for a 'build-failed' target (its
 * `<learned_behaviors>` container is gone, so NOT ONE L1 rule loads and every
 * --write is a silent no-op — see doctor's "Feedback projection" fail and the
 * PreCompact gate's "feedback projection cannot be built" blocker). If
 * `<claude-home>/CLAUDE.md` EXISTS and has no container, appends a short
 * guidance comment plus an empty `<learned_behaviors></learned_behaviors>`
 * pair to the end of the file — the existing bytes are re-written verbatim ahead
 * of the addition, through an ATOMIC tmp+rename (see atomicWrite), so a crash or
 * a full disk mid-write leaves the user's file exactly as it was. If the
 * container is already there, it is a no-op (idempotent, safe to re-run). If
 * the file does not exist at all, it is ALSO a no-op ('target-missing' is the
 * ordinary first-run state, not something to provision here). If the file
 * carries a CORRUPT container (inverted / duplicated / unpaired tags), it
 * REFUSES and says what is wrong: appending a valid pair on top of a broken one
 * produces a file this tool can never repair (the predicate keeps reading "no
 * container", every re-run appends another pair, --write keeps failing).
 *
 * Project-id fallback (§5 step 4): when the derived project-id directory does not
 * exist AND stdin is an interactive TTY AND --no-input is not set, prompt the user
 * to confirm the derived id, enter a different one, or skip MEMORY projection.
 * Non-interactive runs (hooks, CI, pipes — no TTY) NEVER prompt: they keep the
 * existing behavior (warn + skip MEMORY, exit 0). feedback-sync runs inside the
 * PreCompact hook non-interactively and must never block waiting on input.
 *
 * Exit codes:
 *   0  clean / write succeeded
 *   1  drift detected (--check) OR generic error (usage / wiki not found)
 *   2  over-cap (CLAUDE 10 entries / MEMORY 200 index lines) — human decision required
 *   3  conflict (managed block hash mismatch = manual edit, or a generated side file
 *      edited by hand): no auto-merge
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  realpathSync,
  lstatSync,
  statSync,
  chmodSync,
  renameSync,
} from 'node:fs';
import { join, basename, dirname, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseFrontmatter } from './lib/frontmatter.mjs';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
// scripts/ may import hooks/ (never the reverse): the same lock the vault's other
// append-only writers take, so two feedback-sync runs cannot interleave.
import { withFileLock } from '../hooks/hypo-shared.mjs';

const HOME = homedir();

// ── arg parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: 'check', // check | write | bootstrap | import | accept | ensure-container
    from: null,
    acceptSlug: null,
    hypoDir: null,
    claudeHome: null,
    projectId: null,
    noInput: false,
    skipMemory: false,
    strict: false,
    json: false,
    dryRun: false,
    cwd: process.cwd(),
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--check') args.mode = 'check';
    else if (arg === '--write') args.mode = 'write';
    else if (arg === '--bootstrap') args.mode = 'bootstrap';
    else if (arg === '--import-target-change') args.mode = 'import';
    else if (arg.startsWith('--accept-wiki=')) {
      args.mode = 'accept';
      args.acceptSlug = arg.slice(14);
    } else if (arg === '--accept-wiki') {
      // bare form: run() rejects it. Leaving it unparsed would read as --check.
      args.mode = 'accept';
    } else if (arg === '--ensure-container') args.mode = 'ensure-container';
    else if (arg.startsWith('--from=')) args.from = arg.slice(7);
    else if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--claude-home=')) args.claudeHome = expandHome(arg.slice(14));
    else if (arg.startsWith('--project-id=')) args.projectId = arg.slice(13);
    else if (arg.startsWith('--cwd='))
      args.cwd = expandHome(arg.slice(6)); // test hook
    else if (arg === '--no-input') args.noInput = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--dry-run') args.dryRun = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  if (!args.claudeHome) args.claudeHome = join(HOME, '.claude');
  return args;
}

// ── atomic write (tmp + rename) ──────────────────────────────────────────────
//
// `writeFileSync(file, content)` truncates first and writes second: a crash, a
// full disk, or a kill between the two leaves the file cut in half. Every file
// this tool touches is a file it does NOT own — `~/.claude/CLAUDE.md` is
// hand-authored global config, and --ensure-container advertises "existing
// content is never touched" while doing a whole-file overwrite. So writes go
// through tmp+rename: rename(2) is atomic within a filesystem, so the target
// holds either every old byte or every new byte, never a truncated mix. Same
// shape as hooks/base-store.mjs and hooks/proposal-store.mjs (kept local rather
// than imported: those live behind the hooks/ boundary and this file owns its
// own fs layer).
//
// A SYMLINKED target (a dotfile repo that links ~/.claude/CLAUDE.md into a git
// checkout is a common setup) is resolved with realpathSync FIRST, so the tmp
// file lands beside the REAL file — same directory, therefore same filesystem,
// therefore an atomic rename — and the rename replaces the real file instead of
// clobbering the link itself with a regular file.
function atomicWrite(file, content) {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    // not there yet (a first-write side-file): write it where it was requested
  }
  const dir = dirname(real);
  mkdirSync(dir, { recursive: true });
  // Carry the existing mode across: a bare rename would silently relax a 0600
  // CLAUDE.md to whatever the process umask hands the tmp file.
  let mode = null;
  try {
    mode = statSync(real).mode & 0o777;
  } catch {
    /* new file → default mode */
  }
  const tmp = join(
    dir,
    `.${basename(real)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
  );
  try {
    writeFileSync(tmp, content);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, real);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort: an orphan tmp is inert, the original file is intact either way */
    }
    throw err;
  }
}

// Is `file` a symlink whose target does not exist? existsSync FOLLOWS the link,
// so a dangling one reads as "no file at all" — the ordinary, benign first-run
// state — and a target that is configured but broken would be waved through with
// zero rules loaded. lstat sees the link itself.
function isDanglingSymlink(file) {
  if (existsSync(file)) return false;
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false; // genuinely absent
  }
}

// ── frontmatter helpers ──────────────────────────────────────────────────────

// parseFrontmatter() flattens list values to their raw "[a, b]" string; split
// them back into arrays here (same shape lint.mjs uses for tags).
function parseListField(raw) {
  if (!raw) return [];
  const trimmed = String(raw)
    .trim()
    .replace(/^\[|\]$/g, '');
  return trimmed
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function loadFeedbackPages(hypoDir) {
  const dir = join(hypoDir, 'pages', 'feedback');
  if (!existsSync(dir)) return [];
  const pages = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md') || entry.startsWith('.') || entry.startsWith('_')) continue;
    const path = join(dir, entry);
    const content = readFileSync(path, 'utf-8');
    const fm = parseFrontmatter(content) || {};
    pages.push({
      slug: basename(entry, '.md'),
      fm,
      targets: parseListField(fm.targets),
      content,
      path,
    });
  }
  return pages;
}

// ── managed block primitives (contract §1/§2) ────────────────────────────────

const MARK_START = (slug, hash) =>
  `<!-- HYPO:FEEDBACK-SYNC:START source=${slug} sha256=${hash} -->`;
const MARK_END = '<!-- HYPO:FEEDBACK-SYNC:END -->';
const MARK_ANCHOR = '<!-- HYPO:FEEDBACK-SYNC:ANCHOR -->';
// provenance header stamped on generated full-copy side-files so staleSideFiles
// only ever deletes files this tool wrote (never a user's hand-written memory)
const SIDE_MARKER = (slug) => `<!-- HYPO:FEEDBACK-SYNC source=${slug} -->`;
const SIDE_MARKER_PREFIX = '<!-- HYPO:FEEDBACK-SYNC source=';
const BLOCK_RE =
  /<!-- HYPO:FEEDBACK-SYNC:START source=(\S+) sha256=([0-9a-f]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- HYPO:FEEDBACK-SYNC:END -->/g;
// line-anchored so marker-looking text inside prose/code does not false-count
const START_RE = /^[ \t]*<!-- HYPO:FEEDBACK-SYNC:START\b/gm;
const END_RE = /^[ \t]*<!-- HYPO:FEEDBACK-SYNC:END -->[ \t]*$/gm;

// Count raw START/END markers; if they outnumber fully-matched blocks, a marker
// is malformed/unpaired (truncated, tampered hash, stray) → refuse (conflict).
function countMarkers(content) {
  return {
    starts: (content.match(START_RE) || []).length,
    ends: (content.match(END_RE) || []).length,
  };
}

// sha256 over the normalized inner content (contract §2): inner lines joined by
// \n, leading/trailing blank lines stripped, no trailing newline.
function normalizeInner(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.join('\n');
}

function hashInner(text) {
  return createHash('sha256').update(normalizeInner(text), 'utf-8').digest('hex');
}

function renderBlock(slug, inner) {
  const norm = normalizeInner(inner);
  return `${MARK_START(slug, hashInner(norm))}\n${norm}\n${MARK_END}`;
}

// A block is in conflict when its content no longer matches its stored hash AND
// differs from what the wiki renders now. A block that was hand-edited and then
// matched by a wiki edit has a stale marker only: nothing is lost by rewriting it.
function isBlockConflict(b, desired) {
  if (b.actualHash === b.declaredHash) return false;
  const d = desired.find((x) => x.slug === b.slug);
  return !d || d.hash !== b.actualHash;
}

// Find existing managed blocks with their positions. Returns
// { blocks: [{slug, declaredHash, inner, actualHash, start, end}], firstStart, lastEnd }.
function findBlocks(content) {
  const blocks = [];
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(content)) !== null) {
    blocks.push({
      slug: m[1],
      declaredHash: m[2],
      inner: m[3],
      actualHash: hashInner(m[3]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  const firstStart = blocks.length ? blocks[0].start : -1;
  const lastEnd = blocks.length ? blocks[blocks.length - 1].end : -1;
  return { blocks, firstStart, lastEnd };
}

// Detect hand-added lines *between* managed blocks. Contract §1 requires manual
// entries to live outside the contiguous managed span; lines inside it would be
// silently dropped on rewrite, so we refuse (treated as conflict, exit 3).
function regionHasIntruders(content) {
  const { blocks, firstStart, lastEnd } = findBlocks(content);
  if (blocks.length < 1) return false;
  const span = content.slice(firstStart, lastEnd).replace(BLOCK_RE, '');
  return span.trim().length > 0;
}

// ── projection targets (descriptor abstraction) ──────────────────────────────

const PUBLIC_SENSITIVITY = new Set(['public', 'sanitized']);

function memoryTarget(args, projectId) {
  const root = join(args.claudeHome, 'projects', projectId, 'memory');
  return {
    name: 'memory',
    file: join(root, 'MEMORY.md'),
    dir: root,
    cap: 200,
    capKind: 'lines',
    filter: (p) =>
      p.fm.status === 'active' &&
      (p.fm.scope === 'global' || p.fm.scope === `project:${projectId}`) &&
      p.targets.includes('project-memory') &&
      PUBLIC_SENSITIVITY.has(p.fm.sensitivity),
    // Colon separator, not a dash: a model that reads this index copies the line's
    // shape when it adds an entry by hand, and a dash separator also collides with
    // dashes inside a summary. parseMemoryIndex still reads the legacy dash form.
    render: (p) => {
      const summary = p.fm.memory_summary || '';
      return `- [${p.fm.title || p.slug}](feedback_${p.slug}.md)${summary ? `: ${summary}` : ''}`;
    },
    // full-copy individual files owned entirely by sync (contract §7); the
    // provenance header marks them as tool-generated for safe staleness removal
    sideFiles: (p) => [
      {
        path: join(root, `feedback_${p.slug}.md`),
        content: `${SIDE_MARKER(p.slug)}\n${p.content}`,
      },
    ],
  };
}

function claudeTarget(args) {
  return {
    name: 'claude',
    file: join(args.claudeHome, 'CLAUDE.md'),
    cap: 10,
    capKind: 'entries',
    container: 'learned_behaviors', // managed region must live inside <learned_behaviors>
    filter: (p) =>
      p.fm.status === 'active' &&
      p.fm.scope === 'global' && // scope:project:* auto-rejected (contract §6)
      p.fm.tier === 'L1' &&
      p.targets.includes('claude-learned') &&
      String(p.fm.promote_to_global) === 'true' &&
      PUBLIC_SENSITIVITY.has(p.fm.sensitivity),
    render: (p) => {
      const date = (p.fm.updated || p.fm.date || '').slice(0, 10);
      const datePart = date ? `[${date}] ` : '';
      // Period before 근거 instead of the legacy dash; no doubled period when the
      // summary already ends in terminal punctuation.
      const summary = (p.fm.global_summary || '').trim();
      const sep = !summary ? '' : /[.!?]$/.test(summary) ? ' ' : '. ';
      return `- ${datePart}${summary}${sep}근거: [[${p.slug}]]`;
    },
    sideFiles: () => [],
  };
}

// ── sort key (contract §3): (priority desc, date desc, slug asc) ──────────────

function sortKey(a, b) {
  const pa = Number(a.fm.priority) || 3;
  const pb = Number(b.fm.priority) || 3;
  if (pa !== pb) return pb - pa;
  const da = (a.fm.updated || a.fm.date || '1970-01-01').slice(0, 10);
  const db = (b.fm.updated || b.fm.date || '1970-01-01').slice(0, 10);
  if (da !== db) return da < db ? 1 : -1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

// Build the desired ordered block list for a target.
function computeDesired(pages, target) {
  return pages
    .filter(target.filter)
    .sort(sortKey)
    .map((p) => {
      const inner = target.render(p);
      return { slug: p.slug, inner: normalizeInner(inner), hash: hashInner(inner), page: p };
    });
}

// ── region insertion (contract §1) ───────────────────────────────────────────

function buildRegion(desired) {
  return desired.map((d) => renderBlock(d.slug, d.inner)).join('\n');
}

// ── the <learned_behaviors> container: ONE judgment, one view ────────────────

const LB_OPEN = '<learned_behaviors>';
const LB_CLOSE = '</learned_behaviors>';

// Replace every character of `match` with a space, newlines excepted.
function blank(match) {
  return match.replace(/[^\n]/g, ' ');
}

// Mask the spans a markdown reader does NOT read as live text — HTML comments,
// fenced code blocks, inline code spans — so a tag inside one of them cannot be
// mistaken for the container. Masked characters become spaces and newlines are
// kept, so the masked view has EXACTLY the same length and line structure as the
// input: an index found here is a valid index into the original content, which
// is what lets placement splice on it.
//
// Why this exists: a plain indexOf() said "container present" for
// `<!-- <learned_behaviors></learned_behaviors> -->` and for a pair inside a code
// fence. --ensure-container then no-op'd while placement wrote the managed region
// INSIDE the comment/fence, where it is inert — and the hook read that as ordinary
// drift and kept rewriting it. Inline code matters just as much: a CLAUDE.md that
// merely MENTIONS `<learned_behaviors>` in prose (this repo's own does) would
// otherwise read as an unpaired open tag.
function maskInertSpans(content) {
  const lines = content.replace(/<!--[\s\S]*?-->/g, blank).split('\n');
  let fence = null;
  return lines
    .map((line) => {
      const delim = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (delim && delim[1][0] === fence.char && delim[1].length >= fence.len) fence = null;
        return blank(line); // every line inside the fence, close delimiter included
      }
      if (delim) {
        fence = { char: delim[1][0], len: delim[1].length };
        return blank(line);
      }
      return line.replace(/`[^`\n]*`/g, blank);
    })
    .join('\n');
}

function indicesOf(text, needle) {
  const out = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    out.push(i);
  }
  return out;
}

/**
 * The ONE definition of "the container is there", over the masked view above:
 *
 *   { state: 'present', open, close }  exactly one pair, open BEFORE close
 *   { state: 'absent',  ... }          no tag at all → --ensure-container provisions it
 *   { state: 'corrupt', reason, ... }  inverted / duplicated / unpaired tags
 *
 * 'corrupt' is its own state because the alternative — folding it into "absent" —
 * built a trap: with `</learned_behaviors>` sitting before `<learned_behaviors>`,
 * a first-occurrence predicate reads false forever, so --ensure-container appends
 * a fresh pair, the inverted tags stay, the predicate STILL reads false, and every
 * --write keeps failing. The tool manufactured a state it could not repair. A
 * corrupt container is damage a human fixes; the tool says so and stops.
 *
 * buildNextContent's placement, --ensure-container's idempotency check and
 * evaluateTarget's out-of-container check all call this, so they cannot drift
 * apart on what counts as a container — and they are wrong together or right
 * together, never half of each.
 */
function classifyContainer(content) {
  const view = maskInertSpans(content);
  const opens = indicesOf(view, LB_OPEN);
  const closes = indicesOf(view, LB_CLOSE);
  if (!opens.length && !closes.length) return { state: 'absent', open: -1, close: -1 };
  if (opens.length === 1 && closes.length === 1 && opens[0] < closes[0]) {
    return { state: 'present', open: opens[0], close: closes[0] };
  }
  let reason;
  if (!opens.length) reason = `a closing ${LB_CLOSE} with no opening ${LB_OPEN}`;
  else if (!closes.length) reason = `an opening ${LB_OPEN} with no closing ${LB_CLOSE}`;
  else if (opens.length > 1 || closes.length > 1)
    reason = `${opens.length} opening and ${closes.length} closing tags (exactly one pair is required)`;
  else reason = `the closing ${LB_CLOSE} appears BEFORE the opening ${LB_OPEN}`;
  return {
    state: 'corrupt',
    reason,
    open: opens.length ? opens[0] : -1,
    close: closes.length ? closes[0] : -1,
  };
}

// ── remedies (one way out per CAUSE) ─────────────────────────────────────────
//
// A blocker that names a command which cannot possibly fix the condition it
// reports teaches the reader to ignore blockers. `--ensure-container` only ever
// touches CLAUDE.md's container: it cannot chmod an unreadable file, cannot
// repoint a dangling symlink, and must not append onto a corrupt container. The
// remedy is decided ONCE, here, next to the branch that detects the cause, and
// rides along in the JSON report (`buildErrorRemedy`) so doctor and the PreCompact
// gate print the same way out instead of each guessing one.
// A slug safe to paste unquoted into a suggested shell command: the same class
// safeDraftSlug keeps, tested whole instead of cleaned.
const SAFE_SLUG_RE = /^[\p{L}\p{N}._-]+$/u;

const REMEDY = {
  containerMissing: (file) =>
    'Run `hypomnema feedback-sync --ensure-container` to add the missing ' +
    `<learned_behaviors></learned_behaviors> pair to ${file} (existing content is untouched), ` +
    'then `hypomnema feedback-sync --write`.',
  containerCorrupt: (file, reason) =>
    `Repair ${file} BY HAND so it holds exactly one <learned_behaviors></learned_behaviors> pair ` +
    `with the opening tag first — found ${reason}. \`--ensure-container\` refuses to append here: ` +
    'a second pair stacked on a broken one leaves the file unprojectable forever.',
  io: (file) =>
    `Fix the permissions on ${file} so this user can read and write it (e.g. \`chmod u+rw\`), then ` +
    're-run `hypomnema feedback-sync --write`. `--ensure-container` cannot fix a permission bit.',
  danglingSymlink: (file) =>
    `${file} is a symlink whose target does not exist (\`ls -l\` it). Repoint or remove the link, ` +
    'then re-run `hypomnema feedback-sync --write`.',
  // One text for every consumer of a conflicted target (CLI, doctor, PreCompact
  // gate), chosen by the SHAPE of the problem, because the import-then-accept way
  // out only exists when a block is in conflict: for a target whose only trouble
  // is hand-written lines in the managed region, or a block outside the container,
  // import finds nothing ('nothing to import', exit 0) and accept refuses.
  //   conflicting block(s)  import to keep a copy, then accept per block. The accept
  //                         part is left out for an unpaired file (it refuses until
  //                         the markers are repaired) and for a slug that is not a
  //                         plain name (it would be pasted into a shell unquoted).
  //   unpaired markers      repair by hand.
  //   block outside container / intruder lines   move them, then --write.
  // The shapes can be present together, and accept clears none of the structural ones,
  // so a conflict that is also an intruder / out-of-container target gets that step
  // appended to the import-and-accept text instead of being treated as conflict only.
  conflict: (name, { conflicts, unpaired, outOfContainer, intruder, sideEdited = [] }) => {
    const repair =
      'Repair the malformed HYPO:FEEDBACK-SYNC markers by hand (every block needs one START and one END marker).';
    const moveBlocks =
      'Move the HYPO:FEEDBACK-SYNC block(s) back inside <learned_behaviors>, or delete them and let `--write` project them again.';
    const moveLines =
      'Move the hand-written lines outside the HYPO blocks (before the first block or after the last; in CLAUDE.md keep them inside <learned_behaviors>).';
    // steps that only moving or repairing text can do, whatever else is wrong
    const editedSide = `Copy your edits out of ${sideEdited.join(', ')}, then delete the file so \`--write\` generates it again.`;
    const structural = [
      ...(outOfContainer ? [moveBlocks] : []),
      ...(intruder ? [moveLines] : []),
      ...(sideEdited.length ? [editedSide] : []),
    ];
    if (!conflicts.length) {
      const steps = [...(unpaired ? [repair] : []), ...structural];
      return (
        `${steps.join(' ')} Then run \`hypomnema feedback-sync --write\`.` +
        (unpaired || sideEdited.length
          ? ''
          : ' `--import-target-change` has nothing to import here.')
      );
    }
    const accepts = unpaired ? [] : conflicts.filter((c) => SAFE_SLUG_RE.test(c));
    return (
      `Run \`hypomnema feedback-sync --import-target-change --from=${name}\` to keep a copy of the hand edit as a draft.` +
      (unpaired
        ? ' To keep the wiki version instead, repair the malformed markers by hand first, then re-run the check.'
        : '') +
      (accepts.length
        ? ' To discard the edit and keep the wiki version instead, run that import first, then ' +
          accepts.map((c) => `\`hypomnema feedback-sync --accept-wiki=${c}\``).join(', ') +
          ' (one command per conflicted block).'
        : '') +
      // accept rewrites one block and cannot clear these, so the target stays blocked
      // (exit 3) after the accept unless the reader is told to do this part too
      (structural.length
        ? ` This target is also malformed in another way that import and accept do not touch, so do this as well: ${structural.join(' ')} Then run \`hypomnema feedback-sync --check\`.`
        : '')
    );
  },
};

// Sentence for a hand line --write left in place.
function handKeptNotice(r) {
  return (
    `kept the hand-written line in ${r.file} that bootstrap drafted "${r.slug}" from: ` +
    "it was changed, moved to another section, duplicated, or links more than the managed entry's one file, so it was not removed. " +
    `Delete it by hand if it now duplicates the managed entry. The line as bootstrap saw it: ${r.line}`
  );
}

// Compute the next file content for a target. Returns { content } on success or
// { error, remedy } when the region cannot be placed (missing / corrupt
// container). Pure — no disk writes — so run() can preflight every target before
// any write (atomicity).
function buildNextContent(content, region, target) {
  const { firstStart, lastEnd } = findBlocks(content);
  // replace the contiguous managed span (region may be '' to clear it)
  const replaceSpan = () => ({
    content: content.slice(0, firstStart) + region + content.slice(lastEnd),
  });
  if (target.container === 'learned_behaviors') {
    const c = classifyContainer(content);
    // Checked BEFORE the existing-blocks fast path: rewriting a managed span
    // inside a file whose container tags are broken just re-lands the region in a
    // structure nothing reads.
    if (c.state === 'corrupt') {
      return {
        error: `<learned_behaviors> container in ${target.file} is corrupt: ${c.reason}`,
        remedy: REMEDY.containerCorrupt(target.file, c.reason),
      };
    }
    if (firstStart >= 0) return replaceSpan();
    if (region === '') return { content }; // nothing to place → no-op (idempotent)
    if (c.state === 'absent') {
      return {
        error: `<learned_behaviors></learned_behaviors> container not found in ${target.file}`,
        remedy: REMEDY.containerMissing(target.file),
      };
    }
    // an anchor is honored ONLY when it sits inside the container span
    const anchorIdx = content.indexOf(MARK_ANCHOR);
    if (anchorIdx > c.open && anchorIdx < c.close) {
      return {
        content:
          content.slice(0, anchorIdx) + region + content.slice(anchorIdx + MARK_ANCHOR.length),
      };
    }
    return { content: content.slice(0, c.close) + region + '\n' + content.slice(c.close) };
  }
  if (firstStart >= 0) return replaceSpan();
  if (region === '') return { content };
  // memory index: anchor (anywhere) or append
  const anchorIdx = content.indexOf(MARK_ANCHOR);
  if (anchorIdx >= 0) {
    return {
      content: content.slice(0, anchorIdx) + region + content.slice(anchorIdx + MARK_ANCHOR.length),
    };
  }
  const sep = content.endsWith('\n') ? '' : '\n';
  return { content: content + sep + region + '\n' };
}

// sync-owned full-copy files (feedback_<slug>.md) no longer backed by an active
// candidate → must be removed so deletions/demotions propagate (MEDIUM-1).
// readdirSync MAY THROW (e.g. EACCES on target.dir) — deliberately NOT caught
// here. The caller (evaluateTarget) catches it and classifies it exactly like a
// primary-target read failure ('build-failed'), so a directory permission
// problem cannot silently masquerade as "no stale side-files to clean up".
function staleSideFiles(target, desired) {
  if (!target.dir || !existsSync(target.dir)) return [];
  const keep = new Set(desired.map((d) => `feedback_${d.slug}.md`));
  return readdirSync(target.dir)
    .filter((f) => /^feedback_.+\.md$/.test(f) && !keep.has(f))
    .map((f) => join(target.dir, f))
    .filter((p) => {
      // only delete files THIS tool generated (provenance header on line 1) —
      // never a user's hand-written feedback_*.md memory file. Unreadable here
      // just means "don't delete it" (a safe, non-destructive default) — this
      // per-file check was already caught before this fix and stays that way;
      // it is the DIRECTORY listing and the PRIMARY target read that used to
      // throw uncaught, not this narrow provenance probe.
      try {
        return readFileSync(p, 'utf-8').startsWith(SIDE_MARKER_PREFIX);
      } catch {
        return false;
      }
    });
}

// ── hand lines that --bootstrap drafted from ────────────────────────────────
//
// --bootstrap leaves the original hand-written index line where it is. Once the
// draft is promoted, --write adds a managed entry for the same slug and the hand
// line would sit beside it as a duplicate (or, between two managed blocks, as an
// intruder that blocks every write). So bootstrap records the exact bytes of each
// line it drafted from, and the --write that adds that slug's managed entry
// removes exactly that line in the same atomic write.
//
// The record lives in the vault under .cache/ (gitignored by the vault template),
// not under ~/.claude. A line is removed only when it is still there byte for
// byte, outside every managed block, exactly once, under the heading it was recorded
// under, and (memory lines) carrying no link but the managed entry's. Anything else
// (edited, moved, duplicated, repurposed) is left alone and reported. Lines bootstrap
// never recorded are never touched. A line that is removed is first copied to
// .cache/feedback-kept/ (keepCopy), the same place --accept-wiki keeps the file it
// replaces.
//
// The "kept" notice is delivered once and best-effort: the --write that kept a line
// reports it (stderr, the JSON report, the PreCompact heal notice) and drops the
// record in the same run, so a missed notice is never repeated. The failure
// direction is a visible duplicate line beside the managed entry, never a deletion.
//
// Two more conditions keep a deletion from orphaning or hitting the wrong thing:
//   - memory lines: the line's link must name the file the managed entry links,
//     feedback_<slug>.md. Bootstrap turns '_' into '-' when it makes the slug, so a
//     hand line for feedback_no_mocks.md becomes slug no-mocks and its managed entry
//     links feedback_no-mocks.md, a different file. Deleting that hand line would
//     drop the only index pointer to the user's own feedback_no_mocks.md.
//   - a record is consumed only when the projected page carries bootstrap_origin,
//     the key a promoted bootstrap draft keeps. A rejected draft's leftover record
//     must not delete a hand line when an unrelated page later reuses its slug.
const HAND_LINES_FILE = (hypoDir) => join(hypoDir, '.cache', 'feedback-bootstrap-lines.json');

// Entries are { slug, target: 'memory' | 'claude', file, line, section }. `section` is the
// nearest heading above the line ('' when there is none): the line's recorded place. An
// entry without one (written before places were recorded) loads with section null, which
// matches no place, so its line is kept and reported rather than removed. A missing or
// unreadable record means "nothing recorded": the safe direction (no deletion).
function loadHandLines(hypoDir) {
  try {
    const j = JSON.parse(readFileSync(HAND_LINES_FILE(hypoDir), 'utf-8'));
    return (Array.isArray(j.lines) ? j.lines : [])
      .filter(
        (r) =>
          r && ['slug', 'target', 'file', 'line'].every((k) => typeof r[k] === 'string' && r[k]),
      )
      .map((r) => ({ ...r, section: typeof r.section === 'string' ? r.section : null }));
  } catch {
    return [];
  }
}

function saveHandLines(hypoDir, lines) {
  const file = HAND_LINES_FILE(hypoDir);
  if (!lines.length) rmSync(file, { force: true });
  else {
    assertCacheIgnored(hypoDir, file);
    atomicWrite(file, JSON.stringify({ version: 1, lines }, null, 2) + '\n');
  }
}

// Which of `relPaths` (vault-relative, forward slashes) the vault's git would NOT ignore.
// Anything written under .cache/ here holds the user's own MEMORY.md or CLAUDE.md text,
// and the vault's auto-commit stages whatever git does not ignore. The default
// .gitignore ignores .cache/, but a hand-written one may not.
//   not a git work tree (or no git at all): nothing can stage it, so nothing is unignored.
//   git answers anything but 0 or 1, or times out: unknown, counted as unignored.
function unignoredCachePaths(hypoDir, relPaths) {
  if (!relPaths.length) return [];
  const git = (argv, input) =>
    spawnSync('git', ['-C', hypoDir, ...argv], { input, encoding: 'utf-8', timeout: 10000 });
  const probe = git(['rev-parse', '--is-inside-work-tree']);
  if (probe.error?.code === 'ENOENT') return [];
  if (probe.status === 128 || (probe.status === 0 && probe.stdout.trim() !== 'true')) return [];
  const r = git(['check-ignore', '--stdin', '-z'], relPaths.join('\0') + '\0');
  if (r.error || (r.status !== 0 && r.status !== 1)) return [...relPaths];
  const ignored = new Set(r.stdout.split('\0').filter(Boolean));
  return relPaths.filter((p) => !ignored.has(p));
}

// Throws when `file` (under the vault's .cache/) is a path the vault's git would not ignore.
function assertCacheIgnored(hypoDir, file) {
  const rel = relative(hypoDir, file).split(sep).join('/');
  if (unignoredCachePaths(hypoDir, [rel]).length)
    throw Object.assign(
      new Error(
        `${rel} is not ignored by the vault's git, so a copy of your own file there would be staged by the auto-commit. Add .cache/ to the vault's .gitignore first`,
      ),
      { code: 'EUNIGNORED' },
    );
}

// The nearest markdown heading at or above the end of `text` ('' when there is none).
const headingLine = (text) => (/^#{1,6}\s/.test(text) ? text.trimEnd() : null);
function sectionAt(text) {
  let section = '';
  for (const l of text.split('\n')) section = headingLine(l) ?? section;
  return section;
}

// Where this tool keeps a copy of what it is about to remove or overwrite: the hand
// lines a --write drops, the whole target file an --accept-wiki replaces. One place and
// one naming rule (<UTC time>-<label>[-n].txt, never overwriting an earlier copy), so a
// loss can be undone by hand. Inside the vault's .cache/ (gitignored by the vault
// template), next to the hand-line record. Throws when the copy cannot be written, or
// when the vault's git would not ignore it (the copy holds the user's own text and the
// auto-commit would stage it): callers must not go on to the destructive write then.
//
// Only the newest KEPT_PER_LABEL copies of one label stay, but the older ones go in
// pruneKept, after a whole run has succeeded (see run()): a run that fails before its
// write must not have already deleted the one copy that could undo an earlier write.
const KEPT_DIR = (hypoDir) => join(hypoDir, '.cache', 'feedback-kept');
const KEPT_PER_LABEL = 10;
const keptLabels = new Set(); // the labels keepCopy wrote under during the current run
const keptLabelOf = (label) => label.replace(/[^\p{L}\p{N}._-]+/gu, '-');
function keepCopy(hypoDir, label, text) {
  const dir = KEPT_DIR(hypoDir);
  const safeLabel = keptLabelOf(label);
  const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeLabel}`;
  let file = join(dir, `${base}.txt`);
  for (let n = 2; existsSync(file); n++) file = join(dir, `${base}-${n}.txt`);
  assertCacheIgnored(hypoDir, file);
  atomicWrite(file, text);
  keptLabels.add(safeLabel);
  return file;
}

// Deletes all but the newest KEPT_PER_LABEL copies of each label this run wrote. A
// failure to delete is returned as warning text and never changes the run's result.
function pruneKept(hypoDir, labels) {
  const dir = KEPT_DIR(hypoDir);
  const warns = [];
  for (const safeLabel of labels) {
    try {
      const own = new RegExp(
        `^(\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z)-${safeLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?\\.txt$`,
      );
      const mine = readdirSync(dir)
        .map((f) => ({ f, m: own.exec(f) }))
        .filter((x) => x.m)
        .sort((a, b) =>
          a.m[1] === b.m[1] ? (a.m[2] || 1) - (b.m[2] || 1) : a.m[1] < b.m[1] ? -1 : 1,
        );
      for (const { f } of mine.slice(0, Math.max(0, mine.length - KEPT_PER_LABEL)))
        rmSync(join(dir, f), { force: true });
    } catch (err) {
      warns.push(`could not remove old copies in ${dir}: ${err.message}`);
    }
  }
  return warns;
}

// Split `recs` (records for one target file whose slug the wiki now projects)
// into removed / kept / stale and return the content without the removed lines.
//   stale   the slug already has a managed block in the file: an earlier write
//           placed it, only the record cleanup was lost. Nothing to remove.
//   kept    the line is not there exactly once outside the managed blocks, it is not under
//           the heading it was recorded under, or (memory lines) its links are not
//           exactly one link to the file the managed entry will link.
function stripHandLines(content, recs) {
  const { blocks } = findBlocks(content);
  const have = new Set(blocks.map((b) => b.slug));
  const lines = content.split('\n');
  const outside = [];
  let off = 0;
  let section = '';
  lines.forEach((text, i) => {
    section = headingLine(text) ?? section;
    if (!blocks.some((b) => off >= b.start && off < b.end)) outside.push({ i, section });
    off += text.length + 1;
  });
  const drop = new Set();
  const out = { removed: [], kept: [], stale: [] };
  for (const r of recs) {
    if (have.has(r.slug)) {
      out.stale.push(r);
      continue;
    }
    // Deleting a line with a second link orphans that file's only index entry, and
    // deleting the wrong file's link orphans the user's own memory file.
    const links = r.line.match(/\]\([^)]*\)/g) || [];
    if (r.target === 'memory' && (links.length !== 1 || links[0] !== `](feedback_${r.slug}.md)`)) {
      out.kept.push(r);
      continue;
    }
    // exactly once, and still where it was recorded: a line moved under another heading
    // is the user's line now
    const hits = outside.filter((h) => lines[h.i] === r.line);
    if (hits.length === 1 && hits[0].section === r.section) {
      drop.add(hits[0].i);
      out.removed.push(r);
    } else out.kept.push(r);
  }
  return { ...out, content: lines.filter((_, i) => !drop.has(i)).join('\n') };
}

// ── side files the user changed after this tool generated them ───────────────
//
// A feedback_<slug>.md that still carries the provenance header may hold new work: the
// header only says who created the file, not that nobody has touched it since. So the
// hash of the last version this tool wrote is kept per path in the vault's .cache/, and
// a rewrite or a removal only goes ahead when the file on disk still has that hash.
// A file with no recorded hash (written before this record existed, or the record is
// gone) is trusted once and recorded by the write that replaces it.
// ponytail: that one trusted rewrite can still lose an edit made before the upgrade.
const SIDE_HASHES_FILE = (hypoDir) => join(hypoDir, '.cache', 'feedback-side-files.json');
const sha256 = (text) => createHash('sha256').update(text, 'utf-8').digest('hex');

// { <absolute path>: <sha256 of the last generated bytes> }. A missing or unreadable
// record means "nothing recorded", which trusts every marked file once (see above).
function loadSideHashes(hypoDir) {
  try {
    const j = JSON.parse(readFileSync(SIDE_HASHES_FILE(hypoDir), 'utf-8'));
    return Object.fromEntries(
      Object.entries(j.files || {}).filter(([, h]) => /^[0-9a-f]{64}$/.test(String(h))),
    );
  } catch {
    return {};
  }
}

function saveSideHashes(hypoDir, hashes) {
  const file = SIDE_HASHES_FILE(hypoDir);
  if (!Object.keys(hashes).length) rmSync(file, { force: true });
  else atomicWrite(file, JSON.stringify({ version: 1, files: hashes }, null, 2) + '\n');
}

// ── per-target evaluation (preflight: validates + computes the write plan) ─────

function evaluateTarget(pages, target, handRecs = [], sideHashes = {}) {
  const desired = computeDesired(pages, target);
  const fileExists = existsSync(target.file);
  const dangling = isDanglingSymlink(target.file);
  // The FILE existing does not mean it is READABLE. A permission error here
  // (mode 000, an ACL change mid-session, ...) used to throw uncaught: the
  // whole --check/--write run crashed, no JSON report was produced, and every
  // downstream consumer (doctor's "no JSON" branch, the PreCompact gate's
  // unparseable-stdout branch) reads "no report" as "nothing to project" and
  // fails OPEN — reproducing, via an ordinary filesystem error, the exact
  // failure mode ("rules not loaded, gate stays green") this whole projection
  // system exists to prevent. Caught and classified as 'build-failed' instead.
  let original = '';
  let ioError = null;
  if (fileExists) {
    try {
      original = readFileSync(target.file, 'utf-8');
    } catch (err) {
      ioError = `cannot read target file ${target.file}: ${err.message}`;
    }
  }
  // Hand lines bootstrap drafted from, for slugs the wiki now projects here, are
  // judged on the content WITHOUT them: a recorded line between two blocks is no
  // intruder once this write removes it. `original` stays the on-disk bytes
  // (dirty check, applyTarget, runAccept); `content` is the plan's input.
  const mine = ioError
    ? []
    : handRecs.filter(
        (r) =>
          r.target === target.name &&
          r.file === target.file &&
          desired.some((d) => d.slug === r.slug && d.page.fm.bootstrap_origin),
      );
  const hand = stripHandLines(original, mine);
  const content = hand.content;
  const { blocks } = findBlocks(content);
  const { starts, ends } = countMarkers(content);

  // conflict: on-disk block whose inner content no longer matches its marker and
  // differs from the wiki rendering (equal-to-wiki is accepted: the region rebuild
  // below rewrites its marker hash, which --check reports as drift, --write fixes)
  const conflicts = blocks.filter((b) => isBlockConflict(b, desired)).map((b) => b.slug);
  // unpaired: a raw START/END marker that BLOCK_RE could not pair (malformed/tampered)
  const unpaired = starts !== blocks.length || ends !== blocks.length;
  // intruder: hand-added lines inside the managed span (would be dropped on rewrite)
  const intruder = regionHasIntruders(content);
  // out-of-container: an existing managed block sitting outside <learned_behaviors>
  // (drifted/hand-moved) — replacing it in place would leave it outside the
  // required region, so refuse and require import. A CORRUPT container is
  // deliberately NOT reported here: it is a build failure with its own remedy
  // (repair by hand), and routing it through the conflict path would print
  // "run --import-target-change", which reconciles nothing.
  let outOfContainer = false;
  const container = target.container === 'learned_behaviors' ? classifyContainer(content) : null;
  if (container && container.state !== 'corrupt' && blocks.length) {
    outOfContainer =
      container.state !== 'present' ||
      blocks.some((b) => b.start < container.open || b.end > container.close);
  }

  const region = buildRegion(desired);
  let overCap = false;
  if (target.capKind === 'entries') overCap = desired.length > target.cap;
  // count index content lines only — the START/END marker wrappers are sync
  // bookkeeping, not part of the "200 index lines" budget.
  else if (target.capKind === 'lines')
    overCap = desired.reduce((n, d) => n + d.inner.split('\n').length, 0) > target.cap;

  // build the next content (validation happens here, before any write)
  //
  // buildErrorKind splits the two very different reasons a build fails, because
  // consumers must treat them differently and the string alone does not say which
  // is which:
  //
  //   'target-missing'   The target FILE is not there at all (no ~/.claude/
  //                      CLAUDE.md yet). That is the ordinary first-run state, so
  //                      the PreCompact gate and doctor must NOT block on it — a
  //                      block here would hit every new user (same reasoning that
  //                      keeps this out of strictWarnings below).
  //   'build-failed'     The file EXISTS but cannot be projected into — e.g. its
  //                      <learned_behaviors> container is gone. Nothing is broken
  //                      about the user's setup EXCEPT that not one L1 rule loads
  //                      on this machine, and every sync is a silent no-op. That
  //                      is a hard failure and must be surfaced as one.
  let nextContent = null;
  let buildError = null;
  let buildErrorKind = null;
  let buildErrorRemedy = null;
  if (ioError) {
    // The target file exists but could not be read (permissions, a mid-session
    // ACL change, ...). Structurally identical to a missing container: nothing
    // is projected, and the difference from a fresh install matters, so this
    // gets the SAME 'build-failed' kind as a missing container, not
    // 'target-missing' (the file is right there, just unreadable).
    buildError = ioError;
    buildErrorKind = 'build-failed';
    buildErrorRemedy = REMEDY.io(target.file);
  } else if (dangling) {
    // A dangling symlink is NOT 'target-missing'. existsSync follows the link and
    // sees nothing, so this used to be classified as the benign first-run state:
    // the gate stayed green while the configured target was broken and zero rules
    // loaded — and a --write would have replaced the link with a regular file,
    // silently detaching it from whatever it was meant to point at.
    buildError = `target file ${target.file} is a dangling symlink (its link target does not exist)`;
    buildErrorKind = 'build-failed';
    buildErrorRemedy = REMEDY.danglingSymlink(target.file);
  } else if (!fileExists && target.container) {
    buildError = `target file missing: ${target.file}`;
    buildErrorKind = 'target-missing';
  } else {
    const r = buildNextContent(fileExists ? content : '', region, target);
    if (r.error) {
      buildError = r.error;
      buildErrorKind = 'build-failed';
      buildErrorRemedy = r.remedy;
    } else nextContent = r.content;
  }

  // side-files: writes (current candidates) + deletes (stale sync-owned copies).
  // An I/O error on a SIDE file (the directory listing, or one feedback_<slug>.md
  // copy) is a WARNING, not a build failure — the split matters:
  //
  //   PRIMARY target (CLAUDE.md's container, MEMORY.md's index) unreadable ⇒ the
  //     projection cannot be built at all, no rule loads, hard-fail ('build-failed').
  //   SIDE file unreadable ⇒ the index line still projects and every rule still
  //     loads; one full-copy convenience file is stale. Blocking /compact on that
  //     — with a message naming `--ensure-container`, which only ever touches
  //     CLAUDE.md and could not chmod a file if it tried — is a gate whose own
  //     named remedy cannot open it. Warn, name the path, name the permission fix.
  //
  // They are NOT swallowed (that was the original bug: a silent "nothing to clean
  // up" default) — they ride out in the report as `sideWarnings` and reach the
  // human through doctor and the PreCompact gate's notices.
  const sideWarnings = [];
  const sideWrites = [];
  // A marked side file whose bytes are no longer the ones this tool last wrote. It is
  // neither rewritten nor removed, and it blocks the run (exit 3) like a hand-edited block.
  const sideEdited = [];
  // The bytes of every side file this plan will write or remove, as read now (null: not
  // there). The write pass reads each one again right before touching it.
  const sidePre = new Map();
  const handEdited = (verb, p, text) => {
    if (!(p in sideHashes) || sideHashes[p] === sha256(text)) return false;
    sideEdited.push(p);
    sideWarnings.push(
      `not ${verb} ${p}: it was changed after feedback-sync generated it, so a rewrite would erase those edits. Move your edits elsewhere, then delete the file so --write generates it again`,
    );
    return true;
  };
  for (const d of desired) {
    for (const sf of target.sideFiles(d.page)) {
      // Same provenance rule as staleSideFiles, on the overwrite side: a
      // feedback_<slug>.md without the header is the user's own file (a promoted
      // bootstrap draft points at it, and the wiki copy only holds the index
      // summary). Unreadable counts as "not ours": never overwrite what cannot
      // be checked.
      let cur = null;
      if (existsSync(sf.path)) {
        let skip = null;
        try {
          cur = readFileSync(sf.path, 'utf-8');
          if (!cur.startsWith(SIDE_MARKER_PREFIX))
            skip = `not overwriting ${sf.path}: it has no feedback-sync provenance header, so it is a hand-written file. Rename or delete it by hand if the wiki page should own that name`;
        } catch (err) {
          skip = `cannot read side file ${sf.path}: ${err.message}`;
        }
        if (skip) {
          sideWarnings.push(skip);
          continue;
        }
        if (handEdited('overwriting', sf.path, cur)) continue;
      }
      sidePre.set(sf.path, cur);
      sideWrites.push(sf);
    }
  }
  let sideDeletes = [];
  if (!buildError) {
    try {
      for (const p of staleSideFiles(target, desired)) {
        let text;
        try {
          text = readFileSync(p, 'utf-8');
        } catch (err) {
          sideWarnings.push(`cannot read side file ${p}: ${err.message}`);
          continue;
        }
        if (handEdited('removing', p, text)) continue;
        sidePre.set(p, text);
        sideDeletes.push(p);
      }
    } catch (err) {
      sideWarnings.push(`cannot read side-file directory ${target.dir}: ${err.message}`);
    }
  }

  // dirty: main content would change OR any side-file would change/be removed
  let dirty = nextContent !== null && nextContent !== (fileExists ? original : '');
  if (sideDeletes.length) dirty = true;
  for (const sf of sideWrites) if (sidePre.get(sf.path) !== sf.content) dirty = true;

  return {
    desired,
    conflicts,
    unpaired,
    intruder,
    outOfContainer,
    overCap,
    dirty,
    content: original,
    hand,
    fileExists,
    nextContent,
    buildError,
    buildErrorKind,
    buildErrorRemedy,
    sideWrites,
    sideDeletes,
    sideWarnings,
    sideEdited,
    sidePre,
  };
}

// Every file a plan will change, in write order (side files, stale side files, then the
// primary target), each with the bytes preflight saw there (null: not there).
function plannedWrites(target, res) {
  const out = [];
  for (const sf of res.sideWrites)
    if (res.sidePre.get(sf.path) !== sf.content)
      out.push({
        kind: 'side',
        path: sf.path,
        content: sf.content,
        before: res.sidePre.get(sf.path),
      });
  for (const p of res.sideDeletes)
    out.push({ kind: 'delete', path: p, before: res.sidePre.get(p) });
  if (res.nextContent !== null && res.nextContent !== (res.fileExists ? res.content : ''))
    out.push({
      kind: 'primary',
      path: target.file,
      content: res.nextContent,
      before: res.fileExists ? res.content : null,
    });
  return out;
}

// Throws (code ECHANGED) when `path` no longer holds the bytes preflight read there. The
// plan was computed from those bytes: writing it over anything else replaces what
// somebody wrote in between.
function assertUnchanged(path, before) {
  let now = null;
  try {
    now = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (now !== before)
    throw Object.assign(new Error(`${path} changed after it was read for this write`), {
      code: 'ECHANGED',
    });
}

// Writer: applies a fully-validated plan. No validation here beyond the read-again: each
// file is compared with the bytes preflight saw right before it is replaced, and a
// difference stops the run (ECHANGED) instead of overwriting it. Every write is
// atomic (tmp+rename), so an interrupted run leaves each file at its previous
// content rather than truncated. Returns the (non-fatal) side-file warnings it
// collected and the side files it could not write or remove; a PRIMARY-target write
// failure is NOT swallowed: it throws, and run() turns it into a reported error with
// the permission remedy.
// ponytail: the read-again and the rename are two steps, so an editor that does not take
// the feedback-sync lock can still land a save between them.
function applyTarget(target, res) {
  const warnings = [];
  const failed = new Set();
  if (target.dir) mkdirSync(target.dir, { recursive: true });
  for (const w of plannedWrites(target, res)) {
    if (w.kind === 'primary') {
      assertUnchanged(w.path, w.before);
      atomicWrite(w.path, w.content);
      continue;
    }
    try {
      assertUnchanged(w.path, w.before);
      if (w.kind === 'side') atomicWrite(w.path, w.content);
      else rmSync(w.path);
    } catch (err) {
      if (err.code === 'ECHANGED') throw err;
      failed.add(w.path);
      warnings.push(
        w.kind === 'side'
          ? `cannot write side file ${w.path}: ${err.message}`
          : `cannot remove stale side file ${w.path}: ${err.message}`,
      );
    }
  }
  return { warnings, failed };
}

// ── project-id derivation ─────────────────────────────────────────────────────

function deriveProjectId(args) {
  if (args.projectId) return { id: args.projectId, derived: false, exists: true };
  const id = args.cwd.replace(/[/.]/g, '-');
  const dir = join(args.claudeHome, 'projects', id);
  return { id, derived: true, exists: existsSync(dir) };
}

// Default interactive prompt (readline over stdin → stderr, so stdout stays clean
// for --json). Returns one of: { action: 'confirm' } | { action: 'id', id }
// | { action: 'skip' }. Isolated so resolveProjectId() can be unit-tested with a
// fake prompt and so the only thing that can touch stdin is gated behind isTTY.
async function defaultPrompt({ derivedId, claudeHome }) {
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    process.stderr.write(
      `[feedback-sync] project-id "${derivedId}" has no directory under ${claudeHome}/projects.\n` +
        '  [Enter] confirm and use it (memory dir will be created on --write)\n' +
        '  type an id to use a different project-id\n' +
        '  type "skip" to skip MEMORY projection\n',
    );
    const answer = (await rl.question('project-id> ')).trim();
    if (!answer) return { action: 'confirm' };
    if (answer.toLowerCase() === 'skip') return { action: 'skip' };
    return { action: 'id', id: answer };
  } finally {
    rl.close();
  }
}

// Interactive layer on top of the pure deriveProjectId(). Resolves to
// { id, derived, exists, skipMemory }. Only prompts when the derived dir is
// missing AND stdin is a TTY AND --no-input is unset. Non-TTY / --no-input /
// explicit --project-id paths NEVER call prompt → cannot hang (hook/CI safe).
// `prompt` is injectable for testing; defaults to readline.
async function resolveProjectId(args, { prompt = defaultPrompt, isTTY } = {}) {
  const pid = deriveProjectId(args);
  // explicit --project-id, or derived dir exists → use as-is (no prompt).
  if (!pid.derived || pid.exists) return { ...pid, skipMemory: false };

  const interactive = (isTTY ?? Boolean(process.stdin.isTTY)) && !args.noInput;
  if (!interactive) {
    // hook / CI / pipe / --no-input: keep current behavior — skip MEMORY, no hang.
    return { ...pid, skipMemory: true };
  }

  const choice = await prompt({ derivedId: pid.id, claudeHome: args.claudeHome });
  if (choice.action === 'skip') return { ...pid, skipMemory: true };
  if (choice.action === 'id') {
    const id = choice.id;
    const exists = existsSync(join(args.claudeHome, 'projects', id));
    // user-entered id is accepted even if missing (they may be creating it);
    // the MEMORY dir is created on --write.
    return { id, derived: false, exists, skipMemory: false };
  }
  // confirm: accept the derived id despite the missing dir.
  return { ...pid, skipMemory: false };
}

// ── bootstrap + import (contract §11) ────────────────────────
//
// Both modes are *reverse* one-time helpers that scaffold wiki DRAFTS under
// pages/feedback/_drafts/ — they NEVER write pages/feedback/<slug>.md directly
// (the single-direction invariant). A human reviews each draft,
// fills the decision fields (scope/tier/targets/promote_to_global), and moves
// it into pages/feedback/. _drafts/ is excluded from sync candidates
// (loadFeedbackPages) and from lint (collectPages skips `_`-dirs), so an
// incomplete scaffold never trips required-field errors or projection.

// Provenance header so re-running bootstrap/import is recognisable and humans
// see at a glance the file is a generated scaffold awaiting review.
const DRAFT_MARKER = (origin) => `<!-- HYPO:FEEDBACK-SYNC:DRAFT origin=${origin} -->`;

// Slug from free text: keep unicode letters/digits (Korean rules stay readable),
// collapse every other run to a single dash, length-cap for filesystem sanity.
function kebabSlug(text, max = 48) {
  const s = String(text)
    .replace(/\*\*/g, '') // markdown bold
    .replace(/`[^`]*`/g, ' ') // inline code spans
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '') || 'entry';
}

// Reduce an externally-sourced slug (MEMORY index name, managed-block `source=`)
// to a single safe path segment. basename() collapses any `../` traversal to the
// final component, then we strip everything but unicode word chars / . _ - and
// leading dots. Returns null when nothing safe remains → caller skips it. Without
// this a crafted `source=../evil` / `feedback_../evil.md` would let --bootstrap /
// --import write outside _drafts (e.g. into pages/feedback/), breaking the
// one-way invariant.
function safeDraftSlug(raw) {
  const seg = basename(String(raw).replace(/\\/g, '/'));
  const cleaned = seg
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .replace(/-+$/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : null;
}

// Defense-in-depth: refuse to write a draft whose resolved path escapes _drafts.
function assertUnderDrafts(draftsDir, target) {
  const root = resolve(draftsDir) + sep;
  if (!resolve(target).startsWith(root)) {
    throw new Error(`refusing to write outside _drafts: ${target}`);
  }
}

// One-line summary from a rule body: drop markdown noise, cap length.
function oneLineSummary(text, max = 100) {
  const s = String(text).replace(/\*\*/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

// Parse <learned_behaviors> hand-written lines into {date, rule}. Lines INSIDE a
// HYPO:FEEDBACK-SYNC managed block are skipped — those already have a wiki SoT
// and are not legacy entries to migrate.
function parseLearnedBehaviors(content) {
  // Same container judgment placement uses (classifyContainer): a pair quoted in
  // an HTML comment / a code fence / inline code is not a container to read
  // legacy rules out of, and a corrupt one has no unambiguous inner span at all.
  const c = classifyContainer(content);
  if (c.state !== 'present') return [];
  const inner = content.slice(c.open + LB_OPEN.length, c.close);
  const scrubbed = inner.replace(BLOCK_RE, ''); // blank out already-projected blocks
  const out = [];
  let section = sectionAt(content.slice(0, c.open + LB_OPEN.length));
  for (const line of scrubbed.split('\n')) {
    section = headingLine(line) ?? section;
    const m = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.*\S)\s*$/);
    if (m) out.push({ date: m[1], rule: m[2].trim(), line, section });
  }
  return out;
}

// Parse MEMORY.md index for sync-shaped feedback entries:
//   `- [Title](feedback_<name>.md): summary`
// A legacy dash separator before the summary is read too (older projections and
// hand-written lines).
// Non-`feedback_*` index lines are out of scope (not feedback projections).
function parseMemoryIndex(content) {
  const out = [];
  // scrub already-projected managed blocks first (parity with parseLearnedBehaviors):
  // index lines inside a HYPO:FEEDBACK-SYNC block already have a wiki SoT and must
  // not be re-drafted as legacy entries.
  const scrubbed = content.replace(BLOCK_RE, '');
  const re = /^- \[([^\]]*)\]\(feedback_([^)]+?)\.md\)\s*(?:(?::|—)\s*(.*\S))?\s*$/gm;
  let m;
  while ((m = re.exec(scrubbed)) !== null) {
    // The trailing \s* can swallow newlines, so the first segment is the physical
    // line (bytes as on disk, a CRLF's \r included): what --bootstrap records.
    const line = m[0].split('\n')[0];
    const section = sectionAt(scrubbed.slice(0, m.index));
    out.push({
      title: m[1].trim(),
      name: m[2].trim(),
      summary: (m[3] || '').trim(),
      line,
      section,
    });
  }
  return out;
}

// Frontmatter skeleton for a bootstrap draft. Decision fields the human must set
// are left as `TODO` (the file is excluded from lint, so this never errors).
function bootstrapDraftContent({ title, summary, body, date, origin }) {
  const lines = [
    DRAFT_MARKER(origin),
    '---',
    `title: ${title}`,
    'type: feedback',
    'status: draft',
    'scope: TODO              # global | project:<project-id>',
    'tier: TODO               # L1 (CLAUDE.md <learned_behaviors> candidate) | L2',
    'targets: [project-memory]   # + claude-learned for a global L1 rule',
    'sensitivity: public      # public | sanitized (private is forbidden)',
    'priority: 3              # 1-5, higher wins over-cap',
    `memory_summary: ${summary}`,
    `global_summary: ${summary}`,
    'promote_to_global: false # set true to project into <learned_behaviors>',
    'reason: TODO',
    `source: ${date ? `session:${date}` : 'TODO'}`,
  ];
  if (date) lines.push(`created: ${date}`, `updated: ${date}`);
  // the comment has no colon, so parseFrontmatter skips it (a key-less line)
  lines.push(
    '# keep the bootstrap_origin line below, it lets --write remove the hand line this draft came from',
    `bootstrap_origin: ${origin}`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
    '',
  );
  return lines.join('\n');
}

// Frontmatter skeleton for an import draft: captures the on-disk (hand-edited)
// managed block content as the body so the human can reconcile it into the SoT.
function importDraftContent({ slug, inner, from }) {
  return [
    DRAFT_MARKER(`import-${from}`),
    '---',
    `title: imported ${slug}`,
    'type: feedback',
    'status: draft',
    'scope: TODO',
    'tier: TODO',
    'targets: [project-memory]',
    'sensitivity: public',
    'priority: 3',
    `memory_summary: ${oneLineSummary(inner)}`,
    `global_summary: ${oneLineSummary(inner)}`,
    'promote_to_global: false',
    `reason: imported from ${from} <learned_behaviors>/MEMORY managed block (hand-edited)`,
    'source: TODO',
    `imported_from: ${from}`,
    '---',
    '',
    `# imported ${slug}`,
    '',
    '> The managed block below was edited outside the wiki. Reconcile it into',
    `> pages/feedback/${slug}.md (the SoT), then re-run feedback-sync --write.`,
    '',
    inner,
    '',
  ].join('\n');
}

function existingPageSlugs(hypoDir) {
  const dir = join(hypoDir, 'pages', 'feedback');
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.') && !f.startsWith('_'))
      .map((f) => basename(f, '.md')),
  );
}

// Source loader for --bootstrap (input side, symmetric with the output-side
// target descriptors): read the two legacy projection surfaces — CLAUDE.md
// <learned_behaviors> + the project MEMORY.md feedback_* index — and shape them
// into ordered draft candidates. CLAUDE candidates come first (file order from
// parseLearnedBehaviors), then MEMORY (parseMemoryIndex order); this order drives
// duplicate handling in runBootstrap, so it must be preserved. Returns
// { candidates, warnings, skipped } where `skipped` carries the unsafe MEMORY
// slugs the loader could not sanitize (seeded into report.skipped before the
// dedup loop appends its own skips).
function loadBootstrapSources(args) {
  const warnings = [];
  const skipped = [];
  const candidates = [];

  const claudeFile = join(args.claudeHome, 'CLAUDE.md');
  if (existsSync(claudeFile)) {
    for (const lb of parseLearnedBehaviors(readFileSync(claudeFile, 'utf-8'))) {
      const slug = `legacy-claude-${lb.date.replace(/-/g, '')}-${kebabSlug(lb.rule)}`;
      candidates.push({
        slug,
        origin: 'claude-learned',
        title: oneLineSummary(lb.rule, 60),
        summary: oneLineSummary(lb.rule),
        body: lb.rule,
        date: lb.date,
        target: 'claude',
        file: claudeFile,
        line: lb.line,
        section: lb.section,
      });
    }
  } else {
    warnings.push(`CLAUDE.md not found at ${claudeFile} — learned_behaviors source skipped`);
  }

  const pid = deriveProjectId(args);
  const memFile = join(args.claudeHome, 'projects', pid.id, 'memory', 'MEMORY.md');
  if (existsSync(memFile)) {
    for (const e of parseMemoryIndex(readFileSync(memFile, 'utf-8'))) {
      const slug = safeDraftSlug(e.name.replace(/_/g, '-'));
      if (!slug) {
        skipped.push({ slug: e.name, reason: 'unsafe-slug' });
        continue;
      }
      candidates.push({
        slug,
        origin: 'memory-index',
        title: e.title || slug,
        summary: e.summary,
        body: e.summary || e.title || slug,
        date: '',
        target: 'memory',
        file: memFile,
        line: e.line,
        section: e.section,
      });
    }
  } else {
    warnings.push(
      `MEMORY.md not found for project-id "${pid.id}" at ${memFile} — memory source skipped`,
    );
  }

  return { candidates, warnings, skipped };
}

// --bootstrap: load the two legacy projection surfaces (loadBootstrapSources)
// and scaffold one draft per deduped candidate.
function runBootstrap(args) {
  const draftsDir = join(args.hypoDir, 'pages', 'feedback', '_drafts');
  const existing = existingPageSlugs(args.hypoDir);
  const { candidates, warnings, skipped } = loadBootstrapSources(args);
  const report = { mode: 'bootstrap', dryRun: args.dryRun, created: [], skipped: [...skipped] };

  const seen = new Set();
  const recorded = [];
  for (const c of candidates) {
    if (seen.has(c.slug)) {
      report.skipped.push({ slug: c.slug, reason: 'duplicate-in-batch' });
      continue;
    }
    seen.add(c.slug);
    if (existing.has(c.slug)) {
      report.skipped.push({ slug: c.slug, reason: 'page-exists' });
      continue;
    }
    const draftPath = join(draftsDir, `${c.slug}.md`);
    if (existsSync(draftPath)) {
      report.skipped.push({ slug: c.slug, reason: 'draft-exists' });
      continue;
    }
    assertUnderDrafts(draftsDir, draftPath);
    report.created.push({ slug: c.slug, origin: c.origin, path: draftPath });
    if (!args.dryRun) {
      mkdirSync(draftsDir, { recursive: true });
      writeFileSync(draftPath, bootstrapDraftContent(c));
      recorded.push({
        slug: c.slug,
        target: c.target,
        file: c.file,
        line: c.line,
        section: c.section,
      });
    }
  }
  if (recorded.length) {
    const kept = loadHandLines(args.hypoDir).filter(
      (r) => !recorded.some((n) => n.slug === r.slug && n.target === r.target),
    );
    try {
      saveHandLines(args.hypoDir, [...kept, ...recorded]);
    } catch (err) {
      warnings.push(
        `could not record hand lines; they will not be removed on promotion: ${err.message}`,
      );
    }
  }
  return { code: 0, report, warnings };
}

// Source loader for --import-target-change (input side): select the target
// projection file (CLAUDE.md or the project MEMORY.md), read it, and return the
// managed blocks in conflict: inner content no longer matches the marker hash
// AND differs from what the wiki renders now (isBlockConflict). Returns { file, conflicts } or
// { error } for an invalid --from / missing target file.
function loadImportConflicts(args) {
  if (args.from !== 'memory' && args.from !== 'claude') {
    return { error: '--import-target-change requires --from=memory|claude' };
  }
  const file =
    args.from === 'claude'
      ? join(args.claudeHome, 'CLAUDE.md')
      : join(args.claudeHome, 'projects', deriveProjectId(args).id, 'memory', 'MEMORY.md');
  if (!existsSync(file)) return { error: `target file not found: ${file}` };

  // the same definition of conflict as --check/--write/--accept-wiki: a block that
  // was auto-accepted (its content equals the wiki's rendering) is not imported
  const target =
    args.from === 'claude' ? claudeTarget(args) : memoryTarget(args, deriveProjectId(args).id);
  const desired = computeDesired(loadFeedbackPages(args.hypoDir), target);
  const { blocks } = findBlocks(readFileSync(file, 'utf-8'));
  const conflicts = blocks.filter((b) => isBlockConflict(b, desired));
  return { file, conflicts };
}

// --import-target-change --from=<memory|claude>: capture hand-edited (conflict)
// managed blocks back into drafts so the human can reconcile them into the SoT.
function runImport(args) {
  const src = loadImportConflicts(args);
  if (src.error) return { code: 1, error: src.error };
  const { file, conflicts } = src;
  const report = { mode: 'import', from: args.from, dryRun: args.dryRun, imported: [] };
  const warnings = [];
  if (!conflicts.length) {
    warnings.push(`no hand-edited (conflicting) managed blocks in ${file} — nothing to import`);
    return { code: 0, report, warnings };
  }
  const draftsDir = join(args.hypoDir, 'pages', 'feedback', '_drafts');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  report.skipped = [];
  for (const b of conflicts) {
    // sanitize the marker-supplied slug (a tampered `source=../x` must not escape
    // _drafts — codex BLOCKER), then pick a collision-free name so a re-run / a
    // same-day import from both targets never clobbers a prior draft (or human
    // edits to it — codex IMPORTANT). `from` is in the name to disambiguate
    // memory vs claude imports of the same slug.
    const slug = safeDraftSlug(b.slug);
    if (!slug) {
      report.skipped.push({ slug: b.slug, reason: 'unsafe-slug' });
      continue;
    }
    let draftPath = join(draftsDir, `${slug}.import-${args.from}-${stamp}.md`);
    for (let n = 2; existsSync(draftPath); n++) {
      draftPath = join(draftsDir, `${slug}.import-${args.from}-${stamp}-${n}.md`);
    }
    assertUnderDrafts(draftsDir, draftPath);
    report.imported.push({ slug, path: draftPath });
    if (!args.dryRun) {
      mkdirSync(draftsDir, { recursive: true });
      writeFileSync(draftPath, importDraftContent({ slug, inner: b.inner, from: args.from }));
    }
  }
  return { code: 0, report, warnings };
}

// --accept-wiki=<slug>: for every target that holds that source's block in
// conflict, replace the block with the wiki's current rendering (or remove it when
// the wiki projects nothing for that source there any more: the wiki's rendering is
// empty). Only that block's bytes change, rewritten with a fresh marker hash. No
// other block, hand line, side-file or target file is touched.
//
// Refused per target when the file's markers are malformed or unpaired: BLOCK_RE
// pairs lazily, so a START whose END was deleted by hand swallows everything up to
// the NEXT block's END, and splicing that span would delete the neighbor block and
// any hand-written lines in between. --dry-run reports the plan and writes nothing.
// The slug of another entry the wiki projects whose text sits inside block `b` while the
// file has no block of its own for it: a deleted END plus a deleted START leave the marker
// counts balanced, but fuse two blocks (and whatever lies between) into one span.
function fusedWith(b, blocks, desired, target) {
  const ref = (slug) => (target.name === 'memory' ? `](feedback_${slug}.md)` : `[[${slug}]]`);
  return desired.find(
    (d) =>
      d.slug !== b.slug &&
      !blocks.some((x) => x.slug === d.slug) &&
      (b.inner.includes(d.inner) || b.inner.includes(ref(d.slug))),
  )?.slug;
}

function runAccept(args, evals) {
  const slug = args.acceptSlug;
  const report = { mode: 'accept', slug, dryRun: args.dryRun, accepted: [], refused: [] };
  if (args.dryRun) report.planned = [];
  const plans = [];
  for (const { target, res } of evals) {
    const { blocks } = findBlocks(res.content);
    const b = blocks.find((x) => x.slug === slug);
    const d = res.desired.find((x) => x.slug === slug);
    const { starts, ends } = countMarkers(res.content);
    let reason = null;
    // `unresolved`: this target holds the source's block but accept cannot touch it, so
    // it stays blocked after this command (the other refusals are just "nothing to do
    // for this target"). It decides the exit code.
    let unresolved = false;
    if (!b) reason = 'no managed block for this source';
    else if (starts !== blocks.length || ends !== blocks.length) {
      reason = `malformed or unpaired managed marker in ${target.file}: repair the markers by hand first`;
      unresolved = true;
    } else if (!isBlockConflict(b, res.desired)) reason = 'block is not in conflict';
    else {
      const other = fusedWith(b, blocks, res.desired, target);
      if (other) {
        reason = `the block for ${slug} in ${target.file} also holds the text of ${other}: its END marker and the next block's START marker look deleted, so accepting would replace both entries and any text between them. Repair the markers by hand first`;
        unresolved = true;
      }
    }
    if (reason)
      report.refused.push({ target: target.name, reason, ...(unresolved ? { unresolved } : {}) });
    else plans.push({ target, b, d, content: res.content, discarded: b.inner });
  }
  if (!plans.length) {
    const why = report.refused.map((r) => `${r.target}: ${r.reason}`).join('; ');
    return { code: 1, error: `--accept-wiki=${slug}: nothing to accept (${why})`, report };
  }
  for (const { target, b, d, content, discarded } of plans) {
    const action = d ? 'replace' : 'remove';
    // Marker counts cannot tell a block from two blocks fused by deleting one END
    // and the next START, so the exact inner text that is about to go is reported:
    // it is the only way to see a swallowed span before (or after) it is gone.
    if (args.dryRun) {
      report.planned.push({ target: target.name, file: target.file, action, discarded });
      continue;
    }
    const next = d
      ? content.slice(0, b.start) + renderBlock(slug, d.inner) + content.slice(b.end)
      : removeBlock(content, b);
    const done = report.accepted.map((a) => a.target).join(', ');
    const doneNote = done ? ` Already accepted before this failure: ${done}.` : '';
    // The whole file as it is now goes aside first: `discarded` only names the block's
    // inner text, and a block that swallowed a neighbor (a deleted END plus a deleted
    // START leave the counts balanced) loses more than that.
    // `content` is what preflight read: the file is read again before the copy and
    // before the replacement, so a save made in between is neither copied over nor lost.
    const changedNow = (err) => ({
      code: 1,
      error:
        err.code === 'ECHANGED'
          ? `${target.file} changed after it was read for this accept. It was not replaced; run --accept-wiki again.${doneNote}`
          : `cannot read ${target.file}: ${err.message}. Nothing was written to it.${doneNote}`,
      report,
    });
    try {
      assertUnchanged(target.file, content);
    } catch (err) {
      return changedNow(err);
    }
    let kept;
    try {
      kept = keepCopy(args.hypoDir, `${target.name}-before-accept-${slug}`, content);
    } catch (err) {
      return {
        code: 1,
        error: `cannot keep a copy of ${target.file} before replacing it: ${err.message}. Nothing was written to it.${doneNote}`,
        report,
      };
    }
    try {
      assertUnchanged(target.file, content);
    } catch (err) {
      return changedNow(err);
    }
    try {
      atomicWrite(target.file, next);
    } catch (err) {
      return {
        code: 1,
        error: `cannot write ${target.file}: ${err.message}. ${REMEDY.io(target.file)}${doneNote}`,
        report,
      };
    }
    report.accepted.push({ target: target.name, file: target.file, action, discarded, kept });
  }
  // Exit codes: 0 every relevant target resolved, 1 usage error / nothing accepted /
  // write failure, 3 something was accepted but a target that holds the block still
  // needs a hand repair (same meaning as 3 from --check: the projection is still blocked).
  return { code: report.refused.some((r) => r.unresolved) ? 3 : 0, report };
}

// Cut one managed block out of `content` together with its line ending, so no blank
// line is left behind. A block that ends the file without a trailing newline takes
// the newline before it instead.
function removeBlock(content, b) {
  let { start, end } = b;
  if (content.startsWith('\r\n', end)) end += 2;
  else if (content[end] === '\n') end += 1;
  else if (start > 0 && content[start - 1] === '\n') start -= content[start - 2] === '\r' ? 2 : 1;
  return content.slice(0, start) + content.slice(end);
}

// The provisioning step --write can never do on its own: --write only ever
// PLACES a region INSIDE an existing `<learned_behaviors>` container (it has
// no way to guess where in an arbitrary, possibly hand-authored CLAUDE.md a
// container belongs — that would risk corrupting content it does not own).
// When the container is simply gone (deleted by hand, a bad merge, ...),
// --write's only recourse is the 'build-failed' error, and a gate that reports
// a failure with no way through gets bypassed rather than obeyed — this is the
// way through.
//
//   file MISSING entirely → no-op ('target-missing' is the ordinary first-run
//     state; --ensure-container repairs an EXISTING file, it does not create
//     one out of nothing).
//   file is a DANGLING symlink → fail. It is not missing, it is broken, and the
//     fix is on the link, not here.
//   file exists, container ALREADY present → no-op (idempotent: safe to run
//     from a blocker message without checking state first).
//   file exists, container CORRUPT → fail, and say what is wrong. A blind append
//     onto inverted/duplicated tags is how this command would manufacture a state
//     it can never repair: the pair it adds does not fix the broken one, the
//     predicate still reads "no container", the next run appends ANOTHER pair, and
//     --write fails forever. Refusing is the only honest move.
//   file exists, no container → append a short guidance comment plus an empty
//     `<learned_behaviors></learned_behaviors>` pair to the END of the file. The
//     existing bytes are re-written verbatim ahead of the addition through
//     atomicWrite (tmp+rename), so a crash or a full disk mid-write cannot leave
//     the user's global config truncated — the file is either wholly old or
//     wholly new. (The previous writeFileSync(file, content + addition) truncated
//     first and wrote second: the one command that promises "existing content is
//     never touched" was the one that could shred it.)
function runEnsureContainer(args) {
  const target = claudeTarget(args);
  const file = target.file;
  if (!existsSync(file)) {
    if (isDanglingSymlink(file)) {
      return {
        code: 1,
        error:
          `${file} is a dangling symlink (its link target does not exist) — nothing to provision. ` +
          REMEDY.danglingSymlink(file),
      };
    }
    return { code: 0, report: { mode: 'ensure-container', file, action: 'target-missing' } };
  }
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch (err) {
    return { code: 1, error: `cannot read ${file}: ${err.message} — ${REMEDY.io(file)}` };
  }
  const c = classifyContainer(content);
  if (c.state === 'present') {
    return { code: 0, report: { mode: 'ensure-container', file, action: 'noop-already-present' } };
  }
  if (c.state === 'corrupt') {
    return {
      code: 1,
      error:
        `refusing to append to ${file}: it already carries a corrupt <learned_behaviors> ` +
        `container — ${c.reason}. ${REMEDY.containerCorrupt(file, c.reason)}`,
    };
  }
  const sep = content.endsWith('\n') ? '' : '\n';
  const addition =
    `${sep}\n` +
    '<!-- Added by `hypomnema feedback-sync --ensure-container`: this pair is the managed\n' +
    'region feedback-sync projects wiki-sourced learned behaviors into. Do not hand-edit its\n' +
    'contents: a hand-edit becomes a sync conflict. -->\n' +
    '<learned_behaviors>\n</learned_behaviors>\n';
  try {
    atomicWrite(file, content + addition);
  } catch (err) {
    return { code: 1, error: `cannot write ${file}: ${err.message} — ${REMEDY.io(file)}` };
  }
  return { code: 0, report: { mode: 'ensure-container', file, action: 'created' } };
}

// ── modes ─────────────────────────────────────────────────────────────────────

// The modes that replace MEMORY.md, CLAUDE.md or a side file run under one lock on the
// vault, so two feedback-sync runs (two PreCompact heals, a feedback post-step beside a
// hand-run --write) cannot read the same files and then write over each other. check and
// --dry-run only read. bootstrap and import write drafts and the line record, where a lost
// update only leaves a duplicate line, so they do not wait for it.
function run(args, resolvedPid = null) {
  const locked = ['write', 'accept', 'ensure-container'].includes(args.mode) && !args.dryRun;
  if (!locked || !existsSync(args.hypoDir)) return runAndPrune(args, resolvedPid);
  let entered = false;
  try {
    return withFileLock(
      join(args.hypoDir, '.cache', 'feedback-sync'),
      () => {
        entered = true;
        return runAndPrune(args, resolvedPid);
      },
      { timeoutMs: 3000 },
    );
  } catch (err) {
    if (entered) throw err;
    return {
      code: 1,
      error:
        err.code === 'ELOCKTIMEOUT'
          ? 'another feedback-sync run holds the vault lock. Nothing was written; run it again'
          : `cannot take the vault lock: ${err.message}. Nothing was written`,
    };
  }
}

// The older kept copies of the labels this run wrote under are deleted only once the run
// ended normally (exit 0 or 3, no error): a run that stopped before its write keeps every
// copy that could still undo an earlier one.
function runAndPrune(args, resolvedPid) {
  keptLabels.clear();
  try {
    const out = runUnlocked(args, resolvedPid);
    if (!out.error && (out.code === 0 || out.code === 3) && keptLabels.size) {
      const warns = pruneKept(args.hypoDir, [...keptLabels]);
      if (warns.length) {
        (out.warnings ||= []).push(...warns);
        if (out.report) (out.report.warnings ||= []).push(...warns);
      }
    }
    return out;
  } finally {
    keptLabels.clear();
  }
}

function runUnlocked(args, resolvedPid = null) {
  if (!existsSync(args.hypoDir)) {
    return { code: 1, error: `wiki not found: ${args.hypoDir}` };
  }
  if (args.mode === 'ensure-container') return runEnsureContainer(args);
  if (args.mode === 'bootstrap') return runBootstrap(args);
  if (args.mode === 'import') return runImport(args);
  if (args.mode === 'accept' && !args.acceptSlug) {
    return {
      code: 1,
      error:
        '--accept-wiki requires a source slug in the `=` form, e.g. --accept-wiki=rule-a ' +
        '(a space-separated slug is not read)',
    };
  }

  const pages = loadFeedbackPages(args.hypoDir);
  // pid may be pre-resolved by the interactive layer in main(); fall back to the
  // pure derivation for direct callers / tests. `skipMemory` carries the §5 step 4
  // decision (non-interactive unresolved, or user chose "skip").
  let pid;
  if (resolvedPid) {
    pid = resolvedPid;
  } else {
    // direct/sync caller (tests, machine path): no prompting possible here, so
    // mirror the original non-interactive rule — skip MEMORY when the derived
    // dir is missing (contract §5 step 4 non-interactive branch).
    const d = deriveProjectId(args);
    pid = { ...d, skipMemory: d.derived && !d.exists };
  }
  if (args.skipMemory) pid.skipMemory = true;

  const targets = [];
  // MEMORY target only when not skipped (contract §5 step 4: unknown project-id
  // in non-interactive mode, or user-declined → skip, do not hard-fail).
  if (!pid.skipMemory) {
    targets.push(memoryTarget(args, pid.id));
  }
  targets.push(claudeTarget(args));

  const report = { mode: args.mode, projectId: pid.id, projectIdResolved: pid.exists, targets: {} };
  if (pid.skipMemory) report.skipMemory = true;
  let code = 0;
  // `warnings`: everything surfaced to the human (stderr / JSON report).
  // `strictWarnings`: the subset `--strict` escalates to a non-zero exit.
  // These are NOT the same set. The skip-MEMORY warning is an *environmental*
  // state (a fresh / external user has no ~/.claude/projects/<id>/memory yet),
  // not actionable drift — contract §5 step 4 promises this never hard-fails,
  // so it must stay OUT of strictWarnings or the PreCompact gate (#3, which
  // runs `--check --strict`) would block every first-run user. A private-
  // sensitivity page IS a real SoT violation (lint #8 blocks it
  // at the source) so it stays strict-escalatable as defense-in-depth.
  const warnings = [];
  const strictWarnings = [];
  if (pid.skipMemory) {
    warnings.push(
      `project-id "${pid.id}" dir not found under ${args.claudeHome}/projects — MEMORY projection skipped (pass --project-id to override)`,
    );
  }
  for (const p of pages) {
    if (p.fm.sensitivity && !PUBLIC_SENSITIVITY.has(p.fm.sensitivity)) {
      const w = `page "${p.slug}" excluded: sensitivity="${p.fm.sensitivity}" (only public|sanitized)`;
      warnings.push(w);
      strictWarnings.push(w);
    }
  }

  // pass 1: preflight every target before touching disk — validates the write
  // plan (container/anchor, markers) and computes next content. A conflict /
  // over-cap / build error in ANY target blocks writes to ALL (atomicity:
  // "no auto-merge"; avoids a partial write where one target
  // lands and another refuses).
  const handRecs = loadHandLines(args.hypoDir);
  const sideHashes = loadSideHashes(args.hypoDir);
  const sideHashesAtLoad = JSON.stringify(sideHashes);
  const evals = targets.map((target) => ({
    target,
    res: evaluateTarget(pages, target, handRecs, sideHashes),
  }));
  for (const { target, res } of evals) {
    report.targets[target.name] = {
      candidates: res.desired.length,
      conflicts: res.conflicts,
      unpaired: res.unpaired,
      intruder: res.intruder,
      outOfContainer: res.outOfContainer,
      overCap: res.overCap,
      dirty: res.dirty,
      ...(res.sideEdited.length ? { sideEdited: res.sideEdited } : {}),
      // buildErrorKind rides along with buildError so a consumer (doctor, the
      // PreCompact gate) can tell a first-run missing file from a structurally
      // broken one WITHOUT re-deriving that judgment by string-matching the
      // message. The judgment is made once, here, where the branch is taken —
      // and buildErrorRemedy carries the way OUT for that exact cause, so no
      // consumer has to guess one (a permission error advised to run
      // `--ensure-container` is a blocker its own remedy cannot open).
      ...(res.buildError
        ? {
            buildError: res.buildError,
            buildErrorKind: res.buildErrorKind,
            ...(res.buildErrorRemedy ? { buildErrorRemedy: res.buildErrorRemedy } : {}),
          }
        : {}),
      // Non-fatal: a side-file I/O problem degrades the projection, it does not
      // break it. Reported (never swallowed), but it must not block /compact.
      ...(res.sideWarnings.length ? { sideWarnings: res.sideWarnings } : {}),
      // The way out of a conflicted target, decided once here (see REMEDY.conflict).
      ...(res.conflicts.length ||
      res.intruder ||
      res.unpaired ||
      res.outOfContainer ||
      res.sideEdited.length
        ? { conflictRemedy: REMEDY.conflict(target.name, res) }
        : {}),
    };
    for (const w of res.sideWarnings) warnings.push(`${target.name}: ${w}`);
    if (
      res.conflicts.length ||
      res.intruder ||
      res.unpaired ||
      res.outOfContainer ||
      res.sideEdited.length
    )
      code = Math.max(code, 3);
    else if (res.overCap) code = Math.max(code, 2);
    else if (res.buildError) code = Math.max(code, 1);
    else if (res.dirty && args.mode === 'check') code = Math.max(code, 1);
  }

  if (args.mode === 'accept') return runAccept(args, evals);

  // strict promotes warnings to a failure; compute it BEFORE the write gate so a
  // --write --strict refuses rather than writing then exiting non-zero.
  const strictFail = args.strict && strictWarnings.length > 0;

  // pass 2: write only when nothing blocks (code === 0 ⇒ no conflict, over-cap,
  // build error, or check-mode drift) and no strict failure. Skip clean targets
  // so writes stay byte-idempotent.
  if (args.mode === 'write' && code === 0 && !strictFail) {
    // A warning raised while writing goes to stderr and, because --json prints no
    // stderr warnings, into the JSON report too (report.warnings).
    const writeWarn = (w) => {
      warnings.push(w);
      (report.warnings ||= []).push(w);
    };
    // A hand line this write is about to drop goes aside first, for every target, before
    // any file is touched: if the copy cannot be written nothing has changed yet.
    const handCopies = {};
    for (const { target, res } of evals) {
      if (!res.hand.removed.length) continue;
      try {
        handCopies[target.name] = keepCopy(
          args.hypoDir,
          `${target.name}-hand-lines`,
          `Removed from ${target.file} by feedback-sync --write (lines a bootstrap draft came from):\n` +
            res.hand.removed.map((r) => r.line).join('\n') +
            '\n',
        );
      } catch (err) {
        return {
          code: 1,
          error: `cannot keep a copy of the hand lines it would remove from ${target.file}: ${err.message}. Nothing was written.`,
          report,
          warnings,
        };
      }
    }
    // The primary file as preflight read it goes aside too, before any file is replaced:
    // a write that replaces a file somebody else is also editing can lose their bytes.
    for (const { target, res } of evals) {
      const primary = plannedWrites(target, res).find((w) => w.kind === 'primary');
      if (!primary || primary.before === null) continue;
      try {
        keepCopy(args.hypoDir, `${target.name}-before-write`, primary.before);
      } catch (err) {
        // The routine copy is the one thing a vault whose git would stage .cache/ can do
        // without: the write is still guarded by the lock and the read-again, and no user
        // bytes are removed by it (hand lines and accept keep their own blocking copies).
        if (err.code === 'EUNIGNORED') {
          writeWarn(
            `${target.name}: no copy of ${target.file} was kept before replacing it: ${err.message}`,
          );
          continue;
        }
        return {
          code: 1,
          error: `cannot keep a copy of ${target.file} before replacing it: ${err.message}. Nothing was written.`,
          report,
          warnings,
        };
      }
    }
    // A generated side file with no recorded hash may hold the user's edits (it was written
    // before the record existed, or the record is gone), and the write below replaces or
    // removes it without any way to tell. Its bytes go aside first; when they cannot, that
    // one file is left as it is (the primary write does not depend on it) and the run says so.
    for (const { target, res } of evals) {
      const left = new Set();
      for (const w of plannedWrites(target, res)) {
        if (w.kind === 'primary' || w.before === null || w.path in sideHashes) continue;
        try {
          keepCopy(
            args.hypoDir,
            `side-${basename(w.path).replace(/^feedback_|\.md$/g, '')}`,
            w.before,
          );
        } catch (err) {
          left.add(w.path);
          writeWarn(
            `${target.name}: left ${w.path} as it is: no copy of it could be kept first (${err.message}). It has no record that feedback-sync generated every byte of it`,
          );
        }
      }
      if (left.size) {
        res.sideWrites = res.sideWrites.filter((sf) => !left.has(sf.path));
        res.sideDeletes = res.sideDeletes.filter((p) => !left.has(p));
      }
    }
    // Read every file this write will change once more now that the copies are done: a
    // file that is no longer what preflight saw stops the whole run before any is written.
    const changed = [];
    for (const { target, res } of evals)
      for (const w of plannedWrites(target, res)) {
        try {
          assertUnchanged(w.path, w.before);
        } catch {
          changed.push(w.path);
        }
      }
    if (changed.length) {
      return {
        code: 1,
        error: `${changed.join(', ')} changed after feedback-sync read it. Nothing was written; run it again.`,
        report,
        warnings,
      };
    }
    const spent = [];
    try {
      for (const { target, res } of evals) {
        // a side file that already holds the generated bytes is recorded as ours too
        for (const sf of res.sideWrites)
          if (res.sidePre.get(sf.path) === sf.content) sideHashes[sf.path] = sha256(sf.content);
        try {
          if (res.dirty) {
            const out = applyTarget(target, res);
            out.warnings.forEach((w) => writeWarn(`${target.name}: ${w}`));
            for (const sf of res.sideWrites)
              if (res.sidePre.get(sf.path) !== sf.content && !out.failed.has(sf.path))
                sideHashes[sf.path] = sha256(sf.content);
            for (const p of res.sideDeletes) if (!out.failed.has(p)) delete sideHashes[p];
          }
        } catch (err) {
          if (err.code === 'ECHANGED') {
            return {
              code: 1,
              error: `${err.message}. It was not overwritten; run feedback-sync again.`,
              report,
              warnings,
            };
          }
          // A PRIMARY-target write failure (ENOSPC, EACCES, a read-only mount).
          // Reported, not thrown: an uncaught throw prints no JSON, and every
          // consumer reads "no report" as "nothing to project" and fails OPEN —
          // the exact silent-green failure this projection system exists to stop.
          // The preflight already ruled out every failure it CAN see; an fs error
          // at write time is the one thing it cannot, so the cross-target atomicity
          // contract holds up to that point and no further (documented, not fixed
          // here: a two-phase commit across two independent files is a different
          // change).
          return {
            code: 1,
            error: `cannot write ${target.file}: ${err.message} — ${REMEDY.io(target.file)}`,
            report,
            warnings,
          };
        }
        // The record entry is dropped below, so this run is the only one that can say
        // so: put it in the JSON report as well as on stderr (--json prints no warnings).
        const pick = (r) => ({ slug: r.slug, file: r.file, line: r.line });
        if (res.hand.kept.length) report.targets[target.name].handKept = res.hand.kept.map(pick);
        if (res.hand.removed.length) {
          report.targets[target.name].handRemoved = res.hand.removed.map(pick);
          report.targets[target.name].handRemovedCopy = handCopies[target.name];
        }
        for (const r of res.hand.kept) warnings.push(`${target.name}: ${handKeptNotice(r)}`);
        spent.push(...res.hand.removed, ...res.hand.kept, ...res.hand.stale);
      }
    } finally {
      // runs on every way out, an early error return included: a side file that was
      // replaced before the failure must not look hand-edited at the next run
      if (JSON.stringify(sideHashes) !== sideHashesAtLoad) {
        try {
          saveSideHashes(args.hypoDir, sideHashes);
        } catch (err) {
          writeWarn(`cannot update the side file record: ${err.message}`);
        }
      }
    }
    // a record whose draft and page are both gone can never be consumed: drop it
    // so it cannot meet an unrelated page that reuses the slug later
    const draftsDir = join(args.hypoDir, 'pages', 'feedback', '_drafts');
    for (const r of handRecs) {
      if (!pages.some((p) => p.slug === r.slug) && !existsSync(join(draftsDir, `${r.slug}.md`)))
        spent.push(r);
    }
    if (spent.length) {
      try {
        saveHandLines(
          args.hypoDir,
          handRecs.filter((r) => !spent.includes(r)),
        );
      } catch (err) {
        writeWarn(`cannot update the bootstrap line record: ${err.message}`);
      }
    }
  }

  if (strictFail) code = Math.max(code, 1);
  return { code, report, warnings };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  // Resolve project-id before run() so the (possibly interactive) prompt happens
  // exactly once. resolveProjectId only touches stdin when stdin.isTTY is truthy
  // and --no-input is unset → hooks/CI/pipes never block here.
  let resolvedPid = null;
  if (
    existsSync(args.hypoDir) &&
    args.mode !== 'bootstrap' &&
    args.mode !== 'import' &&
    args.mode !== 'ensure-container' // no MEMORY/project-id involvement at all
  ) {
    resolvedPid = await resolveProjectId(args);
  }
  const out = run(args, resolvedPid);

  if (args.json) {
    // a failed --accept-wiki still says which targets were already rewritten
    const errBody =
      out.report && out.report.mode === 'accept'
        ? { error: out.error, accepted: out.report.accepted, refused: out.report.refused }
        : { error: out.error };
    console.log(JSON.stringify(out.error ? errBody : out.report, null, 2));
  } else if (out.error) {
    console.error(`[feedback-sync] ${out.error}`);
  } else if (out.report.mode === 'ensure-container') {
    const { action, file } = out.report;
    if (action === 'target-missing') {
      console.error(
        `[feedback-sync] ensure-container: ${file} does not exist yet — nothing to provision ` +
          `(this is the ordinary first-run state, not something --ensure-container creates).`,
      );
    } else if (action === 'noop-already-present') {
      console.error(
        `[feedback-sync] ensure-container: ${file} already has a <learned_behaviors> container — no changes made.`,
      );
    } else {
      console.error(
        `[feedback-sync] ensure-container: appended an empty <learned_behaviors></learned_behaviors> ` +
          `container to ${file} (existing content untouched). Run \`hypomnema feedback-sync --write\` next.`,
      );
    }
  } else if (out.report.mode === 'bootstrap') {
    for (const w of out.warnings || []) console.error(`[feedback-sync] warn: ${w}`);
    const verb = out.report.dryRun ? 'would create' : 'created';
    for (const c of out.report.created)
      console.error(
        `[feedback-sync] ${verb} draft: pages/feedback/_drafts/${c.slug}.md (${c.origin})`,
      );
    for (const s of out.report.skipped)
      console.error(`[feedback-sync] skipped ${s.slug}: ${s.reason}`);
    console.error(
      `[feedback-sync] bootstrap: ${out.report.created.length} ${verb}, ${out.report.skipped.length} skipped. ` +
        `Fill scope/tier/targets/promote_to_global and move into pages/feedback/.`,
    );
  } else if (out.report.mode === 'accept') {
    for (const w of out.warnings || []) console.error(`[feedback-sync] warn: ${w}`);
    const what = (a) =>
      a.action === 'remove' ? 'removed the block' : 'accepted the wiki rendering';
    const showDiscarded = (a) =>
      console.error(
        `[feedback-sync] ${out.report.dryRun ? 'would discard' : 'discarded'} hand edit in ${a.file} for ${out.report.slug}:\n${a.discarded}`,
      );
    for (const a of out.report.planned || []) {
      console.error(
        `[feedback-sync] would ${a.action} the block for ${out.report.slug} in ${a.target} (${a.file}). Nothing written (--dry-run).`,
      );
      showDiscarded(a);
    }
    for (const a of out.report.accepted) {
      console.error(
        `[feedback-sync] ${what(a)} for ${out.report.slug} in ${a.target} (${a.file}). The file as it was is kept at ${a.kept}.`,
      );
      showDiscarded(a);
    }
    for (const r of out.report.refused.filter((x) => x.unresolved))
      console.error(`[feedback-sync] NOT accepted in ${r.target}: ${r.reason}`);
    if (!out.report.dryRun)
      console.error('[feedback-sync] Run `hypomnema feedback-sync --check` to confirm.');
  } else if (out.report.mode === 'import') {
    for (const w of out.warnings || []) console.error(`[feedback-sync] warn: ${w}`);
    const verb = out.report.dryRun ? 'would import' : 'imported';
    for (const i of out.report.imported)
      console.error(`[feedback-sync] ${verb} ${i.slug} → ${i.path}`);
    if (out.report.imported.length)
      console.error(
        `[feedback-sync] import: ${out.report.imported.length} draft(s). Reconcile into the SoT page, then feedback-sync --write.`,
      );
  } else {
    for (const w of out.warnings || []) console.error(`[feedback-sync] warn: ${w}`);
    for (const [name, t] of Object.entries(out.report.targets)) {
      if (
        t.conflicts.length ||
        t.intruder ||
        t.unpaired ||
        t.outOfContainer ||
        t.sideEdited?.length
      ) {
        const why = t.conflicts.length
          ? `block(s) manually edited: ${t.conflicts.join(', ')}`
          : t.unpaired
            ? 'malformed/unpaired HYPO:FEEDBACK-SYNC marker'
            : t.outOfContainer
              ? 'managed block sits outside <learned_behaviors>'
              : t.intruder
                ? 'managed region has unrecognized lines (move them outside the HYPO blocks)'
                : `side file(s) edited after they were generated: ${t.sideEdited.join(', ')}`;
        console.error(`[feedback-sync] CONFLICT: ${name} ${why}\n` + `  ${t.conflictRemedy}`);
      } else if (t.buildError) console.error(`[feedback-sync] ERROR: ${name} ${t.buildError}`);
      else if (t.overCap)
        console.error(
          `[feedback-sync] OVER-CAP: ${name} has ${t.candidates} candidates (cap ${name === 'claude' ? '10 entries' : '200 lines'}) — demote/archive required.`,
        );
      else if (t.dirty && args.mode === 'check')
        console.error(`[feedback-sync] drift: ${name} projection is stale (run --write).`);
    }
    if (out.code === 0 && args.mode === 'write')
      console.error('[feedback-sync] projections written.');
  }

  process.exit(out.code);
}

function isMain() {
  try {
    // normalize via realpathSync + pathToFileURL so paths with spaces /
    // URL-significant chars / symlinks compare correctly. Node resolves
    // import.meta.url through realpath, so argv[1] must be realpath'd too
    // (e.g. macOS /tmp → /private/tmp); a raw `file://${argv[1]}` silently no-ops.
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}

// evaluateTarget, applyTarget, runAccept, memoryTarget and loadFeedbackPages are exported for
// the tests that drive the preflight and the write pass apart (a file that changes between them).
export {
  parseArgs,
  deriveProjectId,
  resolveProjectId,
  run,
  evaluateTarget,
  applyTarget,
  runAccept,
  memoryTarget,
  loadFeedbackPages,
};
