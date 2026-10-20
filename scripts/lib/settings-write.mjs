// settings.json only. The write itself is hooks/atomic-write.mjs (`atomicWrite`);
// this file decides where to write and cleans up around it, and never grows a
// second temp+rename of its own.
//
// What the rename costs (the helper accepts these rather than fork the writer):
//   - mode window: closed. The write runs under umask 0o077, so the temp file and the
//     renamed file are never wider than 0o600 and the chmod back only widens to the
//     original mode. A brand-new file is chmodded to 0o666 & ~umask to keep the
//     default mode. The directory is made before the umask is lowered, for the
//     same reason.
//   - chmod failure: the write already happened, so the call never throws for it (a caller
//     that goes on to copy a hook the new settings name would otherwise leave settings pointing
//     at a missing file). The file keeps the narrower mode and one line goes to stderr; when
//     that is wider than the original (the umask makes it close to unreachable) the result
//     carries `modeWidened: true` and the line names both modes. A new file whose chmod to the
//     default mode fails stays at 0o600 and the line says so.
//   - read-only file: a 0o444 settings.json in a writable directory is now replaced
//     (the old direct write refused with EACCES) and put back to 0o444.
//   - hard links, owner, ACL and xattr: rename breaks a hard link (the other name
//     keeps the old inode) and does not carry owner, ACL or xattr to the new file.
//     Only the mode is restored.
//   - in-place fallback: when no atomic replace is possible the bytes go straight into
//     the live file, and a kill or a partial write would leave truncated JSON with no copy
//     of the old file. So the current bytes are saved first, beside the file
//     (`settings.json.hypo-bak`) or else in a fresh directory under the OS temp dir. With
//     no backup possible the write is refused. The backup is removed once the file reads
//     back as what was written and kept, with its path in the error, when it does not.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { atomicWrite } from '../../hooks/atomic-write.mjs';

const MAX_LINKS = 40;

/**
 * Follow `path` one readlink at a time to the last path of the chain. Each link
 * body is read against the physical parent of the link: `path.resolve` would fold
 * a `..` before the directory links above it and pick a different file.
 *
 * @returns {{target: string, viaLink: boolean}} `target` has a physical parent.
 */
function resolveSettingsTarget(path) {
  const seen = new Set();
  const finish = (p) => {
    try {
      return { target: join(realpathSync(dirname(p)), basename(p)), viaLink: p !== path };
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const refuse = p !== path;
      if (refuse) {
        throw Object.assign(
          new Error(
            `ENOENT: ${path} is a symlink whose target directory ${dirname(p)} does not exist`,
          ),
          { code: 'ENOENT' },
        );
      }
      return { target: p, viaLink: false }; // first write (init): atomicWrite makes the directory
    }
  };
  let p = path;
  for (;;) {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if (err.code === 'ENOENT') return finish(p);
      throw err;
    }
    const isLink = st.isSymbolicLink();
    if (!isLink) return finish(p);
    const loop = seen.has(p) || seen.size >= MAX_LINKS;
    if (loop) {
      throw Object.assign(
        new Error(`ELOOP: too many symbolic links (or a loop) starting at ${path}`),
        {
          code: 'ELOOP',
        },
      );
    }
    seen.add(p);
    const text = readlinkSync(p);
    const next = isAbsolute(text) ? text : `${realpathSync(dirname(p))}${sep}${text}`;
    p = next;
  }
}

/**
 * Save the current bytes of `target` before an in-place write. 'wx' so a backup kept by an
 * earlier failed run (or a link planted at that name) is never overwritten or followed.
 *
 * @returns {string|null} the backup path, or null when the bytes could not be read or no
 *   backup file could be written.
 */
function saveBackup(target) {
  let bytes;
  try {
    bytes = readFileSync(target);
  } catch {
    return null;
  }
  const name = `${basename(target)}.hypo-bak`;
  const sibling = join(dirname(target), name);
  try {
    writeFileSync(sibling, bytes, { flag: 'wx', mode: 0o600 });
    return sibling;
  } catch {
    // the directory that refused the temp file usually refuses this too; try the OS temp dir
  }
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'hypo-settings-'));
    const inTmp = join(dir, name);
    writeFileSync(inTmp, bytes, { flag: 'wx', mode: 0o600 });
    return inTmp;
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

