import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contextGuard, latestContextTokens } from "./context-guard.mjs";
import { POST_TOOL_USE_GUARDS } from "./post-tool-use.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POST_TOOL_USE = path.join(HERE, "post-tool-use.mjs");
const MINUTE = 60_000;
const ORCHESTRATOR_LOAD = JSON.stringify({ type: "user", message: { content: "Base directory for this skill: /plugins/vibe/skills/fleet-orchestrator\n\n# fleet-orchestrator" } });
const WRITER_LOAD = JSON.stringify({ type: "user", message: { content: "Base directory for this skill: /plugins/vibe/skills/vibe\n\n# Vibe" } });

const assistant = (cacheRead, extra = {}) => JSON.stringify({ type: "assistant", ...extra,
  message: { usage: { input_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 990 } } });

function fixture(t, { load = ORCHESTRATOR_LOAD, config } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-context-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fleetHome = path.join(root, "fleet");
  mkdirSync(fleetHome);
  if (config !== undefined) writeFileSync(path.join(fleetHome, "context-guard.json"), typeof config === "string" ? config : JSON.stringify(config));
  const transcript = path.join(root, "transcript.jsonl");
  writeFileSync(transcript, `${load}\n`);
  const env = { HOME: root, FLEET_HOME: fleetHome };
  const event = { hook_event_name: "PostToolUse", session_id: "s-1", transcript_path: transcript, tool_name: "Bash" };
  const request = (tokens) => appendFileSync(transcript, `${assistant(tokens - 1000)}\n`);
  return { root, fleetHome, transcript, env, event, request };
}

test("PostToolUse runs the context guard", () => {
  assert.deepEqual(POST_TOOL_USE_GUARDS.map((guard) => guard.name), ["context-guard"]);
});

test("below the warn threshold the guard is silent", (t) => {
  const { env, event, request } = fixture(t);
  request(199_000);
  assert.equal(contextGuard(event, env, 0), null);
});

test("at the warn threshold the operator gets one line and the model is told to keep its handoff notes current, once", (t) => {
  const { env, event, request, fleetHome } = fixture(t);
  request(200_000);
  const first = contextGuard(event, env, 0);
  assert.match(first.systemMessage, /^Context is 200k tokens per request \(warn at 200k\)/);
  assert.equal(first.systemMessage.split("\n").length, 1);
  assert.match(first.context, /CONTEXT GUARD \(warn\)/);
  assert.ok(first.context.includes(`this chat's own handoff notes current in ${path.join(fleetHome, "HANDOFF-1970-01-01-s-1.md")}`), first.context);
  request(240_000);
  assert.equal(contextGuard(event, env, 60 * MINUTE), null, "a warn is not repeated");
});

