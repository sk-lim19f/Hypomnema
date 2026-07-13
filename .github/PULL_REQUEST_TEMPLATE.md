<!--
Thanks for the PR. The sections below map to the PR checklist in
docs/CONTRIBUTING.md.

PR title: Conventional Commits plus a scope, e.g.
`feat(feedback): add failure_type enum`. Keep any internal tracker id
(FEAT-/IMPR-/ISSUE-/PRAC-) out of the title and body.

Body language: write the full body TWICE, once under `# English` and once
under `# 한국어` (this repo ships bilingual docs). The `## Changelog` and
`## Checklist` blocks are language-neutral, so they appear once, after both
blocks. Do NOT add a tool-attribution footer or a session URL of any kind.
-->

# English

## What changed

<!-- Short summary. What does this PR do? -->

## Why

<!-- User-visible motivation. What problem does this solve? -->

## How

<!-- Brief notes on the approach: only the parts that aren't obvious from the diff. -->

## Manual verification

<!--
Anything the test suite cannot cover. Required if you changed:
- a hook (run /hypo:upgrade and verify the hook fires in a real session)
- hooks/hypo-shared.mjs (verify the deployed copy works)
- a template or init flow (run a fresh init and inspect the vault)
Paste the exact commands you ran and what you observed.
-->

## Migration notes

<!-- If existing installs need special handling on upgrade, describe the path. Otherwise: "None". -->

---

# 한국어

## 변경 내용

<!-- 짧은 요약. 이 PR이 무엇을 하나? -->

## 이유

<!-- 사용자에게 보이는 동기. 어떤 문제를 푸나? -->

## 방법

<!-- 접근에서 diff만으로 드러나지 않는 부분만. -->

## 수동 검증

<!--
테스트가 못 잡는 부분. 다음을 바꿨으면 필수:
- 훅 (/hypo:upgrade 후 실제 세션에서 훅이 발화하는지 확인)
- hooks/hypo-shared.mjs (배포된 사본이 동작하는지 확인)
- 템플릿이나 init 흐름 (fresh init으로 볼트 구조 확인)
실행한 명령과 관찰 결과를 그대로 붙여넣으세요.
-->

## 마이그레이션 노트

<!-- 기존 설치가 업그레이드 시 특별 처리가 필요하면 경로를 기술. 없으면 "None". -->

---

## Changelog

<!--
One English line plus one Korean line, only if the change is user-visible.
The release collector gathers these into CHANGELOG.md at release time, so
you do NOT edit CHANGELOG.md directly in this PR. Internal-only change
(refactor with no user-visible effect, test-only, CI plumbing)? Write
"None" and skip the lines.

Rules:
- Reference the PR by number only (`#123`). No internal tracker ids
  (FEAT-/IMPR-/ISSUE-/PRAC-) on this public surface.
- No em dashes. Use a colon, comma, or parentheses.
- The section is inferred from your Conventional Commit type: feat -> New
  Features, fix -> Bug Fixes, everything else (chore/refactor/docs/ci) ->
  Chores. See docs/CONTRIBUTING.md for the full mapping.
-->

- EN:
- KO:

## Checklist

- [ ] `npm test` passes locally
- [ ] `npm run lint` passes locally
- [ ] README / ARCHITECTURE / docs updated if user-facing behavior changed
- [ ] Filled the `## Changelog` block above (EN + KO line) if the change is user-visible
- [ ] Wrote the body in both `# English` and `# 한국어` blocks
- [ ] No tool-attribution footer in the body
- [ ] One logical change per PR (rebase / split if necessary)
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, …)
