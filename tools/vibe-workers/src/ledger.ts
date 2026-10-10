import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { actionSchema, ledgerSchema, registerSchema, type Ledger } from "./contracts.js";
import { readDefinition } from "./definition.js";

/** Resolves an exact existing checkout for pre-session operations or a parent-authorized cancellation. */
export function checkoutLocation(worktree: string) {
  const root = realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]));
  if (realpathSync(worktree) !== root) throw new Error("Use the session's exact worktree root");
  const dir = git(root, ["rev-parse", "--absolute-git-dir"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { root, dir, branch, file: join(dir, "vibe-writer.json"), lock: join(dir, "vibe-writer.lock") };
}

/** Implementation and publishing always require the real private session's exact branch and checkout. */
export function location(worktree: string) {
  const place = checkoutLocation(worktree);
  const record = z.object({ worktree: z.string().optional(), branch: z.string() }).passthrough().parse(
    JSON.parse(readFileSync(join(place.dir, "vibe-session.json"), "utf8")),
  );
  if ((record.worktree && realpathSync(record.worktree) !== place.root) || record.branch !== place.branch) throw new Error("Session worktree or branch changed");
  return place;
}

/** Compact identity only; private queued inputs remain in git metadata. */
export function readWriterSummary(worktree: string) {
  const place = location(worktree);
  if (!existsSync(place.file)) return undefined;
  return summary(readLedger(place));
}

/** Checks the existing active source lease atomically without returning private request text. */
export function verifySourceTurn(worktree: string, workerId: string, requestId: string, lease: string) {
  const place = location(worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (ledger.workerId !== workerId || ledger.active?.id !== requestId || ledger.active.lease !== lease) {
      throw new Error("Main-sync validation requires the exact current source lease");
    }
    return ledger.runtime;
  });
}

/** The coordinator can recover only its claimed request, not arbitrary private files or traces. */
export function takeWriterInput(input: unknown) {
  const data = actionSchema.parse(input);
  const place = location(data.worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (!ledger.active || data.workerId !== ledger.workerId || data.requestId !== ledger.active.id
      || !data.lease || ledger.active.lease !== data.lease) throw new Error("Input recovery requires the active turn lease");
    return { workerId: ledger.workerId, requestId: ledger.active.id,
      originalInput: ledger.active.input, input: ledger.active.continuation ?? ledger.active.input };
  });
}

/** Atomically binds the one persistent writer to its runtime, canonical definition and exact session. */
export function registerWriter(input: unknown) {
  const data = registerSchema.parse(input);
  const definition = readDefinition(data.agentRoot, data.agentName, data.capabilities);
  if (data.agentName !== "vibe-change-worker") throw new Error("Session writer must be vibe-change-worker");
  if (data.runtime === "codex" && !data.workerId) throw new Error("Native writer registration requires its worker ID");
  const place = location(data.worktree);
  return locked(place, () => {
    if (existsSync(place.file)) {
      const ledger = readLedger(place);
      if (ledger.runtime !== data.runtime || (data.workerId && ledger.workerId !== data.workerId)
        || JSON.stringify(ledger.binding) !== JSON.stringify(definition.binding)) {
        throw new Error("Persistent writer identity or capability binding changed");
      }
      return summary(ledger);
    }
    const ledger: Ledger = { version: 1, worktree: place.root, branch: place.branch, runtime: data.runtime,
      workerId: data.workerId ?? randomUUID(), binding: definition.binding, started: false,
      pending: [], completed: [] };
    save(place, ledger);
    return summary(ledger);
  });
}

/** Serialized mutations preserve active requests across review, person and commit continuations. */
export function changeWriter(action: "enqueue" | "claim" | "finish", input: unknown) {
  const data = actionSchema.parse(input);
  const place = location(data.worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (data.workerId !== ledger.workerId) throw new Error("Request must name the registered persistent writer");
    const requestId = data.requestId;
    if (!requestId) throw new Error("Request ID is required");
    if (action === "enqueue") {
      if (!data.input || data.continuation) throw new Error("Enqueue requires one original request input");
      if (ledger.pending.some((item) => item.id === requestId) || ledger.active?.id === requestId || ledger.completed.includes(requestId)) {
        throw new Error("Request ID already exists");
      }
      if (ledger.pending.length >= 32) throw new Error("Pending queue is full; keep the new input with the parent");
      ledger.pending.push({ id: requestId, input: data.input });
    } else if (action === "claim") {
      if (existsSync(join(place.dir, "vibe-record-turn.lock"))) throw new Error("A record turn is already running; retain the queued writer request");
      if (ledger.active?.lease) throw new Error("Writer already has an owned running turn");
      if (ledger.active) {
        if (ledger.active.id !== requestId || !data.continuation) throw new Error("Continue the active request before the next queued request");
        ledger.active.continuation = data.continuation;
      } else {
        if (data.continuation || ledger.pending[0]?.id !== requestId) throw new Error("Claim must take the oldest pending request");
        const next = ledger.pending.shift();
        if (!next) throw new Error("No pending request");
        ledger.active = { ...next, status: "PLAN" };
      }
      ledger.active.lease = randomUUID();
      ledger.active.ownerPid = process.pid;
    } else {
      if (!ledger.active || ledger.active.id !== requestId || !data.lease || ledger.active.lease !== data.lease || !data.status) {
        throw new Error("Finish requires ownership of the active turn lease");
      }
      if (ledger.runtime === "codex" && (!data.stoppedTurn || data.stoppedTurn.workerId !== ledger.workerId
        || data.stoppedTurn.requestId !== requestId || data.stoppedTurn.lease !== data.lease)) {
        throw new Error("Native finish requires the exact registered writer's stopped-turn completion evidence");
      }
      if (ledger.runtime === "claude" && ledger.active.processGroupId) proveGroupStopped(ledger.active.processGroupId);
      ledger.active.status = data.status;
      ledger.active.resultSummary = data.resultSummary;
      delete ledger.active.lease;
      delete ledger.active.ownerPid;
      delete ledger.active.processGroupId;
      delete ledger.active.continuation;
      if (data.status === "DONE") {
        ledger.completed = [...ledger.completed.slice(-63), requestId];
        delete ledger.active;
      }
    }
    save(place, ledger);
    return { ...summary(ledger), ...(action === "claim" ? { turn: ledger.active } : {}) };
  });
}

