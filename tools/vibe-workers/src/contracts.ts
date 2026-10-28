import { z } from "zod";

export const graphOperations = new Set([
  "blast_radius_tickets", "code_architecture", "code_callers", "code_grep", "code_importers",
  "code_projects", "code_snippet", "code_symbols", "code_tests_for", "fts_search", "get_entity_edge",
  "get_routing_protocol", "graph_query", "query_collisions", "query_shipped", "query_wip",
  "readonly_sql", "search_memory_facts", "search_nodes", "sync_status", "ticket_detail",
]);
export const recordOperations = new Set([
  "create_document", "create_document_version", "update_document", "upload_attachment", "create_artifact_link",
]);
export const liveReadOperations = new Set([
  "get_document", "get_document_version", "get_document_content", "get_document_comments", "search", "list_documents", "list_document_versions", "list_users",
  "get_me", "list_projects", "get_project", "list_artifact_links", "list_templates", "get_template",
]);
const capabilityName = /^mcp__[A-Za-z0-9_.:-]+__[A-Za-z0-9_-]+$/;

/** Runtime-neutral identity for an MCP tool whose operation may use underscores or hyphens. */
export function mcpToolIdentity(name: string): string | null {
  if (!capabilityName.test(name)) return null;
  const boundary = name.lastIndexOf("__");
  return `${name.slice(0, boundary)}__${name.slice(boundary + 2).replaceAll("-", "_")}`;
}

/** Exact spellings accepted by Codex and Claude Code for one canonical MCP operation. */
export function mcpToolAliases(name: string): string[] {
  const identity = mcpToolIdentity(name);
  if (!identity) return [name];
  const boundary = identity.lastIndexOf("__");
  const hyphenated = `${identity.slice(0, boundary)}__${identity.slice(boundary + 2).replaceAll("_", "-")}`;
  return [...new Set([name, identity, hyphenated])];
}
export const capabilitySchema = z.object({
  name: z.string().regex(capabilityName),
  service: z.enum(["graph", "closedloop"]),
  operation: z.string(),
  access: z.enum(["read", "write"]),
}).strict().superRefine((value, ctx) => {
  const validOperation = value.service === "graph"
    ? value.access === "read" && graphOperations.has(value.operation)
    : value.access === "read" ? liveReadOperations.has(value.operation) : recordOperations.has(value.operation);
  if (!validOperation || mcpToolIdentity(value.name)?.split("__").at(-1) !== value.operation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported capability binding" });
  }
});
export type Capability = z.infer<typeof capabilitySchema>;
export const capabilitiesSchema = z.array(capabilitySchema).max(48).refine(
  (values) => new Set(values.map((value) => mcpToolIdentity(value.name))).size === values.length,
  "Duplicate capability binding",
);
export const identifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
/** A Codex `spawn_agent` result names its helper only by agent path (`/root/setup`), so a native worker ID may be one. */
export const codexAgentPathSchema = z.string().max(160).regex(/^(?:\/[A-Za-z0-9_.:-]+)+$/)
  .refine((value) => value.split("/").slice(1).every((segment) => segment !== "." && segment !== ".."), "Invalid Codex agent path");
export const workerIdSchema = z.union([identifierSchema, codexAgentPathSchema]);
const pathIdOnlyForCodex = (value: { runtime: string; workerId?: string }, ctx: z.RefinementCtx) => {
  if (value.runtime !== "codex" && value.workerId?.startsWith("/")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workerId"], message: "Only a Codex writer is named by its agent path" });
  }
};
export const statusSchema = z.enum(["PLAN", "STORIES_READY", "NEEDS_REVIEW", "NEEDS_PERSON", "NEEDS_COMMIT", "NEEDS_CHANGE",
  "NEEDS_PRIMITIVE", "NEEDS_BACKEND", "NEEDS_STORYBOOK", "NEEDS_DESKTOP_STOP", "DONE", "BLOCKED", "FAILED"]);
export type WorkerStatus = z.infer<typeof statusSchema>;
const registerFields = z.object({
  worktree: z.string().min(1), runtime: z.enum(["codex", "claude"]), workerId: workerIdSchema.optional(),
  agentRoot: z.string().min(1), agentName: identifierSchema,
  capabilities: capabilitiesSchema.default([]),
}).strict();
export const registerSchema = registerFields.superRefine(pathIdOnlyForCodex);
export const stoppedTurnSchema = z.object({ runtime: z.literal("codex"), workerId: workerIdSchema,
  requestId: identifierSchema, lease: z.string().uuid(), state: z.enum(["completed", "failed", "canceled"]) }).strict();
