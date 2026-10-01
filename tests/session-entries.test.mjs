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
  formatSessionEntry,
  isGeneratedViewPath,
  isSessionEntryPath,
  mergeAdditiveGitignore,
  narrowestVisibilityScope,
  parseSessionEntry,
  resolveSupersedesPrefix,
  sessionViewPathsOf,
  splitLegacyFrontmatter,
} from '../hooks/session-entries.mjs';
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
