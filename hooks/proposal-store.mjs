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
//   2. One artifact per target. Each close re-derives the same drifted target, so
//      without supersede a fresh random id would accumulate a stale artifact on
//      every close and inflate the pending count. writeProposal writes the new
//      artifact durably FIRST, then deletes any older same-target sibling — so a
//      crash between the two leaves an extra artifact (harmless, superseded next
//      time), never zero. A same-target close that is byte-identical reuses the
//      existing id instead of writing at all (idempotent).
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
  for (const p of sameTarget) {
    if (p.id === id) continue; // never delete what we just wrote
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