function removeBackup(backup) {
  try {
    if (basename(dirname(backup)).startsWith('hypo-settings-')) {
      rmSync(dirname(backup), { recursive: true, force: true });
    } else {
      unlinkSync(backup);
    }
  } catch {
    // a leftover backup is harmless; the file itself is already correct
  }
}

/**
 * Write `text` to settings.json at `path`. A symlink stays a link and its last
 * target gets the bytes. A dangling link into an existing directory is created
 * through the link; into a missing directory it is refused (ENOENT) and no
 * directory is made. A path that is not a link and does not exist is created.
 *
 * `atomic` is false when the directory refused the temp file (EACCES, EPERM) and
 * the bytes went in place instead, after the old bytes were saved to a backup (see the header).
 * `modeRestored` is true only when the rename
 * changed the mode and the chmod back succeeded. `modeWidened` is true when that chmod failed and
 * the file is now wider than it was (never thrown: the bytes are already written).
 *
 * @returns {{atomic: boolean, target: string, viaLink: boolean, modeRestored: boolean, modeWidened: boolean}}
 */
export function writeSettingsJson(path, text) {
  const { target, viaLink } = resolveSettingsTarget(path);
  let mode;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let atomic = true;
  mkdirSync(dirname(target), { recursive: true }); // before the umask below, so a new directory keeps its default mode
  const oldMask = process.umask(0o077);
  try {
    try {
      atomicWrite(target, text);
    } finally {
      process.umask(oldMask);
    }
  } catch (err) {
    // EBUSY (rename onto a bind-mounted file) and EXDEV take the in-place path like a read-only directory.
    const fallback = ['EACCES', 'EPERM', 'EBUSY', 'EXDEV'].includes(err.code);
    if (!fallback) throw err;
    // A missing target has no old bytes to lose. Otherwise no backup means no write.
    const backup = mode === undefined ? null : saveBackup(target);
    if (mode !== undefined && !backup) {
      throw Object.assign(
        new Error(
          `settings.json: ${target} was not changed because neither an atomic replace (${err.code}) nor a backup of the current file was possible`,
        ),
        { code: err.code, cause: err },
      );
    }
    atomic = false;
    // Printed before the write so a kill mid-write still leaves the backup path on screen.
    process.stderr.write(
      `settings.json: ${dirname(target)} is not writable for an atomic replace, wrote in place` +
        (backup ? ` (previous bytes saved at ${backup} until the write is verified)` : '') +
        '\n',
    );
    try {
      writeFileSync(target, text); // opens the file as is, so its mode stays
    } catch (werr) {
      if (!backup) throw werr;
      throw Object.assign(
        new Error(
          `settings.json: the in-place write to ${target} failed (${werr.code ?? werr.message}); the previous bytes are kept at ${backup}`,
        ),
        { code: werr.code, cause: werr },
      );
    }
    if (backup) {
      let intact = false;
      try {
        intact = Buffer.from(text).equals(readFileSync(target));
      } catch {
        // unreadable counts as not intact
      }
      if (!intact) {
        throw new Error(
          `settings.json: ${target} does not read back as what was written; the previous bytes are kept at ${backup}`,
        );
      }
      removeBackup(backup);
    }
  }
  if (atomic && mode === undefined) {
    try {
      chmodSync(target, 0o666 & ~oldMask); // a new file keeps the default mode
    } catch (err) {
      const now = (statSync(target).mode & 0o7777).toString(8);
      process.stderr.write(
        `settings.json: written, ${target} stays at mode ${now} (chmod failed: ${err.code ?? err.message})\n`,
      );
    }
  }
  let modeRestored = false;
  let modeWidened = false;
  if (atomic && mode !== undefined) {
    const newMode = statSync(target).mode & 0o7777;
    const restoreMode = newMode !== mode;
    if (restoreMode) {
      try {
        chmodSync(target, mode);
        modeRestored = true;
      } catch (err) {
        modeWidened = (newMode & ~mode) !== 0;
        process.stderr.write(
          `settings.json: written, mode not restored: ${target} is ${newMode.toString(8)}, was ${mode.toString(8)} (${err.code ?? err.message})\n`,
        );
      }
    }
  }
  return { atomic, target, viaLink, modeRestored, modeWidened };
}
