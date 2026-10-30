import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK, requirePinnedClaude, wallVerdict } from "./contract.ts";
import { agentModels } from "./agent-models.ts";
import { ControlWebStackAdapter } from "./control-web-stack.ts";
import { prepareFixture } from "./fixture.ts";
import { cleanupClaudeLaunch, prepareClaudeLaunch } from "./launch.ts";
import type { ClaudeLaunch } from "./launch.ts";
import { SeededStackLifecycle } from "./lifecycle.ts";
import { runRealProbe } from "./real-probe.ts";

/**
 * Exercise one pinned Claude task against one owned, seeded web stack. The
 * second lease proves reuse without starting or stopping a second stack.
 */
export async function runLivePhase0(
  sourceCheckout: string,
  sandboxRoot: string,
  pluginDir: string,
  claudeExecutable: string,
): Promise<string> {
  const started = Date.now();
  const source = realpathSync(sourceCheckout);
  const sandbox = realpathSync(sandboxRoot);
  // Refuse model, effort and writer-policy drift before starting local services.
  requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
  agentModels(realpathSync(pluginDir));
  const sourceSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  const originMainSha = execFileSync("git", ["-C", source, "rev-parse", "origin/main^{commit}"], { encoding: "utf8" }).trim();
  if (sourceSha !== originMainSha) throw new Error("benchmark-source-not-current-origin-main");
  const stack = new ControlWebStackAdapter(source, sandbox);
  const lifecycle = new SeededStackLifecycle(stack);
  const isolationKey = `${sourceSha}:${BENCHMARK_TASK.id}:independent-agent-checkout`;
  let stackHeld = false;
  let probeReport: Record<string, unknown> | null = null;
  let setupMs: number | null = null;
  let teardownMs: number | null = null;
  let liveError: string | null = null;
  let launchFiles: ClaudeLaunch | null = null;
  try {
    await lifecycle.acquire({ id: "phase0-probe", isolationKey });
    stackHeld = true;
    await lifecycle.acquire({ id: "reuse-proof", isolationKey });
    if (!(await stack.healthy())) throw new Error("benchmark-stack-reuse-unhealthy");
    await lifecycle.release("reuse-proof");
    const details = stack.details();
    const fixture = prepareFixture(source, sandbox);
    const credentials = JSON.parse(readFileSync(details.apiKeyFile, "utf8")) as { apiBearer?: string };
    if (!credentials.apiBearer) throw new Error("benchmark-seed-key-missing");
    const launch = prepareClaudeLaunch(fixture, realpathSync(pluginDir), credentials.apiBearer);
    launchFiles = launch;
    const manifestFile = join(sandbox, "phase0-manifest.json");
    writeFileSync(manifestFile, `${JSON.stringify({
      fixture,
      launch,
      liveStack: {
        session: details.session,
        controlPid: details.controlPid,
        mcpPid: details.mcpPid,
        databaseName: details.databaseName,
        seedStages: details.seedStages,
        costCardRows: details.costCardRows,
      },
    }, null, 2)}\n`, { flag: "wx" });
    setupMs = Date.now() - started;
    const probeFile = await runRealProbe(manifestFile, claudeExecutable);
    probeReport = JSON.parse(readFileSync(probeFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    liveError = error instanceof Error ? error.message : String(error);
  } finally {
    const teardownStarted = Date.now();
    if (stackHeld) {
      try { await lifecycle.release("phase0-probe"); }
      catch (error) { liveError = `${liveError ?? ""}; teardown: ${String(error)}`; }
    }
    if (launchFiles) cleanupClaudeLaunch(launchFiles);
    teardownMs = Date.now() - teardownStarted;
  }
  const wallMs = Date.now() - started;
  const reportFile = join(sandbox, "phase0-live-result.json");
  const report = { startedAt: new Date(started).toISOString(), sourceSha, setupMs, teardownMs,
    wall: wallVerdict(wallMs), probe: probeReport, error: liveError };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  if (liveError) throw new Error(`benchmark-live-phase0-failed: ${reportFile}: ${liveError}`);
  return reportFile;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 6) {
    throw new Error("usage: live-phase0.ts <clean symphony-alpha checkout> <empty sandbox> <vibe plugin> <claude binary>");
  }
  runLivePhase0(process.argv[2], process.argv[3], process.argv[4], process.argv[5]).then(
    (file) => process.stdout.write(`${file}\n`),
    (error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; },
  );
}
