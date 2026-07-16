#!/usr/bin/env node
/**
 * Hypomnema lint script
 *
 * Validates wiki pages for frontmatter correctness and broken wikilinks.
 *
 * Usage:
 *   node scripts/lint.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>   Hypomnema root (default: resolved via HYPO_DIR / hypo-config.md / ~/hypomnema)
 *   --json              Output results as JSON
 *   --fix               Auto-add missing `updated` field (safe repairs only)
 *   --strict            Promote selected warnings (STRICT_PROMOTE_IDS) to errors
 *                       so they exit 1. Opt-in gate for release-checklist /
 *                       pre-commit; default mode stays byte-identical.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import { resolveHypoRootInfo, checkVaultOrExit, expandHome } from './lib/hypo-root.mjs';
import { SESSION_STATE_NEXT_HEADINGS } from '../hooks/hypo-shared.mjs';
import { loadHypoIgnore, isScanIgnored } from './lib/hypo-ignore.mjs';
import {
  parseSchemaVocab,
  checkForbidden,
  parseSchemaPageDirs,
  parseSchemaTypes,
} from './lib/schema-vocab.mjs';
import { findDesignHistoryStale } from './lib/design-history-stale.mjs';
import { FEEDBACK_SCOPE_RE } from './lib/feedback-scope.mjs';
import { FAILURE_TYPE_ENUM } from './lib/failure-type.mjs';
import { collectPagesLint, collectPagesLinkable, slugForms } from './lib/wikilink.mjs';
import { parseFrontmatter, SEQUENCE_ENTRY_RE } from './lib/frontmatter.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, json: false, fix: false, strict: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--json') args.json = true;
    else if (arg === '--fix') args.fix = true;
    else if (arg === '--strict') args.strict = true;
  }
  if (!args.hypoDir) {
    const info = resolveHypoRootInfo();
    args.hypoDir = info.root;
    args.hypoDirSource = info.source;
  }
  return args;
}

// ── frontmatter parser ────────────────────────────────────────────────────────

// ── W9: narrow invalid-YAML detector ───────────────────────────────────────────
// NOT a full YAML parser (zero-dep policy). Catches only specific classes the
// lenient line-scanner (parseFrontmatter, imported from lib) silently passes but
// a real YAML parser (js-yaml, what Obsidian uses) rejects. Each class is
// conservative — it may miss, but must NOT false-positive on valid YAML, so it
// inspects only top-level (unindented) lines: indented lines may be block-scalar
// content where ": "/tabs are legal, and reliably telling content from structure
// needs a real parser. (A leading-tab class was considered and dropped for this
// reason — it cannot distinguish `relations:\n\t- x` from a tabbed block-scalar
// body without tracking block context.) Returns an array of reasons.
function checkYamlInvalid(block) {
  const reasons = [];
  const seen = new Set();
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (/^\s/.test(line) || SEQUENCE_ENTRY_RE.test(line)) continue; // top-level keys only
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    // duplicate top-level key (YAML rejects; line-scanner silently keeps one)
    if (seen.has(key)) reasons.push(`duplicate key: "${key}"`);
    else seen.add(key);
    // colon-space inside an unquoted, non-flow plain scalar. A plain scalar may
    // not contain ": " — js-yaml hard-errors or silently truncates. Skip quoted
    // ("/') and flow ([/{) values where ": " is legal, and strip an inline
    // " #" comment before scanning.
    let val = line.slice(idx + 1).trim();
    const c = val[0];
    if (val && c !== '"' && c !== "'" && c !== '[' && c !== '{') {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash);
      if (/:\s/.test(val)) {
        reasons.push(`unquoted "${key}" value contains ": " (quote it): "${val.slice(0, 40)}"`);
      }
    }
  }
  return reasons;
}

function parseTagsField(rawValue) {
  if (rawValue == null) return null;
  const trimmed = String(rawValue).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((t) => t.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return trimmed
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// type-conditional required fields (spec §6.3, SCHEMA.md §2)
const TYPE_CONDITIONAL_FIELDS = {
  prd: ['status', 'started'],
  adr: ['source', 'status', 'date'],
  'project-index': ['working_dir', 'status', 'started'],
  'tool-eval': ['status'],
  postmortem: ['outcome'],
  learning: ['source'],
  // feedback: projection SoT requires full classification
  feedback: [
    'status',
    'scope',
    'tier',
    'targets',
    'sensitivity',
    'priority',
    'memory_summary',
    'reason',
    'source',
  ],
  'prompt-pattern': ['source'],
  'source-summary': ['sources'],
  'weekly-journal': ['week'],
};

// type-conditional FORBIDDEN fields: a field that is legitimate on one type
// only, but has been observed leaking into another via an unvalidated writer.
// `working_dir` (and its companion `project`) belong solely on
// `project-index` (index.md) — TYPE_CONDITIONAL_FIELDS above requires it
// there. Unvalidated crystallize output has planted a stray `working_dir` /
// `project` key on session-state.md instead, silently pointing injected
// context at a wrong or stale path. Warn-only (not promoted via
// STRICT_PROMOTE_IDS): this guards against a writer bug, not confirmed-bad
// content a real YAML/type check would reject, so an existing vault carrying
// the stray field is not hard-blocked.
const TYPE_FORBIDDEN_FIELDS = {
  'session-state': ['working_dir', 'project'],
};

const TYPE_ENUM_FIELDS = {
  prd: { status: ['draft', 'active', 'completed', 'cancelled', 'archived'] },
  adr: { status: ['proposed', 'accepted', 'deprecated', 'superseded'] },
  'tool-eval': { status: ['adopted', 'evaluating', 'rejected'] },
  // feedback: sensitivity:private is forbidden (wiki is a
  // git-pushed public surface)
  feedback: {
    status: ['active', 'superseded', 'archived'],
    tier: ['L1', 'L2'],
    sensitivity: ['public', 'sanitized'],
    // optional failure taxonomy. The enum loop guards on `if (fm[field])`,
    // so an omitted failure_type is never validated (optional, migration-safe).
    failure_type: FAILURE_TYPE_ENUM,
  },
};

// ── page collector ────────────────────────────────────────────────────────────

// ── slug map ─────────────────────────────────────────────────────────────────

// `extraTargets` are link-target-only slugs (root *.md, sources/*) that resolve
// wikilinks but are not themselves linted — added verbatim, with NO derived
// basename/dir-relative aliases, so they can't mask an unrelated broken link.
function buildSlugMap(pages, extraTargets = []) {
  const map = new Set();
  for (const { rel } of pages) {
    const noExt = rel.replace(/\.md$/, '').replace(/\\/g, '/');
    // full slug + bare basename + dir-relative alias (drop the leading scan-dir
    // segment so the convention link [[learnings/foo]] resolves to
    // pages/learnings/foo.md). slugForms returns dirRel=null when the slug has no
    // `/` (a page directly under a scan dir has no extra segment to drop).
    const { full, bare, dirRel } = slugForms(noExt);
    map.add(full);
    map.add(bare);
    if (dirRel) map.add(dirRel);
  }
  for (const t of extraTargets) map.add(t);
  return map;
}

// Link-target-only slugs: files that are valid wikilink destinations but are
// NOT linted themselves. Root-level *.md (hot.md / log.md / hypo-guide.md /
// SCHEMA.md — special operational files whose types sit outside VALID_TYPES)
// and sources/* (immutable captured sources). Returned as verbatim slugs so
// buildSlugMap adds no derived aliases for them.
function collectLinkTargets(hypoDir, ignorePatterns = []) {
  const targets = [];
  if (existsSync(hypoDir)) {
    for (const entry of readdirSync(hypoDir)) {
      const full = join(hypoDir, entry);
      // root-level *.md FILES only (no recursion), honoring .hypoignore plus the
      // scan-only generated-artifact exclusions (isScanIgnored) like collectPagesLint
      // — otherwise an ignored root file (e.g. a secret) or a regenerable report
      // would resolve [[its-slug]] as valid, a false negative.
      if (
        extname(entry) === '.md' &&
        !entry.startsWith('.') &&
        !isScanIgnored(full, hypoDir, ignorePatterns) &&
        statSync(full).isFile()
      ) {
        targets.push(entry.replace(/\.md$/, ''));
      }
    }
  }
  // sources/*: linkable as the full 'sources/<name>' slug only — deliberately no
  // bare basename, so a stale [[name]] can't silently resolve to a source file.
  for (const { rel } of collectPagesLint(join(hypoDir, 'sources'), hypoDir, ignorePatterns)) {
    targets.push(rel.replace(/\.md$/, '').replace(/\\/g, '/'));
  }
  return targets;
}

// ── wikilink extractor ────────────────────────────────────────────────────────

// Strip regions where wikilinks are not real references:
//   - fenced code blocks (``` or ~~~ anchored to line start; markdown allows
//     up to 3 spaces of indent and pairs the same fence character)
//   - inline code spans (``...`` then `...`, so double-tick spans aren't split)
//   - HTML comments (<!-- ... -->)
// Replacement preserves newline positions so future line-aware checks still
// line up. Fences are anchored to line starts because the previous version
// matched any two backtick triples in prose, which could silently hide real
// wikilinks between them.
function stripNonWikilinkRegions(content) {
  let out = content;
  out = out.replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/^[ \t]{0,3}~~~[\s\S]*?^[ \t]{0,3}~~~/gm, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/``[^`\n]*``/g, (m) => ' '.repeat(m.length));
  out = out.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
  return out;
}

function extractWikilinks(content) {
  const stripped = stripNonWikilinkRegions(content);
  const links = [];
  // Target capture excludes `\` and stops before an optional `\` preceding the
  // alias/anchor delimiter, so a markdown-table-escaped alias
  // `[[a/b\|label]]` (the `\|` is a literal pipe inside a table cell) yields the
  // clean target `a/b`, not `a/b\`. A bare `[[a\]]` (no delimiter) simply fails
  // to match rather than being mis-read as `[[a]]`.
  for (const m of stripped.matchAll(/\[\[([^\]|#\\]+?)(?:\\?[|#][^\]]*?)?\]\]/g)) {
    links.push(m[1].trim());
  }
  return links;
}

// ── lint checks ───────────────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['title', 'type'];
const VALID_TYPES = [
  'concept',
  'source-summary',
  'entity',
  'tool-eval',
  'prompt-pattern',
  'playbook',
  'learning',
  'tip',
  'feedback',
  'reference',
  'synthesis',
  'weekly-journal',
  'prd',
  'adr',
  'session-log',
  'session-state',
  'project-index',
  'postmortem',
  'open-questions',
  'schema',
  'source',
];

const issues = [];

// Stable warning class IDs (W1..Wn). `--strict` promotes a frozen subset to
// errors by ID — never by brittle message-text matching. W8 (design-history
// stale) predates this scheme; hooks/hypo-personal-check.mjs filters `w.id ===
// 'W8'`, so it must keep that number — the W5..W7 gap is honest history, not a
// bug. (spec-v1.3.0 Track E)
//
// STRICT_PROMOTE_IDS (OQ-E1, frozen as a code constant): confirmed content
// defects only.
//   W1 no-frontmatter / W2 unknown-type / W4 broken-wikilink → promote.
//   W9 invalid-YAML → promote (frontmatter a real YAML parser rejects).
//   W3 missing-updated  → excluded (auto-repaired by --fix).
//   W8 design-history-stale → excluded (hypo-personal-check handles it; would
//                             double-gate).
// NOTE: no gate currently passes --strict (npm run lint / CI / release.yml /
// crystallize / the close-gate all run plain lint), so promotion is
// forward-looking: these surface as warnings today. The deliverable is
// "stop silently green-passing invalid YAML"; the W9 warning satisfies that.
const STRICT_PROMOTE_IDS = new Set(['W1', 'W2', 'W4', 'W9']);

function issue(severity, rel, msg, fullPath = null, id = null) {
  issues.push({ severity, file: rel, message: msg, path: fullPath, id });
}

function hasHeading(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^##\\s+${escaped}\\s*$`, 'm').test(content);
}

function lintSessionStateHeadings(content, rel) {
  if (!rel.match(/^projects\/[^/]+\/session-state\.md$/)) return;

  if (!SESSION_STATE_NEXT_HEADINGS.some((heading) => hasHeading(content, heading))) {
    issue(
      'error',
      rel,
      `Missing required session-state heading: one of ${SESSION_STATE_NEXT_HEADINGS.map((h) => `## ${h}`).join(', ')}`,
    );
  }
}

function lintPage({ path, rel }, slugMap, tagVocab, pageDirs, validTypes) {
  // Directory whitelist: a content page under pages/<subdir>/ must live in a
  // SCHEMA-defined directory. Catches typo'd dirs (e.g. pages/learning/ vs the
  // canonical pages/learnings/) regardless of frontmatter, since a directory
  // absent from SCHEMA breaks wikilink resolution and crystallize routing.
  // `_`-prefixed files (e.g. pages/observability/_index.md) are scaffold/section
  // markers, not content — exempt them so packaged scaffold dirs that aren't a
  // page *type* (e.g. observability, a topical grouping of reference pages) don't
  // trip the guard. A real typo dir is created with content, not just an index.
  // Skipped entirely when pageDirs is empty (SCHEMA.md or the table absent) for
  // back-compat with minimal wikis — mirrors the tag-vocab check.
  if (pageDirs && pageDirs.size > 0 && !basename(rel).startsWith('_')) {
    const segs = rel.replace(/\\/g, '/').split('/');
    if (segs[0] === 'pages' && segs.length > 2 && !pageDirs.has(segs[1])) {
      issue(
        'error',
        rel,
        `Undefined pages/ directory: "pages/${segs[1]}/" not in SCHEMA.md (likely a typo — defined: ${[...pageDirs].sort().join(', ')})`,
      );
    }
  }

  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return;
  }

  if (!content.match(/^---\r?\n/)) {
    issue('warn', rel, 'No frontmatter found', null, 'W1');
    return;
  }

  // W9: invalid-YAML frontmatter the lenient line-scanner would otherwise pass
  // green. Runs on the raw `---` block (the `content.match` above guarantees an
  // opening fence; an unclosed fence falls through to the W3/parse path below).
  const fmBlock = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmBlock) {
    for (const reason of checkYamlInvalid(fmBlock[1])) {
      issue('warn', rel, `Invalid YAML frontmatter: ${reason}`, null, 'W9');
    }
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    issue('error', rel, 'Malformed frontmatter (unclosed ---)');
    return;
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fm[field]) issue('error', rel, `Missing required frontmatter field: ${field}`);
  }

  if (fm.type && !validTypes.has(fm.type)) {
    issue('warn', rel, `Unknown type: "${fm.type}"`, null, 'W2');
  }

  if (!fm.updated) {
    issue('warn', rel, 'Missing frontmatter field: updated', path, 'W3');
  }

  // type-conditional required fields
  if (fm.type && TYPE_CONDITIONAL_FIELDS[fm.type]) {
    for (const field of TYPE_CONDITIONAL_FIELDS[fm.type]) {
      if (!fm[field]) {
        issue('error', rel, `Missing required field for type "${fm.type}": ${field}`);
      }
    }
  }

  // type-conditional forbidden fields (W11): a field valid only on a
  // DIFFERENT type planted here by an unvalidated writer. Object.hasOwn
  // (not `fm[field]`) so a present-but-empty `working_dir:` still flags —
  // the bug is the key's presence, not its value.
  if (fm.type && TYPE_FORBIDDEN_FIELDS[fm.type]) {
    for (const field of TYPE_FORBIDDEN_FIELDS[fm.type]) {
      if (Object.hasOwn(fm, field)) {
        issue(
          'warn',
          rel,
          `Forbidden frontmatter field for type "${fm.type}": "${field}" (only valid on project-index)`,
          null,
          'W11',
        );
      }
    }
  }

  // type-specific enum validation
  if (fm.type && TYPE_ENUM_FIELDS[fm.type]) {
    for (const [field, allowed] of Object.entries(TYPE_ENUM_FIELDS[fm.type])) {
      if (fm[field] && !allowed.includes(fm[field])) {
        issue(
          'error',
          rel,
          `Invalid value for ${field} on type "${fm.type}": "${fm[field]}" (allowed: ${allowed.join(', ')})`,
        );
      }
    }
  }

  // feedback: scope vocabulary + conditional claude-learned fields
  if (fm.type === 'feedback') {
    const scope = fm.scope || '';
    if (scope && !FEEDBACK_SCOPE_RE.test(scope)) {
      issue(
        'error',
        rel,
        `Invalid feedback scope: "${scope}" (allowed: global | project:<project-id>)`,
      );
    }
    const fbTargets = parseTagsField(fm.targets) || [];
    if (fbTargets.includes('claude-learned')) {
      for (const field of ['global_summary', 'promote_to_global']) {
        if (!fm[field]) {
          issue(
            'error',
            rel,
            `Missing required field for feedback with targets:claude-learned: ${field}`,
          );
        }
      }
    }
  }

  // tag vocabulary + forbidden patterns
  const tags = parseTagsField(fm.tags);
  if (tags && tagVocab && tagVocab.size > 0) {
    for (const tag of tags) {
      const forbidden = checkForbidden(tag);
      if (forbidden) {
        issue('error', rel, `Forbidden tag pattern (${forbidden}): "${tag}"`);
        continue;
      }
      if (!tagVocab.has(tag)) {
        // W10 (B-4): an unknown but non-forbidden tag is a WARNING, not a hard
        // error — a session close must never stall on a vocabulary gap. The
        // crystallize apply path parses these warns (by this exact message
        // string — load-bearing, see scripts/crystallize.mjs auto-register block)
        // and registers them into SCHEMA.md's `### Pending` section, so the next
        // lint sees them as known. W10 is intentionally NOT in STRICT_PROMOTE_IDS:
        // an unregistered tag is a vocabulary lag, not a content defect, so even
        // `--strict` keeps it a warning (it only surfaces the id in --json output).
        issue('warn', rel, `Unknown tag: "${tag}" (not in SCHEMA.md Tag Vocabulary)`, null, 'W10');
      }
    }
  }

  lintSessionStateHeadings(content, rel);

  for (const link of extractWikilinks(content)) {
    if (!slugMap.has(link)) {
      issue('warn', rel, `Broken wikilink: [[${link}]]`, null, 'W4');
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
// Only validate the auto-resolved path (env/marker/default). An explicit
// --hypo-dir=<path> (tests, other tooling) is trusted as-is, valid or not.
if (args.hypoDirSource) checkVaultOrExit(args.hypoDir, args.hypoDirSource);

const ignorePatterns = loadHypoIgnore(args.hypoDir);
const scanDirs = ['pages', 'projects', 'journal'].map((d) => join(args.hypoDir, d));
const pages = scanDirs.flatMap((d) => collectPagesLint(d, args.hypoDir, ignorePatterns));
// Pages under `_`-prefixed dirs are deliberately not linted, but they are real
// files and a link to one is not broken. Catalog them as link targets only, as
// verbatim full slugs (extraTargets gets no derived aliases — a bare `spec` from
// every `_specs/<name>/spec.md` would mask unrelated broken links).
const lintedRels = new Set(pages.map((p) => p.rel));
const underscoreDirTargets = scanDirs
  .flatMap((d) => collectPagesLinkable(d, args.hypoDir, ignorePatterns))
  .filter((p) => !lintedRels.has(p.rel))
  .map((p) => p.rel.replace(/\.md$/, '').replace(/\\/g, '/'));
const linkTargets = collectLinkTargets(args.hypoDir, ignorePatterns);
const slugMap = buildSlugMap(pages, [...linkTargets, ...underscoreDirTargets]);
const tagVocab = parseSchemaVocab(args.hypoDir);
const pageDirs = parseSchemaPageDirs(args.hypoDir);
// Accepted page types = hardcoded core ∪ the vault SCHEMA's taxonomy. Union (not
// replace) so core types lint specially handles (session-state, source, …) are
// never lost when a vault's SCHEMA omits or predates them, while a vault-local
// extension (working-doc / draft / qa-run) is honored without editing lint —
// mirroring how tags and page dirs are SCHEMA-derived.
const validTypes = new Set([...VALID_TYPES, ...parseSchemaTypes(args.hypoDir)]);

for (const page of pages) lintPage(page, slugMap, tagVocab, pageDirs, validTypes);

// W8: design-history.md stale relative to session-log.md. Emitted once per
// project (not per page) — runs outside the page loop. POSIX-separated path
// literal (not path.join) so consumers can rely on `file.split('/')` shape
// regardless of host OS — `hooks/hypo-personal-check.mjs:246` depends on this.
for (const s of findDesignHistoryStale(args.hypoDir)) {
  const gap = s.diffDays != null ? ` (${s.diffDays}일 차이)` : '';
  issue(
    'warn',
    `projects/${s.project}/design-history.md`,
    `design-history stale: session-log 설계-관련 최신=${s.lastSession} > design-history 최신=${s.lastDesignHistory}${gap} — projects/${s.project}/design-history.md에 설계 변경 사항을 append 하거나, 무-설계 세션이면 session-log 엔트리에 "ADR 없음" 마커를 명시하세요`,
    null,
    'W8',
  );
}

if (args.fix) {
  const today = new Date().toISOString().slice(0, 10);
  const fixed = new Set();
  for (const iss of issues) {
    if (
      iss.severity === 'warn' &&
      iss.message === 'Missing frontmatter field: updated' &&
      iss.path
    ) {
      const content = readFileSync(iss.path, 'utf-8');
      const fmMatch = /^---\r?\n[\s\S]*?\r?\n---/.exec(content);
      if (fmMatch) {
        const lineEnding = fmMatch[0].includes('\r\n') ? '\r\n' : '\n';
        const closingTag = `${lineEnding}---`;
        const insertAt = fmMatch.index + fmMatch[0].lastIndexOf(closingTag);
        if (insertAt < 0) continue;
        const fixedContent =
          content.slice(0, insertAt) + `${lineEnding}updated: ${today}` + content.slice(insertAt);
        writeFileSync(iss.path, fixedContent);
        fixed.add(iss.path);
      }
    }
  }
  if (fixed.size > 0) {
    issues.splice(
      0,
      issues.length,
      ...issues.filter(
        (i) =>
          !(
            i.severity === 'warn' &&
            i.message === 'Missing frontmatter field: updated' &&
            fixed.has(i.path)
          ),
      ),
    );
  }
}

// --strict: promote selected warnings (by stable ID) to errors *before* the
// errors/warns split, so exit code, counts, plain-text icons, and --json `ok`
// all derive from the post-promotion severities through the existing paths.
if (args.strict) {
  for (const iss of issues) {
    if (iss.severity === 'warn' && iss.id && STRICT_PROMOTE_IDS.has(iss.id)) {
      iss.severity = 'error';
    }
  }
}

const errors = issues.filter((i) => i.severity === 'error');
const warns = issues.filter((i) => i.severity === 'warn');

if (args.json) {
  // Default mode is byte-identical: only W8 carries an `id` in the JSON payload
  // (hooks/hypo-personal-check.mjs filters on it). All other IDs stay internal
  // unless `--strict` is set, where the full ID set is exposed so promoted
  // findings are traceable to their warning class.
  const toOut = ({ severity, file, message, id }) =>
    id && (id === 'W8' || args.strict)
      ? { severity, file, message, id }
      : { severity, file, message };
  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        errors: errors.map(toOut),
        warns: warns.map(toOut),
        total: issues.length,
      },
      null,
      2,
    ),
  );
} else {
  if (issues.length === 0) {
    console.log('✓ No lint issues found');
  } else {
    for (const { severity, file, message } of issues) {
      const icon = severity === 'error' ? '✗' : '⚠';
      console.log(`${icon} ${file}: ${message}`);
    }
    console.log(`\n${errors.length} error(s), ${warns.length} warning(s)`);
  }
}

// Set exitCode and let Node exit naturally rather than calling process.exit():
// when stdout is a pipe, the JSON write above is async, and a synchronous
// process.exit() tears the process down before the OS pipe buffer (64 KiB) is
// drained — truncating large `--json` output mid-string. Consumers that spawn
// this script and JSON.parse the stdout (crystallize's runLint, the PreCompact
// gate) then crash on the partial output. There are no pending async handles
// here (pure synchronous fs), so the event loop empties at end-of-script and
// Node flushes stdout fully before exiting with this code.
process.exitCode = errors.length > 0 ? 1 : 0;
