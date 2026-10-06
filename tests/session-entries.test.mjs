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
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
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
  generatedViewSlug,
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
  frontmatterScalar,
  isIgnored as isIgnoredHooks,
  legacyBaselineDate,
  localChangesOn,
  markPullArchiveMerged,
  pathInHead,
  readGeneratedViewsRecord,
  readVisibilityScope,
  resolveActiveProject,
  restoreGitignoreLines,
  resumePullArchive,
  setAsideNotices,
  revPathArg,
  rootHotBackupRecoveryNotice,
  scopeVisible as sharedScopeVisible,
  shareLegacyBytes,
  undoClearedPaths,
  incomingChangesViewTracking,
  upstreamIsMigrated,
  vaultCommitLockTarget,
  vaultGitPrefix,
  withFileLock,
} from '../hooks/hypo-shared.mjs';
import {
  SESSION_ENTRIES_OFF_MARKER,
  buildCommitInTempIndex,
  fastForwardTo,
  listSessionEntries,
  listSessionProjects,
  listTrackedGeneratedViews,
  loadSessionModel,
  migrateVaultToSessionEntries,
  migrationState,
  projectEntryScope,
  readObservedHeads,
  recordObservedHeads,
  writeGeneratedViews,
  writeGeneratedViewsUnlocked,
} from '../hooks/session-views.mjs';
import { isIgnored as isIgnoredScripts } from '../scripts/lib/hypo-ignore.mjs';
import { isValidProjectName } from '../scripts/lib/project-create.mjs';
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

test('a marker line ending in CRLF or CR is refused: the parser folds it to the marker', () => {
  const marker = entryMarker('summary', CID);
  const track = entryMarker('track', CID, 'masking');
  for (const eol of ['\r\n', '\r', '\r\r\n']) {
    for (const m of [marker, track]) {
      const text = `before\n${m}${eol}after`;
      // The fixture really carries the line ending the check used to miss.
      assert.ok(text.includes(`${m}${eol}`));
      assert.throws(
        () => assertNoEntryMarkers(text, CID),
        (err) => err.code === 'payload-reserved-marker',
      );
      assert.throws(
        () => formatSessionEntry(sample({ summary: text })),
        (err) => err.code === 'payload-reserved-marker',
      );
      assert.throws(
        () => formatSessionEntry(sample({ bodies: { masking: text } })),
        (err) => err.code === 'payload-reserved-marker',
      );
    }
  }
});

test('section text is written as the LF text that was checked: no CR reaches the file', () => {
  const summary = 'a\r\nb\rc\r\n';
  const body = 'x\r\n\r\ny\r';
  const text = formatSessionEntry(sample({ summary, bodies: { masking: body } }));
  assert.ok(!text.includes('\r'));
  const parsed = parseSessionEntry(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entry.summary, 'a\nb\nc\n');
  assert.equal(parsed.entry.bodies.masking, 'x\n\ny\n');
  assert.equal(formatSessionEntry(parsed.entry), text);
});

test('a project must be a vault slug: a space or # in it is refused by the writer and the parser', () => {
  for (const project of ['foo #bar', 'a b', '..', '.', '#x', 'a/b', 'a"b', '-', '', '한글']) {
    assert.throws(
      () => formatSessionEntry(sample({ project })),
      (err) => err.code === 'invalid-entry',
      JSON.stringify(project),
    );
  }
  for (const project of ['my-proj.v2', 'p', 'A_b-1', '.hidden', '1', 'a..b']) {
    const text = formatSessionEntry(sample({ project }));
    assert.equal(parseSessionEntry(text).entry.project, project);
  }
  const good = formatSessionEntry(sample());
  for (const project of ['foo #bar', 'a b', '..']) {
    const forged = good.replace('\nproject: p\n', `\nproject: ${project}\n`);
    assert.notEqual(forged, good);
    assert.deepEqual(parseSessionEntry(forged), { ok: false, reason: 'bad-project' });
  }
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
    assert.throws(
      () => formatSessionEntry(sample({ tracks: [{ id }], bodies: {} })),
      (err) => err.code === 'invalid-entry' && /bad-track-id/.test(err.message),
    );
  }
  assert.equal(LEGACY_TRACK_ID, 'legacy');
});

test('formatSessionEntry throws only the three codes of the plan, with the finer reason in the message', () => {
  const codeOf = (obj) => {
    try {
      formatSessionEntry(obj);
    } catch (err) {
      return err;
    }
    assert.fail('formatSessionEntry did not throw');
  };
  for (const tracks of [
    'x',
    [null],
    [[]],
    [{ id: 'a', title: 5 }],
    [{ id: 'a', supersedes: 'b' }],
    [{ id: 'a', supersedes: [1] }],
    [{ id: 'a', new: 'yes' }],
    [{ id: 'a', done: 1 }],
  ]) {
    const err = codeOf(sample({ tracks, bodies: {} }));
    assert.equal(err.code, 'invalid-entry', JSON.stringify(tracks));
    assert.match(err.message, /bad-tracks/);
  }
  assert.equal(codeOf(sample({ project: 'a"b' })).code, 'invalid-entry');
  assert.equal(codeOf(sample({ bodies: { nope: 'x' } })).code, 'invalid-entry');
  assert.equal(codeOf(sample({ summary: 5 })).code, 'invalid-entry');
});

test('parseSessionEntry keeps its reason strings for a bad tracks line', () => {
  const at = (tracks) =>
    parseSessionEntry(
      formatSessionEntry(sample()).replace(/^tracks: .*$/m, `tracks: ${JSON.stringify(tracks)}`),
    );
  assert.deepEqual(at('x'), { ok: false, reason: 'bad-tracks' });
  assert.deepEqual(at([{ id: 'Bad' }]), { ok: false, reason: 'bad-track-id' });
});

