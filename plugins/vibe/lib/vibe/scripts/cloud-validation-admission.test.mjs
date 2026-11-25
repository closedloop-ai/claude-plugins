import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { capturedJson } from "./captured-json.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { readProcessIdentity } from "../../../shared/process-identity.mjs";
import { recoverValidationReservation, withCloudValidationAdmission } from "./cloud-validation-admission.mjs";
import { ledgerPath, NO_EXECUTOR, readLedger } from "./cloud-routines.mjs";
import {machineTestReport} from "./cloud-outcome-test-fixture.mjs";
import { abandonValidation, pollTask, remoteTrigger, sha256, validateCommit } from "./cloud-worker.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";
import { markerlessProvider, queueFile, queueState, unreadableProvider } from "./cloud-validation-queue-test-fixture.mjs";

function fixture(t) {
  const f = makeHome("vibe-cloud-validation-admission-");
  t.after(f.cleanup);
  const receipt = (key) => path.join(f.root, `${key}.json`);
  const lines = [];
  const execute = (key, action, options = {}) => withCloudValidationAdmission({
    home: f.home, account: "verified-fixture-account", key, receipt: receipt(key), timeoutMs: 3000, sleepMs: 5,
    identityOf: () => "mock-process-start", recover: () => "terminal", report: (line) => lines.push(line), ...options,
  }, action);
  return { home: f.home, receipt, lines, execute };
}

/** A validation request for a fresh fixture checkout, with the routine service the tests drive. */
function adoptionFixture(t) {
  const f = makeHome("vibe-cloud-validation-adopt-");
  t.after(f.cleanup);
  const repository = "closedloop-ai/claude-plugins";
  const worktree = path.join(f.root, "checkout");
  makeCheckout({ ...f, checkout: worktree, remoteUrl: `https://github.com/${repository}.git` });
  const commit = git(worktree, ["rev-parse", "HEAD"], f.home);
  const request = { commit, worktree, repository, provider: "claude", model: "claude-sonnet-5-5", branch: "proof",
    claudeEnvironment: "env_01QueueFixture", pollMs: 1000, lanes: [{ name: "unit-1", command: "node --test selected.test.mjs" }] };
  return { ...f, request };
}

test("ISS-14476 ten concurrent cloud requests each fire once at declared one-run capacity", async (t) => {
  const f = fixture(t);
  let active = 0;
  const started = [];
  await Promise.all(Array.from({ length: 10 }, (_, index) => f.execute(String(index), async ({ launching }) => {
    await launching();
    active++;
    assert.equal(active, 1);
    started.push(index);
    await sleep(8);
    active--;
  })));
  assert.equal(new Set(started).size, 10);
  assert.equal(f.lines.length, 10);
  assert.ok(f.lines.every((line) => line.startsWith("CLOUD_VALIDATION_CAPACITY 1")));
});

