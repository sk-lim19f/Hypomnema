---
description: Record an AI behavior correction or preference into the wiki
---

You are running `/hypo:feedback`. Capture a behavior correction or preference into `pages/feedback/` — the **single source of truth** for learned behaviors (ADR 0031 / fix #37).

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
  [--source="session:<date>"] \
  [--hypo-dir="<path>"] \
  [--dry-run]
```

When `--targets` includes `claude-learned`, `--global-summary` and `--promote-to-global` are required (and `--scope=global --tier=L1`).

> **`scope: project:<project-id>` 주의 (v1.2.0).** `<project-id>`는 `feedback-sync`가 resolve한 project-id와 정확히 일치해야 한다 (default: cwd의 `/`,`.` → `-` 치환; `--project-id=<id>` 로 override). 일치하지 않으면 그 페이지는 해당 project의 MEMORY로 projection되지 **않는다** (silent skip — lint error 아님). 다만 현재 lint scope regex(`^project:[a-z0-9][a-z0-9-]*$`)는 cwd-derived id 형식(`-Users-...`)을 거부하므로, **`project:*` scope를 사용하려면 slug-safe id로 `--project-id=<slug>`를 override해서 wiki 디렉터리도 그 id에 맞추는 운영 패턴이 필요하다**. resolved-id ↔ slug 정합화는 v1.3.0 트랙에서 다룸.

On a real (non-dry-run) write, the script automatically runs `feedback-sync --write` to refresh MEMORY.md / CLAUDE.md. If that post-step reports drift it prints a one-line warning — the page is still saved; reconcile with `hypomnema feedback-sync --check`.

---

## Step 4 — Confirm

After writing, tell the user:
- "Saved to `pages/feedback/<topic>.md` and refreshed the MEMORY/CLAUDE projection."
- If the projection post-step warned (over-cap, conflict, unresolved project-id), surface that and suggest `hypomnema feedback-sync --check`.
