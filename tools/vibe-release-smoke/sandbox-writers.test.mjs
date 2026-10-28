import assert from "node:assert/strict";
import test from "node:test";
import { assessSandboxWriters, escalationIn, sandboxWriters } from "./sandbox-writers.mjs";

const writers = sandboxWriters({ scripts: "/p", repo: "/r", head: "a".repeat(40) });
const asked = (writer) => ({ stdout: `{"check":"node","ok":true}\n${JSON.stringify({ escalate: true, justification: writer.justification, error: "EPERM" })}\n` });

test("every writer asks for an escalated rerun in the sandbox and does its job escalated (ISS-13321)", () => {
  const passing = writers.map((writer) => ({ writer, sandboxed: asked(writer), escalated: writer.escalated ? { stdout: '{"ok":true}\n' } : undefined }));
  assert.deepEqual(assessSandboxWriters(passing), []);
  assert.equal(escalationIn('{"ok":false,"error":"EACCES"}'), null);
});

test("a swallowed or generic refusal, a wrong justification or a still-refused escalated run fails", () => {
  const [preflight, questions, , lock] = writers;
  assert.deepEqual(assessSandboxWriters([{ writer: questions, sandboxed: { stdout: '{"ok":false,"error":"EPERM: operation not permitted"}' }, escalated: { stdout: "{}" } }]),
    ["session-questions.mjs: the sandbox refused its write and it did not ask for an escalated rerun"]);
  assert.match(assessSandboxWriters([{ writer: preflight, sandboxed: { stdout: '{"escalate":true,"justification":"other"}' }, escalated: { stdout: "" } }]).join(), /justification "other"/);
  assert.match(assessSandboxWriters([{ writer: lock, sandboxed: asked(lock), escalated: asked(lock) }]).join(), /still asked to escalate/);
});