test("ISS-14476 queued cancellation and timeout do not launch or overtake a live reservation", async (t) => {
  const f = fixture(t);
  let begin;
  let finish;
  const entered = new Promise((resolve) => { begin = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const active = f.execute("first", async () => { begin(); await hold; });
  await entered;
  const abort = new AbortController();
  const second = f.execute("cancelled", () => assert.fail("cancelled request launched"), { signal: abort.signal });
  abort.abort();
  await assert.rejects(second, /aborted/i);
  await assert.rejects(f.execute("timed-out", () => assert.fail("timed-out request launched"), { timeoutMs: 25 }), /did not launch/);
  finish();
  await active;
  assert.equal(await f.execute("next", () => "running"), "running");
});

test("ISS-14476 a durable exact run can restore its receipt after host loss without a second launch", (t) => {
  const f = fixture(t);
  const entry = { key: "request-exact", receipt: f.receipt("restore"), metadata: { commit: "a".repeat(40), laneKeys: ["one"] } };
  const run = { requestKey: entry.key, routineId: "routine", runId: "existing", sessionId: "session" };
  const ledger = { runs: [{ ...run, requestKey: "different" }, run] };
  const seen = [];
  const remote = (action, input) => {
    seen.push([action, input]);
    return input.cursor === "page-two" ? { data: [{ id: "existing", status: "running" }] } : { data: [], next_cursor: "page-two" };
  };
  assert.equal(recoverValidationReservation(entry, { ledger, remote }), "active");
  assert.equal(regularJson(entry.receipt).requestDigest, entry.key);
  assert.deepEqual(regularJson(entry.receipt).laneKeys, ["one"]);
  assert.deepEqual(seen, [["list_runs", { trigger_id: "routine" }], ["list_runs", { trigger_id: "routine", cursor: "page-two" }]]);
  writeAtomic(entry.receipt, { ...regularJson(entry.receipt), status: "completed" });
  assert.equal(recoverValidationReservation(entry, { ledger, remote: () => assert.fail("completed requests never probe again") }), "terminal");
  assert.equal(recoverValidationReservation({ ...entry, receipt: f.receipt("unknown"), key: "not-seen" }, { ledger, remote }), "unknown");
});


test("ISS-14476 ten validate calls wait for routine visibility and start exactly once at the provider boundary", async (t) => {
  const f = makeHome("vibe-cloud-validation-fifo-");
  t.after(f.cleanup);
  const repository = "closedloop-ai/claude-plugins";
  const worktree = path.join(f.root, "checkout");
  makeCheckout({ ...f, checkout: worktree, remoteUrl: `https://github.com/${repository}.git` });
  const commit = git(worktree, ["rev-parse", "HEAD"], f.home);
  const request = { commit, worktree, repository, provider: "claude", model: "claude-sonnet-5-5", branch: "proof",
    claudeEnvironment: "env_01QueueFixture", pollMs: 1000 };
  let currentLane;
  let outstanding;
  let creations = 0;
  const launched = [];
  const runs = new Map();
  const remote = (action, payload) => {
    if (action === "create") { creations++; return { trigger: { id: "standing", mcp_connections: [] } }; }
    if (action === "update") {
      currentLane = /- (unit-[0-9]+):/.exec(payload.body.job_config.ccr.events[0].data.message.content)[1];
      return { trigger: { id: "standing", mcp_connections: [] } };
    }
    if (action === "run") {
      assert.equal(outstanding, undefined);
      outstanding = currentLane;
      assert.ok(!runs.has(outstanding), "never dispatch the same request twice");
      const id = `run-${outstanding}`;
      runs.set(outstanding, { id, reads: 0 });
      launched.push(outstanding);
      return { run_id: id, session_id: outstanding };
    }
    if (action === "list_runs") {
      const run = runs.get(outstanding);
      if (!run || run.reads++ === 0) return { data: [] };
      const name = outstanding;
      outstanding = undefined;
      return { data: [{ id: run.id, status: "active", worker_status: "idle", session_id: name }] };
    }
    if (action === "get_run_log") return {log:machineTestReport({...request,lanes:[{name:payload.session_id,command:"node --test selected.test.mjs"}]},[0])};
    assert.fail(action);
  };
  const first = {...request, lanes:[{name:"unit-100", command:"node --test selected.test.mjs"}]};
  const prelaunch = (action, payload) => {
    if (action === "update") throw Object.assign(new Error("update timed out"), {code:"CLOUD_CALL_TIMEOUT"});
    return remote(action, payload);
  };
  await assert.rejects(validateCommit(first, {remote:prelaunch, home:f.home, executor:NO_EXECUTOR}), /update timed out/);
  const queues = path.join(f.home, ".codex", "vibe", "cloud", "validation-queues");
  const {readdirSync} = await import("node:fs");
  assert.equal(regularJson(path.join(queues, readdirSync(queues)[0], "queue.json")).active, null);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => {
    const lane = { name: `unit-${index}`, command: "node --test selected.test.mjs" };
    return validateCommit({ ...request, lanes: [lane] }, { remote, home: f.home, executor: NO_EXECUTOR, sleep: async () => {} });
  }));
  assert.equal(launched.length, 10);
  assert.equal(creations, 1);
  assert.ok(results.every(({ passed }) => passed));
  assert.ok([...runs.values()].every(({ reads }) => reads === 2));
});

test("a truncated polling response retries transport timeouts", () => {
  let attempts = 0;
  assert.throws(() => remoteTrigger("list_runs", {}, {pause: () => {}, run: () => {
    attempts++;
    return {stdout:"{", status:null, error:{code:"ETIMEDOUT"}};
  }}), {code:"CLOUD_CALL_TIMEOUT"});
  assert.equal(attempts, 3);
});

test("ordinary captured JSON documents reject trailing input",()=>{
  for(const suffix of ["\n{}","\n{","\ntrailing text"]) assert.throws(()=>capturedJson('{"data":[]}'+suffix));
  assert.deepEqual(capturedJson('{\n"data":[]\n}'),{data:[]});
});

