import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BaselineArtifact, BaselineRun } from "./baseline.ts";
import { verifyBaselineHash } from "./baseline.ts";
import { runClaudeBatch } from "./claude-batch.ts";
import type { Comparison, ThresholdStatus } from "./comparison.ts";
import { compareResults } from "./comparison.ts";
import { TARGET_WALL_MS } from "./contract.ts";
import { verifyResultHash } from "./result-schema.ts";
import type { BenchmarkShape } from "./result-schema.ts";

/** The three balanced pairs used by every developer benchmark. */
export const DEVELOPER_WAVES = Array.from({ length: 3 }, () =>
  ["vibe", "fleet-one-writer"] as const);

/** Selected pull request identity fixed before any paid work starts. */
export interface SelectedPullRequest {
  number: number;
  url: string;
  branch: string;
  headSha: string;
}

/** Immutable six-run candidate artifact compared with the accepted baseline. */
export interface DeveloperBenchmarkArtifact {
  schemaVersion: 1;
  createdAt: string;
  selectedPr: SelectedPullRequest;
  baselineHash: string;
  baselinePluginSha: string;
  pluginSha: string;
  sourceSha: string;
  cliVersion: string;
  order: BenchmarkShape[];
  concurrency: 2;
  waveSizes: number[];
  preflightMs: number;
  stackSetupMs: number;
  stackTeardownMs: number;
  fullWallMs: number;
  targetMs: number;
  targetMet: boolean;
  instructionWords: { baseline: number; pr: number };
  comparisons: Record<BenchmarkShape, Comparison>;
  status: ThresholdStatus;
  totalCostUsd: number;
  runs: BaselineRun[];
  resultHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Count all Markdown instruction words under plugins/vibe at an exact Git ref. */
export function instructionWordsAtRef(repo: string, ref: string): number {
  const files = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", ref, "--", "plugins/vibe"],
    { encoding: "utf8" }).trim().split("\n").filter((path) => path.endsWith(".md"));
  if (!files.length) throw new Error("benchmark-instruction-files-missing");
  return files.reduce((total, path) => total + execFileSync("git", ["-C", repo, "show", `${ref}:${path}`],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).split(/\s+/).filter(Boolean).length, 0);
}

function validatedRuns(input: { runs: BaselineRun[] }): BaselineRun[] {
  return input.runs.map((run) => {
    verifyResultHash(run.result);
    if (run.recordedDigest !== run.result.resultHash) throw new Error("benchmark-recorded-digest-mismatch");
    return run;
  });
}

