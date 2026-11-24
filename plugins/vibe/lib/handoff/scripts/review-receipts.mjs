#!/usr/bin/env node
// Capture source-bound review receipts from the owned Claude launcher or a
// managed Codex App Server thread plus its helper-owned FINAL artifact.
import { capturedJson } from "../../vibe/scripts/captured-json.mjs";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { EVENT_PREFIX, parseGenericCallback } from "../../../skills/cl-sweep/scripts/native-app-server-orchestrator.mjs";
import { evidenceArray, evidenceObject, readEvidence } from "./handoff-evidence.mjs";
import { sourceIdentity, validSourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { premiseProblems } from "./review-premises.mjs";
import { acquireLedgerLock, read as readHelpers, write as writeHelpers, verifiedFinalReport } from "../../fleet-orchestrator/scripts/helpers.mjs";
import { writeAtomic } from "../../vibe/scripts/owned-state.mjs";
import { graphAliases } from "./mcp-tool-names.mjs";
import { codexGraphSetupProblem, readCodexReviewTurn } from "./codex-review-runtime.mjs";
import { exitOnProviderBroken } from "../../vibe/scripts/provider.mjs";
import { isEntryPoint } from "../../../shared/plugin-roots.mjs";

export const REVIEW_ROLES = Object.freeze([
  "vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker",
]);

function findingShapeProblems(findings, worktree) {
  if (!Array.isArray(findings)) return ["structured findings are missing; [] is required when none were found"];
  return findings.flatMap((finding, index) => {
    if (typeof finding?.id !== "string" || !finding.id.trim() || typeof finding.blocking !== "boolean"
      || typeof finding.evidence !== "string" || !finding.evidence.trim()) return [`finding ${index + 1} needs id, blocking and evidence`];
    if (!finding.blocking) return []; // Advisory context can cite observations beyond the blocking premise forms.
    const problems = premiseProblems(finding, worktree);
    const browser = finding.browserCase;
    if (browser && (browser.status !== "reproduced" || typeof browser.name !== "string" || !browser.name.trim()
      || !finding.premises?.some((premise) => premise.evidence?.kind === "command"
        && JSON.stringify(premise.evidence).includes(browser.name)))) {
      problems.push(`${finding.id}: a browser case needs its reproducing runtime result before it can block`);
    }
    return problems;
  });
}

/**
 * Tool calls, final session identity and the model the CLI ran, from a launcher-owned stream trace. The model is
 * what every CLI init record and every assistant message name; it is null unless they all name one model.
 */
export function reviewTraceFacts(traceText) {
  const events = traceText.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const toolCalls = events.flatMap(event => event?.message?.content ?? [])
    .filter(block => block?.type === "tool_use" && typeof block.name === "string")
    .map(block => block.name);
  const final = events.findLast(event => event?.type === "result");
  return { toolCalls, sessionId: final?.session_id ?? null, model: traceModel(events) };
}

/** Tool names from the granted graph capability that the launched worker actually used. */
export function graphCalls(result, trace) {
  if (!Array.isArray(result.graphToolAliases) || !result.graphToolAliases.every(name => typeof name === "string")) {
    throw new Error("launcher graph capability aliases are missing");
  }
  return trace.toolCalls.filter(name => result.graphToolAliases.includes(name));
}

/** Capture one mandatory reviewer's actual launcher result and graph trace. */
export function captureReviewReceipt({ worktree, resultFile, outFile, role, takeover: expected }) {
  if (!REVIEW_ROLES.includes(role)) throw new Error(`unknown review role ${role}`);
  const resultEvidence = readEvidence(resultFile);
  const result = evidenceObject(resultEvidence);
  if (result.runtime !== "claude" || result.agentName !== role || result.status !== "DONE" || !result.sessionId || !result.requestId || !result.tracePath) {
    throw new Error(`${role}: launcher result needs matching role, DONE and completion identity`);
  }
  const current = sourceIdentity(worktree);
  if (!validSourceIdentity(result.source) || result.source.treeSha256 !== current.treeSha256) {
    throw new Error(`${role}: launcher source differs from captured worktree`);
  }
  if (result.worktree !== realpathSync(worktree)) throw new Error(`${role}: launcher worktree differs from captured worktree`);
  const takeover = takeoverBinding(role, result, worktree, current, expected);
  const trace = readEvidence(result.tracePath);
  const facts = reviewTraceFacts(trace.text);
  if (facts.sessionId !== result.sessionId) throw new Error(`${role}: trace completion identity differs from launcher result`);
  const usedGraphCalls = graphCalls(result, facts);
  if (result.graphToolAliases.length > 0 && usedGraphCalls.length === 0) throw new Error(`${role}: graph capability was available but no graph call appears in trace`);
  const shape = findingShapeProblems(result.data?.findings, worktree);
  if (shape.length) throw new Error(`${role}: ${shape.join("; ")}`);
  const source = result.source;
  const receipt = { role, runtime: result.runtime, worktree: realpathSync(worktree), source, result: resultEvidence.fingerprint, trace: trace.fingerprint, sessionId: result.sessionId,
    requestId: result.requestId, graphStatus: result.graphToolAliases.length === 0 ? "unavailable" : "used",
    graphCalls: usedGraphCalls, findings: result.data.findings, model: facts.model, ...(takeover ? { takeover } : {}) };
  writeFileSync(outFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

/** Native reviewers can include the managed completion event immediately before the helper FINAL. */
function nativeReviewResult(bodyLines, helper, completion) {
  const lines = [...bodyLines];
  if (lines.at(-1)?.startsWith(EVENT_PREFIX)) {
    try {
      const event = parseGenericCallback(lines.pop(), {
        session: { sessionId: completion.sessionId, threadId: helper.workerId, cwd: helper.worktree }, turnId: completion.turnId,
      });
      if (!event.terminal || event.status !== "completed") throw new Error();
    } catch { throw new Error("Invalid native FINAL completion event"); }
  }
  let result;
  const body = lines.join("\n").replace(/^\uFEFF/, "");
  try { result = capturedJson(body); } catch { /* Report invalid framing at the receipt boundary. */ }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Native FINAL requires one JSON review object before its completion markers");
  return result;
}

/** Capture a Codex-native helper's private FINAL artifact through its owning helper ledger. */
export async function captureNativeReviewReceipt({ worktree, orchDir, helperName, outFile, role }, runtimeRead = readCodexReviewTurn) {
  if (!REVIEW_ROLES.includes(role)) throw new Error(`unknown review role ${role}`);
  const helper = readHelpers(orchDir)[helperName];
  if (!helper?.acceptedAt || helper.name !== helperName || helper.role !== role || helper.workerId === undefined) throw new Error(`${role}: native helper has no accepted owner and canonical role`);
  if (helper.loadedSkill?.runtime !== "codex" || realpathSync(worktree) !== realpathSync(helper.worktree)) throw new Error(`${role}: native helper belongs to another worktree or runtime`);
  const evidence = verifiedFinalReport(helper, helper.report?.path);
  const { report } = evidence;
  const result = nativeReviewResult(evidence.lines, helper, report.completion);
  if (result.runtime !== "codex" || result.role !== role || result.workerId !== helper.workerId
    || result.completion?.status !== "completed" || result.completion?.sessionId !== report.completion.sessionId
    || result.completion?.turnId !== report.completion.turnId || !validSourceIdentity(result.source)
    || result.source.treeSha256 !== report.source.treeSha256) throw new Error(`${role}: native FINAL identity or source differs from its owner`);
  const shape = findingShapeProblems(result.findings, worktree);
  if (shape.length) throw new Error(`${role}: ${shape.join("; ")}`);
  if (!Array.isArray(result.observedToolCalls) || result.observedToolCalls.some(name => typeof name !== "string")) throw new Error(`${role}: native observed tool calls are missing`);
  if (helper.workerId !== report.completion.sessionId) throw new Error(`${role}: native owner is not the managed App Server thread`);
  const runtime = await runtimeRead(helper.workerId, report.completion.turnId);
  if (!runtime.cwd || realpathSync(runtime.cwd) !== realpathSync(helper.worktree)) throw new Error(`${role}: observed native turn belongs to another worktree`);
  if (runtime.sessionId !== helper.workerId || runtime.turnId !== report.completion.turnId || runtime.status !== "completed"
    || !Array.isArray(runtime.toolCalls) || runtime.toolCalls.some(name => typeof name !== "string")) {
    throw new Error(`${role}: managed App Server turn did not finish with readable tool items`);
  }
  const aliases = graphAliases(evidenceArray(evidence.capabilities));
  const setupProblem = codexGraphSetupProblem(runtime, aliases);
  if (setupProblem) throw new Error(`${role}: ${setupProblem}`);
  const usedGraphCalls = runtime.toolCalls.filter(name => aliases.includes(name));
  if (aliases.length > 0 && usedGraphCalls.length === 0) throw new Error(`${role}: recorded graph capability has no observed tool call`);
  const receipt = { kind: "native-final", role, runtime: "codex", workerId: helper.workerId,
    helperName, orchDir: realpathSync(orchDir), worktree: realpathSync(worktree), source: report.source,
    result: evidence.record.fingerprint, trace: evidence.deliverable.fingerprint,
    capabilities: evidence.capabilities.fingerprint, sessionId: report.completion.sessionId,
    requestId: report.completion.turnId, graphStatus: aliases.length === 0 ? "unavailable" : "used",
    graphCalls: usedGraphCalls, findings: result.findings };
  const unlock = await acquireLedgerLock(orchDir);
  try {
    const ledger = readHelpers(orchDir);
    const current = ledger[helperName];
    if (current?.abandonedAt || current?.acceptedAt !== helper.acceptedAt ||
        current?.workerId !== helper.workerId || !isDeepStrictEqual(current.report, helper.report)) {
      throw new Error(`${role}: accepted helper changed before native evidence publication`);
    }
    const runtimeFile = `${outFile}.runtime.json`;
    if (current.runtimeEvidence && current.runtimeEvidence.path !== path.join(realpathSync(path.dirname(runtimeFile)), path.basename(runtimeFile))) {
      throw new Error(`${role}: native runtime evidence already belongs to another receipt`);
    }
    const runtimeEvidence = publishObject(runtimeFile, runtime, current.runtimeEvidence);
    const complete = { ...receipt, runtimeEvidence };
    publishObject(outFile, complete);
    if (!current.runtimeEvidence) {
      current.runtimeEvidence = runtimeEvidence;
      writeHelpers(orchDir, ledger);
    }
    return complete;
  } finally { unlock(); }
}

/** A retry may finish interrupted publication only with the identical saved object. */
function publishObject(file, value, expected) {
  if (!existsSync(file)) writeAtomic(file, value, { exclusive: true });
  const evidence = readEvidence(file);
  if (!isDeepStrictEqual(evidenceObject(evidence), value) || (expected && !isDeepStrictEqual(expected, evidence.fingerprint))) {
    throw new Error(`${file}: existing native evidence differs`);
  }
  return evidence.fingerprint;
}

/** Verify every mandatory role and collect its actual findings on the current source. */
export function reviewReceiptProblems(receipts, source, { reusableRoles = new Set(), worktree } = {}) {
  if (!Array.isArray(receipts)) return { problems: ["review receipts must be a list"], findings: [] };
  const problems = receipts.some((receipt) => !REVIEW_ROLES.includes(receipt?.role)) ? ["review receipts include an unvalidated role"] : [];
  const findings = [];
  for (const role of REVIEW_ROLES) {
    const matched = receipts.filter(receipt => receipt?.role === role);
    if (matched.length !== 1) { problems.push(`${role}: need exactly one current launcher receipt`); continue; }
    const receipt = matched[0];
    if (worktree && receipt.worktree !== realpathSync(worktree)) { problems.push(`${role}: receipt belongs to another worktree`); continue; }
    if (!validSourceIdentity(receipt.source)
      || (receipt.source.treeSha256 !== source.treeSha256 && !reusableRoles.has(role))) problems.push(`${role}: review source differs from current source`);
    if (receipt.kind === "native-final") {
      try {
        const helper = readHelpers(receipt.orchDir)[receipt.helperName];
        const evidence = verifiedFinalReport(helper, helper.report?.path);
        const equals = (left, right) => left?.path === right?.path && left?.sha256 === right?.sha256;
        if (helper.role !== role || helper.workerId !== receipt.workerId || !helper.acceptedAt || helper.loadedSkill?.runtime !== "codex" ||
            receipt.worktree !== realpathSync(helper.worktree) || receipt.runtime !== "codex" ||
            !equals(evidence.record.fingerprint, receipt.result) || !equals(evidence.deliverable.fingerprint, receipt.trace) ||
            !equals(evidence.capabilities.fingerprint, receipt.capabilities) ||
            !helper.runtimeEvidence || !equals(helper.runtimeEvidence, receipt.runtimeEvidence)) throw new Error("native FINAL owner or evidence changed");
        const result = nativeReviewResult(evidence.lines, helper, evidence.report.completion);
        const runtime = evidenceObject(readEvidence(helper.runtimeEvidence.path, helper.runtimeEvidence));
        if (!runtime.cwd || realpathSync(runtime.cwd) !== realpathSync(helper.worktree)) throw new Error("native runtime worktree differs");
        const aliases = graphAliases(evidenceArray(evidence.capabilities));
        if (result.runtime !== "codex" || result.role !== role || result.workerId !== helper.workerId
          || result.completion?.status !== "completed" || result.completion?.sessionId !== receipt.sessionId
          || result.completion?.turnId !== receipt.requestId || result.source?.treeSha256 !== receipt.source.treeSha256
          || findingShapeProblems(result.findings, receipt.worktree).length
          || JSON.stringify(result.findings) !== JSON.stringify(receipt.findings)
          || runtime.sessionId !== helper.workerId || runtime.turnId !== receipt.requestId || runtime.status !== "completed"
          || !Array.isArray(runtime.toolCalls)
          || (aliases.length > 0 && !runtime.toolCalls.some(name => aliases.includes(name)))) problems.push(`${role}: native FINAL content or capability evidence differs`);
      } catch (error) { problems.push(`${role}: native FINAL evidence cannot be read: ${error.message}`); }
      for (const finding of Array.isArray(receipt.findings) ? receipt.findings : []) findings.push({ ...finding, role });
      continue;
    }
    if (receipt.runtime !== "claude") {
      problems.push(`${role}: Codex review requires an accepted native FINAL receipt`);
      continue;
    }
    try {
      const result = evidenceObject(readEvidence(receipt.result.path, receipt.result));
      const trace = reviewTraceFacts(readEvidence(receipt.trace.path, receipt.trace).text);
      if (result.worktree !== receipt.worktree) problems.push(`${role}: launcher worktree differs from receipt`);
      if (result.runtime !== receipt.runtime || result.agentName !== role || result.status !== "DONE" || result.source?.treeSha256 !== receipt.source?.treeSha256 || result.sessionId !== receipt.sessionId
        || result.requestId !== receipt.requestId || trace.sessionId !== receipt.sessionId) problems.push(`${role}: completion identity differs`);
      if (receipt.model !== undefined && receipt.model !== trace.model) problems.push(`${role}: recorded model differs from its trace`);
      const usedGraphCalls = graphCalls(result, trace);
      if (result.graphToolAliases.length > 0 && usedGraphCalls.length === 0) problems.push(`${role}: graph calls missing`);
      if (findingShapeProblems(result.data?.findings, receipt.worktree).length || JSON.stringify(result.data.findings) !== JSON.stringify(receipt.findings)) problems.push(`${role}: findings differ from launcher output or are malformed`);
    } catch (error) {
      const detail = error.message.startsWith("Evidence changed:") ? "launcher output or trace changed" : "launcher evidence could not be read";
      problems.push(`${role}: ${detail}: ${error.message}`);
    }
    for (const finding of Array.isArray(receipt.findings) ? receipt.findings : []) findings.push({ ...finding, role });
  }
  return { problems, findings };
}

/**
 * The model a Claude launcher receipt proves, re-read from its fingerprinted trace; null for a Codex receipt, a
 * receipt with no recorded model, a changed trace, or a recorded model the trace does not show.
 */
export function verifiedReviewModel(receipt) {
  if (receipt?.runtime !== "claude" || receipt.kind === "native-final" || typeof receipt.model !== "string") return null;
  try {
    const { model } = reviewTraceFacts(readEvidence(receipt.trace.path, receipt.trace).text);
    return model === receipt.model ? model : null;
  } catch { return null; }
}

function traceModel(events) {
  const inits = events.filter(event => event?.type === "system" && event.subtype === "init").map(event => event.model);
  const assistants = events.filter(event => event?.type === "assistant").map(event => event.message?.model);
  const models = new Set([...inits, ...assistants]);
  if (inits.length === 0 || assistants.length === 0 || models.size !== 1) return null;
  const [model] = models;
  return typeof model === "string" && model ? model : null;
}

/**
 * A PR takeover review runs with no vibe session; the launcher binds it to the PR URL, head commit and takeover
 * worktree, and the receipt keeps that binding only while the reviewed source is still that head.
 */
function takeoverBinding(role, result, worktree, current, expected) {
  const bound = result.takeover;
  if (bound === undefined) {
    if (expected) throw new Error(`${role}: launcher result has no takeover binding for ${expected.prUrl}`);
    return undefined;
  }
  if (typeof bound?.prUrl !== "string" || !/^[0-9a-f]{40}$/.test(bound?.headSha ?? "") || typeof bound?.worktree !== "string"
    || realpathSync(bound.worktree) !== realpathSync(worktree) || result.source.head !== bound.headSha || current.head !== bound.headSha) {
    throw new Error(`${role}: takeover binding differs from the reviewed pull request head or worktree`);
  }
  if (expected && (expected.prUrl !== bound.prUrl || expected.headSha !== bound.headSha)) {
    throw new Error(`${role}: takeover review is bound to ${bound.prUrl} at ${bound.headSha}, not the expected pull request head`);
  }
  return { prUrl: bound.prUrl, headSha: bound.headSha, worktree: realpathSync(bound.worktree) };
}

if (isEntryPoint(import.meta.url)) {
  exitOnProviderBroken();
  const { values } = parseArgs({ options: { worktree: { type: "string" }, result: { type: "string" }, out: { type: "string" }, role: { type: "string" }, native: { type: "boolean" }, "orch-dir": { type: "string" }, helper: { type: "string" }, "pr-url": { type: "string" }, head: { type: "string" } } });
  if (!values.worktree || !values.out || !values.role || Boolean(values["pr-url"]) !== Boolean(values.head)) throw new Error("Usage: review-receipts.mjs --worktree <wt> --role <role> --out <receipt.json> (--result <launcher-output.json> [--pr-url <url> --head <sha>] | --native --orch-dir <dir> --helper <name>)");
  const takeover = values.head ? { prUrl: values["pr-url"], headSha: values.head } : undefined;
  const receipt = values.native
    ? await captureNativeReviewReceipt({ worktree: values.worktree, orchDir: values["orch-dir"], helperName: values.helper, outFile: values.out, role: values.role })
    : captureReviewReceipt({ worktree: values.worktree, resultFile: values.result, outFile: values.out, role: values.role, takeover });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
