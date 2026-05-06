---
description: Lint wiki pages for frontmatter and broken wikilinks
---

You are running `/hypo:lint`. Validate all wiki pages for frontmatter correctness and broken `[[wikilink]]` references.

## What this checks

- Every `.md` file under `pages/` and `projects/` must have `---` frontmatter
- Required fields: `title`, `type`
- `type` must be one of the recognised values (concept, source-summary, learning, adr, …)
- `updated` field should be present
- All `[[wikilinks]]` must resolve to an existing page slug

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `skills/`).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/wiki`.

---

## Step 2 — Run lint

```bash
node <package-root>/scripts/lint.mjs [--wiki-dir="<path>"] [--json] [--fix]
```

Options:
- `--json` — output results as JSON (useful for tooling)
- `--fix` — auto-add missing `updated` field (safe repairs only; no other fields are modified)

Show the output verbatim.

---

## Step 3 — Interpret results

- `✓ No lint issues found` — wiki is clean
- `✗ <file>: <message>` — error (missing required field or malformed frontmatter); must be fixed
- `⚠ <file>: <message>` — warning (unknown type, missing `updated`, broken link); worth fixing

A non-zero exit code means at least one error was found.

---

## Step 4 — Offer to fix

For **broken wikilinks**: list the affected files and ask if the user wants help correcting the links now.

For **missing `updated`**: suggest running with `--fix` to auto-repair.

For **missing required fields** (`title`, `type`): open the affected files and help the user fill them in.
