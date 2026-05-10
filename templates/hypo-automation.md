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
| `wiki-session-start.mjs` | Session start | Injects `hot.md` and `session-state.md` into context |
| `wiki-first-prompt.mjs` | First user prompt | Injects active project context on first message |
| `wiki-auto-stage.mjs` | File save | Auto-stages changed wiki files |
| `wiki-auto-commit.mjs` | Session stop | Commits and pushes staged wiki changes |
| `wiki-compact-guard.mjs` | Pre-compact | Blocks `/compact` if session-log entry is missing |
| `wiki-hot-rebuild.mjs` | Post-tool | Rebuilds `hot.md` from project hot caches |
| `personal-wiki-check.mjs` | Pre-tool | Validates config and blocks on lint errors |

All hooks run **locally** — no network requests.

---

## Session Flow

```
Session start
  └─ wiki-session-start.mjs → reads hot.md + session-state.md → injects context

During session
  └─ wiki-auto-stage.mjs → auto-stages .md edits in wiki dir
  └─ wiki-hot-rebuild.mjs → refreshes hot.md after project hot.md changes

Session end
  └─ /session-compact → writes session-log, session-state, ADRs
  └─ wiki-auto-commit.mjs → git commit + push
```

---

## `.wikiignore`

Files matching patterns in `.wikiignore` are excluded from hook reads and index lookups.
They remain on disk but are invisible to all Hypomnema tooling.

```
# Example .wikiignore
journal/
*private*
sources/*.pdf
```

See [docs/PRIVACY.md](https://github.com/sk-lim19f/Hypomnema/blob/main/docs/PRIVACY.md) for full privacy documentation.

---

## Lint Gate

`personal-wiki-check.mjs` runs `lint.mjs` before destructive operations.
If **blocker** errors are found, the operation is blocked until errors are resolved.

Run `/hypo:lint` to check and fix issues.
