import { capturedJson } from "../../../plugins/vibe/lib/vibe/scripts/captured-json.mjs";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { checkClaudeSignIn, checkClaudeSignInAsync, checkProtectedWriteSupportAsync, checkRoleCapabilities, isAuthFailure, LaunchPrecheckError, missingMcpTools, missingServers,
  SIGN_IN_PERSON_ACTION } from "./claude-preflight.js";
import { runFromCanonicalEntry } from "./cli.js";
import { capabilitiesSchema, identifierSchema, mcpToolAliases, mcpToolIdentity, readInput, requireSupportedCapabilities, statusSchema, type WorkerStatus } from "./contracts.js";
import { readDefinition } from "./definition.js";
import { acquireRecordTurnAt, attachClaudeProcess, bindTakeoverWriter, changeWriter, markClaudeStarted, readWriterSummary, recordedWriterRoot,
  readWriterUpgradeEvidence, registerWriter, writerUpgradeCompatible } from "./ledger.js";
import { AgentRootError, installedPluginRoot, readPluginManifest, resolveAgentRoot } from "./plugin-root.js";
import { graphCalls, reviewTraceFacts } from "../../../plugins/vibe/lib/handoff/scripts/review-receipts.mjs";
import { pluginScriptProblems } from "../../../plugins/vibe/lib/vibe/scripts/plugin-script-references.mjs";
import { assembleProviderText, boundWith, connectionLabel, ProviderBroken, providerProbeProblem, sessionBinding } from "../../../plugins/vibe/lib/vibe/scripts/provider.mjs";
import { briefProviderProblem } from "../../../plugins/vibe/lib/vibe/scripts/provider-brief.mjs";
import { isModelName, MODEL_OVERRIDES_INVALID, ModelRuntime, resolveWorkerModel } from "../../../plugins/vibe/skills/vibe/scripts/agent-models.mjs";
import { recordWorkerScope } from "../../../plugins/vibe/lib/vibe/scripts/worker-scope.mjs";
import { isHandoverContext, isPublisherContext, MissingSessionError, recordContextSchema, recordModes, resolveRecordContext } from "./record-context.js";
import { CLAUDE_OPERATION_OWNER } from "./main-sync-state.js";
import type { OperationContext } from "./main-sync-contracts.js";
import { checkPreparationResult } from "./main-sync-preparation.js";
import { deriveValidationEnvelope } from "./main-sync-validation-envelope.js";
import { readReferenceImages } from "./reference-images.js";
import { asksForUsage, claudeWorkerUsage } from "./usage.js";
import { type ClaudeRateLimit, mustStopForUsage, rateLimitFromEvent } from "./claude-usage.js";
import { WorkerRefusal } from "./worker-refusal.js";
import { checkSharedHostGuards } from "./shared-host-guards.js";
import { escalateOwnedStop, finishOwnedGroup, OwnedCleanupError, OwnedSignalRefusal, signalOwnedChild } from "./owned-process.js";

export const MAX_WORKER_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_WORKER_TIMEOUT_MS = MAX_WORKER_TIMEOUT_MS;

const launchSchema = recordContextSchema.extend({
  /** Optional: the launcher binds its own installed plugin root (or a resumed writer's recorded root) when omitted. */
  agentRoot: z.string().min(1).optional(),
  requestId: identifierSchema, input: z.string().min(1).max(64 * 1024).optional(),
  continuation: z.string().min(1).max(64 * 1024).optional(), capabilities: capabilitiesSchema,
  timeoutMs: z.number().int().min(1000).max(MAX_WORKER_TIMEOUT_MS).optional(),
  /** Set only when the person explicitly allowed paid extra usage; otherwise a reached limit or overage stops the turn. */
  allowCredits: z.boolean().optional(),
  /** Explicit top-level orchestrator requirement; raw brief text never grants test authoring. */
  testsRequired: z.boolean().optional(),
  previewRequirements: z.array(z.enum(["app-preview", "feature-flags", "collaboration"])).min(1).optional(),
  previewProducer: z.literal("runtime-provider").optional(),
  /** This launch's model for any role, in place of the person's override and the definition's default. */
  model: z.string().refine(isModelName).optional(),
  /** The earlier name of `model`, still accepted; a review receipt proves the model from the trace. */
  reviewModel: z.string().refine(isModelName).optional(),
}).strict().refine((data) => !(data.input && data.continuation), "Supply input or continuation, not both");
type LaunchInput = z.infer<typeof launchSchema>;
type Definition = ReturnType<typeof readDefinition>;
const resultSchema = z.object({ type: z.literal("result"), session_id: z.string().uuid(),
  is_error: z.boolean().optional(), result: z.string().max(256 * 1024).optional(),
  structured_output: z.unknown().optional(),
}).passthrough();
const initSchema = z.object({ type: z.literal("system"), subtype: z.literal("init"), tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() }).passthrough()).optional() }).passthrough();
const workerResultSchema = z.object({ status: statusSchema, summary: z.string().max(4096),
  data: z.record(z.unknown()).optional() }).strict().refine((value) => JSON.stringify(value).length <= 16 * 1024,
    "Worker status data exceeds the compact response limit");
const workerResultJsonSchema = { type: "object", additionalProperties: false,
  properties: { status: { type: "string", enum: statusSchema.options }, summary: { type: "string" },
    data: { type: "object", additionalProperties: true } }, required: ["status", "summary"] };
const structuredOutputTool = "StructuredOutput";
const readerRoles = new Set([
  "vibe-adversarial-reviewer", "vibe-guardrails-reviewer", "vibe-handoff-summarizer",
  "vibe-requirements-worker", "vibe-backend-worker", "vibe-primitive-worker", "vibe-storybook-decomposer",
  "vibe-verify-worker",
]);
const receiptRoles = new Set(["vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker"]);

/** Only a reviewer's brief must name scripts that already exist in the review worktree; any other role may name one its change adds. */
export function reviewsSource(agentName: string): boolean {
  return receiptRoles.has(agentName);
}
const previewActions = new Set(["create", "redeploy", "flags", "desktop"]);
const testAuthoringModes = new Set(["request", "fix", "handoff", "pull-request"]);
const PROTECTED_WRITE_HOOK_TIMEOUT_SECONDS = 15;
/**
 * How long Claude itself holds the first turn for its MCP connections (`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`). Without it
 * a print-mode child reports a connection that is slow to come up under load as pending at its start event, and
 * every relaunch raced the same few seconds (three reviewer launches refused while both connections were
 * healthy). Measured on Claude Code 2.1.326: a server answering after 20 s was pending at the start event by default
 * and connected with this wait set to 60000.
 */
const MCP_STARTUP_WAIT_MS = 60_000;
/** Room left between the child's own MCP wait and the launcher's start-event watchdog on a retry. */
const MCP_INIT_MARGIN_MS = 5_000;
const MCP_READINESS_WINDOW_MS = MCP_STARTUP_WAIT_MS + 15_000;
const MCP_STARTUP_RETRY_DELAY_MS = 500;
const STDERR_TAIL_LINES = 5;
const STDERR_TAIL_BYTES = 800;
const CAUSE_MESSAGE_LIMIT = 300;

/** Mandatory reviewers are held to the receipt's finding and premise shape by Claude's structured-output tool. */
export function workerResultJsonSchemaFor(agentName: string) {
  const schema: Record<string, any> = structuredClone(workerResultJsonSchema);
  if (!receiptRoles.has(agentName)) return schema;
  schema.properties.data = { type: "object", additionalProperties: true,
    properties: { findings: { type: "array", items: { type: "object", additionalProperties: true,
      properties: { id: { type: "string", minLength: 1 }, blocking: { type: "boolean" }, evidence: { type: "string", minLength: 1 },
        browserCase: { type: "object", additionalProperties: false,
          properties: { name: { type: "string", minLength: 1 }, status: { type: "string", enum: ["queued", "available", "reproduced"] } },
          required: ["name", "status"] },
        premises: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false,
          properties: { claim: { type: "string", minLength: 1 }, evidence: { type: "object", additionalProperties: true,
            properties: { kind: { type: "string", enum: ["code", "command", "official-doc", "UNVERIFIED"] } }, required: ["kind"] } },
          required: ["claim", "evidence"] } } }, required: ["id", "blocking", "evidence"],
      allOf: [{ if: { properties: { blocking: { const: true } }, required: ["blocking"] }, then: { required: ["premises"] } }] } } },
    required: ["findings"] };
  schema.required = ["status", "summary", "data"];
  return schema;
}

