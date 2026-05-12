---
description: Search wiki pages by keyword and retrieve relevant knowledge
---

You are running `/hypo:query`. Full-text search across all wiki pages and projects, then synthesize an answer from the matching pages.

## What this does

- Searches `pages/` and `projects/` for the given query terms
- Returns matching files with a context excerpt and frontmatter summary
- You then read the top results and synthesize an answer

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory two levels above this file (`skills/<name>/SKILL.md` → package root)).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Extract the query

Use the search terms from the user's message. If no query was provided, ask:

> "What would you like to search for in your wiki?"

---

## Step 3 — Run query

```bash
node <package-root>/scripts/query.mjs \
  --q="<search terms>" \
  [--wiki-dir="<path>"] \
  [--limit=<n>] \
  [--json]
```

Options:
- `--q=<query>` — search query (required)
- `--limit=<n>` — max results (default: 10)
- `--json` — output results as JSON

Show the output verbatim.

---

## Step 4 — Synthesize an answer

Read the top matching pages (up to 5) and produce a synthesized response:

1. **Direct answer** — if the query has a clear answer from the wiki, state it first.
2. **Supporting pages** — list the relevant pages with one-line descriptions and `[[wikilink]]` references.
3. **Gaps** — if the wiki lacks coverage on the topic, note what is missing and suggest an ingest target.

If zero results are returned, say so and offer to broaden the search or suggest using `/hypo:ingest` to add relevant sources.

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]`. The observability audit counts citations toward the autonomy score — see [[pages/observability/_index]] (run `/hypo:audit` to inspect).
