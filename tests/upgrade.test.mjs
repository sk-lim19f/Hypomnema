// tests/upgrade.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSchemaVocab } from '../scripts/lib/schema-vocab.mjs';
import { isHypomnemaPluginEnabled } from '../scripts/lib/plugin-detect.mjs';
import { writeDualSkipProvenance } from '../scripts/lib/pkg-json.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
  HOOKS,
  NONEXISTENT_WIKI,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  run,
  runWithHome,
  withTmpDir,
  withTmpHome,
} from './helpers.mjs';

// ── upgrade.mjs smoke tests ───────────────────────────────────────────────────

suite('upgrade.mjs --json');

test('exits without crashing on non-existent wiki dir', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  assert.ok(r.status !== null, 'process did not exit cleanly');
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}\n${r.stderr}`);
});

test('--json output is valid JSON', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout not JSON: ${r.stdout}`);
});

test('JSON output has required top-level fields', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok('schema' in out, 'missing schema field');
  assert.ok('hooks' in out, 'missing hooks field');
  assert.ok('settings' in out, 'missing settings field');
  assert.ok('applied' in out, 'missing applied field');
});

test('schema object has installed/current/bump fields', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { schema } = JSON.parse(r.stdout);
  assert.ok('installed' in schema, 'schema missing installed');
  assert.ok('current' in schema, 'schema missing current');
  assert.ok('bump' in schema, 'schema missing bump');
});

test('hooks is an array of file/status objects', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { hooks } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(hooks), 'hooks should be an array');
  assert.ok(hooks.length > 0, 'expected at least one hook entry');
  assert.ok('file' in hooks[0], 'hook entry missing file');
  assert.ok('status' in hooks[0], 'hook entry missing status');
});

test('settings is an array of event/file/status objects', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { settings } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(settings), 'settings should be an array');
  assert.ok(settings.length > 0, 'expected at least one settings entry');
  assert.ok('event' in settings[0], 'settings entry missing event');
  assert.ok('file' in settings[0], 'settings entry missing file');
  assert.ok('status' in settings[0], 'settings entry missing status');
});

test('applied object has hooks and settings arrays', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { applied } = JSON.parse(r.stdout);
  assert.ok(Array.isArray(applied.hooks), 'applied.hooks should be array');
  assert.ok(Array.isArray(applied.settings), 'applied.settings should be array');
});

test('schema.installed is null and bump is "unknown" for non-existent wiki', () => {
  const r = run('upgrade.mjs', [`--hypo-dir=${NONEXISTENT_WIKI}`, '--json']);
  const { schema } = JSON.parse(r.stdout);
  // No SCHEMA.md → installed=null, version comparison impossible → bump='unknown'
  assert.equal(schema.installed, null, 'missing SCHEMA.md should yield installed=null');
  assert.equal(schema.bump, 'unknown', 'unresolvable versions should yield bump=unknown');
  // Exit code is 0 or 1 depending on installed hook/settings state (environment-dependent)
  assert.ok(r.status <= 1, `unexpected exit code ${r.status}`);
});

test('--apply on tmp wiki exits 0 after applying available changes', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.signal, null, `process killed with signal: ${r.signal}`);
      const out = JSON.parse(r.stdout);
      assert.ok('applied' in out, 'applied field missing after --apply');
      assert.ok(Array.isArray(out.applied.hooks), 'applied.hooks should be an array');
      assert.ok(Array.isArray(out.applied.settings), 'applied.settings should be an array');
      assert.equal(r.status, 0, `expected exit 0 after --apply: ${r.stderr}`);
    });
  });
});

