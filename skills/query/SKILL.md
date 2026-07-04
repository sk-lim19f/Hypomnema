---
description: Search the wiki by keyword and synthesize an answer from the relevant pages. Use when the user asks what the wiki knows about a topic, wants to recall a past decision, or needs prior context before starting work.
---

You are running `/hypo:query`. Full-text search across all wiki pages and projects, then synthesize an answer from the matching pages.

## What this does

- Searches `pages/` and `projects/` for the given query terms
- Returns matching files with a context excerpt and frontmatter summary
- You then read the top results and synthesize an answer

---

## Step 1 — Locate package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Extract the query

Use the search terms from the user's message. If no query was provided, ask:

> "What would you like to search for in your wiki?"

---

## Step 3 — Run query

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/query.mjs \
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

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]` so it stays connected in the graph. The observability audit scores sessions on search / ingest / feedback activity (recorded by `hypo-session-record`), not on these inline citations; run `/hypo:audit` to inspect and see [[pages/observability/_index]].
