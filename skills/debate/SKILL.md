---
description: Structured debate to re-verify a wiki knowledge claim before you trust it, or to harden a hard-to-reverse decision into a durable wiki record. Runs a fixed order (interrogate, then verify against code and docs, then synthesize). Use when hypo:verify flags a page as overdue and you need to actually re-check its claim, when a decision is hard to reverse (architecture, refactor, external API integration) and should leave an ADR, or when the user asks to "debate", "stress-test", or "verify this claim". Skip it for reversible or already-obvious calls.
---

You are running `/hypo:debate`. It formalizes an informal practice (a two-worker adversarial
review) into a reproducible fixed order, so the same rigor applies every time.

The premise: separate the mind that **generates and interrogates** from the mind that
**verifies**. Interrogation without verification lets a plausible wrong answer survive;
verification without interrogation confirms a wrong premise with precision. The order is
fixed for that reason.

The debate always ends in a durable wiki artifact: a refreshed page, a correction, or an
ADR. A debate that leaves nothing on disk was just a conversation. This is the producer
reviewer pattern applied to a single claim; for the orchestration vocabulary it belongs to,
see [references/orchestration-patterns.md](references/orchestration-patterns.md).

## Two uses

1. **Re-verify a wiki claim (primary).** `/hypo:verify` surfaces pages whose `verify_by_date`
   is overdue (or that carry no `verify_by` question at all). This skill is the deep re-check
   behind that prompt: does the page's `verify_by` question still hold against the current
   code and docs? The outcome updates the page exactly as `/hypo:verify` Step 4 does (see
   below), with the debate supplying the evidence.
2. **Harden a hard-to-reverse decision.** Architecture choices, refactor direction, external
   API or dependency integration, where the first-pass answer is often wrong (concurrency,
   migrations, security boundaries, distributed state). The decision must land as an ADR or a
   wiki page; if it would not, it is not big enough for a debate.

## When not to use

- A change whose diff you can state in one sentence. Just do it.
- A reversible call, an already-obvious choice, or a one-off lookup. The debate's fixed cost
  exceeds its value.

## Fixed three phases

### Phase 1. Interrogate (do not answer yet)

Attack the claim or decision. Build a list of questions, not conclusions.

- Surface hidden assumptions: "this rests on X being true. What if X is false?"
- Stand up at least two alternatives (three including the incumbent). Best and worst case of
  each.
- List failure modes: how does this decision bite six months from now?
- Output: a list of **falsifiable claims**. Each must be resolvable to true / false by code,
  docs, or a command ("p95 under 50ms", not "it will be fast"). For a wiki claim, restate the
  page's `verify_by` question in a form you can actually check against the current code or
  docs.

### Phase 2. Verify (against code, docs, and the wiki)

Check each Phase 1 claim, one at a time. Do not invent new claims here.

- Read the code, find the docs, run the command. Judge each claim true / false / unknown.
- Unknown is unknown. A zero-result grep is not proof of absence.
- For a wiki claim, check it against the page's own cited sources and the code or docs it
  describes, not against memory.
- For genuine independence, hand this phase to a reviewer who did not run the interrogation
  (a fresh-context subagent, or a second person). Self-review of your own interrogation
  breeds confirmation bias.
- Output: a **per-claim verdict table** (claim, verdict, evidence line or command).

### Phase 3. Synthesize

Reconcile Phases 1 and 2 into one outcome, and write it down.

- Build the conclusion only from claims that survived verification. For each rejected
  alternative, leave one line on why it fell.
- Name the residual risk (remaining unknowns, fail-open points) alongside the outcome. Do not
  hide it.
- Land the durable artifact:
  - Wiki claim: answer the page's `verify_by` question **yes / no / partially**. On yes,
    refresh `last_reviewed` to today and push `verify_by_date` forward. On no or partially,
    edit the page to correct it, then refresh both fields. This is exactly `/hypo:verify`
    Step 4; the debate is what earns the answer.
  - Decision: record it as an ADR (or a wiki page) holding the **decision, rationale, and
    residual risk**. That record, not the discussion, is the deliverable.

## Execution notes

- Run the three phases inline in order, or split only Phase 2 out to an independent reviewer.
  That independence contributes the most to decision quality (the verifier's fresh context).
- Keep the boundary between interrogation (1) and verification (2). If a new alternative
  occurs during verification, note it for Phase 1 and finish verifying the current claims
  before opening a new round. Mixing the two blurs both.
- Do not accept a reviewer's verdict uncritically. The final call at synthesis stays with the
  person running the debate.