test('--apply .hypoignore migration appends .cache/ and is idempotent', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Simulate a pre-existing user .hypoignore from an older Hypomnema version
      // (no `.cache/` entry). Strip any matching line that may be present from
      // the freshly-scaffolded file.
      const hypoignorePath = join(hypoDir, '.hypoignore');
      const original = readFileSync(hypoignorePath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '.cache/')
        .join('\n');
      writeFileSync(hypoignorePath, original);

      // First --apply: should append .cache/
      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first --apply failed: ${r1.stderr}`);
      const out1 = JSON.parse(r1.stdout);
      assert.deepEqual(
        out1.applied.hypoignore,
        ['.cache/'],
        'expected .cache/ to be appended on first run',
      );
      const afterFirst = readFileSync(hypoignorePath, 'utf-8');
      assert.ok(
        afterFirst.includes('.cache/'),
        '.cache/ missing from .hypoignore after first --apply',
      );
      assert.equal(
        (afterFirst.match(/^\.cache\/$/gm) || []).length,
        1,
        '.cache/ should appear exactly once after first --apply',
      );

      // Second --apply: should be a no-op (idempotency)
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const out2 = JSON.parse(r2.stdout);
      assert.deepEqual(out2.applied.hypoignore, [], 'second --apply should not append anything');
      assert.equal(
        out2.hypoignore.status,
        'up-to-date',
        'hypoignore status should be up-to-date on second run',
      );
      const afterSecond = readFileSync(hypoignorePath, 'utf-8');
      assert.equal(
        afterSecond,
        afterFirst,
        '.hypoignore content drifted across idempotent --apply',
      );
    });
  });
});

// ── B5: .gitignore migration mirrors .cache/ (page-usage privacy) ────────────
suite('B5: .gitignore migration mirrors .cache/ (page-usage privacy)');
test('--apply .gitignore migration appends .cache/, git-ignores the log, idempotent', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Simulate a legacy vault: a .gitignore that predates the .cache/ entry.
      const gitignorePath = join(hypoDir, '.gitignore');
      const original = (existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '')
        .split('\n')
        .filter((line) => line.trim() !== '.cache/')
        .join('\n');
      writeFileSync(gitignorePath, original || '# legacy\nnode_modules/\n');
      // Make it a git repo so we can prove the log ends up ignored.
      const gopts = { cwd: hypoDir, encoding: 'utf-8' };
      spawnSync('git', ['init', '-q'], gopts);
      spawnSync('git', ['config', 'user.email', 't@t.test'], gopts);
      spawnSync('git', ['config', 'user.name', 'test'], gopts);

      const r1 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r1.status, 0, `first --apply failed: ${r1.stderr}`);
      const out1 = JSON.parse(r1.stdout);
      assert.deepEqual(
        out1.applied.gitignore,
        ['.cache/'],
        'expected .cache/ appended to .gitignore',
      );
      const afterFirst = readFileSync(gitignorePath, 'utf-8');
      assert.equal(
        (afterFirst.match(/^\.cache\/$/gm) || []).length,
        1,
        '.cache/ should appear exactly once in .gitignore',
      );
      // Privacy: the page-usage log is now git-ignored.
      const ci = spawnSync(
        'git',
        ['-C', hypoDir, 'check-ignore', '-q', '--', '.cache/page-usage.jsonl'],
        { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME } },
      );
      assert.equal(ci.status, 0, 'page-usage.jsonl must be git-ignored after migration');

      // Idempotent second run.
      const r2 = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r2.status, 0, `second --apply failed: ${r2.stderr}`);
      const out2 = JSON.parse(r2.stdout);
      assert.deepEqual(out2.applied.gitignore, [], 'second --apply must not re-append');
      assert.equal(out2.gitignore.status, 'up-to-date', 'gitignore status should be up-to-date');
      assert.equal(
        readFileSync(gitignorePath, 'utf-8'),
        afterFirst,
        '.gitignore drifted across idempotent --apply',
      );
    });
  });
});

test('--apply text report lists the appended .gitignore entry and counts it', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);
      const gitignorePath = join(hypoDir, '.gitignore');
      const stripped = (existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '')
        .split('\n')
        .filter((line) => line.trim() !== '.cache/')
        .join('\n');
      writeFileSync(gitignorePath, stripped || '# legacy\n');
      // Text mode (no --json): the applied-actions block and the count must
      // include the gitignore migration, not silently omit it.
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(r.status, 0, `text --apply failed: ${r.stderr}`);
      assert.ok(
        /Appended \.gitignore entries/.test(r.stdout),
        `report must list gitignore: ${r.stdout}`,
      );
      const m = r.stdout.match(/Result: (\d+) update\(s\) applied/);
      assert.ok(m && Number(m[1]) >= 1, `applied count must include gitignore: ${r.stdout}`);
    });
  });
});

test('--apply generates migration report for major SCHEMA bump', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Patch SCHEMA.md to an older major version to simulate a major bump
      const schemaPath = join(hypoDir, 'SCHEMA.md');
      const schema = readFileSync(schemaPath, 'utf-8');
      writeFileSync(schemaPath, schema.replace(/^version: .+$/m, 'version: 0.9'));

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.signal, null, `process killed with signal: ${r.signal}`);
      const out = JSON.parse(r.stdout);
      assert.ok(out.migrationReport !== null, 'migrationReport should be set for major bump');
      assert.ok(typeof out.migrationReport === 'string', 'migrationReport should be a path string');
      assert.ok(
        existsSync(out.migrationReport),
        `migration report file not found: ${out.migrationReport}`,
      );
      const content = readFileSync(out.migrationReport, 'utf-8');
      assert.ok(content.includes('0.9'), 'migration report should reference old version');
      assert.ok(
        content.includes('2.1'),
        'migration report should reference the new (current) version 2.1',
      );
    });
  });
});

// FEAT-1 boundary: SCHEMA 2.0 → 2.1 is an additive minor bump (optional
// failure_type). A minor bump needs no migration report — nothing to backfill.
test('--apply: SCHEMA 2.0 → 2.1 is a minor bump with no migration report', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // init stamps the current template (2.1); roll the wiki SCHEMA back one minor.
      const schemaPath = join(hypoDir, 'SCHEMA.md');
      writeFileSync(
        schemaPath,
        readFileSync(schemaPath, 'utf-8').replace(/^version: .+$/m, 'version: 2.0'),
      );

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.signal, null, `process killed with signal: ${r.signal}`);
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.schema.bump,
        'minor',
        `expected minor bump, got: ${JSON.stringify(out.schema)}`,
      );
      assert.ok(!out.migrationReport, 'minor bump must not emit a migration report');
    });
  });
});

// ADR 0034 — SCHEMA 1.0 → 2.0 specific guidance. The v1 → v2 path triggers a
// specialized body that names ADR 0031, all 9 hard-required feedback fields,
// the manual-backfill requirement, and the project-id/slug regex caveat from
// PR-B. Generic major bumps (covered above) keep their original body.
test('--apply migration report v1→v2 includes SCHEMA 2.0 feedback fields guidance', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Simulate a wiki that's still on SCHEMA 1.0 (a v1.1.0 hypomnema user).
      // The package template is now 2.1, so --apply produces MIGRATION-v2.1.md
      // and the v1.x→2.x specific body path must still fire (major crossing).
      const schemaPath = join(hypoDir, 'SCHEMA.md');
      writeFileSync(
        schemaPath,
        readFileSync(schemaPath, 'utf-8').replace(/^version: .+$/m, 'version: 1.0'),
      );
      const schemaBefore = readFileSync(schemaPath, 'utf-8');

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(out.migrationReport, 'migrationReport must be set on v1→v2 bump');

      const body = readFileSync(out.migrationReport, 'utf-8');
      // The SCHEMA 2.0 guidance + the 9 hard-required fields must all be named
      // explicitly so a user running --apply sees exactly what needs backfilling.
      assert.ok(
        body.includes('What changed in SCHEMA 2.0'),
        'v1→v2 report must explain the SCHEMA 2.0 change',
      );
      assert.ok(body.includes('semver-major'), 'v1→v2 report must explain why the bump is major');
      for (const field of [
        'status',
        'scope',
        'tier',
        'targets',
        'sensitivity',
        'priority',
        'memory_summary',
        'reason',
        'source',
      ]) {
        assert.ok(
          body.includes(`\`${field}\``),
          `v1→v2 report must name the new required feedback field \`${field}\``,
        );
      }
      // Manual-backfill / no auto-stub policy must be explicit so users do
      // not assume upgrade silently filled the fields.
      assert.ok(
        /auto-stub|manually backfill|backfill the 9 fields/i.test(body),
        'v1→v2 report must state the manual-backfill / no auto-stub policy',
      );
      // PR-B caveat: lint regex vs. cwd-derived id mismatch must be carried
      // through to v1.2.0 users so the silent skip is not surprising.
      assert.ok(
        body.includes('project-id') && body.includes('cwd-derived'),
        'v1→v2 report must surface the project-id/slug regex caveat',
      );
      // Conditional claude-learned requirements must be named so a user who
      // backfills only the 9 unconditional fields and then sets
      // targets: [claude-learned] does not re-fail lint.
      for (const conditional of ['global_summary', 'promote_to_global']) {
        assert.ok(
          body.includes(`\`${conditional}\``),
          `v1→v2 report must name the conditional claude-learned field \`${conditional}\``,
        );
      }
      assert.ok(
        /claude-learned/.test(body) && /Re-run.*lint/i.test(body),
        'v1→v2 report must close with a re-run-lint checklist item',
      );
      // Option C: SCHEMA.md byte-equal even when the specific body fires.
      assert.equal(
        readFileSync(schemaPath, 'utf-8'),
        schemaBefore,
        'SCHEMA.md must be byte-equal after --apply on v1→v2 (Option C)',
      );
    });
  });
});

