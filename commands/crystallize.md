---
description: Crystallize draft notes into stable wiki knowledge; also the session-close path. Use when the user explicitly signals session end (종료/마무리/wrap up), asks to save or consolidate notes, or before a /compact. Task completion alone is not a close signal.
---

You are running `/hypo:crystallize`. This command serves two purposes:

1. **Session close** — if invoked at the end of a session, run the session-close mechanical-apply path
2. **Knowledge synthesis** — consolidate draft or scattered wiki pages into stable, well-linked pages

---

## Step 1 — Detect context

If `/hypo:crystallize` was invoked to close a session (via an explicit close signal like "세션 종료" / "오늘 작업 마무리" / "session close" / "wrap up", an accepted proactive-offer [세션 마무리], or `/compact`), run Step 1a (advisory reflections) then Steps 2–4 (session-close mechanical apply + recovery) **before** the synthesis scan. Task completion alone does not put you in close mode. Otherwise skip to Step 5.

---

## Step 1a — Session-close advisory reflections

Before composing the payload (Step 2), run these four reflections and surface each to the user. Every one is **advisory** (identity guard): the user confirms or declines, and none performs an automatic action, writes a file on its own, or bypasses the mandatory gate.

1. **Trivial-session check (#44)** — Was this session trivial (a single bug fix, a single-file edit, or Q&A with no durable artifact)? If so, recommend skipping session-close: *"이 세션은 trivial해 보입니다 — session-close를 건너뛸까요?"* and proceed only if the user wants a close. A trivial skip is a recommendation, **not** a bypass: it must not mark the session closed, must not run `--mark-session-closed`, and must not claim `/compact` can pass. Any real close still requires all 5 mandatory files.
2. **ADR-candidate check (#41)** — Did this session make an architectural or design decision (a new pattern, a tradeoff chosen, a convention established)? If yes, ask whether it warrants an ADR and, if so, capture that intent in the `sessionLog` entry you compose in Step 2. If nothing rose to ADR level, you may record `ADR 없음 — <one-line reason>` in that same `sessionLog` entry — but gate it on #42's bar: the marker is machine-read and W8 excludes an entry carrying `ADR 없음` (with no ADR reference) from the design-history staleness check. Write it only when the session had **no design change at all**; a sub-ADR design shift takes #42a (append) instead, since the marker would suppress the W8 nudge it needs. **Never auto-write an ADR file** — recording the decision (or its absence) in the session-log payload is the only action here.
3. **design-history staleness check (#42)** — Two branches, so a stale W8 never blocks a clean close: (a) if this session changed design decisions `projects/<name>/design-history.md` does not yet reflect — including sub-ADR background / tradeoff / differentiation shifts — recommend appending now (the W8 lint warning flags this mechanically; an active-project W8 hard-blocks at PreCompact — append before you commit). (b) only if the session made **no** design change does the `ADR 없음` marker (#41) exempt the entry from W8; do not touch design-history. `ADR 없음` means "no design change," a stricter bar than "no ADR-level decision." If the file does not exist, skip silently — do **not** create it just for this check. Never auto-update it.
4. **Ingest check (#43)** — Did this session consume trustworthy external knowledge (a fetched URL, official docs, or code you verified directly)? If so, recommend running `/hypo:ingest` to capture it under `sources/`. Proceed only on the user's confirmation.

These are judgment calls; when uncertain, surface the question rather than skip it. None of the four blocks the close or writes on its own.

---

## Step 2 — Compose the session-close payload

The session-close path is **payload-driven**. Instead of writing the 5 mandatory files one-by-one, you compose a single JSON payload that describes the full session-close state, then hand it to the `--apply-session-close` apply path (the Step 3 command), which performs idempotent atomic writes and gates the result with lint.

Payload shape (`project` + 4 content fields required; `log` optional/derived; `openQuestions` conditional, per Spec §5.2.7 / §8.3):

```json
{
  "project": "<project-name>",
  "date": "YYYY-MM-DD",
  "sessionState": { "content": "<full body of projects/<name>/session-state.md>" },
  "projectHot": { "content": "<full body of projects/<name>/hot.md>" },
  "rootHot": { "content": "<full body of <hypo-root>/hot.md>" },
  "sessionLog": { "entry": "<entry to append to projects/<name>/session-log/YYYY-MM-DD.md (daily shard)>" },
  "log": { "entry": "<entry to append to <hypo-root>/log.md>" },
  "openQuestions": { "content": "<full body of pages/open-questions.md>" }
}
```

> **Important:** the JSON above is a literal template — do not add `//` or `#` comments when materializing it. `readPayload()` runs `JSON.parse`, which rejects comments and would fail the apply before any write.

Field rules:

- `project`: **required**. Slug of the project being closed (matches a `projects/<slug>/` directory). Must be a single path segment, charset `A-Za-z0-9._-`, with at least one alphanumeric and not a dot-only name (`.`, `..`, `...`). Apply never infers the target from recency; a same-date pointer-table tie could otherwise write the close into the wrong project (B-3). A missing, malformed, or non-existent value fails the apply before any write.
- `date` — optional. Defaults to today (local). Must be `YYYY-MM-DD` if supplied.
- `openQuestions` — optional. Include only when `pages/open-questions.md` exists and changed this session.
- `log`: optional. Omit it by default (apply derives the canonical `## [date] session | <project>` line from your `sessionLog` heading). Supply it only for a custom log.md line, which must still be a canonical `session | <project>` heading, or the apply fails at `stage='pre-apply-verification'`.
- The remaining fields (`sessionState`, `projectHot`, `rootHot`, `sessionLog`) are required.

Notes:

- `sessionState` / `projectHot` / `rootHot` / `openQuestions` are **overwrite** (full-file content). `sessionLog` / `log` are **append** (entry-level idempotency — exact-entry dedup, safe to re-run).
- Frontmatter `updated:` is NOT auto-fixed. If your payload's `updated:` is stale, the post-apply verification gate will fail with `stage='post-apply-verification'` and you must fix the payload and retry.
- Write the payload to a temp path, e.g. `/tmp/hypo-session-close-<YYYY-MM-DD>.json`.

Content guidance for each slot:

1. **sessionState** — next tasks list for the upcoming session (what to tackle first next time).
2. **projectHot** — session snapshot under 500 words: what changed and decisions made. Do **not** put next-step tasks here; those belong in `sessionState`.
3. **rootHot** — active-projects pointer table with this project's `Last Session` date set to today.
4. **sessionLog** — one session entry to append to `projects/<name>/session-log/YYYY-MM-DD.md` (daily shard).
5. **log** (optional): a custom `session` entry for `<hypo-root>/log.md`. Omit it to let apply derive the canonical line from `sessionLog`.
6. **openQuestions** (conditional) — only if `pages/open-questions.md` exists and questions were raised or resolved this session.

---

## Step 3 — Apply the payload

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs \
  --apply-session-close \
  --payload=/tmp/hypo-session-close-<YYYY-MM-DD>.json \
  --session-id=<current-session-id> \
  --hypo-dir="<path>" \
  --json
```

**`--session-id`:** pass the current session's id whenever you
know it — most importantly when this close was triggered by a `[WIKI_AUTOCLOSE]`
Stop-hook block (the block reason prints the exact `--session-id` to use). On a
verified close (`ok: true` + clean git tree), it writes the per-session marker
`HYPO_DIR/.cache/session-closed-<id>.marker`. That marker is what tells the
Stop-chain Layer 3 hook (`hypo-auto-minimal-crystallize`) the session is closed,
so it stops re-prompting. Omit it only when running crystallize purely for
synthesis (no session-close intent) — the marker is then simply not written.

> **Source rule for `--session-id`:** use only the main conversation's session id
> (the id shown in the `[WIKI_AUTOCLOSE]` block reason, or the injected
> `$CLAUDE_CODE_SESSION_ID`; accept the legacy spelling via
> `${CLAUDE_CODE_SESSION_ID:-$CLAUDE_SESSION_ID}`).
> Do NOT extract it from a background task output path or Agent thread (e.g.,
> `/tmp/.../<uuid>/tasks/...`). A UUID from such a path is a background task id,
> not the main conversation id. Passing it causes `markerSkipReason:
> "transcript-unresolved"` or `"no-user-close-signal"` and leaves the Stop-chain
> open, even though `ok: true`.

**Behavior (option D + lint gates):**

| Invocation | Behavior |
|---|---|
| `--apply-session-close` (no `--payload`) | **Probe mode** — exits 0 with "오늘 이미 close 완료로 보임" if all 5 files are fresh today; exits 1 with "payload is required" otherwise. Cheap "already complete?" check. |
| `--apply-session-close --payload=<path>` | **Always-apply** — payload presence = explicit close intent. Per-field idempotent writes (no-op when bytes match), then strict verification + lint gate. Safe to re-run. |
| `--apply-session-close --payload=<path> --session-id=<id>` | Same as above, **plus** writes the per-session closed marker on success (clean git required). The Stop-chain Layer 3 path. |
| `--apply-session-close --force` | Skips the probe early-exit. `--payload` still required for any actual apply work. |

**Two lint gates run automatically, scoped to the files this close writes:**

Both gates judge only the **payload files** (the 5 mandatory close files + `open-questions.md`). Lint debt this close did not author is never gated — so an unrelated broken page elsewhere cannot block your close. It is reported as a non-blocking notice, scoped to the close-target project: debt under `projects/<project>/` is listed by file in `notices[]`; debt elsewhere (other projects, shared `pages/`, root files) folds into the `otherDebtCount` integer so the same untouched-file debt does not re-list its filenames on every close (run `/hypo:lint` for the full list).

1. **Preflight** — an internal `lint --json` preflight runs **before** any payload bytes are written. Errors in overwrite targets (sessionState / projectHot / rootHot / openQuestions) are filtered (about to be replaced). Errors in an **append target** (session-log / log.md) still block (appending can't repair existing corruption) → exit 1 with `stage='preflight-lint'`. Errors outside the payload files → `notices[]`, apply proceeds.
2. **Post-apply** — lint re-runs after the writes. Blocks only on **errors** in payload files (a payload-introduced malformed body / bad frontmatter); pre-existing errors elsewhere → `notices[]`. A lint crash (unparseable output) always blocks. Broken wikilinks are lint **warnings** (W4 — forward references to planned pages are normal) and are not gated here. Surfaces as `stage='post-apply-lint'` (or `'post-apply-verification+lint'` if freshness also fails).

> **Manual close (direct Write tool calls)** clears the Stop-chain block via `--mark-session-closed --session-id=<id>`. Both marker writers apply a **user-close hard gate**: the marker is written only when the session's transcript carries a genuine user close signal — an NL close phrase, a `/compact`, or an accepted AskUserQuestion [세션 마무리] answer. The transcript is resolved **strictly from `--session-id`** (a globally-unique id, globbed under `~/.claude/projects/`), never from a CLI arg, so a model that runs the writer on its own — without the user ever signalling close — is refused, and a forged path cannot point the gate at someone else's close-intent. The lint scope is widened from that same resolved transcript. `--transcript-path` is **not** consulted by the marker gate; it survives only to scope `--check-session-close`'s lint (which writes no marker).

---

## Step 4 — Stage-based recovery

The result JSON includes a `stage` field when `ok: false`. Branch on it:

| `stage` | What broke | How to recover |
|---|---|---|
| `pre-apply-verification` | A payload heading does not match the freshness contract the close gate enforces: `sessionLog.entry` has no dated `## [YYYY-MM-DD] …` heading, or an explicit `log.entry` is not the canonical `## [date] session | <project>` line. Caught **before** any write. | Fix the heading in the payload (the session-log entry needs a bracketed dated heading; the log line needs `session \| <project>` after the date, colon or space delimiter), then re-run. No payload bytes were written. |
| `preflight-lint` | A payload file (append target: session-log / log.md) has a pre-existing blocking lint error. | Fix the lint error in that file, then re-run. No payload bytes were written. (Debt outside the payload files is a non-blocking notice, not this stage.) |
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
- **marker written?** (required check): if `markerWritten: true`, report "session-close marker written"; if `markerWritten: false`, report "session-close marker NOT written (reason: `<markerSkipReason>`)" and do NOT declare the session "closed" or "complete". A missing marker means the Stop-chain is still open; recover per the `markerSkipReason` branch below.

If `markerWritten: true` (or `--session-id` was not passed): ask: "Session closed. Would you like to also run knowledge synthesis now, or stop here?"

If `markerWritten: false`, do NOT say "session closed." Branch on `markerSkipReason`:

- `no-user-close-signal`: the files applied cleanly and the `--session-id` resolved a transcript, but that transcript carries no close phrase the gate recognizes (the user asked to close in wording that fell outside the close-signal set, e.g. "세션 마무리까지 진행해줘" or "세션 마무리 진행"). Re-running with the same id will not help, since the transcript is unchanged. Instead, confirm intent once with `AskUserQuestion`, header "세션", a single option labelled **세션 마무리** (설명: "이 세션을 마무리하고 close 마커를 기록"). If the user picks 세션 마무리, that answer becomes a recognized close signal in the transcript, so re-run the exact same `--apply-session-close … --session-id` command (the writes are idempotent no-ops; the marker now lands). If the user declines, leave the session unmarked: the wiki record stands, but the session is not closed. Do NOT touch the close-signal matcher itself.
- `transcript-unresolved` (or a background / agent id was passed): say "Files applied and verified (ok: true), but the session-close marker was not written (reason: `<markerSkipReason>`). The Stop-chain is still active. To fully close: re-run with the correct main-conversation `--session-id`."
- any other reason (`compact-gate-not-ok`, `commit-failed: …`, `marker-did-not-land`): surface the reason verbatim and address it (resolve the compact blocker, fix the git / disk issue) before re-running.

If the user says stop, end here. Otherwise continue to Step 5.

---

## Step 5 — Surface synthesis candidates

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs [--hypo-dir="<path>"] [--min-group=2]
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
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs --check-session-close [--hypo-dir="<path>"]
```

It reports any file as `missing` or `stale`. For an actual close, prefer `--apply-session-close --payload=<path>` (Step 3) — it bundles freshness + lint into one gate and is the documented dogfood path. (`parseArgs` only accepts the `--payload=<path>` spelling; a space-separated `--payload <path>` is silently ignored and triggers "payload is required".)

Add `--project=<slug>` to scope the check to one project (close status + lint scope) when recency picks the wrong one. This is a project-scoped diagnostic only: a green scoped result (JSON `scope: "project"`) attests that slug is close-complete, **not** that `/compact` is unblocked globally. The marker writer (`--mark-session-closed --project=<slug>`) keeps a **global** gate; there `--project` only sets the marker's attribution slug.
