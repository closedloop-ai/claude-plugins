#!/usr/bin/env node
// Capture source-bound review receipts from the owned Claude launcher or a
// managed Codex App Server thread plus its helper-owned FINAL artifact.
import { readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { evidenceFingerprint } from "./handoff-evidence.mjs";
import { sourceIdentity, validSourceIdentity } from "../../vibe/scripts/tested-head.mjs";
import { premiseProblems } from "./review-premises.mjs";
import { finalMarker, finalReportProblem } from "../../fleet-orchestrator/scripts/helpers.mjs";
import { graphAliases } from "./mcp-tool-names.mjs";
import { readCodexReviewTurn } from "./codex-review-runtime.mjs";

export const REVIEW_ROLES = Object.freeze([
  "vibe-guardrails-reviewer", "vibe-adversarial-reviewer", "vibe-storybook-decomposer", "vibe-verify-worker",
]);

function findingShapeProblems(findings, worktree) {
  if (!Array.isArray(findings)) return ["structured findings are missing; [] is required when none were found"];
  return findings.flatMap((finding, index) => typeof finding?.id === "string" && finding.id.trim()
    && typeof finding.blocking === "boolean" && typeof finding.evidence === "string" && finding.evidence.trim()
    ? premiseProblems(finding, worktree) : [`finding ${index + 1} needs id, blocking and evidence`]);
}

/** Tool calls and final session identity from a launcher-owned stream trace. */
export function reviewTraceFacts(traceText) {
  const events = traceText.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const toolCalls = events.flatMap(event => event?.message?.content ?? [])
    .filter(block => block?.type === "tool_use" && typeof block.name === "string")
    .map(block => block.name);
  const final = events.findLast(event => event?.type === "result");
  return { toolCalls, sessionId: final?.session_id ?? null };
}

function graphCalls(result, trace) {
  if (!Array.isArray(result.graphToolAliases) || !result.graphToolAliases.every(name => typeof name === "string")) {
    throw new Error("launcher graph capability aliases are missing");
  }
  return trace.toolCalls.filter(name => result.graphToolAliases.includes(name));
}

/** Capture one mandatory reviewer's actual launcher result and graph trace. */
export function captureReviewReceipt({ worktree, resultFile, outFile, role }) {
  if (!REVIEW_ROLES.includes(role)) throw new Error(`unknown review role ${role}`);
  const resultEvidence = evidenceFingerprint(resultFile);
  const result = JSON.parse(readFileSync(resultEvidence.path, "utf8"));
  if (result.runtime !== "claude" || result.agentName !== role || result.status !== "DONE" || !result.sessionId || !result.requestId || !result.tracePath) {
    throw new Error(`${role}: launcher result needs matching role, DONE and completion identity`);
  }
  if (!validSourceIdentity(result.source) || result.source.treeSha256 !== sourceIdentity(worktree).treeSha256) {
    throw new Error(`${role}: launcher source differs from captured worktree`);
  }
  const trace = evidenceFingerprint(result.tracePath);
  const facts = reviewTraceFacts(readFileSync(trace.path, "utf8"));
  if (facts.sessionId !== result.sessionId) throw new Error(`${role}: trace completion identity differs from launcher result`);
  const usedGraphCalls = graphCalls(result, facts);
  if (result.graphToolAliases.length > 0 && usedGraphCalls.length === 0) throw new Error(`${role}: graph capability was available but no graph call appears in trace`);
  const shape = findingShapeProblems(result.data?.findings, worktree);
  if (shape.length) throw new Error(`${role}: ${shape.join("; ")}`);
  const source = result.source;
  const receipt = { role, runtime: result.runtime, worktree: realpathSync(worktree), source, result: resultEvidence, trace, sessionId: result.sessionId,
    requestId: result.requestId, graphStatus: result.graphToolAliases.length === 0 ? "unavailable" : "used",
    graphCalls: usedGraphCalls, findings: result.data.findings };
  writeFileSync(outFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

/** Capture a Codex-native helper's private FINAL artifact through its owning helper ledger. */
export async function captureNativeReviewReceipt({ worktree, orchDir, helperName, outFile, role }, runtimeRead = readCodexReviewTurn) {
  if (!REVIEW_ROLES.includes(role)) throw new Error(`unknown review role ${role}`);
  const helper = JSON.parse(readFileSync(path.join(orchDir, "helpers.json"), "utf8"))[helperName];
  if (!helper?.acceptedAt || helper.name !== helperName || helper.role !== role || helper.workerId === undefined) throw new Error(`${role}: native helper has no accepted owner and canonical role`);
  if (JSON.stringify(evidenceFingerprint(helper.report?.path)) !== JSON.stringify(helper.report)) throw new Error(`${role}: accepted native final report changed`);
  const problem = finalReportProblem(helper, helper.report?.path);
  if (problem) throw new Error(`${role}: ${problem}`);
  const report = JSON.parse(readFileSync(helper.report.path, "utf8"));
  const deliverable = readFileSync(report.deliverable.path, "utf8");
  const marker = finalMarker(helper, report.completion);
  const body = deliverable.slice(0, deliverable.lastIndexOf(marker)).trim();
  const result = JSON.parse(body);
  if (result.runtime !== "codex" || result.role !== role || result.workerId !== helper.workerId
    || result.completion?.status !== "completed" || result.completion?.sessionId !== report.completion.sessionId
    || result.completion?.turnId !== report.completion.turnId || !validSourceIdentity(result.source)
    || result.source.treeSha256 !== report.source.treeSha256) throw new Error(`${role}: native FINAL identity or source differs from its owner`);
  const shape = findingShapeProblems(result.findings, worktree);
  if (shape.length) throw new Error(`${role}: ${shape.join("; ")}`);
  if (!Array.isArray(result.observedToolCalls) || result.observedToolCalls.some(name => typeof name !== "string")) throw new Error(`${role}: native observed tool calls are missing`);
  if (helper.workerId !== report.completion.sessionId) throw new Error(`${role}: native owner is not the managed App Server thread`);
  const runtime = await runtimeRead(helper.workerId, report.completion.turnId);
  if (runtime.sessionId !== helper.workerId || runtime.turnId !== report.completion.turnId || runtime.status !== "completed"
    || !Array.isArray(runtime.toolCalls) || runtime.toolCalls.some(name => typeof name !== "string")) {
    throw new Error(`${role}: managed App Server turn did not finish with readable tool items`);
  }
  const aliases = graphAliases(JSON.parse(readFileSync(helper.capabilities.path, "utf8")));
  const usedGraphCalls = runtime.toolCalls.filter(name => aliases.includes(name));
  if (aliases.length > 0 && usedGraphCalls.length === 0) throw new Error(`${role}: recorded graph capability has no observed tool call`);
  const runtimeFile = `${outFile}.runtime.json`;
  writeFileSync(runtimeFile, `${JSON.stringify(runtime)}\n`, { mode: 0o600, flag: "wx" });
  const receipt = { kind: "native-final", role, runtime: "codex", workerId: helper.workerId,
    helperName, orchDir: realpathSync(orchDir), worktree: realpathSync(worktree), source: report.source,
    result: evidenceFingerprint(helper.report.path), trace: evidenceFingerprint(report.deliverable.path),
    capabilities: evidenceFingerprint(helper.capabilities.path), runtimeEvidence: evidenceFingerprint(runtimeFile), sessionId: report.completion.sessionId,
    requestId: report.completion.turnId, graphStatus: aliases.length === 0 ? "unavailable" : "used",
    graphCalls: usedGraphCalls, findings: result.findings };
  writeFileSync(outFile, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return receipt;
}

/** Verify every mandatory role and collect its actual findings on the current source. */
export function reviewReceiptProblems(receipts, source) {
  if (!Array.isArray(receipts)) return { problems: ["review receipts must be a list"], findings: [] };
  const problems = [];
  const findings = [];
  for (const role of REVIEW_ROLES) {
    const matched = receipts.filter(receipt => receipt?.role === role);
    if (matched.length !== 1) { problems.push(`${role}: need exactly one current launcher receipt`); continue; }
    const receipt = matched[0];
    if (!validSourceIdentity(receipt.source) || receipt.source.treeSha256 !== source.treeSha256) problems.push(`${role}: review source differs from current source`);
    if (receipt.kind === "native-final") {
      try {
        const helper = JSON.parse(readFileSync(path.join(receipt.orchDir, "helpers.json"), "utf8"))[receipt.helperName];
        const problem = finalReportProblem(helper, receipt.result.path);
        if (problem || helper.role !== role || helper.workerId !== receipt.workerId || helper.report?.path !== receipt.result.path || !helper.acceptedAt
          || JSON.stringify(evidenceFingerprint(receipt.result.path)) !== JSON.stringify(receipt.result)
          || JSON.stringify(evidenceFingerprint(receipt.trace.path)) !== JSON.stringify(receipt.trace)
          || JSON.stringify(evidenceFingerprint(receipt.runtimeEvidence.path)) !== JSON.stringify(receipt.runtimeEvidence)
          || JSON.stringify(evidenceFingerprint(receipt.capabilities.path)) !== JSON.stringify(receipt.capabilities)) {
          problems.push(`${role}: native FINAL owner or evidence changed`);
        }
        const report = JSON.parse(readFileSync(receipt.result.path, "utf8"));
        const deliverable = readFileSync(receipt.trace.path, "utf8");
        const result = JSON.parse(deliverable.slice(0, deliverable.lastIndexOf(finalMarker(helper, report.completion))).trim());
        const runtime = JSON.parse(readFileSync(receipt.runtimeEvidence.path, "utf8"));
        const aliases = graphAliases(JSON.parse(readFileSync(helper.capabilities.path, "utf8")));
        if (result.runtime !== "codex" || result.role !== role || result.workerId !== helper.workerId
          || result.completion?.status !== "completed" || result.completion?.sessionId !== receipt.sessionId
          || result.completion?.turnId !== receipt.requestId || result.source?.treeSha256 !== receipt.source.treeSha256
          || findingShapeProblems(result.findings, receipt.worktree).length
          || JSON.stringify(result.findings) !== JSON.stringify(receipt.findings)
          || runtime.sessionId !== helper.workerId || runtime.turnId !== receipt.requestId || runtime.status !== "completed"
          || !Array.isArray(runtime.toolCalls)
          || (aliases.length > 0 && !runtime.toolCalls.some(name => aliases.includes(name)))) problems.push(`${role}: native FINAL content or capability evidence differs`);
      } catch { problems.push(`${role}: native FINAL evidence cannot be read`); }
      for (const finding of Array.isArray(receipt.findings) ? receipt.findings : []) findings.push({ ...finding, role });
      continue;
    }
    if (receipt.runtime !== "claude") {
      problems.push(`${role}: Codex review requires an accepted native FINAL receipt`);
      continue;
    }
    try {
      if (JSON.stringify(evidenceFingerprint(receipt.result.path)) !== JSON.stringify(receipt.result)
        || JSON.stringify(evidenceFingerprint(receipt.trace.path)) !== JSON.stringify(receipt.trace)) {
        problems.push(`${role}: launcher output or trace changed`);
      }
      const result = JSON.parse(readFileSync(receipt.result.path, "utf8"));
      const trace = reviewTraceFacts(readFileSync(receipt.trace.path, "utf8"));
      if (result.runtime !== receipt.runtime || result.agentName !== role || result.status !== "DONE" || result.source?.treeSha256 !== receipt.source?.treeSha256 || result.sessionId !== receipt.sessionId
        || result.requestId !== receipt.requestId || trace.sessionId !== receipt.sessionId) problems.push(`${role}: completion identity differs`);
      const usedGraphCalls = graphCalls(result, trace);
      if (result.graphToolAliases.length > 0 && usedGraphCalls.length === 0) problems.push(`${role}: graph calls missing`);
      if (findingShapeProblems(result.data?.findings, receipt.worktree).length || JSON.stringify(result.data.findings) !== JSON.stringify(receipt.findings)) problems.push(`${role}: findings differ from launcher output or are malformed`);
    } catch { problems.push(`${role}: launcher evidence could not be read`); }
    for (const finding of Array.isArray(receipt.findings) ? receipt.findings : []) findings.push({ ...finding, role });
  }
  return { problems, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, result: { type: "string" }, out: { type: "string" }, role: { type: "string" }, native: { type: "boolean" }, "orch-dir": { type: "string" }, helper: { type: "string" } } });
  if (!values.worktree || !values.out || !values.role) throw new Error("Usage: review-receipts.mjs --worktree <wt> --role <role> --out <receipt.json> (--result <launcher-output.json> | --native --orch-dir <dir> --helper <name>)");
  const receipt = values.native
    ? await captureNativeReviewReceipt({ worktree: values.worktree, orchDir: values["orch-dir"], helperName: values.helper, outFile: values.out, role: values.role })
    : captureReviewReceipt({ worktree: values.worktree, resultFile: values.result, outFile: values.out, role: values.role });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
