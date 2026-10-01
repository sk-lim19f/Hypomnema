// hooks/session-entries.mjs, the session entry format and the path rules around it. Pure.
//
// A close writes one immutable file per close event, `projects/<p>/sessions/<date>-<close_id>.md`,
// and the status views (`hot.md`, `session-state.md`, the root `hot.md`) are generated from those
// files on read. This module is the one place that knows what such a file looks like and which
// paths belong to the scheme. Everything here is a function of its arguments: no disk, no git,
// no clock. The IO halves (loading, writing views, migration state) live in session-views.mjs
// and hypo-shared.mjs and import from here.
//
// Node built-ins plus the sibling `proposal-store.mjs` only, per the hooks/ convention (this file
// is copied standalone into `~/.claude/hooks/`). Listed in `hooks/shared.json`.

import { createHash } from 'node:crypto';
import { isValidSessionId } from './proposal-store.mjs';

// ── constants ────────────────────────────────────────────────────────────────

export const TRACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const LEGACY_TRACK_ID = 'legacy';

const ENTRY_SCHEMA = 1;
// A session id is `[A-Za-z0-9_-]+` (isValidSessionId) and a baseline id is `baseline-<hex>`, so
// a close id never holds a space or a dot. The markers rely on that to be unambiguous.
const CLOSE_ID_RE = /^[A-Za-z0-9_-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Written into `title:` inside double quotes and into the project directory name.
const PROJECT_RE = /^[^\r\n"\\/]+$/;
const BASELINE_TITLE = '이행 전 기록';

// Byte-fixed blocks. Two machines that append them independently must produce the same change.
export const GITIGNORE_BLOCK = `# Hypomnema: session views generated from projects/*/sessions/ (not committed)
/hot.md
/projects/*/hot.md
/projects/*/session-state.md
/hot.md.pre-projection-backup*.md
/hot.md.pre-projection-backup*.tmp
/projects/*/*.pre-projection-backup*.md
/projects/*/*.pre-projection-backup*.tmp
/projects/*/sessions/*.tmp
`;

export const GITATTRIBUTES_BLOCK = `# Hypomnema: session-log shards are append-only, keep both sides on a merge
projects/*/session-log/*.md merge=union
# Session entries are parsed byte-exact: keep LF in the working tree even where autocrlf is on
projects/*/sessions/*.md text eol=lf
`;

function fail(code, message) {
  const err = new Error(message ?? code);
  err.code = code;
  return err;
}

// ── markers ──────────────────────────────────────────────────────────────────

/** The line that opens a body section: `kind` is 'summary' or 'track' (which needs `trackId`). */
export function entryMarker(kind, closeId, trackId) {
  if (typeof closeId !== 'string' || !CLOSE_ID_RE.test(closeId)) {
    throw fail('invalid-entry', `invalid close id: ${closeId}`);
  }
  if (kind === 'summary') return `<!-- hypomnema:summary ${closeId} -->`;
  if (kind === 'track') {
    if (typeof trackId !== 'string' || !TRACK_ID_RE.test(trackId)) {
      throw fail('invalid-entry', `invalid track id: ${trackId}`);
    }
    return `<!-- hypomnema:track ${trackId} ${closeId} -->`;
  }
  throw fail('invalid-entry', `unknown marker kind: ${kind}`);
}

// One judgement for both sides: the parser cuts at exactly the lines this recognises, and
// assertNoEntryMarkers refuses exactly the lines this recognises. A line is a marker only if the
// whole line matches and carries THIS entry's close id. The track id is any non-space token here
// (not TRACK_ID_RE), so a malformed id cannot slip past the writer and then split the reader.
function markerOf(line, closeId) {
  if (line === `<!-- hypomnema:summary ${closeId} -->`) return { kind: 'summary' };
  const prefix = '<!-- hypomnema:track ';
  const suffix = ` ${closeId} -->`;
  if (
    line.startsWith(prefix) &&
    line.endsWith(suffix) &&
    line.length > prefix.length + suffix.length
  ) {
    const id = line.slice(prefix.length, line.length - suffix.length);
    if (!/\s/.test(id)) return { kind: 'track', id };
  }
  return null;
}

/** Throws (code `payload-reserved-marker`) if a line of `text` is a marker of this close id. */
export function assertNoEntryMarkers(text, closeId) {
  for (const line of String(text).split('\n')) {
    if (markerOf(line, closeId)) {
      throw fail(
        'payload-reserved-marker',
        `text contains a line reserved for the entry of close ${closeId}: ${line}`,
      );
    }
  }
}

// ── format and parse ─────────────────────────────────────────────────────────

function scalar(name, value, re) {
  if (typeof value !== 'string' || !re.test(value)) {
    throw fail('invalid-entry', `invalid ${name}: ${JSON.stringify(value)}`);
  }
  return value;
}

function validateTracks(tracks) {
  if (!Array.isArray(tracks)) return 'bad-tracks';
  const seen = new Set();
  for (const t of tracks) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return 'bad-tracks';
    if (typeof t.id !== 'string' || !TRACK_ID_RE.test(t.id)) return 'bad-track-id';
    if (seen.has(t.id)) return 'duplicate-track-id';
    seen.add(t.id);
    if (t.title !== undefined && typeof t.title !== 'string') return 'bad-tracks';
    if (t.supersedes !== undefined) {
      if (!Array.isArray(t.supersedes) || t.supersedes.some((s) => typeof s !== 'string')) {
        return 'bad-tracks';
      }
    }
    for (const flag of ['new', 'done']) {
      if (t[flag] !== undefined && typeof t[flag] !== 'boolean') return 'bad-tracks';
    }
  }
  return null;
}

/**
 * Entry object to file text. `obj`: `{project, closeId, sessionId?, date, visibilityScope?,
 * tracks: [{id, title?, supersedes?, new?, done?}], summary, bodies?: {trackId: text}}`.
 * `title:` and `updated:` are derived (lint wants both). Throws on a malformed object or on a
 * body that holds a marker line of this close id.
 */
export function formatSessionEntry(obj) {
  const project = scalar('project', obj?.project, PROJECT_RE);
  const closeId = scalar('closeId', obj.closeId, CLOSE_ID_RE);
  const date = scalar('date', obj.date, DATE_RE);
  const tracks = obj.tracks;
  const trackProblem = validateTracks(tracks);
  if (trackProblem) {
    // The plan names three codes; the finer reason stays in the message.
    throw fail(
      trackProblem === 'duplicate-track-id' ? trackProblem : 'invalid-entry',
      `invalid tracks: ${trackProblem}`,
    );
  }
  const bodies = obj.bodies ?? {};
  for (const id of Object.keys(bodies)) {
    if (!tracks.some((t) => t.id === id)) {
      throw fail('invalid-entry', `body for undeclared track: ${id}`);
    }
  }
  if (typeof obj.summary !== 'string') throw fail('invalid-entry', 'summary must be a string');

  const head = ['---', 'type: session-entry', `title: "session entry: ${project} ${date}"`];
  head.push(`entry_schema: ${ENTRY_SCHEMA}`, `project: ${project}`, `close_id: ${closeId}`);
  if (obj.sessionId) head.push(`session_id: ${scalar('sessionId', obj.sessionId, CLOSE_ID_RE)}`);
  head.push(`date: ${date}`, `updated: ${date}`);
  if (obj.visibilityScope) {
    head.push(`visibility_scope: ${scalar('visibilityScope', obj.visibilityScope, /^[^\r\n]+$/)}`);
  }
  head.push(`tracks: ${JSON.stringify(tracks)}`, '---');

  const sections = [{ marker: entryMarker('summary', closeId), text: obj.summary }];
  for (const t of tracks) {
    if (!Object.hasOwn(bodies, t.id)) continue;
    if (typeof bodies[t.id] !== 'string')
      throw fail('invalid-entry', `body of ${t.id} not a string`);
    sections.push({ marker: entryMarker('track', closeId, t.id), text: bodies[t.id] });
  }
  for (const s of sections) assertNoEntryMarkers(s.text, closeId);

  // `marker`, blank line, text, newline; a blank line joins sections. parse strips exactly this.
  return `${head.join('\n')}\n\n${sections.map((s) => `${s.marker}\n\n${s.text}\n`).join('\n')}`;
}

// Offset just past the closing `---` line (and its newline) when `text` opens with a `---` line
// and a later `---` line exists; -1 otherwise.
function frontmatterEnd(text) {
  if (!text.startsWith('---\n')) return -1;
  let pos = 4;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (text.slice(pos, lineEnd) === '---') return nl === -1 ? text.length : nl + 1;
    if (nl === -1) return -1;
    pos = nl + 1;
  }
  return -1;
}

