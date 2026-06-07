/**
 * version-check.mjs — update-notifier core (pure logic + cache I/O)
 *
 * Hypomnema ships through TWO channels — the `hypomnema` npm package and a
 * Claude Code plugin (marketplace `sk-lim19f/Hypomnema`). This module decides,
 * given the cached "latest" versions and the installed version, whether to show
 * an "update available" banner at session start.
 *
 * Design constraints (see ADR / teams review 2026-05-21):
 *   - The SessionStart hook must never make a synchronous network call. It reads
 *     ONLY the cache here; a detached worker (version-check-fetch.mjs) refreshes
 *     the cache out-of-band. So everything in this file is offline + cheap.
 *   - Per-channel state: npm and plugin `latest` can diverge (npm publish vs
 *     marketplace commit happen at different times), so `latest` and
 *     `notifiedFor` are keyed by channel — a single scalar would suppress or
 *     repeat banners when the user switches channels.
 *   - Cache writes are atomic (tmp + rename); the fetch worker MERGES rather
 *     than overwrites so it never erases the hook's `notifiedFor` marks.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync, existsSync } from 'fs';
import { dirname, join, delimiter } from 'path';
import { homedir } from 'os';

export const TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const CHANNELS = ['npm', 'plugin'];

/**
 * Cache lives under ~/.claude (Claude-hook-specific state), NOT inside the
 * Obsidian vault ~/hypomnema — that directory is git-tracked, so a cache file
 * there would create dirty status, sync noise, and accidental-commit / privacy
 * risk (teams review (e), 2026-05-21).
 */
export function defaultCachePath(home = homedir()) {
  return join(home, '.claude', 'hypomnema', 'cache', 'version-check.json');
}

// ── semver ───────────────────────────────────────────────────────────────────

/**
 * Parse a semver string. Tolerates a leading `v` and ignores build metadata.
 * Returns null for anything that isn't `MAJOR.MINOR.PATCH[-prerelease][+build]`.
 */
export function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  // Keep core identifiers as RAW DIGIT STRINGS (not +Number) so compareSemver can
  // order them precisely — SemVer caps neither core nor prerelease numeric length,
  // and Number() silently loses precision past 2^53.
  return { major: m[1], minor: m[2], patch: m[3], pre: m[4] || '' };
}

/**
 * Compare two SemVer numeric identifier strings (digits only, no leading zeros).
 * Done WITHOUT Number() so arbitrary-length identifiers order exactly: fewer
 * digits ⇒ smaller value; equal length ⇒ ASCII order is numeric order.
 */
function compareNumericId(x, y) {
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  if (x !== y) return x < y ? -1 : 1;
  return 0;
}

/**
 * Compare two prerelease strings per the SemVer §11 precedence rules. Identifiers
 * are dot-separated; numeric ones compare numerically and always rank LOWER than
 * alphanumeric ones; a larger set of identifiers outranks a smaller one when all
 * preceding identifiers are equal. Both inputs are non-empty prereleases here.
 */
function comparePrerelease(a, b) {
  const ai = a.split('.');
  const bi = b.split('.');
  const len = Math.max(ai.length, bi.length);
  for (let i = 0; i < len; i++) {
    // "a larger set of pre-release fields has higher precedence" → the one that
    // still has identifiers wins once the shorter one runs out.
    if (i >= ai.length) return -1;
    if (i >= bi.length) return 1;
    const x = ai[i];
    const y = bi[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const c = compareNumericId(x, y);
      if (c !== 0) return c;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers have lower precedence
    } else if (x !== y) {
      return x < y ? -1 : 1; // ASCII lexical for alphanumeric
    }
  }
  return 0;
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1, or null if either is invalid.
 * A release outranks a prerelease of the same x.y.z (1.2.3 > 1.2.3-rc.1), and
 * prereleases follow full SemVer §11 precedence (1.2.3-rc.2 < 1.2.3-rc.10) — this
 * matters because compareSemver now gates the init/upgrade downgrade guard.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    const c = compareNumericId(pa[k], pb[k]);
    if (c !== 0) return c;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  return comparePrerelease(pa.pre, pb.pre);
}

// ── channel detection ──────────────────────────────────────────────────────

/**
 * Decide the active install channel from the package root path.
 *
 * The caller should pass the root derived from the RUNNING hook path
 * (import.meta.url → ../..), with ~/.claude/hypo-pkg.json's pkgRoot only as a
 * fallback: that metadata file has drifted before, and in a dual install
 * (npm global + plugin) it names just one path. Reporting the inactive channel
 * would hand the user the wrong update command (teams review (b), 2026-05-21).
 *
 * Plugin is checked before npm because a plugin install can itself live under a
 * node_modules path, but never vice-versa.
 */
