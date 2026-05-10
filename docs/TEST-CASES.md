# Hypomnema — 완성본 테스트 케이스

> 이 문서는 BACKLOG.md 갭 분석을 기반으로 작성된 인수 테스트 케이스다.  
> 각 케이스는 **설정(Given) → 실행(When) → 기대 결과(Then)** 형식으로 기술한다.  
> 자동화 가능 항목은 `[AUTO]`, 수동 검증 항목은 `[MANUAL]`로 표시한다.

---

## TC-01. `/hypo:init` — 기본 설치

### TC-01-1. 빈 디렉토리 0-config 설치 [AUTO]

**Given**: 빈 디렉토리 `/tmp/wiki-test-01`  
**When**: `node scripts/init.mjs --wiki-dir=/tmp/wiki-test-01 --no-hooks --no-git-init`  
**Then**:
- `pages/`, `projects/`, `sources/` 디렉토리 존재
- `hypo-config.md` 존재 (root marker)
- `index.md`, `hot.md`, `log.md`, `SCHEMA.md`, `wiki-guide.md` 존재
- `.wikiignore` 존재
- `privacy: personal` (기본값) 포함됨
- 이미 존재하는 파일은 덮어쓰지 않음 (idempotent)

### TC-01-2. journal 디렉토리 및 추가 템플릿 생성 [AUTO]

**Given**: 빈 디렉토리  
**When**: `node scripts/init.mjs --wiki-dir=/tmp/wiki-test-01b --no-hooks --no-git-init`  
**Then**:
- `journal/daily/`, `journal/weekly/`, `journal/monthly/` 존재
- `Home.md`, `Overview.md`, `wiki-automation.md`, `hypo-help.md` 복사됨
- `pages/_index.md` 존재
- `projects/_template/` 구조 존재

### TC-01-3. Privacy 모드별 `.wikiignore` 차등 적용 [AUTO]

| 모드 | `*personal*` | `journal/` | `sources/` | `drafts/` |
|---|---|---|---|---|
| `personal` | ✗ | ✗ | ✗ | ✗ |
| `shared` | ✓ | ✓ | ✗ | ✗ |
| `public` | ✓ | ✓ | ✓ | ✓ |

**When**: 각 모드로 init 실행  
**Then**: `.wikiignore`에 해당 패턴 포함/미포함 확인

### TC-01-4. Privacy boundary 안내 출력 [MANUAL]

**Given**: `/hypo:init` Claude 커맨드 실행  
**When**: privacy mode 선택 단계  
**Then**: 다음 내용의 안내문이 출력됨:
```
Privacy boundary: Wiki files are stored locally on your machine.
However, when Claude reads wiki pages via hooks or commands,
that content is sent to Anthropic's API as part of the conversation context.
```

### TC-01-5. Git remote 설정 + first commit + push [AUTO]

**Given**: git remote URL 입력  
**When**: `node scripts/init.mjs --wiki-dir=/tmp/wiki-git --git-remote=<url>`  
**Then**:
- `.git/` 존재
- `git remote get-url origin` = 입력한 URL
- `git log --oneline` 에 `init: hypomnema wiki` 커밋 존재
- `git status` clean (push 완료)

### TC-01-6. Dry-run 모드 [AUTO]

**When**: `node scripts/init.mjs --wiki-dir=/tmp/wiki-dry --dry-run --no-hooks --no-git-init`  
**Then**:
- 출력에 `[DRY RUN — no changes made]` 포함
- `/tmp/wiki-dry` 디렉토리 미생성

### TC-01-7. Idempotent 재실행 [AUTO]

**When**: 동일 경로에 init 2회 실행  
**Then**:
- 기존 파일 내용 변경 없음
- 두 번째 실행 결과에 `⊘ Skipped` 항목만 나타남

### TC-01-8. Hooks 설치 후 `~/.claude/settings.json` 병합 [AUTO]

**When**: `node scripts/init.mjs` (hooks 활성화)  
**Then**:
- `~/.claude/hooks/` 에 모든 `.mjs` 훅 파일 존재
- `~/.claude/settings.json`의 `hooks` 객체에 hypo 훅 항목 추가됨
- 기존 비-hypo 훅 항목은 보존됨

---

## TC-02. Plugin 검증

### TC-02-1. `claude plugin validate .` 오류 0건 [AUTO]

**When**: `claude plugin validate .` (프로젝트 루트에서)  
**Then**: 오류 0건, 경고만 허용

