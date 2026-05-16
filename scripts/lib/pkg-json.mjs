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