// User's SCHEMA.md must be byte-equal after --apply. SCHEMA is user vocabulary;
// upgrade emits an informational migration report instead and the user merges
// manually. Tests this invariant in the presence of an unrecognized user-added
// vocab block (which would otherwise be the obvious thing to "clean up").
test('--apply leaves user SCHEMA.md byte-equal', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // Simulate a user who appended a custom Domain tag to their SCHEMA.md.
      // Option C contract: upgrade must NOT discard or rewrite this edit.
      const schemaPath = join(hypoDir, 'SCHEMA.md');
      const customLine = '\n<!-- user-custom: -->\n**UserDomain**: `user-custom-domain`\n';
      const modified = readFileSync(schemaPath, 'utf-8') + customLine;
      writeFileSync(schemaPath, modified);

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);

      const after = readFileSync(schemaPath, 'utf-8');
      assert.equal(after, modified, 'user SCHEMA.md must be byte-equal after --apply (Option C)');
    });
  });
});

// Migration report tags must be a subset of the *installed* wiki's SCHEMA vocab,
// not the package's current vocab — because upgrade deliberately leaves user
// SCHEMA.md untouched, so a long-installed wiki keeps its old vocab line.
// lint.mjs does not scan the hypoDir root where the report is written, so a
// file-level lint would give false confidence; the assertion is vocab-direct.
// Backdate the installed Meta vocab line to the oldest shipped set before running.
test('--apply migration report tags are all in installed SCHEMA vocab', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const schemaPath = join(hypoDir, 'SCHEMA.md');
      // Patch (a) version to trigger major bump, (b) Meta vocab to the oldest
      // shipped set — emulates a wiki that was last linted against an older
      // package vocab and has never had its SCHEMA.md rewritten.
      writeFileSync(
        schemaPath,
        readFileSync(schemaPath, 'utf-8')
          .replace(/^version: .+$/m, 'version: 0.9')
          .replace(
            /^\*\*Meta\*\*:.*$/m,
            '**Meta**: `wiki`, `index`, `operations`, `guide`, `schema`',
          ),
      );

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.ok(out.migrationReport, 'migrationReport should be set on major bump');

      const reportContent = readFileSync(out.migrationReport, 'utf-8');
      const tagLine = reportContent.match(/^tags:\s*\[(.+?)\]/m);
      assert.ok(tagLine, 'migration report must have tags: [...] frontmatter');
      const tags = tagLine[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      assert.ok(tags.length > 0, 'migration report must declare at least one tag');

      const vocab = parseSchemaVocab(hypoDir);
      assert.ok(vocab.size > 0, 'installed SCHEMA vocab must be loadable');
      for (const tag of tags) {
        assert.ok(
          vocab.has(tag),
          `migration report tag "${tag}" not in installed SCHEMA vocab — major-bump upgrade would create a lint-failing page`,
        );
      }
    });
  });
});

// ── ISSUE-55: hypo-guide.md version stamp / staleness warning ──────────────
// hypo-guide.md previously had no update channel at all: upgrade.mjs never
// checked it, and init.mjs only ever writes it once. These tests prove the
// new drift check fires (red proof: same suite also proves it stays silent
// when the stamps match, and that --apply never rewrites the installed file).
suite('upgrade.mjs — hypo-guide.md version drift (ISSUE-55)');

test('guide.bump is "none" when installed hypo-guide.md matches the package template', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      assert.ok('guide' in out, 'JSON output missing top-level guide field');
      assert.equal(
        out.guide.bump,
        'none',
        `freshly-init'd hypo-guide.md should match the package template: ${JSON.stringify(out.guide)}`,
      );
    });
  });
});

// Red proof: roll the installed stamp back one version and confirm the drift
// check actually distinguishes it from the matching case above — turning the
// stamp-compare off (or leaving the stamps equal) would make this pass
// silently too, which is exactly the ISSUE-55 regression this test is for.
test('guide.bump is non-none and the report warns when installed hypo-guide.md is stale', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const guidePath = join(hypoDir, 'hypo-guide.md');
      writeFileSync(
        guidePath,
        readFileSync(guidePath, 'utf-8').replace(/^version: .+$/m, 'version: 0'),
      );

      const jsonR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(jsonR.stdout);
      // 0 → 1 is a major-shaped bump per bumpType(); ISSUE-55 only needs "not up
      // to date", not a major/minor distinction (no migration-report behavior
      // hangs off this one, unlike SCHEMA.md).
      assert.equal(
        out.guide.bump,
        'major',
        `expected a major-shaped bump from v0 to package v1: ${JSON.stringify(out.guide)}`,
      );
      assert.equal(jsonR.status, 1, 'stale hypo-guide.md must count as drift (non-zero exit)');

      const textR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.ok(
        /hypo-guide\.md.*package template changed/.test(textR.stdout),
        `text report must warn about stale hypo-guide.md: ${textR.stdout}`,
      );
    });
  });
});

// ISSUE-19 guard: the drift warning must never come with a write path. Confirm
// --apply leaves a customized hypo-guide.md byte-equal, exactly like the SCHEMA.md
// Option C contract above.
test('--apply never overwrites an installed hypo-guide.md, even when stale', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const guidePath = join(hypoDir, 'hypo-guide.md');
      const customized =
        readFileSync(guidePath, 'utf-8').replace(/^version: .+$/m, 'version: 0') +
        '\n<!-- user note -->\n';
      writeFileSync(guidePath, customized);

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);

      const after = readFileSync(guidePath, 'utf-8');
      assert.equal(
        after,
        customized,
        'user hypo-guide.md must be byte-equal after --apply (visibility only, no overwrite)',
      );
    });
  });
});