/**
 * Entry file text to `{ok: true, entry}` (same shape formatSessionEntry takes, plus `updated`)
 * or `{ok: false, reason}`. The body is cut only at marker lines of the close id the
 * frontmatter names, so headings, fences and other entries' markers inside a section are text.
 */
export function parseSessionEntry(text) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof text !== 'string') return bad('not-text');
  text = text.replaceAll('\r\n', '\n'); // a CRLF checkout (autocrlf) parses as the LF original
  const fmEnd = frontmatterEnd(text);
  if (fmEnd === -1) return bad('no-frontmatter');
  const fm = {};
  for (const line of text.slice(4, fmEnd - 4).split('\n')) {
    const m = /^([a-z_]+):[ ]?(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2];
  }
  if (fm.type !== 'session-entry') return bad('not-a-session-entry');
  if (fm.entry_schema !== String(ENTRY_SCHEMA)) return bad('unsupported-entry-schema');
  for (const [key, re] of [
    ['project', PROJECT_RE],
    ['close_id', CLOSE_ID_RE],
    ['date', DATE_RE],
  ]) {
    if (fm[key] === undefined) return bad(`missing-${key}`);
    if (!re.test(fm[key])) return bad(`bad-${key}`);
  }
  if (fm.session_id !== undefined && !CLOSE_ID_RE.test(fm.session_id)) return bad('bad-session_id');
  if (fm.tracks === undefined) return bad('missing-tracks');
  let tracks;
  try {
    tracks = JSON.parse(fm.tracks);
  } catch {
    return bad('bad-tracks');
  }
  const trackProblem = validateTracks(tracks);
  if (trackProblem) return bad(trackProblem);

  const closeId = fm.close_id;
  const rest = text.slice(fmEnd);
  const cuts = []; // {kind, id, start, end}: start of the marker line, offset past it
  let pos = 0;
  for (const line of rest.split('\n')) {
    const marker = markerOf(line, closeId);
    if (marker) cuts.push({ ...marker, start: pos, end: pos + line.length + 1 });
    pos += line.length + 1;
  }
  if (!cuts.length || cuts[0].kind !== 'summary' || cuts[0].start !== 1 || rest[0] !== '\n') {
    return bad('missing-summary');
  }
  const bodies = {};
  let summary = null;
  for (let i = 0; i < cuts.length; i++) {
    const last = i === cuts.length - 1;
    const chunk = rest.slice(cuts[i].end, last ? rest.length : cuts[i + 1].start);
    const tail = last ? '\n' : '\n\n';
    if (!chunk.startsWith('\n') || !chunk.endsWith(tail) || chunk.length < 1 + tail.length) {
      return bad('malformed-section');
    }
    const body = chunk.slice(1, chunk.length - tail.length);
    if (cuts[i].kind === 'summary') {
      if (summary !== null) return bad('duplicate-summary');
      summary = body;
    } else {
      if (!tracks.some((t) => t.id === cuts[i].id)) return bad('unknown-track-body');
      if (Object.hasOwn(bodies, cuts[i].id)) return bad('duplicate-track-body');
      bodies[cuts[i].id] = body;
    }
  }
  return {
    ok: true,
    entry: {
      project: fm.project,
      closeId,
      sessionId: fm.session_id ?? null,
      date: fm.date,
      updated: fm.updated ?? fm.date,
      visibilityScope: fm.visibility_scope ?? null,
      tracks,
      summary,
      bodies,
    },
  };
}

