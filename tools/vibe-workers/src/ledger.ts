import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { actionSchema, capabilityIdentity, dropPendingSchema, ledgerSchema, migrateSchema, registerSchema, requireSupportedCapabilities, type Capability, type Ledger, type RetainedRecord } from "./contracts.js";
import { recordModes } from "./record-context.js";
import { isVibePlugin } from "../../../plugins/vibe/shared/plugin-roots.mjs";
import { sessionBinding } from "../../../plugins/vibe/lib/vibe/scripts/provider.mjs";
import { assertIsolatedTestRead } from "../../../plugins/vibe/lib/vibe/scripts/test-state-isolation.mjs";
import { observeDefinitionDigest, readDefinition } from "./definition.js";
import { installedPluginRoot, readPluginManifest } from "./plugin-root.js";
import { readReferenceImages } from "./reference-images.js";
import { WorkerRefusal } from "./worker-refusal.js";

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
  return sessionPlace(checkoutLocation(worktree));
}

/** The session check of `location` for a checkout the caller already resolved. */
export function sessionPlace(place: ReturnType<typeof checkoutLocation>) {
  const file = join(place.dir, "vibe-session.json");
  assertIsolatedTestRead(file);
  const record = z.object({ worktree: z.string().optional(), branch: z.string() }).passthrough().parse(
    JSON.parse(readFileSync(file, "utf8")),
  );
  if ((record.worktree && realpathSync(record.worktree) !== place.root) || record.branch !== place.branch) throw new Error("Session worktree or branch changed");
  return place;
}

/** Compact identity only; private queued inputs remain in git metadata. */
export function readWriterSummary(worktree: string) {
  const place = writerLocation(worktree);
  if (!existsSync(place.file)) return undefined;
  const ledger = readLedger(place);
  return { ...summary(ledger), recordedDefinition: recordedDefinitionState(ledger) };
}

/**
 * Whether the writer can run under this installed release: `removed` (a plugin update deleted its root) and
 * `changed` (the recorded or proven newer installed definition differs) need migration before launch
 * (a launch failed after three minutes and a setup worker migrated four minutes later).
 */
function recordedDefinitionState(ledger: Ledger): "present" | "removed" | "changed" | "unreadable" {
  try {
    const evidence = definitionUpgradeEvidence(ledger, installedPluginRoot(import.meta.url));
    if (evidence.observedDigest === null) return "removed";
    if (evidence.observedDigest !== evidence.recordedDigest) return "changed";
    if (evidence.sameRelease) return "present";
    if (evidence.provenNewer) return evidence.installedDigest === evidence.recordedDigest ? "present" : "changed";
    return "unreadable";
  } catch { return "unreadable"; }
}

/** The persistent writer's recorded definition root, so a resumed writer keeps its binding; undefined without one. */
export function recordedWriterRoot(worktree: string): string | undefined {
  try {
    const place = writerLocation(worktree);
    return existsSync(place.file) ? readLedger(place).binding.agentRoot : undefined;
  } catch { return undefined; }
}

/** Compare both roots with the persisted binding, using its capabilities rather than caller-supplied ones. */
function definitionUpgradeEvidence(ledger: Ledger, installedRoot: string) {
  const { agentRoot, agentName, capabilities, digest } = ledger.binding;
  const observedDigest = observeDefinitionDigest(agentRoot, agentName, capabilities);
  const installed = readDefinition(installedRoot, agentName, capabilities);
  const recordedVersion = observedDigest === null ? undefined : readPluginManifest(agentRoot).version;
  const cacheVersion = isVibePlugin(basename(dirname(agentRoot))) ? basename(agentRoot) : undefined;
  const provenNewer = typeof recordedVersion === "string" && cacheVersion === recordedVersion
    && Boolean(installed.version && isNewerRelease(installed.version, cacheVersion));
  // A versioned cache root whose manifest disagrees with its directory has no trusted release provenance.
  const sameRelease = typeof recordedVersion === "string" && recordedVersion === installed.version
    && (!cacheVersion || cacheVersion === recordedVersion);
  return { recordedRoot: agentRoot, recordedDigest: digest, observedDigest, installedDigest: installed.binding.digest,
    sameRelease, provenNewer };
}

