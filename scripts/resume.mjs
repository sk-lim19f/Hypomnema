#!/usr/bin/env node
/**
 * Hypomnema resume script
 *
 * Reads the session-state.md for a project and outputs the next-tasks section.
 * Used by /hypo:resume to surface what was left off before Claude continues.
 *
 * Usage:
 *   node scripts/resume.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>     Hypomnema root. When omitted, resolveHypoRoot()
 *                         (see lib/hypo-root.mjs) resolves it in priority order:
 *                           1. $HYPO_DIR if set — returned immediately; the
 *                              hypo-config.md scan below is then skipped.
 *                           2. else the first of 7 fixed candidates
 *                              (~/{hypomnema,wiki,notes,knowledge},
 *                              ~/Documents/{hypomnema,wiki,notes}) that contains
 *                              a hypo-config.md marker.
 *                           3. else the default ~/hypomnema.
 *   --project=<name>      Project name. When omitted, resolveActiveProject()
 *                         prefers the project whose working_dir contains the
 *                         current directory (cwd-first), and only falls back to
 *                         the most recently active hot.md row when nothing under
 *                         cwd matches.
 *   --json                Output as JSON
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';
import { pickProjectByCwd, collectProjectWorkingDirs } from './lib/wd-match.mjs';
import {
  currentDevice,
  scopeVisible,
  readVisibilityScope,
  sanitizeProjForPrompt,
} from '../hooks/hypo-shared.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { hypoDir: null, project: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--project=')) args.project = arg.slice(10);
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  return args;
}

// ── active project from hot.md ───────────────────────────────────────────────

// Parse a single frontmatter scalar (mirrors the hook helpers in
// hypo-session-start.mjs / hypo-cwd-change.mjs — kept local per the hook
// self-contained convention rather than shared, to avoid script↔hook coupling).
function parseFrontmatterField(content, key) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const line = m[1].split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

// Return the project (among `slugs`) that owns cwd: a longest-prefix
// working_dir match, or — when no absolute path matches because the vault was
// synced from another machine — a cwd ancestor whose directory name is a
// globally-unique project basename. Uniqueness is judged over EVERY project on
// disk (not just `slugs`), so a shared dirname declines and falls back to
// recency. resume gives this authority over recency: a cwd↔project match wins
// regardless of which hot.md row is newest.
function pickByCwd(hypoDir, slugs, cwd) {
  if (!cwd) return null;
  let realpathCwd = null;
  try {
    realpathCwd = realpathSync(cwd);
  } catch {
    realpathCwd = null;
  }
  return pickProjectByCwd(collectProjectWorkingDirs(hypoDir), cwd, {
    eligible: slugs,
    realpathCwd,
  });
}

// When cwd is set but no project's working_dir matches it, resume falls back to
// recency silently — the user lands in an unrelated project with no clue why.
// Emit a one-line stderr diagnostic (stdout `Project:`/`--json` contract is untouched)
// naming why each candidate failed: missing index.md, missing working_dir, or a
// working_dir that simply doesn't contain cwd. Logic mirrors pickByCwd's lookup.
function warnCwdFallback(hypoDir, slugs, cwd) {
  // No cwd, or no candidate rows at all (fresh-init / no real project): there is
  // nothing to "fall back to most-recent" toward, so stay silent — the caller
  // surfaces the real "no active project found" error instead.
  if (!cwd || slugs.length === 0) return;
  const reasons = [];
  for (const slug of slugs) {
    const indexPath = join(hypoDir, 'projects', slug, 'index.md');
    if (!existsSync(indexPath)) {
      reasons.push(`${slug} (no index.md)`);
      continue;
    }
    const wd = parseFrontmatterField(readFileSync(indexPath, 'utf-8'), 'working_dir');
    if (!wd) reasons.push(`${slug} (no working_dir)`);
    // else: has working_dir but didn't contain cwd — expected, not flagged.
  }
  const detail = reasons.length ? ` Candidates missing cwd metadata: ${reasons.join(', ')}.` : '';
  process.stderr.write(
    `note: cwd "${cwd}" matched no project working_dir; falling back to most-recent.${detail}\n`,
  );
}

function resolveActiveProject(hypoDir, cwd = null) {
  const hotPath = join(hypoDir, 'hot.md');
  if (!existsSync(hotPath)) return null;

  // Strip HTML comments before parsing so the canonical-format example row
  // in templates/hot.md (`<!-- Row format: ... -->`) is not picked up as data.
  const content = readFileSync(hotPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
  // Canonical hot.md uses wikilinks: | name | date | [[projects/slug/hot]] |
  // Pick the most recent row by the date column when present.
  const wikiRows = [
    ...content.matchAll(
      /\|\s*([^|]+?)\s*\|\s*(\d{4}-\d{2}-\d{2})?\s*\|\s*\[\[projects\/([^\]/]+)\/[^\]]+\]\]/g,
    ),
  ].map((m) => ({ name: m[1].trim(), date: m[2] || '', slug: m[3] }));
  if (wikiRows.length > 0) {
    // cwd-first: a cwd↔working_dir match wins over recency, across
    // ALL rows (not just a same-date tie). The user is physically in that
    // project, so cwd is a stronger intent signal than "some other project was
    // touched more recently". This reverses the earlier tie-breaker-only
    // semantics now that resume=cwd-positive. Tradeoff: a stale cwd
    // match can mask a genuinely newer project; `--project` overrides. close
    // callers pass null → recency path below (resume=cwd-positive / close=no-pick).
    if (cwd) {
      const picked = pickByCwd(
        hypoDir,
        wikiRows.map((r) => r.slug),
        cwd,
      );
      if (picked) return picked;
    }
    // No cwd match → most recent by date (stable-sort keeps the first table row
    // on a tie, the legacy behavior).
    if (cwd)
      warnCwdFallback(
        hypoDir,
        wikiRows.map((r) => r.slug),
        cwd,
      );
    wikiRows.sort((a, b) => b.date.localeCompare(a.date));
    return wikiRows[0].slug;
  }
  // Legacy markdown-link rows: | [name](projects/name/...) | ...
  const mdSlugs = [...content.matchAll(/\|\s*\[([^\]]+)\]\(projects\/([^/)]+)/g)].map((m) => m[2]);
  if (mdSlugs.length > 0) {
    if (cwd) {
      const picked = pickByCwd(hypoDir, mdSlugs, cwd);
      if (picked) return picked;
      warnCwdFallback(hypoDir, mdSlugs, cwd);
    }
    return mdSlugs[0]; // legacy: first table row
  }

  // fallback: a cwd-matched project, else the most recently modified one with a
  // session-state.md. (mtime is only a heuristic once hot.md can't name a
  // project — an explicit working_dir match is safer, so cwd-first here too.)
  const projectsDir = join(hypoDir, 'projects');
  if (!existsSync(projectsDir)) return null;

  // Skip the scaffold project init.mjs writes — it isn't a real active project.
  const candidates = readdirSync(projectsDir).filter(
    (p) => p !== '_template' && existsSync(join(projectsDir, p, 'session-state.md')),
  );
  if (cwd) {
    const picked = pickByCwd(hypoDir, candidates, cwd);
    if (picked) return picked;
    warnCwdFallback(hypoDir, candidates, cwd);
  }
  let latest = null;
  let latestMtime = 0;
  for (const p of candidates) {
    const mtime = statSync(join(projectsDir, p, 'session-state.md')).mtimeMs;
    if (mtime > latestMtime) {
      latestMtime = mtime;
      latest = p;
    }
  }
  return latest;
}

// ── foreign-project uncommitted notice ──────────────────────────────────────
// resume is a bare CLI script (invoked from a slash command via bash) and
// never receives a session_id or transcript, so unlike the SessionStart hook
// it has no accountable-scope to compare against. It always has a resolved
// `project` by the time this runs (the caller exits earlier when none is
// found), so that resolved project stands in as "own project" here.

const FOREIGN_GIT_TIMEOUT_MS = 5000;
// Cap on how many foreign project names the notice spells out. Past this the
// rest collapse into a count, so one session cannot grow the prompt by however
// many projects are dirty.
const FOREIGN_NAME_CAP = 5;

/** `projects/<slug>/...` → `<slug>`; everything else → null. `null` here does
 * not mean "not one project's work": the caller below folds every non-null
 * hit into a per-name foreign count and every null hit into a nameless
 * "unattributed" count, and both feed the same notice. Local duplicate of
 * hypo-shared.mjs's private (non-exported) `projectOfPath`. Not the same
 * classification as hypo-auto-commit.mjs's commit-message counter (also in
 * hypo-shared.mjs): that one folds a non-`projects/` path to its first path
 * segment (`extensions`, `hot.md`, ...) for a "(N paths across M projects)"
 * tally; this one folds it to `null` because attribution, not tallying, is
 * the job here. A top-level segment is not a project name, and this notice
 * must not present it as one.
 */
