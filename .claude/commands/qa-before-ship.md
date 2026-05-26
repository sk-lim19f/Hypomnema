---
description: Pre-release regression QA. Re-verify EVERY README/CHANGELOG-claimed behavior in real Claude/Codex sessions before tagging a release. Use before any `vX.Y.Z` tag or npm publish.
---

# /qa-before-ship — Pre-Release Regression QA

`/qa-features` covers the **incremental** surface a single PR touches. `/qa-before-ship` covers the **cumulative** surface — every behavior the released artifact will claim to support. New features can silently break old ones, so the entire README/CHANGELOG claim set is re-verified end-to-end against real CLI sessions before shipping.

## When to run

- Before any `git tag vX.Y.Z` on the OSS Hypomnema repo.
- Before any `npm publish` / `npm version` bump.
- Before publishing a release blog post (the blog inherits README claims).
- After a major refactor that crossed feature boundaries, even without a version bump.

## Scope contract

Target list = **union of**:
1. Every claim in current `README.md` + `README.ko.md` (commands listed, hooks listed, skills listed, flows described).
2. Every entry in CHANGELOG.md from the **previous tagged release** up to current `HEAD`.
3. Every slash command file under `commands/` (Claude) and `templates/extensions/commands/` (Codex mirror via `--codex`).
4. Every skill under `skills/` and every extension skill under `templates/extensions/skills/`.
5. Every hook in `hooks/` that injects observable behavior (`<system-reminder>`, `additionalContext`, file writes) — separated into Claude-Code hooks (`~/.claude/settings.json`) and Codex hooks (`~/.codex/hooks/` + registered in `~/.codex/settings.json` via `hypomnema --codex`).
6. Every shell-invocable CLI subcommand exposed by `bin: hypomnema` (default = `init`; explicit: `init`, `upgrade`, `doctor`, `uninstall`, `feedback-sync` — full set per `KNOWN_SUBCOMMANDS` in `scripts/init.mjs`).

Doc/code disagreement handling:
- Docs claim X, code does Y → engineering call which side to fix; row stays FAIL until reconciled.
- Code ships surface Z with no doc claim → either document, mark internal, or remove. Until then row is `doc-drift`, not silently passed.

## Worker CLI capability split

Use the table in `/qa-features` ("Worker CLI capability split"). Summary:
- Core `/hypo:*` slash commands → claude workers.
- Codex extension commands (`~/.codex/commands/`, populated by `hypomnema --codex`) → codex workers.
- Claude Code hooks → claude workers.
- Codex hooks (`~/.codex/hooks/` + `~/.codex/settings.json` after `hypomnema --codex`) → codex workers.
- Skills → claude workers for trigger; codex for static SKILL.md sanity.
- CLI subcommands + scripts → either.
- Rows neither CLI can host → `manual`.

## Environment isolation (PREFLIGHT — mandatory, same as /qa-features)

Build a fresh sandbox; install branch HEAD into it; pass `HOME`/`CODEX_HOME`/`HYPO_DIR` to every worker. See `/qa-features` "Environment isolation" for the script. Record `QA_SANDBOX`, `HEAD.sha`, `version`, plus the **previous tag's commit SHA** (`git describe --tags --abbrev=0` then `git rev-parse`) in matrix frontmatter so regression bisects have a known-good baseline.

## Execution protocol

