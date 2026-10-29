#!/usr/bin/env node
// Decides whether a vibe session's handoff review is one consolidated read of
// the final diff over the precomputed guardrails findings, or the full
// reviewer fleet handoff runs today (ISS-13352, PRD-823). Changes nothing.
//
// Usage: review-scope.mjs --worktree <path> [--findings <file>] [--inventory <handoff-inventory.mjs output>]
//          [--base <sha>] [--config <json file>] [--enable]
// Prints one JSON object: { schema, mode, reasons, thresholds, diff, findings }.
// `mode` is `consolidated` or `full-fleet`; exit 0 whenever a decision was
// printed, 2 on a usage error. With no script, no file or any doubt, handoff
// keeps running its existing step 3 and step 6 reviewers: this script only
// ever narrows the review when it can say why it is safe to.
//
// The consolidated path is OFF unless `--enable` or VIBE_CONSOLIDATED_REVIEW=1
// is set: the plan (vibe-fleet-optimization-plan, WS4 R1) gates removing any
// existing reviewer on benchmark parity, which has not been measured, so the
// default keeps every reviewer.
//
// Findings contract (the guardrails gate, WS3 / D4, emits the same shape):
//   { "schema": "vibe.guardrails-findings/1", "head": "<sha>", "base": "<sha>",
//     "findings": [ { id, check, file, line (int|null), severity (high|medium|low), message, evidence } ],
//     "checks_run": ["<name>"], "checks_skipped": [ { "name": "<name>", "reason": "<text>" } ] }
// A missing file, an unreadable or invalid one, a `head` that is not the
// worktree's HEAD, or any entry in `checks_skipped` means those checks were
// NOT checked, never that they were clean: the decision is `full-fleet`.

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git } from "../../vibe/scripts/session-record.mjs";

export const FINDINGS_SCHEMA = "vibe.guardrails-findings/1";
export const REVIEW_SCOPE_SCHEMA = "vibe.review-scope/1";
export const SEVERITIES = ["high", "medium", "low"];
export const ReviewMode = { Consolidated: "consolidated", FullFleet: "full-fleet" };
export const FINDINGS_NOT_CHECKED = "findings-not-checked";

// The one place the escalation numbers live. NO human has specified them
// (WS4 R1 names "diff size, backend change or shared-component change" and no
// numbers), so they are defaults for the owner to rule on, overridable per run
// with `--config <json file>` or VIBE_REVIEW_SCOPE_MAX_FILES / _MAX_LINES.
// `sharedPrefixes` mirrors the UI roots `pr-facts.mjs` already treats as
// shared packages (the shared app package and the design system).
export const REVIEW_SCOPE_DEFAULTS = Object.freeze({
  maxFiles: 15,
  maxChangedLines: 400,
  escalateOnBackend: true,
  escalateOnSharedComponent: true,
  sharedPrefixes: Object.freeze(["packages/app/", "packages/design-system/"]),
});

/** Defaults, then a config file's keys, then the environment's numbers. */
export function resolveThresholds({ config = {}, env = process.env } = {}) {
  const merged = { ...REVIEW_SCOPE_DEFAULTS, ...config };
  for (const [key, name] of [["maxFiles", "VIBE_REVIEW_SCOPE_MAX_FILES"], ["maxChangedLines", "VIBE_REVIEW_SCOPE_MAX_LINES"]]) {
    const value = Number(env[name]);
    if (env[name] !== undefined && env[name] !== "" && Number.isInteger(value) && value >= 0) merged[key] = value;
  }
  return merged;
}

/** Whether the findings file's content is usable; anything else is "not checked". */
export function validateFindings(value, { head } = {}) {
  const problem = (reason) => ({ status: "not-checked", reason, findings: [], checksRun: [], checksSkipped: [] });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return problem("not a JSON object");
  if (value.schema !== FINDINGS_SCHEMA) return problem(`schema is not ${FINDINGS_SCHEMA}`);
  if (typeof value.head !== "string" || !value.head || typeof value.base !== "string" || !value.base) return problem("head and base are required");
  if (!Array.isArray(value.findings) || !Array.isArray(value.checks_run) || !Array.isArray(value.checks_skipped)) {
    return problem("findings, checks_run and checks_skipped must be arrays");
  }
  if (!value.checks_run.every((name) => typeof name === "string" && name)) return problem("checks_run entries must be names");
  const skipped = value.checks_skipped.map((entry) => ({ name: entry?.name, reason: entry?.reason }));
  if (!skipped.every((entry) => typeof entry.name === "string" && entry.name && typeof entry.reason === "string")) {
    return problem("checks_skipped entries need a name and a reason");
  }
  const bad = value.findings.findIndex((finding) => !validFinding(finding));
  if (bad !== -1) return problem(`findings[${bad}] does not match the contract`);
  if (head && value.head !== head) return problem(`findings are for ${value.head.slice(0, 12)}, not HEAD ${head.slice(0, 12)}`);
  const result = { status: "valid", reason: null, findings: value.findings, checksRun: value.checks_run, checksSkipped: skipped };
  return skipped.length > 0
    ? { ...result, status: "not-checked", reason: `checks skipped: ${skipped.map((entry) => entry.name).join(", ")}` }
    : result;
}

