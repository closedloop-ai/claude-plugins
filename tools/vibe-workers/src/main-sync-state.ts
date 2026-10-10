import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { git, readSessionRecord } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { isOwnedPrototypeSession } from "../../../plugins/vibe/skills/vibe/scripts/prototype-session.mjs";
import { checkoutLocation, readWriterSummary, verifySourceTurn } from "./ledger.js";
import { nativeRecordOwnerSchema } from "./native-record.js";
import { isPublisherContext, isRequestContext } from "./record-context.js";
import { MainSyncError, mainSyncInputSchema, mainSyncReceiptSchema, mainSyncStateSchema, operationContextSchema, sessionSchema,
  type MainSyncState, type OperationContext } from "./main-sync-contracts.js";

export const MAIN_SYNC_FILE = "vibe-main-sync.json";
export const CLAUDE_OPERATION_OWNER = "claude-operation-owner.json";
const MAX_PRIVATE_BYTES = 1024 * 1024;
const claudeOwnerSchema = z.object({ context: operationContextSchema, branch: z.string(),
  primaryOwner: z.object({ workerId: z.string(), lease: z.string().uuid() }).strict().optional() }).strict();

/** Resolves the same active private session and its canonical Git metadata before any operation. */
export function syncLocation(worktree: string) {
  const place = checkoutLocation(worktree);
  readPrivateJson(join(place.dir, "vibe-session.json"));
  const session = sessionSchema.parse(readSessionRecord(place.root));
  if (session.branch !== place.branch || (session.worktree && realpathSync(session.worktree) !== place.root)
    || (session.branch.startsWith("prototype/") ? session.mode !== null || !isOwnedPrototypeSession(session, place.branch) : session.mode === null)) {
    throw new MainSyncError("Main-sync requires the exact active owned session branch and mode");
  }
  return { ...place, session };
}

/** Borrows only the caller's current exact record turn; the parent remains its cleanup owner. */
export function syncContext(raw: unknown, operation: "prepare" | "inputs" | "validate" | "push" | "request" | "share") {
  const input = mainSyncInputSchema.parse(raw);
  const place = syncLocation(input.context.worktree);
  const context = { ...input.context, worktree: realpathSync(input.context.worktree) };
  const lock = join(place.dir, "vibe-record-turn.lock");
  let actual: OperationContext;
  let primaryOwner: { workerId: string; lease: string } | undefined;
  if (context.runtime === "codex") {
    const owner = nativeRecordOwnerSchema.parse(readPrivateJson(join(lock, "native-owner.json")));
    if (owner.branch !== place.branch || owner.targetDir || owner.grant.sessionless) throw new MainSyncError("Publishing requires its normal owned session turn");
    const grant = owner.grant;
    if (grant.mode !== "record" || !grant.exclusiveRecordTurn || !grant.recordAction) throw new MainSyncError("Main-sync requires an exclusive declared record grant");
    actual = { runtime: "codex", worktree: grant.worktree, agentName: grant.agentName, mode: "record",
      recordAction: grant.recordAction, workerId: grant.workerId, requestId: grant.requestId,
      lease: owner.lease, ...(grant.publicationPurpose ? { publicationPurpose: grant.publicationPurpose } : {}),
      ...(grant.mainSyncTransactionId ? { mainSyncTransactionId: grant.mainSyncTransactionId } : {}),
      ...(grant.mainSyncRequestContinuations ? { mainSyncRequestContinuations: grant.mainSyncRequestContinuations } : {}) };
    if (grant.mainSyncCiRun) actual.mainSyncCiRun = grant.mainSyncCiRun;
    if (grant.mainSyncValidation) actual.mainSyncValidation = grant.mainSyncValidation;
    primaryOwner = grant.primaryOwner;
  } else {
    const owner = claudeOwnerSchema.parse(readPrivateJson(join(lock, CLAUDE_OPERATION_OWNER)));
    if (owner.branch !== place.branch) throw new MainSyncError("Claude operation belongs to another branch");
    actual = owner.context;
    primaryOwner = owner.primaryOwner;
  }
  if (actual.worktree !== place.root || actual.agentName !== context.agentName || actual.workerId !== context.workerId
    || actual.requestId !== context.requestId || actual.lease !== context.lease || actual.recordAction !== context.recordAction
    || (actual.publicationPurpose ?? "build") !== (context.publicationPurpose ?? "build")
    || actual.mainSyncTransactionId !== context.mainSyncTransactionId
    || JSON.stringify(actual.mainSyncRequestContinuations) !== JSON.stringify(context.mainSyncRequestContinuations)) {
    throw new MainSyncError("Main-sync requires the exact current owner, role, action and purpose");
  }
  if (JSON.stringify(actual.mainSyncCiRun) !== JSON.stringify(context.mainSyncCiRun)) {
    throw new MainSyncError("CI locator must match the actual parent-issued source grant");
  }
  if (JSON.stringify(actual.mainSyncValidation) !== JSON.stringify(context.mainSyncValidation)) {
    throw new MainSyncError("Canonical validation witness must match the actual Root-issued grant");
  }
  const role = { ...actual, exclusiveRecordTurn: true as const };
  const writer = readWriterSummary(place.root);
  if (operation === "validate" || operation === "inputs") {
    if (actual.agentName !== "vibe-change-worker" || actual.recordAction !== "progress" || !primaryOwner
      || writer?.runtime !== actual.runtime || writer.workerId !== actual.workerId
      || writer.activeRequestId !== actual.requestId || !writer.running || primaryOwner.workerId !== actual.workerId) {
      throw new MainSyncError("Validation requires the same registered source writer's exact active record continuation");
    }
    if (verifySourceTurn(place.root, actual.workerId, actual.requestId, primaryOwner.lease) !== actual.runtime) {
      throw new MainSyncError("Source validation runtime changed");
    }
  } else {
    const allowed = operation === "request" ? isRequestContext(role) : isPublisherContext(role);
    if (!allowed || writer?.running) throw new MainSyncError("This exact role/action cannot prepare or publish; request-only grants never gain push rights");
    if (operation === "share" && actual.agentName !== "vibe-prototype-worker") throw new MainSyncError("Canonical share requires the owned prototype publisher");
  }
  return { input, place, context: actual, purpose: actual.publicationPurpose ?? "build" };
}

