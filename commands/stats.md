---
description: Show statistics about the wiki
---

You are running `/hypo:stats`. Display a summary of wiki health and activity.

## What this shows

- Total page count, broken down by type
- Number of projects and sources
- ADR count
- Date of last recorded activity

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Run the stats script

```bash
node <package-root>/scripts/stats.mjs [--wiki-dir="<path>"] [--json]
```

---

## Step 3 — Report results

Show the output verbatim. Then add a brief health commentary:

- If `sources` is 0: "No external sources yet — consider running `/hypo:ingest` with a document or URL."
- If `missingFrontmatter` > 0: "N page(s) missing frontmatter — run `/hypo:lint` to identify them."
- If `lastActivity` is more than 14 days ago: "Last activity was over 2 weeks ago — consider a `/hypo:crystallize` pass."
- Otherwise: "Wiki looks active and healthy."