function validFinding(finding) {
  if (finding === null || typeof finding !== "object") return false;
  const text = ["id", "check", "file", "message", "evidence"].every((key) => typeof finding[key] === "string");
  const line = finding.line === null || Number.isInteger(finding.line);
  return text && line && SEVERITIES.includes(finding.severity);
}

/** Reads and validates the findings file; a missing or unparseable one is "not checked". */
export function loadFindings(file, { head } = {}) {
  if (!file) return { status: "not-checked", reason: "no findings file given", findings: [], checksRun: [], checksSkipped: [] };
  if (!existsSync(file)) return { status: "not-checked", reason: "findings file missing", findings: [], checksRun: [], checksSkipped: [] };
  try {
    return validateFindings(JSON.parse(readFileSync(file, "utf8")), { head });
  } catch (error) {
    return { status: "not-checked", reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`, findings: [], checksRun: [], checksSkipped: [] };
  }
}

/** The review mode and every reason for it. `diff.backendChanged` is null when unknown, which escalates. */
export function decideReview({ enabled, thresholds, diff, findings }) {
  const reasons = [];
  if (!enabled) reasons.push("consolidated-review-disabled");
  if (findings.status !== "valid") reasons.push(`${FINDINGS_NOT_CHECKED}: ${findings.reason}`);
  if (thresholds.escalateOnBackend && diff.backendChanged !== false) {
    reasons.push(diff.backendChanged === null ? "backend-change-unknown (no inventory given)" : "backend-change");
  }
  if (thresholds.escalateOnSharedComponent && diff.sharedFiles.length > 0) reasons.push("shared-component-change");
  if (diff.files > thresholds.maxFiles) reasons.push(`diff-files ${diff.files} > ${thresholds.maxFiles}`);
  if (diff.changedLines > thresholds.maxChangedLines) reasons.push(`diff-lines ${diff.changedLines} > ${thresholds.maxChangedLines}`);
  return { mode: reasons.length === 0 ? ReviewMode.Consolidated : ReviewMode.FullFleet, reasons };
}

/** Files, changed lines and shared-package files of `<base>...HEAD` plus uncommitted work; binary files count as one line. */
export function measureDiff(worktree, base, sharedPrefixes) {
  const numstat = [git(worktree, ["diff", "--numstat", base]), ...untracked(worktree)].filter(Boolean).join("\n");
  let changedLines = 0;
  const files = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed, ...rest] = line.split("\t");
    files.push(rest.join("\t"));
    changedLines += (Number.parseInt(added, 10) || 0) + (Number.parseInt(removed, 10) || 0) || (added === "-" ? 1 : 0);
  }
  const paths = files.filter((file) => !file.startsWith(".closedloop-ai/vibe-plans/"));
  return { files: paths.length, changedLines, sharedFiles: paths.filter((file) => sharedPrefixes.some((prefix) => file.startsWith(prefix))) };
}

function untracked(worktree) {
  return git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).map((file) => `1\t0\t${file}`);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, findings: { type: "string" }, inventory: { type: "string" }, base: { type: "string" },
    config: { type: "string" }, enable: { type: "boolean" },
  } });
  if (!values.worktree) throw new Error("--worktree is required");
  const thresholds = resolveThresholds({ config: values.config ? JSON.parse(readFileSync(values.config, "utf8")) : {} });
  const head = git(values.worktree, ["rev-parse", "HEAD"]);
  const base = values.base ?? git(values.worktree, ["merge-base", "HEAD", "origin/main"]);
  const diff = { ...measureDiff(values.worktree, base, thresholds.sharedPrefixes), backendChanged: null };
  if (values.inventory && existsSync(values.inventory)) {
    const inventory = JSON.parse(readFileSync(values.inventory, "utf8"));
    diff.backendChanged = typeof inventory.backendChanged === "boolean" ? inventory.backendChanged : null;
  }
  const findings = loadFindings(values.findings, { head });
  const enabled = Boolean(values.enable) || process.env.VIBE_CONSOLIDATED_REVIEW === "1";
  const decision = decideReview({ enabled, thresholds, diff, findings });
  process.stdout.write(`${JSON.stringify({ schema: REVIEW_SCOPE_SCHEMA, ...decision, thresholds, diff, findings: {
    status: findings.status, reason: findings.reason, count: findings.findings.length, checksRun: findings.checksRun, checksSkipped: findings.checksSkipped,
  } }, null, 2)}\n`);
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
