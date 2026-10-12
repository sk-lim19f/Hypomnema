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
const PROJECT_CHARS_RE = /^[\p{L}\p{M}\p{N}._-]+$/u;

/**
 * The one project-name rule, shared by the entry format, the crystallize CLI and payload gates,
 * project creation and the hook-side slug checks. A name is a single path segment of Unicode
 * letters, marks and numbers (any script) plus `.`, `_` and `-`, not all dots, with at least one
 * letter or number. Whitespace, `/`, `\`, NUL and other control characters are outside the
 * charset. It is written unquoted into `project:`, so a space or `#` would read differently in a
 * generic frontmatter reader. Names are compared in NFC (callers normalize before comparing with
 * a directory name), but the rule itself accepts either form.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidProjectName(name) {
  return (
    typeof name === 'string' &&
    PROJECT_CHARS_RE.test(name) &&
    !/^\.+$/.test(name) &&
    /[\p{L}\p{N}]/u.test(name)
  );
}

/**
 * Why a project directory name cannot be used, or `null` when it can. `'invalid'` when
 * `isValidProjectName` rejects it, `'not-nfc'` when it is valid but not in NFC: git on macOS reports
 * precomposed paths, so a decomposed directory name never matches the paths git prints.
 */
export function projectNameProblem(name) {
  if (!isValidProjectName(name)) return 'invalid';
  if (name !== name.normalize('NFC')) return 'not-nfc';
  return null;
}

/**
 * The two `/hypo:rename` commands that move a project directory spelled in NFD to its NFC name.
 * macOS file systems treat both spellings as one name, so a direct rename is refused as existing:
 * the move goes through a temporary name. Both paths carry `projects/`, which rename needs to stay
 * in the same top-level area.
 */
export function nfcRenameCommands(onDisk) {
  const nfc = onDisk.normalize('NFC');
  const tmp = `${nfc}.nfc-tmp`;
  return [
    `/hypo:rename --from="projects/${onDisk}" --to="projects/${tmp}"`,
    `/hypo:rename --from="projects/${tmp}" --to="projects/${nfc}"`,
  ];
}
// `scalar` and the parser take anything with `.test`, so the project rule slots in beside the regexes.
const PROJECT_RE = { test: isValidProjectName };
const BASELINE_TITLE = '이행 전 기록';
// `closed_at`: the close's write time, ISO 8601 UTC with `Z` (what `Date#toISOString` prints), the
// fraction optional. Unquoted in the frontmatter, so no space or offset may appear.
const CLOSED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const validClosedAt = (v) =>
  typeof v === 'string' && CLOSED_AT_RE.test(v) && !Number.isNaN(Date.parse(v));

// Byte-fixed blocks. Two machines that append them independently must produce the same change.
// `atomicWrite` leaves a killed write as `<view>.<pid>.<random>.tmp` beside the view (the pid is
// all digits), so the `.[0-9]*.tmp` patterns cover that name and nothing a person would pick.
// `/.cache/` holds the view backups, the ownership record and the pull archive.
export const GITIGNORE_BLOCK = `# Hypomnema: session views generated from projects/*/sessions/ (not committed)
/hot.md
/projects/*/hot.md
/projects/*/session-state.md
/hot.md.[0-9]*.tmp
/projects/*/hot.md.[0-9]*.tmp
/projects/*/session-state.md.[0-9]*.tmp
/.cache/
/hot.md.pre-projection-backup*.md
/hot.md.pre-projection-backup*.tmp
/projects/*/*.pre-projection-backup*.md
/projects/*/*.pre-projection-backup*.tmp
/projects/*/sessions/*.tmp
`;

