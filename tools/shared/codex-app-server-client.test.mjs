import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";

function fixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit("exit", 0, null); };
  const writes = [];
  child.stdin.on("data", (chunk) => writes.push(JSON.parse(String(chunk))));
  const client = new CodexAppServerClient({ codex: "codex", env: {}, spawnImpl: () => child });
  return { child, client, writes };
}

test("shared client resumes the exact thread and polls without turn history", async () => {
  const { child, client, writes } = fixture();
  const resumed = client.resumeThread("thread-1", "/repo");
  await new Promise((resolve) => setImmediate(resolve));
  const resumeCall = writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: resumeCall.id,
    result: { thread: { id: "thread-1", cwd: "/repo" } } })}\n`);
  assert.equal((await resumed).id, "thread-1");
  const state = client.readThreadState("thread-1");
  await new Promise((resolve) => setImmediate(resolve));
  const [read, turns] = writes.slice(-2);
  assert.deepEqual(read.params, { threadId: "thread-1", includeTurns: false });
  assert.deepEqual(turns.params, { threadId: "thread-1", limit: 1,
    sortDirection: "desc", itemsView: "notLoaded" });
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: read.id,
    result: { thread: { id: "thread-1", status: "idle" } } })}\n`);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: turns.id,
    result: { data: [{ id: "turn-1", status: "completed" }] } })}\n`);
  assert.equal((await state).latestTurn.id, "turn-1");
  await client.close();
});

test("shared client rejects a substituted resumed thread and closes its child", async () => {
  const { child, client, writes } = fixture();
  const resumed = client.resumeThread("thread-1", "/repo");
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: writes.at(-1).id,
    result: { thread: { id: "thread-other", cwd: "/repo" } } })}\n`);
  await assert.rejects(resumed, /different thread/);
  await client.close();
  assert.equal(child.killed, true);
});
