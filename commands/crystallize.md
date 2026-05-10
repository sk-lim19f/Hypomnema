---
description: Crystallize draft notes into stable knowledge — also the session-close alias
---

You are running `/hypo:crystallize`. This command serves two purposes:

1. **Session close** — if invoked at the end of a session, run the session-close checklist first
2. **Knowledge synthesis** — consolidate draft or scattered wiki pages into stable, well-linked pages

---

## Step 1 — Detect context

If the user invoked `/hypo:crystallize` to close a session (phrases like "세션 종료", "오늘 작업 마무리", "session close", or "wrap up"), run Steps 2–3 (session-close checklist) **before** the synthesis scan. Otherwise skip to Step 4.

---

## Step 2 — Session-close checklist

Work through each item in order. For an explicit session-close invocation, proceed automatically without asking for confirmation on each item.

1. **session-state.md** — update `projects/<name>/session-state.md` with the next tasks list for the upcoming session (what to tackle first next time).
2. **hot.md (project)** — update `projects/<name>/hot.md` with a session snapshot: what changed and decisions made. Keep under 500 words. Do not put next-step tasks here; those belong in session-state.md.
3. **hot.md (root)** — update `<wiki-root>/hot.md` active-projects pointer table: set the `Last Session` date for this project to today.
4. **session-log** — append a session entry to `projects/<name>/session-log/YYYY-MM.md` (create the file if it does not exist for this month).
5. **open-questions** — only if `pages/open-questions.md` exists and questions were raised or resolved this session: move resolved ones out; add newly raised ones. Skip if unchanged.
6. **log.md** — append a `session` entry to `<wiki-root>/log.md`.

---

## Step 3 — Session-close confirmation

After completing the checklist, report:

- ✓ session-state.md updated
- ✓ hot.md (project + root) updated
- ✓ session-log entry appended
- ✓ open-questions updated (or skipped if unchanged)
- ✓ log.md updated

Then ask: "Session closed. Would you like to also run knowledge synthesis now, or stop here?"

If the user says stop, end here. Otherwise continue to Step 4.

---

## Step 4 — Surface synthesis candidates

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

```bash
node <package-root>/scripts/crystallize.mjs [--hypo-dir="<path>"] [--min-group=2]
```

Show the output to the user. If no candidates are found, tell them Hypomnema looks well-connected and no crystallization is needed.

---

## Step 5 — Choose what to crystallize

If candidates exist, ask:

> "Which would you like to crystallize?
> 1. A tag cluster (synthesize related pages into one synthesis page)
> 2. A draft page (upgrade to stable)
> 3. Unlinked pages (add cross-links)"

---

## Step 5a — Tag cluster synthesis

For a tag cluster:

1. Read all pages in the cluster
2. Create `pages/syntheses/<topic>.md` with `type: synthesis`
3. Frontmatter:
   ```yaml
   ---
   title: "<synthesis title>"
   type: synthesis
   updated: YYYY-MM-DD
   tags: [<shared tags>]
   confidence: high
   ---
   ```
4. Body: synthesize key insights across the cluster, cite each source page with `[[slug]]`
5. Add back-links: add `[[syntheses/<topic>]]` to each constituent page's "See also" section
6. Update `index.md`

---

## Step 5b — Draft upgrade

For a draft page:

1. Read the draft
2. Fill in any missing sections, improve clarity, add cross-links
3. Change `tags: [draft]` → remove `draft` tag, set `confidence: high`
4. Update `updated:` to today

---

## Step 5c — Cross-link unlinked pages

For unlinked pages:

1. Read each unlinked page
2. Search the wiki for related pages (run `/hypo:query` mentally on the page title/tags)
3. Add a `## See also` section with `[[slug]]` links to 2–3 related pages
4. Reciprocally add links back where natural

---

## Step 6 — Report

Show what was created or modified, and offer to run `/hypo:lint` to verify all new links resolve.