// The `log.md merge=union` line is deliberately unanchored: git reads a pattern without a slash at
// any depth, so it covers every `log.md` in the vault, not only the root one. It stays that way
// because it is the line people already wrote by hand; an anchored `/log.md` would not match it
// and would read as a missing block line in their vaults. The comment inside the block is block
// bytes, so it is not reworded here (an edition change needs an entry in the previous-editions list).
export const GITATTRIBUTES_BLOCK = `# Hypomnema: session-log shards are append-only, keep both sides on a merge
projects/*/session-log/*.md merge=union
# The root log.md is append-only too: two clones closing on the same day both add lines to it
log.md merge=union
# Session entries are parsed byte-exact: keep LF in the working tree even where autocrlf is on
projects/*/sessions/*.md text eol=lf
`;

// Earlier byte-exact editions of the two blocks the migration commit adds. A vault moved with one of
// them keeps migrating nothing further (`migrationState` reads a block that lacks a pattern line of
// the current edition as `incomplete-block`), so the command swaps a known old edition for the
// current one. Add the outgoing edition here whenever `GITIGNORE_BLOCK` or `GITATTRIBUTES_BLOCK`
// changes (a test fails until you do). An edition that is not listed (a hand edit) is left alone
// and the move reports it.
export const PREVIOUS_GITIGNORE_BLOCKS = [
  `# Hypomnema: session views generated from projects/*/sessions/ (not committed)
/hot.md
/projects/*/hot.md
/projects/*/session-state.md
/hot.md.pre-projection-backup*.md
/hot.md.pre-projection-backup*.tmp
/projects/*/*.pre-projection-backup*.md
/projects/*/*.pre-projection-backup*.tmp
/projects/*/sessions/*.tmp
`,
];
export const PREVIOUS_GITATTRIBUTES_BLOCKS = [
  // Longest edition first: the swap takes the first one found inside the file, and a shorter
  // edition is a prefix of the longer one.
  `# Hypomnema: session-log shards are append-only, keep both sides on a merge
projects/*/session-log/*.md merge=union
# Session entries are parsed byte-exact: keep LF in the working tree even where autocrlf is on
projects/*/sessions/*.md text eol=lf
`,
  `# Hypomnema: session-log shards are append-only, keep both sides on a merge
projects/*/session-log/*.md merge=union
`,
];

/**
 * How much of `block` (`GITIGNORE_BLOCK` or `GITATTRIBUTES_BLOCK`) `text` holds: `null` when the
 * block's first line is not a line of `text`, else the block's pattern lines (every line after the
 * first that is not a comment) that `text` lacks, in block order. `[]` means complete. Lines are
 * compared trimmed and whole; order and neighbouring lines are not looked at, and nothing here
 * rewrites `text`.
 */
export function missingBlockLines(text, block) {
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const lines = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!have.has(lines[0])) return null;
  return lines.slice(1).filter((l) => !l.startsWith('#') && !have.has(l));
}

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

// Section text as it is stored: every line ending is LF. The parser folds CRLF to LF before it
// looks for markers, so a marker line ending in CRLF must be judged as the marker it becomes. A
// lone CR is a line break here too (old Mac endings): left in, it could end up next to the `\n`
// the writer appends and fold into a CRLF the check never saw. After this no CR remains, so the
// parser's fold is a no-op on what the writer emits.
const toLf = (text) => String(text).replace(/\r\n?/g, '\n');

