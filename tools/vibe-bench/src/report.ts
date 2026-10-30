import type { Comparison, Signal } from "./comparison.ts";
import type { ClaudeBenchmarkResult, ModelCall } from "./result-schema.ts";
import { verifyResultHash } from "./result-schema.ts";

/** Human explanation names the owning component and phase of each regression. */
export interface RegressionExplanation {
  component: ModelCall["component"];
  phase: NonNullable<ModelCall["phase"]> | "unobserved";
  why: string;
}

function cell(value: string | number | null): string {
  return value === null ? "unknown" : String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render a stable Markdown table for benchmark disclosures. */
export function table(headers: string[], rows: Array<Array<string | number | null>>): string {
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n` +
    rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
}

/** Aggregate request records by an evidence-backed attribution facet. */
export function groupedRows(calls: ModelCall[], facet: "component" | "skill" | "worker" | "phase"):
  Array<Array<string | number | null>> {
  const names = [...new Set(calls.map((call) => call[facet] ?? "unobserved"))].sort();
  return names.map((name) => {
    const group = calls.filter((call) => (call[facet] ?? "unobserved") === name);
    const sum = (key: "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens"): number | null => {
      if (group.some((call) => call.tokens?.[key] == null)) return null;
      return group.reduce((total, call) => total + (call.tokens?.[key] ?? 0), 0);
    };
    const duration = group.some((call) => call.durationMs === null) ? null
      : group.reduce((total, call) => total + (call.durationMs ?? 0), 0);
    return [name, group.length, sum("inputTokens"), sum("cachedInputTokens"),
      sum("cacheWriteTokens"), sum("outputTokens"), duration];
  });
}

/** Build a local disclosure report without filling unknown request output with zero. */
export function buildReport(
  result: ClaudeBenchmarkResult,
  comparison?: Comparison,
  explanations: Partial<Record<Signal, RegressionExplanation>> = {},
): string {
  verifyResultHash(result);
  if (comparison) {
    for (const signal of comparison.signals.filter((item) => item.status !== "green")) {
      const explanation = explanations[signal.signal];
      if (!explanation?.component || !explanation.phase || !explanation.why.trim()) {
        throw new Error(`benchmark-explanation-missing:${signal.signal}`);
      }
    }
  }
  const lines = [
    "## Benchmark",
    "",
    `Result: ${result.valid ? (result.success ? "success" : "task failed") : "invalid"}; hash: \`${result.resultHash}\`.`,
    `Claude Code ${result.identity.cliVersion}; plugin \`${result.identity.pluginSha}\`; ${result.identity.shape}; task ${result.identity.taskId} (${result.identity.taskVersion}); fixture ${result.identity.fixtureVersion}.`,
    `Configured ${result.identity.configuredModel} / ${result.identity.configuredEffort}; observed model ${cell(result.observedModel)}, observed effort ${cell(result.observedEffort)}.`,
    `Wall ${result.identity.wallMs} ms (stack setup ${result.identity.stackSetupMs} ms, teardown ${result.identity.stackTeardownMs} ms); cost $${result.costUsd.toFixed(6)}; ${result.modelCalls} model calls.`,
    `Totals: input ${result.totals.inputTokens}, cached read ${result.totals.cachedInputTokens}, uncached input ${result.totals.uncachedInputTokens}, cache write ${result.totals.cacheWriteTokens}, output ${result.totals.outputTokens}, thinking ${cell(result.totals.thinkingTokens)}. Cached input is reported, not independently gated.`,
  ];
  if (!result.valid) lines.push(`Invalid reasons: ${result.invalidReasons.join(", ")}.`);
  for (const facet of ["component", "skill", "worker", "phase"] as const) {
    lines.push("", `### ${facet[0].toUpperCase()}${facet.slice(1)} calls`, "",
      table([facet, "calls", "input", "cache read", "cache write", "output", "request ms"], groupedRows(result.calls, facet)));
  }
  lines.push("", "### Declared agent models", "",
    table(["agent", "frontmatter model"], Object.entries(result.agentModels).sort(([a], [b]) => a.localeCompare(b))));
  if (comparison) {
    lines.push("", `Comparison: ${comparison.status}.`, "", "### Comparison with baseline", "",
      table(["signal", "baseline median", "baseline MAD", "candidate median", "yellow above", "red above", "status"],
        comparison.signals.map((signal) => [signal.signal, signal.baselineMedian, signal.baselineMad,
          signal.candidateMedian, signal.thresholdYellow, signal.thresholdRed, signal.status])));
    lines.push("", "### Informational measures (no independent gate)", "",
      table(["measure", "baseline median", "candidate median"], [
        ["cached input tokens", comparison.informational.cachedInputTokens.baselineMedian,
          comparison.informational.cachedInputTokens.candidateMedian],
        ["dollar cost", comparison.informational.costUsd.baselineMedian,
          comparison.informational.costUsd.candidateMedian],
      ]));
    if (comparison.status !== "green") {
      lines.push("", "### Regression explanations", "");
      for (const signal of comparison.signals.filter((item) => item.status !== "green")) {
        const item = explanations[signal.signal]!;
        lines.push(`- ${signal.signal} (${signal.status}): component **${item.component}**, phase **${item.phase}**: ${item.why}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
