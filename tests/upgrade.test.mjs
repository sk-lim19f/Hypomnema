// tests/upgrade.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import {
  schemaVersionDeltas,
  SCHEMA_VERSION_DELTAS,
} from '../scripts/lib/template-schema-version.mjs';
import { isHypomnemaPluginEnabled } from '../scripts/lib/plugin-detect.mjs';
import { wikiPreCommitContent } from '../scripts/lib/git-hooks-dir.mjs';
import { writeDualSkipProvenance } from '../scripts/lib/pkg-json.mjs';
import { PROVENANCE_FILENAME } from '../scripts/lib/pkg-provenance.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
  HOOKS,
  NONEXISTENT_WIKI,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  legacyWikiPreCommitContent,
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
      // Read the version off the shipped template rather than pinning a literal.
      // The point of this assertion is "the report names the version we are
      // upgrading TO", and a literal turns every SCHEMA bump into a failing test
      // that says nothing about the report.
      const shipped = readFileSync(join(REPO, 'templates', 'SCHEMA.md'), 'utf-8');
      const shippedVersion = shipped.match(/^version: (.+)$/m)?.[1]?.trim();
      assert.ok(shippedVersion, 'templates/SCHEMA.md must carry a version stamp');
      assert.ok(
        content.includes(shippedVersion),
        `migration report should reference the new (current) version ${shippedVersion}`,
      );
      // SCHEMA_VERSION_DELTAS is filled in by hand at every SCHEMA.md version
      // bump, and a skipped line breaks nothing: schemaVersionDeltas() just
      // falls back to the plain "review manually" notice for that version,
      // silently. This pins that the version templates/SCHEMA.md actually
      // ships has an entry, so a bump that forgets the delta line fails HERE
      // instead of degrading a real user's upgrade notice with no test ever
      // noticing.
      assert.ok(
        shippedVersion in SCHEMA_VERSION_DELTAS,
        `SCHEMA_VERSION_DELTAS (scripts/lib/template-schema-version.mjs) has no entry for the ` +
          `shipped SCHEMA.md version ${shippedVersion}; add one describing what that version added`,
      );
    });
  });
});

