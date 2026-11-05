import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../plugins/vibe/skills/vibe/scripts");
const scope = path.join(scripts, "dist", "scope-intake.mjs");
const sessions = path.join(scripts, "vibe-sessions.mjs");
const fixtureModule = new URL("../../../plugins/vibe/skills/vibe/scripts/test-fixtures.mjs", import.meta.url);
const operator = ["--operator-id", "user-operator", "--operator-email", "operator@example.com"];

async function session() {
  const fixtures = await import(fixtureModule.href);
  const fixture = fixtures.makeHome("vibe-scope-intake-vitest-");
  const checkout = path.join(fixture.home, "symphony-alpha");
  fixtures.makeCheckout({ ...fixture, checkout, files: {
    "vibe-handoff-paths.json": fixtures.SYMPHONY_PATH_POLICY,
    "packages/app/issues/list.test.tsx": "test('list', () => {});\n",
  } });
  const created = fixtures.runNode(sessions, ["new", "--repo", checkout, "--slug", "scope-test",
    "--summary", "Scope test", "--mode", "seeded", ...operator], fixture.home);
  expect(created.status).toBe(0);
  return { ...fixture, worktree: created.json.session.worktree, runNode: fixtures.runNode };
}

describe("scope intake public CLI", () => {
  it("refuses scripts-only work and keeps mixed classifications", async () => {
    const fixture = await session();
    try {
      const paths = ["scripts/deploy/check-deployed-destructive-migrations.ts",
        "scripts/lint/check-destructive-migrations.ts"];
      const refused = fixture.runNode(scope, ["--worktree", fixture.worktree, "--phase", "build",
        ...paths.flatMap((file) => ["--path", file])], fixture.home);
      expect(refused.status).toBe(1);
      expect(refused.json.allOutsideAllowed).toBe(true);
      expect(refused.json.allowed).toEqual([]);
      expect(refused.json.outsideAllowed).toEqual(paths);

      const mixed = fixture.runNode(scope, ["--worktree", fixture.worktree, "--phase", "build",
        "--path", "packages/app/issues/list.test.tsx", "--path", paths[1]], fixture.home);
      expect(mixed.status).toBe(0);
      expect(mixed.json.ok).toBe(true);
      expect(mixed.json.allowed).toEqual(["packages/app/issues/list.test.tsx"]);
      expect(mixed.json.outsideAllowed).toEqual([paths[1]]);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps forbidden paths distinct from paths outside the allowlist", async () => {
    const fixture = await session();
    try {
      const result = fixture.runNode(scope, ["--worktree", fixture.worktree, "--phase", "build",
        "--path", ".github/workflows/release.yml", "--path", "scripts/release.mjs",
        "--path", "packages/app/issues/list.test.tsx"], fixture.home);
      expect(result.status).toBe(0);
      expect(result.json.forbidden).toEqual([".github/workflows/release.yml"]);
      expect(result.json.outsideAllowed).toEqual(["scripts/release.mjs"]);
      expect(result.json.allowed).toEqual(["packages/app/issues/list.test.tsx"]);
    } finally {
      fixture.cleanup();
    }
  });
});
