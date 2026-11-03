import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PLAY_EVENT_RECORDER, playVerdictProblems, playVerdicts } from "./story-play-verdict.mjs";
import { makeHome } from "./test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "story-play-verdict.mjs");

/** A Storybook-like channel: the story's play runs, and storyFinished reports success even when the play threw. */
function storybookRun(plays) {
  const listeners = new Map();
  const channel = { on: (type, handler) => listeners.set(type, [...(listeners.get(type) ?? []), handler]) };
  const emit = (type, payload) => (listeners.get(type) ?? []).forEach((handler) => handler(payload));
  const window = { __STORYBOOK_ADDONS_CHANNEL__: channel };
  vm.runInNewContext(PLAY_EVENT_RECORDER, { window, setTimeout });
  for (const [storyId, play] of Object.entries(plays)) {
    try {
      play();
    } catch {
      emit("playFunctionThrewException", { storyId });
    }
    emit("storyFinished", { storyId, status: "success" });
  }
  return window.__vibePlayEvents;
}

test("a play that throws is FAIL even though storyFinished reports success", () => {
  const events = storybookRun({
    "board--drag": () => {
      throw new Error("expected 1 drag, saw 0");
    },
    "board--default": () => {},
  });
  assert.ok(events.some((event) => event.type === "storyFinished" && event.storyId === "board--drag" && event.status === "success"));
  assert.deepEqual(playVerdicts(events, ["board--drag", "board--default"]).map(({ storyId, verdict }) => [storyId, verdict]), [
    ["board--drag", "FAIL"],
    ["board--default", "PASS"],
  ]);
});

test("a story with no observed completion is FAIL, and an unjudged or failing storybook-plays run blocks the evidence", () => {
  assert.deepEqual(playVerdicts([], ["board--late"]), [{ storyId: "board--late", verdict: "FAIL", reason: "no completion was observed" }]);
  assert.match(playVerdictProblems({ lane: "storybook-plays" })[0], /no playVerdicts/);
  assert.deepEqual(playVerdictProblems({ playVerdicts: [{ storyId: "a", verdict: "FAIL", reason: "storyErrored fired" }] }), ["storybook-plays: a is FAIL (storyErrored fired)"]);
  assert.deepEqual(playVerdictProblems({ playVerdicts: [{ storyId: "a", verdict: "PASS" }] }), []);
});

test("the command exits 1 when any play is not PASS", (t) => {
  const { root, cleanup } = makeHome("story-play-verdict-");
  t.after(cleanup);
  const events = path.join(root, "events.jsonl");
  writeFileSync(events, `${JSON.stringify({ type: "storyThrewException", storyId: "x" })}\n${JSON.stringify({ type: "storyFinished", storyId: "x", status: "success" })}\n`);
  const result = spawnSync(process.execPath, [SCRIPT, "--events", events, "--story", "x"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).verdicts[0].verdict, "FAIL");
});
