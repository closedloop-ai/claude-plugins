import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewedProducer } from "./main-sync-ci.js";

// ISS-13321: symphony-alpha #8713 changed the desktop-e2e producer and the pinned checks silently stopped matching.
const SNAPSHOT = readFileSync(new URL("./fixtures/symphony-e2e-test-desktop-job.yml", import.meta.url), "utf8");

function liveWorkflow() {
  const read = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", "repos/closedloop-ai/symphony-alpha/contents/.github/workflows/e2e-test.yml?ref=main"],
    { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return read.status === 0 && read.stdout.includes("desktop-e2e:") ? read.stdout : null;
}
const live = liveWorkflow();

describe("the desktop-e2e CI producer the handoff reader trusts", () => {
  it("accepts symphony-alpha's producer as snapshotted from main", () => {
    expect(reviewedProducer(SNAPSHOT).name).toBe("Run Electron e2e");
  });

  it("refuses a producer whose checkout no longer tests the dispatched ref", () => {
    expect(() => reviewedProducer(SNAPSHOT.replace("github.event.inputs.ref || ", ""))).toThrow(/recognized trusted source/);
  });

  // Runs wherever gh can read symphony-alpha (an engineer's machine); CI's token cannot, so it reports skipped there.
  it.skipIf(live === null)("accepts symphony-alpha's producer on main today", () => {
    expect(reviewedProducer(live!).name).toBe("Run Electron e2e");
  });
});
