// tests/close-signals.test.mjs
//
// One area, one file, one selection unit per suite. Tests inside a suite may
// build on each other; suites may not — that is what lets the runner shard.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test, suite } from './harness.mjs';
import {
  REPO,
  askCloseReconfirmToolUse,
  buildOutput,
  closeFileTargets,
  detectSessionCloseArtifact,
  extractUserMessages,
  gitRepo,
  hasMutatingTranscriptActivity,
  hasPendingBackgroundWork,
  isCloseGateOpen,
  isClearCommand,
  isClosePattern,
  isCloseReconfirmDeclined,
  isCloseRetractionPattern,
  isCompactCommand,
  isCompactOrClearCommand,
  isGateSkipped,
  isOverdueDate,
  isSubstantialSession,
  pageUsageGuardCachePath,
  pageUsageLoggingAllowed,
  partitionLintScope,
  resolveTranscriptBySessionId,
  staleMarkerFor,
  withTmpDir,
} from './helpers.mjs';

suite('isCompactCommand()');

test('/compact → true', () => {
  assert.equal(isCompactCommand('/compact'), true);
});

test('/compact with trailing args → true', () => {
  assert.equal(isCompactCommand('/compact --all'), true);
});

test('non-compact prompt → false', () => {
  assert.equal(isCompactCommand('hello'), false);
  assert.equal(isCompactCommand('/other'), false);
});

suite('isClearCommand() (fix #25)');

test('/clear → true', () => {
  assert.equal(isClearCommand('/clear'), true);
});

test('/clear with trailing args → true', () => {
  assert.equal(isClearCommand('/clear --all'), true);
});

test('non-clear prompt → false', () => {
  assert.equal(isClearCommand('hello'), false);
  assert.equal(isClearCommand('/clearfoo'), false);
  assert.equal(isClearCommand('/compact'), false);
});

suite('isCompactOrClearCommand() (fix #25)');

test('/compact → true', () => {
  assert.equal(isCompactOrClearCommand('/compact'), true);
});

test('/clear → true', () => {
  assert.equal(isCompactOrClearCommand('/clear'), true);
});

test('other prompt → false', () => {
  assert.equal(isCompactOrClearCommand('hello'), false);
});

suite('isClosePattern()');

test('한국어 세션 마무리 패턴 → true', () => {
  assert.equal(isClosePattern('세션 마무리하자'), true);
  assert.equal(isClosePattern('세션 종료할게'), true);
  assert.equal(isClosePattern('세션 끝'), true);
});

// ADR 0055: the OLD pattern required a verb ending and missed the most common
// real phrasings. These were measured as false-rejects of genuine closed
// sessions; the broadened pattern must accept them.
test('한국어 세션 마무리 보강 패턴 → true (imperative / bare / no-space)', () => {
  assert.equal(isClosePattern('세션 마무리 해줘'), true); // imperative
  assert.equal(isClosePattern('세션 마무리'), true); // bare
  assert.equal(isClosePattern('세션마무리'), true); // no space
  assert.equal(isClosePattern('머지 후 세션 마무리'), true); // trailing
  assert.equal(isClosePattern('응 기록하고 세션마무리'), true);
  assert.equal(isClosePattern('세션 마무리한거지?'), true); // confirmation
  assert.equal(isClosePattern('세션 마무리합시다'), true); // 합시다
  assert.equal(isClosePattern('세션 마무리하죠'), true);
  assert.equal(isClosePattern('세션 종료해주세요'), true);
  assert.equal(isClosePattern('세션 마무리 한거니?'), true); // confirmation (corpus)
});

// ADR 0055 (codex re-review): complete-terminal whitelist + (?![가-힣]) boundary
// rejects connective continuations that merely share a close-verb prefix.
test('한국어 연결형(작업 지시 안의 종료 어휘) → false', () => {
  assert.equal(isClosePattern('세션 종료해주는 로직을 작성해줘'), false);
  assert.equal(isClosePattern('세션 종료해야 하는 조건'), false);
  assert.equal(isClosePattern('세션 마무리해도 되는지 확인해줘'), false);
  assert.equal(isClosePattern('세션 마무리하고 싶은지 물어봐'), false);
  assert.equal(isClosePattern('세션 종료 해주기 기능'), false);
});

test('한국어 여기까지/이만 패턴 → true', () => {
  assert.equal(isClosePattern('오늘 여기까지'), true);
  assert.equal(isClosePattern('오늘은 여기'), true);
  assert.equal(isClosePattern('여기까지'), true);
  assert.equal(isClosePattern('이만 마치자'), true);
  assert.equal(isClosePattern('이만 종료'), true);
});

test('한국어 작업/그만/슬슬/이만 패턴 → true', () => {
  assert.equal(isClosePattern('오늘 작업 마무리하자'), true);
  assert.equal(isClosePattern('작업 마무리 할게'), true);
  assert.equal(isClosePattern('작업 종료 하자'), true);
  assert.equal(isClosePattern('그만 하자'), true);
  assert.equal(isClosePattern('그만 할게'), true);
  assert.equal(isClosePattern('슬슬 마무리하자'), true);
  assert.equal(isClosePattern('오늘은 이만'), true);
});

test('영어 close 패턴 → true', () => {
  assert.equal(isClosePattern('wrap up'), true);
  assert.equal(isClosePattern('wrapping up'), true);
  assert.equal(isClosePattern('done for today'), true);
  assert.equal(isClosePattern("that's all for today"), true);
  assert.equal(isClosePattern('signing off'), true);
  assert.equal(isClosePattern('ending the session'), true);
  assert.equal(isClosePattern('close the session'), true);
});

test('일반 작업 문장 → false (false-positive 방지)', () => {
  assert.equal(isClosePattern('이 함수 마무리하자'), false);
  assert.equal(isClosePattern('버그 종료하자'), false);
  assert.equal(isClosePattern('코드 정리'), false);
  assert.equal(isClosePattern('다음 작업 시작하자'), false);
  assert.equal(isClosePattern('여기까지 구현하고 테스트해줘'), false); // Codex P2
  assert.equal(isClosePattern('작업 종료 조건을 바꿔줘'), false); // Codex P2
  assert.equal(isClosePattern('wrap up this PR'), false); // Codex P2
  assert.equal(isClosePattern('wrap up this feature'), false); // Codex P2
  // 6a: read-only review/debug sessions are now "substantial", so task-level
  // "wrap up the <work>" phrasing must NOT read as a session-close signal.
  assert.equal(isClosePattern('wrap up the review'), false);
  assert.equal(isClosePattern('wrap up this analysis'), false);
  assert.equal(isClosePattern('wrapping up the investigation'), false);
  assert.equal(isClosePattern('wrap up the debugging'), false);
  assert.equal(isClosePattern('wrap up the audit'), false);
  // ISSUE-29 부 fix: 세션 + 마무리/종료 needs a verb ending; bare 끝/임 are
  // boundary-guarded so mentions/negations and noun-prefix forms don't trip.
  assert.equal(isClosePattern('세션 마무리 할 때가 아닌데'), false);
  assert.equal(isClosePattern('세션 종료 조건을 바꿔줘'), false);
  assert.equal(isClosePattern('세션 종료 임시 플래그'), false);
  assert.equal(isClosePattern('세션 끝내는 방법'), false);
  assert.equal(isClosePattern('세션 끝나면 알려줘'), false);
  // ADR 0055: broadening must still reject genuine non-close uses a real user
  // types — object particle + transitive verb, noun-modifier, negation.
  assert.equal(isClosePattern('세션 마무리를 구현해줘'), false);
  assert.equal(isClosePattern('세션 종료 로직'), false);
  assert.equal(isClosePattern('세션 마무리 테스트'), false);
  assert.equal(isClosePattern('세션 종료하지 마'), false);
  // ADR 0055 (codex re-review): bare 해 must be boundary-guarded so the nouns
  // 해결/해설/해석 don't satisfy the whitelist, and explicit negations stay out.
  assert.equal(isClosePattern('세션 종료 해결 방법'), false);
  assert.equal(isClosePattern('세션 마무리 해설'), false);
  assert.equal(isClosePattern('세션 종료 안 해도 돼'), false);
  assert.equal(isClosePattern('세션 마무리하지 않아도 돼'), false);
  assert.equal(isClosePattern('세션 종료 여부'), false);
  assert.equal(isClosePattern('세션 마무리 작업 정리'), false);
  assert.equal(isClosePattern(''), false);
  assert.equal(isClosePattern(null), false);
});

test('혼합 텍스트(트랜스크립트)에서도 패턴 감지', () => {
  const transcript = '이 PR 리뷰 마저 봐줘\n오늘은 여기까지 하자\n내일 다시 볼게';
  assert.equal(isClosePattern(transcript), true);
});

// conditional-close-reconfirm reworks the block-reason wording (emitBlock's
// reconfirm branch) but must NOT touch isClosePattern's decision surface —
// narrowing it risks reopening the over-close regression it already guards
// against. The JSDoc's own match/no-match examples are the first-line guard;
// a byte-level snapshot of the function source is the stronger, second-line
// guard (a semantically-equivalent rewrite could still pass the corpus
// above while being a different regex than what was reviewed).
test('isClosePattern JSDoc examples: match/no-match corpus is exact', () => {
  for (const s of ['세션 마무리하자', '오늘 여기까지', 'wrap up', 'signing off']) {
    assert.equal(isClosePattern(s), true, `JSDoc match example should be true: ${s}`);
  }
  for (const s of ['이 함수 마무리하자', 'wrap up this PR']) {
    assert.equal(isClosePattern(s), false, `JSDoc no-match example should be false: ${s}`);
  }
});

test('isClosePattern source is byte-unchanged by this feature (function.toString() snapshot)', () => {
  const digest = createHash('sha256').update(isClosePattern.toString()).digest('hex');
  assert.equal(
    digest,
    '9b882b618b31833f268ac2c6e05693352044c526f7f70344e3fa0981520cdc53',
    'isClosePattern source changed — conditional-close-reconfirm must not touch this regex',
  );
});

// ── close ARTIFACTS, not the marker: the gate lived on one writer, so a close
// done by hand (edit the files, skip crystallize) never tripped it. ──
suite('detectSessionCloseArtifact()');

test('session-state.md 마감 heading → matched, with the heading date captured', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/session-state.md',
    content: '> **2026-07-28 마감(13번째 세션).** 세 스트림을 처음으로 병렬로 굴렸다.',
  });
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'session-state-heading');
  assert.equal(r.date, '2026-07-28');
});

test('session-state.md ordinary dated heading (no 마감) → not matched', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/session-state.md',
    content: '**2026-07-28(13번째 세션): 다음 작업**\n\n- next task',
  });
  assert.equal(r.matched, false);
});

// The real hot.md/session-state.md convention puts "(Nth 세션)" right after
// the date, THEN the colon-led narrative — so the close word can land either
// before or after the parenthetical. Both orderings must match.
test('session-state.md 마감 AFTER the "(Nth 세션)" parenthetical → matched', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/session-state.md',
    content: '**2026-08-03(13번째 세션): 마감**',
  });
  assert.equal(r.matched, true);
  assert.equal(r.date, '2026-08-03');
});

test('session-state.md 마감 as a noun-modifier ("마감 조건") is NOT a close announcement', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/session-state.md',
    content: '**2026-08-03 마감 조건을 점검**',
  });
  assert.equal(r.matched, false);
});

test('hot.md carrying an explicit closing heading → matched', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/hot.md',
    content: '**2026-07-28 세션 종료: 오늘 작업 요약**',
  });
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'hot-narrative');
  assert.equal(r.date, '2026-07-28');
});

test('hot.md "세션 종료 여부" (whether-or-not, a question not an announcement) → NOT matched', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/hot.md',
    content: '**2026-08-03 세션 종료 여부: 점검**',
  });
  assert.equal(r.matched, false);
});

// The noun-modifier class is open-ended (여부/조건/로직/절차/정책/… — codex kept
// finding new ones across review rounds). Rather than enumerate, the guard
// rejects ANY Hangul word directly following the close word — these two pin
// modifiers that were NOT in the original blacklist, proving the structural
// fix generalizes instead of chasing one more word each round.
test('hot.md/session-state.md close word followed by an unlisted noun-modifier (절차/정책) → NOT matched', () => {
  assert.equal(
    detectSessionCloseArtifact({
      path: 'projects/hypomnema/hot.md',
      content: '**2026-08-03 세션 종료 절차: 문서화**',
    }).matched,
    false,
  );
  assert.equal(
    detectSessionCloseArtifact({
      path: 'projects/hypomnema/session-state.md',
      content: '**2026-08-03 마감 정책: 문서화**',
    }).matched,
    false,
  );
});

