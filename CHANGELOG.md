# Changelog

All notable changes to Hypomnema are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-06-07

### Added

- **Stale-sibling install detection — downgrade guard + PATH-CLI notice + doctor scan (ADR 0038).** When a second, older Hypomnema sits on `$PATH` (e.g. a leftover `npm i -g hypomnema`) while a newer copy owns the active hooks, running `hypomnema init` / `upgrade --apply` through the stale bin used to **silently downgrade** the newer registered hooks (dropping features like the update-notifier). Three coordinated defenses now exist: **(P, preventive)** `init` and `upgrade --apply` refuse to overwrite a newer active install — they compare the running package version against `~/.claude/hypo-pkg.json`'s `pkgVersion` using full semver and abort with **exit 2** unless `--allow-downgrade` is passed; a dev workspace re-running its own install is exempt via realpath-equal `pkgRoot` (so the post-commit sync hook and `npm link` setups are never mis-flagged). **(D3, detective — reaches the live victim)** the SessionStart notifier resolves the `hypomnema` bin on `$PATH` (fs-only; no `npm`/`which` spawn) and warns once per `(cliPath@version → activeVersion)` tuple when it is strictly older than the active install — this is the only surface that reaches a user already stuck on the old CLI, since `hypomnema doctor` invoked via the stale bin would run the *old* doctor. **(D, detective backstop)** `hypomnema doctor` adds a `PATH CLI vs active install` check (warn + `npm uninstall -g hypomnema` remediation). Note: the in-product notifier **cannot** retroactively warn installs older than v1.2.0 (the notifier did not exist yet) — that bootstrap gap is unfixable in code; the guard protects forward, and the doctor/notifier surfaces flag the stale copy on any current install.

- **`hypomnema lint --strict` promotes selected warnings to errors (spec-v1.3.0 Track E).** A new opt-in `--strict` flag promotes a frozen set of warning classes to errors so they exit 1 — a general gate for release-checklists and opt-in pre-commit hooks. Stable warning IDs were introduced (`W1` no-frontmatter, `W2` unknown-type, `W3` missing-`updated`, `W4` broken-wikilink) alongside the pre-existing `W8` (design-history stale). `--strict` promotes `STRICT_PROMOTE_IDS = {W1, W2, W4}` — confirmed content defects — while leaving `W3` (auto-repaired by `--fix`) and `W8` (handled separately by the pre-compact hook) as warnings. Default `hypomnema lint` is **byte-identical**: only `W8` exposes an `id` in `--json` output, so existing consumers (`hooks/hypo-personal-check.mjs`) are unaffected. `npm run lint` and `prepublishOnly` keep using the default mode — `--strict` is never auto-wired into CI.