function projectOfPath(relPath) {
  const parts = relPath.split('/');
  return parts[0] === 'projects' && parts.length > 1 && parts[1] ? parts[1] : null;
}

/** Vault-relative dirty paths (tracked + untracked), normalized to be
 * relative to `hypoDir` itself via `git rev-parse --show-prefix` (empty when
 * `hypoDir` IS the repo top level), the same normalization
 * hypo-shared.mjs's `gitDirtyFiles` applies for staging correctness: without
 * it, a vault nested under a larger host repo reports paths relative to that
 * repo's top level, and every one of them would fail to classify as this
 * vault's own. NUL-separated porcelain so Korean project/page names survive
 * intact. Local duplicate of hypo-shared.mjs's private `gitDirtyFiles`: this
 * caller also re-attributes a rename/copy's `from` path (codex 3rd-round
 * review follow-up), the same as that caller does for staging
 * correctness, so a rename OUT of a foreign project is not silently lost
 * just because its destination happens to land under `ownProject`.
 *
 * Returns `null`, not `[]`, on any git failure (repo missing, `rev-parse` or
 * `status` non-zero, or a timeout): folding "cannot enumerate" into the same
 * empty array a truly clean repo returns would render the two identically,
 * which is the silent failure this notice exists to catch (mirrors
 * `gitDirtyFiles`'s own contract: "an empty return here just means 'cannot
 * attribute', not 'clean'"). A clean repo returns `[]`.
 */
