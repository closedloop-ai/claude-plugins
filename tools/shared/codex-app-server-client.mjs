import { spawn } from "node:child_process";
import readline from "node:readline";

/** JSON-RPC stdio client shared by release smoke and stateful upgrade evaluation. */
export class CodexAppServerClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #notificationHandlers = new Set();
  #requestHandler;
  #closed = false;

  constructor(options) {
    this.#requestHandler = options.onRequest;
    this.#child = (options.spawnImpl ?? spawn)(options.codex, ["app-server"], {
      env: options.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.resume();
    readline.createInterface({ input: this.#child.stdout }).on("line", (line) => this.#receive(line));
    this.#child.once("exit", (code, signal) => this.#failPending(
      new Error(`App Server exited before its response: code=${code ?? "none"} signal=${signal ?? "none"}`)));
    this.#child.once("error", (error) => this.#failPending(error));
  }

  get pid() { return this.#child.pid; }

  onNotification(handler) {
    this.#notificationHandlers.add(handler);
    return () => this.#notificationHandlers.delete(handler);
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params, timeoutMs = 60_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("App Server timeout must be positive");
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`App Server request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(clientName, timeoutMs = 60_000) {
    await this.request("initialize", { clientInfo: { name: clientName, title: null, version: "1" },
      capabilities: null }, timeoutMs);
    this.notify("initialized");
  }

  async resumeThread(threadId, cwd, threadOptions = {}, timeoutMs = 60_000) {
    const result = await this.request("thread/resume", { threadId, cwd, ...threadOptions }, timeoutMs);
    if (result?.thread?.id !== threadId) throw new Error("App Server resumed a different thread");
    return result.thread;
  }

  /** Read status without loading the persisted turn history into this process. */
  async readThreadState(threadId, timeoutMs = 60_000) {
    const [thread, turns] = await Promise.all([
      this.request("thread/read", { threadId, includeTurns: false }, timeoutMs),
      this.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc",
        itemsView: "notLoaded" }, timeoutMs),
    ]);
    return { thread: thread?.thread ?? null, latestTurn: turns?.data?.[0] ?? null };
  }

  async close(signal = "SIGTERM") {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new Error("App Server client closed"));
    if (this.#child.killed) return;
    const exited = new Promise((resolve) => this.#child.once("exit", resolve));
    this.#child.kill(signal);
    let timer;
    const graceful = await Promise.race([exited.then(() => true), new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 2_000);
    })]);
    if (timer) clearTimeout(timer);
    if (!graceful) this.#child.kill("SIGKILL");
  }

  #write(message) {
    if (this.#closed || !this.#child.stdin.writable) throw new Error("App Server client is closed");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id !== undefined && !message.method) {
      const waiter = this.#pending.get(message.id);
      if (!waiter) return;
      this.#pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      Promise.resolve(this.#requestHandler?.(message)).then((result) => {
        this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? { decision: "decline" } });
      }, (error) => {
        this.#write({ jsonrpc: "2.0", id: message.id,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
      });
      return;
    }
    for (const handler of this.#notificationHandlers) handler(message);
  }

  #failPending(error) {
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }
}

/** Spawn and initialize one private App Server process. */
export async function startCodexAppServer(options) {
  const client = new CodexAppServerClient(options);
  try {
    await client.initialize(options.clientName ?? "closedloop_vibe", options.timeoutMs);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
