import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { recordEnvironmentPin, readLedger, runOnStanding } from "./cloud-routines.mjs";
import { executeCloudValidation, measuredSetupTools, recordRuntimeFromValidation } from "./cloud-validation-environment.mjs";
import { CLOUD_CAPABILITIES_COMMAND } from "./cloud-check-command.mjs";
import { remoteTrigger } from "./cloud-worker.mjs";
import { regularJson, writeAtomic } from "./owned-state.mjs";

const accountUuid="a0a01111-1111-4111-a111-111111111111", environmentId="env_01Fixture";
const pin={accountUuid,environmentId}, commit="a".repeat(40), env={id:environmentId};
const lane={name:"cloud-capabilities",command:CLOUD_CAPABILITIES_COMMAND,capabilityProbe:true};
const checks={workspace:true,nonRoot:true,ports:true,chromium:true,gitUtc:true,node24:true};

function runtime(t) {
  const f=makeHome("vibe-probe-reservation-");
  t.after(f.cleanup);
  const file=path.join(f.root,"receipt.json");
  const result={commit,lanes:[{name:lane.name,exitCode:0,stdoutTail:"CLOUD_HOST_RUNTIME "+JSON.stringify({commit,checks})}]};
  const ledger=()=>readLedger(f.home);
  const run=overrides=>executeCloudValidation({file,digest:"fixture-digest",request:{commit,branch:"main"},lanes:[lane],env,laneKeys:["probe"],home:f.home,ledger,
    currentAccount:()=>accountUuid,timeoutMs:3000,signal:AbortSignal.timeout(3000),mark:()=>{},poll:r=>({...r,status:"completed"}),
    parse:()=>result,onReport:(report,finished)=>recordRuntimeFromValidation({lanes:[lane],ledger,currentAccount:()=>accountUuid,home:f.home,branch:"main"},report,finished),
    ...overrides});
  return {...f,file,result,run,ledger};
}

for(const variant of ["nonzero CLI","trailing frame"]) test("uncertain provider acknowledgement remains owned through "+variant,async t=>{
  const f=runtime(t); await recordEnvironmentPin({home:f.home,...pin});
  let marker,starts=0;
  const remote=(action,payload)=>{
    if(action==="create" || action==="update") {
      if(action==="update") marker=/VIBE_VALIDATION_LAUNCH ([\w-]+)/.exec(payload.body.job_config.ccr.events[0].data.message.content)[1];
      return {trigger:{id:"standing",mcp_connections:[]}};
    }
    if(action==="run") {
      starts++;
      const stdout=[{message:{content:[{type:"tool_use",name:"RemoteTrigger",id:"one",input:{action,...payload}}]}},
        {message:{content:[{type:"tool_result",tool_use_id:"one",content:'HTTP 200\n{"run_id":"run","session_id":"session"}'}]}}].map(v=>JSON.stringify(v)).join("\n");
      return remoteTrigger(action,payload,{run:()=>({status:variant==="nonzero CLI"?1:0,stderr:"",stdout:stdout+(variant==="trailing frame"?"\n{":"")})});
    }
    if(action==="list_runs") return {data:[{id:"run",session_id:"session",status:"completed"}]};
    if(action==="get_run_log") return {log:"[t] assistant: VIBE_VALIDATION_LAUNCH "+marker};
    assert.fail(action);
  };
  const start=async beforeRun=>{
    const r=await runOnStanding({remote,home:f.home,environment:env,ccr:{},brief:"Validation only.\nCheck",account:()=>accountUuid,
      requestKey:"fixture-digest",beforeRun,waitMs:1500});
    return {...r,startedAt:new Date().toISOString(),environment:env,taskId:r.runId};
  };
  try {await f.run({start,remote});} catch(error){assert.match(error.message,/captured JSON|failed|frame|incomplete/);}
  await f.run({start,remote});
  assert.equal(starts,1);
  assert.equal(f.ledger().runs.filter(r=>r.accountUuid===accountUuid && r.environmentId===environmentId && r.runId==="run").length,1);
  assert.equal(measuredSetupTools(f.home,pin,accountUuid,environmentId)?.node24,true);
});

test("expired completed capability request runs afresh while an in-flight receipt resumes",async t=>{
  const f=runtime(t);
  await recordEnvironmentPin({home:f.home,...pin});
  const old={accountUuid,requestDigest:"fixture-digest",commit,environment:env,status:"completed",runId:"old",taskId:"old",
    startedAt:new Date(Date.now()-31*60_000).toISOString(),validationReport:f.result};
  writeAtomic(f.file,old);
  let starts=0;
  const start=async()=>({status:"running",startedAt:new Date().toISOString(),taskId:"fresh",runId:"fresh",environment:env});
  const go=()=>f.run({start:async()=>{starts++;return start();},remote:()=>assert.fail("unexpected lookup"),onReport:()=>{}});
  await go();
  assert.equal(starts,1);assert.equal(regularJson(f.file).runId,"fresh");
  writeAtomic(f.file,{...old,status:"running",validationReport:undefined});
  await go(); assert.equal(starts,1);
});

