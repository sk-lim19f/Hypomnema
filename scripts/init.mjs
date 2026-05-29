#!/usr/bin/env node
/**
 * Hypomnema init script
 *
 * Sets up a new wiki directory, installs hooks, and merges settings.json.
 * Called by /hypo:init after collecting wizard answers.
 *
 * Usage:
 *   node scripts/init.mjs [options]
 *
 * Options:
 *   --hypo-dir=<path>      Hypomnema root directory (default: resolves via HYPO_DIR env / hypo-config.md scan / ~/hypomnema)
 *   --no-hooks             Skip hook installation
 *   --no-commands          Skip slash command installation to ~/.claude/commands/hypo/
 *   --force-commands       Overwrite user-modified slash command files (creates .bak)
 *   --codex                Also install Codex hooks + extensions (~/.codex/{hooks,commands}/)
 *   --git-remote=<url>     Git remote URL
 *   --no-git-init          Skip git initialization
 *   --from-remote=<url>    Clone existing Hypomnema wiki from remote and install hooks
 *   --dry-run              Show what would be done without making changes
 *   --help, -h             Show this help message
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { expandHome, resolveHypoRoot } from './lib/hypo-root.mjs';
import {
  readPkgJson as readPkgJsonSafe,
  writePkgJsonAtomic,
  sha256 as sha256Buf,
  isRegularFile,
  readFileIfRegular,
} from './lib/pkg-json.mjs';
import { syncExtensions } from './lib/extensions.mjs';

const HOME = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT =
  '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';
const HOOKS_SRC = join(PKG_ROOT, 'hooks');
const COMMANDS_SRC = join(PKG_ROOT, 'commands');
const TEMPLATES = join(PKG_ROOT, 'templates');
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8')).version;
  } catch {
    return null;
  }
})();

function sha256(buf) {
  return sha256Buf(buf);
}

// ── subcommand dispatch ──────────────────────────────────────────────────────
// Route `hypomnema <verb> [flags]` to the matching script. README, CHANGELOG,
// and the upgrade-flow docs all document `hypomnema upgrade --apply`,
// `hypomnema upgrade --check`, `hypomnema doctor`, and `hypomnema uninstall`,
// but without this dispatcher the positional verb was silently dropped and
// init.mjs ran instead — so users got an init-shaped output and assumed the
// command "worked" while the documented behavior never happened.
//
// `hypomnema` with no verb (or with only flags like `--hypo-dir=…` / `--help`)
// keeps running init for backwards compatibility — that's the documented
// Path-B onboarding command. An explicit `hypomnema init` is accepted too,
// and is stripped before flag parsing so the rest of this file is unchanged.
const KNOWN_SUBCOMMANDS = new Set(['init', 'upgrade', 'doctor', 'uninstall', 'feedback-sync']);
const _verb = process.argv[2];
if (_verb && KNOWN_SUBCOMMANDS.has(_verb) && _verb !== 'init') {
  const _target = join(SCRIPT_DIR, `${_verb}.mjs`);
  const _r = spawnSync(process.execPath, [_target, ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(_r.status ?? 1);
}
if (_verb === 'init') process.argv.splice(2, 1);

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    hypoDir: resolveHypoRoot(),
    hooks: true,
    commands: true,
    forceCommands: false,
    forceExtensions: false,
    codex: false,
    gitRemote: null,
    gitInit: true,
    dryRun: false,
    fromRemote: null,
    shellSetup: true,
    shellConfig: null,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: hypomnema [<command>] [options]

Commands:
  init        (default)   Scaffold a wiki, install hooks, merge settings.json
  upgrade                 Reconcile hooks / settings.json / slash commands against the
                          installed package (use --check for dry-run, --apply to commit)
  doctor                  Health check: directories, files, hooks, settings.json, git
  uninstall               Remove hooks and registrations (dry-run by default; pass --apply)
  feedback-sync           Project feedback (SoT) → MEMORY.md / CLAUDE.md learned-behaviors
                          projection (--check default, --write to apply; ADR 0031)

  Running \`hypomnema\` with no command is equivalent to \`hypomnema init\`.

Init options:
  --hypo-dir=<path>      Hypomnema root directory (default: resolves via HYPO_DIR env / hypo-config.md scan / ~/hypomnema)
  --no-hooks             Skip hook installation
  --no-commands          Skip slash command installation to ~/.claude/commands/hypo/
  --force-commands       Overwrite user-modified slash command files (creates .bak)
  --force-extensions     Overwrite user-modified / conflicting extension copies (creates .bak)
  --codex                Also install Codex hooks + extensions (~/.codex/{hooks,commands}/)
  --git-remote=<url>     Git remote URL
  --no-git-init          Skip git initialization
  --from-remote=<url>    Clone existing Hypomnema wiki from remote and install hooks
  --no-shell             Skip shell function setup (~/.zshrc / ~/.bashrc)
  --shell-config=<path>  Shell config file path (default: auto-detect)
  --dry-run              Show what would be done without making changes
  --help, -h             Show this help message

Subcommand-specific flags (upgrade/doctor/uninstall) live in the
docstring at the top of scripts/<command>.mjs.`);
      process.exit(0);
    } else if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg === '--no-hooks') args.hooks = false;
    else if (arg === '--no-commands') args.commands = false;
    else if (arg === '--force-commands') args.forceCommands = true;
    else if (arg === '--force-extensions') args.forceExtensions = true;
    else if (arg === '--codex') args.codex = true;
    else if (arg.startsWith('--git-remote=')) args.gitRemote = arg.slice(13);
    else if (arg === '--no-git-init') args.gitInit = false;
    else if (arg.startsWith('--from-remote=')) {
      const url = arg.slice(14).trim();
      if (!url) {
        console.error('Error: --from-remote requires a non-empty URL');
        process.exit(1);
      }
      args.fromRemote = url;
    } else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-shell') args.shellSetup = false;
    else if (arg.startsWith('--shell-config=')) args.shellConfig = expandHome(arg.slice(15));
  }
  return args;
}

// ── result tracking ──────────────────────────────────────────────────────────

const results = { created: [], skipped: [], merged: [], errors: [] };

function log(action, path) {
  results[action].push(path);
}

// ── directory structure ──────────────────────────────────────────────────────

const HYPO_DIRS = [
  'pages',
  'projects',
  'sources',
  'journal/daily',
  'journal/weekly',
  'journal/monthly',
  'pages/observability',
  // User extensions companion (ADR 0024). init creates the baseline
  // dirs; #29 (E2) adds the hard-copy / manifest / settings sync into them.
  'extensions/hooks',
  'extensions/commands',
  'extensions/skills',
  'extensions/agents',
];

function ensureDir(dir, dryRun) {
  if (existsSync(dir)) return;
  if (!dryRun) mkdirSync(dir, { recursive: true });
  log('created', dir);
}

// ── template copy ────────────────────────────────────────────────────────────

function copyTemplate(srcName, destPath, dryRun, transform) {
  const src = join(TEMPLATES, srcName);
  if (!existsSync(src)) {
    log('errors', `template missing: ${srcName}`);
    return;
  }
  if (existsSync(destPath)) {
    log('skipped', destPath);
    return;
  }
  if (!dryRun) {
    let content = readFileSync(src, 'utf-8');
    content = content.replace(/YYYY-MM-DD/g, new Date().toISOString().slice(0, 10));
    if (transform) content = transform(content);
    writeFileSync(destPath, content);
  }
  log('created', destPath);
}

// ── hypo-config.md ───────────────────────────────────────────────────────────

function writeHypoConfig(hypoDir, dryRun) {
  const dest = join(hypoDir, 'hypo-config.md');
  if (existsSync(dest)) {
    log('skipped', dest);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const src = join(TEMPLATES, 'hypo-config.md');
  const base = existsSync(src) ? readFileSync(src, 'utf-8') : '';
  const content = base.replace(/YYYY-MM-DD/g, today);
  if (!dryRun) writeFileSync(dest, content);
  log('created', dest);
}

// ── .hypoignore ──────────────────────────────────────────────────────────────

function writeWikiignore(hypoDir, dryRun) {
  const dest = join(hypoDir, '.hypoignore');
  if (existsSync(dest)) {
    log('skipped', dest);
    return;
  }
  const src = join(TEMPLATES, '.hypoignore');
  const content = existsSync(src) ? readFileSync(src, 'utf-8') : '';
  if (!dryRun) writeFileSync(dest, content);
  log('created', dest);
}

// ── .gitignore ───────────────────────────────────────────────────────────────

function writeGitignore(hypoDir, dryRun) {
  const dest = join(hypoDir, '.gitignore');
  if (existsSync(dest)) {
    log('skipped', dest);
    return;
  }
  // Template is named without leading dot to survive npm pack (which strips .gitignore)
  const src = join(TEMPLATES, 'gitignore');
  const content = existsSync(src) ? readFileSync(src, 'utf-8') : '.cache/\n';
  if (!dryRun) writeFileSync(dest, content);
  log('created', dest);
}

// ── hook installation ────────────────────────────────────────────────────────

function loadHookMap() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  } catch {
    console.error(`Error: cannot read hooks/hooks.json from package root: ${PKG_ROOT}`);
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    console.error('Error: hooks/hooks.json must be a JSON object');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) {
    console.error('Error: hooks/hooks.json must contain a "hooks" object');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
  function _extractCommandFileName(command) {
    if (typeof command !== 'string') return null;
    const matches = [...command.matchAll(/(?:^|[\/\\])([^\/\\\s"'`]+\.mjs)(?=$|[\s"'`])/g)];
    if (matches.length > 0) return matches[matches.length - 1][1];
    const bare = command.match(/(?:^|\s)([^\/\\\s"'`]+\.mjs)(?=$|[\s"'`])/);
    return bare ? bare[1] : null;
  }

  function _isHookFileName(file) {
    return typeof file === 'string' && /^[^/\\\s]+\.mjs$/.test(file.trim());
  }

  function _isHookGroup(group) {
    return (
      group &&
      typeof group === 'object' &&
      !Array.isArray(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.length > 0 &&
      group.hooks.every(
        (hook) =>
          hook &&
          typeof hook === 'object' &&
          !Array.isArray(hook) &&
          hook.type === 'command' &&
          _extractCommandFileName(hook.command),
      )
    );
  }

  // Extract .mjs file names from both old format (string[]) and new format (hook-group object[])
  function _extractFileNames(groups) {
    return groups.flatMap((group) => {
      if (typeof group === 'string') return [group.trim()];
      return group.hooks.map((hook) => _extractCommandFileName(hook.command));
    });
  }

  for (const [event, groups] of Object.entries(cfg.hooks)) {
    const valid =
      Array.isArray(groups) &&
      groups.length > 0 &&
      groups.every((group) => _isHookFileName(group) || _isHookGroup(group)) &&
      _extractFileNames(groups).length > 0;
    if (!valid) {
      console.error(
        `Error: hooks/hooks.json "hooks.${event}" must be a non-empty array of .mjs file names or Claude hook groups`,
      );
      console.error(PKG_INTEGRITY_HINT);
      process.exit(1);
    }
  }
  if (
    cfg.shared !== undefined &&
    (!Array.isArray(cfg.shared) || !cfg.shared.every((f) => _isHookFileName(f)))
  ) {
    console.error('Error: hooks/hooks.json "shared" must be an array of .mjs file names');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
  return Object.fromEntries(
    Object.entries(cfg.hooks).map(([event, groups]) => [event, _extractFileNames(groups)]),
  );
}

function installHooks(targetDir, dryRun) {
  if (!existsSync(HOOKS_SRC)) {
    log('errors', `hooks source missing: ${HOOKS_SRC}`);
    return;
  }
  if (!dryRun) mkdirSync(targetDir, { recursive: true });
  for (const file of readdirSync(HOOKS_SRC)) {
    if (!file.endsWith('.mjs')) continue;
    const dest = join(targetDir, file);
    if (existsSync(dest)) {
      log('skipped', dest);
      continue;
    }
    if (!dryRun) copyFileSync(join(HOOKS_SRC, file), dest);
    log('created', dest);
  }
}

function mergeSettingsJson(settingsPath, hooksDir, dryRun, hookMap) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      log(
        'errors',
        `settings.json is not valid JSON — fix or back it up before re-running: ${settingsPath}`,
      );
      return;
    }
  }
  if (!settings.hooks) settings.hooks = {};

  let changed = false;
  for (const [event, files] of Object.entries(hookMap)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    for (const file of files) {
      const cmd = `node ${hooksDir.replace(HOME, '$HOME')}/${file}`;
      const already = settings.hooks[event]
        .flatMap((g) => g.hooks || [])
        .some((h) => h.command === cmd);
      if (already) continue;
      settings.hooks[event].push({ hooks: [{ type: 'command', command: cmd }] });
      log('merged', `${event}: ${file}`);
      changed = true;
    }
  }

  if (changed && !dryRun) {
    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
}

// ── pkg git hook ────────────────────────────────────────────────────────────

const PKG_GIT_HOOK_CONTENT = `#!/bin/sh
# Auto-sync hooks/ to ~/.claude/hooks/ when hook files change.
REPO_ROOT="$(git rev-parse --show-toplevel)"
changed=$(git diff --name-only HEAD~1 HEAD 2>/dev/null | grep '^hooks/')
if [ -z "$changed" ]; then
  exit 0
fi
echo "[post-commit] hooks/ changed — syncing to ~/.claude/hooks/ ..."
node "$REPO_ROOT/scripts/upgrade.mjs" --apply
`;

function pkgJsonPath() {
  return join(HOME, '.claude', 'hypo-pkg.json');
}

function writePkgJson(dryRun, extraFields = {}) {
  const dest = pkgJsonPath();
  const existing = readPkgJsonSafe(dest);
  const merged = {
    ...existing,
    pkgRoot: PKG_ROOT,
    pkgVersion: PKG_VERSION,
    schemaVersion: '2.0',
    ...extraFields,
  };
  if (!dryRun) {
    writePkgJsonAtomic(dest, merged);
    log('created', dest);
  }
  return merged;
}

// ── slash command installation ───────────────────────────────────────────────
//
// Sync `commands/*.md` to `~/.claude/commands/hypo/<name>.md` with 3-way SHA tracking.
// Decision matrix (per file):
//   on-disk SHA == recorded SHA && on-disk SHA == packaged SHA  → no-op (up to date)
//   on-disk SHA == recorded SHA && on-disk SHA != packaged SHA  → overwrite (user untouched)
//   on-disk SHA != recorded SHA                                 → skip + warn (user modified)
//     (force=true overrides, writing <name>.md.bak first)
//   file missing                                                → install fresh
// Recorded SHAs are kept in ~/.claude/hypo-pkg.json under `commands: { "<name>.md": "<sha>" }`.

function installCommands(targetDir, dryRun, force) {
  if (!existsSync(COMMANDS_SRC)) {
    log('errors', `commands source missing: ${COMMANDS_SRC}`);
    return null;
  }
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  const prevPkg = readPkgJsonSafe(pkgJsonPath());
  const prevSHAs = prevPkg.commands && typeof prevPkg.commands === 'object' ? prevPkg.commands : {};
  const newSHAs = {};

  function writeFresh(dest, srcContent) {
    if (dryRun) return;
    const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, srcContent);
    try {
      renameSync(tmp, dest);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw err;
    }
  }

  for (const file of readdirSync(COMMANDS_SRC)) {
    if (!file.endsWith('.md')) continue;
    const srcPath = join(COMMANDS_SRC, file);
    const dest = join(targetDir, file);
    const srcContent = readFileSync(srcPath);
    const srcSHA = sha256(srcContent);

    // Fresh install
    if (!existsSync(dest)) {
      writeFresh(dest, srcContent);
      newSHAs[file] = srcSHA;
      log('created', dest);
      continue;
    }

    // Refuse to operate on non-regular files (symlinks, sockets, etc.)
    if (!isRegularFile(dest)) {
      log('skipped', `${dest} (not a regular file — refusing to overwrite)`);
      // Do NOT record ownership for paths we didn't write
      if (prevSHAs[file]) newSHAs[file] = prevSHAs[file];
      continue;
    }

    const onDiskContent = readFileIfRegular(dest);
    if (onDiskContent === null) {
      log('skipped', `${dest} (could not read — refusing to overwrite)`);
      if (prevSHAs[file]) newSHAs[file] = prevSHAs[file];
      continue;
    }
    const onDiskSHA = sha256(onDiskContent);
    const recordedSHA = prevSHAs[file];

    if (onDiskSHA === srcSHA) {
      newSHAs[file] = srcSHA;
      log('skipped', `${dest} (up to date)`);
      continue;
    }

    if (recordedSHA && onDiskSHA === recordedSHA) {
      // Compare-and-swap: re-verify just before write.
      if (!dryRun) {
        const verifyContent = readFileIfRegular(dest);
        const verifySHA = verifyContent ? sha256(verifyContent) : null;
        if (verifySHA !== recordedSHA) {
          log('skipped', `${dest} (changed since check — skipping for safety)`);
          newSHAs[file] = recordedSHA;
          continue;
        }
        writeFresh(dest, srcContent);
      }
      newSHAs[file] = srcSHA;
      log('merged', `${dest} (updated to package version)`);
      continue;
    }

    // User-modified path
    if (force) {
      if (!dryRun) {
        writeFresh(dest + '.bak', onDiskContent);
        writeFresh(dest, srcContent);
      }
      newSHAs[file] = srcSHA;
      log('merged', `${dest} (force-overwritten, backup at ${file}.bak)`);
      continue;
    }

    // Preserve user changes. Only claim ownership if we already had a recorded
    // SHA for this file — never invent ownership for files we didn't install.
    if (recordedSHA) {
      newSHAs[file] = recordedSHA;
      log('skipped', `${dest} (user-modified — re-run with --force-commands to overwrite)`);
    } else {
      log(
        'skipped',
        `${dest} (file exists but Hypomnema does not own it — re-run with --force-commands to take ownership)`,
      );
    }
  }

  return newSHAs;
}

function installPkgGitHook(dryRun) {
  const gitDir = join(PKG_ROOT, '.git');
  if (!existsSync(gitDir)) return;
  const hooksDir = join(gitDir, 'hooks');
  const hookPath = join(hooksDir, 'post-commit');
  if (existsSync(hookPath)) {
    log('skipped', hookPath);
    return;
  }
  if (!dryRun) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookPath, PKG_GIT_HOOK_CONTENT, { mode: 0o755 });
  }
  log('created', hookPath);
}

// ── wiki pre-commit hook ─────────────────────────────────────────────────────

const WIKI_PRE_COMMIT_MARKER_START = '# hypo-managed:pre-commit:start';
const WIKI_PRE_COMMIT_MARKER_END = '# hypo-managed:pre-commit:end';

function wikiPreCommitContent() {
  const worker = join(PKG_ROOT, 'hooks', 'hypo-pre-commit.mjs');
  // Single-quote escaping prevents shell expansion of special chars (e.g. $HOME, backticks) in path
  const escaped = worker.replace(/'/g, "'\\''");
  return `#!/bin/sh\n${WIKI_PRE_COMMIT_MARKER_START}\nnode '${escaped}'\nexit $?\n${WIKI_PRE_COMMIT_MARKER_END}\n`;
}

function installWikiPreCommitHook(hypoDir, dryRun, force) {
  const gitDir = join(hypoDir, '.git');
  if (!existsSync(gitDir)) return; // no git repo — silently skip
  const hooksDir = join(gitDir, 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');
  const newContent = wikiPreCommitContent();

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf-8');
    if (existing.includes(WIKI_PRE_COMMIT_MARKER_START)) {
      if (existing === newContent) {
        log('skipped', `${hookPath} (pre-commit up to date)`);
        return;
      }
      if (!dryRun) {
        writeFileSync(hookPath, newContent);
        chmodSync(hookPath, 0o755);
      }
      log('merged', `${hookPath} (pre-commit updated)`);
    } else if (force) {
      if (!dryRun) {
        writeFileSync(hookPath + '.bak', existing);
        writeFileSync(hookPath, newContent);
        chmodSync(hookPath, 0o755);
      }
      log('merged', `${hookPath} (force-overwritten, backup at pre-commit.bak)`);
    } else {
      log(
        'skipped',
        `${hookPath} (user pre-commit exists — re-run with --force-commands to install)`,
      );
    }
    return;
  }
  if (!dryRun) {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hookPath, newContent, { mode: 0o755 });
  }
  log('created', hookPath);
}

// ── shell function setup ─────────────────────────────────────────────────────

const SHELL_MARKER_START = '# hypo-managed:shell-setup:start';
const SHELL_MARKER_END = '# hypo-managed:shell-setup:end';

function shellFunctionBlock() {
  return `${SHELL_MARKER_START}
function claude() {
  echo "{\\"cwd\\":\\"$(pwd)\\"}" | node "$HOME/.claude/hooks/hypo-session-start.mjs" > /dev/null 2>&1
  command claude "$@"
}
${SHELL_MARKER_END}`;
}

function detectShellConfig(customPath) {
  if (customPath) return customPath;
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return join(HOME, '.zshrc');
  if (shell.includes('bash')) return join(HOME, '.bashrc');
  // fallback: prefer .zshrc if it exists, else .bashrc
  const zshrc = join(HOME, '.zshrc');
  return existsSync(zshrc) ? zshrc : join(HOME, '.bashrc');
}

function installShellFunction(shellConfigPath, dryRun) {
  const block = shellFunctionBlock();

  if (!existsSync(shellConfigPath)) {
    if (!dryRun) writeFileSync(shellConfigPath, block + '\n');
    log('created', `${shellConfigPath} (shell function)`);
    return;
  }

  const content = readFileSync(shellConfigPath, 'utf-8');
  const startIdx = content.indexOf(SHELL_MARKER_START);
  const endIdx = content.indexOf(SHELL_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Block exists — check if already up to date
    const existing = content.slice(startIdx, endIdx + SHELL_MARKER_END.length);
    if (existing === block) {
      log('skipped', `${shellConfigPath} (shell function up to date)`);
      return;
    }
    // Replace stale block
    const updated =
      content.slice(0, startIdx) + block + content.slice(endIdx + SHELL_MARKER_END.length);
    if (!dryRun) writeFileSync(shellConfigPath, updated);
    log('merged', `${shellConfigPath} (shell function updated)`);
    return;
  }

  // No block — remove any legacy wiki-session-start function first, then append
  const legacyPattern = /\n?# Wiki session context[^\n]*\nfunction claude\(\) \{[\s\S]+?\n\}\n?/g;
  const cleaned = content.replace(legacyPattern, '\n');
  const appended = cleaned.trimEnd() + '\n\n' + block + '\n';
  if (!dryRun) writeFileSync(shellConfigPath, appended);
  log('created', `${shellConfigPath} (shell function)`);
}

// ── from-remote clone ────────────────────────────────────────────────────────

function cloneFromRemote(url, hypoDir, dryRun) {
  if (existsSync(hypoDir)) {
    log(
      'errors',
      `--from-remote: target directory already exists: ${hypoDir}. Remove it or choose a different --hypo-dir.`,
    );
    return false;
  }
  console.log(`Cloning ${url} → ${hypoDir} ...`);
  if (!dryRun) {
    const r = spawnSync('git', ['clone', url, hypoDir], { stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      log('errors', `git clone failed: ${url}`);
      return false;
    }
    if (!existsSync(join(hypoDir, 'hypo-config.md'))) {
      spawnSync('rm', ['-rf', hypoDir]);
      log(
        'errors',
        `--from-remote: cloned repo is not a Hypomnema wiki (hypo-config.md missing). Removed ${hypoDir}.`,
      );
      return false;
    }
  }
  log('created', hypoDir);
  return true;
}

// ── git setup ────────────────────────────────────────────────────────────────

function git(hypoDir, args, opts = {}) {
  return spawnSync('git', ['-C', hypoDir, ...args], { encoding: 'utf-8', ...opts });
}

function gitSetup(hypoDir, remote, dryRun) {
  const isGit = existsSync(join(hypoDir, '.git'));
  if (!isGit) {
    if (!dryRun) {
      const r = spawnSync('git', ['init', hypoDir], { stdio: 'ignore' });
      if (r.error || r.status !== 0) {
        log('errors', `git init failed in ${hypoDir}`);
        return;
      }
    }
    log('created', join(hypoDir, '.git'));
  }
  if (remote) {
    const existing = git(hypoDir, ['remote', 'get-url', 'origin']);
    if (existing.status === 0) {
      const url = existing.stdout.trim();
      if (url !== remote) log('skipped', `remote origin already set to ${url}`);
    } else {
      if (!dryRun) git(hypoDir, ['remote', 'add', 'origin', remote], { stdio: 'ignore' });
      log('merged', `git remote origin → ${remote}`);
    }
  }
}

// ── first commit + push ──────────────────────────────────────────────────────

function firstCommit(hypoDir, remote, dryRun) {
  const logR = git(hypoDir, ['log', '--oneline', '-1']);
  if (logR.status === 0 && logR.stdout.trim()) {
    log('skipped', 'first commit (repo already has commits)');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  if (!dryRun) {
    git(hypoDir, ['add', '-A'], { stdio: 'ignore' });
    const commitR = git(hypoDir, ['commit', '-m', `chore: init hypomnema (${today})`]);
    if (commitR.status !== 0) {
      log('errors', 'first commit failed');
      return;
    }
    if (remote) {
      const actualOrigin = git(hypoDir, ['remote', 'get-url', 'origin']);
      const pushTarget = actualOrigin.status === 0 ? actualOrigin.stdout.trim() : remote;
      const pushR = git(hypoDir, ['push', '-u', 'origin', 'HEAD']);
      if (pushR.status !== 0) log('errors', `git push failed: ${(pushR.stderr || '').trim()}`);
      else log('merged', `pushed to ${pushTarget}`);
    }
  }
  log('created', `first commit (${today})`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

// Validate hooks.json before any file writes so a bad package leaves no partial state
const HOOK_MAP = args.hooks || args.codex ? loadHookMap() : null;

if (args.fromRemote) {
  // ── from-remote path: clone → read config → install hooks ──────────────────
  const cloned = cloneFromRemote(args.fromRemote, args.hypoDir, args.dryRun);
  if (!cloned) {
    console.error(results.errors.join('\n'));
    process.exit(1);
  }
} else {
  // ── normal path: create structure + templates ───────────────────────────────
  // 1. wiki directory structure
  ensureDir(args.hypoDir, args.dryRun);
  for (const d of HYPO_DIRS) ensureDir(join(args.hypoDir, d), args.dryRun);

  // 1b. extensions baseline: drop a .gitkeep into each so the empty dirs are
  // git-trackable in the user's wiki repo (ADR 0024).
  for (const t of ['hooks', 'commands', 'skills', 'agents']) {
    copyTemplate(
      join('extensions', t, '.gitkeep'),
      join(args.hypoDir, 'extensions', t, '.gitkeep'),
      args.dryRun,
    );
  }

  // 2. template files
  copyTemplate('index.md', join(args.hypoDir, 'index.md'), args.dryRun);
  copyTemplate('hot.md', join(args.hypoDir, 'hot.md'), args.dryRun);
  copyTemplate('log.md', join(args.hypoDir, 'log.md'), args.dryRun);
  copyTemplate('SCHEMA.md', join(args.hypoDir, 'SCHEMA.md'), args.dryRun);
  copyTemplate('hypo-guide.md', join(args.hypoDir, 'hypo-guide.md'), args.dryRun);
  copyTemplate('Home.md', join(args.hypoDir, 'Home.md'), args.dryRun);
  copyTemplate('Overview.md', join(args.hypoDir, 'Overview.md'), args.dryRun);
  copyTemplate('hypo-help.md', join(args.hypoDir, 'hypo-help.md'), args.dryRun);
  copyTemplate('hypo-automation.md', join(args.hypoDir, 'hypo-automation.md'), args.dryRun);
  copyTemplate('session-state.md', join(args.hypoDir, 'session-state.md'), args.dryRun);
  copyTemplate(join('pages', '_index.md'), join(args.hypoDir, 'pages', '_index.md'), args.dryRun);
  copyTemplate(
    join('pages', 'observability', '_index.md'),
    join(args.hypoDir, 'pages', 'observability', '_index.md'),
    args.dryRun,
  );

  // projects/_template structure
  ensureDir(join(args.hypoDir, 'projects', '_template'), args.dryRun);
  ensureDir(join(args.hypoDir, 'projects', '_template', 'decisions'), args.dryRun);
  ensureDir(join(args.hypoDir, 'projects', '_template', 'session-log'), args.dryRun);
  copyTemplate(
    join('projects', '_template', 'hot.md'),
    join(args.hypoDir, 'projects', '_template', 'hot.md'),
    args.dryRun,
  );
  copyTemplate(
    join('projects', '_template', 'index.md'),
    join(args.hypoDir, 'projects', '_template', 'index.md'),
    args.dryRun,
  );
  copyTemplate(
    join('projects', '_template', 'prd.md'),
    join(args.hypoDir, 'projects', '_template', 'prd.md'),
    args.dryRun,
  );
  copyTemplate(
    join('projects', '_template', 'session-state.md'),
    join(args.hypoDir, 'projects', '_template', 'session-state.md'),
    args.dryRun,
  );

  // 3. hypo-config.md + .hypoignore + .gitignore
  writeHypoConfig(args.hypoDir, args.dryRun);
  writeWikiignore(args.hypoDir, args.dryRun);
  writeGitignore(args.hypoDir, args.dryRun);
}

// 4. hooks

let commandSHAs = null;
if (args.commands) {
  const claudeCommands = join(HOME, '.claude', 'commands', 'hypo');
  commandSHAs = installCommands(claudeCommands, args.dryRun, args.forceCommands);
}

if (args.hooks) {
  const claudeHooks = join(HOME, '.claude', 'hooks');
  installHooks(claudeHooks, args.dryRun);
  mergeSettingsJson(join(HOME, '.claude', 'settings.json'), claudeHooks, args.dryRun, HOOK_MAP);
}

if (args.hooks || args.commands) {
  writePkgJson(args.dryRun, commandSHAs ? { commands: commandSHAs } : {});
}

// 4b. user extensions companion sync (ADR 0024). Runs after
// writePkgJson so the per-target SHA map is merged into the same hypo-pkg.json
// (preserving the commands map) rather than racing it.
if (args.hooks) {
  const extResult = syncExtensions({
    extDir: join(args.hypoDir, 'extensions'),
    hypoDir: args.hypoDir,
    target: 'claude',
    settingsPath: join(HOME, '.claude', 'settings.json'),
    pkgPath: pkgJsonPath(),
    apply: !args.dryRun,
    force: args.forceExtensions,
  });
  for (const a of extResult.actions) {
    if (a.action === 'create' || a.action === 'update' || a.action === 'force-update') {
      log('created', `extension ${a.file} (${a.action})`);
    }
  }
  for (const r of extResult.registered) log('merged', `extension ${r}`);
  for (const w of extResult.warnings) log('skipped', `extension: ${w}`);
  // E3 (fix #31): a hard conflict (unowned/symlinked target) blocks install — surface
  // the recovery and force a non-zero exit. Drift is advisory (resolvable, no block).
  if (extResult.conflicts.length > 0) {
    log('errors', '[WIKI: existing file conflicts. Backup and retry, or use --force-extensions]');
    for (const c of extResult.conflicts) log('errors', `extension ${c.file} (${c.action})`);
  }
  for (const d of extResult.drifts) {
    log(
      'skipped',
      `[WIKI: extension ${d.name} drift detected. Use --force-extensions to overwrite.]`,
    );
  }
}

// 5. shell function (claude wrapper)
if (args.shellSetup) {
  const shellConfigPath = detectShellConfig(args.shellConfig);
  installShellFunction(shellConfigPath, args.dryRun);
}

// 6. codex hooks (optional)
if (args.codex) {
  const codexHooks = join(HOME, '.codex', 'hooks');
  installHooks(codexHooks, args.dryRun);
  mergeSettingsJson(join(HOME, '.codex', 'settings.json'), codexHooks, args.dryRun, HOOK_MAP);

  // 6b. user extensions companion → codex (E4, #32). Mirrors the claude sync above
  // for the codex target: hooks + commands only (skills/agents are skipped with a
  // notice). The per-target SHA map merges into the same ~/.claude/hypo-pkg.json
  // under extensions.codex, alongside extensions.claude written in step 4b.
  const extCodex = syncExtensions({
    extDir: join(args.hypoDir, 'extensions'),
    hypoDir: args.hypoDir,
    target: 'codex',
    settingsPath: join(HOME, '.codex', 'settings.json'),
    pkgPath: pkgJsonPath(),
    apply: !args.dryRun,
    force: args.forceExtensions,
  });
  for (const a of extCodex.actions) {
    if (a.action === 'create' || a.action === 'update' || a.action === 'force-update') {
      log('created', `codex extension ${a.file} (${a.action})`);
    }
  }
  for (const r of extCodex.registered) log('merged', `codex extension ${r}`);
  for (const w of extCodex.warnings) log('skipped', `codex extension: ${w}`);
  if (extCodex.conflicts.length > 0) {
    log('errors', '[WIKI: existing file conflicts. Backup and retry, or use --force-extensions]');
    for (const c of extCodex.conflicts) log('errors', `codex extension ${c.file} (${c.action})`);
  }
  for (const d of extCodex.drifts) {
    log(
      'skipped',
      `[WIKI: extension ${d.name} drift detected. Use --force-extensions to overwrite.]`,
    );
  }
}

// 7. git setup (skip when cloned from remote — already has .git + remote)
if (args.gitInit && !args.fromRemote) {
  gitSetup(args.hypoDir, args.gitRemote, args.dryRun);
}

// 8. pkg repo git hook (auto-sync hooks/ → ~/.claude/hooks/ on commit)
if (args.hooks) {
  installPkgGitHook(args.dryRun);
}

// 8b. wiki pre-commit hook (.hypoignore last-line-of-defence guard — §6.8)
installWikiPreCommitHook(args.hypoDir, args.dryRun, args.forceCommands);

// 9. first commit + push (skip when cloned from remote — already has commits)
if (args.gitInit && !args.fromRemote) {
  firstCommit(args.hypoDir, args.gitRemote, args.dryRun);
}

// ── report ───────────────────────────────────────────────────────────────────

const lines = [];
if (results.created.length)
  lines.push(
    `✓ Created (${results.created.length}):\n${results.created.map((p) => `  ${p}`).join('\n')}`,
  );
if (results.skipped.length)
  lines.push(
    `⊘ Skipped / already exists (${results.skipped.length}):\n${results.skipped.map((p) => `  ${p}`).join('\n')}`,
  );
if (results.merged.length)
  lines.push(`↪ Merged into settings.json:\n${results.merged.map((p) => `  ${p}`).join('\n')}`);
if (results.errors.length)
  lines.push(`✗ Errors:\n${results.errors.map((p) => `  ${p}`).join('\n')}`);

if (args.dryRun) lines.unshift('[DRY RUN — no changes made]');

console.log(lines.join('\n\n'));
if (results.errors.length) process.exit(1);
