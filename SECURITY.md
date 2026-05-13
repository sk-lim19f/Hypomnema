# Security Policy

## Supported versions

Hypomnema is a single-author OSS project on the 1.x line. Security fixes
land on the latest minor; older minors are not back-ported.

| Version | Supported          |
|---------|--------------------|
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a vulnerability

**Do not open a public issue.** Use one of the private channels:

- GitHub private vulnerability reporting:
  <https://github.com/sk-lim19f/Hypomnema/security/advisories/new>
- Email: limsangkyu0219@gmail.com

Please include:

- A description of the issue and its impact.
- Reproduction steps or a minimal proof-of-concept.
- The Hypomnema version (`npm ls -g hypomnema` or the plugin version)
  and the Node / OS combination you hit it on.
- Whether the issue requires a specific install path (npm CLI vs. Claude
  Code plugin) or specific hook configuration to trigger.

You should expect:

- An acknowledgement within **7 days**.
- A disclosure plan (fix timeline, advisory, credit) within **30 days**
  for confirmed issues.

## Threat model — what's in scope

Hypomnema runs locally and writes to two trust zones:

1. The **wiki vault** (default `~/hypomnema`) — markdown the user owns.
2. The **Claude Code config** (`~/.claude/`) — hooks, `settings.json`,
   and the slash command directory under `~/.claude/commands/hypo/`.

In scope, please report:

- Path traversal or symlink-following in `init` / `upgrade` / `uninstall`
  that could write or delete files outside the resolved wiki vault or
  `~/.claude/hypo*` namespace.
- `settings.json` merge logic that produces invalid JSON, drops
  unrelated user hooks, or registers a hook outside the documented
  event set.
- Hook scripts that, when fired by Claude Code, read or transmit
  content outside the wiki vault and the explicit "additionalContext"
  payload (the privacy contract — see
  `tests/runner.mjs` "weekly-report.mjs — privacy contract").
- Any flow where ingesting an untrusted URL or file path could cause
  Hypomnema to execute that content as code.

## Out of scope

- Vulnerabilities in Claude Code itself, in `npm`, in Node.js, or in
  GitHub Actions runners. Report those upstream.
- Issues that require an attacker who already has write access to your
  home directory.
- Markdown content that produces a misleading rendering in third-party
  viewers (Hypomnema does not control rendering).
- Anything that requires modifying the installed package source on
  disk before the attack.

## Disclosure preference

Coordinated disclosure. The reporter and the maintainer agree on a
publication date; the advisory and the fix go out together, with credit
to the reporter unless they request otherwise.
