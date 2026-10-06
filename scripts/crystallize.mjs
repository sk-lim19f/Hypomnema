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
 *   --check-session-close    Verify the strict session-close memory files: 4 mandatory + open-questions conditional
 *   --project=<slug>         Override the recency-inferred project on --check / --mark (single segment
 *                            [A-Za-z0-9._-]+, projects/<slug>/ must exist). On --check it NARROWS the
 *                            gate to that one project: a project-scoped diagnostic, NOT a global
 *                            close verdict. On --mark it is ATTRIBUTION only; the gate stays
 *                            global (the marker gate is the global gate with the git axis narrowed). Ignored on --apply.
 *   --apply-session-close    Apply a JSON payload that updates the 4 mandatory memory files
 *                            (+ optional open-questions). Idempotent — re-running with the same
 *                            payload is a no-op. Always finishes with the strict gate check.
 *
 *                            Without --payload, runs as a cheap "already complete?" probe:
 *                            if the strict gate is ok, exits 0 with alreadyComplete:true;
 *                            otherwise exits 1 with "payload is required". Option D:
 *                            payload presence = explicit close intent → always full apply
 *                            (the per-entry idempotency keeps re-apply cheap).
 *   --payload=<path|->       Path to JSON payload (file or `-` for stdin). Required for any
 *                            apply work; omit only for the probe path above.
 *   --force                  Bypass the no-payload probe early-exit. Payload is still required
 *                            for any apply work — --force only opts out of the alreadyComplete
 *                            shortcut. Reserved for explicit diagnostics / scripted recovery.
 *   --json                   Output as JSON
 *
 * Payload schema:
 *   {
 *     "project":      "<slug>",                       // REQUIRED — single segment [A-Za-z0-9._-]+ (≥1 alnum, not dot-only), projects/<slug>/ dir must exist (B-3: no recency fallback for apply)
 *     "sessionId":    "<session id>",                 // recommended: must equal --session-id when present (null or absent skips the check)
 *     "date":         "YYYY-MM-DD",                   // optional — defaults to today (local)
 *     "summary":      "<markdown>",                   // REQUIRED: string; becomes the summary of this close's session entry
 *     "tracks":       [{ "id": "<track-id>", "title": "...", "next": "<markdown>",
 *                        "new": true, "done": true, "supersedes": ["<close id or prefix>"] }], // optional array, may be empty; title/next/new/done/supersedes optional per element, one element per track id
 *     "sessionLog":   { "entry":   "## [date] ..." }, // REQUIRED: append, skip if heading already present
 *     "log":          { "entry":   "## [date] session | <project> ..." }, // OPTIONAL (B-1): omit it and apply derives the root log.md entry from this close's sessionLog heading; supply it only for a deliberately custom log line
 *     "openQuestions":{ "content": "<full file>" }    // optional overwrite (the only overwrite left in a close)
 *   }
 *
 * A close creates ONE immutable file, projects/<slug>/sessions/<date>-<close id>.md, and
 * appends to the session-log shard and log.md. It never rewrites a project's
 * session-state.md or hot.md: those are generated views of the entries.
 * The old form (`sessionState` + `projectHot` instead of `summary` + `tracks`) is still
 * accepted and recorded as a `legacy` track; sending both forms is refused.
 *
 * Lint gates:
 *   • Preflight: runs `lint.mjs --json` BEFORE any payload byte is written.
 *     Errors in files this close is about to write itself (its own session entry,
 *     openQuestions) are filtered out: a retry may replace them, and not filtering
 *     them dead-locks the documented "fix payload and retry" recovery after a
 *     post-apply-lint failure (codex P2). Errors in the other payload files
 *     (session-log shard, log.md) → exit 1 with stage='preflight-lint', no apply
 *     occurs. The generated session-state.md / hot.md and the root hot.md are not
 *     payload files. PreCompact's hypo-personal-check is still the final enforcement.
 *   • Post-apply: runs after the writes and BEFORE the commit. Surfaces as
 *     stage='post-apply-lint'. Catches payloads that introduce a malformed body /
 *     bad frontmatter (error-level); broken wikilinks are lint W4 warnings and are not
 *     gated. A lint crash hard-fails regardless of scope. The verification that this
 *     close's entry, session-log heading and log.md line read back (stage
 *     'post-apply-verification') runs after the commit, so it never joins a lint failure.
 */