function listDirtyPaths(hypoDir) {
  const prefixRes = spawnSync('git', ['-C', hypoDir, 'rev-parse', '--show-prefix'], {
    encoding: 'utf-8',
    timeout: FOREIGN_GIT_TIMEOUT_MS,
  });
  if (prefixRes.status !== 0) return null;
  // trimEnd(), not trim(): the prefix is a real path segment, and a leading
  // space or control char in a directory name is valid there. trim() would
  // strip it off the front, so the stripped prefix no longer matches the
  // (untouched) start of every path `git status` reports, and every path
  // under that directory would wrongly read as "outside the vault" (the
  // notice going silent for exactly the same reason a missing rename `from`
  // does below). Only the trailing `\n` `--show-prefix` always appends needs
  // stripping.
  const prefix = (prefixRes.stdout || '').trimEnd();

  const r = spawnSync('git', ['-C', hypoDir, 'status', '--porcelain', '-uall', '-z'], {
    encoding: 'utf-8',
    timeout: FOREIGN_GIT_TIMEOUT_MS,
  });
  if (r.status !== 0) return null;
  const out = [];
  const records = (r.stdout || '').split('\0');
  const toVaultRelative = (f) => {
    if (!f) return null;
    if (!prefix) return f; // hypoDir IS the repo top level, nothing to strip
    return f.startsWith(prefix) ? f.slice(prefix.length) : null; // outside the vault
  };
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const file = rec.slice(3); // destination path for a rename/copy
    const isRenameOrCopy = xy[0] === 'R' || xy[1] === 'R' || xy[0] === 'C' || xy[1] === 'C';
    // A rename/copy emits a paired `to\0from` record. Attribute BOTH: the
    // origin project lost a file just as surely as the destination gained
    // one, and dropping `from` (as this used to) silently loses that origin
    // whenever it differs from the destination's project (a rename INTO
    // ownProject from a foreign one would otherwise vanish entirely). One
    // rename/copy is therefore counted as up to 2 dirty paths, inflating
    // foreignCount/unattributedCount by one per cross-project rename; the
    // name Set below still de-dupes, so the project NAME list does not grow.
    let fromFile = null;
    if (isRenameOrCopy) {
      i++;
      fromFile = records[i] || null;
    }
    const rel = toVaultRelative(file);
    if (rel) out.push(rel);
    const relFrom = toVaultRelative(fromFile);
    if (relFrom) out.push(relFrom);
  }
  return out;
}

/** One-line notice covering two counts: uncommitted paths under a named
 * project other than `ownProject` (`projects/<slug>/...`), and uncommitted
 * paths this classifier cannot attribute to any project at all (everything
 * else, root vault infra, `extensions/`, `_specs/`, ...). This is
 * attribution, not narrowing, so the unattributed bucket is surfaced with a
 * count rather than silently dropped just because it has no project name to
 * show. '' only when enumeration succeeded and both counts are zero, so the
 * quiet path stays quiet exactly there. A `null` from `listDirtyPaths`
 * (enumeration failed) gets its own distinct line instead: the caller must
 * not read "could not tell" as "nothing foreign".
 */
