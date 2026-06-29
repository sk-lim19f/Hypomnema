---
title: Hypomnema Config
type: config
version: "1.5.0"
created: YYYY-MM-DD
---

# Hypomnema Config

This file marks the root of your Hypomnema wiki.
Hooks use it to locate the wiki root automatically — do not delete or move it.

## Settings

To override the wiki root path, set the `HYPO_DIR` environment variable
instead of editing this file.

To bypass the session-close gate (e.g. for trivial sessions):
```
HYPO_SKIP_GATE=1
```

## Layout

```
<hypo-root>/
├── hypo-config.md      ← you are here (root marker)
├── index.md            ← searchable page index
├── hot.md              ← active-project pointer table
├── log.md              ← chronological activity log
├── hypo-guide.md       ← operations guide
├── SCHEMA.md           ← type system reference
├── .hypoignore         ← glob patterns excluded from hooks
├── pages/              ← permanent knowledge pages
├── projects/           ← project work artifacts
│   └── <name>/
│       ├── index.md    ← project overview (working_dir: field)
│       ├── hot.md      ← project-scoped session snapshot
│       └── session-log/    ← daily shards (YYYY-MM-DD.md)
└── sources/            ← raw ingested sources (read-only)
```
