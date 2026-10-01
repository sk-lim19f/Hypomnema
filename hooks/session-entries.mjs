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
  if (trackProblem) throw fail(trackProblem, `invalid tracks: ${trackProblem}`);
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

/** `hot.md`, `projects/<slug>/hot.md`, `projects/<slug>/session-state.md` (depth 1, not `_template`). */
export function isGeneratedViewPath(relPath) {
  if (relPath === 'hot.md') return true;
  const m = /^projects\/([^/]+)\/(?:hot|session-state)\.md$/.exec(relPath);
  return m !== null && m[1] !== '_template';
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
  const lines = text.split('\n');
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
