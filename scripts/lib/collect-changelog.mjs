// collect-changelog.mjs (lib): pure helpers for the semi-automatic changelog
// collector. The CLI (scripts/collect-changelog.mjs) does the git/gh I/O; this
// module is side-effect free so the parsing and assembly logic is unit-tested
// offline. Classification is delegated to changelog-classify.mjs (the single
// source shared with the linter, sanitizer, and the migration fixture).
//
// Format target (docs/CONTRIBUTING.md "CHANGELOG conventions"):
// - gated sections New Features / Bug Fixes / Chores, each `#### English` then
//   `#### 한국어`, fed from each PR's `## Changelog` block (one EN, one KO line).
// - a language-neutral `### Changelog` index: `- [#N](<pr-url>) <short title>`
//   lines (the PR number linked to its GitHub PR when the repository URL is
//   known, else a bare `#N`) plus one de-duplicated `Contributors:` line. No
//   per-line @handle, no tracker ids on the surface.

import {
  classifyChange,
  sanitizeTrackerIds,
  SECTION,
  SECTION_TITLE,
} from './changelog-classify.mjs';

// Derive the `…/pull` base URL for inline PR links from a package.json
// repository URL (`https://github.com/owner/repo.git`, `git+https://…`, or the
// `git@github.com:owner/repo.git` SSH form). Returns null when the URL is absent
// or unrecognized, so the caller falls back to a bare `#N` rather than emitting a
// broken link. A trailing `.git` and any trailing slash are dropped.
export function repoUrlToPrBase(repoUrl) {
  const s = String(repoUrl ?? '').trim();
  // Anchor on the host so `https://example.com/github.com/o/r.git` is not
  // mistaken for GitHub, and require owner/repo to be the whole path so a
  // `…/owner/repo/issues` URL declines (no `/issues/pull` base) rather than
  // producing a wrong link. Accepts https, git+https, ssh://git@, and scp-style
  // git@ forms; a trailing `.git` and slash are optional.
  const m =
    /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      s,
    );
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/pull`;
}

// Render a PR number as an inline markdown link when a pull base URL is known,
// else a bare `#N` (offline unit tests, missing repo metadata). The `#N` text is
// preserved either way so a reader sees the same token, linked or not.
export function prRef(pr, prUrlBase) {
  return prUrlBase ? `[#${pr}](${prUrlBase}/${pr})` : `#${pr}`;
}

// A GitHub merge-commit subject (`Merge pull request #N from owner/branch`) is
// boilerplate, so classifying it by subject would always fall through to Chores.
// Detect it so the caller classifies from the commit BODY (which carries the PR
// title) instead. Squash-merge subjects are normal Conventional-Commit titles
// and are NOT boilerplate.
export function isMergeBoilerplate(subject) {
  return /^Merge pull request #\d+\b/.test(String(subject ?? ''));
}