// ── baseline entries ─────────────────────────────────────────────────────────

/**
 * `{frontmatter, body}` for a baseline section: if `text` opens with a `---` line, `frontmatter`
 * is everything through the next `---` line (both delimiter lines and the newline included) and
 * `body` the rest, so `frontmatter + body === text`. Otherwise `frontmatter: null`, `body: text`.
 */
export function splitLegacyFrontmatter(text) {
  const end = frontmatterEnd(text);
  if (end === -1) return { frontmatter: null, body: text };
  return { frontmatter: text.slice(0, end), body: text.slice(end) };
}

/**
 * The entry that stands in for a project's old `hot.md` and `session-state.md`. Both texts go in
 * whole, frontmatter included (`tags`, `related`, `machine_note` survive). Returns
 * `{closeId, fileName, text}`. The id hashes the two texts, `legacyDone` and `visibilityScope`, so
 * two machines with the same inputs write the same path and bytes, and inputs that differ in any
 * of those land on different paths instead of colliding.
 */
export function buildBaselineEntry({
  hotText,
  stateText,
  date,
  visibilityScope,
  project,
  legacyDone,
}) {
  const hot = hotText ?? '';
  const state = stateText ?? '';
  const done = Boolean(legacyDone);
  const scope = visibilityScope || null;
  const h16 = createHash('sha256')
    .update(JSON.stringify([hot, state, done, scope]))
    .digest('hex')
    .slice(0, 16);
  const closeId = `baseline-${h16}`;
  const legacy = { id: LEGACY_TRACK_ID, title: BASELINE_TITLE, new: true };
  if (done) legacy.done = true;
  const text = formatSessionEntry({
    project,
    closeId,
    date,
    visibilityScope: scope,
    tracks: [legacy],
    summary: hot,
    bodies: { [LEGACY_TRACK_ID]: state },
  });
  return { closeId, fileName: entryFileName(date, closeId), text };
}