1. **Build the matrix** — assemble the cumulative target list above. Each row: claim | source (file:line) | invocation surface | scenario | expected | prior-pass-run (if any).
2. **Save the matrix** to `~/hypomnema/projects/hypomnema/qa-runs/<YYYY-MM-DD>-pre-ship-v<X.Y.Z>.md` BEFORE running any worker — this is the contract.
3. **Preflight** — sandbox setup; record version pins in matrix frontmatter.
4. **Pick worker count/CLI** — `AskUserQuestion`. Pre-ship default: 3–4 workers, mixed claude/codex (regression risk highest under model-cross-check).
5. **Spawn via /teams — one call per agent-type group** — never direct CLI. Group matrix rows by required agent type (claude vs codex), then make exactly ONE `/teams N:<agent>` call per group so `spawn.sh` applies right→down topology within the right column (1st = right-split of main; 2nd+ = down-splits stacked). Multiple parallel `/teams 1:…` calls produce N side-by-side right panes — DO NOT do that. For a pre-ship run you typically have two spawn calls total (one codex team, one claude team). `spawn.sh` delivers the **same** `prompt.txt` to every worker in a team, so the prompt must include a `$TEAMS_WORKER_DIR`-based self-dispatch (basename ends in `worker-<N>`) — without it every worker runs every row. Each prompt MUST start with `export HOME=… CODEX_HOME=… HYPO_DIR=…` pointing into `$QA_SANDBOX`.
   ```
   /teams 3:codex  "export HOME=… CODEX_HOME=… HYPO_DIR=…; N=$(basename \"$TEAMS_WORKER_DIR\" | sed 's/worker-//'); case $N in 1) ROWS='1-7';; 2) ROWS='8-14';; 3) ROWS='15-20';; esac; run only your assigned rows in sandbox, capture output, verify vs 'expected'; PASS/FAIL + evidence."
   /teams 2:claude "export HOME=… HYPO_DIR=…; N=$(basename \"$TEAMS_WORKER_DIR\" | sed 's/worker-//'); case $N in 1) ROWS='21-28 (slash)';; 2) ROWS='29-34 (hooks)';; esac; run only your assigned rows."
   ```
6. **Collect & cross-check** — read every worker's `output.txt`. For PASS, spot-check evidence against the matrix. For FAIL, capture the regression delta (what worked before vs. now).
7. **Bisect regressions** — for each FAIL with a prior PASS (check prior `qa-runs/*.md`), `git log <prior-sha>..HEAD -- <file>` to narrow, identify the introducing commit, file a fix PR. Do not ship with unresolved regressions.
8. **Sign off** — append to the matrix file:
   ```
   ## Sign-off
   - Date: <ISO>
   - Tag: v<X.Y.Z>
   - HEAD: <sha>   Previous tag: <prev-tag>@<sha>
   - Rows: <N> total, <P> pass, <F> fail (must be 0 to ship), <M> manual, <D> doc-drift
   - Workers: <count> × <cli list>
   - Regressions found: <list or "none">
   - Resolved by: <PR list or "n/a">
   ```

## Difference vs `/qa-features`

| | `/qa-features` | `/qa-before-ship` |
|---|---|---|
| Trigger | PR with user-facing change | Release tag / npm publish |
| Scope | Only what this PR touches + drift | All claimed behaviors + all shipped surfaces, cumulative |
| Regression coverage | No (incremental) | Yes (cumulative, baselined against previous tag) |
| Output | `qa-runs/<date>.md` | `qa-runs/<date>-pre-ship-v<ver>.md` (with sign-off) |
| Must-pass to proceed | Recommended | **Mandatory — 0 FAILs to ship** |
| Sandbox isolation | Required | Required |

Run **both** in a release cycle: `/qa-features` on each PR as it lands, `/qa-before-ship` once before the tag. The pre-ship run will catch the case where two individually-green PRs interact badly.

## Anti-patterns

- ❌ Skipping pre-ship QA because "all PR-level QAs passed" — interactions are exactly what this catches.
- ❌ Building the matrix from code instead of docs — docs are the user contract; code surfaces with no claim are `doc-drift`, not silently passed.
- ❌ Running only one CLI when both have shipped surfaces — Codex extensions need codex workers; Claude hooks need claude workers.
- ❌ Reusing a stale matrix from a prior release — claims drift, rebuild every time.
- ❌ Shipping with FAILs marked "non-blocking" without an explicit user sign-off override.
- ❌ Skipping the sandbox preflight — without it, the QA may PASS on stale installed bits and FAIL on real users.
- ❌ Mutating the user's real `~/hypomnema` vault during ingest/crystallize/feedback rows.

## Output (last line of this command's response)

Single line JSON for machine consumption:

```json
{"qa_run":"<YYYY-MM-DD>-pre-ship-v<X.Y.Z>","tag":"v<X.Y.Z>","head":"<short-sha>","prev_tag":"<v...>","rows":<N>,"pass":<P>,"fail":<F>,"manual":<M>,"drift":<D>,"ship_verdict":"<GO|NO-GO>","matrix":"<absolute-path>","sandbox":"<absolute-path>","regressions":[<row-ids>],"resolved_by":[<PR # list>]}
```
