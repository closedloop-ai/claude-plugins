#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';

const OPEN = 1;
const CLOSED = 3;

/** Encode one masked client WebSocket frame. */
export function encodeWebSocketFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

/** Decode all complete WebSocket frames and return any partial suffix. */
export function decodeWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const wideLength = buffer.readBigUInt64BE(offset + 2);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame is too large');
      length = Number(wideLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (buffer.length - offset < headerLength + maskLength + length) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const payloadOffset = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ fin: Boolean(first & 0x80), opcode: first & 0x0f, payload });
    offset = payloadOffset + length;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

/** Minimal event emitter used by the transport without external dependencies. */
class EventSource {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return this;
  }

  once(event, handler) {
    const wrapped = (...args) => {
      this.listeners.get(event)?.delete(wrapped);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    for (const handler of this.listeners.get(event) || []) handler(...args);
  }
}

/** WebSocket framing over a duplex stream, used for proxy and direct Unix socket connections. */
class StreamWebSocket extends EventSource {
  static OPEN = OPEN;

  constructor() {
    super();
    this.readyState = 0;
    this.buffer = Buffer.alloc(0);
    this.handshakeComplete = false;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.key = randomBytes(16).toString('base64');
    this.reader = null;
    this.writer = null;
  }

  attach(reader, writer) {
    this.reader = reader;
    this.writer = writer;
    reader.on('data', (chunk) => this.receiveBytes(chunk));
    reader.on('error', (error) => this.emit('error', error));
    reader.on('close', () => {
      this.readyState = CLOSED;
      this.emit('close');
    });
    writer.on('error', (error) => this.emit('error', error));
  }

