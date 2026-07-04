---
description: Lint wiki pages for frontmatter errors and broken wikilinks. Use when the user asks to check or validate the wiki health, before a commit, or after bulk edits or renames.
---

You are running `/hypo:lint`. Validate all wiki pages for frontmatter correctness and broken `[[wikilink]]` references.

## What this checks

- Every `.md` file under `pages/` and `projects/` should have `---` frontmatter (missing frontmatter is a warning, not an error)
- Required fields: `title`, `type`
- `type` must be one of the recognised values (concept, source-summary, learning, adr, …)
- `updated` field should be present
- All `[[wikilinks]]` must resolve to an existing page slug

---

## Step 1 — Locate package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Run lint

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/lint.mjs [--wiki-dir="<path>"] [--json] [--fix]
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

A non-zero exit code means at least one **error** was found (warnings alone do not produce a non-zero exit code).

---

## Step 4 — Offer to fix

For **broken wikilinks**: list the affected files and ask if the user wants help correcting the links now.

For **missing `updated`**: suggest running with `--fix` to auto-add `updated: <today>` to each affected page's frontmatter. Note: `--fix` only repairs files that already have a valid, closed frontmatter block — files with no frontmatter or malformed frontmatter are skipped.

For **missing required fields** (`title`, `type`): open the affected files and help the user fill them in.

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]` so it stays connected in the graph. The observability audit scores sessions on search / ingest / feedback activity (recorded by `hypo-session-record`), not on these inline citations; run `/hypo:audit` to inspect and see [[pages/observability/_index]].
