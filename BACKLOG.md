---
title: Hypomnema — 기획/구현 갭 분석 & 작업 백로그
type: backlog
status: active
created: 2026-05-08
updated: 2026-05-08
reviewers: worker-1 (Codex), worker-2 (Codex), Claude cross-verify
---

# Hypomnema 기획/구현 갭 분석 & 작업 백로그

> **기준 문서**: `~/wiki/projects/llm-wiki-oss/oss-plan.md`, `prd.md`, `index.md`  
> **분석 대상**: `/Users/blair/Workspace/wiki` (OSS 레포)  
> **검증**: Claude 초안 → Codex worker-1 (섹션 A·B) + worker-2 (섹션 C·D, 파일 직접 확인) → Claude 교차 검증  
> **`npm test` 결과**: 51/51 PASS | `claude plugin validate .`: **10개 스키마 오류** (P0 블로커)

---

## 1. 일치 항목 (건드리지 않음)

| 항목 | 확인 근거 |
|---|---|
| 7개 lifecycle 훅 (SessionStart, UserPromptSubmit×3, PreCompact, PostToolUse, Stop×2, CwdChanged, FileChanged) | `hooks/hooks.json` + 훅 파일 10개 |
| Hot cache 패턴 — `hot.md` + `session-state.md` 세션 시작 주입 | `wiki-session-start.mjs` |
| Stop 훅 자동 commit → pull → push | `wiki-auto-commit.mjs` |
| `/hypo:init` wizard (wiki-dir, privacy, hooks, git-remote) | `commands/init.md` + `scripts/init.mjs` |
| commands 13개 (doctor, upgrade, uninstall, ingest, query, crystallize, feedback, resume, stats, graph, verify, repair, help) | `commands/*.md` + `scripts/*.mjs` 확인 |
| CI jobs: test(Node 18/20/22), lint-runner, init-snapshot, upgrade-snapshot, privacy(3모드), replay, omc-absent | `ci.yml` |
| nightly.yml: verify-pages, llm-lint 트리거 | `nightly.yml` |
| Privacy 3모드 (personal/shared/public) + `.wikiignore` | `init.mjs` |
| 문서 4종 (ARCHITECTURE, CONTRIBUTING, PRIVACY, README×2) | `docs/`, `README.md`, `README.ko.md` |
| skills 6종 (crystallize, graph, ingest, lint, query, verify) | `skills/` |
| BM25 위키 검색 훅 | `wiki-lookup.mjs` |
| templates 구조 | `templates/` |
| package.json npm 배포 준비 | `package.json` |
| `HYPO_SKIP_GATE` 환경변수 | `wiki-shared.mjs` |
| release.yml | `.github/workflows/release.yml` |
| `npm test` 51/51 PASS | `tests/runner.mjs` |

---

## 2. 갭 분석 — 불일치/미구현 전체 목록

### [A] 기능 갭

#### A-1. 세션 종료 커맨드 부재 🔴

**기획**: `index.md` 9-6에서 `/hypo:crystallize` = "session close 체크리스트 alias"로 명시  
**실제**: `commands/crystallize.md`는 "초안·분산 페이지를 stable 지식으로 합성"하는 전혀 다른 도구. `skills/crystallize.md`에 "session end" 트리거 시 체크리스트 언급이 있으나 slash command가 구현하지 않음  
**Worker-1 보정**: 기획 문서는 `/hypo:crystallize` 또는 `/hypo:close`를 session-close alias로 명시. 새 이름 결정 전 **설계 Q-F 먼저 결정** 필요

**필요 작업**:
- 설계 Q-F 결정 (아래 §5 참고): 커맨드 이름 및 책임 범위 확정
- 결정 후 해당 `commands/<name>.md` + `skills/<name>.md` 구현  
  체크리스트: session-state.md 업데이트, hot.md 갱신, ingest 대상 권유, commit/push 상태 확인

---

#### A-2. Ingest 워크플로 자동화 없음 🔴

**기획**: `사용자 요청 → 위키 검색 → miss면 LLM 리서치 → ingest → 결과/의사결정 이유 정리 / hit면 최신성 확인 → 레거시면 append/update`  
**실제** (worker-2 파일 직접 확인):
- `wiki-lookup.mjs` miss: `[WIKI LOOKUP: miss] ... Closest: [[slug]]` 신호만 출력 종료
- `wiki-lookup.mjs` hit: 페이지 주입만, 최신성 확인 없음
- `commands/ingest.md`: `updated:` 날짜 업데이트는 있으나 `verify_by_date`/레거시 보존 절차 없음

