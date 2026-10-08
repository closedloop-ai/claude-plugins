#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  AppServerClient,
  decodeWebSocketFrames,
  initializeClient,
  managedDaemon,
  readThreadState,
  sendInput,
} from './native-app-server-client.mjs';

export const PROCESS_API = 'CLOSEDLOOP_APP_SERVER_CLIENT v1';

function failure(error) {
  return { message: error.message, ...(error.code == null ? {} : { code: error.code }) };
}

/** Execute a one-shot public operation without exposing inputs in process arguments. */
export function once(message) {
  if (message.operation === 'contract') return { protocol: PROCESS_API };
  if (message.operation === 'daemon') return managedDaemon(message.options);
  if (message.operation === 'decodeFrames') {
    const decoded = decodeWebSocketFrames(Buffer.from(message.buffer, 'base64'));
    return {
      frames: decoded.frames.map(frame => ({ ...frame, payload: frame.payload.toString('base64') })),
      remainder: decoded.remainder.toString('base64'),
    };
  }
  throw new Error('Unsupported one-shot client operation');
}

/** Serve one caller-owned client over private JSONL pipes, keeping transport code in core. */
export async function serve(input = process.stdin, output = process.stdout) {
  let client = null;
  let closed = false;
  const callbacks = new Map();
  let nextCallback = 1;
  const lines = createInterface({ input });
  const write = value => {
    if (!closed) output.write(`${JSON.stringify({ protocol: PROCESS_API, ...value })}\n`);
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const pending of callbacks.values()) pending.reject(new Error('The caller process closed'));
    callbacks.clear();
    client?.close();
    lines.close();
  };
  input.on('end', dispose);
  output.on('error', dispose);
  process.once('SIGTERM', dispose);
  process.once('SIGINT', dispose);
  async function dispatch(message) {
    if (message.protocol !== PROCESS_API) throw new Error('Incompatible client process protocol');
    const { operation, options = {} } = message;
    if (operation === 'connect') {
      if (client) throw new Error('A client is already connected');
      client = new AppServerClient(options);
      client.onNotification((method, params) => write({ event: 'notification', method, params }));
      client.onConnection((state, error) => write({ event: 'connection', state, error: failure(error) }));
      await client.connect();
      return {};
    }
    if (operation === 'delegate') {
      if (client) throw new Error('A client is already connected');
      const callback = (method, args) => new Promise((accept, reject) => {
        const callbackId = nextCallback++;
        callbacks.set(callbackId, { accept, reject });
        write({ event: 'callback', callbackId, method, args });
      });
      client = {
        connect: () => callback('connect', []),
        request: (...args) => callback('request', args),
        notify: (...args) => { callback('notify', args).catch(() => {}); },
        close: () => {},
      };
      return {};
    }
    if (!client) throw new Error('Connect the client before invoking operations');
    if (operation === 'request') return client.request(message.method, message.params, message.timeoutMs);
    if (operation === 'notify') { client.notify(message.method, message.params); return {}; }
    if (operation === 'initialize') return initializeClient(client, options);
    if (operation === 'readThreadState') {
      const timing = options.deadline == null ? options : { timeoutMs: () => Math.max(1, options.deadline - Date.now()) };
      return readThreadState(client, message.threadId, timing);
    }
    if (operation === 'sendInput') return sendInput(client, options, message.input, message.retryDelayMs);
    if (operation === 'close') { dispose(); return {}; }
    throw new Error('Unsupported client process operation');
  }
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { dispose(); return; }
    if (message.protocol === PROCESS_API && message.callbackId != null) {
      const pending = callbacks.get(message.callbackId);
      if (pending) {
        callbacks.delete(message.callbackId);
        if (message.error) {
          const error = Object.assign(new Error(message.error.message), { code: message.error.code });
          pending.reject(error);
        } else pending.accept(message.result);
      }
      return;
    }
    Promise.resolve().then(() => dispatch(message)).then(
      result => write({ id: message.id, result: result ?? null }),
      error => write({ id: message.id, error: failure(error) }),
    );
  });
  write({ event: 'ready' });
}

async function main() {
  if (process.argv[2] === 'serve') return serve();
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  try {
    const message = JSON.parse(body);
    if (message.protocol !== PROCESS_API) throw new Error('Incompatible client process protocol');
    process.stdout.write(`${JSON.stringify({ protocol: PROCESS_API, result: once(message) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ protocol: PROCESS_API, error: failure(error) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
