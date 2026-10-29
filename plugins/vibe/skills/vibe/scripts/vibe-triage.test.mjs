import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONS, CLASSES, E2E_SOURCE, POLICY, POLICY_STEPS, classify, parsePathList, pathKind, validateManifest } from "./vibe-triage.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "vibe-triage.mjs");
const run = (args) => spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

const BACKEND_PATHS = ["apps/api/app/documents/route.ts", "apps/api/app/documents/route.test.ts", "packages/api/src/types/audit.ts"];
const WEB_UI_PATHS = ["apps/app/components/header.tsx", "apps/app/components/footer.tsx"];

test("paths decide the class: backend only, docs only, one UI file, several UI files, UI with backend, metric, prototypes", () => {
  assert.equal(classify({ paths: BACKEND_PATHS }).class, CLASSES.Backend);
  assert.equal(classify({ paths: ["docs/guide.md", "scripts/deploy/run.sh", "e2e/helpers/auth.ts"] }).class, CLASSES.DocsConfig);
  assert.equal(classify({ paths: ["apps/app/components/header.tsx", "apps/app/components/header.test.tsx"] }).class, CLASSES.TrivialUi);
  assert.equal(classify({ paths: WEB_UI_PATHS }).class, CLASSES.UiFeature);
  assert.equal(classify({ paths: [...WEB_UI_PATHS, ...BACKEND_PATHS] }).class, CLASSES.UiFeature);
  assert.equal(classify({ paths: ["packages/app/cost/cost-card.tsx"] }).class, CLASSES.DataMetric);
  assert.equal(classify({ paths: ["apps/prototypes/a/page.tsx"] }).class, CLASSES.Mockup);
});

test("a path in no known area leaves the class unknown, never guessed", () => {
  const manifest = classify({ paths: ["Dockerfile.unknown-area"] });
  assert.equal(manifest.class, CLASSES.Unknown);
  assert.equal(manifest.steps.environment.decision.action, ACTIONS.Unknown);
  assert.deepEqual(manifest.skipped, []);
});

test("text decides before paths exist, and text that names no one area stays unknown", () => {
  assert.equal(classify({ request: "Add an audit entry to the write path of the documents API route" }).class, CLASSES.Backend);
  assert.equal(classify({ request: "Rename the header on the settings page" }).class, CLASSES.UiFeature);
  assert.equal(classify({ request: "Make me a mockup with fake data" }).class, CLASSES.Mockup);
  assert.equal(classify({ request: "Why does the total cost differ between two screens" }).class, CLASSES.DataMetric);
  assert.equal(classify({ request: "Make it better" }).class, CLASSES.Unknown);
  assert.equal(classify({ request: "The prototype decides the board lanes; the board header lists them" }).class, CLASSES.UiFeature, "a prototype the ticket cites is not a request for a mockup");
});

test("text alone never leaves a step out (replay: title-only text mis-skipped 2 of 9 commits)", () => {
  const manifest = classify({ request: "Add an audit entry to the write path of the documents API route" });
  assert.equal(manifest.class, CLASSES.Backend);
  assert.deepEqual(manifest.evidence.sources, ["text"]);
  for (const id of ["environment", "desktop"]) assert.equal(manifest.steps[id].decision.action, ACTIONS.Unknown, id);
  assert.deepEqual(manifest.skipped, []);
});

test("with touched paths, a backend session defers the environment and skipping Desktop, each logged with reason and evidence", () => {
  const manifest = classify({ paths: BACKEND_PATHS });
  assert.equal(manifest.steps.environment.decision.action, ACTIONS.Defer);
  assert.equal(manifest.steps.desktop.decision.action, ACTIONS.Skip);
  assert.deepEqual(manifest.skipped.map((entry) => entry.step), ["environment", "desktop"]);
  for (const entry of manifest.skipped) {
    assert.ok(entry.reason);
    assert.ok(entry.evidence.length > 0);
  }
});

test("Desktop-relevant evidence keeps Desktop: apps/desktop, packages/app, or the request naming Desktop", () => {
  for (const paths of [["packages/app/sessions/list.tsx", "packages/app/sessions/row.tsx"], ["apps/desktop/src/renderer/a.tsx", "apps/desktop/src/renderer/b.tsx"]]) {
    assert.equal(classify({ paths }).steps.desktop.decision.action, ACTIONS.Run, paths[0]);
  }
  assert.equal(classify({ paths: WEB_UI_PATHS }).steps.desktop.decision.action, ACTIONS.Skip, "web-only UI files name no Desktop surface");
  assert.equal(classify({ paths: WEB_UI_PATHS, request: "Show it on web and Desktop" }).steps.desktop.decision.action, ACTIONS.Run);
  assert.equal(classify({ paths: ["apps/app/a.tsx", "apps/app/b.tsx", "apps/api/x.ts"] }).steps.environment.decision.action, ACTIONS.Run);
});