// An additive bump inside the same major is minor, and a minor bump needs no
// migration report because there is nothing to backfill. The fixture rolls the
// wiki back to 2.0 and lets the shipped template be whatever it currently is.
test('--apply: SCHEMA 2.0 to the shipped version is a minor bump with no migration report', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // init stamps the current template; roll the wiki SCHEMA back to 2.0.
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
      // ISSUE-139: hypo-guide.md carries no version stamp at all, so there is
      // no base to diff a per-version delta from (unlike SCHEMA.md below).
      // The notice must say why, not silently give the same text as a stamped
      // file would.
      assert.ok(
        /no base version to diff/.test(textR.stdout),
        `unstamped hypo-guide.md notice must explain why no delta can be given: ${textR.stdout}`,
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

// IMPR-51 / ADR 0097: `withDualInstall` enables the plugin in settings.json but
// never writes installed_plugins.json, so the registry lookup fails with reason
// 'registry-unreadable' — a JUDGMENT FAILURE, not "no plugin installed". With no
// existing hypo-pkg.json to preserve either, writing PKG_ROOT (this npm/manual
// checkout) here would persist a GUESS as durable truth — the exact removable
// copy the dual-install banner tells the user to uninstall. This replaces the
// prior expectation (a fallback pkgRoot was always written); the fallback must
// NOT fire when the channel judgment itself failed. hypo-pkg.json may still
// exist afterward (the unconditional extensions-SHA sync writes one even with
// zero extensions — see syncExtensions step (4)), so the assertion is on the
// pkgRoot FIELD, not file existence: doctor already treats a pkgRoot-less file
// as its own distinct, reported state (`hypo-pkg.json has no pkgRoot field`),
// never as "resolved to PKG_ROOT".
test('dual install + missing metadata + unresolvable registry: --apply does not stamp a guessed pkgRoot', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    const pkgPath = join(home, '.claude', 'hypo-pkg.json');
    assert.equal(existsSync(pkgPath), false, 'precondition: no metadata yet');
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `dual-install --apply (missing meta) should exit 0: ${r.stderr}`);
    const meta = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf-8')) : {};
    assert.equal(
      meta.pkgRoot,
      undefined,
      'an unresolvable registry judgment must not confirm a guessed PKG_ROOT as the durable pointer',
    );
    assert.match(
      r.stdout,
      /Cannot positively resolve the enabled plugin's install root/,
      'must explain why no pkgRoot was written and what unblocks it',
    );
    assert.match(
      r.stdout,
      /re-run `hypomnema upgrade --apply`/,
      'recovery guidance must name the concrete next step',
    );
    // still no core hooks copied (skip stands; the pkgRoot write was skipped too)
    assert.equal(
      existsSync(join(home, '.claude', 'hooks')),
      false,
      'the skipped fallback write must not also copy core hooks',
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

// Positive control for the missing-metadata guard: once the registry DOES
// positively resolve a usable root, metadata is still written — the guard is
// keyed to the judgment-FAILURE case, not to "missing metadata" in general.
//
// The recorded root is the REGISTRY's, not this run's PKG_ROOT. An earlier draft
// of this test asserted PKG_ROOT and called correcting it "a separate concern".
// It is not separate: PKG_ROOT here is the npm/manual copy the dual-install
// banner tells the user to uninstall, so stamping it leaves a pointer that
// dangles the moment they follow that advice — the exact failure this lane
// exists to close. It also made `init` and `upgrade --apply` disagree in the
// same state, since init writes the plugin root. Asserting PKG_ROOT here pinned
// the defect as the contract.
test("dual install + missing metadata + resolvable registry: --apply records the REGISTRY root, not this run's PKG_ROOT", () => {
  withDualInstall(true, ({ upgrade, home, wiki, root }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      assert.equal(existsSync(pkgPath), false, 'precondition: no metadata yet');
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(
        r.status,
        0,
        `dual-install --apply (resolvable registry) should exit 0: ${r.stderr}`,
      );
      assert.ok(
        existsSync(pkgPath),
        'a fallback hypo-pkg.json must still be written once the registry resolves',
      );
      const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.equal(
        realpathSync(meta.pkgRoot),
        realpathSync(registryRoot),
        'the durable pointer must name the registry root, never this npm run',
      );
      assert.notEqual(
        realpathSync(meta.pkgRoot),
        realpathSync(root),
        'stamping PKG_ROOT here would dangle as soon as the user uninstalls the npm copy',
      );
      assert.equal(meta.pkgVersion, '9.9.9', 'and the version read at that same root');
      assert.doesNotMatch(
        r.stdout,
        /Cannot positively resolve the enabled plugin's install root/,
        'a resolvable registry must not print the judgment-failure recovery notice',
      );
    });
  });
});

// codex reproduction (2026-09-11): selectEntry used to accept any registry row
// whose installPath merely resolved a readable version, with no check on WHOSE
// package sat there. A row naming a directory with an absolute path, a version,
// but a foreign (or missing) package.json `name` must not be adopted as the
// durable root — isHypomnemaInstallRoot is what closes that.
test('dual install: a registry row whose package.json name is not "hypomnema" is never adopted as the durable root', () => {
  withDualInstall(true, ({ upgrade, home, wiki, root }) => {
    const dir = mkdtempSync(join(tmpdir(), 'hypo-foreign-registry-'));
    try {
      const foreignRoot = join(dir, 'not-hypomnema');
      mkdirSync(foreignRoot, { recursive: true });
      writeFileSync(
        join(foreignRoot, 'package.json'),
        JSON.stringify({ name: 'someone-elses-package', version: '9.9.9' }),
      );
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      writeRegistry(home, DUAL_INSTALL_KEY, foreignRoot);
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(r.status, 0, `dual-install --apply should exit 0: ${r.stderr}`);
      assert.match(
        r.stdout,
        /Cannot positively resolve the enabled plugin's install root/,
        'a foreign-named registry row must read as unresolved, not silently adopted',
      );
      if (existsSync(pkgPath)) {
        const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        assert.notEqual(
          meta.pkgRoot,
          foreignRoot,
          'the foreign root must never be recorded as the durable pointer',
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// checkPkgJson reports 'missing' for a file that EXISTS but has no usable
// pkgRoot, so the dual-skip fallback branch is reached with a real file on disk
// — not only with none. That file can carry a manual install's command SHA map,
// and this run copied no commands, so carrying the map over would re-assert
// ownership of ~/.claude/commands/hypo that the run never took. The writer used
// here preserves unknown fields by design (the npm-first correction path needs
// that), so the drop has to happen at this call site.
test('dual install + a pkgRoot-less file that still carries a commands map: the map is dropped, not carried over', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      // No pkgRoot: checkPkgJson calls this 'missing' even though it exists.
      writeFileSync(
        pkgPath,
        JSON.stringify({
          commands: { 'hypo/query.md': 'deadbeef' },
          extensions: { claude: { 'skills/x': 'cafe' } },
        }),
      );
      const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(r.status, 0, `dual-install --apply should exit 0: ${r.stderr}`);
      const meta = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      assert.equal(
        realpathSync(meta.pkgRoot),
        realpathSync(registryRoot),
        'fixture: the registry root must still be recorded',
      );
      assert.equal(
        'commands' in meta,
        false,
        'a stale command SHA map must not survive: this run copied no commands',
      );
      assert.equal(
        typeof meta.extensions,
        'object',
        `every other prior field survives the drop (extensions=${JSON.stringify(meta.extensions)})`,
      );
    });
  });
});

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

// Reported bug: a dual install (npm global + plugin, different versions) ran
// `upgrade --apply` twice in a row and the second call was refused. Cause: the
// first call's dualSkip correction (writeDualSkipProvenance, tested above)
// stamps the REGISTRY's version into hypo-pkg.json, not this package's own, so
// the very next plain `--apply`, still on the dualSkip branch, compared its own
// (lower) version against the registry version it had just recorded and
// refused as a downgrade. The fix narrows the guard to the branches that
// actually copy hooks and stamp THIS run's own version (managesClaudeCore,
// `--codex`); a plain dualSkip repeat touches neither, so the guard no longer
// runs for it.
test('dual install: two consecutive plain --apply calls both exit 0 (no downgrade-guard false positive)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const first = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(first.status, 0, `first --apply should exit 0: ${first.stderr}`);
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      assert.equal(
        JSON.parse(readFileSync(pkgPath, 'utf-8')).pkgVersion,
        '9.9.9',
        'precondition: the first apply must have recorded the registry version, not this own package version',
      );
      // No reset of hypo-pkg.json between the two calls: the fix means the
      // second run reads whatever the first one left there and still is not
      // refused.
      const second = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
      assert.equal(
        second.status,
        0,
        `second consecutive --apply should also exit 0, not refuse a downgrade: ${second.stderr}`,
      );
      assert.doesNotMatch(second.stderr, /Refusing to upgrade --apply/);
    });
  });
});

// Was a known residual, now closed: the codex downgrade guard used to compare
// its incoming version against hypo-pkg.json — the Claude plugin's pointer —
// even though `--codex` never writes a version there. In a dual install that
// pointer stays stuck at the REGISTRY's version (9.9.9 here, from the
// dualSkip write earlier in the same run), so the very next `--apply --codex`
// compared this package's real, lower version against 9.9.9 and refused a
// downgrade that never happened. The guard now reads the codex hooks dir's
// own `.hypo-provenance.json` sidecar for the codex branch — the artifact
// `--codex` actually writes a version into — so a second consecutive
// `--apply --codex` compares against itself and passes.
test('dual install: two consecutive --apply --codex calls both exit 0 (codex guard reads its own sidecar, not the plugin pointer)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    withRegistryRoot('9.9.9', (registryRoot) => {
      writeRegistry(home, DUAL_INSTALL_KEY, registryRoot);
      const first = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply', '--codex'], home);
      assert.equal(first.status, 0, `first --apply --codex should exit 0: ${first.stderr}`);
      const pkgPath = join(home, '.claude', 'hypo-pkg.json');
      assert.equal(
        JSON.parse(readFileSync(pkgPath, 'utf-8')).pkgVersion,
        '9.9.9',
        "precondition: the plugin pointer stays at the registry version, not this run's own",
      );
      const second = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply', '--codex'], home);
      assert.equal(
        second.status,
        0,
        `second consecutive --apply --codex should also exit 0, not refuse a downgrade: ${second.stderr}`,
      );
      assert.doesNotMatch(second.stderr, /Refusing to upgrade --apply/);
    });
  });
});

