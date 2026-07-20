# Contributing to Hypomnema

Thanks for your interest in Hypomnema. This guide covers everything from setup to release.

For a high-level mental model of the codebase, read [ARCHITECTURE.md](ARCHITECTURE.md) first.

---

## Requirements

- **Node.js ≥ 18** (CI matrix tests 18 / 20 / 22)
- **Claude Code CLI** (for end-to-end testing)
- **git** (the wiki vault is a git repo from day one)

No build step. The package is plain ESM with **zero npm runtime dependencies**.

---

## Setup

```bash
git clone https://github.com/sk-lim19f/Hypomnema.git
cd Hypomnema
npm install   # installs dev tooling only — runtime deps are zero
npm test      # all tests should pass — exact count shifts as lanes ship
npm run lint  # frontmatter + wikilink validation
```

To exercise the slash commands locally:

```bash
# Install your in-progress version into ~/.claude/hooks
node scripts/init.mjs --hypo-dir=/tmp/test-wiki --no-git-init

# Or, after publishing a local link
npm link
hypomnema   # equivalent to running scripts/init.mjs
```

---

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full breakdown. Short version:

| Path | What lives there |
|---|---|
| `commands/` | LLM-facing prompts for `/hypo:*` slash commands |
| `scripts/` | Node.js implementations called by the commands |
| `scripts/lib/` | Shared helpers for scripts (`frontmatter`, `hypo-root`, `hypo-ignore`) |
| `hooks/` | Lifecycle hooks + `hooks.json` registry |
| `hooks/hypo-shared.mjs` | Shared hook utilities — read the deployment constraint below |
| `skills/<name>/SKILL.md` | Agent Skills (auto-trigger via description match) |
| `templates/` | Files copied into new wiki vaults on init |
| `tests/` | Test suite (no external deps): `harness.mjs`, `helpers.mjs`, `runner.mjs` (entry), and one `<area>.test.mjs` per production area |
| `docs/` | ARCHITECTURE, CONTRIBUTING |
| `.claude-plugin/plugin.json` | Plugin manifest |

---

## Hook deployment constraint

**Hooks run in `~/.claude/hooks/` in isolation. They cannot import from relative paths.**

- All shared logic must live in `hooks/hypo-shared.mjs`.
- `hypo-shared.mjs` is declared via the `shared` field in `hooks/hooks.json` and copied alongside each hook at deploy time.
- Hook utilities may use **only** Node.js built-ins (`fs`, `path`, `os`, `child_process`, `crypto`).
- No relative imports, no npm dependencies.

Scripts under `scripts/` are not deployed and may freely import from `scripts/lib/`. If you find yourself wanting to share logic between scripts and hooks, the canonical pattern is: implement it inline in `hypo-shared.mjs`, then have `scripts/lib/` mirror the function (or thin-wrap it via the deployed copy).

---

## Making changes

### Adding or modifying a slash command

1. Edit `commands/<name>.md` — the LLM-facing prompt.
2. Edit `scripts/<name>.mjs` — the Node.js logic.
3. If the command is new and synthesis-heavy, add `skills/<name>/SKILL.md`.
4. Update the command table in `README.md` and `README.ko.md`.
5. Add coverage to the matching `tests/<area>.test.mjs` (a new command usually means a new area file).

### Adding or modifying a hook

1. Edit the hook file in `hooks/`.
2. If it's new, register it in `hooks/hooks.json` under the correct event key.
3. Shared utilities go in `hooks/hypo-shared.mjs`.
4. Add a contract test in the hook's area file, e.g. `tests/session-hooks.test.mjs` (input → expected `additionalContext` shape).
5. After your change, run `/hypo:upgrade` in a real Claude Code session and verify the hook fires.

### Modifying `hypo-shared.mjs`

This file is deployed verbatim to `~/.claude/hooks/`. Constraints:

- Only Node.js built-ins.
- No relative imports.
- No npm dependencies.
- Keep exports minimal — the file ships in every wiki install.

If you need to share new logic, prefer extending an existing helper over adding a new export.

### Adding a template file

