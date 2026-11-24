import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyStory, FrozenOutcome, frozenRenders } from "./frozen-render.mjs";
import { BASE, BLUE, fakeBrowser, GREY, HEAD, passes, sandbox, shot, throws } from "./frozen-render-test-fixture.mjs";

const NOW = "2026-11-19T12:00:00.000Z";
const CANDIDATE = "a--candidate";
const NEIGHBOR = "b--neighbor";
const base = passes(shot(GREY));
const changed = passes(shot(BLUE));
const focus = throws("expect(element).toHaveFocus()", shot(BLUE));
const addSession = throws("Unable to find the Add session button", shot(GREY));
const visibleView = throws("expect(Default view).toBeVisible()", shot(BLUE));

/** Exercises the public comparison with two workers and returns its written serial evidence. */
async function compare(t, { head, baseline = base, pullContext = null, parallel = true }) {
  const { out } = sandbox(t);
  const primary = fakeBrowser({ [BASE]: { [CANDIDATE]: baseline }, [HEAD]: { [CANDIDATE]: head } });
  const neighbor = fakeBrowser({ [BASE]: { [NEIGHBOR]: base }, [HEAD]: { [NEIGHBOR]: base } });
  const primaryContext = primary.newContext;
  let context = 0;
  const checkCache = { calls: [], get(id) { this.calls.push(id); return null; }, set() {} };
  if (pullContext) primary.newContext = (...args) => pullContext(++context, () => primaryContext(...args));
  const result = await frozenRenders({
    ids: parallel ? [CANDIDATE, NEIGHBOR] : [CANDIDATE], fileCount: 1,
    browser: primary, browsers: parallel ? [primary, neighbor] : [primary], baseUrl: BASE, headUrl: HEAD,
    out, now: NOW, command: "frozen-render.mjs", base: "a".repeat(40), head: "b".repeat(40), baseCache: checkCache,
  });
  const [story] = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  return { result, story, checkCache, primary, neighbor };
}

test("ISS-14476 isolates parallel head pixel drift and preserves the original named crop", async (t) => {
  const { result, story, checkCache, primary, neighbor } = await compare(t, {
    head: [changed, base, base],
  });
  assert.equal(result.ok, true);
  assert.equal(story.outcome, FrozenOutcome.Identical);
  const proof = story.parallelConfirmation;
  assert.equal(proof.accepted, true);
  assert.equal(proof.parallel.reason, "the render changed");
  assert.ok(existsSync(proof.parallel.crop));
  assert.deepEqual(checkCache.calls, [CANDIDATE, NEIGHBOR]);
  assert.deepEqual(primary.visits.slice(-4).map(({ origin }) => origin), [BASE, HEAD, BASE, HEAD]);
  assert.ok([...primary.visits, ...neighbor.visits].every((visit) => visit.closed && visit.clock === NOW));
  for (const { directory } of proof.controls) {
    assert.ok(existsSync(path.join(directory, "base", CANDIDATE + ".png")));
    assert.ok(existsSync(path.join(directory, "head", CANDIDATE + ".png")));
  }
});

test("ISS-14476 retains an observed head failure despite two wholly successful serial pairs", async (t) => {
  const { result, story } = await compare(t, { head: [focus, focus, base, base, base] });
  assert.equal(result.ok, false);
  assert.equal(story.outcome, FrozenOutcome.Blocking);
  assert.equal(story.parallelConfirmation.parallel.headConfirmRenders, 2);
  assert.match(story.parallelConfirmation.parallel.reason, /toHaveFocus/);
  const results = story.parallelConfirmation.controls.flatMap(({ comparison }) => [comparison.renders.base, comparison.renders.head]);
  assert.ok(results.every(({ verdict, pixels }) => verdict === "PASS" && pixels === results[0].pixels));
});

