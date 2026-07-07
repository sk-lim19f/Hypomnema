# Changelog

All notable changes to Hypomnema are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.6.1] - 2026-07-07

### Bug Fixes

#### English

- Session close no longer nags prematurely on a conditional or deferred wrap-up. When you signal a close but the session still has uncommitted wiki changes or an in-flight delegated subagent, and the phrasing is ambiguous ("once X is done, wrap up"), the autoclose prompt now asks you via a question whether to close now instead of silently reporting an incomplete close. A "not yet" answer is remembered until you signal a fresh close, so you are not re-asked every turn.
- `cwd`-first resume can now anchor a project that was missing its `working_dir`. `doctor` warns when a project with session history has no `index.md` `working_dir` anchor, and a session whose directory name matches an existing anchorless project offers to backfill the anchor instead of creating a duplicate project.

#### 한국어

- 조건부나 유예된 세션 마무리에서 조기 nag가 사라졌습니다. close를 신호했지만 위키에 커밋되지 않은 변경이나 진행 중인 위임 작업이 남아 있고 문구가 모호할 때("~하면 마무리"), autoclose가 조용히 미완료를 보고하는 대신 지금 닫을지 질문으로 되묻습니다. "아직" 응답은 새 close 신호가 나올 때까지 기억되어 매 턴 다시 묻지 않습니다.
- `working_dir`이 없던 프로젝트도 `cwd`-first resume이 앵커할 수 있습니다. `doctor`가 세션 기록은 있는데 `index.md` `working_dir` 앵커가 없는 프로젝트를 경고하고, 디렉터리 이름이 앵커 없는 기존 프로젝트와 일치하는 세션에서는 중복 생성 대신 앵커 backfill을 제안합니다.

### Chores

#### English

- Lint flags a stray `working_dir` or `project` field on a session-state page (those belong only on a project index), catching an unvalidated writer that had been planting a wrong path into injected session context.

#### 한국어

- lint이 session-state 페이지에 잘못 들어간 `working_dir`·`project` 필드를 표시합니다(이 필드는 프로젝트 인덱스에만 유효). 무검증 writer가 주입되는 세션 컨텍스트에 잘못된 경로를 심던 문제를 잡습니다.

### Changelog

