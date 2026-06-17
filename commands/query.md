---
description: Query the wiki and synthesize an answer from the relevant pages. Use when the user asks what the wiki knows, wants to recall a past decision, or needs prior context before starting work.
---

You are running `/hypo:query`. Answer a question by searching the wiki and synthesizing from relevant pages.

## What this does

- Searches `pages/` and `projects/` for pages relevant to the query
- Reads and cross-references the top matches
- Synthesizes a grounded answer citing `[[page-slug]]` links

---

## Step 1 — Understand the query

Ask the user what they want to know if it was not provided in the command invocation.

---

## Step 2 — Locate package root and search

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

Run full-text search:

```bash
node <package-root>/scripts/query.mjs \
  --q="<query terms>" \
  [--hypo-dir="<path>"] \
  [--limit=10]
```

---

## Step 3 — Read relevant pages

Read `index.md` first to understand the page catalog, then read the top-scoring pages returned by the search script (up to 5).

---

## Step 4 — Synthesize answer

Write a clear, concise answer that:
- Cites source pages as `[[slug]]` links
- Notes confidence level if any source is speculative
- Flags if no relevant pages were found ("Hypomnema does not currently have a page on this topic.")

If the query surfaces a gap, offer to create a new page or run `/hypo:ingest` on a relevant source.

---

## Step 5 — Offer follow-ups

After answering, suggest 1–2 related pages the user might want to read next.
