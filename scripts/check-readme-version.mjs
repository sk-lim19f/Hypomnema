#!/usr/bin/env node
// check-readme-version.mjs — assert the release version string is present in BOTH
// README.md and README.ko.md. This is the machine FLOOR for the README-reconcile
// step that was dropped three times (v1.2 / v1.3.0 / v1.3.1): a publish of vX.Y.Z
// must not go out unless vX.Y.Z is written into both READMEs' version narrative.
//
// SCOPE (honest): this catches the GROSS drop — shipping a version whose sentence
// was never added to the README at all. It does NOT verify the narrative is
// accurate or that the first-viewport "current release" pointer was updated; that
// stays a judgment step owned by the release checklist (docs/CONTRIBUTING.md
// "Cutting a release"). README/CHANGELOG carry
// prose version HISTORY (every past vX.Y.Z), so check-versions.mjs intentionally
// excludes them — this script is their complement, not a duplicate.
//
// Usage:
//   node scripts/check-readme-version.mjs                 # version from package.json
//   node scripts/check-readme-version.mjs --version 1.4.0 # explicit version
//   node scripts/check-readme-version.mjs --root <dir>    # point at a fixture (tests)
//   node scripts/check-readme-version.mjs --json
//
// Exit 0 = both READMEs mention the version. Exit 1 = missing in one/both, or unreadable.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function parseArgs(argv) {
  const args = { root: null, version: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--root=')) args.root = a.slice(7);
    else if (a === '--root') args.root = argv[++i];
    else if (a.startsWith('--version=')) args.version = a.slice(10);
    else if (a === '--version') args.version = argv[++i];
    else if (a === '--json') args.json = true;
  }
  return args;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const README_FILES = ['README.md', 'README.ko.md'];

// Build a boundary-aware matcher so a version does not spuriously match inside a
// LONGER version token yet still matches at a sentence boundary. The checked
// version must be a standalone token, NOT a prefix of another version:
//   - "1.3.40", "v11.3.4"      → reject (digit continuation)
//   - "1.3.4.5"                → reject (dot-then-digit continuation)
//   - "1.3.4-rc.1", "1.3.4+b"  → reject (a stable check must NOT pass on a
//                                 prerelease/build string — that defeats the floor)
//   - "1.3.0-rc.1a", "1.3.0-rc.10", "1.3.0-rc.1.alpha" → a prerelease check must
//                                 reject these continuation tokens too
//   - "shipped v1.3.4." / "v1.3.4**" / "(v1.3.4)" → match (sentence/markup boundary)
// Leading: no digit/dot immediately before (an optional "v" is fine — it is
// neither). Trailing: not a semver-continuation char ([0-9A-Za-z+-]) and not a
// dot-then-alphanumeric (".5" / ".alpha" continuation); a sentence period
// (dot followed by space / punctuation / end) is allowed.
function versionPresent(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${escaped}(?![\\dA-Za-z+-])(?!\\.[\\dA-Za-z])`).test(text);
}

function checkReadmeVersions(root, version) {
  const results = README_FILES.map((file) => {
    const abs = join(root, file);
    try {
      const text = readFileSync(abs, 'utf-8');
      return { file, present: versionPresent(text, version) };
    } catch (err) {
      return { file, present: false, error: err?.message ?? String(err) };
    }
  });
  const ok = results.every((r) => r.present);
  return { ok, version, results };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root || REPO_ROOT;

  let version = args.version;
  if (!version) {
    try {
      version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
    } catch (err) {
      const msg = `cannot read package.json for version: ${err?.message ?? err}`;
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(`✗ ${msg}`);
      process.exit(1);
    }
  }
  if (typeof version !== 'string' || !version) {
    const msg = 'no version (—version empty and package.json has no "version" field)';
    if (args.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`✗ ${msg}`);
    process.exit(1);
  }

  const report = checkReadmeVersions(root, version);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const r of report.results) {
      const mark = r.error ? `ERROR: ${r.error}` : r.present ? 'found' : 'MISSING';
      console.log(`  ${r.file.padEnd(13)}  ${mark}`);
    }
    if (report.ok) {
      console.log(`\n✓ both READMEs mention version ${version}`);
    } else {
      const missing = report.results
        .filter((r) => !r.present)
        .map((r) => (r.error ? `${r.file} (unreadable)` : r.file))
        .join(', ');
      console.error(
        `\n✗ version ${version} missing from: ${missing}\n` +
          `  Reconcile the version narrative in both READMEs before releasing ` +
          `(the README reconcile step — see docs/CONTRIBUTING.md "Cutting a release").`,
      );
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main();
