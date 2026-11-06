#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EXPECTED_MAPPINGS = [
  { caseId: "pm-prd-children-are-scope", graderName: "claims-untouched",
    checker: "iss-13760-reply-format.mjs" },
  { caseId: "pm-prd-children-are-scope", graderName: "no-supersession",
    checker: "iss-13760-reply-format.mjs" },
];

const result = (caseId, graderName, passed, reason) => ({
  caseId, graderName, passed, reason,
});

const CONTRACTIONS = new Map([
  ["can't", "can not"], ["won't", "will not"], ["shan't", "shall not"],
  ["don't", "do not"], ["doesn't", "does not"], ["didn't", "did not"],
  ["shouldn't", "should not"], ["mustn't", "must not"],
  ["couldn't", "could not"], ["wouldn't", "would not"],
  ["isn't", "is not"], ["aren't", "are not"], ["wasn't", "was not"],
  ["weren't", "were not"], ["hasn't", "has not"], ["haven't", "have not"],
  ["hadn't", "had not"],
]);

/** Canonicalize apostrophes and common contractions before any classification. */
export function normalizeCheckerText(text) {
  return text.replaceAll(/[‘’]/g, "'").replace(/\b[a-z]+n't\b/gi,
    (value) => CONTRACTIONS.get(value.toLowerCase()) ?? value);
}

function replyBody(reply) {
  const normalized = reply.replaceAll("\r\n", "\n").trim();
  const marker = "\n\nGraph:\n";
  const first = normalized.indexOf(marker);
  return first === -1 ? normalized : normalized.slice(0, first);
}

function parseChildren(reply) {
  const lines = replyBody(reply).split("\n");
  if (lines.length !== 4 || !lines[0].startsWith("CLAIM:") ||
      !lines[1].startsWith("REPORT:") || !lines[2].startsWith("UNCOVERED:") ||
      !lines[3].startsWith("SUPERSEDE:")) return { error: "expected four disposition lines" };
  const [claim, report, uncovered, supersede] = lines;
  return { claim, report, uncovered, supersede };
}

const CURRENT_SUPERSEDE = new Set([
  "SUPERSEDE: None", "SUPERSEDE: None.",
]);

function currentClaim(line) {
  const match = /^CLAIM:\s*ISS-9001;\s*ASSIGN:\s*operator-1;\s*STATUS:\s*IN_PROGRESS;\s*LINK:\s*ISS-9000;\s*COMMENT:\s*(.+)$/i.exec(line);
  if (!match) return false;
  const comment = match[1].trim();
  return /^(?:ISS-9000 coordinates this child|ISS-9000 coordinates this claim, link, and status update|Session ISS-9000 coordinates this child|ISS-9000 is the coordinating session ticket)\.?$/i.test(comment);
}

function currentReport(line) {
  return /^REPORT:\s*ISS-9002;\s*ACTION:\s*EXCLUDE;\s*REASON:\s*ACTIVE_OTHER_OWNER\.?$/i.test(line);
}

function currentUncovered(line) {
  return /^UNCOVERED:\s*ISS-9003;\s*ACTION:\s*LEAVE_UNCOVERED\.?$/i.test(line);
}
const LEGACY_CLAIMS = new Set([
  "CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, link to ISS-9000, and add a coordinator comment.",
  "CLAIM: ISS-9001",
  "CLAIM: ISS-9001 for operator-1 under coordinating ticket ISS-9000.",
  "CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, link to ISS-9000, and comment that ISS-9000 coordinates the work.",
  "CLAIM: ISS-9001 — assign to operator-1, move to IN_PROGRESS, and link to ISS-9000.",
  "CLAIM: ISS-9001 for operator-1 under coordinator ISS-9000.",
  "CLAIM: ISS-9001 → operator-1; set IN_PROGRESS and link to ISS-9000.",
]);
const LEGACY_COMPLETE_CLAIMS = new Set([...LEGACY_CLAIMS].filter((line) =>
  line.includes("coordinator comment") || line.includes("comment that ISS-9000 coordinates")));
