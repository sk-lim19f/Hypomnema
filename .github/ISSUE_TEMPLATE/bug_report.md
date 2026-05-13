---
name: Bug report
about: Something broke. Report it so it can be reproduced and fixed.
title: "bug: <one-line summary>"
labels: bug
assignees: ''
---

## What happened

<!-- One or two sentences. What did you expect, what actually happened. -->

## Repro

<!-- Smallest steps that reproduce the bug. Paste exact commands. -->

1.
2.
3.

## Environment

- Hypomnema version: <!-- `npm ls -g hypomnema` or the plugin version -->
- Install path: <!-- Claude Code plugin / npm CLI / clone -->
- Node version: <!-- `node -v` -->
- OS: <!-- macOS / Linux / Windows + version -->
- Claude Code version: <!-- if known -->

## Diagnostics

<!-- Paste the output of these two commands. They're safe — no transcript text or secrets. -->

```
hypomnema upgrade --check 2>&1
```

```
node scripts/doctor.mjs 2>&1   # or: /hypo:doctor inside Claude Code
```

## Logs / screenshots

<!-- Any extra detail. If a hook misfired, paste the relevant `settings.json` block. -->
