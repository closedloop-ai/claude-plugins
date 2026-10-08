import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { runFromCanonicalEntry } from "./cli.js";
import { capabilitiesSchema, identifierSchema, readInput, statusSchema, type WorkerStatus } from "./contracts.js";
import { readDefinition } from "./definition.js";
import { acquireRecordTurnAt, attachClaudeProcess, changeWriter, markClaudeStarted, readWriterSummary, registerWriter } from "./ledger.js";
import { recordContextSchema, recordModes, resolveRecordContext } from "./record-context.js";

const launchSchema = recordContextSchema.extend({
  agentRoot: z.string().min(1),
  requestId: identifierSchema, input: z.string().min(1).max(64 * 1024).optional(),
  continuation: z.string().min(1).max(64 * 1024).optional(), capabilities: capabilitiesSchema,
  timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).default(15 * 60 * 1000),
}).strict().refine((data) => !(data.input && data.continuation), "Supply input or continuation, not both");
type LaunchInput = z.infer<typeof launchSchema>;
type Definition = ReturnType<typeof readDefinition>;
const resultSchema = z.object({ type: z.literal("result"), session_id: z.string().uuid(),
  is_error: z.boolean().optional(), result: z.string().max(256 * 1024).optional(),
  structured_output: z.unknown().optional(),
}).passthrough();
const workerResultSchema = z.object({ status: statusSchema, summary: z.string().max(4096),
  data: z.record(z.unknown()).optional() }).strict().refine((value) => JSON.stringify(value).length <= 16 * 1024,
    "Worker status data exceeds the compact response limit");
const workerResultJsonSchema = { type: "object", additionalProperties: false,
  properties: { status: { type: "string", enum: statusSchema.options }, summary: { type: "string", maxLength: 4096 },
    data: { type: "object", additionalProperties: true } }, required: ["status", "summary"] };
const structuredOutputTool = "StructuredOutput";
const readerRoles = new Set([
  "vibe-adversarial-reviewer", "vibe-guardrails-reviewer", "vibe-handoff-summarizer",
  "vibe-requirements-worker", "vibe-backend-worker", "vibe-primitive-worker", "vibe-storybook-decomposer",
  "vibe-verify-worker",
]);