**필요 작업**:
- `wiki-lookup.mjs` miss 분기: `[WIKI LOOKUP: miss] 관련 페이지 없음. 리서치 후 /hypo:ingest 로 저장을 권장합니다.` 형태로 리서치 권유 추가  
- `commands/ingest.md` Step 4: 기존 페이지 있을 때 `verify_by_date` 비교 → 레거시면 기존 내용 보존 + append 절차 명시
- (선택) `wiki-lookup.mjs` hit 분기: `verify_by_date` 만료 여부 경고 표시

---

#### A-3. `lint-llm.mjs` 스텁 미구현 🟡

**기획**: L2 의미론적 LLM 검사 — 페이지별 Haiku 판정, nightly CI 실행  
**실제** (worker-2 확인): `scripts/lint-llm.mjs`에 `TODO: implement per-page LLM evaluation pass` + `"LLM evaluation pass not yet implemented"` 메시지만 있음

**필요 작업**:
- `scripts/lint-llm.mjs`: Anthropic SDK로 페이지별 Haiku 호출 구현  
- `scripts/lint-llm.md` 프롬프트 파일은 이미 존재 — 이를 기반으로 구현  
- `--json` 출력 포맷 확정

---

#### A-4. SessionStart에 `git pull` 없음 🟡

**기획**: "매일 00시 또는 최초 실행 시 자동 pull"  
**실제** (worker-2 확인): `wiki-session-start.mjs`는 hot.md/session-state.md 주입만. `git pull`은 Stop 훅(wiki-auto-commit)에서만  
**Worker-1 우선순위 조정**: oss-plan 우선순위 표에서 auto-pull은 P2 — P1에서 **P2로 조정**

**필요 작업**:
- `wiki-session-start.mjs`에 세션 시작 시 `git pull --no-rebase -q` 추가  
  (remote 있을 때만, 실패 시 silent fail, 결과를 additionalContext에 표시)

---

#### A-5. `init` 완료 시 first commit + push 없음 🟡

**기획** (oss-plan.md 시나리오 A): `✓ Git initialized, remote added, first commit pushed`  
**실제** (worker-2 확인): `scripts/init.mjs`의 `gitSetup()`은 `git init` + `git remote add`만. first commit/push 없음  

**필요 작업**:
- git remote가 있을 때 `git add -A` → `git commit -m "init: hypomnema wiki"` → `git push -u origin main` 추가
- `commands/init.md` Step 3 Report에 결과 반영

---

#### A-6. `commands/lint.md` 없음 🟡 → **P1로 승격**

**기획**: `docs/ARCHITECTURE.md` Commands 목록에 `lint` 명시. README에서 `/hypo:lint` 광고  
**실제** (worker-2 확인): `commands/lint.md` 없음. `skills/lint.md` + `scripts/lint.mjs`는 존재  
**Worker-2 우선순위 조정**: README가 `/hypo:lint`를 사용자 공개 기능으로 광고 → P2에서 **P1로 승격**

**필요 작업**:
- `commands/lint.md` 신설 — `scripts/lint.mjs` 호출 절차 기술

---

#### A-7. `/hypo:verify`가 static — Claude API 연동 없음 🟡 *(신규)*

**기획** (oss-plan.md): `verify-pages.mjs` → Claude Haiku `YES/NO` 판정 + `open-questions.md` append  
**실제** (worker-2 직접 확인): `scripts/verify.mjs`는 정적 메타데이터/날짜 검사만. Anthropic API 호출 없음

**필요 작업**:
- `scripts/verify.mjs`: Claude API(Haiku) 호출로 `verify_by` 질문에 YES/NO 판정 구현
- 판정 결과를 `pages/open-questions.md`에 append하는 로직 추가
- 설계 Q-G 먼저 결정 (아래 §5 참고)

---

#### A-8. `init.mjs`에서 생성하는 baseline 파일/디렉토리 불완전 🟡 *(신규)*

**기획** (oss-plan.md + index.md 9-9): `templates/`의 파일들이 `init` 시 복사되어야 함  
**실제** (worker-2 확인): `init.mjs`는 `pages/`, `projects/`, `sources/` 디렉토리 3개 + 5개 루트 파일만 생성. 다음이 누락됨:
- `journal/daily/`, `journal/weekly/`, `journal/monthly/` 디렉토리
- `templates/Home.md`, `Overview.md`, `wiki-automation.md`, `hypo-help.md` 복사 미구현
- `templates/pages/_index.md`, `templates/projects/_template/` 구조 복사 미구현