// Positive control for the fix above: reading the codex sidecar must still
// actually enforce a downgrade when one is real, not just always pass. A
// fabricated sidecar with a different pkgRoot (so the realpath-equality
// exemption for a dev workspace re-running its own --apply does not fire)
// and a newer version stands in for an install that really is ahead.
test('codex downgrade guard refuses a real downgrade read from the codex sidecar', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const codexHooksDir = join(home, '.codex', 'hooks');
      mkdirSync(codexHooksDir, { recursive: true });
      writeFileSync(
        join(codexHooksDir, PROVENANCE_FILENAME),
        JSON.stringify({ pkgRoot: '/fake/newer/codex-root', pkgVersion: '9.9.9' }),
      );

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(
        r.status,
        2,
        `a codex sidecar recording a newer version must still refuse: ${r.stdout}`,
      );
      assert.match(r.stderr, /Refusing to upgrade --apply/);
    });
  });
});

// Policy pin: a codex sidecar that exists but fails to parse carries no more
// of a trustworthy baseline than one that was never written, so the guard
// fail-opens on it exactly like the missing case, rather than refusing on
// unreadable data it cannot prove is a downgrade from.
test('codex downgrade guard fail-opens on a corrupted sidecar, same as a missing one', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const codexHooksDir = join(home, '.codex', 'hooks');
      mkdirSync(codexHooksDir, { recursive: true });
      writeFileSync(join(codexHooksDir, PROVENANCE_FILENAME), '{not json');

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(
        r.status,
        0,
        `a corrupted sidecar must not be read as a downgrade baseline: ${r.stderr}`,
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

// ── wiki pre-commit hook: migrate the version-pinned form to the runtime
// resolver (ISSUE-137) ───────────────────────────────────────────────────────
// init.mjs used to bake an absolute install root into the vault's pre-commit
// hook. A plugin-channel upgrade moves PKG_ROOT to a new version directory
// every release, but nothing ever re-runs init afterward, so the hook kept
// calling whatever release happened to be current the day /hypo:init last
// ran, with no signal anywhere (measured 2026-09-01: a vault hook pointed at a
// release four months stale while the registry and hypo-pkg.json both agreed
// on the current one). wikiPreCommitContent() no longer bakes a root in at
// all — the hook resolves one itself, at commit time — so the fix upgrade.mjs
// applies is no longer "repoint the baked root": it is "rewrite an OLD-form
// hook onto the new, resolver-based form", unconditionally, whenever one is
// found. That migration does not need to positively resolve the active
// install first (see the no-registry-entry test below): the resolver embedded
// in the rewritten hook looks that up fresh at every future commit, so
// migrating is a strict improvement even when THIS run cannot resolve one.

suite('upgrade.mjs — wiki pre-commit hook: old-form migration');

// Writes a pre-commit hook via legacyWikiPreCommitContent — the OLD,
// version-pinned shape wikiPreCommitContent() itself generated before
// ISSUE-137 — so these tests exercise upgrade.mjs's migration path against a
// hook shaped like one a real, older Hypomnema install actually left behind.
// `embeddedHypoDir` defaults to `wiki` (the common case: --hypo-dir usually IS
// the vault's own root) but callers that need to distinguish "preserved the
// baked-in value" from "substituted this run's --hypo-dir" pass a different
// one — see the --lint-strict test below.
// `createRoot: false` seeds the one shape the rewrite path exists for: a
// baked-in install root that is GONE (moved, reinstalled, cache pruned). The
// strict predicate uninstall.mjs still uses rejects that shape on purpose —
// deleting somebody's hook on the strength of a path nobody can read is not a
// call this tool gets to make — but refusing to REWRITE it is what left those
// users with a hook failing every commit, an `upgrade --apply` that printed
// nothing, and a `doctor` that said pass.
function seedWikiPreCommitHook(wiki, root, lintStrict, embeddedHypoDir = wiki, createRoot = true) {
  // git init must not read the developer's real ~/.gitconfig: a global
  // core.hooksPath or init.templateDir there would make git look for the hook
  // somewhere other than <wiki>/.git/hooks, and the assertions below (which
  // read that exact path) would then pass or fail for the wrong reason. See
  // CLAUDE.md's "every process a test spawns gets HOME pinned" rule.
  spawnSync('git', ['init', wiki], {
    stdio: 'ignore',
    env: { ...process.env, HOME: SESSION_TMP_HOME },
  });
  const hooksDir = join(wiki, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  // A real stale root usually still exists: the plugin channel gives every
  // install its own version-numbered cache directory and never removes a
  // superseded one. Measured 2026-09-11 on this machine — 1.7.4, 1.8.0, 1.8.1
  // and 1.8.2 all still present under both install roots, each with its
  // worker script. So `createRoot` defaults to true and these tests seed the
  // common shape. Pass false for the other one (npm reinstall, a moved dev
  // checkout, a hand-pruned cache), which the rewrite path must still migrate.
  if (createRoot) {
    mkdirSync(join(root, 'hooks'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '1.6.0' }),
    );
    writeFileSync(join(root, 'hooks', 'hypo-pre-commit.mjs'), '');
  }
  writeFileSync(hookPath, legacyWikiPreCommitContent(root, embeddedHypoDir, lintStrict), {
    mode: 0o755,
  });
  return hookPath;
}

test('plugin mode: --apply migrates a stale, version-pinned pre-commit hook onto the runtime-resolving form', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const staleRoot = join(tmpdir(), 'hypo-stale-root-4-months-old');
    const hookPath = seedWikiPreCommitHook(wiki, staleRoot, false);
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `--apply should exit 0: ${r.stderr}\n${r.stdout}`);
    const hook = readFileSync(hookPath, 'utf-8');
    assert.match(
      hook,
      /node -e '/,
      `hook must be migrated to resolve the install root at commit time: ${hook}`,
    );
    assert.ok(!hook.includes(staleRoot), 'the stale root must not survive the migration');
    assert.match(
      r.stdout,
      /Wiki pre-commit.*migrated off the baked-in root/,
      'report must surface the migration, not silence it (and not the "nothing to migrate" line)',
    );
    assert.equal(
      existsSync(`${hookPath}.bak`),
      true,
      'a successful migration must leave a .bak of the pre-migration bytes behind',
    );
    assert.equal(
      readFileSync(`${hookPath}.bak`, 'utf-8'),
      legacyWikiPreCommitContent(staleRoot, wiki, false),
      'the backup must hold exactly the bytes that were overwritten',
    );
  });
});