test('a CRLF copy of an entry (autocrlf checkout) parses to the same entry', () => {
  const text = formatSessionEntry(sample());
  const crlf = text.replaceAll('\n', '\r\n');
  assert.notEqual(crlf, text);
  const parsed = parseSessionEntry(crlf);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed, parseSessionEntry(text));
  assert.equal(formatSessionEntry(parsed.entry), text);
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

test('a baseline from CRLF files is the baseline from the same LF files, with no CR in it', () => {
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  assert.equal(OLD_HOT.includes('\r') || OLD_STATE.includes('\r'), false);
  const fromLf = baseline();
  const fromCrlf = baseline({ hotText: crlf(OLD_HOT), stateText: crlf(OLD_STATE) });
  assert.equal(fromCrlf.closeId, fromLf.closeId);
  assert.equal(fromCrlf.fileName, fromLf.fileName);
  assert.equal(fromCrlf.text, fromLf.text);
  assert.equal(fromCrlf.text.includes('\r'), false);
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

test('generatedViewSlug names the project of a depth-1 view and nothing else', () => {
  assert.equal(generatedViewSlug('projects/p/hot.md'), 'p');
  assert.equal(generatedViewSlug('projects/p/session-state.md'), 'p');
  for (const rel of [
    'hot.md',
    'projects/_template/hot.md',
    'projects/_template/session-state.md',
    'projects/p/platform/hot.md',
    'projects/p/sessions/2026-10-01-x.md',
    'pages/hot.md',
    '',
  ]) {
    assert.equal(generatedViewSlug(rel), null, rel);
  }
  for (const rel of SAMPLE_PATHS) {
    assert.equal(
      isGeneratedViewPath(rel),
      rel === 'hot.md' || generatedViewSlug(rel) !== null,
      rel,
    );
  }
});

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

test('the block ignores the temp file a killed view write leaves beside the view, and hides no file a person would name', () => {
  // The name atomicWrite gives its temp: `<path>.<pid>.<random>.tmp`.
  const tmpOf = (rel) => `${rel}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const views = ['hot.md', 'projects/p/hot.md', 'projects/p/session-state.md'];
  const leaked = views.map(tmpOf);
  const mine = ['hot.md.draft.tmp', 'projects/p/hot.md.old', 'projects/p/notes.md.1.tmp'];
  // a vault with its own .gitignore around the block, as an existing vault has
  withVault({ '.gitignore': `node_modules/\n${GITIGNORE_BLOCK}local-only/\n` }, (dir) => {
    for (const rel of [...leaked, ...mine]) put(dir, rel, 'x\n');
    assert.equal(git(dir, ['add', '-A']).status, 0);
    const staged = git(dir, ['ls-files']).stdout.split('\n').filter(Boolean);
    for (const rel of leaked) assert.equal(staged.includes(rel), false, `${rel} is not staged`);
    for (const rel of mine) assert.equal(staged.includes(rel), true, `${rel} is a person's file`);
  });
});

test('the block ignores everything under .cache/, where backups and the records live', () => {
  withVault({ '.gitignore': `node_modules/\n${GITIGNORE_BLOCK}` }, (dir) => {
    const files = [
      '.cache/backups/projects/p/hot.md.pre-projection-backup.md',
      '.cache/pull-archive.json',
      '.cache/generated-views.json',
    ];
    for (const rel of files) put(dir, rel, 'private notes\n');
    assert.equal(git(dir, ['add', '-A']).status, 0);
    assert.deepEqual(git(dir, ['ls-files']).stdout.split('\n').filter(Boolean), ['.gitignore']);
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

test('GITATTRIBUTES_BLOCK pins eol=lf on a depth-1 session entry and on no other path', () => {
  withVault({ '.gitattributes': GITATTRIBUTES_BLOCK }, (dir) => {
    const attr = (rel) => git(dir, ['check-attr', 'eol', 'text', '--', rel]).stdout.trim();
    const entry = 'projects/p/sessions/2026-10-01-x.md';
    assert.equal(attr(entry), `${entry}: eol: lf\n${entry}: text: set`);
    for (const rel of [
      'projects/p/session-log/2026-10-01.md',
      'projects/p/platform/sessions/x.md',
      'projects/p/sessions/x.tmp',
      'projects/p/hot.md',
      'log.md',
    ]) {
      assert.equal(attr(rel), `${rel}: eol: unspecified\n${rel}: text: unspecified`, rel);
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

test('mergeAdditiveGitignore reads a CRLF .gitignore: a pure addition on any side merges', () => {
  const crlf = (t) => t.replaceAll('\n', '\r\n');
  assert.deepEqual(mergeAdditiveGitignore(BASE, crlf(`${BASE}/o\n`), BASE), {
    ok: true,
    merged: `${BASE}/o\n`,
  });
  assert.deepEqual(mergeAdditiveGitignore(crlf(BASE), BASE, crlf(`${BASE}/t\n`)), {
    ok: true,
    merged: `${crlf(`${BASE}/t\n`)}`,
  });
  assert.equal(mergeAdditiveGitignore(BASE, crlf('*.tmp\n'), BASE).ok, false);
});

test('mergeAdditiveGitignore refuses a removed, reordered or replaced base line on either side', () => {
  assert.equal(mergeAdditiveGitignore(BASE, '*.tmp\n', `${BASE}/t\n`).ok, false);
  assert.equal(mergeAdditiveGitignore(BASE, `${BASE}/o\n`, '.cache/\n').ok, false);
  assert.equal(mergeAdditiveGitignore(BASE, '*.tmp\n.cache/\n', BASE).ok, false);
  assert.equal(mergeAdditiveGitignore(BASE, '.cache/\n*.log\n', BASE).ok, false);
});

test('mergeAdditiveGitignore refuses a line inserted in the middle on either side: only tail additions merge', () => {
  const mid = '.cache/\n/mid\n*.tmp\n';
  const head = '/mid\n.cache/\n*.tmp\n';
  for (const changed of [mid, head]) {
    // The fixture really differs from a tail addition: the base lines are not a prefix.
    assert.ok(!changed.startsWith(BASE));
    assert.deepEqual(mergeAdditiveGitignore(BASE, changed, `${BASE}/t\n`), {
      ok: false,
      reason: 'ours-changed-base-line',
    });
    assert.deepEqual(mergeAdditiveGitignore(BASE, `${BASE}/o\n`, changed), {
      ok: false,
      reason: 'theirs-changed-base-line',
    });
  }
  // The same added line at the tail is fine.
  assert.equal(mergeAdditiveGitignore(BASE, `${BASE}/mid\n`, `${BASE}/t\n`).ok, true);
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

test('isSessionProjectDir takes the slugs the other project rules take: no space, #, slash or all-dot name', () => {
  const names = [
    'p',
    'my-proj.v2',
    'A_b-1',
    '.hidden',
    'a..b',
    'foo #bar',
    'a b',
    '#x',
    '..',
    '.',
    '-',
    '한글',
    '',
  ];
  for (const slug of names) {
    const asDir = isSessionProjectDir({ slug, hasIndex: true, hasSessions: true });
    assert.equal(asDir, isValidProjectName(slug), `scripts validator: ${JSON.stringify(slug)}`);
    const forged = formatSessionEntry(sample()).replace('\nproject: p\n', `\nproject: ${slug}\n`);
    assert.equal(
      asDir,
      parseSessionEntry(forged).ok === true,
      `entry parser: ${JSON.stringify(slug)}`,
    );
  }
  assert.equal(isSessionProjectDir({ slug: undefined, hasIndex: true, hasSessions: true }), false);
});

test('listSessionProjects skips a projects/ child whose name is not a slug, even with an index.md', () => {
  withTmpDir((dir) => {
    for (const name of ['p', 'foo #bar', 'a b', '..hidden ', '_template']) {
      put(dir, `projects/${name}/index.md`, '---\ntitle: x\n---\n');
    }
    assert.deepEqual(listSessionProjects(dir), ['p']);
  });
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

// Runs `body` as module code in a node child with the session-views module bound to `V`. HOME is
// pinned like every other child the tests spawn; `env` is merged over the parent's.
const VIEWS_URL = new URL('../hooks/session-views.mjs', import.meta.url).href;
const runChild = (body, env = {}) =>
  spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import * as V from ${JSON.stringify(VIEWS_URL)};\n${body}`],
    { encoding: 'utf-8', env: { ...process.env, HOME: SESSION_TMP_HOME, ...env } },
  );

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

test('visibility_scope and entry_scope are read by one parser: quotes, comments, first-wins, CRLF and nesting alike', () => {
  const doc = (lines, eol = '\n') => `---${eol}${lines.join(eol)}${eol}---${eol}body${eol}`;
  const cases = [
    ['plain', (k) => [`${k}: machine:devA`], true, '\n'],
    ['double quotes', (k) => [`${k}: "machine:devA"`], true, '\n'],
    ['single quotes', (k) => [`${k}: 'machine:devA'`], true, '\n'],
    ['trailing comment', (k) => [`${k}: machine:devA # note`], true, '\n'],
    ['first wins', (k) => [`${k}: machine:devA`, `${k}: machine:devB`], true, '\n'],
    ['CRLF', (k) => [`${k}: machine:devA`], true, '\r\n'],
    ['nested key', (k) => ['meta:', `  ${k}: machine:devA`], false, '\n'],
    ['list item', (k) => ['tags:', `- ${k}: machine:devA`], false, '\n'],
  ];
  withTmpDir((dir) => {
    for (const [name, lines, read, eol] of cases) {
      const viaVisibility = readVisibilityScope(doc(lines('visibility_scope'), eol));
      assert.equal(viaVisibility, read ? 'machine:devA' : '', `visibility_scope: ${name}`);
      put(dir, 'projects/p/index.md', doc(lines('entry_scope'), eol));
      const viaEntry = projectEntryScope(dir, 'p');
      assert.equal(viaEntry === 'machine:devA', read, `entry_scope: ${name} (${viaEntry})`);
      for (const key of ['visibility_scope', 'entry_scope']) {
        assert.equal(
          frontmatterScalar(doc(lines(key), eol), key),
          read ? 'machine:devA' : null,
          `${key}: ${name}`,
        );
      }
    }
    assert.equal(frontmatterScalar('no frontmatter', 'entry_scope'), null);
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
const BACKUP_DIR = '.cache/backups';
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
    assert.equal(readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`), 'hand written\n');
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
    assert.equal(existsSync(join(dir, BACKUP_DIR, `${VIEW}.pre-projection-backup.md`)), false);
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

test('ownership is per path and only `views` counts: the same bytes at another path, or under a stale absorbed key, are backed up', () => {
  withTmpDir((dir) => {
    seedProjects(dir, ['p', 'q']);
    const bytes = 'bytes the writer recorded for q only\n';
    // p is written before q, so a lookup that ignored the path would still find q's record
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({
        views: { 'projects/q/hot.md': sha(bytes) },
        absorbed: { [VIEW]: sha(bytes) },
      }),
    );
    put(dir, VIEW, bytes);
    put(dir, 'projects/q/hot.md', bytes);
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(
      r.backedUp.map((b) => b.relPath),
      [VIEW],
      'p holds the same bytes, but only a views record at p, not a record at q or an absorbed key, protects them',
    );
    assert.equal(readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`), bytes);
    assert.equal(
      existsSync(join(dir, BACKUP_DIR, 'projects/q/hot.md.pre-projection-backup.md')),
      false,
    );
  });
});

test('a record that still carries an absorbed key keeps its views honoured and is rewritten without the key', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    writeGeneratedViews(dir, WRITE);
    const record = JSON.parse(readRel(dir, '.cache/generated-views.json'));
    put(dir, '.cache/generated-views.json', JSON.stringify({ ...record, absorbed: [sha('x')] }));
    putEntry(dir, 'p', 'c-new', { date: '2026-10-02' });
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.backedUp, []);
    assert.deepEqual(Object.keys(JSON.parse(readRel(dir, '.cache/generated-views.json'))), [
      'views',
    ]);
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
    assert.equal(
      readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`),
      'saved in the gap\n',
    );
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

test('git that cannot answer is not a vault that tracks nothing: a tracked view survives a writer run without git', () => {
  withOldVault((dir) => {
    putEntry(dir, 'p', 'c1');
    const statusBefore = git(dir, ['status', '--porcelain']).stdout;
    withTmpDir((plain) => {
      put(plain, 'worktree/.git', 'gitdir: /nowhere\n'); // the file a linked worktree has
      mkdirSync(join(plain, 'worktree/sub'));
      const body = (path) =>
        `console.log(JSON.stringify(V.migrationState(${JSON.stringify(path)})))`;
      const noGit = { PATH: '/nonexistent' };
      const run = (path) => JSON.parse(runChild(body(path), noGit).stdout);
      assert.equal(run(dir), 'not-migrated', 'a repository, git not found');
      assert.equal(run(join(dir, 'projects/p')), 'not-migrated', 'a directory inside it');
      assert.equal(run(join(plain, 'worktree/sub')), 'not-migrated', 'a .git file above');
      assert.equal(run(plain), 'migrated', 'no .git entry anywhere: nothing is tracked');
      const written = runChild(
        `console.log(JSON.stringify(V.writeGeneratedViews(${JSON.stringify(dir)}, { device: 'devA' })))`,
        noGit,
      );
      assert.equal(written.status, 0, written.stderr);
      const result = JSON.parse(written.stdout);
      assert.equal(result.notMigrated, true);
      assert.deepEqual([result.written, result.backedUp], [[], []]);
    });
    assert.equal(readRel(dir, VIEW), OLD_HOT_FILE);
    assert.equal(git(dir, ['status', '--porcelain']).stdout, statusBefore);
  });
});

test('a vault reached through a symlink to a subdirectory of a repository has its .git above the real path', () => {
  withTmpDir((tmp) => {
    mkdirSync(join(tmp, 'repo/vault'), { recursive: true });
    mkdirSync(join(tmp, 'repo/.git'));
    symlinkSync(join(tmp, 'repo/vault'), join(tmp, 'x'));
    const body = `console.log(JSON.stringify(V.migrationState(${JSON.stringify(join(tmp, 'x'))})))`;
    const r = runChild(body, { PATH: '/nonexistent' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      JSON.parse(r.stdout),
      'not-migrated',
      'git cannot answer, the real path has a .git',
    );
    // a link into a place with no .git anywhere is still a vault that tracks nothing
    mkdirSync(join(tmp, 'plain/vault'), { recursive: true });
    symlinkSync(join(tmp, 'plain/vault'), join(tmp, 'y'));
    const plain = runChild(body.replace(join(tmp, 'x'), join(tmp, 'y')), { PATH: '/nonexistent' });
    assert.equal(JSON.parse(plain.stdout), 'migrated');
  });
});

test('a writer killed after the first view leaves it vouched for: the rerun backs nothing up and leaves no notice', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    const killed = runChild(
      `V.writeGeneratedViewsUnlocked(${JSON.stringify(dir)}, {
        device: 'devA',
        testHooks: { beforeFinalWrite: (abs) => abs.endsWith('session-state.md') && process.kill(process.pid, 'SIGKILL') },
      })`,
    );
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal(existsSync(join(dir, VIEW)), true, 'the first view was written');
    assert.equal(existsSync(join(dir, 'projects/p/session-state.md')), false, 'the second was not');
    putEntry(dir, 'p', 'c-new', { date: '2026-10-02' }); // the first view's bytes now differ
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.backedUp, []);
    assert.ok(r.written.includes(VIEW));
    assert.equal(existsSync(join(dir, BACKUP_DIR, `${VIEW}.pre-projection-backup.md`)), false);
    assert.equal(consumeRootHotHealthNotice(dir), null);
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

test('localChangesOn asks git in groups: the same answer as one call, and a list too long for one call still works', () => {
  withVault({}, (dir) => {
    for (let i = 0; i < 5; i++) put(dir, `f${i}.md`, 'base\n');
    commitAll(dir);
    put(dir, 'f1.md', 'edited\n');
    put(dir, 'f3.md', 'staged\n');
    assert.equal(git(dir, ['add', 'f3.md']).status, 0);
    const paths = ['f0.md', 'f1.md', 'f2.md', 'f3.md', 'f4.md', 'not-there.md'];
    const whole = localChangesOn(dir, paths);
    assert.deepEqual(whole, { staged: ['f3.md'], unstaged: ['f1.md'] });
    assert.deepEqual(localChangesOn(dir, paths, { chunkSize: 2 }), whole);
    // Past the argument-size limit of one git call (4MB of pathspecs), only groups can answer.
    const many = Array.from({ length: 50000 }, (_, i) => `projects/${'x'.repeat(60)}/s/${i}.md`);
    assert.deepEqual(localChangesOn(dir, [...many, 'f1.md', 'f3.md']), {
      staged: ['f3.md'],
      unstaged: ['f1.md'],
    });
  });
  withTmpDir((dir) => {
    assert.deepEqual(localChangesOn(dir, ['a.md', 'b.md', 'c.md'], { chunkSize: 2 }), {
      staged: ['a.md', 'b.md', 'c.md'],
      unstaged: ['a.md', 'b.md', 'c.md'],
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
// Backups of a view live under `.cache/backups/`; the names come back as vault-relative paths.
const backupsIn = (dir, rel) =>
  listDir(join(dir, BACKUP_DIR, dirname(rel)))
    .filter((n) => n.startsWith(`${rel.split('/').at(-1)}.pre-`))
    .map((n) => `${BACKUP_DIR}/${dirname(rel) === '.' ? '' : `${dirname(rel)}/`}${n}`);

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

test('restoreGitignoreLines compares lines without a trailing CR, so a CRLF .gitignore gets no line twice', () => {
  withTmpDir((dir) => {
    put(dir, '.gitignore', '.cache/\r\nlocal-only/\r\n');
    assert.deepEqual(restoreGitignoreLines(dir, ['.cache/', 'local-only/\r']), []);
    assert.equal(readRel(dir, '.gitignore'), '.cache/\r\nlocal-only/\r\n', 'nothing was added');
    assert.deepEqual(restoreGitignoreLines(dir, ['.cache/', 'new/']), ['new/']);
    assert.equal(readRel(dir, '.gitignore'), '.cache/\r\nlocal-only/\r\nnew/\n');
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

// ── view backups live under .cache/backups, and the clearing step re-checks before it moves ──

test('(a) a view backup is made under .cache/backups, never beside the view, and undo restores from there', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    const where = join(b, '.cache/backups/projects/p/hot.md.pre-projection-backup.md');
    assert.equal(r.archived[0].backupPath, where);
    assert.equal(readFileSync(where, 'utf-8'), W1);
    assert.deepEqual(
      listDir(join(b, 'projects/p')).filter((n) => n.includes('.pre-projection-backup')),
      [],
      'nothing beside the view',
    );
    // what a blanket add-all would take: the backup is ignored through .cache/
    assert.equal(
      cgit(b, ['check-ignore', '-q', '.cache/backups/projects/p/hot.md.pre-projection-backup.md'])
        .status,
      0,
    );
    // the merge did not happen: the undo reads the bytes back from the backup
    put(b, 'projects/p/hot.md', OLD_HOT_FILE);
    const undone = undoClearedPaths(b, r);
    assert.deepEqual(undone, { ok: true, notices: [] });
    assert.equal(readRel(b, 'projects/p/hot.md'), W1);
    assert.equal(existsSync(where), false, 'a complete undo removes the backup');
  });
});

test('a vault whose own .gitignore leaves .cache/ out gets no backup or archive: the catch-up defers with a notice, and goes on once .cache/ is ignored', () => {
  withCatchUp(
    ({ b }) => {
      put(b, 'projects/p/hot.md', W1);
      const r = clear(b);
      assert.equal(r.ok, false);
      assert.equal(r.deferred, 'cache-not-ignored');
      assert.match(r.notice, /\/\.cache\//);
      assert.equal(existsSync(join(b, '.cache')), false, 'nothing was written under .cache/');
      assert.equal(readRel(b, 'projects/p/hot.md'), W1, 'the local bytes were not moved');
      cgitOk(b, ['add', '-A']);
      assert.equal(
        cgitOk(b, ['ls-files'])
          .split('\n')
          .some((n) => n.startsWith('.cache/')),
        false,
        'an add-all stages nothing from .cache/',
      );
      // the person fixes the rule (the exclude file does not dirty the tree)
      writeFileSync(join(b, '.git', 'info', 'exclude'), '.cache/\n');
      cgitOk(b, ['reset', '-q']);
      const again = clear(b);
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal(readFileSync(again.archived[0].backupPath, 'utf-8'), W1);
    },
    { seed: { '.gitignore': 'node_modules/\n' } },
  );
});

test('a .gitignore that names only the three probe files is not an ignored .cache/: the catch-up defers, writes no backup, and an add-all stages nothing under .cache/', () => {
  withCatchUp(
    ({ b }) => {
      put(b, 'projects/p/hot.md', W1);
      const r = clear(b);
      assert.equal(r.ok, false);
      assert.equal(r.deferred, 'cache-not-ignored');
      assert.equal(existsSync(join(b, '.cache')), false, 'no backup was made');
      assert.equal(readRel(b, 'projects/p/hot.md'), W1, 'the local bytes were not moved');
      cgitOk(b, ['add', '-A']);
      assert.equal(
        cgitOk(b, ['ls-files'])
          .split('\n')
          .some((n) => n.startsWith('.cache/')),
        false,
      );
    },
    {
      seed: {
        '.gitignore':
          '.cache/backups/probe.md\n.cache/pull-archive.json\n.cache/generated-views.json\n',
      },
    },
  );
});

test('(a) the notices of the generator and of the root hot.md name the backup under .cache/backups', () => {
  withTmpDir((dir) => {
    assert.match(
      rootHotBackupRecoveryNotice(join(dir, '.cache/backups/hot.md.pre-projection-backup.md')),
      /\.cache\/backups\/hot\.md\.pre-projection-backup\.md/,
    );
    seedProjects(dir);
    put(dir, VIEW, 'hand written\n');
    writeGeneratedViews(dir, WRITE);
    assert.match(
      consumeRootHotHealthNotice(dir) ?? '',
      /\.cache\/backups\/projects\/p\/hot\.md\.pre-projection-backup\.md/,
    );
  });
});

test('(b) a view edited after its backup, before the unstage, defers the whole step and keeps the new bytes', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    cgitOk(b, ['add', 'projects/p/hot.md']);
    const r = clear(b, '@{u}', {
      testHooks: { beforeUnstage: () => put(b, 'projects/p/hot.md', 'typed after the backup\n') },
    });
    assert.equal(r.ok, false);
    assert.equal(r.deferred, 'concurrent-change');
    assert.equal(readRel(b, 'projects/p/hot.md'), 'typed after the backup\n');
    assert.equal(
      cgitOk(b, ['diff', '--cached', '--name-only']).trim(),
      'projects/p/hot.md',
      'still staged',
    );
  });
});

test('(b) a view edited after the unstage, before the restore, defers and the restore does not run', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    cgitOk(b, ['add', 'projects/p/hot.md']);
    const r = clear(b, '@{u}', {
      testHooks: { afterArchive: () => put(b, 'projects/p/hot.md', 'typed after the unstage\n') },
    });
    assert.equal(r.ok, false);
    assert.equal(r.deferred, 'concurrent-change');
    assert.equal(
      readRel(b, 'projects/p/hot.md'),
      'typed after the unstage\n',
      'not restored to HEAD',
    );
    // the staged bytes are in the backup and the caller's undo can take them back
    assert.equal(
      r.archived.some((v) => v.kind === 'stage'),
      true,
    );
  });
});

test('(b) an index entry changed after the backup defers too', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b, '@{u}', {
      testHooks: {
        beforeUnstage: () => {
          put(b, 'projects/p/hot.md', W1); // the bytes the backup holds are unchanged
          cgitOk(b, [
            'update-index',
            '--cacheinfo',
            `100644,${cgitOk(b, ['hash-object', '-w', '--stdin']).trim()},projects/p/hot.md`,
          ]);
        },
      },
    });
    assert.equal(r.deferred, 'concurrent-change');
  });
});

test('(b) hypo-auto-stage takes the vault commit lock: with it held the add is skipped, without it the file is staged; a Read never stages', () => {
  withTmpDir((dir) => {
    cgitOk(dir, ['init', '-q']);
    put(dir, 'pages/n.md', 'n\n');
    const hook = new URL('../hooks/hypo-auto-stage.mjs', import.meta.url).pathname;
    const run = (tool = 'Write') =>
      spawnSync(process.execPath, [hook], {
        input: JSON.stringify({
          tool_name: tool,
          tool_input: { file_path: join(dir, 'pages/n.md') },
        }),
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: SESSION_TMP_HOME,
          HYPO_DIR: dir,
          HYPO_VAULT_LOCK_TIMEOUT_MS: '300',
        },
      });
    const staged = () => cgitOk(dir, ['diff', '--cached', '--name-only']).trim();
    const read = run('Read');
    assert.equal(read.status, 0, read.stderr);
    assert.equal(staged(), '', 'a Read left the index alone');
    const held = withFileLock(vaultCommitLockTarget(dir), () => run());
    assert.equal(held.status, 0, held.stderr);
    assert.equal(staged(), '', 'the add waited for the lock, timed out and skipped');
    assert.match(held.stderr, /git add/);
    const free = run();
    assert.equal(free.status, 0, free.stderr);
    assert.equal(staged(), 'pages/n.md');
  });
});

test('(c) a rollback-shaped incoming range counts as touching view tracking, and the local ignored file is backed up, not overwritten', () => {
  withCatchUp(({ b }) => {
    const a = join(dirname(b), 'a');
    cgitOk(b, ['merge', '-q', '--ff-only', '@{u}']); // this machine is migrated: views untracked
    put(b, 'projects/p/hot.md', 'local ignored hot\n');
    assert.equal(
      cgit(b, ['check-ignore', '-q', 'projects/p/hot.md']).status,
      0,
      'the file is ignored here',
    );
    cgitOk(a, ['pull', '-q']);
    put(a, '.gitignore', '.cache/\n');
    put(a, 'projects/p/hot.md', 'rolled back hot\n');
    cgitOk(a, ['add', '-f', '.gitignore', 'projects/p/hot.md']);
    cgitOk(a, ['commit', '-q', '-m', 'rollback']);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['fetch', '-q']);
    assert.equal(upstreamIsMigrated(b), false, 'the old predicate says no: the block is gone');
    assert.equal(incomingChangesViewTracking(b, '@{u}'), true);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.cleared.length, 1);
    assert.equal(readFileSync(r.cleared[0].backupPath, 'utf-8'), 'local ignored hot\n');
    assert.equal(ffTo(b), 0);
    assert.equal(readRel(b, 'projects/p/hot.md'), 'rolled back hot\n');
  });
});

test('(c) a migration range counts too, and a range that adds or removes no view path does not', () => {
  withCatchUp(({ a, b }) => {
    assert.equal(
      incomingChangesViewTracking(b, '@{u}'),
      true,
      'the migration commit untracks the views',
    );
    cgitOk(b, ['merge', '-q', '--ff-only', '@{u}']);
    assert.equal(incomingChangesViewTracking(b, '@{u}'), false, 'nothing incoming');
    put(a, 'pages/x.md', 'changed x\n');
    put(a, 'projects/p/notes.md', 'notes\n');
    commitIn(a);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['fetch', '-q']);
    assert.equal(incomingChangesViewTracking(b, '@{u}'), false, 'only pages and notes change');
  });
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

test('(g) the root hot.md is never turned into a baseline, and its backup is named in a notice', () => {
  withCatchUp(({ b }) => {
    put(b, 'hot.md', 'root edited\n');
    const pre = catchUpAndMerge(b);
    assert.equal(pre.archived.length, 1);
    const before = baselinesOf(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.deepEqual(shared.created, []);
    assert.deepEqual(baselinesOf(b), before);
    // The edit lives only in the backup now; the notice is what tells the user where.
    const backupPath = pre.archived[0].backupPath;
    assert.equal(readFileSync(backupPath, 'utf-8'), 'root edited\n');
    assert.ok(
      shared.notices.some((n) => n === rootHotBackupRecoveryNotice(backupPath)),
      JSON.stringify(shared.notices),
    );
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

// ── moving a vault to the scheme ─────────────────────────────────────────────

suite('session views: migrateVaultToSessionEntries');

const RICH_HOT = `---
title: "hot: p"
type: reference
updated: 2026-09-20
tags: [a, b]
---
## Summary
the old summary

\`\`\`md
## Track: x
\`\`\`
`;
const OLD_SCOPED_STATE = OLD_STATE_FILE.replace(
  'machine_note: keep me',
  'machine_note: keep me\nvisibility_scope: machine:devA',
);
const OLD_PROJECT_FILES = {
  '.gitignore': '.cache/\n',
  'hot.md': 'root hot\n',
  'projects/p/index.md': '---\ntitle: p\n---\n',
  'projects/p/hot.md': RICH_HOT,
  'projects/p/session-state.md': OLD_STATE_FILE,
  'projects/p/platform/hot.md': 'platform hot\n',
  'projects/p/platform/session-state.md': 'platform state\n',
  'projects/_template/hot.md': 'template hot\n',
  'projects/_template/session-state.md': 'template state\n',
  'pages/x.md': 'x\n',
};

// One vault with the old tracked files, in a git environment with an identity (the code under test
// makes commits itself).
function withOldGit(fn, extra = {}) {
  inCatchUpEnv(() =>
    withTmpDir((dir) => {
      cgitOk(dir, ['init', '-q']);
      for (const [rel, text] of Object.entries({ ...OLD_PROJECT_FILES, ...extra })) {
        if (text !== null) put(dir, rel, text);
      }
      commitIn(dir);
      fn(dir);
    }),
  );
}

// Two clones `a` and `b` of one origin, both at the old state.
function withOldClones(fn, extra = {}) {
  inCatchUpEnv(() =>
    withTmpDir((root) => {
      const origin = join(root, 'origin.git');
      const a = join(root, 'a');
      const b = join(root, 'b');
      cgitOk(root, ['init', '-q', '--bare', origin]);
      cgitOk(root, ['clone', '-q', origin, a]);
      for (const [rel, text] of Object.entries({ ...OLD_PROJECT_FILES, ...extra }))
        put(a, rel, text);
      commitIn(a);
      cgitOk(a, ['push', '-q', '-u', 'origin', 'main']);
      cgitOk(root, ['clone', '-q', origin, b]);
      fn({ a, b, root });
    }),
  );
}

const treeNames = (dir, rev = 'HEAD') =>
  cgitOk(dir, ['ls-tree', '-r', '--name-only', rev]).split('\n').filter(Boolean);
const showHead = (dir, rel) => cgitOk(dir, ['show', `HEAD:${rel}`]);
const changedBy = (dir, rev = 'HEAD') =>
  cgitOk(dir, ['diff-tree', '--no-commit-id', '--name-status', '-r', rev])
    .trim()
    .split('\n')
    .sort();
const entryOf = (dir, rel) => parseSessionEntry(readRel(dir, rel)).entry;
const countOf = (text, needle) => text.split(needle).length - 1;
const migrate = (dir, opts = {}) => migrateVaultToSessionEntries(dir, opts);

test('the move untracks the generated views, adds one baseline and both blocks, and keeps the rest as it was', () => {
  withOldGit((dir) => {
    const before = commitCount(dir);
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    assert.equal(r.skipped, null);
    assert.equal(r.commit, headOf(dir));
    assert.equal(commitCount(dir), before + 1);
    assert.equal(migrationState(dir), 'migrated');
    assert.deepEqual(listTrackedGeneratedViews(dir, { source: 'head' }), []);
    assert.deepEqual(listTrackedGeneratedViews(dir), []);
    assert.equal(r.baselines.length, 1, 'one project, one baseline');
    assert.match(r.baselines[0], /^projects\/p\/sessions\/2026-09-25-baseline-[0-9a-f]{16}\.md$/);
    assert.deepEqual(
      changedBy(dir),
      [
        'A\t.gitattributes',
        `A\t${r.baselines[0]}`,
        'D\thot.md',
        'D\tprojects/p/hot.md',
        'D\tprojects/p/session-state.md',
        'M\t.gitignore',
      ].sort(),
    );
    // the nested track pages are not generated paths: still tracked, same bytes
    assert.equal(showHead(dir, 'projects/p/platform/hot.md'), 'platform hot\n');
    assert.equal(showHead(dir, 'projects/p/platform/session-state.md'), 'platform state\n');
    assert.equal(showHead(dir, '.gitignore'), `.cache/\n${GITIGNORE_BLOCK}`);
    assert.equal(showHead(dir, '.gitattributes'), GITATTRIBUTES_BLOCK);
    for (const gone of ['hot.md', 'projects/p/hot.md', 'projects/p/session-state.md']) {
      assert.equal(existsSync(join(dir, gone)), false, `${gone} left the working tree`);
    }
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
  });
});

test('the baseline holds both old files whole: a fenced track heading, machine_note and tags survive', () => {
  withOldGit((dir) => {
    const [rel] = migrate(dir).baselines;
    const entry = entryOf(dir, rel);
    assert.equal(entry.summary, RICH_HOT);
    assert.equal(entry.bodies[LEGACY_TRACK_ID], OLD_STATE_FILE);
    assert.match(entry.bodies[LEGACY_TRACK_ID], /machine_note: keep me/);
    assert.equal(entry.tracks[0].id, LEGACY_TRACK_ID);
  });
});

test('projects/_template is not part of the move: both files stay tracked, unchanged on disk and out of the commit', () => {
  withOldGit((dir) => {
    migrate(dir);
    for (const f of ['hot.md', 'session-state.md']) {
      assert.ok(treeNames(dir).includes(`projects/_template/${f}`));
      assert.equal(
        readRel(dir, `projects/_template/${f}`),
        f === 'hot.md' ? 'template hot\n' : 'template state\n',
      );
    }
    assert.equal(
      changedBy(dir).filter((l) => l.includes('_template')).length,
      0,
      'the move commit does not touch _template',
    );
    assert.equal(existsSync(join(dir, 'projects/_template/sessions')), false, 'no baseline for it');
  });
});

test('a machine with a local edit of _template/hot.md is not blocked from taking the move (not other-dirty)', () => {
  withOldClones(({ a, b }) => {
    migrate(a);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['fetch', '-q']);
    put(b, 'projects/_template/hot.md', 'my template edit\n');
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(ffTo(b), 0);
    assert.equal(readRel(b, 'projects/_template/hot.md'), 'my template edit\n');
  });
});

test('.gitattributes: only the block when HEAD had none, never twice, and a hand-written line stays', () => {
  withOldGit((dir) => {
    migrate(dir);
    assert.equal(showHead(dir, '.gitattributes'), GITATTRIBUTES_BLOCK);
  });
  withOldGit(
    (dir) => {
      migrate(dir);
      assert.equal(
        showHead(dir, '.gitattributes'),
        GITATTRIBUTES_BLOCK,
        'already there: untouched',
      );
    },
    { '.gitattributes': GITATTRIBUTES_BLOCK },
  );
  withOldGit(
    (dir) => {
      migrate(dir);
      assert.equal(showHead(dir, '.gitattributes'), `log.md merge=union\n${GITATTRIBUTES_BLOCK}`);
    },
    { '.gitattributes': 'log.md merge=union\n' },
  );
});

test('.gitignore: the block goes in once, and not again when HEAD already has it', () => {
  withOldGit((dir) => {
    migrate(dir);
    assert.equal(countOf(showHead(dir, '.gitignore'), GITIGNORE_BLOCK.split('\n')[0]), 1);
  });
  withOldGit(
    (dir) => {
      migrate(dir);
      assert.equal(showHead(dir, '.gitignore'), `.cache/\n${GITIGNORE_BLOCK}`);
    },
    { '.gitignore': `.cache/\n${GITIGNORE_BLOCK}` },
  );
});

test('a second run makes no commit and leaves HEAD alone, which is also the state after a failed push', () => {
  withOldGit((dir) => {
    migrate(dir);
    const head = headOf(dir);
    const count = commitCount(dir);
    const again = migrate(dir);
    assert.equal(again.migrated, true);
    assert.equal(again.skipped, 'already-migrated');
    assert.equal(again.commit, null);
    assert.equal(headOf(dir), head);
    assert.equal(commitCount(dir), count);
  });
});

test('a file another session staged and a .gitignore line not yet committed stay out of the commit, and stay', () => {
  withOldGit((dir) => {
    put(dir, 'pages/new.md', 'new\n');
    cgitOk(dir, ['add', 'pages/new.md']);
    put(dir, '.gitignore', '.cache/\nlocal-only/\n');
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    assert.equal(
      treeNames(dir).includes('pages/new.md'),
      false,
      'the staged file is not in the commit',
    );
    assert.equal(cgitOk(dir, ['diff', '--cached', '--name-only']).trim(), 'pages/new.md');
    assert.equal(showHead(dir, '.gitignore').includes('local-only/'), false);
    assert.equal(readRel(dir, '.gitignore'), `.cache/\n${GITIGNORE_BLOCK}local-only/\n`);
    assert.equal(
      existsSync(join(dir, '.cache/pull-archive.json')),
      false,
      'the archive record is gone',
    );
  });
});

test('the old hot.md scope goes into the baseline and index.md is not changed', () => {
  withOldGit(
    (dir) => {
      const before = showHead(dir, 'projects/p/index.md');
      const r = migrate(dir);
      assert.equal(entryOf(dir, r.baselines[0]).visibilityScope, 'machine:devA');
      assert.equal(showHead(dir, 'projects/p/index.md'), before);
      assert.equal(
        changedBy(dir).some((l) => l.endsWith('index.md')),
        false,
      );
    },
    { 'projects/p/hot.md': OLD_HOT_FILE },
  );
});

test('scope: index.md machine:devA beats a shared hot.md quietly; a scope only the old state file has is carried with a notice; two machines close it', () => {
  withOldGit(
    (dir) => {
      const r = migrate(dir);
      assert.equal(entryOf(dir, r.baselines[0]).visibilityScope, 'machine:devA');
      assert.equal(
        r.notices.some((n) => n.includes('범위를 이어받습니다')),
        false,
      );
    },
    { 'projects/p/index.md': '---\ntitle: p\nvisibility_scope: machine:devA\n---\n' },
  );
  withOldGit(
    (dir) => {
      const index = showHead(dir, 'projects/p/index.md');
      const r = migrate(dir);
      assert.equal(entryOf(dir, r.baselines[0]).visibilityScope, 'machine:devA');
      assert.equal(showHead(dir, 'projects/p/index.md'), index, 'index.md bytes are untouched');
      assert.ok(
        r.notices.some(
          (n) => n.includes('옛 파일의 범위를 이어받습니다') && n.includes('machine:devA'),
        ),
      );
      // a close of this project now takes the carried scope (the T7 path asks projectEntryScope)
      assert.equal(projectEntryScope(dir, 'p'), 'machine:devA');
    },
    {
      'projects/p/index.md': '---\ntitle: p\nvisibility_scope: shared\n---\n',
      'projects/p/session-state.md': OLD_SCOPED_STATE,
    },
  );
  withOldGit(
    (dir) => {
      const r = migrate(dir);
      assert.equal(entryOf(dir, r.baselines[0]).visibilityScope, 'machine:');
      assert.ok(r.notices.some((n) => n.includes('machine:')));
    },
    {
      'projects/p/index.md': '---\ntitle: p\nvisibility_scope: machine:devB\n---\n',
      'projects/p/hot.md': OLD_HOT_FILE,
    },
  );
});

test('two clones that move on their own clocks and then pull each other agree: no conflict, one baseline', () => {
  withOldClones(({ a, b }) => {
    migrate(a, { testHooks: { now: new Date('2026-10-01T09:00:00Z') } });
    migrate(b, { testHooks: { now: new Date('2026-10-01T09:01:00Z') } });
    assert.notEqual(headOf(a), headOf(b), 'two distinct move commits');
    cgitOk(a, ['push', '-q']);
    const pulled = cgit(b, ['pull', '--no-rebase', '--no-edit']);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.equal(unmerged(b), '');
    assert.equal(baselinesOf(b).length, 1);
    cgitOk(b, ['push', '-q']);
    const back = cgit(a, ['pull', '--no-rebase', '--no-edit']);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(unmerged(a), '');
    assert.equal(baselinesOf(a).length, 1);
  });
});

test('two clones that read different scopes make two baselines and no index.md conflict', () => {
  withOldClones(
    ({ a, b }) => {
      put(b, 'projects/p/hot.md', OLD_HOT_FILE.replace('machine:devA', 'machine:devB'));
      commitIn(b);
      const ra = migrate(a);
      const rb = migrate(b);
      for (const r of [ra, rb]) assert.equal(r.migrated, true, JSON.stringify(r));
      for (const [dir, head] of [
        [a, 'a'],
        [b, 'b'],
      ]) {
        assert.equal(
          changedBy(dir).some((l) => l.endsWith('index.md')),
          false,
          `the move commit of ${head} leaves index.md alone`,
        );
      }
      cgitOk(a, ['push', '-q']);
      const pulled = cgit(b, ['pull', '--no-rebase', '--no-edit']);
      assert.equal(pulled.status, 0, pulled.stderr);
      assert.equal(unmerged(b), '');
      cgitOk(b, ['push', '-q']);
      const back = cgit(a, ['pull', '--no-rebase', '--no-edit']);
      assert.equal(back.status, 0, back.stderr);
      assert.equal(unmerged(a), '');
      const scopes = baselinesOf(a).map(
        (n) => entryOf(a, `projects/p/sessions/${n}`).visibilityScope,
      );
      assert.deepEqual(scopes.sort(), ['machine:', 'machine:devA']);
      assert.equal(
        showHead(a, 'projects/p/index.md'),
        '---\ntitle: p\nvisibility_scope: shared\n---\n',
      );
    },
    {
      'projects/p/index.md': '---\ntitle: p\nvisibility_scope: shared\n---\n',
      'projects/p/hot.md': RICH_HOT,
      'projects/p/session-state.md': OLD_SCOPED_STATE,
    },
  );
});

test('a project .hypoignore hides gets no baseline; its old files are kept locally and the notice names them', () => {
  withOldGit(
    (dir) => {
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      assert.deepEqual(
        r.baselines.map((b) => b.split('/')[1]),
        ['p'],
      );
      assert.equal(existsSync(join(dir, 'projects/secret/sessions')), false);
      for (const f of ['hot.md', 'session-state.md']) {
        assert.equal(existsSync(join(dir, `projects/secret/${f}`)), false, 'the move removed it');
        const kept = backupsIn(dir, `projects/secret/${f}`);
        assert.equal(kept.length, 1, `${f} has a local backup`);
        assert.equal(readRel(dir, kept[0]), f === 'hot.md' ? 'secret hot\n' : 'secret state\n');
        assert.ok(r.notices.some((n) => n.includes(kept[0])));
      }
      assert.equal(
        backupsIn(dir, 'projects/p/hot.md').length,
        0,
        'a project that is not hidden needs none',
      );
    },
    {
      '.hypoignore': 'projects/secret/hot.md\n',
      'projects/secret/index.md': '---\ntitle: secret\n---\n',
      'projects/secret/hot.md': 'secret hot\n',
      'projects/secret/session-state.md': 'secret state\n',
    },
  );
});

test('an off marker in HEAD stops every automatic move; reenable removes the marker in the one move commit', () => {
  withOldGit(
    (dir) => {
      const head = headOf(dir);
      assert.equal(migrationState(dir), 'opted-out');
      const off = migrate(dir);
      assert.equal(off.migrated, false);
      assert.equal(off.skipped, 'opted-out');
      assert.equal(headOf(dir), head);
      const count = commitCount(dir);
      const on = migrate(dir, { reenable: true });
      assert.equal(on.migrated, true, JSON.stringify(on));
      assert.equal(commitCount(dir), count + 1);
      assert.equal(treeNames(dir).includes(SESSION_ENTRIES_OFF_MARKER), false);
      assert.equal(migrationState(dir), 'migrated');
    },
    { [SESSION_ENTRIES_OFF_MARKER]: '' },
  );
});

test('a view staged as S and edited to W: both go to backups and out as additional baselines, the index ends clean', () => {
  withOldGit((dir) => {
    const S = RICH_HOT.replace('the old summary', 'staged S');
    const W = RICH_HOT.replace('the old summary', 'worktree W');
    put(dir, 'projects/p/hot.md', S);
    cgitOk(dir, ['add', 'projects/p/hot.md']);
    put(dir, 'projects/p/hot.md', W);
    const before = commitCount(dir);
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    assert.equal(commitCount(dir), before + 2, 'the move, then the additional baselines');
    assert.deepEqual(
      backupsIn(dir, 'projects/p/hot.md')
        .map((n) => readRel(dir, n))
        .sort(),
      [S, W].sort(),
    );
    assert.equal(r.shared.length, 2);
    assert.deepEqual(r.shared.map((rel) => entryOf(dir, rel).summary).sort(), [S, W].sort());
    assert.equal(baselinesOf(dir).length, 3);
    assert.equal(cgitOk(dir, ['diff', '--cached', '--name-only']).trim(), '');
  });
});

test('a local edit of the old hot.md: the move baseline has the HEAD bytes, the edit is a second baseline and a backup', () => {
  withOldGit((dir) => {
    const W = RICH_HOT.replace('the old summary', 'uncommitted edit');
    put(dir, 'projects/p/hot.md', W);
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    assert.equal(entryOf(dir, r.baselines[0]).summary, RICH_HOT);
    assert.equal(r.shared.length, 1);
    assert.equal(entryOf(dir, r.shared[0]).summary, W);
    assert.deepEqual(
      backupsIn(dir, 'projects/p/hot.md').map((n) => readRel(dir, n)),
      [W],
    );
  });
});

test('a legacy update the old scheme already marked done keeps legacy folded after the old file changed', () => {
  const doneEntry = {
    closeId: 'c-done',
    date: '2026-09-30',
    tracks: [{ id: LEGACY_TRACK_ID, done: true }],
    bodies: { [LEGACY_TRACK_ID]: 'wrapped up\n' },
  };
  withOldGit(
    (dir) => {
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      const legacy = trackHeads(loadSessionModel(dir, 'p').entries).find(
        (t) => t.trackId === LEGACY_TRACK_ID,
      );
      assert.equal(legacy.done, true, 'finished: a one-line track, not an active head');
    },
    {
      [`projects/p/sessions/${entryFileName('2026-09-30', 'c-done')}`]: entryFile(
        'c-done',
        doneEntry,
      ),
    },
  );
  withOldGit((dir) => {
    migrate(dir);
    const legacy = trackHeads(loadSessionModel(dir, 'p').entries).find(
      (t) => t.trackId === LEGACY_TRACK_ID,
    );
    assert.equal(legacy.done, false, 'without a done update it is an active head');
  });
});

test('a vault below the repository root moves under its own prefix and the root stays as it was', () => {
  inCatchUpEnv(() =>
    withTmpDir((root) => {
      cgitOk(root, ['init', '-q']);
      put(root, '.gitignore', 'ROOT\n');
      put(root, 'README.md', 'r\n');
      const vault = join(root, 'wiki');
      for (const [rel, text] of Object.entries(OLD_PROJECT_FILES)) put(vault, rel, text);
      commitIn(root);
      const r = migrate(vault);
      assert.equal(r.migrated, true, JSON.stringify(r));
      const names = treeNames(root);
      assert.ok(names.includes(`wiki/${r.baselines[0]}`), 'the baseline is under wiki/');
      for (const gone of [
        'wiki/hot.md',
        'wiki/projects/p/hot.md',
        'wiki/projects/p/session-state.md',
      ]) {
        assert.equal(names.includes(gone), false, `${gone} is untracked`);
      }
      assert.equal(showHead(root, 'wiki/.gitignore'), `.cache/\n${GITIGNORE_BLOCK}`);
      assert.equal(showHead(root, 'wiki/.gitattributes'), GITATTRIBUTES_BLOCK);
      assert.equal(
        showHead(root, '.gitignore'),
        'ROOT\n',
        'the root .gitignore is not the vault one',
      );
      assert.deepEqual(
        cgitOk(root, ['ls-tree', '--name-only', 'HEAD']).trim().split('\n'),
        ['.gitignore', 'README.md', 'wiki'],
        'nothing new at the repository root',
      );
      const count = commitCount(root);
      assert.equal(migrate(vault).skipped, 'already-migrated');
      assert.equal(commitCount(root), count);
    }),
  );
});

test('stopping once the commit object exists changes nothing, leaves no temporary index, and the next run makes one commit', () => {
  withOldGit((dir) => {
    const snapshot = () => ({
      head: headOf(dir),
      index: cgitOk(dir, ['ls-files', '-s']),
      status: cgitOk(dir, ['status', '--porcelain']),
      hot: readRel(dir, 'projects/p/hot.md'),
    });
    const before = snapshot();
    const count = commitCount(dir);
    const tmp = mkdtempSync(join(SESSION_TMP_HOME, 'tmpdir-'));
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    let made = null;
    try {
      assert.throws(
        () =>
          migrate(dir, {
            testHooks: {
              afterBuildCommit: (sha) => {
                made = sha;
                assert.equal(
                  readdirSync(tmp).length,
                  1,
                  'the temporary index exists at this point',
                );
                throw new Error('stop here');
              },
            },
          }),
        /stop here/,
      );
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    assert.equal(
      cgitOk(dir, ['cat-file', '-t', made]).trim(),
      'commit',
      'the commit object was made',
    );
    assert.deepEqual(readdirSync(tmp), [], 'no temporary index left');
    assert.deepEqual(snapshot(), before);
    assert.equal(migrationState(dir), 'not-migrated');
    assert.equal(cgitOk(dir, ['worktree', 'list']).trim().split('\n').length, 1);
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    assert.equal(commitCount(dir), count + 1);
  });
});

test('fastForwardTo applies nothing when HEAD moved after the commit was built', () => {
  withOldGit((dir) => {
    const built = buildCommitInTempIndex(dir, {
      message: 'm',
      writes: [{ relPath: '.gitignore', text: `.cache/\n${GITIGNORE_BLOCK}` }],
      deletes: ['hot.md'],
    });
    assert.equal(built.ok, true, JSON.stringify(built));
    put(dir, 'pages/y.md', 'y\n');
    commitIn(dir);
    const head = headOf(dir);
    const r = fastForwardTo(dir, built.sha);
    assert.equal(r.ok, false);
    assert.match(r.reason, /^fast-forward-failed/);
    assert.equal(headOf(dir), head);
    assert.equal(readRel(dir, 'hot.md'), 'root hot\n');
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
  });
});

// What a person can see of a vault: the files, both diffs, the status and the archive record.
const vaultSnapshot = (dir, rels) => ({
  files: Object.fromEntries(rels.map((rel) => [rel, readRel(dir, rel)])),
  diff: cgitOk(dir, ['diff']),
  cached: cgitOk(dir, ['diff', '--cached']),
  status: cgitOk(dir, ['status', '--porcelain']),
  record: existsSync(join(dir, '.cache/pull-archive.json')),
});

test('a merge that fails puts back what the clearing step moved: working-tree and staged bytes, no backup left, no record', () => {
  withOldGit((dir) => {
    const stateEdit = (what) => `${OLD_STATE_FILE}${what}\n`;
    put(dir, 'projects/p/hot.md', `${RICH_HOT}edited in the working tree\n`);
    put(dir, 'projects/p/session-state.md', stateEdit('staged'));
    cgitOk(dir, ['add', 'projects/p/session-state.md']);
    put(dir, 'projects/p/session-state.md', stateEdit('edited after staging'));
    // The move adds .gitattributes; an untracked one in the way makes the fast-forward fail.
    put(dir, '.gitattributes', 'mine\n');
    const rels = ['projects/p/hot.md', 'projects/p/session-state.md', 'hot.md', '.gitattributes'];
    const before = vaultSnapshot(dir, rels);
    assert.match(before.cached, /\+staged/);
    assert.match(before.diff, /\+edited after staging/);
    const head = headOf(dir);
    const r = migrate(dir);
    assert.equal(r.migrated, false);
    assert.match(r.deferred, /^fast-forward-failed/);
    assert.match(r.notices.join('\n'), /\.gitattributes/, 'git names the file in the way');
    assert.equal(headOf(dir), head);
    assert.deepEqual(vaultSnapshot(dir, rels), before);
    assert.deepEqual(backupsIn(dir, 'projects/p/hot.md'), []);
    assert.equal(backupsIn(dir, 'hot.md').length, 0, 'the root copy goes too');
    // with the file out of the way the same vault moves, and the edits are kept as before
    unlinkSync(join(dir, '.gitattributes'));
    const again = migrate(dir);
    assert.equal(again.migrated, true, JSON.stringify(again));
    assert.equal(backupsIn(dir, 'projects/p/hot.md').length, 1);
  });
});

test('a vault lock held elsewhere defers the move: lock-timeout, and HEAD, the index and the files are as they were', () => {
  withOldGit((dir) => {
    const S = RICH_HOT.replace('the old summary', 'staged S');
    const W = RICH_HOT.replace('the old summary', 'worktree W');
    put(dir, 'projects/p/hot.md', S);
    cgitOk(dir, ['add', 'projects/p/hot.md']);
    put(dir, 'projects/p/hot.md', W);
    put(dir, 'projects/p/session-state.md', `${OLD_STATE_FILE}edited\n`);
    const rels = ['projects/p/hot.md', 'projects/p/session-state.md', 'hot.md', '.gitignore'];
    const state = () => ({
      ...vaultSnapshot(dir, rels),
      head: headOf(dir),
      index: cgitOk(dir, ['ls-files', '-s']),
    });
    const before = state();
    const saved = process.env.HYPO_VAULT_LOCK_TIMEOUT_MS;
    process.env.HYPO_VAULT_LOCK_TIMEOUT_MS = '100';
    let r;
    try {
      withFileLock(vaultCommitLockTarget(dir), () => {
        r = migrate(dir);
      });
    } finally {
      if (saved === undefined) delete process.env.HYPO_VAULT_LOCK_TIMEOUT_MS;
      else process.env.HYPO_VAULT_LOCK_TIMEOUT_MS = saved;
    }
    assert.equal(r.migrated, false, JSON.stringify(r));
    assert.equal(r.deferred, 'lock-timeout');
    assert.deepEqual(state(), before);
    assert.deepEqual(backupsIn(dir, 'projects/p/hot.md'), []);
    // the lock released, the same vault moves
    assert.equal(migrate(dir).migrated, true);
  });
});

test('a vault below the repository root: a staged view edit is backed up by the clearing step and comes back exactly when the merge fails', () => {
  inCatchUpEnv(() =>
    withTmpDir((root) => {
      cgitOk(root, ['init', '-q']);
      put(root, 'README.md', 'r\n');
      const vault = join(root, 'wiki');
      for (const [rel, text] of Object.entries(OLD_PROJECT_FILES)) put(vault, rel, text);
      commitIn(root);
      const S = RICH_HOT.replace('the old summary', 'staged S');
      const W = RICH_HOT.replace('the old summary', 'worktree W');
      put(vault, 'projects/p/hot.md', S);
      cgitOk(root, ['add', 'wiki/projects/p/hot.md']);
      put(vault, 'projects/p/hot.md', W);
      // The move adds .gitattributes; an untracked one in the way makes the fast-forward fail.
      put(vault, '.gitattributes', 'mine\n');
      const staged = () => cgitOk(root, ['show', ':wiki/projects/p/hot.md']);
      const state = () => ({
        index: cgitOk(root, ['ls-files', '-s']),
        work: readRel(vault, 'projects/p/hot.md'),
        status: cgitOk(root, ['status', '--porcelain']),
        head: headOf(root),
      });
      assert.equal(staged(), S, 'precondition: the index holds S');
      const before = state();
      const r = migrate(vault);
      assert.match(r.deferred ?? '', /^fast-forward-failed/, JSON.stringify(r));
      assert.deepEqual(state(), before);
      assert.equal(staged(), S);
      assert.deepEqual(backupsIn(vault, 'projects/p/hot.md'), [], 'the undo took its backups away');
      // with the file out of the way the same vault moves: both versions were captured
      unlinkSync(join(vault, '.gitattributes'));
      const again = migrate(vault);
      assert.equal(again.migrated, true, JSON.stringify(again));
      assert.deepEqual(
        backupsIn(vault, 'projects/p/hot.md')
          .map((n) => readRel(vault, n))
          .sort(),
        [S, W].sort(),
      );
      assert.equal(again.shared.length, 2);
    }),
  );
});

test('undoClearedPaths does not overwrite a path written since, keeps its backup and the record, and says so', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true);
    put(b, 'projects/p/hot.md', 'saved by someone else\n');
    const undone = undoClearedPaths(b, r);
    assert.equal(undone.ok, false);
    assert.match(undone.notices.join('\n'), /projects\/p\/hot\.md/);
    assert.match(
      undone.notices.join('\n'),
      new RegExp(r.backups[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    assert.equal(readRel(b, 'projects/p/hot.md'), 'saved by someone else\n');
    assert.equal(readFileSync(r.backups[0], 'utf-8'), W1);
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), true);
  });
});

test('undoClearedPaths does not replace an index entry staged since', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    cgitOk(b, ['add', 'projects/p/hot.md']);
    put(b, 'projects/p/hot.md', W2);
    const r = clear(b);
    assert.equal(r.ok, true);
    put(b, 'projects/p/hot.md', 'staged by someone else\n');
    cgitOk(b, ['add', 'projects/p/hot.md']);
    const undone = undoClearedPaths(b, r);
    assert.equal(undone.ok, false);
    assert.equal(cgitOk(b, ['show', ':projects/p/hot.md']), 'staged by someone else\n');
    for (const { backupPath } of r.archived) assert.equal(existsSync(backupPath), true);
  });
});

test('undoClearedPaths puts a staged path back with the vault prefix, in a vault below the repository root', () => {
  withVault({}, (repo) => {
    const vault = join(repo, 'vault');
    put(repo, 'vault/projects/p/hot.md', 'base\n');
    commitAll(repo);
    const backupPath = join(vault, 'projects/p/hot.md.pre-projection-backup.md');
    put(vault, 'projects/p/hot.md.pre-projection-backup.md', 'staged bytes\n');
    // the state the clearing step leaves: stage released, tree at HEAD
    const cleared = {
      archived: [{ relPath: 'projects/p/hot.md', kind: 'stage', backupPath }],
      localOnly: [],
      unowned: [],
    };
    const undone = undoClearedPaths(vault, cleared);
    assert.deepEqual(undone, { ok: true, notices: [] });
    assert.equal(git(repo, ['show', ':vault/projects/p/hot.md']).stdout, 'staged bytes\n');
    assert.equal(readRel(vault, 'projects/p/hot.md'), 'base\n', 'the working tree is untouched');
    assert.equal(existsSync(backupPath), false);
  });
});

test('undoClearedPaths puts bytes back in a core.autocrlf=true clone, where the checkout of HEAD has CRLF', () => {
  withCatchUp(({ b }) => {
    cgitOk(b, ['config', 'core.autocrlf', 'true']);
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(readRel(b, 'projects/p/hot.md').includes('\r\n'), 'the restore left CRLF behind');
    const undone = undoClearedPaths(b, r);
    assert.deepEqual(undone, { ok: true, notices: [] });
    assert.equal(readRel(b, 'projects/p/hot.md'), W1);
    assert.equal(existsSync(r.backups[0]), false);
  });
});

test('a clean CRLF root hot.md that the generator vouches for gets no backup in a core.autocrlf=true clone', () => {
  withCatchUp(({ b }) => {
    cgitOk(b, ['config', 'core.autocrlf', 'true']);
    unlinkSync(join(b, 'hot.md'));
    cgitOk(b, ['checkout', '--', 'hot.md']); // what git itself writes under autocrlf
    assert.equal(readRel(b, 'hot.md'), 'root hot\r\n');
    assert.equal(cgitOk(b, ['status', '--porcelain', '--', 'hot.md']), '', 'git sees it clean');
    put(
      b,
      '.cache/generated-views.json',
      JSON.stringify({ views: { 'hot.md': sha('root hot\n') } }),
    );
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.unowned, []);
    assert.deepEqual(backupsIn(b, 'hot.md'), []);
    // bytes nobody vouches for still get their copy, whatever the line ending
    put(b, '.cache/generated-views.json', JSON.stringify({ views: {} }));
    const other = clear(b);
    assert.equal(other.unowned.length, 1);
    assert.equal(readFileSync(other.unowned[0].backupPath, 'utf-8'), 'root hot\r\n');
  });
});

test('a stop that comes after the backups reports everything it moved, and the move is undone', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    // The backup directories exist and `.cache` itself is read-only: the backups are written, the
    // archive record (a new file in `.cache`) cannot be.
    mkdirSync(join(b, '.cache/backups/projects/p'), { recursive: true });
    chmodSync(join(b, '.cache'), 0o555);
    let r;
    try {
      r = fastForwardTo(b, '@{u}');
    } finally {
      chmodSync(join(b, '.cache'), 0o755);
    }
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'archive-write-failed');
    assert.equal(r.pre.archived.length, 1);
    assert.equal(r.pre.backups.length, 1);
    assert.equal(r.pre.unowned.length, 1, 'the root hot.md copy is reported too');
    assert.equal(existsSync(r.pre.backups[0]), false, 'the backup is taken back');
    assert.equal(existsSync(r.pre.unowned[0].backupPath), false);
    assert.equal(readRel(b, 'projects/p/hot.md'), W1);
    assert.equal(readRel(b, 'hot.md'), 'root hot\n');
  });
});

