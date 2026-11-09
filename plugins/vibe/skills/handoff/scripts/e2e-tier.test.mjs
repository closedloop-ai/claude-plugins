import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NO_DISPLAYLESS_ELECTRON, selectE2eTier, specExecutionLimitation, tierEvidenceProblems } from "./e2e-tier.mjs";

const container = {
  dockerPresent: true,
  dockerReachable: true,
  memoryGiB: 24,
  diskGiB: 80,
  minimumMemoryGiB: 20,
  minimumDiskGiB: 64,
  command: "pnpm prepush --all --probe",
};

test("tier selection prefers capable containers, then native, then a configured remote", () => {
  const base = { container, native: { available: true, forbidden: false }, remote: { available: true } };
  assert.equal(selectE2eTier(base).tier, "A");
  assert.equal(selectE2eTier({ ...base, container: { ...container, memoryGiB: 12 } }).tier, "B");
  assert.equal(selectE2eTier({ ...base, container: { ...container, dockerReachable: false }, native: { available: true, forbidden: true } }).tier, "C");
  assert.equal(selectE2eTier({ ...base, container: { ...container, dockerPresent: false }, native: { available: true, forbidden: true }, remote: { available: false } }).tier, null);
});

test("the evidence records the probe, selected tier and honest no-tier or native visual gaps", () => {
  const base = { container, native: { available: true, forbidden: false }, remote: { available: true }, selectedTier: "A" };
  assert.deepEqual(tierEvidenceProblems(base, ["e2e/sessions.spec.ts"]), []);
  const native = { ...base, container: { ...container, dockerReachable: false }, selectedTier: "B",
    native: { available: true, forbidden: false, headless: true, localStack: true, retries: 0, quarantineExcluded: true, sandboxIdentityNotRequired: "fixture" } };
  assert.match(tierEvidenceProblems(native, ["e2e/visual-regression.spec.ts"]).join(), /visual-regression.*covered by CI/);
  assert.deepEqual(tierEvidenceProblems({ ...native, notRunLocally: ["e2e/visual-regression.spec.ts"], ciCoverage: ["visual regression"] }, ["e2e/visual-regression.spec.ts"]), []);
  assert.deepEqual(tierEvidenceProblems({ ...base, container: { ...container, dockerPresent: false }, native: { available: true, forbidden: true, forbiddenSource: "git config vibe.noNativeE2e" }, remote: { available: false }, selectedTier: null, unavailableSpecs: ["e2e/sessions.spec.ts"], ciCoverage: ["Browser E2E"] }, ["e2e/sessions.spec.ts"]), []);
});

test("container runtime readiness and spec execution prerequisites are separate", () => {
  const commit = "f".repeat(40);
  const capability = { selectedTier: "A", probedCommit: commit,
    container: { ...container, runnable: false, notRunnableReason: "CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY absent",
      secretsSet: { CLERK_SECRET_KEY: false, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: false, DEVOPS_CLOSEDLOOP_APP_PWD: true } },
    desktopHarness: { available: false, reason: NO_DISPLAYLESS_ELECTRON, probe: "macOS has no Linux Xvfb/dbus/keyring harness" },
    native: { available: false }, remote: { available: false } };
  assert.equal(selectE2eTier(capability).tier, "A");
  assert.deepEqual(specExecutionLimitation(capability, "e2e/org-issues-list.spec.ts", commit),
    { tier: "A", kind: "missing-prerequisites", missingPrerequisites: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] });
  assert.deepEqual(specExecutionLimitation(capability, "apps/desktop/test/e2e/issues-list.spec.ts", commit),
    { tier: "A", kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON });
  assert.equal(specExecutionLimitation({ ...capability, probedCommit: "a".repeat(40) }, "e2e/org-issues-list.spec.ts", commit), null);
  assert.equal(specExecutionLimitation({ ...capability, container: { ...capability.container, runnable: true } }, "e2e/org-issues-list.spec.ts", commit), null);
});

