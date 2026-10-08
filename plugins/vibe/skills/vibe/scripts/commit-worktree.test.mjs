import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git, makeCheckout, makeHome, runNode } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "commit-worktree.mjs");
const PLAN_GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-plans.mjs");

function setup(t) {
  const fixture = makeHome("commit-worktree-");
  t.after(fixture.cleanup);
  const checkout = path.join(fixture.root, "symphony-alpha");
  makeCheckout({ root: fixture.root, home: fixture.home, checkout, files: { "apps/app/page.tsx": "one\n" } });
  return { ...fixture, checkout };
}

function write(checkout, file, content) {
  const absolute = path.join(checkout, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commitCount(checkout, home) {
  return Number(git(checkout, ["rev-list", "--count", "HEAD"], home));
}

function writeRecord(checkout, home, record) {
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  writeFileSync(path.join(gitDir, "vibe-session.json"), `${JSON.stringify(record)}\n`);
}

test("commits the session's changes but never its local fixes or files that never belong in a commit", (t) => {
  const { home, checkout } = setup(t);
  writeRecord(checkout, home, { localFixes: [{ ticket: "ISS-1", paths: ["scripts/fix.sh", "tools/patched"] }] });
  write(checkout, "apps/app/page.tsx", "two\n");
  write(checkout, "packages/app/new.tsx", "new\n");
  write(checkout, "scripts/fix.sh", "local fix\n");
  write(checkout, "tools/patched/a.ts", "local fix\n");
  write(checkout, ".env.local", "SECRET=1\n");
  write(checkout, "apps/app/.env", "SECRET=2\n");
  write(checkout, ".control/run.json", "{}\n");

  const result = runNode(
    SCRIPT,
    ["--worktree", checkout, "--subject", "ISS-7: Add the new panel", "--body", "Screens: projects"],
    home
  );

  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.committed, true);
  assert.deepEqual(result.json.files, ["apps/app/page.tsx", "packages/app/new.tsx"]);
  assert.deepEqual(
    [...result.json.excluded].sort(),
    [".control/run.json", ".env.local", "apps/app/.env", "scripts/fix.sh", "tools/patched/a.ts"]
  );
  assert.equal(git(checkout, ["log", "-1", "--format=%s"], home), "ISS-7: Add the new panel");
  assert.equal(git(checkout, ["log", "-1", "--format=%b"], home), "Screens: projects");
  assert.equal(result.json.commit, git(checkout, ["rev-parse", "HEAD"], home));
  const leftOver = git(checkout, ["status", "--porcelain", "--untracked-files=all"], home).split("\n").map((line) => line.slice(3));
  assert.deepEqual(leftOver.sort(), [".control/run.json", ".env.local", "apps/app/.env", "scripts/fix.sh", "tools/patched/a.ts"]);
});

test("reports nothing to commit without creating a commit", (t) => {
  const { home, checkout } = setup(t);
  writeRecord(checkout, home, { localFixes: [{ ticket: "ISS-1", paths: ["scripts/fix.sh"] }] });
  write(checkout, "scripts/fix.sh", "local fix only\n");
  const before = commitCount(checkout, home);

  const result = runNode(SCRIPT, ["--worktree", checkout, "--subject", "ISS-7: Nothing"], home);

  assert.equal(result.status, 0);
  assert.equal(result.json.committed, false);
  assert.deepEqual(result.json.excluded, ["scripts/fix.sh"]);
  assert.equal(commitCount(checkout, home), before);
});

test("local plans stay in the worktree even when staged, without excluding other artifacts", (t) => {
  const { home, checkout } = setup(t);
  const plan = ".closedloop-ai/vibe-plans/request-1.md";
  const other = ".closedloop-ai/published-evidence.md";
  write(checkout, plan, "private implementation plan\n");
  write(checkout, other, "ordinary deliverable\n");
  write(checkout, "apps/app/page.tsx", "changed\n");
  git(checkout, ["add", plan], home);
  const result = runNode(SCRIPT, ["--worktree", checkout, "--subject", "ISS-7: Finish the feature"], home);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.deepEqual(result.json.excluded, [plan]);
  assert.deepEqual(result.json.files, [other, "apps/app/page.tsx"]);
  assert.equal(git(checkout, ["ls-tree", "-r", "--name-only", "HEAD", "--", plan], home), "");
  assert.equal(git(checkout, ["status", "--porcelain", "--", plan], home), `?? ${plan}`);
});

test("a plan already in HEAD blocks another commit and the publication guard", (t) => {
  const { home, checkout } = setup(t);
  const plan = ".closedloop-ai/vibe-plans/request-1.md";
  write(checkout, plan, "private plan\n");
  git(checkout, ["add", plan], home);
  git(checkout, ["commit", "-m", "Fixture: accidentally committed local plan"], home);
  write(checkout, "apps/app/page.tsx", "changed\n");
  const before = commitCount(checkout, home);
  const result = runNode(SCRIPT, ["--worktree", checkout, "--subject", "ISS-7: Finish the feature"], home);
  assert.equal(result.status, 1);
  assert.match(result.json.error, /publication is blocked/);
  assert.equal(commitCount(checkout, home), before);
  assert.equal(git(checkout, ["diff", "--cached", "--name-only"], home), "");
  const guard = runNode(PLAN_GUARD, ["--worktree", checkout], home);
  assert.equal(guard.status, 1);
  assert.deepEqual(guard.json.committedLocalPlans, [plan]);
});

test("refuses a missing, multi-line, or over-long subject and commits nothing", (t) => {
  const { home, checkout } = setup(t);
  write(checkout, "apps/app/page.tsx", "changed\n");
  const before = commitCount(checkout, home);

  const cases = [
    [[], /--subject is required/],
    [["--subject", "ISS-7: One\nTwo"], /must be one line/],
    [["--subject", `ISS-7: ${"x".repeat(70)}`], /at most 72 characters/],
  ];
  for (const [args, message] of cases) {
    const result = runNode(SCRIPT, ["--worktree", checkout, ...args], home);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.json.ok, false);
    assert.match(result.json.error, message);
  }
  assert.equal(commitCount(checkout, home), before);
});

