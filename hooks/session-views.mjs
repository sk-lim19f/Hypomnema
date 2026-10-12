// hooks/session-views.mjs, the IO half of the session entry scheme.
//
// session-entries.mjs knows what an entry file and a generated view look like; this module reads
// the entries off disk into project models, writes the generated views (`hot.md`,
// `session-state.md`, the root `hot.md`) under the vault commit lock without ever overwriting
// bytes it did not write, tells whether the vault has moved to the scheme (`migrationState`),
// and keeps the per-session record of which track heads a session was told about.
//
// Imports hypo-shared.mjs and session-entries.mjs, never the other way round for anything but
// pure helpers (hypo-shared imports `scopeVisible` from session-entries). Node built-ins only
// besides those. Listed in `hooks/shared.json`.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from './atomic-write.mjs';
import { isValidSessionId } from './proposal-store.mjs';
import {
  GITATTRIBUTES_BLOCK,
  GITIGNORE_BLOCK,
  LEGACY_TRACK_ID,
  TRACK_ID_RE,
  buildLegacyBaselines,
  generatedViewSlug,
  isBaselineId,
  isGeneratedViewPath,
  isSessionEntryPath,
  isSessionProjectDir,
  missingBlockLines,
  narrowestVisibilityScope,
  parseSessionEntry,
  projectNameProblem,
  renderViews,
  splitLegacyFrontmatter,
  trackHeads,
} from './session-entries.mjs';
import {
  backUpGeneratedPath,
  cacheNotIgnoredNotice,
  clearGeneratedPathsBlockingPull,
  currentDevice,
  frontmatterScalar,
  isIgnored,
  legacyBaselineDate,
  listSessionProjects,
  listTrackedGeneratedViews,
  loadHypoIgnore,
  markPullArchiveMerged,
  migrationState,
  offMarkerHashes,
  pathInHead,
  projectHiddenByHypoignore,
  readGeneratedViewsRecord,
  readLegacyMovePending,
  readRootHotProjectionOwnership,
  readVisibilityScope,
  resumePullArchive,
  rootHotBackupRecoveryNotice,
  setAsideNotices,
  revPathArg,
  SESSION_ENTRIES_OFF_MARKER,
  undoClearedPaths,
  unignoredCachePaths,
  unignoredPaths,
  vaultCommitLockTarget,
  vaultGitPrefix,
  vaultHasNoGit,
  withFileLock,
  writeLegacyMovePending,
  writeGeneratedViewsRecord,
  writeRootHotHealthNotice,
} from './hypo-shared.mjs';

// Defined in hypo-shared.mjs, whose close gate needs them; this module stays where callers import
// them from.
export {
  SESSION_ENTRIES_OFF_MARKER,
  listSessionProjects,
  listTrackedGeneratedViews,
  migrationState,
  offMarkerHashes,
} from './hypo-shared.mjs';

/**
 * How long into a SessionStart the hook may still begin moving a vault to the scheme. Past this the
 * move waits for the next session; a move that has begun always runs to its end. Measured on a
 * 17-project vault: the migration stage took 7.0s (about 0.4s per project for the move) and
 * rendering 0.6s, so a start at 15s ends well inside the 30s SessionStart timeout (a start at 20s
 * left 2.4s). The 15s value assumes a vault of about that size: the move costs about 0.4s per
 * project, so a vault several times larger can still overrun the timeout once begun.
 */
export const MIGRATION_START_DEADLINE_MS = 15000;

// `entry_scope` has the grammar of `visibility_scope`; anything else closes the project.
const ENTRY_SCOPE_RE = /^(shared|machine:\S*|agent:\S+)$/;

const sha256 = (text) => createHash('sha256').update(text, 'utf-8').digest('hex');

const git = (hypoDir, args) =>
  spawnSync('git', ['-C', hypoDir, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
  });

/** File text, `null` when it does not exist; any other read error is thrown. */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

const lenientRead = (path) => {
  try {
    return readOrNull(path);
  } catch {
    return null;
  }
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── projects and entries ─────────────────────────────────────────────────────

/**
 * The parsed entries of one project plus the files that could not be read: `{entries, unreadable}`.
 * When several files hold the same close id, the one with the smallest file name is the entry and
 * the others are dropped. A file that disappears between the directory listing and its read (a pull in flight) is skipped.
 * Any other read error and a parse failure go to `unreadable[]` as `{fileName, reason}`, so a bad
 * entry shows up in the view instead of vanishing. `testHooks.betweenListAndRead` runs after the
 * listing, so a test can delete a file at exactly that point.
 */
export function listSessionEntries(hypoDir, project, { testHooks } = {}) {
  const dir = join(hypoDir, 'projects', project, 'sessions');
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { entries: [], unreadable: [] };
    throw err;
  }
  names = names
    .filter((n) => isSessionEntryPath(`projects/${project}/sessions/${n}`))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  testHooks?.betweenListAndRead?.();
  const entries = [];
  const unreadable = [];
  for (const fileName of names) {
    let text;
    try {
      text = readOrNull(join(dir, fileName));
    } catch (err) {
      unreadable.push({ fileName, reason: `read-error: ${err?.code ?? err?.message}` });
      continue;
    }
    if (text === null) continue;
    const parsed = parseSessionEntry(text);
    if (!parsed.ok) unreadable.push({ fileName, reason: parsed.reason });
    // One entry per close id: two clones that migrated on their own date one baseline differently
    // and so name two files for one id. `names` is sorted, so the smallest file name stays.
    else if (!entries.some((e) => e.closeId === parsed.entry.closeId)) entries.push(parsed.entry);
  }
  return { entries, unreadable };
}

// ── model ────────────────────────────────────────────────────────────────────

function entryScopeOf(indexText) {
  const raw = frontmatterScalar(indexText, 'entry_scope');
  if (raw === null) return null;
  return ENTRY_SCOPE_RE.test(raw) ? raw : 'machine:';
}

// The baseline scopes `buildLegacyBaselines` takes, read from the three texts.
const baselineScopes = (indexText, hotText, stateText) => ({
  index: readVisibilityScope(indexText ?? ''),
  hot: readVisibilityScope(hotText ?? ''),
  state: readVisibilityScope(stateText ?? ''),
});

// An old file's bytes as the baseline would hold them: `null` when the file is absent, or when the
// bytes are what the generator itself last wrote at that path (`views` is the ownership record).
// The generator's own output is not old memory. A file the generator wrote and a person then edited
// has other bytes, so it still counts, whatever its frontmatter says.
// `rolledBack` (`{rel: sha256}`, from the off marker) lists the flat files a rollback committed: they
// are generated bytes too, rendered from the entries, so they are not old memory either.
function oldFileText(views, rel, text, rolledBack = {}) {
  if (text === null || views[rel] === sha256(text) || rolledBack[rel] === sha256(text)) return null;
  return text;
}

/**
 * The text of the off marker a rollback commits. The first line stays readable by a person
 * (`rolled back to <sha> on <date>`); each further line is `<sha256>  <path>` for a flat file the
 * rollback committed, so a later re-enable can tell those bytes from an edit made after them.
 * `flat` is `[{relPath, text}]`.
 */