test("ISS-13846 AC-3 remote tier carries only an exact-head Desktop displayless limitation", t => {
  const commit = "5afa61faa88a057e2f67df4da923a7be6e46adf5";
  const desktop = "apps/desktop/test/e2e/shared-paged-source-documents.spec.ts";
  const capability = { selectedTier: "C", probedCommit: commit,
    container: { ...container, dockerReachable: false }, native: { available: false },
    remote: { available: true, command: `~/vibe-remote/e2e-slot.sh --head ${commit} proof-owner <command...>`,
      runnerWorktree: "/selected/iss-13699", probeOwner: "proof-owner", source: "SSH exact-head probe passed",
      desktopHarness: { available: false, reason: NO_DISPLAYLESS_ELECTRON, probe: "remote selected-tier displayless probe failed", probedCommit: commit } },
    desktopHarness: { available: false, reason: NO_DISPLAYLESS_ELECTRON,
      probe: "darwin; dbus-run-session=false, xvfb-run=false, gnome-keyring-daemon=false" },
    unavailableSpecs: [desktop], ciCoverage: ["desktop-e2e-validation.yml:desktop-e2e/validated"] };
  const dir = mkdtempSync(path.join(tmpdir(), "remote-desktop-probe-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const receipt = { kind: "selected-runner-desktop-probe/v1", head: commit, selectedTier: "C",
    runnerCommand: capability.remote.command,
    probe: { command: `zsh -lic '~/vibe-remote/e2e-slot.sh --head ${commit} --native-desktop owner probe'`,
      exitCode: 0, output: NO_DISPLAYLESS_ELECTRON },
    desktopHarness: { available: false, reason: NO_DISPLAYLESS_ELECTRON,
      probe: capability.remote.desktopHarness.probe, probedCommit: commit } };
  const bytes = JSON.stringify(receipt);
  writeFileSync(path.join(dir, "probe.json"), bytes);
  capability.remote.desktopHarness.receipt = { path: "probe.json", sha256: createHash("sha256").update(bytes).digest("hex") };
  assert.equal(specExecutionLimitation(capability, desktop, commit), null,
    "a caller-authored self-hashed receipt without selected-runner execution provenance is not authority");
  capability.remote.runnerHost = "selected-second-laptop";
  const calls = [];
  const unavailable = { kind: "selected-runner-desktop-capability/v2", head: commit,
    worktree: capability.remote.runnerWorktree, platform: "darwin", linuxHarness: false };
  const liveProbe = request => { calls.push(request); return request.nativeDesktop
    ? { exitCode: 2, output: "Usage: e2e-slot.sh [--head <sha>] <owner-label> <command...>" }
    : { exitCode: 0, output: JSON.stringify(unavailable) }; };
  assert.equal(specExecutionLimitation(capability, desktop, commit,
    () => ({ exitCode: 0, output: JSON.stringify(unavailable) })), null,
  "review DT-35: a successfully executed native slot command is a supported route even if source-token text claims otherwise");
  assert.deepEqual(specExecutionLimitation(capability, desktop, commit, liveProbe),
    { tier: "C", kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON });
  assert.deepEqual(calls.map(({ command, ...rest }) => rest), [true, false].map(nativeDesktop => ({ host: "selected-second-laptop",
    head: commit, worktree: "/selected/iss-13699", owner: "proof-owner",
    selectedTier: "C", runnerCommand: capability.remote.command, nativeDesktop })));
  for (const token of ["/selected/iss-13699", `--head ${commit}`, "--native-desktop proof-owner", "node -e"])
    assert.ok(calls[0].command.includes(token), token);
  assert.ok(!calls[1].command.includes("--native-desktop"));
  assert.deepEqual(tierEvidenceProblems(capability, [desktop], liveProbe), []);
  const wrongHeadReceipt = { ...receipt, probe: { ...receipt.probe,
    command: `zsh -lic '~/vibe-remote/e2e-slot.sh --head ${commit}bad --native-desktop owner probe'` } };
  const wrongHeadBytes = JSON.stringify(wrongHeadReceipt);
  writeFileSync(path.join(dir, "wrong-head.json"), wrongHeadBytes);
  const wrongHead = structuredClone(capability);
  wrongHead.remote.desktopHarness.receipt = { path: "wrong-head.json", sha256: createHash("sha256").update(wrongHeadBytes).digest("hex") };
  assert.deepEqual(specExecutionLimitation(wrongHead, desktop, commit, liveProbe),
    { tier: "C", kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON },
    "an old caller receipt is irrelevant after a live selected-runner re-probe");
  for (const changed of [
    { ...capability, probedCommit: "a".repeat(40) },
    { ...capability, remote: { ...capability.remote, desktopHarness: { ...capability.remote.desktopHarness, probe: "" } } },
    { ...capability, remote: { available: false, command: capability.remote.command } },
    { ...capability, remote: { ...capability.remote, desktopHarness: { ...capability.remote.desktopHarness, available: true, probe: "e2e-slot.sh --native-desktop passed 302 tests" } } },
    { ...capability, remote: { ...capability.remote, desktopHarness: { ...capability.remote.desktopHarness, probedCommit: "a".repeat(40) } } },
    { ...capability, remote: { ...capability.remote, desktopHarness: undefined } },
  ]) assert.equal(specExecutionLimitation(changed, desktop, commit, liveProbe), null);
  assert.equal(specExecutionLimitation(capability, desktop, commit, () => ({ exitCode: 0,
    output: JSON.stringify({ ...unavailable, nativeSlot: true, offscreenPreflight: true, supported: true,
      reason: null }) })), null,
  "a selected runner with a supported displayless route cannot carry Desktop as not-run");
  assert.equal(specExecutionLimitation(capability, desktop, commit, () => ({ exitCode: 0,
    output: `${NO_DISPLAYLESS_ELECTRON}\n302 desktop tests passed through the supported displayless route` })), null,
  "a stale no-harness line cannot mask a later successful displayless run");
  assert.equal(specExecutionLimitation(capability, "e2e/documents-summary-scope.spec.ts", commit, liveProbe), null);
});

test("ISS-13846 review DT-20 self-declared remote probe text cannot authorize a tier-C carry", () => {
  const commit = "5afa61faa88a057e2f67df4da923a7be6e46adf5";
  const capability = { selectedTier: "C", probedCommit: commit,
    container: { ...container, dockerReachable: false }, native: { available: false },
    remote: { available: true, command: `~/vibe-remote/e2e-slot.sh --head ${commit} owner command`,
      source: "someone says SSH passed", desktopHarness: { available: false,
        reason: NO_DISPLAYLESS_ELECTRON, probe: "someone says no harness", probedCommit: commit } } };
  assert.equal(specExecutionLimitation(capability, "apps/desktop/test/e2e/shared-paged-source-documents.spec.ts", commit), null);
});

test("ISS-13846 review DT-31 production SSH probe uses the selected worktree and real slot interface", t => {
  const commit = "5afa61faa88a057e2f67df4da923a7be6e46adf5";
  const root = mkdtempSync(path.join(tmpdir(), "selected-slot-interface-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const capture = path.join(root, "ssh-args.txt");
  const ssh = path.join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${capture}'\ncase "$*" in\n  *"/selected/iss-13699"*"--head ${commit} --native-desktop iss-13846-probe"*"node -e"*) echo 'Usage: e2e-slot.sh [--head <sha>] <owner-label> <command...>' >&2; exit 2;;\n  *"/selected/iss-13699"*"--head ${commit} iss-13846-probe"*"node -e"*) echo '{"kind":"selected-runner-desktop-capability/v2","head":"${commit}","worktree":"/selected/iss-13699","platform":"darwin","linuxHarness":false}'; exit 0;;\n  *) exit 1;;\nesac\n`);
  chmodSync(ssh, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const capability = { selectedTier: "C", probedCommit: commit,
    container: { ...container, dockerReachable: false }, native: { available: false },
    remote: { available: true, runnerHost: "selected-second-laptop", runnerWorktree: "/selected/iss-13699",
      probeOwner: "iss-13846-probe", command: `~/vibe-remote/e2e-slot.sh --head ${commit} iss-13846-probe <command...>`,
      source: "selected runner route", desktopHarness: { available: false,
        reason: NO_DISPLAYLESS_ELECTRON, probe: "selected Desktop route unavailable", probedCommit: commit } } };
  assert.deepEqual(specExecutionLimitation(capability,
    "apps/desktop/test/e2e/shared-paged-source-documents.spec.ts", commit),
  { tier: "C", kind: "displayless", displaylessLimitation: NO_DISPLAYLESS_ELECTRON });
  const invoked = readFileSync(capture, "utf8");
  for (const token of ["/selected/iss-13699", `--head ${commit}`, "--native-desktop", "iss-13846-probe", "node"])
    assert.ok(invoked.includes(token), token);
  for (const altered of [
    { ...capability, remote: { ...capability.remote, runnerWorktree: "/selected/wrong" } },
    { ...capability, remote: { ...capability.remote, probeOwner: "" } },
    { ...capability, remote: { ...capability.remote,
      desktopHarness: { ...capability.remote.desktopHarness, probedCommit: "a".repeat(40) } } },
  ]) assert.equal(specExecutionLimitation(altered,
    "apps/desktop/test/e2e/shared-paged-source-documents.spec.ts", commit), null);
});
