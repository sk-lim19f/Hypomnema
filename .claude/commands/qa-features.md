---
description: Run real-session QA on Hypomnema features (commands, hooks, skills) using actual claude/codex CLI workers via /teams. Use whenever a feature is added or modified.
---

# /qa-features — Real-Session Feature QA

When Hypomnema adds or modifies a user-facing feature (slash command, hook, skill, doc-claimed behavior), verify it by opening **real Claude or Codex CLI sessions** and exercising the feature end-to-end. Unit tests in `tests/runner.mjs` are necessary but not sufficient — they don't catch wiring bugs in command markdown, hook injection, plugin install, or actual LLM behavior under the documented invocation.

## When to run

- Any PR that touches `commands/`, `hooks/`, `skills/`, `scripts/init.mjs`, `scripts/lint.mjs`, `scripts/feedback-sync.mjs`, `templates/`, `README.md`, `README.ko.md`, or README-documented behavior.
- Before tagging a release (covered features listed in CHANGELOG.md must each have a green QA row — that's `/qa-before-ship`'s job).
- Whenever README/CHANGELOG describes a new behavior — that behavior is the QA contract.

## Scope contract

The QA target list is the **union of**:
1. Every claim in `README.md` and `README.ko.md` (commands, hooks, skills, flows).
2. Every entry in CHANGELOG.md for the unreleased / in-progress version.
3. Every user-facing surface this PR added or modified, **even if undocumented** — surfaces with no matching doc claim are flagged as `doc-drift` rows in the matrix.

Doc/code disagreement handling:
- Doc claims behavior X, code does Y → **fix one of them** (which is the engineering call). QA row is FAIL until reconciled.
- Code ships surface Z with no doc claim → either document it, mark it internal/private, or remove it. Until then row is `doc-drift`, not silently passed.

## Worker CLI capability split (CRITICAL)

`claude` and `codex` CLI sessions have **different invocation surfaces**. Route each scenario correctly or the QA will false-fail on capability, not on regression. Hypomnema mirrors a subset of artifacts to `~/.codex/` when installed with `--codex`, so Codex coverage is non-trivial — pin to the table, don't assume.

| Surface | `claude` worker | `codex` worker |
|---|---|---|
| Core Hypomnema **slash commands** (`/hypo:init`, `/hypo:query`, `/hypo:lint`, …) installed to `~/.claude/commands/hypo/` | ✅ resolves | ❌ no `/hypo:*` registry — skip |
| **Codex extension commands** mirrored to `~/.codex/commands/` (via `hypomnema --codex` of files under `templates/extensions/commands/`) | ❌ not installed there | ✅ via codex's own command surface |
| **Claude Code hooks** registered in `~/.claude/settings.json` (`hypo-first-prompt`, `Stop`, `PreCompact`, `auto-resume`, etc.) | ✅ fire automatically in-session | ❌ Claude Code only |
| **Codex hooks** mirrored to `~/.codex/hooks/` + registered in `~/.codex/settings.json` (via `hypomnema --codex`) | ❌ not registered there | ✅ fire in codex sessions (Stop event, etc.) |
| Skill SKILL.md auto-trigger (description keyword match) | ✅ Claude Code skill registry | ⚠ static read only (codex has no equivalent Skill registry) |
| Shell-invocable CLI subcommands (`hypomnema`, `hypomnema init`, `upgrade`, `doctor`, `uninstall`, `feedback-sync`) | ✅ via Bash | ✅ via Bash |
| Direct script invocation (`node scripts/lint.mjs`, `feedback-sync.mjs`, `verify.mjs`, `graph.mjs`, `weekly-report.mjs`, etc.) | ✅ via Bash | ✅ via Bash |
| Plugin install / settings.json merge | ✅ Claude Code is the install target | ⚠ partial — only the `--codex` mirror side |

Default routing:
- **Claude slash commands + Claude hooks** → claude workers only.
- **Codex commands + Codex hooks** (after `hypomnema --codex` install) → codex workers only.
- **CLI subcommands + scripts** → either CLI; prefer codex when claude is busy with slash/hook rows.
- **Skill auto-trigger** → claude worker; codex worker for SKILL.md content sanity only.

## Environment isolation (PREFLIGHT — mandatory)

