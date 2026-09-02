import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { extractTouchedWikiFilesWithTrust } from '../../hooks/hypo-shared.mjs';

// ── session-close hard gate ───────────────────────────────────────────────────
// The marker attests "the USER closed this session". Its evidence transcript is
// resolved STRICTLY from the session id (a globally-unique UUID) by globbing the
// Claude project dirs — never from a CLI arg. A model owns the whole subprocess
// invocation, so trusting a `--transcript-path` it supplies would let it point at
// a forged `<session-id>.jsonl` it just wrote with a fake close phrase. Resolving
// from the id alone closes that: the only file the glob finds is the live
// transcript the harness itself maintains, which the model cannot author. (If the
// model drops a second `<id>.jsonl` elsewhere the glob returns >1 and fails
// closed.) `--transcript-path` survives ONLY for `--check-session-close`'s lint
// scope, which writes no marker and so cannot cause an over-close.

// Validate that an explicit --project=<slug> override names a real project
// DIRECTORY. Syntax was already checked in parseArgs; this is the existence half,
// mirroring apply's payload.project check — a regular file or an absent dir at
// projects/<slug> is a hard error so the override never silently resolves to an
// all-missing status (which a reader would misread as "exists but incomplete").
export function requireProjectDir(args, slug) {
  const projectDir = join(args.hypoDir, 'projects', slug);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    const msg = `--project "${slug}" does not exist as a directory (no projects/${slug}/ directory)`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
}

// When the global gate's own discovery (hot.md pointer table + today
// close-activity scan, both in hypo-shared.mjs) comes back with NO project at
// all, a real apply never hits that dead end: it is handed `payload.project`
// directly and never infers. --check-session-close has no payload, so its one
// remaining authoritative signal is the same session's own transcript — which
// project's files did THIS session actually touch. Reusing the exact
// evidence-resolution helper the widened-lint-scope path already trusts here
// keeps this a single inference vocabulary (touched wiki files), not a second
// one: the difference is only which project-shaped question gets asked of it.
// Never guessed: a transcript touching zero or more than one project's files
// leaves the check exactly as unresolved as it was before this fallback.
export function deriveTouchedProject(hypoDir, transcriptPath) {
  if (!transcriptPath) return null;
  const { files, trusted } = extractTouchedWikiFilesWithTrust(transcriptPath, hypoDir);
  // `trusted:false` means the walk itself may be incomplete (a missing/unreadable
  // transcript, or a line that failed to parse). A truncated line could have named
  // a SECOND project the walk never saw, so treating this Set as "the whole
  // truth" would resolve a single-project reading off a scope that is only
  // single-project because part of it is missing, exactly the ambiguity this
  // fallback exists to refuse rather than guess through.
  if (!trusted) return null;
  const slugs = new Set();
  for (const f of files) {
    const m = /^projects\/([^/]+)\//.exec(f);
    if (m && existsSync(join(hypoDir, 'projects', m[1]))) slugs.add(m[1]);
  }
  return slugs.size === 1 ? [...slugs][0] : null;
}
