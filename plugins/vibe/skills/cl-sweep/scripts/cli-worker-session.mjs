#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoRawSecrets } from './native-app-server-orchestrator.mjs';
import { parseCallback as parseBoundCallback } from './app-server-worker-session.mjs';
import {
  featureOwnershipMetadata,
  initializeFeatureOwnership,
  verifyFeatureOwnership,
} from './feature-ownership.mjs';
import { isLegacyTicketOwnerModel, TICKET_OWNER_MODEL } from './model-policy.mjs';

const SESSION_SCHEMA = 'CL_SWEEP_CLI_WORKER_SESSION v1';
const EVENT_PREFIX = 'CL_SWEEP_EVENT v1 ';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PARENT_ACTION_CHARS = 512;

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

function ensurePrivateParent(path) {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if ((statSync(parent).mode & 0o077) !== 0) fail(`Session directory must be mode 0700: ${parent}`);
}

function writeJsonPrivate(path, value, exclusive = false) {
  ensurePrivateParent(path);
  if (exclusive && existsSync(path)) fail(`Refusing to overwrite session file: ${path}`);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function loadSession(pathValue) {
  const path = resolve(pathValue);
  if ((statSync(path).mode & 0o077) !== 0) fail(`Session file must be mode 0600: ${path}`);
  const session = JSON.parse(readFileSync(path, 'utf8'));
  if (session.schema !== SESSION_SCHEMA) fail(`Unsupported session schema: ${session.schema}`);
  return { path, session };
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function inspectWorktree(worktree) {
  const root = realpathSync(git(worktree, ['rev-parse', '--show-toplevel']));
  if (root !== realpathSync(worktree)) fail('Worker cwd must be a Git worktree root');
  const branch = git(worktree, ['branch', '--show-current']);
  if (!branch) fail('Worker cwd must use a named branch');
  return {
    worktree: root,
    branch,
    repoCommonDir: realpathSync(resolve(root, git(root, ['rev-parse', '--git-common-dir']))),
  };
}

function currentCheckpointFingerprint(worktree) {
  const command = (args) => execFileSync('git', ['-C', worktree, ...args]);
  const working = command(['diff', 'HEAD', '--binary', '--no-ext-diff']);
  const index = command(['diff', '--cached', '--binary', '--no-ext-diff']);
  const status = command(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = command(['ls-files', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const untracked = paths.map((path) => {
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
  });
  return {
    statusSha256: sha256(status),
    payloads: { 'working.patch': sha256(working), 'index.patch': sha256(index) },
    untracked,
  };
}

function verifyCutoverCheckpoint(pathValue, binding) {
  if (!pathValue) return null;
  const checkpoint = realpathSync(pathValue);
  const helper = resolve(dirname(fileURLToPath(import.meta.url)), 'checkpoint-worktree.mjs');
  const verified = JSON.parse(execFileSync(process.execPath, [helper, 'verify', '--checkpoint', checkpoint], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (realpathSync(verified.sourceWorktree) === binding.worktree) {
    fail('CLI cutover worktree must differ from the legacy checkpoint source worktree');
  }
  if (verified.repoCommonDir !== binding.repoCommonDir || verified.head !== git(binding.worktree, ['rev-parse', 'HEAD'])) {
    fail('CLI cutover worktree does not match the checkpoint repository and HEAD');
  }
  const current = currentCheckpointFingerprint(binding.worktree);
  const payloads = Object.fromEntries(verified.payloads.map((item) => [item.name, item.sha256]));
  if (verified.statusSha256 !== current.statusSha256
    || payloads['working.patch'] !== current.payloads['working.patch']
    || payloads['index.patch'] !== current.payloads['index.patch']
    || JSON.stringify(verified.untracked) !== JSON.stringify(current.untracked)) {
    fail('CLI cutover worktree state does not match the verified checkpoint');
  }
  return { path: checkpoint, manifestSha256: verified.manifestSha256 };
}

function validateWorktreeBinding(session) {
  const current = inspectWorktree(session.worktree);
  if (current.worktree !== session.worktree || current.branch !== session.branch || current.repoCommonDir !== session.repoCommonDir) {
    fail('Worker session cwd binding no longer matches its ticket worktree');
  }
  return current;
}

function validateBinding(session) {
  const current = validateWorktreeBinding(session);
  verifyFeatureOwnership(session);
  if (session.requestedModel !== TICKET_OWNER_MODEL && !isLegacyTicketOwnerModel(session.requestedModel)) {
    fail(`Worker session requires a proven ${TICKET_OWNER_MODEL} or persisted legacy model binding`);
  }
  return current;
}

function probe(args) {
  const codex = args.codex ?? 'codex';
  const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
  const launchHelp = execFileSync(codex, ['exec', '--help'], { encoding: 'utf8' });
  const resumeHelp = execFileSync(codex, ['exec', 'resume', '--help'], { encoding: 'utf8' });
  const launchCwd = /-C, --cd <DIR>/.test(launchHelp);
  const explicitResume = /\[SESSION_ID\]/.test(resumeHelp);
  const modelBoundLaunchResume = /-m, --model <MODEL>/.test(launchHelp)
    && /-m, --model <MODEL>/.test(resumeHelp);
  if (!launchCwd || !explicitResume || !modelBoundLaunchResume) {
    fail('Installed Codex CLI cannot prove cwd-bound launch, explicit-session resume, and model-bound launch/resume');
  }
  return { schema: SESSION_SCHEMA, mode: 'codex_exec', codex, version, launchCwd, explicitResume, modelBoundLaunchResume, resumeProcessCwdRequired: true };
}

function statusSession(args) {
  const { path, session } = loadSession(required(args, 'session-file'));
  let bindingValid = true;
  let bindingError = null;
  try { validateBinding(session); } catch (error) {
    bindingValid = false;
    bindingError = error.message;
  }
  const processRows = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const sessionMarker = `sessions/${session.ticket}/${session.generation}/`;
  const processes = processRows.filter((line) => (
    (line.includes('cli-worker-session.mjs run') && line.includes(sessionMarker))
    || (line.includes('codex exec -C') && line.includes(session.worktree))
  )).map((line) => line.trim());
  return {
    schema: SESSION_SCHEMA,
    sessionFile: path,
    ticket: session.ticket,
    ownerId: session.ownerId,
    generation: session.generation,
    state: session.state,
    parentThreadId: session.parentThreadId,
    parentCwd: session.parentCwd,
    parentGeneration: session.parentGeneration ?? 1,
    codexSessionId: session.codexSessionId,
    requestedModel: session.requestedModel ?? null,
    modelReplacement: session.requestedModel !== TICKET_OWNER_MODEL
      ? { targetModel: TICKET_OWNER_MODEL, requiredBeforeNextTurn: true, idleCandidate: processes.length === 0 }
      : null,
    worktree: session.worktree,
    branch: session.branch,
    bindingValid,
    bindingError,
    processes,
    activeProcess: processes.length > 0,
    lastEvent: session.lastEvent ?? null,
    lastFailure: session.state === 'FAILED' ? session.lastFailure ?? null : null,
    lastRejectedCallback: session.lastRejectedCallback ?? null,
    callbackCorrection: session.callbackCorrection ?? null,
    replacementRequired: session.replacementRequired ?? null,
    updatedAt: session.updatedAt,
  };
}

function initialize(args) {
  const path = resolve(required(args, 'session-file'));
  const binding = inspectWorktree(realpathSync(required(args, 'worktree')));
  const cutoverCheckpoint = verifyCutoverCheckpoint(args['cutover-checkpoint'], binding);
  const generation = Number.parseInt(required(args, 'generation'), 10);
  if (!Number.isSafeInteger(generation) || generation < 1) fail('--generation must be a positive integer');
  const leaseTokenHash = required(args, 'lease-token-hash');
  if (!/^[a-f0-9]{64}$/.test(leaseTokenHash)) fail('--lease-token-hash must be a sha256 hex digest');
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
    ...binding,
    cutoverCheckpoint,
    transport: 'codex_exec',
    requestedModel: TICKET_OWNER_MODEL,
    codexSessionId: null,
    state: 'READY',
    acceptedEventIds: [],
    replacementOf: args['replacement-of'] ?? null,
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
  writeJsonPrivate(path, session, true);
  return session;
}

function findSessionId(stdout) {
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const value = JSON.parse(line);
      const candidate = value.thread_id ?? value.threadId ?? value.thread?.id ?? value.payload?.thread_id ?? value.payload?.threadId;
      if (typeof candidate === 'string' && candidate) return candidate;
    } catch {}
  }
  return null;
}

function parseCallback(message, session) {
  return parseBoundCallback(message, session);
}

function appendEvent(pathValue, event) {
  const path = resolve(pathValue);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Add the exact current callback binding and deterministic preflight to each fallback turn. */
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
    '',
    'Before emitting the final callback, write the callback to a private candidate file: the JSON object, with or without the leading `CL_SWEEP_EVENT v1 ` prefix (the validator accepts both), and nothing else.',
    `Run: node ${JSON.stringify(script)} validate-callback --session-file ${JSON.stringify(sessionPath)} --callback-file <candidate-file>`,
    'Do not emit the callback unless that command succeeds. Delete the candidate file afterward.',
    `Use these exact current binding fields: ${bindingJson}`,
    ...(session.featureOwnership ? [
      'Put the exact feature_ownership object shown above at callback payload.feature_ownership.',
    ] : []),
    `Keep parent_action at or below ${MAX_PARENT_ACTION_CHARS} characters and payload at or below ${MAX_PAYLOAD_BYTES} UTF-8 bytes.`,
    'Then emit the validated JSON on exactly one final line beginning `CL_SWEEP_EVENT v1 `, with no trailing prose.',
    '',
  ].join('\n');
}

function validateCallbackFile(args) {
  const { session } = loadSession(required(args, 'session-file'));
  validateBinding(session);
  const candidate = readFileSync(resolve(required(args, 'callback-file')), 'utf8').trim();
  const message = candidate.startsWith(EVENT_PREFIX) ? candidate : `${EVENT_PREFIX}${candidate}`;
  const event = parseCallback(message, session);
  return {
    valid: true,
    eventId: event.event_id,
    ticket: event.ticket,
    ownerGeneration: event.owner_generation,
    rootGeneration: event.root_generation ?? 1,
  };
}

function callbackRejectionEvent(session, message, error, exhausted) {
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
      : 'Run the one allowed callback-correction turn on this exact session, ticket generation, lease, and worktree; do not repeat implementation work.',
    worktree: session.worktree,
    payload: {
      ...(session.featureOwnership
        ? { feature_ownership: featureOwnershipMetadata(session.featureOwnership) }
        : {}),
      schema: 'CL_SWEEP_RUNTIME_FAILURE v1',
      runtime_generated: true,
      failure_kind: exhausted ? 'CALLBACK_CORRECTION_EXHAUSTED' : 'CALLBACK_CORRECTION_REQUIRED',
      failure: error.message,
      codex_session_id: session.codexSessionId,
      rejected_message_sha256: sha256(message),
      correction_attempts: session.callbackCorrection?.attempts ?? 1,
      correction_max_attempts: session.callbackCorrection?.maxAttempts ?? 1,
      correction_required: !exhausted,
      replacement_required: exhausted,
    },
  };
}

function rejectCompletedCallback(path, session, message, error, eventsFile) {
  const correction = session.callbackCorrection;
  const exhausted = correction?.status === 'in_progress' && correction.attempts >= 1;
  session.state = exhausted ? 'FAILED' : 'INTERRUPTED';
  session.lastFailure = error.message;
  session.lastRejectedCallback = {
    messageSha256: sha256(message),
    failure: error.message,
    rejectedAt: new Date().toISOString(),
  };
  session.callbackCorrection = exhausted ? {
    ...correction,
    status: 'exhausted',
    failure: error.message,
    exhaustedAt: new Date().toISOString(),
  } : {
    attempts: 0,
    maxAttempts: 1,
    status: 'required',
    requiredAt: new Date().toISOString(),
  };
  if (exhausted) {
    session.replacementRequired = {
      reason: 'CALLBACK_CORRECTION_EXHAUSTED',
      codexSessionId: session.codexSessionId,
      rejectedMessageSha256: sha256(message),
      failure: error.message,
      requiredAt: new Date().toISOString(),
    };
  }
  const event = callbackRejectionEvent(session, message, error, exhausted);
  assertNoRawSecrets(event);
  appendEvent(eventsFile, event);
  session.acceptedEventIds.push(event.event_id);
  session.lastEvent = event;
  session.lastMessageSha256 = sha256(message);
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
  return event;
}

function runCodexProcess(codex, commandArgs, worktree, prompt) {
  return new Promise((resolveResult) => {
    const stdoutHash = createHash('sha256');
    let stdoutPending = '';
    let stderr = '';
    let discoveredSessionId = null;
    let spawnError = null;
    let settled = false;
    const child = spawn(codex, commandArgs, {
      cwd: worktree,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const inspectLine = (line) => {
      discoveredSessionId ??= findSessionId(line);
    };
    child.stdout.on('data', (chunk) => {
      stdoutHash.update(chunk);
      stdoutPending += chunk.toString('utf8');
      let newline;
      while ((newline = stdoutPending.indexOf('\n')) !== -1) {
        inspectLine(stdoutPending.slice(0, newline));
        stdoutPending = stdoutPending.slice(newline + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1024 * 1024);
    });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      if (stdoutPending) inspectLine(stdoutPending);
      resolveResult({
        status,
        signal,
        error: spawnError,
        stderr,
        discoveredSessionId,
        stdoutSha256: stdoutHash.digest('hex'),
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

async function runTurn(args) {
  const { path, session } = loadSession(required(args, 'session-file'));
  if (['RUNNING', 'REPLACED', 'TERMINAL'].includes(session.state)) fail(`Session cannot run from state ${session.state}`);
  if (session.callbackCorrection?.status === 'exhausted') {
    fail('Malformed-callback correction budget is exhausted; replace by policy');
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
  if (session.requestedModel !== TICKET_OWNER_MODEL) {
    fail(`Persisted ${session.requestedModel} worker requires idle-boundary replacement with a new ${TICKET_OWNER_MODEL} session before another turn`);
  }
  probe({ codex: args.codex });
  const prompt = guardedWorkerPrompt(
    readFileSync(resolve(required(args, 'prompt-file')), 'utf8'),
    session,
    path,
  );
  const output = resolve(dirname(path), `last-message-${Date.now()}-${process.pid}.txt`);
  const codex = args.codex ?? 'codex';
  const launch = !session.codexSessionId;
  const commandArgs = launch
    ? ['exec', '-C', session.worktree, '-m', session.requestedModel, '--json', '-o', output, '-']
    : ['exec', 'resume', '-m', session.requestedModel, '--json', '-o', output, session.codexSessionId, '-'];
  session.state = 'RUNNING';
  delete session.lastFailure;
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
  const result = await runCodexProcess(codex, commandArgs, session.worktree, prompt);
  if (result.status !== 0 || !existsSync(output)) {
    session.state = 'FAILED';
    session.updatedAt = new Date().toISOString();
    session.lastFailure = result.error?.message || result.stderr?.trim()
      || (result.signal ? `Codex terminated by ${result.signal}` : `Codex exited ${result.status}`);
    writeJsonPrivate(path, session);
    fail(session.lastFailure);
  }
  chmodSync(output, 0o600);
  try {
    const discoveredSessionId = result.discoveredSessionId;
    if (launch && !discoveredSessionId) fail('Codex launch did not report a session id');
    if (launch) session.codexSessionId = discoveredSessionId;
    if (!launch && discoveredSessionId && discoveredSessionId !== session.codexSessionId) fail('Codex resumed a different session id');
    const message = readFileSync(output, 'utf8');
    const event = parseCallback(message, session);
    appendEvent(required(args, 'events-file'), event);
    session.acceptedEventIds.push(event.event_id);
    session.lastEvent = event;
    session.lastMessageSha256 = sha256(message);
    session.state = event.kind === 'TERMINAL' ? 'TERMINAL' : 'WAITING';
    if (session.callbackCorrection?.status === 'in_progress') {
      session.callbackCorrection = {
        ...session.callbackCorrection,
        status: 'corrected',
        correctedAt: new Date().toISOString(),
      };
      delete session.replacementRequired;
    }
    session.updatedAt = new Date().toISOString();
    writeJsonPrivate(path, session);
    return {
      schema: SESSION_SCHEMA,
      launch,
      codexSessionId: session.codexSessionId,
      worktree: session.worktree,
      event,
      transportStdoutSha256: result.stdoutSha256,
    };
  } catch (error) {
    const message = existsSync(output) ? readFileSync(output, 'utf8') : '';
    const event = rejectCompletedCallback(
      path, session, message, error, resolve(required(args, 'events-file')),
    );
    return {
      schema: SESSION_SCHEMA,
      launch,
      codexSessionId: session.codexSessionId,
      worktree: session.worktree,
      event,
      runtimeGenerated: true,
      transportStdoutSha256: result.stdoutSha256,
    };
  }
}

function replaceSession(args) {
  const prior = loadSession(required(args, 'session-file'));
  if (prior.session.state === 'RUNNING') fail('Cannot replace a running worker session');
  validateWorktreeBinding(prior.session);
  const generation = Number.parseInt(required(args, 'generation'), 10);
  if (generation !== prior.session.generation + 1) fail('Replacement generation must increment by exactly one');
  if (prior.session.featureOwnership && (!args['feature-manifest'] || !args['ownership-ledger'])) {
    fail('Replacing a feature-owned session requires the next --feature-manifest and --ownership-ledger');
  }
  const replacement = initialize({
    ...args,
    'session-file': required(args, 'output'),
    worktree: prior.session.worktree,
    ticket: prior.session.ticket,
    'parent-thread-id': prior.session.parentThreadId,
    'parent-cwd': prior.session.parentCwd,
    'root-generation': String(prior.session.parentGeneration ?? 1),
    'replacement-of': `${prior.session.ownerId}:${prior.session.generation}`,
  });
  prior.session.state = 'REPLACED';
  prior.session.replacedBy = required(args, 'owner-id');
  prior.session.replacementReason = required(args, 'reason');
  prior.session.updatedAt = new Date().toISOString();
  writeJsonPrivate(prior.path, prior.session);
  return replacement;
}

/** Rebind an inactive compatibility worker to the next sweep-root generation. */
function rebindParent(args) {
  const { path, session } = loadSession(required(args, 'session-file'));
  validateBinding(session);
  const currentStatus = statusSession({ 'session-file': path });
  if (session.state === 'RUNNING' || currentStatus.activeProcess) {
    fail('Cannot rebind a running worker session');
  }
  const expectedGeneration = Number.parseInt(required(args, 'expected-root-generation'), 10);
  const expectedCwd = realpathSync(resolve(required(args, 'expected-parent-cwd')));
  if (
    session.parentThreadId !== required(args, 'expected-parent-thread-id') ||
    session.parentCwd !== expectedCwd ||
    (session.parentGeneration ?? 1) !== expectedGeneration
  ) {
    fail('Worker parent binding does not match the expected root generation');
  }
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
  session.updatedAt = new Date().toISOString();
  writeJsonPrivate(path, session);
  return {
    ticket: session.ticket,
    codexSessionId: session.codexSessionId,
    ticketOwnerGeneration: session.generation,
    parentThreadId: session.parentThreadId,
    parentCwd: session.parentCwd,
    parentGeneration: session.parentGeneration,
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.command === 'probe') result = probe(args);
  else if (args.command === 'status') result = statusSession(args);
  else if (args.command === 'init') result = initialize(args);
  else if (args.command === 'run') result = await runTurn(args);
  else if (args.command === 'validate-callback') result = validateCallbackFile(args);
  else if (args.command === 'replace') result = replaceSession(args);
  else if (args.command === 'rebind-parent') result = rebindParent(args);
  else fail('Usage: cli-worker-session.mjs <probe|status|init|run|validate-callback|replace|rebind-parent> [options]');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${error.stderr?.toString().trim() || error.message}\n`);
  process.exitCode = 1;
}
