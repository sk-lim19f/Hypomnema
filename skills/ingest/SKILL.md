---
description: Add a source document to the wiki and synthesize a source-summary page
---

You are running `/hypo:ingest`. Add a new source document to `sources/` and create (or update) its corresponding `source-summary` page under `pages/`.

## What this does

- Checks which files in `sources/` are missing a `source-summary` page
- Reports pages that reference a source file that does not exist in `sources/`
- After the script runs, guides you to synthesize a summary for any un-ingested source

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory two levels above this file (`skills/<name>/SKILL.md` → package root)).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/wiki`.

---

## Step 2 — Run ingest status check

```bash
node <package-root>/scripts/ingest.mjs [--wiki-dir="<path>"] [--json]
```

Options:
- `--json` — output results as JSON (useful for tooling)

Show the output verbatim.

---

## Step 3 — Handle the source file

**If the user provided a file or URL to ingest:**

1. Copy or download the source into `<wiki-root>/sources/<slug>.<ext>` (e.g., `sources/2026-05-07-article-title.md`).
2. Confirm the file is now present.

**If no file was provided:**

List un-ingested sources from the script output and ask which one to process now.

---

## Step 4 — Synthesize a source-summary page

For the chosen source, read its content and create `pages/<slug>.md` with the following frontmatter:

```yaml
---
title: <descriptive title>
type: source-summary
source: <filename>
tags: [<relevant tags>]
updated: <today YYYY-MM-DD>
evidence_strength: direct   # or inferred
---
```

Then write a concise summary:
- Key ideas (bullet list)
- Why this source matters to the wiki
- Any open questions or follow-up items

Cross-reference existing pages with `[[wikilink]]` syntax where relevant.

---

## Step 5 — Update log.md

Append an ingest entry to `<wiki-root>/log.md`:

```
## <YYYY-MM-DD> ingest — <slug>

- source: sources/<filename>
- summary: pages/<slug>.md
- tags: <tags>
```