test('a path the target adds as tracked and the clearing step removed comes back when the merge fails', () => {
  withCatchUp(({ a, b }) => {
    cgitOk(a, ['pull', '-q']);
    put(a, 'projects/p/hot.md', 'rolled back hot\n');
    cgitOk(a, ['add', '-f', 'projects/p/hot.md']);
    cgitOk(a, ['commit', '-q', '-m', 'rollback']);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['pull', '-q', '--ff-only']);
    cgitOk(b, ['rm', '-q', '--cached', '-f', 'projects/p/hot.md']);
    cgitOk(b, ['reset', '-q', '--hard', 'HEAD~1']);
    put(b, 'projects/p/hot.md', 'local generated hot\n');
    const r = fastForwardTo(b, 'origin/main', {
      // a held index lock makes the merge fail after the clearing step is done
      testHooks: { afterArchive: () => put(b, '.git/index.lock', '') },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^fast-forward-failed/);
    assert.equal(r.pre.cleared.length, 1);
    assert.equal(r.pre.cleared[0].relPath, 'projects/p/hot.md');
    assert.equal(r.pre.archived.length, 0, 'a cleared file is never a baseline candidate');
    assert.equal(readRel(b, 'projects/p/hot.md'), 'local generated hot\n');
    assert.equal(existsSync(r.pre.cleared[0].backupPath), false);
  });
});