/** Throws (code `payload-reserved-marker`) if a line of `text` is a marker of this close id. */
export function assertNoEntryMarkers(text, closeId) {
  for (const line of toLf(text).split('\n')) {
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
 * Entry object to file text. `obj`: `{project, closeId, sessionId?, date, closedAt?,
 * visibilityScope?, tracks: [{id, title?, supersedes?, new?, done?}], summary, bodies?: {trackId:
 * text}}`. `closedAt` (ISO 8601 UTC ending in `Z`) is when the close wrote the entry; it orders
 * entries of one day (see sortEntries) and may be left out (older entries have none).
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
  if (obj.closedAt !== undefined && obj.closedAt !== null) {
    if (!validClosedAt(obj.closedAt)) {
      throw fail('invalid-entry', `invalid closedAt: ${JSON.stringify(obj.closedAt)}`);
    }
    head.push(`closed_at: ${obj.closedAt}`);
  }
  if (obj.visibilityScope) {
    head.push(`visibility_scope: ${scalar('visibilityScope', obj.visibilityScope, /^[^\r\n]+$/)}`);
  }
  head.push(`tracks: ${JSON.stringify(tracks)}`, '---');

  const sections = [{ marker: entryMarker('summary', closeId), text: toLf(obj.summary) }];
  for (const t of tracks) {
    if (!Object.hasOwn(bodies, t.id)) continue;
    if (typeof bodies[t.id] !== 'string')
      throw fail('invalid-entry', `body of ${t.id} not a string`);
    sections.push({ marker: entryMarker('track', closeId, t.id), text: toLf(bodies[t.id]) });
  }
  // Checked and written as the same LF text.
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
 * Entry file text to `{ok: true, entry}` (same shape formatSessionEntry takes, plus `updated`;
 * `closedAt` is there only when the file has `closed_at`)
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
  if (fm.closed_at !== undefined && !validClosedAt(fm.closed_at)) return bad('bad-closed_at');
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
      ...(fm.closed_at === undefined ? {} : { closedAt: fm.closed_at }),
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

// The headings that open the "what to do next" part of an old `session-state.md`. The one list:
// hypo-shared re-exports it as `SESSION_STATE_NEXT_HEADINGS` for lint. `## Next Up` is what the
// generator renders.
export const NEXT_UP_HEADINGS = ['다음 이어받기', '다음 작업', 'Next Up', 'Next'];

// Whether an HTML comment is still open after `line`, given whether one was open before it.
function commentOpenAfter(line, open) {
  let i = 0;
  let o = open;
  for (;;) {
    const j = line.indexOf(o ? '-->' : '<!--', i);
    if (j === -1) return o;
    i = j + (o ? 3 : 4);
    o = !o;
  }
}

// `[{level, title, start, end}]` for every `##` and `###` heading line of `text` outside code fences,
// HTML comments and the frontmatter. `start` is the offset of the line, `end` the offset just past
// its newline (or the text length).
function headingLines(text) {
  const out = [];
  let pos = Math.max(0, frontmatterEnd(text));
  let fence = null; // {char, len} while inside a fenced block
  let comment = false; // inside an HTML comment that began on an earlier line
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, nl === -1 ? text.length : nl);
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len && f[2].trim() === '')
        fence = null;
    } else if (comment) {
      comment = commentOpenAfter(line, true);
    } else if (f) {
      fence = { char: f[1][0], len: f[1].length };
    } else {
      const h = /^(#{2,3})[ \t]+(\S.*?)[ \t]*$/.exec(line);
      if (h) out.push({ level: h[1].length, title: h[2], start: pos, end });
      else comment = commentOpenAfter(line, false);
    }
    pos = end;
  }
  return out;
}

// The `##` sections among `after` named by the track list line in the next-up section's preamble
// (the text from `next` to the heading that follows it, `first`). `[]` when there is no such line.
function listedTracks(text, next, first, after) {
  const preamble = text.slice(next.end, first?.start ?? text.length);
  const line = /^(?:트랙|Tracks):[ \t]*(.+)$/m.exec(preamble);
  if (!line) return [];
  const items = line[1]
    .replace(/\.(?:\s.*)?$/, '')
    .split(/[·,/]/)
    .map((i) => i.trim())
    .filter(Boolean);
  const named = (title) =>
    items.some((i) => title.startsWith(i) && !/^[\p{L}\p{N}]/u.test(title.slice(i.length)));
  return after.filter((h) => h.level === 2 && named(h.title));
}

