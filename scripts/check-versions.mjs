#!/usr/bin/env node
// check-versions.mjs — assert every version-carrying file in the repo agrees, and
// (with --tag) that they all match the release tag. This makes the release pipeline
// OWN the plugin channel: a forgotten plugin.json / marketplace.json / hypo-config /
// lockfile bump hard-fails the release instead of publishing a split-version plugin.
//
// The set mirrors scripts/bump-version.mjs (package.json, .claude-plugin/plugin.json,
// .claude-plugin/marketplace.json, templates/hypo-config.md) PLUS package-lock.json,
// which npm — not bump-version — manages, so it can lag a bump and silently break
// `npm ci`. CHANGELOG carries prose version HISTORY (every past vX.Y.Z), not a
// single release authority, so it is intentionally excluded (covered by the
// bilingual checklist instead). The READMEs describe current behavior and carry
// no version at all, so there is nothing here for them to agree with.
//
// Usage:
//   node scripts/check-versions.mjs               # assert all files agree
//   node scripts/check-versions.mjs --tag v1.4.0  # also assert they equal the tag
//   node scripts/check-versions.mjs --root <dir>  # point at a fixture (tests)
//   node scripts/check-versions.mjs --json
//
// Exit 0 = consistent (and, with --tag, matches). Exit 1 = drift / unreadable / mismatch.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function parseArgs(argv) {
  const args = { root: null, tag: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--root=')) args.root = a.slice(7);
    else if (a === '--root') args.root = argv[++i];
    else if (a.startsWith('--tag=')) args.tag = a.slice(6);
    else if (a === '--tag') args.tag = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(abs) {
  return JSON.parse(readFileSync(abs, 'utf-8'));
}

// Collect {label, version} for every authoritative location. A location that
// cannot be read or whose field is missing becomes {label, version: null, error}.
function collectVersions(root) {
  const sources = [];
  const push = (label, fn) => {
    try {
      const v = fn();
      if (typeof v !== 'string' || v.length === 0) {
        sources.push({ label, version: null, error: 'version field missing or empty' });
      } else {
        sources.push({ label, version: v });
      }
    } catch (err) {
      sources.push({ label, version: null, error: err?.message ?? String(err) });
    }
  };

  push('package.json', () => readJson(join(root, 'package.json')).version);

  // package-lock.json carries the version in TWO top-level spots (lockfileVersion 3):
  // the root `.version` and `.packages[""].version`. Dependency versions deeper in
  // the tree are NOT release authorities and must not be read.
  push('package-lock.json (root)', () => readJson(join(root, 'package-lock.json')).version);
  push('package-lock.json (packages[""])', () => {
    const lock = readJson(join(root, 'package-lock.json'));
    return lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;
  });

  const pluginName = (() => {
    try {
      return readJson(join(root, '.claude-plugin', 'plugin.json')).name;
    } catch {
      return null;
    }
  })();

  push(
    '.claude-plugin/plugin.json',
    () => readJson(join(root, '.claude-plugin', 'plugin.json')).version,
  );

  // Select the marketplace entry BY NAME (matching plugin.json), not by position:
  // Claude Code's runtime resolves plugins by name (hooks/version-check.mjs), and a
  // future second marketplace entry would make plugins[0] the wrong authority.
  push('.claude-plugin/marketplace.json (entry: ' + (pluginName ?? '?') + ')', () => {
    const mp = readJson(join(root, '.claude-plugin', 'marketplace.json'));
    const plugins = Array.isArray(mp.plugins) ? mp.plugins : [];
    if (!pluginName)
      throw new Error('plugin.json name unreadable — cannot match marketplace entry');
    const matches = plugins.filter((p) => p && p.name === pluginName);
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one marketplace entry named "${pluginName}", found ${matches.length}`,
      );
    }
    return matches[0].version;
  });

  // hypo-config.md frontmatter: version: "X.Y.Z"
  push('templates/hypo-config.md', () => {
    const text = readFileSync(join(root, 'templates', 'hypo-config.md'), 'utf-8');
    const m = text.match(/^version:\s*"?([^"\n]+)"?/m);
    return m ? m[1].trim() : undefined;
  });

  return sources;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root || REPO_ROOT;
  const sources = collectVersions(root);

  const errored = sources.filter((s) => s.error);
  const versions = [...new Set(sources.filter((s) => s.version).map((s) => s.version))];

  // Normalize the tag by stripping exactly one leading `v` (release tags are vX.Y.Z,
  // file versions are X.Y.Z). Track tag PRESENCE separately from the normalized
  // value: a bare `v` (or any tag that normalizes to empty / non-semver) must HARD
  // FAIL, not be mistaken for "no tag supplied" — otherwise a `git tag v` push would
  // bypass the release gate. This preserves the old "Validate tag matches package
  // version" guarantee while widening it to every channel.
  const hasTag = args.tag != null;
  const tagVersion = hasTag ? args.tag.replace(/^v/, '') : null;
  const tagValid = hasTag && /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(tagVersion);

  const consistent = errored.length === 0 && versions.length === 1;
  const tagOk = !hasTag || (tagValid && consistent && versions[0] === tagVersion);
  const ok = consistent && tagOk;

  if (args.json) {
    console.log(
      JSON.stringify(
        { ok, consistent, hasTag, tagVersion, tagValid, distinctVersions: versions, sources },
        null,
        2,
      ),
    );
  } else {
    const width = Math.max(...sources.map((s) => s.label.length));
    for (const s of sources) {
      const val = s.error ? `ERROR: ${s.error}` : s.version;
      console.log(`  ${s.label.padEnd(width)}  ${val}`);
    }
    if (errored.length) {
      console.error(`\n✗ ${errored.length} version source(s) unreadable.`);
    } else if (!consistent) {
      console.error(
        `\n✗ version drift — ${versions.length} distinct versions: ${versions.join(', ')}`,
      );
    } else if (hasTag && !tagValid) {
      console.error(`\n✗ tag "${args.tag}" does not normalize to a valid semver version`);
    } else if (!tagOk) {
      console.error(
        `\n✗ tag ${args.tag} (→ ${tagVersion}) does not match the file version ${versions[0]}`,
      );
    } else {
      console.log(
        `\n✓ all version-carrying files agree on ${versions[0]}${tagVersion ? ` (matches tag ${args.tag})` : ''}`,
      );
    }
  }

  process.exit(ok ? 0 : 1);
}

main();