test('a stop puts the set-aside .gitignore lines back before it reports', () => {
  withCatchUp(({ b }) => {
    put(b, '.gitignore', '.cache/\nlocal-only/\n');
    const r = fastForwardTo(b, '@{u}', {
      testHooks: {
        // something reset .gitignore after its lines were set aside: the re-check stops the run
        afterArchive: () => put(b, '.gitignore', '.cache/\n'),
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'changed-during-clear');
    assert.deepEqual(r.pre.gitignoreLines, ['local-only/']);
    assert.equal(readRel(b, '.gitignore'), '.cache/\nlocal-only/\n');
  });
});

test('a checkout that fails keeps the set-aside .gitignore lines in the result and in the file', () => {
  withCatchUp(({ b }) => {
    put(b, '.gitignore', '.cache/\nlocal-only/\n');
    const r = fastForwardTo(b, '@{u}', {
      // the index is held, so the checkout stops the run
      testHooks: { afterArchive: () => put(b, '.git/index.lock', '') },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'checkout-failed');
    assert.deepEqual(r.pre.gitignoreLines, ['local-only/']);
    assert.equal(readRel(b, '.gitignore'), '.cache/\nlocal-only/\n');
  });
});

test('a user .gitignore rule that hides projects/*/sessions/ defers the move and touches nothing', () => {
  withOldGit(
    (dir) => {
      const head = headOf(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'sessions-ignored');
      assert.match(r.notices[0], /^이행을 다음 세션으로 미뤘습니다/);
      assert.match(r.notices[0], /projects\/p\/sessions\//);
      assert.equal(headOf(dir), head);
      assert.equal(migrationState(dir), 'not-migrated');
      assert.equal(readRel(dir, 'projects/p/hot.md'), RICH_HOT);
      assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
      // the rule gone, the move goes through
      put(dir, '.gitignore', '.cache/\n');
      commitIn(dir);
      assert.equal(migrate(dir).migrated, true);
    },
    { '.gitignore': '.cache/\nsessions/\n' },
  );
});

test('a rule hiding the sessions/ of any visible project defers the move, and the notice names each one', () => {
  const extra = {
    'projects/q/index.md': '---\ntitle: q\n---\n',
    'projects/q/hot.md': OLD_HOT_FILE,
    'projects/q/session-state.md': OLD_STATE_FILE,
    'projects/r/index.md': '---\ntitle: r\n---\n',
    'projects/r/hot.md': OLD_HOT_FILE,
    'projects/r/session-state.md': OLD_STATE_FILE,
  };
  withOldGit(
    (dir) => {
      const head = headOf(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'sessions-ignored');
      assert.match(r.notices[0], /projects\/q\/sessions\//);
      assert.match(r.notices[0], /projects\/r\/sessions\//);
      assert.doesNotMatch(r.notices[0], /projects\/p\/sessions\//, 'p is not covered');
      assert.equal(headOf(dir), head);
      assert.equal(migrationState(dir), 'not-migrated');
      // a covered project that .hypoignore hides gets no entries, so its rule does not matter
      put(dir, '.hypoignore', 'projects/q/hot.md\nprojects/r/hot.md\n');
      assert.equal(migrate(dir).migrated, true);
    },
    { ...extra, '.gitignore': '.cache/\nprojects/q/sessions/\nprojects/r/sessions/\n' },
  );
});

test('the root hot.md the merge deletes: hand-written bytes get a backup and a notice, bytes this machine wrote do not', () => {
  withOldGit((dir) => {
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    const [backup] = backupsIn(dir, 'hot.md');
    assert.equal(readRel(dir, backup), 'root hot\n', 'the same bytes the file had');
    assert.ok(
      r.notices.some((n) => n.includes(backup)),
      JSON.stringify(r.notices),
    );
    assert.equal(existsSync(join(dir, 'hot.md')), false);
  });
  withOldGit((dir) => {
    put(
      dir,
      '.cache/root-hot-projection-state.json',
      JSON.stringify({ lastHash: sha('root hot\n') }),
    );
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    assert.deepEqual(backupsIn(dir, 'hot.md'), [], 'the old root projection wrote these bytes');
    assert.deepEqual(r.notices, []);
  });
  withOldGit((dir) => {
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({ views: { 'hot.md': sha('root hot\n') } }),
    );
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    assert.deepEqual(backupsIn(dir, 'hot.md'), [], 'the generator record vouches for them');
    assert.deepEqual(r.notices, []);
  });
});

test('a local edit of .gitattributes, which the move changes, defers the move and touches nothing', () => {
  withOldGit(
    (dir) => {
      put(dir, '.gitattributes', 'log.md merge=union\n# mine\n');
      const head = headOf(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'other-dirty');
      assert.ok(r.notices[0].startsWith('이행을 다음 세션으로 미뤘습니다'));
      assert.equal(headOf(dir), head);
      assert.equal(migrationState(dir), 'not-migrated');
      assert.equal(readRel(dir, '.gitattributes'), 'log.md merge=union\n# mine\n');
      assert.equal(readRel(dir, 'projects/p/hot.md'), RICH_HOT);
    },
    { '.gitattributes': 'log.md merge=union\n' },
  );
});

test('the first generation after the move writes no backup, and an add-all commit does not take the views back', () => {
  withOldGit((dir) => {
    migrate(dir);
    const r = writeGeneratedViews(dir, { device: 'devA' });
    assert.ok(r.written.includes('projects/p/hot.md'));
    assert.deepEqual(r.backedUp, []);
    assert.deepEqual(backupsIn(dir, 'projects/p/hot.md'), []);
    put(dir, 'pages/new.md', 'new\n');
    commitIn(dir); // what Obsidian Git does: add -A, commit
    assert.deepEqual(treeNames(dir).filter(isGeneratedViewPath), []);
  });
});

// ── one baseline date, one ownership reader ──────────────────────────────────

suite('session views: the baseline date and the ownership record each have one definition');

const BARE_HOT = '---\ntitle: p\n---\nno updated line\n';
const BARE_STATE = 'no frontmatter at all\n';
const commitAt = (dir, iso) => {
  cgitOk(dir, ['add', '-A']);
  const r = spawnSync('git', ['commit', '-q', '-m', 'x'], {
    cwd: dir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: SESSION_TMP_HOME,
      GIT_CONFIG_GLOBAL: CATCH_UP_CONFIG(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_COMMITTER_DATE: iso,
      GIT_AUTHOR_DATE: iso,
    },
  });
  assert.equal(r.status, 0, r.stderr);
};

test('legacyBaselineDate: updated first, then the day git last changed the files, then the mtime day', () => {
  inCatchUpEnv(() =>
    withTmpDir((dir) => {
      cgitOk(dir, ['init', '-q']);
      put(dir, 'projects/p/hot.md', BARE_HOT);
      put(dir, 'projects/p/session-state.md', BARE_STATE);
      // never committed: the mtime day, whatever today is
      utimesSync(
        join(dir, 'projects/p/hot.md'),
        new Date(2026, 2, 4, 12),
        new Date(2026, 2, 4, 12),
      );
      assert.equal(legacyBaselineDate(dir, 'p', [BARE_HOT, BARE_STATE]), '2026-03-04');
      utimesSync(
        join(dir, 'projects/p/hot.md'),
        new Date(2026, 2, 5, 12),
        new Date(2026, 2, 5, 12),
      );
      assert.equal(
        legacyBaselineDate(dir, 'p', [BARE_HOT, BARE_STATE]),
        '2026-03-05',
        'follows the file',
      );
      commitAt(dir, '2026-02-03T12:00:00Z');
      assert.equal(
        legacyBaselineDate(dir, 'p', [BARE_HOT, BARE_STATE]),
        '2026-02-03',
        'git beats mtime',
      );
      assert.equal(
        legacyBaselineDate(dir, 'p', ['---\nupdated: 2026-05-06\n---\n', BARE_STATE]),
        '2026-05-06',
        'updated beats git',
      );
    }),
  );
});

test('the virtual baseline and the move date the same bytes alike (the day git last changed them)', () => {
  inCatchUpEnv(() =>
    withTmpDir((dir) => {
      cgitOk(dir, ['init', '-q']);
      put(dir, '.gitignore', '.cache/\n');
      put(dir, 'projects/p/index.md', '---\ntitle: p\n---\n');
      put(dir, 'projects/p/hot.md', BARE_HOT);
      put(dir, 'projects/p/session-state.md', BARE_STATE);
      commitAt(dir, '2026-02-03T12:00:00Z');
      const virtual = loadSessionModel(dir, 'p').entries.find((e) => isBaselineId(e.closeId));
      assert.equal(virtual.date, '2026-02-03');
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      assert.match(r.baselines[0], /\/2026-02-03-baseline-/);
      assert.equal(
        r.baselines[0].split('/').at(-1),
        entryFileName(virtual.date, virtual.closeId),
        'the file name is the virtual baseline id and date: the same bytes, the same entry',
      );
    }),
  );
});

test('the generator reads and writes the ownership record and the old root state through hypo-shared alone', () => {
  const src = readFileSync(new URL('../hooks/session-views.mjs', import.meta.url), 'utf-8');
  assert.equal(/generated-views\.json'|root-hot-projection-state/.test(src), false);
  assert.equal(/join\(\s*'\.cache'/.test(src), false, 'no second copy of a .cache path');
});

test('readGeneratedViewsRecord: ok with string values only, missing, or invalid', () => {
  withTmpDir((dir) => {
    assert.deepEqual(readGeneratedViewsRecord(dir), { views: {}, state: 'missing' });
    put(dir, '.cache/generated-views.json', '{not json');
    assert.deepEqual(readGeneratedViewsRecord(dir), { views: {}, state: 'invalid' });
    put(dir, '.cache/generated-views.json', JSON.stringify({ views: ['x'] }));
    assert.equal(readGeneratedViewsRecord(dir).state, 'invalid');
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({ views: { a: 'h', b: 1 }, absorbed: { c: 'h' } }),
    );
    assert.deepEqual(readGeneratedViewsRecord(dir), { views: { a: 'h' }, state: 'ok' });
  });
});

// ── catch-up: what the clearing step sets aside is recorded before it is removed ──────────────

// `origin/main` adds projects/p/hot.md as a tracked file, and `b` (at the migrated state) holds an
// untracked, hand-written one there: the clearing step has to move it out of the merge's way.
function rollbackTarget(a, b) {
  cgitOk(a, ['pull', '-q']);
  put(a, 'projects/p/hot.md', 'rolled back hot\n');
  cgitOk(a, ['add', '-f', 'projects/p/hot.md']);
  cgitOk(a, ['commit', '-q', '-m', 'rollback']);
  cgitOk(a, ['push', '-q']);
  cgitOk(b, ['pull', '-q', '--ff-only']);
  cgitOk(b, ['rm', '-q', '--cached', '-f', 'projects/p/hot.md']);
  cgitOk(b, ['reset', '-q', '--hard', 'HEAD~1']);
  put(b, 'projects/p/hot.md', 'local generated hot\n');
}
const underVault = (dir, abs) => abs.slice(dir.length + 1);

// Spies on the fs calls that decide durability and cleanup order, as the hooks see them:
// syncBuiltinESMExports carries the patched properties to their named imports. Returns the
// events seen, in order.
function recordDurability(fn) {
  const nodeFs = createRequire(import.meta.url)('node:fs');
  const { fsyncSync, renameSync, rmSync } = nodeFs;
  const events = [];
  nodeFs.fsyncSync = (fd) => {
    events.push(fstatSync(fd).isDirectory() ? 'fsync-dir' : 'fsync-file');
    return fsyncSync(fd);
  };
  nodeFs.renameSync = (from, to) => {
    events.push(`rename ${basename(to)}`);
    return renameSync(from, to);
  };
  nodeFs.rmSync = (path, ...rest) => {
    events.push(`rm ${basename(String(path))}`);
    return rmSync(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    nodeFs.fsyncSync = fsyncSync;
    nodeFs.renameSync = renameSync;
    nodeFs.rmSync = rmSync;
    syncBuiltinESMExports();
  }
  return events;
}

test('the clearing step syncs each backup, then the archive record, before it removes anything: file, rename, directory', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    let r;
    const events = recordDurability(() => {
      r = clear(b);
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const at = (name) => events.indexOf(`rename ${name}`);
    const backup = at(basename(r.backups[0]));
    const record = at('pull-archive.json');
    assert.ok(backup >= 0 && record > backup, `backup, then record: ${events.join(' | ')}`);
    for (const i of [backup, record]) {
      assert.equal(
        events[i - 1],
        'fsync-file',
        `the file is synced before its rename: ${events[i]}`,
      );
      assert.equal(events[i + 1], 'fsync-dir', `the directory is synced after it: ${events[i]}`);
    }
  });
});

test('an undo drops the archive record before the backups it names, so a stop between never leaves a record naming a missing backup', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    let undone;
    const events = recordDurability(() => {
      undone = undoClearedPaths(b, r);
    });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const record = events.indexOf('rm pull-archive.json');
    const backup = events.indexOf(`rm ${basename(r.backups[0])}`);
    assert.ok(record >= 0 && backup > record, events.join(' | '));
  });
});

test('an undo syncs the restored bytes, then the record removal, and only then removes the backups', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    let undone;
    const events = recordDurability(() => {
      undone = undoClearedPaths(b, r);
    });
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const restore = events.indexOf('rename hot.md');
    const record = events.indexOf('rm pull-archive.json');
    const backup = events.indexOf(`rm ${basename(r.backups[0])}`);
    const trace = events.join(' | ');
    assert.ok(restore >= 0 && record > restore && backup > record, trace);
    assert.equal(events[restore - 1], 'fsync-file', `the restored file is synced: ${trace}`);
    assert.equal(events[restore + 1], 'fsync-dir', `its directory is synced: ${trace}`);
    assert.equal(events[record + 1], 'fsync-dir', `the record removal is synced: ${trace}`);
    // the same backup can be named by two items, so it is removed twice; the sync follows the last
    assert.equal(
      events[events.lastIndexOf(`rm ${basename(r.backups[0])}`) + 1],
      'fsync-dir',
      `the backup removal is synced: ${trace}`,
    );
  });
});

test('a resume that finds the record naming a backup that is gone keeps the record and says which', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(ffTo(b), 0);
    const [backupPath] = r.backups;
    unlinkSync(backupPath);
    const lost = resumePullArchive(b);
    assert.equal(lost.resumed, true);
    assert.equal(lost.created.length, 0, 'nothing could be shared without the bytes');
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), true, 'the record stays');
    assert.ok(
      lost.notices.some(
        (n) => n.includes('projects/p/hot.md') && n.includes(underVault(b, backupPath)),
      ),
      lost.notices.join('\n'),
    );
    // the bytes back on disk: the next run shares them and drops the record
    put(b, underVault(b, backupPath), W1);
    const found = resumePullArchive(b);
    assert.equal(found.created.length, 1, found.notices.join('\n'));
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), false);
  });
});