// Parse a PR number from a commit subject. Squash-merge: a TRAILING `(#123)`
// only. A `(#12)` mid-sentence (e.g. prose about a placeholder) is not a PR
// reference and must not promote a direct-push commit to a fake PR.
// Merge-commit: `Merge pull request #123 from ...`. Returns an integer or null.
export function parsePrNumber(subject) {
  const s = String(subject ?? '');
  const merge = /^Merge pull request #(\d+)\b/.exec(s);
  if (merge) return Number(merge[1]);
  const trailing = /\(#(\d+)\)\s*$/.exec(s);
  if (trailing) return Number(trailing[1]);
  return null;
}

// Build the `### Changelog` index title from a commit subject: drop a single
// trailing `(#N)` (the index already prints `#N`, so repeating it duplicates),
// then sanitize tracker ids off the public surface. Returns the cleaned title.
export function normalizeIndexTitle(subject) {
  const stripped = String(subject ?? '')
    .trim()
    .replace(/\s*\(#\d+\)\s*$/, '');
  return sanitizeTrackerIds(stripped).trim();
}

// Parse a PR body's `## Changelog` block. Returns one of:
//   { en, ko }              both present and non-empty
//   'none'                  literal `None` (no gated body entry; still indexed)
//   null                    the `## Changelog` heading is absent
//   { malformed, reason }   present but invalid (missing EN/KO, empty value,
//                           duplicate line, or None mixed with EN/KO)
// HTML comments (the template's instructions) are stripped before parsing.
export function parseChangelogBlock(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Changelog\s*$/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null; // heading absent

  // Collect the section body until the next `## ` heading or EOF, with HTML
  // comments removed (they may span multiple lines).
  const body_lines = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) break;
    body_lines.push(lines[i]);
  }
  const cleaned = body_lines.join('\n').replace(/<!--[\s\S]*?-->/g, '');

  const enLines = [];
  const koLines = [];
  let noneSeen = false;
  for (const raw of cleaned.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const en = /^-?\s*EN\s*:\s*(.*)$/i.exec(line);
    const ko = /^-?\s*KO\s*:\s*(.*)$/i.exec(line);
    if (en) {
      enLines.push(en[1].trim());
    } else if (ko) {
      koLines.push(ko[1].trim());
    } else if (/^-?\s*None\s*$/i.test(line)) {
      noneSeen = true;
    }
    // other prose lines are tolerated and ignored
  }

  if (noneSeen && (enLines.length || koLines.length)) {
    return { malformed: true, reason: 'None mixed with EN/KO lines' };
  }
  if (noneSeen) return 'none';
  if (enLines.length > 1 || koLines.length > 1) {
    return { malformed: true, reason: 'duplicate EN or KO line' };
  }
  if (enLines.length === 0 && koLines.length === 0) {
    return { malformed: true, reason: 'empty Changelog block (no EN/KO/None)' };
  }
  if (enLines.length === 0 || !enLines[0]) {
    return { malformed: true, reason: 'missing or empty EN line' };
  }
  if (koLines.length === 0 || !koLines[0]) {
    return { malformed: true, reason: 'missing or empty KO line' };
  }
  return { en: enLines[0], ko: koLines[0] };
}

// Assemble classified, API-enriched entries into a structured draft. Pure: takes
// the already-collected entry list, returns sections + index + contributors +
// unresolved. An entry shape:
//   { pr, subject, titleSource, section, basis, author, handle, block }
// where block is { en, ko } | 'none' | null | { malformed }. Only an entry with
// a usable { en, ko } block contributes a gated body line; every entry with a PR
// number still appears in the index. `titleSource` is what the index title is
// built from (the merge-commit body line, or the squash subject) so a merge
// commit is never indexed as its `Merge pull request #N from ...` boilerplate.
//
// Contributors hold ONLY verified GitHub handles (from the API). A commit author
// name is NOT a GitHub handle, so an entry with a PR but no resolved handle goes
// to `unresolved` (the caller emits a manual-fill TODO) rather than being
// rendered as a fake `@name`.
export function assembleSections(entries, { prUrlBase = null } = {}) {
  const sections = {
    [SECTION.NEW_FEATURES]: { en: [], ko: [] },
    [SECTION.BUG_FIXES]: { en: [], ko: [] },
    [SECTION.CHORES]: { en: [], ko: [] },
  };
  const index = [];
  const contributors = [];
  const unresolved = [];
  const seenHandles = new Set();
  const seenUnresolved = new Set();

  for (const e of entries) {
    const block = e.block;
    if (block && typeof block === 'object' && block.en && block.ko) {
      const bucket = sections[e.section] || sections[SECTION.CHORES];
      const pr = e.pr != null ? ` (${prRef(e.pr, prUrlBase)})` : '';
      bucket.en.push(`- ${sanitizeTrackerIds(block.en)}${pr}`);
      bucket.ko.push(`- ${sanitizeTrackerIds(block.ko)}${pr}`);
    }
    if (e.pr != null) {
      index.push({ pr: e.pr, title: normalizeIndexTitle(e.titleSource ?? e.subject) });
      if (e.handle) {
        if (!seenHandles.has(e.handle)) {
          seenHandles.add(e.handle);
          contributors.push(e.handle);
        }
      } else if (e.author && !seenUnresolved.has(e.author)) {
        seenUnresolved.add(e.author);
        unresolved.push(e.author);
      }
    }
  }
  return { sections, index, contributors, unresolved, prUrlBase };
}

// Render an assembled draft to CHANGELOG markdown (the maintainer pastes it,
// adds Highlights, and edits wording). Empty gated sections are omitted; the
// index is always present when there is at least one PR. Contributors lists
// verified @handles; authors without a resolved handle become a manual-fill TODO
// rather than a fabricated `@name`.
export function renderDraft(assembled, { headingLevel = '###' } = {}) {
  const out = [];
  const order = [SECTION.NEW_FEATURES, SECTION.BUG_FIXES, SECTION.CHORES];
  for (const key of order) {
    const sec = assembled.sections[key];
    if (!sec || (sec.en.length === 0 && sec.ko.length === 0)) continue;
    out.push(`${headingLevel} ${SECTION_TITLE[key]}`);
    out.push('#### English');
    out.push(...sec.en);
    out.push('#### 한국어');
    out.push(...sec.ko);
    out.push('');
  }
  if (assembled.index.length) {
    out.push(`${headingLevel} Changelog`);
    for (const it of assembled.index) {
      out.push(`- ${prRef(it.pr, assembled.prUrlBase)} ${it.title}`.trimEnd());
    }
    if (assembled.contributors.length) {
      out.push(
        `Contributors: ${assembled.contributors.map((h) => (h.startsWith('@') ? h : `@${h}`)).join(', ')}`,
      );
    }
    if (assembled.unresolved && assembled.unresolved.length) {
      out.push(`<!-- TODO: add @handle for: ${assembled.unresolved.join(', ')} -->`);
    }
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