export function offMarkerText(point, date, flat) {
  const lines = flat.map((f) => `${sha256(f.text)}  ${f.relPath}`);
  return `rolled back to ${point} on ${date}\n${lines.map((l) => `${l}\n`).join('')}`;
}

// The ids of the old-scheme tracks (`legacy` and each `legacy-*` split out of one file) whose every
// head is done in the project's real entries. Each id is judged on its own: finishing the leftover
// `legacy` does not finish a track that was split out of the same file.
function doneLegacyTracks(hypoDir, slug) {
  return trackHeads(listSessionEntries(hypoDir, slug).entries)
    .filter((t) => t.done && (t.trackId === LEGACY_TRACK_ID || t.trackId.startsWith('legacy-')))
    .map((t) => t.trackId);
}

// The in-memory entries that stand for a not-yet-migrated project's old `hot.md` and
// `session-state.md` (whichever of them is on disk), one entry per file, built from the bytes in
// the working tree: a hand edit or a write git has not committed yet is part of what the session
// is told, and a file the vault's own `.gitignore` keeps out of git is not hidden. The migration
// commit reads HEAD instead, so a file that differs from HEAD gets another id than the baseline the
// migration will make; the additional baseline made from this machine's local bytes covers that.
// `[]` when neither file is there. After the move (`afterMove`) a file carrying the generator's
// marker is a view, not old memory, whatever its hash says.
function virtualBaselines(hypoDir, project, indexText, views, afterMove) {
  const [hotText, stateText] = ['hot.md', 'session-state.md'].map((name) => {
    const rel = `projects/${project}/${name}`;
    const text = oldFileText(views, rel, lenientRead(join(hypoDir, rel)));
    return afterMove && text !== null && frontmatterScalar(text, 'generated') === 'sessions'
      ? null
      : text;
  });
  if (hotText === null && stateText === null) return [];
  return buildLegacyBaselines({
    hotText,
    stateText,
    date: legacyBaselineDate(hypoDir, project, [hotText ?? '', stateText ?? '']),
    project,
    scopes: baselineScopes(indexText, hotText, stateText),
    legacyDone: false,
  }).map((built) => {
    const parsed = parseSessionEntry(built.text);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.entry;
  });
}

/**
 * The model one project's views are made from: `{project, migrated, entries, unreadable, notes,
 * notesScope, entryScope}`. `migrated` is whether `migrationState` is `migrated`; before that the model also
 * holds a virtual baseline entry for each old file on disk (nothing is written). `notes`
 * is the body of `notes.md` or `null` (`null` for a note `.hypoignore` hides; `notesScope` is its
 * `visibility_scope`, `''` when it has none); `entryScope` is the `entry_scope` of `index.md` (a value
 * that is not a valid scope closes the project as `machine:`) or `null`. `opts.state` passes an
 * already known `migrationState`; `opts.testHooks` goes to `listSessionEntries`; `opts.localOld`
 * adds the virtual baselines of old files on disk to a migrated model too (injection only).
 */
export function loadSessionModel(hypoDir, project, opts = {}) {
  const state = opts.state ?? migrationState(hypoDir);
  const migrated = state === 'migrated';
  const { entries, unreadable } = listSessionEntries(hypoDir, project, opts);
  const base = join(hypoDir, 'projects', project);
  const indexText = lenientRead(join(base, 'index.md'));
  // A note `.hypoignore` hides is not read at all; its `visibility_scope` travels with it, and the
  // injection applies the same device judgment the entries get.
  const notesPath = join(base, 'notes.md');
  const notesText = isIgnored(notesPath, hypoDir, opts.patterns ?? loadHypoIgnore(hypoDir))
    ? null
    : lenientRead(notesPath);
  // `opts.localOld` also reads the old files still on disk after the move: one git did not track
  // is not in a baseline, and the session that starts right after the move should still be told it
  // (the writer backs it up next). Never used for a view: the text would be published.
  if (!migrated || opts.localOld) {
    try {
      const { views } = readGeneratedViewsRecord(hypoDir);
      for (const baseline of virtualBaselines(hypoDir, project, indexText, views, migrated)) {
        // A real baseline file with this id (an interrupted move) stands for it already.
        if (!entries.some((e) => e.closeId === baseline.closeId)) entries.push(baseline);
      }
    } catch (err) {
      unreadable.push({ fileName: 'session-state.md', reason: `baseline: ${err?.message ?? err}` });
    }
  }
  return {
    project,
    migrated,
    entries,
    unreadable,
    notes: notesText === null ? null : splitLegacyFrontmatter(notesText).body.trim() || null,
    notesScope: notesText === null ? '' : readVisibilityScope(notesText),
    entryScope: indexText === null ? null : entryScopeOf(indexText),
  };
}

/**
 * The `visibility_scope` a new entry of `project` carries. An `entry_scope` in `index.md` wins as
 * it is; otherwise the narrowest of the `index.md` value and the `session-state.md` baseline's value
 * (the entry that carries the `legacy` track, which new entries continue). The old `hot.md`
 * baseline's value is left out: it hides only its own summary, and letting it narrow every new entry
 * would hide the closes of a project whose state file is shared. `model` is optional.
 */
export function projectEntryScope(hypoDir, project, model) {
  const m = model ?? loadSessionModel(hypoDir, project);
  if (typeof m.entryScope === 'string') return m.entryScope;
  const indexText = lenientRead(join(hypoDir, 'projects', project, 'index.md'));
  const stateBaselines = m.entries.filter(
    (e) => isBaselineId(e.closeId) && e.tracks.some((t) => t.id === LEGACY_TRACK_ID),
  );
  return narrowestVisibilityScope([
    readVisibilityScope(indexText ?? ''),
    ...stateBaselines.map((e) => e.visibilityScope),
  ]).scope;
}

/**
 * The models of every session project as the tree of `rev` holds them (what a rollback renders
 * from): the entries, `index.md` and `notes.md` are read with `git show`, never from the working
 * tree, so an entry that arrived after `rev` cannot get in. A project `.hypoignore` hides is left
 * out, as the generator leaves it out. The models are `migrated` (the rendered views are those of
 * the scheme). Throws when git cannot list or read the tree.
 */
