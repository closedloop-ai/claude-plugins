import { existsSync } from "node:fs";
import path from "node:path";
import { regularJson, writeAtomic } from "./owned-state.mjs";

const SHA = /^[a-f0-9]{40}$/;
const KEY = /^[a-f0-9]{64}$/;
const SCHEMA = "vibe.cloudcheck-proof/1";

/** Ensure cloudcheck refs are owned by validate instead of supplied by callers. */
export function checkCloudcheckRequest(request) {
  if (request.cloudProof !== undefined && typeof request.cloudProof !== "boolean") throw new Error("cloudProof must be true or false");
  if (typeof request.branch === "string" && request.branch.startsWith("cloudcheck/")) {
    throw new Error("use cloudProof: true and name the ordinary branch; validate owns the immutable cloudcheck proof ref");
  }
}

/** Derive the same owned proof identity when resuming an exact recorded routine. */
export function cloudcheckProofIdentity(commit, key) {
  if (!SHA.test(commit ?? "") || !KEY.test(key ?? "")) throw new Error("CLOUDCHECK_UNVERIFIED: a full local commit and validation request digest are required");
  const branch = `cloudcheck/vibe-${key}-${commit}`;
  return { branch, ref: `refs/heads/${branch}`, commit };
}

function remoteSha(read, ref) {
  const output = read(["ls-remote", "--refs", "origin", ref]).trim();
  if (!output) return null;
  const rows = output.split("\n");
  const [oid, found, extra] = rows[0].split("\t");
  if (rows.length !== 1 || extra !== undefined || found !== ref || !SHA.test(oid)) {
    throw new Error(`CLOUDCHECK_UNVERIFIED: origin did not return one full SHA for ${ref}`);
  }
  return oid;
}

/**
 * Create an immutable ref with normal Git argv, then prove the exact remote SHA. The request lock owns this operation
 * within a worktree. A different request or SHA gets a different name. Proof refs are retained for audit.
 */
export function prepareCloudcheckProof({ worktree, commit, key, gitDir, git, now = Date.now }) {
  const proof = cloudcheckProofIdentity(commit, key);
  const { branch, ref } = proof;
  const read = (args) => git(worktree, args);
  if (read(["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).trim() !== commit) {
    throw new Error("CLOUDCHECK_UNVERIFIED: the proof SHA does not identify the exact local commit");
  }
  const file = path.join(gitDir, "vibe-cloudcheck", `${key}.json`);
  const identity = { schema: SCHEMA, requestDigest: key, commit, branch, ref, remote: "origin" };
  let record;
  if (existsSync(file)) {
    record = regularJson(file);
    if (Object.entries(identity).some(([field, expected]) => record[field] !== expected)) {
      throw new Error("CLOUDCHECK_UNVERIFIED: local proof ownership belongs to another request or commit");
    }
  }
  let observed = remoteSha(read, ref);
  if (observed !== null && observed !== commit) {
    throw new Error(`CLOUDCHECK_UNVERIFIED: ${ref} is ${observed}, expected ${commit}. The ref was left intact.`);
  }
  if (!record) writeAtomic(file, { ...identity, plannedAt: new Date(now()).toISOString() }, { exclusive: true });
  if (!observed) {
    read(["push", "origin", `${commit}:${ref}`]);
    observed = remoteSha(read, ref);
  }
  if (observed !== commit) throw new Error(`CLOUDCHECK_UNVERIFIED: ${ref} did not verify at the full requested SHA ${commit}; refusing cloud dispatch`);
  writeAtomic(file, { ...identity, plannedAt: record?.plannedAt ?? new Date(now()).toISOString(), verifiedAt: new Date(now()).toISOString() });
  return proof;
}
