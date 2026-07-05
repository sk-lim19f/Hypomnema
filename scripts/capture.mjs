#!/usr/bin/env node
/**
 * scripts/capture.mjs — Reverse extension capture (MVP capture design).
 *
 * Pulls extensions authored the "normal way" under `~/.claude/{commands,agents}/`
 * into the wiki `~/hypomnema/extensions/{commands,agents}/` so they propagate to
 * other machines via the existing forward-sync ("register on A → sync on B").
 *
 * MVP scope: commands + agents only (pure file copy, no settings.json). hooks
 * (manifest reverse-generation is lossy) and skills (directory support) are
 * deferred to separate PRs.
 *
 * Naming (capture design §3): the wiki STORAGE name is `hypo-ext-<name>.md` (keeps the
 * discovery whitelist), and a sidecar `hypo-ext-<name>.manifest.json` records
 * `{ type, installName }` so forward-sync installs the file back under the user's
 * ORIGINAL name (`~/.claude/commands/<name>.md`), not the wiki storage name.
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
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { sha256, isRegularFile, readFileIfRegular } from './lib/pkg-json.mjs';
import { resolveHypoRoot } from './lib/hypo-root.mjs';
import {
  syncExtensions,
  readExtensionPkgStateNoMutate,
  isValidInstallStem,
  EXT_PREFIX,
} from './lib/extensions.mjs';

const HOME = homedir();

// MVP-captured types and their singular manifest `type` value. Both install as
// top-level `.md` files, so a single extension covers them.
const CAPTURE_TYPES = ['commands', 'agents'];
const TYPE_SINGULAR = { commands: 'command', agents: 'agent' };
const MD = '.md';

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
  if (!file.endsWith(MD)) return { ok: false, reason: 'not a .md file' };
  const lower = file.toLowerCase();
  if (lower === 'hypo' || lower.startsWith('hypo-')) {
    return { ok: false, reason: 'reserved hypo namespace' };
  }
  if (recorded[`${type}/${file}`]) {
    return { ok: false, reason: 'already managed by the wiki' };
  }
  return { ok: true };
}

/**
 * Plan the capture of one candidate against the current wiki state. Returns a
 * status the caller acts on. Pure w.r.t. decisions; the caller supplies the
 * already-read source + wiki contents so this stays testable.
 *
 * status:
 *   'invalid'  — the derived installName stem is unsafe/reserved (skip).
 *   'conflict' — a wiki .md or sidecar manifest already exists and disagrees
 *                (refuse; never silently overwrite, capture design §7).
 *   'already'  — wiki .md + manifest already match this capture (no-op).
 *   'ready'    — safe to write.
 */
export function planCapture({ type, stem, srcSha, existingMdSha, existingManifestRaw }) {
  if (!isValidInstallStem(stem)) {
    return { status: 'invalid', reason: `invalid installName "${stem}"` };
  }
  const wantManifest = { type: TYPE_SINGULAR[type], installName: stem };

  if (existingMdSha !== null && existingMdSha !== undefined) {
    if (existingMdSha !== srcSha) {
      return { status: 'conflict', reason: 'wiki storage file exists with different content' };
    }
    // .md matches — the manifest must also match, else install semantics differ.
    if (existingManifestRaw == null) {
      return { status: 'conflict', reason: 'wiki file exists without its installName manifest' };
    }
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'wiki manifest is not valid JSON' };
    }
    if (parsed.type !== wantManifest.type || parsed.installName !== wantManifest.installName) {
      return { status: 'conflict', reason: 'wiki manifest declares a different installName/type' };
    }
    return { status: 'already', manifest: wantManifest };
  }
  // No wiki .md yet. A stray manifest with a different mapping is still a conflict.
  if (existingManifestRaw != null) {
    let parsed;
    try {
      parsed = JSON.parse(existingManifestRaw);
    } catch {
      return { status: 'conflict', reason: 'stray wiki manifest is not valid JSON' };
    }
    if (parsed.type !== wantManifest.type || parsed.installName !== wantManifest.installName) {
      return { status: 'conflict', reason: 'stray wiki manifest declares a different mapping' };
    }
  }
  return { status: 'ready', manifest: wantManifest };
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
      out.push({ type, file, stem: file.slice(0, -MD.length), srcPath });
    }
  }
  return out;
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