Workers MUST exercise the **current branch's HEAD**, not whatever the user happens to have installed globally. Two contamination sources to defeat:

1. **Stale installed plugin** — `~/.claude/commands/hypo/*.md`, hooks, settings may be from a prior `hypomnema upgrade --apply` and lag behind the branch under test.
2. **Live wiki pollution** — running `hypo:ingest` / `hypo:crystallize` / `hypo:feedback` against `~/hypomnema` mutates the user's real vault.

Preflight steps (run before any worker spawn):

```sh
# 1. Snapshot current state for rollback evidence
QA_RUN_ID=$(date -u +%Y%m%d-%H%M%S)
QA_SANDBOX=$(mktemp -d "/tmp/hypomnema-qa-${QA_RUN_ID}-XXXX")
mkdir -p "$QA_SANDBOX/vault" "$QA_SANDBOX/claude-home" "$QA_SANDBOX/codex-home"

# 2. Install branch HEAD into the sandbox — CRITICAL: set HOME so the install
# writes ~/.claude and ~/.codex INTO the sandbox, not the user's real home.
# Also pass --codex so Codex-side hooks/commands are mirrored for codex workers.
HOME="$QA_SANDBOX/claude-home" \
  node "$REPO_ROOT/scripts/init.mjs" \
    --hypo-dir="$QA_SANDBOX/vault" \
    --codex \
    --no-git-init --no-shell

# Codex uses CODEX_HOME if set, else falls back to $HOME/.codex. To keep the
# codex install isolated to a separate dir, symlink (or copy) the sandbox's
# ~/.codex into $QA_SANDBOX/codex-home before exporting CODEX_HOME to workers:
ln -sfn "$QA_SANDBOX/claude-home/.codex" "$QA_SANDBOX/codex-home"

# 3. Record the version pin
git -C "$REPO_ROOT" rev-parse HEAD > "$QA_SANDBOX/HEAD.sha"
node -e 'console.log(require("'"$REPO_ROOT"'/package.json").version)' > "$QA_SANDBOX/version"

# 4. ASSERT the sandbox actually runs branch HEAD (not a stale registry/global copy).
# Past dogfood produced ~4/5 false-positive FAILs partly because the install
# pointed at an older copy of hypomnema instead of the branch's local code.
# `scripts/init.mjs` writes ~/.claude/hypo-pkg.json with { pkgVersion, pkgRoot }
# — those two fields ARE the source of truth for "what did this install bind to".
HYPO_PKG_JSON="$QA_SANDBOX/claude-home/.claude/hypo-pkg.json"
SANDBOX_VERSION=$(node -p "require('$HYPO_PKG_JSON').pkgVersion" 2>/dev/null || echo MISSING)
SANDBOX_PKG_ROOT=$(node -p "require('$HYPO_PKG_JSON').pkgRoot" 2>/dev/null || echo MISSING)
HEAD_VERSION=$(cat "$QA_SANDBOX/version")
if [ "$SANDBOX_VERSION" != "$HEAD_VERSION" ]; then
  echo "PREFLIGHT FAIL: sandbox pkgVersion=$SANDBOX_VERSION but HEAD version=$HEAD_VERSION — install bound to a stale copy. ABORT."
  exit 1
fi
if [ "$SANDBOX_PKG_ROOT" != "$REPO_ROOT" ]; then
  echo "PREFLIGHT FAIL: sandbox pkgRoot=$SANDBOX_PKG_ROOT but expected REPO_ROOT=$REPO_ROOT — install bound to a different working tree. ABORT."
  exit 1
fi
# Optional sha cross-check: pkgRoot's git HEAD must match the recorded sha.
SANDBOX_HEAD_SHA=$(git -C "$SANDBOX_PKG_ROOT" rev-parse HEAD 2>/dev/null || echo MISSING)
[ "$SANDBOX_HEAD_SHA" != "$(cat "$QA_SANDBOX/HEAD.sha")" ] && echo "WARN: sandbox pkgRoot HEAD sha differs from recorded HEAD.sha"
```

Each worker prompt MUST export `CODEX_HOME="$QA_SANDBOX/codex-home"` (codex workers) AND `HYPO_DIR="$QA_SANDBOX/vault"` so installs/hooks land in the sandbox, not the user's real home. **Exception — `claude` slash / skill rows cannot be HOME-isolated this way** (auth is HOME-scoped; env-via-prompt is swallowed by headless `-p`); see the dedicated subsection just below before routing any claude row.

