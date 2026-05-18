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

Do **not** fetch the URL or read the file yet — the privacy guard in Step 2 must run first.

---

## Step 2 — Privacy guard (`.hypoignore`)

Refuse to ingest secrets (`.env`, SSH keys, credentials) before they ever reach `sources/`. Locate the Hypomnema package root and run the guard for **both** the input path and the destination path:

1. **If the source is a file path**, check it (use an absolute path):

   ```bash
   node <package-root>/scripts/ingest.mjs [--hypo-dir="<path>"] --check="<absolute-input-path>"
   ```

2. **Always** check the destination `sources/<slug>.<ext>`:

   ```bash
   node <package-root>/scripts/ingest.mjs [--hypo-dir="<path>"] --check="sources/<slug>.<ext>"
   ```

If either command exits non-zero, **stop**: surface the `Refused: ...` message to the user and do not fetch, read, or save the source. The slug check matters because a user could rename a `.env` to an innocuous slug — the destination must still be blocked.

---

## Step 3 — Check for orphaned sources

Run the ingest helper to surface existing orphaned sources:

```bash
node <package-root>/scripts/ingest.mjs [--hypo-dir="<path>"]
```

If there are orphaned sources already in `sources/`, ask: "There are N unprocessed sources — do you want to ingest one of those instead?"

Once the guard has passed: if a URL is provided, fetch the content; if a file path is provided, read it.

---

## Step 4 — Save raw source

Save the raw content to `sources/<slug>.<ext>` (use `.md` for text, `.txt` for plain text, `.pdf` or original extension for documents).

Do **not** modify or summarize in the sources file — save it as-is.

---

## Step 5 — Synthesize

Read and synthesize the source:

1. **Check index.md** — does a page on this topic already exist?
   - If yes: update the existing page (merge new information, mark `updated:` today)
   - If no: create a new page in `pages/` with `type: source-summary` and `sources: [<slug>]`

2. **Frontmatter** for new pages:
   ```yaml
   ---
   title: "<descriptive title>"
   type: source-summary
   updated: YYYY-MM-DD
   tags: [<relevant tags>]
   sources: [<slug>]
   confidence: high | medium | low
   evidence_strength: direct
   ---
   ```

3. **Content**: synthesis in your own words — not a copy of the source. Include key insights, quotes as blockquotes, and cross-links to related pages.

---

## Step 6 — Update index.md and log.md

- Append a line to `index.md`: `- [[pages/<slug>]] — <one-line description>`
- Append to `log.md`: `- YYYY-MM-DD ingest: [[pages/<slug>]] from sources/<slug>.<ext>`

---

## Step 7 — Report

Show:
- ✓ Saved source: `sources/<slug>.<ext>`
- ✓ Created/Updated: `pages/<slug>.md`
- ↪ Updated: `index.md`, `log.md`
