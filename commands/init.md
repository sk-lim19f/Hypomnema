---
description: Initialize a new Hypomnema wiki (structure, config, hooks). Use when the user is setting up a wiki for the first time or starting a fresh vault.
---

You are running `/hypo:init`. Set up a new personal wiki powered by Hypomnema.

**If the user passes a remote URL** (e.g. `/hypo:init --from-remote git@github.com:user/wiki.git`), skip the wizard and go directly to [Step 2a — From Remote](#step-2a).

---

## What this does

- Creates the Hypomnema directory structure (`pages/`, `projects/`, `sources/`, etc.)
- Copies baseline template files (`index.md`, `hot.md`, `log.md`, `hypo-config.md`, `SCHEMA.md`, `hypo-guide.md`)
- Installs Claude Code hooks for automatic context injection
- Merges hook entries into `~/.claude/settings.json` (idempotent)
- Optionally sets up git with a remote

---

## Step 1 — Wizard

Ask the following questions **one at a time**. Use the default if the user presses Enter.

1. **Wiki directory**
   > "Where should your wiki live? [~/hypomnema]"
   Default: `~/hypomnema`

2. **Install hooks**
   > "Install Claude Code hooks for automatic context injection? [yes]"
   Default: yes

3. **Codex hooks** — ask only if the user answered **yes** to hooks AND `~/.codex/` exists
   > "Also install Codex-compatible hooks in ~/.codex/hooks/? [yes]"
   Default: yes
   Skip this question if hooks=no or `~/.codex/` does not exist.

4. **Git remote** (optional)
   > "Git remote URL for sync/backup? (Enter to skip)"
   Default: skip

---

## Step 2a — From Remote (skip wizard) {#step-2a}

If the user provided `--from-remote <url>`, run:

```bash
node <package-root>/scripts/init.mjs \
  --from-remote="<url>" \
  --hypo-dir="<hypo-dir>" \
  [--no-hooks] \
  [--codex]
```

- `--hypo-dir` defaults to `~/hypomnema` if not specified.
- The script clones the remote, validates that `hypo-config.md` exists, installs hooks, and merges `~/.claude/settings.json`.
- If the cloned repo is not a Hypomnema wiki (no `hypo-config.md`), the clone is removed and the command exits with an error.
- Skip to **Step 3** after running.

---

## Step 2 — Run the init script (new wiki)

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).
Then run:

```bash
node <package-root>/scripts/init.mjs \
  --hypo-dir="<hypo-dir>" \
  [--no-hooks] \
  [--codex] \
  [--git-remote=<url>] \
  [--no-git-init]
```

Add `--dry-run` first to preview the changes, then run without it.

After init, the user can edit `.hypoignore` directly to exclude any files or directories from hook context.

---

## Step 3 — Report results

Show the script output to the user:
- ✓ Created files/dirs (includes journal/, projects/_template/, first commit)
- ⊘ Skipped (already existed — no overwrites)
- ↪ Merged into settings.json / pushed to remote
- ✗ Errors (if any)

---

## Step 4 — Next steps

After a successful init, tell the user:

1. **Restart Claude Code** (or reload the window) so the new hooks take effect.
2. Run `/hypo:doctor` to verify the installation.
3. Open `<hypo-dir>/hypo-guide.md` to read the operations guide.

If hooks were installed: note that `~/.claude/settings.json` was updated and a restart is required.