const LEGACY_REPORTS = new Set([
  "REPORT: ISS-9002 — overlapping work is active with another owner; leave it untouched and report it.",
  "REPORT: ISS-9002 is active with another owner; its outcome overlaps the request.",
  "REPORT: ISS-9002 overlaps the request but is active with another owner; leave it with that owner and report the overlap.",
  "REPORT: ISS-9002 — overlapping work is active under another account; leave its ownership and progress intact.",
  "REPORT: ISS-9002 — active under another owner; record the overlap and leave its ownership and status intact.",
  "REPORT: ISS-9002 — overlapping work is active under another assignee; leave it with that owner.",
  "REPORT: ISS-9002 — overlapping work is active under another owner; leave it with that owner.",
  "REPORT: ISS-9002 overlaps the request and is active under another owner; retain its owner and report the overlap.",
  "REPORT: ISS-9002 overlaps the request but is active under another owner; leave its assignment and status unchanged.",
]);
const LEGACY_UNCOVERED = new Set([
  "UNCOVERED: ISS-9003 — outside the request; leave it untouched.", "UNCOVERED: ISS-9003",
  "UNCOVERED: ISS-9003; its outcome is outside the request.",
  "UNCOVERED: ISS-9003 — untouched, but outside the requested outcome.",
  "UNCOVERED: ISS-9003 — its outcome is outside this request.",
  "UNCOVERED: ISS-9003 — untouched, but outside the requested outcome; leave it unclaimed.",
  "UNCOVERED: ISS-9003 — its outcome is outside the request; leave it untouched.",
  "UNCOVERED: ISS-9003 is outside the request; leave it untouched.",
  "UNCOVERED: ISS-9003 is a PRD-900 child outside the request; list it as uncovered.",
]);
const LEGACY_SUPERSEDE = new Set([
  "SUPERSEDE: None — no human ruling supersedes a child ticket.", "SUPERSEDE: None.",
  "SUPERSEDE: None — no cited human ruling supersedes a child ticket.",
  "SUPERSEDE: None — no human ruling supports superseding a child ticket.",
  "SUPERSEDE: None. No human supersession ruling was provided.",
  "SUPERSEDE: None; no human supersession ruling was provided.",
]);

function currentStructured(parsed) {
  if (!currentClaim(parsed.claim) || !currentUncovered(parsed.uncovered) ||
      !CURRENT_SUPERSEDE.has(parsed.supersede)) return false;
  return currentReport(parsed.report) || parsed.report ===
    "REPORT: ISS-9002 is active under another owner; exclude it from the build and report the overlap; do not build, claim, cancel, or supersede it.";
}

function legacyStructured(parsed, completeClaim) {
  return (completeClaim ? LEGACY_COMPLETE_CLAIMS : LEGACY_CLAIMS).has(parsed.claim) &&
    LEGACY_REPORTS.has(parsed.report) && LEGACY_UNCOVERED.has(parsed.uncovered) &&
    LEGACY_SUPERSEDE.has(parsed.supersede);
}

function prdChildren(caseId, graderName, reply) {
  if (graderName === "no-supersession" && /^(?:SUPERSEDE:\s*)?None\.?$/i.test(reply.trim())) {
    return result(caseId, graderName, true, "no affirmative supersession is present");
  }
  const parsed = parseChildren(reply);
  if (parsed.error) return result(caseId, graderName, false, parsed.error);
  if (graderName === "claims-untouched") {
    if (!currentStructured(parsed) && !legacyStructured(parsed, true)) {
      return result(caseId, graderName, false, "claim mutations or child dispositions are incomplete");
    }
    return result(caseId, graderName, true, "the untouched child is claimed completely");
  }
  return result(caseId, graderName, currentStructured(parsed) || legacyStructured(parsed, false),
    "no affirmative supersession is present");
}

/** Grade the ISS-13760 case-local reply formats without interpreting arbitrary prose. */
export function gradeReply({ caseId, graderName, reply }) {
  if (typeof caseId !== "string" || typeof graderName !== "string" || typeof reply !== "string") {
    throw new Error("checker-input-invalid");
  }
  if (caseId === "pm-prd-children-are-scope" &&
      (graderName === "claims-untouched" || graderName === "no-supersession")) {
    return prdChildren(caseId, graderName, normalizeCheckerText(reply));
  }
  throw new Error("checker-mapping-invalid");
}

/** Validate the discovery manifest against the checker's one canonical mapping list. */
export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) ||
      manifest.entries.length !== EXPECTED_MAPPINGS.length) return false;
  const canonical = (entries) => entries.map((entry) => JSON.stringify(entry)).sort().join("\n");
  return canonical(manifest.entries) === canonical(EXPECTED_MAPPINGS);
}

async function main() {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw);
  if (input?.operation === "validate-manifest") {
    if (!validateManifest(input.manifest)) throw new Error("checker-manifest-invalid");
    process.stdout.write('{"valid":true}\n');
    return;
  }
  process.stdout.write(`${JSON.stringify(gradeReply(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("checker-failed\n");
    process.exitCode = 2;
  });
}
