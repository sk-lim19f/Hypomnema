---
description: Initialize a new Hypomnema wiki
---

You are running `/hypo:init`. Set up a new personal wiki powered by Hypomnema.

## What this does

- Creates the wiki directory structure (`pages/`, `projects/`, `sources/`, etc.)
- Copies baseline template files (`index.md`, `hot.md`, `log.md`, `hypo-config.md`)
- Installs Claude Code hooks for automatic context injection
- Merges hook entries into `~/.claude/settings.json` (idempotent)
- Optionally sets up git with a remote

---

## Step 1 — Wizard

Ask the following questions **one at a time**. Use the default if the user presses Enter.

1. **Wiki directory**
   > "Where should your wiki live? [~/wiki]"
   Default: `~/wiki`

2. **Privacy mode**
   > "Privacy mode? (personal / shared / public) [personal]"
   - `personal` — standard, for private personal use
   - `shared`   — adds extra ignore rules for names/orgs
   - `public`   — maximum redaction (blocks `journal/`, personal identifiers)
   Default: `personal`

3. **Install hooks**
   > "Install Claude Code hooks for automatic context injection? [yes]"
   Default: yes

4. **Codex hooks** — ask only if the user answered **yes** to hooks AND `~/.codex/` exists
   > "Also install Codex-compatible hooks in ~/.codex/hooks/? [yes]"
   Default: yes
   Skip this question if hooks=no or `~/.codex/` does not exist.

5. **Git remote** (optional)
   > "Git remote URL for sync/backup? (Enter to skip)"
   Default: skip

---

## Step 2 — Run the init script

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).
Then run:

```bash
node <package-root>/scripts/init.mjs \
  --wiki-dir="<wiki-dir>" \
  --privacy=<privacy> \
  [--no-hooks] \
  [--codex] \
  [--git-remote=<url>] \
  [--no-git-init]
```

Add `--dry-run` first to preview the changes, then run without it.

---

## Step 3 — Report results

Show the script output to the user:
- ✓ Created files/dirs
- ⊘ Skipped (already existed — no overwrites)
- ↪ Merged into settings.json
- ✗ Errors (if any)

---

## Step 4 — Next steps

After a successful init, tell the user:

1. **Restart Claude Code** (or reload the window) so the new hooks take effect.
2. Run `/hypo:doctor` to verify the installation.
3. Open `<wiki-dir>/wiki-guide.md` to read the operations guide.

If hooks were installed: note that `~/.claude/settings.json` was updated and a restart is required.
