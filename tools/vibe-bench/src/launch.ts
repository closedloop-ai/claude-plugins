import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARK_EFFORT, BENCHMARK_MODEL, claudeArgs, LOCAL_MCP_URL, requirePinnedClaude, validateClaudeResult } from "./contract.ts";
import type { ClaudeSelection, ObservedClaudeRun } from "./contract.ts";
import { verifyPreparedFixture } from "./fixture.ts";
import type { PreparedFixture } from "./fixture.ts";

/** Exact Claude command and local MCP configuration for one fixture. */
export interface ClaudeLaunch {
  command: "claude";
  cwd: string;
  args: string[];
  mcpConfigFile: string;
  selection: ClaudeSelection;
}

/**
 * Materialize the only MCP registration visible to the benchmark agent.
 * The preflight verifies both git directions before this file is written.
 */
export function prepareClaudeLaunch(fixture: PreparedFixture, pluginDir: string, apiKey?: string): ClaudeLaunch {
  verifyPreparedFixture(fixture, LOCAL_MCP_URL);
  const selection = requirePinnedClaude({ model: BENCHMARK_MODEL, effort: BENCHMARK_EFFORT });
  const mcpConfigFile = join(fixture.agentCheckout, "..", "claude-mcp.json");
  if (apiKey !== undefined && !/^sk_live_[A-Za-z0-9_-]+$/.test(apiKey)) {
    throw new Error("benchmark-local-api-key-invalid");
  }
  const config = {
    mcpServers: {
      closedloop: {
        type: "http",
        url: LOCAL_MCP_URL,
        ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
      },
    },
  };
  writeFileSync(mcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  return {
    command: "claude",
    cwd: fixture.agentCheckout,
    args: claudeArgs(pluginDir, mcpConfigFile, fixture.taskPrompt),
    mcpConfigFile,
    selection,
  };
}

/**
 * Parse Claude Code stream JSON to record the resolved model. Absence or
 * disagreement is invalid; explicit CLI effort remains the effort evidence.
 */
export function evaluateClaudeStream(lines: string[], launchedEffort: string): ReturnType<typeof validateClaudeResult> {
  const models = new Set<string>();
  let resultStatus = "incomplete";
  for (const line of lines) {
    if (!line.trim()) continue;
    const item: unknown = JSON.parse(line);
    if (typeof item !== "object" || item === null) continue;
    const event = item as { type?: string; model?: string; message?: { model?: string }; is_error?: boolean };
    if (typeof event.model === "string") models.add(event.model);
    if (typeof event.message?.model === "string") models.add(event.message.model);
    if (event.type === "result") resultStatus = event.is_error === false ? "success" : "error";
  }
  const observed: ObservedClaudeRun = {
    model: models.size === 1 ? [...models][0] : null,
    launchedEffort,
    resultStatus,
  };
  return validateClaudeResult(observed);
}