test('the archive record names a cleared file backup before the file is removed, and a resume after a crash announces it', () => {
  withCatchUp(({ a, b }) => {
    rollbackTarget(a, b);
    let seen;
    assert.throws(
      () =>
        clear(b, 'origin/main', {
          testHooks: {
            afterArchive: () => {
              seen = {
                record: JSON.parse(readRel(b, '.cache/pull-archive.json')),
                present: existsSync(join(b, 'projects/p/hot.md')),
              };
              throw new Error('stopped');
            },
          },
        }),
      /stopped/,
    );
    assert.equal(
      seen.present,
      true,
      'precondition: the file is still there when the record is read',
    );
    assert.equal(seen.record.cleared.length, 1);
    const { backupPath } = seen.record.cleared[0];
    assert.equal(readFileSync(backupPath, 'utf-8'), 'local generated hot\n');
    // The crash came after the removal: the file is gone and only the record remembers.
    unlinkSync(join(b, 'projects/p/hot.md'));
    const retry = clear(b, 'origin/main');
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.deepEqual(
      retry.cleared.map((c) => c.backupPath),
      [backupPath],
      'the retry carries the entry its predecessor recorded',
    );
    assert.equal(ffTo(b, 'origin/main'), 0);
    const resumed = resumePullArchive(b);
    assert.equal(resumed.resumed, true);
    assert.ok(
      resumed.notices.some(
        (n) => n.includes('projects/p/hot.md') && n.includes(underVault(b, backupPath)),
      ),
      resumed.notices.join('\n'),
    );
  });
});