/** Read-only upgrade decision for the installed Claude launcher; migration uses the same evidence under the ledger lock. */
export function readWriterUpgradeEvidence(worktree: string, installedRoot: string) {
  return definitionUpgradeEvidence(readLedger(writerLocation(worktree)), installedRoot);
}

/** Resume and migration use one compatibility predicate for the recorded and installed definitions. */
export function writerUpgradeCompatible(evidence: ReturnType<typeof definitionUpgradeEvidence>) {
  const unchangedUpgrade = evidence.provenNewer && evidence.installedDigest === evidence.recordedDigest;
  return evidence.observedDigest === evidence.recordedDigest && (evidence.sameRelease || unchangedUpgrade);
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
  requireSupportedCapabilities(data.capabilities, sessionBinding(data.worktree));
  const definition = readDefinition(data.agentRoot, data.agentName, data.capabilities);
  if (data.agentName !== "vibe-change-worker") throw new Error("Session writer must be vibe-change-worker");
  if (data.runtime === "codex" && !data.workerId) throw new Error("Native writer registration requires its worker ID");
  const place = writerLocation(data.worktree);
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
 * cannot run to the other harness, retaining every prior state. A harness switch requires the capabilities in the new
 * runtime's names. Supplied capabilities for a Claude binding keep only the record writes some change-worker action
 * declares, since the Claude launcher refuses any other; capabilities left out keep the recorded binding as it is.
 * A switch or a definition change may add only what the current definition declares. A same-runtime rebind whose capabilities differ from the recorded ones only
 * in naming (`capabilityIdentity`) is allowed, so a writer a harness switch left with the old runtime's names can run.
 * With a verifier and the parent's stopped-turn evidence, it also releases the writer's own record grant
 * that only the removed definition could have released, in the same atomic ledger update.
 */
export function migrateWriter(input: unknown, currentPluginRoot: string, verifyRetained?: StrandedRecordVerifier) {
  const data = migrateSchema.parse(input);
  if (data.harnessSwitch && !data.capabilities) {
    throw new Error("A harness switch requires the capabilities the parent discovered in the new runtime's names; the recorded ones are spelled for the old runtime");
  }
  if (data.capabilities) requireSupportedCapabilities(data.capabilities, sessionBinding(data.worktree));
  const currentDefinition = (capabilities: Capability[]) => {
    const found = readDefinition(currentPluginRoot, "vibe-change-worker", capabilities);
    if (realpathSync(data.agentRoot) !== found.root || data.agentName !== "vibe-change-worker") {
      throw new Error("Migration must use this command's current canonical plugin definition");
    }
    const version = found.version;
    if (!version) throw new Error("Current plugin release has no version");
    return found;
  };
  if (data.capabilities) currentDefinition(data.capabilities);
  const place = location(data.worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (ledger.runtime !== data.runtime || ledger.workerId !== data.previousWorkerId
      || ledger.binding.digest !== data.previousDigest) throw new Error("Migration requires the exact recorded writer and digest");
    const runtime = data.harnessSwitch?.to ?? data.runtime;
    // Capabilities left out keep the recorded binding as it is, with no provider read: a plugin update migrates a
    // stranded writer this way even while the update's check left the provider unprobed.
    const capabilities = data.capabilities ? keptCapabilities(data.worktree, runtime, data.capabilities) : ledger.binding.capabilities;
    const definition = currentDefinition(capabilities);
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
    if (harnessSwitch) refuseDroppedCapabilities(keptCapabilities(ledger.worktree, runtime, ledger.binding.capabilities), capabilities);
    const evidence = definitionUpgradeEvidence(ledger, currentPluginRoot);
    const observedDigest = evidence.observedDigest;
    const reason = harnessSwitch ? "harness-switch" as const
      : renamedOnly(ledger, data.runtime, data.capabilities, capabilities, evidence) ? "capability-names" as const : provenDefinitionChange(evidence);
    // A naming-only rebind refuses any addition itself (renamedOnly); the other paths rebind to the current definition.
    if (reason !== "capability-names") refuseUndeclaredAdditions(ledger, capabilities);
    const releasedRecord = retained && data.retainedRecord && verifyRetained
      ? verifyRetained(lock, ledger, data.retainedRecord) : undefined;
    const block = migratableBlock(ledger, evidence, releasedRecord);
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
    // The new writer starts with no memory of the old turn, so ROOT's continuation needs the block it settles.
    const carriedBlock = block === "carried" && ledger.active ? { requestId: ledger.active.id,
      blockReason: ledger.active.blockReason, resultSummary: ledger.active.resultSummary } : undefined;
    if (!releasedRecord) save(place, ledger);
    else {
      // Park the grant first so a failed ledger write restores it; the record mutex never vanishes without migration.
      const parked = `${lock}.${randomUUID()}.released`;
      renameSync(lock, parked);
      try { save(place, ledger); } catch (error) { renameSync(parked, lock); throw error; }
      rmSync(parked, { recursive: true, force: true });
    }
    return { ...summary(ledger), capabilities: ledger.binding.capabilities, ...(carriedBlock ? { carriedBlock } : {}) };
  });
}

