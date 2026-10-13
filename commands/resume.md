---
description: Resume an active project and pick up where you left off. Use when the user asks to continue prior work or what they were working on.
---

You are running `/hypo:resume`. Load the session state for an active project and pick up where you left off.

## What this does

- Renders the next tasks and what was done last session from the session entries in `projects/<name>/sessions/`. A project that has not moved to session entries yet shows its old `session-state.md` and `hot.md` in their place.
- Offers to continue from the last stopping point

---

## Step 1 — Resolve project

If the user named a project in the command invocation, use that. Otherwise, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/resume.mjs [--hypo-dir="<path>"] [--project=<name>] [--session-id=<current-session-id>]
```

Pass `--session-id` with the main conversation's session id (`$CLAUDE_CODE_SESSION_ID`) when you have it. The script records which task heads it showed, so the next close can replace them. Without an id it still works and records nothing.

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install) or reinstall instead of guessing the cache layout.

When `--project` is omitted, the script prefers the project whose `working_dir` contains the current directory (cwd-first); if nothing under the current directory matches, it falls back to the most recently active project from `hot.md`.

---

## Step 2 — Present session state

Show the output from the script:
- **`[WIKI: ...]` notice**, if present, first and verbatim. It names uncommitted changes elsewhere in the vault (another project, or unattributable to any project) that are not this session's scope. Do not fold this line into the project summary or fetch/edit the paths it names without the user's explicit instruction.
- **Project** name
- **Next up**: the list of active tasks, then the rendered session state with each task's text
- **Background**: the recent session summaries

---

## Step 3 — Offer to continue

After presenting the state, ask:

> "Ready to pick up from here? Which task should we start with?"

If the session-state lists numbered tasks, offer them as options. Start immediately once the user selects one.

---

## Step 4 — On completion of a task

When a task is marked done, mention it in the close payload's `tracks` when closing. `session-state.md` and `hot.md` are generated from the session entries, so do not edit them by hand: the close guard refuses the write.
