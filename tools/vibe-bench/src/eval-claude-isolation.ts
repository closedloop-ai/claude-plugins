import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ClaudeEvalIsolation {
  executable: string;
  binDir: string;
  mcpConfigFile: string;
}

export interface EvalMcpGrant {
  name: string;
  service: "graph" | "closedloop";
  access: "read" | "write";
  operation: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/**
 * Build a run-owned Claude entrypoint with an exact MCP allowlist.
 *
 * The wrapper stays first on PATH so Claude processes started by the released
 * production launcher inherit the same strict configuration. Authentication
 * remains owned by the real Claude executable, while user and project MCP
 * registrations are excluded by `--setting-sources ''` and
 * `--strict-mcp-config`.
 */
export function createClaudeEvalIsolation(root: string, claudeExecutable: string,
  grants: readonly EvalMcpGrant[]): ClaudeEvalIsolation {
  if (!root || !claudeExecutable || new Set(grants.map((item) => item.name)).size !== grants.length) {
    throw new Error("eval-claude-isolation-input-invalid");
  }
  const operations = grants.map((grant) => {
    if (grant.service !== "graph" || grant.access !== "read" ||
        grant.name !== `mcp__closedloop-graph__${grant.operation}` ||
        !/^[a-z][a-z0-9_]*$/.test(grant.operation)) {
      throw new Error("eval-claude-isolation-grant-invalid");
    }
    return grant.operation;
  }).sort();
  const isolationRoot = join(root, "claude-isolation");
  const binDir = join(isolationRoot, "bin");
  const mcpConfigFile = join(isolationRoot, "mcp.json");
  const executable = join(binDir, "claude");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const mcpServers = operations.length === 0 ? {} : {
    "closedloop-graph": {
      type: "stdio",
      command: process.execPath,
      args: ["--experimental-strip-types",
        fileURLToPath(new URL("./eval-mcp-stub.ts", import.meta.url)),
        "--operations", operations.join(",")],
    },
  };
  writeFileSync(mcpConfigFile, `${JSON.stringify({ mcpServers }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 });
  const script = `#!/bin/sh\nPATH=${shellQuote(binDir)}:\"$PATH\"\nexport PATH\n` +
    `exec ${shellQuote(claudeExecutable)} --setting-sources '' --mcp-config ` +
    `${shellQuote(mcpConfigFile)} --strict-mcp-config \"$@\"\n`;
  writeFileSync(executable, script, { flag: "wx", mode: 0o700 });
  chmodSync(executable, 0o700);
  if (dirname(executable) !== binDir) throw new Error("eval-claude-isolation-path-invalid");
  return { executable, binDir, mcpConfigFile };
}
