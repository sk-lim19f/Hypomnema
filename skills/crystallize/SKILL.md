---
description: Close a session by capturing what happened into the wiki (steps 1-6), and on request consolidate scattered notes into stable pages (steps 7-11). Use when the user explicitly signals session end, asks to save or crystallize the session, or before a /compact. Task completion alone is not a close signal.
---

You are running `/hypo:crystallize`. The command serves two modes (spec §5.2.7 / §8.3):

1. **Session close (steps 1~6)** — gate the 5 mandatory memory files plus open-questions (conditional) so `/compact` can pass.
2. **Synthesis (steps 7~11)** — surface tag clusters, orphan pages, and drafts that are ready to consolidate.

When invoked to close a session — via an explicit close signal ("세션 종료", "wrap up"), an accepted proactive-offer [세션 마무리], or `/compact` — run the session-close checklist first. Task completion alone does not put you in close mode. The synthesis scan only runs after close is confirmed and the user agrees.

## What this does

- **Close mode**: walks the checklist (session-state, project hot.md, root hot.md, session-log, open-questions(변경 시), log.md) plus a lint step, then writes via `/hypo:crystallize` in `--apply-session-close --payload=<path>` mode — which runs the lint gate automatically, **scoped to the files it writes** (debt elsewhere is a non-blocking notice). `--check-session-close` is a read-only dry-run of the **full** PreCompact gate: close files + scoped lint + design-history + feedback projection, sharing one function (`precompactGateStatus`) with the gate. A green check means no gate blocker needs a human fix, so it is the signal to declare the session closed (pass `--transcript-path` to widen the lint scope to this session's edited files exactly as the interactive hook does). It is not a hard guarantee: the live `/compact` can still differ on a context-≥70% prompt, `HYPO_SKIP_GATE`, or a transcript-scoped lint error the check did not see.
- **Synthesis mode**: finds tag clusters (≥ N pages), orphan pages (no outbound `[[wikilinks]]`), and draft / stub pages, then guides consolidation into `pages/syntheses/<topic>.md` with back-links and `index.md` updates.

---

## Step 1 — Locate package root

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` or reinstall instead of guessing the cache layout.

If the user specified a wiki directory, pass it as `--wiki-dir="<path>"`. Otherwise omit the flag and the script resolves the wiki root automatically via `HYPO_DIR` → `hypo-config.md` scan → `~/hypomnema`.

---

## Step 2 — Run crystallize scan

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs \
  [--wiki-dir="<path>"] \
  [--min-group=<n>] \
  [--json]
```

Options:
- `--min-group=<n>` — minimum pages per tag group to report (default: 2)
- `--json` — output results as JSON

Show the output verbatim.

---

## Step 3 — Session-close checklist (if triggered at session end)

If `/hypo:crystallize` was invoked as a session-close action, run through this checklist before synthesizing. The mechanical checklist items (1–6 below) proceed automatically without confirmation unless the user has not said "auto"; the advisory reflections that precede them (#41~#44) always surface to the user for confirmation — they are recommendations, never auto-actions.

### Advisory reflections (run before the checklist below — advisory only)

Surface each of these four to the user first. Every one is **advisory** (identity guard): the user confirms or declines, and none performs an automatic action, writes a file on its own, or bypasses the mandatory gate.

- **Trivial-session check (#44)** — Was this session trivial (a single bug fix, a single-file edit, or Q&A with no durable artifact)? If so, recommend skipping session-close: *"이 세션은 trivial해 보입니다 — session-close를 건너뛸까요?"* A trivial skip is a recommendation, **not** a bypass: it must not mark the session closed, must not run `--mark-session-closed`, and must not claim `/compact` can pass. Any real close still requires all 5 mandatory files.
- **ADR-candidate check (#41)** — Did this session make an architectural or design decision (a new pattern, a tradeoff, a convention)? If yes, ask whether it warrants an ADR and capture that intent in the session-log entry. If nothing rose to ADR level, you may record the literal marker `ADR 없음 — <one-line reason>` in that same session-log entry — but gate it on #42's bar, not this one: the marker is machine-read and W8 treats a session-log entry carrying `ADR 없음` (and no ADR reference) as a *no-design* session, excluding it from the design-history staleness check. So write `ADR 없음` only when the session had no design change at all. If it had a sub-ADR design shift (background / tradeoff / differentiation), append to design-history (#42a) instead — writing the marker there would suppress the W8 nudge that shift needs. **Never auto-write an ADR file** — the session-log note is the only action here.
- **design-history staleness check (#42)** — Two branches, so a stale W8 never blocks a clean close: (a) if this session changed design decisions that `projects/<name>/design-history.md` does not yet reflect — including background / tradeoff / differentiation shifts that are below ADR level but still belong in the ledger — recommend appending to it now (W8 flags this mechanically; an active-project W8 hard-blocks at PreCompact — append before you commit, not after the gate fires). (b) only if this session made **no** design change at all does the `ADR 없음` marker from #41 exempt the entry from W8 — do **not** touch design-history. Caution: `ADR 없음` means "no design change," which is a stricter bar than "no ADR-level decision." A session with a sub-ADR design shift should take branch (a) and append; writing `ADR 없음` there would suppress the W8 nudge it actually needs. If the file does not exist, skip silently — do **not** create it just for this check. Never auto-update it.
- **Ingest check (#43)** — Did this session consume trustworthy external knowledge (a fetched URL, official docs, or code you verified directly)? If so, recommend running `/hypo:ingest` to capture it under `sources/`. Proceed only on the user's confirmation.

When uncertain, surface the question rather than skip it. None of the four blocks the close or writes on its own.

1. **session-state.md** — update `projects/<name>/session-state.md` with the next tasks list (what to tackle first next time).
2. **hot.md (project)** — update `projects/<name>/hot.md` with a session snapshot: what changed and decisions made. Keep under 500 words. Do not put next-step tasks here; those belong in session-state.md.
3. **hot.md (root)** — update `<wiki-root>/hot.md` active-projects pointer table: set the `Last Session` date for this project to today.
4. **session-log** — append a session entry to `projects/<name>/session-log/YYYY-MM-DD.md` (daily shard; the apply path creates today's file with seeded frontmatter if it does not exist yet).
5. **open-questions** — only if `pages/open-questions.md` exists and questions were raised or resolved this session: move resolved ones out; add newly raised ones. Skip if unchanged.

> Do **not** hand-write the root `log.md` session entry, and do **not** put a `log` field in the apply payload. The `## [date] session | <project>` entry is a derivable artifact: `--apply-session-close` calls `deriveRootLogEntries` after writing the session-log, reconstructing the canonical line from the session-log heading. (Supply `log` only for a deliberately custom line; it is now an optional payload field.)

After completing the checklist, verify it before reporting:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs --check-session-close [--hypo-dir="<path>"]
```

This runs the **full** PreCompact gate via the shared `precompactGateStatus`:
close files (`missing` / `stale`) plus lint blockers, stale
design-history, and feedback projection over-cap/conflict. Fix every `✗` it
reports and re-run until it prints **"Compact-ready"** — that is the signal the
session is closed. A close-files-only pass is not enough; the real `/compact`
also blocks on those other checks.

Optional `--project=<slug>` narrows the check to ONE project (close status plus
lint scope). It is a project-scoped **diagnostic**, not the compact-ready
signal. A green `--project` result (JSON `scope: "project"`) means only that
project is close-complete; another today-active project can still block
`/compact`. Use the plain `--check-session-close` (no `--project`) for the
go/no-go close signal.

**When using `--apply-session-close --session-id=<id>`** (the payload-driven
path), the `--session-id` must be the main conversation's session id. Do NOT
extract it from a background task or Agent output path (e.g., a UUID from
`/tmp/.../<uuid>/tasks/...`). Such a UUID is a background task id, not the
main conversation id. Passing the wrong id causes `markerWritten: false` with
`markerSkipReason: "transcript-unresolved"` or `"no-user-close-signal"`: the
5 mandatory files are written (ok: true) but the Stop-chain marker is withheld,
so the session is not actually closed and the Stop hook re-prompts. The correct
id comes from the `[WIKI_AUTOCLOSE]` block reason or the injected
`$CLAUDE_CODE_SESSION_ID` (accept the legacy spelling via
`${CLAUDE_CODE_SESSION_ID:-$CLAUDE_SESSION_ID}`).

Once it passes, report each item with ✓:
- ✓ session-state.md
- ✓ hot.md (project + root)
- ✓ session-log entry
- ✓ open-questions (or skipped if unchanged)
- ✓ log.md entry
- **marker written?** (required, if `--apply-session-close --session-id` was used): check `markerWritten` in the JSON output. If `true`, report "session-close marker written." If `false`, do NOT declare the session closed or complete; recover per the `markerSkipReason` branch below.

If `markerWritten: true` (or `--session-id` was not passed), ask: "Session closed. Would you like to also run knowledge synthesis now, or stop here?"

If `markerWritten: false`, do NOT say "session closed." Branch on `markerSkipReason`:

- `no-user-close-signal`: files applied cleanly and the transcript resolved, but it carries no close phrase the gate recognizes (the user's close wording fell outside the close-signal set, e.g. "세션 마무리까지 진행해줘" / "세션 마무리 진행"). Re-running the same id will not help. Confirm intent once with `AskUserQuestion` (header "세션", one option **세션 마무리**); if the user picks it, that answer is a recognized close signal, so re-run the same `--apply-session-close … --session-id` command (idempotent no-op writes; the marker lands). If the user declines, leave the session unmarked. Do NOT change the close-signal matcher.
- `transcript-unresolved` (wrong / background id): report "Files applied and verified (ok: true), but the marker was not written (reason: `<markerSkipReason>`). The Stop-chain is still active. Re-run with the correct main-conversation `--session-id`."
- any other reason (`compact-gate-not-ok`, `commit-failed: …`, `marker-did-not-land`): surface it verbatim and resolve the underlying blocker before re-running.

---

## Step 4 — Pick a synthesis target

Present the top candidates from the script output:
- Tag clusters with the most pages
- Long-standing orphans
- Pages marked `status: draft`

Ask: "Which of these would you like to crystallize now? (or 'all' / 'skip')"

---

## Step 5 — Synthesize

For the chosen target:

1. Read all pages in the cluster.
2. Write a new synthesis page at `pages/syntheses/<slug>.md` with:

```yaml
---
title: <synthesis title>
type: synthesis
tags: [<shared tags>]
updated: <today YYYY-MM-DD>
evidence_strength: inferred
---
```

3. Cross-link all source pages back to the synthesis with `[[wikilink]]`.
4. Add the synthesis to `index.md` under `## Pages — Syntheses`.

---

> **Citation convention.** When you reference a wiki page in your response, link it as `[[page-slug]]` so it stays connected in the graph. The observability audit scores sessions on search / ingest / feedback activity (recorded by `hypo-session-record`), not on these inline citations; run `/hypo:audit` to inspect and see [[pages/observability/_index]].
