import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeHome, makeCheckout, git } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { validationReportInstruction } from "./cloud-validation-report.mjs";
import { NO_EXECUTOR } from "./cloud-routines.mjs";
import { parseValidationResult, validateCommit } from "./cloud-worker.mjs";

const REPOSITORY = "closedloop-ai/claude-plugins";
const SHA = "a".repeat(40);
const SPECS = Array.from({ length: 11 }, (_, index) => ({ name: `lane-${index + 1}`, command: `node --test selection-${index + 1}.test.mjs` }));
const EVIDENCE = "line with a multibyte boundary 🧪\n    stdout content\t".repeat(35);
const outcomes = SPECS.map(({ name }, index) => ({
  name,
  exitCode: index === 6 ? null : index % 2,
  ...(index === 6 ? { notRun: "cloud capacity did not admit the last lane" } : {}),
  stdoutTail: EVIDENCE + name,
  stderrTail: index % 2 ? "command failed\n" + EVIDENCE : "",
  diagnosis: "fixture diagnosis ".repeat(25),
}));

const request = (commit = SHA, worktree = "/fixture") => ({
  worktree, provider: "claude", model: "claude-sonnet-5-5", claudeEnvironment: "env_01Fixture", pollMs: 1000,
  repository: REPOSITORY, branch: "main", commit, lanes: SPECS,
});

/** Build an independently generated service transcript, including messages delivered out of order. */
function transcript(req, records = outcomes, { status = [], count = SPECS.length } = {}) {
  const parts = records.flatMap((lane, index) => {
    const data = Buffer.from(JSON.stringify(lane));
    const parts = Math.ceil(data.length / 700);
    return Array.from({ length: parts }, (_, part) => ({ commit: req.commit, index, part, parts,
      data: data.subarray(part * 700, (part + 1) * 700).toString("base64") }));
  });
  const summary = { commit: req.commit, provenance: { host: "vm", remote: "true", origin: `https://github.com/${REPOSITORY}`,
    commit: req.commit }, laneCount: count, status };
  return { parts, summary };
}

function log({ parts, summary }) {
  return [
    ...parts.map((record) => `[2026-11-19T21:30:00Z] assistant: VIBE_VALIDATION_LANE ${JSON.stringify(record)}`),
    `[2026-11-19T21:30:01Z] assistant: VIBE_VALIDATION_RESULT ${JSON.stringify(summary)}`,
  ].join("\n");
}

test("ISS-14476 imports all eleven lane outcomes and multibyte evidence beyond the aggregate message limit", () => {
  const req = request();
  const brief = validationReportInstruction();
  assert.match(brief, /VIBE_VALIDATION_LANE.*"index".*"part".*"parts".*"data"/);
  const bytes = Number(/chunks of at most (\d+)/.exec(brief)[1]);
  const entry = {commit:req.commit,index:1000,part:1000,parts:1001,data:Buffer.alloc(bytes).toString("base64")};
  assert.ok(("VIBE_VALIDATION_LANE " + JSON.stringify(entry)).length < 400);
  const records = transcript(req);
  const old = "VIBE_VALIDATION_RESULT " + JSON.stringify({ ...records.summary, laneCount: undefined, lanes: outcomes });
  assert.ok(old.length > 2_000, old.length);
  assert.throws(() => parseValidationResult(old.slice(0, 2_000) + "… [+" + (old.length - 2_000) + " chars]", req), /cut off/);
  records.parts.reverse();
  const text = log(records);
  assert.ok(text.split("\n").every((line) => line.length < 1_800));
  const result = parseValidationResult(text, req);
  assert.equal(result.passed, false);
  assert.deepEqual(result.lanes, outcomes.map((lane, index) => ({ ...lane, command: SPECS[index].command, passed: lane.exitCode === 0 })));
});

test("ISS-14476 refuses missing, partial, duplicate, wrong-identity and wrong-order evidence", () => {
  const req = request();
  const records = transcript(req);
  const part = records.parts[0];
  assert.throws(() => parseValidationResult(log({ ...records, parts: records.parts.filter(({ index }) => index !== 2) }), req), /lane 3 is missing/);
  assert.throws(() => parseValidationResult(log({ ...records, parts: records.parts.slice(1) }), req), /lane 1 is missing or incomplete/);
  assert.throws(() => parseValidationResult(log({ ...records, parts: [...records.parts, part] }), req), /duplicate/);
  assert.throws(() => parseValidationResult(log({ ...records, parts: [{ ...part, commit: "b".repeat(40) }, ...records.parts.slice(1)] }), req), /another commit/);
  assert.throws(() => parseValidationResult(log(transcript(req, [outcomes[1], outcomes[0], ...outcomes.slice(2)])), req), /lane-2 where lane-1/);
  assert.throws(() => parseValidationResult(log(transcript(req, outcomes, { status: [" M tracked.file"] })), req), /changed files/);
  const incomplete = [{ ...outcomes[0], exitCode: null }, ...outcomes.slice(1)];
  assert.throws(() => parseValidationResult(log(transcript(req, incomplete)), req), /incomplete outcome evidence/);
});