export function detectChannel(pkgRoot) {
  if (typeof pkgRoot !== 'string' || !pkgRoot) return 'unknown';
  const p = pkgRoot.replace(/\\/g, '/');
  if (p.includes('/plugins/') || p.includes('/.claude/plugins/')) return 'plugin';
  if (p.includes('/node_modules/')) return 'npm';
  return 'unknown';
}

/** Channel-specific one-line update instruction. */
export function buildUpdateLine(channel, current, latest) {
  const head = `[Hypomnema] Update available! ${current} → ${latest}`;
  if (channel === 'plugin') {
    return `${head}\n  → run: /plugin marketplace update hypomnema  then  /reload-plugins`;
  }
  if (channel === 'npm') {
    return `${head}\n  → run: npm install -g hypomnema`;
  }
  return `${head}\n  → npm i -g hypomnema  (or  /plugin marketplace update hypomnema && /reload-plugins)`;
}

// ── cache freshness + notice decision (pure) ─────────────────────────────────

/**
 * Is the cache fresh enough to skip a refresh? A `checkedAt` in the future
 * (clock skew / corrupt cache) is treated as stale so the worker re-fetches.
 */
export function cacheIsFresh(cache, now = Date.now(), ttl = TTL_MS) {
  if (!cache || typeof cache.checkedAt !== 'number') return false;
  if (cache.checkedAt > now + 60_000) return false;
  return now - cache.checkedAt < ttl;
}

/**
 * Decide whether to show a banner. Returns { latest, line } or null.
 * Skips when: unknown channel, no cached latest for the channel, invalid
 * semver, current >= latest (incl. local dev where current > latest), or the
 * channel was already notified for this exact latest version.
 */
export function computeNotice(cache, channel, current) {
  if (!cache || channel === 'unknown' || !CHANNELS.includes(channel)) return null;
  const latest = cache.latest && cache.latest[channel];
  if (!latest) return null;
  const cmp = compareSemver(current, latest);
  if (cmp === null || cmp >= 0) return null;
  const already = cache.notifiedFor && cache.notifiedFor[channel];
  if (already === latest) return null;
  return { latest, line: buildUpdateLine(channel, current, latest) };
}

// ── cache I/O (atomic) ───────────────────────────────────────────────────────

/** Read + parse the cache; returns null on missing/corrupt file. */
export function readCache(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Atomic write: tmp file in the same dir, then rename (last-writer-wins). */
export function writeCacheAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

/**
 * Record that the banner for {channel: latest} has been shown, preserving the
 * rest of the cache. Read-merge-write so concurrent worker refreshes and hook
 * marks don't clobber each other's fields. Best-effort: swallows errors.
 */
export function markNotified(path, channel, latest) {
  try {
    const cache = readCache(path) || {};
    cache.notifiedFor = { ...(cache.notifiedFor || {}), [channel]: latest };
    writeCacheAtomic(path, cache);
  } catch {
    /* best-effort */
  }
}

/**
 * Merge freshly-fetched latest versions into the cache without erasing
 * `notifiedFor`. Used by the detached fetch worker.
 */
export function mergeLatest(path, latest, now = Date.now()) {
  const cache = readCache(path) || {};
  cache.checkedAt = now;
  cache.latest = { ...(cache.latest || {}), ...latest };
  cache.notifiedFor = cache.notifiedFor || {};
  writeCacheAtomic(path, cache);
  return cache;
}

/** True if any opt-out env var is set. */
export function isOptedOut(env = process.env) {
  return Boolean(env.HYPO_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);
}

// ── stale-sibling detection (ADR 0038) ───────────────────────────────────────
//
// A second, OLDER Hypomnema can sit on $PATH (e.g. a stale `npm i -g hypomnema`)
// while a newer copy owns the active hooks. The CLI bin (`hypomnema`) then routes
// `hypomnema init` / `upgrade --apply` through the OLD package, which silently
// downgrades the newer registered hooks (dropping features like this notifier).
//
// The update-notifier above only asks "is MY install behind latest?" — it is
// blind to a stale SIBLING. These helpers add that axis. They are fs-only and
// offline (no `npm`, no `which` spawn) so they are safe inside the SessionStart
// hook and `doctor`.

/** realpathSync that returns null instead of throwing on a missing/broken path. */
export function realpathSafe(p) {
  if (typeof p !== 'string' || !p) return null;
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Read the nearest ancestor `package.json` named `hypomnema`, starting at `start`
 * and walking up. Returns { pkgRoot, version } or null. Used to map a resolved
 * bin path back to the package that owns it.
 */
function readOwningPkg(start) {
  let dir = start;
  // Bounded ascent (filesystem depth is finite; cap defensively).
  for (let i = 0; i < 64; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg && pkg.name === 'hypomnema' && typeof pkg.version === 'string') {
          return { pkgRoot: dir, version: pkg.version };
        }
      } catch {
        /* keep ascending — a non-hypomnema package.json is not our target */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate the `hypomnema` CLI on $PATH WITHOUT spawning `which`/`npm`.
 *
 * Splits $PATH, probes each dir for the bin (plus PATHEXT variants on Windows),
 * resolves symlinks (npm global bins are symlinks into node_modules), then walks
 * up to the owning package.json. Returns { binPath, pkgRoot, version } for the
 * FIRST hit — that is the one the shell would actually run — or null.
 *
 * Windows note: npm installs `.cmd`/`.ps1` launcher shims (not symlinks), so the
 * realpath→package.json walk usually fails there and we return null rather than
 * guess. POSIX (the reported footgun) resolves cleanly.
 */
export function resolveCliOnPath(binName = 'hypomnema', env = process.env) {
  const pathVar = env.PATH || env.Path || '';
  if (!pathVar) return null;
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, binName + ext.toLowerCase());
      const real = realpathSafe(candidate);
      if (!real) continue;
      const owner = readOwningPkg(dirname(real));
      if (owner) return { binPath: candidate, ...owner };
    }
  }
  return null;
}

