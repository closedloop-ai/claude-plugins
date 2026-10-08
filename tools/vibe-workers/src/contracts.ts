import { z } from "zod";

export const graphOperations = new Set([
  "blast_radius_tickets", "code_architecture", "code_callers", "code_grep", "code_importers",
  "code_projects", "code_snippet", "code_symbols", "code_tests_for", "fts_search", "get_entity_edge",
  "get_routing_protocol", "graph_query", "query_collisions", "query_shipped", "query_wip",
  "readonly_sql", "search_memory_facts", "search_nodes", "sync_status", "ticket_detail",
]);
export const recordOperations = new Set([
  "create_document", "create_document_version", "update_document", "upload_attachment",
]);
export const liveReadOperations = new Set([
  "get_document", "get_document_version", "get_document_comments", "search", "list_documents", "list_document_versions", "list_users",
  "get_me", "list_projects", "get_project", "list_artifact_links", "list_templates", "get_template",
]);
const capabilityName = /^mcp__[A-Za-z0-9_.:-]+__[A-Za-z0-9_]+$/;
export const capabilitySchema = z.object({
  name: z.string().regex(capabilityName),
  service: z.enum(["graph", "closedloop"]),
  operation: z.string(),
  access: z.enum(["read", "write"]),
}).strict().superRefine((value, ctx) => {
  const validOperation = value.service === "graph"
    ? value.access === "read" && graphOperations.has(value.operation)
    : value.access === "read" ? liveReadOperations.has(value.operation) : recordOperations.has(value.operation);
  if (!validOperation || !value.name.endsWith(`__${value.operation}`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported capability binding" });
  }
});
export type Capability = z.infer<typeof capabilitySchema>;
export const capabilitiesSchema = z.array(capabilitySchema).max(48).refine(
  (values) => new Set(values.map((value) => value.name)).size === values.length,
  "Duplicate capability binding",
);
export const identifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
export const statusSchema = z.enum(["PLAN", "NEEDS_REVIEW", "NEEDS_PERSON", "NEEDS_COMMIT", "NEEDS_CHANGE",
  "NEEDS_PRIMITIVE", "NEEDS_BACKEND", "NEEDS_DESKTOP_STOP", "DONE", "BLOCKED", "FAILED"]);
export type WorkerStatus = z.infer<typeof statusSchema>;
export const registerSchema = z.object({
  worktree: z.string().min(1), runtime: z.enum(["codex", "claude"]), workerId: identifierSchema.optional(),
  agentRoot: z.string().min(1), agentName: identifierSchema,
  capabilities: capabilitiesSchema.default([]),
}).strict();
export const actionSchema = z.object({
  worktree: z.string().min(1), workerId: identifierSchema.optional(), requestId: identifierSchema.optional(),
  input: z.string().min(1).max(64 * 1024).optional(), continuation: z.string().min(1).max(64 * 1024).optional(),
  lease: z.string().uuid().optional(), status: statusSchema.optional(), resultSummary: z.string().max(4096).optional(),
  stoppedTurn: z.object({ runtime: z.literal("codex"), workerId: identifierSchema,
    requestId: identifierSchema, lease: z.string().uuid(), state: z.enum(["completed", "failed", "canceled"]) }).strict().optional(),
}).strict();
export const bindingSchema = z.object({
  agentRoot: z.string(), agentName: identifierSchema, digest: z.string().length(64),
  capabilities: capabilitiesSchema,
}).strict();
const requestSchema = z.object({ id: identifierSchema, input: z.string().min(1).max(64 * 1024) }).strict();
export const ledgerSchema = z.object({
  version: z.literal(1), worktree: z.string(), branch: z.string(), runtime: z.enum(["codex", "claude"]),
  workerId: identifierSchema, binding: bindingSchema, started: z.boolean(),
  pending: z.array(requestSchema).max(32),
  active: requestSchema.extend({ status: statusSchema, continuation: z.string().max(64 * 1024).optional(),
    lease: z.string().uuid().optional(), ownerPid: z.number().int().positive().optional(),
    processGroupId: z.number().int().positive().optional(),
    resultSummary: z.string().max(4096).optional() }).strict().optional(),
  completed: z.array(identifierSchema).max(64),
}).strict();
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
