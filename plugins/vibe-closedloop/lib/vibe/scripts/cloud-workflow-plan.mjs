import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { validationCommandKey } from "./cloud-receipts.mjs";
import { workflowLaneDefinitions } from "./workflow-lane-definitions.mjs";

/** Bind the selected order as well as each complete canonical recipe, including actions, matrix and conditions. */
export function workflowSelectionKey(lanes) {
  return validationCommandKey(JSON.stringify(lanes.map(lane=>[lane.name,validationCommandKey(lane.command)])));
}

/** Reconstitute the locally validated definitions from Git objects into a fresh private directory. */
export function prepareWorkflowPlan({source, selectionKey, reporter}, directory) {
  const {commit, names} = reporter;
  const git = (...args) => execFileSync("git",args,{encoding:"utf8",maxBuffer:8*1024*1024});
  if (git("rev-parse","HEAD").trim() !== commit || source.commit !== commit) throw new Error("workflow checkout differs");
  const yaml = git("show",commit+":"+source.path);
  if (validationCommandKey(yaml) !== source.sha256) throw new Error("committed workflow SHA-256 differs");
  const available = new Map(workflowLaneDefinitions(yaml).map(row=>[row.name,row]));
  const selected = names.map(name=>available.get(name));
  if (selected.some(row=>!row) || new Set(names).size !== names.length || workflowSelectionKey(selected) !== selectionKey)
    throw new Error("workflow selection or command key differs");
  writeFileSync(path.join(directory,"lanes.json"),JSON.stringify(names),{flag:"wx",mode:0o600});
  for (const [index,row] of selected.entries())
    writeFileSync(path.join(directory,"lane-"+index+".json"),row.command,{flag:"wx",mode:0o600});
  writeFileSync(path.join(directory,"reporter-spec"),Buffer.from(JSON.stringify(reporter)).toString("base64url"),{flag:"wx",mode:0o600});
}
