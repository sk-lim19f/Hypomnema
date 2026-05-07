---
description: Record an AI behavior correction or preference into the wiki
---

You are running `/hypo:feedback`. Capture a behavior correction or preference into `pages/feedback/` for future sessions.

## What this does

- Creates or updates `pages/feedback/<topic>.md` with a dated entry
- Appends a reference to `log.md`
- Ensures the feedback is findable in future sessions

---

## Step 1 — Gather feedback details

If the user did not provide them, ask:

1. **Topic** (slug): "What topic does this feedback apply to? (e.g. `response-length`, `commit-style`, `code-comments`)"
2. **Rule**: "State the rule or correction in one or two sentences."
3. **Why** (optional): "What was the reason or incident that prompted this?"

---

## Step 2 — List existing feedback (optional)

To check for an existing topic, locate the Hypomnema package root and run:

```bash
node <package-root>/scripts/feedback.mjs --list [--wiki-dir="<path>"]
```

If a matching topic exists, confirm with the user whether to append to it or create a new one.

---

## Step 3 — Write the feedback entry

Compose the entry text. Format:

```
**Rule**: <one-line rule>

**Why**: <reason or incident>

**How to apply**: <when this kicks in>
```

Then run:

```bash
node <package-root>/scripts/feedback.mjs \
  --topic="<slug>" \
  --entry="<formatted entry text>" \
  [--wiki-dir="<path>"] \
  [--dry-run]
```

Run with `--dry-run` first to preview, then without it to write.

---

## Step 4 — Confirm and cross-reference

After writing:
- Tell the user: "Saved to `pages/feedback/<topic>.md`."
- If this feedback should also update the project's `session-state.md` or the user's CLAUDE.md `<learned_behaviors>`, ask: "Should I also add this to your CLAUDE.md learned behaviors?"
