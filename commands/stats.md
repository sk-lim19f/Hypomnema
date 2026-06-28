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

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

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
