import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

interface GateConfig {
  worktree: string;
  scripts: string[];
}

interface HookInput {
  tool_name?: unknown;
  tool_input?: { command?: unknown };
}

interface HookDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason: string;
  };
}

function decision(permissionDecision: "allow" | "deny", reason: string): HookDecision {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision,
    permissionDecisionReason: reason } };
}

/** Permit only one JSON-on-stdin production writer command for the exact fixture. */
export function claudeRootCommandDecision(input: HookInput, config: GateConfig): HookDecision {
  const command = input.tool_input?.command;
  if (input.tool_name !== "Bash" || typeof command !== "string" || command.includes("\n") ||
      [";", "&", "`", "$(", "||"].some((part) => command.includes(part))) {
    return decision("deny", "Upgrade eval allows only one bounded writer command");
  }
  const parts = command.split("|").map((part) => part.trim());
  if (parts.length !== 2) return decision("deny", "Upgrade eval command must provide JSON on stdin");
  const payloadMatch = /^printf\s+'%s(?:\\n)?'\s+'(\{.*\})'$/.exec(parts[0]);
  const commandMatch = /^(?:node|[^\s]+\/node)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+(\S+))?$/.exec(parts[1]);
  if (!payloadMatch || !commandMatch) return decision("deny", "Upgrade eval command shape is not allowed");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(payloadMatch[1]) as Record<string, unknown>; }
  catch { return decision("deny", "Upgrade eval command JSON is invalid"); }
  if (payload.worktree !== config.worktree) return decision("deny", "Upgrade eval worktree does not match");
  let script: string;
  try { script = realpathSync(commandMatch[1] ?? commandMatch[2] ?? commandMatch[3]); }
  catch { return decision("deny", "Upgrade eval script does not exist"); }
  if (!config.scripts.map((path) => realpathSync(path)).includes(script)) {
    return decision("deny", "Upgrade eval script is outside the released roots");
  }
  const action = commandMatch[4];
  if (basename(script) === "writer-state.mjs") {
    if (!action || !new Set(["status", "enqueue", "claim", "take-input", "finish", "migrate"])
      .has(action)) return decision("deny", "Upgrade eval writer-state action is not allowed");
  } else if (basename(script) === "claude-worker.mjs") {
    if (action) return decision("deny", "Upgrade eval launcher takes no positional arguments");
  } else return decision("deny", "Upgrade eval script is not a production writer entry");
  return decision("allow", "Exact upgrade eval writer command");
}

function main(configPath: string | undefined): void {
  try {
    if (!configPath) throw new Error("missing config");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as GateConfig;
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    process.stdout.write(`${JSON.stringify(claudeRootCommandDecision(input, config))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(decision("deny", "Upgrade eval command gate input invalid"))}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv[2]);
