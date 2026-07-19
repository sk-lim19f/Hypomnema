/**
 * Shared helpers for reading/writing ~/.claude/hypo-pkg.json safely.
 *
 * - `readPkgJson` returns `{}` on missing/corrupt files but logs a warning so
 *   callers can decide whether to surface it.
 * - `writePkgJsonAtomic` writes via a sibling temp file + rename so a crash
 *   mid-write cannot leave a truncated JSON file behind.
 * - `sha256FileSafe` reads a regular file and returns its hex SHA. Returns
 *   `null` if the path is a symlink or non-regular file — callers must treat
 *   that as a refusal to operate on the destination.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function isRegularFile(path) {
  if (!existsSync(path)) return false;
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

export function readFileIfRegular(path) {
  if (!isRegularFile(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

export function readPkgJson(pkgJsonPath) {
  if (!existsSync(pkgJsonPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // Preserve corrupt file as <name>.corrupt-<ts>.json so the user can recover.
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = `${pkgJsonPath}.corrupt-${ts}.json`;
      renameSync(pkgJsonPath, bak);
      console.error(`[hypomnema] WARN: ${pkgJsonPath} was not valid JSON. Preserved as ${bak}.`);
    } catch {}
    return {};
  }
}

export function writePkgJsonAtomic(pkgJsonPath, data) {
  const dir = dirname(pkgJsonPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${pkgJsonPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  try {
    renameSync(tmp, pkgJsonPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

// Non-mutating read of the version a candidate install root's own package.json
// carries, or null. Shared by writeDualSkipProvenance (what to stamp) and
// upgrade.mjs's read-only report (what to preview/display) so both agree.
export function readVersionAtRoot(root) {
  try {
    const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// Dual-install self-heal: writes a NARROW provenance correction to
// pkgJsonPath, pointing pkgRoot/pkgVersion at the plugin registry's own
// resolved root/version, while preserving every other existing field
// (including a prior `commands` map — that map reflects the PLUGIN's own
// install, not the caller's own run, so unlike a full plugin-mode metadata
// write it must NOT be dropped or touched here).
//
// TOCTOU guard: the caller (upgrade.mjs) resolves `registryRoot` as usable via
// a SEPARATE earlier read (resolveEnabledPluginRoot / usablePkgRoot) — that
// root's own package.json can vanish or corrupt between that resolution and
// this write. Re-reads the version HERE and refuses the correction outright if
// it cannot, rather than stamp a NEW pkgRoot with a STALE version (the old
// recorded one, or none): a wrong root+version pairing is worse than no
// correction. Returns false without writing anything when refused — the
// existing metadata is left exactly as it was, and the caller must not report
// this as "corrected".
export function writeDualSkipProvenance(pkgJsonPath, registryRoot) {
  const registryVersion = readVersionAtRoot(registryRoot);
  if (!registryVersion) return false;
  const existing = readPkgJson(pkgJsonPath);
  writePkgJsonAtomic(pkgJsonPath, {
    ...existing,
    pkgRoot: registryRoot,
    pkgVersion: registryVersion,
  });
  return true;
}
