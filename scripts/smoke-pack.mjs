#!/usr/bin/env node
/**
 * scripts/smoke-pack.mjs — pre-publish smoke test
 *
 * Runs `npm pack`, installs the resulting tarball into an isolated temp
 * directory, and exercises the installed CLI to verify the published
 * artifact actually works. Catches mistakes that local tests miss:
 *   - `files:` / `.npmignore` excluding required assets
 *   - `bin` entry pointing to a missing file
 *   - runtime requires on paths not shipped in the tarball
 *
 * Usage:
 *   node scripts/smoke-pack.mjs [--keep]
 *
 * --keep   Leave the temp directory in place for inspection on success.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');

const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
const PKG_NAME = PKG.name;

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8', ...opts });
  if (res.status !== 0) {
    process.stderr.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
  }
  return res;
}

function step(msg) { console.log(`\n▸ ${msg}`); }

const work = mkdtempSync(join(tmpdir(), 'hypo-smoke-'));
const sandboxHome = join(work, 'home');
const installRoot = join(work, 'install');
const wikiDir = join(work, 'wiki');
let cleanupOk = false;

try {
  step('npm pack');
  const pack = run('npm', ['pack', '--json'], { cwd: REPO });
  const meta = JSON.parse(pack.stdout)[0];
  const tarball = join(REPO, meta.filename);
  console.log(`  → ${meta.filename} (${meta.size} bytes, ${meta.entryCount} entries)`);

  step(`install into ${installRoot}`);
  run('mkdir', ['-p', installRoot]);
  writeFileSync(join(installRoot, 'package.json'), JSON.stringify({
    name: 'hypo-smoke-host',
    version: '0.0.0',
    private: true,
  }) + '\n');
  run('npm', ['install', '--no-audit', '--no-fund', '--silent', tarball], { cwd: installRoot });

  // Move tarball into the work dir so it's not left in the repo.
  renameSync(tarball, join(work, meta.filename));

  const cliBin = join(installRoot, 'node_modules', '.bin', 'hypomnema');
  if (!existsSync(cliBin)) {
    throw new Error(`bin not installed at ${cliBin}`);
  }

  step('hypomnema --help (installed)');
  const help = run(cliBin, ['--help']);
  if (!help.stdout.includes('Usage: hypomnema')) {
    throw new Error('--help output did not match expected banner');
  }

  step('hypomnema init --dry-run (installed)');
  const dryEnv = { ...process.env, HOME: sandboxHome, HYPO_DIR: wikiDir };
  const dry = run(cliBin, [
    'init',
    '--dry-run',
    `--hypo-dir=${wikiDir}`,
    '--no-hooks',
    '--no-commands',
    '--no-git-init',
    '--no-shell',
  ], { env: dryEnv });
  if (!/dry[\s-]?run/i.test(dry.stdout + dry.stderr)) {
    console.log(dry.stdout);
    throw new Error('init --dry-run did not announce dry-run mode');
  }

  step('verify shipped assets are present');
  const required = [
    'scripts/init.mjs',
    'scripts/upgrade.mjs',
    'hooks',
    'commands',
    'templates',
    'README.md',
  ];
  const pkgRoot = join(installRoot, 'node_modules', PKG_NAME);
  for (const rel of required) {
    if (!existsSync(join(pkgRoot, rel))) {
      throw new Error(`shipped tarball missing: ${rel}`);
    }
  }

  console.log('\n✓ smoke-pack passed');
  cleanupOk = true;
} catch (err) {
  console.error(`\n✗ smoke-pack failed: ${err.message}`);
  console.error(`  work dir preserved: ${work}`);
  process.exitCode = 1;
} finally {
  if (cleanupOk && !KEEP) {
    rmSync(work, { recursive: true, force: true });
  } else if (KEEP) {
    console.log(`\nwork dir kept: ${work}`);
  }
  // Sweep any stray tarballs left in the repo root from a crashed run.
  for (const f of readdirSync(REPO)) {
    if (f.startsWith(`${PKG_NAME}-`) && f.endsWith('.tgz')) {
      rmSync(join(REPO, f), { force: true });
    }
  }
}
