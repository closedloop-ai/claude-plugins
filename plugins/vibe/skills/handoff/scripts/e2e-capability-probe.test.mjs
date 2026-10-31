import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { probeE2eCapability } from "./e2e-capability-probe.mjs";
import { selectE2eTier, specExecutionLimitation } from "./e2e-tier.mjs";

test("the capability producer reports working Docker and only boolean prerequisite presence", (t) => {
  const fixture = makeHome("vibe-e2e-probe-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  mkdirSync(path.join(worktree, "apps", "api"), { recursive: true });
  writeFileSync(path.join(worktree, "apps", "api", ".env.local"), "DEVOPS_CLOSEDLOOP_APP_PWD=fixture-password\n");
  git(worktree, ['init', '--quiet'], fixture.home);
  git(worktree, ['add', '.'], fixture.home);
  git(worktree, ['commit', '--quiet', '-m', 'base'], fixture.home);
  const commit = git(worktree, ['rev-parse', 'HEAD'], fixture.home);
  writeFileSync(path.join(worktree, 'uncommitted.md'), 'dirty probe input');
  const run = (name, args) => {
    if (name === "docker" && args[0] === "--version") return { status: 0, stdout: "Docker version 29.9.1" };
    if (name === "docker" && args[0] === "info") return { status: 0, stdout: String(25157324800) };
    if (name === "dagger") return { status: 0, stdout: "dagger v0.21.9" };
    return { status: 1, stdout: "" };
  };
  const observed = probeE2eCapability({ worktree, commit, run, diskGiB: 936, platform: "darwin", env: {} });
  assert.equal(observed.container.dockerPresent, true);
  assert.equal(observed.container.dockerReachable, true);
  assert.equal(observed.container.memoryGiB > 23, true);
  assert.equal(observed.container.runnable, false);
  assert.deepEqual(observed.container.secretsSet, {
    CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true,
  });
  assert.equal(observed.probedCommit, commit);
  assert.equal(observed.source.head, commit);
  assert.match(observed.source.diffSha256, /^[a-f0-9]{64}$/);
  assert.equal(observed.desktopHarness.available, false);
  assert.doesNotMatch(JSON.stringify(observed), /fixture-password/);
  const capability = { ...observed, selectedTier: "A", native: { available: false }, remote: { available: false } };
  assert.equal(selectE2eTier(capability).tier, "A");
  assert.deepEqual(specExecutionLimitation(capability, "e2e/org-issues-list.spec.ts", commit)?.missingPrerequisites,
    ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"]);
  const missingDocker = probeE2eCapability({ worktree, commit, run: () => ({ status: 1, stdout: "", errorCode: "ENOENT" }), diskGiB: 936, platform: "darwin", env: {} });
  assert.equal(missingDocker.container.dockerPresent, false);
  const stoppedDaemon = probeE2eCapability({ worktree, commit, run: (name) => name === "docker"
    ? { status: 1, stdout: "", errorCode: undefined } : { status: 1, stdout: "", errorCode: "ENOENT" },
    diskGiB: 936, platform: "darwin", env: {} });
  assert.equal(stoppedDaemon.container.dockerPresent, true);
  assert.equal(stoppedDaemon.container.dockerReachable, false);
});
