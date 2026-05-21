#!/usr/bin/env node
/**
 * version-check-fetch.mjs — detached update-check worker
 *
 * Spawned (detached, unref'd, stdio ignored) by the SessionStart hook ONLY when
 * the cache is stale. It fetches the latest published versions for both
 * channels and merges them into the cache, then exits. The hook never waits on
 * it, so session start stays at 0ms added latency; the refreshed version is
 * shown from the NEXT session.
 *
 * Best-effort throughout: any failure (offline, 404, timeout) leaves the cache
 * untouched for that channel and exits 0 — never throws back at a hook.
 *
 * Usage: node version-check-fetch.mjs [cachePath]
 */

import { defaultCachePath, mergeLatest } from './version-check.mjs';

const NPM_URL = 'https://registry.npmjs.org/hypomnema/latest';
const PLUGIN_URL =
  'https://raw.githubusercontent.com/sk-lim19f/Hypomnema/main/.claude-plugin/marketplace.json';
const TIMEOUT_MS = 2000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNpmLatest() {
  const data = await fetchJson(NPM_URL);
  return data && typeof data.version === 'string' ? data.version : null;
}

async function fetchPluginLatest() {
  const data = await fetchJson(PLUGIN_URL);
  if (!data || !Array.isArray(data.plugins)) return null;
  // Select by name rather than plugins[0]: a future marketplace.json could list
  // more than one plugin or reorder entries, which would otherwise read the
  // wrong version.
  const entry = data.plugins.find((p) => p && p.name === 'hypomnema');
  const v = entry && entry.version;
  return typeof v === 'string' ? v : null;
}

async function main() {
  const cachePath = process.argv[2] || defaultCachePath();
  const [npmLatest, pluginLatest] = await Promise.all([fetchNpmLatest(), fetchPluginLatest()]);

  const latest = {};
  if (npmLatest) latest.npm = npmLatest;
  if (pluginLatest) latest.plugin = pluginLatest;

  // Even if both fetches fail we still stamp checkedAt so we don't hammer the
  // network every single session while offline — the TTL backs off naturally.
  try {
    mergeLatest(cachePath, latest);
  } catch {
    /* best-effort */
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
