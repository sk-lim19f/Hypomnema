---
description: Show statistics about the wiki (page counts, link density, growth). Use when the user asks how big the wiki is, how it has grown, or its overall shape.
---

You are running `/hypo:stats`. Display a summary of wiki health and activity.

## What this shows

- Total page count, broken down by type
- Number of projects and sources
- ADR count
- Date of last recorded activity

---

## Step 1 — Run script

The script path below resolves via `${CLAUDE_PLUGIN_ROOT}`, which the plugin harness expands to this package's absolute path before you see it, so run it as written. If it appears unexpanded (a literal `${CLAUDE_PLUGIN_ROOT}`), read the package root from the `hypo@hypomnema` installPath in `~/.claude/plugins/installed_plugins.json` rather than guessing from the cache layout.

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Run the stats script

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/stats.mjs [--hypo-dir="<path>"] [--json]
```

---

## Step 3 — Report results

Show the output verbatim. Then add a brief health commentary:

- If `sources` is 0: "No external sources yet — consider running `/hypo:ingest` with a document or URL."
- If `missingFrontmatter` > 0: "N page(s) missing frontmatter — run `/hypo:lint` to identify them."
- If `lastActivity` is more than 14 days ago: "Last activity was over 2 weeks ago — consider a `/hypo:crystallize` pass."
- Otherwise: "Wiki looks active and healthy."
