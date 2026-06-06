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
| `tests/runner.mjs` | Test runner (no external deps) |
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
5. Add coverage to `tests/runner.mjs`.

### Adding or modifying a hook

1. Edit the hook file in `hooks/`.
2. If it's new, register it in `hooks/hooks.json` under the correct event key.
3. Shared utilities go in `hooks/hypo-shared.mjs`.
4. Add a contract test in `tests/runner.mjs` (input → expected `additionalContext` shape).
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
4. Add a test in `tests/runner.mjs` that asserts the file lands in a freshly initialized vault.

### Adding an Agent Skill

1. Create `skills/<name>/SKILL.md`.
2. The frontmatter must include `name`, `description`, and the trigger criteria.
3. The skill body is the LLM prompt — keep it focused on the synthesis task.
4. Add to the skills inventory in `README.md`.

---

## Testing

```bash
npm test           # tests/runner.mjs — unit + smoke + contract tests
npm run lint       # scripts/lint.mjs — frontmatter + wikilink validation + W8 (design-history stale vs session-log)
npm run fix:verify # Phase 1 of learned_behavior #6 — verifies fix #N status claims in
                   # a wiki spec against `// @fix #N: <test-name>` anchors in
                   # tests/runner.mjs. Maintainer dogfood; needs a local wiki at
                   # $HYPO_DIR or ~/hypomnema. Does NOT grep ADR core decision lines.
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
// @fix #25: replay-compact-guard-detects-slash-clear: /clear with incomplete wiki → WIKI_AUTOCLOSE
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

Open the PR against `main`. Include:

- **What changed** — short summary
- **Why** — the user-visible motivation
- **Manual verification steps** — anything the test suite cannot cover
- **Migration notes** — if upgrading existing installs needs special handling

---

## Release process

Hypomnema uses semver. Releases are automated via `release.yml` on `v*` tag push.

### Cutting a release

Every Hypomnema release must carry a Korean summary alongside the English body
in **both** the CHANGELOG section AND the git tag annotation. The release
workflow enforces this with `scripts/check-bilingual.mjs`; lightweight tags or
a missing `### 한글 요약` section will block `npm publish`.

```bash
# 1. Bump the version across package.json, plugin.json, marketplace.json,
#    and templates/hypo-config.md. Takes a concrete semver (not patch/minor/major).
node scripts/bump-version.mjs <new-semver>   # e.g. 1.2.2 or 1.3.0-rc.1

# 2. Edit CHANGELOG.md — the new section MUST include a "### 한글 요약"
#    sub-section with at least 10 Hangul characters of real summary text.
$EDITOR CHANGELOG.md

# 3. Verify locally before tagging (same check that runs in CI)
node scripts/check-bilingual.mjs --changelog

# 4. Commit
git add package.json CHANGELOG.md
git commit -m "chore: release v<version>"

# 5. Tag with an ANNOTATED tag — never a lightweight tag.
#    Annotation body shape: English summary, then "---" on its own line,
#    then a Korean summary block.
git tag -a v<version> -m "$(cat <<'EOF'
Hypomnema v<version> — <one-line English summary>

<a few lines of English body — what shipped, links, etc.>

---

Hypomnema v<version> — <한 줄 한글 요약>

<몇 줄의 한글 요약 본문.>
EOF
)"

# 6. Verify the tag annotation locally (same check that runs in CI)
node scripts/check-bilingual.mjs --tag v<version>

# 7. Push
git push origin main --tags
```

The `release.yml` workflow then:

1. Verifies the tag matches `package.json` version.
2. Validates the CHANGELOG section AND the tag annotation are bilingual
   (`scripts/check-bilingual.mjs`).
3. Runs `npm test` and `npm run lint`.
4. Publishes to npm with `npm publish --access public --provenance`.

`NPM_TOKEN` must be set as a repository secret.

### Versioning rules

| Change type | Bump |
|---|---|
| Hook contract change (event name, output schema) | major |
| `hooks.json` schema change | major |
| Wiki vault layout change requiring migration | major |
| New command, hook, or skill | minor |
| New `init` template file | minor |
| Bug fix, doc-only change, internal refactor | patch |

Major bumps must include an `upgrade.mjs` migration fixture in `tests/runner.mjs`.

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
- `~/hypomnema/projects/hypomnema/decisions/0001..0014.md` — architecture decision records
- `~/hypomnema/projects/hypomnema/design-history.md` — narrative design history
- `~/hypomnema/projects/hypomnema/backlog-v1.0.md` — historical gap analysis (archived)
- `~/hypomnema/projects/hypomnema/test-cases-v1.0.md` — historical QA spec (archived)

If you need maintainer context for a non-trivial design choice, ask in the PR — references will be summarized inline.

---

## Questions

Open a GitHub Issue at <https://github.com/sk-lim19f/Hypomnema/issues>. For security-sensitive reports, please email the maintainer directly rather than filing publicly.
