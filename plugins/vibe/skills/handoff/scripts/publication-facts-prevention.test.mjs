import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeCheckout, makeHome, PROVIDER_BINDING } from "../../vibe/scripts/test-fixtures.mjs";
import { lanesTouchedSince, sharedMainFailures, verifiedMainCommit } from "../../vibe/scripts/pre-pr-lanes.mjs";
import { gateOverrideEntries, overriddenChecks, readPrBodyEvidence, readPrBodyFile } from "../../../lib/handoff/scripts/gate-override.mjs";
import { knownMainFailureProblems } from "./pr-facts.mjs";
import { currentPrTreeFacts, prBodyClaimProblems } from "./pr-body-claims.mjs";

test("ISS-14476 uses one exact ticketed override and refuses unsupported checks or a substituted body", (t) => {
  const { root, cleanup } = makeHome("vibe-override-exact-");
  t.after(cleanup);
  const approved = "Vibe gate override: ISS-14476: head ownership, visual QA: reviewed exact scope\n";
  const filename = path.join(root, "approved.md");
  const alias = path.join(root, "alias.md");
  writeFileSync(filename, approved);
  symlinkSync(filename, alias);

  const read = readPrBodyEvidence(filename);
  assert.equal(read.fingerprint.sha256, createHash("sha256").update(read.text).digest("hex"));
  assert.equal(readPrBodyFile(filename), approved);
  assert.throws(() => readPrBodyFile(alias), /is not|not a regular file/);
  assert.deepEqual(gateOverrideEntries(approved, PROVIDER_BINDING).map(({ tickets }) => tickets), [["ISS-14476"]]);
  assert.deepEqual([...overriddenChecks(approved, PROVIDER_BINDING)], ["head ownership", "visual QA"]);
  assert.deepEqual([...overriddenChecks(approved.replace("visual QA", "base replay"), PROVIDER_BINDING)], []);
  assert.deepEqual([...overriddenChecks(approved.replace("ISS-14476", "uncited"), PROVIDER_BINDING)], []);
});

test("AC-22 ISS-14476 marks a lane reusable only when every changed input is accounted for", () => {
  const request = { laneSelections: { files: { "app/visible.tsx": ["web", "Desktop"], "ops/repair.mjs": ["touch"] } } };
  assert.deepEqual([...lanesTouchedSince(request, { outcome: "None" })], []);
  assert.deepEqual([...lanesTouchedSince(request, { outcome: "Changed", changedFiles: ["ops/repair.mjs"] })], ["touch"]);
  assert.deepEqual([...lanesTouchedSince(request, { outcome: "Changed", changedFiles: ["app/visible.tsx"] })], ["web", "Desktop"]);
  assert.equal(lanesTouchedSince(request, { outcome: "Changed", changedFiles: ["app/visible.tsx", "new/unknown"] }), null);
});

test("ISS-14476 compares both main failure records and lists the workflow lane by stable name", (t) => {
  const fixture = makeHome("vibe-main-failures-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "checkout");
  makeCheckout({ ...fixture, checkout });
  const result = currentPrTreeFacts(checkout);
  const same = { id: "existing spec", assertion: "value is ready" };
  const run = { status: "main-preexisting", lane: "frontend smoke", mainSha: result.head, failures: [same], mainFailures: [same] };

  assert.equal(verifiedMainCommit(checkout, result.head), result.head);
  assert.throws(() => verifiedMainCommit(checkout, "a".repeat(40)), /exact fetched origin\/main/);
  assert.deepEqual(sharedMainFailures({ branch: [same], main: [same, { id: "other", assertion: "other" }] }), [same]);
  assert.throws(() => sharedMainFailures({ branch: [same], main: [{ ...same, assertion: "different" }] }), /same assertion/);
  assert.equal(knownMainFailureProblems("## Known main failures\n- another lane", { runs: [run] }).length, 1);
  assert.deepEqual(knownMainFailureProblems("## Known main failures\n- frontend smoke on " + result.head, { runs: [run] }), []);
});

test("AC-59 ISS-14476 binds body claims to Git's exact Storybook, count and head instead of dirty source or earlier receipts", (t) => {
  const fixture = makeHome("vibe-pr-tree-facts-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "checkout");
  const manifest = "package.json";
  const history = "release.ts";
  makeCheckout({ ...fixture, checkout, files: {
    ".vibe/storybook-rules.json": JSON.stringify({ release: { versionFile: manifest, historyFiles: [history] } }),
    [manifest]: JSON.stringify({ version: "1.3.0" }),
    [history]: "const releases = [{version:'1.3.0', contents:[{level:'Composites',entries:4,stories:81}]}];",
  } });
  const facts = currentPrTreeFacts(checkout);
  writeFileSync(path.join(checkout, manifest), '{"version":"1.4.0"}');
  const exact = "Storybook 1.3.0 (Composites 81 stories)\nHead: " + facts.head + "\nChanged files: 0\n";
  const stale = "Storybook 1.2.0 (Composites 80 stories)\nHead: " + "f".repeat(40) + "\nChanged files: 1\n";

  assert.equal(facts.storybook.version, "1.3.0");
  assert.equal(currentPrTreeFacts(checkout).storybook.version, "1.3.0");
  assert.deepEqual(prBodyClaimProblems(exact, null, facts), []);
  assert.equal(prBodyClaimProblems(stale, null, facts).length, 4);
  assert.equal(prBodyClaimProblems("All tests passed.", { testRuns: [{ status: "failed", commit: facts.head }] }, facts).length, 1);
  assert.deepEqual(prBodyClaimProblems("All tests passed.", { testRuns: [{ status: "failed", commit: "c".repeat(40) }] }, facts), []);
});
