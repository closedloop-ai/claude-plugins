import { describe, expect, it } from "vitest";
import { checkedSourceFromJobLog, type CiStep } from "./main-sync-ci-logs.js";

const checkout: CiStep = { number: 2, name: "Checkout repository", status: "completed", conclusion: "success",
  started_at: "2026-10-09T00:00:00Z", completed_at: "2026-10-09T00:00:01Z" };
const test: CiStep = { number: 20, name: "Run Electron e2e", status: "completed", conclusion: "success",
  started_at: "2026-10-09T00:00:10Z", completed_at: "2026-10-09T00:00:30Z" };
const sha = "b".repeat(40);
function log() { return [
  "2026-10-09T00:00:00.2500000Z [command]/usr/bin/git log -1 --format=%H",
  `2026-10-09T00:00:00.2600000Z ${sha}`,
  "2026-10-09T00:00:10.0010000Z ##[group]Run preceding step in the same API second",
  "2026-10-09T00:00:10.0050000Z ##[endgroup]",
  "2026-10-09T00:00:10.0100000Z ##[group]Run set -o pipefail",
  `2026-10-09T00:00:10.0200000Z   DD_GIT_COMMIT_SHA: ${sha}`,
  "2026-10-09T00:00:10.0210000Z   DESKTOP_E2E_SMOKE_TAG: ",
  "2026-10-09T00:00:10.0220000Z   DESKTOP_E2E_CHANGED_SPECS: ",
  "2026-10-09T00:00:10.0300000Z ##[endgroup]",
  "2026-10-09T00:00:11.0000000Z Running 280 tests using 2 workers",
].join("\n"); }
describe("trusted runner checked-source interface", () => {
  it("matches the actual producer header despite whole-second overlap and ignores later spoofed output", () => {
    const spoof = `${log()}\n2026-10-09T00:00:12Z   DD_GIT_COMMIT_SHA: ${"c".repeat(40)}`;
    expect(checkedSourceFromJobLog(spoof, checkout, test, "set -o pipefail")).toBe(sha);
  });
  it("never promotes a later test-printed header when the trusted pre-test identity is missing", () => {
    const source = log().replace(`   DD_GIT_COMMIT_SHA: ${sha}`, "   OMITTED: ");
    const spoof = `${source}\n2026-10-09T00:00:12Z ##[group]Run set -o pipefail\n2026-10-09T00:00:12.1Z   DD_GIT_COMMIT_SHA: ${sha}\n2026-10-09T00:00:12.2Z ##[endgroup]`;
    expect(() => checkedSourceFromJobLog(spoof, checkout, test, "set -o pipefail")).toThrow(/source\/full-scope/);
  });
  it("rejects wrong checkout, duplicate env, missing group end, narrowed selection and unsuccessful steps", () => {
    for (const source of [log().replace(`Z ${sha}`, `Z ${"c".repeat(40)}`),
      log().replace("   DESKTOP_E2E_SMOKE_TAG: ", "   DESKTOP_E2E_SMOKE_TAG: @smoke"),
      log().replace("DESKTOP_E2E_CHANGED_SPECS:", "DESKTOP_E2E_SMOKE_TAG:"),
      log().replace("2026-10-09T00:00:10.0300000Z ##[endgroup]", ""),
      `${log().split("2026-10-09T00:00:10.0300000Z")[0]}2026-10-09T00:00:10.0250000Z   DD_GIT_COMMIT_SHA: ${sha}\n2026-10-09T00:00:10.0300000Z ##[endgroup]`]) {
      expect(() => checkedSourceFromJobLog(source, checkout, test, "set -o pipefail")).toThrow();
    }
    expect(() => checkedSourceFromJobLog(log(), checkout, { ...test, conclusion: "skipped" }, "set -o pipefail")).toThrow();
  });
});
