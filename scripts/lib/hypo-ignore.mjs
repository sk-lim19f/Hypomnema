import { existsSync, readFileSync } from 'fs';
import { join, relative, basename } from 'path';

export function loadHypoIgnore(hypoDir) {
  const ignorePath = join(hypoDir, '.hypoignore');
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
}

function globToRegex(glob) {
  return new RegExp('^' +
    glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00')   // placeholder before single-* replacement
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\x00/g, '.*')     // restore ** → .*
  + '$');
}

export function isIgnored(filePath, hypoDir, patterns) {
  const rel = relative(hypoDir, filePath).replace(/\\/g, '/');
  const base = basename(filePath);

  for (const pattern of patterns) {
    const isDir = pattern.endsWith('/');
    if (isDir) {
      const dir = pattern.slice(0, -1);
      const isAnchored = dir.includes('/');
      if (isAnchored) {
        // e.g. pages/journal/ — anchored to wiki root, match prefix
        const re = globToRegex(dir);
        const parts = rel.split('/');
        for (let i = dir.split('/').length; i <= parts.length; i++) {
          if (re.test(parts.slice(0, i).join('/'))) return true;
        }
      } else {
        // e.g. node_modules/ — unanchored, match any single component
        const re = globToRegex(dir);
        for (const part of rel.split('/')) {
          if (re.test(part)) return true;
        }
      }
      continue;
    }
    const hasSlash = pattern.includes('/');
    const target = hasSlash ? rel : base;
    if (globToRegex(pattern).test(target)) return true;
  }
  return false;
}