test("runs the repository's commit hook and reports its output when it refuses", (t) => {
  const { root, home, checkout } = setup(t);
  const hooks = path.join(root, "hooks");
  mkdirSync(hooks);
  const hook = path.join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'typecheck failed: apps/app/page.tsx'\nexit 1\n");
  chmodSync(hook, 0o755);
  git(checkout, ["config", "core.hooksPath", hooks], home);
  write(checkout, "apps/app/page.tsx", "broken\n");
  const before = commitCount(checkout, home);

  const result = runNode(SCRIPT, ["--worktree", checkout, "--subject", "ISS-7: Break it"], home);

  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.match(result.json.error, /refused \(exit 1\); nothing was committed/);
  assert.match(result.json.error, /typecheck failed: apps\/app\/page\.tsx/);
  assert.equal(commitCount(checkout, home), before);
});

test("concludes a merge a worker staged without committing", (t) => {
  const { home, checkout } = setup(t);
  git(checkout, ["checkout", "-q", "-b", "fix/seed"], home);
  write(checkout, "apps/api/seed.ts", "seed\n");
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "-q", "-m", "Seed change"], home);
  git(checkout, ["checkout", "-q", "main"], home);
  write(checkout, "README.md", "main moved\n");
  git(checkout, ["commit", "-q", "-am", "Main change"], home);
  git(checkout, ["checkout", "-q", "fix/seed"], home);
  git(checkout, ["merge", "--no-commit", "--no-ff", "main"], home);

  const result = runNode(SCRIPT, ["--worktree", checkout, "--subject", "Merge main into fix/seed"], home);

  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.committed, true);
  assert.equal(result.json.merge, true);
  assert.equal(git(checkout, ["rev-list", "--parents", "-n", "1", "HEAD"], home).split(" ").length, 3);
});