// ── ids and file names ───────────────────────────────────────────────────────

/**
 * One full id from an explicit `supersedes` element: an exact id wins, else the only id that
 * starts with `prefix`. `{ok: true, id}` or `{ok: false, reason: 'unknown' | 'ambiguous'}`.
 */
export function resolveSupersedesPrefix(prefix, ids) {
  if (typeof prefix !== 'string' || !prefix) return { ok: false, reason: 'unknown' };
  if (ids.includes(prefix)) return { ok: true, id: prefix };
  const hits = [...new Set(ids.filter((id) => id.startsWith(prefix)))];
  if (hits.length === 1) return { ok: true, id: hits[0] };
  return { ok: false, reason: hits.length ? 'ambiguous' : 'unknown' };
}

export function entryFileName(date, closeId) {
  return `${scalar('date', date, DATE_RE)}-${scalar('closeId', closeId, CLOSE_ID_RE)}.md`;
}

/** `<sessionId>-<openedAtIndex>`: the same close signal always yields the same id. */
export function closeIdFor(sessionId, openedAtIndex) {
  if (!isValidSessionId(sessionId)) throw fail('invalid-entry', `invalid session id: ${sessionId}`);
  if (!Number.isInteger(openedAtIndex) || openedAtIndex < 0) {
    throw fail('invalid-entry', `invalid openedAtIndex: ${openedAtIndex}`);
  }
  return `${sessionId}-${openedAtIndex}`;
}

// ── path predicates ──────────────────────────────────────────────────────────

/**
 * The project slug of `projects/<slug>/hot.md` or `projects/<slug>/session-state.md` (depth 1, not
 * `_template`); `null` for the root `hot.md` and for any other path.
 */
export function generatedViewSlug(relPath) {
  const m = /^projects\/([^/]+)\/(?:hot|session-state)\.md$/.exec(relPath);
  return m !== null && m[1] !== '_template' ? m[1] : null;
}

/** `hot.md`, `projects/<slug>/hot.md`, `projects/<slug>/session-state.md` (depth 1, not `_template`). */
export function isGeneratedViewPath(relPath) {
  return relPath === 'hot.md' || generatedViewSlug(relPath) !== null;
}

/** `projects/<slug>/sessions/<file>.md`, depth fixed. */
export function isSessionEntryPath(relPath) {
  return /^projects\/[^/]+\/sessions\/[^/]+\.md$/.test(relPath);
}

/** The two view paths of the project an entry path belongs to; `null` for any other path. */
export function sessionViewPathsOf(relPath) {
  if (!isSessionEntryPath(relPath)) return null;
  const slug = relPath.split('/')[1];
  return [`projects/${slug}/hot.md`, `projects/${slug}/session-state.md`];
}

// ── visibility scope and .gitignore merging ──────────────────────────────────

/**
 * The narrowest of several `visibility_scope` values: `{scope, conflict}`. A `machine:` value is
 * narrower than anything else. Two different `machine:` values share no machine, so the result is
 * `machine:` (visible nowhere) with `conflict: true`. With no `machine:` value it is the first
 * non-empty value, or `null`.
 */
export function narrowestVisibilityScope(values) {
  const cleaned = (values ?? []).map((v) => String(v ?? '').trim()).filter(Boolean);
  const machines = [...new Set(cleaned.filter((v) => v.startsWith('machine:')))];
  if (machines.length > 1) return { scope: 'machine:', conflict: true };
  if (machines.length === 1) return { scope: machines[0], conflict: false };
  return { scope: cleaned[0] ?? null, conflict: false };
}

