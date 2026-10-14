import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CHECK_MS, type MainSyncReceipt } from "./main-sync-contracts.js";
import { discoverCheckLanes } from "./main-sync-lanes.js";
import { storedRecipe } from "./main-sync-validation-recipe.js";
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

  it("records a main import of 2,549 changed paths in a recipe that fits the stored argument bound", () => {
    // ISS-12305 handoff: 2,549 paths since validationSince became one 159,526-character argument.
    const value = syncFixture(); fixtures.push(value);
    const imported = Array.from({ length: 2548 }, (_, index) =>
      `apps/app/imported/bulk-tag-acceptance-main-import-module-${String(index).padStart(4, "0")}.ts`);
    for (const file of imported) value.write(file, "export {};\n");
    value.write("scripts/lint/owned-change.ts", "export {};\n");
    value.git(["add", "."]); value.git(["commit", "-q", "-m", "Main import"]);
    expect(JSON.stringify([...imported, "scripts/lint/owned-change.ts"]).length).toBeGreaterThan(150000);
    process.env.PATH = `${value.bin}:${originalPath}`;
    const receipt = { validationSince: value.baseCommit } as MainSyncReceipt;
    const lanes = discoverCheckLanes(value.worktree, receipt);
    const identity = { headSha: value.git(["rev-parse", "HEAD"]), treeSha: value.git(["rev-parse", "HEAD^{tree}"]), inputSha256: "0".repeat(64) };
    const recipe = storedRecipe(identity, { commands: lanes.commands.map((command) => ({ ...command, timeoutMs: MAX_CHECK_MS })),
      e2eLimitations: lanes.limitations });
    expect(recipe.commands[0]?.argv.at(-1)).toBe(value.baseCommit);
    // The only scripts/ path sorts last, so the owner saw the whole changed set.
    expect(recipe.commands.map((command) => command.argv.join(" "))).toContain("pnpm test:skills");
  }, 120000);
});
