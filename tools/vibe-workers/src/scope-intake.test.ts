import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPathPolicy } from "./scope-intake.js";

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
  it("refuses scripts-only work", async () => {
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
    } finally { fixture.cleanup(); }
  });

  it("keeps mixed classifications", async () => {
    const fixture = await session();
    try {
      const pathOutside = "scripts/lint/check-destructive-migrations.ts";
      const mixed = fixture.runNode(scope, ["--worktree", fixture.worktree, "--phase", "build",
        "--path", "packages/app/issues/list.test.tsx", "--path", pathOutside], fixture.home);
      expect(mixed.status).toBe(0);
      expect(mixed.json.ok).toBe(true);
      expect(mixed.json.allowed).toEqual(["packages/app/issues/list.test.tsx"]);
      expect(mixed.json.outsideAllowed).toEqual([pathOutside]);
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

  it("accepts literal Next.js bracket routes and classifies an untracked planned file", async () => {
    const fixture = await session();
    try {
      const route = "apps/app/app/(authenticated)/[orgSlug]/branches/page.tsx";
      mkdirSync(path.dirname(path.join(fixture.worktree, route)), { recursive: true });
      writeFileSync(path.join(fixture.worktree, route), "export default function Page() {}\n");
      const result = fixture.runNode(scope, ["--worktree", fixture.worktree, "--phase", "build", "--path", route], fixture.home);
      expect(result.status).toBe(0);
      expect(result.json.allowed).toEqual([route]);
    } finally { fixture.cleanup(); }
  });

  it("reads inventory JSON from its dedicated file and reports a bounded child diagnostic", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scope-intake-channel-"));
    try {
      const valid = path.join(dir, "valid.mjs");
      const payload = JSON.stringify({ pathPolicyFile: null,
        pathPolicySource: { kind: "built-in-default", commit: "a".repeat(40) }, baseCommit: "a".repeat(40) });
      writeFileSync(valid, ["import { writeFileSync } from 'node:fs';", "const out = process.argv.at(-1);",
        "process.stdout.write('w'.repeat(2 * 1024 * 1024));", `writeFileSync(out, ${JSON.stringify(payload)});`].join("\n"));
      expect(loadPathPolicy(dir, "build", valid).inventory.pathPolicySource?.kind).toBe("built-in-default");

      const invalid = path.join(dir, "invalid.mjs");
      writeFileSync(invalid, "process.stdout.write('warning before json\\n');process.stderr.write('inventory failed\\n');process.exitCode=7;");
      expect(() => loadPathPolicy(dir, "build", invalid)).toThrow(/exit 7, signal none, stdout 20 bytes: warning before json, stderr: inventory failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