export function loadSessionModelsAt(hypoDir, rev) {
  const listed = git(hypoDir, ['ls-tree', '-r', '-z', '--name-only', rev]);
  if (listed.status !== 0) throw new Error(`git ls-tree ${rev}: ${String(listed.stderr).trim()}`);
  const paths = listed.stdout.split('\0').filter(Boolean);
  const have = new Set(paths);
  const slugs = [...new Set(paths.map((p) => /^projects\/([^/]+)\//.exec(p)?.[1]).filter(Boolean))]
    .filter((slug) =>
      isSessionProjectDir({
        slug,
        hasIndex: have.has(`projects/${slug}/index.md`),
        hasSessions: paths.some((p) => p.startsWith(`projects/${slug}/sessions/`)),
      }),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const patterns = loadHypoIgnore(hypoDir);
  const read = (rel) => {
    const r = git(hypoDir, ['show', revPathArg(rev, rel)]);
    if (r.status !== 0)
      throw new Error(`git show ${revPathArg(rev, rel)}: ${String(r.stderr).trim()}`);
    return r.stdout;
  };
  return slugs
    .filter((slug) => !projectHiddenByHypoignore(hypoDir, slug, patterns))
    .map((project) => {
      const entries = [];
      const unreadable = [];
      const files = paths
        .filter((p) => p.startsWith(`projects/${project}/sessions/`) && isSessionEntryPath(p))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const rel of files) {
        const parsed = parseSessionEntry(read(rel));
        const fileName = rel.slice(rel.lastIndexOf('/') + 1);
        if (!parsed.ok) unreadable.push({ fileName, reason: parsed.reason });
        else if (!entries.some((e) => e.closeId === parsed.entry.closeId))
          entries.push(parsed.entry);
      }
      const base = `projects/${project}`;
      const indexText = have.has(`${base}/index.md`) ? read(`${base}/index.md`) : null;
      const notesPath = join(hypoDir, base, 'notes.md');
      const notesText =
        have.has(`${base}/notes.md`) && !isIgnored(notesPath, hypoDir, patterns)
          ? read(`${base}/notes.md`)
          : null;
      return {
        project,
        migrated: true,
        entries,
        unreadable,
        notes: notesText === null ? null : splitLegacyFrontmatter(notesText).body.trim() || null,
        notesScope: notesText === null ? '' : readVisibilityScope(notesText),
        entryScope: indexText === null ? null : entryScopeOf(indexText),
      };
    });
}

// ── writing the views ────────────────────────────────────────────────────────

// `.cache/generated-views.json` = {views: {relPath: sha}}, read and written by hypo-shared's one
// reader and writer. A file that cannot be read makes every path unowned (backed up before it is
// overwritten). A missing file starts from the old root projection's hash for `hot.md`. `dirty`
// says the record on disk needs rewriting.
function readOwnership(hypoDir) {
  const { views, state } = readGeneratedViewsRecord(hypoDir);
  if (state === 'missing') {
    const { lastHash } = readRootHotProjectionOwnership(hypoDir);
    if (lastHash) views['hot.md'] = lastHash;
  }
  return { views, dirty: state !== 'ok', fresh: state === 'missing' };
}

// Write one view if its bytes differ. Bytes this writer did not last write at this very path are
// backed up first, and the file is read again right before the replacing write so a save landing
// in between is backed up as well. The ownership record takes the new hash before the replacing
// write, so a process that dies after the write finds its own bytes vouched for (the other order
// would back them up as foreign on the next run). Each backup is announced in the health notice
// right after it is written and before its source is replaced: a later view that fails would
// otherwise leave a hand edit saved in `.cache/backups/` that no notice ever names, because the next
// run finds the generator's bytes in place. A notice that cannot be written stops the replacement.
function writeOneView(hypoDir, relPath, content, own, testHooks, result) {
  const abs = join(hypoDir, relPath);
  const sha = sha256(content);
  const read = () => readOrNull(abs);
  const ours = (text) => sha256(text) === own.views[relPath];
  const claim = () => {
    if (own.views[relPath] !== sha) {
      own.views[relPath] = sha;
      own.dirty = true;
    }
  };
  const current = read();
  if (current === content) {
    claim();
    result.unchanged.push(relPath);
    return;
  }
  const backups = [];
  const backUp = (text) => {
    const backupPath = backUpGeneratedPath(hypoDir, abs, text, testHooks);
    if (!writeRootHotHealthNotice(hypoDir, rootHotBackupRecoveryNotice(relPath, backupPath)))
      throw new Error(`the notice for the backup of ${relPath} could not be written`);
    backups.push(backupPath);
  };
  if (current !== null && !ours(current)) backUp(current);
  testHooks?.beforeFinalWrite?.(abs);
  const latest = read();
  if (latest === content) {
    claim();
    result.unchanged.push(relPath);
  } else {
    if (latest !== current && latest !== null && !ours(latest)) backUp(latest);
    if (own.views[relPath] !== sha) {
      own.views[relPath] = sha;
      writeGeneratedViewsRecord(hypoDir, own.views);
    }
    atomicWrite(abs, content);
    result.written.push(relPath);
  }
  for (const backupPath of backups) result.backedUp.push({ relPath, backupPath });
}

const emptyResult = (over) => ({
  notMigrated: false,
  lockTimeout: false,
  written: [],
  unchanged: [],
  backedUp: [],
  stageableViews: [],
  ...over,
});

// A migrated vault whose `.gitignore` block lost a line is not rendered into: the views would sit
// outside the ignore patterns and a `git add -A` tool would stage them. Stopping silently is not
// acceptable, so the next SessionStart gets a notice naming the lines. A plain not-migrated vault
// stays silent. Each line of a message is kept once in the notice file, so repeated renders do not
// pile notices up.
function skipIncompleteBlock(hypoDir, state) {
  const missing =
    missingBlockLines(showText(hypoDir, 'HEAD', '.gitignore') ?? '', GITIGNORE_BLOCK) ?? [];
  writeRootHotHealthNotice(
    hypoDir,
    '세션 현황 파일: .gitignore의 Hypomnema 블록이 불완전해 이번에는 갱신하지 않았습니다 ' +
      '(생성 파일이 ignore 밖에서 저장소에 올라가는 일을 막기 위해서입니다). ' +
      `빠진 줄: ${missing.join(', ')}. 블록 전체를 되살려 커밋하세요. 판정은 커밋된 .gitignore(HEAD)를 읽으므로, 작업 트리만 고쳐서는 갱신이 다시 시작되지 않습니다.`,
  );
  return emptyResult({ notMigrated: true, state, missingBlockLines: missing });
}

// The backups and the ownership record the writer keeps under `.cache/` must not be stageable by a
// `git add -A`. A vault whose own `.gitignore` leaves `.cache/` out gets the same stop as a damaged
// block: nothing is written, and the next SessionStart says why.
function skipUnignoredCache(hypoDir, state, unignored) {
  writeRootHotHealthNotice(hypoDir, `세션 현황 파일: ${cacheNotIgnoredNotice(unignored)}`);
  return emptyResult({ notMigrated: true, state, unignoredCache: unignored });
}

// What to tell the user about the scope a baseline took: two scopes that name different machines
// close it for everyone, and a scope that differs from `index.md`'s is carried into new entries.
function baselineScopeNotices(slug, built, indexScope) {
  const file = built.kind === 'hot' ? 'hot.md' : 'session-state.md';
  if (built.conflict) {
    return [
      `프로젝트 ${slug}: 옛 ${file}와 프로젝트의 범위가 서로 다른 기계를 가리켜 그 기준선을 machine:으로 닫았습니다. 어느 기계에서도 보이지 않습니다.`,
    ];
  }
  if (built.scope !== null && built.scope !== indexScope) {
    return [
      `이행 뒤 프로젝트 ${slug}의 원본은 옛 파일의 범위를 이어받습니다: ${indexScope || '(없음)'} → ${built.scope} (${file})`,
    ];
  }
  return [];
}

// ── moving a vault that is not a git repository ──────────────────────────────

const VIEW_NAMES = ['hot.md', 'session-state.md'];

/**
 * Move the old `hot.md` and `session-state.md` of a vault that is not a git repository into
 * baseline entries (one per file, the same entries a git vault's migration makes, only without a
 * repository to record it in), so the generator that follows does not meet them as bytes it never
 * wrote. `own` is the ownership record `readOwnership` returned; the moved files' bytes are
 * claimed in it (they are kept whole in the entry, so the generator may replace them without a
 * backup) and the record is saved at once. Returns `{created: [relPath], notices: [string],
 * blocked: [slug]}`. The caller holds the vault commit lock.
 *
 * Which projects are looked at: every one while the vault has no ownership record (the generator
 * has not written a view yet), afterwards only those that were set aside then (hidden by
 * `.hypoignore`, or blocked, see below) and are visible now. The record is vault wide and a
 * project can miss the first pass, so it cannot say that a given project was moved; the set aside
 * list does. A visible project outside both is judged as before: a file that is foreign to the
 * generator is an edit to a generated view, not old memory, and the generator backs it up and
 * reports it, as in a git vault. A file the generator wrote (`generated: sessions`) is not an old file.
 *
 * Per project, the move is complete when every baseline file the old files would make is in
 * `sessions/` with the bytes the move would write: a run that died part way writes only the
 * missing ones next time, and one that died before saving the record claims the old files without
 * writing anything. A file already at a baseline's name with other bytes is not that baseline, and
 * claiming the old file on its word would let the generator replace the only copy of it: the
 * project is `blocked` (nothing written, nothing claimed, the old files untouched), a notice names
 * the path, and the caller leaves the project's views alone until the clash is resolved.
 */
export function moveLegacyFilesToEntriesUnlocked(hypoDir, own) {
  const created = [];
  const notices = [];
  const blocked = [];
  const pendingBefore = readLegacyMovePending(hypoDir);
  if (!own.fresh && pendingBefore.size === 0) return { created, notices, blocked };
  const pending = new Set(pendingBefore);
  const patterns = loadHypoIgnore(hypoDir);
  let names = [];
  try {
    names = readdirSync(join(hypoDir, 'projects'));
  } catch {
    // no projects/: nothing to move
  }
  let claimed = false;
  for (const slug of names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (slug === '_template' || !isSessionProjectDir({ slug, hasIndex: true })) continue;
    if (!own.fresh && !pending.has(slug)) continue;
    // A view of this project already has an ownership record: its move completed earlier and the
    // slug is stale. Moving now would baseline a later hand edit instead of letting the writer back it up.
    if (!own.fresh && VIEW_NAMES.some((n) => Object.hasOwn(own.views, `projects/${slug}/${n}`))) {
      pending.delete(slug);
      continue;
    }
    const base = join(hypoDir, 'projects', slug);
    const [hotText, stateText] = ['hot.md', 'session-state.md'].map((name) => {
      const text = lenientRead(join(base, name));
      if (text === null || frontmatterScalar(text, 'generated') === 'sessions') return null;
      return own.views[`projects/${slug}/${name}`] === sha256(text) ? null : text;
    });
    if (hotText === null && stateText === null) {
      pending.delete(slug);
      continue;
    }
    if (projectHiddenByHypoignore(hypoDir, slug, patterns)) {
      pending.add(slug);
      continue;
    }
    const indexText = lenientRead(join(base, 'index.md'));
    const indexScope = readVisibilityScope(indexText ?? '');
    const plan = buildLegacyBaselines({
      hotText,
      stateText,
      date: legacyBaselineDate(hypoDir, slug, [hotText ?? '', stateText ?? '']),
      project: slug,
      scopes: baselineScopes(indexText, hotText, stateText),
      legacyDone: doneLegacyTracks(hypoDir, slug),
    }).map((built) => ({
      built,
      relPath: `projects/${slug}/sessions/${built.fileName}`,
    }));
    const clash = plan.find(({ built, relPath }) => {
      const there = lenientRead(join(hypoDir, relPath));
      return there !== null && there !== built.text;
    });
    if (clash) {
      pending.add(slug);
      blocked.push(slug);
      notices.push(
        `프로젝트 ${slug}: ${clash.relPath}에 이미 다른 내용의 파일이 있어 옛 hot.md와 session-state.md를 옮기지 않았습니다. ` +
          '옛 파일은 그대로 두었고 이 프로젝트의 현황 파일은 갱신하지 않습니다. 그 파일을 확인하고 치운 뒤 다시 시작하세요.',
      );
      continue;
    }
    for (const { built, relPath } of plan) {
      if (lenientRead(join(hypoDir, relPath)) !== null) continue; // an earlier run wrote it
      atomicWrite(join(hypoDir, relPath), built.text);
      created.push(relPath);
      notices.push(...baselineScopeNotices(slug, built, indexScope));
    }
    pending.delete(slug);
    for (const [name, text] of [
      ['hot.md', hotText],
      ['session-state.md', stateText],
    ]) {
      if (text !== null) own.views[`projects/${slug}/${name}`] = sha256(text);
      claimed ||= text !== null;
    }
  }
  // The list goes first: a run that dies before the record is saved still knows who is waiting.
  if (pending.size !== pendingBefore.size || [...pending].some((x) => !pendingBefore.has(x)))
    writeLegacyMovePending(hypoDir, pending);
  if (claimed) {
    writeGeneratedViewsRecord(hypoDir, own.views);
    own.dirty = false;
    own.fresh = false;
  }
  if (created.length) {
    notices.unshift(
      `git 저장소가 아닌 볼트라 옛 hot.md와 session-state.md를 세션 원본(기준선)으로 옮겼습니다: ${created.join(', ')}`,
    );
  }
  return { created, notices, blocked };
}

/**
 * `writeGeneratedViews` for a caller that already holds the vault commit lock (the lock is not
 * reentrant). `opts`: `projects` (slugs, default every session project), `root` (write the root
 * `hot.md`, default true), `device` (default `currentDevice()`), `testHooks`. Returns
 * `{notMigrated, lockTimeout, written[], unchanged[], backedUp[{relPath, backupPath}]}`; when the
 * vault is not `migrated` nothing is written and `notMigrated` is true (`incomplete-block` also adds
 * `missingBlockLines[]` and leaves a health notice; a `.cache/` that git would not ignore adds
 * `unignoredCache[]` and leaves one too). A view path git would not ignore (a later `!` rule) is not
 * written and listed in `stageableViews[]`, with a notice naming it. A project that
 * `.hypoignore` hides (see `projectHiddenByHypoignore`) is neither read nor written and has no
 * root row. Any backup leaves a health notice for the next SessionStart, written right after the
 * backup (see `writeOneView`).
 */
export function writeGeneratedViewsUnlocked(hypoDir, opts = {}) {
  const { root = true, device = currentDevice(), testHooks } = opts;
  const state = migrationState(hypoDir);
  if (state === 'incomplete-block') return skipIncompleteBlock(hypoDir, state);
  if (state !== 'migrated') return emptyResult({ notMigrated: true, state });
  const unignored = unignoredCachePaths(hypoDir);
  if (unignored.length) return skipUnignoredCache(hypoDir, state, unignored);
  // A vault with no git has no migration to move its old `hot.md` and `session-state.md`: they
  // move into baseline entries here, before anything is rendered over them.
  const own = readOwnership(hypoDir);
  let blocked = [];
  if (vaultHasNoGit(hypoDir)) {
    const moved = moveLegacyFilesToEntriesUnlocked(hypoDir, own);
    blocked = moved.blocked;
    if (moved.notices.length) writeRootHotHealthNotice(hypoDir, moved.notices.join('\n'));
  }
  // A project the `.hypoignore` hides gets no views and no row in the root table: its entries are
  // never committed, so a table row would publish a project the owner chose to keep local.
  const patterns = loadHypoIgnore(hypoDir);
  const hidden = (p) => projectHiddenByHypoignore(hypoDir, p, patterns);
  const all = listSessionProjects(hypoDir).filter((p) => !hidden(p));
  // A project whose move was blocked keeps its old files: rendering would back them up and replace them.
  const only = (opts.projects ? all.filter((p) => opts.projects.includes(p)) : all).filter(
    (p) => !blocked.includes(p),
  );
  const models = all.map((p) => loadSessionModel(hypoDir, p, { state, testHooks }));
  const views = renderViews(models, { device, only });
  const allTargets = only.flatMap((slug) => [
    [`projects/${slug}/hot.md`, views.projects[slug].hot],
    [`projects/${slug}/session-state.md`, views.projects[slug].sessionState],
  ]);
  if (root) allTargets.push(['hot.md', views.root]);
  // The block's lines being present does not make a view ignored: a later `!` rule can let one
  // through, and `git add -A` would stage what the generator writes. Judge each path by the
  // effective rules and write none that git would stage.
  const stageable = new Set(
    unignoredPaths(
      hypoDir,
      allTargets.map(([relPath]) => relPath),
    ),
  );
  const targets = allTargets.filter(([relPath]) => !stageable.has(relPath));
  const notes = [];
  if (stageable.size) {
    notes.push(
      `세션 현황 파일: ${[...stageable].join(', ')}를 .gitignore가 무시하지 않아(뒤쪽의 \`!\` 규칙일 수 있습니다) ` +
        '쓰지 않았습니다. 그대로 쓰면 git add -A가 생성 파일을 스테이징합니다. ' +
        '그 규칙을 지우거나 해당 경로를 무시하는 줄을 .gitignore 끝에 추가하면 다음 갱신부터 씁니다.',
    );
  }

  const result = emptyResult({ state, stageableViews: [...stageable] });
  let failure = null;
  try {
    for (const [relPath, content] of targets) {
      writeOneView(hypoDir, relPath, content, own, testHooks, result);
    }
  } catch (err) {
    failure = err;
  }
  if (own.dirty) {
    try {
      writeGeneratedViewsRecord(hypoDir, own.views);
    } catch (err) {
      failure ??= err;
    }
  }
  if (notes.length) writeRootHotHealthNotice(hypoDir, notes.join('\n'));
  if (failure) throw failure;
  return result;
}

/**
 * Render and write the generated views under the vault commit lock (the same lock the auto-commit
 * and the close apply take, so a pull never leaves `sessions/` half changed under a render). A
 * busy lock is not an error: it returns `lockTimeout: true` and leaves a health notice. See
 * `writeGeneratedViewsUnlocked` for `opts` and the result.
 */
export function writeGeneratedViews(hypoDir, opts = {}) {
  try {
    return withFileLock(
      vaultCommitLockTarget(hypoDir),
      () => writeGeneratedViewsUnlocked(hypoDir, opts),
      {
        timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000,
      },
    );
  } catch (err) {
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    writeRootHotHealthNotice(
      hypoDir,
      '세션 현황 파일: 다른 세션이 저장소 잠금을 쥐고 있어 이번에는 갱신하지 않았습니다 (이전 내용을 그대로 둡니다).',
    );
    return emptyResult({ lockTimeout: true });
  }
}

// ── observed heads ───────────────────────────────────────────────────────────

const LEVELS = ['full', 'pointer'];

// Same place as the other per-session artifacts (`.cache/sessions/<sid>/`); a valid session id
// is `[A-Za-z0-9_-]+`, so it needs no sanitizing to be one path segment.
const observedPath = (hypoDir, sessionId) =>
  join(hypoDir, '.cache', 'sessions', sessionId, 'observed-heads.json');

function cleanHeads(src) {
  const out = {};
  if (!isPlain(src)) return out;
  for (const [trackId, ids] of Object.entries(src)) {
    if (!TRACK_ID_RE.test(trackId) || !Array.isArray(ids)) continue;
    const list = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (list.length) out[trackId] = list;
  }
  return out;
}

function readObservedFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return isPlain(parsed) && isPlain(parsed.projects) ? parsed : { projects: {} };
  } catch {
    return { projects: {} };
  }
}

const levelsOf = (data, project) => {
  const rec = Object.hasOwn(data.projects, project) ? data.projects[project] : null;
  return { full: cleanHeads(rec?.full), pointer: cleanHeads(rec?.pointer) };
};

/**
 * Remember which heads of `project` this session was told about: `heads` is
 * `{trackId: [closeId]}` and `level` is `'full'` (the body was shown) or `'pointer'` (only that the
 * head exists was shown). The two accumulate as separate unions. A `level` that is neither throws.
 * A session id that is not a plain id (it becomes a directory name) writes nothing. Returns
 * `{recorded, lockTimeout?}`.
 */
export function recordObservedHeads(hypoDir, sessionId, project, { level, heads } = {}) {
  if (!LEVELS.includes(level)) {
    throw new Error(`recordObservedHeads: level must be 'full' or 'pointer', got ${level}`);
  }
  if (
    !isValidSessionId(sessionId) ||
    typeof project !== 'string' ||
    !project ||
    project === '__proto__'
  ) {
    return { recorded: false };
  }
  const path = observedPath(hypoDir, sessionId);
  try {
    return withFileLock(
      path,
      () => {
        const data = readObservedFile(path);
        const rec = levelsOf(data, project);
        for (const [trackId, ids] of Object.entries(cleanHeads(heads))) {
          rec[level][trackId] = [...new Set([...(rec[level][trackId] ?? []), ...ids])];
        }
        data.projects[project] = rec;
        atomicWrite(path, JSON.stringify(data));
        return { recorded: true };
      },
      { timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000 },
    );
  } catch (err) {
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    return { recorded: false, lockTimeout: true };
  }
}

/** `{full: {trackId: [closeId]}, pointer: {...}}` for one session and project; empty when unknown. */
export function readObservedHeads(hypoDir, sessionId, project) {
  if (!isValidSessionId(sessionId) || typeof project !== 'string') return { full: {}, pointer: {} };
  return levelsOf(readObservedFile(observedPath(hypoDir, sessionId)), project);
}

// ── moving a vault to the scheme ─────────────────────────────────────────────

const gitRun = (cwd, args, extra = {}) =>
  spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    ...extra,
  });