/** Only the persistent writer receives an explicit, mode-bounded test-authoring grant. */
export function testAuthoringGranted(input: Pick<LaunchInput, "agentName" | "mode" | "testsRequired">): boolean {
  return input.agentName === "vibe-change-worker" && (input.mode === "pull-request" ||
    (input.testsRequired === true && testAuthoringModes.has(input.mode)));
}

/** Cap every startup retry by the original worker turn deadline. */
export function remainingWorkerTurnBudget(input: { turnDeadline: number;
  readinessDeadline: number; now: number }): { turnTimeoutMs: number; startupTimeoutMs: number } {
  const turnTimeoutMs = Math.max(0, input.turnDeadline - input.now);
  return { turnTimeoutMs,
    startupTimeoutMs: Math.min(turnTimeoutMs, Math.max(0, input.readinessDeadline - input.now)) };
}

/** The first child may use any positive budget; retry delay is checked only after a pending init. */
export function canStartWorkerAttempt(budget: { turnTimeoutMs: number;
  startupTimeoutMs: number }): boolean {
  return budget.turnTimeoutMs > 0 && budget.startupTimeoutMs > 0;
}

/** The first init has only the overall turn deadline; retries get a separate readiness timer. */
export function armMcpInitWatchdog(startupTimeoutMs: number | null,
  onTimeout: () => void): ReturnType<typeof setTimeout> | undefined {
  return startupTimeoutMs === null ? undefined : setTimeout(onTimeout, startupTimeoutMs);
}

class PendingMcpError extends Error {
  constructor(readonly servers: string[]) { super(`Granted MCP connections pending: ${servers.join(", ")}`); }
}

/** The connections that never left pending, carried to the result so the caller knows which one to check. */
class McpStillPendingError extends LaunchPrecheckError {
  constructor(readonly pendingConnections: string[], attempts: number, waitedMs: number) {
    super("MCP_TOOLS_MISSING", `The worker's granted connections stayed pending during bounded startup: ${pendingConnections.join(", ") || "unknown"}`
      + ` (still pending after ${attempts} launch attempt${attempts === 1 ? "" : "s"} over ${Math.round(waitedMs / 1000)} s; check that connection, then relaunch)`);
  }
}

/** Claude exited non-zero: its exit code and the last stderr lines, so the failure names its cause. */
class ClaudeExitError extends WorkerRefusal {
  constructor(readonly exitCode: number | null, readonly stderrTail: string) {
    super("CLAUDE_PROCESS_FAILED", `Claude exited with status ${exitCode}.${stderrTail ? ` Last stderr: ${stderrTail}` : ""}`
      + " Inspect the private trace and continue the same request.");
  }
}

/** The child's own MCP hold: as long as the launcher can wait, less a margin so its start event beats the watchdog. */
export function childMcpStartupWaitMs(turnTimeoutMs: number, startupTimeoutMs: number | null): number {
  return Math.max(0, Math.min(MCP_STARTUP_WAIT_MS, (startupTimeoutMs ?? turnTimeoutMs) - MCP_INIT_MARGIN_MS));
}

/** The bounded last lines of a stderr capture, never more than STDERR_TAIL_BYTES. */
export function stderrTail(text: string): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter(Boolean).slice(-STDERR_TAIL_LINES).join(" | ");
  return lines.length > STDERR_TAIL_BYTES ? lines.slice(-STDERR_TAIL_BYTES) : lines;
}

type TimerHandle = ReturnType<typeof setTimeout>;
/**
 * A worker turn's time cap that counts the model's own time and stops while a tool call runs (operator item 30(g):
 * two turns were cut while they waited on the inventory and a validation, not while thinking). Each single tool wait
 * is its own step, bounded by the same cap, so a hung tool still ends the turn.
 */
export function createTurnCap(capMs: number, onExpire: (reason: "model" | "tool") => void,
  clock: { now: () => number; set: (callback: () => void, ms: number) => TimerHandle; clear: (handle: TimerHandle) => void }
    = { now: Date.now, set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle) }) {
  let remaining = capMs;
  let armedAt = clock.now();
  let timer: TimerHandle | undefined = clock.set(() => onExpire("model"), remaining);
  const open = new Set<string>();
  return {
    toolStarted(id: string) {
      if (open.has(id)) return;
      open.add(id);
      if (open.size !== 1) return;
      if (timer) clock.clear(timer);
      remaining = Math.max(0, remaining - (clock.now() - armedAt));
      timer = clock.set(() => onExpire("tool"), capMs);
    },
    toolFinished(id: string) {
      if (!open.delete(id) || open.size !== 0) return;
      if (timer) clock.clear(timer);
      armedAt = clock.now();
      timer = clock.set(() => onExpire("model"), remaining);
    },
    stop() { if (timer) clock.clear(timer); timer = undefined; },
  };
}

const toolUseEventSchema = z.object({ type: z.literal("assistant"), message: z.object({
  content: z.array(z.object({ type: z.string(), id: z.string().min(1).optional() }).passthrough()) }).passthrough() }).passthrough();
const toolResultEventSchema = z.object({ type: z.literal("user"), message: z.object({
  content: z.array(z.object({ type: z.string(), tool_use_id: z.string().min(1).optional() }).passthrough()) }).passthrough() }).passthrough();
type PreviewProbeRunner = (command: string, args: string[], options: { encoding: "utf8" }) =>
  { status: number | null; stdout?: string | null; stderr?: string | null };

/** The persistent Claude writer's inline policy, never installed in plugin-wide hooks. */
export function protectedWriteSettings(hookPath: string, worktree: string): string {
  const handler = { type: "command", command: process.execPath, args: [hookPath, worktree],
    timeout: PROTECTED_WRITE_HOOK_TIMEOUT_SECONDS, onFailure: "block", statusMessage: "Protected write guard" };
  return JSON.stringify({ hooks: {
    PermissionRequest: [{ matcher: "Edit|Write", hooks: [handler] }],
    PreToolUse: [{ matcher: "Edit|Write|Bash", hooks: [handler] }],
  } });
}

/** Keep the writer's permission policy and unattended prompt target inseparable. */
export function protectedWriteLaunchArgs(hookPath: string, worktree: string): string[] {
  return ["--settings", protectedWriteSettings(hookPath, worktree), "--permission-prompts", "none"];
}

/** The exact installed definition root and referenced scripts bound to one Claude dispatch. */
export function dispatchFreshnessProblem(agentRoot: string, installedRoot: string, worktree: string, text: string, reviewSource = false): string | null {
  const root = realpathSync(agentRoot);
  const installed = realpathSync(installedRoot);
  const version = (dir: string) => readPluginManifest(dir).version;
  if (version(root) !== version(installed)) return "Claude dispatch definition is from a stale installed plugin release; reload or migrate before launch";
  return pluginScriptProblems(text, root, worktree, { reviewSource })[0] ?? null;
}

