---
description: Generate a wikilink dependency graph from wiki pages (json, mermaid, or dot). Use when the user asks to visualize wiki structure or find orphan and hub pages.
---

You are running `/hypo:graph`. Generate a link dependency graph from wiki pages.

## What this does

- Scans `pages/` and `projects/` for all `.md` files
- Extracts `[[wikilink]]` references between pages
- Outputs an adjacency graph in JSON, Mermaid, or DOT format

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Run the graph script

```bash
node <package-root>/scripts/graph.mjs \
  [--hypo-dir="<path>"] \
  [--format=json|mermaid|dot] \
  [--min-edges=<n>]
```

Options:
- `--format=json` (default) — adjacency list with in/out degree counts
- `--format=mermaid` — Mermaid `graph TD` diagram (paste into a Markdown code block)
- `--format=dot` — Graphviz DOT format
- `--min-edges=<n>` — only include nodes with at least N total edges

---

## Step 3 — Present results

- For **JSON**: summarise the top 10 most-connected nodes (highest in+out degree), then offer to show the full output.
- For **Mermaid**: wrap the output in a `\`\`\`mermaid` code block so it renders in the chat.
- For **DOT**: show the raw output and suggest pasting it into a Graphviz renderer.

If `--min-edges` was not specified and there are more than 50 nodes, suggest re-running with `--min-edges=2` to focus on well-connected pages.

---

## Step 4 — Insights

After displaying results, offer one or two observations:
- Pages with high in-degree are hub pages — consider linking to them from new pages.
- Pages with zero edges are isolated — suggest adding cross-links or running `/hypo:crystallize`.