/** Reads bounded regular private metadata, refusing symlink and partial/malformed proof inputs. */
export function readPrivateJson(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PRIVATE_BYTES) throw new MainSyncError("Private main-sync evidence must be a bounded regular file");
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Writes one private receipt atomically without following an existing proof symlink. */
export function saveSyncReceipt(dir: string, receipt: MainSyncState) {
  const file = join(dir, MAIN_SYNC_FILE);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new MainSyncError("Main-sync receipt cannot be a symlink");
  const serialized = JSON.stringify(mainSyncStateSchema.parse(receipt));
  if (Buffer.byteLength(serialized, "utf8") > MAX_PRIVATE_BYTES) {
    throw new MainSyncError("Complete main-sync receipt exceeds the unchanged private byte bound; prior evidence is preserved", "NEEDS_CHANGE");
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, serialized, { mode: 0o600, flag: "wx" }); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}

/** Current state never promotes an old/missing receipt or a different session/operator into trust. */
export function requireSyncReceipt(value: ReturnType<typeof syncContext>) {
  const file = join(value.place.dir, MAIN_SYNC_FILE);
  if (!existsSync(file)) throw new MainSyncError("Canonical redeploy required: no fresh main-sync transaction", "NEEDS_CHANGE");
  const state = mainSyncStateSchema.parse(readPrivateJson(file));
  const receipt = state.phase === "input-readiness" ? state.previous : state;
  if (!receipt) throw new MainSyncError("Canonical redeploy required: inputs are ready but main has not been captured", "NEEDS_CHANGE");
  if (receipt.worktree !== value.place.root || receipt.branch !== value.place.branch
    || receipt.operator.id !== value.place.session.operator.id || receipt.operator.email !== value.place.session.operator.email
    || receipt.originalBase !== value.place.session.baseCommit || receipt.purpose !== value.purpose
    || !value.context.mainSyncTransactionId || receipt.transactionId !== value.context.mainSyncTransactionId
    || (value.input.transactionId && value.input.transactionId !== receipt.transactionId)) {
    throw new MainSyncError("Canonical redeploy required: main-sync transaction context changed", "NEEDS_CHANGE");
  }
  return receipt;
}

/** A commit's exact tree is the publication identity, not the mutable tracking ref or task text. */
export function committedIdentity(root: string) {
  if (existsSync(resolve(root, git(root, ["rev-parse", "--git-path", "MERGE_HEAD"])))) throw new MainSyncError("ROOT must finish the ordinary merge before validation", "NEEDS_COMMIT");
  return { headSha: git(root, ["rev-parse", "HEAD"]), treeSha: git(root, ["rev-parse", "HEAD^{tree}"]) };
}

export function digest(text: string | Buffer) { return createHash("sha256").update(text).digest("hex"); }
