// settings.json only. The write itself is hooks/atomic-write.mjs (`atomicWrite`);
// this file decides where to write and cleans up around it, and never grows a
// second temp+rename of its own.
//
// What the rename costs (the helper accepts these rather than fork the writer):
//   - mode window: between the rename and the chmod back, the new file shows the
//     default mode (0o666 & ~umask). An original 0o600 is readable for that moment.
//   - chmod failure: the file keeps the default mode. If that is wider than the
//     original the call throws SETTINGS_MODE_NOT_RESTORED (written: true); if not,
//     it only prints one line to stderr.
//   - read-only file: a 0o444 settings.json in a writable directory is now replaced
//     (the old direct write refused with EACCES) and put back to 0o444.
//   - hard links, owner, ACL and xattr: rename breaks a hard link (the other name
//     keeps the old inode) and does not carry owner, ACL or xattr to the new file.
//     Only the mode is restored.
import { chmodSync, lstatSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
 * Write `text` to settings.json at `path`. A symlink stays a link and its last
 * target gets the bytes. A dangling link into an existing directory is created
 * through the link; into a missing directory it is refused (ENOENT) and no
 * directory is made. A path that is not a link and does not exist is created.
 *
 * `atomic` is false when the directory refused the temp file (EACCES, EPERM) and
 * the bytes went in place instead. `modeRestored` is true only when the rename
 * changed the mode and the chmod back succeeded.
 *
 * @returns {{atomic: boolean, target: string, viaLink: boolean, modeRestored: boolean}}
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
  try {
    atomicWrite(target, text);
  } catch (err) {
    const fallback = err.code === 'EACCES' || err.code === 'EPERM';
    if (!fallback) throw err;
    writeFileSync(target, text); // opens the file as is, so its mode stays
    atomic = false;
    process.stderr.write(
      `settings.json: ${dirname(target)} is not writable for an atomic replace, wrote in place\n`,
    );
  }
  let modeRestored = false;
  if (atomic && mode !== undefined) {
    const newMode = statSync(target).mode & 0o7777;
    const restoreMode = newMode !== mode;
    if (restoreMode) {
      try {
        chmodSync(target, mode);
        modeRestored = true;
      } catch (err) {
        const wider = (newMode & ~mode) !== 0;
        const detail = `${target} is ${newMode.toString(8)}, was ${mode.toString(8)} (${err.code ?? err.message})`;
        if (wider) {
          throw Object.assign(
            new Error(`settings.json was written, but its mode was not restored: ${detail}`),
            {
              code: 'SETTINGS_MODE_NOT_RESTORED',
              written: true,
            },
          );
        }
        process.stderr.write(`settings.json: written, mode not restored: ${detail}\n`);
      }
    }
  }
  return { atomic, target, viaLink, modeRestored };
}
