import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CHECK_MS, type MainSyncReceipt } from "./main-sync-contracts.js";
import { discoverRequiredE2eLanes } from "./main-sync-lanes.js";
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
  it("bounds discovery by the fixed check budget and runs no selected lane locally", () => {
    // Measured on the ISS-12305 acceptance copy: 2,178 changed paths after a main import took 141 s to 8.5 min.
    const value = syncFixture(); fixtures.push(value);
    value.write("scripts/lint/owned-change.ts", "export {};\n");
    value.git(["add", "."]); value.git(["commit", "-m", "Owned scripts change"]);
    process.env.PATH = `${value.bin}:${originalPath}`;
    const receipt = { validationSince: value.baseCommit, mainSha: value.baseCommit } as MainSyncReceipt;
    const limitations = discoverRequiredE2eLanes(value.worktree, receipt);
    const discovery = spawned.calls.find((call) => call.command === "pnpm" && call.args.includes("--eval"));
    expect(discovery?.timeout).toBe(MAX_CHECK_MS);
    // The scripts/ change selects the test:skills lane, which is not an e2e lane: CI runs it, nothing here does.
    expect(limitations).toEqual([]);
    expect(spawned.calls.some((call) => call.command === "pnpm" && call.args.includes("test:skills"))).toBe(false);
  }, 60000);

  it("selects lanes from the session's own changes, not the main import merged since the last deploy", () => {
    // ISS-12305 handoff: validationSince..HEAD held 2,585 paths, the captured main..HEAD 84; the owner greps once per path.
    const value = syncFixture(); fixtures.push(value);
    const imported = Array.from({ length: 300 }, (_, index) => `scripts/imported/main-module-${String(index).padStart(3, "0")}.ts`);
    for (const file of imported) value.write(file, "export {};\n");
    value.git(["add", "."]); value.git(["commit", "-q", "-m", "Main import"]);
    const mainSha = value.git(["rev-parse", "HEAD"]);
    value.write("apps/app/feature.ts", "export const feature = true;\n");
    value.git(["add", "."]); value.git(["commit", "-q", "-m", "Session change"]);
    process.env.PATH = `${value.bin}:${originalPath}`;
    const receipt = { validationSince: value.baseCommit, mainSha } as MainSyncReceipt;
    discoverRequiredE2eLanes(value.worktree, receipt);
    const discovery = spawned.calls.find((call) => call.command === "pnpm" && call.args.includes("--eval"));
    expect(discovery?.args.at(-1)).toBe(mainSha);
  }, 60000);
});