// codex reproduction (2026-09-11): applyWikiPreCommitRoot used to overwrite the
// WHOLE hook file unconditionally. isOwnedWikiPreCommitBody only validates the
// SPAN between the markers, so a hand-crafted file pairing a forged-but-valid
// old-form marker span (a worker line naming a root that does not currently
// exist, which isRewritableOldFormInstallRoot's "gone root" branch accepts)
// with real content OUTSIDE that span passed every prior check, and the
// migration silently discarded the outside content. The fix requires the file
// to already be byte-for-byte the exact legacy shape before it may be
// overwritten whole.
test('--apply refuses to migrate (and does not touch the file) when content sits outside the managed marker span', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const goneRoot = join(tmpdir(), `hypo-gone-outside-content-${process.pid}`);
    const hookPath = seedWikiPreCommitHook(wiki, goneRoot, false, wiki, false);
    const legacyBody = readFileSync(hookPath, 'utf-8');
    // Splice in a user's own line right after the shebang, outside the marker
    // span isOwnedWikiPreCommitBody validates.
    const withOutsideContent = legacyBody.replace(
      '#!/bin/sh\n',
      '#!/bin/sh\necho "user-owned deploy check"\n',
    );
    writeFileSync(hookPath, withOutsideContent, { mode: 0o755 });
    const before = readFileSync(hookPath, 'utf-8');
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `--apply should still exit 0 on a soft refusal: ${r.stderr}`);
    const after = readFileSync(hookPath, 'utf-8');
    assert.equal(
      after,
      before,
      'a file with content outside the marker span must be left byte-identical, never partially migrated',
    );
    assert.equal(
      existsSync(`${hookPath}.bak`),
      false,
      'a refused migration must not leave a backup behind either — nothing was written',
    );
    assert.match(
      r.stdout,
      /could not migrate hook/,
      `the refusal must be surfaced, not silent: ${r.stdout}`,
    );
  });
});

// The unit check on parseWikiPreCommitRoot (tests/git-hooks-dir.test.mjs) pins
// the predicate. It does NOT pin what upgrade does with the answer, and that
// gap is where this shipped broken once: the strict predicate said "not ours",
// checkWikiPreCommitRoot turned that into null, and both report branches were
// gated on non-null, so `--apply` printed no Wiki pre-commit line at all while
// the hook failed every commit with MODULE_NOT_FOUND. Green units, silent
// product. This asserts the downstream instead.
test('--apply migrates an old-form hook whose baked-in root is GONE, and says so', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const goneRoot = join(tmpdir(), `hypo-root-deleted-${process.pid}-${Date.now()}`);
    const hookPath = seedWikiPreCommitHook(wiki, goneRoot, false, wiki, false);
    assert.equal(
      existsSync(goneRoot),
      false,
      'fixture must not exist for this test to mean anything',
    );

    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `--apply should exit 0: ${r.stderr}\n${r.stdout}`);

    const hook = readFileSync(hookPath, 'utf-8');
    assert.match(hook, /node -e '/, `a gone root must not block the migration: ${hook}`);
    assert.ok(!hook.includes(goneRoot), 'the dead root must not survive the migration');
    assert.match(
      r.stdout,
      /Wiki pre-commit.*migrated off the baked-in root/,
      `the migration must be reported, not silent: ${r.stdout}`,
    );
  });
});

