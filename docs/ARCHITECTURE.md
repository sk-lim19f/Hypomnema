# Hypomnema — Architecture

> Internal reference for v1.1. For the user-facing pitch, see [README.md](../README.md).

---

## Runtime layers

Hypomnema is a Claude Code extension with three runtime layers stacked on a plain markdown vault.

```
┌──────────────────────────────────────────────────────────────┐
│  User                                                        │
│      ↓ /hypo:* slash command                                 │
│  Claude Code session                                         │
│  ├──► commands/<name>.md      (LLM prompt — what to do)       │
│  └──► scripts/<name>.mjs      (Node.js — how to do it)        │
│           ↓ writes / reads                                    │
│  Wiki vault (markdown + git)                                 │
│           ↑ reads / stages / commits                          │
│  Lifecycle hooks              (background automation)         │
│  ├──► SessionStart, UserPromptSubmit, PreCompact,             │
│  │    PreToolUse, PostToolUse, Stop, SessionEnd,              │
│  │    CwdChanged, FileChanged                                 │
│  └──► hypo-shared.mjs + other (copied beside the hooks,       │
│       shared modules           no imports outside the dir)    │
└──────────────────────────────────────────────────────────────┘
```

The three layers are deliberately **decoupled by file artifacts**. Slash commands write markdown. Hooks read markdown. The vault is the integration boundary — there is no in-process state shared across the layers.

---

## Package layout

```
hypomnema/
├── commands/                 ← slash command definitions (.md prompts)
├── hooks/                    ← lifecycle hooks (copied to ~/.claude/hooks/ on the npm channel)
│   ├── hypo-*.mjs                ← hook entry points and modules (see Hook registry below)
│   ├── hypo-shared.mjs           ← shared utilities, copied beside the hooks
│   ├── hooks.json                ← source of truth for the event to hook map
│   └── shared.json               ← source of truth for the shared module list
├── scripts/                  ← Node.js implementations
│   ├── init.mjs / upgrade.mjs / uninstall.mjs / doctor.mjs
│   ├── ingest.mjs / query.mjs / lint.mjs / verify.mjs / graph.mjs / stats.mjs
│   ├── crystallize.mjs / resume.mjs / feedback.mjs / feedback-sync.mjs
│   ├── capture.mjs / rename.mjs / proposal.mjs / session-entries.mjs
│   ├── session-audit.mjs / weekly-report.mjs
│   └── lib/                      ← helpers only scripts import (about 30 files)
├── skills/                   ← directory-form Agent Skills (skills/<name>/SKILL.md)
├── templates/                ← baseline files copied on init
│   ├── hypo-config.md, index.md, hot.md, log.md, SCHEMA.md, hypo-guide.md
│   ├── Home.md, Overview.md, hypo-automation.md, hypo-help.md
│   ├── pages/_index.md
│   └── projects/_template/
├── tests/
│   ├── harness.mjs               ← test()/testAsync()/suite(), selection, reporting
│   ├── helpers.mjs               ← fixtures shared by more than one area file
│   ├── runner.mjs                ← entry: imports every *.test.mjs, owns no tests
│   ├── parallel.mjs              ← runs the entry as N processes (`npm test`)
│   └── <area>.test.mjs           ← one file per production area
├── docs/                     ← ARCHITECTURE.md, CONTRIBUTING.md
├── .claude-plugin/plugin.json← plugin manifest
└── package.json              ← npm metadata, no runtime deps
```

Which `scripts/` files ship is decided by the `files` list in `package.json`, which names each one. Anything under `scripts/` that is not on that list is maintainer tooling (release checks, the git-hook installer, and similar) and never reaches an installed copy. The entry points above are the ones a user runs.

The package has **zero npm runtime dependencies**. Everything is Node.js built-ins (`fs`, `path`, `os`, `child_process`, `crypto`).

---

## Slash commands

Each user-facing operation is a pair: an LLM-facing prompt + a Node.js script.

| File | Role |
|---|---|
| `commands/<name>.md` | Prompt definition — instructions Claude follows when the command is invoked |
| `scripts/<name>.mjs` | Script implementation — Node.js logic the prompt may call via Bash |

**Commands shipped in v1.1:** `init`, `doctor`, `upgrade`, `uninstall`, `ingest`, `query`, `crystallize`, `resume`, `feedback`, `verify`, `lint`, `stats`, `graph`.

Every one of those files is itself an Agent Skill; see below.

---

## Agent Skills

A flat `commands/<name>.md` and a directory `skills/<name>/SKILL.md` are the same kind of
component to the plugin loader: both are Agent Skills, both claim `/hypo:<name>`, and both
auto-load when a conversation matches their `description`. (That is measured on a plugin
install. `init`/`upgrade` do not deploy the plugin's own `skills/` at all, so on the npm path
only `commands/` is installed — into `~/.claude/commands/hypo/` — and whether those copies
auto-trigger the same way has not been measured.) The directory form is what a skill needs when
it carries more than one file (`skills/debate/references/`); the flat form is everything else.

**One name ships from one directory, never both** (in this package; the extensions channel
under `~/hypomnema/extensions/` is not covered by the gate and can still sync a co-named pair)**.** Shipping a pair does not give you a
human-facing surface and a model-facing surface: nothing in the frontmatter separates them, only
one wins, and the loser is dead weight that still costs always-on tokens and still appears in
`claude plugin details`. Six pairs shipped that way from v1.0.0 until 2026-09-04, and `commands/`
won every one of them. `scripts/smoke-plugin.mjs` now fails the build on a collision.

