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

LLM-native personal wiki for Claude Code. Knowledge that compounds.

Make Claude take notes, and measure whether it actually does.

[Quick Start](#quick-start) • [How It Compares](#how-it-compares) • [Design Decisions](#design-decisions) • [Features](#features) • [Architecture](docs/ARCHITECTURE.md) • [Contributing](docs/CONTRIBUTING.md)

Inspired by Andrej Karpathy's "LLM-native wiki" sketch, shaped by ten months of personal AI-workflow experiments and a month of dogfooding before the public release. Hypomnema ships the full lifecycle, from capturing a source to synthesizing, retrieving, and resuming a paused session, as Claude Code commands and lifecycle hooks.

New to the terms below? Keep the [Term decoder](#term-decoder) open in another tab. It defines frontmatter, wikilink, projection, hook, `hot.md`, and `session-state.md`, one line each.

### Where automation stands today

The current release is v1.5.1. It sharpens how the wiki signals its own freshness: a page whose `verify_by_date` has passed is flagged `[STALE ...]` at the moment it is injected, so a dated answer is visible instead of trusted silently, and lookup usage is tracked locally so crystallize can surface a linked-but-never-injected page as a cold candidate. The same release makes session close robust to the standard `session | project: title` colon log format that had been misread as stale. The v1.5.0 line turned to cross-machine reliability and everyday friction before it: `cwd`-first resume on a git-synced vault, a code-repo session told where the wiki lives, and session close no longer re-listing unrelated lint debt.

Wiki work (ingest, query, session-close) still starts from an explicit `/hypo:*` command or plain language. The v2 goal is full autonomy: Claude reading, writing, and synthesizing the wiki without being asked, which is the direction this is heading.

The lanes that already run on their own: v1.1.0 shipped the observability score that measures how often the wiki is used per session, and v1.2.0 added four automated areas on top.

- Edit feedback in one place and the rest follows. `pages/feedback/` is the single source of truth for behavior corrections, and Hypomnema derives `MEMORY.md` and the `<learned_behaviors>` block inside `~/.claude/CLAUDE.md` from it automatically.
- Extensions sync alongside. Anything under `~/hypomnema/extensions/{agents,commands,hooks,skills}/` is mirrored into `~/.claude/` automatically. The `--codex` flag also mirrors `hooks` and `commands` into `~/.codex/`; `agents` and `skills` are Claude-only and skipped on purpose.
- Auto-project creation. When you `cd` into a git repo with a project marker (`package.json`, `Cargo.toml`, etc.) and no matching wiki project exists, Hypomnema offers to scaffold one.
- Session-close cleanup and `/clear` recovery. After a non-trivial session, a "save a minimal session-close note?" prompt appears automatically; a `/clear` after a forgotten close is detected and recovered at the next session start.

What changed per version lives in the [CHANGELOG](CHANGELOG.md).

One upgrade policy worth knowing up front: `hypomnema upgrade --apply` never overwrites a `SCHEMA.md` you have edited. When the schema bumps, upgrade writes a migration report into the wiki root and leaves the actual changes for you to apply (the policy the code calls Option C).

---

## Quick Start

There are two install paths. Either one ends up with the same wiki, hooks, and `/hypo:*` slash commands.

### Path A: Claude Code plugin (recommended)

Inside Claude Code:

```
/plugin marketplace add sk-lim19f/Hypomnema
/plugin install hypo@hypomnema
/hypo:init
```

The plugin install registers `/hypo:*` commands from the package's `commands/` directory; `/hypo:init` then scaffolds the wiki and merges hooks into `~/.claude/settings.json`.

### Path B: npm CLI

In your shell:

```bash
npm install -g hypomnema
hypomnema
```

`hypomnema` (or `hypomnema --help` for flags) scaffolds the wiki and installs hooks. It also copies the slash command files to `~/.claude/commands/hypo/`, so `/hypo:*` works inside Claude Code afterwards. Later `hypomnema upgrade` runs use per-file SHA tracking, so anything you hand-edited stays put.

> Either path: restart Claude Code (or open a new session) after the first run so the new hooks and slash commands are picked up.

### Step 2: use it

```
/hypo:ingest https://example.com/some-article-or-paper.pdf
/hypo:query  "summarize what I know about X"
/hypo:feedback "always include test commands when explaining a fix"
```

Hooks handle the rest: auto-staging, auto-commit/push, session-state injection, and lookup signals.

> You don't have to memorize the commands. Describe what you want in plain language and the matching skill fires with no slash command: "save this article to the wiki" triggers `ingest`, "what do I know about X?" triggers `query`, "let's wrap up this session" triggers `crystallize`. See [Claude Agent Skills](#claude-agent-skills) for how it works.

> Sync across machines: the wiki is already a git repo. Add a remote, push once, and the `Stop` hook keeps every machine in sync afterwards.

---

## Why Hypomnema

Personal knowledge tools fall into five buckets. Each breaks at a different place.

| | Pain | Why it doesn't compound |
|---|---|---|
| Note vaults (markdown-based, local-first) | Manual capture, manual linking, manual rereading | Each note stays independent; no synthesis |
| Cloud knowledge platforms (page/database hybrids) | Fast capture, slow retrieval | Search is keyword-first; LLM has no native access |
| RAG / vector-search stacks | Pipelines, embeddings, chunking | Returns chunks, not synthesized knowledge; chunks multiply forever |
| AI-native notebooks (proprietary "second brain" apps) | Feels magical at first | Closed format, no git, opaque retrieval logic, vendor lock-in |
| Code-only wikis (auto-generated from a repo) | Zero manual effort | Limited to code; can't capture decisions, research, AI behavior corrections |

Hypomnema lives in the gap between them: structured synthesis on top of plain markdown, driven by Claude Code's lifecycle, version-controlled by git, local-first by default.

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

| | Hypomnema | Note vault | Cloud platform | RAG / vector DB | AI notebook | Code wiki |
|---|---|---|---|---|---|---|
| Capture effort | Paste a URL → done | Manual typing | Manual typing | Upload + embed pipeline | Paste / chat | Auto from repo |
| Storage unit | Synthesized page | Note | Page / block | Vector chunk | Opaque memory | Code symbol |
| Knowledge growth | New sources update existing pages | Each note stays independent | Each page stays independent | Chunks multiply forever | Black box | Fixed by repo |
| Retrieval | LLM synthesizes a grounded answer | Full-text / backlinks | Keyword search | Nearest-neighbour chunks | Opaque | Code search |
| Session continuity | Auto-resume via `hot.md` + `session-state.md` | None | None | None | Sometimes | None |
| Workflow integration | Native to Claude Code | Separate app | Separate app / browser tab | Separate service | Separate app | Separate site |
| Format | Plain markdown + frontmatter | Markdown | Proprietary | Vector store | Proprietary | HTML |
| Behavior tuning | `/hypo:feedback` → permanent rules | None | None | None | Sometimes | None |
| Auto-behavior | `/hypo:*` triggers + observability score (v1.1) + four autonomous lanes (v1.2); v2 target = fully autonomous | None | None | None | Black box | None |
| Setup cost | One command | One install | Sign-up | Pipeline build | Sign-up | Repo connect |
| Lock-in | Zero (markdown + git) | Low | High | Medium | High | Medium |

### What this trade-off buys you

- Synthesis over storage. You don't end up with a graveyard of half-read articles. Each `/hypo:ingest` produces a structured page, and the next ingest on the same topic updates that page instead of adding a new one.
- Compounding density. A wiki with 100 sources should not be 100 disconnected pages. After a few months of real use, page count grows sub-linearly while cross-links grow faster.
- No context switch. You're already in Claude Code. The wiki is one slash command away, with no extra tab, app, or login.
- Future-proof storage. Plain markdown + git will still be readable in 20 years, greps offline, moves to another tool anytime, and stays usable by AI assistants that don't exist yet, with no conversion needed.

---

## Term decoder

These are the recurring terms used in the rest of the README. Keep this table open in another tab while you skim.

| Term | Meaning in Hypomnema |
|---|---|
| frontmatter | The YAML block at the top of a markdown page: `title`, `type`, `tags`, etc. |
| wikilink | A `[[page-slug]]` cross-reference between pages; resolved at lint time |
| ADR | "Architecture Decision Record": a short markdown page recording _why_ a non-obvious design choice was made |
| schema | The type taxonomy and required-field rules in `SCHEMA.md`: what makes a page valid |
| lint | A read-only validator (`hypomnema lint`) that checks frontmatter, wikilinks, and schema |
| projection | A one-way automatic derivation: `pages/feedback/*.md` → `MEMORY.md` and CLAUDE.md `<learned_behaviors>` |
| SoT ("source of truth") | The single file you edit; projections derive from it, never the other way around |
| hook | A script Claude Code runs automatically on a lifecycle event (e.g. `SessionStart`, `Stop`) |
| lifecycle event | A point Claude Code surfaces to plugins: session opens, prompt submitted, tool used, compact requested, session ends, etc. |
| `hot.md` | Per-project cache: "what just happened" (most recent session highlights) |
| `session-state.md` | Per-project cache: "what's next" (the resume payload for the next session) |
| `.hypoignore` | Glob patterns that exclude paths from every content-injection hook and from `ingest` |
| observability score | A per-session metric (search / ingest / feedback activity) that measures whether the wiki is actually being used |
| manifest | A small JSON the install scripts write to track exactly which files were installed and at what SHA |
| `additionalContext` | The Claude Code hook field that injects extra context into the prompt: where content-injection hooks emit |
| byte-equal | A file that comes out of `--apply` bit-for-bit identical to before: the strongest "we did not touch this" guarantee |
| BM25 | A classic full-text ranking algorithm; powers the `/hypo:query` MISS-resistant lookup |
| Option C | The policy that `hypomnema upgrade --apply` never overwrites your `SCHEMA.md`: it only writes a migration report you apply by hand |

If a term you hit later in the README is missing here, that is a documentation bug. Please open an issue.

---

## Design Decisions

Why each choice looks the way it does.

### 1. Why synthesis instead of RAG over chunks

RAG is excellent for _unfamiliar_ corpora: give it a million-page legal archive and it will find relevant fragments. For _personal_ knowledge, the failure mode is the opposite.

- The corpus is small but highly redundant (3 articles on the same topic).
- The user wants a point of view, not a passage.
- Chunk count grows linearly with capture, even when knowledge doesn't.

Hypomnema treats the page, not the chunk, as the unit of knowledge. A new source updates the relevant page if one exists and creates a new one if not. The result reads like a wiki article, because that's what it is.

### 2. Why markdown + git instead of a proprietary store

A personal knowledge base has to outlive any single tool. Markdown survives. Git survives. Both are LLM-native (every model can read them), both run offline, and both have 30 years of tooling behind them. We picked the boring stack on purpose, because the interesting part is _what Claude does with it_.

### 3. Why lifecycle hooks instead of manual commands

Friction kills personal knowledge systems. If saving a thought takes three clicks, you stop saving thoughts. Hypomnema piggybacks on events Claude Code already emits.

| Event | What you'd otherwise do by hand |
|---|---|
| `SessionStart` | "Where did I leave off?" reading `hot.md` / `session-state.md` |
| `UserPromptSubmit` | "Do I already know this?" a BM25 lookup, top-3 inject |
| `PreCompact` | "Did I close the session?" the checklist guard |
| `PostToolUse` (Write/Edit) | `git add` |
| `Stop` | `git pull --rebase && git commit && git push` |

Once installed, you stop _managing_ the wiki. It just accumulates.

### 4. Why a `hot.md` cache for resume

The most expensive part of a paused project isn't redoing the work, it's rebuilding context. Reading `session-log/` from scratch costs minutes and tokens; reading a one-page `hot.md` costs neither. So we cache the most recent state explicitly, rebuild it on `Stop`, and inject it on `SessionStart`. Resume is O(1).

### 5. Why a feedback → behavior pipeline

Most AI tools take corrections _for the current conversation only_. They never persist. Hypomnema funnels every `/hypo:feedback` into `pages/feedback/`, and durable rules are promoted into the `<learned_behaviors>` block in `CLAUDE.md`, where they survive every future session, on every machine that pulls the wiki.

### 6. Why no API keys, no vector DB, no service

Every external dependency is a future failure: it breaks, gets bought, gets deprecated, or leaks credentials. Hypomnema is a Node.js script + markdown files + git. That's the whole stack. The only "AI" piece is Claude itself, which you're running anyway.

### 7. Why `.hypoignore` instead of a privacy mode flag

v1.0 had a `personal / shared / public` mode matrix. It didn't survive contact with reality: every privacy decision turned out to be a per-path question, and a single file (`.hypoignore`) handles per-path decisions natively. v1.1 deleted the mode concept entirely. One file, one source of truth.

---

## Features

### Synthesis primitives

Nine commands cover the full capture → retrieval → consolidation cycle.

| Command | What it does | When to reach for it |
|---|---|---|
| `/hypo:ingest` | Saves the raw source under `sources/`; Claude synthesizes a structured page under `pages/`. The shell helper (`scripts/ingest.mjs`) is read-only and only _lists_ pending sources | Anytime you read something worth keeping |
| `/hypo:query` | BM25 retrieval + LLM synthesis with `[[wikilink]]` citations | When you need an answer grounded in your own notes |
| `/hypo:crystallize` | Runs the session-close checklist (steps 1-6) and, on request, synthesizes drafts (steps 7-11) | End of a non-trivial session |
| `/hypo:resume` | Loads the most recent session state for an active project | Coming back to a paused project |
| `/hypo:feedback` | Records an AI behavior correction; eligible for promotion to permanent rules | When Claude gets something wrong, or gets it exactly right |
| `/hypo:verify` | Audits pages with `verify_by` frontmatter | When time-bound knowledge might have aged out |
| `/hypo:lint` | Validates frontmatter, wikilinks, schema | Before commits, in CI |
| `/hypo:graph` | Generates a wikilink dependency graph | When you want to see how the structure grew |
| `/hypo:rename` | Renames a page or directory and rewrites inbound `[[wikilinks]]` | When a page or project folder needs a new name |

### Lifecycle hooks (14)

| Hook | Event | Role |
|---|---|---|
| `hypo-session-start.mjs` | `SessionStart` | Inject `hot.md` / `session-state.md` + `git pull --ff-only` |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | Marker-based one-shot `hot.md` injection (10-min TTL) |
| `hypo-lookup.mjs` | `UserPromptSubmit` | BM25 top-3 HIT inject / MISS → closest-slug signal |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | Detect `/compact` → enforce session-close checklist |
| `hypo-cwd-change.mjs` | `CwdChanged` | Inject the matching project's `hot.md` |
| `hypo-file-watch.mjs` | `FileChanged` | Notify on wiki-file changes (honors `.hypoignore`; matched paths are never re-emitted into LLM context) |
| `hypo-auto-stage.mjs` | `PostToolUse(Write/Edit)` | Auto-stage wiki-file edits |
| `hypo-auto-commit.mjs` | `Stop` | Auto commit + pull + push |
| `hypo-hot-rebuild.mjs` | `Stop` | Rebuild `hot.md` |
| `hypo-personal-check.mjs` | `PreCompact` | Block compact on lint failures or unfinished session-close |
| `hypo-session-end.mjs` | `SessionEnd` | Write a SessionEnd marker so SessionStart can detect `source=clear` recovery |
| `hypo-session-record.mjs` | `Stop` | Record session metadata for the observability score and auto-resume signaling |
| `hypo-auto-minimal-crystallize.mjs` | `Stop` | Offer (and on consent run) `/hypo:crystallize --apply-session-close --minimal` after non-trivial sessions |
| `hypo-web-fetch-ingest.mjs` | `PostToolUse(WebFetch/WebSearch)` | Inject a `/hypo:ingest` nudge into `additionalContext` after a URL resolution (privacy-aware: redacts query/hash/userinfo) |

All hooks resolve the wiki root via `HYPO_DIR` env → `hypo-config.md` scan → `~/hypomnema` default, and share `hypo-shared.mjs` (declared via `hooks.json`'s `shared` field).

### Setup & maintenance

| Command | Purpose |
|---|---|
| `/hypo:init` | First-time install (dirs, hooks, settings.json merge, first commit/push) |
| `/hypo:doctor` | Health check (hooks, paths, frontmatter, git) |
| `/hypo:upgrade` | Migrate hooks/config to the latest version |
| `/hypo:uninstall` | Remove hooks and registrations |
| `/hypo:stats` | Wiki statistics |
| `/hypo:audit` | Observability audit (per-session metrics, weekly report) |

> Update notice: the `SessionStart` hook runs a non-blocking background check against npm and the Claude Code plugin marketplace, and prints an "Update available!" banner the next time a newer version has been published. Opt out with `HYPO_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or by running under `CI=true`.

### Claude Agent Skills

The synthesis-heavy commands (`ingest`, `query`, `crystallize`, `lint`, `verify`, `graph`) are also exposed as Claude Agent Skills in `skills/<name>/SKILL.md`, so they auto-trigger when the conversation matches their description, with no slash command required. You don't need to know the exact command; just say what you want.

| Say this | Skill it triggers |
|---|---|
| "save this link/article to the wiki" | `ingest` |
| "what do I know about X?", "find that decision I made" | `query` |
| "let's wrap up this session", "save what we did today" | `crystallize` |
| "check these pages for broken links" | `lint` |

Use the slash command when you want to be explicit, plain language when you don't want to break your flow. Both reach the same skill.

---

## Scenarios

A. Learning a new technology.
You're reading Kubernetes docs and blog posts. Drop each URL into `/hypo:ingest`. By the third article, Claude is updating your existing `kubernetes-networking.md` rather than creating another page. A week later, `/hypo:query "how does pod CIDR allocation work?"` returns a synthesized answer citing your own notes.

B. Tracking engineering decisions.
Before merging a significant change, run `/hypo:ingest` on the design doc or PR description. Claude writes an ADR-style page with context, tradeoffs, and the decision. Future `[[wikilink]]` references pull the rationale directly into any prompt that asks about it.

C. Research accumulation.
You work through papers on a topic over several weeks. Each `/hypo:ingest` synthesizes the paper and cross-links it. At any point, `/hypo:query` returns a literature-review-style summary grounded in your own notes.

D. Tuning AI behavior.
Run `/hypo:feedback` whenever Claude gets something wrong, or gets it exactly right. The correction is stored in `pages/feedback/` and injected at session start, so the same mistake doesn't happen twice. It carries across sessions, not just within one conversation.

E. Resuming a paused project.
You put a project down for three weeks. At the next session start, `hypo-session-start.mjs` reads `projects/<name>/session-state.md` and injects "next tasks" and recent decisions into context. You're back up to speed before you type the first prompt.

---

## What goes in your wiki

Store here:

- Synthesized knowledge from external sources (docs, papers, talks)
- Architecture decisions and their rationale
- AI behavior corrections and preferences
- Project context that doesn't belong in git (stakeholder constraints, open questions, background)
- Research findings and cross-source comparisons

Do not store here:

- Raw source material: it goes in `sources/` automatically, unedited
- Credentials, tokens, or secrets: use `.hypoignore` to exclude sensitive paths
- Transient task lists for the current session: use the conversation's task list
- Code patterns derivable from the repo itself: `git log` and `grep` are already authoritative
- Information with a canonical owner elsewhere (Jira, Confluence, API docs): ingest a _synthesis_, not a mirror

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

`.hypoignore` controls which paths the hooks ignore (default: `*.pdf`, `*.zip`, `*.pem`, `*.env`, …). Edit it directly; there is no privacy mode flag. One file, one source of truth.

> Provider transmission disclaimer: Hypomnema hooks emit wiki content into Claude Code's `additionalContext`, which is transmitted to the Claude model provider as part of the prompt. `.hypoignore` is enforced at every content-injection hook (`hypo-file-watch`, `hypo-session-start`, `hypo-cwd-change`, `hypo-lookup`) and at `ingest`, but any file _not_ matched by `.hypoignore` is fair game for transmission. (`hypo-auto-stage` and `hypo-auto-commit` are git-staging hooks, not injection points, and also honor `.hypoignore` for their staging decisions.) Keep secrets out of the wiki, and review `.hypoignore` patterns before storing anything sensitive under `HYPO_DIR`.

> Scope of git sync: Hypomnema git-syncs only the `~/hypomnema/` wiki itself. `init` / `upgrade` do install and SHA-track a defined surface inside `~/.claude/` (Hypomnema's own hooks at `~/.claude/hooks/`, slash commands at `~/.claude/commands/hypo/`, and `settings.json` registrations), plus, via v1.2.0 extensions companion sync, any `agents/` · `commands/` · `hooks/` · `skills/` you ship inside `~/hypomnema/extensions/` (and with `--codex`, the `hooks` + `commands` subset into `~/.codex/`). Anything _outside_ that defined surface in `~/.claude/` is intentionally not managed by Hypomnema. For general cross-machine sync of Claude Code config (other agents/skills not staged via the wiki, machine-specific `settings.local.json`, etc.), use a separate dotfiles manager such as [chezmoi](https://www.chezmoi.io/).

### Where do `/hypo:*` commands live?

| Install path | Slash commands served from |
|---|---|
| Plugin (Path A) | Claude Code's plugin cache; updated via `/plugin marketplace update hypomnema` then `/reload-plugins` |
| npm CLI (Path B) | `~/.claude/commands/hypo/`; updated via `hypomnema upgrade --apply` with per-file SHA tracking. Pass `--force-commands` to overwrite hand-edits (creates `.bak`). |

---

## Requirements

- Node.js ≥ 18 (tested on 18 / 20 / 22)
- Claude Code CLI

No external services. No API keys. No vector databases.

---

## Status

- Tests: see `npm test`. Exact totals shift as lanes ship, so the runner is the source of truth
- CI: 7 independent jobs (test matrix, lint, init/upgrade snapshots, replay, hypo-absent, uninstall-smoke)
- Release: `npm publish --provenance` on `v*` tag push

---

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): internals, component map, data flows
- [CONTRIBUTING.md](docs/CONTRIBUTING.md): development setup, conventions, PR process
- [CHANGELOG.md](CHANGELOG.md): release history

---

## License

MIT
