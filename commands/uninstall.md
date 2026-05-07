---
description: Remove Hypomnema hooks and clean up settings.json
---

You are running `/hypo:uninstall`. Remove Hypomnema from this machine.

## What this does

- Removes Hypomnema hook files from `~/.claude/hooks/` (and optionally `~/.codex/hooks/`)
- Strips Hypomnema entries from `~/.claude/settings.json`, leaving all other hooks untouched
- **Dry-run by default** — shows what would be removed without making any changes

---

## Step 1 — Confirm intent

Say:
> "This will remove Hypomnema hooks from your system. Your wiki files are NOT deleted.
> Run in dry-run mode first to preview changes? [yes]"

Default: yes (dry-run first)

---

## Step 2 — Dry run

Run:
```
node scripts/uninstall.mjs
```

Show the output to the user. Ask:
> "Proceed with removal? (yes / no)"

If no → abort and confirm nothing was changed.

---

## Step 3 — Apply (if confirmed)

```
node scripts/uninstall.mjs --apply
```

If the user also wants Codex hooks removed, append `--codex`.

---

## Notes

- Wiki content (`~/wiki/`) is never touched — only hook files and settings.json entries
- To reinstall, run `/hypo:init`
