import { z } from "zod";
import { identifierSchema } from "./contracts.js";
import { ciRunLocatorSchema, recordActionSchema, requestContinuationSchema } from "./record-context.js";
import { validationCommitSchema, validationWitnessSchema, storedValidationRecipeSchema } from "./main-sync-validation-contracts.js";

export const mainSyncPurposeSchema = z.enum(["build", "handoff"]);
export const commitSchema = validationCommitSchema;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const originFileSchema = z.object({ path: z.string().min(1).max(2048).refine((path) => !path.startsWith("/")
  && !path.includes("\\") && !path.includes("\0") && !path.split("/").includes("..")),
  bytes: z.number().int().nonnegative().max(128 * 1024 * 1024), sha256: digestSchema,
  mode: z.literal("100644") }).strict();
export const producerInputSchema = originFileSchema.extend({ mode: z.enum(["100644", "100755"]) });
export const canonicalRelativeSchema = z.string().min(1).max(2048).refine((path) => !path.startsWith("/")
  && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => !part || part === "." || part === ".."));
export const packageOwnerSchema = z.object({ path: canonicalRelativeSchema, name: z.string().min(1).max(128),
  version: z.string().min(1).max(128), files: z.number().int().min(1).max(10000),
  names: z.string().min(1).max(256 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  sha256: digestSchema }).strict();
export type PackageOwner = z.infer<typeof packageOwnerSchema>;
export const originProofSchema = z.object({ headSha: commitSchema, treeSha: commitSchema,
  trackedInputSha256: digestSchema, inputSha256: digestSchema, source: z.object({ runtime: z.enum(["codex", "claude"]),
    workerId: identifierSchema }).strict(), checkedAt: z.string().datetime(),
  files: z.array(originFileSchema).max(10000),
  packages: z.array(packageOwnerSchema).max(16).default([]),
  producers: z.array(z.object({ id: z.string().min(1).max(128), ownerPath: canonicalRelativeSchema.optional(),
    files: z.array(z.string().min(1).max(2048)).max(10000), log: z.string().min(1), logSha256: digestSchema }).strict()).max(16),
}).strict();
export type OriginProof = z.infer<typeof originProofSchema>;
export const operationContextSchema = z.object({
  runtime: z.enum(["codex", "claude"]), worktree: z.string().min(1), agentName: identifierSchema,
  mode: z.literal("record"), recordAction: recordActionSchema, workerId: identifierSchema,
  requestId: identifierSchema, lease: z.string().uuid(), publicationPurpose: mainSyncPurposeSchema.optional(),
  mainSyncTransactionId: z.string().uuid().optional(),
  mainSyncRequestContinuations: z.array(requestContinuationSchema).min(1).max(2).optional(),
  mainSyncCiRun: ciRunLocatorSchema.optional(),
  mainSyncValidation: validationWitnessSchema.optional(),
}).strict();
export type OperationContext = z.infer<typeof operationContextSchema>;
export const mainSyncInputSchema = z.object({ context: operationContextSchema,
  transactionId: z.string().uuid().optional() }).strict();
export const commandReceiptSchema = z.object({ argv: z.array(z.string()).min(1).max(256),
  bindings: z.record(z.string()).optional(), cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(2 ** 31 - 1).optional(),
  exitCode: z.literal(0), log: z.string().min(1), sha256: z.string().length(64) }).strict();
export const e2eLimitationSchema = z.object({ argv: z.array(z.string()).min(1).max(256),
  bindings: z.record(z.string()).optional(), reason: z.string().min(1).max(4096) }).strict();
const fileDeltaSchema = z.object({ path: z.string().min(1), status: z.string().min(1) }).strict();
const publicationTurnSchema = z.object({ runtime: z.enum(["codex", "claude"]), workerId: identifierSchema,
  requestId: identifierSchema, lease: z.string().uuid() }).strict();
export const ciEvidenceSchema = z.object({ runId: z.number().int().positive().safe(), attempt: z.number().int().positive().safe(),
  workflowId: z.number().int().positive().safe(), definitionSha: commitSchema, checkoutSha: commitSchema,
  treeSha: commitSchema, inputSha256: z.string().length(64), verifiedAt: z.string().datetime(),
  jobs: z.array(z.object({ jobId: z.number().int().positive().safe(), name: z.string().min(1),
    conclusion: z.literal("success"), logSha256: z.string().length(64) }).strict()).min(1).max(10) }).strict();
export const mainSyncReceiptSchema = z.object({
  version: z.literal(1), phase: z.literal("captured").optional(), transactionId: z.string().uuid(), worktree: z.string(), branch: z.string(),
  operator: z.object({ id: z.string().min(1), email: z.string().email() }).strict(),
  purpose: mainSyncPurposeSchema, mainSha: commitSchema, startingHead: commitSchema, originalBase: commitSchema,
  validationSince: commitSchema, fetchedAt: z.string().datetime(), importedFiles: z.array(fileDeltaSchema).max(50000),
  importedCommits: z.array(commitSchema).max(50000).default([]),
  featureTestHistory: z.array(z.object({ commit: commitSchema, path: z.string().min(1) }).strict()).max(50000).default([]),
  validation: z.object({ headSha: commitSchema, treeSha: commitSchema, inputSha256: z.string().length(64),
    commands: z.array(commandReceiptSchema).min(1).max(128), checkedAt: z.string().datetime(),
    e2eLimitations: z.array(e2eLimitationSchema).max(128).default([]) }).strict().optional(),
  ciEvidence: ciEvidenceSchema.optional(),
  pushedHead: commitSchema.optional(),
  publicationTurn: publicationTurnSchema.optional(),
  requestContinuations: z.array(requestContinuationSchema.extend({ turn: publicationTurnSchema.optional() })).max(2).default([]),
  inputs: originProofSchema.optional(),
  recipe: storedValidationRecipeSchema.optional(),
}).strict();
export type MainSyncReceipt = z.infer<typeof mainSyncReceiptSchema>;
export const readinessStateSchema = z.object({ version: z.literal(1), phase: z.literal("input-readiness"),
  transactionId: z.string().uuid(), worktree: z.string(), branch: z.string(),
  operator: z.object({ id: z.string().min(1), email: z.string().email() }).strict(),
  originalBase: commitSchema, purpose: mainSyncPurposeSchema, inputs: originProofSchema,
  previous: mainSyncReceiptSchema.optional() }).strict();
export const mainSyncStateSchema = z.union([readinessStateSchema, mainSyncReceiptSchema]);
export type MainSyncState = z.infer<typeof mainSyncStateSchema>;
export const sessionSchema = z.object({
  worktree: z.string().optional(), branch: z.string().regex(/^(?:vibe|prototype)\/[^\s]+$/),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), status: z.literal("active"),
  mode: z.enum(["seeded", "blank"]).nullable(), baseCommit: commitSchema,
  operator: z.object({ id: z.string().min(1), email: z.string().email() }).passthrough(),
  localFixes: z.array(z.object({ ticket: z.string(), paths: z.array(z.string()) }).passthrough()).default([]),
  vercel: z.object({ lastDeployedCommit: commitSchema.nullable().optional(),
    verifiedAt: z.string().nullable().optional(), verifiedRequestId: z.string().nullable().optional() }).passthrough().nullable().optional(),
  lastRequestId: z.string().nullable().optional(),
  prototype: z.object({ deployedCommit: commitSchema, verifiedAt: z.string(), previewUrl: z.string() }).passthrough().optional(),
}).passthrough();
export type MainSyncSession = z.infer<typeof sessionSchema>;

/** Errors preserve existing worker outcomes without returning command output or private inputs. */
export class MainSyncError extends Error {
  constructor(message: string, readonly status: "BLOCKED" | "NEEDS_CHANGE" | "NEEDS_COMMIT" | "NEEDS_DESKTOP_STOP" = "BLOCKED") {
    super(message);
  }
}
