#!/usr/bin/env node
// Sync version across package.json, .claude-plugin/plugin.json, and templates/hypo-config.md.
// Usage: node scripts/bump-version.mjs <new-version>

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const next = process.argv[2];

if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error('Usage: node scripts/bump-version.mjs <semver>');
  console.error('Example: node scripts/bump-version.mjs 1.0.0');
  process.exit(1);
}

const targets = [
  {
    path: 'package.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    path: '.claude-plugin/plugin.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    path: '.claude-plugin/marketplace.json',
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    path: 'templates/hypo-config.md',
    pattern: /(^version:\s*")([^"]+)(")/m,
  },
];

for (const { path, pattern } of targets) {
  const abs = resolve(root, path);
  const before = readFileSync(abs, 'utf-8');
  const match = before.match(pattern);
  if (!match) {
    console.error(`✗ ${path}: version pattern not found`);
    process.exit(1);
  }
  const current = match[2];
  if (current === next) {
    console.log(`= ${path} already ${next}`);
    continue;
  }
  writeFileSync(abs, before.replace(pattern, `$1${next}$3`));
  console.log(`✓ ${path}: ${current} → ${next}`);
}

console.log(`\nNext steps:`);
console.log(`  1. Edit CHANGELOG.md — ensure the "## [${next}]" section has a`);
console.log(`     "### 한글 요약" sub-section (release.yml check-bilingual gate).`);
console.log(`  2. node scripts/check-bilingual.mjs --changelog   # local pre-check`);
console.log(`  3. git add -A && git commit -m "chore(release): v${next}"`);
console.log(`  4. Create an ANNOTATED tag (lightweight tags are rejected by CI):`);
console.log(`       git tag -a v${next} -m "<English body>\\n\\n---\\n\\n<한글 요약>"`);
console.log(`     See docs/CONTRIBUTING.md "Cutting a release" for the full template.`);
console.log(`  5. node scripts/check-bilingual.mjs --tag v${next}   # local pre-check`);
console.log(`  6. git push origin <branch> --tags`);
