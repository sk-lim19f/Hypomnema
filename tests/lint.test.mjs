// tests/lint.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSchemaVocab, appendPendingTags } from '../scripts/lib/schema-vocab.mjs';
import { fencedLineMask, maskNonProse, retiredLineMask } from '../scripts/lib/code-fence.mjs';
import { parseFrontmatter as libParseFrontmatter } from '../scripts/lib/frontmatter.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
  REPO,
  SCRIPTS,
  SESSION_TMP_HOME,
  findDesignHistoryStale,
  payloadForCleanWiki,
  run,
  runApply,
  setupDhProject,
  withTmpDir,
  withWiki,
} from './helpers.mjs';

// ── lint.mjs --fix tests ─────────────────────────────────────────────────────

suite('lint.mjs --fix');

function lintFix(content) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-'));
  const pagesDir = join(dir, 'pages');
  mkdirSync(pagesDir);
  writeFileSync(join(pagesDir, 'test.md'), content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--fix', '--json']);
  const fixed = readFileSync(join(pagesDir, 'test.md'), 'utf-8');
  rmSync(dir, { recursive: true, force: true });
  return { r, fixed };
}

test('--fix inserts updated into LF frontmatter', () => {
  const { fixed } = lintFix('---\ntitle: T\ntype: concept\n---\nbody\n');
  const fm = fixed.slice(0, fixed.indexOf('\n---\n') + 5);
  assert.ok(fm.includes('updated:'), 'updated not inserted into frontmatter');
  assert.ok(
    !fixed.slice(fixed.indexOf('\n---\n') + 5).includes('updated:'),
    'updated inserted outside frontmatter',
  );
});

test('--fix inserts updated into CRLF frontmatter', () => {
  const { fixed } = lintFix('---\r\ntitle: T\r\ntype: concept\r\n---\r\nbody\r\n');
  assert.ok(fixed.includes('updated:'), 'updated not inserted');
  const fmEnd = fixed.indexOf('\r\n---\r\n');
  assert.ok(fixed.indexOf('updated:') < fmEnd, 'updated inserted outside frontmatter');
});

test('--fix handles mixed line endings (LF frontmatter + CRLF body)', () => {
  const { fixed } = lintFix('---\ntitle: T\ntype: concept\n---\r\nbody\r\n');
  const fmEnd = fixed.indexOf('\n---\r\n');
  assert.ok(fmEnd > 0, 'frontmatter closing not found');
  const updatedPos = fixed.indexOf('updated:');
  assert.ok(
    updatedPos > 0 && updatedPos < fmEnd,
    `updated at ${updatedPos}, fm closes at ${fmEnd}`,
  );
});

test('--fix skips file with no frontmatter', () => {
  const { fixed } = lintFix('# No frontmatter here\nbody\n');
  assert.ok(!fixed.includes('updated:'), 'should not insert updated into file without frontmatter');
});

test('--json output omits internal path field', () => {
  const { r } = lintFix('---\ntitle: T\ntype: concept\n---\nbody\n');
  const out = JSON.parse(r.stdout);
  const allIssues = [...(out.errors || []), ...(out.warns || [])];
  assert.ok(
    allIssues.every((i) => !('path' in i)),
    'path field leaked into JSON output',
  );
});

suite('lint.mjs session-state schema');

function lintSessionState(content) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-state-'));
  const projectDir = join(dir, 'projects', 'proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'session-state.md'), content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(dir, { recursive: true, force: true });
  return { r, out };
}

test('accepts 다음 작업 as a session-state next heading alias', () => {
  const { r, out } = lintSessionState(
    '---\ntitle: Session State\ntype: session-state\nupdated: 2026-05-07\n---\n# Session State\n\n## 다음 작업\n\n- Continue\n',
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.deepEqual(out.errors, []);
});

test('errors when project session-state lacks a next heading', () => {
  const { r, out } = lintSessionState(
    '---\ntitle: Session State\ntype: session-state\nupdated: 2026-05-07\n---\n# Session State\n\n## Background\n\n- Missing next section\n',
  );
  assert.equal(r.status, 1, `expected lint error\nstdout: ${r.stdout}`);
  assert.ok(
    out.errors.some(
      (i) =>
        i.file === 'projects/proj/session-state.md' &&
        i.message.includes('Missing required session-state heading'),
    ),
    `missing session-state heading error: ${r.stdout}`,
  );
});

// ── lint.mjs type-conditional + tag vocab tests ─────────────
// @fix #15: all type-conditional fields present → green
// @fix #36: PascalCase tag → error
// @fix #36: unknown tag (not in vocab) → error

suite('lint.mjs type-conditional required fields');

const VOCAB_SCHEMA =
  '---\ntitle: SCHEMA\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n`wiki` `project` `prd` `adr` `concept` `learning` `feedback`\n\n## 5. Next\n';

function lintWithSchema(pageRel, content, schemaContent = VOCAB_SCHEMA) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-cond-'));
  writeFileSync(join(dir, 'SCHEMA.md'), schemaContent);
  const fullPath = join(dir, pageRel);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(r.stdout);
  rmSync(dir, { recursive: true, force: true });
  return { r, out };
}

test('prd missing started → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/prd.md',
    '---\ntitle: T\ntype: prd\nstatus: active\nupdated: 2026-05-18\ntags: [prd]\n---\nbody\n',
  );
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Missing required field for type "prd": started')),
    `started error missing: ${r.stdout}`,
  );
});

test('adr missing source → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/decisions/0001-x.md',
    '---\ntitle: T\ntype: adr\nstatus: accepted\ndate: 2026-05-18\nupdated: 2026-05-18\ntags: [adr]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Missing required field for type "adr": source')),
  );
});

// A-1/BLOCKER fix: working_dir dropped from project-index's required fields.
// An index without a cwd anchor is a genuine, unfilled state (crystallize.mjs's
// auto-created index has none to substitute) — it must lint clean, not error.
// status/started stay required (they always have a real value).
test('project-index missing working_dir → clean (no longer required), but W13 warns', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `missing working_dir must not error: ${r.stdout}`);
  assert.ok(
    !out.errors.some((e) => e.message.includes('working_dir')),
    `working_dir must not be flagged as an ERROR: ${r.stdout}`,
  );
  // CONCERN 1 fix: a missing anchor is a WARNING (W13) — doctor's manual report
  // is not the only surface this shows up on, and cwd-first backfill only
  // fires when the cwd's leaf directory name happens to match the slug.
  assert.ok(
    out.warns.some((w) => w.message.includes('working_dir anchor')),
    `expected a W13-style missing-anchor warning: ${r.stdout}`,
  );
});

test('project-index with an EMPTY working_dir (crystallize.mjs A-1 shape) → W13 warns, no error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\nworking_dir: \ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `empty working_dir must not error: ${r.stdout}`);
  // Matched by message, not `id`: non-strict --json omits `id` on every
  // warning class except W8 (lint.mjs's byte-identical-default guarantee) —
  // `--strict does not promote W13` below is what checks the `id` itself.
  assert.ok(
    out.warns.some((w) => w.message.includes('working_dir anchor')),
    `expected a missing-anchor warning for an empty (present-but-blank) working_dir: ${r.stdout}`,
  );
});

test('project-index WITH a real working_dir → no working_dir-anchor warning', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\nworking_dir: /real/path\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `well-anchored index must lint clean: ${r.stdout}`);
  assert.ok(
    !out.warns.some((w) => w.message.includes('working_dir anchor')),
    `an anchored project-index must not trip the missing-anchor warning: ${r.stdout}`,
  );
});

test('--strict does not promote W13 (stays a warn, exit 0)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-w13-'));
  writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
  const pagePath = join(dir, 'projects', 'p', 'index.md');
  mkdirSync(dirname(pagePath), { recursive: true });
  writeFileSync(
    pagePath,
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json', '--strict']);
  const out = JSON.parse(r.stdout);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `W13 is excluded from STRICT_PROMOTE_IDS → exit 0: ${r.stdout}`);
  assert.ok(
    out.warns.some((w) => w.id === 'W13'),
    `W13 must stay a warn under --strict: ${r.stdout}`,
  );
});

test('project-index missing status/started → still errors (contract unchanged for those)', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 1, `missing status/started must still error: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "project-index": status'),
    ),
  );
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "project-index": started'),
    ),
  );
});

test('postmortem missing outcome → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/postmortems/2026-05-18-x.md',
    '---\ntitle: T\ntype: postmortem\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "postmortem": outcome'),
    ),
  );
});

test('prd with invalid status enum → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/prd.md',
    '---\ntitle: T\ntype: prd\nstatus: in-progress\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [prd]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(out.errors.some((e) => e.message.includes('Invalid value for status on type "prd"')));
});

test('all type-conditional fields present → green', () => {
  const { r } = lintWithSchema(
    'projects/p/prd.md',
    '---\ntitle: T\ntype: prd\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [prd]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `expected green, got ${r.status}`);
});

test('weekly-journal under journal/weekly missing week → error (scanDirs covers journal/)', () => {
  const { r, out } = lintWithSchema(
    'journal/weekly/2026-W19.md',
    '---\ntitle: T\ntype: weekly-journal\nupdated: 2026-05-18\ntags: [wiki]\n---\nbody\n',
  );
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "weekly-journal": week'),
    ),
    `weekly-journal week error missing: ${r.stdout}`,
  );
});

// feedback type — ADR 0031 / fix #37 conditional schema
const FB_FM_OK =
  '---\ntitle: T\ntype: feedback\nstatus: active\nscope: global\ntier: L1\n' +
  'targets: [project-memory, claude-learned]\nsensitivity: public\npriority: 3\n' +
  'memory_summary: m\nglobal_summary: g\npromote_to_global: true\nreason: r\n' +
  'source: session:2026-05-20\nupdated: 2026-05-20\ntags: [feedback]\n---\nbody\n';

test('feedback fully populated → no error', () => {
  const { r } = lintWithSchema('pages/feedback/ok.md', FB_FM_OK);
  assert.equal(r.status, 0, `expected clean, got ${r.status}: ${r.stdout}`);
});

test('feedback missing tier → error', () => {
  const { r, out } = lintWithSchema('pages/feedback/x.md', FB_FM_OK.replace('tier: L1\n', ''));
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Missing required field for type "feedback": tier')),
    `tier error missing: ${r.stdout}`,
  );
});

test('feedback sensitivity:private → error (forbidden vocabulary)', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('sensitivity: public', 'sensitivity: private'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid value for sensitivity')),
    `private sensitivity must error: ${r.stdout}`,
  );
});

test('feedback claude-learned target without global_summary → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('global_summary: g\n', ''),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('targets:claude-learned: global_summary')),
    `conditional global_summary error missing: ${r.stdout}`,
  );
});

test('feedback project-memory-only target does NOT require global_summary', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('targets: [project-memory, claude-learned]', 'targets: [project-memory]')
      .replace('global_summary: g\n', '')
      .replace('promote_to_global: true\n', '')
      .replace('scope: global', 'scope: project:hypomnema')
      .replace('tier: L1', 'tier: L2'),
  );
  assert.equal(r.status, 0, `project-memory-only feedback should be clean: ${r.stdout}`);
});

test('feedback invalid scope → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('scope: global', 'scope: team'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid feedback scope')),
    `invalid scope must error: ${r.stdout}`,
  );
});

// ── Track D (OQ-34): scope regex accepts cwd-derived project-ids ──────────────
// deriveProjectId emits leading-dash, mixed-case ids (cwd `/`,`.` → `-`). The
// v1.2 regex `^project:[a-z0-9][a-z0-9-]*$` rejected them, forcing a
// `--project-id=<slug>` override; v1.3 relaxes the shared FEEDBACK_SCOPE_RE to
// `^(global|project:[A-Za-z0-9_-]+)$`. These cover the lint stage of the
suite('Track D (OQ-34): scope regex accepts cwd-derived project-ids');
// create → lint → projection consistency chain plus the hardening edges from
// the codex design review (`.` excluded → no `project:.`/`project:..`; spaces
// still rejected = documented limit).
test('feedback scope: cwd-derived project-id (leading dash, mixed case) → no error', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('targets: [project-memory, claude-learned]', 'targets: [project-memory]')
      .replace('global_summary: g\n', '')
      .replace('promote_to_global: true\n', '')
      .replace('scope: global', 'scope: project:-Users-you-Workspace-Project')
      .replace('tier: L1', 'tier: L2'),
  );
  assert.equal(r.status, 0, `cwd-derived scope must lint clean: ${r.stdout}`);
});

test('feedback scope: existing short slug still accepted (backcompat regression)', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('targets: [project-memory, claude-learned]', 'targets: [project-memory]')
      .replace('global_summary: g\n', '')
      .replace('promote_to_global: true\n', '')
      .replace('scope: global', 'scope: project:hypomnema')
      .replace('tier: L1', 'tier: L2'),
  );
  assert.equal(r.status, 0, `short slug must remain clean: ${r.stdout}`);
});

test('feedback scope: dot-only project-id (project:. / project:..) → error', () => {
  for (const bad of ['project:.', 'project:..']) {
    const { r, out } = lintWithSchema(
      'pages/feedback/x.md',
      FB_FM_OK.replace('scope: global', `scope: ${bad}`),
    );
    assert.equal(r.status, 1, `${bad} must error`);
    assert.ok(
      out.errors.some((e) => e.message.includes('Invalid feedback scope')),
      `${bad} must be rejected: ${r.stdout}`,
    );
  }
});

test('feedback scope: cwd-derived id with space still rejected (documented limit) → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('scope: global', 'scope: project:-Users-My Name-Proj'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid feedback scope')),
    `space-bearing derived id must error: ${r.stdout}`,
  );
});

test('feedback status:superseded + sensitivity:sanitized → no error (allowed enums)', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('status: active', 'status: superseded').replace(
      'sensitivity: public',
      'sensitivity: sanitized',
    ),
  );
  assert.equal(r.status, 0, `superseded+sanitized must be clean: ${r.stdout}`);
});

test('feedback invalid tier → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('tier: L1', 'tier: L3'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid value for tier')),
    `invalid tier must error: ${r.stdout}`,
  );
});

// ── FEAT-1: optional failure_type enum ──────────────────────────────────────
suite('FEAT-1: optional failure_type enum');
test('feedback failure_type valid value → no error', () => {
  const { r } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('reason: r\n', 'reason: r\nfailure_type: incompleteness\n'),
  );
  assert.equal(r.status, 0, `valid failure_type must lint clean: ${r.stdout}`);
});

test('feedback failure_type invalid value → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('reason: r\n', 'reason: r\nfailure_type: tool-misuse\n'),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Invalid value for failure_type')),
    `invalid failure_type must error: ${r.stdout}`,
  );
});

test('feedback failure_type omitted → no error (optional, migration-safe)', () => {
  // FB_FM_OK carries no failure_type; assert the field is genuinely optional.
  const { r } = lintWithSchema('pages/feedback/x.md', FB_FM_OK);
  assert.equal(r.status, 0, `omitted failure_type must be clean: ${r.stdout}`);
});

test('feedback claude-learned target without promote_to_global → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('promote_to_global: true\n', ''),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('targets:claude-learned: promote_to_global')),
    `conditional promote_to_global error missing: ${r.stdout}`,
  );
});

test('feedback missing targets → error', () => {
  const { r, out } = lintWithSchema(
    'pages/feedback/x.md',
    FB_FM_OK.replace('targets: [project-memory, claude-learned]\n', ''),
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "feedback": targets'),
    ),
    `missing targets error: ${r.stdout}`,
  );
});

// working_dir/project are legitimate only on project-index (index.md);
// session-state.md pages have been observed picking up a stray copy from
// unvalidated crystallize output, planting a wrong path that pollutes
// injected context. Lint must flag (not silently accept) either key on
// session-state.
suite('lint.mjs forbidden frontmatter fields on session-state');

const SS_FM_OK =
  '---\ntitle: T\ntype: session-state\nupdated: 2026-05-18\ntags: [project]\n---\n## Next\nbody\n';

test('session-state with a stray working_dir → warn, not error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/session-state.md',
    SS_FM_OK.replace('updated: 2026-05-18', 'updated: 2026-05-18\nworking_dir: /repo/p'),
  );
  assert.equal(r.status, 0, `forbidden-field must be a warn, not a lint failure: ${r.stdout}`);
  assert.ok(
    out.warns.some((w) => w.message.includes('working_dir') && w.message.includes('session-state')),
    `expected working_dir forbidden-field warn: ${r.stdout}`,
  );
});

test('session-state with a stray project field → warn', () => {
  const { r, out } = lintWithSchema(
    'projects/p/session-state.md',
    SS_FM_OK.replace('updated: 2026-05-18', 'updated: 2026-05-18\nproject: p'),
  );
  assert.equal(r.status, 0);
  assert.ok(
    out.warns.some((w) => w.message.includes('project') && w.message.includes('session-state')),
    `expected project forbidden-field warn: ${r.stdout}`,
  );
});

test('session-state without working_dir/project → no forbidden-field warn', () => {
  const { r, out } = lintWithSchema('projects/p/session-state.md', SS_FM_OK);
  assert.equal(r.status, 0);
  assert.ok(
    !out.warns.some((w) => w.message.includes('Forbidden frontmatter field')),
    `unexpected forbidden-field warn on a clean page: ${r.stdout}`,
  );
});

test('project-index carrying working_dir is unaffected (field is legitimate there)', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\nworking_dir: /repo/p\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `project-index working_dir must stay clean: ${r.stdout}`);
  assert.ok(
    !(out.warns || []).some((w) => w.message.includes('Forbidden frontmatter field')),
    `project-index must never trip the forbidden-field check: ${r.stdout}`,
  );
});

// ── lint.mjs frontmatter hardening (IMPR-3) ─────────────────────────────────
// A: top-level-only field extraction (nested `type:` no longer clobbers).
// B: W9 invalid-YAML detector (colon-space / tab-indent / dup-key) + strict.
// C: VALID_TYPES ∪ SCHEMA-derived types (vault-local type extensions).

// Direct unit coverage for the shared helper (used by lint, doctor,
// feedback-sync, upgrade). The integration tests below exercise it via lint;
// these pin the contract so the lib function can't silently rot if a consumer
// re-inlines its own parser (the doctor clobber bug that drove consolidation).
suite('lib/frontmatter.mjs parseFrontmatter (shared)');

test('nested type: under a relations list does not clobber top-level type', () => {
  const fm = libParseFrontmatter(
    '---\ntitle: T\ntype: learning\nrelations:\n  - target: y\n    type: depends_on\n---\nbody\n',
  );
  assert.equal(fm.type, 'learning');
  assert.equal(fm['- target'], undefined, 'list item leaked as a key');
});

test('first-wins on a duplicate top-level key', () => {
  const fm = libParseFrontmatter('---\ntype: concept\ntype: reference\n---\nbody\n');
  assert.equal(fm.type, 'concept');
});

test('CRLF frontmatter parses top-level fields', () => {
  const fm = libParseFrontmatter('---\r\ntitle: T\r\ntype: concept\r\n---\r\nbody\r\n');
  assert.equal(fm.type, 'concept');
  assert.equal(fm.title, 'T');
});

test('trailing comment stripped only after whitespace', () => {
  assert.equal(libParseFrontmatter('---\ntype: concept # note\n---\n').type, 'concept');
  assert.equal(libParseFrontmatter('---\ntype: concept#bad\n---\n').type, 'concept#bad');
});

suite('lint.mjs frontmatter hardening (IMPR-3)');

// SCHEMA with a Page Type Taxonomy table — parseSchemaTypes reads the first
// backticked cell of each row, so `working-doc` becomes an accepted type.
const TAXONOMY_SCHEMA = `---
title: SCHEMA
type: schema
---
# Schema

## 1. Page Type Taxonomy

| type | location | mutability |
|------|----------|------------|
| \`concept\` | \`pages/\` | mutable |
| \`working-doc\` | \`projects/*/\` | mutable |

## 4. Tag Vocabulary

\`concept\` \`project\`
`;

function lintStrict(pageRel, content, schemaContent = VOCAB_SCHEMA) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-strict-'));
  writeFileSync(join(dir, 'SCHEMA.md'), schemaContent);
  const fullPath = join(dir, pageRel);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json', '--strict']);
  const out = JSON.parse(r.stdout);
  rmSync(dir, { recursive: true, force: true });
  return { r, out };
}

