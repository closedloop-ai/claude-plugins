// State that crosses vibe versions. In Claude Code an update without a restart leaves a session running vibe N's
// skills while vibe-core's loader already hands each hook to vibe N+1's guards (the registry names N+1), and a fat
// vibe-core's own guards may read what a newer vibe wrote. So the records the guards read stay where they are and
// stay readable across adjacent versions: these pin both directions.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { hookActivated, readHookSkill, recordHookSkill } from "../hooks/hook-session-scope.mjs";
import { blockingProblem, markPending, readStartupRecord, startupFile, VersionStatus } from "../lib/vibe/scripts/startup-record.mjs";
import { launcherWorker, recordWorkerScope } from "../lib/vibe/scripts/worker-scope.mjs";
import { Layout, VIBE_SOURCE, machine, tempRoot, writePlugin } from "./vibe-core-skew-test-support.mjs";

const FORCE_PUSH = ["git", "push", "-f", "origin", "fix/x"].join(" ");
/** Installs a copy of this checkout's vibe, as version `version`, in machine `m`'s cache without registering it. */
function installCopy(m, version) {
  const root = path.join(m.cache, "vibe", version);
  cpSync(VIBE_SOURCE, root, { recursive: true, filter: file => !file.endsWith(".test.mjs") && path.basename(file) !== "node_modules" });
  return writePlugin(root, { name: "vibe", version });
}

/** The module at `relative` in the vibe copy at `root`. */
function from(root, relative) {
  return import(pathToFileURL(path.join(root, relative)).href);
}

/** The permission decision in a PreToolUse result (vibe's guards may refuse; vibe-core itself never does), or null. */
function decision(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? null : JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision ?? null;
}

test("Claude Code mid-session skew: what vibe N's scripts write, vibe N+1's guards (loaded by vibe-core) read", async (t) => {
  const m = machine(t, Layout.Claude);
  const older = installCopy(m, "1.2.0");
  const newer = installCopy(m, "1.3.0");
  // The session started on 1.2.0; `claude plugin update` then repointed the registry at 1.3.0 without a restart.
  m.register("vibe", [{ scope: "user", installPath: newer }]);
  const bash = (session, command) => m.run("PreToolUse", { session_id: session, tool_name: "Bash", tool_input: { command } });

  // vibe N's skill start marked the conversation pending; vibe N+1's version guard holds a worker launch on it.
  (await from(older, "lib/vibe/scripts/startup-record.mjs")).markPending("skew-pending", m.home);
  const launch = bash("skew-pending", "node /x/skills/vibe/scripts/claude-worker.mjs start");
  assert.equal(decision(launch), "deny", launch.stderr);
  const reason = JSON.parse(launch.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /has not run/);
  assert.ok(reason.includes(newer), "the refusal comes from the vibe the registry names now");

  // vibe N's launcher recorded its worker; vibe N+1's activation counts it, so an activated-only guard acts.
  assert.equal(decision(bash("skew-worker", FORCE_PUSH)), null, "not activated yet");
  (await from(older, "lib/vibe/scripts/worker-scope.mjs")).recordWorkerScope("skew-worker", m.project, m.home);
  assert.equal(decision(bash("skew-worker", FORCE_PUSH)), "deny");

  // vibe N's hooks recorded a skill start; vibe N+1's guards read that record.
  (await from(older, "hooks/hook-session-scope.mjs")).recordHookSkill("skew-hook", "vibe:vibe", m.home);
  assert.equal(decision(bash("skew-hook", FORCE_PUSH)), "deny");
});

test("state locations do not depend on the vibe version or install that computes them", async (t) => {
  const m = machine(t, Layout.Codex);
  const [a, b] = [installCopy(m, "1.2.0"), installCopy(m, "1.3.0")];
  const locations = async (root) => {
    const scope = await from(root, "hooks/hook-session-scope.mjs");
    const startup = await from(root, "lib/vibe/scripts/startup-record.mjs");
    const owned = await from(root, "lib/vibe/scripts/owned-state.mjs");
    const kill = await from(root, "hooks/kill-guard.mjs");
    return { hookState: scope.hookStatePath("s-1", "pause-guard", m.home), startup: startup.startupFile("s-1", m.home),
      cleanup: owned.cleanupDir(m.home), e2eLock: owned.e2eLockDir(m.home), killLedger: kill.ledgerFile(m.home) };
  };
  const [first, second] = [await locations(a), await locations(b)];
  assert.deepEqual(first, second);
  for (const location of Object.values(first)) assert.ok(location.startsWith(`${m.home}${path.sep}`), `${location} is under HOME`);
});

