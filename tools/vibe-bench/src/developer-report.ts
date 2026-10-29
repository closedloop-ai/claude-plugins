import type { LocalEvalResult } from "./eval-collector.ts";
import { verifyLocalEvalHash } from "./eval-collector.ts";
import type { Signal } from "./comparison.ts";
import type { DeveloperBenchmarkArtifact } from "./developer-benchmark.ts";
import { verifyDeveloperBenchmarkHash } from "./developer-benchmark.ts";
import { groupedRows, table } from "./report.ts";
import type { RegressionExplanation } from "./report.ts";
import type { BenchmarkShape, ModelCall } from "./result-schema.ts";

/** Explanations are keyed by shape and signal because both shapes are gated. */
export type DeveloperExplanations = Partial<Record<`${BenchmarkShape}:${Signal}`, RegressionExplanation>>;

function cell(value: number | null): string | number {
  return value === null ? "unknown" : value;
}

function exactCoverage(actual: string[], expected: string[]): void {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
      [...actual].sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error("benchmark-eval-case-coverage-mismatch");
  }
}

/** Render the one publishable Benchmark section after all local evidence is complete. */
export function buildDeveloperReport(result: DeveloperBenchmarkArtifact, evaluation: LocalEvalResult,
  expectedEvalCases: string[], explanations: DeveloperExplanations = {}): string {
  verifyDeveloperBenchmarkHash(result);
  verifyLocalEvalHash(evaluation);
  exactCoverage(evaluation.selectedCases, expectedEvalCases);
  if (!evaluation.success || evaluation.deterministicOnly || evaluation.pluginSha !== result.pluginSha ||
      evaluation.runtimes.some((runtime) => !runtime.result || runtime.result.failed !== 0)) {
    throw new Error("benchmark-eval-not-publishable");
  }
  const regressions = Object.entries(result.comparisons).flatMap(([shape, comparison]) =>
    comparison.signals.filter((signal) => signal.status !== "green").map((signal) => ({
      shape: shape as BenchmarkShape, signal,
      explanation: explanations[`${shape as BenchmarkShape}:${signal.signal}`],
    })));
  for (const item of regressions) {
    if (!item.explanation?.component || !item.explanation.phase || !item.explanation.why.trim()) {
      throw new Error(`benchmark-explanation-missing:${item.shape}:${item.signal.signal}`);
    }
  }
  const calls: ModelCall[] = result.runs.flatMap((run) => run.result.calls);
  const totals = result.runs.reduce((sum, run) => ({
    input: sum.input + run.result.totals.inputTokens,
    uncached: sum.uncached + run.result.totals.uncachedInputTokens,
    cached: sum.cached + run.result.totals.cachedInputTokens,
    cacheWrite: sum.cacheWrite + run.result.totals.cacheWriteTokens,
    output: sum.output + run.result.totals.outputTokens,
  }), { input: 0, uncached: 0, cached: 0, cacheWrite: 0, output: 0 });
  const agentModels = Object.fromEntries(result.runs.flatMap((run) => Object.entries(run.result.agentModels))
    .sort(([left], [right]) => left.localeCompare(right)));
  const lines = [
    "## Benchmark", "",
    `Result: success; hash: \`${result.resultHash}\`.`,
    `Baseline hash: \`${result.baselineHash}\`.`,
    `Selected PR #${result.selectedPr.number}; head \`${result.pluginSha}\`; symphony-alpha \`${result.sourceSha}\`.`,
    `Claude Code ${result.cliVersion}; six runs in three paired waves.`,
    "Configured claude-sonnet-5-5 / high; observed model claude-sonnet-5-5, observed effort high.",
    `Wall ${result.fullWallMs} ms (stack setup ${result.stackSetupMs} ms, teardown ${result.stackTeardownMs} ms); cost $${result.totalCostUsd.toFixed(6)}; ${calls.length} model calls.`,
    `Target under ${result.targetMs} ms: ${result.targetMet ? "met" : "missed"}; preflight ${result.preflightMs} ms.`,
    `Totals: input ${totals.input}, cached read ${totals.cached}, uncached input ${totals.uncached}, cache write ${totals.cacheWrite}, output ${totals.output}, thinking unknown.`,
    "Cached input is reported, not independently gated.", "", "### Every run", "",
    table(["#", "shape", "wall ms", "uncached input", "cached input", "output", "calls", "cost USD", "proof"],
      result.runs.map((run) => [run.index + 1, run.shape, run.result.identity.wallMs,
        run.result.totals.uncachedInputTokens, run.result.totals.cachedInputTokens,
        run.result.totals.outputTokens, run.result.modelCalls, run.result.costUsd.toFixed(6),
        `#${run.prNumber} closed; refs removed`])),
  ];
  for (const facet of ["component", "skill", "worker", "phase"] as const) {
    lines.push("", `### ${facet[0].toUpperCase()}${facet.slice(1)} calls`, "",
      table([facet, "calls", "input", "cache read", "cache write", "output", "request ms"],
        groupedRows(calls, facet)));
  }
  lines.push("", "### Declared agent models", "",
    table(["agent", "frontmatter model"], Object.entries(agentModels)),
    "", `Comparison: ${result.status}.`, "", "### Comparison with main", "",
    table(["shape", "signal", "main median", "main MAD", "PR median", "yellow above", "red above", "status"],
      Object.entries(result.comparisons).flatMap(([shape, comparison]) => comparison.signals.map((signal) => [
        shape, signal.signal, cell(signal.baselineMedian), cell(signal.baselineMad), cell(signal.prMedian),
        cell(signal.thresholdYellow), cell(signal.thresholdRed), signal.status,
      ]))),
    "", "### Informational measures", "",
    table(["shape", "measure", "main median", "PR median"],
      Object.entries(result.comparisons).flatMap(([shape, comparison]) => [
        [shape, "cached input tokens", comparison.informational.cachedInputTokens.baselineMedian,
          comparison.informational.cachedInputTokens.prMedian],
        [shape, "dollar cost", comparison.informational.costUsd.baselineMedian,
          comparison.informational.costUsd.prMedian],
      ])));
  if (regressions.length) {
    lines.push("", "### Regression explanations", "");
    for (const item of regressions) {
      const explanation = item.explanation!;
      lines.push(`- ${item.shape}:${item.signal.signal} (${item.signal.status}): component **${explanation.component}**, phase **${explanation.phase}**: ${explanation.why}`);
    }
  }
  lines.push("", "### Model-driven evals", "",
    `Full shared corpus: ${evaluation.selectedCases.length} cases; result hash \`${evaluation.resultHash}\`; plugin \`${evaluation.pluginSha}\`.`,
    ...evaluation.runtimes.map((runtime) => `- ${runtime.runtime}: ${runtime.result!.passed}/${evaluation.selectedCases.length} passed; CLI ${runtime.result!.cliVersion}; native hash \`${runtime.result!.nativeHash}\`.`));
  if (result.status === "red") {
    lines.push("", "Red regression: blocked pending Daniel Ochoa's explicit acceptance.");
  }
  return `${lines.join("\n")}\n`;
}
