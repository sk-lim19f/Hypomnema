# Hypomnema — Architecture

## Overview

Hypomnema is an LLM-native personal wiki that runs as a Claude Code extension. It has three runtime layers:

1. **Slash commands** — LLM-driven operations triggered by `/hypo:*` in Claude Code
2. **Lifecycle hooks** — background automation triggered by Claude Code events
3. **Wiki vault** — a local markdown directory that serves as the persistent knowledge store

---

## Package layout

```
hypomnema/
├── commands/          ← slash command definitions (.md prompts)
├── hooks/             ← lifecycle hooks deployed to ~/.claude/hooks/
│   ├── wiki-shared.mjs   ← shared utilities (inlined at deploy; no external imports)
│   └── hooks.json        ← hook-to-event registry
├── scripts/           ← command implementations called by slash commands
│   └── lib/           ← shared helpers (frontmatter, wiki-root, wiki-ignore)
├── skills/            ← Agent Skills (skills/<name>/SKILL.md) for /hypo:* commands
├── templates/         ← baseline wiki files copied on init
├── tests/
│   └── runner.mjs     ← no-dependency test runner
└── docs/              ← PRIVACY.md, ARCHITECTURE.md, CONTRIBUTING.md
```

---

## Slash commands

Each command is a pair:

| File | Role |
|------|------|
| `commands/<name>.md` | Prompt definition — instructions Claude follows when the command is invoked |
| `scripts/<name>.mjs` | Script implementation — Node.js logic called by the command |

Commands: `init`, `ingest`, `query`, `crystallize`, `resume`, `feedback`, `verify`, `stats`, `graph`, `lint`, `doctor`, `upgrade`, `uninstall`.

---

## Lifecycle hooks

Hooks run automatically at Claude Code lifecycle events. They are deployed to `~/.claude/hooks/` by `init`/`upgrade`.

### Event map (`hooks/hooks.json`)

| Event | Hooks |
|-------|-------|
| `SessionStart` | `wiki-session-start.mjs` |
| `UserPromptSubmit` | `wiki-first-prompt.mjs`, `wiki-lookup.mjs`, `wiki-compact-guard.mjs` |
| `PreCompact` | `personal-wiki-check.mjs` |
| `PostToolUse` | `wiki-auto-stage.mjs` |
| `Stop` | `wiki-hot-rebuild.mjs`, `wiki-auto-commit.mjs` |
| `CwdChanged` | `wiki-cwd-change.mjs` |
| `FileChanged` | `wiki-file-watch.mjs` |

### Hook responsibilities

- **wiki-session-start** — injects wiki index and active project context at session open
- **wiki-first-prompt** — injects session-state for the active project on the first user prompt
- **wiki-lookup** — resolves `[[wikilink]]` references in prompts to actual page content
- **wiki-compact-guard** — blocks `/compact` if the session-close checklist is incomplete
- **personal-wiki-check** — pre-compact validation: uncommitted changes, log integrity
- **wiki-auto-stage** — stages modified wiki files after tool use
- **wiki-hot-rebuild** — rewrites `hot.md` at session end based on recent activity
- **wiki-auto-commit** — commits and pushes staged wiki changes at session stop
- **wiki-cwd-change** — re-resolves active project when the working directory changes
- **wiki-file-watch** — watches for external wiki edits and re-indexes changed pages

### Deployment constraint

Hooks run in an isolated environment at `~/.claude/hooks/`. They **cannot import from relative paths** outside their own directory. As a result, `wiki-shared.mjs` is copied alongside each hook at deploy time. All shared utilities must remain self-contained in that file.

---

## Shared utilities (`hooks/wiki-shared.mjs`)

Core helpers used across hooks and scripts:

| Export | Purpose |
|--------|---------|
| `WIKI_DIR` | Resolved wiki root path |
| `PKG_ROOT` | Package install path, read from `~/.claude/hypo-pkg.json` |
| `resolveWikiRoot()` | `HYPO_DIR` env → `hypo-config.md` scan → `~/wiki` fallback |
| `loadWikiIgnore()` | Parses `.wikiignore` into pattern list |
| `isIgnored()` | Tests a file path against `.wikiignore` patterns |
| `wikiIsClean()` | Checks git status + unpushed commits |
| `hotMdIsClean()` | Validates `hot.md` structure |
| `isCompactCommand()` | Detects `/compact` invocations |
| `buildOutput()` | Formats hook output for Claude Code's `additionalContext` channel |

---

## Scripts lib (`scripts/lib/`)

Helpers used by command scripts (not deployed to hooks):

| File | Purpose |
|------|---------|
| `frontmatter.mjs` | Parse and serialize YAML frontmatter |
| `wiki-root.mjs` | Wiki root resolution (mirrors hook logic, allows imports) |
| `wiki-ignore.mjs` | `.wikiignore` parsing (mirrors hook logic, allows imports) |

---

## Wiki vault layout

```
<wiki-root>/
├── hypo-config.md      ← root marker + settings
├── index.md            ← searchable page catalog
├── hot.md              ← active project pointers
├── log.md              ← append-only activity log
├── SCHEMA.md           ← type system reference
├── wiki-guide.md       ← operations guide
├── .wikiignore         ← privacy/exclusion patterns
├── pages/              ← permanent knowledge pages
├── projects/           ← per-project session artifacts
│   └── <name>/
│       ├── hot.md          ← project-level status
│       └── session-state.md← next tasks + last session summary
└── sources/            ← raw ingested sources (append-only)
```

`hypo-config.md` presence is the wiki root marker. `resolveWikiRoot()` scans candidate directories for it.

---

## Init and upgrade flow

1. **Init** (`/hypo:init`):
   - Wizard collects wiki path, privacy mode, hook preferences
   - Creates vault directory structure
   - Copies `templates/` files
   - Deploys hooks to `~/.claude/hooks/` (and optionally `~/.codex/hooks/`)
   - Merges hook entries into `~/.claude/settings.json` (idempotent)
   - Writes `~/.claude/hypo-pkg.json` with `pkgRoot` for future upgrades

2. **Upgrade** (`/hypo:upgrade`):
   - Reads `pkgRoot` from `~/.claude/hypo-pkg.json`
   - Re-deploys hooks from the new package version
   - Re-merges `settings.json` entries

---

## Data flow: ingest

```
source (URL / file / paste)
  → LLM reads + synthesizes
  → check index.md for existing related pages
  → update existing page OR create new page in pages/
  → append raw source to sources/<slug>.md
  → update index.md + log.md
```

## Data flow: query

```
user question
  → search index.md + page frontmatter
  → load candidate pages
  → LLM synthesizes grounded answer with [[wikilink]] citations
```

---

## Privacy

`.wikiignore` controls which files hooks include in context. Three built-in modes (`personal`, `shared`, `public`) set default patterns at init time. See [PRIVACY.md](PRIVACY.md).

---

## Testing

```bash
npm test        # tests/runner.mjs — unit + smoke tests, no external deps
npm run lint    # scripts/lint.mjs — frontmatter + wikilink validation
```
