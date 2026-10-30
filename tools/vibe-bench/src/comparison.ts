import { BENCHMARK_EFFORT, BENCHMARK_MODEL, TARGET_WALL_MS } from "./contract.ts";
import type { ClaudeBenchmarkResult } from "./result-schema.ts";
import { verifyResultHash } from "./result-schema.ts";

/** Green is within noise, yellow or red requires a local explanation. */
export type ThresholdStatus = "green" | "yellow" | "red";
/** Section 5's gated signals; cached input is deliberately absent. */
export type Signal = "wallMs" | "uncachedInputTokens" | "outputTokens" | "modelCalls" | "taskSuccess" | "instructionWords";

/** One threshold verdict with the exact baseline noise used in its decision. */
export interface SignalVerdict {
  signal: Signal;
  status: ThresholdStatus;
  baselineMedian: number | null;
  baselineMad: number | null;
  candidateMedian: number | null;
  thresholdYellow: number | null;
  thresholdRed: number | null;
  detail: string;
}

/** Complete local baseline-versus-candidate verdict for one benchmark shape. */
export interface Comparison {
  shape: ClaudeBenchmarkResult["identity"]["shape"];
  baselinePluginSha: string;
  candidatePluginSha: string;
  signals: SignalVerdict[];
  informational: {
    cachedInputTokens: { baselineMedian: number; candidateMedian: number };
    costUsd: { baselineMedian: number; candidateMedian: number };
  };
  status: ThresholdStatus;
  yellowExplanationRequired: boolean;
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

function numericSignal(signal: Signal, baseline: ClaudeBenchmarkResult[], candidateRuns: ClaudeBenchmarkResult[]): SignalVerdict {
  const base = baseline.map((run) => metric(run, signal));
  const candidate = candidateRuns.map((run) => metric(run, signal));
  const baselineMedian = median(base);
  const baselineMad = mad(base);
  const candidateMedian = median(candidate);
  const thresholdYellow = baselineMedian + Math.max(3 * baselineMad, baselineMedian * 0.2);
  const thresholdRed = signal === "wallMs" ? baselineMedian * 2
    : baselineMedian + Math.max(6 * baselineMad, baselineMedian * 0.5);
  const overCap = signal === "wallMs" && candidate.some((value) => value > TARGET_WALL_MS);
  const status: ThresholdStatus = overCap || candidateMedian > thresholdRed ? "red"
    : candidateMedian > thresholdYellow ? "yellow" : "green";
  return {
    signal, status, baselineMedian, baselineMad, candidateMedian, thresholdYellow, thresholdRed,
    detail: overCap ? `At least one run exceeded the fixed ${TARGET_WALL_MS} ms cap.`
      : `${signal} candidate median ${candidateMedian}; baseline median ${baselineMedian}, MAD ${baselineMad}.`,
  };
}

/** Compare two immutable local samples with at least three runs per sample. */
export function compareResults(
  baseline: ClaudeBenchmarkResult[],
  candidate: ClaudeBenchmarkResult[],
  instructionWords: { baseline: number; candidate: number },
): Comparison {
  if (baseline.length < 3 || candidate.length < 3) throw new Error("benchmark-comparison-run-count");
  const all = [...baseline, ...candidate];
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
      candidate.some((run) => run.identity.pluginSha !== candidate[0].identity.pluginSha)) {
    throw new Error("benchmark-comparison-plugin-sha-drift");
  }
  for (const run of all) {
    if (!Number.isFinite(run.identity.wallMs) || run.identity.wallMs < 0 ||
        !Number.isFinite(run.modelCalls) || run.modelCalls < 0) throw new Error("benchmark-comparison-metric-invalid");
  }
  if (!Number.isInteger(instructionWords.baseline) || !Number.isInteger(instructionWords.candidate) ||
      instructionWords.baseline <= 0 || instructionWords.candidate < 0) {
    throw new Error("benchmark-instruction-words-invalid");
  }
  const signals = (["wallMs", "uncachedInputTokens", "outputTokens", "modelCalls"] as const)
    .map((signal) => numericSignal(signal, baseline, candidate));
  const successes = candidate.filter((run) => run.success).length;
  const successRatio = successes / candidate.length;
  signals.push({
    signal: "taskSuccess", status: successRatio < 2 / 3 ? "red" : successRatio < 1 ? "yellow" : "green",
    baselineMedian: null, baselineMad: null, candidateMedian: successes,
    thresholdYellow: candidate.length, thresholdRed: Math.ceil(candidate.length * 2 / 3),
    detail: `${successes} of ${candidate.length} candidate runs succeeded.`,
  });
  const growth = (instructionWords.candidate - instructionWords.baseline) / instructionWords.baseline;
  signals.push({
    signal: "instructionWords", status: growth > 0.02 ? "yellow" : "green",
    baselineMedian: instructionWords.baseline, baselineMad: null, candidateMedian: instructionWords.candidate,
    thresholdYellow: instructionWords.baseline * 1.02, thresholdRed: null,
    detail: `Net static instruction growth ${(growth * 100).toFixed(2)}%; no automatic red threshold.`,
  });
  const status: ThresholdStatus = signals.some((signal) => signal.status === "red") ? "red"
    : signals.some((signal) => signal.status === "yellow") ? "yellow" : "green";
  return {
    shape: first.shape, baselinePluginSha: baseline[0].identity.pluginSha,
    candidatePluginSha: candidate[0].identity.pluginSha, signals, status,
    informational: {
      cachedInputTokens: {
        baselineMedian: median(baseline.map((run) => run.totals.cachedInputTokens)),
        candidateMedian: median(candidate.map((run) => run.totals.cachedInputTokens)),
      },
      costUsd: {
        baselineMedian: median(baseline.map((run) => run.costUsd)),
        candidateMedian: median(candidate.map((run) => run.costUsd)),
      },
    },
    yellowExplanationRequired: signals.some((signal) => signal.status === "yellow"),
  };
}
