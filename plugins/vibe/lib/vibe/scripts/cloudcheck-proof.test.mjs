import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { git, makeCheckout, makeHome } from "../../../../vibe/skills/vibe/scripts/test-fixtures.mjs";
import { checkCloudcheckRequest, prepareCloudcheckProof } from "./cloudcheck-proof.mjs";
import { NO_EXECUTOR } from "./cloud-routines.mjs";
import { validateCommit } from "./cloud-worker.mjs";

const SHA = "a123456789abcdefa123456789abcdefa1234567";
const DIGEST = "d".repeat(64);
const OTHER = "b".repeat(40);

function fixture(t) {
  const f = makeHome("vibe-cloudcheck-proof-");
  t.after(f.cleanup);
  const refs = new Map();
  const operations = [];
  let pushFailed = false;
  let pushMismatch = false;
  const read = (_, args) => {
    operations.push(args);
    if (args[0] === "rev-parse") return args[3].split("^")[0];
    if (args[0] === "ls-remote") return refs.has(args[3]) ? `${refs.get(args[3])}\t${args[3]}\n` : "";
    if (args[0] === "push") {
      if (pushFailed) throw new Error("proof push failed");
      const [commit, ref] = args[2].split(":");
      refs.set(ref, pushMismatch ? OTHER : commit);
      return "";
    }
    assert.fail("unrelated operation: " + args[0]);
  };
  return { ref: (key = DIGEST) => `refs/heads/cloudcheck/vibe-${key}-${SHA}`, refs, operations,
    failPush: () => { pushFailed = true; }, mismatchAfterPush: () => { pushMismatch = true; },
    prepare: (overrides = {}) => prepareCloudcheckProof({ worktree: f.root, commit: SHA, key: DIGEST, gitDir: f.root, git: read, ...overrides }) };
}

test("ISS-14476 zsh colon modifier loses the literal refspec, and argv keeps it exact and auditable", (t) => {
  const f = fixture(t);
  const old = spawnSync("/bin/zsh", ["-fc", 'C=$1; print -r -- "$C:refs/heads/old"','_',SHA], { encoding: "utf8" });
  assert.notEqual(old.stdout.trim(), `${SHA}:refs/heads/old`);
  const proof = f.prepare();
  assert.equal(proof.ref, f.ref());
  assert.equal(proof.commit, SHA);
  assert.deepEqual(f.operations.filter(([command]) => command === "push"), [["push", "origin", `${SHA}:${proof.ref}`]]);
  assert.equal(f.refs.get(proof.ref), SHA);
  assert.deepEqual(f.prepare(), proof);
  assert.equal(f.operations.filter(([command]) => command === "push").length, 1);
  assert.ok(!f.operations.flat().some((arg) => /force|delete/.test(arg)));
});

test("ISS-14476 stale and moved refs, local short SHA and failed proof pushes fail closed", (t) => {
  const f = fixture(t);
  f.refs.set(f.ref(), OTHER);
  assert.throws(f.prepare, /left intact/);
  assert.equal(f.refs.get(f.ref()), OTHER);
  assert.ok(!f.operations.some(([command]) => command === "push"));
  assert.throws(() => f.prepare({ commit: "1234567" }), /full local commit/);
  assert.throws(() => checkCloudcheckRequest({ branch: "cloudcheck/handmade" }), /validate owns the immutable/);
  const failing = fixture(t);
  failing.failPush();
  assert.throws(failing.prepare, /proof push failed/);
  const after = fixture(t);
  after.mismatchAfterPush();
  assert.throws(after.prepare, /did not verify at the full requested SHA/);
});

test("ISS-14476 same requests reuse one immutable ref and different requests never share it", async (t) => {
  const f = fixture(t);
  const different = "1".repeat(64);
  const [a, b, c] = await Promise.all([Promise.resolve().then(f.prepare), Promise.resolve().then(f.prepare),
    Promise.resolve().then(() => f.prepare({ key: different }))]);
  assert.deepEqual(a, b);
  assert.notEqual(a.ref, c.ref);
  assert.equal(f.refs.size, 2);
  assert.equal(f.operations.filter(([command]) => command === "push").length, 2);
});

test("ISS-14476 validate refuses to create or run a routine before the exact proof ref verified", async (t) => {
  const f = makeHome("vibe-cloudcheck-start-");
  t.after(f.cleanup);
  const worktree = path.join(f.root, "checkout");
  const repository = "closedloop-ai/claude-plugins";
  makeCheckout({ ...f, checkout: worktree, remoteUrl: `https://github.com/${repository}.git` });
  const commit = git(worktree, ["rev-parse", "HEAD"], f.home);
  const request = { branch: "feature", worktree, repository, commit, provider: "claude", model: "claude-sonnet-5-5",
    cloudProof: true, claudeEnvironment: "env_01Proof", lanes: [{ name: "unit", command: "node --test example.test.mjs" }] };
  const operations = [];
  const proofGit = (_, args) => {
    operations.push(args);
    if (args[0] === "rev-parse") return commit;
    if (args[0] === "ls-remote") return `${OTHER}\t${args[3]}`;
    assert.fail("The mismatch should suppress the attempted push");
  };
  const remoteCalls = [];
  const remote = (action) => { remoteCalls.push(action); assert.fail("cloud operation should wait for proof"); };
  await assert.rejects(() => validateCommit(request, { home: f.home, remote, executor: NO_EXECUTOR, proofGit }), /left intact/);
  assert.deepEqual(operations.map((args) => args[0]), ["rev-parse", "ls-remote"]);
  assert.deepEqual(remoteCalls, []);
});
