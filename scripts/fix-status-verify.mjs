#!/usr/bin/env node
/**
 * fix-status-verify (CLI) — verify fix→test linkage + ADR-line evidence
 * against wiki spec claims.
 *
 * Phase 1: test-green half (anchors × spec status × runner results).
 * Phase 2 (A-sot): manifest validation + manifest↔anchor drift + ADR core
 * decision grep against the production corpus. See scripts/lib/fix-manifest.mjs
 * and scripts/lib/fix-status-verify.mjs headers.
 *
 * Usage:
 *   node scripts/fix-status-verify.mjs [--hypo-dir <path>]
 *                                      [--spec <path>]
 *                                      [--runner <path>]
 *                                      [--test-command "<cmd>"]
 *                                      [--json]
 *
 * Exit 0 if no error-level findings, 1 otherwise.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseAnchors,
  parseStatus,
  parseRunnerOutput,
  verifyMatrix,
  isReferenceStub,
  validateManifest,
  checkManifestCoverage,
  checkAdrLines,
  FIX_MANIFEST,
  NO_ADR,
} from './lib/fix-status-verify.mjs';
import { buildCorpusSearch } from './lib/adr-corpus.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Production-code corpus for the ADR-line grep (spec §A amendment 2026-06-07:
// templates/ ships via npm `files`, so prompt-driven fixes are verifiable).
const CORPUS_DIRS = ['scripts', 'hooks', 'commands', 'skills', 'templates'];
// MUST exclude the manifest itself — it holds every adrKeyLine as a literal and
// would self-match, making ADR_LINE_MISSING impossible to ever fire.
const CORPUS_EXCLUDE = ['scripts/lib/fix-manifest.mjs'];

function parseArgs(argv) {
  const out = {
    hypoDir: process.env.HYPO_DIR || join(homedir(), 'hypomnema'),
    spec: null,
    runner: join(REPO, 'tests/runner.mjs'),
    testCommand: 'npm test',
    json: false,
    manifest: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hypo-dir') out.hypoDir = argv[++i];
    else if (a === '--spec') out.spec = argv[++i];
    else if (a === '--runner') out.runner = argv[++i];
    else if (a === '--test-command') out.testCommand = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.spec) {
    out.spec = join(out.hypoDir, 'projects/hypomnema/spec-v1.2.md');
  }
  return out;
}

function printHelp() {
  console.log(
    [
      'fix-status-verify — Phase 1 (test-green half) of learned_behavior #6',
      '',
      'Options:',
      '  --hypo-dir <path>        Wiki root (default: $HYPO_DIR or ~/hypomnema)',
      '  --spec <path>            Override spec-v1.2.md path',
      '  --runner <path>          Override tests/runner.mjs path',
      '  --test-command "<cmd>"   Test invocation (default: "npm test")',
      '  --json                   Emit machine-readable JSON report',
      '',
      'Exit 0 if no error findings, 1 otherwise.',
      '',
      'NOTE: The default --spec is a `type: reference` redirect stub (the real',
      'spec moved to archive/). Running without --spec fails with STUB_SPEC by',
      'design — pass --spec <real spec> to verify against actual claims.',
      '',
      'Phase 2 (A-sot): also greps each manifest adrKeyLine against the',
      'production corpus (scripts/ hooks/ commands/ skills/ templates/) and',
      'checks manifest↔anchor drift. NO_ADR rows skip the grep (test-green only).',
    ].join('\n'),
  );
}

function runTests(testCommand) {
  // Parse simple command (no shell metacharacters supported in args; this is
  // a maintainer tool, not a security boundary).
  const parts = testCommand.split(/\s+/).filter(Boolean);
  const [cmd, ...args] = parts;
  const result = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function formatFinding(f) {
  const icon = f.level === 'error' ? '✗' : '⚠';
  // Some findings are not tied to a specific fix # (STUB_SPEC,
  // TEST_RUN_NONZERO_EXIT). Only render the `fix #N` segment when present so
  // they don't print `fix #undefined`.
  const ref = f.fixNum != null ? ` fix #${f.fixNum}` : '';
  return `  ${icon} [${f.class}]${ref}` + (f.testName ? ` (${f.testName})` : '') + `: ${f.detail}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Manifest source: built-in code constant by default (ADR 0036). --manifest
  // <path.mjs> overrides for tests, which inject a fixture manifest matching
  // their synthetic fixes so the real manifest does not couple to fixtures.
  let manifest = FIX_MANIFEST;
  if (opts.manifest) {
    if (!existsSync(opts.manifest)) {
      console.error(`manifest not found: ${opts.manifest}`);
      process.exit(2);
    }
    const mod = await import(pathToFileURL(resolve(opts.manifest)).href);
    manifest = mod.FIX_MANIFEST;
  }

  if (!existsSync(opts.spec)) {
    console.error(`spec not found: ${opts.spec}`);
    console.error('hint: pass --hypo-dir <path> or set $HYPO_DIR');
    process.exit(2);
  }
  if (!existsSync(opts.runner)) {
    console.error(`runner not found: ${opts.runner}`);
    process.exit(2);
  }

  const specText = readFileSync(opts.spec, 'utf-8');
  const runnerText = readFileSync(opts.runner, 'utf-8');

  const anchors = parseAnchors(runnerText);
  const status = parseStatus(specText);
  const specIsStub = isReferenceStub(specText);

  if (!opts.json) {
    console.log(`fix-status-verify (Phase 1)`);
    console.log(`  spec:   ${opts.spec}`);
    console.log(`  runner: ${opts.runner}`);
    console.log(`  ${status.size} positive status claim(s), ${anchors.size} anchor(s)`);
    console.log(`  running: ${opts.testCommand}`);
  }

  const testRun = runTests(opts.testCommand);
  const testResults = parseRunnerOutput(testRun.stdout + '\n' + testRun.stderr);

  if (!opts.json) {
    const passes = [...testResults.values()].filter((v) => v === 'pass').length;
    const fails = [...testResults.values()].filter((v) => v === 'fail').length;
    console.log(`  test run: ${passes} pass, ${fails} fail (exit ${testRun.exitCode})`);
  }

  const matrixResult = verifyMatrix({ anchors, status, testResults, specIsStub });
  const findings = [...matrixResult.findings];

  // Phase 2 (A-sot): manifest validation + ADR-line grep. validateManifest and
  // checkAdrLines are spec-independent (manifest/code health) and run always;
  // checkManifestCoverage keys off the spec status (a no-op under STUB_SPEC,
  // where status is empty).
  const needsCorpus = manifest.some((r) => r.adrKeyLine !== NO_ADR);
  const adrSearch = needsCorpus
    ? buildCorpusSearch({ repoRoot: REPO, includeDirs: CORPUS_DIRS, excludePaths: CORPUS_EXCLUDE })
    : () => false;
  const adrExists = (adrPath) => existsSync(join(opts.hypoDir, 'projects/hypomnema', adrPath));
  findings.push(...validateManifest(manifest));
  findings.push(...checkManifestCoverage({ manifest, anchors, status }));
  findings.push(...checkAdrLines({ manifest, searchFn: adrSearch, adrExistsFn: adrExists }));

  // CLI-level error: if the test command itself exited nonzero, the test run
  // is not green even if the anchored tests happen to all pass in the parsed
  // output. Surface as a synthetic error finding so `ok` flips false.
  if (testRun.exitCode !== 0) {
    findings.push({
      level: 'error',
      class: 'TEST_RUN_NONZERO_EXIT',
      detail: `test command "${opts.testCommand}" exited ${testRun.exitCode}`,
      exitCode: testRun.exitCode,
    });
  }
  const ok = !findings.some((f) => f.level === 'error') && testRun.exitCode === 0;

  const MANDATORY_NOTE =
    'test-linkage + green + ADR-line grep (Phase 2): manifest evidence checked against production corpus';

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          spec: opts.spec,
          runner: opts.runner,
          statusClaims: status.size,
          anchorCount: anchors.size,
          testsRan: testResults.size,
          testExitCode: testRun.exitCode,
          findings,
          note: MANDATORY_NOTE,
        },
        null,
        2,
      ),
    );
  } else {
    const errors = findings.filter((f) => f.level === 'error');
    const warns = findings.filter((f) => f.level === 'warn');
    if (errors.length === 0 && warns.length === 0) {
      console.log(`  ✓ all ${status.size} claimed-merged fix(es) verified`);
    } else {
      if (errors.length) {
        console.log(`\nerrors (${errors.length}):`);
        for (const f of errors) console.log(formatFinding(f));
      }
      if (warns.length) {
        console.log(`\nwarnings (${warns.length}):`);
        for (const f of warns) console.log(formatFinding(f));
      }
    }
    console.log(`\n(${MANDATORY_NOTE})`);
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
