---
title: Wiki Schema
type: schema
updated: YYYY-MM-DD
version: 1.0
---

# Wiki Schema

The type system and vocabulary standard for this wiki.
Read this before any wiki operation (ingest / query / lint).

---

## 1. Page Type Taxonomy

| type | location | description | mutability |
|------|----------|-------------|------------|
| `concept` | `pages/` | Principles, theories, design ideas | mutable |
| `source-summary` | `pages/` | Summary of a `sources/` raw document | semi-immutable |
| `entity` | `pages/people/`, `pages/orgs/` | People, organizations | mutable |
| `tool-eval` | `pages/tool-evaluations/` | Tool evaluations (adopt / reject) | mutable |
| `prompt-pattern` | `pages/prompt-patterns/` | Verified prompt patterns | mutable |
| `playbook` | `pages/playbooks/` | Repeatable how-to procedures | mutable |
| `learning` | `pages/learnings/` | Discoveries, gotchas, lessons learned | append-only |
| `tip` | `pages/tips/` | Practical environment/tool tips | mutable |
| `feedback` | `pages/feedback/` | AI behavior correction records | append-only |
| `reference` | `pages/` | Config snapshots, external system references | mutable |
| `synthesis` | `pages/syntheses/` | Cross-page synthesis (3+ pages analyzed) | mutable |
| `weekly-journal` | `journal/weekly/YYYY-Www.md` | Weekly session/ingest summary | append-only |
| `prd` | `projects/*/prd.md` | Project purpose, success criteria, constraints | mutable |
| `adr` | `projects/*/decisions/NNNN-*.md` | Architecture decision records | immutable |
| `session-log` | `projects/*/session-log/YYYY-MM.md` | Chronological session narrative (monthly) | append-only |
| `session-state` | `projects/*/session-state.md` | Next-session handoff — overwritten each close | overwrite |
| `project-index` | `projects/*/index.md` | Project overview + progress checklist | mutable |
| `open-questions` | `pages/open-questions.md` | Unresolved question queue | append+resolve |
| `schema` | `SCHEMA.md` (this file) | Type system + vocabulary standard | versioned |
| `log` | `log.md` | Append-only activity log (ingest, session, note entries) | append-only |
| `config` | `hypo-config.md` | Wiki root marker + user settings | mutable |

**Notes**:
- `append-only`: never delete/modify existing entries. Corrections go as new entries (`[supersedes: YYYY-MM-DD]`).
- `immutable`: deprecated/superseded markers allowed, content edits forbidden.
- `semi-immutable`: factual corrections OK; interpretation/synthesis goes in `pages/` as a new page.

---

## 2. Memory Layer Files

Files responsible for session continuity — separate from the type taxonomy above.

| file | role | constraint |
|------|------|-----------|
| `hot.md` (root) | Active project pointer table + last session date | Pointers only. No session content. |
| `projects/<name>/hot.md` | Last session snapshot — "what was done" | 500-word cap. No next-tasks. Overwrite each close. |
| `projects/<name>/session-state.md` | Next-session handoff — "what to do next" | Overwrite each close. Read at session start. |
| `projects/<name>/session-log/YYYY-MM.md` | Append-only narrative timeline (monthly) | No edits to existing entries. |
| `pages/open-questions.md` | Cross-project unresolved question queue | Append + mark resolved. |

**Operations**:
- Session start: root `hot.md` → project `hot.md` → `session-state.md`
- Session close: update project `hot.md` (what was done) + `session-state.md` (what to do next) + root `hot.md`

**Pointer table row format** (`hypo-hot-rebuild.mjs` parses this with a fixed regex — wrong col3 format causes the row to be silently skipped):

```
| <Project Name> | YYYY-MM-DD | [[projects/<slug>/hot]] |
```

Column semantics:
- col 1 (name): preserved as-is from the existing row
- col 2 (date): **ignored on read** — rebuilt from `projects/<slug>/hot.md` frontmatter `updated:` (falls back to today if the file is absent)
- col 3 (wikilink): must be `[[projects/<slug>/hot]]` — no trailing path, no markdown link `[text](url)`. Extra trailing columns are discarded during canonical rebuild (not dropped).

---

## 3. Required Frontmatter Fields

```yaml
---
title: <human-readable title>
type: <type from taxonomy above>
updated: YYYY-MM-DD
tags: [tag1, tag2]
---
```

Optional fields (add as needed):

```yaml
confidence: high | medium | low | speculative
evidence_strength: direct | inferred | hearsay
scope: always | project | session
source: <slug or URL>
verify_by: <question to re-check at next review>
verify_by_date: YYYY-MM-DD
```

---

## 4. Tag Vocabulary

Use lowercase, hyphenated tags. Vocabulary is locked — `lint` blocks unknown tags
and forbidden patterns (PascalCase, plurals, whitespace, generic words).
Extend this list (and `~/hypomnema/SCHEMA.md`) before introducing a new tag.

**Meta**: `wiki`, `index`, `pages`, `home`, `overview`, `guide`, `operations`, `schema`, `reference`, `hypo`, `commands`, `hot-cache`
**Workflow**: `automation`, `hooks`, `observability`, `autonomy`, `wiki-health`
**Project**: `project`, `prd`, `adr`, `session-state`
**Domain**: `ai`, `dev`, `ops`, `security`, `data`, `design`, `management`
**Status**: `active`, `completed`, `archived`, `draft`, `stable`, `deprecated`, `needs-review`, `proposed`, `superseded`
**Content classification**: `learning`, `tip`, `feedback`, `gotcha`, `concept`, `pattern`

### Forbidden patterns

| Pattern | Reason | Use instead |
|---------|--------|-------------|
| PascalCase (`Jenkins`, `Claude`) | Inconsistent casing | `jenkins`, `claude-code` |
| Plurals (`learnings`, `tips`) | Singular form is canonical | `learning`, `tip` |
| Generic (`general`, `misc`, `other`, `todo`) | No search value | Specific domain tag |
| Whitespace (`llm wiki`) | Parse breakage | `llm-wiki` |

---

## 5. Source-First Principle

Wiki compound value comes from **external source ingestion**, not self-reference.

- At least 1 new external source per week in `sources/`
- `source: session:*` only chains → drift risk (see `pages/learnings/`)
- Every `source-summary` must reference a file in `sources/`
