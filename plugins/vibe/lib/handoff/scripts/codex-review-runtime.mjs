// Read a managed Codex reviewer's exact completed turn from App Server.
// Its saved MCP items have type mcpToolCall with server, tool and status:
// https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/thread_history.rs
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { finalBodyLines, finalMarker, read as readHelpers, readHelperInput, registrationFingerprint, resolveHelperBrief } from "../../fleet-orchestrator/scripts/helpers.mjs";
import { resolveWorkDir } from "../../codex-fleet-monitor/scripts/work-dir.mjs";
import { assembleProviderText, sessionBinding } from "../../vibe/scripts/provider.mjs";
import { evidenceArray } from "./handoff-evidence.mjs";
import { agentFrontmatterName } from "../../vibe/scripts/agent-frontmatter.mjs";
import { graphAliases } from "./mcp-tool-names.mjs";
import { boundReviewContext, reviewDoctrine } from "./review-context.mjs";
import { findingProblems } from "../../../skills/fleet-orchestrator/scripts/finding-brief.mjs";
import { connectViaProxy, daemonSocket } from "../../codex-fleet-monitor/scripts/liveness.mjs";
import { findCli } from "../../../skills/vibe/scripts/plugin-cli.mjs";

/** Use the same installed executable to discover a daemon and connect its proxy. */
function connectReviewProxy(discover, connect, resolveCli = findCli) {
  const codex = resolveCli("codex");
  if (!codex) throw new Error("Could not find a Codex executable on PATH or in the ChatGPT app bundle");
  return connect(discover(codex), codex);
}

/** Open the independent receipt reader's proxy connection. */
export function reviewReadClient({ discover = daemonSocket, connect = connectViaProxy, resolveCli } = {}) {
  return connectReviewProxy(discover, connect, resolveCli);
}

function nativeMcpName(item) {
  return `mcp__${item.server.replaceAll("-", "_")}__${item.tool}`;
}

/** Completed turn and machine-observed successful MCP calls, or a refusal. */
export function observedCodexTurn(thread, sessionId, turnId) {
  if (thread?.id !== sessionId) throw new Error("App Server returned another native reviewer thread");
  const turn = Array.isArray(thread.turns) ? thread.turns.find(item => item?.id === turnId) : null;
  if (turn?.status !== "completed" || !Array.isArray(turn.items) || turn.items.length === 0 || turn.itemsView === "notLoaded") {
    throw new Error("App Server has no loaded completed reviewer turn and items");
  }
  const toolCalls = turn.items.filter(item => item?.type === "mcpToolCall" && item.status === "completed"
    && typeof item.server === "string" && typeof item.tool === "string")
    .map(nativeMcpName);
  const failedToolCalls = turn.items.filter(item => item?.type === "mcpToolCall" && item.status === "failed"
    && typeof item.server === "string" && typeof item.tool === "string")
    .map(item => ({ name: nativeMcpName(item), error: String(item.error?.message ?? item.error ?? item.message ?? "tool call failed") }));
  return { sessionId, turnId, status: "completed", ...(thread.cwd ? { cwd: realpathSync(thread.cwd) } : {}), toolCalls, failedToolCalls };
}

/** A managed reviewer probes graph first; an approval refusal stops before its findings can be accepted. */
export function codexGraphSetupProblem(runtime, aliases) {
  const refusal = runtime?.failedToolCalls?.find(call => aliases.includes(call.name)
    && /approval|not approved|requires approval/i.test(call.error));
  return refusal ? `Codex reviewer graph tool ${refusal.name} was refused by the approval policy before review. Approve the graph read tools for managed Codex reviewers, then relaunch the review.` : null;
}

/** Read one exact completed turn and its raw App Server items. */
export async function readCodexTurnItems(sessionId, turnId, client) {
  const owned = client ?? reviewReadClient();
  try {
    if (!client) await owned.initialize();
    const { thread } = await owned.request("thread/read", { threadId: sessionId, includeTurns: false });
    let cursor;
    let turn = null;
    do {
      const page = await owned.request("thread/turns/list", { threadId: sessionId, limit: 50, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) });
      turn = (page?.data ?? []).find(item => item?.id === turnId) ?? turn;
      cursor = turn ? null : page?.nextCursor ?? null;
    } while (cursor);
    if (!turn || turn.status !== "completed") throw new Error("App Server did not return the exact completed reviewer turn");
    const items = [];
    cursor = undefined;
    do {
      const page = await owned.request("thread/items/list", { threadId: sessionId, turnId, limit: 100, sortDirection: "asc", ...(cursor ? { cursor } : {}) });
      items.push(...(page?.data ?? []).map(entry => entry?.item).filter(Boolean));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return { thread, turn, items };
  } finally { if (!client) owned.close(); }
}

