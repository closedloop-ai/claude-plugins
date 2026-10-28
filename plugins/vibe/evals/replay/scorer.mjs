// M3: scores one replay run against the human change.
//   functional: the human change's own test files, run on the agent's tree (injected `runTests`)
//   minimality: agent diff size and file overlap against the human diff
//   criteria:   graders in the evals/<case>/graders format run over the agent's diff
// A check that could not run is BLOCKED with its reason and a check that does not
// apply is NOT_APPLICABLE; a missing oracle is never PASS.

import { ReplayResult } from "./results.mjs";
import { gradeText } from "./graders.mjs";
import { scoreUncertainty } from "./uncertainty.mjs";

/** Parses `git diff --numstat` text. A binary file (`-`) counts as a file with no lines. */
export function parseNumstat(text) {
  return (text ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [added, deleted, ...rest] = line.split("\t");
    return { path: rest.join("\t"), additions: Number(added) || 0, deletions: Number(deleted) || 0 };
  });
}

/** Diff size and overlap; a ratio is null when the human diff gives no denominator. */
export function minimality(agentFiles, humanFiles) {
  const agent = new Set(agentFiles.map((file) => file.path));
  const human = new Set(humanFiles.map((file) => file.path));
  const lines = (files) => files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  const shared = [...agent].filter((file) => human.has(file));
  const union = new Set([...agent, ...human]).size;
  return {
    agentLines: lines(agentFiles), humanLines: lines(humanFiles),
    agentFiles: agent.size, humanFiles: human.size,
    lineRatio: lines(humanFiles) === 0 ? null : lines(agentFiles) / lines(humanFiles),
    overlap: union === 0 ? null : shared.length / union,
    extraFiles: [...agent].filter((file) => !human.has(file)).sort(),
    missedFiles: [...human].filter((file) => !agent.has(file)).sort(),
  };
}

async function functional(ticket, record, runTests) {
  const testFiles = ticket.pr.testFiles ?? [];
  if (testFiles.length === 0) {
    return { id: "functional", result: ReplayResult.NotApplicable, reason: "the human change has no test files" };
  }
  if (record.result !== ReplayResult.Pass) return { id: "functional", result: ReplayResult.Blocked, reason: record.reason ?? "the run produced no tree to test" };
  if (typeof runTests !== "function") return { id: "functional", result: ReplayResult.Blocked, reason: "no test runner was given" };
  const files = await runTests({ workspace: record.workspace, testFiles, ticket });
  const ran = Array.isArray(files) && files.length === testFiles.length && files.every((file) => Number.isInteger(file?.exitCode));
  if (!ran) return { id: "functional", result: ReplayResult.Blocked, reason: "not every oracle test file ran to an exit code" };
  const failed = files.filter((file) => file.exitCode !== 0).map((file) => file.path);
  return { id: "functional", result: failed.length > 0 ? ReplayResult.Fail : ReplayResult.Pass, passedFiles: files.length - failed.length, failedFiles: failed };
}

async function criteria(graders, record, judge) {
  if (!graders) return [];
  if (typeof record.diffText !== "string") {
    return graders.map((grader) => ({ id: grader.id, result: ReplayResult.Blocked, reason: "the run has no diff text" }));
  }
  return gradeText(graders, record.diffText, { judge });
}

/** Fraction of criteria graders that passed; null when none could run. BLOCKED graders are excluded and counted. */
export function criteriaScore(entries) {
  const decided = entries.filter((entry) => entry.result === ReplayResult.Pass || entry.result === ReplayResult.Fail);
  const passed = decided.filter((entry) => entry.result === ReplayResult.Pass).length;
  return { passed, decided: decided.length, blocked: entries.length - decided.length, fraction: decided.length === 0 ? null : passed / decided.length };
}

/**
 * deps = {runTests({workspace, testFiles, ticket}) -> [{path, exitCode}], judge?, graders?: grader[]};
 * `uncertaintyInput` is the labeled input of uncertainty.mjs for this run, when there is one.
 */
export async function scoreRun({ ticket, record, deps, uncertaintyInput }) {
  const entries = await criteria(deps.graders, record, deps.judge);
  const numstat = record.result === ReplayResult.Pass ? parseNumstat(record.numstat) : null;
  return {
    slug: record.slug, taskClass: record.taskClass, arm: record.arm, run: record.run,
    functional: await functional(ticket, record, deps.runTests),
    oracleFilesEditedByAgent: numstat ? numstat.map((file) => file.path).filter((file) => (ticket.pr.testFiles ?? []).includes(file)) : null,
    minimality: numstat ? minimality(numstat, ticket.pr.files) : null,
    criteria: entries,
    criteriaScore: criteriaScore(entries),
    contamination: record.contamination ?? null,
    telemetry: record.telemetry ?? null,
    uncertainty: uncertaintyInput ? scoreUncertainty(uncertaintyInput) : null,
  };
}
