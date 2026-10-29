import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "control-evidence.mjs");

test("moves only an owned control capture to private git storage before publication", (t) => {
  const fixture = makeHome("vibe-control-evidence-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout: worktree });
  const own = path.join(worktree, ".control", "runs", "owned-run");
  const other = path.join(worktree, ".control", "runs", "other-run");
  for (const dir of [own, other]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(own, "002-snapshot.yml"), "owned evidence\n");
  writeFileSync(path.join(other, "002-snapshot.yml"), "other evidence\n");

  const moved = runNode(SCRIPT, ["--worktree", worktree, "--run", own], fixture.home);
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(existsSync(own), false);
  assert.equal(readFileSync(moved.json.path + "/002-snapshot.yml", "utf8"), "owned evidence\n");
  assert.equal(readFileSync(path.join(other, "002-snapshot.yml"), "utf8"), "other evidence\n");
  assert.ok(moved.json.path.startsWith(git(worktree, ["rev-parse", "--absolute-git-dir"], fixture.home) + path.sep));

  const foreign = runNode(SCRIPT, ["--worktree", worktree, "--run", path.join(fixture.root, "elsewhere")], fixture.home);
  assert.equal(foreign.status, 1);
  const repeat = runNode(SCRIPT, ["--worktree", worktree, "--run", own], fixture.home);
  assert.equal(repeat.status, 1);
});