/** Validate, compare and hash exactly three samples per shape. */
export function finalizeDeveloperBenchmark(input: {
  selectedPr: SelectedPullRequest;
  baseline: BaselineArtifact;
  runs: BaselineRun[];
  setupMs: number;
  teardownMs: number;
  preflightMs: number;
  fullWallMs: number;
  sourceSha: string;
  pluginSha: string;
  cliVersion: string;
  instructionWords: { baseline: number; pr: number };
  createdAt: string;
}): DeveloperBenchmarkArtifact {
  verifyBaselineHash(input.baseline);
  const expected = DEVELOPER_WAVES.flat();
  if (!/^[a-f0-9]{40}$/.test(input.selectedPr.headSha) || input.selectedPr.headSha !== input.pluginSha ||
      input.selectedPr.number <= 0 || input.runs.length !== 6 || input.runs.some((run, index) =>
        run.index !== index || run.shape !== expected[index] || run.result.identity.shape !== run.shape ||
        !run.prClosed || !run.proofRefRemoved || !run.recordedDigest || run.prNumber <= 0)) {
    throw new Error("benchmark-developer-run-or-pr-state");
  }
  if (input.baseline.sourceSha !== input.sourceSha || input.baseline.cliVersion !== input.cliVersion ||
      new Set(input.runs.map((run) => run.result.identity.id)).size !== 6 ||
      new Set(input.runs.map((run) => run.prNumber)).size !== 6 ||
      new Set(input.runs.map((run) => run.proofRef)).size !== 6 ||
      new Set(input.runs.map((run) => run.proofBaseRef)).size !== 6) {
    throw new Error("benchmark-developer-identity-or-proof-drift");
  }
  const runs = validatedRuns(input);
  for (const run of runs) {
    if (!run.result.valid || run.result.identity.pluginSha !== input.pluginSha ||
        run.result.identity.fixtureVersion !== input.sourceSha || run.result.identity.cliVersion !== input.cliVersion) {
      throw new Error("benchmark-developer-invalid-run");
    }
  }
  const comparisons = Object.fromEntries((["vibe", "fleet-one-writer"] as const).map((shape) => [shape,
    compareResults(input.baseline.runs.filter((run) => run.shape === shape).map((run) => run.result),
      runs.filter((run) => run.shape === shape).map((run) => run.result), input.instructionWords),
  ])) as Record<BenchmarkShape, Comparison>;
  const status: ThresholdStatus = Object.values(comparisons).some((item) => item.status === "red") ? "red"
    : Object.values(comparisons).some((item) => item.status === "yellow") ? "yellow" : "green";
  const payload: Omit<DeveloperBenchmarkArtifact, "resultHash"> = {
    schemaVersion: 1, createdAt: input.createdAt, selectedPr: input.selectedPr,
    baselineHash: input.baseline.baselineHash, baselinePluginSha: input.baseline.pluginSha,
    pluginSha: input.pluginSha, sourceSha: input.sourceSha, cliVersion: input.cliVersion,
    order: [...expected], concurrency: 2, waveSizes: DEVELOPER_WAVES.map((wave) => wave.length),
    preflightMs: input.preflightMs, stackSetupMs: input.setupMs, stackTeardownMs: input.teardownMs,
    fullWallMs: input.fullWallMs, targetMs: TARGET_WALL_MS, targetMet: input.fullWallMs < TARGET_WALL_MS,
    instructionWords: input.instructionWords, comparisons, status,
    totalCostUsd: runs.reduce((sum, run) => sum + run.result.costUsd, 0), runs,
  };
  return { ...payload, resultHash: hash(payload) };
}

/** Reject a changed developer artifact before rendering or publishing it. */
export function verifyDeveloperBenchmarkHash(result: DeveloperBenchmarkArtifact): void {
  const { resultHash, ...payload } = result;
  if (!/^[a-f0-9]{64}$/.test(resultHash) || hash(payload) !== resultHash) {
    throw new Error("benchmark-developer-hash-mismatch");
  }
  result.runs.forEach((run) => verifyResultHash(run.result));
}

/** Run the selected head's six samples and persist the immutable result. */
export async function runDeveloperBenchmark(input: {
  selectedPr: SelectedPullRequest;
  baselineFile: string;
  symphonyCheckout: string;
  claudePluginsRepo: string;
  runRoot: string;
  outputDir: string;
  claudeExecutable: string;
  ghExecutable: string;
}): Promise<{ result: DeveloperBenchmarkArtifact; jsonFile: string }> {
  const baseline = JSON.parse(readFileSync(input.baselineFile, "utf8")) as BaselineArtifact;
  const batch = await runClaudeBatch({ symphonyCheckout: input.symphonyCheckout,
    claudePluginsRepo: input.claudePluginsRepo, expectedPluginSha: input.selectedPr.headSha,
    snapshotMode: "head", waves: DEVELOPER_WAVES, runRoot: input.runRoot,
    claudeExecutable: input.claudeExecutable, ghExecutable: input.ghExecutable });
  const result = finalizeDeveloperBenchmark({ selectedPr: input.selectedPr, baseline, runs: batch.runs,
    setupMs: batch.setupMs, teardownMs: batch.teardownMs, preflightMs: batch.preflightMs,
    fullWallMs: batch.fullWallMs, sourceSha: batch.sourceSha, pluginSha: batch.pluginSha,
    cliVersion: batch.cliVersion, createdAt: new Date().toISOString(), instructionWords: {
      baseline: instructionWordsAtRef(input.claudePluginsRepo, baseline.pluginSha),
      pr: instructionWordsAtRef(input.claudePluginsRepo, input.selectedPr.headSha),
    } });
  const outputDir = resolve(input.outputDir);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const jsonFile = join(outputDir, `benchmark-pr-${input.selectedPr.number}-${result.resultHash.slice(0, 12)}.json`);
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return { result, jsonFile };
}
