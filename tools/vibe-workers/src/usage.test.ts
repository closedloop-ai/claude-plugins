import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphOperations, liveReadOperations, recordOperations } from "./contracts.js";
import { bundleDirectory } from "./test-fixtures.js";

const run = (bundle: string, args: string[]) => spawnSync(process.execPath, [join(bundleDirectory, bundle), ...args],
  { input: "", encoding: "utf8" });

describe("worker CLI usage mode (ISS-13291)", () => {
  it.each(["help", "--help", "-h"])("writer-state.mjs %s prints usage and the bindable capability set", word => {
    const result = run("writer-state.mjs", [word]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: writer-state.mjs <action> < request.json");
    expect(result.stdout).toContain("capabilities left out keeps the recorded binding's");
    expect(result.stdout).toContain("at most 48");
    for (const operation of [...graphOperations, ...liveReadOperations, ...recordOperations]) expect(result.stdout).toContain(operation);
  });

  it.each(["help", "--help", "-h"])("claude-worker.mjs %s prints usage instead of a failed turn", word => {
    const result = run("claude-worker.mjs", [word]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: claude-worker.mjs < launch.json");
    expect(result.stdout).not.toContain("WORKER_TURN_FAILED");
  });

  it("claude-worker.mjs names an argument mistake as an invalid request", () => {
    const result = run("claude-worker.mjs", ["--worktree", "x"]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "BLOCKED", code: "INVALID_REQUEST" });
  });
});
