# Privacy Guide

Hypomnema stores all wiki data **locally on your machine**. No content is sent to any external service by the package itself.

---

## What is stored and where

| Location | Contents | Notes |
|----------|----------|-------|
| `<wiki-dir>/pages/` | Synthesized knowledge pages | Written by Claude during ingest/crystallize |
| `<wiki-dir>/projects/` | Project artifacts, session logs, ADRs | Written by Claude during session close |
| `<wiki-dir>/sources/` | Raw ingested source documents | Saved as-is; never edited |
| `<wiki-dir>/log.md` | Append-only activity log | Dates, page slugs, brief descriptions |
| `<wiki-dir>/hot.md` | Active project pointer table | Project names and dates only |
| `<wiki-dir>/hypo-config.md` | Wiki root marker + user settings | Includes privacy mode |
| `~/.claude/hooks/` | Hook scripts | JavaScript files; run locally by Claude Code |
| `~/.claude/settings.json` | Hook registrations | Command strings pointing to local hook files |

---

## Privacy modes

Set via `/hypo:init` or by editing `privacy:` in `hypo-config.md`.

### `personal` (default)
Standard mode for private local use. No restrictions beyond `.wikiignore`.

### `shared`
Adds ignore patterns for personal identifiers: `*personal*`, `*private*`, `journal/`.
Suitable for wikis that may be viewed by teammates, but where personal notes should be excluded.

### `public`
Maximum redaction. Blocks `journal/`, personal identifiers, and applies stricter `.wikiignore` rules.
Suitable for wikis synced to a public git remote.

---

## `.wikiignore` — excluding content from hooks

The `.wikiignore` file in your wiki root controls which files the hooks scan (context injection, hot.md rebuild, etc.).

Syntax: one glob pattern per line. Lines starting with `#` are comments.

```
# Example .wikiignore
journal/
*private*
sources/*.pdf
```

Files matched by `.wikiignore` are never read by hooks or included in index lookups. They remain on disk but are invisible to the Hypomnema tooling.

---

## What the hooks do

Hypomnema installs Claude Code hooks that run locally. They do **not** make network requests.

| Hook | Event | What it reads |
|------|-------|---------------|
| `wiki-session-start.mjs` | Session start | `hot.md`, `session-state.md` |
| `wiki-first-prompt.mjs` | First user prompt | `hot.md` |
| `wiki-file-watch.mjs` | File save | Changed wiki files (for auto-stage) |
| `wiki-auto-stage.mjs` | File save | Git status in wiki dir |
| `wiki-auto-commit.mjs` | Session stop | Git status in wiki dir |
| `wiki-compact-guard.mjs` | Pre-compact | `session-log/` (checks for missing entries) |
| `wiki-hot-rebuild.mjs` | Post-tool | `projects/*/hot.md` |
| `wiki-lookup.mjs` | Tool use | Wiki pages (for context injection) |
| `personal-wiki-check.mjs` | Pre-tool | Settings and config validation |

---

## Git sync and remote remotes

If you configure a git remote during `/hypo:init`, your wiki content will be pushed to that remote on session close (via `wiki-auto-commit.mjs`).

**Before adding a remote**, verify your `.wikiignore` excludes any content you do not want to publish. The auto-commit hook does not filter content — it commits everything not in `.gitignore`.

---

## Deleting your wiki

To remove Hypomnema completely:

1. **Delete the wiki directory**: `rm -rf <wiki-dir>`
2. **Remove hook files**: `rm ~/.claude/hooks/wiki-*.mjs ~/.claude/hooks/personal-wiki-check.mjs`
3. **Remove hook registrations** from `~/.claude/settings.json` (the `hooks` object entries added by Hypomnema)
4. Optionally run `/hypo:uninstall` which automates steps 2–3.

---

## Data sent to Claude

When Claude Code reads wiki pages (via hooks or commands), that content is sent to Anthropic's API as part of the conversation context, subject to [Anthropic's privacy policy](https://www.anthropic.com/privacy).

To exclude sensitive content from Claude's context:
- Add the relevant paths to `.wikiignore`
- Use `privacy: public` mode to apply maximum redaction
- Store sensitive raw documents in `sources/` and only keep the synthesized summary (which you control) in `pages/`
