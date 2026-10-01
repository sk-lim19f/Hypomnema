// tests/session-entries.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not, that is what lets the runner shard.
//
// Covers hooks/session-entries.mjs: the pure session entry format, the baseline
// entry, the path predicates, and the byte-fixed .gitignore/.gitattributes blocks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  isGeneratedViewPath,
  isSessionEntryPath,
  isSessionProjectDir,
  mergeAdditiveGitignore,
  narrowestVisibilityScope,
  nextUpItems,
  parseSessionEntry,
  renderViews,
  resolveSupersedesPrefix,
  sessionViewPathsOf,
  sortEntries,
  sortRootRows,
  splitLegacyFrontmatter,
  trackHeads,
} from '../hooks/session-entries.mjs';
import {
  formatRootHotProjection,
  resolveActiveProject,
  scopeVisible,
} from '../hooks/hypo-shared.mjs';
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

test('the machine filter answers like scopeVisible for every scope shape', () => {
  for (const scope of [
    null,
    '',
    'shared',
    'machine:devA',
    'machine:devB',
    'machine:',
    'agent:x',
    'odd',
  ]) {
    for (const device of ['devA', 'devB', 'devC']) {
      const items = nextUpItems(M([E('c1', { visibilityScope: scope })]), { device });
      assert.equal(items.length === 1, scopeVisible(scope, device), `${scope} on ${device}`);
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
