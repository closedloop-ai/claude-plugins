import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { agentModels } from "./agent-models.ts";
import { orchestrateWaves } from "./baseline.ts";
import type { BaselineRun } from "./baseline.ts";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK, requirePinnedClaude } from "./contract.ts";
import { ControlWebStackAdapter } from "./control-web-stack.ts";
import { SeededStackLifecycle } from "./lifecycle.ts";
import { snapshotMainPlugins, snapshotPluginsAtHead } from "./plugin-snapshot.ts";
import type { SingleRunInput } from "./single-run.ts";
import type { BenchmarkShape } from "./result-schema.ts";

const execFileAsync = promisify(execFile);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trimEnd();
}

/** Verify a clean, current symphony-alpha main checkout before measurement. */
export function sourceMain(checkout: string): string {
  if (git(checkout, "status", "--porcelain")) throw new Error("benchmark-source-not-clean");
  const head = git(checkout, "rev-parse", "HEAD^{commit}");
  const origin = git(checkout, "rev-parse", "origin/main^{commit}");
  if (!/[:/]closedloop-ai\/symphony-alpha(?:\.git)?$/.test(git(checkout, "remote", "get-url", "origin"))) {
    throw new Error("benchmark-source-not-symphony-alpha");
  }
  if (head !== origin) throw new Error("benchmark-source-not-current-origin-main");
  const live = git(checkout, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];
  if (live !== head) throw new Error("benchmark-source-live-main-moved");
  return head;
}

/** Inputs shared by the baseline and selected-PR Claude batches. */
export interface ClaudeBatchInputs {
  symphonyCheckout: string;
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

/** Run balanced Claude samples on one isolated seeded stack and always tear it down. */
export async function runClaudeBatch(input: ClaudeBatchInputs): Promise<ClaudeBatchResult> {
  const batchStarted = Date.now();
  requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
  const source = realpathSync(input.symphonyCheckout);
  const pluginRepo = realpathSync(input.claudePluginsRepo);
  const runRoot = realpathSync(input.runRoot);
  if (readdirSync(runRoot).length) throw new Error("benchmark-run-root-not-empty");
  const sourceSha = sourceMain(source);
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
    },
    async run(index, shape) {
      const runDir = join(runRoot, `run-${String(index + 1).padStart(2, "0")}-${shape}`);
      mkdirSync(runDir);
      const childInput: SingleRunInput = { index, shape, source, sourceSha, snapshot,
        apiKeyFile: stack.details().apiKeyFile, claudeExecutable: input.claudeExecutable,
        ghExecutable: input.ghExecutable, cliVersion, batchId, runDir };
      const inputFile = join(runDir, "run-input.json");
      writeFileSync(inputFile, `${JSON.stringify(childInput)}\n`, { flag: "wx", mode: 0o600 });
      const childScript = realpathSync(fileURLToPath(new URL("./single-run.ts", import.meta.url)));
      try {
        const child = await execFileAsync(process.execPath,
          ["--experimental-strip-types", childScript, inputFile], {
            cwd: runDir, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
          });
        writeFileSync(join(runDir, "run-process.log"), `${child.stdout}\n${child.stderr}`,
          { flag: "wx", mode: 0o600 });
      } catch (error) {
        throw new Error(`benchmark-child-${index + 1}-failed:${String(error)}`);
      }
      return JSON.parse(readFileSync(join(runDir, "run-result.json"), "utf8")) as BaselineRun;
    },
    async teardown() { await lifecycle.close(); },
  });
  return { runs: measured.runs.map((item) => item.value), setupMs: measured.setupMs,
    teardownMs: measured.teardownMs, preflightMs, fullWallMs: Date.now() - batchStarted,
    sourceSha, pluginSha: snapshot.sha, cliVersion, batchId };
}