/**
 * Classify two installs by version and identity. Returns:
 *   'same'      — same package root (dev re-run / npm-link) → never a downgrade
 *   'downgrade' — `incoming` is strictly OLDER than `active`
 *   'ok'        — `incoming` >= `active`
 *   'unknown'   — either version unparseable; cannot prove a downgrade
 *
 * realpath-compares the roots first so a dev workspace re-running its own
 * init/upgrade is never mis-flagged.
 */
export function classifyInstall(incoming, active) {
  const ri = realpathSafe(incoming && incoming.pkgRoot);
  const ra = realpathSafe(active && active.pkgRoot);
  if (ri && ra && ri === ra) return 'same';
  const cmp = compareSemver(incoming && incoming.version, active && active.version);
  if (cmp === null) return 'unknown';
  return cmp < 0 ? 'downgrade' : 'ok';
}

/**
 * Decide whether to warn about a stale sibling owning the CLI. Returns
 * { cliVersion, line, key } or null. Warns only when the PATH CLI is a DIFFERENT,
 * strictly OLDER package than the active install.
 *
 * `key` is a throttle token (cli path+version → active version) so the
 * SessionStart hook can suppress repeats via `siblingNotifiedFor`.
 */
export function computeSiblingNotice(cli, active) {
  if (!cli || !active || !active.version) return null;
  if (classifyInstall(cli, active) !== 'downgrade') return null;
  const key = `${cli.binPath || cli.pkgRoot}@${cli.version}->${active.version}`;
  const line =
    `[Hypomnema] Stale install on PATH: \`${cli.binPath || cli.pkgRoot}\` is v${cli.version}, ` +
    `but your active install is v${active.version}.\n` +
    `  Running \`hypomnema init\`/\`upgrade\` from PATH would DOWNGRADE your hooks.\n` +
    `  → remove the old one:  npm uninstall -g hypomnema   (then re-check with \`hypomnema doctor\`)`;
  return { cliVersion: cli.version, line, key };
}

/** Has this exact sibling tuple already been surfaced? */
export function siblingAlreadyNotified(cache, key) {
  return Boolean(cache && cache.siblingNotifiedFor === key);
}

/** Record that the sibling banner for `key` was shown (read-merge-write). */
export function markSiblingNotified(path, key) {
  try {
    const cache = readCache(path) || {};
    cache.siblingNotifiedFor = key;
    writeCacheAtomic(path, cache);
  } catch {
    /* best-effort */
  }
}

/**
 * Shared one-line message for the init/upgrade downgrade guard (P). `op` is
 * 'init' or 'upgrade'. Kept here so guard text stays identical across both CLIs.
 */
export function downgradeGuardMessage(incomingVersion, activeVersion, op) {
  return (
    `[Hypomnema] Refusing to ${op}: this package is v${incomingVersion}, but your ` +
    `active install is NEWER (v${activeVersion}).\n` +
    `  This is usually a stale global CLI on PATH — proceeding would DOWNGRADE your hooks.\n` +
    `  → upgrade the stale copy:  npm install -g hypomnema\n` +
    `  → or, if you really mean to downgrade:  re-run with --allow-downgrade`
  );
}
