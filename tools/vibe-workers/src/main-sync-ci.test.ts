import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSync, syncFixture, validateFixture } from "./main-sync-test-fixtures.js";
import { installCiFixture, producerContents } from "./main-sync-ci-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });
function pendingHandoff() {
  const value = syncFixture(); fixtures.push(value);
  value.write("apps/desktop/test/reveal-window.spec.ts", "synthetic required Electron scenario\n");
  value.git(["add", "."]); value.git(["commit", "-m", "Final handoff scenario"]);
  const result = validateFixture(value, "handoff");
  expect(result.json?.mainSync).toMatchObject({ status: "NEEDS_REVIEW", publicationReady: true, requiredE2eComplete: false });
  const publication = value.start("redeploy", "handoff");
  try { expect(invokeSync(value, "push", publication.context).status).toBe(0); } finally { publication.finish(); }
  return value;
}
function complete(value: ReturnType<typeof syncFixture>) {
  const source = value.sourceTurn("handoff", undefined, { ciRun: { runId: 37896583565, attempt: 1 } });
  try { return invokeSync(value, "validate", source.context); } finally { source.finish(); }
}
describe("actual published snapshot external coverage completion", () => {
  it("publishes incomplete handoff safely, then verifies actual checkout instead of workflow main without another capture", () => {
    const value = pendingHandoff();
    const ci = installCiFixture(value);
    const before = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    const localCalls = value.calls();
    const checked = complete(value);
    expect(checked.status, checked.stdout).toBe(0);
    expect(checked.json?.mainSync).toMatchObject({ status: "DONE", requiredE2eComplete: true });
    const after = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(after.transactionId).toBe(before.transactionId);
    expect(after.mainSha).toBe(before.mainSha);
    expect(after.ciEvidence.checkoutSha).toBe(value.git(["rev-parse", "HEAD"]));
    expect(after.ciEvidence.definitionSha).not.toBe(after.ciEvidence.checkoutSha);
    expect(after.pushedHead).toBe(before.pushedHead);
    expect(value.calls().split("\n").filter((line) => line.includes('"check:source-gates"'))).toEqual(
      localCalls.split("\n").filter((line) => line.includes('"check:source-gates"')));
    expect(ci.reads().split("\n").filter(Boolean).every((line) => JSON.parse(line)[0] === "api")).toBe(true);
    expect(existsSync(join(value.metadata, "unsafe-lane-spawned"))).toBe(false);
    const stored = readFileSync(join(value.metadata, "vibe-writer.json"), "utf8");
    expect(JSON.parse(stored).workerId).toBe("fixture-source");
  }, 30000);
  it.each(["repository", "head-repository", "loaded-main", "workflow", "attempt", "checkout", "canceled", "skipped", "missing-step", "narrowed-scope", "producer", "producer-markers-only", "duplicate-selector"])(
    "rejects actual %s mismatch rather than accepting generic green", (failure) => {
      const value = pendingHandoff(); const ci = installCiFixture(value);
      if (failure === "repository") ci.fixture.run.repository.full_name = "other/repo";
      if (failure === "head-repository") ci.fixture.run.head_repository.full_name = "other/repo";
      if (failure === "loaded-main") ci.fixture.run.head_branch = "vibe/untrusted-definition";
      if (failure === "workflow") ci.fixture.run.workflow_id += 1;
      if (failure === "attempt") ci.fixture.run.run_attempt = 2;
      if (failure === "checkout") ci.fixture.log = ci.fixture.log.replaceAll(value.git(["rev-parse", "HEAD"]), "b".repeat(40));
      if (failure === "canceled") ci.fixture.jobs.jobs[0]!.conclusion = "cancelled";
      if (failure === "skipped") ci.fixture.jobs.jobs[0]!.steps[2]!.conclusion = "skipped";
      if (failure === "missing-step") ci.fixture.jobs.jobs[0]!.steps.pop();
      if (failure === "narrowed-scope") ci.fixture.log = ci.fixture.log.replace("DESKTOP_E2E_SMOKE_TAG: ", "DESKTOP_E2E_SMOKE_TAG: @smoke");
      if (failure === "producer") ci.fixture.contents.content = Buffer.from("jobs: {}\n").toString("base64");
      if (failure === "producer-markers-only") {
        ci.fixture.contents = producerContents("# dbus-run-session xvfb-run node scripts/assert-e2e-results.mjs\necho 'dbus-run-session xvfb-run node scripts/assert-e2e-results.mjs'\n");
      }
      if (failure === "duplicate-selector") ci.fixture.log = ci.fixture.log.replace("DESKTOP_E2E_CHANGED_SPECS:", "DESKTOP_E2E_SMOKE_TAG:");
      ci.save();
      const denied = complete(value);
      expect(denied.status, denied.stdout).toBe(1);
      const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
      expect(receipt.ciEvidence).toBeUndefined();
      expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
    }, 30000);
  it("rejects a spoofed later test header, an unbound locator and changed source during real API reads", () => {
    const value = pendingHandoff(); const ci = installCiFixture(value);
    const source = value.sourceTurn("handoff");
    try { expect(invokeSync(value, "validate", { ...source.context, mainSyncCiRun: { runId: 37896583565, attempt: 1 } }).status).toBe(1); }
    finally { source.finish(); }
    const sha = value.git(["rev-parse", "HEAD"]);
    const original = ci.fixture.log;
    ci.fixture.log = original.replace(`   DD_GIT_COMMIT_SHA: ${sha}`, "   MISSING: ")
      + `\n2026-10-09T00:00:12Z ##[group]Run set -o pipefail\n2026-10-09T00:00:12.1Z   DD_GIT_COMMIT_SHA: ${sha}\n2026-10-09T00:00:12.2Z ##[endgroup]`;
    ci.save(); expect(complete(value).status).toBe(1);
    ci.fixture.log = original; ci.fixture.mutateSourceOnLog = true; ci.save();
    expect(complete(value).status).toBe(1);
    expect(readFileSync(join(value.worktree, "apps/app/probe.ts"), "utf8")).toBe("changed during CI read");
    expect(JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8")).ciEvidence).toBeUndefined();
  }, 30000);
  it("keeps exact already-published no-op and original operation after source interruption while coverage is pending", () => {
    const value = pendingHandoff();
    const recordFile = join(value.metadata, "vibe-session.json");
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    record.vercel = { lastDeployedCommit: value.git(["rev-parse", "HEAD"]), verifiedAt: "2026-10-09T00:00:00Z", verifiedRequestId: "verified" };
    record.lastRequestId = "verified"; writeFileSync(recordFile, JSON.stringify(record));
    const ci = installCiFixture(value);
    expect(complete(value).status).toBe(0);
    expect(ci.reads()).toContain("/logs");
    const receipt = JSON.parse(readFileSync(join(value.metadata, "vibe-main-sync.json"), "utf8"));
    expect(receipt.ciEvidence.checkoutSha).toBe(record.vercel.lastDeployedCommit);
    expect(receipt.validation.e2eLimitations).not.toEqual([]);
    expect(existsSync(join(value.metadata, "request.json"))).toBe(false);
  }, 30000);
});
