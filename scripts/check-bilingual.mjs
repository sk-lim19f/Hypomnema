#!/usr/bin/env node
/**
 * check-bilingual.mjs — CLI gate for the bilingual release-doc rule.
 *
 * Modes:
 *   --changelog [version]   Validate CHANGELOG.md section for given version.
 *                           Defaults to package.json's "version" field.
 *                           Wired into npm `prepublishOnly` so publishes fail
 *                           when the Korean summary is missing.
 *
 *   --tag <ref>             Validate annotated tag body for given ref.
 *                           Wired into .github/workflows/release.yml so a
 *                           lightweight tag or a missing Korean section
 *                           blocks the npm publish step.
 *
 * Exits 0 on pass, 1 on fail with a stderr diagnostic.
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { validateChangelog, validateTagBody } from './lib/check-bilingual.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const RULE_REF =
  'Rule source: CLAUDE.md learned_behaviors (release-doc-bilingual, 2026-05-24). ' +
  'OSS Hypomnema ships must carry English body + Korean summary in both CHANGELOG section and git tag annotation.';

function fail(msg) {
  process.stderr.write(`[check-bilingual] FAIL: ${msg}\n${RULE_REF}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`[check-bilingual] OK: ${msg}\n`);
  process.exit(0);
}

function usage(exitCode) {
  process.stdout.write(
    `Usage:\n` +
      `  node scripts/check-bilingual.mjs --changelog [version]\n` +
      `      Validate CHANGELOG.md "## [<version>]" section. Default version: package.json.\n` +
      `  node scripts/check-bilingual.mjs --tag <ref>\n` +
      `      Validate annotated tag body (lightweight tags are rejected).\n`,
  );
  process.exit(exitCode);
}

const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--help' || mode === '-h') usage(0);
if (!mode) usage(1);

if (mode === '--changelog') {
  let version = args[1];
  if (!version) {
    try {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
      version = pkg.version;
    } catch (err) {
      fail(`cannot read package.json: ${err.message}`);
    }
  }
  if (!version) fail('no version (arg empty, package.json has no "version" field)');

  let content;
  try {
    content = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf-8');
  } catch (err) {
    fail(`cannot read CHANGELOG.md: ${err.message}`);
  }

  const result = validateChangelog(content, version);
  if (!result.ok) fail(result.reason);
  ok(`CHANGELOG.md [${version}] — ${result.hangulCount} Hangul chars in "### 한글 요약".`);
} else if (mode === '--tag') {
  const ref = args[1];
  if (!ref) fail('--tag requires a ref argument (e.g. v1.2.1)');

  // Reject lightweight tags. `git rev-parse <ref>^{tag}` succeeds ONLY for
  // annotated tags. For lightweight tags the ^{tag} peel fails because there
  // is no tag object — the ref points straight at a commit.
  const tagObj = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{tag}`], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });
  if (tagObj.status !== 0) {
    const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf-8',
      cwd: REPO_ROOT,
    });
    if (exists.status !== 0) fail(`tag ${ref} not found`);
    fail(
      `tag ${ref} is a lightweight tag, not annotated. ` +
        `Re-create with: git tag -a ${ref} -m "<English body>\n\n---\n\n<Korean summary>"`,
    );
  }

  const tagBody = spawnSync('git', ['tag', '-l', `--format=%(contents)`, ref], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });
  if (tagBody.status !== 0) fail(`failed to read tag ${ref}: ${tagBody.stderr}`);

  const result = validateTagBody(tagBody.stdout || '');
  if (!result.ok) fail(`tag ${ref} — ${result.reason}`);
  ok(`tag ${ref} annotation — ${result.hangulCount} Hangul chars after last "---" separator.`);
} else {
  fail(`unknown mode: ${mode}. Use --changelog or --tag (see --help).`);
}
