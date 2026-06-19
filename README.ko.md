[English](README.md) | 한국어

<p align="center">
  <img src="docs/assets/logo/wordmark.svg" alt="Hypomnema" width="520">
</p>

# Hypomnema

[![npm version](https://img.shields.io/npm/v/hypomnema?color=cb3837)](https://www.npmjs.com/package/hypomnema)
[![npm downloads](https://img.shields.io/npm/dm/hypomnema?color=blue)](https://www.npmjs.com/package/hypomnema)
[![Node.js](https://img.shields.io/node/v/hypomnema?color=43853d&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/sk-lim19f/Hypomnema/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sk-lim19f/Hypomnema/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/sk-lim19f/Hypomnema?style=flat&color=yellow)](https://github.com/sk-lim19f/Hypomnema/stargazers)

**Claude Code를 위한 LLM 네이티브 개인 위키. 복리로 성장하는 지식.**

_Claude에게 기록을 맡기세요 — 그리고 그 기록이 실제로 쌓이는지 측정하세요._

[빠른 시작](#빠른-시작) • [다른 시스템과의 비교](#다른-시스템과의-비교) • [설계 결정](#설계-결정) • [기능](#기능) • [아키텍처](docs/ARCHITECTURE.md) • [기여](docs/CONTRIBUTING.md)

> Andrej Karpathy의 "LLM 네이티브 위키" 스케치에서 영감을 받아, 10개월간의 AI 워크플로우 실험과 v1.2.0 공개 전 한 달의 Hypomnema 직접 굴리기(dogfood)로 다듬어진 도구입니다. 캡처 → 합성 → 검색 → 세션 재개로 이어지는 전체 라이프사이클을 Claude Code 명령어와 라이프사이클 훅으로 제공합니다.

> **아래에서 자주 쓰이는 용어 간단 정리.** *프런트매터(frontmatter)* = 마크다운 파일 맨 위의 YAML 블록. *위키링크(wikilink)* = `[[페이지-슬러그]]` 형태의 교차 참조. *ADR* = "Architecture Decision Record" — 어떤 설계 결정을 *왜* 했는지 짧게 적은 마크다운 페이지. *projection*(투영) = 한 방향 자동 파생(`pages/feedback/*.md` → `MEMORY.md` / `<learned_behaviors>`). *훅(hook)* = Claude Code가 라이프사이클 이벤트에서 자동으로 실행하는 스크립트. *hot.md* / *session-state.md* = "방금 무엇을 했는지"와 "다음에 무엇을 할지"를 담는 프로젝트별 캐시 파일 — 멈춘 프로젝트를 한 번에 이어 받을 수 있게 합니다. 전체 용어 풀이는 [용어 사전](#용어-사전) 참조.

> **현재 자동화 범위와 다음 목표.** v1.3.0(현재)은 트리거 모델을 솔직하게 정리합니다. 위키 작업(자료 정리·검색·세션 마무리)은 여전히 사용자가 `/hypo:*` 명령어를 직접 입력해 시작합니다. 다만 **v1.1.0**부터 위키가 한 세션에서 얼마나 활용됐는지를 측정하는 *관측성 지표(observability score)* 가 들어갔고, **v1.2.0**은 그 위에 사용자가 시키지 않아도 자동으로 동작하는 영역 4개를 추가했습니다:
> - **`feedback` 페이지를 단일 원천(source of truth)으로** — `pages/feedback/`에 한 번만 적으면, 위키가 `MEMORY.md`와 `~/.claude/CLAUDE.md`의 `<learned_behaviors>` 블록을 자동으로 갱신합니다.
> - **확장 파일 동봉 동기화** — 위키 안의 `~/hypomnema/extensions/{agents,commands,hooks,skills}/`에 둔 파일을 자동으로 `~/.claude/`에 반영합니다. `--codex` 옵션을 추가하면 `hooks`·`commands`는 `~/.codex/`에도 반영되지만, `agents`와 `skills`는 Claude 전용이라 의도적으로 건너뜁니다.
> - **프로젝트 자동 생성** — 작업 디렉터리를 git 저장소(`package.json`·`Cargo.toml` 등의 프로젝트 표식이 있는 곳)로 옮겼을 때 대응하는 위키 프로젝트가 없으면, 새로 만들지 물어봅니다.
> - **세션 종료 자동 정리와 `/clear` 복구** — 의미 있는 세션이 끝날 때 "마무리 메모를 짧게 남길까요?"가 자동으로 뜨고, 마무리하지 않은 채 `/clear`를 입력해도 다음 세션 시작 시 이어서 정리할 수 있습니다.
>
> 스키마(`SCHEMA.md`)는 2.0으로 올라갑니다. `feedback` 페이지 타입에 9개의 필수 항목이 추가되며, `hypomnema upgrade --apply`를 실행하면 위키 루트에 `MIGRATION-v2.0.md`가 생성되어 단계별 보강 체크리스트를 제공합니다. 사용자가 직접 편집한 `SCHEMA.md`는 upgrade가 **덮어쓰지 않습니다** — 안내만 표시하고, 실제 반영은 사용자가 수동으로 결정합니다(이 정책을 코드에서는 *Option C*로 부릅니다).
>
> **v1.3.0**은 자율성을 넓히기보다 이 레이어를 다듬습니다. 세션 마무리 흐름에 *권고형* 성찰 4가지(자동 실행 없이 제안만)가 들어가고, `hypomnema lint --strict`가 선택된 경고를 에러로 승격해 릴리스 게이트로 쓸 수 있으며, 설치가 **stale-sibling 감지**로 단단해집니다 — `$PATH`에 남은 더 오래된 `hypomnema`가 더는 활성 훅을 조용히 다운그레이드하지 못합니다.

---

## 빠른 시작

Hypomnema는 **설치 경로 두 가지**를 제공합니다. 둘 다 동일한 위키·훅·`/hypo:*` 슬래시 커맨드를 만듭니다.

### Path A — Claude Code 플러그인 (권장)

Claude Code 안에서:

```
/plugin marketplace add sk-lim19f/Hypomnema
/plugin install hypo@hypomnema
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

개인 지식 도구는 보통 다섯 가지 부류에 속하고, 각각 다른 지점에서 무너집니다:

| | 어디서 막히는가 | 왜 지식이 쌓이지 않는가 |
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
| **자율 동작(auto-behavior)** | 명시적 `/hypo:*` 호출 + **v1.1 관측성 점수** + **v1.2 피드백 단일 원천 자동 반영 / 확장 파일 동봉 동기화 / 프로젝트 자동 생성 / 세션 종료 시 최소 마무리 자동 제안**; v2 목표는 완전 자율 동작 | 없음 | 없음 | 없음 | 블랙박스 | 없음 |
| **셋업 비용** | 명령 1개 | 설치 1번 | 가입 | 파이프라인 구축 | 가입 | 레포 연결 |
| **락인** | 0 (마크다운 + git) | 낮음 | 높음 | 중간 | 높음 | 중간 |

### 이 선택이 가져다주는 것

- **저장이 아니라 합성.** 끝까지 읽지도 못한 글들의 무덤이 쌓이지 않습니다. `/hypo:ingest`는 매번 구조화된 페이지를 만들고, 같은 주제의 다음 인제스트는 새 페이지가 아닌 *기존 페이지의 갱신*으로 들어갑니다.
- **밀도가 복리로 자란다.** 소스 100개짜리 위키가 단절된 페이지 100개로 끝나면 의미가 없습니다. 실사용 3개월 시점이면 페이지 수는 소스 증가보다 천천히 늘고, 교차 링크는 오히려 더 빠르게 늘어납니다.
- **맥락 전환이 0이다.** 어차피 Claude Code 안에서 일하는 중입니다. 위키는 슬래시 명령 한 줄로 닿습니다 — 새 탭도, 다른 앱도, 추가 로그인도 없습니다.
- **저장 형식이 오래 살아남는다.** 평문 마크다운 + git 조합은 20년 뒤에도 읽힙니다. 오프라인에서도 `grep`이 됩니다. 언제든 다른 도구로 옮길 수 있고, 아직 세상에 없는 미래의 AI 도우미도 별도 변환 없이 그대로 읽을 수 있습니다.

---

## 용어 사전

Hypomnema가 본문에서 반복적으로 쓰는 용어를 한 표로 모았습니다. 본문을 훑어볼 때 이 표를 옆 탭에 열어 두시면 됩니다.

| 용어 | Hypomnema에서의 의미 |
|---|---|
| **프런트매터(frontmatter)** | 마크다운 페이지 맨 위의 YAML 블록 — `title`, `type`, `tags` 같은 항목이 들어갑니다 |
| **위키링크(wikilink)** | `[[페이지-슬러그]]` 형태의 페이지 간 교차 참조 — `lint` 시 유효성이 확인됩니다 |
| **ADR** | "Architecture Decision Record" — 자명하지 않은 설계 결정을 *왜* 했는지 짧게 기록하는 마크다운 페이지 |
| **스키마(schema)** | `SCHEMA.md`에 정의된 타입 분류 + 필수 항목 규칙 — 페이지가 유효한지의 기준 |
| **lint** | 읽기 전용 검증기(`hypomnema lint`) — 프런트매터·위키링크·스키마를 한꺼번에 점검 |
| **projection(투영)** | 한 방향 자동 파생 — `pages/feedback/*.md` → `MEMORY.md`와 CLAUDE.md `<learned_behaviors>` |
| **단일 원천(source of truth, SoT)** | 사용자가 편집하는 단 하나의 파일 — 단방향 반영(projection)은 그로부터만 파생되며, 역방향은 허용되지 않습니다 |
| **훅(hook)** | Claude Code가 라이프사이클 이벤트(`SessionStart`, `Stop` 등)에 자동으로 실행하는 스크립트 |
| **라이프사이클 이벤트** | Claude Code가 플러그인에 알리는 시점 — 세션 시작/프롬프트 제출/도구 사용/`compact` 요청/세션 종료 등 |
| **`hot.md`** | 프로젝트별 캐시 — "방금 무엇을 했는지"(직전 세션의 핵심) |
| **`session-state.md`** | 프로젝트별 캐시 — "다음에 무엇을 할지"(다음 세션 시작 시 주입되는 이어받기 데이터) |
| **`.hypoignore`** | 모든 콘텐츠 주입 훅과 `ingest`에서 제외할 경로(글롭 패턴) |
| **관측성 지표(observability score)** | 세션별 측정값(ingest·query·session-close·citation 비율) — 위키가 실제로 활용됐는지를 보여줍니다 |
| **manifest** | 설치 스크립트가 작성하는 작은 JSON — 어떤 파일을 어떤 SHA로 설치했는지 정확히 기록 |
| **`additionalContext`** | Claude Code 훅이 프롬프트에 컨텍스트를 끼워 넣는 필드 — 콘텐츠 주입 훅의 출력 위치 |
| **바이트 동일(byte-equal)** | `--apply` 전후가 비트 단위로 같은 파일 — "건드리지 않았다"는 가장 강한 보장 |
| **BM25** | 고전적인 전문(全文) 랭킹 알고리즘 — `/hypo:query`의 MISS 내성 검색을 담당 |
| **Option C** | `hypomnema upgrade --apply`가 사용자의 `SCHEMA.md`를 절대 덮어쓰지 않는 정책 — 마이그레이션 보고서만 작성하고, 적용은 사용자가 수동으로 |

본문에서 마주친 용어가 이 표에 빠져 있다면 문서 버그입니다. 이슈를 남겨 주세요.

---

## 설계 결정

각 결정이 왜 이 모양인지:

### 1. 왜 청크 기반 RAG가 아니라 **합성**인가

RAG는 *낯선* 코퍼스에 강합니다 — 100만 페이지 법률 아카이브를 주면 관련 단편을 잘 찾아냅니다. 그런데 *개인* 지식의 실패 모드는 정반대입니다:

- 코퍼스가 작지만 **중복도가 매우 높습니다** (같은 주제의 글 3편).
- 사용자는 단편이 아니라 **관점**을 원합니다.
- 청크 수는 캡처에 비례해 선형 증가합니다 — 지식이 늘지 않아도.

Hypomnema는 청크가 아니라 페이지를 지식 단위로 다룹니다. 새 소스는 관련 페이지에 반영됩니다 — 기존 페이지가 있으면 갱신하고, 없으면 새 페이지로 만듭니다. 결과물은 위키 문서처럼 읽힙니다 — 정확히 위키 문서이기 때문입니다.

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

v1.0에서는 `personal / shared / public` 3-mode를 만들었습니다. 현실과 부딪히자마자 무너졌습니다 — 모든 privacy 결정은 결국 *경로 단위* 질문이었고, 그 질문은 단일 파일(`.hypoignore`)이 네이티브로 처리합니다. v1.1은 mode 개념을 통째로 삭제했습니다. 한 파일이 모든 결정을 담는 단일 원천 구조입니다.

---

## 기능

### 합성 명령어

8개 명령어가 캡처 → 검색 → 통합 사이클 전체를 커버합니다.

| 명령어 | 하는 일 | 언제 쓰나 |
|---|---|---|
| `/hypo:ingest` | 원본을 `sources/`에 보관하고 Claude가 `pages/`에 구조화된 페이지를 합성. 셸 헬퍼(`scripts/ingest.mjs`)는 read-only — 아직 ingest되지 않은 소스를 *목록만* 출력 | 보관할 가치가 있는 글을 읽었을 때 |
| `/hypo:query` | BM25 검색 + LLM 합성 + `[[wikilink]]` 인용 | 자기 노트에 근거한 답변이 필요할 때 |
| `/hypo:crystallize` | 세션 마무리 체크리스트(1~6단계) 실행. 요청 시 초안 합성(7~11단계)까지 수행 | 단순하지 않은 세션을 마칠 때 |
| `/hypo:resume` | 활성 프로젝트의 가장 최근 세션 상태를 불러오기 | 잠시 미뤄둔 프로젝트로 돌아올 때 |
| `/hypo:feedback` | AI 행동 교정 사항을 기록. 영구 규칙으로 승격 후보가 됨 | Claude가 잘못한 순간 — 또는 반대로 정확히 잘한 순간 |
| `/hypo:verify` | `verify_by` 프런트매터가 붙은 페이지를 점검 | 시간이 지나 옛 정보가 됐을 가능성이 있을 때 |
| `/hypo:lint` | frontmatter, 위키링크, 스키마 검증 | 커밋 전, CI에서 |
| `/hypo:graph` | 위키링크 의존성 그래프 생성 | 구조적 성장을 보고 싶을 때 |
| `/hypo:rename` | 페이지·디렉터리 이름 변경 + 인바운드 `[[위키링크]]` 갱신 | 페이지나 프로젝트 폴더 이름을 바꿀 때 |

### 라이프사이클 훅 (14개)

| 훅 | 이벤트 | 역할 |
|---|---|---|
| `hypo-session-start.mjs` | `SessionStart` | `hot.md` / `session-state.md` 주입 + `git pull --ff-only` |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | 마커 기반 일회성 `hot.md` 주입 (10분 TTL) |
| `hypo-lookup.mjs` | `UserPromptSubmit` | BM25 top-3 HIT 주입 / MISS → 가까운 슬러그 신호 |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | `/compact` 감지 → session-close 체크리스트 강제 |
| `hypo-cwd-change.mjs` | `CwdChanged` | cwd에 매칭되는 프로젝트 `hot.md` 주입 |
| `hypo-file-watch.mjs` | `FileChanged` | 위키 파일 변경 알림 (`.hypoignore` 준수 — 매칭 경로는 LLM 컨텍스트로 재주입되지 않음) |
| `hypo-auto-stage.mjs` | `PostToolUse(Write/Edit)` | 위키 파일 자동 stage |
| `hypo-auto-commit.mjs` | `Stop` | 자동 commit + pull + push |
| `hypo-hot-rebuild.mjs` | `Stop` | `hot.md` 재생성 |
| `hypo-personal-check.mjs` | `PreCompact` | lint 실패 / session-close 미완 시 compact 차단 |
| `hypo-session-end.mjs` | `SessionEnd` | SessionEnd 마커 기록 — 다음 SessionStart가 `source=clear` 복구를 감지하기 위함 |
| `hypo-session-record.mjs` | `Stop` | observability 점수 + auto-resume 신호용 세션 메타데이터 기록 |
| `hypo-auto-minimal-crystallize.mjs` | `Stop` | 단순하지 않은 세션이 끝났을 때 `/hypo:crystallize --apply-session-close --minimal`을 자동 제안 (사용자가 동의하면 실행) |
| `hypo-web-fetch-ingest.mjs` | `PostToolUse(WebFetch/WebSearch)` | WebFetch/WebSearch 완료 후 `additionalContext`에 `/hypo:ingest` 권유 안내 주입 (privacy 보호: WebFetch URL의 query/hash/userinfo 제거) |

모든 훅은 위키 루트를 `HYPO_DIR` 환경변수 → `hypo-config.md` 스캔 → `~/hypomnema` 기본값 순으로 해결하며, `hypo-shared.mjs`(`hooks.json`의 `shared` 필드로 선언)를 공유합니다.

이와 별도로 `SessionStart` 훅은 npm 레지스트리와 Claude Code 플러그인 마켓플레이스를 백그라운드에서 확인합니다(세션 시작을 막지 않습니다). 새 버전이 게시되어 있으면 다음 세션 시작 시 "Update available!" 안내가 한 줄 표시됩니다. `HYPO_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`을 지정하거나 `CI=true` 환경에서 실행하면 점검을 건너뜁니다.

위 네 가지 레인 외의 v1.3 세부 수정 — 세션 마무리 lint를 건드린 파일로 스코프해 무관한 debt로 `/compact`가 막히지 않게 한 변경, `feedback` scope 검증기가 cwd 유래 project id를 수용하게 한 수정, `--strict`가 에러로 승격하는 안정적 lint 경고 ID `W1`/`W2`/`W4`(`--fix`로 자동복구되는 `W3`는 경고로 유지) — 은 [`CHANGELOG.md`](CHANGELOG.md)를 참고하세요. **v1.3.1**은 수정 전용 패치입니다: 업데이트 notifier 배너가 이제 보이지 않던 stderr 출력 대신 top-level `systemMessage` 채널로 실제 사용자에게 도달하고, `/hypo:upgrade`가 플러그인·dual(수동+플러그인) 설치에서 core 훅을 중복 등록하지 않으며, 세션 마무리가 두 프로젝트가 같은 최신 날짜를 가질 때 완료된 close를 false-block 하지 않습니다. **v1.3.2**는 비-프로젝트(툴링·위키 전용) 세션을 무관한 프로젝트에 엮지 않고 닫는 1급 log-only close 경로와, 페이지 이름을 바꿀 때 해당하는 인바운드 위키링크를 갱신하는 `rename` 헬퍼를 추가합니다(모호하거나 append-only인 참조는 갱신하지 않고 보고합니다). 또한 세션 마무리 게이트(오늘 활동한 모든 프로젝트를 게이트, 세션별 마커와 `/compact`가 하나의 게이트를 공유, 도출 가능한 루트 `log.md` 항목 자동 도출)와 linter(`--json`이 파이프에서 잘리지 않음, 볼트 관습 위키링크를 오탐 대신 정상 해석)를 수정합니다. **v1.3.3**은 세션 마무리 게이트를 실수 발동에 대해 단단히 합니다: 모델이 실제 사용자 종료 신호 없이 세션을 닫을 수 없고, 종료 관련 텍스트를 읽는 것이 턴을 false-block하지 않으며, `--apply-session-close`가 사용자 종료 신호가 있는 close에서 payload 커밋과 마커 기록을 한 번에 끝내고, 일상적 트래커 bookkeeping이 무관한 프로젝트의 `/compact`를 cross-block하지 않습니다. 또한 `rename`을 디렉터리 서브트리 전체 이동으로 확장합니다(`/hypo:rename` 커맨드와 대상 경로가 이미 있을 때의 merge/renumber 충돌 리포트 포함).

### 셋업 & 유지보수

| 명령어 | 목적 |
|---|---|
| `/hypo:init` | 최초 설치 (디렉터리, 훅, settings.json 병합, 첫 commit/push) |
| `/hypo:doctor` | 상태 점검 (훅, 경로, frontmatter, git) |
| `/hypo:upgrade` | 훅/설정을 최신 버전으로 마이그레이션 |
| `/hypo:uninstall` | 훅 및 등록 정보 제거 |
| `/hypo:stats` | 위키 통계 |
| `/hypo:audit` | observability 감사 (세션별 메트릭, 주간 보고서) |

### Claude Agent Skills

합성이 핵심인 명령어(`ingest`, `query`, `crystallize`, `lint`, `verify`, `graph`)는 `skills/<name>/SKILL.md`로도 등록되어 있습니다. 대화 내용이 해당 스킬의 설명(`description`)과 맞아떨어지면 **Claude Agent Skills** 메커니즘이 슬래시 명령 입력 없이도 자동으로 호출합니다.

---

## 시나리오

**A — 새 기술 학습.**
Kubernetes 문서와 블로그 글을 읽는 중입니다. 각 URL을 `/hypo:ingest`에 넘깁니다. 세 번째 글쯤 되면 Claude가 새 페이지를 만드는 대신 기존 `kubernetes-networking.md`를 갱신하기 시작합니다. 일주일 뒤 `/hypo:query "pod CIDR 할당은 어떻게 동작하나요?"`를 실행하면, 본인이 직접 정리해 둔 노트를 인용한 합성 답변이 돌아옵니다.

**B — 엔지니어링 결정 추적.**
중요한 변경 사항을 머지하기 전에 설계 문서나 PR 설명을 `/hypo:ingest`로 처리합니다. Claude가 컨텍스트, 트레이드오프, 결정 사항이 담긴 ADR 스타일 페이지를 작성합니다. 이후 `[[wikilink]]` 참조가 관련 프롬프트에 근거를 직접 주입합니다.

**C — 연구 누적.**
몇 주에 걸쳐 한 주제의 논문들을 읽습니다. 각 `/hypo:ingest`가 논문을 합성하고 기존 페이지와 교차 연결합니다. 언제든 `/hypo:query`로 자신의 노트에 근거한 문헌 리뷰 스타일 요약을 받을 수 있습니다.

**D — AI 행동 튜닝.**
Claude가 잘못한 순간 — 또는 반대로 정확히 잘한 순간 — `/hypo:feedback`을 실행합니다. 교정 내용이 `pages/feedback/`에 저장되고 다음 세션 시작 시 자동으로 주입되므로, 같은 실수가 다시 반복되지 않습니다. 한 번의 대화 안에서만 효력이 있는 게 아니라, 세션이 바뀌어도 그대로 유지된다는 뜻입니다.

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

`.hypoignore`는 훅이 무시할 경로를 정의합니다 (기본: `*.pdf`, `*.zip`, `*.pem`, `*.env` 등). 직접 편집하면 됩니다 — privacy mode 플래그는 없습니다. 파일 하나가 모든 결정을 담는 단일 원천 구조입니다.

> **모델 사업자에게 전송되는 범위 안내.** Hypomnema 훅은 위키 본문을 Claude Code의 추가 컨텍스트(`additionalContext`)에 실어 보내며, 이 내용은 프롬프트의 일부로 Claude 모델 사업자에게 전송됩니다. 따라서 `.hypoignore`에 등록된 경로는 모든 주입 훅(`hypo-file-watch`, `hypo-session-start`, `hypo-cwd-change`, `hypo-lookup`)과 `ingest`에서 제외되지만, 등록되지 *않은* 파일은 전송 대상이 됩니다. (`hypo-auto-stage`/`hypo-auto-commit`은 git 스테이징용 훅이라 컨텍스트를 주입하지는 않지만, 스테이징 판단에도 동일하게 `.hypoignore`를 참고합니다.) 비밀 정보는 위키에 두지 마시고, `HYPO_DIR` 아래에 민감한 내용을 저장하기 전에 `.hypoignore` 패턴을 먼저 점검하시기 바랍니다.

> **git sync 범위.** Hypomnema는 `~/hypomnema/` 위키 자체만 git sync합니다. 단, `init` / `upgrade`는 `~/.claude/` 내부의 관리 대상 영역 — Hypomnema 자체 hook(`~/.claude/hooks/`), 슬래시 커맨드(`~/.claude/commands/hypo/`), `settings.json` 등록 — 을 설치·SHA 추적하며, v1.2.0 **extensions companion sync**에 의해 위키의 `~/hypomnema/extensions/`에 둔 `agents/`·`commands/`·`hooks/`·`skills/`도 자동 미러링합니다(`--codex` 옵션 시 `hooks`·`commands` 부분 집합만 `~/.codex/`로). 이 관리 대상 영역 *바깥*의 `~/.claude/` 콘텐츠는 의도적으로 Hypomnema가 **관리하지 않습니다** — 위키를 거치지 않는 기타 agent/skill, 머신 고유 `settings.local.json` 등 일반적인 Claude Code 설정 기기 간 동기화는 [chezmoi](https://www.chezmoi.io/) 같은 별도 dotfiles 매니저 사용을 권장합니다.

### `/hypo:*` 커맨드는 어디서 오는가?

| 설치 경로 | 슬래시 커맨드 위치 |
|---|---|
| 플러그인 (Path A) | Claude Code 플러그인 캐시; `/plugin marketplace update hypomnema` 후 `/reload-plugins`로 갱신 |
| npm CLI (Path B) | `~/.claude/commands/hypo/`; `hypomnema upgrade --apply`로 갱신, 파일별 SHA 추적. 사용자 수정본까지 덮어쓰려면 `--force-commands`(원본은 `.bak`으로 보존) |

---

## 요구 사항

- **Node.js ≥ 18** (18 / 20 / 22 검증됨)
- **Claude Code CLI**

외부 서비스·API 키·벡터 DB 모두 불필요.

---

## 상태

- **테스트:** `npm test` 참조 — 레인이 ship될 때마다 카운트가 변하므로 러너가 단일 원천입니다
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