/**
 * A harness switch renames capabilities into the new runtime's spelling and may drop the writes it does not declare,
 * never another: the new binding holds, under one name or the other, every recorded capability the new runtime keeps
 * (`kept`). A dropped one could not come back, since a later rebind refuses any change but naming.
 */
function refuseDroppedCapabilities(kept: Capability[], target: Capability[]) {
  const present = new Set(target.map(capabilityIdentity));
  const dropped = kept.filter((capability) => !present.has(capabilityIdentity(capability))).map((capability) => capability.name).sort().join(", ");
  if (dropped) throw new Error(`A harness switch may rename capabilities and drop undeclared writes, never drop a declared one: ${dropped}`);
}

/**
 * Every migration that rebinds to the current definition (a harness switch, or a missing or upgraded definition) may
 * add a capability the recorded binding lacks only when the current definition declares it: a read the bound provider
 * offers, or a record write some change-worker action declares. A release can make a provider read bindable and require
 * it in the change worker's prompt, and a writer registered before that gains it only here. Any other addition refuses.
 */
function refuseUndeclaredAdditions(ledger: Ledger, target: Capability[]) {
  const known = new Set(ledger.binding.capabilities.map(capabilityIdentity));
  const added = target.filter((capability) => !known.has(capabilityIdentity(capability)));
  // Only an addition is checked against the definition, so a migration that adds nothing never reads the provider.
  if (!added.length) return;
  const declared = new Set(declaredByChangeWorker(ledger.worktree, added).map(capabilityIdentity));
  const undeclared = added.filter((capability) => !declared.has(capabilityIdentity(capability)));
  if (undeclared.length) {
    throw new Error(`A migration may add only the capabilities the current definition declares: ${undeclared.map((capability) => capability.name).sort().join(", ")}`);
  }
}

/** The recorded `capabilities` a `runtime` binding keeps: every one for Codex, and only the declared ones for Claude. */
function keptCapabilities(worktree: string, runtime: Ledger["runtime"], capabilities: Capability[]) {
  return runtime === "claude" ? declaredByChangeWorker(worktree, capabilities) : capabilities;
}

/** Reads, and only the record writes some change-worker record action declares: the Claude launcher refuses any other. */
function declaredByChangeWorker(worktree: string, capabilities: Capability[]) {
  const declared = new Set(Object.values(recordModes(sessionBinding(worktree))["vibe-change-worker"] ?? {}).flat());
  return capabilities.filter((capability) => capability.access === "read" || declared.has(capability.operation));
}