/** Only a provider receipt verified outside the worker's prose can clear preview readiness. */
export function checkPreviewResult(input: Pick<LaunchInput, "agentName" | "mode" | "recordAction" | "requestId" | "previewRequirements" | "previewProducer">,
  output: { status: string; data?: Record<string, unknown> }, pluginRoot: string, worktree: string,
  run: PreviewProbeRunner = spawnSync): void {
  if (input.agentName !== "vibe-environment-worker" || input.mode !== "record"
    || !previewActions.has(input.recordAction ?? "") || output.status !== "DONE") return;
  if (!input.previewProducer && !input.previewRequirements) return;
  if (input.previewProducer !== "runtime-provider") throw new WorkerRefusal("PREVIEW_PRODUCER_INVALID",
    "Preview requirements need an authoritative provider producer declaration.");
  if (!input.previewRequirements?.includes("app-preview")) throw new WorkerRefusal("PREVIEW_REQUIREMENTS_INVALID",
    "Environment DONE needs explicit preview requirements including app-preview.");
  const receipt = output.data?.previewReceipt;
  const environmentId = output.data?.environmentId;
  if (typeof receipt !== "string" || typeof environmentId !== "string") throw new WorkerRefusal("PREVIEW_RECEIPT_MISSING",
    "Environment DONE needs provider preview receipt and environment identity.");
  const args = [realpathSync(join(pluginRoot, "skills/vibe/scripts/preview-capabilities.mjs")), "--file", receipt,
    "--worktree", worktree, "--request-id", input.requestId, "--environment-id", environmentId,
    ...input.previewRequirements.flatMap(capability => ["--required", capability])];
  const checked = run(process.execPath, args, { encoding: "utf8" });
  if (checked.status !== 0) throw new WorkerRefusal("PREVIEW_NOT_READY",
    `Environment preview is not ready: ${checked.stdout || checked.stderr}`);
}

type ReviewSource = { head: string; diffSha256: string; treeSha256: string };

/** Source identity is captured by the plugin's canonical dirty-aware reader, never by the reviewer's prose. */
function reviewSourceIdentity(pluginRoot: string, worktree: string): ReviewSource {
  return capturedJson(execFileSync(process.execPath, [realpathSync(join(pluginRoot, "skills/vibe/scripts/tested-head.mjs")), "source", worktree],
    { encoding: "utf8" })) as ReviewSource;
}

/** Exact capabilities are discovered by the parent, then bounded again by role and declared operation. */
export function boundDefinition(definition: Definition, input: LaunchInput) {
  const binding = sessionBinding(input.worktree);
  requireSupportedCapabilities(input.capabilities, binding);
  // A brief that names the lead's binding launches only in a session bound the same way (fleet writer inheritance).
  const inherited = briefProviderProblem(input.input ?? "", binding);
  if (inherited) throw new WorkerRefusal("PROVIDER_BRIEF_MISMATCH", inherited);
  const modes = recordModes(binding);
  if (!readerRoles.has(input.agentName) && !Object.hasOwn(modes, input.agentName)) {
    throw new WorkerRefusal("ROLE_NOT_OWNED", `The role ${input.agentName} is outside the vibe and handoff owned launcher.`);
  }
  const { model } = resolveWorkerModel(ModelRuntime.Claude, input.agentName, definition.metadata.model,
    { launchModel: input.model ?? input.reviewModel });
  const prototypeAdvice = input.agentName === "vibe-prototype-worker" && input.mode !== "record";
  const reader = readerRoles.has(input.agentName) || prototypeAdvice;
  const declaredModes = modes[input.agentName];
  const possibleWrites = new Set(Object.values(declaredModes ?? {}).flat());
  if (reader && !prototypeAdvice && definition.tools.some((tool) => tool === "Write" || tool === "Edit")) {
    throw new WorkerRefusal("READER_DECLARATION_WRITABLE",
      `The read-only role ${input.agentName} declares writable filesystem tools.`);
  }
  const undeclaredWrite = input.capabilities.find((capability) => capability.access === "write" && !possibleWrites.has(capability.operation));
  if (input.capabilities.some((capability) => capability.access === "write") && (reader || undeclaredWrite)) {
    throw new WorkerRefusal("RECORD_CAPABILITY_UNDECLARED",
      `Record capability ${undeclaredWrite?.operation ?? "write"} is not declared for ${input.agentName}.`);
  }
  let permittedWrites: readonly string[] = [];
  if (input.mode === "record") {
    const declaredActions = Object.keys(declaredModes ?? {});
    if (!input.recordAction) throw new WorkerRefusal("RECORD_ACTION_REQUIRED",
      `Record mode for ${input.agentName} requires recordAction. Allowed actions: ${declaredActions.join(", ") || "none"}.`);
    if (!declaredModes?.[input.recordAction]) throw new WorkerRefusal("RECORD_ACTION_UNDECLARED",
      `Record action ${input.recordAction} is not declared for ${input.agentName}. Allowed actions: ${declaredActions.join(", ") || "none"}.`);
    if (!input.exclusiveRecordTurn) throw new WorkerRefusal("EXCLUSIVE_RECORD_TURN_REQUIRED",
      `Record action ${input.recordAction} for ${input.agentName} requires exclusiveRecordTurn.`);
    permittedWrites = declaredModes[input.recordAction] ?? [];
    const outsideAction = input.capabilities.find((capability) => capability.access === "write" && !permittedWrites.includes(capability.operation));
    if (outsideAction) {
      const allowedActions = Object.entries(declaredModes).filter(([, operations]) => operations.includes(outsideAction.operation))
        .map(([action]) => action);
      throw new WorkerRefusal("RECORD_CAPABILITY_OUTSIDE_ACTION",
        `Record capability ${outsideAction.operation} is outside action ${input.recordAction} for ${input.agentName}. Allowed actions: ${allowedActions.join(", ") || "none"}.`);
    }
  } else if (input.recordAction || input.exclusiveRecordTurn) throw new WorkerRefusal("RECORD_GRANT_OUTSIDE_RECORD",
    "Record grants require mode record and a separate record continuation.");
  // A bound graph provider's tools are discovered by the parent and required; with no graph bound there are none.
  if (boundWith(binding, "graph") && !input.capabilities.some((capability) => capability.service === "graph")) {
    throw new WorkerRefusal("GRAPH_CAPABILITIES_REQUIRED", "Parent-discovered read-only graph capabilities are required.");
  }
  const roleTools = prototypeAdvice ? definition.tools.filter((tool) => tool !== "Write" && tool !== "Edit") : definition.tools;
  const tools = [...new Set([...roleTools, "ToolSearch", structuredOutputTool, ...input.capabilities
    .filter((capability) => capability.access === "read" || permittedWrites.includes(capability.operation))
    .flatMap((capability) => mcpToolAliases(capability.name))])];
  const persistent = input.agentName === "vibe-change-worker";
  const phasePolicy = persistent
    ? "Current phase, test-authoring and test-repair authority come only from the orchestrator's top-level turn envelope, separate from raw input text. "
      + "Only an explicit pull-request turn or an explicit top-level testsRequired grant may author tests. "
      + "Never author tests in plan or record turns, or in request, fix or handoff turns without that grant; never infer authority from the person's words. "
      + "A request, fix or handoff turn with test-repair authority but without a test-authoring grant may only repair existing tests and fixtures your own change broke "
      + "(imports, renamed or retired symbols, setup, type errors) without changing what any test asserts; never add a test file. "
      + "Delete a test file or case only when it covers nothing but code the request retires, recorded with retired-tests.mjs "
      + "and the ticket or PRD that retires it; a test of live behavior is only repaired. "
    : `This is mode ${input.mode}. Never write or edit tests. `;
  const verifyEvidencePolicy = input.agentName === "vibe-verify-worker"
    ? "This is a source read-only verification role. Never edit product source, tests, fixtures, snapshots, catalog or allowlists. "
      + "Bash may write only owned private verification artifacts: <gitdir>/vibe-pr-evidence.json, "
      + "<gitdir>/vibe-lane-report.txt from the repository-declared lane source, <gitdir>/vibe-lane-results.json "
      + "through pre-pr-lanes.mjs, typed lane run receipts, verifier-owned Storybook birth records and logs in its private git directory, "
      + "and .control/ runtime files from "
      + "the repository control command in control mode. Move only this turn's control captures to "
      + "the private git directory before publication. "
      + `Never write a ${connectionLabel(binding, "tickets", "tracker") ?? "tracker"} or session record. `
    : "";
  const storybookEvidencePolicy = input.agentName === "vibe-storybook-decomposer"
    ? "This advisor may write only verifier-owned Storybook birth records and logs in the private git directory "
      + "through verify-storybook-process.mjs. Stop each new process before returning. Never edit product source, "
      + "tests or live records, and never adopt an unrecorded process. " : "";
  // Any provider stubs left in the role's definition are resolved here against the session's binding (a release built
  // with its provider has none); with no provider bound each stub's generic text stays. A bound provider whose text
  // cannot be read throws ProviderBroken, so the launch fails with its reason and fix instead of running generic text.
  const prompt = `${assembleProviderText(definition.prompt, binding)}\n\nRuntime binding: work only in ${input.worktree}. `
    + `Resolve this canonical definition's relative resource references against ${join(definition.root, "agents")}. `
    + pushPolicy(input) + phasePolicy
    + (reader ? "Before any finding, verify each material premise about source, tool, runtime, CLI, platform or version against current code, a bounded read-only command result or current official documentation. Give each finding a premises array with claim and evidence; label unverified premises UNVERIFIED and never make them blocking. The orchestrator separately rechecks premises before relay. " : "")
    + (reader && !["vibe-verify-worker", "vibe-storybook-decomposer"].includes(input.agentName)
      ? "This session is read-only. Bash and Skill may inspect existing sources, never mutate files or records. "
      : `${verifyEvidencePolicy}${storybookEvidencePolicy}`)
    + (input.agentName === "vibe-prototype-worker"
      ? `Use canonical ${prototypeAdvice ? "advice" : "share"} mode; operational publication never authors source. ` : "")
    + "Return one JSON object with status, summary (at most 4096 characters), and optional data. "
    + "Finish by calling the native StructuredOutput tool exactly once with that compact object. "
    + "Return compact facts, paths and status, never source bodies, raw tool responses, credentials or transcript text. "
    + "Use status PLAN, STORIES_READY, NEEDS_REVIEW, NEEDS_PERSON, NEEDS_COMMIT, NEEDS_CHANGE, NEEDS_PRIMITIVE, NEEDS_BACKEND, NEEDS_STORYBOOK, NEEDS_DESKTOP_STOP, DONE, BLOCKED, or FAILED. "
    + "DONE means the whole current request is complete; intermediate units keep the request active.";
  const agent = { description: definition.metadata.description, prompt, model, tools,
    ...(definition.skills.length ? { skills: definition.skills } : {}) };
  return { agent, reader, tools, model };
}

