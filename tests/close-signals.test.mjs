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
suite('hasUserCloseSignal() — measured transcript shapes (ADR 0075)');

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
    assert.equal(hasUserCloseSignal(p), true);
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
    assert.equal(hasUserCloseSignal(p), true);
  });
});

// The delivered /compact, stripped to the companions that must not break it.
// `dequeue` carries no content: the event model must treat it as NEUTRAL, a host
// companion rather than a user event. Same for the interrupt — it is user-SHAPED
// (the harness cutting the model off to run the compaction) but it is not a user
// decision, so it must be neutralized structurally on interruptedMessageId. A
// naive "any user event after the grant invalidates it" rule would reject the
// only observed delivered /compact (n=1 — one observation proves no more).
test('acceptance: delivered /compact with neutral companions → true (must STAY granted)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [
      QOP('enqueue', '/compact'),
      QOP('dequeue'),
      USER({
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        interruptedMessageId: 'msg_1',
      }),
    ]);
    assert.equal(hasUserCloseSignal(p), true);
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
    assert.equal(hasUserCloseSignal(p), false);
  });
});

test('measured: /clear enqueue → false (abandons context; not a close)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [QOP('enqueue', '/clear')]);
    assert.equal(hasUserCloseSignal(p), false);
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
    assert.equal(hasUserCloseSignal(p), true);
  });
});

// DEFECT (fail-open). popAll is the op that actually cancels: measured 6 of 7
// user enqueues followed by popAll were never delivered by any mechanism. Yet
// the gate matches on `type` + `content` and never reads `operation`, so a
// popAll carrying /compact grants anyway. popAll does carry content in the
// corpus, so the shape is reachable — though this exact pairing, like the one
// above, is composed rather than observed.
test('acceptance: popAll carrying /compact → true (DEFECT: operation is never checked)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [QOP('popAll', '/compact')]);
    assert.equal(hasUserCloseSignal(p), true);
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

test('measured: NL close via the remove path, human origin (2.1.181+) → false (GAP: a real user close is invisible)', () => {
  withTmpDir((dir) => {
    const p = REMOVE_DELIVERY(dir, {
      origin: { origin: { kind: 'human' } },
      version: '2.1.207',
      removeContent: true,
      companions: [HOOK_SUCCESS],
    });
    assert.equal(hasUserCloseSignal(p), false);
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
    assert.equal(hasUserCloseSignal(p), false);
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
    assert.equal(hasUserCloseSignal(p), true);
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
    assert.equal(hasUserCloseSignal(p), false);
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
    assert.equal(hasUserCloseSignal(p), false);
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
    assert.equal(hasUserCloseSignal(p), true);
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
    assert.equal(hasUserCloseSignal(p), true);
  });
});

// INVALIDATE. The user closes, then changes their mind and asks for more work.
// The lease must expire. Today it does not: the stale close is still "somewhere
// in the transcript", which is exactly Defect B.
//
// Twice, because the invalidator's own producer field is what a fix will reach
// for. Of the 7 real close→more-work cases, 6 carry human origin on BOTH typed
// records and 1 has origin absent on both (a legacy transcript, same 2.1.181
// boundary as the remove path). A model that invalidates only on
// origin.kind === "human" would pass the first fixture and keep the stale lease
// alive in the seventh real case, which is the failure this pair exists to block.
// Both must flip to false: `typed` is the ADR's producer contract, and it is
// present on both variants.
//
// The distance is elided, not modelled: in the real cases 4–225 records separate
// the close from the next instruction (18–83 for the task-notification fixture
// above, 111 for /clear). What is pinned is the RELATION — a later typed
// instruction expires the lease — not the gap, since no rule should key on it.
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

test('acceptance: close, then the user asks for more work → true (DEFECT: lease must expire)', () => {
  withTmpDir((dir) => {
    assert.equal(hasUserCloseSignal(CLOSE_THEN_WORK(dir, true)), true);
  });
});

test('acceptance: close, then more work, both without origin → true (DEFECT: lease must expire here too)', () => {
  withTmpDir((dir) => {
    assert.equal(hasUserCloseSignal(CLOSE_THEN_WORK(dir, false)), true);
  });
});

// INVALIDATE. /clear after a close abandons the context rather than preserving it.
// It is a different intent, so it must retract the close rather than sit inert.
test('acceptance: close, then /clear → true (DEFECT: /clear must invalidate the lease)', () => {
  withTmpDir((dir) => {
    const p = writeJsonl(dir, [USER(CLOSE), QOP('enqueue', '/clear')]);
    assert.equal(hasUserCloseSignal(p), true);
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
test('acceptance: sidechain mixed text+tool_result carrying a close → true (DEFECT: must never grant)', () => {
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
    assert.equal(hasUserCloseSignal(p), true);
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