// Word-boundary rule, not an enumerated suffix list: a verb conjugation
// attaches to 마감/종료 with NO space (거의 무한한 활용형), so ANY such
// directly-attached run is accepted — honorific, passive, and nominal forms
// alike, without naming each one. This is the corpus a real Korean speaker
// (this user's default register is 존댓말) actually writes, not just the
// bare dictionary form the old suffix-whitelist happened to enumerate.
test('마감/종료 with a directly-attached conjugation (no space) → matched regardless of form', () => {
  const forms = [
    '마감했다', // plain past
    '마감했습니다', // honorific past (해요체/합쇼체)
    '마감하였습니다', // honorific past, full form
    '마감되었습니다', // passive honorific
    '마감됨', // nominalized passive
  ];
  for (const form of forms) {
    const r = detectSessionCloseArtifact({
      path: 'projects/hypomnema/session-state.md',
      content: `**2026-08-03 ${form}**`,
    });
    assert.equal(r.matched, true, `expected a match for "${form}"`);
  }
});

test('hot.md rewritten as a closing narrative WITHOUT 마감/종료 vocabulary is a PARTIAL-DEFENSE gap, not a solved case', () => {
  // This is the literal text the 2026-07-28 incident wrote into hot.md. It
  // reads as a wrap-up to a human but names no close word, and this signal
  // can only see current content (no prior version to diff against) — so it
  // does not fire here. This is NOT the completion of the artifact-set
  // defense; catching a diff-shaped rewrite needs a diff-aware check (compare
  // against the prior committed hot.md, or a PreToolUse guard watching the
  // edit as it happens) — a follow-up slice, not something this pure
  // function can be extended to cover. The session-state heading and
  // commit-message signals still catch this same incident, so today's gap is
  // documented, not silent — but it remains a real gap this test PINS, not a
  // boundary this slice was designed to hold.
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/hot.md',
    content:
      '**2026-07-28(13번째 세션): 세 스트림 병렬을 표준으로 등재하고 처음 실행했다.** 사용자 결정으로 …',
  });
  assert.equal(r.matched, false);
});

test('commit message "session: close the Nth session" → matched', () => {
  const r = detectSessionCloseArtifact({
    commitMessage: 'session: close the thirteenth session, first parallel three-stream run',
  });
  assert.equal(r.matched, true);
  assert.equal(r.kind, 'commit-message');
  assert.equal(r.date, null); // caller supplies the commit's own date
});

test('commit message "세션 마무리" / "세션 종료" (bare) → matched', () => {
  assert.equal(detectSessionCloseArtifact({ commitMessage: '세션 마무리' }).matched, true);
  assert.equal(detectSessionCloseArtifact({ commitMessage: '세션 종료' }).matched, true);
});

// The object particle (을/를) between 세션 and its verb is normal Korean
// syntax, not a modifier — "세션을 종료했다" is a plain sentence, not a heading.
test('commit message "세션을 종료했다" (with object particle + honorific-adjacent verb) → matched', () => {
  assert.equal(detectSessionCloseArtifact({ commitMessage: '세션을 종료했다' }).matched, true);
});

test('commit message "close the 13th session" (digit ordinal) → matched', () => {
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: 'close the 13th session' }).matched,
    true,
  );
});

// The EN pattern's middle slot is now an ORDINAL only (the shape every real
// close commit uses) — a technical commit that happens to say "close the
// <noun> session" must not match just because "session" appears nearby.
test('commit message "close the <noun> session" (technical, not a session-close) → NOT matched', () => {
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: 'fix: close the database session' }).matched,
    false,
  );
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: 'close the browser session' }).matched,
    false,
  );
});

test('commit message "close the session" / "close this session" (isClosePattern\'s own EN forms) → matched', () => {
  assert.equal(detectSessionCloseArtifact({ commitMessage: 'close the session' }).matched, true);
  assert.equal(detectSessionCloseArtifact({ commitMessage: 'close this session' }).matched, true);
});

test('commit message mentioning session and close unrelated to session-close → not matched', () => {
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: 'fix(session): close leak on retry' }).matched,
    false,
  );
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: 'feat: add close button to session modal' })
      .matched,
    false,
  );
  // A "session:" conventional-commit SCOPE label is not itself a close signal
  // — the object being closed must actually be "the session".
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: 'session: close database connection' }).matched,
    false,
  );
  // 마감 as a noun-modifier (documenting a close CONDITION) is not an
  // announcement that a close happened.
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: '세션 마감 조건을 문서화' }).matched,
    false,
  );
  assert.equal(
    detectSessionCloseArtifact({ commitMessage: '세션 종료 절차를 문서화' }).matched,
    false,
  );
});

test('a file basename outside {session-state.md, hot.md} never matches, even with close content', () => {
  const r = detectSessionCloseArtifact({
    path: 'projects/hypomnema/notes.md',
    content: '> **2026-07-28 마감(13번째 세션).**',
  });
  assert.equal(r.matched, false);
});

test('no arguments → not matched, not a crash', () => {
  assert.equal(detectSessionCloseArtifact().matched, false);
  assert.equal(detectSessionCloseArtifact({}).matched, false);
});

// ── ISSUE-29: extractUserMessages must not slurp tool_result content ──
suite('extractUserMessages() — tool_result exclusion');

test('tool_result carrying close-phrase examples is excluded → no false close', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      // tool_result (role:'user') carrying close-pattern example strings, as a
      // Read of close logic/docs would produce — must NOT count as user text.
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              content: '패턴 예시: "이만 마치자", "오늘 여기까지", "wrap up", "session close"',
            },
          ],
        },
      },
      // a genuine, neutral user message in a text block
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '이 close 로직 좀 봐줘' }] },
      },
    ]);
    const text = extractUserMessages(p);
    assert.equal(text.includes('이 close 로직'), true); // real text kept
    assert.equal(text.includes('이만 마치자'), false); // tool_result dropped
    assert.equal(isClosePattern(text), false); // the ISSUE-29 false-positive is dead
  });
});

test('genuine close in a text block still fires', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'y', content: 'noise' }],
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '오늘은 여기까지 하자' }] },
      },
    ]);
    assert.equal(isClosePattern(extractUserMessages(p)), true);
  });
});

test('string content and legacy top-level shape still extracted', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: '세션 마무리하자' } },
      { role: 'user', content: '추가 메모' }, // legacy top-level shape
    ]);
    const text = extractUserMessages(p);
    assert.equal(text.includes('세션 마무리하자'), true);
    assert.equal(text.includes('추가 메모'), true);
  });
});

// ── ADR 0055: extractUserMessages drops system-injected role:user messages ──
suite('extractUserMessages() — injection-vector exclusion (ADR 0055)');

test('isMeta:true (skill/command body) is excluded → injected close phrase ignored', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      // a slash-command / skill body injected as role:user — carries close
      // vocabulary but is NOT user intent. Confirmed isMeta:true in transcripts.
      {
        isMeta: true,
        type: 'user',
        message: { role: 'user', content: '… phrases like "세션 종료", "session close" …' },
      },
      { type: 'user', message: { role: 'user', content: '이 패턴 좀 봐줘' } },
    ]);
    const text = extractUserMessages(p);
    assert.equal(text.includes('이 패턴'), true);
    assert.equal(text.includes('session close'), false);
    assert.equal(isClosePattern(text), false);
  });
});

test('promptSource system/sdk (task-notification / harness) is excluded', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        promptSource: 'system',
        type: 'user',
        message: { role: 'user', content: '세션 마무리 해줘' },
      },
      { promptSource: 'sdk', type: 'user', message: { role: 'user', content: '세션 종료하자' } },
      { type: 'user', message: { role: 'user', content: '중립 메모' } },
    ]);
    const text = extractUserMessages(p);
    assert.equal(text.trim(), '중립 메모');
    assert.equal(isClosePattern(text), false);
  });
});

test('"Stop hook feedback" string (hook nudge) is excluded — not circular evidence', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        type: 'user',
        message: {
          role: 'user',
          content: 'Stop hook feedback:\n[WIKI_AUTOCLOSE] … Run crystallize …',
        },
      },
      { type: 'user', message: { role: 'user', content: '작업 계속하자' } },
    ]);
    const text = extractUserMessages(p);
    assert.equal(text.includes('WIKI_AUTOCLOSE'), false);
    assert.equal(text.includes('작업 계속'), true);
  });
});

// ── ADR 0055: isCloseGateOpen — the marker-writer hard gate ──
suite('isCloseGateOpen() (ADR 0055)');

