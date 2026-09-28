// time.mjs: shared time constants for scripts/. Imports nothing, so a script
// that only needs a day length does not pull in the modules it would otherwise
// share a file with (page-usage.mjs loads hooks/hypo-shared.mjs, for one).
//
// hooks/ keeps its own copies: hooks may not import scripts/ (they are copied
// standalone into ~/.claude/hooks/).

export const DAY_MS = 86400000;