test("a lost provider acknowledgement releases the next queued request through its exact launch marker", async t => {
  const f=fixture(t), identity={routineId:"standing",launchToken:"123e4567-e89b-42d3-a456-426614174000",startedAt:new Date().toISOString()};
  await assert.rejects(f.execute("lost",async ({launching})=>{
    await launching(identity);
    throw Object.assign(new Error("acknowledgement lost"),{code:"CLOUD_CALL_TIMEOUT"});
  }),/acknowledgement lost/);
  const remote=(action,input)=>{
    if(action==="list_runs") return {data:[
      {id:"sibling",session_id:"other",status:"completed"},
      {id:"launched",session_id:"owned",status:"completed"},
    ]};
    if(action==="get_run_log") return {log:input.session_id==="owned" ? "[2026-11-23T12:00:00Z] assistant: VIBE_VALIDATION_LAUNCH "+identity.launchToken : "VIBE_VALIDATION_LAUNCH another"};
    assert.fail(action);
  };
  assert.equal(await f.execute("next",()=> "admitted",{recover:entry=>recoverValidationReservation(entry,{ledger:{runs:[]},remote}),timeoutMs:80}),"admitted");
  assert.equal(regularJson(f.receipt("lost")).runId,"launched");
});

test("local abandonment holds capacity until the exact provider run ends", t=>{
  const f=fixture(t), entry={key:"one",receipt:f.receipt("one")};
  writeAtomic(entry.receipt,{status:"abandoned",runId:"first",routineId:"standing"});
  for(const [status,want] of [["running","active"],["completed","terminal"],["cancelled","terminal"]]){
    const remote=()=>({data:[{id:"other",status:"completed"},{id:"first",status}]});
    assert.equal(recoverValidationReservation(entry,{ledger:{runs:[]},remote}),want);
  }
});

test("queue retains a locally abandoned active run until the provider confirms termination",async t=>{
  const f=fixture(t);
  await f.execute("active",async ({launching})=>{
    await launching();
    writeAtomic(f.receipt("active"),{status:"abandoned",routineId:"standing",runId:"owned"});
  });
  let status="running", clock=0;
  const observed={
    now:()=>clock,wait:async delay=>{clock+=delay;}, timeoutMs:20,
    recover:entry=>recoverValidationReservation(entry,{ledger:{runs:[]},remote:()=>({data:[{id:"owned",status}]})}),
  };
  await assert.rejects(f.execute("next",()=>assert.fail("released before provider termination"),observed),/did not launch/);
  status="completed";
  assert.equal(await f.execute("next",()=>"admitted",observed),"admitted");
  assert.equal(regularJson(f.receipt("active")).status,"abandoned");
});

test("a verified update consumes its response header before opaque transport material",()=>{
  const invoke=body=>remoteTrigger("update",{trigger_id:"fixture"},{run:()=>({status:0,stderr:"",stdout:[
    {message:{content:[{type:"tool_use",name:"RemoteTrigger",id:"one",input:{action:"update",trigger_id:"fixture"}}]}},
    {message:{content:[{type:"tool_result",tool_use_id:"one",content:"HTTP 200\n"+body}]}},
  ].map(event=>JSON.stringify(event)).join("\n")})});
  assert.deepEqual(invoke('{"trigger":{"id":"fixture"}}\nopaque transport footer'),{trigger:{id:"fixture"}});
  assert.throws(()=>invoke('{"trigger":{}} {}\nopaque transport footer'),/did not return JSON/);
});

test("routine polling consumes the authenticated provider response header",()=>{
  const result=remoteTrigger("list_runs",{trigger_id:"fixture"},{run:()=>({status:0,stderr:"",stdout:[
    {message:{content:[{type:"tool_use",name:"RemoteTrigger",id:"one",input:{action:"list_runs",trigger_id:"fixture"}}]}},
    {message:{content:[{type:"tool_result",tool_use_id:"one",content:'HTTP 200\n{"data":[]}\nprivate transport material'}]}},
  ].map(event=>JSON.stringify(event)).join("\n")})});
  assert.deepEqual(result,{data:[]});
});

test("a bounded visibility miss retries the exact run and preserves unknown status at deadline", async () => {
  const {pollTask} = await import("./cloud-worker.mjs");
  const receipt = {provider:"claude",routineId:"standing",runId:"owned",sessionId:"session",startedAt:new Date(0).toISOString()};
  for (const reappears of [true,false]) {
    let clock=0, pages=0, logs=0;
    const remote=(action, input)=>{
      if (action==="get_run_log") { logs++; assert.equal(input.session_id,"session"); return {}; }
      assert.equal(action,"list_runs");
      assert.equal(input.trigger_id,"standing");
      pages++;
      if (reappears && pages===11) return {data:[{id:"owned",status:"completed",session_id:"session"}]};
      return {data:[{id:"sibling",status:"completed"}],next_cursor:"page-"+pages};
    };
    const result=await pollTask(receipt,{maxWallMs:5,pollMs:5},{remote,waitForVisibility:true,
      now:()=>clock,sleep:async ms=>{clock+=ms;}});
    assert.equal(result.runId,"owned");
    assert.equal(result.status,reappears?"completed":"overdue");
    assert.equal(pages,reappears?11:20);
    assert.equal(logs,reappears?1:0);
    if (!reappears) assert.equal(result.remoteStatus,"unknown");
  }
});

