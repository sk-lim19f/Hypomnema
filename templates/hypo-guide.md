---
title: Wiki Operations Guide
type: reference
updated: YYYY-MM-DD
tags: [wiki, guide, operations]
---

# Wiki Operations Guide

How to run this wiki. For the type system, see [[SCHEMA]].

> **Before any wiki task**: read `SCHEMA.md` → `hypo-guide.md` on the first wiki operation of a session. Reuse for subsequent operations. Re-read after `/compact`, context resume, or if unsure.

---

## 1. Why This Wiki Exists

Standard RAG chunks sources as-is — contradictions, stale content and all.
This wiki is different: **an LLM reads each source, synthesizes it, and updates existing pages**.
Over time, new sources *update* pages more than they *create* them — that's when compound value starts.

---

## 2. Directory Layout

```
<hypo-root>/
├── hypo-config.md      ← root marker (do not delete)
├── index.md            ← searchable page catalog
├── hot.md              ← active-project pointer table
├── log.md              ← append-only activity log
├── SCHEMA.md           ← type system reference
├── hypo-guide.md       ← this file
├── .hypoignore         ← privacy/exclusion patterns
├── pages/              ← permanent knowledge pages (subdirs added on demand)
│   ├── learnings/      (optional)
│   ├── playbooks/      (optional)
│   ├── feedback/       (optional)
│   └── open-questions.md  (optional)
├── projects/           ← project work artifacts
│   └── <name>/
│       ├── index.md          ← overview (working_dir: field)
│       ├── prd.md            ← purpose / success criteria
│       ├── hot.md            ← session snapshot
│       ├── session-state.md  ← next-session handoff
│       ├── session-log/      ← monthly narrative logs
│       └── decisions/        ← ADRs (0001-*.md …)
└── sources/            ← raw ingested sources (never edit)
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

**Auto-trigger rule**: when the user sends a natural-language close signal — "세션 마무리하자", "오늘 여기까지", "이만 종료", "wrap up", "signing off", or equivalent — run the session close checklist immediately without waiting for an explicit `/compact` or `/hypo:crystallize`. If the intent is ambiguous, confirm with a single question before proceeding.

1. Update `projects/<name>/session-state.md` (next tasks, overwrite)
2. Update `projects/<name>/hot.md` (what was done, ≤500 words, overwrite)
3. Append to `projects/<name>/session-log/YYYY-MM.md` (narrative entry, append-only)
4. Update root `hot.md` pointer table + date

Skip session close for: single bug fix, single-file edit, Q&A only.

### Ingest (external source → wiki)

**Auto-trigger rule**: after any `WebFetch` / `WebSearch` that yields new knowledge relevant to the current task, run `/hypo:ingest` immediately — do not wait for the user to ask.

1. Save raw source to `sources/<slug>.<ext>` (never edit after)
2. Read and synthesize
3. Update or create pages in `pages/` with frontmatter `source: <slug>`
4. Append to `index.md`
5. Append to `log.md`

### Query

1. Read `index.md` first
2. Cross-reference related pages
3. Synthesize answer — cite `[[page-slug]]` links
4. **On miss**: research externally (`WebFetch` / `WebSearch`), then auto-ingest — omitting `/hypo:ingest` after external research is a defect

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

---

## 8. Observability & citation convention

Hypomnema v1.1.0 ships an **autonomy score** so you can see whether the wiki is actually being used per session, rather than just trusting that it is.

- **Citation:** when a response uses a wiki page, link it inline as `[[page-slug]]`. The audit script counts citations as one signal of "the wiki was actually consulted".
- **Tools that count:** `Grep`, `WebSearch`, `WebFetch`, and any `/hypo:query` / `/hypo:ingest` / `/hypo:feedback` invocation in the transcript.
- **Classification (heuristic v0):**
  - `normal` — at least one search, no missed URL ingests
  - `search-0` — zero search/query in the session
  - `search-many` — five or more searches (sign of heavy retrieval; may indicate missing synthesis)
  - `ingest-missed` — URLs appeared in conversation but no `/hypo:ingest` ran
  - `staleness-skip` — session older than the audit window (default 30d)
- **Where it lives:**
  - Per-session transcript index: `<hypo-root>/.cache/sessions/index.jsonl` (written by the Stop hook `hypo-session-record.mjs`).
  - Fallback source: `~/.claude/projects/<encoded>/*.jsonl` (used when the index is empty — see ADR 0019 if present in your wiki).
  - Reports: `journal/weekly/<YYYY-Www>.md` (spec §6.4 SoT), generated by `node scripts/weekly-report.mjs --write`.
- **Definitions:** the 0% / 100% endpoints, the formal score sketch, and open questions live in `pages/observability/_index.md`.

Use `/hypo:audit` for a quick read of recent sessions; pass `--write` to commit the weekly report into the wiki.
