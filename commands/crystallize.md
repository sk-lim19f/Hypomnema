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

1. **Trivial-session check (#44).** Was this session trivial (a single bug fix, a single-file edit, or Q&A with no durable artifact)? If so, recommend skipping session-close: *"이 세션은 trivial해 보입니다. session-close를 건너뛸까요?"* and proceed only if the user wants a close. A trivial skip is a recommendation, **not** a bypass: it must not mark the session closed, must not run `--mark-session-closed`, and must not claim the close check is green. Any real close still requires its own session entry, the session-log entry and the log.md line.
2. **ADR-candidate check (#41).** Did this session make an architectural or design decision (a new pattern, a tradeoff chosen, a convention established)? If yes, ask whether it warrants an ADR and, if so, capture that intent in the `sessionLog` entry you compose in Step 2. If nothing rose to ADR level, you may record `ADR 없음: <one-line reason>` in that same `sessionLog` entry, but gate it on #42's bar: the marker is machine-read and W8 excludes an entry carrying `ADR 없음` (with no ADR reference) from the design-history staleness check. Write it only when the session had **no design change at all**; a sub-ADR design shift takes #42a (append) instead, since the marker would suppress the W8 nudge it needs. **Never auto-write an ADR file.** Recording the decision (or its absence) in the session-log payload is the only action here. This check carries no `decisions/` directory precondition: run it whether or not that directory exists.
3. **design-history staleness check (#42).** Two branches, so a stale W8 never blocks a clean close: (a) if this session changed design decisions `projects/<name>/design-history.md` does not yet reflect (including sub-ADR background, tradeoff, or differentiation shifts), recommend appending now: the W8 lint warning flags this mechanically, and an active-project W8 still counts as a `--check-session-close` blocker even though the PreCompact hook no longer stops `/compact` on it, so append before you commit. **If the file does not exist yet and this session had a design change, recommend creating it now** with that change as the first entry; lint separately flags a missing-but-needed file as W14, a warning that never blocks. (b) only if the session made **no** design change does the `ADR 없음` marker (#41) exempt the entry from W8; do not touch design-history, and do not create the file just to satisfy this branch's check. `ADR 없음` means "no design change," a stricter bar than "no ADR-level decision." Never auto-write the file yourself in either branch: recommend it, and let the user decide.
4. **Ingest check (#43)** — Did this session consume trustworthy external knowledge (a fetched URL, official docs, or code you verified directly)? If so, recommend running `/hypo:ingest` to capture it under `sources/`. Proceed only on the user's confirmation.

These are judgment calls; when uncertain, surface the question rather than skip it. None of the four blocks the close or writes on its own.

---

## Step 2 — Compose the session-close payload

The session-close path is **payload-driven**. You compose a single JSON payload that describes this session and hand it to the `--apply-session-close` apply path (the Step 3 command). Apply creates **one immutable session entry**, `projects/<slug>/sessions/<date>-<close id>.md`, appends to the project's session-log shard and to `log.md`, and gates the result with lint. It overwrites no project state file: a project's `session-state.md` and `hot.md` are views generated from its entries, so do not write them. The close id belongs to this close request and stays the same across retries, so re-running a payload is safe.

Payload shape (a single-track example with the required fields only):

```json
{
  "project": "<slug>",
  "sessionId": "<current session id>",
  "summary": "<what this session did and decided, markdown>",
  "tracks": [
    { "id": "<track-id>", "title": "<display title>", "next": "<next steps and state, markdown>" }
  ],
  "sessionLog": { "entry": "<entry to append to projects/<slug>/session-log/YYYY-MM-DD.md>" }
}
```

> **Important:** the JSON above is a literal template: replace every `<...>` placeholder with a real value, and do not add `//` or `#` comments when materializing it. `readPayload()` runs `JSON.parse`, which rejects comments and would fail the apply before any write.

Field rules:

- `project`: **required**. Slug of the project being closed (matches a `projects/<slug>/` directory). Must be a single path segment, charset `A-Za-z0-9._-`, with at least one alphanumeric and not a dot-only name (`.`, `..`, `...`). Apply never infers the target from recency; a same-date pointer-table tie could otherwise write the close into the wrong project (B-3). A missing, malformed, or non-existent value fails the apply before any write.
- `sessionId`: recommended. The current session id, the same value you pass to `--session-id`. When present, apply refuses (`stage='session-id-mismatch'`, exit 1, nothing written) if it does not equal `--session-id`, so a payload file another session overwrote cannot be applied under this session's marker. It is a string self-check, not the transcript resolver; authority still comes from `--session-id`. Optional for backward-compat: omitting it or setting it to `null` skips the check (fail-open), but an empty string `""` counts as a mismatch and is refused. Omit only if you genuinely cannot determine the id.
- `summary`: **required**, a string. A snapshot of this session under 500 words: what changed and what was decided, as markdown. Do **not** put next-step tasks here; those belong in `tracks[].next`.
- `tracks`: an array with one element per track this session worked on. A track is one thread of work in the project (a project running two or three in parallel is normal). The array may be empty when the session moved no track. Each element has:
  - `id`: **required**. Lowercase letters, digits and hyphens, starting with a letter or digit, at most 48 characters. It must name a track the project already has, or be a new one (see `new` below).
  - `next`: the next tasks and state of that track, as markdown. This becomes the track's current head, the first thing the next session reads for it. An element that only ends the track (`done`) may leave it out.
  - `title`: an optional display title.
- `sessionLog.entry`: **required**. The entry to append to `projects/<slug>/session-log/YYYY-MM-DD.md` (the daily shard). It must carry a dated `## [YYYY-MM-DD] <title>` heading.

Optional fields, which stay out of the JSON template above:

- `date`: defaults to today (local). If supplied, it must be a real calendar date in `YYYY-MM-DD` form; a day that does not exist, such as `2026-09-31`, fails the apply before any write.
- `new: true` on a track element starts a track the project has not registered yet. An unregistered id without it is refused (`track-unknown`, and the error lists the registered ids). `new: true` on a registered id is refused as well (`track-exists`).
- `done: true` on a track element ends the track. It may be sent without a body: `{ "id": "<track-id>", "done": true }`. It ends only the heads this session knew about (the ones it was shown in full or as a pointer line). A head another session wrote to the same track at the same time stays active. To end that one too, read that entry first, then send `done` again in a later close.
- `supersedes` on a track element names the earlier heads of that track this update replaces. Leave it out and the update replaces every head of the track this session was told about. When you name them, use a full close id as shown in the injection or the view, or a prefix that is unique within that track. A close id that does not exist, or an ambiguous prefix, is refused (`supersedes-unknown`).
- Never put the same track id in `tracks` twice (`track-duplicate`). A normal update plus a separate `done` for one track is the usual way to hit it: send one element for that track instead.
- `log.entry`: a custom line for `<hypo-root>/log.md`. Omit it by default: apply derives the canonical `## [date] session | <project>` line from your `sessionLog` heading. Supply it only for a custom line, which must still be a canonical `session | <project>` heading, or the apply fails at `stage='pre-apply-verification'`.
- `openQuestions.content`: the full body of `pages/open-questions.md`. Include it only when this session actually changed that file. It is the one overwrite left in a close, so it goes through the base protection and the approval path described below and in Step 4 (`proposal-pending`).

Notes:

- The session entry is create-only. `sessionLog` and `log` are **append** (entry-level idempotency, exact-entry dedup, safe to re-run). Only `openQuestions` is **overwrite** (full-file content).
- A summary or track body must not contain a line that is exactly one of this close's own entry markers (an HTML comment of the form `<!-- hypomnema:summary <close id> -->` or `<!-- hypomnema:track <track id> <close id> -->` that carries this close's id). Such a line is refused (`payload-reserved-marker`) before anything is written. Any other text, including other HTML comments, passes.
- If this close's entry was already committed by an earlier run of the same close, a re-run keeps that entry as it is and reports one line in `notices[]`: `이미 기록된 원본이 있어 이번 payload의 요약은 반영되지 않았습니다`. It means the summary and track text in this payload were not written. Tell the user, and carry whatever still matters into the summary of the next close.
- If the injected context at session start showed a track head only as a pointer line, this session's close still replaces that head by default. Before you continue that track, read the file the pointer line names: the entry under `projects/<slug>/sessions/` before the vault is migrated, `projects/<slug>/session-state.md` after it is (a baseline head always points there).
- **Overwrite means overwrite: whatever you did not carry into `openQuestions.content` is gone.** Before composing that field, read the CURRENT on-disk file and carry forward every `##` section this session did not touch, verbatim; do not reconstruct a section from memory or drop it because this session had nothing new to add to it. This session's own edits go on top of that, not in place of it.
- Apply enforces the same rule mechanically: if the `openQuestions` payload drops 2 or more of the file's existing `##` sections, apply withholds it (parks it exactly like a base conflict, as a proposal artifact a human reviews and can force through) rather than writing it. If you are deliberately consolidating or retiring sections on purpose (the user asked for it, or the sections genuinely no longer apply), add `"restructure": true` next to that field's `"content"` to say so. **This changed: the flag used to write the bytes straight through, and it no longer does.** It records your claim for whoever reviews the park, and it changes the park reason so they can see the drop was deliberate rather than an omission. The bytes still land only once a human approves the proposal. Nothing you can put in a payload approves your own destructive overwrite. A flag that waived a real trip, as opposed to a `true` set on a field that never dropped anything, shows up in the result's `restructureWaivers[]` (see Step 4's close-result reporting).
- Write the payload to a **session-scoped** temp path, e.g. `/tmp/hypo-session-close-<session-id>.json`, using the same `<session-id>` you pass below. A date-based path (`<YYYY-MM-DD>`) collides when two sessions close on the same day: the second write silently overwrites the first, and the wrong payload gets applied. The `sessionId` field above is the second line of defense if a path is ever reused anyway.
- `rootHot` is **gone from this payload.** The root `hot.md` pointer table is regenerated by the SessionStart and Stop hooks, so a table composed here is overwritten by this same turn's Stop hook before it ever reaches git. It is not an omission: do not add it back. An older installed copy of this command still sends it, so apply does not fail on it: it reports one line in `notices[]` saying the field was ignored, and writes nothing for it.
- An older copy of this command also sent `sessionState` and `projectHot` instead of `summary` and `tracks`. That form is still accepted so a not-yet-upgraded install keeps closing: `projectHot.content` becomes the summary and `sessionState.content` the body of a track named `legacy`, and `notices[]` carries one line asking for the new form from the next close. Do not write new payloads this way. A payload that carries both forms is refused.

There is no slot for the project `hot.md`, `session-state.md` or the root `hot.md`. They are generated from the session entries (and the root table from the projects' entries) on every session start and session end, so anything written into them by hand is thrown away.

---

## Step 3 — Apply the payload

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install) or reinstall instead of guessing the cache layout.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs \
  --apply-session-close \
  --payload=/tmp/hypo-session-close-<session-id>.json \
  --session-id=<current-session-id> \
  --json
```

Add `--hypo-dir="<path>"` only when the user specified a Hypomnema directory explicitly;
otherwise omit it and the script resolves the root itself.

**`--session-id` is required for any close that carries a `--payload`.** It is not a
switch that turns a check on; omitting it fails the check. Before a single byte is
written or committed, the apply resolves that session's transcript and looks for
evidence the **user** asked to close. It refuses outright, exit 1 with `applied: []`
and nothing on disk, in three cases:

| `reason` | Meaning |
|---|---|
| `session-id-required` | No `--session-id` was passed. |
| `transcript-unresolved` | The id resolves to no transcript under `~/.claude/projects/`. |
| `no-user-close-signal` | The transcript exists, but no close authority is in force right now. This one string collapses three different gate outcomes, and only one of them means the user never asked. Read `gateReason` (below) before deciding what to do about it. |

A refusal is not a failure to route around. It means the close should not happen: ask
the user, and re-run only after they say so.

On a verified close (`ok: true`, no uncommitted file in the project folder being closed, and no uncommitted file elsewhere that this session wrote through Write or Edit since its last auto-commit)
the apply first files a commit-backed close checkpoint receipt at
`HYPO_DIR/.cache/sessions/<id>/close-receipt.json`, then writes the per-session compat marker
`HYPO_DIR/.cache/session-closed-<id>.marker` as a projection of it. If the marker does not land,
the receipt is withdrawn again, so a run that reports the marker as failed never leaves a valid
receipt behind. The checkpoint gate reads git more narrowly than the PreCompact gate and `--check-session-close` do. An uncommitted
file inside the project folder being closed (`projects/<project>/`) blocks whether or not this
session has a record of writing it. An uncommitted file at the vault root or in another project's
folder blocks only when this session wrote it through Write or Edit since its last auto-commit;
otherwise it is reported as a notice. If the record of what this session wrote cannot be read, the
gate does not block on it: it treats the session as having no record and adds a notice that it could
not determine who owns those files. So the checkpoint can land while `--check-session-close` stays red on
someone else's dirty file. Neither one stops `/compact`: the PreCompact hook only shows a notice. The checkpoint receipt is the thing the
Stop-chain Layer 3 hook (`hypo-auto-minimal-crystallize`) actually checks: it proves only that
the file versions it names are in a specific commit, never that every change this session made
is saved. (It has nothing to do with the `close-receipt-failed` result of `proposal resolve`
below, which concerns the close-journal's handoff receipt.) Stop stops re-prompting for the close
procedure itself, and still surfaces any other uncommitted vault change separately, once per
receipt, as a notice rather than a repeat of "session-close incomplete". A shared append
target (`log.md`, a session-log shard) is checked by containment, not byte-for-byte: the
receipt only confirms this close's own entry is in the file, and the commit that lands it
carries the whole file as it stood at commit time, including any other session's
already-dirty bytes in the same file. Running crystallize purely for **synthesis** carries
no payload and needs no session id.

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
| `--apply-session-close` (no `--payload`) | **Probe mode**: exits 0 with "오늘 이미 close 완료로 보임" if the project already has today's session entry, session-log entry and `log.md` line; exits 1 with "payload is required" otherwise. Writes nothing, so it needs no session id. |
| `--apply-session-close --payload=<path>` | **Refused**, exit 1, `reason: 'session-id-required'`. Nothing is written and nothing is committed. |
| `--apply-session-close --payload=<path> --session-id=<id>` | The only apply path. Verifies close authority against that session's transcript **first**; on a refusal nothing is written. On success: per-field idempotent writes (no-op when bytes match), strict verification, lint gate, commit, and the per-session closed marker. Safe to re-run. |
| `--apply-session-close --force` | Skips the probe early-exit. It does **not** skip the authority check, and `--payload` plus `--session-id` are still required to apply anything. |

When a refusal carries `reason: 'no-user-close-signal'`, the JSON also carries
`gateReason`, naming which of the three gate checks refused: `no-open` (the
transcript holds no user close signal at all), `transcript-rewrite-detected`
(the transcript changed under the gate), or `no-new-open-since-resolution` (the
close signal predates a resolution already recorded). The collapsed `reason`
stays the same string in all three cases, so read `gateReason` rather than
parsing the `Gate detail:` fragment out of `error`. The field is absent for
every other refusal. `markerGateReason` on a successful apply is the same
diagnostic one stage later: the apply itself went through, and only the marker
was withheld for lack of a signal, so it carries the same three values and is
read the same way (see the `markerSkipReason` branches below).

**Two lint gates run automatically, scoped to the files this close writes:**

Both gates judge only the **payload files**: this close's session entry, the session-log shard (or the monthly file that already holds today's heading), `log.md`, `open-questions.md` when the payload carries it, and a project `index.md` this close creates. The project's generated `session-state.md` and `hot.md` and the root `hot.md` are not payload files, so debt in them never blocks a close. Lint debt this close did not author is never gated, so an unrelated broken page elsewhere cannot block your close. It is reported as a non-blocking notice, scoped to the close-target project: debt under `projects/<project>/` is listed by file in `notices[]`; debt elsewhere (other projects, shared `pages/`, root files) folds into the `otherDebtCount` integer so the same untouched-file debt does not re-list its filenames on every close (run `/hypo:lint` for the full list).

1. **Preflight**: an internal `lint --json` preflight runs **before** any payload bytes are written. Errors in the files this close is about to write (its own session entry, `openQuestions`) are filtered (a retry may replace them). Errors in an **append target** (session-log / log.md) still block (appending can't repair existing corruption) → exit 1 with `stage='preflight-lint'`. Errors outside the payload files → `notices[]`, apply proceeds.
2. **Post-apply**: lint re-runs after the writes and **before** the commit. Blocks only on **errors** in payload files (a payload-introduced malformed body / bad frontmatter); pre-existing errors elsewhere → `notices[]`. A lint crash (unparseable output) always blocks. Broken wikilinks are lint **warnings** (W4: forward references to planned pages are normal) and are not gated here. Surfaces as `stage='post-apply-lint'`. A lint failure stops the close before anything is committed, so the post-apply verification (which reads the commit) never runs next to it.

> **Manual close (direct Write tool calls)** clears the Stop-chain block via `--mark-session-closed --session-id=<id>`. Both marker writers apply a **user-close hard gate**: the marker is written only when the session's transcript carries a genuine user close signal — an NL close phrase, a `/compact`, or an accepted AskUserQuestion [세션 마무리] answer. The transcript is resolved **strictly from `--session-id`** (a globally-unique id, globbed under `~/.claude/projects/`), never from a CLI arg, so a model that runs the writer on its own — without the user ever signalling close — is refused, and a forged path cannot point the gate at someone else's close-intent. The lint scope is widened from that same resolved transcript. `--transcript-path` is **not** consulted by the marker gate; it survives only to scope `--check-session-close`'s lint (which writes no marker).
>
> `--mark-session-closed` files the checkpoint receipt only when this session's own close entry under `projects/<project>/sessions/`, the session-log evidence file and `log.md` of every project it attributes are already **committed**, so commit them first. The generated `session-state.md` and `hot.md` prove nothing here. "This session's own close entry" is the entry of the close request that is in force: while the user's newest close request has no entry yet, an entry from an earlier close of the same session does not count. In that state the command refuses with `reason: 'incomplete'` and `awaitingApply: true`, and `error` carries `이 세션에 새 close 요청이 열려 있고 아직 이 요청의 원본이 없습니다. close payload로 apply를 먼저 실행하세요`: run `--apply-session-close` with the close payload first, there is nothing to commit by hand. On any failure it prints `ok: false` and exits 1 without a marker.
>
> The `stage` table in Step 4 belongs to `--apply-session-close`. `--mark-session-closed` has no `stage` field. A refusal after the receipt proof carries a `reason` instead (and `error` in prose), and so does `prior-checkpoint-rewritten`, which comes before the gate runs. Branch on that:
>
> | `reason` | What broke | How to recover |
> |---|---|---|
> | `incomplete` | `incompleteProjects[]` names each project whose session entry for this close, session-log evidence file or log.md is missing, not fresh, or not committed. When `awaitingApply: true` is also present, a new close request is open and no entry was written for it yet, so an earlier close of the session cannot vouch for it. | Commit the close files of the projects named, or finish writing them, then re-run the same command. With `awaitingApply: true`, run `--apply-session-close` with the close payload (Step 2) first. |
> | `mismatch` | The version of a proof file committed at HEAD differs from what is in the working tree. `mismatches[]` lists each `{path, reason}` (for example a file with an uncommitted edit, or one a `.hypoignore` rule keeps out of the commit). | Run `git status` in the vault, commit the reviewed paths, then re-run. |
> | `no-commit-identity` | The vault has no readable commit to certify against (not a git repository, or no commit exists yet). | Commit the close files so the vault has a HEAD, then re-run. |
> | `write-failed` | Writing the checkpoint receipt under `.cache/sessions/<session-id>/` failed; `writeReason` names the error. If `retractFailed` is also present, taking back what the write may have left failed too and a stale receipt may remain there. | Fix what blocks that directory (a file where the directory should be, permissions, disk space), remove any stale `close-receipt.json` it names, then re-run. |
> | `marker-did-not-land` | The receipt was filed but the marker file itself did not land. The receipt is withdrawn again; `retractFailed` is present only when that failed too. | Fix what blocks the marker path under `.cache/` (permissions, a directory sitting where the marker goes, disk space), then re-run. |
> | `prior-checkpoint-rewritten` | This session had filed a close receipt earlier, and the commit it proved is no longer in the branch history (a hard reset or a rebase dropped it). The command refuses before it touches anything: the old receipt and marker stay where they are, and the result carries `prior_commit`. Issuing a new receipt over today's other close files would report "closed" while the original close record stays lost. A receipt that is missing or unparsable does not trigger this, and neither does one whose commit is still in the history but whose marker is gone (that one recovers with this command as usual). | Restore the dropped commit (for example from `git reflog`), or ask the user to request the close again and run `--apply-session-close` with a new payload. Do not retry `--mark-session-closed`: it refuses the same way until the history holds that commit again. |
> | `vault-commit-lock-timeout` | Another close or commit held the vault-commit lock past the timeout. | Re-run the same command a moment later. |
>
> Three refusals come before the receipt proof and carry no `reason`. A gate refusal (`blockers[]` plus `missing` and `stale`, with `error: 'session-close gate not satisfied'`) means the same close-file, lint or feedback checks as `--check-session-close` found something this session owns: fix it and re-run. A `skipReason` of `no-user-close-signal` (with `gateReason` when the gate has one) or `no-attribution-evidence` means the transcript shows no close request, or nothing ties this session to a project (pass `--project=<slug>` or `--log-only`). A bare `error` with none of these fields means the prior receipt or marker could not be set aside; fix the permission or disk problem under `.cache/` it names.
>
> The close checkpoint is recorded once the receipt is issued: `ok: true` from this command, and `close_state: closed` from `--check-session-close --session-id=<id>`. The Stop hook still checks this session's own project folder and has the final say. The final "Close check" line of `--check-session-close` covers the whole vault, so another session's uncommitted file can keep it red after your close has landed. A red line never stops `/compact`: PreCompact only shows a notice.

---

## Step 4 — Stage-based recovery

The result JSON of `--apply-session-close` includes a `stage` field when `ok: false`. Branch on it. (`--mark-session-closed` reports `reason` instead; see the table in Step 3.)

| `stage` | What broke | How to recover |
|---|---|---|
| `session-id-mismatch` | The payload's `sessionId` is a non-empty string that does not equal `--session-id`, so this file was authored for a different session (a reused or overwritten temp path). Caught **before** any write. Absent or `null` `sessionId` fails open (no check); an empty string counts as a mismatch. | Rebuild the payload for THIS session and write it to a session-scoped path (`/tmp/hypo-session-close-<session-id>.json`), then re-run. No payload bytes were written. |
| `pre-apply-verification` | A payload heading does not match the freshness contract the close gate enforces: `sessionLog.entry` has no dated `## [YYYY-MM-DD] …` heading, or an explicit `log.entry` is not the canonical `## [date] session | <project>` line. Caught **before** any write. | Fix the heading in the payload (the session-log entry needs a bracketed dated heading; the log line needs `session \| <project>` after the date, colon or space delimiter), then re-run. No payload bytes were written. |
| `track-duplicate` | The same track id appears in `tracks` more than once (typically a normal update plus a separate `done` for one track). Caught **before** any write. | Merge the elements into one per track id, then re-run. No payload bytes were written. |
| `track-unknown` | A `tracks` element names an id the project has no track for and does not carry `new: true`. The `error` lists the registered ids. Caught **before** any write. | If it is a typo, use the registered id. If it is a new track, add `"new": true`. Re-run. Nothing was written. |
| `track-exists` | A `tracks` element carries `new: true` for an id the project already has. Caught **before** any write. | Drop `"new": true` to update the track (or pick another id for a new one), then re-run. Nothing was written. |
| `supersedes-unknown` | A `supersedes` value is not a close id of an update of that track, or is a prefix that matches more than one. The `error` lists the track's updates. Caught **before** any write. | Use a full close id or a prefix unique within that track, or drop `supersedes` to take the default (every head this session was told about), then re-run. Nothing was written. |
| `payload-reserved-marker` | The summary or a track body holds a line that is exactly an entry marker of this close (the whole line, carrying this close's id). Caught **before** any write. | Change or remove that line, then re-run. Other HTML comments and similar text do not trip it. Nothing was written. |
| `invalid-entry` | The entry could not be formatted for a reason other than a marker or a duplicate track: a value that does not fit the entry format (for example a malformed session id or project name). The `error` names it. Caught **before** any write. | Fix the value the `error` names, then re-run. Nothing was written. |
| `entry-conflict` | This close's entry path already holds bytes that this close did not write, or that were edited after the commit. Apply leaves the file alone. The `error` names the path. Caught **before** any write; `committed: null`. | Look at the file and the vault history. Once you have moved or removed the foreign bytes yourself, re-run the same close: the retry needs no fresh close phrase. |
| `close-pin` | Apply could not record this close's id, or its intent to publish the entry, in `.cache/close-pin/` (usually a permission or disk problem under `.cache/`). Refused before the entry is written, so nothing changed on disk and `committed` is `null`. (For a `.hypoignore` project, recording the entry's local proof comes after the write; the retry recognizes the file as this close's own.) | Fix the problem named in `error`, then re-run the same payload. |
| `preflight-lint` | A payload file (append target: session-log / log.md) has a pre-existing blocking lint error. | Fix the lint error in that file, then re-run. No payload bytes were written. (Debt outside the payload files is a non-blocking notice, not this stage.) |
| `post-apply-verification` | After the commit landed, this close's own state did not read back right: its session entry (found by its close id) is not in HEAD, or the session-log heading or the `log.md` line for it is missing or not fresh. The `error` lists what is `missing` or `stale`. | Check the entry, the session-log shard and `log.md` in the vault (`git status`, `git log`), then re-run the same close. Writes are idempotent, so re-applying is safe. A lint failure never shows up here: lint runs before the commit, and its failure is reported as `post-apply-lint`. |
| `post-apply-lint` | The payload introduced an error-level lint blocker in a payload file (malformed body / bad frontmatter), or lint crashed. Nothing was committed. | Fix the offending content in the payload, then re-run. (Broken wikilinks are W4 warnings and are not gated.) |
| `proposal-pending` (overwrite park) | At least one overwrite field drifted from this session's observed base, or its payload dropped 2 or more of an existing file's `##` sections. `restructure: true` does not exempt a field from this; it only changes which park reason is recorded (`section-loss-guard-restructure-pending` instead of `section-loss-guard`). One reason, `will-overwrite-local-change`, fires whenever disk has moved away from what this session's own close last applied to that target (almost always a hand edit through Write/Edit after that apply), regardless of whether the new payload is the exact old bytes or something else entirely: there is no way from here to tell a payload that folds the hand edit back in from one that ignores it, so both park the same way and both need a human's `proposal challenge`/`proposal resolve` to land. Each withheld field appears in `conflicts[]` with a `reason` code and a `why` (a ready-to-read sentence naming the cause, reuse it verbatim, don't reword it), and is parked as a `.cache/proposals/<id>.json` artifact; `proposals[]` lists the id, target, and path for every one. The target on disk is untouched. Other, non-conflicting fields in the same payload may already be on disk but uncommitted (`partialConflict: true`, `appliedUncommitted`). | Do not touch the parked file yourself, and do not tell the user to run `hypomnema proposal apply <id>`: that command reads from a TTY and is refused outright in this environment (no terminal attached). Use the transcript-approved path instead. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.mjs challenge --session-id=<current-session-id> --ids=<comma-separated ids from proposals[]>`. If the session resolving this approval is NOT the same session that ran this close (the original session ended and this is a fresh one finishing its park), also pass `--close-session-id=<the original close's session id>`, so the approved bytes get credited back to THAT close's own retry instead of this one's. It prints a diff per target and mints a nonce; tell the user the exact line it prints (`apply-proposals <nonce>`, read the nonce off that output, never invent or reuse one), and once they have typed it back in the conversation, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.mjs resolve --session-id=<current-session-id>` to apply the approved batch. `node ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.mjs list` and `... discard <id>` (drop a proposal without applying it) both work with no TTY. Once resolved, re-run the **original** close (the one named by `--close-session-id`, or this same session if you omitted it); it is idempotent. If `resolve` itself reports `close-receipt-failed` (the close-journal's handoff receipt, unrelated to the close checkpoint receipt described above), do NOT re-run the close: the approved bytes landed on the page, but the close whose retry needs to see them was not told. Fix whatever is blocking `.cache/close-journal/` and run `node ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.mjs reconcile` instead, which recovers the missing receipt from the audit log without writing any page, then re-run the original close. |
| `proposal-pending` (append lock timeout) | An append field (`sessionLog` or `log`) could not take its file lock within the timeout (default 5s), usually a concurrent close holding the same target. Nothing is parked for it: it carries `kind: 'append'` in `conflicts[]` and never appears in `proposals[]`. | This is transient, not a review case. Do not run any `proposal` subcommand for it, there is nothing there to challenge or apply. Just re-run the same close; the next attempt normally clears once the other close releases the lock. |
| `invalidate-failed` | A new close was authorized, and before writing anything the apply tried to set aside this session's prior close checkpoint receipt and marker, because they must not keep certifying a close that is being redone. That rename failed, usually a permission or disk problem under `.cache/`. Nothing was written and nothing was committed (`applied: []`, `committed: null`). The JSON carries `error` but no `mismatches[]`. | Fix the permission or disk problem named in `error`, then re-run the same close. No fresh close phrase is needed: nothing was recorded as resolved. |
| `receipt-proof-mismatch` | The writes and the commit went through, but the committed bytes do not match what this close meant to certify, so the checkpoint receipt was withheld and no marker was written. `ok: false`, exit 1, `committed: true`, and `mismatches[]` lists each `{path, reason}` that failed (for example a target that a `.hypoignore` rule keeps out of the commit, or a file whose committed version differs from the payload). A `path` of `(commit)` with `no-commit-identity` means the vault has no readable commit to certify against. | Run `git status` in the vault and look at each path in `mismatches[]` to see why that file is not committed as written. Once you have reviewed those paths, commit them, then re-run the same close. The retry needs **no fresh close phrase**, because a close signal is spent only once the receipt and marker land. |
| `receipt-write-failed` | Same point as above (committed, proof verified), but writing the checkpoint receipt file itself failed. `ok: false`, exit 1, and `mismatches[]` holds one entry `{path: '(receipt)', reason}` naming the write error. When the file was written but could not be read back, the receipt is withdrawn again if it is this close's own; if that fails too, a second entry `{path: '(receipt)', reason: 'retract-failed: …'}` follows and a stale receipt may remain. | Fix what is blocking `.cache/sessions/<session-id>/` (a file sitting where the directory should be, permissions, disk space), then re-run the same close. No fresh close phrase is needed. |
| `marker-did-not-land` | Every close precondition cleared (the gate was satisfied, the writes landed, the commit succeeded, the checkpoint receipt was filed) and only the session-close marker's own write to disk failed. This is the one marker failure that is a disk problem rather than a policy withhold, so it comes back `ok: false` and exit 1 instead of a `markerSkipReason` on a successful result. The receipt just filed is withdrawn again, so no reader sees this session as closed. If withdrawing it failed too, `mismatches[]` carries `{path: '(receipt)', reason: 'retract-failed: …'}` and a stale receipt may remain under `.cache/sessions/<session-id>/`. | Fix what is blocking the marker path under `.cache/` (permissions, a directory sitting where the marker file goes, disk space), then re-run the same close. **No fresh close phrase is needed**: a close signal is spent only once the marker lands, so this run left it unspent. Everything else is already idempotent, so the retry re-applies cleanly. |
| `proposal-store-failed` | A conflict was correctly withheld from disk, but writing its `.cache/proposals/` artifact also failed (see `proposalStoreFailures[]` and the loud stderr). The payload bytes for that field are on neither disk nor a proposal artifact right now. | Fix whatever is blocking `.cache/proposals/` (permissions, a file sitting where the directory should be, disk space), then re-run the exact same payload. Nothing was lost: the payload still holds the bytes, only the parking step failed. |

Once `ok: true`, report from the result JSON's `applied` and `skipped` arrays together, not `applied` alone. `applied` lists only the fields this run actually wrote bytes for; `skipped` lists the fields that already matched what was on disk (a re-run of an already-applied payload). An idempotent re-run legitimately reports `applied: []`, and that is success, not a failure to report on: check `skipped` for the same 4-6 entries instead. Read `committed` the same way: `true` covers both a real commit and the case where nothing needed staging (a full no-op re-run); `false` means the commit itself ran and failed (see `markerSkipReason`); `null` means apply never reached the commit step at all, because `ok` was already false (an authority refusal before any write, or a verification/lint failure, or a withheld conflict, per `stage`). `null` does NOT mean nothing was written: `applied` can be non-empty (bytes landed on disk) while `committed` stays `null`, because those bytes were never staged into git.

- ✓ session entry `projects/<slug>/sessions/<date>-<close id>.md` created (or already current, per `skipped`; both arrays name it `sessionEntry (<path>)`). A close writes this one new file and replaces nothing: the project's `session-state.md` and `hot.md` are generated views, not part of this apply. The root `hot.md` pointer table is a separate projection a hook rebuilds from the projects' entries. A `rootHot` field in an older payload is not applied here either; it's ignored, and the result JSON reports that under `notices[]` (see below).
- ✓ session-log entry appended (or already present)
- ✓ open-questions applied (or skipped if unchanged)
- ✓ log.md entry appended (or already present)
- ✓ post-apply lint: no blockers (say "lint clean" only when `lintNotices` is empty and `notices[]` and `otherDebtCount` show no lint debt; otherwise say "no lint blockers")
- **`lintNotices[]`** (report any entries): non-blocking W19 findings, one `{id, file, message}` per project that has calendar-overflow session-log headings (a date like `2026-02-30` that is not on the calendar). The message lists every overflowing heading and its session-log file; the `file` field is that project's `design-history.md`. Report each entry's message verbatim. They never block the close or flip `ok`; the fix is to correct the date in that session-log heading.
- **`notices[]`** (report any entries): non-blocking messages, including the obsolete-field notice above when a payload sent `rootHot`. Report them alongside the checklist so whoever sent an older payload knows their root table field was ignored, not silently dropped. Two more notices come from the entry itself. One says the payload was in the old `sessionState`/`projectHot` form and was recorded as an entry. The other, `이미 기록된 원본이 있어 이번 payload의 요약은 반영되지 않았습니다`, means this close's entry had already been committed and was kept as it was, so this payload's summary and track text were not written: tell the user, and carry what still matters into the next close's summary.
- **`hostTagWarning`** (report it verbatim whenever present): this close was granted while a queued item shaped like a known host tag stayed neutral instead of retracting it. The host mints that shape, but a person can type or paste it too, so the close may not reflect a decision the user actually made. Print the string as it comes, including the undo instructions it carries, and print it once per run of the command. A close that keeps failing and gets retried is expected to print it again each time, because each run writes its own bytes; what must not happen is the same run repeating it, or a later, unrelated run inheriting it. It is **not** limited to `ok: true`: a run that committed the payload and then failed its marker write (`stage: 'marker-did-not-land'`) is exactly the case where it matters most, because those bytes are already in the vault's history. The undo instructions differ per run and name only what that run actually did, so never reword them and never swap in instructions you remember from another run. `--mark-session-closed` carries the same field, on the same terms, for a manual close.
- **marker written?** (required check): if `markerWritten: true`, report "session-close marker written"; if `markerWritten: false`, report "session-close marker NOT written (reason: `<markerSkipReason>`)" and do NOT declare the session "closed" or "complete". A missing marker means the Stop-chain is still open; recover per the `markerSkipReason` branch below.

**Check these three regardless of `ok`.** The result JSON carries them on a failed apply exactly as it does on a successful one: the apply script reports them outside its success branch on purpose. A park most often lands on exactly the run where `ok: false`, `stage: 'proposal-pending'`, since that is the run where the backlog just grew and a damaged artifact is most likely sitting next to the new one. A payload that never reaches `ok: true` still needs these three reported.

- **`restructureWaivers[]`** (report it if non-empty): an overwrite field carried `"restructure": true` on a field that really did drop `##` sections. Report each entry verbatim: the target file and the section names. **Nothing was let through.** The field is parked like any other section-loss trip and appears in `conflicts[]` too. This list is the claim, not the outcome, and it is set by the same party (a model composing the payload) the guard exists to check, so it must never pass silently.
- **`parkedTotal`** (report it if not `null` and > 0): the vault-wide count of parked write-proposal artifacts, not just what this close just parked (`proposals[]` above is only this run's own). It mixes pending, already-approved-but-unreconciled, and evidence-broken artifacts; the breakdown by state lives in doctor, not here. Tell the user, in one line, that N parked write-proposal artifact(s) exist vault-wide and that doctor shows what state each one is in: `/hypo:doctor` in Claude Code, or `hypomnema doctor` from a shell with the npm CLI (a plugin-only install has no `hypomnema` command). Do not repeat the per-id detail already covered by `proposals[]`. `null` means `.cache/proposals` itself could not be listed: report that as a measurement failure, never as "no parked proposals."
- **`parkedUnreadable`** (report it whenever non-empty, regardless of `parkedTotal`): filenames under `.cache/proposals` that exist as `.json` candidates but could not be parsed into an artifact (corrupt, permission-denied, or hand-edited into an unrecognizable shape). These are **not** counted in `parkedTotal` above; do not add the two numbers together. Tell the user, by name, which file(s) are unreadable and that doctor is where to inspect them (`/hypo:doctor` in Claude Code, or `hypomnema doctor` with the npm CLI); neither `proposal list` nor `proposal reconcile` can see these. This can be non-empty even when `parkedTotal` is `0`: a vault whose only proposal file is broken must never read as "nothing parked."

If `markerWritten: true`: ask: "The close checkpoint is recorded. Would you like to also run knowledge synthesis now, or stop here?"

**If `ok: false` with an authority `reason`, the close did not happen at all.** Nothing was written, nothing was committed. Do not report a partial close, and do not go looking for another way in.

- `session-id-required`: you omitted `--session-id`. Pass the main conversation's id and re-run.
- `transcript-unresolved`: the id resolved no transcript, so it is almost certainly not the main conversation's (a background-task or Agent-thread uuid, most often). Get the right one and re-run.
- `no-user-close-signal`: the transcript is this session's, but no close authority is in force. **Branch on `gateReason` before doing anything.** The three cases need three different responses, and treating them alike is what made this refusal look like it had a new cause every time it appeared.
  - `no-open`: the user genuinely never asked to close in wording the gate recognizes (e.g. "세션 마무리까지 진행해줘" falls outside the close-signal set). Re-running the same id changes nothing, because the transcript is unchanged. Confirm intent once with `AskUserQuestion`, header "세션", a single option labelled **세션 마무리** (설명: "이 세션을 마무리하고 close 마커를 기록"). If the user picks it, that answer lands in the transcript as a recognized close signal, so re-running the exact same command now applies **everything**: the writes, the commit, and the marker. If the user declines, the session stays open and nothing is written.
  - `no-new-open-since-resolution`: the user DID ask, and that request was already resolved by an earlier close. Asking again makes them answer a question they have already answered. Before you say anything, read `close_state` from `--check-session-close --session-id=<id>`. If it is `closed` (or `legacy-closed`), report that this session is already closed and stop; do not re-prompt. If it is `broken`, do **not** say the session is already closed: the earlier close's proof no longer holds (a commit it named was dropped by a reset or rebase, or the receipt and marker disagree). First run `--mark-session-closed --session-id=<id>`: when only the marker is missing, that recovers the close without asking the user anything. Only when it refuses with `prior-checkpoint-rewritten` (the commit its receipt named left the history) tell the user so and ask them to request the close again, then run `--apply-session-close` with a new payload. On the apply path, a resolution is recorded only once the session-close marker itself lands, so this reason cannot appear for a session whose apply was never marked closed. `/clear` is the one exception: it ends the session as surely as a close apply does, so `hypo-session-end.mjs` records the same resolution on a `/clear` directly, with no marker involved at all. So a session that never ran an apply, but was ended with `/clear`, can still carry a recorded resolution.
  - `transcript-rewrite-detected`: the transcript changed underneath the gate, so the earlier signal can no longer be attested. This is not a statement about what the user wants. Say what happened rather than asking them to repeat themselves, and let a human decide.

  In all three: do NOT touch the close-signal matcher itself, and do not hand-write the files to work around the refusal.

If the apply succeeded but `markerWritten: false`, do NOT say "session closed." Branch on `markerSkipReason`, which carries one of four values here. Three more (`marker-did-not-land`, `receipt-proof-mismatch`, `receipt-write-failed`) no longer reach this branch: when every other precondition cleared and the close still could not certify itself, that is a failure and not a policy withhold, so the result comes back `ok: false` with that value as `stage` and exit 1. Each has its own row in the stage table above.

- `compact-gate-not-ok`, `commit-failed: …`: surface the reason verbatim and address it (resolve the gate blocker, fix the git issue) before re-running. The JSON's `gateBlockers[]` names what the checkpoint gate refused on; read the cause there, not from `--check-session-close`, which judges the whole vault on a wider git axis and also lists other sessions' files that did not block this close. One `compact-gate-not-ok` blocker is an uncommitted file in the project folder being closed, which blocks even when this session has no record of writing it: commit it or revert it. **The re-run needs no fresh close phrase from the user for these two.** The resolution that spends a close signal is written only once the marker lands, so a run denied its marker at this stage leaves that signal unspent and the retry is authorized by the same one.
  **A `commit-failed:` retry can need a hand first.** The payload writes land before the commit does, so after a failed commit those files already match what the retry would write. The retry skips them as already current, which leaves them out of the commit it makes, and they stay uncommitted and keep blocking the marker. If a retry reports `commit-failed:` or `compact-gate-not-ok` a second time on the same close, or comes back with `stage: 'receipt-proof-mismatch'` naming those close files, stop retrying and look at `git status` in the vault: stage and commit the close files yourself, or ask the user to, then run the close again.
- `transcript-unresolved`: the marker writer could not resolve any transcript for this `--session-id` at all, so it never got as far as checking for a close signal. Passing the exact same id again changes nothing; get the main conversation's real session id (not a background-task or Agent-thread uuid) and re-run.
- `no-user-close-signal`: a transcript was found, but it carries no close signal the gate recognizes. This is the one branch where the re-run DOES need a fresh signal: confirm intent once with `AskUserQuestion` (the same 세션 마무리 flow described under Step 3's `no-user-close-signal` table above), then re-run only after the user confirms. **Read `markerGateReason` first.** It carries the same three values as the authority refusal's `gateReason` (`no-open`, `transcript-rewrite-detected`, `no-new-open-since-resolution`), and only `no-open` means the user never asked. It also names a queued item shaped like an unregistered host tag when one retracted the close, which is a stale allowlist rather than a change of mind: report that name to the user instead of asking them to close again.

If the user says stop, end here. Otherwise continue to Step 5.

---

## Step 5 — Surface synthesis candidates

Bundled scripts here run via `${CLAUDE_PLUGIN_ROOT}/scripts/`. To resolve that package root: if `${CLAUDE_PLUGIN_ROOT}` is already an absolute path, use it; otherwise read `pkgRoot` from `~/.claude/hypo-pkg.json` (only when non-empty and the target script exists under it); otherwise use the `hypo@hypomnema` (or legacy `hypomnema@hypomnema`) installPath in `~/.claude/plugins/installed_plugins.json`; if none resolve, stop and tell the user to run `hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install) or reinstall instead of guessing the cache layout.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs --min-group=2
```

Add `--hypo-dir="<path>"` only when the user specified a Hypomnema directory explicitly;
otherwise omit it.

An unrecognized flag exits 2 instead of being ignored.

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
node ${CLAUDE_PLUGIN_ROOT}/scripts/crystallize.mjs --check-session-close --session-id=<current-session-id>
```

Add `--hypo-dir="<path>"` only when the user specified a Hypomnema directory explicitly;
otherwise omit it.

An unrecognized flag exits 2 instead of being ignored.

Its verdict covers the whole vault (with `--session-id` for a session whose close was log-only, the project-close checks are skipped), so it can stay red on another session's uncommitted file after your own close has landed. Whether this session is closed is decided by the close checkpoint receipt: pass `--session-id=<id>` and read `close_state` (`closed` once the receipt is valid, or `legacy-closed` for an older marker written before receipts existed), not the vault-wide verdict. The Stop hook still checks this session's own project folder and has the final say.

Its required lines are this close's session entry (`projects/<project>/sessions/<date>-<close id>.md`), the session-log shard and `log.md`; the generated `session-state.md` and `hot.md` are not among them. It reports any file as `missing` or `stale`. For an actual close, prefer `--apply-session-close --payload=<path>` (Step 3): it bundles freshness and lint into one gate and is the documented dogfood path. `parseArgs` only accepts the `--payload=<path|->` spelling (a path, or `-` for stdin); a space-separated `--payload <path>` is rejected outright with exit 2, not silently dropped.

Add `--project=<slug>` to scope the check to one project (close status + lint scope) when recency picks the wrong one. This is a project-scoped diagnostic only: a green scoped result (JSON `scope: "project"`) attests that slug is close-complete, **not** that the whole vault is clean.

On the marker writer (`--mark-session-closed --project=<slug>`), `--project` names the project this session closed: it sets the marker's attribution slug and enters the close scope, so another session's incomplete close is reported as `close_debt` (a notice) instead of refusing your marker. Every other gate check stays global.
