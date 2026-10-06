// The one temp+rename writer. Six byte-identical copies of this function used to
// live in hooks/ and scripts/lib/, and a fix landed in two of them (#296) while
// the other four kept the bug. That is the whole reason this file exists: a
// defense that lives in six places is a defense you can only half-apply.
//
// Hooks are copied standalone into ~/.claude/hooks/, so this has to live in
// hooks/ and be listed in hooks/shared.json. scripts/ may import it; the reverse
// direction is what breaks for every installed copy.
//
// Node built-ins only, per the hooks rule.
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Commit `content` to `path` via a temp file and a rename, so a partial or
 * failed write lands on a throwaway name and the target is never torn.
 *
 * The temp name carries this pid and a fresh random rather than a shared
 * `<path>.tmp` slot, so concurrent writers never fight over it. That is also
 * why a leaked temp is permanent: nothing ever picks the same name again, so
 * the file sits in the vault forever, close after close. Both failure points
 * leak one: the rename (the target stays untouched, which is the point) and
 * the write itself (ENOSPC or EDQUOT partway through). Clean up on either, and
 * never let the cleanup hide the error that got us here.
 *
 * Rename atomicity swaps the directory entry. By default it is NOT power-loss
 * durable: there is no fsync, same as everything else in the vault. `durable`
 * adds one for the writes a later step depends on surviving a power loss in
 * order (the view backups, then the record that names them): the temp file is
 * synced before the rename, and the directory (every directory this call had to
 * create, and the one above the first of them) after it. A directory that
 * cannot be opened for sync (EISDIR or EPERM on some platforms) is skipped;
 * every other error propagates.
 *
 * @param {string} path absolute path to write
 * @param {string|Buffer} content bytes to commit
 * @param {{durable?: boolean}} [opts]
 */
export function atomicWrite(path, content, { durable = false } = {}) {
  const dir = dirname(path);
  const created = mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    if (durable) {
      const fd = openSync(tmp, 'w');
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      writeFileSync(tmp, content);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
  if (durable) {
    for (let d = dir; ; d = dirname(d)) {
      fsyncDir(d);
      if (!created || d === dirname(created) || d === dirname(d)) break;
    }
  }
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch (err) {
    if (err?.code !== 'EISDIR' && err?.code !== 'EPERM') throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