test('the archive record keeps local-only and unowned backups, and a resume names each one', () => {
  withCatchUp(
    ({ b }) => {
      put(b, '.hypoignore', 'projects/secret/hot.md\n');
      const r = clear(b);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.localOnly.length, 2, 'precondition: two local-only files');
      assert.equal(r.unowned.length, 1, 'precondition: the root hot.md is nobody-vouched');
      const record = JSON.parse(readRel(b, '.cache/pull-archive.json'));
      assert.deepEqual(
        record.localOnly.map((v) => v.backupPath).sort(),
        r.localOnly.map((v) => v.backupPath).sort(),
      );
      assert.deepEqual(
        record.unowned.map((v) => v.backupPath),
        r.unowned.map((v) => v.backupPath),
      );
      assert.equal(ffTo(b), 0);
      const resumed = resumePullArchive(b);
      const text = resumed.notices.join('\n');
      for (const { backupPath } of [...r.localOnly, ...r.unowned]) {
        assert.ok(text.includes(underVault(b, backupPath)), `${backupPath} in\n${text}`);
      }
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

test('a record from before the set-aside lists existed reads as empty lists and still resumes', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true);
    const record = JSON.parse(readRel(b, '.cache/pull-archive.json'));
    for (const key of ['localOnly', 'unowned', 'cleared', 'gitignoreSaved']) delete record[key];
    for (const v of record.views) delete v.run;
    put(b, '.cache/pull-archive.json', JSON.stringify(record));
    assert.equal(ffTo(b), 0);
    const resumed = resumePullArchive(b);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.created.length, 1);
  });
});

