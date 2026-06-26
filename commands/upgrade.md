---
description: Check for Hypomnema updates and optionally apply them. Use when the user asks to update Hypomnema or sees an update-available notice.
---

You are running `/hypo:upgrade`. Check if the installed Hypomnema wiki is out of date and offer to apply updates.

## What this checks

- **SCHEMA version**: compares `~/hypomnema/SCHEMA.md` version against the package's current version
- **Hook files**: checks if any hooks in `~/.claude/hooks/` are stale or missing
- **settings.json**: checks if all hook registrations are present in `~/.claude/settings.json`

---

## Step 1 — Run script

The script path below resolves via `${CLAUDE_PLUGIN_ROOT}`, which the plugin harness expands to this package's absolute path before you see it, so run it as written. If it appears unexpanded (a literal `${CLAUDE_PLUGIN_ROOT}`), read the package root from the `hypo@hypomnema` installPath in `~/.claude/plugins/installed_plugins.json` rather than guessing from the cache layout.

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Run upgrade check

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.mjs [--hypo-dir="<path>"]
```

Show the output verbatim.

> **Plugin installs**: if the output begins with `ℹ Plugin install detected`, the core hooks, slash commands, and `settings.json` wiring are managed by the Claude Code plugin loader — **not** by `/hypo:upgrade`. Do **not** run `--apply` expecting it to update them (it intentionally skips those to avoid double-registering every hook). To upgrade the plugin itself: `/plugin marketplace update hypomnema` then `/reload-plugins`. `--apply` in plugin mode applies vault-side migrations (SCHEMA, `.hypoignore`), refreshes package metadata, and still syncs any vault extensions — but does **not** install the core hooks/commands/settings (the plugin provides those).

> **Note**: A major SCHEMA bump is only **detected** in this step. The informational `MIGRATION-vX.Y.md` file is written later by `--apply` (Step 4) and only on a major bump. `SCHEMA.md` is never auto-overwritten.

---

## Step 3 — Interpret and summarise

- `✓` — up to date, no action needed
- `⚠` — minor update available (stale hook or missing settings entry)
- `✗` — major version bump or missing hook files (action required)

For a **major SCHEMA bump**: warn the user that `--apply` will additionally write a `MIGRATION-vX.Y.md` informational file in their Hypomnema root and that they must manually merge the SCHEMA diff after applying.

---

## Step 4 — Confirm before applying

If there is anything to update, ask the user:

> Updates found: [list what needs updating].
> Apply now? Hook files will be overwritten and settings.json will be merged.
> Note: SCHEMA.md is never auto-overwritten — update it manually after reviewing the diff. (y/N)

- If **yes** → run with `--apply`:
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.mjs [--hypo-dir="<path>"] --apply
  ```
- If **no** → tell the user they can apply later by running `/hypo:upgrade` again.

---

## Step 5 — Post-apply

After applying, recommend running `/hypo:doctor` to verify the installation is healthy.