function pushPolicy(input: LaunchInput) {
  if (isPublisherContext(input)) {
    return "Never start another implementation writer or commit. Normal pushes are permitted only through the owned main-sync publication gate. ";
  }
  if (isHandoverContext(input)) {
    return "Never start another implementation writer or commit. Push only the current commit to the session's branch, once, "
      + "through the repository's normal pre-push checks; never forced or with checks skipped. ";
  }
  return "Never start another implementation writer, commit, or push. ";
}

/** Launches the canonical scoped agent directly; the registered writer resumes its original context. */
export async function runWorker(rawInput: unknown) {
  const input = launchSchema.parse(rawInput);
  const probe = providerProbeProblem(sessionBinding(input.worktree));
  if (probe) throw new WorkerRefusal("PROVIDER_PROBE_REQUIRED", probe);
  if (input.mainSyncValidation && input.timeoutMs !== undefined) {
    throw new WorkerRefusal("VALIDATION_TIMEOUT_OVERRIDE",
      "Canonical validation derives its own envelope; caller timeout overrides are not allowed.");
  }
  if (process.platform === "win32") throw new Error("Owned descendant cleanup requires a supported POSIX process-group harness");
  const recorded = input.agentName === "vibe-change-worker" && (!input.sessionless || input.sessionless.kind === "takeover")
    ? recordedWriterRoot(input.worktree) : undefined;
  const installedRoot = installedPluginRoot(import.meta.url);
  const resolvedRoot = resolveAgentRoot(input.agentRoot, installedRoot, recorded);
  const upgrade = recorded ? readWriterUpgradeEvidence(input.worktree, installedRoot) : undefined;
  const unchangedUpgrade = upgrade?.provenNewer && upgrade.installedDigest === upgrade.recordedDigest;
  const compatible = upgrade && writerUpgradeCompatible(upgrade);
  if (upgrade && !compatible) {
    const command = `node ${join(installedRoot, "skills/vibe/scripts/dist/writer-state.mjs")} migrate`;
    const message = upgrade.provenNewer || upgrade.observedDigest === null
      ? `Claude dispatch definition is from a stale installed plugin release; run ${command} with the recorded migration JSON on stdin`
      : "Writer definition mismatch has no proven installed release upgrade; retain the original writer";
    throw new AgentRootError("STALE_PLUGIN_ROOT", message);
  }
  const agentRoot = unchangedUpgrade && resolvedRoot === installedRoot ? recorded! : resolvedRoot;
  const dispatchProblem = dispatchFreshnessProblem(unchangedUpgrade ? installedRoot : agentRoot,
    installedRoot, input.worktree, input.input ?? input.continuation ?? "", reviewsSource(input.agentName));
  if (dispatchProblem) throw new WorkerRefusal("DISPATCH_SCRIPT_INVALID", dispatchProblem);
  if (receiptRoles.has(input.agentName) && input.continuation) {
    throw new WorkerRefusal("REVIEWER_RELAUNCH_REQUIRED",
      `Read-only role ${input.agentName} has no persistent continuation. Relaunch that same role fresh with a new requestId and input; do not continue the session writer.`);
  }
  const definition = readDefinition(agentRoot, input.agentName, input.capabilities);
  const bound = boundDefinition(definition, input);
  checkRoleCapabilities(input.agentName, input.capabilities);
  const persistent = input.agentName === "vibe-change-worker";
  if (!persistent) checkClaudeSignIn();
  const { place, target: discardPlace } = resolveRecordContext(input);
  checkSharedHostGuards(place.root);
  const reviewSource = receiptRoles.has(input.agentName) ? reviewSourceIdentity(definition.root, place.root) : undefined;
  const takeover = input.sessionless?.kind === "takeover" ? { ...input.sessionless.evidence, worktree: place.root } : undefined;
  if (takeover && (reviewSource?.head ?? checkoutHead(place.root)) !== takeover.headSha) {
    throw new Error("Takeover worktree HEAD differs from the pull request head it was bound to");
  }
  let protectedArgs: string[] = [];
  if (persistent) {
    const [signIn, support] = await Promise.allSettled([
      checkClaudeSignInAsync(), checkProtectedWriteSupportAsync(installedRoot),
    ] as const);
    if (signIn.status === "rejected") throw signIn.reason;
    if (support.status === "rejected") throw support.reason;
    protectedArgs = protectedWriteLaunchArgs(support.value, place.root);
  }
  let workerId: string = randomUUID();
  let lease: string | undefined;
  let resume = false;
  let turnInput = input.input ?? input.continuation ?? "";
  if (persistent) {
    if (takeover) bindTakeoverWriter(place.root, { prUrl: takeover.prUrl, headSha: takeover.headSha, sourceBranch: takeover.sourceBranch! });
    const registered = registerWriter({ worktree: input.worktree, runtime: "claude", agentRoot: definition.root,
      agentName: input.agentName, capabilities: input.capabilities });
    workerId = registered.workerId;
    const claim = input.input
      ? changeWriter("start", { worktree: input.worktree, workerId, requestId: input.requestId, input: input.input })
      : changeWriter("claim", { worktree: input.worktree, workerId, requestId: input.requestId,
        ...(input.continuation ? { continuation: input.continuation } : {}) });
    lease = claim.turn?.lease;
    if (!lease) throw new Error("Writer claim returned no owned turn");
    turnInput = claim.turn?.continuation ?? claim.turn?.input ?? "";
  } else if (input.continuation) throw new WorkerRefusal("REVIEWER_RELAUNCH_REQUIRED",
    `Read-only role ${input.agentName} has no persistent continuation. Relaunch that same role fresh with a new requestId and input; do not continue the session writer.`);
  else if (!input.input) throw new WorkerRefusal("REVIEWER_INPUT_REQUIRED", "A read-only role requires fresh input.");
  // The worker loads no skill (it runs with --agent), so its hooks learn from this record that vibe started it.
  recordWorkerScope(workerId, place.root);
  const turnId = randomUUID();
  const definitionFile = join(place.dir, `vibe-agent-${turnId}.json`);
  const tracePath = join(place.dir, `vibe-worker-${turnId}.jsonl`);
  let trace: number | undefined;
  let recordLock = false;
  let discardLock = false;
  let cleanupBlocked = false;
  let operationContext: OperationContext | undefined;
  let prelaunchCanceled = false;
  const cancelBeforeLaunch = () => { prelaunchCanceled = true; };
  process.once("SIGTERM", cancelBeforeLaunch);
  process.once("SIGINT", cancelBeforeLaunch);
  try {
    if (input.mode === "record") {
      if (discardPlace) { acquireRecordTurnAt(discardPlace); discardLock = true; }
      acquireRecordTurnAt(place, persistent && lease ? { workerId, lease } : undefined);
      recordLock = true;
      if (!input.sessionless && input.recordAction) {
        operationContext = { runtime: "claude", worktree: place.root, agentName: input.agentName,
          mode: "record", recordAction: input.recordAction, workerId, requestId: input.requestId,
          lease: randomUUID(), ...(input.publicationPurpose ? { publicationPurpose: input.publicationPurpose } : {}),
          ...(input.mainSyncTransactionId ? { mainSyncTransactionId: input.mainSyncTransactionId } : {}),
          ...(input.mainSyncRequestContinuations ? { mainSyncRequestContinuations: input.mainSyncRequestContinuations } : {}) };
        if (input.mainSyncCiRun) operationContext.mainSyncCiRun = input.mainSyncCiRun;
        if (input.mainSyncValidation) operationContext.mainSyncValidation = input.mainSyncValidation;
        writeFileSync(join(place.dir, "vibe-record-turn.lock", CLAUDE_OPERATION_OWNER), JSON.stringify({
          context: operationContext, branch: place.branch,
          ...(persistent && lease ? { primaryOwner: { workerId, lease } } : {}),
        }), { mode: 0o600, flag: "wx" });
      }
    }
    writeFileSync(definitionFile, JSON.stringify({ [definition.name]: bound.agent }), { mode: 0o600, flag: "wx" });
    trace = openSync(tracePath, "wx", 0o600);
    const timeoutMs = input.mainSyncValidation
      ? await deriveValidationEnvelope(operationContext!, place.dir, place.branch, () => prelaunchCanceled)
      : input.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    if (prelaunchCanceled) throw new Error("Owned worker turn canceled before Claude spawn");
    if (persistent && lease) resume = markClaudeStarted(input.worktree, workerId, lease).resume;
    const args = ["--print", "--verbose", "--output-format", "stream-json", "--agent", definition.name,
      "--json-schema", JSON.stringify(workerResultJsonSchemaFor(input.agentName)),
      "--agents", definitionFile, "--model", bound.model,
      "--tools", bound.tools.join(","), "--disallowedTools", bound.reader
        ? "Agent,Task,Write,Edit,NotebookEdit,EnterWorktree,ExitWorktree"
        : bound.tools.includes("Agent") ? "Task,EnterWorktree,ExitWorktree,NotebookEdit"
          : "Agent,Task,EnterWorktree,ExitWorktree,NotebookEdit",
      "--permission-mode", "default",
      "--allowedTools", bound.tools.join(","),
      ...protectedArgs,
      resume ? "--resume" : "--session-id", workerId,
      "--name", workerSessionName(input.agentName, place.branch, input.requestId)];
    const launch = launchProcess(args, bound.tools, place.root, JSON.stringify({ requestId: input.requestId,
      mode: input.mode, authority: { testAuthoringAuthorized: testAuthoringGranted(input),
        testRepairAuthorized: persistent && TEST_REPAIR_MODES.has(input.mode) },
      ...(input.sessionless ? { sessionless: input.sessionless } : {}),
      ...(input.discardTarget ? { discardTarget: input.discardTarget } : {}),
      ...(input.recordAction ? { recordAction: input.recordAction } : {}),
      ...(operationContext ? { operationContext } : {}), ...referenceImagesFor(input.agentName, place.dir),
      input: turnInput }), timeoutMs, trace, input.allowCredits === true, (processGroupId) => {
        if (persistent && lease) attachClaudeProcess(input.worktree, workerId, lease, processGroupId);
      }, !input.mainSyncValidation);
    process.removeListener("SIGTERM", cancelBeforeLaunch);
    process.removeListener("SIGINT", cancelBeforeLaunch);
    const output = await launch;
    if (output.sessionId !== workerId) throw new Error("Claude returned a different session identity; no fresh fallback is permitted");
    const endingReviewSource = reviewSource ? reviewSourceIdentity(definition.root, place.root) : undefined;
    if (reviewSource && JSON.stringify(endingReviewSource) !== JSON.stringify(reviewSource)) {
      throw new WorkerRefusal("REVIEWER_SOURCE_CHANGED",
        `Reviewer source changed during its read-only turn from ${JSON.stringify(reviewSource)} to ${JSON.stringify(endingReviewSource)}. Rerun the review on the final settled source.`);
    }
    const graphCapabilities = input.capabilities.filter((capability) => capability.service === "graph" && capability.access === "read");
    const graphToolAliases = [...new Set(graphCapabilities.flatMap((capability) => mcpToolAliases(capability.name)))];
    if (input.agentName === "vibe-storybook-decomposer" && output.status === "DONE" && graphToolAliases.length > 0
      && graphCalls({ graphToolAliases }, reviewTraceFacts(readFileSync(tracePath, "utf8"))).length === 0) {
      throw new WorkerRefusal("GRAPH_EVIDENCE_REQUIRED", "Storybook decomposition had read-only graph tools but made no graph call. Relaunch with the same inputs and use the granted graph before returning DONE.");
    }
    if (operationContext && isPublisherContext(input)) checkPreparationResult(output, place.dir, input, operationContext.lease);
    checkPreviewResult(input, output, definition.root, place.root);
    if (persistent && lease) changeWriter("finish", { worktree: input.worktree, workerId, requestId: input.requestId,
      lease, status: output.status, resultSummary: output.summary });
    return { ...output, runtime: "claude", agentName: input.agentName, ...(reviewSource ? { source: reviewSource, worktree: realpathSync(place.root) } : {}),
      ...(takeover ? { takeover } : {}),
      graphToolIdentities: graphCapabilities.map((capability) => mcpToolIdentity(capability.name)),
      graphToolAliases,
      workerId, requestId: input.requestId, tracePath,
      writer: persistent ? readWriterSummary(input.worktree) : undefined };
  } catch (error) {
    cleanupBlocked = error instanceof OwnedCleanupError;
    let leaseRetained = persistent && Boolean(lease);
    if (persistent && lease && !cleanupBlocked) {
      try {
        changeWriter("finish", { worktree: input.worktree, workerId, requestId: input.requestId,
          lease, status: "FAILED", resultSummary: "Worker turn failed; retain this request and resume the same writer." });
        leaseRetained = false;
      } catch { leaseRetained = true; }
    }
    const failure = error instanceof WorkerRefusal && error.code === "STRUCTURED_OUTPUT_RETRY_EXHAUSTED" && input.mode === "record"
      ? { code: "RECORD_RESULT_UNVERIFIED", summary: "The record turn's final status failed structured output validation. Its write may have succeeded. Do not repeat the write; perform read-only reconciliation of the ticket and session record, then continue from the verified state." }
      : safeFailure(error, input);
    if (!persistent && failure.code === "TURN_TIMEOUT") {
      failure.summary = `Read-only role ${input.agentName} timed out. Relaunch that same role fresh with a new requestId and input; reviewer turns cannot be continued.`;
    }
    const capHit = persistent && failure.code === "TURN_TIMEOUT" ? capCheckpoint(place.root, place.dir, turnId) : undefined;
    if (capHit) {
      failure.summary = `CAP-HIT: the turn hit its time cap with ${capHit.dirtyFiles} changed files${capHit.midMerge ? ", mid-merge" : ""}`
        + `${capHit.patch ? `; work saved as ${capHit.patch}` : ""}. Continue this request with the same writer.`;
    }
    throw new WorkerLaunchError({ status: "BLOCKED", ...failure, workerId, sessionId: workerId,
      requestId: input.requestId, tracePath, leaseRetained, recordLeaseRetained: recordLock && cleanupBlocked,
      ...(capHit ? { capHit } : {}) });
  } finally {
    process.removeListener("SIGTERM", cancelBeforeLaunch);
    process.removeListener("SIGINT", cancelBeforeLaunch);
    if (trace !== undefined) closeSync(trace);
    rmSync(definitionFile, { force: true });
    if (recordLock && !cleanupBlocked) rmSync(join(place.dir, "vibe-record-turn.lock"), { recursive: true });
    if (discardLock && !cleanupBlocked && discardPlace) rmSync(join(discardPlace.dir, "vibe-record-turn.lock"), { recursive: true, force: true });
  }
}

