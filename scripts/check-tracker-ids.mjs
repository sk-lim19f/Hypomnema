#!/usr/bin/env node
/**
 * check-tracker-ids.mjs — CLI gate: no wiki-internal tracker IDs (ISSUE-N,
 * fix #N, FEAT-N, IMPR-N, PRAC-N) in OSS-public artifacts.
 *
 * Rule source: CLAUDE.md learned_behaviors (no-internal-tracker-ids-in-oss-
 * artifacts, 2026-06-09). The repo ships through npm + a Claude Code plugin;
 * an `ISSUE-N` / `fix #N` / `FEAT-N` / `IMPR-N` / `PRAC-N` in any shipped file or
 * in README/CHANGELOG is a dangling pointer into the maintainer's PRIVATE wiki
 * tracker. GitHub refs (`PR #N`, `(#N)`, `#N`, issue URLs) are legitimate and
 * never flagged.
 *
 * Modes:
 *   --all (default)        Walk the public-artifact scope and scan every text
 *                          file. Wired into npm `prepublishOnly` and CI.
 *   --staged               Scan the STAGED blob of every in-scope file in the
 *                          index (git show :path), mirroring the pre-commit
 *                          formatter's name-status/-z/diff-filter plumbing so
 *                          deletes, type-changes, symlinks and submodules are
 *                          skipped. Used by the pre-commit hook.
 *   --commit-msg <file>    Scan a commit message for tracker ids AND for tool-
 *                          attribution trailers (ATTRIBUTION_PATTERNS: the
 *                          harness system prompt instructs the agent to append a
 *                          `Co-Authored-By:` / `Claude-Session:` trailer that
 *                          this repo bans, and 8 of 47 post-ban commits carried
 *                          one to main). Drops the --verbose scissors diff, then
 *                          strips comment lines ONLY when git added its template
 *                          (editor/strip mode); for `commit -m` / whitespace /
 *                          verbatim (no template) it scans comment lines too,
 *                          since git keeps them. Used by the commit-msg hook,
 *                          which is FAST FEEDBACK, not a guarantee: the hook
 *                          installer fails open at every guard (and --no-verify
 *                          skips it outright), so CI is the real gate.
 *   --commit-range <a..b>  CI backstop for the exact gap above: the commit-msg
 *                          hook fails open on tooling problems and is bypassable
 *                          with --no-verify, so a trailer can reach `main` on a
 *                          commit while the PR body itself stays clean (this
 *                          shipped 8 times). Scans every commit message in range
 *                          `a..b` (`git log --format=%B`) with judgeMessage() —
 *                          the SAME function --commit-msg uses on a single
 *                          message — so the two entry points can never disagree
 *                          about what counts as a violation (one judgment, not
 *                          two — a duplicated judgment drifts). Wired into the
 *                          pr-surface CI job, which checks out with
 *                          fetch-depth:0 so `a..b` resolves against the PR's
 *                          base/head SHAs.
 *   --push-range <a..b>    The gap --commit-range still leaves open: this repo
 *                          SQUASH-merges, so the message that actually lands on
 *                          `main` is written in the merge dialog and never
 *                          existed on the PR branch — it was never inside
 *                          base.sha..head.sha, and every check stayed green. Runs
 *                          on the `push` to main over
 *                          github.event.before..github.event.after, tolerating an
 *                          all-zero / force-pushed `before` (resolvePushRange).
 *                          Post-merge detection, not prevention — see that
 *                          function's comment.
 *   --json                 Machine-readable output.
 *
 * Exit: 0 clean · 1 violations · 2 usage error.
 *
 * Scope (public): README.md, README.ko.md, CHANGELOG.md, package.json (npm
 * auto-ships it) + shipped trees commands/ hooks/ scripts/ skills/ templates/
 * docs/ .github/ .claude-plugin/. Excluded: tests/ and qa-runs/ (internal
 * maintainer artifacts — a tracker id in a test description aids traceability
 * and never reaches an installed user), node_modules/, .git/, and the
 * fix-status-verify subsystem (EXCLUDED_FILES — maintainer-only, carries wiki
 * `decisions/` paths as runtime data, un-shipped from the npm package). The
 * checker's OWN sources are scanned (NOT exempt); their examples use `N`
 * placeholders so they stay clean.
 *
 * ADR scope: `ADR NNNN` / `decisions/NNNN` wiki-ADR pointers (DECISION_PATTERNS)
 * are blocked everywhere in scope EXCEPT CHANGELOG.md, whose version history
 * legitimately cites the decision behind a release line. patternsFor() applies the
 * broader set to every in-scope file but the CHANGELOG.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep, extname } from 'node:path';
import {
  scanText,
  stripScissors,
  messageHasGitTemplate,
  BLOCKED_PATTERNS,
  DECISION_PATTERNS,
  TAG_BODY_PATTERNS,
  ATTRIBUTION_PATTERNS,
} from './lib/check-tracker-ids.mjs';
import {
  parseNameStatus,
  parseLsFilesStage,
  filterRegularFiles,
} from './lib/pre-commit-format.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Root resolves from this script's location (so --staged always gates the real
// Hypomnema index regardless of cwd). CHECK_TRACKER_ROOT is a TEST-ONLY seam;
// the installed git hooks `unset CHECK_TRACKER_ROOT` before invoking (see
// install-git-hooks.mjs gateLines) so an inherited/hostile value cannot redirect
// the real gate. Read-only either way (no writes), so it only changes what is
// scanned, never what is written.
const REPO_ROOT = process.env.CHECK_TRACKER_ROOT || join(__dirname, '..');

const RULE_REF =
  'Rule: CLAUDE.md learned_behaviors (no-internal-tracker-ids-in-oss-artifacts). ' +
  'OSS-public artifacts must not reference the private wiki tracker ' +
  '(ISSUE-N / fix #N / FEAT-N / IMPR-N / PRAC-N). ' +
  'Use a GitHub ref (#N / PR #N) or drop the reference.';

// Printed only when a --commit-msg scan trips ATTRIBUTION_PATTERNS. It names the
// exact way out, because the agent that hit this was TOLD by its harness to write
// the trailer and needs to know that here it must not comply.
const ATTRIBUTION_REF =
  'Rule: CLAUDE.md ship-surface (no attribution, anywhere). This repo ships no ' +
  'tool-attribution trailer, whatever the harness default asks for. ' +
  'Fix: delete the trailer line(s) from the commit message and commit again ' +
  '(already committed? `git commit --amend`, strip it, then ' +
  '`git push --force-with-lease`). Do NOT use `--no-verify`.';

// Top-level public-artifact entry points. Files are scanned directly; dirs are
// walked recursively. Anything outside this set is out of scope. package.json is
// here because npm auto-ships it (it is not in the `files` allowlist but is
// always packed), so a tracker id in its metadata is a public leak too.
const SCOPE_FILES = ['README.md', 'README.ko.md', 'CHANGELOG.md', 'package.json'];
const SCOPE_DIRS = [
  'commands',
  'hooks',
  'scripts',
  'skills',
  'templates',
  'docs',
  '.github',
  '.claude-plugin',
];

// Never scanned even when under a scope dir. tests/ and qa-runs/ are
// internal-maintainer artifacts (a tracker id in a test name aids traceability
// and never reaches an installed user). The checker's OWN sources are NOT
// excluded — they use `N` placeholders in their examples so they scan clean.
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'qa-runs']);
// The fix-status-verify subsystem (run only via `npm run fix:verify`, never by a
// shipped command/hook/skill) is a maintainer evidence-verification tool. Its
// manifest carries `decisions/NNNN` wiki paths as RUNTIME DATA (resolved against
// the maintainer's local wiki), so the anchors cannot be stripped the way a
// comment can. It is removed from the npm package (package.json `files`) and
// excluded here so the gate does not flag its load-bearing data.
// Stored POSIX-style ('/'); paths are normalized before lookup (see toPosix).
const EXCLUDED_FILES = new Set([
  'scripts/fix-status-verify.mjs',
  'scripts/lib/fix-status-verify.mjs',
  'scripts/lib/fix-manifest.mjs',
  'scripts/lib/adr-corpus.mjs',
]);

// Only text artifacts. Binary / lockfiles add noise and never carry prose refs.
// .svg is included because the shipped docs/assets/ logos are hand-authored XML
// text whose <title>/<desc>/comment fields could carry a dangling wiki pointer.
const TEXT_EXT = new Set([
  '.md',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.txt',
  '.svg',
]);

// Normalize OS separators to '/' so the two scan modes classify a path the same
// way on every host: --all builds relPath via relative() (platform sep, so '\' on
// Windows) while --staged takes git's output (always '/'). Without this, a Windows
// --staged run would neither exclude the verifier files nor recognize scope dirs.
// No-op on POSIX (sep is already '/').
function toPosix(relPath) {
  return sep === '/' ? relPath : relPath.split(sep).join('/');
}

function isExcludedRel(relPath) {
  const p = toPosix(relPath);
  if (p.split('/').some((seg) => EXCLUDED_DIRS.has(seg))) return true;
  if (EXCLUDED_FILES.has(p)) return true;
  return false;
}

function isTextFile(p) {
  return TEXT_EXT.has(extname(p).toLowerCase());
}

// Single public-scope predicate shared by --all and --staged so the two modes
// can never disagree on what counts as a public artifact (a root file like
// `foo.md` is out of scope for both; `package.json` and scope-dir files are in).
function isInScope(relPath) {
  if (isExcludedRel(relPath)) return false;
  if (!isTextFile(relPath)) return false;
  const p = toPosix(relPath);
  if (SCOPE_FILES.includes(p)) return true;
  return SCOPE_DIRS.includes(p.split('/')[0]);
}

// `ADR NNNN` / `decisions/NNNN` are dangling pointers into the maintainer's
// private wiki ADR set, so they are blocked everywhere in scope EXCEPT the
// CHANGELOG, whose version history legitimately cites the decision behind a
// release line (and never reaches an installed user as a live link). The verifier
// subsystem that carries `decisions/` paths as runtime data is already removed by
// EXCLUDED_FILES, so it is never reached here.
const ADR_EXEMPT_FILES = new Set(['CHANGELOG.md']);
function patternsFor(relPath) {
  return ADR_EXEMPT_FILES.has(toPosix(relPath))
    ? BLOCKED_PATTERNS
    : [...BLOCKED_PATTERNS, ...DECISION_PATTERNS];
}

// Recursively collect in-scope text files under an absolute dir.
function walk(absDir, acc) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const abs = join(absDir, ent.name);
    const rel = relative(REPO_ROOT, abs);
    if (isExcludedRel(rel)) continue;
    if (ent.isDirectory()) {
      walk(abs, acc);
    } else if (ent.isFile() && isTextFile(abs)) {
      acc.push(rel);
    }
  }
}

function collectAllScopeFiles() {
  const files = [];
  for (const f of SCOPE_FILES) {
    if (existsSync(join(REPO_ROOT, f))) files.push(f);
  }
  for (const d of SCOPE_DIRS) {
    walk(join(REPO_ROOT, d), files);
  }
  return files;
}

// ── violation reporting ──────────────────────────────────────────────────────

function report(violations, json) {
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: violations.length === 0,
          count: violations.length,
          violations,
        },
        null,
        2,
      ) + '\n',
    );
  } else if (violations.length === 0) {
    process.stdout.write('[check-tracker-ids] OK: no wiki-internal tracker ids found.\n');
  } else {
    // "blocked reference(s)", not "tracker-id reference(s)": --commit-msg also
    // reports attribution trailers through this same reporter.
    process.stderr.write(`[check-tracker-ids] FAIL: ${violations.length} blocked reference(s):\n`);
    for (const v of violations) {
      process.stderr.write(
        `  ${v.file}:${v.line}:${v.col}  ${v.match}  (${v.label})\n` +
          `      ${v.lineText.trim()}\n`,
      );
    }
    process.stderr.write(`${RULE_REF}\n`);
  }
  return violations.length === 0 ? 0 : 1;
}

// ── git helpers (scoped env not required: read-only, no GIT_DIR attack surface
//    here — the hook shim already pins identity before invoking) ──────────────

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf-8', ...opts });
}

// ── modes ────────────────────────────────────────────────────────────────────

function runAll(json) {
  const files = collectAllScopeFiles();
  const violations = [];
  for (const rel of files) {
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    } catch {
      continue;
    }
    for (const h of scanText(text, patternsFor(rel))) violations.push({ file: rel, ...h });
  }
  process.exit(report(violations, json));
}

function runStaged(json) {
  const diff = git(['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMR', '--']);
  if (diff.status !== 0) {
    // Can't read the index → fail OPEN (don't block a commit on a git probe
    // failure); the --all CI gate is the hard backstop.
    process.stdout.write(
      '[check-tracker-ids] staged: git diff failed; skipping (CI is the backstop).\n',
    );
    process.exit(0);
  }
  const staged = parseNameStatus(diff.stdout || '');
  // Restrict to in-scope public artifacts (same predicate --all uses).
  const inScope = staged.filter((e) => isInScope(e.path));
  if (!inScope.length) {
    if (json) report([], json);
    process.exit(0);
  }
  // Drop symlinks / submodules via the staged mode bits.
  const ls = git(['ls-files', '--stage', '-z', '--', ...inScope.map((e) => e.path)]);
  let regular = inScope;
  if (ls.status === 0) {
    regular = filterRegularFiles(inScope, parseLsFilesStage(ls.stdout || ''));
  }
  const violations = [];
  for (const e of regular) {
    // Scan the STAGED blob, not the working tree — only what is actually being
    // committed is gated (partial stage safety).
    const show = git(['show', `:${e.path}`]);
    if (show.status !== 0) continue;
    for (const h of scanText(show.stdout || '', patternsFor(e.path)))
      violations.push({ file: e.path, ...h });
  }
  process.exit(report(violations, json));
}

// The ONE judgment function for a commit message TEXT: tracker-id scan +
// attribution scan, both via scanText. --commit-msg (local hook, a single
// COMMIT_EDITMSG file) and --commit-range (CI backstop, every already-recorded
// message in a range) both call this and NOTHING ELSE decides the verdict —
// this repo's rule against implementing the same judgment in two places (a
// duplicated judgment drifts) applies here, and this is exactly the kind of
// judgment that drifted before: a local-only check with no CI backstop let an
// attribution trailer land on `main` on 8 separate commits while the PR body
// itself stayed clean.
function judgeMessage(text) {
  return [
    ...scanText(text).map((h) => ({ ...h })),
    ...scanText(text, ATTRIBUTION_PATTERNS).map((h) => ({ ...h, attribution: true })),
  ];
}

function runCommitMsg(file, json) {
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `[check-tracker-ids] cannot read commit-msg file ${file}: ${err.message}\n`,
    );
    process.exit(2);
  }
  // Decide comment/scissors handling by whether git added its editor template
  // (NOT by config, which the hook can't fully resolve). Two branches:
  //
  //   template present (editor commit) → git honors the --verbose scissors AND,
  //     in the default cleanup, strips `#` comment lines. Replicate: cut the
  //     scissors diff, then `stripspace --strip-comments`. This matches what git
  //     records and avoids a false-positive on the template's own branch/file
  //     names (e.g. a ticket-numbered branch in `# On branch ...`).
  //
  //   template absent (`git commit -m` / `-F` / whitespace / verbatim) → git
  //     keeps `#` lines and does NOT treat a bare `>8` line as scissors, so scan
  //     the message VERBATIM. This is what closes both -m gaps (a `#`-prefixed
  //     tracker id, and content after a user-written `>8` line).
  //
  // KNOWN LIMITATION (documented, exotic): an EDITOR commit run with an explicit
  // non-default `--cleanup=whitespace`/`verbatim` does carry a template yet keeps
  // `#` lines, so a tracker id sitting in a comment line there is not caught.
  // This needs a non-default flag AND a `#`-prefixed id; the prose path (the real
  // risk) is always caught, and the file gate (--all/--staged/CI) is the hard
  // guarantee. commit-msg is best-effort — --commit-range below is the real one.
  let text;
  if (messageHasGitTemplate(raw)) {
    const noScissors = stripScissors(raw);
    const strip = git(['stripspace', '--strip-comments'], { input: noScissors });
    text = strip.status === 0 ? strip.stdout || '' : noScissors;
  } else {
    text = raw;
  }
  const rel = relative(REPO_ROOT, file) || file;
  // The commit message is where the harness/repo conflict actually bites: the
  // system prompt tells the agent to append `Co-Authored-By:` / `Claude-Session:`
  // on every commit, and 8 of the 47 commits that reached main after the ban did.
  //
  // Reminder on how much this is worth: install-git-hooks.mjs fails OPEN at every
  // identity guard (CI, no .git, symlinked hook, missing script) and --no-verify
  // skips it outright, so this hook is FAST LOCAL FEEDBACK, never the guarantee.
  // The guarantee is CI — the tracker-id job for files, the pr-surface job for the
  // PR title/body, and --commit-range below for the commit messages themselves.
  const violations = judgeMessage(text).map((h) => ({ file: rel, ...h }));
  const code = report(violations, json);
  if (code !== 0 && !json && violations.some((v) => v.attribution)) {
    process.stderr.write(`${ATTRIBUTION_REF}\n`);
  }
  process.exit(code);
}

// CI backstop for the gap above: --commit-msg only ever runs locally (fails
// open on tooling problems, skippable with --no-verify), so a commit with an
// attribution trailer can reach `main` while the PR body itself is clean — this
// happened 8 times. Scans every commit message in `range` (`a..b`, resolved by
// `git log`) with the SAME judgeMessage() --commit-msg uses.
//
// Commit messages read via `git log --format=%B` are already-recorded: git
// itself stripped any editor template / --verbose scissors diff at commit time,
// so unlike --commit-msg (which reads a live COMMIT_EDITMSG file) no
// messageHasGitTemplate/stripScissors preprocessing applies or is needed here.
// Parse a two-dot `base..head` shape without touching a three-dot
// (symmetric-difference) range or anything else this checker never emits
// itself — every caller in this file builds a two-dot range, so a `...` or a
// dot-free string here is a shape this checker did not produce and the
// existence pre-check below must not apply to it. Returns null for anything
// that is not cleanly `<non-empty>..<non-empty>`, which sends the caller
// straight to the original git-log path (and its original exit-2 behavior).
function parseCommitRange(range) {
  if (range.includes('...')) return null;
  const idx = range.indexOf('..');
  if (idx < 0) return null;
  const base = range.slice(0, idx);
  const head = range.slice(idx + 2);
  if (!base || !head || base.includes('..') || head.includes('..')) return null;
  return { base, head };
}

// True only if `ref` resolves to a commit this checkout can actually see.
function commitExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

function runCommitRange(range, json) {
  // A squash-merge + --delete-branch (or a force-push) can leave `head`
  // resolving to nothing once the branch is gone, so a CI re-run on the
  // merged PR fails `git log a..b` with "Invalid revision range" — not
  // because anything is wrong with the content, but because the ref this
  // checker is asked to scan no longer exists anywhere. That is a procedural
  // side effect of the merge, not a violation, so it must SKIP (exit 0), not
  // FAIL (exit 2) and leave an already-merged, already-reviewed PR red for a
  // reason nobody can act on.
  //
  // The pre-check only fires for a clean two-dot `base..head` shape
  // (parseCommitRange), and ONLY skips when `base` resolves AND `head` does
  // not — never on `base` alone missing, never on both missing. This is
  // load-bearing, not cosmetic: `base` is where the real content lives (every
  // commit in the range is `base`'s descendant), so an attacker (or a broken
  // caller) could pair a bogus, unresolvable base with a real, violating head
  // — `deadbeefdead..<violating-head>` — and if that were allowed to skip, it
  // would walk straight past the gate with a genuine violation sitting right
  // there. Requiring base to resolve means the "content anchor" of the range
  // is always verified live; only the deleted-branch symptom (head vanished,
  // base intact on a surviving branch like main) takes the skip path. A
  // genuinely malformed range (three dots, missing side, garbage token, base
  // missing, or both missing) skips this branch and falls straight into the
  // original git-log call below, so it still fails exit 2 exactly as before.
  const parsed = parseCommitRange(range);
  if (parsed && commitExists(parsed.base) && !commitExists(parsed.head)) {
    process.stdout.write(
      `[check-tracker-ids] --commit-range: skipping "${range}" — head commit not found in this ` +
        `checkout: ${parsed.head} (base ${parsed.base} resolves fine; likely a deleted branch ` +
        `after merge, not a content violation; the pr-surface job already scanned this range ` +
        `before the merge).\n`,
    );
    process.exit(0);
  }
  const listRes = git(['log', '--format=%H', range, '--']);
  if (listRes.status !== 0) {
    process.stderr.write(
      `[check-tracker-ids] --commit-range: git log failed for "${range}": ${(listRes.stderr || '').trim()}\n`,
    );
    process.exit(2);
  }
  const shas = (listRes.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const violations = [];
  for (const sha of shas) {
    const msgRes = git(['log', '-1', '--format=%B', sha]);
    if (msgRes.status !== 0) continue; // sha came from the same git log call above
    const short = sha.slice(0, 7);
    violations.push(
      ...judgeMessage(msgRes.stdout || '').map((h) => ({ file: `commit:${short}`, ...h })),
    );
  }
  const code = report(violations, json);
  if (code !== 0 && !json && violations.some((v) => v.attribution)) {
    process.stderr.write(`${ATTRIBUTION_REF}\n`);
  }
  process.exit(code);
}

// The all-zero SHA GitHub sends as `github.event.before` for a branch's first push.
const ZERO_SHA_RE = /^0{40}$/;

/**
 * Resolve the commit range a `push` event actually ADDED to the branch.
 *
 * Why a push scan exists at all: this repo merges with SQUASH. The message that
 * lands on `main` is composed in the merge dialog, so it never existed on the PR
 * branch and was never inside the pr-surface job's `base.sha..head.sha` range —
 * every check could be green while the public commit on `main` carries an
 * attribution trailer. That is not theoretical; it is the only path left open.
 *
 * KNOWN LIMITATION, stated plainly: this runs on `push`, i.e. AFTER the merge. It
 * DETECTS, it cannot PREVENT. The commit is already on `main` when the job goes
 * red — the remedy is `git commit --amend` + `git push --force-with-lease`, which
 * is exactly what CLAUDE.md prescribes. A red build a minute after the merge beats
 * a leak nobody ever looks for.
 *
 * `before` cannot be trusted blindly: it is all-zeros on a first push and points
 * into discarded history after a force-push, so `before..after` would fail to
 * resolve (exit 2, a red build for the wrong reason) or silently scan nothing.
 *   before resolvable          → before..after  (exactly the commits this push added)
 *   otherwise, after has a parent → after^1..after (the tip alone — less, never nothing)
 *   after is a root commit     → after (that single commit)
 */