### TC-02-2. hooks.json 스키마 형식 [AUTO]

**Given**: `hooks/hooks.json`  
**Then**: 각 이벤트 항목이 다음 형식을 따름:
```json
{
  "hooks": [
    { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.mjs" }
  ]
}
```
(raw string 배열 형식 `["file.mjs"]` 사용 금지)

### TC-02-3. skills/ 구조 호환성 [AUTO]

**Then**: `skills/` 디렉토리가 플러그인 문서의 skill 배포 스펙과 일치  
(flat `*.md` 또는 `<name>/SKILL.md` 중 결정된 방식 준수)

---

## TC-03. `/hypo:ingest` — 소스 인제스트

### TC-03-1. 신규 소스 인제스트 [MANUAL]

**Given**: 빈 위키 (`index.md` 비어있음)  
**When**: `/hypo:ingest` 실행 → URL 또는 텍스트 입력  
**Then**:
- `sources/<slug>.<ext>` 에 원본 내용 저장 (수정 없음)
- `pages/<slug>.md` 생성 (합성본, 원본 복사 아님)
- frontmatter에 `type: source-summary`, `source: <slug>`, `confidence:`, `evidence_strength: direct` 포함
- `index.md`에 `[[pages/<slug>]]` 항목 추가됨
- `log.md`에 ingest 항목 추가됨

### TC-03-2. 기존 페이지가 있을 때 업데이트 [MANUAL]

**Given**: `pages/kubernetes-networking.md` 이미 존재  
**When**: 동일 주제 소스 인제스트  
**Then**:
- 기존 파일 덮어쓰기가 아닌 내용 병합
- `updated:` 필드가 오늘 날짜로 갱신
- 기존 내용 보존됨 (레거시 내용 유실 없음)
- `sources/` 에 새 소스 별도 저장

### TC-03-3. 레거시 페이지 append/update 시 기존 기록 보존 [MANUAL]

**Given**: `verify_by_date`가 만료된 기존 페이지  
**When**: 동일 주제 새 소스 인제스트  
**Then**:
- 기존 섹션에 `> [2026-MM-DD update]` 형태로 변경 내용 append
- 기존 내용 삭제 없음
- `verify_by_date` 갱신됨

### TC-03-4. 孤兒 소스(orphaned source) 처리 [MANUAL]

**Given**: `sources/`에 페이지 미생성 소스 존재  
**When**: `/hypo:ingest` 실행  
**Then**: "N개의 미처리 소스가 있습니다 — 먼저 인제스트하시겠습니까?" 안내 출력

---

## TC-04. wiki-lookup 훅 — 위키 검색 자동 주입

### TC-04-1. BM25 hit — 관련 페이지 주입 [AUTO]

**Given**: `pages/kubernetes-networking.md` 존재  
**When**: `echo '{"prompt":"kubernetes pod CIDR 할당"}' | node hooks/wiki-lookup.mjs`  
**Then**:
- 출력에 `[WIKI LOOKUP: 1 page(s) matched]` 포함
- 페이지 내용(최대 2000자) 주입됨
- `continue: true`

### TC-04-2. BM25 miss — 리서치 권유 메시지 [AUTO]

**Given**: 위키에 관련 페이지 없음  
**When**: `echo '{"prompt":"zk-SNARKs 영지식 증명"}' | node hooks/wiki-lookup.mjs`  
**Then**:
- 출력에 `[WIKI LOOKUP: miss]` 포함
- "리서치 후 /hypo:ingest 로 저장을 권장합니다" 메시지 포함
- 가장 가까운 slug 3개 표시
- `continue: true`

### TC-04-3. hit — verify_by_date 만료 경고 [AUTO]

**Given**: `verify_by_date`가 과거인 페이지 존재  
**When**: 해당 주제 프롬프트  
**Then**: 주입된 내용에 `⚠ 이 페이지는 verify_by_date가 만료됐습니다` 경고 포함

### TC-04-4. `.wikiignore` 패턴 파일 제외 [AUTO]

**Given**: `.wikiignore`에 `*private*` 패턴 존재, `pages/my-private-notes.md` 존재  
**When**: 관련 키워드 프롬프트  
**Then**: 해당 페이지 주입 안됨

### TC-04-5. 빈 프롬프트 / 키워드 없음 [AUTO]

**When**: `echo '{"prompt":""}' | node hooks/wiki-lookup.mjs`  
**Then**: `{"continue": true, "suppressOutput": true}` (오류 없이 통과)