test('NL close phrase anywhere in the full transcript → true', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: '작업 시작하자' } },
      toolUse('Edit'),
      { type: 'user', message: { role: 'user', content: '세션 마무리 해줘' } },
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('/compact queue-operation → true', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: '계속' } },
      { type: 'queue-operation', operation: 'enqueue', content: '/compact' },
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('AskUserQuestion answer naming a close action → true (correlated by tool_use_id)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q' }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q',
              content:
                'Your questions have been answered: "다음?"="스쿼시 머지하고 세션 마무리". continue.',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('"have been answered" tool_result NOT from AskUserQuestion → false (no pollution)', () => {
  withTmpDir((dir) => {
    // a Read/Grep result whose text happens to contain an answer sentence must
    // NOT satisfy the gate — its tool_use_id has no AskUserQuestion behind it.
    const p = writeJsonl(dir, [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-1',
              content:
                'file.md: Your questions have been answered: "다음?"="세션 마무리". (quoted)',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

test('no close signal (model self-close / over-close) → false', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: 'ingest 해줘' } },
      toolUse('Write'),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

test('injected close phrase (isMeta) does NOT satisfy the gate', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { isMeta: true, type: 'user', message: { role: 'user', content: '… "close the session" …' } },
      { type: 'user', message: { role: 'user', content: '버그 고쳐줘' } },
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

test('unreadable / missing transcript → false (fail-closed)', () => {
  assert.equal(isCloseGateOpen('/no/such/transcript.jsonl'), false);
  assert.equal(isCloseGateOpen(null), false);
});

// ── Measured transcript shapes (ADR 0075) ──────────────────────────────────
//
// The record FIELDS below are the ones the gate reads, taken from records that
// occur in ~/.claude/projects. Text is anonymized and common metadata (uuid, cwd,
// version, …) is omitted, so these are the gate-relevant projection of a real
// shape, not a byte copy — but anonymizing must not change a verdict the fixture
// asserts on, which is the line an earlier draft crossed by swapping a close
// phrase into records whose real text the matcher rejects. Tests labelled
// `acceptance:` go further: they compose measured operations into a sequence the
// corpus does not happen to contain — including one that elides records sitting
// between two real ones — to pin what MUST hold.
//
// Until ADR 0075 lands these are CHARACTERIZATION tests: they pin what the gate
// does today, including where that is wrong. A test asserting `true` under a
// DEFECT comment is pinning a fail-open, not blessing it — the event model is
// expected to flip exactly those assertions, which is how the diff stays honest.
//
// TWO SNAPSHOTS, and mixing them would be its own error, so each count below says
// which it came from. Snapshot A is 2026-07-16 morning: 220 files / 152,395
// records. Snapshot B is the SAME DAY after the harness pruned old transcripts:
// 203 files / 127,655 records. See the provenance note under the helpers.
//
// From SNAPSHOT A, for the classification the event model has to get right:
//   queue-operation   enqueue 655 · dequeue 455 · remove 193 · popAll 7
//   <task-notification>  547 of the 655 enqueues (and 61 of the removes) — i.e.
//                        the queue is overwhelmingly MODEL-CAUSED, not user intent
//   promptSource counts, whose denominator is not obvious: over user records only,
//   and "absent" excludes tool_result-bearing records (18,367), which are replies
//   rather than prompts. Counting those in yields 19,222 and measures nothing.
//
// From SNAPSHOT B (everything the pruning left, re-measured after it):
//   producers on user records carrying `origin.kind`: human 312,
//     task-notification 346, coordinator 4. Non-human producers are real, and
//     `isMeta:true` does not mean "user" — the 4 coordinator records carry it.
//   typed records: 320, all 320 with isSidechain:false + userType:"external".
//   the USER-queued replay shape (isMeta:true + `system` + queuePriority): 10.
//
// The difficulty the GAP fixtures below circle is narrower than "the queue has no
// origin": task-notification replays DO carry origin.kind, and are attributable.
// It is specifically the replay of USER-queued text that carries no origin at all
// — so the one path that needs attribution is the one path that lacks it.
suite('isCloseGateOpen() — measured transcript shapes (ADR 0075)');

const QOP = (operation, content) => {
  const r = {
    type: 'queue-operation',
    operation,
    timestamp: '2026-07-14T00:00:00.000Z',
    sessionId: 's1',
  };
  if (content !== undefined) r.content = content;
  return r;
};

// Every main-chain user record in the corpus carries BOTH of these, without a
// single exception: typed 320/320, interrupt companions 22/22, local-command
// caveats 125/125 — `isSidechain: false` and `userType: "external"`, never
// absent. They are defaults here rather than per-fixture fields because a
// fixture that omits them is not the record it claims to model: an event model
// keyed on their ABSENCE would satisfy the fixture and mishandle every real
// record. Overridable for the sidechain shape, which is the one that differs.
const USER = (fields) => ({ type: 'user', isSidechain: false, userType: 'external', ...fields });

// The typed close that opens the grant-then-event fixtures below. Real ones carry
// a human origin: of the corpus closes followed by a task-notification, /clear, or
// more work, 13/13, 1/1 and 6/7 respectively have origin.kind:"human". Held in one
// place because a fixture that drops it is not the record it models — an event
// model keyed on origin being ABSENT would satisfy the fixture and reject every
// real close. (The 7th, origin-absent, is why origin can corroborate a producer
// but cannot be required as one; see the remove-path twins.)
const CLOSE_TEXT = {
  message: { role: 'user', content: '세션 마무리 해줘' },
  promptSource: 'typed',
};
const CLOSE = { ...CLOSE_TEXT, origin: { kind: 'human' } };

// PROVENANCE, and why `measured:` is a claim about a snapshot rather than a
// re-runnable query. Snapshot A (2026-07-16, 220 files / 152,395 records) and
// snapshot B (the same day, 203 files / 127,655 records) are hours apart: the
// harness prunes old transcripts, and this pruning took with it the only /compact
// enqueue in the corpus (1 → 0) and a third of the user-queued replay records
// (15 → 10). So the shapes below cannot be re-derived from a live
// ~/.claude/projects, and a reviewer who re-measures and finds nothing has not
// caught an error. Each `measured:` fixture therefore names its snapshot and,
// where the corpus is the only witness, cites the durable record in the wiki.
//
// The rotation is also the reason these fixtures exist at all: the corpus is the
// evidence base for ADR 0075, and it is ephemeral. The test file is the archive.

// The one /compact ever observed, pinned end to end. Order as recorded:
//   enqueue "/compact"
//   user   isMeta:true promptSource:"system" queuePriority:"later"  ← queue replay
//   attachment edited_text_file
//   attachment hook_success
//   dequeue
//   user   interruptedMessageId:"msg_…"  "[Request interrupted by user]"
//   user   isMeta:true  "<local-command-caveat>…"
// Only STRUCTURAL fields are pinned (attachment type, interruptedMessageId
// presence, isMeta, producer fields) — not payloads or incidental metadata, which
// would couple the test to harness internals that churn.
//
// The companions are not trivia once the event model classifies every record:
// the attachments pin that known host records stay NEUTRAL rather than fatal,
// [Request interrupted by user] is today extracted as user TEXT rather than
// structurally ignored (so the event model must neutralize interruptedMessageId
// explicitly), and the caveat record is gate-relevant because isMeta is read.
// `dequeue` itself carries no content, so it too is NEUTRAL, a host companion
// rather than a user event: a naive "any user event after the grant
// invalidates it" rule would otherwise reject this, the only observed
// delivered /compact (n=1, one observation proves no more).
//
// Folded in (T7) a second, stripped-down fixture that used to sit right after
// this one: its transcript was a strict subset of this one's, so it pinned
// nothing this fixture does not already cover on its own. What the merged
// fixture fixes is one claim: a delivered /compact opens the gate, and none
// of the records that accompany delivery undo that opening.
test('measured: the one observed /compact lifecycle, through the caveat → true (must STAY granted)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      QOP('enqueue', '/compact'),
      USER({
        message: { role: 'user', content: '앞서 큐에 넣어둔 지시' },
        isMeta: true,
        promptSource: 'system',
        queuePriority: 'later',
      }),
      { type: 'attachment', attachment: { type: 'edited_text_file' } },
      { type: 'attachment', attachment: { type: 'hook_success' } },
      QOP('dequeue'),
      USER({
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        interruptedMessageId: 'msg_1',
      }),
      USER({
        message: { role: 'user', content: '<local-command-caveat>…</local-command-caveat>' },
        isMeta: true,
      }),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// DEFECT (fail-open). A /compact sitting in the queue has not been delivered, so
// under ADR 0075 it is PENDING and must not grant — only a delivered one should.
// The gate matches on type + content and never reads the lifecycle, so it grants
// on the enqueue alone. Composed: a lone enqueue is not a shape the corpus
// contains (the one observed /compact was always followed by its delivery).
test('acceptance: pending /compact enqueue, never delivered → true (DEFECT: must not grant until delivered)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER({ message: { role: 'user', content: '계속' }, promptSource: 'typed' }),
      QOP('enqueue', '/compact'),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// A background task the MODEL launched reports completion through the same queue
// channel — 547 of the 655 enqueues in the snapshot are these. So queue enqueue
// is not a user-authored channel, and the event model must class this NEUTRAL:
// treating it as an invalidator lets the model's own background work retract the
// user's close.
test('measured: <task-notification> enqueue (model-caused) → false', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER({ message: { role: 'user', content: '계속' }, promptSource: 'typed' }),
      QOP(
        'enqueue',
        '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>',
      ),
      QOP('dequeue'),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

test('measured: /clear enqueue → false (abandons context; not a close)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [QOP('enqueue', '/clear')]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// `remove` is DELIVERY, not cancellation. Measured: of 40 user enqueues whose
// next queue-op was `remove`, all 40 were delivered — the item leaves the queue
// precisely because it is being handed to the model, and the delivery lands as
// an `attachment` of type `queued_command` (origin.kind "human" when present).
// So granting here is CORRECT. Pinned because two review rounds asserted the
// opposite ("cancelled close still grants") and a lifecycle that treats remove
// as a cancellation would drop real user closes on the floor.
//
// The /compact + remove pairing is composed, not observed: the corpus's one real
// /compact went down the dequeue path. The `remove` semantics it relies on are
// measured; the combination is the acceptance case they imply.
test('acceptance: /compact enqueue THEN remove → true (remove is delivery, so this SHOULD grant)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [QOP('enqueue', '/compact'), QOP('remove', '/compact')]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// DEFECT (fail-open). popAll is the op that actually cancels: measured 6 of 7
// user enqueues followed by popAll were never delivered by any mechanism. Yet
// the gate matches on `type` + `content` and never reads `operation`, so a
// popAll carrying /compact grants anyway. popAll does carry content in the
// corpus, so the shape is reachable — though this exact pairing, like the one
// above, is composed rather than observed.
test('acceptance: popAll carrying /compact → false (event model: popAll is a cancellation)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [QOP('popAll', '/compact')]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// GAP (false negative), and the sharpest one. This is the full measured sequence
// for "user types a close while the model is busy": the text is enqueued, then
// `remove`d as it is handed to the model, and the delivery lands as an
// `attachment` of type "queued_command" carrying the prompt verbatim. Crucially
// there is NO user-record replay on this path.
//
// The gate never reads attachments, and it only reads /compact out of a
// queue-operation — so a natural-language close delivered this way is invisible
// end to end. Measured: of the 40 user enqueues delivered via `remove`, 8 carried
// text matching isClosePattern(). Every one of those real closes was dropped.
//
// Two fixtures, because the corpus has two variants and the difference is a
// SCHEMA VERSION boundary, not a producer distinction. Of the 7 close-bearing
// queued_command deliveries surviving at the snapshot, 5 carry origin
// {kind:"human"} and 2 carry none — and the 2 are both 2.1.179, while the 5 span
// 2.1.185–2.1.207. Widened to every user-originated queued_command attachment:
// 2.1.177/179 have no origin (6 records), and 2.1.181 onward have human origin on
// all 27, with no exceptions. origin.kind arrived in 2.1.181.
//
// So origin IS a usable producer signal on this path for current transcripts, and
// the fixtures must not be read as saying otherwise. What is undecided is the
// LEGACY policy: whether a pre-2.1.181 origin-absent delivery may be trusted at
// all. Trusting it blindly means anything without an origin can open the gate, so
// the version is pinned here rather than dropped as incidental metadata — it is
// the field that tells the two fixtures apart. See ADR 0075's version table.
//
// Both are false today for the same reason (the gate never reads attachments), so
// the human-origin one should flip once attachments are read. Whether the legacy
// one flips with it is exactly the open policy question, so this suite does not
// assert that they flip together.
//
// The lifecycle is measured, not idealized, down to the companions: no real
// delivery is adjacent to its remove, and the records in between differ by
// variant. All 5 current deliveries carry a `hook_success` attachment there (one
// also a `hook_additional_context`); the 2 legacy ones carry assistant turns, a
// tool_use, its tool_result, and then `hook_success`. Each fixture uses its own
// variant's companions, because a correlator that only handles a bare gap would
// pass an idealized fixture and break on the attachments present in every real
// delivery. remove likewise carries content in only 3 of 7, both legacy cases
// being content-less, so each fixture follows its own variant there too; and the
// attachment record carries the outer isSidechain/userType in all 7.
const REMOVE_DELIVERY = (dir, { origin, version, removeContent, companions }) => {
  const close = '위키에도 저장해놓고 세션 마무리해줘';
  assert.equal(isClosePattern(close), true); // the ONLY cause of false is the delivery path
  return writeJsonl(dir, [
    USER({ message: { role: 'user', content: '작업 계속' }, promptSource: 'typed' }),
    QOP('enqueue', close),
    removeContent ? QOP('remove', close) : QOP('remove'),
    ...companions,
    {
      type: 'attachment',
      isSidechain: false,
      userType: 'external',
      version,
      attachment: { type: 'queued_command', prompt: close, commandMode: 'prompt', ...origin },
    },
  ]);
};

const HOOK_SUCCESS = { type: 'attachment', attachment: { type: 'hook_success' } };

test('measured: NL close via the remove path, human origin (2.1.181+) → true (event model reads the queued_command attachment)', () => {
  withTmpDir((dir) => {
    const p = REMOVE_DELIVERY(dir, {
      origin: { origin: { kind: 'human' } },
      version: '2.1.207',
      removeContent: true,
      companions: [HOOK_SUCCESS],
    });
    assert.equal(isCloseGateOpen(p), true);
  });
});

// The legacy variant: 2 of the 7 real close-bearing deliveries look like this, and
// both are 2.1.179 — before origin.kind existed. Kept because it is the shape an
// origin-keyed fix would silently leave behind, and because the legacy policy is
// undecided: this fixture is the case that policy has to rule on.
test('measured: NL close via the remove path, legacy 2.1.179 with no origin → false (GAP: legacy policy undecided)', () => {
  withTmpDir((dir) => {
    const p = REMOVE_DELIVERY(dir, {
      origin: {},
      version: '2.1.179',
      removeContent: false,
      // As recorded: two assistant records (a thinking turn, then a text turn)
      // before the tool_use, and the tool_result correlated to it by id.
      companions: [
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '…' }] } },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tu_1', input: {} }] },
        },
        USER({
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
          },
        }),
        HOOK_SUCCESS,
      ],
    });
    assert.equal(isCloseGateOpen(p), false);
  });
});

// promptSource names the producer, and the harness sets it: `typed` (375 in the
// corpus) marks text the user typed directly; `queued` (23) text they typed into
// the queue; `suggestion_accepted` (3) a suggestion they accepted; `system` (416)
// / `sdk` (5) are injections, and it is ABSENT on slash-command bodies and
// caveats (856). Under the ADR 0075 threat model (a model that drifts but does
// not forge the transcript), `typed` is a signal the model cannot mint, which is
// the producer contract the event model needs. Today the gate only uses
// promptSource negatively, to drop system|sdk, so this grants for the weaker
// reason that the text matches.
//
// The signal is only this clean on the typed path. `system` covers both harness
// injections and the queue-replay of text a user really typed, which is why the
// dequeue GAP below is still open.
test('measured: promptSource "typed" close → true (the authorship signal the gate does not use)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER({ message: { role: 'user', content: '세션 마무리 해줘' }, promptSource: 'typed' }),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// The counterexample that corrects the record, pinned at the ONLY layer that can
// still carry it. An earlier draft of this suite claimed the replay-shape records
// "all carry non-close text". That was wrong: one of them was the phrase below, a
// genuine instruction to end the session that the matcher does not recognize.
//
// What is pinned here is only the matcher verdict, because that is all the
// evidence supports. The record itself was observed once (snapshot 2026-07-16)
// and the corpus has since pruned it, so its exact lifecycle can no longer be
// verified by anyone — and a fixture that reconstructed that lifecycle would be
// asserting a sequence nobody can check, under a `measured:` label that claims
// somebody did. The durable citation for the phrase is the wiki: issue_detail
// ISSUE-60, "곁가지: 매처도 진짜 close를 놓친다", which quotes it verbatim and
// predates this suite.
//
// The matcher miss is a SEPARATE layer from the delivery GAP below. ADR 0072
// rejects loosening the matcher as the fix for structured selections; it does not
// forbid every extension, so this is an open question rather than a closed one.
test('measured: a real user close phrase the matcher does not recognize (separate layer)', () => {
  assert.equal(
    isClosePattern('PR #110 CI green 확인 후 머지하고 세션 마무리(위키 저장)까지 진행'),
    false,
  );
});

// GAP (false negative), and an OPEN one — read the twin below before touching it.
// The other queue delivery path: `dequeue` replays the user's text as a user
// record, but stamps it isMeta:true + promptSource:"system", the two fields the
// de-pollution layer uses to drop harness injections. So the replay of a close the
// user really typed is dropped, and a real close is invisible.
//
// The text is matcher-visible, so the ONLY cause of false is that drop. The
// isClosePattern guard is load-bearing: without it a matcher change could silently
// turn this into a pass-for-the-wrong-reason, which is the exact defect that made
// an earlier draft of this fixture worthless.
//
// This fixture must NOT be flipped to true on the strength of the lifecycle it
// pins. ADR 0075 briefly carried a rule granting exactly this shape (correlated
// enqueue → dequeue → replay) and withdrew it: the fields here do not attest
// authorship, so granting on them lets the model open the gate itself. See the
// negative twin below, and ADR 0075 "미결: dequeue 경로엔 producer 귀속 수단이
// 없다". Making this true requires a producer signal that does not exist yet.
test('acceptance: queued close, delivered via the correlated dequeue lifecycle → false (GAP: open, do not flip yet)', () => {
  withTmpDir((dir) => {
    const close = '세션 마무리 해줘';
    assert.equal(isClosePattern(close), true); // the ONLY cause of false is the drop
    const p = writeJsonl(dir, [
      QOP('enqueue', close),
      QOP('dequeue'),
      USER({
        message: { role: 'user', content: close },
        isMeta: true,
        promptSource: 'system',
        queuePriority: 'later',
      }),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// The negative twin, and the reason the fixture above must stay false. This is the
// SAME correlated lifecycle — enqueue, dequeue, replay of the same text — with
// every field held identical, including userType:"external", carrying a close the
// user never typed. `origin.kind` is the ONLY difference, and that is deliberate:
// the twins are worthless if any other field can be used to tell them apart, since
// a rule could then reject this fixture while still granting a real peer replay.
// userType in particular does not discriminate: at snapshot B every user record
// carrying an origin.kind is userType:"external" (all 662 of them, human and
// non-human alike).
//
// The corpus shows why none of the remaining fields can attest authorship either:
// `isMeta:true` appears on non-human `coordinator` records, and `queuePriority` is
// a scheduling priority. Model-caused work already traverses this exact lifecycle
// (320 task-notifications with enqueue → dequeue → system replay of the same
// text), and the harness has a `kind:"peer"` path by which an agent's message
// reaches the same queue machinery.
//
// So any rule that grants the fixture above without checking the producer grants
// this one too, and the model can then close its own session without forging
// anything. Both must stay false until an audited producer signal exists — a rule
// that flips the twin above and leaves this one false is the thing to build.
test('acceptance: model-origin text on the same correlated lifecycle → false (must NEVER grant)', () => {
  withTmpDir((dir) => {
    const close = '세션 마무리 해줘';
    const p = writeJsonl(dir, [
      QOP('enqueue', close),
      QOP('dequeue'),
      USER({
        message: { role: 'user', content: close },
        isMeta: true,
        promptSource: 'system',
        queuePriority: 'later',
        origin: { kind: 'peer' },
      }),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// ── Grant-then-event shapes: what the event model must DISTINGUISH ──────────
//
// The shapes above mostly assert `false` with no prior grant, so they cannot tell
// a NEUTRAL record from an INVALIDATING one — both read as false. These three put
// a real grant first, so the two classes separate. Today's gate is an existence
// predicate, so all three return true; under the event model the first must stay
// true and the other two must flip to false. That gap IS the change.
//
// The RELATIONS are measured; the sequences are not, which is why these are all
// `acceptance:`. A typed close followed later in the same transcript by the event
// in question occurs 13 / 7 / 1 times at the 2026-07-16 snapshot — these are
// things users really do after asking to close. (Scan definition, since the count
// moves with it: a typed record whose text matches isClosePattern, then a forward
// scan to the first task-notification enqueue / non-close typed record / `/clear`
// enqueue.) But 18–83, 4–225 and 111 records respectively sit between the two in
// the real transcripts, and the fixtures put them next to each other. No rule
// should key on that distance, so padding with filler would buy nothing — but a
// sequence with the middle removed was not observed, and calling it `measured:`
// would claim it was.

// NEUTRAL. The model launches a background task; its completion notification is
// enqueued after the user's close. The user's decision must survive: if the model
// can retract the user's close simply by doing work, the gate is unusable.
//
// The whole lifecycle is pinned, replay included, because the replay is the record
// that would do the damage: it is a user-TYPE record carrying text, arriving after
// the grant, and an event model that classed it as invalidating would revoke the
// close on the model's own background work. Stopping at the dequeue would let such
// a model pass this fixture. 320 complete enqueue → dequeue → system-replay
// lifecycles were in the corpus at the 2026-07-16 snapshot, so this is the common
// case, not a corner.
//
// origin.kind:"task-notification" is what marks it model-caused; note it is the
// same promptSource:"system" the user's own queued text is replayed under, which
// is exactly why the dequeue GAP above cannot be closed on promptSource alone.
test('acceptance: close, then a model-caused <task-notification> lifecycle → true (must STAY granted)', () => {
  withTmpDir((dir) => {
    const notif =
      '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>';
    const p = writeJsonl(dir, [
      USER(CLOSE),
      QOP('enqueue', notif),
      QOP('dequeue'),
      USER({
        message: { role: 'user', content: notif },
        promptSource: 'system',
        origin: { kind: 'task-notification' },
      }),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// The isolator for the pair below, and it has to come first. Those fixtures put an
// assistant tool_use between the close and the user's next instruction, matching
// the real transcripts — but that means "flipped to false" alone would not prove
// the TYPED WORK did it: a model that wrongly invalidated on the model's own
// tool_use would flip them too and never read the instruction. This fixture is the
// same prefix with the instruction removed, and it must STAY true. The model
// working is not the user changing their mind.
test('acceptance: close, then the model works → true (must STAY granted: tool_use is not an invalidator)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [USER(CLOSE), toolUse('Write')]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// INVALIDATE. The user closes, then changes their mind and asks for more work.
// What closes the gate here is not a rule that any later typed text undoes a
// grant: T4 deleted that per-turn overwrite. It is the retraction tripwire
// (isCloseRetractionPattern) matching the exact corpus phrase this fixture
// types ('아 잠깐, 이것도 고쳐줘'). The limit that comes with a fixed corpus: a
// real retraction worded outside the tripwire's list is missed, and the gate
// stays open.
//
// Twice, because the invalidator's own producer field is what a fix will reach
// for. Of the 7 real close→more-work cases, 6 carry human origin on BOTH typed
// records and 1 has origin absent on both (a legacy transcript, same 2.1.181
// boundary as the remove path). A model that invalidates only on
// origin.kind === "human" would pass the first fixture and keep the gate open
// in the seventh real case, which is the failure this pair exists to block.
// Both must flip to false: `typed` is the ADR's producer contract, and it is
// present on both variants.
//
// The distance is elided, not modelled: in the real cases 4 to 225 records
// separate the close from the next instruction (18 to 83 for the
// task-notification fixture above, 111 for /clear). The second half of that
// still holds after this rewrite; the first half does not. What is pinned is
// no longer "a later typed instruction expires the lease" (false since T4: an
// unmatched typed instruction is neutral, not an invalidator). It is order: a
// tripwire match closes the gate whenever it lands after the open, and no
// rule may key on how far after. That is the same order-over-distance
// principle the resolution store applies outside this file (openedAtIndex
// compared against closedAtIndex, never a record count between them).
const CLOSE_THEN_WORK = (dir, human) => {
  const origin = human ? { origin: { kind: 'human' } } : {};
  return writeJsonl(dir, [
    USER({ ...CLOSE_TEXT, ...origin }),
    toolUse('Write'),
    USER({
      message: { role: 'user', content: '아 잠깐, 이것도 고쳐줘' },
      promptSource: 'typed',
      ...origin,
    }),
  ]);
};

test('acceptance: close, then the user asks for more work → false (event model: lease expires)', () => {
  withTmpDir((dir) => {
    assert.equal(isCloseGateOpen(CLOSE_THEN_WORK(dir, true)), false);
  });
});

test('acceptance: close, then more work, both without origin → false (event model: lease expires here too)', () => {
  withTmpDir((dir) => {
    assert.equal(isCloseGateOpen(CLOSE_THEN_WORK(dir, false)), false);
  });
});

// INVALIDATE. /clear after a close abandons the context rather than preserving it.
// It is a different intent, so it must retract the close rather than sit inert.
test('acceptance: close, then /clear → false (event model: /clear invalidates the lease)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [USER(CLOSE), QOP('enqueue', '/clear')]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// DEFECT (fail-open), latent. Mixed text+tool_result user records DO exist (2 in
// the corpus) but ONLY inside subagents/*.jsonl, which resolveTranscriptBySessionId
// never selects — so this is a latent shape, not a live hole today. The gate reads
// the text block alone, boilerplate and all, so the shape grants the moment
// anything starts feeding it a sidechain file.
//
// COMPOSED, and the composition is the point. Both real records carry
// <fork-boilerplate> text that isClosePattern() rejects, so neither grants as it
// stands; swapping in a close phrase changes the matcher verdict, which is a
// different record, not an anonymization of those two. What is measured is the
// SHAPE (sidechain, mixed blocks, userType:"external"); the close text is the
// acceptance case that shape implies.
//
// It must flip to false: this text is model-context, not a user decision, and a
// subagent must never be able to close the session by quoting a close phrase.
test('acceptance: sidechain mixed text+tool_result carrying a close → false (event model excludes isSidechain)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER({
        isSidechain: true,
        agentId: 'a1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'Fork started' }],
            },
            { type: 'text', text: '<fork-boilerplate> … 세션 마무리 해줘 … </fork-boilerplate>' },
          ],
        },
      }),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// ── ADR 0075 event model: lease invalidation + robustness + AskUserQuestion hardening ──
//
// Coverage the merged measured-shapes suite does not carry, added after a
// pre-commit review. The transcript has no authoritative leaf pointer (measured
// 2026-07-19: 0 leafUuid / summary records), so a heuristic active-branch filter
// was withdrawn — it could skip the real invalidator and PRESERVE a stale grant.
// The gate is a pure line-order lease; these pin the invalidation edges, the
// robustness edges, and the AskUserQuestion hardening.
suite('isCloseGateOpen() — lease invalidation + robustness + AskUserQuestion hardening');

// LOAD-BEARING (invalidation via the queued non-close): the user closes, then
// queues "keep working". The decision is read off the ENQUEUE content (the queue
// has no correlation key), so the queued non-close expires the lease before the
// dequeue+replay companions arrive. Without it the stale close would survive this
// change-of-mind — the majority delivery path for queued text is the queue.
test('close, then a queued non-close (read off the enqueue) → false', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      QOP('enqueue', '아 잠깐, 계속 작업하자'),
      QOP('dequeue'),
      USER({
        message: { role: 'user', content: '아 잠깐, 계속 작업하자' },
        isMeta: true,
        promptSource: 'system',
        queuePriority: 'later',
      }),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// The negative twin: a task-notification replay wears promptSource:"system" too,
// but carries origin.kind, so it is attributable as model-caused and stays
// NEUTRAL — the user's close must survive the model's own background work.
test('close, then a task-notification replay (origin.kind present) → true (stays granted)', () => {
  withTmpDir((dir) => {
    const notif =
      '<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>';
    const p = writeJsonl(dir, [
      USER(CLOSE),
      QOP('enqueue', notif),
      QOP('dequeue'),
      USER({
        message: { role: 'user', content: notif },
        promptSource: 'system',
        queuePriority: 'later',
        origin: { kind: 'task-notification' },
      }),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// ROBUSTNESS: a line that parses to a bare `null` is valid JSON but not a record.
// It must be skipped, not crash on a field read, and not change the verdict.
test('a null JSONL line → skipped, not a crash, verdict unchanged', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [null, USER(CLOSE)]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// EXCLUSION: an AskUserQuestion answer on an injected record (isMeta / sdk) must
// not reach the answer parser — model-reachable channels are never a user click,
// even when correlated to a real AskUserQuestion tool_use.
test('AskUserQuestion answer on an isMeta record → false (exclusion applies)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q' }] },
      },
      {
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q',
              content: 'Your questions have been answered: "다음?"="세션 마무리 해줘"',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// Q7 hardening, LOAD-BEARING: the pre-event scanner matched any `="…"` in a
// correlated tool_result and would grant on this. A malformed AskUserQuestion
// yields a host is_error result that echoes the model's raw input; even with the
// close phrase steered into it AND the success marker present, is_error:true must
// refuse. A click is the signal, not an echo.
test('AskUserQuestion is_error echo of a close phrase → false', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q' }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q',
              is_error: true,
              content: 'Your questions have been answered: "다음?"="세션 마무리 해줘"',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// T5 flip: a non-close AskUserQuestion selection used to expire the lease (the
// old default closed on ANY non-close click). It no longer does. A reflection
// question the close skill's own Step 1a asks mid-procedure produced this
// exact shape, an ordinary click answering an unrelated question, and the old
// rule read it as the user changing their mind and cancelled the approval that
// started the procedure. Now only a close phrase in the answer opens the gate,
// and only a decline answering OUR MARKED close-reconfirm prompt closes it
// (see the click-axis reconfirm suite below); an ordinary click is neutral.
test('close, then a non-close AskUserQuestion selection → true (no longer expires the lease)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id: 'q' }] },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q',
              content: 'Your questions have been answered: "다음?"="아니 계속 작업하자"',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// ── the approval line must not expire the close lease (ISSUE-74) ──
// One carve-out survives review: a typed `apply-proposals <nonce>` for a nonce this
// transcript shows `proposal challenge` minting. The command-channel carve-out was
// removed after codex showed a model-issued Skill call produces the same non-meta
// <command-name> user record, and the AskUserQuestion carve-out was removed because
// "does not read as a retraction" is fail-open on an open class of phrasings.
// Those two removals are pinned here as NEGATIVES, so re-adding either turns red.
suite('isCloseGateOpen(): the minted approval line, and what is NOT a channel');

// The nonce shape `proposal challenge` mints (randomBytes(16).toString('hex')).
const NONCE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
// The challenge output verbatim (scripts/proposal.mjs). The drift pin below keeps
// this fixture honest against the real writer.
const CHALLENGE_TEXT = (nonce) =>
  '\nTo approve the 1 overwrite(s) above, the USER must type this line in the conversation:\n\n' +
  `    apply-proposals ${nonce}\n\nThen run: hypomnema proposal resolve --session-id=s\n`;
const TOOL_USE = (name, id) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name, id, input: {} }] },
});
// A tool_result record: role:'user' in the transcript, but no text block, so it is
// never genuine user text.
const TOOL_RESULT = (id, content, extra = {}) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }],
  },
});
// The minting pair as it really lands: the model runs `proposal challenge` via Bash
// and the challenge output comes back correlated to that Bash tool_use.
const MINT = (nonce) => [TOOL_USE('Bash', 'bash-1'), TOOL_RESULT('bash-1', CHALLENGE_TEXT(nonce))];
const TYPED = (text) => USER({ message: { role: 'user', content: text }, promptSource: 'typed' });
// A slash-command / Skill invocation as the harness records it. Not a channel: the
// model's own Skill call produces this same shape.
const COMMAND_TAGS = (name, args) =>
  USER({
    message: {
      role: 'user',
      content:
        `<command-message>${name}</command-message>\n` +
        `<command-name>/${name}</command-name>` +
        (args ? `\n<command-args>${args}</command-args>` : ''),
    },
  });
const ASK = (id) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', id }] },
});
const ANSWER = (id, picked) =>
  TOOL_RESULT(id, `Your questions have been answered: "?"="${picked}"`);

// Renamed (codex): mint is no longer the thing this pins. The per-turn
// overwrite that could have expired a grant on any non-close typed text is
// gone (T4). What survives here is narrower: the retraction tripwire does not
// match the approval line `apply-proposals <nonce>` at all, so it stays
// NEUTRAL and the grant made by CLOSE stands. Pairs with 'typed non-close
// text after the approval line still expires the lease' further down, which
// pins the tripwire firing normally on a real retraction typed right after
// this same line. MINT/NONCE/CHALLENGE_TEXT stay defined above only because
// this test and that pairing test both still build on them.
test('the apply-proposals approval line is neutral and does not retract a prior grant', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [USER(CLOSE), ...MINT(NONCE), TYPED(`apply-proposals ${NONCE}`)]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// THE CARVE-OUT NEVER GRANTS. Same transcript minus the close: neutral leaves the
// lease exactly where it was, and where it was is "never granted".
test('the approval line alone is not a close signal (neutral never creates a grant)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [...MINT(NONCE), TYPED(`apply-proposals ${NONCE}`)]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// The eight mint-carve-out tests that used to sit here (a minted nonce's twin,
// self-mint ordering, assistant/non-Bash/uncorrelated/failed/bare-hex framing,
// and whole-message exactness) and the drift pin on `proposal challenge`'s
// wording are gone along with the carve-out itself (ADR 0088, T4). Every one
// of them asserted that a non-close typed message EXPIRED the lease — the
// exact per-turn overwrite this task deletes. Under the new rule an
// unrecognized typed message (including the approval line itself) is NEUTRAL,
// so those assertions became false rather than merely untested; keeping them
// would have meant weakening the assertion to reach green, which this task
// forbids. `MINT`/`NONCE`/`CHALLENGE_TEXT` stay defined above because the
// surviving tests below still use them to build a close-then-neutral-then-
// retraction sequence.

// NOT A CHANNEL (removed after review): a `<command-name>` user record proves
// nothing about who produced it. Claude Code routes a model-issued Skill call
// through the same slash-command path, so an invocation record can be the model's
// own. Each variant below must stay a non-grant.
test('a command invocation record is not a close signal, in any namespace form', () => {
  withTmpDir((dir) => {
    for (const rec of [
      COMMAND_TAGS('hypo:crystallize'),
      COMMAND_TAGS('other-plugin:crystallize'),
      COMMAND_TAGS('crystallize'),
      COMMAND_TAGS('hypo:crystallize', '위키 지식합성 진행해줘'),
      // the XML block pasted on its own, with no <command-message> wrapper
      TYPED('<command-name>/hypo:crystallize</command-name>'),
    ]) {
      const p = writeJsonl(dir, [rec]);
      assert.equal(isCloseGateOpen(p), false, JSON.stringify(rec.message.content));
    }
  });
});

// DISCARDED (T4): a command invocation after a close used to expire the lease,
// because the old rule read a command-tag record as ordinary user text and any
// non-close user text closed the gate. Now `eventUserText` excludes a
// command-tag record entirely (it is model-reachable, ADR 0087), so it is
// NEUTRAL rather than closing — the assertion this test made is no longer
// true, not merely untested, so it is removed rather than weakened.

// NEW (T4): a close phrase riding along INSIDE a command invocation must not
// open the gate either — the exclusion covers the whole record, not just a
// bare tag with no close wording attached. Regression for ADR 0087 applied to
// the OPENING axis: without the exclusion in `eventUserText`, either fixture
// below opens the gate on the strength of a model-reachable record.
test('a close phrase riding inside a command invocation does not open the gate', () => {
  withTmpDir((dir) => {
    for (const rec of [
      COMMAND_TAGS('hypo:crystallize', '세션 마무리해줘'),
      TYPED('<command-name>/hypo:crystallize</command-name> 세션 마무리 해줘'),
    ]) {
      const p = writeJsonl(dir, [rec]);
      assert.equal(isCloseGateOpen(p), false, JSON.stringify(rec.message.content));
    }
  });
});

// F5 (CONCERN): eventUserText used to join array content blocks with a bare
// '\n' before scanning for a command-invocation tag. A tag split across block
// boundaries (e.g. '<command-na' | 'me>/hypo:crystallize</command-name>' |
// '세션 마무리해줘') gets a newline spliced into the middle of the tag name by
// that join, so the regex misses it and the trailing close phrase opens the
// gate — a fail-open on a format drift, not on today's string-content host
// shape. Not reproducible via today's live Skill path (the host sends one
// string), but the exclusion must not depend on where the blocks happen to be
// cut, so this pins the fix directly against the split shape.
test('a command tag split across array content blocks (no separator between them) does not open the gate', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<command-na' },
            { type: 'text', text: 'me>/hypo:crystallize</command-name>' },
            { type: 'text', text: '세션 마무리해줘' },
          ],
        },
      }),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// The no-separator check above must stay scoped to CONSECUTIVE text blocks —
// joining across an intervening non-text block (an image, here) would
// synthesize a tag out of two text blocks that were never actually adjacent
// in the real content, and that is a new false-open-turned-false-close bug:
// a real close spoken right after attaching an image would be thrown away.
// Neither the two text blocks bridged by the image, nor the '\n'-joined whole
// text, ever form the tag, so this must open the gate on the trailing close
// phrase exactly as it would with no image in between.
test('a command-tag-shaped fragment bridged across an intervening non-text block (an image) does not suppress the close underneath it', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<command-na' },
            { type: 'image', source: '첨부 이미지' },
            { type: 'text', text: 'me>/hypo:crystallize</command-name>' },
            { type: 'text', text: '세션 마무리해줘' },
          ],
        },
      }),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// F3 (BLOCKER fix). The behavioral guard the source scan below cannot be —
// a name-based scan is defeated by renaming the variable
// (`open = isClosePattern(userText)` reads identically to the old rule and
// still passes a regex keyed on the literal name `granted`). What must
// actually hold is the EFFECT: once the gate is open, typed text that is
// neither a close phrase nor a retraction phrase must leave it open. If the
// per-turn overwrite ever comes back — under any variable name — one of
// these ordinary, unrelated messages would silently close a gate the user
// already opened, and this assertion goes red.
//
// A single fixed sentence let an implementation special-case that exact
// string and still pass (`if (userText === '이거 어떻게 돼?') continue; open =
// isClosePattern(userText);`), so this now runs several different, unrelated
// sentences — Korean and English, a question and a plain statement — none of
// them a close phrase or a retraction phrase, and requires every one to
// leave the gate open.
test('a grant survives several different ordinary, unrelated typed messages (per-turn overwrite would silently close it)', () => {
  const neutralPhrases = [
    '이거 어떻게 돼?',
    '테스트 결과 좀 보여줘',
    'what does this function return?',
    'can you check the linter output',
  ];
  for (const phrase of neutralPhrases) {
    withTmpDir((dir) => {
      const p = writeJsonl(dir, [USER(CLOSE), TYPED(phrase)]);
      assert.equal(isCloseGateOpen(p), true, phrase);
    });
  }
});

// S3 (codex round 4 CONCERN). A fixed list of four sentences is still a name
// list: an implementation can special-case exactly those four strings and
// fall through to the old per-turn overwrite for everything else, passing
// every assertion above while still misclosing on e.g. '다음 파일도 읽어줘'.
// The four-phrase test stays (a concrete example is still useful to a
// reader), but the actual guard has to be the EFFECT from the walk's own
// contract: typed text classifies into close / retraction / neutral, and
// anything neither matcher recognizes MUST be neutral — i.e. it must never
// change whether the gate is open. This pins that default branch directly,
// over a battery of GENERATED sentences rather than a hand-picked handful,
// so a variable-renamed or string-keyed reintroduction of the old rule has
// no finite list left to hide behind.
//
// The generator is deterministic (a fixed word list crossed with a fixed set
// of sentence templates, Korean and English), not random — a flaky suite
// helps nobody. The FILTER is the actual effect criterion this fix cares
// about: every candidate is checked against isClosePattern and
// isCloseRetractionPattern first, and only the ones BOTH reject (i.e.
// genuinely unclassified, "neutral" by the walk's own rulebook) are used.
// None of the words or templates below was chosen to name a close or
// retraction phrase, so in practice the filter keeps nearly everything — but
// asserting the filtered set, not the raw one, is what makes this a test of
// the EFFECT ("unmatched implies neutral") instead of one more fixed list.
const NEUTRAL_CANDIDATE_WORDS = [
  '파일',
  '코드',
  '버그',
  '문서',
  '설정',
  '로그',
  '링크',
  '결과',
  '함수',
  '테이블',
];
const NEUTRAL_CANDIDATE_TEMPLATES = [
  (w) => `${w} 어떻게 돼?`,
  (w) => `${w} 좀 보여줘`,
  (w) => `${w} 다시 확인해줘`,
  (w) => `${w} 내용 알려줘`,
  (w) => `what about the ${w}`,
  (w) => `can you check the ${w}`,
  (w) => `show me the ${w} again`,
  (w) => `please read the ${w}`,
];
function generateUnclassifiedTypedTexts() {
  const out = [];
  for (const w of NEUTRAL_CANDIDATE_WORDS) {
    for (const tpl of NEUTRAL_CANDIDATE_TEMPLATES) {
      const s = tpl(w);
      if (!isClosePattern(s) && !isCloseRetractionPattern(s)) out.push(s);
    }
  }
  return out;
}

test('every generated typed message that neither matcher classifies leaves an open gate open (the walk default branch is neutral, not close-by-default)', () => {
  const candidates = generateUnclassifiedTypedTexts();
  // Sanity floor on the filter itself: if this drops to 0 the test below
  // would vacuously pass on an empty set, proving nothing. The word/template
  // grid is 10 x 8 = 80 candidates; none of the words or templates was
  // chosen to look like a close or retraction phrase, so this should keep
  // all 80 — a much smaller surviving count would itself be a signal that
  // isClosePattern's own word list grew wide enough to eat the fixture.
  assert.ok(
    candidates.length >= 40,
    `expected a substantial unmatched set, got ${candidates.length}`,
  );
  for (const phrase of candidates) {
    withTmpDir((dir) => {
      const p = writeJsonl(dir, [USER(CLOSE), TYPED(phrase)]);
      assert.equal(isCloseGateOpen(p), true, phrase);
    });
  }
});

// SOURCE SCAN: this is a SECONDARY, name-based guard, not the primary
// defense (the behavioral test above is) — a rewrite that renames every one
// of these identifiers would sail through this scan while still reproducing
// the old per-turn overwrite, which is exactly why the behavioral test exists
// alongside it. Kept because a literal reintroduction under the SAME names is
// a cheap, zero-cost thing to also catch. `granted = isClosePattern(` is the
// old rule's exact shape (any typed text unconditionally sets the verdict);
// `bashIds` is mint-machinery's own correlation state, so its return would
// signal the same deleted subsystem coming back even before any use of it
// reappears.
test('the per-turn overwrite and the mint machinery are gone from the source', () => {
  const src = readFileSync(join(REPO, 'hooks', 'hypo-shared.mjs'), 'utf-8');
  assert.equal(/granted\s*=\s*isClosePattern\(/.test(src), false);
  for (const id of ['mintedNonces', 'challengeMint', 'collectMinted', 'bashIds']) {
    assert.equal(src.includes(id), false, `${id} should no longer exist`);
  }
});

// F4 (BLOCKER fix). isCloseRetractionPattern was imported but never called
// directly anywhere in this file — every existing pass was routed through
// isCloseGateOpen, which never proves the matcher's OWN boundary (a false
// positive on the approval line or a close phrase would have been masked by
// isCloseGateOpen's other branches). These call it directly.
suite('isCloseRetractionPattern()');

test('the three corpus retraction phrases → true', () => {
  assert.equal(isCloseRetractionPattern('아 잠깐, 이것도 고쳐줘'), true);
  assert.equal(isCloseRetractionPattern('아 잠깐, 이거 먼저 고쳐줘'), true);
  assert.equal(isCloseRetractionPattern('하나만 더 해줘'), true);
});

test('the approval line, a close phrase itself, and an ordinary question → false', () => {
  assert.equal(isCloseRetractionPattern(`apply-proposals ${'0'.repeat(32)}`), false);
  assert.equal(isCloseRetractionPattern('세션 마무리 해줘'), false);
  assert.equal(
    isCloseRetractionPattern('업데이트 했는데 /hypo:upgrade --apply 이거 실행해야해?'),
    false,
  );
});

test('empty string and non-string input → false', () => {
  assert.equal(isCloseRetractionPattern(''), false);
  assert.equal(isCloseRetractionPattern(null), false);
  assert.equal(isCloseRetractionPattern(undefined), false);
  assert.equal(isCloseRetractionPattern(42), false);
});

// T5 flip: this used to pin the fail-closed direction (any non-close answer
// expires the lease, whatever its wording). That direction is gone; a click
// axis that closed on any unrecognized answer is exactly the default that let
// an unrelated mid-procedure question cancel a real approval. Now the answer
// is neutral unless it names a close, or declines OUR MARKED reconfirm prompt.
// The loss this buys: '지금 종료하지 말아 줘' is a genuine request to keep
// going, but it is not a close phrase and this question is not marked, so it
// now passes through neutral instead of closing, same as the other three
// unrelated wordings below.
test('a non-close AskUserQuestion answer on an unmarked question is neutral, whatever its wording', () => {
  withTmpDir((dir) => {
    for (const picked of ['지금 종료하지 말아 줘', '지금 쓴다', '3개', 'whatever']) {
      const p = writeJsonl(dir, [USER(CLOSE), ASK('q'), ANSWER('q', picked)]);
      assert.equal(isCloseGateOpen(p), true, picked);
    }
  });
});

// THE FENCE (ISSUE-31): a user who types one of the retraction tripwire's own
// corpus phrases after a close closes the gate again.
// Renamed (codex): the old name claimed every non-close text expires the
// grant; the per-turn overwrite that made that true is gone (T4), and this
// fixture types one of the retraction tripwire's own corpus phrases, not an
// arbitrary non-close message. See the neutral-survival test above for what
// an UNLISTED non-close phrase does instead (nothing).
test('a tripwire retraction phrase after a grant expires the lease (over-close defense)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [USER(CLOSE), TYPED('아 잠깐, 이거 먼저 고쳐줘')]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// Pairs with 'the apply-proposals approval line is neutral and does not
// retract a prior grant' above: that test shows the approval line itself
// never matches the retraction tripwire, and this one shows the tripwire
// still fires normally on a real retraction typed right after it. Together
// they pin that the approval line carries no special immunity beyond being,
// like any other unrecognized text, neutral on its own.
test('typed non-close text after the approval line still expires the lease', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      ...MINT(NONCE),
      TYPED(`apply-proposals ${NONCE}`),
      TYPED('하나만 더 해줘'),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// ── T5: click axis, marked reconfirm decline only ──────────────────────────
// A close answer still opens the gate exactly as before. The other half of
// the click axis is new: an answer no longer closes the gate just for not
// naming a close. Only a decline answering OUR marked close-reconfirm prompt
// (askCloseReconfirmToolUse, correlated via CLOSE_RECONFIRM_MARK) closes it,
// and any of the four openers this walk already recognizes reopens it right
// after, the same as it would after any other close.
suite('isCloseGateOpen() click axis: marked reconfirm decline only (T5)');

test('a decline answering OUR marked close-reconfirm prompt closes an open gate', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', '아직, 계속'),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// A decline that ALSO contains close wording (the model authors the option
// text, so it could word a decline to carry a close phrase too) must still
// close: the decline branch is checked first for a marked prompt, and only
// falls through to the close check when the answer did not decline.
// Otherwise a marked reconfirm's own "no" option would be a forgeable way to
// force the gate open on the user's own rejection.
test('a decline that also carries close wording still closes, on a marked prompt (decline wins)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', '나중에 세션 마무리'),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

test('an English decline that also carries close wording still closes, on a marked prompt (decline wins)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', 'not yet, wrap up later'),
    ]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// COVERAGE GAP (found in review): every T5 assertion above starts from an
// ALREADY-OPEN gate (USER(CLOSE) first), so a neutral answer and an
// opening answer read the same isCloseGateOpen(p) === true and no assertion
// tells them apart. A sabotage that made every AskUserQuestion answer open
// the gate (`if (m[1] !== undefined) sawClose = true;` in place of
// `if (isClosePattern(m[1])) sawClose = true;`) passed the whole suite
// green. These three start from a transcript with NO initiation record at
// all (no typed close, no /compact enqueue, no queued delivery), so a
// non-close answer opening the gate has nowhere to hide.
test('no initiation at all, then an UNMARKED non-close AskUserQuestion answer, stays closed (does not open)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [ASK('q'), ANSWER('q', '3개')]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// Being marked (askCloseReconfirmToolUse) grants no opening authority of its
// own: it only narrows what CLOSES an already-open gate. A non-close,
// non-decline answer to a marked prompt, with no prior initiation, must stay
// closed exactly like the unmarked case above.
test('no initiation at all, then a MARKED non-close non-decline AskUserQuestion answer, stays closed (marked grants no opening authority)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [askCloseReconfirmToolUse('q1'), ANSWER('q1', '3개')]);
    assert.equal(isCloseGateOpen(p), false);
  });
});

// The priority flip above is scoped to a MARKED prompt only: markedAskIds.has
// gates the decline branch, so an unmarked question's close answer is
// unaffected and still opens the gate exactly as before. This fixture also
// has NO prior initiation record, so it doubles as the positive twin of the
// two closed-gate tests above: with no initiation at all, a close-naming
// answer is what actually opens the gate, nothing else does.
test('a close answer to an UNMARKED question still opens the gate (priority flip does not touch the opening axis)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [ASK('q'), ANSWER('q', '세션 마무리')]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// SOURCE SCAN: walkCloseGate and isCloseReconfirmDeclined must match the SAME
// decline vocabulary, or the two walks quietly drift apart on what counts as
// "not now". Counting the literal regex text (not calling either function)
// pins that the pattern is defined once and referenced, not copied.
test('the reconfirm decline vocabulary regex literal is defined in exactly one place in the source', () => {
  const src = readFileSync(join(REPO, 'hooks', 'hypo-shared.mjs'), 'utf-8');
  const literal = '/(아직|나중|not\\s?yet|later)/i';
  const occurrences = src.split(literal).length - 1;
  assert.equal(occurrences, 1, 'the decline regex literal must be defined once and shared');
});

test('the same decline wording answering an UNMARKED question does not close the gate', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [USER(CLOSE), ASK('q'), ANSWER('q', '아직, 계속')]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('after a marked decline closes the gate, a typed close phrase reopens it', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', '아직, 계속'),
      TYPED('세션 마무리 해줘'),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('after a marked decline closes the gate, a queued /compact reopens it', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', '아직, 계속'),
      QOP('enqueue', '/compact'),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('after a marked decline closes the gate, a human-origin queued close delivery reopens it', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', '아직, 계속'),
      {
        type: 'attachment',
        isSidechain: false,
        userType: 'external',
        attachment: {
          type: 'queued_command',
          prompt: '세션 마무리 해줘',
          origin: { kind: 'human' },
        },
      },
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

test('after a marked decline closes the gate, a fresh AskUserQuestion close answer reopens it', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      USER(CLOSE),
      askCloseReconfirmToolUse('q1'),
      ANSWER('q1', '아직, 계속'),
      ASK('q2'),
      ANSWER('q2', '세션 마무리 해줘'),
    ]);
    assert.equal(isCloseGateOpen(p), true);
  });
});

// ── hasPendingBackgroundWork — read-only pending-work check ──
suite('hasPendingBackgroundWork()');

test('a subagent task with a non-terminal status → true', () => {
  assert.equal(
    hasPendingBackgroundWork({ background_tasks: [{ type: 'subagent', status: 'running' }] }),
    true,
  );
});

test('a shell background task with a running status → true', () => {
  assert.equal(
    hasPendingBackgroundWork({ background_tasks: [{ type: 'shell', status: 'running' }] }),
    true,
  );
});

test('a task with a terminal status → false', () => {
  assert.equal(
    hasPendingBackgroundWork({ background_tasks: [{ type: 'subagent', status: 'completed' }] }),
    false,
  );
  assert.equal(
    hasPendingBackgroundWork({ background_tasks: [{ type: 'shell', status: 'failed' }] }),
    false,
  );
});

test('a task with no status field → true (unknown = not yet terminal)', () => {
  assert.equal(hasPendingBackgroundWork({ background_tasks: [{ type: 'subagent' }] }), true);
});

test('a non-subagent (shell) task counts too → true (widened past subagent-only)', () => {
  assert.equal(
    hasPendingBackgroundWork({ background_tasks: [{ type: 'other', status: 'running' }] }),
    true,
  );
});

test('missing/non-array/empty background_tasks → false (fail-open)', () => {
  assert.equal(hasPendingBackgroundWork({}), false);
  assert.equal(hasPendingBackgroundWork({ background_tasks: 'not-an-array' }), false);
  assert.equal(hasPendingBackgroundWork({ background_tasks: [] }), false);
  assert.equal(hasPendingBackgroundWork(null), false);
});

test('a non-empty session_crons → true (scheduled wake is pending work)', () => {
  // No background_tasks key at all — must fire off the session_crons branch.
  assert.equal(
    hasPendingBackgroundWork({ session_crons: [{ id: 'c1', schedule: '* * * * *' }] }),
    true,
  );
});

test('an empty / non-array session_crons → false (fail-open, ignored)', () => {
  assert.equal(hasPendingBackgroundWork({ session_crons: [] }), false);
  assert.equal(hasPendingBackgroundWork({ session_crons: 'not-an-array' }), false);
});

// ── isCloseReconfirmDeclined — order-sensitive decline detection ──
suite('isCloseReconfirmDeclined()');

test('a correlated "아직" AskUserQuestion answer → true (declined)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseReconfirmDeclined(p), true);
  });
});

test('decline followed by a NEW user close signal → false (re-arm)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
      toolUse('Edit'),
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
    ]);
    assert.equal(isCloseReconfirmDeclined(p), false);
  });
});

test('an uncorrelated tool_result containing "아직" (no matching AskUserQuestion) → false', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-1',
              content: 'file.md: "아직"="맞음" (quoted, not a real answer)',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseReconfirmDeclined(p), false);
  });
});

test('decline label variants ("나중에" / "later") also suppress (label-drift defense)', () => {
  withTmpDir((dir) => {
    const p1 = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content: 'Your questions have been answered: "지금 닫을까요?"="나중에". continue.',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseReconfirmDeclined(p1), true);
  });
  withTmpDir((dir) => {
    const p2 = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content: 'Your questions have been answered: "close now?"="later". continue.',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseReconfirmDeclined(p2), true);
  });
});

// BLOCKER fix (codex pre-commit review): re-arm must fire ONLY on a genuine
// USER-authored close signal, mirroring extractUserMessages' input boundary
// (isMeta / promptSource / tool_result exclusion) — never on the model's own
// reasoning text, which can itself say "세션 마무리".
test('decline, then an ASSISTANT text block saying "세션 마무리" → still declined (no false re-arm)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '알겠습니다, 아직 세션 마무리는 하지 않고 계속 진행하겠습니다.' },
          ],
        },
      },
    ]);
    assert.equal(
      isCloseReconfirmDeclined(p),
      true,
      'assistant reasoning text must not re-arm a recorded decline',
    );
  });
});

