<!--
Thanks for the PR. Please fill out the sections below — they map 1:1 to
the PR checklist in docs/CONTRIBUTING.md.
-->

## What changed

<!-- Short summary. What does this PR do? -->

## Why

<!-- User-visible motivation. What problem does this solve? -->

## How

<!-- Brief notes on the approach — only the parts that aren't obvious from the diff. -->

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

## Checklist

- [ ] `npm test` passes locally
- [ ] `npm run lint` passes locally
- [ ] README / ARCHITECTURE / docs updated if user-facing behavior changed
- [ ] CHANGELOG.md updated under `[Unreleased]` if user-visible
- [ ] One logical change per PR (rebase / split if necessary)
- [ ] Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, …)
