import { installedProviders } from "../../../../vibe-closedloop/lib/vibe/scripts/provider.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { admitCloudEnvironment, cloudHostInstruction, confirmCloudEnvironment, describeCloudLanes } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-validation-environment.mjs";
import { runCloudHostPlan } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-validation-host.mjs";
import { validateCommit, validationLanes } from "../../../../vibe-closedloop/lib/vibe/scripts/cloud-worker.mjs";
import { installPnpmHelpFixture } from "./pnpm-help-test-fixture.mjs";

installPnpmHelpFixture();

const TOOL = { commit: "a".repeat(40), ref: "refs/heads/vibe-proof" };
const ENV = "env_01LxFsf5RAQbZ2Yuuv7Bx4x8";
const PIN = { environmentId: ENV, accountUuid: "a0a01111-1111-4111-a111-111111111111" };
const NOW = Date.parse("2026-11-19T22:16:00Z");
const CHECKS = { workspace: true, nonRoot: true, ports: true, chromium: true, chromium1254:true, gitUtc: true };
const LANES = [{ name: "desktop-tests", command: "pnpm --dir apps/desktop test" }, { name: "gardener", command: "pnpm test:gardener" }];

test("ISS-14476 admits only current exact full env/account/tool proof and preserves both affected lane names", (t) => {
  const f = makeHome("vibe-runtime-admission-");
  t.after(f.cleanup);
  const inputs = { home: f.home, pin: PIN, tool: TOOL, environmentId: ENV, now: NOW };
  const check = (overrides = {}) =>
    admitCloudEnvironment(LANES, { ...inputs, currentAccount: PIN.accountUuid, ...overrides });
  const record = (checks, fields = {}) => confirmCloudEnvironment({
    ...inputs, completed: true, sessionId: "session-exact",
    outcome: { name: "cloud-capabilities", exitCode: 0, stdoutTail: `CLOUD_HOST_RUNTIME ${JSON.stringify({ commit: TOOL.commit, checks })}` }, ...fields,
  });
  const refuses = /desktop-tests.*gardener.*run on L2 \(remote slot heavy\)/;
  assert.throws(check, refuses);
  assert.equal(record(CHECKS), true);
  const ready = check();
  assert.deepEqual(ready.affected.map(({ name }) => name), ["desktop-tests", "gardener"]);
  const instructions = cloudHostInstruction(ready, { lanes: LANES, commit: "c".repeat(40) });
  assert.match(instructions, /git merge-base --is-ancestor a{40} FETCH_HEAD/);
  assert.match(instructions, /"browser":true/);
  assert.match(instructions, /\"commit\":\"c{40}\"/);
  assert.throws(() => check({ now: NOW + 30 * 60_000 + 1 }), refuses);
  assert.throws(() => check({ environmentId: "env_01Other" }), refuses);
  assert.throws(() => check({ currentAccount: "other-actor" }), refuses);
  assert.throws(() => check({ tool: { ...TOOL, ref: "refs/heads/other" } }), refuses);
  assert.throws(() => check({ tool: { ...TOOL, commit: "b".repeat(40) } }), refuses);
  assert.equal(record({ ...CHECKS, chromium: false }), true);
  record({...CHECKS,chromium:false,dockerBootstrap:true});
  assert.equal(admitCloudEnvironment([{name:"docker-setup",command:"pnpm docker:ensure",containerPnpm:true}],
    {...inputs,currentAccount:PIN.accountUuid}), null);
  assert.throws(check, /desktop-tests.*chromium/, "a partial new measurement supersedes a passing measurement");
  assert.equal(record(CHECKS), true);
  assert.equal(record(CHECKS, { outcome: { name: "cloud-capabilities", exitCode: 1, stdoutTail: "" } }), false);
  assert.throws(check, refuses, "a failed replacement also invalidates positive evidence");
  assert.equal(admitCloudEnvironment([{ name: "unit", command: "node --test simple.test.mjs" }], {}), null);
});

test("ISS-14476 validate names unsupported lanes before any cloud create, update, run or test command", async (t) => {
  const f = makeHome("vibe-runtime-pre-mutation-");
  t.after(f.cleanup);
  const worktree = path.join(f.root, "checkout");
  const repository = "closedloop-ai/claude-plugins";
  makeCheckout({ ...f, checkout: worktree, remoteUrl: `https://github.com/${repository}.git` });
  const commit = git(worktree, ["rev-parse", "HEAD"], f.home);
  const request = { worktree, commit, branch: "proof", model: "claude-sonnet-5-5", provider: "claude",
    repository, claudeEnvironment: ENV, lanes: LANES, runtimeTool: TOOL };
  const calls = [];
  await assert.rejects(() => validateCommit(request, { home: f.home, remote: (action) => { calls.push(action); } }),
    /CLOUD_LANES_UNAVAILABLE: desktop-tests.*gardener.*run on L2 \(remote slot heavy\)/);
  assert.deepEqual(calls, []);
});

const API_FIXTURE = "apps/api/.env.test";
const API_SETUP = "apps/api/__tests__/setup.ts";
const API_COMMAND = "pnpm --filter api test";
const FIXTURE_REGION = "us-west-2";
const FIXTURE = ["AWS_ACCESS_KEY_ID=test-access-key-id", "AWS_SECRET_ACCESS_KEY=test-secret-key", "AWS_REGION=" + FIXTURE_REGION].join("\n") + "\n";
const USE_FIXTURE = "dotenv.config({ path: path.resolve(__dirname, '../', '.env.test') });\n";

test("ISS-14476 API command refuses before provider creation unless committed test settings are approved", async (t) => {
  const f = makeHome("vibe-api-env-");
  t.after(f.cleanup);
  const worktree = path.join(f.root, "checkout");
  const repository = "closedloop-ai/claude-plugins";
  makeCheckout({ ...f, checkout: worktree, remoteUrl: `https://github.com/${repository}.git` });
  const request = { worktree, commit: git(worktree, ["rev-parse", "HEAD"], f.home), branch: "proof", model: "claude-sonnet-5-5",
    provider: "claude", repository, claudeEnvironment: ENV, lanes: [{ name: "api-unit", command: API_COMMAND }], runtimeTool: TOOL };
  const calls = [];
  const clients = { home: f.home, remote: (action) => { calls.push(action); throw new Error("unexpected provider call"); } };
  await assert.rejects(() => validateCommit(request, clients), /api-unit.*approved committed non-secret API test fixture.*run on L2 \(remote slot heavy\)/);
  await assert.rejects(() => validateCommit({ ...request, env: {} }, clients), /caller test environment values are refused/);
  assert.deepEqual(calls, []);
  for (const [file, text] of [[API_FIXTURE, FIXTURE], [API_SETUP, USE_FIXTURE]]) {
    mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    writeFileSync(path.join(worktree, file), text);
  }
  assert.equal(validationLanes(request).lanes[0].prerequisites.env.source, null, "worktree-only input cannot satisfy exact-commit admission");
  git(worktree, ["add", "--", API_FIXTURE, API_SETUP], f.home);
  git(worktree, ["commit", "-qm", "test: add approved public API fixture"], f.home);
  const commit = git(worktree, ["rev-parse", "HEAD"], f.home);
  const lanes = validationLanes({ ...request, commit }).lanes;
  assert.equal(lanes[0].prerequisites.env.source.commit, commit);
  assert.equal(lanes[0].prerequisites.env.source.source, API_SETUP);
  assert.deepEqual(lanes[0].prerequisites.env.source.keys, ["AWS_ACCESS_KEY_ID", "AWS_REGION", "AWS_SECRET_ACCESS_KEY"]);
  assert.doesNotMatch(JSON.stringify(lanes), /test-secret-key|test-access-key-id|us-west-2/);
  assert.equal(confirmCloudEnvironment({ home: f.home, pin: PIN, environmentId: ENV, tool: TOOL, completed: true,
    sessionId: "session-exact-approved", now: NOW,
    outcome: { name: "cloud-capabilities", exitCode: 0, stdoutTail: `CLOUD_HOST_RUNTIME ${JSON.stringify({ commit: TOOL.commit, checks: CHECKS })}` } }), true);
  assert.equal(admitCloudEnvironment(lanes, { home: f.home, pin: PIN, tool: TOOL, environmentId: ENV,
    currentAccount: PIN.accountUuid, now: NOW }).affected[0].env.source.commit, commit);
});

test("ISS-14476 classifies each lane and refuses incomplete, excessive, credential-looking, and unrelated settings", () => {
  const command = { name: "api-test", command: API_COMMAND };
  const describe = (fixture, setup) => describeCloudLanes([command], { commit: "c".repeat(40),
    read: (file) => ({ [API_FIXTURE]: fixture, [API_SETUP]: setup })[file],
  })[0].prerequisites;
  for (const [fixture, setup] of [
    [null, USE_FIXTURE], [FIXTURE, "// " + USE_FIXTURE], [FIXTURE, USE_FIXTURE.replace(".env.test", ".env.local")],
    [FIXTURE.replace(/^AWS_REGION=.*$/m, ""), USE_FIXTURE], [FIXTURE + "NEW_KEY=test-extra\n", USE_FIXTURE],
    [FIXTURE + "AWS_REGION=us-east-1\n", USE_FIXTURE], [FIXTURE.replace("test-access-key-id", "AK" + "IA1111111111111111"), USE_FIXTURE],
  ]) {
    assert.deepEqual(describe(fixture, setup), { packages: [], capabilities: ["nonRoot"], env: { kind: "api-test", source: null } });
  }
  const classified = describeCloudLanes([
    { name: "setup:build", command: "pnpm --filter @repo/required build", prerequisite: true },
    { name: "web-container", command: "e2e/run-containerized.sh -- --list", cloudE2E: "(preflight)" },
    { name: "desktop-spec", command: "pnpm --dir apps/desktop test:e2e test/e2e/window.spec.ts", cloudE2E: "(preflight)" },
    { name: "api-alt", command: "pnpm -F api run test" },
    { name: "api-ci", command: JSON.stringify({ workflow: {}, job: { steps: [{ run: "pnpm test", "working-directory": "apps/api" }] } }), workflow: {} },
  ]);
  assert.deepEqual(classified[0].prerequisites, { packages: [], capabilities: [], env: null });
  assert.deepEqual(classified[1].prerequisites.capabilities, ["docker"]);
  assert.deepEqual(classified[2].prerequisites.capabilities, ["workspace", "ports", "chromium", "chromium1254", "display"]);
  assert.deepEqual(classified[2].prerequisites.packages, ["@repo/required"]);
  assert.equal(classified[3].prerequisites.env.kind, "api-test");
  assert.equal(classified[4].prerequisites.env.kind, "api-test");
});

test("ISS-14476 host imports exact approved bytes for the lane and redacts fixture values from evidence", (t) => {
  const f = makeHome("vibe-approved-host-fixture-");
  t.after(f.cleanup);
  const checkout = path.join(f.root, "checkout");
  const commit = "f".repeat(40);
  mkdirSync(checkout);
  const fixtureFiles = { [API_FIXTURE]: FIXTURE, [API_SETUP]: USE_FIXTURE };
  const [{ prerequisites: { env } }] = describeCloudLanes([{ name: "api", command: API_COMMAND }], {
    read: (file) => fixtureFiles[file], commit,
  });
  const calls = [];
  let observedCommit = commit;
  const run = (command, args, options) => {
    if (command === "git") {
      assert.equal(options.uid,1000);
      assert.equal(options.gid,1000);
      const stdoutTail = args[0] === "rev-parse" ? observedCommit + "\n" : fixtureFiles[args[1].slice(5)];
      return { exitCode: stdoutTail ? 0 : 1, stdoutTail };
    }
    calls.push({ command, args, env: options.env });
    return { exitCode: 0, stdoutTail: options.env.AWS_ACCESS_KEY_ID, stderrTail: options.env.AWS_SECRET_ACCESS_KEY, diagnosis: options.env.AWS_REGION };
  };
  const execute = (directory, envSource) => {
    const work = path.join(f.root, directory);
    mkdirSync(work);
    return runCloudHostPlan({ checkout, directory: work, contract: installedProviders()[0].contract, lanes: [{ name: "api", command: API_COMMAND, envSource }],
      uid: 1000, gid: 1000, run, environment: { AWS_ACCESS_KEY_ID: "never-inherit" } })[0];
  };
  const passed = execute("accepted", env.source);
  assert.equal(passed.exitCode, 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [["pnpm", "--filter", "api", "test"]]);
  assert.equal(calls[0].env.AWS_REGION, FIXTURE_REGION);
  assert.equal(calls[0].env.AWS_ACCESS_KEY_ID, "test-access-key-id");
  assert.doesNotMatch(JSON.stringify(passed), /test-secret-key|test-access-key-id|us-west-2|never-inherit/);
  const wrongSource = execute("wrong-source", { ...env.source, source: ".env.local" });
  assert.equal(wrongSource.exitCode, null);
  assert.match(wrongSource.notRun, /fixture differs.*run on L2/);
  observedCommit = "b".repeat(40);
  assert.equal(execute("stale-commit", env.source).exitCode, null);
  observedCommit = commit;
  fixtureFiles[API_FIXTURE] = FIXTURE.replace("us-west-2", "us-west-1");
  assert.equal(execute("mismatched-digest", env.source).exitCode, null);
  assert.equal(calls.length, 1);
});

test("both control filters and the pkgs-a group consume the measured namespace capability", ()=>{
  for(const [name,command] of [["control","pnpm -F @repo/control test"],["control","pnpm --filter @repo/control test"],["pkgs-a","pnpm test"]]){
    const lane = name === "pkgs-a" ? {name, workflow:{}, command:JSON.stringify({workflow:{}, job:{steps:[{run:command}]}})} : {name,command};
    const lanes=describeCloudLanes([lane]);
    assert.ok(lanes[0].prerequisites.capabilities.includes("controlNamespace"));
    const instructions=cloudHostInstruction({tool:TOOL,affected:lanes.map(l=>({name:l.name,...l.prerequisites}))},{lanes,commit:TOOL.commit});
    assert.match(instructions,/"isolateControlPorts":true/);
  }
});

test("committed API fixture Git reads run as the real checkout owner", t => {
  const f = makeHome("vibe-actor-git-");
  t.after(f.cleanup);
  const checkout = path.join(f.root,"checkout"), directory = path.join(f.root,"work");
  chmodSync(f.root,0o711);
  mkdirSync(directory,{mode:0o711});
  const files = {[API_FIXTURE]:FIXTURE,[API_SETUP]:USE_FIXTURE,
    "verify.cjs":"process.exitCode=process.getuid() > 0 && process.env.AWS_REGION ? 0 : 1"};
  makeCheckout({...f,checkout,files});
  const commit = git(checkout,["rev-parse","HEAD"],f.home);
  const [{prerequisites:{env}}] = describeCloudLanes([{name:"api",command:API_COMMAND}],
    {read:file=>files[file],commit});
  const [result] = runCloudHostPlan({checkout,directory,contract:installedProviders()[0].contract,
    lanes:[{name:"api",command:"node verify.cjs",envSource:env.source}]});
  assert.equal(result.exitCode,0,result.diagnosis);
  assert.equal(result.runtime.uid,process.getuid() || 65534);
});

test("direct labels never change requirements and equivalent package commands share admission",()=>{
  const describe=(name,command)=>describeCloudLanes([{name,command}])[0].prerequisites;
  assert.deepEqual(describe("desktop-version","node --version"),describe("version","node --version"));
  assert.deepEqual(describe("docker-desktop","pnpm docker:ensure"),describe("docker","pnpm docker:ensure"));
  assert.deepEqual(describe("app","pnpm -F @repo/app test"),describe("app","pnpm --filter @repo/app test"));
  assert.deepEqual(describe("api",'pnpm --filter api "test"'),describe("api","pnpm --filter api test"));
});

test("finished owned validation is replayable after capability proof expiry",async t=>{
  const {createHash}=await import("node:crypto");
  const {recordEnvironmentPin}=await import("./cloud-routines.mjs");
  const {validationReceiptName}=await import("./cloud-receipts.mjs");
  const f=makeHome("vibe-replay-expiry-");t.after(f.cleanup);
  const worktree=path.join(f.root,"checkout"),repository="closedloop-ai/claude-plugins";
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/"+repository+".git"});
  const commit=git(worktree,["rev-parse","HEAD"],f.home);
  const request={worktree,commit,branch:"proof",model:"claude-sonnet-5-5",provider:"claude",repository,claudeEnvironment:ENV,lanes:LANES,runtimeTool:TOOL};
  const digest=createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const receipt=path.join(worktree,".git",validationReceiptName(commit,digest));
  await recordEnvironmentPin({home:f.home,...PIN});
  writeFileSync(receipt,JSON.stringify({requestDigest:digest,...PIN,environment:{id:ENV},taskId:"saved",runId:"saved",status:"completed",validationReport:{passed:true}}));
  const clients={home:f.home,currentAccount:()=>PIN.accountUuid,remote:()=>assert.fail("no provider I/O for completed run")};
  assert.equal((await validateCommit(request,clients)).taskId,"saved");
  await assert.rejects(validateCommit(request,{...clients,currentAccount:()=>"other"}),/account/i);
});

test("package capability selection follows the operation and resolved package",()=>{
  const read=file=>file==="packages/control/package.json"?'{"name":"@repo/control"}':null;
  const caps=command=>describeCloudLanes([{name:"fixture",command}],{read})[0].prerequisites.capabilities;
  assert.deepEqual(caps("pnpm --dir packages/control test"),caps("pnpm --filter @repo/control test"));
  assert.ok(!caps("pnpm --filter desktop run typecheck").includes("chromium"));
  assert.deepEqual(caps("node --check apps/desktop/scripts/run-typecheck-passes.mjs"),[]);
  assert.ok(caps("pnpm --filter desktop test:renderer").includes("chromium"));
});

test("mixed Turbo tasks keep all prerequisites and committed typecheck aliases use typecheck policy",()=>{
  const read=file=>file==="package.json"?JSON.stringify({scripts:{"desktop:typecheck":"pnpm turbo typecheck --filter=desktop"}}):null;
  const caps=command=>describeCloudLanes([{name:"fixture",command}],{read})[0].prerequisites.capabilities;
  assert.deepEqual(caps("pnpm desktop:typecheck"),caps("pnpm turbo typecheck --filter=desktop"));
  const mixed=caps("pnpm turbo run typecheck test --filter=@repo/control");
  for(const capability of caps("pnpm turbo run test --filter=@repo/control")) assert.ok(mixed.includes(capability),capability);
});