test("state round trip: the hook record keeps the fields an older reader needs, and an older record still activates", (t) => {
  const home = tempRoot(t, "hook-record");
  const now = new Date();
  recordHookSkill("s-new", "vibe:vibe", home, now);
  const written = JSON.parse(readFileSync(path.join(home, ".vibe-hook-scope", "s-new.json"), "utf8"));
  // A fat vibe-core's reader: the exact session, a fresh recordedAt, then `activated` or a scoped `skill`.
  assert.equal(written.sessionId, "s-new");
  assert.equal(written.activated, true);
  assert.equal(written.skill, "vibe");
  assert.equal(written.recordedAt, now.toISOString());
  // A record from before the `activated` field: a scoped skill alone counts.
  mkdirSync(path.join(home, ".vibe-hook-scope"), { recursive: true });
  writeFileSync(path.join(home, ".vibe-hook-scope", "s-old.json"), JSON.stringify({ sessionId: "s-old", skill: "fleet-orchestrator", recordedAt: now.toISOString() }));
  assert.equal(hookActivated("s-old", home, now), true);
  assert.equal(readHookSkill("s-old", home, now), "fleet-orchestrator");
});

test("state round trip: the launcher's worker record and the startup record read back in the shapes earlier versions wrote", (t) => {
  const home = tempRoot(t, "records");
  const now = new Date();
  const file = recordWorkerScope("w-new", "/repo/worktree", home, now);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort(), ["recordedAt", "sessionId", "worktree"]);
  assert.equal(launcherWorker("w-new", home, now), true);
  const legacyWorker = path.join(home, ".vibe-hook-scope", "workers", "w-old.json");
  writeFileSync(legacyWorker, JSON.stringify({ sessionId: "w-old", worktree: "/repo/worktree", recordedAt: now.toISOString() }));
  assert.equal(launcherWorker("w-old", home, now), true);

  const pending = markPending("c-new", home, now);
  assert.deepEqual(pending, { conversation: "c-new", status: VersionStatus.Pending, startedAt: now.toISOString() });
  assert.deepEqual(readStartupRecord("c-new", home), pending);
  writeFileSync(startupFile("c-old", home), JSON.stringify({ conversation: "c-old", status: "outdated", versions: "vibe 1.1.80 < 1.2.0" }));
  assert.match(blockingProblem(readStartupRecord("c-old", home)), /outdated \(vibe 1\.1\.80 < 1\.2\.0\)/, "an earlier outdated record still blocks");
  writeFileSync(startupFile("c-old", home), JSON.stringify({ conversation: "c-old", status: "outdated", versions: "vibe 1.1.80 < 1.2.0", choice: "proceed" }));
  assert.equal(blockingProblem(readStartupRecord("c-old", home)), null, "and its recorded choice still releases it");
});

test("state round trip: owned-state records written by one vibe install read back through another", async (t) => {
  const m = machine(t, Layout.Codex);
  const [a, b] = [installCopy(m, "1.2.0"), installCopy(m, "1.3.0")];
  const writer = await from(a, "lib/vibe/scripts/owned-state.mjs");
  const reader = await from(b, "lib/vibe/scripts/owned-state.mjs");
  assert.equal(writer.OWNERSHIP_VERSION, reader.OWNERSHIP_VERSION);
  const file = path.join(writer.cleanupDir(m.home), "skew.json");
  const record = { version: writer.OWNERSHIP_VERSION, owner: "skew-session", resources: ["container-1"] };
  writer.writeAtomic(file, record);
  assert.deepEqual(reader.regularJson(file), record);
});
