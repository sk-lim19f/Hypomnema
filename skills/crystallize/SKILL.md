---
description: Close a session (steps 1~6) and, on request, consolidate scattered wiki knowledge into stable pages (steps 7~11)
---

You are running `/hypo:crystallize`. The command serves two modes (spec §5.2.7 / §8.3):

1. **Session close (steps 1~6)** — gate the 5 mandatory memory files plus open-questions (conditional) so `/compact` can pass.
2. **Synthesis (steps 7~11)** — surface tag clusters, orphan pages, and drafts that are ready to consolidate.

When invoked at the end of a session (or with phrases like "세션 종료", "wrap up"), run the session-close checklist first. The synthesis scan only runs after close is confirmed and the user agrees.

## What this does

- **Close mode**: walks the 6-step checklist (session-state, project hot.md, root hot.md, session-log, open-questions(변경 시), log.md) and verifies via `crystallize.mjs --check-session-close` — same gate the PreCompact hook runs.
- **Synthesis mode**: finds tag clusters (≥ N pages), orphan pages (no outbound `[[wikilinks]]`), and draft / stub pages, then guides consolidation into `pages/syntheses/<topic>.md` with back-links and `index.md` updates.

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory two levels above this file (`skills/<name>/SKILL.md` → package root)).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Run crystallize scan

```bash
node <package-root>/scripts/crystallize.mjs \
  [--wiki-dir="<path>"] \
  [--min-group=<n>] \
  [--json]
```

Options:
- `--min-group=<n>` — minimum pages per tag group to report (default: 2)
- `--json` — output results as JSON

Show the output verbatim.

---

## Step 3 — Session-close checklist (if triggered at session end)

If `/hypo:crystallize` was invoked as a session-close action, run through this checklist before synthesizing. Proceed automatically without confirmation unless the user has not said "auto".

1. **session-state.md** — update `projects/<name>/session-state.md` with the next tasks list (what to tackle first next time).
2. **hot.md (project)** — update `projects/<name>/hot.md` with a session snapshot: what changed and decisions made. Keep under 500 words. Do not put next-step tasks here; those belong in session-state.md.
3. **hot.md (root)** — update `<wiki-root>/hot.md` active-projects pointer table: set the `Last Session` date for this project to today.
4. **session-log** — append a session entry to `projects/<name>/session-log/YYYY-MM.md` (create the file if it does not exist for this month).
5. **open-questions** — only if `pages/open-questions.md` exists and questions were raised or resolved this session: move resolved ones out; add newly raised ones. Skip if unchanged.
6. **log.md** — append a `session` entry to `<wiki-root>/log.md`.

After completing the checklist, verify it before reporting:

```bash
node <package-root>/scripts/crystallize.mjs --check-session-close [--hypo-dir="<path>"]
```

This runs the same strict check as the PreCompact hard gate (fix #17). Fix any
file reported `missing` or `stale` and re-run until it passes — otherwise
`/compact` will be blocked.

Once it passes, report each item with ✓ and ask: "Session closed. Would you like to also run knowledge synthesis now, or stop here?"

---

## Step 4 — Pick a synthesis target

Present the top candidates from the script output:
- Tag clusters with the most pages
- Long-standing orphans
- Pages marked `status: draft`

Ask: "Which of these would you like to crystallize now? (or 'all' / 'skip')"

---

## Step 5 — Synthesize

For the chosen target:

1. Read all pages in the cluster.
2. Write a new synthesis page at `pages/syntheses/<slug>.md` with:

```yaml
---
title: <synthesis title>
type: synthesis
tags: [<shared tags>]
updated: <today YYYY-MM-DD>
evidence_strength: inferred
---
```

3. Cross-link all source pages back to the synthesis with `[[wikilink]]`.
4. Add the synthesis to `index.md` under `## Pages — Syntheses`.

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]`. The observability audit counts citations toward the autonomy score — see [[pages/observability/_index]] (run `/hypo:audit` to inspect).
