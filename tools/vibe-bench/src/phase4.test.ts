import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const REPO = join(import.meta.dirname, "../../..");

test("CI contains only deterministic vibe checks and no model command", () => {
  const workflows = readdirSync(join(REPO, ".github/workflows"))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  const paid = /claude\s+(?:plugin\s+eval|-p|--print)|codex\s+exec|eval-t[12]|vibe-bench[^\n]*(?:baseline|run-local|eval-local)/;
  for (const workflow of workflows) {
    assert.doesNotMatch(readFileSync(join(REPO, ".github/workflows", workflow), "utf8"), paid,
      `${workflow} must not launch a paid model command`);
  }
  const ci = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /tools\/vibe-bench/);
  assert.match(ci, /test_run\.py/);
  assert.equal(readdirSync(join(REPO, ".github/workflows"))
    .includes("vibe-benchmark-gate.yml"), false);
  const template = join(REPO, ".github/pull_request_template.md");
  if (existsSync(template)) assert.doesNotMatch(readFileSync(template, "utf8"), /^## Benchmark$/m);
});

test("paid benchmark entry points refuse hosted automation before setup", () => {
  const cli = join(REPO, "tools/vibe-bench/src/cli.ts");
  for (const args of [
    ["run-local", "/missing", "/missing", "/missing", "/missing"],
    ["baseline", "/missing", "/missing", "a".repeat(40), "/missing", "/missing",
      "/missing", "/missing", "/missing"],
  ]) {
    const result = spawnSync(process.execPath,
      ["--experimental-strip-types", cli, ...args],
      { encoding: "utf8", env: { ...process.env, CI: "true" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /eval-model-calls-forbidden-in-ci/);
  }
});