// Undo one capture's wiki writes: drop the .md, and either restore the manifest
// bytes we overwrote (a pre-existing same-mapping sidecar) or remove the manifest
// we created. Used on a failed/aborted adopt so a capture never half-lands.
function rollbackRec(rec) {
  try {
    unlinkSync(rec.mdPath);
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
  const recorded = readExtensionPkgStateNoMutate(pkgJsonPath(), 'claude');
  const candidates = scanCandidates(claudeHome, recorded, args.types);

  // No explicit selection → list candidates and stop (capture design §6).
  if (!args.all && args.names.length === 0) {
    if (candidates.length === 0) {
      log('No capturable extensions found under ~/.claude/{' + args.types.join(',') + '}.');
      return { selected: [], captured: [], skipped: [], failed: [], listedOnly: true };
    }
    log('Capturable extensions (pass names to capture, or --all):');
    for (const c of candidates) log(`  ${c.type}/${c.file}`);
    log('');
    log('Note: --all captures every unowned regular .md here — not a provenance check.');
    log('Explicit selection is the trust boundary.');
    return { selected: candidates, captured: [], skipped: [], failed: [], listedOnly: true };
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
  const skipped = [];
  const failed = [];
  const created = []; // files written THIS run, for rollback on adopt failure

  for (const c of selected) {
    const wikiStem = `${EXT_PREFIX}${c.stem}`;
    const typeDir = join(extDir, c.type);
    const mdPath = join(typeDir, `${wikiStem}${MD}`);
    const manifestPath = join(typeDir, `${wikiStem}.manifest.json`);

    // A pre-existing NON-regular wiki target (symlink / dir / socket) is a hard
    // conflict: readFileIfRegular reports it as absent, so without this guard a
    // naive write would follow a symlink out of the wiki (codex pre-commit
    // BLOCKER). Refuse before reading or planning.
    if (
      (existsSync(mdPath) && !isRegularFile(mdPath)) ||
      (existsSync(manifestPath) && !isRegularFile(manifestPath))
    ) {
      const reason = 'wiki target exists but is not a regular file';
      log(`⊘ ${c.type}/${c.file}: ${reason} — skipped`);
      skipped.push({ ...c, reason, status: 'conflict' });
      continue;
    }

    const srcBuf = readFileSync(c.srcPath); // verbatim bytes (capture design §4)
    const srcSha = sha256(srcBuf);
    const existingMdBuf = readFileIfRegular(mdPath);
    const existingMdSha = existingMdBuf ? sha256(existingMdBuf) : null;
    const existingManifestBuf = readFileIfRegular(manifestPath);
    const existingManifestRaw = existingManifestBuf ? existingManifestBuf.toString('utf-8') : null;

    const plan = planCapture({
      type: c.type,
      stem: c.stem,
      srcSha,
      existingMdSha,
      existingManifestRaw,
    });

    if (plan.status === 'invalid' || plan.status === 'conflict') {
      log(`⊘ ${c.type}/${c.file}: ${plan.reason} — skipped`);
      skipped.push({ ...c, reason: plan.reason, status: plan.status });
      continue;
    }
    if (plan.status === 'already') {
      log(`= ${c.type}/${c.file}: already captured`);
      captured.push({ ...c, installFile: `${c.stem}${MD}`, status: 'already' });
      continue;
    }

    // status === 'ready'. Write the manifest FIRST, then the .md (capture design §4):
    // a crash between the two leaves only a manifest (no sibling → discovery
    // skips it), never a lone .md that forward-sync would install under the wiki
    // storage name. Both writes are atomic (temp + rename) so a symlink at the
    // target is replaced, not followed.
    if (!args.dryRun) {
      mkdirSync(typeDir, { recursive: true });
      const rec = {
        type: c.type,
        stem: c.stem,
        mdPath,
        manifestPath,
        manifestExisted: existingManifestBuf != null,
        manifestPrevBuf: existingManifestBuf,
      };
      writeAtomic(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n');
      writeAtomic(mdPath, srcBuf);
      created.push(rec);
    }
    captured.push({ ...c, installFile: `${c.stem}${MD}`, status: 'ready' });
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

  // VERIFY each expected key is owned; roll back any capture whose adoption did
  // not take (e.g. the install target changed between copy and sync → skip-conflict
  // with a null SHA) so the wiki does not keep an un-adopted file.
  for (const c of toAdopt) {
    const key = `${c.type}/${c.installFile}`;
    if (newSHAs[key]) {
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
      log(`  ${c.type}/${c.file} → extensions/${c.type}/${EXT_PREFIX}${c.stem}${MD}`);
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
    log('Usage: hypomnema capture [names…] [--all] [--type=commands,agents] [--dry-run]');
    log('  Pull ~/.claude/{commands,agents} extensions into the wiki for cross-machine sync.');
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
