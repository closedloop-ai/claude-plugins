import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { claimProblems, titleProblems } from "./pr-preflight.mjs";
import { visualBaselineLedgerProblems } from "../../handoff/scripts/visual-baseline-ledger.mjs";

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

test("a changed visual baseline needs a counted, sourced element ledger (#9188)", (t) => {
  const file = "e2e/__screenshots__/visual-regression.spec.ts/branches-desktop.png";
  assert.match(visualBaselineLedgerProblems("The checkbox is plausibly intended.\n", [file]).join(), /needs exactly one/);
  const incomplete = [
    `Baseline inventory: ${file}: Branches: 3 new elements`,
    `Baseline element: ${file}: Branches: star column: ISS-12918 AC-2`,
    `Baseline element: ${file}: Branches: header select-all checkbox: plausibly intended`,
  ].join("\n");
  assert.match(visualBaselineLedgerProblems(incomplete, [file]).join(), /declares 3 new elements but lists 2/);
  assert.match(visualBaselineLedgerProblems(incomplete, [file]).join(), /plausibly intended/);

  const dir = mkdtempSync(path.join(os.tmpdir(), "pr-baseline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), "old");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-m", "base"]);
  const base = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(dir, file), "new");
  execFileSync("git", ["-C", dir, "commit", "--quiet", "-am", "baseline"]);
  const body = path.join(dir, "body.md");
  writeFileSync(body, incomplete);
  const failed = spawnSync(process.execPath, [SCRIPT, "--title", "ISS-12901: Fix baselines", "--body-file", body, "--worktree", dir, "--base", base], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  writeFileSync(body, `${incomplete}\nBaseline element: ${file}: Branches: avatar style: ISS-12576 ruling\n`.replace("header select-all checkbox: plausibly intended", "header select-all checkbox: ISS-100 AC-3"));
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--title", "ISS-12901: Fix baselines", "--body-file", body, "--worktree", dir, "--base", base], { encoding: "utf8" }).status, 0);
});
