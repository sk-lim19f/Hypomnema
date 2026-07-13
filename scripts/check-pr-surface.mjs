#!/usr/bin/env node
/**
 * check-pr-surface.mjs — CI gate: the PR title and body are a public surface.
 *
 * The repo's other gates all read files. A PR title/body is not a file in the
 * repo, so `check:tracker-ids` has never seen one — an `ISSUE-N` in a PR title
 * sails past a green `Tracker-id gate`. This closes that hole, plus the two other
 * PR-surface rules that had no enforcement at all: tool attribution (the harness
 * prompt actively instructs the agent to add what this repo bans) and the PR
 * template (`gh pr create --body` REPLACES the body, so
 * .github/PULL_REQUEST_TEMPLATE.md never loads on the path agents use).
 *
 * All judgment lives in scripts/lib/check-pr-surface.mjs (pure, unit-tested).
 * This wrapper only does I/O.
 *
 * Modes:
 *   --title=<str> --body-file=<path>   Check an explicit title/body (local
 *                                      pre-flight before `gh pr create`).
 *   --github-event=<path>              Read pull_request.title / .body from a
 *                                      GitHub event payload. Defaults to
 *                                      $GITHUB_EVENT_PATH when neither --title
 *                                      nor --body-file is given, so CI needs no
 *                                      extra permissions: the title and body are
 *                                      already in the payload.
 *   --json                             Machine-readable output.
 *
 * Exit: 0 clean · 1 violations · 2 usage / unreadable input.
 *
 * NOTE the CI workflow must list `edited` in `on.pull_request.types`. The default
 * type set is [opened, synchronize, reopened] — WITHOUT `edited` a contributor
 * opens a clean PR, then edits the body to add an attribution footer, and no job
 * ever re-runs.
 */

import { readFileSync } from 'node:fs';
import { checkPrSurface } from './lib/check-pr-surface.mjs';

function usage(code) {
  process.stdout.write(
    'Usage:\n' +
      '  node scripts/check-pr-surface.mjs --title=<str> --body-file=<path> [--json]\n' +
      '  node scripts/check-pr-surface.mjs --github-event=<path> [--json]\n' +
      '  node scripts/check-pr-surface.mjs [--json]   (reads $GITHUB_EVENT_PATH)\n',
  );
  process.exit(code);
}

function die(msg) {
  process.stderr.write(`[check-pr-surface] ${msg}\n`);
  process.exit(2);
}

function readText(path, what) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    die(`cannot read ${what} ${path}: ${err.message}`);
  }
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);
const json = argv.includes('--json');

function flag(name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
}

const titleArg = flag('title');
const bodyFile = flag('body-file');
const eventArg = flag('github-event');

let title;
let body;

if (titleArg !== null || bodyFile !== null) {
  // Explicit mode. An empty body is a legitimate input here (and a violation),
  // so only a missing --body-file falls back to an empty string.
  title = titleArg ?? '';
  body = bodyFile !== null ? readText(bodyFile, 'body file') : '';
} else {
  const eventPath = eventArg ?? process.env.GITHUB_EVENT_PATH ?? null;
  if (!eventPath) {
    process.stderr.write(
      '[check-pr-surface] no --title/--body-file and no --github-event / $GITHUB_EVENT_PATH\n',
    );
    usage(2);
  }
  let payload;
  try {
    payload = JSON.parse(readText(eventPath, 'event payload'));
  } catch (err) {
    die(`event payload ${eventPath} is not valid JSON: ${err.message}`);
  }
  const pr = payload && payload.pull_request;
  if (!pr) {
    // Not a pull_request event (push, workflow_dispatch, ...). Nothing to gate;
    // the job's own `if:` should have prevented this, so say so and pass.
    process.stdout.write('[check-pr-surface] event carries no pull_request — nothing to check.\n');
    process.exit(0);
  }
  // GitHub sends `body: null` for an empty PR body.
  title = typeof pr.title === 'string' ? pr.title : '';
  body = typeof pr.body === 'string' ? pr.body : '';
}

const { ok, violations } = checkPrSurface({ title, body });

if (json) {
  process.stdout.write(
    JSON.stringify({ ok, count: violations.length, violations }, null, 2) + '\n',
  );
  process.exit(ok ? 0 : 1);
}

if (ok) {
  process.stdout.write('[check-pr-surface] OK: PR title and body are clean.\n');
  process.exit(0);
}

process.stderr.write(
  `[check-pr-surface] FAIL: ${violations.length} violation(s) on the PR surface:\n\n`,
);
for (const v of violations) {
  process.stderr.write(`  [${v.rule}] ${v.surface}: ${v.detail}\n`);
  // The fix is the point of the gate: a blocked agent that cannot see the way
  // through works around the gate instead of obeying the rule.
  process.stderr.write(`      fix: ${v.fix}\n\n`);
}
process.stderr.write(
  'The PR title and body are a public surface: no wiki-internal tracker ids, no tool\n' +
    'attribution, and the body follows .github/PULL_REQUEST_TEMPLATE.md (both language\n' +
    'blocks + Changelog + Checklist). Re-run this check locally before pushing:\n' +
    '  node scripts/check-pr-surface.mjs --title="$(gh pr view <N> --json title -q .title)" \\\n' +
    '    --body-file=<file>\n',
);
process.exit(1);