/** `git show <rev>:./<relPath>` as text, `null` when HEAD has no such path. */
function showText(hypoDir, rev, relPath) {
  const r = gitRun(hypoDir, ['show', revPathArg(rev, relPath)]);
  return r.status === 0 ? r.stdout : null;
}

// `base` with `block` after it, unless the block's first line is already there (then `base` as it is).
function withBlock(base, block) {
  const first = block.split('\n')[0];
  if (base.split('\n').some((l) => l.trim() === first)) return base;
  return `${base}${base === '' || base.endsWith('\n') ? '' : '\n'}${block}`;
}

/**
 * Make a commit on top of HEAD without touching HEAD, the real index or the working tree, and
 * return its sha: `{ok: true, sha}` or `{ok: false, reason}`. `edits` is `{message, writes:
 * [{relPath, text}], deletes: [relPath]}` (vault-relative paths): the tree of HEAD with every
 * `writes` blob stored and every `deletes` path removed. It runs in a temporary index file under
 * `os.tmpdir()` (removed in a `finally`), so another session's staged files and the uncommitted
 * lines of the working tree `.gitignore` never reach the commit, and no temporary worktree is
 * needed.
 *
 * Every git call here runs from the repository top level on paths with the vault's prefix:
 * `update-index --cacheinfo` takes a top level path, but `--force-remove` takes one relative to the
 * current directory, so from inside a vault below the top level a prefixed `--force-remove` would
 * exit 0 and remove nothing. `testHooks.afterBuildCommit(sha)` runs once the commit object exists,
 * `testHooks.now` (a Date) fixes the author and committer date.
 */