If a scenario explicitly tests "real install side effects on the user's machine" (rare), mark it `requires-real-home` in the matrix and warn the user before running.

### ⚠ claude / skill rows cannot be HOME-sandbox-isolated (auth is HOME-scoped)

The preflight's `HOME="$QA_SANDBOX/claude-home"` isolation **works for codex / CLI / script rows but NOT for `claude` slash-command or skill rows**. Two hard constraints, both observed in the 2026-06-07 dogfood:

1. **`claude` auth is HOME-scoped.** A `claude` process launched with `HOME=$QA_SANDBOX/...` has no login session → it exits with `Not logged in · Please run /login` and runs nothing. Copying the real `~/.claude/.credentials.json` (or `~/.claude.json`) into the sandbox is the only way to give it auth — and that is **credential scavenging**; the Claude Code auto-mode classifier blocks it, correctly. So sandbox-HOME + claude is a dead end.
2. **env-via-prompt does not set process env for headless `-p` agents.** `spawn.sh` launches claude/gemini as `<agent> -p "$(cat prompt.txt)"`, so an `export HOME=…` line placed in the worker *prompt* becomes prompt **text**, never shell env. (codex TUI "works around" this only because the model interactively runs the `export` as a Bash tool call — but even then it cannot change the already-started process's HOME, which is what command/skill resolution binds to.)

**Therefore, route `claude` slash / skill rows by one of these three strategies (pick per row, record which in the matrix):**

- **(A) inline-command (preferred for prompt-layer features).** Do not depend on the installed copy at all: paste the **HEAD version of the command/skill spec** (e.g. the `Step 1a` section of `commands/crystallize.md`) verbatim into the worker prompt, give it the scenario, and instruct **no file/script writes** (pure reasoning — "output what you would surface"). This tests the *feature behavior* (does the prompt text drive the LLM to do X?) decoupled from install location, needs no auth juggling, and cannot pollute the real vault. Verify `~/hypomnema` is `git status` clean afterward regardless.
- **(B) real-HOME + upgrade-first + vault-only isolation.** Run the claude worker with the **real (logged-in) HOME**, but FIRST sync the install to HEAD (`hypomnema upgrade --apply`, or re-`init` the real home) — otherwise the worker tests a **stale** installed command (the post-merge real install lags until upgrade runs; the stale-install guard, clause C, exists to catch exactly this). Isolate only the **vault** via `HYPO_DIR=$QA_SANDBOX/vault` (vault access needs no auth), and prefer no-write/sandbox-vault scenarios. Mark the row `requires-real-home`.
- **(C) drop the row** — if neither (A) nor (B) fits, move the claude row to `manual` and surface it to the user; do not fake a sandbox pass.

`codex` / CLI / script rows are unaffected — keep using sandbox `CODEX_HOME` / `HOME` isolation as written above.

### Headless `-p` output capture (fixed 2026-06-07)

`spawn.sh` previously launched `claude -p` / `gemini -p` as `<agent> -p "$(cat prompt)"` and relied on the codex-style Stop-hook `cmux read-screen` scrape to fill `output.txt`. That scrape only captured the launch line for headless `-p` (the answer goes to stdout, not the rendered TUI). **Fixed**: `spawn_headless_cmd` now tees `-p` stdout/stderr straight to `output.txt` and writes the `done` marker inline (and does not export `TEAMS_WORKER_DIR`, so the Stop hook no-ops and cannot clobber the file). Result collection reads `output.txt` for `-p` agents the same as for codex. If you see a claude/gemini worker's `output.txt` holding only the shell launch line, you are on a pre-fix `spawn.sh` — update the teams skill.

## Execution protocol

1. **Inventory** — read `README.md` + `README.ko.md` + the current unreleased CHANGELOG section + the files changed by this PR (`git diff --name-only origin/main...HEAD`). Extract every claim ("run `hypo:foo`", "the hook will...", "this skill does X") AND every shipped surface that has no matching claim (doc-drift). Each becomes a matrix row, tagged with invocation surface (`slash` / `codex-cmd` / `claude-hook` / `codex-hook` / `skill` / `cli` / `script` / `install`).
2. **Preflight** — run the sandbox setup above. Record `QA_SANDBOX`, `HEAD.sha`, `version` in the matrix file frontmatter.
3. **Route by surface** — apply the capability table. Any row whose surface neither CLI can host gets `manual` and is surfaced to the user.
4. **Pick worker stack** — `AskUserQuestion`: how many workers, claude/codex mix (suggest a mix covering every surface in the row set).
5. **Spawn via /teams — one call per agent-type group** — never call `codex` or `claude` CLI directly. Group rows by required agent type (claude vs codex), then make exactly ONE `/teams N:<agent>` call per group so `spawn.sh` applies its right→down topology within the right column (1st worker = right-split of main; 2nd+ = down-splits stacked under the 1st).

   **Anti-pattern**: making three separate `/teams 1:codex` / `/teams 1:claude` / `/teams 1:claude` calls — each call splits the main pane to the right independently, producing N side-by-side right panes instead of the intended right→down stack. The skill output becomes visually unreadable and breaks the user's expectation of teams topology.

   For a typical QA run with both CLIs, you end up with at most **two** spawn calls (one codex team, one claude team). Within each team, decompose row sets across the N workers in the prompt itself (e.g., "Worker 1: rows 1–3. Worker 2: rows 4–6.").

   **`spawn.sh` delivers the same prompt to every worker in the team** (single `prompt.txt` copied into `$TEAM_DIR/`, every worker runs `codex "$(cat …/prompt.txt)"` or equivalent). Workers therefore need an explicit self-identification rule in the prompt body. The index source differs by agent type:
   - **codex** workers: read the index from `$TEAMS_WORKER_DIR` (basename ends in `worker-<N>`).
   - **claude / gemini (`-p`)** workers: read it from **`$TEAMS_WORKER_INDEX`** — `spawn.sh` withholds `$TEAMS_WORKER_DIR` for headless agents (so the capture-clobbering Stop hook no-ops; see the headless-capture note above) and exports `$TEAMS_WORKER_INDEX=<N>` instead.

   Instruct each worker to execute only the rows assigned to its `<N>`. Without that rule the row decomposition is unenforced and every worker runs every row.

   **Env handling differs by agent type** (see the headless-`-p` constraint above):
   - **codex** workers interactively execute their prompt's bash, so an `export CODEX_HOME=… HYPO_DIR=… HEAD_VERSION=… REPO_ROOT=…` preamble in the prompt DOES take effect for the rows they then run. Index via `$TEAMS_WORKER_DIR`. Clause C applies.
   - **claude** workers run headless `claude -p` — a prompt `export HOME=…` is **inert** (prompt text, and HOME can't be re-bound after process start). Do NOT rely on it. Route claude rows by strategy A (inline-command, no install dependency) or B (real-HOME + `upgrade --apply` first + `HYPO_DIR` vault-only); index via `$TEAMS_WORKER_INDEX`.

   Example for a 5-row codex group + a claude group (strategy A inline-command):
   ```
   /teams 2:codex  "export CODEX_HOME=… HYPO_DIR=… HEAD_VERSION=… REPO_ROOT=…; N=$(basename \"$TEAMS_WORKER_DIR\" | sed 's/worker-//'); case $N in 1) ROWS='1-3 (CLI subcommands)';; 2) ROWS='4-5 (scripts)';; esac; run clause-C stale-install check first, then your assigned rows; capture exit code + output + filesystem effect; PASS/FAIL with evidence."
   /teams 2:claude "N=$TEAMS_WORKER_INDEX; case $N in 1) ROWS='slash rows 6-8';; 2) ROWS='slash rows 9-11';; esac; the prompt INLINES the HEAD command/skill spec under test (strategy A) — verify the inlined spec matches branch HEAD, do NOT touch the installed copy, run your rows with no file/vault writes, PASS/FAIL with quoted evidence."
   ```
6. **One scenario per row** — each row must be assigned explicitly inside the team prompt (via the index dispatch above: `$TEAMS_WORKER_DIR` for codex, `$TEAMS_WORKER_INDEX` for claude/gemini) with scenario, expected outcome, and evidence requirement (file path / grep / exit code). Worker prompts MUST also include the **mandatory clauses** below (placeholder rule + exact-quote rule + stale-install rule + ack-echo) — workers without these clauses produced 4/5 false-positive FAILs in the first dogfood run. **Exception:** clause C (stale-install detection) is for rows that exercise the *installed* copy (codex/CLI/script rows, claude strategy B). For claude **strategy A (inline-command)** rows, clause C does not apply — the row deliberately bypasses the install; replace it with a check that the **inlined spec matches branch HEAD** (e.g. the worker confirms the pasted section is verbatim from the repo file at HEAD).
7. **Collect** — block on the `done` markers (codex writes them via its Stop hook; headless `-p` agents write them inline — see the headless-capture note), read `output.txt` per worker, parse PASS/FAIL, capture evidence excerpts.
8. **Orchestrator re-verification (MANDATORY before logging)** — for every FAIL the workers reported, the orchestrating Claude MUST live-re-run the failing scenario against a **fresh HEAD-version sandbox** (created by re-running the preflight against the current working tree, NOT against the user's real `~/.claude` / `~/.codex` / `~/hypomnema`) before recording it as a real defect.
   - **CLI / script rows** (`hypomnema doctor`, `node scripts/lint.mjs`, etc.) — run directly against the working tree from `$REPO_ROOT`; if the row passes, mark `WORKER_FALSE_POSITIVE`.
   - **Slash / hook / install rows** (`/hypo:resume`, `hypo-first-prompt`, …) — bind a second sandbox via the same preflight, re-execute the scenario there, compare.
   - **Intentional-failure rows** — if the matrix `expected` field says the scenario MUST exit non-zero (e.g., `feedback-sync --strict` with no target file), a non-zero result is PASS, not FAIL. Worker FAILs claiming "ungraceful error" against such rows are downgraded to `WORKER_EXPECTATION_MISMATCH`; fix the matrix `expected` field if it was ambiguous.
   - **Doc-drift FAILs** — re-grep the cited `README.md:L<n>` / `CHANGELOG.md:L<n>` to confirm the worker's quote is verbatim. If the cited line doesn't say what the worker claimed (paraphrase, hallucination), mark `WORKER_QUOTE_MISMATCH`.

   Only confirmed-on-fresh-HEAD FAILs become fix-PR follow-ups. This step is non-negotiable — skipping it produces the dogfood-#1 backlog of ghost defects.
9. **Log** — write the run to `~/hypomnema/projects/hypomnema/qa-runs/<YYYY-MM-DD>.md` with table: `row | feature | surface | scenario | expected | worker | verdict | evidence | follow-up`. The **`expected`** column is mandatory — record the exact expected outcome (exit 0 / exit non-zero / specific output / filesystem effect). Without it, step 8 cannot classify intentional-failure rows as `WORKER_EXPECTATION_MISMATCH`. Include a separate "False positives caught at orchestrator gate" section listing each downgrade (`WORKER_FALSE_POSITIVE` / `WORKER_EXPECTATION_MISMATCH` / `WORKER_QUOTE_MISMATCH`) with the reason.
10. **Triage** — every confirmed FAIL → fix PR (code or docs). Never close a QA run with confirmed FAILs unresolved or `manual` rows un-checked.

### Worker prompt template — mandatory clauses

Every worker prompt for this skill MUST embed these three clauses (in addition to env preamble + row dispatch). They are the operational countermeasures against the three false-positive classes observed in dogfood #1:

```
# (A) Placeholder substitution rule
Doc syntax like `--project=<name>`, `--hypo-dir=<path>`, `<sha>` uses angle-bracket
METAVARIABLES — they are NOT literal arguments. Replace `<name>` with a real
project slug from the sandbox, replace `<path>` with a real path, or omit the
flag entirely. Never type `--project=name` or `--project=slug` thinking that's
what the doc said to do.

# (B) Doc-vs-code drift evidence rule
When claiming a doc-vs-code drift FAIL, quote the EXACT line from README/
CHANGELOG (`README.md:L<n>` or `README.ko.md:L<n>`) and the EXACT observed
output. Words like "implies", "suggests", "the doc should mean" are NOT
evidence — they are hallucination. If you cannot quote the doc line that
contradicts the observed behavior, downgrade the verdict from FAIL to
"drift candidate" and move on; do not file it as a defect.

# (C) Stale-install detection rule
Before running any scenario, confirm the sandbox you were handed actually binds
to branch HEAD. The preflight wrote $HOME/.claude/hypo-pkg.json with pkgVersion
+ pkgRoot — assert both against HEAD_VERSION and REPO_ROOT (which the env
preamble below also exports). Use real shell tests (printing == does NOT
compare):
  GOT_VER=$(node -p "require(process.env.HOME + '/.claude/hypo-pkg.json').pkgVersion")
  GOT_ROOT=$(node -p "require(process.env.HOME + '/.claude/hypo-pkg.json').pkgRoot")
  [ "$GOT_VER" = "$HEAD_VERSION" ] || { echo "STALE_INSTALL_ABORT: pkgVersion=$GOT_VER != $HEAD_VERSION"; exit 1; }
  [ "$GOT_ROOT" = "$REPO_ROOT"    ] || { echo "STALE_INSTALL_ABORT: pkgRoot=$GOT_ROOT != $REPO_ROOT"; exit 1; }
If either disagrees → STOP, do not generate FAILs.
The env preamble (step 5 example above) must therefore export BOTH
HEAD_VERSION and REPO_ROOT in addition to HOME/CODEX_HOME/HYPO_DIR.

# (Worker self-check echo — MANDATORY)
Before running any scenario, echo this exact line to stdout so the orchestrator
can confirm the guard clauses reached you:
  "guard clauses acknowledged: A/B/C"
The orchestrator greps output.txt for this line. Absence = the prompt template
did not reach you and your FAILs will be treated as VERDICT_UNCLEAR.
```

The orchestrator MUST grep each worker's `output.txt` for the literal `guard clauses acknowledged: A/B/C` line before parsing verdicts. The clauses themselves are in the team's `prompt.txt` (the spawn-time file, not the worker's answer log), so do not grep `output.txt` for the clause body — grep for the acknowledgement echo instead.

## Evidence requirements (per row)

- **Command behavior**: actual command output excerpt + exit code + filesystem effect (file created/modified path inside `$QA_SANDBOX/vault`).
- **Hook behavior**: real session transcript excerpt showing the hook's injected `<system-reminder>` or `additionalContext`.
- **Doc claim**: side-by-side — doc quote vs. observed behavior.
- **Doc-drift row**: explicit note "no doc claim found for this surface; routing as drift evidence".

A "I ran it and it looked fine" verdict is not evidence. Quote the raw output.

**Doc-drift FAILs require exact citation**: worker may not claim "README implies X" / "README should say Y" — they must paste the literal `README.md:L<n>` line that contradicts the observed output. Orchestrator-side grep verifies the cited line really exists at that location before accepting the FAIL.

## Anti-patterns

- ❌ Calling `codex` or `claude` CLI directly from this command. Always `/teams`.
- ❌ Trusting worker self-reported PASS without reading `output.txt`.
- ❌ Trusting worker self-reported FAIL without orchestrator-side HEAD re-verification (step 8).
- ❌ Substituting `<name>`, `<path>`, `<sha>` from docs as literal CLI args — these are metavariables, not values.
- ❌ Filing a fix PR based on a worker FAIL that was never re-checked against HEAD.
- ❌ Skipping rows because "obvious it works" — that's exactly when regressions hide.
- ❌ Running QA after merge. Run before, on the feature branch.
- ❌ Letting QA log live only in chat. Write the `qa-runs/<date>.md` row durably.
- ❌ Skipping preflight sandbox — workers will silently test a stale globally-installed plugin and the matrix will lie.
- ❌ Skipping the preflight sandbox-version assertion — past dogfood produced ghost defects because `npm install` resolved a published version older than HEAD.
- ❌ Running install/hook rows in the user's real `$HOME` / `~/hypomnema` vault. Use `$QA_SANDBOX`.

## Output (last line of this command's response)

Single line JSON for machine consumption:

```json
{"qa_run":"<YYYY-MM-DD>","head":"<short-sha>","rows":<N>,"pass":<P>,"fail":<F>,"manual":<M>,"drift":<D>,"log":"<absolute-path>","sandbox":"<absolute-path>","followups":[<PR # list or empty>]}
```
