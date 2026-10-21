import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { actionSchema, ledgerSchema, migrateSchema, registerSchema, type Ledger, type RetainedRecord } from "./contracts.js";
import { observeDefinitionDigest, readDefinition } from "./definition.js";
import { readReferenceImages } from "./reference-images.js";

/** Resolves an exact existing checkout for pre-session operations or a parent-authorized cancellation. */
export function checkoutLocation(worktree: string) {
  const root = realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]));
  if (realpathSync(worktree) !== root) throw new Error("Use the session's exact worktree root");
  const metadata = git(root, ["rev-parse", "--absolute-git-dir", "--abbrev-ref", "HEAD"]);
  // Directory names may contain newlines; native branch names cannot.
  const separator = metadata.lastIndexOf("\n");
  if (separator < 0) throw new Error("Missing native checkout metadata boundary");
  const [dir, branch] = z.tuple([z.string().min(1).refine(isAbsolute), z.string().min(1)])
    .parse([metadata.slice(0, separator).trim(), metadata.slice(separator + 1).trim()]);
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

/** The persistent writer's recorded definition root, so a resumed writer keeps its binding; undefined without one. */
export function recordedWriterRoot(worktree: string): string | undefined {
  try {
    const place = location(worktree);
    return existsSync(place.file) ? readLedger(place).binding.agentRoot : undefined;
  } catch { return undefined; }
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
    const referenceImages = readReferenceImages(place.dir);
    return { workerId: ledger.workerId, requestId: ledger.active.id,
      originalInput: ledger.active.input, input: ledger.active.continuation ?? ledger.active.input,
      ...(referenceImages.length ? { referenceImages } : {}) };
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
      pending: [], completed: [], migrations: [] };
    save(place, ledger);
    return summary(ledger);
  });
}

/** Proves a retained record grant is the writer's own stranded continuation; returns what migration history keeps. */
export type StrandedRecordVerifier = (lock: string, ledger: Ledger, retained: RetainedRecord) => NonNullable<
  Ledger["migrations"][number]["releasedRecord"]>;

/**
 * Rebinds only a stopped writer with proven definition loss or upgrade, or moves a stopped writer whose runtime
 * cannot run to the other harness, retaining every prior state.
 * With a verifier and the parent's stopped-turn evidence, it also releases the writer's own record grant
 * that only the removed definition could have released, in the same atomic ledger update.
 */
export function migrateWriter(input: unknown, currentPluginRoot: string, verifyRetained?: StrandedRecordVerifier) {
  const data = migrateSchema.parse(input);
  const definition = readDefinition(currentPluginRoot, "vibe-change-worker", data.capabilities);
  if (realpathSync(data.agentRoot) !== definition.root || data.agentName !== "vibe-change-worker") {
    throw new Error("Migration must use this command's current canonical plugin definition");
  }
  const currentVersion = definition.version;
  if (!currentVersion) throw new Error("Current plugin release has no version");
  const place = location(data.worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (ledger.runtime !== data.runtime || ledger.workerId !== data.previousWorkerId
      || ledger.binding.digest !== data.previousDigest) throw new Error("Migration requires the exact recorded writer and digest");
    const lock = join(place.dir, "vibe-record-turn.lock");
    const retained = existsSync(lock);
    if (ledger.active?.lease || (retained && !(data.retainedRecord && verifyRetained))) {
      throw new Error("Wait for owned source and record turns to stop before migration");
    }
    if (!retained && data.retainedRecord) throw new Error("No retained record grant exists to release");
    const harnessSwitch = data.harnessSwitch;
    if (harnessSwitch && (harnessSwitch.to === ledger.runtime || data.retainedRecord)) {
      throw new Error("A harness switch moves a stopped writer to the other runtime and releases no record grant");
    }
    const observedDigest = observeDefinitionDigest(ledger.binding.agentRoot, ledger.binding.agentName, ledger.binding.capabilities);
    const reason = harnessSwitch ? "harness-switch" as const : provenDefinitionChange(ledger, observedDigest, currentVersion);
    const releasedRecord = retained && data.retainedRecord && verifyRetained
      ? verifyRetained(lock, ledger, data.retainedRecord) : undefined;
    const block = migratableBlock(ledger, observedDigest, releasedRecord);
    const runtime = harnessSwitch?.to ?? data.runtime;
    const workerId = runtime === "claude" ? randomUUID() : data.workerId;
    if (!workerId) throw new Error("Native migration requires the new read-only held worker's actual ID");
    const oldIds = [ledger.workerId, ...ledger.migrations.map((item) => item.previous.workerId)];
    if (oldIds.includes(workerId)) throw new Error("Migration requires a new writer identity");
    const { migrations, ...current } = ledger;
    const previous = structuredClone(current);
    ledger.migrations = [...migrations, { id: randomUUID(), at: new Date().toISOString(), reason,
      observedDigest, previous, workerId, binding: definition.binding, ...(releasedRecord ? { releasedRecord } : {}),
      ...(harnessSwitch ? { harnessSwitch: { ...harnessSwitch, from: ledger.runtime } } : {}) }];
    ledger.runtime = runtime;
    ledger.workerId = workerId;
    ledger.binding = definition.binding;
    ledger.started = false;
    if (block === "proven-legacy" && ledger.active) ledger.active.blockReason = "recorded-definition-removed";
    if (!releasedRecord) save(place, ledger);
    else {
      // Park the grant first so a failed ledger write restores it; the record mutex never vanishes without migration.
      const parked = `${lock}.${randomUUID()}.released`;
      renameSync(lock, parked);
      try { save(place, ledger); } catch (error) { renameSync(parked, lock); throw error; }
      rmSync(parked, { recursive: true, force: true });
    }
    return summary(ledger);
  });
}

