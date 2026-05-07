---
description: Crystallize draft notes and related pages into stable wiki knowledge
---

You are running `/hypo:crystallize`. Identify and consolidate draft or scattered knowledge into stable, well-linked pages.

## What this does

- Scans `pages/` for draft pages, unlinked pages, and tag clusters
- Synthesizes related pages into a `synthesis` page (or upgrades a draft to stable)
- Adds cross-links between related pages

---

## Step 1 — Surface candidates

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

```bash
node <package-root>/scripts/crystallize.mjs [--wiki-dir="<path>"] [--min-group=2]
```

Show the output to the user. If no candidates are found, tell them the wiki looks well-connected and no crystallization is needed.

---

## Step 2 — Choose what to crystallize

If candidates exist, ask:

> "Which would you like to crystallize?
> 1. A tag cluster (synthesize related pages into one synthesis page)
> 2. A draft page (upgrade to stable)
> 3. Unlinked pages (add cross-links)"

---

## Step 3a — Tag cluster synthesis

For a tag cluster:

1. Read all pages in the cluster
2. Create `pages/syntheses/<topic>.md` with `type: synthesis`
3. Frontmatter:
   ```yaml
   ---
   title: "<synthesis title>"
   type: synthesis
   updated: YYYY-MM-DD
   tags: [<shared tags>]
   confidence: high
   ---
   ```
4. Body: synthesize key insights across the cluster, cite each source page with `[[slug]]`
5. Add back-links: add `[[syntheses/<topic>]]` to each constituent page's "See also" section
6. Update `index.md`

---

## Step 3b — Draft upgrade

For a draft page:

1. Read the draft
2. Fill in any missing sections, improve clarity, add cross-links
3. Change `tags: [draft]` → remove `draft` tag, set `confidence: high`
4. Update `updated:` to today

---

## Step 3c — Cross-link unlinked pages

For unlinked pages:

1. Read each unlinked page
2. Search the wiki for related pages (run `/hypo:query` mentally on the page title/tags)
3. Add a `## See also` section with `[[slug]]` links to 2–3 related pages
4. Reciprocally add links back where natural

---

## Step 4 — Report

Show what was created or modified, and offer to run `/hypo:lint` to verify all new links resolve.
