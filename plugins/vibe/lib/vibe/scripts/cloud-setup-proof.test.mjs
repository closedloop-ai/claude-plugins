import assert from "node:assert/strict";
import test from "node:test";
import { checkCloudSetup } from "./cloud-environment.mjs";
import { CLOUD_CAPABILITIES_COMMAND } from "./cloud-check-command.mjs";
import { confirmCloudEnvironment, recordRuntimeFromValidation, measuredSetupTools } from "./cloud-validation-environment.mjs";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";

test("AC-102 check requires current measured account, environment and all five tools", (t) => {
  const f = makeHome("vibe-cloud-setup-");
  t.after(f.cleanup);
  const pin = { accountUuid: "a0a01111-1111-4111-a111-111111111111", environmentId: "env_Fixture" };
  const tool = { commit: "a".repeat(40), ref: "refs/heads/proof" };
  const checks = { workspace: true, nonRoot: true, ports: true, chromium: false, gitUtc: true,
    zsh: true, uv: true, python313: true, node24: true, pnpm: true };
  const remote = (action) => {
    assert.equal(action, "list");
    return { data: [{ id: "standing", job_config: { ccr: { environment_id: pin.environmentId } } }] };
  };
  const check = (options = {}) => checkCloudSetup({ claudeEnvironment: pin.environmentId }, {
    home: f.home, account: { uuid: pin.accountUuid }, environmentPin: pin, remote, ...options });
  const record = (flags, at = Date.now()) => confirmCloudEnvironment({ home: f.home, pin, environmentId: pin.environmentId,
    tool, sessionId: "session-fixture", completed: true, now: at, outcome: { name: "cloud-capabilities", exitCode: 0,
      stdoutTail: "CLOUD_HOST_RUNTIME " + JSON.stringify({ commit: tool.commit, checks: flags }) } });
  const refused = (result) => {
    assert.equal(result.ok, false);
    const detail = result.checks.find((row) => row.check === "lane-tools")?.detail;
    for (const pattern of [/claude.ai\/code/, /Setup script/, /cloud-env-setup.sh/, /CLOUD_CLAUDE_ENV/, /config.env/]) assert.match(detail, pattern);
  };
  refused(check({ remote: () => ({ data: [] }) }));
  refused(check());
  record(checks);
  assert.equal(check().ok, false, "a previous browser revision cannot satisfy the canonical setup");
  record({...checks, chromium:true, chromium1254:true});
  assert.equal(check().ok, true);
  refused(check({ account: { uuid: "b0b02222-2222-4222-b222-222222222222" } }));
  refused(check({ environmentPin: null }));
  for (const name of ["zsh", "uv", "python313", "node24", "pnpm"]) {
    record({ ...checks, chromium:true, chromium1254:true, [name]: false });
    refused(check());
  }
  record(checks, Date.now() - 31 * 60_000);
  refused(check());
});


test("AC-102 completion cannot rebind an unpinned, repinned or old run", (t) => {
  const f = makeHome("vibe-launch-proof-");
  t.after(f.cleanup);
  const pin = { accountUuid: "a0a01111-1111-4111-a111-111111111111", environmentId: "env_Fixture" };
  const checks = { workspace: true, nonRoot: true, ports: true, chromium: true, gitUtc: true, node24: true };
  const commit = "a".repeat(40);
  const outcome = { name: "cloud-capabilities", exitCode: 0, stdoutTail: "CLOUD_HOST_RUNTIME " + JSON.stringify({ commit, checks }) };
  const run = { runId: "run", routineId: "routine", sessionId: "session", startedAt: new Date().toISOString() };
  const measured = () => measuredSetupTools(f.home, pin, pin.accountUuid, pin.environmentId)?.node24;
  const canonical = [{name:outcome.name,command:CLOUD_CAPABILITIES_COMMAND,capabilityProbe:true}];
  const capture = (fields, lanes=canonical) => recordRuntimeFromValidation({ lanes, home: f.home, branch: "main", currentAccount: () => pin.accountUuid,
    ledger: () => ({ environmentPin: pin, runs: [{ ...run, ...fields }] }) }, { commit, lanes: [outcome] },
    { ...run, status: "completed", environment: { id: pin.environmentId } });
  capture({});
  assert.equal(measured(), undefined);
  capture({ accountUuid: "other", environmentId: pin.environmentId });
  assert.equal(measured(), undefined);
  capture({ ...pin, startedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
  assert.equal(measured(), undefined);
  capture(pin,[{name:outcome.name,command:"workflow step",workflow:{}}]);
  assert.equal(measured(),undefined);
  capture(pin);
  assert.equal(measured(), true);
});

test("AC-102 measures selected executables and exact required language versions", async () => {
  const { measureLaneTools } = await import("./cloud-capability-probe.mjs");
  const stdout = ["zsh 5.9 (linux)", "uv 0.10.2", "Python 3.13.3", "v24.1.2", "10.1.2"];
  const observe = (outputs) => {
    let index = 0;
    return measureLaneTools(async (name, args) => {
      assert.deepEqual([name, ...args], [
        ["zsh", "--version"], ["uv", "--version"], ["uv", "run", "--offline", "--no-project", "--python", "3.13", "python", "--version"],
        ["node", "--version"], ["pnpm", "--version"],
      ][index]);
      const output = outputs[index++];
      return { result: output ? "YES" : "NO", output };
    });
  };
  assert.deepEqual(await observe(stdout), { zsh: true, uv: true, python313: true, node24: true, pnpm: true });
  assert.deepEqual(await observe(["", "", "Python 3.12.0", "v22.0.0", ""]), { zsh: false, uv: false, python313: false, node24: false, pnpm: false });
});
