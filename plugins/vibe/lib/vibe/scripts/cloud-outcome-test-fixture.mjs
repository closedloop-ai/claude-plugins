import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { validationReceiptName } from "./cloud-receipts.mjs";
import { encodeOutcomes, outcomeLine } from "./cloud-outcome-artifact.mjs";

const requestKey = request => createHash("sha256").update(JSON.stringify(request)).digest("hex");
const emptyStream = { bytes: 0, sha256: createHash("sha256").digest("hex") };

/** Simulate the result carrier selected by a new validation, bound to the fixture's exact request. */
export function machineTestReport(request, codes, repository = request.repository) {
  const lanes = codes.map(exitCode => ({exitCode,privateStreams:{stdout:emptyStream,stderr:emptyStream}}));
  return outcomeLine(encodeOutcomes({key:requestKey(request),commit:request.commit,repository,host:"vm",directory:"/tmp/vibe-lane-results-a1b2c3",lanes}));
}

/** Replay a real archived provider transcript through its original, pre-machine receipt. */
export function seedArchivedValidation(request, sessionId, routineId) {
  const digest=requestKey(request);
  const file=path.join(request.worktree,".git",validationReceiptName(request.commit,digest));
  writeFileSync(file,JSON.stringify({provider:"claude",runId:sessionId,taskId:sessionId,routineId,sessionId,
    commit:request.commit,status:"completed",startedAt:"2026-11-10T23:39:41Z",requestDigest:digest}));
}
