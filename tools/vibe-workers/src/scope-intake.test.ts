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
const loaded = () => ({ inventory: {
  branch: "vibe/example", baseCommit: "b".repeat(40), pathPolicyFile: "vibe-handoff-paths.json", pathPolicySource: source,
}, policy });
const classified = (entries: Array<[string, "allowed" | "forbidden" | "outside"]>) =>
  entries.map(([file, disposition]) => ({ file, classification: { disposition, reason: disposition } }));

describe("scope intake classification", () => {
  it("refuses the ISS-12820 scripts-only plan and keeps canonical mixed classifications", () => {
    const planned = [
      "scripts/deploy/check-deployed-destructive-migrations.ts",
      "scripts/lint/check-destructive-migrations.ts",
    ];
    const refused = classifyPlannedPaths({ worktree: "/repo", loaded: loaded(), planned,
      classifications: classified(planned.map((file) => [file, "outside"] as [string, "outside"])) });
    expect(refused.ok).toBe(false);
    expect(refused.allOutsideAllowed).toBe(true);
    expect(refused.allowed).toEqual([]);
    expect(refused.outsideAllowed).toEqual([
      "scripts/deploy/check-deployed-destructive-migrations.ts",
      "scripts/lint/check-destructive-migrations.ts",
    ]);
    const mixed = classifyPlannedPaths({ worktree: "/repo", loaded: loaded(),
      planned: ["packages/app/issues/list.tsx", "scripts/lint/check-destructive-migrations.ts"],
      classifications: classified([
        ["packages/app/issues/list.tsx", "allowed"],
        ["scripts/lint/check-destructive-migrations.ts", "outside"],
      ]) });
    expect(mixed.ok).toBe(true);
    expect(mixed.allowed).toEqual(["packages/app/issues/list.tsx"]);
  });

  it("keeps forbidden paths distinct from paths outside the allowlist", () => {
    const result = classifyPlannedPaths({ worktree: "/repo", loaded: loaded(),
      planned: [".github/workflows/release.yml", "scripts/release.mjs", "packages/app/page.tsx"],
      classifications: classified([
        [".github/workflows/release.yml", "forbidden"],
        ["scripts/release.mjs", "outside"],
        ["packages/app/page.tsx", "allowed"],
      ]) });
    expect(result.forbidden).toEqual([".github/workflows/release.yml"]);
    expect(result.outsideAllowed).toEqual(["scripts/release.mjs"]);
    expect(result.allowed).toEqual(["packages/app/page.tsx"]);
  });
});
