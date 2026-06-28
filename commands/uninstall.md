---
description: Remove Hypomnema hooks and clean up settings.json. Use when the user wants to uninstall or disable the wiki integration.
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

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

---

## Step 2 — Dry run

Run:
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs
```

Show the output to the user. Ask:
> "Proceed with removal? (yes / no)"

If no → abort and confirm nothing was changed.

---

## Step 3 — Apply (if confirmed)

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/uninstall.mjs --apply
```

If the user also wants Codex hooks removed, append `--codex`.

---

## Notes

- Wiki content (`~/hypomnema/`) is never touched — only hook files and settings.json entries
- To reinstall, run `/hypo:init`