test('dual install: --allow-dual-install does not move the diagnostic wantRoot field, and --apply writes the identical vault hook bytes either way', () => {
  withDualInstall(true, ({ upgrade, home, wiki, root }) => {
    // `--allow-dual-install` means "stop refusing to write the core surface
    // twice". It says nothing about which install a vault's git hook should
    // resolve through. Reading it as a root choice made upgrade repoint the
    // hook at this npm/manual PKG_ROOT while doctor kept calling that stale
    // against the registry root, so a user following doctor's advice silently
    // undid their own run, and re-running WITH the flag changed nothing
    // because upgrade already agreed with the manual root. wikiPreCommitRoot's
    // `wantRoot` is now purely a DIAGNOSTIC field (the migrated hook body
    // never bakes a root in at all, see below); the title used to claim the
    // flag does not change "which root the vault hook gets", which this field
    // alone cannot prove one way or the other. What it actually checks is
    // narrower: with and without the flag, wantRoot reports the same answer.
    seedWikiPreCommitHook(wiki, join(tmpdir(), `hypo-stale-1-6-0-${process.pid}`), false);
    const registryRoot = join(home, '.claude', 'plugins', 'cache', 'mp', 'hypo', '9.9.9');
    mkdirSync(registryRoot, { recursive: true });
    // isHypomnemaInstallRoot() demands both a name of "hypomnema" and a package.json
    // carrying a version; without either the resolver returns null for BOTH runs and
    // the comparison below passes while measuring nothing. That is exactly how the
    // first version of this test stayed green over a real divergence.
    writeFileSync(
      join(registryRoot, 'package.json'),
      JSON.stringify({ name: 'hypomnema', version: '9.9.9' }),
    );
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'hypomnema@hypomnema': [{ scope: 'user', installPath: registryRoot }] },
      }),
    );
    const withoutFlag = JSON.parse(
      runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home).stdout,
    ).wikiPreCommitRoot?.wantRoot;
    const withFlag = JSON.parse(
      runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json', '--allow-dual-install'], home).stdout,
    ).wikiPreCommitRoot?.wantRoot;
    assert.equal(
      withFlag,
      withoutFlag,
      '--allow-dual-install must not move the vault hook target: doctor has no such flag, and the two tools disagreeing is what let a user undo their own repoint',
    );
    // Both runs must POSITIVELY resolve the registry root. A null on either side
    // would let the equality above pass for the wrong reason.
    assert.equal(
      withoutFlag,
      registryRoot,
      `without the flag the hook target must be the registry root: ${withoutFlag}`,
    );
    assert.equal(
      withFlag,
      registryRoot,
      `--allow-dual-install must not swap the hook target for this manual PKG_ROOT: ${withFlag}`,
    );
    assert.ok(
      !String(withFlag).startsWith(root),
      'the manual/npm checkout is never the durable hook root while a plugin install resolves',
    );

    // The field above is a diagnostic, not the artifact. Prove the actual
    // contract (the flag does not change what --apply WRITES) on the real
    // output: re-seed the same old-form hook, --apply with and without the
    // flag, and compare the bytes on disk. The migrated form never bakes a
    // root in either way (git-hooks-dir.mjs's runtime resolver), so a match
    // here is expected, but it is the artifact this test was actually named
    // for, not the wantRoot field alone.
    const hookPath = join(wiki, '.git', 'hooks', 'pre-commit');
    const pkgJsonPath = join(home, '.claude', 'hypo-pkg.json');
    const pkgJsonBefore = existsSync(pkgJsonPath) ? readFileSync(pkgJsonPath, 'utf-8') : null;

    seedWikiPreCommitHook(wiki, join(tmpdir(), `hypo-stale-1-6-0-${process.pid}`), false);
    const applyWithout = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(applyWithout.status, 0, `--apply failed: ${applyWithout.stderr}`);
    const hookWithout = readFileSync(hookPath, 'utf-8');

    // Reset hypo-pkg.json to its pre-apply state before the second run. The
    // first --apply's dual-skip provenance correction bumps its recorded
    // pkgVersion to the registry root's 9.9.9, and this package's own version
    // (1.8.2) would then trip upgrade.mjs's UNRELATED downgrade guard on the
    // second call — an artifact of running --apply twice against the same
    // fixture, not something this test is measuring.
    if (pkgJsonBefore === null) rmSync(pkgJsonPath, { force: true });
    else writeFileSync(pkgJsonPath, pkgJsonBefore);

    seedWikiPreCommitHook(wiki, join(tmpdir(), `hypo-stale-1-6-0-${process.pid}`), false);
    const applyWith = runUpgrade(
      upgrade,
      [`--hypo-dir=${wiki}`, '--apply', '--allow-dual-install'],
      home,
    );
    assert.equal(applyWith.status, 0, `--apply --allow-dual-install failed: ${applyWith.stderr}`);
    const hookWith = readFileSync(hookPath, 'utf-8');

    assert.equal(
      hookWith,
      hookWithout,
      '--allow-dual-install must not change a single byte of the vault hook --apply writes',
    );
    assert.doesNotMatch(
      hookWithout,
      /'\/[^']*\/hooks\/hypo-pre-commit\.mjs'/,
      'the migrated hook must resolve the install root at commit time, never bake an absolute path',
    );
  });
});

test('dual install + no registry entry: --apply still migrates the old-form hook (migrating needs no resolved root)', () => {
  withDualInstall(true, ({ upgrade, home, wiki }) => {
    // Plugin enabled in settings.json, but no installed_plugins.json at all —
    // resolveEnabledPluginRoot fails open to null. Unlike the old repoint
    // (which had to pick a CORRECT root to bake in, and so had to stay silent
    // when it could not resolve one), migrating onto the resolver form needs
    // no root at all: the rewritten hook looks one up itself, fresh, at every
    // future commit. So an unresolvable registry must NOT block the migration.
    // Under tmpdir, not a literal "/some/old/...": seedWikiPreCommitHook has
    // to create this root (the old form is only ours when the root is a real
    // install), and nothing in this suite may write outside a temp dir.
    const staleRoot = join(tmpdir(), `hypo-stale-unresolvable-registry-${process.pid}`);
    const hookPath = seedWikiPreCommitHook(wiki, staleRoot, false);
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply', '--json'], home);
    assert.equal(r.status, 0, `dual-install --apply should exit 0: ${r.stderr}`);
    assert.match(
      readFileSync(hookPath, 'utf-8'),
      /node -e '/,
      'an unresolvable registry must not stop the old-form hook from being migrated',
    );
    assert.ok(
      !readFileSync(hookPath, 'utf-8').includes(staleRoot),
      'the stale root must not survive the migration',
    );
    // Names what WAS actually seeded/parsed before the mutation above, so a
    // report of "current: null" here would mean "never found the seeded hook
    // in the first place" rather than "already migrated" — the two must stay
    // distinguishable even though wantRoot has nothing to do with the outcome.
    const out = JSON.parse(r.stdout);
    assert.equal(
      out.wikiPreCommitRoot?.current,
      staleRoot,
      'doctor/upgrade must have actually found and parsed the seeded (pre-migration) hook',
    );
    assert.equal(
      out.wikiPreCommitRoot?.wantRoot,
      null,
      'an unresolvable dual-install registry must report wantRoot as null, not a guess',
    );
  });
});

