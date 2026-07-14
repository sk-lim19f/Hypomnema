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
import { parseFrontmatter as libParseFrontmatter } from '../scripts/lib/frontmatter.mjs';
import { test, suite } from './harness.mjs';
import {
  HOME,
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

test('project-index missing working_dir → error', () => {
  const { r, out } = lintWithSchema(
    'projects/p/index.md',
    '---\ntitle: T\ntype: project-index\nstatus: active\nstarted: 2026-05-18\nupdated: 2026-05-18\ntags: [project]\n---\nbody\n',
  );
  assert.equal(r.status, 1);
  assert.ok(
    out.errors.some((e) =>
      e.message.includes('Missing required field for type "project-index": working_dir'),
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
    assert.deepEqual([...added].sort(), ['new-tag-a', 'new-tag-b']);
    const vocab = parseSchemaVocab(dir);
    assert.ok(vocab.has('new-tag-a') && vocab.has('new-tag-b'), 'pending tags not in vocab');
    assert.ok(vocab.has('wiki') && vocab.has('concept'), 'existing vocab clobbered');
    // idempotent: a second register of the same tags writes nothing new
    assert.equal(appendPendingTags(dir, ['new-tag-a', 'new-tag-b']).length, 0, 'not idempotent');
    // forbidden patterns are filtered out (registering them is pointless)
    assert.equal(appendPendingTags(dir, ['BadTag']).length, 0, 'forbidden tag registered');
    assert.ok(!parseSchemaVocab(dir).has('BadTag'), 'forbidden tag leaked into vocab');
    // edge tags (codex stage-2): a `"` is non-forbidden and must round-trip; a
    // backtick can't be serialized and is skipped WITHOUT corrupting siblings.
    assert.deepEqual(appendPendingTags(dir, ['has"quote']), ['has"quote']);
    assert.ok(parseSchemaVocab(dir).has('has"quote'), 'quote tag did not round-trip');
    assert.equal(appendPendingTags(dir, ['bad`tick']).length, 0, 'backtick tag must be skipped');
    assert.ok(!parseSchemaVocab(dir).has('bad`tick'), 'backtick tag leaked into vocab');
    assert.ok(parseSchemaVocab(dir).has('new-tag-a'), 'sibling tag lost after edge-case calls');
    // no-op when SCHEMA.md has no Tag Vocabulary header
    const dir2 = mkdtempSync(join(tmpdir(), 'hypo-pending-novocab-'));
    writeFileSync(
      join(dir2, 'SCHEMA.md'),
      '---\ntitle: S\ntype: schema\n---\n# Schema\n\n## 1. Other\n',
    );
    assert.equal(appendPendingTags(dir2, ['x']).length, 0, 'must no-op without a vocab header');
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
    assert.deepEqual(appendPendingTags(dir, ['fresh-tag']), ['fresh-tag']);
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
    return { broken, errors: out.errors, status: r.status };
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

test('w8-skip: project without design-history.md is skipped', () => {
  withTmpDir((root) => {
    setupDhProject(root, 'p4', { sessionLogMd: '## [2026-05-20] s\n' });
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

test('w8-edge: invalid date headings (## [2026-13-01]) are filtered, no Invalid Date crash', () => {
  // codex 2-worker pre-commit review CONCERN: `new Date('2026-13-01')` is an
  // Invalid Date and `toISOString()` on it throws RangeError. Guarantee the
  // parser silently drops malformed dates instead of crashing all of lint.
  withTmpDir((root) => {
    setupDhProject(root, 'p8', {
      dh: '## 2026-05-10\nfoo\n',
      sessionLogMd: '## [2026-13-01] bogus\n## [2026-05-20] real\n',
    });
    const stale = findDesignHistoryStale(root);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].lastSession, '2026-05-20');
  });
});

test('w8-edge: design-history with only invalid dates → stale with diffDays=null', () => {
  // Use month-out-of-range (truly Invalid Date in JS); JS auto-normalizes
  // overflows in the day field (2026-02-30 → 2026-03-02) but ISO 8601 strict
  // parsing rejects month > 12 with NaN — that is the path findDesignHistoryStale
  // must filter to avoid poisoning maxDate.
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
      `expected non-W8 warns to omit id field: ${JSON.stringify(parsed.warns)}`,
    );
  });
});

// ── Track E: lint --strict warning→error promotion ──────────────────────────
// spec-v1.3.0 Track E. Stable warning IDs (W1 no-frontmatter / W2 unknown-type
// / W3 missing-updated / W4 broken-wikilink; W8 design-history-stale predates).
// `--strict` promotes STRICT_PROMOTE_IDS = {W1,W2,W4,W9} to errors (exit 1).
// Default mode must stay byte-identical (only W8 exposes `id` in --json).

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
      `default --json must not leak non-W8 ids: ${JSON.stringify(parsed.warns)}`,
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
