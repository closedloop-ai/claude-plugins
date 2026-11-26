import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { fakeDpkg, git, makeCheckout, makeHome, privateSudoers } from "../../../skills/vibe/scripts/test-fixtures.mjs";
import { validateCommit, validationBrief, validationLanes } from "./cloud-worker.mjs";
import { workflowLaneDefinitions } from "./workflow-lane-definitions.mjs";
import { reporterFiles } from "./cloud-outcome-instruction.mjs";
import { compactWorkflowBrief, WORKFLOW_BRIEF_UNAVAILABLE } from "./cloud-workflow-brief.mjs";
import { decodeOutcomes, outcomeRecords } from "./cloud-outcome-artifact.mjs";

const tools="plugins/vibe/lib/vibe/scripts";
const fixtureFiles=["cloud-workflow-plan.mjs","workflow-lane-definitions.mjs","cloud-receipts.mjs","cloud-validation-host.mjs","cloud-workflow-runner.mjs",...reporterFiles];
const checksum=value=>createHash("sha256").update(value).digest("hex");
const workflowPath=".github/workflows/ci.yml";
// The refusal's route to the managed pnpm lanes, as a pattern (team-lead ruling (b), 2026-11-25).
const managedRoute="validate this commit through its managed pnpm lanes instead: lanes \\[\\{name, command\\}\\] whose command is a pnpm script, with no workflow file";
const root=fileURLToPath(new URL("../../../../../",import.meta.url));
// The bootstrap's plan step runs the host's package repair, which runs dpkg as root: every bootstrap here runs with
// dpkg and dpkg-query stubbed first on its PATH, so a root test run never configures a real package.
const stubbed=dpkg=>({...process.env,PATH:dpkg.bin+path.delimiter+process.env.PATH});
// A private results directory where the shipped reporter reads one: directly under the real temporary directory.
const resultsDirectory=t=>{const d=mkdtempSync(path.join(realpathSync(tmpdir()),"vibe-lane-results-"));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
// A lane as the agent runs it, into the results directory `d`; as root, with a private /etc/sudoers.d for the runner's real grant.
const runLane=(dir,cwd,d)=>spawnSync(...privateSudoers(process.execPath,[path.join(dir,"cloud-workflow-runner.mjs"),"0",d]),{cwd,encoding:"utf8"});
// The brief's own lane command, run by bash exactly as written with the index filled in and both streams redirected into $d.
const briefLane=(brief,index,env,cwd)=>{
  const command=/with exactly `([^`]+)`/.exec(brief)?.[1];
  assert.ok(command,"the brief names its lane command");
  return spawnSync(...privateSudoers("bash",["-c",`${command.replace("<index>",String(index))} >"$d/${index}.stdout" 2>"$d/${index}.stderr"`]),{cwd,env,encoding:"utf8"});
};

test("large committed workflow briefs reconstruct every selected recipe and pin the machine reporter",t=>{
  const f=makeHome("compact-workflow-");t.after(f.cleanup);
  const matrixTool = "${{ matrix.tool }}";
  const workflow=readFileSync(path.join(root,workflowPath),"utf8")+`
  material-fields:
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    env:
      CHECK: ${matrixTool}
    strategy:
      matrix:
        include:
          - tool: widget
    defaults:
      run:
        working-directory: tools/${matrixTool}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: npm ci
      - run: npm test
        if: success()
        env:
          MODE: strict
        working-directory: tests/${matrixTool}