test("plugin mode: --apply on a --lint-strict hook migrates it while preserving the EMBEDDED --hypo-dir, not this run's", () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const staleRoot = join(tmpdir(), 'hypo-stale-lintstrict-root');
    // Deliberately NOT `wiki` (the --hypo-dir this run's `--apply` passes), so
    // a regression that substitutes the current run's --hypo-dir for the
    // preserved embedded one is caught: upgrade.mjs previously called
    // wikiPreCommitContent(wantRoot, args.hypoDir, ...) here, silently
    // repointing the lint gate at whatever --hypo-dir happened to be passed
    // this run rather than the one the hook was actually built for.
    const embeddedHypoDir = join(tmpdir(), 'hypo-embedded-hypo-dir-differs-from-this-run');
    const hookPath = seedWikiPreCommitHook(wiki, staleRoot, true, embeddedHypoDir);
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `--apply should exit 0: ${r.stderr}\n${r.stdout}`);
    const hook = readFileSync(hookPath, 'utf-8');
    assert.ok(
      hook.includes('/scripts/lint.mjs'),
      `the --lint-strict step must survive the migration, not be dropped: ${hook}`,
    );
    assert.equal(
      hook,
      wikiPreCommitContent(embeddedHypoDir, true),
      'a migrated --lint-strict hook must keep the embedded --hypo-dir, and bake in no root at all',
    );
    assert.ok(
      !hook.includes(wiki),
      "this run's --hypo-dir must not leak into the hook when it differs from the embedded one",
    );
    assert.ok(!hook.includes(staleRoot), 'the stale root must not survive the migration');
  });
});

test('plugin mode: --apply refuses a --lint-strict hook whose embedded --hypo-dir is relative', () => {
  withFakeUpgradeInstall(true, ({ upgrade, root, home, wiki }) => {
    const staleRoot = join(tmpdir(), 'hypo-stale-relative-hypodir-root');
    // seedWikiPreCommitHook cannot produce this: legacyWikiPreCommitContent()
    // resolves the value before baking it, so a relative --hypo-dir only ever
    // reaches the hook through a hand edit. That edit still passes the
    // ownership check (isOwnedWikiPreCommitBody validates the marker span and
    // line shape, not whether the path is absolute), so the refusal branch in
    // applyWikiPreCommitRoot is reachable in practice, not dead code. Without
    // this test that branch has no red to prove it, and the next refactor that
    // "helpfully" resolve()s the value would silently defeat it: upgrade's cwd
    // is never what a relative --hypo-dir there was meant to mean.
    const hookPath = seedWikiPreCommitHook(wiki, staleRoot, true);
    const relative = readFileSync(hookPath, 'utf-8').replace(
      /--hypo-dir='[^']*'/,
      "--hypo-dir='relative/vault'",
    );
    writeFileSync(hookPath, relative, { mode: 0o755 });
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `a refusal must not fail the whole upgrade: ${r.stderr}`);
    assert.equal(
      readFileSync(hookPath, 'utf-8'),
      relative,
      'a hook with a relative embedded --hypo-dir must be left byte-for-byte untouched',
    );
    assert.ok(
      !readFileSync(hookPath, 'utf-8').includes(realpathSync(root)),
      'refusing means the root is not repointed either: the whole rewrite is skipped',
    );
  });
});

// This asserts doctor.mjs's output, which by area rules belongs in
// tests/doctor.test.mjs, and it stays here anyway: it reuses
// withFakeUpgradeInstall / seedWikiPreCommitHook, both local to this file, and
// moving the assertion alone would mean lifting that fixture into
// tests/helpers.mjs — the one file CLAUDE.md says to keep as small as
// possible because every line in it is a conflict handed to someone else. One
// misplaced assertion is a smaller cost than a second area now sharing a
// fixture only this one needs.
test('doctor reports a stale pre-commit root without excluding it from the active-install answer', () => {
  withFakeUpgradeInstall(true, ({ root, home, wiki }) => {
    const staleRoot = join(tmpdir(), 'hypo-stale-doctor-root');
    seedWikiPreCommitHook(wiki, staleRoot, false);
    const doctor = join(root, 'scripts', 'doctor.mjs');
    const r = spawnSync(process.execPath, [doctor, `--hypo-dir=${wiki}`, '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: home },
    });
    const out = JSON.parse(r.stdout);
    const rootCheck = out.find((c) => c.label === 'git hooks/pre-commit root');
    assert.ok(rootCheck, `expected a pre-commit root drift check: ${r.stdout}`);
    assert.equal(rootCheck.status, 'warn', 'a stale root must be reported, not silently passed');
    assert.ok(
      rootCheck.detail.includes(staleRoot),
      `detail must name the stale root: ${rootCheck.detail}`,
    );
    // The recovery command has to be RUNNABLE on the channel it is printed for.
    // This fixture is a plugin install, which has no `hypomnema` on PATH: the
    // CLI bin belongs to the npm package, the plugin manifest ships commands
    // only. Naming the binary here would send a plugin user to a command they
    // cannot run, the same defect the update notifier had.
    assert.match(
      rootCheck.detail,
      /\/hypo:upgrade/,
      `a plugin install must be pointed at the slash command: ${rootCheck.detail}`,
    );
    assert.doesNotMatch(
      rootCheck.detail,
      /hypomnema upgrade --apply/,
      `a plugin install must not be told to run the npm binary: ${rootCheck.detail}`,
    );
    // The plugin-cache leaf-drift precedent this mirrors exists precisely
    // because excluding a drifted root from resolution left users pointed at a
    // directory that no longer existed — reporting must stay additive, so the
    // active root doctor names here must still be a real, resolvable install.
    assert.ok(
      existsSync(realpathSync(root)),
      'the root doctor names as active must still resolve to a real directory',
    );
    const markerCheck = out.find((c) => c.label === 'git hooks/pre-commit');
    assert.equal(markerCheck?.status, 'pass', 'the marker/guard check itself must stay a pass');
  });
});

