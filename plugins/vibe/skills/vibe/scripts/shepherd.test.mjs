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
  writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat "${dir}/pr.json"\n`);
  chmodSync(path.join(dir, "gh"), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const result = spawnSync(process.execPath, [SCRIPT, "--pr", "42", "--repo", "o/r", "--interval-seconds", "0"], { encoding: "utf8", env });
  assert.equal(result.status, EXIT.conflict);
  assert.deepEqual(JSON.parse(result.stdout), { event: "conflict", head: "abc" });
  assert.equal(spawnSync(process.execPath, [SCRIPT, "--pr", "x"], { encoding: "utf8" }).status, 64);
});
