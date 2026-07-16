# Multi-agent orchestration patterns

A shared vocabulary for designing multi-agent work. `/hypo:debate` is one instance of it
(the producer-reviewer pattern). When you orchestrate several agents around your wiki work,
name the pattern first, then build.

The one selection rule: **does the next stage need a barrier?** If not, pipeline. If it must
see everything at once, fan-out / fan-in. If several angles look at the same target, expert
pool. If one agent must grade another's output, producer-reviewer. If one place must hold the
decision, supervisor. If delegation spawns more delegation, hierarchical.

## 1. Pipeline

Each item flows through the stages independently. No barrier between stages, so item A can be
in stage 3 while item B is still in stage 1. With enough parallel capacity, wall-clock trends
toward the slowest single-item chain rather than the sum of per-stage worsts (setting aside
pipeline fill and drain). With limited capacity, items queue and it degrades toward the
barrier case.

- Use when: every item runs the same chain and items do not wait on each other (per-file
  transforms, a find then fix then verify done per item).
- Mistake: adding a barrier because you think a stage needs all prior results. That is
  fan-out / fan-in, not a pipeline. Do any flatten / map / filter inside a stage.

## 2. Fan-out / fan-in

Spread work in parallel (fan-out), then gather all of it at a barrier (fan-in) to merge,
dedup, or aggregate. Justified only when stage N needs every result of stage N-1 together.

- Use when: dedup across the full set before an expensive downstream step, early-exit when
  the total is zero, or a result that must be compared against all the others.
- Mistake: forgetting the barrier's wait cost. Fast workers idle waiting on slow ones. Use it
  only when you genuinely need all results.

## 3. Expert pool

Several agents look at the same target through **different lenses** at once. Each holds a
different expertise (correctness, security, performance, reproducibility) or a different
viewpoint, blind to what the others see.

- Use when: one search angle cannot find everything, or a defect can break in more than one
  way. The goal is **perspective diversity**, not redundant voting.
- Mistake: giving N agents the same prompt and calling it an expert pool. That is just
  redundancy. The lenses must actually differ.

## 4. Producer-reviewer

A producer makes something and an **independent** reviewer verifies it adversarially. Use it
when the maker should not grade their own work. Prompt the reviewer to find why it is wrong
first. `/hypo:debate` is this pattern applied to one claim.

- Use when: catching defects in a change, a design, or an artifact from a fresh context.
- Mistake: handing the reviewer the producer's rationale. The reviewer should see the target,
  not the conclusion, to stay independent. Do not accept the review uncritically; the final
  call stays with the orchestrator.

## 5. Supervisor

One orchestrator delegates to workers and integrates the results. The **decision and the
human gate stay with the orchestrator**; only the heavy execution goes down.

- Use when: keeping the main context for decisions while isolating large raw material or
  diffs in subagents. When you delegate, hand over everything the main context knows: the
  goal, the read / write scope, the constraints already confirmed, the verify command, the
  return schema.
- Mistake: treating a worker's output as evidence. It is a candidate. Trust it blindly and
  you get a phantom backlog.

## 6. Hierarchical delegation

A tree of delegation: a higher worker re-delegates to lower ones. Splits a large problem into
sub-problems handled by depth.

- Use when: a breadth or depth one orchestrator cannot hold (a large migration, a broad
  audit).
- Mistake: allowing unbounded nesting depth. Keep the hierarchy to a controlled one or two
  levels, and do not let a subagent open its own sub-delegation without a reason.

## When not to reach for multi-agent at all

If the main context already holds the material and the task finishes faster than the delegation
overhead, do it inline. Before picking a pattern, ask whether the work is worth splitting. Most
single lookups are not.
