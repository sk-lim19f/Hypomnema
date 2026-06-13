---
description: Resume the most recent session for an active project
---

You are running `/hypo:resume`. Load the session state for an active project and pick up where you left off.

## What this does

- Reads `projects/<name>/session-state.md` (next tasks)
- Reads `projects/<name>/hot.md` (what was done last session)
- Offers to continue from the last stopping point

---

## Step 1 — Resolve project

If the user named a project in the command invocation, use that. Otherwise, locate the Hypomnema package root and run:

```bash
node <package-root>/scripts/resume.mjs [--hypo-dir="<path>"] [--project=<name>]
```

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