// codex pre-commit review BLOCKER: an already-installed vault's hypo-guide.md
// predates the version stamp entirely (no `version:` line at all, not merely
// an old value) — that is the actual shape of every existing installed copy,
// and it is exactly the case the v0-rollback test above does NOT cover (that
// test only ever strips the VALUE, never the whole line). Before this fix,
// stripping the line entirely made checkTemplateVersion() fall through to
// bumpType(null, pkgVersion) === 'unknown', which was excluded from
// guideDrift — so the file this feature exists to catch reported
// "up to date" with exit 0.
test('guide.bump is "unstamped" (counted as drift) when the version line is removed entirely', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const guidePath = join(hypoDir, 'hypo-guide.md');
      // Remove the whole `version:` line — not just its value — to match a
      // pre-versioning installed copy exactly.
      const stripped = readFileSync(guidePath, 'utf-8')
        .split('\n')
        .filter((line) => !/^version:\s/.test(line))
        .join('\n');
      writeFileSync(guidePath, stripped);

      const jsonR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(jsonR.stdout);
      assert.equal(
        out.guide.bump,
        'unstamped',
        `expected bump 'unstamped' for a version-line-less hypo-guide.md: ${JSON.stringify(out.guide)}`,
      );
      assert.equal(
        jsonR.status,
        1,
        `an unstamped installed hypo-guide.md must count as drift (exit 1), not "up to date": ${jsonR.stdout}`,
      );

      const textR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.ok(
        !/Result: Hypomnema is up to date/.test(textR.stdout),
        `must not report "up to date" for an unstamped hypo-guide.md: ${textR.stdout}`,
      );
      assert.ok(
        /hypo-guide\.md\s+installed copy has no version stamp/.test(textR.stdout),
        `text report must give an actionable "no version stamp" warning, not "cannot compare": ${textR.stdout}`,
      );

      // ISSUE-19: still no write path, even for the unstamped case.
      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json', '--apply'], home);
      assert.equal(r.status, 0, `--apply failed: ${r.stderr}`);
      assert.equal(
        readFileSync(guidePath, 'utf-8'),
        stripped,
        'an unstamped hypo-guide.md must still be byte-equal after --apply (no overwrite)',
      );
    });
  });
});

// SCHEMA.md interaction guard: checkTemplateVersion() is shared between
// SCHEMA.md and hypo-guide.md, so the 'unstamped' classification must not
// change SCHEMA.md's existing (pre-ISSUE-55) drift behavior — SCHEMA.md is
// user-owned vocabulary (Option C) and an unstamped copy was already
// non-actionable ("cannot compare") before this classification existed.
test('an unstamped SCHEMA.md is classified but NOT counted as drift (SCHEMA behavior unchanged)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const schemaPath = join(hypoDir, 'SCHEMA.md');
      const stripped = readFileSync(schemaPath, 'utf-8')
        .split('\n')
        .filter((line) => !/^version:\s/.test(line))
        .join('\n');
      writeFileSync(schemaPath, stripped);

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.schema.bump,
        'unstamped',
        `expected the shared classifier to report 'unstamped' for SCHEMA.md too: ${JSON.stringify(out.schema)}`,
      );
      assert.equal(
        r.status,
        0,
        `SCHEMA.md's unstamped case must stay non-actionable (exit 0, unchanged behavior): ${r.stdout}`,
      );
    });
  });
});

// ── ISSUE-6: plugin-mode guard (upgrade.mjs) ───────────────────
// When /hypo:upgrade runs as the Claude Code PLUGIN, the core hooks/commands/
// settings are provided by the plugin loader, not ~/.claude/. The manual-model
// check must NOT report them "missing" and `--apply` must NOT copy/register them
// (double-registration). pluginMode is gated on PKG_ROOT containing /.claude/plugins/,
// so we run a COPY of upgrade.mjs from a fake root whose path matches that shape.
suite('upgrade.mjs — plugin-mode guard (ISSUE-6)');

// underPlugins=true → fake root under .claude/plugins (channel 'plugin');
// false → under node_modules (channel 'npm', regression baseline).
function withFakeUpgradeInstall(underPlugins, fn) {
  const base = mkdtempSync(join(tmpdir(), 'hypo-upg-'));
  try {
    const root = underPlugins
      ? join(base, '.claude', 'plugins', 'cache', 'mp', 'hypomnema', '1.3.0')
      : join(base, 'lib', 'node_modules', 'hypomnema');
    mkdirSync(root, { recursive: true });
    cpSync(SCRIPTS, join(root, 'scripts'), { recursive: true });
    cpSync(HOOKS, join(root, 'hooks'), { recursive: true });
    cpSync(join(REPO, 'commands'), join(root, 'commands'), { recursive: true });
    cpSync(join(REPO, 'templates'), join(root, 'templates'), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(root, 'package.json'));
    const home = join(base, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    const wiki = join(base, 'wiki');
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'hypo-config.md'), '---\ntitle: config\ntype: reference\n---\n');
    cpSync(join(REPO, 'templates', 'SCHEMA.md'), join(wiki, 'SCHEMA.md'));
    fn({ upgrade: join(root, 'scripts', 'upgrade.mjs'), root, home, wiki });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runUpgrade(upgrade, args, home) {
  return spawnSync(process.execPath, [upgrade, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HYPO_DIR: '', HOME: home },
  });
}

test('plugin mode: check reports core surfaces as plugin-managed, not missing', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
    assert.match(r.stdout, /Plugin install detected/, 'missing plugin banner');
    assert.match(r.stdout, /provided by the plugin loader/, 'hooks not relabeled plugin-managed');
    // the manual-model "✗ <hook>.mjs [not found ...]" per-hook nag must be absent
    assert.doesNotMatch(
      r.stdout,
      /✗ hypo-session-start\.mjs/,
      'plugin mode must not report core hooks missing',
    );
    // The legacy bug surfaced ~47 items; plugin mode must only ever flag the
    // (safe, metadata-only) hypo-pkg.json — never a multi-item hook/command nag.
    const m = r.stdout.match(/Result: (\d+) item\(s\) need updating/);
    if (m) assert.ok(Number(m[1]) <= 1, `plugin check over-reported drift: ${m[0]}`);
  });
});

test('plugin mode: --json sets pluginMode true', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pluginMode, true, 'pluginMode flag not set in JSON');
  });
});

test('plugin mode: --apply does NOT copy hooks or register settings (no double-registration)', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `plugin --apply should exit 0: ${r.stderr}`);
    assert.equal(
      existsSync(join(home, '.claude', 'hooks')),
      false,
      '--apply must NOT create ~/.claude/hooks in plugin mode (double-registration footgun)',
    );
    assert.equal(
      existsSync(join(home, '.claude', 'commands', 'hypo')),
      false,
      '--apply must NOT create ~/.claude/commands/hypo in plugin mode',
    );
    // settings.json must not gain hypo-* hook registrations
    const settingsPath = join(home, '.claude', 'settings.json');
    if (existsSync(settingsPath)) {
      assert.doesNotMatch(
        readFileSync(settingsPath, 'utf-8'),
        /hypo-session-start/,
        'plugin --apply must not register hooks into settings.json',
      );
    }
  });
});