1. Drop the file under `templates/`.
2. Update `scripts/init.mjs` so `init` copies it.
3. Update the templates section of [ARCHITECTURE.md](ARCHITECTURE.md#package-layout).
4. Add a test in `tests/init.test.mjs` that asserts the file lands in a freshly initialized vault.

### Adding an Agent Skill

1. Create `skills/<name>/SKILL.md`.
2. The frontmatter must include `name`, `description`, and the trigger criteria.
3. The skill body is the LLM prompt — keep it focused on the synthesis task.
4. Add to the skills inventory in `README.md`.

---

## Testing

```bash
npm test           # tests/*.test.mjs, sharded across processes — unit + smoke + contract
npm run lint       # scripts/lint.mjs — frontmatter + wikilink validation + W8 (design-history stale vs session-log)
npm run fix:verify # Phase 1 of learned_behavior #6 — verifies fix #N status claims in
                   # a wiki spec against `// @fix #N: <test-name>` anchors, read as a
                   # union across every tests/*.mjs. Maintainer dogfood; needs a wiki at
                   # $HYPO_DIR or ~/hypomnema (source checkout only; not shipped in
                   # the npm package). Phase 2 also greps each manifest adrKeyLine
                   # against the production corpus.
```

> **`fix:verify` needs an explicit `--spec`.** The default path
> (`projects/hypomnema/spec-v1.2.md`) is now a `type: reference` redirect stub —
> the real spec moved to `archive/`. Running the bare command fails with
> `STUB_SPEC` by design (a stub carries zero status claims, so greening it would
> be vacuous). Point it at the real spec:
>
> ```bash
> npm run fix:verify -- --spec ~/hypomnema/projects/hypomnema/archive/spec-v1.2.md
> ```

### `// @fix #N:` anchor convention

When a test verifies behavior tied to a numbered fix in the wiki spec, add an anchor immediately above the `suite(...)` or `test(...)` call:

```js
// @fix #N: replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE
test('replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE', () => { ... });
```

The anchor's body must be the EXACT test name (whole rest of the line; no comma splitting). Multiple anchor lines per fix # accumulate. For fixes whose verification is behavioral / prompt-driven (no automated test by design), use the sentinel `// @fix #N: NO_AUTO_TEST`.

`npm run fix:verify` reads these anchors plus the spec status claims and reports any drift (`NO_ANCHOR`, `MISSING_TEST`, `FAILING_TEST`, `ORPHAN_ANCHOR`, `STUB_SPEC`). Plain `// fix #N: …` comments without the `@` prefix are treated as prose and ignored by the verifier.

The test runner uses only Node.js built-ins. Tests create scoped temp directories and clean up after themselves; you can run the suite without any environment setup.

When adding a feature, add a corresponding test. For hook-event behavior that's hard to unit-test, document the manual verification step in the PR description (see the manual verification section below).

### Manual verification (for hook changes)

Some hook behavior is only observable inside a Claude Code session. Document the exact session you ran:

1. Set up a clean wiki: `node scripts/init.mjs --hypo-dir=/tmp/v-wiki`
2. Open a Claude Code session in that directory.
3. Trigger the lifecycle event (e.g., for `Stop` hooks, end the session).
4. Verify the expected side effect (e.g., commit was created, push happened).
5. Note the verification in the PR.

---

## Pre-commit auto-format hook

`npm install` in this checkout installs a git `pre-commit` hook that runs `prettier --write` on staged files only. The hook is **non-blocking**: formatter failures print a notice but the commit still proceeds. The only block is when `git add` itself fails during restage (true index corruption).

**Requirements**: Git ≥ 2.13 (uses `--absolute-git-dir`; `--git-common-dir` is 2.5+).

**Path-locked to your checkout.** The shim embeds the absolute paths of your `HYPOMNEMA_ROOT` and `.git/` directory at install time. If you `mv` the checkout, re-run `npm install` to regenerate the shim — until then it safely no-ops.

**Main worktree only.** `git worktree add` checkouts silently skip — the shared `.git/hooks/pre-commit` can only point at one embedded root at a time. Commit from the main worktree to get auto-format, or accept the no-op in linked worktrees.

**CI is skipped.** `npm ci` runs `prepare`, but the installer detects `CI=true` and exits 0 without touching `.git/hooks/`. CI runs never mutate hooks.

**Symlink-safe.** If `.git/hooks/` is a symlink, or an existing `pre-commit` is a symlink, the installer refuses to write through it.

**Shared `core.hooksPath` safe.** The shim verifies both `--show-toplevel` and `--absolute-git-dir` against the embedded values before executing. Foreign repos that share your global `core.hooksPath` will silently no-op.

**Env-override defense.** The Node side strips every `GIT_*` env from `git rev-parse --local-env-vars` (plus `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_*`) before its own git spawns. Inherited `GIT_INDEX_FILE` is preserved **only** when invoked from the installed shell shim (signalled via a sentinel env var). Direct `node scripts/pre-commit-format.mjs` invocation drops `GIT_INDEX_FILE` and falls back to the default `.git/index`, closing the class of attacks that try to drive the formatter against a crafted alternate index.

**Existing non-marker pre-commit?** If you have your own `pre-commit` hook (no `# hypomnema-pre-commit-marker v1` on line 2), the installer logs a notice and never overwrites it.

**Skip a single commit**: `git commit --no-verify`. AI agents must not use this without explicit user authorization.

**Verbose install logs**: `HYPOMNEMA_HOOK_VERBOSE=1 npm install` prints skip/install reasons to stderr.

**Distinction from `hooks/hypo-pre-commit.mjs`**: that file is the git pre-commit worker template that `scripts/init.mjs` installs into `<wiki>/.git/hooks/pre-commit` when a user runs `hypomnema init` in their own wiki repo. It lives in the *user's wiki* repo, not in this package repo. The two hooks never interact.

---

## Branch and commit conventions

- One logical change per branch.
- Branch names: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `refactor/<topic>`, `chore/<topic>`.
- Commit messages: imperative, lowercase subject, ≤ 72 characters.
  - Good: `fix: resolve wiki root when HYPO_DIR contains ~`
  - Bad: `Fixed the bug with the wiki root path resolution issue`
- Conventional Commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) are encouraged but not strictly required.

