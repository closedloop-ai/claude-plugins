import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareResults } from "./comparison.ts";
import type { RegressionExplanation } from "./report.ts";
import type { Signal } from "./comparison.ts";
import { collectLocalProbe, runLocalClaude } from "./driver.ts";
import { buildReport } from "./report.ts";
import { requireLatestNightlyBenchmarkBaseline, runPhase2Baseline } from "./phase2-driver.ts";
import type { BaselineArtifact } from "./baseline.ts";
import type { ClaudeBenchmarkResult } from "./result-schema.ts";
import type { BenchmarkShape } from "./result-schema.ts";
import { runLocalEvals, runT2Evals } from "./eval-driver.ts";
import { requireDeveloperMachine } from "./eval-policy.ts";
import { evalChangedFiles } from "./eval-selection.ts";
import { classifyVibeWorkingTreeScope } from "./vibe-change-scope.ts";

function readResults(path: string, shape: BenchmarkShape): ClaudeBenchmarkResult[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  const results = Array.isArray(value) ? value as ClaudeBenchmarkResult[]
    : Array.isArray((value as Partial<BaselineArtifact>).runs)
      ? (value as BaselineArtifact).runs.map((run) => run.result)
      : null;
  if (!results) throw new Error("benchmark-results-array-or-batch-required");
  const selected = results.filter((result) => result.identity.shape === shape);
  if (selected.length < 3) throw new Error(`benchmark-shape-sample-missing:${shape}`);
  return selected;
}

/** Local-only CLI; comparison requires explicit human explanations for regressions. */
export async function main(args: string[]): Promise<string> {
  const [command, ...rest] = args;
  if (["run-local", "baseline", "eval-local", "eval-t2"].includes(command ?? "")) {
    requireDeveloperMachine();
  }
  if (command === "collect" && (rest.length >= 3 && rest.length <= 5)) {
    const output = collectLocalProbe(rest[0], rest[1], rest[2], rest[3], rest[4]);
    return `${output.jsonFile}\n${output.markdownFile}`;
  }
  if (command === "run-local" && (rest.length >= 4 && rest.length <= 6)) {
    const output = await runLocalClaude(rest[0], rest[1], rest[2], rest[3], rest[4], rest[5]);
    return `${output.jsonFile}\n${output.markdownFile}`;
  }
  if (command === "compare" && (rest.length === 6 || rest.length === 7)) {
    const [baselineFile, candidateFile, baseWordsRaw, candidateWordsRaw, outputDir,
      shapeRaw, explanationFile] = rest;
    if (shapeRaw !== "vibe" && shapeRaw !== "fleet-one-writer") {
      throw new Error("benchmark-shape-invalid");
    }
    const baselineWords = Number(baseWordsRaw);
    const candidateWords = Number(candidateWordsRaw);
    const baseline = readResults(baselineFile, shapeRaw);
    const candidate = readResults(candidateFile, shapeRaw);
    const comparison = compareResults(baseline, candidate,
      { baseline: baselineWords, candidate: candidateWords });
    const explanations = explanationFile
      ? JSON.parse(readFileSync(explanationFile, "utf8")) as Partial<Record<Signal, RegressionExplanation>> : {};
    const report = buildReport(candidate[candidate.length - 1], comparison, explanations);
    const jsonFile = join(outputDir, "phase1-comparison.json");
    const markdownFile = join(outputDir, "phase1-comparison.md");
    writeFileSync(jsonFile, `${JSON.stringify(comparison, null, 2)}\n`, { flag: "wx" });
    writeFileSync(markdownFile, report, { flag: "wx" });
    return `${jsonFile}\n${markdownFile}`;
  }
  if (command === "baseline" && rest.length === 8) {
    requireLatestNightlyBenchmarkBaseline(rest[2], rest[7]);
    const output = await runPhase2Baseline({
      symphonyCheckout: rest[0], claudePluginsRepo: rest[1], expectedPluginSha: rest[2],
      runRoot: rest[3], outputDir: rest[4], claudeExecutable: rest[5], ghExecutable: rest[6],
    });
    return `${output.jsonFile}\n${output.reportFile}`;
  }
  if (command === "eval-local" && rest.length >= 8) {
    const mode = rest[7];
    if (mode !== "full" && mode !== "deterministic") throw new Error("eval-mode-invalid");
    const output = await runLocalEvals({ repo: rest[0], pluginSha: rest[1], runRoot: rest[2],
      outputDir: rest[3], claudeExecutable: rest[4], codexExecutable: rest[5],
      uvExecutable: rest[6], deterministicOnly: mode === "deterministic",
      selectedCases: rest.slice(8) });
    return `${output.jsonFile}\n${output.reportFile}`;
  }
  if (command === "eval-scope" && rest.length === 2) {
    return JSON.stringify(classifyVibeWorkingTreeScope(rest[0], rest[1],
      evalChangedFiles(rest[0], rest[1])), null, 2);
  }
  if (command === "eval-t2" && rest.length === 8) {
    const output = await runT2Evals({ repo: rest[0], pluginSha: rest[1], runRoot: rest[2],
      outputDir: rest[3], claudeExecutable: rest[4], codexExecutable: rest[5],
      uvExecutable: rest[6], ghExecutable: rest[7] });
    if (output.skipped) return `SKIPPED ${output.jsonFile}`;
    return output.lineageReset
      ? `NEW_LINEAGE ${output.lineageReason}\n${output.jsonFile}` : output.jsonFile;
  }
  throw new Error("usage: cli.ts collect <phase0-result> <plugin-dir> <claude> [otel-jsonl] [transcript-manifest] | run-local <symphony-checkout> <sandbox> <plugin-dir> <claude> [otel-jsonl] [transcript-manifest] | compare <baseline-results-or-batch-json> <candidate-results-or-batch-json> <base-words> <candidate-words> <output-dir> <vibe-or-fleet-one-writer> [explanations-json] | baseline <symphony-checkout> <claude-plugins-repo> <pinned-plugin-sha> <empty-run-root> <output-dir> <claude> <gh> <nightly-results-store> | eval-scope <claude-plugins-repo> <base-ref> | eval-local <claude-plugins-repo> <full-branch-sha> <empty-run-root> <output-dir> <claude> <codex> <uv> <full-or-deterministic> [case ...] | eval-t2 <clean-main-repo> <sha> <empty-run-root> <results-store> <claude> <codex> <uv> <gh>");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (output) => process.stdout.write(`${output}\n`),
    (error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; },
  );
}
