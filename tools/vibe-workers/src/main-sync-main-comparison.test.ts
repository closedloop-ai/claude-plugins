import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSync, syncFixture } from "./main-sync-test-fixtures.js";
import { capturedMainArgv } from "./main-sync-main-comparison.js";
import { comparisonBudgetMs, MAIN_BOOTSTRAP_MS, storedRecipe, validationEnvelopeMs } from "./main-sync-validation-recipe.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

const FAILED = /Required validation command failed/;

/** Puts the failure modes and the canonical bootstrap on the captured main, so main and the session share them. */
function setup(failures: Record<string, "always" | "session" | "once">, bootstrap = "#!/usr/bin/env bash\necho bootstrapped\n") {
  const value = syncFixture();
  fixtures.push(value);
  value.write("fixture-failures.json", JSON.stringify(failures));
  value.write(".closedloop-ai/loops-setup.sh", bootstrap);
  value.git(["add", "-f", "fixture-failures.json", ".closedloop-ai/loops-setup.sh"]);
  value.git(["commit", "-m", "Main carries the failure modes and its bootstrap"]);
  value.git(["push", "origin", "HEAD:main"]);
  return value;
}

function validate(value: ReturnType<typeof syncFixture>, purpose: "build" | "handoff") {
  const prepare = value.start("redeploy", purpose);
  try { expect(invokeSync(value, "prepare", prepare.context).status).toBe(0); } finally { prepare.finish(); }
  const source = value.sourceTurn(purpose);
  try { return invokeSync(value, "validate", source.context); } finally { source.finish(); }
}

const calls = (file: string) => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
const executed = (list: string[][]) => list.filter((call) => !call.includes("--dry=json") && call[1] !== "node");
const receipt = (value: ReturnType<typeof syncFixture>) => JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
const worktrees = (value: ReturnType<typeof syncFixture>) => value.git(["worktree", "list", "--porcelain"]).split("\n")
  .filter((line) => line.startsWith("worktree ")).length;

describe("handoff failures compared against the captured main (operator ruling, 2026-10-16)", () => {
  it("records a check that also fails on the captured main and publishes anyway", () => {
    const value = setup({ "check:source-gates": "always", "typecheck:affected": "always", "turbo typecheck": "always" });
    const result = validate(value, "handoff");
    expect(result.status, result.stdout).toBe(0);
    const mainSha = value.git(["rev-parse", "origin/main"]);
    expect(result.json?.mainSync).toMatchObject({ status: "DONE", publicationReady: true, mainSha });
    const failures = (result.json?.mainSync as { mainPreexistingFailures: { check: string; mainArgv: string[] }[] }).mainPreexistingFailures;
    expect(failures.map((item) => item.check)).toEqual(["pnpm check:source-gates", "pnpm typecheck:affected",
      expect.stringMatching(/^pnpm turbo typecheck --filter=\.\.\.\[[a-f0-9]{40}\] --concurrency=1$/)]);
    // A diff-relative selector runs the same task over the packages the session selected, never main's own diff.
    expect(failures[1]!.mainArgv).toEqual(["pnpm", "turbo", "typecheck", "--filter=app", "--concurrency=1"]);
    const stored = receipt(value).validation.commands.filter((command: { comparison?: unknown }) => command.comparison);
    expect(stored).toHaveLength(3);
    for (const command of stored) {
      expect(command.exitCode).toBe(1);
      expect(command.comparison).toMatchObject({ classification: "main-preexisting", mainSha, main: { outcome: "failed", exitCode: 1 } });
      expect(command.comparison.sessionRuns).toHaveLength(1);
      expect(readFileSync(command.comparison.main.log, "utf8")).toContain("fixture failure");
    }
    // Only the failing checks ran on main, once each, after one bootstrap; the checkout is gone.
    expect(executed(calls(join(value.metadata, "main-checkout-calls.jsonl")))).toEqual([["check:source-gates"],
      ["turbo", "typecheck", "--filter=app", "--concurrency=1"], ["turbo", "typecheck", "--filter=app", "--concurrency=1"]]);
    expect(worktrees(value)).toBe(1);
    const publish = value.start("redeploy", "handoff");
    try {
      const pushed = invokeSync(value, "push", publish.context);
      expect(pushed.status, pushed.stdout).toBe(0);
      expect(value.git(["ls-remote", "origin", "refs/heads/vibe/test"]).split("\t")[0]).toBe(value.git(["rev-parse", "HEAD"]));
    } finally { publish.finish(); }
  }, 60000);

  it("blocks a check that passes on the captured main and fails again on the session commit", () => {
    const value = setup({ "check:source-gates": "session" });
    const result = validate(value, "handoff");
    expect(result.status).toBe(1);
    expect(String(result.json?.error)).toMatch(FAILED);
    expect(String(result.json?.error)).toMatch(/passes on captured main [a-f0-9]{40} and failed again on a rerun.*session-caused/);
    const stored = receipt(value);
    expect(stored.validation).toBeUndefined();
    expect(stored.failedChecks).toHaveLength(1);
    expect(stored.failedChecks[0].comparison).toMatchObject({ classification: "session-caused", main: { outcome: "passed", exitCode: 0 } });
    expect(stored.failedChecks[0].comparison.sessionRuns.map((run: { exitCode: number }) => run.exitCode)).toEqual([1, 1]);
    expect(executed(calls(join(value.metadata, "validation-calls.jsonl"))).filter((call) => call[0] === "check:source-gates")).toHaveLength(2);
    expect(worktrees(value)).toBe(1);
  }, 60000);

  it("passes a flaky check that passes on main and on its one session rerun, keeping both session runs", () => {
    const value = setup({ "check:source-gates": "once" });
    const result = validate(value, "handoff");
    expect(result.status, result.stdout).toBe(0);
    expect(result.json?.mainSync).not.toHaveProperty("mainPreexistingFailures");
    expect((result.json?.mainSync as { flakyChecks: unknown[] }).flakyChecks).toHaveLength(1);
    const command = receipt(value).validation.commands.find((item: { argv: string[] }) => item.argv.join(" ") === "pnpm check:source-gates");
    expect(command).toMatchObject({ exitCode: 0, comparison: { classification: "flaky", main: { outcome: "passed" } } });
    expect(command.comparison.sessionRuns.map((run: { exitCode: number }) => run.exitCode)).toEqual([1, 0]);
    expect(command.log).toBe(command.comparison.sessionRuns[1].log);
  }, 60000);

  it("treats a check that cannot run on the captured main as session-caused without a rerun", () => {
    const value = setup({ "check:source-gates": "always" }, "#!/usr/bin/env bash\necho install failed >&2\nexit 3\n");
    const result = validate(value, "handoff");
    expect(result.status).toBe(1);
    expect(String(result.json?.error)).toMatch(/could not run on captured main [a-f0-9]{40} \(the captured main bootstrap exited 3\), so it is treated as session-caused/);
    const comparison = receipt(value).failedChecks[0].comparison;
    expect(comparison).toMatchObject({ classification: "session-caused", main: { outcome: "unrunnable" } });
    expect(comparison.sessionRuns).toHaveLength(1);
    expect(executed(calls(join(value.metadata, "main-checkout-calls.jsonl")))).toEqual([]);
    expect(worktrees(value)).toBe(1);
  }, 60000);

  it("keeps a build-loop failure blocking without a main comparison", () => {
    const value = setup({ "typecheck:affected": "always" });
    const result = validate(value, "build");
    expect(result.status).toBe(1);
    expect(String(result.json?.error)).toMatch(/^Required validation command failed: pnpm typecheck:affected; private log /);
    expect(existsSync(join(value.metadata, "main-checkout-calls.jsonl"))).toBe(false);
    expect(receipt(value).failedChecks).toBeUndefined();
  }, 60000);
});

