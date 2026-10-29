import { BENCHMARK_EFFORT, BENCHMARK_MODEL, TARGET_WALL_MS } from "./contract.ts";
import type { ClaudeBenchmarkResult } from "./result-schema.ts";
import { verifyResultHash } from "./result-schema.ts";

/** Green passes, yellow requires explanation, red needs approver acceptance. */
export type ThresholdStatus = "green" | "yellow" | "red";
/** Section 5's gated signals; cached input is deliberately absent. */
export type Signal = "wallMs" | "uncachedInputTokens" | "outputTokens" | "modelCalls" | "taskSuccess" | "instructionWords";

/** One threshold verdict with the exact baseline noise used in its decision. */
export interface SignalVerdict {
  signal: Signal;
  status: ThresholdStatus;
  baselineMedian: number | null;
  baselineMad: number | null;
  prMedian: number | null;
  thresholdYellow: number | null;
  thresholdRed: number | null;
  detail: string;
}

/** Complete five-versus-three verdict for one Claude benchmark shape. */
export interface Comparison {
  shape: ClaudeBenchmarkResult["identity"]["shape"];
  baselinePluginSha: string;
  prPluginSha: string;
  signals: SignalVerdict[];
  informational: {
    cachedInputTokens: { baselineMedian: number; prMedian: number };
    costUsd: { baselineMedian: number; prMedian: number };
  };
  status: ThresholdStatus;
  yellowExplanationRequired: boolean;
  redRequiresApproverAcceptance: boolean;
}

/** Standard median, including the mean of the two middle values for even N. */
export function median(values: number[]): number {
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error("benchmark-median-invalid");
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Median absolute deviation of the baseline, never a candidate noise estimate. */
export function mad(values: number[]): number {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

function metric(run: ClaudeBenchmarkResult, signal: Signal): number {
  switch (signal) {
    case "wallMs": return run.identity.wallMs;
    case "uncachedInputTokens": return run.totals.uncachedInputTokens;
    case "outputTokens": return run.totals.outputTokens;
    case "modelCalls": return run.modelCalls;
    default: throw new Error(`benchmark-metric-unsupported:${signal}`);
  }
}

function numericSignal(signal: Signal, baseline: ClaudeBenchmarkResult[], pr: ClaudeBenchmarkResult[]): SignalVerdict {
  const base = baseline.map((run) => metric(run, signal));
  const candidate = pr.map((run) => metric(run, signal));
  const baselineMedian = median(base);
  const baselineMad = mad(base);
  const prMedian = median(candidate);
  const thresholdYellow = baselineMedian + Math.max(3 * baselineMad, baselineMedian * 0.2);
  const thresholdRed = signal === "wallMs" ? baselineMedian * 2
    : baselineMedian + Math.max(6 * baselineMad, baselineMedian * 0.5);
  const overCap = signal === "wallMs" && candidate.some((value) => value > TARGET_WALL_MS);
  const status: ThresholdStatus = overCap || prMedian > thresholdRed ? "red"
    : prMedian > thresholdYellow ? "yellow" : "green";
  return {
    signal, status, baselineMedian, baselineMad, prMedian, thresholdYellow, thresholdRed,
    detail: overCap ? `At least one run exceeded the fixed ${TARGET_WALL_MS} ms cap.`
      : `${signal} PR median ${prMedian}; baseline median ${baselineMedian}, MAD ${baselineMad}.`,
  };
}

/** Compare exactly five main runs with exactly three PR runs for one shape. */
export function compareResults(
  baseline: ClaudeBenchmarkResult[],
  pr: ClaudeBenchmarkResult[],
  instructionWords: { baseline: number; pr: number },
): Comparison {
  if (baseline.length !== 5 || pr.length !== 3) throw new Error("benchmark-comparison-run-count");
  const all = [...baseline, ...pr];
  all.forEach(verifyResultHash);
  if (new Set(all.map((run) => run.identity.id)).size !== all.length) {
    throw new Error("benchmark-comparison-duplicate-run");
  }
  if (all.some((run) => !run.valid || run.runtime !== "claude" ||
      run.identity.configuredModel !== BENCHMARK_MODEL || run.observedModel !== BENCHMARK_MODEL ||
      run.identity.configuredEffort !== BENCHMARK_EFFORT || run.observedEffort !== BENCHMARK_EFFORT)) {
    throw new Error("benchmark-comparison-invalid-run");
  }
  const first = all[0].identity;
  if (all.some((run) => run.identity.shape !== first.shape || run.identity.taskId !== first.taskId ||
      run.identity.taskVersion !== first.taskVersion || run.identity.fixtureVersion !== first.fixtureVersion ||
      run.identity.configuredModel !== first.configuredModel || run.identity.configuredEffort !== first.configuredEffort ||
      run.identity.cliVersion !== first.cliVersion)) {
    throw new Error("benchmark-comparison-identity-drift");
  }
  if (baseline.some((run) => run.identity.pluginSha !== baseline[0].identity.pluginSha) ||
      pr.some((run) => run.identity.pluginSha !== pr[0].identity.pluginSha)) {
    throw new Error("benchmark-comparison-plugin-sha-drift");
  }
  for (const run of all) {
    if (!Number.isFinite(run.identity.wallMs) || run.identity.wallMs < 0 ||
        !Number.isFinite(run.modelCalls) || run.modelCalls < 0) throw new Error("benchmark-comparison-metric-invalid");
  }
  if (!Number.isInteger(instructionWords.baseline) || !Number.isInteger(instructionWords.pr) ||
      instructionWords.baseline <= 0 || instructionWords.pr < 0) {
    throw new Error("benchmark-instruction-words-invalid");
  }
  const signals = (["wallMs", "uncachedInputTokens", "outputTokens", "modelCalls"] as const)
    .map((signal) => numericSignal(signal, baseline, pr));
  const successes = pr.filter((run) => run.success).length;
  signals.push({
    signal: "taskSuccess", status: successes < 2 ? "red" : successes < 3 ? "yellow" : "green",
    baselineMedian: null, baselineMad: null, prMedian: successes,
    thresholdYellow: 3, thresholdRed: 2,
    detail: `${successes} of 3 PR runs succeeded.`,
  });
  const growth = (instructionWords.pr - instructionWords.baseline) / instructionWords.baseline;
  signals.push({
    signal: "instructionWords", status: growth > 0.02 ? "yellow" : "green",
    baselineMedian: instructionWords.baseline, baselineMad: null, prMedian: instructionWords.pr,
    thresholdYellow: instructionWords.baseline * 1.02, thresholdRed: null,
    detail: `Net static instruction growth ${(growth * 100).toFixed(2)}%; no automatic red threshold.`,
  });
  const status: ThresholdStatus = signals.some((signal) => signal.status === "red") ? "red"
    : signals.some((signal) => signal.status === "yellow") ? "yellow" : "green";
  return {
    shape: first.shape, baselinePluginSha: baseline[0].identity.pluginSha,
    prPluginSha: pr[0].identity.pluginSha, signals, status,
    informational: {
      cachedInputTokens: {
        baselineMedian: median(baseline.map((run) => run.totals.cachedInputTokens)),
        prMedian: median(pr.map((run) => run.totals.cachedInputTokens)),
      },
      costUsd: {
        baselineMedian: median(baseline.map((run) => run.costUsd)),
        prMedian: median(pr.map((run) => run.costUsd)),
      },
    },
    yellowExplanationRequired: signals.some((signal) => signal.status === "yellow"),
    redRequiresApproverAcceptance: status === "red",
  };
}
