import { describe, expect, it } from "vitest";
import { classifyPlannedPaths } from "./scope-intake.js";

const policy = {
  version: 1 as const,
  allowedPrefixes: ["packages/app/"],
  allowedFiles: [] as string[],
  forbiddenPrefixes: [".github/"],
  forbiddenBasenames: ["AGENTS.md"],
  rootTests: true,
};
const source = { kind: "base", commit: "a".repeat(40) };
const loaded = (branch = "vibe/example") => ({ inventory: {
  branch, pathPolicyFile: "vibe-handoff-paths.json", pathPolicySource: source,
}, policy });
const rootTests = {
  isRootTest: (file: string) => file.startsWith("e2e/"),
  testSpecPattern: /\.(?:test|spec)\.ts$/,
};

describe("scope intake classification", () => {
  it("refuses the ISS-12820 scripts-only plan and keeps allowed mixed work", () => {
    const refused = classifyPlannedPaths({ worktree: "/repo", phase: "build", loaded: loaded(), planned: [
      "scripts/deploy/check-deployed-destructive-migrations.ts",
      "scripts/lint/check-destructive-migrations.ts",
    ] });
    expect(refused.ok).toBe(false);
    expect(refused.allOutsideAllowed).toBe(true);
    expect(refused.allowed).toEqual([]);
    expect(refused.outsideAllowed).toEqual([
      "scripts/deploy/check-deployed-destructive-migrations.ts",
      "scripts/lint/check-destructive-migrations.ts",
    ]);
    const mixed = classifyPlannedPaths({ worktree: "/repo", phase: "build", loaded: loaded(),
      planned: ["packages/app/issues/list.tsx", "scripts/lint/check-destructive-migrations.ts"] });
    expect(mixed.ok).toBe(true);
    expect(mixed.allowed).toEqual(["packages/app/issues/list.tsx"]);
  });

  it("preserves owned prototype paths and pull-request root tests", () => {
    const prototype = classifyPlannedPaths({ worktree: "/repo", phase: "build", loaded: loaded("prototype/board-mockup"), planned: [
      "apps/prototypes/app/p/board-mockup/page.tsx",
      "apps/prototypes/lib/registry.generated.ts",
      "apps/prototypes/scripts/check-catalog-imports.mjs",
    ] });
    expect(prototype.ok).toBe(true);
    expect(prototype.outsideAllowed).toEqual([]);
    expect(classifyPlannedPaths({ worktree: "/repo", phase: "build", loaded: loaded("prototype/board-mockup"),
      planned: ["apps/prototypes/app/p/other/page.tsx"] }).ok).toBe(false);
    expect(classifyPlannedPaths({ worktree: "/repo", phase: "build", loaded: loaded(), rootTests,
      planned: ["e2e/issues.spec.ts"] }).ok).toBe(false);
    expect(classifyPlannedPaths({ worktree: "/repo", phase: "pull-request", loaded: loaded(), rootTests,
      planned: ["e2e/issues.spec.ts"] }).allowed).toEqual(["e2e/issues.spec.ts"]);
  });
});