function splitLines(text) {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// The lines of `lines` that are not base lines, or null when a base line is missing or out of
// order (leftmost greedy match, so a duplicated base line is matched to its first copy).
function addedLines(base, lines) {
  const added = [];
  let b = 0;
  for (const line of lines) {
    if (b < base.length && line === base[b]) b++;
    else added.push(line);
  }
  return b === base.length ? added : null;
}

/**
 * Merge two `.gitignore` edits of one base when both only added lines. `{ok: true, merged}`
 * (theirs' bytes, then the lines only `ours` added, each once) or `{ok: false, reason}`. It
 * refuses a removed or reordered base line on either side, and a `!` line added on EITHER side:
 * a negation depends on where it sits among the other patterns, and appending reorders them.
 */
export function mergeAdditiveGitignore(base, ours, theirs) {
  const baseLines = splitLines(base);
  const oursAdded = addedLines(baseLines, splitLines(ours));
  if (oursAdded === null) return { ok: false, reason: 'ours-changed-base-line' };
  const theirsLines = splitLines(theirs);
  const theirsAdded = addedLines(baseLines, theirsLines);
  if (theirsAdded === null) return { ok: false, reason: 'theirs-changed-base-line' };
  if ([...oursAdded, ...theirsAdded].some((l) => l.trimStart().startsWith('!'))) {
    return { ok: false, reason: 'negation-added' };
  }
  const seen = new Set(theirsLines);
  const extra = [];
  for (const line of oursAdded) {
    if (seen.has(line)) continue;
    seen.add(line);
    extra.push(line);
  }
  if (!extra.length) return { ok: true, merged: theirs };
  const lead = theirs === '' || theirs.endsWith('\n') ? '' : '\n';
  return { ok: true, merged: `${theirs}${lead}${extra.join('\n')}\n` };
}

// ── project directories and root rows ────────────────────────────────────────

/** A `projects/` child that is a session project: has `index.md` or `sessions/`, not `_template`. */
export function isSessionProjectDir({ slug, hasIndex, hasSessions }) {
  return (
    typeof slug === 'string' && slug !== '' && slug !== '_template' && !!(hasIndex || hasSessions)
  );
}

// Code-unit comparison on purpose: `localeCompare` orders by locale, so two machines could
// disagree on the bytes of one generated file.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Root table rows `{slug, date}`: date descending (blank last), then slug ascending. A new array. */
export function sortRootRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.date !== b.date) {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return cmp(b.date, a.date);
    }
    return cmp(a.slug, b.slug);
  });
}

// ── order and heads ──────────────────────────────────────────────────────────

/** A baseline entry (real or virtual) stands for the old `hot.md` and `session-state.md`. */
export const isBaselineId = (closeId) => closeId.startsWith('baseline-');

const supersededIdsOf = (entry) => entry.tracks.flatMap((t) => t.supersedes ?? []);

/**
 * Entries newest first: `date` descending, then supersede depth descending (1 + the deepest entry
 * it replaces, so a same-day replacement sorts before what it replaced), then close id ascending.
 * A new array; never reads the clock.
 */
export function sortEntries(entries) {
  const byId = new Map(entries.map((e) => [e.closeId, e]));
  const depths = new Map();
  const depthOf = (entry, active = new Set()) => {
    if (depths.has(entry.closeId)) return depths.get(entry.closeId);
    if (active.has(entry.closeId)) return 0; // a cycle cannot arise from real ids; just do not loop
    active.add(entry.closeId);
    let deepest = 0;
    for (const id of supersededIdsOf(entry)) {
      const target = byId.get(id);
      if (target && target !== entry) deepest = Math.max(deepest, depthOf(target, active));
    }
    active.delete(entry.closeId);
    depths.set(entry.closeId, deepest + 1);
    return deepest + 1;
  };
  return [...entries].sort(
    (a, b) => cmp(b.date, a.date) || depthOf(b) - depthOf(a) || cmp(a.closeId, b.closeId),
  );
}

/**
 * The heads of every track in `entries`: `[{trackId, title, done, heads}]`, tracks in the order of
 * their first head, heads in entry order. An update is a head unless another update of the same
 * track lists its close id in `supersedes` (an id that names nothing is ignored). `done` is true
 * when every head is done. `title` is the newest title any update of the track carries.
 */
