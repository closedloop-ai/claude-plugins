import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, shepherd, shepherdEvent } from "./shepherd.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "shepherd.mjs");
const OPEN = { state: "OPEN", mergeable: "MERGEABLE", headRefOid: "abc", statusCheckRollup: [{ name: "lint", conclusion: "SUCCESS" }, { name: "e2e", conclusion: null, status: "IN_PROGRESS" }] };

test("each pull request state maps to the action the writer takes", () => {
  assert.equal(shepherdEvent(OPEN), null);
  assert.deepEqual(shepherdEvent({ ...OPEN, state: "MERGED" }), { event: "merged" });
  assert.deepEqual(shepherdEvent({ ...OPEN, state: "CLOSED" }), { event: "closed" });
  assert.deepEqual(shepherdEvent({ ...OPEN, mergeable: "CONFLICTING" }), { event: "conflict", head: "abc" });
  assert.deepEqual(
    shepherdEvent({ ...OPEN, statusCheckRollup: [{ name: "lint", conclusion: "FAILURE" }, { context: "deploy", state: "ERROR" }] }),
    { event: "checks-failed", head: "abc", failed: ["lint", "deploy"] }
  );
  assert.equal(shepherdEvent({ ...OPEN, mergeable: "UNKNOWN" }), null, "unknown mergeability keeps waiting");
  assert.deepEqual(shepherdEvent({ ...OPEN, waitingThreads: 2 }), { event: "threads", head: "abc", unresolved: 2 });
  assert.deepEqual(shepherdEvent({ ...OPEN, state: "MERGED", waitingThreads: 2 }), { event: "merged" });
});

test("it keeps polling until a conflict appears, and a single failed read is retried", async () => {
  const reads = [() => OPEN, () => { throw new Error("gh: 502"); }, () => OPEN, () => ({ ...OPEN, mergeable: "CONFLICTING" })];
  let calls = 0;
  const result = await shepherd({ pr: 1, repo: "o/r", intervalSeconds: 0, read: () => reads[calls++]() });
  assert.deepEqual(result, { event: "conflict", head: "abc" });
  assert.equal(calls, 4);
  const failing = await shepherd({ pr: 1, repo: "o/r", intervalSeconds: 0, read: () => { throw new Error("gh: auth\nmore"); } });
  assert.deepEqual(failing, { event: "unreadable", error: "gh: auth" });
  assert.deepEqual(await shepherd({ pr: 1, repo: "o/r", intervalSeconds: 0, maxPolls: 2, read: () => OPEN }), { event: "waiting", polls: 2 });
});

test("the command reads the pull request through gh and exits with the event's code", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-shepherd-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "pr.json"), JSON.stringify({ ...OPEN, mergeable: "CONFLICTING" }));
  writeFileSync(path.join(dir, "threads.json"), JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncase "$1 $2" in\n  "api user") echo writer ;;\n  "api graphql") cat "${dir}/threads.json" ;;\n  *) cat "${dir}/pr.json" ;;\nesac\n`);
  chmodSync(path.join(dir, "gh"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const shepherdRun = () => spawnSync(process.execPath, [SCRIPT, "--pr", "42", "--repo", "o/r", "--interval-seconds", "0", "--max-polls", "1"], { encoding: "utf8", env });
  const result = shepherdRun();
  assert.equal(result.status, EXIT.conflict);
  assert.deepEqual(JSON.parse(result.stdout), { event: "conflict", head: "abc" });
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--pr", "x"], { encoding: "utf8" }).status, 64);

  // An approved pull request with auto-merge armed and a new reviewer thread is work, not waiting.
  writeFileSync(path.join(dir, "pr.json"), JSON.stringify({ ...OPEN, reviewDecision: "APPROVED" }));
  const thread = (login, latest) => ({ isResolved: false, comments: { nodes: [{ author: { login } }] }, latest: { nodes: [{ author: { login: latest } }] } });
  writeFileSync(path.join(dir, "threads.json"), JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
    thread("reviewer", "reviewer"),
    thread("reviewer", "writer"),
    { ...thread("reviewer", "reviewer"), isResolved: true },
  ] } } } } }));
  const threads = shepherdRun();
  assert.equal(threads.status, EXIT.threads);
  assert.deepEqual(JSON.parse(threads.stdout), { event: "threads", head: "abc", unresolved: 1 });
  writeFileSync(path.join(dir, "threads.json"), JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [thread("reviewer", "writer")] } } } } }));
  assert.equal(shepherdRun().status, EXIT.waiting, "a thread the writer answered last waits on the reviewer");
});
