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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
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
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/**
 * Compare two semver strings. Returns -1 / 0 / 1, or null if either is invalid.
 * A release outranks a prerelease of the same x.y.z (1.2.3 > 1.2.3-rc.1).
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1; // lexicographic fallback (good enough)
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
