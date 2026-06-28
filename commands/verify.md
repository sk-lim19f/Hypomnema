---
description: Check verify_by fields and surface overdue or missing verifications. Use when the user asks what wiki knowledge needs re-checking or wants to audit freshness.
---

You are running `/hypo:verify`. Audit wiki pages for overdue or missing `verify_by` fields.

## What this does

- Scans `pages/` and `projects/` for pages of types `adr`, `page`, `learning`, `concept`, `playbook`, `tool-eval`
- Reports overdue pages (past `verify_by_date`), upcoming (within 14 days), and pages missing a `verify_by` question

---

## Step 1 — Run

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/verify.mjs [--hypo-dir="<path>"] [--file=<path>]
```

Options:
- `--file=<path>` — check a single page only (useful after editing a page)

---

## Step 2 — Report results

Show the script output verbatim:
- `✗ Overdue` — page is past its `verify_by_date`; requires immediate review
- `⚠ Due soon` — within 14 days
- `⚠ Missing verify_by` — tracked page has no verification question set
- `✓` — all pages up to date

---

## Step 3 — Offer to review overdue pages

For each overdue page, ask:

> "[[<slug>]] is overdue for verification. The question was: '<verify_by>'. Is this still accurate?"

If the user confirms it is still accurate:
- Update `verify_by_date` to a new future date (suggest 90 days from today)

If the user says it is outdated:
- Help update the page content
- Reset `verify_by_date` and optionally revise `verify_by`

---

## Step 4 — Add missing verify_by fields

For pages missing `verify_by`, suggest a verification question based on the page type:
- `concept` / `learning`: "Is this still the recommended approach?"
- `playbook`: "Has this procedure been tested recently?"
- `tool-eval`: "Is this evaluation still current? Check for a newer version."
- `adr`: "Is this decision still in effect, or has it been superseded?"

Ask the user to confirm the question, then add it to the frontmatter.