function foreignUncommittedNotice(hypoDir, ownProject) {
  const dirty = listDirtyPaths(hypoDir);
  if (dirty === null) {
    return '[WIKI: 미커밋 변경의 귀속을 확인하지 못했습니다. git 상태를 근거로 작업 범위를 정하지 마십시오.]';
  }
  const foreignProjects = new Set();
  let foreignCount = 0;
  let unattributedCount = 0;
  for (const f of dirty) {
    const slug = projectOfPath(f);
    if (slug === ownProject) continue;
    if (slug) {
      foreignProjects.add(slug);
      foreignCount++;
    } else {
      unattributedCount++;
    }
  }
  if (foreignCount === 0 && unattributedCount === 0) return '';
  const clauses = [];
  if (foreignCount > 0) {
    // The slug comes from a directory name in `git status` output, so it is
    // untrusted text on its way into a prompt. sanitizeProjForPrompt is the same
    // guard the hot-cache notices in this file already use; skipping it here would
    // let a newline or a control char in a project directory name break the
    // one-line notice apart and inject into the surrounding context. The name list
    // is also capped, because an unbounded one grows the context by however many
    // projects happen to be dirty.
    const all = [...foreignProjects].sort();
    const shown = all.slice(0, FOREIGN_NAME_CAP).map((s) => `projects/${sanitizeProjForPrompt(s)}`);
    const names =
      all.length > FOREIGN_NAME_CAP
        ? `${shown.join(', ')} 외 ${all.length - FOREIGN_NAME_CAP}개`
        : shown.join(', ');
    clauses.push(`현재 프로젝트 외 ${names} 변경 ${foreignCount}건`);
  }
  if (unattributedCount > 0) clauses.push(`귀속 불명 변경 ${unattributedCount}건`);
  return `[WIKI: ${clauses.join(', ')}이 있습니다. 사용자 명시 지시 없이는 이 세션 작업으로 편입하지 마십시오.]`;
}

// ── read session state ────────────────────────────────────────────────────────

// Visibility guard: same contract as hypo-file-watch / hypo-session-start /
// hypo-cwd-change. A machine-scoped page (visibility_scope: machine:<owner>) is
// not surfaced on any machine but its owner, and /hypo:resume feeds its stdout
// straight into the model, so it is one of those injection paths.
//
// `hidden` is kept distinct from "file absent" on purpose: reporting a scoped-out
// state file as "no session-state.md found" would read as a broken vault. The
// caller says which one it was.
function readVisible(path, device) {
  if (!existsSync(path)) return { content: null, hidden: false };
  const raw = readFileSync(path, 'utf-8');
  if (!scopeVisible(readVisibilityScope(raw), device)) return { content: null, hidden: true };
  return { content: raw, hidden: false };
}

function readSessionState(hypoDir, project, device) {
  return readVisible(join(hypoDir, 'projects', project, 'session-state.md'), device);
}

function readHot(hypoDir, project, device) {
  return readVisible(join(hypoDir, 'projects', project, 'hot.md'), device);
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

const project = args.project || resolveActiveProject(args.hypoDir, process.cwd());

if (!project) {
  console.error('Error: no active project found. Use --project=<name> or create a hot.md entry.');
  process.exit(1);
}

const foreignNotice = foreignUncommittedNotice(args.hypoDir, project);
const device = currentDevice();

const state = readSessionState(args.hypoDir, project, device);
if (!state.content) {
  if (state.hidden) {
    console.error(
      `Error: session-state.md for "${project}" is scoped to another machine ` +
        `(visibility_scope). Nothing to resume on this machine (${device}).`,
    );
  } else {
    console.error(`Error: no session-state.md found for project "${project}"`);
  }
  process.exit(1);
}
const sessionState = state.content;

const hotContent = readHot(args.hypoDir, project, device).content;

if (args.json) {
  console.log(
    JSON.stringify(
      {
        project,
        sessionState,
        hot: hotContent,
        ...(foreignNotice ? { notice: foreignNotice } : {}),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (foreignNotice) console.log(foreignNotice + '\n');
console.log(`Project: ${project}`);
console.log(`State: projects/${project}/session-state.md\n`);
console.log('─'.repeat(60));
console.log(sessionState.trim());

if (hotContent) {
  console.log('\n' + '─'.repeat(60));
  console.log('Background (hot.md):');
  console.log(hotContent.trim());
}
