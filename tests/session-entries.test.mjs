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
import { basename, dirname, join, relative } from 'node:path';
import {
  GITATTRIBUTES_BLOCK,
  GITIGNORE_BLOCK,
  LEGACY_TRACK_ID,
  NEXT_UP_HEADINGS,
  TRACK_ID_RE,
  assertNoEntryMarkers,
  baselineIdMismatch,
  buildLegacyBaselines,
  closeIdFor,
  entryFileName,
  entryMarker,
  entryVisible,
  buildInjection,
  generatedViewSlug,
  formatSessionEntry,
  isBaselineId,
  isGeneratedViewPath,
  isSessionEntryPath,
  isSessionProjectDir,
  isValidProjectName as isValidProjectNameHook,
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
  nfcRenameCommands,
} from '../hooks/session-entries.mjs';
import {
  clearGeneratedPathsBlockingPull,
  consumeRootHotHealthNotice,
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
  SESSION_STATE_NEXT_HEADINGS,
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
  afterFastForward,
  fastForwardTo,
  listSessionEntries,
  listSessionProjects,
  listTrackedGeneratedViews,
  loadSessionModel,
  migrateVaultToSessionEntries,
  migrationState,
  offMarkerHashes,
  projectEntryScope,
  readObservedHeads,
  recordObservedHeads,
  writeGeneratedViews,
  writeGeneratedViewsUnlocked,
} from '../hooks/session-views.mjs';
import { isIgnored as isIgnoredScripts } from '../scripts/lib/hypo-ignore.mjs';
import { isValidProjectName } from '../scripts/lib/project-create.mjs';
import { ROLLBACK_LIMITS, rollbackSessionEntries } from '../scripts/session-entries.mjs';
import { test, suite } from './harness.mjs';
import { REPO, SESSION_TMP_HOME, withTmpDir } from './helpers.mjs';

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
  for (const project of ['foo #bar', 'a b', '..', '.', '#x', 'a/b', 'a"b', '-', '']) {
    assert.throws(
      () => formatSessionEntry(sample({ project })),
      (err) => err.code === 'invalid-entry',
      JSON.stringify(project),
    );
  }
  for (const project of ['my-proj.v2', 'p', 'A_b-1', '.hidden', '1', 'a..b', '한글']) {
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

const NO_SCOPES = { index: null, hot: null, state: null };

// The baselines of one project's old files, hot first: [{kind, closeId, fileName, text, scope, conflict}].
function baselines(over = {}) {
  return buildLegacyBaselines({
    hotText: OLD_HOT,
    stateText: OLD_STATE,
    date: '2026-09-30',
    project: 'p',
    scopes: NO_SCOPES,
    legacyDone: false,
    ...over,
  });
}
const baselineOf = (kind, over) => baselines(over).find((x) => x.kind === kind);
const baselineEntries = (over) => baselines(over).map((x) => parseSessionEntry(x.text).entry);

test('each old file is its own baseline entry and keeps its bytes whole, frontmatter included', () => {
  const [hot, state] = baselines();
  assert.deepEqual([hot.kind, state.kind], ['hot', 'state']);
  const h = parseSessionEntry(hot.text);
  const st = parseSessionEntry(state.text);
  assert.equal(h.ok, true);
  assert.equal(st.ok, true);
  assert.equal(h.entry.summary, OLD_HOT);
  assert.deepEqual(h.entry.tracks, [], 'the hot baseline carries no track');
  assert.deepEqual(h.entry.bodies, {});
  assert.equal(st.entry.summary, '', 'the state baseline has no summary');
  assert.equal(st.entry.bodies[LEGACY_TRACK_ID], OLD_STATE);
  assert.deepEqual(st.entry.tracks, [{ id: 'legacy', title: '이행 전 기록', new: true }]);
  for (const [built, parsed] of [
    [hot, h],
    [state, st],
  ]) {
    assert.equal(parsed.entry.closeId, built.closeId);
    assert.match(built.closeId, /^baseline-[0-9a-f]{16}$/);
    assert.equal(built.fileName, `2026-09-30-${built.closeId}.md`);
    assert.equal(parsed.entry.sessionId, null);
  }
  assert.notEqual(hot.closeId, state.closeId, 'the two files of one project never share an id');
});

test('a file that is absent or empty gets no baseline entry', () => {
  assert.deepEqual(
    baselines({ hotText: null }).map((x) => x.kind),
    ['state'],
  );
  assert.deepEqual(
    baselines({ stateText: '' }).map((x) => x.kind),
    ['hot'],
  );
  assert.deepEqual(baselines({ hotText: null, stateText: undefined }), []);
});

test('identical bytes in the two old files still give two different ids', () => {
  const [hot, state] = baselines({ hotText: 'same', stateText: 'same' });
  assert.notEqual(hot.closeId, state.closeId);
  assert.notEqual(hot.fileName, state.fileName);
});

test('baselines from CRLF files are the baselines from the same LF files, with no CR in them', () => {
  const crlf = (t) => t.replace(/\n/g, '\r\n');
  assert.equal(OLD_HOT.includes('\r') || OLD_STATE.includes('\r'), false);
  const fromLf = baselines();
  const fromCrlf = baselines({ hotText: crlf(OLD_HOT), stateText: crlf(OLD_STATE) });
  assert.deepEqual(
    fromCrlf.map((x) => [x.closeId, x.fileName, x.text]),
    fromLf.map((x) => [x.closeId, x.fileName, x.text]),
  );
  for (const x of fromCrlf) assert.equal(x.text.includes('\r'), false);
});

test('--- lines and frontmatter-shaped text inside a section do not leak into the entry frontmatter', () => {
  const b = baselineOf('state');
  const parsed = parseSessionEntry(b.text);
  assert.equal(parsed.entry.closeId, b.closeId);
  assert.equal(parsed.entry.tracks.length, 1);
  assert.equal(parsed.entry.project, 'p');
  assert.ok(!('machine_note' in parsed.entry));
});

test('splitLegacyFrontmatter separates the old frontmatter, machine_note included, from the body', () => {
  const [hotEntry, stateEntry] = baselineEntries();
  const state = splitLegacyFrontmatter(stateEntry.bodies[LEGACY_TRACK_ID]);
  assert.match(state.frontmatter, /^---\ntype: session-state\n/);
  assert.match(state.frontmatter, /machine_note: next, finish the masking pipeline\n---\n$/);
  assert.ok(state.body.startsWith('\n## Next Up'));
  assert.ok(state.body.includes('Body with a rule\n---\nand text after it.'));
  assert.equal(state.frontmatter + state.body, OLD_STATE);
  const hot = splitLegacyFrontmatter(hotEntry.summary);
  assert.match(hot.frontmatter, /tags: \[a, b\]\nrelated: \["\[\[x\]\]"\]\n---\n$/);
  assert.equal(hot.frontmatter + hot.body, OLD_HOT);
});

test('splitLegacyFrontmatter returns frontmatter null when the first line is not ---', () => {
  for (const text of ['# Title\n---\nx\n---\n', '', ' ---\nx\n---\n', '---\nnever closed\n']) {
    assert.deepEqual(splitLegacyFrontmatter(text), { frontmatter: null, body: text });
  }
});

test('legacyDone marks only the state baseline done, keeps the body, and changes its close id', () => {
  const open = baselines();
  const done = baselines({ legacyDone: true });
  const parsed = parseSessionEntry(done.find((x) => x.kind === 'state').text);
  assert.deepEqual(parsed.entry.tracks, [
    { id: 'legacy', title: '이행 전 기록', new: true, done: true },
  ]);
  assert.equal(parsed.entry.bodies[LEGACY_TRACK_ID], OLD_STATE);
  assert.notEqual(
    done.find((x) => x.kind === 'state').closeId,
    open.find((x) => x.kind === 'state').closeId,
  );
  assert.equal(
    done.find((x) => x.kind === 'hot').closeId,
    open.find((x) => x.kind === 'hot').closeId,
    'the hot baseline has no track to fold',
  );
});

test('baselines that differ only in visibility scope get different close ids and paths', () => {
  const scoped = (scope) => baselines({ scopes: { ...NO_SCOPES, hot: scope, state: scope } });
  const [shared, devA, devB] = [scoped(null), scoped('machine:devA'), scoped('machine:devB')];
  for (const kind of [0, 1]) {
    assert.notEqual(shared[kind].closeId, devA[kind].closeId);
    assert.notEqual(devA[kind].closeId, devB[kind].closeId);
    assert.notEqual(devA[kind].fileName, devB[kind].fileName);
    assert.match(devA[kind].text, /^visibility_scope: machine:devA$/m);
    assert.ok(!/^visibility_scope:/m.test(shared[kind].text));
  }
});

test('each baseline takes the narrower of the project scope and its own file scope only', () => {
  const only = (scopes) =>
    Object.fromEntries(baselines({ scopes: { ...NO_SCOPES, ...scopes } }).map((x) => [x.kind, x]));
  const hotScoped = only({ hot: 'machine:devA' });
  assert.equal(hotScoped.hot.scope, 'machine:devA');
  assert.equal(hotScoped.state.scope, null, 'a scoped hot.md must not hide the state baseline');
  assert.ok(!/^visibility_scope:/m.test(hotScoped.state.text));
  const stateScoped = only({ state: 'machine:devB' });
  assert.equal(stateScoped.hot.scope, null);
  assert.equal(stateScoped.state.scope, 'machine:devB');
  const projectScoped = only({ index: 'machine:devA' });
  assert.deepEqual(
    [projectScoped.hot.scope, projectScoped.state.scope],
    ['machine:devA', 'machine:devA'],
  );
  const clash = only({ index: 'machine:devA', state: 'machine:devB' });
  assert.deepEqual([clash.hot.scope, clash.hot.conflict], ['machine:devA', false]);
  assert.deepEqual([clash.state.scope, clash.state.conflict], ['machine:', true]);
});

test('the same inputs give the same close ids and bytes on any machine', () => {
  assert.deepEqual(baselines(), baselines());
  assert.notEqual(
    baselineOf('state').closeId,
    baselineOf('state', { stateText: `${OLD_STATE}x` }).closeId,
  );
  assert.notEqual(baselineOf('hot').closeId, baselineOf('hot', { hotText: `${OLD_HOT}x` }).closeId);
  assert.equal(
    baselineOf('hot').closeId,
    baselineOf('hot', { stateText: `${OLD_STATE}x` }).closeId,
    'a change to the state file leaves the hot baseline where it was',
  );
});

test('baselineIdMismatch: a baseline names its content, and an edit merged into it breaks the name', () => {
  for (const kind of ['hot', 'state']) {
    const built = baselineOf(kind);
    assert.equal(baselineIdMismatch(built.fileName, built.text), null, `${kind}: untouched`);
    const bodyEdit = built.text.replace(kind === 'hot' ? '# Hot' : 'Body with a rule', 'EDITED');
    assert.notEqual(bodyEdit, built.text);
    const m = baselineIdMismatch(built.fileName, bodyEdit);
    assert.ok(m, `${kind}: an edited body is reported`);
    assert.equal(m.inName, built.closeId, 'the name still carries the old hash');
    assert.notEqual(m.expected, built.closeId, 'the content hashes to another id');
    const renamed = built.fileName.replace(/baseline-[0-9a-f]{16}/, 'baseline-0000000000000000');
    assert.equal(baselineIdMismatch(renamed, built.text)?.inName, 'baseline-0000000000000000');
  }
  assert.equal(
    baselineIdMismatch('2026-10-01-c1.md', 'not an entry'),
    null,
    'a file that is not a readable baseline is not this check',
  );
});

// An old session-state.md shaped like the security-backoffice one: a preamble, a `## 다음 이어받기`
// section with no subsections, then one `##` section per track. A fenced block holds a `##` line.
const MULTI_STATE = [
  '---',
  'type: session-state',
  'updated: 2026-10-12',
  '---',
  '',
  '## 다음 이어받기',
  '',
  '트랙: squid 콘솔 · flow · review',
  '',
  '```',
  '## not a heading',
  '```',
  '',
  '## squid 콘솔 (257차, 2026-10-12)',
  '',
  'SQUID_BODY',
  '',
  '```',
  '## also not a heading',
  '```',
  '',
  '## flow',
  '',
  'FLOW_BODY',
  '',
  '## review',
  '',
  'REVIEW_BODY',
  '',
].join('\n');

// The same shape the generator renders: `## Next Up` with `###` tracks, then sections that are not tracks.
const NEXT_UP_STATE = [
  '# State',
  '',
  '## Next Up',
  '',
  '### Alpha (alpha) · 2026-10-01 · c1',
  'ALPHA_BODY',
  '',
  '### Beta (beta) · 2026-10-01 · c2',
  'BETA_BODY',
  '',
  '## Notes',
  '',
  'NOTES_TEXT',
  '',
].join('\n');

const splitBaseline = (stateText, over) => {
  const built = baselineOf('state', { stateText, ...over });
  return { built, entry: parseSessionEntry(built.text).entry };
};

// The source with every track's heading line and body cut out must equal the remainder: no byte
// of the old file is lost except the `##`/`###` marker run of a track heading.
function cutTracks(source, entry, marks) {
  let rest = source;
  for (const t of entry.tracks.filter((x) => x.id !== 'legacy')) {
    const piece = `${marks} ${t.title}\n${entry.bodies[t.id]}`;
    assert.ok(rest.includes(piece), `${t.id}: heading and body are in the source`);
    rest = rest.replace(piece, '');
  }
  return rest;
}

test('an old state file with a section per track becomes one head per track and loses no byte', () => {
  const { entry } = splitBaseline(MULTI_STATE);
  assert.deepEqual(
    entry.tracks.map((t) => t.title),
    ['이행 전 기록', 'squid 콘솔 (257차, 2026-10-12)', 'flow', 'review'],
  );
  assert.equal(new Set(entry.tracks.map((t) => t.id)).size, 4, 'every track has its own id');
  assert.ok(entry.tracks.every((t) => t.new === true));
  assert.ok(entry.tracks.slice(1).every((t) => /^legacy-/.test(t.id)));
  const [, squid, flow, review] = entry.tracks;
  assert.ok(entry.bodies[squid.id].includes('SQUID_BODY'));
  assert.ok(entry.bodies[squid.id].includes('## also not a heading'), 'a fenced ## is body text');
  assert.equal(entry.bodies[flow.id], '\nFLOW_BODY\n\n');
  assert.equal(entry.bodies[review.id], '\nREVIEW_BODY\n');
  assert.ok(squid.id.startsWith('legacy-'));
  const rest = entry.bodies.legacy;
  assert.ok(rest.startsWith('---\ntype: session-state') && rest.includes('트랙: squid 콘솔'));
  assert.ok(
    rest.includes('## not a heading'),
    'the fenced ## of the preamble stays in the remainder',
  );
  assert.equal(cutTracks(MULTI_STATE, entry, '##'), rest);
});

test('a generator-shaped ## Next Up with ### tracks splits, and what follows stays in the remainder', () => {
  const { entry } = splitBaseline(NEXT_UP_STATE);
  assert.deepEqual(
    entry.tracks.map((t) => t.title),
    ['이행 전 기록', 'Alpha (alpha) · 2026-10-01 · c1', 'Beta (beta) · 2026-10-01 · c2'],
  );
  assert.ok(entry.tracks[1].id.startsWith('legacy-alpha-alpha-2026-10-01-c1-'));
  const rest = entry.bodies.legacy;
  assert.ok(
    rest.includes('## Next Up') && rest.includes('## Notes') && rest.includes('NOTES_TEXT'),
  );
  assert.ok(!rest.includes('ALPHA_BODY') && !rest.includes('BETA_BODY'));
  assert.equal(cutTracks(NEXT_UP_STATE, entry, '###'), rest);
});

test('text that cannot be cut into tracks stays one whole legacy head', () => {
  const cases = {
    'no next-up heading': '## squid\n\nA\n\n## flow\n\nB\n',
    'one track only': '## Next Up\n\n### only\nA\n',
    'next-up heading but no sections after it': '## Next Up\n\nfree text\n',
    'headings inside a fence': '## Next Up\n\n```\n### a\n### b\n```\n',
    'plain text': 'just a note\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    const { entry } = splitBaseline(text);
    assert.deepEqual(
      entry.tracks,
      [{ id: 'legacy', title: '이행 전 기록', new: true }],
      `${name}: one head`,
    );
    assert.equal(entry.bodies.legacy, text, `${name}: whole text`);
  }
});

test('split baseline ids are deterministic: same bytes (also CRLF) give the same entry file', () => {
  const a = splitBaseline(MULTI_STATE).built;
  const b = splitBaseline(MULTI_STATE).built;
  const crlf = splitBaseline(MULTI_STATE.replace(/\n/g, '\r\n')).built;
  assert.equal(a.text, b.text);
  assert.equal(a.fileName, b.fileName);
  assert.equal(crlf.text, a.text);
  assert.notEqual(a.closeId, splitBaseline(`${MULTI_STATE}x`).built.closeId);
  const twin = splitBaseline('## Next Up\n\n### same\nA\n\n### same\nB\n').entry;
  assert.equal(new Set(twin.tracks.map((t) => t.id)).size, 3, 'two sections with one title differ');
  // Moving a track section does not rename it.
  const moved = splitBaseline(
    NEXT_UP_STATE.replace('### Alpha', '### Zero (zero)\nZ\n\n### Alpha'),
  ).entry;
  const ids = (e) => Object.fromEntries(e.tracks.map((t) => [t.title, t.id]));
  assert.equal(
    ids(moved)['Alpha (alpha) · 2026-10-01 · c1'],
    ids(splitBaseline(NEXT_UP_STATE).entry)['Alpha (alpha) · 2026-10-01 · c1'],
  );
});

test('baselineIdMismatch accepts a split baseline and flags an edit of one track body', () => {
  const { built } = splitBaseline(MULTI_STATE);
  assert.equal(baselineIdMismatch(built.fileName, built.text), null);
  const edited = baselineIdMismatch(built.fileName, built.text.replace('FLOW_BODY', 'EDITED'));
  assert.ok(edited, 'an edited track body is reported');
  assert.equal(edited.inName, built.closeId);
  const done = splitBaseline(MULTI_STATE, { legacyDone: true });
  assert.equal(baselineIdMismatch(done.built.fileName, done.built.text), null);
  assert.deepEqual(
    done.entry.tracks.filter((t) => t.done === true).map((t) => t.id),
    [LEGACY_TRACK_ID],
    'legacyDone: true marks the leftover legacy head only, not the tracks split out of the file',
  );
  assert.notEqual(done.built.closeId, built.closeId);
});

test('done is decided per track id: a split track marked done stays alone, and the id covers which heads are done', () => {
  const ids = splitBaseline(MULTI_STATE).entry.tracks.map((t) => t.id);
  const [, squid, flow] = ids;
  const some = splitBaseline(MULTI_STATE, { legacyDone: [flow] });
  assert.deepEqual(
    some.entry.tracks.filter((t) => t.done === true).map((t) => t.id),
    [flow],
    'only the head whose own id is in the set is done',
  );
  assert.equal(baselineIdMismatch(some.built.fileName, some.built.text), null);
  const other = splitBaseline(MULTI_STATE, { legacyDone: [squid] });
  const both = splitBaseline(MULTI_STATE, { legacyDone: [LEGACY_TRACK_ID, flow] });
  const closeIds = [
    splitBaseline(MULTI_STATE).built.closeId,
    some.built.closeId,
    other.built.closeId,
    both.built.closeId,
    splitBaseline(MULTI_STATE, { legacyDone: true }).built.closeId,
  ];
  assert.equal(new Set(closeIds).size, closeIds.length, 'each done set gets its own id');
  assert.equal(baselineIdMismatch(both.built.fileName, both.built.text), null);
  // A non-state baseline ignores the set.
  assert.deepEqual(baselineOf('hot', { legacyDone: [flow] }).closeId, baselineOf('hot').closeId);
});

test('the next-up heading list has one definition', () => {
  assert.strictEqual(SESSION_STATE_NEXT_HEADINGS, NEXT_UP_HEADINGS);
  assert.ok(NEXT_UP_HEADINGS.includes('Next Up') && NEXT_UP_HEADINGS.includes('다음 이어받기'));
});

// The shapes of real old session-state files (read from the maintainer's vault): which ones are
// cut into tracks and which stay one head.
const tenTracks = [
  'squid 콘솔',
  'NWFW 콘솔 승인 창구',
  'firewall 룰 정본과 인프라',
  'flow',
  '반출과 DB 회신',
  'platform 공통',
  '검토자 슬랙 알림 배포',
  'review',
  'masking',
  'UX 문구',
];
const BACKOFFICE_STATE = [
  '---',
  'type: session-state',
  '---',
  '',
  '## 다음 이어받기',
  '',
  `트랙: ${tenTracks.join(' · ')}. 각 트랙은 아래 \`##\` 절이다.`,
  '',
  ...tenTracks.flatMap((t, i) => [
    `## ${t}${i === 0 ? ' (257차, 2026-10-12)' : i === 9 ? ' (ux-writing)' : ''}`,
    '',
    `BODY_${i}`,
    '',
  ]),
].join('\n');

test('a track list line makes the ## sections it names tracks, all ten of a security-backoffice shaped file', () => {
  const { entry } = splitBaseline(BACKOFFICE_STATE);
  assert.equal(entry.tracks.length, 11, 'the remainder plus ten tracks');
  assert.deepEqual(
    entry.tracks.slice(1).map((t) => entry.bodies[t.id]),
    tenTracks.map((_, i) => (i === 9 ? `\nBODY_9\n` : `\nBODY_${i}\n\n`)),
  );
  assert.equal(
    entry.tracks[10].title,
    'UX 문구 (ux-writing)',
    'the last item ends at the sentence',
  );
});

test('a ## section the list does not name stays in the remainder, a section whose title only starts with an item word does not count', () => {
  const text = [
    '## Next Up',
    '',
    'Tracks: alpha, beta / gamma',
    '',
    '## alpha (1)',
    'A',
    '',
    '## 공통: notes',
    'NOTE_TEXT',
    '',
    '## beta',
    'B',
    '',
    '## betamax',
    'NOT_A_TRACK',
    '',
    '## code state',
    'CODE_STATE',
    '',
  ].join('\n');
  const { entry } = splitBaseline(text);
  assert.deepEqual(
    entry.tracks.map((t) => t.title),
    ['이행 전 기록', 'alpha (1)', 'beta'],
  );
  const rest = entry.bodies[LEGACY_TRACK_ID];
  for (const kept of ['NOTE_TEXT', 'NOT_A_TRACK', 'CODE_STATE', '## 공통: notes']) {
    assert.ok(rest.includes(kept), `${kept} stays in the remainder`);
  }
});

test('a harness-shaped file (numbered ## tracks, ## 공통 notes, no list line) and a csv-decrypt-tool shaped one stay one head', () => {
  const harness = [
    '## 다음 이어받기',
    '',
    'Pick the track by number.',
    '',
    '## 1. codex-recurrence (축): 활성',
    'ONE',
    '',
    '## 2. sub-agent (위임): 대기',
    'TWO',
    '',
    '## 공통: 다섯이 같은 표면을 만진다',
    'COMMON',
    '',
    '## 공통: 정본 위치',
    'WHERE',
    '',
  ].join('\n');
  const csv = [
    '## 다음 이어받기',
    '',
    '1. 먼저 할 일',
    '',
    '## 버킷정책 형태(되돌리지 말 것)',
    'BUCKET',
    '',
    '## 코드 상태',
    'CODE',
    '',
  ].join('\n');
  for (const [name, text] of Object.entries({ harness, csv })) {
    const { entry } = splitBaseline(text);
    assert.deepEqual(
      entry.tracks,
      [{ id: 'legacy', title: '이행 전 기록', new: true }],
      `${name}: one head`,
    );
    assert.equal(entry.bodies.legacy, text, `${name}: whole text`);
  }
});

test('a heading inside an HTML comment is not a track: one line or several', () => {
  const oneLine = NEXT_UP_STATE.replace(
    'ALPHA_BODY\n',
    'ALPHA_BODY\n<!-- ### x\nstill the comment -->\n<!-- ### y -->\n<!--\n### z\n-->\n',
  );
  const { entry } = splitBaseline(oneLine);
  assert.deepEqual(
    entry.tracks.map((t) => t.title),
    ['이행 전 기록', 'Alpha (alpha) · 2026-10-01 · c1', 'Beta (beta) · 2026-10-01 · c2'],
  );
  assert.ok(entry.bodies[entry.tracks[1].id].includes('<!-- ### x'), 'the comment is body text');
  // Without the comment the same lines would be a third and fourth track.
  const bare = splitBaseline(NEXT_UP_STATE.replace('ALPHA_BODY\n', 'ALPHA_BODY\n### x\nX\n'));
  assert.equal(bare.entry.tracks.length, 4);
  // A comment after the closing marker does not swallow the next heading.
  const after = splitBaseline(
    NEXT_UP_STATE.replace('ALPHA_BODY\n', 'ALPHA_BODY\n<!-- note --> trailing\n'),
  );
  assert.equal(after.entry.tracks.length, 3);
});

test('a newer close that replaces one split track leaves the other tracks in the injection', () => {
  const { entry: base } = splitBaseline(MULTI_STATE);
  const flow = base.tracks.find((t) => t.title === 'flow');
  const newer = E('c9', {
    date: '2026-10-13',
    closedAt: '2026-10-13T01:00:00.000Z',
    tracks: [{ id: flow.id, supersedes: [base.closeId] }],
    bodies: { [flow.id]: 'FLOW_REPLACED' },
  });
  const { text, observed } = buildInjection(M([base, newer]), 20000);
  for (const keep of ['SQUID_BODY', 'REVIEW_BODY', '트랙: squid 콘솔']) {
    assert.ok(text.includes(keep), `${keep} still in the injection`);
  }
  assert.ok(text.includes('FLOW_REPLACED') && !text.includes('FLOW_BODY'));
  const squid = base.tracks.find((t) => t.title.startsWith('squid')).id;
  assert.deepEqual(observed.heads[squid], [base.closeId]);
  assert.deepEqual(observed.heads[flow.id], ['c9']);
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

test('GITATTRIBUTES_BLOCK sets merge=union on a depth-1 session-log shard and on log.md, nothing else', () => {
  withVault({ '.gitattributes': GITATTRIBUTES_BLOCK }, (dir) => {
    const attr = (rel) => git(dir, ['check-attr', 'merge', '--', rel]).stdout.trim();
    assert.equal(
      attr('projects/p/session-log/2026-10-01.md'),
      'projects/p/session-log/2026-10-01.md: merge: union',
    );
    // the root log.md is append-only too
    assert.equal(attr('log.md'), 'log.md: merge: union');
    for (const rel of [
      'projects/p/platform/session-log/2026-10-01.md',
      'projects/p/hot.md',
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

test('mergeAdditiveGitignore keeps a line ours appended again after a base negation, so the last rule still wins', () => {
  const base = '*.md\n!secret.md\n';
  // Ours repeats `*.md` at the tail (re-ignoring secret.md); theirs added another pattern.
  assert.deepEqual(mergeAdditiveGitignore(base, `${base}*.md\n`, `${base}/t\n`), {
    ok: true,
    merged: `${base}/t\n*.md\n`,
  });
  // Theirs changed nothing: the repeat still lands after the negation.
  assert.deepEqual(mergeAdditiveGitignore(base, `${base}*.md\n`, base), {
    ok: true,
    merged: `${base}*.md\n`,
  });
  // The pair: both sides appended the same repeat, so one copy is enough.
  assert.deepEqual(mergeAdditiveGitignore(base, `${base}*.md\n`, `${base}*.md\n`), {
    ok: true,
    merged: `${base}*.md\n`,
  });
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

const at = (ms) => new Date(Date.UTC(2026, 9, 1, 4, 0, 0, ms)).toISOString();

test('a same-day close sorts by its closed_at, whatever the supersede depth', () => {
  // x1..x6 is a chain of depth 6; z9 is a later close of another track with depth 1.
  const chain = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((id, i, all) =>
    E(id, {
      closedAt: at(i * 1000),
      tracks: [{ id: 'x', ...(i ? { supersedes: [all[i - 1]] } : {}) }],
    }),
  );
  const last = E('z9', { closedAt: at(60000), tracks: [{ id: 't', done: true }], bodies: {} });
  for (const input of [[...chain, last], reversed([...chain, last]), rotated([...chain, last])]) {
    assert.deepEqual(ids(sortEntries(input)), ['z9', 'x6', 'x5', 'x4', 'x3', 'x2', 'x1']);
  }
});

test('an entry with closed_at sorts before a same-day entry without one', () => {
  const dated = E('z1', { closedAt: at(0) });
  const bare = E('a1');
  // The bare one is first by close id and would win a depth or id tie.
  assert.deepEqual(ids(sortEntries([bare, dated])), ['z1', 'a1']);
  assert.deepEqual(ids(sortEntries([dated, bare])), ['z1', 'a1']);
  assert.equal(
    ids(sortEntries([E('b', { date: '2026-10-02' }), dated]))[0],
    'b',
    'the date still ranks above closed_at',
  );
});

test('closed_at is compared as an instant, not as text', () => {
  // As text `...07Z` sorts after `...07.123Z` ('Z' > '.'), as instants it is earlier.
  const whole = E('a1', { closedAt: '2026-10-01T04:00:07Z' });
  const fraction = E('b1', { closedAt: '2026-10-01T04:00:07.123Z' });
  assert.deepEqual(ids(sortEntries([whole, fraction])), ['b1', 'a1']);
});

test('the same closed_at falls back to supersede depth, then to close id', () => {
  const t = at(0);
  const a1 = E('a1', { closedAt: t });
  const b1 = E('b1', { closedAt: t, tracks: [{ id: 'masking', supersedes: ['a1'] }] });
  const c1 = E('c1', { closedAt: t, tracks: [{ id: 'flow' }] });
  assert.deepEqual(ids(sortEntries([a1, b1, c1])), ['b1', 'a1', 'c1']);
  assert.deepEqual(ids(sortEntries([c1, a1, b1])), ['b1', 'a1', 'c1']);
});

test('closed_at round-trips through format and parse; an entry without it still parses', () => {
  const closedAt = '2026-10-12T04:31:07.123Z';
  const text = formatSessionEntry(sample({ closedAt }));
  assert.ok(text.includes(`\nclosed_at: ${closedAt}\n`));
  assert.equal(parseSessionEntry(text).entry.closedAt, closedAt);
  const bare = formatSessionEntry(sample());
  assert.ok(!bare.includes('closed_at'));
  assert.equal(parseSessionEntry(bare).entry.closedAt, undefined);
  for (const bad of ['2026-10-12', '2026-10-12T04:31:07+09:00', '2026-13-45T25:61:61Z', 7]) {
    assert.throws(() => formatSessionEntry(sample({ closedAt: bad })), { code: 'invalid-entry' });
  }
  const forged = text.replace(closedAt, '2026-10-12 04:31');
  assert.deepEqual(parseSessionEntry(forged), { ok: false, reason: 'bad-closed_at' });
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

test('entryScope, when a string, replaces every entry own scope; without it the entry own scope decides', () => {
  const own = [E('c1', { visibilityScope: 'machine:devB' }), E('c2')];
  // no entry_scope: the entry's own scope decides
  const plain = M(own);
  assert.deepEqual(ids(nextUpItems(plain, { device: 'devA' })), ['c2']);
  assert.deepEqual(ids(nextUpItems(plain, { device: 'devB' })), ['c1', 'c2']);
  // an explicit entry_scope: shared reopens an entry scoped to another machine
  const open = M(own, { entryScope: 'shared' });
  assert.deepEqual(ids(nextUpItems(open, { device: 'devA' })), ['c1', 'c2']);
  assert.deepEqual(ids(nextUpItems(open, { device: 'devB' })), ['c1', 'c2']);
  // a narrow entry_scope hides entries whose own scope is shared
  const closed = M(own, { entryScope: 'machine:devB' });
  assert.deepEqual(nextUpItems(closed, { device: 'devA' }), []);
  assert.deepEqual(ids(nextUpItems(closed, { device: 'devB' })), ['c1', 'c2']);
  assert.equal(entryVisible(closed, E('c3'), 'devA'), false);
  assert.equal(entryVisible(closed, E('c3'), 'devB'), true);
  assert.equal(entryVisible(open, own[0], 'devA'), true, 'the override reopens it');
  assert.equal(entryVisible(plain, own[0], 'devA'), false, 'without it the own scope closes it');
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

test('isValidProjectName takes any script and rejects whitespace, separators, dot-only, empty and control characters', () => {
  const NFD = '인수인계-runbook'.normalize('NFD');
  for (const ok of [
    'p',
    'my-proj.v2',
    'A_b-1',
    '.hidden',
    '인수인계-runbook',
    NFD,
    '日本語',
    'né_é',
    'x1',
    '7',
  ]) {
    assert.equal(isValidProjectNameHook(ok), true, JSON.stringify(ok));
  }
  const bad = [
    '',
    '.',
    '..',
    '...',
    '-',
    '_-_',
    'a/b',
    'a\\b',
    'a b',
    '인수 인계',
    'a\tb',
    'a\nb',
    'a\u0000b',
    'a\u0001b',
    'a\u007fb',
    'a\u200bb',
    'a#b',
    '../x',
  ];
  for (const name of bad) assert.equal(isValidProjectNameHook(name), false, JSON.stringify(name));
  for (const notString of [undefined, null, 42, {}, ['p']]) {
    assert.equal(isValidProjectNameHook(notString), false, String(notString));
  }
});

test('a Korean project name round-trips through formatSessionEntry and parseSessionEntry', () => {
  for (const project of ['인수인계-runbook', '인수인계-runbook'.normalize('NFD'), '日本語.v2']) {
    const text = formatSessionEntry(sample({ project }));
    assert.ok(text.includes(`\nproject: ${project}\n`), 'written unquoted');
    const r = parseSessionEntry(text);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.entry.project, project);
  }
  assert.throws(() => formatSessionEntry(sample({ project: '인수 인계' })), /invalid project/);
  const forged = formatSessionEntry(sample()).replace('\nproject: p\n', '\nproject: 인수 인계\n');
  assert.deepEqual(parseSessionEntry(forged), { ok: false, reason: 'bad-project' });
  assert.equal(isSessionProjectDir({ slug: '인수인계-runbook', hasIndex: true }), true);
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

test('the root table lists the rows in sortRootRows order in the shape resolveActiveProject reads', () => {
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
  assert.equal(
    tableOf(root),
    [
      '| Project | Last Session | Hot Cache |',
      ...rows.map((r) => `| ${r.slug} | ${r.date} | [[projects/${r.slug}/hot]] |`),
    ].join('\n'),
  );
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
  const model = M(baselineEntries({ stateText: state }));
  const [item] = nextUpItems(model);
  const split = splitLegacyFrontmatter(state);
  assert.equal(item.body, split.body);
  assert.ok(item.body.includes('## Notes') && item.body.includes('last line of the old file'));
  assert.equal(item.legacyFrontmatter, split.frontmatter);
  assert.ok(item.legacyFrontmatter.includes('machine_note: next, finish the masking pipeline'));
});

test('a baseline head folds the old frontmatter into <details> and the body starts without it', () => {
  const model = M(baselineEntries());
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
  const out = renderViews([M(baselineEntries({ stateText: state }))]).projects.p.sessionState;
  assert.ok(out.includes('````yaml'), 'the fence is longer than any backtick run inside');
});

test('generated text holds no em dash or en dash', () => {
  const model = M([
    E('c1'),
    E('c2', { tracks: [{ id: 'flow', title: 'Flow', done: true }], bodies: {} }),
    ...baselineEntries(),
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

test('a done-only close of one track still reaches the injection as the latest session', () => {
  // The QA repro: a deep chain on track x, then a later close that only finishes track t.
  const chain = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((id, i, all) =>
    E(id, {
      closedAt: at(i * 1000),
      tracks: [{ id: 'x', title: 'X', ...(i ? { supersedes: [all[i - 1]] } : {}) }],
      bodies: { x: `body of ${id}` },
      summary: `summary of ${id}`,
    }),
  );
  const t0 = E('t0', { closedAt: at(100), tracks: [{ id: 't', title: 'T' }], bodies: { t: 'T0' } });
  const last = E('last', {
    closedAt: at(60000),
    tracks: [{ id: 't', done: true, supersedes: ['t0'] }],
    bodies: {},
    summary: 'summary of last',
  });
  const { text } = buildInjection(M([...chain, t0, last]), 4000);
  const latest = text.split('## Latest session')[1].split('\n## ')[0];
  assert.ok(
    latest.includes('### 2026-10-01 · last'),
    `latest session is the newest close: ${latest}`,
  );
  assert.ok(text.includes('summary of last'));
  assert.ok(text.includes('body of x6'));
});

test('the pointer target follows migration: entry file before, session-state.md after, baseline always session-state.md', () => {
  const real = E('c1', { date: '2026-10-02', bodies: { masking: 'R'.repeat(9000) } });
  const base = baselineEntries()[1];
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
  const model = M(baselineEntries());
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

// Disabling the defense: in `listSessionProjects` (hooks/hypo-shared.mjs) make the catch return
// `[]` for every error (delete the `throw err`). The EACCES assertion goes red.
test('listSessionProjects: no projects/ is no projects, but a projects/ it cannot read throws', () => {
  withTmpDir((dir) => {
    assert.deepEqual(listSessionProjects(dir), [], 'ENOENT');
    writeFileSync(join(dir, 'projects'), 'a file, not a directory\n');
    assert.deepEqual(listSessionProjects(dir), [], 'ENOTDIR');
  });
  if (process.getuid?.() === 0) return; // root reads a mode 000 directory
  withTmpDir((dir) => {
    put(dir, 'projects/p/index.md', 'x');
    chmodSync(join(dir, 'projects'), 0o000);
    try {
      assert.throws(() => listSessionProjects(dir), { code: 'EACCES' });
    } finally {
      chmodSync(join(dir, 'projects'), 0o755);
    }
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

test('before the move the model holds one virtual baseline per old file and nothing on disk changes', () => {
  withOldVault((dir) => {
    putEntry(dir, 'p', 'c1');
    const model = loadSessionModel(dir, 'p');
    assert.equal(model.migrated, false);
    const bases = model.entries.filter((e) => isBaselineId(e.closeId));
    assert.equal(bases.length, 2, 'one virtual baseline entry per old file');
    const hot = bases.find((e) => e.summary !== '');
    const state = bases.find((e) => e.bodies[LEGACY_TRACK_ID] !== undefined);
    assert.ok(hot && state && hot !== state);
    assert.equal(hot.summary, OLD_HOT_FILE);
    assert.equal(state.bodies[LEGACY_TRACK_ID], OLD_STATE_FILE);
    assert.equal(hot.date, '2026-09-25');
    assert.equal(state.date, '2026-09-25');
    assert.equal(hot.visibilityScope, 'machine:devA', 'the hot file is machine-scoped');
    assert.equal(state.visibilityScope, null, 'the state file is not: its entry stays shared');
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

test('projectEntryScope: the narrowest of index.md and the state baseline, or the entry_scope as written', () => {
  withOldVault((dir) => {
    put(dir, 'projects/p/index.md', '---\nvisibility_scope: shared\n---\n');
    // only the old hot.md is machine-scoped: the shared state file keeps new entries shared
    assert.equal(projectEntryScope(dir, 'p', loadSessionModel(dir, 'p')), 'shared');
    assert.equal(projectEntryScope(dir, 'p'), 'shared', 'model is optional');
    put(dir, 'projects/p/index.md', '---\nvisibility_scope: shared\nentry_scope: shared\n---\n');
    assert.equal(projectEntryScope(dir, 'p'), 'shared', 'entry_scope skips the calculation');
  });
  withOldVault(
    (dir) => {
      put(dir, 'projects/p/index.md', '---\nvisibility_scope: shared\n---\n');
      assert.equal(projectEntryScope(dir, 'p'), 'machine:devA', 'the state file is machine-scoped');
    },
    {
      'projects/p/session-state.md': OLD_STATE_FILE.replace(
        'machine_note: keep me',
        'machine_note: keep me\nvisibility_scope: machine:devA',
      ),
    },
  );
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
  // A migrated git vault: a vault with no git moves such a file into a baseline entry instead.
  withMigratedVault((dir) => {
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

// Disabling the defense: in `writeOneView` (hooks/session-views.mjs) wrap the first
// `backUpGeneratedPath(...)` call in `try { ... } catch {}`. The view is then overwritten with no
// copy of the bytes, and the first assertion goes red.
test('a backup that cannot be written stops the write: the unowned bytes stay in place and no record claims them', () => {
  withMigratedVault((dir) => {
    seedProjects(dir);
    put(dir, VIEW, 'hand written\n');
    assert.throws(
      () =>
        writeGeneratedViews(dir, {
          ...WRITE,
          testHooks: {
            beforeBackupWrite: () => {
              throw new Error('backup disk full');
            },
          },
        }),
      /backup disk full/,
    );
    assert.equal(readRel(dir, VIEW), 'hand written\n', 'the view was not overwritten');
    assert.equal(existsSync(join(dir, BACKUP_DIR, `${VIEW}.pre-projection-backup.md`)), false);
    const record = existsSync(join(dir, '.cache/generated-views.json'))
      ? JSON.parse(readRel(dir, '.cache/generated-views.json')).views
      : {};
    assert.equal(
      record[VIEW],
      undefined,
      'the record does not vouch for bytes the writer never wrote',
    );
    // The retry with a working backup converges: one backup, then the replacement.
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.backedUp.length, 1, JSON.stringify(r.backedUp));
    assert.equal(readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`), 'hand written\n');
    assert.match(readRel(dir, VIEW), /generated: sessions/);
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

// ── a vault that is not a git repository: the old files move into baseline entries ───────────

const gitlessBaselines = (dir, slug = 'p') => {
  try {
    return readdirSync(join(dir, 'projects', slug, 'sessions'))
      .filter((n) => /-baseline-[0-9a-f]{16}\.md$/.test(n))
      .sort();
  } catch {
    return [];
  }
};
const gitlessLegacyVault = (dir, extra = {}) => {
  put(dir, 'projects/p/index.md', '---\ntitle: p\n---\n');
  put(dir, 'projects/p/hot.md', OLD_HOT_FILE);
  put(dir, 'projects/p/session-state.md', OLD_STATE_FILE);
  for (const [rel, text] of Object.entries(extra)) put(dir, rel, text);
};

test('a vault with no git moves its old files into two baseline entries before the first write, and backs nothing up', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    assert.equal(migrationState(dir), 'migrated', 'no git: nothing is tracked');
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.backedUp, [], 'the old files are not unowned bytes');
    const names = gitlessBaselines(dir);
    assert.equal(names.length, 2);
    const entries = names.map((n) => parseSessionEntry(readRel(dir, `projects/p/sessions/${n}`)));
    assert.deepEqual(
      entries.map((e) => e.ok),
      [true, true],
    );
    assert.deepEqual(entries.map((e) => e.entry.summary).sort(), ['', OLD_HOT_FILE].sort());
    assert.ok(entries.some((e) => e.entry.bodies[LEGACY_TRACK_ID] === OLD_STATE_FILE));
    // the views are rendered from the entries, so the old content is in them
    assert.match(readRel(dir, 'projects/p/session-state.md'), /old state body/);
    assert.match(readRel(dir, 'projects/p/hot.md'), /old hot body/);
    assert.match(readRel(dir, 'projects/p/hot.md'), /generated: sessions/);
    assert.equal(existsSync(join(dir, BACKUP_DIR)), false, 'no backup directory was made');
    // the same entries a git vault's move makes: one model, the old state body as the head
    const model = loadSessionModel(dir, 'p');
    assert.equal(model.entries.filter((e) => isBaselineId(e.closeId)).length, 2);
    assert.equal(nextUpItems(model).length, 1);
  });
});

test('the move in a vault with no git is idempotent: a second write moves and rewrites nothing', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    writeGeneratedViews(dir, WRITE);
    const names = gitlessBaselines(dir);
    const before = names.map((n) => readRel(dir, `projects/p/sessions/${n}`));
    const record = readRel(dir, '.cache/generated-views.json');
    const second = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.backedUp, []);
    assert.deepEqual(gitlessBaselines(dir), names);
    assert.deepEqual(
      gitlessBaselines(dir).map((n) => readRel(dir, `projects/p/sessions/${n}`)),
      before,
    );
    assert.equal(readRel(dir, '.cache/generated-views.json'), record);
  });
});

test('in a vault with no git, each old file keeps its own scope and the moved bytes are the old bytes', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir, {
      'projects/p/session-state.md': OLD_STATE_FILE.replace(
        'machine_note: keep me',
        'machine_note: keep me\nvisibility_scope: machine:devB',
      ),
    });
    writeGeneratedViews(dir, WRITE);
    const scopes = Object.fromEntries(
      gitlessBaselines(dir).map((n) => {
        const { entry } = parseSessionEntry(readRel(dir, `projects/p/sessions/${n}`));
        return [entry.summary === '' ? 'state' : 'hot', entry.visibilityScope];
      }),
    );
    assert.deepEqual(scopes, { hot: 'machine:devA', state: 'machine:devB' });
    // devA sees the hot file only, devB the state file only: neither hides the other
    const sees = (device) => {
      const m = loadSessionModel(dir, 'p');
      return renderViews([m], { device }).projects.p;
    };
    assert.match(sees('devA').hot, /old hot body/);
    assert.doesNotMatch(sees('devA').sessionState, /old state body/);
    assert.match(sees('devB').sessionState, /old state body/);
    assert.doesNotMatch(sees('devB').hot, /old hot body/);
  });
});

test('in a vault with no git, entry_scope replaces the scope of an old file, and without it the old file scope decides', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir, {
      'projects/p/session-state.md': OLD_STATE_FILE.replace(
        'machine_note: keep me',
        'machine_note: keep me\nvisibility_scope: shared',
      ),
    });
    writeGeneratedViews(dir, WRITE);
    const sees = (device) => renderViews([loadSessionModel(dir, 'p')], { device }).projects.p;
    // the hot baseline is machine:devA, the state baseline is shared
    assert.match(sees('devA').hot, /old hot body/);
    assert.doesNotMatch(
      sees('devB').hot,
      /old hot body/,
      'without entry_scope its own scope decides',
    );
    assert.match(sees('devB').sessionState, /old state body/, 'the shared one stays visible');
    put(dir, 'projects/p/index.md', '---\ntitle: p\nentry_scope: shared\n---\n');
    assert.match(sees('devA').hot, /old hot body/);
    assert.match(sees('devB').hot, /old hot body/, 'an explicit entry_scope: shared reopens it');
    assert.match(sees('devB').sessionState, /old state body/);
    put(dir, 'projects/p/index.md', '---\ntitle: p\nentry_scope: machine:devA\n---\n');
    assert.match(sees('devA').hot, /old hot body/);
    assert.match(sees('devA').sessionState, /old state body/);
    assert.doesNotMatch(
      sees('devB').sessionState,
      /old state body/,
      'a narrow entry_scope hides a shared entry',
    );
  });
});

test('a stale pending slug for a project whose move completed neither baselines a later edit nor survives', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    writeGeneratedViews(dir, WRITE);
    const names = gitlessBaselines(dir);
    assert.equal(names.length, 2, 'the move happened');
    put(dir, VIEW, 'typed over the view\n');
    const pendingFile = join(dir, '.cache', 'legacy-move-pending.json');
    writeFileSync(pendingFile, JSON.stringify({ slugs: ['p'] }));
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.backedUp.length, 1, 'the edit is backed up');
    assert.equal(r.backedUp[0].relPath, VIEW);
    assert.equal(
      readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`),
      'typed over the view\n',
    );
    assert.deepEqual(gitlessBaselines(dir), names, 'no new baseline');
    assert.equal(existsSync(pendingFile), false, 'the stale slug is gone');
  });
});

test('a file edited after the move in a vault with no git is backed up like any foreign bytes, not turned into a baseline', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    writeGeneratedViews(dir, WRITE);
    const names = gitlessBaselines(dir);
    put(dir, VIEW, 'typed over the view\n');
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.backedUp.length, 1);
    assert.equal(r.backedUp[0].relPath, VIEW);
    assert.equal(
      readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`),
      'typed over the view\n',
    );
    assert.deepEqual(gitlessBaselines(dir), names, 'no third baseline');
  });
});

test('a vault with no git that was never given old files treats a later hand edit as foreign bytes, with no baseline', () => {
  withTmpDir((dir) => {
    seedProjects(dir);
    writeGeneratedViews(dir, WRITE); // the record exists from here on
    put(dir, VIEW, 'hand written\n');
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(r.backedUp.length, 1);
    assert.deepEqual(gitlessBaselines(dir), []);
  });
});

test('every baseline already on disk but no record (a move that stopped before the record) claims the old files and moves nothing again', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    writeGeneratedViews(dir, WRITE);
    assert.match(
      consumeRootHotHealthNotice(dir) ?? '',
      /기준선/,
      'the first run tells of the move',
    );
    const names = gitlessBaselines(dir);
    assert.equal(names.length, 2, 'one baseline per old file');
    // The state a run killed after writing the entries leaves: the old files as they were, no record.
    unlinkSync(join(dir, '.cache', 'generated-views.json'));
    put(dir, 'projects/p/hot.md', OLD_HOT_FILE);
    put(dir, 'projects/p/session-state.md', OLD_STATE_FILE);
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(gitlessBaselines(dir), names, 'no second pair of baselines');
    // the entries hold the old bytes whole, so the views replace them without a backup
    assert.deepEqual(r.backedUp, []);
    assert.equal(existsSync(join(dir, '.cache', 'generated-views.json')), true);
    assert.match(readRel(dir, 'projects/p/hot.md'), /generated: sessions/);
    assert.equal(consumeRootHotHealthNotice(dir), null, 'no backup notice');
  });
});

test('a move that wrote only some of its baselines writes the missing ones and backs up nothing', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    writeGeneratedViews(dir, WRITE);
    consumeRootHotHealthNotice(dir);
    const names = gitlessBaselines(dir);
    // Killed between the two baseline writes: the state baseline is missing and there is no record.
    const stateName = names.find((n) =>
      readRel(dir, `projects/p/sessions/${n}`).includes('legacy'),
    );
    assert.ok(stateName, names.join(', '));
    unlinkSync(join(dir, 'projects', 'p', 'sessions', stateName));
    unlinkSync(join(dir, '.cache', 'generated-views.json'));
    put(dir, 'projects/p/hot.md', OLD_HOT_FILE);
    put(dir, 'projects/p/session-state.md', OLD_STATE_FILE);
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(gitlessBaselines(dir), names, 'the missing baseline is back, nothing else');
    assert.deepEqual(r.backedUp, [], 'the state file is not backed up as foreign bytes');
    const notice = consumeRootHotHealthNotice(dir) ?? '';
    assert.ok(notice.includes(stateName), 'the notice names the baseline it wrote');
    assert.equal(notice.includes('pre-projection-backup'), false, notice);
    assert.match(
      readRel(dir, `projects/p/sessions/${stateName}`),
      /old state body/,
      'the old state is in its baseline',
    );
  });
});

test('a baseline name already taken by other bytes stops the move for that project: old files untouched, nothing claimed, the notice names the path', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir);
    writeGeneratedViews(dir, WRITE);
    consumeRootHotHealthNotice(dir);
    const names = gitlessBaselines(dir);
    const hotName = names.find((n) => !readRel(dir, `projects/p/sessions/${n}`).includes('legacy'));
    assert.ok(hotName, names.join(', '));
    const clashPath = `projects/p/sessions/${hotName}`;
    // the state of a first start whose baseline name already holds other bytes
    unlinkSync(join(dir, '.cache', 'generated-views.json'));
    put(dir, clashPath, 'NOT THE BASELINE, someone else wrote this\n');
    put(dir, 'projects/p/hot.md', OLD_HOT_FILE);
    put(dir, 'projects/p/session-state.md', OLD_STATE_FILE);
    const r = writeGeneratedViews(dir, WRITE);
    assert.equal(readRel(dir, 'projects/p/hot.md'), OLD_HOT_FILE, 'the old hot.md is untouched');
    assert.equal(readRel(dir, 'projects/p/session-state.md'), OLD_STATE_FILE);
    assert.equal(readRel(dir, clashPath), 'NOT THE BASELINE, someone else wrote this\n');
    assert.deepEqual(r.backedUp, [], 'nothing was backed up: nothing was replaced');
    assert.equal(existsSync(join(dir, BACKUP_DIR)), false);
    assert.equal(r.written.includes('projects/p/hot.md'), false, JSON.stringify(r.written));
    const record = JSON.parse(readRel(dir, '.cache/generated-views.json')).views;
    assert.equal(record['projects/p/hot.md'], undefined, 'the old file is not claimed');
    assert.equal(record['projects/p/session-state.md'], undefined);
    assert.ok(
      (consumeRootHotHealthNotice(dir) ?? '').includes(clashPath),
      'the notice names the conflicting path',
    );
    // the clash resolved: the next write finishes the move without a backup
    unlinkSync(join(dir, clashPath));
    const again = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(again.backedUp, []);
    assert.equal(gitlessBaselines(dir).length, 2);
    assert.match(readRel(dir, 'projects/p/hot.md'), /generated: sessions/);
    assert.match(readRel(dir, 'projects/p/hot.md'), /old hot body/);
  });
});

test('a project hidden by .hypoignore on the first write and visible later is moved on the write that first sees it, without a backup', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir, { '.hypoignore': 'projects/p/\n' });
    writeGeneratedViews(dir, WRITE);
    assert.deepEqual(gitlessBaselines(dir), [], 'hidden: not touched');
    assert.equal(readRel(dir, 'projects/p/hot.md'), OLD_HOT_FILE);
    assert.equal(
      existsSync(join(dir, '.cache', 'generated-views.json')),
      true,
      'the record exists',
    );
    unlinkSync(join(dir, '.hypoignore'));
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.backedUp, [], 'the old bytes are not set aside as foreign');
    assert.equal(existsSync(join(dir, BACKUP_DIR)), false);
    assert.equal(gitlessBaselines(dir).length, 2);
    const model = loadSessionModel(dir, 'p');
    assert.equal(model.entries.filter((e) => isBaselineId(e.closeId)).length, 2);
    assert.match(readRel(dir, 'projects/p/hot.md'), /old hot body/);
    assert.match(readRel(dir, 'projects/p/session-state.md'), /old state body/);
    // once moved it is an ordinary project: a later edit is foreign bytes and no baseline
    put(dir, VIEW, 'typed over the view\n');
    assert.equal(writeGeneratedViews(dir, WRITE).backedUp.length, 1);
    assert.equal(gitlessBaselines(dir).length, 2);
  });
});

test('a generated view left over without a record is not read as an old file, and a hidden project is not touched', () => {
  withTmpDir((dir) => {
    gitlessLegacyVault(dir, {
      'projects/p/hot.md':
        '---\ntype: reference\ngenerated: sessions\n---\nwritten by a generator\n',
      'projects/p/session-state.md': '',
      '.hypoignore': 'projects/secret/\n',
      'projects/secret/index.md': '---\ntitle: secret\n---\n',
      'projects/secret/hot.md': 'secret hot\n',
    });
    writeGeneratedViews(dir, WRITE);
    assert.deepEqual(
      gitlessBaselines(dir),
      [],
      'a generated file and an empty one are not old memory',
    );
    assert.deepEqual(gitlessBaselines(dir, 'secret'), []);
    assert.equal(readRel(dir, 'projects/secret/hot.md'), 'secret hot\n');
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

// Disabling: in `writeOneView` (hooks/session-views.mjs) remove the `writeRootHotHealthNotice`
// condition in `backUp` (`if (false && !writeRootHotHealthNotice(...))`) and the notice is never
// written for the first view, because the batch fails before any aggregate. The notice assertion
// goes red: the first view's hand edit is backed up and replaced, then the second view fails.
test('a hand edit backed up before a later view fails is named in the notice anyway', () => {
  withMigratedVault((dir) => {
    seedProjects(dir);
    put(dir, VIEW, 'hand written\n');
    assert.throws(
      () =>
        writeGeneratedViews(dir, {
          ...WRITE,
          testHooks: {
            beforeFinalWrite: (abs) => {
              if (abs.endsWith('projects/p/session-state.md')) throw new Error('disk full');
            },
          },
        }),
      /disk full/,
    );
    assert.equal(readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`), 'hand written\n');
    assert.match(readRel(dir, VIEW), /generated: sessions/, 'the first view was replaced');
    const notice = consumeRootHotHealthNotice(dir);
    assert.ok(notice?.includes(VIEW) && notice.includes('pre-projection-backup'), notice);
  });
});

// Disabling: in `writeOneView` delete the `throw new Error(...)` line after the notice write in
// `backUp`. The view is then replaced with no notice, and the throws and bytes assertions go red.
test('a backup whose notice cannot be written stops the replacement of its view', () => {
  withMigratedVault((dir) => {
    seedProjects(dir);
    put(dir, VIEW, 'hand written\n');
    mkdirSync(join(dir, '.cache', 'root-hot-projection-notice.json'), { recursive: true });
    assert.throws(
      () => writeGeneratedViews(dir, WRITE),
      /notice for the backup of projects\/p\/hot\.md/,
    );
    assert.equal(readRel(dir, VIEW), 'hand written\n', 'the hand edit is still in place');
    assert.equal(readRel(dir, `${BACKUP_DIR}/${VIEW}.pre-projection-backup.md`), 'hand written\n');
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
      const remote = buildLegacyBaselines({
        hotText: OLD_HOT_FILE,
        stateText: OLD_STATE_FILE,
        date: '2026-09-25',
        project: 'p',
        scopes: {
          index: null,
          hot: readVisibilityScope(OLD_HOT_FILE),
          state: readVisibilityScope(OLD_STATE_FILE),
        },
        legacyDone: opts.migrate?.legacyDone === true,
      });
      for (const r of remote) put(a, `projects/p/sessions/${r.fileName}`, r.text);
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

test('restoreGitignoreLines appends a line that only appears above a later negation, and a second call adds nothing', () => {
  withTmpDir((dir) => {
    put(dir, '.gitignore', '*.md\n!secret.md\n');
    assert.deepEqual(restoreGitignoreLines(dir, ['*.md']), ['*.md']);
    assert.equal(readRel(dir, '.gitignore'), '*.md\n!secret.md\n*.md\n', 'the rule is back last');
    assert.deepEqual(restoreGitignoreLines(dir, ['*.md']), [], 'now it is in force: no repeat');
    // The pair: a line that already sits after the last negation is not added again.
    put(dir, '.gitignore', '!secret.md\n*.md\n');
    assert.deepEqual(restoreGitignoreLines(dir, ['*.md']), []);
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

// A pure addition, so the old rule set it aside: the lines went back to the work tree only and the
// saved bytes were deleted, which left the stage empty. Disabling: in `clearBlockingPaths`
// (hooks/hypo-shared.mjs) change `if (staged.has('.gitignore') && blocked.includes('.gitignore')) {`
// to `if (false) {`. The deferral, stage and backup assertions go red.
test('(c3) a .gitignore with one line staged and another unstaged defers, with the stage, the tree and the backups untouched', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    put(b, '.gitignore', '.cache/\nstaged-line/\n');
    cgitOk(b, ['add', '.gitignore']);
    put(b, '.gitignore', '.cache/\nstaged-line/\nunstaged-line/\n');
    const head = headOf(b);
    const r = clear(b);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.deferred, 'gitignore');
    assert.equal(r.reason, 'gitignore-staged');
    assert.ok(r.notice.includes('.gitignore'));
    assert.equal(headOf(b), head);
    assert.equal(
      cgitOk(b, ['show', ':.gitignore']),
      '.cache/\nstaged-line/\n',
      'the stage is intact',
    );
    assert.equal(readRel(b, '.gitignore'), '.cache/\nstaged-line/\nunstaged-line/\n');
    assert.equal(readRel(b, 'projects/p/hot.md'), W1, 'nothing is archived');
    assert.equal(backupsIn(b, 'projects/p/hot.md').length, 0);
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), false, 'no record');
    assert.equal(existsSync(join(b, '.cache', 'backups')), false, 'and no backup');
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
  withMigratedVault((dir) => {
    // The head of the sentence names the view itself; the backup path later in it contains the
    // same words, so a match anywhere in the sentence would not tell the two apart.
    const rootSentence = rootHotBackupRecoveryNotice(
      'hot.md',
      join(dir, '.cache/backups/hot.md.pre-projection-backup.md'),
    );
    assert.ok(rootSentence.startsWith('생성 파일 `hot.md`에 '), rootSentence);
    assert.match(rootSentence, /`projects\/<프로젝트>\/notes\.md`/);
    assert.match(rootSentence, /\.cache\/backups\/hot\.md\.pre-projection-backup\.md/);
    seedProjects(dir);
    put(dir, VIEW, 'hand written\n');
    writeGeneratedViews(dir, WRITE);
    const notice = consumeRootHotHealthNotice(dir) ?? '';
    assert.ok(notice.startsWith(`생성 파일 \`${VIEW}\`에 `), notice);
    assert.match(notice, /`projects\/p\/notes\.md`/);
    assert.match(notice, /\.cache\/backups\/projects\/p\/hot\.md\.pre-projection-backup\.md/);
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

// `b` is migrated and holds the views of a project `q` that the rollback commit from `a` knows
// nothing about. `marked` puts the off marker into that commit; `owned` records q/session-state.md
// as bytes this machine's generator wrote.
function withRollbackRange(fn, { marked, owned }) {
  withCatchUp(({ a, b }) => {
    cgitOk(b, ['merge', '-q', '--ff-only', '@{u}']);
    put(b, 'projects/q/index.md', '---\ntitle: q\n---\n');
    put(b, 'projects/q/hot.md', 'q hot, written by hand\n');
    put(b, 'projects/q/session-state.md', 'q state, generator bytes\n');
    if (owned) {
      put(
        b,
        '.cache/generated-views.json',
        JSON.stringify({
          views: { 'projects/q/session-state.md': sha('q state, generator bytes\n') },
        }),
      );
    }
    cgitOk(a, ['pull', '-q']);
    put(a, '.gitignore', '.cache/\n');
    put(a, 'projects/p/hot.md', 'rolled back hot\n');
    const added = ['.gitignore', 'projects/p/hot.md'];
    if (marked) {
      put(a, SESSION_ENTRIES_OFF_MARKER, 'rolled back to abc on 2026-10-01\n');
      added.push(SESSION_ENTRIES_OFF_MARKER);
    }
    cgitOk(a, ['add', '-f', ...added]);
    cgitOk(a, ['commit', '-q', '-m', 'rollback']);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['fetch', '-q']);
    fn({ b });
  });
}

test('a rollback range clears the views of a project it does not track: owned bytes are dropped, others are backed up first', () => {
  withRollbackRange(
    ({ b }) => {
      const r = clear(b);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(
        r.cleared.map((c) => c.relPath),
        ['projects/q/hot.md'],
        'only the bytes the generator did not write are backed up',
      );
      assert.equal(readFileSync(r.cleared[0].backupPath, 'utf-8'), 'q hot, written by hand\n');
      assert.equal(ffTo(b), 0);
      assert.equal(existsSync(join(b, 'projects/q/hot.md')), false);
      assert.equal(existsSync(join(b, 'projects/q/session-state.md')), false);
      assert.equal(cgitOk(b, ['status', '--porcelain', '-uall']).trim(), '?? projects/q/index.md');
    },
    { marked: true, owned: true },
  );
});

test('a range without the off marker leaves the views of other projects where they are', () => {
  withRollbackRange(
    ({ b }) => {
      const r = clear(b);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.cleared, []);
      assert.equal(ffTo(b), 0);
      assert.equal(readRel(b, 'projects/q/hot.md'), 'q hot, written by hand\n');
      assert.equal(readRel(b, 'projects/q/session-state.md'), 'q state, generator bytes\n');
    },
    { marked: false, owned: true },
  );
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

test('(g) a hot.md that differs from the remote baseline becomes a new committed baseline, and the unchanged state file makes none', () => {
  withCatchUp(({ b, remote }) => {
    put(b, 'projects/p/hot.md', W1);
    const pre = catchUpAndMerge(b);
    assert.deepEqual(baselinesOf(b), remote.map((r) => r.fileName).sort());
    const before = commitCount(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.equal(shared.created.length, 1);
    assert.match(
      shared.created[0],
      /^projects\/p\/sessions\/2026-09-25-baseline-[0-9a-f]{16}\.md$/,
    );
    assert.equal(baselinesOf(b).length, 3);
    assert.equal(commitCount(b), before + 1, 'one commit');
    assert.equal(pathInHead(b, shared.created[0]), true);
    assert.equal(parseSessionEntry(readRel(b, shared.created[0])).entry.summary, W1);
    assert.equal(legacyHeads(b).length, 1, 'a hot baseline has no legacy track');
    assert.ok(shared.notices.some((n) => n.includes(shared.created[0])));
  });
});

test('(g) a session-state.md that differs from the remote baseline becomes a second legacy head, and the unchanged hot file makes none', () => {
  withCatchUp(({ b, remote }) => {
    put(b, 'projects/p/session-state.md', OLD_STATE_FILE.replace('old state body', 'local state'));
    const pre = catchUpAndMerge(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.equal(shared.created.length, 1);
    const made = parseSessionEntry(readRel(b, shared.created[0])).entry;
    assert.match(made.bodies[LEGACY_TRACK_ID], /local state/);
    assert.equal(made.summary, '');
    assert.equal(baselinesOf(b).length, remote.length + 1);
    assert.equal(legacyHeads(b).length, 2);
  });
});

test('(g) a session-state.md with a section per track becomes one split baseline, and sharing it again makes none', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/session-state.md', MULTI_STATE);
    const pre = catchUpAndMerge(b);
    const shared = shareLegacyBytes(b, pre.archived);
    assert.equal(shared.created.length, 1, JSON.stringify(shared));
    const made = parseSessionEntry(readRel(b, shared.created[0])).entry;
    assert.deepEqual(
      made.tracks.map((t) => t.title),
      ['이행 전 기록', 'squid 콘솔 (257차, 2026-10-12)', 'flow', 'review'],
    );
    const again = shareLegacyBytes(b, pre.archived);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.skipped, shared.created);
  });
});

test('(g) a committed split baseline does not swallow a copy whose remainder matches but one track body differs', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/session-state.md', MULTI_STATE);
    const pre = catchUpAndMerge(b);
    const first = shareLegacyBytes(b, pre.archived);
    assert.equal(first.created.length, 1);
    assert.ok(
      cgitOk(b, ['ls-tree', '--name-only', 'HEAD', first.created[0]]).trim(),
      'precondition: the split baseline is committed',
    );
    const edited = MULTI_STATE.replace('FLOW_BODY', 'FLOW_BODY edited on this machine');
    assert.notEqual(edited, MULTI_STATE, 'precondition: one track body differs');
    const backup = join(b, 'held-state.txt');
    writeFileSync(backup, edited);
    const held = [
      {
        relPath: 'projects/p/session-state.md',
        kind: 'worktree',
        backupPath: backup,
        sha256: sha(edited),
      },
    ];
    const shared = shareLegacyBytes(b, held);
    assert.equal(shared.created.length, 1, JSON.stringify(shared));
    const made = parseSessionEntry(readRel(b, shared.created[0])).entry;
    assert.ok(
      Object.values(made.bodies).some((body) => body.includes('FLOW_BODY edited on this machine')),
      'the edited track reaches a baseline',
    );
  });
});

test('(g) only the file this machine set aside becomes a baseline: a stale companion in the other file makes none', () => {
  withCatchUp(({ b, remote }) => {
    // a revision whose session-state.md is not any baseline: what the companion read finds
    put(
      b,
      'projects/p/session-state.md',
      OLD_STATE_FILE.replace('old state body', 'stale companion'),
    );
    commitIn(b);
    const staleRev = headOf(b);
    cgitOk(b, ['reset', '-q', '--hard', 'HEAD~1']);
    catchUpAndMerge(b);
    const backup = join(b, 'held-hot.txt');
    writeFileSync(backup, W1);
    const held = [
      {
        relPath: 'projects/p/hot.md',
        kind: 'worktree',
        backupPath: backup,
        sha256: sha(W1),
        companionRev: staleRev,
      },
    ];
    const shared = shareLegacyBytes(b, held);
    assert.equal(shared.created.length, 1, JSON.stringify(shared));
    const made = parseSessionEntry(readRel(b, shared.created[0])).entry;
    assert.equal(made.summary, W1, 'the hot.md this machine held');
    assert.equal(made.bodies[LEGACY_TRACK_ID], undefined);
    assert.equal(baselinesOf(b).length, remote.length + 1, 'no baseline of the stale companion');
    assert.equal(
      baselinesOf(b).some((n) =>
        readRel(b, `projects/p/sessions/${n}`).includes('stale companion'),
      ),
      false,
    );
  });
});

test('(g) two groups that set aside the same hot.md publish its baseline once', () => {
  withCatchUp(({ b, remote }) => {
    catchUpAndMerge(b);
    const mk = (name, text) => {
      const path = join(b, name);
      writeFileSync(path, text);
      return path;
    };
    const hot = mk('held-hot.txt', W1);
    const state = mk('held-state.txt', OLD_STATE_FILE.replace('old state body', 'held state'));
    const held = [
      { relPath: 'projects/p/hot.md', kind: 'worktree', backupPath: hot, sha256: sha(W1), run: 0 },
      { relPath: 'projects/p/hot.md', kind: 'stage', backupPath: hot, sha256: sha(W1), run: 0 },
      {
        relPath: 'projects/p/session-state.md',
        kind: 'stage',
        backupPath: state,
        sha256: sha(readFileSync(state, 'utf-8')),
        run: 0,
      },
    ];
    const shared = shareLegacyBytes(b, held);
    assert.equal(new Set(shared.created).size, shared.created.length, JSON.stringify(shared));
    assert.equal(shared.created.length, 2, 'one hot baseline, one state baseline');
    assert.equal(baselinesOf(b).length, remote.length + 2);
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
        assert.equal(baselinesOf(b).length, 2, 'the two baselines the remote made');
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
      shared.notices.some(
        (n) =>
          n.startsWith('생성 파일 `hot.md`에 ') &&
          n === rootHotBackupRecoveryNotice('hot.md', backupPath),
      ),
      JSON.stringify(shared.notices),
    );
  });
});

test('(g) a baseline this machine had already folded with done is created but is not a legacy head', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const virtual = loadSessionModel(b, 'p', { state: 'not-migrated' }).entries.find(
      (e) => isBaselineId(e.closeId) && e.bodies[LEGACY_TRACK_ID] !== undefined,
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

const STATE_LOCAL = OLD_STATE_FILE.replace('old state body', 'local state');
const scopeOfEntry = (dir, rel) => parseSessionEntry(readRel(dir, rel)).entry.visibilityScope;

test('shareLegacyBytes: an uncommitted index.md scope can narrow the baseline but never widen it', () => {
  // HEAD's index.md scopes the project to devA; the working tree says shared
  withCatchUp(
    ({ b }) => {
      put(b, 'projects/p/session-state.md', STATE_LOCAL);
      const pre = catchUpAndMerge(b);
      put(b, 'projects/p/index.md', '---\ntitle: p\nvisibility_scope: shared\n---\n');
      const shared = shareLegacyBytes(b, pre.archived);
      assert.equal(shared.created.length, 1, JSON.stringify(shared));
      assert.equal(scopeOfEntry(b, shared.created[0]), 'machine:devA', 'HEAD scope holds');
      assert.equal(pathInHead(b, shared.created[0]), true);
    },
    { seed: { 'projects/p/index.md': '---\ntitle: p\nvisibility_scope: machine:devA\n---\n' } },
  );
  // HEAD's index.md has no scope; the working tree narrows it
  withCatchUp(({ b }) => {
    put(b, 'projects/p/session-state.md', STATE_LOCAL);
    const pre = catchUpAndMerge(b);
    put(b, 'projects/p/index.md', '---\ntitle: p\nvisibility_scope: machine:devB\n---\n');
    const shared = shareLegacyBytes(b, pre.archived);
    assert.equal(shared.created.length, 1, JSON.stringify(shared));
    assert.equal(scopeOfEntry(b, shared.created[0]), 'machine:devB', 'the narrowing applies');
  });
});

test('shareLegacyBytes: the same old text under a different scope is another baseline, and under the same scope is not', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/session-state.md', STATE_LOCAL);
    const pre = catchUpAndMerge(b);
    const withScope = (scope) =>
      put(b, 'projects/p/index.md', `---\ntitle: p\nvisibility_scope: ${scope}\n---\n`);
    withScope('machine:devA');
    const first = shareLegacyBytes(b, pre.archived);
    assert.equal(first.created.length, 1, JSON.stringify(first));
    assert.equal(scopeOfEntry(b, first.created[0]), 'machine:devA');
    withScope('machine:devB');
    const second = shareLegacyBytes(b, pre.archived);
    assert.equal(second.created.length, 1, 'a different scope is a different baseline');
    assert.notEqual(second.created[0], first.created[0]);
    assert.equal(scopeOfEntry(b, second.created[0]), 'machine:devB');
    assert.equal(pathInHead(b, second.created[0]), true);
    const third = shareLegacyBytes(b, pre.archived);
    assert.deepEqual(third.created, [], 'the same text and scope is shared once');
  });
});

test('shareLegacyBytes returns the members it could not share: a changed backup and a conflicting destination', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/session-state.md', STATE_LOCAL);
    const pre = catchUpAndMerge(b);
    const [view] = pre.archived;
    const original = readFileSync(view.backupPath, 'utf-8');
    writeFileSync(view.backupPath, 'changed by hand\n');
    const changed = shareLegacyBytes(b, pre.archived);
    assert.deepEqual(changed.unresolved, [view], 'the changed backup is unresolved');
    writeFileSync(view.backupPath, original);
    // publish it once, take it out of HEAD, then leave a different file at its path
    const made = shareLegacyBytes(b, pre.archived);
    assert.equal(made.created.length, 1, JSON.stringify(made));
    assert.deepEqual(made.unresolved, []);
    cgitOk(b, ['rm', '-q', '-f', made.created[0]]);
    cgitOk(b, ['commit', '-q', '-m', 'drop']);
    put(b, made.created[0], 'someone else wrote this\n');
    const clash = shareLegacyBytes(b, pre.archived);
    assert.deepEqual(clash.created, []);
    assert.deepEqual(clash.unresolved, [view], 'the clash is unresolved');
  });
});

test('resumePullArchive keeps the record with only the unresolved members when a backup changed, and reports it again until it is shared', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const pre = catchUpAndMerge(b);
    const [view] = pre.archived;
    const original = readFileSync(view.backupPath, 'utf-8');
    writeFileSync(view.backupPath, 'changed by hand\n');
    const record = () => JSON.parse(readRel(b, '.cache/pull-archive.json'));
    const first = resumePullArchive(b);
    assert.equal(first.resumed, true);
    assert.deepEqual(first.created, []);
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), true, 'the record survives');
    assert.deepEqual(
      record().views.map((v) => v.relPath),
      ['projects/p/hot.md'],
    );
    assert.ok(
      first.notices.some((n) => n.includes('projects/p/hot.md') && n.includes('다시 시도')),
      first.notices.join('\n'),
    );
    const second = resumePullArchive(b);
    assert.equal(second.resumed, true, 'the next resume picks it up again');
    assert.ok(
      second.notices.some((n) => n.includes('백업')),
      second.notices.join('\n'),
    );
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), true);
    // the backup is whole again: the next resume shares it and removes the record
    writeFileSync(view.backupPath, original);
    const third = resumePullArchive(b);
    assert.equal(third.created.length, 1, JSON.stringify(third));
    assert.equal(existsSync(join(b, '.cache', 'pull-archive.json')), false);
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

test('the move untracks the generated views, adds one baseline per old file and both blocks, and keeps the rest as it was', () => {
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
    assert.equal(r.baselines.length, 2, 'one project, one baseline per old file');
    for (const rel of r.baselines) {
      assert.match(rel, /^projects\/p\/sessions\/2026-09-25-baseline-[0-9a-f]{16}\.md$/);
    }
    assert.deepEqual(
      changedBy(dir),
      [
        'A\t.gitattributes',
        ...r.baselines.map((rel) => `A\t${rel}`),
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

test('a vault with a Korean project (hot.md and session-state.md) migrates instead of throwing', () => {
  const ko = '인수인계-runbook';
  withOldGit(
    (dir) => {
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      assert.equal(r.skipped, null);
      const koBaselines = r.baselines.filter((rel) => rel.startsWith(`projects/${ko}/sessions/`));
      assert.equal(koBaselines.length, 2, `one baseline per old file: ${r.baselines.join(', ')}`);
      for (const rel of koBaselines) {
        assert.equal(entryOf(dir, rel).project, ko);
        assert.equal(parseSessionEntry(showHead(dir, rel)).entry.project, ko, 'committed in HEAD');
      }
      assert.equal(migrationState(dir), 'migrated');
      assert.deepEqual(listTrackedGeneratedViews(dir, { source: 'head' }), []);
    },
    {
      [`projects/${ko}/index.md`]: '---\ntitle: runbook\n---\n',
      [`projects/${ko}/hot.md`]: RICH_HOT,
      [`projects/${ko}/session-state.md`]: OLD_STATE_FILE,
    },
  );
});

test('the first move of a vault whose root hot.md is as HEAD has it sets nothing aside: no backup, no notice', () => {
  withOldGit((dir) => {
    assert.equal(readRel(dir, 'hot.md'), showHead(dir, 'hot.md'), 'precondition: untouched');
    assert.equal(existsSync(join(dir, '.cache/generated-views.json')), false, 'no record yet');
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    assert.deepEqual(backupsIn(dir, 'hot.md'), []);
    assert.equal(
      r.notices.some((n) => n.includes('생성기가 쓰지 않은 내용')),
      false,
      r.notices.join('\n'),
    );
    assert.equal(existsSync(join(dir, '.cache/root-hot-projection-notice.json')), false);
  });
});

test('the baselines hold both old files whole: a fenced track heading, machine_note and tags survive', () => {
  withOldGit((dir) => {
    const [hotRel, stateRel] = migrate(dir).baselines;
    const hot = entryOf(dir, hotRel);
    const state = entryOf(dir, stateRel);
    assert.equal(hot.summary, RICH_HOT);
    assert.deepEqual(hot.tracks, []);
    assert.equal(state.bodies[LEGACY_TRACK_ID], OLD_STATE_FILE);
    assert.match(state.bodies[LEGACY_TRACK_ID], /machine_note: keep me/);
    assert.equal(state.tracks[0].id, LEGACY_TRACK_ID);
    assert.equal(state.summary, '');
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
      for (const rel of r.baselines) {
        assert.equal(entryOf(dir, rel).visibilityScope, 'machine:devA', rel);
      }
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
      const [hot, state] = r.baselines.map((rel) => entryOf(dir, rel));
      assert.equal(state.visibilityScope, 'machine:devA', 'the scope only the state file has');
      assert.equal(hot.visibilityScope, 'shared', 'it does not hide the hot baseline');
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
      const [hot, state] = r.baselines.map((rel) => entryOf(dir, rel));
      assert.equal(
        hot.visibilityScope,
        'machine:',
        'the hot file names another machine than index.md',
      );
      assert.equal(state.visibilityScope, 'machine:devB', 'the state file has no scope of its own');
      assert.ok(r.notices.some((n) => n.includes('machine:')));
    },
    {
      'projects/p/index.md': '---\ntitle: p\nvisibility_scope: machine:devB\n---\n',
      'projects/p/hot.md': OLD_HOT_FILE,
    },
  );
});

test('two clones that move on their own clocks and then pull each other agree: no conflict, one baseline per file', () => {
  withOldClones(({ a, b }) => {
    migrate(a, { testHooks: { now: new Date('2026-10-01T09:00:00Z') } });
    migrate(b, { testHooks: { now: new Date('2026-10-01T09:01:00Z') } });
    assert.notEqual(headOf(a), headOf(b), 'two distinct move commits');
    cgitOk(a, ['push', '-q']);
    const pulled = cgit(b, ['pull', '--no-rebase', '--no-edit']);
    assert.equal(pulled.status, 0, pulled.stderr);
    assert.equal(unmerged(b), '');
    assert.equal(baselinesOf(b).length, 2);
    cgitOk(b, ['push', '-q']);
    const back = cgit(a, ['pull', '--no-rebase', '--no-edit']);
    assert.equal(back.status, 0, back.stderr);
    assert.equal(unmerged(a), '');
    assert.equal(baselinesOf(a).length, 2);
  });
});

test('two clones that read different scopes keep each file its own scope and make no index.md conflict', () => {
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
        (n) => entryOf(a, `projects/p/sessions/${n}`).visibilityScope ?? 'shared',
      );
      // the hot baselines differ (one clone's hot.md names devB), the shared state baseline is one
      assert.deepEqual(scopes.sort(), ['machine:devA', 'machine:devB', 'shared']);
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
        ['p', 'p'],
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
    assert.equal(baselinesOf(dir).length, 4, 'the move made two, the edits one each');
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
    // with no record at all the bytes HEAD tracks are still safe: the merge keeps HEAD in history
    put(b, '.cache/generated-views.json', JSON.stringify({ views: {} }));
    const unrecorded = clear(b);
    assert.equal(unrecorded.ok, true, JSON.stringify(unrecorded));
    assert.deepEqual(unrecorded.unowned, []);
    assert.deepEqual(backupsIn(b, 'hot.md'), []);
    // bytes that are neither vouched for nor what HEAD tracks get their copy, whatever the line
    // ending (git is told to ignore the edit, so it still reads the file as clean)
    cgitOk(b, ['update-index', '--assume-unchanged', 'hot.md']);
    put(b, 'hot.md', 'an old machine wrote this\r\n');
    const other = clear(b);
    assert.equal(other.unowned.length, 1, JSON.stringify(other));
    assert.equal(
      readFileSync(other.unowned[0].backupPath, 'utf-8'),
      'an old machine wrote this\r\n',
    );
  });
});

test('a stop that comes after the backups reports everything it moved, and the move is undone', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    // root hot.md bytes HEAD does not track, which git is told to ignore (so the file reads as clean)
    cgitOk(b, ['update-index', '--assume-unchanged', 'hot.md']);
    put(b, 'hot.md', 'an old machine wrote this\n');
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
    assert.equal(readRel(b, 'hot.md'), 'an old machine wrote this\n');
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
    put(dir, 'hot.md', 'an old machine wrote this\n'); // not what HEAD tracks
    const r = migrate(dir);
    assert.equal(r.migrated, true);
    const [backup] = backupsIn(dir, 'hot.md');
    assert.equal(
      readRel(dir, backup),
      'an old machine wrote this\n',
      'the same bytes the file had',
    );
    assert.ok(
      r.notices.some((n) => n.includes('생성기가 쓰지 않은 내용') && n.includes(`\`${backup}\``)),
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

// One archived view is shared and another one's backup is gone: the kept record holds the missing
// one only, not the view that is already a baseline. Disabling: in `resumePullArchive` delete the
// `writePullArchive(hypoDir, { ...rec, views: shared.unresolved });` call in the `lost` branch. The
// record-views assertion goes red.
test('a resume with one backup gone and another view shared keeps only the missing member in the record', () => {
  withCatchUp(({ b }) => {
    put(b, 'projects/p/hot.md', W1);
    const r = clear(b);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(ffTo(b), 0);
    const recordPath = join(b, '.cache/pull-archive.json');
    const rec = JSON.parse(readFileSync(recordPath, 'utf-8'));
    const [missing] = rec.views;
    unlinkSync(missing.backupPath);
    const goodPath = join(b, '.cache', 'second-run-hot.md');
    writeFileSync(goodPath, W2);
    const good = { ...missing, backupPath: goodPath, sha256: sha(W2), run: (missing.run ?? 0) + 1 };
    writeFileSync(recordPath, JSON.stringify({ ...rec, views: [missing, good] }));

    const first = resumePullArchive(b);
    assert.equal(first.resumed, true);
    assert.equal(first.created.length, 1, `the other view is shared: ${first.notices.join('\n')}`);
    assert.ok(
      first.notices.some((n) => n.includes(missing.backupPath)),
      first.notices.join('\n'),
    );
    const kept = JSON.parse(readFileSync(recordPath, 'utf-8'));
    assert.deepEqual(
      kept.views.map((v) => v.backupPath),
      [missing.backupPath],
      'only the unresolved member stays',
    );

    // The next resume still reports the missing one and shares nothing twice.
    const second = resumePullArchive(b);
    assert.equal(second.resumed, true);
    assert.deepEqual(second.created, []);
    assert.ok(
      second.notices.some((n) => n.includes(missing.backupPath)),
      second.notices.join('\n'),
    );
    assert.equal(existsSync(recordPath), true, 'the record stays until the member is resolved');
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
      // bytes HEAD does not track, which git is told to ignore (so the file reads as clean)
      cgitOk(b, ['update-index', '--assume-unchanged', 'hot.md']);
      put(b, 'hot.md', 'an old machine wrote this\n');
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
      // the merge needs the file as HEAD has it; the copy in .cache/backups/ holds the other bytes
      put(b, 'hot.md', 'root hot\n');
      cgitOk(b, ['update-index', '--no-assume-unchanged', 'hot.md']);
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
const HEAD_GITIGNORE = '.cache/\n';

// `.gitignore` rewritten in the working tree only (CRLF, blank lines), nothing staged; and a local
// commit, so the later `merge --ff-only` cannot succeed.
function gitignoreWorkOnly(b) {
  put(b, '.gitignore', WORK_GITIGNORE);
  put(b, 'pages/local.md', 'local\n');
  cgitOk(b, ['add', 'pages/local.md']);
  cgitOk(b, ['commit', '-q', '-m', 'local', '--', 'pages/local.md']);
  assert.equal(cgitOk(b, ['diff', '--cached', '--name-only']).trim(), '', 'precondition: no stage');
  assert.equal(readRel(b, '.gitignore'), WORK_GITIGNORE, 'precondition: working tree');
}
const indexBlob = (b) => cgitOk(b, ['show', ':.gitignore']);

test('a failed move puts the working-tree .gitignore bytes back exactly', () => {
  withCatchUp(({ b }) => {
    gitignoreWorkOnly(b);
    const pre = clear(b);
    assert.equal(pre.ok, true, JSON.stringify(pre));
    assert.deepEqual(
      pre.gitignoreSaved.map((v) => v.kind),
      ['worktree'],
    );
    assert.equal(
      readRel(b, '.gitignore'),
      HEAD_GITIGNORE,
      'precondition: the clearing step restored HEAD',
    );
    assert.notEqual(ffTo(b), 0, 'precondition: the merge cannot fast-forward');
    const undone = undoClearedPaths(b, pre);
    assert.deepEqual(undone, { ok: true, notices: [] });
    assert.ok(readFileSync(join(b, '.gitignore')).equals(Buffer.from(WORK_GITIGNORE)));
    assert.equal(indexBlob(b), HEAD_GITIGNORE, 'nothing got staged');
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), false);
    for (const { backupPath } of pre.gitignoreSaved) assert.equal(existsSync(backupPath), false);
  });
});

test('fastForwardTo leaves the CRLF working-tree .gitignore as it was when the merge fails', () => {
  withCatchUp(({ b }) => {
    gitignoreWorkOnly(b);
    const r = fastForwardTo(b, '@{u}');
    assert.equal(r.ok, false);
    assert.match(r.reason, /^fast-forward-failed/);
    assert.equal(r.pre.gitignoreSaved.length, 1, 'precondition: the clearing step moved it');
    assert.ok(readFileSync(join(b, '.gitignore')).equals(Buffer.from(WORK_GITIGNORE)));
    assert.equal(indexBlob(b), HEAD_GITIGNORE, 'nothing got staged');
  });
});

// The staged-only line that the test above used to carry through the failed move: a staged
// .gitignore is no longer set aside at all.
test('fastForwardTo defers on a staged-only .gitignore line and leaves the stage, the tree and the backups alone', () => {
  withCatchUp(({ b }) => {
    put(b, '.gitignore', STAGED_GITIGNORE);
    cgitOk(b, ['add', '.gitignore']);
    put(b, '.gitignore', WORK_GITIGNORE);
    const head = headOf(b);
    const r = fastForwardTo(b, '@{u}');
    assert.equal(r.ok, false);
    assert.equal(r.deferred, 'gitignore');
    assert.equal(r.reason, 'gitignore-staged');
    assert.equal(headOf(b), head);
    assert.equal(indexBlob(b), STAGED_GITIGNORE, 'the stage is intact');
    assert.ok(readFileSync(join(b, '.gitignore')).equals(Buffer.from(WORK_GITIGNORE)));
    assert.equal(existsSync(join(b, '.cache', 'backups')), false, 'no backup');
    assert.equal(existsSync(join(b, '.cache/pull-archive.json')), false, 'no record');
  });
});

test('a .gitignore written after the clearing step is not overwritten by the undo, and its backup is kept', () => {
  withCatchUp(({ b }) => {
    gitignoreWorkOnly(b);
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
    gitignoreWorkOnly(b);
    const pre = clear(b);
    assert.equal(pre.ok, true, JSON.stringify(pre));
    const record = JSON.parse(readRel(b, '.cache/pull-archive.json'));
    assert.equal(record.gitignoreSaved.length, 1, 'precondition: the record holds the saved bytes');
    // the next run starts from the released state; its own snapshot is the exact bytes again
    const again = clear(b);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual(
      again.gitignoreSaved.map((v) => readFileSync(v.backupPath, 'utf-8')),
      [WORK_GITIGNORE],
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
    // The old files were as HEAD had them, so the move set nothing aside and left no notice.
    assert.equal(consumeRootHotHealthNotice(dir), null, 'the move names no backup');
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

test('the writer skips a view that a later rule un-ignores, writes the others, and names it in a notice', () => {
  withOldGit((dir) => {
    assert.equal(migrate(dir).migrated, true, 'precondition: the vault is migrated');
    const ignore = showHead(dir, '.gitignore');
    put(dir, '.gitignore', `${ignore}!/projects/p/hot.md\n`);
    commitIn(dir);
    assert.equal(migrationState(dir), 'migrated', 'precondition: the block lines are all there');
    consumeRootHotHealthNotice(dir);
    putEntry(dir, 'p', 'c-late', { date: '2026-10-02' });
    for (const rel of ['hot.md', VIEW, 'projects/p/session-state.md']) {
      if (existsSync(join(dir, rel))) unlinkSync(join(dir, rel));
    }
    const r = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(r.stageableViews, [VIEW], JSON.stringify(r));
    assert.equal(existsSync(join(dir, VIEW)), false, 'the stageable view was not written');
    assert.deepEqual(r.written.sort(), ['hot.md', 'projects/p/session-state.md']);
    cgitOk(dir, ['add', '-A']);
    assert.deepEqual(
      cgitOk(dir, ['diff', '--cached', '--name-only'])
        .split('\n')
        .filter((n) => n && !n.includes('/sessions/')),
      [],
      'no generated view is staged (the new entry is)',
    );
    const notice = consumeRootHotHealthNotice(dir) ?? '';
    assert.ok(notice.includes(VIEW) && notice.includes('.gitignore'), notice);
    // The pair: with the rule gone the same render writes it.
    put(dir, '.gitignore', ignore);
    commitIn(dir);
    const again = writeGeneratedViews(dir, WRITE);
    assert.deepEqual(again.stageableViews, []);
    assert.deepEqual(again.written, [VIEW]);
    assert.equal(existsSync(join(dir, VIEW)), true);
  });
});

// A project directory with an index and both old files, as the migration reads them.
const oldProjectFiles = (slug) => ({
  [`projects/${slug}/index.md`]: `---\ntitle: x\n---\n`,
  [`projects/${slug}/hot.md`]: OLD_HOT_FILE,
  [`projects/${slug}/session-state.md`]: OLD_STATE_FILE,
});

test('a tracked project directory whose name cannot be an entry project defers the whole move, names each directory with its rename command, and writes nothing', () => {
  const bad = ['my project', 'c++', 'foo(bar)', '프로젝트 A'];
  const fixes = ['my-project', 'c', 'foo-bar', '프로젝트-A'];
  withOldGit(
    (dir) => {
      const head = headOf(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'invalid-project-name', JSON.stringify(r));
      const notice = r.notices.join('\n');
      bad.forEach((name, i) => {
        assert.ok(notice.includes(`projects/${name}:`), `${name} is named`);
        assert.ok(
          notice.includes(`/hypo:rename --from="projects/${name}" --to="projects/${fixes[i]}"`),
          `${name}: the exact command, ${notice}`,
        );
      });
      assert.match(notice, /공백이나 기호/);
      assert.doesNotMatch(notice, /projects\/p:/, 'the valid project is not named');
      assert.equal(headOf(dir), head, 'no commit');
      assert.equal(migrationState(dir), 'not-migrated');
      assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'nothing written');
      assert.deepEqual(listDir(sessionsDir(dir)), [], 'the valid project got no baseline either');
      // The pair: renamed to the names the notice suggests, the same vault moves.
      bad.forEach((name, i) => {
        cgitOk(dir, ['mv', `projects/${name}`, `projects/${fixes[i]}`]);
      });
      commitIn(dir);
      const again = migrate(dir);
      assert.equal(again.migrated, true, JSON.stringify(again));
      for (const fix of fixes) {
        assert.ok(
          again.baselines.some((b) => b.startsWith(`projects/${fix}/sessions/`)),
          `${fix} has its baselines`,
        );
      }
    },
    Object.assign({}, ...bad.map(oldProjectFiles)),
  );
});

test('a tracked project directory that is not in NFC defers the move and names the NFC spelling', () => {
  const nfd = '프로젝트'.normalize('NFD');
  const nfc = nfd.normalize('NFC');
  assert.notEqual(nfd, nfc, 'precondition: the two spellings differ');
  inCatchUpEnv(() =>
    withTmpDir((dir) => {
      cgitOk(dir, ['init', '-q']);
      cgitOk(dir, ['config', 'core.precomposeunicode', 'false']);
      for (const [rel, text] of Object.entries({
        '.gitignore': '.cache/\n',
        ...oldProjectFiles(nfd),
        ...oldProjectFiles('ok'),
      })) {
        put(dir, rel, text);
      }
      commitIn(dir);
      const tracked = listTrackedGeneratedViews(dir, { source: 'head' });
      assert.ok(
        tracked.some((rel) => rel.startsWith(`projects/${nfd}/`)),
        'precondition: HEAD holds the decomposed spelling',
      );
      const head = headOf(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false);
      assert.equal(r.deferred, 'invalid-project-name', JSON.stringify(r));
      const notice = r.notices.join('\n');
      const [first, second] = nfcRenameCommands(nfd);
      assert.equal(first, `/hypo:rename --from="projects/${nfd}" --to="projects/${nfc}.nfc-tmp"`);
      assert.equal(second, `/hypo:rename --from="projects/${nfc}.nfc-tmp" --to="projects/${nfc}"`);
      assert.ok(notice.includes(`${first} 다음에 ${second}`), notice);
      assert.ok(notice.includes('.hypoignore'), notice);
      assert.match(notice, /NFC/);
      assert.doesNotMatch(notice, /projects\/ok:/);
      assert.equal(headOf(dir), head);
      assert.equal(migrationState(dir), 'not-migrated');
    }),
  );
});

test('a decomposed project directory defers the move even when git reports its path precomposed', () => {
  const nfd = '프로젝트'.normalize('NFD');
  const nfc = nfd.normalize('NFC');
  inCatchUpEnv(() =>
    withTmpDir((dir) => {
      cgitOk(dir, ['init', '-q']);
      // The macOS default: git prints the decomposed directory in NFC. Elsewhere git ignores the
      // setting and prints the bytes as they are; the move must be deferred either way.
      cgitOk(dir, ['config', 'core.precomposeunicode', 'true']);
      for (const [rel, text] of Object.entries({
        '.gitignore': '.cache/\n',
        ...oldProjectFiles(nfd),
        ...oldProjectFiles('ok'),
      })) {
        put(dir, rel, text);
      }
      commitIn(dir);
      assert.ok(
        readdirSync(join(dir, 'projects')).includes(nfd),
        'precondition: the directory is decomposed on disk',
      );
      const head = headOf(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, false, JSON.stringify(r));
      assert.equal(r.deferred, 'invalid-project-name', JSON.stringify(r));
      const [first, second] = nfcRenameCommands(nfd);
      assert.ok(r.notices.join('\n').includes(`${first} 다음에 ${second}`), r.notices.join('\n'));
      assert.equal(headOf(dir), head, 'nothing committed');
      assert.equal(existsSync(join(dir, 'projects', nfc, 'sessions')), false, 'no entries written');
    }),
  );
});

test('a split track the old scheme finished stays finished after the move, and its siblings stay live', () => {
  const split = splitBaseline(MULTI_STATE).entry.tracks;
  const flow = split.find((t) => t.title === 'flow').id;
  const squid = split.find((t) => t.title.startsWith('squid')).id;
  withOldGit(
    (dir) => {
      // Closed under the old scheme: the entry finishes `flow` only. The file then changes
      // (another track's body), so the real baseline gets another id than the virtual one had.
      putEntry(dir, 'p', 'finish-flow-0', {
        tracks: [{ id: flow, title: 'flow', new: true, done: true }],
        bodies: { [flow]: 'FLOW_FINISHED\n' },
        summary: 'finished flow\n',
      });
      put(dir, 'projects/p/session-state.md', MULTI_STATE.replace('SQUID_BODY', 'SQUID_EDITED'));
      commitIn(dir);
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      const heads = trackHeads(listSessionEntries(dir, 'p').entries);
      const by = (id) => heads.find((t) => t.trackId === id);
      assert.equal(by(flow)?.done, true, 'the finished track is not live again');
      assert.equal(by(squid)?.done, false, 'a sibling that was never finished is live');
      assert.equal(by(LEGACY_TRACK_ID)?.done, false, 'the remainder is live');
    },
    { 'projects/p/session-state.md': MULTI_STATE },
  );
});

test('a generated view staged by hand but not in HEAD stops the move before it writes anything, and the move goes on once it is committed', () => {
  withOldGit((dir) => {
    put(dir, 'projects/p2/hot.md', RICH_HOT);
    cgitOk(dir, ['add', 'projects/p2/hot.md']);
    const before = commitCount(dir);
    const head = cgitOk(dir, ['rev-parse', 'HEAD']);
    const r = migrate(dir);
    assert.equal(r.migrated, false);
    assert.equal(r.deferred, 'staged-views', JSON.stringify(r));
    assert.ok(r.notices.join('\n').includes('projects/p2/hot.md'), r.notices.join('\n'));
    assert.equal(commitCount(dir), before, 'no commit was created');
    assert.equal(cgitOk(dir, ['rev-parse', 'HEAD']), head);
    assert.ok(cgitOk(dir, ['ls-files']).includes('projects/p2/hot.md'), 'the stage is untouched');
    assert.equal(migrationState(dir), 'not-migrated');
    // The pair: once the stage is committed, HEAD lists it and the move removes it with the rest.
    commitIn(dir);
    const again = migrate(dir);
    assert.equal(again.migrated, true, JSON.stringify(again));
    assert.deepEqual(
      listTrackedGeneratedViews(dir, { source: 'index' }),
      [],
      'no generated view is tracked after the move',
    );
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

test('the virtual baseline of a vault not moved yet holds the working-tree bytes: a hand edit that is staged or not shows up', () => {
  withOldGit((dir) => {
    put(dir, 'projects/p/hot.md', RICH_HOT.replace('the old summary', 'STAGED summary'));
    cgitOk(dir, ['add', 'projects/p/hot.md']);
    put(dir, 'projects/p/hot.md', RICH_HOT.replace('the old summary', 'WORKTREE summary'));
    const virtual = loadSessionModel(dir, 'p').entries.find((e) => isBaselineId(e.closeId));
    assert.ok(virtual, 'a virtual baseline');
    const text = JSON.stringify(virtual);
    assert.ok(text.includes('WORKTREE summary'), 'the working-tree text');
    assert.equal(text.includes('the old summary'), false, 'not HEAD');
    assert.equal(text.includes('STAGED'), false, 'not the index');
  });
});

test('the virtual baseline of a file the vault .gitignore keeps out of git is still there', () => {
  withOldGit((dir) => {
    // HEAD tracks neither old file of q: a user rule keeps them out, and they are on disk
    put(dir, '.gitignore', '.cache/\nprojects/q/\n');
    put(dir, 'projects/q/index.md', '---\ntitle: q\n---\n');
    put(dir, 'projects/q/session-state.md', '## Next Up\nQ_STATE_BODY\n');
    const model = loadSessionModel(dir, 'q');
    const virtual = model.entries.find((e) => isBaselineId(e.closeId));
    assert.ok(virtual, JSON.stringify(model));
    assert.ok(JSON.stringify(virtual).includes('Q_STATE_BODY'));
  });
});

test('the virtual baseline skips bytes the generator wrote, and an edit of them counts again', () => {
  withOldGit((dir) => {
    const written = '---\ngenerated: sessions\n---\nwritten by the generator\n';
    put(dir, 'projects/p/hot.md', written);
    put(dir, 'projects/p/session-state.md', '');
    // committed, so the working tree and HEAD hold the same bytes and only ownership decides
    commitIn(dir);
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({ views: { 'projects/p/hot.md': sha(written) } }),
    );
    assert.equal(
      loadSessionModel(dir, 'p').entries.filter((e) => isBaselineId(e.closeId)).length,
      0,
      'the generator output is not old memory',
    );
    put(dir, 'projects/p/hot.md', `${written}typed by hand\n`);
    commitIn(dir);
    const [edited] = loadSessionModel(dir, 'p').entries.filter((e) => isBaselineId(e.closeId));
    assert.ok(edited && JSON.stringify(edited).includes('typed by hand'), 'an edited view is read');
  });
});

test('with a clean working tree the virtual baseline has the id the migration commit builds', () => {
  withOldGit((dir) => {
    const virtual = loadSessionModel(dir, 'p').entries.find(
      (e) => isBaselineId(e.closeId) && e.summary !== '',
    );
    assert.ok(virtual, 'a virtual hot baseline');
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    const ids = r.baselines.map((rel) => entryOf(dir, rel).closeId);
    assert.ok(ids.includes(virtual.closeId), 'the migration commit builds the same baseline id');
  });
});

// An old file git does not track is not published and not claimed by the migration: whether it is
// private local memory or an edited generated view cannot be told, and its scope may live in an
// `index.md` that is untracked too. The writer backs it up and the notice says where.
test('an untracked old file with an untracked machine-scoped index.md is in no commit and no shared view, and is backed up with a notice', () => {
  withOldGit((dir) => {
    put(
      dir,
      'projects/q/index.md',
      '---\ntitle: q\nvisibility_scope: machine:secret-device\n---\n',
    );
    put(dir, 'projects/q/session-state.md', '## Next Up\nPRIVATE_LOCAL_MEMORY\n');
    assert.equal(cgitOk(dir, ['ls-files', 'projects/q']).trim(), '', 'precondition: untracked');
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    assert.equal(
      r.baselines.some((rel) => rel.startsWith('projects/q/')),
      false,
      JSON.stringify(r.baselines),
    );
    assert.equal(
      git(dir, ['grep', '-q', 'PRIVATE_LOCAL_MEMORY', 'HEAD']).status,
      1,
      'in no commit',
    );
    assert.ok(
      r.notices.some((n) => n.includes('projects/q/session-state.md')),
      `the migration says the file stayed out: ${JSON.stringify(r.notices)}`,
    );
    const written = writeGeneratedViews(dir, WRITE);
    const backup = written.backedUp.find((b) => b.relPath === 'projects/q/session-state.md');
    assert.ok(backup, JSON.stringify(written.backedUp));
    assert.match(readFileSync(backup.backupPath, 'utf-8'), /PRIVATE_LOCAL_MEMORY/);
    const shared = [readRel(dir, 'hot.md'), readRel(dir, 'projects/q/hot.md')].join('\n');
    assert.equal(shared.includes('PRIVATE_LOCAL_MEMORY'), false, 'in no shared view');
    const notice = consumeRootHotHealthNotice(dir) ?? '';
    assert.ok(notice.includes(relative(dir, backup.backupPath)), `names the backup: ${notice}`);
    assert.match(notice, /notes\.md/, 'says how to bring the text back');
  });
});

test('an edited generated view that git does not track, with an ownership record, is backed up and not claimed', () => {
  withOldGit((dir) => {
    const written = '---\ngenerated: sessions\n---\nwritten by the generator\n';
    put(dir, 'projects/q/index.md', '---\ntitle: q\n---\n');
    put(dir, 'projects/q/hot.md', `${written}typed by hand EDITED_VIEW\n`);
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({ views: { 'projects/q/hot.md': sha(written) } }),
    );
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    assert.equal(
      r.baselines.some((rel) => rel.startsWith('projects/q/')),
      false,
      'not a baseline',
    );
    assert.equal(git(dir, ['grep', '-q', 'EDITED_VIEW', 'HEAD']).status, 1, 'in no commit');
    const claimed = readGeneratedViewsRecord(dir).views['projects/q/hot.md'];
    assert.equal(claimed, sha(written), 'the record still holds the old hash: not claimed');
    const out = writeGeneratedViews(dir, WRITE);
    const backup = out.backedUp.find((b) => b.relPath === 'projects/q/hot.md');
    assert.ok(backup, JSON.stringify(out.backedUp));
    assert.match(readFileSync(backup.backupPath, 'utf-8'), /EDITED_VIEW/);
  });
});

test('an old file that is not tracked, ignored by the vault or never added, is not published as a baseline by the move', () => {
  withOldGit(
    (dir) => {
      put(dir, 'projects/q/index.md', '---\ntitle: q\n---\n');
      put(dir, 'projects/q/session-state.md', '## Next Up\nQ_PRIVATE_STATE\n');
      put(dir, 'projects/r/index.md', '---\ntitle: r\n---\n');
      put(dir, 'projects/r/session-state.md', '## Next Up\nR_PLAIN_STATE\n');
      const r = migrate(dir);
      assert.equal(r.migrated, true, JSON.stringify(r));
      const published = r.baselines.map((rel) => readRel(dir, rel)).join('\n');
      // the contract changed: a file that was merely never added is no longer published either
      assert.equal(published.includes('R_PLAIN_STATE'), false, 'the never added one is not');
      assert.equal(published.includes('Q_PRIVATE_STATE'), false, 'the ignored one is not');
      assert.equal(cgitOk(dir, ['ls-tree', '-r', '--name-only', 'HEAD', 'projects/q']).trim(), '');
      // kept local: the writer backs it up and the notice says where
      assert.ok(
        r.notices.some((n) => n.includes('projects/q/session-state.md')),
        JSON.stringify(r.notices),
      );
      const out = writeGeneratedViews(dir, WRITE);
      const backup = out.backedUp.find((b) => b.relPath === 'projects/q/session-state.md');
      assert.ok(backup, JSON.stringify(out.backedUp));
      assert.match(readFileSync(backup.backupPath, 'utf-8'), /Q_PRIVATE_STATE/);
      assert.ok(out.backedUp.some((b) => b.relPath === 'projects/r/session-state.md'));
      assert.ok((consumeRootHotHealthNotice(dir) ?? '').includes(relative(dir, backup.backupPath)));
    },
    { '.gitignore': '.cache/\nprojects/q/session-state.md\n' },
  );
});

test('a tracked view with the generator bytes gets no baseline in the migration commit', () => {
  withOldGit((dir) => {
    const written = '---\ngenerated: sessions\n---\nwritten by the generator\n';
    put(dir, 'projects/p/hot.md', written);
    commitIn(dir);
    put(
      dir,
      '.cache/generated-views.json',
      JSON.stringify({ views: { 'projects/p/hot.md': sha(written) } }),
    );
    const r = migrate(dir);
    assert.equal(r.migrated, true, JSON.stringify(r));
    const texts = r.baselines.map((rel) => readRel(dir, rel));
    assert.equal(
      texts.some((t) => t.includes('written by the generator')),
      false,
      'the generator output is not turned into a baseline',
    );
    assert.equal(
      texts.some((t) => t.includes('old state body')),
      true,
      'the real old state file still is',
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
    // The old files were as HEAD had them, so the move set nothing aside and left no notice.
    assert.equal(consumeRootHotHealthNotice(dir), null, 'the move names no backup');
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

// ── rollback to the flat files ───────────────────────────────────────────────

suite('session entries: rollback and render commands');

const RB_IDS = [1, 2, 3].map((n) => `2b1c4d5e-aaaa-bbbb-cccc-0123456789ab-${410 + n}`);
const RB_MARKER = SESSION_ENTRIES_OFF_MARKER;
const RB_TRACKED = ['hot.md', ':(glob)projects/*/hot.md', ':(glob)projects/*/session-state.md'];

// A migrated vault with three originals, each in a commit of its own (`shas[i]` is the commit that
// added original i), the generator's views written and owned, on top of the move from the old files.
function withRollbackVault(fn) {
  withOldGit((dir) => {
    const old = headOf(dir);
    assert.equal(migrate(dir).migrated, true);
    const shas = RB_IDS.map((id, i) => {
      putEntry(dir, 'p', id, { date: `2026-10-0${i + 1}` });
      commitIn(dir);
      return headOf(dir);
    });
    assert.equal(writeGeneratedViews(dir, WRITE).notMigrated, false);
    fn({ dir, shas, old });
  });
}

const rbRun = (dir, args) =>
  spawnSync(process.execPath, [join(REPO, 'scripts', 'session-entries.mjs'), ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: SESSION_TMP_HOME,
      HYPO_DIR: dir,
      CLAUDE_CONFIG_DIR: '',
      GIT_CONFIG_GLOBAL: CATCH_UP_CONFIG(),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });

test('rollback at the second original renders the flat files from that commit only, tracks the three paths and keeps sessions/', () => {
  withRollbackVault(({ dir, shas }) => {
    const sessionsBefore = listDir(sessionsDir(dir));
    // Names alone would pass a rollback that rewrote the originals: compare their bytes and the
    // committed blobs too.
    const originalBytes = () =>
      sessionsBefore.map((n) => [n, readFileSync(join(sessionsDir(dir), n), 'utf-8')]);
    const originalBlobs = () =>
      cgitOk(dir, ['ls-tree', '-r', 'HEAD'])
        .split('\n')
        .filter((l) => l.includes('/sessions/'))
        .join('\n');
    const bytesBefore = originalBytes();
    const blobsBefore = originalBlobs();
    assert.ok(bytesBefore.length >= 3, 'the originals are there to compare');
    const before = commitCount(dir);
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    assert.equal(r.commit, headOf(dir));
    assert.equal(commitCount(dir), before + 1);
    const tracked = cgitOk(dir, ['ls-files', '--', ...RB_TRACKED])
      .trim()
      .split('\n')
      .filter((rel) => !rel.includes('_template')); // tracked before and not a generated path
    assert.deepEqual(tracked, ['hot.md', 'projects/p/hot.md', 'projects/p/session-state.md']);
    const flat = ['projects/p/hot.md', 'projects/p/session-state.md', 'hot.md']
      .map((rel) => showHead(dir, rel))
      .join('\n');
    assert.ok(flat.includes(`summary ${RB_IDS[0]}`), 'the first original is in the flat files');
    assert.ok(flat.includes(`summary ${RB_IDS[1]}`), 'the second original is in the flat files');
    assert.ok(!flat.includes(RB_IDS[2]), 'the original added after the rollback point is not');
    assert.deepEqual(listDir(sessionsDir(dir)), sessionsBefore, 'sessions/ is left as it is');
    assert.deepEqual(originalBytes(), bytesBefore, 'the originals keep their bytes');
    assert.equal(
      originalBlobs(),
      blobsBefore,
      'the rollback commit leaves the original blobs as they were',
    );
    assert.ok(!showHead(dir, '.gitignore').includes(GITIGNORE_BLOCK));
    assert.ok(showHead(dir, '.gitignore').includes('.cache/'), 'the cache stays ignored');
  });
});

test('rollback leaves HEAD, the index and the working tree together: status is empty and the flat bytes are the commit blobs', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
    for (const rel of ['hot.md', 'projects/p/hot.md', 'projects/p/session-state.md']) {
      assert.equal(readRel(dir, rel), showHead(dir, rel), `${rel} is the committed blob`);
    }
  });
});

test('rollback writes the off marker into HEAD: the default move makes no commit and reenable makes one', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    assert.match(
      showHead(dir, RB_MARKER),
      new RegExp(`^rolled back to ${shas[1]} on \\d{4}-\\d{2}-\\d{2}\\n`),
      'the first line stays readable',
    );
    const marked = offMarkerHashes(showHead(dir, RB_MARKER));
    assert.deepEqual(Object.keys(marked).sort(), [
      'hot.md',
      'projects/p/hot.md',
      'projects/p/session-state.md',
    ]);
    for (const [rel, hash] of Object.entries(marked)) assert.equal(hash, sha(showHead(dir, rel)));
    assert.equal(migrationState(dir), 'opted-out');
    const before = commitCount(dir);
    const again = migrate(dir);
    assert.equal(again.skipped, 'opted-out');
    assert.equal(again.migrated, false);
    assert.equal(commitCount(dir), before, 'a SessionStart move makes no commit');
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.equal(commitCount(dir), before + 1, 'reenable makes the one move commit');
    assert.ok(!treeNames(dir).includes(RB_MARKER));
  });
});

test('rollback keeps the bytes of a generated file the generator did not write, in a backup', () => {
  withRollbackVault(({ dir, shas }) => {
    put(dir, 'projects/p/hot.md', "my own hot, not the generator's\n");
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    const backups = backupsIn(dir, 'projects/p/hot.md');
    assert.equal(backups.length, 1);
    assert.equal(readRel(dir, backups[0]), "my own hot, not the generator's\n");
    assert.notEqual(readRel(dir, 'projects/p/hot.md'), "my own hot, not the generator's\n");
    assert.equal(backupsIn(dir, 'projects/p/session-state.md').length, 0, 'owned bytes need none');
  });
});

test('rollback defers with the reason and changes nothing: unknown commit, a commit from before the move, a vault not moved', () => {
  withRollbackVault(({ dir, old }) => {
    const head = headOf(dir);
    const unknown = rollbackSessionEntries(dir, { at: 'no-such-rev' });
    assert.equal(unknown.rolledBack, false);
    assert.equal(unknown.deferred, 'revision-unreadable');
    const early = rollbackSessionEntries(dir, { at: old });
    assert.equal(early.deferred, 'at-not-migrated');
    assert.match(early.notices[0], /롤백을 미뤘습니다/);
    assert.equal(headOf(dir), head);
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
  });
  withOldGit((dir) => {
    const r = rollbackSessionEntries(dir, { at: headOf(dir) });
    assert.equal(r.deferred, 'not-migrated');
  });
});

// ── what the rollback leaves behind, what re-enabling keeps, and machine scope ───────────────

test('rollback clears the views of a project made after its point: status is empty, an owned file leaves no backup, an unowned one keeps its bytes', () => {
  withRollbackVault(({ dir, shas }) => {
    putEntry(dir, 'q', RB_IDS[0].replace(/-411$/, '-511'), {
      date: '2026-10-04',
      visibilityScope: 'machine:devA',
    });
    put(dir, 'projects/q/index.md', '---\ntitle: q\nvisibility_scope: machine:devA\n---\n');
    commitIn(dir);
    assert.equal(writeGeneratedViews(dir, WRITE).notMigrated, false);
    for (const rel of ['projects/q/hot.md', 'projects/q/session-state.md']) {
      assert.equal(existsSync(join(dir, rel)), true, `${rel} is generated first`);
    }
    put(dir, 'projects/q/session-state.md', 'a person wrote this in q\n');
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'nothing of q is left to stage');
    assert.equal(existsSync(join(dir, 'projects/q/hot.md')), false);
    assert.equal(existsSync(join(dir, 'projects/q/session-state.md')), false);
    assert.equal(backupsIn(dir, 'projects/q/hot.md').length, 0, 'the generator wrote it: no copy');
    const kept = backupsIn(dir, 'projects/q/session-state.md');
    assert.equal(kept.length, 1);
    assert.equal(readRel(dir, kept[0]), 'a person wrote this in q\n');
    assert.deepEqual(
      treeNames(dir).filter((n) => n.startsWith('projects/q/') && !n.includes('/sessions/')),
      ['projects/q/index.md'],
      'q has no flat file in the rollback commit',
    );
  });
});

test('rollback limits say that a project made after the point has no flat file and that mixed machine scopes are left out', () => {
  assert.ok(ROLLBACK_LIMITS.some((l) => l.includes('뒤에 만든 프로젝트')));
  assert.ok(ROLLBACK_LIMITS.some((l) => l.includes('machine:') && l.includes('visibility_scope')));
  assert.ok(
    ROLLBACK_LIMITS.some((l) => l.includes('다음 동기화') && l.includes('모든 기계')),
    'the next sync publishes the rollback to every machine',
  );
  assert.ok(
    ROLLBACK_LIMITS.some((l) => l.includes('구버전') && l.includes('hot.md') && l.includes('복사')),
    'a machine on an older version overwrites its local flat files when it pulls the rollback',
  );
});

function withScopedRollbackVault(fn) {
  withOldGit((dir) => {
    assert.equal(migrate(dir).migrated, true);
    const id = (n) => `2b1c4d5e-aaaa-bbbb-cccc-0123456789ab-${520 + n}`;
    put(dir, 'projects/s/index.md', '---\ntitle: s\n---\n');
    put(dir, 'projects/m/index.md', '---\ntitle: m\n---\n');
    putEntry(dir, 's', id(1), { date: '2026-10-01', visibilityScope: 'machine:devA' });
    putEntry(dir, 's', id(2), { date: '2026-10-02', visibilityScope: 'machine:devA' });
    putEntry(dir, 'm', id(3), { date: '2026-10-01' });
    putEntry(dir, 'm', id(4), { date: '2026-10-02', visibilityScope: 'machine:devA' });
    putEntry(dir, 'p', id(5), { date: '2026-10-02' });
    commitIn(dir);
    const point = headOf(dir);
    fn({ dir, point, id });
  });
}

test('rollback renders a project whose entries all belong to one machine for that machine and tags both files with the scope', () => {
  withScopedRollbackVault(({ dir, point, id }) => {
    const r = rollbackSessionEntries(dir, { at: point });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    for (const rel of ['projects/s/hot.md', 'projects/s/session-state.md']) {
      const text = showHead(dir, rel);
      assert.match(text, /^visibility_scope: machine:devA$/m, rel);
      assert.ok(text.includes(`${id(2)}`), `${rel} holds the machine-scoped entry`);
    }
    assert.ok(showHead(dir, 'projects/s/session-state.md').includes(`next for ${id(2)}`));
    // the line sits inside the frontmatter, so a reader of the file sees it as a scope
    assert.equal(readVisibilityScope(showHead(dir, 'projects/s/hot.md')), 'machine:devA');
    for (const rel of ['projects/p/hot.md', 'projects/p/session-state.md']) {
      assert.ok(!/^visibility_scope:/m.test(showHead(dir, rel)), `${rel} is shared`);
    }
    assert.ok(!r.leftOut.some((l) => l.project === 's'), 'nothing of s is left out');
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
  });
});

test('rollback leaves the machine-scoped entries of a project that mixes scopes out of its files and reports the project and the count', () => {
  withScopedRollbackVault(({ dir, point, id }) => {
    const r = rbRun(dir, ['rollback', `--at=${point}`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const state = showHead(dir, 'projects/m/session-state.md');
    assert.ok(state.includes(`next for ${id(3)}`), 'the shared entry is in');
    assert.ok(!state.includes(id(4)), 'the machine-scoped one is not');
    assert.ok(!/^visibility_scope:/m.test(state));
    assert.ok(r.stdout.includes('기계 범위 항목이 평면 파일에서 빠진 프로젝트: m (1개)'), r.stdout);
    assert.ok(!r.stdout.includes('s ('), 'a project rendered for its machine is not listed');
  });
});

test('re-enabling after a rollback makes no baseline from the files the rollback committed, and the bodies are not doubled', () => {
  withRollbackVault(({ dir, shas }) => {
    const baselines = () => listDir(sessionsDir(dir)).filter((n) => n.includes('-baseline-'));
    const before = baselines();
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.deepEqual(back.baselines, []);
    assert.deepEqual(baselines(), before, 'no baseline entry was added');
    assert.equal(writeGeneratedViews(dir, WRITE).notMigrated, false);
    assert.equal(
      countOf(readRel(dir, 'projects/p/session-state.md'), `next for ${RB_IDS[0]}`),
      1,
      'the first original shows once',
    );
  });
});

test('re-enabling after a rollback and a committed hand edit makes exactly one baseline, and it holds the edit', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    put(
      dir,
      'projects/p/session-state.md',
      `${readRel(dir, 'projects/p/session-state.md')}\nOLD MACHINE EDIT\n`,
    );
    commitIn(dir);
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.equal(back.baselines.length, 1, back.baselines.join(', '));
    assert.ok(readRel(dir, back.baselines[0]).includes('OLD MACHINE EDIT'));
  });
});

test('re-enabling after a rollback whose marker was recommitted with CRLF bytes still makes no baseline and does not double the bodies', () => {
  withRollbackVault(({ dir, shas }) => {
    const baselines = () => listDir(sessionsDir(dir)).filter((n) => n.includes('-baseline-'));
    const before = baselines();
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    cgitOk(dir, ['config', 'core.autocrlf', 'false']);
    const marker = readRel(dir, RB_MARKER);
    assert.ok(marker.split('\n').filter((l) => /^[0-9a-f]{64} {2}/.test(l)).length >= 2);
    put(dir, RB_MARKER, marker.replaceAll('\n', '\r\n'));
    commitIn(dir);
    assert.ok(showHead(dir, RB_MARKER).includes('\r\n'), 'HEAD holds the CRLF marker');
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.deepEqual(back.baselines, []);
    assert.deepEqual(baselines(), before, 'no baseline entry was added');
    assert.equal(writeGeneratedViews(dir, WRITE).notMigrated, false);
    assert.equal(
      countOf(readRel(dir, 'projects/p/session-state.md'), `next for ${RB_IDS[0]}`),
      1,
      'the first original shows once',
    );
  });
});

test('rollback keeps leftover render temp files and old adjacent backups ignored while the flat files are tracked', () => {
  withRollbackVault(({ dir, shas }) => {
    const residue = [
      'projects/p/hot.md.20753.q5rab15x.tmp',
      'hot.md.20753.q5rab15x.tmp',
      'projects/p/hot.md.pre-projection-backup-1.md',
      'projects/p/sessions/2026-10-09-x-0.md.tmp',
    ];
    for (const rel of residue) put(dir, rel, 'left by a killed render\n');
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'ignored before the rollback');
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    for (const rel of residue) cgitOk(dir, ['check-ignore', '-q', '--', rel]); // throws unless ignored
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'nothing left to stage');
    const tracked = cgitOk(dir, ['ls-files', '--', ...RB_TRACKED])
      .trim()
      .split('\n');
    assert.ok(tracked.includes('projects/p/hot.md'), 'the flat files are tracked');
    assert.ok(!showHead(dir, '.gitignore').includes('\n/projects/*/hot.md\n'), 'view paths went');
  });
});

test('rollback keeps the local views of a project .hypoignore hides out of git: excluded locally, bytes untouched, the committed .gitignore silent', () => {
  withRollbackVault(({ dir, shas }) => {
    put(dir, '.hypoignore', 'projects/h/\n');
    put(dir, 'projects/h/index.md', '---\ntitle: h\n---\n');
    commitIn(dir);
    const views = ['projects/h/hot.md', 'projects/h/session-state.md'];
    for (const rel of views) put(dir, rel, `PRIVATE LOCAL CONTENT ${rel}\n`);
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'ignored before the rollback');
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    for (const rel of views) {
      assert.equal(readRel(dir, rel), `PRIVATE LOCAL CONTENT ${rel}\n`, `${rel} is untouched`);
      cgitOk(dir, ['check-ignore', '-q', '--', rel]); // throws unless ignored
    }
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
    assert.ok(
      !showHead(dir, '.gitignore').includes('projects/h'),
      'the project name stays private',
    );
    assert.ok(!readRel(dir, '.gitignore').includes('projects/h'));
    const exclude = cgitOk(dir, ['rev-parse', '--git-path', 'info/exclude']).trim();
    const lines = readFileSync(join(dir, exclude), 'utf-8').split('\n');
    assert.deepEqual(
      views.map((v) => lines.filter((l) => l === `/${v}`).length),
      [1, 1],
      'each view is listed once',
    );
  });
});

test('re-enabling after a rollback leaves the rolled-back root hot.md to the generator: no backup, no foreign-bytes notice', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    consumeRootHotHealthNotice(dir);
    const kept = backupsIn(dir, 'hot.md');
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.deepEqual(back.notices, [], 'the move says nothing about the root hot.md');
    const w = writeGeneratedViews(dir, WRITE);
    assert.equal(w.notMigrated, false);
    assert.ok(w.written.includes('hot.md'), 'the root view is regenerated');
    assert.deepEqual(w.backedUp, []);
    assert.deepEqual(
      backupsIn(dir, 'hot.md'),
      kept,
      'no pre-projection copy of the rollback bytes',
    );
    assert.equal(consumeRootHotHealthNotice(dir), null, 'no notice about foreign bytes');
  });
});

test('re-enabling does not vouch for a root hot.md edited after the rollback: its bytes are backed up and announced', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    const edit = 'a person edited the root after the rollback\n';
    put(dir, 'hot.md', edit);
    commitIn(dir); // committed: HEAD holds these bytes, and the re-enable still must not vouch for them
    const kept = backupsIn(dir, 'hot.md');
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    const fresh = backupsIn(dir, 'hot.md').filter((n) => !kept.includes(n));
    assert.equal(fresh.length, 1, JSON.stringify(back.notices));
    assert.equal(readRel(dir, fresh[0]), edit);
    assert.equal(back.notices.length, 1);
    assert.ok(back.notices[0].includes(fresh[0]), 'the notice names the backup');
  });
});

// A machine `b` that pulled the rollback and then pulls the re-enable commit: the same bytes arrive
// as a tracked file and leave again, and the second pull must not call them someone's own writing.
test('a clone that pulls the rollback and then the re-enable sets no root hot.md aside as unowned', () => {
  withOldClones(({ a, b }) => {
    assert.equal(migrate(a).migrated, true);
    putEntry(a, 'p', RB_IDS[0], { date: '2026-10-01' });
    commitIn(a);
    const point = headOf(a);
    putEntry(a, 'p', RB_IDS[1], { date: '2026-10-02' });
    commitIn(a);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['pull', '-q', '--ff-only']);
    assert.equal(writeGeneratedViews(b, WRITE).notMigrated, false);
    assert.equal(writeGeneratedViews(a, WRITE).notMigrated, false);
    assert.equal(rollbackSessionEntries(a, { at: point }).rolledBack, true);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['fetch', '-q']);
    const taken = fastForwardTo(b, '@{u}');
    assert.equal(taken.ok, true, JSON.stringify(taken));
    assert.equal(migrationState(b), 'opted-out');
    assert.equal(migrate(a, { reenable: true }).migrated, true);
    cgitOk(a, ['push', '-q']);
    cgitOk(b, ['fetch', '-q']);
    assert.notEqual(
      sha(readRel(b, 'hot.md')),
      readGeneratedViewsRecord(b).views['hot.md'],
      'precondition: the rolled-back root differs from what b generated',
    );
    const r = fastForwardTo(b, '@{u}');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(migrationState(b), 'migrated');
    assert.deepEqual(r.pre.unowned, []);
    assert.deepEqual(afterFastForward(b, r.pre).notices, []);
    assert.equal(backupsIn(b, 'hot.md').length, 0);
  });
});

test('a marker written before the hashes (one line) re-enables as it always did: the flat files become baselines', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    put(dir, RB_MARKER, `rolled back to ${shas[1]} on 2026-10-01\n`);
    commitIn(dir);
    assert.deepEqual(offMarkerHashes(showHead(dir, RB_MARKER)), {});
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.equal(back.baselines.length, 2, 'hot.md and session-state.md of p');
  });
});

test('a marker removed by hand after a rollback: the move names the generator-written flat files it makes baselines from', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    cgitOk(dir, ['rm', '-q', RB_MARKER]);
    cgitOk(dir, ['commit', '-q', '-m', 'drop the marker']);
    assert.equal(migrationState(dir), 'not-migrated');
    const back = migrate(dir);
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.equal(back.baselines.length, 2, 'the doubling the notice warns about');
    const notice = back.notices.find((n) => n.includes('기준선을 만듭니다')) ?? '';
    for (const rel of ['projects/p/hot.md', 'projects/p/session-state.md']) {
      assert.ok(notice.includes(rel), `${rel} is named: ${notice}`);
    }
    assert.ok(notice.includes(RB_MARKER), 'the notice names the marker that is likely gone');
  });
});

test('the same move with the marker still in HEAD or with hand-written old files adds no generator-output notice', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    const back = migrate(dir, { reenable: true });
    assert.equal(back.migrated, true, back.notices.join('\n')); // not the opted-out skip, which is silent too
    assert.ok(!back.notices.some((n) => n.includes('기준선을 만듭니다')), back.notices.join('\n'));
  });
  withOldGit((dir) => {
    const back = migrate(dir);
    assert.equal(back.migrated, true, back.notices.join('\n'));
    assert.equal(back.baselines.length, 2);
    assert.ok(!back.notices.some((n) => n.includes('기준선을 만듭니다')), back.notices.join('\n'));
  });
});

test('the off marker is not matched by the template .gitignore or by the migrated vault .gitignore', () => {
  withTmpDir((dir) => {
    cgitOk(dir, ['init', '-q']);
    put(dir, '.gitignore', readFileSync(join(REPO, 'templates', 'gitignore'), 'utf-8'));
    assert.equal(cgit(dir, ['check-ignore', '-q', RB_MARKER]).status, 1, 'template');
    put(dir, '.gitignore', `.cache/\n${GITIGNORE_BLOCK}`);
    assert.equal(cgit(dir, ['check-ignore', '-q', RB_MARKER]).status, 1, 'migrated vault');
  });
});

test('rollback command: exit 0 with the limits printed and the commit made, 1 when deferred, 2 for an unknown flag', () => {
  withRollbackVault(({ dir, shas }) => {
    const bad = rbRun(dir, ['rollback', `--at=${shas[1]}`, '--force']);
    assert.equal(bad.status, 2);
    assert.equal(rbRun(dir, ['rollback']).status, 2, 'no --at');
    assert.equal(rbRun(dir, ['migrate']).status, 2, 'no migrate subcommand');
    assert.equal(rbRun(dir, ['render', '--at=x']).status, 2, 'a flag of another subcommand');
    assert.equal(commitCount(dir), 5, 'a refused command made no commit');
    const missing = rbRun(dir, ['rollback', '--at=no-such-rev']);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /롤백을 미뤘습니다/);
    const ok = rbRun(dir, ['rollback', `--at=${shas[1]}`]);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(ok.stdout.includes(`롤백했습니다: ${headOf(dir)}`));
    for (const line of ROLLBACK_LIMITS) assert.ok(ok.stdout.includes(line), line);
    // The loop above passes when a line leaves the list, so the meanings that must be said are
    // pinned here, written out apart from the module.
    for (const phrase of [
      '지정한 커밋 뒤에 추가된 원본은 평면 파일에 들어 있지 않습니다',
      '구버전 Hypomnema는 sessions/를 읽지 못합니다',
      '지정한 커밋 뒤에 만든 프로젝트',
      'visibility_scope',
      '다음 동기화가 이 롤백을 원격에 올리므로',
      '구버전 기계는 롤백을 받을 때 로컬의 hot.md와 session-state.md를 덮어씁니다',
      '/hypo:upgrade --migrate-sessions',
    ]) {
      assert.ok(ok.stdout.includes(phrase), `the rollback output says: ${phrase}`);
    }
    assert.equal(migrationState(dir), 'opted-out');
  });
});

test('render command prints both views of the project to stdout and writes nothing', () => {
  withRollbackVault(({ dir }) => {
    // The views and the ownership record are git-ignored, so an empty status cannot see a write
    // to them: compare their bytes (and the project view's presence) around the call.
    const watched = [
      'hot.md',
      'projects/p/hot.md',
      'projects/p/session-state.md',
      '.cache/generated-views.json',
    ];
    const snapshot = () =>
      watched.map((rel) => [rel, existsSync(join(dir, rel)) ? readRel(dir, rel) : null]);
    const watchedBefore = snapshot();
    assert.ok(
      watchedBefore.every(([, text]) => text !== null),
      'the views and the ownership record exist to be compared',
    );
    const r = rbRun(dir, ['render', '--project=p']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('==> projects/p/hot.md <=='));
    assert.ok(r.stdout.includes('==> projects/p/session-state.md <=='));
    assert.ok(r.stdout.includes(`summary ${RB_IDS[2]}`));
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
    assert.deepEqual(
      snapshot(),
      watchedBefore,
      'render left the views and the ownership record alone',
    );
    assert.equal(rbRun(dir, ['render', '--project=nope']).status, 1);
    assert.deepEqual(snapshot(), watchedBefore, 'a refused render did not touch them either');
  });
});

// ── a move that fails after git started applying it, and notices that outlive a stop ─────────

const VIEW_PATHS = ['hot.md', 'projects/p/hot.md', 'projects/p/session-state.md'];
const NOTICE_FILE = (dir) => join(dir, '.cache', 'root-hot-projection-notice.json');

test('rollback with HEAD.lock held leaves HEAD, index and disk as they were, then succeeds once the lock is gone', () => {
  withRollbackVault(({ dir, shas }) => {
    const head = headOf(dir);
    const before = VIEW_PATHS.map((rel) => readRel(dir, rel));
    put(dir, '.git/HEAD.lock', '');
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, false);
    assert.match(r.deferred, /^fast-forward-failed/);
    assert.equal(headOf(dir), head, 'HEAD did not move');
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'no staged or stray file is left');
    assert.ok(!treeNames(dir).includes(RB_MARKER));
    assert.deepEqual(
      VIEW_PATHS.map((rel) => readRel(dir, rel)),
      before,
      'the views are as they were',
    );
    unlinkSync(join(dir, '.git/HEAD.lock'));
    const again = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(again.rolledBack, true, again.notices.join('\n'));
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
    assert.ok(treeNames(dir).includes(RB_MARKER));
  });
});

test('re-enabling with HEAD.lock held keeps the marker and the flat files, then succeeds once the lock is gone', () => {
  withRollbackVault(({ dir, shas }) => {
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, true);
    const head = headOf(dir);
    const flat = VIEW_PATHS.map((rel) => readRel(dir, rel));
    put(dir, '.git/HEAD.lock', '');
    const r = migrate(dir, { reenable: true });
    assert.equal(r.migrated, false);
    assert.match(r.deferred, /^fast-forward-failed/);
    assert.equal(headOf(dir), head);
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '', 'no deletion is left staged');
    assert.ok(existsSync(join(dir, RB_MARKER)), 'the marker is still on disk');
    assert.deepEqual(
      VIEW_PATHS.map((rel) => readRel(dir, rel)),
      flat,
      'the flat files are still on disk',
    );
    unlinkSync(join(dir, '.git/HEAD.lock'));
    const again = migrate(dir, { reenable: true });
    assert.equal(again.migrated, true, again.notices.join('\n'));
  });
});

test('rollback with index.lock held leaves the three owned views on disk', () => {
  withRollbackVault(({ dir, shas }) => {
    const before = VIEW_PATHS.map((rel) => readRel(dir, rel));
    put(dir, '.git/index.lock', '');
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, false);
    assert.match(r.deferred, /^fast-forward-failed/);
    assert.deepEqual(
      VIEW_PATHS.map((rel) => readRel(dir, rel)),
      before,
    );
    unlinkSync(join(dir, '.git/index.lock'));
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
  });
});

test('a rollback that is taken back leaves no notice about the backups it removed', () => {
  withRollbackVault(({ dir, shas }) => {
    consumeRootHotHealthNotice(dir); // what the fixture's own writes left
    put(dir, 'projects/p/hot.md', 'my own hot\n');
    put(dir, '.git/index.lock', '');
    assert.equal(rollbackSessionEntries(dir, { at: shas[1] }).rolledBack, false);
    assert.equal(readRel(dir, 'projects/p/hot.md'), 'my own hot\n', 'the edit is back');
    assert.equal(backupsIn(dir, 'projects/p/hot.md').length, 0, 'the backup is gone');
    assert.equal(consumeRootHotHealthNotice(dir), null, 'so is the notice that named it');
  });
});

test('a stop right after the clearing step leaves a pending notice that names the backup', () => {
  withRollbackVault(({ dir, shas }) => {
    put(dir, 'projects/p/hot.md', 'my own hot\n');
    assert.throws(
      () =>
        rollbackSessionEntries(dir, {
          at: shas[1],
          testHooks: {
            afterArchive: () => {
              throw new Error('killed');
            },
          },
        }),
      /killed/,
    );
    const [backup] = backupsIn(dir, 'projects/p/hot.md');
    assert.ok(backup, 'the edit is in a backup');
    const notice = consumeRootHotHealthNotice(dir) ?? '';
    assert.ok(notice.includes(backup), `the notice names ${backup}: ${notice}`);
  });
});

test('a notice that cannot be stored stops the clearing before it removes the edit', () => {
  withRollbackVault(({ dir, shas }) => {
    consumeRootHotHealthNotice(dir);
    put(dir, 'projects/p/hot.md', 'my own hot\n');
    mkdirSync(NOTICE_FILE(dir), { recursive: true });
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, false);
    assert.equal(r.deferred, 'notice-write-failed');
    assert.equal(readRel(dir, 'projects/p/hot.md'), 'my own hot\n', 'the edit was not touched');
    assert.equal(cgitOk(dir, ['status', '--porcelain']), '');
  });
});

test('a successful rollback has every notice it returns in the store, with the archive already gone', () => {
  withRollbackVault(({ dir, shas }) => {
    put(dir, 'projects/p/hot.md', 'my own hot\n');
    const r = rollbackSessionEntries(dir, { at: shas[1] });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    assert.ok(r.notices.length > 0);
    assert.ok(!existsSync(join(dir, '.cache', 'pull-archive.json')), 'the archive is deleted');
    const stored = consumeRootHotHealthNotice(dir) ?? '';
    for (const line of r.notices) assert.ok(stored.includes(line), `stored: ${line}`);
  });
});

test('a notice that cannot be stored after the move keeps the archive for the next run', () => {
  withRollbackVault(({ dir, shas }) => {
    put(dir, 'projects/p/hot.md', 'my own hot\n');
    const r = rollbackSessionEntries(dir, {
      at: shas[1],
      testHooks: {
        // the clearing step stored its notice; now the store becomes unwritable
        afterArchive: () => {
          unlinkSync(NOTICE_FILE(dir));
          mkdirSync(NOTICE_FILE(dir));
        },
      },
    });
    assert.equal(r.rolledBack, true, r.notices.join('\n'));
    assert.ok(existsSync(join(dir, '.cache', 'pull-archive.json')), 'the archive stays');
  });
});