For non-trivial changes, request a second review before merging — a peer review or a tool-assisted cross-check (e.g., a separate model run) is fine.

---

## Submitting a PR

Before opening:

1. `npm test` and `npm run lint` both pass.
2. If you changed a hook, you ran the manual verification step in a real Claude Code session.
3. If you changed `hypo-shared.mjs`, the deployed copy works after `/hypo:upgrade`.
4. If you changed a template or `init` flow, a fresh `init` produces the expected vault structure.
5. README / ARCHITECTURE / docs are updated to match.

Open the PR against `main`. The body is **bilingual**: write the full description twice, once under a `# English` heading and once under a `# 한국어` heading, each carrying the same sections. The `## Changelog` and `## Checklist` blocks are language-neutral, so they appear once, after both language blocks. Do **not** add any tool-attribution footer (no "Generated with ..." line) to the body.

Each language block includes:

- **What changed** / **변경 내용**: short summary
- **Why** / **이유**: the user-visible motivation
- **How** / **방법**: approach notes that aren't obvious from the diff
- **Manual verification** / **수동 검증**: anything the test suite cannot cover
- **Migration notes** / **마이그레이션 노트**: if upgrading existing installs needs special handling (else "None")

After both blocks, language-neutral:

- **Changelog**: one English line plus one Korean line if the change is user-visible (see CHANGELOG conventions below)
- **Checklist**: the boxes from the PR template

---

## CHANGELOG conventions

`CHANGELOG.md` is the source of truth for release history. It follows a fixed section model, and contributors feed it through the `## Changelog` block in the PR template rather than editing `CHANGELOG.md` directly. The release collector and the maintainer assemble the final entries at release time.

### PR title vs. merge commit

- **PR title**: Conventional Commits plus a scope, e.g. `feat(feedback): add failure_type enum`. The type drives the CHANGELOG section (see the classification table below).
- **Merge commit**: the squash-merge subject carries the PR number (`#123`). That is where `#N` comes from, not the PR title. The two conventions stay separate.
- Internal tracker ids (`FEAT-`, `IMPR-`, `ISSUE-`, `PRAC-`, `fix #N`) may appear in your local notes and in `tests/` / `qa-runs/` (where they aid test-to-issue traceability and never reach an installed user), but not in shipped code or workflow comments, and never on the published changelog and release surface: not in the CHANGELOG body, not in the PR `## Changelog` block, not in a tag annotation, not in a GitHub Release. The only tracker identifier that ships in those is the PR number `#N`; the lone exception is the ADR carve-out noted below. `check-tracker-ids` gates the file, message, and tag surfaces (`--all`/`--staged` for files, `--commit-msg` for messages, `--tag` for the tag body), and `check-pr-surface` gates the PR title and body; the migration keeps the CHANGELOG body clean. `ADR NNNN` / `decisions/NNNN` are exempt on the changelog surfaces (the CHANGELOG body, the tag body, and the PR `## Changelog` block), where a release line legitimately cites the decision behind it.

