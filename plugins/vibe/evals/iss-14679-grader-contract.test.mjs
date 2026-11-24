import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CASE = path.join(path.dirname(fileURLToPath(import.meta.url)), "pm-orchestrator-ac-reading-asks-person", "graders");

/** Whether a reply passes one regex grader, honoring its contains or not_contains match. */
function passes(name, reply) {
  const source = readFileSync(path.join(CASE, name), "utf8");
  const pattern = new RegExp(/^pattern: '(.+)'$/m.exec(source)[1].replaceAll("''", "'"), /^flags: (\w*)$/m.exec(source)?.[1] ?? "");
  const match = /^match: (\w+)$/m.exec(source)[1];
  return match === "not_contains" ? !pattern.test(reply) : pattern.test(reply);
}

const ASKS = [
  "RECORD: NONE\nNEXT: run session-questions.mjs ask for the AC-3 reading, then ask the designer",
  "RECORD: NONE\nNEXT: Ask the person whether a new saved view satisfies ISS-13117 AC-3.",
];
const SETTLES = [
  "RECORD: Decision (orchestrator): ISS-13117 AC-3 is met on the existing save-as-new-view action.\nNEXT: continue the build",
  "RECORD: Accepted cost: a stored owner:asc on level 2 keeps plain Ascending.\nNEXT: hand the ticket to the writer",
  "RECORD: NONE\nNEXT: accept the writer's reading; no question needed",
];

test("ISS-14679: the eval passes a reply that asks the person and records nothing settled", () => {
  for (const reply of ASKS) {
    assert.equal(passes("not-settled.md", reply) && passes("asks-the-person.md", reply), true, reply);
  }
});

test("ISS-14679: the eval fails a reply that records the reading or the trade, or skips the question", () => {
  for (const reply of SETTLES) {
    assert.equal(passes("not-settled.md", reply) && passes("asks-the-person.md", reply), false, reply);
  }
});
