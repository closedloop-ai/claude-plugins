// Background verify runs (PRD-823, WS8 load-aware execution, W3, ISS-13586). The CPU-bound lane
// run starts in the background and returns a run id at once, so the model-bound handoff work
// (reviews, summary, ticket and plan work) proceeds while it runs; a join before Final Alignment
// reads the result. verify-run.mjs wires these into `--background`, `--status <id>` and `--wait <id>`.
//
// A run record lives in the session's git dir (`vibe-verify-runs/<id>.json`): the intended head,
// progress as lanes finish, and the result. The starter stores the worker pid beside it until the
// child records its own pid; this keeps parent and child from racing to replace the same JSON.
// A record that still says `running`
// whose process is gone is `orphaned`, never read as passed. The join says `passed` only when the
// run finished with `ok`, its evidence head is the head under review, and the worktree is still at
// that head; anything else is not a pass.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execCommand, parseJson } from "./ws3-exec.mjs";

export const RUN_SCHEMA = "vibe.verify-run/1";
export const RunState = Object.freeze({
  Running: "running", Passed: "passed", Failed: "failed", Orphaned: "orphaned", HeadMoved: "head-moved", Unknown: "unknown-run",
});
// Exit codes of `--status` and `--wait`: 0 only for a pass.
export const RunExit = Object.freeze({ [RunState.Passed]: 0, [RunState.Failed]: 1, [RunState.Unknown]: 2, [RunState.Orphaned]: 3, [RunState.Running]: 4, [RunState.HeadMoved]: 5 });
const RUN_ID = /^vr-[0-9a-z]+-[0-9a-f]{8}$/;

export function runDir(gitDir) {
  return path.join(gitDir, "vibe-verify-runs");
}

export const recordFile = (gitDir, id) => path.join(runDir(gitDir), `${id}.json`);
const pidFileFor = (gitDir, id) => path.join(runDir(gitDir), `${id}.pid`);
export const evidenceFileFor = (gitDir, id) => path.join(runDir(gitDir), `${id}.evidence.json`);
export const isRunId = (id) => RUN_ID.test(String(id));

export function newRunId(now = Date.now(), random = () => randomBytes(4).toString("hex")) {
  return `vr-${now.toString(36)}-${random()}`;
}

const realFs = {
  read: (file) => readFileSync(file, "utf8"),
  exists: existsSync,
  write: (file, text) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, file);
  },
};

/** Whether the process that owns a run is still that run: alive, and its command line names verify-run and the run id. */
export function runProcessAlive(pid, id, exec = execCommand) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const result = exec("ps", ["-ww", "-p", String(pid), "-o", "command="]);
  return result.status === 0 && result.stdout.includes("verify-run.mjs") && result.stdout.includes(id);
}

/** Writes or updates a run's record. */
export function writeRecord(gitDir, id, patch, fs = realFs) {
  const file = recordFile(gitDir, id);
  const current = fs.exists(file) ? parseJson(fs.read(file), {}) : {};
  fs.write(file, `${JSON.stringify({ schema: RUN_SCHEMA, ...current, ...patch, id }, null, 2)}\n`);
}

/** Starts `verify-run.mjs` detached with `--run-id`; the child alone updates the JSON after spawn. */
export function startBackground({ gitDir, worktree, head, scriptPath, passArgs, now = () => Date.now(), spawnDetached = defaultSpawn, fs = realFs, newId = newRunId }) {
  const id = newId(now());
  const evidenceFile = evidenceFileFor(gitDir, id);
  const logFile = path.join(runDir(gitDir), `${id}.log`);
  writeRecord(gitDir, id, { worktree, head, startedAt: new Date(now()).toISOString(), state: "starting", evidenceFile, logFile }, fs);
  const pid = spawnDetached(process.execPath, [scriptPath, "--worktree", worktree, "--head", head, ...passArgs, "--run-id", id, "--out", evidenceFile], { logFile });
  fs.write(pidFileFor(gitDir, id), `${pid}\n`);
  return { id, pid, statusFile: recordFile(gitDir, id), evidenceFile, logFile, state: RunState.Running };
}

function defaultSpawn(command, args, { logFile }) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  const child = spawn(command, args, { detached: true, stdio: ["ignore", fd, fd] });
  child.unref();
  closeSync(fd);
  return child.pid;
}

/** The run's state now. `running` with no live process is `orphaned`; a finished run is judged by its result and head. */
export function readRun({ gitDir, id, currentHead, expectedHead, fs = realFs, alive = runProcessAlive }) {
  if (!isRunId(id)) return { id, state: RunState.Unknown, reason: "not a verify run id" };
  const file = recordFile(gitDir, id);
  if (!fs.exists(file)) return { id, state: RunState.Unknown, reason: "no record of this run in this worktree" };
  const record = parseJson(fs.read(file), null);
  if (!record) return { id, state: RunState.Unknown, reason: "the run record is unreadable" };
  const classify = (observed) => {
    const base = { id, head: observed.head, evidenceHead: observed.evidenceHead ?? null, startedAt: observed.startedAt, finishedAt: observed.finishedAt ?? null, progress: observed.progress ?? [], evidenceFile: observed.evidenceFile, statusFile: file };
    if (observed.state === "finished") {
      if (!observed.ok) return { base, terminal: { ...base, state: RunState.Failed, summary: observed.summary ?? null, reason: observed.reason ?? "at least one required check did not pass" } };
      const wanted = (expectedHead ?? observed.head ?? "").toLowerCase();
      const matches = (head) => Boolean(head) && Boolean(wanted) && (head.startsWith(wanted) || wanted.startsWith(head));
      if (!matches(observed.evidenceHead) || (currentHead !== undefined && !matches(currentHead))) {
        return { base, terminal: { ...base, state: RunState.HeadMoved, summary: observed.summary ?? null, reason: `the result is for ${String(observed.evidenceHead).slice(0, 12)}, the head under review is ${String(currentHead ?? expectedHead).slice(0, 12)}` } };
      }
      return { base, terminal: { ...base, state: RunState.Passed, summary: observed.summary ?? null } };
    }
    if (observed.state === "error") return { base, terminal: { ...base, state: RunState.Failed, reason: observed.error ?? "the run stopped with an error" } };
    return { base, terminal: null };
  };
  const first = classify(record);
  if (first.terminal) return first.terminal;
  const pid = record.pid ?? (fs.exists(pidFileFor(gitDir, id)) ? Number(fs.read(pidFileFor(gitDir, id)).trim()) : undefined);
  if (!alive(pid, id)) {
    // The child may have finished after the first read but before the liveness check returned.
    const latest = parseJson(fs.read(file), null);
    const fresh = latest ? classify(latest) : first;
    if (fresh.terminal) return fresh.terminal;
    return { ...fresh.base, state: RunState.Orphaned, reason: "the run's process is gone and it never wrote a result; this is not a pass" };
  }
  return { ...first.base, state: RunState.Running };
}

/** Polls `readRun` until the run is not running, or `waitSeconds` pass (then it is still `running`). */
export async function waitForRun({ read, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), waitSeconds = 7200, pollSeconds = 10 }) {
  const started = now();
  for (;;) {
    const run = read();
    if (run.state !== RunState.Running || now() - started >= waitSeconds * 1000) return run;
    await sleep(pollSeconds * 1000);
  }
}
