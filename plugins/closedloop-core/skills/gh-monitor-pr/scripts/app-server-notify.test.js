"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deliverPrompt,
  parseArguments,
} = require("./app-server-notify.js");
const nativeClient = import("./native-app-server-client.mjs");

class FakeClient {
  constructor(responses) {
    this.responses = [...responses];
    this.requests = [];
  }

  async request(method, params, timeoutMs) {
    this.requests.push({ method, params, timeoutMs });
    const next = this.responses.shift();
    assert.equal(next.method, method);
    if (next.error) throw new Error(next.error);
    return next.result;
  }
}

const activeRead = {
  method: "thread/read",
  result: { thread: { id: "thread-1", status: { type: "active" } } },
};
const activeTurns = {
  method: "thread/turns/list",
  result: { data: [{ id: "turn-active", status: "inProgress" }] },
};
const idleRead = {
  method: "thread/read",
  result: { thread: { id: "thread-1", status: { type: "idle" } } },
};
const options = { threadId: "thread-1", cwd: "/tmp", waitSeconds: 1 };

test("steers an active turn without trying to resume it", async () => {
  const client = new FakeClient([
    activeRead,
    activeTurns,
    { method: "turn/steer", result: { turnId: "turn-active" } },
  ]);
  const result = await deliverPrompt(client, options, "event", 0);
  assert.deepEqual(result, { status: "accepted", mode: "steer", turnId: "turn-active" });
  assert.deepEqual(client.requests.map(({ method }) => method), [
    "thread/read", "thread/turns/list", "turn/steer",
  ]);
});

test("resumes an idle thread and starts a new turn", async () => {
  const client = new FakeClient([
    idleRead,
    { method: "thread/resume", result: { thread: { id: "thread-1", cwd: "/tmp", status: { type: "idle" } } } },
    { method: "turn/start", result: { turn: { id: "turn-new" } } },
  ]);
  const result = await deliverPrompt(client, options, "event", 0);
  assert.deepEqual(result, { status: "accepted", mode: "start", turnId: "turn-new" });
});

test("passes an extended delivery budget through to large thread resumes", async () => {
  const client = new FakeClient([
    idleRead,
    { method: "thread/resume", result: { thread: { id: "thread-1", cwd: "/tmp", status: { type: "idle" } } } },
    { method: "turn/start", result: { turn: { id: "turn-new" } } },
  ]);
  const result = await deliverPrompt(client, { ...options, waitSeconds: 180 }, "event", 0);
  const resumeCall = client.requests.find((request) => request.method === "thread/resume");
  assert.deepEqual(result, { status: "accepted", mode: "start", turnId: "turn-new" });
  assert.ok(resumeCall.timeoutMs > 60_000);
});

test("starts after a resume timeout when reread shows the thread loaded", async () => {
  const client = new FakeClient([
    idleRead,
    { method: "thread/resume", error: "thread/resume timed out" },
    idleRead,
    { method: "turn/start", result: { turn: { id: "turn-new" } } },
  ]);
  const result = await deliverPrompt(client, { ...options, waitSeconds: 2 }, "event", 0);
  assert.deepEqual(result, { status: "accepted", mode: "start", turnId: "turn-new" });
  assert.deepEqual(client.requests.map(({ method }) => method), [
    "thread/read", "thread/resume", "thread/read", "turn/start",
  ]);
});

test("switches from steer to start when the active turn finishes during delivery", async () => {
  const client = new FakeClient([
    activeRead,
    activeTurns,
    { method: "turn/steer", error: "no active turn (-32600)" },
    idleRead,
    { method: "thread/resume", result: { thread: { id: "thread-1", cwd: "/tmp", status: { type: "idle" } } } },
    { method: "turn/start", result: { turn: { id: "turn-new" } } },
  ]);
  const result = await deliverPrompt(client, options, "event", 0);
  assert.equal(result.mode, "start");
});

test("switches from resume to steer when a turn starts during delivery", async () => {
  const client = new FakeClient([
    idleRead,
    { method: "thread/resume", error: "thread thread-1 already has an active writer (-32600)" },
    activeRead,
    activeTurns,
    { method: "turn/steer", result: { turnId: "turn-active" } },
  ]);
  const result = await deliverPrompt(client, options, "event", 0);
  assert.equal(result.mode, "steer");
});

test("fails clearly when another App Server owns a not-loaded thread", async () => {
  const client = new FakeClient([
    {
      method: "thread/read",
      result: { thread: { id: "thread-1", status: { type: "notLoaded" } } },
    },
    { method: "thread/resume", error: "thread thread-1 already has an active writer (-32600)" },
  ]);
  await assert.rejects(
    deliverPrompt(client, options, "event", 0),
    /active writer outside this managed App Server/,
  );
});

test("rejects a probe response for a different thread identity", async () => {
  const client = new FakeClient([{
    method: "thread/read",
    result: { thread: { id: "thread-other", status: { type: "idle" } } },
  }]);
  await assert.rejects(
    deliverPrompt(client, options, "event", 0),
    /thread-other instead of thread-1/,
  );
});

test("defaults the notifier to the portable proxy transport", async () => {
  assert.deepEqual(await parseArguments([
    "--socket", "/tmp/app.sock",
    "--thread-id", "thread-1",
    "--probe-only",
  ]), {
    socket: "/tmp/app.sock",
    threadId: "thread-1",
    probeOnly: true,
    transport: "proxy",
    codex: "codex",
    waitSeconds: 30,
  });
});

test("encodes masked proxy frames that decode without data loss", async () => {
  const { decodeWebSocketFrames, encodeWebSocketFrame } = await nativeClient;
  const encoded = encodeWebSocketFrame(JSON.stringify({ method: "thread/read" }));
  assert.equal(Boolean(encoded[1] & 0x80), true);
  const decoded = decodeWebSocketFrames(encoded);
  assert.equal(decoded.remainder.length, 0);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].opcode, 1);
  assert.equal(decoded.frames[0].payload.toString("utf8"), '{"method":"thread/read"}');
});

test("retains incomplete proxy frames until the remaining bytes arrive", async () => {
  const { decodeWebSocketFrames, encodeWebSocketFrame } = await nativeClient;
  const encoded = encodeWebSocketFrame("event");
  const partial = decodeWebSocketFrames(encoded.subarray(0, 4));
  assert.equal(partial.frames.length, 0);
  assert.equal(partial.remainder.length, 4);
  const completed = decodeWebSocketFrames(Buffer.concat([partial.remainder, encoded.subarray(4)]));
  assert.equal(completed.frames[0].payload.toString("utf8"), "event");
});
