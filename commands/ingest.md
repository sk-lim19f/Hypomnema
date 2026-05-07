---
description: Ingest an external source into the wiki
---

You are running `/hypo:ingest`. Save a raw source and synthesize it into wiki pages.

## What this does

- Saves raw source content to `sources/<slug>.<ext>` (never edited after)
- Synthesizes the source into one or more pages in `pages/`
- Updates `index.md` with new or updated pages
- Appends an entry to `log.md`

---

## Step 1 — Collect source details

Ask the user:

1. **Source**: "What is the source? (paste text, provide a file path, or give a URL)"
2. **Slug**: "What slug should this source have? (e.g. `openai-swarm-paper`, `team-retro-2026-04`)"
   - Default: derive from title or filename

If a URL is provided, fetch the content. If a file path is provided, read it.

---

## Step 2 — Check for orphaned sources

Locate the Hypomnema package root. Run the ingest helper to surface existing orphaned sources:

```bash
node <package-root>/scripts/ingest.mjs [--wiki-dir="<path>"]
```

If there are orphaned sources already in `sources/`, ask: "There are N unprocessed sources — do you want to ingest one of those instead?"

---

## Step 3 — Save raw source

Save the raw content to `sources/<slug>.<ext>` (use `.md` for text, `.txt` for plain text, `.pdf` or original extension for documents).

Do **not** modify or summarize in the sources file — save it as-is.

---

## Step 4 — Synthesize

Read and synthesize the source:

1. **Check index.md** — does a page on this topic already exist?
   - If yes: update the existing page (merge new information, mark `updated:` today)
   - If no: create a new page in `pages/` with `type: source-summary` and `source: <slug>`

2. **Frontmatter** for new pages:
   ```yaml
   ---
   title: "<descriptive title>"
   type: source-summary
   updated: YYYY-MM-DD
   tags: [<relevant tags>]
   source: <slug>
   confidence: high | medium | low
   evidence_strength: direct
   ---
   ```

3. **Content**: synthesis in your own words — not a copy of the source. Include key insights, quotes as blockquotes, and cross-links to related pages.

---

## Step 5 — Update index.md and log.md

- Append a line to `index.md`: `- [[pages/<slug>]] — <one-line description>`
- Append to `log.md`: `- YYYY-MM-DD ingest: [[pages/<slug>]] from sources/<slug>.<ext>`

---

## Step 6 — Report

Show:
- ✓ Saved source: `sources/<slug>.<ext>`
- ✓ Created/Updated: `pages/<slug>.md`
- ↪ Updated: `index.md`, `log.md`
