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
4. **Your first response must lead with the resume**: a one-line summary of last session + the concrete next task(s) from `session-state.md`, then "Continuing [X] — shall we pick up?". Do not wait for the user to ask; this is mandatory whenever a project matched (not a soft offer).

### Session Close

Trigger: explicit close mention, `/compact` request, or context limit approaching.

**Auto-trigger rule**: when the user sends a natural-language close signal — "세션 마무리하자", "오늘 여기까지", "이만 종료", "wrap up", "signing off", or equivalent — run the session close checklist immediately without waiting for an explicit `/compact` or `/hypo:crystallize`. If the intent is ambiguous, confirm with a single question before proceeding.

**Proactive close offer** (Layer 1): even when the user gives no close signal, offer to wrap up once a task is truly done — don't make them remember to. Fire `AskUserQuestion` **at the end of the assistant turn in which you report a task complete or verified**, when both hold:

1. The session did substantial work — file mutations or multi-step changes, not Q&A only.
2. The current user request did not already include a next task or tell you not to close.

Do **not** treat these as completion: plan approvals, clarification answers, permission grants, progress updates, partial findings, or mid-task checkpoints. A "좋아요" / "감사합니다" / "ok" following any of those is *not* a close signal — only offer after a genuine final completion/verification report.

**Proactive offer means offer, not close.** In this path (task done, no close signal) do not run the close checklist, write the `session-closed` marker, or declare the session ended on your own. Fire `AskUserQuestion` and proceed only after the user picks [세션 마무리]. Task completion is not a close trigger; closing without asking violates this procedure. This scopes the proactive path only: a real close signal, `/compact`, or context limit still closes via the triggers above.

Ask: *"이 작업이 마무리되었나요? 세션을 정리(crystallize)할까요?"* with options **[세션 마무리 / 계속 작업]**. On **세션 마무리** → run the session close checklist (or invoke `/hypo:crystallize`). On **계속 작업** → continue and do not re-ask until the next task completes. Ask at most once per completed task; never loop. (Decline simply ends the turn — Layer 3's Stop-chain only blocks on an explicit close signal, so no repeated prompts occur.)

1. Update `projects/<name>/session-state.md` (next tasks, overwrite)
2. Update `projects/<name>/hot.md` (what was done, ≤500 words, overwrite)
3. Append to `projects/<name>/session-log/YYYY-MM-DD.md` (daily shard, narrative entry, append-only)
4. Update root `hot.md` pointer table + date
5. Run `/hypo:lint` and fix errors in files **you** touched — debt in other
   projects / shared pages you did not author is reported as a non-blocking
   notice, not a gate. (The documented `/hypo:crystallize` session-close path
   runs this lint automatically, scoped to the files it writes.)
6. Verify with `/hypo:crystallize` in its `--check-session-close` mode: a dry-run of the
   **full** PreCompact gate (close files + lint + design-history + feedback
   projection), sharing one function with the gate. Only declare the
   session closed once it prints **"Compact-ready"**. A "close files updated"
   check alone is not enough — the real `/compact` gate also blocks on a lint
   error in a close file or a feedback projection over-cap. (Not a hard
   guarantee: the live gate can still differ on a context-≥70% prompt,
   `HYPO_SKIP_GATE`, or a transcript-scoped lint error — pass `--transcript-path`
   to include the last.) Pass `--session-id=<id>` to also see `marker_present`
   (step 7). `--project=<slug>` narrows the check to one project (a scoped
   diagnostic, JSON `scope: "project"`): green there means only that slug is
   close-complete, **not** that `/compact` is globally unblocked. Use the plain
   check for the go/no-go signal.
7. Record the session-closed marker. The Stop hook blocks until this
   session's per-session marker exists, and a hand-edit close (writing the files
   directly + committing) never writes it; the marker is written only by the
   crystallize writer, never by the hook (bypass guard). Normal path:
   close via `/hypo:crystallize` (`--apply-session-close --session-id=<id> --transcript-path=<path>`),
   which writes the marker once the gate is green. Hand-edit recovery: after
   committing the files, run `/hypo:crystallize` (`--mark-session-closed --session-id=<id> --transcript-path=<path>`).
   Both writers gate the marker on the SAME `precompactGateStatus` as `/compact`,
   so the marker only lands when step 6 would print **"Compact-ready"**.

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

#### Auto-project offer

When SessionStart / CwdChanged injects a line like
`[WIKI: cwd '<name>'에 매칭되는 프로젝트가 없습니다. 자동 생성할까요? (Y/n)]`,
the current working directory is a real project (git repo + a project marker
like `package.json`) that has no matching wiki project. **Act on it — do not
ignore it:**

1. Ask the user with `AskUserQuestion` (or a plain Y/n question) whether to
   create the project.
2. **On Yes** — run the scaffold helper once (it substitutes tokens, creates
   the project files, adds the root `hot.md` row, and logs the entry):
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/lib/project-create.mjs --name <slug> --working-dir "$(pwd)"
   ```
   To resolve that package root from this guide: if `${CLAUDE_PLUGIN_ROOT}` is
   already an absolute path, use it; otherwise read `pkgRoot` from
   `~/.claude/hypo-pkg.json` (only when non-empty and the script exists under it);
   otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath
   in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the
   user to run `hypomnema upgrade --apply` or reinstall instead of guessing.
   Then tell the user: "Created project `<name>` at
   `~/hypomnema/projects/<name>/`. Edit `index.md` to refine." Do **not** hand-write
   the five files — the helper keeps substitution and registration consistent.
3. **On No** — record the refusal so this cwd is never offered again: append an
   entry to `~/hypomnema/.cache/project-suggestions.json` under `skips`:
   ```json
   { "skips": [ { "cwd": "<absolute cwd>", "declined_at": "<ISO date>", "reason": "user_decline" } ] }
   ```
   (preserve any existing `skips` / `cooldowns` keys). The hook reads this and
   stays silent for that cwd permanently.

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

- **Citation:** when a response uses a wiki page, link it inline as `[[page-slug]]` to keep it connected in the graph. (The audit score is based on the tool and command usage below, not on these inline citations.)
- **Tools that count:** `Grep`, `WebSearch`, `WebFetch`, and any `/hypo:query` / `/hypo:ingest` / `/hypo:feedback` invocation in the transcript.
- **Classification (heuristic v0):**
  - `normal` — at least one search, no missed URL ingests
  - `search-0` — zero search/query in the session
  - `search-many` — five or more searches (sign of heavy retrieval; may indicate missing synthesis)
  - `ingest-missed` — URLs appeared in conversation but no `/hypo:ingest` ran
  - `staleness-skip` — session older than the audit window (default 30d)
- **Where it lives:**
  - Per-session transcript index: `<hypo-root>/.cache/sessions/index.jsonl` (written by the Stop hook `hypo-session-record.mjs`).
  - Fallback source: `~/.claude/projects/<encoded>/*.jsonl` (used when the index is empty).
  - Reports: `journal/weekly/<YYYY-Www>.md` (spec §6.4 SoT), generated by the `/hypo:audit` weekly report flow.
- **Definitions:** the 0% / 100% endpoints, the formal score sketch, and open questions live in `pages/observability/_index.md`.

Use `/hypo:audit` for a quick read of recent sessions; pass `--write` to commit the weekly report into the wiki.
