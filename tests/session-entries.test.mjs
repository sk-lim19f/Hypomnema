// tests/session-entries.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not, that is what lets the runner shard.
//
// Covers hooks/session-entries.mjs: the pure session entry format, the baseline
// entry, the path predicates, and the byte-fixed .gitignore/.gitattributes blocks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GITATTRIBUTES_BLOCK,
  GITIGNORE_BLOCK,
  LEGACY_TRACK_ID,
  TRACK_ID_RE,
  assertNoEntryMarkers,
  buildBaselineEntry,
  closeIdFor,
  entryFileName,
  entryMarker,
  buildInjection,
  formatSessionEntry,
  isBaselineId,
  isGeneratedViewPath,
  isSessionEntryPath,
  isSessionProjectDir,
  mergeAdditiveGitignore,
  narrowestVisibilityScope,
  nextUpItems,
  parseSessionEntry,
  renderViews,
  resolveSupersedesPrefix,
  scopeVisible,
  sessionViewPathsOf,
  sortEntries,
  sortRootRows,
  splitLegacyFrontmatter,
  trackHeads,
} from '../hooks/session-entries.mjs';
import {
  clearGeneratedPathsBlockingPull,
  consumeRootHotHealthNotice,
  formatRootHotProjection,
  isIgnored as isIgnoredHooks,
  localChangesOn,
  markPullArchiveMerged,
  pathInHead,
  resolveActiveProject,
  restoreGitignoreLines,
  resumePullArchive,
  revPathArg,
  scopeVisible as sharedScopeVisible,
  shareLegacyBytes,
  upstreamIsMigrated,
  vaultCommitLockTarget,
  vaultGitPrefix,
  withFileLock,
} from '../hooks/hypo-shared.mjs';
import {
  SESSION_ENTRIES_OFF_MARKER,
  listSessionEntries,
  listSessionProjects,
  listTrackedGeneratedViews,
  loadSessionModel,
  migrationState,
  projectEntryScope,
  readObservedHeads,
  recordObservedHeads,
  writeGeneratedViews,
  writeGeneratedViewsUnlocked,
} from '../hooks/session-views.mjs';
import { isIgnored as isIgnoredScripts } from '../scripts/lib/hypo-ignore.mjs';
import { test, suite } from './harness.mjs';
import { SESSION_TMP_HOME, withTmpDir } from './helpers.mjs';

const CID = '2b1c4d5e-aaaa-bbbb-cccc-0123456789ab-412';
const OTHER_CID = '9f9f9f9f-aaaa-bbbb-cccc-0123456789ab-7';

function sample(over = {}) {
  return {
    project: 'p',
    closeId: CID,
    sessionId: '2b1c4d5e-aaaa-bbbb-cccc-0123456789ab',
    date: '2026-10-01',
    visibilityScope: 'machine:devA',
    tracks: [
      { id: 'masking', title: '마스킹 파이프라인', supersedes: ['5f0e-88'] },
      { id: 'flow-inbound', title: '들어오는 흐름', new: true },
      { id: 'legacy', done: true },
    ],
    summary: '이번 세션 요약\n',
    bodies: { masking: '다음 할 일\n', 'flow-inbound': '- 하나\n- 둘' },
    ...over,
  };
}

// ── format, parse, markers ───────────────────────────────────────────────────

suite('session entries: format, parse and body markers');

test('format then parse returns the same fields; title and updated are derived', () => {
  const obj = sample();
  const text = formatSessionEntry(obj);
  assert.match(text, /^---\ntype: session-entry\ntitle: "session entry: p 2026-10-01"\n/);
  assert.match(text, /\nupdated: 2026-10-01\n/);
  const parsed = parseSessionEntry(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.entry, { ...obj, updated: '2026-10-01' });
});

test('a session id and a visibility scope are optional: no line is written for them', () => {
  const text = formatSessionEntry(sample({ sessionId: undefined, visibilityScope: null }));
  assert.ok(!/^session_id:/m.test(text));
  assert.ok(!/^visibility_scope:/m.test(text));
  const { entry } = parseSessionEntry(text);
  assert.equal(entry.sessionId, null);
  assert.equal(entry.visibilityScope, null);
});

test('text shaped like headings, fences and frontmatter survives format then parse byte for byte', () => {
  const tricky = [
    '## Summary',
    '## Track: x',
    '```',
    '## Track: masking',
    '```',
    '---',
    'machine_note: not frontmatter',
    '---',
    '',
    '',
  ].join('\n');
  const obj = sample({ summary: tricky, bodies: { masking: `\n${tricky}`, 'flow-inbound': '' } });
  const text = formatSessionEntry(obj);
  const parsed = parseSessionEntry(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.summary, tricky);
  assert.equal(parsed.entry.bodies.masking, `\n${tricky}`);
  assert.equal(parsed.entry.bodies['flow-inbound'], '');
  assert.equal(formatSessionEntry(parsed.entry), text);
});

test('a summary holding this close id summary marker line is refused', () => {
  const marker = entryMarker('summary', CID);
  assert.throws(
    () => formatSessionEntry(sample({ summary: `before\n${marker}\nafter` })),
    (err) => err.code === 'payload-reserved-marker',
  );
  assert.throws(() => assertNoEntryMarkers(`x\n${marker}`, CID), /reserved/);
});

test('a body holding this close id track marker line is refused, for any track id', () => {
  const marker = entryMarker('track', CID, 'masking');
  assert.throws(
    () => formatSessionEntry(sample({ bodies: { masking: `a\n${marker}\nb` } })),
    (err) => err.code === 'payload-reserved-marker',
  );
  assert.throws(
    () => assertNoEntryMarkers(`<!-- hypomnema:track Bad_ID ${CID} -->`, CID),
    /reserved/,
  );
  assert.throws(
    () => assertNoEntryMarkers(`<!-- hypomnema:track whatever ${CID} -->`, CID),
    /reserved/,
  );
});

test('other close ids, markers inside a sentence, and padded markers pass and round-trip', () => {
  const lines = [
    entryMarker('summary', OTHER_CID),
    entryMarker('track', OTHER_CID, 'masking'),
    `see <!-- hypomnema:summary ${CID} --> in the docs`,
    ` ${entryMarker('summary', CID)}`,
    `${entryMarker('summary', CID)} `,
    `${entryMarker('track', CID, 'masking')}x`,
    'a sentence about <!-- hypomnema: markers',
  ];
  for (const line of lines) assertNoEntryMarkers(line, CID);
  const obj = sample({ summary: lines.join('\n'), bodies: { masking: lines.join('\n') } });
  const text = formatSessionEntry(obj);
  const parsed = parseSessionEntry(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.summary, lines.join('\n'));
  assert.equal(parsed.entry.bodies.masking, lines.join('\n'));
  assert.equal(formatSessionEntry(parsed.entry), text);
});

test('the parser cuts only at the close id the frontmatter names', () => {
  const foreign = entryMarker('track', OTHER_CID, 'masking');
  const text = formatSessionEntry(sample({ summary: `x\n${foreign}\ny` }));
  const parsed = parseSessionEntry(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.summary, `x\n${foreign}\ny`);
  assert.deepEqual(Object.keys(parsed.entry.bodies).sort(), ['flow-inbound', 'masking']);
});

test('a track id twice in tracks: parse fails with duplicate-track-id, format throws', () => {
  const dup = [{ id: 'masking' }, { id: 'masking' }];
  assert.throws(
    () => formatSessionEntry(sample({ tracks: dup, bodies: {} })),
    (err) => err.code === 'duplicate-track-id',
  );
  const text = formatSessionEntry(sample()).replace(
    /^tracks: .*$/m,
    `tracks: ${JSON.stringify(dup)}`,
  );
  assert.deepEqual(parseSessionEntry(text), { ok: false, reason: 'duplicate-track-id' });
});

test('track ids must match TRACK_ID_RE: upper case, spaces, empty and 49 characters are refused', () => {
  assert.ok(TRACK_ID_RE.test('a'));
  assert.ok(TRACK_ID_RE.test('flow-inbound-2'));
  assert.ok(TRACK_ID_RE.test(`a${'b'.repeat(47)}`));
  for (const id of ['Masking', 'has space', '', '-lead', `a${'b'.repeat(48)}`]) {
    assert.ok(!TRACK_ID_RE.test(id), `[${id}]`);
    assert.throws(() => formatSessionEntry(sample({ tracks: [{ id }], bodies: {} })));
  }
  assert.equal(LEGACY_TRACK_ID, 'legacy');
});

test('parse reports a reason instead of throwing on files that are not entries', () => {
  const good = formatSessionEntry(sample());
  const reasons = [
    ['no frontmatter here', 'no-frontmatter'],
    [good.replace('type: session-entry', 'type: reference'), 'not-a-session-entry'],
    [good.replace('entry_schema: 1', 'entry_schema: 2'), 'unsupported-entry-schema'],
    [good.replace(/^date: .*\n/m, ''), 'missing-date'],
    [good.replace(/^tracks: .*$/m, 'tracks: [{'), 'bad-tracks'],
    [good.replace(/^tracks: .*$/m, 'tracks: [{"id":"x"}]'), 'unknown-track-body'],
    [good.replace(entryMarker('summary', CID), ''), 'missing-summary'],
  ];
  for (const [text, reason] of reasons) {
    assert.deepEqual(parseSessionEntry(text), { ok: false, reason }, reason);
  }
  assert.equal(parseSessionEntry(undefined).ok, false);
});

test('entryMarker, entryFileName and closeIdFor build the fixed shapes and refuse bad input', () => {
  assert.equal(entryMarker('summary', CID), `<!-- hypomnema:summary ${CID} -->`);
  assert.equal(entryMarker('track', CID, 'masking'), `<!-- hypomnema:track masking ${CID} -->`);
  assert.throws(() => entryMarker('track', CID));
  assert.throws(() => entryMarker('other', CID));
  assert.equal(entryFileName('2026-10-01', CID), `2026-10-01-${CID}.md`);
  assert.throws(() => entryFileName('2026-1-1', CID));
  assert.throws(() => entryFileName('2026-10-01', '../x'));
  assert.equal(closeIdFor('sess-1', 0), 'sess-1-0');
  assert.equal(closeIdFor('sess-1', 412), 'sess-1-412');
  assert.throws(() => closeIdFor('../x', 1));
  assert.throws(() => closeIdFor('sess-1', -1));
  assert.throws(() => closeIdFor('sess-1', 1.5));
});