test("ISS-14476 keeps BLOCK on a missing render, reproduced difference, or mixed isolated identities", async (t) => {
  const cases = [
    ["missing", { head: [changed, base], pullContext: (index, open) => {
      if (index === 6) throw new Error("missing isolated render");
      return open();
    } }],
    ["same pixel change", { head: changed }],
    ["same play failure", { head: focus }],
    ["mixed identities", { head: [changed, base, changed], baseline: [base, base, base, base, base, changed] }],
  ];
  for (const [label, scenario] of cases) {
    const { result, story } = await compare(t, scenario);
    assert.equal(result.ok, false, label);
    assert.equal(story.outcome, FrozenOutcome.Blocking, label);
    assert.equal(story.parallelConfirmation.accepted, false, label);
    assert.deepEqual(story.renders, story.parallelConfirmation.parallel.renders, label);
    if (label === "missing") assert.match(story.parallelConfirmation.controls[0].error, /missing isolated render/);
    if (label === "mixed identities") {
      const [first, second] = story.parallelConfirmation.controls.map(({ comparison }) => comparison);
      assert.equal(first.outcome, FrozenOutcome.Identical);
      assert.equal(second.outcome, FrozenOutcome.Identical);
      assert.notEqual(first.renders.base.pixels, second.renders.base.pixels);
    }
  }
});

test("ISS-14476 preserves the historical single-worker block without creating an isolation receipt", async (t) => {
  const { result, story, primary } = await compare(t, { head: [changed, base, base], parallel: false });
  assert.equal(result.ok, false);
  assert.equal(story.parallelConfirmation, undefined);
  assert.equal(primary.visits.length, 5);
});

test("ISS-14476 keeps a provisional block on its assigned non-primary worker", async (t) => {
  const { out } = sandbox(t);
  const first = fakeBrowser({ [BASE]: { [CANDIDATE]: base }, [HEAD]: { [CANDIDATE]: base } });
  const assigned = fakeBrowser({ [BASE]: { [NEIGHBOR]: base }, [HEAD]: { [NEIGHBOR]: [changed, base, base] } });
  const result = await frozenRenders({
    ids: [CANDIDATE, NEIGHBOR], fileCount: 1, browsers: [first, assigned], baseUrl: BASE, headUrl: HEAD,
    out, now: NOW, command: "frozen-render.mjs",
  });
  const { details } = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.equal(details[1].parallelConfirmation.accepted, true);
  assert.ok(first.visits.every(({ id }) => id === CANDIDATE));
  assert.ok(assigned.visits.every(({ id }) => id === NEIGHBOR));
  assert.deepEqual(assigned.visits.slice(-4).map(({ origin }) => origin), [BASE, HEAD, BASE, HEAD]);
});

test("ISS-14476 blocks mixed Focus repeats when base also passes despite the shared failure", async (t) => {
  const { result, story } = await compare(t, {
    head: [focus, focus, base, focus, base, focus, base],
    baseline: [base, base, base, base, base, focus, base, focus, base],
  });
  assert.equal(result.ok, false);
  assert.equal(story.outcome, FrozenOutcome.Blocking);
  assert.equal(story.parallelConfirmation.parallel.outcome, FrozenOutcome.Blocking);
  assert.ok(existsSync(story.parallelConfirmation.parallel.crop));
  assert.equal(story.parallelConfirmation.source.base, "a".repeat(40));
  assert.equal(story.parallelConfirmation.source.head, "b".repeat(40));
  assert.equal(story.parallelConfirmation.source.now, NOW);
});

test("ISS-14476 retains BLOCK when only one ref repeats the exact Focus failure", async (t) => {
  const otherSignature = throws("focus did not reach the allowed item", shot(BLUE));
  const otherPixels = throws("expect(element).toHaveFocus()", shot(GREY));
  for (const control of [base, otherSignature, otherPixels, [base, base, base, base, focus, base], "missing"]) {
    const { result, story } = await compare(t, {
      head: focus,
      baseline: control === "missing" ? base : [base, base, base, base, ...[control].flat()],
      pullContext: control === "missing" ? (index, open) => {
        if (index === 9) throw new Error("fresh Focus context missing");
        return open();
      } : null,
    });
    assert.equal(result.ok, false);
    assert.equal(story.outcome, FrozenOutcome.Blocking);
    assert.equal(story.parallelConfirmation.accepted, false);
  }
});