test("an unknown inventory at the deadline cannot become a missing run",async()=>{
  const {pollTask}=await import("./cloud-worker.mjs");
  const receipt={provider:"claude",routineId:"routine",runId:"owned",sessionId:"session",startedAt:new Date(0).toISOString()};
  let reads=0;
  const result=await pollTask(receipt,{repository:"example/widgets",maxWallMs:5,pollMs:5},{waitForVisibility:true,
    now:()=>reads++===0?4:5,sleep:async()=>{},remote:action=>{
      assert.equal(action,"list_runs");
      return {data:[{id:"sibling",status:"completed"}],next_cursor:"next"};
    }});
  assert.equal(result.status,"overdue");assert.equal(result.remoteStatus,"unknown");assert.equal(result.runId,"owned");
});

test("queued validations launch in the order they arrived once the active one releases", async (t) => {
  const f = fixture(t);
  const started = [];
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = f.execute("first", async ({ launching }) => { await launching(); started.push("first"); await held; });
  while (!started.length) await sleep(5);
  const waiters = [];
  for (const key of ["b", "c", "d", "e", "f"]) {
    waiters.push(f.execute(key, async ({ launching }) => { await launching(); started.push(key); await sleep(2); }));
    await sleep(25);
  }
  release();
  await Promise.all([first, ...waiters]);
  assert.deepEqual(started, ["first", "b", "c", "d", "e", "f"]);
});

const LAUNCH = { routineId: "standing", launchToken: "93383742-95da-42d3-9ace-2d1fcf6dbf8e" };
const lostLaunch = (message) => Object.assign(new Error(message), { code: "CLOUD_CALL_TIMEOUT" });