/**
 * Cut the track sections out of an old `session-state.md` (LF text): `{rest, tracks: [{id, title,
 * body}]}`, or `null` when no recognizable set of at least two tracks is there (the file then stays
 * one whole `legacy` head). Two shapes are recognized, both after a `## <next-up heading>` (see
 * NEXT_UP_HEADINGS):
 *   - that section holds `###` subsections: each `###` section is a track (the generator's own
 *     `## Next Up` and a hand-written one);
 *   - it holds none, but its preamble has a track list line (`트랙:` or `Tracks:`, items separated
 *     by `·`, `,` or `/`, the list ends at the first sentence end): each `##` section after it whose
 *     title starts with a listed item is a track. Any other `##` section (notes, "common" parts)
 *     stays in `rest`. Without a list line nothing is split, so a file that merely has several
 *     `##` sections is never read as having tracks.
 * A track's `title` is its heading text, `body` the text after the heading line up to the next
 * section boundary. `rest` is every byte outside the track bodies and heading lines, in file order
 * (frontmatter, preamble, the next-up heading itself, sections that are not tracks). Cutting
 * removes only the `##`/`###` marker run of each track heading, which the title does not repeat.
 * Ids are `legacy-<slug>-<h6>`: the slug is the ASCII part of the title, the hash covers the title
 * and its occurrence number (two sections with one title), so equal bytes give equal ids on any
 * machine and no id depends on a section's position.
 */
export function splitStateTracks(text) {
  const heads = headingLines(text);
  const at = heads.findIndex((h) => h.level === 2 && NEXT_UP_HEADINGS.includes(h.title));
  if (at === -1) return null;
  const after = heads.slice(at + 1);
  const nextTwo = after.findIndex((h) => h.level === 2);
  const inside = nextTwo === -1 ? after : after.slice(0, nextTwo);
  const sub = inside.filter((h) => h.level === 3);
  const picked = sub.length >= 2 ? sub : listedTracks(text, heads[at], heads[at + 1], after);
  // A track section stops at the next heading of its own or a higher level, else at the text end.
  const tracksFound = picked.map((h) => ({
    ...h,
    stop: heads.find((n) => n.start > h.start && n.level <= h.level)?.start ?? text.length,
  }));
  if (tracksFound.length < 2) return null;
  const seen = new Map();
  const tracks = tracksFound.map((h) => {
    const n = seen.get(h.title) ?? 0;
    seen.set(h.title, n + 1);
    const hash = createHash('sha256')
      .update(JSON.stringify([h.title, n]))
      .digest('hex')
      .slice(0, 6);
    const slug = h.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/g, '');
    return {
      id: `legacy-${slug ? `${slug}-` : ''}${hash}`,
      title: h.title,
      body: text.slice(h.end, h.stop),
      cut: [h.start, h.stop],
    };
  });
  let rest = '';
  let from = 0;
  for (const t of tracks) {
    rest += text.slice(from, t.cut[0]);
    from = t.cut[1];
  }
  rest += text.slice(from);
  return { rest, tracks: tracks.map(({ cut, ...t }) => t) };
}

// The id of a baseline: a hash of what it holds, so two machines with the same inputs write the same
// path and bytes. `content` is the old file's text (one `legacy` head) or, for a split file,
// `[rest, [[id, title, body]...]]`; the text form hashes exactly as it did before the split existed.
function baselineIdOf(kind, content, done, scope) {
  const h16 = createHash('sha256')
    .update(JSON.stringify([kind, content, done, scope]))
    .digest('hex')
    .slice(0, 16);
  return `baseline-${h16}`;
}

// The `done` part of a baseline id's input. An unsplit file hashes one flag (is `legacy` done); a
// split one (`splitIds`: the ids of its split-out tracks) hashes which of its own heads are done,
// `false` when none is. The writer and `baselineIdMismatch` both go through here.
function doneKeyOf(splitIds, doneIds) {
  if (!splitIds) return doneIds.has(LEGACY_TRACK_ID);
  const done = [LEGACY_TRACK_ID, ...splitIds].filter((id) => doneIds.has(id)).sort();
  return done.length ? done : false;
}