test('resolveSupersedesPrefix picks the one id a prefix names and fails on none or several', () => {
  const ids = ['baseline-3f2a9c0d11e4b7a6', 'baseline-3f2b00000000aaaa', 'sess-1-4', 'sess-1-41'];
  // The first 8 characters of both baseline ids are the same ("baseline"), so the prefix must go further.
  assert.deepEqual(resolveSupersedesPrefix('baseline-3f2a', ids), {
    ok: true,
    id: 'baseline-3f2a9c0d11e4b7a6',
  });
  assert.deepEqual(resolveSupersedesPrefix('baseline', ids), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(resolveSupersedesPrefix('baseline-3f2', ids), {
    ok: false,
    reason: 'ambiguous',
  });
  assert.deepEqual(resolveSupersedesPrefix('zzz', ids), { ok: false, reason: 'unknown' });
  assert.deepEqual(resolveSupersedesPrefix('', ids), { ok: false, reason: 'unknown' });
  // An exact id wins even when it is also a prefix of another id.
  assert.deepEqual(resolveSupersedesPrefix('sess-1-4', ids), { ok: true, id: 'sess-1-4' });
  assert.deepEqual(resolveSupersedesPrefix('sess-1-41', ids), { ok: true, id: 'sess-1-41' });
});

// ── baseline entries ─────────────────────────────────────────────────────────

suite('session entries: baseline entry');

const OLD_HOT = [
  '---',
  'type: reference',
  'title: "hot: p"',
  'updated: 2026-09-30',
  'tags: [a, b]',
  'related: ["[[x]]"]',
  '---',
  '',
  '# Hot',
  '',
  '```',
  '## Track: legacy',
  '```',
  '',
].join('\n');

const OLD_STATE = [
  '---',
  'type: session-state',
  'title: "state: p"',
  'updated: 2026-09-30',
  'machine_note: next, finish the masking pipeline',
  '---',
  '',
  '## Next Up',
  '',
  'Body with a rule',
  '---',
  'and text after it.',
  '',
].join('\n');

function baseline(over = {}) {
  return buildBaselineEntry({
    hotText: OLD_HOT,
    stateText: OLD_STATE,
    date: '2026-09-30',
    visibilityScope: null,
    project: 'p',
    legacyDone: false,
    ...over,
  });
}

test('a baseline keeps both old files whole, frontmatter included', () => {
  const b = baseline();
  const parsed = parseSessionEntry(b.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.summary, OLD_HOT);
  assert.equal(parsed.entry.bodies[LEGACY_TRACK_ID], OLD_STATE);
  assert.equal(parsed.entry.closeId, b.closeId);
  assert.match(b.closeId, /^baseline-[0-9a-f]{16}$/);
  assert.equal(b.fileName, `2026-09-30-${b.closeId}.md`);
  assert.equal(parsed.entry.sessionId, null);
  assert.deepEqual(parsed.entry.tracks, [{ id: 'legacy', title: '이행 전 기록', new: true }]);
});

test('--- lines and frontmatter-shaped text inside a section do not leak into the entry frontmatter', () => {
  const b = baseline();
  const parsed = parseSessionEntry(b.text);
  assert.equal(parsed.entry.closeId, b.closeId);
  assert.equal(parsed.entry.tracks.length, 1);
  assert.equal(parsed.entry.project, 'p');
  assert.ok(!('machine_note' in parsed.entry));
});

test('splitLegacyFrontmatter separates the old frontmatter, machine_note included, from the body', () => {
  const { entry } = parseSessionEntry(baseline().text);
  const state = splitLegacyFrontmatter(entry.bodies[LEGACY_TRACK_ID]);
  assert.match(state.frontmatter, /^---\ntype: session-state\n/);
  assert.match(state.frontmatter, /machine_note: next, finish the masking pipeline\n---\n$/);
  assert.ok(state.body.startsWith('\n## Next Up'));
  assert.ok(state.body.includes('Body with a rule\n---\nand text after it.'));
  assert.equal(state.frontmatter + state.body, OLD_STATE);
  const hot = splitLegacyFrontmatter(entry.summary);
  assert.match(hot.frontmatter, /tags: \[a, b\]\nrelated: \["\[\[x\]\]"\]\n---\n$/);
  assert.equal(hot.frontmatter + hot.body, OLD_HOT);
});

test('splitLegacyFrontmatter returns frontmatter null when the first line is not ---', () => {
  for (const text of ['# Title\n---\nx\n---\n', '', ' ---\nx\n---\n', '---\nnever closed\n']) {
    assert.deepEqual(splitLegacyFrontmatter(text), { frontmatter: null, body: text });
  }
});

test('legacyDone marks the legacy update done, keeps the body, and changes the close id', () => {
  const open = baseline();
  const done = baseline({ legacyDone: true });
  const parsed = parseSessionEntry(done.text);
  assert.deepEqual(parsed.entry.tracks, [
    { id: 'legacy', title: '이행 전 기록', new: true, done: true },
  ]);
  assert.equal(parsed.entry.bodies[LEGACY_TRACK_ID], OLD_STATE);
  assert.equal(parsed.entry.summary, OLD_HOT);
  assert.notEqual(done.closeId, open.closeId);
});

test('two baselines that differ only in visibility scope get different close ids and paths', () => {
  const shared = baseline({ visibilityScope: null });
  const devA = baseline({ visibilityScope: 'machine:devA' });
  const devB = baseline({ visibilityScope: 'machine:devB' });
  assert.notEqual(shared.closeId, devA.closeId);
  assert.notEqual(devA.closeId, devB.closeId);
  assert.notEqual(devA.fileName, devB.fileName);
  assert.match(devA.text, /^visibility_scope: machine:devA$/m);
  assert.ok(!/^visibility_scope:/m.test(shared.text));
});

test('the same inputs give the same close id and bytes on any machine', () => {
  assert.deepEqual(baseline(), baseline());
  assert.notEqual(baseline().closeId, baseline({ stateText: `${OLD_STATE}x` }).closeId);
  assert.notEqual(baseline().closeId, baseline({ hotText: `${OLD_HOT}x` }).closeId);
  // Moving text between the two files must not collide with the original split.
  assert.notEqual(
    baseline({ hotText: 'ab', stateText: 'c' }).closeId,
    baseline({ hotText: 'a', stateText: 'bc' }).closeId,
  );
});

// ── path predicates and the byte-fixed blocks ────────────────────────────────

suite('session entries: path predicates agree with the .gitignore block');

function git(dir, args) {
  return spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, HOME: SESSION_TMP_HOME, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function withVault(files, fn) {
  withTmpDir((dir) => {
    assert.equal(git(dir, ['init', '-q']).status, 0);
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    fn(dir);
  });
}

const SAMPLE_PATHS = [
  'hot.md',
  'projects/p/hot.md',
  'projects/p/session-state.md',
  'projects/p/platform/session-state.md',
  'projects/p/platform/hot.md',
  'projects/_template/hot.md',
  'projects/p/sessions/2026-10-01-x.md',
  'pages/hot.md',
];

// `projects/_template/*` is ignored by the block (the migration untracks it) but is not a
// generated path: the one named exception.
const IGNORED_BUT_NOT_GENERATED = new Set(['projects/_template/hot.md']);

test('isGeneratedViewPath matches git check-ignore on the block, except _template by name', () => {
  withVault({ '.gitignore': GITIGNORE_BLOCK }, (dir) => {
    for (const rel of SAMPLE_PATHS) {
      const ignored = git(dir, ['check-ignore', '--no-index', '-q', rel]).status === 0;
      if (IGNORED_BUT_NOT_GENERATED.has(rel)) {
        assert.equal(ignored, true, `${rel} is ignored by the block`);
        assert.equal(isGeneratedViewPath(rel), false, `${rel} is not a generated path`);
      } else {
        assert.equal(isGeneratedViewPath(rel), ignored, rel);
      }
    }
  });
});

test('the generated paths are exactly the root hot and the two depth-1 project views', () => {
  assert.equal(isGeneratedViewPath('hot.md'), true);
  assert.equal(isGeneratedViewPath('projects/p/hot.md'), true);
  assert.equal(isGeneratedViewPath('projects/p/session-state.md'), true);
  for (const rel of [
    'projects/p/platform/session-state.md',
    'projects/_template/session-state.md',
    'projects/p/notes.md',
    'projects/hot.md',
    'projects/p/sessions/hot.md',
    'x/hot.md',
    'hot.md.pre-projection-backup.md',
  ]) {
    assert.equal(isGeneratedViewPath(rel), false, rel);
  }
});

test('isSessionEntryPath is depth-fixed and sessionViewPathsOf maps an entry to its two views', () => {
  assert.equal(isSessionEntryPath('projects/p/sessions/2026-10-01-x.md'), true);
  for (const rel of [
    'projects/p/sessions/sub/x.md',
    'projects/p/platform/sessions/x.md',
    'projects/p/sessions/x.tmp',
    'projects/p/hot.md',
    'sessions/x.md',
  ]) {
    assert.equal(isSessionEntryPath(rel), false, rel);
    assert.equal(sessionViewPathsOf(rel), null, rel);
  }
  assert.deepEqual(sessionViewPathsOf('projects/p/sessions/2026-10-01-x.md'), [
    'projects/p/hot.md',
    'projects/p/session-state.md',
  ]);
});

test('GITATTRIBUTES_BLOCK sets merge=union on a depth-1 session-log shard and nothing else', () => {
  withVault({ '.gitattributes': GITATTRIBUTES_BLOCK }, (dir) => {
    const attr = (rel) => git(dir, ['check-attr', 'merge', '--', rel]).stdout.trim();
    assert.equal(
      attr('projects/p/session-log/2026-10-01.md'),
      'projects/p/session-log/2026-10-01.md: merge: union',
    );
    for (const rel of [
      'projects/p/platform/session-log/2026-10-01.md',
      'projects/p/hot.md',
      'log.md',
      'projects/p/sessions/x.md',
    ]) {
      assert.equal(attr(rel), `${rel}: merge: unspecified`, rel);
    }
  });
});

test('both blocks end with a newline, so appending one after the other keeps lines apart', () => {
  assert.ok(GITIGNORE_BLOCK.endsWith('\n'));
  assert.ok(GITATTRIBUTES_BLOCK.endsWith('\n'));
  assert.match(
    GITIGNORE_BLOCK,
    /^# Hypomnema: session views generated from projects\/\*\/sessions\/ /,
  );
});

// ── scope narrowing and .gitignore merging ───────────────────────────────────

suite('session entries: scope narrowing and additive .gitignore merge');

test('narrowestVisibilityScope picks the machine value, flags two different machines, ignores blanks', () => {
  assert.deepEqual(narrowestVisibilityScope(['machine:devA', 'shared']), {
    scope: 'machine:devA',
    conflict: false,
  });
  assert.deepEqual(narrowestVisibilityScope(['shared', 'machine:devA']), {
    scope: 'machine:devA',
    conflict: false,
  });
  assert.deepEqual(narrowestVisibilityScope(['machine:devA', 'machine:devA']), {
    scope: 'machine:devA',
    conflict: false,
  });
  assert.deepEqual(narrowestVisibilityScope(['shared', null]), {
    scope: 'shared',
    conflict: false,
  });
  assert.deepEqual(narrowestVisibilityScope([null, '', 'agent:x', 'shared']), {
    scope: 'agent:x',
    conflict: false,
  });
  assert.deepEqual(narrowestVisibilityScope([]), { scope: null, conflict: false });
  assert.deepEqual(narrowestVisibilityScope([null, undefined]), { scope: null, conflict: false });
  assert.deepEqual(narrowestVisibilityScope(['machine:devA', 'machine:devB']), {
    scope: 'machine:',
    conflict: true,
  });
  assert.deepEqual(narrowestVisibilityScope(['machine:devA', 'shared', 'machine:devB']), {
    scope: 'machine:',
    conflict: true,
  });
});

const BASE = '.cache/\n*.tmp\n';

test('mergeAdditiveGitignore keeps theirs, then appends each line only ours added, once', () => {
  const ours = `${BASE}/ours-only\n/both\n`;
  const theirs = `${BASE}/theirs-only\n/both\n`;
  assert.deepEqual(mergeAdditiveGitignore(BASE, ours, theirs), {
    ok: true,
    merged: `${BASE}/theirs-only\n/both\n/ours-only\n`,
  });
  // Nothing new on ours: theirs comes back byte for byte.
  assert.deepEqual(mergeAdditiveGitignore(BASE, BASE, theirs), { ok: true, merged: theirs });
  // Theirs without a final newline still gets ours on its own line.
  assert.deepEqual(mergeAdditiveGitignore(BASE, `${BASE}/a\n`, `${BASE}/b`), {
    ok: true,
    merged: `${BASE}/b\n/a\n`,
  });
});

test('mergeAdditiveGitignore refuses a removed, reordered or replaced base line on either side', () => {
  assert.equal(mergeAdditiveGitignore(BASE, '*.tmp\n', `${BASE}/t\n`).ok, false);
  assert.equal(mergeAdditiveGitignore(BASE, `${BASE}/o\n`, '.cache/\n').ok, false);
  assert.equal(mergeAdditiveGitignore(BASE, '*.tmp\n.cache/\n', BASE).ok, false);
  assert.equal(mergeAdditiveGitignore(BASE, '.cache/\n*.log\n', BASE).ok, false);
});

test('mergeAdditiveGitignore refuses a negation added by theirs', () => {
  const r = mergeAdditiveGitignore(BASE, `${BASE}/o\n`, `${BASE}!keep.md\n`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'negation-added');
});

test('mergeAdditiveGitignore refuses a negation added by ours, even when theirs adds a plain pattern', () => {
  const r = mergeAdditiveGitignore(BASE, `${BASE}!keep.md\n`, `${BASE}*.md\n`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'negation-added');
});

test('the same input shape with plain patterns on both sides merges (the refusal targets only !)', () => {
  const r = mergeAdditiveGitignore(BASE, `${BASE}keep.md\n`, `${BASE}*.md\n`);
  assert.deepEqual(r, { ok: true, merged: `${BASE}*.md\nkeep.md\n` });
  // A line that merely contains ! is not a negation.
  assert.equal(mergeAdditiveGitignore(BASE, `${BASE}a!b\n`, `${BASE}\\!c\n`).ok, true);
});

// ── heads, order, projection ─────────────────────────────────────────────────

// A parsed entry (what parseSessionEntry returns) without the file round trip.
function E(closeId, over = {}) {
  const date = over.date ?? '2026-10-01';
  return {
    project: 'p',
    closeId,
    sessionId: null,
    date,
    updated: date,
    visibilityScope: null,
    tracks: [{ id: 'masking', title: 'Masking' }],
    summary: `summary of ${closeId}`,
    bodies: { masking: `body of ${closeId}` },
    ...over,
  };
}

function M(entries, over = {}) {
  return {
    project: 'p',
    migrated: true,
    entries,
    unreadable: [],
    notes: null,
    entryScope: null,
    ...over,
  };
}

const ids = (list) => list.map((e) => e.closeId);
const reversed = (list) => [...list].reverse();
const rotated = (list) => [...list.slice(2), ...list.slice(0, 2)];

suite('session entries: order and track heads');

test('sortEntries is newest first; a same-day replacement goes before what it replaced', () => {
  // a1 < b1 by close id, so only the supersede depth can put b1 first.
  const a1 = E('a1');
  const b1 = E('b1', { tracks: [{ id: 'masking', supersedes: ['a1'] }] });
  const old = E('z0', { date: '2026-09-30' });
  assert.deepEqual(ids(sortEntries([a1, old, b1])), ['b1', 'a1', 'z0']);
});

test('same day and same depth are ordered by close id, whatever the input order', () => {
  const list = [E('c1'), E('b2'), E('a3'), E('d4')];
  const want = ['a3', 'b2', 'c1', 'd4'];
  for (const input of [list, reversed(list), rotated(list)]) {
    assert.deepEqual(ids(sortEntries(input)), want);
  }
});

test('close ids are compared by code unit, not by locale', () => {
  assert.deepEqual(ids(sortEntries([E('a'), E('B'), E('_x')])), ['B', '_x', 'a']);
});

test('a superseded update is not a head; one nobody supersedes is', () => {
  const first = E('c1');
  const second = E('c2', { tracks: [{ id: 'masking', supersedes: ['c1'] }] });
  const [track] = trackHeads([first, second]);
  assert.deepEqual(
    track.heads.map((h) => h.closeId),
    ['c2'],
  );
});

test('two unrelated updates of one track are both heads and both rendered', () => {
  const model = M([E('c1'), E('c2')]);
  const [track] = trackHeads(model.entries);
  assert.deepEqual(
    track.heads.map((h) => h.closeId),
    ['c1', 'c2'],
  );
  const state = renderViews([model]).projects.p.sessionState;
  assert.ok(state.includes('body of c1') && state.includes('body of c2'));
});

test('a supersedes naming an id no entry has is ignored', () => {
  const only = E('c1', { tracks: [{ id: 'masking', supersedes: ['gone-9'] }] });
  assert.deepEqual(
    trackHeads([only])[0].heads.map((h) => h.closeId),
    ['c1'],
  );
  // Naming an entry that has no update of THIS track does not replace anything either.
  const other = E('c0', { tracks: [{ id: 'flow' }], bodies: {} });
  const naming = E('c2', { tracks: [{ id: 'masking', supersedes: ['c0'] }] });
  assert.equal(trackHeads([other, naming]).length, 2);
});

test('a track whose heads are all done is finished: one line, no Next Up item', () => {
  const open = E('c1');
  const closing = E('c2', {
    tracks: [{ id: 'masking', done: true, supersedes: ['c1'] }],
    bodies: {},
  });
  const model = M([open, closing]);
  assert.equal(trackHeads(model.entries)[0].done, true);
  assert.deepEqual(nextUpItems(model), []);
  const state = renderViews([model]).projects.p.sessionState;
  assert.match(state, /## Finished tracks\n\n- Masking \(masking\) · 2026-10-01\n/);
  assert.ok(!state.includes('body of c1'));
});

test('a done update does not finish a track that still has another head', () => {
  const closing = E('c2', { tracks: [{ id: 'masking', done: true }], bodies: {} });
  const model = M([E('c1'), closing]);
  assert.equal(trackHeads(model.entries)[0].done, false);
  assert.deepEqual(ids(nextUpItems(model)), ['c1']);
});

test('the track title is the newest title any update carries', () => {
  const a = E('c1', { date: '2026-09-01', tracks: [{ id: 'masking', title: 'Old name' }] });
  const b = E('c2', { tracks: [{ id: 'masking', supersedes: ['c1'] }] });
  assert.equal(trackHeads([a, b])[0].title, 'Old name');
  const c = E('c3', {
    date: '2026-10-02',
    tracks: [{ id: 'masking', title: 'New name', supersedes: ['c2'] }],
  });
  assert.equal(trackHeads([a, b, c])[0].title, 'New name');
});

test('an entry the machine cannot see is absent: it cannot replace a visible head', () => {
  const visible = E('c1');
  const hidden = E('c2', {
    visibilityScope: 'machine:devB',
    tracks: [{ id: 'masking', supersedes: ['c1'] }],
  });
  const model = M([visible, hidden]);
  assert.deepEqual(ids(nextUpItems(model, { device: 'devA' })), ['c1']);
  assert.deepEqual(ids(nextUpItems(model, { device: 'devB' })), ['c2']);
});

// The expected answers are written out: a scope on a device is visible unless it is a
// `machine:` value naming another device (or nobody).
const SCOPE_EXPECTED = {
  null: { devA: true, devB: true, devC: true },
  '': { devA: true, devB: true, devC: true },
  shared: { devA: true, devB: true, devC: true },
  'machine:devA': { devA: true, devB: false, devC: false },
  'machine:devB': { devA: false, devB: true, devC: false },
  'machine:': { devA: false, devB: false, devC: false },
  'agent:x': { devA: true, devB: true, devC: true },
  odd: { devA: true, devB: true, devC: true },
};

test('hypo-shared re-exports the one scopeVisible, and the machine filter answers like it', () => {
  assert.equal(sharedScopeVisible, scopeVisible, 'one definition, not a copy');
  for (const [key, byDevice] of Object.entries(SCOPE_EXPECTED)) {
    const scope = key === 'null' ? null : key;
    for (const [device, visible] of Object.entries(byDevice)) {
      assert.equal(scopeVisible(scope, device), visible, `${key} on ${device}`);
      const items = nextUpItems(M([E('c1', { visibilityScope: scope })]), { device });
      assert.equal(items.length === 1, visible, `filter: ${key} on ${device}`);
    }
  }
});

test('entryScope, when set, replaces every entry scope', () => {
  const entries = [E('c1', { visibilityScope: 'machine:devB' }), E('c2')];
  const open = M(entries, { entryScope: 'shared' });
  assert.deepEqual(ids(nextUpItems(open, { device: 'devA' })), ['c1', 'c2']);
  const closed = M(entries, { entryScope: 'machine:devB' });
  assert.deepEqual(nextUpItems(closed, { device: 'devA' }), []);
});

test('isSessionProjectDir wants index.md or sessions/ and refuses _template', () => {
  assert.equal(isSessionProjectDir({ slug: 'p', hasIndex: true, hasSessions: false }), true);
  assert.equal(isSessionProjectDir({ slug: 'p', hasIndex: false, hasSessions: true }), true);
  assert.equal(isSessionProjectDir({ slug: 'p', hasIndex: false, hasSessions: false }), false);
  assert.equal(
    isSessionProjectDir({ slug: '_template', hasIndex: true, hasSessions: true }),
    false,
  );
});

test('sortRootRows: date descending, blank last, slugs by code unit', () => {
  const rows = [
    { slug: 'a', date: '2026-10-01' },
    { slug: 'B', date: '2026-10-01' },
    { slug: '_x', date: '2026-10-01' },
    { slug: 'z', date: '' },
    { slug: 'm', date: '2026-10-02' },
  ];
  const want = ['m', 'B', '_x', 'a', 'z'];
  assert.deepEqual(
    sortRootRows(rows).map((r) => r.slug),
    want,
  );
  assert.deepEqual(
    sortRootRows(reversed(rows)).map((r) => r.slug),
    want,
  );
});

suite('session entries: generated views');

test('the views are the same bytes for any input order', () => {
  const list = [
    E('c1'),
    E('b2'),
    E('a3', { tracks: [{ id: 'flow', title: 'Flow' }], bodies: { flow: 'flow body' } }),
    E('d4', { date: '2026-09-29' }),
    E('e5', { tracks: [{ id: 'masking', supersedes: ['d4'] }] }),
  ];
  const want = renderViews([M(list)]);
  for (const input of [reversed(list), rotated(list)]) {
    assert.deepEqual(renderViews([M(input)]), want);
  }
});

test('unreadable entries render by file name whatever the input order, and are never dropped', () => {
  const a = { fileName: 'a.md', reason: 'bad-tracks' };
  const b = { fileName: 'b.md', reason: 'missing-summary' };
  const one = renderViews([M([E('c1')], { unreadable: [b, a] })]).projects.p.sessionState;
  const two = renderViews([M([E('c1')], { unreadable: [a, b] })]).projects.p.sessionState;
  assert.equal(one, two);
  assert.match(one, /## Unreadable entries\n\n- `a\.md`: bad-tracks\n- `b\.md`: missing-summary\n/);
});

test('hot.md spreads the newest 5 summaries, links the next 20, and renders nothing older', () => {
  const entries = [];
  for (let n = 1; n <= 30; n++) {
    const nn = String(n).padStart(2, '0');
    entries.push(E(`c${nn}`, { date: `2026-09-${nn}`, summary: `SUM-${nn}` }));
  }
  const hot = renderViews([M(entries)]).projects.p.hot;
  for (let n = 26; n <= 30; n++) assert.ok(hot.includes(`SUM-${n}`), `summary ${n}`);
  for (let n = 1; n <= 25; n++) assert.ok(!hot.includes(`SUM-${String(n).padStart(2, '0')}`));
  for (let n = 6; n <= 25; n++) {
    const nn = String(n).padStart(2, '0');
    assert.ok(hot.includes(`[[projects/p/sessions/2026-09-${nn}-c${nn}]]`), `link ${n}`);
  }
  for (let n = 1; n <= 5; n++) {
    const nn = String(n).padStart(2, '0');
    assert.ok(!hot.includes(`c${nn}`), `entry ${n} is not rendered`);
  }
  assert.match(hot, /그 밖 5개는 `projects\/p\/sessions\/`/);
  assert.match(
    hot,
    /^---\ntype: reference\ntitle: "hot: p"\nupdated: 2026-09-30\ngenerated: sessions\n---\n/,
  );
  assert.ok(hot.includes('[[projects/p/notes]]'));
});

test('the generator never reads the date: two mocked days give the same bytes, updated is the newest entry', () => {
  const RealDate = globalThis.Date;
  const render = (iso) => {
    const fixed = new RealDate(iso).getTime();
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixed]));
      }
      static now() {
        return fixed;
      }
    };
    try {
      return renderViews([M([E('c1', { date: '2026-10-01' }), E('c2', { date: '2026-09-20' })])]);
    } finally {
      globalThis.Date = RealDate;
    }
  };
  const first = render('2030-01-01T00:00:00Z');
  const second = render('2041-06-15T00:00:00Z');
  assert.deepEqual(first, second);
  assert.match(first.projects.p.hot, /\nupdated: 2026-10-01\n/);
  assert.match(first.projects.p.sessionState, /\nupdated: 2026-10-01\n/);
  assert.match(first.root, /\nupdated: 2026-10-01\n/);
});

