// Feedback page `scope:` field vocabulary — shared single source of truth.
//
// Consumed by:
//   - scripts/lint.mjs      (lint-time validation of feedback page frontmatter)
//   - scripts/feedback.mjs  (create-time --scope validation in /hypo:feedback)
// Keep this the ONLY definition; both consumers import it so the two validators
// never drift. feedback-sync.mjs matches scope by plain string
// equality (not this regex), so it is intentionally not a consumer.
//
// Accepts `global` or `project:<id>`. The `<id>` charset matches what
// deriveProjectId() (feedback-sync.mjs) emits from a cwd: `/` and `.` are both
// replaced with `-`, producing leading-dash, mixed-case ids like
// `-Users-you-Workspace-Project`. So the class allows a leading `-`, mixed case,
// and `_`/`-` — but deliberately NOT `.`:
//   - deriveProjectId never emits `.` (it is replaced), so excluding it loses
//     nothing for the derived path; and
//   - the resolved project-id is path-joined in feedback-sync.mjs:213, so keeping
//     `.` out of the vocabulary avoids ever blessing `project:.` / `project:..`.
// Known limit: a cwd containing spaces (or other path chars outside [A-Za-z0-9_-])
// still derives an id this regex rejects; pass `--project-id=<id>` for those.
export const FEEDBACK_SCOPE_RE = /^(global|project:[A-Za-z0-9_-]+)$/;
