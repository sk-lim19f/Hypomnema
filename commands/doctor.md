---
description: Health check for a Hypomnema wiki installation
---

You are running `/hypo:doctor`. Verify the health of the current Hypomnema wiki installation.

## What this checks

- Wiki root directory exists and has `hypo-config.md` marker
- Required subdirectories and baseline files are present
- Claude Code hook files are installed in `~/.claude/hooks/`
- `~/.claude/settings.json` contains all required hook registrations
- Git repository and remote origin are configured
- No broken `[[wiki-link]]` references
- No overdue or missing `verify_by` fields on tracked pages

---

## Step 1 — Locate package root and resolve wiki dir

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically: `HYPO_DIR` env → `hypo-config.md` scan → `~/wiki` default.

---

## Step 2 — Run the doctor script

```bash
node <package-root>/scripts/doctor.mjs [--wiki-dir="<path>"] [--json]
```

- `--wiki-dir=<path>` — override wiki root (takes precedence over `HYPO_DIR` env and auto-scan)
- `--json` — output results as a JSON array (useful for programmatic use)

---

## Step 3 — Report results

Show the script output verbatim. Each line is prefixed with:
- `✓` — check passed
- `⚠` — warning (not blocking, but worth fixing)
- `✗` — failure (installation is broken)

Then show the summary line: `Result: N passed, N warnings, N failed`

---

## Step 4 — Recommend fixes

For any `✗` failures:
- Missing wiki root or required directories/files → run `/hypo:init`.
- 0 hook files installed → run `/hypo:init`.
- 0 hook registrations in settings.json → run `/hypo:init`.

For `⚠` warnings:
- Missing `hypo-config.md` → run `/hypo:init` — it creates the config marker.
- Missing baseline files (`index.md`, `hot.md`, etc.) → run `/hypo:init`.
- Partial hook files (some missing) → run `/hypo:init` to install missing hooks.
- Partial settings.json registrations → run `/hypo:init` to merge missing entries.
- Missing git remote → `git -C <wiki-dir> remote add origin <url>`.
- Broken `[[links]]` → list the affected files and ask if the user wants to fix them now.
- Overdue `verify_by_date` → offer to open the affected pages for review.
- Missing `verify_by` question → suggest adding a `verify_by` field to the listed pages.

If all checks passed, tell the user the wiki is healthy and ready to use.
