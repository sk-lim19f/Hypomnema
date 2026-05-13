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
npm test       # tests/runner.mjs — unit + smoke + contract tests
npm run lint   # scripts/lint.mjs — frontmatter + wikilink validation
```

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

```bash
# 1. Bump the version (writes package.json + CHANGELOG.md)
node scripts/bump-version.mjs <patch|minor|major>

# 2. Review the diff and edit CHANGELOG.md if needed
git diff

# 3. Commit
git add package.json CHANGELOG.md
git commit -m "chore: release v<version>"

# 4. Tag and push
git tag v<version>
git push origin main --tags
```

The `release.yml` workflow then:

1. Verifies the tag matches `package.json` version.
2. Runs `npm test` and `npm run lint`.
3. Publishes to npm with `npm publish --access public --provenance`.

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
