import { z } from "zod";
import { identifierSchema } from "./contracts.js";
import { ciRunLocatorSchema, recordActionSchema, requestContinuationSchema } from "./record-context.js";

export const mainSyncPurposeSchema = z.enum(["build", "handoff"]);
export const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const operationContextSchema = z.object({
  runtime: z.enum(["codex", "claude"]), worktree: z.string().min(1), agentName: identifierSchema,
  mode: z.literal("record"), recordAction: recordActionSchema, workerId: identifierSchema,
  requestId: identifierSchema, lease: z.string().uuid(), publicationPurpose: mainSyncPurposeSchema.optional(),
  mainSyncTransactionId: z.string().uuid().optional(),
  mainSyncRequestContinuations: z.array(requestContinuationSchema).min(1).max(2).optional(),
  mainSyncCiRun: ciRunLocatorSchema.optional(),
}).strict();
export type OperationContext = z.infer<typeof operationContextSchema>;
export const mainSyncInputSchema = z.object({ context: operationContextSchema,
  transactionId: z.string().uuid().optional() }).strict();
export const commandReceiptSchema = z.object({ argv: z.array(z.string()).min(1).max(256),
  bindings: z.record(z.string()).optional(), cwd: z.string().optional(),
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
  version: z.literal(1), transactionId: z.string().uuid(), worktree: z.string(), branch: z.string(),
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
}).strict();
export type MainSyncReceipt = z.infer<typeof mainSyncReceiptSchema>;
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