**필요 작업**:
- `init.mjs`에 누락된 디렉토리/파일 생성 로직 추가
- 설계 Q-H에서 "init이 생성해야 할 것"의 범위를 확정 후 구현

---

### [B] OMC 잔존 참조 (OSS 오염)

Phase 2 DoD 조건: **`grep 'OMC|oh-my-claude' 0건`** — 현재 미달성

#### B-1. `OMC_SKIP_WIKI_GATE` rename 미완료 🔴

| 파일 | 위치 | 내용 |
|---|---|---|
| `hooks/wiki-shared.mjs` | line 67 | `process.env.OMC_SKIP_WIKI_GATE === '1'` |
| `hooks/personal-wiki-check.mjs` | line 11 (주석) | `OMC_SKIP_WIKI_GATE=1 for backwards compat` |
| `tests/runner.mjs` | lines 307, 309, 313 | `OMC_SKIP_WIKI_GATE` 환경변수 조작 |

**Worker-2 추가 (B-4 참고)**: `ci.yml` omc-absent job에도 `OMC_SKIP_WIKI_GATE: ""` 환경변수 잔존

**필요 작업**:
- `wiki-shared.mjs`: backwards compat 코드 및 `OMC_SKIP_WIKI_GATE` 참조 완전 제거
- `personal-wiki-check.mjs`: 주석 수정
- `tests/runner.mjs`: `OMC_SKIP_WIKI_GATE` → `HYPO_SKIP_GATE`로 교체
- `ci.yml` omc-absent job: `OMC_SKIP_WIKI_GATE: ""` 항목 제거
- **OMC 스크럽 정책 확정**: CI job 이름(`omc-absent`), `.omc/` gitignore 항목 처리 방침 포함 (설계 Q-I)

---

#### B-2. `docs/ARCHITECTURE.md` OMC 문구 🟡

```
line 23: skills/ ← OMC skill wrappers for /hypo:* commands
```

**필요 작업**: `OMC skill wrappers` → `Agent skill definitions`로 수정

---

#### B-3. `docs/CONTRIBUTING.md` omc-teams 언급 🟡

```
line 97: get a second review (e.g. via omc-teams:2 codex) before merging
```

**필요 작업**: OMC 특정 참조 제거 → 일반적인 리뷰 방법으로 교체

---

### [C] README / 문서 불일치

#### C-1. README "로컬 저장" 문구가 "Git-synced" 차별점과 충돌 🔴

**`README.ko.md` Privacy 섹션**: `"모든 위키 데이터는 로컬에 저장됩니다"` + `"외부 서비스로 콘텐츠를 전송하지 않습니다"`  
**실제**: `wiki-auto-commit.mjs`(Stop 훅)가 자동 commit + pull + push. README는 "no sync service"라고 명시  
**Worker-2 확인**: `README.md`/`README.ko.md` 모두 동일한 충돌 문구 존재

**필요 작업**:
- Privacy 섹션: "로컬 저장" → "로컬 파일 + 선택적 Git remote 동기화"로 변경
- "no sync service" 문구 제거 또는 "no third-party sync service"로 한정
- Git remote 설정 시 auto-push 동작 명시
- 설계 Q-K 결정 후 README/PRIVACY 일관 수정

---

#### C-2. README에 Git sync 초기 설정 절차 없음 🟡

**필요 작업**: "빠른 시작" 또는 별도 섹션에 git remote 등록 → 자동 sync 활성화 절차 추가

---

#### C-3. `plugin.json` author 정보 placeholder 🟡

**현재**: `"name": "Linus"`, `"email": "linus@cre8orclub.com"`  
**package.json은 이미** `sk-lim19f/Hypomnema` URL로 되어 있음  
**Worker-2**: package.json의 repository/homepage/bugs는 이미 올바름. plugin.json만 수정 필요

**필요 작업**: `.claude-plugin/plugin.json` author 정보를 실제 정보로 교체

---

#### C-4. `plugin.json` hooks 스키마 오류 (10개) 🔴 *(설명 수정)*

**초안 설명**: "hooks 필드 누락"  
**Worker-2 직접 실행** (`claude plugin validate .`): **10개 스키마 오류** 발생  
실제 문제: `hooks/hooks.json`의 모든 이벤트가 raw string 배열 (`["wiki-session-start.mjs"]`)로 되어 있음. 플러그인 hooks는 `hooks` 배열을 포함한 객체 형식 + `${CLAUDE_PLUGIN_ROOT}` 경로 규칙 필요

