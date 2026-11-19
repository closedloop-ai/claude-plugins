import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultWorkers, FrozenOutcome, frozenRenders, runOwnedFrozenComparison } from "./frozen-render.mjs";
import { BASE, BLUE, fakeBrowser, GREY, HEAD, passes, sandbox, shot, throws } from "./frozen-render-test-fixture.mjs";
import { bindProviderInProcess } from "../../vibe/scripts/test-fixtures.mjs";

bindProviderInProcess(after);

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "frozen-render.mjs");
const sides = (browser, id) => browser.visits.filter((visit) => visit.id === id).map((visit) => (visit.origin === BASE ? "base" : "head"));

test("a branch render matching the base's play and pixels skips the second base render; a mismatch still gets it (ISS-14395)", async (t) => {
  const { out } = sandbox(t);
  const browser = fakeBrowser({
    [BASE]: {
      "a--unchanged": passes(shot(GREY)),
      // The base varies on its second render, but the branch matches the first: no second base render is needed to pass.
      "b--varies-later": [passes(shot(GREY)), passes(shot(GREY, BLUE))],
      "c--same-failure": throws("no route", shot(GREY)),
      "d--changed": passes(shot(GREY)),
    },
    [HEAD]: { "a--unchanged": passes(shot(GREY)), "b--varies-later": passes(shot(GREY)), "c--same-failure": throws("no route", shot(BLUE)), "d--changed": passes(shot(BLUE)) },
  });
  const summary = await frozenRenders({ ids: ["a--unchanged", "b--varies-later", "c--same-failure", "d--changed"], fileCount: 1, baseUrl: BASE, headUrl: HEAD, browser, out, command: "frozen-render.mjs" });
  const details = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  assert.deepEqual(details.map((story) => [story.storyId, story.outcome]), [
    ["a--unchanged", FrozenOutcome.Identical],
    ["b--varies-later", FrozenOutcome.Identical],
    ["c--same-failure", FrozenOutcome.SameFailure],
    ["d--changed", FrozenOutcome.Blocking],
  ]);
  for (const id of ["a--unchanged", "b--varies-later", "c--same-failure"]) assert.deepEqual(sides(browser, id), ["base", "head"], id);
  assert.deepEqual(sides(browser, "d--changed"), ["base", "head", "base", "base", "base"]);
  assert.deepEqual(Object.keys(details[0].renders), ["base", "head"]);
  assert.deepEqual(summary.blocking.map((story) => story.storyId), ["d--changed"]);
});

/** One known-changed and one known-unchanged story, the fixture every step's verdict is held to. */
function verdictFixture() {
  return {
    [BASE]: { "a--unchanged": passes(shot(GREY)), "b--changed": passes(shot(GREY)) },
    [HEAD]: { "a--unchanged": passes(shot(GREY)), "b--changed": passes(shot(GREY, BLUE)) },
  };
}

test("stories spread over every worker browser, results keep story order and the verdict matches one browser's (ISS-14395)", async (t) => {
  const ids = ["a--unchanged", "b--changed", "a--unchanged-2", "b--changed-2", "a--unchanged-3"];
  const plays = verdictFixture();
  for (const side of [BASE, HEAD]) {
    for (const suffix of ["-2", "-3"]) {
      plays[side][`a--unchanged${suffix}`] = plays[side]["a--unchanged"];
      plays[side][`b--changed${suffix}`] = plays[side]["b--changed"];
    }
  }
  const single = await frozenRenders({ ids, fileCount: 1, baseUrl: BASE, headUrl: HEAD, browser: fakeBrowser(plays), out: sandbox(t).out, command: "frozen-render.mjs" });
  const browsers = [fakeBrowser(plays), fakeBrowser(plays), fakeBrowser(plays)];
  const pooledOut = sandbox(t).out;
  const pooled = await frozenRenders({ ids, fileCount: 1, baseUrl: BASE, headUrl: HEAD, browsers, out: pooledOut, command: "frozen-render.mjs" });
  assert.ok(browsers.every((browser) => browser.visits.length > 0), "every worker browser rendered a story");
  assert.equal(new Set(browsers.flatMap((browser) => [...new Set(browser.visits.map((visit) => visit.id))])).size, ids.length);
  for (const browser of browsers) {
    for (const id of new Set(browser.visits.map((visit) => visit.id))) {
      assert.ok(browsers.filter((other) => other.visits.some((visit) => visit.id === id)).length === 1, `${id} rendered by one worker`);
    }
  }
  const details = JSON.parse(readFileSync(path.join(pooledOut, "results.json"), "utf8")).details;
  assert.deepEqual(details.map((story) => story.storyId), ids);
  assert.deepEqual(pooled.lines.slice(0, -1).map((line) => line.replace(pooledOut, "OUT")), single.lines.slice(0, -1).map((line) => line.replace(/\S+\/out/, "OUT")));
  assert.equal(pooled.ok, false);
  assert.deepEqual(pooled.blocking.map((story) => story.storyId), ["b--changed", "b--changed-2"]);
  const passing = await frozenRenders({ ids: ["a--unchanged"], fileCount: 1, baseUrl: BASE, headUrl: HEAD, browsers: [fakeBrowser(plays), fakeBrowser(plays)], out: sandbox(t).out, command: "frozen-render.mjs" });
  assert.equal(passing.ok, true);
  assert.match(passing.changeLogLine, /^Frozen render unchanged: all 1 story files \(1 stories\)/);
});