- **Session-close now surfaces four advisory reflections (ADR 0029 Phase B).** The `/hypo:crystallize` session-close flow — exposed both as the `crystallize.md` slash command and the `crystallize` skill — now prompts you, *advisory-only*, on four points before composing the session payload: **(#44)** flag a trivial session and recommend skipping close (without bypassing the mandatory checklist or marking the session closed); **(#41)** when a non-trivial decision lacks an ADR, record `ADR 없음 — <reason>` in the session-log payload (it never auto-writes an ADR file); **(#42)** recommend refreshing a stale `design-history.md` (silently skips when none exists — never creates one); **(#43)** recommend `/hypo:ingest` for trustworthy external knowledge acquired in the session (user-confirmed). Every reflection is advisory: none performs an automatic action, none bypasses a gate, none writes a file on its own. A surface-drift guard test pins both surfaces to keep the four advisories and the identity-guard contract present.

### 한글 요약

- **Stale-sibling 설치 감지 — downgrade 가드 + PATH-CLI 노티 + doctor 스캔 (ADR 0038).** 더 오래된 Hypomnema가 `$PATH`를 점유(예: 남아있는 `npm i -g hypomnema`)하고 더 새 사본이 active 훅을 소유한 상황에서, stale 바이너리로 `hypomnema init` / `upgrade --apply`를 돌리면 더 새 등록 훅이 **조용히 다운그레이드**(update-notifier 등 기능 제거)되던 footgun을 막는다. 세 방어를 함께 도입: **(P, 예방)** `init`·`upgrade --apply`가 실행 중 패키지 버전과 `~/.claude/hypo-pkg.json`의 `pkgVersion`을 full semver로 비교해, active가 더 새로우면 `--allow-downgrade` 없이는 **exit 2**로 거부한다. dev workspace가 자기 자신을 재실행하는 경우는 `pkgRoot` realpath 동일성으로 면제(post-commit sync 훅·`npm link` 오탐 없음). **(D3, 탐지 — 현재 피해자에게 도달)** SessionStart notifier가 `$PATH`의 `hypomnema` 바이너리를 해석(fs-only, `npm`/`which` spawn 없음)해 active보다 엄격히 오래되면 `(cliPath@version → activeVersion)` 튜플당 1회 경고한다. stale 바이너리로 부른 `hypomnema doctor`는 *구버전* doctor를 돌리므로, 이미 옛 CLI에 갇힌 사용자에게 도달하는 유일한 경로다. **(D, 탐지 백스톱)** `hypomnema doctor`에 `PATH CLI vs active install` 체크 추가(warn + `npm uninstall -g hypomnema` 안내). 참고: in-product notifier는 v1.2.0 이전 설치(당시 notifier 미존재)에는 소급 경고할 수 **없다** — 이 bootstrap 갭은 코드로 수정 불가다. 가드는 앞으로를 보호하고, doctor/notifier 표면이 현재 설치에서 stale 사본을 적발한다.

- **`hypomnema lint --strict` warning→error 승격 (spec-v1.3.0 Track E).** opt-in `--strict` 플래그 추가 — 동결된 warning 클래스 집합을 error로 승격해 exit 1로 만든다. release-checklist / opt-in pre-commit용 범용 게이트. 안정 warning ID(`W1` no-frontmatter, `W2` unknown-type, `W3` missing-`updated`, `W4` broken-wikilink)를 기존 `W8`(design-history stale)에 더해 부여했다. `--strict`는 `STRICT_PROMOTE_IDS = {W1, W2, W4}`(확정적 콘텐츠 결함)만 승격하고, `W3`(`--fix`로 자동복구)·`W8`(pre-compact 훅이 별도 처리)은 warning으로 유지한다. 기본 `hypomnema lint`는 **byte-identical** — `--json`에서 `W8`만 `id`를 노출하므로 기존 소비자(`hooks/hypo-personal-check.mjs`)는 무영향. `npm run lint`·`prepublishOnly`는 기본 모드를 그대로 사용 — `--strict`는 CI에 자동 배선되지 않는다.

- **세션-close가 네 가지 advisory 성찰을 표면화 (ADR 0029 Phase B).** `/hypo:crystallize` 세션-close 흐름(`crystallize.md` 슬래시 커맨드 + `crystallize` 스킬 양쪽)이 세션 payload 작성 전에 네 가지를 *advisory로만* 권고한다: **(#44)** trivial 세션이면 close 스킵 권고(필수 체크리스트 우회·세션 closed 표기는 하지 않음), **(#41)** 비자명 결정에 ADR이 없으면 session-log payload에 `ADR 없음 — <이유>` 기록(ADR 파일을 auto-write 하지 않음), **(#42)** stale `design-history.md` 갱신 권고(없으면 silent skip — 생성하지 않음), **(#43)** 세션 중 습득한 신뢰할 만한 외부 지식에 `/hypo:ingest` 권고(user-confirm). 모든 성찰은 advisory다 — 자동 동작·게이트 우회·파일 자동 작성을 하는 것은 하나도 없다. surface-drift 가드 테스트가 두 표면에 네 advisory와 identity-guard 계약 문구가 present함을 pin한다.

### Fixed

- **Session-close gate no longer blocks `/compact` on lint debt this session did not create (ADR 0037).** The PreCompact gate and the crystallize apply gate both linted the *entire* vault, so unfinished session-close could be blocked by lint errors in other projects or shared pages you never touched. Each gate is now **scoped to the files this session actually touched** — the PreCompact gate to transcript-touched files ∪ the mandatory close-file targets, the apply gate to its payload files — and errors outside that scope downgrade to a non-blocking notice. A companion marker-coherence fix prevents a session from being marked closed without lint running on its own files: `--mark-session-closed --transcript-path` refuses the marker on scoped-lint failure (without `--transcript-path` it keeps the legacy freshness + clean-git recovery path), and the Stop hook surfaces the transcript path. Broken-wikilink stays `W4` warn-only (forward-references are legitimate; gating on them re-introduced friction).

- **`/hypo:feedback` scope validator accepts cwd-derived project ids (OQ-34).** The shared `scope:` validator rejected the project-id shape `deriveProjectId` emits (leading dash + mixed case, e.g. `project:-Users-you-Workspace-Project`), so writing a cwd-scoped feedback page failed lint and forced a manual `--project-id=<slug>` override. A single source-of-truth `FEEDBACK_SCOPE_RE` (`scripts/lib/feedback-scope.mjs`, imported by both `lint.mjs` and `feedback.mjs`) now accepts that form while still rejecting dot-only ids (`project:.` / `project:..`); the deriver, on-disk project dirs, and string-equality projection are unchanged.

### 한글 요약

- **세션-close 게이트가 이 세션이 만들지 않은 lint debt로 `/compact`를 더는 막지 않는다 (ADR 0037).** PreCompact 게이트와 crystallize apply 게이트가 볼트 *전체*를 lint해서, 손대지도 않은 타 프로젝트·공유 페이지의 lint error로 세션-close가 막히던 버그를 수정. 이제 각 게이트는 **이 세션이 실제로 touch한 파일로 스코프**된다 — PreCompact는 transcript-touched ∪ 필수 close-파일 타깃, apply는 자신의 payload 파일로 — 그리고 스코프 밖 error는 non-blocking notice로 강등된다. marker-coherence 보강으로 자기 파일에 lint가 돌지 않은 채 세션이 closed로 표기되는 것을 방지: `--mark-session-closed --transcript-path`가 스코프-lint 실패 시 marker를 거부하고(`--transcript-path` 없으면 legacy freshness + clean-git 복구 경로 유지), Stop 훅이 transcript path를 노출한다. broken-wikilink는 `W4` warn-only 유지(forward-reference는 정상이며, 게이트 시 마찰 재발).

- **`/hypo:feedback` scope 검증기가 cwd 유래 project id를 수용한다 (OQ-34).** 공유 `scope:` 검증기가 `deriveProjectId`가 내보내는 project-id 형태(leading dash + 대소문자 혼합, 예 `project:-Users-you-Workspace-Project`)를 거부해, cwd-스코프 feedback 페이지 작성이 lint를 통과 못 하고 수동 `--project-id=<slug>` override를 강요당했다. 단일 SoT `FEEDBACK_SCOPE_RE`(`scripts/lib/feedback-scope.mjs`, `lint.mjs`·`feedback.mjs` 양쪽 import)가 이제 그 형태를 수용하되 dot-only id(`project:.` / `project:..`)는 여전히 거부한다. deriver·on-disk project 디렉터리·string-equality projection은 변경 없음.

### Internal

- **Maintainer tooling and repo hygiene (no user-facing surface change).** `fix:verify` test-linkage CLI plus its `STUB_SPEC` vacuous-gate rejection (Track A-gate) and the fix-manifest evidence-only SoT + ADR-line grep gate (Track A-sot, ADR 0036/0039); a pre-commit auto-format hook for staged files; publish-time bilingual CHANGELOG + annotated-tag enforcement (`check-bilingual.mjs`); a `feedback-sync` per-mode source-loader refactor (byte-identical golden tests); inline-comment hygiene cleanup; `actions/checkout` + `actions/setup-node` bumped to v5; and untracking of personal dev-workflow commands (`.claude/` is now fully gitignored — the repo ships only the published plugin surface). These touch dev/CI/maintainer workflows only; the installed product surface is unchanged. 정비성·CI·maintainer 워크플로 변경만 포함하며 설치되는 제품 표면은 동일하다.

## [1.2.1] - 2026-05-26

### Fixed

- **`/hypo:resume` no longer leaks the literal `"slug"` as the active project on a fresh `init` vault (fix #68).** `scripts/resume.mjs` parsed `templates/hot.md`'s HTML-commented example row (`<!-- Row format: | ... | [[projects/slug/hot]] | -->`) as if it were a real entry, returning `slug` from the regex. Three-place defense-in-depth fix: (1) `scripts/resume.mjs` strips HTML comments before the wikilink regex AND skips the `projects/_template` scaffold in the mtime fallback (init.mjs writes `_template/session-state.md`, which would otherwise be chosen on a fresh vault); (2) `hooks/hypo-shared.mjs`'s mirrored `resolveActiveProject` applies the same comment strip; (3) `templates/hot.md` rewrites the example to no longer embed a real `[[...]]` shape. Pre-existing in v1.2.0 (confirmed via `git show v1.2.0:...`); surfaced by the v1.2.1 pre-ship QA matrix row 18 with guard D orchestrator-side live re-verification. Three new regression tests in `tests/runner.mjs` cover fresh-init graceful exit, real-project-vs-`_template`-mtime-newer override, and back-compat against vaults that still carry the pre-fix `[[projects/slug/hot]]` comment form.

### 한글 요약

- **`/hypo:resume` placeholder leak fix (#68).** 빈 vault(`init` 직후)에서 `/hypo:resume` 실행 시 `Error: no session-state.md found for project "slug"`가 나오던 버그를 수정. 근본 원인은 `templates/hot.md`의 HTML 주석 예시 `[[projects/slug/hot]]`가 wikilink-row regex에 잡혀서 literal `"slug"`를 활성 프로젝트로 반환하는 것이었습니다. v1.2.0에서도 잠복하던 결함으로(regression 아님) v1.2.1 pre-ship QA matrix row 18 가드 D 검증 단계에서 적발. 3중 방어 수정: (1) `scripts/resume.mjs`가 regex 전에 HTML 주석을 제거하고 mtime fallback에서 `projects/_template` 디렉터리를 스킵, (2) `hooks/hypo-shared.mjs`의 미러 파서에도 동일한 주석 strip 적용, (3) `templates/hot.md`의 예시 wikilink 형식을 `projects/<slug>/hot (wikilink)`로 변경해 정규식이 더 이상 매치되지 않게 함. 회귀 테스트 3건 추가 (fresh-init 정상 종료 + `_template` skip 효력 증명 + 옛 vault 백호환).

### Internal

- **`/qa-features` + `/qa-before-ship` 첫 dogfood 사이클 완료.** v1.2.0 → v1.2.1 사이 PR #67에서 도입된 두 신규 dev workflow 스킬이 첫 실가동 — 5워커 cmux 팀(codex 2 + claude 3)으로 34행 매트릭스 검증, 가드 A/B/C/D 모두 in-band 발동. 워커가 stale-install 잡아낸 가드 C, orchestrator-side 라이브 재검증으로 워커 false-positive 2건(`WORKER_EXPECTATION_MISMATCH`)을 다운그레이드한 가드 D 모두 실제로 동작. claude 워커의 cmux scrollback 캡처 타이밍 이슈(claude TUI alt-screen + `read-screen --scrollback` race)는 별도 follow-up — 가드 D의 orchestrator-side re-execution이 그 갭을 메움.

## [1.2.0] - 2026-05-24

### ⚠ Breaking

- **`SCHEMA.md` version 2.0 — `feedback` page type now requires 9 hard fields (ADR 0031 / ADR 0034, PR #60).** Pages of `type: feedback` must declare `status`, `scope`, `tier`, `targets`, `sensitivity`, `priority`, `memory_summary`, `reason`, `source`. When `targets` includes `claude-learned`, the page must additionally be `scope: global` + `tier: L1` and declare `global_summary` + `promote_to_global: true`. `hypomnema upgrade --apply` now writes `MIGRATION-v2.0.md` into the wiki root with a manual-backfill checklist; the upgrade deliberately does NOT auto-stub the fields because wrong defaults for `scope` / `tier` / `targets` / `sensitivity` / `reason` / `source` would silently project wrong behavior. `SCHEMA.md` itself remains user-owned and byte-equal across upgrade (Option C, preserved by PR #57's invariants). The migration report also carries the `project-id` ↔ slug regex caveat from PR #59 — to use `scope: project:*` in v1.2.0 you must `--project-id=<slug>` override.

### Added

- **`lint` emits `W8` design-history-stale warning (fix #49).** The PreCompact
  hook (`hypo-personal-check.mjs`) has filtered `lint --json` warns for
  `id === 'W8'` since the initial OSS hook drop, but `scripts/lint.mjs` never
  emitted that id — so `design-history.md` aging next to a fresher
  `session-log.md` (or `session-log/YYYY-MM.md` directory layout) was silently
  invisible to the gate. Lint now runs `findDesignHistoryStale()` once per
  project (outside the page loop), and emits a `W8`-tagged warn per stale
  project with a POSIX-separated `file` literal (`projects/<name>/design-history.md`)
  so the consumer's `file.split('/')` contract stays portable. The JSON `warn`
  shape gains an optional `id` field, omitted for legacy id-less warns.

- **`lint` emits `W8` design-history-stale warning (fix #49).** The PreCompact
  hook (`hypo-personal-check.mjs`) has filtered `lint --json` warns for
  `id === 'W8'` since the initial OSS hook drop, but `scripts/lint.mjs` never
  emitted that id — so `design-history.md` aging next to a fresher
  `session-log.md` (or `session-log/YYYY-MM.md` directory layout) was silently
  invisible to the gate. Lint now runs `findDesignHistoryStale()` once per
  project (outside the page loop), and emits a `W8`-tagged warn per stale
  project with a POSIX-separated `file` literal (`projects/<name>/design-history.md`)
  so the consumer's `file.split('/')` contract stays portable. The JSON `warn`
  shape gains an optional `id` field, omitted for legacy id-less warns.
- **`hypomnema upgrade --codex` mirrors core hooks (fix #48).** `init --codex`
  has always installed Hypomnema's core hooks into `~/.codex/hooks/` and
  registered them in `~/.codex/settings.json`, but `upgrade` only mirrored
  user extensions — so a v1.1.x → v1.2.0 codex user's core hooks stayed
  stale until a fresh install. The flag now drives drift detection, hook-file
  apply, settings.json registration, and the `wiki-*.mjs → hypo-*.mjs` rename
  migration on both targets in one pass. The human-readable report labels
  the two blocks ("Hook files (codex)", "settings.json (codex)") and JSON
  output gains `hooksCodex` / `settingsCodex` / `oldHookRefsCodex` plus
  matching `applied.*Codex` keys. Without `--codex` nothing under `~/.codex/`
  is inspected (parity with the existing extensions behaviour).
- **Auto-project creation on cwd match (ADR 0023).** When you start a session
  (or change directory) inside a git repository that carries a project marker
  (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`,
  `build.gradle`, `composer.json`, `Gemfile`) but matches no existing wiki
  project's `working_dir`, the SessionStart/CwdChanged hook now offers to create
  one. The offer is a nudge only; on "Y" Claude runs the new internal scaffold
  helper (`scripts/lib/project-create.mjs`) which materializes the project from
  `templates/projects/_template/` with token substitution, adds the root
  `hot.md` pointer row, and logs the creation. On "N" the cwd is recorded under
  `skips[]` in `.cache/project-suggestions.json` and never offered again (a
  5-minute per-cwd cooldown also suppresses repeats within a session). Temp and
  marker-less directories never trigger the offer. `hypomnema doctor` validates
  the skip-persistence file's schema. The deprecated `hypomnema project new`
  subcommand is not introduced (ADR 0023). Also strengthens the templated
  Session Start guidance: the first response must lead with a resume summary.
- **Update notifier.** The SessionStart hook now shows an "Update available!"
  banner when a newer Hypomnema version has been published, detecting both
  distribution channels (npm package and Claude Code plugin) and printing the
  channel-appropriate update command (`npm install -g hypomnema`, or
  `/plugin marketplace update hypomnema` + `/reload-plugins`). The check never
  blocks session start: the hook reads a 24-hour cache only, and a detached
  worker refreshes it out-of-band, so a newer version surfaces from the next
  session. Per-channel notification state prevents the same banner from
  repeating, and `current >= latest` (local dev) is silently skipped. Opt out
  with `HYPO_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, or `CI`.
- **`feedback`-as-source-of-truth + one-way projections to MEMORY / `<learned_behaviors>` (ADR 0031, fix #37, PR #36).** A new `pages/feedback/<slug>.md` page type replaces ad-hoc human-side sync of behavior corrections across three storage surfaces. `hypomnema feedback-sync` derives `~/.claude/projects/<project-id>/memory/MEMORY.md` (200-line cap) and `~/.claude/CLAUDE.md` `<learned_behaviors>` (max 10 entries, strict gate: `scope:global` + `tier:L1` + `targets:claude-learned` + `promote_to_global:true` + `sensitivity ∈ {public, sanitized}`) from the wiki. Managed blocks are marker- and hash-fenced; hand-edits are flagged as `CONFLICT_MANUAL_EDIT`. PreCompact integration runs inside `hypo-personal-check` (single-blocking-gate invariant). `sensitivity: private` is forbidden — the wiki is git-pushed; private data must stay outside the wiki entirely. `/hypo:feedback` slash command writes pages directly; `hypomnema feedback-sync --bootstrap` scaffolds drafts from existing MEMORY/CLAUDE state under `pages/feedback/_drafts/` for human review.
- **Extensions companion sync (ADR 0024, PRs #42~#47).** A new `extensions/` taxonomy in the wiki (`agents/`, `commands/`, `hooks/`, `skills/`) lets users ship Claude Code / Codex companion files alongside their wiki. `hypomnema init` scaffolds the directory; `hypomnema upgrade` mirrors the inventory into `~/.claude/` and (with `--codex`) **only the `hooks` and `commands` subset** into `~/.codex/` (agents/skills are Claude-only and skipped on the Codex target by design — see `scripts/lib/extensions.mjs` `CODEX_TYPES`). Conflict detection (`--force-extensions` to overwrite), and `hypomnema doctor extensions` audits integrity (orphan duplicates, matcher drift, non-registrable orphans). `hypomnema uninstall` cleans up the companion files. PR #49 added settings.json mixed-group surgical write so settings.json edits stay minimal and merge-friendly.
- **`hypomnema upgrade --codex` mirrors core hooks (fix #48, PR #50).** `init --codex`
  has always installed Hypomnema's core hooks into `~/.codex/hooks/` and
  registered them in `~/.codex/settings.json`, but `upgrade` only mirrored
  user extensions — so a v1.1.x → v1.2.0 codex user's core hooks stayed
  stale until a fresh install. The flag now drives drift detection, hook-file
  apply, settings.json registration, and the `wiki-*.mjs → hypo-*.mjs` rename
  migration on both targets in one pass. The human-readable report labels
  the two blocks ("Hook files (codex)", "settings.json (codex)") and JSON
  output gains `hooksCodex` / `settingsCodex` / `oldHookRefsCodex` plus
  matching `applied.*Codex` keys. Without `--codex` nothing under `~/.codex/`
  is inspected (parity with the existing extensions behaviour).
- **`hypomnema upgrade` v1→v2 migration report (ADR 0034, PR #60).** Major SCHEMA bump now writes `MIGRATION-v2.0.md` into the wiki root with v1→v2-specific guidance: ADR 0031 / ADR 0034 references, all 9 unconditional `feedback` fields, the conditional `claude-learned` set, the explicit no-auto-stub policy, the "fix existing pages before `/hypo:feedback` append" warning, the PR #59 `project-id` ↔ slug regex caveat, and a closing re-run-lint checklist. Other major jumps keep the original generic body. PR #57 invariants preserved: `SCHEMA.md` is byte-equal after `--apply` (Option C), report tag stays `[schema]` (the only token historically valid across all shipped Meta vocabularies).
- **PostToolUse WebFetch / WebSearch auto-ingest signal (fix #2, PR #48).** When Claude resolves a URL via WebFetch or runs WebSearch, the PostToolUse hook injects a nudge in `hookSpecificOutput.additionalContext` so Claude considers running `/hypo:ingest`. URL query/hash tokens and userinfo (`user:pass@host`) are stripped before injection. Non-HTTP schemes (`file://`, `ftp://`, `data:`) and missing URLs are silent skips. Opt out with `HYPO_SKIP_GATE=1`. Fail-open on invalid JSON stdin; stderr carries the unified `[hypo-web-fetch-ingest] error:` tag.
- **Stop-chain auto-minimal-crystallize (ADR 0022 Layer 3, PR #34).** A session that crossed a "non-trivial" threshold now offers (and on `Y` runs) `/hypo:crystallize --apply-session-close --minimal` automatically from the Stop hook chain. Combined with PR #31~#33 `/clear` detection and SessionEnd marker / SessionStart `source=clear` recovery, the personal-check gate now catches forgotten session closes and reopens cleanly when the user runs `/clear`.
- **`crystallize --apply-session-close` programmatic entrypoint (PRs #21, #23~#26).** Strict 11-step session-close validation (PreCompact hard gate + crystallize). `--payload <json>` and `--apply-session-close` make the path machine-callable from the Stop hook chain; `--probe` early-exit (option D) keeps no-op closes fast. Lint preflight + post-apply gate ensures the wiki ends up clean.
- **Auto-project creation on cwd match (ADR 0023, PR #41).** When you start a session
  (or change directory) inside a git repository that carries a project marker
  (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`,
  `build.gradle`, `composer.json`, `Gemfile`) but matches no existing wiki
  project's `working_dir`, the SessionStart/CwdChanged hook now offers to create
  one. The offer is a nudge only; on "Y" Claude runs the new internal scaffold
  helper (`scripts/lib/project-create.mjs`) which materializes the project from
  `templates/projects/_template/` with token substitution, adds the root
  `hot.md` pointer row, and logs the creation. On "N" the cwd is recorded under
  `skips[]` in `.cache/project-suggestions.json` and never offered again (a
  5-minute per-cwd cooldown also suppresses repeats within a session). Temp and
  marker-less directories never trigger the offer. `hypomnema doctor` validates
  the skip-persistence file's schema. (Already listed above; this version's PR #41 also strengthens templated Session Start guidance: first response must lead with a resume summary.)
- **First-prompt resume summary + cwd-change re-trigger (PR #39).** SessionStart's resume nudge now forces the resume summary on the first response, and a cwd change inside the session re-triggers the project match check (so opening a new repo without restarting Claude still picks up the right project).
- **Unified `[hypo-<name>] error:` stderr log tag across all lifecycle hooks (PR #40).** Every hook (`hypo-cwd-change`, `hypo-first-prompt`, `hypo-compact-guard`, `hypo-file-watch`, `hypo-lookup`, `hypo-personal-check`, `hypo-auto-minimal-crystallize`, `hypo-auto-stage`, `hypo-web-fetch-ingest`) emits its forced-catch path with the same `[hypo-<name>] error: ...` prefix so dogfood log triage is grep-friendly.
- **`weekly-report` migrates output to `journal/weekly/<YYYY-Www>.md` (PR #29).** Single source of truth per spec §6.4. Old report locations are no longer written.
- **Lint type-conditional fields + tag vocabulary lock (PRs #28, #38).** Lint now enforces per-type required fields and rejects unknown tags (vocabulary outside SCHEMA `Tag Vocabulary`). PR #38 adds `B6` warn for `pages/` subdirs absent from SCHEMA taxonomy.
- **`.hypoignore` privacy guards (PRs #19, #20, #27).** `/hypo:ingest` honors `.hypoignore`; `.hypoignore` is kept in sync with `.gitignore`; a pre-commit hook prevents private-marked content from leaking. `.hypoignore` is now enforced on **all** wiki content-injection hooks (#27).
- **Self-natural-close pattern detection (PR `91e1c91`).** Behavioral rule layer-1 — the personal-check gate now recognizes natural-language close phrases ("이만 마무리", "오늘 여기까지", etc.) and offers the session-close flow.
- **Prettier setup + format pass (chore commits `dbc228f`, `4dac33c`, `4696abf`).** Repository-wide Prettier config + `npm run format` / `format:check` scripts. `.git-blame-ignore-revs` for the reformat commit so `git blame` stays clean.

### Changed

- **`feedback-sync` MEMORY projection is now strictly cwd-scoped (ADR 0031 §4 amendment, PR #59).** `memoryTarget.filter` previously accepted any `scope: project:*` page regardless of the resolved project-id, so a `scope: project:other` page was silently projected into `~/.claude/projects/<this-project>/memory/`. The filter is now `scope === 'global' || scope === \`project:${projectId}\`` (exact match). `templates/SCHEMA.md` §3.1 and `commands/feedback.md` `--scope` flag clarify that `<project-id>` must exact-match the resolved project-id (default: `cwd → '/'.'.' → '-'`; or `--project-id=<id>` override). Mismatch = silent MEMORY skip (not a lint error). The lint regex `^project:[a-z0-9][a-z0-9-]*$` and the default cwd-derived id are incompatible — to use a `project:*` scope you must `--project-id=<slug>` override. Full resolved-id ↔ wiki-slug reconciliation is deferred to v1.3.0.
- **`hypomnema upgrade` migration report tag historical regression fix (별도 잔여 #5, PR #57).** `writeMigrationReport()` previously emitted `tags: [hypomnema, migration, schema]`, but the v1.0 / v1.1 historical Meta vocab is `wiki, index, operations, guide, schema` — neither `hypomnema` nor `migration` are present. Because Option C deliberately does NOT touch the user's `SCHEMA.md`, a v1.0 / v1.1 user upgrading would have a lint-failing page created at the wiki root. Tag tightened to `[schema]` (the only token historically valid). Added two regression tests: `--apply leaves user SCHEMA.md byte-equal` (Option C contract) and `--apply migration report tags are all in installed SCHEMA vocab` (vocab-level assertion, with the installed Meta vocab back-dated to the oldest shipped set). Also clarified `upgrade.mjs` dry-run wording and removed the self-referential "Run /hypo:upgrade --apply" action item from the report body.

### Fixed

- **`doctor` orphan duplicate scan + matcher drift surfacing (PRs #53~#56, fix #47 / PR #54 follow-ups).** `doctor extensions` now surfaces non-registrable orphans, gated `matcher:""` specific message on `hookExact`, and reports orphan duplicate counts. `parseManifest` handles empty matcher; the canonical-pick mirror keeps the doctor view aligned with the actual registered hook.
- **`extensions` settings.json mixed-group surgical write (fix #47, PR #49, ADR 0024 amendment).** Edits to `settings.json` for extensions registration are now surgical inside mixed groups, leaving siblings + matcher in the source group exactly as found.
- **`crystallize --apply-session-close` lint preflight + post-apply gate (fix #40, PR #25).** Lint runs before AND after the apply to fail loudly on dirty input or post-write drift.
- **PreCompact `/clear` detection + SessionEnd marker recovery (PRs #31~#33, fix #25/#26 + amendments, ADR 0022).** `compact-guard` detects `/clear` so it does not block; `personal-check` capacity bypass removed (#32); SessionEnd marker + SessionStart `source=clear` recovery makes /clear-then-restart cleanup work end-to-end.
- **Test hermeticity — child HOME isolation in `tests/runner.mjs` (fix #3, PR #30).** Tests no longer rely on the dev's real `$HOME`; child processes get an isolated home so external writes can't pollute or break the suite.
- **`withWiki()` fixture date local-time alignment (fix #39, PR #52).** UTC vs local boundary flake removed.

### Maintenance

- **Code comment cleanup Phase 1 (PR #58).** 13 files, comment-only diff (0 non-comment line changes verified by gate). Removed rot-prone references — `(fix #NN)`, `(PR #NN follow-up)`, `(codex BLOCKER/CONCERN/...)`, `v120-*`, `stage-N-#M`, `(#NN scope)` — while preserving ADR / contract / spec / plan / Layer / § anchors. PR descriptions are now the canonical location for fix/PR/issue cross-references; in-code comments stay about the WHY.

### 한글 요약

**Breaking 변경**
- **SCHEMA 2.0 — `feedback` page 9 hard 필드 + claude-learned conditional 2 필드 강제.** `hypomnema upgrade --apply` 시 `MIGRATION-v2.0.md`가 자동 작성되어 backfill checklist 제공. `SCHEMA.md`는 사용자 소유 (Option C 보존, byte-equal). 자동 stub은 거부 — `scope` / `tier` / `targets` / `sensitivity` / `reason` / `source`는 의미 결정이라 wrong default가 wrong behavior로 이어짐.

**핵심 신규**
- **`feedback`-as-SoT + 단방향 projection** (ADR 0031): `pages/feedback/<slug>.md`가 행동 교정의 단일 source-of-truth. `hypomnema feedback-sync`로 MEMORY.md (cwd-scoped, 200줄 cap) + CLAUDE.md `<learned_behaviors>` (max 10, 엄격 게이트) 자동 동기.
- **Extensions companion sync** (ADR 0024): wiki에 `extensions/{agents,commands,hooks,skills}` 동봉. init/upgrade가 `~/.claude/` (+`--codex`로 `~/.codex/`) 미러링, conflict 감지, doctor 무결성 검사.
- **Auto-project creation on cwd match** (ADR 0023): git project marker 있는 cwd에 wiki project 없으면 SessionStart에서 생성 권유.
- **Stop-chain auto-minimal-crystallize** + `/clear` 감지 + SessionEnd marker 복구 (ADR 0022): session 종료 누락 → 자동 minimal crystallize 권유 → `/clear` 후 재시작 시 깔끔 복구.
- **Update notifier**: SessionStart에서 신규 버전 알림 (npm 패키지 / Claude Code plugin 두 채널), opt out: `HYPO_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` / `CI`.
- **PostToolUse WebFetch / WebSearch auto-ingest 신호**: URL fetch 시 `/hypo:ingest` 권유 nudge 자동 주입 (privacy redaction 포함).

**Changed**
- **`feedback-sync` MEMORY cross-project pollution fix** (PR #59 / ADR 0031 §4 amendment): `scope: project:*` exact-match 강제.
- **`hypomnema upgrade` migration report tag historical regression fix** (PR #57): tag `[schema]`로 좁힘 — v1.0/v1.1 historical vocab에 있는 유일 안전 토큰.

**Fixed**
- doctor orphan duplicate scan + matcher drift (PR #53~#56)
- extensions settings.json mixed-group surgical write (PR #49)
- crystallize lint preflight + post-apply gate (PR #25)
- test hermeticity HOME isolation (PR #30), withWiki fixture date flake (PR #52)

**Maintenance**
- Code comment rot cleanup Phase 1 — 13 files comment-only diff. `fix #NN` / `PR #NN follow-up` 등 시간에 따라 stale 되는 참조 제거, ADR / contract / spec anchor 보존.

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
