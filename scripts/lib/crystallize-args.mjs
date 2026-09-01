import { resolveHypoRoot, expandHome } from './hypo-root.mjs';
import { isValidProjectName } from './project-create.mjs';

// ── arg parsing ──────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    hypoDir: null,
    minGroup: 2,
    json: false,
    checkSessionClose: false,
    applySessionClose: false,
    markSessionClosed: false,
    logOnly: false,
    sessionId: null,
    payload: null,
    force: false,
    transcriptPath: null,
    project: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--min-group=')) args.minGroup = parseInt(arg.slice(12), 10) || 2;
    else if (arg === '--check-session-close') args.checkSessionClose = true;
    else if (arg === '--apply-session-close') args.applySessionClose = true;
    else if (arg === '--mark-session-closed') args.markSessionClosed = true;
    else if (arg === '--log-only') args.logOnly = true;
    else if (arg.startsWith('--session-id=')) args.sessionId = arg.slice(13);
    else if (arg.startsWith('--payload=')) args.payload = arg.slice(10);
    else if (arg.startsWith('--transcript-path=')) args.transcriptPath = expandHome(arg.slice(18));
    else if (arg.startsWith('--session-cwd=')) args.sessionCwd = expandHome(arg.slice(14));
    else if (arg.startsWith('--project=')) args.project = arg.slice(10);
    else if (arg === '--force') args.force = true;
    else if (arg === '--json') args.json = true;
  }
  if (!args.hypoDir) args.hypoDir = resolveHypoRoot();
  // --project=<slug> override (check/mark only). Validate the SYNTAX here so a
  // traversal/charset attack (`--project=../x`) is rejected before any path is
  // built from it — sessionCloseFileStatus(projectOverride) joins it directly.
  // isValidProjectName is the SHARED validator (project-create.mjs), so the
  // override accepts exactly the namespace createProject can scaffold. Existence
  // (a real projects/<slug>/ directory) is checked in the run functions, where
  // hypoDir is resolved and only the check/mark paths consume --project.
  if (args.project != null && !isValidProjectName(args.project)) {
    const msg = `--project "${args.project}" is not a valid project name (need a single segment with ≥1 alnum, charset A-Za-z0-9._-, not "."/"..")`;
    console.log(args.json ? JSON.stringify({ ok: false, error: msg }, null, 2) : `✗ ${msg}`);
    process.exit(1);
  }
  return args;
}
