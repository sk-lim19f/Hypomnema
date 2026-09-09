#!/usr/bin/env node
// check-release-vehicle.mjs — report what the next release is allowed to be.
//
// Semver decides the version from the change kind, but nothing in this repo was
// watching for the moment that decision gets taken away. A `feat` merged onto
// main means the next release cannot be a patch. Twice that happened and the
// patch shipped anyway (v1.7.1 carried 5 feat commits, v1.7.4 carried 1), and
// once the patch line just stalled, which is what lanes.md predicted.
//
// This is a NOTICE, not a gate. It exits 0 either way. The point is that the
// moment is visible while a PR is still open, so the maintainer can cut the
// pending patch first if that is what they want. Making it a hard failure would
// block every feat PR until a release happened, which is a worse trade than
// letting a human read one line.
//
// Usage:
//   node scripts/check-release-vehicle.mjs           # human-readable notice
//   node scripts/check-release-vehicle.mjs --json    # machine-readable
//   node scripts/check-release-vehicle.mjs --github  # also emit ::warning::
//
// Exit 0 always, including when it cannot tell (no tags, shallow clone). A
// checker that cannot see the history says so rather than reporting "patch is
// fine", because that answer is indistinguishable from the real one and would
// be wrong exactly when it matters.

import { spawnSync } from 'child_process';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const forGithub = args.includes('--github');

function git(...a) {
  const r = spawnSync('git', a, { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// A shallow clone has no tags and a truncated log, so both lookups below fail
// the same way. Report that as 'unknown' rather than guessing.
const lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
const shallow = git('rev-parse', '--is-shallow-repository') === 'true';

let result;
if (shallow || !lastTag) {
  result = {
    determined: false,
    reason: shallow ? 'shallow-clone' : 'no-release-tag',
    lastTag,
    minimumBump: null,
    feats: [],
    commitCount: 0,
  };
} else {
  const log = git('log', '--format=%s', `${lastTag}..HEAD`) || '';
  const subjects = log.split('\n').filter((s) => s.trim());
  // Conventional Commits: `feat:` and `feat(scope):` both mean a new user
  // surface. `feat!:` / `BREAKING CHANGE` would mean major, but this repo has
  // never cut one, so it is not special-cased; a human reads the notice anyway.
  const feats = subjects.filter((s) => /^feat(\([^)]*\))?!?:/.test(s));
  result = {
    determined: true,
    reason: null,
    lastTag,
    minimumBump: feats.length > 0 ? 'minor' : 'patch',
    feats,
    commitCount: subjects.length,
  };
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else if (!result.determined) {
  console.log(
    `[check-release-vehicle] cannot tell (${result.reason}). ` +
      `Run in a full clone with tags to get an answer.`,
  );
} else if (result.minimumBump === 'minor') {
  const lines = [
    `[check-release-vehicle] the next release must be at least a MINOR.`,
    `  ${result.feats.length} feat commit(s) since ${result.lastTag}, out of ${result.commitCount}:`,
    ...result.feats.map((s) => `    ${s}`),
    `  A patch release cannot carry these. If a patch line is pending, cut it`,
    `  before merging more feat work, or accept that the pending fixes ship`,
    `  in the minor.`,
  ];
  console.log(lines.join('\n'));
} else {
  console.log(
    `[check-release-vehicle] OK: ${result.commitCount} commit(s) since ${result.lastTag}, ` +
      `no feat. A patch release is still available.`,
  );
}

if (forGithub && result.determined && result.minimumBump === 'minor') {
  const names = result.feats.join('; ').replace(/[\r\n]+/g, ' ');
  console.log(
    `::warning title=Next release must be minor::` +
      `${result.feats.length} feat commit(s) since ${result.lastTag}: ${names}`,
  );
}
