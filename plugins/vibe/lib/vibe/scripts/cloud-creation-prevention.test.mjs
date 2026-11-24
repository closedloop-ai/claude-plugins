import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {machineTestReport} from "./cloud-outcome-test-fixture.mjs";
import { currentClaudeAccount } from "./cloud-account-pin.mjs";
import { confirmCloudEnvironment } from "./cloud-validation-environment.mjs";
import { checkCloudSetup } from "./cloud-environment.mjs";
import { NO_EXECUTOR, readLedger, recordEnvironmentPin, runOnStanding } from "./cloud-routines.mjs";
import { remoteTrigger, validateCommit } from "./cloud-worker.mjs";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

const ACCOUNT = "a0a01111-1111-4111-a111-111111111111";
const SWITCHED = "b0b02222-2222-4222-b222-222222222222";
const ENV = "env_01LxFsf5RAQbZ2Yuuv7Bx4x8";
const OTHER = "env_01DDp7GK2XnFsuEnwRx26ehW";
const request = { claudeEnvironment: ENV };
const pin = { environmentId: ENV, accountUuid: ACCOUNT };
const routine = (id, environment) => ({ id, job_config: { ccr: { environment_id: environment } } });

test("ISS-14476 validates observed account and exact environment instead of accepting a stale pin", async (t) => {
  const { home, cleanup } = makeHome("vibe-account-pin-");
  t.after(cleanup);
  assert.deepEqual(await recordEnvironmentPin({ home, environmentId: ENV, accountUuid: ACCOUNT }),
    { ok: true, environmentId: ENV, accountBound: true });
  assert.equal(readLedger(home).environmentPin.accountUuid, ACCOUNT);
  const commit = "a".repeat(40);
  const checks = { workspace: true, nonRoot: true, ports: true, chromium: true, chromium1254:true, gitUtc: true,
    zsh: true, uv: true, python313: true, node24: true, pnpm: true };
  confirmCloudEnvironment({ home, pin, environmentId: ENV, tool: { commit, ref: "refs/heads/fixture" }, sessionId: "session",
    completed: true, outcome: { name: "cloud-capabilities", exitCode: 0, stdoutTail: "CLOUD_HOST_RUNTIME " + JSON.stringify({ commit, checks }) } });
  const current = { uuid: ACCOUNT };
  const check = (data, account = current, environment = request) =>
    checkCloudSetup(environment, { home, account, environmentPin: pin, remote: () => ({ data }) });
  assert.equal(check([routine("owned", ENV), routine("other", OTHER)]).ok, true);
  assert.equal(check([]).checks.find(({ check }) => check === "environment-use").ok, null);
  const unused = check([routine("other", OTHER)]);
  assert.equal(unused.ok, false);
  assert.equal(unused.checks.find(({ check }) => check === "environment-use").ok, false);
  assert.match(unused.checks.find(({ check }) => check === "environment-use").detail, /Re-pin.*this account/);
  let lookedUp = 0;
  const switched = checkCloudSetup(request, { account: { uuid: SWITCHED }, environmentPin: pin,
    remote: () => { lookedUp += 1; return { data: [routine("wrong", ENV)] }; } });
  assert.equal(switched.ok, false);
  assert.match(switched.checks.find(({ check }) => check === "account-pin").detail, /differs from the recorded pin/);
  assert.equal(lookedUp, 0);
  assert.equal(check([routine("other", OTHER)], current, { claudeEnvironment: OTHER }).ok, false);
  const fallback = checkCloudSetup(request, {
    home, account: current, environmentPin: pin, standing: { id: "old" },
    remote: (action) => action === "get" ? { trigger: routine("old", OTHER) } : { data: [routine("owned", ENV)] },
  });
  assert.equal(fallback.ok, true);
});

test("ISS-14476 accepts OAuth UUID only for the active Claude profile", () => {
  const home = "/fixture-home";
  const verified = {
    loggedIn: true, authMethod: "claude.ai", storedClaudeAiLogin: true,
    configDirectory: path.join(home, ".claude"), email: "fixture@example.invalid",
  };
  const run = (status) => () => ({ status: 0, stdout: JSON.stringify(status) });
  const profile = { accountUuid: ACCOUNT, emailAddress: verified.email };
  assert.equal(currentClaudeAccount({ home, run: run(verified), profile: (file) => {
    assert.equal(file, path.join(home, ".claude.json"));
    return profile;
  } }), ACCOUNT);
  assert.throws(() => currentClaudeAccount({ home, run: run(verified), profile: () => ({ ...profile, emailAddress: "different@example.invalid" }) }),
    /current|active Claude login/);
  assert.throws(() => currentClaudeAccount({ home, run: run({ ...verified, loggedIn: false }), profile: () => profile }),
    /CLOUD_ACCOUNT_UNVERIFIED/);
});

