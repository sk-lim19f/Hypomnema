// proposal-store.mjs: parked overwrite-conflict artifacts (the write=proposal gate)
//
// Lives in hooks/ rather than scripts/lib/ for the same reason base-store does: a
// SessionStart-chain hook (T8's session-start surface) counts pending proposals,
// so the store must sit where a hook can import it without reaching up into
// scripts/. scripts/ (crystallize, the T7 CLI) already imports from hooks/, never
// the reverse. Registered in hooks.json `shared` alongside base-store.
//
// When crystallize's close path finds that an OVERWRITE target drifted away from
// the base this session observed at start, it withholds the bytes rather than
// clobber the other writer's edits (base-store's guard). Those withheld bytes have
// to go somewhere a human can review and re-apply them later, out of band from the
// session that produced them — that is this artifact:
// `<hypoDir>/.cache/proposals/<id>.json` (gitignored, never synced, same .cache/
// neighborhood as base-store's per-session snapshots).
//
// Two invariants shape the store:
//
//   1. Overwrite only. APPEND conflicts (session-log / log.md lock-timeouts) do
//      NOT become artifacts. A lock-timeout is transient, so the next close
//      self-heals by re-appending; and T7 applies a proposal by REPLACING the
//      whole target, which for an append-only history file would drop every other
//      entry. crystallize filters `kind: 'append'` out before it ever calls here.
//
//   2. One artifact per (target, SESSION). Each close re-derives the same drifted
//      target, so without supersede a fresh random id would accumulate a stale
//      artifact on every close and inflate the pending count. But supersede is
//      scoped to the writing session: a LATER close only replaces that same
//      session's own earlier attempt at the target. Two concurrent sessions that
//      both withhold bytes for one target keep BOTH artifacts, because each holds
//      a distinct payload and this artifact is its only durable copy (crystallize
//      never puts withheld bytes on disk and drops them from its reported shape).
//      Deleting across sessions would silently destroy the first session's work,
//      which is exactly the clobber this gate exists to prevent. A session id we
//      cannot match (null on either side) supersedes nothing: never delete a
//      payload we cannot prove is our own earlier attempt.
//      writeProposal writes the new artifact durably FIRST, then deletes the older
//      same-session sibling — so a crash between the two leaves an extra artifact
//      (harmless, superseded next time), never zero. A same-target close that is
//      byte-identical reuses the existing id instead of writing at all (idempotent,
//      and session-agnostic: identical bytes are one payload, so reusing another
//      session's artifact drops nothing).
//
// Everything is best-effort on the read side (a malformed artifact is skipped, not
// fatal) and atomic on the write side (tmp+rename), mirroring base-store.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';

/** `<hypoDir>/.cache/proposals/`. */
export function proposalsDir(hypoDir) {
  return join(hypoDir, '.cache', 'proposals');
}

/** `<hypoDir>/.cache/proposals/<id>.json`. */
export function proposalPath(hypoDir, id) {
  return join(proposalsDir(hypoDir), `${id}.json`);
}

// A generated id is `<digits>-<slug>-<rand>`: filename-safe tokens joined by
// hyphens, never a path separator, `.`, or `..`. The T7 CLI takes an id straight
// off the command line, so an unvalidated id would let `../../hot` resolve to
// `<hypoDir>/hot.json` and drive readProposal/deleteProposal against a file
// outside the store. Reject anything that is not the generated shape.
const PROPOSAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** True only for the filename-safe id shape makeProposalId emits. */
export function isValidProposalId(id) {
  return typeof id === 'string' && PROPOSAL_ID_RE.test(id);
}

/**
 * Resolve `<id>.json` and confirm it sits DIRECTLY inside the proposals dir.
 * Returns the absolute path, or null when the id is malformed or the resolved
 * path escapes the store — defense in depth behind isValidProposalId, so even a
 * validator gap cannot read or unlink a file elsewhere in the vault.
 */