/** Exact capabilities are discovered by the parent, then bounded again by role and declared operation. */
export function boundDefinition(definition: Definition, input: LaunchInput) {
  if (!readerRoles.has(input.agentName) && !Object.hasOwn(recordModes, input.agentName)) {
    throw new Error("This role is outside the vibe and handoff owned launcher");
  }
  const prototypeAdvice = input.agentName === "vibe-prototype-worker" && input.mode !== "record";
  const reader = readerRoles.has(input.agentName) || prototypeAdvice;
  const declaredModes = recordModes[input.agentName];
  const possibleWrites = new Set(Object.values(declaredModes ?? {}).flat());
  if (reader && !prototypeAdvice && definition.tools.some((tool) => tool === "Write" || tool === "Edit")) {
    throw new Error("Read-only advisor declares writable filesystem tools");
  }
  if (input.capabilities.some((capability) => capability.access === "write")
    && (reader || input.capabilities.some((capability) => capability.access === "write" && !possibleWrites.has(capability.operation)))) {
    throw new Error("This worker cannot receive record-write capabilities");
  }
  let permittedWrites: readonly string[] = [];
  if (input.mode === "record") {
    if (!input.exclusiveRecordTurn || !input.recordAction || !declaredModes?.[input.recordAction]) {
      throw new Error("Record writes require a declared canonical action and exclusive record turn");
    }
    permittedWrites = declaredModes[input.recordAction] ?? [];
    if (input.capabilities.some((capability) => capability.access === "write" && !permittedWrites.includes(capability.operation))) {
      throw new Error("Record capability is outside this canonical action");
    }
  } else if (input.recordAction || input.exclusiveRecordTurn) throw new Error("Record grants belong only to a separate record continuation");
  if (!input.capabilities.some((capability) => capability.service === "graph")) {
    throw new Error("Parent-discovered read-only graph capabilities are required");
  }
  const roleTools = prototypeAdvice ? definition.tools.filter((tool) => tool !== "Write" && tool !== "Edit") : definition.tools;
  const tools = [...new Set([...roleTools, "ToolSearch", structuredOutputTool, ...input.capabilities
    .filter((capability) => capability.access === "read" || permittedWrites.includes(capability.operation))
    .map((capability) => capability.name)])];
  const persistent = input.agentName === "vibe-change-worker";
  const phasePolicy = persistent
    ? "Current phase and test-authoring authority come only from the orchestrator's top-level turn envelope, separate from raw input text. "
      + "Only an explicitly authorized handoff turn in that envelope may author or edit tests. "
      + "Never author tests in plan, request, fix, record or build turns, or infer authority from the person's words. "
    : `This is mode ${input.mode}. Never write or edit tests. `;
  const prompt = `${definition.prompt}\n\nRuntime binding: work only in ${input.worktree}. `
    + `Resolve this canonical definition's relative resource references against ${join(definition.root, "agents")}. `
    + "Never start another implementation writer, commit, or push. " + phasePolicy
    + (reader ? "This session is read-only. Bash and Skill may inspect existing sources, never mutate files or records. " : "")
    + (input.agentName === "vibe-prototype-worker"
      ? `Use canonical ${prototypeAdvice ? "advice" : "share"} mode; operational publication never authors source. ` : "")
    + "Return one JSON object with status, summary (at most 4096 characters), and optional data. "
    + "Finish by calling the native StructuredOutput tool exactly once with that compact object. "
    + "Return compact facts, paths and status, never source bodies, raw tool responses, credentials or transcript text. "
    + "Use status PLAN, NEEDS_REVIEW, NEEDS_PERSON, NEEDS_COMMIT, NEEDS_CHANGE, NEEDS_PRIMITIVE, NEEDS_BACKEND, NEEDS_DESKTOP_STOP, DONE, BLOCKED, or FAILED. "
    + "DONE means the whole current request is complete; intermediate units keep the request active.";
  const agent = { description: definition.metadata.description, prompt, model: definition.metadata.model, tools,
    ...(definition.skills.length ? { skills: definition.skills } : {}) };
  return { agent, reader, tools };
}