test("ISS-14476 retains the block on a primary base pass even when fresh failed pairs match", async (t) => {
  const { result, story } = await compare(t, { head: focus, baseline: [base, base, base, base, focus] });
  assert.equal(result.ok, false);
  assert.equal(story.outcome, FrozenOutcome.Blocking);
  assert.match(story.reason, /play PASS on the base, FAIL on the branch/);
  assert.equal(story.parallelConfirmation.controls.length, 2);
});

test("ISS-14476 reports every distinct repeated error when all base attempts fail and cover the branch", async (t) => {
  const { result, story } = await compare(t, {
    baseline: [addSession, addSession, addSession, addSession, addSession, visibleView],
    head: visibleView,
  });
  assert.equal(story.outcome, FrozenOutcome.UnstableOnBase);
  assert.equal(result.ok, true);
  assert.equal(story.parallelConfirmation.parallel.outcome, FrozenOutcome.Blocking);
  assert.equal(story.parallelConfirmation.controls.length, 2);
  assert.deepEqual(result.repetitionReport, [
    "## a--candidate (unstable-on-base)",
    "- Base: storyThrewException fired: Unable to find the Add session button",
    "- Base: storyThrewException fired: expect(Default view).toBeVisible()",
    "- Head: storyThrewException fired: expect(Default view).toBeVisible()",
  ]);
});

test("ISS-14476 blocks a failing head if one repeated base attempt passed", async (t) => {
  const { result, story } = await compare(t, {
    baseline: [addSession, addSession, addSession, addSession, visibleView, base],
    head: visibleView,
  });
  assert.equal(result.ok, false);
  assert.equal(story.outcome, FrozenOutcome.Blocking);
  assert.equal(story.parallelConfirmation.accepted, false);
  assert.ok(story.parallelConfirmation.controls.some(({ comparison }) => comparison.renders.base.verdict === "PASS"));
});

test("ISS-14476 blocks a new head signature even when every repetition fails", async (t) => {
  const { result, story } = await compare(t, {
    baseline: [addSession, addSession, addSession, addSession, addSession, visibleView],
    head: focus,
  });
  assert.equal(result.ok, false);
  assert.equal(story.outcome, FrozenOutcome.Blocking);
  assert.equal(story.parallelConfirmation.accepted, false);
  assert.ok(story.parallelConfirmation.controls.every(({ comparison }) =>
    comparison.renders.base.verdict === "FAIL" && comparison.renders.head.verdict === "FAIL"));
});

test("ISS-14476 applies the same failure rule to primary base repetitions", () => {
  const render = (message) => ({ verdict: message ? "FAIL" : "PASS", reason: message ? "play failed" : "play passed",
    failure: message ? { type: "playFunctionThrewException", message } : null, pixels: "fixture-pixels" });
  const add = render("Add session missing");
  const view = render("Default view hidden");
  assert.equal(classifyStory([add], add).outcome, FrozenOutcome.SameFailure);
  assert.equal(classifyStory([add, view], add).outcome, FrozenOutcome.UnstableOnBase);
  assert.equal(classifyStory([add, render(null)], add).outcome, FrozenOutcome.Blocking);
  assert.equal(classifyStory([add, view], render("new failure")).outcome, FrozenOutcome.Blocking);
});

test("ISS-14476 reports primary variation without requiring a post-drain replay", async (t) => {
  const { result, story } = await compare(t, { baseline: [addSession, visibleView], head: visibleView });
  assert.equal(story.outcome, FrozenOutcome.UnstableOnBase);
  assert.equal(story.parallelConfirmation, undefined);
  assert.deepEqual(result.repetitionReport, [
    "## a--candidate (unstable-on-base)",
    "- Base: storyThrewException fired: Unable to find the Add session button",
    "- Base: storyThrewException fired: expect(Default view).toBeVisible()",
    "- Head: storyThrewException fired: expect(Default view).toBeVisible()",
  ]);
});
