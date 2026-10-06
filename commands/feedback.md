---
description: Record an AI behavior correction or preference into the wiki. Use when the user corrects how you work or states a lasting preference to remember.
---

You are running `/hypo:feedback`. Capture a behavior correction or preference into `pages/feedback/` — the **single source of truth** for learned behaviors.

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

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install) or reinstall instead of guessing the cache layout.

To check for an existing topic, run:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs --list [--hypo-dir="<path>"]
```

If a matching topic exists, appending adds a dated entry and bumps `updated:` (classification frontmatter is preserved).

---

## Step 3 — Write the feedback page

Run with `--dry-run` first to preview the generated page, then without it to write. Pass every collected field:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs \
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

A projection block you edited by hand is a conflict, except when the edit already matches what the wiki would write: the next `--write` takes it over. To keep the wiki version of a conflicted block, run `hypomnema feedback-sync --import-target-change --from=<target>` first to save a copy of the edit as a draft, then `hypomnema feedback-sync --accept-wiki=<slug>`.

`--bootstrap` and `--import-target-change` write their drafts to `.cache/feedback-drafts/` in the wiki, not under `pages/feedback/`. A draft is a copy of your own hand-written lines or edited block, so it goes where the wiki's git does not look: nothing is written unless git ignores that path (the default `.gitignore` does), and otherwise the command exits 1 and says why. A draft has no `sensitivity` yet (`TODO`): set `public` or `sanitized` when you move it into `pages/feedback/`. The cost is that drafts are not synced to your other machines and are gone when `.cache/` is cleared. Drafts that an earlier version left in `pages/feedback/_drafts/` still count: `--bootstrap` does not draft the same slug again, and `--write` keeps the hand line record while one is there. Nothing moves or deletes them. A draft is created only if its name is free, and it appears under that name only once complete, so a second run or a crash never replaces or cuts one in half.

Before `--accept-wiki` replaces a file, before `--write` replaces `MEMORY.md` or `CLAUDE.md`, and before `--write` removes a hand line that `--bootstrap` drafted from, the old bytes are copied to `.cache/feedback-kept/` in the wiki. The copy holds your own text, so it is only written when the wiki's git ignores `.cache/` (the default `.gitignore` does); otherwise the command stops with exit 1 and writes nothing, and the same goes for the bootstrap line record. The one exception is the routine before-write copy of `MEMORY.md` or `CLAUDE.md`: in such a vault `--write` skips that copy, warns, and goes ahead. The same copy is made before `--write` rewrites or removes a generated `feedback_<slug>.md` that has no recorded hash (an older install, or a lost record); if that copy cannot be kept, that one file is left as it is and `--write` warns. Only the newest 10 copies of each kind are kept, and the older ones are deleted only after a run that ended with exit 0 or 3. The warnings a `--write` raises (a skipped copy, a side file it left alone, a record it could not save) are also in the `warnings` list of its `--json` report. `--ensure-container` copies `CLAUDE.md` to `.cache/feedback-kept/` before it appends the container (with the same exception for a wiki whose git does not ignore `.cache/`: it warns and goes ahead) and reads the file again right before the replace. `--accept-wiki` reads each target again right before it copies and replaces it and stops with exit 1, writing nothing to that target, when it changed since the plan was made. `--accept-wiki` exits 3 when it accepted some target but another one that holds the block still needs a hand repair. That includes two blocks that lost an END and a START marker and now read as one: accept refuses to replace them.

A managed-block marker counts only when it starts its own line outside a code fence. An example of the markers inside a fenced block, inside inline code, or after other text on the same line is left alone. A fence that is never closed does not count as a fence, so marker lines below a stray ``` are still read as a real block; an example placed inside such an unclosed fence is rewritten like one, and the file's earlier bytes are in `.cache/feedback-kept/` when that copy could be kept.

A `feedback_<slug>.md` copy that you edited after `--write` generated it is neither rewritten nor removed. The run exits 3 and names the file: move your edits out and delete it, then `--write` generates it again. The hash of each generated copy is kept in `.cache/feedback-side-files.json`; a copy with no recorded hash is refreshed once and recorded. Every writing mode takes a lock on the wiki, and `--write` reads each file again right before replacing it, so a file that changed after the check is not overwritten (exit 1, run it again).

---

## Step 4 — Confirm

After writing, tell the user:
- "Saved to `pages/feedback/<topic>.md` and refreshed the MEMORY/CLAUDE projection."
- If the projection post-step warned (over-cap, conflict, unresolved project-id), surface that and suggest `hypomnema feedback-sync --check`.
