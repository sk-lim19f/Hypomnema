#!/usr/bin/env node
/**
 * scripts/capture.mjs — Reverse extension capture (MVP capture design).
 *
 * Pulls extensions authored the "normal way" under `~/.claude/{commands,agents}/`
 * (readdir enumeration) and canonical hooks registered in `~/.claude/settings.json`
 * (settings enumeration) into the wiki `~/hypomnema/extensions/{commands,agents,hooks}/`
 * so they propagate to other machines via the existing forward-sync ("register on
 * A → sync on B").
 *
 * Scope: commands + agents (pure file copy, no settings.json) and hooks (settings
 * reverse-capture, lossless round-trip only). skills (directory support) are
 * deferred to a separate PR.
 *
 * Naming (capture design §3): the wiki STORAGE name is `hypo-ext-<name>.<ext>` (keeps
 * the discovery whitelist), and a sidecar `hypo-ext-<name>.manifest.json` records
 * `{ type, installName, ... }` so forward-sync installs the file back under the
 * user's ORIGINAL name (`~/.claude/<type>/<name>.<ext>`), not the wiki storage name.
 * For hooks the manifest also carries `{ event, matcher?, timeout? }` so the original
 * settings.json registration is restored on the far machine.
 *
 * Adopt (capture design §4): capture copies the source verbatim into the wiki, then
 * runs forward-sync. The install target already holds byte-identical content, so
 * `copyOne` hits its `up-to-date` branch and records the SHA — ownership is
 * acquired through the normal sync path, never by injecting a SHA directly.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  realpathSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { sha256, isRegularFile, readFileIfRegular } from './lib/pkg-json.mjs';
import { resolveHypoRoot } from './lib/hypo-root.mjs';
import {
  syncExtensions,
  readExtensionPkgStateNoMutate,
  isValidInstallStem,
  scanSettingsHooks,
  parseCapturableHookCommand,
  HOOK_EVENT_ALLOWLIST,
  EXT_PREFIX,
} from './lib/extensions.mjs';
import { readCoreHooksConfig, deriveCoreHookBasenames } from './lib/core-hooks.mjs';

const HOME = homedir();

// The package root (contains hooks/hooks.json) so reverse-capture can reserve the
// core hook basenames without importing init.mjs (which has exit-on-error side
// effects). capture.mjs lives in scripts/, so the root is one level up.
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Captured types and their singular manifest `type` value. commands/agents install
// as top-level `.md` files; hooks install as `.mjs` and additionally register a
// settings.json entry (reverse of forward-sync).
const CAPTURE_TYPES = ['commands', 'agents', 'hooks'];
const TYPE_SINGULAR = { commands: 'command', agents: 'agent', hooks: 'hook' };
const TYPE_EXT = { commands: '.md', agents: '.md', hooks: '.mjs' };

function pkgJsonPath() {
  return join(HOME, '.claude', 'hypo-pkg.json');
}

// ── pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Decide whether a top-level `~/.claude/<type>/<file>` is a capture candidate.
 * Excludes (capture design §6): the reserved `hypo` namespace (case-insensitive — core
 * hooks/commands + already-synced hypo-ext-* copies), anything already owned
 * (a recorded SHA for its install path means the wiki already manages it), and
 * non-.md files. Symlink/non-regular is checked by the caller (needs an fs stat).
 */
export function isCaptureCandidate(type, file, recorded) {
  if (!file.endsWith(TYPE_EXT[type])) return { ok: false, reason: `not a ${TYPE_EXT[type]} file` };
  const lower = file.toLowerCase();
  if (lower === 'hypo' || lower.startsWith('hypo-')) {
    return { ok: false, reason: 'reserved hypo namespace' };
  }
  if (recorded[`${type}/${file}`]) {
    return { ok: false, reason: 'already managed by the wiki' };
  }
  return { ok: true };
}