/** Read one exact thread through the repository's existing App Server client. */
export async function readCodexReviewTurn(sessionId, turnId, client) {
  const { thread, turn, items } = await readCodexTurnItems(sessionId, turnId, client);
  // The summary marker describes thread/turns/list, before these item pages were loaded.
  const loadedTurn = { ...turn, items };
  delete loadedTurn.itemsView;
  return observedCodexTurn({ ...thread, turns: [loadedTurn] }, sessionId, turnId);
}

const helperCli = fileURLToPath(new URL("../../fleet-orchestrator/scripts/helpers.mjs", import.meta.url));

/** Use the ledger's guarded command entry for each transition, including its file lock. */
function helperAction(orchDir, action, name, ...args) {
  execFileSync(process.execPath, [helperCli, orchDir, action, name, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The Codex host's core client owns daemon discovery, the transport and the live connection. */
export async function managedReviewClient({ core, resolveCli } = {}) {
  const { AppServerClient, initializeClient, managedDaemon } = core ?? await import("../../../skills/cl-sweep/scripts/core-client-process.mjs");
  const client = connectReviewProxy(codex => managedDaemon({ runtime: "codex", codex }).socketPath,
    (socket, codex) => new AppServerClient({ runtime: "codex", transport: "proxy", socket, codex }), resolveCli);
  try { await initializeClient(client); return client; }
  catch (error) { client.close(); throw error; }
}

/** Allocate a fresh cwd-bound thread on the caller's initialized managed client. */
async function startReadOnlyThread({ stateFile, worktree, helper, model }, client) {
  const { initializeSession, startThread } = await import("../../../skills/cl-sweep/scripts/native-app-server-orchestrator.mjs");
  const { DEFAULT_REASONING_EFFORT } = await import("../../../skills/cl-sweep/scripts/model-policy.mjs");
  const { listModels } = await import("../../../skills/cl-sweep/scripts/model-catalog.mjs");
  const modelCatalog = await listModels(client);
  const session = initializeSession({ stateFile, cwd: worktree, serviceName: helper, approvalPolicy: "never",
    sandbox: "read-only", model: model, effort: DEFAULT_REASONING_EFFORT, modelCatalog });
  if (session.options.model !== model) throw new Error("The managed Codex App Server cannot run the requested review model " + model);
  // Both operations share one initialized connection, including the first turn on a newly allocated thread.
  const connection = { client, initializeClient: async () => {} };
  const { threadId } = await startThread({ stateFile }, connection);
  return { threadId, connection };
}

/** Dispatch one human QA guide. Return its durable session so the operator can continue in the same thread. */
export async function launchQaGuide(input, openClient = managedReviewClient, resolvePull) {
  const { prepareGuide, loadGuideSkill } = await import("./qa-guide-brief.mjs");
  const worktree = realpathSync(input.worktree);
  const orchDir = realpathSync(resolveWorkDir(input.orchDir).dir);
  if (orchDir === worktree || orchDir.startsWith(worktree + path.sep)) throw new Error("QA guide state belongs outside the source worktree");
  if (!input.writerThread?.trim()) throw new Error("Identify the PR writer thread before dispatch");
  const brief = prepareGuide(resolveHelperBrief(orchDir, input.brief), worktree, resolvePull);
  const client = await openClient();
  try {
    const skill = await loadGuideSkill(client, worktree);
    const stateFile = path.join(mkdtempSync(path.join(orchDir, "codex-qa-guide-")), "session.json");
    const { threadId, connection } = await startReadOnlyThread({ stateFile, worktree, helper: input.helper, model: input.model }, client);
    if (threadId === input.writerThread) throw new Error("QA guide received the PR writer thread");
    const { startTurn } = await import("../../../skills/cl-sweep/scripts/native-app-server-orchestrator.mjs");
    const { turnId } = await startTurn({ stateFile, prompt: [brief, skill].join("\n\n") }, connection);
    return { threadId, turnId, stateFile };
  } finally { client.close(); }
}

/** Run a read-only managed turn and save the actual final answer. Acceptance is a separate coordinator action. */
export async function runManagedReviewer(input, openClient = managedReviewClient) {
  const { REVIEW_ROLES, nativeReviewResult } = await import("./review-receipts.mjs");
  const critic = input.role === "visual-qa-critic";
  if (!critic && !REVIEW_ROLES.includes(input.role)) throw new Error("Unknown native review role: " + input.role);
  if (critic !== Boolean(input.agentDefinition)) throw new Error("Only visual-qa-critic runs require --agent-definition <repo-agent-file>");
  const { runTurn, parseGenericCallback, EVENT_PREFIX } =
    await import("../../../skills/cl-sweep/scripts/native-app-server-orchestrator.mjs");
  const worktree = realpathSync(input.worktree);
  const orchDir = realpathSync(resolveWorkDir(input.orchDir).dir);
  if (orchDir === worktree || orchDir.startsWith(worktree + path.sep)) throw new Error("Reviewer evidence belongs outside the source worktree");
  if (Object.hasOwn(readHelpers(orchDir), input.helper)) throw new Error("Choose a fresh reviewer helper name");
  const capabilities = readHelperInput(input.capabilities);
  const reads = evidenceArray(capabilities);
  const binding = sessionBinding(worktree);
  const aliases = graphAliases(reads);
  if (reads.some(capability => capability.access !== "read")) throw new Error("Reviewers require read-only capabilities");
  const brief = readHelperInput(resolveHelperBrief(orchDir, input.brief));
  const criteria = boundReviewContext(brief.text, worktree, orchDir);
  const definitionPath = critic ? realpathSync(path.resolve(worktree, input.agentDefinition))
    : fileURLToPath(new URL(`../../../agents/${input.role}.md`, import.meta.url));
  if (critic && !definitionPath.startsWith(worktree + path.sep)) throw new Error("The critic definition must belong to the source repository");
  if (realpathSync(definitionPath) !== definitionPath) throw new Error("Canonical reviewer definition must be inside its owning plugin");
  const definition = readHelperInput(definitionPath);
  if (critic && agentFrontmatterName(definition.text) !== input.role) throw new Error("Canonical repository agent definition does not name visual-qa-critic");
  const directory = mkdtempSync(path.join(orchDir, "codex-review-"));
  const stateFile = path.join(directory, "session.json");
  const report = path.join(directory, "report.json");
  const deliverable = path.join(directory, "final.txt");
  const client = await openClient();
  let helper;
  let activeTurn;
  try {
    const { threadId, connection } = await startReadOnlyThread({ stateFile, worktree, helper: input.helper, model: input.model }, client);
    const kind = critic ? "critic" : input.role === "vibe-verify-worker" ? "verifier" : "reviewer";
    helperAction(orchDir, "start", input.helper, "--kind", kind,
      "--runtime", "codex", "--role", input.role, "--agent-definition", definitionPath, "--worker-id", threadId,
      "--worktree", worktree, "--brief", input.brief, "--capabilities", capabilities.fingerprint.path);
    const registered = readHelpers(orchDir)[input.helper];
    if (registered?.workerId !== threadId) throw new Error("Managed reviewer registration changed after start");
    helper = registered;
    if (critic && helper.source.diffSha256 !== createHash("sha256").digest("hex")) throw new Error("Commit the visual QA source before running a head-bound critic");
    if (!isDeepStrictEqual(helper.agentDefinition, definition.fingerprint) || !isDeepStrictEqual(helper.capabilities, capabilities.fingerprint) ||
        !isDeepStrictEqual(helper.briefEvidence, brief.fingerprint) || !isDeepStrictEqual(helper.reviewCriteria, criteria)) throw new Error("Reviewer inputs changed before registration");
    const instruction = [
      "You are a read-only reviewer. Follow the canonical agent definition at " + definitionPath + ". Resolve its relative paths from that file.",
      assembleProviderText(definition.text, binding), brief.text, reviewDoctrine,
      reads.length ? "Use only these MCP reads: " + reads.map(read => read.name).join(", ") : "Do not call MCP tools.",
      aliases.length ? "First call a relevant graph read from " + aliases.join(", ") + ". Stop immediately on approval refusal." : "",
      "Return your final answer as one JSON object with runtime, role, workerId, source, completion, observedToolCalls and findings, then the exact FINAL line.",
      critic ? "Return the supplied head and a findings array. Each finding needs boolean touchedSurface. Include a disposition only for an actual fixing commit or follow-up ticket. Preserve unresolved findings for the writer." : "",
      "Use the identity and FINAL line supplied in the follow-up message for this turn. Verify and cite every finding's material premises. Make no changes.",
    ].filter(Boolean).join("\n\n");
    const finished = await runTurn({ stateFile, prompt: instruction, deliver: false, timeoutMs: 30 * 60 * 1000 }, {
      ...connection,
      afterRemoteTurnStart: async ({ turn }) => {
        activeTurn = { threadId, turnId: turn.id };
        const completion = { sessionId: threadId, turnId: turn.id, status: "completed" };
        const fields = { runtime: "codex", role: input.role, workerId: threadId, source: helper.source, completion,
          ...(critic ? { head: helper.source.head } : {}) };
        const result = await client.request("turn/steer", { threadId, expectedTurnId: turn.id,
          input: [{ type: "text", text: "Use these fields: " + JSON.stringify(fields) + "\nLast line: " + finalMarker(helper, completion) }] });
        if (result.turnId !== turn.id) throw new Error("App Server steered another review turn");
      },
      parseEvent(message, context) {
        activeTurn = undefined;
        // The child's delivered bytes are the evidence. The managed session's separate lifecycle event contains no findings.
        writeFileSync(deliverable, message, { flag: "wx", mode: 0o600 });
        return parseGenericCallback(EVENT_PREFIX + JSON.stringify({ event_id: randomUUID(), kind: "review",
          status: "completed", terminal: true, payload: {} }), context);
      },
    });
    const observed = await readCodexReviewTurn(threadId, finished.turnId, client);
    const setupProblem = codexGraphSetupProblem(observed, aliases);
    if (setupProblem) throw new Error(setupProblem);
    if (aliases.length && !observed.toolCalls.some(name => aliases.includes(name))) throw new Error("Recorded graph capability has no observed tool call");
    let findings;
    if (critic) {
      const completion = { sessionId: threadId, turnId: finished.turnId, status: "completed" };
      const result = nativeReviewResult(finalBodyLines(readFileSync(deliverable, "utf8"), helper, completion), helper, completion);
      if (result.head !== helper.source.head || !isDeepStrictEqual(result.source, helper.source) ||
          result.role !== input.role || result.runtime !== "codex" || result.workerId !== threadId ||
          !isDeepStrictEqual(result.completion, completion)) throw new Error("Critic findings differ from the registered head or completed turn");
      if (!Array.isArray(result.findings) || result.findings.some(finding => typeof finding?.touchedSurface !== "boolean")) {
        throw new Error("Critic findings must be a list with a boolean touchedSurface on each entry");
      }
      if (result.findings.length) {
        const problems = findingProblems(result.findings);
        if (problems.length) throw new Error("Critic findings need actionable evidence: " + problems.join("; "));
      }
      findings = { head: result.head, findings: result.findings, ...(result.questions ? { questions: result.questions } : {}) };
    }
    helperAction(orchDir, "final", input.helper, "--deliverable", deliverable, "--session-id", threadId,
      "--turn-id", finished.turnId, "--out", report);
    if (critic) {
      const visualQa = path.join(directory, "findings.json");
      writeFileSync(visualQa, JSON.stringify(findings) + "\n", { flag: "wx", mode: 0o600 });
      return { threadId, visualQa };
    }
    return { threadId, report, deliverable };
  } catch (error) {
    const cleanup = [];
    if (activeTurn) {
      try { await client.request("turn/interrupt", activeTurn); }
      catch (failure) { cleanup.push("interrupt: " + failure.message); }
    }
    if (helper) {
      try { helperAction(orchDir, "abandoned", input.helper, "--if-registration", registrationFingerprint(helper), "--reason", "Managed review did not finalize"); }
      catch (failure) { cleanup.push("abandon: " + failure.message); }
    }
    if (cleanup.length) throw new Error(error.message + "; cleanup: " + cleanup.join("; "), { cause: error });
    throw error;
  } finally { client.close(); }
}

/** Record the coordinator's acceptance and capture the native receipt using its registered report. */
export async function acceptManagedReviewer(input, runtimeRead = readCodexReviewTurn) {
  const { captureNativeReviewReceipt, REVIEW_ROLES } = await import("./review-receipts.mjs");
  const orchDir = realpathSync(resolveWorkDir(input.orchDir).dir);
  const helper = readHelpers(orchDir)[input.helper];
  const report = realpathSync(input.report);
  const directory = path.dirname(report);
  if (!helper?.finalizedAt || helper.abandonedAt || helper.loadedSkill?.runtime !== "codex" ||
      !REVIEW_ROLES.includes(helper.role) || helper.finalReportPath !== report ||
      path.dirname(directory) !== orchDir || !path.basename(directory).startsWith("codex-review-") || path.basename(report) !== "report.json") {
    throw new Error("Use the finalized report returned by this managed reviewer");
  }
  if (!helper.acceptedAt) helperAction(orchDir, "accepted", input.helper, "--report", report);
  const receipt = path.join(directory, "receipt.json");
  await captureNativeReviewReceipt({ worktree: helper.worktree, orchDir, helperName: helper.name, outFile: receipt, role: helper.role }, runtimeRead);
  return { threadId: helper.workerId, receipt };
}