function resolvePushRange(before, after) {
  const usable =
    before &&
    !ZERO_SHA_RE.test(before) &&
    git(['cat-file', '-e', `${before}^{commit}`]).status === 0;
  if (usable) return `${before}..${after}`;
  if (git(['rev-parse', '-q', '--verify', `${after}^1`]).status === 0)
    return `${after}^1..${after}`;
  return after;
}

function runPushRange(spec, json) {
  const idx = String(spec).indexOf('..');
  if (idx < 0) {
    process.stderr.write(
      '[check-tracker-ids] --push-range requires a "<before>..<after>" argument\n',
    );
    usage(2);
  }
  const before = String(spec).slice(0, idx);
  const after = String(spec).slice(idx + 2);
  if (!after) {
    process.stderr.write('[check-tracker-ids] --push-range: the <after> sha is required\n');
    usage(2);
  }
  // Same judgment as every other entry point: runCommitRange → judgeMessage.
  runCommitRange(resolvePushRange(before, after), json);
}

// Scan an annotated tag's body for ALL wiki tracker prefixes (TAG_BODY_PATTERNS:
// ISSUE-/fix #/FEAT-/IMPR-/PRAC-). The tag body is the PUBLIC release surface —
// `gh release create --notes-from-tag` republishes it verbatim — and it carries
// no code, so unlike the file gate it must reject every prefix (changelog-pr-
// guide §5 / T4). Wired into release.yml before `gh release create`. `--tag -`
// reads the body from stdin (piping / test), `--tag <ref>` reads it from git.
function runTag(ref, json) {
  let body;
  if (ref === '-') {
    try {
      body = readFileSync(0, 'utf-8');
    } catch (err) {
      process.stderr.write(`[check-tracker-ids] --tag -: cannot read stdin: ${err.message}\n`);
      process.exit(2);
    }
  } else {
    // Require an annotated tag: `<ref>^{tag}` peels only for an annotated tag
    // object. A lightweight tag has no body to leak, but a release uses
    // --notes-from-tag on an annotated tag, so a lightweight one here is a
    // release misconfiguration — fail loudly rather than silently pass.
    const tagObj = git(['rev-parse', '--verify', '--quiet', `${ref}^{tag}`]);
    if (tagObj.status !== 0) {
      const exists = git(['rev-parse', '--verify', '--quiet', ref]);
      if (exists.status !== 0) {
        process.stderr.write(`[check-tracker-ids] --tag: tag ${ref} not found\n`);
      } else {
        process.stderr.write(
          `[check-tracker-ids] --tag: ${ref} is a lightweight tag (no annotation body to scan)\n`,
        );
      }
      process.exit(2);
    }
    const tagBody = git(['tag', '-l', '--format=%(contents)', ref]);
    if (tagBody.status !== 0) {
      process.stderr.write(
        `[check-tracker-ids] --tag: failed to read tag ${ref}: ${tagBody.stderr}\n`,
      );
      process.exit(2);
    }
    body = tagBody.stdout || '';
  }
  const file = ref === '-' ? '<stdin>' : `tag:${ref}`;
  const violations = scanText(body, TAG_BODY_PATTERNS).map((h) => ({ file, ...h }));
  process.exit(report(violations, json));
}