test('decline, then a tool_result containing a close phrase → still declined (no false re-arm)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-2',
              content: 'file.md: 예시 문구 "세션 마무리하자" 발견',
            },
          ],
        },
      },
    ]);
    assert.equal(
      isCloseReconfirmDeclined(p),
      true,
      'tool_result content must not re-arm a recorded decline',
    );
  });
});

// MEDIUM fix (codex pre-commit review): only OUR close-reconfirm prompt (the
// AskUserQuestion whose input carries the reconfirm reason's "지금 닫기"
// option label) may correlate — an unrelated AskUserQuestion answered with a
// decline-shaped word ("나중"/"later") must not falsely suppress.
test('an UNRELATED AskUserQuestion answered with "나중" → false (does not correlate)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      askUnrelatedToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "어떤 색을 원하세요?"="나중에 정할게요". continue.',
            },
          ],
        },
      },
    ]);
    assert.equal(
      isCloseReconfirmDeclined(p),
      false,
      'a non-close-reconfirm AskUserQuestion must not suppress the reconfirm',
    );
  });
});

test('the real close-reconfirm prompt ("지금 닫기" in input) + "아직, 계속" answer → true', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      askCloseReconfirmToolUse('q1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'q1',
              content:
                'Your questions have been answered: "지금 세션을 닫을까요?"="아직, 계속". continue.',
            },
          ],
        },
      },
    ]);
    assert.equal(isCloseReconfirmDeclined(p), true);
  });
});

