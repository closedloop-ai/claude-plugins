import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";
import { probeE2eCapability, remoteCapabilityProbe } from "./e2e-capability-probe.mjs";
import { selectE2eTier, specExecutionLimitation } from "./e2e-tier.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

// Tracker checks run only with a tracker bound, so these run bound to the provider this repository ships (spawned scripts inherit it).
bindProviderInProcess(after);

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

test("ISS-14225: a probe names the host and Git tree it ran on, and a remote re-probe runs on that host bound to the tree", (t) => {
  const fixture = makeHome("vibe-e2e-probe-host-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "slot");
  mkdirSync(worktree);
  git(worktree, ["init", "--quiet"], fixture.home);
  git(worktree, ["commit", "--quiet", "--allow-empty", "-m", "proof"], fixture.home);
  const commit = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const gitTree = git(worktree, ["rev-parse", "HEAD^{tree}"], fixture.home);
  const run = () => ({ status: 1, stdout: "", errorCode: "ENOENT" });
  const local = probeE2eCapability({ worktree, commit, run, diskGiB: 936, platform: "darwin", env: {} });
  assert.equal(local.host, hostname());
  assert.equal(local.gitTree, gitTree);
  assert.equal(local.runnerWorktree, realpathSync(worktree));
  assert.match(local.probeScript, /\/e2e-capability-probe\.mjs$/);
  const named = probeE2eCapability({ worktree, commit, run, diskGiB: 936, platform: "darwin", env: {}, host: "heavy-slot" });
  assert.equal(named.host, "heavy-slot");
  const target = { host: "heavy-slot", runnerWorktree: "/Users/fixture/slot", probeScript: "/opt/vibe/e2e-capability-probe.mjs", gitTree };
  const asked = [];
  const reprobed = remoteCapabilityProbe(target, (request) => {
    asked.push(request);
    return { exitCode: 0, output: `login banner\n${JSON.stringify({ ok: true, probe: { ...named, runnerWorktree: target.runnerWorktree } })}\n` };
  });
  assert.equal(reprobed.host, "heavy-slot");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].host, "heavy-slot", "the recorded host is probed, never this machine");
  assert.ok(asked[0].command.includes(`test "$(git rev-parse 'HEAD^{tree}')" = ${gitTree}`), asked[0].command);
  assert.ok(asked[0].command.includes("--host 'heavy-slot'"), asked[0].command);
  for (const [why, bad] of [["host", { ...target, host: "heavy slot;" }], ["worktree", { ...target, runnerWorktree: "relative/slot" }],
    ["script", { ...target, probeScript: "/opt/vibe/other.mjs" }], ["tree", { ...target, gitTree: "HEAD" }]]) {
    assert.throws(() => remoteCapabilityProbe(bad, () => assert.fail(`no ssh for an invalid ${why}`)), /remote capability probe/, why);
  }
  assert.throws(() => remoteCapabilityProbe(target, () => ({ exitCode: 1, output: "tree moved" })), /remote capability probe/);
  assert.throws(() => remoteCapabilityProbe(target, () => ({ exitCode: 0, output: JSON.stringify({ ok: false, error: "HEAD moved" }) })), /remote capability probe/);
});