export function trackHeads(entries) {
  const sorted = sortEntries(entries);
  const updates = new Map(); // trackId -> [{entry, track}] in entry order
  for (const entry of sorted) {
    for (const track of entry.tracks) {
      if (!updates.has(track.id)) updates.set(track.id, []);
      updates.get(track.id).push({ entry, track });
    }
  }
  const byFirstHead = [];
  for (const [trackId, list] of updates) {
    const replaced = new Set();
    for (const { entry, track } of list) {
      for (const id of track.supersedes ?? []) if (id !== entry.closeId) replaced.add(id);
    }
    const heads = list
      .filter(({ entry }) => !replaced.has(entry.closeId))
      .map(({ entry, track }) => ({
        trackId,
        closeId: entry.closeId,
        date: entry.date,
        done: track.done === true,
        entry,
      }));
    if (!heads.length) continue;
    const title = list.find(({ track }) => typeof track.title === 'string' && track.title)?.track
      .title;
    byFirstHead.push({
      trackId,
      title: title ?? trackId,
      done: heads.every((h) => h.done),
      heads,
      first: sorted.indexOf(heads[0].entry),
    });
  }
  return byFirstHead
    .sort((a, b) => a.first - b.first || cmp(a.trackId, b.trackId))
    .map(({ first, ...track }) => track);
}

/**
 * The single visibility decision, shared by lookup / query / file-watch / page-usage /
 * crystallize (through hypo-shared, which re-exports it) and by the generated views.
 * `scopeValue` is a readVisibilityScope() output, `device` a currentDevice() output. Prefix
 * dispatch, fail-open on anything unrecognized so the field is purely additive:
 *   ''/'shared'       visible (the implicit default of every pre-existing page)
 *   'machine:<owner>' visible only on the owning machine. An empty owner (`machine:`) hides
 *                     everywhere: '' can never equal currentDevice()'s non-empty fallback.
 *   'agent:<id>'      visible; value space reserved, no writer yet (forward-compat)
 *   anything else     visible (fail-open)
 * No `device` hides every `machine:` value.
 */
export function scopeVisible(scopeValue, device) {
  const v = String(scopeValue || '').trim();
  if (v === '' || v === 'shared') return true;
  if (v.startsWith('machine:')) return v.slice('machine:'.length) === device;
  if (v.startsWith('agent:')) return true;
  return true;
}

// Everything the renderers and the injection share: the entries this machine may see (a hidden
// entry is treated as absent, so it cannot replace a visible one), newest first, and the active
// and finished tracks. `model.entryScope`, when a string, replaces every entry's own scope.
function projectView(model, device) {
  const forced = typeof model.entryScope === 'string' ? model.entryScope : null;
  const entries = sortEntries(
    model.entries.filter((e) => scopeVisible(forced ?? e.visibilityScope, device)),
  );
  const tracks = trackHeads(entries);
  const live = new Set();
  for (const t of tracks) {
    if (t.done) continue;
    for (const h of t.heads) if (!h.done) live.add(`${t.trackId} ${h.closeId}`);
  }
  const titles = new Map(tracks.map((t) => [t.trackId, t.title]));
  const slug = model.project;
  const items = [];
  for (const entry of entries) {
    for (const track of entry.tracks) {
      if (!live.has(`${track.id} ${entry.closeId}`)) continue;
      const baseline = isBaselineId(entry.closeId);
      const { frontmatter, body } = baseline
        ? splitLegacyFrontmatter(entry.bodies[track.id] ?? '')
        : { frontmatter: null, body: entry.bodies[track.id] ?? '' };
      items.push({
        trackId: track.id,
        title: titles.get(track.id),
        date: entry.date,
        closeId: entry.closeId,
        body,
        legacyFrontmatter: frontmatter,
        sourcePath:
          model.migrated || baseline
            ? `projects/${slug}/session-state.md`
            : `projects/${slug}/sessions/${entryFileName(entry.date, entry.closeId)}`,
      });
    }
  }
  return { entries, finished: tracks.filter((t) => t.done), items };
}

/**
 * The active heads in entry order, for `## Next Up`, the terminal summary and resume:
 * `[{trackId, title, date, closeId, body, legacyFrontmatter, sourcePath}]`. `body` is the head's
 * section without a baseline's old frontmatter (that goes in `legacyFrontmatter`, else `null`).
 * `sourcePath` is where to read the head: `session-state.md` once the vault is migrated or for a
 * baseline, else the entry file. `model`: `{project, migrated, entries, ...}`; `device` filters
 * entries by `visibility_scope`.
 */
export function nextUpItems(model, { device } = {}) {
  return projectView(model, device).items;
}

// ── rendering ────────────────────────────────────────────────────────────────

const RECENT_SUMMARIES = 5;
const OLDER_LINKS = 20;
const FINISHED_TRACKS = 5;
const POINTER_LINES = 20;

const labelOf = (i) => `${i.title} (${i.trackId}) · ${i.date} · ${i.closeId}`;

