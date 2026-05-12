---
description: Generate a wikilink dependency graph from wiki pages
---

You are running `/hypo:graph`. Build a wikilink dependency graph from all pages under `pages/` and `projects/` and output it in the requested format.

## What this produces

- **json** (default) — adjacency list with in/out-degree counts per node, sorted by total edges
- **mermaid** — `graph TD` Mermaid diagram (paste into any Mermaid renderer)
- **dot** — Graphviz DOT format (pipe to `dot -Tsvg` for an SVG)

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory two levels above this file (`skills/<name>/SKILL.md` → package root)).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Ask for output format (optional)

If the user did not specify a format, ask:

> "Output format? (json / mermaid / dot) [json]"

Default: `json`

Optionally ask:

> "Minimum edges to include a node? (0 = all) [0]"

---

## Step 3 — Run graph

```bash
node <package-root>/scripts/graph.mjs \
  [--wiki-dir="<path>"] \
  [--format=json|mermaid|dot] \
  [--min-edges=<n>]
```

---

## Step 4 — Present results

- **json**: summarise the top 10 most-connected nodes (by `in + out`), then offer to show the full JSON.
- **mermaid**: wrap the output in a fenced code block tagged `mermaid` so it renders inline.
- **dot**: wrap the output in a fenced code block tagged `dot` and suggest the user pipe it to `dot -Tsvg -o graph.svg`.

If the graph has 0 edges, note that no `[[wikilinks]]` were found between pages.

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]`. The observability audit counts citations toward the autonomy score — see [[pages/observability/_index]] (run `/hypo:audit` to inspect).
