import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexCaseId } from "./eval-collector.ts";
import { splitCodexArms } from "./eval-codex-arms.ts";
import { partitionEvalCases } from "./eval-driver.ts";
import { evalCaseCatalog } from "./eval-selection.ts";

const vibeDir = join(dirname(fileURLToPath(import.meta.url)), "../../../plugins/vibe");
const runner = join(vibeDir, "evals/codex/run.py");

function listed(arm: string, ids: string[]) {
  // The same isolated PyYAML the driver provisions through uv, so a bare system python is not required.
  return spawnSync("uv", ["run", "--with", "PyYAML", "python", runner, "--list", "--arm", arm,
    ...ids.flatMap((id) => ["--case", codexCaseId(id)])], { encoding: "utf8" });
}

test("ISS-14116 the nightly's exact ordinary selection is accepted by run.py once split by arm", () => {
  const catalog = evalCaseCatalog(vibeDir);
  const { ordinary } = partitionEvalCases(catalog, catalog.map((item) => item.id));
  assert.ok(ordinary.length >= 120, "the real nightly selection is the whole ordinary corpus");
  const arms = splitCodexArms(vibeDir, ordinary);
  assert.ok(arms.generic.length > 0 && arms.provider.length > 0);
  assert.equal(arms.generic.length + arms.provider.length, ordinary.length);

  const rejected = listed("provider", ordinary);
  assert.equal(rejected.status, 2, "one provider-arm invocation for everything is what failed the nightly");
  assert.match(rejected.stderr, /unknown or empty case selection/);

  for (const arm of ["provider", "generic"] as const) {
    const accepted = listed(arm, arms[arm]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(accepted.stdout.trim().split("\n").sort(), arms[arm].map(codexCaseId).sort());
  }
});

test("ISS-14116 an ordinary case runs in the arm its generic tag names", () => {
  const arms = splitCodexArms(vibeDir, ["pm-generic-repo-gates-not-shipped", "pm-done-asks-two-way"]);
  assert.deepEqual(arms, { provider: ["pm-done-asks-two-way"], generic: ["pm-generic-repo-gates-not-shipped"] });
});
