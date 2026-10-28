import { graphOperations, liveReadOperations, recordOperations } from "./contracts.js";

/** The words that ask a vibe worker CLI for its usage instead of running it (ISS-13291). */
export function asksForUsage(argv: string[]): boolean {
  return argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!);
}

/** Which MCP tools a writer binding may carry, from the same sets the capability schema checks. */
export function capabilityUsage(): string {
  const list = (values: Set<string>) => [...values].sort().join(", ");
  return [
    "Capabilities: a JSON array of at most 48 { name, service, access, operation } entries, one per MCP tool, no duplicates.",
    "  name       the tool as the harness lists it: mcp__<server>__<operation> (underscores or hyphens)",
    `  graph      service "graph", access "read": ${list(graphOperations)}`,
    `  live read  service "closedloop", access "read": ${list(liveReadOperations)}`,
    `  record     service "closedloop", access "write": ${list(recordOperations)}`,
    "  Any other tool is refused as an unsupported capability binding.",
  ].join("\n");
}

export function writerStateUsage(): string {
  return [
    "Usage: writer-state.mjs <action> < request.json",
    "The action is the only argument; the request is one JSON object on stdin, never in argv.",
    "",
    "Actions:",
    "  status          { worktree }  the writer's compact summary, or null",
    "  register        { worktree, runtime, agentName, capabilities, workerId? (codex), agentRoot? }",
    "  migrate         { worktree, runtime, agentRoot, agentName, previousWorkerId, previousDigest,",
    "                    workerId? (codex), capabilities?, retainedRecord?, harnessSwitch? }",
    "                  capabilities left out keeps the recorded binding's; agentRoot is this command's plugin root.",
    "                  A BLOCKED request whose recorded definition is missing is carried over as the active",
    "                  request and returned as carriedBlock; the new writer settles it first.",
    "  enqueue         { worktree, workerId, requestId, input }",
    "  claim           { worktree, workerId, requestId, continuation? }",
    "  take-input      { worktree, workerId, requestId, lease }",
    "  finish          { worktree, workerId, requestId, lease, status, resultSummary?, blockReason?, stoppedTurn? (codex) }",
    "  acquire-record  native helper record grant",
    "  release-record  native helper record release with stopped-turn evidence",
    "  help            this text",
    "",
    capabilityUsage(),
    "",
    "The full procedure is the vibe skill's quality loop, \"Recorded definition migration\".",
  ].join("\n");
}

export function claudeWorkerUsage(): string {
  return [
    "Usage: claude-worker.mjs < launch.json",
    "Launches one canonical vibe agent as an owned Claude session. Takes no arguments;",
    "the launch request is one JSON object on stdin.",
    "",
    "Fields: worktree, agentName, mode, requestId, capabilities, and input (a new request) or continuation",
    "(the active request). Optional: agentRoot, timeoutMs, allowCredits, and the record fields",
    "(recordAction, exclusiveRecordTurn, ...) for a record turn.",
    "Prints one JSON result; exits 1 when the status is BLOCKED or FAILED.",
    "",
    capabilityUsage(),
  ].join("\n");
}