test('no AskUserQuestion answer at all → false (not declined, keep reconfirming)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: '오늘은 이만 마무리하자' } },
      toolUse('Edit'),
    ]);
    assert.equal(isCloseReconfirmDeclined(p), false);
  });
});

test('unreadable / missing transcript → false (fail-open, keep reconfirming)', () => {
  assert.equal(isCloseReconfirmDeclined('/no/such/transcript.jsonl'), false);
  assert.equal(isCloseReconfirmDeclined(null), false);
});

// ── ADR 0055: resolveTranscriptBySessionId — session-id glob, fail-closed ──
suite('resolveTranscriptBySessionId() (ADR 0055)');

test('non-UUID / path-traversal ids → null (no escape from projects root)', () => {
  assert.equal(resolveTranscriptBySessionId('../../etc/passwd'), null);
  assert.equal(resolveTranscriptBySessionId('a/b'), null);
  assert.equal(resolveTranscriptBySessionId(''), null);
  assert.equal(resolveTranscriptBySessionId(null), null);
});

test('a session id that matches no transcript → null (fail-closed)', () => {
  assert.equal(resolveTranscriptBySessionId('00000000-0000-0000-0000-000000000000'), null);
});

test('exactly one match under projectsRoot → resolves; two → null (ambiguity fail-closed)', () => {
  withTmpDir((root) => {
    const sid = '11111111-2222-3333-4444-555555555555';
    const a = join(root, 'proj-a');
    mkdirSync(a, { recursive: true });
    const fa = join(a, `${sid}.jsonl`);
    writeFileSync(fa, '{}\n');
    // single match → resolves to that file (realpath-normalized, so compare by
    // suffix to stay robust to /var → /private/var symlink canonicalization)
    const got = resolveTranscriptBySessionId(sid, root);
    assert.ok(got && got.endsWith(`proj-a/${sid}.jsonl`), `expected proj-a match, got ${got}`);
    // a second distinct file in another project dir → ambiguous → null
    const b = join(root, 'proj-b');
    mkdirSync(b, { recursive: true });
    writeFileSync(join(b, `${sid}.jsonl`), '{}\n');
    assert.equal(resolveTranscriptBySessionId(sid, root), null);
  });
});

