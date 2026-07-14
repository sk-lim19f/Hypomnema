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
  extractUserMessages,
  gitRepo,
  hasMutatingTranscriptActivity,
  hasPendingBackgroundWork,
  hasUserCloseSignal,
  isClearCommand,
  isClosePattern,
  isCloseReconfirmDeclined,
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

// ── ADR 0055: hasUserCloseSignal — the marker-writer hard gate ──
suite('hasUserCloseSignal() (ADR 0055)');

test('NL close phrase anywhere in the full transcript → true', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: '작업 시작하자' } },
      toolUse('Edit'),
      { type: 'user', message: { role: 'user', content: '세션 마무리 해줘' } },
    ]);
    assert.equal(hasUserCloseSignal(p), true);
  });
});

test('/compact queue-operation → true', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: '계속' } },
      { type: 'queue-operation', operation: 'enqueue', content: '/compact' },
    ]);
    assert.equal(hasUserCloseSignal(p), true);
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
    assert.equal(hasUserCloseSignal(p), true);
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
    assert.equal(hasUserCloseSignal(p), false);
  });
});

test('no close signal (model self-close / over-close) → false', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { type: 'user', message: { role: 'user', content: 'ingest 해줘' } },
      toolUse('Write'),
    ]);
    assert.equal(hasUserCloseSignal(p), false);
  });
});

test('injected close phrase (isMeta) does NOT satisfy the gate', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      { isMeta: true, type: 'user', message: { role: 'user', content: '… "close the session" …' } },
      { type: 'user', message: { role: 'user', content: '버그 고쳐줘' } },
    ]);
    assert.equal(hasUserCloseSignal(p), false);
  });
});

test('unreadable / missing transcript → false (fail-closed)', () => {
  assert.equal(hasUserCloseSignal('/no/such/transcript.jsonl'), false);
  assert.equal(hasUserCloseSignal(null), false);
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

test('guard true when both .gitignore and .hypoignore cover .cache/', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-both'), true);
  });
});

test('guard false when only .gitignore covers .cache/ (both signals required)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-git-only'), false);
  });
});

test('guard false when only .hypoignore covers .cache/', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-hypo-only'), false);
  });
});

test('guard false in a non-git vault (fail-closed)', () => {
  withTmpDir((dir) => {
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-nogit'), false);
  });
});

test('git probe is cached per session (no recompute of the git signal)', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-cache'), true);
    const cachePath = pageUsageGuardCachePath('b1-cache', dir);
    assert.ok(existsSync(cachePath), 'guard must write a session cache file');
    // Remove .gitignore coverage. A fresh git probe would now say "not ignored",
    // but the git signal is cached, so with .hypoignore still present the verdict
    // stays true, proving the 2nd call skipped the git subprocess.
    rmSync(join(dir, '.gitignore'));
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-cache'), true, 'git signal must be cached');
  });
});

test('privacy: removing .hypoignore mid-session flips the guard closed', () => {
  withTmpDir((dir) => {
    gitRepo(dir);
    writeFileSync(join(dir, '.gitignore'), '.cache/\n');
    writeFileSync(join(dir, '.hypoignore'), '.cache/\n');
    assert.equal(pageUsageLoggingAllowed(dir, 'b1-privacy'), true);
    // .hypoignore is the load-bearing commit gate and is re-checked fresh every
    // call: dropping it must immediately deny logging even within the session.
    rmSync(join(dir, '.hypoignore'));
    assert.equal(
      pageUsageLoggingAllowed(dir, 'b1-privacy'),
      false,
      'a mid-session .hypoignore removal must fail closed',
    );
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
