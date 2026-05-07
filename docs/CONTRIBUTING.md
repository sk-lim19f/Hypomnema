# Contributing to Hypomnema

## Requirements

- Node.js ≥ 18
- Claude Code CLI (for end-to-end testing)

No build step. The package is plain ESM.

---

## Setup

```bash
git clone https://github.com/sk-lim19f/Hypomnema.git
cd Hypomnema
npm install   # no runtime deps; installs dev tooling only
npm test      # verify baseline
```

---

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full breakdown. The short version:

| Directory | What to touch |
|-----------|---------------|
| `commands/` | Prompt definitions for `/hypo:*` slash commands |
| `scripts/` | Node.js implementations called by commands |
| `scripts/lib/` | Shared helpers for scripts (frontmatter, wiki-root, wikiignore) |
| `hooks/` | Claude Code lifecycle hooks + `hooks.json` registry |
| `hooks/wiki-shared.mjs` | Shared hook utilities — see deployment constraint below |
| `templates/` | Baseline files copied into new wiki vaults on init |
| `tests/runner.mjs` | Test suite |
| `docs/` | Documentation |

---

## Hook deployment constraint

Hooks are deployed to `~/.claude/hooks/` and **run in isolation** — they cannot import from relative paths. All shared logic lives in `hooks/wiki-shared.mjs`, which is copied alongside each hook at deploy time. If you add a utility that hooks need, add it to `wiki-shared.mjs`. Do not create additional shared files that hooks import.

Scripts in `scripts/` are not subject to this constraint and can import from `scripts/lib/`.

---

## Making changes

### Adding or modifying a slash command

1. Edit `commands/<name>.md` — the LLM-facing prompt.
2. Edit `scripts/<name>.mjs` — the Node.js logic.
3. If the command is new, add a skill wrapper in `skills/` and register it in `package.json` if needed.
4. Update `README.md` command table if the command is user-facing.

### Adding or modifying a hook

1. Edit the hook file in `hooks/`.
2. If it's a new hook, add it to `hooks/hooks.json` under the correct event key.
3. If the hook needs shared utilities, add them to `hooks/wiki-shared.mjs`.
4. Test by running `npm test` and manually running `/hypo:upgrade` in a Claude Code session.

### Modifying `wiki-shared.mjs`

This file is deployed verbatim to `~/.claude/hooks/`. Keep it self-contained:
- Only Node.js built-ins (`fs`, `path`, `os`, `child_process`)
- No relative imports
- No npm dependencies

### Adding a template file

Drop the file in `templates/` and update `commands/init.md` to include it in the copy step.

---

## Testing

```bash
npm test       # unit + smoke tests (tests/runner.mjs, no external deps)
npm run lint   # frontmatter + wikilink validation
```

The test runner uses only Node.js built-ins. Tests create temporary directories and clean up after themselves.

When adding a feature, add a corresponding test in `tests/runner.mjs`. For hook changes that are hard to unit-test, document a manual verification step in the PR description.

---

## Branch and commit conventions

- One logical change per branch.
- Branch names: `fix/<topic>`, `feat/<topic>`, `docs/<topic>`, `refactor/<topic>`.
- Commit messages: imperative, lowercase subject line, ≤ 72 characters.
  - Good: `fix: resolve wiki root when HYPO_DIR contains ~`
  - Bad: `Fixed the bug with the wiki root path resolution issue`
- For non-trivial changes, get a second review (e.g. via `omc-teams:2 codex`) before merging.

---

## Submitting a PR

1. Run `npm test` and `npm run lint` — both must pass.
2. If you changed a hook, manually test the affected lifecycle event in Claude Code.
3. If you changed `wiki-shared.mjs`, verify the deployed copy works after `/hypo:upgrade`.
4. Open the PR against `main`. Include what was changed and why, plus any manual verification steps.

---

## What not to do

- Don't add npm runtime dependencies. The package intentionally has none.
- Don't add external imports to hook files.
- Don't edit files under `templates/` to fix bugs — fix the source in `scripts/` or `hooks/` and let init/upgrade propagate the change.
- Don't commit `~/.claude/hypo-pkg.json` or any user-specific config.
