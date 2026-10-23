import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { mcpToolIdentity, type Capability } from "./contracts.js";

/** A launch refused before or at worker start, carrying the one plain step a person can take when there is one. */
export class LaunchPrecheckError extends Error {
  constructor(readonly code: "CLAUDE_SIGN_IN_NEEDED" | "CLAUDE_CLI_MISSING" | "MCP_TOOLS_MISSING" | "MISSING_CAPABILITIES"
    | "USAGE_LIMIT_REACHED",
    message: string, readonly personAction?: string) { super(message); }
}

/** The person's only step when the standalone Claude CLI's sign-in has run out (operator ruling, 2026-10-15). */
export const SIGN_IN_PERSON_ACTION = "Your Claude sign-in on this Mac has run out, so I can't start the helpers that build your change. "
  + "Open the Terminal app (press Cmd and Space, type Terminal, press Return), type claude auth login and press Return, "
  + "then finish signing in in the browser window that opens. Tell me when you're done.";

const AUTH_FAILURE = /oauth (?:session|token)[^\n]*expired|failed to authenticate|please run \/login|invalid api key|not logged in|authentication_error/i;

/** True when Claude's own output says the stored sign-in cannot be used. */
export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text);
}

/**
 * Asks the CLI for its stored sign-in before any worker state changes. Runs from the home folder so no
 * project settings or project MCP servers load. An unreadable answer (an older CLI) is not a refusal;
 * the post-start check below still classifies an expired sign-in.
 */
export function checkClaudeSignIn(command = "claude"): void {
  const status = spawnSync(command, ["auth", "status", "--json"], { cwd: homedir(), encoding: "utf8", timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"] });
  if (status.error && "code" in status.error && status.error.code === "ENOENT") {
    throw new LaunchPrecheckError("CLAUDE_CLI_MISSING", "The claude command is not on this shell's PATH");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(status.stdout ?? ""); } catch { return; }
  if (parsed && typeof parsed === "object" && (parsed as { loggedIn?: unknown }).loggedIn === false) {
    throw new LaunchPrecheckError("CLAUDE_SIGN_IN_NEEDED", "The standalone Claude CLI is signed out", SIGN_IN_PERSON_ACTION);
  }
}

/** Services each role cannot do its job without, beyond the graph every launched role already needs. */
const requiredLiveReads: Readonly<Record<string, readonly string[]>> = {
  "vibe-requirements-worker": ["get_document"],
  "vibe-ticket-worker": ["get_document"],
};

/** Refuses a launch whose parent-discovered capabilities leave out what the role must read. */
export function checkRoleCapabilities(agentName: string, capabilities: readonly Capability[]): void {
  const missing = (requiredLiveReads[agentName] ?? []).filter((operation) => !capabilities.some((capability) =>
    capability.service === "closedloop" && capability.access === "read" && capability.operation === operation));
  if (missing.length) {
    throw new LaunchPrecheckError("MISSING_CAPABILITIES",
      `${agentName} needs ClosedLoop read capabilities: ${missing.join(", ")}; discover and pass them in the parent`);
  }
}

/** The granted MCP tools the started worker does not actually have, from its own init event. */
export function missingMcpTools(initTools: readonly string[], granted: readonly string[]): string[] {
  const available = new Set(initTools.map(mcpToolIdentity).filter((name): name is string => name !== null));
  return granted.filter((name) => {
    const identity = mcpToolIdentity(name);
    return identity !== null && !available.has(identity);
  });
}

/** Names the connections behind missing tools, for the parent's diagnosis (never shown to the person). */
export function missingServers(missing: readonly string[]): string[] {
  return [...new Set(missing.map((name) => name.slice("mcp__".length, name.lastIndexOf("__"))))];
}