import { readFileSync, realpathSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { loadHypoIgnore } from './lib/hypo-ignore.mjs';
import { collectPagesCrystallize, extractWikilinks } from './lib/wikilink.mjs';
import { aggregateColdCandidates } from './lib/page-usage.mjs';
import { parseArgs } from './lib/crystallize-args.mjs';
import { runSessionCloseCheck } from './lib/crystallize-close-check.mjs';
import {
  runMarkSessionClosed,
  applySessionClose,
  planMarkerDecision,
  closeResultContradiction,
  ensureProjectIndex,
} from './lib/crystallize-close-apply.mjs';
import { parseFrontmatterLoose, parseTags } from './lib/crystallize-helpers.mjs';
import { scopeVisible, readVisibilityScope, currentDevice } from '../hooks/hypo-shared.mjs';

// Re-exported for tests that exercise the pure close-pipeline pieces directly
// (tests/close-global.test.mjs, tests/crystallize-apply.test.mjs) without
// spawning the CLI. Importing this module must expose EXACTLY these three
// names — see tests/close-global.test.mjs's entry-guard test.
export { planMarkerDecision, closeResultContradiction, ensureProjectIndex };

// ── main ─────────────────────────────────────────────────────────────────────

// Guard the CLI dispatch behind an entry check: the module now exports
// pure functions (planMarkerDecision / closeResultContradiction) that the test
// runner imports, and importing must NOT execute the CLI (its process.exit would
// kill the runner). Mirror feedback-sync.mjs's realpath + pathToFileURL guard so
// `node crystallize.mjs …` still runs main() while `import` does not.
function isMain() {
  if (!process.argv[1]) return false;
  return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.markSessionClosed) {
    runMarkSessionClosed(args); // exits
  }

  if (args.applySessionClose) {
    applySessionClose(args); // exits
  }

  if (args.checkSessionClose) {
    runSessionCloseCheck(args); // exits
  }

  const ignorePatterns = loadHypoIgnore(args.hypoDir);
  const pagesDir = join(args.hypoDir, 'pages');
  const pages = collectPagesCrystallize(pagesDir, args.hypoDir, ignorePatterns);

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
    if (!scopeVisible(readVisibilityScope(content), currentDevice())) continue;
    const fm = parseFrontmatterLoose(content);
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

  // Lookup-cold candidates (B): pages with inbound wikilinks that lookup has not
  // injected within the recency window. Advisory only, never gates, never mutates.
  const coldCandidates = aggregateColdCandidates(args.hypoDir, { ignorePatterns });

  if (args.json) {
    console.log(JSON.stringify({ synthesisGroups, unlinked, drafts, coldCandidates }, null, 2));
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

  // Advisory (non-gating): pages the graph treats as live but lookup has not
  // injected recently. Held until enough page-usage history accrues.
  if (coldCandidates.status === 'ok' && coldCandidates.candidates.length > 0) {
    found = true;
    console.log(
      `Lookup-cold pages (${coldCandidates.candidates.length}), inbound links but not injected recently:`,
    );
    for (const p of coldCandidates.candidates) console.log(`  [[${p.slug}]] (${p.title})`);
    console.log('');
  } else if (
    coldCandidates.status === 'insufficient-data' &&
    coldCandidates.reason === 'span-too-short'
  ) {
    // Only surface the "held" notice once a log is actually accruing (span under
    // the cold-start window). A vault with no log at all stays silent so this
    // advisory never becomes permanent noise on every crystallize run.
    console.log('Lookup-cold scan held: not enough page-usage history yet (advisory).\n');
  }

  if (!found) {
    console.log('✓ No crystallization candidates found — Hypomnema looks well-connected.');
  }
}

if (isMain()) main();