describe("captured-main command and budget", () => {
  it("pins every diff-relative selector to the session's selected packages and refuses a missing file", () => {
    const tasks = { tasks: [{ taskId: "api#test", package: "api" }, { taskId: "app#test", package: "app" }, { taskId: "db#build", package: "db" }] };
    const sha = "a".repeat(40);
    expect(capturedMainArgv("/unused", sha, { argv: ["pnpm", "test:affected", "--continue"] }, tasks))
      .toEqual({ argv: ["pnpm", "turbo", "test", "--filter=api", "--filter=app", "--continue"] });
    expect(capturedMainArgv("/unused", sha, { argv: ["pnpm", "turbo", "test", `--filter=...[${sha}]`, "--continue"] }, tasks))
      .toEqual({ argv: ["pnpm", "turbo", "test", "--filter=api", "--filter=app", "--continue"] });
    expect(capturedMainArgv("/unused", sha, { argv: ["pnpm", "test:affected", "--continue"] }, undefined))
      .toHaveProperty("reason");
    expect(capturedMainArgv("/unused", sha, { argv: ["pnpm", "check:source-gates"] }, undefined))
      .toEqual({ argv: ["pnpm", "check:source-gates"] });
    const value = syncFixture();
    fixtures.push(value);
    const head = value.git(["rev-parse", "HEAD"]);
    expect(capturedMainArgv(value.worktree, head, { argv: ["pnpm", "exec", "biome", "check", "apps/app/probe.ts"] }, undefined))
      .toEqual({ argv: ["pnpm", "exec", "biome", "check", "apps/app/probe.ts"] });
    expect(capturedMainArgv(value.worktree, head, { argv: ["pnpm", "exec", "biome", "check", "apps/app/new.ts"] }, undefined))
      .toEqual({ reason: "the checked file apps/app/new.ts does not exist on captured main" });
  });

  it("reserves one bootstrap plus a main run and a rerun per check in the Claude envelope, bound to the recipe", () => {
    const identity = { headSha: "b".repeat(40), treeSha: "c".repeat(40), inputSha256: "d".repeat(64) };
    const commands = [{ argv: ["pnpm", "check:source-gates"], timeoutMs: 1000 }, { argv: ["pnpm", "test"], timeoutMs: 4000 }];
    expect(comparisonBudgetMs(commands)).toBe(MAIN_BOOTSTRAP_MS + 10000);
    const plain = storedRecipe(identity, { commands, e2eLimitations: [] });
    const compared = storedRecipe(identity, { commands, e2eLimitations: [], comparison: { timeoutMs: comparisonBudgetMs(commands) } });
    expect(compared.recipeSha256).not.toBe(plain.recipeSha256);
    expect(validationEnvelopeMs(compared) - validationEnvelopeMs(plain)).toBe(MAIN_BOOTSTRAP_MS + 10000);
    expect(() => validationEnvelopeMs({ ...compared, comparison: { timeoutMs: 1 } })).toThrow(/comparison reserve/);
  });
});
