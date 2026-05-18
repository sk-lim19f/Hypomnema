English | [한국어](README.ko.md)

<p align="center">
  <img src="docs/assets/logo/wordmark.svg" alt="Hypomnema" width="520">
</p>

# Hypomnema

[![npm version](https://img.shields.io/npm/v/hypomnema?color=cb3837)](https://www.npmjs.com/package/hypomnema)
[![npm downloads](https://img.shields.io/npm/dm/hypomnema?color=blue)](https://www.npmjs.com/package/hypomnema)
[![Node.js](https://img.shields.io/node/v/hypomnema?color=43853d&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/sk-lim19f/Hypomnema/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sk-lim19f/Hypomnema/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/sk-lim19f/Hypomnema?style=flat&color=yellow)](https://github.com/sk-lim19f/Hypomnema/stargazers)

**LLM-native personal wiki for Claude Code. Knowledge that compounds.**

_Make Claude take notes — and measure whether it actually does._

[Quick Start](#quick-start) • [How It Compares](#how-it-compares) • [Design Decisions](#design-decisions) • [Features](#features) • [Architecture](docs/ARCHITECTURE.md) • [Contributing](docs/CONTRIBUTING.md)

> Inspired by Andrej Karpathy's "LLM-native wiki" sketch and shaped by ten months of personal use, Hypomnema ships the full lifecycle — capture, synthesis, retrieval, session-resume — as Claude Code commands and lifecycle hooks.

> **Current state vs. v2 vision.** v1.0.1 (today) is honest about its trigger model: most wiki behavior — ingest, query, session-close — fires on **explicit `/hypo:*` commands**, with a handful of hooks providing auto-staging, session-state injection, and lookup signals. The v2 thesis is *fully autonomous* — Claude reading, writing, and synthesizing the wiki without being asked. **v1.1.0** is the first step on that ramp: instead of claiming auto-behavior, it ships an **observability score** that measures how often the wiki is actually used per session (ingest count, query count, session-close rate, citation rate) so you can see the auto-vs-manual ratio with your own eyes before the v2 work lands.

---

## Quick Start

Hypomnema ships **two install paths**. Pick one — both end up with the same wiki, hooks, and `/hypo:*` slash commands.

### Path A — Claude Code plugin (recommended)

Inside Claude Code:

```
/plugin marketplace add sk-lim19f/Hypomnema
/plugin install hypomnema@hypomnema
/hypo:init
```

The plugin install registers `/hypo:*` commands from the package's `commands/` directory; `/hypo:init` then scaffolds the wiki and merges hooks into `~/.claude/settings.json`.

### Path B — npm CLI

In your shell:

```bash
npm install -g hypomnema
hypomnema
```

`hypomnema` (or `hypomnema --help` for flags) scaffolds the wiki, installs hooks, **and** copies the slash command files to `~/.claude/commands/hypo/` so `/hypo:*` works inside Claude Code afterwards. Subsequent `hypomnema upgrade` runs use per-file SHA tracking to avoid clobbering anything you have hand-edited.

> Either path: restart Claude Code (or open a new session) after the first run so the new hooks and slash commands are picked up.

### Step 2: use it

```
/hypo:ingest https://example.com/some-article-or-paper.pdf
/hypo:query  "summarize what I know about X"
/hypo:feedback "always include test commands when explaining a fix"
```

Hooks handle the rest — auto-staging, auto-commit/push, session-state injection, lookup signals.

> **Sync across machines:** the wiki is already a git repo. Add a remote, push once, and the `Stop` hook will keep every machine in sync afterwards.

---

## Why Hypomnema

Personal knowledge tools fall into four buckets, and each one breaks at a different place:

| | Pain | Why it doesn't compound |
|---|---|---|
| **Note vaults** (markdown-based, local-first) | Manual capture, manual linking, manual rereading | Each note stays independent; no synthesis |
| **Cloud knowledge platforms** (page/database hybrids) | Fast capture, slow retrieval | Search is keyword-first; LLM has no native access |
| **RAG / vector-search stacks** | Pipelines, embeddings, chunking | Returns chunks, not synthesized knowledge; chunks multiply forever |
| **AI-native notebooks** (proprietary "second brain" apps) | Feels magical at first | Closed format, no git, retrieval logic is opaque, vendor lock-in |
| **Code-only wikis** (auto-generated from a repo) | Zero manual effort | Limited to code; can't capture decisions, research, AI behavior corrections |

Hypomnema lives in the gap between them: **structured synthesis on top of plain markdown, driven by Claude Code's lifecycle, version-controlled by git, and local-first by default.**

```
Note vaults        ───►  store everything, synthesize nothing
Cloud platforms    ───►  capture fast, retrieve slow
RAG / vector DBs   ───►  retrieve chunks, never pages
AI notebooks       ───►  black box, no git, no portability
Code wikis         ───►  code only, no decisions / research / feedback

Hypomnema          ───►  synthesis · markdown · git · hooks · local
```

---

## How It Compares

| | **Hypomnema** | Note vault | Cloud platform | RAG / vector DB | AI notebook | Code wiki |
|---|---|---|---|---|---|---|
| **Capture effort** | Paste a URL → done | Manual typing | Manual typing | Upload + embed pipeline | Paste / chat | Auto from repo |
| **Storage unit** | Synthesized **page** | Note | Page / block | Vector chunk | Opaque memory | Code symbol |
| **Knowledge growth** | New sources **update** existing pages | Each note stays independent | Each page stays independent | Chunks multiply forever | Black box | Fixed by repo |
| **Retrieval** | LLM synthesizes a grounded answer | Full-text / backlinks | Keyword search | Nearest-neighbour chunks | Opaque | Code search |
| **Session continuity** | Auto-resume via `hot.md` + `session-state.md` | None | None | None | Sometimes | None |
| **Workflow integration** | Native to Claude Code | Separate app | Separate app / browser tab | Separate service | Separate app | Separate site |
| **Format** | Plain markdown + frontmatter | Markdown | Proprietary | Vector store | Proprietary | HTML |
| **Backend** | Local file + git | Local file | SaaS | Service / DB | SaaS | Service |
| **Behavior tuning** | `/hypo:feedback` → permanent rules | None | None | None | Sometimes | None |
| **Auto-behavior** | Explicit `/hypo:*` triggers today; **v1.1 ships an observability score**, v2 target = fully autonomous | None | None | None | Black box | None |
| **Setup cost** | One command | One install | Sign-up | Pipeline build | Sign-up | Repo connect |
| **Lock-in** | Zero (markdown + git) | Low | High | Medium | High | Medium |

### What this trade-off buys you

- **Synthesis, not storage.** You don't end up with a graveyard of half-read articles. Each `/hypo:ingest` produces a structured page; subsequent ingests on the same topic *update* that page.
- **Compounding density.** A wiki with 100 sources should not have 100 disconnected pages. After three months of real use, page count grows sub-linearly while cross-links grow super-linearly.
- **Zero context switch.** You're already in Claude Code. The wiki is one slash command away — not another tab, another app, another login.
- **Future-proof storage.** Plain markdown + git means: you can read it in 20 years, you can grep it offline, you can move providers anytime, and AI assistants you haven't met yet will still understand it.

---

## Design Decisions

Why each choice looks the way it does:

### 1. Why **synthesis** instead of RAG over chunks

RAG is excellent for *unfamiliar* corpora — give it a million-page legal archive and it will find relevant fragments. For *personal* knowledge, the failure mode is the opposite:

- The corpus is small but **highly redundant** (3 articles on the same topic).
- The user wants a **point of view**, not a passage.
- Chunk count grows linearly with capture, even when knowledge doesn't.

Hypomnema treats the page — not the chunk — as the unit of knowledge. New sources reconcile against the page. The result reads like a wiki article, because that's what it is.

### 2. Why **markdown + git** instead of a proprietary store

A personal knowledge base must outlive any single tool. Markdown survives. Git survives. Both are LLM-native (every model can read them). Both run offline. Both have 30 years of tooling behind them. We deliberately picked the boring stack because the interesting part is *what Claude does with it*.

### 3. Why **lifecycle hooks** instead of manual commands

Friction is the silent killer of personal knowledge systems. If saving a thought requires three clicks, you stop. Hypomnema piggybacks on events Claude Code already emits:

| Event | What you'd otherwise do manually |
|---|---|
| `SessionStart` | "Where did I leave off?" — read `hot.md` / `session-state.md` |
| `UserPromptSubmit` | "Do I already know this?" — BM25 lookup, top-3 inject |
| `PreCompact` | "Did I forget to write a session log?" — checklist guard |
| `PostToolUse` (Write/Edit) | `git add` |
| `Stop` | `git pull --rebase && git commit && git push` |

Once installed, you stop *managing* the wiki. It just accumulates.

### 4. Why a **`hot.md` cache** for resume

The most expensive operation in a paused project isn't doing the work — it's **rebuilding context**. Reading `session-log/` from scratch costs minutes and tokens; reading a one-page `hot.md` costs neither. So we cache the most recent state explicitly, rebuild it on `Stop`, and inject it on `SessionStart`. Resume is O(1).

### 5. Why a **feedback → behavior** pipeline

Most AI tools accept corrections *for the current conversation*. They never persist. Hypomnema funnels every `/hypo:feedback` into `pages/feedback/`, and durable rules are promoted into `CLAUDE.md`'s `<learned_behaviors>` block — where they survive every future session, on every machine that pulls the wiki.

### 6. Why **no API keys, no vector DB, no service**

Every external dependency is a future-failure mode: it breaks, it's bought, it's deprecated, it leaks credentials. Hypomnema is a Node.js script + markdown files + git. That is the entire stack. The only "AI" piece is Claude itself, which you're running anyway.

### 7. Why **`.hypoignore`** instead of a privacy mode flag

We tried a `personal / shared / public` mode matrix in v1.0. It didn't survive contact with reality — every privacy decision was a per-path question, and a single file (`.hypoignore`) handles per-path decisions natively. v1.1 deletes the mode concept entirely. One file, one source of truth.

---

## Features

### Synthesis primitives

Eight commands cover the full capture → retrieval → consolidation cycle.

| Command | What it does | When to reach for it |
|---|---|---|
| `/hypo:ingest` | Saves the raw source under `sources/`; Claude synthesizes a structured page under `pages/`. The shell helper (`scripts/ingest.mjs`) is read-only — it only *lists* pending sources so you know what still needs ingesting | Anytime you read something worth keeping |
| `/hypo:query` | BM25 retrieval + LLM synthesis with `[[wikilink]]` citations | When you need an answer grounded in your own notes |
| `/hypo:crystallize` | Runs the session-close checklist (steps 1~6) and, on request, synthesizes drafts (steps 7~11) | End of a non-trivial session |
| `/hypo:resume` | Loads the most recent session state for an active project | Coming back to a paused project |
| `/hypo:feedback` | Records an AI behavior correction; eligible for promotion to permanent rules | Right when Claude does something wrong (or exactly right) |
| `/hypo:verify` | Audits pages with `verify_by` frontmatter | When time-bound knowledge might have aged out |
| `/hypo:lint` | Validates frontmatter, wikilinks, schema | Before commits, in CI |
| `/hypo:graph` | Generates a wikilink dependency graph | When you want to see structural growth |

### Lifecycle hooks (10)

| Hook | Event | Role |
|---|---|---|
| `hypo-session-start.mjs` | `SessionStart` | Inject `hot.md` / `session-state.md` + `git pull --ff-only` |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | Marker-based one-shot `hot.md` injection (10-min TTL) |
| `hypo-lookup.mjs` | `UserPromptSubmit` | BM25 top-3 HIT inject / MISS → closest-slug signal |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | Detect `/compact` → enforce session-close checklist |
| `hypo-cwd-change.mjs` | `CwdChanged` | Inject the matching project's `hot.md` |
| `hypo-file-watch.mjs` | `FileChanged` | Notify on wiki-file changes (honors `.hypoignore` — matched paths are never re-emitted into LLM context) |
| `hypo-auto-stage.mjs` | `PostToolUse(Write/Edit)` | Auto-stage wiki-file edits |
| `hypo-auto-commit.mjs` | `Stop` | Auto commit + pull + push |
| `hypo-hot-rebuild.mjs` | `Stop` | Rebuild `hot.md` |
| `hypo-personal-check.mjs` | `PreCompact` | Block compact on lint failures or unfinished session-close |

All hooks resolve the wiki root via `HYPO_DIR` env → `hypo-config.md` scan → `~/hypomnema` default, and share `hypo-shared.mjs` (declared via `hooks.json`'s `shared` field).

### Setup & maintenance

| Command | Purpose |
|---|---|
| `/hypo:init` | First-time install (dirs, hooks, settings.json merge, first commit/push) |
| `/hypo:doctor` | Health check (hooks, paths, frontmatter, git) |
| `/hypo:upgrade` | Migrate hooks/config to the latest version |
| `/hypo:uninstall` | Remove hooks and registrations |
| `/hypo:stats` | Wiki statistics |

### Claude Agent Skills

The synthesis-heavy commands (`ingest`, `query`, `crystallize`, `lint`, `verify`, `graph`) are also exposed as **Claude Agent Skills** in `skills/<name>/SKILL.md`, so they auto-trigger when the conversation matches their description — no slash command required.

---

## Scenarios

**A — Learning a new technology.**
You're reading Kubernetes docs and blog posts. Drop each URL into `/hypo:ingest`. By the third article, Claude is updating your existing `kubernetes-networking.md` rather than creating another page. A week later, `/hypo:query "how does pod CIDR allocation work?"` returns a synthesized answer citing your own notes.

**B — Tracking engineering decisions.**
Before merging a significant change, run `/hypo:ingest` on the design doc or PR description. Claude creates an ADR-style page with context, tradeoffs, and the decision. Future `[[wikilink]]` references pull the rationale directly into any prompt that asks about it.

**C — Research accumulation.**
You're working through papers on a topic over several weeks. Each `/hypo:ingest` synthesizes the paper and cross-links it. At any point, `/hypo:query` returns a literature-review-style summary grounded in your own notes.

**D — Tuning AI behavior.**
Run `/hypo:feedback` whenever Claude does something wrong or exactly right. The correction is stored in `pages/feedback/` and injected at session start, so the same mistake doesn't happen twice — across sessions, not just within one conversation.

**E — Resuming a paused project.**
You put a project down for three weeks. At the next session start, `hypo-session-start.mjs` reads `projects/<name>/session-state.md` and injects "next tasks" and recent decisions directly into context. You're back up to speed before you type the first prompt.

---

## What goes in your wiki

**Store here:**

- Synthesized knowledge from external sources (docs, papers, talks)
- Architecture decisions and their rationale
- AI behavior corrections and preferences
- Project context that doesn't belong in git (stakeholder constraints, open questions, background)
- Research findings and cross-source comparisons

**Do not store here:**

- Raw source material — that goes in `sources/` automatically, unedited
- Credentials, tokens, or secrets — use `.hypoignore` to exclude sensitive paths
- Transient task lists for the current session — use the conversation's task list
- Code patterns derivable from the repo itself — `git log` and `grep` are already authoritative
- Information with a canonical owner elsewhere (Jira, Confluence, API docs) — ingest a *synthesis*, not a mirror

---

## Directory layout

```
<wiki-root>/
├── hypo-config.md       ← root marker + settings
├── index.md             ← searchable page catalog
├── hot.md               ← active project pointers
├── log.md               ← append-only activity log
├── SCHEMA.md            ← type system reference
├── hypo-guide.md        ← operations guide
├── .hypoignore          ← glob patterns excluded from hooks
├── pages/               ← permanent knowledge pages
│   └── feedback/        ← AI behavior corrections
├── projects/            ← project artifacts and session logs
│   └── <name>/
│       ├── hot.md
│       ├── session-state.md
│       └── session-log/
├── journal/             ← daily / weekly / monthly entries
└── sources/             ← raw ingested sources (never edit)
```

---

## Configuration

The wiki path is resolved in this order (see `scripts/lib/hypo-root.mjs`):

| Priority | Source |
|---|---|
| 1 | `--hypo-dir=<path>` CLI flag (per-script override; only honored by scripts that accept it) |
| 2 | `HYPO_DIR` environment variable |
| 3 | `hypo-config.md` marker discovered in a fixed list of home-relative candidates (`~/hypomnema`, `~/wiki`, `~/notes`, `~/knowledge`, `~/Documents/{hypomnema,wiki,notes}`) |
| 4 | Default: `~/hypomnema` |

Place a `hypo-config.md` at the wiki root to make it portable across machines without setting environment variables.

`.hypoignore` controls which paths the hooks ignore (default: `*.pdf`, `*.zip`, `*.pem`, `*.env`, …). Edit it directly — there is no privacy mode flag; one file, one source of truth.

> **Provider transmission disclaimer.** Hypomnema hooks emit wiki content into Claude Code's `additionalContext`, which is transmitted to the Claude model provider as part of the prompt. `.hypoignore` is enforced at every content-injection hook (`hypo-file-watch`, `hypo-session-start`, `hypo-cwd-change`, `hypo-lookup`) and at `ingest`, but any file *not* matched by `.hypoignore` is fair game for transmission. (`hypo-auto-stage` and `hypo-auto-commit` are git-staging hooks, not injection points, and also honor `.hypoignore` for their staging decisions.) Keep secrets out of the wiki, and review `.hypoignore` patterns before storing anything sensitive under `HYPO_DIR`.

> **Scope of git sync.** Hypomnema git-syncs only the `~/hypomnema/` wiki itself. Your Claude Code configuration (`~/.claude/`) is intentionally **not** managed by Hypomnema — for cross-machine sync of agents, skills, and settings, the recommended pattern is a separate dotfiles manager such as [chezmoi](https://www.chezmoi.io/).

### Where do `/hypo:*` commands live?

| Install path | Slash commands served from |
|---|---|
| Plugin (Path A) | Claude Code's plugin cache; updated via `/plugin update` |
| npm CLI (Path B) | `~/.claude/commands/hypo/`; updated via `hypomnema upgrade --apply` with per-file SHA tracking. Pass `--force-commands` to overwrite hand-edits (creates `.bak`). |

---

## Requirements

- **Node.js ≥ 18** (tested on 18 / 20 / 22)
- **Claude Code CLI**

No external services. No API keys. No vector databases.

---

## Status

- **Tests:** see `npm test` — exact totals shift as lanes ship, so the runner is the source of truth
- **CI:** 7 independent jobs (test matrix, lint, init/upgrade snapshots, replay, hypo-absent, uninstall-smoke)
- **Release:** `npm publish --provenance` on `v*` tag push

---

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — internals, component map, data flows
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — development setup, conventions, PR process
- [CHANGELOG.md](CHANGELOG.md) — release history

---

## License

MIT
