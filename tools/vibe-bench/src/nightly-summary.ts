import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Scheduled-task outcome derived from one wrapper execution. */
export type NightlyTaskResult = "SKIPPED" | "RAN" | "FAILED";

/** Stable machine-readable result consumed by the local ChatGPT scheduled task. */
export interface NightlyTaskSummary {
  result: NightlyTaskResult;
  passed: number;
  failed: number;
  posted: "yes" | "no";
  path: string;
  failure: string | null;
}

function artifactCounts(path: string): { passed: number; failed: number } {
  const artifact = JSON.parse(readFileSync(path, "utf8")) as {
    cases?: Array<{ outcomes?: Record<string, { recentNightlyOutcomes?: Array<{
      passes?: unknown; runs?: unknown;
    }> }> }>;
  };
  if (!Array.isArray(artifact.cases)) throw new Error("nightly-summary-artifact-invalid");
  return artifact.cases.reduce((total, item) => {
    for (const outcome of Object.values(item.outcomes ?? {})) {
      const latest = outcome.recentNightlyOutcomes?.at(-1);
      if (!latest || typeof latest.passes !== "number" || typeof latest.runs !== "number" ||
          latest.passes < 0 || latest.runs < latest.passes) continue;
      total.passed += latest.passes;
      total.failed += latest.runs - latest.passes;
    }
    return total;
  }, { passed: 0, failed: 0 });
}

function artifactPath(lines: string[]): string | null {
  for (const line of [...lines].reverse()) {
    const candidate = line.startsWith("SKIPPED ") ? line.slice("SKIPPED ".length) : line;
    if (candidate.startsWith("/") && candidate.endsWith(".json")) return candidate;
  }
  return null;
}

/** Convert one wrapper log and exit status into the task's final summary line. */
export function nightlyTaskSummary(exitCode: number, output: string, logPath: string): NightlyTaskSummary {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const failures = lines.filter((line) => /^VIBE_NIGHTLY_(?:INFRA|SLACK)_FAILURE\b/.test(line));
  const artifact = artifactPath(lines);
  const skipped = lines.some((line) => line.startsWith("SKIPPED "));
  const posted = lines.includes("VIBE_NIGHTLY_SLACK_POSTED") ? "yes" : "no";
  let failure = failures.at(-1) ?? (exitCode === 0 ? null
    : `VIBE_NIGHTLY_INFRA_FAILURE nightly process exited with status ${exitCode}`);
  let result: NightlyTaskResult = exitCode === 0 && !failure ? (skipped ? "SKIPPED" : "RAN") : "FAILED";
  let counts = { passed: 0, failed: 0 };
  if (result === "RAN" && artifact) {
    try { counts = artifactCounts(artifact); }
    catch { failure = "VIBE_NIGHTLY_INFRA_FAILURE nightly summary artifact is unreadable"; }
  } else if (result === "RAN") {
    failure = "VIBE_NIGHTLY_INFRA_FAILURE nightly summary artifact is missing";
  }
  if (failure) result = "FAILED";
  return { result, ...counts, posted, path: artifact ?? logPath, failure };
}

/** Render exactly one line for robust extraction from a scheduled-task transcript. */
export function formatNightlyTaskSummary(summary: NightlyTaskSummary): string {
  return `VIBE_NIGHTLY_SUMMARY ${JSON.stringify(summary)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [rawExitCode, logPath] = process.argv.slice(2);
  const exitCode = Number(rawExitCode);
  if (!Number.isInteger(exitCode) || exitCode < 0 || !logPath) {
    throw new Error("usage: nightly-summary.ts <exit-code> <log-file>");
  }
  const output = readFileSync(logPath, "utf8");
  process.stdout.write(`${formatNightlyTaskSummary(nightlyTaskSummary(exitCode, output, logPath))}\n`);
}