test('plugin mode: --apply still writes hypo-pkg.json so runtime resolves PKG_ROOT (lint/feedback)', () => {
  withFakeUpgradeInstall(true, ({ upgrade, root, home, wiki }) => {
    runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    assert.ok(existsSync(pkgPath), 'plugin --apply must still write hypo-pkg.json metadata');
    const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    // realpath both sides: macOS /var is a symlink to /private/var, and the
    // executed script path resolves to the realpath form.
    assert.equal(
      realpathSync(meta.pkgRoot),
      realpathSync(root),
      'hypo-pkg.json pkgRoot must point at the plugin package root',
    );
    // hypo-personal-check resolves lint.mjs/feedback-sync.mjs under pkgRoot/scripts:
    assert.ok(
      existsSync(join(meta.pkgRoot, 'scripts', 'lint.mjs')),
      'pkgRoot must contain the runtime scripts (PreCompact gate dependency)',
    );
    // no command-SHA map is recorded (no commands were copied)
    assert.ok(!('commands' in meta), 'plugin metadata must not record a command-SHA map');
    // steady state: with metadata now written, a fresh check has no drift → exit 0
    // (no perpetual nag for a plugin user who has already applied once).
    const recheck = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
    assert.equal(
      recheck.status,
      0,
      `plugin check after --apply should be clean (exit 0): ${recheck.stdout}`,
    );
  });
});

test('regression: non-plugin install (npm path) still manages core hooks/commands', () => {
  withFakeUpgradeInstall(false, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pluginMode, false, 'non-plugin install must not enter plugin mode');
    // manual model: core hooks are reported (missing here, since fake HOME is empty)
    assert.ok(
      out.hooks.some((h) => h.status === 'missing'),
      'npm mode should still check hooks',
    );
    const apply = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(apply.status, 0, `npm --apply should exit 0: ${apply.stderr}`);
    assert.ok(
      existsSync(join(home, '.claude', 'hooks')),
      'npm mode --apply must install hooks into ~/.claude/hooks (unchanged behavior)',
    );
  });
});

test('plugin mode: --apply drops a stale command-SHA map but preserves other metadata', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    // Simulate a prior manual install: hypo-pkg.json with a commands map + an
    // unrelated extensions field that must survive.
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'hypo-pkg.json'),
      JSON.stringify({
        pkgRoot: '/old/manual/root',
        pkgVersion: '1.0.0',
        schemaVersion: '2.0',
        commands: { 'resume.md': 'deadbeef' },
        extensions: { claude: { 'x.mjs': 'cafe' } },
      }),
    );
    runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    const meta = JSON.parse(readFileSync(join(home, '.claude', 'hypo-pkg.json'), 'utf-8'));
    assert.ok(!('commands' in meta), 'stale command-SHA map must be dropped in plugin mode');
    assert.deepEqual(
      meta.extensions,
      { claude: { 'x.mjs': 'cafe' } },
      'extensions must be preserved',
    );
  });
});

test('plugin mode: check does NOT print a hook-name rename instruction --apply will not honor', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    // Seed a legacy wiki-*.mjs reference in ~/.claude/settings.json (the source of
    // oldHookRefs). In plugin mode --apply skips the rename, so the report must not
    // tell the user to run it.
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: 'command', command: 'node ~/.claude/hooks/wiki-session-start.mjs' }],
            },
          ],
        },
      }),
    );
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
    assert.doesNotMatch(
      r.stdout,
      /old wiki-\*\.mjs reference/,
      'plugin mode must not surface the Claude hook-name rename instruction',
    );
  });
});

// ── dual-install guard (upgrade.mjs + lib/plugin-detect.mjs) ────────────────
// A manual/npm upgrade.mjs run while the plugin is ALSO enabled would copy+register
// the core hooks the plugin already provides → double-registration. The detector is
// fail-open so a legit npm-only user is never blocked.

suite('lib/plugin-detect.mjs — isHypomnemaPluginEnabled (dual-install parser)');

function withSettingsFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-settings-'));
  try {
    const p = join(dir, 'settings.json');
    if (content !== null)
      writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('enabled: hypo@<marketplace> mapped to true → true (current plugin name)', () => {
  withSettingsFile({ enabledPlugins: { 'hypo@hypomnema': true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), true);
  });
});

test('enabled: legacy hypomnema@<marketplace> mapped to true → true (migration window)', () => {
  withSettingsFile({ enabledPlugins: { 'hypomnema@hypomnema': true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), true);
  });
});

test('disabled value: hypomnema@mp: false → false', () => {
  withSettingsFile({ enabledPlugins: { 'hypomnema@hypomnema': false } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), false);
  });
});

test('only other plugins enabled → false', () => {
  withSettingsFile(
    {
      enabledPlugins: {
        'frontend-design@claude-plugins-official': true,
        'oh-my-claudecode@omc': true,
      },
    },
    (p) => assert.equal(isHypomnemaPluginEnabled(p), false),
  );
});

test('bare "hypo": true (no @marketplace) → false (not a valid identifier)', () => {
  withSettingsFile({ enabledPlugins: { hypo: true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), false);
  });
});

test('bare "hypomnema": true (no @marketplace) → false (not a valid identifier)', () => {
  withSettingsFile({ enabledPlugins: { hypomnema: true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), false);
  });
});

test('prefix collision hypo-foo@mp: true → false (exact name only)', () => {
  withSettingsFile({ enabledPlugins: { 'hypo-foo@mp': true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), false);
  });
});

test('prefix collision hypomnema-foo@mp: true → false (exact name only)', () => {
  withSettingsFile({ enabledPlugins: { 'hypomnema-foo@mp': true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), false);
  });
});

test('leading @ (@hypomnema) → false', () => {
  withSettingsFile({ enabledPlugins: { '@hypomnema': true } }, (p) => {
    assert.equal(isHypomnemaPluginEnabled(p), false);
  });
});

test('truthy-but-not-true value (1 / "yes") → false (strict === true)', () => {
  withSettingsFile({ enabledPlugins: { 'hypomnema@mp': 1 } }, (p) =>
    assert.equal(isHypomnemaPluginEnabled(p), false),
  );
  withSettingsFile({ enabledPlugins: { 'hypomnema@mp': 'yes' } }, (p) =>
    assert.equal(isHypomnemaPluginEnabled(p), false),
  );
});

test('enabledPlugins as array → false (fail open)', () => {
  withSettingsFile({ enabledPlugins: ['hypomnema@mp'] }, (p) =>
    assert.equal(isHypomnemaPluginEnabled(p), false),
  );
});

test('enabledPlugins absent → false', () => {
  withSettingsFile({ hooks: {} }, (p) => assert.equal(isHypomnemaPluginEnabled(p), false));
});

test('missing file → false (fail open, never blocks npm-only user)', () => {
  assert.equal(isHypomnemaPluginEnabled('/no/such/settings.json'), false);
});

