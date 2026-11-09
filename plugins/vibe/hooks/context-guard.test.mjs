import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compactionInstructions, contextGuard, latestContextTokens } from "./context-guard.mjs";
import { recordHookSkill } from "./hook-session-scope.mjs";
import { POST_TOOL_USE_GUARDS } from "./post-tool-use.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POST_TOOL_USE = path.join(HERE, "post-tool-use.mjs");
const PRE_COMPACT = path.join(HERE, "pre-compact.mjs");
const WINDOW_VARIABLE = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const ORCHESTRATOR_LOAD = JSON.stringify({ type: "user", isMeta: true, message: { content: [{ type: "text", text: "Base directory for this skill: /plugins/vibe/skills/fleet-orchestrator\n\n# fleet-orchestrator" }] } });
const ORCHESTRATOR_SKILL_CALL = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vibe:fleet-orchestrator" } }] } });
const WRITER_LOAD = JSON.stringify({ type: "user", isMeta: true, message: { content: "Base directory for this skill: /plugins/vibe/skills/vibe\n\n# Vibe" } });

const assistant = (cacheRead, extra = {}) => JSON.stringify({ type: "assistant", ...extra,
  message: { usage: { input_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 990 } } });

function fixture(t, { load = ORCHESTRATOR_LOAD, config, window, program = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "vibe-context-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fleetHome = path.join(root, "fleet");
  mkdirSync(fleetHome);
  if (program) {
    mkdirSync(path.join(fleetHome, "programs", "prog-a"), { recursive: true });
    writeFileSync(path.join(fleetHome, "current"), "prog-a\n");
  }
  if (config !== undefined) writeFileSync(path.join(fleetHome, "context-guard.json"), typeof config === "string" ? config : JSON.stringify(config));
  const transcript = path.join(root, "transcript.jsonl");
  writeFileSync(transcript, `${load}\n`);
  const env = { HOME: root, FLEET_HOME: fleetHome, ...(window === undefined ? {} : { [WINDOW_VARIABLE]: window }) };
  const event = { hook_event_name: "PostToolUse", session_id: "s-1", transcript_path: transcript, tool_name: "Bash" };
  const request = (tokens) => appendFileSync(transcript, `${assistant(tokens - 1000)}\n`);
  return { root, fleetHome, transcript, env, event, request };
}

function runScript(script, input, env) {
  const childEnv = { ...process.env, ...env };
  if (!Object.hasOwn(env, WINDOW_VARIABLE)) Reflect.deleteProperty(childEnv, WINDOW_VARIABLE);
  return spawnSync(process.execPath, [script], { input, encoding: "utf8", env: childEnv });
}

test("PostToolUse runs the context guard", () => {
  assert.deepEqual(POST_TOOL_USE_GUARDS.map((guard) => guard.name), ["context-guard"]);
});

test("launched without the window variable, the operator is told once how to relaunch with the file's window", (t) => {
  const { env, event, request, fleetHome } = fixture(t);
  request(50_000);
  const first = contextGuard(event, env);
  assert.equal(first.systemMessage, `This fleet-orchestrator chat has no usable ${WINDOW_VARIABLE}, so it compacts where Claude Code's own settings put it. To compact at 300k (set in ${path.join(fleetHome, "context-guard.json")}), relaunch it with: ${WINDOW_VARIABLE}=300000 claude --resume s-1`);
  assert.equal(first.context, undefined, "below the flush point there is nothing to flush");
  request(60_000);
  assert.equal(contextGuard(event, env), null, "the notice is not repeated");
});

test("launched with the window variable, there is no notice", (t) => {
  for (const window of ["300000", "300k", "0.3M"]) {
    const { env, event, request } = fixture(t, { window });
    request(50_000);
    assert.equal(contextGuard(event, env), null, window);
  }
});

test("at flushAtPercent of the window the model is told once per compaction cycle to bring the state files current", (t) => {
  const { env, event, request, fleetHome } = fixture(t, { window: "400k" });
  const program = path.join(fleetHome, "programs", "prog-a");
  mkdirSync(program, { recursive: true });
  writeFileSync(path.join(fleetHome, "current"), "prog-a\n");
  request(339_000);
  assert.equal(contextGuard(event, env), null, "below 85% of 400k");
  request(341_000);
  const flush = contextGuard(event, env);
  assert.equal(flush.systemMessage, undefined);
  assert.match(flush.context, /^CONTEXT GUARD \(flush\): this chat re-reads about 341k tokens per request and compacts at about 400k\./);
  assert.ok(flush.context.includes(`program state files in ${program} current (rulings.md, attention.md, resume-log.md, board.md)`), flush.context);
  request(380_000);
  assert.equal(contextGuard(event, env), null, "once per cycle");
  request(120_000);
  assert.equal(contextGuard(event, env), null, "a compaction re-arms it");
  request(345_000);
  assert.match(contextGuard(event, env).context, /CONTEXT GUARD \(flush\)/);
});

test("with no window variable the flush names no compaction point and repeats at each step of growth", (t) => {
  const { env, event, request } = fixture(t);
  request(50_000);
  assert.ok(contextGuard(event, env).systemMessage, "the one window notice");
  request(256_000);
  const flush = contextGuard(event, env).context;
  assert.match(flush, /^CONTEXT GUARD \(flush\): this chat re-reads about 256k tokens per request and has no usable CLAUDE_CODE_AUTO_COMPACT_WINDOW, so it compacts where Claude Code's own settings put it; this repeats every 45k of growth\./);
  assert.ok(!flush.includes("compacts at about"), flush);
  request(300_000);
  assert.equal(contextGuard(event, env), null, "less than 45k since the last flush");
  request(301_000);
  assert.match(contextGuard(event, env).context, /about 301k tokens/);
  request(950_000);
  assert.match(contextGuard(event, env).context, /about 950k tokens/, "still prompted near Claude Code's own compaction point");
  request(120_000);
  assert.equal(contextGuard(event, env), null, "a compaction re-arms it");
  request(260_000);
  assert.match(contextGuard(event, env).context, /about 260k tokens/);
});

test("with no active program there are no state files, so neither hook names them", (t) => {
  const { env, event, request } = fixture(t, { program: false, window: "300k" });
  request(290_000);
  assert.equal(contextGuard(event, env), null);
  assert.equal(compactionInstructions({ ...event, hook_event_name: "PreCompact" }, env), null);
});

test("the limits come from the editable file on every call, with no restart", (t) => {
  const { env, event, request, fleetHome } = fixture(t, { config: { compactWindowTokens: 500_000 } });
  request(300_000);
  assert.match(contextGuard(event, env).systemMessage, /To compact at 500k .* relaunch it with: CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000 claude --resume s-1$/);
  writeFileSync(path.join(fleetHome, "context-guard.json"), JSON.stringify({ compactWindowTokens: 300_000, flushAtPercent: 90 }));
  assert.match(contextGuard(event, env).context, /this repeats every 30k of growth/, "300k is past 90% of the edited 300k window, and the step is the edited 10%");
  writeFileSync(path.join(fleetHome, "context-guard.json"), JSON.stringify({ enabled: false }));
  request(120_000);
  request(290_000);
  assert.equal(contextGuard(event, env), null);
});

test("PreCompact in a fleet-orchestrator chat prints instructions that leave the state files out of the summary", (t) => {
  const { env, event, fleetHome } = fixture(t);
  const program = path.join(fleetHome, "programs", "prog-a");
  mkdirSync(program, { recursive: true });
  writeFileSync(path.join(fleetHome, "current"), "prog-a\n");
  const preCompact = { ...event, hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null };
  const text = compactionInstructions(preCompact, env);
  for (const name of ["rulings.md", "attention.md", "resume-log.md", "board.md"]) assert.ok(text.includes(path.join(program, name)), name);
  assert.match(text, /Do not restate what those files hold/);
  assert.match(text, /every question to the operator that is still open/);
  assert.match(text, /every operator ruling not yet written to rulings\.md/);
  assert.match(text, /the name of every live worker, session, watcher and background job/);
  assert.match(text, /every promise made to the operator that is not yet kept/);
  assert.ok(text.length < 10_000, "under Claude Code's per-hook cap");
  const result = runScript(PRE_COMPACT, JSON.stringify(preCompact), env);
  assert.deepEqual([result.status, result.stdout], [0, `${text}\n`], result.stderr);
  for (const load of [WRITER_LOAD, JSON.stringify({ type: "user", message: { content: "quote <name>vibe:fleet-orchestrator</name>" } })]) {
    const other = fixture(t, { load });
    assert.equal(compactionInstructions({ ...other.event, hook_event_name: "PreCompact" }, other.env), null);
    assert.deepEqual([runScript(PRE_COMPACT, JSON.stringify(other.event), other.env).stdout], [""]);
  }
});

test("a session that never loaded fleet-orchestrator stays silent at any size, and so does a subagent's tool call", (t) => {
  const writer = fixture(t, { load: WRITER_LOAD });
  writer.request(900_000);
  assert.equal(contextGuard(writer.event, writer.env), null);
  const orchestrator = fixture(t);
  orchestrator.request(900_000);
  assert.equal(contextGuard({ ...orchestrator.event, agent_id: "agent-1" }, orchestrator.env), null);
  assert.equal(compactionInstructions({ ...orchestrator.event, agent_id: "agent-1" }, orchestrator.env), null);
  assert.ok(contextGuard(orchestrator.event, orchestrator.env), "the orchestrator's own call still gets it");
});

test("a chat that only mentions, quotes or reads fleet-orchestrator, without loading it, stays silent", (t) => {
  const mentions = [
    JSON.stringify({ type: "user", message: { content: "run vibe:fleet-orchestrator later; see plugins/vibe/skills/fleet-orchestrator/SKILL.md" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/plugins/vibe/skills/fleet-orchestrator/SKILL.md" } }] } }),
    JSON.stringify({ type: "user", message: { content: "a tool result quoting {\"skill\": \"vibe:fleet-orchestrator\"}" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "grep -n '<name>vibe:fleet-orchestrator</name>' t.jsonl" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "printf '%s\\n' \"x\"\nBase directory for this skill: /plugins/vibe/skills/fleet-orchestrator\n" } }] } }),
    JSON.stringify({ type: "user", message: { content: "Base directory for this skill: /plugins/vibe/skills/fleet-orchestrator\nand <name>vibe:fleet-orchestrator</name>" } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vibe:fleet-orchestrator" } }] } }),
  ].join("\n");
  const { env, event, request } = fixture(t, { load: mentions });
  request(900_000);
  assert.equal(contextGuard(event, env), null);
  assert.equal(compactionInstructions(event, env), null);
});

test("a Claude Code chat whose prompt only mentions $fleet-orchestrator stays silent, though the prompt hook recorded the skill", (t) => {
  const mention = JSON.stringify({ type: "user", message: { content: "$fleet-orchestrator hooks look slow here, can you profile them?" } });
  const { env, event, request, root } = fixture(t, { load: mention });
  recordHookSkill(event.session_id, "vibe:fleet-orchestrator", root);
  request(900_000);
  assert.equal(contextGuard(event, env), null);
  assert.equal(compactionInstructions(event, env), null);
});

test("a malformed config or transcript is silent", (t) => {
  for (const config of ["{not json", "[]", JSON.stringify({ compactWindowTokens: "lots" }), JSON.stringify({ compactWindowTokens: 50_000 }),
    JSON.stringify({ flushAtPercent: 120 }), JSON.stringify({ enabled: "yes" })]) {
    const { env, event, request } = fixture(t, { config });
    request(900_000);
    assert.equal(contextGuard(event, env), null, config);
    assert.equal(compactionInstructions(event, env), null, config);
  }
  const { env, event, transcript } = fixture(t, { window: "300k" });
  appendFileSync(transcript, "{\"type\":\"assistant\",\"message\":{\"usage\":\n\u0000garbage\n");
  assert.equal(contextGuard(event, env), null);
  assert.equal(contextGuard({ ...event, transcript_path: path.join(path.dirname(transcript), "missing.jsonl") }, env), null);
  assert.equal(contextGuard({ ...event, session_id: "../escape" }, env), null);
  assert.equal(contextGuard(null, env), null);
  assert.equal(compactionInstructions(null, env), null);
});

test("both hook scripts exit 0 with no output on malformed input or config, and print when due", (t) => {
  const { env, event, request, fleetHome } = fixture(t);
  for (const script of [POST_TOOL_USE, PRE_COMPACT]) {
    for (const input of ["", "{", "[]", JSON.stringify({ ...event, transcript_path: 7 })]) {
      const result = runScript(script, input, env);
      assert.deepEqual([result.status, result.stdout], [0, ""], `${path.basename(script)} ${input}`);
    }
  }
  request(350_000);
  writeFileSync(path.join(fleetHome, "context-guard.json"), "{broken");
  for (const script of [POST_TOOL_USE, PRE_COMPACT]) assert.deepEqual([runScript(script, JSON.stringify(event), env).status, runScript(script, JSON.stringify(event), env).stdout], [0, ""]);
  rmSync(path.join(fleetHome, "context-guard.json"));
  const result = runScript(POST_TOOL_USE, JSON.stringify(event), env);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.match(output.systemMessage, /relaunch it with: CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 claude --resume s-1$/);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /CONTEXT GUARD \(flush\)/);
});

test("a Skill tool call of vibe:fleet-orchestrator counts as a load", (t) => {
  const { env, event, request } = fixture(t, { load: ORCHESTRATOR_SKILL_CALL });
  request(900_000);
  assert.ok(contextGuard(event, env));
});

test("a load line still being written is read whole on the next call", (t) => {
  const { env, event, transcript, request } = fixture(t, { load: "" });
  request(900_000);
  const half = Math.floor(ORCHESTRATOR_LOAD.length / 2);
  appendFileSync(transcript, ORCHESTRATOR_LOAD.slice(0, half));
  assert.equal(contextGuard(event, env), null);
  appendFileSync(transcript, `${ORCHESTRATOR_LOAD.slice(half)}\n`);
  assert.ok(contextGuard(event, env));
});

test("the load check never rereads scanned bytes", (t) => {
  const filler = "x".repeat(ORCHESTRATOR_LOAD.length);
  const { env, event, transcript, request } = fixture(t, { load: filler });
  appendFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "y".repeat(16 * 1024) } })}\n`);
  request(900_000);
  assert.equal(contextGuard(event, env), null);
  // Same size, so only a rescan of bytes already read could see a load written over them.
  const before = readFileSync(transcript, "utf8");
  writeFileSync(transcript, before.replace(filler, ORCHESTRATOR_LOAD));
  assert.equal(readFileSync(transcript).length, Buffer.byteLength(before));
  assert.ok(contextGuard({ ...event, session_id: "s-fresh" }, env), "a fresh scan of the same bytes does see the load");
  assert.equal(contextGuard(event, env), null);
  appendFileSync(transcript, `${ORCHESTRATOR_LOAD}\n${assistant(899_000)}\n`);
  assert.ok(contextGuard(event, env), "an appended load is seen");
});

test("context is input plus cache read plus cache write of the latest main-thread assistant request", (t) => {
  const { transcript } = fixture(t);
  appendFileSync(transcript, [assistant(299_000), assistant(5_000_000, { isSidechain: true }),
    JSON.stringify({ type: "user", message: { content: "a tool result mentioning \"usage\"" } }), ""].join("\n"));
  assert.equal(latestContextTokens(transcript), 300_000);
  appendFileSync(transcript, `${"x".repeat(3 * 1024 * 1024)}\n`);
  assert.equal(latestContextTokens(transcript), 300_000, "a large tool result after the request widens the read window");
});
