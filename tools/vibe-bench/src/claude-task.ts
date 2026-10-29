import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, BENCHMARK_TASK, claudeArgs,
  LOCAL_MCP_URL, requirePinnedClaude } from "./contract.ts";
import type { BenchmarkShape } from "./result-schema.ts";
import type { PreparedFixture } from "./fixture.ts";
import { prepareClaudeLaunch } from "./launch.ts";
import type { PluginSnapshot } from "./plugin-snapshot.ts";
import { projectSearchOracle } from "../oracle/project-search-oracle.ts";
import { checkVibeVersion, writeBenchmarkSessionRecord } from "./session-preflight.ts";

const BENCHMARK_SCOPE = `This is an authorized, isolated benchmark of the fixed Projects search task. The harness already supplies the clean checkout, seeded web app, local MCP, hidden oracle and draft-PR lifecycle. Skip ticket creation, Vercel, browser/desktop, installs, Git, GitHub, tests, review and handoff. Do not ask a question. Do not use Bash, web or MCP tools. Delegate to exactly one vibe-change-worker. Its only job is to change the Projects search predicate so a trimmed, case-insensitive query matches anywhere in the name. The agent may edit only that one source file. Stop as soon as the edit is done. The harness verifies the edit and handles the draft PR.`;

/** Comparable paired waves: each wave has equal A and B contention. */
export const BASELINE_WAVES = [
  ["vibe", "fleet-one-writer"],
  ["vibe", "fleet-one-writer"],
  ["vibe", "fleet-one-writer"],
  ["vibe", "fleet-one-writer"],
  ["vibe", "fleet-one-writer"],
] as const;
/** Stable run indexes and report order for the paired baseline. */
export const BASELINE_ORDER = BASELINE_WAVES.flat();

/** Exact user prompt and canonical skill entry for one baseline shape. */
export function shapePrompt(shape: BenchmarkShape): string {
  const skill = shape === "vibe" ? "/vibe:vibe" : "/vibe:fleet-orchestrator";
  return `${skill}\n\n${BENCHMARK_SCOPE}\n\nTask: ${BENCHMARK_TASK.prompt}`;
}

/** Real Claude stream and task evidence before the GitHub PR boundary. */
export interface ClaudeTaskEvidence {
  stream: string;
  sessionId: string;
  taskMs: number;
  mcpConnected: boolean;
  oracleBefore: boolean;
  oracleAfter: boolean;
  observedRootModel: string | null;
  toolNames: string[];
  versionCheck: "current" | "unknown" | "outdated";
}

/** Accept only the two inline snapshot plugins plus Claude's built-ins. */
export function exactSnapshotPlugins(plugins: unknown, snapshot: PluginSnapshot): boolean {
  if (!Array.isArray(plugins)) return false;
  const custom = plugins.filter((value): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && (value as Record<string, unknown>).path !== "builtin");
  return custom.length === 2 && [
    { name: "closedloop-core", source: "closedloop-core@inline", path: snapshot.coreDir },
    { name: "vibe", source: "vibe@inline", path: snapshot.vibeDir },
  ].every((expected) => custom.some((plugin) => plugin.name === expected.name &&
    plugin.source === expected.source && plugin.path === expected.path));
}

