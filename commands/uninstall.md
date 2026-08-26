---
description: Remove Hypomnema hooks and clean up settings.json. Use when the user wants to uninstall or disable the wiki integration.
---

You are running `/hypo:uninstall`. Remove Hypomnema from this machine.

## What this does

- Removes Hypomnema hook files from `~/.claude/hooks/` (and optionally `~/.codex/hooks/`)
- Strips Hypomnema entries from `~/.claude/settings.json`, leaving all other hooks untouched
- Removes the `claude()` shell function block from `~/.zshrc` and/or `~/.bashrc` (whichever carries the marker `init` wrote; use `--shell-config=<path>` to target a different file)
- Removes the marked pre-commit hook from the wiki repo (`<wiki>/.git/hooks/pre-commit`); resolve a non-default wiki with `--hypo-dir=<path>`
- Removes tracked slash commands, extension hard-copies, and `~/.claude/hypo-pkg.json` when nothing user-modified is left behind
- Every removal above is marker- or SHA-gated: a block or file you have since hand-edited is reported and left in place, never guessed at
- **The wiki content itself (pages, journal, sources under the vault root) is never deleted, only the git hook and shell block Hypomnema installed**
- **Dry-run by default**: shows what would be removed without making any changes

---

## Step 1 — Confirm intent

Say:
> "This will remove Hypomnema's hooks, slash commands, the claude() shell function block, and the wiki's pre-commit hook. Your wiki content (pages, journal, sources) is NOT deleted.
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

If the user also wants Codex hooks removed, append `--codex`. Other flags worth knowing about:
- `--hypo-dir=<path>`: the wiki whose pre-commit hook gets removed, if it is not the default-resolved one
- `--shell-config=<path>`: the single rc file to strip the shell block from, instead of checking both `~/.zshrc` and `~/.bashrc`
- `--force-commands` / `--force-extensions`: remove a slash command or extension file even if its content no longer matches what Hypomnema installed
- `--hooks-dir=<path>`: only redirects the `~/.claude/hooks/*.mjs` cleanup, so a run scoped to a sandbox hooks directory still touches the real shell rc files and wiki vault unless `--keep-shell` and/or `--keep-wiki-hook` are also passed. The script warns about this before it does anything if it detects the combination
- `--keep-shell`: skip the shell rc `claude()` block removal entirely
- `--keep-wiki-hook`: skip the wiki pre-commit hook removal entirely, including the step that resolves which vault it would have looked at

---

## Notes

- Wiki content under `~/hypomnema/` (pages, journal, sources, etc.) is never touched
- What IS removed by `--apply`: hook files, settings.json entries, the shell rc `claude()` block, and the wiki's own pre-commit hook
- To reinstall, run `/hypo:init`
