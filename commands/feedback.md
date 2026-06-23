---
description: Record an AI behavior correction or preference into the wiki. Use when the user corrects how you work or states a lasting preference to remember.
---

You are running `/hypo:feedback`. Capture a behavior correction or preference into `pages/feedback/` — the **single source of truth** for learned behaviors (ADR 0031).

## What this does

- Creates or updates `pages/feedback/<topic>.md` with a dated entry and full classification frontmatter
- Appends a reference to `log.md`
- **Automatically refreshes the projection** into `MEMORY.md` and the user's CLAUDE.md `<learned_behaviors>` via `feedback-sync --write`

> ⚠️ Do **not** hand-edit MEMORY.md or CLAUDE.md `<learned_behaviors>` for feedback. Those are one-way projections derived from the wiki page. Edit the wiki page; the projection follows.

---

## Step 1 — Gather feedback details

If the user did not provide them, ask. The classification fields are required so the page can project correctly:

1. **Topic** (slug): "What topic does this feedback apply to? (e.g. `response-length`, `commit-style`)"
2. **Rule** (entry): "State the rule or correction in one or two sentences."
3. **Reason**: "What incident or reasoning prompted this?"
4. **Scope**: "Does this apply globally (all projects) or to this project only?" → `global` | `project:<project-id>` (project-id must exact-match the resolved id; see Step 3 note)
5. **Tier**: "Is this a hard rule (L1) or a softer preference (L2)?" → `L1` | `L2`
6. **Targets**: "Where should this project?" → `project-memory` (MEMORY.md) and/or `claude-learned` (global CLAUDE.md). Default `project-memory`.
7. **Priority** (1–5, higher sorts first; default 3).
8. **Sensitivity**: `public` (default) or `sanitized` (redacted secrets/paths). `private` is not allowed — the wiki is git-pushed.
9. **Failure type** (optional): if this correction came from a real failure incident, classify it — `hallucination` | `false-completion` | `process-stall` | `over-caution` | `overreach` | `incompleteness` | `instruction-miss` | `convention-violation`. Omit it for a pure preference or a brand-new convention ("always do X"). When several fit, take the most specific (the list is in precedence order; see SCHEMA §3.1).

If **claude-learned** is among the targets, the page must be `scope: global` + `tier: L1`, and you must also collect:
- **Global summary**: a one-line summary for the CLAUDE.md learned-behaviors entry.
- Confirm **promote to global** (the page is only projected to CLAUDE.md when promoted).

---

## Step 2 — List existing feedback (optional)

To check for an existing topic, locate the Hypomnema package root and run:

```bash
node <package-root>/scripts/feedback.mjs --list [--hypo-dir="<path>"]
```

If a matching topic exists, appending adds a dated entry and bumps `updated:` (classification frontmatter is preserved).

---

## Step 3 — Write the feedback page

Run with `--dry-run` first to preview the generated page, then without it to write. Pass every collected field:

```bash
node <package-root>/scripts/feedback.mjs \
  --topic="<slug>" \
  --entry="<one-line rule>" \
  --scope="global|project:<project-id>" \
  --tier="L1|L2" \
  --targets="project-memory[,claude-learned]" \
  --priority=<1-5> \
  --sensitivity="public|sanitized" \
  --memory-summary="<one-line MEMORY.md summary>" \
  --reason="<why this rule exists>" \
  [--global-summary="<one-line CLAUDE.md summary>" --promote-to-global] \
  [--failure-type="<enum>"] \
  [--source="session:<date>"] \
  [--hypo-dir="<path>"] \
  [--dry-run]
```

When `--targets` includes `claude-learned`, `--global-summary` and `--promote-to-global` are required (and `--scope=global --tier=L1`).

`--failure-type` is optional (one of the eight values above). On **append** to an existing topic it is set only if the page has none; if the page already carries a different `failure_type` the command errors (a page holds a single failure_type — use a separate topic for a different one). Without the flag, an append leaves the frontmatter untouched as before.

> **`scope: project:<project-id>` 주의.** `<project-id>`는 `feedback-sync`가 resolve한 project-id와 정확히 일치해야 한다 (default: cwd의 `/`,`.` → `-` 치환; `--project-id=<id>` 로 override). 일치하지 않으면 그 페이지는 해당 project의 MEMORY로 projection되지 **않는다** (silent skip — lint error 아님). v1.3.0부터 scope regex(`^(global|project:[A-Za-z0-9_-]+)$`)가 cwd-derived id 형식(`-Users-...`)을 그대로 허용하므로 lint 통과를 위해 `--project-id=<slug>`를 override할 필요는 없다. 단 cwd에 공백 등 `[A-Za-z0-9_-]` 밖 문자가 있으면 그 id는 여전히 거부되니 그때만 `--project-id=<id>`로 override한다.

On a real (non-dry-run) write, the script automatically runs `feedback-sync --write` to refresh MEMORY.md / CLAUDE.md. If that post-step reports drift it prints a one-line warning — the page is still saved; reconcile with `hypomnema feedback-sync --check`.

---

## Step 4 — Confirm

After writing, tell the user:
- "Saved to `pages/feedback/<topic>.md` and refreshed the MEMORY/CLAUDE projection."
- If the projection post-step warned (over-cap, conflict, unresolved project-id), surface that and suggest `hypomnema feedback-sync --check`.
