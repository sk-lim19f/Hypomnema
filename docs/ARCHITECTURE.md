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
│   ├── hypo-shared.mjs   ← shared utilities (inlined at deploy; no external imports)
│   └── hooks.json        ← hook-to-event registry
├── scripts/           ← command implementations called by slash commands
│   └── lib/           ← shared helpers (frontmatter, hypo-root, hypo-ignore)
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
| `SessionStart` | `hypo-session-start.mjs` |
| `UserPromptSubmit` | `hypo-first-prompt.mjs`, `hypo-lookup.mjs`, `hypo-compact-guard.mjs` |
| `PreCompact` | `hypo-personal-check.mjs` |
| `PostToolUse` | `hypo-auto-stage.mjs` |
| `Stop` | `hypo-hot-rebuild.mjs`, `hypo-auto-commit.mjs` |
| `CwdChanged` | `hypo-cwd-change.mjs` |
| `FileChanged` | `hypo-file-watch.mjs` |

### Hook responsibilities

- **hypo-session-start** — injects wiki index and active project context at session open
- **hypo-first-prompt** — injects session-state for the active project on the first user prompt
- **hypo-lookup** — resolves `[[wikilink]]` references in prompts to actual page content
- **hypo-compact-guard** — blocks `/compact` if the session-close checklist is incomplete
- **hypo-personal-check** — pre-compact validation: uncommitted changes, log integrity
- **hypo-auto-stage** — stages modified wiki files after tool use
- **hypo-hot-rebuild** — rewrites `hot.md` at session end based on recent activity
- **hypo-auto-commit** — commits and pushes staged wiki changes at session stop
- **hypo-cwd-change** — re-resolves active project when the working directory changes
- **hypo-file-watch** — watches for external wiki edits and re-indexes changed pages

### Deployment constraint

Hooks run in an isolated environment at `~/.claude/hooks/`. They **cannot import from relative paths** outside their own directory. As a result, `hypo-shared.mjs` is copied alongside each hook at deploy time. All shared utilities must remain self-contained in that file.

---

## Shared utilities (`hooks/hypo-shared.mjs`)

Core helpers used across hooks and scripts:

| Export | Purpose |
|--------|---------|
| `HYPO_DIR` | Resolved wiki root path |
| `PKG_ROOT` | Package install path, read from `~/.claude/hypo-pkg.json` |
| `resolveHypoRoot()` | `HYPO_DIR` env → `hypo-config.md` scan → `~/hypomnema` fallback |
| `loadHypoIgnore()` | Parses `.hypoignore` into pattern list |
| `isIgnored()` | Tests a file path against `.hypoignore` patterns |
| `hypoIsClean()` | Checks git status + unpushed commits |
| `hotMdIsClean()` | Validates `hot.md` structure |
| `isCompactCommand()` | Detects `/compact` invocations |
| `buildOutput()` | Formats hook output for Claude Code's `additionalContext` channel |

---

## Scripts lib (`scripts/lib/`)

Helpers used by command scripts (not deployed to hooks):

| File | Purpose |
|------|---------|
| `frontmatter.mjs` | Parse and serialize YAML frontmatter |
| `hypo-root.mjs` | Wiki root resolution (mirrors hook logic, allows imports) |
| `hypo-ignore.mjs` | `.hypoignore` parsing (mirrors hook logic, allows imports) |

---

## Wiki vault layout

```
<hypo-root>/
├── hypo-config.md      ← root marker + settings
├── index.md            ← searchable page catalog
├── hot.md              ← active project pointers
├── log.md              ← append-only activity log
├── SCHEMA.md           ← type system reference
├── hypo-guide.md       ← operations guide
├── .hypoignore         ← privacy/exclusion patterns
├── pages/              ← permanent knowledge pages
├── projects/           ← per-project session artifacts
│   └── <name>/
│       ├── hot.md          ← project-level status
│       └── session-state.md← next tasks + last session summary
└── sources/            ← raw ingested sources (append-only)
```

`hypo-config.md` presence is the wiki root marker. `resolveHypoRoot()` scans candidate directories for it.

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

`.hypoignore` controls which files hooks include in context. Three built-in modes (`personal`, `shared`, `public`) set default patterns at init time. See [PRIVACY.md](PRIVACY.md).

---

## Testing

```bash
npm test        # tests/runner.mjs — unit + smoke tests, no external deps
npm run lint    # scripts/lint.mjs — frontmatter + wikilink validation
```