/** Only a missing definition or a proven newer release replaces the recorded writer. */
function provenDefinitionChange(ledger: Ledger, observedDigest: string | null, currentVersion: string) {
  if (observedDigest === ledger.binding.digest) throw new Error("Recorded definition is present and matching; resume the existing writer");
  if (observedDigest === null) return "definition-missing" as const;
  // A recorded vibe/<semver> cache root supplies the original release, even after an in-place upgrade.
  const oldVersion = basename(dirname(ledger.binding.agentRoot)) === "vibe" ? basename(ledger.binding.agentRoot) : undefined;
  if (!oldVersion || !isNewerRelease(currentVersion, oldVersion)) {
    throw new Error("Digest mismatch has no proven plugin version upgrade; retain the original writer");
  }
  return "definition-upgraded" as const;
}

/**
 * A BLOCKED request migrates only when its recorded cause is the removed definition. A ledger written before
 * block reasons existed carries none; there the writer's own unreleasable grant for that request, under an
 * absent definition, is the mechanical proof of that cause.
 */
function migratableBlock(ledger: Ledger, observedDigest: string | null,
  releasedRecord: ReturnType<StrandedRecordVerifier> | undefined) {
  const active = ledger.active;
  if (active?.status !== "BLOCKED" || active.blockReason === "recorded-definition-removed") return "migratable";
  if (active.blockReason === undefined && observedDigest === null && releasedRecord?.requestId === active.id) return "proven-legacy";
  throw new Error("Migration cannot bypass a writer refusal; resolve the blocked request first");
}

/** Compare numeric release tuples; unknown release provenance fails closed. */
function isNewerRelease(current: string, previous: string) {
  if (!/^\d+\.\d+\.\d+$/.test(previous)) return false;
  const left = current.split(".").map(Number);
  const right = previous.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
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
      if (data.blockReason && data.status !== "BLOCKED") throw new Error("Only a BLOCKED finish carries a block reason");
      if (data.blockReason === "recorded-definition-removed" && observeDefinitionDigest(ledger.binding.agentRoot,
        ledger.binding.agentName, ledger.binding.capabilities) !== null) {
        throw new Error("The recorded definition is present; record the block's actual cause");
      }
      ledger.active.status = data.status;
      ledger.active.resultSummary = data.resultSummary;
      if (data.status === "BLOCKED") ledger.active.blockReason = data.blockReason ?? "other";
      else delete ledger.active.blockReason;
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
  const lastMigration = ledger.migrations.at(-1);
  return { runtime: ledger.runtime, workerId: ledger.workerId, agentName: ledger.binding.agentName,
    definitionDigest: ledger.binding.digest, branch: ledger.branch, worktree: ledger.worktree,
    queuedRequestIds: ledger.pending.map((item) => item.id), activeRequestId: ledger.active?.id,
    status: ledger.active?.status, running: Boolean(ledger.active?.lease), processGroupId: ledger.active?.processGroupId,
    migrationCount: ledger.migrations.length,
    lastMigration: lastMigration ? { id: lastMigration.id, reason: lastMigration.reason, at: lastMigration.at } : undefined };
}

function proveGroupStopped(processGroupId: number) {
  if (process.platform === "win32") throw new Error("Owned process-group proof is unsupported on this platform");
  if (!(processGroupId > 1)) throw new Error("Unable to prove the owned process group stopped; retain the lease");
  try { process.kill(-processGroupId, 0); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw new Error("Unable to prove the owned process group stopped; retain the lease");
  }
  throw new Error("Owned process group is still running; retain the lease");
}