test('the root table is what formatRootHotProjection writes for the rows, and resolveActiveProject reads it', () => {
  const models = [
    M([E('c1', { date: '2026-10-01' })], { project: 'p' }),
    M([E('c2', { date: '2026-10-03' })], { project: 'q' }),
    M([], { project: 'r' }),
  ];
  const { root } = renderViews(models);
  const rows = sortRootRows([
    { slug: 'p', date: '2026-10-01' },
    { slug: 'q', date: '2026-10-03' },
    { slug: 'r', date: '' },
  ]);
  const tableOf = (text) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('| '))
      .join('\n');
  assert.equal(tableOf(root), tableOf(formatRootHotProjection(rows)));
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hot.md'), root);
    assert.equal(resolveActiveProject(dir), 'q');
  });
});

test('only limits the per-project files; the root still has a row for every project', () => {
  const models = [M([E('c1')], { project: 'p' }), M([E('c2')], { project: 'q' })];
  const out = renderViews(models, { only: ['p'] });
  assert.deepEqual(Object.keys(out.projects), ['p']);
  assert.ok(out.root.includes('[[projects/q/hot]]'));
});

test('a baseline head: nextUpItems keeps the whole body and splits the old frontmatter off', () => {
  const state = `${OLD_STATE}\n## Notes\n\nlast line of the old file\n`;
  const b = baseline({ stateText: state });
  const model = M([parseSessionEntry(b.text).entry]);
  const [item] = nextUpItems(model);
  const split = splitLegacyFrontmatter(state);
  assert.equal(item.body, split.body);
  assert.ok(item.body.includes('## Notes') && item.body.includes('last line of the old file'));
  assert.equal(item.legacyFrontmatter, split.frontmatter);
  assert.ok(item.legacyFrontmatter.includes('machine_note: next, finish the masking pipeline'));
});

