---
description: Validate wiki pages for frontmatter correctness and broken wikilinks. Use when the user asks to check wiki health, before a commit, or after bulk edits or renames.
---

You are running `/hypo:lint`. Validate all wiki pages for frontmatter correctness and broken `[[wikilink]]` references.

## What this checks

- Every `.md` file under `pages/` and `projects/` should have frontmatter (missing frontmatter is a warning)
- Required fields: `title`, `type`
- `type` must be one of the recognised values (concept, source-summary, learning, adr, …)
- `updated` field should be present
- All `[[wikilinks]]` must resolve to an existing page slug

---

## Step 1 — Run script

The script path below resolves via `${CLAUDE_PLUGIN_ROOT}`, which the plugin harness expands to this package's absolute path before you see it, so run it as written. If it appears unexpanded (a literal `${CLAUDE_PLUGIN_ROOT}`), read the package root from the `hypo@hypomnema` installPath in `~/.claude/plugins/installed_plugins.json` rather than guessing from the cache layout.

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag and the script resolves the Hypomnema root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Run lint

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/lint.mjs [--hypo-dir="<path>"] [--json] [--fix]
```

Options:
- `--json` — output results as JSON (useful for tooling)
- `--fix` — auto-add missing `updated` field (safe repairs only; no other fields are modified)

Show the output verbatim.

---

## Step 3 — Interpret results

- `✓ No lint issues found` — Hypomnema is clean
- `✗ <file>: <message>` — error (missing required field or malformed frontmatter); must be fixed
- `⚠ <file>: <message>` — warning (unknown type, missing `updated`, broken link); worth fixing

A non-zero exit code means at least one **error** was found (warnings alone do not produce a non-zero exit code).

---

## Step 4 — Offer to fix

For **broken wikilinks**: list the affected files and ask if the user wants help correcting the links now.

For **missing `updated`**: suggest running with `--fix` to auto-add `updated: <today>` to each affected page's frontmatter. Note: `--fix` only repairs files that already have a valid, closed frontmatter block — files with no frontmatter or malformed frontmatter are skipped.

For **missing required fields** (`title`, `type`): open the affected files and help the user fill them in.
