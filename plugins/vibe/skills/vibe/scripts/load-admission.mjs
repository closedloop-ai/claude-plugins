// Wait instead of fail (PRD-823, WS6 load-aware execution, W2, ISS-13585).
//
// 1. Admission: when heavy-budget.mjs says the machine has fewer than `minWorkers`
//    cores to spare, a heavy run waits (polling with backoff, never a busy loop) up to
//    `maxWaitSeconds`, then proceeds at the minimum worker count. It never fails for
//    lack of capacity.
// 2. Load-failure retry: a failed heavy command whose output or exit matches a load
//    signature is re-run ONCE at half the workers after waiting for admission again.
//    A failing assertion is never retried, a failure with no load signature is final,
//    a second failure is final, and a failure becomes a pass only through a real pass
//    on the retry. The result keeps `attempts`, the first failure's signature and the
//    load at start.
//
// Switches: VIBE_HEAVY_WAIT=off skips the wait, VIBE_HEAVY_RETRY=off skips the retry,
// VIBE_HEAVY_BUDGET=off skips both (and the budget itself). Defaults: heavy-budget.mjs.

import os from "node:os";
import { ENV, featureDisabled, resolveSettings } from "./heavy-budget.mjs";

export const Signature = Object.freeze({
  Assertion: "assertion-failure",
  Sigkill: "sigkill-exit-137",
  OutOfMemory: "out-of-memory",
  RunTimeout: "run-timeout-under-load",
  TestTimeout: "test-timeout-under-load",
  StarvedServer: "starved-server-connection",
});

const SIGKILL_EXIT = 137;
const TIMED_OUT_EXIT = 124;
// A failing assertion is a genuine failure. It outranks every load signature, so a kill that follows a real failure is still final.
const ASSERTION = /AssertionError|AssertionFailedError|Assertion failed|^\s*(?:Expected|Received)\b|expected .{1,200} to (?:be|equal|deeply|have|match|contain|include|throw|not)|\bFAIL\b.*\bexpected\b/im;
const SIGKILL_TEXT = /\bSIGKILL\b|\bKilled: 9\b/;
const OUT_OF_MEMORY = /JavaScript heap out of memory|\bENOMEM\b|Cannot allocate memory|\bOOMKilled\b|out of memory/i;
const STARVED_SERVER = /\bECONNRESET\b|\bEPIPE\b|socket hang up/;
const TEST_TIMEOUT = /Test timed out in \d+\s*ms|Hook timed out in \d+\s*ms|Exceeded timeout of \d+\s*ms|Timeout of \d+\s*ms exceeded|Timeout - Async callback was not invoked/;

/** `{ retry, signature }` for a failed run. Resource exhaustion (exit 137, out of memory) is a load signature on its own; a timeout or a dropped connection is one only while the machine was loaded at the start. */
export function classifyLoadFailure({ exitCode, output = "", loadHigh }) {
  if (exitCode === 0) return { retry: false, signature: null };
  if (ASSERTION.test(output)) return { retry: false, signature: Signature.Assertion };
  if (exitCode === SIGKILL_EXIT || SIGKILL_TEXT.test(output)) return { retry: true, signature: Signature.Sigkill };
  if (OUT_OF_MEMORY.test(output)) return { retry: true, signature: Signature.OutOfMemory };
  if (!loadHigh) return { retry: false, signature: null };
  if (exitCode === TIMED_OUT_EXIT) return { retry: true, signature: Signature.RunTimeout };
  if (TEST_TIMEOUT.test(output)) return { retry: true, signature: Signature.TestTimeout };
  if (STARVED_SERVER.test(output)) return { retry: true, signature: Signature.StarvedServer };
  return { retry: false, signature: null };
}

/** Polls the budget until it has `minWorkers` to spare, with backoff, up to `maxWaitSeconds`; then returns the last snapshot with `timedOut`. */
export async function waitForAdmission({ budget, settings, sleep, now, wait = true, log = () => {} }) {
  const started = now();
  const maxWaitMs = settings.maxWaitSeconds * 1000;
  let delaySeconds = settings.pollSeconds;
  let polls = 0;
  for (;;) {
    const snapshot = budget.snapshot();
    const waitedMs = now() - started;
    if (!snapshot.belowMinimum) return { snapshot, waitedMs, polls, timedOut: false };
    if (!wait || waitedMs >= maxWaitMs) return { snapshot, waitedMs, polls, timedOut: wait };
    if (polls === 0) log(`run-bounded: ${snapshot.available} of ${snapshot.capacity} cores free, below the minimum of ${settings.minWorkers}; waiting up to ${settings.maxWaitSeconds}s for capacity\n`);
    polls += 1;
    await sleep(Math.min(delaySeconds * 1000, maxWaitMs - waitedMs));
    delaySeconds = Math.min(delaySeconds * settings.pollBackoffFactor, settings.maxPollSeconds);
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a heavy command with admission and the load-failure retry. `run(command, args, { seconds, env })`
 * resolves `{ code, output }`. Resolves `{ exitCode, attempts, retried, firstFailureSignature, loadAtStart, waitedMs, admission }`;
 * `exitCode` is the last attempt's own exit code.
 */
export async function runAdmitted(command, args, {
  seconds, budget, run, env = process.env, settings = resolveSettings(env), sleep = realSleep, now = () => Date.now(),
  loadAverage = () => os.loadavg()[0], log = () => {},
}) {
  const waiting = !featureDisabled(env, ENV.wait);
  const retrying = !featureDisabled(env, ENV.retry) && settings.retries > 0;
  const first = await waitForAdmission({ budget, settings, sleep, now, wait: waiting, log });
  const load1 = loadAverage();
  const loadAtStart = { load1, cores: first.snapshot.cores, perCore: load1 / first.snapshot.cores, belowMinimum: first.snapshot.belowMinimum };
  const loadHigh = loadAtStart.perCore > settings.highLoadPerCore || first.snapshot.belowMinimum;
  const attempts = [];
  let waitedMs = first.waitedMs;
  let admission = first;
  let workers = first.snapshot.workers;
  for (let attempt = 1; ; attempt += 1) {
    const taken = budget.acquire({ command, args, budget: { ...admission.snapshot, workers } });
    const started = now();
    let result;
    try {
      result = await run(command, args, { seconds, env: taken.env });
    } finally {
      taken.release();
    }
    const verdict = classifyLoadFailure({ exitCode: result.code, output: result.output, loadHigh });
    attempts.push({ attempt, workers, exitCode: result.code, signature: verdict.signature, durationMs: now() - started, ...(attempt === 1 ? {} : { waitedMs: admission.waitedMs }) });
    const retry = verdict.retry && retrying && attempt <= settings.retries;
    if (!retry) {
      return {
        exitCode: result.code, attempts, retried: attempt > 1, firstFailureSignature: attempts.find((item) => item.signature)?.signature ?? null,
        loadAtStart, waitedMs, admission: first.timedOut ? "waited-timed-out" : first.polls > 0 ? "waited" : "immediate",
      };
    }
    log(`run-bounded: load failure (${verdict.signature}); waiting for capacity, then one retry at half the workers\n`);
    admission = await waitForAdmission({ budget, settings, sleep, now, wait: waiting, log });
    waitedMs += admission.waitedMs;
    workers = Math.max(1, Math.floor(workers / settings.retryWorkerDivisor));
  }
}
