#!/usr/bin/env node
/**
 * hypo-web-fetch-ingest.mjs — PostToolUse hook (fix #2)
 *
 * When the LLM uses WebFetch or WebSearch, nudge it to follow §8.4 path A:
 * "external research → /hypo:ingest into sources/". This hook produces a
 * *signal*, not an automatic ingest call — per spec §5.4.6 Q-5.4.6:
 *   "WebFetch/WebSearch 자동 ingest 시그널은 별도 hook(fix #2)으로 분리."
 *
 * Why signal-only (not direct ingest):
 *   - slug derivation is LLM-driven (commands/ingest.md), so a hook cannot
 *     reliably write to the canonical sources/<slug>.* path.
 *   - duplicate-ingest detection is delegated to /hypo:ingest itself; the
 *     nudge text says "이미 반영 여부 확인 후" so the LLM checks the page
 *     graph before adding a new source.
 *
 * Output contract — Claude Code docs, "Add context for Claude":
 *   PostToolUse uses **nested** hookSpecificOutput.additionalContext, NOT
 *   the top-level additionalContext that UserPromptSubmit hooks use.
 *   buildOutput() in hypo-shared.mjs is the top-level helper used by
 *   hypo-first-prompt / hypo-lookup; intentionally not reused here. See
 *   commit 515458f for the per-event matrix this codebase follows.
 *
 * URL redaction:
 *   additionalContext lands in the transcript. Query strings and
 *   fragments may carry tokens (?token=…, #access_token=…), so we emit
 *   origin + pathname only. Malformed URLs are dropped to avoid raw
 *   echoes.
 *
 * matcher choice:
 *   hooks/hooks.json does not (today) propagate matcher/timeout through
 *   scripts/init.mjs:mergeSettingsJson — the installer rewrites groups
 *   as {hooks:[{type,command}]}. So we filter on tool_name internally
 *   instead of declaring a matcher. Per-tool spawn cost (~39ms node
 *   startup, measured 2026-05-23) is the trade-off; switch to a matcher
 *   when the installer learns to preserve it.
 *
 * Fail-safe (spec §5.4.3 (e)): silent fail + {continue:true,
 * suppressOutput:true}. PostToolUse fires only on successful tool calls;
 * failures arrive on a separate PostToolUseFailure event, so no
 * in-hook failure branch is needed.
 */

import { isGateSkipped } from './hypo-shared.mjs';

let input = {};
try {
  const raw = await new Promise((r) => {
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });
  input = raw ? JSON.parse(raw) : {};
} catch (err) {
  process.stderr.write(`[hypo-web-fetch-ingest] error: ${err?.message ?? String(err)}\n`);
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

const context = buildContext(input);
const output = { continue: true, suppressOutput: true };
if (context) {
  output.hookSpecificOutput = {
    hookEventName: 'PostToolUse',
    additionalContext: context,
  };
}
console.log(JSON.stringify(output));

function buildContext(data) {
  if (isGateSkipped()) return null;
  const tool = data?.tool_name ?? '';
  if (tool === 'WebFetch') {
    const url = redactUrl(data?.tool_input?.url);
    if (!url) return null;
    return (
      `[WIKI AUTO-INGEST: WebFetch] ${url}\n` +
      `Spec §8.4 path A: confirm this URL is not already represented in ` +
      `sources/ or pages/, then call /hypo:ingest to capture it. ` +
      `(URL redacted of query/hash for transcript safety.)`
    );
  }
  if (tool === 'WebSearch') {
    return (
      `[WIKI AUTO-INGEST: WebSearch] external search performed.\n` +
      `Spec §8.4 path A: any URL you fetch from these results should be ` +
      `captured via /hypo:ingest — confirm it is not already in sources/ before ingesting.`
    );
  }
  return null;
}

/**
 * Reduce a URL to `origin + pathname` so query strings, fragments, and
 * userinfo (`https://user:pass@host`) — which routinely carry
 * credentials / session tokens — never reach the transcript via
 * additionalContext. `new URL().origin` is protocol + host + port only,
 * so userinfo is dropped for free.
 *
 * The protocol allow-list (http/https) is a defense-in-depth guard:
 * non-web schemes like `file://`, `ftp://`, `data:` can produce
 * surprising origins (e.g. `null/Users/...`) or pull a local path into
 * the transcript, so they are rejected instead of redacted.
 *
 * Path-carried secrets (`https://host/path/<token>`) remain — keeping
 * the path is the whole point of identifying *which* page to ingest, so
 * full path redaction would defeat the nudge's purpose. The nudge text
 * still tells the LLM to verify the URL before committing it.
 *
 * Returns null on malformed input or disallowed scheme.
 */
function redactUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}
