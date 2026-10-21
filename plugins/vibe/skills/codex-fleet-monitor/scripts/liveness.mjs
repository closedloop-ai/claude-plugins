// Usage: node liveness.mjs <stateDir> <session>...
// A session is "<name>" (reads <stateDir>/<name>.json, which holds a threadId) or "<label>=<threadId>".
// Prints "<label> <lastTurnStatus> <progress> <flag>"; progress is the id of the last turn's newest item (it
// changes while the turn works), flag is LIMIT, TRANSIENT, SYSTEM-ERROR, ERROR, READFAIL or -.
// It never loads a thread's history: a long thread's full read is tens of MB of JSON.
// Self-contained: speaks the Codex App Server protocol to the managed daemon through
// `codex app-server proxy`, so a single file is all a remote host needs.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const REQUEST_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 120_000;

export function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  else if (body.length <= 0xffff) {
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
  const masked = Buffer.from(body);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const maskLength = second & 0x80 ? 4 : 0;
    if (buffer.length - offset < headerLength + maskLength + length) break;
    const start = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(start, start + length));
    if (maskLength) {
      const mask = buffer.subarray(offset + headerLength, start);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin: Boolean(first & 0x80), opcode: first & 0x0f, payload });
    offset = start + length;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

/** JSON-RPC requests and replies; a subclass frames messages in `send` and feeds replies to `handleMessage`. */
class JsonRpcClient {
  constructor() {
    this.pending = new Map();
    this.nextId = 1;
    this.failure = null;
    this.connected = new Promise((resolve, reject) => {
      this.onOpen = resolve;
      this.fail = (error) => {
        this.failure ??= error;
        reject(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
      };
    });
    this.connected.catch(() => {});
  }

  handleMessage(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message || 'App Server request failed'));
      else pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      this.send({ id: message.id, error: { code: -32603, message: 'Server requests are not supported' } });
    }
  }

  /** The timeout also covers the connection, so a daemon that never completes the upgrade cannot hang a caller. */
  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = `fleet-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      const settle = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.connected.then(() => {
        if (this.failure) return settle.reject(this.failure);
        this.pending.set(id, settle);
        this.send({ id, method, params });
      }, settle.reject);
    });
  }

  async initialize(timeoutMs = REQUEST_TIMEOUT_MS) {
    await this.request('initialize', {
      clientInfo: { name: 'fleet-liveness', title: 'Fleet liveness', version: '1.0.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['item/agentMessage/delta'] },
    }, timeoutMs);
    this.send({ method: 'initialized', params: {} });
  }
}

/** JSON-RPC over a WebSocket carried on a duplex byte stream (reader/writer). */
export class AppServerClient extends JsonRpcClient {
  constructor(reader, writer, { onClose = () => {} } = {}) {
    super();
    this.writer = writer;
    this.buffer = Buffer.alloc(0);
    this.open = false;
    this.fragments = [];
    this.key = randomBytes(16).toString('base64');
    reader.on('data', (chunk) => this.receive(chunk));
    reader.on('error', (error) => this.fail(error));
    reader.on('close', () => { this.fail(new Error('App Server connection closed')); onClose(); });
    writer.on('error', (error) => this.fail(error));
    writer.write([
      'GET /rpc HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${this.key}`, 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.open) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const head = this.buffer.subarray(0, boundary).toString('utf8');
      this.buffer = this.buffer.subarray(boundary + 4);
      const accept = createHash('sha1').update(this.key + WS_GUID).digest('base64');
      if (!/^HTTP\/1\.1 101\b/.test(head) || !head.includes(accept)) {
        this.fail(new Error(`WebSocket upgrade rejected: ${head.split('\r\n')[0] || 'empty response'}`));
        return;
      }
      this.open = true;
      this.onOpen();
    }
    const { frames, remainder } = decodeFrames(this.buffer);
    this.buffer = remainder;
    for (const frame of frames) this.handleFrame(frame);
  }

  handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x9) this.writer.write(encodeFrame(payload, 0xa));
    else if (opcode === 0x8) this.fail(new Error('App Server closed the connection'));
    else if (opcode === 0x1 || opcode === 0x0) {
      this.fragments.push(payload);
      if (!fin) return;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.handleMessage(text);
    }
  }

  send(message) { this.writer.write(encodeFrame(JSON.stringify(message))); }

  close() {
    try { this.writer.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch {}
    this.writer.end?.();
  }
}

