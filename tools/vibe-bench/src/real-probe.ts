import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, claudeArgs, LOCAL_MCP_URL, requirePinnedClaude } from "./contract.ts";
import { agentModels } from "./agent-models.ts";
import { verifyPreparedFixture } from "./fixture.ts";
import type { PreparedFixture } from "./fixture.ts";
import { evaluateClaudeStream } from "./launch.ts";
import type { ClaudeLaunch } from "./launch.ts";
import { projectSearchOracle } from "../oracle/project-search-oracle.ts";

interface Phase0Manifest {
  fixture: PreparedFixture;
  launch: ClaudeLaunch;
  liveStack?: {
    session: string;
    controlPid: number;
    mcpPid: number;
    databaseName: string;
    seedStages: number;
    costCardRows: number;
  };
}

/**
 * Run a bounded real Claude Code probe in the disposable checkout. Restricted
 * mode and the explicit tool list confine it to local file edits; the benchmark
 * PR and any external service are outside this Phase 0 probe.
 */
export function runRealProbe(manifestFile: string, claudeExecutable: string): string {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Phase0Manifest;
  const { fixture, launch } = manifest;
  verifyPreparedFixture(fixture, LOCAL_MCP_URL);
  requirePinnedClaude(launch.selection);
  if (launch.command !== "claude" || realpathSync(launch.cwd) !== realpathSync(fixture.agentCheckout)) {
    throw new Error("benchmark-launch-changed");
  }
  const config = JSON.parse(readFileSync(launch.mcpConfigFile, "utf8"));
  const localMcp = config?.mcpServers?.closedloop;
  const authorized = typeof localMcp?.headers?.Authorization === "string" &&
    /^Bearer sk_live_[A-Za-z0-9_-]+$/.test(localMcp.headers.Authorization);
  if (localMcp?.type !== "http" || localMcp?.url !== LOCAL_MCP_URL ||
      Object.keys(config.mcpServers).length !== 1 ||
      (manifest.liveStack && !authorized) ||
      (!manifest.liveStack && localMcp.headers !== undefined)) {
    throw new Error("benchmark-mcp-config-changed");
  }
  const pluginFlag = launch.args.indexOf("--plugin-dir");
  const pluginDir = launch.args[pluginFlag + 1];
  if (pluginFlag < 0 || !pluginDir ||
      JSON.stringify(launch.args) !== JSON.stringify(claudeArgs(pluginDir, launch.mcpConfigFile,
        launch.settingsFile, fixture.taskPrompt))) {
    throw new Error("benchmark-claude-args-changed");
  }
  if (existsSync(join(fixture.agentCheckout, "tools/vibe-bench/oracle"))) {
    throw new Error("benchmark-oracle-visible");
  }
  const oracleBefore = projectSearchOracle(fixture.agentCheckout);
  if (oracleBefore.pass) throw new Error("benchmark-fixture-not-regressed");

  const prompt = "Phase 0 local-only probe. Repair Projects search so an infix match works regardless of case and surrounding query spaces. Make only the smallest code edit in this checkout. Do not create a PR or use MCP, browser, network, Git, or any external service. Briefly state what you changed.";
  const args = [
    ...launch.args.slice(0, -1),
    "--restricted", "--tools", "Read,Edit,Write,Grep,Glob",
    "--permission-mode", "acceptEdits", "--max-turns", "8", prompt,
  ];
  const started = Date.now();
  const completed = spawnSync(claudeExecutable, args, {
    cwd: fixture.agentCheckout,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = completed.stdout ?? "";
  const stderr = completed.stderr ?? "";
  const stream = evaluateClaudeStream(stdout.split("\n"), BENCHMARK_EFFORT);
  const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const mcpConnected = init?.mcp_servers?.some((server: { name?: string; status?: string }) =>
    server.name === "closedloop" && server.status === "connected") ?? false;
  const result = events.slice().reverse().find((event: { type?: string }) => event.type === "result");
  const oracleAfter = projectSearchOracle(fixture.agentCheckout);
  const report = {
    model: BENCHMARK_MODEL,
    effort: BENCHMARK_EFFORT,
    observed: stream,
    exitCode: completed.status,
    signal: completed.signal,
    error: completed.error?.message ?? null,
    wallMs: Date.now() - started,
    oracleBefore,
    oracleAfter,
    mcpConnected,
    liveStack: manifest.liveStack ?? null,
    agentModels: agentModels(pluginDir),
    modelUsage: result?.modelUsage ?? null,
    usage: result?.usage ?? null,
    totalCostUsd: result?.total_cost_usd ?? null,
    durationApiMs: result?.duration_api_ms ?? null,
    restricted: true,
    noExternalTools: true,
    localMcpUrl: LOCAL_MCP_URL,
    fakeRemote: fixture.bareRemote,
    stdout,
    stderr,
  };
  const reportFile = join(dirname(manifestFile), "phase0-real-probe.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (completed.status !== 0 || !stream.valid || !oracleAfter.pass ||
      (manifest.liveStack && !mcpConnected)) {
    throw new Error(`benchmark-real-probe-failed: ${reportFile}`);
  }
  return reportFile;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 4) throw new Error("usage: real-probe.ts <phase0-manifest.json> <absolute claude binary>");
  process.stdout.write(`${runRealProbe(resolve(process.argv[2]), resolve(process.argv[3]))}\n`);
}