/** Launches the canonical scoped agent directly; the registered writer resumes its original context. */
export async function runWorker(rawInput: unknown) {
  const input = launchSchema.parse(rawInput);
  if (process.platform === "win32") throw new Error("Owned descendant cleanup requires a supported POSIX process-group harness");
  const definition = readDefinition(input.agentRoot, input.agentName, input.capabilities);
  const bound = boundDefinition(definition, input);
  const { place, target: discardPlace } = resolveRecordContext(input);
  const persistent = input.agentName === "vibe-change-worker";
  let workerId: string = randomUUID();
  let lease: string | undefined;
  let resume = false;
  let turnInput = input.input ?? input.continuation ?? "";
  if (persistent) {
    const registered = registerWriter({ worktree: input.worktree, runtime: "claude", agentRoot: definition.root,
      agentName: input.agentName, capabilities: input.capabilities });
    workerId = registered.workerId;
    if (input.input) changeWriter("enqueue", { worktree: input.worktree, workerId, requestId: input.requestId, input: input.input });
    const claim = changeWriter("claim", { worktree: input.worktree, workerId, requestId: input.requestId,
      ...(input.continuation ? { continuation: input.continuation } : {}) });
    lease = claim.turn?.lease;
    if (!lease) throw new Error("Writer claim returned no owned turn");
    turnInput = claim.turn?.continuation ?? claim.turn?.input ?? "";
  } else if (!input.input || input.continuation) throw new Error("Advisors require a fresh read-only input");
  const turnId = randomUUID();
  const definitionFile = join(place.dir, `vibe-agent-${turnId}.json`);
  const tracePath = join(place.dir, `vibe-worker-${turnId}.jsonl`);
  let trace: number | undefined;
  let recordLock = false;
  let discardLock = false;
  let cleanupBlocked = false;
  try {
    if (input.mode === "record") {
      if (discardPlace) { acquireRecordTurnAt(discardPlace); discardLock = true; }
      acquireRecordTurnAt(place, persistent && lease ? { workerId, lease } : undefined);
      recordLock = true;
    }
    writeFileSync(definitionFile, JSON.stringify({ [definition.name]: bound.agent }), { mode: 0o600, flag: "wx" });
    trace = openSync(tracePath, "wx", 0o600);
    if (persistent && lease) resume = markClaudeStarted(input.worktree, workerId, lease).resume;
    const args = ["--print", "--verbose", "--output-format", "stream-json", "--agent", definition.name,
      "--json-schema", JSON.stringify(workerResultJsonSchema),
      "--agents", definitionFile, "--model", definition.metadata.model,
      "--tools", bound.tools.join(","), "--disallowedTools", bound.reader
        ? "Agent,Task,Write,Edit,NotebookEdit,EnterWorktree,ExitWorktree"
        : "Agent,Task,EnterWorktree,ExitWorktree,NotebookEdit",
      "--permission-mode", "default",
      "--allowedTools", bound.tools.join(","),
      resume ? "--resume" : "--session-id", workerId];
    const output = await launchProcess(args, place.root, JSON.stringify({ requestId: input.requestId,
      mode: input.mode, authority: { testAuthoringAuthorized: persistent && input.mode === "handoff" },
      ...(input.sessionless ? { sessionless: input.sessionless } : {}),
      ...(input.discardTarget ? { discardTarget: input.discardTarget } : {}),
      ...(input.recordAction ? { recordAction: input.recordAction } : {}), input: turnInput }), input.timeoutMs, trace, (processGroupId) => {
        if (persistent && lease) attachClaudeProcess(input.worktree, workerId, lease, processGroupId);
      });
    if (output.sessionId !== workerId) throw new Error("Claude returned a different session identity; no fresh fallback is permitted");
    if (persistent && lease) changeWriter("finish", { worktree: input.worktree, workerId, requestId: input.requestId,
      lease, status: output.status, resultSummary: output.summary });
    return { ...output, workerId, requestId: input.requestId, tracePath,
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
    const failure = safeFailure(error);
    throw new WorkerLaunchError({ status: "BLOCKED", ...failure, workerId, sessionId: workerId,
      requestId: input.requestId, tracePath, leaseRetained, recordLeaseRetained: recordLock && cleanupBlocked });
  } finally {
    if (trace !== undefined) closeSync(trace);
    rmSync(definitionFile, { force: true });
    if (recordLock && !cleanupBlocked) rmSync(join(place.dir, "vibe-record-turn.lock"), { recursive: true });
    if (discardLock && !cleanupBlocked && discardPlace) rmSync(join(discardPlace.dir, "vibe-record-turn.lock"), { recursive: true, force: true });
  }
}

/** Owns only the spawned child and its streams; bounded failure never falls back to another session. */
async function launchProcess(args: string[], cwd: string, input: string, timeoutMs: number, trace: number,
  attach: (pid: number) => void) {
  return await new Promise<{ status: WorkerStatus; summary: string; data?: Record<string, unknown>; sessionId: string }>((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn("claude", args, { cwd, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"] });
    let failed: Error | undefined;
    let lines = "";
    let bytes = 0;
    let final: z.infer<typeof resultSchema> | undefined;
    const decoder = new StringDecoder("utf8");
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: Error) => {
      failed ??= reason;
      signalOwnedChild(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalOwnedChild(child, "SIGKILL"), 1000);
    };
    const onSignal = () => stop(new Error("Owned worker turn canceled"));
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    const deadline = setTimeout(() => stop(new Error("Owned worker turn exceeded its deadline")), timeoutMs);
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
        try { const parsed = resultSchema.safeParse(JSON.parse(line)); if (parsed.success) final = parsed.data; }
        catch { stop(new Error("Claude emitted malformed structured output")); }
        end = lines.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop(new Error("Worker trace exceeds its bounded limit"));
      else {
        try { writeSync(trace, `${JSON.stringify({ type: "stderr", text: chunk.toString("utf8") })}\n`); }
        catch { stop(new Error("Unable to preserve private worker trace")); }
      }
    });
    child.on("close", (code) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
      finishOwnedGroup(child).then(() => {
        if (failed) { reject(failed); return; }
        if (code !== 0 || !final || final.is_error || (final.structured_output === undefined && !final.result)) { reject(new Error("Claude failed or returned no successful structured result")); return; }
        try {
          const result = workerResultSchema.parse(final.structured_output !== undefined
            ? final.structured_output : JSON.parse(final.result!));
          resolve({ ...result, sessionId: final.session_id });
        } catch { reject(new Error("Worker returned no valid compact status object")); }
      }, reject);
    });
    child.stdin.end(`${input}\n`);
  });
}

