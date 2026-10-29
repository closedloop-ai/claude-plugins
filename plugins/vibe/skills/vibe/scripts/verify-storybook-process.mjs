#!/usr/bin/env node
// Start, run with, and stop a verifier-owned Storybook or static build server
// without adopting a process already running. Reuses session-processes' birth
// and cwd checks; the run wrapper owns cleanup on success and failure.

import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";
import { captureSessionProcessIdentities, stopSessionProcesses } from "./session-processes.mjs";

function recordPath(worktree, port) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), `vibe-verify-storybook-${port}.json`);
}

/** Start a new Storybook or static build server and bind its PID, birth, command and cwd. */
export async function startVerifyStorybook(worktree, port, { staticDir } = {}) {
  const root = realpathSync(worktree);
  const served = staticDir ? realpathSync(staticDir) : null;
  if (served && !(served === root || served.startsWith(`${root}${path.sep}`))) {
    throw new Error("The static Storybook build must be inside its recorded worktree.");
  }
  const file = recordPath(root, port);
  if (existsSync(file)) throw new Error("This verifier port already has a private process record; stop or reconcile it first.");
  const log = path.join(path.dirname(file), `vibe-verify-storybook-${port}.log`);
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    const command = served ? process.execPath : "pnpm";
    const args = served
      ? [fileURLToPath(import.meta.url), "serve-static", "--worktree", root, "--port", String(port), "--dir", served]
      : ["exec", "storybook", "dev", "-p", String(port), "--ci", "--no-open"];
    child = spawn(command, args, {
      cwd: path.join(root, "apps", "storybook"), detached: true, stdio: ["ignore", fd, fd],
    });
    child.on("error", () => {});
    if (!child.pid) throw new Error("Storybook did not start; no process was recorded.");
    // pnpm's shell shim may exec into node after spawn. Wait for that command
    // transition before taking the immutable birth and command witness.
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let attempt = 0; attempt < 40; attempt++) {
      const stack = captureSessionProcessIdentities(root, { storybookPid: child.pid });
      if (stack.storybookIdentity) {
        const record = { worktree: root, port, stack, log, ...(served ? { staticDir: served } : {}) };
        const output = openSync(file, "wx", 0o600);
        try { writeFileSync(output, `${JSON.stringify(record)}\n`); }
        finally { closeSync(output); }
        child.unref();
        return { pid: child.pid, record: file, log };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("New Storybook process has no verified birth identity; it was not registered.");
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    throw error;
  } finally { closeSync(fd); }
}

/** Wait until this server answers before giving its URL to a comparison. */
async function ready(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("The owned Storybook server exited before it became ready.");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The owned Storybook server did not become ready.");
}

/** Run a comparison or command while one verified server is owned, always stopping it. */
export async function withVerifyStorybook(worktree, port, action, options = {}) {
  const controller = new AbortController();
  let rejectInterrupt;
  const interruption = new Promise((_, reject) => { rejectInterrupt = reject; });
  interruption.catch(() => {});
  const onSignal = (name) => { controller.abort(); rejectInterrupt(new Error(`Owned Storybook run interrupted by ${name}.`)); };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let started;
  try {
    started = await startVerifyStorybook(worktree, port, options);
    const url = `http://127.0.0.1:${port}`;
    await ready(url, { get exitCode() { return started.pid && processAlive(started.pid) ? null : 1; } });
    return await Promise.race([action(url, controller.signal), interruption]);
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (started) await stopVerifyStorybook(worktree, port);
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Serve only files inside this Storybook build; no directory traversal or shell process. */
async function serveStatic(dir, port) {
  const root = realpathSync(dir);
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".woff": "font/woff", ".woff2": "font/woff2" };
  const server = createServer(async (request, response) => {
    let target;
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      target = path.resolve(root, `.${pathname}`);
      if (!(target === root || target.startsWith(`${root}${path.sep}`))) throw new Error("outside build");
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      target = realpathSync(target);
      if (!(target === root || target.startsWith(`${root}${path.sep}`))) throw new Error("outside build");
      const body = await readFile(target);
      response.writeHead(200, { "Content-Type": types[path.extname(target)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

/** Stop only the still-matching recorded Storybook process and clear its private record. */
export async function stopVerifyStorybook(worktree, port) {
  const root = realpathSync(worktree);
  const file = recordPath(root, port);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Verifier process record is not a regular private file.");
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (record.worktree !== root || record.port !== port || !Number.isInteger(record.stack?.storybookPid)
    || !/^[a-f0-9]{64}$/.test(record.stack.storybookIdentity ?? "")) {
    throw new Error("Verifier process record has no matching worktree, port and birth identity.");
  }
  const result = await stopSessionProcesses(root, record.stack);
  if (result.results.some((entry) => entry.result === "left-alone" || entry.result === "still-running")) {
    throw new Error("Verifier Storybook could not be proven owned and stopped; private record retained.");
  }
  unlinkSync(file);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const separator = process.argv.indexOf("--");
    const own = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
    const command = separator < 0 ? [] : process.argv.slice(separator + 1);
    const { values, positionals } = parseArgs({ args: own, allowPositionals: true,
      options: { worktree: { type: "string" }, port: { type: "string" }, dir: { type: "string" } } });
    const port = Number(values.port);
    if (!values.worktree || !Number.isInteger(port) || port < 1024 || port > 65535 || positionals.length !== 1
      || !["start", "stop", "run", "serve-static"].includes(positionals[0])) {
      throw new Error("Usage: verify-storybook-process.mjs start|stop|run|serve-static --worktree <path> --port <1024..65535> [--dir <build>] [-- <command>]");
    }
    if (positionals[0] === "serve-static") {
      if (!values.dir) throw new Error("A static Storybook build directory is required.");
      await serveStatic(values.dir, port);
    } else {
      if (positionals[0] === "run" && command.length === 0) throw new Error("run needs a command after the separator.");
      const result = positionals[0] === "start" ? await startVerifyStorybook(values.worktree, port, { staticDir: values.dir })
        : positionals[0] === "stop" ? await stopVerifyStorybook(values.worktree, port)
          : await withVerifyStorybook(values.worktree, port, (url, signal) => new Promise((resolve, reject) => {
            const child = spawn(command[0], command.slice(1).map((arg) => arg.replaceAll("{url}", url)), { cwd: values.worktree, stdio: "inherit", signal });
            child.once("error", reject);
            child.once("close", (code) => resolve({ exitCode: code }));
          }), { staticDir: values.dir });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
      if (result.exitCode) process.exitCode = result.exitCode;
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
