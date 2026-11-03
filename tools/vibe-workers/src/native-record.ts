import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { identifierSchema, workerIdSchema, type Ledger, type RetainedRecord } from "./contracts.js";
import { observeDefinitionDigest, readDefinition } from "./definition.js";
import { acquireRecordTurnAt, checkoutLocation, location, readWriterSummary, releaseRecordTurnAt } from "./ledger.js";
import { recordContextSchema, recordModes, resolveRecordContext } from "./record-context.js";

const grantSchema = recordContextSchema.extend({ agentRoot: z.string().min(1), workerId: workerIdSchema,
  requestId: identifierSchema, primaryOwner: z.object({ workerId: workerIdSchema, lease: z.string().uuid() }).strict().optional(),
}).strict();
const releaseSchema = grantSchema.extend({ lease: z.string().uuid(), stoppedTurn: z.object({ runtime: z.literal("codex"),
  workerId: workerIdSchema, requestId: identifierSchema, lease: z.string().uuid(),
  state: z.enum(["completed", "failed", "canceled"]) }).strict() }).strict();
export const nativeRecordOwnerSchema = z.object({ grant: grantSchema, lease: z.string().uuid(), branch: z.string(), targetDir: z.string().optional() }).strict();
const ownerFile = "native-owner.json";

/** Acquires the existing source/record mutex for one exact native helper turn, never its short coordinator process. */
export function acquireNativeRecord(input: unknown) {
  const grant = grantSchema.parse(input);
  if (grant.mode !== "record" || !grant.exclusiveRecordTurn || !grant.recordAction
    || !recordModes[grant.agentName]?.[grant.recordAction]) throw new Error("Native record grant requires an exclusive canonical role/action");
  const definition = readDefinition(grant.agentRoot, grant.agentName, []);
  grant.agentRoot = definition.root;
  if (grant.primaryOwner && (grant.agentName !== "vibe-change-worker" || grant.primaryOwner.workerId !== grant.workerId)) {
    throw new Error("Only the exact primary writer may acquire its own record continuation");
  }
  const { place, target } = resolveRecordContext(grant);
  if (grant.agentName === "vibe-change-worker") {
    const writer = readWriterSummary(grant.worktree);
    if (writer?.runtime !== "codex" || writer.workerId !== grant.workerId || !writer.running
      || !grant.primaryOwner || writer.activeRequestId !== grant.requestId) {
      throw new Error("Primary record continuation must name the registered native writer and exact active request");
    }
  }
  grant.worktree = place.root;
  let targetLock: string | undefined;
  let lock: string | undefined;
  try {
    if (target) targetLock = acquireRecordTurnAt(target);
    lock = acquireRecordTurnAt(place, grant.primaryOwner);
    const lease = randomUUID();
    writeFileSync(join(lock, ownerFile), JSON.stringify({ grant, lease, branch: place.branch,
      ...(target ? { targetDir: target.dir } : {}) }), { mode: 0o600, flag: "wx" });
    return { workerId: grant.workerId, requestId: grant.requestId, lease, agentName: grant.agentName, recordAction: grant.recordAction };
  } catch (error) {
    if (lock) rmSync(lock, { recursive: true });
    if (targetLock) rmSync(targetLock, { recursive: true, force: true });
    throw error;
  }
}

/** Retains the grant until the parent supplies matching native completion or owned-termination evidence. */
export function releaseNativeRecord(input: unknown) {
  const data = releaseSchema.parse(input);
  const { lease, stoppedTurn, ...grant } = data;
  // A plugin upgrade deletes older version directories. A helper's grant is then released against the root it
  // recorded at acquisition; the writer's own continuation keeps quality-loop.md's stranded `migrate` path.
  if (grant.primaryOwner || observeDefinitionDigest(grant.agentRoot, grant.agentName, []) !== null) {
    grant.agentRoot = readDefinition(grant.agentRoot, grant.agentName, []).root;
  }
  const place = grant.sessionless ? checkoutLocation(grant.worktree) : location(grant.worktree);
  grant.worktree = place.root;
  releaseRecordTurnAt(place, (lock) => {
    const owner = nativeRecordOwnerSchema.parse(JSON.parse(readFileSync(join(lock, ownerFile), "utf8")));
    if (owner.lease !== lease || owner.branch !== place.branch || JSON.stringify(owner.grant) !== JSON.stringify(grant)
      || stoppedTurn.workerId !== grant.workerId || stoppedTurn.requestId !== grant.requestId || stoppedTurn.lease !== lease) {
      throw new Error("Native record release requires the exact owner's stopped-turn completion evidence");
    }
    if (owner.targetDir) rmSync(join(owner.targetDir, "vibe-record-turn.lock"), { recursive: true, force: true });
  });
  return { workerId: grant.workerId, requestId: grant.requestId, released: true };
}

/**
 * Accepts a retained grant for migration only when it is the registered writer's own record continuation for
 * its current or just-completed request, the parent proves that exact turn stopped, and the grant's recorded
 * definition is absent, so release-record can never verify it again.
 */
export function verifyStrandedRecordGrant(lock: string, ledger: Ledger, retained: RetainedRecord) {
  const owner = nativeRecordOwnerSchema.parse(JSON.parse(readFileSync(join(lock, ownerFile), "utf8")));
  const { grant } = owner;
  const { stoppedTurn } = retained;
  const ownRequest = ledger.active ? ledger.active.id === grant.requestId : ledger.completed.includes(grant.requestId);
  if (ledger.runtime !== "codex" || grant.agentName !== ledger.binding.agentName || grant.workerId !== ledger.workerId
    || grant.primaryOwner?.workerId !== ledger.workerId || grant.agentRoot !== ledger.binding.agentRoot
    || grant.worktree !== ledger.worktree || owner.branch !== ledger.branch || owner.targetDir !== undefined
    || !grant.recordAction || !ownRequest || owner.lease !== retained.lease || stoppedTurn.workerId !== grant.workerId
    || stoppedTurn.requestId !== grant.requestId || stoppedTurn.lease !== owner.lease) {
    throw new Error("Stranded recovery requires the registered writer's own record grant and its exact stopped-turn evidence");
  }
  if (observeDefinitionDigest(grant.agentRoot, grant.agentName, []) !== null) {
    throw new Error("The grant's recorded definition is present; release it with release-record");
  }
  return { requestId: grant.requestId, recordAction: grant.recordAction, state: stoppedTurn.state };
}