function resolvedProposalPath(hypoDir, id) {
  if (!isValidProposalId(id)) return null;
  const p = resolve(proposalPath(hypoDir, id));
  if (dirname(p) !== resolve(proposalsDir(hypoDir))) return null;
  // A lexical resolve+dirname check cannot see a SYMLINKED store: if
  // `.cache/proposals` (or a parent) is a symlink to outside the vault, the id is
  // valid but the path still escapes. When the store exists, require its real
  // (symlink-resolved) path to be the vault's own `.cache/proposals`. When it does
  // not exist yet there is nothing to read or unlink, so the lexical guard stands.
  try {
    if (
      realpathSync(proposalsDir(hypoDir)) !== join(realpathSync(hypoDir), '.cache', 'proposals')
    ) {
      return null;
    }
  } catch {
    /* store or vault not present yet — nothing to escape to */
  }
  return p;
}

/** Slug a vault-relative path into a filename-safe token (no separators). */
function slugTarget(target) {
  return (
    String(target)
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'target'
  );
}

/**
 * Build an artifact id: `<compressed-createdAt>-<targetSlug>-<rand>`.
 *
 * createdAt is an ISO string stripped of the characters a filename cannot carry
 * (`-`, `:`, `.`), so it stays human-sortable; targetSlug keeps the id legible in
 * `ls`; rand disambiguates two closes that land in the same millisecond. The id is
 * only an on-disk key — the artifact body carries the authoritative fields.
 */