/**
 * A same-runtime rebind whose definitions still match and whose new binding `target` (the `supplied` capabilities,
 * less the writes the runtime does not declare) differs from the recorded binding, as recorded, only in naming and in
 * dropping writes the runtime does not declare. Nothing supplied, or nothing different, is no rebind; adding a
 * capability, or dropping or changing a declared one, refuses here.
 */
function renamedOnly(ledger: Ledger, runtime: Ledger["runtime"], supplied: Capability[] | undefined, target: Capability[],
  evidence: ReturnType<typeof definitionUpgradeEvidence>) {
  if (!supplied || runtime !== ledger.runtime || evidence.observedDigest !== evidence.recordedDigest
    || evidence.installedDigest !== evidence.recordedDigest) return false;
  const names = (values: Capability[]) => JSON.stringify(values.map((value) => value.name).sort());
  if (names(target) === names(ledger.binding.capabilities)) return false;
  const kept = keptCapabilities(ledger.worktree, runtime, ledger.binding.capabilities);
  const identities = (values: Capability[]) => JSON.stringify(values.map(capabilityIdentity).sort());
  if (identities(target) !== identities(kept)) {
    throw new Error("A rebind may change capabilities only in naming and by dropping record writes the runtime does not declare; the supplied capabilities add, drop or change one");
  }
  return true;
}

/** Only an absent recorded definition or a proven newer installed definition replaces the writer. */
function provenDefinitionChange(evidence: ReturnType<typeof definitionUpgradeEvidence>) {
  if (evidence.observedDigest === null) return "definition-missing" as const;
  if (evidence.observedDigest === evidence.recordedDigest && evidence.installedDigest === evidence.recordedDigest) {
    throw new Error("Recorded and installed definitions are present and matching; resume the existing writer");
  }
  if (!evidence.provenNewer) {
    throw new Error("Digest mismatch has no proven plugin version upgrade; retain the original writer");
  }
  return "definition-upgraded" as const;
}

/**
 * A BLOCKED request whose recorded cause is the removed definition migrates. A ledger written before block
 * reasons existed carries none; there the writer's own unreleasable grant for that request, under an absent
 * definition, is the mechanical proof of that cause.
 * Any other BLOCKED request migrates when the recorded definition is absent, or when an intact cached definition
 * belongs to a proven older release and differs from the installed definition. In either state the launcher refuses
 * the old writer, so migration carries the request unchanged and `claim` admits nothing else until it is continued.
 */
