---
title: Hypomnema — Command Reference
type: reference
updated: YYYY-MM-DD
tags: [hypo, commands, reference]
---

# Hypomnema Command Reference

Quick reference for all `/hypo:*` commands.

---

## Setup & Maintenance

| Command | Description |
|---------|-------------|
| `/hypo:init` | Initialize a new wiki (first-time setup) |
| `/hypo:doctor` | Health check — verifies dirs, hooks, settings |
| `/hypo:upgrade` | Update hooks and settings to latest version |
| `/hypo:uninstall` | Remove hooks and deregister from settings.json |

---

## Daily Operations

| Command | Description |
|---------|-------------|
| `/hypo:resume` | Show next tasks from session-state.md |
| `/hypo:query <terms>` | Full-text search + synthesis across all pages |
| `/hypo:ingest <url/text>` | Add external knowledge to sources/ and synthesize |
| `/hypo:feedback <topic>` | Record AI behavior correction for a topic |
| `/hypo:stats` | Wiki health summary — page counts, ADRs, last activity |

---

## Knowledge Curation

| Command | Description |
|---------|-------------|
| `/hypo:crystallize` | Close a session (steps 1~6 hard gate) and, on request, surface synthesis candidates (steps 7~11) — tag clusters, unlinked pages, drafts |
| `/hypo:verify` | Review overdue verify_by deadlines |
| `/hypo:lint` | Validate frontmatter and `[[wikilinks]]` |
| `/hypo:graph` | Generate link graph (json / mermaid / dot) |

---

## Tips

- **Session start**: `hot.md` → `session-state.md` → begin work
- **Session end**: run `/session-compact` (if available) or update session-state.md manually
- **Privacy**: edit `.hypoignore` to exclude sensitive paths from hooks
- **Verify schedule**: add `verify_by:` and `verify_by_date:` to pages you want to review periodically
