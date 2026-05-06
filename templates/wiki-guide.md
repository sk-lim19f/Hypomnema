---
title: Wiki Operations Guide
type: reference
updated: YYYY-MM-DD
tags: [wiki, guide, operations]
---

# Wiki Operations Guide

How to run this wiki. For the type system, see [[SCHEMA]].

> **Before any wiki task**: read `SCHEMA.md` → `wiki-guide.md` on the first wiki operation of a session. Reuse for subsequent operations. Re-read after `/compact`, context resume, or if unsure.

---

## 1. Why This Wiki Exists

Standard RAG chunks sources as-is — contradictions, stale content and all.
This wiki is different: **an LLM reads each source, synthesizes it, and updates existing pages**.
Over time, new sources *update* pages more than they *create* them — that's when compound value starts.

---

## 2. Directory Layout

```
<wiki-root>/
├── hypo-config.md      ← root marker (do not delete)
├── index.md            ← searchable page catalog
├── hot.md              ← active-project pointer table
├── log.md              ← append-only activity log
├── SCHEMA.md           ← type system reference
├── wiki-guide.md       ← this file
├── .wikiignore         ← privacy/exclusion patterns
├── pages/              ← permanent knowledge pages
│   ├── learnings/
│   ├── playbooks/
│   ├── tool-evaluations/
│   ├── prompt-patterns/
│   ├── feedback/
│   ├── syntheses/
│   ├── tips/
│   ├── people/
│   ├── orgs/
│   └── open-questions.md
├── projects/           ← project work artifacts
│   └── <name>/
│       ├── index.md          ← overview (working_dir: field)
│       ├── prd.md            ← purpose / success criteria
│       ├── hot.md            ← session snapshot
│       ├── session-state.md  ← next-session handoff
│       ├── session-log/      ← monthly narrative logs
│       └── decisions/        ← ADRs (0001-*.md …)
├── sources/            ← raw ingested sources (never edit)
├── journal/            ← weekly/monthly journals
│   └── weekly/
└── decisions/          ← cross-project ADRs
```

**Rule**: never edit `sources/`. All knowledge creation goes in `pages/` and `projects/`.

---

## 3. Core Operations

### Session Start

1. Read root `hot.md` → identify active project
2. If `cwd` matches `projects/<name>/index.md`'s `working_dir:` field → read `projects/<name>/session-state.md` first
3. Read `projects/<name>/hot.md` for background context
4. Offer: "Continuing [X] from last session — shall we pick up?"

### Session Close

Trigger: explicit close mention, `/compact` request, or context limit approaching.

1. Update `projects/<name>/session-state.md` (next tasks, overwrite)
2. Update `projects/<name>/hot.md` (what was done, ≤500 words, overwrite)
3. Append to `projects/<name>/session-log/YYYY-MM.md` (narrative entry, append-only)
4. Update root `hot.md` pointer table + date

Skip session close for: single bug fix, single-file edit, Q&A only.

### Ingest (external source → wiki)

1. Save raw source to `sources/<slug>.<ext>` (never edit after)
2. Read and synthesize
3. Update or create pages in `pages/` with frontmatter `source: <slug>`
4. Append to `index.md`
5. Append to `log.md`

### Query

1. Read `index.md` first
2. Cross-reference related pages
3. Synthesize answer — cite `[[page-slug]]` links

---

## 4. Page Creation Checklist

- [ ] Correct `type` from SCHEMA taxonomy
- [ ] `updated: YYYY-MM-DD` (today's date)
- [ ] Meaningful `tags` (see SCHEMA §4)
- [ ] Added to `index.md`
- [ ] Cross-links to related pages

---

## 5. Project Lifecycle

### Start a project

```
projects/<name>/
├── index.md          (working_dir: /path/to/repo)
├── prd.md
└── session-state.md
```

Add to root `hot.md` active projects table.

### Close a project

1. Write final `session-state.md` (mark as complete)
2. Update `projects/<name>/index.md` status
3. Remove from root `hot.md` active table (or mark archived)

---

## 6. ADR Format

```
projects/<name>/decisions/NNNN-short-title.md
```

```yaml
---
title: "NNNN: Short Title"
type: adr
status: accepted | deprecated | superseded
date: YYYY-MM-DD
superseded_by: NNNN   # if applicable
---
```

ADRs are immutable once accepted. Mark deprecated/superseded but never edit content.

---

## 7. Maintenance

- **Weekly**: check `pages/open-questions.md` for resolved items
- **Monthly**: review `log.md` for source-starved weeks (< 1 external source)
- **On schema change**: bump `SCHEMA.md` version, update this guide if layout changed