test('corrupt JSON → false (fail open)', () => {
  withSettingsFile('{ not valid json', (p) => assert.equal(isHypomnemaPluginEnabled(p), false));
});

suite('upgrade.mjs — dual-install guard');

// Build a manual/npm fake install (NOT under .claude/plugins) and write a
// ~/.claude/settings.json whose enabledPlugins enables the hypomnema plugin.
function withDualInstall(enablePlugin, fn) {
  withFakeUpgradeInstall(false, (ctx) => {
    const settingsPath = join(ctx.home, '.claude', 'settings.json');
    if (enablePlugin) {
      writeFileSync(
        settingsPath,
        JSON.stringify({ enabledPlugins: { 'hypomnema@hypomnema': true } }),
      );
    }
    fn({ ...ctx, settingsPath });
  });
}

test('dual install: --json flags dualInstallCoreConflict and coreManagedBy plugin-enabled', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pluginMode, false, 'this is a manual/npm run, not a plugin run');
    assert.equal(out.hypomnemaPluginEnabled, true, 'plugin should be detected as enabled');
    assert.equal(out.dualInstallCoreConflict, true);
    assert.equal(out.coreManagedBy, 'plugin-enabled');
  });
});

test('dual install: --apply does NOT copy hooks or register settings (no double-register)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `dual-install --apply should exit 0: ${r.stderr}\n${r.stdout}`);
    assert.equal(
      existsSync(join(home, '.claude', 'hooks')),
      false,
      'dual-install --apply must NOT create ~/.claude/hooks (the plugin owns core)',
    );
    assert.equal(
      existsSync(join(home, '.claude', 'commands', 'hypo')),
      false,
      'dual-install --apply must NOT create ~/.claude/commands/hypo',
    );
    // settings.json must not gain hypo-* core hook registrations (the actual
    // double-registration vector — the plugin's hooks.json already wires them).
    const settingsPath = join(home, '.claude', 'settings.json');
    const settingsAfter = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : '';
    assert.doesNotMatch(
      settingsAfter,
      /hypo-session-start/,
      'dual-install --apply must NOT register core hooks into settings.json',
    );
    assert.match(r.stdout, /Dual install detected/, 'must surface the loud dual-install banner');
  });
});

test('dual install + missing metadata: --apply writes fallback with a pkgRoot (no pkgRoot-less file)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    assert.equal(existsSync(pkgPath), false, 'precondition: no metadata yet');
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `dual-install --apply (missing meta) should exit 0: ${r.stderr}`);
    assert.ok(existsSync(pkgPath), 'a fallback hypo-pkg.json must be written when none existed');
    const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    assert.equal(
      typeof meta.pkgRoot === 'string' && meta.pkgRoot.length > 0,
      true,
      'fallback metadata must carry a pkgRoot — never a pkgRoot-less file (codex CONCERN)',
    );
    // still no core hooks copied (skip stands; only metadata was written)
    assert.equal(
      existsSync(join(home, '.claude', 'hooks')),
      false,
      'fallback metadata write must not also copy core hooks',
    );
  });
});

test('dual install: hypo-pkg.json identity is preserved (pkgRoot NOT repointed to npm)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    // Seed an existing plugin-written hypo-pkg.json pointing at a plugin path.
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    const pluginRoot = '/some/.claude/plugins/cache/mp/hypomnema/1.3.0';
    writeFileSync(
      pkgPath,
      JSON.stringify({ pkgRoot: pluginRoot, pkgVersion: '1.3.0', schemaVersion: '2.0' }),
    );
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `dual-install --apply should exit 0: ${r.stderr}`);
    const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    assert.equal(
      meta.pkgRoot,
      pluginRoot,
      'dual-install --apply must preserve the plugin-owned pkgRoot, not repoint to npm',
    );
  });
});

test('dual install: preserved metadata is not perpetually nagged as stale (check exit 0)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    writeFileSync(
      pkgPath,
      JSON.stringify({
        pkgRoot: '/some/.claude/plugins/cache/mp/hypomnema/1.3.0',
        pkgVersion: '1.3.0',
        schemaVersion: '2.0',
      }),
    );
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
    assert.equal(
      r.status,
      0,
      `dual-install check with preserved plugin metadata must not nag (exit 0): ${r.stdout}`,
    );
    assert.match(
      r.stdout,
      /plugin-owned \(preserved/,
      'metadata line should read plugin-owned/preserved',
    );
  });
});

test('dual install + --allow-dual-install: core IS registered (override honored)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply', '--allow-dual-install'], home);
    assert.equal(r.status, 0, `override --apply should exit 0: ${r.stderr}\n${r.stdout}`);
    assert.equal(
      existsSync(join(home, '.claude', 'hooks')),
      true,
      '--allow-dual-install must register the core hooks despite the enabled plugin',
    );
  });
});

test('manual install, plugin NOT enabled → normal core management (no false positive)', () => {
  withDualInstall(false, ({ upgrade, home, wiki }) => {
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hypomnemaPluginEnabled, false, 'no plugin enabled → must not be flagged');
    assert.equal(out.dualInstallCoreConflict, false);
    assert.equal(out.coreManagedBy, 'self', 'npm-only user must keep managing the core surface');
    // and --apply must still install core hooks as before
    const ra = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(ra.status, 0, `npm-only --apply should exit 0: ${ra.stderr}`);
    assert.equal(
      existsSync(join(home, '.claude', 'hooks')),
      true,
      'npm-only --apply must still copy core hooks (no regression)',
    );
  });
});

// ── dualSkip provenance self-heal (upgrade.mjs + lib/plugin-detect.mjs) ─────
// npm-first counter-example: `npm init`, then enable the plugin, then `npm init`
// again leaves hypo-pkg.json pointing at the npm root FOREVER — the old dualSkip
// branch only ever preserved whatever was already recorded, never positively
// checked it against the plugin registry. resolveEnabledPluginRoot (shared with
// init.mjs's resolveDurableRoot) lets dualSkip self-heal that ONE case while
// still refusing to touch an already-correct or unresolvable pointer.

suite('upgrade.mjs — dualSkip provenance self-heal (registry root)');

// A second fake install root standing in for "the plugin's real cache root" —
// distinct from the npm root withDualInstall/withFakeUpgradeInstall builds, with
// a DISTINGUISHABLE package.json version so a test can prove which root's
// identity ended up recorded. Package.json only: usablePkgRoot/resolveEnabledPluginRoot
// need nothing else, and these tests never invoke the registry root's own scripts.
function withRegistryRoot(version, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-registry-'));
  try {
    const root = join(dir, 'plugins', 'cache', 'hypomnema', 'hypomnema', version);
    mkdirSync(root, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ ...pkg, version }));
    fn(root);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Writes ~/.claude/plugins/installed_plugins.json with a single entry for `key`