> v1.0 originally planned flat `skills/*.md` files and shipped `<name>/SKILL.md` instead; both
> forms have loaded since v1.0.0. The 2026-09-04 correction is that they are not two surfaces.

---

## Lifecycle hooks

Hooks run automatically at Claude Code lifecycle events. On the plugin channel the harness runs them straight from the plugin directory. On the npm channel `init` / `upgrade` copy them to `~/.claude/hooks/` and register them in `~/.claude/settings.json` (see Install channels below).

### Hook registry (`hooks/hooks.json`)

`hooks.json` is the **single source of truth** for hook ↔ event mapping. `init`, `upgrade`, and `doctor` all read from it; the previous v1.0 design that maintained three separate `HOOK_MAP` constants was deleted in v1.1. A `git post-commit` hook re-applies upgrades when this file changes.

Counts are left out on purpose, because they go stale: `hooks/hooks.json` lists the events and registered handlers, and `hooks/shared.json` lists the modules copied beside them. At the time of writing that is nine events and twelve handlers.

| Event | Hooks (in order) |
|---|---|
| `PreToolUse` | `hypo-close-guard.mjs` |
| `SessionStart` | `hypo-session-start.mjs` |
| `SessionEnd` | `hypo-session-end.mjs` |
| `UserPromptSubmit` | `hypo-first-prompt.mjs` → `hypo-lookup.mjs` → `hypo-compact-guard.mjs` |
| `PreCompact` | `hypo-personal-check.mjs` |
| `PostToolUse` (no matcher in `hooks.json`; each hook filters on `tool_name` itself) | `hypo-auto-stage.mjs` (Write/Edit/MultiEdit) → `hypo-web-fetch-ingest.mjs` (WebFetch/WebSearch) |
| `Stop` | `hypo-stop.mjs` (runs `hypo-hot-rebuild.mjs` → `hypo-session-record.mjs` → `hypo-auto-commit.mjs` → `hypo-auto-minimal-crystallize.mjs` as ordered stages, not separate registrations) |
| `CwdChanged` | `hypo-cwd-change.mjs` |
| `FileChanged` | `hypo-file-watch.mjs` |

### Hook responsibilities

