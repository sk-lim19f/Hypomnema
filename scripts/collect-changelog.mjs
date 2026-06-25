#!/usr/bin/env node
// collect-changelog.mjs: semi-automatic changelog collector.
//
// Walks a git range, classifies each merged PR into a CHANGELOG section
// (offline, from commit messages, reusing scripts/lib/changelog-classify.mjs),
// and pulls each PR's `## Changelog` block body + author @handle from the GitHub
// API (`gh`). It PRINTS a draft section to stdout; it never edits CHANGELOG.md.
// The maintainer pastes the draft, writes Highlights, and finalizes the wording
// (the semi-automatic / hybrid flow in docs/CONTRIBUTING.md).
//
// Responsibility split (plan.md §1): classification is OFFLINE and authoritative
// (deterministic, no network). Exact @handle and the `## Changelog` body come
// from `gh`. Nothing is silently skipped: a missing block, a malformed block, a
// gh failure, or a commit with no PR is surfaced (warn) or fails the run
// (--strict).
//
// Usage:
//   node scripts/collect-changelog.mjs [--range <git-range>] [--strict]
//                                      [--no-api] [--json] [--help]
//   --range   git range to collect, default `<last-tag>..HEAD`
//             (last tag via `git describe --tags --abbrev=0`).
//   --strict  hard-fail (exit 1) on any defect: a commit with no PR, a gh API
//             failure, a missing/malformed `## Changelog` block, or a fallback
//             classification. For release automation.
//   --no-api  offline only: classify + commit author, no `gh`. @handle and block
//             bodies are left as manual TODOs. `--strict --no-api` is rejected
//             (strict cannot prove handles/bodies without the API).
//   --json    emit the structured result instead of markdown.
//   --help    this text.
//
// Exit codes: 0 ok (warn mode tolerates defects) · 1 strict-mode defect ·
//   2 usage error / empty range / no tags.
//
// Edge cases:
// - gh rate limit (60/hr unauthenticated) and an unauthenticated/absent gh are
//   reported as API failures (fail-loud), not silently dropped.
// - fork PRs: `author.login` still resolves via the API.
// - co-author trailers are ignored for Contributors (PR author only, format §7).
// - squash-merge subject `(#N)` vs merge-commit `Merge pull request #N`: both are
//   handled; `git log --first-parent` keeps a merge PR as one entry rather than
//   exposing its inner commits as PR-less.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChange, SECTION_TITLE } from './lib/changelog-classify.mjs';
import {
  parsePrNumber,
  isMergeBoilerplate,
  parseChangelogBlock,
  assembleSections,
  renderDraft,
} from './lib/collect-changelog.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FS = '\x1f'; // field separator
const RS = '\x1e'; // record separator

