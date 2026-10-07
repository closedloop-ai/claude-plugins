#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { recordSessionDisplayEvent, callbackDisplayDetail } from './display-event.mjs';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  assertNoRawSecrets,
  createTurnCollector,
  deliverDurableDelivery,
  enqueueDurableDelivery,
  ensureDurableThread,
  inspectThread,
  probe as probeGenericAppServer,
  startDurableTurn,
  verifyIdleAbsentTurn,
} from './native-app-server-orchestrator.mjs';
import {
  AppServerClient,
  initializeClient as initializeGenericClient,
  readThreadState,
} from '../../gh-monitor-pr/scripts/native-app-server-client.mjs';
import {
  featureOwnershipMetadata,
  initializeFeatureOwnership,
  validateFeatureOwnershipMetadata,
  verifyFeatureOwnership,
} from './feature-ownership.mjs';
import { isLegacyTicketOwnerModel, LEGACY_UNVERSIONED_MODEL, TICKET_OWNER_MODEL } from './model-policy.mjs';

export const SESSION_SCHEMA = 'CL_SWEEP_APP_SERVER_WORKER_SESSION v1';
export const EVENT_PREFIX = 'CL_SWEEP_EVENT v1 ';
export const RESULT_SCHEMA = 'CL_SWEEP_RESULT v1';
const MAX_FINAL_RESPONSE_BYTES = 256 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_RESULT_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_PARENT_ACTION_CHARS = 512;
export const REQUIRED_WORKER_MODEL = TICKET_OWNER_MODEL;
export const LEGACY_COMPATIBLE_WORKER_MODEL = LEGACY_UNVERSIONED_MODEL;
export const DEFAULT_TICKET_REASONING_EFFORT = 'xhigh';
const EXTERNAL_PARENT_WRITER_FAILURE = 'The target thread has an active writer outside this managed App Server daemon';
const SESSION_PATH = Symbol('sessionPath');
const EVENT_KINDS = new Set([
  'ANALYSIS_COMPLETE',
  'SPLIT_COMPLETE',
  'EXECUTION_CHECKPOINT',
  'SUPPORT_REQUEST',
  'SUPPORT_RESULT',
  'PR_MONITORING_HANDOFF',
  'MATERIAL_EVENT_HANDLED',
  'WAITING_HUMAN',
  'BLOCKED',
  'CHECKPOINT_READY',
  'TERMINAL',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALLBACK_WORD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) fail(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${argument}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function required(args, key) {
  if (!args[key]) fail(`Missing --${key}`);
  return args[key];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function binding(worktree) {
  const canonical = realpathSync(resolve(worktree));
  const root = realpathSync(git(canonical, ['rev-parse', '--show-toplevel']));
  if (root !== canonical) fail('Worker cwd must be a Git worktree root');
  const branch = git(canonical, ['branch', '--show-current']);
  if (!branch) fail('Worker cwd must use a named branch');
  const commonRaw = git(canonical, ['rev-parse', '--git-common-dir']);
  const commonDir = realpathSync(resolve(canonical, commonRaw));
  return { worktree: canonical, branch, repoCommonDir: commonDir };
}

function checkpointFingerprint(worktree) {
  const command = (args) => execFileSync('git', ['-C', worktree, ...args]);
  const working = command(['diff', 'HEAD', '--binary', '--no-ext-diff']);
  const index = command(['diff', '--cached', '--binary', '--no-ext-diff']);
  const status = command(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = command(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  return {
    statusSha256: sha256(status),
    payloads: { 'working.patch': sha256(working), 'index.patch': sha256(index) },
    untracked: paths.map((path) => {
      const absolute = resolve(worktree, path);
      const stat = lstatSync(absolute);
      const descriptor = stat.isSymbolicLink()
        ? Buffer.from(`symlink:${readlinkSync(absolute)}`)
        : readFileSync(absolute);
      return {
        path,
        type: stat.isSymbolicLink() ? 'symlink' : 'file',
        mode: stat.mode & 0o777,
        sha256: sha256(descriptor),
      };
    }),
  };
}

function verifyCutoverCheckpoint(pathValue, current) {
  if (!pathValue) return null;
  const checkpoint = realpathSync(pathValue);
  const helper = resolve(dirname(fileURLToPath(import.meta.url)), 'checkpoint-worktree.mjs');
  const verified = JSON.parse(execFileSync(process.execPath, [
    helper, 'verify', '--checkpoint', checkpoint,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (verified.repoCommonDir !== current.repoCommonDir) fail('Checkpoint repository does not match worker worktree');
  if (verified.head !== git(current.worktree, ['rev-parse', 'HEAD'])) fail('Checkpoint HEAD does not match worker worktree');
  const observed = checkpointFingerprint(current.worktree);
  const payloads = Object.fromEntries(verified.payloads.map((item) => [item.name, item.sha256]));
  if (
    verified.statusSha256 !== observed.statusSha256 ||
    payloads['working.patch'] !== observed.payloads['working.patch'] ||
    payloads['index.patch'] !== observed.payloads['index.patch'] ||
    JSON.stringify(verified.untracked) !== JSON.stringify(observed.untracked)
  ) {
    fail('Worker worktree state does not match the verified migration checkpoint');
  }
  return { path: checkpoint, manifestSha256: verified.manifestSha256 };
}

function writeJsonPrivate(pathValue, value) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function loadSession(pathValue) {
  const path = resolve(pathValue);
  const session = JSON.parse(readFileSync(path, 'utf8'));
  if (session.schema !== SESSION_SCHEMA) fail('Unexpected App Server worker session schema');
  Object.defineProperty(session, SESSION_PATH, { value: path, enumerable: false });
  return { path, session };
}

function currentUid(dependencies = {}) {
  const uid = dependencies.getuid ? dependencies.getuid() : process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 0) fail('Cannot verify result artifact UID ownership');
  return uid;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Resolve the exact session-authorized result directory without walking broad ancestors. */
function resultRootForSession(session, { create = false, ...dependencies } = {}) {
  const configured = session.resultRoot
    || (session[SESSION_PATH] ? resolve(dirname(session[SESSION_PATH]), 'results') : null);
  if (!configured || !isAbsolute(configured) || resolve(configured) !== configured) {
    fail('Worker session resultRoot must be an absolute normalized path');
  }
  if (!existsSync(configured)) {
    if (!create) fail(`Worker session resultRoot is unavailable: ${configured}`);
    mkdirSync(configured, { recursive: true, mode: 0o700 });
    chmodSync(configured, 0o700);
  }
  const rootStat = lstatSync(configured);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail('Worker session resultRoot must be a real directory, not a symlink');
  }
  if ((rootStat.mode & 0o077) !== 0) fail('Worker session resultRoot must not be group/world accessible');
  if (rootStat.uid !== currentUid(dependencies)) fail('Worker session resultRoot must be owned by the current UID');
  const canonical = realpathSync(configured);
  if (canonical !== configured && !create) fail('Worker session resultRoot must be stored canonically');
  return canonical;
}

function expectedArtifactPath(session, eventId, options = {}) {
  return resolve(resultRootForSession(session, options), `${eventId}.json`);
}

function validateArtifactEnvelope(artifact, session, event = null) {
  if (!isPlainObject(artifact)) fail('Result artifact must be a plain JSON object');
  const requiredFields = [
    'schema', 'event_id', 'parent_thread_id', 'root_generation', 'ticket', 'worker_id',
    'owner_surface', 'owner_generation', 'lease_id', 'lease_token_hash', 'worktree',
    'kind', 'phase', 'status', 'result',
  ];
  for (const field of requiredFields) {
    if (artifact[field] === undefined || artifact[field] === null) {
      fail(`Result artifact missing ${field}`);
    }
  }
  if (artifact.schema !== RESULT_SCHEMA) fail(`Result artifact schema must be ${RESULT_SCHEMA}`);
  if (!UUID.test(artifact.event_id || '')) fail('Result artifact event_id must be a UUID');
  if (artifact.parent_thread_id !== session.parentThreadId && !event) {
    fail('Result artifact parent_thread_id does not match the current parent binding');
  }
  if (artifact.ticket !== session.ticket) fail('Result artifact ticket does not match the worker session');
  if (artifact.worker_id !== session.ownerId) fail('Result artifact worker_id does not match the worker session');
  if (artifact.owner_surface !== 'cli') fail('Result artifact owner_surface must be cli');
  if (artifact.owner_generation !== session.generation) {
    fail('Result artifact owner_generation does not match the ticket generation');
  }
  if (artifact.lease_id !== session.leaseId) fail('Result artifact lease_id does not match the ticket lease');
  if (artifact.lease_token_hash !== session.leaseTokenHash) {
    fail('Result artifact lease_token_hash does not match the ticket lease');
  }
  if (!Number.isSafeInteger(artifact.root_generation) || artifact.root_generation < 1) {
    fail('Result artifact root_generation must be a positive integer');
  }
  if (!event && artifact.root_generation !== (session.parentGeneration ?? 1)) {
    fail('Result artifact root_generation does not match the current parent generation');
  }
  if (typeof artifact.worktree !== 'string' || realpathSync(artifact.worktree) !== session.worktree) {
    fail('Result artifact worktree does not match the worker session');
  }
  if (!EVENT_KINDS.has(artifact.kind)) fail(`Result artifact kind is not allowed: ${artifact.kind}`);
  if (!CALLBACK_WORD.test(artifact.phase || '')) fail('Result artifact phase must be a compact callback word');
  if (!CALLBACK_WORD.test(artifact.status || '')) fail('Result artifact status must be a compact callback word');
  if (!isPlainObject(artifact.result)) fail('Result artifact result must be a plain JSON object');
  validateFeatureOwnershipMetadata(
    artifact.result.feature_ownership,
    session.featureOwnership,
    'Result artifact result',
  );
  if (event) {
    const matchingFields = [
      'event_id', 'parent_thread_id', 'root_generation', 'ticket', 'worker_id',
      'owner_surface', 'owner_generation', 'lease_id', 'lease_token_hash', 'worktree',
      'kind', 'phase', 'status',
    ];
    for (const field of matchingFields) {
      const callbackValue = field === 'root_generation' ? (event[field] ?? 1) : event[field];
      const artifactValue = field === 'worktree' ? realpathSync(artifact[field]) : artifact[field];
      const normalizedCallback = field === 'worktree' ? realpathSync(callbackValue) : callbackValue;
      if (artifactValue !== normalizedCallback) {
        fail(`Result artifact ${field} does not match the callback`);
      }
    }
  }
  assertNoRawSecrets(artifact);
  return artifact;
}

function artifactReferenceFromEvent(event) {
  const candidate = event?.payload?.result;
  if (!isPlainObject(candidate)) return null;
  const looksLikeReference = candidate.schema === RESULT_SCHEMA
    || candidate.transport === 'local_artifact'
    || (Object.hasOwn(candidate, 'transport')
      && Object.hasOwn(candidate, 'path')
      && Object.hasOwn(candidate, 'sha256')
      && Object.hasOwn(candidate, 'bytes'));
  return looksLikeReference ? candidate : null;
}

/**
 * Inline facts a callback must keep when its full result lives in a local
 * artifact. The worker prompt renders this table, so the instructions and the
 * validator cannot drift.
 */
export const COMPACT_CALLBACK_REQUIRED_FIELDS = Object.freeze({
  ANALYSIS_COMPLETE: [['summary', 'decision']],
  PR_MONITORING_HANDOFF: [
    ['summary', 'pr_url'], ['summary', 'head_sha'], ['summary', 'ui_work'],
    ['routing', 'merge_disposition'],
  ],
  TERMINAL: [
    ['summary', 'outcome'], ['summary', 'requirements_contract'],
    ['summary', 'review_learning_memory'],
  ],
  SUPPORT_REQUEST: [['summary', 'request_id'], ['summary', 'support_type']],
  SUPPORT_RESULT: [['summary', 'request_id'], ['summary', 'outcome']],
  WAITING_HUMAN: [['summary', 'wait_kind'], ['routing', 'recheck_when']],
  BLOCKED: [['summary', 'blocker'], ['routing', 'recheck_when']],
});

/** One line per event kind: `KIND: payload.summary.a, payload.routing.b`. */
export function describeCompactCallbackRequiredFields() {
  return Object.entries(COMPACT_CALLBACK_REQUIRED_FIELDS)
    .map(([kind, fields]) => `${kind}: ${fields.map(([container, field]) => `payload.${container}.${field}`).join(', ')}`)
    .join('; ');
}

function validateCompactRouting(event) {
  if (!isPlainObject(event.payload.summary) || Object.keys(event.payload.summary).length === 0) {
    fail('Artifact callback payload.summary must be a nonempty plain JSON object');
  }
  if (!isPlainObject(event.payload.routing) || Object.keys(event.payload.routing).length === 0) {
    fail('Artifact callback payload.routing must be a nonempty plain JSON object');
  }
  const required = COMPACT_CALLBACK_REQUIRED_FIELDS[event.kind] || [];
  for (const [container, field] of required) {
    const value = event.payload[container][field];
    if (value === undefined || value === null || value === '') {
      fail(`Artifact callback payload.${container}.${field} is required for ${event.kind}`);
    }
  }
}

/** Verify one local result artifact against its immutable reference and callback binding. */
export function verifyResultArtifactReference(event, session, dependencies = {}) {
  verifyFeatureOwnership(session);
  const reference = artifactReferenceFromEvent(event);
  if (!reference) return null;
  if (!isPlainObject(reference)) fail('Result artifact reference must be a plain JSON object');
  if (reference.schema !== RESULT_SCHEMA) fail(`Result artifact reference schema must be ${RESULT_SCHEMA}`);
  if (reference.transport !== 'local_artifact') {
    fail(`Unsupported result artifact transport: ${reference.transport || 'missing'}`);
  }
  if (typeof reference.path !== 'string' || !isAbsolute(reference.path)
    || resolve(reference.path) !== reference.path) {
    fail('Result artifact path must be absolute and normalized');
  }
  if (!/^[a-f0-9]{64}$/.test(reference.sha256 || '')) {
    fail('Result artifact sha256 must be a lowercase SHA-256 digest');
  }
  if (!Number.isSafeInteger(reference.bytes) || reference.bytes < 1
    || reference.bytes > MAX_RESULT_ARTIFACT_BYTES) {
    fail(`Result artifact bytes must be between 1 and ${MAX_RESULT_ARTIFACT_BYTES}`);
  }
  const expectedPath = expectedArtifactPath(session, event.event_id, dependencies);
  if (reference.path !== expectedPath) {
    fail('Result artifact path is outside the session-authorized canonical event path');
  }
  let descriptor;
  try {
    const pathStat = lstatSync(reference.path);
    if (pathStat.isSymbolicLink()) fail('Result artifact must not be a symlink');
    descriptor = openSync(reference.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.message?.startsWith('Result artifact')) throw error;
    fail(`Result artifact is unavailable: ${error.message}`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail('Result artifact must be a regular file');
    if (before.nlink !== 1) fail('Result artifact must not have additional hard links');
    if ((before.mode & 0o777) !== 0o600) fail('Result artifact must be mode 0600');
    if (before.uid !== currentUid(dependencies)) fail('Result artifact must be owned by the current UID');
    if (before.size !== reference.bytes) {
      fail(`Result artifact size mismatch: expected ${reference.bytes}, observed ${before.size}`);
    }
    if (before.size > MAX_RESULT_ARTIFACT_BYTES) {
      fail(`Result artifact exceeds ${MAX_RESULT_ARTIFACT_BYTES} bytes`);
    }
    const contents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('Result artifact changed while it was being verified');
    }
    const observedSha256 = sha256(contents);
    if (observedSha256 !== reference.sha256) fail('Result artifact sha256 mismatch');
    let artifact;
    try { artifact = JSON.parse(contents.toString('utf8')); } catch (error) {
      fail(`Result artifact is not valid JSON: ${error.message}`);
    }
    validateArtifactEnvelope(artifact, session, event);
    return {
      ...reference,
      eventId: event.event_id,
      bindingSha256: sha256(JSON.stringify({
        event_id: artifact.event_id,
        parent_thread_id: artifact.parent_thread_id,
        root_generation: artifact.root_generation,
        ticket: artifact.ticket,
        worker_id: artifact.worker_id,
        owner_generation: artifact.owner_generation,
        lease_id: artifact.lease_id,
        worktree: artifact.worktree,
        kind: artifact.kind,
        status: artifact.status,
      })),
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    closeSync(descriptor);
  }
}

function recoveryLockPath(sessionPath) {
  return `${sessionPath}.absent-turn-recovery.lock`;
}

function assertRecoveryUnlocked(sessionPath) {
  if (existsSync(recoveryLockPath(sessionPath))) {
    fail('Worker session is fenced for absent-turn recovery');
  }
}

function validateBinding(session) {
  const current = binding(session.worktree);
  if (
    current.worktree !== session.worktree ||
    current.branch !== session.branch ||
    current.repoCommonDir !== session.repoCommonDir
  ) {
    fail('Worker session cwd binding no longer matches its ticket worktree');
  }
  verifyFeatureOwnership(session);
  return current;
}

function validateModelName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    fail(`${label} must be a compact model identifier`);
  }
  return value;
}

function validateReasoningEffort(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value)) {
    fail(`${label} must be a compact reasoning effort identifier`);
  }
  return value;
}

function validateModelBinding(session) {
  if (session.requestedModel !== REQUIRED_WORKER_MODEL && !isLegacyTicketOwnerModel(session.requestedModel)) {
    fail(
      `Worker session requestedModel must be ${REQUIRED_WORKER_MODEL}`
      + ' or a persisted legacy gpt-5.5/gpt-5.6-* binding',
    );
  }
  if (!session.modelBinding || session.modelBinding.field !== 'model') {
    fail('Worker session is missing proven App Server model binding field');
  }
  if (session.modelBinding.requestedModel !== session.requestedModel) {
    fail('Worker session modelBinding must match its persisted requestedModel');
  }
  if (!/^[a-f0-9]{64}$/.test(session.modelBinding.protocolSchemaSha256 || '')) {
    fail('Worker session model binding lacks protocolSchemaSha256 proof');
  }
  if (session.lastModelReroute && session.lastModelReroute.toModel !== session.requestedModel) {
    fail(`Worker session observed incompatible model reroute to ${session.lastModelReroute.toModel}`);
  }
  if (!session.requestedReasoningEffort) {
    fail('Worker session is missing requestedReasoningEffort');
  }
  validateReasoningEffort(session.requestedReasoningEffort, 'requestedReasoningEffort');
  return true;
}

function modelBindingStatus(session) {
  try {
    validateModelBinding(session);
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

function parseCallback(message, session) {
  verifyFeatureOwnership(session);
  if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > MAX_FINAL_RESPONSE_BYTES) {
    fail('Worker final response is missing or too large');
  }
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const callbackLines = lines.filter((line) => line.startsWith(EVENT_PREFIX));
  const line = lines.at(-1);
  if (callbackLines.length !== 1 || callbackLines[0] !== line) {
    fail('Worker final response must contain exactly one final CL_SWEEP_EVENT v1 line');
  }
  const event = JSON.parse(line.slice(EVENT_PREFIX.length));
  if (!event || Object.getPrototypeOf(event) !== Object.prototype) fail('Callback must be a plain JSON object');
  const requiredFields = [
    'event_id', 'parent_thread_id', 'ticket', 'worker_id', 'owner_surface',
    'owner_generation', 'lease_id', 'lease_token_hash', 'kind', 'phase', 'status',
    'parent_action', 'worktree', 'payload',
  ];
  for (const field of requiredFields) {
    if (event[field] === undefined || event[field] === null) fail(`Callback missing ${field}`);
  }
  const rootGeneration = event.root_generation ?? 1;
  if (!UUID.test(event.event_id || '')) fail('Callback event_id must be a UUID');
  if (event.parent_thread_id !== session.parentThreadId) fail('Callback parent_thread_id does not match the current parent binding');
  if (event.ticket !== session.ticket) fail('Callback ticket does not match the current worker binding');
  if (event.worker_id !== session.ownerId) fail('Callback worker_id does not match the current worker binding');
  if (event.owner_surface !== 'cli') fail('Callback owner_surface must be cli');
  if (event.owner_generation !== session.generation) fail('Callback owner_generation does not match the current ticket generation');
  if (rootGeneration !== (session.parentGeneration ?? 1)) fail('Callback root_generation does not match the current parent generation');
  if (event.lease_id !== session.leaseId) fail('Callback lease_id does not match the current ticket lease');
  if (event.lease_token_hash !== session.leaseTokenHash) fail('Callback lease_token_hash does not match the current ticket lease');
  if (typeof event.worktree !== 'string' || realpathSync(event.worktree) !== session.worktree) {
    fail('Callback worktree does not match the current cwd binding');
  }
  if (
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload) ||
    Object.getPrototypeOf(event.payload) !== Object.prototype
  ) {
    fail('Callback payload must be a plain JSON object');
  }
  validateFeatureOwnershipMetadata(
    event.payload.feature_ownership,
    session.featureOwnership,
    'Callback payload',
  );
  const payloadBytes = Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    fail(`Callback payload exceeds ${MAX_PAYLOAD_BYTES} UTF-8 bytes (observed ${payloadBytes})`);
  }
  if (!EVENT_KINDS.has(event.kind)) fail(`Callback kind is not allowed: ${event.kind}`);
  if (!CALLBACK_WORD.test(event.phase || '')) fail('Callback phase must be a compact callback word');
  if (!CALLBACK_WORD.test(event.status || '')) fail('Callback status must be a compact callback word');
  if (typeof event.parent_action !== 'string' || event.parent_action.length < 1) {
    fail('Callback parent_action must be a nonempty string');
  }
  if (event.parent_action.length > MAX_PARENT_ACTION_CHARS) {
    fail(`Callback parent_action exceeds ${MAX_PARENT_ACTION_CHARS} characters (observed ${event.parent_action.length})`);
  }
  if (session.acceptedEventIds.includes(event.event_id)) fail(`Duplicate callback event: ${event.event_id}`);
  assertNoRawSecrets(event);
  const artifact = verifyResultArtifactReference(event, session);
  if (artifact) validateCompactRouting(event);
  return event;
}

function appendEvent(pathValue, event) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Add the exact current callback binding and deterministic preflight to every bounded turn. */
function guardedWorkerPrompt(prompt, session, sessionPath) {
  const bindingJson = JSON.stringify({
    parent_thread_id: session.parentThreadId,
    root_generation: session.parentGeneration ?? 1,
    ticket: session.ticket,
    worker_id: session.ownerId,
    owner_surface: 'cli',
    owner_generation: session.generation,
    lease_id: session.leaseId,
    lease_token_hash: session.leaseTokenHash,
    worktree: session.worktree,
    ...(session.featureOwnership
      ? { feature_ownership: featureOwnershipMetadata(session.featureOwnership) }
      : {}),
  });
  const script = fileURLToPath(import.meta.url);
  return [
    prompt.trimEnd(),
    `For sweep display telemetry, follow ${fileURLToPath(new URL('../references/display-events.md', import.meta.url))} at actual activity entry and exit. Logging is best effort and never changes lifecycle; do not backfill guessed phases.`,
    '',
    'Before emitting the final callback, write the callback to a private candidate file: the JSON object, with or without the leading `CL_SWEEP_EVENT v1 ` prefix (the validator accepts both), and nothing else.',
    `Run: node ${JSON.stringify(script)} validate-callback --session-file ${JSON.stringify(sessionPath)} --callback-file <candidate-file>`,
    'Do not emit the callback unless that command succeeds. Delete the candidate file afterward.',
    `For substantive evidence, use a compact ${RESULT_SCHEMA} artifact by default: write the full envelope, then run: node ${JSON.stringify(script)} write-result-artifact --session-file ${JSON.stringify(sessionPath)} --artifact-file <artifact-candidate-file>`,
    `Create the artifact candidate as a regular file you own with mode 0600 (for example run \`umask 077\` before writing it, or \`chmod 600\` it), not a symlink, and at most ${MAX_RESULT_ARTIFACT_BYTES} bytes; write-result-artifact rejects anything else.`,
    'Put the returned `result` reference in callback payload.result and retain only the required payload.summary and payload.routing facts inline. Keep a complete inline payload only for a small routing-only result or when the verified local artifact transport is unavailable.',
    `With a result reference, payload.summary and payload.routing must be nonempty objects and these inline fields are required by event kind: ${describeCompactCallbackRequiredFields()}.`,
    `Use these exact current binding fields: ${bindingJson}`,
    ...(session.featureOwnership ? [
      'Put the exact feature_ownership object shown above at callback payload.feature_ownership and at result artifact result.feature_ownership.',
    ] : []),
    `Keep parent_action at or below ${MAX_PARENT_ACTION_CHARS} characters and payload at or below ${MAX_PAYLOAD_BYTES} UTF-8 bytes.`,
    'Then emit the validated JSON on exactly one final line beginning `CL_SWEEP_EVENT v1 `, with no trailing prose.',
    '',
  ].join('\n');
}

function artifactEvent(artifact) {
  return {
    event_id: artifact.event_id,
    parent_thread_id: artifact.parent_thread_id,
    root_generation: artifact.root_generation,
    ticket: artifact.ticket,
    worker_id: artifact.worker_id,
    owner_surface: artifact.owner_surface,
    owner_generation: artifact.owner_generation,
    lease_id: artifact.lease_id,
    lease_token_hash: artifact.lease_token_hash,
    kind: artifact.kind,
    phase: artifact.phase,
    status: artifact.status,
    parent_action: 'artifact preflight',
    worktree: artifact.worktree,
    payload: {},
  };
}

function writeImmutableArtifact(pathValue, contents) {
  const temporary = `${pathValue}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, pathValue);
    const directoryDescriptor = openSync(dirname(pathValue), fsConstants.O_RDONLY);
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Validate and atomically publish a canonical local result artifact for worker preflight. */
export function createResultArtifact(args) {
  const { path: sessionPath, session } = loadSession(required(args, 'session-file'));
  validateBinding(session);
  const candidatePath = resolve(required(args, 'artifact-file'));
  if (lstatSync(candidatePath).isSymbolicLink()) fail('Result artifact candidate must not be a symlink');
  const descriptor = openSync(candidatePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let candidateContents;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail('Result artifact candidate must be a regular file');
    if ((before.mode & 0o777) !== 0o600) fail('Result artifact candidate must be mode 0600');
    if (before.uid !== currentUid()) fail('Result artifact candidate must be owned by the current UID');
    if (before.size < 1 || before.size > MAX_RESULT_ARTIFACT_BYTES) {
      fail(`Result artifact candidate must be between 1 and ${MAX_RESULT_ARTIFACT_BYTES} bytes`);
    }
    candidateContents = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('Result artifact candidate changed while it was being read');
    }
  } finally {
    closeSync(descriptor);
  }
  let artifact;
  try { artifact = JSON.parse(candidateContents.toString('utf8')); } catch (error) {
    fail(`Result artifact candidate is not valid JSON: ${error.message}`);
  }
  validateArtifactEnvelope(artifact, session);
  const contents = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  if (contents.length > MAX_RESULT_ARTIFACT_BYTES) {
    fail(`Canonical result artifact exceeds ${MAX_RESULT_ARTIFACT_BYTES} bytes`);
  }
  const resultRoot = resultRootForSession(session, { create: true });
  if (!session.resultRoot) {
    session.resultRoot = resultRoot;
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(sessionPath, session);
  }
  const target = expectedArtifactPath(session, artifact.event_id);
  const reference = {
    schema: RESULT_SCHEMA,
    transport: 'local_artifact',
    path: target,
    sha256: sha256(contents),
    bytes: contents.length,
  };
  let created = false;
  if (!existsSync(target)) {
    try {
      writeImmutableArtifact(target, contents);
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const verified = verifyResultArtifactReference({
    ...artifactEvent(artifact),
    payload: { result: reference },
  }, session);
  return { created, eventId: artifact.event_id, result: reference, verified };
}

/** Validate a worker-created callback candidate before it is emitted. */
function validateCallbackFile(args) {
  const { session } = loadSession(required(args, 'session-file'));
  validateBinding(session);
  const candidate = readFileSync(resolve(required(args, 'callback-file')), 'utf8').trim();
  const message = candidate.startsWith(EVENT_PREFIX)
    ? candidate
    : `${EVENT_PREFIX}${candidate}`;
  const event = parseCallback(message, session);
  return {
    valid: true,
    eventId: event.event_id,
    ticket: event.ticket,
    ownerGeneration: event.owner_generation,
    rootGeneration: event.root_generation ?? 1,
  };
}

/** Fence a completed turn whose final callback was rejected without losing thread identity. */
function rejectCompletedCallback(path, session, turnId, message, error) {
  const correction = session.callbackCorrection;
  const exhausted = correction?.status === 'in_progress' && correction.attempts >= 1;
  session.state = exhausted ? 'FAILED' : 'INTERRUPTED';
  recordSessionDisplayEvent(path, session, { kind: 'phase', phase: null });
  session.activeTurnId = null;
  session.lastFailure = error.message;
  session.lastRejectedCallback = {
    turnId,
    messageSha256: sha256(message),
    failure: error.message,
    rejectedAt: new Date().toISOString(),
  };
  if (exhausted) {
    session.callbackCorrection = {
      ...correction,
      status: 'exhausted',
      failedTurnId: turnId,
      failure: error.message,
      exhaustedAt: new Date().toISOString(),
    };
    session.replacementRequired = {
      reason: 'CALLBACK_CORRECTION_EXHAUSTED',
      failedTurnId: turnId,
      rejectedMessageSha256: sha256(message),
      failure: error.message,
      requiredAt: new Date().toISOString(),
    };
  } else {
    session.callbackCorrection = {
      sourceTurnId: turnId,
      attempts: 0,
      maxAttempts: 1,
      status: 'required',
      requiredAt: new Date().toISOString(),
    };
  }
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
  return { exhausted };
}

function markCallbackCorrected(session, turnId) {
  if (session.callbackCorrection?.status !== 'in_progress') return;
  session.callbackCorrection = {
    ...session.callbackCorrection,
    status: 'corrected',
    correctedTurnId: turnId,
    correctedAt: new Date().toISOString(),
  };
  delete session.replacementRequired;
}

function createClient(args) {
  return new AppServerClient({
    transport: 'proxy',
    codex: args.codex || 'codex',
    socket: required(args, 'socket'),
  });
}

async function probeAppServer(args) {
  const codex = args.codex || 'codex';
  const socket = realpathSync(required(args, 'socket'));
  const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
  const generic = await probeGenericAppServer({ codex, socket, transport: 'proxy' });
  return {
    schema: SESSION_SCHEMA,
    mode: 'app_server',
    codex,
    version,
    daemonVersion: generic.daemon,
    socket,
    protocolSchemaSha256: generic.protocolSchemaSha256,
    cwdBoundStartResume: generic.cwdBoundStartResume,
    cwdBoundTurns: generic.cwdBoundTurns,
    modelBindingField: generic.modelBindingField,
    modelBoundStartResume: generic.modelBoundStartResume,
    modelBoundTurns: generic.modelBoundTurns,
    turnSteerModelOverride: generic.turnSteerModelOverride,
    effortBindingField: generic.effortBindingField,
    turnStartEffort: generic.turnStartEffort,
    requiredWorkerModel: REQUIRED_WORKER_MODEL,
    defaultTicketReasoningEffort: DEFAULT_TICKET_REASONING_EFFORT,
    liveSteering: generic.liveSteering,
  };
}

async function initializeClient(client) {
  return initializeGenericClient(client, {
    name: 'cl_sweep',
    title: 'ClosedLoop Sweep',
    version: '1.0.0',
  });
}

function assertThreadBinding(thread, session) {
  if (thread?.id !== session.appServerThreadId) fail('App Server returned a different worker thread');
  if (!thread.cwd || realpathSync(thread.cwd) !== session.worktree) {
    fail('App Server worker thread cwd does not match the ticket worktree');
  }
}

function lifecycleView(session) {
  return {
    sessionId: `${session.ticket}:${session.ownerId}:${session.generation}`,
    cwd: session.worktree,
    threadId: session.appServerThreadId,
    threadMaterialized: session.appServerThreadMaterialized === true || Boolean(
      session.activeTurnId || session.lastEvent || session.lastRejectedCallback || session.recoveryHistory?.length,
    ),
    activeTurnId: session.activeTurnId,
    pendingOperation: session.appServerPendingOperation,
    operationHistory: session.appServerOperationHistory,
    options: {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'cl_sweep',
      model: session.requestedModel,
      effort: session.requestedReasoningEffort,
    },
  };
}

function syncLifecycle(path, session, lifecycle) {
  session.appServerThreadId = lifecycle.threadId || null;
  session.appServerThreadMaterialized = lifecycle.threadMaterialized === true;
  session.activeTurnId = lifecycle.activeTurnId || null;
  if (lifecycle.pendingOperation) session.appServerPendingOperation = lifecycle.pendingOperation;
  else delete session.appServerPendingOperation;
  if (lifecycle.operationHistory) session.appServerOperationHistory = lifecycle.operationHistory;
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
}

export function initializeSession(args) {
  const path = resolve(required(args, 'session-file'));
  if (existsSync(path)) fail('Session file already exists');
  const current = binding(required(args, 'worktree'));
  const generation = Number.parseInt(required(args, 'generation'), 10);
  if (!Number.isSafeInteger(generation) || generation < 1) fail('--generation must be a positive integer');
  const leaseTokenHash = required(args, 'lease-token-hash');
  if (!/^[a-f0-9]{64}$/.test(leaseTokenHash)) fail('--lease-token-hash must be a sha256 hex digest');
  const requestedModel = validateModelName(args['requested-model'] || REQUIRED_WORKER_MODEL, '--requested-model');
  if (requestedModel !== REQUIRED_WORKER_MODEL) {
    fail(`--requested-model must be ${REQUIRED_WORKER_MODEL}; no fallback model is allowed`);
  }
  const requestedReasoningEffort = validateReasoningEffort(
    args['reasoning-effort'] || DEFAULT_TICKET_REASONING_EFFORT,
    '--reasoning-effort',
  );
  const protocolSchemaSha256 = required(args, 'protocol-schema-sha256');
  if (!/^[a-f0-9]{64}$/.test(protocolSchemaSha256)) {
    fail('--protocol-schema-sha256 must be a sha256 hex digest proving App Server model support');
  }
  const cutoverCheckpoint = verifyCutoverCheckpoint(args['cutover-checkpoint'], current);
  const requestedResultRoot = args['result-root']
    ? resolve(required(args, 'result-root'))
    : resolve(dirname(path), 'results');
  const session = {
    schema: SESSION_SCHEMA,
    ticket: required(args, 'ticket'),
    parentThreadId: required(args, 'parent-thread-id'),
    parentCwd: realpathSync(resolve(required(args, 'parent-cwd'))),
    parentGeneration: args['root-generation'] ? Number.parseInt(args['root-generation'], 10) : 1,
    ownerId: required(args, 'owner-id'),
    generation,
    leaseId: required(args, 'lease-id'),
    leaseTokenHash,
    ...current,
    resultRoot: requestedResultRoot,
    cutoverCheckpoint,
    transport: 'app_server',
    appServerVersion: args['app-server-version'] || null,
    protocolSchemaSha256,
    requestedModel,
    requestedReasoningEffort,
    modelBinding: {
      field: 'model',
      requestedModel,
      protocolSchemaSha256,
      threadStart: true,
      threadResume: true,
      turnStart: true,
      turnSteer: false,
      provenAt: new Date().toISOString(),
    },
    appServerThreadId: null,
    appServerThreadMaterialized: false,
    activeTurnId: null,
    state: 'READY',
    acceptedEventIds: [],
    events: [],
    replacementOf: args['replacement-of'] || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!Number.isSafeInteger(session.parentGeneration) || session.parentGeneration < 1) {
    fail('--root-generation must be a positive integer');
  }
  session.featureOwnership = initializeFeatureOwnership({
    manifestPath: args['feature-manifest'],
    ownershipLedger: args['ownership-ledger'],
    session,
  });
  if (!session.featureOwnership) delete session.featureOwnership;
  session.resultRoot = resultRootForSession(session, { create: true });
  writeJsonPrivate(path, session);
  return session;
}

/** Rebind a new lease generation to its original idle App Server thread. */
export async function attachIdleHistoricalThread(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  const { path: sourcePath, session: source } = loadSession(required(args, 'source-session-file'));
  const { path: outgoingPath, session: outgoing } = loadSession(required(args, 'outgoing-session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  validateModelBinding(session);
  if (
    session.state !== 'READY' || session.appServerThreadId || session.activeTurnId ||
    session.events.length || session.lastEvent || session.appServerPendingOperation
  ) fail('Historical-thread attachment requires a fresh, unused replacement session');
  if (
    source.ticket !== session.ticket || outgoing.ticket !== session.ticket ||
    source.worktree !== session.worktree || outgoing.worktree !== session.worktree ||
    source.branch !== session.branch || outgoing.branch !== session.branch ||
    source.repoCommonDir !== session.repoCommonDir || outgoing.repoCommonDir !== session.repoCommonDir ||
    source.parentThreadId !== session.parentThreadId || outgoing.parentThreadId !== session.parentThreadId ||
    source.parentGeneration !== session.parentGeneration || outgoing.parentGeneration !== session.parentGeneration ||
    source.ownerId !== session.ownerId || source.generation >= outgoing.generation ||
    outgoing.generation + 1 !== session.generation ||
    session.replacementOf !== `${outgoing.ownerId}:${outgoing.generation}` ||
    source.requestedModel !== session.requestedModel || outgoing.requestedModel !== session.requestedModel ||
    !source.appServerThreadId || !outgoing.appServerThreadId ||
    source.appServerThreadId !== required(args, 'expected-source-thread-id') ||
    outgoing.appServerThreadId !== required(args, 'expected-outgoing-thread-id') ||
    source.activeTurnId || outgoing.activeTurnId ||
    source.appServerPendingOperation || outgoing.appServerPendingOperation ||
    !source.appServerThreadMaterialized || !outgoing.appServerThreadMaterialized
  ) fail('Historical-thread attachment does not match the fenced ownership lineage');
  if (matchingWaiters(sourcePath).length || matchingWaiters(outgoingPath).length) {
    fail('A prior worker waiter is still running');
  }
  verifyRecoveryLease(session, args);
  verifyCutoverCheckpoint(required(args, 'cutover-checkpoint'), binding(session.worktree));
  const inspect = dependencies.inspectThread || inspectThread;
  const options = { cwd: session.worktree, socket: args.socket };
  let [sourceLive, outgoingLive] = await Promise.all([
    inspect({ ...options, threadId: source.appServerThreadId }),
    inspect({ ...options, threadId: outgoing.appServerThreadId }),
  ]);
  const resume = dependencies.resumeThread || (async (threadId) => {
    const client = createClient(args);
    await client.connect();
    try {
      await initializeClient(client);
      const result = await client.request('thread/resume', {
        threadId, cwd: session.worktree, approvalPolicy: 'never',
        sandbox: 'danger-full-access', serviceName: 'cl_sweep', model: session.requestedModel,
      });
      if (result?.thread?.id !== threadId ||
        !result.thread.cwd || realpathSync(result.thread.cwd) !== session.worktree) {
        fail('App Server resumed a different historical worker thread or cwd');
      }
    } finally {
      client.close();
    }
  });
  if (sourceLive.status === 'notLoaded') {
    await resume(source.appServerThreadId);
    sourceLive = await inspect({ ...options, threadId: source.appServerThreadId });
  }
  if (outgoingLive.status === 'notLoaded') {
    await resume(outgoing.appServerThreadId);
    outgoingLive = await inspect({ ...options, threadId: outgoing.appServerThreadId });
  }
  for (const live of [sourceLive, outgoingLive]) {
    if (live.status !== 'idle' || live.activeTurnId || live.cwd !== session.worktree) {
      fail('A prior App Server thread is not idle in the exact ticket worktree');
    }
  }
  if (sourceLive.canAcceptDirectInput !== true) {
    fail('Original App Server thread cannot accept the restoration turn');
  }
  const audit = {
    sourceSession: sourcePath,
    outgoingSession: outgoingPath,
    sourceThreadId: source.appServerThreadId,
    outgoingThreadId: outgoing.appServerThreadId,
    checkpoint: realpathSync(required(args, 'cutover-checkpoint')),
    restoredAt: new Date().toISOString(),
  };
  session.appServerThreadId = source.appServerThreadId;
  session.appServerThreadMaterialized = true;
  session.state = 'READY';
  session.historicalThreadRestoration = audit;
  session.updatedAt = audit.restoredAt;
  writeJsonPrivate(path, session);
  return { schema: SESSION_SCHEMA, ticket: session.ticket, generation: session.generation,
    ownerId: session.ownerId, threadId: session.appServerThreadId, state: session.state, audit };
}

async function startOrResumeThread(client, path, session, dependencies = {}) {
  validateModelBinding(session);
  const lifecycle = lifecycleView(session);
  const result = await ensureDurableThread(
    client,
    lifecycle,
    () => syncLifecycle(path, session, lifecycle),
    dependencies,
  );
  syncLifecycle(path, session, lifecycle);
  return { result, lifecycle };
}

function queueAcceptedEvent(path, session, event, eventsFile) {
  verifyFeatureOwnership(session);
  session.events ||= [];
  const verifiedArtifact = verifyResultArtifactReference(event, session);
  const queued = enqueueDurableDelivery(session, event, {
    eventId: (item) => item.event_id,
    outbox: (state) => state.events,
    parent: {
      threadId: session.parentThreadId,
      cwd: session.parentCwd,
      generation: session.parentGeneration ?? 1,
    },
    persist: () => writeJsonPrivate(path, session),
  });
  if (verifiedArtifact) {
    const stableArtifact = {
      schema: verifiedArtifact.schema,
      transport: verifiedArtifact.transport,
      path: verifiedArtifact.path,
      sha256: verifiedArtifact.sha256,
      bytes: verifiedArtifact.bytes,
      eventId: verifiedArtifact.eventId,
      bindingSha256: verifiedArtifact.bindingSha256,
    };
    if (queued.entry.resultArtifact
      && JSON.stringify(queued.entry.resultArtifact) !== JSON.stringify(stableArtifact)) {
      fail(`Persisted result artifact metadata conflicts for event ${event.event_id}`);
    }
    queued.entry.resultArtifact = stableArtifact;
    session.resultArtifacts ||= {};
    const existing = session.resultArtifacts[event.event_id];
    if (existing && JSON.stringify(existing) !== JSON.stringify(stableArtifact)) {
      fail(`Session result artifact metadata conflicts for event ${event.event_id}`);
    }
    session.resultArtifacts[event.event_id] = stableArtifact;
  }
  if (!session.acceptedEventIds.includes(event.event_id)) {
    appendEvent(eventsFile, event);
    session.acceptedEventIds.push(event.event_id);
    recordSessionDisplayEvent(path, session, { ...callbackDisplayDetail(event), id: `${event.event_id}:phase` });
    recordSessionDisplayEvent(path, session, { kind: 'message', direction: 'to_orchestrator', stage: 'sent', messageId: event.event_id, id: `${event.event_id}:sent` });
  }
  writeJsonPrivate(path, session);
  return queued.entry;
}

async function deliverParentCallback(client, path, session, event) {
  const entry = queueAcceptedEvent(path, session, event, session.eventsFile);
  const verifiedArtifact = verifyResultArtifactReference(entry.event, session);
  if (verifiedArtifact && entry.resultArtifact?.sha256 !== verifiedArtifact.sha256) {
    fail(`Result artifact digest changed before delivery for event ${event.event_id}`);
  }
  const parentBlocker = await knownParentDeliveryBlocker(client, session);
  if (parentBlocker) {
    entry.delivery = {
      status: 'pending_retry',
      failure: parentBlocker,
      updatedAt: new Date().toISOString(),
    };
    session.parentDelivery = { ...entry.delivery, eventId: event.event_id };
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
    return session.parentDelivery;
  }
  const persist = () => {
    session.parentDelivery = { ...entry.delivery, eventId: event.event_id };
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
  };
  const delivery = await deliverDurableDelivery(client, session, entry, {
    eventId: (item) => item.event_id,
    parent: {
      threadId: session.parentThreadId,
      cwd: session.parentCwd,
      generation: session.parentGeneration ?? 1,
    },
    formatDelivery: (item) => `${session.ticket} worker callback\n\n${EVENT_PREFIX}${JSON.stringify(item)}`,
    persist,
  });
  persist();
  if (delivery?.status === 'delivered') recordSessionDisplayEvent(path, session, { kind: 'message', direction: 'to_orchestrator', stage: 'delivered', messageId: event.event_id, id: `${event.event_id}:delivered` });
  return session.parentDelivery;
}

async function knownParentDeliveryBlocker(client, session) {
  const state = await readThreadState(client, session.parentThreadId);
  if (state.cwd && realpathSync(state.cwd) !== realpathSync(session.parentCwd)) {
    fail('Parent App Server thread cwd does not match the current callback binding');
  }
  if (state.status === 'active') return null;
  try {
    const resumed = await client.request('thread/resume', {
      threadId: session.parentThreadId,
      cwd: session.parentCwd,
    });
    if (resumed?.thread?.id !== session.parentThreadId) {
      fail(`App Server resumed parent thread ${resumed?.thread?.id || 'missing'} instead of ${session.parentThreadId}`);
    }
    if (resumed.thread.cwd && realpathSync(resumed.thread.cwd) !== realpathSync(session.parentCwd)) {
      fail('App Server resumed the parent thread with a different cwd');
    }
  } catch (error) {
    if (state.status === 'notLoaded' && /already has an active writer/i.test(error.message)) {
      return EXTERNAL_PARENT_WRITER_FAILURE;
    }
    throw error;
  }
  return null;
}

function verifyPersistedResultArtifacts(session) {
  session.resultArtifacts ||= {};
  for (const entry of session.events || []) {
    const verified = verifyResultArtifactReference(entry.event, session);
    if (!verified) continue;
    const stableArtifact = {
      schema: verified.schema,
      transport: verified.transport,
      path: verified.path,
      sha256: verified.sha256,
      bytes: verified.bytes,
      eventId: verified.eventId,
      bindingSha256: verified.bindingSha256,
    };
    if (entry.resultArtifact && JSON.stringify(entry.resultArtifact) !== JSON.stringify(stableArtifact)) {
      fail(`Persisted result artifact metadata does not match event ${entry.event.event_id}`);
    }
    const sessionArtifact = session.resultArtifacts[entry.event.event_id];
    if (sessionArtifact && JSON.stringify(sessionArtifact) !== JSON.stringify(stableArtifact)) {
      fail(`Session result artifact metadata does not match event ${entry.event.event_id}`);
    }
    // A crash after the generic outbox fence but before adapter metadata persistence
    // is recoverable only by re-verifying the event's already-persisted digest.
    entry.resultArtifact = stableArtifact;
    session.resultArtifacts[entry.event.event_id] = stableArtifact;
  }
}

function callbackRejectionEvent(session, turnId, message, error, exhausted) {
  return {
    event_id: randomUUID(),
    parent_thread_id: session.parentThreadId,
    root_generation: session.parentGeneration ?? 1,
    ticket: session.ticket,
    worker_id: session.ownerId,
    owner_surface: 'cli',
    owner_generation: session.generation,
    lease_id: session.leaseId,
    lease_token_hash: session.leaseTokenHash,
    kind: 'CHECKPOINT_READY',
    phase: 'callback_correction',
    status: exhausted ? 'REPLACEMENT_REQUIRED' : 'CALLBACK_CORRECTION_REQUIRED',
    parent_action: exhausted
      ? 'Replace this failed worker under the CLI lease/session replacement protocol; reconcile its preserved worktree, PR, checks, review state, and checkpoint before mutation.'
      : 'Run the one allowed callback-correction turn on this exact thread, ticket generation, lease, and worktree; do not repeat implementation work.',
    worktree: session.worktree,
    payload: {
      ...(session.featureOwnership
        ? { feature_ownership: featureOwnershipMetadata(session.featureOwnership) }
        : {}),
      schema: 'CL_SWEEP_RUNTIME_FAILURE v1',
      runtime_generated: true,
      failure_kind: exhausted ? 'CALLBACK_CORRECTION_EXHAUSTED' : 'CALLBACK_CORRECTION_REQUIRED',
      failure: error.message,
      failed_turn_id: turnId,
      rejected_message_sha256: sha256(message),
      correction_attempts: session.callbackCorrection?.attempts ?? 1,
      correction_max_attempts: session.callbackCorrection?.maxAttempts ?? 1,
      correction_required: !exhausted,
      replacement_required: exhausted,
    },
  };
}

/** Persist and deliver an actionable root event when the sole correction turn fails. */
async function rejectCompletedCallbackAndNotify(client, path, session, turnId, message, error) {
  const rejection = rejectCompletedCallback(path, session, turnId, message, error);
  const event = callbackRejectionEvent(session, turnId, message, error, rejection.exhausted);
  assertNoRawSecrets(event);
  session.lastEvent = event;
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
  try {
    const parentDelivery = await deliverAcceptedEventOrDefer(client, path, session, event);
    if (rejection.exhausted) session.replacementRequired.parentDelivery = parentDelivery;
    else session.callbackCorrection.parentDelivery = parentDelivery;
  } catch (deliveryError) {
    const parentDelivery = {
      status: 'pending_retry',
      failure: deliveryError.message,
      updatedAt: new Date().toISOString(),
    };
    if (rejection.exhausted) session.replacementRequired.parentDelivery = parentDelivery;
    else session.callbackCorrection.parentDelivery = parentDelivery;
  }
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
}

async function runTurn(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateModelBinding(session);
  if (session.requestedModel !== REQUIRED_WORKER_MODEL) {
    fail(`Persisted ${session.requestedModel} worker requires idle-boundary replacement with a new ${REQUIRED_WORKER_MODEL} session before another turn`);
  }
  if (!['READY', 'WAITING', 'FAILED', 'INTERRUPTED'].includes(session.state)) {
    fail(`Session cannot start a turn from state ${session.state}`);
  }
  if (session.callbackCorrection?.status === 'exhausted') {
    fail('Malformed-callback correction budget is exhausted; reconcile or replace by policy');
  }
  if (session.callbackCorrection?.status === 'required') {
    session.callbackCorrection = {
      ...session.callbackCorrection,
      attempts: 1,
      status: 'in_progress',
      startedAt: new Date().toISOString(),
    };
    writeJsonPrivate(path, session);
  }
  validateBinding(session);
  const activity = normalizeRunActivity(args);
  const prompt = guardedWorkerPrompt(
    readFileSync(resolve(required(args, 'prompt-file')), 'utf8'),
    session,
    path,
  );
  session.eventsFile = resolve(required(args, 'events-file'));
  writeJsonPrivate(path, session);
  const client = dependencies.client || createClient(args);
  let completedTurn = null;
  try {
    await initializeClient(client);
    const startedThread = await startOrResumeThread(client, path, session, dependencies);
    const collector = createTurnCollector(client, session.appServerThreadId);
    session.state = 'RUNNING';
    session.updatedAt = new Date().toISOString();
    delete session.lastFailure;
    writeJsonPrivate(path, session);
    const lifecycle = startedThread.lifecycle;
    const result = await startDurableTurn(
      client,
      lifecycle,
      prompt,
      () => syncLifecycle(path, session, lifecycle),
      { threadEnsured: true, freshThread: startedThread.result.materialized === false },
      dependencies,
    );
    session.activeTurnId = result.turnId;
    const activityRecorded = recordSessionDisplayEvent(path, session, {
      kind: 'phase', phase: activity.phase, reviewKind: activity.reviewKind,
      id: `${result.turnId}:activity`,
    });
    session.currentActivity = {
      ...activity,
      turnId: result.turnId,
      recorded: activityRecorded,
      reportedAt: new Date().toISOString(),
    };
    if (result.turnId && !result.recovered) recordSessionDisplayEvent(path, session, { kind: 'message', direction: 'to_worker', stage: 'sent', messageId: result.turnId, id: `${result.turnId}:sent` });
    session.appServerThreadMaterialized = true;
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
    const message = result.recovered && result.turn?.status === 'completed'
      ? turnMessage(result.turn)
      : await collector.wait(session.activeTurnId, { expectedModel: session.requestedModel });
    collector.close();
    completedTurn = { id: session.activeTurnId, message };
    const event = parseCallback(message, session);
    queueAcceptedEvent(path, session, event, session.eventsFile);
    session.lastEvent = event;
    session.lastMessageSha256 = sha256(message);
    session.activeTurnId = null;
    delete session.currentActivity;
    session.state = event.kind === 'TERMINAL' ? 'TERMINAL' : 'WAITING';
    markCallbackCorrected(session, completedTurn?.id || result.turnId);
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
    const parentDelivery = await deliverAcceptedEventOrDefer(client, path, session, event);
    return { schema: SESSION_SCHEMA, threadId: session.appServerThreadId, event, parentDelivery };
  } catch (error) {
    if (completedTurn) {
      await rejectCompletedCallbackAndNotify(
        client, path, session, completedTurn.id, completedTurn.message, error,
      );
    } else {
      if (error.modelReroute) session.lastModelReroute = { ...error.modelReroute, observedAt: new Date().toISOString() };
      session.state = 'FAILED';
      recordSessionDisplayEvent(path, session, { kind: 'phase', phase: null });
      delete session.currentActivity;
      session.lastFailure = error.message;
      session.updatedAt = new Date().toISOString();
      writeJsonPrivate(path, session);
    }
    throw error;
  } finally {
    if (!dependencies.client) client.close();
  }
}

/** Keep an already accepted callback valid when only parent delivery fails. */
async function deliverAcceptedEventOrDefer(client, path, session, event) {
  try {
    return await deliverParentCallback(client, path, session, event);
  } catch (error) {
    const entry = (session.events || []).find((candidate) => candidate.event?.event_id === event.event_id);
    if (!entry) throw error;
    if (entry.delivery?.status === 'pending') {
      entry.delivery = {
        status: 'pending_retry',
        failure: error.message,
        updatedAt: new Date().toISOString(),
      };
    }
    session.parentDelivery = {
      ...(entry.delivery || { status: 'pending_retry', failure: error.message }),
      eventId: event.event_id,
    };
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
    return session.parentDelivery;
  }
}

/** Repair the historical case where accepted delivery failure requested correction. */
async function repairAcceptedCallbackDelivery(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  const correction = session.callbackCorrection;
  if (!correction || correction.status !== 'required' || !correction.sourceTurnId) {
    fail('Session has no accepted-callback delivery repair candidate');
  }
  if (!['FAILED', 'INTERRUPTED'].includes(session.state) || session.activeTurnId) {
    fail('Accepted-callback delivery repair requires an idle failed or interrupted session');
  }
  const client = dependencies.client || createClient(args);
  try {
    await initializeClient(client);
    const live = await readThreadState(client, session.appServerThreadId);
    if (live.status === 'active' || live.activeTurnId) fail('Worker still has an active turn');
    const read = await client.request('thread/read', {
      threadId: session.appServerThreadId,
      includeTurns: true,
    });
    assertThreadBinding(read?.thread, session);
    const sourceTurn = (read.thread.turns || []).find((turn) => turn.id === correction.sourceTurnId);
    if (!sourceTurn || sourceTurn.status !== 'completed') fail('Correction source turn is not completed');
    const message = turnMessage(sourceTurn);
    const messageSha256 = sha256(message);
    if (messageSha256 !== session.lastRejectedCallback?.messageSha256) {
      fail('Correction source message no longer matches the rejected callback');
    }
    const rawEvent = rawCallbackEvent(message);
    const acceptedEntry = (session.events || []).find((entry) => entry.event?.event_id === rawEvent.event_id);
    if (
      !acceptedEntry || !session.acceptedEventIds.includes(rawEvent.event_id) ||
      JSON.stringify(acceptedEntry.event) !== JSON.stringify(rawEvent)
    ) {
      fail('Rejected callback was not durably accepted before delivery failed');
    }
    verifyResultArtifactReference(acceptedEntry.event, session);
    const runtimeFailureEventId = session.lastEvent?.event_id || null;
    const repairedAt = new Date().toISOString();
    if (acceptedEntry.delivery?.status === 'pending') {
      acceptedEntry.delivery = {
        status: 'pending_retry',
        failure: 'Parent delivery deferred after accepted callback transport failure',
        updatedAt: repairedAt,
      };
    }
    session.lastAcceptedCallbackDeliveryRepair = {
      eventId: rawEvent.event_id,
      sourceTurnId: sourceTurn.id,
      runtimeFailureEventId,
      repairedAt,
    };
    session.lastEvent = acceptedEntry.event;
    session.lastMessageSha256 = messageSha256;
    session.state = acceptedEntry.event.kind === 'TERMINAL' ? 'TERMINAL' : 'WAITING';
    session.parentDelivery = { ...acceptedEntry.delivery, eventId: rawEvent.event_id };
    delete session.callbackCorrection;
    delete session.lastRejectedCallback;
    delete session.lastFailure;
    delete session.currentActivity;
    session.updatedAt = repairedAt;
    writeJsonPrivate(path, session);
    recordSessionDisplayEvent(path, session, {
      ...callbackDisplayDetail(acceptedEntry.event),
      id: `${rawEvent.event_id}:delivery-repair`,
    });
    return {
      ticket: session.ticket,
      ownerId: session.ownerId,
      generation: session.generation,
      state: session.state,
      event: acceptedEntry.event,
      parentDelivery: session.parentDelivery,
    };
  } finally {
    if (!dependencies.client) client.close();
  }
}

/** Parse one already-validated worker callback without duplicate-state checks. */
function rawCallbackEvent(message) {
  const lines = message.split('\n').map((line) => line.trim()).filter(Boolean);
  const eventLines = lines.filter((line) => line.startsWith(EVENT_PREFIX));
  if (eventLines.length !== 1 || lines.at(-1) !== eventLines[0]) {
    fail('Completed worker message has no unique final callback');
  }
  return JSON.parse(eventLines[0].slice(EVENT_PREFIX.length));
}

async function superviseTurn(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  session.eventsFile = resolve(required(args, 'events-file'));
  writeJsonPrivate(path, session);
  if (!session.appServerThreadId) fail('Worker thread has not started');
  const client = dependencies.client || createClient(args);
  let collector;
  let completedTurn = null;
  try {
    await initializeClient(client);
    validateModelBinding(session);
    collector = createTurnCollector(client, session.appServerThreadId);
    const lifecycle = lifecycleView(session);
    const resumed = await ensureDurableThread(
      client,
      lifecycle,
      () => syncLifecycle(path, session, lifecycle),
      dependencies,
    );
    assertThreadBinding(resumed?.thread, session);
    const read = await client.request('thread/read', {
      threadId: session.appServerThreadId,
      includeTurns: true,
    });
    assertThreadBinding(read?.thread, session);
    let turn = (read.thread.turns || []).find((candidate) => candidate.id === session.activeTurnId);
    if (!turn && read.thread.status?.type === 'active') {
      const live = await readThreadState(client, session.appServerThreadId);
      const liveTurn = (read.thread.turns || []).find((candidate) => (
        candidate.id === live.activeTurnId && candidate.status === 'inProgress'
      ));
      if (!liveTurn) {
        fail(`Stored turn ${session.activeTurnId} differs from an unverified live turn ${live.activeTurnId || 'missing'}`);
      }
      session.activeTurnId = liveTurn.id;
      session.state = 'RUNNING';
      session.updatedAt = new Date().toISOString();
      delete session.lastFailure;
      writeJsonPrivate(path, session);
      turn = liveTurn;
    }
    if (!turn) fail(`Active turn ${session.activeTurnId} is absent from worker history`);
    let message;
    if (turn.status === 'inProgress') message = await collector.wait(session.activeTurnId, { expectedModel: session.requestedModel });
    else if (turn.status === 'completed') message = turnMessage(turn);
    else fail(turn.error?.message || `Worker turn ended ${turn.status}`);
    if (turn.status === 'completed') completedTurn = { id: turn.id, message };
    const event = parseCallback(message, session);
    queueAcceptedEvent(path, session, event, session.eventsFile);
    session.lastEvent = event;
    session.lastMessageSha256 = sha256(message);
    session.activeTurnId = null;
    session.state = event.kind === 'TERMINAL' ? 'TERMINAL' : 'WAITING';
    markCallbackCorrected(session, completedTurn?.id || turn.id);
    session.updatedAt = new Date().toISOString();
    delete session.lastFailure;
    writeJsonPrivate(path, session);
    const parentDelivery = await deliverParentCallback(client, path, session, event);
    return { schema: SESSION_SCHEMA, threadId: session.appServerThreadId, event, parentDelivery };
  } catch (error) {
    if (completedTurn) {
      await rejectCompletedCallbackAndNotify(
        client, path, session, completedTurn.id, completedTurn.message, error,
      );
    } else {
      if (error.modelReroute) session.lastModelReroute = { ...error.modelReroute, observedAt: new Date().toISOString() };
      session.state = 'INTERRUPTED';
      recordSessionDisplayEvent(path, session, { kind: 'phase', phase: null });
      session.lastFailure = error.message;
      session.updatedAt = new Date().toISOString();
      writeJsonPrivate(path, session);
    }
    throw error;
  } finally {
    collector?.close();
    if (!dependencies.client) client.close();
  }
}

function launchDetached(args) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  const command = session.activeTurnId ? 'supervise' : 'run';
  if (command === 'run' && session.requestedModel !== REQUIRED_WORKER_MODEL) {
    fail(`Persisted ${session.requestedModel} worker requires idle-boundary replacement with a new ${REQUIRED_WORKER_MODEL} session before another turn`);
  }
  if (command === 'run' && !args['prompt-file']) fail('Detached run requires --prompt-file');
  const activity = command === 'run' ? normalizeRunActivity(args) : null;
  const logFile = resolve(required(args, 'log-file'));
  const runnerFile = resolve(required(args, 'runner-file'));
  mkdirSync(dirname(logFile), { recursive: true });
  const descriptor = openSync(logFile, 'a', 0o600);
  const script = fileURLToPath(import.meta.url);
  const childArgs = [script, command,
    '--socket', required(args, 'socket'),
    '--session-file', required(args, 'session-file'),
    '--events-file', required(args, 'events-file')];
  if (args.codex) childArgs.push('--codex', args.codex);
  if (command === 'run') {
    childArgs.push('--prompt-file', required(args, 'prompt-file'), '--activity-phase', activity.phase);
    if (activity.reviewKind) childArgs.push('--review-kind', activity.reviewKind);
  }
  const child = spawn(process.execPath, childArgs, {
    cwd: session.parentCwd,
    detached: true,
    stdio: ['ignore', descriptor, descriptor],
  });
  child.unref();
  closeSync(descriptor);
  const runner = {
    schema: SESSION_SCHEMA,
    ticket: session.ticket,
    generation: session.generation,
    mode: command,
    pid: child.pid,
    logFile,
    startedAt: new Date().toISOString(),
    activity,
  };
  writeJsonPrivate(runnerFile, runner);
  return runner;
}

async function statusSession(args, dependencies = {}) {
  const { session } = loadSession(required(args, 'session-file'));
  let bindingValid = true;
  let bindingError = null;
  try { validateBinding(session); } catch (error) { bindingValid = false; bindingError = error.message; }
  const modelBinding = modelBindingStatus(session);
  let threadStatus = session.appServerThreadId ? 'unknown' : 'notStarted';
  let activeTurnId = session.activeTurnId;
  if (session.appServerThreadId) {
    const client = dependencies.client || createClient(args);
    try {
      await initializeClient(client);
      const result = await client.request('thread/read', {
        threadId: session.appServerThreadId,
        includeTurns: false,
      });
      assertThreadBinding(result?.thread, session);
      threadStatus = result.thread.status?.type || 'unknown';
      if (threadStatus === 'active') {
        const state = await readThreadState(client, session.appServerThreadId);
        activeTurnId = state.activeTurnId;
      }
    } finally {
      if (!dependencies.client) client.close();
    }
  }
  return {
    schema: SESSION_SCHEMA,
    ticket: session.ticket,
    ownerId: session.ownerId,
    generation: session.generation,
    state: session.state,
    appServerThreadId: session.appServerThreadId,
    activeTurnId,
    threadStatus,
    activeProcess: threadStatus === 'active',
    parentThreadId: session.parentThreadId,
    parentCwd: session.parentCwd,
    parentGeneration: session.parentGeneration ?? 1,
    requestedModel: session.requestedModel || null,
    requestedReasoningEffort: session.requestedReasoningEffort || null,
    modelBinding,
    modelReplacement: isLegacyTicketOwnerModel(session.requestedModel)
      ? {
        targetModel: REQUIRED_WORKER_MODEL,
        requiredBeforeNextTurn: true,
        idleCandidate: !activeTurnId && ['idle', 'notStarted'].includes(threadStatus),
      }
      : null,
    worktree: session.worktree,
    branch: session.branch,
    bindingValid,
    bindingError,
    lastEvent: session.lastEvent || null,
    lastFailure: ['FAILED', 'INTERRUPTED'].includes(session.state) ? session.lastFailure || null : null,
    lastRejectedCallback: session.lastRejectedCallback || null,
    callbackCorrection: session.callbackCorrection || null,
    replacementRequired: session.replacementRequired || null,
    lastStaleTurnRecovery: session.lastStaleTurnRecovery || null,
    currentActivity: session.currentActivity || null,
  };
}

/** Record or repair the declared activity for one exact live worker turn. */
async function reportActivity(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  if (!session.appServerThreadId) fail('Worker thread has not started');
  const activity = normalizeRunActivity(args);
  const client = dependencies.client || createClient(args);
  try {
    await initializeClient(client);
    const state = await readThreadState(client, session.appServerThreadId);
    if (state.status !== 'active' || !state.activeTurnId) fail('Worker has no active turn to report');
    if (session.activeTurnId !== state.activeTurnId) {
      await adoptUntrackedSuccessorTurn(client, path, session, state.activeTurnId);
    }
    const recorded = (dependencies.recordSessionDisplayEvent || recordSessionDisplayEvent)(path, session, {
      kind: 'phase', phase: activity.phase, reviewKind: activity.reviewKind,
      id: `${state.activeTurnId}:activity`,
    });
    session.currentActivity = {
      ...activity,
      turnId: state.activeTurnId,
      recorded,
      reportedAt: new Date().toISOString(),
    };
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
    if (!recorded) fail('Activity phase could not be written to the display journal');
    return { ticket: session.ticket, ownerId: session.ownerId, generation: session.generation, currentActivity: session.currentActivity };
  } finally {
    if (!dependencies.client) client.close();
  }
}

/** Replay completed automatic goal continuations after their thread becomes idle. */
async function reconcileAutomaticContinuations(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  if (!session.appServerThreadId) fail('Worker thread has not started');
  if (session.state !== 'WAITING' || session.activeTurnId || !session.lastEvent || !session.lastMessageSha256) {
    fail('Session is not an idle accepted-callback continuation candidate');
  }
  if (session.callbackCorrection || session.replacementRequired) {
    fail('Cannot reconcile continuations while callback recovery is pending');
  }
  const client = dependencies.client || createClient(args);
  try {
    await initializeClient(client);
    const live = await readThreadState(client, session.appServerThreadId);
    if (live.status === 'active' || live.activeTurnId) fail('Worker still has an active turn');
    const read = await client.request('thread/read', {
      threadId: session.appServerThreadId,
      includeTurns: true,
    });
    assertThreadBinding(read?.thread, session);
    const turns = read.thread.turns || [];
    const anchorIndex = findAcceptedCallbackTurnIndex(turns, session.lastMessageSha256, turns.length);
    if (anchorIndex < 0) fail('Automatic continuation history has no accepted callback anchor');
    const continuationEvents = parseAutomaticContinuationEvents(
      turns.slice(anchorIndex + 1),
      session,
    );
    if (continuationEvents.length === 0) fail('No completed automatic continuations need reconciliation');
    for (const { message, event } of continuationEvents) {
      session.lastEvent = event;
      session.lastMessageSha256 = sha256(message);
      queueAcceptedEvent(path, session, event, session.eventsFile);
    }
    const reconciledAt = new Date().toISOString();
    session.state = continuationEvents.at(-1).event.kind === 'TERMINAL' ? 'TERMINAL' : 'WAITING';
    delete session.currentActivity;
    session.lastAutomaticContinuationReconciliation = {
      anchorTurnId: turns[anchorIndex].id,
      eventIds: continuationEvents.map(({ event }) => event.event_id),
      reconciledAt,
    };
    session.updatedAt = reconciledAt;
    writeJsonPrivate(path, session);
    return {
      ticket: session.ticket,
      ownerId: session.ownerId,
      generation: session.generation,
      state: session.state,
      events: continuationEvents.map(({ event }) => event),
    };
  } finally {
    if (!dependencies.client) client.close();
  }
}

/**
 * Adopt either a direct-user successor after interruption or the one automatic
 * persistent-goal continuation immediately following an accepted callback.
 * Both paths keep the exact leased worker authoritative and fail closed on
 * ambiguous history or multiple live turns.
 */
async function adoptUntrackedSuccessorTurn(client, path, session, liveTurnId) {
  if (session.callbackCorrection || session.replacementRequired) {
    fail('Cannot adopt a successor turn while callback recovery is pending');
  }
  const read = await client.request('thread/read', {
    threadId: session.appServerThreadId,
    includeTurns: true,
  });
  assertThreadBinding(read?.thread, session);
  const turns = read.thread.turns || [];
  const storedTurn = turns.find((turn) => turn.id === session.activeTurnId);
  const liveTurn = turns.find((turn) => turn.id === liveTurnId);
  const inProgressTurns = turns.filter((turn) => turn.status === 'inProgress');
  if (
    !liveTurn || liveTurn.status !== 'inProgress' ||
    inProgressTurns.length !== 1 || inProgressTurns[0].id !== liveTurnId
  ) {
    fail('Successor turn is not the sole live worker turn');
  }
  const hasUserMessage = (liveTurn.items || []).some((item) => item.type === 'userMessage');
  const adoptedAt = new Date().toISOString();
  if (session.activeTurnId) {
    if (!['FAILED', 'INTERRUPTED'].includes(session.state)) {
      fail('Live worker turn does not match the stored turn');
    }
    if (!storedTurn || !['interrupted', 'failed'].includes(storedTurn.status)) {
      fail('Stored worker turn is not a terminal interrupted turn');
    }
    if (!hasUserMessage) fail('Direct successor turn has no user instruction');
    session.lastDirectTurnAdoption = {
      previousTurnId: session.activeTurnId,
      previousTurnStatus: storedTurn.status,
      turnId: liveTurnId,
      reason: 'direct_user_successor',
      adoptedAt,
    };
  } else {
    if (session.state !== 'WAITING' || !session.lastEvent || !session.lastMessageSha256) {
      fail('Untracked live turn has no accepted predecessor callback');
    }
    if (hasUserMessage) fail('Waiting-session successor unexpectedly has a user instruction');
    const liveIndex = turns.findIndex((turn) => turn.id === liveTurnId);
    const anchorIndex = findAcceptedCallbackTurnIndex(turns, session.lastMessageSha256, liveIndex);
    if (anchorIndex < 0) fail('Automatic continuation has no accepted callback anchor');
    const anchorEventId = session.lastEvent.event_id;
    const continuationEvents = parseAutomaticContinuationEvents(
      turns.slice(anchorIndex + 1, liveIndex),
      session,
      { forbidTerminal: true },
    );
    for (const { message, event } of continuationEvents) {
      session.lastEvent = event;
      session.lastMessageSha256 = sha256(message);
      queueAcceptedEvent(path, session, event, session.eventsFile);
    }
    const anchorTurn = turns[anchorIndex];
    session.lastAutomaticContinuationAdoption = {
      previousTurnId: anchorTurn.id,
      previousEventId: anchorEventId,
      replayedEventIds: continuationEvents.map(({ event }) => event.event_id),
      turnId: liveTurnId,
      reason: 'persistent_goal_continuation',
      adoptedAt,
    };
  }
  session.activeTurnId = liveTurnId;
  session.state = 'RUNNING';
  delete session.lastFailure;
  session.updatedAt = adoptedAt;
  writeJsonPrivate(path, session);
}

/** Validate completed no-user-message continuations before persisting any. */
function parseAutomaticContinuationEvents(turns, session, { forbidTerminal = false } = {}) {
  const continuationEvents = turns.map((turn) => {
    if (turn.status !== 'completed') fail('Automatic continuation chain contains a nonterminal turn');
    if ((turn.items || []).some((item) => item.type === 'userMessage')) {
      fail('Automatic continuation chain contains a user-authored turn');
    }
    const message = turnMessage(turn);
    const event = parseCallback(message, session);
    if (forbidTerminal && event.kind === 'TERMINAL') {
      fail('Terminal callback cannot be followed by an automatic continuation');
    }
    return { turn, message, event };
  });
  if (new Set(continuationEvents.map(({ event }) => event.event_id)).size !== continuationEvents.length) {
    fail('Automatic continuation chain contains duplicate callback events');
  }
  const terminalIndex = continuationEvents.findIndex(({ event }) => event.kind === 'TERMINAL');
  if (terminalIndex >= 0 && terminalIndex !== continuationEvents.length - 1) {
    fail('Terminal callback is not the final automatic continuation');
  }
  return continuationEvents;
}

/** Locate the already-accepted callback turn before one live continuation. */
function findAcceptedCallbackTurnIndex(turns, acceptedMessageSha256, liveIndex) {
  for (let index = liveIndex - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.status !== 'completed') continue;
    try {
      if (sha256(turnMessage(turn)) === acceptedMessageSha256) return index;
    } catch { /* A non-callback turn cannot be the durable anchor. */ }
  }
  return -1;
}

/** Require an explicit activity classification for every new worker turn. */
export function normalizeRunActivity(args) {
  const phase = required(args, 'activity-phase');
  if (!['planning', 'coding', 'reviewing'].includes(phase)) {
    fail('--activity-phase must be planning, coding, or reviewing');
  }
  const reviewKind = args['review-kind'];
  if (phase === 'reviewing' && !['plan', 'code'].includes(reviewKind)) {
    fail('Reviewing activity requires --review-kind plan|code');
  }
  if (phase !== 'reviewing' && reviewKind !== undefined) {
    fail('--review-kind is valid only with --activity-phase reviewing');
  }
  return reviewKind ? { phase, reviewKind } : { phase };
}

/** Rebind an idle worker's callback target after a fail-closed sweep-root transfer. */
async function rebindParent(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  const expectedGeneration = Number.parseInt(required(args, 'expected-root-generation'), 10);
  const expectedCwd = realpathSync(resolve(required(args, 'expected-parent-cwd')));
  if (
    session.parentThreadId !== required(args, 'expected-parent-thread-id') ||
    session.parentCwd !== expectedCwd ||
    (session.parentGeneration ?? 1) !== expectedGeneration
  ) {
    fail('Worker parent binding does not match the expected root generation');
  }
  if (session.activeTurnId || ['RUNNING', 'DISCONNECTED'].includes(session.state)) {
    fail('Cannot rebind a worker with an active or disconnected turn');
  }
  if (session.parentDelivery?.status === 'delivering'
    || session.events?.some((entry) => entry.delivery?.status === 'delivering')) {
    fail('Cannot rebind a worker with an ambiguous in-flight parent callback');
  }
  if (session.appServerThreadId) {
    const live = await (dependencies.inspectThread || inspectThread)({
      threadId: session.appServerThreadId,
      cwd: session.worktree,
      socket: args.socket,
      codex: args.codex,
      transport: args.transport,
    }, dependencies);
    if (live.status === 'active' || live.activeTurnId) {
      fail(`Cannot rebind active worker turn ${live.activeTurnId || 'unknown'}`);
    }
  }
  verifyPersistedResultArtifacts(session);
  session.parentHistory ||= [];
  session.parentHistory.push({
    threadId: session.parentThreadId,
    cwd: session.parentCwd,
    generation: session.parentGeneration ?? 1,
    replacedAt: new Date().toISOString(),
  });
  session.parentThreadId = required(args, 'parent-thread-id');
  session.parentCwd = realpathSync(resolve(required(args, 'parent-cwd')));
  session.parentGeneration = expectedGeneration + 1;
  if (session.parentDelivery?.status === 'pending_retry') {
    session.parentDelivery.failure = 'parent binding transferred; delivery must be retried';
  }
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
  return {
    ticket: session.ticket,
    workerThreadId: session.appServerThreadId,
    ticketOwnerGeneration: session.generation,
    parentThreadId: session.parentThreadId,
    parentCwd: session.parentCwd,
    parentGeneration: session.parentGeneration,
  };
}

function turnMessage(turn) {
  const messages = turn?.items || [];
  return messages.findLast((item) => (
    item?.type === 'agentMessage' && item.phase === 'final_answer' && item.text
  ))?.text || messages.findLast((item) => item?.type === 'agentMessage' && item.text)?.text || '';
}

async function reconcileSession(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  if (!session.appServerThreadId) fail('Worker thread has not started');
  const client = dependencies.client || createClient(args);
  try {
    await initializeClient(client);
    validateModelBinding(session);
    const lifecycle = lifecycleView(session);
    const resumed = await ensureDurableThread(
      client,
      lifecycle,
      () => syncLifecycle(path, session, lifecycle),
      dependencies,
    );
    assertThreadBinding(resumed?.thread, session);
    const read = await client.request('thread/read', {
      threadId: session.appServerThreadId,
      includeTurns: true,
    });
    assertThreadBinding(read?.thread, session);
    const turn = (read.thread.turns || []).find((candidate) => candidate.id === session.activeTurnId);
    if (!turn) fail(`Active turn ${session.activeTurnId || 'missing'} is absent from worker history`);
    if (turn.status === 'inProgress') {
      session.state = 'RUNNING';
      session.updatedAt = new Date().toISOString();
      writeJsonPrivate(path, session);
      return { action: 'still_running', threadId: session.appServerThreadId, turnId: turn.id };
    }
    if (turn.status !== 'completed') {
      session.state = turn.status === 'interrupted' ? 'INTERRUPTED' : 'FAILED';
      recordSessionDisplayEvent(path, session, { kind: 'phase', phase: null });
      session.lastFailure = turn.error?.message || `Worker turn ended ${turn.status}`;
      session.activeTurnId = null;
      session.updatedAt = new Date().toISOString();
      writeJsonPrivate(path, session);
      return { action: 'turn_not_completed', status: turn.status, failure: session.lastFailure };
    }
    const message = turnMessage(turn);
    let event;
    try {
      event = parseCallback(message, session);
    } catch (error) {
      session.eventsFile = resolve(required(args, 'events-file'));
      await rejectCompletedCallbackAndNotify(client, path, session, turn.id, message, error);
      throw error;
    }
    session.eventsFile = resolve(required(args, 'events-file'));
    queueAcceptedEvent(path, session, event, session.eventsFile);
    session.lastEvent = event;
    session.lastMessageSha256 = sha256(message);
    session.activeTurnId = null;
    session.state = event.kind === 'TERMINAL' ? 'TERMINAL' : 'WAITING';
    markCallbackCorrected(session, turn.id);
    session.updatedAt = new Date().toISOString();
    delete session.lastFailure;
    writeJsonPrivate(path, session);
    const parentDelivery = await deliverParentCallback(client, path, session, event);
    return { action: 'callback_recovered', threadId: session.appServerThreadId, event, parentDelivery };
  } finally {
    if (!dependencies.client) client.close();
  }
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`);
  return parsed;
}

function validateRecoveryExpectations(session, args) {
  const expectedWorktree = realpathSync(resolve(required(args, 'expected-worktree')));
  const expectedGeneration = positiveInteger(required(args, 'expected-generation'), '--expected-generation');
  const expectedRootGeneration = positiveInteger(required(args, 'expected-root-generation'), '--expected-root-generation');
  const expectedState = required(args, 'expected-state');
  if (!['RUNNING', 'INTERRUPTED', 'DISCONNECTED'].includes(expectedState)) {
    fail('--expected-state must be RUNNING, INTERRUPTED, or DISCONNECTED');
  }
  if (
    session.ticket !== required(args, 'expected-ticket') ||
    session.appServerThreadId !== required(args, 'expected-thread-id') ||
    session.activeTurnId !== required(args, 'expected-turn-id') ||
    session.worktree !== expectedWorktree ||
    session.branch !== required(args, 'expected-branch') ||
    session.ownerId !== required(args, 'expected-owner-id') ||
    session.generation !== expectedGeneration ||
    session.leaseId !== required(args, 'expected-lease-id') ||
    session.parentThreadId !== required(args, 'expected-parent-thread-id') ||
    (session.parentGeneration ?? 1) !== expectedRootGeneration ||
    session.state !== expectedState
  ) {
    fail('Worker session does not match the expected stale-turn ownership fence');
  }
}

function verifyRecoveryLease(session, args) {
  const ownershipScript = resolve(dirname(fileURLToPath(import.meta.url)), 'ownership-lease.mjs');
  const result = JSON.parse(execFileSync(process.execPath, [
    ownershipScript,
    'status',
    '--ledger', required(args, 'ownership-ledger'),
    '--ticket', session.ticket,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const record = result.record;
  if (
    !result.active ||
    record?.ticket !== session.ticket ||
    record?.generation !== session.generation ||
    record?.leaseId !== session.leaseId ||
    record?.leaseTokenHash !== session.leaseTokenHash ||
    record?.ownerSurface !== 'cli' ||
    record?.ownerRole !== 'ticket_worker' ||
    record?.ownerId !== session.ownerId
  ) {
    fail('Active ownership ledger record does not match the worker session');
  }
  return record;
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function matchingWaiters(sessionPath) {
  const script = fileURLToPath(import.meta.url);
  const output = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const command = match[2];
    if (!command.includes(script) || !command.includes(sessionPath)) return [];
    if (!/app-server-worker-session\.mjs (?:run|supervise)\b/.test(command)) return [];
    return [{ pid: Number.parseInt(match[1], 10), command }];
  });
}

async function fenceDetachedRunner(sessionPath, session, args) {
  const waiters = matchingWaiters(sessionPath);
  const runnerFile = args['runner-file'] ? resolve(args['runner-file']) : null;
  if (!runnerFile) {
    if (waiters.length) fail('A live detached waiter requires its exact --runner-file before recovery');
    return { receiptFile: null, pid: null, wasRunning: false, fenced: true };
  }
  if ((statSync(runnerFile).mode & 0o077) !== 0) fail('Runner receipt must be mode 0600');
  const runner = JSON.parse(readFileSync(runnerFile, 'utf8'));
  if (
    runner.schema !== SESSION_SCHEMA ||
    runner.ticket !== session.ticket ||
    runner.generation !== session.generation ||
    !['run', 'supervise'].includes(runner.mode) ||
    !Number.isSafeInteger(runner.pid) ||
    runner.pid < 1
  ) {
    fail('Runner receipt does not match the worker session');
  }
  const live = pidIsAlive(runner.pid);
  if (live) {
    if (waiters.length !== 1 || waiters[0].pid !== runner.pid) {
      fail('Runner PID is not the sole exact session waiter');
    }
    process.kill(runner.pid, 'SIGTERM');
    const deadline = Date.now() + 5_000;
    while (pidIsAlive(runner.pid) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (pidIsAlive(runner.pid)) fail(`Runner ${runner.pid} did not stop after SIGTERM`);
  } else if (waiters.length) {
    fail('Runner receipt PID differs from the live exact session waiter');
  }
  if (matchingWaiters(sessionPath).length) fail('An exact session waiter remains after runner fencing');
  const fencedAt = new Date().toISOString();
  writeJsonPrivate(runnerFile, {
    ...runner,
    status: 'FENCED_ABSENT_TURN',
    staleTurnId: session.activeTurnId,
    fencedAt,
  });
  return { receiptFile: runnerFile, pid: runner.pid, wasRunning: live, fenced: true, fencedAt };
}

/**
 * Fence a stale stored turn only after exact ownership and two idle/absence proofs.
 * No worker turn is started and the existing thread, worktree, lease, and generations remain unchanged.
 */
async function recoverAbsentTurn(args, dependencies = {}) {
  const sessionPath = resolve(required(args, 'session-file'));
  const lockPath = recoveryLockPath(sessionPath);
  mkdirSync(lockPath, { mode: 0o700 });
  try {
    const initial = loadSession(sessionPath);
    validateBinding(initial.session);
    validateRecoveryExpectations(initial.session, args);
    (dependencies.verifyLease || verifyRecoveryLease)(initial.session, args);
    const verifyAbsent = dependencies.verifyAbsentTurn || verifyIdleAbsentTurn;
    const proofOptions = {
      threadId: initial.session.appServerThreadId,
      turnId: initial.session.activeTurnId,
      cwd: initial.session.worktree,
      socket: args.socket,
      codex: args.codex,
      transport: args.transport,
    };
    await verifyAbsent(proofOptions, dependencies);
    const runnerFence = await (dependencies.fenceRunner || fenceDetachedRunner)(
      sessionPath,
      initial.session,
      args,
    );

    const current = loadSession(sessionPath);
    validateBinding(current.session);
    validateRecoveryExpectations(current.session, args);
    (dependencies.verifyLease || verifyRecoveryLease)(current.session, args);
    const authoritative = await verifyAbsent(proofOptions, dependencies);
    const recoveredAt = new Date().toISOString();
    const audit = {
      schema: 'CL_SWEEP_STALE_TURN_RECOVERY v1',
      turnId: current.session.activeTurnId,
      priorState: current.session.state,
      threadId: current.session.appServerThreadId,
      cwd: current.session.worktree,
      authoritativeStatus: authoritative.status,
      authoritativeActiveTurnId: authoritative.activeTurnId,
      historyAbsent: authoritative.historyAbsent,
      ownerId: current.session.ownerId,
      ownerGeneration: current.session.generation,
      leaseId: current.session.leaseId,
      parentThreadId: current.session.parentThreadId,
      rootGeneration: current.session.parentGeneration ?? 1,
      runner: runnerFence,
      recoveredAt,
    };
    current.session.staleTurnRecoveryHistory ||= [];
    current.session.staleTurnRecoveryHistory.push(audit);
    current.session.lastStaleTurnRecovery = audit;
    current.session.activeTurnId = null;
    current.session.state = 'INTERRUPTED';
    recordSessionDisplayEvent(current.path, current.session, { kind: 'phase', phase: null });
    current.session.lastFailure = `Fenced stale turn ${audit.turnId}; authoritative exact-bound thread is idle and the turn is absent from history`;
    current.session.updatedAt = recoveredAt;
    writeJsonPrivate(current.path, current.session);
    return {
      schema: SESSION_SCHEMA,
      action: 'stale_turn_fenced',
      continuable: true,
      ticket: current.session.ticket,
      workerThreadId: current.session.appServerThreadId,
      staleTurnId: audit.turnId,
      state: current.session.state,
      worktree: current.session.worktree,
      ownerId: current.session.ownerId,
      ownerGeneration: current.session.generation,
      leaseId: current.session.leaseId,
      parentThreadId: current.session.parentThreadId,
      rootGeneration: current.session.parentGeneration ?? 1,
      runnerFence,
      recoveredAt,
    };
  } finally {
    rmdirSync(lockPath);
  }
}

async function steerSession(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  if (!session.appServerThreadId) fail('Worker thread has not started');
  const prompt = readFileSync(resolve(required(args, 'prompt-file')), 'utf8');
  const client = dependencies.client || createClient(args);
  try {
    await initializeClient(client);
    validateModelBinding(session);
    const state = await readThreadState(client, session.appServerThreadId);
    if (state.status !== 'active' || !state.activeTurnId) fail('Worker has no active turn to steer');
    if (!state.canAcceptDirectInput) fail('Worker active turn cannot currently accept direct input');
    const result = await client.request('turn/steer', {
      threadId: session.appServerThreadId,
      expectedTurnId: state.activeTurnId,
      input: [{ type: 'text', text: prompt }],
    });
    if (result?.turnId !== state.activeTurnId) fail('App Server steered a different worker turn');
    return { threadId: session.appServerThreadId, turnId: result.turnId, mode: 'steer' };
  } finally {
    if (!dependencies.client) client.close();
  }
}

async function notifyParent(args, dependencies = {}) {
  const { path, session } = loadSession(required(args, 'session-file'));
  if (!session.lastEvent) fail('Worker has no accepted event to deliver');
  const client = dependencies.client || createClient(args);
  try {
    await initializeClient(client);
    const parentDelivery = await deliverParentCallback(client, path, session, session.lastEvent);
    if (parentDelivery.status !== 'delivered') fail(parentDelivery.failure);
    return parentDelivery;
  } finally {
    if (!dependencies.client) client.close();
  }
}

function repairExternalParentWriterDelivery(args) {
  const { path, session } = loadSession(required(args, 'session-file'));
  assertRecoveryUnlocked(path);
  validateBinding(session);
  const repairedAt = new Date().toISOString();
  let repaired = 0;
  for (const entry of session.events || []) {
    if (repairExternalParentWriterDeliveryEntry(entry, repairedAt)) repaired += 1;
  }
  if (session.parentDelivery?.status === 'delivering') {
    const parentEntry = (session.events || []).find((entry) => (
      entry.event?.event_id === session.parentDelivery.eventId
    ));
    if (!parentEntry || parentEntry.delivery.status !== 'pending_retry') {
      fail('Parent delivery is ambiguous and is not a known external-parent-writer failure');
    }
    session.parentDelivery = { ...parentEntry.delivery, eventId: session.parentDelivery.eventId };
  }
  if (repaired === 0) fail('No known external-parent-writer delivery entries found');
  session.updatedAt = repairedAt;
  writeJsonPrivate(path, session);
  return {
    schema: SESSION_SCHEMA,
    ticket: session.ticket,
    repaired,
    parentDelivery: session.parentDelivery || null,
  };
}

function repairExternalParentWriterDeliveryEntry(entry, repairedAt) {
  if (entry?.delivery?.status !== 'delivering') return false;
  if (entry.delivery.failure !== EXTERNAL_PARENT_WRITER_FAILURE || entry.delivery.outcome !== 'ambiguous') {
    fail(`Ambiguous delivery ${entry?.event?.event_id || 'unknown'} is not a known external-parent-writer failure`);
  }
  entry.delivery = {
    status: 'pending_retry',
    failure: EXTERNAL_PARENT_WRITER_FAILURE,
    repairedFrom: {
      status: 'delivering',
      attemptId: entry.delivery.attemptId || null,
      outcome: entry.delivery.outcome,
      updatedAt: entry.delivery.updatedAt || null,
    },
    updatedAt: repairedAt,
  };
  return true;
}

function usage() {
  return [
    'Usage: app-server-worker-session.mjs <command> [options]',
    '',
    'Commands:',
    '  probe                 Verify the managed App Server worker surface',
    '  init                  Create one exact cwd-bound ticket session',
    '  attach-idle-historical-thread Bind a fresh lease to its original verified-idle thread',
    '  run                   Start one idle turn and capture its callback',
    '  supervise             Reconnect to one stored active turn',
    '  launch                Run or supervise through a detached runner receipt',
    '  status                Read durable and authoritative live state',
    '  report-activity       Record/repair one exact active turn activity',
    '  reconcile-continuations Replay completed automatic goal continuation callbacks',
    '  repair-accepted-callback-delivery Restore an accepted callback after delivery-only failure',
    '  recover-absent-turn   Fence an absent stored turn after exact idle/ownership checks',
    '  rebind-parent         Advance an idle callback binding by one root generation',
    '  steer                 Send input only to the exact active turn',
    '  reconcile             Recover an in-progress or completed stored turn',
    '  notify-parent         Retry the last accepted parent callback',
    '  repair-parent-writer-delivery Convert known external-parent-writer delivery fences to pending_retry',
    '  write-result-artifact Validate and atomically publish one local full-result artifact',
    '  validate-callback     Validate candidate callback JSON against the current session binding',
    '',
    'recover-absent-turn requires --session-file, --ownership-ledger, and exact expected',
    'ticket/thread/turn/worktree/branch/owner/generation/lease/parent/root-generation/state guards.',
    'Pass --runner-file when a detached run/supervise waiter is still alive.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || ['help', '--help', '-h'].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  let result;
  if (args.command === 'init') result = initializeSession(args);
  else if (args.command === 'attach-idle-historical-thread') result = await attachIdleHistoricalThread(args);
  else if (args.command === 'probe') result = await probeAppServer(args);
  else if (args.command === 'run') result = await runTurn(args);
  else if (args.command === 'supervise') result = await superviseTurn(args);
  else if (args.command === 'launch') result = launchDetached(args);
  else if (args.command === 'status') result = await statusSession(args);
  else if (args.command === 'report-activity') result = await reportActivity(args);
  else if (args.command === 'reconcile-continuations') result = await reconcileAutomaticContinuations(args);
  else if (args.command === 'repair-accepted-callback-delivery') result = await repairAcceptedCallbackDelivery(args);
  else if (args.command === 'recover-absent-turn') result = await recoverAbsentTurn(args);
  else if (args.command === 'rebind-parent') result = await rebindParent(args);
  else if (args.command === 'steer') result = await steerSession(args);
  else if (args.command === 'reconcile') result = await reconcileSession(args);
  else if (args.command === 'notify-parent') result = await notifyParent(args);
  else if (args.command === 'repair-parent-writer-delivery') result = repairExternalParentWriterDelivery(args);
  else if (args.command === 'write-result-artifact') result = createResultArtifact(args);
  else if (args.command === 'validate-callback') result = validateCallbackFile(args);
  else fail(`Unknown command: ${args.command}\n\n${usage()}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export {
  createTurnCollector,
  resultRootForSession,
  parseCallback,
  probeAppServer,
  reconcileSession,
  recoverAbsentTurn,
  rebindParent,
  reportActivity,
  reconcileAutomaticContinuations,
  repairAcceptedCallbackDelivery,
  notifyParent,
  repairExternalParentWriterDelivery,
  runTurn,
  superviseTurn,
  statusSession,
  steerSession,
  validateCallbackFile,
  validateBinding,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