// A hook that carries our marker but a body checkWikiPreCommitRoot cannot
// read (hand-edited, corrupted). Before this fix that state was silent on
// both surfaces: upgrade.mjs printed no "Wiki pre-commit" line at all, and
// doctor.mjs's marker-substring check still passed it. This is not the "root
// gone" case above (that one is now readable, see seedWikiPreCommitHook's
// comment): it is genuinely unparseable, so unlike a stale root it can never
// migrate itself; both surfaces must say so instead of staying quiet.
function seedUnrecognizedWikiPreCommitHook(wiki, root) {
  const hookPath = seedWikiPreCommitHook(wiki, root, false);
  const broken = readFileSync(hookPath, 'utf-8').replace('exit 0\n', '');
  writeFileSync(hookPath, broken, { mode: 0o755 });
  return hookPath;
}

test('plugin mode: --apply reports an unreadable-but-marked pre-commit hook instead of staying silent', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    seedUnrecognizedWikiPreCommitHook(wiki, join(tmpdir(), 'hypo-unrecognized-root'));
    // Not asserting the exit code here: a fresh fixture already carries
    // unrelated baseline drift (commands, schema, ...) that makes a
    // check-only run exit non-zero regardless of the pre-commit hook, so it
    // proves nothing about THIS check. `wikiPreCommitRoot.drift` below is the
    // narrow assertion.
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`], home);
    assert.match(
      r.stdout,
      /Wiki pre-commit.*not recognized/,
      `an unparseable-but-marked hook must be named, not silently skipped: ${r.stdout}`,
    );
    const json = JSON.parse(runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--json'], home).stdout);
    assert.equal(
      json.wikiPreCommitRoot?.unrecognized,
      true,
      'JSON output must carry the same distinction the text report makes',
    );
    assert.equal(
      json.wikiPreCommitRoot?.drift,
      false,
      'an unrecognized body is not the same as drift: there is no root here to migrate',
    );
  });
});

test('plugin mode: --apply never attempts to rewrite an unreadable-but-marked pre-commit hook', () => {
  withFakeUpgradeInstall(true, ({ upgrade, home, wiki }) => {
    const hookPath = seedUnrecognizedWikiPreCommitHook(
      wiki,
      join(tmpdir(), 'hypo-unrecognized-root-apply'),
    );
    const before = readFileSync(hookPath, 'utf-8');
    const r = runUpgrade(upgrade, [`--hypo-dir=${wiki}`, '--apply'], home);
    assert.equal(r.status, 0, `--apply should exit 0: ${r.stderr}`);
    assert.equal(
      readFileSync(hookPath, 'utf-8'),
      before,
      '--apply must leave a body it cannot parse byte-for-byte untouched, not guess at a rewrite',
    );
  });
});

test('doctor reports an unreadable-but-marked pre-commit hook, not a silent pass', () => {
  withFakeUpgradeInstall(true, ({ root, home, wiki }) => {
    seedUnrecognizedWikiPreCommitHook(wiki, join(tmpdir(), 'hypo-unrecognized-root-doctor'));
    const doctor = join(root, 'scripts', 'doctor.mjs');
    const r = spawnSync(process.execPath, [doctor, `--hypo-dir=${wiki}`, '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: home },
    });
    const out = JSON.parse(r.stdout);
    const rootCheck = out.find((c) => c.label === 'git hooks/pre-commit root');
    assert.ok(
      rootCheck,
      `expected a pre-commit root check even for an unparseable body: ${r.stdout}`,
    );
    assert.equal(
      rootCheck.status,
      'warn',
      'a hook doctor cannot read must warn, not pass silently, per the marker-only substring check above it',
    );
    const markerCheck = out.find((c) => c.label === 'git hooks/pre-commit');
    assert.equal(
      markerCheck?.status,
      'pass',
      'the marker-substring check stays a pass, the root check next to it is what must now catch this',
    );
  });
});

// ── ISSUE-80: --apply refreshes the provenance sidecar (scripts/lib/pkg-provenance.mjs) ──
suite('upgrade.mjs — provenance sidecar refresh (ISSUE-80)');

function repoHypoSharedSha256() {
  return createHash('sha256')
    .update(readFileSync(join(HOOKS, 'hypo-shared.mjs')))
    .digest('hex');
}

test('--apply refreshes a corrupted claude-side provenance sidecar (scripts/upgrade.mjs:1144)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const sidecarPath = join(home, '.claude', 'hooks', PROVENANCE_FILENAME);
      assert.ok(existsSync(sidecarPath), 'pre-state: init must have written the sidecar');
      // Corrupt it so a real regression (upgrade never touching it) is
      // distinguishable from "it happened to already be correct".
      writeFileSync(sidecarPath, '{not json');

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply'], home);
      assert.equal(r.status, 0, `upgrade --apply failed: ${r.stderr}`);

      const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf-8'));
      assert.equal(sidecar.pkgRoot, REPO, '--apply must rewrite the sidecar pkgRoot');
      assert.equal(
        sidecar.hypoSharedSha256,
        repoHypoSharedSha256(),
        '--apply must rewrite the sidecar hash to match the installed hypo-shared.mjs',
      );
    });
  });
});

// scripts/upgrade.mjs:1206 mirrors the same write for the codex hooks
// directory, but only under `if (args.codex)`. --codex has no dependency
// on a codex CLI actually being installed (applyHookFiles mkdirSync's the
// target unconditionally), so the fixture just needs the flag.
test('--apply --codex writes the provenance sidecar into the codex hooks dir (scripts/upgrade.mjs:1206)', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const r = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--apply', '--codex'], home);
      assert.equal(r.status, 0, `upgrade --apply --codex failed: ${r.stderr}`);

      const codexSidecarPath = join(home, '.codex', 'hooks', PROVENANCE_FILENAME);
      assert.ok(
        existsSync(codexSidecarPath),
        '--apply --codex must write the codex-side provenance sidecar',
      );
      const sidecar = JSON.parse(readFileSync(codexSidecarPath, 'utf-8'));
      assert.equal(sidecar.pkgRoot, REPO, 'codex sidecar pkgRoot must point at this package');
      assert.equal(
        sidecar.hypoSharedSha256,
        repoHypoSharedSha256(),
        'codex sidecar hash must match the installed hypo-shared.mjs',
      );
    });
  });
});

// ── ISSUE-139: SCHEMA delta text on the upgrade notice ─────────────────────
// Before this, the SCHEMA drift notice named only the two version numbers.
// A user's SCHEMA.md is a translated, hand-extended document, so a raw diff
// against the shipped template is dominated by noise unrelated to the actual
// upstream change; the notice now names what each version in between added.

suite('lib/template-schema-version.mjs — schemaVersionDeltas (ISSUE-139)');

// Reads the source text, not the loaded object: by the time the module is
// imported a key written as `2.10:` has ALREADY collapsed to "2.1", and no
// runtime check can tell the two apart. The day SCHEMA.md reaches 2.10 the
// obvious way to add a line is the broken one, and the failure is silent —
// either 2.1's entry is overwritten or 2.10's text goes to someone upgrading
// across 2.1. Prettier keeps the quotes once they are there but will not put
// them there for you, so this is the only place that can catch it.
test('every SCHEMA_VERSION_DELTAS key with a trailing zero is quoted (2.10 is not 2.1)', () => {
  const src = readFileSync(join(REPO, 'scripts', 'lib', 'template-schema-version.mjs'), 'utf-8');
  const block = src.slice(
    src.indexOf('export const SCHEMA_VERSION_DELTAS'),
    src.indexOf('function parseMinorVersion'),
  );
  assert.ok(block.length > 0, 'could not locate the SCHEMA_VERSION_DELTAS block');
  const bad = [...block.matchAll(/^\s*(\d+\.\d*0)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual(
    bad,
    [],
    `these keys are unquoted number literals whose trailing zero is dropped ` +
      `(${bad.join(', ')}) — quote them: '2.10', not 2.10`,
  );
});

test('names the real 2.1 → 2.2 change (sources_consulted, PR #290)', () => {
  const result = schemaVersionDeltas('2.1', '2.2');
  assert.equal(result.length, 1, `expected exactly one delta line: ${JSON.stringify(result)}`);
  assert.ok(
    result[0].includes('sources_consulted'),
    `2.1 → 2.2 delta must name sources_consulted: ${result[0]}`,
  );
});

test('a multi-minor gap reports every version crossed, not just the endpoint', () => {
  // Injected map, not SCHEMA_VERSION_DELTAS: this isolates the stepping logic
  // from how many real bumps happen to exist right now. A version-off-by-one
  // implementation (e.g. one that only checks installed+1 === current) would
  // return nothing here since 2.0 → 2.2 is a two-step gap.
  const injected = { 2.1: 'first change', 2.2: 'second change' };
  const result = schemaVersionDeltas('2.0', '2.2', injected);
  assert.deepEqual(
    result,
    ['2.1: first change', '2.2: second change'],
    `expected both in-between versions in ascending order: ${JSON.stringify(result)}`,
  );
});

test('a version the map has no entry for yields nothing (no invented text)', () => {
  const result = schemaVersionDeltas('9.8', '9.9', SCHEMA_VERSION_DELTAS);
  assert.deepEqual(result, [], `unmapped version range must not fabricate a delta: ${result}`);
});

test('installed at or after current yields nothing', () => {
  assert.deepEqual(schemaVersionDeltas('2.2', '2.2'), []);
  assert.deepEqual(schemaVersionDeltas('2.2', '2.1'), []);
});

suite('upgrade.mjs — SCHEMA minor-bump notice includes the delta (ISSUE-139)');

test('a single-minor-step bump names the change in the text report', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      const schemaPath = join(hypoDir, 'SCHEMA.md');
      writeFileSync(
        schemaPath,
        readFileSync(schemaPath, 'utf-8').replace(/^version: .+$/m, 'version: 2.1'),
      );

      const jsonR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(jsonR.stdout);
      assert.equal(
        out.schema.bump,
        'minor',
        `expected minor bump from 2.1: ${JSON.stringify(out.schema)}`,
      );

      const textR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.ok(
        /SCHEMA version.*2\.1 → 2\.2/.test(textR.stdout),
        `text report must still show the version bump: ${textR.stdout}`,
      );
      assert.ok(
        textR.stdout.includes('sources_consulted'),
        `text report must name what 2.2 added, not just the version numbers: ${textR.stdout}`,
      );
    });
  });
});

test('a two-minor-step bump still names the in-between change, not just the endpoint', () => {
  withTmpHome((home) => {
    withTmpDir((dir) => {
      const hypoDir = join(dir, 'wiki');
      const initR = runWithHome('init.mjs', [`--hypo-dir=${hypoDir}`, '--no-git-init'], home);
      assert.equal(initR.status, 0, `init failed: ${initR.stderr}`);

      // init stamps the current template; roll the wiki SCHEMA back to 2.0,
      // two minor versions behind whatever templates/SCHEMA.md currently ships.
      const schemaPath = join(hypoDir, 'SCHEMA.md');
      writeFileSync(
        schemaPath,
        readFileSync(schemaPath, 'utf-8').replace(/^version: .+$/m, 'version: 2.0'),
      );

      const jsonR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`, '--json'], home);
      const out = JSON.parse(jsonR.stdout);
      assert.equal(
        out.schema.bump,
        'minor',
        `expected minor bump from 2.0: ${JSON.stringify(out.schema)}`,
      );

      const textR = runWithHome('upgrade.mjs', [`--hypo-dir=${hypoDir}`], home);
      assert.ok(
        textR.stdout.includes('sources_consulted'),
        `text report must name the 2.2 change even when installed is two minors behind: ${textR.stdout}`,
      );
    });
  });
});