// A — nested `type:` inside a relations list must not clobber the page type.
test('A: nested type: under relations does not trigger W2 unknown-type', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-06-23\nrelations:\n  - target: y\n    type: depends_on\n---\nbody\n',
  );
  assert.ok(
    !out.warns.some((w) => /Unknown type/.test(w.message)),
    `nested type clobbered top-level: ${r.stdout}`,
  );
});

// B — colon-space in an unquoted top-level value → W9 warn (default), error (--strict).
test('B: unquoted value with ": " → W9 warn', () => {
  const { out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: Plan: phase 2\ntype: concept\nupdated: 2026-06-23\n---\nbody\n',
  );
  const w9 = out.warns.filter((w) => /Invalid YAML/.test(w.message));
  assert.equal(w9.length, 1, `expected one W9 warn: ${JSON.stringify(out.warns)}`);
});

test('B: W9 promoted to error under --strict', () => {
  const { r, out } = lintStrict(
    'pages/x.md',
    '---\ntitle: Plan: phase 2\ntype: concept\nupdated: 2026-06-23\n---\nbody\n',
  );
  assert.equal(r.status, 1, `--strict should exit 1: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.id === 'W9' && /Invalid YAML/.test(e.message)),
    `W9 not promoted: ${r.stdout}`,
  );
});

// B — quoted / flow / commented values containing ":" are valid YAML → no W9.
test('B: quoted, flow, and comment values do not false-positive W9', () => {
  for (const fm of ['title: "a: b"', 'tags: ["a: b"]', 'meta: {a: b}', 'title: foo # note: bar']) {
    const { out } = lintWithSchema(
      'pages/x.md',
      `---\n${fm}\ntype: concept\nupdated: 2026-06-23\n---\nbody\n`,
    );
    assert.ok(!out.warns.some((w) => /Invalid YAML/.test(w.message)), `false W9 on "${fm}"`);
  }
});

// B — duplicate top-level key → W9.
test('B: duplicate top-level key → W9 warn', () => {
  const { out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\ntype: reference\nupdated: 2026-06-23\n---\nbody\n',
  );
  assert.ok(
    out.warns.some((w) => /Invalid YAML.*duplicate key/.test(w.message)),
    `dup-key W9 missing: ${JSON.stringify(out.warns)}`,
  );
});

// C — a vault-local type defined only in SCHEMA's taxonomy is accepted.
test('C: SCHEMA-defined type (working-doc) is not W2 unknown-type', () => {
  const { out } = lintWithSchema(
    'projects/p/scope.md',
    '---\ntitle: T\ntype: working-doc\nupdated: 2026-06-23\n---\nbody\n',
    TAXONOMY_SCHEMA,
  );
  assert.ok(
    !out.warns.some((w) => /Unknown type/.test(w.message)),
    `SCHEMA-defined type flagged: ${JSON.stringify(out.warns)}`,
  );
});

// C — core type stays valid even when SCHEMA has no taxonomy table (union floor).
test('C: core type valid when SCHEMA lacks a taxonomy table', () => {
  const { out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-06-23\n---\nbody\n',
  );
  assert.ok(
    !out.warns.some((w) => /Unknown type/.test(w.message)),
    `core type lost: ${JSON.stringify(out.warns)}`,
  );
});

// C — a non-core type present only in the (template-like) taxonomy is accepted.
test('C: SCHEMA taxonomy row (log) admits a non-core type', () => {
  const schema = TAXONOMY_SCHEMA.replace(
    '| `working-doc` | `projects/*/` | mutable |',
    '| `log` | `log.md` | append-only |',
  );
  const { out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: log\nupdated: 2026-06-23\n---\nbody\n',
    schema,
  );
  assert.ok(
    !out.warns.some((w) => /Unknown type/.test(w.message)),
    `SCHEMA taxonomy type rejected: ${JSON.stringify(out.warns)}`,
  );
});

// B — tabs in block-scalar bodies are valid content, never W9. Covers plain,
// structural-looking (`key:` / `- item`) tabbed lines — W9 inspects only
// top-level lines, so none of these false-positive (codex stage-2/2b guard).
test('B: tab in block-scalar body does not false-positive W9', () => {
  for (const body of ['  \tbar', '  \tkey: value', '  \t- item']) {
    const { out } = lintWithSchema(
      'pages/x.md',
      `---\ntitle: T\ntype: concept\nupdated: 2026-06-23\ndesc: |\n  foo\n${body}\n---\nbody\n`,
    );
    assert.ok(
      !out.warns.some((w) => /Invalid YAML/.test(w.message)),
      `block-scalar tab false-positived on "${body}": ${JSON.stringify(out.warns)}`,
    );
  }
});

// B — `#` without a leading space is a literal scalar char, not a comment, so an
// unknown type like `concept#bad` must still trip W2 (not be silently stripped).
test('B: "#" without leading space is literal (W2 still fires)', () => {
  const { out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept#bad\nupdated: 2026-06-23\n---\nbody\n',
  );
  assert.ok(
    out.warns.some((w) => /Unknown type: "concept#bad"/.test(w.message)),
    `comment-strip hid unknown type: ${JSON.stringify(out.warns)}`,
  );
});

// A — CRLF frontmatter: nested type: still must not clobber, fields still read.
test('A: CRLF frontmatter parses and nested type does not clobber', () => {
  const { out } = lintWithSchema(
    'pages/x.md',
    '---\r\ntitle: T\r\ntype: concept\r\nupdated: 2026-06-23\r\nrelations:\r\n  - type: depends_on\r\n---\r\nbody\r\n',
  );
  assert.ok(
    !out.warns.some((w) => /Unknown type/.test(w.message)),
    `CRLF nested type clobbered: ${JSON.stringify(out.warns)}`,
  );
});

suite('lint.mjs tag vocabulary + forbidden patterns');

test('PascalCase tag → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [Jenkins]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) => e.message.includes('Forbidden tag pattern (PascalCase)')),
    `expected PascalCase error: ${r.stdout}`,
  );
});

test('plural tag (learnings) → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [learnings]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(out.errors.some((e) => e.message.includes('Forbidden tag pattern (plural)')));
});

test('generic tag (todo) → error', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [todo]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(out.errors.some((e) => e.message.includes('Forbidden tag pattern (generic)')));
});

test('unknown tag (not in vocab) → W10 warn, not error (B-4)', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [zzz-unknown]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `unknown tag must be a warning, not an error: ${r.stdout}`);
  assert.ok(
    out.warns.some((w) => w.message.includes('Unknown tag: "zzz-unknown"')),
    `expected unknown tag warn: ${r.stdout}`,
  );
  assert.ok(
    !out.errors.some((e) => e.message.includes('Unknown tag')),
    `unknown tag must not be a hard error: ${r.stdout}`,
  );
});

test('valid tag in vocab → green', () => {
  const { r } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [wiki, concept]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `expected green, got ${r.status}`);
});

test('vocab parser excludes prose backticks and Forbidden table examples', () => {
  // Codex P3: prior parser accepted every backtick in the section, so `lint`
  // appearing in explanatory prose and `Jenkins` in the Forbidden table row
  // were silently added to the vocabulary.
  const schema =
    '---\ntitle: SCHEMA\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n' +
    'Use lowercase, hyphenated tags. `lint` blocks unknown tags.\n\n' +
    '**Meta**: `wiki`, `concept`\n\n' +
    '### Forbidden patterns\n\n' +
    '| Pattern | Reason | Use instead |\n' +
    '|---------|--------|-------------|\n' +
    '| PascalCase (`Jenkins`) | Inconsistent | `jenkins` |\n\n' +
    '## 5. Next\n';
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [lint]\n---\nbody\n',
    schema,
  );
  // Post B-4 the prose-only tag is an unknown-tag WARNING (not an error), but the
  // point stands: the parser must not have admitted the prose `lint` token into
  // the vocabulary, so `lint` is still flagged as unknown.
  assert.equal(r.status, 0, `prose-only tag is now a warning, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.warns.some((w) => w.message.includes('Unknown tag: "lint"')),
    `parser leaked prose token "lint" into vocab: ${r.stdout}`,
  );
});

test('vocab check skipped when SCHEMA.md absent (back-compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-novocab-'));
  const pageDir = join(dir, 'pages');
  mkdirSync(pageDir, { recursive: true });
  writeFileSync(
    join(pageDir, 'x.md'),
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [Jenkins]\n---\nbody\n',
  );
  const r = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `expected green when SCHEMA.md missing, got ${r.status}: ${r.stdout}`);
});

// ── B-4: unknown-tag warn (W10) + SCHEMA Pending auto-registration ──────────────

suite('B-4 — unknown-tag warn + auto-register');

test('B-4: unknown tag stays a warning under --strict (W10 not promoted), id exposed', () => {
  const { r, out } = lintStrict(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [zzz-unknown]\n---\nbody\n',
  );
  assert.equal(r.status, 0, `W10 must NOT promote to error under --strict: ${r.stdout}`);
  assert.ok(
    out.warns.some((w) => w.id === 'W10' && /Unknown tag: "zzz-unknown"/.test(w.message)),
    `W10 id must surface in --strict --json: ${r.stdout}`,
  );
  assert.ok(
    !out.errors.some((e) => /Unknown tag/.test(e.message)),
    `W10 wrongly promoted to error: ${r.stdout}`,
  );
});

test('B-4: forbidden tag stays a hard error (not demoted to a warn)', () => {
  const { r, out } = lintWithSchema(
    'pages/x.md',
    '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\ntags: [Jenkins]\n---\nbody\n',
  );
  assert.equal(r.status, 1, `forbidden tag must still be an error: ${r.stdout}`);
  assert.ok(out.errors.some((e) => e.message.includes('Forbidden tag pattern (PascalCase)')));
});

test('B-4: appendPendingTags round-trips into parseSchemaVocab and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-pending-'));
  try {
    writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
    assert.ok(!parseSchemaVocab(dir).has('new-tag-a'), 'precondition: tag absent');
    const added = appendPendingTags(dir, ['new-tag-a', 'new-tag-b']);
    assert.deepEqual([...added.tags].sort(), ['new-tag-a', 'new-tag-b']);
    assert.ok(
      added.content && added.content.includes('new-tag-a'),
      'written content must carry the new tag',
    );
    const vocab = parseSchemaVocab(dir);
    assert.ok(vocab.has('new-tag-a') && vocab.has('new-tag-b'), 'pending tags not in vocab');
    assert.ok(vocab.has('wiki') && vocab.has('concept'), 'existing vocab clobbered');
    // idempotent: a second register of the same tags writes nothing new
    assert.equal(
      appendPendingTags(dir, ['new-tag-a', 'new-tag-b']).tags.length,
      0,
      'not idempotent',
    );
    // forbidden patterns are filtered out (registering them is pointless)
    assert.equal(appendPendingTags(dir, ['BadTag']).tags.length, 0, 'forbidden tag registered');
    assert.ok(!parseSchemaVocab(dir).has('BadTag'), 'forbidden tag leaked into vocab');
    // edge tags (codex stage-2): a `"` is non-forbidden and must round-trip; a
    // backtick can't be serialized and is skipped WITHOUT corrupting siblings.
    assert.deepEqual(appendPendingTags(dir, ['has"quote']).tags, ['has"quote']);
    assert.ok(parseSchemaVocab(dir).has('has"quote'), 'quote tag did not round-trip');
    assert.equal(
      appendPendingTags(dir, ['bad`tick']).tags.length,
      0,
      'backtick tag must be skipped',
    );
    assert.ok(!parseSchemaVocab(dir).has('bad`tick'), 'backtick tag leaked into vocab');
    assert.ok(parseSchemaVocab(dir).has('new-tag-a'), 'sibling tag lost after edge-case calls');
    // no-op when SCHEMA.md has no Tag Vocabulary header
    const dir2 = mkdtempSync(join(tmpdir(), 'hypo-pending-novocab-'));
    writeFileSync(
      join(dir2, 'SCHEMA.md'),
      '---\ntitle: S\ntype: schema\n---\n# Schema\n\n## 1. Other\n',
    );
    assert.equal(
      appendPendingTags(dir2, ['x']).tags.length,
      0,
      'must no-op without a vocab header',
    );
    rmSync(dir2, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B-4: appendPendingTags fills a pre-existing empty Pending block (template shape)', () => {
  // Mirrors the templates/SCHEMA.md shape: an empty `### Pending` (heading +
  // prose, no data line) sitting before `### Forbidden patterns`. The helper must
  // seed the data line inside that block, not create a second one.
  const dir = mkdtempSync(join(tmpdir(), 'hypo-pending-empty-'));
  try {
    writeFileSync(
      join(dir, 'SCHEMA.md'),
      '---\ntitle: S\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n' +
        '**Meta**: `wiki`\n\n### Pending (auto-registered)\n\nAuto-registered tags land here.\n\n' +
        '### Forbidden patterns\n\n| Pattern | Reason |\n|---|---|\n| PascalCase (`Jenkins`) | x |\n\n## 5. Next\n',
    );
    assert.deepEqual(appendPendingTags(dir, ['fresh-tag']).tags, ['fresh-tag']);
    const vocab = parseSchemaVocab(dir);
    assert.ok(vocab.has('fresh-tag'), 'tag not added to empty Pending block');
    assert.ok(vocab.has('wiki'), 'existing vocab lost');
    assert.ok(!vocab.has('Jenkins'), 'Forbidden table example token leaked into vocab');
    // exactly one Pending data line (no duplicate block created)
    const data = readFileSync(join(dir, 'SCHEMA.md'), 'utf-8').match(/^\*\*Pending\b/gm) || [];
    assert.equal(data.length, 1, 'expected exactly one **Pending** data line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B-4: apply-session-close auto-registers a preflight unknown tag; re-lint clean', () => {
  withWiki(
    (dir) => {
      // A SCHEMA with a vocab section (no Pending block yet) + a page carrying an
      // unknown but well-formed tag → preflight surfaces a W10 warn for it. The
      // page is OUTSIDE the close payload, so it models PRE-EXISTING wiki debt:
      // the apply path registers it (eventual consistency), not this close's own
      // payload tags. Forbidden patterns would stay errors and never reach here.
      writeFileSync(
        join(dir, 'SCHEMA.md'),
        '---\ntitle: SCHEMA\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n' +
          '**Meta**: `wiki`, `concept`\n\n## 5. Next\n',
      );
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'note.md'),
        '---\ntitle: N\ntype: concept\nupdated: 2026-06-27\ntags: [brand-new-tag]\n---\nbody\n',
      );
      // A second page whose tag contains a `"` — non-forbidden, so it reaches the
      // auto-register path. Proves the message parse captures the WHOLE tag rather
      // than truncating at the embedded quote (codex stage-2 fix), end to end.
      writeFileSync(
        join(dir, 'pages', 'note2.md'),
        "---\ntitle: N2\ntype: concept\nupdated: 2026-06-27\ntags: ['weird\"tag']\n---\nbody\n",
      );
    },
    (dir, today) => {
      assert.ok(!parseSchemaVocab(dir).has('brand-new-tag'), 'precondition: tag unknown');
      const r = runApply(dir, payloadForCleanWiki(dir, today));
      assert.equal(r.status, 0, `apply must not stall on a vocab gap: ${r.stdout}\n${r.stderr}`);
      const vocab = parseSchemaVocab(dir);
      assert.ok(
        vocab.has('brand-new-tag'),
        'unknown tag was not auto-registered into SCHEMA Pending',
      );
      assert.ok(vocab.has('weird"tag'), 'quote-containing tag truncated, not registered whole');
      // Drive REAL lint (not just the round-trip helper): neither registered tag
      // warns — proves the message-string parse and the SCHEMA write agree.
      const lr = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
      const lout = JSON.parse(lr.stdout);
      assert.ok(
        !lout.warns.some((w) => /Unknown tag: "brand-new-tag"/.test(w.message)),
        `re-lint still warns on the registered tag: ${lr.stdout}`,
      );
      assert.ok(
        !lout.warns.some((w) => /Unknown tag: "weird"tag"/.test(w.message)),
        `re-lint still warns on the quote tag: ${lr.stdout}`,
      );
    },
  );
});

// design.md v3 §D / test row a: the mirror of the test above, with ONE
// difference, SCHEMA.md is dirty (uncommitted) against HEAD before the
// close runs. registerPendingTagsLocked must defer registration entirely
// rather than layer a new write onto bytes it cannot attribute.
test('B-4: apply-session-close defers a preflight unknown tag when SCHEMA.md is already dirty', () => {
  withWiki(
    (dir) => {
      writeFileSync(
        join(dir, 'SCHEMA.md'),
        '---\ntitle: SCHEMA\ntype: schema\n---\n# Schema\n\n## 4. Tag Vocabulary\n\n' +
          '**Meta**: `wiki`, `concept`\n\n## 5. Next\n',
      );
      mkdirSync(join(dir, 'pages'), { recursive: true });
      writeFileSync(
        join(dir, 'pages', 'note3.md'),
        '---\ntitle: N3\ntype: concept\nupdated: 2026-06-27\ntags: [dirty-schema-tag]\n---\nbody\n',
      );
    },
    (dir, today) => {
      assert.ok(!parseSchemaVocab(dir).has('dirty-schema-tag'), 'precondition: tag unknown');
      // Dirty AFTER the fixture's own commit, from a source outside this
      // close (a hand edit, or another session), not a prior attempt of
      // this same close.
      writeFileSync(
        join(dir, 'SCHEMA.md'),
        readFileSync(join(dir, 'SCHEMA.md'), 'utf-8') + '\n<!-- unrelated dirty edit -->\n',
      );
      const r = runApply(dir, payloadForCleanWiki(dir, today));
      assert.equal(r.status, 0, `apply must not stall on the vocab gap: ${r.stdout}\n${r.stderr}`);
      assert.ok(
        !parseSchemaVocab(dir).has('dirty-schema-tag'),
        'a dirty SCHEMA.md must not be registered into (this close never wrote the tag)',
      );
      const status = spawnSync('git', ['-C', dir, 'status', '--porcelain', '--', 'SCHEMA.md'], {
        encoding: 'utf-8',
      });
      assert.ok(
        (status.stdout || '').trim() !== '',
        'the unrelated dirty edit must still sit uncommitted, untouched by this close',
      );
    },
  );
});

// ── lint.mjs pages/ directory whitelist (B6 — SCHEMA dir typo guard) ─────────

suite('lint.mjs pages/ directory whitelist');

const DIR_SCHEMA = [
  '---',
  'title: SCHEMA',
  'type: schema',
  '---',
  '# Schema',
  '',
  '## 1. Page Type Taxonomy',
  '',
  '| type | directory | desc |',
  '|------|-----------|------|',
  '| `learning` | `pages/learnings/` | gotchas |',
  '| `feedback` | `pages/feedback/` | corrections |',
  '',
  '## 4. Tag Vocabulary',
  '',
  '`wiki` `concept`',
  '',
  '## 5. Next',
  '',
].join('\n');

// type: concept has no conditional-required fields and no tags → isolates B6 as
// the only possible error, since the check keys off the path, not frontmatter.
const PLAIN_PAGE = '---\ntitle: T\ntype: concept\nupdated: 2026-05-18\n---\nbody\n';

test('typo directory (pages/learning/) → error', () => {
  const { r, out } = lintWithSchema('pages/learning/x.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Undefined pages/ directory: "pages/learning/"')),
    `expected undefined-dir error: ${r.stdout}`,
  );
});

test('canonical directory (pages/learnings/) → green', () => {
  const { r } = lintWithSchema('pages/learnings/x.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 0, `expected green, got ${r.status}: ${r.stdout}`);
});

test('root-level pages/ file (no subdir) → green', () => {
  const { r } = lintWithSchema('pages/x.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 0, `expected green, got ${r.status}: ${r.stdout}`);
});

test('dir check skipped when Page Type Taxonomy table absent (back-compat)', () => {
  // VOCAB_SCHEMA has no "## 1. Page Type Taxonomy" table → whitelist empty → skip.
  const { r } = lintWithSchema('pages/learning/x.md', PLAIN_PAGE);
  assert.equal(r.status, 0, `expected green when table absent, got ${r.status}: ${r.stdout}`);
});

test('_index.md in an undefined dir → green (scaffold exemption)', () => {
  // pages/observability/ ships via init but is a topical grouping, not a page
  // *type*, so it is absent from the taxonomy table. Its _index.md scaffold must
  // not trip the guard.
  const { r } = lintWithSchema('pages/observability/_index.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 0, `expected green for _index scaffold, got ${r.status}: ${r.stdout}`);
});

test('content file in an undefined dir still errors despite the _index exemption', () => {
  // The exemption must not blunt the guard: a real content page (no `_` prefix)
  // in a typo dir is still the original bug we are catching.
  const { r, out } = lintWithSchema('pages/learning/real-content.md', PLAIN_PAGE, DIR_SCHEMA);
  assert.equal(r.status, 1, `expected error, got ${r.status}: ${r.stdout}`);
  assert.ok(
    out.errors.some((e) => e.message.includes('Undefined pages/ directory: "pages/learning/"')),
    `expected undefined-dir error: ${r.stdout}`,
  );
});

test('fresh init wiki passes lint (regression: observability scaffold vs B6)', () => {
  // Worker-1 caught that B6 would fail a freshly initialized wiki because
  // init.mjs scaffolds pages/observability/_index.md, a dir absent from the
  // taxonomy table. Drive the real init.mjs + lint.mjs, not a fixture.
  const dir = mkdtempSync(join(tmpdir(), 'hypo-init-lint-'));
  const initR = run('init.mjs', [`--hypo-dir=${dir}`, '--no-hooks', '--no-git-init']);
  assert.equal(initR.status, 0, `init failed: ${initR.stderr || initR.stdout}`);
  const lintR = run('lint.mjs', [`--hypo-dir=${dir}`, '--json']);
  const out = JSON.parse(lintR.stdout);
  rmSync(dir, { recursive: true, force: true });
  const dirErrors = out.errors.filter((e) => /Undefined pages\/ directory/.test(e.message));
  assert.equal(dirErrors.length, 0, `B6 fired on fresh init wiki: ${JSON.stringify(dirErrors)}`);
  assert.equal(
    lintR.status,
    0,
    `fresh init wiki should lint green, got ${lintR.status}: ${lintR.stdout}`,
  );
});

suite('lint.mjs --json large-output flush (ISSUE-16)');

test('lint --json: large warn-heavy output survives the 64 KiB pipe boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-big-'));
  try {
    writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
    mkdirSync(join(dir, 'pages'), { recursive: true });
    // One frontmatter-valid page with many DISTINCT broken wikilinks → one W4 warn
    // each. Enough to push --json stdout well past 64 KiB — the exact point where
    // lint's old synchronous process.exit() cut stdout at 65536 bytes mid-string,
    // making JSON.parse throw for every spawn-and-parse consumer (crystallize's
    // runLint, the PreCompact gate).
    const N = 3000;
    let body = '---\ntitle: many\ntype: wiki\nupdated: 2026-06-08\n---\n\n# many\n\n';
    for (let i = 0; i < N; i++) body += `- [[missing-target-${i}]]\n`;
    writeFileSync(join(dir, 'pages', 'many.md'), body);
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${dir}`, '--json'],
      {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    // Output must exceed the old 64 KiB cutoff AND parse cleanly (pre-fix it was
    // truncated to exactly 65536 bytes and JSON.parse threw here). Don't assert an
    // exact size — only that it crosses the boundary and every warn survived.
    assert.ok(r.stdout.length > 64 * 1024, `expected >64 KiB stdout, got ${r.stdout.length}`);
    const parsed = JSON.parse(r.stdout);
    const broken = parsed.warns.filter((w) =>
      /Broken wikilink: \[\[missing-target-/.test(w.message),
    );
    assert.equal(
      broken.length,
      N,
      `expected all ${N} broken-link warns intact, got ${broken.length}`,
    );
    // exit code contract preserved: warns are not errors → clean exit 0.
    assert.equal(r.status, 0, `warn-only lint must exit 0, got ${r.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

suite('lib/hypo-ignore.mjs — generated-artifact catalog exclusion');

const {
  isGeneratedArtifact,
  isScanIgnored,
  isIgnored: isHypoIgnored,
  loadScanIgnore,
} = await import(`${SCRIPTS}/lib/hypo-ignore.mjs`);

const GA_ROOT = '/tmp/ga-vault';

test('root MIGRATION-v*.md and GRAPH_REPORT.md are generated artifacts', () => {
  assert.ok(isGeneratedArtifact(join(GA_ROOT, 'MIGRATION-v2.0.md'), GA_ROOT));
  assert.ok(isGeneratedArtifact(join(GA_ROOT, 'MIGRATION-v1.3.4.md'), GA_ROOT));
  assert.ok(isGeneratedArtifact(join(GA_ROOT, 'GRAPH_REPORT.md'), GA_ROOT));
});

test('exclusion is root-anchored — a same-named nested file is NOT an artifact', () => {
  assert.ok(!isGeneratedArtifact(join(GA_ROOT, 'pages', 'MIGRATION-v2.0.md'), GA_ROOT));
  assert.ok(!isGeneratedArtifact(join(GA_ROOT, 'projects', 'x', 'GRAPH_REPORT.md'), GA_ROOT));
  assert.ok(!isGeneratedArtifact(join(GA_ROOT, 'sources', 'MIGRATION-v2.0.md'), GA_ROOT));
});

test('lookalike root names are NOT artifacts', () => {
  assert.ok(!isGeneratedArtifact(join(GA_ROOT, 'MIGRATION.md'), GA_ROOT)); // no -v segment
  assert.ok(!isGeneratedArtifact(join(GA_ROOT, 'GRAPH_REPORT_NOTES.md'), GA_ROOT));
  assert.ok(!isGeneratedArtifact(join(GA_ROOT, 'hot.md'), GA_ROOT));
});

test('isScanIgnored hides a generated root artifact but isIgnored does NOT', () => {
  // The split matters: pre-commit runs isIgnored() — if it hid the report, the
  // commit (and every auto-commit) would be blocked while it sits at root.
  const report = join(GA_ROOT, 'MIGRATION-v2.0.md');
  assert.equal(isHypoIgnored(report, GA_ROOT, []), false, 'pre-commit must still commit it');
  assert.equal(isScanIgnored(report, GA_ROOT, []), true, 'catalog scan must skip it');
});

test('isScanIgnored still honors .hypoignore patterns (secret-block preserved)', () => {
  const secret = join(GA_ROOT, 'my-token.md');
  assert.equal(isScanIgnored(secret, GA_ROOT, ['*token*']), true);
});

suite('lib/hypo-ignore.mjs — .hyposcanignore scan-only exclusion (A안)');

function withScanIgnoreVault(scanIgnoreContent, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-scanignore-'));
  try {
    if (scanIgnoreContent !== null) {
      writeFileSync(join(dir, '.hyposcanignore'), scanIgnoreContent);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadScanIgnore returns [] when .hyposcanignore is absent (today parity)', () => {
  withScanIgnoreVault(null, (dir) => {
    assert.deepEqual(loadScanIgnore(dir), []);
  });
});

test('loadScanIgnore parses glob lines, skipping comments and blanks', () => {
  withScanIgnoreVault('# comment\n\ndrafts/\nscratch/*.md\n', (dir) => {
    assert.deepEqual(loadScanIgnore(dir), ['drafts/', 'scratch/*.md']);
  });
});

test('isScanIgnored matches a .hyposcanignore-only path, but isIgnored (privacy) does not', () => {
  withScanIgnoreVault('drafts/\n', (dir) => {
    const target = join(dir, 'drafts', 'wip.md');
    assert.equal(
      isHypoIgnored(target, dir, []),
      false,
      'privacy check must not see .hyposcanignore — commit path stays open',
    );
    assert.equal(
      isScanIgnored(target, dir, []),
      true,
      'scan check must skip a .hyposcanignore-listed path',
    );
  });
});

test('isScanIgnored with no .hyposcanignore behaves exactly like privacy+generated-artifact only (today parity)', () => {
  withScanIgnoreVault(null, (dir) => {
    const plain = join(dir, 'pages', 'note.md');
    assert.equal(isScanIgnored(plain, dir, []), false);
    const artifact = join(dir, 'GRAPH_REPORT.md');
    assert.equal(isScanIgnored(artifact, dir, []), true);
  });
});

// Cache-key regression (codex pre-commit BLOCKER): a raw, un-resolved hypoDir
// string as the cache key lets a relative spelling like '.' collide ACROSS
// vaults when the caller cd's between them — the cache must key on the
// resolved absolute path, not the caller's spelling.
test('cross-vault bleed: hypoDir="." scanning vault A does not leak A\'s patterns into vault B scanned as "."', () => {
  const originalCwd = process.cwd();
  const vaultA = mkdtempSync(join(tmpdir(), 'hypo-scanignore-vaultA-'));
  const vaultB = mkdtempSync(join(tmpdir(), 'hypo-scanignore-vaultB-'));
  try {
    writeFileSync(join(vaultA, '.hyposcanignore'), 'drafts/\n');
    // vaultB deliberately has NO .hyposcanignore — drafts/ must stay scannable.

    process.chdir(vaultA);
    const aTarget = join('.', 'drafts', 'wip.md');
    assert.equal(
      isScanIgnored(aTarget, '.', []),
      true,
      'vault A: drafts/ is .hyposcanignore-listed there',
    );

    process.chdir(vaultB);
    const bTarget = join('.', 'drafts', 'wip.md');
    assert.equal(
      isScanIgnored(bTarget, '.', []),
      false,
      'vault B: must NOT reuse vault A\'s cached scan patterns just because both were addressed as "."',
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(vaultA, { recursive: true, force: true });
    rmSync(vaultB, { recursive: true, force: true });
  }
});

test('cache key normalizes "." and "./" to the same absolute vault (no duplicate cache entries, no bleed)', () => {
  const originalCwd = process.cwd();
  const vault = mkdtempSync(join(tmpdir(), 'hypo-scanignore-norm-'));
  try {
    writeFileSync(join(vault, '.hyposcanignore'), 'drafts/\n');
    process.chdir(vault);
    assert.equal(isScanIgnored(join('.', 'drafts', 'wip.md'), '.', []), true);
    assert.equal(isScanIgnored(join('./', 'drafts', 'wip.md'), './', []), true);
    assert.equal(isScanIgnored(join(vault, 'drafts', 'wip.md'), vault, []), true);
  } finally {
    process.chdir(originalCwd);
    rmSync(vault, { recursive: true, force: true });
  }
});

// The A안 split only holds if privacy-relevant callers never reach for the
// scan-only functions. The hole this guards is a gate loading .hyposcanignore
// patterns IN PLACE OF .hypoignore ones, which would let a user-authored scan
// pattern punch through the secret gate. (Using isScanIgnored in a reject-style
// gate would over-block, not leak — annoying, but not a privacy failure.)
//
// Most hooks are structurally immune: hooks cannot import scripts/ (one-way
// dependency direction), so hooks/hypo-shared.mjs carries its own
// isIgnored/loadHypoIgnore with no scan variant. hooks/hypo-pre-commit.mjs is
// the one hook that imports scripts/lib/hypo-ignore.mjs directly. installHooks
// does copy it into ~/.claude/hooks/ along with every other hooks/*.mjs, but
// that copy is never the one that runs: the wiki's git pre-commit shim executes
// the package-root worker (scripts/init.mjs, wikiPreCommitContent), where
// scripts/ sits alongside and the import resolves. So it can reach
// isScanIgnored and has to be checked here. scripts/ingest.mjs,
// scripts/capture.mjs, and scripts/lib/extensions.mjs are the other places a
// privacy decision gets made; none of the four may touch the scan-only pair.
const SCAN_IGNORE_CALLER_GUARD_FILES = [
  'hooks/hypo-pre-commit.mjs',
  'scripts/ingest.mjs',
  'scripts/capture.mjs',
  'scripts/lib/extensions.mjs',
];

test('privacy-relevant files never reference isScanIgnored/loadScanIgnore (scan-only stays scan-only)', () => {
  for (const rel of SCAN_IGNORE_CALLER_GUARD_FILES) {
    const code = readFileSync(join(REPO, rel), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // Match the bare identifier, not `name(`: an aliased import
    // (`import { isScanIgnored as si }`) or a passed reference
    // (`someFilter(isScanIgnored)`) reaches the same file and a call-shaped
    // regex would wave both through. Comments are stripped above, so a doc
    // comment naming the function stays legal.
    assert.equal(
      /\b(isScanIgnored|loadScanIgnore)\b/.test(code),
      false,
      `${rel} must not reference the scan-only .hyposcanignore functions`,
    );
  }
});

suite('lint.mjs wikilink resolution (ISSUE-21)');

// Build a multi-file vault, run lint --json, return broken-wikilink targets plus
// the error count and exit status (so a test can assert target-only files are NOT
// linted). `files` maps relPath → content; SCHEMA.md is auto-seeded unless given.
function lintWiki(files) {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-wl-'));
  try {
    if (!files['SCHEMA.md']) writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${dir}`, '--json'],
      {
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    const out = JSON.parse(r.stdout);
    const broken = out.warns
      .filter((w) => /Broken wikilink/.test(w.message))
      .map((w) => (w.message.match(/\[\[(.+?)\]\]/) || [])[1]);
    return { broken, errors: out.errors, warns: out.warns, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const wlPage = (type, body) =>
  `---\ntitle: T\ntype: ${type}\nupdated: 2026-06-08\n---\n\n${body}\n`;

test('dir-relative link [[learnings/foo]] resolves to pages/learnings/foo.md', () => {
  const { broken } = lintWiki({
    'pages/learnings/foo.md': wlPage('learning', '# foo'),
    'pages/index.md': wlPage('reference', 'see [[learnings/foo]]'),
  });
  assert.ok(
    !broken.includes('learnings/foo'),
    `dir-relative link must resolve, broken=${JSON.stringify(broken)}`,
  );
});

test('root *.md and sources are target-only — linkable but NOT linted', () => {
  // Each target file OMITS the required title/type frontmatter, which is an
  // ERROR if the file is linted. As pure link targets they must resolve AND
  // raise zero errors — so if a future change widens scanDirs to include root or
  // sources, the missing-field error fires and this test fails (it would pass
  // with valid-frontmatter fixtures, the weakness codex flagged).
  const { broken, errors, status } = lintWiki({
    'log.md': '---\nupdated: 2026-06-08\n---\n# operational log, no title/type\n',
    'hypo-guide.md': '---\nupdated: 2026-06-08\n---\n# guide, no title/type\n',
    'sources/2026-01-01-x.md': '---\nupdated: 2026-06-08\n---\n# source, no title/type\n',
    'pages/index.md': wlPage('reference', 'see [[log]], [[hypo-guide]], [[sources/2026-01-01-x]]'),
  });
  assert.equal(
    errors.length,
    0,
    `target-only files must NOT be linted (got errors): ${JSON.stringify(errors)}`,
  );
  assert.equal(status, 0, `clean exit expected, got ${status}`);
  for (const t of ['log', 'hypo-guide', 'sources/2026-01-01-x']) {
    assert.ok(!broken.includes(t), `target "${t}" must resolve: ${JSON.stringify(broken)}`);
  }
});

test('root .md honors .hypoignore — an ignored root file is NOT a valid target', () => {
  // collectLinkTargets must skip .hypoignore'd root files; otherwise [[secret]]
  // would resolve to an ignored file (the false negative codex reproduced).
  const { broken } = lintWiki({
    '.hypoignore': 'secret.md\n',
    'secret.md': '---\ntitle: S\ntype: reference\nupdated: 2026-06-08\n---\n# secret\n',
    'pages/index.md': wlPage('reference', 'leak [[secret]]'),
  });
  assert.ok(
    broken.includes('secret'),
    `an ignored root file must NOT resolve as a link target: ${JSON.stringify(broken)}`,
  );
});

test('sources is target-only by full slug, NOT bare basename (no false negative)', () => {
  const { broken } = lintWiki({
    'sources/2026-01-01-x.md': '---\ntitle: S\ntype: source\nupdated: 2026-06-08\n---\n# s\n',
    'pages/index.md': wlPage('reference', 'stale [[2026-01-01-x]]'), // bare basename
  });
  assert.ok(
    broken.includes('2026-01-01-x'),
    `a bare basename must NOT resolve to a source file: ${JSON.stringify(broken)}`,
  );
});

test('table-escaped alias [[a/b\\|label]] yields the clean target a/b', () => {
  const { broken } = lintWiki({
    'projects/p/issue.md': wlPage('reference', '# issue'),
    'pages/index.md': wlPage('reference', '| x | [[projects/p/issue\\|issue.md]] |'),
  });
  assert.ok(
    !broken.includes('projects/p/issue'),
    `escaped-pipe alias must resolve: ${JSON.stringify(broken)}`,
  );
  assert.ok(
    !broken.some((b) => b && b.includes('\\')),
    `no target should carry a trailing backslash: ${JSON.stringify(broken)}`,
  );
});

test('generated root artifact MIGRATION-v*.md is NOT a valid link target', () => {
  // A regenerable upgrade report at the root must not pollute the catalog: a
  // stale [[MIGRATION-v9.9]] reads as broken instead of silently resolving.
  const { broken } = lintWiki({
    'MIGRATION-v9.9.md': '---\nupdated: 2026-06-08\n---\n# one-time upgrade report\n',
    'pages/index.md': wlPage('reference', 'stale [[MIGRATION-v9.9]]'),
  });
  assert.ok(
    broken.includes('MIGRATION-v9.9'),
    `a generated root artifact must NOT resolve as a link target: ${JSON.stringify(broken)}`,
  );
});

test('generated root artifact GRAPH_REPORT.md is NOT a valid link target', () => {
  const { broken } = lintWiki({
    'GRAPH_REPORT.md': '---\nupdated: 2026-06-08\n---\n# regenerable graph dump\n',
    'pages/index.md': wlPage('reference', 'stale [[GRAPH_REPORT]]'),
  });
  assert.ok(
    broken.includes('GRAPH_REPORT'),
    `GRAPH_REPORT.md must NOT resolve as a link target: ${JSON.stringify(broken)}`,
  );
});

test('a real root operational file is still a valid target (no over-exclusion)', () => {
  const { broken } = lintWiki({
    'hot.md': '---\nupdated: 2026-06-08\n---\n# hot\n',
    'pages/index.md': wlPage('reference', 'see [[hot]]'),
  });
  assert.ok(
    !broken.includes('hot'),
    `a non-artifact root file must still resolve: ${JSON.stringify(broken)}`,
  );
});

test('only ROOT artifacts are excluded — a nested same-named page still resolves', () => {
  const { broken } = lintWiki({
    'pages/MIGRATION-v9.9.md': wlPage('reference', '# a real page that happens to share the name'),
    'pages/index.md': wlPage('reference', 'see [[MIGRATION-v9.9]]'),
  });
  assert.ok(
    !broken.includes('MIGRATION-v9.9'),
    `a nested page must NOT be treated as a generated artifact: ${JSON.stringify(broken)}`,
  );
});

test('genuinely missing links are still W4 broken (no false negative)', () => {
  const { broken } = lintWiki({
    'pages/index.md': wlPage('reference', 'see [[learnings/does-not-exist]] and [[nope]]'),
  });
  assert.ok(
    broken.includes('learnings/does-not-exist'),
    `missing dir-relative must stay broken: ${JSON.stringify(broken)}`,
  );
  assert.ok(
    broken.includes('nope'),
    `missing bare slug must stay broken: ${JSON.stringify(broken)}`,
  );
});

// ── `_`-dir pages: not linted, but still linkable (ISSUE-57) ─────────────────
// The `_`-dir skip keeps draft/spec scaffolds out of the lint set. It used to
// also drop them from the link-target catalog, so a link to a file that plainly
// exists was reported broken — and under --strict that error made a green gate
// unreachable. Scanning and referencing are now separate.
suite('`_`-dir pages: not linted, but still linkable (ISSUE-57)');

test('a page under a `_`-dir is a valid link target (not a false broken link)', () => {
  const { broken } = lintWiki({
    'projects/p/_specs/freshness/spec.md': '# spec (no frontmatter: `_`-dir is not linted)\n',
    'pages/index.md': wlPage('reference', 'see [[projects/p/_specs/freshness/spec]]'),
  });
  assert.ok(
    !broken.includes('projects/p/_specs/freshness/spec'),
    `a live file under a _-dir must resolve: ${JSON.stringify(broken)}`,
  );
});

test('a page under a `_`-dir is still NOT linted (the skip itself survives)', () => {
  // No frontmatter at all. If the `_`-dir page had entered the lint set this
  // would raise W1/no-frontmatter, which is exactly what the skip prevents.
  const { errors, broken } = lintWiki({
    'projects/p/_specs/freshness/spec.md': '# bare spec, no frontmatter\n',
    'pages/index.md': wlPage('reference', 'see [[projects/p/_specs/freshness/spec]]'),
  });
  assert.equal(broken.length, 0);
  assert.ok(
    !errors.some((e) => e.file.includes('_specs')),
    `_-dir pages must stay out of the lint set: ${JSON.stringify(errors)}`,
  );
});

test('a missing page under a `_`-dir is still W4 broken (no false negative)', () => {
  const { broken } = lintWiki({
    'projects/p/_specs/freshness/spec.md': '# real one\n',
    'pages/index.md': wlPage('reference', 'ghost [[projects/p/_specs/not-here/spec]]'),
  });
  assert.ok(
    broken.includes('projects/p/_specs/not-here/spec'),
    `a _-dir path that does not exist must stay broken: ${JSON.stringify(broken)}`,
  );
});

test('`_`-dir link targets get NO bare alias (they cannot mask unrelated links)', () => {
  // Every spec lives at _specs/<name>/spec.md, so a derived bare `spec` alias
  // would resolve any stray [[spec]] and swallow real broken links. Link targets
  // are added verbatim — full slug only.
  const { broken } = lintWiki({
    'projects/p/_specs/freshness/spec.md': '# spec\n',
    'pages/index.md': wlPage('reference', 'bare [[spec]]'),
  });
  assert.ok(
    broken.includes('spec'),
    `bare [[spec]] must NOT resolve to a _-dir page: ${JSON.stringify(broken)}`,
  );
});

test('dir-relative collision across scan dirs resolves when a real file matches', () => {
  // pages/x/foo.md and projects/x/foo.md both yield the dir-relative key x/foo.
  // The Set semantics resolve [[x/foo]] because a real file backs the key — this
  // pins the collision behavior codex flagged so a future change can't regress it.
  const { broken } = lintWiki({
    'pages/x/foo.md': wlPage('learning', '# pf'),
    'projects/x/foo.md': wlPage('reference', '# pjf'),
    'pages/index.md': wlPage('reference', 'see [[x/foo]]'),
  });
  assert.ok(
    !broken.includes('x/foo'),
    `collision key must resolve when a real file exists: ${JSON.stringify(broken)}`,
  );
});

// ── root close targets (hot.md / log.md) get W4-only scanning ───────────────
// closeFileTargetsGlobal (hooks/hypo-shared.mjs) says a session close writes
// root hot.md and log.md, but the three scanDirs (pages/projects/journal)
// never covered the vault root, so a broken wikilink close itself just wrote
// there passed lint clean while doctor caught it. See CLAUDE.md's hook-table
// caveat for why hooks/hypo-shared.mjs, not docs, is the source of truth here.
suite('lint.mjs root close-target scan (hot.md / log.md)');

test('a broken wikilink in root log.md is caught (not just by doctor)', () => {
  const { broken } = lintWiki({
    'log.md':
      '---\ntitle: Activity Log\ntype: log\nupdated: 2026-06-08\n---\n\nsee [[projects/ghost/hot]]\n',
  });
  assert.ok(
    broken.includes('projects/ghost/hot'),
    `root log.md broken link must be reported: ${JSON.stringify(broken)}`,
  );
});

test('a broken wikilink in root hot.md is caught (not just by doctor)', () => {
  const { broken } = lintWiki({
    'hot.md':
      '---\ntitle: Hot Cache\ntype: reference\nupdated: 2026-06-08\n---\n\nsee [[projects/ghost/hot]]\n',
  });
  assert.ok(
    broken.includes('projects/ghost/hot'),
    `root hot.md broken link must be reported: ${JSON.stringify(broken)}`,
  );
});

test('root log.md: a broken link is caught AND a real link resolves in the same run (no false positive)', () => {
  // A single vacuous "broken is empty" read passes whether or not the new loop
  // runs at all (log.md unscanned → no warns either way). Asserting the broken
  // and the real link together only holds if the loop actually ran: a disabled
  // loop reports the real link as clean by omission, but ALSO drops the
  // broken one, so this specific pairing only passes with the loop alive.
  const { broken } = lintWiki({
    'log.md':
      '---\ntitle: Activity Log\ntype: log\nupdated: 2026-06-08\n---\n\nreal [[pages/target]], ghost [[projects/ghost/hot]]\n',
    'pages/target.md': wlPage('reference', '# Target'),
  });
  assert.ok(
    broken.includes('projects/ghost/hot'),
    `the broken link must still be reported: ${JSON.stringify(broken)}`,
  );
  assert.ok(
    !broken.includes('pages/target'),
    `the real link target must resolve, not just go unmentioned: ${JSON.stringify(broken)}`,
  );
});

test('root log.md still gets no full lintPage treatment (its non-VALID_TYPES type stays silent)', () => {
  // log.md's `type: log` is not declared in VOCAB_SCHEMA's taxonomy (it has no
  // Page Type Taxonomy table), so parseSchemaTypes() contributes nothing and
  // validTypes falls back to the hardcoded VALID_TYPES list, which does not
  // include `log`. If lintPage ran on this file, that would raise a W2 "Unknown
  // type" WARN, not an error, so checking `errors` alone proves nothing; this
  // reads `warns` directly to prove the type check never ran at all.
  const { warns } = lintWiki({
    'log.md': '---\ntitle: Activity Log\ntype: log\nupdated: 2026-06-08\n---\n\nno links here\n',
  });
  assert.ok(
    !warns.some((w) => w.file === 'log.md'),
    `root log.md must not be run through full lintPage: ${JSON.stringify(warns)}`,
  );
});

test('.hyposcanignore flips the same broken link from reported to unscanned', () => {
  // A single ignored-and-clean run would pass even with the new loop deleted
  // entirely (log.md never in scope either way). Running the SAME file both
  // with and without the ignore entry, and asserting the warn flips, only
  // holds if the loop is both alive and honoring isScanIgnored.
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-wl-'));
  try {
    writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
    writeFileSync(
      join(dir, 'log.md'),
      '---\ntitle: Activity Log\ntype: log\nupdated: 2026-06-08\n---\n\nsee [[projects/ghost/hot]]\n',
    );
    const runLint = () => {
      const r = spawnSync(
        process.execPath,
        [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${dir}`, '--json'],
        {
          encoding: 'utf-8',
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
        },
      );
      return JSON.parse(r.stdout).warns.some(
        (w) => w.file === 'log.md' && /Broken wikilink/.test(w.message),
      );
    };
    assert.equal(runLint(), true, 'before .hyposcanignore: the broken link must be reported');
    writeFileSync(join(dir, '.hyposcanignore'), 'log.md\n');
    assert.equal(runLint(), false, 'after .hyposcanignore: log.md must be skipped entirely');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── root close targets: W1 no-frontmatter reduced check (ISSUE-98) ──────────
// close overwrites hot.md/log.md wholesale, and nothing was checking whether
// that write left a frontmatter block behind at all. These pair with the
// strict-exemption tests below: this suite proves the check fires (a), the
// Track E suite proves it stays a warning for a legacy vault under --strict
// (b), and both directions matter for the same fixture to mean anything.

test('a root close target with no frontmatter block at all is caught as W1', () => {
  const { warns } = lintWiki({
    'hot.md': '# Hot Cache\n\nclose overwrote this without a frontmatter block\n',
  });
  assert.ok(
    warns.some((w) => w.file === 'hot.md' && /No closed frontmatter block found/.test(w.message)),
    `root hot.md missing its frontmatter block must be reported: ${JSON.stringify(warns)}`,
  );
});

test('a root close target with an unclosed frontmatter fence is caught as W1', () => {
  // Same predicate as hooks/hypo-shared.mjs's frontmatterUpdated: a closed
  // `---`...`---` block, not just an opening fence. An unclosed fence used to
  // slip past this loop's old open-fence-only check and only fail at the
  // close gate, with no lint signal pointing at why.
  const { warns } = lintWiki({
    'hot.md': '---\ntitle: Hot\n',
  });
  assert.ok(
    warns.some((w) => w.file === 'hot.md' && /No closed frontmatter block found/.test(w.message)),
    `root hot.md with an unclosed fence must be reported: ${JSON.stringify(warns)}`,
  );
});

test('a root close target with an empty frontmatter block is caught as W1', () => {
  // `---\n---\n` is caught, not skipped. The shared closed-block regex (both
  // here and in hooks/hypo-shared.mjs's frontmatterUpdated) needs a line of
  // content between the two fences: its lazy `([\s\S]*?)\r?\n---` requires a
  // newline before the closing `---` that is not the opening fence's own
  // newline, and an empty block has none. So `---\n---\n` does not match and
  // this loop reports it exactly like a missing block, agreeing with the
  // close gate's own reading of the same bytes rather than silently passing
  // a frontmatter block with nothing in it.
  const { warns } = lintWiki({
    'hot.md': '---\n---\n\n# Hot\n',
  });
  assert.ok(
    warns.some((w) => w.file === 'hot.md' && /No closed frontmatter block found/.test(w.message)),
    `an empty frontmatter block must trip W1: ${JSON.stringify(warns)}`,
  );
});

test('a root close target with a closed fence but broken YAML is caught as W9, and promotes under --strict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-w9root-'));
  try {
    writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
    writeFileSync(join(dir, 'hot.md'), '---\ntitle: Hot\ntitle: Hot Again\n---\n\n# Hot\n');
    const plain = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${dir}`, '--json'],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
    );
    const plainOut = JSON.parse(plain.stdout);
    assert.equal(plain.status, 0, `W9 is a warn, not an error, by default: ${plain.stdout}`);
    assert.ok(
      (plainOut.warns || []).some(
        (w) => w.file === 'hot.md' && /Invalid YAML frontmatter/.test(w.message),
      ),
      `root hot.md with a closed-but-broken block must surface W9: ${JSON.stringify(plainOut.warns)}`,
    );

    const strict = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${dir}`, '--json', '--strict'],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
    );
    const strictOut = JSON.parse(strict.stdout);
    assert.equal(strict.status, 1, `W9 must promote under --strict: ${strict.stdout}`);
    assert.ok(
      (strictOut.errors || []).some((e) => e.file === 'hot.md' && e.id === 'W9'),
      `root hot.md's W9 must promote to an error under --strict (not exempted): ${JSON.stringify(strictOut.errors)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy root log.md with no frontmatter at all still passes --strict', () => {
  // Mirrors a real maintainer vault: log.md predates the frontmatter
  // convention entirely, starting with a heading, not `---`.
  const dir = mkdtempSync(join(tmpdir(), 'hypo-lint-legacy-'));
  try {
    writeFileSync(join(dir, 'SCHEMA.md'), VOCAB_SCHEMA);
    writeFileSync(join(dir, 'log.md'), '# Wiki Log\n\nappend-only history, no frontmatter\n');
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${dir}`, '--json', '--strict'],
      { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
    );
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `a legacy log.md must not fail --strict: ${r.stdout}`);
    assert.ok(
      (out.warns || []).some((w) => w.file === 'log.md' && w.id === 'W1'),
      `log.md must still surface W1 as a warning under --strict: ${JSON.stringify(out.warns)}`,
    );
    assert.ok(
      !(out.errors || []).some((e) => e.file === 'log.md'),
      `log.md must not be promoted to an error under --strict: ${JSON.stringify(out.errors)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the packaged templates/ vault stays errors:0 warns:0', () => {
  // Stock hot.md/log.md both carry a real frontmatter block, so the new W1
  // check must not add a single finding to a vault it was never aimed at.
  const r = spawnSync(
    process.execPath,
    [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${join(REPO, 'templates')}`, '--json'],
    { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
  );
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 0, `packaged templates/ must stay clean: ${r.stdout}`);
  assert.equal((out.errors || []).length, 0, `templates/ errors: ${JSON.stringify(out.errors)}`);
  assert.equal((out.warns || []).length, 0, `templates/ warns: ${JSON.stringify(out.warns)}`);
});

suite('fix #49: findDesignHistoryStale()');

test('w8-stale: flat session-log.md newer than design-history → stale', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p1', {
      dh: '---\ntitle: dh\n---\n\n## 2026-05-10\nfoo\n',
      sessionLogMd: '## [2026-05-20] session\nbar\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].project, 'p1');
    assert.equal(stale[0].lastSession, '2026-05-20');
    assert.equal(stale[0].lastDesignHistory, '2026-05-10');
    assert.equal(stale[0].diffDays, 10);
  });
});

test('w8-stale: directory session-log/YYYY-MM.md aggregated across files', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p2', {
      dh: '## 2026-04-01\nfoo\n',
      sessionLogDir: {
        '2026-04.md': '## [2026-04-15] s\n',
        '2026-05.md': '## [2026-05-22] s\n',
      },
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-05-22');
  });
});

test('w8-clean: session-log older than design-history → no emit', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p3', {
      dh: '## 2026-05-22\nfoo\n',
      sessionLogMd: '## [2026-05-10] s\n',
    });
    assert.equal(findDesignHistoryStale(root).length, 0);
  });
});

// Was "w8-skip: project without design-history.md is skipped" until this fix:
// a project with a design-relevant session-log entry and NO design-history.md
// at all used to fall through `continue` silently, so the design change had
// nowhere to land and nothing warned about it. Now it reports kind:'missing'
// instead of being dropped.
test('w14-missing: project with a design-relevant entry and no design-history.md at all → missing', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p4', { sessionLogMd: '## [2026-05-20] s\n' });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].project, 'p4');
    assert.equal(stale[0].kind, 'missing');
    assert.equal(stale[0].lastSession, '2026-05-20');
    assert.equal(stale[0].lastDesignHistory, null);
    assert.equal(stale[0].diffDays, null);
  });
});

test('w14-missing: "ADR 없음" latest entry with no design-history.md → no finding', () => {
  // Mirrors the W8 no-design exclusion: parseSessionDates already drops a pure
  // "ADR 없음" entry, so an all-no-design session-log produces zero
  // design-relevant dates and must not trip the missing-file finding either.
  withTmpDir((root) => {
    setupDhProject(root, 'p4b', {
      sessionLogMd: '## [2026-05-20] docs\n- ADR 없음 — fix only\n',
    });
    assert.equal(findDesignHistoryStale(root).length, 0);
  });
});

test('w8-skip: project without any session-log (file or dir) is skipped', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p5', { dh: '## 2026-05-10\nfoo\n' });
    assert.equal(findDesignHistoryStale(root).length, 0);
  });
});

test('w8-edge: design-history body has no date heading → stale, diffDays=null', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p6', {
      dh: '---\ntitle: dh\nupdated: 2026-05-22\n---\n\nNo date headings here.\n',
      sessionLogMd: '## [2026-05-20] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastDesignHistory, '(없음)');
    assert.equal(stale[0].diffDays, null);
  });
});

test('w8-edge: invalid date headings (## [2026-13-01]) are reported as calendarOverflow, no Invalid Date crash', () => {
  // `new Date('2026-13-01')` is an Invalid Date and `toISOString()` on it
  // throws RangeError. The parser must not crash all of lint on it, and must
  // not drop it silently either: it comes back as a calendarOverflow literal.
  withTmpDir((root) => {
    setupDhProject(root, 'p8', {
      dh: '## 2026-05-10\nfoo\n',
      sessionLogMd: '## [2026-13-01] bogus\n## [2026-05-20] real\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-05-20');
    assert.deepEqual(stale[0].calendarOverflow, [
      { literal: '2026-13-01', file: 'projects/p8/session-log.md' },
    ]);
  });
});

test('w8-edge: design-history with only invalid dates → stale with diffDays=null', () => {
  // Month-out-of-range: a plain `new Date()` check already rejected this
  // (Invalid Date), so this pins the case that predates the strict parser.
  withTmpDir((root) => {
    setupDhProject(root, 'p9', {
      dh: '## 2026-13-01\ninvalid only\n',
      sessionLogMd: '## [2026-05-20] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastDesignHistory, '(없음)');
    assert.equal(stale[0].diffDays, null);
  });
});

test('w8-edge: calendar-overflow heading (## 2026-02-30) is filtered, not normalized to March 2', () => {
  // `new Date('2026-02-30')` does not produce an Invalid Date: it silently
  // normalizes to March 2. A design-history heading with this literal used to
  // read as a real, later date and could make a stale record look caught up.
  // parseStrictDate (scripts/lib/time.mjs) rejects it by round-tripping
  // year/month/day through Date.UTC and checking the calendar holds.
  withTmpDir((root) => {
    setupDhProject(root, 'p10', {
      dh: '## 2026-02-30\ninvalid only\n',
      sessionLogMd: '## [2026-05-20] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastDesignHistory, '(없음)');
    assert.equal(stale[0].diffDays, null);
  });
});

test('w8-edge: calendar-overflow session-log heading (## [2026-02-30]) is reported, not normalized into 03-02', () => {
  // The heading must neither be dropped (sessionDates would empty and both W8
  // and W14 would vanish) nor read as March 2 (that invents a 2-day gap).
  withTmpDir((root) => {
    setupDhProject(root, 'p11', {
      dh: '## 2026-02-28\nfoo\n',
      sessionLogMd: '## [2026-02-30] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].kind, 'stale');
    assert.deepEqual(stale[0].calendarOverflow, [
      { literal: '2026-02-30', file: `projects/${stale[0].project}/session-log.md` },
    ]);
    assert.equal(stale[0].diffDays, null); // not the invented 2
    assert.equal(stale[0].lastSession, null); // not '2026-03-02'
    assert.equal(stale[0].lastDesignHistory, '2026-02-28');
  });
});

test('w8-edge: overflow heading is not silent when design-history equals the normalized date', () => {
  // new Date('2026-02-30') is March 2, not later than a design-history of
  // 2026-03-02, so the normalizing read raised nothing at all.
  withTmpDir((root) => {
    setupDhProject(root, 'p11b', {
      dh: '## 2026-03-02\nfoo\n',
      sessionLogMd: '## [2026-02-30] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.deepEqual(stale[0].calendarOverflow, [
      { literal: '2026-02-30', file: `projects/${stale[0].project}/session-log.md` },
    ]);
    assert.equal(stale[0].diffDays, null);
  });
});

test('w8-edge: calendar boundaries (leap day, April 31, year 0000) sort into real dates or overflow', () => {
  // 2024-02-29 is a real leap day and 0000-01-01 is a real proleptic date, so both count as
  // dates; 2026-02-29 and 2026-04-31 do not exist and land in calendarOverflow, unnormalised.
  withTmpDir((root) => {
    setupDhProject(root, 'p11f', {
      dh: '## 2023-01-01\nfoo\n',
      sessionLogMd:
        '## [2024-02-29] a\n\n## [2026-02-29] b\n\n## [2026-04-31] c\n\n## [0000-01-01] d\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2024-02-29');
    assert.equal(stale[0].realLater, true);
    assert.deepEqual(
      stale[0].calendarOverflow.map((o) => o.literal),
      ['2026-02-29', '2026-04-31'],
    );
  });
  // 0000-01-01 alone, no design-history: read as a date it makes a missing finding with that
  // lastSession; dropped, it would make no finding at all.
  withTmpDir((root) => {
    setupDhProject(root, 'p11g', { sessionLogMd: '## [0000-01-01] d\n' });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].kind, 'missing');
    assert.equal(stale[0].lastSession, '0000-01-01');
    assert.deepEqual(stale[0].calendarOverflow, []);
  });
});

test('w8-edge: overflow heading is not hidden by an older real date that design-history covers', () => {
  // The real date (02-20) is not later than design-history (02-28), so only the
  // overflow literal itself can raise the finding; lastSession is not null here.
  withTmpDir((root) => {
    setupDhProject(root, 'p11e', {
      dh: '## 2026-02-28\nfoo\n',
      sessionLogMd: '## [2026-02-30] a\n\n## [2026-02-20] b\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-02-20');
    assert.equal(stale[0].diffDays, null);
    assert.deepEqual(stale[0].calendarOverflow, [
      { literal: '2026-02-30', file: `projects/${stale[0].project}/session-log.md` },
    ]);
  });
});

test('w8-edge: overflow heading beside a real later date keeps the real diffDays', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p11c', {
      dh: '## 2026-02-20\nfoo\n',
      sessionLogMd: '## [2026-02-30] a\n\n## [2026-02-25] b\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-02-25');
    assert.equal(stale[0].diffDays, 5);
    assert.deepEqual(stale[0].calendarOverflow, [
      { literal: '2026-02-30', file: `projects/${stale[0].project}/session-log.md` },
    ]);
  });
});

test('w8-edge: only real dates → calendarOverflow is empty and diffDays unchanged', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p11d', {
      dh: '## 2026-02-20\nfoo\n',
      sessionLogMd: '## [2026-02-25] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.deepEqual(stale[0].calendarOverflow, []);
    assert.equal(stale[0].diffDays, 5);
  });
});

test('w14-missing: calendar-overflow session-log heading with no design-history.md still reports missing', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p12', { sessionLogMd: '## [2026-09-31] s\n' });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].kind, 'missing');
    assert.equal(stale[0].lastDesignHistory, null);
  });
});

test('w8-edge: frontmatter updated newer than body date → still stale on body comparison', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p7', {
      dh: '---\nupdated: 2026-05-25\n---\n\n## 2026-05-10\nfoo\n',
      sessionLogMd: '## [2026-05-20] s\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastDesignHistory, '2026-05-10');
  });
});

// ── issue①: design-marker precision (W8 false-positive) ──────────────────────
// A no-design session declares `ADR 없음`; it must NOT count toward staleness,
// or it pushes session-log past design-history forever (treadmill). A real
// design session (ADR ref, or no marker at all) still must block.
suite('issue①: W8 design-marker precision');

test('marker: latest entry "ADR 없음" (no ADR ref) is excluded → not stale', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'm1', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## [2026-06-05] feature\n- **ADR 없음** — fix only\n',
    });
    assert.equal(findDesignHistoryStale(root).length, 0);
  });
});

test('marker: treadmill — repeated "ADR 없음" sessions never trip W8', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'm2', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## [2026-06-05] a\n- ADR 없음 — fix\n\n## [2026-06-09] b\n- ADR 없음 — docs\n',
    });
    assert.equal(findDesignHistoryStale(root).length, 0);
  });
});

test('marker: no marker at all → conservative include → still stale (ADR 0041 intent)', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'm3', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## [2026-06-05] unmarked session\nbody with no marker\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-05');
  });
});

test('marker: real design session (ADR ref, no 없음) → stale (forgot-append case)', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'm4', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## [2026-06-10] rename (ADR 0040)\n- → [[decisions/0040-rename]]\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-10');
  });
});

test('marker: "ADR 없음" + "ADR 0040" coexist → ambiguous → included (not excluded)', () => {
  // Excluding a contradictory entry would re-introduce the false-negative W8
  // exists to catch (codex review). Treat mixed entries as design entries.
  withTmpDir((root) => {
    setupDhProject(root, 'm5', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## [2026-06-12] mixed\n- ADR 없음 but mentions ADR 0040 별개\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-12');
  });
});

test('marker: only the latest entry is excluded → earlier design entry still governs', () => {
  // Excluding the no-design latest entry must reveal the prior design entry's
  // date, not collapse to clean. 06-08 (ADR 0040) > design-history 06-01.
  withTmpDir((root) => {
    setupDhProject(root, 'm6', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd:
        '## [2026-06-08] design (ADR 0040)\n- [[decisions/0040]]\n\n## [2026-06-11] cleanup\n- ADR 없음 — docs\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-08');
  });
});

test('regex: bracketless "## YYYY-MM-DD" session-log heading is parsed', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'm7', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## 2026-06-07 bracketless SHIP entry\nbody\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-07');
  });
});

test('regex: malformed partial bracket "## [2026-06-07" is NOT a valid heading', () => {
  // Two-branch regex (not \[?...\]?) rejects half-bracketed headings.
  withTmpDir((root) => {
    setupDhProject(root, 'm8', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## [2026-06-20 missing close bracket\nbody\n## [2026-06-05] real\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-05'); // 06-20 ignored (malformed)
  });
});

test('regex: trailing-only bracket "## 2026-06-20]" is NOT a valid heading', () => {
  // The bare branch must reject a stray closing bracket via (?!\]); otherwise it
  // would match the date and ignore the `]` (codex pre-commit review).
  withTmpDir((root) => {
    setupDhProject(root, 'm8b', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd: '## 2026-06-20] stray close bracket\nbody\n## [2026-06-05] real\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-05'); // 06-20] ignored (malformed)
  });
});

test('parse: last entry without trailing newline is sliced to EOF', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'm9', {
      dh: '## 2026-06-01\ninitial\n',
      sessionLogMd:
        '## [2026-06-05] first\nbody\n## [2026-06-15] last no newline\n- ADR 없음 — eof',
    });
    // last entry (06-15) is "ADR 없음" → excluded even at EOF; 06-05 has no
    // marker → included → governs.
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-06-05');
  });
});

suite('fix #49: lint.mjs --json W8 wiring');

test('w8-lint-emits-id-and-posix-file-in-json', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-05-10\nfoo\n',
      sessionLogMd: '## [2026-05-20] s\n',
    });
    // pages/ scan dir is required by lint.mjs even if empty
    mkdirSync(join(root, 'pages'), { recursive: true });
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${root}`, '--json'],
      {
        encoding: 'utf-8',
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    const parsed = JSON.parse(r.stdout);
    const w8 = (parsed.warns || []).filter((w) => w.id === 'W8');
    assert.equal(w8.length, 1, `expected one W8 warn, got: ${JSON.stringify(parsed.warns)}`);
    assert.equal(w8[0].file, 'projects/demo/design-history.md');
    assert.ok(w8[0].message.includes('design-history stale'));
    assert.equal(w8[0].id, 'W8');
  });
});

function lintWarnsFor(root, id, extraArgs = []) {
  mkdirSync(join(root, 'pages'), { recursive: true });
  const r = spawnSync(
    process.execPath,
    [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${root}`, '--json', ...extraArgs],
    {
      encoding: 'utf-8',
      env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
    },
  );
  // default (non-strict) --json exposes ids for W8 and W19 only, so match W14 by message
  return (JSON.parse(r.stdout).warns || []).filter((w) =>
    id === 'W14' ? w.message.includes('design-history missing') : w.id === id,
  );
}

test('w19-lint-overflow-only: W19 not W8, no ">" comparison, names file and literal, leads with fixing the heading', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-03-02\nfoo\n',
      sessionLogMd: '## [2026-02-30] s\n',
    });
    // W8 is the close-gate blocker; a heading typo must not be one.
    assert.equal(lintWarnsFor(root, 'W8').length, 0, 'overflow alone is never W8');
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1);
    const m = w19[0].message;
    assert.ok(!m.includes('>'), `no false ordering claim: ${m}`);
    assert.ok(m.includes('projects/demo/session-log.md: 2026-02-30'));
    assert.ok(m.includes('실제 날짜로 고치세요'));
    assert.ok(!/\d+일 차이/.test(m), 'no invented day gap');
    assert.ok(
      m.indexOf('실제 날짜로 고치세요') < m.indexOf('append'),
      'fix-the-heading comes first',
    );
  });
});

test('w19-lint-default-json: default --json (no --strict) exposes W19 with its id, as W8 is, and stays a warn', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-03-02\nfoo\n',
      sessionLogMd: '## [2026-02-30] s\n',
    });
    const w19 = lintWarnsFor(root, 'W19');
    assert.equal(w19.length, 1, 'W19 must carry its id without --strict');
    assert.equal(w19[0].severity, 'warn');
    assert.equal(w19[0].file, 'projects/demo/design-history.md');
    assert.ok(w19[0].message.includes('2026-02-30'));
  });
});

test('w19-lint-strict: W19 is not promoted, exit 0 and still a warn', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '---\ntitle: dh\ntype: reference\nupdated: 2026-03-02\n---\n\n## 2026-03-02\nfoo\n',
      sessionLogMd:
        '---\ntitle: sl\ntype: session-log\nupdated: 2026-03-02\n---\n\n## [2026-02-30] s\n',
    });
    mkdirSync(join(root, 'pages'), { recursive: true });
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W19 is outside STRICT_PROMOTE_IDS');
    assert.equal(parsed.ok, true);
    assert.equal((parsed.warns || []).filter((w) => w.id === 'W19').length, 1);
  });
});

test('w19-lint-fenced-heading: an overflow heading inside a ``` fence is example text, no W19', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-25\nfoo\n',
      // daily-shard shape: frontmatter, then `## [date] session | project`
      sessionLogMd:
        '---\ntitle: sl\ntype: session-log\nupdated: 2026-02-25\n---\n\n## [2026-02-25] session | demo\n\n```md\n## [2026-02-30] example\n```\n',
    });
    assert.equal(lintWarnsFor(root, 'W19', ['--strict']).length, 0);
    assert.equal(lintWarnsFor(root, 'W8').length, 0);
  });
});

test('w8-lint-fenced-real-date: a fenced later real date does not raise W8', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-25\nfoo\n',
      sessionLogMd: '## [2026-02-25] a\n\n~~~\n## [2026-12-25] example\n~~~\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 0);
  });
});

test('w8-lint-fenced-heading-stays-in-entry: a fenced heading does not split an ADR 없음 entry', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-01\nfoo\n',
      sessionLogMd: '## [2026-02-10] a\n```\n## [2026-02-20] x\n```\nADR 없음\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 0, 'whole entry is one no-design entry');
  });
});

test('w19-lint-fenced-unclosed: an unclosed fence never opened, so later headings still count', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-25\nfoo\n',
      sessionLogMd: '## [2026-02-25] a\n\n```\n## [2026-02-30] x\n\n## [2026-12-25] y\n',
    });
    // fail-closed: the heading after the unclosed fence is a real later date
    const w8 = lintWarnsFor(root, 'W8');
    assert.equal(w8.length, 1, 'unclosed fence must not hide the later heading');
    assert.ok(w8[0].message.includes('2026-12-25'), w8[0].message);
    assert.ok(w8[0].message.includes('2026-02-30'), w8[0].message);
  });
});

test('w8-lint-fenced-adr-marker-stays-fenced: a fenced example ADR 없음 does not exclude the real entry around it', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-10-02] session | p\ndesigned X...\n\n```md\n## [2026-01-01] example\nADR 없음: example\n```\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
  });
});

test('w8-lint-unclosed-fence-then-no-adr-entry: an unclosed fence in a design entry does not swallow a same-day ADR 없음 entry', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-10-02] session | p\ndesigned X\n\n```\nsnippet\n\n## [2026-02-30] session | p\nADR 없음\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
    // W8 comes from the first entry alone; the later heading's own outcome is W19
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1, 'the later heading must survive the unclosed fence');
    assert.ok(w19[0].message.includes('2026-02-30'), w19[0].message);
  });
});

test('w8-lint-nested-same-length-fence: a ```md fence closed by an inner ``` leaves the last ``` unclosed, headings after it still count', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-10-02] session | p\ndesigned X\n\n```md\nexample:\n```js\nx\n```\n```\n\n## [2026-02-30] session | p\nADR 없음\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1, 'the later heading must survive the fence');
    assert.ok(w19[0].message.includes('2026-02-30'), w19[0].message);
  });
});

test('w8-lint-fence-opened-by-earlier-session: a ``` left unclosed by one session is not closed by a later session, so the later real heading still counts', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-09-01] session | demo\nADR 없음\n\n```\nleft open\n\n## [2026-10-02] session | demo\ndesigned X\n\n```\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1, 'the later session heading is live');
  });
});

test('w8-lint-comment-opened-by-earlier-session: a <!-- left open by one session is not closed by a later session --> either', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-09-01] session | demo\nADR 없음\n\n<!-- left open\n\n## [2026-10-02] session | demo\ndesigned X\n\nnote -->\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1, 'the later session heading is live');
  });
});

test('w8-lint-retired-fence-adr-example: an ADR 없음 example in a fence left open until the next entry does not exclude the real design entry', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-10-02] session | demo\ndesigned X\n\n```\nADR 없음: example\n\n## [2026-10-02] session | demo\nADR 없음\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1, 'the example marker must not count');
  });
});

test('w8-lint-retired-comment-adr-example: the same for a <!-- left open until the next entry', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-10-02] session | demo\ndesigned X\n\n<!--\nADR 없음: example\n\n## [2026-10-02] session | demo\nADR 없음\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1, 'the example marker must not count');
  });
});

test('w8-lint-eof-unclosed-fence-adr-example: an ADR 없음 example in a fence left open to EOF does not exclude the real design entry', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd: '## [2026-10-02] session | demo\ndesigned X\n\n```\nADR 없음: example\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
  });
});

test('w8-lint-design-history-frontmatter-heading: a `## 2026-12-25` YAML comment in design-history frontmatter is not a date', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '---\ntitle: dh\n## 2026-12-25 example\n---\n\n## 2026-09-01\nfoo\n',
      sessionLogMd: '## [2026-10-02] session | demo\ndesigned X\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1, 'the frontmatter date must not cover October');
  });
});

test('w8-lint-session-log-frontmatter-heading: a `## [date]` YAML comment in session-log frontmatter makes no false W8', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd: '---\ntitle: sl\n## [2026-12-25] example\n---\n\n## [2026-08-30] s\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 0, 'the frontmatter line is not an entry');
  });
});

test('w8-lint-frontmatter-fence-scalar: a ``` in a frontmatter block scalar does not open a fence over the body', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '---\ntitle: sl\nnote: |\n  ```\n---\n\n## [2026-10-02] session | p\ndesigned X\n\n```\nex\n```\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
  });
});

test('w19-lint-bom-frontmatter-fence-scalar: a BOM before the frontmatter does not let a ``` block scalar swallow the body', () => {
  withTmpDir((root) => {
    const sessionLogMd =
      '\uFEFF---\ntitle: sl\nnote: |\n  ```\n---\n\n## [2026-02-30] x\n\n```\nex\n```\n';
    assert.equal(sessionLogMd.charCodeAt(0), 0xfeff, 'precondition: the shard starts with a BOM');
    setupDhProject(root, 'demo', { dh: '## 2026-02-25\nfoo\n', sessionLogMd });
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1, JSON.stringify(w19));
    assert.ok(w19[0].message.includes('2026-02-30'), w19[0].message);
  });
});

test('w19-lint-html-comment-heading: an overflow heading inside an HTML comment is example text, no W19', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-03-02\nfoo\n',
      sessionLogMd: '## [2026-03-01] s\n\n<!--\n## [2026-02-30] example\n-->\n',
    });
    assert.equal(lintWarnsFor(root, 'W19', ['--strict']).length, 0);
  });
});

test('w8-lint-fenced-design-history-date: a fenced ## date in design-history.md does not count as the latest entry', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n\n```\n## 2026-12-31\n```\n',
      sessionLogMd: '## [2026-10-02] session | p\ndesigned X\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
  });
});

test('w19-lint-fenced-mixed-chars: a ~~~ fence is not closed by ```, and is closed by ~~~', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-25\nfoo\n',
      sessionLogMd:
        '## [2026-02-25] a\n\n~~~\n```\n## [2026-02-30] x\n```\n~~~\n\n## [2026-02-31] y\n',
    });
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1);
    assert.ok(w19[0].message.includes('2026-02-31'), w19[0].message);
    assert.ok(!w19[0].message.includes('2026-02-30'), w19[0].message);
  });
});

test('w19-lint-fenced-crlf: CRLF fence lines still open and close a fence', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-25\nfoo\n',
      sessionLogMd:
        '## [2026-02-25] a\r\n\r\n```\r\n## [2026-02-30] x\r\n```\r\n\r\n## [2026-02-31] y\r\n',
    });
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1);
    assert.ok(w19[0].message.includes('2026-02-31'), w19[0].message);
    assert.ok(!w19[0].message.includes('2026-02-30'), w19[0].message);
  });
});

test('w19-lint-unfenced-still-flagged: an overflow heading after a closed fence is still W19', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-03-02\nfoo\n',
      sessionLogMd: '```\nexample\n```\n\n## [2026-02-30] s\n',
    });
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1);
    assert.ok(w19[0].message.includes('2026-02-30'), w19[0].message);
  });
});

// Disabling the check: in scripts/lib/code-fence.mjs scanOnce, change `comment || skip.has(key)`
// to `skip.has(key)` so a fence marker is read even on a line inside a comment.
test('w8-lint-fence-markers-in-comments-do-not-pair: markers inside two comments do not hide the real heading between them', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '---\ntitle: sl\ntype: session-log\nupdated: 2026-10-02\n---\n\n<!--\n```\n-->\n\n## [2026-10-02] session | demo\ndesigned X\n\n<!--\n```\n-->\n',
    });
    assert.equal(
      lintWarnsFor(root, 'W8').length,
      1,
      'real heading between the comments stays live',
    );
  });
});

// Disabling the check: in scripts/lib/code-fence.mjs scanOnce, drop the
// `!(m[1][0] === '`' && m[2].includes('`'))` clause so a backtick in the info string still opens.
test('w8-lint-backtick-info-string-is-not-a-fence: ```js`x` opens nothing, so the heading after it stays live', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '## [2026-09-01] a\n\n```js`x`\n## [2026-10-02] session | demo\ndesigned X\n```\n',
    });
    assert.equal(lintWarnsFor(root, 'W8').length, 1);
  });
});

// Disabling the check: in scripts/lib/design-history-stale.mjs parseSessionDates, push the
// overflow literal only when `!excluded`.
test('w19-lint-adr-none-overflow: an overflow heading inside an `ADR 없음` entry is W19, and never W8', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd:
        '---\ntitle: sl\ntype: session-log\nupdated: 2026-09-01\n---\n\n## [2026-02-30] session | demo\nADR 없음\n',
    });
    const w19 = lintWarnsFor(root, 'W19');
    assert.equal(w19.length, 1, JSON.stringify(w19));
    assert.ok(w19[0].message.includes('projects/demo/session-log.md: 2026-02-30'), w19[0].message);
    assert.equal(lintWarnsFor(root, 'W8').length, 0, 'a no-design entry never makes W8');
  });
});

test('w19-lint-adr-none-overflow-no-dh: an `ADR 없음` overflow heading with no design-history.md is W19 only, no W14', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', { sessionLogMd: '## [2026-02-30] session | demo\nADR 없음\n' });
    assert.equal(lintWarnsFor(root, 'W19').length, 1);
    assert.equal(lintWarnsFor(root, 'W14').length, 0);
  });
});

test('w19-findDesignHistoryStale-kind-overflow: only a no-design overflow heading gives kind overflow with the literal and file', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p', {
      dh: '## 2026-09-01\nfoo\n',
      sessionLogMd: '## [2026-08-01] a\nADR 없음\n\n## [2026-02-30] b\nADR 없음\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].kind, 'overflow');
    assert.deepEqual(stale[0].calendarOverflow, [
      { literal: '2026-02-30', file: 'projects/p/session-log.md' },
    ]);
  });
});

test('w8-lint-real-later-with-overflow: a real later date keeps id W8 and its overflow tail', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-20\nfoo\n',
      sessionLogMd: '## [2026-02-30] a\n\n## [2026-02-25] b\n',
    });
    // The overflow heading is also its own W19 now (close lists only W19 as a notice).
    const w19 = lintWarnsFor(root, 'W19', ['--strict']);
    assert.equal(w19.length, 1, JSON.stringify(w19));
    assert.ok(w19[0].message.includes('2026-02-30'), w19[0].message);
    const w8 = lintWarnsFor(root, 'W8');
    assert.equal(w8.length, 1);
    assert.ok(w8[0].message.includes('2026-02-30'));
  });
});

test('w8-lint-overflow-beside-real-later-date: keeps the ">" message and the real gap, plus the overflow tail', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-02-20\nfoo\n',
      sessionLogMd: '## [2026-02-30] a\n\n## [2026-02-25] b\n',
    });
    const m = lintWarnsFor(root, 'W8')[0].message;
    assert.ok(m.includes('최신=2026-02-25 > design-history 최신=2026-02-20 (5일 차이)'));
    assert.ok(m.includes('projects/demo/session-log.md: 2026-02-30'));
    // Clearing W8 by appending to design-history would leave the bad heading in place, so the
    // message must also say to fix it.
    assert.ok(m.includes('이 헤딩 날짜도 실제 날짜로 고치세요'), m);
  });
});

test('w14-lint-overflow-beside-real-date: missing design-history with a real date still says to fix the bad heading', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      sessionLogMd: '## [2026-02-30] a\n\n## [2026-02-25] b\n',
    });
    const all = lintWarnsFor(root, 'W14', ['--strict']);
    assert.equal(all.length, 1);
    const m = all[0].message;
    assert.ok(m.includes('최신=2026-02-25'), m);
    assert.ok(m.includes('projects/demo/session-log.md: 2026-02-30'), m);
    assert.ok(m.includes('위 session-log 헤딩 날짜도 실제 날짜로 고치세요'), m);
  });
});

test('w14-lint-overflow-only: missing design-history with no real date also says to fix the heading', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', { sessionLogMd: '## [2026-09-31] s\n' });
    const w14 = lintWarnsFor(root, 'W14');
    assert.equal(w14.length, 1);
    assert.ok(w14[0].message.includes('(유효한 날짜 없음)'));
    assert.ok(w14[0].message.includes('projects/demo/session-log.md: 2026-09-31'));
    assert.ok(w14[0].message.includes('실제 날짜로 고치세요'));
  });
});

// Disabling the check: remove the W19 issue() in the `s.kind === 'missing'`
// branch of the design-history loop in scripts/lint.mjs.
test('w19-missing-dh-overflow: missing design-history plus an overflow heading also emits one W19 with its id; W14 is unchanged', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', { sessionLogMd: '## [2026-02-30] a\n\n## [2026-02-25] b\n' });
    const w19 = lintWarnsFor(root, 'W19');
    assert.equal(w19.length, 1, 'default --json shows the overflow as W19');
    assert.equal(w19[0].severity, 'warn');
    assert.equal(w19[0].file, 'projects/demo/design-history.md');
    assert.ok(w19[0].message.includes('projects/demo/session-log.md: 2026-02-30'), w19[0].message);
    assert.ok(w19[0].message.includes('실제 날짜로 고치세요'), w19[0].message);
    assert.ok(
      !w19[0].message.includes('design-history와'),
      'no compare-with-design-history advice',
    );
    assert.equal(lintWarnsFor(root, 'W14').length, 1, 'W14 itself is still emitted once');
  });
});

test('w19-missing-dh-no-overflow: missing design-history without an overflow heading emits no W19', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', { sessionLogMd: '## [2026-05-20] s\n' });
    assert.equal(lintWarnsFor(root, 'W19').length, 0);
    assert.equal(lintWarnsFor(root, 'W14').length, 1);
  });
});

test('w8-lint-omits-id-for-other-warns', () => {
  withTmpDir((root) => {
    // page with frontmatter missing `updated` field → W warn without id
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', 'a.md'), '---\ntitle: a\ntype: concept\n---\n\nbody\n');
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${root}`, '--json'],
      {
        encoding: 'utf-8',
        env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME },
      },
    );
    const parsed = JSON.parse(r.stdout);
    const nonId = (parsed.warns || []).filter((w) => !('id' in w));
    assert.ok(
      nonId.length >= 1,
      `expected warns other than W8 and W19 to omit id field: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

// ── W14: design-history.md missing entirely, session-log carries a design
// entry. Distinct id from W8 on purpose: hypo-shared.mjs's PreCompact gate
// filters strictly on `w.id === 'W8'` to hard-block an active project on
// staleness, and W14 must never enter that path (a bootstrap gap on most
// live projects would otherwise block every one of them at once).

suite('W14: design-history missing (bootstrap gap)');

test('w14-lint-emits-warn-with-distinct-message-and-no-W8-id', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', { sessionLogMd: '## [2026-05-20] s\n' }); // no dh
    mkdirSync(join(root, 'pages'), { recursive: true });
    const r = runLintE(root);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `missing design-history must not fail lint: ${r.stdout}`);
    assert.equal(parsed.ok, true);
    const missing = (parsed.warns || []).filter((w) =>
      w.message.includes('design-history missing'),
    );
    assert.equal(missing.length, 1, `expected one W14 warn: ${JSON.stringify(parsed.warns)}`);
    assert.equal(missing[0].file, 'projects/demo/design-history.md');
    // must not be mistaken for a stale (W8) finding — different message body
    assert.ok(!missing[0].message.includes('design-history stale'));
    // default (non-strict) --json hides ids for anything but W8 and W19
    assert.ok(!('id' in missing[0]));
    const w8 = (parsed.warns || []).filter((w) => w.id === 'W8');
    assert.equal(w8.length, 0, 'a missing file has nothing to compare, so it is never W8');
  });
});

test('w14-strict: --strict exposes id W14 and does not promote it to an error', () => {
  withTmpDir((root) => {
    // valid frontmatter on the session-log so the *only* finding is W14 —
    // otherwise a bare session-log.md trips W1 (no-frontmatter), which
    // --strict promotes and would mask what this test asserts.
    setupDhProject(root, 'demo', {
      sessionLogMd:
        '---\ntitle: sl\ntype: session-log\nupdated: 2026-05-20\n---\n\n## [2026-05-20] s\n',
    }); // no dh
    mkdirSync(join(root, 'pages'), { recursive: true });
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W14 is excluded from STRICT_PROMOTE_IDS → exit 0');
    assert.equal(parsed.ok, true);
    const w14 = (parsed.warns || []).filter((w) => w.id === 'W14');
    assert.equal(w14.length, 1, `W14 stays a warn under --strict: ${JSON.stringify(parsed.warns)}`);
  });
});

test('w14-clean: project WITH design-history.md never emits W14, only W8/none', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'demo', {
      dh: '## 2026-05-10\nfoo\n',
      sessionLogMd: '## [2026-05-20] s\n',
    });
    mkdirSync(join(root, 'pages'), { recursive: true });
    const r = runLintE(root);
    const parsed = JSON.parse(r.stdout);
    const missing = (parsed.warns || []).filter((w) =>
      w.message.includes('design-history missing'),
    );
    assert.equal(
      missing.length,
      0,
      `existing file must never trip W14: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

// ── W15: synthesis page stale relative to its sources_consulted ─────────────
// A type:synthesis page absorbs other pages; if a source's `updated` moved
// past the synthesis's own `updated`, the synthesis has not caught up.
// `sources_consulted: [name, ...]` uses the same bracket-list shape lint
// already parses for `tags` (parseTagsField), reused rather than re-invented.

suite('W15/W16: synthesis staleness (sources_consulted)');

test('source newer than synthesis → W15 warn with distinct message and no W8/W14 id', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-02-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `stale synthesis must not fail lint: ${r.stdout}`);
    assert.equal(parsed.ok, true);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 1, `expected one W15 warn: ${JSON.stringify(parsed.warns)}`);
    assert.equal(stale[0].file, 'pages/syn.md');
    assert.ok(
      !('id' in stale[0]),
      'default (non-strict) --json hides ids for anything but W8 and W19',
    );
  });
});

test('synthesis at least as fresh as every source → no W15 warn', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-01-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-01\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(
      stale.length,
      0,
      `fresh synthesis must not trip W15: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

test('unresolved sources_consulted entry yields no W15 but a W16 naming it', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [does-not-exist]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(
      stale.length,
      0,
      `no date to compare means no staleness verdict: ${JSON.stringify(parsed.warns)}`,
    );
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 1, `expected one W16 warn: ${JSON.stringify(parsed.warns)}`);
    assert.equal(unres[0].file, 'pages/syn.md');
    assert.ok(
      unres[0].message.includes('does-not-exist'),
      `W16 must name the unresolved entry: ${unres[0].message}`,
    );
    assert.ok(
      unres[0].message.includes('1/1'),
      `W16 must report coverage, not just the fact: ${unres[0].message}`,
    );
    assert.ok(
      unres[0].message.includes('없는 이름'),
      `W16 must say WHY the source could not be compared: ${unres[0].message}`,
    );
  });
});

test('W15 compares against the NEWEST source, not the first or the oldest', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    // Ordered oldest-first on purpose: a rule that keeps the first date, or
    // that keeps the minimum, produces no warning here. Only picking the
    // maximum crosses the synthesis's own 2026-02-01.
    writeFileSync(
      join(root, 'pages', 'source-old.md'),
      '---\ntitle: source-old\ntype: concept\nupdated: 2026-01-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'source-new.md'),
      '---\ntitle: source-new\ntype: concept\nupdated: 2026-03-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-01\n' +
        'sources_consulted: [source-old, source-new]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 1, `newest source must win: ${JSON.stringify(parsed.warns)}`);
    assert.ok(
      stale[0].message.includes('최신=2026-03-01'),
      `W15 must report the maximum source date: ${stale[0].message}`,
    );
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 0, 'both sources resolve, so no W16');
  });
});

test('a source in a subdirectory resolves by bare name and by dir-relative name', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages', 'learnings'), { recursive: true });
    // Every fixture above puts source and synthesis side by side in pages/,
    // where slugForms' full/bare/dirRel collapse to one string and the map
    // cannot be told apart from a bare-only map. Here they differ:
    // full=pages/learnings/deep, bare=deep, dirRel=learnings/deep.
    writeFileSync(
      join(root, 'pages', 'learnings', 'deep.md'),
      '---\ntitle: deep\ntype: learning\nupdated: 2026-03-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn-bare.md'),
      '---\ntitle: syn-bare\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [deep]\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn-rel.md'),
      '---\ntitle: syn-rel\ntype: synthesis\nupdated: 2026-01-01\n' +
        'sources_consulted: [learnings/deep]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const staleFiles = (parsed.warns || [])
      .filter((w) => w.message.includes('synthesis stale'))
      .map((w) => w.file)
      .sort();
    assert.deepEqual(
      staleFiles,
      ['pages/syn-bare.md', 'pages/syn-rel.md'],
      `both slug forms must resolve: ${JSON.stringify(parsed.warns)}`,
    );
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 0, `neither form is unresolved: ${JSON.stringify(parsed.warns)}`);
  });
});

test('a source name claimed by two pages is not compared, and W16 says so', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages', 'a'), { recursive: true });
    mkdirSync(join(root, 'pages', 'b'), { recursive: true });
    // Same bare name under two directories. Picking either date would make the
    // verdict depend on walk order: one of them is newer than the synthesis
    // and the other is not.
    writeFileSync(
      join(root, 'pages', 'a', 'dup.md'),
      '---\ntitle: dup a\ntype: concept\nupdated: 2026-01-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'b', 'dup.md'),
      '---\ntitle: dup b\ntype: concept\nupdated: 2026-03-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-01\nsources_consulted: [dup]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 0, `an ambiguous name must not decide staleness: ${r.stdout}`);
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 1, `expected one W16 warn: ${r.stdout}`);
    assert.ok(
      unres[0].message.includes('2개 페이지가 같은 이름'),
      `W16 must name ambiguity as the reason: ${unres[0].message}`,
    );
  });
});

test('a page directly under pages/ is not mistaken for its own collision', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    // slugForms collapses bare and dirRel to the same string here. Counting raw
    // values instead of distinct ones would report every such page as a
    // two-page collision and suppress every W15 in the vault.
    writeFileSync(
      join(root, 'pages', 'flat.md'),
      '---\ntitle: flat\ntype: concept\nupdated: 2026-03-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [flat]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 1, `a flat page must still resolve: ${r.stdout}`);
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 0, `no ambiguity here: ${r.stdout}`);
  });
});

test('a source that exists but has no usable date is reported, not called missing', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    // Present, so calling it a missing name would be wrong. Its date cannot be
    // compared, so using it would be wrong too.
    writeFileSync(
      join(root, 'pages', 'nodate.md'),
      '---\ntitle: nodate\ntype: concept\n---\n\nbody\n',
    );
    // Lexically greater than 2026-02-01, chronologically earlier. A raw string
    // compare would call the synthesis stale on the strength of this.
    writeFileSync(
      join(root, 'pages', 'sloppy.md'),
      '---\ntitle: sloppy\ntype: concept\nupdated: 2026-3-1\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-01\n' +
        'sources_consulted: [nodate, sloppy]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 0, `an unusable date must not decide staleness: ${r.stdout}`);
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 1, `expected one W16 warn: ${r.stdout}`);
    assert.ok(
      unres[0].message.includes('2/2'),
      `both sources are uncomparable: ${unres[0].message}`,
    );
    assert.ok(
      !unres[0].message.includes('없는 이름'),
      `neither source is missing; both exist: ${unres[0].message}`,
    );
  });
});

test('strict: W16 exposes its id but is not promoted to an error', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [does-not-exist]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json', '--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W16 is excluded from STRICT_PROMOTE_IDS → exit 0');
    assert.equal(parsed.ok, true);
    const w16 = (parsed.warns || []).filter((w) => w.id === 'W16');
    assert.equal(w16.length, 1, `W16 stays a warn under --strict: ${JSON.stringify(parsed.warns)}`);
  });
});

test('synthesis page without sources_consulted never trips W15', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 0);
  });
});

test('strict: W15 exposes its id but is not promoted to an error', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-02-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json', '--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W15 is excluded from STRICT_PROMOTE_IDS → exit 0');
    assert.equal(parsed.ok, true);
    const w15 = (parsed.warns || []).filter((w) => w.id === 'W15');
    assert.equal(w15.length, 1, `W15 stays a warn under --strict: ${JSON.stringify(parsed.warns)}`);
  });
});

test('calendar-overflow source updated (2026-02-30) is not compared, and W16 says so', () => {
  // A format-only check reads 2026-02-30 as a valid YYYY-MM-DD literal, and
  // `new Date('2026-02-30')` normalizes it to March 2 instead of failing, so
  // this source used to win the "newest" comparison outright. It must land
  // in the same "no usable updated" bucket as a missing date.
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-02-30\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 0, `an unparseable source date must not win W15: ${r.stdout}`);
    const unres = (parsed.warns || []).filter((w) =>
      w.message.includes('sources_consulted 비교 불가'),
    );
    assert.equal(unres.length, 1, `expected one W16 warn: ${JSON.stringify(parsed.warns)}`);
    assert.ok(
      unres[0].message.includes('source-a') && unres[0].message.includes('실제 날짜가 아님'),
      `W16 must name the calendar-invalid source: ${unres[0].message}`,
    );
  });
});

test('calendar-overflow synthesis updated (2026-02-30) skips W15 and W16 names its own field', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-03-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-30\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 0, 'an unparseable own date must not compare at all');
    const ownWarn = (parsed.warns || []).filter(
      (w) => w.file === 'pages/syn.md' && w.message.includes('synthesis 자신의 updated'),
    );
    assert.equal(
      ownWarn.length,
      1,
      `W16 must name the synthesis's own invalid updated: ${JSON.stringify(parsed.warns)}`,
    );
    assert.ok(
      ownWarn[0].message.includes('2026-02-30'),
      `W16 must include the bad value: ${ownWarn[0].message}`,
    );
    const strict = JSON.parse(run('lint.mjs', [`--hypo-dir=${root}`, '--json', '--strict']).stdout);
    const ownStrict = [...(strict.warns || []), ...(strict.errors || [])].filter((w) =>
      w.message.includes('synthesis 자신의 updated'),
    );
    assert.deepEqual(
      ownStrict.map((w) => w.id),
      ['W16'],
      `the own-date warning must carry id W16: ${JSON.stringify(ownStrict)}`,
    );
  });
});

test('invalid synthesis updated is reported even when sources_consulted is a block list', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-30\n' +
        'sources_consulted:\n  - source-a\n---\n\nbody\n',
    );
    const parsed = JSON.parse(run('lint.mjs', [`--hypo-dir=${root}`, '--json']).stdout);
    const mine = (parsed.warns || []).filter((w) => w.file === 'pages/syn.md');
    assert.equal(
      mine.filter((w) => w.message.includes('synthesis 자신의 updated')).length,
      1,
      `the own-date W16 must not be hidden by the block-list W16: ${JSON.stringify(mine)}`,
    );
    assert.equal(mine.filter((w) => w.message.includes('블록 목록')).length, 1);
  });
});

test('invalid synthesis updated is reported even with no sources_consulted at all', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-30\n---\n\nbody\n',
    );
    const parsed = JSON.parse(run('lint.mjs', [`--hypo-dir=${root}`, '--json']).stdout);
    const own = (parsed.warns || []).filter(
      (w) => w.file === 'pages/syn.md' && w.message.includes('synthesis 자신의 updated'),
    );
    assert.equal(own.length, 1, `expected the own-date W16: ${JSON.stringify(parsed.warns)}`);
  });
});

test('a valid year below 100 (0001-01-01) is not rejected as a calendar overflow', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 0001-01-01\n---\n\nbody\n',
    );
    const parsed = JSON.parse(run('lint.mjs', [`--hypo-dir=${root}`, '--json']).stdout);
    const own = (parsed.warns || []).filter((w) => w.message.includes('synthesis 자신의 updated'));
    assert.equal(own.length, 0, `0001-01-01 is a real date: ${JSON.stringify(own)}`);
  });
});

test('missing synthesis updated is W3 only, not duplicated as a W16', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-01-15\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const ownWarn = (parsed.warns || []).filter((w) =>
      w.message.includes('synthesis 자신의 updated'),
    );
    assert.equal(ownWarn.length, 0, 'a missing updated is W3 alone, never repeated in W16');
    const w3 = (parsed.warns || []).filter(
      (w) => w.file === 'pages/syn.md' && w.message.includes('Missing frontmatter field: updated'),
    );
    assert.equal(w3.length, 1, `expected the usual W3: ${JSON.stringify(parsed.warns)}`);
  });
});

suite('W16: sources_consulted written as a YAML block list');

test('block list with items on their own indented lines is detected', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\n' +
        'sources_consulted:\n  - source-a\n  - source-b\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const block = (parsed.warns || []).filter(
      (w) => w.file === 'pages/syn.md' && w.message.includes('블록 목록'),
    );
    assert.equal(block.length, 1, `expected one block-list W16: ${JSON.stringify(parsed.warns)}`);
    assert.ok(
      block[0].message.includes('[a, b]'),
      `W16 must point at the flow-list fix: ${block[0].message}`,
    );
    const strict = JSON.parse(run('lint.mjs', [`--hypo-dir=${root}`, '--json', '--strict']).stdout);
    const blockStrict = [...(strict.warns || []), ...(strict.errors || [])].filter((w) =>
      w.message.includes('블록 목록'),
    );
    assert.deepEqual(
      blockStrict.map((w) => w.id),
      ['W16'],
      `the block-list warning must carry id W16: ${JSON.stringify(blockStrict)}`,
    );
  });
});

test('block list with a dash at column 0 (no leading space) is detected', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\n' +
        'sources_consulted:\n- source-a\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const block = (parsed.warns || []).filter(
      (w) => w.file === 'pages/syn.md' && w.message.includes('블록 목록'),
    );
    assert.equal(block.length, 1, `expected the column-0 dash to still count: ${r.stdout}`);
  });
});

test('a comment line and a blank line before the first item do not hide the block list', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-01-01\n' +
        'sources_consulted:\n  # imported citations\n\n  - source-a\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const block = (parsed.warns || []).filter(
      (w) => w.file === 'pages/syn.md' && w.message.includes('블록 목록'),
    );
    assert.equal(block.length, 1, `a leading comment/blank line must not hide it: ${r.stdout}`);
  });
});

test('a block list under a different key does not trip the sources_consulted detector', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'source-a.md'),
      '---\ntitle: source-a\ntype: concept\nupdated: 2026-01-01\n---\n\nbody\n',
    );
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-01\n' +
        'tags:\n  - foo\n  - bar\nsources_consulted: [source-a]\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const block = (parsed.warns || []).filter((w) => w.message.includes('블록 목록'));
    assert.equal(
      block.length,
      0,
      `a block list on a different key must not false-positive: ${JSON.stringify(parsed.warns)}`,
    );
    const stale = (parsed.warns || []).filter((w) => w.message.includes('synthesis stale'));
    assert.equal(stale.length, 0, 'the real flow-list sources_consulted still compares normally');
  });
});

test("an empty sources_consulted: immediately followed by another top-level key's block list is not misread", () => {
  // sources_consulted here has no value and no items of its own: the very
  // next line is the NEXT top-level key (tags:), and that key's own block
  // list sits below it. The detector must stop at that first non-blank line
  // instead of reading past it into `- foo`, or an empty sources_consulted
  // would falsely read as "written as a block list".
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(
      join(root, 'pages', 'syn.md'),
      '---\ntitle: syn\ntype: synthesis\nupdated: 2026-02-01\n' +
        'sources_consulted:\ntags:\n  - foo\n---\n\nbody\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0);
    const block = (parsed.warns || []).filter((w) => w.message.includes('블록 목록'));
    assert.equal(
      block.length,
      0,
      `an empty sources_consulted followed by another key's block list must not false-positive: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

// ── A-2 (project index lifecycle): W12 missing-index warning ────────────────
// scripts/lint.mjs: a projects/<slug>/ directory with no index.md warns — never
// errors, since a hard block would stop /compact for every pre-existing
// project that predates crystallize.mjs's A-1 create-on-close.

suite('W12: missing project index.md');

test('project dir without index.md → W12 warn, ok:true, exit 0', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    mkdirSync(join(root, 'projects', 'no-index'), { recursive: true });
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `missing index must not fail lint: ${r.stdout}`);
    assert.equal(parsed.ok, true);
    const w12 = (parsed.warns || []).filter((w) =>
      /Missing project index: projects\/no-index\//.test(w.message),
    );
    assert.equal(w12.length, 1, `expected one W12 warn: ${JSON.stringify(parsed.warns)}`);
  });
});

test('project dir WITH index.md → no W12 warn for it', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    mkdirSync(join(root, 'projects', 'has-index'), { recursive: true });
    writeFileSync(
      join(root, 'projects', 'has-index', 'index.md'),
      '---\ntitle: has-index — Index\ntype: project-index\nstatus: active\nstarted: 2026-01-01\nupdated: 2026-01-01\nworking_dir: /tmp/x\n---\n\n# has-index\n',
    );
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, `well-formed index must not fail lint: ${r.stdout}`);
    const w12 = (parsed.warns || []).filter((w) => /Missing project index/.test(w.message));
    assert.equal(w12.length, 0, `has-index must not trigger W12: ${JSON.stringify(parsed.warns)}`);
  });
});

// Any `_`-prefixed directory is excluded, not just `_template` — matching the
// markdown collector's own convention (scripts/lib/wikilink.mjs's
// skipUnderscoreDir treats `_`-prefixed dirs as scaffold, not content).
test('any `_`-prefixed project directory is excluded from the W12 scan', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    mkdirSync(join(root, 'projects', '_scratch'), { recursive: true }); // no index.md
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json']);
    const parsed = JSON.parse(r.stdout);
    const w12 = (parsed.warns || []).filter((w) => /Missing project index/.test(w.message));
    assert.equal(
      w12.length,
      0,
      `_-prefixed dirs must be excluded: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

// CONCERN 1 fix: W12's own statSync is now wrapped in try/catch (mirroring
// doctor.mjs's identical project-anchor scan guard), so a dangling symlink
// entry reaching THIS loop is skipped, not thrown. No end-to-end test via the
// lint.mjs CLI is possible for this today: a bare dangling symlink placed
// directly under projects/ is stat'd — and throws — earlier in the SAME run,
// in two pre-existing unguarded traversals this slice does not touch
// (scripts/lib/wikilink.mjs's walkMarkdown, run by collectPagesLint before the
// page loop; scripts/lib/design-history-stale.mjs's own project loop, run for
// W8 before W12). Both crash on the identical dangling-symlink shape,
// independent of any fix here, so no fixture reaches W12's code at all while
// they stay unguarded. See out_of_scope.

test('--strict does not promote W12 (stays a warn, exit 0)', () => {
  withTmpDir((root) => {
    mkdirSync(join(root, 'pages'), { recursive: true });
    mkdirSync(join(root, 'projects', 'no-index'), { recursive: true });
    const r = run('lint.mjs', [`--hypo-dir=${root}`, '--json', '--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W12 is excluded from STRICT_PROMOTE_IDS → exit 0');
    assert.equal(parsed.ok, true);
    const w12 = (parsed.warns || []).filter((w) => w.id === 'W12');
    assert.equal(
      w12.length,
      1,
      `W12 must stay a warn under --strict: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

// ── Track E: lint --strict warning→error promotion ──────────────────────────
// spec-v1.3.0 Track E. Stable warning IDs (W1 no-frontmatter / W2 unknown-type
// / W3 missing-updated / W4 broken-wikilink; W8 design-history-stale predates).
// `--strict` promotes STRICT_PROMOTE_IDS = {W1,W2,W4,W9} to errors (exit 1).
// Default mode must stay byte-identical (only W8 and W19 expose `id` in --json).

suite('Track E: lint --strict warning ID promotion');

function runLintE(root, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [join(SCRIPTS, 'lint.mjs'), `--hypo-dir=${root}`, '--json', ...extraArgs],
    { encoding: 'utf-8', env: { ...process.env, HYPO_DIR: '', HOME: SESSION_TMP_HOME } },
  );
}

// page that triggers W2 (unknown-type) + W3 (missing-updated) + W4 (broken-wikilink)
function setupStrictFixture(root) {
  mkdirSync(join(root, 'pages'), { recursive: true });
  writeFileSync(
    join(root, 'pages', 'a.md'),
    '---\ntitle: a\ntype: notarealtype\n---\n\nbody with [[nonexistent-page]] link\n',
  );
}

test('strict: default --json keeps W1/W2/W4 ids internal (byte-identical guard)', () => {
  withTmpDir((root) => {
    setupStrictFixture(root);
    const r = runLintE(root);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'default mode: warnings do not change exit code');
    assert.equal(parsed.ok, true);
    // every warn in this fixture is W2/W3/W4 (no W8) → none may expose `id`
    const withId = (parsed.warns || []).filter((w) => 'id' in w);
    assert.equal(
      withId.length,
      0,
      `default --json must not leak ids other than W8 and W19: ${JSON.stringify(parsed.warns)}`,
    );
    assert.equal((parsed.warns || []).length, 3);
  });
});

test('strict: --strict promotes W2 + W4 to errors and exits 1', () => {
  withTmpDir((root) => {
    setupStrictFixture(root);
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 1, 'promoted warnings exit 1');
    assert.equal(parsed.ok, false);
    const errIds = (parsed.errors || []).map((e) => e.id).sort();
    assert.deepEqual(errIds, ['W2', 'W4'], `expected W2+W4 promoted: ${JSON.stringify(parsed)}`);
    // W3 (missing-updated) is NOT in STRICT_PROMOTE_IDS → stays a warn
    const warnIds = (parsed.warns || []).map((w) => w.id);
    assert.deepEqual(warnIds, ['W3'], `W3 must stay a warn: ${JSON.stringify(parsed.warns)}`);
  });
});

test('strict: W3-only fixture is not promoted (exit 0)', () => {
  withTmpDir((root) => {
    // valid type + valid links → only W3 (missing `updated`) remains
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', 'a.md'), '---\ntitle: a\ntype: concept\n---\n\nbody\n');
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W3 is excluded from STRICT_PROMOTE_IDS → exit 0');
    assert.equal(parsed.ok, true);
    assert.equal((parsed.errors || []).length, 0);
    assert.deepEqual(
      (parsed.warns || []).map((w) => w.id),
      ['W3'],
    );
  });
});

test('strict: W8 design-history-stale is not promoted (exit 0)', () => {
  withTmpDir((root) => {
    // valid frontmatter on both files so the *only* finding is W8 (stale) —
    // otherwise the bare design-history.md/session-log.md trip W1 (no-frontmatter)
    // which --strict would promote, masking what this test asserts.
    setupDhProject(root, 'demo', {
      dh: '---\ntitle: dh\ntype: reference\nupdated: 2026-05-10\n---\n\n## 2026-05-10\nfoo\n',
      sessionLogMd:
        '---\ntitle: sl\ntype: session-log\nupdated: 2026-05-20\n---\n\n## [2026-05-20] s\n',
    });
    mkdirSync(join(root, 'pages'), { recursive: true });
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 0, 'W8 is excluded from STRICT_PROMOTE_IDS → exit 0');
    assert.equal(parsed.ok, true);
    const w8 = (parsed.warns || []).filter((w) => w.id === 'W8');
    assert.equal(w8.length, 1, `W8 stays a warn under --strict: ${JSON.stringify(parsed.warns)}`);
  });
});

test('strict: W1 no-frontmatter promotes and preserves early-return skip', () => {
  withTmpDir((root) => {
    // no frontmatter at all → W1 fires and lintPage returns early, so no
    // "Missing required frontmatter field" errors are also emitted for this page
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', 'a.md'), 'plain body, no frontmatter\n');
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 1);
    assert.equal(parsed.ok, false);
    const errs = parsed.errors || [];
    assert.equal(errs.length, 1, `early-return preserved → only W1: ${JSON.stringify(errs)}`);
    assert.equal(errs[0].id, 'W1');
  });
});

test('strict: the closeRootTargets W1 exemption does not leak to pages/ (ISSUE-98)', () => {
  // Same run, same warning id, two files: a legacy root log.md (exempted) and
  // a pages/ file with the identical defect (not exempted). Only pairing them
  // in one run proves the exemption is scoped by file, not just by id — a
  // disabled exemption would fail on log.md too, and a too-wide exemption
  // would silently pass pages/a.md instead of failing.
  withTmpDir((root) => {
    writeFileSync(join(root, 'log.md'), '# Wiki Log\n\nlegacy, no frontmatter\n');
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'pages', 'a.md'), 'plain body, no frontmatter\n');
    const r = runLintE(root, ['--strict']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(r.status, 1, `pages/a.md's W1 must still fail --strict: ${r.stdout}`);
    const errIds = (parsed.errors || []).map((e) => `${e.file}:${e.id}`);
    assert.deepEqual(
      errIds,
      ['pages/a.md:W1'],
      `only pages/a.md may promote: ${JSON.stringify(parsed.errors)}`,
    );
    const warnW1Files = (parsed.warns || []).filter((w) => w.id === 'W1').map((w) => w.file);
    assert.deepEqual(
      warnW1Files,
      ['log.md'],
      `log.md's W1 must stay a warn: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

suite('code-fence.mjs: one place for fence and comment decisions');

test('fencedLineMask: a fence marker inside an HTML comment is not a fence, so two of them never pair', () => {
  const text = '<!--\n```\n-->\n## real\n<!--\n```\n-->\n';
  assert.deepEqual(fencedLineMask(text), new Array(8).fill(false));
  assert.ok(maskNonProse(text).includes('## real'));
});

test('fencedLineMask: a comment opener inside a fence is fence content, not a comment', () => {
  const text = '```\n<!--\n```\n## real\n-->\n';
  assert.deepEqual(fencedLineMask(text), [true, true, true, false, false, false]);
  assert.ok(maskNonProse(text).includes('## real'), 'the unclosed `<!--` was never opened');
});

test('fencedLineMask: a backtick fence whose info string has a backtick is not an opener; a tilde one is', () => {
  assert.deepEqual(fencedLineMask('```js`x`\na\n```\n'), [false, false, false, false]);
  assert.deepEqual(fencedLineMask('~~~js`x`\na\n~~~\n'), [true, true, true, false]);
  assert.deepEqual(fencedLineMask('```js\na\n```\n'), [true, true, true, false]);
});

test('fencedLineMask: frontmatter lines are never fenced, so a scalar ``` cannot swallow the body', () => {
  const text = '---\nnote: |\n  ```\n## fm\n---\n## h\n```\nx\n```\n';
  assert.deepEqual(fencedLineMask(text), [
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    false,
  ]);
  const masked = maskNonProse(text);
  assert.ok(!masked.includes('## fm'), 'frontmatter text is not prose');
  assert.ok(masked.includes('## h'));
});

test('fencedLineMask: a session entry heading ends an open fence or comment, which then never opened', () => {
  const h = '## [2026-10-02] session | demo';
  assert.deepEqual(fencedLineMask(`\`\`\`\nx\n${h}\ny\n\`\`\`\n`), new Array(6).fill(false));
  assert.ok(maskNonProse(`<!--\nx\n${h}\ny\n-->\n`).includes(h));
  // a plain `## [date] title` heading is no boundary: the fence still pairs across it
  assert.ok(!maskNonProse('```\n## [2026-10-02] title\n```\n').includes('title'));
});

test('retiredLineMask: marks the lines from an unclosed opener to the next entry heading or EOF, nothing else', () => {
  const h = '## [2026-10-02] session | demo';
  assert.deepEqual(retiredLineMask(`a\n\`\`\`\nx\n${h}\ny\n`), [
    false,
    true,
    true,
    false,
    false,
    false,
  ]);
  assert.deepEqual(retiredLineMask('a\n<!--\nx\n'), [false, true, true, true]);
  assert.deepEqual(retiredLineMask('a\n```\nx\n```\nb\n'), new Array(6).fill(false));
});

test('maskNonProse: a leading frontmatter block is blanked whole, same length; no closing --- means no frontmatter', () => {
  const fm = '---\ntitle: t\n## 2026-12-25 x\n---\n## real\n';
  assert.equal(maskNonProse(fm), '   \n        \n               \n   \n## real\n');
  const bom = `\uFEFF${fm}`;
  assert.equal(maskNonProse(bom).length, bom.length);
  assert.ok(!maskNonProse(bom).includes('2026-12-25'));
  const open = '---\n## kept\n';
  assert.equal(maskNonProse(open), open);
});

test('fencedLineMask: an unclosed fence and an unclosed comment never opened', () => {
  assert.deepEqual(fencedLineMask('a\n```\nb\n'), [false, false, false, false]);
  assert.equal(maskNonProse('a <!-- b\n## h\n'), 'a <!-- b\n## h\n');
});

test('maskNonProse: keeps length and newlines, blanks only the comment span and whole fence lines', () => {
  const text = 'x <!-- c --> y\n```\nf\n```\nz\n';
  const out = maskNonProse(text);
  assert.equal(out.length, text.length);
  assert.equal(out, `x${' '.repeat(12)}y\n   \n \n   \nz\n`);
});
