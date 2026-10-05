import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Immutable manifest schema for one feature owner and its ticket leases. */
export const FEATURE_OWNERSHIP_SCHEMA = 'CL_SWEEP_FEATURE_OWNERSHIP v1';

const SHA256 = /^[a-f0-9]{64}$/;
const TICKET = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ownershipScript = resolve(dirname(fileURLToPath(import.meta.url)), 'ownership-lease.mjs');

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function privateCanonicalFile(pathValue, label) {
  if (!pathValue || !isAbsolute(pathValue) || resolve(pathValue) !== pathValue) {
    fail(`${label} must be an absolute normalized path`);
  }
  const pathStat = lstatSync(pathValue);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) fail(`${label} must be a regular file, not a symlink`);
  if ((pathStat.mode & 0o077) !== 0) fail(`${label} must not be group/world accessible`);
  if (typeof process.getuid === 'function' && pathStat.uid !== process.getuid()) {
    fail(`${label} must be owned by the current UID`);
  }
  const canonical = realpathSync(pathValue);
  if (canonical !== pathValue) fail(`${label} must be stored canonically`);
  return canonical;
}

function validateMember(member, index) {
  if (!isPlainObject(member)) fail(`Feature ownership member ${index} must be a plain object`);
  if (!TICKET.test(member.ticket || '')) fail(`Feature ownership member ${index} has an invalid ticket`);
  if (!Number.isSafeInteger(member.generation) || member.generation < 1) {
    fail(`Feature ownership member ${member.ticket} has an invalid generation`);
  }
  if (typeof member.lease_id !== 'string' || !member.lease_id) {
    fail(`Feature ownership member ${member.ticket} is missing lease_id`);
  }
  if (!SHA256.test(member.lease_token_hash || '')) {
    fail(`Feature ownership member ${member.ticket} has an invalid lease_token_hash`);
  }
  return {
    ticket: member.ticket,
    generation: member.generation,
    lease_id: member.lease_id,
    lease_token_hash: member.lease_token_hash,
  };
}

