import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectInputInventory } from "./main-sync-checks.js";
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

  // Main's ISS-14689 AC2 (#446) made no git-ignored file a validation input, so an ignored run directory never blocks;
  // the same undeclared executables, untracked and unignored, still do.
  it("AC-91 refuses an undeclared Desktop or other-app results executable while it is unignored, and never once it is ignored (ISS-14689 AC2)", () => {
    const value = desktopRun(["apps/desktop/test-results-e2e/leftover.json", "apps/web/test-results-e2e/.last-run.json"]);
    expect(() => inspectInputInventory(value.worktree)).not.toThrow();
    const unignored = ["apps/desktop/leftover.json", "apps/web/.last-run.json"];
    for (const file of unignored) value.write(file, "{}");
    expect(() => inspectInputInventory(value.worktree))
      .toThrow(/^Committed validation inputs differ from HEAD: uncommitted executable apps\/desktop\/leftover\.json; uncommitted executable apps\/web\/\.last-run\.json$/);
    const rows = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync-blocking-inputs.json"), "utf8")).paths;
    expect(rows.map((row: { path: string }) => row.path)).toEqual(unignored);
  });
});
