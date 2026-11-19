import { describe, expect, it, onTestFinished } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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

  it("asks the inventory for the policy phase only, and passes its own refusal through", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scope-intake-policy-"));
    try {
      const payload = JSON.stringify({ pathPolicyFile: null,
        pathPolicySource: { kind: "built-in-default", commit: "a".repeat(40) }, baseCommit: "a".repeat(40) });
      const policyOnly = path.join(dir, "policy-only.mjs");
      writeFileSync(policyOnly, ["import { writeFileSync } from 'node:fs';", "const at = process.argv.indexOf('--phase');",
        "if (process.argv[at + 1] !== 'policy') process.exit(3);", `writeFileSync(process.argv.at(-1), ${JSON.stringify(payload)});`].join("\n"));
      expect(loadPathPolicy(dir, "build", policyOnly).inventory.baseCommit).toBe("a".repeat(40));

      const refusing = path.join(dir, "refusing.mjs");
      // The refusal one operator session saw replaced by "did not return one validated root path policy".
      const refusal = "fetched origin/main does not match the remote's advertised HEAD; fetch origin first";
      writeFileSync(refusing, `process.stdout.write(${JSON.stringify(JSON.stringify({ ok: false, error: refusal }) + "\n")});process.exitCode=1;`);
      expect(() => loadPathPolicy(dir, "build", refusing)).toThrow(`handoff inventory: ${refusal}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("passes its 120 s limit to the inventory when the caller gives none, as the CLI does", () => {
    const seen: Array<number | undefined> = [];
    const spawn = (_command: string, _args: string[], options: { timeout: number }) => {
      seen.push(options.timeout);
      return { status: 1, signal: null, stdout: JSON.stringify({ ok: false, error: "stop here" }), stderr: "" };
    };
    expect(() => loadPathPolicy(tmpdir(), "build", "inventory.mjs", { spawn })).toThrow("handoff inventory: stop here");
    expect(seen).toEqual([120_000]);
  });

  it("stops a policy lookup that runs past its limit with a message naming the step", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scope-intake-timeout-"));
    try {
      const hanging = path.join(dir, "hanging.mjs");
      writeFileSync(hanging, "setInterval(() => {}, 1000);");
      expect(() => loadPathPolicy(dir, "build", hanging, { timeoutMs: 500 }))
        .toThrow(/path policy lookup \(hanging\.mjs --phase policy\) did not finish within 1 s, so no planned file was classified/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the inventory's policy phase runs no repository rule: a fixed handful of git calls", async () => {
    // A vibe branch in a fixture checkout with an origin is all the policy phase reads; no session record is needed.
    const fixtures = await import(fixtureModule.href);
    const { root, home, cleanup } = fixtures.makeHome("vibe-scope-intake-policy-");
    onTestFinished(cleanup);
    const worktree = path.join(home, "symphony-alpha");
    fixtures.makeCheckout({ root, home, checkout: worktree, files: { "vibe-handoff-paths.json": fixtures.SYMPHONY_PATH_POLICY } });
    execFileSync("git", ["-C", worktree, "switch", "-q", "-c", "vibe/policy-count"]);
    const shim = path.join(home, "git-shim");
    mkdirSync(shim);
    const log = path.join(home, "git-calls.log");
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(shim, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
    chmodSync(path.join(shim, "git"), 0o755);
    const inventory = path.resolve(scripts, "../../handoff/scripts/handoff-inventory.mjs");
    const calls = (phase: string) => {
      writeFileSync(log, "");
      const run = spawnSync(process.execPath, [inventory, "--worktree", worktree, "--phase", phase, "--out", path.join(home, `${phase}.json`)],
        { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${shim}${path.delimiter}${process.env.PATH}` } });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      return readFileSync(log, "utf8").split("\n").filter(Boolean);
    };
    const policy = calls("policy");
    const result = JSON.parse(readFileSync(path.join(home, "policy.json"), "utf8"));
    expect(result).toMatchObject({ phase: "policy", pathPolicyFile: "vibe-handoff-paths.json" });
    expect(result).not.toHaveProperty("diffRules");
    // No rule-shaped read (a repository search, history walk or blob batch), and a fixed count that does not grow
    // with the repository: the source identity, the session record and the remote default branch.
    expect(policy.filter((call) => /^(?:-C \S+ )?(?:grep|log|cat-file)\b/.test(call))).toEqual([]);
    expect(policy.length).toBeLessThanOrEqual(30);
  });
});