// ── 6a: substantial-session gate (read-only investigation volume) ──
suite('isSubstantialSession() / hasMutatingTranscriptActivity()');

function writeJsonl(dir, entries) {
  const path = join(dir, `t-${Math.random().toString(36).slice(2, 8)}.jsonl`);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return path;
}

function toolUse(name) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } };
}

// An unrelated AskUserQuestion (no close-reconfirm label) — used to prove a
// random question's decline-shaped answer must NOT correlate.
function askUnrelatedToolUse(id) {
  return {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'AskUserQuestion',
          id,
          input: { questions: [{ question: '어떤 색을 원하세요?', options: ['빨강', '파랑'] }] },
        },
      ],
    },
  };
}

test('mutation tool → substantial AND mutating', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [toolUse('Edit')]);
    assert.equal(hasMutatingTranscriptActivity(p), true);
    assert.equal(isSubstantialSession(p), true);
  });
});

test('read-only below threshold (4 investigation) → NOT substantial', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [toolUse('Read'), toolUse('Grep'), toolUse('Glob'), toolUse('Bash')]);
    assert.equal(hasMutatingTranscriptActivity(p), false, 'no mutation tool');
    assert.equal(isSubstantialSession(p), false, '4 < threshold 5');
  });
});

test('read-only at threshold (5 investigation) → substantial, still NOT mutating', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      toolUse('Read'),
      toolUse('Grep'),
      toolUse('Glob'),
      toolUse('Read'),
      toolUse('Grep'),
    ]);
    assert.equal(
      hasMutatingTranscriptActivity(p),
      false,
      'read-only never trips the mutation oracle',
    );
    assert.equal(isSubstantialSession(p), true, '5 >= threshold 5');
  });
});

