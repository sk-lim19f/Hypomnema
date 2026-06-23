// Feedback page `failure_type:` field vocabulary — shared single source of truth.
//
// Consumed by:
//   - scripts/lint.mjs      (lint-time enum validation of feedback frontmatter)
//   - scripts/feedback.mjs  (create/append-time --failure-type validation)
// Keep this the ONLY definition; both consumers import it so the two validators
// never drift (mirrors feedback-scope.mjs / ADR 0034). stats.mjs aggregates by
// plain string and does not validate, so it is intentionally not a consumer.
//
// `failure_type` is an OPTIONAL field: it classifies feedback that came from a
// real failure incident. Pure preferences / new conventions ("always do X")
// omit it. Order below is the precedence used when classifying — most specific
// first (a failure that matches several is labeled by the earliest match):
//   hallucination       fabricated a fact / API / path
//   false-completion    declared "done" without running the required gate/test
//   process-stall       stopped instead of asking / continuing when it should
//   over-caution        re-asked / re-gated despite standing authority
//   overreach           acted beyond the requested scope
//   incompleteness      started correctly but omitted a required step / scope
//   instruction-miss    ignored an explicit this-session instruction
//   convention-violation broke a standing documented convention (not restated)
// The runtime does NOT enforce the precedence tree — it only validates that a
// supplied value is one of these eight; classification is a human judgement.
export const FAILURE_TYPE_ENUM = [
  'hallucination',
  'false-completion',
  'process-stall',
  'over-caution',
  'overreach',
  'incompleteness',
  'instruction-miss',
  'convention-violation',
];
