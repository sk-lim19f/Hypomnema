---
title: Wiki Automation
type: reference
updated: YYYY-MM-DD
tags: [wiki, automation, hooks]
---

# Wiki Automation

How Hypomnema's Claude Code hooks work together to automate context injection,
session continuity, and git sync.

---

## Hook Overview

All 15 hooks registered in `hooks/hooks.json` are listed below, in registration order.

| Hook | Event | Purpose |
|------|-------|---------|
| `hypo-close-guard.mjs` | `PreToolUse` | Blocks a direct Write/Edit/MultiEdit bypass of the session-close approval flow |
| `hypo-session-start.mjs` | `SessionStart` | Injects `hot.md` and `session-state.md` into context on session start |
| `hypo-session-end.mjs` | `SessionEnd` | Records the dying session's identity so a `/clear` can be detected and recovered from on the next start |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | Injects a one-line resume summary on the first prompt after a session start or cwd change |
| `hypo-lookup.mjs` | `UserPromptSubmit` | Searches the wiki index for each prompt and injects matched pages as context |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | Prompts session close in chat when `/compact` or `/clear` is typed and close is incomplete |
| `hypo-personal-check.mjs` | `PreCompact` | Hard-gates `/compact`, blocking on missing session-close files, uncommitted wiki changes, or lint blockers |
| `hypo-auto-stage.mjs` | `PostToolUse` | Auto-stages a wiki file after it is written |
| `hypo-web-fetch-ingest.mjs` | `PostToolUse` | Nudges Claude to ingest WebFetch/WebSearch results into `sources/` |
| `hypo-hot-rebuild.mjs` | `Stop` | Rebuilds root `hot.md`'s pointer table and frontmatter at session end |
| `hypo-session-record.mjs` | `Stop` | Appends the completed session to the session index |
| `hypo-auto-commit.mjs` | `Stop` | Stages, commits, and pushes this session's touched wiki paths |
| `hypo-auto-minimal-crystallize.mjs` | `Stop` | Blocks `Stop` when the session did substantial work, the user signalled wrap-up, and no close was recorded. A substantial session with no close signal is let through |
| `hypo-cwd-change.mjs` | `CwdChanged` | Re-injects the matching project's `hot.md` when the working directory changes mid-session |
| `hypo-file-watch.mjs` | `FileChanged` | Re-injects any vault file changed on disk outside the session, once it passes the ignore and visibility filters |

Two hooks reach the network; the rest compute locally. There are two separate kinds of
network traffic here, and only one of them can be turned off.

**Your vault's own git remote.** Whenever the vault is a git repo with a remote, the wiki
syncs through it and its contents go wherever that remote lives. No flag disables this;
remove the remote if you do not want it.

- `hypo-session-start.mjs` (`SessionStart`) runs `git pull --ff-only` before it reads any
  vault file. It waits for that pull, up to a 10 second timeout.
- `hypo-auto-commit.mjs` (`Stop`) runs `git pull` and `git push` after committing this
  session's touched paths.

**The update check.** `hypo-session-start.mjs` also spawns a background check that fetches
two URLs:

- `https://registry.npmjs.org/hypomnema/latest`
- `https://raw.githubusercontent.com/sk-lim19f/Hypomnema/main/.claude-plugin/marketplace.json`

That one is non-blocking, and it is skipped entirely when `HYPO_NO_UPDATE_CHECK`,
`NO_UPDATE_NOTIFIER`, or `CI` holds a non-empty value (an empty string does not count).
The same variables also silence the stale-sibling and package-root warnings. None of them
affect the git sync above.

---

## Session Flow

```
Session start
  └─ hypo-session-start.mjs → reads hot.md + session-state.md → injects context

During session
  └─ hypo-auto-stage.mjs → git-adds any wiki path a tool touched (not only .md edits)
  └─ hypo-web-fetch-ingest.mjs → after WebFetch/WebSearch, nudges an ingest
  └─ hypo-lookup.mjs → BM25-matches each prompt against the wiki index

Session end (Stop chain, in order)
  └─ hypo-hot-rebuild.mjs → refreshes root hot.md
  └─ hypo-session-record.mjs → appends to the session index
  └─ hypo-auto-commit.mjs → git commit + push
  └─ hypo-auto-minimal-crystallize.mjs → blocks Stop if session close never ran
```

---

## `.hypoignore`

Files matching patterns in `.hypoignore` are kept out of the context hooks inject and out
of index lookups. They stay on disk.

This is not a blanket read barrier. Some hooks touch a file before the ignore list is
consulted: the `SessionStart` base snapshot hashes the four session-close overwrite
targets whether or not they are ignored. Treat `.hypoignore` as "do not surface this",
not as "nothing in Hypomnema opens this".

```
# Example .hypoignore
journal/
*private*
sources/*.pdf
```

Edit `.hypoignore` in your wiki root to exclude additional files or directories from hook context.

---

## Lint Gate

`hypo-personal-check.mjs` runs `lint.mjs` before destructive operations.
If **blocker** errors are found, the operation is blocked until errors are resolved.

Run `/hypo:lint` to check and fix issues.
