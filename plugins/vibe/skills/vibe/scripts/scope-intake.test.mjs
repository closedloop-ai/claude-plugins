import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeCheckout, makeHome, portableSurfaceChecker, runNode, SYMPHONY_PATH_POLICY } from "./test-fixtures.mjs";
import { readAssembled } from "./skill-split.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCOPE = path.join(HERE, "dist", "scope-intake.mjs");
const SESSIONS = path.join(HERE, "vibe-sessions.mjs");
const OPERATOR = ["--operator-id", "user-operator", "--operator-email", "operator@example.com"];

function session(t, prototype = false) {
  const fixture = makeHome("vibe-scope-intake-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.home, "symphony-alpha");
  makeCheckout({ ...fixture, checkout, files: {
    "vibe-handoff-paths.json": SYMPHONY_PATH_POLICY,
    "packages/app/issues/list.test.tsx": "test('list', () => {});\n",
    "apps/prototypes/scripts/check-catalog-imports.mjs": portableSurfaceChecker([]),
  } });
  const args = prototype
    ? ["new-prototype", "--repo", checkout, "--slug", "board-mockup", "--summary", "Board mockup", ...OPERATOR]
    : ["new", "--repo", checkout, "--slug", "destructive-gate", "--summary", "Destructive gate", "--mode", "seeded", ...OPERATOR];
  const created = runNode(SESSIONS, args, fixture.home);
  assert.equal(created.status, 0, created.stderr);
  return { ...fixture, worktree: created.json.session.worktree };
}

test("ISS-12820 scripts-only work is refused at intake before source is built", (t) => {
  const value = session(t);
  const refused = runNode(SCOPE, ["--worktree", value.worktree, "--phase", "build",
    "--path", "scripts/lint/check-destructive-migrations.ts",
    "--path", "scripts/deploy/check-deployed-destructive-migrations.ts"], value.home);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.allOutsideAllowed, true);
  assert.equal(refused.json.pathPolicySource.kind, "base");
  assert.deepEqual(refused.json.allowed, []);
  assert.deepEqual(refused.json.outsideAllowed, [
    "scripts/deploy/check-deployed-destructive-migrations.ts",
    "scripts/lint/check-destructive-migrations.ts",
  ]);
});

test("intake preserves owned prototype paths, pull-request root tests, and canonical routing", (t) => {
  const prototype = session(t, true);
  const owned = runNode(SCOPE, ["--worktree", prototype.worktree, "--phase", "build",
    "--path", "apps/prototypes/app/p/board-mockup/page.tsx",
    "--path", "apps/prototypes/lib/registry.generated.ts",
    "--path", "apps/prototypes/scripts/check-catalog-imports.mjs"], prototype.home);
  assert.equal(owned.status, 0, JSON.stringify(owned.json));
  assert.deepEqual(owned.json.outsideAllowed, []);
  assert.equal(runNode(SCOPE, ["--worktree", prototype.worktree, "--phase", "build",
    "--path", "apps/prototypes/app/p/other/page.tsx"], prototype.home).status, 1);
  writeFileSync(path.join(prototype.worktree, "apps/prototypes/scripts/check-catalog-imports.mjs"),
    portableSurfaceChecker([]).replace(".has(specifier)", ".has(specifier) || true"));
  assert.equal(runNode(SCOPE, ["--worktree", prototype.worktree, "--phase", "build",
    "--path", "apps/prototypes/scripts/check-catalog-imports.mjs"], prototype.home).status, 1,
  "intake rejects the same invalid portable-checker edit as handoff");

  const app = session(t);
  assert.deepEqual(runNode(SCOPE, ["--worktree", app.worktree, "--phase", "build",
    "--path", "packages/app/issues/list.test.tsx"], app.home).json.allowed,
  ["packages/app/issues/list.test.tsx"], "an existing modified test is a build-phase repair");
  assert.deepEqual(runNode(SCOPE, ["--worktree", app.worktree, "--phase", "build",
    "--path", "packages/app/issues/new.test.tsx"], app.home).json.outsideAllowed,
  ["packages/app/issues/new.test.tsx"], "a new test under an allowed prefix still needs pull-request phase");
  assert.deepEqual(runNode(SCOPE, ["--worktree", app.worktree, "--phase", "pull-request",
    "--path", "packages/app/issues/new.test.tsx"], app.home).json.allowed,
  ["packages/app/issues/new.test.tsx"]);
  assert.equal(runNode(SCOPE, ["--worktree", app.worktree, "--phase", "build",
    "--path", "e2e/issues.spec.ts"], app.home).status, 1);
  assert.deepEqual(runNode(SCOPE, ["--worktree", app.worktree, "--phase", "pull-request",
    "--path", "e2e/issues.spec.ts"], app.home).json.allowed, ["e2e/issues.spec.ts"]);

  const plugin = path.resolve(HERE, "../../..");
  const worker = readAssembled(path.join(plugin, "agents", "vibe-change-worker.md"));
  const quality = readAssembled(path.join(plugin, "skills", "vibe", "references", "quality-loop.md"));
  const guardrails = readAssembled(path.join(plugin, "skills", "vibe", "references", "guardrails.md"));
  assert.match(worker, /dist\/scope-intake\.mjs[\s\S]*before any source edit/);
  assert.match(worker, /allOutsideAllowed[\s\S]*Engineering needed \(forbidden path\)[\s\S]*`BLOCKED`/);
  assert.match(quality, /planned file[\s\S]*dist\/scope-intake\.mjs[\s\S]*before implementation/);
  assert.match(guardrails, /complete planned file list[\s\S]*Engineering needed \(forbidden path\)[\s\S]*`BLOCKED`/);
});
