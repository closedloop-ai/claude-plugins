#!/usr/bin/env node

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const SCHEMA = 'CL_SWEEP_OWNERSHIP v1';
const SECRET_SCHEMA = 'CL_SWEEP_LEASE_SECRET v1';
const DESKTOP_FENCE_SCHEMA = 'CL_SWEEP_DESKTOP_FENCE v1';
const SCOPE_EXCLUSIONS_SCHEMA = 'CL_SWEEP_SCOPE_EXCLUSIONS v1';

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || !value) fail(`Invalid argument near ${key ?? '<end>'}`);
    args[key.slice(2)] = value;
  }
  return args;
}

function required(args, key) {
  if (!args[key]) fail(`--${key} is required`);
  return args[key];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashRecord(record) {
  return sha256(JSON.stringify(record));
}

function readLedger(ledger) {
  if (!existsSync(ledger)) return [];
  const records = [];
  let previousHash = null;
  for (const [index, line] of readFileSync(ledger, 'utf8').split('\n').filter(Boolean).entries()) {
    const record = JSON.parse(line);
    const { hash, ...unsigned } = record;
    if (record.schema !== SCHEMA || record.sequence !== index + 1 || record.previousHash !== previousHash || hashRecord(unsigned) !== hash) {
      fail(`Invalid append-only ownership ledger at line ${index + 1}`);
    }
    if ('leaseToken' in record || 'token' in record) fail(`Raw lease token found in ownership ledger at line ${index + 1}`);
    records.push(record);
    previousHash = hash;
  }
  return records;
}

function currentByTicket(records) {
  const states = new Map();
  for (const record of records) states.set(record.ticket, record);
  return states;
}

function isActive(record, now = Date.now()) {
  return Boolean(record && record.event !== 'RELEASE'
    && (record.expiresAt === null || Date.parse(record.expiresAt) > now));
}

function ttl(args, ownerRole) {
  const raw = args['ttl-seconds'] ?? '900';
  if (raw === 'persistent') {
    if (ownerRole !== 'root') fail('Only root ownership may use a persistent lifetime');
    return null;
  }
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(seconds) || seconds < 30 || seconds > 86400) fail('--ttl-seconds must be between 30 and 86400');
  return seconds;
}

function append(ledger, records, data) {
  const previousHash = records.at(-1)?.hash ?? null;
  const unsigned = { schema: SCHEMA, sequence: records.length + 1, ...data, previousHash };
  const record = { ...unsigned, hash: hashRecord(unsigned) };
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(ledger, 0o600);
  return record;
}