class OwnedCleanupError extends Error {}
class WorkerLaunchError extends Error {
  constructor(readonly result: { status: "BLOCKED"; code: string; summary: string; workerId: string;
    sessionId: string; requestId: string; tracePath: string; leaseRetained: boolean; recordLeaseRetained: boolean }) {
    super(result.summary);
  }
}

function safeFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof z.ZodError) return { code: "INVALID_REQUEST", summary: "The worker request or capability binding does not match the supported contract." };
  if (error instanceof OwnedCleanupError) return { code: "OWNED_PROCESS_NOT_STOPPED", summary: "Owned process cleanup is unproven; the unsafe turn remains locked." };
  if (message.includes("deadline")) return { code: "TURN_TIMEOUT", summary: "The owned worker turn exceeded its deadline." };
  if (message.includes("canceled")) return { code: "TURN_CANCELED", summary: "The owned worker turn was canceled." };
  if (message.includes("requires a supported POSIX")) return { code: "RUNTIME_UNSUPPORTED", summary: "This runtime has no supported owned-descendant cleanup harness." };
  if (message.includes("different session identity")) return { code: "SESSION_MISMATCH", summary: "The runtime returned a different session; no fresh-session fallback was attempted." };
  if (message.includes("binding changed")) return { code: "WRITER_BINDING_CHANGED", summary: "The persistent writer binding changed; restore the exact original binding." };
  if (message.includes("Continue the active request")) return { code: "ACTIVE_REQUEST_PENDING", summary: "Continue the current request before consuming queued work." };
  if (message.includes("running turn") || message.includes("record turn") || message.includes("state is locked")) return { code: "WRITER_BUSY", summary: "The session already has an owned source or record turn." };
  return { code: "WORKER_TURN_FAILED", summary: "The worker turn failed; inspect its private evidence and retain the same writer identity." };
}

/** Completion is not a free writer slot until the owned process group is proven stopped. */
async function finishOwnedGroup(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    throw new OwnedCleanupError("Owned descendant cleanup is unsupported on this platform; writer lease retained for stopped-turn proof");
  }
  signalOwnedChild(child, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(-child.pid, 0); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
      throw new OwnedCleanupError("Unable to prove the owned process group stopped; writer lease retained");
    }
    if (attempt === 5) signalOwnedChild(child, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new OwnedCleanupError("Owned process group is still present; writer lease retained for stopped-turn proof");
}

function signalOwnedChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export async function main(argv: string[]): Promise<number> {
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
    const result = error instanceof WorkerLaunchError ? error.result : { status: "BLOCKED", ...safeFailure(error),
      requestId: identity.success ? identity.data.requestId : undefined,
      workerId: writer?.workerId, sessionId: writer?.runtime === "claude" ? writer.workerId : undefined,
      leaseRetained: writer?.running };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 1;
  }
}
runFromCanonicalEntry(import.meta.url, main);