/**
 * The entry that stands in for ONE of a project's old files: `kind` `'hot'` is the old `hot.md`
 * (the entry's summary, no tracks), `'state'` the old `session-state.md` (an empty summary and one
 * `legacy` track whose body is the file; when the file has recognizable per-track sections, see
 * splitStateTracks, the `legacy` track keeps the text outside them and each track section is a
 * track of its own with its own id, so a close that replaces one track leaves the rest as heads).
 * Each file is its own entry so it carries its own
 * `visibilityScope`: a machine-scoped `hot.md` must not hide a shared `session-state.md`. The text
 * goes in whole, frontmatter included (`tags`, `related`, `machine_note` survive), with line
 * endings normalized to LF. A CRLF source would otherwise leave `\r` in a blob that
 * `.gitattributes` (`eol=lf`) rewrites on checkout, so the path would read as modified forever, and
 * a CRLF machine and an LF machine would hash the same content to different paths. Returns
 * `{kind, closeId, fileName, text}`. The id hashes the kind, the text (or its split form), which
 * heads are done (state only: `legacyDone` is `true` for the `legacy` head, or the ids of every
 * finished `legacy` and `legacy-*` track) and `visibilityScope`, so two machines with the same
 * inputs write the same path and bytes, the two files of one project never share an id, and inputs
 * that differ in any of those land on different paths instead of colliding.
 */
export function buildBaselineEntry({ kind, text, date, visibilityScope, project, legacyDone }) {
  if (kind !== 'hot' && kind !== 'state')
    throw fail('invalid-entry', `invalid baseline kind: ${kind}`);
  const body = (text ?? '').replace(/\r\n/g, '\n');
  const scope = visibilityScope || null;
  const split = kind === 'state' ? splitStateTracks(body) : null;
  // `legacyDone` is `true` (the `legacy` track only) or the ids of the old-scheme tracks that were
  // finished (`legacy` and `legacy-*`). A head is done only when its own id is in the set: finishing
  // the leftover `legacy` must not finish tracks that were split out of the same file.
  const doneIds =
    kind !== 'state' || !legacyDone
      ? new Set()
      : new Set(legacyDone === true ? [LEGACY_TRACK_ID] : legacyDone);
  const isDone = (id) => doneIds.has(id);
  const closeId = baselineIdOf(
    kind,
    split ? [split.rest, split.tracks.map((t) => [t.id, t.title, t.body])] : body,
    doneKeyOf(split ? split.tracks.map((t) => t.id) : null, doneIds),
    scope,
  );
  let tracks = [];
  let bodies = {};
  if (kind === 'state') {
    const heads = split
      ? [{ id: LEGACY_TRACK_ID, title: BASELINE_TITLE, body: split.rest }, ...split.tracks]
      : [{ id: LEGACY_TRACK_ID, title: BASELINE_TITLE, body }];
    tracks = heads.map((h) => ({
      id: h.id,
      title: h.title,
      new: true,
      ...(isDone(h.id) ? { done: true } : {}),
    }));
    bodies = Object.fromEntries(heads.map((h) => [h.id, h.body]));
  }
  const entry = formatSessionEntry({
    project,
    closeId,
    date,
    visibilityScope: scope,
    tracks,
    summary: kind === 'hot' ? body : '',
    bodies,
  });
  return { kind, closeId, fileName: entryFileName(date, closeId), text: entry };
}

/**
 * The baseline entries of one project's old files, hot first: `[{kind, closeId, fileName, text,
 * scope, conflict}]`. A file that is absent or empty gets no entry. `scopes` is `{index, hot,
 * state}`, the `visibility_scope` read from `index.md` and from each old file. Each entry takes the
 * narrower of the project's scope and ITS OWN file's, so one machine-scoped file hides only its
 * own entry. `conflict` is `narrowestVisibilityScope`'s: the two values name different machines,
 * the entry is `machine:` and visible nowhere. One `date` for both keeps them on one day.
 */