test("at the handoff threshold it recommends a handoff, never a stop, and repeats only after the interval", (t) => {
  const { env, event, request } = fixture(t);
  request(320_000);
  const first = contextGuard(event, env, 0);
  assert.match(first.systemMessage, /Context is 320k tokens per request \(handoff recommended at 300k\).*it is your call/);
  assert.match(first.context, /Recommend a handoff to the operator and let them decide; do not stop or pause any work on your own/);
  assert.match(first.context, /"First steps" section that invokes vibe:fleet-orchestrator and vibe:codex-fleet-monitor/);
  assert.match(first.context, /Only after the operator agrees: stop the work this chat owns that a new chat would orphan \(its watcher and delivery loops/);
  assert.equal(contextGuard(event, env, 19 * MINUTE), null);
  const reminder = contextGuard(event, env, 20 * MINUTE);
  assert.match(reminder.systemMessage, /handoff recommended/);
  assert.equal(contextGuard(event, env, 21 * MINUTE), null);
});

test("a drop below warn, as after a compaction, re-arms the warning", (t) => {
  const { env, event, request } = fixture(t);
  request(210_000);
  assert.ok(contextGuard(event, env, 0));
  request(176_000);
  assert.equal(contextGuard(event, env, MINUTE), null);
  request(205_000);
  assert.match(contextGuard(event, env, 2 * MINUTE).systemMessage, /warn at 200k/);
});

test("a session that never loaded fleet-orchestrator stays silent at any size, and so does a subagent's tool call", (t) => {
  const writer = fixture(t, { load: WRITER_LOAD });
  writer.request(900_000);
  assert.equal(contextGuard(writer.event, writer.env, 0), null);
  const orchestrator = fixture(t);
  orchestrator.request(900_000);
  assert.equal(contextGuard({ ...orchestrator.event, agent_id: "agent-1" }, orchestrator.env, 0), null);
  assert.ok(contextGuard(orchestrator.event, orchestrator.env, 0), "the orchestrator's own call still gets it");
});

test("a chat that only mentions or reads fleet-orchestrator, without loading it, stays silent", (t) => {
  const mentions = [
    JSON.stringify({ type: "user", message: { content: "run vibe:fleet-orchestrator later; see plugins/vibe/skills/fleet-orchestrator/SKILL.md" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/plugins/vibe/skills/fleet-orchestrator/SKILL.md" } }] } }),
    JSON.stringify({ type: "user", message: { content: "a tool result quoting {\"skill\": \"vibe:fleet-orchestrator\"}" } }),
  ].join("\n");
  const { env, event, request } = fixture(t, { load: mentions });
  request(900_000);
  assert.equal(contextGuard(event, env, 0), null);
});

test("two chats each get their own handoff file, in the program each runs, never a shared one", (t) => {
  const { env, event, request, fleetHome, transcript } = fixture(t);
  const program = path.join(fleetHome, "programs", "prog-a");
  mkdirSync(program, { recursive: true });
  writeFileSync(path.join(fleetHome, "current"), "prog-a\n");
  request(320_000);
  const day = "2026-11-09";
  const now = Date.parse(`${day}T12:00:00Z`);
  const first = contextGuard(event, env, now);
  const second = contextGuard({ ...event, session_id: "s-2", transcript_path: transcript }, env, now);
  const fileA = path.join(program, `HANDOFF-${day}-s-1.md`);
  const fileB = path.join(program, `HANDOFF-${day}-s-2.md`);
  assert.ok(first.context.includes(`handoff file ${fileA} current, never another chat's`), first.context);
  assert.ok(second.context.includes(`handoff file ${fileB} current`), second.context);
  assert.ok(!first.context.includes(fileB) && !second.context.includes(fileA));
  const otherProgram = path.join(fleetHome, "programs", "prog-b");
  mkdirSync(otherProgram);
  writeFileSync(path.join(fleetHome, "current"), "prog-b\n");
  assert.ok(contextGuard(event, env, now + 20 * MINUTE).context.includes(fileA), "a chat keeps its program's file when the home switches program");
});

test("with no active program a chat's handoff file is in the home, and moves to its program once one starts", (t) => {
  const { env, event, request, fleetHome } = fixture(t);
  request(320_000);
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.ok(contextGuard(event, env, now).context.includes(path.join(fleetHome, "HANDOFF-2026-11-09-s-1.md")));
  mkdirSync(path.join(fleetHome, "programs", "prog-a"), { recursive: true });
  writeFileSync(path.join(fleetHome, "current"), "prog-a\n");
  assert.ok(contextGuard(event, env, now + 20 * MINUTE).context.includes(path.join(fleetHome, "programs", "prog-a", "HANDOFF-2026-11-09-s-1.md")));
});

test("thresholds come from the editable file on every call, with no restart", (t) => {
  const { env, event, request, fleetHome } = fixture(t, { config: { warnContextTokens: 500_000, handoffContextTokens: 600_000 } });
  request(320_000);
  assert.equal(contextGuard(event, env, 0), null);
  writeFileSync(path.join(fleetHome, "context-guard.json"), JSON.stringify({ warnContextTokens: 100_000, handoffContextTokens: 150_000, remindEveryMinutes: 5 }));
  assert.match(contextGuard(event, env, MINUTE).systemMessage, /handoff recommended at 150k/);
  assert.ok(contextGuard(event, env, 6 * MINUTE), "the edited interval applies");
  writeFileSync(path.join(fleetHome, "context-guard.json"), JSON.stringify({ enabled: false }));
  assert.equal(contextGuard(event, env, 60 * MINUTE), null);
});

test("a malformed config or transcript is silent", (t) => {
  for (const config of ["{not json", "[]", JSON.stringify({ warnContextTokens: "lots" }), JSON.stringify({ remindEveryMinutes: -1 }), JSON.stringify({ enabled: "yes" })]) {
    const { env, event, request } = fixture(t, { config });
    request(900_000);
    assert.equal(contextGuard(event, env, 0), null, config);
  }
  const { env, event, transcript } = fixture(t);
  appendFileSync(transcript, "{\"type\":\"assistant\",\"message\":{\"usage\":\n\u0000garbage\n");
  assert.equal(contextGuard(event, env, 0), null);
  assert.equal(contextGuard({ ...event, transcript_path: path.join(path.dirname(transcript), "missing.jsonl") }, env, 0), null);
  assert.equal(contextGuard({ ...event, session_id: "../escape" }, env, 0), null);
  assert.equal(contextGuard(null, env, 0), null);
});

test("the hook script exits 0 with no output on malformed input or config, and prints a PostToolUse notice when due", (t) => {
  const { env, event, request, fleetHome } = fixture(t);
  const run = (input) => spawnSync(process.execPath, [POST_TOOL_USE], { input, encoding: "utf8", env: { ...process.env, ...env } });
  for (const input of ["", "{", "[]", JSON.stringify({ ...event, transcript_path: 7 })]) {
    const result = run(input);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", input);
  }
  request(350_000);
  writeFileSync(path.join(fleetHome, "context-guard.json"), "{broken");
  assert.deepEqual([run(JSON.stringify(event)).status, run(JSON.stringify(event)).stdout], [0, ""]);
  rmSync(path.join(fleetHome, "context-guard.json"));
  const result = run(JSON.stringify(event));
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /^Context is 350k tokens per request/);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /CONTEXT GUARD \(handoff recommended\)/);
});

test("the load check never rereads scanned bytes beyond its small boundary overlap", (t) => {
  const filler = "x".repeat(ORCHESTRATOR_LOAD.length);
  const { env, event, transcript, request } = fixture(t, { load: filler });
  appendFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "y".repeat(16 * 1024) } })}\n`);
  request(900_000);
  assert.equal(contextGuard(event, env, 0), null);
  // Same size, so only a rescan of bytes already read could see a load written over them.
  const before = readFileSync(transcript, "utf8");
  writeFileSync(transcript, before.replace(filler, ORCHESTRATOR_LOAD));
  assert.equal(readFileSync(transcript).length, Buffer.byteLength(before));
  assert.ok(contextGuard({ ...event, session_id: "s-fresh" }, env, MINUTE), "a fresh scan of the same bytes does see the load");
  assert.equal(contextGuard(event, env, MINUTE), null);
  appendFileSync(transcript, `${ORCHESTRATOR_LOAD}\n${assistant(899_000)}\n`);
  assert.ok(contextGuard(event, env, 2 * MINUTE), "an appended load is seen");
});

test("context is input plus cache read plus cache write of the latest main-thread assistant request", (t) => {
  const { transcript } = fixture(t);
  appendFileSync(transcript, [assistant(299_000), assistant(5_000_000, { isSidechain: true }),
    JSON.stringify({ type: "user", message: { content: "a tool result mentioning \"usage\"" } }), ""].join("\n"));
  assert.equal(latestContextTokens(transcript), 300_000);
  appendFileSync(transcript, `${"x".repeat(3 * 1024 * 1024)}\n`);
  assert.equal(latestContextTokens(transcript), 300_000, "a large tool result after the request widens the read window");
});
