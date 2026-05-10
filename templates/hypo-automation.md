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

| Hook | Event | Purpose |
|------|-------|---------|
| `hypo-session-start.mjs` | Session start | Injects `hot.md` and `session-state.md` into context |
| `hypo-first-prompt.mjs` | First user prompt | Injects active project context on first message |
| `hypo-auto-stage.mjs` | File save | Auto-stages changed wiki files |
| `hypo-auto-commit.mjs` | Session stop | Commits and pushes staged wiki changes |
| `hypo-compact-guard.mjs` | Pre-compact | Blocks `/compact` if session-log entry is missing |
| `hypo-hot-rebuild.mjs` | Post-tool | Rebuilds `hot.md` from project hot caches |
| `hypo-personal-check.mjs` | Pre-tool | Validates config and blocks on lint errors |

All hooks run **locally** — no network requests.

---

## Session Flow

```
Session start
  └─ hypo-session-start.mjs → reads hot.md + session-state.md → injects context

During session
  └─ hypo-auto-stage.mjs → auto-stages .md edits in wiki dir
  └─ hypo-hot-rebuild.mjs → refreshes hot.md after project hot.md changes

Session end
  └─ /session-compact → writes session-log, session-state, ADRs
  └─ hypo-auto-commit.mjs → git commit + push
```

---

## `.hypoignore`

Files matching patterns in `.hypoignore` are excluded from hook reads and index lookups.
They remain on disk but are invisible to all Hypomnema tooling.

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