/** Order-independent deep equality for parsed JSON values (objects/arrays/scalars).
 * Manifests are compared by content, not key order, so a hand-reordered but
 * equivalent sidecar is still recognized as `already` rather than a false conflict. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Plan the capture of one candidate against the current wiki state. Generalized
 * over extension type: the caller assembles the desired `wantManifest` (commands
 * and agents get `{ type, installName }`; hooks additionally carry
 * `{ event, matcher?, timeout? }`) and this decides the outcome by comparing the
 * source SHA and doing a deep-equality check against any existing sidecar. Pure
 * w.r.t. decisions; the caller supplies the already-read source + wiki contents so
 * this stays testable.
 *
 * status:
 *   'invalid'  — the installName stem is unsafe/reserved (skip).
 *   'conflict' — a wiki storage file or sidecar manifest already exists and
 *                disagrees (refuse; never silently overwrite, capture design §7).
 *   'already'  — wiki file + manifest already match this capture (no-op).
 *   'ready'    — safe to write.
 */
export function planCapture({ wantManifest, srcSha, existingFileSha, existingManifestRaw }) {
  if (!isValidInstallStem(wantManifest.installName)) {
    return { status: 'invalid', reason: `invalid installName "${wantManifest.installName}"` };
  }

  if (existingFileSha !== null && existingFileSha !== undefined) {
    if (existingFileSha !== srcSha) {
      return { status: 'conflict', reason: 'wiki storage file exists with different content' };
    }
    // The storage file matches — the manifest must also match, else install
    // semantics (installName/event/matcher/timeout) would differ.
    if (existingManifestRaw == null) {
      return { status: 'conflict', reason: 'wiki file exists without its installName manifest' };
    }
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'wiki manifest is not valid JSON' };
    }
    if (!deepEqual(parsed, wantManifest)) {
      return { status: 'conflict', reason: 'wiki manifest declares a different mapping' };
    }
    return { status: 'already', manifest: wantManifest };
  }
  // No wiki storage file yet. A stray manifest with a different mapping is still a conflict.
  if (existingManifestRaw != null) {
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'stray wiki manifest is not valid JSON' };
    }
    if (!deepEqual(parsed, wantManifest)) {
      return { status: 'conflict', reason: 'stray wiki manifest declares a different mapping' };
    }
  }
  return { status: 'ready', manifest: wantManifest };
}

/**
 * Reverse-generate the sidecar manifest for a capture candidate. commands/agents
 * carry only `{ type, installName }`; hooks additionally carry the settings
 * registration fields `{ event, matcher?, timeout? }`. matcher/timeout are omitted
 * when absent (an empty-string matcher is already normalized to undefined by the
 * scanner) via conditional spread, so the in-memory object never carries an
 * `undefined`-valued key that would break the planCapture deep-equality check.
 */
function buildWantManifest(c) {
  const manifest = { type: TYPE_SINGULAR[c.type], installName: c.stem };
  if (c.type === 'hooks') {
    manifest.event = c.event;
    if (c.matcher !== undefined && c.matcher !== '') manifest.matcher = c.matcher;
    if (c.timeout !== undefined) manifest.timeout = c.timeout;
  }
  return manifest;
}

// ── filesystem orchestration ─────────────────────────────────────────────────

function scanCandidates(claudeHome, recorded, types) {
  const out = [];
  for (const type of types) {
    const dir = join(claudeHome, type);
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      const verdict = isCaptureCandidate(type, file, recorded);
      if (!verdict.ok) continue;
      const srcPath = join(dir, file);
      if (!isRegularFile(srcPath)) continue; // never follow symlinks/sockets
      out.push({ type, file, stem: file.slice(0, -TYPE_EXT[type].length), srcPath });
    }
  }
  return out;
}

// The preservable shape a capturable hook must have (F3). Anything outside these
// key sets, or a non-positive-integer timeout, means a lossless round-trip cannot
// be guaranteed → skip rather than drop a field on the far machine.
const ALLOWED_HOOK_KEYS = new Set(['type', 'command', 'timeout']);
const ALLOWED_GROUP_KEYS = new Set(['matcher', 'hooks']);