function cloudFixture(t, { refused = false, duplicate = false } = {}) {
  const fixture = makeHome("vibe-confirm-create-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "repo");
  const repository = "closedloop-ai/claude-plugins";
  makeCheckout({ ...fixture, checkout: worktree, remoteUrl: `https://github.com/${repository}.git` });
  const commit = git(worktree, ["rev-parse", "HEAD"], fixture.home);
  const calls = [];
  let runCount = 0;
  let activeRequest;
  const remote = (action, body, options = {}) => remoteTrigger(action, body, {
    ...options, home: fixture.home, run: (_command, args) => {
      const sent = JSON.parse(args[1].split("complete tool input: ")[1].split(". Do not call")[0]);
      calls.push({ action, maxTurns: Number(args[args.indexOf("--max-turns") + 1]), sent });
      let value;
      let head = "HTTP 200";
      let tail = "";
      if (action === "create") {
        head = refused ? "HTTP 400" : "HTTP 200 CREATE_TRIGGER_OUTCOME_CREATED";
        value = refused ? { error: { code: "environment_not_found" } } : { trigger: { id: "standing-fixture", mcp_connections: [] } };
      } else if (action === "update") {
        // At the precise update boundary, create already exists durably without its intent.
        assert.equal(readLedger(fixture.home).standing?.id, "standing-fixture");
        assert.deepEqual(readLedger(fixture.home).intents, []);
        value = { trigger: { id: "standing-fixture", mcp_connections: [] } };
      } else if (action === "run") {
        runCount += 1;
        value = { run_id: `run-${runCount}`, session_id: `session-${runCount}` };
      } else if (action === "list_runs") {
        value = { data: [{ id: `run-${runCount}`, status: "active", worker_status: "idle", session_id: `session-${runCount}` }] };
      } else if (action === "get_run_log") {
        value = { session_id: `session-${runCount}` };
        tail = "\n" + machineTestReport(activeRequest,[0]);
      } else {
        assert.fail("unexpected fixture operation " + action);
      }
      const terminal = action === "create" ? { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3 }
        : { type: "result", subtype: "success", is_error: false };
      const events = [
        { type: "assistant", message: { content: [{ type: "tool_use", name: "RemoteTrigger", id: "verified", input: sent }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "verified", content: head + "\n" + JSON.stringify(value) + tail }] } },
        terminal,
      ];
      if (duplicate && action === "create") events.splice(2, 0, events[1]);
      return { status: action === "create" ? 1 : 0, stdout: events.map(JSON.stringify).join("\n"), stderr: "" };
    },
  });
  const validate = (name = "unit") => {
    activeRequest={ worktree, repository, provider: "claude", model: "claude-sonnet-5-5", commit, branch: "main",
      claudeEnvironment: ENV, lanes: [{ name, command: "node --test selected.test.mjs" }], pollMs: 1000 };
    return validateCommit(activeRequest,{ remote, executor: NO_EXECUTOR, sleep: async () => {}, home: fixture.home });
  };
  return { ...fixture, calls, validate };
}

test("ISS-14476 adopts a verified create after agent max-turn and reuses it for the next validation", async (t) => {
  const f = cloudFixture(t);
  assert.equal((await f.validate()).passed, true);
  assert.equal((await f.validate("second-unit")).passed, true);
  assert.deepEqual(f.calls.filter(({ action }) => action === "create").map(({ maxTurns }) => maxTurns), [1]);
  assert.deepEqual(f.calls.filter(({ action }) => action === "run").map(({ sent }) => sent.trigger_id),
    ["standing-fixture", "standing-fixture"]);
  assert.equal(readLedger(f.home).standing?.id, "standing-fixture");
  assert.deepEqual(readLedger(f.home).intents, []);
});

test("ISS-14476 clears a confirmed environment refusal and never retries the create agent", async (t) => {
  const f = cloudFixture(t, { refused: true });
  await assert.rejects(f.validate(), /environment_not_found.*Re-pin the environment for this account/);
  assert.deepEqual(f.calls.map(({ action, maxTurns }) => [action, maxTurns]), [["create", 1]]);
  assert.deepEqual(readLedger(f.home).intents, []);
  assert.equal(readLedger(f.home).standing, null);
});

test("ISS-14476 leaves an ambiguous duplicate create result for intent reconciliation", async (t) => {
  const f = cloudFixture(t, { duplicate: true });
  await assert.rejects(f.validate(), /RemoteTrigger create failed/);
  assert.deepEqual(f.calls.map(({ action }) => action), ["create"]);
  assert.equal(readLedger(f.home).standing, null);
  assert.equal(readLedger(f.home).intents.length, 1);
});


test("ISS-14476 switches the standing routine ledger only on an explicit account re-pin", async (t) => {
  const fixture = makeHome("vibe-account-repin-");
  t.after(fixture.cleanup);
  const { home } = fixture;
  await recordEnvironmentPin({ home, environmentId: ENV, accountUuid: ACCOUNT });
  const actions = [];
  const remote = (action) => {
    actions.push(action);
    if (action === "create" || action === "update") return { trigger: { id: "original-standing", mcp_connections: [] } };
    if (action === "run") return { run_id: "known-run" };
    assert.fail("unexpected remote operation " + action);
  };
  const start = (uuid, id = ENV) => runOnStanding({ home, remote, account: () => uuid, environment: { id },
    ccr: { environment_id: id }, brief: "harmless fixture", waitMs: 1000 });
  await start(ACCOUNT);
  await assert.rejects(() => start(SWITCHED), /differs from the recorded pin/);
  await assert.rejects(() => start(ACCOUNT, OTHER), /differs from the recorded pin/);
  assert.deepEqual(actions, ["create", "update", "run"]);
  await recordEnvironmentPin({ home, environmentId: OTHER, accountUuid: SWITCHED });
  const switched = readLedger(home);
  assert.equal(switched.standing, null);
  assert.equal(switched.environmentAccounts[ACCOUNT].standing.id, "original-standing");
  await recordEnvironmentPin({ home, environmentId: ENV, accountUuid: ACCOUNT });
  const restored = readLedger(home);
  assert.equal(restored.standing.id, "original-standing");
  assert.equal(restored.runs[0].runId, "known-run");
  assert.equal(restored.environmentAccounts[SWITCHED].standing, null);
});
