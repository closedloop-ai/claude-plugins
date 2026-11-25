import { capabilityOperations, TRACKER_SERVICE } from "./contracts.js";

/** The words that ask a vibe worker CLI for its usage instead of running it. */
export function asksForUsage(argv: string[]): boolean {
  return argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!);
}

/** Which MCP tools a writer binding may carry, from the same sets the capability schema checks. */
export function capabilityUsage(): string {
  const list = (values: Set<string>) => [...values].sort().join(", ") || "none (no provider bound)";
  const operations = capabilityOperations();
  return [
    "Capabilities: a JSON array of at most 48 { name, service, access, operation } entries, one per MCP tool, no duplicates.",
    "  name       the tool as the harness lists it: mcp__<server>__<operation> (underscores or hyphens)",
    `  graph      service "graph", access "read": ${list(operations.graph)}`,
    `  live read  service "${TRACKER_SERVICE}", access "read": ${list(operations.read)}`,
    `  record     service "${TRACKER_SERVICE}", access "write": ${list(operations.record)}`,
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
    "                  capabilities left out keeps the recorded binding's, except that a harnessSwitch requires them",
    "                  in the new runtime's tool names; agentRoot is this command's plugin root. A Claude binding",
    "                  keeps reads and only the record writes a change-worker action declares, and the result returns",
    "                  them as capabilities. A same-runtime call whose capabilities differ only in naming rebinds.",
    "                  A BLOCKED request whose recorded definition is missing is carried over as the active",
    "                  request and returned as carriedBlock; the new writer settles it first.",
    "  enqueue         { worktree, workerId, requestId, input }",
    "                  Behind an open active request the result names it in queuedBehind: claim waits until it is continued.",
    "  start           { worktree, workerId, requestId, input }  only when neither active nor queued work comes first;",
    "                  a queued requestId sent with its own queued input is claimed by that id.",
    "  claim           { worktree, workerId, requestId, continuation? }",
    "  drop-pending    { worktree, workerId, requestId, evidence: { source, reason, inputSha256 } }",
    "                  The parent records why the pending request is obsolete and uses the digest from status.",
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
    "Fields: worktree, agentName, mode, requestId, capabilities, and input for a new request or continuation",
    "for the active request. To claim the oldest pending request, name its requestId and send neither field.",
    "Optional: agentRoot, timeoutMs (default and maximum 1800000 ms), allowCredits, and the record fields.",
    "timeoutMs counts the model's own time; a running tool call pauses it and is bounded by the same value on its own.",
    "A record action uses mode record, recordAction, and exclusiveRecordTurn true.",
    "Prints one JSON result; exits 1 when the status is BLOCKED or FAILED.",
    "",
    capabilityUsage(),
  ].join("\n");
}