function parseArgs(argv) {
  const args = { range: null, strict: false, noApi: false, json: false, help: false, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--no-api') args.noApi = true;
    else if (a === '--json') args.json = true;
    else if (a === '--range') args.range = argv[++i];
    else if (a.startsWith('--range=')) args.range = a.slice('--range='.length);
    else if (a === '--repo') args.repo = argv[++i];
    else if (a.startsWith('--repo=')) args.repo = a.slice('--repo='.length);
    else {
      process.stderr.write(`[collect-changelog] unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

const USAGE = `collect-changelog: draft a CHANGELOG section from merged PRs in a git range.

Usage:
  node scripts/collect-changelog.mjs [--range <git-range>] [--strict] [--no-api] [--json] [--help]

  --range   git range, default <last-tag>..HEAD
  --strict  exit 1 on any defect (no PR, gh failure, missing/malformed block, fallback class)
  --no-api  offline only (no gh); @handle + block bodies become manual TODOs. --strict --no-api is rejected.
  --json    structured output instead of markdown
  --repo    git repo dir to read (default: this package); used by tests
  --help    this text

Prints a draft to stdout; never edits CHANGELOG.md.`;

function git(args, cwd = REPO_ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

// Fetch a PR's author login + body via gh. Returns { ok, handle, body } or
// { ok: false, reason }.
function ghPrView(pr, cwd = REPO_ROOT) {
  const res = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'author,body'], {
    cwd,
    encoding: 'utf-8',
  });
  if (res.error) {
    return {
      ok: false,
      reason: res.error.code === 'ENOENT' ? 'gh not installed' : String(res.error.message),
    };
  }
  if (res.status !== 0) {
    const err = (res.stderr || '').trim().split('\n')[0] || `gh exited ${res.status}`;
    return { ok: false, reason: err };
  }
  try {
    const data = JSON.parse(res.stdout || '{}');
    return {
      ok: true,
      handle: data.author && data.author.login ? data.author.login : null,
      body: data.body || '',
    };
  } catch (e) {
    return { ok: false, reason: `unparseable gh JSON: ${e.message}` };
  }
}

function resolveRange(args, cwd) {
  if (args.range) return args.range;
  const tag = git(['describe', '--tags', '--abbrev=0'], cwd);
  if (tag.status !== 0 || !tag.stdout.trim()) {
    process.stderr.write('[collect-changelog] no tags found; pass --range explicitly.\n');
    process.exit(2);
  }
  return `${tag.stdout.trim()}..HEAD`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (args.strict && args.noApi) {
    process.stderr.write(
      '[collect-changelog] --strict --no-api is rejected: strict cannot verify @handle or block bodies without the API.\n',
    );
    return 2;
  }

  const repo = args.repo || REPO_ROOT;
  const range = resolveRange(args, repo);
  // --first-parent collapses each merge PR to one entry instead of exposing its
  // inner commits as PR-less.
  const log = git(['log', '--first-parent', `--format=%H${FS}%s${FS}%an${FS}%b${RS}`, range], repo);
  if (log.status !== 0) {
    process.stderr.write(
      `[collect-changelog] git log failed for range "${range}": ${(log.stderr || '').trim()}\n`,
    );
    return 2;
  }
  const records = log.stdout
    .split(RS)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.trim());
  if (records.length === 0) {
    process.stderr.write(`[collect-changelog] empty range "${range}": no commits to collect.\n`);
    return 2;
  }

  const defects = {
    directPush: [],
    apiErrors: [],
    missingBlocks: [],
    malformedBlocks: [],
    fallback: [],
  };
  const entries = [];

  for (const rec of records) {
    const [hash, subject, author, ...rest] = rec.split(FS);
    const bodyText = rest.join(FS) || '';
    const pr = parsePrNumber(subject);

    // Classification: offline + authoritative. For a merge-commit boilerplate
    // subject, classify from the PR title carried in the body's first line.
    const classifySource = isMergeBoilerplate(subject)
      ? bodyText.split('\n').find((l) => l.trim()) || subject
      : subject;
    const { section, basis } = classifyChange(classifySource);
    if (basis === 'fallback') defects.fallback.push({ hash, subject });

    if (pr == null) {
      defects.directPush.push({ hash, subject, author });
    }

    let handle = null;
    let block = null;
    if (!args.noApi && pr != null) {
      const view = ghPrView(pr, repo);
      if (!view.ok) {
        defects.apiErrors.push({ pr, reason: view.reason });
      } else {
        handle = view.handle;
        block = parseChangelogBlock(view.body);
        if (block == null) defects.missingBlocks.push({ pr });
        else if (block && typeof block === 'object' && block.malformed) {
          defects.malformedBlocks.push({ pr, reason: block.reason });
          block = null;
        }
      }
    }

    // titleSource feeds the ### Changelog index title: the same source used for
    // classification, so a merge commit is indexed by its PR title (from the
    // body), never by its `Merge pull request #N from ...` boilerplate subject.
    entries.push({
      pr,
      subject,
      titleSource: classifySource,
      section,
      basis,
      author,
      handle,
      block,
    });
  }

  const assembled = assembleSections(entries);

  // Warnings (always emitted to stderr; never silent).
  const warn = (msg) => process.stderr.write(`[collect-changelog] ${msg}\n`);
  if (args.noApi)
    warn('--no-api: @handle and block bodies are manual; fill them in the draft before release.');
  for (const d of defects.directPush)
    warn(`commit with no PR: ${d.hash.slice(0, 9)} "${d.subject}" by ${d.author}`);
  for (const d of defects.apiErrors) warn(`gh API failed for #${d.pr}: ${d.reason}`);
  for (const d of defects.missingBlocks)
    warn(`PR #${d.pr} has no ## Changelog block (fill it manually).`);
  for (const d of defects.malformedBlocks)
    warn(`PR #${d.pr} ## Changelog block malformed: ${d.reason}`);
  for (const d of defects.fallback)
    warn(`classification fell back to Chores (no type/id/heading hint): "${d.subject}"`);

  if (args.json) {
    process.stdout.write(JSON.stringify({ range, entries, assembled, defects }, null, 2) + '\n');
  } else {
    // A manual TODO header so a draft with unresolved gaps is never mistaken for
    // complete. Direct-push commits get an explicit TODO comment, not a fake #N.
    const todos = [];
    for (const d of defects.directPush)
      todos.push(
        `<!-- TODO: direct push ${d.hash.slice(0, 9)} "${d.subject}" by ${d.author}, no PR -->`,
      );
    for (const d of defects.missingBlocks)
      todos.push(`<!-- TODO: PR #${d.pr} needs a ## Changelog block -->`);
    for (const d of defects.malformedBlocks)
      todos.push(`<!-- TODO: PR #${d.pr} ## Changelog block malformed (${d.reason}) -->`);
    const draft = renderDraft(assembled);
    process.stdout.write((todos.length ? todos.join('\n') + '\n\n' : '') + draft);
  }

  const hasDefect =
    defects.directPush.length ||
    defects.apiErrors.length ||
    defects.missingBlocks.length ||
    defects.malformedBlocks.length ||
    defects.fallback.length;
  if (args.strict && hasDefect) {
    warn('strict mode: defects above must be resolved before release.');
    return 1;
  }
  return 0;
}

process.exit(main());
