#!/usr/bin/env node
// Validates the single operator review page. Duplicate F1-style IDs across
// audits made findings ambiguous, so IDs are globally unique and encode kind.
// A decision row (D###) also names where the code was checked first
// (`checked in code: <file>:<line>`): questions the schema already answered
// (an owner that comes from the code host cannot be reassigned) once reached
// the operator.
// Usage: review-page-check.mjs <review.md>

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROW = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|(.*)$/gm;
const CODE_EVIDENCE = /checked in code:\s*[^\s|:]+:\d+/i;
const ID = /^[DXNSR]\d{3,}$/;
const STATUS = { D: "decision needed", X: "fixing", N: "stands", S: "superseded", R: "ruling" };

/** Problems in an operator review page. */
export function reviewPageProblems(text) {
  const seen = new Set();
  const problems = [];
  for (const match of text.matchAll(ROW)) {
    const id = match[1].trim();
    if (id === "ID" || /^-+$/.test(id)) continue;
    const status = match[2].trim().toLowerCase();
    if (!ID.test(id)) problems.push(`${id}: ID must be D###, X###, N###, S### or R###`);
    else if (seen.has(id)) problems.push(`${id}: duplicate ID; review IDs are never reused`);
    else if (status !== STATUS[id[0]]) problems.push(`${id}: status must be ${STATUS[id[0]]}`);
    else if (id[0] === "D" && !CODE_EVIDENCE.test(match[3])) {
      problems.push(`${id}: a decision names where the code was checked first (checked in code: <file>:<line>); drop it if the code already answers it`);
    }
    seen.add(id);
  }
  if (seen.size === 0) problems.push("no operator review rows");
  return problems;
}

function main(file) {
  if (!file) throw new Error("Usage: review-page-check.mjs <review.md>");
  const problems = reviewPageProblems(readFileSync(file, "utf8"));
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exit(main(process.argv[2])); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
