---
description: Audit recent sessions for observability gaps and optionally write the weekly report. Use when the user asks to review session quality, find tracking gaps, or generate the weekly summary.
---

You are running `/hypo:audit`. Inspect recent Claude Code sessions to see how much of the wiki's value motion is actually happening (search, ingest, citation, feedback), then either show the result inline or write a weekly observability page.

## What this shows

- Per-session metrics — search count, ingest count, URL mentions, feedback count
- Classification — `normal` / `search-0` / `search-many` / `ingest-missed` / `staleness-skip`
- Optional weekly aggregation with an autonomy score (heuristic v0)

Definition: [[pages/observability/_index]].

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Decide the mode

- **Per-session view (default)** — show recent sessions with metrics + classification:
  ```bash
  node <package-root>/scripts/session-audit.mjs [--hypo-dir="<path>"] [--limit=20]
  ```
- **Weekly report (when the user asks for "weekly", "score", or names a week)** — write the report to `journal/weekly/<YYYY-Www>.md` (spec §6.4 SoT):
  ```bash
  node <package-root>/scripts/weekly-report.mjs [--hypo-dir="<path>"] [--week=YYYY-Www] --write
  ```
- **JSON for tooling** — append `--json` to either script.

---

## Step 3 — Report results

Show the output verbatim. Then add a brief interpretation:

- If `staleness-skip` dominates: "Most sessions audited are older than 30 days — score reflects backlog, not current behavior."
- If `search-0` count is high: "Sessions ran without consulting the wiki — consider whether `/hypo:query` was the right reflex."
- If `ingest-missed` is non-zero: "Sessions discussed URLs but no `/hypo:ingest` ran — those captures got lost."
- Otherwise: "Audit window looks healthy; weekly report committed to the wiki for trend tracking."