export function buildLegacyBaselines({ hotText, stateText, date, project, scopes, legacyDone }) {
  const files = [
    { kind: 'hot', text: hotText, scope: scopes?.hot },
    { kind: 'state', text: stateText, scope: scopes?.state },
  ];
  return files
    .filter((f) => typeof f.text === 'string' && f.text !== '')
    .map((f) => {
      const { scope, conflict } = narrowestVisibilityScope([scopes?.index, f.scope]);
      const built = buildBaselineEntry({
        kind: f.kind,
        text: f.text,
        date,
        visibilityScope: scope,
        project,
        legacyDone,
      });
      return { ...built, scope, conflict };
    });
}

/**
 * Whether a baseline entry file still names its own content. `fileName` is the file's base name
 * and `text` its bytes. The id in a baseline's name is a hash of the kind, body (a split state
 * file hashes its parts, see splitStateTracks), `done` flag and scope, so a baseline whose bytes changed after it was written (git pairs it with the old file it
 * was cut from as a rename and merges a later edit of that file into it) no longer matches its
 * name. Returns `null` when the name and the entry's own id both equal the hash of the content (or
 * the file is not a readable baseline), else `{expected, inName, inEntry}` (the ids as `baseline-<h16>`).
 */
export function baselineIdMismatch(fileName, text) {
  const parsed = parseSessionEntry(text);
  if (!parsed.ok || !isBaselineId(parsed.entry.closeId)) return null;
  const e = parsed.entry;
  const legacy = e.tracks.find((t) => t.id === LEGACY_TRACK_ID);
  const others = e.tracks.filter((t) => t.id !== LEGACY_TRACK_ID);
  const kind = legacy ? 'state' : 'hot';
  let content = e.summary;
  if (legacy) {
    const own = e.bodies[LEGACY_TRACK_ID] ?? '';
    content = others.length
      ? [own, others.map((t) => [t.id, t.title ?? '', e.bodies[t.id] ?? ''])]
      : own;
  }
  const doneIds = new Set(e.tracks.filter((t) => t.done === true).map((t) => t.id));
  const doneKey = legacy
    ? doneKeyOf(others.length ? others.map((t) => t.id) : null, doneIds)
    : false;
  const expected = baselineIdOf(kind, content, doneKey, e.visibilityScope || null);
  const inName = /-(baseline-[0-9a-f]{16})\.md$/.exec(fileName)?.[1] ?? null;
  if (expected === e.closeId && expected === inName) return null;
  return { expected, inName, inEntry: e.closeId };
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

// The lines `lines` appends after `base`, or null unless `lines` starts with every base line, in
// order, unchanged. Only a tail addition counts: a line inserted in the middle would move the lines
// after it, and `.gitignore` order decides how `!` rules read.
function addedLines(base, lines) {
  if (lines.length < base.length || base.some((line, i) => lines[i] !== line)) return null;
  return lines.slice(base.length);
}

/**
 * Merge two `.gitignore` edits of one base when both only appended lines. `{ok: true, merged}`
 * (theirs' bytes, then the lines `ours` added, in order) or `{ok: false, reason}`. It refuses a
 * removed, reordered or middle-inserted base line on either side, and a `!` line added on EITHER
 * side: a negation depends on where it sits among the other patterns, and appending reorders them.
 * A line `ours` appended counts as already there only when theirs ALSO appended it: a repeat of a
 * base line is kept, because appended after a base `!` rule it re-ignores what that rule let
 * through. Every added line is a plain pattern placed after the whole base, so their order among
 * themselves changes nothing and an identical pair collapses to one.
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
  const seen = new Set(theirsAdded);
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

/**
 * A `projects/` child that is a session project: a vault slug (`isValidProjectName`, the rule an entry's
 * `project:` uses), has `index.md` or `sessions/`, not `_template`.
 */
export function isSessionProjectDir({ slug, hasIndex, hasSessions }) {
  return (
    typeof slug === 'string' &&
    isValidProjectName(slug) &&
    slug !== '_template' &&
    !!(hasIndex || hasSessions)
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

/** A baseline entry (real or virtual) stands for the old `hot.md` or the old `session-state.md`. */
export const isBaselineId = (closeId) => closeId.startsWith('baseline-');

// The state baseline holds the old `session-state.md` as a track body and has no summary. It has no
// place among the session summaries, which would show an empty `### <date> · baseline-...` block.
const hasSummary = (entry) => !isBaselineId(entry.closeId) || entry.summary !== '';

const supersededIdsOf = (entry) => entry.tracks.flatMap((t) => t.supersedes ?? []);

/**
 * Entries newest first: `date` descending, then `closedAt` descending (the close's write time; an
 * entry with one sorts before an entry of the same day without one, since only older entries and
 * baselines lack it), then supersede depth descending (1 + the deepest entry it replaces, so a
 * same-day replacement sorts before what it replaced), then close id ascending. Depth only breaks
 * ties now: ranked first it kept a deep chain of one track ahead of a later close of another. A new
 * array; never reads the clock.
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
  // Parsed once per entry; `null` sorts after every real time. Compared as instants, not strings:
  // `...07Z` and `...07.123Z` differ in length, so the text order is not the time order.
  const closedMs = new Map(
    entries.map((e) => [e.closeId, e.closedAt ? Date.parse(e.closedAt) : null]),
  );
  const byClosedAt = (a, b) => {
    const x = closedMs.get(a.closeId);
    const y = closedMs.get(b.closeId);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  };
  return [...entries].sort(
    (a, b) =>
      cmp(b.date, a.date) ||
      byClosedAt(a, b) ||
      depthOf(b) - depthOf(a) ||
      cmp(a.closeId, b.closeId),
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

/**
 * Whether `device` may see one session entry of `model`. A string `model.entryScope` (the
 * project's `entry_scope`) replaces every entry's own `visibility_scope`: it is the human-written
 * key that reopens entries a machine scope closed. Without one, the entry's own scope decides.
 * The one place the two scopes meet.
 */
export function entryVisible(model, entry, device) {
  if (typeof model.entryScope === 'string') return scopeVisible(model.entryScope, device);
  return scopeVisible(entry.visibilityScope, device);
}

// Everything the renderers and the injection share: the entries this machine may see (a hidden
// entry is treated as absent, so it cannot replace a visible one), newest first, and the active
// and finished tracks. Visibility is `entryVisible`: `entry_scope` when set, else the entry's own scope.
function projectView(model, device) {
  const entries = sortEntries(model.entries.filter((e) => entryVisible(model, e, device)));
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
  const summarized = view.entries.filter(hasSummary);
  const recent = summarized.slice(0, RECENT_SUMMARIES);
  const older = summarized.slice(RECENT_SUMMARIES, RECENT_SUMMARIES + OLDER_LINKS);
  const rest = summarized.length - recent.length - older.length;
  const slug = model.project;
  const blocks = [
    `---\ntype: reference\ntitle: "hot: ${slug}"\nupdated: ${view.entries[0]?.date ?? ''}\ngenerated: sessions\n---`,
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
  const sums = view.entries
    .filter(hasSummary)
    .slice(0, RECENT_SUMMARIES)
    .map((entry) => {
      const { frontmatter, body } = summaryParts(entry);
      const text = joinBlocks([
        `### ${entry.date} · ${entry.closeId}`,
        frontmatter === null ? null : yamlFence(frontmatter),
        body,
      ]);
      return { text, on: false };
    });
  // The note carries its own `visibility_scope`: another machine's note is not this machine's context.
  const notesVisible = model.notes && scopeVisible(model.notesScope, device);
  const notes = { text: notesVisible ? `## Project notes\n\n${model.notes}` : null, on: false };

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