// ── arg parsing ────────────────────────────────────────────────────────────

function usage(code) {
  process.stdout.write(
    'Usage:\n' +
      '  node scripts/check-tracker-ids.mjs [--all] [--json]\n' +
      '  node scripts/check-tracker-ids.mjs --staged [--json]\n' +
      '  node scripts/check-tracker-ids.mjs --commit-msg <file> [--json]\n' +
      '  node scripts/check-tracker-ids.mjs --commit-range <base>..<head> [--json]\n' +
      '      CI backstop: scan every commit message in the range for tracker ids\n' +
      '      and attribution trailers (the local commit-msg hook is bypassable).\n' +
      '  node scripts/check-tracker-ids.mjs --push-range <before>..<after> [--json]\n' +
      '      Same scan for a `push` event, tolerating an all-zero / force-pushed\n' +
      '      <before>. This is the ONLY thing that sees a squash-merge message.\n' +
      '  node scripts/check-tracker-ids.mjs --tag <ref|-> [--json]\n' +
      '      Scan an annotated tag body (or stdin via "-") for ALL tracker\n' +
      '      prefixes; the public release surface must be tracker-ID-0.\n',
  );
  process.exit(code);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);
const json = argv.includes('--json');

if (argv.includes('--commit-msg')) {
  const i = argv.indexOf('--commit-msg');
  const file = argv[i + 1];
  if (!file || file.startsWith('--')) {
    process.stderr.write('[check-tracker-ids] --commit-msg requires a file path\n');
    usage(2);
  }
  runCommitMsg(file, json);
} else if (argv.includes('--commit-range')) {
  const i = argv.indexOf('--commit-range');
  const range = argv[i + 1];
  if (!range || range.startsWith('--')) {
    process.stderr.write(
      '[check-tracker-ids] --commit-range requires a "<base>..<head>" argument\n',
    );
    usage(2);
  }
  runCommitRange(range, json);
} else if (argv.includes('--push-range')) {
  const i = argv.indexOf('--push-range');
  const spec = argv[i + 1];
  if (!spec || spec.startsWith('--')) {
    process.stderr.write(
      '[check-tracker-ids] --push-range requires a "<before>..<after>" argument\n',
    );
    usage(2);
  }
  runPushRange(spec, json);
} else if (argv.includes('--tag')) {
  const i = argv.indexOf('--tag');
  const ref = argv[i + 1];
  // `-` (stdin) is a valid ref token here; only a missing/flag value is an error.
  if (!ref || (ref.startsWith('--') && ref !== '-')) {
    process.stderr.write('[check-tracker-ids] --tag requires a ref argument (or "-" for stdin)\n');
    usage(2);
  }
  runTag(ref, json);
} else if (argv.includes('--staged')) {
  runStaged(json);
} else {
  // default + explicit --all
  runAll(json);
}