test("ISS-14476 a partial report retries import and caches the complete result without creating or running twice", async (t) => {
  const fixture = makeHome("vibe-cloud-lane-report-");
  t.after(fixture.cleanup);
  const worktree = path.join(fixture.root, "checkout");
  makeCheckout({ ...fixture, checkout: worktree, remoteUrl: `https://github.com/${REPOSITORY}.git` });
  const req = {...request(git(worktree, ["rev-parse", "HEAD"], fixture.home), worktree),
    resultArtifact:{path:"eval/result.json",branch:"vibe-eval-results/fixture"}};
  const artifact={...req.resultArtifact,commit:"b".repeat(40),sha256:"c".repeat(64)};
  const complete = transcript(req);
  complete.summary.artifact=artifact;
  let report = log({ ...complete, parts: complete.parts.slice(1) });
  const calls = [];
  const remote = (action) => {
    calls.push(action);
    if (action === "create" || action === "update") return { trigger: { id: "standing-report", mcp_connections: [] } };
    if (action === "run") return { run_id: "run-report", session_id: "session-report" };
    if (action === "list_runs") return { data: [{ id: "run-report", status: "active", worker_status: "idle", session_id: "session-report" }] };
    if (action === "get_run_log") return { log: report };
    assert.fail("unexpected cloud action " + action);
  };
  const validate = () => validateCommit(req, { remote, artifactReader:(_,identity)=>({...identity,result:{completed:true}}), executor: NO_EXECUTOR, sleep: async () => {}, home: fixture.home });
  const first = validate();
  await assert.rejects(validate, /CLOUD_VALIDATION_BUSY/);
  await assert.rejects(first, /lane 1 is missing or incomplete/);
  report = log(complete);
  const result = await validate();
  const receipt = JSON.parse(readFileSync(result.receipt, "utf8"));
  assert.equal(receipt.validationReport.lanes[6].stdoutTail, outcomes[6].stdoutTail);
  report = "the cloud log is no longer available";
  const count = calls.length;
  assert.deepEqual(await validate(), result);
  assert.equal(calls.length, count);
  assert.deepEqual(calls.filter((action) => ["create", "update", "run"].includes(action)), ["create", "update", "run"]);
});

test("private stream receipts bind both channels to this lane without including full output",()=>{
  const req=request(), base="/tmp/vibe-lane-results-ABC123/";
  const streams=index=>Object.fromEntries(["stdout","stderr"].map(channel=>[channel,{file:base+index+"."+channel,bytes:10240,sha256:"a".repeat(64)}]));
  const rows=outcomes.map((r,index)=>({...r,privateStreams:streams(index)}));
  const result=parseValidationResult(log(transcript(req,rows)),req,{managedHost:true});
  assert.deepEqual(result.lanes[0].privateStreams,streams(0));
  rows[0].privateStreams=streams(1);
  assert.throws(()=>parseValidationResult(log(transcript(req,rows)),req,{managedHost:true}),/private stream receipt/);
});

test("managed stream exemption requires an actual failed browser preflight",()=>{
  for(const [command,exitCode,diagnosis,accepted] of [
    ["node --test suite.test.mjs",0,"Chromium preflight failed",false],
    ["node --test suite.test.mjs",1,"Chromium preflight failed",false],
    ["pnpm test:storybook",1,"Chromium preflight failed: extra",false],
    ["pnpm test:storybook",1,"Chromium preflight failed",true],
  ]){
    const req={...request(),lanes:[{name:"measure",command}]};
    const row={name:"measure",exitCode,diagnosis,stdoutTail:"",stderrTail:"failed"};
    const read=()=>parseValidationResult(log(transcript(req,[row],{count:1})),req,{managedHost:true});
    if(accepted) assert.equal(read().passed,false);
    else assert.throws(read,/private stream receipt/);
  }
});

test("one managed host invocation owns all lane stream files",()=>{
  const req={...request(),lanes:SPECS.slice(0,2)};
  const read=roots=>parseValidationResult(log(transcript(req,req.lanes.map(({name},index)=>({name,exitCode:0,privateStreams:Object.fromEntries(["stdout","stderr"].map(channel=>[channel,{file:"/tmp/vibe-lane-results-"+roots[index]+"/"+index+"."+channel,bytes:0,sha256:"a".repeat(64)}]))})),{count:2})),req,{managedHost:true});
  assert.equal(read(["AAA111","AAA111"]).passed,true);
  assert.throws(()=>read(["AAA111","BBB222"]),/private stream/);
});
