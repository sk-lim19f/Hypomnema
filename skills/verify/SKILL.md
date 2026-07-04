---
description: Surface wiki knowledge that is stale or past its verify-by date and prompt review. Use when the user asks what needs re-checking, wants to audit knowledge freshness, or is reviewing the wiki for rot.
---

You are running `/hypo:verify`. Check all wiki pages for `verify_by` and `verify_by_date` fields, surface overdue pages, and guide a review pass.

## What this does

- Scans all pages for `verify_by` (a question to re-check) and `verify_by_date` (deadline)
- Groups results: **overdue**, **due soon** (within 14 days), and **ok**
- After the script runs, you help the user review and update each overdue page

---

## Step 1 — Locate package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Run verify

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs \
  [--wiki-dir="<path>"] \
  [--file="<path>"] \
  [--json]
```

Options:
- `--file=<path>` — check a single file only
- `--json` — output results as JSON

Show the output verbatim.

---

## Step 3 — Interpret results

- **overdue** — `verify_by_date` is in the past; the page needs immediate review
- **due soon** — `verify_by_date` is within 14 days; worth reviewing this session
- **ok** — no verify fields, or deadline is far enough out

A page with `verify_by` but no `verify_by_date` is treated as **ok** (no deadline set — add `verify_by_date` to schedule a review).

---

## Step 4 — Review overdue pages

For each overdue page, in priority order:

1. Read the page content.
2. Show the `verify_by` question to the user.
3. Ask: "Is this still accurate? (yes / no / partially)"
4. Based on the answer:
   - **yes** — update `last_reviewed: <today>` and push `verify_by_date` forward by 90 days.
   - **no / partially** — help the user edit the page to correct the outdated content, then update `last_reviewed` and `verify_by_date`.
5. Offer to move to the next overdue page.

---

## Step 5 — Update frontmatter

After each review, apply the updated `last_reviewed` and `verify_by_date` fields to the page frontmatter. Do not change any other fields unless the user approves.

---

## Step 6 — Append stale items to open-questions.md

For each page reviewed as **no** or **partially** (content found stale or incorrect):

1. Open `<wiki-root>/pages/open-questions.md`. If absent, create it with this frontmatter:

```
---
title: Open Questions
type: open-questions
updated: <today YYYY-MM-DD>
---

# Open Questions
```

2. Append an entry:

```
- [ ] Re-verify [[<page-slug>|<page-title>]]: <verify_by question>  (surfaced: <today YYYY-MM-DD>)
```

3. Save the file. Do not remove or reorder existing entries.

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]` so it stays connected in the graph. The observability audit scores sessions on search / ingest / feedback activity (recorded by `hypo-session-record`), not on these inline citations; run `/hypo:audit` to inspect and see [[pages/observability/_index]].
