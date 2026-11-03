import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK } from "./contract.ts";
import { collectClaude } from "./claude-collector.ts";
import type { OtelRequest } from "./claude-collector.ts";
import { runLivePhase0 } from "./live-phase0.ts";
import { buildReport } from "./report.ts";
import type { ClaudeBenchmarkResult, ClaudeRunIdentity } from "./result-schema.ts";

interface LocalProbeReport {
  startedAt?: string;
  sourceSha: string;
  setupMs: number;
  teardownMs: number;
  wall: { wallMs: number };
  error: string | null;
  probe: {
    stdout: string;
    oracleAfter: { pass: boolean };
    agentModels: Record<string, string>;
  } | null;
}

function git(cwd: string, ...args: string[]): string {
  // Porcelain status uses its first leading column for the index state.
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trimEnd();
}

/** Preserve both porcelain status columns while extracting changed paths. */
export function changedPathsInCheckout(cwd: string): string[] {
  return git(cwd, "status", "--porcelain").split("\n").filter(Boolean).map((line) => line.slice(3));
}

/** Read a run-owned JSONL OTEL file, never a global telemetry collector. */
export function readOtelFile(path: string): OtelRequest[] {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as OtelRequest; }
    catch { throw new Error(`benchmark-otel-truncated-line:${index + 1}`); }
  });
}

/** Load root and subagent transcript files named by a run-owned manifest. */
export function readTranscriptManifest(path: string): Array<{ jsonl: string; agentName?: string; parentToolUseId?: string }> {
  const entries = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(entries) || !entries.length) throw new Error("benchmark-transcript-manifest-invalid");
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof (entry as { path?: unknown }).path !== "string") {
      throw new Error("benchmark-transcript-manifest-invalid");
    }
    const item = entry as { path: string; agentName?: string; parentToolUseId?: string };
    if (item.agentName !== undefined && typeof item.agentName !== "string") throw new Error("benchmark-transcript-agent-invalid");
    return { jsonl: readFileSync(item.path, "utf8"), agentName: item.agentName, parentToolUseId: item.parentToolUseId };
  });
}

/** Find only this CLI session's root and subagent transcripts in Claude's store. */
export function discoverRunTranscripts(
  sessionId: string,
  agentCheckout: string,
  projectsRoot = join(homedir(), ".claude", "projects"),
): Array<{ jsonl: string; agentName?: string; parentToolUseId?: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(sessionId)) throw new Error("benchmark-transcript-session-id-invalid");
  const matches = readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsRoot, entry.name))
    .filter((dir) => existsSync(join(dir, `${sessionId}.jsonl`)));
  if (matches.length !== 1) throw new Error("benchmark-transcript-session-ambiguous-or-missing");
  const dir = matches[0];
  const root = readFileSync(join(dir, `${sessionId}.jsonl`), "utf8");
  const firstCwd = root.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { cwd?: string })
    .find((item) => typeof item.cwd === "string")?.cwd;
  if (!firstCwd || realpathSync(firstCwd) !== realpathSync(agentCheckout)) {
    throw new Error("benchmark-transcript-checkout-mismatch");
  }
  const bundles: Array<{ jsonl: string; agentName?: string; parentToolUseId?: string }> = [{ jsonl: root }];
  const subagentsDir = join(dir, sessionId, "subagents");
  if (!existsSync(subagentsDir)) return bundles;
  for (const entry of readdirSync(subagentsDir).filter((name) => /^agent-[a-zA-Z0-9]+\.jsonl$/.test(name)).sort()) {
    const stem = entry.slice(0, -".jsonl".length);
    const metaFile = join(subagentsDir, `${stem}.meta.json`);
    if (!existsSync(metaFile)) throw new Error(`benchmark-subagent-meta-missing:${stem}`);
    const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { agentType?: string; description?: string; toolUseId?: string };
    if (!meta.agentType || !meta.toolUseId) throw new Error(`benchmark-subagent-meta-invalid:${stem}`);
    const named = meta.agentType === "general-purpose" ? meta.description?.match(/^vibe-[a-z-]+/)?.[0] : null;
    bundles.push({ jsonl: readFileSync(join(subagentsDir, entry), "utf8"),
      agentName: named ?? meta.agentType, parentToolUseId: meta.toolUseId });
  }
  return bundles;
}