### The `## Changelog` block

If a change is user-visible, fill the `## Changelog` block in the PR body with one English line and one Korean line:

```
## Changelog

- EN: Feedback pages accept an optional `failure_type` so recurring mistakes are visible.
- KO: 피드백 페이지에 선택적 `failure_type`를 달아 반복되는 실수를 집계로 볼 수 있습니다.
```

- Reference the PR by number only (`#123`). No internal tracker ids on this surface.
- No em dashes; use a colon, comma, or parentheses.
- Internal-only changes (a refactor with no user-visible effect, test-only, CI plumbing) write `None` and skip the lines.

### Section model

Each version block in `CHANGELOG.md` is ordered, top to bottom:

1. Optional `> [!IMPORTANT]` migration or breaking callout.
2. `### New Features`, `### Bug Fixes`, `### Chores`: present only when that version has a user-relevant entry of that kind. An empty section is omitted. Keep each entry to one compact line; split or trim anything that runs to multiple sentences. Describe only what a user sees: purely internal work (release tooling, contributor docs, a refactor with no user-visible effect) gets no prose entry and lives in the `### Changelog` index alone.
3. `### Changelog`: the PR-link index plus contributors. Always present. Language-neutral. It lists every merged PR, internal ones included.

At and after the v1.2.0 cutoff, each non-empty gated section (`New Features`, `Bug Fixes`, `Chores`) splits its content into `#### English` then `#### 한국어`, in that order:

```
### New Features
#### English
- Feedback pages accept an optional `failure_type`. ([#141](https://github.com/sk-lim19f/Hypomnema/pull/141))
#### 한국어
- 피드백 페이지가 선택적 `failure_type`를 받습니다. ([#141](https://github.com/sk-lim19f/Hypomnema/pull/141))
```

Versions below the v1.2.0 cutoff (1.0.0, 1.0.1, 1.1.0) are English-only: the English body sits directly under the section header with no `####` sub-blocks. Korean is not back-filled for those releases.

The `### Changelog` index is language-neutral, one merged PR per line:

```
### Changelog
- [#141](https://github.com/sk-lim19f/Hypomnema/pull/141) feedback failure_type classification
- [#140](https://github.com/sk-lim19f/Hypomnema/pull/140) invalid-YAML lint guard
Contributors: @handle
```

Each line is `- [#N](<pr-url>) <short title>`, no em dash: the collector links each `#N` to its GitHub PR (a repo markdown file does not autolink a bare `#N`), deriving the URL from the `repository` field in `package.json`. The `Contributors:` line lists that version's PR authors, de-duplicated; the release collector fills the handles from the GitHub API.

A `### Known Issues` or `### Notes` block, when a version has one, is a trailing note (a caveat, not a change). It is not one of the gated sections, so it carries no `####` sub-blocks even at or after the cutoff; bilingual text there is recommended, not enforced.

### Classification

The section is decided by change kind, with the Conventional Commit type as the default and content as the override:

| Input | Section |
|---|---|
| `feat:` / `FEAT-` | New Features |
| `fix:` / `ISSUE-` | Bug Fixes |
| `chore:` / `refactor:` / `docs:` / `ci:` / `perf:` / `IMPR-` / `PRAC-` | Chores |

Chores is defined by kind, not by visibility: improvements (`IMPR`), refactors, and release or internal cleanup all land in Chores even when user-visible. The external changelog highlights only New Features and Bug Fixes; everything else is a Chore.

---

## Release process

Hypomnema uses semver. Releases are automated via `release.yml` on `v*` tag push.

### Cutting a release

The maintainer drives this checklist with a personal `/ship` command (it lives in
`~/.claude/commands/`, alongside `qa-before-ship` — it is maintainer tooling, not
a shipped plugin command, since an OSS user has no reason to release Hypomnema
itself). The sequence below is that same checklist, and is the authoritative
in-repo reference; follow it whether or not you have the `/ship` convenience
command.