test('setAsideNotices names each backup, and skips the ones the caller announced already', () => {
  withTmpDir((dir) => {
    const list = {
      cleared: [{ relPath: 'projects/p/hot.md', backupPath: join(dir, '.cache/backups/c.md') }],
      unowned: [
        { relPath: 'hot.md', kind: 'worktree', backupPath: join(dir, '.cache/backups/u.md') },
      ],
    };
    const all = setAsideNotices(dir, list).join('\n');
    assert.match(all, /projects\/p\/hot\.md/);
    assert.ok(all.includes('.cache/backups/c.md') && all.includes('.cache/backups/u.md'), all);
    assert.deepEqual(
      setAsideNotices(dir, list, [list.cleared[0].backupPath, list.unowned[0].backupPath]),
      [],
    );
  });
});

test('two archived versions of one path both become baselines, and both are announced', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    assert.throws(
      () =>
        clear(b, '@{u}', {
          testHooks: {
            afterArchive: () => {
              throw new Error('stopped');
            },
          },
        }),
      /stopped/,
    );
    put(b, 'projects/p/hot.md', W2); // edited between the retries
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(
      r.archived
        .filter((v) => v.kind === 'worktree')
        .map((v) => v.sha256)
        .sort(),
      [sha(W1), sha(W2)].sort(),
      'precondition: the record holds both versions',
    );
    assert.equal(ffTo(b), 0);
    const before = baselinesOf(b).length;
    const resumed = resumePullArchive(b);
    assert.equal(resumed.created.length, 2);
    assert.equal(new Set(resumed.created).size, 2, 'two distinct baseline ids');
    assert.equal(baselinesOf(b).length, before + 2);
    for (const rel of resumed.created) {
      assert.ok(
        resumed.notices.some((n) => n.includes(rel)),
        `no notice for ${rel}`,
      );
    }
    const bodies = resumed.created.map((rel) => readRel(b, rel));
    assert.ok(bodies.some((t) => t.includes('local edit one')));
    assert.ok(bodies.some((t) => t.includes('local edit two')));
  });
});

// ── catch-up: the .gitignore goes back as the exact bytes it held ────────────────────────────

const STAGED_GITIGNORE = '.cache/\nstaged-only/\n';
const WORK_GITIGNORE = '.cache/\r\n\r\nwork-only/\r\n\r\n';

// `.gitignore` staged as STAGED_GITIGNORE, then rewritten in the working tree (CRLF, blank lines,
// without the staged line); and a local commit, so the later `merge --ff-only` cannot succeed.
function gitignoreTwoVersions(b) {
  put(b, '.gitignore', STAGED_GITIGNORE);
  cgitOk(b, ['add', '.gitignore']);
  put(b, '.gitignore', WORK_GITIGNORE);
  put(b, 'pages/local.md', 'local\n');
  cgitOk(b, ['add', 'pages/local.md']);
  cgitOk(b, ['commit', '-q', '-m', 'local', '--', 'pages/local.md']);
  assert.equal(cgitOk(b, ['show', ':.gitignore']), STAGED_GITIGNORE, 'precondition: staged blob');
  assert.equal(readRel(b, '.gitignore'), WORK_GITIGNORE, 'precondition: working tree');
}
const indexBlob = (b) => cgitOk(b, ['show', ':.gitignore']);

test('a failed move puts the staged .gitignore blob and the working-tree bytes back exactly', () => {
  withCatchUp(({ b }) => {
    gitignoreTwoVersions(b);
    const pre = clear(b);
    assert.equal(pre.ok, true, JSON.stringify(pre));
    assert.deepEqual(pre.gitignoreSaved.map((v) => v.kind).sort(), ['stage', 'worktree']);
    assert.equal(
      readRel(b, '.gitignore'),
      '.cache/\n',
      'precondition: the clearing step restored HEAD',
    );
    assert.equal(
      cgitOk(b, ['diff', '--cached', '--name-only']).trim(),
      '',
      'and released the stage',
    );
    assert.notEqual(ffTo(b), 0, 'precondition: the merge cannot fast-forward');
    const undone = undoClearedPaths(b, pre);
    assert.deepEqual(undone, { ok: true, notices: [] });
    assert.ok(readFileSync(join(b, '.gitignore')).equals(Buffer.from(WORK_GITIGNORE)));
    assert.equal(indexBlob(b), STAGED_GITIGNORE);
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), false);
    for (const { backupPath } of pre.gitignoreSaved) assert.equal(existsSync(backupPath), false);
  });
});

test('fastForwardTo leaves a staged-only .gitignore line staged and the CRLF working tree as it was when the merge fails', () => {
  withCatchUp(({ b }) => {
    gitignoreTwoVersions(b);
    const r = fastForwardTo(b, '@{u}');
    assert.equal(r.ok, false);
    assert.match(r.reason, /^fast-forward-failed/);
    assert.equal(r.pre.gitignoreSaved.length, 2, 'precondition: the clearing step moved it');
    assert.ok(readFileSync(join(b, '.gitignore')).equals(Buffer.from(WORK_GITIGNORE)));
    assert.equal(indexBlob(b), STAGED_GITIGNORE);
  });
});