function migratableBlock(ledger: Ledger, evidence: ReturnType<typeof definitionUpgradeEvidence>,
  releasedRecord: ReturnType<StrandedRecordVerifier> | undefined) {
  const active = ledger.active;
  if (active?.status !== "BLOCKED" || active.blockReason === "recorded-definition-removed") return "migratable";
  if (active.blockReason === undefined && evidence.observedDigest === null && releasedRecord?.requestId === active.id) return "proven-legacy";
  if (evidence.observedDigest === null
    || (!writerUpgradeCompatible(evidence) && evidence.provenNewer && evidence.observedDigest === evidence.recordedDigest)) return "carried";
  throw new Error("Migration cannot bypass a writer refusal while the recorded writer can still run; resolve the blocked request first");
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

function activeContinuationSummary(requestId: string, queuedId?: string) {
  const continuation = `Continue active requestId "${requestId}" with {"requestId":"${requestId}","continuation":"<next step>"}`;
  return queuedId
    ? `${continuation} first; requestId "${queuedId}" stays queued: claim it by id after that, or cancel it with writer-state.mjs drop-pending.`
    : `${continuation}; the refused request was not queued.`;
}

function oldestPendingSummary(ledger: Ledger) {
  const next = ledger.pending[0]?.id;
  return next ? `Claim the oldest pending requestId "${next}" without input or continuation.`
    : "There is no oldest pending request to claim. Use a new requestId with original input.";
}

function duplicateRefusal(ledger: Ledger, requestId: string) {
  const queued = ledger.pending.some((item) => item.id === requestId) ? requestId : undefined;
  const recovery = ledger.active ? activeContinuationSummary(ledger.active.id, queued) : oldestPendingSummary(ledger);
  return new WorkerRefusal("REQUEST_ID_EXISTS", `Request ID "${requestId}" already exists. ${recovery}`);
}

function inputDigest(input: string) { return createHash("sha256").update(input).digest("hex"); }

/** Drop a parent's obsolete request under the same mutex, without touching active work or exposing queued input. */
export function dropPendingWriter(input: unknown) {
  const data = dropPendingSchema.parse(input);
  const place = writerLocation(data.worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (data.workerId !== ledger.workerId) throw new WorkerRefusal("WRITER_ID_MISMATCH", "The request must name the registered persistent writer.");
    if (existsSync(join(place.dir, "vibe-record-turn.lock"))) throw new WorkerRefusal("WRITER_BUSY", "Wait for the owned record turn before dropping pending work.");
    const index = ledger.pending.findIndex((item) => item.id === data.requestId);
    const pending = ledger.pending[index];
    if (!pending) throw new WorkerRefusal("REQUEST_NOT_PENDING", `Request ID "${data.requestId}" is not pending. ${ledger.active ? activeContinuationSummary(ledger.active.id) : oldestPendingSummary(ledger)}`);
    if (inputDigest(pending.input) !== data.evidence.inputSha256) throw new WorkerRefusal("PENDING_INPUT_MISMATCH",
      `Request ID "${data.requestId}" does not match the parent's evidence. Check its inputSha256 with writer-state status.`);
    ledger.pending.splice(index, 1);
    ledger.dropped = [...(ledger.dropped ?? []).slice(-63), { id: data.requestId, ...data.evidence, at: new Date().toISOString() }];
    save(place, ledger);
    return summary(ledger);
  });
}

