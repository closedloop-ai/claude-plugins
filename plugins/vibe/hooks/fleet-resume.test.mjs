import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fleetResume } from "./fleet-resume.mjs";
import { SESSION_START_GUARDS } from "./session-start.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_START = path.join(HERE, "session-start.mjs");

function fleetHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "vibe-fleet-resume-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const program = path.join(home, "programs", "ticket-fixes");
  mkdirSync(program, { recursive: true });
  writeFileSync(path.join(home, "current"), "ticket-fixes\n");
  writeFileSync(path.join(program, "rulings.md"), "- Ruling 2026-10-22 (operator message): design only\n");
  writeFileSync(path.join(program, "resume-log.md"),
    "## 2026-10-22 18:47\n- Pending: operator ruling on how to proceed\n\n## 2026-10-22 18:55\n- Ruling (operator): \"I don't want to build anything yet\"\n- Program: PRD-800 design from scratch\n");
  const transcript = path.join(home, "transcript.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: "Base directory for this skill: /plugins/vibe/skills/fleet-orchestrator" })}\n`);
  return { home, program, transcript };
}

// Two compactions were followed by actions on the summary alone, never the resume log (2026-10-22, 2026-10-26).
test("after a compaction an orchestrator gets the resume reading list and the last resume-log entry", (t) => {
  const { home, program, transcript } = fleetHome(t);
  const event = { hook_event_name: "SessionStart", source: "compact", transcript_path: transcript };
  const context = fleetResume(event, { FLEET_HOME: home })?.context ?? "";
  assert.match(context, /fleet-home\.mjs" resume/);
  assert.ok(context.includes(`READ ${path.join(program, "resume-log.md")}`), context);
  assert.ok(context.includes(`READ ${path.join(program, "rulings.md")}`), context);
  assert.match(context, /## 2026-10-22 18:55\n- Ruling \(operator\): "I don't want to build anything yet"\n- Program: PRD-800 design from scratch/);
  assert.doesNotMatch(context, /Pending: operator ruling on how to proceed/, "only the last entry is quoted");
});

test("it stays silent outside a compaction, outside an orchestrator session and without an active program", (t) => {
  const { home, transcript } = fleetHome(t);
  const env = { FLEET_HOME: home };
  assert.equal(fleetResume({ source: "startup", transcript_path: transcript }, env), null);
  const worker = path.join(home, "worker.jsonl");
  writeFileSync(worker, `${JSON.stringify({ type: "user", message: "fix the table" })}\n`);
  assert.equal(fleetResume({ source: "compact", transcript_path: worker }, env), null);
  assert.equal(fleetResume({ source: "compact" }, env), null);
  writeFileSync(path.join(home, "current"), "");
  assert.equal(fleetResume({ source: "compact", transcript_path: transcript }, env), null);
});

test("the SessionStart hook routes to it, prints the context and is registered for compact", (t) => {
  const { home, transcript } = fleetHome(t);
  assert.ok(SESSION_START_GUARDS.some((guard) => guard.run === fleetResume));
  const result = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ hook_event_name: "SessionStart", source: "compact", transcript_path: transcript }),
    encoding: "utf8", env: { ...process.env, FLEET_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "SessionStart");
  assert.match(output.additionalContext, /fleet-home\.mjs" resume/);
});
