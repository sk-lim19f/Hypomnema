---
description: Check for Hypomnema updates and optionally apply them
---

You are running `/hypo:upgrade`. Check if the installed Hypomnema wiki is out of date and offer to apply updates.

## What this checks

- **SCHEMA version**: compares `~/wiki/SCHEMA.md` version against the package's current version
- **Hook files**: checks if any hooks in `~/.claude/hooks/` are stale or missing
- **settings.json**: checks if all hook registrations are present in `~/.claude/settings.json`

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Run upgrade check

```bash
node <package-root>/scripts/upgrade.mjs [--wiki-dir="<path>"]
```

Show the output verbatim.

> **Note**: If a major SCHEMA bump is detected, this step generates a `MIGRATION-vX.Y.md` file in the wiki root. This is a new informational file — no existing files are overwritten.

---

## Step 3 — Interpret and summarise

- `✓` — up to date, no action needed
- `⚠` — minor update available (stale hook or missing settings entry)
- `✗` — major version bump or missing hook files (action required)

For a **major SCHEMA bump**: point the user to the generated `MIGRATION-vX.Y.md` file in their wiki root and ask them to review it before applying.

---

## Step 4 — Confirm before applying

If there is anything to update, ask the user:

> Updates found: [list what needs updating].
> Apply now? Hook files will be overwritten and settings.json will be merged.
> Note: SCHEMA.md is never auto-overwritten — update it manually after reviewing the diff. (y/N)

- If **yes** → run with `--apply`:
  ```bash
  node <package-root>/scripts/upgrade.mjs [--wiki-dir="<path>"] --apply
  ```
- If **no** → tell the user they can apply later by running `/hypo:upgrade` again.

---

## Step 5 — Post-apply

After applying, recommend running `/hypo:doctor` to verify the installation is healthy.