function readManifest(pathValue, expected) {
  const manifestPath = privateCanonicalFile(pathValue, 'Feature ownership manifest');
  const bytes = readFileSync(manifestPath);
  const manifestSha256 = sha256(bytes);
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch (error) {
    fail(`Feature ownership manifest is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(manifest) || manifest.schema !== FEATURE_OWNERSHIP_SCHEMA) {
    fail(`Feature ownership manifest schema must be ${FEATURE_OWNERSHIP_SCHEMA}`);
  }
  if (typeof manifest.feature_id !== 'string' || !manifest.feature_id) {
    fail('Feature ownership manifest requires feature_id');
  }
  if (!TICKET.test(manifest.anchor_ticket || '')) {
    fail('Feature ownership manifest has an invalid anchor_ticket');
  }
  if (manifest.owner_surface !== 'cli') fail('Feature ownership manifest owner_surface must be cli');
  if (typeof manifest.owner_id !== 'string' || !manifest.owner_id) {
    fail('Feature ownership manifest requires owner_id');
  }
  if (!Array.isArray(manifest.members) || manifest.members.length < 2) {
    fail('Feature ownership manifest must contain at least two members');
  }
  const members = manifest.members.map(validateMember);
  const tickets = members.map((member) => member.ticket);
  if (new Set(tickets).size !== tickets.length) fail('Feature ownership manifest members must be unique');
  const sorted = [...tickets].sort();
  if (JSON.stringify(tickets) !== JSON.stringify(sorted)) {
    fail('Feature ownership manifest members must be sorted by ticket');
  }
  if (typeof manifest.worktree !== 'string' || !isAbsolute(manifest.worktree)) {
    fail('Feature ownership manifest worktree must be an absolute path');
  }
  const canonicalWorktree = realpathSync(manifest.worktree);
  if (manifest.worktree !== canonicalWorktree) fail('Feature ownership manifest worktree must be canonical');
  if (expected) {
    if (manifest.anchor_ticket !== expected.ticket) {
      fail('Feature ownership manifest anchor_ticket does not match the canonical session ticket');
    }
    if (manifest.owner_id !== expected.ownerId || manifest.owner_surface !== 'cli') {
      fail('Feature ownership manifest owner does not match the worker session');
    }
    if (canonicalWorktree !== expected.worktree) {
      fail('Feature ownership manifest worktree does not match the worker session');
    }
    const anchor = members.find((member) => member.ticket === expected.ticket);
    if (!anchor) fail('Feature ownership manifest members do not include the anchor ticket');
    if (anchor.generation !== expected.generation || anchor.lease_id !== expected.leaseId
      || anchor.lease_token_hash !== expected.leaseTokenHash) {
      fail('Feature ownership anchor lease does not match the worker session');
    }
  }
  return {
    manifestPath,
    manifestSha256,
    featureId: manifest.feature_id,
    anchorTicket: manifest.anchor_ticket,
    ownerId: manifest.owner_id,
    ownerSurface: manifest.owner_surface,
    worktree: canonicalWorktree,
    members,
  };
}

function currentOwnershipRecords(ledgerPath) {
  const output = execFileSync(process.execPath, [
    ownershipScript, 'status', '--ledger', ledgerPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const result = JSON.parse(output);
  if (!Array.isArray(result.records)) fail('Ownership ledger status did not return current records');
  return new Map(result.records.map((record) => [record.ticket, record]));
}

function verifyMembers(scope, records) {
  for (const member of scope.members) {
    const record = records.get(member.ticket);
    if (!record?.active || record.event === 'RELEASE'
      || record.ownerSurface !== scope.ownerSurface
      || record.ownerRole !== 'ticket_worker'
      || record.ownerId !== scope.ownerId
      || record.generation !== member.generation
      || record.leaseId !== member.lease_id
      || record.leaseTokenHash !== member.lease_token_hash) {
      fail(`Feature ownership member ${member.ticket} does not match an active current lease`);
    }
  }
}

/** Create and verify the immutable feature ownership binding stored in a worker session. */
export function initializeFeatureOwnership({ manifestPath, ownershipLedger, session }) {
  if (!manifestPath && !ownershipLedger) return null;
  if (!manifestPath || !ownershipLedger) {
    fail('Feature sessions require both --feature-manifest and --ownership-ledger');
  }
  const scope = readManifest(resolve(manifestPath), session);
  scope.ownershipLedger = privateCanonicalFile(resolve(ownershipLedger), 'Ownership ledger');
  verifyMembers(scope, currentOwnershipRecords(scope.ownershipLedger));
  return scope;
}

/** Re-verify the frozen manifest and every member lease before a feature-owned operation. */
export function verifyFeatureOwnership(session) {
  const stored = session.featureOwnership;
  if (!stored) return null;
  const observed = readManifest(stored.manifestPath, session);
  if (observed.manifestSha256 !== stored.manifestSha256
    || observed.featureId !== stored.featureId
    || observed.anchorTicket !== stored.anchorTicket
    || observed.ownerId !== stored.ownerId
    || observed.worktree !== stored.worktree
    || JSON.stringify(observed.members) !== JSON.stringify(stored.members)) {
    fail('Feature ownership manifest no longer matches the frozen session binding');
  }
  const ownershipLedger = privateCanonicalFile(stored.ownershipLedger, 'Ownership ledger');
  verifyMembers(observed, currentOwnershipRecords(ownershipLedger));
  return stored;
}

/** Return the compact identity required in scoped callback and result payloads. */
export function featureOwnershipMetadata(scope) {
  if (!scope) return null;
  return {
    manifest_sha256: scope.manifestSha256,
    feature_id: scope.featureId,
    members: scope.members.map((member) => member.ticket),
  };
}

/** Require compact feature identity in callback/result payloads without changing envelope v1. */
export function validateFeatureOwnershipMetadata(value, scope, label) {
  if (!scope) return;
  const expected = featureOwnershipMetadata(scope);
  if (!isPlainObject(value)
    || value.manifest_sha256 !== expected.manifest_sha256
    || value.feature_id !== expected.feature_id
    || JSON.stringify(value.members) !== JSON.stringify(expected.members)) {
    fail(`${label} feature_ownership does not match the frozen session binding`);
  }
}