**필요 작업**:
- `claude plugin validate .` 출력 10개 오류 확인 후 `hooks/hooks.json` 스키마 수정
- 공식 Claude Code Plugin 문서의 hooks manifest 스펙 확인 (설계 Q-E)
- 수정 후 재검증

---

#### C-5. Privacy README "What goes / does not go in your wiki" 섹션 미완 🟡 *(신규)*

**기획** (`oss-plan.md` §529-546, `index.md` 9-8): "What goes / does not go in your wiki" 섹션 필요  
**현재**: `README.ko.md`에 "위키에 저장할 것 / 저장하지 말 것" 섹션 있음 (line 75-89)  
**Worker-1 지적**: 섹션 자체는 있으나 index.md 9-8 체크리스트 항목이 아직 `[ ]` — 검토 후 완료 처리 필요

**필요 작업**:
- README의 해당 섹션 내용이 oss-plan.md §529-546 요구사항을 충족하는지 검토
- 충족 시 index.md 9-8 `[x]`로 체크

---

### [D] CI/테스트 갭

#### D-1. Uninstall CI 검증 없음 🟡

**Phase 2 DoD**: `/hypo:uninstall` 후 `~/.claude/settings.json` clean (기존 훅 보존)  
**현재 ci.yml**: uninstall 관련 job 없음

**필요 작업**:
- `ci.yml`에 `uninstall` job 추가  
  1. init → settings.json 훅 확인  
  2. uninstall → hypo 훅만 제거됐는지 확인  
  3. 기존 훅(non-hypo)은 보존됐는지 확인

---

#### D-2. nightly verify-pages가 실제로 Claude API를 호출하지 않음 🟡 *(설명 수정)*

**초안 설명**: "ANTHROPIC_API_KEY 없으면 실패"  
**Worker-2 직접 확인**: `scripts/verify.mjs`는 Anthropic 호출 자체 없음 (정적 날짜/메타데이터 검사만)  
실제 문제: A-7과 연결 — semantic 판정이 미구현이므로 nightly job 자체가 의도한 기능을 하지 않음

**필요 작업**:
- A-7 (`/hypo:verify` Claude API 구현) 완료 후 nightly job이 자동으로 의미 있어짐
- 그 전까지는 nightly `verify-pages` job의 목적과 한계를 주석으로 명시

---

### [E] 체크리스트 staleness

#### E-1. `index.md` 완료됐지만 `[ ]`로 표시된 항목 🔴 → **P0로 승격**

**Worker-1 지적**: privacy onboarding은 단순 체크리스트 정리가 아니라 실제 릴리스 블로커

| 항목 | index.md 상태 | 실제 구현 상태 |
|---|---|---|
| `9-8` privacy boundary 안내 | `[ ]` | `commands/init.md` Step 1-2에 구현됨 — 검토 후 체크 |
| `9-12` README.md 작성 | `[ ]` | `README.md` + `README.ko.md` 존재 — 내용 검토 후 체크 |
| `즉시 할 일`: git init, 레포 구조 | `[ ]` | 완료됨 |

**필요 작업**:
- `~/wiki/projects/llm-wiki-oss/index.md` 해당 항목들 검토 후 `[x]`로 업데이트

---

## 3. 우선순위별 작업 목록

### P0 — OSS 공개 블로커

| ID | 작업 | 파일 |
|---|---|---|
| P0-1 | `plugin.json` hooks.json 스키마 오류 10개 수정 (C-4) | `hooks/hooks.json`, `.claude-plugin/plugin.json` |
| P0-2 | `OMC_SKIP_WIKI_GATE` 완전 제거 + OMC 스크럽 정책 확정 (B-1) | `wiki-shared.mjs`, `personal-wiki-check.mjs`, `tests/runner.mjs`, `ci.yml` |
| P0-3 | `docs/ARCHITECTURE.md` "OMC skill wrappers" 수정 (B-2) | `docs/ARCHITECTURE.md` |
| P0-4 | `docs/CONTRIBUTING.md` "omc-teams:2 codex" 제거 (B-3) | `docs/CONTRIBUTING.md` |
| P0-5 | README "로컬 저장" vs "Git-synced" 일관 수정 (C-1) | `README.md`, `README.ko.md` |
| P0-6 | `plugin.json` author 정보 교체 (C-3) | `.claude-plugin/plugin.json` |
| P0-7 | `index.md` 체크리스트 staleness 정리 (E-1) | `~/wiki/projects/llm-wiki-oss/index.md` |
| P0-8 | License 결정 (신규) | `LICENSE`, `package.json` |

