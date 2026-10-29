import { createHash } from "node:crypto";
import { BASELINE_ORDER, BASELINE_WAVES, shapePrompt } from "./claude-task.ts";
import { TARGET_WALL_MS } from "./contract.ts";
import { mad, median } from "./comparison.ts";
import type { BenchmarkShape, ClaudeBenchmarkResult, ModelCall } from "./result-schema.ts";
import { resultHash, verifyResultHash } from "./result-schema.ts";

/** One complete task-to-closed-draft-PR measurement. */
export interface BaselineRun {
  index: number;
  shape: BenchmarkShape;
  fixtureMs: number;
  claudeTaskMs: number;
  versionCheck: "current" | "unknown" | "outdated";
  prMs: number;
  prNumber: number;
  prUrl: string;
  proofBaseRef: string;
  proofRef: string;
  recordedDigest: string;
  prClosed: boolean;
  proofRefRemoved: boolean;
  result: ClaudeBenchmarkResult;
}

/** An immutable, hash-stamped ten-run main baseline. */
export interface BaselineArtifact {
  schemaVersion: 1;
  createdAt: string;
  pluginSha: string;
  sourceSha: string;
  cliVersion: string;
  taskId: string;
  taskVersion: string;
  promptHashes: Record<BenchmarkShape, string>;
  order: BenchmarkShape[];
  concurrency: 2;
  waveSizes: number[];
  waveWallMs: number[];
  preflightMs: number;
  stackSetupMs: number;
  stackTeardownMs: number;
  fullWallMs: number;
  targetMs: number;
  targetMet: boolean;
  shapeWall: Record<BenchmarkShape, { medianMs: number; madMs: number; noiseRatio: number }>;
  shapeANoiseMet: boolean;
  totalCostUsd: number;
  runs: BaselineRun[];
  baselineHash: string;
}

