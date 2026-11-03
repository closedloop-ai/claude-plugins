import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { mainSyncStateSchema, sessionSchema, MainSyncError, type OperationContext } from "./main-sync-contracts.js";
import { verifyRecipeWitness, validationEnvelopeMs } from "./main-sync-validation-recipe.js";

/** Prelaunch option A reads bounded existing private data only; no source import, Git or other child execution. */
export async function deriveValidationEnvelope(context: OperationContext, dir: string, branch: string,
  canceled: () => boolean) {
  const witness = context.mainSyncValidation;
  if (!witness || context.agentName !== "vibe-change-worker" || context.recordAction !== "progress") {
    throw new MainSyncError("Root canonical source validation witness is required");
  }
  const state = mainSyncStateSchema.parse(await privateData(join(dir, "vibe-main-sync.json")));
  if (canceled()) throw new Error("Owned worker turn canceled before Claude spawn");
  const session = sessionSchema.parse(await privateData(join(dir, "vibe-session.json")));
  const receipt = state.phase === "input-readiness" ? state.previous : state;
  if (!receipt?.recipe || receipt.worktree !== context.worktree || receipt.branch !== branch
    || session.branch !== branch || receipt.operator.id !== session.operator.id || receipt.operator.email !== session.operator.email
    || receipt.originalBase !== session.baseCommit || receipt.purpose !== context.publicationPurpose
    || receipt.transactionId !== context.mainSyncTransactionId || !state.inputs
    || state.inputs.source.runtime !== context.runtime || state.inputs.source.workerId !== context.workerId
    || state.inputs.headSha !== witness.headSha || state.inputs.treeSha !== witness.treeSha || state.inputs.inputSha256 !== witness.inputSha256) {
    throw new MainSyncError("Stored canonical readiness is missing, stale or outside the actual Root source operation", "NEEDS_CHANGE");
  }
  verifyRecipeWitness(receipt.recipe, witness, receipt.transactionId);
  if (canceled()) throw new Error("Owned worker turn canceled before Claude spawn");
  return validationEnvelopeMs(receipt.recipe);
}

async function privateData(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new MainSyncError("Canonical validation data must be a bounded regular file");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
