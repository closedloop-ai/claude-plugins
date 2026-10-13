import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CHECK_MS, type MainSyncReceipt } from "./main-sync-contracts.js";
import { discoverCheckLanes } from "./main-sync-lanes.js";
import { syncFixture } from "./main-sync-test-fixtures.js";

const spawned = vi.hoisted(() => ({ calls: [] as { command: string; args: readonly string[]; timeout: unknown }[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: (command: string, args: readonly string[], options: childProcess.SpawnSyncOptions) => {
    spawned.calls.push({ command, args, timeout: options?.timeout });
    return actual.spawnSync(command, args, options);
  } };
});

const fixtures: ReturnType<typeof syncFixture>[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  spawned.calls.length = 0;
  process.env.PATH = originalPath;
  for (const value of fixtures.splice(0)) value.cleanup();
});

describe("owning test-lane discovery", () => {
  it("bounds discovery by the fixed check budget it later runs under as a selected command", () => {
    // Measured on the ISS-12305 acceptance copy: 2,178 changed paths after a main import took 141 s to 8.5 min.
    const value = syncFixture(); fixtures.push(value);
    value.write("scripts/lint/owned-change.ts", "export {};\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Owned scripts change"]);
    process.env.PATH = `${value.bin}:${originalPath}`;
    const receipt = { validationSince: value.baseCommit } as MainSyncReceipt;
    const lanes = discoverCheckLanes(value.worktree, receipt);
    const discovery = spawned.calls.find((call) => call.command === "pnpm" && call.args.includes("--eval"));
    expect(discovery?.timeout).toBe(MAX_CHECK_MS);
    expect(lanes.commands[0]?.argv).toEqual(["pnpm", ...(discovery?.args ?? [])]);
    expect(lanes.commands[0]?.timeoutMs).toBeUndefined();
    expect(lanes.commands.map((command) => command.argv.join(" "))).toContain("pnpm test:skills");
  }, 60000);
});
