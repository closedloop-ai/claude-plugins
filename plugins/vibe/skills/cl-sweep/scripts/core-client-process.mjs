import { execFileSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCOVERY_TOTAL_TIMEOUT_MS } from './resolve-core-skill.mjs';

const PROCESS_API = 'CLOSEDLOOP_APP_SERVER_CLIENT v1';
const resolver = fileURLToPath(new URL('./resolve-core-skill.mjs', import.meta.url));
const bindings = new Map();

/** Resolve the named, enabled core skill through its runtime, never a sibling plugin path. */
export function coreSkillDirectory(options = {}) {
  const key = JSON.stringify([options.runtime || '', options.codex || 'codex', options.claude || 'claude', process.cwd()]);
  if (!bindings.has(key)) {
    const raw = execFileSync(process.execPath, [resolver], {
      input: JSON.stringify(options), encoding: 'utf8', timeout: DISCOVERY_TOTAL_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw);
    if (result.protocol !== PROCESS_API || !result.skillDirectory) throw new Error('Core skill discovery returned an incompatible binding');
    if (bindings.size >= 16) bindings.clear();
    bindings.set(key, result.skillDirectory);
  }
  return bindings.get(key);
}

/** Resolve a public script declared by the loaded gh-monitor-pr skill. */
export function monitorScript(options = {}) {
  return resolve(coreSkillDirectory(options), 'scripts/monitor-pr.mjs');
}

function apiScript(options) {
  return resolve(coreSkillDirectory(options), 'scripts/client-process-api.mjs');
}

function errorFrom(value) {
  const error = new Error(value.message);
  if (value.code != null) error.code = value.code;
  return error;
}

function callOnce(operation, payload, options = {}) {
  const result = JSON.parse(execFileSync(process.execPath, [apiScript(options)], {
    input: JSON.stringify({ protocol: PROCESS_API, operation, ...payload }), encoding: 'utf8',
    timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  if (result.protocol !== PROCESS_API) throw new Error('Update closedloop-core: incompatible client process API');
  if (result.error) throw errorFrom(result.error);
  return result.result;
}

/** Preserve the synchronous daemon operation through the core public process API. */
export function managedDaemon(options = {}) {
  return callOnce('daemon', { options }, options);
}

/** Decode fixture frames through the sole core implementation, without importing it. */
export function decodeWebSocketFrames(buffer, options = {}) {
  const decoded = callOnce('decodeFrames', { buffer: buffer.toString('base64') }, options);
  return {
    frames: decoded.frames.map(frame => ({ ...frame, payload: Buffer.from(frame.payload, 'base64') })),
    remainder: Buffer.from(decoded.remainder, 'base64'),
  };
}

/** Thin process adapter: core owns WebSocket, daemon, JSON-RPC, and thread-state mechanics. */
export class AppServerClient {
  constructor(options, delegate = null) {
    this.delegate = delegate;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.connectionHandlers = new Set();
    this.nextId = 1;
    this.closed = false;
    this.child = spawn(process.execPath, [apiScript(options), 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.ready = new Promise((accept, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Core client startup timed out')), 30_000);
      this.acceptReady = () => { clearTimeout(timer); accept(); };
      this.rejectReady = error => { clearTimeout(timer); reject(error); };
    });
    this.ready.catch(() => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) return this.fail(new Error('Core client response exceeded the pipe limit'));
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error); }
      }
    });
    // Child diagnostics are not persisted or echoed; payloads stay on private pipes.
    this.child.stderr.resume();
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('close', () => {
      if (!this.closed) this.fail(new Error('The core client process closed'), 'close');
    });
    this.connected = this.ready.then(() => this.operation(delegate ? 'delegate' : 'connect', { options }));
    this.connected.catch(() => {});
  }

  async connect() { await this.connected; }

  operation(operation, payload = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error('The core client process is closed'));
    const id = this.nextId++;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${payload.method || operation} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); accept(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ protocol: PROCESS_API, id, operation, ...payload })}\n`, error => {
        if (error) this.fail(error);
      });
    });
  }

  request(method, params, timeoutMs = 60_000) {
    return this.operation('request', { method, params, timeoutMs }, timeoutMs);
  }

  notify(method, params = {}) {
    this.operation('notify', { method, params }).catch(error => this.fail(error));
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onConnection(handler) {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  receive(message) {
    if (message.protocol !== PROCESS_API) throw new Error('Update closedloop-core: incompatible client process API');
    if (message.event === 'ready') return this.acceptReady();
    if (message.event === 'callback') {
      Promise.resolve().then(() => this.delegate[message.method](...message.args)).then(
        result => this.child.stdin.write(`${JSON.stringify({ protocol: PROCESS_API, callbackId: message.callbackId, result: result ?? null })}\n`),
        error => this.child.stdin.write(`${JSON.stringify({ protocol: PROCESS_API, callbackId: message.callbackId, error: { message: error.message, code: error.code } })}\n`),
      );
      return;
    }
    if (message.event === 'notification') {
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    } else if (message.event === 'connection') {
      for (const handler of this.connectionHandlers) handler(message.state, errorFrom(message.error));
      this.rejectAll(errorFrom(message.error));
    } else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(errorFrom(message.error));
      else pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  fail(error, state = 'error') {
    if (this.closed) return;
    this.rejectReady(error);
    this.rejectAll(error);
    for (const handler of this.connectionHandlers) handler(state, error);
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(new Error('The core client process is closed'));
    this.rejectAll(new Error('The core client process is closed'));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
    this.notificationHandlers.clear();
    this.connectionHandlers.clear();
  }
}

/** Initialize the core-owned connection with the original protocol handshake. */
export async function initializeClient(client, options = {}) {
  if (!(client instanceof AppServerClient)) return delegatedOperation(client, 'initialize', { options });
  await client.connect();
  return client.operation('initialize', { options });
}

/** Forward live thread reads; a shrinking deadline stays a deadline inside core. */
export function readThreadState(client, threadId, options = {}) {
  const forwarded = typeof options.timeoutMs === 'function'
    ? { deadline: Date.now() + options.timeoutMs() }
    : options;
  const payload = { threadId, options: forwarded };
  // The native helper may perform three separately bounded RPCs; a deadline remains one deadline.
  const timeoutMs = threadReadBudget(forwarded);
  if (!(client instanceof AppServerClient)) return delegatedOperation(client, 'readThreadState', payload, timeoutMs);
  return client.operation('readThreadState', payload, timeoutMs);
}

/** Preserve exactly-once state-aware input delivery in core, not in this adapter. */
export function sendInput(client, options, input, retryDelayMs = 100) {
  const timeoutMs = (options.waitSeconds ?? 30) * 1000 + Math.max(1000, retryDelayMs);
  if (!(client instanceof AppServerClient)) return delegatedOperation(client, 'sendInput', { options, input, retryDelayMs }, timeoutMs);
  return client.operation('sendInput', { options, input, retryDelayMs }, timeoutMs);
}

async function delegatedOperation(client, operation, payload, timeoutMs = 61_000) {
  const adapter = new AppServerClient({}, client);
  try {
    await adapter.connect();
    return await adapter.operation(operation, payload, timeoutMs);
  } finally { adapter.close(); }
}

function threadReadBudget(options) {
  if (options.deadline != null) return Math.max(1, options.deadline - Date.now()) + 1000;
  const requestBudget = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 60_000;
  return requestBudget * 3 + 1000;
}
