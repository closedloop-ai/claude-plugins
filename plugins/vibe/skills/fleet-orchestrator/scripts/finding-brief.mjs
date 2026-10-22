#!/usr/bin/env node
// Builds the prompt that sends QA findings to a writer, with their evidence
// where the writer can open it. A finding once went to a writer on another
// machine as prose while its QA record and screenshots stayed behind, and the
// writer stalled asking for the story and the evidence.
//
// Usage: finding-brief.mjs <orchDir> --findings <findings.json> --prompt <prompt .md> [--where local|remote]
//        finding-brief.mjs <orchDir> --findings <findings.json> --require-disposition
//
// findings.json: {"head": "<sha>", "findings": [{"id", "summary", "story" or "route",
//   "viewport", "selector" and/or "screenshots": [paths], "touchedSurface": true|false,
//   "disposition": "fixed: <sha>"|"ticket: <id>" when touched}]}
// Each finding needs a summary, a story id or route, a viewport, and a
// selector or at least one screenshot that exists; any other finding is
// refused (exit 1) and nothing is written. Screenshots are copied into
// <prompt>.evidence/, which `fleet.sh` ships beside the prompt, and the prompt
// names each one at the path the writer opens: under REMOTE_STATE_DIR's
// .fleet-orchestrator/ for `--where remote` (from <orchDir>/config.env),
// otherwise the local copy.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** What is missing from each finding, or an empty list when every finding can be acted on. */
export function findingProblems(findings, exists = existsSync) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return ["no findings"];
  }
  return findings.flatMap((finding, index) => {
    const name = finding?.id ?? `finding ${index + 1}`;
    const screenshots = Array.isArray(finding?.screenshots) ? finding.screenshots : [];
    return [
      ...(finding?.summary ? [] : [`${name}: no summary`]),
      ...(finding?.story || finding?.route ? [] : [`${name}: no story id or route`]),
      ...(finding?.viewport ? [] : [`${name}: no viewport`]),
      ...(finding?.selector || screenshots.length > 0 ? [] : [`${name}: no selector or screenshot`]),
      ...(typeof finding?.touchedSurface === "boolean" ? [] : [`${name}: touchedSurface must say true or false`]),
      ...screenshots.filter((file) => !exists(file)).map((file) => `${name}: screenshot ${file} does not exist here`),
    ];
  });
}

/** Touched-surface findings that have neither a fixing commit nor a follow-up ticket. */
export function dispositionProblems(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return ["no findings"];
  return findings.flatMap((finding, index) => {
    const name = finding?.id ?? `finding ${index + 1}`;
    if (typeof finding?.touchedSurface !== "boolean") return [`${name}: touchedSurface must say true or false`];
    if (!finding.touchedSurface) return [];
    if (/^(?:fixed:\s*[0-9a-f]{7,40}|ticket:\s*[A-Z]+-\d+)$/i.test(finding?.disposition ?? "")) return [];
    return [`${name}: a finding on a touched surface needs disposition "fixed: <sha>" or "ticket: <id>"`];
  });
}

/** The prompt text, with each screenshot at `evidenceDir` as the writer sees it. */
export function briefText(head, findings, evidenceDir) {
  const lines = [`QA findings on head ${head ?? "unknown"}. Fix each one on the branch and report the fixing commit per finding.`, ""];
  for (const [index, finding] of findings.entries()) {
    lines.push(`${finding.id ?? `F${index + 1}`}: ${finding.summary}`);
    lines.push(`- ${finding.story ? `Story: ${finding.story}` : `Route: ${finding.route}`}`, `- Viewport: ${finding.viewport}`);
    if (finding.selector) lines.push(`- Selector: ${finding.selector}`);
    for (const file of finding.screenshots ?? []) lines.push(`- Screenshot: ${path.join(evidenceDir, evidenceName(finding, index, file))}`);
    lines.push("");
  }
  return lines.join("\n");
}

function evidenceName(finding, index, file) {
  return `${finding.id ?? `F${index + 1}`}-${path.basename(file)}`;
}

function remoteDir(orchDir) {
  const config = existsSync(path.join(orchDir, "config.env")) ? readFileSync(path.join(orchDir, "config.env"), "utf8") : "";
  const value = /^REMOTE_STATE_DIR=(.*)$/m.exec(config)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!value) {
    throw new Error("--where remote needs REMOTE_STATE_DIR in config.env");
  }
  return path.join(value, ".fleet-orchestrator");
}

function main(argv) {
  const [orchDir, ...rest] = argv;
  const { values } = parseArgs({ args: rest, options: {
    findings: { type: "string" }, prompt: { type: "string" }, where: { type: "string" }, "require-disposition": { type: "boolean" },
  } });
  if (!orchDir || !values.findings || (!values.prompt && !values["require-disposition"])) {
    throw new Error("Usage: finding-brief.mjs <orchDir> --findings <findings.json> (--prompt <prompt .md> [--where local|remote] | --require-disposition)");
  }
  const { head, findings } = JSON.parse(readFileSync(values.findings, "utf8"));
  if (values["require-disposition"]) {
    const problems = dispositionProblems(findings);
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
    return problems.length === 0 ? 0 : 1;
  }
  const problems = findingProblems(findings);
  if (problems.length > 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, problems })}\n`);
    return 1;
  }
  const localEvidence = `${path.resolve(values.prompt)}.evidence`;
  const seen = values.where === "remote" ? path.join(remoteDir(orchDir), `${path.basename(values.prompt)}.evidence`) : localEvidence;
  mkdirSync(localEvidence, { recursive: true });
  for (const [index, finding] of findings.entries()) {
    for (const file of finding.screenshots ?? []) copyFileSync(file, path.join(localEvidence, evidenceName(finding, index, file)));
  }
  writeFileSync(values.prompt, briefText(head, findings, seen));
  process.stdout.write(`${JSON.stringify({ ok: true, prompt: values.prompt, evidence: localEvidence })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