Every Hypomnema release must carry Korean alongside the English body
in **both** the CHANGELOG section AND the git tag annotation. The release
workflow enforces this with `scripts/check-bilingual.mjs`; a lightweight tag, or
a gated CHANGELOG section missing its `#### 한국어` sub-block, will block `npm publish`.

The READMEs are not part of a release. They describe what Hypomnema does now, not
what each version added, so cutting a release never edits them. Version history
lives in `CHANGELOG.md` alone. (A gate used to require the release version to
appear in both READMEs, back when they carried a rolling version narrative. That
narrative is gone, and the gate with it.)

Prerequisite: the changelog collector in step 2 reads merged-PR data through the GitHub CLI, so have `gh` installed and authenticated (`gh auth status`) before you start. It is a maintainer-only release script and is not shipped to npm.

```bash
# 0. (minor+ releases only) Ensure the wiki vault carries this release's version
#    spec. Convention (version-plan lifecycle: born-at-stable-path, flip-in-place,
#    recorded in the vault's decisions log): a minor-or-higher release has
#    projects/hypomnema/specs/spec-v<version>.md with status: active and
#    version: <version>. If it is missing, create it from the vault's minimal spec
#    shape (omit patch-only fields for a minor/major). If you created or changed
#    it, run the wiki lint and commit + push the vault before bumping, so the
#    active pre-ship state is recorded remotely. Patch releases are exempt: the
#    CHANGELOG section and PR body cover them, no spec doc required.
$EDITOR ~/hypomnema/projects/hypomnema/specs/spec-v<version>.md

# 1. Bump the version across package.json, plugin.json, marketplace.json,
#    and templates/hypo-config.md. Takes a concrete semver (not patch/minor/major).
node scripts/bump-version.mjs <new-semver>   # e.g. 1.2.2 or 1.3.0-rc.1

# 1b. bump-version does NOT touch package-lock.json — sync it so `npm ci` and the
#     version-consistency gate stay green (the lock carries the version twice).
npm install --package-lock-only

# 2. Draft the new CHANGELOG.md section from the merged PRs' `## Changelog`
#    blocks (see CHANGELOG conventions above). The collector prints a draft for
#    the range since the last tag; paste it, then finalize the wording by hand,
#    dropping any entry that is not user-relevant. --strict fails if any PR lacks
#    a usable block.
node scripts/collect-changelog.mjs --strict   # maintainer-only; not shipped to npm
#    Each gated section (New Features / Bug Fixes / Chores) MUST carry both a
#    "#### English" and a "#### 한국어" sub-block; check:bilingual enforces it.
$EDITOR CHANGELOG.md

#    The READMEs need no edit here. They describe current behavior, so a release
#    only touches them when the behavior itself changed.

# 3. Verify locally before tagging (the full gate set CI + prepublishOnly run)
npm test                   # unit suite
npm run lint               # vault linter
npm run check:versions     # all version-carrying files (incl. package-lock) agree
npm run check:bilingual    # each gated CHANGELOG section has #### English + #### 한국어
npm run smoke:plugin       # plugin manifest + hooks/commands/skills load-valid
npm run smoke-pack         # packed tarball installs and resolves
npm run check:tracker-ids  # no private-tracker pointers leaked into shipped files

# 4. Commit every file the bump touched, plus the lockfile.
git add package.json package-lock.json .claude-plugin/ templates/hypo-config.md \
        CHANGELOG.md
git commit -m "chore: release v<version>"
#    Then open the release PR, pass review + green CI, and squash-merge to main.

# 5. Tag the merge commit with an ANNOTATED tag, never a lightweight tag.
#    Annotation body shape: English summary, then "---" on its own line,
#    then a Korean summary block. The GitHub Release republishes this body
#    verbatim, so keep it on the same public surface as the CHANGELOG: PR
#    numbers (#N) only, no `FEAT-`/`IMPR-`/`ISSUE-`/`PRAC-`/`fix #N` tracker
#    ids (check-tracker-ids --tag gates it). Like the CHANGELOG, the tag body MAY cite
#    `ADR NNNN` / `decisions/NNNN` for the decision behind a release.
git tag -a v<version> -m "$(cat <<'EOF'
Hypomnema v<version>: <one-line English summary>

