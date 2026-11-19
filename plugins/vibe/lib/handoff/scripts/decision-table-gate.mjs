import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { localPlanPaths } from "../../vibe/scripts/session-artifact-paths.mjs";

const REVIEW_SECTIONS = ["Verification Findings", "Adversarial Review", "Fixes Applied"];
const PLACEHOLDER = /^\(?(?:append-only after implementation|post-implementation|(?:pending|tbd)\b.*)\)?[.!]?$/i;
const PENDING_EVIDENCE = /^(?:\*\*)?(?:pending|tbd)\b(?:\*\*)?(?:[.:;]\s*.*)?$/i;

/** Read current sections without treating fenced examples or prior duplicate headings as evidence. */
function sections(text) {
  const result = new Map();
  let heading = "";
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (fence) continue;
    const next = /^##\s+(.+?)\s*$/.exec(line)?.[1];
    if (next) {
      heading = next;
      result.set(heading, []);
      continue;
    }
    const entries = result.get(heading) ?? [];
    entries.push(line);
    result.set(heading, entries);
  }
  return result;
}

function hasReviewEvidence(lines) {
  const separator = /^\|[\s|:-]+\|$/;
  return lines.some((line, index) => {
    const body = line.trim().replace(/^[-*]\s+(?:\[[ x]\]\s+)?/i, "");
    return body && !/^#+\s|^<!--/.test(body) && !separator.test(body)
      && !(body.startsWith("|") && separator.test(lines[index + 1]?.trim() ?? "")) && !PLACEHOLDER.test(body);
  });
}

function pendingRuling(line) {
  const fields = line.split("|").flatMap((field) => field.split(/(?:[.!?]\s+|:\s+)/));
  return fields.some((field) => {
    const text = field.trim().replace(/^[-*]\s+(?:\[[ x]\]\s+)?/i, "");
    return /^(?:pending\s+(?:ruling|decision|approval|operator)\b|(?:ruling|decision|approval)\s+pending\b)/i.test(text)
      || /^[Pp]ending\s+[A-Z][a-z]+\b/.test(text);
  });
}

/** Source-backed table content required before a build or import may advance to handoff. */
export function decisionTableProblems(worktree) {
  const expected = localPlanPaths(realpathSync(worktree)).decisionTable;
  const name = path.basename(expected);
  let text;
  try {
    if (!existsSync(expected)) return [`${name}: the session decision table is missing`];
    if (!lstatSync(expected).isFile() || realpathSync(expected) !== expected) return [`${name}: decision table is not a contained regular file`];
    text = readFileSync(expected, "utf8");
  } catch (error) {
    return [`${name}: the session decision table could not be read (${error.code ?? "read failure"})`];
  }

  const table = sections(text);
  const status = (table.get("Final Alignment Status") ?? []).join("\n").trim();
  const problems = [];
  const report = (message) => problems.push(`${name}: ${message}`);
  const held = /\bNot aligned\b/i.test(status) || laterNotAligned(text);
  const aligned = !held && /^\s*(?:[-*]\s+)?(?:`|\*\*)?Aligned(?:`|\*\*)?\s*$/im.test(status);
  if (!status) report("Final Alignment Status is missing");
  else if (held) report("Final Alignment Status is still Not aligned");
  else if (!aligned) report("Final Alignment Status does not say Aligned");
  if (aligned && !table.has("Frozen Behavior")) report("Frozen Behavior is missing from the aligned table");
  for (const heading of REVIEW_SECTIONS) {
    if (!hasReviewEvidence(table.get(heading) ?? [])) report(`${heading} is empty or still a placeholder`);
  }
  for (const line of [...table.get("Evidence Artifacts") ?? [], ...table.get("Evidence") ?? []]) {
    if (!line.trimStart().startsWith("|")) continue;
    const [, claim, ...fields] = line.split("|");
    if (fields.some((field) => PENDING_EVIDENCE.test(field.trim()))) report(`pending evidence for ${claim.trim() || "an unnamed claim"}`);
  }
  for (const heading of ["Inputs", "Notes", "Open Questions", "Evidence Artifacts", "Evidence"]) {
    if ((table.get(heading) ?? []).some(pendingRuling)) report(`pending ruling in ${heading}`);
  }
  for (const [heading, lines] of table) {
    if (/^(?:Inputs|Notes|Open Questions|Evidence|Evidence Artifacts|Superseded|Frozen Behavior|Verification Findings|Fixes Applied|Adversarial Review)$/.test(heading)) continue;
    if (lines.some((line) => line.trimStart().startsWith("|") && pendingRuling(line))) report(`pending ruling in ${heading || "a table row"}`);
  }
  const missingRows = new Set((table.get("Missing tests") ?? []).filter((line) => /^\s*[-*]\s+/.test(line))
    .flatMap((line) => line.match(/\b(?:DT|ROW)-[A-Za-z0-9.-]+\b/g) ?? []));
  for (const line of [...table.values()].flat().filter((entry) => /built[^|\n]*without (?:a )?test|built[^|\n]*no test/i.test(entry))) {
    const row = /\b(?:DT|ROW)-[A-Za-z0-9.-]+\b/.exec(line)?.[0];
    if (!row || !missingRows.has(row)) report(`${row ?? "a row"} is built without a test and is absent from Missing tests`);
  }
  return problems;
}

/**
 * Whether a Not aligned statement comes after the last `## Final Alignment Status` heading: an append-only table
 * records later status changes in its later sections, and the latest one holds. Table rows that quote the phrase
 * describe a rule, not the table's status.
 */
function laterNotAligned(text) {
  let fence = null;
  let latestSection = -1;
  let latestHeld = -1;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^##\s+Final Alignment Status\s*$/.test(line)) latestSection = index;
    else if (!line.trimStart().startsWith("|") && /\bNot aligned\b/i.test(line)) latestHeld = index;
  }
  return latestHeld > latestSection;
}
