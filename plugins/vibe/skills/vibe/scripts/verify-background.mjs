// Background verify runs (PRD-823, WS8 load-aware execution, W3, ISS-13586). The CPU-bound lane
// run starts in the background and returns a run id at once, so the model-bound handoff work
// (reviews, summary, ticket and plan work) proceeds while it runs; a join before Final Alignment
// reads the result. verify-run.mjs wires these into `--background`, `--status <id>` and `--wait <id>`.
//
// A run record lives in the session's git dir (`vibe-verify-runs/<id>.json`): the intended head,
// the worker pid, progress as lanes finish, and the result. A record that still says `running`
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
  const result = exec("ps", ["-p", String(pid), "-o", "command="]);
  return result.status === 0 && result.stdout.includes("verify-run.mjs") && result.stdout.includes(id);
}

/** Writes or updates a run's record. */
export function writeRecord(gitDir, id, patch, fs = realFs) {
  const file = recordFile(gitDir, id);
  const current = fs.exists(file) ? parseJson(fs.read(file), {}) : {};
  fs.write(file, `${JSON.stringify({ schema: RUN_SCHEMA, ...current, ...patch, id }, null, 2)}\n`);
}

/** Starts `verify-run.mjs` detached with `--run-id`, writes the record, and returns at once. */
export function startBackground({ gitDir, worktree, head, scriptPath, passArgs, now = () => Date.now(), spawnDetached = defaultSpawn, fs = realFs, newId = newRunId }) {
  const id = newId(now());
  const evidenceFile = evidenceFileFor(gitDir, id);
  const logFile = path.join(runDir(gitDir), `${id}.log`);
  writeRecord(gitDir, id, { worktree, head, startedAt: new Date(now()).toISOString(), state: "starting", evidenceFile, logFile }, fs);
  const pid = spawnDetached(process.execPath, [scriptPath, "--worktree", worktree, "--head", head, ...passArgs, "--run-id", id, "--out", evidenceFile], { logFile });
  writeRecord(gitDir, id, { pid, state: "running" }, fs);
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
  const base = { id, head: record.head, evidenceHead: record.evidenceHead ?? null, startedAt: record.startedAt, finishedAt: record.finishedAt ?? null, progress: record.progress ?? [], evidenceFile: record.evidenceFile, statusFile: file };
  if (record.state === "finished") {
    if (!record.ok) return { ...base, state: RunState.Failed, summary: record.summary ?? null, reason: record.reason ?? "at least one required check did not pass" };
    const wanted = (expectedHead ?? record.head ?? "").toLowerCase();
    const matches = (head) => Boolean(head) && Boolean(wanted) && (head.startsWith(wanted) || wanted.startsWith(head));
    if (!matches(record.evidenceHead) || (currentHead !== undefined && !matches(currentHead))) {
      return { ...base, state: RunState.HeadMoved, summary: record.summary ?? null, reason: `the result is for ${String(record.evidenceHead).slice(0, 12)}, the head under review is ${String(currentHead ?? expectedHead).slice(0, 12)}` };
    }
    return { ...base, state: RunState.Passed, summary: record.summary ?? null };
  }
  if (record.state === "error") return { ...base, state: RunState.Failed, reason: record.error ?? "the run stopped with an error" };
  if (!alive(record.pid, id)) return { ...base, state: RunState.Orphaned, reason: "the run's process is gone and it never wrote a result; this is not a pass" };
  return { ...base, state: RunState.Running };
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
