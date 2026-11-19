import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { CONFIRM_RENDERS, FrozenOutcome, frozenRenders } from "./frozen-render.mjs";
import { BASE, BLUE, fakeBrowser, GREY, HEAD, passes, sandbox, shot, throws } from "./frozen-render-test-fixture.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

bindProviderInProcess(after);

const flaky = throws("Unable to find an accessible element with the role \"grid\"", shot(GREY));

/** One story rendered against a passing grey base, with `head` as its branch plays, render by render. */
async function judge(t, head) {
  const { out } = sandbox(t);
  const browser = fakeBrowser({ [BASE]: { "a--story": passes(shot(GREY)) }, [HEAD]: { "a--story": head } });
  const summary = await frozenRenders({ ids: ["a--story"], fileCount: 1, baseUrl: BASE, headUrl: HEAD, browser, out, command: "frozen-render.mjs" });
  const [story] = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  return { summary, story, sides: browser.visits.map((visit) => (visit.origin === BASE ? "base" : "head")) };
}

test("a branch play failure the branch does not reproduce in its confirmation renders does not block (ISS-14395)", async (t) => {
  const { summary, story, sides } = await judge(t, [flaky, passes(shot(GREY))]);
  assert.equal(summary.ok, true);
  assert.equal(story.outcome, FrozenOutcome.Identical);
  assert.equal(story.headConfirmRenders, CONFIRM_RENDERS);
  assert.match(story.reason, /the branch's first play \(FAIL: storyThrewException fired: Unable to find an accessible element with the role "grid"\) did not reproduce in 2 more branch renders$/);
  assert.deepEqual(sides, ["base", "head", "base", "base", "base", "head", "head"], "each confirmation render is counted");
  assert.deepEqual(Object.keys(story.renders), ["base", "base-again", "head", "base-confirm-1", "base-confirm-2", "head-confirm-1", "head-confirm-2"]);
});

test("a branch play failure that reproduces blocks, every time or only some of the time", async (t) => {
  for (const head of [flaky, [flaky, passes(shot(GREY)), flaky], [flaky, flaky, passes(shot(GREY))]]) {
    const { summary, story } = await judge(t, head);
    assert.equal(summary.ok, false, JSON.stringify(head));
    assert.equal(story.outcome, FrozenOutcome.Blocking);
    assert.match(story.reason, /^play PASS on the base, FAIL on the branch/);
    assert.equal(story.headConfirmRenders, CONFIRM_RENDERS);
  }
});

test("a branch whose failure does not reproduce still blocks when its passing render changed", async (t) => {
  const { summary, story } = await judge(t, [flaky, passes(shot(BLUE))]);
  assert.equal(summary.ok, false);
  assert.match(story.reason, /^the render changed; the branch's first play \(FAIL: .*\) did not reproduce in 2 more branch renders$/);
});

test("a changed render with the base's own play outcome gets no branch confirmation renders", async (t) => {
  const { summary, story, sides } = await judge(t, passes(shot(BLUE)));
  assert.equal(summary.ok, false);
  assert.equal(story.headConfirmRenders, undefined);
  assert.deepEqual(sides, ["base", "head", "base", "base", "base"]);
});
