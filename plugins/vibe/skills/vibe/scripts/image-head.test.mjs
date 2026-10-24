import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { imageProblem, recordImages, reusesImages } from "./image-head.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "image-head.mjs");
const A = "a".repeat(40);
const B = "b".repeat(40);

test("only a command that reuses images is checked, and only a building command records", (t) => {
  const records = mkdtempSync(path.join(os.tmpdir(), "image-head-"));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  for (const command of ["e2e/run-containerized.sh --no-build -- e2e/x.spec.ts", "zsh -lc \"e2e/run-containerized.sh --no-build\""]) assert.equal(reusesImages(command), true, command);
  for (const command of ["e2e/run-containerized.sh -- e2e/x.spec.ts", "pnpm run no-build-check"]) assert.equal(reusesImages(command), false, command);
  const base = { project: "cl-e2e", worktree: "/wt/fix", records };
  assert.equal(imageProblem({ ...base, head: A, command: "run.sh" }), null);
  assert.match(imageProblem({ ...base, head: A, command: "run.sh --no-build" }), /no recorded build/);
  assert.equal(recordImages({ ...base, head: A, command: "run.sh --no-build" }), false);
  assert.equal(recordImages({ ...base, head: A, command: "run.sh" }), true);
  assert.equal(imageProblem({ ...base, head: A.slice(0, 12), command: "run.sh --no-build" }), null);
  assert.match(imageProblem({ ...base, head: B, command: "run.sh --no-build" }), /built from aaaaaaaaaaaa, not bbbbbbbbbbbb/);
  assert.match(imageProblem({ ...base, worktree: "/wt/baseline", head: A, command: "run.sh --no-build" }), /worktree switch/);
  const cli = (action, head, ...command) => spawnSync(process.execPath, [SCRIPT, action, "--project", "cl-e2e", "--worktree", "/wt/fix",
    "--head", head, "--records", records, "--", ...command], { encoding: "utf8" });
  assert.equal(cli("check", B, "run.sh", "--no-build").status, 1);
  assert.equal(cli("record", B, "run.sh").status, 0);
  assert.equal(cli("check", B, "run.sh", "--no-build").status, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT, "check"], { encoding: "utf8" }).status, 2);
});