/** Launch a canonical shape with only local file, skill and agent tools. */
export async function runClaudeTask(
  fixture: PreparedFixture,
  snapshot: PluginSnapshot,
  apiKey: string,
  claudeExecutable: string,
  cliVersion: string,
  shape: BenchmarkShape,
  runDir: string,
): Promise<ClaudeTaskEvidence> {
  requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
  const before = projectSearchOracle(fixture.agentCheckout);
  if (before.pass) throw new Error("benchmark-task-not-regressed");
  const launch = prepareClaudeLaunch(fixture, snapshot.vibeDir, apiKey);
  const prompt = shapePrompt(shape);
  const baseArgs = claudeArgs(snapshot.vibeDir, launch.mcpConfigFile, launch.settingsFile, prompt).slice(0, -1);
  baseArgs.splice(baseArgs.indexOf("--plugin-dir"), 0, "--plugin-dir", snapshot.coreDir);
  const requestedSessionId = randomUUID();
  const started = Date.now();
  const checked = checkVibeVersion(snapshot.vibeDir, fixture.agentCheckout,
    runDir, requestedSessionId, claudeExecutable);
  await writeBenchmarkSessionRecord(snapshot.vibeDir, fixture.agentCheckout,
    `benchmark/${fixture.taskId}`, "seeded", fixture.baseSha);
  const args = [
    ...baseArgs,
    "--restricted", "--tools", "Read,Edit,Write,Grep,Glob,Skill,Agent",
    "--permission-mode", "acceptEdits", "--max-turns", "24",
    "--forward-subagent-text", "--session-id", requestedSessionId, prompt,
  ];
  const completed = spawnSync(claudeExecutable, args, {
    cwd: fixture.agentCheckout, encoding: "utf8", timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stream = completed.stdout ?? "";
  writeFileSync(join(runDir, "claude-stream.jsonl"), stream, { flag: "wx", mode: 0o600 });
  writeFileSync(join(runDir, "claude-stderr.txt"), completed.stderr ?? "", { flag: "wx", mode: 0o600 });
  const events = stream.trim().split("\n").map((line) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch { throw new Error("benchmark-claude-stream-truncated"); }
  });
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const sessionId = init?.session_id;
  const mcpServers = init?.mcp_servers;
  const mcpConnected = Array.isArray(mcpServers) && mcpServers.some((server) =>
    server?.name === "closedloop" && server?.status === "connected");
  const model = typeof init?.model === "string" ? init.model : null;
  const observedCliVersion = init?.claude_code_version;
  const pluginErrors = init?.plugin_errors;
  const skills = init?.skills;
  if (observedCliVersion !== cliVersion.split(" ")[0] ||
      (Array.isArray(pluginErrors) && pluginErrors.length > 0) ||
      !exactSnapshotPlugins(init?.plugins, snapshot) ||
      !Array.isArray(skills) || !skills.includes("vibe:vibe") ||
      !skills.includes("vibe:fleet-orchestrator")) {
    throw new Error("benchmark-claude-plugin-or-cli-mismatch");
  }
  const seenToolBlocks = new Map<string, { id?: string; type?: string; name?: string; input?: unknown }>();
  for (const event of events) {
    if (event.type !== "assistant" || typeof event.message !== "object" || !event.message) continue;
    const message = event.message as { id?: string; content?: Array<{ id?: string; type?: string; name?: string; input?: unknown }> };
    for (const [blockIndex, block] of (message.content ?? []).entries()) {
      if (block.type !== "tool_use" || !block.name) continue;
      const key = block.id ?? `${message.id ?? "unknown"}:${blockIndex}`;
      const previous = seenToolBlocks.get(key);
      if (previous && previous.name !== block.name) throw new Error("benchmark-tool-block-conflict");
      seenToolBlocks.set(key, block);
    }
  }
  const toolBlocks = [...seenToolBlocks.values()];
  const toolNames = toolBlocks.map((block) => block.name!);
  const agentBlocks = toolBlocks.filter((block) => block.name === "Agent");
  const oneWriter = agentBlocks.length === 1 && typeof agentBlocks[0].input === "object" &&
    agentBlocks[0].input !== null &&
    ["vibe-change-worker", "vibe:vibe-change-worker"].includes(
      String((agentBlocks[0].input as { subagent_type?: unknown }).subagent_type ?? ""));
  const allowed = new Set(["Read", "Edit", "Write", "Grep", "Glob", "Skill", "Agent"]);
  if (toolNames.some((name) => !allowed.has(name))) throw new Error("benchmark-claude-external-tool-used");
  const after = projectSearchOracle(fixture.agentCheckout);
  if (completed.status !== 0 || completed.signal || completed.error || !after.pass || !mcpConnected ||
      model !== BENCHMARK_MODEL || sessionId !== requestedSessionId ||
      !oneWriter) {
    throw new Error(`benchmark-claude-task-failed: exit=${completed.status}, signal=${completed.signal}, ` +
      `error=${completed.error?.message ?? "none"}, oracle=${after.pass}, mcp=${mcpConnected}, ` +
      `model=${model}, oneWriter=${oneWriter}`);
  }
  return { stream, sessionId, taskMs: Date.now() - started, mcpConnected,
    oracleBefore: before.pass, oracleAfter: after.pass, observedRootModel: model, toolNames,
    versionCheck: checked.status };
}