/** Shares the writer mutex so a helper cannot race source ownership or another record turn. */
export function acquireRecordTurn(worktree: string, owner?: { workerId: string; lease: string }) {
  return acquireRecordTurnAt(location(worktree), owner);
}

/** Uses the same source/record mutex after the caller has resolved its explicitly permitted context. */
export function acquireRecordTurnAt(place: ReturnType<typeof checkoutLocation>, owner?: { workerId: string; lease: string }) {
  return locked(place, () => {
    const file = join(place.dir, "vibe-record-turn.lock");
    if (existsSync(place.file)) {
      const ledger = readLedger(place);
      if (owner && !ledger.active?.lease) {
        throw new Error("Record continuation requires the exact current source lease");
      }
      if (ledger.active?.lease && (owner?.workerId !== ledger.workerId || owner?.lease !== ledger.active.lease)) {
        throw new Error("The implementation writer has a running turn; wait before changing shared records");
      }
    } else if (owner) throw new Error("Record continuation requires its registered source writer");
    mkdirSync(file, { mode: 0o700 });
    return file;
  });
}

/** Releases a native helper's record mutex only after its persisted grant is verified under the same writer mutex. */
export function releaseRecordTurnAt(place: ReturnType<typeof checkoutLocation>, verify: (lock: string) => void) {
  return locked(place, () => {
    const lock = join(place.dir, "vibe-record-turn.lock");
    verify(lock);
    rmSync(lock, { recursive: true });
  });
}

/** Keeps the actual owned Claude group in the turn, not the short-lived coordinator CLI PID. */
export function attachClaudeProcess(worktree: string, workerId: string, lease: string, processGroupId: number) {
  const place = location(worktree);
  locked(place, () => {
    const ledger = readLedger(place);
    if (ledger.runtime !== "claude" || ledger.workerId !== workerId || ledger.active?.lease !== lease) {
      throw new Error("Cannot attach an unowned Claude process group");
    }
    ledger.active.processGroupId = z.number().int().positive().parse(processGroupId);
    save(place, ledger);
  });
}

/** Marks the first launch before spawning; failed startup never silently creates a second session. */
export function markClaudeStarted(worktree: string, workerId: string, lease: string) {
  const place = location(worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (ledger.runtime !== "claude" || ledger.workerId !== workerId || ledger.active?.lease !== lease) {
      throw new Error("Claude launch does not own the registered turn");
    }
    const resume = ledger.started;
    ledger.started = true;
    save(place, ledger);
    return { resume, ledger };
  });
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function readLedger(place: ReturnType<typeof location>) {
  const ledger = ledgerSchema.parse(JSON.parse(readFileSync(place.file, "utf8")));
  if (ledger.worktree !== place.root || ledger.branch !== place.branch) throw new Error("Writer ledger does not belong to this session");
  return ledger;
}
function save(place: ReturnType<typeof location>, ledger: Ledger) {
  const temp = `${place.file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, `${JSON.stringify(ledger)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, place.file); }
  finally { rmSync(temp, { force: true }); }
}
function locked<T>(place: ReturnType<typeof location>, operation: () => T): T {
  try { mkdirSync(place.lock, { mode: 0o700 }); }
  catch { throw new Error("Writer state is locked by another operation; retry without starting a worker"); }
  try { return operation(); } finally { rmSync(place.lock, { recursive: true }); }
}
function summary(ledger: Ledger) {
  return { runtime: ledger.runtime, workerId: ledger.workerId, agentName: ledger.binding.agentName,
    definitionDigest: ledger.binding.digest, branch: ledger.branch, worktree: ledger.worktree,
    queuedRequestIds: ledger.pending.map((item) => item.id), activeRequestId: ledger.active?.id,
    status: ledger.active?.status, running: Boolean(ledger.active?.lease), processGroupId: ledger.active?.processGroupId };
}

function proveGroupStopped(processGroupId: number) {
  if (process.platform === "win32") throw new Error("Owned process-group proof is unsupported on this platform");
  try { process.kill(-processGroupId, 0); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw new Error("Unable to prove the owned process group stopped; retain the lease");
  }
  throw new Error("Owned process group is still running; retain the lease");
}