  beginHandshake() {
    this.writer.write([
      'GET /rpc HTTP/1.1',
      'Host: localhost',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  }

  receiveBytes(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.handshakeComplete) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const headers = this.buffer.subarray(0, boundary).toString('utf8');
      this.buffer = this.buffer.subarray(boundary + 4);
      const expectedAccept = createHash('sha1')
        .update(`${this.key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
      const escapedAccept = expectedAccept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!/^HTTP\/1\.1 101\b/m.test(headers)
        || !new RegExp(`^Sec-WebSocket-Accept:\\s*${escapedAccept}\\s*$`, 'im').test(headers)) {
        this.emit('error', new Error(`App Server rejected the WebSocket upgrade: ${headers.split('\r\n')[0] || 'empty response'}`));
        this.close();
        return;
      }
      this.handshakeComplete = true;
      this.readyState = OPEN;
      this.emit('open');
    }
    this.readFrames();
  }

  readFrames() {
    const decoded = decodeWebSocketFrames(this.buffer);
    this.buffer = decoded.remainder;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x1 && !frame.fin) {
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
      } else if (frame.opcode === 0x0 && this.fragmentOpcode !== null) {
        this.fragments.push(frame.payload);
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments);
          const opcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragments = [];
          if (opcode === 0x1) this.emit('message', payload);
        }
      } else if (frame.opcode === 0x1) {
        this.emit('message', frame.payload);
      } else if (frame.opcode === 0x8) {
        this.close();
      } else if (frame.opcode === 0x9 && this.readyState === OPEN) {
        this.writer.write(encodeWebSocketFrame(frame.payload, 0xA));
      }
    }
  }

  send(value) {
    if (this.readyState !== OPEN) throw new Error('The App Server connection is not open');
    this.writer.write(encodeWebSocketFrame(value));
  }

  close() {
    if (this.readyState === OPEN) {
      try { this.writer.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8)); } catch {}
    }
    this.readyState = 2;
    this.writer?.end();
  }
}

/** WebSocket stream carried by `codex app-server proxy` to the managed daemon socket. */
export class ProxyWebSocket extends StreamWebSocket {
  constructor(codex, socketPath) {
    super();
    this.stderr = '';
    this.child = spawn(codex, ['app-server', 'proxy', '--sock', socketPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.child.on('error', (error) => this.emit('error', error));
    this.child.on('close', (code) => {
      if (!this.handshakeComplete) {
        this.emit('error', new Error(this.stderr.trim() || `Codex App Server proxy exited ${code} before opening`));
      }
    });
    this.attach(this.child.stdout, this.child.stdin);
    this.beginHandshake();
  }

  close() {
    super.close();
    this.child.kill();
  }
}

/** Direct WebSocket over the daemon's Unix socket for compatible Desktop runtimes. */
export class DirectWebSocket extends StreamWebSocket {
  constructor(socketPath) {
    super();
    this.stream = createConnection(socketPath);
    this.attach(this.stream, this.stream);
    this.stream.once('connect', () => this.beginHandshake());
  }

  close() {
    super.close();
    this.stream.destroy();
  }
}

/** Return managed daemon metadata, starting the shared daemon idempotently when requested. */
export function managedDaemon({ codex = 'codex', start = true } = {}) {
  const command = start ? 'start' : 'version';
  const raw = execFileSync(codex, ['app-server', 'daemon', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const metadata = JSON.parse(raw);
  if (!['running', 'alreadyRunning', 'started'].includes(metadata.status) || !metadata.socketPath) {
    throw new Error(`Managed App Server daemon is not running (${metadata.status || 'unknown'})`);
  }
  const socketPath = realpathSync(metadata.socketPath);
  if (!statSync(socketPath).isSocket()) throw new Error('Managed App Server path is not a Unix socket');
  return { ...metadata, socketPath };
}

/** JSON-RPC client for the managed native Codex App Server. Interactive server requests are fail-closed. */
export class AppServerClient {
  constructor({ transport = 'proxy', codex = 'codex', socket, requestPrefix = 'gh-monitor-pr' }) {
    if (!socket) throw new Error('App Server socket is required');
    if (!['proxy', 'direct', 'desktop'].includes(transport)) {
      throw new Error('transport must be proxy, direct, or desktop');
    }
    this.socket = transport === 'proxy'
      ? new ProxyWebSocket(codex, socket)
      : new DirectWebSocket(socket);
    this.WebSocket = this.socket.constructor;
    this.requestPrefix = requestPrefix;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.connectionHandlers = new Set();
    this.connected = new Promise((resolvePromise, reject) => {
      this.socket.once('open', resolvePromise);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data) => this.receive(data.toString('utf8')));
    this.socket.on('error', (error) => {
      this.rejectAll(error);
      this.emitConnection('error', error);
    });
    this.socket.on('close', () => {
      const error = new Error('The managed App Server connection closed');
      this.rejectAll(error);
      this.emitConnection('close', error);
    });
  }

  async connect() {
    await this.connected;
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** Send one JSON-RPC request with a bounded timeout. */
  request(method, params, timeoutMs = 60_000) {
    const id = `${this.requestPrefix}-${this.nextId++}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (Object.hasOwn(message, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        const error = new Error(`${message.error.message || 'App Server request failed'} (${message.error.code ?? 'unknown'})`);
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (Object.hasOwn(message, 'id') && message.method) {
      this.send({
        id: message.id,
        error: { code: -32603, message: 'Interactive server requests are disabled for detached orchestration' },
      });
      return;
    }
    if (message.method) {
      for (const handler of this.notificationHandlers) handler(message.method, message.params || {});
    }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onConnection(handler) {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  emitConnection(state, error) {
    for (const handler of this.connectionHandlers) handler(state, error);
  }

  close() {
    this.socket?.close();
  }
}

/** Initialize a connected client with the App Server protocol handshake. */
export async function initializeClient(client, {
  name = 'gh_monitor_pr',
  title = 'GitHub PR Monitor',
  version = '1.0.0',
} = {}) {
  await client.connect();
  await client.request('initialize', {
    clientInfo: { name, title, version },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: ['item/agentMessage/delta'],
    },
  });
  client.notify('initialized');
}

function requestTimeoutMs(options) {
  const raw = typeof options.timeoutMs === 'function' ? options.timeoutMs() : options.timeoutMs;
  return Number.isFinite(raw) ? Math.max(1, raw) : undefined;
}

function requestWithOptionalTimeout(client, method, params, options) {
  const timeoutMs = requestTimeoutMs(options);
  return timeoutMs == null ? client.request(method, params) : client.request(method, params, timeoutMs);
}

/** Read live thread state, including the exact active turn and direct-input capability. */
export async function readThreadState(client, threadId, options = {}) {
  const readResult = await requestWithOptionalTimeout(client, 'thread/read', {
    threadId,
    includeTurns: false,
  }, options);
  const thread = readResult?.thread;
  if (thread?.id !== threadId) {
    throw new Error(`App Server returned thread ${thread?.id || 'missing'} instead of ${threadId}`);
  }
  const status = thread?.status?.type || null;
  if (status === 'systemError') throw new Error('The App Server thread is in a system-error state');
  if (!['idle', 'notLoaded', 'active'].includes(status)) {
    throw new Error(`Unexpected App Server thread status: ${status || 'missing'}`);
  }
  let activeTurnId = null;
  if (status === 'active') {
    let turns = [];
    try {
      const listed = await requestWithOptionalTimeout(client, 'thread/turns/list', {
        threadId,
        limit: 10,
        sortDirection: 'desc',
        itemsView: 'notLoaded',
      }, options);
      turns = listed?.data || [];
    } catch {
      const full = await requestWithOptionalTimeout(client, 'thread/read', {
        threadId,
        includeTurns: true,
      }, options);
      turns = full?.thread?.turns || [];
    }
    activeTurnId = turns.find((turn) => turn.status === 'inProgress')?.id || null;
    if (!activeTurnId) throw new Error('Active App Server thread has no discoverable in-progress turn');
  }
  return {
    status,
    activeTurnId,
    cwd: thread?.cwd || null,
    canAcceptDirectInput: thread?.canAcceptDirectInput !== false,
    activeFlags: thread?.activeFlags || [],
  };
}

/** Return true when a state-aware send should retry after a concurrent state transition. */
export function isThreadStateRace(error) {
  return /already has an active writer|no active turn|active turn.*(?:changed|does not match|not steerable)|expectedTurnId|currently active regular turn/i.test(error?.message || '');
}

function isResumeTimeout(error) {
  return /^thread\/resume timed out$/i.test(error?.message || '');
}

function remainingTimeoutMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

/**
 * Deliver input exactly once: steer the current turn when possible, otherwise resume and start an idle turn.
 */
export async function sendInput(client, options, input, retryDelayMs = 100) {
  const deadline = Date.now() + (options.waitSeconds ?? 30) * 1_000;
  let lastState = null;
  let resumeTimedOut = false;
  const timeoutMs = () => remainingTimeoutMs(deadline);
  while (Date.now() < deadline) {
    const state = await readThreadState(client, options.threadId, { timeoutMs });
    lastState = state.status;
    if (state.cwd && realpathSync(state.cwd) !== realpathSync(options.cwd)) {
      throw new Error('App Server thread cwd does not match the requested cwd');
    }
    if (state.status === 'active' && state.canAcceptDirectInput) {
      try {
        const result = await client.request('turn/steer', {
          threadId: options.threadId,
          expectedTurnId: state.activeTurnId,
          input,
        }, timeoutMs());
        if (result?.turnId !== state.activeTurnId) throw new Error('App Server steered a different turn');
        return { status: 'accepted', mode: 'steer', turnId: result.turnId };
      } catch (error) {
        if (!isThreadStateRace(error)) throw error;
        await delay(retryDelayMs);
        continue;
      }
    }
    if (state.status === 'active') {
      await delay(retryDelayMs);
      continue;
    }
    if (!resumeTimedOut || state.status === 'notLoaded') {
      try {
        const resumed = await client.request('thread/resume', {
          threadId: options.threadId,
          cwd: options.cwd,
          ...(options.threadOptions || {}),
        }, timeoutMs());
        resumeTimedOut = false;
        if (resumed?.thread?.id !== options.threadId) throw new Error('App Server resumed a different thread');
        if (!resumed.thread.cwd || realpathSync(resumed.thread.cwd) !== realpathSync(options.cwd)) {
          throw new Error('App Server resumed the thread with a different cwd');
        }
      } catch (error) {
        if (isResumeTimeout(error)) {
          resumeTimedOut = true;
          await delay(retryDelayMs);
          continue;
        }
        if (state.status === 'notLoaded' && /already has an active writer/i.test(error.message)) {
          throw new Error('The target thread has an active writer outside this managed App Server daemon');
        }
        if (!isThreadStateRace(error)) throw error;
        await delay(retryDelayMs);
        continue;
      }
    }
    try {
      const result = await client.request('turn/start', {
        threadId: options.threadId,
        input,
        cwd: options.cwd,
        ...(options.turnOptions || {}),
      }, timeoutMs());
      const turnId = result?.turn?.id;
      if (!turnId) throw new Error('App Server did not return a turn identifier');
      return { status: 'accepted', mode: 'start', turnId };
    } catch (error) {
      if (!isThreadStateRace(error)) throw error;
      await delay(retryDelayMs);
    }
  }
  throw new Error(`App Server thread did not stabilize; last observed state was ${lastState || 'unknown'}`);
}