<a few lines of English body: what shipped, links, etc.>

---

Hypomnema v<version>: <한 줄 한글 요약>

<몇 줄의 한글 요약 본문.>
EOF
)"

# 6. Rehearse the release locally (same checks CI runs against the tag)
node scripts/check-bilingual.mjs --tag v<version>
node scripts/check-versions.mjs --tag v<version>
node scripts/check-tracker-ids.mjs --tag v<version>   # no tracker ids leak into the tag body
npm publish --dry-run --access public   # packs + prepublishOnly, NO registry PUT

# 7. Push the SPECIFIC tag alone — NOT --tags (that would push stale local tags
#    and could trigger releases for versions you did not intend).
git push origin v<version>

# 8. (minor+ releases only) After the release workflow succeeds, close the spec
#    lifecycle IN PLACE (no path move): set status: archived and
#    archived_date: <release date> in the same spec, run the wiki lint, then
#    commit and push the vault. Do this only after the release is green, never at
#    tag time: a failed release must not leave an archived spec behind.
$EDITOR ~/hypomnema/projects/hypomnema/specs/spec-v<version>.md
```

The `release.yml` workflow then:

1. Verifies the tag matches the version in EVERY version-carrying file —
   `package.json`, `package-lock.json`, `.claude-plugin/{plugin,marketplace}.json`,
   and `templates/hypo-config.md` (`scripts/check-versions.mjs --tag`).
2. Smokes the plugin channel — manifest, `hooks/hooks.json` targets, and
   command/skill component files (`scripts/smoke-plugin.mjs`).
3. Validates the CHANGELOG section AND the tag annotation are bilingual
   (`scripts/check-bilingual.mjs`).
4. Runs `npm test` and `npm run lint`.
5. Publishes to npm with `npm publish --access public --provenance` and creates
   the GitHub Release from the tag body.

`NPM_TOKEN` must be set as a repository secret. After rotating it, run the
`release.yml` `workflow_dispatch` "publish credential pre-check" — it verifies the
token authenticates without publishing anything.

### Versioning rules

| Change type | Bump |
|---|---|
| Hook contract change (event name, output schema) | major |
| `hooks.json` schema change | major |
| Wiki vault layout change requiring migration | major |
| New command, hook, or skill | minor |
| New `init` template file | minor |
| Bug fix, doc-only change, internal refactor | patch |

Major bumps must include an `upgrade.mjs` migration fixture in `tests/upgrade.test.mjs`.

---

## What not to do

- **Don't add npm runtime dependencies.** The package is intentionally dependency-free. If a feature genuinely needs one, raise an issue first to discuss alternatives.
- **Don't add external imports to hook files.** See the deployment constraint above.
- **Don't edit `templates/` to fix bugs.** Fix the source in `scripts/` or `hooks/` and let `init` / `upgrade` propagate. `templates/` is *output*, not *source*.
- **Don't commit `~/.claude/hypo-pkg.json` or other user-specific config.** These are local-only artifacts.
- **Don't reintroduce a privacy mode flag.** v1.1 deleted `personal / shared / public` modes deliberately. `.hypoignore` is the single source of truth for exclusions.
- **Don't bypass `hooks.json`.** It's the single source of truth for event-to-hook mapping; `init`, `upgrade`, and `doctor` all read from it. Adding a hook means editing this file, period.

---

## Internal references

These documents live in the maintainer's personal wiki, not in this repo:

- `~/hypomnema/projects/hypomnema/prd-v1.1.md` — current product requirements
- `~/hypomnema/projects/hypomnema/decisions/*.md` — architecture decision records
- `~/hypomnema/projects/hypomnema/design-history.md` — narrative design history
- `~/hypomnema/projects/hypomnema/backlog-v1.0.md` — historical gap analysis (archived)
- `~/hypomnema/projects/hypomnema/test-cases-v1.0.md` — historical QA spec (archived)

If you need maintainer context for a non-trivial design choice, ask in the PR — references will be summarized inline.

---

## Questions

Open a GitHub Issue at <https://github.com/sk-lim19f/Hypomnema/issues>. For security-sensitive reports, please email the maintainer directly rather than filing publicly.
