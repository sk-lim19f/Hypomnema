English | [한국어](README.ko.md)

---

# Hypomnema

LLM-native personal wiki system for Claude Code.

Hypomnema turns Claude Code into a compounding knowledge base. Instead of chunking sources as-is, an LLM reads each source, synthesizes it, and updates existing pages — so new sources update knowledge more than they create it.

---

## Quick start

```bash
npm install -g hypomnema   # or: npx hypomnema
```

In Claude Code, run:

```
/hypo:init
```

This sets up your wiki directory, installs hooks, and merges them into `~/.claude/settings.json`.

---

## Why Hypomnema

| | Hypomnema | Plain Obsidian / Notion | RAG / vector search |
|---|---|---|---|
| **Capture effort** | Paste a URL → done | Manual note-taking | Upload + embed pipeline |
| **Knowledge growth** | New sources update existing pages | Each note is independent | Chunks multiply indefinitely |
| **Retrieval** | LLM synthesizes a grounded answer | Full-text search | Nearest-neighbour chunks |
| **Workflow integration** | Lives inside Claude Code | Separate app / browser tab | Separate service |

Four things that set it apart:

1. **Synthesis over storage.** Claude reads each source and synthesizes it into a structured page — not a copy-paste dump. You get a knowledge base you can reason over, not a pile of bookmarks.
2. **Compounding pages.** When a new source overlaps an existing page, Claude updates that page. The wiki gets denser and more connected over time rather than just bigger.
3. **Zero-friction hooks.** Session start, session close, auto-staging, and auto-commit happen automatically through Claude Code lifecycle hooks. You never context-switch to manage the wiki.
4. **Native to your workflow.** No separate app, no export/import, no third-party sync service. Hypomnema runs inside the Claude Code session you already have open.

---

## Scenarios

**A — Learning a new technology**
You're reading Kubernetes docs and blog posts. Drop each URL into `/hypo:ingest`. By the third article, Claude is updating your existing `kubernetes-networking.md` page rather than creating another one. A week later, `/hypo:query "how does pod CIDR allocation work?"` returns a synthesized answer citing your own notes.

**B — Tracking engineering decisions**
Before merging a significant change, run `/hypo:ingest` on the design doc or PR description. Claude creates an ADR-style page with context, tradeoffs, and the decision. Future `[[wikilink]]` references pull the rationale directly into any prompt that asks about it.

**C — Research accumulation**
You're working through papers on a topic over several weeks. Each `/hypo:ingest` run synthesizes the paper and cross-links it to related pages you already have. At any point, `/hypo:query` gives you a literature-review-style summary grounded in your own notes.

**D — Tuning AI behavior**
Run `/hypo:feedback` whenever Claude does something wrong or exactly right. The correction is stored in `pages/feedback/` and injected at session start, so the same mistake doesn't happen twice — across sessions, not just within one conversation.

**E — Resuming a paused project**
You put a project down for three weeks. At the next session start, the hook reads `projects/<name>/session-state.md` and injects "next tasks" and recent decisions directly into context. You're back up to speed before you type the first prompt.

---

## How it works

1. **Ingest** — drop a document, URL, or paste text into `/hypo:ingest`. Claude saves the raw source and synthesizes it into a structured page.
2. **Query** — ask `/hypo:query` anything. Claude searches your pages and synthesizes a grounded answer with `[[wikilink]]` citations.
3. **Session close** — on session end, Claude updates `session-state.md` (next tasks) and `hot.md` (what was done) so the next session resumes seamlessly.
4. **Compound value** — over time, new sources update existing pages rather than creating new ones. The wiki gets denser and more useful.

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
- Credentials, tokens, or secrets — use `.wikiignore` to exclude sensitive paths
- Transient task lists for the current session — use the task list in the conversation
- Code patterns derivable from the repo itself — `git log` and `grep` are already authoritative
- Information that has a canonical owner elsewhere (Jira tickets, Confluence pages, API docs) — ingest a *synthesis*, not a mirror

---

## Commands

| Command | Description |
|---------|-------------|
| `/hypo:init` | Set up a new wiki |
| `/hypo:doctor` | Health check |
| `/hypo:upgrade` | Upgrade hooks to latest version |
| `/hypo:uninstall` | Remove hooks and registrations |
| `/hypo:ingest` | Ingest an external source into the wiki |
| `/hypo:query` | Search and synthesize an answer from wiki pages |
| `/hypo:crystallize` | Consolidate drafts and related pages into stable knowledge |
| `/hypo:resume` | Resume the most recent session for an active project |
| `/hypo:feedback` | Record an AI behavior correction |
| `/hypo:verify` | Audit pages for overdue or missing `verify_by` fields |
| `/hypo:stats` | Show wiki statistics |
| `/hypo:graph` | Generate a wikilink dependency graph |
| `/hypo:lint` | Validate frontmatter and wikilinks |

---

## Directory layout

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
├── projects/           ← project artifacts and session logs
└── sources/            ← raw ingested sources (never edit)
```

---

## Privacy

Wiki data is stored as local files. If you configure a Git remote, the Stop hook automatically commits and pushes your wiki — no third-party sync service is involved. Commands that use the Claude API (such as `/hypo:verify` and `/hypo:lint --llm`) send page content to Anthropic for evaluation; all other hooks operate entirely offline.

Three privacy modes are available: `personal` (default), `shared`, and `public`. A `.wikiignore` file controls which files hooks scan and include in context.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full privacy guide, including what each hook reads, how to exclude sensitive content, and how to delete your wiki completely.

---

## Requirements

- Node.js ≥ 18
- Claude Code CLI

---

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — internals, component map, data flows
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — development setup, conventions, PR process
- [PRIVACY.md](docs/PRIVACY.md) — privacy modes, `.wikiignore`, data handling

---

## License

MIT
