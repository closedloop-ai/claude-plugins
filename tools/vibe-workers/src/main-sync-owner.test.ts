import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSync, syncFixture } from "./main-sync-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

// ISS-13321: a worker that rebuilt its context was refused twice with no hint of which field differed.
describe("a main-sync context that differs from the launcher's record", () => {
  it("names each differing field, never its value, and says to pass the context verbatim", () => {
    const value = syncFixture(); fixtures.push(value);
    const publisher = value.start("redeploy", "handoff");
    try {
      const refused = invokeSync(value, "prepare", { ...publisher.context, requestId: "rebuilt-request", lease: randomUUID() });
      expect(refused.status).toBe(1);
      const error = String(refused.json?.error);
      expect(error).toContain("differs: requestId, lease.");
      expect(error).toContain("Pass the launch envelope's operationContext verbatim");
      expect(error).not.toContain("rebuilt-request");
      expect(invokeSync(value, "prepare", publisher.context).status).toBe(0);
    } finally { publisher.finish(); }
  });
});
