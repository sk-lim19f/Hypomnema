---
description: Surface synthesis candidates and consolidate scattered wiki knowledge into stable pages
---

You are running `/hypo:crystallize`. Find pages that are ready to be consolidated into stable, cross-linked knowledge — then guide the synthesis.

## What this does

- Finds tag groups with ≥ N pages sharing the same tag (synthesis candidates)
- Lists orphan pages (no inbound `[[wikilinks]]`)
- Lists draft / stub pages that could be fleshed out
- After the script runs, you help the user pick what to crystallize and do it

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `skills/`).

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/wiki`.

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

If `/hypo:crystallize` was invoked as a session-close action, run through this checklist before synthesizing:

1. **hot.md** — update `projects/<name>/hot.md` with a snapshot of this session (what changed, decisions made, next steps). Keep under 500 words.
2. **session-log** — append a session entry to `projects/<name>/session-log/` (or `session-log.md`).
3. **open-questions** — move any resolved questions out of `pages/open-questions.md`; add new ones.
4. **log.md** — append a `session` entry to `<wiki-root>/log.md`.

Ask the user to confirm each section before writing, or proceed automatically if they said "auto".

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
