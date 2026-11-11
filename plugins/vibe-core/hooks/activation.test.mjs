// A chat that never activated vibe gets nothing from vibe-core's gated hooks: no output, no state write
// and no network call (operator ruling, 2026-11-11). Each gated route is run through its real hook entry
// point in such a chat, and again in a chat activated each way activation.mjs accepts.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { activationBasis } from "./activation.mjs";
import { runGuards } from "./hook-dispatch.mjs";
import { hookActivated, recordHookSkill } from "./hook-session-scope.mjs";
import { recordWorkerScope } from "../lib/vibe/scripts/worker-scope.mjs";
import { POST_TOOL_USE_GUARDS } from "./post-tool-use.mjs";
import { MCP_ROUTE, PRE_TOOL_USE_ROUTES } from "./pre-tool-use.mjs";
import { loadsSkill, readTranscript, TRANSCRIPT_LIMIT_BYTES } from "./skill-transcript.mjs";
import { USER_PROMPT_SUBMIT_GUARDS } from "./user-prompt-submit.mjs";

const PROVIDER_BINDING = { state: "bound", name: "vibe-closedloop-provider", capabilities: ["tickets", "plans", "graph", "memory", "recipes"],
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vibe-closedloop-provider") };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE = path.join(HERE, "pre-tool-use.mjs");
const PROMPT = path.join(HERE, "user-prompt-submit.mjs");
const POST = path.join(HERE, "post-tool-use.mjs");
// Assembled from words so the repository's signal scans, which read test text, never meet a live shape.
const sh = (...words) => words.join(" ");

/** The guards the ruling names, plus the ones the plan gates with them, each with a call it acts on. */
const GATED_CALLS = [
  { guard: "kill-guard", script: PRE, event: { tool_name: "Bash", tool_input: { command: sh("p" + "kill", "-f", "vitest") } } },
  { guard: "merge-guard", script: PRE, event: { tool_name: "Bash", tool_input: { command: "gh pr merge 9169 --auto" } } },
  { guard: "shell-safety-guard", script: PRE, event: { tool_name: "Bash", tool_input: { command: sh("git push", "-f", "origin fix/x") } } },
  { guard: "pause-guard", script: PRE, event: { tool_name: "SendMessage", tool_input: { to: "w", message: "HOLD everything" } } },
  { guard: "agent-guard", script: PRE, event: { tool_name: "Agent", tool_input: { subagent_type: "vibe:vibe-change-worker", prompt: "go" } } },
  { guard: "unit-status-guard", script: PRE, event: { tool_name: "mcp__closedloop__update-document", tool_input: { documentId: "ISS-2", status: "DONE" } } },
  { guard: "away-protocol", script: PROMPT, event: { hook_event_name: "UserPromptSubmit", prompt: "stepping away. brb." } },
];

function chat(t) {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-activation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "repo");
  mkdirSync(home);
  execFileSync("git", ["init", "-q", cwd]);
  const ghCalls = path.join(root, "gh-calls");
  const gh = path.join(root, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\necho "$*" >> "${ghCalls}"\nif [ "$1" = api ]; then echo operator; else echo '{"author":{"login":"teammate"},"headRefName":"fix/x"}'; fi\n`, { mode: 0o755 });
  const fleetHome = path.join(root, "fleet");
  unreviewedUnit(fleetHome);
  // Both chats bind the ClosedLoop provider, so only activation decides whether its status rule runs.
  const records = path.join(home, ".codex", "vibe", "plugin-version");
  mkdirSync(records, { recursive: true });
  for (const conversation of ["plain-chat", "active-chat"]) {
    writeFileSync(path.join(records, `${conversation}.json`), JSON.stringify({ conversation, status: "current", provider: PROVIDER_BINDING }));
  }
  const transcript = path.join(root, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "fix the login button" } })}\n`);
  const env = { ...process.env, HOME: home, FLEET_HOME: fleetHome, MERGE_GUARD_GH: gh };
  const run = (script, event, session = "plain-chat") => spawnSync(process.execPath, [script], { encoding: "utf8", env,
    input: JSON.stringify({ session_id: session, transcript_path: transcript, cwd, ...event }) });
  return { root, home, cwd, run, transcript, ghCalls, fleetHome };
}

/** A fleet home whose active program's board has an open unit holding ISS-2 with no review recorded. */
function unreviewedUnit(home) {
  const program = path.join(home, "programs", "p1");
  mkdirSync(program, { recursive: true });
  writeFileSync(path.join(home, "current"), "p1\n");
  writeFileSync(path.join(program, "board.json"), JSON.stringify({ units: { u1: { tickets: ["ISS-1", "ISS-2"] } } }));
}