test("completed probe receipts stay with their launch account and environment",async t=>{
  const f=runtime(t);
  let starts=0;
  const run=async (account,environment)=>{
    await recordEnvironmentPin({home:f.home,accountUuid:account,environmentId:environment});
    return f.run({env:{id:environment},currentAccount:()=>account,
      start:async()=>({taskId:String(++starts),runId:String(starts),environment:{id:environment},startedAt:new Date().toISOString(),status:"running"}),
      onReport:()=>{},remote:()=>assert.fail("unexpected provider lookup")});
  };
  assert.equal((await run(accountUuid,environmentId)).taskId,"1");
  assert.equal((await run(accountUuid,"env_02Fixture")).taskId,"2");
  assert.equal((await run("b0b02222-2222-4222-b222-222222222222","env_02Fixture")).taskId,"3");
  assert.equal((await run(accountUuid,environmentId)).taskId,"1");
});

for (const recovery of ["ledger","nonce"]) test("accepted provider dispatch survives the first receipt write failing via "+recovery,async t=>{
  const {default:fs}=await import("node:fs"),{syncBuiltinESMExports}=await import("node:module");
  const f=runtime(t),launch={routineId:"standing",launchToken:"token",startedAt:new Date().toISOString()};
  let starts=0,fail=true;
  const rename=fs.renameSync;
  const mock=t.mock.method(fs,"renameSync",(tmp,to)=>{
    if(to===f.file && fail){fail=false;throw Object.assign(new Error("disk full"),{code:"ENOSPC"});}
    return rename(tmp,to);
  });syncBuiltinESMExports();
  let supplyStreams=false;
  const {privateStreamEvidence}=await import("./cloud-validation-report.mjs");
  const run=()=>f.run({lanes:[{name:"version",command:"node --version"}],
    ledger:()=>({...f.ledger(),runs:recovery==="ledger" && starts ? [{...launch,requestKey:"fixture-digest",runId:"owned",sessionId:"session"}] : []}),
    parse:finished=>{
      const channels=Object.fromEntries(["stdout","stderr"].map(channel=>[channel,{file:"/tmp/vibe-lane-results-example/0."+channel,bytes:0,sha256:"0".repeat(64)}]));
      return {...f.result,...privateStreamEvidence(supplyStreams ? channels : undefined,0,finished.managedHost)};
    },
    start:async before=>{await before(launch,{managedHost:true});starts++;return {...launch,taskId:"owned",runId:"owned",sessionId:"session",status:"running"};},
    remote:(action)=>action==="list_runs"?{data:[{id:"owned",session_id:"session",status:"running"}]}:{log:"VIBE_VALIDATION_LAUNCH token"},onReport:()=>{}});
  try {
    await assert.rejects(run(),/disk full/);
    await assert.rejects(run(),/invalid private stream receipt/);
    supplyStreams=true;
    const recovered=await run();
    assert.equal(recovered.taskId,"owned");
    assert.equal(recovered.privateStreams.stdout.bytes,0);
    assert.equal(starts,1);
  }
  finally{mock.mock.restore();syncBuiltinESMExports();}
});

test("two unpinned environments share one account reservation",async t=>{
  const f=runtime(t);let active=0,peak=0;
  const run=index=>f.run({lanes:[{name:"version",command:"node --version"}],digest:"key"+index,file:f.file+index,env:{id:"env_"+index},
    start:async()=>{peak=Math.max(peak,++active);return {status:"running",taskId:String(index)};},
    poll:async row=>{await new Promise(res=>setTimeout(res,40));active--;return {...row,status:"completed"};},onReport:()=>{}});
  await Promise.all([run(1),run(2)]);assert.equal(peak,1);
});

test("first account pin waits for already-dispatched unbound validation",async t=>{
  const f=runtime(t);
  let announce;
  const entered=new Promise(resolve=>{announce=resolve;});
  let running=false,overlap=false;
  const submit=(key)=>f.run({lanes:[{name:"version",command:"node --version"}],digest:key,file:f.file+key,
    start:async()=>{if(running)overlap=true;running=true;announce();return {taskId:key,status:"running"};},
    poll:async row=>{await new Promise(done=>setTimeout(done,300));running=false;return {...row,status:"completed"};},onReport:()=>{}});
  const first=submit("before");
  await entered;
  await recordEnvironmentPin({home:f.home,...pin});
  await Promise.all([first,submit("after")]);
  assert.equal(overlap,false);
});
