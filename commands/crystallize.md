---
description: Crystallize draft notes into stable knowledge — also the session-close alias
---

You are running `/hypo:crystallize`. This command serves two purposes:

1. **Session close** — if invoked at the end of a session, run the session-close mechanical-apply path
2. **Knowledge synthesis** — consolidate draft or scattered wiki pages into stable, well-linked pages

---

## Step 1 — Detect context

If the user invoked `/hypo:crystallize` to close a session (phrases like "세션 종료", "오늘 작업 마무리", "session close", or "wrap up"), run Steps 2–4 (session-close mechanical apply + recovery) **before** the synthesis scan. Otherwise skip to Step 5.

---

## Step 2 — Compose the session-close payload

The session-close path is **payload-driven** (fix #38). Instead of writing the 5 mandatory files one-by-one, you compose a single JSON payload that describes the full session-close state, then hand it to `crystallize.mjs --apply-session-close`, which performs idempotent atomic writes and gates the result with lint.

Payload shape (5 required + 1 conditional, per Spec §5.2.7 / §8.3 + ADR 0029):

```json
{
  "project": "<project-name>",
  "date": "YYYY-MM-DD",
  "sessionState": { "content": "<full body of projects/<name>/session-state.md>" },
  "projectHot": { "content": "<full body of projects/<name>/hot.md>" },
  "rootHot": { "content": "<full body of <hypo-root>/hot.md>" },
  "sessionLog": { "entry": "<entry to append to projects/<name>/session-log/YYYY-MM.md>" },
  "log": { "entry": "<entry to append to <hypo-root>/log.md>" },
  "openQuestions": { "content": "<full body of pages/open-questions.md>" }
}
```

> **Important:** the JSON above is a literal template — do not add `//` or `#` comments when materializing it. `readPayload()` runs `JSON.parse`, which rejects comments and would fail the apply before any write.

Field rules:

- `project` — optional. Falls back to the active project from root `hot.md` pointer table.
- `date` — optional. Defaults to today (local). Must be `YYYY-MM-DD` if supplied.
- `openQuestions` — optional. Include only when `pages/open-questions.md` exists and changed this session.
- All other top-level fields are required.

Notes:

- `sessionState` / `projectHot` / `rootHot` / `openQuestions` are **overwrite** (full-file content). `sessionLog` / `log` are **append** (entry-level idempotency — exact-entry dedup, safe to re-run).
- Frontmatter `updated:` is NOT auto-fixed. If your payload's `updated:` is stale, the post-apply verification gate will fail with `stage='post-apply-verification'` and you must fix the payload and retry.
- Write the payload to a temp path, e.g. `/tmp/hypo-session-close-<YYYY-MM-DD>.json`.

Content guidance for each slot:

1. **sessionState** — next tasks list for the upcoming session (what to tackle first next time).
2. **projectHot** — session snapshot under 500 words: what changed and decisions made. Do **not** put next-step tasks here; those belong in `sessionState`.
3. **rootHot** — active-projects pointer table with this project's `Last Session` date set to today.
4. **sessionLog** — one session entry to append to `projects/<name>/session-log/YYYY-MM.md`.
5. **log** — one `session` entry to append to `<hypo-root>/log.md`.
6. **openQuestions** (conditional) — only if `pages/open-questions.md` exists and questions were raised or resolved this session.

---

## Step 3 — Apply the payload

```bash
node <package-root>/scripts/crystallize.mjs \
  --apply-session-close \
  --payload=/tmp/hypo-session-close-<YYYY-MM-DD>.json \
  --session-id=<current-session-id> \
  --hypo-dir="<path>" \
  --json
```

**`--session-id` (fix #27 PR-C):** pass the current session's id whenever you
know it — most importantly when this close was triggered by a `[WIKI_AUTOCLOSE]`
Stop-hook block (the block reason prints the exact `--session-id` to use). On a
verified close (`ok: true` + clean git tree), it writes the per-session marker
`HYPO_DIR/.cache/session-closed-<id>.marker`. That marker is what tells the
Stop-chain Layer 3 hook (`hypo-auto-minimal-crystallize`) the session is closed,
so it stops re-prompting. Omit it only when running crystallize purely for
synthesis (no session-close intent) — the marker is then simply not written.

**Behavior (fix #39 option D + fix #40 lint gates):**

| Invocation | Behavior |
|---|---|
| `--apply-session-close` (no `--payload`) | **Probe mode** — exits 0 with "오늘 이미 close 완료로 보임" if all 5 files are fresh today; exits 1 with "payload is required" otherwise. Cheap "already complete?" check. |
| `--apply-session-close --payload=<path>` | **Always-apply** — payload presence = explicit close intent. Per-field idempotent writes (no-op when bytes match), then strict verification + lint gate. Safe to re-run. |
| `--apply-session-close --payload=<path> --session-id=<id>` | Same as above, **plus** writes the per-session closed marker on success (clean git required). The Stop-chain Layer 3 path. |
| `--apply-session-close --force` | Skips the probe early-exit. `--payload` still required for any actual apply work. |

**Two lint gates run automatically (fix #40), scoped to the files this close writes:**

Both gates judge only the **payload files** (the 5 mandatory close files + `open-questions.md`). Lint debt in other projects or shared `pages/` this close did not author is reported as a non-blocking `notices[]` entry, never gated — so an unrelated broken page elsewhere cannot block your close.

1. **Preflight** — `lint.mjs --json` runs **before** any payload bytes are written. Errors in overwrite targets (sessionState / projectHot / rootHot / openQuestions) are filtered (about to be replaced). Errors in an **append target** (session-log / log.md) still block (appending can't repair existing corruption) → exit 1 with `stage='preflight-lint'`. Errors outside the payload files → `notices[]`, apply proceeds.
2. **Post-apply** — lint re-runs after the writes. Blocks only on **errors** in payload files (a payload-introduced malformed body / bad frontmatter); pre-existing errors elsewhere → `notices[]`. A lint crash (unparseable output) always blocks. Broken wikilinks are lint **warnings** (W4 — forward references to planned pages are normal) and are not gated here. Surfaces as `stage='post-apply-lint'` (or `'post-apply-verification+lint'` if freshness also fails).

> **Manual close (direct Write tool calls)** clears the Stop-chain block via `--mark-session-closed --session-id=<id>`. Pass `--transcript-path=<path>` (the Stop hook surfaces it in its block message) so the marker is refused when a file **this session edited** still has lint errors — keeping the marker coherent with the PreCompact gate. Without `--transcript-path` it falls back to freshness + clean-git only (lint left to PreCompact).

---

## Step 4 — Stage-based recovery

The result JSON includes a `stage` field when `ok: false`. Branch on it:

| `stage` | What broke | How to recover |
|---|---|---|
| `preflight-lint` | A payload file (append target — session-log / log.md) has a pre-existing blocking lint error. | Fix the lint error in that file, then re-run. No payload bytes were written. (Debt outside the payload files is a non-blocking notice, not this stage.) |
| `post-apply-verification` | A mandatory file's `updated:` frontmatter is stale (≠ today) after apply. | Edit the payload's stale `content` (or supply correct `date`), then re-run. Writes are idempotent — re-applying a corrected payload is safe. |
| `post-apply-lint` | The payload introduced an error-level lint blocker in a payload file (malformed body / bad frontmatter), or lint crashed. | Fix the offending content in the payload, then re-run. (Broken wikilinks are W4 warnings — not gated.) |
| `post-apply-verification+lint` | Both above. | Fix both; re-run. |

Once `ok: true`, report:

- ✓ session-state.md applied
- ✓ hot.md (project + root) applied
- ✓ session-log entry appended
- ✓ open-questions applied (or skipped if unchanged)
- ✓ log.md entry appended
- ✓ post-apply lint clean

Then ask: "Session closed. Would you like to also run knowledge synthesis now, or stop here?"

If the user says stop, end here. Otherwise continue to Step 5.

---

## Step 5 — Surface synthesis candidates

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

```bash
node <package-root>/scripts/crystallize.mjs [--hypo-dir="<path>"] [--min-group=2]
```

Show the output to the user. If no candidates are found, tell them Hypomnema looks well-connected and no crystallization is needed.

---

## Step 6 — Choose what to crystallize

If candidates exist, ask:

> "Which would you like to crystallize?
> 1. A tag cluster (synthesize related pages into one synthesis page)
> 2. A draft page (upgrade to stable)
> 3. Unlinked pages (add cross-links)"

---

## Step 6a — Tag cluster synthesis

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

## Step 6b — Draft upgrade

For a draft page:

1. Read the draft
2. Fill in any missing sections, improve clarity, add cross-links
3. Change `tags: [draft]` → remove `draft` tag, set `confidence: high`
4. Update `updated:` to today

---

## Step 6c — Cross-link unlinked pages

For unlinked pages:

1. Read each unlinked page
2. Search the wiki for related pages (run `/hypo:query` mentally on the page title/tags)
3. Add a `## See also` section with `[[slug]]` links to 2–3 related pages
4. Reciprocally add links back where natural

---

## Step 7 — Report

Show what was created or modified, and offer to run `/hypo:lint` to verify all new links resolve.

---

## Appendix — Legacy `--check-session-close`

`--check-session-close` (read-only strict gate, same check PreCompact runs) is still supported as a probe-only verification. Use it when you only want to verify that today's session-close is complete without applying anything:

```bash
node <package-root>/scripts/crystallize.mjs --check-session-close [--hypo-dir="<path>"]
```

It reports any file as `missing` or `stale`. For an actual close, prefer `--apply-session-close --payload=<path>` (Step 3) — it bundles freshness + lint into one gate and is the documented dogfood path. (`parseArgs` only accepts the `--payload=<path>` spelling; a space-separated `--payload <path>` is silently ignored and triggers "payload is required".)
