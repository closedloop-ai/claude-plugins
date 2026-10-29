import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareResults } from "./comparison.ts";
import type { RegressionExplanation } from "./report.ts";
import type { Signal } from "./comparison.ts";
import { collectLocalProbe, runLocalClaude } from "./driver.ts";
import { buildReport } from "./report.ts";
import { runPhase2Baseline } from "./phase2-driver.ts";
import type { ClaudeBenchmarkResult } from "./result-schema.ts";
import { runLocalEvals } from "./eval-driver.ts";
import { evalCaseIds } from "./eval-driver.ts";
import { runDeveloperBenchmark } from "./developer-benchmark.ts";
import type { DeveloperBenchmarkArtifact } from "./developer-benchmark.ts";
import { buildBenchmarkEvidence, buildDeveloperReport } from "./developer-report.ts";
import type { DeveloperExplanations } from "./developer-report.ts";
import { listOpenPullRequests, preflightSelectedPullRequest, publishBenchmarkSection } from "./developer-pr.ts";
import type { LocalEvalResult } from "./eval-collector.ts";

function readResults(path: string): ClaudeBenchmarkResult[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value)) throw new Error("benchmark-results-array-required");
  return value as ClaudeBenchmarkResult[];
}

/** Local-only CLI; comparison requires explicit human explanations for regressions. */
export async function main(args: string[]): Promise<string> {
  const [command, ...rest] = args;
  if (command === "collect" && (rest.length >= 3 && rest.length <= 5)) {
    const output = collectLocalProbe(rest[0], rest[1], rest[2], rest[3], rest[4]);
    return `${output.jsonFile}\n${output.markdownFile}`;
  }
  if (command === "run-local" && (rest.length >= 4 && rest.length <= 6)) {
    const output = await runLocalClaude(rest[0], rest[1], rest[2], rest[3], rest[4], rest[5]);
    return `${output.jsonFile}\n${output.markdownFile}`;
  }
  if (command === "compare" && (rest.length === 5 || rest.length === 6)) {
    const [baselineFile, prFile, baseWordsRaw, prWordsRaw, outputDir, explanationFile] = rest;
    const baselineWords = Number(baseWordsRaw);
    const prWords = Number(prWordsRaw);
    const baseline = readResults(baselineFile);
    const pr = readResults(prFile);
    const comparison = compareResults(baseline, pr, { baseline: baselineWords, pr: prWords });
    const explanations = explanationFile
      ? JSON.parse(readFileSync(explanationFile, "utf8")) as Partial<Record<Signal, RegressionExplanation>> : {};
    const report = buildReport(pr[pr.length - 1], comparison, explanations);
    const jsonFile = join(outputDir, "phase1-comparison.json");
    const markdownFile = join(outputDir, "phase1-comparison.md");
    writeFileSync(jsonFile, `${JSON.stringify(comparison, null, 2)}\n`, { flag: "wx" });
    writeFileSync(markdownFile, report, { flag: "wx" });
    return `${jsonFile}\n${markdownFile}`;
  }
  if (command === "baseline" && rest.length === 7) {
    const output = await runPhase2Baseline({
      symphonyCheckout: rest[0], claudePluginsRepo: rest[1], expectedPluginSha: rest[2],
      runRoot: rest[3], outputDir: rest[4], claudeExecutable: rest[5], ghExecutable: rest[6],
    });
    return `${output.jsonFile}\n${output.reportFile}`;
  }
  if (command === "eval-local" && rest.length >= 8) {
    const mode = rest[7];
    if (mode !== "full" && mode !== "deterministic") throw new Error("eval-mode-invalid");
    const output = runLocalEvals({ repo: rest[0], pluginSha: rest[1], runRoot: rest[2],
      outputDir: rest[3], claudeExecutable: rest[4], codexExecutable: rest[5],
      pythonExecutable: rest[6], deterministicOnly: mode === "deterministic",
      selectedCases: rest.slice(8) });
    if (!output.result.success) {
      throw new Error(`eval-failed:${output.jsonFile}:${output.reportFile}`);
    }
    return `${output.jsonFile}\n${output.reportFile}`;
  }
  if (command === "pr-list" && rest.length === 2) {
    return JSON.stringify(listOpenPullRequests(rest[0], undefined, rest[1]), null, 2);
  }
  if (command === "pr-run" && rest.length === 8) {
    const selected = preflightSelectedPullRequest(rest[0], Number(rest[1]), undefined, rest[7]);
    const output = await runDeveloperBenchmark({ selectedPr: selected, baselineFile: rest[2],
      symphonyCheckout: rest[3], claudePluginsRepo: rest[0], runRoot: rest[4], outputDir: rest[5],
      claudeExecutable: rest[6], ghExecutable: rest[7] });
    return output.jsonFile;
  }
  if (command === "pr-publish" && (rest.length === 6 || rest.length === 7)) {
    const [repo, numberRaw, benchmarkFile, evalFile, sectionFile, gh, explanationFile] = rest;
    const selected = preflightSelectedPullRequest(repo, Number(numberRaw), undefined, gh);
    const benchmark = JSON.parse(readFileSync(benchmarkFile, "utf8")) as DeveloperBenchmarkArtifact;
    const evaluation = JSON.parse(readFileSync(evalFile, "utf8")) as LocalEvalResult;
    if (benchmark.selectedPr.number !== selected.number || benchmark.selectedPr.headSha !== selected.headSha) {
      throw new Error("benchmark-pr-artifact-selection-mismatch");
    }
    const explanations = explanationFile
      ? JSON.parse(readFileSync(explanationFile, "utf8")) as DeveloperExplanations : {};
    const section = buildDeveloperReport(benchmark, evaluation,
      evalCaseIds(join(repo, "plugins/vibe")), explanations);
    writeFileSync(sectionFile, section, { flag: "wx" });
    publishBenchmarkSection(repo, selected, sectionFile, buildBenchmarkEvidence(benchmark, evaluation), undefined, gh);
    if (benchmark.status === "red") throw new Error(`benchmark-red-blocked:${sectionFile}`);
    return sectionFile;
  }
  throw new Error("usage: cli.ts collect <phase0-result> <plugin-dir> <claude> [otel-jsonl] [transcript-manifest] | run-local <symphony-checkout> <sandbox> <plugin-dir> <claude> [otel-jsonl] [transcript-manifest] | compare <five-baseline-json> <three-pr-json> <base-words> <pr-words> <output-dir> [explanations-json] | baseline <symphony-checkout> <claude-plugins-repo> <pinned-plugin-sha> <empty-run-root> <output-dir> <claude> <gh> | eval-local <claude-plugins-repo> <full-branch-sha> <empty-run-root> <output-dir> <claude> <codex> <python> <full|deterministic> [case ...] | pr-list <claude-plugins-repo> <gh> | pr-run <claude-plugins-repo> <pr-number> <baseline-json> <symphony-checkout> <empty-run-root> <output-dir> <claude> <gh> | pr-publish <claude-plugins-repo> <pr-number> <benchmark-json> <eval-json> <section-output> <gh> [explanations-json]");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (output) => process.stdout.write(`${output}\n`),
    (error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; },
  );
}
