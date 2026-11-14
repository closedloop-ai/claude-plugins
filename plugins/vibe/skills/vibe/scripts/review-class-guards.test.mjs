import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  alwaysLoadedRuleFindings,
  bareWordClassifierFindings,
  bareWordClassifierProblems,
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

test("ISS-14136: every bare-word classifier in the gate script directories is in the baseline with its reason", () => {
  const found = bareWordClassifierFindings(ROOT);
  assert.deepEqual(bareWordClassifierProblems(found, BASELINE.bareWordClassifiers), []);
  assert.deepEqual(Object.keys(BASELINE.bareWordClassifiers), found, "the baseline holds exactly today's cases");
  assert(Object.values(BASELINE.bareWordClassifiers).every((reason) => typeof reason === "string" && reason.trim().length > 0));
  assert(found.includes("plugins/vibe/skills/handoff/scripts/criterion-surface.mjs:RUNTIME_CRITERION"));
});

test("ISS-14136 mutation proof: a new bare-word classifier fails; a fixed grammar, an exact-case name and other directories do not", (t) => {
  const root = temporaryRoot(t);
  const gate = "plugins/vibe/skills/handoff/scripts/new-gate.mjs";
  put(root, gate, [
    "const MOBILE_WORD = /\\b(?:phone|tablet)\\b/i;",
    "export const TOUCH_TEXT = /touch|tap/gi;",
    "const AUDIT_VERDICT = /^\\|\\s*(MET|PARTIAL|MISSED)\\s*\\|$/i;",
    "const GRID_SYMBOL = /\\bGridTableV2\\b/;",
    "const DATED = /\\b(?:ruling|decision), \\d{4}\\b/i;",
    "",
  ].join("\n"));
  put(root, "plugins/vibe/skills/cl-sweep/scripts/elsewhere.mjs", "const MOBILE_WORD = /\\b(?:phone|tablet)\\b/i;\n");
  put(root, "plugins/vibe/skills/handoff/scripts/new-gate.test.mjs", "const MOBILE_WORD = /\\b(?:phone|tablet)\\b/i;\n");
  const found = bareWordClassifierFindings(root);
  assert.deepEqual(found, [`${gate}:MOBILE_WORD`, `${gate}:TOUCH_TEXT`]);
  const frozen = [`${gate}:TOUCH_TEXT`];
  assert.deepEqual(bareWordClassifierProblems(found, { [`${gate}:TOUCH_TEXT`]: "fixed grammar: the two gesture names the runner prints" }, frozen), [
    `bare-word-classifier:new:${gate}:MOBILE_WORD`,
  ], "a new classifier fails until it is frozen in code");
  assert.deepEqual(bareWordClassifierProblems([`${gate}:TOUCH_TEXT`], { [`${gate}:TOUCH_TEXT`]: "fixed grammar", [`${gate}:GONE`]: "was justified" }, [...frozen, `${gate}:GONE`]),
    [`bare-word-classifier:stale:${gate}:GONE`], "the baseline only shrinks with the code");
  assert.deepEqual(bareWordClassifierProblems(found, { [`${gate}:MOBILE_WORD`]: " ", [`${gate}:TOUCH_TEXT`]: "fixed grammar" }, [...frozen, `${gate}:MOBILE_WORD`]), [`bare-word-classifier:no-reason:${gate}:MOBILE_WORD`]);
});

test("ISS-14136 mutation proof: a whitespace class or an escaped mark between the words does not hide a bare-word classifier", (t) => {
  const root = temporaryRoot(t);
  const gate = "plugins/vibe/skills/vibe/scripts/new-gate.mjs";
  put(root, gate, [
    "const DESKTOP_APP = /\\bdesktop\\s+app\\b/i;",
    "const SPEC_NAME = /\\.spec\\.ts\\b|\\bsmoke\\s*test\\b/i;",
    "const ANY_SPACE = /\\bcheck\\s(?:ran|passed)\\b/i;",
    "const DIGITS = /\\bslot\\s+\\d+\\b/i;",
    "",
  ].join("\n"));
  const found = bareWordClassifierFindings(root);
  assert.deepEqual(found, [`${gate}:ANY_SPACE`, `${gate}:DESKTOP_APP`, `${gate}:SPEC_NAME`], "a digit class is structure, not a word");
  assert.ok(bareWordClassifierProblems(found, {}, []).includes(`bare-word-classifier:new:${gate}:DESKTOP_APP`));
});

test("ISS-14136 mutation proof: a classifier entered in the JSON baseline but not frozen in code fails as baseline-grew", () => {
  const added = "plugins/vibe/skills/handoff/scripts/new-gate.mjs:MOBILE_WORD";
  const found = [...bareWordClassifierFindings(ROOT), added].sort();
  const baseline = { ...BASELINE.bareWordClassifiers, [added]: "classifies prose by bare words; no ruling yet (listed by ISS-14136)" };
  assert.deepEqual(bareWordClassifierProblems(found, baseline), [`bare-word-classifier:baseline-grew:${added}`]);
  assert.deepEqual(bareWordClassifierProblems(found, BASELINE.bareWordClassifiers), [`bare-word-classifier:new:${added}`], "and with no JSON entry it fails as new");
});
