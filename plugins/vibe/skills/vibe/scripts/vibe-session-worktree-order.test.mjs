import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const cli = fileURLToPath(new URL("./vibe-sessions.mjs", import.meta.url));

test("ISS-14476 lists recent sessions first and orders equal timestamps by slug", (t) => {
  const fixture = makeHome("vibe-worktree-order-");
  t.after(fixture.cleanup);
  const { root, home } = fixture;
  const checkout = path.join(root, "checkout");
  makeCheckout({ root, home, checkout });
  const cases = [
    ["z-last", "2026-11-19T12:00:00.000Z"],
    ["a-first", "2026-11-19T12:00:00.000Z"],
    ["m-recent", "2026-11-19T12:01:00.000Z"],
    ["b-old", "2026-11-19T11:00:00.000Z"],
  ];
  for (const [slug, lastActiveAt] of cases) {
    const worktree = path.join(root, slug);
    const branch = "vibe/" + slug;
    git(checkout, ["worktree", "add", "--quiet", "--no-track", "-b", branch, worktree], home);
    const gitDir = git(worktree, ["rev-parse", "--absolute-git-dir"], home);
    writeFileSync(path.join(gitDir, "vibe-session.json"), JSON.stringify({ slug, branch, lastActiveAt }));
  }

  const result = runNode(cli, ["list", "--repo", checkout], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.sessions.map(({ slug }) => slug), ["m-recent", "a-first", "z-last", "b-old"]);
});