/** Owns only the spawned child and its streams; bounded failure never falls back to another session. */
async function launchProcessOnce(args: string[], granted: readonly string[], cwd: string, input: string,
  timeoutMs: number, startupTimeoutMs: number | null, trace: number, allowCredits: boolean,
  attach: (pid: number) => void, excludeToolWait: boolean) {
  return await new Promise<{ status: WorkerStatus; summary: string; data?: Record<string, unknown>; sessionId: string;
    rateLimit?: ClaudeRateLimit }>((resolve, reject) => {
    // A caller's own CLAUDE_CODE_MCP_STARTUP_WAIT_MS wins, a budget too short for any wait keeps Claude's default,
    // and an older Claude ignores the unknown name.
    const env = { ...process.env };
    const mcpWait = childMcpStartupWaitMs(timeoutMs, startupTimeoutMs);
    if (mcpWait > 0) env.CLAUDE_CODE_MCP_STARTUP_WAIT_MS ??= String(mcpWait);
    const child: ChildProcessWithoutNullStreams = spawn("claude", args, { cwd, env, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"] });
    let stderrText = "";
    let failed: Error | undefined;
    let lines = "";
    let bytes = 0;
    let final: z.infer<typeof resultSchema> | undefined;
    let authFailed = false;
    let rateLimit: ClaudeRateLimit | undefined;
    const decoder = new StringDecoder("utf8");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupRefused = false;
    const sendStop = (signal: NodeJS.Signals) => {
      if (cleanupRefused) return false;
      try {
        signalOwnedChild(child, signal);
        return true;
      } catch (error) {
        cleanupRefused = true;
        releaseTimers();
        // Preserve the owning record. The launcher cannot claim the cleanup or permit a second writer.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(error);
        return false;
      }
    };
    const stop = (reason: Error) => {
      failed ??= reason;
      const timer = escalateOwnedStop(sendStop, (escalate) => killTimer ?? setTimeout(escalate, 1000));
      if (timer) killTimer = timer;
    };
    const onSignal = () => stop(new Error("Owned worker turn canceled"));
    // The brief is already piped. An observed init with missing grants stops the child; pending grants may retry.
    const checkInit = (event: unknown) => {
      const init = initSchema.safeParse(event);
      if (!init.success) return;
      if (initTimer) clearTimeout(initTimer);
      const missing = missingMcpTools(init.data.tools, granted);
      if (missing.length) {
        const servers = missingServers(missing);
        const statuses = new Map(init.data.mcp_servers?.map((server) => [server.name, server.status]));
        if (servers.every((server) => statuses.get(server) === "pending")) {
          stop(new PendingMcpError(servers));
        } else {
          stop(new LaunchPrecheckError("MCP_TOOLS_MISSING",
            `The worker started without its granted connections: ${servers.join(", ")}`));
        }
      }
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    // The validation envelope is derived for wall-clock lanes, so it keeps counting tool time.
    const cap = createTurnCap(timeoutMs, (reason) => stop(new Error(reason === "tool"
      ? "Owned worker turn exceeded its deadline: one tool call ran past the step cap"
      : "Owned worker turn exceeded its deadline")));
    const trackTools = (event: unknown) => {
      if (!excludeToolWait) return;
      const started = toolUseEventSchema.safeParse(event);
      if (started.success) for (const block of started.data.message.content) if (block.type === "tool_use" && block.id) cap.toolStarted(block.id);
      const finished = toolResultEventSchema.safeParse(event);
      if (finished.success) for (const block of finished.data.message.content) if (block.type === "tool_result" && block.tool_use_id) cap.toolFinished(block.tool_use_id);
    };
    const initTimer = armMcpInitWatchdog(startupTimeoutMs, () => stop(new LaunchPrecheckError(
      "MCP_TOOLS_MISSING", "The worker did not report its granted tools during bounded startup")));
    child.once("spawn", () => {
      try { if (child.pid) attach(child.pid); }
      catch { stop(new Error("Unable to bind the owned process to its writer turn")); }
    });
    child.on("error", (error) => { failed = error; });
    child.stdin.on("error", (error) => stop(error));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { stop(new Error("Worker trace exceeds its bounded limit")); return; }
      try { writeSync(trace, chunk); }
      catch { stop(new Error("Unable to preserve private worker trace")); return; }
      lines += decoder.write(chunk);
      let end = lines.indexOf("\n");
      while (end >= 0) {
        const line = lines.slice(0, end);
        lines = lines.slice(end + 1);
        try {
          const event: unknown = capturedJson(line);
          checkInit(event);
          trackTools(event);
          rateLimit = rateLimitFromEvent(event) ?? rateLimit;
          if (mustStopForUsage(rateLimit, allowCredits)) {
            stop(new LaunchPrecheckError("USAGE_LIMIT_REACHED", "Claude reported a reached usage limit or paid extra usage"));
          }
          const parsed = resultSchema.safeParse(event);
          if (parsed.success) {
            final = parsed.data;
            if (final.is_error && isAuthFailure(final.result ?? "")) authFailed = true;
          }
        } catch { stop(new Error("Claude emitted malformed structured output")); }
        end = lines.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      stderrText = `${stderrText}${chunk.toString("utf8")}`.slice(-4 * STDERR_TAIL_BYTES);
      if (isAuthFailure(chunk.toString("utf8"))) authFailed = true;
      if (bytes > 8 * 1024 * 1024) stop(new Error("Worker trace exceeds its bounded limit"));
      else {
        try { writeSync(trace, `${JSON.stringify({ type: "stderr", text: chunk.toString("utf8") })}\n`); }
        catch { stop(new Error("Unable to preserve private worker trace")); }
      }
    });
    function releaseTimers() {
      cap.stop();
      if (initTimer) clearTimeout(initTimer);
      if (killTimer) clearTimeout(killTimer);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    child.on("close", (code) => {
      releaseTimers();
      if (cleanupRefused) return;
      finishOwnedGroup(child).then(() => {
        if (authFailed && !(failed instanceof LaunchPrecheckError)) {
          reject(new LaunchPrecheckError("CLAUDE_SIGN_IN_NEEDED", "Claude refused the stored sign-in", SIGN_IN_PERSON_ACTION));
          return;
        }
        if (failed) { reject(failed); return; }
        if (final?.is_error && final.terminal_reason === "structured_output_retry_exhausted") {
          reject(new WorkerRefusal("STRUCTURED_OUTPUT_RETRY_EXHAUSTED",
            "Claude exhausted structured output retries; continue the same request with a shorter compact result."));
          return;
        }
        if (code !== 0) { reject(new ClaudeExitError(code, stderrTail(stderrText))); return; }
        if (!final) { reject(new WorkerRefusal("CLAUDE_RESULT_MISSING", "Claude returned no final result record. Inspect the private trace and continue the same request.")); return; }
        if (final.is_error) { reject(new WorkerRefusal("CLAUDE_RESULT_ERROR", "Claude marked its final result as an error. Inspect the private trace and continue the same request.")); return; }
        if (final.structured_output === undefined && !final.result) { reject(new WorkerRefusal("CLAUDE_RESULT_EMPTY", "Claude returned no structured result payload. Continue the same request.")); return; }
        try {
          let rawResult: unknown;
          try { rawResult = final.structured_output !== undefined ? final.structured_output : capturedJson(final.result!); }
          catch { throw new WorkerRefusal("WORKER_RESULT_JSON_INVALID", "The worker returned invalid JSON instead of a compact status object."); }
          const parsed = workerResultSchema.safeParse(capWorkerResult(rawResult));
          if (!parsed.success) throw new WorkerRefusal("WORKER_RESULT_SCHEMA_INVALID",
            `The worker returned an invalid compact status object: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "result"} ${issue.message}`).join("; ")}`);
          const result = parsed.data;
          resolve({ ...result, sessionId: final.session_id, ...(rateLimit ? { rateLimit } : {}) });
        } catch (error) { reject(error); }
      }, reject);
    });
    child.stdin.end(`${input}\n`);
  });
}

/** Retry only a pending MCP init, after owned cleanup, under the same worker identity and deadline. */
async function launchProcess(args: string[], granted: readonly string[], cwd: string, input: string,
  timeoutMs: number, trace: number, allowCredits: boolean, attach: (pid: number) => void, excludeToolWait: boolean) {
  const started = Date.now();
  const turnDeadline = started + timeoutMs;
  let readinessDeadline: number | null = null;
  let attemptArgs = args;
  let lastPending: PendingMcpError | undefined;
  let attempts = 0;
  for (let attempt = 1; ; attempt += 1) {
    const budget = remainingWorkerTurnBudget({ turnDeadline,
      readinessDeadline: readinessDeadline ?? turnDeadline, now: Date.now() });
    if (!canStartWorkerAttempt(budget)) break;
    attempts = attempt;
    try {
      return await launchProcessOnce(attemptArgs, granted, cwd, input,
        budget.turnTimeoutMs, readinessDeadline === null ? null : budget.startupTimeoutMs,
        trace, allowCredits, attach, excludeToolWait);
    } catch (error) {
      if (!(error instanceof PendingMcpError)) throw error;
      lastPending = error;
      readinessDeadline ??= Math.min(turnDeadline, Date.now() + MCP_READINESS_WINDOW_MS);
      writeSync(trace, `${JSON.stringify({ type: "mcp_startup_pending", attempt,
        servers: error.servers })}\n`);
      if (readinessDeadline - Date.now() <= MCP_STARTUP_RETRY_DELAY_MS) break;
      const sessionFlag = attemptArgs.indexOf("--session-id");
      if (sessionFlag >= 0) {
        attemptArgs = [...attemptArgs];
        attemptArgs[sessionFlag] = "--resume";
      }
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); cleanup(); reject(new Error("Owned worker turn canceled")); };
        const cleanup = () => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, MCP_STARTUP_RETRY_DELAY_MS);
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
      });
    }
  }
  if (!lastPending) throw new Error("Owned worker turn exceeded its deadline");
  throw new McpStillPendingError(lastPending.servers, attempts, Date.now() - started);
}

class WorkerLaunchError extends Error {
  constructor(readonly result: { status: "BLOCKED"; code: string; summary: string; personAction?: string; workerId: string;
    sessionId: string; requestId: string; tracePath: string; leaseRetained: boolean; recordLeaseRetained: boolean;
    capHit?: CapCheckpoint } & FailureDetail) {
    super(result.summary);
  }
}

function invalidRequestSummary(error: z.ZodError, rawInput?: unknown): string {
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? rawInput as Record<string, unknown> : undefined;
  const modeIssue = error.issues.find((issue) => issue.path.join(".") === "mode");
  if (modeIssue && typeof input?.mode === "string" && typeof input.agentName === "string") {
    try {
      const actions = Object.keys(recordModes(sessionBinding(typeof input.worktree === "string" ? input.worktree : undefined))[input.agentName] ?? {});
      if (actions.includes(input.mode)) {
        return `Field mode received record action ${JSON.stringify(input.mode)} for ${input.agentName}. Use mode ${JSON.stringify("record")} with recordAction ${JSON.stringify(input.mode)}. Allowed record actions: ${actions.join(", ")}.`;
      }
    } catch { /* Fall through to the schema-owned issue list. */ }
  }
  return error.issues.map((issue) => {
    const field = issue.path.join(".") || "request";
    if (field === "timeoutMs" && issue.code === "too_big" && "maximum" in issue && typeof issue.maximum === "number") {
      return `${field} received ${String(input?.timeoutMs)}; maximum ${issue.maximum} ms (${issue.maximum / 60_000} minutes)`;
    }
    return `${field}: ${issue.message}`;
  }).join("; ");
}

/** Optional result fields that name a failure's underlying cause; older callers ignore them. */
type FailureCause = { message?: string; code?: string; exitCode?: number | null; stderrTail?: string };
type FailureDetail = { cause?: FailureCause; pendingConnections?: string[] };

export function safeFailure(error: unknown, rawInput?: unknown): { code: string; summary: string; personAction?: string } & FailureDetail {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof ClaudeExitError) {
    return { code: error.code, summary: error.summary,
      cause: { exitCode: error.exitCode, ...(error.stderrTail ? { stderrTail: error.stderrTail } : {}) } };
  }
  if (error instanceof WorkerRefusal) return { code: error.code, summary: error.summary };
  if (error instanceof McpStillPendingError) return { code: error.code, summary: error.message, pendingConnections: error.pendingConnections };
  if (error instanceof LaunchPrecheckError) {
    return { code: error.code, summary: error.message, ...(error.personAction ? { personAction: error.personAction } : {}) };
  }
  if (error instanceof AgentRootError || error instanceof MissingSessionError) return { code: error.code, summary: error.message };
  if (error instanceof ProviderBroken) return { code: "PROVIDER_BROKEN", summary: error.message };
  if (error instanceof Error && "code" in error && error.code === MODEL_OVERRIDES_INVALID) return { code: MODEL_OVERRIDES_INVALID, summary: error.message };
  if (error instanceof Error && "code" in error && error.code === "ENOENT" && "syscall" in error
    && String(error.syscall).startsWith("spawn")) {
    return { code: "CLAUDE_CLI_MISSING", summary: "The claude command is not on this shell's PATH" };
  }
  if (message.includes("Takeover worktree HEAD")) return { code: "TAKEOVER_HEAD_MISMATCH", summary: "The takeover worktree is not at the bound pull request head; fetch and check out that head, then relaunch." };
  if (message.includes("Takeover worktree already has a writer")) return { code: "TAKEOVER_WRITER_BOUND", summary: "This takeover worktree already has its one writer for another pull request or source branch; use a new worktree for another takeover." };
  if (message.includes("never argv")) return { code: "INVALID_REQUEST", summary: "This command takes no arguments; send the launch request on stdin (claude-worker.mjs help prints its shape)." };
  if (error instanceof z.ZodError) {
    if (rawInput && typeof rawInput === "object" && "mode" in rawInput && rawInput.mode === "record"
        && "agentName" in rawInput && typeof rawInput.agentName === "string"
        && error.issues.some((issue) => issue.path[0] === "recordAction")) {
      const actions = Object.keys(recordModes(null)[rawInput.agentName] ?? {});
      return { code: "RECORD_ACTION_UNDECLARED",
        summary: `Record action is not declared for ${rawInput.agentName}. Allowed actions: ${actions.join(", ") || "none"}.` };
    }
    return { code: "INVALID_REQUEST", summary: invalidRequestSummary(error, rawInput) };
  }
  if (error instanceof OwnedSignalRefusal) return { code: "OWNED_PROCESS_SIGNAL_REFUSED", summary: error.message };
  if (error instanceof OwnedCleanupError) return { code: "OWNED_PROCESS_NOT_STOPPED", summary: "Owned process cleanup is unproven; the unsafe turn remains locked." };
  if (message.includes("deadline")) return { code: "TURN_TIMEOUT", summary: "The owned worker turn exceeded its deadline." };
  if (message.includes("canceled")) return { code: "TURN_CANCELED", summary: "The owned worker turn was canceled." };
  if (message.includes("requires a supported POSIX")) return { code: "RUNTIME_UNSUPPORTED", summary: "This runtime has no supported owned-descendant cleanup harness." };
  if (message.includes("different session identity")) return { code: "SESSION_MISMATCH", summary: "The runtime returned a different session; no fresh-session fallback was attempted." };
  if (message.includes("binding changed")) return { code: "WRITER_BINDING_CHANGED", summary: "The persistent writer binding changed; restore the exact original binding." };
  if (message.includes("Continue the active request")) return { code: "ACTIVE_REQUEST_PENDING", summary: "Continue the current request before consuming queued work." };
  const cause = failureCause(error);
  return { code: "WORKER_TURN_FAILED", summary: "The worker turn failed; inspect its private evidence and retain the same writer identity."
    + (cause.message ? ` Cause: ${cause.message}` : "") + (cause.code ? ` (${cause.code})` : ""),
    ...(cause.message || cause.code ? { cause } : {}) };
}

/**
 * The underlying cause of an otherwise unclassified failure (operator item 31(c)): its message and its code or refusal
 * id. A parse error's message can quote the text it parsed (the brief), so only its kind is kept.
 */
function failureCause(error: unknown): FailureCause {
  if (!(error instanceof Error)) return {};
  const code = "code" in error && typeof error.code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : undefined;
  const message = error instanceof SyntaxError ? "malformed JSON" : error.message.replace(/\s+/g, " ").trim().slice(0, CAUSE_MESSAGE_LIMIT);
  return { ...(message ? { message } : {}), ...(code ? { code } : {}) };
}

export async function main(argv: string[]): Promise<number> {
  if (asksForUsage(argv)) {
    process.stdout.write(`${claudeWorkerUsage()}\n`);
    return 0;
  }
  let input: unknown;
  try {
    if (argv.length) throw new Error("Send the worker brief and capability metadata on stdin, never argv");
    input = await readInput();
    const result = await runWorker(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "BLOCKED" || result.status === "FAILED" ? 1 : 0;
  } catch (error) {
    const identity = z.object({ worktree: z.string(), requestId: identifierSchema }).passthrough().safeParse(input);
    let writer: ReturnType<typeof readWriterSummary>;
    try { writer = identity.success ? readWriterSummary(identity.data.worktree) : undefined; } catch { writer = undefined; }
    const result = error instanceof WorkerLaunchError ? error.result : { status: "BLOCKED", ...safeFailure(error, input),
      requestId: identity.success ? identity.data.requestId : undefined,
      workerId: writer?.workerId, sessionId: writer?.runtime === "claude" ? writer.workerId : undefined,
      leaseRetained: writer?.running };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return "code" in result && result.code === "PROVIDER_BROKEN" ? 4 : 1;
  }
}

/** Roles that look at the person's visual references: the writer builds to them, requirements and verify read them. */
const REFERENCE_IMAGE_ROLES: ReadonlySet<string> = new Set(["vibe-change-worker", "vibe-requirements-worker", "vibe-verify-worker"]);

/** Names the session's saved reference images in the turn envelope; the role opens each path as an image. */
function referenceImagesFor(agentName: string, metadataDir: string) {
  if (!REFERENCE_IMAGE_ROLES.has(agentName)) return {};
  const referenceImages = readReferenceImages(metadataDir);
  return referenceImages.length ? { referenceImages } : {};
}

/** Writer turns that may mechanically repair existing tests the session's change broke (operator ruling, 2026-10-13). */
const TEST_REPAIR_MODES: ReadonlySet<string> = new Set(["request", "fix", "handoff", "pull-request"]);
const SUMMARY_LIMIT = 4096;
const RESULT_LIMIT = 16 * 1024;
const TRUNCATED = " [truncated by the launcher]";
const DATA_DROPPED = " [data dropped by the launcher: over 16 KB; see the trace]";

/**
 * The launcher caps a result instead of rejecting it after the turn. A result
 * rejected for length left its request open, and the writer refused the next
 * request until a continuation nobody sent.
 */
export function capWorkerResult(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  const clip = (summary: string, suffix: string) => summary.length + suffix.length <= SUMMARY_LIMIT ? `${summary}${suffix}`
    : `${summary.slice(0, SUMMARY_LIMIT - suffix.length)}${suffix}`;
  if (typeof result.summary === "string" && result.summary.length > SUMMARY_LIMIT) result.summary = clip(result.summary, TRUNCATED);
  const originalBytes = JSON.stringify(result).length;
  if (originalBytes > RESULT_LIMIT && "data" in result) {
    result.status = "BLOCKED";
    result.data = { launcher: { code: "WORKER_DATA_TOO_LARGE", originalBytes } };
    if (typeof result.summary === "string") result.summary = clip(result.summary, DATA_DROPPED);
  }
  return result;
}

type CapCheckpoint = { dirtyFiles: number; midMerge: boolean; patch?: string };

/**
 * A writer turn that hits its time cap leaves its edits uncommitted, twice
 * mid-merge, with no report (vibe-13007, 2026-10-23). Before the turn is
 * released, record what it left and save tracked changes as a patch in the
 * git dir; nothing is committed, reset or discarded.
 */
function capCheckpoint(root: string, gitDir: string, turnId: string): CapCheckpoint | undefined {
  try {
    const run = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"] });
    const dirtyFiles = run(["status", "--porcelain"]).split("\n").filter(Boolean).length;
    const midMerge = existsSync(join(gitDir, "MERGE_HEAD"));
    const diff = run(["diff", "--binary", "HEAD"]);
    if (!diff) return { dirtyFiles, midMerge };
    const patch = join(gitDir, `vibe-cap-${turnId}.patch`);
    writeFileSync(patch, diff, { mode: 0o600, flag: "wx" });
    return { dirtyFiles, midMerge, patch };
  } catch { return undefined; }
}
runFromCanonicalEntry(import.meta.url, main);

/**
 * The saved session's title, e.g. "vibe guardrails reviewer · prd818 · prd818-guardrails-05". The Codex app's
 * Import Claude turns each saved Claude session into a sidebar chat titled by this name, else by the first
 * message, which here is the JSON request envelope.
 */
export function workerSessionName(agentName: string, branch: string, requestId: string) {
  const role = agentName.replace(/^vibe-/, "").replaceAll("-", " ");
  return `vibe ${role} · ${branch.replace(/^vibe\//, "")} · ${requestId}`;
}

function checkoutHead(root: string) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
