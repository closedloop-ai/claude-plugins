import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapFor, checkSteps, mainSyncRecipe, reportOutputsFor } from "./main-sync-recipe.js";
import { isDesktopE2eLimitation, desktopE2ePostMergeCoverage } from "./main-sync-lanes.js";
import { inputProducers } from "./main-sync-input-catalog.js";
import { fixture } from "./test-fixtures.js";
import { discoverRequiredE2eLanes } from "./main-sync-lanes.js";
import { pureOriginFiles } from "./main-sync-input-pure.js";
import type { MainSyncReceipt } from "./main-sync-contracts.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

/** A session whose record pins no provider, so ambient chat state cannot bind one. */
function genericSession() {
  const value = fixture();
  fixtures.push(value);
  writeFileSync(join(value.metadata, "vibe-session.json"), JSON.stringify({ worktree: value.worktree, branch: "vibe/test", provider: { state: "none" } }));
  return value;
}

function boundSession() {
  const value = fixture();
  fixtures.push(value);
  return value;
}

describe("main-sync recipe", () => {
  it("binds the provider's matrix, generated inputs, reports, Desktop lane and CI producer in its repository", () => {
    const { worktree } = boundSession();
    const recipe = mainSyncRecipe(worktree);
    expect(recipe.producers.map((producer) => producer.id)).toContain("shared-prisma");
    expect(inputProducers(worktree).length).toBe(recipe.producers.length);
    expect(checkSteps(worktree, "build").steps).toEqual([{ biome: true }, { argv: ["pnpm", "typecheck:affected"] }]);
    expect(checkSteps(worktree, "build").final).toEqual([]);
    expect(checkSteps(worktree, "handoff").steps).toContainEqual({ laneDiscovery: true });
    expect(checkSteps(worktree, "prototype").final[0]).toEqual({ argv: ["pnpm", "turbo", "typecheck", "--filter=...[{mainSha}]", "--concurrency=1"] });
    expect(bootstrapFor(worktree)).toEqual(["bash", ".closedloop-ai/loops-setup.sh"]);
    expect(reportOutputsFor(worktree).has("apps/desktop/playwright-report-e2e/results.json")).toBe(true);
    expect(isDesktopE2eLimitation(worktree, { argv: ["pnpm", "--dir", "apps/desktop", "test:e2e"] })).toBe(true);
    expect(desktopE2ePostMergeCoverage(worktree)).toMatch(/desktop-e2e-validation\.yml/);
    expect(recipe.ci?.workflow).toBe(".github/workflows/e2e-test.yml");
  });

  it("without a provider recipe has no generated inputs, Desktop lane or CI producer, and runs the AGENTS.md test command at handoff", () => {
    const { worktree } = genericSession();
    expect(inputProducers(worktree)).toEqual([]);
    expect(mainSyncRecipe(worktree).ci).toBeUndefined();
    expect(desktopE2ePostMergeCoverage(worktree)).toBeNull();
    expect(isDesktopE2eLimitation(worktree, { argv: ["pnpm", "--dir", "apps/desktop", "test:e2e"] })).toBe(false);
    expect(reportOutputsFor(worktree).has("apps/desktop/playwright-report-e2e/results.json")).toBe(false);
    expect(reportOutputsFor(worktree).has("playwright-report/index.html")).toBe(true);
    expect(checkSteps(worktree, "build")).toEqual({ steps: [], final: [] });
    expect(checkSteps(worktree, "handoff")).toEqual({ steps: [], final: [] });
    writeFileSync(join(worktree, "AGENTS.md"), "# Agents\n\nRun the tests with `npm run test:unit` before pushing.\n");
    expect(checkSteps(worktree, "handoff")).toEqual({ steps: [{ argv: ["npm", "run", "test:unit"] }], final: [] });
    expect(checkSteps(worktree, "prototype").steps).toEqual([{ argv: ["npm", "run", "test:unit"] }]);
    expect(checkSteps(worktree, "build").steps, "the commit hooks own the build loop's checks").toEqual([]);
  });

  it("runs a documented test command with shell syntax through sh, and bootstraps from the lockfile", () => {
    const { worktree } = genericSession();
    writeFileSync(join(worktree, "AGENTS.md"), "Test with `make test && make lint`.\n");
    expect(checkSteps(worktree, "handoff").steps).toEqual([{ argv: ["sh", "-c", "make test && make lint"] }]);
    expect(bootstrapFor(worktree)).toBeNull();
    writeFileSync(join(worktree, "package-lock.json"), "{}\n");
    expect(bootstrapFor(worktree)).toEqual(["npm", "ci"]);
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "");
    expect(bootstrapFor(worktree), "the first lockfile in order wins").toEqual(["pnpm", "install", "--frozen-lockfile"]);
  });

  it("never runs the provider's lane discovery or pure renderers in a generic repository", () => {
    const { worktree } = genericSession();
    // The discovery modules do not exist here, so reaching them would throw; an empty result means none ran.
    expect(discoverRequiredE2eLanes(worktree, { mainSha: "a".repeat(40) } as MainSyncReceipt)).toEqual([]);
    const producer = { id: "desktop-build", roots: ["apps/desktop/src/shared/build-info.ts"], inputs: [], strategy: "pure" as const };
    expect(() => pureOriginFiles(worktree, producer, "a".repeat(40))).toThrow(/declares no pure renderer for desktop-build/);
  });
});