---

## TC-05. 세션 종료 커맨드 (session-close)

### TC-05-1. session-state.md 업데이트 [MANUAL]

**When**: 세션 종료 커맨드 실행  
**Then**:
- `projects/<name>/session-state.md`의 "다음 이어받기" 항목이 현재 세션 결과 반영
- 완료된 태스크는 `[x]` 처리
- 신규 미결 항목 추가

### TC-05-2. hot.md 갱신 [MANUAL]

**Then**: `projects/<name>/hot.md`에 직전 세션 요약 (~500자) 갱신

### TC-05-3. ingest 대상 소스 안내 [MANUAL]

**Given**: 세션 중 신뢰할 만한 외부 지식 습득  
**Then**: "인제스트할 소스가 있습니까?" 안내 → `/hypo:ingest` 흐름 연결

### TC-05-4. commit/push 상태 확인 [MANUAL]

**Then**: git status 확인 → unstaged 변경 있으면 경고 출력

---

## TC-06. `/hypo:verify` — 페이지 최신성 검증

### TC-06-1. 만료 페이지 감지 [AUTO]

**Given**: `verify_by_date: 2026-01-01`이 포함된 페이지  
**When**: `node scripts/verify.mjs --wiki-dir=<path> --due`  
**Then**: 해당 페이지가 만료 목록에 포함됨

### TC-06-2. Claude API 의미론적 판정 [MANUAL]

**Given**: `ANTHROPIC_API_KEY` 설정됨, `verify_by: "이 내용은 아직 유효한가?"` 포함 페이지  
**When**: `node scripts/verify.mjs --wiki-dir=<path> --model=haiku`  
**Then**:
- Claude Haiku 호출로 YES/NO 판정
- NO 판정 시 `pages/open-questions.md`에 해당 항목 append
- 결과에 `confidence: high|medium|low` 포함

### TC-06-3. API key 없을 때 graceful exit [AUTO]

**When**: `ANTHROPIC_API_KEY` 미설정 상태로 실행  
**Then**: 오류 메시지 출력 후 exit code 1 (프로그램 crash 없음)

---

## TC-07. `/hypo:lint` — 구조 검사

### TC-08-1. `commands/lint.md` 커맨드 존재 [MANUAL]

**When**: Claude에서 `/hypo:lint` 실행  
**Then**: `scripts/lint.mjs` 호출됨, 결과 출력됨

### TC-07-2. Blocker 감지 [AUTO]

**Given**: frontmatter에 `title:` 없는 페이지  
**When**: `node scripts/lint.mjs`  
**Then**: `B1` blocker 항목에 해당 파일 표시, exit code 1

### TC-07-3. `.wikiignore` 패턴 파일에 민감 정보 → B5 blocker [AUTO]

**Given**: `sources/credentials.pem` 존재 (`.wikiignore`에 `*.pem` 패턴)  
**Then**: B5 blocker 발생

### TC-07-4. Warning 항목 (non-blocking) [AUTO]

**Given**: `verify_by_date`가 6개월 이상 지난 페이지  
**Then**: W 항목에 표시되나 exit code 0

### TC-07-5. lint 결과 0 blockers 유지 [AUTO]

**When**: `npm run lint`  
**Then**: blockers 0건

---

## TC-08. `/hypo:lint-llm` — L2 의미론적 검사 (nightly)

### TC-08-1. Haiku 판정 실행 [AUTO]

**Given**: `ANTHROPIC_API_KEY` 설정됨  
**When**: `node scripts/lint-llm.mjs --wiki-dir=<path> --json`  
**Then**:
- `ok: true`
- `results` 배열에 페이지별 판정 결과 포함
- `note: "LLM evaluation pass not yet implemented"` 메시지 없음 (스텁 제거됨)

### TC-08-2. API key 없을 때 graceful [AUTO]

**When**: API key 미설정  
**Then**: `{"ok": false, "error": "lint-llm requires ANTHROPIC_API_KEY ..."}` 출력, exit 1

---

## TC-09. `/hypo:doctor` — 설치 상태 점검

### TC-09-1. 정상 설치 상태 [MANUAL]

**Given**: init 완료 후  
**When**: `/hypo:doctor`  
**Then**:
- ✓ Wiki root 탐지 (`hypo-config.md` 존재)
- ✓ 훅 설치 상태 (모든 훅 파일 존재)
- ✓ SCHEMA 버전
- ✓ lint blockers 0
- ✓ git remote 설정 (설정된 경우)