/** JSON-RPC as one JSON object per line, the framing of `codex app-server` on stdio. */
export class LineClient extends JsonRpcClient {
  constructor(reader, writer) {
    super();
    this.writer = writer;
    this.buffer = '';
    reader.setEncoding?.('utf8');
    reader.on('data', (chunk) => this.receive(chunk));
    reader.on('error', (error) => this.fail(error));
    reader.on('close', () => this.fail(new Error('The App Server exited before it answered')));
    writer.on('error', () => this.fail(new Error('The App Server closed its input before it answered')));
    this.onOpen();
  }

  receive(chunk) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      this.handleMessage(line);
      boundary = this.buffer.indexOf('\n');
    }
  }

  send(message) { this.writer.write(`${JSON.stringify(message)}\n`); }

  close() { this.writer.end?.(); }
}

/** Connect through `codex app-server proxy --sock <socket>`, which bridges stdio to the daemon. */
export function connectViaProxy(socket, codex = 'codex') {
  const child = spawn(codex, ['app-server', 'proxy', '--sock', socket], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => {});
  const client = new AppServerClient(child.stdout, child.stdin);
  const close = client.close.bind(client);
  client.close = () => { close(); child.kill(); };
  return client;
}

/** Start a private `codex app-server` on stdio; it needs no daemon and leaves nothing running. */
export function connectStdio(codex = 'codex') {
  const child = spawn(codex, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const client = new LineClient(child.stdout, child.stdin);
  child.on('error', (error) => client.fail(new Error(`Could not start ${codex}: ${error.message}`)));
  const close = client.close.bind(client);
  client.close = () => { close(); child.kill(); };
  return client;
}

/** Connect straight to a Unix socket that already speaks WebSocket. */
export function connectDirect(socket) {
  const stream = createConnection(socket);
  return new AppServerClient(stream, stream);
}

export function daemonSocket(codex = 'codex') {
  const fallback = `${homedir()}/.codex/app-server-control/app-server-control.sock`;
  try {
    const started = execFileSync(codex, ['app-server', 'daemon', 'start'], { encoding: 'utf8', timeout: 30_000 });
    return JSON.parse(started).socketPath ?? fallback;
  } catch {
    return fallback;
  }
}

export function parseSession(spec, dir) {
  const eq = spec.indexOf('=');
  if (eq > 0) return { label: spec.slice(0, eq), threadId: spec.slice(eq + 1) };
  return { label: spec, threadId: JSON.parse(readFileSync(`${dir}/${spec}.json`, 'utf8')).threadId };
}

/** The default turn and progress read a full thread (`includeTurns`), as fleet-orchestrator's `last` does. */
export function summarize(label, thread, turn = (thread?.turns ?? []).at(-1), progress = String((turn?.items ?? []).length)) {
  let flag = '-';
  if (thread?.status?.type === 'systemError') flag = Failure.SystemError;
  else if (turn?.error) flag = classifyTurnError(turn.error);
  return `${label} ${turn?.status ?? 'none'} ${progress} ${flag}`;
}

const UNKNOWN_METHOD = /unknown variant|method not found/i;

/**
 * A thread's status and last turn without its history: `thread/read` without turns, then `thread/turns/list`
 * for the newest turn with no items. With `progress`, also the id of that turn's newest item (`-` when it
 * has none). An App Server too old for `thread/turns/list` gets the full read, and the item count as progress.
 */
export async function readThreadState(client, threadId, { progress = false } = {}) {
  const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
  let turns;
  try {
    turns = await client.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
  } catch (error) {
    if (!UNKNOWN_METHOD.test(error.message)) throw error;
    const full = (await client.request('thread/read', { threadId, includeTurns: true })).thread;
    const turn = (full?.turns ?? []).at(-1) ?? null;
    return { thread, turn, progress: String((turn?.items ?? []).length) };
  }
  const turn = turns?.data?.[0] ?? null;
  if (!progress || !turn) return { thread, turn, progress: '-' };
  const items = await client.request('thread/items/list', { threadId, turnId: turn.id, limit: 1, sortDirection: 'desc' });
  return { thread, turn, progress: items?.data?.[0]?.item?.id ?? '-' };
}

export async function readSessions(client, dir, specs) {
  const lines = [];
  for (const spec of specs) {
    let label = spec.split('=')[0];
    try {
      const session = parseSession(spec, dir);
      label = session.label;
      const { thread, turn, progress } = await readThreadState(client, session.threadId, { progress: true });
      lines.push(summarize(label, thread, turn, progress));
    } catch {
      lines.push(`${label} unreadable 0 READFAIL`);
    }
  }
  return lines;
}

async function main() {
  exitAfterTotalTimeout();
  const [dir, ...specs] = process.argv.slice(2);
  const client = connectViaProxy(daemonSocket());
  try {
    await client.initialize();
  } catch {
    for (const spec of specs) console.log(`${spec.split('=')[0]} unreadable 0 READFAIL`);
    process.exit(0);
  }
  for (const line of await readSessions(client, dir, specs)) console.log(line);
  client.close();
  process.exit(0);
}

if (isEntryPoint(import.meta.url)) await main();

/** Bounds the whole run from inside node; macOS has no `timeout` or `gtimeout` command. */
export function exitAfterTotalTimeout() {
  setTimeout(() => process.exit(1), TOTAL_TIMEOUT_MS).unref();
}

/** Compare real paths: a symlinked directory (macOS /tmp) makes argv[1] differ from the module url. */
export function isEntryPoint(moduleUrl) {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
}

/** The flag a failed turn or thread gets; recover.mjs acts on TRANSIENT and SYSTEM-ERROR. */
export const Failure = Object.freeze({
  Limit: 'LIMIT',
  Transient: 'TRANSIENT',
  SystemError: 'SYSTEM-ERROR',
  Error: 'ERROR',
});

const TRANSIENT_ERROR_CODES = new Set(['serverOverloaded', 'rateLimitExceeded', 'internalServerError']);
const HTTP_ERROR_CODES = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'];
const TRANSIENT_MESSAGE = /at capacity|overloaded|rate.?limit|too many requests|temporarily unavailable|internal server error|bad gateway|service unavailable|gateway timeout|(?:status|http|error)[ :=]*5\d\d\b/;
const USAGE_MESSAGE = /usage|quota/;
const LIMIT_MESSAGE = /limit/;

/**
 * Classifies a turn error by its codexErrorInfo, falling back to the message. Provider capacity, rate
 * limits, 5xx and dropped connections are TRANSIENT; a usage limit stays LIMIT, since only a reset clears it.
 */
export function classifyTurnError(error) {
  const info = error?.codexErrorInfo;
  if (info === 'usageLimitExceeded') return Failure.Limit;
  if (TRANSIENT_ERROR_CODES.has(info)) return Failure.Transient;
  const http = info && typeof info === 'object' ? HTTP_ERROR_CODES.find((code) => code in info) : undefined;
  if (http) {
    const status = info[http]?.httpStatusCode;
    return status == null || status === 429 || status >= 500 ? Failure.Transient : Failure.Error;
  }
  if (info && info !== 'other') return Failure.Error;
  const text = (typeof error === 'string' ? error : `${error?.message ?? ''} ${error?.additionalDetails ?? ''}`).toLowerCase();
  if (USAGE_MESSAGE.test(text)) return Failure.Limit;
  if (TRANSIENT_MESSAGE.test(text)) return Failure.Transient;
  if (LIMIT_MESSAGE.test(text)) return Failure.Limit;
  return Failure.Error;
}
