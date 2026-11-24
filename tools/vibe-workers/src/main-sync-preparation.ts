import { isDeepStrictEqual } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { WorkerRefusal } from "./worker-refusal.js";
import { mainSyncReceiptSchema } from "./main-sync-contracts.js";
import { digest, MAIN_SYNC_FILE, readPrivateJson } from "./main-sync-state.js";

const resultSchema = z.object({ mainSync: z.object({ transactionId: z.string().uuid(), mainSha: z.string(),
  originalBase: z.string(), importedFileCount: z.number().int().nonnegative().optional(),
  importedFilesSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), importedFiles: z.array(z.object({ status: z.string(), path: z.string() })).optional() }) });

/** Bind the ordered path/status inventory without copying a potentially large private receipt into a turn result. */
export function importedFileFacts(files: {status: string; path: string}[]) {
  return { importedFileCount: files.length, importedFilesSha256: digest(JSON.stringify(files.map(({path, status}) => [path, status]))) };
}

/** Authenticate explicit preparation grants and captures actually performed by older publisher callers. */
export function checkPreparationResult(output: { status: string; data?: Record<string, unknown> }, dir: string,
  grant: { publicationStep?: "prepare"; publicationPurpose?: "build" | "handoff" }, lease: string) {
  if (output.status !== "DONE" && output.status !== "NEEDS_COMMIT") return;
  const file = join(dir, MAIN_SYNC_FILE);
  const refusal = () => new WorkerRefusal("MAIN_SYNC_RESULT_INVALID", "Publication preparation needs its own UUID and captured main facts from the private receipt.");
  let saved: unknown;
  try { saved = existsSync(file) ? readPrivateJson(file) : undefined; } catch { throw refusal(); }
  const receipt = mainSyncReceiptSchema.safeParse(saved);
  const owned = receipt.success && receipt.data.preparationTurn?.lease === lease;
  if (grant.publicationStep !== "prepare" && !owned) return;
  const result = resultSchema.safeParse(output.data?.mainSyncResult);
  if (!owned || !receipt.success || !result.success || receipt.data.purpose !== grant.publicationPurpose) throw refusal();
  const facts = result.data.mainSync;
  const compact = importedFileFacts(receipt.data.importedFiles);
  const hasCompact = facts.importedFileCount !== undefined || facts.importedFilesSha256 !== undefined;
  if (hasCompact && (compact.importedFileCount !== facts.importedFileCount || compact.importedFilesSha256 !== facts.importedFilesSha256)) throw refusal();
  if (!hasCompact && !facts.importedFiles) throw refusal();
  if (facts.importedFiles && !isDeepStrictEqual(receipt.data.importedFiles, facts.importedFiles)) throw refusal();
  if (receipt.data.transactionId !== facts.transactionId || receipt.data.mainSha !== facts.mainSha ||
      receipt.data.originalBase !== facts.originalBase) throw refusal();
}
