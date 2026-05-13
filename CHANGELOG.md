# Changelog

All notable changes to Hypomnema are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-13

Minor release. The headline is **observability**: the v1 → v2 thesis is
that Claude eventually reads, writes, and synthesizes the wiki without
being asked, but v1.0.1 was still trigger-driven. v1.1.0 doesn't claim
the autonomy gap is closed — instead it ships the **measurement** that
makes the auto-vs-manual ratio visible per session and per week, plus
the privacy gate that lets that measurement run without leaking
transcript content into the wiki.

Alongside that, this release cleans up a v1.0.x install-flow surprise:
`hypomnema upgrade --apply` is no longer a no-op (see Fixed).

### Upgrading from 1.0.1

```bash
npm install -g hypomnema@1.1.0       # or: npm update -g hypomnema
hypomnema upgrade --apply            # now actually runs upgrade.mjs
```

Plugin users: re-run `/plugin install hypomnema@hypomnema` (or restart
Claude Code) so the new slash commands and hooks get registered.

### Added

- **Observability pipeline.** `/hypo:audit` (`scripts/session-audit.mjs`)
  classifies every Claude session against the lookup → ingest → query →
  session-close pipeline and prints a per-session report.
  `scripts/weekly-report.mjs` aggregates the same signal into a weekly
  observability page. `SKILL.md` files now carry citation footers that
  the audit uses to verify wiki uptake. Nightly CI (`nightly.yml`)
  keeps the pipeline honest.
- **Session growth metrics.** Hooks surface per-session growth at
  session boundaries — pages touched, wikilinks added, session-close
  rate — scoped to `pages/` + `projects/` so unrelated repo activity
  doesn't pollute the score.
- **Privacy gate via `.hypoignore`.** The auto-commit and auto-stage
  hooks now honor `.hypoignore`; transcript classification cannot leak
  transcript text, URLs, tool input, or secret commands into the
  weekly report. Locked by a contract test in `tests/runner.mjs`.
- **`hypomnema <upgrade|doctor|uninstall>` subcommands.** Previously
  the bin entry silently dropped the positional verb and ran `init`;
  the documented forms had been advertised but never wired up.
  `hypomnema --help` now lists each command.
- **Community templates.**
  `.github/ISSUE_TEMPLATE/{bug_report.md,feature_request.md,config.yml}`,
  `.github/PULL_REQUEST_TEMPLATE.md`, and root `SECURITY.md` — the
  last with a scoped threat model (wiki vault + `~/.claude/`
  namespace) and a private-reporting channel.

### Fixed

- **`hypomnema upgrade --apply` actually upgrades.** The bin pointed at
  `scripts/init.mjs`, which silently ignored the positional verb and
  ran the init flow instead. Users got an init-shaped output and
  assumed the documented upgrade had run. It hadn't. Same story for
  `hypomnema doctor` and `hypomnema uninstall`. All four are now
  dispatched correctly from a tiny subcommand router at the top of
  `init.mjs`; bare `hypomnema` still equals `hypomnema init` for the
  documented Path-B onboarding command.
- **Audit correctness.** Counts nested `tool_use` entries (matches real
  transcript shape), scopes session growth to `pages/` + `projects/`
  (ignores root `README.md` / `hot.md`), validates `--week=<ISO>` with
  a clear error on malformed input, and defaults the fallback session
  scan to the wiki's encoded cwd. Opt-in to a full scan via
  `--fallback-all-projects`.
- **Package-integrity errors point at a next step.** Low-level errors
  thrown when `hooks/hooks.json` is missing or malformed
  (`Error: hooks/hooks.json must be a JSON object`, etc.) previously
  exited with no remediation. They now follow up with:
  *→ This indicates a corrupt or incomplete install. Re-install with
  `npm install -g hypomnema` (or re-install the Claude Code plugin).*
- **`.hypoignore` migration.** `hypomnema upgrade` appends `.cache/` to
  existing `.hypoignore` idempotently — no duplication if you run
  `upgrade --apply` twice.

### Documentation

- README honesty pass. v1.0.1's trigger model is documented explicitly
  (most behavior fires on `/hypo:*` commands, not autonomously). v1.1
  is framed as the *first step* on the v2 autonomous ramp: ship the
  observability score so the gap is visible to the user before the
  autonomy work lands. No "fully autonomous" claims in v1.1.
- README badges and Status section drop the hard-coded "51/51 tests"
  figure. The static shields.io badge is replaced with a live GitHub
  Actions CI status badge; the body line points readers at `npm test`.
  ARCHITECTURE.md and CONTRIBUTING.md follow the same pattern, so the
  count no longer rots every time a lane ships.
- ARCHITECTURE.md syncs the `Stop` hook order with `hypo-session-record`
  and updates the auto-stage / auto-commit rows to reflect
  `.hypoignore` filtering.

