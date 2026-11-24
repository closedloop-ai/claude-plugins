import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { git, makeCheckout, makeHome } from "../../../skills/vibe/scripts/test-fixtures.mjs";
import { validationBrief, validationLanes } from "./cloud-worker.mjs";
import { workflowLaneDefinitions } from "./workflow-lane-definitions.mjs";

const tools="plugins/vibe/lib/vibe/scripts";
const keys=["cloud-workflow-plan","workflow-lane-definitions","cloud-receipts","captured-json","github-remote","cloud-outcome-artifact","cloud-outcome-writer"];
const checksum=value=>createHash("sha256").update(value).digest("hex");
const workflowPath=".github/workflows/ci.yml";
const root=fileURLToPath(new URL("../../../../../",import.meta.url));

test("large committed workflow briefs reconstruct every selected recipe and pin the machine reporter",t=>{
  const f=makeHome("compact-workflow-");t.after(f.cleanup);
  const workflow=readFileSync(path.join(root,workflowPath),"utf8");
  const names=workflowLaneDefinitions(workflow).map(row=>row.name);
  assert.ok(names.length>=13);
  const files={[workflowPath]:workflow};
  for (const key of keys) {
    const file=tools+"/"+key+".mjs";
    files[file]=readFileSync(path.join(root,file),"utf8");
  }
  const worktree=path.join(f.root,"checkout");
  const repository="example/widgets";
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/"+repository+".git",files});
  const commit=git(worktree,["rev-parse","HEAD"],f.home);
  const request={provider:"claude",repository,commit,worktree,branch:"main",model:"fixture-model",lanes:names.map(name=>({name})),
    resultArtifact:{kind:"validation-outcomes",branch:"vibe-validation-results/compact",path:".vibe-validation-outcomes-12345678.json"},
    laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}};
  const brief=validationBrief(request);
  t.diagnostic("Complete workflow brief bytes "+Buffer.byteLength(brief));
  assert.ok(Buffer.byteLength(brief)<10000, "entire 13-job request must avoid the repeated oversized update");
  const command=brief.split("\n").find(line=>line.startsWith("node -e "));
  assert.ok(command);
  const run=()=>execFileSync("bash",["-ec",command],{cwd:worktree,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const dir=run();
  assert.equal(path.dirname(dir),path.join(worktree,".git"));
  const expected=validationLanes(request).lanes;
  const spec=JSON.parse(Buffer.from(readFileSync(path.join(dir,"reporter-spec"),"utf8"),"base64url"));
  assert.deepEqual(spec.names,expected.map(row=>row.name));
  assert.equal(spec.key,checksum(JSON.stringify(request)));
  for(const [i,row] of expected.entries())assert.equal(readFileSync(path.join(dir,"lane-"+i+".json"),"utf8"),row.command);
  assert.equal(readFileSync(path.join(dir,"cloud-outcome-writer.mjs"),"utf8"),files[tools+"/cloud-outcome-writer.mjs"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir,"lanes.json"),"utf8")),names);
  assert.ok(expected.every(row=>!brief.includes(row.command)));
  assert.doesNotMatch(brief,/brotliDecompressSync/);
  const split=command.lastIndexOf(" "), original=JSON.parse(Buffer.from(command.slice(split+1),"base64url"));
  for (const adjust of [p=>p.plan.source.sha256="0".repeat(64),p=>p.plan.selectionKey="0".repeat(64),
    p=>p.plan.reporter.names.reverse(),p=>p.toolsKey="0".repeat(64)]){
    const payload=structuredClone(original); adjust(payload);
    const modified=command.slice(0,split+1)+Buffer.from(JSON.stringify(payload)).toString("base64url");
    assert.throws(()=>execFileSync("bash",["-ec",modified],{cwd:worktree,stdio:"pipe"}),/differs/);
  }
  assert.equal(git(worktree,["status","--porcelain"],f.home),"");
  writeFileSync(path.join(worktree,workflowPath),workflow+"\n# local divergence\n");
  const second=run();
  assert.equal(readFileSync(path.join(second,"lane-0.json"),"utf8"),expected[0].command);
});