test("ISS-14476 DT-149R a launching reservation whose launcher is gone is reclaimed after the launch window, never inside it", async (t) => {
  const f = fixture(t);
  let clock = Date.parse("2026-11-24T23:15:35.893Z");
  const timed = { now: () => clock, wait: async (ms) => { clock += ms; }, launchWindowMs: 60_000, sleepMs: 10_000 };
  await assert.rejects(f.execute("lost", async ({ launching }) => {
    await launching({ ...LAUNCH, startedAt: new Date(clock).toISOString() });
    throw lostLaunch("Claude RemoteTrigger run timed out on this machine after 90 s");
  }, timed), /timed out/);
  const stuck = queueState(f.home).active;
  assert.deepEqual([stuck.key, stuck.phase, stuck.pid, stuck.identity], ["lost", "launching", null, null]);
  const waiting = { ...timed, timeoutMs: 30_000, recover: () => "unknown" };
  await assert.rejects(f.execute("next", () => assert.fail("admitted inside the launch window"), waiting), { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" });
  assert.equal(queueState(f.home).active.token, stuck.token, "inside the window the gone launcher's reservation still holds the account");
  clock += 60_000;
  assert.equal(await f.execute("next", () => "admitted", waiting), "admitted");
  assert.deepEqual(queueState(f.home).abandoned.at(-1), { key: "lost", reason: "launcher exited during launch; no provider run was proven" });
  // A recorded launcher pid whose start time no longer matches is gone the same way.
  writeAtomic(queueFile(f.home), { ...queueState(f.home), active: { ...stuck, token: "crashed", key: "crashed", pid: process.pid, identity: "an earlier process start" } });
  assert.equal(await f.execute("after-crash", () => "admitted", waiting), "admitted");
  assert.equal(queueState(f.home).abandoned.at(-1).key, "crashed");
  assert.equal(queueState(f.home).active, null);
});

test("ISS-14476 DT-153R a launching reservation whose launcher is alive is waited on however old its launch is", async (t) => {
  const f = fixture(t);
  let clock = 0;
  const timed = { now: () => clock, wait: async (ms) => { clock += ms; }, launchWindowMs: 60_000, sleepMs: 10_000 };
  let entered;
  let finish;
  const begun = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const live = f.execute("live", async ({ launching }) => {
    await launching({ ...LAUNCH, startedAt: new Date(clock).toISOString() });
    entered();
    await hold;
    return "live launcher finished";
  }, timed);
  await begun;
  clock += 10 * 60_000;
  let recovered = 0;
  const waiting = { ...timed, timeoutMs: 30_000, recover: () => { recovered++; return "unknown"; } };
  await assert.rejects(f.execute("next", () => assert.fail("a live launcher's reservation was reclaimed"), waiting), { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" });
  assert.equal(recovered, 0, "a live launcher is never reconciled");
  assert.equal(queueState(f.home).active.key, "live");
  finish();
  assert.equal(await live, "live launcher finished");
});

test("ISS-14476 DT-157R another request never marks a gone launcher's acknowledged run abandoned and holds the account at any age until the provider ends it", async (t) => {
  const f = fixture(t);
  let clock = 0;
  const timed = { now: () => clock, wait: async (ms) => { clock += ms; }, launchWindowMs: 60_000, sleepMs: 10_000, timeoutMs: 20_000 };
  const launch = { ...LAUNCH, startedAt: new Date(0).toISOString() };
  await assert.rejects(f.execute("lost", async ({ launching }) => {
    await launching(launch);
    await launching({ ...launch, runId: "run-lost", sessionId: "cse_lost" });
    throw Object.assign(new Error("routine ledger write failed"), { launchUncertain: true });
  }, timed), /ledger write failed/);
  const stuck = queueState(f.home).active;
  assert.deepEqual([stuck.launch.runId, stuck.launch.sessionId, stuck.pid], ["run-lost", "cse_lost", null]);
  clock += 60 * 60_000;
  let provider;
  const recover = (entry) => recoverValidationReservation(entry, { ledger: { runs: [] }, remote: () => provider() });
  for (const [name, answer] of [["reports it running", () => ({ data: [{ id: "run-lost", session_id: "cse_lost", status: "running" }] })],
    ["does not list it", () => ({ data: [] })], ["cannot be read", () => unreadableProvider("list_runs")]]) {
    provider = answer;
    await assert.rejects(f.execute("next", () => assert.fail(`admitted while the provider ${name}`), { ...timed, recover }), { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" }, name);
    assert.equal(queueState(f.home).active.token, stuck.token, `the gone launcher's reservation holds while the provider ${name}`);
    const receipt = regularJson(f.receipt("lost"));
    assert.deepEqual([receipt.status, receipt.runId, receipt.sessionId, receipt.requestDigest], ["running", "run-lost", "cse_lost", "lost"], `its receipt stays running while the provider ${name}`);
  }
  assert.deepEqual(queueState(f.home).abandoned, [], "an acknowledged run is never reclaimed");
  provider = () => ({ data: [{ id: "run-lost", session_id: "cse_lost", status: "completed" }] });
  assert.equal(await f.execute("next", () => "admitted", { ...timed, recover }), "admitted");
});

test("ISS-14476 DT-156R a gone launcher's unacknowledged launch holds at any age while the provider cannot be read, and is reclaimed past its window once every read proves nothing", async (t) => {
  const f = fixture(t);
  let clock = 0;
  const timed = { now: () => clock, wait: async (ms) => { clock += ms; }, launchWindowMs: 60_000, sleepMs: 10_000, timeoutMs: 20_000 };
  await assert.rejects(f.execute("lost", async ({ launching }) => {
    await launching({ ...LAUNCH, startedAt: new Date(0).toISOString() });
    throw lostLaunch("Claude RemoteTrigger run timed out on this machine after 90 s");
  }, timed), /timed out/);
  clock += 60 * 60_000;
  let readable = false;
  const recover = (entry) => recoverValidationReservation(entry, { ledger: { runs: [] }, remote: (action) => (readable ? markerlessProvider : unreadableProvider)(action) });
  await assert.rejects(f.execute("next", () => assert.fail("admitted while the provider could not be read"), { ...timed, recover }), { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" });
  await assert.rejects(f.execute("lost", () => assert.fail("the identical request launched again while the provider could not be read"), { ...timed, recover }), { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" });
  assert.deepEqual([queueState(f.home).active.key, queueState(f.home).abandoned], ["lost", []]);
  readable = true;
  assert.equal(await f.execute("next", () => "admitted", { ...timed, recover }), "admitted");
  assert.deepEqual(queueState(f.home).abandoned, [{ key: "lost", reason: "launcher exited during launch; no provider run was proven" }], "a reclaimed launch carries no run or session id");
  assert.equal(existsSync(f.receipt("lost")), false);
});

test("ISS-14476 DT-150R DT-151R the identical request adopts the run its gone launcher's reservation recorded, so the provider runs it once", async (t) => {
  for (const listedAtRecovery of [true, false]) {
    const f = adoptionFixture(t);
    let runs = 0;
    let lists = 0;
    let saved;
    const remote = (action) => {
      if (action === "create" || action === "update") return { trigger: { id: "standing", mcp_connections: [] } };
      if (action === "run") {
        runs++;
        // The provider accepted the run, then this launcher is lost: its routine ledger can no longer be written.
        saved = readFileSync(ledgerPath(f.home), "utf8");
        rmSync(ledgerPath(f.home));
        mkdirSync(path.join(ledgerPath(f.home), "blocked"), { recursive: true });
        return { run_id: "run-adopted", session_id: "cse_adopted" };
      }
      if (action === "list_runs") {
        lists++;
        if (lists === 1 && !listedAtRecovery) return { data: [] };
        return { data: [{ id: "run-adopted", session_id: "cse_adopted", ...(lists === 1 ? { status: "running" } : { status: "active", worker_status: "idle" }) }] };
      }
      if (action === "get_run_log") return { log: machineTestReport(f.request, [0]) };
      assert.fail(action);
    };
    await assert.rejects(validateCommit(f.request, { remote, home: f.home, executor: NO_EXECUTOR }), (error) => error.launchUncertain === true);
    const stuck = queueState(f.home).active;
    assert.deepEqual([stuck.phase, stuck.pid, stuck.launch.runId, stuck.launch.sessionId], ["launching", null, "run-adopted", "cse_adopted"],
      "the reservation holds the acknowledged run although the ledger write failed");
    rmSync(ledgerPath(f.home), { recursive: true });
    writeFileSync(ledgerPath(f.home), saved);
    // Without adoption this request would wait in the queue; the signal ends that wait as a failure.
    const result = await validateCommit(f.request, { remote, home: f.home, executor: NO_EXECUTOR, sleep: async () => {}, signal: AbortSignal.timeout(15_000) });
    assert.equal(result.passed, true);
    assert.equal(result.sessionId, "cse_adopted");
    assert.equal(runs, 1, "the provider ran the request once across both attempts");
    assert.ok(readLedger(f.home).runs.some((row) => row.runId === "run-adopted" && row.sessionId === "cse_adopted"), "adoption restores the ledger row");
    assert.equal(queueState(f.home).active, null);
  }
});

test("ISS-14476 DT-150R the identical request adopts an acknowledged run the provider does not list yet, inside the launch window", async (t) => {
  const f = fixture(t);
  let clock = 0;
  const timed = { now: () => clock, wait: async (ms) => { clock += ms; }, launchWindowMs: 60_000, sleepMs: 10_000, timeoutMs: 20_000 };
  const launch = { ...LAUNCH, startedAt: new Date(0).toISOString() };
  await assert.rejects(f.execute("same", async ({ launching }) => {
    await launching(launch);
    await launching({ ...launch, runId: "run-same", sessionId: "cse_same" });
    throw Object.assign(new Error("routine ledger write failed"), { launchUncertain: true });
  }, timed), /ledger write failed/);
  const recover = (entry) => recoverValidationReservation(entry, { ledger: { runs: [] }, remote: () => ({ data: [] }) });
  let launched = 0;
  const resumed = await f.execute("same", async ({ launching }) => {
    if (!existsSync(f.receipt("same"))) { launched++; await launching(launch); }
    return regularJson(f.receipt("same"));
  }, { ...timed, recover });
  assert.equal(launched, 0, "the adopted run is never launched again");
  assert.deepEqual([resumed.runId, resumed.sessionId, resumed.status, resumed.requestDigest], ["run-same", "cse_same", "running", "same"]);
  assert.equal(clock, 0, "adoption does not wait for the provider to list the run");
});

test("ISS-14476 DT-151R a RemoteTrigger run whose local claude times out after the provider's one HTTP 200 result returns that run", () => {
  const sent = { action: "run", trigger_id: "trig_018sJF4fkuDrC9wNx6jRP5fQ" };
  const json = JSON.stringify({ conversation_id: "", session_id: "cse_01H58iaevxqUroz3b7Nsha9m" });
  const use = { type: "assistant", message: { content: [{ type: "tool_use", name: "RemoteTrigger", id: "one", input: sent }] } };
  const answered = (content, extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "one", content }] }, ...extra });
  const timedOut = (events) => () => ({ status: null, signal: "SIGTERM", stderr: "", stdout: events.map((event) => JSON.stringify(event)).join("\n"),
    error: Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" }) });
  const run = (events) => remoteTrigger("run", { trigger_id: sent.trigger_id }, { run: timedOut(events) });
  assert.equal(run([use, answered(`HTTP 200\n${json}`)]).session_id, "cse_01H58iaevxqUroz3b7Nsha9m");
  const placeholder = "<persisted-output>\nOutput too large (57.5KB). Full output saved to: /nonexistent/toolu_one.txt\n\nPreview (first 2KB):\nHTTP 200\n" + json.slice(0, 40) + "\n</persisted-output>";
  assert.equal(run([use, answered(placeholder, { tool_use_result: { status: 200, json } })]).session_id, "cse_01H58iaevxqUroz3b7Nsha9m");
  assert.throws(() => run([use, answered(placeholder)]), { code: "CLOUD_RESULT_TOO_LARGE" }, "a preview alone is never read as the run");
  assert.throws(() => run([use]), { code: "CLOUD_CALL_TIMEOUT" }, "no tool result yet is still a timeout");
  assert.throws(() => run([]), { code: "CLOUD_CALL_TIMEOUT" });
  assert.throws(() => run([use, answered(`HTTP 200\n${json}`), answered(`HTTP 200\n${json}`)]), { code: "CLOUD_CALL_TIMEOUT" }, "two results are never one acknowledgement");
  assert.throws(() => run([use, answered('HTTP 500\n{"error":"overloaded"}')]), (error) => error.code !== "CLOUD_CALL_TIMEOUT" && /500|overloaded/.test(error.message));
  const echo = { ...use, message: { content: [{ ...use.message.content[0], input: { ...sent, trigger_id: "trig_other" } }] } };
  assert.throws(() => run([echo, answered(`HTTP 200\n${json}`)]), /unexpected action/);
  const again = { type: "assistant", message: { content: [{ type: "tool_use", name: "RemoteTrigger", id: "two", input: sent }] } };
  assert.equal(run([use, answered(`HTTP 200\n${json}`), again]).session_id, "cse_01H58iaevxqUroz3b7Nsha9m",
    "a second call still unanswered at the timeout is not an execution, as in an untimed call");
});

test("ISS-14476 DT-155R a timeout after one tool result stays CLOUD_CALL_TIMEOUT for every action but run, with its retries and the poll's resume hint", async () => {
  const oneResult = (input) => [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "RemoteTrigger", id: "one", input }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "one", content: 'HTTP 200\n{"data":[{"id":"run-x","status":"running"}]}' }] } },
  ].map((event) => JSON.stringify(event)).join("\n");
  const timedOut = (input, counted) => () => { counted.calls++; return { status: null, signal: "SIGTERM", stderr: "", stdout: oneResult(input),
    error: Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" }) }; };
  const payloads = [["list_runs", { trigger_id: "trig_x" }, 3], ["get_run_log", { session_id: "cse_x" }, 3], ["update", { trigger_id: "trig_x", body: {} }, 3],
    ["get", { trigger_id: "trig_x" }, 1], ["list", {}, 1]];
  for (const [action, payload, calls] of payloads) {
    const counted = { calls: 0 };
    assert.throws(() => remoteTrigger(action, payload, { run: timedOut({ action, ...payload }, counted), pause: () => {} }), { code: "CLOUD_CALL_TIMEOUT" }, action);
    assert.equal(counted.calls, calls, `${action} is called ${calls} time(s)`);
  }
  const counted = { calls: 0 };
  const remote = (action, payload) => remoteTrigger(action, payload, { run: timedOut({ action, ...payload }, counted), pause: () => {} });
  await assert.rejects(pollTask({ provider: "claude", routineId: "trig_x", runId: "run-x", startedAt: new Date().toISOString() }, { repository: "closedloop-ai/claude-plugins" },
    { remote, sleep: async () => {} }), { code: "CLOUD_POLL_TIMEOUT", message: /run run-x may still be running in the cloud\. To resume, run the same cloud-worker\.mjs command/ });
  assert.equal(counted.calls, 3);
});

/** The validation receipt `validate` and `abandon` read for this request: in the checkout's Git directory, named by commit and request key. */
const gitDirReceipt = (request, key) => path.join(request.worktree, ".git", `cloud-validate-${request.commit.slice(0, 12)}-${key.slice(0, 12)}.json`);
/** A file path with its directory resolved, so a temporary directory's symlinked and real forms compare equal. */
const resolved = (file) => path.join(realpathSync(path.dirname(file)), path.basename(file));

test("ISS-14476 DT-152R DT-159R abandon releases the queue reservation of a request whose launch wrote no receipt, by its request key, and writes no receipt", async (t) => {
  const f = adoptionFixture(t);
  const key = sha256(JSON.stringify(f.request));
  const receipt = gitDirReceipt(f.request, key);
  const admit = (action) => withCloudValidationAdmission({ home: f.home, account: "verified-fixture-account", key, receipt,
    timeoutMs: 3000, sleepMs: 5, recover: () => "unknown", report: () => {} }, action);
  await assert.rejects(admit(async ({ launching }) => {
    await launching({ ...LAUNCH, startedAt: new Date().toISOString() });
    throw lostLaunch("Claude RemoteTrigger run timed out on this machine after 90 s");
  }), /timed out/);
  const stuck = queueState(f.home).active;
  const asked = await abandonValidation(f.request, { home: f.home });
  assert.equal(asked.confirmRequired, true);
  assert.deepEqual([asked.wouldChange.active.token, asked.wouldChange.active.key, asked.wouldChange.active.phase, asked.wouldChange.releases], [stuck.token, key, "launching", stuck.token]);
  assert.equal(queueState(f.home).active.token, stuck.token, "without --confirm nothing changes");
  const done = await abandonValidation(f.request, { confirm: true, home: f.home });
  assert.deepEqual([done.status, done.released.token, done.active], ["abandoned", stuck.token, null]);
  assert.equal(existsSync(receipt), false, "abandon of a launch no provider run acknowledged writes no receipt, so the request can launch again");
  assert.equal(queueState(f.home).active, null);
  assert.deepEqual(queueState(f.home).abandoned.at(-1), { key, reason: "abandoned locally; its launch wrote no receipt" });
  await assert.rejects(abandonValidation(f.request, { confirm: true, home: f.home }), /no cloud task exists to poll and no queue reservation holds this request/);
  // A launcher that is still alive keeps its reservation.
  writeAtomic(queueFile(f.home), { ...queueState(f.home), active: { ...stuck, pid: process.pid, identity: readProcessIdentity(process.pid) } });
  await assert.rejects(abandonValidation(f.request, { confirm: true, home: f.home }), /still holds this reservation/);
  assert.equal(queueState(f.home).active.token, stuck.token);
  // The path checked above is the receipt abandon reads: once it exists, abandon takes the receipt path.
  writeAtomic(receipt, { status: "running", requestDigest: key });
  assert.equal(resolved((await abandonValidation(f.request, { home: f.home })).wouldChange.receipt), resolved(receipt));
});

test("ISS-14476 DT-158R abandon of a receipt-less reservation that recorded an acknowledged run abandons that run as a receipt is and holds the account until the provider ends it", async (t) => {
  const f = adoptionFixture(t);
  const key = sha256(JSON.stringify(f.request));
  const receipt = gitDirReceipt(f.request, key);
  const launch = { ...LAUNCH, startedAt: new Date().toISOString() };
  await assert.rejects(withCloudValidationAdmission({ home: f.home, account: "verified-fixture-account", key, receipt, metadata: { commit: f.request.commit, laneKeys: ["unit-1"] },
    timeoutMs: 3000, sleepMs: 5, recover: () => "unknown", report: () => {} }, async ({ launching }) => {
    await launching(launch);
    await launching({ ...launch, runId: "run-acknowledged", sessionId: "cse_acknowledged" });
    throw Object.assign(new Error("routine ledger write failed"), { launchUncertain: true });
  }), /ledger write failed/);
  const stuck = queueState(f.home).active;
  // The routine ledger row the launch wrote before its reservation could not be finished.
  writeAtomic(ledgerPath(f.home), { ...readLedger(f.home), runs: [{ runId: "run-acknowledged", sessionId: "cse_acknowledged", routineId: "standing", requestKey: key, status: "started" }] });
  const asked = await abandonValidation(f.request, { home: f.home });
  assert.deepEqual([asked.confirmRequired, asked.wouldChange.abandonsRun, resolved(asked.wouldChange.receipt)], [true, "run-acknowledged", resolved(receipt)]);
  assert.equal(existsSync(receipt), false, "without --confirm nothing changes");
  const done = await abandonValidation(f.request, { confirm: true, home: f.home });
  assert.deepEqual([done.status, done.holdsUntilProviderEnds.token, done.active.token], ["abandoned", stuck.token, stuck.token]);
  const written = regularJson(receipt);
  assert.deepEqual([written.status, written.provider, written.runId, written.taskId, written.sessionId, written.routineId, written.requestDigest, written.laneKeys],
    ["abandoned", "claude", "run-acknowledged", "run-acknowledged", "cse_acknowledged", "standing", key, ["unit-1"]]);
  assert.equal(readLedger(f.home).runs[0].status, "abandoned", "the routine ledger marks the run abandoned, as the receipt path does");
  assert.deepEqual([queueState(f.home).active.token, queueState(f.home).abandoned], [stuck.token, []], "the reservation still holds the account");
  let status = "running";
  const next = (action) => withCloudValidationAdmission({ home: f.home, account: "verified-fixture-account", key: "next", receipt: path.join(f.root, "next.json"), timeoutMs: 200, sleepMs: 5,
    recover: (entry) => recoverValidationReservation(entry, { ledger: { runs: [] }, remote: () => ({ data: [{ id: "run-acknowledged", status }] }) }), report: () => {} }, action);
  await assert.rejects(next(() => assert.fail("admitted while the provider still ran the abandoned run")), { code: "CLOUD_VALIDATION_QUEUE_TIMEOUT" });
  status = "completed";
  assert.equal(await next(() => "admitted"), "admitted");
});