`;
  const names=workflowLaneDefinitions(workflow).map(row=>row.name);
  assert.ok(names.length>=13);
  const files={[workflowPath]:workflow};
  for (const name of fixtureFiles) {
    const file=tools+"/"+name;
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
  const env=stubbed(fakeDpkg(f.root));
  const run=()=>execFileSync("bash",["-ec",command],{cwd:worktree,env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const dir=run();
  assert.equal(path.dirname(dir),path.join(worktree,".git"));
  const expected=validationLanes(request).lanes;
  const spec=JSON.parse(Buffer.from(readFileSync(path.join(dir,"reporter-spec"),"utf8"),"base64url"));
  assert.deepEqual(spec.names,expected.map(row=>row.name));
  assert.equal(spec.key,checksum(JSON.stringify(request)));
  for(const [i,row] of expected.entries())assert.equal(readFileSync(path.join(dir,"lane-"+i+".json"),"utf8"),row.command);
  const fixtureIndex=names.indexOf('material-fields[{"tool":"widget"}]');
  assert.ok(fixtureIndex>=0);
  const recipe=JSON.parse(readFileSync(path.join(dir,"lane-"+fixtureIndex+".json"),"utf8"));
  assert.deepEqual(recipe.matrix,{tool:"widget"});
  assert.deepEqual(recipe.job,{
    "runs-on":"ubuntu-latest", if:"github.event_name == 'push'", env:{CHECK:"widget"},
    strategy:{matrix:{include:[{tool:"widget"}]}},
    defaults:{run:{"working-directory":"tools/widget"}},
    steps:[
      {uses:"actions/checkout@v4",with:{"fetch-depth":0}},
      {run:"npm ci"},
      {run:"npm test",if:"success()",env:{MODE:"strict"},"working-directory":"tests/widget"},
    ],
  });
  assert.equal(readFileSync(path.join(dir,"cloud-outcome-writer.mjs"),"utf8"),files[tools+"/cloud-outcome-writer.mjs"]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir,"lanes.json"),"utf8")),names);
  assert.ok(expected.every(row=>!brief.includes(row.command)));
  assert.doesNotMatch(brief,/brotliDecompressSync/);
  const split=command.lastIndexOf(" "), original=JSON.parse(Buffer.from(command.slice(split+1),"base64url"));
  const refusals=[
    [p=>p.plan.source.sha256="0".repeat(64),"committed workflow SHA-256 differs"],
    [p=>p.plan.selectionKey="0".repeat(64),"workflow selection or command key differs"],
    [p=>p.plan.reporter.names.reverse(),"workflow selection or command key differs"],
    [p=>p.toolsKey="0".repeat(64),"workflow or reporter tools differ"],
  ];
  for (const [adjust,reason] of refusals){
    const payload=structuredClone(original); adjust(payload);
    const modified=command.slice(0,split+1)+Buffer.from(JSON.stringify(payload)).toString("base64url");
    const child=spawnSync("bash",["-ec",modified],{cwd:worktree,env,encoding:"utf8"});
    assert.ifError(child.error);
    assert.equal(child.status,1);
    assert.equal(child.stdout,"");
    assert.equal(child.stderr,reason+"\n");
  }
  assert.equal(git(worktree,["status","--porcelain"],f.home),"");
  writeFileSync(path.join(worktree,workflowPath),workflow+"\n# local divergence\n");
  const second=run();
  assert.equal(readFileSync(path.join(second,"lane-0.json"),"utf8"),expected[0].command);
});

test("AC-68 the compact brief runs each workflow lane through the shipped runner and never has the agent run recipe steps or install dependencies",t=>{
  const f=makeHome("compact-runner-");t.after(f.cleanup);
  const workflow="on: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo compact lane\n";
  const files={[workflowPath]:workflow};
  for (const name of fixtureFiles) files[tools+"/"+name]=readFileSync(path.join(root,tools,name),"utf8");
  const worktree=path.join(f.root,"checkout");
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/example/widgets.git",files});
  const commit=git(worktree,["rev-parse","HEAD"],f.home);
  const request={provider:"claude",repository:"example/widgets",commit,worktree,branch:"main",model:"fixture-model",lanes:[{name:"check"}],
    resultArtifact:{kind:"validation-outcomes",branch:"vibe-validation-results/runner",path:".vibe-validation-outcomes-87654321.json"},
    laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}};
  const brief=validationBrief(request);
  assert.match(brief,/Run each lane by its zero-based index, 0 through 0, from the repository root with exactly `node "\$p\/cloud-workflow-runner\.mjs" <index> "\$d"`/);
  assert.match(brief,/every step as a non-root user with passwordless sudo, as on GitHub's runner\. The runner itself writes each lane's record/);
  assert.ok(brief.includes("Never create, write or edit any file in $d yourself, and never replace a missing or wrong record by hand"),
    "ISS-14476 the agent never writes lane evidence itself (s6 lint smoke)");
  assert.doesNotMatch(brief,/record exitCode null and notRun|Record the actual foreground exit|Keep the private lane JSON fields/,"no sentence tells the agent to write a lane record");
  assert.doesNotMatch(brief,/perform its committed setup\/action steps|Execute its complete workflow|Install dependencies|as root/,"the agent no longer applies recipe steps or installs in its own checkout, and no step is the agent's as root");
  const command=brief.split("\n").find(line=>line.startsWith("node -e "));
  const dpkg=fakeDpkg(f.root);
  const dir=execFileSync("bash",["-ec",command],{cwd:worktree,env:stubbed(dpkg),encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  assert.equal(existsSync(dpkg.calls)?readFileSync(dpkg.calls,"utf8").includes("dpkg --force-confdef --force-confold --configure -a"):null,process.getuid()===0?true:null,
    "as root the plan step's repair ran, against the stubs; otherwise it never runs dpkg");
  for (const name of ["cloud-workflow-runner.mjs","cloud-validation-host.mjs"]) {
    const shipped=path.join(dir,name);
    assert.equal(existsSync(shipped)?readFileSync(shipped,"utf8"):null,files[tools+"/"+name],name+" is shipped into the private plan directory");
  }
  const lane=runLane(dir,worktree,resultsDirectory(t));
  assert.equal(lane.status,0,lane.stderr);
  assert.match(lane.stdout,/^compact lane$/m);
  assert.match(lane.stdout.trim().split("\n").at(-1),/^CLOUD_WORKFLOW_LANE \{"exitCode":0,"steps":\[\[1,"action",\d+,0\],\[2,"actor",\d+,0\]\]\}$/);
  assert.equal(git(worktree,["status","--porcelain"],f.home),"");
});

// s6 lint smoke: a lane passed in the cloud, but nothing wrote $d/0.json, so the reporter refused and the run had no result.
test("ISS-14476 the brief's own runner command writes every lane record and the shipped reporter turns them into the outcome line: a passed, a failed and a refused lane",t=>{
  const f=makeHome("compact-reporter-");t.after(f.cleanup);
  const workflow="on: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo compact lane\n"+
    "  broken:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: exit 3\n"+
    "  pushed:\n    runs-on: ubuntu-latest\n    if: github.event_name == 'push'\n    steps:\n      - run: echo never\n";
  const files={[workflowPath]:workflow};
  for (const name of fixtureFiles) files[tools+"/"+name]=readFileSync(path.join(root,tools,name),"utf8");
  const worktree=path.join(f.root,"checkout"), repository="example/widgets";
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/"+repository+".git",files});
  // The reporter reads origin through git, so the fixture's URL rewrite to a local mirror is dropped.
  git(worktree,["config","--unset",git(worktree,["config","--name-only","--get-regexp","^url\\..*\\.insteadof$"],f.home)],f.home);
  const commit=git(worktree,["rev-parse","HEAD"],f.home), env=stubbed(fakeDpkg(f.root));
  // One request as the cloud agent follows its brief: the plan step, each lane by the brief's command, then its reporter.
  // Without a result artifact the outcome line holds two lanes, so the three cases take two requests.
  const report=(names,statuses)=>{
    const brief=validationBrief({provider:"claude",repository,commit,worktree,branch:"main",model:"fixture-model",lanes:names.map(name=>({name})),
      laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}});
    const p=execFileSync("bash",["-ec",brief.split("\n").find(line=>line.startsWith("node -e "))],{cwd:worktree,env,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
    const d=resultsDirectory(t);
    const lanes=names.map((_,index)=>briefLane(brief,index,{...env,p,d},worktree));
    assert.deepEqual(lanes.map(lane=>lane.status),statuses,lanes.map(lane=>lane.stderr).join("\n"));
    for (const index of names.keys()) {
      const record=path.join(d,index+".json");
      assert.equal(existsSync(record)?statSync(record).mode&0o777:null,0o600,`the runner wrote ${names[index]}'s private record`);
    }
    const reporter=brief.split("\n").find(line=>line.startsWith('node "$p/cloud-outcome-writer.mjs"'));
    const reported=spawnSync("bash",["-c",reporter],{cwd:worktree,env:{...env,p,d,CLAUDE_CODE_REMOTE:"true"},encoding:"utf8"});
    assert.equal(reported.status,0,reported.stderr);
    const spec=JSON.parse(Buffer.from(readFileSync(path.join(p,"reporter-spec"),"utf8"),"base64url"));
    const [encoded]=outcomeRecords(reported.stdout,"VIBE_OUTCOMES_V1");
    const decoded=decodeOutcomes(encoded,{key:spec.key,commit,repository,names,probe:spec.probe,frozen:spec.frozen,combined:spec.combined});
    assert.equal(decoded.lanes[0].privateStreams.stdout.sha256,createHash("sha256").update(readFileSync(path.join(d,"0.stdout"))).digest("hex"),
      "the outcome line hashes the stream the brief's command redirected");
    return decoded.lanes.map(lane=>[lane.name,lane.exitCode,lane.diagnosis]);
  };
  assert.deepEqual(report(["check","broken"],[0,3]),[["check",0,""],["broken",3,"process failed; see private stream evidence"]]);
  assert.deepEqual(report(["pushed"],[78]),[["pushed",null,"lane was not run"]]);
  assert.equal(git(worktree,["status","--porcelain"],f.home),"");
});