test('a .gitignore written after the clearing step is not overwritten by the undo, and its backup is kept', () => {
  withCatchUp(({ b }) => {
    gitignoreTwoVersions(b);
    const pre = clear(b);
    assert.equal(pre.ok, true, JSON.stringify(pre));
    put(b, '.gitignore', 'written by someone else\n');
    const undone = undoClearedPaths(b, pre);
    assert.equal(undone.ok, false);
    assert.equal(readRel(b, '.gitignore'), 'written by someone else\n');
    const work = pre.gitignoreSaved.find((v) => v.kind === 'worktree');
    assert.match(undone.notices.join('\n'), /\.gitignore/);
    assert.ok(undone.notices.join('\n').includes(work.backupPath));
    assert.equal(readFileSync(work.backupPath, 'utf-8'), WORK_GITIGNORE);
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), true, 'the record stays');
  });
});

test('a run that stopped after the .gitignore was released is recovered with its exact bytes', () => {
  withCatchUp(({ b }) => {
    gitignoreTwoVersions(b);
    const pre = clear(b);
    assert.equal(pre.ok, true, JSON.stringify(pre));
    const record = JSON.parse(readRel(b, '.cache/pull-archive.json'));
    assert.equal(record.gitignoreSaved.length, 2, 'precondition: the record holds the saved bytes');
    // the next run starts from the released state; its own snapshot is the exact bytes again
    const again = clear(b);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(
      again.gitignoreSaved.map((v) => readFileSync(v.backupPath, 'utf-8')).sort(),
      [STAGED_GITIGNORE, WORK_GITIGNORE].sort(),
    );
  });
});

test('(b) an index entry replaced after the backup, working tree unchanged, defers and the new staged bytes survive', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    cgitOk(b, ['add', 'projects/p/hot.md']);
    assert.equal(cgitOk(b, ['show', ':0:projects/p/hot.md']), W1, 'precondition: S1 is staged');
    const r = clear(b, '@{u}', {
      testHooks: {
        beforeUnstage: () => {
          put(b, 'swap.tmp', W2);
          const blob = cgitOk(b, ['hash-object', '-w', '--no-filters', 'swap.tmp']).trim();
          unlinkSync(join(b, 'swap.tmp'));
          cgitOk(b, ['update-index', '--cacheinfo', `100644,${blob},projects/p/hot.md`]);
        },
      },
    });
    assert.equal(r.deferred, 'concurrent-change');
    assert.equal(readRel(b, 'projects/p/hot.md'), W1, 'the working tree is as it was');
    assert.equal(cgitOk(b, ['show', ':0:projects/p/hot.md']), W2, 'the index still holds S2');
  });
});

// ── review fixes: incomplete block, HEAD baseline, one entry per close id, old-shape record ──

const GITIGNORE_FIRST_LINE = GITIGNORE_BLOCK.split('\n')[0];

test('a .gitignore with the block first line but not its view patterns defers the move and names the missing lines', () => {
  withOldGit(
    (dir) => {
      const before = commitCount(dir);
      const trackedBefore = listTrackedGeneratedViews(dir, { source: 'head' });
      assert.equal(migrationState(dir), 'incomplete-block');
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'block-incomplete');
      assert.equal(commitCount(dir), before, 'no commit was created');
      assert.deepEqual(listTrackedGeneratedViews(dir, { source: 'head' }), trackedBefore);
      assert.equal(showHead(dir, '.gitignore'), `.cache/\n${GITIGNORE_FIRST_LINE}\n/hot.md\n`);
      const notice = r.notices.join('\n');
      for (const line of ['/projects/*/hot.md', '/projects/*/session-state.md']) {
        assert.ok(notice.includes(line), `the notice names ${line}: ${notice}`);
      }
      assert.match(notice, /커밋/, 'the notice says the repair is read from a commit');
      assert.equal(notice.includes('/hot.md.pre'), true, 'the backup patterns are named too');
    },
    { '.gitignore': `.cache/\n${GITIGNORE_FIRST_LINE}\n/hot.md\n` },
  );
});

test('a vault whose own .gitignore leaves .cache/ out is not moved: the backup of a local edit would be staged by an add-all', () => {
  withOldGit(
    (dir) => {
      put(dir, 'projects/p/hot.md', `${RICH_HOT}local edit\n`);
      const before = commitCount(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'cache-not-ignored');
      assert.equal(commitCount(dir), before, 'no commit was created');
      assert.match(r.notices.join('\n'), /\/\.cache\//);
      for (const rel of [
        '.cache/backups',
        '.cache/pull-archive.json',
        '.cache/generated-views.json',
      ]) {
        assert.equal(existsSync(join(dir, rel)), false, `${rel} was not written`);
      }
      assert.equal(readRel(dir, 'projects/p/hot.md'), `${RICH_HOT}local edit\n`);
      cgitOk(dir, ['add', '-A']);
      assert.equal(
        cgitOk(dir, ['ls-files'])
          .split('\n')
          .some((n) => n.startsWith('.cache/')),
        false,
      );
    },
    { '.gitignore': 'node_modules/\n' },
  );
});

test('the writer leaves .cache/ alone while a later rule un-ignores it, and says so', () => {
  withOldGit((dir) => {
    assert.equal(migrate(dir).migrated, true, 'precondition: the vault is migrated');
    put(dir, '.gitignore', `${showHead(dir, '.gitignore')}!/.cache/\n`);
    commitIn(dir);
    assert.equal(migrationState(dir), 'migrated', 'precondition: the block itself is whole');
    assert.equal(consumeRootHotHealthNotice(dir), null);
    putEntry(dir, 'p', 'c-late', { date: '2026-10-02' });
    put(dir, 'projects/p/hot.md', 'hand written\n'); // foreign bytes: the writer would back them up
    const cacheNow = () => [
      listDir(join(dir, '.cache/backups')),
      existsSync(join(dir, '.cache/generated-views.json')),
    ];
    const cacheBefore = cacheNow();
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.notMigrated, true);
    assert.deepEqual(r.written, []);
    assert.deepEqual(cacheNow(), cacheBefore, 'no backup or ownership record was added');
    assert.ok(r.unignoredCache.includes('.cache/'), JSON.stringify(r));
    assert.ok(
      r.unignoredCache.includes('.cache/backups/projects/probe/hot.md.pre-projection-backup.md'),
      JSON.stringify(r),
    );
    assert.equal(readRel(dir, 'projects/p/hot.md'), 'hand written\n');
    assert.match(consumeRootHotHealthNotice(dir) ?? '', /\/\.cache\//);
  });
});

test('a .gitattributes with the block first line but not its patterns defers the move', () => {
  withOldGit(
    (dir) => {
      const before = commitCount(dir);
      const r = migrate(dir);
      assert.equal(r.deferred, 'block-incomplete');
      assert.equal(commitCount(dir), before);
      assert.ok(r.notices.join('\n').includes('projects/*/sessions/*.md text eol=lf'));
    },
    { '.gitattributes': `${GITATTRIBUTES_BLOCK.split('\n')[0]}\n` },
  );
});

test('a .gitignore that holds the whole block, with user lines around it, still migrates', () => {
  withOldGit(
    (dir) => {
      // the block ignores the views, so they were not committed: track them as an old vault did
      cgitOk(dir, ['add', '-f', 'hot.md', 'projects/p/hot.md', 'projects/p/session-state.md']);
      commitIn(dir);
      assert.equal(migrationState(dir), 'not-migrated', 'views are still tracked');
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      assert.equal(showHead(dir, '.gitignore'), `.cache/\n${GITIGNORE_BLOCK}!keep-me.md\n`);
      assert.equal(migrationState(dir), 'migrated');
    },
    { '.gitignore': `.cache/\n${GITIGNORE_BLOCK}!keep-me.md\n` },
  );
});

test('the virtual baseline of a vault not moved yet is HEAD bytes, not the staged or working-tree ones, and its id is the migration id', () => {
  withOldGit((dir) => {
    put(dir, 'projects/p/hot.md', RICH_HOT.replace('the old summary', 'STAGED summary'));
    cgitOk(dir, ['add', 'projects/p/hot.md']);
    put(dir, 'projects/p/hot.md', RICH_HOT.replace('the old summary', 'WORKTREE summary'));
    const virtual = loadSessionModel(dir, 'p').entries.find((e) => isBaselineId(e.closeId));
    assert.ok(virtual, 'a virtual baseline');
    const text = JSON.stringify(virtual);
    assert.ok(text.includes('the old summary'), 'HEAD text');
    assert.equal(text.includes('STAGED'), false);
    assert.equal(text.includes('WORKTREE'), false);
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    assert.equal(
      entryOf(dir, r.baselines[0]).closeId,
      virtual.closeId,
      'the migration commit builds the same baseline id',
    );
  });
});

test('two entry files with one close id and different date prefixes give one entry and one head, whatever order they were written in', () => {
  for (const order of [
    ['2026-10-02', '2026-10-01'],
    ['2026-10-01', '2026-10-02'],
  ]) {
    withTmpDir((dir) => {
      const text = entryFile('dup-close-1', { project: 'p', date: '2026-10-01' });
      for (const day of order)
        put(dir, `projects/p/sessions/${entryFileName(day, 'dup-close-1')}`, text);
      const { entries, unreadable } = listSessionEntries(dir, 'p');
      assert.deepEqual(unreadable, []);
      assert.equal(entries.length, 1, 'one entry per close id');
      const model = loadSessionModel(dir, 'p', { state: 'migrated' });
      assert.equal(model.entries.length, 1);
      const heads = trackHeads(model.entries).flatMap((t) => t.heads);
      assert.deepEqual(
        heads.map((h) => h.closeId),
        ['dup-close-1'],
      );
    });
  }
});

test('an archive record of the old shape (views without run) with two versions of one path makes two baselines', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    assert.throws(
      () =>
        clear(b, '@{u}', {
          testHooks: {
            afterArchive: () => {
              throw new Error('stopped');
            },
          },
        }),
      /stopped/,
    );
    put(b, 'projects/p/hot.md', W2);
    assert.equal(clear(b).ok, true);
    assert.equal(ffTo(b), 0);
    // what the previous code wrote: no `run` on any view
    const recordPath = join(b, '.cache', 'pull-archive.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    const hots = record.views.filter((v) => v.relPath === 'projects/p/hot.md');
    assert.deepEqual(hots.map((v) => v.sha256).sort(), [sha(W1), sha(W2)].sort());
    for (const v of record.views) delete v.run;
    writeFileSync(recordPath, JSON.stringify(record));
    const resumed = resumePullArchive(b);
    assert.equal(resumed.created.length, 2, JSON.stringify(resumed));
    assert.equal(new Set(resumed.created).size, 2, 'two distinct baseline ids');
  });
});

test('a migrated vault whose HEAD .gitignore later loses a view pattern renders nothing and leaves a notice naming the missing lines', () => {
  withOldGit((dir) => {
    assert.equal(migrate(dir).migrated, true, 'precondition: the vault is migrated');
    const healthy = writeGeneratedViews(dir, WRITE);
    assert.equal(healthy.state, 'migrated');
    assert.equal(healthy.missingBlockLines, undefined);
    assert.equal(consumeRootHotHealthNotice(dir), null, 'a healthy vault leaves no notice');

    const healthyIgnore = showHead(dir, '.gitignore');
    const lost = ['/projects/*/hot.md', '/projects/*/session-state.md'];
    const damaged = showHead(dir, '.gitignore')
      .split('\n')
      .filter((l) => !lost.includes(l.trim()))
      .join('\n');
    put(dir, '.gitignore', damaged);
    commitIn(dir);
    assert.equal(migrationState(dir), 'incomplete-block', 'precondition: the block is damaged');
    const hotBefore = readRel(dir, 'hot.md');
    putEntry(dir, 'p', 'c-late', { date: '2026-10-02' });

    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.written, []);
    assert.equal(r.notMigrated, true);
    assert.equal(r.state, 'incomplete-block');
    assert.deepEqual(r.missingBlockLines, lost);
    assert.equal(readRel(dir, 'hot.md'), hotBefore, 'nothing was rendered');
    const notice = consumeRootHotHealthNotice(dir) ?? '';
    for (const line of lost)
      assert.ok(notice.includes(line), `the notice names ${line}: ${notice}`);
    assert.match(notice, /불완전/);
    assert.match(notice, /커밋/, 'the notice says to commit the restored block');
    assert.equal(consumeRootHotHealthNotice(dir), null, 'the notice is delivered once');
    // the state is read from HEAD: a restored working tree alone does not start the renders again
    put(dir, '.gitignore', healthyIgnore);
    assert.equal(migrationState(dir), 'incomplete-block', 'an uncommitted restore changes nothing');
    assert.equal(writeGeneratedViews(dir, WRITE).notMigrated, true);
    // the damaged commit also took the views in (nothing ignored the project ones): untrack them again
    cgitOk(dir, ['rm', '-q', '--cached', VIEW, 'projects/p/session-state.md']);
    commitIn(dir);
    assert.equal(migrationState(dir), 'migrated', 'the committed block starts them again');
    assert.ok(writeGeneratedViews(dir, WRITE).written.length > 0);
  });
});

test('a vault that is simply not migrated stays silent when the writer declines to render', () => {
  withOldGit((dir) => {
    assert.equal(migrationState(dir), 'not-migrated', 'precondition');
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.notMigrated, true);
    assert.equal(r.missingBlockLines, undefined);
    assert.equal(consumeRootHotHealthNotice(dir), null);
  });
});