/** Convert the owned Phase 0 probe into a reviewable, hash-stamped local result. */
export function collectLocalProbe(
  phase0ReportFile: string,
  pluginDir: string,
  claudeExecutable: string,
  otelFile?: string,
  transcriptManifestFile?: string,
): { jsonFile: string; markdownFile: string; result: ClaudeBenchmarkResult } {
  const phase0 = JSON.parse(readFileSync(phase0ReportFile, "utf8")) as LocalProbeReport;
  if (phase0.error || !phase0.probe || !phase0.sourceSha || phase0.setupMs == null || phase0.teardownMs == null) {
    throw new Error("benchmark-local-probe-incomplete");
  }
  if (git(pluginDir, "status", "--porcelain", "--", ".")) {
    throw new Error("benchmark-plugin-snapshot-dirty");
  }
  const pluginSha = git(pluginDir, "rev-parse", "HEAD");
  const cliVersion = execFileSync(claudeExecutable, ["--version"], { encoding: "utf8" }).trim();
  const taskVersion = createHash("sha256").update(JSON.stringify(BENCHMARK_TASK)).digest("hex");
  const sandbox = dirname(resolve(phase0ReportFile));
  const phase0Manifest = join(sandbox, "phase0-manifest.json");
  const manifest = existsSync(phase0Manifest)
    ? JSON.parse(readFileSync(phase0Manifest, "utf8")) as { fixture?: { agentCheckout?: string } } : null;
  const changedPaths = manifest?.fixture?.agentCheckout
    ? changedPathsInCheckout(manifest.fixture.agentCheckout) : [];
  const noOutOfScopeEdits = changedPaths.length > 0 &&
    changedPaths.every((path) => path === BENCHMARK_TASK.file);
  const identity: ClaudeRunIdentity = {
    id: randomUUID(), shape: "vibe", pluginSha,
    taskId: BENCHMARK_TASK.id, taskVersion, fixtureVersion: phase0.sourceSha,
    cliVersion, configuredModel: BENCHMARK_MODEL, configuredEffort: BENCHMARK_EFFORT,
    startedAt: phase0.startedAt ?? "",
    stackSetupMs: phase0.setupMs, stackTeardownMs: phase0.teardownMs,
    wallMs: phase0.wall.wallMs, oraclePassed: phase0.probe.oracleAfter.pass,
    noOutOfScopeEdits, taskComplete: phase0.probe.oracleAfter.pass, prDraftRecordedAndClosed: false,
  };
  let transcripts = transcriptManifestFile ? readTranscriptManifest(transcriptManifestFile) : undefined;
  if (!transcripts && existsSync(phase0Manifest)) {
    const init = phase0.probe.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; subtype?: string; session_id?: string })
      .find((event) => event.type === "system" && event.subtype === "init");
    if (!manifest?.fixture?.agentCheckout || !init?.session_id) throw new Error("benchmark-transcript-discovery-input-missing");
    transcripts = discoverRunTranscripts(init.session_id, manifest.fixture.agentCheckout);
  }
  const result = collectClaude({
    stream: phase0.probe.stdout, otel: otelFile ? readOtelFile(otelFile) : null,
    transcripts,
    identity, agentModels: phase0.probe.agentModels,
  });
  const dir = sandbox;
  const jsonFile = join(dir, "phase1-claude-result.json");
  const markdownFile = join(dir, "phase1-claude-report.md");
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  writeFileSync(markdownFile, buildReport(result), { flag: "wx" });
  return { jsonFile, markdownFile, result };
}

/** Start one owned local Claude probe, then collect it without external writes. */
export async function runLocalClaude(
  sourceCheckout: string,
  sandboxRoot: string,
  pluginDir: string,
  claudeExecutable: string,
  otelFile?: string,
  transcriptManifestFile?: string,
): Promise<{ jsonFile: string; markdownFile: string; result: ClaudeBenchmarkResult }> {
  const report = await runLivePhase0(sourceCheckout, sandboxRoot, pluginDir, claudeExecutable);
  return collectLocalProbe(report, pluginDir, claudeExecutable, otelFile, transcriptManifestFile);
}
