[English](README.md) | 한국어

<p align="center">
  <img src="docs/assets/logo/wordmark.svg" alt="Hypomnema" width="520">
</p>

# Hypomnema

[![npm version](https://img.shields.io/npm/v/hypomnema?color=cb3837)](https://www.npmjs.com/package/hypomnema)
[![npm downloads](https://img.shields.io/npm/dm/hypomnema?color=blue)](https://www.npmjs.com/package/hypomnema)
[![Node.js](https://img.shields.io/node/v/hypomnema?color=43853d&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-51%2F51-brightgreen)](tests/runner.mjs)
[![GitHub stars](https://img.shields.io/github/stars/sk-lim19f/Hypomnema?style=flat&color=yellow)](https://github.com/sk-lim19f/Hypomnema/stargazers)

**Claude Code를 위한 LLM 네이티브 개인 위키. 복리로 성장하는 지식.**

_노트하지 마세요. Claude가 합성하게 하세요._

[빠른 시작](#빠른-시작) • [다른 시스템과의 비교](#다른-시스템과의-비교) • [설계 결정](#설계-결정) • [기능](#기능) • [아키텍처](docs/ARCHITECTURE.md) • [기여](docs/CONTRIBUTING.md)

> Andrej Karpathy의 "LLM 네이티브 위키" 스케치에서 영감을 받아, 10개월간의 개인 운영 경험으로 다듬어진 도구입니다. 캡처 → 합성 → 검색 → 세션 재개로 이어지는 전체 라이프사이클을 Claude Code 명령어와 라이프사이클 훅으로 제공합니다.

---

## 빠른 시작

Hypomnema는 **설치 경로 두 가지**를 제공합니다. 둘 다 동일한 위키·훅·`/hypo:*` 슬래시 커맨드를 만듭니다.

### Path A — Claude Code 플러그인 (권장)

Claude Code 안에서:

```
/plugin marketplace add sk-lim19f/Hypomnema
/plugin install hypomnema@hypomnema
/hypo:init
```

플러그인 설치 단계에서 패키지의 `commands/` 디렉터리에서 `/hypo:*` 커맨드가 등록되고, `/hypo:init`이 위키 스캐폴딩과 `~/.claude/settings.json` 훅 병합을 수행합니다.

### Path B — npm CLI

셸에서:

```bash
npm install -g hypomnema
hypomnema
```

`hypomnema`(또는 `hypomnema --help`로 플래그 확인)는 위키 스캐폴딩과 훅 설치를 수행하고, **추가로** `~/.claude/commands/hypo/`에 슬래시 커맨드 파일까지 복사해서 이후 Claude Code 안에서 `/hypo:*`이 동작합니다. 다음 `hypomnema upgrade` 실행은 파일별 SHA 추적으로 사용자가 손댄 파일을 덮어쓰지 않습니다.

> 어느 경로든: 첫 실행 후 Claude Code를 재시작(또는 새 세션 열기) 해야 새 훅과 슬래시 커맨드가 반영됩니다.

### Step 2: 위키처럼 사용

```
/hypo:ingest https://example.com/some-article-or-paper.pdf
/hypo:query  "내가 X에 대해 알고 있는 것 정리해줘"
/hypo:feedback "버그 픽스 설명할 때는 항상 테스트 명령어를 같이 알려줘"
```

나머지는 훅이 처리합니다 — 자동 staging, 자동 commit/push, 세션 상태 주입, 룩업 신호.

> **여러 기기 동기화:** 위키는 처음부터 git 저장소입니다. remote만 한 번 연결해 두면, 이후 매 세션 종료 시 `Stop` 훅이 동기화를 유지합니다.

---

## Hypomnema가 필요한 이유

개인 지식 도구는 보통 네 가지 부류에 속하고, 각각 다른 지점에서 무너집니다:

| | 통증 | 왜 복리가 안 되는가 |
|---|---|---|
| **노트 볼트** (마크다운 기반, 로컬 우선) | 수동 캡처, 수동 링크, 수동 재독 | 노트가 독립적으로 머무름. 합성 없음 |
| **클라우드 지식 플랫폼** (페이지·DB 하이브리드) | 캡처는 빠르나 검색이 느림 | 키워드 기반 검색. LLM이 직접 접근 못 함 |
| **RAG / 벡터 검색 스택** | 파이프라인·임베딩·청킹 | 청크 반환에 그침. 청크가 무한정 증가 |
| **AI 네이티브 노트북** (독자 포맷의 "세컨드 브레인" 앱) | 처음엔 마법 같음 | 폐쇄 포맷·git 미지원·검색 로직 불투명·벤더 락인 |
| **코드 전용 위키** (레포에서 자동 생성) | 수동 작업 0 | 코드만 다룸. 의사결정·연구·AI 행동 교정 캡처 불가 |

Hypomnema는 이 빈틈을 메웁니다 — **평문 마크다운 위에서의 구조화된 합성, Claude Code 라이프사이클 기반 구동, git 버전 관리, 기본 로컬 우선.**

```
노트 볼트          ───►  전부 저장하나 합성은 0
클라우드 플랫폼     ───►  캡처는 빠르나 검색이 느림
RAG / 벡터 DB     ───►  청크는 돌려주지만 페이지는 못 줌
AI 노트북          ───►  블랙박스, git 없음, 이식성 없음
코드 위키          ───►  코드만, 의사결정/연구/피드백 없음

Hypomnema         ───►  합성 · 마크다운 · git · 훅 · 로컬
```

---

## 다른 시스템과의 비교

| | **Hypomnema** | 노트 볼트 | 클라우드 플랫폼 | RAG / 벡터 DB | AI 노트북 | 코드 위키 |
|---|---|---|---|---|---|---|
| **캡처 노력** | URL 붙여넣기 → 완료 | 직접 입력 | 직접 입력 | 업로드 + 임베딩 | 붙여넣기 / 채팅 | 레포에서 자동 |
| **저장 단위** | 합성된 **페이지** | 노트 | 페이지 / 블록 | 벡터 청크 | 불투명 메모리 | 코드 심볼 |
| **지식 성장** | 새 소스가 기존 페이지를 **갱신** | 각 노트가 독립 | 각 페이지가 독립 | 청크가 무한 증가 | 블랙박스 | 레포가 곧 한계 |
| **검색** | LLM이 근거 있는 답변 합성 | 전문 검색 / 백링크 | 키워드 검색 | 최근접 청크 | 불투명 | 코드 검색 |
| **세션 연속성** | `hot.md` + `session-state.md`로 자동 재개 | 없음 | 없음 | 없음 | 일부 | 없음 |
| **워크플로 통합** | Claude Code 네이티브 | 별도 앱 | 별도 앱 / 브라우저 | 별도 서비스 | 별도 앱 | 별도 사이트 |
| **포맷** | 평문 마크다운 + frontmatter | 마크다운 | 독자 포맷 | 벡터 스토어 | 독자 포맷 | HTML |
| **백엔드** | 로컬 파일 + git | 로컬 파일 | SaaS | 서비스 / DB | SaaS | 서비스 |
| **행동 튜닝** | `/hypo:feedback` → 영구 규칙 | 없음 | 없음 | 없음 | 일부 | 없음 |
| **셋업 비용** | 명령 1개 | 설치 1번 | 가입 | 파이프라인 구축 | 가입 | 레포 연결 |
| **락인** | 0 (마크다운 + git) | 낮음 | 높음 | 중간 | 높음 | 중간 |

### 이 트레이드오프가 가져오는 것

- **저장이 아닌 합성.** 다 못 읽은 글들의 무덤이 만들어지지 않습니다. `/hypo:ingest`가 매번 구조화된 페이지를 만들고, 같은 주제의 후속 인제스트는 그 페이지를 *갱신*합니다.
- **복리적 밀도.** 100개의 소스를 모은 위키가 100개의 단절된 페이지가 되어선 안 됩니다. 실사용 3개월 시점에서 페이지 수는 sub-linear로 늘고 교차 링크는 super-linear로 늘어납니다.
- **컨텍스트 전환 0.** 이미 Claude Code 안에 있습니다. 위키는 슬래시 명령 하나 떨어진 거리 — 새 탭도, 새 앱도, 새 로그인도 없습니다.
- **미래 안전한 저장소.** 평문 마크다운 + git이라는 의미는 — 20년 뒤에도 읽을 수 있고, 오프라인에서도 grep 되며, 언제든 다른 도구로 옮겨갈 수 있고, 아직 만나지 않은 미래의 AI 어시스턴트도 그대로 이해할 수 있다는 뜻입니다.

---

## 설계 결정

각 결정이 왜 이 모양인지:

### 1. 왜 청크 기반 RAG가 아니라 **합성**인가

RAG는 *낯선* 코퍼스에 강합니다 — 100만 페이지 법률 아카이브를 주면 관련 단편을 잘 찾아냅니다. 그런데 *개인* 지식의 실패 모드는 정반대입니다:

- 코퍼스가 작지만 **중복도가 매우 높습니다** (같은 주제의 글 3편).
- 사용자는 단편이 아니라 **관점**을 원합니다.
- 청크 수는 캡처에 비례해 선형 증가합니다 — 지식이 늘지 않아도.

Hypomnema는 청크가 아니라 페이지를 지식 단위로 다룹니다. 새 소스는 페이지에 대해 reconcile됩니다. 결과물은 위키 문서처럼 읽힙니다 — 정확히 위키 문서이기 때문입니다.

### 2. 왜 독자 포맷이 아니라 **마크다운 + git**인가

개인 지식 베이스는 어떤 한 도구보다 오래 살아남아야 합니다. 마크다운은 살아남습니다. git도 살아남습니다. 둘 다 LLM 네이티브입니다 (어떤 모델이든 읽습니다). 둘 다 오프라인에서 동작합니다. 둘 다 30년치의 도구 생태계가 받쳐줍니다. 우리는 *지루한* 스택을 의도적으로 골랐습니다 — 흥미로운 부분은 *Claude가 그 위에서 무엇을 하는가*이기 때문입니다.

### 3. 왜 수동 명령이 아니라 **라이프사이클 훅**인가

마찰은 개인 지식 시스템의 조용한 살인자입니다. 한 가지 생각을 저장하기 위해 클릭이 3번 필요하면, 사람은 멈춥니다. Hypomnema는 Claude Code가 이미 발생시키는 이벤트에 올라탑니다:

| 이벤트 | 그렇지 않으면 수동으로 해야 할 일 |
|---|---|
| `SessionStart` | "어디까지 했더라?" — `hot.md` / `session-state.md` 읽기 |
| `UserPromptSubmit` | "이거 이미 알고 있나?" — BM25 룩업, top-3 주입 |
| `PreCompact` | "session log 안 썼나?" — 체크리스트 가드 |
| `PostToolUse` (Write/Edit) | `git add` |
| `Stop` | `git pull --rebase && git commit && git push` |

설치하고 나면 위키를 *관리*하는 일을 멈추게 됩니다. 그냥 쌓입니다.

### 4. 왜 재개를 위해 **`hot.md` 캐시**를 쓰는가

일시 중단된 프로젝트에서 가장 비싼 작업은 일을 다시 하는 게 아니라 **컨텍스트를 다시 쌓는 일**입니다. `session-log/`를 처음부터 다시 읽는 것은 분 단위 시간과 토큰을 먹지만, 한 페이지짜리 `hot.md`를 읽는 건 둘 다 거의 0입니다. 그래서 가장 최근 상태를 명시적으로 캐싱하고, `Stop`에서 재생성하고, `SessionStart`에서 주입합니다. 재개는 O(1).

### 5. 왜 **feedback → behavior** 파이프라인인가

대부분의 AI 도구는 교정을 *현재 대화에 한해* 받아들입니다. 영속하지 않습니다. Hypomnema는 모든 `/hypo:feedback`을 `pages/feedback/`으로 흘려보내고, 영속성 있는 규칙은 `CLAUDE.md`의 `<learned_behaviors>` 블록으로 승격됩니다 — 이후 모든 세션, 위키를 pull하는 모든 기기에서 살아 있습니다.

### 6. 왜 **API 키도, 벡터 DB도, 외부 서비스도** 없는가

모든 외부 의존은 미래의 실패 모드입니다 — 깨지거나, 인수되거나, 단종되거나, 자격증명이 새거나. Hypomnema는 Node.js 스크립트 + 마크다운 파일 + git이 전부입니다. "AI" 부분은 Claude 자체뿐이고, 그건 어차피 켜져 있습니다.

### 7. 왜 privacy mode 플래그가 아니라 **`.hypoignore`** 인가

v1.0에서는 `personal / shared / public` 3-mode를 만들었습니다. 현실과 부딪히자마자 무너졌습니다 — 모든 privacy 결정은 결국 *경로 단위* 질문이었고, 그 질문은 단일 파일(`.hypoignore`)이 네이티브로 처리합니다. v1.1은 mode 개념을 통째로 삭제했습니다. 단일 파일, 단일 진실 소스.

---

## 기능

### 합성 명령어

8개 명령어가 캡처 → 검색 → 통합 사이클 전체를 커버합니다.

| 명령어 | 하는 일 | 언제 쓰나 |
|---|---|---|
| `/hypo:ingest` | 원본을 `sources/`에 보관하고 Claude가 `pages/`에 구조화된 페이지를 합성. 셸 헬퍼(`scripts/ingest.mjs`)는 read-only — 아직 ingest되지 않은 소스를 *목록만* 출력 | 보관할 가치가 있는 글을 읽었을 때 |
| `/hypo:query` | BM25 검색 + LLM 합성 + `[[wikilink]]` 인용 | 자기 노트에 근거한 답변이 필요할 때 |
| `/hypo:crystallize` | 초안 합성 + 11단계 session-close 체크리스트 | 비자명한 세션 종료 시 |
| `/hypo:resume` | 활성 프로젝트의 가장 최근 세션 상태 로드 | 일시 중단된 프로젝트로 돌아올 때 |
| `/hypo:feedback` | AI 행동 교정 기록, 영구 규칙으로 승격 가능 | Claude가 잘못 하거나 정확히 잘 했을 때 |
| `/hypo:verify` | `verify_by` frontmatter 페이지 감사 | 시간 제약 지식이 노후화됐을 가능성이 있을 때 |
| `/hypo:lint` | frontmatter, 위키링크, 스키마 검증 | 커밋 전, CI에서 |
| `/hypo:graph` | 위키링크 의존성 그래프 생성 | 구조적 성장을 보고 싶을 때 |

### 라이프사이클 훅 (10개)

| 훅 | 이벤트 | 역할 |
|---|---|---|
| `hypo-session-start.mjs` | `SessionStart` | `hot.md` / `session-state.md` 주입 + `git pull --ff-only` |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | 마커 기반 일회성 `hot.md` 주입 (10분 TTL) |
| `hypo-lookup.mjs` | `UserPromptSubmit` | BM25 top-3 HIT 주입 / MISS → 가까운 슬러그 신호 |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | `/compact` 감지 → session-close 체크리스트 강제 |
| `hypo-cwd-change.mjs` | `CwdChanged` | cwd에 매칭되는 프로젝트 `hot.md` 주입 |
| `hypo-file-watch.mjs` | `FileChanged` | 위키 파일 변경 알림 |
| `hypo-auto-stage.mjs` | `PostToolUse(Write/Edit)` | 위키 파일 자동 stage |
| `hypo-auto-commit.mjs` | `Stop` | 자동 commit + pull + push |
| `hypo-hot-rebuild.mjs` | `Stop` | `hot.md` 재생성 |
| `hypo-personal-check.mjs` | `PreCompact` | lint 실패 / session-close 미완 시 compact 차단 |

모든 훅은 위키 루트를 `HYPO_DIR` 환경변수 → `hypo-config.md` 스캔 → `~/hypomnema` 기본값 순으로 해결하며, `hypo-shared.mjs`(`hooks.json`의 `shared` 필드로 선언)를 공유합니다.

### 셋업 & 유지보수

| 명령어 | 목적 |
|---|---|
| `/hypo:init` | 최초 설치 (디렉터리, 훅, settings.json 병합, 첫 commit/push) |
| `/hypo:doctor` | 상태 점검 (훅, 경로, frontmatter, git) |
| `/hypo:upgrade` | 훅/설정을 최신 버전으로 마이그레이션 |
| `/hypo:uninstall` | 훅 및 등록 정보 제거 |
| `/hypo:stats` | 위키 통계 |

### Claude Agent Skills

합성이 핵심인 명령어(`ingest`, `query`, `crystallize`, `lint`, `verify`, `graph`)는 `skills/<name>/SKILL.md`로도 등록되어 있어, 대화가 해당 description에 매칭되면 **Claude Agent Skills**로 자동 트리거됩니다 — 슬래시 명령 없이도.

---

## 시나리오

**A — 새 기술 학습.**
Kubernetes 문서와 블로그 글을 읽는 중. 각 URL을 `/hypo:ingest`에 넣습니다. 세 번째 글에서 Claude가 새 페이지 대신 기존 `kubernetes-networking.md`를 갱신하기 시작합니다. 일주일 후 `/hypo:query "pod CIDR 할당은 어떻게 동작하나요?"`는 자신의 노트를 인용한 합성 답변을 돌려줍니다.

**B — 엔지니어링 결정 추적.**
중요한 변경 사항을 머지하기 전에 설계 문서나 PR 설명을 `/hypo:ingest`로 처리합니다. Claude가 컨텍스트, 트레이드오프, 결정 사항이 담긴 ADR 스타일 페이지를 작성합니다. 이후 `[[wikilink]]` 참조가 관련 프롬프트에 근거를 직접 주입합니다.

**C — 연구 누적.**
몇 주에 걸쳐 한 주제의 논문들을 읽습니다. 각 `/hypo:ingest`가 논문을 합성하고 기존 페이지와 교차 연결합니다. 언제든 `/hypo:query`로 자신의 노트에 근거한 문헌 리뷰 스타일 요약을 받을 수 있습니다.

**D — AI 행동 튜닝.**
Claude가 잘못하거나 정확히 맞았을 때마다 `/hypo:feedback`을 실행합니다. 교정 사항이 `pages/feedback/`에 저장되고 세션 시작 시 주입되어, 같은 실수가 반복되지 않습니다 — 한 대화 안이 아니라 세션 간에 걸쳐서요.

**E — 일시 중단된 프로젝트 재개.**
3주 동안 손 놓았던 프로젝트로 돌아옵니다. 다음 세션 시작 시 `hypo-session-start.mjs`가 `projects/<name>/session-state.md`를 읽고 "다음 작업"과 최근 결정 사항을 컨텍스트에 주입합니다. 첫 프롬프트를 입력하기 전에 이미 업무 파악이 끝나 있습니다.

---

## 위키에 저장할 것 / 저장하지 말 것

**저장할 것:**

- 외부 소스(문서, 논문, 강연)에서 합성된 지식
- 아키텍처 결정과 근거
- AI 행동 교정 및 선호사항
- git에 담기 어려운 프로젝트 컨텍스트 (이해관계자 제약, 미결 질문, 배경)
- 연구 결과 및 교차 소스 비교

**저장하지 말 것:**

- 원본 소스 자료 — `sources/`에 자동·미편집 상태로 보관됨
- 자격증명·토큰·비밀 — `.hypoignore`로 민감 경로 제외
- 현재 세션의 일시적 작업 목록 — 대화 내 작업 목록 사용
- 레포지토리에서 도출 가능한 코드 패턴 — `git log`, `grep`이 정규 소스
- 정규 소유자가 다른 곳에 있는 정보 (Jira, Confluence, API 문서) — 미러가 아닌 *합성본*만 인제스트

---

## 디렉터리 구조

```
<wiki-root>/
├── hypo-config.md       ← 루트 마커 + 설정
├── index.md             ← 검색 가능한 페이지 카탈로그
├── hot.md               ← 활성 프로젝트 포인터
├── log.md               ← 추가 전용 활동 로그
├── SCHEMA.md            ← 타입 시스템 참조
├── hypo-guide.md        ← 운영 가이드
├── .hypoignore          ← 훅에서 제외할 글로브 패턴
├── pages/               ← 영구 지식 페이지
│   └── feedback/        ← AI 행동 교정
├── projects/            ← 프로젝트 아티팩트 및 세션 로그
│   └── <name>/
│       ├── hot.md
│       ├── session-state.md
│       └── session-log/
├── journal/             ← daily / weekly / monthly 기록
└── sources/             ← 원본 인제스트 소스 (수정 금지)
```

---

## 설정

위키 경로는 다음 순서로 해결됩니다 (`scripts/lib/hypo-root.mjs` 참조):

| 우선순위 | 출처 |
|---|---|
| 1 | `--hypo-dir=<path>` CLI 플래그 (스크립트 단위 오버라이드; 해당 플래그를 받는 스크립트에서만 동작) |
| 2 | `HYPO_DIR` 환경변수 |
| 3 | 홈 기준 후보 목록(`~/hypomnema`, `~/wiki`, `~/notes`, `~/knowledge`, `~/Documents/{hypomnema,wiki,notes}`)에서 `hypo-config.md` 마커 발견 |
| 4 | 기본값: `~/hypomnema` |

위키 루트에 `hypo-config.md`를 두면 환경변수 없이도 기기 간 이식이 가능합니다.

`.hypoignore`는 훅이 무시할 경로를 정의합니다 (기본: `*.pdf`, `*.zip`, `*.pem`, `*.env` 등). 직접 편집하면 됩니다 — privacy mode 플래그는 없습니다. 단일 파일, 단일 진실 소스.

### `/hypo:*` 커맨드는 어디서 오는가?

| 설치 경로 | 슬래시 커맨드 위치 |
|---|---|
| 플러그인 (Path A) | Claude Code 플러그인 캐시; `/plugin update`로 갱신 |
| npm CLI (Path B) | `~/.claude/commands/hypo/`; `hypomnema upgrade --apply`로 갱신, 파일별 SHA 추적. 사용자 수정본까지 덮어쓰려면 `--force-commands`(원본은 `.bak`으로 보존) |

---

## 요구 사항

- **Node.js ≥ 18** (18 / 20 / 22 검증됨)
- **Claude Code CLI**

외부 서비스·API 키·벡터 DB 모두 불필요.

---

## 상태

- **테스트:** 51 / 51 통과 — `tests/runner.mjs`
- **CI:** 7개 독립 job (test matrix, lint, init/upgrade snapshots, replay, hypo-absent, uninstall-smoke)
- **릴리스:** `v*` 태그 push 시 `npm publish --provenance` 자동 실행

---

## 문서

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — 내부 구조, 컴포넌트 맵, 데이터 흐름
- [CONTRIBUTING.md](docs/CONTRIBUTING.md) — 개발 환경 설정, 컨벤션, PR 프로세스
- [CHANGELOG.md](CHANGELOG.md) — 릴리스 히스토리

---

## 라이선스

MIT