test('Bash-only at threshold (5) → substantial (Bash counts as investigation)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(
      dir,
      Array.from({ length: 5 }, () => toolUse('Bash')),
    );
    assert.equal(isSubstantialSession(p), true, 'Bash-dominant read-only session is substantial');
  });
});

test('missing / null transcript → not substantial (fail-open)', () => {
  withTmpDir((dir) => {
    assert.equal(isSubstantialSession(null), false);
    assert.equal(isSubstantialSession(join(dir, 'nope.jsonl')), false);
  });
});

suite('isGateSkipped()');

test('HYPO_SKIP_GATE=1 → true', () => {
  const orig = process.env.HYPO_SKIP_GATE;
  process.env.HYPO_SKIP_GATE = '1';
  try {
    assert.equal(isGateSkipped(), true);
  } finally {
    orig === undefined ? delete process.env.HYPO_SKIP_GATE : (process.env.HYPO_SKIP_GATE = orig);
  }
});

test('no env var → false', () => {
  const o1 = process.env.HYPO_SKIP_GATE;
  delete process.env.HYPO_SKIP_GATE;
  try {
    assert.equal(isGateSkipped(), false);
  } finally {
    if (o1 !== undefined) process.env.HYPO_SKIP_GATE = o1;
  }
});

suite('buildOutput()');

test('wraps context in additionalContext field', () => {
  const out = buildOutput('test context');
  assert.equal(out.additionalContext, 'test context');
});

test('merges extra fields alongside additionalContext', () => {
  const out = buildOutput('ctx', { continue: true });
  assert.equal(out.continue, true);
  assert.equal(out.additionalContext, 'ctx');
});

// ── A1: overdue verify_by_date predicate + STALE marker (freshness) ──────────
suite('hypo-shared.mjs — overdue predicate + STALE marker (A1)');

test('isOverdueDate: past ISO date is overdue', () => {
  assert.equal(isOverdueDate('2020-01-01', '2026-07-02'), true);
});

test('isOverdueDate: future and today are not overdue', () => {
  assert.equal(isOverdueDate('2030-01-01', '2026-07-02'), false);
  assert.equal(isOverdueDate('2026-07-02', '2026-07-02'), false);
});

test('isOverdueDate: malformed date is not overdue', () => {
  assert.equal(isOverdueDate('2020-1-1', '2026-07-02'), false);
  assert.equal(isOverdueDate('not-a-date', '2026-07-02'), false);
  assert.equal(isOverdueDate('', '2026-07-02'), false);
  assert.equal(isOverdueDate(null, '2026-07-02'), false);
});

test('staleMarkerFor: overdue verify_by_date yields marker', () => {
  const raw = '---\ntype: page\nverify_by_date: 2020-01-01\n---\n# body';
  assert.equal(staleMarkerFor(raw, '2026-07-02'), '[STALE verify_by_date=2020-01-01]');
});

test('staleMarkerFor: future/absent/malformed verify_by_date yields empty', () => {
  assert.equal(staleMarkerFor('---\nverify_by_date: 2030-01-01\n---\nx', '2026-07-02'), '');
  assert.equal(staleMarkerFor('---\ntype: page\n---\nx', '2026-07-02'), '');
  assert.equal(staleMarkerFor('---\nverify_by_date: 2020-1-1\n---\nx', '2026-07-02'), '');
  assert.equal(staleMarkerFor('no frontmatter at all', '2026-07-02'), '');
});

test('staleMarkerFor: legacy date in verify_by (not verify_by_date) yields empty', () => {
  // verify_by holds the question, never a date. A date parked there must not
  // trigger STALE (D1: only verify_by_date is a deadline).
  const raw = '---\ntype: page\nverify_by: 2020-01-01\n---\n# body';
  assert.equal(staleMarkerFor(raw, '2026-07-02'), '');
});

test('staleMarkerFor: strips a trailing YAML comment (doctor parity)', () => {
  // doctor parses via frontmatter.mjs, which strips `\s+#.*`. staleMarkerFor must
  // match, or an overdue page with an inline comment silently loses its marker.
  const raw = '---\ntype: page\nverify_by_date: 2020-01-01 # yearly recheck\n---\n# body';
  assert.equal(staleMarkerFor(raw, '2026-07-02'), '[STALE verify_by_date=2020-01-01]');
  const quoted = '---\nverify_by_date: "2020-01-01" # note\n---\nx';
  assert.equal(staleMarkerFor(quoted, '2026-07-02'), '[STALE verify_by_date=2020-01-01]');
  // doctor's parser splits on the first colon, so `key : value` is tolerated.
  const spaced = '---\nverify_by_date : 2020-01-01\n---\nx';
  assert.equal(staleMarkerFor(spaced, '2026-07-02'), '[STALE verify_by_date=2020-01-01]');
});

