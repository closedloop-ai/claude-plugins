import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evidenceFingerprint, MAX_EVIDENCE_BYTES } from "./handoff-evidence.mjs";

test("evidence fingerprints are bounded regular files hashed incrementally", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-evidence-"));
  const file = path.join(dir, "evidence.bin");
  const bytes = Buffer.alloc(MAX_EVIDENCE_BYTES, 0x61);
  writeFileSync(file, bytes);
  assert.equal(evidenceFingerprint(file).sha256, createHash("sha256").update(bytes).digest("hex"));
  writeFileSync(file, Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 0x61));
  assert.throws(() => evidenceFingerprint(file), /too large/);
  const folder = path.join(dir, "folder");
  mkdirSync(folder);
  assert.throws(() => evidenceFingerprint(folder), /regular file/);
  const link = path.join(dir, "link");
  symlinkSync(file, link);
  assert.throws(() => evidenceFingerprint(link), /regular file/);
  const fifo = path.join(dir, "fifo");
  const made = spawnSync("mkfifo", [fifo]);
  if (made.status === 0) assert.throws(() => evidenceFingerprint(fifo), /regular file/);
});


test("AC-088 public handoff identifies the file containing a malformed receipt", async (t) => {
  const { readReviewReceipts } = await import("./handoff-gate-check.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-receipt-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "review.json");
  writeFileSync(file, "{");
  assert.throws(() => readReviewReceipts([file]), /review\.json.*JSON object/i);
});
