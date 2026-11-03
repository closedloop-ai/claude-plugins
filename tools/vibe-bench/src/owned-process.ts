import { spawn } from "node:child_process";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Stop an owned detached process group, escalating until no descendant remains. */
export async function terminateProcessGroup(pid: number,
  firstSignal: NodeJS.Signals = "SIGINT", graceMs = 1_000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("benchmark-process-group-pid-invalid");
  for (const signal of [firstSignal, "SIGTERM", "SIGKILL"] as NodeJS.Signals[]) {
    if (!groupAlive(pid)) return;
    try { process.kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && groupAlive(pid)) await delay(20);
  }
  if (groupAlive(pid)) throw new Error("benchmark-process-group-survived-kill");
}

export interface OwnedProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** Run a command as one owned group bounded by the shared batch deadline. */
export function runOwnedProcess(command: string, args: string[], options: {
  cwd: string;
  deadline: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<OwnedProcessResult> {
  if (options.deadline <= Date.now()) return Promise.reject(new Error("benchmark-batch-budget-exhausted"));
  if (options.signal?.aborted) return Promise.reject(new Error("benchmark-batch-interrupted"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, env: options.env,
      stdio: ["ignore", "pipe", "pipe"] });
    if (!child.pid) { reject(new Error("benchmark-child-pid-missing")); return; }
    const pid = child.pid;
    const limit = options.maxBuffer ?? 8 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > limit) void stop(new Error("benchmark-child-output-too-large"));
      return next;
    };
    child.stdout!.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => void stop(new Error("benchmark-batch-budget-exhausted")),
      Math.max(1, options.deadline - Date.now()));
    const onAbort = () => void stop(new Error("benchmark-batch-interrupted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    async function stop(reason: Error): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try { await terminateProcessGroup(pid); }
      catch (error) { reject(new AggregateError([reason, error], "benchmark-child-cleanup-failed")); return; }
      reject(reason);
    }
    child.once("error", (error) => void stop(error));
    child.once("exit", (exitCode, signal) => void (async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        if (groupAlive(pid)) await terminateProcessGroup(pid, "SIGTERM");
        resolve({ stdout, stderr, exitCode, signal });
      } catch (error) {
        reject(new AggregateError([error], "benchmark-child-exit-cleanup-failed"));
      }
    })());
  });
}
