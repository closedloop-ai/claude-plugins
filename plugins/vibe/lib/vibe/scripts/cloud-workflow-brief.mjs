import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { outcomeSpec } from "./cloud-outcome-instruction.mjs";
import { toolingRoot } from "./cloud-validation-recipes.mjs";
import { workflowSelectionKey } from "./cloud-workflow-plan.mjs";

const modules = ["cloud-workflow-plan","workflow-lane-definitions","cloud-receipts","captured-json","github-remote","cloud-outcome-artifact","cloud-outcome-writer"].map(n=>n+".mjs");
const quote = text => "'"+text.replaceAll("'","'\"'\"'")+"'";

/** This fixed bootstrap verifies every committed helper byte before importing anything from the application. */
async function bootstrap() {
  const fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto");
  const git=(...args)=>require("node:child_process").execFileSync("git",args,{maxBuffer:8*1024*1024});
  const {modules,root,toolsKey,plan}=JSON.parse(Buffer.from(process.argv[1],"base64url"));
  if (git("rev-parse","HEAD").toString().trim()!==plan.reporter.commit) throw Error("workflow checkout differs");
  const contents=modules.map(name=>git("show",plan.reporter.commit+":"+root+"/"+name));
  const hash=crypto.createHash("sha256");
  for(const bytes of contents) hash.update(bytes).update("\0");
  if(hash.digest("hex")!==toolsKey) throw Error("workflow or reporter tools differ");
  const dir=fs.mkdtempSync(path.join(git("rev-parse","--absolute-git-dir").toString().trim(),"vibe-workflow-"));
  try {
    for(const [i,name] of modules.entries()) fs.writeFileSync(path.join(dir,name),contents[i],{mode:0o600,flag:"wx"});
    const reader=await import(require("node:url").pathToFileURL(path.join(dir,modules[0])).href);
    reader.prepareWorkflowPlan(plan,dir);
    console.log(dir);
  } catch(error) {fs.rmSync(dir,{recursive:true,force:true});throw error;}
}

/** Reuse exact shipped tools when the subject commit contains them. Other repositories retain their installed-tool transport. */
export function compactWorkflowBrief(request,lanes,key,readCommitted) {
  const root=toolingRoot+"/lib/vibe/scripts", hash=createHash("sha256");
  for (const name of modules) {
    const installed=readFileSync(new URL(name,import.meta.url));
    let subject;
    try {subject=readCommitted(root+"/"+name);} catch {return null;}
    if (!installed.equals(Buffer.from(subject))) return null;
    hash.update(installed).update("\0");
  }
  const plan={source:request.laneSource,selectionKey:workflowSelectionKey(lanes),reporter:outcomeSpec(request,lanes,key,false)};
  const packed=Buffer.from(JSON.stringify({modules,root,toolsKey:hash.digest("hex"),plan})).toString("base64url");
  const command="node -e "+quote("("+bootstrap.toString()+")().catch(e=>{console.error(e.message);process.exitCode=1})")+" "+packed;
  // A single-line tool invocation can be copied literally. The code itself contains no line comments.
  const start=[
    "Prepare the exact ordered CI recipes from the checked-out commit. Save the printed private directory as p for later calls.",
    command.replace(/\n\s*/g," "),
    "Read the exact ordered lane names in $p/lanes.json. For indices 0 through "+(lanes.length-1)+", read $p/lane-<index>.json privately. Execute its complete workflow and job with the selected matrix. Apply every action, environment, condition, working directory and run step in declared order, as in CI. Do not embed private recipe or output files in a response.",
  ].join("\n\n");
  return {start, reporter:'node "$p/cloud-outcome-writer.mjs" "$(cat "$p/reporter-spec")" "$d"'};
}
