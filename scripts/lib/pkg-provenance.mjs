/**
 * `.hypo-provenance.json` sidecar: copy-time producer proof for the
 * standalone (manual/npm) hooks channel.
 *
 * hooks/hypo-shared.mjs's resolvePkgRoot() falls back to this file, verified
 * against its own package name + a SHA-256 of the running hypo-shared.mjs,
 * whenever self-location can't confirm a package root — the standalone hooks
 * copy has no package.json alongside it to walk up to, by design (hooks
 * import only Node built-ins, nothing outside the hooks dir).
 *
 * This is accidental-staleness protection, not a security boundary: any
 * process running as this OS user can edit this JSON file freely, same as it
 * could edit hooks/hypo-shared.mjs itself. It only guards against the
 * accidental drift init/upgrade left unguarded before this fix — a hook
 * file skip (already-present) that still let hypo-pkg.json's cached pointer
 * move on to a newer version, silently mismatching the code actually copied.
 *
 * The filename and the producer-name check ("hypomnema") here must stay
 * byte-identical with hooks/hypo-shared.mjs's own copy of this contract —
 * hooks can't import scripts/, so the two sides are duplicated, not shared.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { sha256 } from './pkg-json.mjs';
import { readCoreHooksConfig, deriveCoreHookBasenames } from './core-hooks.mjs';

export const PROVENANCE_FILENAME = '.hypo-provenance.json';
export const EXPECTED_PKG_NAME = 'hypomnema';

// Field name for the aggregate hook-set hash (BLOCKER A). Exported so
// scripts/doctor.mjs reads/writes the same key instead of duplicating the
// string literal — doctor already imports this module for
// PROVENANCE_FILENAME/EXPECTED_PKG_NAME, so importing one more constant costs
// nothing and closes the duplication CONCERN 1 flagged for the filename/name
// pair (those two stay duplicated only because hooks/hypo-shared.mjs can't
// import this file at all).
export const HOOKS_DIGEST_FIELD = 'hooksDigest';

/**
 * Deterministic aggregate hash over every hook file hooks/hooks.json wires up
 * (every event handler's file plus every `shared` entry) — the exact set
 * installHooks/applyHookFiles copy, derived from hooks.json itself rather
 * than hand-listed here so this can never drift from what actually gets
 * copied. `dir` is read for CONTENT: pass hooksSrcDir at write time (the
 * package's own hooks/, immediately after files were copied out of it — see
 * writeProvenanceSidecar) and the installed hooksDir at doctor-check time
 * (mirrors how hypoSharedSha256 below is written from source but verified
 * against the installed copy).
 *
 * Deliberately NOT what the runtime resolver reads: hooks/hypo-shared.mjs's
 * readVerifiedProvenancePkgRoot() only ever compares hypoSharedSha256, one
 * file, because hook modules load on every single hook event and hashing an
 * entire directory on every load would tax the hot path for a check only
 * `hypomnema doctor` needs to run once per invocation. This digest is that
 * doctor-only, directory-wide check: it catches a hooks/ dir where some OTHER
 * file (e.g. hypo-personal-check.mjs) went stale while hypo-shared.mjs itself
 * stayed byte-identical, which the single-file SHA the runtime trusts cannot
 * see at all.
 *
 * Sorted basenames, `<file>\n<sha256-of-file-hex>\n` per file concatenated,
 * then SHA-256 of that string — order and content only, never mtime/size.
 * Returns null if hooks.json can't be read/parsed or any listed file can't be
 * read, so a caller can treat "couldn't compute" the same as "nothing to
 * compare" rather than writing/trusting a bogus digest.
 */
export function computeHooksDigest(pkgRoot, dir) {
  const cfgRes = readCoreHooksConfig(pkgRoot);
  if (!cfgRes.ok) return null;
  const files = [...deriveCoreHookBasenames(cfgRes.cfg)].sort();
  try {
    let acc = '';
    for (const file of files) {
      acc += `${file}\n${sha256(readFileSync(join(dir, file)))}\n`;
    }
    return sha256(acc);
  } catch {
    return null;
  }
}

export function provenancePath(hooksDir) {
  return join(hooksDir, PROVENANCE_FILENAME);
}

/**
 * Write/refresh the sidecar next to a standalone hooks copy at `hooksDir`.
 * `hooksSrcDir` is the package's own hooks/ (the source hypo-shared.mjs was
 * just copied FROM) — its content is what gets hashed, since that hash is
 * what the copy left at `hooksDir` will actually match.
 *
 * Callers must invoke this every run that touches — or even just re-verifies
 * — the hook file set, EVEN when every individual .mjs file was skipped as
 * already-present. A skipped hook copy that still lets hypo-pkg.json's
 * pkgVersion move on to a newer release is exactly the bug this sidecar
 * exists to catch; refreshing it only when files actually changed would
 * reintroduce that gap under a new name.
 *
 * Returns the sidecar path written, or null if the source couldn't be
 * hashed (leaves any pre-existing sidecar untouched rather than write a
 * broken one).
 *
 * `hooksDigest` (BLOCKER A) is best-effort: computed from the same
 * `hooksSrcDir`, over the file set hooks.json actually wires up. Unlike
 * hypoSharedSha256 above, a failure to compute it does not abort the write —
 * it is a doctor-only freshness signal, not part of the runtime contract
 * (hooks/hypo-shared.mjs never reads this field), so a sidecar the runtime
 * can verify should not be withheld just because the digest step failed.
 */
export function writeProvenanceSidecar(hooksDir, pkgRoot, pkgVersion, hooksSrcDir, dryRun) {
  let hypoSharedSha256;
  try {
    hypoSharedSha256 = sha256(readFileSync(join(hooksSrcDir, 'hypo-shared.mjs')));
  } catch {
    return null;
  }
  const hooksDigest = computeHooksDigest(pkgRoot, hooksSrcDir);
  const dest = provenancePath(hooksDir);
  const data = {
    pkgRoot,
    pkgVersion,
    hypoSharedSha256,
    ...(hooksDigest ? { [HOOKS_DIGEST_FIELD]: hooksDigest } : {}),
    copiedAt: new Date().toISOString(),
  };
  if (!dryRun) atomicWriteJson(dest, data);
  return dest;
}

// Tmp file in the SAME directory as `dest`, then rename over it (CONCERN 2):
// a reader (readVerifiedProvenancePkgRoot in hooks/hypo-shared.mjs) that
// races a plain truncate-then-write can observe a half-written file and
// JSON.parse throws, degrading PKG_ROOT to null for that hook invocation.
// Same directory is required for the rename to be atomic — crossing a
// filesystem boundary would fall back to a non-atomic copy+delete.
function atomicWriteJson(dest, data) {
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** Remove the sidecar at `hooksDir`, if present. Returns the path removed, or null. */
export function removeProvenanceSidecar(hooksDir, apply) {
  const dest = provenancePath(hooksDir);
  if (!existsSync(dest)) return null;
  if (apply) unlinkSync(dest);
  return dest;
}

/** Non-mutating read. Returns the parsed sidecar, or null on absence/corruption. */
export function readProvenanceSidecar(hooksDir) {
  try {
    return JSON.parse(readFileSync(provenancePath(hooksDir), 'utf-8'));
  } catch {
    return null;
  }
}
