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

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite } from './atomic-write.mjs';
import { isValidSessionId } from './proposal-store.mjs';
import {
  GITIGNORE_BLOCK,
  TRACK_ID_RE,
  buildBaselineEntry,
  isBaselineId,
  isGeneratedViewPath,
  isSessionEntryPath,
  isSessionProjectDir,
  narrowestVisibilityScope,
  parseSessionEntry,
  renderViews,
  splitLegacyFrontmatter,
} from './session-entries.mjs';
import {
  backUpGeneratedPath,
  currentDevice,
  pathInHead,
  readVisibilityScope,
  revPathArg,
  vaultCommitLockTarget,
  withFileLock,
  writeRootHotHealthNotice,
} from './hypo-shared.mjs';

/** Present in HEAD's tree when the vault was rolled back to the old flat files on purpose. */
export const SESSION_ENTRIES_OFF_MARKER = '.hypo-session-entries-off';

const OWNERSHIP_REL = join('.cache', 'generated-views.json');
const LEGACY_ROOT_STATE_REL = join('.cache', 'root-hot-projection-state.json');
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;
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

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A top-level frontmatter value: first wins, a trailing ` # comment` and surrounding quotes
// stripped (the same reading as readVisibilityScope, for another key). `null` when absent.
function frontmatterValue(text, key) {
  const m = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) || /^-(\s|$)/.test(line)) continue;
    const idx = line.indexOf(':');
    if (idx < 0 || line.slice(0, idx).trim() !== key) continue;
    return line
      .slice(idx + 1)
      .trim()
      .replace(/\s+#.*$/, '')
      .replace(/^["']|["']$/g, '');
  }
  return null;
}

// ── projects and entries ─────────────────────────────────────────────────────

/** Slugs of the `projects/` children that are session projects, in code-unit order. */
export function listSessionProjects(hypoDir) {
  let names;
  try {
    names = readdirSync(join(hypoDir, 'projects'));
  } catch {
    return [];
  }
  return names
    .filter((slug) => {
      const dir = join(hypoDir, 'projects', slug);
      return (
        isDir(dir) &&
        isSessionProjectDir({
          slug,
          hasIndex: isFile(join(dir, 'index.md')),
          hasSessions: isDir(join(dir, 'sessions')),
        })
      );
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The parsed entries of one project plus the files that could not be read: `{entries, unreadable}`.
 * A file that disappears between the directory listing and its read (a pull in flight) is skipped.
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
    if (parsed.ok) entries.push(parsed.entry);
    else unreadable.push({ fileName, reason: parsed.reason });
  }
  return { entries, unreadable };
}

// ── git state ────────────────────────────────────────────────────────────────

/**
 * The generated view paths git tracks. `source: 'index'` (default) is `git ls-files`, `'head'` is
 * `git ls-tree -r HEAD`. Filtered by `isGeneratedViewPath`, never by a pathspec (`*` crosses `/`).
 * Throws when git cannot answer: an empty list must always mean "nothing tracked".
 */
export function listTrackedGeneratedViews(hypoDir, { source = 'index' } = {}) {
  if (source !== 'head' && source !== 'index') {
    throw new Error(`listTrackedGeneratedViews: source must be 'head' or 'index', got ${source}`);
  }
  const args =
    source === 'head' ? ['ls-tree', '-r', '-z', '--name-only', 'HEAD'] : ['ls-files', '-z'];
  const r = git(hypoDir, args);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr).trim()}`);
  return r.stdout.split('\0').filter((p) => isGeneratedViewPath(p));
}

/**
 * `'migrated' | 'not-migrated' | 'opted-out'`, read from HEAD's tree only (the real index is not
 * consulted: a migration commit moves HEAD and the index together). The off marker in HEAD is
 * `opted-out`; the `.gitignore` block in HEAD plus no tracked generated view in HEAD is
 * `migrated`; anything else, including git failing to answer, is `not-migrated`. A vault that is
 * not a git repository tracks nothing, so it counts as `migrated`.
 */
export function migrationState(hypoDir) {
  if (git(hypoDir, ['rev-parse', '--is-inside-work-tree']).status !== 0) return 'migrated';
  if (pathInHead(hypoDir, SESSION_ENTRIES_OFF_MARKER)) return 'opted-out';
  const shown = git(hypoDir, ['show', revPathArg('HEAD', '.gitignore')]);
  const first = GITIGNORE_BLOCK.split('\n')[0];
  if (shown.status !== 0 || !shown.stdout.split('\n').some((l) => l.trim() === first)) {
    return 'not-migrated';
  }
  try {
    return listTrackedGeneratedViews(hypoDir, { source: 'head' }).length === 0
      ? 'migrated'
      : 'not-migrated';
  } catch {
    return 'not-migrated';
  }
}

// ── model ────────────────────────────────────────────────────────────────────

function entryScopeOf(indexText) {
  const raw = frontmatterValue(indexText, 'entry_scope');
  if (raw === null) return null;
  return ENTRY_SCOPE_RE.test(raw) ? raw : 'machine:';
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The baseline date: the larger `updated:` of the two old files, else the day git last changed
// them, else the file's mtime day.
function legacyDate(hypoDir, rels, texts) {
  const updated = texts
    .map((t) => DATE_PREFIX_RE.exec(frontmatterValue(t, 'updated') ?? '')?.[0])
    .filter(Boolean)
    .sort();
  if (updated.length) return updated.at(-1);
  const committed = rels
    .map((rel) => {
      const r = git(hypoDir, ['log', '-1', '--format=%cs', '--', `:(literal)${rel}`]);
      return r.status === 0 ? DATE_PREFIX_RE.exec(r.stdout.trim())?.[0] : null;
    })
    .filter(Boolean)
    .sort();
  if (committed.length) return committed.at(-1);
  return localDate(statSync(join(hypoDir, rels[0])).mtime);
}

// The in-memory entry that stands for a not-yet-migrated project's old `hot.md` and
// `session-state.md` (whichever of them git tracks). `null` when neither is.
function virtualBaseline(hypoDir, project, tracked, indexText) {
  const rels = [`projects/${project}/hot.md`, `projects/${project}/session-state.md`];
  const [hotText, stateText] = rels.map((rel) =>
    tracked.has(rel) ? readOrNull(join(hypoDir, rel)) : null,
  );
  const present = rels.filter((_, i) => [hotText, stateText][i] !== null);
  if (!present.length) return null;
  const { scope } = narrowestVisibilityScope([
    readVisibilityScope(indexText ?? ''),
    readVisibilityScope(hotText ?? ''),
    readVisibilityScope(stateText ?? ''),
  ]);
  const built = buildBaselineEntry({
    hotText,
    stateText,
    date: legacyDate(hypoDir, present, [hotText ?? '', stateText ?? '']),
    visibilityScope: scope,
    project,
    legacyDone: false,
  });
  const parsed = parseSessionEntry(built.text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.entry;
}

/**
 * The model one project's views are made from: `{project, migrated, entries, unreadable, notes,
 * entryScope}`. `migrated` is whether `migrationState` is `migrated`; before that the model also
 * holds a virtual baseline entry built from the tracked old files (nothing is written). `notes`
 * is the body of `notes.md` or `null`; `entryScope` is the `entry_scope` of `index.md` (a value
 * that is not a valid scope closes the project as `machine:`) or `null`. `opts.state` passes an
 * already known `migrationState`; `opts.testHooks` goes to `listSessionEntries`.
 */
export function loadSessionModel(hypoDir, project, opts = {}) {
  const state = opts.state ?? migrationState(hypoDir);
  const migrated = state === 'migrated';
  const { entries, unreadable } = listSessionEntries(hypoDir, project, opts);
  const base = join(hypoDir, 'projects', project);
  const indexText = lenientRead(join(base, 'index.md'));
  const notesText = lenientRead(join(base, 'notes.md'));
  if (!migrated) {
    try {
      let tracked = new Set();
      try {
        tracked = new Set(listTrackedGeneratedViews(hypoDir));
      } catch {
        // git cannot say what is tracked: no baseline rather than a guessed one
      }
      const baseline = virtualBaseline(hypoDir, project, tracked, indexText);
      if (baseline) entries.push(baseline);
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
    entryScope: indexText === null ? null : entryScopeOf(indexText),
  };
}

/**
 * The `visibility_scope` a new entry of `project` carries. An `entry_scope` in `index.md` wins as
 * it is; otherwise the narrowest of the `index.md` value and every baseline entry's value, so an
 * old file's machine scope carries over without `index.md` being edited. `model` is optional.
 */
export function projectEntryScope(hypoDir, project, model) {
  const m = model ?? loadSessionModel(hypoDir, project);
  if (typeof m.entryScope === 'string') return m.entryScope;
  const indexText = lenientRead(join(hypoDir, 'projects', project, 'index.md'));
  return narrowestVisibilityScope([
    readVisibilityScope(indexText ?? ''),
    ...m.entries.filter((e) => isBaselineId(e.closeId)).map((e) => e.visibilityScope),
  ]).scope;
}

// ── writing the views ────────────────────────────────────────────────────────

// `.cache/generated-views.json` = {views: {relPath: sha}, absorbed: {relPath: sha}}. A file that
// cannot be read makes every path unowned (backed up before it is overwritten). A missing file
// starts from the old root projection's hash for `hot.md`. `absorbed` that is not an object is
// dropped. `dirty` says the record on disk needs rewriting.
function readOwnership(hypoDir) {
  const strings = (src) =>
    Object.fromEntries(Object.entries(src).filter(([, v]) => typeof v === 'string'));
  let raw;
  try {
    raw = readFileSync(join(hypoDir, OWNERSHIP_REL), 'utf-8');
  } catch (err) {
    const views = {};
    if (err?.code === 'ENOENT') {
      try {
        const legacy = JSON.parse(readFileSync(join(hypoDir, LEGACY_ROOT_STATE_REL), 'utf-8'));
        if (typeof legacy?.lastHash === 'string') views['hot.md'] = legacy.lastHash;
      } catch {
        // no old state either: nothing to inherit
      }
    }
    return { views, absorbed: {}, dirty: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlain(parsed) || !isPlain(parsed.views)) throw new Error('shape');
    return {
      views: strings(parsed.views),
      absorbed: isPlain(parsed.absorbed) ? strings(parsed.absorbed) : {},
      dirty: !isPlain(parsed.absorbed),
    };
  } catch {
    return { views: {}, absorbed: {}, dirty: true };
  }
}

// Write one view if its bytes differ. Bytes that neither this writer last wrote (`views`) nor the
// migration absorbed for this very path (`absorbed`) are backed up first, and the file is read
// again right before the replacing write so a save landing in between is backed up as well.
function writeOneView(hypoDir, relPath, content, own, testHooks, result) {
  const abs = join(hypoDir, relPath);
  const sha = sha256(content);
  const read = () => readOrNull(abs);
  const ours = (text) => {
    const h = sha256(text);
    return h === own.views[relPath] || h === own.absorbed[relPath];
  };
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
  if (current !== null && !ours(current))
    backups.push(backUpGeneratedPath(abs, current, testHooks));
  testHooks?.beforeFinalWrite?.(abs);
  const latest = read();
  if (latest === content) {
    claim();
    result.unchanged.push(relPath);
  } else {
    if (latest !== current && latest !== null && !ours(latest)) {
      backups.push(backUpGeneratedPath(abs, latest, testHooks));
    }
    atomicWrite(abs, content);
    claim();
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
  ...over,
});

/**
 * `writeGeneratedViews` for a caller that already holds the vault commit lock (the lock is not
 * reentrant). `opts`: `projects` (slugs, default every session project), `root` (write the root
 * `hot.md`, default true), `device` (default `currentDevice()`), `testHooks`. Returns
 * `{notMigrated, lockTimeout, written[], unchanged[], backedUp[{relPath, backupPath}]}`; when the
 * vault is not `migrated` nothing is written and `notMigrated` is true. Any backup leaves a health
 * notice for the next SessionStart.
 */
export function writeGeneratedViewsUnlocked(hypoDir, opts = {}) {
  const { root = true, device = currentDevice(), testHooks } = opts;
  const state = migrationState(hypoDir);
  if (state !== 'migrated') return emptyResult({ notMigrated: true, state });
  const all = listSessionProjects(hypoDir);
  const only = opts.projects ? all.filter((p) => opts.projects.includes(p)) : all;
  const models = all.map((p) => loadSessionModel(hypoDir, p, { state, testHooks }));
  const views = renderViews(models, { device, only });
  const targets = only.flatMap((slug) => [
    [`projects/${slug}/hot.md`, views.projects[slug].hot],
    [`projects/${slug}/session-state.md`, views.projects[slug].sessionState],
  ]);
  if (root) targets.push(['hot.md', views.root]);

  const result = emptyResult({ state });
  const own = readOwnership(hypoDir);
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
      atomicWrite(
        join(hypoDir, OWNERSHIP_REL),
        JSON.stringify({ views: own.views, absorbed: own.absorbed }),
      );
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
  if (result.backedUp.length) {
    writeRootHotHealthNotice(
      hypoDir,
      result.backedUp
        .map(
          (b) =>
            `생성 파일 ${b.relPath}에 생성기가 쓰지 않은 내용이 있어 ${relative(hypoDir, b.backupPath)}에 보관했습니다. ` +
            '구버전 Hypomnema(같은 기계의 다른 설치일 수 있습니다)나 사람이 쓴 내용으로 보입니다. 자동으로 합치지 않았습니다. ' +
            '남길 내용은 다음 close의 요약이나 projects/<p>/notes.md로 옮기세요.',
        )
        .join('\n'),
    );
  }
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
