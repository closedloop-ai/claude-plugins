#!/usr/bin/env node
// Decides whether a vibe session's handoff review is one consolidated read of
// the final diff over the precomputed guardrails findings, or the full
// reviewer fleet handoff runs today. Changes nothing.
//
// Usage: review-scope.mjs --worktree <path> [--findings <file>] [--inventory <handoff-inventory.mjs output>]
//          [--base <sha>] [--config <json file>] [--manifest <triage manifest>] [--enable]
// Prints one JSON object: { schema, mode, reasons, thresholds, diff, findings, triage }.
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
import { isLocalPlanPath, sessionLocalPlanPrefix } from "../../vibe/scripts/local-plans.mjs";
import { REVIEW_EFFECTIVE, validateManifest } from "../../vibe/scripts/vibe-triage.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";
import { repositoryLayout } from "../../vibe/scripts/area-paths.mjs";

const { git } = await vibeCore("lib/vibe/scripts/session-record.mjs");
const { failScript } = await vibeCore("lib/vibe/scripts/provider.mjs");

export const FINDINGS_SCHEMA = "vibe.guardrails-findings/1";
export const REVIEW_SCOPE_SCHEMA = "vibe.review-scope/1";
export const SEVERITIES = ["high", "medium", "low"];
export const ReviewMode = { Consolidated: "consolidated", FullFleet: "full-fleet" };
export const FINDINGS_NOT_CHECKED = "findings-not-checked";
// The guardrails gate lists a check that evaluated only some files under `checks_skipped` with a
// reason starting `partial:` and keeps its findings. Those findings are real evidence: they stay in
// `findings.items` for whoever reviews next, even though the check counts as not checked.
export const PARTIAL_REASON_PREFIX = "partial:";

// The one place the escalation numbers live. NO human has specified them
// (WS4 R1 names "diff size, backend change or shared-component change" and no
// numbers), so they are defaults for the owner to rule on, overridable per run
// with `--config <json file>` or VIBE_REVIEW_SCOPE_MAX_FILES / _MAX_LINES.
// `sharedPrefixes` are the repository's shared packages, from the bound
// provider's layout recipe; none without one.
export const REVIEW_SCOPE_DEFAULTS = Object.freeze({
  maxFiles: 15,
  maxChangedLines: 400,
  escalateOnBackend: true,
  escalateOnSharedComponent: true,
  sharedPrefixes: Object.freeze([]),
});

/** Defaults, then a config file's keys, then the environment's numbers. */
export function resolveThresholds({ config = {}, env = process.env } = {}) {
  const merged = { ...REVIEW_SCOPE_DEFAULTS, ...(repositoryLayout().sharedPrefixes ? { sharedPrefixes: repositoryLayout().sharedPrefixes } : {}), ...config };
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

/** Findings under a check the gate only partly evaluated; never discarded when the file otherwise falls back to the full review. */
export function partialFindings(checked) {
  const partial = new Set(checked.checksSkipped.filter((entry) => entry.reason.startsWith(PARTIAL_REASON_PREFIX)).map((entry) => entry.name));
  return checked.findings.filter((finding) => partial.has(finding.check));
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
  const planPrefix = sessionLocalPlanPrefix(worktree);
  const paths = files.filter((file) => !isLocalPlanPath(file, planPrefix));
  return { files: paths.length, changedLines, sharedFiles: paths.filter((file) => sharedPrefixes.some((prefix) => file.startsWith(prefix))) };
}

function untracked(worktree) {
  return git(worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).map((file) => `1\t0\t${file}`);
}

export const TriageStatus = { Absent: "absent", Invalid: "invalid", Valid: "valid" };
export const ADVERSARIAL_REVIEWER = "vibe-adversarial-reviewer";
export const TRIAGE_SCOPE_ADDS_ADVERSARIAL = "consolidated-adversarial";
// Gates the handoff knows how to run; a manifest naming any other is ignored, not run.
export const TRIAGE_GATES = Object.freeze(["workflow-code-review", "logical-qa"]);

/** The triage manifest, when its file exists and passes `vibe-triage.mjs check`; anything else is "no manifest", never an error. */
export function loadTriageManifest(file) {
  if (!file) return { status: TriageStatus.Absent, reason: "no manifest file given", manifest: null };
  if (!existsSync(file)) return { status: TriageStatus.Absent, reason: "manifest file missing", manifest: null };
  try {
    return { status: TriageStatus.Valid, reason: null, manifest: validateManifest(JSON.parse(readFileSync(file, "utf8"))) };
  } catch (error) {
    return { status: TriageStatus.Invalid, reason: error instanceof Error ? error.message : String(error), manifest: null };
  }
}

/**
 * What the triage manifest adds to the diff-derived review `decision`. ITEM 2 = A (the owner's ruling, the
 * operator's instruction in this task): the manifest may ADD review work (the adversarial reviewer beside the
 * consolidated one, and its extra gates) and must NEVER remove a review review-scope.mjs already requires, so
 * `decision` is returned untouched and only `addedReviews` and `extraGates` come from the manifest. It takes
 * effect only when the manifest's own `effective` says the triage switch was on when it was classified (the
 * same semantics as the environment and desktop recommendations); with the switch off it only records what
 * would apply. A missing or invalid manifest is today's behavior.
 */
export function applyTriage({ decision, triage }) {
  const none = { addedReviews: [], extraGates: [] };
  if (triage.status !== TriageStatus.Valid) {
    return { status: triage.status, reason: triage.reason, applied: false, ...none, wouldApply: none, ignoredGates: [] };
  }
  const { steps, class: cls } = triage.manifest;
  const named = [...new Set(steps.extraGates.gates)];
  const wouldApply = {
    addedReviews: steps.review.scope === TRIAGE_SCOPE_ADDS_ADVERSARIAL && decision.mode === ReviewMode.Consolidated ? [ADVERSARIAL_REVIEWER] : [],
    extraGates: named.filter((gate) => TRIAGE_GATES.includes(gate)),
  };
  const applied = steps.review.effective === REVIEW_EFFECTIVE.Apply && steps.extraGates.effective === REVIEW_EFFECTIVE.Apply;
  return {
    status: TriageStatus.Valid, reason: null, class: cls, scope: steps.review.scope, applied,
    ...(applied ? wouldApply : none), wouldApply, ignoredGates: named.filter((gate) => !TRIAGE_GATES.includes(gate)),
  };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    worktree: { type: "string" }, findings: { type: "string" }, inventory: { type: "string" }, base: { type: "string" },
    config: { type: "string" }, manifest: { type: "string" }, enable: { type: "boolean" },
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
  const triage = applyTriage({ decision, triage: loadTriageManifest(values.manifest) });
  process.stdout.write(`${JSON.stringify({ schema: REVIEW_SCOPE_SCHEMA, ...decision, triage, thresholds, diff, findings: {
    status: findings.status, reason: findings.reason, count: findings.findings.length, checksRun: findings.checksRun, checksSkipped: findings.checksSkipped,
    partial: partialFindings(findings), items: findings.findings,
  } }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.exit(failScript(error, 2));
  }
}