### TC-09-2. 미설치 항목 감지 [MANUAL]

**Given**: 훅 파일 일부 삭제  
**Then**: ✗ 항목으로 표시 + 재설치 안내

---

## TC-10. `/hypo:upgrade` — 버전 업그레이드

### TC-10-1. JSON 출력 필수 필드 [AUTO]

**When**: `node scripts/upgrade.mjs --wiki-dir=<path> --json`  
**Then**: 출력 JSON에 `schema`, `hooks`, `settings`, `applied` 필드 존재  
`applied.hooks`와 `applied.settings`가 배열

### TC-10-2. 사용자 파일 보존 [AUTO]

**Given**: 기존 `pages/my-notes.md` 존재  
**When**: upgrade 실행  
**Then**: `my-notes.md` 내용 변경 없음

### TC-10-3. Dry-run 먼저 출력 [MANUAL]

**Then**: diff 출력 → 사용자 confirm → 실제 적용 순서

---

## TC-11. `/hypo:uninstall` — 제거

### TC-11-1. settings.json에서 hypo 훅만 제거 [AUTO]

**Given**: settings.json에 hypo 훅 3개 + 비-hypo 훅 2개  
**When**: `node scripts/uninstall.mjs`  
**Then**:
- hypo 훅 3개 제거됨
- 비-hypo 훅 2개 보존됨
- `~/.claude/hooks/wiki-*.mjs` 파일 삭제됨

### TC-11-2. Dry-run 기본값 [AUTO]

**When**: `node scripts/uninstall.mjs` (--dry-run 없이)  
**Then**: `[DRY RUN]` 모드로 동작, 실제 파일 삭제 없음

---

## TC-12. Git 동기화

### TC-12-1. SessionStart — git pull [AUTO]

**Given**: 원격 레포에 새 커밋 존재, wiki-session-start.mjs 실행  
**When**: `echo '{"cwd":"/some/project"}' | node hooks/wiki-session-start.mjs`  
**Then**:
- `git pull` 실행됨
- pull 결과(`pulled N commits` 또는 `up to date`)가 additionalContext에 포함됨

### TC-12-2. SessionStart — remote 없을 때 pull 생략 [AUTO]

**Given**: git remote 없는 위키  
**Then**: pull 생략, 오류 없이 계속 진행

### TC-12-3. Stop 훅 — 자동 commit + push [AUTO]

**Given**: 위키 파일 수정됨, remote 존재  
**When**: `node hooks/wiki-auto-commit.mjs`  
**Then**:
- `git add -A` → `git commit` → `git pull --no-rebase` → `git push` 순서
- commit 메시지: `auto: YYYY-MM-DD wiki update`
- staged 없으면 commit 생략, push만

### TC-12-4. init — first commit + push [AUTO]

**Given**: git remote 설정됨  
**When**: init 완료  
**Then**: `git log --oneline` 에 `init: hypomnema wiki` 커밋 존재, 원격에 push됨

---

## TC-13. Lifecycle 훅 — 세션 시작/종료

### TC-13-1. SessionStart — 프로젝트 hit (hot.md + session-state.md 주입) [AUTO]

**Given**: `projects/my-project/index.md`에 `working_dir: /path/to/project`  
**When**: `echo '{"cwd":"/path/to/project"}' | node hooks/wiki-session-start.mjs`  
**Then**:
- 출력에 `[WIKI HOT CACHE: project=my-project]` 포함
- hot.md 내용 (최대 2000자) 주입됨
- session-state.md 내용 (최대 1000자) 주입됨
- terminal에 프로젝트 이름 + next 작업 출력됨 (stderr)

### TC-13-2. SessionStart — 프로젝트 miss (global hot.md 주입) [AUTO]

**Given**: cwd가 어떤 project의 working_dir도 아닌 경우  
**When**: `echo '{"cwd":"/unrelated/path"}' | node hooks/wiki-session-start.mjs`  
**Then**: `[WIKI HOT CACHE: global — no project matched cwd=...]` 포함

### TC-13-3. wiki-compact-guard — /compact 차단 [AUTO]

**When**: `echo '{"prompt":"/compact"}' | HYPO_DIR=/tmp/no-wiki node hooks/wiki-compact-guard.mjs`  
**Then**: `additionalContext`에 세션 close 체크리스트 안내 포함, `continue: true`

### TC-13-4. wiki-compact-guard — 일반 프롬프트 통과 [AUTO]

