---
description: Resume an active project and pick up where you left off. Use when the user asks to continue prior work or what they were working on.
---

You are running `/hypo:resume`. Load the session state for an active project and pick up where you left off.

## What this does

- Reads `projects/<name>/session-state.md` (next tasks)
- Reads `projects/<name>/hot.md` (what was done last session)
- Offers to continue from the last stopping point

---

## Step 1 — Resolve project

If the user named a project in the command invocation, use that. Otherwise, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/resume.mjs [--hypo-dir="<path>"] [--project=<name>]
```

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

When `--project` is omitted, the script prefers the project whose `working_dir` contains the current directory (cwd-first); if nothing under the current directory matches, it falls back to the most recently active project from `hot.md`.

---

## Step 2 — Present session state

Show the output from the script:
- **Project** name
- **Next tasks** from `session-state.md`
- **Background** from `hot.md` (what was done last session, condensed)

---

## Step 3 — Offer to continue

After presenting the state, ask:

> "Ready to pick up from here? Which task should we start with?"

If the session-state lists numbered tasks, offer them as options. Start immediately once the user selects one.

---

## Step 4 — On completion of a task

When a task is marked done, offer to update `session-state.md` to reflect the new state before closing.
