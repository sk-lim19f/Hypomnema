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

## How it works

1. **Ingest** — drop a document, URL, or paste text into `/hypo:ingest`. Claude saves the raw source and synthesizes it into a structured page.
2. **Query** — ask `/hypo:query` anything. Claude searches your pages and synthesizes a grounded answer with `[[wikilink]]` citations.
3. **Session close** — on session end, Claude updates `session-state.md` (next tasks) and `hot.md` (what was done) so the next session resumes seamlessly.
4. **Compound value** — over time, new sources update existing pages rather than creating new ones. The wiki gets denser and more useful.

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

All wiki data is stored locally. No content is sent to external services by Hypomnema itself.

Three privacy modes are available: `personal` (default), `shared`, and `public`. A `.wikiignore` file controls which files hooks scan and include in context.

See [docs/PRIVACY.md](docs/PRIVACY.md) for the full privacy guide, including what each hook reads, how to exclude sensitive content, and how to delete your wiki completely.

---

## Requirements

- Node.js ≥ 18
- Claude Code CLI

---

## License

MIT
