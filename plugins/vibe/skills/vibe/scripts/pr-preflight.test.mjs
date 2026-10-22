import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { claimProblems, titleProblems } from "./pr-preflight.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "pr-preflight.mjs");

test("a title over 72 characters with the ' (#n)' suffix fails, as the metadata gate does (#9188 at 73)", () => {
  const title = (length) => `ISS-12901: ${"x".repeat(length - 11)}`;
  assert.match(titleProblems(title(65), { pr: 9188 }).join(), /title is 73 characters/);
  assert.deepEqual(titleProblems(title(64), { pr: 9188 }), []);
  assert.match(titleProblems(title(64)).join(), /title is 73 characters/, "before the PR exists the suffix counts five digits");
});

test("an identical or matching claim needs its measured count (#9186 was about 3,900 pixels off)", () => {
  assert.equal(claimProblems("Regenerated baseline is pixel-identical to CI.").length, 1);
  assert.equal(claimProblems("Snapshot matches the Linux render.").length, 1);
  assert.equal(claimProblems("No visual diff against main.").length, 1);
  assert.deepEqual(claimProblems("Regenerated baseline is pixel-identical to CI: 0 of 1,048,576 pixels differ."), []);
  assert.deepEqual(claimProblems("Matches CI within 0.02% (210 pixels differ, threshold 0.1%)."), []);
  assert.deepEqual(claimProblems("Fixes the star column header."), []);
  assert.deepEqual(claimProblems("The empty state matches the design and the ticket's wording."), [], "only result comparisons need a count");
});

test("the command fails a 73-character title and passes a fitting one", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-preflight-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = path.join(dir, "body.md");
  writeFileSync(body, "## Summary\n- Fix the reds.\n");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const long = run("--title", "x".repeat(65), "--pr", "9188", "--body-file", body);
  assert.equal(long.status, 1);
  assert.equal(JSON.parse(long.stdout).ok, false);
  assert.equal(run("--title", "x".repeat(64), "--pr", "9188", "--body-file", body).status, 0);
});
