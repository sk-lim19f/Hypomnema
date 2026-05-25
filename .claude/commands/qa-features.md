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
```

Each worker prompt MUST export `HOME="$QA_SANDBOX/claude-home"` (claude workers) or `CODEX_HOME="$QA_SANDBOX/codex-home"` (codex workers) AND `HYPO_DIR="$QA_SANDBOX/vault"` so installs/hooks land in the sandbox, not the user's real home.

If a scenario explicitly tests "real install side effects on the user's machine" (rare), mark it `requires-real-home` in the matrix and warn the user before running.

## Execution protocol

1. **Inventory** — read `README.md` + `README.ko.md` + the current unreleased CHANGELOG section + the files changed by this PR (`git diff --name-only origin/main...HEAD`). Extract every claim ("run `hypo:foo`", "the hook will...", "this skill does X") AND every shipped surface that has no matching claim (doc-drift). Each becomes a matrix row, tagged with invocation surface (`slash` / `codex-cmd` / `claude-hook` / `codex-hook` / `skill` / `cli` / `script` / `install`).
2. **Preflight** — run the sandbox setup above. Record `QA_SANDBOX`, `HEAD.sha`, `version` in the matrix file frontmatter.
3. **Route by surface** — apply the capability table. Any row whose surface neither CLI can host gets `manual` and is surfaced to the user.
4. **Pick worker stack** — `AskUserQuestion`: how many workers, claude/codex mix (suggest a mix covering every surface in the row set).
5. **Spawn via /teams** — never call `codex` or `claude` CLI directly. Pass `HOME`/`CODEX_HOME`/`HYPO_DIR` via the worker prompt's env preamble. Example:
   ```
   /teams 1:claude "export HOME=/tmp/hypomnema-qa-…/claude-home HYPO_DIR=/tmp/hypomnema-qa-…/vault; run /hypo:init; verify pages/index.md, hot.md exist under $HYPO_DIR. PASS/FAIL with file paths."
   /teams 2:codex  "export HOME=… CODEX_HOME=… HYPO_DIR=…; node $REPO_ROOT/scripts/lint.mjs against the sandbox vault; assert exit code 0 and report broken-wikilink count vs README claim."
   ```
6. **One scenario per row** — each row gets its own worker prompt with a single scenario, expected outcome, and evidence requirement (file path / grep / exit code).
7. **Collect** — block on Stop-hook markers, read `output.txt` per worker, parse PASS/FAIL, capture evidence excerpts.
8. **Log** — write the run to `~/hypomnema/projects/hypomnema/qa-runs/<YYYY-MM-DD>.md` with table: row | feature | surface | scenario | worker | verdict | evidence | follow-up.
9. **Triage** — every FAIL → fix PR (code or docs). Never close a QA run with FAILs unresolved or `manual` rows un-checked.

## Evidence requirements (per row)

- **Command behavior**: actual command output excerpt + exit code + filesystem effect (file created/modified path inside `$QA_SANDBOX/vault`).
- **Hook behavior**: real session transcript excerpt showing the hook's injected `<system-reminder>` or `additionalContext`.
- **Doc claim**: side-by-side — doc quote vs. observed behavior.
- **Doc-drift row**: explicit note "no doc claim found for this surface; routing as drift evidence".

A "I ran it and it looked fine" verdict is not evidence. Quote the raw output.

## Anti-patterns

- ❌ Calling `codex` or `claude` CLI directly from this command. Always `/teams`.
- ❌ Trusting worker self-reported PASS without reading `output.txt`.
- ❌ Skipping rows because "obvious it works" — that's exactly when regressions hide.
- ❌ Running QA after merge. Run before, on the feature branch.
- ❌ Letting QA log live only in chat. Write the `qa-runs/<date>.md` row durably.
- ❌ Skipping preflight sandbox — workers will silently test a stale globally-installed plugin and the matrix will lie.
- ❌ Running install/hook rows in the user's real `$HOME` / `~/hypomnema` vault. Use `$QA_SANDBOX`.

## Output (last line of this command's response)

Single line JSON for machine consumption:

```json
{"qa_run":"<YYYY-MM-DD>","head":"<short-sha>","rows":<N>,"pass":<P>,"fail":<F>,"manual":<M>,"drift":<D>,"log":"<absolute-path>","sandbox":"<absolute-path>","followups":[<PR # list or empty>]}
```