| Hook | Responsibility |
|---|---|
| `hypo-session-start` | Run `git pull --ff-only` (silent fail on missing remote), rebuild the generated session views from `projects/*/sessions/` (not on a vault with a remote that has not moved yet, which gets a notice instead), inject `index.md`, root `hot.md`, project `hot.md`/`session-state.md` |
| `hypo-close-guard` | `PreToolUse`: denies a direct Write/Edit/MultiEdit to a generated session view (root `hot.md`, a project's `hot.md` or `session-state.md`) or to a session entry under `projects/<p>/sessions/`. Writes made through Bash are out of its scope, and the regular close apply runs through Bash |
| `hypo-session-end` | `SessionEnd`: on `reason=clear` only, writes `.cache/clear-marker.json` so the next `SessionStart` (`source=clear`) can issue a recovery nudge. Other exit reasons write nothing |
| `hypo-web-fetch-ingest` | `PostToolUse`: after a WebFetch or WebSearch, injects a nudge to run `/hypo:ingest` (URL reduced to origin and path). It is a signal only and never ingests anything itself |
| `hypo-first-prompt` | Reads the marker left by `hypo-session-start` or `hypo-cwd-change` and forces a one-line resume on the first user prompt (10-min TTL). It does not re-read or re-inject `hot.md` |
| `hypo-lookup` | BM25 search over the wiki on every prompt. **HIT** → inject top-3 page snippets (≤2000 chars each; a page whose `verify_by_date` is overdue gets a `[STALE verify_by_date=…]` marker prepended). **MISS** → emit closest-slug signal that prompts Claude to research + `/hypo:ingest` |
| `hypo-compact-guard` | Detect `/compact` or `/clear` typed in chat and, if session close is incomplete, tell Claude so. It never blocks `/compact` |
| `hypo-personal-check` | PreCompact detection: lint blockers, uncommitted changes, missing session-log entries surface as a `systemMessage`; `/compact` is never blocked here |
| `hypo-auto-stage` | After Write/Edit on a wiki path, run `git add` (skips paths matching `.hypoignore`, and every path while a merge is open) |
| `hypo-hot-rebuild` | At session stop, regenerate the generated session views (root `hot.md`, project `hot.md` and `session-state.md`; the same generator `hypo-session-start` also calls); emit growth metrics + cache for next SessionStart. A scan failure (not just an empty `projects/`) skips the write and leaves a health notice for the next `SessionStart` to surface |
| `hypo-session-record` | At session stop, append `{session_id, transcript_path, recorded_at, cwd, device}` to `.cache/sessions/index.jsonl` (primary source for the observability audit) |
| `hypo-auto-commit` | At session stop, filter changed paths through `.hypoignore`, finish a merge Hypomnema left open, commit non-ignored changes, `git pull --no-rebase` + `git push` (silent fail on missing remote; the push is skipped after a pull that did not land, and when the tree tracks generated views under a migrated upstream) |
| `hypo-cwd-change` | When working directory changes, re-resolve the active project and build a notice carrying its `hot.md`. The hook reference documents `watchPaths` and `systemMessage` as `CwdChanged`'s output fields and says only that "it shows the `systemMessage` as a brief terminal notification" and "the message doesn't reach the SDK message stream"; it does not say whether `systemMessage` reaches the model on this event either way. As of Claude Code 2.1.276 (checked 2026-09-18) and reconfirmed on 2.1.283, tracing the installed binary shows the only consumer of that `systemMessage` is the terminal notification queue, a low-priority toast that a same-keyed message replaces and that disappears after five seconds, with no branch that forwards it to the model; outside the interactive REPL the injecting function is null. No live-session observation of this path exists either way. Until the documentation says otherwise, this event is treated as not reaching the model |
| `hypo-file-watch` | Build a `systemMessage` notice for a changed wiki file, over the same field as `hypo-cwd-change` whose reach to the model the reference leaves undocumented; as of Claude Code 2.1.276 (checked 2026-09-18) and reconfirmed on 2.1.283 it is likewise treated as not reaching the model, for the same shared-consumer reason (see the `hypo-cwd-change` row). On a stock install the event still has no registered trigger: its matcher key is omitted (not blank), which the reference says matches every watched file while adding nothing to the watch list, and nothing in this package returns `watchPaths` to seed that list. The watch list is session-global, not scoped to this plugin, so another hook or plugin that does seed it would make this matcher-less group fire on every watched file; the hook still returns immediately for any path that does not start with `HYPO_DIR` (a string-prefix check, not a symlink-resolving one). That check only screens the path string: a symlink living inside the wiki still starts with `HYPO_DIR` and passes it, and the hook's `readFileSync` follows the link, so such a symlink can still surface content from wherever it points. The event also fires regardless of who changed the file, so it is not an external-edit signal |

### Deployment constraint

On the npm channel hooks run from `~/.claude/hooks/`, an isolated directory. They **cannot import from relative paths** outside their own directory. Therefore:

- Shared hook logic lives in the modules `hooks/shared.json` declares, not only in `hypo-shared.mjs`. That file (a plain JSON array of `.mjs` basenames) is the source of truth for the list. Each listed file is copied next to the hooks at deploy time, not inlined into them. It used to be a `shared` field inside `hooks.json` itself; it moved to this sibling file because the harness started warning on that unknown top-level key once it began validating `hooks.json` against its own hook-registration schema.
- Hook utilities use **only Node.js built-ins** — no relative imports, no npm dependencies.

Scripts in `scripts/` are not copied anywhere. They run from the package install path, so they can import from `scripts/lib/`, and they may import from `hooks/`. The reverse is never allowed: a hook that imported from `scripts/` would resolve in a checkout and fail in every installed copy.

---

## Shared utilities (`hooks/hypo-shared.mjs`)

| Export | Purpose |
|---|---|
| `HYPO_DIR` | Resolved wiki root path |
| `PKG_ROOT` | Package install path, read from `~/.claude/hypo-pkg.json` |
| `resolveHypoRoot()` | `HYPO_DIR` env → `hypo-config.md` scan (cwd → `$HOME`) → `~/hypomnema` fallback |
| `loadHypoIgnore()` | Parse `.hypoignore` into a pattern list |
| `isIgnored(path)` | Test a path against `.hypoignore` patterns |
| `hypoIsClean()` | Check git status + unpushed commits |
| `hotMdIsClean()` | Validate `hot.md` structure |
| `isCompactCommand(prompt)` | Detect `/compact` invocations |
| `buildOutput(hookEventName, context, extra)` | Build hook output that nests `additionalContext` under `hookSpecificOutput`, keeping control fields as top-level siblings. The event name is required: Claude Code drops a payload whose `hookEventName` does not match the firing event |
| `SESSION_STATE_NEXT_HEADINGS` | Allowed headings for "next tasks": `## 다음 이어받기` / `## 다음 작업`. Lint reuses this constant (DRY) |

`hypo-shared.mjs` is one of the shared modules. The full list is `hooks/shared.json`; besides the session-close stores and the update-check modules it includes `session-entries.mjs`, which holds the session entry format and the renderers, and `session-views.mjs`, which loads the entries and writes the generated views.

---

## Scripts lib (`scripts/lib/`)

Helpers used by command scripts only. They are not copied beside the hooks. There are about 30 of them, and the shipped set is the `scripts/lib/` entries in `package.json`'s `files`. The main ones:

| File | Purpose |
|---|---|
| `frontmatter.mjs` | Parse and serialize YAML frontmatter |
| `hypo-root.mjs` | Wiki root resolution (mirrors hook logic, allows imports) |
| `hypo-ignore.mjs` | `.hypoignore` parsing (mirrors hook logic, allows imports) |
| `project-create.mjs` | Creates a project: `index.md`, `prd.md`, `decisions/`, `session-log/` |
| `crystallize-close-*.mjs` | The session-close check, gate and apply behind `/hypo:crystallize` |
| `extensions.mjs` | Syncs the vault's `extensions/` into `~/.claude` |
| `plugin-detect.mjs` | Detects whether the plugin is also enabled, so the npm path does not register every hook twice |
| `wikilink.mjs`, `slug-resolver.mjs` | Wikilink parsing and slug resolution |
| `rename-marker.mjs` | The crash-recovery marker `rename.mjs --apply` writes and `doctor.mjs` reads |

The session entry format and the generated views are not here. `hooks/session-entries.mjs` and `hooks/session-views.mjs` own them, because hooks need them too and scripts may import from `hooks/` but not the other way round. `scripts/session-entries.mjs` is the command-line entry for them (`rollback` and `render`; the move to entries is `/hypo:upgrade --migrate-sessions`).

---

## Wiki vault layout

```
<hypo-root>/
├── hypo-config.md        ← root marker + settings (presence == wiki root)
├── index.md              ← searchable page catalog
├── hot.md                ← active project pointers (root-level, generated, not committed)
├── log.md                ← append-only activity log
├── SCHEMA.md             ← type system reference
├── hypo-guide.md         ← operations guide
├── .hypoignore           ← glob patterns the hooks must ignore
├── .hyposcanignore       ← glob patterns excluded from catalog scans only (not a privacy boundary)
├── .gitignore            ← written by init (generated views, .cache/)
├── .gitattributes        ← written by init
├── extensions/           ← your own agents/commands/hooks/skills, mirrored to ~/.claude
│   └── {agents,commands,hooks,skills}/
├── pages/                ← permanent knowledge pages
│   ├── feedback/         ← AI behavior corrections
│   └── observability/    ← _index.md (the autonomy score definition)
├── projects/             ← per-project artifacts
│   ├── _template/        ← scaffold: index.md, prd.md, decisions/, session-log/
│   └── <name>/
│       ├── index.md          ← overview (working_dir: field)
│       ├── prd.md            ← purpose / success criteria
│       ├── decisions/        ← ADRs (created with the project)
│       ├── sessions/         ← one entry per session close (source of truth, never deleted)
│       ├── notes.md          ← notes every session shares (hand-written, optional)
│       ├── hot.md            ← recent session summaries (generated, not committed)
│       ├── session-state.md  ← next tasks per track (generated, not committed)
│       └── session-log/
│           └── YYYY-MM-DD.md ← append-only daily session-log shard
├── journal/
│   ├── daily/
│   ├── weekly/
│   └── monthly/
├── sources/              ← raw ingested sources (append-only, never edit)
└── .cache/               ← runtime state (gitignored): session index, markers, backups
```

`hypo-config.md` presence is the wiki root marker. `resolveHypoRoot()` scans for it from cwd up to `$HOME`.

---

## Configuration resolution

The wiki path is resolved in this order:

1. **`HYPO_DIR` environment variable** — explicit override
2. **`hypo-config.md` scan** — walk from current dir up to `$HOME`
3. **`~/hypomnema`** — default fallback

Hooks carry this logic in `hypo-shared.mjs`. Scripts use `scripts/lib/hypo-root.mjs` (functionally identical, but importable).

`PKG_ROOT` is stored in `~/.claude/hypo-pkg.json` by `init`. `hypo-personal-check.mjs` uses it to locate the lint script (`PKG_ROOT ?? HYPO_DIR`); `upgrade --apply` detects drift and refreshes it.

---

## Install channels

Hypomnema reaches a machine through two channels, and they deploy hooks differently.

| | Plugin channel | npm channel |
|---|---|---|
| Who runs the hooks | The harness, straight from `${CLAUDE_PLUGIN_ROOT}/hooks` as `hooks/hooks.json` says | `~/.claude/hooks/`, registered in `~/.claude/settings.json` |
| Deploy step | None | `init` and `upgrade` copy the hooks and shared modules, then merge `settings.json` |
| How an update arrives | The installer caches each version in a directory named after `plugin.json`'s `version` string. If the version has not changed, the directory already exists and new commits never reach the installed copy | `upgrade` re-copies from the package |

The consequence for releases: on the plugin channel a fix reaches nobody until the version string moves. `init` and `upgrade` detect an enabled plugin and skip the copy and the `settings.json` merge, because doing both would fire every hook twice. In the steps below, each step is marked `[both]`, `[npm only]`, or `[plugin: skipped]`.

## Init and upgrade flow

### `/hypo:init`

1. `[both]` Wizard collects: wiki path, hook scope (`~/.claude` and/or `~/.codex`), git remote URL.
2. `[both]` Creates the vault directory structure: `pages/`, `pages/observability/`, `projects/`, `sources/`, `journal/{daily,weekly,monthly}/`, and `extensions/{hooks,commands,skills,agents}/` (each with a `.gitkeep`).
3. `[both]` Copies `templates/` files: `index.md`, a generated root `hot.md`, `log.md`, `SCHEMA.md`, `hypo-guide.md`, the helpers `Home.md`, `Overview.md`, `hypo-help.md`, `hypo-automation.md`, a root `session-state.md`, `pages/_index.md`, `pages/observability/_index.md`, and `projects/_template/` (`index.md`, `prd.md`, `decisions/`, `session-log/`). It then writes `hypo-config.md`, `.hypoignore`, `.hyposcanignore`, `.gitignore` and `.gitattributes`.
4. `[npm only]` Copies the hooks and shared modules to `~/.claude/hooks/`, installs the commands under `~/.claude/commands/hypo/`, and merges entries into `~/.claude/settings.json` (idempotent; preserves non-hypo hooks). `[plugin: skipped]` when the plugin is enabled.
5. `[both]` Writes `~/.claude/hypo-pkg.json` with `pkgRoot` for upgrade tracking (skipped when the
   plugin channel judgment fails; see `init.mjs`'s `resolveDurableRoot`).
6. `git init` + first commit `init: hypomnema wiki`. Pushes to remote when one is provided.

`--dry-run` previews; `--no-hooks` and `--no-git-init` are also supported. Re-running `init` is idempotent — existing files are skipped, never overwritten.

### `/hypo:upgrade`

1. `[both]` Reads `pkgRoot` from `~/.claude/hypo-pkg.json`.
2. `[npm only]` Re-deploys hooks from the current package version.
3. `[npm only]` Re-merges `settings.json` entries.
4. `[both]` Detects drift (e.g., `pkgRoot` no longer exists) and refreshes the pointer.
5. `--json` output emits `{ schema, hooks, settings, applied }`. `--dry-run` previews; `--apply` commits changes.

The SessionStart hook (`hooks/hypo-session-start.mjs`) is a third writer of this file, outside init/upgrade entirely. `hooks/hypo-shared.mjs`'s `pkgRootDriftStatus` detects drift by comparing the canonicalized `pkgRoot` alone, not `pkgVersion`, so a file whose `pkgRoot` already matches self-location reads as `match` even when its `pkgVersion` is stale. Only a `pkgRoot` mismatch triggers the rewrite (temp file, then rename), and `pkgVersion` is carried along in that same write rather than checked or fixed on its own. The rewrite is guarded by a lockfile, so two sessions self-locating to different install roots at once cannot race each other's write, and it writes nothing on a downgrade (self-location resolves to an older version than the file already records), an incoming version that fails to parse as semver, a lock it could not acquire, or an opted-out session.

### `/hypo:uninstall`

Removes hypo-prefixed hooks from `~/.claude/hooks/` and matching entries from `~/.claude/settings.json`. **Non-hypo hooks are preserved**. `--apply` also reaches past `~/.claude/`: it strips the marked `claude()` block from the shell rc file(s) init wrote to, and removes the marked pre-commit hook from the wiki's own git repo. Both removals are marker-gated the same way the hooks-dir cleanup is, so a hand-edited block or hook is left in place rather than guessed at.

---

## Data flows

### Ingest

```
source (URL / file / paste)
  │
  ├─► sources/<slug>.<ext>          ← raw, untouched
  │
  └─► LLM reads + synthesizes
       │
       ├─► HIT (page exists)        ← reconcile + append [YYYY-MM-DD update]
       │     └─► pages/<slug>.md (updated, frontmatter `updated:` bumped)
       │
       └─► MISS                     ← new page
             └─► pages/<slug>.md (frontmatter: type, source, confidence, evidence_strength)
       │
       ├─► index.md ← add [[pages/<slug>]]
       └─► log.md   ← append ingest entry
```

### Query

```
user question
  │
  ├─► hypo-lookup.mjs (BM25 over index.md + page frontmatter)
  │     ├─► HIT → inject top-3 page snippets into prompt context
  │     └─► MISS → emit closest-slug signal
  │
  └─► /hypo:query → LLM synthesizes grounded answer with [[wikilink]] citations
```

### Session lifecycle

```
SessionStart
  │
  ├─► hypo-session-start.mjs
  │     ├─► git pull --ff-only (if remote)
  │     ├─► rebuild the generated views (root hot.md, project hot.md and session-state.md, from projects/*/sessions/)
  │     ├─► inject index.md / hot.md / project session-state.md
  │     └─► (Claude resumes work)
  │
  ├─► UserPromptSubmit (every prompt)
  │     ├─► hypo-first-prompt.mjs (one-shot, 10min TTL)
  │     ├─► hypo-lookup.mjs (BM25 inject)
  │     └─► hypo-compact-guard.mjs (report incomplete checklist; never blocks /compact)
  │
  ├─► PreToolUse
  │     └─► hypo-close-guard.mjs (denies a direct write to a generated view or a session entry)
  │
  ├─► PostToolUse (no matcher; each hook filters on tool_name)
  │     ├─► hypo-auto-stage.mjs (Write/Edit/MultiEdit: git add)
  │     └─► hypo-web-fetch-ingest.mjs (WebFetch/WebSearch: nudge toward /hypo:ingest, never ingests)
  │
  ├─► PreCompact
  │     └─► hypo-personal-check.mjs (lint + session-close gate)
  │
  ├─► CwdChanged
  │     └─► hypo-cwd-change.mjs (builds a hot.md notice on systemMessage; the reference documents the terminal notification, tracing the installed binary as of Claude Code 2.1.276, checked 2026-09-18 and reconfirmed on 2.1.283, shows it does not reach the model, and no live-session observation exists either way; see the hook table above)
  │
  ├─► Stop
  │     └─► hypo-stop.mjs, running four stages in order:
  │           ├─► hypo-hot-rebuild.mjs (regenerate the session views + growth cache; SessionStart also calls this generator)
  │           ├─► hypo-session-record.mjs (append .cache/sessions/index.jsonl)
  │           ├─► hypo-auto-commit.mjs (.hypoignore-filtered stage + commit + pull + push)
  │           └─► hypo-auto-minimal-crystallize.mjs (blocks Stop if session close never ran)
  │
  └─► SessionEnd
        └─► hypo-session-end.mjs (on /clear only: writes .cache/clear-marker.json for the next SessionStart)
```

Root hot.md's frontmatter `updated:` is the max of every project row date, and a row's date is the
date of that project's newest session entry, not the date the file itself was last rewritten.
A vault whose newest entry is a week old keeps that same week-old date across every SessionStart
and Stop, even though the root file's bytes get recomputed and checked far more often.

Before overwriting content it does not recognize as its own, the generator backs it up under
`.cache/backups/<relPath>` (for the root file, `.cache/backups/hot.md.pre-projection-backup.md`, or
a numbered variant, `-2.md`, `-3.md`, ...). These
backups are never cleaned up automatically. Delete the ones you no longer need by hand.

### Session entries

Session close does not write `hot.md` or `session-state.md`. Each close writes one entry,
`projects/<p>/sessions/<date>-<close_id>.md`, whose frontmatter lists the tracks it updated
(`entry_schema`, `close_id`, `tracks`) and whose body holds a summary and one section per track.
Entries are never deleted. Concurrent closes (two sessions, two machines) write different files, so
nothing is overwritten; the head of a track is the update no later update supersedes, and a track
with several heads shows all of them. Entries are ordered newest first by `date`, then by the
`closed_at` time the close wrote (ISO 8601 UTC), so two closes on one day sort by when they ran, and
an entry without `closed_at` (a baseline, or one written by an older version) sorts after the
same-day entries that have it. `hooks/session-entries.mjs` holds the entry format and the
renderers, `hooks/session-views.mjs` loads the model and writes the views. Root `hot.md`, project
`hot.md` and project `session-state.md` are listed in the vault `.gitignore` (the block in
`templates/gitignore`) and are not committed. `projects/<p>/notes.md` is hand-written, not
generated, and is injected with the views.

Vaults move to this layout in one of three ways. A vault with no git remote moves at its first
SessionStart. A vault with a remote only gets a notice (at most once a day) until a person runs
`/hypo:upgrade --migrate-sessions` after every machine has the new version; the command pulls first,
migrates, then pushes. Before the move, a close writes entries only, the tracked old files are read
as a virtual baseline for injection and resume, and nothing is written to the generated paths.
The move turns each old `hot.md` and `session-state.md` into a baseline entry. An old
`session-state.md` that has a `## Next Up` (or `## 다음 이어받기`) section with `###` tracks, or one
with a `트랙:` / `Tracks:` list line whose named `##` sections follow, becomes one head per track,
so a later close can finish one track without touching the others; any other file stays one
`legacy` head.
`node scripts/session-entries.mjs rollback --at=<commit>` re-tracks flat files rendered from the
entries at that commit and adds the `.hypo-session-entries-off` marker; the vault then counts as
opted out and no hook migrates it again until `--migrate-sessions` is run. A machine on an older
version that pulls the move loses the three files, cannot read `sessions/`, and its closes are not
recorded; `/hypo:doctor` reports recent traces of such a machine.

The write itself goes through `writeGeneratedViews` in `hooks/session-views.mjs`, which holds
the vault commit lock (`vaultCommitLockTarget`, the same lock `hypo-auto-commit.mjs` and
`crystallize.mjs`'s apply take around stage and commit) across the whole write: the read of each
view, the ownership check, the backup, and the replacing rename. `hypo-session-start.mjs`'s own
`git pull` takes and releases the same lock before it renders, so the two never overlap; they
still serialize against each other and against a concurrent `auto-commit` or `crystallize` apply.
The lock is not reentrant: nothing inside the write path may take it a second time, and a caller
that already holds it (`hypo-auto-commit.mjs` after its pull) calls `writeGeneratedViewsUnlocked`
instead. When the lock cannot be acquired within its timeout, the write is skipped rather than
blocked on indefinitely, the result carries `lockTimeout: true`, and a health notice is left for
the next SessionStart.

---

## Feedback → Behavior pipeline

Corrections flow through three stages:

1. **Capture** — `/hypo:feedback` writes a structured page to `pages/feedback/<topic>.md` with frontmatter `{ type: feedback, scope, confidence, evidence_strength }`.
2. **Inject** — `hypo-session-start.mjs` reads relevant feedback into the next session's context.
3. **Promote** — when a feedback page accumulates `confidence: high`, `evidence_strength: direct`, and ≥3 "forgotten and re-explained" events, it is hand-promoted into `CLAUDE.md`'s `<learned_behaviors>` block — making it a permanent rule for Claude on every machine that pulls the wiki.

Promotion is intentionally manual to keep `<learned_behaviors>` curated. The pipeline definition is captured in the wiki at `.omc/wiki/wiki-promotion-pipeline.md` (personal system; not part of the OSS package).

---

## Observability (v1.1)

v1.1 ships an **observability wedge** — the wiki measures whether it's actually being used per session, rather than claiming autonomy it can't yet deliver.

### Data flow

```
Stop hook (hypo-session-record.mjs)
    │  appends one JSONL entry per session
    ▼
<hypo-root>/.cache/sessions/index.jsonl   ← primary source
    │
    ▼
scripts/session-audit.mjs                  ← per-session metrics + classification
    │
    ▼
scripts/weekly-report.mjs                  ← aggregated weekly autonomy score
    │
    ▼
journal/weekly/<YYYY-Www>.md               ← committed report (heuristic v0, spec §6.4 SoT)
```

### Transcript dual-source

`session-audit.mjs` reads transcripts from two locations, in priority order:

1. **Primary:** `<hypo-root>/.cache/sessions/index.jsonl` — written by the Stop hook `hypo-session-record.mjs`. Each line: `{ session_id, transcript_path, recorded_at, cwd, device }`. `device` is `os.hostname()` for multi-machine audit; the index lives under `.cache/` (gitignored in a normal vault) so it is a local-only per-session record.
2. **Fallback:** `~/.claude/projects/<encoded>/*.jsonl` — scanned when the index is missing or empty (legacy / freshly-installed wikis).

### Classification

| Class | Rule |
|---|---|
| `staleness-skip` | `recorded_at` older than `--max-age-days` (default 30) |
| `ingest-missed` | `urls >= 2` and `ingest_count == 0` |
| `search-many`   | `search_count >= 5` (heavy retrieval; suggests missing synthesis) |
| `search-0`      | `search_count == 0` |
| `normal`        | otherwise |

Counted tool names: `Grep`, `WebSearch`, `WebFetch`. Counted slash commands: `/hypo:query`, `/hypo:ingest`, `/hypo:feedback`. A single transcript record contributes to exactly one of (tool-use search OR text-based command search) — `computeMetrics` short-circuits after a tool-use match to prevent double counting.

### Autonomy score (heuristic v0)

`weekly-report.mjs` aggregates the week's results into a 0–100 score. The score is **clamped to `[0, 100]`** and skips `staleness-skip` sessions. Formula sketch (see `pages/observability/_index.md` for the formal definition):

```
numerator   = Σ min(search,3) + ingest*3 + feedback*2
denominator = Σ 1   + (urls > 0 ? min(urls,5)*2 : 0)
score       = clamp(round(num/den * 100), 0, 100)
```

The score is a **proxy, not ground truth**. The four-week baseline plan (capture v0 numbers, then revisit with LLM-judge classification before v2) is recorded in the same `_index.md`.

### Privacy

The observability pipeline reads but never republishes raw transcripts. Weekly reports only emit `session_id` plus aggregate counts — no transcript content, no URLs, no tool inputs. Transcripts themselves live under `~/.claude/projects/` or `.cache/sessions/` which `.hypoignore` already excludes from any sync.

**Audit fields (`device`, `session_id`).** `device` (`os.hostname()`) is recorded in two places with different sync boundaries, by design. In `.cache/sessions/index.jsonl` it is per-session-accurate but **local-only** (`.cache/` is gitignored in a normal vault). In the seeded session-log daily-shard frontmatter it is an **intentional synced field** — a creator-only stamp (the session/machine that first created the day's shard), carried across machines so the wiki itself records which machine opened each day. `session_id` (the Claude session UUID) is seeded into that same synced frontmatter, but only on the Stop-chain close path that passes `--session-id`; on manual/skill closes it is omitted. This deliberately puts a hostname (and, on the automated path, the session UUID) into git-tracked, synced content; it is acceptable for a single-user private vault where multi-machine identification is the goal. Operators who do not want a hostname synced can override `os.hostname()` at the OS level or treat the field as a pseudonymous label.

### Growth metrics (Lane B)

A separate, lightweight counter — distinct from the audit pipeline — runs at every Stop / SessionStart pair:

- **Stop** (`hypo-hot-rebuild.mjs`) computes `{ addedPages, updatedPages, newWikilinks }` by reading `git status --porcelain` plus a conditional `git diff HEAD --unified=0`, writes the result to `<hypo-root>/.cache/last-session-growth.json`, and echoes one line to stderr.
- **SessionStart** (`hypo-session-start.mjs`) reads the cache and surfaces the same line in both stderr (cyan) and the LLM's `additionalContext` so user and model see the same "직전 세션" prefix.

If `git status` shows no `.md` changes, the diff step is skipped — Stop hook fast path.

### Citation convention

**The convention is current.** It is stated in `commands/query.md`, in `commands/crystallize.md`, and in `templates/hypo-guide.md` §8, which `init` writes into a vault that does not already have it (an existing copy is left alone). What went away on 2026-09-04 is one particular copy of it: an identical footer written into six `skills/*/SKILL.md` files, which were the losing half of the name collision above and never reached anyone. Whether to repeat that footer in the remaining `commands/*.md` is open. The observability audit never depended on it either way: it scores sessions on tool and command usage recorded by `hypo-session-record` (search / ingest / feedback counts), not on inline citations.

---

## Privacy & exclusions

`.hypoignore` is the **only** privacy mechanism. The v1.0 `personal / shared / public` mode matrix was deleted in v1.1 — every privacy decision turned out to be a per-path question, and a single ignore file handles per-path natively.

Default patterns: `*.pdf`, `*.zip`, `*.pem`, `*.env`, `*.key`, `*.crt`, `*credentials*`, `*secret*`. The user edits this file directly.

`.hypoignore` is consumed by `loadHypoIgnore()` / `isIgnored()` in both hook and script contexts, and `lint` raises a `B5` blocker if a `.hypoignore`-matched file is present in tracked content.

---

## Testing

```
tests/
├── harness.mjs          ← test() / testAsync() / suite(), and how a run is selected
├── helpers.mjs          ← fixtures used by more than one area file
├── runner.mjs           ← the entry: imports every *.test.mjs, owns no tests itself
├── parallel.mjs         ← runs the entry as N concurrent processes (`npm test`)
└── <area>.test.mjs      ← one file per production area
```

Tests live next to the thing they test: `extensions.test.mjs`, `lint.test.mjs`,
`proposal-base.test.mjs`, and so on. Two branches adding tests to different areas never touch
the same file, which is the point of the layout. It is not about speed.

Everything uses Node built-ins only. Fixtures are built in code with scoped helpers
(`withTmpDir`, `withWiki`, `withCleanWiki`, `gitRepo`, …), each cleaning up in a `finally`.

**Selection is by suite, never by test.** `suite(label)` opens a selection unit, and
`--shard=i/n` keeps a whole suite in one process, in order. So tests inside one suite may build
on each other, and suites may not build on each other. `node tests/parallel.mjs --shards=<n>`,
with `n` at or above the current `suite()` count, runs every suite alone in a fresh process and
is the proof of that invariant. A smaller `n` stops proving it. Run it whenever you add or split
a suite.

| Command | What it does |
|---|---|
| `npm test` | `parallel.mjs`, cpu-count processes, suites round-robined across them |
| `npm run test:serial` | the whole suite in one process; verdict-identical |
| `node tests/runner.mjs --grep=<regex>` | just the matching tests, in seconds |
| `node tests/runner.mjs --file=lint` | one area file |
| `node tests/parallel.mjs --by-file` | one process per area file |
| `node tests/parallel.mjs --shards=<n>` | every suite alone, with `n` at or above the `suite()` count: the order-independence proof |

Round-robin is the default rather than one-process-per-file, and the reason is measured, not
assumed: on a 2026 laptop the whole suite runs in about 70s round-robined and about 100s
`--by-file`. The areas differ by an order of magnitude in size, and `--by-file` starts every area
at once, which oversubscribes the cores. The big files (`extensions`, `proposal-base`,
`close-global`) then finish last under contention while the small ones exit in seconds and
leave the tail of the run half idle. Reach for `--by-file` to read one area's output, not to go
fast.

`  ✓ name` and `  ✗ name` are a contract, not decoration.
`scripts/lib/fix-status-verify.mjs` parses them to map a fix number to its verdict, and reads
the `// @fix #N:` anchors as a union across every `tests/*.mjs`, so the file an anchor sits in
does not matter.

---

## CI / Release

### `ci.yml` — independent jobs

The table below is not exhaustive and the count is deliberately left out: it went
stale once already. `.github/workflows/ci.yml` is the source of truth for which
jobs exist.

| Job | Purpose |
|---|---|
| `test` (Node 18 / 20 / 22 matrix) | `npm test` |
| `lint-runner` | `npm run lint` |
| `init-snapshot` | dry-run + actual init structure verification |
| `upgrade-snapshot` | init → upgrade JSON field verification |
| `replay` | compact-guard + personal-check contract tests |
| `hypo-absent` (Node 18 / 20 / 22) | full suite passes without HYPO_* env vars |
| `uninstall-smoke` | dry-run + apply verification |

### `nightly.yml`

| Job | Purpose |
|---|---|
| `verify-pages` | `verify_by` / `verify_by_date` frontmatter audit (fixture-based) |

### `release.yml`

Triggered by `v*` tag push:

1. Verify tag matches `package.json` version
2. `npm test` + `npm run lint`
3. `npm publish --access public --provenance`

Requires `NPM_TOKEN` secret.

> v1.1 removed the `privacy` matrix job (privacy modes deleted) and the `llm-lint` job (`/hypo:lint --llm` and `scripts/lint-llm.mjs` were retired in favor of signal-pattern lint).

---

## Plugin manifest

`.claude-plugin/plugin.json` declares the plugin to Claude Code. `hooks/hooks.json` follows the standard plugin hooks schema, and carries only what that schema knows about: an event-to-hook map, nothing else.

```json
{
  "hooks": {
    "<EventName>": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/hypo-<name>.mjs",
            "timeout": <ms>
          }
        ]
      }
    ]
  }
}
```

The shared-file list (helpers a registered hook imports, such as `hypo-shared.mjs`) is Hypomnema's own convention, not something the harness's schema recognizes, so it lives in a sibling file instead: `hooks/shared.json`, a plain JSON array of `.mjs` basenames.

```json
["hypo-shared.mjs", "version-check.mjs", "..."]
```

`hooks/hooks.json` is still the source of truth for the event-to-hook map; `hooks/shared.json` is the source of truth for the shared-file list. A hook registered in the former, or a helper listed in the latter, is what init/upgrade deploy. Anything left off either file never reaches an installed copy.

`claude plugin validate .` is run as part of CI's plugin-snapshot checks.

---

## Versioning

Hypomnema follows semver. The release tooling (`scripts/bump-version.mjs`, `CHANGELOG.md`, `release.yml`) is documented in [CONTRIBUTING.md](CONTRIBUTING.md#release-process).

Breaking schema or hook-format changes require a major bump and a corresponding `upgrade.mjs` migration fixture in `tests/upgrade.test.mjs`.
