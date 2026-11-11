// Canonical selection shape shared by the PR facts and comment gates. The
// verifier writes this evidence; neither consumer may reinterpret a path-only
// object as exact test coverage.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { proofSourceAt, testIntegrityProofShapeProblems } from "./test-integrity.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { validSourceIdentity } = await vibeCore("lib/vibe/scripts/tested-head.mjs");
const { exitOnProviderBroken } = await vibeCore("lib/vibe/scripts/provider.mjs");

// The selector a graph's test lookup records (the evidence file's version-skewed contract keeps its name).
export const GRAPH_SELECTOR = "code_tests_for";
export const TEST_SELECTORS = Object.freeze([GRAPH_SELECTOR, "related", "e2e-reference"]);

/**
 * Read canonical per-source test selections without discarding malformed
 * evidence. Every problem blocks the PR, even when valid sibling rows remain.
 * A graph selector's null list means the graph did not establish coverage and
 * requires a separate `related` row for that file.
 */
export function readTestSelection(evidence) {
  if (!Array.isArray(evidence?.testSelection)) {
    return { entries: [], problems: ["testSelection must be an array of {file, selector, tests} entries; rerun the verifier. A codeTestsFor object with basename tests cannot prove exact selected paths"] };
  }
  const problems = [];
  const entries = [];
  for (const [index, entry] of evidence.testSelection.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.file !== "string" || !entry.file.trim()) {
      problems.push(`testSelection entry ${index} needs a repo-relative file path`);
      continue;
    }
    if (!TEST_SELECTORS.includes(entry.selector)) {
      problems.push(`testSelection entry for ${entry.file} has selector ${JSON.stringify(entry.selector)}; use one of ${TEST_SELECTORS.join(", ")}`);
      continue;
    }
    if (!(Array.isArray(entry.tests) && entry.tests.every((test) => typeof test === "string" && test.trim()))
      && !(entry.selector === GRAPH_SELECTOR && entry.tests === null)) {
      problems.push(`testSelection entry for ${entry.file}: tests must be an array of exact repo-relative paths${entry.selector === GRAPH_SELECTOR ? " or null when the graph found none" : ""}`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, problems };
}

/**
 * The current unversioned PR evidence document's required structural shape.
 * The Part B path-only object is not a documented older version: it lacks the
 * cases, commands, lane report and full test paths needed for safe conversion.
 */
export function prEvidenceShapeProblems(evidence, receiptDir, readSource) {
  const problems = [
    ...readTestSelection(evidence).problems,
    ...testIntegrityProofShapeProblems(evidence, receiptDir, readSource),
    ...(evidence?.treeEquivalentCarry === undefined ? [] : treeEquivalentCarryShapeProblems(evidence.treeEquivalentCarry)),
  ];
  const inventory = evidence?.targetedInventory;
  if (evidence?.source !== undefined && !validSourceIdentity(evidence.source)) problems.push('source identity needs HEAD plus full diff/tree hashes');
  if (inventory?.source === 'working-tree' && (!validSourceIdentity(evidence?.source) || inventory.commit !== evidence.source.head)) {
    problems.push('working-tree inventory must name the actual tested HEAD and complete source identity');
  }
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    problems.push("targeted inventory of the final committed diff is missing");
  } else {
    if (inventory.actor !== "read-only" || !["final-committed-diff", "working-tree"].includes(inventory.source) || !/^[a-f0-9]{40}$/.test(inventory.commit ?? "")) {
      problems.push("targetedInventory must identify a read-only actor, the final committed diff and its full commit SHA");
    }
    if (evidence?.qaImpact !== undefined
      && (!/^[a-f0-9]{16}$/.test(evidence.qaImpact?.laneKey ?? "") || inventory.impactKey !== evidence.qaImpact.laneKey)) {
      problems.push("targetedInventory must name qaImpact.laneKey as its changed-file scope");
    }
    problems.push(...laneReportShapeProblems(inventory.laneReport));
    if (!Array.isArray(inventory.entries) || (inventory.entries.length === 0 && !inventory.noTestsReason)) {
      problems.push("targetedInventory needs exact entries with paths, cases and commands, or a noTestsReason");
    } else for (const [index, entry] of inventory.entries.entries()) {
      if (!entry?.kind || !entry?.path || !entry?.command || !Array.isArray(entry?.cases) || entry.cases.length === 0) {
        problems.push(`targetedInventory entry ${index} needs kind, exact path, cases and command`);
      }
      if (entry?.coveredFiles !== undefined && !Array.isArray(entry.coveredFiles)) {
        problems.push(`targetedInventory entry ${index} coveredFiles must be an array`);
      }
    }
  }
  if (!Array.isArray(evidence?.testRuns)) problems.push("testRuns must be an array of exact runs");
  if (!Array.isArray(evidence?.rerunCycles)) problems.push("rerunCycles must record isolated reruns, or [] when none failed");
  return problems;
}

