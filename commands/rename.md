---
description: Rename a wiki page or directory and rewrite the inbound wikilinks so live links survive. Use when the user wants to move or rename a page or folder without breaking references.
---

You are running `/hypo:rename`. Move a page or directory and content-aware rewrite every inbound `[[wikilink]]` across the vault so the rename never breaks a link.

## What this does

- Resolves `--from` to a page (`.md`) or a directory
- Page mode: moves the single page, rewrites every inbound `[[old]]` / `[[old|alias]]` / `[[old#anchor]]` / `[[dir/old]]` that resolves unambiguously to it
- Directory mode: relocates the whole subtree (carrying non-`.md` assets) and rewrites inbound full-slug and dir-relative links for every moved page
- Skips append-only time records (journal / session-log / weekly / archive / postmortems / root `log.md`) and immutable `sources/*` as link sources
- Reports ambiguous bare links it refuses to auto-rewrite, and refuses a merge/renumber into an existing destination

---

## Step 1 — Locate package root

Locate the Hypomnema package root (the directory containing this file's parent `commands/`).

If the user specified a Hypomnema directory, pass it as `--hypo-dir="<path>"`. Otherwise omit the flag.

---

## Step 2 — Dry-run first

Always run the dry-run (no `--apply`) before writing anything:

```bash
node <package-root>/scripts/rename.mjs \
  [--hypo-dir="<path>"] \
  --from=<slug|rel|dir> \
  --to=<slug|rel|dir> \
  [--json]
```

Options:
- `--from` — the page slug / relative path, OR an existing directory to relocate
- `--to` — the new name. A bare name renames in place within the same directory; a path with `/` moves across directories. For a directory `--from`, `--to` must be a fresh (non-existing) directory in the same top-level area
- `--json` — machine-readable result (recommended so you can present a precise summary)
- `--apply` — perform the move + rewrites (Step 4)

---

## Step 3 — Present the dry-run result

From the JSON, report:
- `from` → `to`, and for directory mode `pages_moved`
- `links_rewritten` across `files_rewritten` files — list the `from`→`to` per file
- `ambiguous` — any bare links shared by more than one page that were NOT rewritten. Tell the user to resolve these manually (use a dir-relative or full-slug form)

If the result is `ok: false`:
- `reason: "renumber-or-merge"` — the destination directory already exists. List `destination_collisions` and explain this is a merge/renumber: resolve manually, then retry into a fresh directory.
- `reason: "form-collision"` — the move would create ambiguous link forms. List `form_collisions`.
- Any other error — surface the `error` message verbatim.

---

## Step 4 — Apply

Once the user confirms the dry-run looks right, re-run with `--apply`:

```bash
node <package-root>/scripts/rename.mjs \
  [--hypo-dir="<path>"] \
  --from=<slug|rel|dir> \
  --to=<slug|rel|dir> \
  --apply --json
```

Then confirm: the page/subtree moved, `links_rewritten` applied, and any `ambiguous` links still pending manual fixup.

---

## Notes

- Directory mode rewrites a relocated time-record's intra-subtree links as `[[new|old]]`, preserving the rendered historical label while pointing at the live page.
- Bare `[[name]]` links to a moved page are intentionally left untouched in directory mode: a directory rename does not change basenames, so they keep resolving.
- After a large rename, run `/hypo:lint` to confirm no broken links remain.
