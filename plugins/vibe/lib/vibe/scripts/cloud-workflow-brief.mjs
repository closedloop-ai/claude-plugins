import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { outcomeSpec, reporterFiles } from "./cloud-outcome-instruction.mjs";
import { toolingRoot } from "./cloud-validation-recipes.mjs";
import { workflowSelectionKey } from "./cloud-workflow-plan.mjs";
import { WORKFLOW_NOT_RUN } from "./cloud-workflow-runner.mjs";

// The runner and the host module (the supervisor it runs every step through, and the package repair the plan reader
// runs once as root before any lane) are shipped and verified like the plan reader.
const modules = ["cloud-workflow-plan.mjs", "workflow-lane-definitions.mjs", "cloud-receipts.mjs", "cloud-validation-host.mjs", "cloud-workflow-runner.mjs", ...reporterFiles];
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

// The refusal of a workflow-file validation whose commit cannot run the shipped runner, or whose result is a legacy eval
// artifact the runner cannot report. Only workflow-file lanes reach it: a pnpm command lane or a managed-host lane is
// briefed without the runner.
export const WORKFLOW_BRIEF_UNAVAILABLE = "CLOUD_WORKFLOW_BRIEF_UNAVAILABLE";
const MANAGED_PNPM_ROUTE = "validate this commit through its managed pnpm lanes instead: lanes [{name, command}] whose command is a pnpm script, with no workflow file";

/**
 * Workflow lanes run only through the shipped runner, from the subject commit's own copy of these tools, checked byte
 * for byte against the installed ones. A commit that lacks one, or holds other bytes, is refused by name before any
 * launch: the agent never runs workflow steps itself as root without the package repair (team-lead rulings,
 * 2026-11-25: refuse with a named error rather than fall back to root, and point to the managed pnpm lanes).
 */
export function compactWorkflowBrief(request,lanes,key,readCommitted,legacyArtifact=false) {
  const root=toolingRoot+"/lib/vibe/scripts", hash=createHash("sha256");
  const refuse=why=>{throw new Error(`${WORKFLOW_BRIEF_UNAVAILABLE}: workflow lanes run only through the shipped runner, and ${why}; ${MANAGED_PNPM_ROUTE}`);};
  if (legacyArtifact) refuse("the runner reports only machine outcomes, never a legacy result artifact (a path and branch with no kind)");
  for (const name of modules) {
    const installed=readFileSync(new URL(name,import.meta.url));
    let subject;
    try {subject=readCommitted(root+"/"+name);} catch {refuse(`commit ${request.commit} has no ${root}/${name}`);}
    if (!installed.equals(Buffer.from(subject))) refuse(`commit ${request.commit}'s ${root}/${name} differs from the installed copy`);
    hash.update(installed).update("\0");
  }
  const plan={source:request.laneSource,selectionKey:workflowSelectionKey(lanes),reporter:outcomeSpec(request,lanes,key,false)};
  const packed=Buffer.from(JSON.stringify({modules,root,toolsKey:hash.digest("hex"),plan})).toString("base64url");
  const command="node -e "+quote("("+bootstrap.toString()+")().catch(e=>{console.error(e.message);process.exitCode=1})")+" "+packed;
  // A single-line tool invocation can be copied literally. The code itself contains no line comments.
  const start=[
    "Prepare the exact ordered CI recipes from the checked-out commit. Save the printed private directory as p for later calls.",
    command.replace(/\n\s*/g," "),
    "The exact ordered lane names are in $p/lanes.json. Run each lane by its zero-based index, 0 through "+(lanes.length-1)+", from the repository root with exactly `node \"$p/cloud-workflow-runner.mjs\" <index>`, with stdout and stderr redirected into $d/<index>.stdout and .stderr; its exit code is the lane's exit code. The runner executes the lane's complete committed workflow job in a private copy of the commit, in declared order as in CI: every step as a non-root user with passwordless sudo, as on GitHub's runner. Never run a recipe step yourself, and do not embed private recipe or output files in a response. When the stderr file ends with a "+WORKFLOW_NOT_RUN+" line, record exitCode null and notRun with that line's reason. Keep the last stdout line, CLOUD_WORKFLOW_LANE, in your lane status.",
  ].join("\n\n");
  return {start, reporter:'node "$p/cloud-outcome-writer.mjs" "$(cat "$p/reporter-spec")" "$d"'};
}
