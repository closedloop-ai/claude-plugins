#!/usr/bin/env node
// Start and stop a verifier-owned Storybook without ever adopting a process
// that was already running. Reuses session-processes' birth and cwd checks.

import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "./session-record.mjs";
import { captureSessionProcessIdentities, stopSessionProcesses } from "./session-processes.mjs";

function recordPath(worktree, port) {
  return path.join(git(worktree, ["rev-parse", "--absolute-git-dir"]), `vibe-verify-storybook-${port}.json`);
}

/** Start a new Storybook and durably bind its PID, birth, command and cwd before returning. */
export async function startVerifyStorybook(worktree, port) {
  const root = realpathSync(worktree);
  const file = recordPath(root, port);
  if (existsSync(file)) throw new Error("This verifier port already has a private process record; stop or reconcile it first.");
  const log = path.join(path.dirname(file), `vibe-verify-storybook-${port}.log`);
  const fd = openSync(log, "a", 0o600);
  let child;
  try {
    child = spawn("pnpm", ["exec", "storybook", "dev", "-p", String(port), "--ci", "--no-open"], {
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
        const record = { worktree: root, port, stack, log };
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
    const { values, positionals } = parseArgs({ allowPositionals: true,
      options: { worktree: { type: "string" }, port: { type: "string" } } });
    const port = Number(values.port);
    if (!values.worktree || !Number.isInteger(port) || port < 1024 || port > 65535 || positionals.length !== 1
      || !["start", "stop"].includes(positionals[0])) {
      throw new Error("Usage: verify-storybook-process.mjs start|stop --worktree <path> --port <1024..65535>");
    }
    const result = positionals[0] === "start"
      ? await startVerifyStorybook(values.worktree, port) : await stopVerifyStorybook(values.worktree, port);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