/** Testable one-stack orchestration for balanced benchmark waves. */
export async function orchestrateWaves<T>(waves: readonly (readonly BenchmarkShape[])[], workflow: {
  setup(): Promise<void>;
  run(index: number, shape: BenchmarkShape): Promise<T>;
  teardown(): Promise<void>;
}, now: () => number = Date.now): Promise<{ runs: Array<{ shape: BenchmarkShape; value: T }>;
  setupMs: number; teardownMs: number; fullWallMs: number }> {
  const started = now();
  let setupMs = 0;
  let teardownMs = 0;
  const runs: Array<{ shape: BenchmarkShape; value: T }> = [];
  try {
    await workflow.setup();
    setupMs = now() - started;
    let offset = 0;
    for (const wave of waves) {
      // Wait for every peer before teardown if one run fails mid-wave.
      const settled = await Promise.allSettled(wave.map((shape, position) =>
        workflow.run(offset + position, shape)));
      const failure = settled.find((entry) => entry.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      settled.forEach((entry, position) => {
        if (entry.status === "fulfilled") runs.push({ shape: wave[position], value: entry.value });
      });
      offset += wave.length;
    }
  } finally {
    const teardownStarted = now();
    await workflow.teardown();
    teardownMs = now() - teardownStarted;
  }
  return { runs, setupMs, teardownMs, fullWallMs: now() - started };
}

/** Testable one-stack orchestration with five balanced AB waves. */
export async function orchestrateTen<T>(workflow: {
  setup(): Promise<void>;
  run(index: number, shape: BenchmarkShape): Promise<T>;
  teardown(): Promise<void>;
}, now: () => number = Date.now): Promise<{ runs: Array<{ shape: BenchmarkShape; value: T }>;
  setupMs: number; teardownMs: number; fullWallMs: number }> {
  return orchestrateWaves(BASELINE_WAVES, workflow, now);
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Fix shared setup/teardown allocation and reject any mixed-input baseline. */
export function finalizeBaseline(input: {
  runs: BaselineRun[];
  setupMs: number;
  teardownMs: number;
  preflightMs: number;
  fullWallMs: number;
  pluginSha: string;
  sourceSha: string;
  cliVersion: string;
  createdAt: string;
}): BaselineArtifact {
  if (input.runs.length !== 10 || input.runs.some((run, index) => run.index !== index ||
      run.shape !== BASELINE_ORDER[index] || run.result.identity.shape !== run.shape ||
      !run.prClosed || !run.proofRefRemoved || !run.recordedDigest || run.prNumber <= 0)) {
    throw new Error("benchmark-baseline-run-count-or-pr-state");
  }
  if (new Set(input.runs.map((run) => run.result.identity.id)).size !== 10 ||
      new Set(input.runs.map((run) => run.prNumber)).size !== 10 ||
      new Set(input.runs.map((run) => run.proofRef)).size !== 10 ||
      new Set(input.runs.map((run) => run.proofBaseRef)).size !== 10) {
    throw new Error("benchmark-baseline-duplicate-run-or-proof");
  }
  for (const key of ["setupMs", "teardownMs", "preflightMs", "fullWallMs"] as const) {
    if (!Number.isFinite(input[key]) || input[key] < 0) throw new Error(`benchmark-baseline-${key}-invalid`);
  }
  const taskId = input.runs[0].result.identity.taskId;
  const taskVersion = input.runs[0].result.identity.taskVersion;
  const runs = input.runs.map((run) => {
    verifyResultHash(run.result);
    if (!run.result.valid || !run.result.success || run.result.identity.pluginSha !== input.pluginSha ||
        run.result.identity.fixtureVersion !== input.sourceSha ||
        run.result.identity.cliVersion !== input.cliVersion ||
        run.result.identity.taskId !== taskId || run.result.identity.taskVersion !== taskVersion ||
        run.result.observedEffort !== "high" || run.result.observedModel !== "claude-sonnet-5-5") {
      throw new Error("benchmark-baseline-mixed-or-invalid-run");
    }
    const { resultHash: _oldHash, ...payload } = run.result;
    payload.identity = { ...payload.identity,
      stackSetupMs: input.setupMs / 10, stackTeardownMs: input.teardownMs / 10 };
    return { ...run, result: { ...payload, resultHash: resultHash(payload) } };
  });
  const shapeWall = Object.fromEntries((["vibe", "fleet-one-writer"] as const).map((shape) => {
    const values = runs.filter((run) => run.shape === shape).map((run) => run.result.identity.wallMs);
    const center = median(values);
    const spread = mad(values);
    return [shape, { medianMs: center, madMs: spread, noiseRatio: center > 0 ? spread / center : Infinity }];
  })) as BaselineArtifact["shapeWall"];
  let waveOffset = 0;
  const waveWallMs = BASELINE_WAVES.map((wave) => {
    const maximum = Math.max(...runs.slice(waveOffset, waveOffset + wave.length)
      .map((run) => run.result.identity.wallMs));
    waveOffset += wave.length;
    return maximum;
  });
  const payload: Omit<BaselineArtifact, "baselineHash"> = {
    schemaVersion: 1, createdAt: input.createdAt, pluginSha: input.pluginSha,
    sourceSha: input.sourceSha, cliVersion: input.cliVersion, taskId, taskVersion,
    promptHashes: {
      vibe: hashPayload(shapePrompt("vibe")),
      "fleet-one-writer": hashPayload(shapePrompt("fleet-one-writer")),
    },
    order: [...BASELINE_ORDER], concurrency: 2, waveSizes: BASELINE_WAVES.map((wave) => wave.length),
    waveWallMs,
    preflightMs: input.preflightMs,
    stackSetupMs: input.setupMs, stackTeardownMs: input.teardownMs,
    fullWallMs: input.fullWallMs, targetMs: TARGET_WALL_MS,
    targetMet: input.fullWallMs < TARGET_WALL_MS,
    shapeWall, shapeANoiseMet: shapeWall.vibe.noiseRatio < 0.25,
    totalCostUsd: runs.reduce((sum, run) => sum + run.result.costUsd, 0), runs,
  };
  return { ...payload, baselineHash: hashPayload(payload) };
}

/** Verify the dated artifact before it is reported or compared later. */
export function verifyBaselineHash(baseline: BaselineArtifact): void {
  const { baselineHash, ...payload } = baseline;
  if (!/^[a-f0-9]{64}$/.test(baselineHash) || hashPayload(payload) !== baselineHash) {
    throw new Error("benchmark-baseline-hash-mismatch");
  }
  baseline.runs.forEach((run) => verifyResultHash(run.result));
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const cell = (value: string | number) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
  return `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n` +
    rows.map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n");
}

function facetRows(runs: BaselineRun[], facet: "component" | "skill" | "worker" | "phase"):
  Array<Array<string | number>> {
  const calls = runs.flatMap((run) => run.result.calls);
  const names = [...new Set(calls.map((call) => call[facet] ?? "unobserved"))].sort();
  return names.map((name) => {
    const group: ModelCall[] = calls.filter((call) => (call[facet] ?? "unobserved") === name);
    const sum = (key: "uncachedInputTokens" | "cachedInputTokens" | "outputTokens"): string | number =>
      group.some((call) => call.tokens?.[key] === null || call.tokens == null) ? "unknown" :
        group.reduce((total, call) => total + (call.tokens?.[key] ?? 0), 0);
    return [name, group.length, sum("uncachedInputTokens"), sum("cachedInputTokens"), sum("outputTokens")];
  });
}

/** Render all ten runs and the measured drivers without fabricating call cost. */
export function buildBaselineReport(baseline: BaselineArtifact): string {
  verifyBaselineHash(baseline);
  const runs = baseline.runs;
  const taskMs = runs.reduce((sum, run) => sum + run.claudeTaskMs, 0);
  const prMs = runs.reduce((sum, run) => sum + run.prMs, 0);
  const fixtureMs = runs.reduce((sum, run) => sum + run.fixtureMs, 0);
  const otherMs = runs.reduce((sum, run) => sum + run.result.identity.wallMs - run.claudeTaskMs - run.prMs - run.fixtureMs, 0);
  const drivers = [
    ["snapshot and preflight", baseline.preflightMs], ["stack setup", baseline.stackSetupMs],
    ["Claude task", taskMs], ["draft PR lifecycle", prMs],
    ["fixture creation", fixtureMs], ["other per-run", otherMs], ["stack teardown", baseline.stackTeardownMs],
  ].sort((a, b) => Number(b[1]) - Number(a[1]));
  const wavePathMs = baseline.waveWallMs.reduce((sum, value) => sum + value, 0);
  const lines = [
    "# ISS-13401 Claude Code main baseline", "",
    `Created ${baseline.createdAt}; baseline hash \`${baseline.baselineHash}\`.`,
    `Plugin ${baseline.pluginSha}; symphony-alpha fixture ${baseline.sourceSha}; Claude Code ${baseline.cliVersion}.`,
    `Task ${baseline.taskId} (${baseline.taskVersion}); shape prompts ${JSON.stringify(baseline.promptHashes)}.`,
    `Order ${baseline.order.map((shape) => shape === "vibe" ? "A" : "B").join(" ")}; waves ${baseline.waveSizes.join("/")}; concurrency ${baseline.concurrency}.`,
    `Full wall ${baseline.fullWallMs} ms; fixed target ${baseline.targetMs} ms: ${baseline.targetMet ? "met" : "missed"}.`,
    `Setup ${baseline.stackSetupMs} ms, teardown ${baseline.stackTeardownMs} ms, total cost $${baseline.totalCostUsd.toFixed(6)}.`,
    `Balanced-wave maxima sum to ${wavePathMs} ms; shared preflight/setup/teardown and scheduler overhead account for the rest of the full wall.`,
    "Cached input is informational and has no independent threshold.",
    "Local fixture adapter: each fake-origin checkout gets the plugin's private session record, with no live ticket, operator, Vercel destination or Desktop. The plugin's real version check runs inside each measured task.", "",
    "## Every run", "",
    table(["#", "shape", "success", "wall ms", "setup alloc ms", "teardown alloc ms", "version check", "input",
      "cached input", "cache write", "output", "calls", "cost USD", "model / effort", "CLI", "plugin SHA", "PR", "result hash"],
    runs.map((run) => [run.index + 1, run.shape, String(run.result.success), run.result.identity.wallMs,
      run.result.identity.stackSetupMs, run.result.identity.stackTeardownMs, run.versionCheck,
      run.result.totals.uncachedInputTokens, run.result.totals.cachedInputTokens,
      run.result.totals.cacheWriteTokens, run.result.totals.outputTokens,
      run.result.modelCalls, run.result.costUsd.toFixed(6),
      `${run.result.observedModel} / ${run.result.observedEffort}`, run.result.identity.cliVersion,
      run.result.identity.pluginSha, `#${run.prNumber} closed; refs removed`, run.result.resultHash])),
    "", "## Shape wall and noise", "",
    table(["shape", "median ms", "MAD ms", "MAD / median"],
      (["vibe", "fleet-one-writer"] as const).map((shape) => [shape,
        baseline.shapeWall[shape].medianMs, baseline.shapeWall[shape].madMs,
        baseline.shapeWall[shape].noiseRatio.toFixed(4)])),
    `Shape A noise criterion: ${baseline.shapeANoiseMet ? "met" : "failed; replace task and repeat"}.`,
    "", "## Balanced wave wall", "", table(["wave", "wall ms"],
      baseline.waveWallMs.map((value, index) => [index + 1, value])),
    "", "## Aggregate measured work", "",
    "Peer-run durations overlap, so these component sums are not additive to full batch wall.", "",
    table(["component", "aggregate process ms"], drivers),
  ];
  for (const facet of ["component", "skill", "worker", "phase"] as const) {
    lines.push("", `## ${facet[0].toUpperCase()}${facet.slice(1)} totals`, "",
      table([facet, "calls", "uncached input", "cached input", "output"], facetRows(runs, facet)));
  }
  lines.push("", "Component output and dollars are unknown without reconciled request-level OTEL; run totals above come from Claude's final result.", "");
  return lines.join("\n");
}