**When**: `echo '{"prompt":"hello world"}' | node hooks/wiki-compact-guard.mjs`  
**Then**: `{"continue": true, "suppressOutput": true}` (차단 없음)

### TC-13-5. personal-wiki-check — HYPO_SKIP_GATE=1 통과 [AUTO]

**When**: `echo '{}' | HYPO_SKIP_GATE=1 node hooks/personal-wiki-check.mjs`  
**Then**: `{"continue": true, "suppressOutput": true}`

### TC-13-6. personal-wiki-check — 위키 없을 때 block [AUTO]

**When**: `echo '{}' | HYPO_DIR=/tmp/no-wiki-xxx node hooks/personal-wiki-check.mjs`  
**Then**: `{"decision": "block", ...}` (compact 차단)

### TC-13-7. wiki-auto-stage — 위키 파일 수정 후 자동 스테이징 [AUTO]

**Given**: `pages/test.md` 수정  
**When**: PostToolUse 훅 실행  
**Then**: `git -C <wiki> status --porcelain` 에 해당 파일이 staged 상태

### TC-13-8. CwdChanged — 다른 프로젝트 전환 시 context 재주입 [AUTO]

**Given**: project-A → project-B로 cwd 변경  
**When**: `echo '{"cwd":"/path/to/project-b"}' | node hooks/wiki-cwd-change.mjs`  
**Then**: project-B의 hot.md 주입됨, project-A context 미포함

### TC-13-9. 동일 프로젝트 subdirectory 이동 시 false re-injection 방지 [AUTO]

**Given**: `/project/src` → `/project/tests` 이동 (같은 프로젝트)  
**Then**: 동일 프로젝트 중복 주입 없음

---

## TC-14. OMC 의존성 제거 검증

### TC-14-1. `OMC_SKIP_WIKI_GATE` 참조 0건 [AUTO]

**When**: `grep -r 'OMC_SKIP_WIKI_GATE' hooks/ scripts/ tests/`  
**Then**: 결과 없음 (0건)

### TC-14-2. `OMC|oh-my-claude` 참조 0건 (정책 합의 범위 내) [AUTO]

**When**: `grep -ri 'oh-my-claude\|omc-teams\|omc skill' hooks/ scripts/ docs/ commands/ skills/`  
**Then**: 결과 없음

### TC-14-3. OMC-absent 환경에서 전체 테스트 통과 [AUTO]

**When**:
```bash
env -i HOME=$HOME PATH=$PATH \
  HYPO_SKIP_GATE="" OMC_SKIP_WIKI_GATE="" OMC_SKIP_HOOKS="" HYPO_DIR="" \
  npm test
```
**Then**: 51/51 (또는 그 이상) PASS

---

## TC-15. Privacy 보호

### TC-15-1. `.wikiignore` 패턴 파일이 hook context에 포함되지 않음 [AUTO]

**Given**: `pages/my-private-notes.md`, `.wikiignore`에 `*private*`  
**When**: wiki-lookup.mjs, wiki-session-start.mjs 실행  
**Then**: `my-private-notes.md` 내용이 additionalContext에 없음

### TC-15-2. `.wikiignore` 패턴 파일이 lint.mjs에서 스킵됨 [AUTO]

**When**: `node scripts/lint.mjs`  
**Then**: `.wikiignore` 매칭 파일은 lint 대상에서 제외됨

### TC-15-3. sources/에 민감 파일 → B5 blocker [AUTO]

**Given**: `sources/aws-credentials.pem` (`.wikiignore`에 `*.pem`)  
**When**: `node scripts/lint.mjs`  
**Then**: B5 blocker 발생, exit 1

---

## TC-16. CI 검증

### TC-16-1. 전체 CI jobs green [AUTO]

**When**: main 브랜치 push  
**Then**: 다음 jobs 모두 green:
- `test` (Node 18, 20, 22)
- `lint-runner`
- `init-snapshot`
- `upgrade-snapshot`
- `privacy` (personal, shared, public)
- `replay`
- `omc-absent` (Node 18, 20, 22)
- `uninstall` (신규)

### TC-16-2. nightly verify-pages [AUTO]

**When**: nightly 실행 (또는 `workflow_dispatch`)  
**Then**: `verify-pages` job 실행됨, `ANTHROPIC_API_KEY` 없으면 skip (graceful)

### TC-16-3. nightly llm-lint [AUTO]

