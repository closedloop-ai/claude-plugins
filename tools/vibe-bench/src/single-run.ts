import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaselineRun } from "./baseline.ts";
import { runClaudeTask } from "./claude-task.ts";
import { collectClaude } from "./claude-collector.ts";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK, requirePinnedClaude } from "./contract.ts";
import { discoverRunTranscripts } from "./driver.ts";
import { prepareFixture } from "./fixture.ts";
import { GithubProofPr, ProcessPrCommands } from "./github-pr.ts";
import type { PublishedProof } from "./github-pr.ts";
import type { PluginSnapshot } from "./plugin-snapshot.ts";
import type { BenchmarkShape, ClaudeRunIdentity } from "./result-schema.ts";

/** One child owns one fake checkout, Claude conversation, draft PR and cleanup. */
export interface SingleRunInput {
  index: number;
  shape: BenchmarkShape;
  source: string;
  sourceSha: string;
  snapshot: PluginSnapshot;
  apiKeyFile: string;
  claudeExecutable: string;
  ghExecutable: string;
  cliVersion: string;
  batchId: string;
  runDir: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trimEnd();
}

function identity(input: SingleRunInput, id: string, startedAt: string,
  wallMs: number, complete: boolean, prComplete: boolean): ClaudeRunIdentity {
  return {
    id, shape: input.shape, pluginSha: input.snapshot.sha,
    taskId: BENCHMARK_TASK.id,
    taskVersion: createHash("sha256").update(JSON.stringify(BENCHMARK_TASK)).digest("hex"),
    fixtureVersion: input.sourceSha, cliVersion: input.cliVersion,
    configuredModel: BENCHMARK_MODEL, configuredEffort: BENCHMARK_EFFORT,
    startedAt, stackSetupMs: 0, stackTeardownMs: 0, wallMs,
    oraclePassed: complete, noOutOfScopeEdits: complete,
    taskComplete: complete, prDraftRecordedAndClosed: prComplete,
  };
}

/** Measure and persist one complete run; failure cleanup is confined to its PR. */
export async function runBaselineOne(input: SingleRunInput): Promise<BaselineRun> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const runId = randomUUID();
  let fixture: ReturnType<typeof prepareFixture> | null = null;
  let proof: PublishedProof | null = null;
  const prAdapter = new GithubProofPr(new ProcessPrCommands(), input.ghExecutable);
  try {
    requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
    if (git(input.source, "rev-parse", "HEAD") !== input.sourceSha ||
        execFileSync(input.claudeExecutable, ["--version"], { encoding: "utf8" }).trim() !== input.cliVersion) {
      throw new Error("benchmark-run-source-or-cli-drift");
    }
    const key = JSON.parse(readFileSync(input.apiKeyFile, "utf8")) as { apiBearer?: string };
    if (!key.apiBearer) throw new Error("benchmark-seed-key-missing");
    const fixtureStarted = Date.now();
    fixture = prepareFixture(input.source, input.runDir);
    const fixtureMs = Date.now() - fixtureStarted;
    if (fixture.sourceSha !== input.sourceSha) throw new Error("benchmark-fixture-source-drift");
    const task = await runClaudeTask(fixture, input.snapshot, key.apiBearer,
      input.claudeExecutable, input.cliVersion, input.shape, input.runDir);
    const transcripts = discoverRunTranscripts(task.sessionId, fixture.agentCheckout);
    const changed = git(fixture.agentCheckout, "status", "--porcelain")
      .split("\n").filter(Boolean).map((line) => line.slice(3));
    const taskComplete = changed.length === 1 && changed[0] === BENCHMARK_TASK.file && task.oracleAfter;
    const provisional = collectClaude({ stream: task.stream, transcripts,
      identity: identity(input, runId, startedAt, Date.now() - started, taskComplete, false),
      agentModels: input.snapshot.agentModels });
    if (!provisional.valid || !taskComplete || !provisional.calls.some((call) =>
      call.component === "vibe" && call.worker === "vibe-change-worker")) {
      throw new Error(`benchmark-run-collector-or-worker-invalid:${provisional.invalidReasons.join(",")}`);
    }
    const prStarted = Date.now();
    proof = prAdapter.publish(fixture, input.runDir, `${input.batchId}-${input.index + 1}`);
    prAdapter.record(proof, provisional.resultHash, input.runDir, fixture.agentCheckout);
    prAdapter.close(proof, fixture.agentCheckout);
    const prMs = Date.now() - prStarted;
    const result = collectClaude({ stream: task.stream, transcripts,
      identity: identity(input, runId, startedAt, Date.now() - started, taskComplete, true),
      agentModels: input.snapshot.agentModels });
    if (!result.valid || !result.success) throw new Error("benchmark-run-final-invalid");
    const run: BaselineRun = {
      index: input.index, shape: input.shape, fixtureMs, claudeTaskMs: task.taskMs,
      prMs, versionCheck: task.versionCheck,
      prNumber: proof.number, prUrl: proof.url,
      proofBaseRef: proof.baseRef, proofRef: proof.ref,
      recordedDigest: provisional.resultHash,
      prClosed: proof.closed, proofRefRemoved: proof.refRemoved, result,
    };
    writeFileSync(join(input.runDir, "run-result.json"), `${JSON.stringify(run, null, 2)}\n`,
      { flag: "wx", mode: 0o600 });
    return run;
  } catch (error) {
    const cleanupFailures = proof && fixture ? prAdapter.cleanup(proof, fixture.agentCheckout) : [];
    writeFileSync(join(input.runDir, "run-failure.json"), `${JSON.stringify({
      index: input.index, shape: input.shape, error: String(error), cleanupFailures,
      prNumber: proof?.number ?? null, proofBaseRef: proof?.baseRef ?? null,
      proofRef: proof?.ref ?? null,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    throw new Error(`benchmark-run-${input.index + 1}-failed:${String(error)}; cleanup=${cleanupFailures.join(",") || "complete"}`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const input = JSON.parse(readFileSync(process.argv[2], "utf8")) as SingleRunInput;
  runBaselineOne(input).then(
    (run) => process.stdout.write(`${JSON.stringify({ index: run.index, resultHash: run.result.resultHash })}\n`),
    (error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; },
  );
}
