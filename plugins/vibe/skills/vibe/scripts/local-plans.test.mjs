import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { committedLocalPlans, knownLocalPlanPrefixes, localPlanPaths, localPlanPrefix } from "./local-plans.mjs";
import { PROVIDER_BINDING } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-plans.mjs");

function repo(t) {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-local-plans-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "vibe/plans");
  writeFileSync(path.join(root, "README.md"), "x\n");
  git("add", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  return { root, git };
}

test("plans live in the private git directory without a provider recipe, and in its folder with one", (t) => {
  const { root } = repo(t);
  assert.equal(localPlanPrefix(null), null);
  const generic = localPlanPaths(root, { requestId: "first", binding: null });
  assert.equal(generic.inWorktree, false);
  assert.ok(generic.plan.includes(`${path.sep}.git${path.sep}vibe${path.sep}plans${path.sep}`));
  assert.equal(localPlanPrefix(PROVIDER_BINDING), ".closedloop-ai/vibe-plans/");
  assert.equal(localPlanPaths(root, { binding: PROVIDER_BINDING }).inWorktree, true);
});

test("every installed provider's plan folder is known, bound or not, and a committed plan there blocks publication", (t) => {
  const { root, git } = repo(t);
  // This checkout installs the ClosedLoop provider beside vibe-core, so its folder is known even with nothing bound.
  assert.deepEqual(knownLocalPlanPrefixes(null), [".closedloop-ai/vibe-plans/"]);
  assert.deepEqual(knownLocalPlanPrefixes(PROVIDER_BINDING), [".closedloop-ai/vibe-plans/"]);
  mkdirSync(path.join(root, ".closedloop-ai", "vibe-plans"), { recursive: true });
  writeFileSync(path.join(root, ".closedloop-ai", "vibe-plans", "plan.md"), "plan\n");
  git("add", "-f", ".");
  git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "plan");
  assert.deepEqual(committedLocalPlans((args) => git(...args), ".closedloop-ai/vibe-plans/"), [".closedloop-ai/vibe-plans/plan.md"]);
  const check = (() => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [SCRIPT, "--worktree", root], { encoding: "utf8",
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "" } }) };
    } catch (error) { return { status: error.status, out: error.stdout }; }
  })();
  assert.equal(check.status, 1, "a session with nothing bound still refuses the committed plan");
  assert.deepEqual(JSON.parse(check.out).committedLocalPlans, [".closedloop-ai/vibe-plans/plan.md"]);
});
