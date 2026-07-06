---
description: Pull extensions you made the normal way under ~/.claude/{commands,agents}, or a canonical hook registered in ~/.claude/settings.json, into the wiki so they sync to your other machines. Use when the user wants to capture, adopt, or back up a locally-authored slash command, agent, or hook into Hypomnema.
---

You are running `/hypo:capture`. Bring a command or agent that the user created the normal way (directly under `~/.claude/commands/` or `~/.claude/agents/`), or a hook they registered in `~/.claude/settings.json`, into the wiki `extensions/` tree so the existing forward-sync propagates it to their other machines under its original name.

Scope: commands, agents, and hooks. Commands and agents are enumerated from `~/.claude/{commands,agents}/`; hooks are read from the `~/.claude/settings.json` registration. A hook is captured only when its command is the canonical `node $HOME/.claude/hooks/<name>.mjs` form and it round-trips losslessly (original event, matcher, and timeout preserved); non-canonical or lossy registrations are skipped with a reason instead of being rewritten. Skills are not captured yet.

## Step 1: Resolve the package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema capture` or reinstall instead of guessing the cache layout.

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

## Step 2: List what can be captured

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs [--hypo-dir="<path>"]
```

With no names and no `--all`, the script lists capturable candidates and stops. It excludes anything already managed by the wiki, the reserved `hypo-*` namespace, symlinks, and non-`.md` files.

Show the list. Note that these are every unowned regular `.md` under the top-level directories, not a provenance check: explicit selection is the trust boundary. A third-party tool's file could appear here, so let the user pick deliberately.

## Step 3: Capture the user's selection

Ask which ones to capture, then run with the chosen names (space-separated), or `--all` if the user wants everything listed:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs [--hypo-dir="<path>"] <name> [<name> ...]
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs [--hypo-dir="<path>"] --all
```

A name is the filename (`mycmd.md`), its stem (`mycmd`), or the `type/file` form (`commands/mycmd.md`). Add `--dry-run` to preview without writing.

Each capture stores the file in the wiki as `extensions/<type>/hypo-ext-<name>.<ext>` (`.md` for commands and agents, `.mjs` for hooks) with a sidecar `hypo-ext-<name>.manifest.json` that records the original install name (and, for a hook, its event, matcher, and timeout), then adopts it so the currently-installed copy is left in place and tracked. A wiki file that already exists with different content (or a mismatched manifest) is refused, not overwritten.

## Step 4: Commit the wiki, then sync elsewhere

Show the script output verbatim. When something was captured, remind the user to commit and push the wiki, then run `hypomnema upgrade --apply` on their other machine to install the captured extension under its original name.