function yamlFence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}yaml\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`;
}

const foldedFrontmatter = (fm) =>
  `<details><summary>이행 전 파일의 frontmatter</summary>\n\n${yamlFence(fm)}\n\n</details>`;

const GENERATED_NOTE = (slug) =>
  `> Generated from projects/${slug}/sessions/. Do not edit: the next session start or stop overwrites this file and keeps a backup of anything it did not write. To change it, close a session with a track update.`;

const joinBlocks = (blocks) => blocks.filter((b) => b !== null && b !== '').join('\n\n');

// A summary section; a baseline's is the old hot.md whole, so its frontmatter is split off.
function summaryParts(entry) {
  return isBaselineId(entry.closeId)
    ? splitLegacyFrontmatter(entry.summary)
    : { frontmatter: null, body: entry.summary };
}

function renderSessionState(model, view) {
  const { items, finished } = view;
  const shownFinished = finished.slice(0, FINISHED_TRACKS);
  const updated = [...items.map((i) => i.date), ...shownFinished.map((t) => t.heads[0].date)]
    .sort()
    .at(-1);
  const blocks = [
    `---\ntype: session-state\ntitle: "session state: ${model.project}"\nupdated: ${updated ?? ''}\ngenerated: sessions\n---`,
    GENERATED_NOTE(model.project),
    '## Next Up',
  ];
  if (!items.length) blocks.push('No active tracks.');
  for (const i of items) {
    blocks.push(
      `### ${labelOf(i)}`,
      i.legacyFrontmatter === null ? null : foldedFrontmatter(i.legacyFrontmatter),
      i.body,
    );
  }
  if (shownFinished.length) {
    blocks.push(
      '## Finished tracks',
      shownFinished.map((t) => `- ${t.title} (${t.trackId}) · ${t.heads[0].date}`).join('\n'),
    );
  }
  const unreadable = [...(model.unreadable ?? [])].sort((a, b) => cmp(a.fileName, b.fileName));
  if (unreadable.length) {
    blocks.push(
      '## Unreadable entries',
      unreadable.map((u) => `- \`${u.fileName}\`: ${u.reason}`).join('\n'),
    );
  }
  return `${joinBlocks(blocks)}\n`;
}

function renderHot(model, view) {
  const { entries } = view;
  const recent = entries.slice(0, RECENT_SUMMARIES);
  const older = entries.slice(RECENT_SUMMARIES, RECENT_SUMMARIES + OLDER_LINKS);
  const rest = entries.length - recent.length - older.length;
  const slug = model.project;
  const blocks = [
    `---\ntype: reference\ntitle: "hot: ${slug}"\nupdated: ${entries[0]?.date ?? ''}\ngenerated: sessions\n---`,
    GENERATED_NOTE(slug),
    '## Recent sessions',
  ];
  if (!recent.length) blocks.push('No session entries yet.');
  for (const e of recent) {
    const { frontmatter, body } = summaryParts(e);
    blocks.push(
      `### ${e.date} · ${e.closeId}`,
      frontmatter === null ? null : foldedFrontmatter(frontmatter),
      body,
    );
  }
  if (older.length || rest > 0) {
    blocks.push('## Older sessions');
    if (older.length) {
      blocks.push(
        older
          .map(
            (e) =>
              `- ${e.date} · [[projects/${slug}/sessions/${entryFileName(e.date, e.closeId).slice(0, -3)}]]`,
          )
          .join('\n'),
      );
    }
    if (rest > 0) blocks.push(`그 밖 ${rest}개는 \`projects/${slug}/sessions/\`에 있습니다.`);
  }
  blocks.push('## Project notes', `- [[projects/${slug}/notes]]`);
  return `${joinBlocks(blocks)}\n`;
}

function renderRoot(rows) {
  const table = rows
    .map((r) => `| ${r.slug} | ${r.date} | [[projects/${r.slug}/hot]] |`)
    .join('\n');
  const updated = rows.reduce((max, r) => (r.date && r.date > max ? r.date : max), '');
  return `---
title: "Hot Cache: Pointer"
type: reference
updated: ${updated}
tags: [wiki, operations]
---

# Hot Cache

> Read at session start → navigate to the relevant project session-state.md and hot.md.
> This "Active Projects" table is generated from \`projects/*/sessions/\`, rebuilt at every session start and stop. To change it, close a session in the relevant project: a hand edit to this table is overwritten by the next session.

## Active Projects

| Project | Last Session | Hot Cache |
|---|---|---|
${table}

## Session Start Checklist

1. Check this file for the relevant project link
2. Read \`projects/<name>/session-state.md\` for next tasks if it exists
3. Read \`projects/<name>/hot.md\` for project background
`;
}

