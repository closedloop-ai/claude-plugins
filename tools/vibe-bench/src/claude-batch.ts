import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentModels } from "./agent-models.ts";
import { orchestrateWaves } from "./baseline.ts";
import type { BaselineRun } from "./baseline.ts";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK, requirePinnedClaude,
  TARGET_WALL_MS } from "./contract.ts";
import { ControlWebStackAdapter } from "./control-web-stack.ts";
import { cleanupRecordedProof, ProcessPrCommands, proofRefs } from "./github-pr.ts";
import { SeededStackLifecycle } from "./lifecycle.ts";
import { snapshotMainPlugins, snapshotPluginsAtHead } from "./plugin-snapshot.ts";
import type { SingleRunInput } from "./single-run.ts";
import type { BenchmarkShape } from "./result-schema.ts";
import { runOwnedProcess } from "./owned-process.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trimEnd();
}

/** Verify a clean symphony-alpha fixture checkout before measurement. */
export function sourceMain(checkout: string, expectedSourceSha?: string): string {
  if (git(checkout, "status", "--porcelain")) throw new Error("benchmark-source-not-clean");
  const head = git(checkout, "rev-parse", "HEAD^{commit}");
  const origin = git(checkout, "rev-parse", "origin/main^{commit}");
  if (!/[:/]closedloop-ai\/symphony-alpha(?:\.git)?$/.test(git(checkout, "remote", "get-url", "origin"))) {
    throw new Error("benchmark-source-not-symphony-alpha");
  }
  const live = git(checkout, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
  if (origin !== live) throw new Error("benchmark-source-local-origin-main-stale");
  if (expectedSourceSha) {
    if (!/^[a-f0-9]{40}$/.test(expectedSourceSha) || head !== expectedSourceSha) {
      throw new Error("benchmark-source-not-expected-fixture");
    }
    try {
      execFileSync("git", ["-C", checkout, "merge-base", "--is-ancestor", head, live], { stdio: "ignore" });
    } catch {
      throw new Error("benchmark-source-fixture-not-on-live-main");
    }
  } else if (head !== origin) {
    throw new Error("benchmark-source-not-current-origin-main");
  }
  return head;
}

/** Inputs shared by the baseline and selected-PR Claude batches. */
export interface ClaudeBatchInputs {
  symphonyCheckout: string;
  expectedSourceSha?: string;
  claudePluginsRepo: string;
  expectedPluginSha: string;
  snapshotMode: "main" | "head";
  waves: readonly (readonly BenchmarkShape[])[];
  runRoot: string;
  claudeExecutable: string;
  ghExecutable: string;
}

/** Complete one-stack batch result, including cleanup time and all proof PRs. */
export interface ClaudeBatchResult {
  runs: BaselineRun[];
  setupMs: number;
  teardownMs: number;
  preflightMs: number;
  fullWallMs: number;
  sourceSha: string;
  pluginSha: string;
  cliVersion: string;
  batchId: string;
}

/**
 * Bound paid model execution without charging seeded-stack setup to that budget.
 *
 * ISS-13401's 2026-10-29 runtime decision still evaluates the complete
 * start-to-PR wall time separately through `fullWallMs` and `targetMet`.
 */
export function modelBudgetDeadline(setupCompletedAt: number): number {
  return setupCompletedAt + TARGET_WALL_MS;
}

/** Run balanced Claude samples on one isolated seeded stack and always tear it down. */
export async function runClaudeBatch(input: ClaudeBatchInputs): Promise<ClaudeBatchResult> {
  const batchStarted = Date.now();
  let deadline: number | null = null;
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
    const source = realpathSync(input.symphonyCheckout);
    const pluginRepo = realpathSync(input.claudePluginsRepo);
    const runRoot = realpathSync(input.runRoot);
    if (readdirSync(runRoot).length) throw new Error("benchmark-run-root-not-empty");
    const sourceSha = sourceMain(source, input.expectedSourceSha);
    const snapshot = input.snapshotMode === "main"
      ? snapshotMainPlugins(pluginRepo, input.expectedPluginSha, runRoot)
      : snapshotPluginsAtHead(pluginRepo, input.expectedPluginSha, runRoot);
    if (JSON.stringify(agentModels(snapshot.vibeDir)) !== JSON.stringify(snapshot.agentModels)) {
      throw new Error("benchmark-agent-model-snapshot-changed");
    }
    const cliVersion = execFileSync(input.claudeExecutable, ["--version"], { encoding: "utf8" }).trim();
    if (!/^\d+\.\d+\.\d+ \(Claude Code\)$/.test(cliVersion)) throw new Error("benchmark-cli-version-invalid");
    const preflightMs = Date.now() - batchStarted;
    const stack = new ControlWebStackAdapter(source, runRoot);
    const lifecycle = new SeededStackLifecycle(stack);
    const batchId = randomUUID().slice(0, 8);
    const measured = await orchestrateWaves<BaselineRun>(input.waves, {
    async setup() {
      await lifecycle.acquire({ id: batchId,
        isolationKey: `${sourceSha}:${BENCHMARK_TASK.id}:${input.waves.length}-balanced-waves` });
      const details = stack.details();
      if (details.costCardRows < 1 || details.seedStages < 1) throw new Error("benchmark-seed-incomplete");
      const key = JSON.parse(readFileSync(details.apiKeyFile, "utf8")) as { apiBearer?: string };
      if (!key.apiBearer) throw new Error("benchmark-seed-key-missing");
      deadline = modelBudgetDeadline(Date.now());
    },
    async run(index, shape) {
      const runDir = join(runRoot, `run-${String(index + 1).padStart(2, "0")}-${shape}`);
      mkdirSync(runDir);
      const runKey = `${batchId}-${index + 1}`;
      const refs = proofRefs(sourceSha, runKey);
      const childInput: SingleRunInput = { index, shape, source, sourceSha, snapshot,
        apiKeyFile: stack.details().apiKeyFile, claudeExecutable: input.claudeExecutable,
        ghExecutable: input.ghExecutable, cliVersion, batchId, runDir };
      const inputFile = join(runDir, "run-input.json");
      writeFileSync(inputFile, `${JSON.stringify(childInput)}\n`, { flag: "wx", mode: 0o600 });
      const childScript = realpathSync(fileURLToPath(new URL("./single-run.ts", import.meta.url)));
      let childFailure: unknown = null;
      try {
        if (deadline === null) throw new Error("benchmark-model-budget-not-started");
        const child = await runOwnedProcess(process.execPath,
          ["--experimental-strip-types", childScript, inputFile], {
            cwd: runDir, deadline, signal: abort.signal, maxBuffer: 8 * 1024 * 1024,
          });
        if (child.exitCode !== 0 || child.signal) {
          throw new Error(`exit=${child.exitCode};signal=${child.signal ?? "none"};stderr=${child.stderr}`);
        }
        writeFileSync(join(runDir, "run-process.log"), `${child.stdout}\n${child.stderr}`,
          { flag: "wx", mode: 0o600 });
      } catch (error) {
        childFailure = error;
      } finally {
        rmSync(join(runDir, "claude-mcp.json"), { force: true });
        rmSync(join(runDir, "claude-settings.json"), { force: true });
      }
      let cleanupFailures: string[] = [];
      try {
        cleanupFailures = cleanupRecordedProof(runDir, refs.baseRef, refs.ref,
          new ProcessPrCommands(), input.ghExecutable);
      } catch (error) {
        cleanupFailures = [`journal:${String(error)}`];
      }
      if (childFailure || cleanupFailures.length) {
        throw new Error(`benchmark-child-${index + 1}-failed:${String(childFailure ?? "cleanup")}; ` +
          `parent-cleanup=${cleanupFailures.join(",") || "complete"}`);
      }
      return JSON.parse(readFileSync(join(runDir, "run-result.json"), "utf8")) as BaselineRun;
    },
    async teardown() { await lifecycle.close(); },
  });
    return { runs: measured.runs.map((item) => item.value), setupMs: measured.setupMs,
      teardownMs: measured.teardownMs, preflightMs, fullWallMs: Date.now() - batchStarted,
      sourceSha, pluginSha: snapshot.sha, cliVersion, batchId };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