test("AC-68 workflow lanes whose commit lacks the shipped runner, or holds other bytes, are refused by name, never briefed for the agent to run as root; command lanes still brief",t=>{
  const f=makeHome("compact-refused-");t.after(f.cleanup);
  const workflow="on: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lane\n";
  const outcomes={kind:"validation-outcomes",branch:"vibe-validation-results/refused",path:".vibe-validation-outcomes-55667788.json"};
  const brief=(files,lanes=[{name:"check"}],source=true,resultArtifact=outcomes)=>{
    const worktree=mkdtempSync(path.join(f.root,"checkout-"));
    makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/example/widgets.git",files:{[workflowPath]:workflow,...files}});
    const commit=git(worktree,["rev-parse","HEAD"],f.home);
    return validationBrief({provider:"claude",repository:"example/widgets",commit,worktree,branch:"main",model:"fixture-model",lanes,resultArtifact,
      ...(source?{laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}}:{})});
  };
  const shipped=Object.fromEntries(fixtureFiles.map(name=>[tools+"/"+name,readFileSync(path.join(root,tools,name),"utf8")]));
  assert.throws(()=>brief({}),new RegExp(`^Error: ${WORKFLOW_BRIEF_UNAVAILABLE}: workflow lanes run only through the shipped runner, and commit [0-9a-f]{40} has no plugins/vibe/lib/vibe/scripts/cloud-workflow-plan\\.mjs; ${managedRoute}$`),
    "a repository without the tools");
  const runner=tools+"/cloud-workflow-runner.mjs";
  assert.throws(()=>brief({...shipped,[runner]:shipped[runner]+"// another version\n"}),
    new RegExp(`^Error: ${WORKFLOW_BRIEF_UNAVAILABLE}: .*'s plugins/vibe/lib/vibe/scripts/cloud-workflow-runner\\.mjs differs from the installed copy; ${managedRoute}$`), "a commit with another runner");
  assert.throws(()=>compactWorkflowBrief({commit:"c".repeat(40)},[],"key",()=>{throw new Error("missing");}),new RegExp(`^Error: ${WORKFLOW_BRIEF_UNAVAILABLE}: `),
    "the brief builder itself refuses; it never returns a fallback");
  assert.match(brief(shipped),/node "\$p\/cloud-workflow-runner\.mjs" <index>/,"the same request with the shipped tools briefs");
  // ADV-R11-1: a legacy eval artifact (a path and branch, no kind) has no runner route, so even the shipped tools refuse.
  const legacy={branch:"vibe-eval-results/refused",path:"eval-results/refused.json"};
  assert.throws(()=>brief(shipped,[{name:"check"}],true,legacy),new RegExp(`^Error: ${WORKFLOW_BRIEF_UNAVAILABLE}: workflow lanes run only through the shipped runner, and the runner reports only machine outcomes, never a legacy result artifact \\(a path and branch with no kind\\); ${managedRoute}$`),
    "a workflow lane with a legacy result artifact");
  assert.match(brief({},[{name:"check",command:"node --test"}],false,legacy),/- check: node --test/,"a command lane with a legacy result artifact still briefs");
  assert.match(brief({},[{name:"check",command:"node --test"}],false),/- check: node --test/,"a command lane needs no runner and still briefs");
});