/** Why a writer turn ended BLOCKED; `migrateWriter` decides which blocks move to a new writer. */
export const blockReasonSchema = z.enum(["recorded-definition-removed", "other"]);
export const actionSchema = z.object({
  worktree: z.string().min(1), workerId: workerIdSchema.optional(), requestId: identifierSchema.optional(),
  input: z.string().min(1).max(64 * 1024).optional(), continuation: z.string().min(1).max(64 * 1024).optional(),
  lease: z.string().uuid().optional(), status: statusSchema.optional(), resultSummary: z.string().max(4096).optional(),
  blockReason: blockReasonSchema.optional(), stoppedTurn: stoppedTurnSchema.optional(),
}).strict();
export const bindingSchema = z.object({
  agentRoot: z.string(), agentName: identifierSchema, digest: z.string().length(64),
  capabilities: capabilitiesSchema,
}).strict();
/** The writer's own record grant that only its removed definition could release. */
export const retainedRecordSchema = z.object({ lease: z.string().uuid(), stoppedTurn: stoppedTurnSchema }).strict();
export type RetainedRecord = z.infer<typeof retainedRecordSchema>;
/** A writer whose runtime cannot run (a Codex account at its usage limit) moves to the other harness. */
export const harnessSwitchSchema = z.object({
  to: z.enum(["codex", "claude"]), cause: z.enum(["usage-limit", "runtime-unavailable"]),
  evidence: z.string().min(1).max(1024),
}).strict();
export type HarnessSwitch = z.infer<typeof harnessSwitchSchema>;
/** Migration is a parent-owned operation, separate from ordinary registration; omitted capabilities keep the recorded ones. */
export const migrateSchema = registerFields.extend({
  capabilities: capabilitiesSchema.optional(),
  previousWorkerId: workerIdSchema, previousDigest: z.string().regex(/^[a-f0-9]{64}$/),
  retainedRecord: retainedRecordSchema.optional(), harnessSwitch: harnessSwitchSchema.optional(),
}).strict().superRefine(pathIdOnlyForCodex);
const requestSchema = z.object({ id: identifierSchema, input: z.string().min(1).max(64 * 1024) }).strict();
const ledgerStateSchema = z.object({
  version: z.literal(1), worktree: z.string(), branch: z.string(), runtime: z.enum(["codex", "claude"]),
  workerId: workerIdSchema, binding: bindingSchema, started: z.boolean(),
  pending: z.array(requestSchema).max(32),
  active: requestSchema.extend({ status: statusSchema, continuation: z.string().max(64 * 1024).optional(),
    lease: z.string().uuid().optional(), ownerPid: z.number().int().positive().optional(),
    processGroupId: z.number().int().positive().optional(),
    resultSummary: z.string().max(4096).optional(), blockReason: blockReasonSchema.optional() }).strict().optional(),
  completed: z.array(identifierSchema).max(64),
}).strict();
/** Retains the full prior writer state without recursively copying migration history. */
export const migrationSchema = z.object({
  id: z.string().uuid(), at: z.string().datetime(),
  reason: z.enum(["definition-missing", "definition-upgraded", "harness-switch"]),
  observedDigest: z.string().length(64).nullable(),
  previous: ledgerStateSchema, workerId: workerIdSchema, binding: bindingSchema,
  releasedRecord: z.object({ requestId: identifierSchema, recordAction: identifierSchema,
    state: stoppedTurnSchema.shape.state }).strict().optional(),
  harnessSwitch: harnessSwitchSchema.extend({ from: z.enum(["codex", "claude"]) }).strict().optional(),
}).strict();
export const ledgerSchema = ledgerStateSchema.extend({ migrations: z.array(migrationSchema).default([]) }).strict();
export type Ledger = z.infer<typeof ledgerSchema>;

/** Limits parent input before JSON parsing; briefs never belong in process arguments. */
export async function readInput(stream: NodeJS.ReadableStream = process.stdin): Promise<unknown> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    if (size > 128 * 1024) throw new Error("Worker input exceeds the private input limit");
    buffers.push(bytes);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8"));
}