// pointing at `installPath` (user scope — resolveEnabledPluginRoot prefers it).
function writeRegistry(home, key, installPath) {
  const dir = join(home, '.claude', 'plugins');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'installed_plugins.json'),
    JSON.stringify({ plugins: { [key]: [{ installPath, scope: 'user' }] } }),
  );
}

const DUAL_INSTALL_KEY = 'hypomnema@hypomnema'; // matches withDualInstall's settings.json fixture

test('npm-first correction: stale npm pkgRoot + a real registry entry → dualSkip corrects to the registry root', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      // Simulate the npm-first sequence: a stale/npm-shaped pointer already
      // recorded, predating the plugin's registration.
      writeFileSync(
        pkgPath,
        JSON.stringify({ pkgRoot: '/old/npm/root', pkgVersion: '1.0.0', schemaVersion: '2.0' }),
      );
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(
        r.status,
        0,
        `npm-first correction --apply should exit 0: ${r.stderr}\n${r.stdout}`,
      );
      const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.equal(
        realpathSync(meta.pkgRoot),
        realpathSync(registryRoot),
        'dualSkip must correct pkgRoot to the positively-resolved registry root',
      );
      assert.equal(
        meta.pkgVersion,
        '9.9.9',
        'pkgVersion must come from the registry root, not npm',
      );
      assert.match(
        r.stdout,
        /corrected to enabled plugin registry root/,
        'report must surface an explicit corrected outcome, not "preserved"/"stale"',
      );
    });
  });
});

test('npm-first correction (dry run): reports the pending correction and does not write', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      writeFileSync(
        pkgPath,
        JSON.stringify({ pkgRoot: '/old/npm/root', pkgVersion: '1.0.0', schemaVersion: '2.0' }),
      );
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const before = readFileSync(pkgPath, 'utf-8');
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
      assert.equal(
        r.status,
        1,
        'a genuinely correctable npm-first divergence must count as drift (exit 1) so --apply is discoverable',
      );
      assert.match(
        r.stdout,
        /will correct it to the enabled plugin registry root/,
        'dry run must preview the pending correction',
      );
      assert.equal(
        readFileSync(pkgPath, 'utf-8'),
        before,
        'a dry run (no --apply) must never write',
      );
    });
  });
});

test("npm-first correction (recorded already equals this run's PKG_ROOT): dry run still flags drift", () => {
  // checkPkgJson()'s own status only ever compares the recorded pointer against
  // THIS run's PKG_ROOT — so if the recorded pointer happens to equal PKG_ROOT,
  // status reads 'up-to-date' even when the registry positively resolves a
  // DIFFERENT, real plugin root. pkgJsonDrift must not let that 'up-to-date'
  // status suppress the divergence: dualSkipWouldCorrect has to win regardless
  // of status, or this exact npm-first shape goes unreported forever.
  withDualInstall(true, ({ upgrade, root, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      // checkPkgJson() compares the recorded string byte-for-byte against
      // PKG_ROOT as the running upgrade.mjs computes it — which, via
      // import.meta.url, is the REALPATH of `root` (macOS resolves the
      // /var -> /private/var symlink at module-URL resolution time). Record
      // the realpath so status is genuinely 'up-to-date', not merely 'stale'
      // (which the pre-BLOCKER-1-fix formula already handled correctly).
      writeFileSync(
        pkgPath,
        JSON.stringify({ pkgRoot: realpathSync(root), pkgVersion: '1.0.0', schemaVersion: '2.0' }),
      );
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const before = readFileSync(pkgPath, 'utf-8');
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
      const check = JSON.parse(runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home).stdout);
      assert.equal(
        check.pkgJson.status,
        'up-to-date',
        'precondition: the recorded pointer must byte-match PKG_ROOT (status up-to-date), or this is not exercising the bug',
      );
      assert.equal(
        r.status,
        1,
        `a registry divergence must count as drift even when recorded == PKG_ROOT (status up-to-date): ${r.stdout}`,
      );
      assert.match(
        r.stdout,
        /will correct it to the enabled plugin registry root/,
        'dry run must preview the pending correction even when pkgJson.status is up-to-date',
      );
      assert.equal(
        readFileSync(pkgPath, 'utf-8'),
        before,
        'a dry run (no --apply) must never write',
      );
    });
  });
});

test('already-correct: registry root matches what is recorded → no rewrite (no churn)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    // Same version as the npm root's own package.json (REPO's) — an already-
    // correct registry pointer must not itself look like a "newer active
    // install" and trip the unrelated downgrade guard.
    const repoVersion = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version;
    withRegistryRoot(repoVersion, (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      const seeded = JSON.stringify({
        pkgRoot: registryRoot,
        pkgVersion: repoVersion,
        schemaVersion: '2.0',
      });
      writeFileSync(pkgPath, seeded);
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(r.status, 0, `already-correct --apply should exit 0: ${r.stderr}`);
      // syncExtensions runs unconditionally in --apply and re-pretty-prints the
      // file with an `extensions` field regardless of dualSkip — orthogonal to
      // this correction logic — so compare the identity fields, not raw bytes.
      const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.equal(
        meta.pkgRoot,
        registryRoot,
        'an already-correct dualSkip pointer must not be repointed',
      );
      assert.equal(
        meta.pkgVersion,
        repoVersion,
        'an already-correct pkgVersion must not be rewritten',
      );
      assert.doesNotMatch(
        r.stdout,
        /corrected to enabled plugin registry root/,
        'an unchanged identity must not be reported as corrected',
      );
    });
  });
});

test('corrupt registry: usable recorded pointer is preserved, apply does not abort', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    const pluginRoot = '/some/.claude/plugins/cache/mp/hypomnema/1.3.0';
    writeFileSync(
      pkgPath,
      JSON.stringify({ pkgRoot: pluginRoot, pkgVersion: '1.3.0', schemaVersion: '2.0' }),
    );
    // Corrupt registry: unreadable as JSON. resolveEnabledPluginRoot must fail
    // open (null) — never abort a normal upgrade over a damaged registry file.
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ not valid json');
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(
      r.status,
      0,
      `--apply must not abort on a corrupt registry: ${r.stderr}\n${r.stdout}`,
    );
    const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    assert.equal(
      meta.pkgRoot,
      pluginRoot,
      'a corrupt registry must preserve the existing usable pointer untouched',
    );
    assert.equal(meta.pkgVersion, '1.3.0');
    assert.match(
      r.stdout,
      /plugin-owned \(preserved/,
      'corrupt registry must report preserved, not corrected',
    );
  });
});

