#!/usr/bin/env node
/**
 * Hypomnema uninstall script
 *
 * Removes hook files installed by Hypomnema and strips wiki entries from
 * settings.json, leaving all other user hooks untouched.
 *
 * Usage:
 *   node scripts/uninstall.mjs [options]
 *
 * Options:
 *   --apply              Actually remove files / edit settings.json (default: dry-run)
 *   --codex              Also remove Codex hooks/commands + ext hard-copies (~/.codex/)
 *   --force-commands     Remove user-modified slash commands instead of preserving them
 *   --force-extensions   Remove user-modified extension files (hypo-ext-*) instead of preserving them
 *   --hooks-dir=<path>   Override Claude hooks directory (default: ~/.claude/hooks)
 *   --hypo-dir=<path>    Wiki vault to remove the pre-commit hook from (default: auto-resolve,
 *                        same rules as init/lint/query)
 *   --shell-config=<path> Shell rc file to strip the shell block from (default: checks both
 *                        ~/.zshrc and ~/.bashrc, since init may have run under either shell)
 *   --keep-shell         Skip the shell rc `claude()` block removal entirely
 *   --keep-wiki-hook     Skip the wiki pre-commit hook removal entirely
 *
 * The wiki's git pre-commit hook and the shell rc's `claude()` wrapper function are removed
 * only when they still carry the marker init.mjs wrote (WIKI_PRE_COMMIT_MARKER_START /
 * SHELL_MARKER_START, both from ./lib/git-hooks-dir.mjs). A user's own pre-commit hook, a
 * symlinked hook target, and any rc content outside the marker block are never touched.
 *
 * --hooks-dir only redirects where the ~/.claude/hooks/*.mjs removal looks; it does NOT bound
 * the rc-block and wiki-hook removals above, since those live outside ~/.claude entirely and a
 * hypo-dir override already exists for the latter. A caller that wants an uninstall run scoped
 * to a throwaway hooks dir (a sandboxed CI check, for instance) and NOT touching the real
 * machine's shell rc files or scanning for a real vault must say so explicitly with
 * --keep-shell --keep-wiki-hook.
 *
 * Extensions: hypo-ext-* hard-copies under
 * ~/.claude/{hooks,commands,skills,agents}/ and ~/.codex/{hooks,commands}/ (with
 * --codex) are removed when their on-disk SHA matches the recorded one in
 * ~/.claude/hypo-pkg.json#extensions.<target>. User-modified copies are preserved
 * unless --force-extensions; symlinks/non-regular files are NEVER removed (force
 * does not follow them). The wiki source (~/hypomnema/extensions/) is preserved.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  rmdirSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  readPkgJson as readPkgJsonSafe,
  sha256,
  isRegularFile,
  readFileIfRegular,
} from './lib/pkg-json.mjs';
import {
  EXT_PREFIX,
  EXT_TYPES,
  CODEX_TYPES,
  readExtensionPkgStateNoMutate,
  parseExtKey,
  parseSkillKey,
  parseSkillShaValue,
  isFlatShaValue,
  emptyShaMap,
  isContainedUnder,
  hasSymlinkAncestor,
  buildHookCommand,
} from './lib/extensions.mjs';
import { removeProvenanceSidecar } from './lib/pkg-provenance.mjs';
import {
  hooksDirForInstall,
  unsafeHookTargetReason,
  findMarkerSpan,
  isOwnedWikiPreCommitBody,
  isOwnedShellFunctionBody,
  canonicalize,
  isInside,
  WIKI_PRE_COMMIT_MARKER_START,
  WIKI_PRE_COMMIT_MARKER_END,
  SHELL_MARKER_START,
  SHELL_MARKER_END,
} from './lib/git-hooks-dir.mjs';
import { resolveHypoRoot, expandHome } from './lib/hypo-root.mjs';

const HOME = homedir();
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, '..');

// Shown after every fatal package-integrity error. These conditions mean the
// shipped hooks/hooks.json is missing or malformed — never a user mistake —
// so the only useful next step is a re-install of the package.
const PKG_INTEGRITY_HINT =
  '→ This indicates a corrupt or incomplete install. Re-install with `npm install -g hypomnema` (or re-install the Claude Code plugin).';

function removeCommands(apply, force) {
  const targetDir = join(HOME, '.claude', 'commands', 'hypo');
  const pkgPath = join(HOME, '.claude', 'hypo-pkg.json');
  if (!existsSync(targetDir))
    return { removed: [], skippedUserModified: [], skippedNonRegular: [] };

  const recorded = readPkgJsonSafe(pkgPath).commands || {};
  const removed = [];
  const skippedUserModified = [];
  const skippedNonRegular = [];

  for (const file of readdirSync(targetDir)) {
    if (!file.endsWith('.md')) continue;
    const fullPath = join(targetDir, file);
    const recordedSHA = recorded[file];
    if (!recordedSHA) continue; // wasn't installed by us — leave alone

    if (!isRegularFile(fullPath)) {
      // Refuse to follow symlinks during destructive ops.
      skippedNonRegular.push(fullPath);
      continue;
    }
    const buf = readFileIfRegular(fullPath);
    const sha = buf ? sha256(buf) : null;

    if (sha === recordedSHA || force) {
      if (apply) rmSync(fullPath);
      removed.push(fullPath);
    } else {
      // User-modified tracked command — preserve unless --force.
      skippedUserModified.push(fullPath);
    }
  }

  // Remove the hypo/ dir only if it ends up empty.
  if (apply && existsSync(targetDir)) {
    try {
      const remaining = readdirSync(targetDir);
      if (remaining.length === 0) rmdirSync(targetDir);
    } catch {}
  }
  return { removed, skippedUserModified, skippedNonRegular };
}

// ── extensions removal ───────────────────────────────────

// Strip per-target extension SHA records from ~/.claude/hypo-pkg.json. Surgical:
// we only touch the entries for keys we actually removed, so a `--force-extensions`
// run that leaves user-modified files behind keeps their recorded SHAs intact
// (doctor still has something to compare against next time). When the per-target
// map empties out, drop the target key; when the whole `extensions` object empties,
// drop it too. Other targets' records (e.g. codex map during a Claude-only uninstall)
// are never touched.
function stripExtensionsFromPkg(pkgPath, target, removedKeys, apply, rewrittenKeys = new Map()) {
  if (!existsSync(pkgPath) || (removedKeys.length === 0 && rewrittenKeys.size === 0)) return false;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return false;
  const extensions = pkg.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  const perTarget = extensions[target];
  if (!perTarget || typeof perTarget !== 'object' || Array.isArray(perTarget)) return false;

  let changed = false;
  for (const key of removedKeys) {
    if (key in perTarget) {
      delete perTarget[key];
      changed = true;
    }
  }
  // A partially-uninstalled skill keeps only the files it still owns. Leaving the
  // removed paths in the map would let a later --force run delete whatever the user
  // has since put back at those paths.
  for (const [key, nested] of rewrittenKeys) {
    if (key in perTarget) {
      perTarget[key] = nested;
      changed = true;
    }
  }
  if (Object.keys(perTarget).length === 0) {
    delete extensions[target];
    changed = true;
  }
  if (Object.keys(extensions).length === 0) {
    delete pkg.extensions;
    changed = true;
  }
  if (changed && apply) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return changed;
}

// Remove Hypomnema-installed extension hard-copies for one target (claude |
// codex). Ownership is decided by the per-target recorded SHA map in
// hypo-pkg.json#extensions[target]: we iterate the RECORDED KEYS (not a
// filesystem+prefix scan) because the reverse-capture design decoupled the install filename from
// the wiki `hypo-ext-*` storage name — a reverse-captured command installs as
// `commands/mycmd.md`, which a prefix scan would never reach. The SHA map key
// IS the install path relative to the target root, so it names every file we
// own regardless of its filename.
//
// Safety (capture design §8): a recorded key comes from an on-disk JSON we do not
// fully control, so each key is validated by `parseExtKey` to a single covered
// `<type>/<safe-basename>` segment (no separators / traversal) before any
// join/rm — a corrupt or malicious key can never delete outside the extension
// directory. "Never delete unowned" holds via SHA MATCHING, not the prefix: a
// file whose on-disk SHA differs from the recorded one is user-modified and
// preserved unless --force-extensions; a symlink/non-regular target is always
// preserved (force does not follow them, matching install/upgrade E3's guard).
// Remove the directories a skill removal emptied, deepest first, and finally the
// skill root itself. Anything still holding files (user-added, or copies we
// refused to remove) is left standing — rmdir on a non-empty directory throws and
// we swallow it, which is exactly the "never destroy what we don't own" behavior.
//
// Every rmdir is guarded by the same containment + symlink-ancestor walk the file
// removals use. Without it, a corrupt `"skills/x": {}` record plus a symlinked
// skill dir was enough to rmdir empty directories anywhere on disk: the record
// granted no file ownership, yet the prune still ran (codex pre-commit BLOCKER).
function pruneSkillDirs(skillsRoot, skillRoot) {
  if (hasSymlinkAncestor(skillsRoot, skillRoot)) return;
  const dirs = [];
  const collect = (dir, depth) => {
    if (depth > 16) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue; // isDirectory() is false for a symlink here
      const full = join(dir, e.name);
      collect(full, depth + 1);
      dirs.push(full);
    }
  };
  collect(skillRoot, 1);
  dirs.push(skillRoot);
  for (const dir of dirs) {
    if (!isContainedUnder(skillsRoot, dir)) continue;
    if (hasSymlinkAncestor(skillsRoot, dir)) continue;
    try {
      rmdirSync(dir);
    } catch {
      // not empty (or gone) — leave it
    }
  }
}

function removeExtensions(target, apply, force) {
  const targetRoot = target === 'codex' ? join(HOME, '.codex') : join(HOME, '.claude');
  const types = target === 'codex' ? CODEX_TYPES : EXT_TYPES;
  // Per-target SHAs live in ~/.claude/hypo-pkg.json regardless of target (the
  // file is a single source of truth, with extensions: { claude: {}, codex: {} }).
  const pkgPath = join(HOME, '.claude', 'hypo-pkg.json');
  const recorded = readExtensionPkgStateNoMutate(pkgPath, target);

  const removed = [];
  const removedKeys = [];
  // Skill keys that survive in reduced form: key → the nested map of files we still
  // own after this run.
  const rewrittenKeys = new Map();
  const skippedUserModified = [];
  const skippedNonRegular = [];

  for (const [key, recordedSHA] of Object.entries(recorded)) {
    if (!recordedSHA) continue; // no ownership baseline → nothing to remove

    // A directory skill records one key (`skills/<name>`) whose value is a map of
    // per-file SHAs. parseExtKey rejects that key by design (it demands the type's
    // file extension), so without this branch every installed skill file would be
    // silently stranded: owned on paper, unreachable by uninstall.
    const skillKey = types.includes('skills') ? parseSkillKey(key) : null;
    if (skillKey) {
      const nested = parseSkillShaValue(recordedSHA);
      // A corrupt value grants no ownership: remove nothing, and do NOT prune —
      // pruning on an empty/invalid record is destructive power the record never
      // earned.
      if (!nested || Object.keys(nested).length === 0) continue;
      const skillsRoot = join(targetRoot, 'skills');
      const skillRoot = join(skillsRoot, skillKey.installDir);
      // What the record must still claim after this run. A file we removed drops
      // out; a file we preserved stays. Keeping a removed path in the record is not
      // cosmetic: a later --force run deletes whatever now sits at that path,
      // including a brand-new file the user created there (codex fix-verify BLOCKER).
      const remaining = emptyShaMap();
      let removedAny = false;
      const preserve = (rel, sha, path, bucket) => {
        remaining[rel] = sha;
        bucket.push(path);
      };
      for (const [rel, sha] of Object.entries(nested)) {
        const fullPath = join(skillRoot, ...rel.split('/'));
        // Same containment + symlink-ancestor guard the sync path uses: a lexical
        // check alone cannot see a symlinked directory in the middle of the path.
        if (!isContainedUnder(skillRoot, fullPath) || hasSymlinkAncestor(skillsRoot, fullPath)) {
          preserve(rel, sha, fullPath, skippedNonRegular);
          continue;
        }
        if (!existsSync(fullPath)) continue; // already gone: the claim goes too
        if (!isRegularFile(fullPath)) {
          preserve(rel, sha, fullPath, skippedNonRegular);
          continue;
        }
        const buf = readFileIfRegular(fullPath);
        const fileSha = buf ? sha256(buf) : null;
        if (fileSha === sha || force) {
          if (apply) rmSync(fullPath);
          removed.push(fullPath);
          removedAny = true;
        } else {
          preserve(rel, sha, fullPath, skippedUserModified);
        }
      }
      // Prune the directories we emptied, deepest first. A skill dir still holding
      // user files (or files we refused to remove) is left in place.
      if (apply && removedAny) pruneSkillDirs(skillsRoot, skillRoot);
      // Retire the key outright only when nothing is left to claim. Otherwise rewrite
      // it down to just the preserved files: dropping the whole key would disown them
      // forever, and keeping the whole key would leave stale claims on paths we no
      // longer own.
      if (Object.keys(remaining).length === 0) removedKeys.push(key);
      else rewrittenKeys.set(key, remaining);
      continue;
    }

    // A flat key's value must be a plain hex SHA. Anything else (an object parked
    // there by a corrupt pkg-json) grants no ownership — otherwise --force would
    // remove the file on the strength of a value we never wrote.
    if (!isFlatShaValue(recordedSHA)) continue;
    const parsed = parseExtKey(key, types);
    if (!parsed) continue; // untrusted / cross-target key → never join+rm
    const fullPath = join(targetRoot, parsed.type, parsed.installFile);
    if (!existsSync(fullPath)) continue; // already gone

    if (!isRegularFile(fullPath)) {
      // Refuse to follow symlinks/sockets even under --force-extensions.
      skippedNonRegular.push(fullPath);
      continue;
    }
    const buf = readFileIfRegular(fullPath);
    const sha = buf ? sha256(buf) : null;

    if (sha === recordedSHA || force) {
      if (apply) rmSync(fullPath);
      removed.push(fullPath);
      removedKeys.push(key);
    } else {
      skippedUserModified.push(fullPath);
    }
  }
  return { target, removed, removedKeys, rewrittenKeys, skippedUserModified, skippedNonRegular };
}

// True iff `pkg.json` still holds extensions state for a target the current
// uninstall did NOT process. Without this guard, a Claude-only uninstall would
// wholesale-rm pkg.json even when ~/.codex/hooks/hypo-ext-* hard-copies (and
// their `extensions.codex` ownership baseline) are still live — silently
// orphaning Codex's per-target SHA contract (plan D2b/E6).
//
// Scope is narrowed to unprocessed targets so the legacy clean-uninstall path
// stands: when commands are removed in full (commandResult has no skipped
// entries) the stale `pkg.commands` map still gets wholesale-removed, matching
// pre-E6 behavior. A processed target whose own state is non-empty (e.g.
// user-modified ext file held back) is already guarded by its skippedUserModified
// / skippedNonRegular tally — so we don't double-count it here.
function unprocessedExtensionTargetRemains(pkgPath, processedTargets) {
  if (!existsSync(pkgPath)) return false;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    // Cannot reliably inspect — refuse to delete (fail-safe: keep the file).
    return true;
  }
  const exts = pkg && typeof pkg === 'object' && !Array.isArray(pkg) ? pkg.extensions : null;
  if (!exts || typeof exts !== 'object' || Array.isArray(exts)) return false;
  for (const [target, m] of Object.entries(exts)) {
    if (processedTargets.has(target)) continue;
    if (m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length > 0) {
      return true;
    }
  }
  return false;
}

// Build the set of settings.json commands owned by reverse-captured hooks that
// install under their ORIGINAL name (not the hypo-ext-* storage name). The prefix
// scan below only reaches hypo-ext-* commands; a captured hook registers as
// `node $HOME/.claude/hooks/foo.mjs`, which no prefix would ever match. The
// recorded per-target SHA map names every file we own, so its hooks `.mjs` keys
// reconstruct exactly the commands we registered. Read WITHOUT mutation and while
// the map is still whole. stripExtensionsFromPkg (which clears it) runs later.
// Only `.mjs` keys are commands; the paired `.manifest.json` sidecar keys (which
// parseExtKey also admits for hooks) are dropped by the extension check.
function ownedHookCommands(pkgPath, target, hooksDir) {
  const types = target === 'codex' ? CODEX_TYPES : EXT_TYPES;
  const recorded = readExtensionPkgStateNoMutate(pkgPath, target);
  const commands = new Set();
  for (const key of Object.keys(recorded)) {
    const parsed = parseExtKey(key, types);
    if (!parsed || parsed.type !== 'hooks') continue;
    if (!parsed.installFile.endsWith('.mjs')) continue;
    commands.add(buildHookCommand(hooksDir, parsed.installFile));
  }
  return commands;
}

// settings.json: strip groups whose command is one of ours under the target's
// hooks dir. Ownership is the UNION of two path-based signals (plan §0 D1, P2):
// the hypo-ext-* command prefix (catches wiki-authored hooks and hypo-ext-*
// leftovers whose recorded key was already cleared by a partial uninstall) and
// the recorded owned-command set (`ownedCommands`, catches reverse-captured hooks
// registered under their original name, which carry no hypo-ext-* marker). Both
// branches are needed, so this is a union, not a replacement. No hookMap needed
// because ext hooks are never enumerated there. Mixed groups (foreign hook +
// ours) keep the foreign hook; ours-only groups are dropped entirely. Mirrors
// stripSettingsJson's flatMap pattern so other-plugin invariants (§7.3) hold.
function stripExtensionSettings(settingsPath, hooksDir, apply, ownedCommands = new Set()) {
  if (!existsSync(settingsPath)) return { stripped: [] };
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { stripped: [], error: `${settingsPath} is not valid JSON — skipping` };
  }
  if (!settings.hooks || typeof settings.hooks !== 'object') return { stripped: [] };

  const cmdPrefix = `node ${hooksDir.replace(HOME, '$HOME')}/${EXT_PREFIX}`;
  const isExtHook = (h) =>
    h &&
    h.type === 'command' &&
    typeof h.command === 'string' &&
    (h.command.startsWith(cmdPrefix) || ownedCommands.has(h.command));

  const stripped = [];
  let changed = false;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;

    const filtered = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];

      const extHooks = group.hooks.filter(isExtHook);
      const others = group.hooks.filter((h) => !isExtHook(h));

      for (const h of extHooks) stripped.push(`${event}: ${h.command}`);

      if (extHooks.length === 0) return [group];
      changed = true;
      if (others.length === 0) return [];
      return [{ ...group, hooks: others }];
    });

    settings.hooks[event] = filtered;
  }

  if (changed && apply) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return { stripped };
}

// ── wiki pre-commit hook removal ────────────────────────────────────────────

// Mirrors init.mjs's own resolution (hooksDirForInstall) as the PRIMARY
// candidate, so this finds the hook wherever init would put it today,
// including under a core.hooksPath override. A second, best-effort candidate
// (the vault's plain .git/hooks/pre-commit) is checked too, but it only
// recovers ONE specific drift: an install that went to the default .git/hooks
// and had core.hooksPath pointed elsewhere afterward. It does not recover the
// general case (an install that went to a non-default core.hooksPath which was
// then repointed somewhere else again), since the only fallback candidate is
// the plain .git/hooks path, never the original custom one. Both candidates go
// through the same marker/ownership gate below, so widening the search costs
// nothing in safety, only in how many places we bother to look.
// A hook that still carries our marker is removed; a user's own pre-commit (no
// marker), a symlinked/non-regular target, and a hook whose marker is
// duplicated, swapped, or missing its shebang are all left standing.
// `pre-commit.bak` (init's --force-commands backup of the user's original
// hook) is never removed here, only reported so the user knows it exists.
function removeWikiPreCommitHook(hypoDir, apply) {
  const result = { removed: [], skipped: [], bakPresent: [] };

  if (!hypoDir || !existsSync(join(hypoDir, 'hypo-config.md'))) {
    result.skipped.push(
      `no Hypomnema vault found${hypoDir ? ` at ${hypoDir}` : ''} — nothing to remove`,
    );
    return result;
  }

  const candidateDirs = [];
  const { dir: hooksDir, skip } = hooksDirForInstall(hypoDir);
  if (hooksDir) candidateDirs.push(hooksDir);
  else if (skip) result.skipped.push(skip);

  // Best-effort fallback: only when `.git` is a real directory here (a plain
  // checkout, not a linked worktree's gitdir-pointer FILE, which this join
  // would misread entirely — resolveGitHooksDir already handles that layout
  // correctly via the primary candidate above).
  const legacyGitDir = join(hypoDir, '.git');
  if (existsSync(legacyGitDir) && statSync(legacyGitDir).isDirectory()) {
    const legacyHooksDir = join(legacyGitDir, 'hooks');
    // Canonicalize before trusting this candidate. The primary path above
    // already refuses to write through a `.git/hooks` that resolves outside
    // the repo (resolveGitHooksDir's `owned` check), but that refusal does
    // nothing for THIS fallback, which built its candidate by string join,
    // not by resolving anything. If `.git/hooks` (or any ancestor of it) is
    // itself a symlink to an external directory, the join above still points
    // there, and the leaf-only unsafeHookTargetReason() below cannot see it:
    // lstat on the FINAL path component says nothing about a symlink the OS
    // already followed to reach that component. Codex reproduced exactly
    // this (2026-08-27): a symlinked `.git/hooks` pointing at an external
    // directory let this fallback delete a file the primary path had
    // already, correctly, refused to touch.
    const resolvedCandidate = canonicalize(legacyHooksDir);
    if (isInside(resolvedCandidate, canonicalize(legacyGitDir))) {
      candidateDirs.push(legacyHooksDir);
    }
  }

  const seen = new Set();
  for (const dir of candidateDirs) {
    const hookPath = join(dir, 'pre-commit');
    // Dedupe by the resolved real path, not the string: the primary candidate
    // is realpath'd internally (resolveGitHooksDir's canonicalize) while the
    // legacy join above is not, so the same physical file can arrive under two
    // different-looking paths. Falling back to the raw path when the file does
    // not exist is fine — two distinct absent candidates never collide.
    let key = hookPath;
    try {
      key = realpathSync(hookPath);
    } catch {
      // leave key as hookPath
    }
    if (seen.has(key)) continue;
    seen.add(key);

    const unsafe = unsafeHookTargetReason(hookPath);
    if (unsafe) {
      result.skipped.push(`${hookPath} (${unsafe})`);
      continue;
    }
    if (!existsSync(hookPath)) continue; // already absent, nothing to report

    let content;
    try {
      content = readFileSync(hookPath, 'utf-8');
    } catch (e) {
      result.skipped.push(`${hookPath} (cannot read: ${e.code || e.message})`);
      continue;
    }
    if (
      !content.includes(WIKI_PRE_COMMIT_MARKER_START) ||
      !content.includes(WIKI_PRE_COMMIT_MARKER_END)
    ) {
      result.skipped.push(`${hookPath} (not managed by Hypomnema — preserving)`);
      continue;
    }

    // Report the backup only past the ownership gate above: a vault with no
    // Hypomnema hook at all (or a symlinked/unreadable one) can still happen
    // to have a stray pre-commit.bak lying around, and attributing that to
    // "from --force-commands" before confirming this IS a Hypomnema-managed
    // hook would misdescribe someone else's file.
    const bakPath = `${hookPath}.bak`;
    if (existsSync(bakPath)) result.bakPresent.push(bakPath);

    const span = findMarkerSpan(content, WIKI_PRE_COMMIT_MARKER_START, WIKI_PRE_COMMIT_MARKER_END);
    if (!span.ok) {
      result.skipped.push(`${hookPath} (${span.reason} — preserving)`);
      continue;
    }

    // init writes the marker as the ENTIRE hook body: a bare "#!/bin/sh\n"
    // right before WIKI_PRE_COMMIT_MARKER_START, nothing after
    // WIKI_PRE_COMMIT_MARKER_END. A file with no shebang there was never
    // written by init even if it happens to carry a well-formed marker span
    // (hand-authored or copy-pasted) — deleting it on marker presence alone
    // would remove code we do not own. A user who appended their own check
    // after the block turned this into a file we only partly own. init's own
    // --force-commands path handles the analogous case by OVERWRITING with
    // equivalent content (a safe merge); uninstall has no such repair, only
    // rmSync, so treating "extra content" the same as "fully ours" would
    // silently delete the user's check with no way back.
    const before = content.slice(0, span.startIdx);
    const after = content.slice(span.endIdx + WIKI_PRE_COMMIT_MARKER_END.length);
    if (!/^#![^\n]*\n$/.test(before)) {
      result.skipped.push(
        `${hookPath} (hook carries content before the Hypomnema block — preserving)`,
      );
      continue;
    }
    if (after.trim() !== '') {
      result.skipped.push(
        `${hookPath} (hook carries content after the Hypomnema block — preserving)`,
      );
      continue;
    }

    // A well-formed span (one start, one end, in order) with a bare shebang
    // before it and nothing after proves only the SHAPE around the block is
    // ours. It says nothing about what is INSIDE the block — a marker pair
    // can be hand-copied around arbitrary content, including a user's own
    // check (codex BLOCKER, 2026-08-27). Refuse unless the body itself is
    // recognizable as what wikiPreCommitContent() writes.
    if (!isOwnedWikiPreCommitBody(content, span)) {
      result.skipped.push(
        `${hookPath} (marker span present but its body does not match the hook Hypomnema writes — preserving)`,
      );
      continue;
    }

    if (apply) rmSync(hookPath);
    result.removed.push(hookPath);
  }

  // Every candidate came back plain-absent (existsSync(hookPath) was false for
  // all of them): nothing was removed, and nothing was skipped-with-a-reason
  // either, so silence here would read as "there was nothing to say" when it
  // actually means "the fallback above did not find a marked hook anywhere it
  // looked". Report that explicitly instead of just going quiet — and name the
  // one drift this cannot recover from: if core.hooksPath pointed somewhere
  // else at install time and has since been repointed AGAIN (custom to
  // custom, not the default-to-custom case the fallback above does cover),
  // the hook Hypomnema wrote is still sitting at that first custom path,
  // still executable, and can fail a future commit there with no cleanup
  // path from this run.
  if (candidateDirs.length > 0 && result.removed.length === 0 && result.skipped.length === 0) {
    result.skipped.push(
      `no Hypomnema-marked pre-commit hook found in ${candidateDirs.join(' or ')} — if core.hooksPath ` +
        `pointed somewhere else at install time and has since changed again, the hook Hypomnema wrote ` +
        `may still be sitting at that earlier path; it will keep running on every commit there and can ` +
        `fail commits until it is removed by hand`,
    );
  }

  return result;
}

// ── shell function block removal ────────────────────────────────────────────

// init picks ONE rc file at install time from $SHELL (or --shell-config), but
// $SHELL by uninstall time may point somewhere else, or init may have run in
// a different shell session altogether — so both common rc files are checked
// by default rather than guessing one. Only the marker span itself is
// stripped; every other byte in the file, including surrounding blank lines,
// is left exactly as it was. A malformed span (duplicated or swapped markers,
// see findMarkerSpan above) leaves the file completely untouched: an rc file
// is the user's own, and this script has no backup to restore it from.
function removeShellFunctionBlock(shellConfigPath, apply) {
  if (!existsSync(shellConfigPath)) return null;
  const content = readFileSync(shellConfigPath, 'utf-8');
  if (!content.includes(SHELL_MARKER_START) && !content.includes(SHELL_MARKER_END)) {
    return null; // block not present here at all
  }

  const span = findMarkerSpan(content, SHELL_MARKER_START, SHELL_MARKER_END);
  if (!span.ok) {
    return { path: shellConfigPath, removed: false, skipped: span.reason };
  }

  // A well-formed span proves only that a start and an end marker exist in
  // order — nothing about what sits between them. A marker pair copy-pasted
  // around a user's own function (or appended to, inside the same span) would
  // pass every check above and get removed along with that user's code
  // (codex BLOCKER, 2026-08-27). Refuse unless the body between the markers
  // is byte-identical to what init.mjs installs.
  if (!isOwnedShellFunctionBody(content, span)) {
    return {
      path: shellConfigPath,
      removed: false,
      skipped:
        'marker span present but its body does not match the shell function Hypomnema installs',
    };
  }

  const updated =
    content.slice(0, span.startIdx) + content.slice(span.endIdx + SHELL_MARKER_END.length);
  if (apply) writeFileSync(shellConfigPath, updated);
  return { path: shellConfigPath, removed: true, skipped: null };
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    apply: false,
    codex: false,
    hooksDir: null,
    forceCommands: false,
    forceExtensions: false,
    hypoDir: null,
    shellConfig: null,
    keepShell: false,
    keepWikiHook: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--codex') args.codex = true;
    else if (arg === '--force-commands') args.forceCommands = true;
    else if (arg === '--force-extensions') args.forceExtensions = true;
    else if (arg === '--keep-shell') args.keepShell = true;
    else if (arg === '--keep-wiki-hook') args.keepWikiHook = true;
    else if (arg.startsWith('--hooks-dir=')) args.hooksDir = arg.slice(12);
    // expandHome mirrors init.mjs's own --hypo-dir/--shell-config parsing
    // (init.mjs's parseArgs) exactly, reusing the same function from
    // ./lib/hypo-root.mjs rather than re-deriving it. Uninstall must undo
    // whatever path init actually wrote to disk, and init resolves a leading
    // "~/" itself (the shell never does, since the value arrives already
    // quoted inside "--flag=value"); skipping that step here would silently
    // fail to find the vault or rc file a user installed with "~/..." to
    // begin with.
    else if (arg.startsWith('--hypo-dir=')) args.hypoDir = expandHome(arg.slice(11));
    else if (arg.startsWith('--shell-config=')) args.shellConfig = expandHome(arg.slice(15));
  }
  return args;
}

// ── hook map (single source of truth) ───────────────────────────────────────

function loadHookFiles() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf-8'));
  } catch {
    console.error('Error: cannot read hooks/hooks.json');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }
  if (!cfg?.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) {
    console.error('Error: hooks/hooks.json must contain a "hooks" object');
    console.error(PKG_INTEGRITY_HINT);
    process.exit(1);
  }

  const hookFiles = new Set();
  const normalizedHookMap = {};

  for (const [event, groups] of Object.entries(cfg.hooks)) {
    const filenames = [];
    for (const entry of groups) {
      if (typeof entry === 'string') {
        // legacy flat format: entry is a filename
        hookFiles.add(entry);
        filenames.push(entry);
      } else if (entry && Array.isArray(entry.hooks)) {
        // current group format: extract filename from command string
        for (const h of entry.hooks) {
          if (h.type === 'command' && typeof h.command === 'string') {
            const m = h.command.match(/\/hooks\/([^/\s]+\.mjs)$/);
            if (m) {
              hookFiles.add(m[1]);
              filenames.push(m[1]);
            }
          }
        }
      }
    }
    normalizedHookMap[event] = filenames;
  }

  if (Array.isArray(cfg.shared)) {
    for (const f of cfg.shared) hookFiles.add(f);
  }
  return { hookMap: normalizedHookMap, hookFiles };
}

// ── hook file removal ────────────────────────────────────────────────────────

function removeHookFiles(hooksDir, hookFiles, apply) {
  const removed = [],
    missing = [];
  for (const file of hookFiles) {
    const p = join(hooksDir, file);
    if (existsSync(p)) {
      if (apply) rmSync(p);
      removed.push(p);
    } else {
      missing.push(p);
    }
  }
  // .hypo-provenance.json (scripts/lib/pkg-provenance.mjs) is written next to
  // this exact hooksDir by installHooks/applyHookFiles — same lifecycle as the
  // hook files themselves, so it is removed in the same pass rather than left
  // behind to describe a package root that no longer has any hooks pointing
  // through it. Unlike hookFiles above, this is an optional file (only the
  // manual/npm channel ever writes one) — so, mirroring the loop's own
  // present/absent split, it is only added to `removed` (dry-run: "to remove")
  // when it actually exists; a channel that never wrote one gets no line at
  // all, not a spurious "already absent".
  const sidecar = removeProvenanceSidecar(hooksDir, apply);
  if (sidecar) removed.push(sidecar);
  return { removed, missing };
}

// ── settings.json cleanup ────────────────────────────────────────────────────

function stripSettingsJson(settingsPath, hooksDir, hookMap, apply) {
  if (!existsSync(settingsPath)) return { stripped: [], kept: 0 };

  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { stripped: [], kept: 0, error: `${settingsPath} is not valid JSON — skipping` };
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') return { stripped: [], kept: 0 };

  const stripped = [];
  let changed = false;

  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;

    const managed = hookMap[event] ?? [];
    const isHypoHook = (h) =>
      h.type === 'command' &&
      typeof h.command === 'string' &&
      managed.some((file) => h.command === `node ${hooksDir.replace(HOME, '$HOME')}/${file}`);

    const filtered = groups.flatMap((group) => {
      if (!Array.isArray(group.hooks)) return [group];

      const hypoHooks = group.hooks.filter((h) => isHypoHook(h));
      const userHooks = group.hooks.filter((h) => !isHypoHook(h));

      for (const h of hypoHooks) stripped.push(`${event}: ${h.command}`);

      if (hypoHooks.length === 0) return [group]; // no Hypomnema hooks → keep as-is
      changed = true;
      if (userHooks.length === 0) return []; // all Hypomnema → remove group
      return [{ ...group, hooks: userHooks }]; // mixed → keep only user hooks
    });

    settings.hooks[event] = filtered;
  }

  if (changed && apply) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  return { stripped, kept: 0 };
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
const dryRun = !args.apply;

// --hooks-dir only redirects the ~/.claude/hooks/*.mjs cleanup below (see the
// module doc comment). A caller who passes it alone, expecting the run to
// stay confined to that throwaway directory, is surprised when the real
// machine's shell rc files and auto-resolved wiki vault get touched too
// (codex CONCERN, 2026-08-27). Warn before any of the removal functions run,
// not just in the final report, since by the time that report prints under
// --apply the files are already gone.
if (args.hooksDir && !args.keepShell && !args.keepWikiHook) {
  console.error(
    `⚠ --hooks-dir only redirects the ~/.claude/hooks/*.mjs cleanup. This run will still ` +
      `${dryRun ? 'inspect' : 'modify'} the real shell rc files (~/.zshrc, ~/.bashrc, or --shell-config) ` +
      `and the auto-resolved wiki vault's pre-commit hook. Pass --keep-shell and/or --keep-wiki-hook to ` +
      `scope this run to --hooks-dir only.`,
  );
}

const { hookMap, hookFiles } = loadHookFiles();

const claudeHooksDir = args.hooksDir ?? join(HOME, '.claude', 'hooks');
const claudeSettings = join(HOME, '.claude', 'settings.json');

const hookResult = removeHookFiles(claudeHooksDir, hookFiles, args.apply);
const settingsResult = stripSettingsJson(claudeSettings, claudeHooksDir, hookMap, args.apply);
const commandResult = removeCommands(args.apply, args.forceCommands);

// Wiki-side cleanup: the git pre-commit hook and the shell rc block init.mjs
// installs outside ~/.claude entirely. Both are independent of --codex/--hooks-dir:
// --hooks-dir only redirects the ~/.claude/hooks/*.mjs removal above, it does not
// bound these two, since they live outside ~/.claude and already have their own
// scoping flags (--hypo-dir, --shell-config). A caller that wants an uninstall run
// confined to a throwaway --hooks-dir and NOT touching the real machine's shell rc
// files or scanning for a real vault (a sandboxed CI check, for instance) says so
// explicitly with --keep-shell / --keep-wiki-hook rather than relying on
// --hooks-dir to imply it.
// resolveHypoRoot() scans a fixed list of candidate directories under HOME
// (see ./lib/hypo-root.mjs). --keep-wiki-hook says the caller does not want
// this run touching a vault at all, so the scan itself is skipped rather than
// run and then discarded — matching the module doc comment above ("--keep-
// wiki-hook" is described as skipping the cleanup outright, not as skipping
// only the removal after still resolving a root).
const hypoDir = args.keepWikiHook ? null : (args.hypoDir ?? resolveHypoRoot());
const preCommitResult = args.keepWikiHook
  ? {
      removed: [],
      skipped: ['--keep-wiki-hook passed: wiki pre-commit hook cleanup skipped'],
      bakPresent: [],
    }
  : removeWikiPreCommitHook(hypoDir, args.apply);

const shellConfigCandidates = args.shellConfig
  ? [args.shellConfig]
  : [join(HOME, '.zshrc'), join(HOME, '.bashrc')];
const shellBlockOutcomes = args.keepShell
  ? []
  : shellConfigCandidates.map((p) => removeShellFunctionBlock(p, args.apply)).filter(Boolean);
const shellBlockResults = shellBlockOutcomes.filter((r) => r.removed).map((r) => r.path);
const shellBlockSkipped = shellBlockOutcomes.filter((r) => !r.removed);

// Extensions. Order matters: remove files first, then strip
// settings, then surgically clear the per-target SHA map. The SHA strip uses
// removedKeys so a user-modified file we left in place keeps its recorded SHA
// (doctor still has a baseline next run). Settings are path-based and run even
// if no files were removed — a manifest could have registered entries that the
// hook copy was deleted by hand (force-commands legacy state).
const pkgJsonPath = join(HOME, '.claude', 'hypo-pkg.json');
const claudeExtResult = removeExtensions('claude', args.apply, args.forceExtensions);
const claudeExtSettings = stripExtensionSettings(
  claudeSettings,
  claudeHooksDir,
  args.apply,
  ownedHookCommands(pkgJsonPath, 'claude', claudeHooksDir),
);

let codexHookResult = { removed: [], missing: [] };
let codexSettingsResult = { stripped: [] };
let codexCommandResult = null;
let codexExtResult = {
  target: 'codex',
  removed: [],
  removedKeys: [],
  rewrittenKeys: new Map(),
  skippedUserModified: [],
  skippedNonRegular: [],
};
let codexExtSettings = { stripped: [] };

if (args.codex) {
  const codexHooksDir = join(HOME, '.codex', 'hooks');
  const codexSettings = join(HOME, '.codex', 'settings.json');
  codexHookResult = removeHookFiles(codexHooksDir, hookFiles, args.apply);
  codexSettingsResult = stripSettingsJson(codexSettings, codexHooksDir, hookMap, args.apply);
  codexExtResult = removeExtensions('codex', args.apply, args.forceExtensions);
  codexExtSettings = stripExtensionSettings(
    codexSettings,
    codexHooksDir,
    args.apply,
    ownedHookCommands(pkgJsonPath, 'codex', codexHooksDir),
  );
}

// Surgical per-target ext SHA strip — only for files we actually removed. A skill
// we uninstalled only partway is rewritten down to the files we still own.
stripExtensionsFromPkg(
  pkgJsonPath,
  'claude',
  claudeExtResult.removedKeys,
  args.apply,
  claudeExtResult.rewrittenKeys,
);
if (args.codex) {
  stripExtensionsFromPkg(
    pkgJsonPath,
    'codex',
    codexExtResult.removedKeys,
    args.apply,
    codexExtResult.rewrittenKeys,
  );
}

// pkg.json metadata file removal — only when no user-tracked state remains.
// Both command and extension preservation cases hold the file: doctor still
// needs the recorded SHAs of files we left behind so the next sync compares
// against truth, not nothing.
let pkgJsonRemoved = null;
const processedExtTargets = new Set(['claude']);
if (args.codex) processedExtTargets.add('codex');
const keepPkgJson =
  commandResult.skippedUserModified.length > 0 ||
  commandResult.skippedNonRegular.length > 0 ||
  claudeExtResult.skippedUserModified.length > 0 ||
  claudeExtResult.skippedNonRegular.length > 0 ||
  codexExtResult.skippedUserModified.length > 0 ||
  codexExtResult.skippedNonRegular.length > 0 ||
  // Claude-only uninstall must not wholesale-rm pkg.json if extensions.codex
  // (or any other unprocessed target) still tracks live Codex hard-copies.
  unprocessedExtensionTargetRemains(pkgJsonPath, processedExtTargets);
if (existsSync(pkgJsonPath) && !keepPkgJson) {
  if (args.apply) rmSync(pkgJsonPath);
  pkgJsonRemoved = pkgJsonPath;
}

// ── report ───────────────────────────────────────────────────────────────────

const lines = [];
if (dryRun) lines.push('[DRY RUN — pass --apply to make changes]');

const allRemoved = [...hookResult.removed, ...codexHookResult.removed];
const allStripped = [...settingsResult.stripped, ...codexSettingsResult.stripped];
const extRemoved = [...claudeExtResult.removed, ...codexExtResult.removed];
const extSkippedUserModified = [
  ...claudeExtResult.skippedUserModified,
  ...codexExtResult.skippedUserModified,
];
const extSkippedNonRegular = [
  ...claudeExtResult.skippedNonRegular,
  ...codexExtResult.skippedNonRegular,
];
const extStripped = [...claudeExtSettings.stripped, ...codexExtSettings.stripped];

if (allRemoved.length)
  lines.push(
    `✓ Hook files ${dryRun ? 'to remove' : 'removed'} (${allRemoved.length}):\n${allRemoved.map((p) => `  ${p}`).join('\n')}`,
  );
if (commandResult.removed.length)
  lines.push(
    `✓ Slash commands ${dryRun ? 'to remove' : 'removed'} (${commandResult.removed.length}):\n${commandResult.removed.map((p) => `  ${p}`).join('\n')}`,
  );
if (commandResult.skippedUserModified.length)
  lines.push(
    `⊘ Slash commands preserved (user-modified, ${commandResult.skippedUserModified.length}) — pass --force-commands to remove anyway:\n${commandResult.skippedUserModified.map((p) => `  ${p}`).join('\n')}`,
  );
if (commandResult.skippedNonRegular.length)
  lines.push(
    `⊘ Slash commands skipped (non-regular file, ${commandResult.skippedNonRegular.length}) — refusing to follow symlinks:\n${commandResult.skippedNonRegular.map((p) => `  ${p}`).join('\n')}`,
  );
if (extRemoved.length)
  lines.push(
    `✓ Extension files ${dryRun ? 'to remove' : 'removed'} (${extRemoved.length}):\n${extRemoved.map((p) => `  ${p}`).join('\n')}`,
  );
if (extSkippedUserModified.length)
  lines.push(
    `⊘ Extension files preserved (user-modified, ${extSkippedUserModified.length}) — pass --force-extensions to remove anyway:\n${extSkippedUserModified.map((p) => `  ${p}`).join('\n')}`,
  );
if (extSkippedNonRegular.length)
  lines.push(
    `⊘ Extension files skipped (non-regular file, ${extSkippedNonRegular.length}) — refusing to follow symlinks:\n${extSkippedNonRegular.map((p) => `  ${p}`).join('\n')}`,
  );
if (extStripped.length)
  lines.push(
    `✓ settings.json extension entries ${dryRun ? 'to remove' : 'removed'} (${extStripped.length}):\n${extStripped.map((p) => `  ${p}`).join('\n')}`,
  );
if (allStripped.length)
  lines.push(
    `✓ settings.json entries ${dryRun ? 'to remove' : 'removed'} (${allStripped.length}):\n${allStripped.map((p) => `  ${p}`).join('\n')}`,
  );
if (pkgJsonRemoved)
  lines.push(`✓ Package metadata ${dryRun ? 'to remove' : 'removed'}: ${pkgJsonRemoved}`);
if (keepPkgJson && !pkgJsonRemoved && existsSync(pkgJsonPath))
  lines.push(
    `⊘ Package metadata preserved (${pkgJsonPath}) — user-modified or non-regular files still tracked`,
  );
if (hookResult.missing.length)
  lines.push(
    `⊘ Already absent (${hookResult.missing.length}):\n${hookResult.missing.map((p) => `  ${p}`).join('\n')}`,
  );
if (preCommitResult.removed.length)
  lines.push(
    `✓ Wiki pre-commit hook ${dryRun ? 'to remove' : 'removed'} (${preCommitResult.removed.length}):\n${preCommitResult.removed.map((p) => `  ${p}`).join('\n')}`,
  );
if (preCommitResult.skipped.length)
  lines.push(
    `⊘ Wiki pre-commit hook preserved:\n${preCommitResult.skipped.map((p) => `  ${p}`).join('\n')}`,
  );
if (preCommitResult.bakPresent.length)
  lines.push(
    `ⓘ Pre-commit backup left in place (from --force-commands, never touched by uninstall):\n${preCommitResult.bakPresent.map((p) => `  ${p}`).join('\n')}`,
  );
if (shellBlockResults.length)
  lines.push(
    `✓ Shell function block ${dryRun ? 'to remove' : 'removed'} (${shellBlockResults.length}):\n${shellBlockResults.map((p) => `  ${p}`).join('\n')}`,
  );
if (shellBlockSkipped.length)
  lines.push(
    `⊘ Shell function block preserved:\n${shellBlockSkipped.map((r) => `  ${r.path} (${r.skipped})`).join('\n')}`,
  );

if (settingsResult.error) lines.push(`⚠ ${settingsResult.error}`);
if (claudeExtSettings.error) lines.push(`⚠ ${claudeExtSettings.error}`);
if (codexExtSettings.error) lines.push(`⚠ ${codexExtSettings.error}`);

if (
  !allRemoved.length &&
  !allStripped.length &&
  !extRemoved.length &&
  !extStripped.length &&
  !hookResult.missing.length &&
  !commandResult.removed.length &&
  !pkgJsonRemoved &&
  !commandResult.skippedUserModified.length &&
  !extSkippedUserModified.length &&
  !extSkippedNonRegular.length &&
  !preCommitResult.removed.length &&
  !shellBlockResults.length
) {
  lines.push('Nothing to uninstall — Hypomnema does not appear to be installed.');
}

console.log(lines.join('\n\n'));