test("a worker's render failure stops the pool, lets the other worker finish its story, then rejects the run", async (t) => {
  const plays = { [BASE]: {}, [HEAD]: {} };
  const ids = ["a--first", "b--second", "c--third", "d--fourth"];
  for (const id of ids) {
    plays[BASE][id] = passes(shot(GREY));
    plays[HEAD][id] = passes(shot(GREY));
  }
  const broken = fakeBrowser(plays);
  broken.newContext = async () => { throw new Error("browser crashed"); };
  const healthy = fakeBrowser(plays);
  const newContext = healthy.newContext;
  let finishedAfterFailure = false;
  healthy.newContext = async (options) => {
    // Let the broken worker fail while this one is mid-story.
    await new Promise((resolve) => setImmediate(resolve));
    const context = await newContext(options);
    return { ...context, close: async () => { finishedAfterFailure = true; await context.close(); } };
  };
  await assert.rejects(frozenRenders({ ids, fileCount: 1, baseUrl: BASE, headUrl: HEAD,
    browsers: [broken, healthy], out: sandbox(t).out, command: "frozen-render.mjs" }), /browser crashed/);
  assert.ok(finishedAfterFailure, "the healthy worker's renders closed before the run rejected");
  assert.deepEqual([...new Set(healthy.visits.map((visit) => visit.id))], ["b--second"], "no story is taken after the failure");
  assert.ok(healthy.visits.every((visit) => visit.closed), "every render the healthy worker started was closed");
});

test("the owned comparison launches one browser per worker and closes every one", async () => {
  const events = [];
  let launched = 0;
  const launch = async () => { const n = ++launched; events.push(`launch ${n}`); return { close: async () => { events.push(`close ${n}`); } }; };
  const withServer = async (_dir, _port, action) => action("http://storybook");
  const result = await runOwnedFrozenComparison({ repo: "head", baseDir: "base", base: "abc", storyFiles: [], out: "out", workers: 3 },
    { withServer, nextPort: async (other) => (other ? 6122 : 6121), launch, compare: async ({ browsers, browser }) => ({ count: browsers.length, first: browser === browsers[0] }) });
  assert.deepEqual(result, { count: 3, first: true });
  assert.deepEqual(events.slice(0, 3), ["launch 1", "launch 2", "launch 3"]);
  assert.deepEqual(events.slice(3).sort(), ["close 1", "close 2", "close 3"]);
});

test("the default worker count is half the cores, between one and eight", () => {
  assert.equal(defaultWorkers(18), 8);
  assert.equal(defaultWorkers(10), 5);
  assert.equal(defaultWorkers(1), 1);
});

test("the CLI refuses a worker count below one and exits 2", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--repo", ".", "--base", "HEAD", "--base-dir", ".", "--story-file", "a.stories.tsx", "--out", "out", "--workers", "0"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--workers must be a whole number of at least 1/);
});
