#!/usr/bin/env node
// Runs one command with a time limit, on any Mac. macOS ships no GNU
// `timeout` (or `gtimeout`), so a vibe worker that bounds a slow check with
// it fails with "command not found" (operator ruling, 2026-10-15). Workers use
// this instead, or their tool's own timeout setting.
//
// Usage: run-bounded.mjs <seconds> <command> [args...]
//
// Output streams through unchanged. On time out it stops the command and
// everything it started, then exits 124, the code GNU `timeout` uses, and
// prints one line to stderr. Otherwise it exits with the command's own code.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TIMED_OUT_EXIT = 124;
const GRACE_MS = 2_000;

/** Runs `command` in its own process group and resolves its exit code, or 124 after `seconds`. */
export function runBounded(command, args, { seconds, stdio = "inherit" }) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return Promise.reject(new Error("The time limit must be a positive number of seconds."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio, detached: true });
    let timedOut = false;
    let killTimer;
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
    const deadline = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), GRACE_MS);
    }, seconds * 1000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) {
        signalGroup("SIGKILL");
        clearTimeout(killTimer);
        resolve(TIMED_OUT_EXIT);
        return;
      }
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

async function main(argv) {
  const [limit, command, ...args] = argv;
  if (!command) {
    throw new Error("Usage: run-bounded.mjs <seconds> <command> [args...]");
  }
  const seconds = Number(limit);
  const code = await runBounded(command, args, { seconds });
  if (code === TIMED_OUT_EXIT) {
    process.stderr.write(`run-bounded: stopped after ${seconds}s: ${command}\n`);
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }
  );
}
