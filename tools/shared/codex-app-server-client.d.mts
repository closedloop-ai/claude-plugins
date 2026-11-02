export interface CodexAppServerOptions {
  codex: string;
  env: NodeJS.ProcessEnv;
  clientName?: string;
  timeoutMs?: number;
  onRequest?: (message: Record<string, unknown>) => unknown | Promise<unknown>;
  spawnImpl?: typeof import("node:child_process").spawn;
}

export declare class CodexAppServerClient {
  constructor(options: CodexAppServerOptions);
  readonly pid: number | undefined;
  onNotification(handler: (message: Record<string, unknown>) => void): () => boolean;
  notify(method: string, params?: unknown): void;
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  initialize(clientName: string, timeoutMs?: number): Promise<void>;
  resumeThread(threadId: string, cwd: string, threadOptions?: Record<string, unknown>,
    timeoutMs?: number): Promise<any>;
  readThreadState(threadId: string, timeoutMs?: number): Promise<{ thread: any; latestTurn: any }>;
  close(signal?: NodeJS.Signals): Promise<void>;
}

export declare function startCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServerClient>;
