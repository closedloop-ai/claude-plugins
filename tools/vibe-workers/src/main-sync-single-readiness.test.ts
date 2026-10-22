import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { invokeSync, syncFixture } from "./main-sync-test-fixtures.js";
import { prismaInputFixture } from "./main-sync-input-test-fixtures.js";

const fixtures: ReturnType<typeof syncFixture>[] = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.cleanup(); });

describe("one source readiness pass per publication", () => {
  it("captures main without a readiness pass, then proves generated inputs once and returns the witness", () => {
    const value = syncFixture();
    fixtures.push(value);
    prismaInputFixture(value);
    const origins = () => readdirSync(value.metadata).filter((name) => /^vibe-input-origin-.*\.json$/.test(name));
    const publisher = value.start("redeploy");
    try {
      const prepared = invokeSync(value, "prepare", publisher.context);
      expect(prepared.status, prepared.stdout).toBe(0);
    } finally { publisher.finish(); }
    expect(origins()).toHaveLength(0);
    const source = value.sourceTurn();
    try {
      const ready = invokeSync(value, "inputs", source.context);
      expect(ready.status, ready.stdout).toBe(0);
      expect(ready.json?.mainSync).toMatchObject({ status: "DONE", generatedFiles: 1 });
      expect((ready.json?.mainSync as { validationWitness?: unknown }).validationWitness).toBeDefined();
    } finally { source.finish(); }
    expect(origins()).toHaveLength(1);
  }, 60000);
});