test("AC-68 a pnpm lane or a managed-host lane never gets the workflow refusal, even on a commit without the shipped runner (team-lead ruling (b), 2026-11-25)",t=>{
  const f=makeHome("compact-pnpm-");t.after(f.cleanup);
  const workflow="on: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lane\n";
  const worktree=path.join(f.root,"checkout");
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/example/widgets.git",files:{[workflowPath]:workflow,
    "package.json":JSON.stringify({scripts:{"docker:ensure":"node scripts/docker.mjs"}})}});
  const commit=git(worktree,["rev-parse","HEAD"],f.home);
  const request=(lanes,source=false)=>({provider:"claude",repository:"example/widgets",commit,worktree,branch:"main",model:"fixture-model",lanes,
    resultArtifact:{kind:"validation-outcomes",branch:"vibe-validation-results/pnpm",path:".vibe-validation-outcomes-99887766.json"},
    ...(source?{laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}}:{})});
  const managed={tool:{commit:"a".repeat(40),ref:"refs/heads/vibe-proof"},affected:[]};
  assert.throws(()=>validationBrief(request([{name:"check"}],true)),new RegExp(`^Error: ${WORKFLOW_BRIEF_UNAVAILABLE}: `),"precondition: this commit's workflow lanes are refused");
  const briefs={
    "a pnpm lane":validationBrief(request([{name:"typecheck",command:"pnpm --filter widgets typecheck"}])),
    "a managed pnpm lane":validationBrief(request([{name:"containers",command:"pnpm docker:ensure"}]),managed),
    "a workflow lane on the managed host":validationBrief(request([{name:"check"}],true),managed),
  };
  for (const [name,brief] of Object.entries(briefs)) assert.doesNotMatch(brief,/CLOUD_WORKFLOW_BRIEF_UNAVAILABLE|cloud-workflow-runner/,name);
  // ADV-R11-2: the host runner runs the managed workflow lane; the agent is never told to perform its steps beside it.
  assert.match(briefs["a workflow lane on the managed host"],/This request uses the verified non-root lane runner/,"the managed host runs the lane");
  assert.doesNotMatch(briefs["a workflow lane on the managed host"],/immutable recipes|perform its committed setup\/action steps|run its committed run steps/,
    "the managed workflow brief never asks the agent to perform the recipe's steps");
  assert.match(briefs["a pnpm lane"],/- typecheck: pnpm --filter widgets typecheck/,"the pnpm lane is briefed as its own command");
});

