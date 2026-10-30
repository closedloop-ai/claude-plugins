#!/usr/bin/env node
// A provider's measured preview capabilities are verified at the environment
// worker result boundary before that worker can report DONE.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { sourceIdentity, validSourceIdentity } from "./tested-head.mjs";
import { evidenceFingerprint } from "../../handoff/scripts/handoff-evidence.mjs";

export const PREVIEW_CAPABILITIES = Object.freeze(["app-preview", "feature-flags", "collaboration"]);

/** Validate a provider-produced receipt against the exact environment request and source. */
export function previewCapabilityProblems(receipt, expected) {
  const required = expected?.required;
  if (!Array.isArray(required) || required.length === 0 || !required.includes("app-preview")
    || required.some(item => !PREVIEW_CAPABILITIES.includes(item))) {
    return ["preview requirements need app-preview and supported capability names"];
  }
  if (receipt?.schema !== 1 || receipt?.producer !== "runtime-provider" || !receipt.environmentId || !receipt.requestId
    || !validSourceIdentity(receipt.source) || !receipt.probes || typeof receipt.probes !== "object") {
    return ["provider preview receipt is missing schema, identity, source or probes"];
  }
  const problems = [];
  if (receipt.environmentId !== expected.environmentId || receipt.requestId !== expected.requestId
    || receipt.source.treeSha256 !== expected.source?.treeSha256) problems.push("provider preview receipt is stale for this environment request or source");
  for (const capability of [...new Set(required)]) {
    const probe = receipt.probes[capability];
    if (probe?.status !== "available") {
      problems.push(`preview cannot show required ${capability} behavior`);
      continue;
    }
    try {
      if (probe.producer !== "runtime-provider" || !probe.evidence?.path
        || JSON.stringify(evidenceFingerprint(probe.evidence.path)) !== JSON.stringify(probe.evidence)) {
        problems.push(`${capability}: provider probe evidence is missing or changed`);
      }
    } catch { problems.push(`${capability}: provider probe evidence cannot be read`); }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { file: { type: "string" }, worktree: { type: "string" }, "request-id": { type: "string" }, "environment-id": { type: "string" }, required: { type: "string", multiple: true } } });
  if (!values.file || !values.worktree || !values["request-id"] || !values["environment-id"]) {
    throw new Error("Usage: preview-capabilities.mjs --file <provider receipt> --worktree <wt> --request-id <id> --environment-id <id> --required <capability>...");
  }
  const problems = previewCapabilityProblems(JSON.parse(readFileSync(evidenceFingerprint(values.file).path, "utf8")), {
    source: sourceIdentity(values.worktree), environmentId: values["environment-id"], requestId: values["request-id"], required: values.required,
  });
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  if (problems.length) process.exitCode = 1;
}