[1.1.0]: https://github.com/sk-lim19f/Hypomnema/releases/tag/v1.1.0

## [1.0.1] - 2026-05-12

Hotfix release. v1.0.0 quickstart told users to run `npm install -g hypomnema`
and then call `/hypo:init`, but the npm install never registered any
`/hypo:*` slash commands with Claude Code. v1.0.1 closes that gap, hardens
the install scripts against real edge cases caught by code review, and
cleans up first-run noise.

### Upgrading from 1.0.0

`npm` does not run anything in your wiki when it updates the global
package. Run **two** commands instead of one:

```bash
npm install -g hypomnema@1.0.1   # or: npm update -g hypomnema
hypomnema upgrade --apply        # syncs hooks, settings.json, and the
                                 # new slash commands into ~/.claude/
```

Inside Claude Code: `/plugin marketplace add sk-lim19f/Hypomnema` followed
by `/plugin install hypomnema@hypomnema` registers `/hypo:*` from the
plugin cache without touching `~/.claude/commands/`.

### Added
- Claude Code plugin marketplace manifest (`.claude-plugin/marketplace.json`).
- `init.mjs` now copies slash command files into `~/.claude/commands/hypo/`
  with per-file SHA tracking recorded in `~/.claude/hypo-pkg.json`. Future
  upgrades distinguish package content from user edits.
- `--no-commands` / `--force-commands` flags on `init.mjs` and
  `upgrade.mjs`; `--force-commands` on `uninstall.mjs`.
- `upgrade.mjs` reconciles orphaned recorded commands — drops the entry,
  deletes the file on disk only when its SHA still matches the recorded
  value, otherwise keeps the user-modified file.
- `scripts/lib/pkg-json.mjs`: atomic temp-file + rename writes for
  `hypo-pkg.json`; corrupt files are preserved as `.corrupt-<ts>.json`.

### Fixed
- `lint.mjs` was emitting 11 false-positive warnings on a freshly initialised
  wiki — placeholder wikilinks inside HTML comments, fenced code blocks, and
  inline code spans were all treated as broken links. `extractWikilinks` now
  preprocesses content through `stripNonWikilinkRegions` (line-anchored
  ``` / ~~~ fences, double/single backtick spans, HTML comments) before the
  regex runs. Real broken wikilinks still get caught.
- `templates/projects/_template/index.md` wraps the `<project-name>`
  placeholders in an HTML comment so they document the expected format
  without triggering lint.
- `scripts/ingest.mjs` docstring and first banner line now make explicit
  that the CLI helper is read-only — it lists pending sources; synthesis
  is performed by `/hypo:ingest` inside Claude.
- `uninstall.mjs` previously deleted every tracked `*.md` file regardless
  of whether the user had modified it. It now gates each removal on a SHA
  match against the recorded value, preserves user-modified files (and the
  metadata that tracks them) unless `--force-commands` is passed, and
  refuses to follow symlinks.
- Race-condition hardening across `init`/`upgrade`/`uninstall`: file writes
  use temp-file + rename; SHA checks are re-verified immediately before
  overwriting so an edit that lands between check and apply is preserved;
  destinations that are symlinks or non-regular files are refused before
  read or write.

### Documentation
- README quickstart rewritten in both languages to document the two
  supported install paths (plugin and npm CLI), how slash commands get
  registered under each, and how upgrades reconcile against user edits.
- Wiki-path resolver table corrected to match `scripts/lib/hypo-root.mjs`:
  `HYPO_DIR` → fixed home-relative candidates → `~/hypomnema`.
- `/hypo:ingest` row clarified: CLI helper lists, Claude synthesises.

[1.0.1]: https://github.com/sk-lim19f/Hypomnema/releases/tag/v1.0.1

## [1.0.0] - 2026-05-10

First public release.

### Added
- `hypomnema` CLI with `init` / `upgrade` / `doctor` commands.
- Slash commands: `/hypo:lookup`, `/hypo:lint`, `/hypo:upgrade`, `/hypo:verify`.
- Hooks: SessionStart project resume, session-close gate, personal-check, wiki auto-commit, lint enforcement, PreCompact safety net.
- Skills: `crystallize`, `session-close`, `wiki-lookup`, `verify`.
- Templates: `SCHEMA.md`, `hypo-guide.md`, `hypo-config.md`, `hypo-help.md`.
- Privacy mode (`init` privacy boundary) and `.hypoignore` enforcement.
- Schema v1.0 (page types, frontmatter contract, project layout).

### Notes
- Schema version (`templates/SCHEMA.md`) is tracked independently from package version.
- Upgrade path from pre-1.0 installations: run `/hypo:upgrade`.

[1.0.0]: https://github.com/sk-lim19f/Hypomnema/releases/tag/v1.0.0
