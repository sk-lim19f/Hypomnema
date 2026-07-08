---
title: Wiki Schema
type: schema
updated: YYYY-MM-DD
version: 2.1
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
| `session-log` | `projects/*/session-log/YYYY-MM-DD.md` | Chronological session narrative (daily shard) | append-only |
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
| `projects/<name>/session-log/YYYY-MM-DD.md` | Append-only narrative timeline (daily shard; legacy `YYYY-MM.md` still read) | No edits to existing entries. |
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
visibility_scope: shared | machine:<device>
source: <slug or URL>
verify_by: <question to re-check at next review>
verify_by_date: YYYY-MM-DD
```

`visibility_scope` is a different axis from `scope`: `scope` is memory lifetime,
`visibility_scope` is where a page may surface. Omitting it means `shared` (the
implicit default of every pre-existing page), so lookup/query/injection stay
unchanged. `machine:<device>` hides the page from every machine except the one
whose `currentDevice()` output equals `<device>`. Copy that exact string from the
newest `device` value in `.cache/sessions/index.jsonl`, or from a recent
session-log shard's `device:` frontmatter (both are `currentDevice()` outputs); a
hand-typed value that does not match will hide the page on its own machine too.
An empty owner (`machine:`) hides the page everywhere. `agent:<id>` is a reserved
forward-compat value that is not filtered yet.

### 3.1. `feedback` type — projection fields

Feedback pages are the single source of truth for behavior corrections;
`hypomnema feedback-sync` projects them one-way into Claude Code's `MEMORY.md`
and `~/.claude/CLAUDE.md` `<learned_behaviors>`. They require:

```yaml
status: active | superseded | archived
scope: global | project:<project-id>     # global → eligible for CLAUDE.md projection;
                                         # <project-id> must exact-match the resolved
                                         # project-id (default: cwd → `/`,`.` replaced
                                         # with `-`; or pass `--project-id=<id>`).
                                         # Mismatched scope = page is NOT projected
                                         # into that project's MEMORY.md.
tier: L1 | L2                            # L1 required for CLAUDE.md <learned_behaviors>
targets: [project-memory, claude-learned] # which projection surfaces to derive
sensitivity: public | sanitized          # `private` forbidden (wiki is git-pushed)
priority: 1-5                            # over-cap sort key (higher first)
memory_summary: <one line for the MEMORY.md index>
reason: <why this rule is needed>
source: session:YYYY-MM-DD | commit:<hash> | pr:<n> | https://...

# optional (2.1) — failure taxonomy for incident-driven corrections:
failure_type: <enum>                     # one of the 8 values below; OMIT for pure
                                         # preferences / new conventions ("always do X")

# conditional — required when `targets` includes `claude-learned`:
global_summary: <one line for the <learned_behaviors> entry>
promote_to_global: true                  # explicit opt-in to global projection
```

`failure_type` (optional, added 2.1) classifies feedback that came from a real
failure incident so recurring mistake types become machine-aggregatable
(surfaced by `hypomnema stats`). Leave it off when the page records a preference
rather than a failure. The eight values, in classification-precedence order
(most specific first — a failure matching several takes the earliest):

| value | when |
|-------|------|
| `hallucination` | fabricated a fact / API / path |
| `false-completion` | declared "done" without running the required gate or test |
| `process-stall` | stopped instead of asking / continuing when it should have |
| `over-caution` | re-asked or re-gated despite standing authority |
| `overreach` | acted beyond the requested scope |
| `incompleteness` | started correctly but omitted a required step or scope |
| `instruction-miss` | ignored an explicit this-session instruction |
| `convention-violation` | broke a standing documented convention (not restated) |

`lint` rejects any value outside this set; an omitted `failure_type` is always
allowed.

Edit the feedback page only — never hand-edit the generated
`<!-- HYPO:FEEDBACK-SYNC:START … -->` managed blocks (sync detects tampering as a conflict).

---

## 4. Tag Vocabulary

Use lowercase, hyphenated tags. `lint` hard-blocks forbidden patterns (PascalCase,
plurals, whitespace, generic words); an unknown but well-formed tag is a warning,
and a session close auto-registers it into the `### Pending` section below so the
next lint accepts it. Promote a pending tag into a category here (and in
`~/hypomnema/SCHEMA.md`) once it has settled.

**Meta**: `wiki`, `index`, `pages`, `home`, `overview`, `guide`, `operations`, `schema`, `reference`, `hypo`, `commands`, `hot-cache`, `migration`
**Workflow**: `automation`, `hooks`, `observability`, `autonomy`, `wiki-health`, `weekly`
**Project**: `project`, `prd`, `adr`, `session-state`
**Domain**: `ai`, `dev`, `ops`, `security`, `data`, `design`, `management`
**Status**: `active`, `completed`, `archived`, `draft`, `stable`, `deprecated`, `needs-review`, `proposed`, `superseded`
**Content classification**: `learning`, `tip`, `feedback`, `gotcha`, `concept`, `pattern`

### Pending (auto-registered)

Tags auto-registered by a crystallize close because they were not yet in the
vocabulary above. Review periodically: promote each into a category and delete it
here, or drop the tag from the page.

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