test('verify.mjs stays independent of the shared predicate (A1 invariant)', () => {
  // The shared predicate must not be silently unified into verify.mjs, whose
  // missing-short-circuit (verify_by absent → missing) is a distinct contract.
  const verifySrc = readFileSync(join(REPO, 'scripts', 'verify.mjs'), 'utf-8');
  assert.ok(
    !/hypo-shared/.test(verifySrc),
    'verify.mjs must not import hypo-shared (overdue set stays distinct)',
  );
});

// ── B1: page-usage logging coverage guard (fail-closed) ──────────────────────
suite('hypo-shared.mjs — page-usage logging guard (B1)');

// Fake probes stand in for the real `spawnSync('git', ['check-ignore', ...])`
// call: same shape (`{ status }` or a throw/null for "never answered"), no
// subprocess. That makes the guard's own branching deterministic — the flake
// this suite used to have came from racing a real git process across 278
// concurrent shards, not from the guard logic itself. `runGitCheckIgnore`
// (the production default in hypo-shared.mjs) is exercised separately, below,
// by the one real-git integration test.
const fakeProbe = (status) => () => ({ status });
const fakeProbeThrows = () => {
  throw new Error('spawn failed');
};

// A probe that records whether it was consulted. Needed because a *throwing*
// probe cannot prove "the guard short-circuited before the probe": the guard
// wraps the call in `try/catch` and turns a throw into `probe = null`, which
// then returns `false` — the same answer the short-circuit gives. So a test
// asserting `false` passes whether or not the probe ran. Counting the calls is
// what actually distinguishes the two, and it is the only way to pin that the
// composite guard never pays for a subprocess once .hypoignore has already
// denied. Verified by re-running the short-circuit regression proof against it.
const countingProbe = (status) => {
  const fn = () => {
    fn.calls += 1;
    return { status };
  };
  fn.calls = 0;
  return fn;
};

test('guard true when both .gitignore and .hypoignore cover .cache/', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-both', fakeProbe(0)), true);
  });
});

// A probe that never answered is not the same as git saying "not ignored".
// check-ignore exits 0 (ignored) or 1 (not ignored); 128 means git errored out,
// and a null status means the timeout fired or the spawn failed outright — which
// is what a machine under heavy process load produces. The old code collapsed
// all of those into `false` and then cached it, so one blip kept logging
// disabled for the whole session even after the cause cleared. That is the
// flake this test pins: simulated here instead of raced, so it is deterministic
// and instant instead of depending on the real 10s timeout ever firing.
test('an inconclusive git probe records an outage, never a verdict', () => {
  withTmpDir((dir) => {
    const sessionId = 'b1-inconclusive';
    const cachePath = pageUsageGuardCachePath(sessionId, dir);
    try {
      writeFileSync(join(dir, '.hypoignore'), '.cache/\n');

      // status 128 (git errored) is one shape of "never answered".
      assert.equal(pageUsageLoggingAllowed(dir, sessionId, fakeProbe(128)), false);
      const recorded = JSON.parse(readFileSync(cachePath, 'utf-8'));
      assert.equal(
        recorded.gitIgnored,
        undefined,
        'an unanswered probe must never be written down as an answer',
      );
      assert.equal(typeof recorded.unavailableUntil, 'number');

      // The outage stamp suppresses re-probing while it stands: a probe that
      // would now say "ignored" is still not consulted, proving the backoff
      // — not the probe — is what answered `false` here.
      assert.equal(pageUsageLoggingAllowed(dir, sessionId, fakeProbe(0)), false);

      // A thrown spawn (the other shape of "never answered": spawnSync itself
      // failing) is inconclusive the same way once the backoff lapses.
      writeFileSync(cachePath, JSON.stringify({ unavailableUntil: Date.now() - 1 }));
      assert.equal(pageUsageLoggingAllowed(dir, sessionId, fakeProbeThrows), false);

      // Once the backoff lapses and the probe finally answers, the verdict is
      // recomputed rather than served from the outage — the old code cached
      // `false` here and never recovered.
      writeFileSync(cachePath, JSON.stringify({ unavailableUntil: Date.now() - 1 }));
      assert.equal(pageUsageLoggingAllowed(dir, sessionId, fakeProbe(0)), true);
    } finally {
      rmSync(cachePath, { force: true });
    }
  });
});

// `{ status: null }` is the shape spawnSync actually returns when the timeout
// fires, and a fired timeout under process load is the exact flake that opened
// ISSUE-79 — yet nothing pinned it: the test above covers 128 and a throw only.
// Narrowing the guard to `status === 128` would keep every one of those green
// while reintroducing the original bug, so this walks the null path end to end.
suite('hypo-shared.mjs — page-usage guard, timed-out probe (B1b)');

test('a timed-out probe ({ status: null }) is an outage, not a "not ignored" answer', () => {
  withTmpDir((dir) => {
    const sessionId = 'b1b-timeout';
    const cachePath = pageUsageGuardCachePath(sessionId, dir);
    try {
      writeFileSync(join(dir, '.hypoignore'), '.cache/\n');

      assert.equal(pageUsageLoggingAllowed(dir, sessionId, fakeProbe(null)), false);
      const recorded = JSON.parse(readFileSync(cachePath, 'utf-8'));
      assert.equal(
        recorded.gitIgnored,
        undefined,
        'a timed-out probe must never be written down as an answer',
      );
      assert.equal(typeof recorded.unavailableUntil, 'number');

      // While the outage stands, a probe that would now answer "ignored" is not
      // even called — the backoff is what suppresses the next subprocess, which
      // is the whole point of not paying a timeout on every prompt.
      const probe = countingProbe(0);
      assert.equal(pageUsageLoggingAllowed(dir, sessionId, probe), false);
      assert.equal(probe.calls, 0, 'the backoff must suppress the probe, not just its verdict');

      // Once it lapses, the guard recovers on its own.
      writeFileSync(cachePath, JSON.stringify({ unavailableUntil: Date.now() - 1 }));
      assert.equal(pageUsageLoggingAllowed(dir, sessionId, fakeProbe(0)), true);
    } finally {
      rmSync(cachePath, { force: true });
    }
  });
});

// Without a session id the cache key collapses to `default`, so one session's
// verdict would answer for the next — and nothing expires the file. The guard
// re-probes instead, which is what lets removed .gitignore coverage take effect.
test('no session id → the git verdict is not cached at all', () => {
  withTmpDir((dir) => {
    const cachePath = pageUsageGuardCachePath(undefined, dir);
    try {
      rmSync(cachePath, { force: true });
      writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
      assert.equal(pageUsageLoggingAllowed(dir, undefined, fakeProbe(0)), true);
      assert.ok(!existsSync(cachePath), 'an unscoped verdict must not be written');

      // Coverage removed (probe now answers "not ignored") → the next call
      // must see it, not a stale `true` served from a cache.
      assert.equal(pageUsageLoggingAllowed(dir, undefined, fakeProbe(1)), false);
    } finally {
      rmSync(cachePath, { force: true });
    }
  });
});

test('guard false when only .gitignore covers .cache/ (both signals required)', () => {
  withTmpDir((dir) => {
    // No .hypoignore → the composite guard must short-circuit before it ever
    // reaches the probe. Count the calls rather than throwing from the probe:
    // the guard swallows a throw into `probe = null` and returns `false`, which
    // is the same answer the short-circuit gives, so a throwing probe cannot
    // tell the two apart.
    const probe = countingProbe(0);
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-git-only', probe), false);
    assert.equal(probe.calls, 0, 'a denied .hypoignore must short-circuit before the probe');
  });
});

test('guard false when only .hypoignore covers .cache/', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    // .hypoignore alone clears the short-circuit; the probe still has to say
    // "not ignored" for the composite verdict to be false.
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-hypo-only', fakeProbe(1)), false);
  });
});

test('guard false in a non-git vault (fail-closed)', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    // A non-repo vault is exactly what makes check-ignore exit 128 in real git;
    // fakeProbe(128) simulates that without needing an actual non-repo dir.
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-nogit', fakeProbe(128)), false);
  });
});

test('git probe is cached per session (no recompute of the git signal)', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-cache', fakeProbe(0)), true);
    const cachePath = pageUsageGuardCachePath('b1-cache', dir);
    assert.ok(existsSync(cachePath), 'guard must write a session cache file');
    // A second call with a probe that would now say "not ignored" must still
    // read `true` from the cache, proving the 2nd call skipped the probe.
    assert.equal(
      pageUsageLoggingAllowed(dir, 'b1-cache', fakeProbe(1)),
      true,
      'git signal must be cached',
    );
  });
});

test('privacy: removing .hypoignore mid-session flips the guard closed', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-privacy', fakeProbe(0)), true);
    // .hypoignore is the load-bearing commit gate and is re-checked fresh every
    // call: dropping it must immediately deny logging even within the session,
    // before the (still "ignored") probe is ever consulted again.
    rmSync(join(dir, '.hypoignore'));
    const probe = countingProbe(0);
    assert.equal(
      pageUsageLoggingAllowed(dir, 'b1-privacy', probe),
      false,
      'a mid-session .hypoignore removal must fail closed',
    );
    // What stops the probe here is the .hypoignore short-circuit, which runs
    // before the cache is ever consulted (pageUsageLoggingAllowed returns on
    // `!hypoIgnored` before calling gitIgnoresPageUsageCached at all).
    // But this assertion does not *pin* that: the first call above already
    // cached a verdict for this session, so removing the short-circuit still
    // leaves the cache to answer without a subprocess, and the count stays 0.
    // Confirmed by regression proof — forcing the probe call ahead of the
    // short-circuit failed b1-git-only and left this test green. So what this
    // pins is "the denial costs no subprocess"; the short-circuit itself is
    // pinned by b1-git-only, which has no cache to hide behind.
    assert.equal(probe.calls, 0, 'and the denial must cost no subprocess');
  });
});

// The one place *this suite* still spawns a real `git check-ignore` — not the
// only one in the test tree. The B2 hook E2E tests in tests/lookup-usage.test.mjs
// run hypo-lookup.mjs as a child process, and that hook calls the guard with two
// args, so it takes the default probe and spawns real git too. Those cannot take
// an injected probe (the seam does not cross a process boundary) and real git is
// the point of a hook E2E, so the shard-load exposure is reduced here, not
// eliminated tree-wide. Recorded on ISSUE-79 rather than papered over.
//
// Unscoped so the guard's session cache is never touched: two independent real
// probes (ignored, then not-ignored) with no shared state between them. That
// removes cache contention, not process contention.
test('real git check-ignore: ignored/not-ignored round trip (integration)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, undefined), true);

    writeFileSync(join(dir, '.gitignore'), 'unrelated/\n');
    assert.equal(pageUsageLoggingAllowed(dir, undefined), false);
  });
});

suite('hypo-shared.mjs — session-scoped lint (Bug A/B)');

test('partitionLintScope: in-scope error blocks, out-of-scope error → notice', () => {
  const findings = [
    { file: 'projects/p/session-state.md', message: 'bad' },
    { file: 'pages/feedback/other.md', message: 'Unknown tag: "x"' },
  ];
  const scope = new Set(['projects/p/session-state.md']);
  const { blocking, notice } = partitionLintScope(findings, scope);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].file, 'projects/p/session-state.md');
  assert.equal(notice.length, 1);
  assert.equal(notice[0].file, 'pages/feedback/other.md');
});

test('partitionLintScope: scope membership is separator-normalized (Windows path safety)', () => {
  // lint.mjs emits `file` via path.relative — back-slashes on Windows — while the
  // scope builders use forward slashes. Both sides are normalized so an in-scope
  // error is never misclassified as out-of-scope (which would weaken the gate).
  const findings = [{ file: 'projects\\p\\session-state.md', message: 'bad' }];
  const scope = new Set(['projects/p/session-state.md']);
  const { blocking, notice } = partitionLintScope(findings, scope);
  assert.equal(blocking.length, 1);
  assert.equal(notice.length, 0);
});

test('closeFileTargets: returns the 5 mandatory close files for the active project', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, 'hot.md'), '| proj | 2026-06-07 | [[projects/proj/hot]] |\n');
    const t = closeFileTargets(dir);
    assert.ok(t.has('hot.md'));
    assert.ok(t.has('log.md'));
    assert.ok(t.has('projects/proj/session-state.md'));
    assert.ok(t.has('projects/proj/hot.md'));
    assert.ok([...t].some((f) => /^projects\/proj\/session-log\/\d{4}-\d{2}-\d{2}\.md$/.test(f)));
  });
});
