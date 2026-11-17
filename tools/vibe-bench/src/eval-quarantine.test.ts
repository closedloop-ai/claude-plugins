import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evalQuarantineStatus, loadEvalQuarantine } from "./eval-baseline.ts";

// Orchestrator ruling Q-14162-15 (A): an empty quarantine entries list is valid, while the
// shared owner and deadline stay required.

function quarantineFile(root: string, value: unknown): string {
  const file = join(root, "eval-quarantine.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("ISS-14162 Q-14162-15 an empty quarantine loads as no entries and nothing expired", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-quarantine-empty-"));
  try {
    const file = quarantineFile(root, { schemaVersion: 1, createdAt: "2026-10-30", owner: "vibe-maintainers",
      deadline: "2026-11-13", entries: [] });
    assert.deepEqual(loadEvalQuarantine(file), []);
    assert.deepEqual(evalQuarantineStatus(new Date("2026-11-20T00:00:00Z"), file), { entries: [], expired: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISS-14162 Q-14162-15 a quarantine without its owner or deadline is still invalid", () => {
  const root = mkdtempSync(join(tmpdir(), "vibe-eval-quarantine-invalid-"));
  try {
    const valid = { schemaVersion: 1, owner: "vibe-maintainers", deadline: "2026-11-13", entries: [] };
    for (const field of ["owner", "deadline"] as const) {
      const value: Record<string, unknown> = { ...valid };
      delete value[field];
      assert.throws(() => loadEvalQuarantine(quarantineFile(root, value)), /^Error: eval-quarantine-invalid$/, field);
    }
    assert.throws(() => loadEvalQuarantine(quarantineFile(root, { ...valid, entries: undefined })),
      /^Error: eval-quarantine-invalid$/, "entries must still be a list");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