function subsetOf(keys, allowed) {
  for (const k of keys) if (!allowed.has(k)) return false;
  return true;
}

/**
 * Enumerate capturable hooks from `~/.claude/settings.json`. Unlike commands/agents
 * (readdir), hooks are discovered by walking the settings registration and keeping
 * only entries that round-trip losslessly to the canonical form forward-sync emits.
 * Returns `{ candidates, skipped }`; every rejected entry gets a visible skip reason
 * (never a silent drop, capture design F4) so a user can see why a hook was passed
 * over — including absolute-path / tilde registrations that are legal but not
 * canonical.
 *
 * A candidate must satisfy ALL of: strict command grammar
 * (`parseCapturableHookCommand`) resolving under `~/.claude/hooks/`; the resolved
 * `.mjs` is a real regular file (no symlink / non-regular); `type === 'command'`;
 * the event is in `HOOK_EVENT_ALLOWLIST`; a preservable shape (F3); the case-folded
 * basename appears exactly once across all settings hooks (F6); and the stem is not
 * a core hook, not the reserved hypo namespace, and not already wiki-owned.
 */
export function scanHookCandidates(claudeHome, settingsPath, recorded, coreBasenames) {
  const candidates = [];
  const skipped = [];
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    // Absent or invalid settings.json → nothing to capture (not an error).
    return { candidates, skipped };
  }

  const records = scanSettingsHooks(settings);

  // First pass: count case-folded basenames across every record whose command
  // parses to a canonical basename. A basename seen 2+ times (multiple events, or
  // the same event with different matchers) cannot be reverse-generated to a single
  // manifest, so ALL its registrations are skipped (F6).
  const parsedByRecord = new Map();
  const basenameCounts = new Map();
  for (const rec of records) {
    const parsed = parseCapturableHookCommand(rec.command);
    parsedByRecord.set(rec, parsed);
    if (parsed.ok) {
      const key = parsed.basename.toLowerCase();
      basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
    }
  }

  // Second pass: classify each record.
  for (const rec of records) {
    const parsed = parsedByRecord.get(rec);
    if (!parsed.ok) {
      skipped.push({ type: 'hooks', command: rec.command, reason: parsed.reason });
      continue;
    }
    const { stem, basename } = parsed;
    const label = `hooks/${basename}`;

    // Duplicate first: a basename registered 2+ times is uniformly skipped so both
    // sides report the same reason.
    if (basenameCounts.get(basename.toLowerCase()) >= 2) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'duplicate-registration',
      });
      continue;
    }
    if (rec.type !== 'command') {
      skipped.push({ type: 'hooks', command: rec.command, basename, reason: 'non-command-type' });
      continue;
    }
    if (!HOOK_EVENT_ALLOWLIST.has(rec.event)) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'event-not-allowlisted',
      });
      continue;
    }
    if (
      !subsetOf(rec.hookKeys, ALLOWED_HOOK_KEYS) ||
      !subsetOf(rec.groupKeys, ALLOWED_GROUP_KEYS) ||
      (rec.timeout !== undefined && !(Number.isInteger(rec.timeout) && rec.timeout > 0))
    ) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'unpreservable-shape',
      });
      continue;
    }
    if (coreBasenames.has(basename.toLowerCase())) {
      skipped.push({ type: 'hooks', command: rec.command, basename, reason: 'core-hook' });
      continue;
    }
    if (recorded[label]) {
      skipped.push({
        type: 'hooks',
        command: rec.command,
        basename,
        reason: 'already-managed by the wiki',
      });
      continue;
    }
    // The command resolved under $HOME/.claude/hooks; the source must be a real
    // regular file there (a symlink or non-regular is refused, capture design F4).
    const srcPath = join(claudeHome, 'hooks', basename);
    if (!existsSync(srcPath) || !isRegularFile(srcPath)) {
      skipped.push({ type: 'hooks', command: rec.command, basename, reason: 'unresolved-source' });
      continue;
    }
    candidates.push({
      type: 'hooks',
      file: basename,
      stem,
      srcPath,
      event: rec.event,
      matcher: rec.matcher,
      timeout: rec.timeout,
      label,
    });
  }
  return { candidates, skipped };
}

