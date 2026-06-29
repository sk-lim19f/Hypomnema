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

Claude Code를 위한 LLM 네이티브 개인 위키. 쓸수록 지식이 쌓입니다.

_Claude에게 기록을 맡기고, 그 기록이 실제로 쌓이는지 측정하세요._

[빠른 시작](#빠른-시작) • [다른 시스템과의 비교](#다른-시스템과의-비교) • [설계 결정](#설계-결정) • [기능](#기능) • [아키텍처](docs/ARCHITECTURE.md) • [기여](docs/CONTRIBUTING.md)

Andrej Karpathy의 "LLM 네이티브 위키" 스케치에서 출발했습니다. 10개월간 AI 워크플로를 실험하고 공개 한 달 전부터 직접 써 보며 다듬었습니다. 자료 캡처부터 페이지 합성, 다시 찾기, 멈춘 세션 이어받기까지 한 사이클 전체를 Claude Code 명령어와 라이프사이클 훅으로 제공합니다.

처음 보는 용어가 나오면 [용어 사전](#용어-사전)을 옆에 펴 두세요. frontmatter, wikilink, projection, 훅, `hot.md` / `session-state.md` 같은 말이 거기 한 줄씩 정리돼 있습니다.

### 지금 어디까지 자동인가

현재 릴리스는 v1.5.0이고, 머신 간 안정성과 일상의 마찰로 초점을 옮겼습니다: git 동기화로 여러 머신이 공유하는 볼트에서 `cwd`-first resume가 올바른 프로젝트를 찾고, 코드 레포에서 작업하는 세션이 매번 위키를 다시 찾는 대신 위키 위치를 안내받으며, 세션 마무리가 무관한 lint 부채를 다시 나열하거나 수백 개 경고를 컨텍스트에 쏟지 않습니다. 그 앞 v1.4.x는 세션 마무리 경로를 견고하게 다듬었습니다. 위키 작업(자료 정리·검색·세션 마무리)은 아직 `/hypo:*` 명령어를 직접 입력해 시작합니다. v2의 목표는 Claude가 시키지 않아도 위키를 읽고 쓰고 합성하는 완전 자율 동작이고, 지금은 그쪽으로 가는 중입니다. v1.1.0이 위키가 한 세션에서 얼마나 쓰였는지 재는 관측성 점수를 넣었습니다. v1.2.0은 자동으로 동작하는 영역 네 가지를 추가했습니다.

- 피드백 한 곳만 고치면 나머지는 따라옵니다. `pages/feedback/`에 한 번 적으면 위키가 `MEMORY.md`와 `~/.claude/CLAUDE.md`의 `<learned_behaviors>` 블록을 자동으로 갱신합니다(단방향 projection).
- 확장 파일도 함께 동기화. 위키 안 `~/hypomnema/extensions/{agents,commands,hooks,skills}/`에 둔 파일을 `~/.claude/`에 자동 반영합니다. `--codex`를 붙이면 `hooks`·`commands`는 `~/.codex/`에도 반영하지만, `agents`와 `skills`는 Claude 전용이라 건너뜁니다.
- 프로젝트 자동 생성. 프로젝트 표식(`package.json`·`Cargo.toml` 등)이 있는 git 저장소로 `cd` 했는데 대응하는 위키 프로젝트가 없으면 만들지 물어봅니다.
- 세션 종료 자동 정리와 `/clear` 복구. 의미 있는 세션이 끝나면 "마무리 메모를 짧게 남길까요?"가 자동으로 뜹니다. 마무리하지 않은 채 `/clear`를 입력해도 다음 세션 시작 때 이어서 정리할 수 있습니다.

버전별로 무엇이 바뀌었는지는 [CHANGELOG](CHANGELOG.md)에 있습니다. 한 가지만 알아 두면, `hypomnema upgrade --apply`는 사용자가 직접 편집한 `SCHEMA.md`를 덮어쓰지 않습니다. 스키마가 올라가면 위키 루트에 마이그레이션 보고서를 써 주고, 실제 반영은 사용자가 직접 결정합니다(코드에서 _Option C_로 부르는 정책).

---

## 빠른 시작

설치 경로는 두 가지입니다. 어느 쪽이든 같은 위키·훅·`/hypo:*` 슬래시 커맨드가 만들어집니다.

### Path A: Claude Code 플러그인 (권장)

Claude Code 안에서:

```
/plugin marketplace add sk-lim19f/Hypomnema
/plugin install hypo@hypomnema
/hypo:init
```

플러그인을 설치하면 패키지의 `commands/` 디렉터리에서 `/hypo:*` 커맨드가 등록되고, `/hypo:init`이 위키 스캐폴딩과 `~/.claude/settings.json` 훅 병합을 처리합니다.

### Path B: npm CLI

셸에서:

```bash
npm install -g hypomnema
hypomnema
```

`hypomnema`(플래그는 `hypomnema --help`로 확인)는 위키 스캐폴딩과 훅 설치를 합니다. 거기에 더해 `~/.claude/commands/hypo/`로 슬래시 커맨드 파일까지 복사하므로, 이후 Claude Code 안에서 `/hypo:*`이 동작합니다. 다음에 `hypomnema upgrade`를 돌려도 파일별 SHA를 추적해 사용자가 손댄 파일은 덮어쓰지 않습니다.

> 어느 경로든 첫 실행 뒤에는 Claude Code를 재시작(또는 새 세션 열기)해야 새 훅과 슬래시 커맨드가 반영됩니다.

### Step 2: 위키처럼 쓰기

```
/hypo:ingest https://example.com/some-article-or-paper.pdf
/hypo:query  "내가 X에 대해 알고 있는 것 정리해줘"
/hypo:feedback "버그 픽스 설명할 때는 항상 테스트 명령어를 같이 알려줘"
```

나머지는 훅이 합니다. 자동 staging, 자동 commit/push, 세션 상태 주입, 관련 노트 룩업까지 알아서 처리합니다.

> 여러 기기 동기화: 위키는 처음부터 git 저장소입니다. remote만 한 번 연결해 두면 이후 매 세션 종료 때 `Stop` 훅이 동기화를 맞춰 줍니다.

---

## Hypomnema가 필요한 이유

개인 지식 도구는 보통 다섯 부류로 나뉩니다. 각각 무너지는 지점이 다릅니다.

| | 어디서 막히는가 | 왜 지식이 쌓이지 않는가 |
|---|---|---|
| 노트 볼트 (마크다운 기반, 로컬 우선) | 수동 캡처, 수동 링크, 수동 재독 | 노트가 따로 논다. 합성이 없다 |
| 클라우드 지식 플랫폼 (페이지·DB 하이브리드) | 캡처는 빠르나 검색이 느리다 | 키워드 검색. LLM이 직접 못 읽는다 |
| RAG / 벡터 검색 스택 | 파이프라인·임베딩·청킹 | 청크만 돌려준다. 청크가 무한정 늘어난다 |
| AI 네이티브 노트북 (독자 포맷 "세컨드 브레인" 앱) | 처음엔 마법 같다 | 폐쇄 포맷·git 미지원·검색 로직 불투명·벤더 락인 |
| 코드 전용 위키 (레포에서 자동 생성) | 수동 작업이 없다 | 코드만 다룬다. 의사결정·연구·AI 행동 교정은 못 담는다 |

Hypomnema는 이 빈틈을 메웁니다. 평문 마크다운 위에 구조화된 합성을 얹고 Claude Code 라이프사이클에 맞춰 돌아갑니다. git으로 버전을 관리하며 기본은 로컬 우선입니다.

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

| | Hypomnema | 노트 볼트 | 클라우드 플랫폼 | RAG / 벡터 DB | AI 노트북 | 코드 위키 |
|---|---|---|---|---|---|---|
| 캡처 노력 | URL 붙여넣기 → 끝 | 직접 입력 | 직접 입력 | 업로드 + 임베딩 | 붙여넣기 / 채팅 | 레포에서 자동 |
| 저장 단위 | 합성된 페이지 | 노트 | 페이지 / 블록 | 벡터 청크 | 불투명 메모리 | 코드 심볼 |
| 지식 성장 | 새 소스가 기존 페이지를 갱신 | 각 노트가 독립 | 각 페이지가 독립 | 청크가 무한 증가 | 블랙박스 | 레포가 곧 한계 |
| 검색 | LLM이 근거 있는 답을 합성 | 전문 검색 / 백링크 | 키워드 검색 | 최근접 청크 | 불투명 | 코드 검색 |
| 세션 연속성 | `hot.md` + `session-state.md`로 자동 재개 | 없음 | 없음 | 없음 | 일부 | 없음 |
| 워크플로 통합 | Claude Code 네이티브 | 별도 앱 | 별도 앱 / 브라우저 | 별도 서비스 | 별도 앱 | 별도 사이트 |
| 포맷 | 평문 마크다운 + frontmatter | 마크다운 | 독자 포맷 | 벡터 스토어 | 독자 포맷 | HTML |
| 행동 튜닝 | `/hypo:feedback` → 영구 규칙 | 없음 | 없음 | 없음 | 일부 | 없음 |
| 자동 동작 | `/hypo:*` 호출 + 관측성 점수(v1.1) + 자동화 4영역(v1.2); v2 목표는 완전 자율 | 없음 | 없음 | 없음 | 블랙박스 | 없음 |
| 셋업 비용 | 명령 1개 | 설치 1번 | 가입 | 파이프라인 구축 | 가입 | 레포 연결 |
| 락인 | 0 (마크다운 + git) | 낮음 | 높음 | 중간 | 높음 | 중간 |

### 이 선택이 가져다주는 것

- 저장이 아니라 합성. 끝까지 읽지도 못한 글이 무덤처럼 쌓이지 않습니다. `/hypo:ingest`는 매번 구조화된 페이지를 만듭니다. 같은 주제를 다음에 인제스트하면 새 페이지를 만들지 않고 기존 페이지를 갱신합니다.
- 오래 쓸수록 밀도가 빠르게 높아집니다. 소스 100개가 단절된 페이지 100개로 끝나면 의미가 없습니다. 몇 달 쓰다 보면 페이지 수는 소스 증가보다 천천히 늘지만 교차 링크는 더 빠르게 늘어납니다.
- 맥락 전환이 없습니다. 어차피 Claude Code 안에서 일하는 중입니다. 위키는 슬래시 명령 한 줄로 닿습니다. 새 탭도, 다른 앱도, 추가 로그인도 없습니다.
- 저장 형식이 오래 살아남습니다. 평문 마크다운 + git은 20년 뒤에도 읽힙니다. 오프라인에서도 `grep`이 됩니다. 언제든 다른 도구로 옮길 수 있고, 아직 나오지 않은 미래의 AI 도우미도 변환 없이 그대로 읽습니다.

---

## 용어 사전

본문에서 반복해서 쓰는 용어를 한 표에 모았습니다. 읽다가 막히면 여기서 찾으세요.

| 용어 | Hypomnema에서의 뜻 |
|---|---|
| frontmatter(프런트매터) | 마크다운 페이지 맨 위의 YAML 블록. `title`, `type`, `tags` 같은 항목이 들어갑니다 |
| wikilink(위키링크) | `[[페이지-슬러그]]` 형태의 페이지 간 교차 참조. `lint`가 유효성을 확인합니다 |
| ADR | "Architecture Decision Record". 자명하지 않은 설계 결정을 _왜_ 했는지 짧게 적는 마크다운 페이지 |
| schema(스키마) | `SCHEMA.md`에 정의된 타입 분류와 필수 항목 규칙. 페이지가 유효한지 판단하는 기준 |
| lint | 읽기 전용 검증기(`hypomnema lint`). 프런트매터·위키링크·스키마를 한꺼번에 점검 |
| projection(투영) | 한 방향 자동 파생. `pages/feedback/*.md` → `MEMORY.md`와 CLAUDE.md `<learned_behaviors>` |
| 단일 원천(source of truth, SoT) | 사용자가 편집하는 단 하나의 파일. projection은 거기서만 파생되고 역방향은 막습니다 |
| 훅(hook) | Claude Code가 라이프사이클 이벤트(`SessionStart`, `Stop` 등)에 자동으로 실행하는 스크립트 |
| 라이프사이클 이벤트 | Claude Code가 플러그인에 알리는 시점. 세션 시작·프롬프트 제출·도구 사용·compact 요청·세션 종료 등 |
| `hot.md` | 프로젝트별 캐시. "방금 무엇을 했는지"(직전 세션의 핵심) |
| `session-state.md` | 프로젝트별 캐시. "다음에 무엇을 할지"(다음 세션 시작 때 주입되는 이어받기 데이터) |
| `.hypoignore` | 모든 콘텐츠 주입 훅과 `ingest`에서 제외할 경로(글롭 패턴) |
| 관측성 점수(observability score) | 세션별 측정값(ingest·query·session-close·citation 비율). 위키가 실제로 쓰였는지 보여줍니다 |
| manifest | 설치 스크립트가 쓰는 작은 JSON. 어떤 파일을 어떤 SHA로 설치했는지 기록 |
| `additionalContext` | Claude Code 훅이 프롬프트에 컨텍스트를 끼워 넣는 필드. 콘텐츠 주입 훅의 출력 위치 |
| 바이트 동일(byte-equal) | `--apply` 전후가 비트 단위로 같은 파일. "건드리지 않았다"의 가장 강한 보장 |
| BM25 | 고전적인 전문(全文) 랭킹 알고리즘. `/hypo:query`의 MISS 내성 검색을 담당 |
| Option C | `hypomnema upgrade --apply`가 사용자의 `SCHEMA.md`를 절대 덮어쓰지 않는 정책. 마이그레이션 보고서만 쓰고, 적용은 사용자가 직접 한다 |

이 표에 빠진 용어를 본문에서 만났다면 문서 버그입니다. 이슈를 남겨 주세요.

---

## 설계 결정

각 결정이 왜 이 모양인지.

### 1. 왜 청크 기반 RAG가 아니라 합성인가

RAG는 _낯선_ 코퍼스에 강합니다. 100만 페이지짜리 법률 아카이브를 주면 관련 단편을 잘 찾아냅니다. 그런데 _개인_ 지식의 실패는 정반대 지점에서 옵니다.

- 코퍼스가 작은 대신 중복이 많습니다(같은 주제의 글 3편).
- 사용자는 단편이 아니라 관점을 원합니다.
- 청크 수는 캡처에 비례해 선형으로 늘어납니다. 지식이 안 늘어도 그렇습니다.

Hypomnema는 청크가 아니라 페이지를 지식 단위로 봅니다. 새 소스는 관련 페이지가 있으면 갱신하고 없으면 새로 만듭니다. 결과물은 위키 문서처럼 읽힙니다. 실제로 위키 문서이기 때문입니다.

### 2. 왜 독자 포맷이 아니라 마크다운 + git인가

개인 지식 베이스는 특정 도구 하나보다 오래 살아남아야 합니다. 마크다운은 살아남습니다. git도 살아남습니다. 둘 다 어떤 LLM이든 읽고 오프라인에서 동작합니다. 30년치 도구 생태계가 받쳐 줍니다. 스택은 일부러 _지루하게_ 골랐습니다. 흥미로운 부분은 _그 위에서 Claude가 무엇을 하느냐_니까요.

### 3. 왜 수동 명령이 아니라 라이프사이클 훅인가

개인 지식 시스템은 사소한 마찰에 무너집니다. 생각 하나 저장하는 데 클릭이 세 번 필요하면 사람은 결국 안 하게 됩니다. Hypomnema는 Claude Code가 이미 일으키는 이벤트를 그대로 활용합니다.

| 이벤트 | 없으면 직접 해야 하는 일 |
|---|---|
| `SessionStart` | "어디까지 했더라?" `hot.md` / `session-state.md` 다시 읽기 |
| `UserPromptSubmit` | "이거 이미 정리해 뒀나?" BM25 룩업, top-3 주입 |
| `PreCompact` | "세션 정리는 했나?" 체크리스트 가드 |
| `PostToolUse` (Write/Edit) | `git add` |
| `Stop` | `git pull --rebase && git commit && git push` |

설치하고 나면 위키를 _관리_하는 일을 그만두게 됩니다. 그냥 쌓입니다.

### 4. 왜 재개에 `hot.md` 캐시를 쓰는가

멈춘 프로젝트에서 가장 비싼 건 일을 다시 하는 게 아니라 컨텍스트를 다시 쌓는 일입니다. `session-log/`를 처음부터 다시 읽으면 분 단위 시간과 토큰이 들지만, 한 페이지짜리 `hot.md`를 읽는 건 둘 다 거의 0입니다. 그래서 가장 최근 상태를 따로 캐싱합니다. `Stop`에서 다시 만들어 `SessionStart`에서 주입합니다. 재개는 O(1)입니다.

### 5. 왜 feedback → behavior 파이프라인인가

대부분의 AI 도구는 교정을 _지금 대화에 한해서만_ 받아들입니다. 다음으로 이어지지 않습니다. Hypomnema는 모든 `/hypo:feedback`을 `pages/feedback/`으로 흘려보냅니다. 오래 갈 규칙은 `CLAUDE.md`의 `<learned_behaviors>` 블록으로 승격합니다. 이후 모든 세션, 위키를 pull하는 모든 기기에서 살아 있습니다.

### 6. 왜 API 키도, 벡터 DB도, 외부 서비스도 없는가

외부 의존은 전부 언젠가 터질 위험입니다. 언젠가 깨지거나 인수되거나 단종되거나 자격증명이 샙니다. Hypomnema는 Node.js 스크립트 + 마크다운 파일 + git이 전부입니다. "AI" 부분은 Claude 자체뿐이고, 그건 어차피 켜져 있습니다.

### 7. 왜 privacy mode 플래그가 아니라 `.hypoignore`인가

v1.0에서는 `personal / shared / public` 3-mode를 만들었습니다. 현실과 부딪히자 바로 무너졌습니다. 모든 privacy 결정은 결국 _경로 단위_ 질문이었고, 그건 단일 파일(`.hypoignore`) 하나로 처리됩니다. v1.1에서 mode 개념을 통째로 지웠습니다. 파일 하나가 모든 결정을 담는 단일 원천 구조입니다.

---

## 기능

### 합성 명령어

9개 명령어가 캡처 → 검색 → 통합까지 전 과정을 담당합니다.

| 명령어 | 하는 일 | 언제 쓰나 |
|---|---|---|
| `/hypo:ingest` | 원본을 `sources/`에 보관하고 Claude가 `pages/`에 구조화된 페이지를 합성. 셸 헬퍼(`scripts/ingest.mjs`)는 읽기 전용이라 아직 인제스트 안 된 소스를 _목록만_ 출력 | 보관할 가치가 있는 글을 읽었을 때 |
| `/hypo:query` | BM25 검색 + LLM 합성 + `[[wikilink]]` 인용 | 자기 노트에 근거한 답이 필요할 때 |
| `/hypo:crystallize` | 세션 마무리 체크리스트(1~6단계) 실행. 요청하면 초안 합성(7~11단계)까지 | 단순하지 않은 세션을 마칠 때 |
| `/hypo:resume` | 활성 프로젝트의 가장 최근 세션 상태 불러오기 | 잠시 미뤄둔 프로젝트로 돌아올 때 |
| `/hypo:feedback` | AI 행동 교정을 기록. 영구 규칙 승격 후보가 됨 | Claude가 잘못했을 때, 또는 반대로 잘했을 때 |
| `/hypo:verify` | `verify_by` 프런트매터가 붙은 페이지를 점검 | 시간이 지나 옛 정보가 됐을 수 있을 때 |
| `/hypo:lint` | frontmatter·위키링크·스키마 검증 | 커밋 전, CI에서 |
| `/hypo:graph` | 위키링크 의존성 그래프 생성 | 구조가 어떻게 자랐는지 보고 싶을 때 |
| `/hypo:rename` | 페이지·디렉터리 이름 변경 + 인바운드 `[[위키링크]]` 갱신 | 페이지나 프로젝트 폴더 이름을 바꿀 때 |

### 라이프사이클 훅 (14개)

| 훅 | 이벤트 | 역할 |
|---|---|---|
| `hypo-session-start.mjs` | `SessionStart` | `hot.md` / `session-state.md` 주입 + `git pull --ff-only` |
| `hypo-first-prompt.mjs` | `UserPromptSubmit` | 마커 기반 일회성 `hot.md` 주입 (10분 TTL) |
| `hypo-lookup.mjs` | `UserPromptSubmit` | BM25 top-3 HIT 주입 / MISS면 가까운 슬러그 신호 |
| `hypo-compact-guard.mjs` | `UserPromptSubmit` | `/compact` 감지 시 session-close 체크리스트 강제 |
| `hypo-cwd-change.mjs` | `CwdChanged` | cwd에 맞는 프로젝트 `hot.md` 주입 |
| `hypo-file-watch.mjs` | `FileChanged` | 위키 파일 변경 알림 (`.hypoignore` 준수. 매칭 경로는 LLM 컨텍스트로 다시 주입하지 않음) |
| `hypo-auto-stage.mjs` | `PostToolUse(Write/Edit)` | 위키 파일 자동 stage |
| `hypo-auto-commit.mjs` | `Stop` | 자동 commit + pull + push |
| `hypo-hot-rebuild.mjs` | `Stop` | `hot.md` 재생성 |
| `hypo-personal-check.mjs` | `PreCompact` | lint 실패 또는 session-close 미완이면 compact 차단 |
| `hypo-session-end.mjs` | `SessionEnd` | SessionEnd 마커 기록. 다음 SessionStart가 `source=clear` 복구를 감지하게 함 |
| `hypo-session-record.mjs` | `Stop` | observability 점수 + auto-resume 신호용 세션 메타데이터 기록 |
| `hypo-auto-minimal-crystallize.mjs` | `Stop` | 단순하지 않은 세션이 끝나면 `/hypo:crystallize --apply-session-close --minimal`을 자동 제안 (동의하면 실행) |
| `hypo-web-fetch-ingest.mjs` | `PostToolUse(WebFetch/WebSearch)` | WebFetch/WebSearch 뒤 `additionalContext`에 `/hypo:ingest` 권유 주입 (URL의 query/hash/userinfo 제거) |

모든 훅은 위키 루트를 `HYPO_DIR` 환경변수 → `hypo-config.md` 스캔 → `~/hypomnema` 기본값 순으로 찾고, `hypo-shared.mjs`(`hooks.json`의 `shared` 필드로 선언)를 공유합니다.

이와 별도로 `SessionStart` 훅은 npm 레지스트리와 Claude Code 플러그인 마켓플레이스를 백그라운드에서 확인합니다(세션 시작을 막지 않습니다). 새 버전이 올라와 있으면 다음 세션 시작 때 "Update available!" 안내가 한 줄 뜹니다. `HYPO_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`을 주거나 `CI=true` 환경이면 건너뜁니다.

### 셋업 & 유지보수

| 명령어 | 목적 |
|---|---|
| `/hypo:init` | 최초 설치 (디렉터리, 훅, settings.json 병합, 첫 commit/push) |
| `/hypo:doctor` | 상태 점검 (훅, 경로, frontmatter, git) |
| `/hypo:upgrade` | 훅·설정을 최신 버전으로 마이그레이션 |
| `/hypo:uninstall` | 훅 및 등록 정보 제거 |
| `/hypo:stats` | 위키 통계 |
| `/hypo:audit` | observability 감사 (세션별 메트릭, 주간 보고서) |

### Claude Agent Skills

합성이 핵심인 명령어(`ingest`, `query`, `crystallize`, `lint`, `verify`, `graph`)는 `skills/<name>/SKILL.md`로도 등록돼 있습니다. 대화 내용이 해당 스킬의 `description`과 맞으면 Claude Agent Skills 메커니즘이 슬래시 명령 없이도 자동으로 호출합니다.

---

## 시나리오

A. 새 기술 학습.
Kubernetes 문서와 블로그 글을 읽는 중입니다. URL을 하나씩 `/hypo:ingest`에 넘깁니다. 세 번째 글쯤 되면 Claude가 새 페이지를 만드는 대신 기존 `kubernetes-networking.md`를 갱신하기 시작합니다. 일주일 뒤 `/hypo:query "pod CIDR 할당은 어떻게 동작하나요?"`를 돌리면 본인이 정리해 둔 노트를 인용한 합성 답이 돌아옵니다.

B. 엔지니어링 결정 추적.
중요한 변경을 머지하기 전에 설계 문서나 PR 설명을 `/hypo:ingest`로 처리합니다. Claude가 맥락·트레이드오프·결정이 담긴 ADR 스타일 페이지를 씁니다. 이후 `[[wikilink]]` 참조가 관련 프롬프트에 근거를 직접 주입합니다.

C. 연구 누적.
몇 주에 걸쳐 한 주제의 논문들을 읽습니다. `/hypo:ingest`가 논문을 합성하고 기존 페이지와 교차 연결합니다. 언제든 `/hypo:query`로 자기 노트에 근거한 문헌 리뷰 스타일 요약을 받습니다.

D. AI 행동 튜닝.
Claude가 잘못했을 때, 또는 반대로 잘했을 때 `/hypo:feedback`을 실행합니다. 교정 내용이 `pages/feedback/`에 저장되고 다음 세션 시작 때 자동으로 주입되므로 같은 실수가 반복되지 않습니다. 그 대화 한 번으로 끝나지 않고 세션이 바뀌어도 그대로 남습니다.

E. 멈춘 프로젝트 재개.
3주 손 놓았던 프로젝트로 돌아옵니다. 다음 세션 시작 때 `hypo-session-start.mjs`가 `projects/<name>/session-state.md`를 읽어 "다음 작업"과 최근 결정을 컨텍스트에 주입합니다. 첫 프롬프트를 치기 전에 이미 업무 파악이 끝나 있습니다.

---

## 위키에 저장할 것 / 저장하지 말 것

저장할 것:

- 외부 소스(문서, 논문, 강연)에서 합성한 지식
- 아키텍처 결정과 근거
- AI 행동 교정 및 선호
- git에 담기 어려운 프로젝트 컨텍스트 (이해관계자 제약, 미결 질문, 배경)
- 연구 결과 및 교차 소스 비교

저장하지 말 것:

- 원본 소스 자료. `sources/`에 자동·미편집으로 보관됩니다
- 자격증명·토큰·비밀. `.hypoignore`로 민감 경로를 제외하세요
- 이번 세션의 일시적 작업 목록. 대화 안의 작업 목록을 쓰세요
- 레포에서 도출되는 코드 패턴. `git log`, `grep`이 원본 기준입니다
- 관리 주체가 따로 있는 정보 (Jira, Confluence, API 문서). 미러가 아니라 _합성본_만 인제스트하세요

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

위키 경로는 다음 순서로 찾습니다 (`scripts/lib/hypo-root.mjs` 참조).

| 우선순위 | 출처 |
|---|---|
| 1 | `--hypo-dir=<path>` CLI 플래그 (스크립트 단위 오버라이드. 이 플래그를 받는 스크립트에서만 동작) |
| 2 | `HYPO_DIR` 환경변수 |
| 3 | 홈 기준 후보(`~/hypomnema`, `~/wiki`, `~/notes`, `~/knowledge`, `~/Documents/{hypomnema,wiki,notes}`)에서 `hypo-config.md` 마커 발견 |
| 4 | 기본값: `~/hypomnema` |

위키 루트에 `hypo-config.md`를 두면 환경변수 없이도 다른 기기로 옮겨 쓸 수 있습니다.

`.hypoignore`는 훅이 무시할 경로를 정합니다 (기본: `*.pdf`, `*.zip`, `*.pem`, `*.env` 등). 직접 편집하면 됩니다. privacy mode 플래그는 없습니다. 파일 하나가 모든 결정을 담는 단일 원천 구조입니다.

> 모델 사업자에게 전송되는 범위: Hypomnema 훅은 위키 본문을 Claude Code의 추가 컨텍스트(`additionalContext`)에 실어 보내고, 이 내용은 프롬프트의 일부로 Claude 모델 사업자에게 전송됩니다. `.hypoignore`에 등록된 경로는 모든 주입 훅(`hypo-file-watch`, `hypo-session-start`, `hypo-cwd-change`, `hypo-lookup`)과 `ingest`에서 제외되지만, 등록하지 _않은_ 파일은 전송 대상입니다. (`hypo-auto-stage`/`hypo-auto-commit`은 git 스테이징용 훅이라 컨텍스트를 주입하지는 않지만, 스테이징 판단에도 `.hypoignore`를 참고합니다.) 비밀 정보는 위키에 두지 마시고, `HYPO_DIR` 아래에 민감한 내용을 저장하기 전에 `.hypoignore` 패턴을 먼저 점검하세요.

> git sync 범위: Hypomnema는 `~/hypomnema/` 위키 자체만 git sync합니다. 단 `init` / `upgrade`는 `~/.claude/` 안의 관리 대상 영역(Hypomnema 자체 hook `~/.claude/hooks/`, 슬래시 커맨드 `~/.claude/commands/hypo/`, `settings.json` 등록)을 설치·SHA 추적하고, v1.2.0 extensions companion sync로 위키의 `~/hypomnema/extensions/`에 둔 `agents/`·`commands/`·`hooks/`·`skills/`도 자동 미러링합니다(`--codex`면 `hooks`·`commands` 부분집합만 `~/.codex/`로). 이 관리 대상 _바깥_의 `~/.claude/` 콘텐츠는 일부러 관리하지 않습니다. 위키를 거치지 않는 기타 agent/skill, 머신 고유 `settings.local.json` 같은 일반 Claude Code 설정의 기기 간 동기화는 [chezmoi](https://www.chezmoi.io/) 같은 별도 dotfiles 매니저를 권합니다.

### `/hypo:*` 커맨드는 어디서 오는가

| 설치 경로 | 슬래시 커맨드 위치 |
|---|---|
| 플러그인 (Path A) | Claude Code 플러그인 캐시. `/plugin marketplace update hypomnema` 후 `/reload-plugins`로 갱신 |
| npm CLI (Path B) | `~/.claude/commands/hypo/`. `hypomnema upgrade --apply`로 갱신, 파일별 SHA 추적. 사용자 수정본까지 덮어쓰려면 `--force-commands`(원본은 `.bak`으로 보존) |

---

## 요구 사항

- Node.js ≥ 18 (18 / 20 / 22 검증됨)
- Claude Code CLI

외부 서비스·API 키·벡터 DB 모두 필요 없습니다.

---

## 상태

- 테스트: `npm test` 참조. 테스트가 추가될 때마다 개수가 바뀌므로, 정확한 기준은 테스트 러너입니다
- CI: 7개 독립 job (test matrix, lint, init/upgrade snapshots, replay, hypo-absent, uninstall-smoke)
- 릴리스: `v*` 태그 push 시 `npm publish --provenance` 자동 실행

---

## 문서

- [ARCHITECTURE.md](docs/ARCHITECTURE.md): 내부 구조, 컴포넌트 맵, 데이터 흐름
- [CONTRIBUTING.md](docs/CONTRIBUTING.md): 개발 환경 설정, 컨벤션, PR 프로세스
- [CHANGELOG.md](CHANGELOG.md): 릴리스 히스토리

---

## 라이선스

MIT
