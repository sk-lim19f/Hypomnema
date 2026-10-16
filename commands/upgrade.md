---
description: Check for Hypomnema updates and optionally apply them. Use when the user asks to update Hypomnema or sees an update-available notice.
---

You are running `/hypo:upgrade`. Check if the installed Hypomnema wiki is out of date and offer to apply updates.

**If the arguments contain `--migrate-sessions`**, resolve the package root (Step 1), then skip Steps 2 to 5 and go straight to the `--migrate-sessions` section at the end of this file.

## What this checks

- **SCHEMA version**: compares `~/hypomnema/SCHEMA.md` version against the package's current version
- **Hook files**: checks if any hooks in `~/.claude/hooks/` are stale or missing
- **settings.json**: checks if all hook registrations are present in `~/.claude/settings.json`

A vault with no git remote moves its session state into per-session entries (`projects/<p>/sessions/`) by itself at the next SessionStart. A vault with a remote is never moved from a hook; SessionStart only tells you it has not moved.

---

## Step 1 — Run script

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install) or reinstall instead of guessing the cache layout.

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Run upgrade check

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.mjs [--hypo-dir="<path>"]
```

Show the output verbatim.

> **Plugin installs**: if the output begins with `ℹ Plugin install detected`, the core hooks, slash commands, and `settings.json` wiring are managed by the Claude Code plugin loader — **not** by `/hypo:upgrade`. Do **not** run `--apply` expecting it to update them (it intentionally skips those to avoid double-registering every hook). To upgrade the plugin itself: `/plugin marketplace update hypomnema`, then `/reload-plugins` in **every session that is already open**, not only the one where you ran the update. A session that has not reloaded keeps running the old hooks and commands. It can go on blocking close under the old project-folder rule, and when old hooks mix with new commands a failed write record leaves no trace. `--apply` alone never changes the plugin-managed hooks. **Then run `--apply` anyway**: the vault's git pre-commit hook holds an absolute path baked in at init time, and reloading the plugin does not move it, so without that step every wiki commit keeps running the install you had when you first ran init. `--apply` in plugin mode applies vault-side migrations (SCHEMA, `.hypoignore`), refreshes package metadata, and still syncs any vault extensions — but does **not** install the core hooks/commands/settings (the plugin provides those).

> **Note**: A major SCHEMA bump is only **detected** in this step. The informational `MIGRATION-vX.Y.md` file is written later by `--apply` (Step 4) and only on a major bump. `SCHEMA.md` is never auto-overwritten.

---

## Step 3 — Interpret and summarise

- `✓` — up to date, no action needed
- `⚠` — minor update available (stale hook or missing settings entry)
- `✗` — major version bump or missing hook files (action required)

If a `⚠ hypo-guide.md` line shows a version change (`vN → vM`) or says the installed copy has no version stamp, `--apply` will not fix it: it never overwrites the vault's guide. Tell the user to finish it by hand, and offer to do the merge. A line that says the installed copy is ahead of the package, or that the versions cannot be compared, is not drift: leave the stamp alone and only report it.

1. Run the `diff` command printed on that line to compare the package template with the vault's `hypo-guide.md`.
2. Merge the changed parts into the vault copy and keep the user's own edits.
3. Set `version:` in the vault copy's frontmatter to the package version shown on that line.
4. Run the check again. The warning clears.

The stamp only records that the template was reviewed. It does not prove the contents match, so do not raise it before the merge is done.

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

---

## `--migrate-sessions` (a vault with a git remote)

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/upgrade.mjs [--hypo-dir="<path>"] --migrate-sessions
```

This moves the vault from the tracked `hot.md` and `session-state.md` files to per-session entries under `projects/<p>/sessions/`. A vault with a remote does not move by itself: it waits for this command, which commits the move and pushes it right away.

**Upgrade all machines first.** Every machine that uses the vault must run this Hypomnema version before you run the command. A machine that skipped the upgrade, once it pulls the move commit:

1. loses the session view in what it injects at session start,
2. stalls its whole sync if it holds an unpushed commit that edits `hot.md` or `session-state.md`, and
3. if it uses the plugin channel, is not refreshed on its own (run `/plugin marketplace update hypomnema`, then `/reload-plugins` in every session that is already open).

**When to ask.** If the user typed `/hypo:upgrade --migrate-sessions` directly, run it without asking again: typing the flag is their statement that all machines are upgraded. Only when you are the one proposing this flag, or about to run it during another flow, first ask the user whether every machine that uses the same vault has been upgraded, because the command pushes the migration commit at once.

What it does, in order: fetch; if another machine already moved the vault, take in that commit without migrating (this machine never migrates a remote that is already moved), then pull and push as the last step does; otherwise merge the remote history first so the move is built on the newest commit; migrate (also clearing a rollback marker); pull and push. It brings an older edition of the `.gitignore` / `.gitattributes` block up to the current one. If taking in a moved remote leaves generated views tracked here (an old machine's unpushed work came along), it stops before pushing, names the paths and the `git rm --cached` repair, and exits 1.

During this one-time merge, a page that one machine renamed and edited while another machine edited it too ends as a modify/delete conflict, and the sync aborts so you can merge that page by hand.

Show the output verbatim. Exit code 1 means a step stopped and printed why (a deferred pull, a lock held by another session, a rejected push). Fix the cause and run the same command again: a repeat after a failed push adds no new commit and only pushes.

While machines are catching up, a plain `git pull` or Obsidian Git can hit conflicts that Hypomnema's own sync resolves. Tell the user this once after the command succeeds.