test('a baseline head folds the old frontmatter into <details> and the body starts without it', () => {
  const model = M([parseSessionEntry(baseline().text).entry]);
  const { sessionState, hot } = renderViews([model]).projects.p;
  assert.match(sessionState, /<details><summary>[^<]+<\/summary>\n\n```yaml\n---\n/);
  assert.ok(sessionState.includes('machine_note: next, finish the masking pipeline'));
  const afterFold = sessionState.split('</details>\n\n')[1];
  assert.ok(!afterFold.startsWith('---') && !afterFold.includes('machine_note'));
  // The baseline summary is the old hot.md whole: its tags and related fold the same way.
  assert.match(hot, /<details>[\s\S]*tags: \[a, b\][\s\S]*<\/details>/);
});

test('a track and a summary with a fence in their text still render the old frontmatter safely', () => {
  const state = '---\nnote: |\n  ```\n---\nbody\n';
  const b = baseline({ stateText: state });
  const out = renderViews([M([parseSessionEntry(b.text).entry])]).projects.p.sessionState;
  assert.ok(out.includes('````yaml'), 'the fence is longer than any backtick run inside');
});

test('generated text holds no em dash or en dash', () => {
  const model = M([
    E('c1'),
    E('c2', { tracks: [{ id: 'flow', title: 'Flow', done: true }], bodies: {} }),
    parseSessionEntry(baseline().text).entry,
  ]);
  const out = renderViews([model]);
  const injected = buildInjection(model, 4000).text;
  for (const text of [out.root, out.projects.p.hot, out.projects.p.sessionState, injected]) {
    assert.ok(!/[\u2013\u2014]/.test(text));
  }
});

// ── injection ────────────────────────────────────────────────────────────────

suite('session entries: injection budget');

const pointerLines = (text) =>
  text.split('\n').filter((l) => l.startsWith('- ') && l.includes('이 머리를 읽으세요'));
const lineWith = (text, closeId) => text.split('\n').find((l) => l.includes(closeId));

test('a head that fits goes in whole and is in observed.heads only', () => {
  const model = M([E('c1')]);
  const { text, observed } = buildInjection(model, 4000);
  assert.ok(text.includes('body of c1'));
  assert.deepEqual(observed, { project: 'p', heads: { masking: ['c1'] }, pointer: {} });
});

test('a head over budget is a pointer line with the whole close id and the replace notice', () => {
  const big = E('c1', { bodies: { masking: 'X'.repeat(9000) } });
  const second = E('c2', {
    tracks: [{ id: 'flow', title: 'Flow' }],
    bodies: { flow: 'F'.repeat(9000) },
  });
  const { text, observed } = buildInjection(M([big, second]), 4000);
  const line = lineWith(text, 'c2');
  assert.ok(line.includes('닫을 때 이 머리를 대체합니다') && line.includes('c2'));
  assert.ok(!text.includes('F'.repeat(40)), 'the second head is not cut, it is a pointer');
  assert.deepEqual(observed.pointer.flow, ['c2']);
  assert.equal(observed.heads.flow, undefined);
});

test('an item goes in whole or not at all: a summary that does not fit leaves no trace', () => {
  const entries = [
    E('c1', { bodies: { masking: 'small' }, summary: 'S'.repeat(5000) }),
    E('c2', { date: '2026-09-01', bodies: { masking: 'x' }, summary: 'shorter summary' }),
  ];
  const { text } = buildInjection(M(entries), 4000);
  assert.ok(!text.includes('SSSS'));
  assert.ok(text.includes('body of c2') || text.includes('shorter summary'));
  const roomy = buildInjection(M(entries), 20000).text;
  assert.ok(roomy.includes('S'.repeat(5000)));
});

test('the priority is heads, newest summary, notes, then the other summaries', () => {
  const entries = [
    E('c1', { summary: 'NEWEST-SUMMARY' }),
    E('c2', { date: '2026-09-01', summary: 'OLDER-SUMMARY' }),
  ];
  const model = M(entries, { notes: 'THE-NOTES' });
  const full = buildInjection(model, 4000).text;
  assert.ok(full.indexOf('NEWEST-SUMMARY') < full.indexOf('THE-NOTES'));
  assert.ok(full.indexOf('THE-NOTES') < full.indexOf('OLDER-SUMMARY'));
  // Squeezed so that only the heads, the newest summary and the notes fit: the older one drops first.
  const tight = buildInjection(model, full.length - 10).text;
  assert.ok(tight.includes('THE-NOTES') && tight.includes('NEWEST-SUMMARY'));
  assert.ok(!tight.includes('OLDER-SUMMARY'));
});

test('the first head over budget is cut to the rest and still tells every other head', () => {
  const first = E('c1', { bodies: { masking: 'A'.repeat(6000) } });
  // Longer than its own pointer line, so it cannot squeeze in if the pointer line were not reserved.
  const second = E('c2', {
    tracks: [{ id: 'flow', title: 'Flow' }],
    bodies: { flow: 'F'.repeat(400) },
  });
  const { text, observed } = buildInjection(M([first, second]), 4000);
  assert.ok(text.includes('c1') && text.includes('c2'));
  assert.match(text, /\(잘림: 전문은 projects\/p\/session-state\.md\)/);
  assert.ok(text.length <= 4000);
  assert.deepEqual(observed.pointer.masking, ['c1']);
  assert.equal(observed.heads.masking, undefined);
  assert.deepEqual(observed.pointer.flow, ['c2']);
  assert.equal(observed.heads.flow, undefined);
});

test('21 active heads: 20 pointer lines and "외 1개" even with no room, the 21st in neither key', () => {
  const tracks = [];
  for (let n = 1; n <= 21; n++)
    tracks.push({ id: `t${String(n).padStart(2, '0')}`, title: `T${n}` });
  const { text, observed } = buildInjection(M([E('c1', { tracks, bodies: {} })]), 1);
  assert.equal(pointerLines(text).length, 20);
  assert.ok(text.includes('- 외 1개'));
  assert.equal(Object.keys(observed.pointer).length, 20);
  assert.deepEqual(observed.heads, {});
  assert.equal(observed.pointer.t21, undefined);
  assert.equal(observed.pointer.t20.length, 1);
});

test('the pointer target follows migration: entry file before, session-state.md after, baseline always session-state.md', () => {
  const real = E('c1', { date: '2026-10-02', bodies: { masking: 'R'.repeat(9000) } });
  const base = parseSessionEntry(baseline().text).entry;
  const target = (migrated) => {
    const { text } = buildInjection(M([real, base], { migrated }), 800);
    return { real: lineWith(text, 'c1'), base: lineWith(text, base.closeId), text };
  };
  const before = target(false);
  assert.ok(before.base.includes('projects/p/session-state.md'));
  assert.ok(before.text.includes(`(잘림: 전문은 projects/p/sessions/2026-10-02-c1.md)`));
  const after = target(true);
  assert.ok(after.base.includes('projects/p/session-state.md'));
  assert.ok(after.text.includes('(잘림: 전문은 projects/p/session-state.md)'));
  // Before migration a head that is only a pointer names its entry file too.
  const pointerOnly = buildInjection(M([real], { migrated: false }), 1).text;
  assert.ok(lineWith(pointerOnly, 'c1').includes('projects/p/sessions/2026-10-02-c1.md'));
  const migratedPointer = buildInjection(M([real], { migrated: true }), 1).text;
  assert.ok(lineWith(migratedPointer, 'c1').includes('projects/p/session-state.md'));
});

test('a baseline head carries its old frontmatter into the injection, and the nextUp body does not', () => {
  const model = M([parseSessionEntry(baseline().text).entry]);
  const { text } = buildInjection(model, 4000);
  assert.ok(text.includes('machine_note: next, finish the masking pipeline'));
  assert.match(text, /```yaml\n---\n/);
  assert.ok(!nextUpItems(model)[0].body.includes('machine_note'));
});

test('no active head and no summary: empty text and empty observed', () => {
  assert.deepEqual(buildInjection(M([]), 4000), {
    text: '',
    observed: { project: 'p', heads: {}, pointer: {} },
  });
});

// ── session-views: IO fixtures ───────────────────────────────────────────────

const sha = (text) => createHash('sha256').update(text, 'utf-8').digest('hex');

function put(dir, rel, text) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const readRel = (dir, rel) => readFileSync(join(dir, rel), 'utf-8');

function commitAll(dir) {
  assert.equal(git(dir, ['add', '-A']).status, 0);
  const r = git(dir, [
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '-m',
    'x',
  ]);
  assert.equal(r.status, 0, r.stderr);
}

// A plain entry file: one track, no supersedes, no scope.
function entryFile(closeId, over = {}) {
  return formatSessionEntry(
    sample({
      closeId,
      sessionId: null,
      visibilityScope: null,
      tracks: [{ id: 'masking', title: 'Masking' }],
      bodies: { masking: `next for ${closeId}\n` },
      summary: `summary ${closeId}\n`,
      ...over,
    }),
  );
}

const putEntry = (dir, project, closeId, over = {}) =>
  put(
    dir,
    `projects/${project}/sessions/${entryFileName(over.date ?? '2026-10-01', closeId)}`,
    entryFile(closeId, { project, ...over }),
  );

const OLD_HOT_FILE = `---
title: "hot: p"
type: reference
updated: 2026-09-20
visibility_scope: machine:devA
---
old hot body
`;
const OLD_STATE_FILE = `---
type: session-state
updated: 2026-09-25
machine_note: keep me
---
## Next Up
old state body
`;

// A git vault that has not moved to the scheme: the old two files are tracked, no block.
function withOldVault(fn, files = {}) {
  withVault({}, (dir) => {
    put(dir, 'projects/p/index.md', '---\ntitle: p\n---\n');
    put(dir, 'projects/p/hot.md', OLD_HOT_FILE);
    put(dir, 'projects/p/session-state.md', OLD_STATE_FILE);
    for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
    commitAll(dir);
    fn(dir);
  });
}

// A git vault that has moved: the block is in HEAD and no view is tracked.
function withMigratedVault(fn, files = {}) {
  withVault({}, (dir) => {
    put(dir, '.gitignore', GITIGNORE_BLOCK);
    put(dir, 'projects/p/index.md', '---\ntitle: p\n---\n');
    for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
    commitAll(dir);
    fn(dir);
  });
}

// ── project list, entry list, model ──────────────────────────────────────────

suite('session views: projects, entries and the model');

test('listSessionProjects leaves out _template and empty directories and keeps sessions-only projects', () => {
  withTmpDir((dir) => {
    put(dir, 'projects/_template/index.md', 'x');
    put(dir, 'projects/idx/index.md', 'x');
    mkdirSync(join(dir, 'projects/only-sessions/sessions'), { recursive: true });
    mkdirSync(join(dir, 'projects/empty'), { recursive: true });
    put(dir, 'projects/stray.md', 'x');
    assert.deepEqual(listSessionProjects(dir), ['idx', 'only-sessions']);
    assert.deepEqual(listSessionProjects(join(dir, 'nowhere')), []);
  });
});

test('listSessionEntries skips a file deleted between the listing and the read, and reports the rest', () => {
  withTmpDir((dir) => {
    putEntry(dir, 'p', 'keep');
    putEntry(dir, 'p', 'gone');
    put(dir, 'projects/p/sessions/2026-10-01-broken.md', 'no frontmatter at all\n');
    mkdirSync(join(dir, 'projects/p/sessions/2026-10-01-dir.md'));
    put(dir, 'projects/p/sessions/2026-10-01-temp.md.123.tmp', 'partial');
    const { entries, unreadable } = listSessionEntries(dir, 'p', {
      testHooks: {
        betweenListAndRead: () =>
          unlinkSync(join(dir, 'projects/p/sessions', entryFileName('2026-10-01', 'gone'))),
      },
    });
    assert.deepEqual(
      entries.map((e) => e.closeId),
      ['keep'],
    );
    assert.deepEqual(
      unreadable.map((u) => u.fileName),
      ['2026-10-01-broken.md', '2026-10-01-dir.md'],
    );
    assert.match(unreadable[1].reason, /^read-error: EISDIR$/);
  });
});

test('loadSessionModel on a vault without git reads entries, notes body and entry_scope', () => {
  withTmpDir((dir) => {
    putEntry(dir, 'p', 'c1');
    put(dir, 'projects/p/index.md', '---\ntitle: p\nentry_scope: shared # widened\n---\n');
    put(dir, 'projects/p/notes.md', '---\ntitle: notes\n---\n\nthe notes\n');
    const model = loadSessionModel(dir, 'p');
    assert.equal(model.migrated, true);
    assert.equal(model.project, 'p');
    assert.deepEqual(
      model.entries.map((e) => e.closeId),
      ['c1'],
    );
    assert.deepEqual(model.unreadable, []);
    assert.equal(model.notes, 'the notes');
    assert.equal(model.entryScope, 'shared');
    const bare = loadSessionModel(dir, 'nobody');
    assert.deepEqual([bare.entries, bare.notes, bare.entryScope], [[], null, null]);
  });
});

test('an entry_scope that is not a scope closes the project instead of being ignored', () => {
  withTmpDir((dir) => {
    for (const [raw, expected] of [
      ['machine:devA', 'machine:devA'],
      ['agent:x', 'agent:x'],
      ['everyone', 'machine:'],
      ['', 'machine:'],
      ['machine:dev A', 'machine:'],
    ]) {
      put(dir, 'projects/p/index.md', `---\nentry_scope: ${raw}\n---\n`);
      assert.equal(loadSessionModel(dir, 'p').entryScope, expected, `[${raw}]`);
    }
  });
});

test('before the move the model holds a virtual baseline of the old files and nothing on disk changes', () => {
  withOldVault((dir) => {
    putEntry(dir, 'p', 'c1');
    const model = loadSessionModel(dir, 'p');
    assert.equal(model.migrated, false);
    const base = model.entries.find((e) => isBaselineId(e.closeId));
    assert.ok(base, 'a virtual baseline entry');
    assert.equal(base.summary, OLD_HOT_FILE);
    assert.equal(base.bodies[LEGACY_TRACK_ID], OLD_STATE_FILE);
    assert.equal(base.date, '2026-09-25');
    assert.equal(base.visibilityScope, 'machine:devA');
    assert.deepEqual(
      model.entries.map((e) => e.closeId).filter((id) => !isBaselineId(id)),
      ['c1'],
    );
    assert.equal(readRel(dir, 'projects/p/hot.md'), OLD_HOT_FILE);
    assert.equal(readRel(dir, 'projects/p/session-state.md'), OLD_STATE_FILE);
    assert.equal(git(dir, ['status', '--porcelain', '--untracked-files=no']).stdout, '');
  });
});

test('a migrated vault has no virtual baseline even when old view files linger on disk', () => {
  withMigratedVault(
    (dir) => {
      put(dir, 'projects/p/hot.md', OLD_HOT_FILE);
      const model = loadSessionModel(dir, 'p');
      assert.equal(model.migrated, true);
      assert.deepEqual(
        model.entries.map((e) => e.closeId),
        ['c1'],
      );
    },
    { [`projects/p/sessions/${entryFileName('2026-10-01', 'c1')}`]: entryFile('c1') },
  );
});

test('projectEntryScope: the narrowest of index.md and the baselines, or the entry_scope as written', () => {
  withOldVault((dir) => {
    put(dir, 'projects/p/index.md', '---\nvisibility_scope: shared\n---\n');
    assert.equal(projectEntryScope(dir, 'p', loadSessionModel(dir, 'p')), 'machine:devA');
    assert.equal(projectEntryScope(dir, 'p'), 'machine:devA', 'model is optional');
    put(dir, 'projects/p/index.md', '---\nvisibility_scope: shared\nentry_scope: shared\n---\n');
    assert.equal(projectEntryScope(dir, 'p'), 'shared', 'entry_scope skips the calculation');
  });
  withTmpDir((dir) => {
    put(dir, 'projects/p/index.md', '---\nvisibility_scope: shared\n---\n');
    putEntry(dir, 'p', 'c1', { visibilityScope: 'machine:devB' });
    assert.equal(
      projectEntryScope(dir, 'p'),
      'shared',
      'no baseline: a non-baseline entry scope does not narrow',
    );
    put(dir, 'projects/q/index.md', '---\ntitle: q\n---\n');
    assert.equal(projectEntryScope(dir, 'q'), null);
  });
});

// ── git state ────────────────────────────────────────────────────────────────

suite('session views: tracked views and migration state');

test('listTrackedGeneratedViews holds the root and depth-1 views only, never by pathspec', () => {
  withVault({}, (dir) => {
    for (const rel of [
      'hot.md',
      'projects/p/hot.md',
      'projects/p/session-state.md',
      'projects/p/platform/session-state.md',
      'projects/p/platform/hot.md',
      'projects/_template/hot.md',
      'projects/p/notes.md',
    ]) {
      put(dir, rel, 'x\n');
    }
    commitAll(dir);
    const expected = ['hot.md', 'projects/p/hot.md', 'projects/p/session-state.md'];
    assert.deepEqual(listTrackedGeneratedViews(dir, { source: 'head' }), expected);
    assert.deepEqual(listTrackedGeneratedViews(dir), expected);
    assert.throws(() => listTrackedGeneratedViews(dir, { source: 'worktree' }));
  });
});

test('migrationState reads HEAD alone: block plus no tracked view is migrated', () => {
  withTmpDir((dir) => assert.equal(migrationState(dir), 'migrated', 'not a git repository'));
  withVault({}, (dir) => {
    assert.equal(migrationState(dir), 'not-migrated', 'a repository with no commit');
  });
  withOldVault((dir) => {
    assert.equal(migrationState(dir), 'not-migrated');
    // The block in the working tree alone does not count.
    put(dir, '.gitignore', GITIGNORE_BLOCK);
    assert.equal(migrationState(dir), 'not-migrated');
    commitAll(dir);
    assert.equal(
      migrationState(dir),
      'not-migrated',
      'block committed but the views still tracked',
    );
    assert.equal(
      git(dir, ['rm', '-q', '--cached', 'projects/p/hot.md', 'projects/p/session-state.md']).status,
      0,
    );
    // The untracking is only staged: HEAD still tracks the views.
    assert.equal(migrationState(dir), 'not-migrated');
    commitAll(dir);
    assert.equal(migrationState(dir), 'migrated');
  });
});

test('HEAD migrated while the real index still holds a view: migrated', () => {
  withOldVault((dir) => {
    put(dir, '.gitignore', GITIGNORE_BLOCK);
    assert.equal(
      git(dir, ['rm', '-q', '--cached', 'projects/p/hot.md', 'projects/p/session-state.md']).status,
      0,
    );
    commitAll(dir);
    assert.equal(git(dir, ['add', '-f', 'projects/p/hot.md']).status, 0);
    assert.deepEqual(listTrackedGeneratedViews(dir), ['projects/p/hot.md']);
    assert.deepEqual(listTrackedGeneratedViews(dir, { source: 'head' }), []);
    assert.equal(migrationState(dir), 'migrated');
  });
});

test('an off marker in HEAD is opted-out, and only HEAD counts', () => {
  withMigratedVault((dir) => {
    put(dir, SESSION_ENTRIES_OFF_MARKER, '');
    assert.equal(migrationState(dir), 'migrated', 'untracked marker is not HEAD');
    commitAll(dir);
    assert.equal(migrationState(dir), 'opted-out');
  });
});

// ── writing the views ────────────────────────────────────────────────────────

suite('session views: the writer');

const VIEW = 'projects/p/hot.md';
const WRITE = { device: 'devA' };

function seedProjects(dir, slugs = ['p']) {
  for (const slug of slugs) {
    put(dir, `projects/${slug}/index.md`, '---\ntitle: x\n---\n');
    putEntry(dir, slug, `c-${slug}`);
  }
}

test('the first write creates the project views and the root, the second changes nothing and keeps mtimes', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    const first = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(first.written.sort(), ['hot.md', VIEW, 'projects/p/session-state.md'].sort());
    assert.deepEqual(first.backedUp, []);
    assert.match(readRel(dir, VIEW), /^---\ntype: reference\ntitle: "hot: p"/);
    assert.match(readRel(dir, 'projects/p/session-state.md'), /next for c-p/);
    for (const rel of first.written) utimesSync(join(dir, rel), 1000, 1000);
    const second = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(second.written, []);
    assert.equal(second.unchanged.length, 3);
    for (const rel of first.written) assert.equal(statSync(join(dir, rel)).mtimeMs, 1000000, rel);
  });
});

test('bytes the writer did not write are backed up before they are replaced, and a notice is left', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    put(dir, VIEW, 'hand written\n');
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.backedUp.length, 1);
    assert.equal(r.backedUp[0].relPath, VIEW);
    assert.equal(readRel(dir, `${VIEW}.pre-projection-backup.md`), 'hand written\n');
    assert.match(readRel(dir, VIEW), /generated: sessions/);
    const notice = consumeRootHotHealthNotice(dir);
    assert.ok(notice?.includes(VIEW) && notice.includes('pre-projection-backup'), notice);
  });
});

test('an owned file is replaced without a backup when its entries change', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    writeGeneratedViews(dir, WRITE);
    putEntry(dir, 'p', 'c-new', { date: '2026-10-02' });
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.backedUp, []);
    assert.ok(r.written.includes(VIEW));
    assert.equal(existsSync(join(dir, `${VIEW}.pre-projection-backup.md`)), false);
  });
});

test('an unreadable ownership record makes every file unowned, and the record is rewritten', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    writeGeneratedViews(dir, WRITE);
    putEntry(dir, 'p', 'c-new', { date: '2026-10-02' });
    put(dir, '.cache/generated-views.json', '{not json');
    const r = writeGeneratedViews(dir, WRITE);
    assert.ok(
      r.backedUp.some((b) => b.relPath === VIEW),
      JSON.stringify(r.backedUp),
    );
    const record = JSON.parse(readRel(dir, '.cache/generated-views.json'));
    assert.equal(record.views[VIEW], sha(readRel(dir, VIEW)));
  });
});

test('absorbed bytes are replaced without a backup, but only at the path they were absorbed from', () => {
  withTmpDir((dir) => {
    seedProjects(dir, ['p', 'q']);
    const absorbed = 'the old hot.md the migration absorbed\n';
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({ views: {}, absorbed: { [VIEW]: sha(absorbed) } }),
    );
    put(dir, VIEW, absorbed);
    put(dir, 'projects/q/hot.md', absorbed);
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(
      r.backedUp.map((b) => b.relPath),
      ['projects/q/hot.md'],
      'q holds the same bytes but they were never absorbed from q',
    );
    assert.equal(existsSync(join(dir, `${VIEW}.pre-projection-backup.md`)), false);
    assert.equal(readRel(dir, 'projects/q/hot.md.pre-projection-backup.md'), absorbed);
    const record = JSON.parse(readRel(dir, '.cache/generated-views.json'));
    assert.deepEqual(record.absorbed, { [VIEW]: sha(absorbed) }, 'absorbed is kept as it was');
  });
});

test('absorbed that is not an object is dropped and the views record is still honoured', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    writeGeneratedViews(dir, WRITE);
    const record = JSON.parse(readRel(dir, '.cache/generated-views.json'));
    put(dir, '.cache/generated-views.json', JSON.stringify({ ...record, absorbed: [sha('x')] }));
    putEntry(dir, 'p', 'c-new', { date: '2026-10-02' });
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.backedUp, []);
    assert.deepEqual(JSON.parse(readRel(dir, '.cache/generated-views.json')).absorbed, {});
  });
});

test('the old root projection hash seeds ownership of the root hot.md once', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    const rootBytes = 'what the old root projection wrote\n';
    put(dir, 'hot.md', rootBytes);
    put(dir, '.cache/root-hot-projection-state.json', JSON.stringify({ lastHash: sha(rootBytes) }));
    assert.deepEqual(writeGeneratedViews(dir, WRITE).backedUp, [], 'inherited hash: no backup');
  });
  withTmpDir((dir) => {
    seedProjects(dir);
    put(dir, 'hot.md', 'hand written root\n');
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(
      r.backedUp.map((b) => b.relPath),
      ['hot.md'],
    );
  });
});

test('bytes that land between the first read and the write are backed up too', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    writeGeneratedViews(dir, WRITE);
    putEntry(dir, 'p', 'c-new', { date: '2026-10-02' });
    const r = writeGeneratedViews(dir, {
      ...WRITE,
      testHooks: {
        beforeFinalWrite: (abs) => abs.endsWith(VIEW) && writeFileSync(abs, 'saved in the gap\n'),
      },
    });
    assert.deepEqual(
      r.backedUp.map((b) => b.relPath),
      [VIEW],
    );
    assert.equal(readRel(dir, `${VIEW}.pre-projection-backup.md`), 'saved in the gap\n');
  });
});

test('a vault that has not moved is left alone: notMigrated, no file written, tracked bytes intact', () => {
  withOldVault((dir) => {
    putEntry(dir, 'p', 'c1');
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.notMigrated, true);
    assert.deepEqual([r.written, r.backedUp], [[], []]);
    assert.equal(readRel(dir, VIEW), OLD_HOT_FILE);
    assert.equal(existsSync(join(dir, 'hot.md')), false);
    assert.equal(git(dir, ['status', '--porcelain']).stdout.trim(), '?? projects/p/sessions/');
  });
});

test('projects and root choose what is written', () => {
  withTmpDir((dir) => {
    seedProjects(dir, ['p', 'q']);
    const r = writeGeneratedViews(dir, { ...WRITE, projects: ['q', 'not-a-project'], root: false });
    assert.deepEqual(r.written.sort(), ['projects/q/hot.md', 'projects/q/session-state.md']);
    assert.equal(existsSync(join(dir, 'hot.md')), false);
    assert.match(readRel(dir, 'projects/q/hot.md'), /c-q/);
  });
});

test('a project .hypoignore hides gets no views and no root row, the others are unaffected', () => {
  withTmpDir((dir) => {
    seedProjects(dir, ['p', 'secret']);
    put(dir, '.hypoignore', 'projects/secret/hot.md\n');
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.written.sort(), ['hot.md', VIEW, 'projects/p/session-state.md'].sort());
    assert.equal(existsSync(join(dir, 'projects/secret/hot.md')), false);
    assert.equal(existsSync(join(dir, 'projects/secret/session-state.md')), false);
    assert.ok(!readRel(dir, 'hot.md').includes('secret'), 'the root table has no secret row');
    assert.match(readRel(dir, 'hot.md'), /\bp\b/);
  });
});

test('naming a project in `projects` does not write it while .hypoignore hides it, and without the pattern it is written', () => {
  withTmpDir((dir) => {
    seedProjects(dir, ['p', 'secret']);
    put(dir, '.hypoignore', 'projects/secret/session-state.md\n');
    const hidden = writeGeneratedViews(dir, { ...WRITE, projects: ['secret'], root: false });
    assert.deepEqual(hidden.written, []);
    unlinkSync(join(dir, '.hypoignore'));
    const shown = writeGeneratedViews(dir, { ...WRITE, projects: ['secret'], root: false });
    assert.deepEqual(shown.written.sort(), [
      'projects/secret/hot.md',
      'projects/secret/session-state.md',
    ]);
  });
});

test('the machine filter applies per device on write', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    putEntry(dir, 'p', 'c-secret', { date: '2026-10-02', visibilityScope: 'machine:devB' });
    writeGeneratedViews(dir, { device: 'devA' });
    assert.ok(!readRel(dir, 'projects/p/session-state.md').includes('c-secret'));
    writeGeneratedViews(dir, { device: 'devB' });
    assert.ok(readRel(dir, 'projects/p/session-state.md').includes('c-secret'));
  });
});

test('a busy vault lock is a lockTimeout result, not a throw, and the unlocked form runs inside the lock', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    const saved = process.env.HYPO_VAULT_LOCK_TIMEOUT_MS;
    process.env.HYPO_VAULT_LOCK_TIMEOUT_MS = '100';
    try {
      withFileLock(vaultCommitLockTarget(dir), () => {
        const busy = writeGeneratedViews(dir, WRITE);
        assert.equal(busy.lockTimeout, true);
        assert.deepEqual(busy.written, []);
        assert.equal(existsSync(join(dir, VIEW)), false);
        assert.equal(writeGeneratedViewsUnlocked(dir, WRITE).written.length, 3);
      });
    } finally {
      if (saved === undefined) delete process.env.HYPO_VAULT_LOCK_TIMEOUT_MS;
      else process.env.HYPO_VAULT_LOCK_TIMEOUT_MS = saved;
    }
    assert.match(consumeRootHotHealthNotice(dir) ?? '', /잠금/);
  });
});

// ── observed heads ───────────────────────────────────────────────────────────

suite('session views: observed heads');

const SID = '2b1c4d5e-aaaa-bbbb-cccc-0123456789ab';

test('heads accumulate as a union per level, and a full id never shows up under pointer', () => {
  withTmpDir((dir) => {
    recordObservedHeads(dir, SID, 'p', { level: 'full', heads: { masking: ['c1'] } });
    recordObservedHeads(dir, SID, 'p', {
      level: 'full',
      heads: { masking: ['c1', 'c2'], flow: ['c3'] },
    });
    recordObservedHeads(dir, SID, 'p', { level: 'pointer', heads: { masking: ['c9'] } });
    assert.deepEqual(readObservedHeads(dir, SID, 'p'), {
      full: { masking: ['c1', 'c2'], flow: ['c3'] },
      pointer: { masking: ['c9'] },
    });
    assert.deepEqual(readObservedHeads(dir, SID, 'other'), { full: {}, pointer: {} });
    assert.deepEqual(readObservedHeads(dir, 'someone-else', 'p'), { full: {}, pointer: {} });
  });
});

test('a record without a valid level throws and writes nothing', () => {
  withTmpDir((dir) => {
    for (const level of [undefined, 'both', 'FULL']) {
      assert.throws(
        () => recordObservedHeads(dir, SID, 'p', { level, heads: { a: ['c1'] } }),
        /level/,
      );
    }
    assert.throws(() => recordObservedHeads(dir, SID, 'p', undefined), /level/);
    assert.equal(existsSync(join(dir, '.cache')), false);
  });
});

test('a session id that is not a plain id never creates a file', () => {
  withTmpDir((dir) => {
    for (const bad of ['../x', 'a/b', '', 'a b', '.', null]) {
      const r = recordObservedHeads(dir, bad, 'p', { level: 'full', heads: { a: ['c1'] } });
      assert.equal(r.recorded, false, String(bad));
      assert.deepEqual(readObservedHeads(dir, bad, 'p'), { full: {}, pointer: {} });
    }
    assert.equal(existsSync(join(dir, '.cache')), false);
    assert.equal(existsSync(join(dir, 'x')), false);
  });
});

test('a corrupt record reads as empty and the next record starts over', () => {
  withTmpDir((dir) => {
    put(dir, `.cache/sessions/${SID}/observed-heads.json`, '{broken');
    assert.deepEqual(readObservedHeads(dir, SID, 'p'), { full: {}, pointer: {} });
    recordObservedHeads(dir, SID, 'p', { level: 'full', heads: { a: ['c1'] } });
    assert.deepEqual(readObservedHeads(dir, SID, 'p').full, { a: ['c1'] });
  });
});

// ── vault git helpers (hypo-shared) ──────────────────────────────────────────

suite('vault git helpers: HEAD paths and local changes');

test('revPathArg puts ./ in front so the path resolves from the vault', () => {
  assert.equal(revPathArg('HEAD', 'projects/p/hot.md'), 'HEAD:./projects/p/hot.md');
  assert.equal(revPathArg('@{u}', '.gitignore'), '@{u}:./.gitignore');
});

test('pathInHead is true for a committed path and false for one that exists only on disk', () => {
  withVault({}, (dir) => {
    assert.equal(pathInHead(dir, 'a.md'), false, 'no commit yet');
    put(dir, 'a.md', 'a\n');
    put(dir, 'sub/b.md', 'b\n');
    commitAll(dir);
    put(dir, 'disk-only.md', 'c\n');
    assert.equal(pathInHead(dir, 'a.md'), true);
    assert.equal(pathInHead(dir, 'sub/b.md'), true);
    assert.equal(pathInHead(dir, 'disk-only.md'), false);
    assert.equal(pathInHead(dir, 'missing.md'), false);
  });
  withTmpDir((dir) => assert.equal(pathInHead(dir, 'a.md'), false, 'not a repository'));
});

test('in a vault below the repository root, paths resolve from the vault and the prefix is reported', () => {
  withVault({}, (repo) => {
    put(repo, 'vault/projects/p/hot.md', 'x\n');
    put(repo, 'top.md', 'x\n');
    commitAll(repo);
    const vault = join(repo, 'vault');
    assert.equal(vaultGitPrefix(vault), 'vault/');
    assert.equal(vaultGitPrefix(repo), '');
    assert.equal(pathInHead(vault, 'projects/p/hot.md'), true);
    assert.equal(pathInHead(vault, 'vault/projects/p/hot.md'), false);
    assert.equal(pathInHead(vault, 'top.md'), false, 'a repository-root path is not a vault path');
  });
  withTmpDir((dir) => assert.equal(vaultGitPrefix(dir), '', 'not a repository'));
});

test('localChangesOn splits staged from unstaged, and a path staged then edited again is in both', () => {
  withVault({}, (dir) => {
    for (const rel of ['both.md', 'work.md', 'clean.md']) put(dir, rel, 'base\n');
    commitAll(dir);
    put(dir, 'both.md', 'staged\n');
    assert.equal(git(dir, ['add', 'both.md']).status, 0);
    put(dir, 'both.md', 'edited again\n');
    put(dir, 'work.md', 'edited\n');
    put(dir, 'untracked.md', 'new\n');
    const changes = localChangesOn(dir, ['both.md', 'work.md', 'clean.md', 'untracked.md']);
    assert.deepEqual(changes.staged, ['both.md']);
    assert.deepEqual(changes.unstaged.sort(), ['both.md', 'work.md']);
    assert.deepEqual(localChangesOn(dir, []), { staged: [], unstaged: [] });
  });
});

test('localChangesOn takes each path literally, so a glob character in a name matches only that file', () => {
  withVault({}, (dir) => {
    put(dir, 's1.md', 'base\n');
    put(dir, 's*.md', 'base\n');
    commitAll(dir);
    put(dir, 's1.md', 'edited\n');
    assert.deepEqual(localChangesOn(dir, ['s*.md']), { staged: [], unstaged: [] });
    assert.deepEqual(localChangesOn(dir, ['s1.md']).unstaged, ['s1.md']);
  });
});

test('when git cannot answer, localChangesOn reports every path changed so the caller stops', () => {
  withTmpDir((dir) => {
    assert.deepEqual(localChangesOn(dir, ['a.md', 'b.md']), {
      staged: ['a.md', 'b.md'],
      unstaged: ['a.md', 'b.md'],
    });
  });
});

// ── .hypoignore covers a project's session entries ───────────────────────────

suite('.hypoignore: a project hidden by its view paths hides its entries too');

const IGNORE_DIR = '/tmp/ignore-vault';
const ignoredIn = (isIgnored, rel, patterns) =>
  isIgnored(join(IGNORE_DIR, rel), IGNORE_DIR, patterns);

// The two `isIgnored` copies are separate code (hooks cannot import scripts/), so every case runs
// against both and a divergence between them shows up as a failure of one name.
for (const [name, isIgnored] of [
  ['hooks/hypo-shared isIgnored', isIgnoredHooks],
  ['scripts/lib/hypo-ignore isIgnored', isIgnoredScripts],
]) {
  test(`${name}: a view pattern covers that project's entries and no other project's`, () => {
    for (const pattern of ['projects/secret/hot.md', 'projects/secret/session-state.md']) {
      assert.equal(ignoredIn(isIgnored, 'projects/secret/sessions/x.md', [pattern]), true, pattern);
      assert.equal(ignoredIn(isIgnored, 'projects/other/sessions/x.md', [pattern]), false, pattern);
    }
  });

  test(`${name}: only an entry path gets the second look, and a directory pattern still matches`, () => {
    const pattern = ['projects/secret/hot.md'];
    assert.equal(ignoredIn(isIgnored, 'projects/secret/notes.md', pattern), false);
    assert.equal(ignoredIn(isIgnored, 'projects/secret/sessions/sub/x.md', pattern), false);
    assert.equal(ignoredIn(isIgnored, 'projects/secret/hot.md', pattern), true);
    assert.equal(ignoredIn(isIgnored, 'projects/secret/sessions/x.md', ['projects/secret/']), true);
    assert.equal(ignoredIn(isIgnored, 'projects/secret/sessions/x.md', []), false);
  });
}

// ── catching up with a migration commit ──────────────────────────────────────

suite('catch-up: clearGeneratedPathsBlockingPull clears what blocks the merge');

// Two real clones of one bare origin. `a` is the machine that migrates, `b` is the machine that
// has to catch up. Every git child gets HOME in the session temp dir and a throwaway global
// config; the production functions under test run in this process, so the same two variables are
// set around the body and restored in a finally.
const CATCH_UP_CONFIG = () => {
  const path = join(SESSION_TMP_HOME, 'gitconfig-catch-up');
  writeFileSync(
    path,
    '[user]\n\tname = t\n\temail = t@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n',
  );
  return path;
};

function cgit(dir, args) {
  return spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: SESSION_TMP_HOME,
      GIT_CONFIG_GLOBAL: CATCH_UP_CONFIG(),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

const cgitOk = (dir, args) => {
  const r = cgit(dir, args);
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function inCatchUpEnv(fn) {
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = CATCH_UP_CONFIG();
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const commitIn = (dir) => {
  cgitOk(dir, ['add', '-A']);
  cgitOk(dir, ['commit', '-q', '-m', 'x']);
};
const headOf = (dir) => cgitOk(dir, ['rev-parse', 'HEAD']).trim();
const commitCount = (dir) => Number(cgitOk(dir, ['rev-list', '--count', 'HEAD']).trim());
const sessionsDir = (dir, project = 'p') => join(dir, 'projects', project, 'sessions');
const listDir = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};
const backupsIn = (dir, rel) =>
  listDir(join(dir, dirname(rel))).filter((n) => n.startsWith(`${rel.split('/').at(-1)}.pre-`));

const SEED = {
  '.gitignore': '.cache/\n',
  'hot.md': 'root hot\n',
  'projects/p/index.md': '---\ntitle: p\n---\n',
  'projects/p/hot.md': OLD_HOT_FILE,
  'projects/p/session-state.md': OLD_STATE_FILE,
  'pages/x.md': 'x\n',
  'pages/y.md': 'y\n',
};

// `a` seeds the origin, `b` clones it, then `a` pushes a migration commit that untracks the old
// views and adds the block and a remote baseline. `b` has fetched it: HEAD is the old state,
// `@{u}` the migrated one. `opts.seed` adds seed files, `opts.migrate.touch` more files the
// migration commit changes, `opts.migrate.legacyDone` builds the remote baseline folded.
function withCatchUp(fn, opts = {}) {
  inCatchUpEnv(() =>
    withTmpDir((root) => {
      const origin = join(root, 'origin.git');
      const a = join(root, 'a');
      const b = join(root, 'b');
      cgitOk(root, ['init', '-q', '--bare', origin]);
      cgitOk(root, ['clone', '-q', origin, a]);
      for (const [rel, text] of Object.entries({ ...SEED, ...opts.seed })) put(a, rel, text);
      commitIn(a);
      cgitOk(a, ['push', '-q', '-u', 'origin', 'main']);
      cgitOk(root, ['clone', '-q', origin, b]);
      const gone = [
        'hot.md',
        'projects/p/hot.md',
        'projects/p/session-state.md',
        ...(opts.gone ?? []),
      ];
      cgitOk(a, ['rm', '-q', ...gone]);
      put(a, '.gitignore', `.cache/\n${GITIGNORE_BLOCK}`);
      const remote = buildBaselineEntry({
        hotText: OLD_HOT_FILE,
        stateText: OLD_STATE_FILE,
        date: '2026-09-25',
        visibilityScope: 'machine:devA',
        project: 'p',
        legacyDone: opts.migrate?.legacyDone === true,
      });
      put(a, `projects/p/sessions/${remote.fileName}`, remote.text);
      for (const [rel, text] of Object.entries(opts.migrate?.touch ?? {})) {
        put(a, rel, text);
        cgitOk(a, ['add', '-f', rel]); // the block ignores generated view paths
      }
      commitIn(a);
      cgitOk(a, ['push', '-q']);
      cgitOk(b, ['fetch', '-q']);
      fn({ a, b, root, remote });
    }),
  );
}

const W1 = OLD_HOT_FILE.replace('old hot body', 'local edit one');
const W2 = OLD_HOT_FILE.replace('old hot body', 'local edit two');
const clear = (dir, rev = '@{u}', opts) => clearGeneratedPathsBlockingPull(dir, rev, opts);
const ffTo = (dir, rev = '@{u}') => cgit(dir, ['merge', '--ff-only', rev]).status;
const unmerged = (dir) => cgitOk(dir, ['ls-files', '-u']).trim();

test('upstreamIsMigrated reads @{u}: true once the migrated commit is fetched, false before it and with no upstream', () => {
  withCatchUp(({ b, root }) => {
    assert.equal(upstreamIsMigrated(b), true);
    // Point the remote-tracking ref back at the old state, as before the fetch.
    cgitOk(b, ['update-ref', 'refs/remotes/origin/main', headOf(b)]);
    assert.equal(upstreamIsMigrated(b), false);
    cgitOk(b, ['fetch', '-q']);
    assert.equal(upstreamIsMigrated(b), true);
    const lone = join(root, 'lone');
    cgitOk(root, ['init', '-q', lone]);
    assert.equal(upstreamIsMigrated(lone), false, 'no upstream');
  });
});

test('(a) an uncommitted edit of a view blocks the ff; it is backed up and restored, then the ff succeeds', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    assert.notEqual(ffTo(b), 0, 'the block is real before the call');
    assert.equal(unmerged(b), '');
    const r = clear(b);
    assert.equal(r.ok, true);
    assert.equal(r.backups.length, 1);
    assert.equal(readFileSync(r.backups[0], 'utf-8'), W1);
    assert.equal(readRel(b, 'projects/p/hot.md'), OLD_HOT_FILE, 'the working tree is HEAD again');
    assert.deepEqual(
      r.archived.map((v) => [v.relPath, v.kind, v.backupPath, v.sha256]),
      [['projects/p/hot.md', 'worktree', r.backups[0], sha(W1)]],
    );
    assert.equal(ffTo(b), 0);
  });
});

test('(b) diverged history: the same edit is cleared and pull --no-rebase then succeeds with nothing unmerged', () => {
  withCatchUp(({ b }) => {
    putEntry(b, 'p', 'local-close-1');
    commitIn(b);
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true);
    assert.equal(cgit(b, ['pull', '--no-rebase', '--no-edit', '-q']).status, 0);
    assert.equal(unmerged(b), '');
    assert.equal(readFileSync(r.backups[0], 'utf-8'), W1);
  });
});

test('(b2) diverged history: a file only the local commit changed, edited again, is not a block', () => {
  withCatchUp(({ b }) => {
    put(b, 'pages/y.md', 'y local commit\n');
    commitIn(b);
    put(b, 'pages/y.md', 'y local commit\nplus uncommitted\n');
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(cgit(b, ['pull', '--no-rebase', '--no-edit', '-q']).status, 0);
    assert.equal(readRel(b, 'pages/y.md'), 'y local commit\nplus uncommitted\n');
  });
});

test('(c) staged bytes S and later working-tree bytes W are both backed up and archived, the stage is released', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    cgitOk(b, ['add', 'projects/p/hot.md']);
    put(b, 'projects/p/hot.md', W2);
    const r = clear(b);
    assert.equal(r.ok, true);
    const byKind = Object.fromEntries(r.archived.map((v) => [v.kind, v]));
    assert.equal(readFileSync(byKind.stage.backupPath, 'utf-8'), W1);
    assert.equal(readFileSync(byKind.worktree.backupPath, 'utf-8'), W2);
    assert.equal(byKind.stage.relPath, 'projects/p/hot.md');
    assert.equal(byKind.worktree.relPath, 'projects/p/hot.md');
    assert.equal(cgitOk(b, ['diff', '--cached', '--name-only']).trim(), '');
    assert.equal(ffTo(b), 0);
    // Both versions differ from the remote baseline: two additional baselines.
    const shared = shareLegacyBytes(b, r.archived);
    assert.equal(shared.created.length, 2);
  });
});

test('(c) the same bytes staged and in the working tree make one backup and one additional baseline', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    cgitOk(b, ['add', 'projects/p/hot.md']);
    const r = clear(b);
    assert.equal(r.ok, true);
    assert.equal(new Set(r.backups).size, 1);
    assert.equal(backupsIn(b, 'projects/p/hot.md').length, 1);
    assert.equal(ffTo(b), 0);
    assert.equal(shareLegacyBytes(b, r.archived).created.length, 1);
  });
});

test('(c2) a staged .gitignore that is not a pure addition defers and leaves HEAD, index and tree alone', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    put(b, '.gitignore', '.cache/\n!keep.md\n');
    cgitOk(b, ['add', '.gitignore']);
    const head = headOf(b);
    const stagedBytes = cgitOk(b, ['show', ':.gitignore']);
    const r = clear(b);
    assert.equal(r.ok, false);
    assert.equal(r.deferred, 'gitignore');
    assert.ok(r.notice.includes('.gitignore'));
    assert.equal(headOf(b), head);
    assert.equal(cgitOk(b, ['show', ':.gitignore']), stagedBytes);
    assert.equal(readRel(b, '.gitignore'), '.cache/\n!keep.md\n');
    assert.equal(readRel(b, 'projects/p/hot.md'), W1, 'nothing is archived before the verdict');
    assert.equal(backupsIn(b, 'projects/p/hot.md').length, 0);
  });
});

test('(d) a working-tree .gitignore with a negation line defers and touches nothing', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    put(b, '.gitignore', '.cache/\n!keep.md\n');
    const r = clear(b);
    assert.equal(r.ok, false);
    assert.equal(r.deferred, 'gitignore');
    assert.equal(readRel(b, '.gitignore'), '.cache/\n!keep.md\n');
    assert.equal(readRel(b, 'projects/p/hot.md'), W1);
    assert.equal(backupsIn(b, 'projects/p/hot.md').length, 0);
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), false);
  });
});

test('(e) a local edit of another incoming path is other-dirty and nothing is touched', () => {
  withCatchUp(
    ({ b }) => {
      put(b, 'pages/x.md', 'local x\n');
      put(b, 'projects/p/hot.md', W1);
      const r = clear(b);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'other-dirty');
      assert.equal(readRel(b, 'pages/x.md'), 'local x\n');
      assert.equal(readRel(b, 'projects/p/hot.md'), W1);
      assert.equal(backupsIn(b, 'projects/p/hot.md').length, 0);
    },
    { migrate: { touch: { 'pages/x.md': 'remote x\n' } } },
  );
});

test('uncommitted .gitignore additions are kept, the file is restored, and they come back after the ff once', () => {
  withCatchUp(({ b }) => {
    put(b, '.gitignore', '.cache/\nlocal-only/\n');
    const r = clear(b);
    assert.equal(r.ok, true);
    assert.deepEqual(r.gitignoreLines, ['local-only/']);
    assert.equal(readRel(b, '.gitignore'), '.cache/\n');
    assert.equal(ffTo(b), 0);
    assert.deepEqual(restoreGitignoreLines(b, r.gitignoreLines), ['local-only/']);
    assert.deepEqual(
      restoreGitignoreLines(b, r.gitignoreLines),
      [],
      'a second restore adds nothing',
    );
    const text = readRel(b, '.gitignore');
    assert.equal(text.split('\n').filter((l) => l === 'local-only/').length, 1);
    assert.ok(text.includes(GITIGNORE_BLOCK));
    assert.equal(cgitOk(b, ['diff', '--name-only']).trim(), '.gitignore', 'still uncommitted');
  });
});

test('(f) a run that stopped after archiving is recovered: the lines and the archived bytes come back, each once', () => {
  const stopAfterArchive = {
    testHooks: {
      afterArchive: () => {
        throw new Error('stopped');
      },
    },
  };
  const countLine = (dir) =>
    readRel(dir, '.gitignore')
      .split('\n')
      .filter((l) => l === 'local-only/').length;
  // Stopped before anything was restored: the second run finds the same dirt and the same record.
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    put(b, '.gitignore', '.cache/\nlocal-only/\n');
    assert.throws(() => clear(b, '@{u}', stopAfterArchive), /stopped/);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.gitignoreLines, ['local-only/']);
    assert.equal(r.archived.length, 1);
    assert.equal(
      backupsIn(b, 'projects/p/hot.md').length,
      1,
      'the backup is reused, not copied again',
    );
    assert.equal(ffTo(b), 0);
    restoreGitignoreLines(b, r.gitignoreLines);
    assert.equal(countLine(b), 1);
  });
  // Stopped further on: the working tree is already back at HEAD, so only the record remembers.
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    put(b, '.gitignore', '.cache/\nlocal-only/\n');
    assert.throws(() => clear(b, '@{u}', stopAfterArchive), /stopped/);
    cgitOk(b, ['checkout', 'HEAD', '--', 'projects/p/hot.md', '.gitignore']);
    assert.equal(countLine(b), 0);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.gitignoreLines, ['local-only/']);
    assert.deepEqual(
      r.archived.map((v) => [v.relPath, v.sha256]),
      [['projects/p/hot.md', sha(W1)]],
    );
    const record = JSON.parse(readRel(b, '.cache/pull-archive.json'));
    assert.equal(record.stage, 'archived');
    assert.equal(record.views.length, 1);
    assert.deepEqual(record.gitignoreLines, ['local-only/']);
    assert.equal(ffTo(b), 0);
    restoreGitignoreLines(b, r.gitignoreLines);
    assert.equal(countLine(b), 1);
  });
});

test('a path the target adds as tracked, held here untracked, is cleared: backed up unless the generator wrote it', () => {
  withCatchUp(({ b }) => {
    // a rollback-shaped target: the next commit re-adds two views as tracked files
    const [a2] = [join(dirname(b), 'a')];
    cgitOk(a2, ['pull', '-q']);
    put(a2, 'projects/p/hot.md', 'rolled back hot\n');
    put(a2, 'projects/p/session-state.md', 'rolled back state\n');
    cgitOk(a2, ['add', '-f', 'projects/p/hot.md', 'projects/p/session-state.md']);
    cgitOk(a2, ['commit', '-q', '-m', 'rollback']);
    cgitOk(a2, ['push', '-q']);
    cgitOk(b, ['pull', '-q', '--ff-only']);
    cgitOk(b, ['rm', '-q', '--cached', '-f', 'projects/p/hot.md', 'projects/p/session-state.md']);
    cgitOk(b, ['reset', '-q', '--hard', 'HEAD~1']);
    put(b, 'projects/p/hot.md', 'local generated hot\n');
    put(b, 'projects/p/session-state.md', 'owned generated state\n');
    put(
      b,
      '.cache/generated-views.json',
      JSON.stringify({ views: { 'projects/p/session-state.md': sha('owned generated state\n') } }),
    );
    const r = clear(b, 'origin/main');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(existsSync(join(b, 'projects/p/hot.md')), false);
    assert.equal(existsSync(join(b, 'projects/p/session-state.md')), false);
    assert.equal(r.backups.length, 1, 'only the file this machine did not generate is backed up');
    assert.equal(readFileSync(r.backups[0], 'utf-8'), 'local generated hot\n');
    assert.equal(ffTo(b, 'origin/main'), 0);
    assert.equal(readRel(b, 'projects/p/hot.md'), 'rolled back hot\n');
  });
});

test('a view staged as new while the target adds the same path is released from the index and removed, with its bytes kept', () => {
  withCatchUp(
    ({ b }) => {
      put(b, 'projects/q/hot.md', 'local q\n');
      cgitOk(b, ['add', 'projects/q/hot.md']);
      const r = clear(b);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.archived.map((v) => v.kind).sort(), ['stage', 'worktree']);
      assert.equal(readFileSync(r.backups[0], 'utf-8'), 'local q\n');
      assert.equal(cgitOk(b, ['diff', '--cached', '--name-only']).trim(), '');
      assert.equal(existsSync(join(b, 'projects/q/hot.md')), false);
      assert.equal(ffTo(b), 0);
      assert.equal(readRel(b, 'projects/q/hot.md'), 'q from remote\n');
    },
    { migrate: { touch: { 'projects/q/hot.md': 'q from remote\n' } } },
  );
});

test('(h) an ignored project: even clean old views are backed up and kept local, and never shared', () => {
  withCatchUp(
    ({ b }) => {
      put(b, '.hypoignore', 'projects/secret/hot.md\n');
      const r = clear(b);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.localOnly.map((v) => v.relPath).sort(), [
        'projects/secret/hot.md',
        'projects/secret/session-state.md',
      ]);
      const bytes = Object.fromEntries(
        r.localOnly.map((v) => [v.relPath, readFileSync(v.backupPath, 'utf-8')]),
      );
      assert.equal(bytes['projects/secret/hot.md'], 'secret hot\n');
      assert.equal(bytes['projects/secret/session-state.md'], 'secret state\n');
      assert.equal(r.archived.length, 0);
      assert.equal(
        backupsIn(b, 'projects/p/hot.md').length,
        0,
        'a project that is not ignored: no backup',
      );
      assert.equal(ffTo(b), 0);
      assert.equal(existsSync(join(b, 'projects/secret/hot.md')), false);
      assert.equal(existsSync(r.localOnly[0].backupPath), true);
      assert.deepEqual(shareLegacyBytes(b, r.archived).created, []);
      // The same view held in an old record is skipped by the share itself.
      const held = r.localOnly.find((v) => v.relPath === 'projects/secret/hot.md');
      const shared = shareLegacyBytes(b, [
        { ...held, kind: 'worktree', sha256: sha('secret hot\n'), companionRev: 'HEAD' },
      ]);
      assert.deepEqual(shared.created, []);
      assert.deepEqual(listDir(sessionsDir(b, 'secret')), []);
    },
    {
      seed: {
        'projects/secret/index.md': '---\ntitle: secret\n---\n',
        'projects/secret/hot.md': 'secret hot\n',
        'projects/secret/session-state.md': 'secret state\n',
      },
      gone: ['projects/secret/hot.md', 'projects/secret/session-state.md'],
    },
  );
});

test('(h2) an ignored project whose view has local edits: the edit is backed up and stays local, not archived', () => {
  withCatchUp(
    ({ b }) => {
      put(b, '.hypoignore', 'projects/secret/\n');
      put(b, 'projects/secret/session-state.md', 'secret state edited\n');
      cgitOk(b, ['add', 'projects/secret/session-state.md']);
      const r = clear(b);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.archived.length, 0);
      const edited = r.localOnly.filter((v) => v.relPath === 'projects/secret/session-state.md');
      assert.deepEqual(
        [...new Set(edited.map((v) => readFileSync(v.backupPath, 'utf-8')))],
        ['secret state edited\n'],
      );
      assert.equal(ffTo(b), 0);
    },
    {
      seed: {
        'projects/secret/index.md': '---\ntitle: secret\n---\n',
        'projects/secret/hot.md': 'secret hot\n',
        'projects/secret/session-state.md': 'secret state\n',
      },
      gone: ['projects/secret/hot.md', 'projects/secret/session-state.md'],
    },
  );
});

// ── additional baselines and the leftover archive ────────────────────────────

suite('catch-up: shareLegacyBytes and resumePullArchive share the bytes that were set aside');

const catchUpAndMerge = (b, hooks) => {
  const pre = clear(b, '@{u}', hooks);
  assert.equal(pre.ok, true, JSON.stringify(pre));
  assert.equal(ffTo(b), 0);
  return pre;
};
const baselinesOf = (dir) =>
  listDir(sessionsDir(dir)).filter((n) => /-baseline-[0-9a-f]{16}\.md$/.test(n));
const legacyHeads = (dir, state = 'migrated') => {
  const model = loadSessionModel(dir, 'p', { state });
  return trackHeads(model.entries).find((t) => t.trackId === LEGACY_TRACK_ID)?.heads ?? [];
};

test('(g) bytes that differ from the remote baseline become a new committed baseline and a second legacy head', () => {
  withCatchUp(({ b, remote }) => {
    put(b, 'projects/p/hot.md', W1);
    const pre = catchUpAndMerge(b);
    assert.deepEqual(baselinesOf(b), [remote.fileName]);
    const before = commitCount(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.equal(shared.created.length, 1);
    assert.match(
      shared.created[0],
      /^projects\/p\/sessions\/2026-09-25-baseline-[0-9a-f]{16}\.md$/,
    );
    assert.equal(baselinesOf(b).length, 2);
    assert.equal(commitCount(b), before + 1, 'one commit');
    assert.equal(pathInHead(b, shared.created[0]), true);
    assert.equal(legacyHeads(b).length, 2);
    assert.ok(shared.notices.some((n) => n.includes(shared.created[0])));
  });
});

test('(g) the same bytes as the remote baseline make no new file, even when the remote baseline was folded', () => {
  for (const legacyDone of [false, true]) {
    withCatchUp(
      ({ b }) => {
        const pre = catchUpAndMerge(b);
        const backup = join(b, 'held-hot.txt');
        writeFileSync(backup, OLD_HOT_FILE);
        const held = [
          {
            relPath: 'projects/p/hot.md',
            kind: 'worktree',
            backupPath: backup,
            sha256: sha(OLD_HOT_FILE),
            companionRev: 'ORIG_HEAD',
          },
        ];
        void pre;
        const before = commitCount(b);
        const shared = shareLegacyBytes(b, held);
        assert.deepEqual(shared.created, [], `legacyDone ${legacyDone}`);
        assert.equal(commitCount(b), before);
        assert.equal(baselinesOf(b).length, 1);
      },
      { migrate: { legacyDone } },
    );
  }
});

test('(g) the root hot.md is never turned into a baseline', () => {
  withCatchUp(({ b }) => {
    put(b, 'hot.md', 'root edited\n');
    const pre = catchUpAndMerge(b);
    assert.equal(pre.archived.length, 1);
    const before = baselinesOf(b);
    assert.deepEqual(shareLegacyBytes(b, pre.archived).created, []);
    assert.deepEqual(baselinesOf(b), before);
  });
});

test('(g) a baseline this machine had already folded with done is created but is not a legacy head', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const virtual = loadSessionModel(b, 'p', { state: 'not-migrated' }).entries.find((e) =>
      isBaselineId(e.closeId),
    );
    putEntry(b, 'p', 'earlier-close-1', {
      tracks: [{ id: LEGACY_TRACK_ID, done: true, supersedes: [virtual.closeId] }],
      bodies: { [LEGACY_TRACK_ID]: 'folded\n' },
    });
    const pre = catchUpAndMerge(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.equal(shared.created.length, 1);
    const ids = legacyHeads(b).map((h) => h.closeId);
    assert.equal(ids.includes(virtual.closeId), false, 'the folded id stays folded');
    assert.ok(baselinesOf(b).some((n) => n.includes(virtual.closeId.slice('baseline-'.length))));
  });
});

test('(g2) a frontmatter-only difference is a different memory and gets its own baseline', () => {
  withCatchUp(({ b }) => {
    put(
      b,
      'projects/p/hot.md',
      OLD_HOT_FILE.replace('visibility_scope:', 'machine_note: changed\nvisibility_scope:'),
    );
    const pre = catchUpAndMerge(b);
    assert.equal(shareLegacyBytes(b, pre.archived).created.length, 1);
  });
});

test('shareLegacyBytes skips an element whose backup is gone or changed, and says so', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const pre = catchUpAndMerge(b);
    const [view] = pre.archived;
    writeFileSync(view.backupPath, 'changed by hand\n');
    const before = commitCount(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.deepEqual(shared.created, []);
    assert.deepEqual(shared.skipped, ['projects/p/hot.md']);
    assert.equal(shared.notices.length, 1);
    assert.equal(commitCount(b), before);
  });
});

test('(i) a stop between the ff and the share is finished by resumePullArchive, once', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    put(b, '.gitignore', '.cache/\nlocal-only/\n');
    // the caller, up to the point where it stops
    assert.throws(() => {
      catchUpAndMerge(b);
      throw new Error('stopped after the merge');
    }, /stopped after the merge/);
    assert.equal(migrationState(b), 'migrated');
    const record = JSON.parse(readRel(b, '.cache/pull-archive.json'));
    assert.equal(record.stage, 'archived');
    const before = commitCount(b);
    const first = resumePullArchive(b);
    assert.equal(first.resumed, true);
    assert.equal(first.created.length, 1);
    assert.equal(commitCount(b), before + 1);
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), false);
    assert.equal(
      readRel(b, '.gitignore')
        .split('\n')
        .filter((l) => l === 'local-only/').length,
      1,
    );
    const head = headOf(b);
    assert.equal(resumePullArchive(b).resumed, false);
    assert.equal(headOf(b), head, 'a second resume makes no commit');
  });
});

test('(i) the commit was made but the record was not deleted: resume deletes it and makes no commit', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const pre = catchUpAndMerge(b);
    markPullArchiveMerged(b);
    const saved = readRel(b, '.cache/pull-archive.json');
    assert.equal(JSON.parse(saved).stage, 'merged');
    assert.equal(shareLegacyBytes(b, pre.archived).created.length, 1);
    const head = headOf(b);
    writeFileSync(join(b, '.cache', 'pull-archive.json'), saved);
    const r = resumePullArchive(b);
    assert.equal(r.resumed, true);
    assert.deepEqual(r.created, [], 'the baseline is already there, so nothing is created');
    assert.equal(headOf(b), head);
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), false);
  });
});

test('(i) an archived record whose target is not in HEAD yet is left alone', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const pre = clear(b);
    assert.equal(pre.ok, true);
    const bytes = readRel(b, '.cache/pull-archive.json');
    const r = resumePullArchive(b);
    assert.equal(r.resumed, false);
    assert.equal(readRel(b, '.cache/pull-archive.json'), bytes);
    assert.deepEqual(baselinesOf(b), [], 'nothing was shared');
  });
});
