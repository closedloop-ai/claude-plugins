import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness, harnessActor, harnessOfCommand, processAncestry } from "./harness-identity.mjs";

const CLAUDE_ID = "1bc84ae5-e27b-4e2c-b779-34be38c3a70b";
const CODEX_ID = "01a1b313-e78f-7951-afd9-b55267389d9b";
// A Codex thread whose App Server was started from a Claude Code chat (ISS-13834).
const INHERITED = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_THREAD_ID: CODEX_ID };
const CODEX_DAEMON = "/opt/codex/releases/0.167.0/bin/codex app-server --listen unix:// --managed-daemon";
const CLAUDE_CLI = "/opt/claude/versions/2.1.319 --permission-mode auto";

test("a Codex thread that inherited a Claude session id acts as its own thread", () => {
  assert.deepEqual(harnessActor(INHERITED, { ancestry: () => ["/bin/zsh -lc node x.mjs", CODEX_DAEMON, CLAUDE_CLI] }),
    { runtime: Harness.Codex, id: CODEX_ID });
});

test("with both ids and no readable ancestry the Codex thread wins", () => {
  assert.deepEqual(harnessActor(INHERITED, { ancestry: () => [] }), { runtime: Harness.Codex, id: CODEX_ID });
});

test("a Claude Code process started under Codex acts as its own Claude session", () => {
  assert.deepEqual(harnessActor(INHERITED, { ancestry: () => ["/bin/zsh -c node x.mjs", CLAUDE_CLI, CODEX_DAEMON] }),
    { runtime: Harness.Claude, id: CLAUDE_ID });
});

test("one valid id decides alone, and neither means no harness", () => {
  const never = () => assert.fail("ancestry is read only when both ids are set");
  assert.deepEqual(harnessActor({ CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CODEX_THREAD_ID: "" }, { ancestry: never }), { runtime: Harness.Claude, id: CLAUDE_ID });
  assert.deepEqual(harnessActor({ CODEX_THREAD_ID: CODEX_ID, CLAUDE_CODE_SESSION_ID: "bad id!" }, { ancestry: never }), { runtime: Harness.Codex, id: CODEX_ID });
  assert.equal(harnessActor({ CLAUDECODE: "1" }, { ancestry: never }), null);
});

test("harness commands are recognized by executable, not by a mention in arguments", () => {
  assert.equal(harnessOfCommand(CODEX_DAEMON), Harness.Codex);
  assert.equal(harnessOfCommand("/opt/codex/bin/codex-code-mode-host"), Harness.Codex);
  assert.equal(harnessOfCommand("node /usr/lib/node_modules/@openai/codex/bin/codex.js"), Harness.Codex);
  assert.equal(harnessOfCommand(CLAUDE_CLI), Harness.Claude);
  assert.equal(harnessOfCommand("/usr/local/bin/claude -p hi"), Harness.Claude);
  assert.equal(harnessOfCommand("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), Harness.Claude);
  assert.equal(harnessOfCommand("/bin/zsh -c codex exec hi"), null);
  assert.equal(harnessOfCommand("grep claude notes.txt"), null);
});

test("an unreadable ps leaves no ancestry, and the Codex thread then wins", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-ps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const refused = path.join(dir, "ps");
  writeFileSync(refused, "#!/bin/sh\necho 'ps: Operation not permitted' >&2\nexit 1\n");
  chmodSync(refused, 0o755);
  assert.deepEqual(processAncestry(process.ppid, { ps: refused }), []);
  assert.deepEqual(processAncestry(process.ppid, { ps: path.join(dir, "missing") }), []);
  assert.deepEqual(harnessActor(INHERITED, { ancestry: () => processAncestry(process.ppid, { ps: refused }) }), { runtime: Harness.Codex, id: CODEX_ID });
});

test("the real ancestry walk reads this process's parents", () => {
  const ancestry = processAncestry();
  assert.ok(ancestry.length > 0);
  assert.ok(ancestry.every((command) => typeof command === "string" && command !== ""));
});
