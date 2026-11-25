import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { committedInputs, inspectInputInventory } from "./main-sync-checks.js";
import { producerFor } from "./main-sync-input-catalog.js";
import { syncFixture } from "./main-sync-test-fixtures.js";

// The ignored Desktop outputs a real build and e2e run left in three laptop 2 checkouts (fleet evidence
// iss14476/item144-real-desktop-ignored-outputs.txt), with the files those run directories held.
const RUN_OUTPUTS = ["playwright-report-e2e/index.html", "playwright-report-e2e/results.json",
  "playwright-report-e2e/dd-quarantine.json", `playwright-report-e2e/data/${"a1".repeat(20)}.md`,
  "test-results-e2e/.last-run.json", "test-results-e2e/liveblocks-editor-shortcut-08cb5-paste-electron/error-context.md",
  "test-results-e2e/dashboard-kpi-1a2b3-values-electron/dashboard-kpi-values.png", ".local/state/gh/device-id",
  ...["", ".e2e", ".renderer", ".scripts", ".tests", ".type-tests"].map((name) => `tsconfig${name}.tsbuildinfo`)]
  .map((file) => `apps/desktop/${file}`);
const GENERATED_SOURCES = ["src/main/database/generated", "src/main/database/migration/migrations-manifest.ts",
  "src/main/docs-help/docs-bundle-manifest.ts", "src/shared/auth-handoff-assets.generated.ts", "src/shared/build-info.ts"]
  .map((file) => `apps/desktop/${file}`);

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

function desktopRun(extra: string[] = []) {
  const value = syncFixture();
  fixtures.push(value);
  value.write(".gitignore", `${readFileSync(join(value.worktree, ".gitignore"), "utf8")}test-results-e2e/\nplaywright-report-e2e/\n*.tsbuildinfo\napps/desktop/.local/\n`);
  value.git(["add", "."]);
  value.git(["commit", "-m", "Desktop run outputs stay ignored"]);
  for (const file of [...RUN_OUTPUTS, ...extra]) value.write(file, "{}");
  return value;
}

describe("AC-91 real Desktop run outputs at main-sync inventory", () => {
  it("AC-91 admits every recorded Desktop report, attachment, build-info cache and leaked tool state as a non-input", () => {
    const value = desktopRun();
    expect(() => inspectInputInventory(value.worktree)).not.toThrow();
  });

  it("AC-91 names each recorded generated Desktop source as a declared producer output", () => {
    const value = desktopRun();
    for (const file of GENERATED_SOURCES) expect(producerFor(value.worktree, file)?.roots, file).toContain(file);
  });

  it("AC-91 still refuses an undeclared executable in a Desktop run directory or another app's results file", () => {
    const extra = ["apps/desktop/test-results-e2e/leftover.json", "apps/web/test-results-e2e/.last-run.json"];
    const value = desktopRun(extra);
    expect(() => inspectInputInventory(value.worktree)).toThrow(/blocking input/);
    const rows = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync-blocking-inputs.json"), "utf8")).paths;
    expect(rows.map((row: { path: string }) => row.path)).toEqual(extra.sort());
  });

  it("AC-91 refuses an undeclared ignored executable a Desktop run leaked under its app directory, outside any run directory", () => {
    const value = desktopRun(["apps/desktop/.local/state/gh/hosts.yml"]);
    expect(() => inspectInputInventory(value.worktree)).toThrow(/^Undeclared git-ignored run output is a blocking input: apps\/desktop\/\.local\/state\/gh\/hosts\.yml\. /);
  });

  // Two gates (team-lead ruling, 2026-11-25): main sync's validation inputs never include a git-ignored file
  // (ISS-14689 AC2), while the inventory still refuses an undeclared ignored run output as a leftover.
  it("AC-91 main sync's committed validation inputs pass an ignored Desktop leftover that the inventory refuses (ISS-14689 AC2)", () => {
    const value = desktopRun(["apps/desktop/test-results-e2e/leftover.json"]);
    expect(() => inspectInputInventory(value.worktree)).toThrow(/^Undeclared git-ignored run output is a blocking input: apps\/desktop\/test-results-e2e\/leftover\.json\. /);
    expect(committedInputs(value.worktree).headSha).toBe(value.git(["rev-parse", "HEAD"]));
  });
});
