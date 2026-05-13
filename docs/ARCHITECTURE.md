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
│  Lifecycle hooks (10)         (background automation)         │
│  ├──► SessionStart, UserPromptSubmit, PreCompact,             │
│  │    PostToolUse, Stop, CwdChanged, FileChanged              │
│  └──► hypo-shared.mjs         (deployed inline; no imports)   │
└──────────────────────────────────────────────────────────────┘
```

The three layers are deliberately **decoupled by file artifacts**. Slash commands write markdown. Hooks read markdown. The vault is the integration boundary — there is no in-process state shared across the layers.

---

## Package layout

```
hypomnema/
├── commands/                 ← slash command definitions (.md prompts)
├── hooks/                    ← lifecycle hooks deployed to ~/.claude/hooks/
│   ├── hypo-*.mjs                ← 10 hook files (see Hook registry below)
│   ├── hypo-shared.mjs           ← shared utilities, inlined at deploy
│   └── hooks.json                ← single source of truth for event ↔ hook mapping
├── scripts/                  ← Node.js implementations
│   ├── init.mjs / upgrade.mjs / uninstall.mjs / doctor.mjs
│   ├── ingest.mjs / query.mjs / lint.mjs / verify.mjs / graph.mjs / stats.mjs
│   ├── crystallize.mjs / resume.mjs / feedback.mjs
│   ├── bump-version.mjs          ← release helper
│   └── lib/                      ← scripts-only helpers
│       ├── frontmatter.mjs
│       ├── hypo-root.mjs
│       └── hypo-ignore.mjs
├── skills/                   ← Agent Skills — skills/<name>/SKILL.md
├── templates/                ← baseline files copied on init
│   ├── hypo-config.md, index.md, hot.md, log.md, SCHEMA.md, hypo-guide.md
│   ├── Home.md, Overview.md, hypo-automation.md, hypo-help.md
│   ├── pages/_index.md
│   └── projects/_template/
├── tests/runner.mjs          ← no-dependency test runner
├── docs/                     ← ARCHITECTURE.md, CONTRIBUTING.md
├── .claude-plugin/plugin.json← plugin manifest
└── package.json              ← npm metadata, no runtime deps
```

The package has **zero npm runtime dependencies**. Everything is Node.js built-ins (`fs`, `path`, `os`, `child_process`, `crypto`).

---

## Slash commands

Each user-facing operation is a pair: an LLM-facing prompt + a Node.js script.

| File | Role |
|---|---|
| `commands/<name>.md` | Prompt definition — instructions Claude follows when the command is invoked |
| `scripts/<name>.mjs` | Script implementation — Node.js logic the prompt may call via Bash |

**Commands shipped in v1.1:** `init`, `doctor`, `upgrade`, `uninstall`, `ingest`, `query`, `crystallize`, `resume`, `feedback`, `verify`, `lint`, `stats`, `graph`.

The synthesis-heavy commands (`ingest`, `query`, `crystallize`, `lint`, `verify`, `graph`) are also exposed as Agent Skills.

---

## Agent Skills

`skills/<name>/SKILL.md` follows the Claude Agent Skills convention (per ADR `decisions/0001` in the wiki). When a conversation matches the skill's description, Claude auto-loads it without needing the slash command.

> v1.0 originally planned flat `skills/*.md` files; v1.1 switched to `<name>/SKILL.md` for compatibility with the official Agent Skills loader.

---

## Lifecycle hooks

Hooks run automatically at Claude Code lifecycle events. They are deployed to `~/.claude/hooks/` by `init` / `upgrade`, and registered in `~/.claude/settings.json`.

### Hook registry (`hooks/hooks.json`)

`hooks.json` is the **single source of truth** for hook ↔ event mapping. `init`, `upgrade`, and `doctor` all read from it; the previous v1.0 design that maintained three separate `HOOK_MAP` constants was deleted in v1.1. A `git post-commit` hook re-applies upgrades when this file changes.

| Event | Hooks (in order) |
|---|---|
| `SessionStart` | `hypo-session-start.mjs` |
| `UserPromptSubmit` | `hypo-first-prompt.mjs` → `hypo-lookup.mjs` → `hypo-compact-guard.mjs` |
| `PreCompact` | `hypo-personal-check.mjs` |
| `PostToolUse` (Write/Edit) | `hypo-auto-stage.mjs` |
| `Stop` | `hypo-hot-rebuild.mjs` → `hypo-session-record.mjs` → `hypo-auto-commit.mjs` |
| `CwdChanged` | `hypo-cwd-change.mjs` |
| `FileChanged` | `hypo-file-watch.mjs` |

### Hook responsibilities

| Hook | Responsibility |
|---|---|
| `hypo-session-start` | Inject `index.md`, root `hot.md`, project `hot.md`/`session-state.md`. Run `git pull --ff-only` (silent fail on missing remote) |
| `hypo-first-prompt` | Marker-based one-shot `hot.md` injection on first user prompt (10-min TTL) — for sessions that bypass `SessionStart` |
| `hypo-lookup` | BM25 search over the wiki on every prompt. **HIT** → inject top-3 page snippets (≤2000 chars each, with verify-by-date warnings). **MISS** → emit closest-slug signal that prompts Claude to research + `/hypo:ingest` |
| `hypo-compact-guard` | Detect `/compact` invocations → enforce session-close checklist before allowing compact |
| `hypo-personal-check` | PreCompact validation: lint blockers, uncommitted changes, missing session-log entries → block compact |
| `hypo-auto-stage` | After Write/Edit on a wiki path, run `git add` (skips paths matching `.hypoignore`) |
| `hypo-hot-rebuild` | At session stop, regenerate root `hot.md` from recent activity; emit growth metrics + cache for next SessionStart |
| `hypo-session-record` | At session stop, append `{session_id, transcript_path, recorded_at, cwd}` to `.cache/sessions/index.jsonl` (primary source for the observability audit) |
| `hypo-auto-commit` | At session stop, filter changed paths through `.hypoignore`, commit non-ignored changes, `git pull --no-rebase` + `git push` (silent fail on missing remote) |
| `hypo-cwd-change` | When working directory changes, re-resolve the active project and inject its `hot.md` |
| `hypo-file-watch` | Notify on external wiki edits so the in-session view stays consistent |

### Deployment constraint

Hooks run in an isolated environment at `~/.claude/hooks/`. They **cannot import from relative paths** outside their own directory. Therefore:

- All shared hook logic lives in `hypo-shared.mjs`.
- `hypo-shared.mjs` is declared via the `shared` field in `hooks.json` and copied alongside hooks at deploy time.
- Hook utilities use **only Node.js built-ins** — no relative imports, no npm dependencies.

Scripts in `scripts/` are not deployed — they run from the package install path — so they can import from `scripts/lib/`.

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
| `buildOutput(...)` | Format hook output for Claude Code's `additionalContext` channel |
| `SESSION_STATE_NEXT_HEADINGS` | Allowed headings for "next tasks" — `## 다음 이어받기` / `## 다음 작업`. Lint reuses this constant (DRY) |

---

## Scripts lib (`scripts/lib/`)

Helpers used by command scripts only. Not deployed to hooks.

| File | Purpose |
|---|---|
| `frontmatter.mjs` | Parse and serialize YAML frontmatter |
| `hypo-root.mjs` | Wiki root resolution (mirrors hook logic, allows imports) |
| `hypo-ignore.mjs` | `.hypoignore` parsing (mirrors hook logic, allows imports) |

---

## Wiki vault layout

```
<hypo-root>/
├── hypo-config.md        ← root marker + settings (presence == wiki root)
├── index.md              ← searchable page catalog
├── hot.md                ← active project pointers (root-level)
├── log.md                ← append-only activity log
├── SCHEMA.md             ← type system reference
├── hypo-guide.md         ← operations guide
├── .hypoignore           ← glob patterns the hooks must ignore
├── pages/                ← permanent knowledge pages
│   └── feedback/         ← AI behavior corrections
├── projects/             ← per-project artifacts
│   └── <name>/
│       ├── hot.md            ← project-level current state
│       ├── session-state.md  ← next tasks + last session summary
│       └── session-log/
│           └── YYYY-MM.md    ← append-only monthly session log
├── journal/
│   ├── daily/
│   ├── weekly/
│   └── monthly/
└── sources/              ← raw ingested sources (append-only, never edit)
```

`hypo-config.md` presence is the wiki root marker. `resolveHypoRoot()` scans for it from cwd up to `$HOME`.

---

## Configuration resolution

The wiki path is resolved in this order:

1. **`HYPO_DIR` environment variable** — explicit override
2. **`hypo-config.md` scan** — walk from current dir up to `$HOME`
3. **`~/hypomnema`** — default fallback

Hooks inline this logic in `hypo-shared.mjs`. Scripts use `scripts/lib/hypo-root.mjs` (functionally identical, but importable).

`PKG_ROOT` is stored in `~/.claude/hypo-pkg.json` by `init`. `hypo-personal-check.mjs` uses it to locate the lint script (`PKG_ROOT ?? HYPO_DIR`); `upgrade --apply` detects drift and refreshes it.

---

## Init and upgrade flow

### `/hypo:init`

1. Wizard collects: wiki path, hook scope (`~/.claude` and/or `~/.codex`), git remote URL.
2. Creates the vault directory structure: `pages/`, `projects/`, `sources/`, `journal/{daily,weekly,monthly}/`.
3. Copies `templates/` files: 6 root files (`hypo-config.md`, `index.md`, `hot.md`, `log.md`, `SCHEMA.md`, `hypo-guide.md`) + 4 helpers (`Home.md`, `Overview.md`, `hypo-automation.md`, `hypo-help.md`) + `pages/_index.md` + `projects/_template/`.
4. Deploys 10 hooks to `~/.claude/hooks/` and merges entries into `~/.claude/settings.json` (idempotent; preserves non-hypo hooks).
5. Writes `~/.claude/hypo-pkg.json` with `pkgRoot` for upgrade tracking.
6. `git init` + first commit `init: hypomnema wiki`. Pushes to remote when one is provided.

`--dry-run` previews; `--no-hooks` and `--no-git-init` are also supported. Re-running `init` is idempotent — existing files are skipped, never overwritten.

### `/hypo:upgrade`

1. Reads `pkgRoot` from `~/.claude/hypo-pkg.json`.
2. Re-deploys hooks from the current package version.
3. Re-merges `settings.json` entries.
4. Detects drift (e.g., `pkgRoot` no longer exists) and refreshes the pointer.
5. `--json` output emits `{ schema, hooks, settings, applied }`. `--dry-run` previews; `--apply` commits changes.

### `/hypo:uninstall`

Removes hypo-prefixed hooks from `~/.claude/hooks/` and matching entries from `~/.claude/settings.json`. **Non-hypo hooks are preserved**. The wiki vault itself is never touched.

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
  │     ├─► inject index.md / hot.md / project session-state.md
  │     └─► (Claude resumes work)
  │
  ├─► UserPromptSubmit (every prompt)
  │     ├─► hypo-first-prompt.mjs (one-shot, 10min TTL)
  │     ├─► hypo-lookup.mjs (BM25 inject)
  │     └─► hypo-compact-guard.mjs (block /compact when checklist incomplete)
  │
  ├─► PostToolUse(Write/Edit)
  │     └─► hypo-auto-stage.mjs (git add)
  │
  ├─► PreCompact
  │     └─► hypo-personal-check.mjs (lint + session-close gate)
  │
  ├─► CwdChanged
  │     └─► hypo-cwd-change.mjs (re-inject project hot.md)
  │
  └─► Stop
        ├─► hypo-hot-rebuild.mjs (regenerate root hot.md + growth cache)
        ├─► hypo-session-record.mjs (append .cache/sessions/index.jsonl)
        └─► hypo-auto-commit.mjs (.hypoignore-filtered stage + commit + pull + push)
```

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
pages/observability/<YYYY-WW>.md           ← committed report (heuristic v0)
```

### Transcript dual-source (ADR 0019)

`session-audit.mjs` reads transcripts from two locations, in priority order:

1. **Primary:** `<hypo-root>/.cache/sessions/index.jsonl` — written by the Stop hook `hypo-session-record.mjs`. Each line: `{ session_id, transcript_path, recorded_at, cwd }`.
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

### Growth metrics (Lane B)

A separate, lightweight counter — distinct from the audit pipeline — runs at every Stop / SessionStart pair:

- **Stop** (`hypo-hot-rebuild.mjs`) computes `{ addedPages, updatedPages, newWikilinks }` by reading `git status --porcelain` plus a conditional `git diff HEAD --unified=0`, writes the result to `<hypo-root>/.cache/last-session-growth.json`, and echoes one line to stderr.
- **SessionStart** (`hypo-session-start.mjs`) reads the cache and surfaces the same line in both stderr (cyan) and the LLM's `additionalContext` so user and model see the same "직전 세션" prefix.

If `git status` shows no `.md` changes, the diff step is skipped — Stop hook fast path.

### Citation convention

The six writer-side skills (`crystallize`, `query`, `ingest`, `verify`, `graph`, `lint`) carry an identical footer instructing Claude to cite wiki pages inline as `[[page-slug]]`. The audit script counts these citations as a "wiki was actually consulted" signal in future iterations.

---

## Privacy & exclusions

`.hypoignore` is the **only** privacy mechanism. The v1.0 `personal / shared / public` mode matrix was deleted in v1.1 — every privacy decision turned out to be a per-path question, and a single ignore file handles per-path natively.

Default patterns: `*.pdf`, `*.zip`, `*.pem`, `*.env`, `*.key`, `*.crt`, `*credentials*`, `*secret*`. The user edits this file directly.

`.hypoignore` is consumed by `loadHypoIgnore()` / `isIgnored()` in both hook and script contexts, and `lint` raises a `B5` blocker if a `.hypoignore`-matched file is present in tracked content.

---

## Testing

| Layer | Coverage |
|---|---|
| `hypo-shared.mjs` utilities | 7 unit tests |
| `hypo-compact-guard.mjs` contract | 8 input/output tests |
| `hypo-personal-check.mjs` contract | 6 input/output tests |
| `init.mjs` smoke | ~6 (idempotency, dry-run, hook merge) |
| `doctor.mjs` smoke | ~5 |
| `upgrade.mjs` regression | ~10 (includes migration fixture) |
| `lint.mjs` (fix / json / session-state) | ~10 |
| Misc (`expandHome`, `resolveHypoRoot`, …) | ~remainder |
| **Total** | Run `npm test` for the live count |

Run with `npm test`. The runner uses only Node.js built-ins; tests create scoped temp dirs and clean up after themselves. The count above is a layout sketch — exact totals shift as lanes ship, so `npm test` is the source of truth.

---

## CI / Release

### `ci.yml` — 7 independent jobs

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

`.claude-plugin/plugin.json` declares the plugin to Claude Code. `hooks/hooks.json` follows the standard plugin hooks schema:

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
  },
  "shared": ["hypo-shared.mjs"]
}
```

`claude plugin validate .` is run as part of CI's plugin-snapshot checks.

---

## Versioning

Hypomnema follows semver. The release tooling (`scripts/bump-version.mjs`, `CHANGELOG.md`, `release.yml`) is documented in [CONTRIBUTING.md](CONTRIBUTING.md#release-process).

Breaking schema or hook-format changes require a major bump and a corresponding `upgrade.mjs` migration fixture in `tests/runner.mjs`.