test("a deferred or skipped step is effective automatically; every other step, and every undecided one, runs", () => {
  const backend = classify({ paths: BACKEND_PATHS });
  assert.equal(backend.steps.environment.effective, ACTIONS.Defer);
  assert.equal(backend.steps.desktop.effective, ACTIONS.Skip);
  for (const id of POLICY_STEPS.filter((step) => step !== "environment" && step !== "desktop")) assert.equal(backend.steps[id].effective, ACTIONS.Run, id);
  for (const input of [{ request: "Make it better" }, { request: "Add an audit entry to the write path of the documents API route" }]) {
    const manifest = classify(input);
    for (const id of POLICY_STEPS) assert.equal(manifest.steps[id].effective, ACTIONS.Run, `${id} ${JSON.stringify(input)}`);
  }
  assert.equal(classify({ paths: ["apps/app/a.tsx", "apps/app/b.tsx", "apps/api/x.ts"] }).steps.environment.effective, ACTIONS.Run, "a UI feature keeps its environment");
});

test("the CLI prints the same automatic defer and skip, with no switch to set", () => {
  const manifest = JSON.parse(run(["classify", "--paths", BACKEND_PATHS.join(",")]).stdout);
  assert.equal(manifest.steps.environment.effective, ACTIONS.Defer);
  assert.equal(manifest.steps.desktop.effective, ACTIONS.Skip);
  assert.equal("applyRecommendations" in manifest, false);
});

test("every class records the policy steps and takes lanes and e2e from test:lanes", () => {
  for (const input of [{ paths: BACKEND_PATHS }, { paths: ["docs/a.md"] }, { paths: WEB_UI_PATHS }, { paths: ["apps/app/a.tsx"] }, { paths: ["apps/prototypes/a.tsx"] }, { request: "Make it better" }]) {
    const manifest = classify(input);
    for (const id of POLICY_STEPS) assert.equal(manifest.steps[id].state, POLICY, id);
    assert.equal(manifest.steps.e2e.source, E2E_SOURCE);
    assert.ok(manifest.steps.review.scope);
    validateManifest(manifest);
  }
  assert.deepEqual(classify({ paths: BACKEND_PATHS }).steps.extraGates.gates, ["workflow-code-review"]);
  assert.deepEqual(classify({ paths: ["packages/app/cost/cost-card.tsx"] }).steps.extraGates.gates, ["logical-qa"]);
});

test("validation rejects a manifest that drops a log entry, a reason, or lets effective disagree with the decision", () => {
  const good = () => structuredClone(classify({ paths: BACKEND_PATHS }));
  validateManifest(good());
  const unlogged = good();
  unlogged.skipped.pop();
  assert.throws(() => validateManifest(unlogged), /skipped must log/);
  const noReason = good();
  noReason.skipped[0].reason = "";
  assert.throws(() => validateManifest(noReason), /needs a reason and evidence/);
  const noEvidence = good();
  noEvidence.steps.desktop.decision.evidence = [];
  assert.throws(() => validateManifest(noEvidence), /without evidence/);
  const moved = good();
  moved.steps.desktop.effective = ACTIONS.Run;
  assert.throws(() => validateManifest(moved), /effective must be "skip"/);
  const waived = good();
  waived.steps.decisionTable.effective = ACTIONS.Skip;
  assert.throws(() => validateManifest(waived), /always runs/);
  const skippedEnv = good();
  skippedEnv.steps.environment.decision.action = ACTIONS.Skip;
  assert.throws(() => validateManifest(skippedEnv), /deferred, never skipped/);
  assert.throws(() => validateManifest({ ...good(), schemaVersion: 2 }), /schemaVersion/);
});

test("check validates a manifest file and exits 1 on a bad one", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-triage-"));
  const file = path.join(dir, "manifest.json");
  const written = run(["classify", "--paths", BACKEND_PATHS.join(","), "--out", file]);
  assert.equal(written.status, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).class, CLASSES.Backend);
  assert.equal(run(["check", "--manifest", file]).status, 0);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
  const bad = run(["check", "--manifest", file]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
});

test("the same input gives the same manifest", () => {
  assert.deepEqual(classify({ paths: BACKEND_PATHS, request: "x" }), classify({ paths: BACKEND_PATHS, request: "x" }));
  assert.deepEqual(parsePathList("a.ts, ./b.ts\nc.ts\n"), ["a.ts", "b.ts", "c.ts"]);
  assert.equal(pathKind("apps/api/app/x.test.ts"), "test");
});