test('partial registry: enabled key absent from installed_plugins.json → preserved, no abort', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    const pluginRoot = '/some/.claude/plugins/cache/mp/hypomnema/1.3.0';
    writeFileSync(
      pkgPath,
      JSON.stringify({ pkgRoot: pluginRoot, pkgVersion: '1.3.0', schemaVersion: '2.0' }),
    );
    // Well-formed registry, but no entry for the enabled key (a different
    // marketplace/name is installed) — must not be treated as a positive match.
    writeRegistry(home, 'some-other-plugin@mp', '/irrelevant/root');
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(
      r.status,
      0,
      `--apply must not abort on a registry with no matching entry: ${r.stderr}`,
    );
    const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    assert.equal(
      meta.pkgRoot,
      pluginRoot,
      'no usable entry for the enabled key must preserve the existing pointer untouched',
    );
  });
});

test('correction preserves unrelated existing metadata (commands map, extensions)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      writeFileSync(
        pkgPath,
        JSON.stringify({
          pkgRoot: '/old/npm/root',
          pkgVersion: '1.0.0',
          schemaVersion: '2.0',
          commands: { 'resume.md': 'deadbeef' },
          extensions: { claude: { 'x.mjs': 'cafe' } },
        }),
      );
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(r.status, 0, `--apply should exit 0: ${r.stderr}`);
      const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.equal(realpathSync(meta.pkgRoot), realpathSync(registryRoot));
      assert.equal(meta.pkgVersion, '9.9.9');
      // Unlike writePluginModeMetadata (true plugin mode), a dualSkip provenance
      // correction is NOT plugin-mode cleanup — it must not drop the commands map
      // or touch unrelated fields, since the identity being written is the OTHER
      // (plugin) install's, not this npm run's.
      assert.deepEqual(
        meta.commands,
        { 'resume.md': 'deadbeef' },
        'a dualSkip correction must preserve an existing commands map, unlike plugin-mode metadata writes',
      );
      assert.deepEqual(
        meta.extensions,
        { claude: { 'x.mjs': 'cafe' } },
        'extensions must be preserved',
      );
    });
  });
});

// ── writeDualSkipProvenance TOCTOU refusal (lib/pkg-json.mjs) ───────────────
// resolveEnabledPluginRoot proves registryRoot usable via a SEPARATE, earlier
// read; the writer re-reads registryRoot's package.json at write time and must
// refuse (not stamp a new pkgRoot with a stale/missing version) if that root
// stops being usable by the time the write actually happens. Unit-tested
// directly against the shared lib function — deterministic, no timing race
// needed — since upgrade.mjs itself has no exported surface to spawn this
// exact boundary condition end-to-end.

suite('lib/pkg-json.mjs — writeDualSkipProvenance TOCTOU refusal');

function withPkgJsonFixture(seeded, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-pkgjson-'));
  try {
    const pkgPath = join(dir, 'hypo-pkg.json');
    if (seeded !== null) writeFileSync(pkgPath, JSON.stringify(seeded));
    fn(pkgPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registry root unreadable at write time: refuses, preserves existing metadata, returns false', () => {
  withPkgJsonFixture(
    { pkgRoot: '/old/npm/root', pkgVersion: '1.0.0', schemaVersion: '2.0' },
    (pkgPath) => {
      const before = readFileSync(pkgPath, 'utf-8');
      // A registryRoot whose package.json cannot be read at write time — the
      // exact TOCTOU shape: something resolved this root as usable earlier,
      // but by the time the writer re-reads it, it no longer is.
      const result = writeDualSkipProvenance(pkgPath, '/nonexistent/registry/root');
      assert.equal(
        result,
        false,
        'must refuse (return false), not write a stale-version correction',
      );
      assert.equal(
        readFileSync(pkgPath, 'utf-8'),
        before,
        'a refused correction must leave the existing metadata byte-identical',
      );
    },
  );
});

test('registry root package.json is corrupt JSON at write time: refuses, preserves existing metadata', () => {
  const registryDir = mkdtempSync(join(tmpdir(), 'hypo-registry-corrupt-'));
  try {
    writeFileSync(join(registryDir, 'package.json'), '{ not valid json');
    withPkgJsonFixture(
      { pkgRoot: '/old/npm/root', pkgVersion: '1.0.0', schemaVersion: '2.0' },
      (pkgPath) => {
        const before = readFileSync(pkgPath, 'utf-8');
        const result = writeDualSkipProvenance(pkgPath, registryDir);
        assert.equal(
          result,
          false,
          'corrupt package.json at the registry root must refuse the correction',
        );
        assert.equal(readFileSync(pkgPath, 'utf-8'), before, 'existing metadata must be untouched');
      },
    );
  } finally {
    rmSync(registryDir, { recursive: true, force: true });
  }
});

test('registry root package.json has no usable version at write time: refuses', () => {
  const registryDir = mkdtempSync(join(tmpdir(), 'hypo-registry-noversion-'));
  try {
    writeFileSync(join(registryDir, 'package.json'), JSON.stringify({ name: 'hypomnema' }));
    withPkgJsonFixture(
      { pkgRoot: '/old/npm/root', pkgVersion: '1.0.0', schemaVersion: '2.0' },
      (pkgPath) => {
        const before = readFileSync(pkgPath, 'utf-8');
        const result = writeDualSkipProvenance(pkgPath, registryDir);
        assert.equal(result, false, 'a version-less package.json must refuse the correction');
        assert.equal(readFileSync(pkgPath, 'utf-8'), before);
      },
    );
  } finally {
    rmSync(registryDir, { recursive: true, force: true });
  }
});

test('registry root usable at write time: writes the correction and returns true', () => {
  const registryDir = mkdtempSync(join(tmpdir(), 'hypo-registry-ok-'));
  try {
    writeFileSync(
      join(registryDir, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '9.9.9' }),
    );
    withPkgJsonFixture(
      {
        pkgRoot: '/old/npm/root',
        pkgVersion: '1.0.0',
        schemaVersion: '2.0',
        extensions: { claude: {} },
      },
      (pkgPath) => {
        const result = writeDualSkipProvenance(pkgPath, registryDir);
        assert.equal(result, true, 'a usable registry root must be written');
        const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        assert.equal(meta.pkgRoot, registryDir);
        assert.equal(meta.pkgVersion, '9.9.9');
        assert.deepEqual(meta.extensions, { claude: {} }, 'unrelated fields must be preserved');
      },
    );
  } finally {
    rmSync(registryDir, { recursive: true, force: true });
  }
});
