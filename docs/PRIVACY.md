# Privacy Guide

Hypomnema stores all wiki data **locally on your machine**. No content is sent to any external service by the package itself.

---

## What is stored and where

| Location | Contents | Notes |
|----------|----------|-------|
| `<hypo-root>/pages/` | Synthesized knowledge pages | Written by Claude during ingest/crystallize |
| `<hypo-root>/projects/` | Project artifacts, session logs, ADRs | Written by Claude during session close |
| `<hypo-root>/sources/` | Raw ingested source documents | Saved as-is; never edited |
| `<hypo-root>/log.md` | Append-only activity log | Dates, page slugs, brief descriptions |
| `<hypo-root>/hot.md` | Active project pointer table | Project names and dates only |
| `<hypo-root>/hypo-config.md` | Wiki root marker + user settings | Includes privacy mode |
| `~/.claude/hooks/` | Hook scripts | JavaScript files; run locally by Claude Code |
| `~/.claude/settings.json` | Hook registrations | Command strings pointing to local hook files |

---

## Privacy modes

Set via `/hypo:init` or by editing `privacy:` in `hypo-config.md`.

### `personal` (default)
Standard mode for private local use. No restrictions beyond `.hypoignore`.

### `shared`
Adds ignore patterns for personal identifiers: `*personal*`, `*private*`, `journal/`.
Suitable for wikis that may be viewed by teammates, but where personal notes should be excluded.

### `public`
Maximum redaction. Blocks `journal/`, personal identifiers, and applies stricter `.hypoignore` rules.
Suitable for wikis synced to a public git remote.

---

## `.hypoignore` — excluding content from hooks

The `.hypoignore` file in your wiki root controls which files the hooks scan (context injection, hot.md rebuild, etc.).

Syntax: one glob pattern per line. Lines starting with `#` are comments.

```
# Example .hypoignore
journal/
*private*
sources/*.pdf
```

Files matched by `.hypoignore` are never read by hooks or included in index lookups. They remain on disk but are invisible to the Hypomnema tooling.

---

## What the hooks do

Hypomnema installs Claude Code hooks that run locally. They do **not** make network requests.

| Hook | Event | What it reads |
|------|-------|---------------|
| `hypo-session-start.mjs` | Session start | `hot.md`, `session-state.md` |
| `hypo-first-prompt.mjs` | First user prompt | `hot.md` |
| `hypo-file-watch.mjs` | File save | Changed wiki files (for auto-stage) |
| `hypo-auto-stage.mjs` | File save | Git status in wiki dir |
| `hypo-auto-commit.mjs` | Session stop | Git status in wiki dir |
| `hypo-compact-guard.mjs` | Pre-compact | `session-log/` (checks for missing entries) |
| `hypo-hot-rebuild.mjs` | Post-tool | `projects/*/hot.md` |
| `hypo-lookup.mjs` | Tool use | Wiki pages (for context injection) |
| `hypo-personal-check.mjs` | Pre-tool | Settings and config validation |

---

## Git sync and remote remotes

If you configure a git remote during `/hypo:init`, your wiki content will be pushed to that remote on session close (via `hypo-auto-commit.mjs`).

**Before adding a remote**, verify your `.hypoignore` excludes any content you do not want to publish. The auto-commit hook does not filter content — it commits everything not in `.gitignore`.

---

## Deleting your wiki

To remove Hypomnema completely:

1. **Delete the wiki directory**: `rm -rf <hypo-root>`
2. **Remove hook files**: `rm ~/.claude/hooks/hypo-*.mjs ~/.claude/hooks/hypo-personal-check.mjs`
3. **Remove hook registrations** from `~/.claude/settings.json` (the `hooks` object entries added by Hypomnema)
4. Optionally run `/hypo:uninstall` which automates steps 2–3.

---

## Data sent to Claude

When Claude Code reads wiki pages (via hooks or commands), that content is sent to Anthropic's API as part of the conversation context, subject to [Anthropic's privacy policy](https://www.anthropic.com/privacy).

To exclude sensitive content from Claude's context:
- Add the relevant paths to `.hypoignore`
- Use `privacy: public` mode to apply maximum redaction
- Store sensitive raw documents in `sources/` and only keep the synthesized summary (which you control) in `pages/`