export function makeProposalId(createdAt, target) {
  const ts = String(createdAt)
    .replace(/[-:.]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${slugTarget(target)}-${rand}`;
}

/** Atomic overwrite via tmp+rename, mirroring base-store's atomicWrite. */
function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Read+parse one artifact file by absolute path. Returns null when absent,
 * unreadable, or malformed (best-effort: a corrupt artifact must never crash a
 * listing or a supersede scan).
 */
function readArtifactFile(path) {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.id !== 'string' || typeof parsed.target !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * List parked proposals, newest artifacts included, malformed ones skipped.
 * Each entry is the parsed body plus `_path` (absolute) so callers (the T7 CLI)
 * can act on the exact file without re-deriving the path.
 *
 * @returns {Array<object>} parsed artifacts; empty when the dir is absent/empty
 */
export function listProposals(hypoDir) {
  const dir = proposalsDir(hypoDir);
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const parsed = readArtifactFile(path);
    // A well-formed artifact's `id` field equals its filename stem and is itself
    // id-safe. A mismatch means the body was hand-edited or corrupt; trusting its
    // `id` would let a spoofed value drive supersede or T7 apply against the wrong
    // file, so skip it (it stays on disk but is never acted on).
    if (parsed && isValidProposalId(parsed.id) && parsed.id === name.slice(0, -'.json'.length)) {
      out.push({ ...parsed, _path: path });
    }
  }
  return out;
}

/**
 * Read one proposal by id. Returns null when the id is unsafe, or the file is
 * absent, unreadable, or malformed.
 */
export function readProposal(hypoDir, id) {
  const path = resolvedProposalPath(hypoDir, id);
  if (!path) return null; // reject unsafe id — never read outside the store
  return readArtifactFile(path);
}

/**
 * Delete one proposal by id. Returns true when the file is gone afterwards
 * (whether this call removed it or it was already absent), false when the id is
 * unsafe or the unlink itself failed for another reason.
 */
export function deleteProposal(hypoDir, id) {
  const path = resolvedProposalPath(hypoDir, id);
  if (!path) return false; // reject unsafe id — never unlink outside the store
  try {
    unlinkSync(path);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return true; // already gone — the desired end state
    return false;
  }
}

/**
 * Park a drifted overwrite target as a proposal artifact.
 *
 * @param {string} hypoDir
 * @param {object} fields
 * @param {string} fields.target vault-relative path the payload wanted to write
 * @param {string|null} fields.baseHash hash this session observed at start (may be null)
 * @param {string|null} fields.currentAtProposalHash disk hash at withhold time
 * @param {string} fields.proposedContent the full page bytes this close withheld
 * @param {string} fields.sessionId owning session
 * @param {string} fields.device machine identifier (crystallize passes currentDevice())
 * @param {string} [fields.createdAt] ISO timestamp; defaults to now
 * @returns {{id: string, target: string, path: string, supersedeWarnings: string[]}}
 *   `supersedeWarnings` is non-empty only when the new artifact WAS written but an
 *   older same-target sibling could not be removed — a non-fatal condition (the
 *   payload is parked), reported separately from a write failure (which throws).
 */
export function writeProposal(hypoDir, fields) {
  const { target, baseHash, currentAtProposalHash, proposedContent, sessionId, device } = fields;
  const createdAt = fields.createdAt || new Date().toISOString();

  // Match on the parsed `target` field, never on the filename slug: two distinct
  // rel paths can slug-collide, and a slug-prefix scan could delete an unrelated
  // target's artifact. Reading the body is the only safe discriminator.
  const sameTarget = listProposals(hypoDir).filter((p) => p.target === target);

  // Idempotent reuse: a re-close that withholds the SAME bytes against the SAME
  // base and disk state reuses the existing id rather than minting a new artifact,
  // so an unchanged close does not churn the store or move the id T7 apply keys on.
  const identical = sameTarget.find(
    (p) =>
      p.baseHash === (baseHash ?? null) &&
      p.currentAtProposalHash === (currentAtProposalHash ?? null) &&
      p.proposedContent === proposedContent,
  );
  if (identical) {
    return { id: identical.id, target, path: identical._path, supersedeWarnings: [] };
  }

  const id = makeProposalId(createdAt, target);
  const path = proposalPath(hypoDir, id);
  const body = {
    id,
    target,
    baseHash: baseHash ?? null,
    currentAtProposalHash: currentAtProposalHash ?? null,
    proposedContent,
    sessionId: sessionId != null ? String(sessionId) : null,
    device: device != null ? String(device) : null,
    createdAt,
  };
  // Write the new artifact DURABLY before removing the old one: a crash in the
  // gap leaves a stale sibling (superseded next close), never a lost payload.
  atomicWrite(path, JSON.stringify(body, null, 2));

  const supersedeWarnings = [];
  const mine = body.sessionId;
  for (const p of sameTarget) {
    if (p.id === id) continue; // never delete what we just wrote
    // Same target is NOT enough: a sibling written by a DIFFERENT session holds
    // that session's only copy of its withheld bytes (invariant 2). Supersede
    // only our own earlier attempt, and only when both ids are known.
    //
    // `typeof === 'string'` before comparing, never String(p.sessionId): the body
    // is hand-editable and listProposals validates only `id`, so a field like
    // `["s-A"]` would coerce to a matching primitive. writeProposal always stores
    // a string, so a non-string id belongs to no session we can identify — and an
    // unidentifiable owner is exactly the case that must not be deleted.
    if (mine === null || typeof p.sessionId !== 'string' || p.sessionId !== mine) continue;
    if (!deleteProposal(hypoDir, p.id)) {
      supersedeWarnings.push(`could not supersede stale proposal ${p.id} for ${target}`);
    }
  }
  return { id, target, path, supersedeWarnings };
}

/** sha256 of a UTF-8 string, hex — the same hashing base-store uses for targets. */
export function hashProposalContent(content) {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ── approval challenges ───────────────────────────────────────────────────────
//
// A challenge is the record a `proposal challenge` run leaves behind so a later
// `proposal resolve` can prove FOUR things about a batch the user approved in
// conversation: that the approval postdates the diff (the nonce did not exist
// before), that it is spent once (resolve deletes the record), that the bytes on
// disk are still the bytes whose diff was shown, and that the set being applied
// is the set that was approved.
//
// Challenges live in a SUBDIRECTORY, not beside the artifacts. listProposals
// readdir-scans `<store>/*.json` and would otherwise have to reason about which
// `.json` files are proposals and which are not; a directory entry never ends in
// `.json`, so the scan skips it structurally rather than by convention.
//
// The record binds `target` per item, not just the id and the content hash. The
// artifact body's `target` is UNTRUSTED and apply writes to whatever it says at
// apply time, so binding id+content alone would let the same id, carrying the same
// approved bytes, land on a DIFFERENT in-vault path than the one the user reviewed.

/** `<hypoDir>/.cache/proposals/challenges/`. */
export function challengesDir(hypoDir) {
  return join(proposalsDir(hypoDir), 'challenges');
}

// A session id reaches this module straight from `--session-id`, so it is subject
// to the same treatment the proposal id gets: it becomes a FILENAME. Reject
// anything that is not the transcript-resolver's own id shape.
const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** True only for a session id shape that is safe to use as a filename. */
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

// The nonce is the approval, so it is also the challenge's IDENTITY — and the record
// is stored under it: `challenges/<sessionId>.<nonce>.json`.
//
// A path keyed by the session alone (`<sessionId>.json`) cannot be claimed safely. To
// consume such a record a resolver unlinks the PATH, which claims whatever happens to
// be sitting there — not the record it actually read and verified. A `challenge` that
// remints mid-flight replaces that file, and a resolver still authorized by the OLD
// nonce would then unlink the NEW record and go on to write the old batch: one typed
// approval buys two write batches, and the new nonce is spent without its own approval.
// Naming the file after the nonce makes the unlink claim an identity instead of an
// address, so a resolver can only ever consume the exact approval it holds.
const NONCE_RE = /^[a-f0-9]{32,}$/;

/**
 * The challenges dir, ABSOLUTE, or null if it is not really inside the store — the
 * symlinked-store defense `resolvedProposalPath` applies, hoisted here so it runs BEFORE
 * anything reads the directory rather than after. A scan that lists and parses files out
 * of a redirected dir and only then rejects them has already read what it promised not to.
 *
 * Absolute is not cosmetic: `hypoDir` reaches this module straight from `--hypo-dir` and
 * may be relative (`.`). Every challenge path must be produced the same way or the same
 * file gets two names, and a record minted under one is invisible to the other.
 */
function safeChallengesDir(hypoDir) {
  const dir = resolve(challengesDir(hypoDir));
  // Anchor to the VAULT, exactly as `resolvedProposalPath` does — not to the store, which
  // is the thing that might be redirected. Comparing the real challenges dir against
  // `realpath(proposalsDir) + '/challenges'` follows a symlinked `.cache/proposals` right
  // out of the vault and then agrees with itself, so the check passes and the escape holds.
  try {
    if (realpathSync(dir) !== join(realpathSync(hypoDir), '.cache', 'proposals', 'challenges')) {
      return null;
    }
  } catch {
    /* challenges dir or store not present yet — nothing to read, unlink, or escape to */
  }
  return dir;
}

/**
 * Resolve `challenges/<sessionId>.<nonce>.json` and confirm it sits DIRECTLY inside the
 * challenges dir. Returns null (fail CLOSED) on a malformed id or nonce, or an escaping
 * path.
 */
function resolvedChallengePath(hypoDir, sessionId, nonce) {
  if (!isValidSessionId(sessionId)) return null;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return null;
  const dir = safeChallengesDir(hypoDir);
  if (!dir) return null;
  const p = resolve(join(dir, `${sessionId}.${nonce}.json`));
  if (dirname(p) !== dir) return null;
  return p;
}

/**
 * Every challenge file currently held by this session (there must be at most one), as
 * absolute paths from the same resolution `resolvedChallengePath` uses.
 *
 * The session id cannot contain a dot (`isValidSessionId`), so matching on `<sessionId>.`
 * cannot reach across sessions: `sess-1.` does not prefix `sess-10.<nonce>.json`.
 */
function sessionChallengeFiles(hypoDir, sessionId) {
  if (!isValidSessionId(sessionId)) return [];
  const dir = safeChallengesDir(hypoDir);
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${sessionId}.`) && f.endsWith('.json'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Persist a challenge for one session, replacing any earlier one it had. A session
 * holds at most one live challenge: re-running `challenge` re-reads disk and mints
 * a fresh nonce, and the previous nonce must stop working the moment it does (an
 * un-superseded old nonce would be a second, unreviewed key to the same write).
 *
 * @param {string} hypoDir
 * @param {{nonce: string, sessionId: string, mintedAt: string,
 *          items: Array<{id: string, target: string, proposedHash: string,
 *                        freshness: {state: 'hash'|'absent', hash: string|null}}>}} record
 * @returns {string|null} the artifact path, or null when the session id is unsafe
 */
export function writeChallenge(hypoDir, record) {
  const path = resolvedChallengePath(hypoDir, record.sessionId, record.nonce);
  if (!path) return null;
  // Supersede BEFORE minting, not after: an old record that outlives the start of a remint
  // can still be consumed by a resolver holding the old nonce, landing a batch the user is
  // at that very moment being asked to re-approve. Removing it first makes any such consume
  // hit ENOENT and refuse. (The window is not zero — a resolver can still consume the old
  // record in the instant between this scan and this unlink — but that batch is the one the
  // old nonce legitimately bought, and its write revalidates the target before touching it.)
  //
  // A record that will NOT go is FATAL to the mint, not a warning. Leaving it behind puts
  // two files under one session, which `readChallenge` reads as no approval at all — so
  // announcing a fresh nonce anyway would hand the user a nonce that can never be spent,
  // and every later remint would strand the session deeper.
  for (const old of sessionChallengeFiles(hypoDir, record.sessionId)) {
    if (old === path) continue; // reminting onto the same nonce: atomicWrite replaces it
    try {
      unlinkSync(old);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return null; // already gone is fine; anything else is not
    }
  }
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/**
 * Read a session's challenge. Returns null when the id is unsafe, or the record is
 * absent, unreadable, or malformed — all of which the caller must treat as "no
 * approval exists", never as "approval not required". A corrupt record is a REMINT,
 * not a bypass.
 */
export function readChallenge(hypoDir, sessionId) {
  // A session holds at most one live challenge. Two would mean a remint raced its own
  // supersession, and there is no way to tell which nonce the user was shown — so it is
  // read as NO approval (a remint), never as "pick one".
  const files = sessionChallengeFiles(hypoDir, sessionId);
  if (files.length !== 1) return null;
  const path = files[0];
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (typeof parsed.nonce !== 'string' || !parsed.nonce) return null;
    if (parsed.sessionId !== sessionId) return null; // record must own itself
    // The record must live under its OWN nonce, or the filename is not the identity the
    // consume claims. A hand-edited body that swaps the nonce is a remint, not a bypass.
    if (resolvedChallengePath(hypoDir, sessionId, parsed.nonce) !== path) return null;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    for (const it of parsed.items) {
      if (!it || typeof it !== 'object') return null;
      if (!isValidProposalId(it.id)) return null;
      if (typeof it.target !== 'string' || !it.target) return null;
      if (typeof it.proposedHash !== 'string' || !it.proposedHash) return null;
      const f = it.freshness;
      if (!f || (f.state !== 'hash' && f.state !== 'absent')) return null;
      if (f.state === 'hash' && typeof f.hash !== 'string') return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Spend the challenge for THIS EXACT NONCE, and report whether THIS CALL is the one
 * that spent it.
 *
 * Both halves of that sentence are the security property.
 *
 * "This call": `unlink` is atomic, so when two resolvers race the same nonce exactly one
 * wins and the loser gets ENOENT. Reading ENOENT as success would tell BOTH they had
 * consumed the approval, and both would write — one typed approval, two write batches.
 * The unlink IS the mutual exclusion; the return value is how the winner learns it won.
 *
 * "This exact nonce": the caller passes the nonce it actually read and verified, and the
 * record lives under that nonce's filename. So a resolver cannot consume a record it was
 * never authorized against — including a FRESHER one that a concurrent `challenge` just
 * minted in its place.
 *
 * False means "do not proceed", whether the record was already gone (someone else took
 * it, or a remint superseded it) or the unlink failed outright (it is still spendable).
 * The caller must write nothing in either case.
 */
export function consumeChallenge(hypoDir, sessionId, nonce) {
  const path = resolvedChallengePath(hypoDir, sessionId, nonce);
  if (!path) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