export function buildCommitInTempIndex(hypoDir, edits, { testHooks } = {}) {
  const { message, writes = [], deletes = [] } = edits;
  const top = gitRun(hypoDir, ['rev-parse', '--show-toplevel']).stdout?.trim();
  const head = gitRun(hypoDir, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD^{commit}',
  ]).stdout?.trim();
  if (!top || !head) return { ok: false, reason: 'no-head' };
  const prefix = vaultGitPrefix(hypoDir);
  const index = join(tmpdir(), `hypo-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  if (testHooks?.now) {
    env.GIT_AUTHOR_DATE = env.GIT_COMMITTER_DATE = testHooks.now.toISOString();
  }
  const step = (args, input) => {
    const r = gitRun(top, args, { env, input });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr).trim()}`);
    return r.stdout.trim();
  };
  try {
    step(['read-tree', 'HEAD']);
    for (const { relPath, text } of writes) {
      const blob = step(['hash-object', '-w', '--stdin'], text);
      step(['update-index', '--add', '--cacheinfo', `100644,${blob},${prefix}${relPath}`]);
    }
    for (const relPath of deletes) step(['update-index', '--force-remove', '--', prefix + relPath]);
    const sha = step(['commit-tree', step(['write-tree']), '-p', head, '-m', message]);
    testHooks?.afterBuildCommit?.(sha);
    return { ok: true, sha };
  } catch (err) {
    if (err?.message?.startsWith('git ')) return { ok: false, reason: err.message };
    throw err;
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

// A merge can fail after git installed the new index and working tree: the ref update is its last
// step, and a held `HEAD.lock` stops it there. HEAD is then where it was while the index and disk
// hold the target layout, a state no later run reads as "nothing moved". When HEAD is unchanged and
// the index equals the target on every path the move changes, a two-tree `read-tree` goes back from
// the target to HEAD: it touches those paths only and refuses to overwrite a changed file. Returns
// `{ok, notice?}`; `ok: false` means the state is still stranded and `notice` (also written to the
// pending notices for the next SessionStart) names it and the git command that recovers it.
function returnStrandedIndex(hypoDir, sha, headBefore) {
  const headNow = gitRun(hypoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
  if (!headBefore || headNow !== headBefore) return { ok: true };
  const changed = gitRun(hypoDir, ['diff', '--name-only', '-z', '--relative', headBefore, sha]);
  const paths = String(changed.stdout).split('\0').filter(Boolean);
  if (changed.status !== 0 || !paths.length) return { ok: true };
  const specs = paths.map((p) => `:(literal)${p}`);
  // 0 when the index holds the target's bytes on every one of those paths.
  if (gitRun(hypoDir, ['diff', '--cached', '--quiet', sha, '--', ...specs]).status !== 0) {
    return { ok: true };
  }
  if (gitRun(hypoDir, ['read-tree', '-m', '-u', sha, headBefore]).status === 0) return { ok: true };
  const notice = `이행 커밋 적용이 HEAD 갱신에서 멈췄고 인덱스와 작업 트리가 새 구성에 남았습니다. 되돌리려면 이 명령을 실행하세요: git -C '${hypoDir}' read-tree -m -u ${sha} ${headBefore}`;
  writeRootHotHealthNotice(hypoDir, notice);
  return { ok: false, notice };
}

/**
 * Bring HEAD, the real index and the working tree to `sha` (a descendant of HEAD) in one git
 * motion. First `clearGeneratedPathsBlockingPull` sets aside what would block the merge, then
 * `git merge --ff-only`. When the merge fails, or the first step stops half way, what it moved is
 * taken back (`undoClearedPaths`: working-tree and staged bytes, the `.gitignore`, backups, archive
 * record), so a failed move leaves the vault as it was. That
 * covers bytes only: a deletion the user had made of a view path before the move is not made
 * again, because the clearing step brought the file back from HEAD with no bytes to keep.
 * Returns `{ok, pre, deferred?, reason?, notice?}` where `pre` is the clearing step's result (its
 * `archived[]`, `localOnly[]`, `unowned[]` and `cleared[]` are for the caller, after a successful
 * merge). The `.gitignore` goes back as the exact bytes it held (`undoClearedPaths`), unstaged
 * lines and staged ones apart, not as lines appended.
 * `notice` carries git's whole stderr after a failed merge, which names the files in the way, and
 * any path that could not be put back.
 */
export function fastForwardTo(hypoDir, sha, { testHooks } = {}) {
  const pre = clearGeneratedPathsBlockingPull(hypoDir, sha, { testHooks });
  const moved =
    pre.archived.length +
      pre.localOnly.length +
      pre.unowned.length +
      pre.cleared.length +
      pre.gitignoreSaved.length +
      pre.ownedRemoved.length >
    0;
  if (!pre.ok) {
    const undone = moved ? undoClearedPaths(hypoDir, pre).notices : [];
    const notice = [pre.notice, ...undone].filter(Boolean).join('\n') || undefined;
    return { ok: false, pre, deferred: pre.deferred, reason: pre.reason, notice };
  }
  const headBefore = gitRun(hypoDir, ['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
  const merged = gitRun(hypoDir, ['merge', '--ff-only', sha]);
  if (merged.status !== 0) {
    const stderr = String(merged.stderr).trim();
    const stranded = returnStrandedIndex(hypoDir, sha, headBefore);
    const undone =
      moved && stranded.ok
        ? undoClearedPaths(hypoDir, pre).notices
        : [stranded.notice].filter(Boolean);
    return {
      ok: false,
      pre,
      reason: `fast-forward-failed: ${stderr.split('\n')[0]}`,
      notice: [`git merge --ff-only 실패: ${stderr}`, ...undone].join('\n'),
    };
  }
  return { ok: true, pre };
}

/**
 * What every landed `fastForwardTo` leaves to do, for the migration and for `upgrade
 * --migrate-sessions`: tell what was set aside, then share what this machine held only in its
 * working tree or index (the old files differ from HEAD) as additional baselines; the pull record
 * is dropped once those are committed. `pre` is the `pre` of the `fastForwardTo` result. Returns
 * `{notices, created}` (the entries made, relative to the vault). A caller holds the vault lock.
 */
export function afterFastForward(hypoDir, pre) {
  const setAside = setAsideNotices(hypoDir, pre);
  markPullArchiveMerged(hypoDir);
  const { localOnly, unowned, cleared } = pre;
  const resumed = resumePullArchive(hypoDir, {
    announced: [...localOnly, ...unowned, ...cleared].map((v) => v.backupPath),
  });
  return { notices: [...setAside, ...resumed.notices], created: resumed.created };
}

const migrationResult = (over) => ({
  migrated: false,
  commit: null,
  baselines: [],
  shared: [],
  skipped: null,
  notices: [],
  ...over,
});

const deferredMigration = (reason, detail) =>
  migrationResult({
    deferred: reason,
    notices: [`이행을 다음 세션으로 미뤘습니다: ${detail ?? reason}`],
  });

// A name `projectNameProblem` accepts, close to `slug`: runs of characters outside the project
// charset become `-`, the NFC form is taken, and a name left without a letter or number falls back.
function suggestedProjectName(slug) {
  const name = slug
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return projectNameProblem(name) === null ? name : 'project';
}

// One directory's line of the invalid-name notice: why, and the `/hypo:rename` command to a valid name.
function renameAdvice(slug, problem) {
  const why =
    problem === 'not-nfc'
      ? '이름이 NFC 형태가 아니라(macOS에서 만든 분해형 한글 등) git이 보고하는 경로와 맞지 않습니다'
      : '이름에 공백이나 기호가 있습니다';
  return (
    `projects/${slug}: ${why}. ` +
    `/hypo:rename --from="projects/${slug}" --to="projects/${suggestedProjectName(slug)}" (--to는 예시이고, 쓸 수 있는 글자는 문자, 숫자, ., _, - 입니다).`
  );
}

/**
 * Move a vault from tracked `hot.md`/`session-state.md` files to session entries: one commit with a
 * baseline entry per old file HEAD tracks, in each project (each whole, as HEAD has it, with its own
 * `visibility_scope`; bytes the generator wrote are not old files; an old file git does not track
 * stays where it is for the writer to back up, and a notice says so), the `.gitignore` and `.gitattributes` blocks, and the generated views
 * untracked, applied with `fastForwardTo`. `index.md` is not changed (the baselines carry the old
 * files' `visibility_scope`), and
 * `projects/_template` is not touched (it is not a generated path). For a caller that already
 * holds the vault commit lock; `migrateVaultToSessionEntries` takes it. `opts`: `reenable` (also
 * move a vault rolled back on purpose, removing the off marker in the same commit), `testHooks`
 * (`afterBuildCommit`, `now`, and whatever `fastForwardTo` takes).
 *
 * Returns `{migrated, deferred?, commit, baselines[], shared[], skipped, notices[]}`. `skipped` is
 * `'already-migrated'` or `'opted-out'` when nothing was done for that reason, else `null`.
 * `baselines` are the entry paths the migration commit added, `shared` the additional baselines
 * made from this machine's uncommitted old files (separate commit, see `shareLegacyBytes`).
 * A failure to apply leaves the vault as it was and returns `migrated: false` with `deferred`.
 */
export function migrateVaultToSessionEntriesUnlocked(hypoDir, opts = {}) {
  const { reenable = false, testHooks } = opts;
  const state = migrationState(hypoDir);
  if (state === 'migrated') return migrationResult({ migrated: true, skipped: 'already-migrated' });
  if (state === 'opted-out' && !reenable) return migrationResult({ skipped: 'opted-out' });

  // A block with its first line but not every pattern line is not repaired here: user lines keep
  // their order (a later negation changes what an earlier pattern means). The user restores it, or
  // removes it so the move adds it whole.
  const incomplete = [
    ['.gitignore', GITIGNORE_BLOCK],
    ['.gitattributes', GITATTRIBUTES_BLOCK],
  ]
    .map(([rel, block]) => [rel, missingBlockLines(showText(hypoDir, 'HEAD', rel) ?? '', block)])
    .filter(([, missing]) => missing?.length);
  if (incomplete.length) {
    const what = incomplete.map(([rel, missing]) => `${rel}에 ${missing.join(' , ')}`).join('; ');
    return deferredMigration(
      'block-incomplete',
      `Hypomnema 블록의 첫 줄은 있지만 필요한 줄이 빠져 있습니다 (${what}). 블록을 통째로 복원해 커밋하거나, 블록을 지워 커밋하면 이행 때 도구가 전체를 다시 추가합니다 (판정은 커밋된 파일을 읽습니다)`,
    );
  }
  let tracked;
  try {
    tracked = listTrackedGeneratedViews(hypoDir, { source: 'head' });
  } catch (err) {
    return deferredMigration('head-unreadable', err?.message);
  }
  // The move lists the views to remove from HEAD. A view that is staged but not in HEAD (a new
  // project whose old files were added by hand) would stay in the index, tracked, after the move.
  // Nothing is written before the person unstages or commits them.
  let indexed;
  try {
    indexed = listTrackedGeneratedViews(hypoDir, { source: 'index' });
  } catch (err) {
    return deferredMigration('index-unreadable', err?.message);
  }
  const inHead = new Set(tracked);
  const stagedOnly = indexed.filter((rel) => !inHead.has(rel));
  if (stagedOnly.length) {
    return deferredMigration(
      'staged-views',
      `커밋되지 않고 스테이징만 된 세션 현황 파일이 있어 아무것도 쓰지 않았습니다 (${stagedOnly.join(', ')}). ` +
        'git restore --staged로 스테이징을 풀거나 먼저 커밋한 뒤 다시 시도합니다',
    );
  }
  const notices = [];
  const patterns = loadHypoIgnore(hypoDir);
  const { views: ownViews } = readGeneratedViewsRecord(hypoDir);
  // The flat files a rollback committed are named, with their hashes, by the marker in HEAD.
  const rolledBack = reenable
    ? offMarkerHashes(showText(hypoDir, 'HEAD', SESSION_ENTRIES_OFF_MARKER))
    : {};
  const writes = [];
  const baselines = [];
  // Only an old file HEAD tracks becomes a baseline, read from HEAD. One git does not track (never
  // committed, or kept out of git by a rule of the vault's own `.gitignore`) is not published and
  // not claimed: whether it is the owner's private file or an edited generated view cannot be told
  // from here, and its `index.md` scope may be just as untracked. The writer that follows backs it
  // up as foreign bytes, and the notice below says so.
  const trackedSet = new Set(tracked);
  const OLD_NAMES = ['hot.md', 'session-state.md'];
  const slugs = [...new Set(tracked.map((rel) => generatedViewSlug(rel)))]
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // A project directory whose name an entry cannot carry (a space or symbol, or not in NFC) would
  // make the baseline build throw. Nothing is written until the person renames it; the notice names
  // each directory, the reason and the command.
  const badNames = slugs
    .filter((slug) => !projectHiddenByHypoignore(hypoDir, slug, patterns))
    .map((slug) => [slug, projectNameProblem(slug)])
    .filter(([, problem]) => problem !== null);
  if (badNames.length) {
    return deferredMigration(
      'invalid-project-name',
      '프로젝트 디렉터리 이름을 세션 원본에 쓸 수 없어 아무것도 쓰지 않았습니다. ' +
        `${badNames.map(([slug, problem]) => renameAdvice(slug, problem)).join(' ')} ` +
        '이름을 바꾸고 커밋한 뒤 다시 시작하세요.',
    );
  }
  const leftLocal = listSessionProjects(hypoDir)
    .filter((slug) => !projectHiddenByHypoignore(hypoDir, slug, patterns))
    .flatMap((slug) => OLD_NAMES.map((name) => `projects/${slug}/${name}`))
    .filter((rel) => {
      if (trackedSet.has(rel)) return false;
      const text = lenientRead(join(hypoDir, rel));
      return text !== null && ownViews[rel] !== sha256(text);
    });
  if (leftLocal.length) {
    notices.push(
      `git이 추적하지 않는 옛 파일은 세션 원본으로 옮기지 않았습니다: ${leftLocal.join(', ')}. ` +
        '다음 생성 때 .cache/backups/ 아래에 보관하고 그 위치를 알립니다. ' +
        '남길 내용은 다음 close의 요약이나 `projects/<프로젝트>/notes.md`로 옮기세요.',
    );
  }
  // A rule of the user's own `.gitignore` (or an exclude file) that covers an entry directory would
  // keep every close out of git once the views stop being tracked: the move waits for that rule.
  // Every project that is not hidden by `.hypoignore` is probed in one call, so the answer does not
  // depend on which project sorts first, and the notice names all of them.
  let listed;
  try {
    listed = listSessionProjects(hypoDir);
  } catch (err) {
    return deferredMigration('projects-unreadable', err?.message);
  }
  const probed = [...new Set([...slugs, ...listed])]
    .filter((slug) => !projectHiddenByHypoignore(hypoDir, slug, patterns))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (probed.length) {
    const probePath = (slug) => `projects/${slug}/sessions/0000-00-00-probe.md`;
    const checked = gitRun(hypoDir, ['check-ignore', '--stdin', '-z'], {
      input: probed.map((slug) => `${probePath(slug)}\0`).join(''),
    });
    const hits = checked.status === 0 ? new Set(checked.stdout.split('\0')) : new Set();
    const covered = probed.filter((slug) => hits.has(probePath(slug)));
    if (covered.length) {
      const dirs = covered.map((slug) => `projects/${slug}/sessions/`).join(', ');
      return deferredMigration(
        'sessions-ignored',
        `무시 규칙이 ${dirs}의 세션 원본을 가립니다. 그대로 옮기면 세션 기록이 커밋되지 않으니, 그 규칙을 고친 뒤 다시 시도합니다`,
      );
    }
  }
  // Flat files that carry the generator's own header but become baselines: with the off marker gone
  // nothing tells these bytes from old memory, so the entry text would be doubled. Named below.
  const markerGone = !pathInHead(hypoDir, SESSION_ENTRIES_OFF_MARKER);
  const generatorOutput = [];
  for (const slug of slugs) {
    // A hidden project's entries are never committed, so it gets no baseline. The catch-up step
    // keeps a local copy of its old files before the merge removes them.
    if (projectHiddenByHypoignore(hypoDir, slug, patterns)) continue;
    // HEAD can track a generated view too (a vault that ran `git init` and committed everything
    // after a move): the generator's own bytes are not old memory, so they get no baseline.
    const [hotText, stateText] = OLD_NAMES.map((name) => {
      const rel = `projects/${slug}/${name}`;
      return trackedSet.has(rel)
        ? oldFileText(ownViews, rel, showText(hypoDir, 'HEAD', rel), rolledBack)
        : null;
    });
    if (markerGone) {
      OLD_NAMES.forEach((name, i) => {
        if (frontmatterScalar([hotText, stateText][i] ?? '', 'generated') === 'sessions') {
          generatorOutput.push(`projects/${slug}/${name}`);
        }
      });
    }
    const indexScope = readVisibilityScope(showText(hypoDir, 'HEAD', `projects/${slug}/index.md`));
    // An update the old scheme already sent to `legacy` (or to a `legacy-*` track split out of the
    // file) with `done` replaced the virtual baseline, whose id covers the bytes of this moment. The
    // real baseline gets another id when the files changed since, so each head whose own track was
    // finished is built folded to keep that `done` effective.
    const built = buildLegacyBaselines({
      hotText,
      stateText,
      date: legacyBaselineDate(hypoDir, slug, [hotText ?? '', stateText ?? '']),
      project: slug,
      scopes: { ...baselineScopes('', hotText, stateText), index: indexScope },
      legacyDone: doneLegacyTracks(hypoDir, slug),
    });
    for (const b of built) {
      notices.push(...baselineScopeNotices(slug, b, indexScope));
      const relPath = `projects/${slug}/sessions/${b.fileName}`;
      if (pathInHead(hypoDir, relPath)) continue; // the same content is already there
      writes.push({ relPath, text: b.text });
      baselines.push(relPath);
    }
  }

  if (generatorOutput.length) {
    notices.push(
      `세션 원본에서 생성한 평면 파일로 보이는 파일에서 기준선을 만듭니다: ${generatorOutput.join(', ')}. ` +
        `롤백 뒤에 ${SESSION_ENTRIES_OFF_MARKER}를 지웠을 가능성이 큽니다. ` +
        '이 기준선은 생성기가 쓴 내용을 담아 같은 본문이 원본과 기준선에 겹쳐 보일 수 있습니다.',
    );
  }

  const headText = (rel) => showText(hypoDir, 'HEAD', rel) ?? '';
  writes.push(
    { relPath: '.gitignore', text: withBlock(headText('.gitignore'), GITIGNORE_BLOCK) },
    { relPath: '.gitattributes', text: withBlock(headText('.gitattributes'), GITATTRIBUTES_BLOCK) },
  );
  const deletes = [...tracked];
  if (reenable && pathInHead(hypoDir, SESSION_ENTRIES_OFF_MARKER)) {
    deletes.push(SESSION_ENTRIES_OFF_MARKER);
  }
  const commit = buildCommitInTempIndex(
    hypoDir,
    { message: 'hypomnema: move session state into projects/*/sessions entries', writes, deletes },
    { testHooks },
  );
  if (!commit.ok) return deferredMigration('commit-failed', commit.reason);

  const applied = fastForwardTo(hypoDir, commit.sha, { testHooks });
  if (!applied.ok) {
    const reason = applied.deferred ?? applied.reason ?? 'ff-failed';
    return deferredMigration(reason, applied.notice ?? reason);
  }
  const after = afterFastForward(hypoDir, applied.pre);
  return migrationResult({
    migrated: true,
    commit: commit.sha,
    baselines,
    shared: after.created,
    notices: [...notices, ...after.notices],
  });
}

/**
 * `migrateVaultToSessionEntriesUnlocked` under the vault commit lock. A busy lock defers the move
 * (`deferred: 'lock-timeout'`) instead of throwing.
 */
export function migrateVaultToSessionEntries(hypoDir, opts = {}) {
  try {
    return withFileLock(
      vaultCommitLockTarget(hypoDir),
      () => migrateVaultToSessionEntriesUnlocked(hypoDir, opts),
      { timeoutMs: Number(process.env.HYPO_VAULT_LOCK_TIMEOUT_MS) || 5000 },
    );
  } catch (err) {
    if (err?.code !== 'ELOCKTIMEOUT') throw err;
    return deferredMigration('lock-timeout', '다른 세션이 저장소 잠금을 쥐고 있습니다');
  }
}