- [#174](https://github.com/sk-lim19f/Hypomnema/pull/174) v1.6.1: session-close conditional reconfirm, working_dir provenance hardening (doctor anchor check + cwd-change backfill offer), session-state forbidden-field lint

Contributors: @sk-lim19f

## [1.6.0] - 2026-07-06

### New Features

#### English

- Reverse extension capture: a new `hypomnema capture` subcommand and `/hypo:capture` slash command pull a command or agent you created the normal way under `~/.claude/{commands,agents}/` into the wiki, so the existing forward-sync propagates it to your other machines under its original install name. A synced command stays `/mycmd` instead of becoming `/hypo-ext-mycmd`, which closes the "register on one machine, sync on another" gap for extensions you author by hand. ([#170](https://github.com/sk-lim19f/Hypomnema/pull/170))
- Capture now covers hooks as well: a hook you registered by hand in `settings.json`, with its script under `~/.claude/hooks/`, is captured into the wiki and re-registered on your other machines under its original name and event. Only a hook that round-trips losslessly is captured; anything non-canonical is left untouched with a visible skip reason. ([#172](https://github.com/sk-lim19f/Hypomnema/pull/172))

#### 한국어

- 역방향 확장 capture: `hypomnema capture` 서브커맨드와 `/hypo:capture` 슬래시 커맨드가 `~/.claude/{commands,agents}/`에 보통 방식으로 만든 command·agent를 위키로 끌어와, 기존 forward-sync가 다른 머신에 원래 설치 이름 그대로 전파합니다. 동기화된 커맨드가 `/hypo-ext-mycmd`가 아니라 `/mycmd`로 유지돼, 손으로 만든 확장의 "한 머신에서 등록, 다른 머신에서 동기화" 갭을 메웁니다. ([#170](https://github.com/sk-lim19f/Hypomnema/pull/170))
- capture가 hooks까지 지원합니다: `settings.json`에 손으로 등록한 훅(스크립트가 `~/.claude/hooks/` 아래)을 위키에 담아 다른 머신에 원래 이름과 event로 재등록합니다. 무손실로 라운드트립되는 정규형 훅만 대상이고, 그 밖의 형태는 건드리지 않고 보이는 skip 사유로 남깁니다. ([#172](https://github.com/sk-lim19f/Hypomnema/pull/172))

### Chores

#### English

- Documented the version-spec lifecycle (born at a stable path, flipped in place, minor-and-up scope) in the maintainer release checklist. ([#171](https://github.com/sk-lim19f/Hypomnema/pull/171))

#### 한국어

- 버전 spec 라이프사이클(안정 경로에서 태어나 제자리에서 flip, minor 이상 범위)을 메인테이너 릴리스 체크리스트에 문서화했습니다. ([#171](https://github.com/sk-lim19f/Hypomnema/pull/171))

## [1.5.1] - 2026-07-04

### New Features

#### English

- Lookup and session-start now flag an injected page whose `verify_by_date` has passed with a `[STALE verify_by_date=...]` marker, so a stale answer is visibly dated at the point of use instead of trusted silently. Lookup usage is also tracked locally (fail-closed, git-ignored) so crystallize can surface a linked-but-never-injected page as a cold candidate. ([#164](https://github.com/sk-lim19f/Hypomnema/pull/164))

#### 한국어

- lookup과 session-start가 `verify_by_date`가 지난 주입 페이지에 `[STALE verify_by_date=...]` 마커를 붙여, 낡은 답을 조용히 신뢰하는 대신 사용하는 지점에서 날짜를 눈에 띄게 표시합니다. lookup 사용도 로컬에서(fail-closed, git 제외) 추적해, 링크됐지만 한 번도 주입되지 않은 페이지를 crystallize가 cold 후보로 표면화합니다. ([#164](https://github.com/sk-lim19f/Hypomnema/pull/164))

### Bug Fixes

#### English

- Fixed a non-deterministic session-close failure: `/hypo:crystallize` reported log.md and the session-log as "stale" (exit 1) even when both carried today's entry, because the freshness gate did not recognize the standard `## [date] session | <project>: title` colon delimiter. The gate now accepts it, and a malformed close payload is rejected before any file is written instead of being written and then misdiagnosed downstream. ([#166](https://github.com/sk-lim19f/Hypomnema/pull/166))

#### 한국어

- 비결정적 session-close 실패를 고쳤습니다: `/hypo:crystallize`가 log.md와 session-log를 둘 다 오늘 엔트리를 가졌는데도 "stale"로 보고하며 exit 1 하던 문제인데, 신선도 게이트가 표준 `## [date] session | <project>: title` 콜론 구분자를 인식하지 못한 탓이었습니다. 이제 게이트가 이를 수용하고, malformed close payload는 파일을 쓰기 전에 거부합니다(예전처럼 일단 쓴 뒤 downstream에서 오진하지 않음). ([#166](https://github.com/sk-lim19f/Hypomnema/pull/166))

### Chores

#### English

- Corrected docs (skill footers, README, ARCHITECTURE, the audit report) that wrongly claimed the observability audit counts inline citations toward the autonomy score; the score is based on search / ingest / feedback activity. ([#165](https://github.com/sk-lim19f/Hypomnema/pull/165))
- Fixed README rendering traps in both languages (step ranges rendered as strikethrough, Korean underscore emphasis leaking as literal underscores, run-on version-history paragraphs) and added natural-language / keyword trigger examples to the usage sections. ([#163](https://github.com/sk-lim19f/Hypomnema/pull/163))

#### 한국어

- 관측성 audit이 인라인 citation을 autonomy score에 집계한다고 잘못 서술한 문서(skill footer, README, ARCHITECTURE, audit 리포트)를 정정했습니다. 점수는 search / ingest / feedback 활동을 기반으로 합니다. ([#165](https://github.com/sk-lim19f/Hypomnema/pull/165))
- 양쪽 언어 README의 렌더링 문제(단계 범위가 취소선으로 표시, 한국어 밑줄 강조가 리터럴로 노출, 뒤엉킨 버전 이력 문단)를 고치고, 사용법 섹션에 자연어·키워드 트리거 예시를 추가했습니다. ([#163](https://github.com/sk-lim19f/Hypomnema/pull/163))

### Changelog

- [#166](https://github.com/sk-lim19f/Hypomnema/pull/166) fix(session-close): recognize colon log entries, reject malformed payloads pre-apply
- [#165](https://github.com/sk-lim19f/Hypomnema/pull/165) docs: correct false citation-counting claims (skills, guide, architecture, readme, audit)
- [#164](https://github.com/sk-lim19f/Hypomnema/pull/164) feat(freshness): STALE injection markers + page-usage logging
- [#163](https://github.com/sk-lim19f/Hypomnema/pull/163) docs(readme): fix Markdown rendering traps and add keyword-trigger usage

Contributors: @sk-lim19f

## [1.5.0] - 2026-06-29

### New Features

#### English

- A session running in a code repo now sees the wiki's absolute path: when the working directory is a project's `working_dir` outside the vault, the session-start and cwd-change hooks prepend a one-line `[WIKI VAULT: <path>]` orientation, so a wiki file is no longer wrongly reported missing after only the repo was searched. ([#156](https://github.com/sk-lim19f/Hypomnema/pull/156))
- Session close no longer re-lists pre-existing lint debt from unrelated projects: debt under the close-target project stays listed, debt elsewhere folds into a count pointing to the linter, so a one-time signal stops resurfacing as recurring noise on every close. ([#157](https://github.com/sk-lim19f/Hypomnema/pull/157))
- The session-close result handed back to the model caps its lint warning list, carrying the full warning count plus the first ten instead of serializing hundreds of warnings into model context twice on every close. Errors stay listed in full. ([#158](https://github.com/sk-lim19f/Hypomnema/pull/158))

#### 한국어

- 코드 레포에서 도는 세션이 위키의 절대 경로를 봅니다: 작업 디렉터리가 볼트 밖 프로젝트 `working_dir`이면 세션 시작·cwd 변경 훅이 `[WIKI VAULT: <path>]` 한 줄을 앞에 붙여, 레포만 뒤지고 위키 파일이 없다고 잘못 판단하는 일을 막습니다. ([#156](https://github.com/sk-lim19f/Hypomnema/pull/156))
- 세션 close가 무관한 프로젝트의 기존 lint 부채를 다시 나열하지 않습니다: close 대상 프로젝트 밑 부채만 나열하고 다른 곳 부채는 linter를 가리키는 카운트로 접어, 한 번의 신호가 매 close마다 반복 노이즈로 굳는 것을 막습니다. ([#157](https://github.com/sk-lim19f/Hypomnema/pull/157))
- 모델에 돌려주는 세션 close 결과가 lint 경고 리스트에 상한을 둡니다. 매 close마다 수백 개 경고를 모델 컨텍스트에 두 번 직렬화하는 대신 전체 경고 개수와 앞 10개만 싣습니다. 에러는 전부 나열합니다. ([#158](https://github.com/sk-lim19f/Hypomnema/pull/158))

### Bug Fixes

#### English

- `cwd`-first resume now works on a git-synced multi-machine vault: when no project's absolute `working_dir` prefixes the current directory, resume matches by a globally unique project basename along the cwd path instead of silently degrading to recency and loading an unrelated project. It fails closed on an ambiguous basename. ([#155](https://github.com/sk-lim19f/Hypomnema/pull/155))
- Slash commands, skills, and the wiki guide resolve bundled-script paths through `hypo-pkg.json` when `${CLAUDE_PLUGIN_ROOT}` is left unexpanded, so an npm or copied install runs from any directory. ([#159](https://github.com/sk-lim19f/Hypomnema/pull/159))

#### 한국어

- git 동기화 멀티머신 볼트에서 `cwd`-first resume가 동작합니다: 어떤 프로젝트의 절대 `working_dir`도 현재 디렉터리의 접두사가 아니면, recency로 조용히 떨어져 무관한 프로젝트를 여는 대신 cwd 경로상 전역 유니크한 프로젝트 basename으로 매칭합니다. basename이 모호하면 fail-closed합니다. ([#155](https://github.com/sk-lim19f/Hypomnema/pull/155))
- `${CLAUDE_PLUGIN_ROOT}`가 펼쳐지지 않은 채 남을 때 슬래시 커맨드·스킬·위키 가이드가 `hypo-pkg.json`으로 번들 스크립트 경로를 해소해서, npm이나 복사 설치가 어느 디렉터리에서든 동작합니다. ([#159](https://github.com/sk-lim19f/Hypomnema/pull/159))

### Chores

#### English

- Shipped code, workflow, and doc comments no longer carry tracker-id pointers into the maintainer's private wiki (`FEAT-`/`IMPR-`/`PRAC-`/`ADR`/`decisions`): the explanatory prose stays, the dead pointer is stripped, and the `check-tracker-ids` gate now blocks their reintroduction, including line-wrapped tokens. The maintainer-only fix-verify tooling is no longer shipped in the npm package. ([#160](https://github.com/sk-lim19f/Hypomnema/pull/160), [#161](https://github.com/sk-lim19f/Hypomnema/pull/161))

#### 한국어

- 출하 코드·워크플로·문서 주석이 메인테이너 비공개 위키를 가리키는 tracker-id 포인터(`FEAT-`/`IMPR-`/`PRAC-`/`ADR`/`decisions`)를 더는 담지 않습니다: 설명 문장은 남기고 죽은 포인터만 제거했으며, `check-tracker-ids` 게이트가 줄바꿈으로 쪼개진 토큰까지 포함해 재유입을 차단합니다. 메인테이너 전용 fix-verify 도구는 npm 패키지에서 출하 중단했습니다. ([#160](https://github.com/sk-lim19f/Hypomnema/pull/160), [#161](https://github.com/sk-lim19f/Hypomnema/pull/161))

### Changelog

- [#161](https://github.com/sk-lim19f/Hypomnema/pull/161) chore(check-tracker-ids): block ADR/decisions in shipped code + catch line-wrapped tokens
- [#160](https://github.com/sk-lim19f/Hypomnema/pull/160) chore(check-tracker-ids): block FEAT/IMPR/PRAC in shipped code comments + un-ship fix-verify tools
- [#159](https://github.com/sk-lim19f/Hypomnema/pull/159) fix(commands): resolve bundled-script paths via hypo-pkg.json when the plugin root is unexpanded
- [#158](https://github.com/sk-lim19f/Hypomnema/pull/158) feat(close): cap the lint warn list in the model-facing apply result
- [#157](https://github.com/sk-lim19f/Hypomnema/pull/157) feat(close): scope pre-existing lint-debt notices to the close-target project
- [#156](https://github.com/sk-lim19f/Hypomnema/pull/156) feat(hooks): surface vault path when cwd is a project working_dir outside the vault
- [#155](https://github.com/sk-lim19f/Hypomnema/pull/155) fix(resume): match cwd to project by unique basename on synced multi-machine vaults

Contributors: @sk-lim19f

## [1.4.2] - 2026-06-28

### New Features

#### English

- `crystallize --check-session-close --project=<slug>` scopes the close check to one project, and `--mark-session-closed --project=<slug>` sets the marker attribution. ([#150](https://github.com/sk-lim19f/Hypomnema/pull/150))

#### 한국어

- `crystallize --check-session-close --project=<slug>`로 close 체크를 한 프로젝트로 좁히고, `--mark-session-closed --project=<slug>`로 마커 attribution을 지정합니다. ([#150](https://github.com/sk-lim19f/Hypomnema/pull/150))

### Bug Fixes

#### English

- Session-close recovery commands are now runnable in a plugin install: `node ".../crystallize.mjs"` instead of a bare `crystallize` bin that is not on PATH. ([#153](https://github.com/sk-lim19f/Hypomnema/pull/153))
- Session close no longer stalls on an unregistered tag: an unknown but well-formed tag is a lint warning (W10) and is auto-registered into the SCHEMA Pending section, while forbidden patterns stay hard errors. ([#152](https://github.com/sk-lim19f/Hypomnema/pull/152))
- Session close no longer needs a hand-written `log.md` entry (it is derived from the session-log heading), and a malformed or stale `log.md` slug no longer false-blocks a finished close. ([#151](https://github.com/sk-lim19f/Hypomnema/pull/151))
- Session-close apply now requires a valid project and fails fast on a missing, malformed, or non-directory project, so a close can no longer be written to the wrong project on a same-date tie. ([#148](https://github.com/sk-lim19f/Hypomnema/pull/148))

#### 한국어

- 플러그인 설치에서 세션 close 복구 명령이 실행됩니다: PATH에 없는 bare `crystallize` 대신 `node ".../crystallize.mjs"`를 안내합니다. ([#153](https://github.com/sk-lim19f/Hypomnema/pull/153))
- 세션 close가 미등록 태그에서 멈추지 않습니다: 형식은 맞지만 어휘에 없는 태그는 lint 경고(W10)이자 SCHEMA Pending에 자동 등록되고, 금지 패턴은 hard error로 남습니다. ([#152](https://github.com/sk-lim19f/Hypomnema/pull/152))
- 세션 close가 `log.md` 엔트리를 수기로 쓸 필요가 없어졌고(세션 로그 heading에서 파생), malformed/stale `log.md` slug가 끝난 close를 더는 false-block 하지 않습니다. ([#151](https://github.com/sk-lim19f/Hypomnema/pull/151))
- 세션 close apply가 유효한 프로젝트를 요구하고 누락이나 형식 오류, 디렉터리 아님이면 즉시 실패해서, 같은 날짜 동점 상황에서 close가 엉뚱한 프로젝트에 기록되는 일을 막습니다. ([#148](https://github.com/sk-lim19f/Hypomnema/pull/148))

### Chores

#### English

- The PR template and contributing guide now require a bilingual PR body (English and Korean blocks) and ban a tool-attribution footer in the PR body. ([#149](https://github.com/sk-lim19f/Hypomnema/pull/149))

#### 한국어

- PR 템플릿과 기여 가이드가 PR 본문을 이중 언어(영어·한국어 블록)로 요구하고 PR 본문의 tool-attribution 푸터를 금지합니다. ([#149](https://github.com/sk-lim19f/Hypomnema/pull/149))

### Changelog

- [#153](https://github.com/sk-lim19f/Hypomnema/pull/153) fix(close): emit runnable node CLI for session-close recovery, not bare crystallize bin
- [#152](https://github.com/sk-lim19f/Hypomnema/pull/152) fix(close): demote unknown-tag to warn (W10) and auto-register pending tags
- [#151](https://github.com/sk-lim19f/Hypomnema/pull/151) fix(close): disk-gate ghost slugs and derive root log.md per-close
- [#150](https://github.com/sk-lim19f/Hypomnema/pull/150) feat(close): add --project=<slug> override for session-close check/mark
- [#149](https://github.com/sk-lim19f/Hypomnema/pull/149) docs(pr): bilingual PR body (EN/KO blocks) and ban tool-attribution footer
- [#148](https://github.com/sk-lim19f/Hypomnema/pull/148) fix(close): require and validate payload.project on session-close apply

Contributors: @sk-lim19f

## [1.4.1] - 2026-06-26

### Bug Fixes

#### English

- `/hypo:*` commands resolve script paths via `${CLAUDE_PLUGIN_ROOT}` instead of a guessed `<package-root>`, with an `installed_plugins.json` fallback. ([#147](https://github.com/sk-lim19f/Hypomnema/pull/147))
- `crystallize --apply-session-close` warns when the files verify but the Stop-chain marker was withheld, instead of reading `ok: true` as closed. ([#147](https://github.com/sk-lim19f/Hypomnema/pull/147))
- `weekly-report` links the observability index only when the page exists, else plain text. ([#147](https://github.com/sk-lim19f/Hypomnema/pull/147))

#### 한국어

- `/hypo:*` 커맨드가 스크립트 경로를 추측한 `<package-root>` 대신 `${CLAUDE_PLUGIN_ROOT}`로 해소하고, `installed_plugins.json` 폴백을 둡니다. ([#147](https://github.com/sk-lim19f/Hypomnema/pull/147))
- `crystallize --apply-session-close`가 파일은 검증됐는데 Stop-체인 마커가 빠지면 `ok: true`를 닫힘으로 읽지 않고 경고합니다. ([#147](https://github.com/sk-lim19f/Hypomnema/pull/147))
- `weekly-report`가 observability 인덱스를 페이지가 있을 때만 링크하고, 없으면 일반 텍스트입니다. ([#147](https://github.com/sk-lim19f/Hypomnema/pull/147))

### Changelog

- [#147](https://github.com/sk-lim19f/Hypomnema/pull/147) plugin-root command paths, session-close marker visibility, weekly link guard
- [#146](https://github.com/sk-lim19f/Hypomnema/pull/146) finalize changelog-pr-guide release flow
- [#145](https://github.com/sk-lim19f/Hypomnema/pull/145) semi-automatic changelog collector + exclude maintainer scripts from npm
- [#144](https://github.com/sk-lim19f/Hypomnema/pull/144) document changelog section-model + PR conventions
- [#143](https://github.com/sk-lim19f/Hypomnema/pull/143) changelog section model + classifier, README humanization

Contributors: @sk-lim19f

## [1.4.0] - 2026-06-23

### Highlights

#### English

- Feedback pages can now carry an optional `failure_type` so you can see which kinds of mistakes recur instead of re-reading every page. It is one of eight values (`hallucination`, `false-completion`, `process-stall`, `over-caution`, `overreach`, `incompleteness`, `instruction-miss`, `convention-violation`), classified by a fixed precedence order, and `hypomnema stats` aggregates the counts. The field is optional: leave it off for a plain preference rather than a failure ([#141](https://github.com/sk-lim19f/Hypomnema/pull/141)).
- An auto-commit that hits a merge conflict no longer leaves a half-merged vault. The sync step now detects a real conflict, aborts the merge back to your just-committed state, and surfaces the divergence with manual-merge guidance, so the next session never opens `.md` pages full of `<<<<<<<` markers ([#135](https://github.com/sk-lim19f/Hypomnema/pull/135)).
- `lint` stops silently green-passing invalid YAML frontmatter. Frontmatter that Obsidian's parser would reject (an unquoted value containing `: `, a duplicate top-level key) is now flagged, and a nested mapping key can no longer overwrite the page's real `type` ([#140](https://github.com/sk-lim19f/Hypomnema/pull/140)).

#### 한국어

- 피드백 페이지에 선택적 `failure_type`를 달 수 있습니다. 어떤 종류의 실수가 반복되는지 매 페이지를 다시 읽지 않고 집계로 봅니다. 여덟 값(`hallucination`, `false-completion`, `process-stall`, `over-caution`, `overreach`, `incompleteness`, `instruction-miss`, `convention-violation`) 중 하나이며 정해진 우선순위로 분류하고, `hypomnema stats`가 유형별 개수를 모아 보여줍니다. 선택 필드라 실패가 아닌 단순 선호에는 비워 둡니다 ([#141](https://github.com/sk-lim19f/Hypomnema/pull/141)).
- auto-commit이 머지 충돌을 만나도 절반만 머지된 볼트를 남기지 않습니다. 동기화 단계가 실제 충돌을 감지하면 방금 커밋한 상태로 머지를 되돌리고, 수동 머지 안내와 함께 분기를 드러냅니다. 다음 세션이 `<<<<<<<` 마커로 가득 찬 `.md` 페이지를 여는 일이 없습니다 ([#135](https://github.com/sk-lim19f/Hypomnema/pull/135)).
- `lint`이 invalid YAML frontmatter를 조용히 통과시키지 않습니다. Obsidian 파서가 거부할 frontmatter(따옴표 없는 값 안의 `: `, 중복 top-level 키)를 이제 표시하고, 중첩 매핑 키가 페이지의 실제 `type`을 덮어쓰지 못합니다 ([#140](https://github.com/sk-lim19f/Hypomnema/pull/140)).

### New Features

#### English

- `failure_type` classification for feedback. `/hypo:feedback` takes an optional `--failure-type`, the writer records it, `lint` rejects an out-of-vocabulary value, and `stats` reports the per-type counts. On append to an existing topic the field is set if absent and refuses a conflicting value (one page holds one failure_type). `SCHEMA` moves to 2.1 (an additive, optional field: a page that does not use it is unaffected). The eight values and their precedence are documented in `SCHEMA.md` §3.1. If you had hand-written a free-text `failure_type` on a page before this release, `lint` now flags it, so re-label it with one of the eight values. ([#141](https://github.com/sk-lim19f/Hypomnema/pull/141))
- Session and device audit fields on session records. Each session-log day-shard is seeded with the `device` that created it (and a `session_id` on the Stop-chain close path), and the local `.cache/` session index records the `device`, so multi-machine, multi-session activity is identifiable. The synced shard stamp is a documented, intentional cross-machine identifier; the always-accurate per-session record stays local-only. ([#136](https://github.com/sk-lim19f/Hypomnema/pull/136))

#### 한국어

- 피드백 `failure_type` 분류. `/hypo:feedback`이 선택 인자 `--failure-type`를 받고, writer가 기록하며, `lint`이 어휘 밖 값을 거부하고, `stats`가 유형별 개수를 보고합니다. 기존 토픽에 append할 때 값이 없으면 설정하고 다른 값과 충돌하면 거부합니다(한 페이지는 하나의 failure_type을 가집니다). `SCHEMA`는 2.1로 올라갑니다(추가형 선택 필드라 이 필드를 안 쓰는 페이지는 영향받지 않습니다). 여덟 값과 우선순위는 `SCHEMA.md` §3.1에 있습니다. 이번 릴리스 전에 `failure_type`에 자유서술을 손으로 적어 두었다면 이제 `lint`이 표시하니 여덟 값 중 하나로 다시 분류하세요. ([#141](https://github.com/sk-lim19f/Hypomnema/pull/141))
- 세션 기록의 세션·기기 감사 필드. 세션로그 일별 shard에 이를 만든 `device`(그리고 Stop-체인 close 경로에서는 `session_id`)를 심고, 로컬 `.cache/` 세션 인덱스가 `device`를 기록해 여러 기기·여러 세션 활동을 식별합니다. 동기화되는 shard 스탬프는 의도된 cross-machine 식별자로 문서화돼 있고, 항상 정확한 세션별 기록은 로컬 전용으로 둡니다. ([#136](https://github.com/sk-lim19f/Hypomnema/pull/136))

### Bug Fixes

#### English

- Merge conflicts abort instead of corrupting the tree. The auto-commit Stop hook's `git pull` could leave unmerged files with conflict markers. A new sync primitive separates a true merge conflict (unmerged index entries) from an ordinary network or auth failure, aborts on the former (losing no data, your commit stays local and the remote is untouched), and reports the divergence from session-start and `doctor` until you resolve it by hand. ([#135](https://github.com/sk-lim19f/Hypomnema/pull/135))
- Invalid-YAML detection, nested-key clobber, and a `doctor` verify-skip. The shared frontmatter parser now reads only top-level lines with first-wins, so a `type:` inside a `relations:` list no longer masquerades as the page type, which also fixes `doctor`'s freshness scan silently skipping `learning`/`adr` pages that carried a relations block. A narrow invalid-YAML check (a warning by default, so no vault turns red) catches the colon-space and duplicate-key classes a real parser rejects, and the accepted-type set is now derived from the `SCHEMA` taxonomy instead of a hardcoded list. ([#140](https://github.com/sk-lim19f/Hypomnema/pull/140))

#### 한국어

- 머지 충돌 시 트리를 망가뜨리지 않고 abort합니다. auto-commit Stop 훅의 `git pull`이 충돌 마커가 박힌 미머지 파일을 남길 수 있었습니다. 새 동기화 프리미티브가 실제 머지 충돌(미머지 인덱스 항목)과 일반 네트워크·인증 실패를 구분해 전자에서 abort하고(데이터 손실 없음. 커밋은 로컬에 남고 원격은 그대로), 사용자가 직접 해소할 때까지 session-start와 `doctor`가 분기를 보고합니다. ([#135](https://github.com/sk-lim19f/Hypomnema/pull/135))
- invalid-YAML 검출, 중첩 키 clobber, `doctor` verify-skip. 공유 frontmatter 파서가 이제 top-level 줄만 first-wins로 읽어, `relations:` 리스트 안의 `type:`이 페이지 타입 행세를 못 합니다. relations 블록을 가진 `learning`/`adr` 페이지를 `doctor`의 freshness 스캔이 조용히 건너뛰던 버그도 함께 고쳤습니다. 좁은 invalid-YAML 검사(기본은 경고라 어떤 볼트도 red가 되지 않습니다)가 실제 파서가 거부하는 colon-space·중복 키 부류를 잡고, 허용 타입 집합을 하드코딩 대신 `SCHEMA` taxonomy에서 도출합니다. ([#140](https://github.com/sk-lim19f/Hypomnema/pull/140))

### Chores

#### English

- The release pipeline now owns the Claude Code plugin channel, not just npm. A new version-consistency check asserts every version-carrying file agrees (and matches the release tag), a network-free plugin smoke check verifies the manifest, hook targets, and command/skill files all resolve to real files, and a README floor gate blocks a publish whose version was never written into both `README.md` and `README.ko.md`: the reconcile step that had been dropped three times. ([#137](https://github.com/sk-lim19f/Hypomnema/pull/137), [#138](https://github.com/sk-lim19f/Hypomnema/pull/138))
- Shared wikilink resolver. The `collectPages` / `extractWikilinks` / slug-form logic duplicated across `lint`, `rename`, `graph`, and `crystallize` is consolidated into one `lib/wikilink.mjs` with four named traversal presets that preserve each caller's deliberate policy. A pure internal refactor with no behavior change. ([#139](https://github.com/sk-lim19f/Hypomnema/pull/139))

#### 한국어

- 릴리스 파이프라인이 npm뿐 아니라 Claude Code 플러그인 채널까지 소유합니다. 새 버전 일치 검사가 버전을 담은 모든 파일이 (그리고 릴리스 태그와) 일치하는지 단언하고, 네트워크 없는 플러그인 smoke 검사가 매니페스트·훅 타깃·커맨드/스킬 파일이 모두 실제 파일로 존재하는지 확인하며, README floor 게이트가 버전이 `README.md`·`README.ko.md` 양쪽에 적히지 않은 publish를 막습니다. 세 번이나 누락됐던 reconcile 단계입니다. ([#137](https://github.com/sk-lim19f/Hypomnema/pull/137), [#138](https://github.com/sk-lim19f/Hypomnema/pull/138))
- 공유 wikilink resolver. `lint`·`rename`·`graph`·`crystallize`에 중복돼 있던 `collectPages`/`extractWikilinks`/slug 로직을 각 호출자의 의도적 정책을 보존하는 네 개의 named 순회 preset과 함께 단일 `lib/wikilink.mjs`로 통합했습니다. 동작 변화 없는 순수 내부 리팩터입니다. ([#139](https://github.com/sk-lim19f/Hypomnema/pull/139))

### Changelog

- [#141](https://github.com/sk-lim19f/Hypomnema/pull/141) feedback failure_type classification
- [#136](https://github.com/sk-lim19f/Hypomnema/pull/136) session and device audit fields
- [#135](https://github.com/sk-lim19f/Hypomnema/pull/135) merge-conflict abort on auto-commit
- [#140](https://github.com/sk-lim19f/Hypomnema/pull/140) invalid-YAML lint guard
- [#137](https://github.com/sk-lim19f/Hypomnema/pull/137) release version-consistency + plugin smoke
- [#138](https://github.com/sk-lim19f/Hypomnema/pull/138) README floor gate
- [#139](https://github.com/sk-lim19f/Hypomnema/pull/139) shared wikilink resolver

Contributors: @sk-lim19f

## [1.3.4] - 2026-06-19

### Highlights

#### English

- `init` no longer drops a duplicate stock page next to one you wrote by hand. If you already have a `wiki-automation.md`, installing the templates keeps it and skips the stock `hypo-automation.md`, with a loud "merge manually" notice instead of a silent, 0-reference orphan ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133)).
- Regenerable report output at the vault root (the upgrade `MIGRATION-v*.md` report, plus the reserved `GRAPH_REPORT.md` name) no longer clutters your knowledge catalog. These root files are excluded from the catalog scans (lint link targets, rename, doctor) while staying fully committable ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133)).

#### 한국어

- `init`이 손수 쓴 페이지 옆에 중복 stock 페이지를 떨구지 않습니다. 이미 `wiki-automation.md`가 있으면 템플릿 설치 시 그걸 유지하고 stock `hypo-automation.md`는 건너뜁니다. 조용한 참조 0곳 고아 대신 "수동 머지" 경고를 크게 냅니다 ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133)).
- 볼트 루트의 재생성 가능한 리포트 산출물(업그레이드 `MIGRATION-v*.md` 리포트, 예약된 `GRAPH_REPORT.md` 이름 포함)이 지식 카탈로그를 더는 어지럽히지 않습니다. 이 루트 파일들은 카탈로그 스캔(lint 링크 타깃·rename·doctor)에서 제외되면서도 정상 커밋됩니다 ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133)).

### Bug Fixes

#### English

- Template injection keeps your hand-authored page instead of dropping a duplicate orphan. `init` checked only the exact destination filename, so a stock `hypo-automation.md` landed next to a user's `wiki-automation.md` (the `hypo-`/`wiki-` namespace split), leaving a 0-reference duplicate orphan. `init` now carries an explicit equivalents map (the same idiom the hook-rename migration uses): when a legacy `wiki-*` page exists it keeps that page, skips the stock one, and reports the skip loudly so you can merge by hand. `hypo-guide.md` is exempt, because the runtime loads it by name and a mid-migration vault must still receive it. The check also fires in `--dry-run`. ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133), ADR 0058)
- Generated root artifacts no longer pollute the knowledge catalog. The upgrade report (`MIGRATION-v*.md`) sits at the vault root, and the catalog scans (lint link targets, rename, doctor) treated it as a knowledge page. (`GRAPH_REPORT.md` has no writer today; its name is reserved preventively so a future dump cannot pollute the catalog either.) They cannot go in `.hypoignore`, because that list also drives the pre-commit secret gate, so listing them there would block their own commit and freeze every auto-commit while the report sits at root. A root-anchored, catalog-only exclusion now hides them from the scans while the pre-commit gate and `ingest --check` keep treating them normally, so the report still commits and enters git history but stops cluttering the catalog. Same-named files nested under `pages/` or `projects/` are untouched. ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133), ADR 0059)

#### 한국어

- 템플릿 주입이 중복 고아를 떨구지 않고 손수 쓴 페이지를 유지합니다. `init`이 정확한 대상 파일명만 검사해서 stock `hypo-automation.md`가 사용자의 `wiki-automation.md`(hypo-/wiki- 네임스페이스 split) 옆에 떨어지며 참조 0곳 중복 고아를 남겼습니다. 이제 `init`은 명시적 등가본 맵(hook-rename 마이그레이션과 같은 관용구)을 갖춰, 레거시 `wiki-*` 페이지가 있으면 그 페이지를 유지하고 stock 페이지는 건너뛰며 그 사실을 눈에 띄게 보고해 사용자가 수동으로 머지하게 합니다. `hypo-guide.md`는 런타임이 이름으로 읽고 마이그레이션 중간 볼트도 받아야 하므로 예외입니다. `--dry-run`에서도 이 안내를 출력합니다. ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133), ADR 0058)
- 생성된 루트 산출물이 지식 카탈로그를 오염하지 않습니다. 업그레이드 리포트(`MIGRATION-v*.md`)가 볼트 루트에 있어 카탈로그 스캔(lint 링크 타깃·rename·doctor)이 지식 페이지로 취급했습니다. (`GRAPH_REPORT.md`는 현재 writer가 없고, 향후 덤프가 카탈로그를 오염하지 못하도록 이름만 예방적으로 예약했습니다.) 이들은 `.hypoignore`에 넣을 수 없는데, 그 목록이 pre-commit 시크릿 게이트도 구동하므로 거기 넣으면 자기 커밋이 차단되고 리포트가 루트에 있는 동안 모든 auto-commit이 동결되기 때문입니다. 이제 root-anchored 카탈로그 전용 제외 규칙이 스캔에서는 숨기되 pre-commit 게이트와 `ingest --check`은 정상 취급하므로, 리포트는 여전히 커밋되어 git 히스토리에 들어가면서 카탈로그를 어지럽히지 않습니다. `pages/`·`projects/` 아래 중첩 동명 파일은 영향받지 않습니다. ([#133](https://github.com/sk-lim19f/Hypomnema/pull/133), ADR 0059)

### Changelog

- [#133](https://github.com/sk-lim19f/Hypomnema/pull/133) init equivalents map + root-artifact catalog exclusion

Contributors: @sk-lim19f

## [1.3.3] - 2026-06-19

### Highlights

#### English

- Session close is much harder to trigger by accident. The model can no longer mark a session closed without a real user close signal, and merely reading close-related text (docs, a prior transcript, a skill body) no longer false-blocks your turn ([#129](https://github.com/sk-lim19f/Hypomnema/pull/129), [#126](https://github.com/sk-lim19f/Hypomnema/pull/126), [#128](https://github.com/sk-lim19f/Hypomnema/pull/128)).
- `--apply-session-close`, on a close that carries a user close signal, now finishes in one step: it commits its own payload and writes the session-closed marker, instead of silently skipping the marker and leaving you to run `--mark-session-closed` by hand ([#130](https://github.com/sk-lim19f/Hypomnema/pull/130)).
- Routine tracker bookkeeping no longer cross-blocks an unrelated project's `/compact`. Only a real session (a session-log entry) counts as close activity, not a touched `session-state.md` ([#131](https://github.com/sk-lim19f/Hypomnema/pull/131)).
- `rename` now moves a whole directory subtree, with its own slash command and a merge/renumber collision report when a destination already exists ([#125](https://github.com/sk-lim19f/Hypomnema/pull/125)).

#### 한국어

- 세션 종료가 실수로 발동되기 훨씬 어려워졌습니다. 모델이 실제 사용자 종료 신호 없이 세션을 닫을 수 없고, 종료 관련 텍스트(문서·이전 transcript·스킬 본문)를 단지 읽는 것만으로 턴이 false-block되지 않습니다 ([#129](https://github.com/sk-lim19f/Hypomnema/pull/129), [#126](https://github.com/sk-lim19f/Hypomnema/pull/126), [#128](https://github.com/sk-lim19f/Hypomnema/pull/128)).
- `--apply-session-close`가 사용자 종료 신호가 있는 close에서 이제 한 번에 끝냅니다. 자기 payload를 커밋하고 session-closed 마커까지 써서, 마커를 조용히 건너뛰고 사용자가 `--mark-session-closed`를 손수 돌리게 두던 동작이 사라졌습니다 ([#130](https://github.com/sk-lim19f/Hypomnema/pull/130)).
- 일상적인 트래커 bookkeeping이 무관한 프로젝트의 `/compact`를 더는 cross-block하지 않습니다. 실제 세션(session-log 항목)만 close 활동으로 치고, 건드린 `session-state.md`는 치지 않습니다 ([#131](https://github.com/sk-lim19f/Hypomnema/pull/131)).
- `rename`이 이제 디렉터리 서브트리 전체를 옮기며, 전용 슬래시 커맨드와 대상 경로가 이미 있을 때의 merge/renumber 충돌 리포트를 갖췄습니다 ([#125](https://github.com/sk-lim19f/Hypomnema/pull/125)).

### New Features

#### English

- `rename` handles a directory subtree, not just a single page. The rename helper shipped for pages in 1.3.2; renaming a folder still meant moving each page by hand. `scripts/rename.mjs` (and a `/hypo:rename` slash command) now relocates an entire subtree, rewrites the eligible inbound wikilinks across the vault the same way the page mode does, and when a destination path already exists it emits a merge/renumber collision report and refuses `--apply` (leaving the merge for manual handling) rather than clobbering. It stays a dry-run by default; pass `--apply` to write the move. ([#125](https://github.com/sk-lim19f/Hypomnema/pull/125), ADR 0053)

#### 한국어

- `rename`이 단일 페이지뿐 아니라 디렉터리 서브트리를 처리합니다. rename 헬퍼는 1.3.2에서 페이지용으로 출시됐는데, 폴더 이름 변경은 여전히 페이지를 하나씩 손으로 옮겨야 했습니다. `scripts/rename.mjs`(및 `/hypo:rename` 슬래시 커맨드)가 이제 서브트리 전체를 옮기고, 페이지 모드와 동일하게 볼트 전체의 해당하는 인바운드 위키링크를 갱신하며, 대상 경로가 이미 있으면 clobber 대신 merge/renumber 충돌 리포트를 내고 `--apply`를 거부합니다(merge는 수동 처리에 맡깁니다). 기본은 dry-run이며 `--apply`로 이동을 기록합니다. ([#125](https://github.com/sk-lim19f/Hypomnema/pull/125), ADR 0053)

### Bug Fixes

#### English

- A session is no longer marked closed without a real user close signal. Both session-closed marker writers gated only on "is the wiki compact-ready", never on whether you actually asked to close, so the model could self-close (write the marker and declare done) on its own judgment. A hard gate now requires a genuine user close signal in the session (a natural-language close phrase, `/compact`, or an AskUserQuestion close answer), resolved strictly from the session id, separate from the compact-readiness check. This blocks inadvertent over-close; it is not a claim of unforgeability (the model owns its own subprocess), and a direct marker write stays inert because the Stop hook only consults the marker once a close signal is already present. ([#129](https://github.com/sk-lim19f/Hypomnema/pull/129), ADR 0055)
- Reading close-related text no longer false-blocks the turn. The Stop-gate close-intent check stringified `role:user` tool results and injected skill or command bodies, so a session that merely read close vocabulary (a prior transcript, the close docs, a skill body full of "wrap up" / "session close" examples) tripped the gate every turn. Close-intent now ignores tool results and injected meta/system content, and the Korean close pattern moved from a verb-suffix blacklist to a complete-terminal whitelist, so it matches the common real phrasings and rejects noun-modifier and negation forms. (Tool-result exclusion is [#126](https://github.com/sk-lim19f/Hypomnema/pull/126) / ADR 0054; the injected meta/system exclusion and the whitelist are [#129](https://github.com/sk-lim19f/Hypomnema/pull/129) / ADR 0055.)
- The proactive close offer can no longer close the session by itself. The "looks like you're wrapping up" path could proceed all the way to a self-close; it is now scoped to offering only, and the actual close still requires you to choose it. ([#128](https://github.com/sk-lim19f/Hypomnema/pull/128))
- `--apply-session-close` writes the session-closed marker instead of silently skipping it. apply wrote its payload files (leaving the tree dirty) and then checked a gate whose git-clean blocker its own writes had just tripped, so the marker was skipped and you were nudged to run `--mark-session-closed` by hand, after the close had already reported success. apply now commits its own payload first, via the same `.hypoignore`-aware helper the auto-commit Stop hook uses, then writes and verifies the marker. Unpushed commits ("ahead") are demoted from a blocker to a notice across the shared gate (push is automatic and its failures are already non-fatal), so a committed-but-unpushed close still marks and still compacts. ([#130](https://github.com/sk-lim19f/Hypomnema/pull/130), ADR 0056)
- Tracker bookkeeping no longer cross-blocks an unrelated project's `/compact`. The global close invariant treated a freshly-dated `session-state.md` as close activity, but routine tracker bookkeeping (mirroring a new item into "next tasks") bumps that date with no real session, so an unrelated project's `/compact` was held hostage demanding the bookkept project's full close. Close activity is now recognized only from the artifacts a real close writes (a today session-log heading or a `## [today] session | P` log entry); the soft state files (`session-state.md`, project `hot.md`, the root `hot.md` row) no longer count, which also stops `project-create` and hot-cache rebuilds from looking like sessions. ([#131](https://github.com/sk-lim19f/Hypomnema/pull/131), ADR 0057)

#### 한국어

- 실제 사용자 종료 신호 없이 세션이 닫히지 않습니다. 두 session-closed 마커 writer는 "위키가 compact-ready인가"만 검사하고 사용자가 실제로 종료를 요청했는지는 보지 않아, 모델이 자의로 self-close(마커를 쓰고 완료 선언)할 수 있었습니다. 이제 hard gate가 세션 안의 진짜 사용자 종료 신호(자연어 종료 표현·`/compact`·AskUserQuestion 종료 답변)를 요구하며, session id에서만 해석하고 compact-readiness 검사와는 별개입니다. 무심코 일어나는 over-close를 막는 장치이지 위조 불가를 주장하는 것은 아니며(모델은 자기 subprocess를 소유합니다), 직접 마커를 써도 Stop 훅은 종료 신호가 이미 있을 때만 마커를 참조하므로 무력합니다. ([#129](https://github.com/sk-lim19f/Hypomnema/pull/129), ADR 0055)
- 종료 관련 텍스트를 읽는 것이 턴을 false-block하지 않습니다. Stop 게이트의 close-intent 검사가 `role:user` tool result와 주입된 스킬·커맨드 본문을 통째로 문자열화해서, 종료 어휘를 단지 읽은 세션(이전 transcript·종료 문서·"wrap up"·"session close" 예시가 가득한 스킬 본문)이 매 턴 게이트에 걸렸습니다. 이제 close-intent는 tool result와 주입된 meta/system 콘텐츠를 무시하고, 한국어 종료 패턴은 동사어미 blacklist에서 종결형 완전체 whitelist로 바뀌어 흔한 실제 표현은 잡고 명사수식·부정형은 거부합니다. (tool result 제외는 [#126](https://github.com/sk-lim19f/Hypomnema/pull/126) / ADR 0054, 주입된 meta/system 제외와 whitelist는 [#129](https://github.com/sk-lim19f/Hypomnema/pull/129) / ADR 0055입니다.)
- 선제적 종료 제안이 스스로 세션을 닫을 수 없습니다. "마무리하는 것 같다" 경로가 self-close까지 진행될 수 있었는데, 이제 제안만 하도록 스코프되고 실제 종료는 사용자가 선택해야 합니다. ([#128](https://github.com/sk-lim19f/Hypomnema/pull/128))
- `--apply-session-close`가 session-closed 마커를 조용히 건너뛰지 않고 기록합니다. apply는 payload 파일을 쓰고(트리가 dirty해짐) 나서 자기 write가 방금 건드린 git-clean 차단을 검사해서, 마커가 생략되고 종료가 이미 성공으로 보고된 뒤에 사용자가 `--mark-session-closed`를 손수 돌리도록 내몰렸습니다. 이제 apply는 auto-commit Stop 훅과 동일한 `.hypoignore` 인지 헬퍼로 자기 payload를 먼저 커밋한 뒤 마커를 쓰고 검증합니다. unpushed 커밋("ahead")은 공유 게이트 전반에서 차단이 아니라 notice로 강등되어(push는 자동이고 그 실패는 이미 비치명적입니다), committed-but-unpushed 종료도 마커가 써지고 `/compact`도 통과합니다. ([#130](https://github.com/sk-lim19f/Hypomnema/pull/130), ADR 0056)
- 트래커 bookkeeping이 무관한 프로젝트의 `/compact`를 cross-block하지 않습니다. 전역 close 불변식이 갓 갱신된 `session-state.md`를 close 활동으로 봤는데, 일상적 트래커 bookkeeping("다음 작업"에 새 항목 미러)은 실제 세션 없이 그 날짜를 bump하므로 무관한 프로젝트의 `/compact`가 bookkeeping된 프로젝트의 완전 close를 요구하며 인질이 됐습니다. 이제 close 활동은 실제 종료가 쓰는 아티팩트(오늘 session-log 헤딩 또는 `## [today] session | P` log 항목)에서만 인식하고, soft state 파일(`session-state.md`·프로젝트 `hot.md`·루트 `hot.md` row)은 치지 않으므로 `project-create`나 hot-cache 재빌드도 세션처럼 보이지 않습니다. ([#131](https://github.com/sk-lim19f/Hypomnema/pull/131), ADR 0057)

### Chores

#### English

- The `/hypo:*` slash command and skill descriptions are now trigger-rich. Each slash command (15) and the auto-triggering skills (crystallize, graph, ingest, lint, query, verify) now spell out when to reach for them, so the command picker and the model surface the right one from a wider range of phrasings. ([#127](https://github.com/sk-lim19f/Hypomnema/pull/127))

#### 한국어

- `/hypo:*` 슬래시 커맨드와 스킬 설명이 trigger-rich해졌습니다. 슬래시 커맨드 15개와 자동 발동 스킬(crystallize·graph·ingest·lint·query·verify)이 각각 언제 써야 하는지 명시해, 커맨드 선택기와 모델이 더 넓은 표현 범위에서 알맞은 것을 떠올립니다. ([#127](https://github.com/sk-lim19f/Hypomnema/pull/127))

### Changelog

- [#129](https://github.com/sk-lim19f/Hypomnema/pull/129) hard close-signal gate for session close
- [#126](https://github.com/sk-lim19f/Hypomnema/pull/126) close-intent ignores tool results
- [#128](https://github.com/sk-lim19f/Hypomnema/pull/128) proactive close offer is offer-only
- [#130](https://github.com/sk-lim19f/Hypomnema/pull/130) apply-session-close writes the marker
- [#131](https://github.com/sk-lim19f/Hypomnema/pull/131) tracker bookkeeping no longer cross-blocks compact
- [#125](https://github.com/sk-lim19f/Hypomnema/pull/125) rename a directory subtree
- [#127](https://github.com/sk-lim19f/Hypomnema/pull/127) trigger-rich command and skill descriptions

Contributors: @sk-lim19f

## [1.3.2] - 2026-06-16

> [!IMPORTANT]
> **Plugin install identifier changed: `hypomnema@hypomnema` ⇒ `hypo@hypomnema`.** Disable or remove the old plugin, then run `/plugin install hypo@hypomnema` followed by `/reload-plugins`. The old `/hypomnema:*` commands keep working from the cached plugin until you reinstall, and the npm/manual `/hypo:upgrade` dual-install guard recognizes both names during the migration window. The marketplace itself keeps its name (`hypomnema`), so `/plugin marketplace add` and `/plugin marketplace update hypomnema` are unchanged. Session-log daily shards need no migration: existing monthly files are still read as a fallback, and daily files take over going forward.

> [!IMPORTANT]
> **플러그인 설치 식별자 변경: `hypomnema@hypomnema` ⇒ `hypo@hypomnema`.** 기존 플러그인을 비활성화하거나 제거한 뒤 `/plugin install hypo@hypomnema`와 `/reload-plugins`를 실행하세요. 재설치 전까지는 캐시된 플러그인의 기존 `/hypomnema:*` 커맨드가 계속 동작하고, npm/수동 `/hypo:upgrade`의 dual-install 가드가 마이그레이션 기간에 두 이름을 모두 인식합니다. 마켓플레이스 이름(`hypomnema`)은 그대로이므로 `/plugin marketplace add`·`/plugin marketplace update hypomnema`는 변하지 않습니다. 세션 로그 일별 shard는 마이그레이션이 필요 없습니다. 기존 월별 파일은 fallback으로 계속 읽히고, 일별 파일이 이후부터 인계받습니다.

### Highlights

#### English

- The marketplace plugin now installs as `hypo`, so the documented `/hypo:*` commands work straight away ([#101](https://github.com/sk-lim19f/Hypomnema/pull/101)).
- Session logs are sharded by day, so each session close reads today's small file instead of the whole month ([#118](https://github.com/sk-lim19f/Hypomnema/pull/118)).
- `crystallize --check-session-close` now runs the same shared gate as `/compact`, so a green check means no human-fixable blocker remains (live-only differences like a context-pressure prompt aside) ([#109](https://github.com/sk-lim19f/Hypomnema/pull/109)).
- A non-project (tooling or wiki-only) session can now be closed with `--mark-session-closed --log-only`, without being forced onto an unrelated project ([#122](https://github.com/sk-lim19f/Hypomnema/pull/122)).
- A new `rename` helper rewrites the eligible inbound wikilinks when you rename a page, so live links survive the move (ambiguous or append-only references are reported, not rewritten) ([#123](https://github.com/sk-lim19f/Hypomnema/pull/123)).

#### 한국어

- 마켓플레이스 플러그인이 이제 `hypo`로 설치되어, 문서에 적힌 `/hypo:*` 커맨드가 바로 동작합니다 ([#101](https://github.com/sk-lim19f/Hypomnema/pull/101)).
- 세션 로그를 일별로 분할(shard)하여, 매 세션 종료가 한 달치 전체 대신 오늘치 작은 파일만 읽습니다 ([#118](https://github.com/sk-lim19f/Hypomnema/pull/118)).
- `crystallize --check-session-close`가 이제 `/compact`와 동일한 공유 게이트를 돌려, 체크가 깨끗하면 사람이 고칠 차단 사유가 없다는 뜻입니다(컨텍스트 압박 프롬프트 같은 라이브 전용 차이는 제외) ([#109](https://github.com/sk-lim19f/Hypomnema/pull/109)).
- 비-프로젝트(툴링·위키 전용) 세션을 `--mark-session-closed --log-only`로 무관한 프로젝트에 엮이지 않고 닫을 수 있습니다 ([#122](https://github.com/sk-lim19f/Hypomnema/pull/122)).
- 페이지 이름을 바꿀 때 새 `rename` 헬퍼가 해당하는 인바운드 위키링크를 갱신하여 live 링크가 이동 후에도 살아남습니다(모호하거나 append-only인 참조는 갱신하지 않고 보고합니다) ([#123](https://github.com/sk-lim19f/Hypomnema/pull/123)).

### Bug Fixes

#### English

- `crystallize --check-session-close` now checks everything `/compact` checks, so it no longer reports a clean close while the gate still blocks. The check verified only the five close files, while the real PreCompact gate also blocks on a lint error in a close file, a stale design-history, or a feedback projection over-cap. So the check could report a clean close while `/compact` still blocked: you'd declare the session done, then hit a wall. The decision now lives in one shared function (`precompactGateStatus`) that both the gate and the check call, and the check prints "Compact-ready" only when every gate condition passes (pure feedback drift is reported as a non-blocking notice because the gate self-heals it; over-cap and conflict still block as a human decision). Pass `--transcript-path` to also scope the lint check to this session's edited files, exactly as the interactive gate does. It is a read-only dry-run, not a hard guarantee: the live gate can still differ on a context-pressure prompt, a `HYPO_SKIP_GATE` bypass, or a transcript-scoped lint error the check did not see. Its JSON keeps the prior `ok`/`project`/`dates`/`stale`/`missing` fields and adds `blockers`/`notices`/`skipped`. ([#109](https://github.com/sk-lim19f/Hypomnema/pull/109))
- A stale feedback projection no longer blocks `/compact`; the gate now re-syncs it for you. Wiki `pages/feedback/*.md` is the source of truth, and your `MEMORY.md` / `CLAUDE.md` learned-behaviors blocks are one-way projections of it. Editing a feedback page left those projections stale, and nothing regenerated them automatically, so the next `/compact` always blocked with "run feedback-sync --write", and running it changed nothing you could see, because the drift lived in per-feedback side-files, not the visible `MEMORY.md` body. The PreCompact gate now self-heals: when the only issue is plain projection drift (a deterministic, byte-identical regeneration), it runs the sync itself and proceeds, noting in the banner that it re-synced. The two cases that genuinely need a human decision still block, by design: a hand-edited managed block (conflict: resolve with `feedback-sync --import-target-change`) and an over-cap projection (demote or archive a feedback page). The auto-sync updates files on disk for the next session; it does not change the memory already loaded into the current session. ([#108](https://github.com/sk-lim19f/Hypomnema/pull/108))
- `/hypo:resume` (without `--project`) now prefers the project you're standing in. When the current directory matches a project's `working_dir`, resume loads that project even if another project has a more recent entry in `hot.md`. Previously the current directory was only consulted to break a same-date tie, so a single newer non-matching row always won: running resume from a repo whose project was last touched a few days ago would load the unrelated newer project instead, and dead-end if that project's `working_dir` doesn't exist on the current machine. The current directory is now the stronger signal (you are physically in that repo), applied before the recency fallback across the wiki-row, legacy markdown-row, and modified-time-fallback paths. Pass `--project=<name>` to override. The session-close gate is unchanged: it never picks a project by the current directory, so close verification is unaffected. ([#107](https://github.com/sk-lim19f/Hypomnema/pull/107))
- A transcript-less PreCompact no longer blocks `/compact` on unrelated lint debt. The session-close gate scopes blocking lint to the files this session is accountable for (the mandatory close files, plus any file the transcript shows it edited), surfacing everything else as a non-blocking notice. The no-transcript fallback was the exception: it reverted to gating the **whole vault**, so a lint error in another project or a shared page (debt this session never touched) would hold `/compact` hostage. The fallback now scopes to the mandatory close files (`closeFileTargets`), the only files derivable without a transcript. Normal interactive `/compact` is unaffected (both manual and automatic compaction always carry a transcript, per the Claude Code hooks contract); this only changes the headless / programmatic path, where the old global gate was the wrong scope rather than a safer one. The have-transcript path is behavior-preserving. ([#103](https://github.com/sk-lim19f/Hypomnema/pull/103))
- A non-project (tooling or wiki-only) session can be closed without being forced onto an unrelated project. Session close assumed every session belongs to the active project, so a tooling or wiki-only session with nothing of its own to close was pushed to close the recency project, risking a clobber of that project's handoff. `crystallize --mark-session-closed --log-only` is a first-class path that closes such a session against a single today `log.md` entry (its minimum proof) and records no project attribution, while the git, lint, and feedback checks still apply (it is not a gate bypass). The `/compact` gate and `--check-session-close` recognize the log-only marker by session id, and the Stop hook offers `--log-only` only when a project-close blocker is actually present, so a real project session is never taught to skip its close. ([#122](https://github.com/sk-lim19f/Hypomnema/pull/122))
- The per-session close marker now uses the same gate as `/compact`, so it cannot attest a close that `/compact` would still block. The marker gated on a narrower check than the real PreCompact gate, so a hand-edited close could write a marker while `/compact` still blocked on feedback projection, design-history staleness, or root `hot.md` structure (and, symmetrically, a close that bypassed the writer left the marker absent so the Stop hook blocked). Both marker writers now route through `precompactGateStatus`; the marker is refused whenever the gate has a blocker, and git-clean is one of those blockers. Pure feedback drift stays a non-blocker (the marker is written and the gate self-heals it at `/compact`). ([#110](https://github.com/sk-lim19f/Hypomnema/pull/110))
- Session close now gates every project with activity today, not a single recency pick. The no-payload close paths re-derived the project from the top row of root `hot.md`, so closing a project that was not the recency winner could false-block, and no global rule stopped a different project from ending a session with a partial close. The gate now checks every project with today's close activity and blocks if any is incomplete, falling back to the recency project only when none is active (the from-zero force-close is unchanged). The apply path keeps its explicit `payload.project` authority. Resume still prefers the current directory; close never picks by directory, and a regression test locks that split. ([#106](https://github.com/sk-lim19f/Hypomnema/pull/106))
- A hand-edited close that skipped the root `log.md` entry no longer blocks `/compact` for every project. The root `log.md` session line restates a project's session-log heading the close already wrote, but it was the last derivable artifact still left as a manual step, so skipping it hard-blocked the global gate across sessions and looked like a fresh defect each time. The hot-rebuild Stop hook now derives the missing entry from the session-log heading, but only for a project whose sole remaining gap is that line (an otherwise-incomplete close keeps blocking). The close marker itself is deliberately not derived, since it is the proof the gate actually ran. ([#112](https://github.com/sk-lim19f/Hypomnema/pull/112))
- Design-history staleness (W8) no longer false-flags a project after a no-design session. The lint compared the latest session-log date against the latest design-history date, but design-history is appended only on a design change while session-log grows every session, so a session that changed no design pushed the date past design-history forever. The check now reads session-log per entry and excludes an entry only when it carries the explicit no-design marker with no ADR reference in the same block, preserving the hard block for a real design change that forgot to record one. ([#104](https://github.com/sk-lim19f/Hypomnema/pull/104))
- Session close and resume now say which project they acted on when the choice was not obvious. `crystallize --apply-session-close` already honored an explicit `payload.project` for the write and freshness check, but when that differed from the inferred active project the divergence was silent; it now prints a one-line stderr note naming the project actually verified. Resume similarly fell back to the most-recent project in silence when the current directory matched none (a missing `index.md` or `working_dir`); it now prints a diagnostic at each fallback, staying quiet only on a fresh install with nothing to fall back to. The stdout JSON contracts are unchanged. ([#119](https://github.com/sk-lim19f/Hypomnema/pull/119))
- `lint --json` no longer truncates its output on a pipe, which had aborted session close over unrelated lint debt. The linter called `process.exit()` right after printing its JSON, so on a pipe the synchronous exit tore the process down before the OS buffer drained, cutting large output at 64 KiB; every spawn-and-parse consumer then crashed on `JSON.parse`, and on the apply-session-close path that aborted the whole close. The linter now sets an exit code and lets Node exit naturally so stdout flushes fully (the exit-code contract is preserved). The PreCompact gate now treats a lint spawn failure, timeout, or empty output as a visible fail-open with a reason instead of silently passing the check, while the apply-session-close path reports a hard lint-helper failure with diagnostic metadata (output size, exit/signal, stderr tail) rather than a silent pass or a truncated dump. ([#120](https://github.com/sk-lim19f/Hypomnema/pull/120))
- The linter no longer reports vault-convention wikilinks as broken, clearing the false positives that buried the real ones. Three resolution gaps inflated the broken-link total: a directory-relative link like `[[learnings/foo]]` for `pages/learnings/foo.md` was not keyed, root-level `*.md` and `sources/*` were never collected as valid destinations (so `[[hypo-guide]]`, `[[SCHEMA]]`, and `[[sources/x]]` flagged despite existing), and a Markdown-table-escaped alias `[[a/b\|label]]` captured the trailing backslash and never matched. All three resolve correctly now, so the broken-link warnings reflect genuinely dangling links. ([#121](https://github.com/sk-lim19f/Hypomnema/pull/121))
- User-facing docs no longer point at the maintainer's private wiki decision records. README, the Korean README, and the architecture and contributing guides referenced internal decision-record ids that an installed user cannot open; those parentheticals are removed (and a stale numeric decisions path in the contributing guide is replaced with a wildcard), with the prose intact in both languages. A scoped regression check keeps those pointers out of the user-facing docs while leaving shipped code comments and changelog history, which keep their anchors for maintainer context. ([#111](https://github.com/sk-lim19f/Hypomnema/pull/111))

#### 한국어

- `crystallize --check-session-close`가 이제 `/compact`가 검사하는 것을 모두 검사하여, 게이트는 막는데 명령은 깨끗하다고 보고하는 불일치가 사라졌습니다. 이 명령은 close 파일 5종만 검증했는데, 실제 PreCompact 게이트는 close 파일의 lint 에러·stale design-history·feedback 투영 over-cap도 차단합니다. 그래서 명령은 깨끗하다고 보고하는데 `/compact`는 막히는 일이 생겼습니다(마무리됐다고 선언한 뒤 벽에 부딪히는 격입니다). 이제 결정 로직이 게이트와 명령이 함께 호출하는 단일 함수(`precompactGateStatus`)에 있고, 모든 게이트 조건이 통과할 때만 "Compact-ready"를 출력합니다(순수 feedback drift는 게이트가 self-heal하므로 비차단 notice로 표시하고, over-cap·conflict는 사람 결정으로 계속 차단합니다). `--transcript-path`를 넘기면 lint 검사를 이번 세션이 편집한 파일로 스코프하는 것까지 인터랙티브 게이트와 동일하게 동작합니다. read-only dry-run이지 절대적 보증은 아닙니다. 라이브 게이트는 컨텍스트 압박 프롬프트·`HYPO_SKIP_GATE` bypass·이 명령이 못 본 transcript-스코프 lint 에러에서 달라질 수 있습니다. JSON은 기존 `ok`/`project`/`dates`/`stale`/`missing` 필드를 유지하며 `blockers`/`notices`/`skipped`를 추가합니다. ([#109](https://github.com/sk-lim19f/Hypomnema/pull/109))
- stale해진 feedback 투영이 더는 `/compact`를 막지 않고, 게이트가 직접 재동기화합니다. 위키 `pages/feedback/*.md`가 source-of-truth이고, `MEMORY.md`·`CLAUDE.md` learned-behaviors 블록은 그 단방향 투영입니다. feedback 페이지를 편집하면 투영이 stale해지는데 자동 재생성이 없어, 다음 `/compact`가 항상 "feedback-sync --write 실행"으로 막혔습니다. 그런데 실행해도 눈에 보이는 변화가 없었습니다(drift는 per-feedback side-file에 있고 보이는 `MEMORY.md` 본문은 그대로였기 때문입니다). 이제 PreCompact 게이트가 self-heal합니다. 문제가 순수 투영 drift(결정론적·byte-identical 재생성)뿐이면 게이트가 sync를 직접 돌리고 진행하며, 재동기화했음을 배너에 알립니다. 사람의 판단이 진짜 필요한 두 경우는 설계상 계속 차단됩니다. managed block 수기 편집(conflict이며 `feedback-sync --import-target-change`로 해소합니다)과 투영 over-cap(feedback 페이지를 demote하거나 archive합니다)입니다. auto-sync는 다음 세션을 위해 디스크 파일을 갱신할 뿐, 현재 세션에 이미 로드된 memory는 바꾸지 않습니다. ([#108](https://github.com/sk-lim19f/Hypomnema/pull/108))
- 무인자 `/hypo:resume`이 이제 현재 디렉토리의 프로젝트를 우선 로드합니다. 현재 디렉토리가 어떤 프로젝트의 `working_dir`과 일치하면, `hot.md`에 더 최신 항목을 가진 다른 프로젝트가 있어도 그 프로젝트를 로드합니다. 이전에는 현재 디렉토리를 같은 날짜 동률을 깰 때만 참조해서, 더 최신 비매칭 row가 하나라도 있으면 항상 그쪽이 이겼습니다. 그래서 며칠 전 마지막으로 작업한 프로젝트의 repo에서 resume을 실행하면 무관한 최신 프로젝트가 로드됐고, 그 프로젝트의 `working_dir`이 현재 머신에 없으면 dead-end였습니다. 이제 현재 디렉토리를 더 강한 신호로 보고(사용자가 물리적으로 그 repo에 있기 때문입니다), wiki-row·레거시 markdown-row·수정시각 fallback 경로 모두에서 recency fallback보다 먼저 적용합니다. 덮어쓰려면 `--project=<name>`을 넘기면 됩니다. session-close 게이트는 변함이 없습니다. close 검증은 현재 디렉토리로 프로젝트를 고르지 않으므로 영향이 없습니다. ([#107](https://github.com/sk-lim19f/Hypomnema/pull/107))
- transcript가 없는 PreCompact가 무관한 lint debt로 `/compact`를 더는 차단하지 않습니다. session-close 게이트는 차단성 lint을 이 세션이 책임지는 파일(필수 close 파일과 transcript가 보여주는 편집 파일)로 스코프하고 나머지는 non-blocking notice로 표시합니다. 무-transcript fallback만 예외로 **vault 전체**를 게이트해서, 이 세션이 건드리지도 않은 타 프로젝트·공유 페이지의 lint error가 `/compact`를 인질로 잡았습니다. 이제 fallback은 필수 close 파일(`closeFileTargets`)로 스코프됩니다. 이 파일들은 transcript 없이 도출 가능한 유일한 파일입니다. 일반 인터랙티브 `/compact`는 영향이 없습니다(manual·auto 압축 모두 Claude Code 훅 계약상 항상 transcript를 싣기 때문입니다). 이 변경은 headless/프로그램적 경로에만 적용되며, 거기서 옛 전역 게이트는 더 안전한 스코프가 아니라 잘못된 스코프였습니다. transcript가 있는 경로는 동작이 보존됩니다. ([#103](https://github.com/sk-lim19f/Hypomnema/pull/103))
- 비-프로젝트(툴링·위키 전용) 세션을 무관한 프로젝트에 강제로 엮지 않고 닫을 수 있습니다. session-close는 모든 세션이 active 프로젝트에 속한다고 가정해서, 자기가 닫을 것이 없는 툴링·위키 전용 세션이 recency 프로젝트를 닫도록 내몰렸고 그 프로젝트의 핸드오프를 clobber할 위험이 있었습니다. `crystallize --mark-session-closed --log-only`는 그런 세션을 오늘치 `log.md` 항목 하나(최소 증거)로 닫고 프로젝트 귀속을 기록하지 않는 1급 경로이며, git·lint·feedback 검사는 그대로 적용됩니다(게이트 우회가 아닙니다). `/compact` 게이트와 `--check-session-close`는 log-only 마커를 session id로 인식하고, Stop 훅은 프로젝트 close 차단이 실제로 있을 때만 `--log-only`를 제시하므로 실제 프로젝트 세션이 close를 건너뛰도록 학습되지 않습니다. ([#122](https://github.com/sk-lim19f/Hypomnema/pull/122))
- 세션별 close 마커가 이제 `/compact`와 동일한 게이트를 사용하여, `/compact`가 막을 close를 마커가 인증하지 못합니다. 마커는 실제 PreCompact 게이트보다 좁은 검사를 통과 기준으로 삼아, 손수 편집한 close가 feedback 투영·design-history stale·루트 `hot.md` 구조에서 `/compact`는 막히는데 마커는 써지는 경우가 있었습니다(반대로 writer를 우회한 close는 마커가 없어 Stop 훅이 막았습니다). 이제 두 마커 writer 모두 `precompactGateStatus`를 거치며, 게이트에 차단 사유가 있으면 마커를 거부합니다(git clean도 그 차단 사유 중 하나입니다). 순수 feedback drift는 비차단으로 남습니다(마커는 써지고 게이트가 `/compact`에서 self-heal합니다). ([#110](https://github.com/sk-lim19f/Hypomnema/pull/110))
- 세션 close가 이제 recency 한 곳이 아니라 오늘 활동한 모든 프로젝트를 게이트합니다. payload 없는 close 경로는 프로젝트를 루트 `hot.md` 최상단 row에서 재도출해서, recency 승자가 아닌 프로젝트를 닫으면 false-block이 나고, 다른 프로젝트가 부분 close로 세션을 끝내는 것을 막는 전역 규칙도 없었습니다. 이제 게이트는 오늘 close 활동이 있는 모든 프로젝트를 검사하여 하나라도 미완이면 차단하고, 활동 프로젝트가 없을 때만 recency 프로젝트로 폴백합니다(from-zero 강제 close는 그대로입니다). apply 경로는 명시적 `payload.project` 권한을 유지합니다. resume은 여전히 현재 디렉토리를 우선하고, close는 디렉토리로 프로젝트를 고르지 않으며, 회귀 테스트가 그 구분을 고정합니다. ([#106](https://github.com/sk-lim19f/Hypomnema/pull/106))
- 손수 편집한 close가 루트 `log.md` 항목을 건너뛰어도 더는 모든 프로젝트의 `/compact`를 막지 않습니다. 루트 `log.md`의 session 줄은 close가 이미 쓴 프로젝트 session-log 헤딩을 다시 적은 것인데, 도출 가능한 산출물 중 유일하게 수동 단계로 남아 있어서 건너뛰면 전역 게이트가 세션을 넘나들며 하드 차단하고 매번 새 결함처럼 보였습니다. 이제 hot-rebuild Stop 훅이 session-log 헤딩에서 누락 항목을 도출하되, 남은 차단 사유가 그 줄뿐인 프로젝트에 한해 적용합니다(그 외에 미완인 close는 계속 차단합니다). close 마커 자체는 일부러 도출하지 않습니다. 게이트가 실제로 돌았다는 증거이기 때문입니다. ([#112](https://github.com/sk-lim19f/Hypomnema/pull/112))
- design-history stale(W8)이 무-설계 세션 뒤에 프로젝트를 false-flag하지 않습니다. lint은 최신 session-log 날짜를 최신 design-history 날짜와 비교했는데, design-history는 설계 변경 시에만 append되고 session-log는 매 세션 늘어나므로, 설계를 바꾸지 않은 세션이 날짜를 design-history 너머로 영영 밀어냈습니다. 이제 검사는 session-log를 항목별로 읽어, 같은 블록에 ADR 참조 없이 명시적 무-설계 마커를 단 항목만 제외하므로, 설계를 바꾸고도 기록을 빠뜨린 실제 경우의 하드 차단은 보존됩니다. ([#104](https://github.com/sk-lim19f/Hypomnema/pull/104))
- 세션 close와 resume이 선택이 비자명할 때 어느 프로젝트에 작용했는지 알립니다. `crystallize --apply-session-close`는 쓰기와 신선도 검사에 명시적 `payload.project`를 이미 존중했지만, 그것이 추론된 active 프로젝트와 다를 때 그 차이가 무음이었습니다. 이제 실제로 검증한 프로젝트를 한 줄 stderr로 알립니다. resume도 현재 디렉토리가 어떤 프로젝트와도 안 맞을 때(`index.md`나 `working_dir` 결여) 무음으로 최신 프로젝트로 폴백했는데, 이제 각 폴백 지점에서 진단을 출력하고 폴백할 대상이 전혀 없는 fresh install에서만 조용합니다. stdout JSON 계약은 그대로입니다. ([#119](https://github.com/sk-lim19f/Hypomnema/pull/119))
- `lint --json`이 파이프에서 출력을 잘리지 않게 되어, 무관한 lint debt로 세션 close가 중단되던 문제가 사라졌습니다. linter는 JSON을 출력한 직후 `process.exit()`를 호출했는데, 파이프에서는 동기 종료가 OS 버퍼가 비워지기 전에 프로세스를 내려서 큰 출력을 64 KiB에서 잘랐습니다. 그러면 모든 spawn-and-parse 소비자가 `JSON.parse`에서 크래시했고, apply-session-close 경로에서는 close 전체가 중단됐습니다. 이제 linter는 exit code를 설정하고 Node가 자연히 종료하게 하여 stdout이 완전히 flush됩니다(exit-code 계약은 보존). PreCompact 게이트는 lint spawn 실패·timeout·빈 출력을 조용히 통과시키지 않고 사유가 있는 가시적 fail-open으로 처리하며, apply-session-close 경로는 lint 헬퍼 실패를 진단 메타데이터(출력 크기·exit/signal·stderr 꼬리)와 함께 hard-fail로 보고합니다(조용한 통과나 잘린 덤프가 아닙니다). ([#120](https://github.com/sk-lim19f/Hypomnema/pull/120))
- linter가 볼트 관습 위키링크를 깨진 링크로 보고하지 않게 되어, 진짜 깨진 링크를 가리던 오탐이 정리됐습니다. 세 가지 해석 공백이 깨진 링크 수를 부풀렸습니다. `pages/learnings/foo.md`에 대한 디렉토리 상대 링크 `[[learnings/foo]]`가 키로 잡히지 않았고, 루트 `*.md`와 `sources/*`가 유효한 대상으로 수집되지 않았으며(그래서 `[[hypo-guide]]`·`[[SCHEMA]]`·`[[sources/x]]`가 실존하는데도 깨진 것으로 표시), 마크다운 테이블 이스케이프 alias `[[a/b\|label]]`가 뒤따르는 백슬래시를 잡아 매칭에 실패했습니다. 이제 셋 다 올바르게 해석되어 깨진 링크 경고가 실제 dangling 링크만 반영합니다. ([#121](https://github.com/sk-lim19f/Hypomnema/pull/121))
- 사용자 대상 문서가 메인테이너의 비공개 위키 결정 기록을 더는 가리키지 않습니다. README·한국어 README·아키텍처/기여 가이드가 설치 사용자가 열 수 없는 내부 결정 기록 id를 참조했는데, 그 괄호 참조를 제거했고(기여 가이드의 낡은 숫자 decisions 경로는 와일드카드로 대체) 양 언어의 산문은 그대로 유지했습니다. 스코프된 회귀 검사가 그 포인터를 사용자 대상 문서에서 막되, 메인테이너 맥락을 위해 앵커를 유지하는 배포 코드 주석과 changelog 히스토리는 건드리지 않습니다. ([#111](https://github.com/sk-lim19f/Hypomnema/pull/111))

### Chores

#### English

- The Claude marketplace plugin is renamed `hypomnema` to `hypo`, so its slash commands now match the docs. Claude Code namespaces a plugin's slash commands by the plugin's `name` field, so the plugin (named `hypomnema`) actually registered its commands as `/hypomnema:resume`, `/hypomnema:init`, and so on. Every doc, command body, and `/hypo:init` reference assumed `/hypo:*`, so a user who installed via the marketplace and followed the README hit "command not found". (The npm/manual install path was never affected: it copies the command files into `~/.claude/commands/hypo/`, which already yields `/hypo:*`.) Renaming the plugin to `hypo` makes both install paths expose the same `/hypo:*` namespace the docs describe. The marketplace itself keeps its name (`hypomnema`), so `/plugin marketplace add` and `/plugin marketplace update hypomnema` are unchanged; only the plugin identifier in the install command changes. (See the migration callout above.) ([#101](https://github.com/sk-lim19f/Hypomnema/pull/101))
- Session logs are now written as daily shards (`session-log/YYYY-MM-DD.md`) instead of one file per month. A month's log grew to thousands of lines, and every session close read the whole file (to append without duplicating and to verify the close is fresh), so the read cost climbed as the month filled up. Each close now touches only today's small file. Existing monthly files (`YYYY-MM.md`) are still read as a fallback, so nothing needs to be migrated or split: daily shards take over going forward, and a close during the cutover month resolves correctly from whichever file holds today's entry. The dated `## [YYYY-MM-DD]` heading still lives inside each entry, so search, root-log derivation, and design-history tracking are unchanged. A new daily file is created with seeded frontmatter (title and type) on its first write. ([#118](https://github.com/sk-lim19f/Hypomnema/pull/118))
- A new `rename` helper rewrites inbound wikilinks when you rename a page. A bare file move left every `[[old]]`, `[[old|alias]]`, `[[old#anchor]]`, and `[[dir/old]]` pointing at a missing target, so broken links piled up on each rename. `scripts/rename.mjs` moves the page and rewrites the eligible inbound references across the vault, resolving each link with the same precedence the linter uses so only references that unambiguously point at the renamed page are touched (a basename shared by two pages is reported, never blind-rewritten). Append-only records (journal, session-log, weekly, archive, postmortems) and immutable sources are left alone so past snapshots stay truthful. It runs as a dry-run by default; pass `--apply` to write the move and rewrites. ([#123](https://github.com/sk-lim19f/Hypomnema/pull/123))
- A substantial read-only session (a review or debugging pass) is now nudged to close, not just a mutating one. The Stop-chain close gate counted a session as substantial only when it edited a file, so a read-only code-review or debugging session that reached a real conclusion was never prompted to crystallize it. A session now counts as substantial when it has any edit or at least five read-only investigation calls (Read/Grep/Glob/Bash), the same cutoff the session audit uses. Mutating sessions behave exactly as before, and over-firing is bounded by the existing close-intent gate: a block still requires a wrap-up signal from you. ([#113](https://github.com/sk-lim19f/Hypomnema/pull/113))
- Shipped files, README/CHANGELOG, and commit messages are now gated against references to the maintainer's private wiki trackers. A pointer to a private tracker entry is a dangling reference an installed user cannot resolve, and a load-time reminder did not hard-stop them, so they accumulated. A mechanical check (`check-tracker-ids`) runs at three points (a full-repo scan, a staged-blob pre-commit hook, and a commit-message hook) and blocks the private ids while leaving GitHub references (`PR #N`, `(#N)`, issue URLs) and ADR anchors untouched. ([#102](https://github.com/sk-lim19f/Hypomnema/pull/102))

#### 한국어

- Claude 마켓플레이스 플러그인 이름을 `hypomnema`에서 `hypo`로 변경하여 슬래시 커맨드가 문서와 일치하게 되었습니다. Claude Code는 플러그인 슬래시 커맨드를 플러그인의 `name` 필드로 네임스페이싱합니다. 그래서 이름이 `hypomnema`인 플러그인은 커맨드를 실제로 `/hypomnema:resume`, `/hypomnema:init` 등으로 등록했습니다. 모든 문서·커맨드 본문·`/hypo:init` 안내는 `/hypo:*`을 가정했으므로, 마켓플레이스로 설치하고 README를 따른 사용자는 "command not found"를 만났습니다. (npm/수동 설치 경로는 영향이 없었습니다. 커맨드 파일을 `~/.claude/commands/hypo/`로 복사하므로 처음부터 `/hypo:*`이 됩니다.) 플러그인 이름을 `hypo`로 바꾸면 두 설치 경로 모두 문서가 설명하는 동일한 `/hypo:*` 네임스페이스를 노출합니다. 마켓플레이스 이름(`hypomnema`)은 그대로이므로 `/plugin marketplace add`와 `/plugin marketplace update hypomnema`는 변하지 않으며, 설치 명령의 플러그인 식별자만 바뀝니다. (위 마이그레이션 콜아웃을 참조하세요.) ([#101](https://github.com/sk-lim19f/Hypomnema/pull/101))
- 세션 로그를 월별 단일 파일 대신 일별 shard(`session-log/YYYY-MM-DD.md`)로 기록합니다. 한 달치 로그가 수천 줄로 커지면서 매 세션 종료가 그 파일 전체를 읽었고(중복 없이 append하고 종료 신선도를 확인하기 위해서입니다), 달이 찰수록 읽기 비용이 커졌습니다. 이제 종료는 오늘치 작은 파일만 건드립니다. 기존 월별 파일(`YYYY-MM.md`)은 fallback으로 계속 읽으므로 마이그레이션이나 분할이 필요 없습니다. 일별 shard가 이후부터 인계받고, 전환 달의 종료는 오늘 항목이 든 파일에서 올바르게 해석됩니다. 날짜 헤딩(`## [YYYY-MM-DD]`)은 각 항목 안에 그대로 있으므로 검색·루트 로그 도출·design-history 추적은 변함이 없습니다. 새 일별 파일은 첫 기록 시 frontmatter(title·type)를 seed하여 생성합니다. ([#118](https://github.com/sk-lim19f/Hypomnema/pull/118))
- 페이지 이름을 바꿀 때 새 `rename` 헬퍼가 인바운드 위키링크를 갱신합니다. 단순 파일 이동은 `[[old]]`·`[[old|alias]]`·`[[old#anchor]]`·`[[dir/old]]`를 모두 사라진 대상에 남겨, rename마다 깨진 링크가 쌓였습니다. `scripts/rename.mjs`는 페이지를 옮기고 볼트 전체에서 해당하는 인바운드 참조를 갱신하되, 각 링크를 linter와 동일한 우선순위로 해석하여 rename된 페이지를 명확히 가리키는 참조만 바꿉니다(두 페이지가 basename을 공유하면 자동 치환하지 않고 보고합니다). append-only 기록(journal·session-log·weekly·archive·postmortems)과 immutable한 sources는 건드리지 않아 과거 스냅샷이 사실로 남습니다. 기본은 dry-run이며, `--apply`를 넘기면 이동과 갱신을 기록합니다. ([#123](https://github.com/sk-lim19f/Hypomnema/pull/123))
- 실질적인 read-only 세션(리뷰·디버깅)도 이제 종료를 권유받습니다. Stop 체인 close 게이트는 파일을 편집한 세션만 "실질적"으로 보아, 실제 결론에 도달한 read-only 코드리뷰·디버깅 세션은 crystallize 권유를 받지 못했습니다. 이제 세션은 편집이 있거나 read-only 조사 호출(Read/Grep/Glob/Bash)이 5건 이상이면 실질적으로 간주됩니다(세션 audit의 cutoff와 동일합니다). 편집 세션의 동작은 이전과 같고, read-only 세션의 과잉 발화는 기존 close-intent 게이트로 제한됩니다(차단에는 여전히 마무리 신호가 필요합니다). ([#113](https://github.com/sk-lim19f/Hypomnema/pull/113))
- 배포 파일·README/CHANGELOG·커밋 메시지가 메인테이너의 비공개 위키 트래커 참조를 차단합니다. 비공개 트래커 항목을 가리키는 포인터는 설치 사용자가 풀 수 없는 dangling 참조이고, 로드 시점 알림으로는 강제 차단되지 않아 누적됐습니다. 기계적 검사(`check-tracker-ids`)가 세 지점(전체 스캔, staged blob pre-commit 훅, commit-message 훅)에서 비공개 id를 차단하되, GitHub 참조(`PR #N`·`(#N)`·이슈 URL)와 ADR 앵커는 건드리지 않습니다. ([#102](https://github.com/sk-lim19f/Hypomnema/pull/102))

### Known Issues

- `scripts/lint.mjs` counts example wikilink placeholders that appear inside code spans or fenced code blocks (a literal `[[slug]]` written in documentation) as broken links, which inflates the broken-link warning total. These are warnings, not errors, so they never block a session close; scoping the scan to skip code spans is planned.
- `scripts/lint.mjs`가 코드 스팬이나 펜스 코드 블록 안에 적힌 예시 위키링크 placeholder(문서에 글자 그대로 쓴 `[[slug]]`)를 깨진 링크로 집계하여, 깨진 링크 경고 수가 부풀려집니다. error가 아니라 warning이므로 세션 종료를 막지는 않습니다. 코드 스팬을 건너뛰도록 스캔 범위를 좁히는 작업을 계획하고 있습니다.

### Changelog

- [#101](https://github.com/sk-lim19f/Hypomnema/pull/101) plugin installs as `hypo`
- [#118](https://github.com/sk-lim19f/Hypomnema/pull/118) daily session-log shards
- [#109](https://github.com/sk-lim19f/Hypomnema/pull/109) check-session-close shares the compact gate
- [#122](https://github.com/sk-lim19f/Hypomnema/pull/122) log-only close for non-project sessions
- [#123](https://github.com/sk-lim19f/Hypomnema/pull/123) rename helper rewrites inbound wikilinks
- [#113](https://github.com/sk-lim19f/Hypomnema/pull/113) read-only sessions nudged to close
- [#102](https://github.com/sk-lim19f/Hypomnema/pull/102) tracker-id gate on shipped files and commits
- [#108](https://github.com/sk-lim19f/Hypomnema/pull/108) stale feedback projection auto-resyncs
- [#107](https://github.com/sk-lim19f/Hypomnema/pull/107) resume prefers the current directory
- [#103](https://github.com/sk-lim19f/Hypomnema/pull/103) transcript-less PreCompact scopes lint
- [#110](https://github.com/sk-lim19f/Hypomnema/pull/110) per-session close marker shares the gate
- [#106](https://github.com/sk-lim19f/Hypomnema/pull/106) close gates every project active today
- [#112](https://github.com/sk-lim19f/Hypomnema/pull/112) derive a missing root log.md line
- [#104](https://github.com/sk-lim19f/Hypomnema/pull/104) design-history staleness no longer false-flags
- [#119](https://github.com/sk-lim19f/Hypomnema/pull/119) close and resume name the acted project
- [#120](https://github.com/sk-lim19f/Hypomnema/pull/120) lint --json no longer truncates on a pipe
- [#121](https://github.com/sk-lim19f/Hypomnema/pull/121) linter resolves vault-convention wikilinks
- [#111](https://github.com/sk-lim19f/Hypomnema/pull/111) user-facing docs drop private decision ids

Contributors: @sk-lim19f

## [1.3.1] - 2026-06-09

### Bug Fixes

#### English

- Update-notifier banners now actually reach the user. The SessionStart hook computed an "Update available" banner (ADR 0033) and a stale-sibling banner (ADR 0038 D3) but emitted them only to **stderr** (invisible in the normal TUI on a hook that exits 0) and to `additionalContext`, which is model-only. Per the Claude Code hooks contract the user-visible channel is the top-level **`systemMessage`** field, which the hook never set, so both notices were no-ops on screen (the version cache would even mark a version "notified" against a banner nobody saw). Both banners now route to `systemMessage` (and stay in `additionalContext`, so the model and the user see the same state). This applies equally to the **npm** and **Claude marketplace (plugin)** channels: the notifier fetches the latest version for both and shows the channel-appropriate upgrade command. Scope: only the update + stale-sibling notices; the sync/growth/clear/suggest lines remain intentionally transcript-only.
- Plugin installs no longer double-register core hooks on `/hypo:upgrade --apply`. When Hypomnema is installed as a Claude Code **plugin**, the 15 core hooks and 14 slash commands are provided by the plugin loader (`hooks.json` + `commands/`), not copied into `~/.claude/`. `upgrade.mjs` assumed the manual/npm install model, reported ~47 items "missing", and recommended `--apply`, which copied the hooks into `~/.claude/hooks/` and registered 14 `settings.json` events, so Claude Code then ran **both** the plugin hooks and the user hooks and every hook fired **twice**. A plugin-mode guard (keyed on the running `upgrade.mjs` living under `~/.claude/plugins/`) now reports the core surface as "provided by the plugin loader", excludes it from drift, and skips copying/registering it on `--apply`. Vault extensions, the codex target (`--codex`), and `hypo-pkg.json` metadata stay managed: the metadata write is required so the runtime can resolve the package root for the PreCompact lint/feedback gates.
- `/hypo:resume` respects the working directory on a same-date tie. With no `--project`, `resolveActiveProject` sorted the root `hot.md` "Active Projects" rows by date only; when two projects shared the latest date, the table's top row always won regardless of where you were working. A **tie-breaker-only** cwd match (cwd ↔ each project's `session-state.md` `working_dir`, longest-prefix) now breaks same-date ties without overriding a genuinely newer non-matching project. `resume.mjs` and the mirrored `hooks/hypo-shared.mjs` are kept in sync.
- `resume.mjs` `--hypo-dir` header comment corrected. The comment described root resolution as a sequential `A / B / C` fallback chain, but `$HYPO_DIR` actually takes precedence and short-circuits the other steps. Pure comment fix, no runtime change.
- `/hypo:upgrade` no longer double-registers core hooks in a dual install. A plugin-mode guard stopped the *plugin's* `upgrade.mjs` from copying the core hooks into `~/.claude/`. The mirror-image case remained: when you run the **manual/npm** `upgrade.mjs` (so `pluginMode` is false and it manages the Claude core surface) **while the Hypomnema plugin is also enabled**, `--apply` would copy the 15 core hooks into `~/.claude/hooks/` and register 14 `settings.json` events on top of the plugin loader's own `hooks.json`, so every core hook fires **twice**. `upgrade.mjs` now detects an enabled plugin (a conservative, fail-open parse of `~/.claude/settings.json` `enabledPlugins` for an exact `hypomnema@<marketplace>: true` entry, `scripts/lib/plugin-detect.mjs`) and, by default, **skips the core surface** (which the plugin already provides) with a loud banner, while still syncing vault extensions, the codex target, and package metadata. In a dual install the existing (plugin-written) `hypo-pkg.json` identity is **preserved** rather than repointed at the npm copy, and the preserved metadata is no longer flagged as perpetual "stale" drift. The new `--allow-dual-install` flag overrides the guard to register the core surface anyway (knowingly accepting the double-register risk). The detector only fires on a precise, well-formed entry, so a legitimate npm-only user is never blocked (the asymmetric cost the guard is tuned against).
- Session-close no longer false-blocks a completed close on a same-date project tie (Part A). `crystallize --apply-session-close` resolves the authoritative project once (`payload.project || probe.project`) and writes the five mandatory close files for it (three project-scoped, plus the project's row/entry in root `hot.md` and `log.md`), but the **post-apply verification** re-derived the project via `resolveActiveProject()`, which, on a same-date tie in root `hot.md`'s pointer table, returns the table's **top** row (stable-sort). So a finished close of project B could be verified against a *different* project A and reported `ok:false` (A's `log.md` entry was missing), leaving the closed-marker unwritten and the Stop hook re-prompting (observed 2026-06-09: a completed `security-ops-kb` close was blocked by an unrelated `hypomnema` row). `sessionCloseFileStatus` now accepts a `projectOverride`, and the apply path passes the project it actually wrote, so write-project and verify-project can no longer diverge. Scope: the **apply** path only; the Stop-hook / payload-less probe paths still resolve from the pointer table (a cwd-aware tie-break there has a cross-project masking risk and is tracked separately as follow-up work (Part B)). No signature change for any existing caller (new arg is an options object).

#### 한국어

- 업데이트 notifier 배너가 이제 실제로 사용자에게 도달. SessionStart 훅이 "Update available" 배너(ADR 0033)와 stale-sibling 배너(ADR 0038 D3)를 계산하지만 **stderr**(exit 0 훅에선 일반 TUI에 비가시)와 모델 전용 `additionalContext`로만 출력했다. Claude Code 훅 계약상 사용자 가시 채널은 top-level **`systemMessage`**인데 훅이 이를 설정하지 않아 두 배너 모두 화면에선 무효였다(버전 캐시는 아무도 못 본 배너를 "notified"로 마킹까지 함). 두 배너를 이제 `systemMessage`로 라우팅한다(`additionalContext`에도 유지 → 모델·사용자 동기). **npm**·**Claude marketplace(plugin)** 두 채널 모두 동일 적용. notifier가 양 채널의 latest를 fetch해 채널별 업그레이드 명령을 보여준다. 범위: update + stale-sibling만, sync/growth/clear/suggest는 의도적으로 transcript 전용 유지.
- 플러그인 설치에서 `/hypo:upgrade --apply`가 더는 core 훅을 중복 등록하지 않음. Hypomnema를 Claude Code **플러그인**으로 설치하면 core 훅 15개·슬래시 커맨드 14개를 플러그인 로더(`hooks.json` + `commands/`)가 제공하며 `~/.claude/`로 복사되지 않는다. `upgrade.mjs`가 수동/npm 설치 모델을 가정해 ~47개를 "missing"으로 보고하고 `--apply`를 권했고 → `--apply`가 훅을 `~/.claude/hooks/`로 복사 + `settings.json` 이벤트 14개 등록 → Claude Code가 플러그인 훅과 사용자 훅을 **둘 다** 실행해 모든 훅이 **2회씩** 발화했다. 플러그인 모드 가드(실행 중 `upgrade.mjs`가 `~/.claude/plugins/` 하위인지로 판정)가 이제 core 표면을 "provided by the plugin loader"로 보고하고 drift에서 제외하며 `--apply` 시 복사·등록을 skip한다. vault extensions·codex 타깃(`--codex`)·`hypo-pkg.json` 메타데이터는 계속 관리. 메타데이터 write는 런타임이 PreCompact lint/feedback 게이트용 패키지 루트를 해석하는 데 필요.
- `/hypo:resume`가 동률 날짜에서 작업 디렉터리를 존중. `--project` 미지정 시 `resolveActiveProject`가 루트 `hot.md`의 "Active Projects" 행을 날짜로만 정렬해, 같은 날짜 프로젝트가 둘이면 작업 위치와 무관하게 테이블 최상단 행이 항상 선택됐다. **tie-breaker 전용** cwd 매칭(cwd ↔ 각 프로젝트 `session-state.md`의 `working_dir`, longest-prefix)이 더 최신인 비매칭 프로젝트를 덮어쓰지 않으면서 동률만 깬다. `resume.mjs`와 미러 `hooks/hypo-shared.mjs`를 동기화.
- `resume.mjs` `--hypo-dir` 헤더 주석 정정. 주석이 root resolution을 순차 `A / B / C` 폴백 체인처럼 기술했으나, 실제로는 `$HYPO_DIR`이 최우선이며 나머지 단계를 단락(short-circuit)한다. 순수 주석 수정, 런타임 변경 없음.
- `/hypo:upgrade`가 dual install에서 core 훅을 더는 중복 등록하지 않음. 플러그인 모드 가드가 *플러그인의* `upgrade.mjs`가 core 훅을 `~/.claude/`로 복사하는 것을 막았다. 거울상 케이스가 남아 있었다. **수동/npm** `upgrade.mjs`를 실행(`pluginMode`=false라 Claude core 표면을 관리)하면서 **Hypomnema 플러그인도 enabled**이면, `--apply`가 core 훅 15개를 `~/.claude/hooks/`로 복사하고 `settings.json` 이벤트 14개를 플러그인 로더의 `hooks.json` 위에 등록 → 모든 core 훅이 **2회** 발화한다. 이제 `upgrade.mjs`가 enabled 플러그인을 감지(`~/.claude/settings.json` `enabledPlugins`에서 정확한 `hypomnema@<marketplace>: true` 항목만 보는 보수적·fail-open 파서, `scripts/lib/plugin-detect.mjs`)해, 기본적으로 **core 표면을 skip**(플러그인이 이미 제공)하고 큰 경고 배너를 띄우며, vault extensions·codex 타깃·패키지 메타데이터는 계속 동기화한다. dual install에서는 기존(플러그인이 쓴) `hypo-pkg.json` identity를 npm 복사본으로 repoint하지 않고 **보존**하며, 보존된 메타데이터를 더는 영구 "stale" drift로 표시하지 않는다. 새 `--allow-dual-install` 플래그는 가드를 우회해 core 표면을 등록한다(중복 등록 위험 인지·수용). 감지기는 정확한 well-formed 항목에만 발화하므로 정당한 npm-only 사용자는 절대 막히지 않는다(가드가 겨냥한 비대칭 비용).
- 세션-close가 동률 날짜 프로젝트 tie에서 완료된 close를 더는 false-block 하지 않음 (Part A). `crystallize --apply-session-close`는 닫는 프로젝트를 한 번 확정(`payload.project || probe.project`)해 그 프로젝트의 5개 필수 close 파일을 쓰지만(3개는 project-scoped, 나머지는 루트 `hot.md`·`log.md`의 해당 프로젝트 행/엔트리), **post-apply 검증**이 `resolveActiveProject()`로 프로젝트를 재해석했다. 루트 `hot.md` 포인터 테이블에서 날짜가 동률이면 stable-sort로 **테이블 최상단** 행을 반환한다. 그래서 프로젝트 B의 완료된 close가 *다른* 프로젝트 A 기준으로 검증돼 `ok:false`(A의 `log.md` 엔트리 부재)를 받고, closed-marker 미기록 → Stop 훅 재프롬프트가 발생했다(2026-06-09 실증: 완료된 `security-ops-kb` close가 무관한 `hypomnema` 행 때문에 막힘). 이제 `sessionCloseFileStatus`가 `projectOverride`를 받고 apply 경로가 실제로 쓴 프로젝트를 전달 → write-project와 verify-project가 갈릴 수 없다. 범위: **apply** 경로만. Stop-훅/무-payload probe 경로는 여전히 포인터 테이블로 해석(거기에 cwd tie-break을 넣으면 cross-project 마스킹 위험이라 follow-up(Part B)으로 분리 추적). 기존 caller 시그니처 변경 없음(새 인자는 옵션 객체).

### Chores

#### English

- CI/release hardening (no user-facing surface change). A `workflow_dispatch` publish-credential pre-check that never publishes (`npm whoami` + read-write probe + `npm publish --dry-run`); the precheck's **exit-254 root fix**: `npm publish --dry-run` exported `npm_config_dry_run=true` into the lifecycle env, which leaked into smoke-pack's nested `npm pack` (making it a no-op that wrote no tarball, so the nested install died with ENOENT → exit 254); smoke-pack now strips that flag for its nested npm calls and dropped the `--silent` mask. The release workflow also gained a GitHub Release step (`--notes-from-tag`) and an idempotent publish guard (skip the PUT only when this exact version is already on the registry). README version anchors were reconciled with a v1.3.0 lane. These touch CI/maintainer workflows only; the installed product is unchanged.

#### 한국어

- CI/릴리스 hardening (사용자 대상 표면 변경 없음). 절대 publish하지 않는 `workflow_dispatch` publish-credential 사전 검사(`npm whoami` + read-write probe + `npm publish --dry-run`). precheck의 **exit-254 root fix**: `npm publish --dry-run`이 `npm_config_dry_run=true`를 lifecycle env로 내보냈고, 그것이 smoke-pack의 중첩 `npm pack`으로 새어 들어가(tarball을 안 쓰는 no-op가 되어 중첩 install이 ENOENT로 죽고 → exit 254) 발생했다. smoke-pack은 이제 중첩 npm 호출에서 그 플래그를 벗기고 `--silent` 마스크를 제거했다. 릴리스 워크플로는 GitHub Release 단계(`--notes-from-tag`)와 멱등 publish 가드(이 정확한 버전이 이미 레지스트리에 있을 때만 PUT을 건너뜀)도 추가했다. README 버전 앵커를 v1.3.0 lane으로 정합했다. CI/maintainer 워크플로 변경만 포함하며 설치되는 제품 표면은 동일하다.

### Changelog

- [#88](https://github.com/sk-lim19f/Hypomnema/pull/88) reconcile README version anchors + add v1.3.0 lane
- [#89](https://github.com/sk-lim19f/Hypomnema/pull/89) add workflow_dispatch publish-credential pre-check
- [#90](https://github.com/sk-lim19f/Hypomnema/pull/90) restore NODE_AUTH_TOKEN on precheck dry-run
- [#91](https://github.com/sk-lim19f/Hypomnema/pull/91) cwd-aware same-date tie-break for active project selection
- [#92](https://github.com/sk-lim19f/Hypomnema/pull/92) add GitHub Release step + idempotent publish guard
- [#93](https://github.com/sk-lim19f/Hypomnema/pull/93) correct resume `--hypo-dir` resolution-order comment
- [#94](https://github.com/sk-lim19f/Hypomnema/pull/94) strip inherited npm_config_dry_run in smoke-pack
- [#95](https://github.com/sk-lim19f/Hypomnema/pull/95) route update + stale-sibling banners to systemMessage
- [#96](https://github.com/sk-lim19f/Hypomnema/pull/96) guard plugin installs from double-registering core hooks
- [#97](https://github.com/sk-lim19f/Hypomnema/pull/97) verify session-close against payload.project on a same-date tie
- [#98](https://github.com/sk-lim19f/Hypomnema/pull/98) guard manual/npm --apply from double-registering core when the plugin is enabled
- [#99](https://github.com/sk-lim19f/Hypomnema/pull/99) prepare v1.3.1 (bump version + CHANGELOG)

Contributors: @sk-lim19f

## [1.3.0] - 2026-06-07

### New Features

#### English

- Stale-sibling install detection: downgrade guard + PATH-CLI notice + doctor scan (ADR 0038). When a second, older Hypomnema sits on `$PATH` (e.g. a leftover `npm i -g hypomnema`) while a newer copy owns the active hooks, running `hypomnema init` / `upgrade --apply` through the stale bin used to **silently downgrade** the newer registered hooks (dropping features like the update-notifier). Three coordinated defenses now exist: **(P, preventive)** `init` and `upgrade --apply` refuse to overwrite a newer active install. They compare the running package version against `~/.claude/hypo-pkg.json`'s `pkgVersion` using full semver and abort with **exit 2** unless `--allow-downgrade` is passed; a dev workspace re-running its own install is exempt via realpath-equal `pkgRoot` (so the post-commit sync hook and `npm link` setups are never mis-flagged). **(D3, detective, reaches the live victim)** the SessionStart notifier resolves the `hypomnema` bin on `$PATH` (fs-only; no `npm`/`which` spawn) and warns once per `(cliPath@version → activeVersion)` tuple when it is strictly older than the active install. This is the only surface that reaches a user already stuck on the old CLI, since `hypomnema doctor` invoked via the stale bin would run the *old* doctor. **(D, detective backstop)** `hypomnema doctor` adds a `PATH CLI vs active install` check (warn + `npm uninstall -g hypomnema` remediation). Note: the in-product notifier **cannot** retroactively warn installs older than v1.2.0 (the notifier did not exist yet): that bootstrap gap is unfixable in code; the guard protects forward, and the doctor/notifier surfaces flag the stale copy on any current install.
- `hypomnema lint --strict` promotes selected warnings to errors. A new opt-in `--strict` flag promotes a frozen set of warning classes to errors so they exit 1: a general gate for release-checklists and opt-in pre-commit hooks. Stable warning IDs were introduced (`W1` no-frontmatter, `W2` unknown-type, `W3` missing-`updated`, `W4` broken-wikilink) alongside the pre-existing `W8` (design-history stale). `--strict` promotes `STRICT_PROMOTE_IDS = {W1, W2, W4}` (confirmed content defects) while leaving `W3` (auto-repaired by `--fix`) and `W8` (handled separately by the pre-compact hook) as warnings. Default `hypomnema lint` is **byte-identical**: only `W8` exposes an `id` in `--json` output, so existing consumers (`hooks/hypo-personal-check.mjs`) are unaffected. `npm run lint` and `prepublishOnly` keep using the default mode, and `--strict` is never auto-wired into CI.
- Session-close now surfaces four advisory reflections (ADR 0029 Phase B). The `/hypo:crystallize` session-close flow (exposed both as the `crystallize.md` slash command and the `crystallize` skill) now prompts you, *advisory-only*, on four points before composing the session payload: flag a trivial session and recommend skipping close (without bypassing the mandatory checklist or marking the session closed); when a non-trivial decision lacks an ADR, record `ADR 없음: <reason>` in the session-log payload (it never auto-writes an ADR file); recommend refreshing a stale `design-history.md` (silently skips when none exists, never creates one); recommend `/hypo:ingest` for trustworthy external knowledge acquired in the session (user-confirmed). Every reflection is advisory: none performs an automatic action, none bypasses a gate, none writes a file on its own. A surface-drift guard test pins both surfaces to keep the four advisories and the identity-guard contract present.

#### 한국어

- Stale-sibling 설치 감지: downgrade 가드 + PATH-CLI 노티 + doctor 스캔 (ADR 0038). 더 오래된 Hypomnema가 `$PATH`를 점유(예: 남아있는 `npm i -g hypomnema`)하고 더 새 사본이 active 훅을 소유한 상황에서, stale 바이너리로 `hypomnema init` / `upgrade --apply`를 돌리면 더 새 등록 훅이 **조용히 다운그레이드**(update-notifier 등 기능 제거)되던 footgun을 막는다. 세 방어를 함께 도입: **(P, 예방)** `init`·`upgrade --apply`가 실행 중 패키지 버전과 `~/.claude/hypo-pkg.json`의 `pkgVersion`을 full semver로 비교해, active가 더 새로우면 `--allow-downgrade` 없이는 **exit 2**로 거부한다. dev workspace가 자기 자신을 재실행하는 경우는 `pkgRoot` realpath 동일성으로 면제(post-commit sync 훅·`npm link` 오탐 없음). **(D3, 탐지, 현재 피해자에게 도달)** SessionStart notifier가 `$PATH`의 `hypomnema` 바이너리를 해석(fs-only, `npm`/`which` spawn 없음)해 active보다 엄격히 오래되면 `(cliPath@version → activeVersion)` 튜플당 1회 경고한다. stale 바이너리로 부른 `hypomnema doctor`는 *구버전* doctor를 돌리므로, 이미 옛 CLI에 갇힌 사용자에게 도달하는 유일한 경로다. **(D, 탐지 백스톱)** `hypomnema doctor`에 `PATH CLI vs active install` 체크 추가(warn + `npm uninstall -g hypomnema` 안내). 참고: in-product notifier는 v1.2.0 이전 설치(당시 notifier 미존재)에는 소급 경고할 수 **없다**. 이 bootstrap 갭은 코드로 수정 불가다. 가드는 앞으로를 보호하고, doctor/notifier 표면이 현재 설치에서 stale 사본을 적발한다.
- `hypomnema lint --strict`가 선택 warning을 error로 승격한다. opt-in `--strict` 플래그가 동결된 warning 클래스 집합을 error로 승격해 exit 1로 만든다: release-checklist / opt-in pre-commit용 범용 게이트. 안정 warning ID(`W1` no-frontmatter, `W2` unknown-type, `W3` missing-`updated`, `W4` broken-wikilink)를 기존 `W8`(design-history stale)에 더해 부여했다. `--strict`는 `STRICT_PROMOTE_IDS = {W1, W2, W4}`(확정적 콘텐츠 결함)만 승격하고, `W3`(`--fix`로 자동복구)·`W8`(pre-compact 훅이 별도 처리)은 warning으로 유지한다. 기본 `hypomnema lint`는 **byte-identical**. `--json`에서 `W8`만 `id`를 노출하므로 기존 소비자(`hooks/hypo-personal-check.mjs`)는 무영향. `npm run lint`·`prepublishOnly`는 기본 모드를 그대로 사용하며 `--strict`는 CI에 자동 배선되지 않는다.
- 세션-close가 네 가지 advisory 성찰을 띄운다 (ADR 0029 Phase B). `/hypo:crystallize` 세션-close 흐름(`crystallize.md` 슬래시 커맨드 + `crystallize` 스킬 양쪽)이 세션 payload 작성 전에 네 가지를 *advisory로만* 권고한다: trivial 세션이면 close 스킵 권고(필수 체크리스트 우회·세션 closed 표기는 하지 않음); 비자명 결정에 ADR이 없으면 session-log payload에 `ADR 없음: <이유>` 기록(ADR 파일을 auto-write 하지 않음); stale `design-history.md` 갱신 권고(없으면 silent skip, 생성하지 않음); 세션 중 습득한 신뢰할 만한 외부 지식에 `/hypo:ingest` 권고(user-confirm). 모든 성찰은 advisory다. 자동 동작·게이트 우회·파일 자동 작성을 하는 것은 하나도 없다. surface-drift 가드 테스트가 두 표면에 네 advisory와 identity-guard 계약 문구가 그대로 있는지 검증한다.

### Bug Fixes

#### English

- Session-close gate no longer blocks `/compact` on lint debt this session did not create (ADR 0037). The PreCompact gate and the crystallize apply gate both linted the *entire* vault, so unfinished session-close could be blocked by lint errors in other projects or shared pages you never touched. Each gate is now **scoped to the files this session actually touched** (the PreCompact gate to transcript-touched files ∪ the mandatory close-file targets, the apply gate to its payload files), and errors outside that scope downgrade to a non-blocking notice. A companion marker-coherence fix prevents a session from being marked closed without lint running on its own files: `--mark-session-closed --transcript-path` refuses the marker on scoped-lint failure (without `--transcript-path` it keeps the legacy freshness + clean-git recovery path), and the Stop hook surfaces the transcript path. Broken-wikilink stays `W4` warn-only (forward-references are legitimate; gating on them re-introduced friction).
- `/hypo:feedback` scope validator accepts cwd-derived project ids. The shared `scope:` validator rejected the project-id shape `deriveProjectId` emits (leading dash + mixed case, e.g. `project:-Users-you-Workspace-Project`), so writing a cwd-scoped feedback page failed lint and forced a manual `--project-id=<slug>` override. A single source-of-truth `FEEDBACK_SCOPE_RE` (`scripts/lib/feedback-scope.mjs`, imported by both `lint.mjs` and `feedback.mjs`) now accepts that form while still rejecting dot-only ids (`project:.` / `project:..`); the deriver, on-disk project dirs, and string-equality projection are unchanged.

#### 한국어

- 세션-close 게이트가 이 세션이 만들지 않은 lint debt로 `/compact`를 더는 막지 않는다 (ADR 0037). PreCompact 게이트와 crystallize apply 게이트가 볼트 *전체*를 lint해서, 손대지도 않은 타 프로젝트·공유 페이지의 lint error로 세션-close가 막히던 버그를 수정. 이제 각 게이트는 **이 세션이 실제로 touch한 파일로 스코프**된다(PreCompact는 transcript-touched ∪ 필수 close-파일 타깃, apply는 자신의 payload 파일로). 그리고 스코프 밖 error는 non-blocking notice로 강등된다. marker-coherence 보강으로 자기 파일에 lint가 돌지 않은 채 세션이 closed로 표기되는 것을 방지: `--mark-session-closed --transcript-path`가 스코프-lint 실패 시 marker를 거부하고(`--transcript-path` 없으면 legacy freshness + clean-git 복구 경로 유지), Stop 훅이 transcript path를 노출한다. broken-wikilink는 `W4` warn-only 유지(forward-reference는 정상이며, 게이트 시 마찰 재발).
- `/hypo:feedback` scope 검증기가 cwd 유래 project id를 수용한다. 공유 `scope:` 검증기가 `deriveProjectId`가 내보내는 project-id 형태(leading dash + 대소문자 혼합, 예 `project:-Users-you-Workspace-Project`)를 거부해, cwd-스코프 feedback 페이지 작성이 lint를 통과 못 하고 수동 `--project-id=<slug>` override를 강요당했다. 단일 SoT `FEEDBACK_SCOPE_RE`(`scripts/lib/feedback-scope.mjs`, `lint.mjs`·`feedback.mjs` 양쪽 import)가 이제 그 형태를 수용하되 dot-only id(`project:.` / `project:..`)는 여전히 거부한다. deriver·on-disk project 디렉터리·string-equality projection은 변경 없음.

### Chores

#### English

- Maintainer tooling and repo hygiene (no user-facing surface change). `fix:verify` test-linkage CLI plus its `STUB_SPEC` vacuous-gate rejection and the fix-manifest evidence-only SoT + ADR-line grep gate (ADR 0036/0039); a pre-commit auto-format hook for staged files; publish-time bilingual CHANGELOG + annotated-tag enforcement (`check-bilingual.mjs`); a `feedback-sync` per-mode source-loader refactor (byte-identical golden tests); inline-comment hygiene cleanup; `actions/checkout` + `actions/setup-node` bumped to v5; and untracking of personal dev-workflow commands (`.claude/` is now fully gitignored: the repo ships only the published plugin surface). These touch dev/CI/maintainer workflows only; the installed product surface is unchanged.

#### 한국어

- 메인테이너 도구·repo 위생 (사용자 대상 표면 변경 없음). `fix:verify` test-linkage CLI와 그 `STUB_SPEC` vacuous-gate 거부, fix-manifest evidence-only SoT + ADR-line grep 게이트(ADR 0036/0039), staged 파일용 pre-commit auto-format 훅, publish 시점 bilingual CHANGELOG + annotated-tag 강제(`check-bilingual.mjs`), `feedback-sync`의 per-mode source-loader 리팩터(byte-identical golden 테스트), inline-comment 위생 정리, `actions/checkout`·`actions/setup-node` v5 bump, 개인 dev-workflow 커맨드 untrack(`.claude/`를 완전히 gitignore: repo는 published plugin 표면만 ship). 모두 dev/CI/maintainer 워크플로만 건드리며 설치되는 제품 표면은 동일하다.

### Changelog

- [#70](https://github.com/sk-lim19f/Hypomnema/pull/70) enforce bilingual CHANGELOG + annotated tag at publish-time
- [#71](https://github.com/sk-lim19f/Hypomnema/pull/71) auto-format staged files via a pre-commit hook
- [#72](https://github.com/sk-lim19f/Hypomnema/pull/72) add fix:verify CLI for test-linkage
- [#73](https://github.com/sk-lim19f/Hypomnema/pull/73) bump actions/checkout + actions/setup-node to v5
- [#74](https://github.com/sk-lim19f/Hypomnema/pull/74) strip rotting inline comment refs (cleanup Phase 2)
- [#75](https://github.com/sk-lim19f/Hypomnema/pull/75) normalize inline issue-refs in comments
- [#76](https://github.com/sk-lim19f/Hypomnema/pull/76) accept cwd-derived project-ids in the scope regex
- [#77](https://github.com/sk-lim19f/Hypomnema/pull/77) extract per-mode feedback-sync source loaders
- [#78](https://github.com/sk-lim19f/Hypomnema/pull/78) add lint --strict warning→error promotion with stable IDs
- [#79](https://github.com/sk-lim19f/Hypomnema/pull/79) reject a stub/vacuous spec with STUB_SPEC
- [#80](https://github.com/sk-lim19f/Hypomnema/pull/80) scope session-close lint to touched files + coherent marker gate
- [#81](https://github.com/sk-lim19f/Hypomnema/pull/81) stale-sibling install detection (downgrade guard + PATH-CLI notice + doctor scan)
- [#82](https://github.com/sk-lim19f/Hypomnema/pull/82) fix-manifest SoT + ADR-line grep + bare-anchor gate
- [#83](https://github.com/sk-lim19f/Hypomnema/pull/83) session-close advisory reflections (ADR 0029 Phase B)
- [#84](https://github.com/sk-lim19f/Hypomnema/pull/84) document claude-worker HOME-isolation limits
- [#85](https://github.com/sk-lim19f/Hypomnema/pull/85) untrack personal dev-workflow commands; fully gitignore .claude/
- [#86](https://github.com/sk-lim19f/Hypomnema/pull/86) prepare v1.3.0 (bump version + reconcile CHANGELOG)
- [#87](https://github.com/sk-lim19f/Hypomnema/pull/87) fetch the annotated tag object so the bilingual --tag gate works in CI

Contributors: @sk-lim19f

## [1.2.1] - 2026-05-26

### Bug Fixes

#### English

- `/hypo:resume` no longer leaks the literal `"slug"` as the active project on a fresh `init` vault. `scripts/resume.mjs` parsed `templates/hot.md`'s HTML-commented example row (`<!-- Row format: | ... | [[projects/slug/hot]] | -->`) as if it were a real entry, returning `slug` from the regex. Three-place defense-in-depth fix: (1) `scripts/resume.mjs` strips HTML comments before the wikilink regex AND skips the `projects/_template` scaffold in the mtime fallback (init.mjs writes `_template/session-state.md`, which would otherwise be chosen on a fresh vault); (2) `hooks/hypo-shared.mjs`'s mirrored `resolveActiveProject` applies the same comment strip; (3) `templates/hot.md` rewrites the example to no longer embed a real `[[...]]` shape. Pre-existing in v1.2.0 (confirmed via `git show v1.2.0:...`); surfaced by the v1.2.1 pre-ship QA matrix row 18 with guard D orchestrator-side live re-verification. Three new regression tests in `tests/runner.mjs` cover fresh-init graceful exit, real-project-vs-`_template`-mtime-newer override, and back-compat against vaults that still carry the pre-fix `[[projects/slug/hot]]` comment form. ([#68](https://github.com/sk-lim19f/Hypomnema/pull/68))

#### 한국어

- `/hypo:resume` placeholder leak fix ([#68](https://github.com/sk-lim19f/Hypomnema/pull/68)). 빈 vault(`init` 직후)에서 `/hypo:resume` 실행 시 `Error: no session-state.md found for project "slug"`가 나오던 버그를 수정. 근본 원인은 `templates/hot.md`의 HTML 주석 예시 `[[projects/slug/hot]]`가 wikilink-row regex에 잡혀서 literal `"slug"`를 활성 프로젝트로 반환하는 것이었습니다. v1.2.0에서도 잠복하던 결함으로(regression 아님) v1.2.1 pre-ship QA matrix row 18 가드 D 검증 단계에서 적발. 3중 방어 수정: (1) `scripts/resume.mjs`가 regex 전에 HTML 주석을 제거하고 mtime fallback에서 `projects/_template` 디렉터리를 스킵, (2) `hooks/hypo-shared.mjs`의 미러 파서에도 동일한 주석 strip 적용, (3) `templates/hot.md`의 예시 wikilink 형식을 `projects/<slug>/hot (wikilink)`로 변경해 정규식이 더 이상 매치되지 않게 함. 회귀 테스트 3건 추가 (fresh-init 정상 종료 + `_template` skip 효력 증명 + 옛 vault 백호환).

### Chores

#### English

- First dogfood cycle of `/qa-features` + `/qa-before-ship` complete. The two new dev-workflow skills introduced in PR [#67](https://github.com/sk-lim19f/Hypomnema/pull/67) between v1.2.0 and v1.2.1 had their first real run: a 5-worker cmux team (2 codex + 3 claude) verified a 34-row matrix, and guards A/B/C/D all fired in-band. Guard C (a worker caught a stale install) and guard D (orchestrator-side live re-verification downgraded two worker false-positives, `WORKER_EXPECTATION_MISMATCH`) both worked in practice. A cmux scrollback capture-timing issue on the claude workers (claude TUI alt-screen + `read-screen --scrollback` race) is a separate follow-up; guard D's orchestrator-side re-execution covers that gap. ([#67](https://github.com/sk-lim19f/Hypomnema/pull/67))

#### 한국어

- `/qa-features` + `/qa-before-ship` 첫 dogfood 사이클 완료. v1.2.0 → v1.2.1 사이 PR [#67](https://github.com/sk-lim19f/Hypomnema/pull/67)에서 도입된 두 신규 dev workflow 스킬이 첫 실가동. 5워커 cmux 팀(codex 2 + claude 3)으로 34행 매트릭스 검증, 가드 A/B/C/D 모두 in-band 발동. 워커가 stale-install 잡아낸 가드 C, orchestrator-side 라이브 재검증으로 워커 false-positive 2건(`WORKER_EXPECTATION_MISMATCH`)을 다운그레이드한 가드 D 모두 실제로 동작. claude 워커의 cmux scrollback 캡처 타이밍 이슈(claude TUI alt-screen + `read-screen --scrollback` race)는 별도 follow-up. 가드 D의 orchestrator-side re-execution이 그 갭을 메움. ([#67](https://github.com/sk-lim19f/Hypomnema/pull/67))

### Changelog

- [#67](https://github.com/sk-lim19f/Hypomnema/pull/67) introduce /qa-features + /qa-before-ship dev-workflow skills
- [#68](https://github.com/sk-lim19f/Hypomnema/pull/68) resume no longer leaks the literal "slug" on a fresh vault

Contributors: @sk-lim19f

## [1.2.0] - 2026-05-24

> [!IMPORTANT]
> **`SCHEMA.md` version 2.0: `feedback` page type now requires 9 hard fields (ADR 0031 / ADR 0034, PR [#60](https://github.com/sk-lim19f/Hypomnema/pull/60)).** Pages of `type: feedback` must declare `status`, `scope`, `tier`, `targets`, `sensitivity`, `priority`, `memory_summary`, `reason`, `source`. When `targets` includes `claude-learned`, the page must additionally be `scope: global` + `tier: L1` and declare `global_summary` + `promote_to_global: true`. `hypomnema upgrade --apply` now writes `MIGRATION-v2.0.md` into the wiki root with a manual-backfill checklist; the upgrade deliberately does NOT auto-stub the fields because wrong defaults for `scope` / `tier` / `targets` / `sensitivity` / `reason` / `source` would silently project wrong behavior. `SCHEMA.md` itself remains user-owned and byte-equal across upgrade (Option C, preserved by PR [#57](https://github.com/sk-lim19f/Hypomnema/pull/57)'s invariants). The migration report also carries the `project-id` ↔ slug regex caveat from PR [#59](https://github.com/sk-lim19f/Hypomnema/pull/59): to use `scope: project:*` in v1.2.0 you must `--project-id=<slug>` override.

> [!IMPORTANT]
> **SCHEMA 2.0: `feedback` page 9 hard 필드 + claude-learned conditional 2 필드 강제.** `hypomnema upgrade --apply` 시 `MIGRATION-v2.0.md`가 자동 작성되어 backfill checklist 제공. `SCHEMA.md`는 사용자 소유 (Option C 보존, byte-equal). 자동 stub은 거부. `scope` / `tier` / `targets` / `sensitivity` / `reason` / `source`는 의미 결정이라 wrong default가 wrong behavior로 이어짐.

### New Features

#### English

- `lint` emits `W8` design-history-stale warning. The PreCompact hook (`hypo-personal-check.mjs`) has filtered `lint --json` warns for `id === 'W8'` since the initial OSS hook drop, but `scripts/lint.mjs` never emitted that id: so `design-history.md` aging next to a fresher `session-log.md` (or `session-log/YYYY-MM.md` directory layout) was silently invisible to the gate. Lint now runs `findDesignHistoryStale()` once per project (outside the page loop), and emits a `W8`-tagged warn per stale project with a POSIX-separated `file` literal (`projects/<name>/design-history.md`) so the consumer's `file.split('/')` contract stays portable. The JSON `warn` shape gains an optional `id` field, omitted for legacy id-less warns.
- Update notifier. The SessionStart hook now shows an "Update available!" banner when a newer Hypomnema version has been published, detecting both distribution channels (npm package and Claude Code plugin) and printing the channel-appropriate update command (`npm install -g hypomnema`, or `/plugin marketplace update hypomnema` + `/reload-plugins`). The check never blocks session start: the hook reads a 24-hour cache only, and a detached worker refreshes it out-of-band, so a newer version surfaces from the next session. Per-channel notification state prevents the same banner from repeating, and `current >= latest` (local dev) is silently skipped. Opt out with `HYPO_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`, or `CI`.
- `feedback`-as-source-of-truth + one-way projections to MEMORY / `<learned_behaviors>` (ADR 0031, PR [#36](https://github.com/sk-lim19f/Hypomnema/pull/36)). A new `pages/feedback/<slug>.md` page type replaces ad-hoc human-side sync of behavior corrections across three storage surfaces. `hypomnema feedback-sync` derives `~/.claude/projects/<project-id>/memory/MEMORY.md` (200-line cap) and `~/.claude/CLAUDE.md` `<learned_behaviors>` (max 10 entries, strict gate: `scope:global` + `tier:L1` + `targets:claude-learned` + `promote_to_global:true` + `sensitivity ∈ {public, sanitized}`) from the wiki. Managed blocks are marker- and hash-fenced; hand-edits are flagged as `CONFLICT_MANUAL_EDIT`. PreCompact integration runs inside `hypo-personal-check` (single-blocking-gate invariant). `sensitivity: private` is forbidden: the wiki is git-pushed; private data must stay outside the wiki entirely. `/hypo:feedback` slash command writes pages directly; `hypomnema feedback-sync --bootstrap` scaffolds drafts from existing MEMORY/CLAUDE state under `pages/feedback/_drafts/` for human review.
- Extensions companion sync (ADR 0024, PRs [#42](https://github.com/sk-lim19f/Hypomnema/pull/42)~[#47](https://github.com/sk-lim19f/Hypomnema/pull/47)). A new `extensions/` taxonomy in the wiki (`agents/`, `commands/`, `hooks/`, `skills/`) lets users ship Claude Code / Codex companion files alongside their wiki. `hypomnema init` scaffolds the directory; `hypomnema upgrade` mirrors the inventory into `~/.claude/` and (with `--codex`) **only the `hooks` and `commands` subset** into `~/.codex/` (agents/skills are Claude-only and skipped on the Codex target by design, see `scripts/lib/extensions.mjs` `CODEX_TYPES`). Conflict detection (`--force-extensions` to overwrite), and `hypomnema doctor extensions` audits integrity (orphan duplicates, matcher drift, non-registrable orphans). `hypomnema uninstall` cleans up the companion files. PR [#49](https://github.com/sk-lim19f/Hypomnema/pull/49) added settings.json mixed-group surgical write so settings.json edits stay minimal and merge-friendly.
- `hypomnema upgrade --codex` mirrors core hooks (PR [#50](https://github.com/sk-lim19f/Hypomnema/pull/50)). `init --codex` has always installed Hypomnema's core hooks into `~/.codex/hooks/` and registered them in `~/.codex/settings.json`, but `upgrade` only mirrored user extensions: so a v1.1.x → v1.2.0 codex user's core hooks stayed stale until a fresh install. The flag now drives drift detection, hook-file apply, settings.json registration, and the `wiki-*.mjs → hypo-*.mjs` rename migration on both targets in one pass. The human-readable report labels the two blocks ("Hook files (codex)", "settings.json (codex)") and JSON output gains `hooksCodex` / `settingsCodex` / `oldHookRefsCodex` plus matching `applied.*Codex` keys. Without `--codex` nothing under `~/.codex/` is inspected (parity with the existing extensions behaviour).
- `hypomnema upgrade` v1→v2 migration report (ADR 0034, PR [#60](https://github.com/sk-lim19f/Hypomnema/pull/60)). Major SCHEMA bump now writes `MIGRATION-v2.0.md` into the wiki root with v1→v2-specific guidance: ADR 0031 / ADR 0034 references, all 9 unconditional `feedback` fields, the conditional `claude-learned` set, the explicit no-auto-stub policy, the "fix existing pages before `/hypo:feedback` append" warning, the PR [#59](https://github.com/sk-lim19f/Hypomnema/pull/59) `project-id` ↔ slug regex caveat, and a closing re-run-lint checklist. Other major jumps keep the original generic body. PR [#57](https://github.com/sk-lim19f/Hypomnema/pull/57) invariants preserved: `SCHEMA.md` is byte-equal after `--apply` (Option C), report tag stays `[schema]` (the only token historically valid across all shipped Meta vocabularies).
- PostToolUse WebFetch / WebSearch auto-ingest signal (PR [#48](https://github.com/sk-lim19f/Hypomnema/pull/48)). When Claude resolves a URL via WebFetch or runs WebSearch, the PostToolUse hook injects a nudge in `hookSpecificOutput.additionalContext` so Claude considers running `/hypo:ingest`. URL query/hash tokens and userinfo (`user:pass@host`) are stripped before injection. Non-HTTP schemes (`file://`, `ftp://`, `data:`) and missing URLs are silent skips. Opt out with `HYPO_SKIP_GATE=1`. Fail-open on invalid JSON stdin; stderr carries the unified `[hypo-web-fetch-ingest] error:` tag.
- Stop-chain auto-minimal-crystallize (ADR 0022 Layer 3, PR [#34](https://github.com/sk-lim19f/Hypomnema/pull/34)). A session that crossed a "non-trivial" threshold now offers (and on `Y` runs) `/hypo:crystallize --apply-session-close --minimal` automatically from the Stop hook chain. Combined with PR [#31](https://github.com/sk-lim19f/Hypomnema/pull/31)~[#33](https://github.com/sk-lim19f/Hypomnema/pull/33) `/clear` detection and SessionEnd marker / SessionStart `source=clear` recovery, the personal-check gate now catches forgotten session closes and reopens cleanly when the user runs `/clear`.
- `crystallize --apply-session-close` programmatic entrypoint (PRs [#21](https://github.com/sk-lim19f/Hypomnema/pull/21), [#23](https://github.com/sk-lim19f/Hypomnema/pull/23)~[#26](https://github.com/sk-lim19f/Hypomnema/pull/26)). Strict 11-step session-close validation (PreCompact hard gate + crystallize). `--payload <json>` and `--apply-session-close` make the path machine-callable from the Stop hook chain; `--probe` early-exit (option D) keeps no-op closes fast. Lint preflight + post-apply gate ensures the wiki ends up clean.
- Auto-project creation on cwd match (ADR 0023, PR [#41](https://github.com/sk-lim19f/Hypomnema/pull/41)). When you start a session (or change directory) inside a git repository that carries a project marker (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`) but matches no existing wiki project's `working_dir`, the SessionStart/CwdChanged hook now offers to create one. The offer is a nudge only; on "Y" Claude runs the new internal scaffold helper (`scripts/lib/project-create.mjs`) which materializes the project from `templates/projects/_template/` with token substitution, adds the root `hot.md` pointer row, and logs the creation. On "N" the cwd is recorded under `skips[]` in `.cache/project-suggestions.json` and never offered again (a 5-minute per-cwd cooldown also suppresses repeats within a session). Temp and marker-less directories never trigger the offer. `hypomnema doctor` validates the skip-persistence file's schema. The deprecated `hypomnema project new` subcommand is not introduced (ADR 0023). PR [#41](https://github.com/sk-lim19f/Hypomnema/pull/41) also strengthens the templated Session Start guidance: the first response must lead with a resume summary.
- First-prompt resume summary + cwd-change re-trigger (PR [#39](https://github.com/sk-lim19f/Hypomnema/pull/39)). SessionStart's resume nudge now forces the resume summary on the first response, and a cwd change inside the session re-triggers the project match check (so opening a new repo without restarting Claude still picks up the right project).
- `weekly-report` migrates output to `journal/weekly/<YYYY-Www>.md` (PR [#29](https://github.com/sk-lim19f/Hypomnema/pull/29)). Single source of truth per spec §6.4. Old report locations are no longer written.
- Lint type-conditional fields + tag vocabulary lock (PRs [#28](https://github.com/sk-lim19f/Hypomnema/pull/28), [#38](https://github.com/sk-lim19f/Hypomnema/pull/38)). Lint now enforces per-type required fields and rejects unknown tags (vocabulary outside SCHEMA `Tag Vocabulary`). PR [#38](https://github.com/sk-lim19f/Hypomnema/pull/38) adds `B6` warn for `pages/` subdirs absent from SCHEMA taxonomy.
- `.hypoignore` privacy guards (PRs [#19](https://github.com/sk-lim19f/Hypomnema/pull/19), [#20](https://github.com/sk-lim19f/Hypomnema/pull/20), [#27](https://github.com/sk-lim19f/Hypomnema/pull/27)). `/hypo:ingest` honors `.hypoignore`; `.hypoignore` is kept in sync with `.gitignore`; a pre-commit hook prevents private-marked content from leaking. `.hypoignore` is now enforced on **all** wiki content-injection hooks ([#27](https://github.com/sk-lim19f/Hypomnema/pull/27)).
- Self-natural-close pattern detection (PR `91e1c91`). Behavioral rule layer-1: the personal-check gate now recognizes natural-language close phrases ("이만 마무리", "오늘 여기까지", etc.) and offers the session-close flow.

#### 한국어

- `feedback`-as-SoT + 단방향 projection (ADR 0031): `pages/feedback/<slug>.md`가 행동 교정의 단일 source-of-truth. `hypomnema feedback-sync`로 MEMORY.md (cwd-scoped, 200줄 cap) + CLAUDE.md `<learned_behaviors>` (max 10, 엄격 게이트) 자동 동기.
- Extensions companion sync (ADR 0024): wiki에 `extensions/{agents,commands,hooks,skills}` 동봉. init/upgrade가 `~/.claude/` (+`--codex`로 `~/.codex/`) 미러링, conflict 감지, doctor 무결성 검사.
- Auto-project creation on cwd match (ADR 0023): git project marker 있는 cwd에 wiki project 없으면 SessionStart에서 생성 권유.
- Stop-chain auto-minimal-crystallize + `/clear` 감지 + SessionEnd marker 복구 (ADR 0022): session 종료 누락 시 자동 minimal crystallize 권유, `/clear` 후 재시작 시 깔끔 복구.
- Update notifier: SessionStart에서 신규 버전 알림 (npm 패키지 / Claude Code plugin 두 채널), opt out: `HYPO_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` / `CI`.
- PostToolUse WebFetch / WebSearch auto-ingest 신호: URL fetch 시 `/hypo:ingest` 권유 nudge 자동 주입 (privacy redaction 포함).

### Bug Fixes

#### English

- `doctor` orphan duplicate scan + matcher drift surfacing (PRs [#53](https://github.com/sk-lim19f/Hypomnema/pull/53)~[#56](https://github.com/sk-lim19f/Hypomnema/pull/56), PR [#54](https://github.com/sk-lim19f/Hypomnema/pull/54) follow-ups). `doctor extensions` now surfaces non-registrable orphans, gated `matcher:""` specific message on `hookExact`, and reports orphan duplicate counts. `parseManifest` handles empty matcher; the canonical-pick mirror keeps the doctor view aligned with the actual registered hook.
- `extensions` settings.json mixed-group surgical write (PR [#49](https://github.com/sk-lim19f/Hypomnema/pull/49), ADR 0024 amendment). Edits to `settings.json` for extensions registration are now surgical inside mixed groups, leaving siblings + matcher in the source group exactly as found.
- `crystallize --apply-session-close` lint preflight + post-apply gate (PR [#25](https://github.com/sk-lim19f/Hypomnema/pull/25)). Lint runs before AND after the apply to fail loudly on dirty input or post-write drift.
- PreCompact `/clear` detection + SessionEnd marker recovery (PRs [#31](https://github.com/sk-lim19f/Hypomnema/pull/31)~[#33](https://github.com/sk-lim19f/Hypomnema/pull/33) + amendments, ADR 0022). `compact-guard` detects `/clear` so it does not block; `personal-check` capacity bypass removed ([#32](https://github.com/sk-lim19f/Hypomnema/pull/32)); SessionEnd marker + SessionStart `source=clear` recovery makes /clear-then-restart cleanup work end-to-end.
- Test hermeticity: child HOME isolation in `tests/runner.mjs` (PR [#30](https://github.com/sk-lim19f/Hypomnema/pull/30)). Tests no longer rely on the dev's real `$HOME`; child processes get an isolated home so external writes can't pollute or break the suite.
- `withWiki()` fixture date local-time alignment (PR [#52](https://github.com/sk-lim19f/Hypomnema/pull/52)). UTC vs local boundary flake removed.

#### 한국어

- doctor orphan 중복 스캔 + matcher drift 표면화 ([#53](https://github.com/sk-lim19f/Hypomnema/pull/53)~[#56](https://github.com/sk-lim19f/Hypomnema/pull/56))
- extensions settings.json mixed-group 외과적 write ([#49](https://github.com/sk-lim19f/Hypomnema/pull/49))
- crystallize lint preflight + post-apply 게이트 ([#25](https://github.com/sk-lim19f/Hypomnema/pull/25))
- test hermeticity HOME 격리 ([#30](https://github.com/sk-lim19f/Hypomnema/pull/30)), withWiki fixture 날짜 flake 제거 ([#52](https://github.com/sk-lim19f/Hypomnema/pull/52))

### Chores

#### English

- `feedback-sync` MEMORY projection is now strictly cwd-scoped (ADR 0031 §4 amendment, PR [#59](https://github.com/sk-lim19f/Hypomnema/pull/59)). `memoryTarget.filter` previously accepted any `scope: project:*` page regardless of the resolved project-id, so a `scope: project:other` page was silently projected into `~/.claude/projects/<this-project>/memory/`. The filter is now `scope === 'global' || scope === \`project:${projectId}\`` (exact match). `templates/SCHEMA.md` §3.1 and `commands/feedback.md` `--scope` flag clarify that `<project-id>` must exact-match the resolved project-id (default: `cwd → '/'.'.' → '-'`; or `--project-id=<id>` override). Mismatch = silent MEMORY skip (not a lint error). The lint regex `^project:[a-z0-9][a-z0-9-]*$` and the default cwd-derived id are incompatible: to use a `project:*` scope you must `--project-id=<slug>` override. Full resolved-id ↔ wiki-slug reconciliation is deferred to v1.3.0.
- `hypomnema upgrade` migration report tag historical regression fix (PR [#57](https://github.com/sk-lim19f/Hypomnema/pull/57)). `writeMigrationReport()` previously emitted `tags: [hypomnema, migration, schema]`, but the v1.0 / v1.1 historical Meta vocab is `wiki, index, operations, guide, schema`: neither `hypomnema` nor `migration` are present. Because Option C deliberately does NOT touch the user's `SCHEMA.md`, a v1.0 / v1.1 user upgrading would have a lint-failing page created at the wiki root. Tag tightened to `[schema]` (the only token historically valid). Added two regression tests: `--apply leaves user SCHEMA.md byte-equal` (Option C contract) and `--apply migration report tags are all in installed SCHEMA vocab` (vocab-level assertion, with the installed Meta vocab back-dated to the oldest shipped set). Also clarified `upgrade.mjs` dry-run wording and removed the self-referential "Run /hypo:upgrade --apply" action item from the report body.
- Unified `[hypo-<name>] error:` stderr log tag across all lifecycle hooks (PR [#40](https://github.com/sk-lim19f/Hypomnema/pull/40)). Every hook (`hypo-cwd-change`, `hypo-first-prompt`, `hypo-compact-guard`, `hypo-file-watch`, `hypo-lookup`, `hypo-personal-check`, `hypo-auto-minimal-crystallize`, `hypo-auto-stage`, `hypo-web-fetch-ingest`) emits its forced-catch path with the same `[hypo-<name>] error: ...` prefix so dogfood log triage is grep-friendly.
- Prettier setup + format pass (chore commits `dbc228f`, `4dac33c`, `4696abf`). Repository-wide Prettier config + `npm run format` / `format:check` scripts. `.git-blame-ignore-revs` for the reformat commit so `git blame` stays clean.
- Code comment cleanup Phase 1 (PR [#58](https://github.com/sk-lim19f/Hypomnema/pull/58)). 13 files, comment-only diff (0 non-comment line changes verified by gate). Removed rot-prone references (`(fix #NN)`, `(PR #NN follow-up)`, `(codex BLOCKER/CONCERN/...)`, `v120-*`, `stage-N-#M`, `(#NN scope)`) while preserving ADR / contract / spec / plan / Layer / § anchors. PR descriptions are now the canonical location for fix/PR/issue cross-references; in-code comments stay about the WHY.

#### 한국어

- `feedback-sync` MEMORY cross-project pollution fix (PR [#59](https://github.com/sk-lim19f/Hypomnema/pull/59) / ADR 0031 §4 amendment): `scope: project:*` exact-match 강제.
- `hypomnema upgrade` migration report tag historical regression fix (PR [#57](https://github.com/sk-lim19f/Hypomnema/pull/57)): tag `[schema]`로 좁힘. v1.0/v1.1 historical vocab에 있는 유일 안전 토큰.
- Code comment rot cleanup Phase 1. 13 files comment-only diff. `fix #NN` / `PR #NN follow-up` 등 시간에 따라 stale 되는 참조 제거, ADR / contract / spec anchor 보존.

### Changelog

- [#19](https://github.com/sk-lim19f/Hypomnema/pull/19) .hypoignore privacy guards
- [#20](https://github.com/sk-lim19f/Hypomnema/pull/20) keep .hypoignore in sync with .gitignore
- [#21](https://github.com/sk-lim19f/Hypomnema/pull/21) crystallize --apply-session-close programmatic entrypoint
- [#23](https://github.com/sk-lim19f/Hypomnema/pull/23) crystallize --apply-session-close validation steps
- [#25](https://github.com/sk-lim19f/Hypomnema/pull/25) crystallize lint preflight + post-apply gate
- [#26](https://github.com/sk-lim19f/Hypomnema/pull/26) crystallize --apply-session-close validation steps
- [#27](https://github.com/sk-lim19f/Hypomnema/pull/27) enforce .hypoignore on all content-injection hooks
- [#28](https://github.com/sk-lim19f/Hypomnema/pull/28) lint type-conditional required fields
- [#29](https://github.com/sk-lim19f/Hypomnema/pull/29) weekly-report output migration to journal/weekly
- [#30](https://github.com/sk-lim19f/Hypomnema/pull/30) test child HOME isolation
- [#31](https://github.com/sk-lim19f/Hypomnema/pull/31) PreCompact /clear detection + SessionEnd marker recovery
- [#32](https://github.com/sk-lim19f/Hypomnema/pull/32) remove personal-check capacity bypass
- [#33](https://github.com/sk-lim19f/Hypomnema/pull/33) /clear detection + SessionStart source=clear recovery
- [#34](https://github.com/sk-lim19f/Hypomnema/pull/34) Stop-chain auto-minimal-crystallize
- [#36](https://github.com/sk-lim19f/Hypomnema/pull/36) feedback-as-source-of-truth + one-way projections
- [#38](https://github.com/sk-lim19f/Hypomnema/pull/38) lint B6 warn for non-SCHEMA pages/ subdirs
- [#39](https://github.com/sk-lim19f/Hypomnema/pull/39) first-prompt resume summary + cwd-change re-trigger
- [#40](https://github.com/sk-lim19f/Hypomnema/pull/40) unified [hypo-*] error stderr tag
- [#41](https://github.com/sk-lim19f/Hypomnema/pull/41) auto-project creation on cwd match
- [#42](https://github.com/sk-lim19f/Hypomnema/pull/42) extensions companion sync
- [#47](https://github.com/sk-lim19f/Hypomnema/pull/47) extensions companion sync
- [#48](https://github.com/sk-lim19f/Hypomnema/pull/48) PostToolUse WebFetch/WebSearch auto-ingest
- [#49](https://github.com/sk-lim19f/Hypomnema/pull/49) extensions settings.json mixed-group surgical write
- [#50](https://github.com/sk-lim19f/Hypomnema/pull/50) upgrade --codex mirrors core hooks
- [#52](https://github.com/sk-lim19f/Hypomnema/pull/52) withWiki fixture date local-time alignment
- [#53](https://github.com/sk-lim19f/Hypomnema/pull/53) doctor orphan duplicate scan + matcher drift
- [#54](https://github.com/sk-lim19f/Hypomnema/pull/54) doctor extensions follow-ups
- [#56](https://github.com/sk-lim19f/Hypomnema/pull/56) doctor orphan duplicate scan
- [#57](https://github.com/sk-lim19f/Hypomnema/pull/57) upgrade migration report tag historical regression fix
- [#58](https://github.com/sk-lim19f/Hypomnema/pull/58) code comment cleanup Phase 1
- [#59](https://github.com/sk-lim19f/Hypomnema/pull/59) feedback-sync MEMORY strictly cwd-scoped
- [#60](https://github.com/sk-lim19f/Hypomnema/pull/60) SCHEMA 2.0 + v1→v2 migration report

Contributors: @sk-lim19f

## [1.1.0] - 2026-05-13

Minor release. The headline is **observability**: the v1 → v2 thesis is
that Claude eventually reads, writes, and synthesizes the wiki without
being asked, but v1.0.1 was still trigger-driven. v1.1.0 doesn't claim
the autonomy gap is closed; instead it ships the **measurement** that
makes the auto-vs-manual ratio visible per session and per week, plus
the privacy gate that lets that measurement run without leaking
transcript content into the wiki.

Alongside that, this release cleans up a v1.0.x install-flow surprise:
`hypomnema upgrade --apply` is no longer a no-op (see Bug Fixes).

### Upgrading from 1.0.1

```bash
npm install -g hypomnema@1.1.0       # or: npm update -g hypomnema
hypomnema upgrade --apply            # now actually runs upgrade.mjs
```

Plugin users: re-run `/plugin install hypomnema@hypomnema` (or restart
Claude Code) so the new slash commands and hooks get registered.

### New Features

- Observability pipeline. `/hypo:audit` (`scripts/session-audit.mjs`) classifies every Claude session against the lookup → ingest → query → session-close pipeline and prints a per-session report. `scripts/weekly-report.mjs` aggregates the same signal into a weekly observability page. `SKILL.md` files now carry citation footers that the audit uses to verify wiki uptake. Nightly CI (`nightly.yml`) keeps the pipeline honest.
- Session growth metrics. Hooks surface per-session growth at session boundaries (pages touched, wikilinks added, session-close rate), scoped to `pages/` + `projects/` so unrelated repo activity doesn't pollute the score.
- Privacy gate via `.hypoignore`. The auto-commit and auto-stage hooks now honor `.hypoignore`; transcript classification cannot leak transcript text, URLs, tool input, or secret commands into the weekly report. Locked by a contract test in `tests/runner.mjs`.
- `hypomnema <upgrade|doctor|uninstall>` subcommands. Previously the bin entry silently dropped the positional verb and ran `init`; the documented forms had been advertised but never wired up. `hypomnema --help` now lists each command.
- Community templates. `.github/ISSUE_TEMPLATE/{bug_report.md,feature_request.md,config.yml}`, `.github/PULL_REQUEST_TEMPLATE.md`, and root `SECURITY.md`, the last with a scoped threat model (wiki vault + `~/.claude/` namespace) and a private-reporting channel.

### Bug Fixes

- `hypomnema upgrade --apply` actually upgrades. The bin pointed at `scripts/init.mjs`, which silently ignored the positional verb and ran the init flow instead. Users got an init-shaped output and assumed the documented upgrade had run. It hadn't. Same story for `hypomnema doctor` and `hypomnema uninstall`. All four are now dispatched correctly from a tiny subcommand router at the top of `init.mjs`; bare `hypomnema` still equals `hypomnema init` for the documented Path-B onboarding command.
- Audit correctness. Counts nested `tool_use` entries (matches real transcript shape), scopes session growth to `pages/` + `projects/` (ignores root `README.md` / `hot.md`), validates `--week=<ISO>` with a clear error on malformed input, and defaults the fallback session scan to the wiki's encoded cwd. Opt-in to a full scan via `--fallback-all-projects`.
- Package-integrity errors point at a next step. Low-level errors thrown when `hooks/hooks.json` is missing or malformed (`Error: hooks/hooks.json must be a JSON object`, etc.) previously exited with no remediation. They now follow up with: *→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).*
- `.hypoignore` migration. `hypomnema upgrade` appends `.cache/` to existing `.hypoignore` idempotently, with no duplication if you run `upgrade --apply` twice.

### Chores

- README honesty pass. v1.0.1's trigger model is documented explicitly (most behavior fires on `/hypo:*` commands, not autonomously). v1.1 is framed as the *first step* on the v2 autonomous ramp: ship the observability score so the gap is visible to the user before the autonomy work lands. No "fully autonomous" claims in v1.1.
- README badges and Status section drop the hard-coded "51/51 tests" figure. The static shields.io badge is replaced with a live GitHub Actions CI status badge; the body line points readers at `npm test`. ARCHITECTURE.md and CONTRIBUTING.md follow the same pattern, so the count no longer rots every time a lane ships.
- ARCHITECTURE.md syncs the `Stop` hook order with `hypo-session-record` and updates the auto-stage / auto-commit rows to reflect `.hypoignore` filtering.

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

### New Features

- Claude Code plugin marketplace manifest (`.claude-plugin/marketplace.json`).
- `init.mjs` now copies slash command files into `~/.claude/commands/hypo/` with per-file SHA tracking recorded in `~/.claude/hypo-pkg.json`. Future upgrades distinguish package content from user edits.
- `--no-commands` / `--force-commands` flags on `init.mjs` and `upgrade.mjs`; `--force-commands` on `uninstall.mjs`.
- `upgrade.mjs` reconciles orphaned recorded commands: drops the entry, deletes the file on disk only when its SHA still matches the recorded value, otherwise keeps the user-modified file.
- `scripts/lib/pkg-json.mjs`: atomic temp-file + rename writes for `hypo-pkg.json`; corrupt files are preserved as `.corrupt-<ts>.json`.

### Bug Fixes

- `lint.mjs` was emitting 11 false-positive warnings on a freshly initialised wiki: placeholder wikilinks inside HTML comments, fenced code blocks, and inline code spans were all treated as broken links. `extractWikilinks` now preprocesses content through `stripNonWikilinkRegions` (line-anchored ``` / ~~~ fences, double/single backtick spans, HTML comments) before the regex runs. Real broken wikilinks still get caught.
- `templates/projects/_template/index.md` wraps the `<project-name>` placeholders in an HTML comment so they document the expected format without triggering lint.
- `scripts/ingest.mjs` docstring and first banner line now make explicit that the CLI helper is read-only: it lists pending sources; synthesis is performed by `/hypo:ingest` inside Claude.
- `uninstall.mjs` previously deleted every tracked `*.md` file regardless of whether the user had modified it. It now gates each removal on a SHA match against the recorded value, preserves user-modified files (and the metadata that tracks them) unless `--force-commands` is passed, and refuses to follow symlinks.
- Race-condition hardening across `init`/`upgrade`/`uninstall`: file writes use temp-file + rename; SHA checks are re-verified immediately before overwriting so an edit that lands between check and apply is preserved; destinations that are symlinks or non-regular files are refused before read or write.

### Chores

- README quickstart rewritten in both languages to document the two supported install paths (plugin and npm CLI), how slash commands get registered under each, and how upgrades reconcile against user edits.
- Wiki-path resolver table corrected to match `scripts/lib/hypo-root.mjs`: `HYPO_DIR` → fixed home-relative candidates → `~/hypomnema`.
- `/hypo:ingest` row clarified: CLI helper lists, Claude synthesises.

[1.0.1]: https://github.com/sk-lim19f/Hypomnema/releases/tag/v1.0.1

## [1.0.0] - 2026-05-10

First public release.

### New Features

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

### Changelog

- [#4](https://github.com/sk-lim19f/Hypomnema/pull/4) add CI workflows

Contributors: @sk-lim19f

[1.0.0]: https://github.com/sk-lim19f/Hypomnema/releases/tag/v1.0.0