**Given**: `ENABLE_LLM_LINT=true`, `ANTHROPIC_API_KEY` 설정  
**Then**: `llm-lint` job 실행, `ok: true` 반환

---

## TC-17. `/hypo:query` — 질의 응답

### TC-17-1. 근거 있는 답변 + wikilink 인용 [MANUAL]

**Given**: 관련 페이지 3개 존재  
**When**: `/hypo:query "pod CIDR 할당은 어떻게 동작하나요?"`  
**Then**:
- 답변에 `[[page-slug]]` 형식의 인용 포함
- 페이지 내용에 없는 추정 내용 없음 (근거 기반)

### TC-17-2. 관련 페이지 없을 때 솔직한 미답변 [MANUAL]

**Given**: 위키에 관련 내용 없음  
**Then**: "관련 위키 페이지가 없습니다" 안내 + 인제스트 권유

---

## TC-18. `/hypo:crystallize` — 지식 합성

### TC-18-1. 태그 클러스터 합성 [MANUAL]

**Given**: `kubernetes` 태그 페이지 5개 분산  
**When**: `/hypo:crystallize` → 태그 클러스터 선택  
**Then**:
- `pages/syntheses/kubernetes.md` 생성 (`type: synthesis`)
- 각 페이지에 `[[syntheses/kubernetes]]` backlink 추가
- `index.md` 업데이트

### TC-18-2. 세션 종료와 crystallize 혼동 없음 [MANUAL]

**When**: `/hypo:crystallize` 실행  
**Then**: 세션 close 체크리스트(session-state 업데이트, hot.md 갱신 등)를 실행하지 않음  
→ 세션 종료는 별도 커맨드로 분리

---

## TC-19. stats / graph

### TC-19-1. `/hypo:stats` — 핵심 지표 출력 [MANUAL]

**Then**: 다음 지표 포함:
- 총 페이지 수
- link density (페이지당 평균 outbound link)
- orphan count
- broken link count
- stale page count (`verify_by_date` 만료)
- hot-cache freshness
- source/week (최근 4주 ingest 속도)

### TC-19-2. `/hypo:graph` — JSON 생성 [AUTO]

**When**: `node scripts/graph.mjs --wiki-dir=<path>`  
**Then**: `graph.json` 생성, `nodes`/`edges` 배열 포함

---

## TC-20. 외부 사용자 dogfooding (E2E)

### TC-20-1. 완전 신규 설치 → 첫 인제스트 → 쿼리 [MANUAL]

**Given**: Hypomnema 미설치 환경 (다른 macOS 머신 또는 VM)  
**When**:
1. `npm install -g hypomnema` 또는 `npx hypomnema`
2. `/hypo:init` (remote URL 입력)
3. URL 하나 `/hypo:ingest`
4. `/hypo:query` 로 방금 인제스트한 내용 질의

**Then**:
- 각 단계 오류 없음
- 쿼리 결과가 인제스트한 내용을 근거로 답변
- Claude Code 재시작 후 훅이 자동으로 동작

### TC-20-2. OMC 미설치 환경 [MANUAL]

**Given**: OMC(`oh-my-claudecode`) 설치 안 된 환경  
**Then**: 모든 `/hypo:*` 커맨드 정상 동작, OMC 관련 오류 없음

---

## 부록 A. 테스트 환경 설정

```bash
# 테스트용 임시 wiki 디렉토리
export TEST_WIKI=/tmp/hypo-test-$(date +%s)

# OMC-absent 환경
env -i HOME=$HOME PATH=$PATH HYPO_DIR=$TEST_WIKI npm test

# plugin 검증
claude plugin validate .

# 전체 CI 로컬 실행
npm test && npm run lint
```

## 부록 B. 테스트 픽스처 위치

| 픽스처 | 경로 |
|---|---|
| hook replay 픽스처 | `tests/fixtures/hooks/` |
| lint 케이스 픽스처 | `tests/fixtures/lint/` |
| init snapshot | `tests/fixtures/init/` |
| e2e PreCompact 시나리오 | `tests/fixtures/e2e/` |

## 부록 C. 합격 기준 (DoD)

| 항목 | 기준 |
|---|---|
| `npm test` | 전체 PASS (0 fail) |
| `npm run lint` | blocker 0건 |
| `claude plugin validate .` | 오류 0건 |
| CI all jobs | green |
| OMC 참조 | 0건 (정책 합의 범위 내) |
| 외부 dogfooding | 1인 이상 PASS |
| README "로컬 저장" vs Git-sync | 모순 없음 |