/** Serialized mutations preserve active requests across review, person and commit continuations. */
export function changeWriter(action: "enqueue" | "start" | "claim" | "finish", input: unknown) {
  const data = actionSchema.parse(input);
  const place = writerLocation(data.worktree);
  return locked(place, () => {
    const ledger = readLedger(place);
    if (data.workerId !== ledger.workerId) throw new WorkerRefusal("WRITER_ID_MISMATCH",
      "The request must name the registered persistent writer.");
    const requestId = data.requestId;
    if (!requestId) throw new WorkerRefusal("REQUEST_ID_REQUIRED", "A requestId is required.");
    const duplicateRequest = () => ledger.pending.some((item) => item.id === requestId)
      || ledger.active?.id === requestId || ledger.completed.includes(requestId) || ledger.dropped?.some((item) => item.id === requestId);
    const prepareClaim = () => {
      if (existsSync(join(place.dir, "vibe-record-turn.lock"))) {
        throw new WorkerRefusal("WRITER_BUSY", "A record turn is already running; retain the queued writer request.");
      }
      if (ledger.active?.lease && ledger.runtime === "claude" && staleClaudeLease(ledger.active)) {
        ledger.active.status = "FAILED";
        ledger.active.resultSummary = "The launcher that owned this turn stopped; the turn was closed.";
        delete ledger.active.lease;
        delete ledger.active.ownerPid;
        delete ledger.active.processGroupId;
        delete ledger.active.continuation;
      }
      if (ledger.active?.lease) throw new WorkerRefusal("WRITER_BUSY", "The writer already has an owned running turn.");
    };
    const claim = (continuation?: string) => {
      prepareClaim();
      // A stopped or rejected turn finishes FAILED. A new request supersedes it
      // instead of waiting on a continuation nobody sends.
      if (ledger.active?.status === "FAILED" && !continuation && ledger.pending[0]?.id === requestId) {
        ledger.completed = [...ledger.completed.slice(-63), ledger.active.id];
        delete ledger.active;
      }
      if (!ledger.active && continuation && ledger.completed.at(-1) === requestId) {
        // The writer's last request returned DONE and its follow-up step (the main-sync validation after the
        // input step) continues it: reopen that request rather than fail the continuation.
        ledger.completed = ledger.completed.slice(0, -1);
        ledger.active = { id: requestId, input: continuation, status: "PLAN", continuation };
      } else if (ledger.active) {
        if (ledger.active.id !== requestId || !continuation) throw new WorkerRefusal("ACTIVE_REQUEST_PENDING",
          activeContinuationSummary(ledger.active.id, ledger.pending.some((item) => item.id === requestId) ? requestId : undefined));
        ledger.active.continuation = continuation;
      } else {
        if (continuation || ledger.pending[0]?.id !== requestId) throw new WorkerRefusal("REQUEST_ORDER_INVALID", oldestPendingSummary(ledger));
        const next = ledger.pending.shift();
        if (!next) throw new WorkerRefusal("NO_PENDING_REQUEST", "There is no pending request to claim.");
        ledger.active = { ...next, status: "PLAN" };
      }
      ledger.active.lease = randomUUID();
      ledger.active.ownerPid = process.pid;
    };
    let queuedBehind: { requestId: string; status: string; next: string } | undefined;
    if (action === "enqueue") {
      if (!data.input || data.continuation) throw new WorkerRefusal("ENQUEUE_INPUT_REQUIRED", "Enqueue requires one original request input.");
      if (duplicateRequest()) throw duplicateRefusal(ledger, requestId);
      if (ledger.pending.length >= 32) throw new WorkerRefusal("REQUEST_QUEUE_FULL",
        "The pending queue is full; keep the new input with the parent.");
      ledger.pending.push({ id: requestId, input: data.input });
      // A request queued behind a stopped open one (BLOCKED, NEEDS_PERSON and the like) is not silent: claim
      // refuses it until that request is continued. A running turn reports its own completion.
      if (ledger.active && !ledger.active.lease && ledger.active.status !== "FAILED") {
        queuedBehind = { requestId: ledger.active.id, status: ledger.active.status,
          next: activeContinuationSummary(ledger.active.id, requestId) };
      }
    } else if (action === "start" && data.input && !data.continuation
      && ledger.pending.some((item) => item.id === requestId && item.input === data.input)) {
      // Relaunching a queued request with its own input claims it by id; other input stays a duplicate refusal.
      claim();
    } else if (action === "start") {
      if (!data.input || data.continuation) throw new WorkerRefusal("START_INPUT_REQUIRED", "Starting a request requires one original input.");
      if (duplicateRequest()) throw duplicateRefusal(ledger, requestId);
      prepareClaim();
      if (ledger.active?.status === "FAILED") {
        ledger.completed = [...ledger.completed.slice(-63), ledger.active.id];
        delete ledger.active;
      }
      if (ledger.active) throw new WorkerRefusal("ACTIVE_REQUEST_PENDING",
        activeContinuationSummary(ledger.active.id));
      if (ledger.pending.length) throw new WorkerRefusal("REQUEST_ORDER_INVALID", oldestPendingSummary(ledger));
      ledger.active = { id: requestId, input: data.input, status: "PLAN", lease: randomUUID(), ownerPid: process.pid };
    } else if (action === "claim") {
      claim(data.continuation);
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
    return { ...summary(ledger), ...(["start", "claim"].includes(action) ? { turn: ledger.active } : {}),
      ...(queuedBehind ? { queuedBehind } : {}) };
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
        throw new WorkerRefusal("WRITER_BUSY", "The implementation writer has a running turn; wait before changing shared records.");
      }
    } else if (owner) throw new Error("Record continuation requires its registered source writer");
    try { mkdirSync(file, { mode: 0o700 }); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new WorkerRefusal("WRITER_BUSY", "A record turn is already running; wait before changing shared records.");
      }
      throw error;
    }
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
  const place = writerLocation(worktree);
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
  const place = writerLocation(worktree);
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
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new WorkerRefusal("WRITER_BUSY", "Writer state is locked by another operation; retry without starting a worker.");
    }
    throw error;
  }
  try { return operation(); } finally { rmSync(place.lock, { recursive: true }); }
}
function summary(ledger: Ledger) {
  const lastMigration = ledger.migrations.at(-1);
  return { runtime: ledger.runtime, workerId: ledger.workerId, agentName: ledger.binding.agentName,
    definitionDigest: ledger.binding.digest, branch: ledger.branch, worktree: ledger.worktree,
    queuedRequestIds: ledger.pending.map((item) => item.id), activeRequestId: ledger.active?.id,
    queuedRequests: ledger.pending.map((item) => ({ requestId: item.id, inputSha256: inputDigest(item.input) })),
    droppedRequestIds: ledger.dropped?.map((item) => item.id) ?? [],
    status: ledger.active?.status, running: Boolean(ledger.active?.lease), processGroupId: ledger.active?.processGroupId,
    migrationCount: ledger.migrations.length,
    lastMigration: lastMigration ? { id: lastMigration.id, reason: lastMigration.reason, at: lastMigration.at } : undefined };
}

