# Changelog

All notable changes to Hypomnema are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
