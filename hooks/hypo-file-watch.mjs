#!/usr/bin/env node
/**
 * hypo-file-watch.mjs — FileChanged hook
 *
 * When any file under HYPO_DIR changes, build a notification of its contents.
 * FileChanged fires for edits from any source: Claude's own Write/Edit/Bash
 * tools as well as an external process (a remote agent, another Claude Code
 * session), not only external ones. Tracing the installed binary (Claude Code
 * 2.1.276, reconfirmed on 2.1.283) shows that notification is a five-second
 * terminal toast that does not reach the model, so this hook does not put
 * anything back in front of the model, only the terminal.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  HYPO_DIR,
  loadHypoIgnore,
  isIgnored,
  currentDevice,
  scopeVisible,
  readVisibilityScope,
  vaultRelatives,
} from './hypo-shared.mjs';

const MAX_CHARS = 2000;

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {}

    const givenPath = data.file_path || data.path || '';

    // Inside the vault by a path comparison on real paths, not a string prefix: a HYPO_DIR with a
    // trailing separator, or a vault reached through a symlink, still counts. Every check below
    // then uses the file spelled from HYPO_DIR. The .hypoignore guard checks every spelling
    // (a pattern may name the symlink or the directory it points to); the real-path one is read.
    const rels =
      typeof givenPath === 'string' && givenPath ? vaultRelatives(HYPO_DIR, givenPath) : [];
    if (rels.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
    const rel = rels[0];
    const filePath = join(HYPO_DIR, rel);

    // Privacy guard: refuse to emit .hypoignore-matched paths. Without this,
    // `.env*` or other secrets under HYPO_DIR are re-emitted in this hook's
    // output. The guard does not depend on which field carries that output:
    // whether or not the systemMessage terminal notification documented for
    // FileChanged actually appears on a given machine is unmeasured, so the
    // only safe assumption is that a matched path must never be put in it.
    const patterns = loadHypoIgnore(HYPO_DIR);
    if (patterns.length > 0 && rels.some((r) => isIgnored(join(HYPO_DIR, r), HYPO_DIR, patterns))) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    if (!existsSync(filePath)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const fileRaw = readFileSync(filePath, 'utf-8');

    // Visibility guard: a machine-scoped page (visibility_scope: machine:<owner>)
    // must not be re-injected on a machine other than its owner. Read the scope
    // from the raw, unsliced content — slicing to MAX_CHARS first could cut the
    // frontmatter off and silently make every scoped page pass fail-open.
    const scope = readVisibilityScope(fileRaw);
    if (!scopeVisible(scope, currentDevice())) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const content = fileRaw.slice(0, MAX_CHARS);
    const relPath = rel;

    // Built inline rather than through buildOutput(): the hook reference's
    // FileChanged section documents the same two fields as its CwdChanged
    // section (watchPaths, systemMessage), and neither is an additionalContext
    // path, so the notice rides systemMessage. The two events are documented
    // separately, each repeating the sentence for itself (checked against the
    // published reference 2026-09-21). The reference says systemMessage
    // "shows the systemMessage as a brief terminal notification" and
    // "doesn't reach the SDK message stream," but it does not say whether
    // systemMessage reaches the model on this event either way. As of Claude
    // Code 2.1.276 (checked 2026-09-18) and reconfirmed on 2.1.283, tracing
    // the installed binary shows the same shared consumer as
    // hypo-cwd-change.mjs: a low-priority terminal toast with no branch to
    // the model, dropped entirely outside the interactive REPL. No
    // live-session observation of this path exists either way. Until the
    // documentation says otherwise, treat this event as not reaching the
    // model.
    // On a stock install this hook still has no registered trigger: its
    // matcher is omitted (not blank), which the reference says matches every
    // watched file while adding nothing to the watch list, and nothing in
    // this package returns watchPaths to seed that list. The watch list is
    // session-global though, not scoped to this plugin: if another hook or
    // plugin seeds it, this matcher-less group fires on every watched file,
    // not just wiki ones. The vaultRelatives check above still returns
    // immediately for any path that is not inside HYPO_DIR (as given or by its
    // real path), so a watch seeded elsewhere cannot point this hook at a path
    // outside the wiki. A symlink living inside the wiki is a separate case:
    // its path is inside HYPO_DIR as given and passes the check above, but
    // readFileSync follows it, so whatever that link points to, inside the
    // wiki or not, is what actually gets emitted.
    console.log(
      JSON.stringify({
        continue: true,
        suppressOutput: true,
        systemMessage: `[WIKI FILE UPDATED: ${relPath}]\n\n${content}`,
      }),
    );
  } catch (err) {
    process.stderr.write(`[hypo-file-watch] error: ${err?.message ?? String(err)}\n`);
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
});