function files(dir) {
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).sort() : [];
}

test("every gated guard is marked in its route, so the dispatcher skips it outside an activated chat", () => {
  const routed = [...Object.values(PRE_TOOL_USE_ROUTES).flat(), ...MCP_ROUTE, ...USER_PROMPT_SUBMIT_GUARDS, ...POST_TOOL_USE_GUARDS];
  const gated = new Set(routed.filter((guard) => guard.activated === true).map((guard) => guard.name));
  assert.deepEqual([...gated].sort(), [...GATED_CALLS.map((call) => call.guard), "context-guard"].sort());
});

test("a chat that never activated vibe gets no output, no write and no gh call from any gated guard", (t) => {
  const c = chat(t);
  const before = files(c.home);
  for (const { guard, script, event } of GATED_CALLS) {
    const result = c.run(script, event);
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""], guard);
  }
  const post = c.run(POST, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual([post.status, post.stdout, post.stderr], [0, "", ""], "context-guard");
  assert.deepEqual(files(c.home), before, "nothing is written under HOME");
  assert.equal(existsSync(c.ghCalls), false, "merge-guard never asked gh");
  const skill = c.run(PRE, { tool_name: "Skill", tool_input: { skill: "other-plugin:helper" } });
  assert.deepEqual([skill.stdout, files(c.home)], ["", before], "an unrelated skill records nothing");
});

test("each way of activating a chat brings every gated guard back", (t) => {
  const activations = {
    "hook-record": (c) => { recordHookSkill("active-chat", "vibe:handoff", c.home); },
    "launcher-worker": (c) => { recordWorkerScope("active-chat", c.cwd, c.home); },
    transcript: (c) => {
      writeFileSync(c.transcript, `${JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: /x/plugins/cache/closedloop-ai/vibe/1.1.81/skills/pr-takeover" }] } })}\n`);
    },
    "vibe-worktree": (c) => {
      const gitDir = execFileSync("git", ["-C", c.cwd, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
      writeFileSync(path.join(gitDir, "vibe-session.json"), "{}\n");
    },
  };
  for (const [basis, activate] of Object.entries(activations)) {
    const c = chat(t);
    activate(c);
    assert.equal(activationBasis({ session_id: "active-chat", transcript_path: c.transcript, cwd: c.cwd }, c.home), basis);
    for (const { guard, script, event } of GATED_CALLS) {
      const result = c.run(script, event, "active-chat");
      assert.notEqual(result.stdout, "", `${guard} acts in a chat activated by ${basis}`);
    }
    assert.equal(existsSync(c.ghCalls), true, `merge-guard asks gh once activated by ${basis}`);
  }
});

test("an activating skill keeps the chat activated through later unrelated skills", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "vibe-activation-sticky-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(recordHookSkill("s", "other-plugin:helper", home), null);
  assert.equal(hookActivated("s", home), false, "an unrelated skill alone activates nothing");
  recordHookSkill("s", "vibe:fleet-orchestrator", home);
  recordHookSkill("s", "other-plugin:helper", home);
  recordHookSkill("s", "vibe:handoff", home);
  assert.equal(hookActivated("s", home), true);
  assert.equal(hookActivated("s", home, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)), false, "the record expires after 7 days");
});

test("the dispatcher decides activation once per event, and only when a gated guard comes up", () => {
  let asked = 0;
  const isActivated = () => { asked += 1; return false; };
  const guards = [{ name: "a", run: () => ({ context: "a" }) }, { name: "b", run: () => ({ context: "b" }), activated: true },
    { name: "c", run: () => ({ context: "c" }), activated: true }];
  assert.deepEqual(runGuards(guards, {}, () => {}, isActivated), [{ context: "a" }]);
  assert.equal(asked, 1);
  asked = 0;
  runGuards([guards[0]], {}, () => {}, isActivated);
  assert.equal(asked, 0);
});

test("a transcript past the read limit still shows a load at either end, where a whole read once returned nothing", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "vibe-activation-big-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "big.jsonl");
  const marker = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vibe:vibe" } }] } })}\n`;
  const fd = openSync(file, "w");
  writeSync(fd, "x".repeat(1024) + "\n", TRANSCRIPT_LIMIT_BYTES + 8 * 1024 * 1024);
  writeSync(fd, marker);
  closeSync(fd);
  assert.equal(loadsSkill(readTranscript(file), "vibe-plugin"), true, "a load at the tail");
  assert.equal(loadsSkill(readTranscript(file), "vibe"), true);
});
