---
description: Pull extensions you made the normal way under ~/.claude/{commands,agents,skills}, or a canonical hook registered in ~/.claude/settings.json, into the wiki so they sync to your other machines. Use when the user wants to capture, adopt, or back up a locally-authored slash command, agent, skill, or hook into Hypomnema.
---

You are running `/hypo:capture`. Bring a command, agent, or skill that the user created the normal way (directly under `~/.claude/commands/`, `~/.claude/agents/`, or `~/.claude/skills/`), or a hook they registered in `~/.claude/settings.json`, into the wiki `extensions/` tree so the existing forward-sync propagates it to their other machines under its original name.

Scope: commands, agents, skills, and hooks. Commands and agents are enumerated from `~/.claude/{commands,agents}/`; a skill is a whole directory (`~/.claude/skills/<name>/SKILL.md` plus its subtree); hooks are read from the `~/.claude/settings.json` registration.

Hooks and skills are captured only when they round-trip losslessly, because what lands in the wiki is exactly what the far machine installs. A hook qualifies when its command is the canonical `node $HOME/.claude/hooks/<name>.mjs` form and its event, matcher, and timeout are preserved. A skill is refused whole (never captured as a partial subset) when its subtree holds anything that cannot survive the trip: a symlink, a hardlink, an empty directory (git cannot carry one), a VCS control directory, or more than 500 files / 5 MiB. That ceiling is what keeps a vendored skill with its own `node_modules` out of the vault. Content is reproduced byte for byte, and a newly captured executable script keeps its executable bit through the wiki and onto every install. A skill captured before this behavior shipped has its wiki copy recorded non-executable, and there is no automatic fix once that has happened: it is already managed by the wiki, so it never shows up as a capture candidate again, and forward-sync's own heal only adds a missing exec bit while the install's content still matches the wiki record byte for byte. If the wiki content changes later for an unrelated reason, the install picks up whatever mode the new wiki bytes carry, exec bit included, so the mode can move in either direction at that point, not just up. The only working fix for an already-committed non-executable script is `chmod +x` directly on the wiki file; since that is a mode-only change with the content untouched, forward-sync's heal then carries the bit to every install from there.

## Step 1: Resolve the package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema capture` or reinstall instead of guessing the cache layout.

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

## Step 2: List what can be captured

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs [--hypo-dir="<path>"]
```

With no names and no `--all`, the script lists capturable candidates and stops. Candidates come from three sources: commands and agents are the unowned regular `.md` files under `~/.claude/{commands,agents}/`; skills are the unowned directories under `~/.claude/skills/` that hold a real `SKILL.md`; hooks are the canonical `node $HOME/.claude/hooks/<name>.mjs` entries registered in `~/.claude/settings.json`. It excludes anything already managed by the wiki, the reserved `hypo-*` namespace, symlinks and other non-regular files, core hooks, and anything that would not round-trip losslessly. Skipped hooks and skills are printed with the reason; unowned commands and agents that fail these filters are simply omitted from the list, without a per-item reason.

Show the list. Note that these are unowned candidates, not a provenance check: explicit selection is the trust boundary. A third-party tool's command, agent, or hook could appear here, so let the user pick deliberately.

## Step 3: Capture the user's selection

Ask which ones to capture, then run with the chosen names (space-separated), or `--all` if the user wants everything listed:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs [--hypo-dir="<path>"] <name> [<name> ...]
node ${CLAUDE_PLUGIN_ROOT}/scripts/capture.mjs [--hypo-dir="<path>"] --all
```

A name is the filename (`mycmd.md`, or `myhook.mjs` for a hook), its stem (`mycmd`, and for a skill the directory name), or the `type/file` form (`commands/mycmd.md`, `skills/myskill`). When a bare name matches more than one candidate (a `mine` command and a `mine` skill), the script refuses it and asks for the type-qualified form. Add `--dry-run` to preview without writing, or `--type=skills` to narrow the scan.

A flat capture stores the file in the wiki as `extensions/<type>/hypo-ext-<name>.<ext>` (`.md` for commands and agents, `.mjs` for hooks). A skill is stored as a directory, `extensions/skills/hypo-ext-<name>/`, with its subtree intact. Either way a sidecar `hypo-ext-<name>.manifest.json` records the original install name (and, for a hook, its event, matcher, and timeout), and the capture is then adopted so the currently-installed copy is left in place and tracked. A wiki entry that already exists with different content (or a mismatched manifest) is refused, not overwritten.

## Step 4: Commit the wiki, then sync elsewhere

Show the script output verbatim. When something was captured, remind the user to commit and push the wiki, then run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install) on their other machine to install the captured extension under its original name.
