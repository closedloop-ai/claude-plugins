#!/usr/bin/env node
// Runs one command with a time limit, on any Mac. macOS ships no GNU
// `timeout` (or `gtimeout`), so a vibe worker that bounds a slow check with
// it fails with "command not found" (operator ruling, 2026-10-15). Workers use
// this instead, or their tool's own timeout setting.
//
// Usage: run-bounded.mjs <seconds> <command> [args...]
//
// A CPU-heavy command (a test, typecheck, lint or build run, vitest, turbo, playwright
// and the like; `isHeavyCommand` in heavy-budget.mjs) first takes a worker budget:
// what is left of the machine after the heavy runs already on it. The
// command gets that concurrency through TURBO_TEST_CONCURRENCY and VITEST_MAX_WORKERS,
// never above what the caller already set, and a lease for its lifetime. When the machine
// has no capacity to spare it waits for some, then proceeds at the minimum; a failure with
// a load signature (exit 137, out of memory, a timeout under load) is retried once at half
// the workers (load-admission.mjs). A final stderr line `run-bounded-result: {json}`
// carries the attempts. Any other
// command is untouched. This is opt-in: without VIBE_HEAVY_BUDGET=on a heavy command runs exactly as before.
// Waiting and the retry count inside the time limit, so a caller's outer limit of `seconds` plus a margin still holds.
//
// Output streams through unchanged. On time out it stops the command and
// everything it started, then exits 124, the code GNU `timeout` uses, and
// prints one line to stderr. Otherwise it exits with the command's own code.

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { budgetDisabled, createBudget, isHeavyCommand } from "./heavy-budget.mjs";
import { runAdmitted } from "./load-admission.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

export const TIMED_OUT_EXIT = 124;
/** The stderr line that carries a heavy run's attempts, first-failure signature and load at start. */
export const RESULT_PREFIX = "run-bounded-result: ";
const GRACE_MS = 2_000;

/** Runs `command` in its own process group and resolves its exit code, or 124 after `seconds`. */
export function runBounded(command, args, options) {
  return runBoundedDetailed(command, args, options).then((result) => result.code);
}

/**
 * `runBounded` with `{ code, output }`. With `capture`, stdout and stderr still stream to this
 * process unchanged and the last `captureBytes` of both are kept, so a caller can classify a failure.
 */
export function runBoundedDetailed(command, args, { seconds, stdio = "inherit", env, capture = false, captureBytes = 256 * 1024, drainGroup = false }) {
  if (seconds !== null && (!Number.isFinite(seconds) || seconds <= 0)) {
    return Promise.reject(new Error("The time limit must be a positive number of seconds."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ["inherit", "pipe", "pipe"] : stdio, detached: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
    let timedOut = false;
    let forwarded = false;
    let killTimer;
    let output = "";
    if (capture) {
      for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
        stream.on("data", (chunk) => {
          sink.write(chunk);
          output = (output + chunk.toString("utf8")).slice(-captureBytes);
        });
      }
    }
    const signalGroup = (signal) => {
      // kill(-1) would signal every process the user owns.
      if (!(child.pid > 1)) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        // Seen on macOS: EPERM instead of ESRCH once the group's members have exited.
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") {
          throw error;
        }
      }
    };
    // A caller's kill of this process must reach the detached group, or the group is orphaned.
    const forward = (signal) => {
      forwarded = true;
      signalGroup(signal);
      killTimer ??= setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
    };
    const onTerm = () => forward("SIGTERM");
    const onInt = () => forward("SIGINT");
    const onHup = () => forward("SIGHUP");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    process.on("SIGHUP", onHup);
    const release = () => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      process.off("SIGHUP", onHup);
    };
    const deadline = seconds === null ? null : setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
    }, seconds * 1000);
    child.once("error", (error) => {
      release();
      clearTimeout(deadline);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(deadline);
      if (drainGroup && (forwarded || timedOut)) {
        clearTimeout(killTimer);
        try { await settleGroup(child.pid, signalGroup); }
        catch (error) { release(); reject(error); return; }
      }
      release();
      if (timedOut) {
        signalGroup("SIGKILL");
        clearTimeout(killTimer);
        resolve({ code: TIMED_OUT_EXIT, output });
        return;
      }
      resolve({ code: code ?? 128 + (os.constants.signals[signal] ?? 0), output });
    });
  });
}

/** Wait out polite cancellation of this spawn's group, then stop any remaining group members. */
async function settleGroup(pid, signalGroup) {
  if (!(pid > 1)) return;
  const started = Date.now();
  let forced = false;
  while (runningInGroup(pid)) {
    const elapsed = Date.now() - started;
    if (elapsed >= 2 * GRACE_MS) throw new Error(`owned process group ${pid} did not stop after cancellation`);
    if (elapsed >= GRACE_MS && !forced) {
      signalGroup("SIGKILL");
      forced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Zombies can keep a process group addressable after its last runnable process has stopped. */
function runningInGroup(pid) {
  if (!(pid > 1)) return false;
  try { process.kill(-pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  const ps = spawnSync("ps", ["-Ao", "pgid=,stat="], { encoding: "utf8", timeout: 500 });
  if (ps.status !== 0) return true;
  return ps.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/, 2);
    return Number(group) === pid && state && !state.startsWith("Z");
  });
}

/**
 * Runs a command; a CPU-heavy one first waits for capacity, takes a worker budget and a lease, and a
 * load failure is retried once (load-admission.mjs). Resolves `{ exitCode, ... }` with the provenance
 * of every attempt; any other command, or a disabled budget, runs as `runBounded` does.
 */
export async function runBudgeted(command, args, { seconds, env = process.env, budget = createBudget({ env }), log = () => {}, sleep, now, loadAverage }) {
  if (budgetDisabled(env) || !isHeavyCommand(command, args)) return { exitCode: await runBounded(command, args, { seconds }), attempts: null };
  return runAdmitted(command, args, {
    seconds, budget, env, log, sleep, now, loadAverage,
    run: (cmd, cmdArgs, options) => runBoundedDetailed(cmd, cmdArgs, { ...options, capture: true }),
  });
}

async function main(argv) {
  const [limit, command, ...args] = argv;
  if (!command) {
    throw new Error("Usage: run-bounded.mjs <seconds> <command> [args...]");
  }
  const seconds = Number(limit);
  const result = await runBudgeted(command, args, { seconds, log: (line) => process.stderr.write(line) });
  const code = result.exitCode;
  if (result.attempts) process.stderr.write(`${RESULT_PREFIX}${JSON.stringify({ ...result, exitCode: undefined })}\n`);
  if (code === TIMED_OUT_EXIT) {
    process.stderr.write(`run-bounded: stopped after ${seconds}s: ${command}\n`);
  }
  return code;
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  );
}
