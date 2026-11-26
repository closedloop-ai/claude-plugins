import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { committedInputs, inspectInputInventory, runLeftovers } from "./main-sync-checks.js";
import { producerFor } from "./main-sync-input-catalog.js";
import { advanceMain, finalMerge, invokeSync, syncFixture } from "./main-sync-test-fixtures.js";

// The ignored Desktop outputs a real build and e2e run left in three laptop 2 checkouts (fleet evidence
// iss14476/item144-real-desktop-ignored-outputs.txt), with the files those run directories held.
const RUN_OUTPUTS = ["playwright-report-e2e/index.html", "playwright-report-e2e/results.json",
  "playwright-report-e2e/dd-quarantine.json", `playwright-report-e2e/data/${"a1".repeat(20)}.md`,
  "test-results-e2e/.last-run.json", "test-results-e2e/liveblocks-editor-shortcut-08cb5-paste-electron/error-context.md",
  "test-results-e2e/dashboard-kpi-1a2b3-values-electron/dashboard-kpi-values.png", ".local/state/gh/device-id",
  ...["", ".e2e", ".renderer", ".scripts", ".tests", ".type-tests"].map((name) => `tsconfig${name}.tsbuildinfo`)]
  .map((file) => `apps/desktop/${file}`);
// A Desktop build's own ignored output on the development machine's symphony-alpha checkout (GR11-B1): build:prereqs
// stages the Session Mesh tool there, and the recipe declares it generated.
const BUILD_OUTPUTS = ["apps/desktop/resources/hooks/closedloop-mesh.cjs"];
const GENERATED_SOURCES = ["src/main/database/generated", "src/main/database/migration/migrations-manifest.ts",
  "src/main/docs-help/docs-bundle-manifest.ts", "src/shared/auth-handoff-assets.generated.ts", "src/shared/build-info.ts"]
  .map((file) => `apps/desktop/${file}`);

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

function desktopRun(extra: string[] = []) {
  const value = syncFixture();
  fixtures.push(value);
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}test-results-e2e/\nplaywright-report-e2e/\n*.tsbuildinfo\napps/desktop/.local/\ntools/build/.out/\n${BUILD_OUTPUTS.join("\n")}\n`);
  value.git(["add", "."]);
  value.git(["commit", "-m", "Desktop run outputs stay ignored"]);
  for (const file of [...RUN_OUTPUTS, ...BUILD_OUTPUTS, ...extra]) value.write(file, "{}");
  return value;
}

describe("AC-91 real Desktop run outputs at main-sync inventory", () => {
  it("AC-91 admits every recorded Desktop report, attachment, build-info cache, declared build output and leaked tool state as a non-input", () => {
    const value = desktopRun();
    expect(() => inspectInputInventory(value.worktree)).not.toThrow();
    expect(runLeftovers(value.worktree)).toEqual([]);
  });

  it("AC-91 names each recorded generated Desktop source as a declared producer output", () => {
    const value = desktopRun();
    for (const file of GENERATED_SOURCES) expect(producerFor(value.worktree, file)?.roots, file).toContain(file);
  });

  it("AC-91 the leftover check still names an undeclared executable in a Desktop run directory or another app's results file", () => {
    const extra = ["apps/desktop/test-results-e2e/leftover.json", "apps/web/test-results-e2e/.last-run.json"];
    const value = desktopRun(extra);
    // An ignored tool output outside the recipe's run scope is never a leftover (ISS-14689 AC2's own example).
    value.write("tools/build/.out/cli.mjs", "export {};\n");
    expect(runLeftovers(value.worktree)).toEqual(extra.sort());
  });

  it("AC-91 the leftover check names an undeclared ignored executable a Desktop run leaked under its app directory, outside any run directory", () => {
    const value = desktopRun(["apps/desktop/.local/state/gh/hosts.yml"]);
    expect(runLeftovers(value.worktree)).toEqual(["apps/desktop/.local/state/gh/hosts.yml"]);
  });

  // Two gates (team-lead ruling, 2026-11-25; GR11-B1): main sync's own inputs, preparation and validation inputs never
  // include a git-ignored file (ISS-14689 AC2), and only the handoff inventory's leftover check names a run leftover.
  it("AC-91 main sync's inputs pass an ignored Desktop leftover that the leftover check names (ISS-14689 AC2)", () => {
    const leftover = "apps/desktop/test-results-e2e/leftover.json";
    const value = desktopRun([leftover]);
    expect(runLeftovers(value.worktree)).toEqual([leftover]);
    expect(inspectInputInventory(value.worktree).headSha).toBe(value.git(["rev-parse", "HEAD"]));
    expect(committedInputs(value.worktree).headSha).toBe(value.git(["rev-parse", "HEAD"]));
  });

  // Precondition for the next test: the same behind-main preparation of a Desktop run scans its inputs.
  it("AC-91 a behind-main preparation of a Desktop run refuses an unignored executable (ISS-14689 AC1)", () => {
    const scanned = desktopRun(["apps/app/scratch.ts"]);
    advanceMain(scanned); finalMerge(scanned);
    const refusing = scanned.start("redeploy");
    try {
      const refused = invokeSync(scanned, "prepare", refusing.context);
      expect(refused.status, refused.stdout).toBe(1);
      expect(String(refused.json?.error)).toMatch(/uncommitted executable apps\/app\/scratch\.ts/);
    } finally { refusing.finish(); }
  });

  it("AC-91 a behind-main preparation passes an ignored Desktop leftover that the leftover check still names (ISS-14689 AC2)", () => {
    const leftover = "apps/desktop/test-results-e2e/leftover.json";
    const value = desktopRun([leftover]);
    advanceMain(value); finalMerge(value);
    const behind = value.start("redeploy");
    try {
      const prepared = invokeSync(value, "prepare", behind.context);
      expect(prepared.status, prepared.stdout).toBe(0);
    } finally { behind.finish(); }
    expect(runLeftovers(value.worktree)).toEqual([leftover]);
  });
});
