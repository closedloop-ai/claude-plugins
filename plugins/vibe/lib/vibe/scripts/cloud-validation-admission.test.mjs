import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { capturedJson } from "./captured-json.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { recoverValidationReservation, withCloudValidationAdmission } from "./cloud-validation-admission.mjs";
import { NO_EXECUTOR } from "./cloud-routines.mjs";
import {machineTestReport} from "./cloud-outcome-test-fixture.mjs";
import { remoteTrigger, validateCommit } from "./cloud-worker.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

function fixture(t) {
  const f = makeHome("vibe-cloud-validation-admission-");
  t.after(f.cleanup);
  const receipt = (key) => path.join(f.root, `${key}.json`);
  const lines = [];
  const execute = (key, action, options = {}) => withCloudValidationAdmission({
    home: f.home, account: "verified-fixture-account", key, receipt: receipt(key), timeoutMs: 3000, sleepMs: 5,
    identityOf: () => "mock-process-start", recover: () => "terminal", report: (line) => lines.push(line), ...options,
  }, action);
  return { receipt, lines, execute };
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
