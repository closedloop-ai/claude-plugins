import { createHash } from "node:crypto";
import type { EvalCaseResult, EvalSuiteResult, LocalEvalResult } from "./eval-collector.ts";
import { verifyLocalEvalHash } from "./eval-collector.ts";

/** One runtime-specific case outcome that differs from or agrees with main. */
export interface EvalCaseFinding {
  runtime: "claude" | "codex";
  id: string;
  reason: string;
}

/** Immutable main-versus-candidate result plus the focused current-head proof. */
export interface EvalComparisonArtifact {
  schemaVersion: 1;
  createdAt: string;
  baselinePluginSha: string;
  candidatePluginSha: string;
  headSha: string;
  cases: number;
  baselineResultHash: string;
  candidateResultHash: string;
  rerunResultHash: string;
  rerunCases: string[];
  controls: string[];
  regressions: EvalCaseFinding[];
  preExisting: EvalCaseFinding[];
  fixed: EvalCaseFinding[];
  runtimes: Array<{
    runtime: "claude" | "codex";
    baselinePassed: number;
    candidatePassed: number;
    regressions: number;
    preExisting: number;
  }>;
  success: boolean;
  resultHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function suite(result: LocalEvalResult, runtime: "claude" | "codex"): EvalSuiteResult {
  const record = result.runtimes.find((item) => item.runtime === runtime);
  if (!record?.result || record.invalidReason || result.deterministicOnly) {
    throw new Error("eval-comparison-runtime-incomplete");
  }
  return record.result;
}

function caseMap(value: EvalSuiteResult): Map<string, EvalCaseResult> {
  return new Map(value.cases.map((item) => [item.id, item]));
}

function finding(runtime: "claude" | "codex", item: EvalCaseResult): EvalCaseFinding {
  return { runtime, id: item.id, reason: item.failedGraders.join(", ") || "passed" };
}

function exactCases(left: string[], right: string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    [...left].sort().join("\0") === [...right].sort().join("\0");
}

/**
 * Compare one unchanged corpus against main, then prove every regression and a
 * stable control sample on the current head without repeating the full corpus.
 */
export function compareLocalEvals(baseline: LocalEvalResult, candidate: LocalEvalResult,
  rerun: LocalEvalResult, controls: string[]): EvalComparisonArtifact {
  [baseline, candidate, rerun].forEach(verifyLocalEvalHash);
  if (!exactCases(baseline.selectedCases, candidate.selectedCases) ||
      baseline.selectedCases.length === 0) throw new Error("eval-comparison-corpus-mismatch");
  if (baseline.pluginSha === candidate.pluginSha || baseline.pluginSha === rerun.pluginSha) {
    throw new Error("eval-comparison-identity-invalid");
  }
  if (!rerun.success || rerun.deterministicOnly || !controls.length ||
      new Set(controls).size !== controls.length) throw new Error("eval-comparison-rerun-invalid");

  const regressions: EvalCaseFinding[] = [];
  const preExisting: EvalCaseFinding[] = [];
  const fixed: EvalCaseFinding[] = [];
  const runtimes: EvalComparisonArtifact["runtimes"] = [];
  for (const runtime of ["claude", "codex"] as const) {
    const mainSuite = suite(baseline, runtime);
    const candidateSuite = suite(candidate, runtime);
    const rerunSuite = suite(rerun, runtime);
    if (mainSuite.cliVersion !== candidateSuite.cliVersion ||
        candidateSuite.cliVersion !== rerunSuite.cliVersion) {
      throw new Error("eval-comparison-runtime-identity-mismatch");
    }
    const mainCases = caseMap(mainSuite);
    const candidateCases = caseMap(candidateSuite);
    if (!exactCases([...mainCases.keys()], [...candidateCases.keys()])) {
      throw new Error("eval-comparison-runtime-corpus-mismatch");
    }
    for (const id of baseline.selectedCases) {
      const mainCase = mainCases.get(id)!;
      const candidateCase = candidateCases.get(id)!;
      if (mainCase.passed && !candidateCase.passed) regressions.push(finding(runtime, candidateCase));
      else if (!mainCase.passed && !candidateCase.passed) preExisting.push(finding(runtime, candidateCase));
      else if (!mainCase.passed && candidateCase.passed) fixed.push(finding(runtime, mainCase));
    }
    runtimes.push({ runtime, baselinePassed: mainSuite.passed, candidatePassed: candidateSuite.passed,
      regressions: regressions.filter((item) => item.runtime === runtime).length,
      preExisting: preExisting.filter((item) => item.runtime === runtime).length });
  }
  const controlSet = new Set(controls);
  for (const id of controls) {
    if (!baseline.selectedCases.includes(id) || ([baseline, candidate] as const).some((result) =>
      (["claude", "codex"] as const).some((runtime) => !caseMap(suite(result, runtime)).get(id)?.passed))) {
      throw new Error("eval-comparison-control-not-stable");
    }
  }
  const expectedRerun = [...new Set([...regressions.map((item) => item.id), ...controlSet])].sort();
  if (!exactCases(rerun.selectedCases, expectedRerun)) throw new Error("eval-comparison-rerun-coverage");
  for (const runtime of ["claude", "codex"] as const) {
    const rerunSuite = suite(rerun, runtime);
    if (rerunSuite.failed !== 0 || !exactCases(rerunSuite.cases.map((item) => item.id), expectedRerun)) {
      throw new Error("eval-comparison-rerun-failed");
    }
  }
  const payload: Omit<EvalComparisonArtifact, "resultHash"> = {
    schemaVersion: 1, createdAt: new Date().toISOString(),
    baselinePluginSha: baseline.pluginSha, candidatePluginSha: candidate.pluginSha,
    headSha: rerun.pluginSha, cases: baseline.selectedCases.length,
    baselineResultHash: baseline.resultHash, candidateResultHash: candidate.resultHash,
    rerunResultHash: rerun.resultHash, rerunCases: expectedRerun, controls: [...controls].sort(),
    regressions, preExisting, fixed, runtimes, success: true,
  };
  return { ...payload, resultHash: hash(payload) };
}

/** Reject modified eval comparison evidence before report or PR publication. */
export function verifyEvalComparisonHash(result: EvalComparisonArtifact): void {
  const { resultHash, ...payload } = result;
  if (!/^[a-f0-9]{64}$/.test(resultHash) || hash(payload) !== resultHash || !result.success ||
      !/^[a-f0-9]{40}$/.test(result.headSha) || result.cases <= 0 || !result.rerunCases.length) {
    throw new Error("eval-comparison-hash-mismatch");
  }
}

/** Render the comparison artifact without developer-machine paths. */
export function buildEvalComparisonReport(result: EvalComparisonArtifact): string {
  verifyEvalComparisonHash(result);
  const lines = [
    "# Vibe eval comparison", "",
    `Main \`${result.baselinePluginSha}\`; candidate \`${result.candidatePluginSha}\`; ` +
      `current head \`${result.headSha}\`.`,
    `Shared corpus ${result.cases} cases; focused rerun ${result.rerunCases.length} cases; ` +
      `result hash \`${result.resultHash}\`.`, "",
    "| runtime | main passed | candidate passed | regressions | pre-existing |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...result.runtimes.map((item) => `| ${item.runtime} | ${item.baselinePassed} | ` +
      `${item.candidatePassed} | ${item.regressions} | ${item.preExisting} |`),
    "", "## Pre-existing failures", "",
    ...(result.preExisting.length ? result.preExisting.map((item) =>
      `- ${item.runtime} ${item.id}: ${item.reason}.`) : ["None."]),
    "", "## Regressions", "",
    ...(result.regressions.length ? result.regressions.map((item) =>
      `- ${item.runtime} ${item.id}: ${item.reason}.`) : ["None."]),
  ];
  return `${lines.join("\n")}\n`;
}
