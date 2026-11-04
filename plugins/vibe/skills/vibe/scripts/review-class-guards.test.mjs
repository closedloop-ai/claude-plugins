import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  alwaysLoadedRuleFindings,
  environmentInventory,
  realPathClassifierFindings,
  reviewClassGuard,
  subprocessStatusFindings,
} from "./review-class-guards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../../../");
const BASELINE = JSON.parse(readFileSync(path.join(HERE, "review-class-guard-baseline.json"), "utf8"));
const PATHS = JSON.parse(readFileSync(path.join(HERE, "review-class-path-fixture.json"), "utf8"));

function temporaryRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-review-class-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, relative, content) {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

test("the review-class guard passes the current raw repository", async () => {
  const result = await reviewClassGuard(ROOT);
  assert.deepEqual(result.problems, []);
  const names = result.inventory.environment.map((entry) => entry.name);
  assert(BASELINE.configurationEnvironment.every((name) => names.includes(name)));
});

test("mutation proof: parsing stdout without process status fails", (t) => {
  const root = temporaryRoot(t);
  put(root, "plugins/vibe/skills/vibe/scripts/bad-runtime.mjs", 'const checked = parseLaneCheck(run("check").stdout);\n');
  assert.deepEqual(subprocessStatusFindings(root), [
    'plugins/vibe/skills/vibe/scripts/bad-runtime.mjs:direct-stdout:run("check").stdout',
  ]);
});

test("mutation proof: a default-on switch fails while an explicit opt-in passes", (t) => {
  const root = temporaryRoot(t);
  put(root, "plugins/vibe/skills/vibe/scripts/switches.mjs", [
    'export const bad = process.env.VIBE_BAD_SWITCH !== "0";',
    'export const good = process.env.FLEET_GOOD_SWITCH === "1";',
    "",
  ].join("\n"));
  const inventory = environmentInventory(root, BASELINE);
  assert.equal(inventory.find((entry) => entry.name === "VIBE_BAD_SWITCH")?.classification, "unreviewed-default-on");
  assert.equal(inventory.find((entry) => entry.name === "FLEET_GOOD_SWITCH")?.classification, "default-off");
});

test("the reviewed ENV object pattern exposes a default-on heavy budget", (t) => {
  const root = temporaryRoot(t);
  put(root, "plugins/vibe/skills/vibe/scripts/heavy-budget.mjs", [
    'export const ENV = Object.freeze({ off: "VIBE_HEAVY_BUDGET", wait: "VIBE_HEAVY_WAIT" });',
    'const OFF_VALUES = new Set(["off", "0", "false", "no"]);',
    'export const budgetDisabled = (env) => OFF_VALUES.has(String(env[ENV.off] ?? "").trim().toLowerCase());',
    "",
  ].join("\n"));
  const inventory = environmentInventory(root, BASELINE);
  assert.equal(inventory.find((entry) => entry.name === "VIBE_HEAVY_BUDGET")?.classification, "unreviewed-default-on");
});

test("mutation proof: dropping a real Desktop Prisma path fails", async (t) => {
  const root = temporaryRoot(t);
  put(root, "plugins/vibe/skills/handoff/scripts/handoff-inventory.mjs", [
    'const BACKEND_PREFIXES = ["apps/api/"];',
    'const BACKEND_SEGMENTS = ["/migrations/"];',
    "",
  ].join("\n"));
  const findings = await realPathClassifierFindings(root, PATHS);
  assert(findings.includes("backend:desktop-prisma-seed-coverage:apps/desktop/prisma/seed-coverage/Agent.json"));
});

test("mutation proof: moving a critical rule out of its raw skill fails", (t) => {
  const root = temporaryRoot(t);
  for (const relative of [
    "plugins/vibe/skills/fleet-orchestrator/SKILL.md",
    "plugins/vibe/skills/handoff/SKILL.md",
    "plugins/vibe/skills/vibe/SKILL.md",
  ]) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ROOT, relative), target);
  }
  const fleet = path.join(root, "plugins/vibe/skills/fleet-orchestrator/SKILL.md");
  writeFileSync(fleet, readFileSync(fleet, "utf8").replace(
    "A writer starts only once its plan holds a numbered acceptance-criteria list",
    "A writer reads its criteria later",
  ));
  assert(alwaysLoadedRuleFindings(root).includes(
    "writer-acceptance-gate:plugins/vibe/skills/fleet-orchestrator/SKILL.md",
  ));
});
