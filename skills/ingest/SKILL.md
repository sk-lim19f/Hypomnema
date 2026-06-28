---
description: Add an external source (URL, doc, article, command output) to the wiki and synthesize a citable summary page. Use when the user shares a source to capture, asks to ingest something, or wants reliable external knowledge saved for reuse.
---

You are running `/hypo:ingest`. Add a new source document to `sources/` and create (or update) its corresponding `source-summary` page under `pages/`.

## What this does

- Checks which files in `sources/` are missing a `source-summary` page
- Reports pages that reference a source file that does not exist in `sources/`
- After the script runs, guides you to synthesize a summary for any un-ingested source

---

## Step 1 — Locate package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

If the user specified a wiki directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Run ingest status check

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/ingest.mjs [--hypo-dir="<path>"] [--json]
```

Options:
- `--json` — output results as JSON (useful for tooling)

Show the output verbatim.

---

## Step 3 — Privacy guard (`.hypoignore`)

Before touching any source content, refuse to ingest secrets (`.env`, SSH keys, credentials). Run the guard for **both** the input path and the destination path:

1. **If the user provided a file path**, check it (use an absolute path):

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/ingest.mjs [--hypo-dir="<path>"] --check="<absolute-input-path>"
   ```

2. **Always** check the destination `sources/<slug>.<ext>`:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/ingest.mjs [--hypo-dir="<path>"] --check="sources/<slug>.<ext>"
   ```

If either command exits non-zero, **stop**: surface the `Refused: ...` message to the user and do not download, read, or save the source. The slug check matters because a user could rename a `.env` to an innocuous slug — the destination must still be blocked.

---

## Step 4 — Handle the source file

**If the user provided a file or URL to ingest:**

1. Copy or download the source into `<wiki-root>/sources/<slug>.<ext>` (e.g., `sources/2026-05-07-article-title.md`).
2. Confirm the file is now present.

**If no file was provided:**

List un-ingested sources from the script output and ask which one to process now.

---

## Step 5 — Synthesize a source-summary page

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

## Step 6 — Update log.md

Append an ingest entry to `<wiki-root>/log.md`:

```
## <YYYY-MM-DD> ingest — <slug>

- source: sources/<filename>
- summary: pages/<slug>.md
- tags: <tags>
```

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]`. The observability audit counts citations toward the autonomy score — see [[pages/observability/_index]] (run `/hypo:audit` to inspect).