/** A Claude turn whose launcher process is gone and whose process group, if any, has stopped. */
function staleClaudeLease(active: { ownerPid?: number | undefined; processGroupId?: number | undefined }) {
  if (!(typeof active.ownerPid === "number" && active.ownerPid > 1) || signalReaches(active.ownerPid)) return false;
  return !(typeof active.processGroupId === "number" && active.processGroupId > 1) || !signalReaches(-active.processGroupId);
}

function signalReaches(target: number) {
  try { process.kill(target, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
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

const TAKEOVER_RECORD = "vibe-takeover.json";
const takeoverRecordSchema = z.object({ version: z.literal(1), kind: z.literal("takeover"), worktree: z.string().min(1),
  branch: z.string().min(1), prUrl: z.string().min(1), headSha: z.string().regex(/^[0-9a-f]{40}$/),
  sourceBranch: z.string().min(1) }).strict();
export type TakeoverBinding = Pick<z.infer<typeof takeoverRecordSchema>, "prUrl" | "headSha" | "sourceBranch">;

/**
 * The persistent writer's ledger lives beside the private session record, or, in an engineer PR takeover with no
 * session, beside the launcher-written takeover record that stands in for it. Every other session operation keeps
 * requiring the real session record through `location`.
 */
function writerLocation(worktree: string) {
  const place = checkoutLocation(worktree);
  const file = join(place.dir, TAKEOVER_RECORD);
  if (existsSync(join(place.dir, "vibe-session.json")) || !existsSync(file)) return sessionPlace(place);
  const record = takeoverRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (realpathSync(record.worktree) !== place.root || record.branch !== place.branch) throw new Error("Takeover worktree or branch changed");
  return place;
}

/**
 * Binds one takeover worktree to one pull request and source branch before its writer registers. The first launch
 * writes the record; a later launch for another pull request or source branch is a second writer and is refused.
 */
export function bindTakeoverWriter(worktree: string, binding: TakeoverBinding) {
  const place = checkoutLocation(worktree);
  const file = join(place.dir, TAKEOVER_RECORD);
  const record = { version: 1 as const, kind: "takeover" as const, worktree: place.root, branch: place.branch, ...binding };
  return locked(place, () => {
    if (!existsSync(file)) {
      if (existsSync(place.file)) throw new Error("Takeover worktree already has a writer from another binding");
      writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      return record;
    }
    const existing = takeoverRecordSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (existing.worktree !== record.worktree || existing.branch !== record.branch || existing.prUrl !== record.prUrl
      || existing.sourceBranch !== record.sourceBranch) {
      throw new Error("Takeover worktree already has a writer bound to another pull request or source branch");
    }
    return existing;
  });
}