### P1 — 기획 핵심 기능 갭

| ID | 작업 | 파일 |
|---|---|---|
| P1-1 | 세션 종료 커맨드 구현 — Q-F 결정 후 (A-1) | `commands/<name>.md`, `skills/<name>.md` |
| P1-2 | ingest miss 분기 리서치 권유 + hit 분기 최신성 확인 (A-2) | `hooks/wiki-lookup.mjs`, `commands/ingest.md` |
| P1-3 | `commands/lint.md` 신설 (A-6) | `commands/lint.md` |
| P1-4 | `/hypo:verify` Claude API 연동 — Q-G 결정 후 (A-7) | `scripts/verify.mjs` |
| P1-5 | `init.mjs` baseline 파일/디렉토리 완성 — Q-H 결정 후 (A-8) | `scripts/init.mjs` |
| P1-6 | init 완료 시 first commit + push (A-5) | `scripts/init.mjs`, `commands/init.md` |
| P1-7 | skills/ 구조 확인 — flat vs SKILL.md (M6) — Q-J 결정 후 | `skills/` |

### P2 — 품질/완성도

| ID | 작업 | 파일 |
|---|---|---|
| P2-1 | `lint-llm.mjs` 실제 구현 (A-3) | `scripts/lint-llm.mjs` |
| P2-2 | SessionStart에 `git pull` 추가 (A-4) | `hooks/wiki-session-start.mjs` |
| P2-3 | README Git sync 초기 설정 절차 추가 (C-2) | `README.md`, `README.ko.md` |
| P2-4 | CI uninstall job 추가 (D-1) | `.github/workflows/ci.yml` |
| P2-5 | nightly verify-pages 한계 주석 추가 (D-2) | `.github/workflows/nightly.yml` |
| P2-6 | Privacy README "What goes/doesn't" 섹션 검토 (C-5) | `README.md`, `README.ko.md` |

---

## 4. 작업 접근 순서 (권장)

```
1. §5 설계 질문 결정 (Q-E~Q-K) → 여러 P1 항목의 방향이 바뀜
2. P0 병렬 실행:
   - P0-1 plugin 스키마 수정 (단독)
   - P0-2~4 OMC 스크럽 (파일 묶음)
   - P0-5~6 README/plugin.json (문서 묶음)
   - P0-7~8 체크리스트 + License (행정)
3. P1 순서: P1-6 → P1-3 → P1-1 → P1-2 → P1-4 → P1-5 → P1-7
4. P2 일괄 처리
```

---

## 5. 미결 설계 질문 (작업 전 결정 필요)

> Worker-1·2 교차 검증 결과 원래 4개에서 11개로 확장됨

| Q | 질문 | 관련 작업 |
|---|---|---|
| Q-A | `session-compact`는 별도 커맨드인가, `crystallize`를 split하는가? | P1-1 |
| Q-B | ingest miss 분기에서 자동 리서치를 hook이 실행하는가, Claude에게 지시만 하는가? | P1-2 |
| Q-C | `plugin.json`에 `hooks` 필드가 Claude Code Plugin API 스펙상 필요한가? | P0-1 |
| Q-D | OSS 레포 최종 이름 (`hypomnema` vs 다른 이름)? | P0-1, package.json |
| Q-E | plugin hooks는 `hooks/hooks.json` 기본값인가, manifest `hooks` 필드인가? `${CLAUDE_PLUGIN_ROOT}` 경로 규칙은? | P0-1 |
| Q-F | 공개 세션 종료 커맨드 이름과 책임: `crystallize`, `session-compact`, `close`? `session-state.md` 업데이트 포함 여부? | P1-1 |
| Q-G | `/hypo:verify`는 수동/정적인가, Claude API 의미론적 판정 + `open-questions.md` append인가? | P1-4 |
| Q-H | `/hypo:init`이 생성해야 할 것의 범위: journal 디렉토리, Home.md, Overview.md, _template 구조, first commit/push 포함 여부? | P1-5, P1-6 |
| Q-I | OMC 제거 정책: CI job 이름(`omc-absent`), `.omc/` gitignore 항목, backwards-compat 환경변수를 어디까지 제거하는가? | P0-2 |
| Q-J | `skills/`는 실제 Agent Skills (`<name>/SKILL.md`) 구조인가, flat markdown 커맨드가 유일한 배포 방식인가? | P1-7 |
| Q-K | README/PRIVACY에서 "로컬 파일", "Git remote 동기화", "Claude API context 노출"을 어떻게 모순 없이 설명하는가? | P0-5 |
