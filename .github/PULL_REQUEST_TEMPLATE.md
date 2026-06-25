<!--
Thanks for the PR. The sections below map 1:1 to the PR checklist in
docs/CONTRIBUTING.md. PR title: Conventional Commits + scope, e.g.
`feat(feedback): add failure_type enum`. Keep any internal tracker id
out of the title and body (see the Changelog block note below).
-->

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

## Changelog

<!--
One English line + one Korean line, only if this change is user-visible.
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

## Migration notes

<!-- If existing installs need special handling on upgrade, describe the path. Otherwise: "None". -->

## Checklist

- [ ] `npm test` passes locally
- [ ] `npm run lint` passes locally
- [ ] README / ARCHITECTURE / docs updated if user-facing behavior changed
- [ ] Filled the `## Changelog` block above (EN + KO line) if the change is user-visible
- [ ] One logical change per PR (rebase / split if necessary)
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, …)