/** @typedef {{kind: "command", command: string} | {kind: "github-workflow", path: string}} RepositoryLaneSource */
/** @typedef {{ref: string, commit: string, gitTree: string, source: {head: string, diffSha256: string, treeSha256: string}}} CarryPoint */
/** @typedef {{kind: "tree-equivalent", version: 1, proof: CarryPoint, published: CarryPoint, proofs?: CarryPoint[], laneKey: string,
 * runs: Array<{scopeKey: string, result: {lane: string, command: string, commit: string, laneKey?: string, status: "passed", exitCode: 0},
 * coveredFiles: Array<{path: string, sha256: string}>, receipt: {path: string, sha256: string}}>}} TreeEquivalentCarry */
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const LANE_KEY = /^[a-f0-9]{16}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
/** Literal repository-relative regular-file operands; never traversal, Git options or control characters. */
function evidencePath(value) {
  return typeof value === "string" && value.length > 0 && !/[\\\x00-\x1f]/.test(value)
    && !value.startsWith("/") && !value.startsWith("-") && value.split("/").every(part => part && ![".", "..", ".git"].includes(part));
}
/** Validate the shared declaration shape, with immutable definition identity required on a workflow report. */
export function laneSourceShapeProblems(source, report = false) {
  if (source?.kind === "command" && exactKeys(source, ["kind", "command"]) && typeof source.command === "string" && source.command.trim()) return [];
  if (source?.kind === "github-workflow" && exactKeys(source, report ? ["kind", "path", "commit", "sha256"] : ["kind", "path"])
    && evidencePath(source.path) && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(source.path)
    && (!report || COMMIT.test(source.commit ?? "") && HASH.test(source.sha256 ?? ""))) return [];
  return ["repository lane source needs a typed command or immutable github-workflow definition"];
}
/** One structural owner for both gate and comment consumers; legacy pnpm evidence remains compatible. */
export function laneReportShapeProblems(report) {
  const source = report?.source ?? { kind: "command", command: report?.command };
  const problems = laneSourceShapeProblems(source, true);
  if (!report?.source && report?.command !== "pnpm test:lanes") problems.push("legacy lane report needs pnpm test:lanes");
  if (!Array.isArray(report?.matches)) problems.push("lane report needs exact matching lane commands");
  return problems;
}
/** Machine-checkable carry shape; semantic authority is checked against Git and durable receipts by pr-facts. */
export function treeEquivalentCarryShapeProblems(carry) {
  const problems = [];
  const keys = ["kind", "version", "proof", "published", "laneKey", "runs"];
  if (object(carry) && Object.hasOwn(carry, "proofs")) keys.push("proofs");
  if (!exactKeys(carry, keys) || carry.kind !== "tree-equivalent" || carry.version !== 1) {
    return ["tree-equivalent carry needs its complete versioned contract"];
  }
  if (carry.proofs !== undefined && (!Array.isArray(carry.proofs) || carry.proofs.length > 100)) return ["tree carry proofs must be a bounded list of pinned points"];
  const points = [["proof", carry.proof], ["published", carry.published], ...(carry.proofs ?? []).map((point, index) => [`proofs[${index}]`, point])];
  const commits = new Set([carry.proof?.commit, carry.published?.commit]);
  for (const point of carry.proofs ?? []) {
    if (commits.has(point?.commit)) problems.push("tree carry proof commits must be unambiguous");
    commits.add(point?.commit);
  }
  for (const [name, point] of points) {
    if (!exactKeys(point, ["ref", "commit", "gitTree", "source"]) || !/^refs\/(?:heads|remotes)\/[A-Za-z0-9_./-]+$/.test(point?.ref ?? "")
      || !COMMIT.test(point?.commit ?? "") || !COMMIT.test(point?.gitTree ?? "") || !validSourceIdentity(point?.source)
      || point.source.head !== point.commit) problems.push(`tree carry ${name} needs a verified ref/commit/Git tree/source identity`);
  }
  if (!LANE_KEY.test(carry.laneKey ?? "")) problems.push("tree carry needs a lane key");
  if (!Array.isArray(carry.runs) || !carry.runs.length) return [...problems, "tree carry needs recorded run receipts"];
  for (const record of carry.runs) {
    const result = record?.result;
    if (!exactKeys(record, ["scopeKey", "result", "coveredFiles", "receipt"]) || !LANE_KEY.test(record.scopeKey ?? "") || !object(result) || typeof result.lane !== "string" || !result.lane
      || typeof result.command !== "string" || !result.command || !COMMIT.test(result.commit ?? "") || (result.laneKey !== undefined && !LANE_KEY.test(result.laneKey))
      || result.status !== "passed" || result.exitCode !== 0) problems.push("tree carry needs a complete passing recorded run result");
    if (!exactKeys(record?.receipt, ["path", "sha256"]) || !evidencePath(record.receipt.path) || !HASH.test(record.receipt.sha256 ?? "")) {
      problems.push("tree carry needs an immutable receipt path/hash");
    }
    if (!Array.isArray(record?.coveredFiles) || !record.coveredFiles.length
      || record.coveredFiles.some(file => !exactKeys(file, ["path", "sha256"]) || !evidencePath(file.path) || !HASH.test(file.sha256 ?? ""))
      || new Set(record.coveredFiles.map(file => file.path)).size !== record.coveredFiles.length) problems.push("tree carry needs immutable covered-file hashes");
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnProviderBroken();
  const { values } = parseArgs({ options: { file: { type: "string" }, worktree: { type: "string" } } });
  if (!values.file) throw new Error("Usage: pr-evidence-schema.mjs --file <private vibe-pr-evidence.json>");
  const problems = prEvidenceShapeProblems(JSON.parse(readFileSync(values.file, "utf8")), dirname(values.file),
    values.worktree ? file => proofSourceAt(values.worktree, file) : undefined);
  process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems })}\n`);
  if (problems.length) process.exitCode = 1;
}