function withLock(ledger, callback) {
  const lock = `${ledger}.lock`;
  mkdirSync(dirname(ledger), { recursive: true });
  const deadline = Date.now() + 3000;
  while (true) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) fail(`Could not acquire ledger lock: ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return callback(); } finally { rmdirSync(lock); }
}

function ownerFields(args) {
  const ownerSurface = required(args, 'owner-surface');
  if (!['desktop', 'cli'].includes(ownerSurface)) fail('--owner-surface must be desktop or cli');
  const ownerRole = required(args, 'owner-role');
  if (!['root', 'ticket_worker'].includes(ownerRole)) fail('--owner-role must be root or ticket_worker');
  return { ownerSurface, ownerRole, ownerId: required(args, 'owner-id') };
}

function secretMetadata(ticket, generation) {
  const token = randomBytes(32).toString('base64url');
  return {
    schema: SECRET_SCHEMA,
    ticket,
    generation,
    leaseId: randomUUID(),
    leaseTokenHash: sha256(token),
    token,
    createdAt: new Date().toISOString(),
  };
}

function writeSecret(pathValue, secret) {
  const path = resolve(pathValue);
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if ((statSync(parent).mode & 0o077) !== 0) fail(`Lease secret directory must be mode 0700: ${parent}`);
  writeFileSync(path, `${JSON.stringify(secret)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function readSecret(pathValue, current) {
  const path = resolve(pathValue);
  if ((statSync(path).mode & 0o077) !== 0) fail(`Lease secret file must be mode 0600: ${path}`);
  const secret = JSON.parse(readFileSync(path, 'utf8'));
  if (secret.schema !== SECRET_SCHEMA
    || secret.ticket !== current.ticket
    || secret.generation !== current.generation
    || secret.leaseId !== current.leaseId
    || secret.leaseTokenHash !== current.leaseTokenHash
    || sha256(secret.token) !== current.leaseTokenHash) {
    fail('Lease secret does not match current generation');
  }
  const expected = Buffer.from(current.leaseTokenHash, 'hex');
  const actual = Buffer.from(sha256(secret.token), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('Lease secret hash mismatch');
  return { path, secret };
}

function verifyDesktopFence(pathValue, current) {
  const path = resolve(pathValue);
  const fence = JSON.parse(readFileSync(path, 'utf8'));
  const validState = ['paused', 'idle', 'stopped'].includes(fence.taskState);
  const acknowledgedAt = Date.parse(fence.acknowledgedAt);
  const observedAt = Date.parse(fence.observedAt);
  if (fence.schema !== DESKTOP_FENCE_SCHEMA
    || fence.ticket !== current.ticket
    || fence.ownerId !== current.ownerId
    || fence.generation !== current.generation
    || !validState
    || fence.activeTurn !== false
    || fence.activeToolCall !== false
    || fence.activeImplementationWorker !== false
    || fence.pendingMutation !== false
    || !Number.isFinite(acknowledgedAt)
    || !Number.isFinite(observedAt)
    || observedAt < acknowledgedAt) {
    fail('Desktop cutover fence does not prove pause/idle with no active turn or mutation');
  }
  return { path, sha256: sha256(readFileSync(path)) };
}

function expiringRecord(event, ticket, generation, secret, owner, ttlSeconds, reason = null, extra = {}) {
  const at = new Date();
  return {
    event,
    ticket,
    generation,
    leaseId: secret.leaseId,
    leaseTokenHash: secret.leaseTokenHash,
    ...owner,
    at: at.toISOString(),
    expiresAt: ttlSeconds === null ? null : new Date(at.getTime() + ttlSeconds * 1000).toISOString(),
    leaseLifetime: ttlSeconds === null ? 'explicit' : 'ttl',
    reason,
    ...extra,
  };
}

function createGeneration(args, ledger, records, current, event, extra = {}) {
  const ticket = required(args, 'ticket');
  const generation = (current?.generation ?? 0) + 1;
  const secret = secretMetadata(ticket, generation);
  const secretPath = writeSecret(required(args, 'secret-output'), secret);
  const owner = ownerFields(args);
  try {
    return append(ledger, records, expiringRecord(event, ticket, generation, secret, owner, ttl(args, owner.ownerRole), args.reason ?? null, extra));
  } catch (error) {
    unlinkSync(secretPath);
    throw error;
  }
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function rejectExcludedTicket(ledger, ticket) {
  if (ticket === '@sweep-root' || basename(ledger) !== 'ownership.jsonl') return;
  const exclusionsPath = join(dirname(ledger), 'scope-exclusions.json');
  if (!existsSync(exclusionsPath)) return;
  let exclusions;
  try {
    exclusions = JSON.parse(readFileSync(exclusionsPath, 'utf8'));
  } catch {
    fail(`Invalid scope exclusions file: ${exclusionsPath}`);
  }
  const entries = exclusions?.excludedTickets;
  const valid = hasExactKeys(exclusions, ['schema', 'sweepId', 'projectId', 'excludedTickets'])
    && exclusions.schema === SCOPE_EXCLUSIONS_SCHEMA
    && typeof exclusions.sweepId === 'string' && exclusions.sweepId.trim().length > 0
    && typeof exclusions.projectId === 'string' && exclusions.projectId.trim().length > 0
    && Array.isArray(entries)
    && entries.every((entry) => hasExactKeys(entry, ['ticket', 'reason', 'reincludeWhen'])
      && ['ticket', 'reason', 'reincludeWhen'].every((key) => typeof entry[key] === 'string' && entry[key].trim().length > 0))
    && new Set(entries.map((entry) => entry.ticket)).size === entries.length;
  if (!valid) fail(`Invalid scope exclusions file: ${exclusionsPath}`);
  if (entries.some((entry) => entry.ticket === ticket)) fail(`Ticket ${ticket} is excluded from sweep scope`);
}

function mutate(args) {
  const ledger = resolve(required(args, 'ledger'));
  return withLock(ledger, () => {
    const records = readLedger(ledger);
    const ticket = required(args, 'ticket');
    if (['acquire', 'renew', 'replace', 'transfer'].includes(args.command)) rejectExcludedTicket(ledger, ticket);
    const current = currentByTicket(records).get(ticket);
    if (args.command === 'acquire') {
      if (isActive(current)) fail(`Ticket already has an active generation ${current.generation}`);
      if (current && current.event !== 'RELEASE') fail('Expired ownership requires authenticated replace; acquire cannot fence a prior owner');
      return createGeneration(args, ledger, records, current, current ? 'REPLACE' : 'ACQUIRE');
    }
    if (!current) fail(`No ownership generation exists for ${ticket}`);
    if (args.command === 'release' && current.event === 'RELEASE') {
      fail(`Ownership generation ${current.generation} for ${ticket} is already released`);
    }
    const authentication = readSecret(required(args, 'secret-file'), current);
    if (!isActive(current) && !['replace', 'release'].includes(args.command)) fail('Current lease is expired');
    if (args.command === 'renew') {
      return append(ledger, records, expiringRecord('RENEW', ticket, current.generation, authentication.secret, {
        ownerSurface: current.ownerSurface, ownerRole: current.ownerRole, ownerId: current.ownerId,
      }, ttl(args, current.ownerRole)));
    }
    if (args.command === 'release') {
      const at = new Date().toISOString();
      const record = append(ledger, records, {
        event: 'RELEASE', ticket, generation: current.generation, leaseId: current.leaseId,
        leaseTokenHash: current.leaseTokenHash, ownerSurface: current.ownerSurface,
        ownerRole: current.ownerRole, ownerId: current.ownerId, at, expiresAt: at,
        reason: required(args, 'reason'),
      });
      unlinkSync(authentication.path);
      return record;
    }
    if (args.command === 'transfer' || args.command === 'replace') {
      let desktopFence = null;
      const nextOwner = ownerFields(args);
      if (current.ownerSurface === 'desktop' && nextOwner.ownerSurface === 'cli') {
        desktopFence = verifyDesktopFence(required(args, 'desktop-fence-file'), current);
      }
      const record = createGeneration(args, ledger, records, current, args.command === 'transfer' ? 'TRANSFER' : 'REPLACE', desktopFence ? { desktopFence } : {});
      unlinkSync(authentication.path);
      return record;
    }
    fail(`Unknown mutation command: ${args.command}`);
  });
}

function status(args) {
  const ledger = resolve(required(args, 'ledger'));
  const records = readLedger(ledger);
  const states = currentByTicket(records);
  if (args.ticket) {
    const record = states.get(args.ticket) ?? null;
    return { schema: SCHEMA, ticket: args.ticket, active: isActive(record), record };
  }
  return { schema: SCHEMA, records: [...states.values()].map((record) => ({ ...record, active: isActive(record) })) };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = args.command === 'status' ? status(args) : mutate(args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
