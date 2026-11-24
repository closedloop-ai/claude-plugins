import { execFileSync } from "node:child_process";

const INVENTORY_COMMANDS = new Set(["ls-tree", "ls-files"]);
const MAX_INVENTORY_BYTES = 128 * 1024 * 1024;
const DEFAULT_INVENTORY_TIMEOUT_MS = 30_000;

function executeInventory(command, args, { encoding, timeoutMs, maxBuffer }) {
  return execFileSync(command, args, {
    encoding, timeout: timeoutMs, maxBuffer, stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Read a Git tree or index inventory without the default child-process buffer limit.
 * Keep the original record framing. Status-aware callers can adapt their existing runner.
 */
export function readGitInventory(worktree, args, {
  encoding = "utf8",
  timeout = DEFAULT_INVENTORY_TIMEOUT_MS,
  maxBuffer = MAX_INVENTORY_BYTES,
  run = executeInventory,
} = {}) {
  if (typeof worktree !== "string" || worktree.length === 0 || !Array.isArray(args)
    || !INVENTORY_COMMANDS.has(args[0]) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("a worktree and Git inventory command are required");
  }
  return run("git", ["-C", worktree, ...args], { encoding, timeoutMs: timeout, maxBuffer: Math.max(maxBuffer, MAX_INVENTORY_BYTES) });
}