/**
 * The generated files, as strings, from project models (see nextUpItems). `models` is every
 * project's model, because the root table has a row per project. Returns
 * `{projects: {slug: {hot, sessionState}}, root}`; `only` (slugs) limits the per-project files,
 * the root is always whole. A function of its arguments: the same models give the same bytes on
 * any machine and any day.
 */
export function renderViews(models, { device, only } = {}) {
  const projects = {};
  const rows = [];
  for (const model of models) {
    const view = projectView(model, device);
    rows.push({ slug: model.project, date: view.entries[0]?.date ?? '' });
    if (only && !only.includes(model.project)) continue;
    projects[model.project] = {
      hot: renderHot(model, view),
      sessionState: renderSessionState(model, view),
    };
  }
  return { projects, root: renderRoot(sortRootRows(rows)) };
}

// ── injection ────────────────────────────────────────────────────────────────

/**
 * What SessionStart tells the model, within `budget` characters: `{text, observed}`. Every active
 * head gets a pointer line first (up to 20, then "외 N개"; this reservation is never cut back).
 * With what is left, whole items replace pointer lines or join the text in priority order: heads
 * in entry order, the newest summary, `model.notes`, the other recent summaries. An item goes in
 * whole or not at all, except that the first head alone may be cut to the remaining budget. A
 * head whose body went in whole is in `observed.heads`; one shown as a pointer or cut is in
 * `observed.pointer`; one folded into "외 N개" is in neither (the session was never told of it).
 */
export function buildInjection(model, budget, { device } = {}) {
  const view = projectView(model, device);
  const slots = view.items
    .slice(0, POINTER_LINES)
    .map((item) => ({ item, text: null, cut: false }));
  const overflow = view.items.length - slots.length;
  const pointer = (item) =>
    `- ${labelOf(item)}: 이 트랙을 이어 작업하면 먼저 ${item.sourcePath}에서 이 머리를 읽으세요. 닫을 때 이 머리를 대체합니다.`;
  const sums = view.entries.slice(0, RECENT_SUMMARIES).map((entry) => {
    const { frontmatter, body } = summaryParts(entry);
    const text = joinBlocks([
      `### ${entry.date} · ${entry.closeId}`,
      frontmatter === null ? null : yamlFence(frontmatter),
      body,
    ]);
    return { text, on: false };
  });
  const notes = { text: model.notes ? `## Project notes\n\n${model.notes}` : null, on: false };

  const render = () => {
    const sections = [];
    const active = slots.map((s) => s.text ?? pointer(s.item));
    if (overflow > 0) active.push(`- 외 ${overflow}개`);
    if (active.length) sections.push(`## Active tracks\n\n${active.join('\n\n')}`);
    if (sums[0]?.on) sections.push(`## Latest session\n\n${sums[0].text}`);
    if (notes.on) sections.push(notes.text);
    const earlier = sums.slice(1).filter((s) => s.on);
    if (earlier.length)
      sections.push(`## Earlier sessions\n\n${earlier.map((s) => s.text).join('\n\n')}`);
    return sections.join('\n\n');
  };
  const unitOf = (item, body, note) =>
    joinBlocks([
      `#### ${labelOf(item)}`,
      item.legacyFrontmatter === null ? null : yamlFence(item.legacyFrontmatter),
      body,
      note,
    ]);
  const fits = () => render().length <= budget;

  slots.forEach((slot, index) => {
    slot.text = unitOf(slot.item, slot.item.body, null);
    if (fits()) return;
    slot.text = null;
    if (index !== 0) return;
    // The first head may be cut to what is left; the pointer lines of the others stay reserved.
    const note = `(잘림: 전문은 ${slot.item.sourcePath})`;
    slot.text = unitOf(slot.item, '', note);
    const room = budget - render().length - 2;
    if (room <= 0) {
      slot.text = null;
      return;
    }
    let cut = slot.item.body.slice(0, room);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    slot.text = unitOf(slot.item, cut, note);
    slot.cut = true;
  });
  for (const part of [sums[0], notes, ...sums.slice(1)]) {
    if (!part || part.text === null) continue;
    part.on = true;
    if (!fits()) part.on = false;
  }

  const heads = {};
  const pointers = {};
  for (const { item, text, cut } of slots) {
    const into = text !== null && !cut ? heads : pointers;
    (into[item.trackId] ??= []).push(item.closeId);
  }
  return { text: render(), observed: { project: model.project, heads, pointer: pointers } };
}
