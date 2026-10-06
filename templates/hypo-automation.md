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

All 12 hooks registered in `hooks/hooks.json` are listed below, in registration order.

| Hook | Event | Purpose |
|------|-------|---------|
| `hypo-close-guard.mjs` | `PreToolUse` | Blocks a direct Write/Edit/MultiEdit bypass of the session-close approval flow |
| `hypo-session-start.mjs` | `SessionStart` | Rebuilds the root `hot.md` projection, then injects `hot.md` and `session-state.md` into context on session start |
| `hypo-session-end.mjs` | `SessionEnd` | Records the dying session's identity so a `/clear` can be detected and recovered from on the next start |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | Injects a one-line resume summary on the first prompt after a session start or cwd change |
| `hypo-lookup.mjs` | `UserPromptSubmit` | Searches the wiki index for each prompt and injects matched pages as context |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | Prompts session close in chat when `/compact` or `/clear` is typed and close is incomplete |
| `hypo-personal-check.mjs` | `PreCompact` | Detects missing session-close files, uncommitted wiki changes, or lint blockers and surfaces them as a `systemMessage`; it does not block `/compact` |
| `hypo-auto-stage.mjs` | `PostToolUse` | Auto-stages a wiki file after it is written |
| `hypo-web-fetch-ingest.mjs` | `PostToolUse` | Nudges Claude to ingest WebFetch/WebSearch results into `sources/` |
| `hypo-stop.mjs` | `Stop` | Runs the session-end chain as four ordered stages, one after another, not in parallel: rebuilds the root `hot.md` projection, appends the session to the session index, stages/commits/pushes this session's touched wiki paths, then blocks `Stop` if the session did substantial work, the user signalled wrap-up, and no close was recorded |
| `hypo-cwd-change.mjs` | `CwdChanged` | Builds a `systemMessage` with the matching project's `hot.md` when the working directory changes mid-session. `additionalContext` is not among `CwdChanged`'s documented output fields, so this never becomes `additionalContext`; the reference says only that it "shows the `systemMessage` as a brief terminal notification," without saying whether it also reaches the model. As of Claude Code 2.1.276 (checked 2026-09-18) and reconfirmed on 2.1.283, tracing the installed binary shows the only consumer of that `systemMessage` is the terminal notification queue, with no branch that forwards it to the model; no live-session observation of this path exists either way, and this event is treated as not reaching the model until the documentation says otherwise |
| `hypo-file-watch.mjs` | `FileChanged` | Builds a `systemMessage` for a changed vault file once it passes the ignore and visibility filters, over the same field as `hypo-cwd-change` whose reach to the model the reference leaves undocumented; as of Claude Code 2.1.276 (checked 2026-09-18) and reconfirmed on 2.1.283 it is likewise treated as not reaching the model (see the row above). On a stock install the event still has no trigger here, because nothing in this package returns `watchPaths` to seed the watch list; that list is session-global, so another hook or plugin seeding it would still make this matcher-less group fire, though it returns immediately for any path that does not start with `HYPO_DIR` (a string-prefix check, not a symlink-resolving one) |

This file is copied into a vault only at `init` time, and no update channel pushes a later fix here into a vault that already exists. So this copy can be older than the shipped one. `hooks/hooks.json` in the package is the source of truth for which hook runs on which event; when this table disagrees with it, the table is what went stale.

Two hooks reach the network; the rest compute locally. There are two separate kinds of
network traffic here, and only one of them can be turned off.

**Your vault's own git remote.** Whenever the vault is a git repo with a remote, the wiki
syncs through it and its contents go wherever that remote lives. No flag disables this;
remove the remote if you do not want it.

- `hypo-session-start.mjs` (`SessionStart`) runs `git pull --ff-only` before it reads any
  vault file. It waits for that pull, up to a 10 second timeout.
- `hypo-stop.mjs` (`Stop`) runs `git pull` and `git push`, via its `hypo-auto-commit.mjs`
  stage, after committing this session's touched paths.

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
  └─ hypo-session-start.mjs → rebuilds root hot.md → reads hot.md + session-state.md → injects context

During session
  └─ hypo-auto-stage.mjs → git-adds any wiki path a tool touched (not only .md edits)
  └─ hypo-web-fetch-ingest.mjs → after WebFetch/WebSearch, nudges an ingest
  └─ hypo-lookup.mjs → BM25-matches each prompt against the wiki index

Session end (single Stop hook, hypo-stop.mjs, running four stages in order)
  └─ hypo-hot-rebuild.mjs → refreshes root hot.md (same generator SessionStart also calls)
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

`hypo-personal-check.mjs` runs `lint.mjs` before a compact.
Blocker errors are reported in its `systemMessage`; the PreCompact hook does not
stop `/compact` on them. The two places that still refuse on a red gate are
`crystallize --check-session-close` (it reports the gate blockers; whether this session's close is recorded is its separate `close_state` line)
and the marker writer (`--mark-session-closed` will not stamp a marker).

Run `/hypo:lint` to check and fix issues.
