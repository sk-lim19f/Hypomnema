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

/**
 * Pick the plugin's published version out of a marketplace.json `plugins` array.
 * Select by name rather than plugins[0]: the file could list more than one
 * plugin or reorder entries. Accept the current name (`hypo`) and the legacy one
 * (`hypomnema`) so a stale-cached or transitional marketplace.json still
 * resolves. Returns the version string or null.
 */
export function selectPluginVersion(plugins) {
  if (!Array.isArray(plugins)) return null;
  // Prefer the current name over the legacy one so that a transitional
  // marketplace.json listing BOTH aliases resolves to `hypo` regardless of the
  // entries' order (a legacy-first list must not shadow a newer `hypo` entry).
  const entry =
    plugins.find((p) => p && p.name === 'hypo') || plugins.find((p) => p && p.name === 'hypomnema');
  const v = entry && entry.version;
  return typeof v === 'string' ? v : null;
}

/** The command that runs an upgrade apply, in the form the caller's channel can
 *  actually run. A plugin-only install has no `hypomnema` on PATH: that binary is
 *  the npm package's bin, while the plugin manifest ships commands only. And the
 *  slash command takes no `--apply` argument, so naming the flag there describes
 *  a call it does not make: it runs the check and appends --apply only after the
 *  operator confirms.
 *
 *  Lives here because both hooks and scripts need it and the dependency only
 *  runs one way (scripts import hooks, never the reverse). This file is already
 *  in hooks.json's `shared` list, so it reaches every standalone install.
 *
 *  Use UPGRADE_APPLY_EITHER when the target channel is genuinely unknown, e.g.
 *  an instruction about a DIFFERENT machine. */
export function upgradeApplyHint(isPluginChannel) {
  return isPluginChannel
    ? '`/hypo:upgrade` (confirm the apply step)'
    : '`hypomnema upgrade --apply`';
}

export const UPGRADE_APPLY_EITHER =
  '`hypomnema upgrade --apply` (or `/hypo:upgrade` on a plugin install)';

/** Channel-specific one-line update instruction.
 *
 *  Every channel ends with the same second step. Installing a release does NOT
 *  repoint the vault's git pre-commit hook: that hook holds an absolute path
 *  baked in at init time, and only `upgrade --apply` rewrites it. No hook can
 *  do it either (a hook must never invoke an apply path). Without this line the
 *  user updates, sees the new version string, and keeps committing through the
 *  install they had when they first ran init. */
export function buildUpdateLine(channel, current, latest) {
  const head = `[Hypomnema] Update available! ${current} → ${latest}`;
  // The repoint step has to be RUNNABLE on the channel it is printed for. A
  // plugin-only install has no `hypomnema` on PATH (that binary is the npm
  // package's bin; the plugin manifest ships commands only), so its form is the
  // slash command. And the slash command takes no --apply argument: that
  // command runs the check first and only appends --apply after the operator
  // confirms, so naming the flag there would describe a call the command does
  // not make. Both mistakes are the same class as naming a flag no script parses.
  const repoint = (cmd) => `\n  → then: ${cmd}  (repoints the vault's git hook at the new install)`;
  if (channel === 'plugin') {
    return `${head}\n  → run: /plugin marketplace update hypomnema  then  /reload-plugins${repoint(upgradeApplyHint(true))}`;
  }
  // The only remaining displayed channel is npm: computeNotice drops 'unknown'
  // before anything renders, and a dual install reports the channel of the hook
  // root actually running, never a third "mixed" value. A branch for one would
  // be code no user reaches.
  return `${head}\n  → run: npm install -g hypomnema${repoint(upgradeApplyHint(false))}`;
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

// ── stale-sibling detection ───────────────────────────────────────────────────
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

// ── pkgRoot drift notice ────────────────────────────────────────────────────
// Same notify-once shape as the sibling banner above, in a field of its own
// (`pkgRootDriftNotifiedFor`) so the two never suppress each other — they are
// unrelated tuples that happen to share this cache file.

/** Has this exact (cached → self-location) pkgRoot-drift pair already been surfaced? */
export function pkgRootDriftAlreadyNotified(cache, key) {
  return Boolean(cache && cache.pkgRootDriftNotifiedFor === key);
}

/** Record that the pkgRoot-drift banner for `key` was shown (read-merge-write). */
export function markPkgRootDriftNotified(path, key) {
  try {
    const cache = readCache(path) || {};
    cache.pkgRootDriftNotifiedFor = key;
    writeCacheAtomic(path, cache);
  } catch {
    /* best-effort */
  }
}

/**
 * Clear a previously-recorded pkgRoot-drift mark once the drift is observed
 * to be resolved (cache catches up with self-location again — status
 * 'match'). Without this the mark is permanent: the SAME (cached →
 * self-location) pair recurring later — e.g. hypo-pkg.json catches up, then a
 * later plugin update or a manual edit drifts it right back to the identical
 * pair — would stay silently suppressed forever, because only a DIFFERENT
 * pair would ever produce a new key. Callers must NOT call this on status
 * 'unknown' (self-location could not be resolved) — that would wrongly wipe a
 * mark this session had no grounds to judge one way or the other. Read-merge-
 * write, best-effort (a failure here just means the notice stays suppressed
 * one extra cycle, never a crash).
 */
export function clearPkgRootDriftNotified(path) {
  try {
    const cache = readCache(path);
    if (!cache || !('pkgRootDriftNotifiedFor' in cache)) return;
    delete cache.pkgRootDriftNotifiedFor;
    writeCacheAtomic(path, cache);
  } catch {
    /* best-effort */
  }
}

// ── pkgRoot-null notice ─────────────────────────────────────────────────────
// A DIFFERENT failure than drift above: drift only ever fires when
// self-location resolved (PKG_ROOT is non-null, just disagreeing with the
// cache). This one fires when PKG_ROOT itself resolved to null — self-location
// failed AND no verified provenance sidecar covered it — the case where
// PreCompact's lint/feedback calls silently no-op because they have no root to
// shell scripts through. The two conditions can never both hold in the same
// session (drift requires a non-null self-location), so there is no "which
// wins" question in practice, but the two use separate cache fields regardless
// so neither implementation depends on that being true forever.
// Boolean (not a pair-key like drift) — the notified state is just "already
// told them this session's install has no resolvable pkgRoot".

/** Has the PKG_ROOT-null state already been surfaced since it last cleared? */
export function pkgRootNullAlreadyNotified(cache) {
  return Boolean(cache && cache.pkgRootNullNotified === true);
}

/** Record that the PKG_ROOT-null banner was shown (read-merge-write). */
export function markPkgRootNullNotified(path) {
  try {
    const cache = readCache(path) || {};
    cache.pkgRootNullNotified = true;
    writeCacheAtomic(path, cache);
  } catch {
    /* best-effort */
  }
}

/**
 * Clear a previously-recorded PKG_ROOT-null mark once PKG_ROOT resolves again
 * (self-location or a verified provenance sidecar). Without this, a null state
 * that resolves and then recurs later (e.g. the provenance sidecar's hash
 * binding breaks again after a partial re-install) would stay silently
 * suppressed forever. Read-merge-write, best-effort.
 */
export function clearPkgRootNullNotified(path) {
  try {
    const cache = readCache(path);
    if (!cache || !('pkgRootNullNotified' in cache)) return;
    delete cache.pkgRootNullNotified;
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
