import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finalizeBaseline, buildBaselineReport } from "./baseline.ts";
import type { BaselineArtifact, BaselineRun } from "./baseline.ts";
import { runClaudeBatch } from "./claude-batch.ts";
import { resolveLatestEvalBaseline } from "./eval-baseline.ts";
export { sourceMain } from "./claude-batch.ts";

/** Exact Phase 2 entry inputs; no installed plugin or convenience env override. */
export interface Phase2Inputs {
  symphonyCheckout: string;
  claudePluginsRepo: string;
  expectedPluginSha: string;
  runRoot: string;
  outputDir: string;
  claudeExecutable: string;
  ghExecutable: string;
}

/** Tie every on-demand benchmark baseline to the latest accepted nightly. */
export function requireLatestNightlyBenchmarkBaseline(expectedPluginSha: string,
  nightlyStore: string): void {
  const latest = resolveLatestEvalBaseline(nightlyStore).artifact;
  if (latest.pluginSha !== expectedPluginSha) {
    throw new Error(`benchmark-baseline-not-latest-nightly:${latest.pluginSha}`);
  }
}

/** Run six isolated Claude tasks on one owned stack and close every proof PR. */
export async function runPhase2Baseline(input: Phase2Inputs): Promise<{ baseline: BaselineArtifact;
  jsonFile: string; reportFile: string }> {
  const measured = await runClaudeBatch({ ...input, snapshotMode: "main",
    waves: Array.from({ length: 3 }, () => ["vibe", "fleet-one-writer"] as const) });
  const baseline = finalizeBaseline({ runs: measured.runs,
    setupMs: measured.setupMs, teardownMs: measured.teardownMs,
    preflightMs: measured.preflightMs, fullWallMs: measured.fullWallMs,
    pluginSha: measured.pluginSha, sourceSha: measured.sourceSha,
    cliVersion: measured.cliVersion, createdAt: new Date().toISOString() });
  const outputDir = resolve(input.outputDir);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  const stem = `${new Date().toISOString().slice(0, 10)}-main-${measured.pluginSha.slice(0, 12)}-${measured.batchId}`;
  const jsonFile = join(outputDir, `${stem}.json`);
  const reportFile = join(outputDir, `${stem}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
  writeFileSync(reportFile, buildBaselineReport(baseline), { flag: "wx" });
  appendFileSync(join(outputDir, "measurement-log.md"), `\n## ${new Date().toISOString()}: ${stem}\n\n` +
    `Command: phase2 baseline CLI with source ${measured.sourceSha}, plugin ${measured.pluginSha}, Claude ${measured.cliVersion}, ` +
    `order ${baseline.order.map((shape) => shape === "vibe" ? "A" : "B").join(" ")}, ` +
    `waves ${baseline.waveSizes.join("/")}, concurrency ${baseline.concurrency}.\n` +
    `Every run (ms): ${baseline.runs.map((run) => `${run.index + 1}:${run.shape}:${run.result.identity.wallMs}`).join("; ")}.\n` +
    `Full wall ${baseline.fullWallMs} ms; A median/MAD ${baseline.shapeWall.vibe.medianMs}/${baseline.shapeWall.vibe.madMs} ms; ` +
    `B median/MAD ${baseline.shapeWall["fleet-one-writer"].medianMs}/${baseline.shapeWall["fleet-one-writer"].madMs} ms.\n` +
    `Verdict: ${baseline.targetMet && baseline.shapeANoiseMet ? "BASELINE ACCEPTED" : "TARGET OR NOISE MISSED"}. ` +
    `Immutable artifact: ${stem}.json (SHA-256 ${baseline.baselineHash}).\n` +
    `Measured: six task-to-closed-PR runs and shared setup/teardown. Not measured: model-driven evals. ` +
    `Re-check if task, source, plugin, model, effort, CLI or machine conditions change.\n`);
  return { baseline, jsonFile, reportFile };
}
