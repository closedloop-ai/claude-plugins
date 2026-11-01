import { execFile, spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpToolIdentity, type Capability } from "./contracts.js";

/** A launch refused before or at worker start, carrying the one plain step a person can take when there is one. */
export class LaunchPrecheckError extends Error {
  constructor(readonly code: "CLAUDE_SIGN_IN_NEEDED" | "CLAUDE_CLI_MISSING" | "MCP_TOOLS_MISSING" | "MISSING_CAPABILITIES"
    | "USAGE_LIMIT_REACHED" | "PROTECTED_PATH_HOOK_UNAVAILABLE",
    message: string, readonly personAction?: string) { super(message); }
}

const MINIMUM_PROTECTED_HOOK_VERSION = [2, 1, 295] as const;

function protectedHookPath(pluginRoot: string): string {
  const unavailable = (reason: string) => new LaunchPrecheckError("PROTECTED_PATH_HOOK_UNAVAILABLE",
    `The headless Claude writer's protected-path hook is unavailable: ${reason}`);
  const hookPath = join(pluginRoot, "hooks", "protected-write-guard.mjs");
  try {
    if (!lstatSync(hookPath).isFile() || realpathSync(hookPath) !== hookPath) {
      throw unavailable("the installed guard must be a regular file");
    }
  } catch (error) {
    if (error instanceof LaunchPrecheckError) throw error;
    throw unavailable("the installed guard is missing or unreadable");
  }
  return hookPath;
}

function checkProtectedVersion(stdout: string, failed: boolean): void {
  const unavailable = (reason: string) => new LaunchPrecheckError("PROTECTED_PATH_HOOK_UNAVAILABLE",
    `The headless Claude writer's protected-path hook is unavailable: ${reason}`);
  const match = /^\s*(\d+)\.(\d+)\.(\d+)(?=[+\-\s]|$)/.exec(stdout);
  if (failed || !match) throw unavailable("the installed Claude Code version could not be checked");
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_PROTECTED_HOOK_VERSION.length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const requiredPart = MINIMUM_PROTECTED_HOOK_VERSION[index] ?? 0;
    if (actualPart < requiredPart) throw unavailable("Claude Code 2.1.295 or newer is required");
    if (actualPart > requiredPart) break;
  }
}

/** The two read-only Claude probes can run at the same time before writer registration. */
function cliProbe(command: string, args: string[], timeout: number): Promise<{ error: Error | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd: homedir(), encoding: "utf8", timeout, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve({ error, stdout }));
  });
}

/** Check the version floor on every persistent launch while the independent sign-in probe runs. */
export async function checkProtectedWriteSupportAsync(pluginRoot: string, command = "claude"): Promise<string> {
  const hookPath = protectedHookPath(pluginRoot);
  const version = await cliProbe(command, ["--version"], 10_000);
  checkProtectedVersion(version.stdout, version.error !== null);
  // This floor includes the documented unattended-prompt option, introduced in 2.1.259.
  return hookPath;
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
  checkClaudeSignInResult(status.stdout ?? "", status.error ?? null);
}

function checkClaudeSignInResult(stdout: string, error: Error | null): void {
  if (error && "code" in error && error.code === "ENOENT") {
    throw new LaunchPrecheckError("CLAUDE_CLI_MISSING", "The claude command is not on this shell's PATH");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return; }
  if (parsed && typeof parsed === "object" && (parsed as { loggedIn?: unknown }).loggedIn === false) {
    throw new LaunchPrecheckError("CLAUDE_SIGN_IN_NEEDED", "The standalone Claude CLI is signed out", SIGN_IN_PERSON_ACTION);
  }
}

/** Async variant for the launcher; it preserves the same sign-in diagnostic. */
export async function checkClaudeSignInAsync(command = "claude"): Promise<void> {
  const status = await cliProbe(command, ["auth", "status", "--json"], 20_000);
  checkClaudeSignInResult(status.stdout, status.error);
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