test("AC-68 a workflow validation the brief refuses ends before the queue hold, the proof push or any launch",async t=>{
  const f=makeHome("compact-refused-hold-");t.after(f.cleanup);
  const workflow="on: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lane\n";
  const worktree=path.join(f.root,"checkout");
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/example/widgets.git",files:{[workflowPath]:workflow}});
  const commit=git(worktree,["rev-parse","HEAD"],f.home), calls=[];
  const request={provider:"claude",repository:"example/widgets",commit,worktree,branch:"main",model:"fixture-model",lanes:[{name:"check"}],cloudProof:true,
    claudeEnvironment:"env_01TestRequest",laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}};
  await assert.rejects(validateCommit(request,{remote:action=>{calls.push(action);throw new Error("no provider call expected");},sleep:async()=>{},home:f.home,
    proofGit:()=>{calls.push("proof git");return "";}}),new RegExp(`^Error: ${WORKFLOW_BRIEF_UNAVAILABLE}: `));
  assert.deepEqual(calls,[],"no routine, run or proof push");
  assert.equal(existsSync(path.join(f.home,".codex/vibe/cloud/validation-queues")),false,"the account's validation slot was never taken");
});

// A compact plan prepared as the bootstrap prepares it, with the host's package repair replaced by a fixed result.
function repairedPlan(t){
  const f=makeHome("compact-repair-");t.after(f.cleanup);
  const workflow="on: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo compact lane\n";
  const files={[workflowPath]:workflow};
  for (const name of fixtureFiles) files[tools+"/"+name]=readFileSync(path.join(root,tools,name),"utf8");
  const worktree=path.join(f.root,"checkout");
  makeCheckout({...f,checkout:worktree,remoteUrl:"https://github.com/example/widgets.git",files});
  const commit=git(worktree,["rev-parse","HEAD"],f.home);
  const request={provider:"claude",repository:"example/widgets",commit,worktree,branch:"main",model:"fixture-model",lanes:[{name:"check"}],
    resultArtifact:{kind:"validation-outcomes",branch:"vibe-validation-results/repair",path:".vibe-validation-outcomes-11223344.json"},
    laneSource:{kind:"github-workflow",path:workflowPath,sha256:checksum(workflow),commit}};
  const command=validationBrief(request).split("\n").find(line=>line.startsWith("node -e "));
  const shipped=execFileSync("bash",["-ec",command],{cwd:worktree,env:stubbed(fakeDpkg(f.root)),encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const {plan}=JSON.parse(Buffer.from(command.slice(command.lastIndexOf(" ")+1),"base64url"));
  const prepare=repaired=>{
    const dir=mkdtempSync(path.join(worktree,".git","vibe-repair-"));
    for (const name of fixtureFiles) copyFileSync(path.join(shipped,name),path.join(dir,name));
    const reader=pathToFileURL(path.join(dir,"cloud-workflow-plan.mjs")).href;
    const child=spawnSync(process.execPath,["--input-type=module","-e",`import { prepareWorkflowPlan } from ${JSON.stringify(reader)};
prepareWorkflowPlan(JSON.parse(process.argv[1]),process.argv[2],()=>JSON.parse(process.argv[3]));`,JSON.stringify(plan),dir,JSON.stringify(repaired)],{cwd:worktree,encoding:"utf8"});
    assert.equal(child.status,0,child.stderr);
    return dir;
  };
  const lane=dir=>{const d=resultsDirectory(t);return {...runLane(dir,worktree,d),record:path.join(d,"0.json")};};
  return {prepare,lane};
}

test("ISS-14476 the plan records the host's package repair once before any lane, and a failed repair refuses every lane with its reason before any step",t=>{
  const {prepare,lane}=repairedPlan(t);
  const failure={exitCode:1,partlyInstalled:["zsh:unpacked"],detail:"exit 1; dpkg --configure -a failed"};
  const failed=prepare(failure);
  const record=path.join(failed,"package-repair.json");
  assert.deepEqual(existsSync(record)?JSON.parse(readFileSync(record,"utf8")):null,failure,"the plan holds the repair's result for every lane");
  const refused=lane(failed);
  assert.equal(refused.status,78);
  assert.equal(refused.stdout,"","no step runs");
  assert.equal(refused.stderr,"CLOUD_WORKFLOW_NOT_RUN root setup: the host's package repair failed before any lane: exit 1; dpkg --configure -a failed\n");
  assert.deepEqual(existsSync(refused.record)?JSON.parse(readFileSync(refused.record,"utf8")):null,{name:"check",exitCode:null,
    notRun:"root setup: the host's package repair failed before any lane: exit 1; dpkg --configure -a failed",diagnosis:"lane was not run",stdoutTail:"",
    stderrTail:"CLOUD_WORKFLOW_NOT_RUN root setup: the host's package repair failed before any lane: exit 1; dpkg --configure -a failed"},
    "ISS-14476 the runner records the refused lane itself");
  assert.equal(existsSync(path.join(prepare(null),"package-repair.json")),false,"a host with nothing to repair records nothing");
});

test("ISS-14476 each lane's line names the packages the plan's repair finished before it",t=>{
  const {prepare,lane}=repairedPlan(t);
  const ran=lane(prepare({exitCode:0,partlyInstalled:["zsh:unpacked","zsh-common:unpacked"],detail:""}));
  assert.equal(ran.status,0,ran.stderr);
  assert.match(ran.stdout.trim().split("\n").at(-1),/^CLOUD_WORKFLOW_LANE \{"exitCode":0,"steps":\[\[1,"action",\d+,0\],\[2,"actor",\d+,0\]\],"repaired":\["zsh:unpacked","zsh-common:unpacked"\]\}$/);
});
