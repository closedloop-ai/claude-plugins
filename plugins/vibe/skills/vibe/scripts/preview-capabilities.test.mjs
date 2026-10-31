import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evidenceFingerprint } from "../../handoff/scripts/handoff-evidence.mjs";
import { previewCapabilityProblems } from "./preview-capabilities.mjs";

test("provider preview receipt gates missing, stale and unsupported behavior", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-capabilities-"));
  const file = path.join(dir, "provider-proof.json");
  writeFileSync(file, "measured preview response\n");
  const source = { head: "a".repeat(40), diffSha256: "b".repeat(64), treeSha256: "c".repeat(64) };
  const expected = { source, environmentId: "preview-1", requestId: "request-1", required: ["app-preview", "feature-flags", "collaboration"] };
  const probe = { status: "available", producer: "runtime-provider", evidence: evidenceFingerprint(file) };
  const valid = { schema: 1, producer: "runtime-provider", environmentId: "preview-1", requestId: "request-1", source,
    probes: { "app-preview": probe, "feature-flags": probe, collaboration: probe } };
  assert.deepEqual(previewCapabilityProblems(valid, expected), []);
  assert.deepEqual(previewCapabilityProblems(valid, { ...expected, required: [] }), ["preview requirements need app-preview and supported capability names"]);
  assert.deepEqual(previewCapabilityProblems(valid, { ...expected, required: ["unknown"] }), ["preview requirements need app-preview and supported capability names"]);
  assert.deepEqual(previewCapabilityProblems(null, expected), ["provider preview receipt is missing schema, identity, source or probes"]);
  assert.match(previewCapabilityProblems({ ...valid, requestId: "old" }, expected).join(), /stale/);
  assert.match(previewCapabilityProblems({ ...valid, source: { ...source, treeSha256: "d".repeat(64) } }, expected).join(), /stale/);
  assert.deepEqual(previewCapabilityProblems({ ...valid, probes: { "app-preview": probe } }, expected), [
    "preview cannot show required feature-flags behavior", "preview cannot show required collaboration behavior",
  ]);
  assert.deepEqual(previewCapabilityProblems({ ...valid, probes: { ...valid.probes, collaboration: { ...probe, status: "unsupported" } } }, expected), [
    "preview cannot show required collaboration behavior",
  ]);
  writeFileSync(file, "changed provider response\n");
  assert.match(previewCapabilityProblems(valid, expected).join(), /evidence is missing or changed/);
});
