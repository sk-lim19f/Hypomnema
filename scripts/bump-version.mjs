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
console.log(`  git add -A && git commit -m "chore(release): v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push origin <branch> --tags`);