function parseArgs(argv) {
  const args = { names: [], all: false, types: CAPTURE_TYPES.slice(), dryRun: false, help: false };
  let hypoDir = null;
  for (const a of argv.slice(2)) {
    if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--type=')) {
      args.types = a
        .slice(7)
        .split(',')
        .map((s) => s.trim())
        .filter((t) => CAPTURE_TYPES.includes(t));
    } else if (a.startsWith('--hypo-dir=')) hypoDir = a.slice(11);
    else if (!a.startsWith('-')) args.names.push(a);
  }
  args.hypoDir = hypoDir || resolveHypoRoot();
  if (args.types.length === 0) args.types = CAPTURE_TYPES.slice();
  return args;
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// Write via a sibling temp + rename so the final replace is atomic and, crucially,
// never follows a symlink already sitting at `dest` (rename swaps the link itself).
function writeAtomic(dest, buf) {
  const tmp = `${dest}.tmp.${process.pid}`;
  writeFileSync(tmp, buf);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Undo one capture's wiki writes: drop the storage file (.md or .mjs), and either
// restore the manifest bytes we overwrote (a pre-existing same-mapping sidecar) or
// remove the manifest we created. Used on a failed/aborted adopt so a capture never
// half-lands.
function rollbackRec(rec) {
  try {
    unlinkSync(rec.filePath);
  } catch {}
  if (rec.manifestExisted && rec.manifestPrevBuf != null) {
    try {
      writeFileSync(rec.manifestPath, rec.manifestPrevBuf);
    } catch {}
  } else {
    try {
      unlinkSync(rec.manifestPath);
    } catch {}
  }
}

function run(args, { claudeHome = join(HOME, '.claude') } = {}) {
  const extDir = join(args.hypoDir, 'extensions');
  const settingsPath = join(claudeHome, 'settings.json');
  const recorded = readExtensionPkgStateNoMutate(pkgJsonPath(), 'claude');
  // commands/agents enumerate by readdir; hooks enumerate from settings.json.
  const dirTypes = args.types.filter((t) => t !== 'hooks');
  const candidates = scanCandidates(claudeHome, recorded, dirTypes);

  // Hooks are captured from the settings registration. Reserve the core hook
  // basenames deterministically from hooks.json; if that load is not ok (read,
  // parse, or shape failure) skip the whole hooks type rather than risk capturing
  // a core hook (T1 fail-closed contract: gate on ok, not on cfg presence).
  const scanSkipped = [];
  if (args.types.includes('hooks')) {
    const core = readCoreHooksConfig(PKG_ROOT);
    if (!core.ok) {
      log(`⊘ hooks: core hook reservations unavailable (${core.error}) — hooks capture skipped`);
    } else {
      const coreBasenames = deriveCoreHookBasenames(core.cfg);
      const hookScan = scanHookCandidates(claudeHome, settingsPath, recorded, coreBasenames);
      candidates.push(...hookScan.candidates);
      scanSkipped.push(...hookScan.skipped);
    }
  }

  // Surface every scan-time skip with its reason (never a silent drop, F4). Printed
  // before any early return so observability holds even when nothing is capturable.
  for (const s of scanSkipped) {
    const label = s.basename ? `hooks/${s.basename}` : `hooks (${s.command})`;
    log(`⊘ ${label}: ${s.reason} — skipped`);
  }

  // No explicit selection → list candidates and stop (capture design §6).
  if (!args.all && args.names.length === 0) {
    if (candidates.length === 0) {
      log('No capturable extensions found under ~/.claude/{' + args.types.join(',') + '}.');
      return { selected: [], captured: [], skipped: scanSkipped, failed: [], listedOnly: true };
    }
    log('Capturable extensions (pass names to capture, or --all):');
    for (const c of candidates) log(`  ${c.type}/${c.file}`);
    log('');
    log('Note: --all captures every unowned candidate here — not a provenance check.');
    log('Explicit selection is the trust boundary.');
    return {
      selected: candidates,
      captured: [],
      skipped: scanSkipped,
      failed: [],
      listedOnly: true,
    };
  }

  // Resolve the selection.
  let selected;
  if (args.all) {
    selected = candidates;
  } else {
    const byName = new Map();
    for (const c of candidates) {
      byName.set(c.file, c);
      byName.set(c.stem, c);
      byName.set(`${c.type}/${c.file}`, c);
    }
    selected = [];
    for (const name of args.names) {
      const c = byName.get(name);
      if (c) selected.push(c);
      else log(`⊘ ${name}: no capturable candidate by that name — skipped`);
    }
  }

  const captured = [];
  const skipped = [...scanSkipped];
  const failed = [];
  const created = []; // files written THIS run, for rollback on adopt failure

  for (const c of selected) {
    const fileExt = TYPE_EXT[c.type];
    const wikiStem = `${EXT_PREFIX}${c.stem}`;
    const typeDir = join(extDir, c.type);
    const filePath = join(typeDir, `${wikiStem}${fileExt}`);
    const manifestPath = join(typeDir, `${wikiStem}.manifest.json`);

    // A pre-existing NON-regular wiki target (symlink / dir / socket) is a hard
    // conflict: readFileIfRegular reports it as absent, so without this guard a
    // naive write would follow a symlink out of the wiki (codex pre-commit
    // BLOCKER). Refuse before reading or planning.
    if (
      (existsSync(filePath) && !isRegularFile(filePath)) ||
      (existsSync(manifestPath) && !isRegularFile(manifestPath))
    ) {
      const reason = 'wiki target exists but is not a regular file';
      log(`⊘ ${c.type}/${c.file}: ${reason} — skipped`);
      skipped.push({ ...c, reason, status: 'conflict' });
      continue;
    }

    const srcBuf = readFileSync(c.srcPath); // verbatim bytes (capture design §4)
    const srcSha = sha256(srcBuf);
    const existingFileBuf = readFileIfRegular(filePath);
    const existingFileSha = existingFileBuf ? sha256(existingFileBuf) : null;
    const existingManifestBuf = readFileIfRegular(manifestPath);
    const existingManifestRaw = existingManifestBuf ? existingManifestBuf.toString('utf-8') : null;

    const wantManifest = buildWantManifest(c);
    const plan = planCapture({ wantManifest, srcSha, existingFileSha, existingManifestRaw });

    // installFile is the ORIGINAL name the far machine installs under (installName
    // adoption); for hooks that is `<stem>.mjs`, for commands/agents `<stem>.md`.
    const installFile = `${c.stem}${fileExt}`;
    // Ownership keys sync must record for the adoption to count. Hooks track BOTH
    // the `.mjs` and its `.manifest.json` sidecar under the install path (success
    // criterion d); commands/agents track only the single install file.
    const requiredKeys =
      c.type === 'hooks'
        ? [`hooks/${installFile}`, `hooks/${c.stem}.manifest.json`]
        : [`${c.type}/${installFile}`];

    if (plan.status === 'invalid' || plan.status === 'conflict') {
      log(`⊘ ${c.type}/${c.file}: ${plan.reason} — skipped`);
      skipped.push({ ...c, reason: plan.reason, status: plan.status });
      continue;
    }
    if (plan.status === 'already') {
      log(`= ${c.type}/${c.file}: already captured`);
      captured.push({ ...c, installFile, requiredKeys, status: 'already' });
      continue;
    }

    // status === 'ready'. Write the manifest FIRST, then the storage file (capture
    // design §4): a crash between the two leaves only a manifest (no sibling →
    // discovery skips it), never a lone file that forward-sync would install under
    // the wiki storage name. Both writes are atomic (temp + rename) so a symlink at
    // the target is replaced, not followed.
    if (!args.dryRun) {
      mkdirSync(typeDir, { recursive: true });
      const rec = {
        type: c.type,
        stem: c.stem,
        filePath,
        manifestPath,
        manifestExisted: existingManifestBuf != null,
        manifestPrevBuf: existingManifestBuf,
      };
      writeAtomic(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
      writeAtomic(filePath, srcBuf);
      created.push(rec);
    }
    captured.push({ ...c, installFile, requiredKeys, status: 'ready' });
  }

  const toAdopt = captured.filter((c) => c.status === 'ready');
  if (toAdopt.length === 0 || args.dryRun) {
    report(captured, skipped, failed, args.dryRun);
    return { selected, captured, skipped, failed };
  }

  // Adopt: run forward-sync so the install targets (byte-identical) hit the
  // up-to-date branch and record ownership. If sync THROWS, roll back every file
  // written this run so a hard failure never leaves a half-captured extension
  // behind (codex pre-commit CONCERN).
  let sync;
  try {
    sync = syncExtensions({
      extDir,
      hypoDir: args.hypoDir,
      target: 'claude',
      settingsPath: join(claudeHome, 'settings.json'),
      pkgPath: pkgJsonPath(),
      apply: true,
      force: false,
    });
  } catch (err) {
    for (const rec of created) rollbackRec(rec);
    log(`capture aborted: forward-sync failed (${err.message}); wiki files rolled back.`);
    for (const c of toAdopt) {
      c.status = 'failed';
      failed.push(c);
    }
    report([], skipped, failed, false);
    return { selected, captured, skipped, failed, sync: null };
  }
  const newSHAs = sync.newSHAs || {};

  // VERIFY every expected key is owned; roll back any capture whose adoption did
  // not take (e.g. the install target changed between copy and sync → skip-conflict
  // with a null SHA) so the wiki does not keep an un-adopted file. Hooks require
  // BOTH the `.mjs` and the sidecar `.manifest.json` keys (success criterion d).
  for (const c of toAdopt) {
    if (c.requiredKeys.every((k) => newSHAs[k])) {
      c.status = 'captured';
    } else {
      c.status = 'failed';
      failed.push(c);
      const rec = created.find((r) => r.type === c.type && r.stem === c.stem);
      if (rec) rollbackRec(rec);
    }
  }
  const okCaptured = captured.filter((c) => c.status === 'captured' || c.status === 'already');
  for (const w of sync.warnings || []) log(`  sync: ${w}`);
  report(okCaptured, skipped, failed, args.dryRun);
  return { selected, captured, skipped, failed, sync };
}

function report(captured, skipped, failed, dryRun) {
  log('');
  if (captured.length > 0) {
    log(`${dryRun ? 'Would capture' : 'Captured'} ${captured.length} extension(s):`);
    for (const c of captured)
      log(`  ${c.type}/${c.file} → extensions/${c.type}/${EXT_PREFIX}${c.stem}${TYPE_EXT[c.type]}`);
  }
  if (skipped.length > 0) log(`Skipped ${skipped.length} (conflict/invalid — see above).`);
  if (failed.length > 0)
    log(`Failed to adopt ${failed.length} (see sync warnings; wiki files rolled back).`);
  if (!dryRun && captured.some((c) => c.status === 'captured')) {
    log('');
    log('Next: commit + push the wiki, then run `hypomnema upgrade --apply` on another machine.');
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    log('Usage: hypomnema capture [names…] [--all] [--type=commands,agents,hooks] [--dry-run]');
    log('  Pull ~/.claude/{commands,agents} extensions and canonical settings.json');
    log('  hooks into the wiki for cross-machine sync. Hooks are captured only when');
    log('  they round-trip losslessly to the canonical form; others are skipped with');
    log('  a reason.');
    return 0;
  }
  const res = run(args);
  return res.failed.length > 0 ? 1 : 0;
}

function isMain() {
  try {
    if (!process.argv[1]) return false;
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(main());
}

export { parseArgs, scanCandidates, run };
// scanHookCandidates is exported at its definition above.
