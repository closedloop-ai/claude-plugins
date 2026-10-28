import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDiffRules } from "./diff-rules.mjs";
import { DEFAULT_NOW, FrozenOutcome, PINNED_CONTEXT, classifyStory, frozenRenders, frozenStoryFiles, frozenStoryIds } from "./frozen-render.mjs";
import { CROP_MAX_WIDTH, decodePng, encodePng } from "./png-diff.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "frozen-render.mjs");
const BASE = "http://storybook-base";
const HEAD = "http://storybook-head";

/** A small solid screenshot, with one pixel of `dot` color when given. */
function shot(color, dot) {
  const [width, height] = [6, 4];
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...color, 255], i * 4);
  if (dot) data.set([...dot, 255], (2 * width + 3) * 4);
  return encodePng({ width, height, data });
}

const GREY = [200, 200, 200];
const BLUE = [0, 0, 255];

/**
 * A stand-in for Playwright's browser. `plays[url][storyId]` is what that Storybook does for the story, either one
 * play or a list consumed render by render: the channel events it emits ({type, storyId?, message?}; none means the
 * play never finishes) and its screenshot.
 */
function fakeBrowser(plays) {
  const visits = [];
  const served = new Map();
  return {
    visits,
    newContext: async (options) => {
      const visit = { options, clock: null, recorder: false, closed: false };
      return {
        newPage: async () => {
          let play = null;
          return {
            clock: { setFixedTime: async (time) => { visit.clock = new Date(time).toISOString(); } },
            addInitScript: async (source) => { visit.recorder = source.includes("__vibePlayEvents"); },
            goto: async (url) => {
              const [origin, query] = url.split("/iframe.html?");
              const id = decodeURIComponent(new URLSearchParams(query).get("id"));
              Object.assign(visit, { origin, id });
              visits.push(visit);
              const key = `${origin} ${id}`;
              const configured = plays[origin]?.[id] ?? { events: [{ type: "storyMissing", storyId: id }], png: shot([0, 0, 0]) };
              const index = served.get(key) ?? 0;
              served.set(key, index + 1);
              play = Array.isArray(configured) ? configured[Math.min(index, configured.length - 1)] : configured;
            },
            waitForFunction: async () => {
              if (!play.events.length) throw new Error("Timeout");
            },
            evaluate: async (fn) => (String(fn).includes("fonts") ? undefined : play.events.map((event) => ({ storyId: null, status: null, message: null, ...event }))),
            screenshot: async (options) => {
              visit.screenshot = options;
              return play.png;
            },
          };
        },
        close: async () => { visit.closed = true; },
      };
    },
  };
}

const passes = (png) => ({ events: [{ type: "storyRendered" }, { type: "storyFinished", status: "success" }], png });
const throws = (message, png = shot([255, 0, 0])) => ({ events: [{ type: "storyThrewException", message }, { type: "storyFinished", status: "error" }], png });

function sandbox(t) {
  const fixture = makeHome("vibe-frozen-render-");
  t.after(fixture.cleanup);
  return { ...fixture, out: path.join(fixture.root, "out") };
}

test("each class: identical, unstable on base, same failure, changed render, new failure and a changed play on an unstable base (ISS-13317)", async (t) => {
  const { out } = sandbox(t);
  const ids = ["a--identical", "b--unstable", "c--same-failure", "d--changed", "e--newly-failing", "f--unstable-play-changed"];
  const browser = fakeBrowser({
    [BASE]: {
      "a--identical": passes(shot(GREY)),
      "b--unstable": [passes(shot(GREY)), passes(shot(GREY, BLUE))],
      "c--same-failure": [throws("No fixture for /api/pr-files", shot(GREY)), throws("No fixture for /api/pr-files", shot(GREY, BLUE))],
      "d--changed": passes(shot(GREY)),
      "e--newly-failing": passes(shot(GREY)),
      "f--unstable-play-changed": [passes(shot(GREY)), passes(shot(GREY, BLUE))],
    },
    [HEAD]: {
      "a--identical": passes(shot(GREY)),
      "b--unstable": passes(shot(BLUE)),
      "c--same-failure": throws("No fixture for /api/pr-files", shot(BLUE)),
      "d--changed": passes(shot(GREY, BLUE)),
      "e--newly-failing": throws("boom", shot(GREY)),
      "f--unstable-play-changed": throws("expected dialog", shot(GREY)),
    },
  });
  const summary = await frozenRenders({ ids, fileCount: 2, baseUrl: BASE, headUrl: HEAD, browser, out, command: "frozen-render.mjs --base abc" });
  const details = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  assert.deepEqual(details.map((story) => [story.storyId, story.outcome]), [
    ["a--identical", FrozenOutcome.Identical],
    ["b--unstable", FrozenOutcome.UnstableOnBase],
    ["c--same-failure", FrozenOutcome.SameFailure],
    ["d--changed", FrozenOutcome.Blocking],
    ["e--newly-failing", FrozenOutcome.Blocking],
    ["f--unstable-play-changed", FrozenOutcome.Blocking],
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.changeLogLine, undefined);
  assert.deepEqual(summary.blocking.map((story) => [story.storyId, story.reason]), [
    ["d--changed", "the render changed"],
    ["e--newly-failing", "play PASS on the base, FAIL on the branch (storyThrewException fired: boom)"],
    ["f--unstable-play-changed", "play PASS on the base, FAIL on the branch (storyThrewException fired: expected dialog)"],
  ]);
  assert.equal(summary.sameFailure[0].reason, "fails the same way on the base: storyThrewException fired: No fixture for /api/pr-files");
  assert.deepEqual(summary.lines.slice(0, 3), [
    "identical a--identical",
    `unstable-on-base b--unstable: the two base renders differ; diff ${path.join(out, "diffs", "b--unstable.png")}`,
    "same-failure c--same-failure: fails the same way on the base: storyThrewException fired: No fixture for /api/pr-files",
  ]);
  assert.equal(summary.lines.at(-1), `summary: 6 stories in 2 story files: 1 identical, 1 unstable on base (b--unstable), 1 same failure (c--same-failure), 3 blocking; results ${path.join(out, "results.json")}`);
  // A cropped diff only for the unstable base and for blocking pixel differences, never for a new failure with the base's pixels.
  assert.deepEqual(details.filter((story) => story.crop).map((story) => story.storyId), ["b--unstable", "d--changed"]);
  const crop = decodePng(readFileSync(summary.blocking[0].crop));
  assert.ok(crop.width <= CROP_MAX_WIDTH);
  assert.ok(!existsSync(path.join(out, "diffs", "a--identical.png")));
  // Each story renders twice on the base, then once on the branch, each in its own pinned context.
  assert.deepEqual(browser.visits.slice(0, 3).map((visit) => `${visit.origin} ${visit.id}`), [`${BASE} a--identical`, `${BASE} a--identical`, `${HEAD} a--identical`]);
  for (const visit of browser.visits) {
    assert.deepEqual(visit.options, { viewport: { width: 1280, height: 800 }, ...PINNED_CONTEXT });
    assert.equal(visit.clock, DEFAULT_NOW);
    assert.ok(visit.recorder && visit.closed);
    assert.deepEqual(visit.screenshot, { animations: "disabled", caret: "hide", scale: "css", fullPage: true });
  }
  for (const side of ["base", "base-again", "head"]) assert.ok(existsSync(path.join(out, side, "a--identical.png")));
});

test("only unstable-on-base and same-failure stories clear: the line names both classes and passes with no blocking", async (t) => {
  const { out } = sandbox(t);
  const browser = fakeBrowser({
    [BASE]: { "tour--opening": [passes(shot(GREY)), passes(shot(GREY, BLUE))], "shell--populated": throws("no route"), "row--x": passes(shot(GREY)) },
    [HEAD]: { "tour--opening": passes(shot(BLUE)), "shell--populated": throws("no route"), "row--x": passes(shot(GREY)) },
  });
  const summary = await frozenRenders({ ids: ["tour--opening", "shell--populated", "row--x"], fileCount: 2, baseUrl: BASE, headUrl: HEAD, browser, out,
    command: "frozen-render.mjs --base abc --story-file s/a.stories.tsx --story-file s/b.stories.tsx" });
  assert.equal(summary.ok, true);
  assert.equal(summary.changeLogLine, `Frozen render unchanged: all 2 story files (3 stories): frozen-render.mjs --base abc --story-file s/a.stories.tsx --story-file s/b.stories.tsx: 1 identical, 1 unstable on base (tour--opening), 1 same failure (shell--populated), 0 blocking; ${path.join(out, "results.json")}`);
});

test("a base whose play outcome varies clears only when the branch matches one of its outcomes", () => {
  const pass = { verdict: "PASS", reason: "completed with no exception or error event", failure: null, pixels: "p" };
  const fail = (message) => ({ verdict: "FAIL", reason: "storyThrewException fired", failure: { type: "storyThrewException", message }, pixels: "f" });
  assert.equal(classifyStory(pass, fail("flaky"), fail("flaky")).outcome, FrozenOutcome.UnstableOnBase);
  assert.equal(classifyStory(pass, fail("flaky"), pass).outcome, FrozenOutcome.UnstableOnBase);
  const neither = classifyStory(pass, fail("flaky"), fail("other"));
  assert.equal(neither.outcome, FrozenOutcome.Blocking);
  assert.match(neither.reason, /differs between the two base renders and the branch matches neither/);
  // Same verdict, different error text: a changed failure blocks.
  const changed = classifyStory(fail("first"), fail("first"), fail("second"));
  assert.equal(changed.outcome, FrozenOutcome.Blocking);
  assert.equal(changed.reason, "the failure changed: base storyThrewException fired: first, branch storyThrewException fired: second");
  // Fails on the base and passes on the branch: still a change to a frozen story.
  assert.equal(classifyStory(fail("x"), fail("x"), pass).reason, "play FAIL on the base, PASS on the branch");
});

test("a play that threw is never identical, even when Storybook reports it finished with success", () => {
  const base = { verdict: "PASS", reason: "ok", failure: null, pixels: "same" };
  const head = { verdict: "FAIL", reason: "playFunctionThrewException fired", failure: { type: "playFunctionThrewException", message: null }, pixels: "same" };
  assert.equal(classifyStory(base, base, head).outcome, FrozenOutcome.Blocking);
  assert.equal(classifyStory(head, head, head).outcome, FrozenOutcome.SameFailure);
});

test("an unfinished play fails with its timeout and blocks against a passing base", async (t) => {
  const { out } = sandbox(t);
  const browser = fakeBrowser({ [BASE]: { "d--unfinished": passes(shot(GREY)) }, [HEAD]: { "d--unfinished": { events: [], png: shot(GREY) } } });
  const summary = await frozenRenders({ ids: ["d--unfinished"], fileCount: 1, baseUrl: BASE, headUrl: HEAD, browser, out, timeoutMs: 1000, command: "frozen-render.mjs" });
  assert.deepEqual(summary.blocking.map((story) => story.reason), ["play PASS on the base, FAIL on the branch (the play did not finish within 1000 ms)"]);
});

test("story IDs come from each story file's base text", (t) => {
  const { root, home } = sandbox(t);
  const repo = path.join(root, "repo");
  git(root, ["init", "--quiet", "--initial-branch=main", repo], home);
  mkdirSync(path.join(repo, "s"));
  writeFileSync(path.join(repo, "s", "row.stories.tsx"), "export default { title: \"Composites v1.0/Row\" };\nexport const Populated = {};\nexport const EmptyState = {};\n");
  git(repo, ["add", "-A"], home);
  git(repo, ["commit", "--quiet", "-m", "base"], home);
  const base = git(repo, ["rev-parse", "HEAD"], home);
  writeFileSync(path.join(repo, "s", "row.stories.tsx"), "export default { title: \"Composites v1.0/Row\" };\nexport const Renamed = {};\n");
  assert.deepEqual(frozenStoryIds(repo, base, ["s/row.stories.tsx"]), ["composites-v1-0-row--empty-state", "composites-v1-0-row--populated"]);
});

test("the line it prints passes handoff's frozen-render rule, which counts story files", async (t) => {
  const { root, home, out } = sandbox(t);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  const files = {
    "apps/storybook/stories/row.stories.tsx": "import { Row } from \"@repo/design-system/components/row\";\nexport default { title: \"Composites v1.0/Row\" };\nexport const Populated = {};\nexport const Empty = {};\n",
    "packages/design-system/components/row.tsx": "export const Row = 1;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const base = git(checkout, ["rev-parse", "HEAD"], home);
  writeFileSync(path.join(checkout, "packages/design-system/components/row.tsx"), "export const Row = 2;\n");
  const storyFiles = ["apps/storybook/stories/row.stories.tsx"];
  const ids = frozenStoryIds(checkout, base, storyFiles);
  const summary = await frozenRenders({ ids, fileCount: storyFiles.length, baseUrl: BASE, headUrl: HEAD, out, command: `frozen-render.mjs --base ${base} --story-file ${storyFiles[0]}`,
    browser: fakeBrowser({ [BASE]: { [ids[0]]: throws("no fixture"), [ids[1]]: [passes(shot(GREY)), passes(shot(BLUE))] }, [HEAD]: { [ids[0]]: throws("no fixture"), [ids[1]]: passes(shot(GREY)) } }) });
  assert.match(summary.changeLogLine, /^Frozen render unchanged: all 1 story files \(2 stories\): frozen-render\.mjs /);
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  const isFrozenStory = (text) => / v1\.0\//.test(text);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), "");
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((finding) => finding.rule), ["frozen-render"]);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
  // The 1.1.11 line counted stories where the rule counts story files, so it is not accepted.
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `Frozen render unchanged: all 2 stories: frozen-render.mjs --base ${base}: 1 identical, 1 known main failures; ${out}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((finding) => finding.rule), ["frozen-render"]);
});

test("the line the command prints is the line the gate accepts when story files hold several story IDs (ISS-13317)", async (t) => {
  const { root, home, out } = sandbox(t);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  const header = (title) => `import { Row } from "@repo/design-system/components/row";\nexport default { title: "${title}" };\n`;
  const files = {
    "apps/storybook/stories/rows.stories.tsx": `${header("Composites v1.0/Rows")}export const Populated = {};\nexport const Empty = {};\nexport const Loading = {};\n`,
    "apps/storybook/stories/table.stories.tsx": `${header("Surfaces v1.0/Table")}export const Default = {};\n`,
    "packages/design-system/components/row.tsx": "export const Row = 1;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const base = git(checkout, ["rev-parse", "HEAD"], home);
  writeFileSync(path.join(checkout, "packages/design-system/components/row.tsx"), "export const Row = 2;\n");
  const isFrozenStory = (text) => / v1\.0\//.test(text);
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), "");
  const [finding] = runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking;
  assert.equal(finding.rule, "frozen-render");
  assert.match(finding.problem, /^2 frozen v1\.0 story files /);
  const storyFiles = ["apps/storybook/stories/rows.stories.tsx", "apps/storybook/stories/table.stories.tsx"];
  const ids = frozenStoryIds(checkout, base, storyFiles);
  assert.equal(ids.length, 4);
  const side = Object.fromEntries(ids.map((id) => [id, passes(shot(GREY))]));
  // A story file named twice is still one file.
  const summary = await frozenStoryFiles({ repo: checkout, base, storyFiles: [...storyFiles, storyFiles[0]], baseUrl: BASE, headUrl: HEAD, out,
    browser: fakeBrowser({ [BASE]: side, [HEAD]: side }) });
  assert.equal(summary.changeLogLine, `Frozen render unchanged: all 2 story files (4 stories): frozen-render.mjs --base ${base} --story-file ${storyFiles[0]} --story-file ${storyFiles[1]}: 4 identical, 0 unstable on base, 0 same failure, 0 blocking; ${path.join(out, "results.json")}`);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
  // A line counting the 4 stories as story files, as 1.1.11 did, is refused.
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine.replace("all 2 story files (4 stories)", "all 4 story files (4 stories)")}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((entry) => entry.rule), ["frozen-render"]);
});

test("the CLI names a missing argument, a bad --now or a repo without Playwright and exits 2", (t) => {
  const { root } = sandbox(t);
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /^error: Usage: frozen-render\.mjs/);
  const repo = path.join(root, "bare");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", repo]);
  writeFileSync(path.join(repo, "s.stories.tsx"), "export default { title: \"A\" };\nexport const B = {};\n");
  spawnSync("git", ["-C", repo, "add", "-A"]);
  spawnSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "story"]);
  const args = [SCRIPT, "--repo", repo, "--base", "HEAD", "--base-url", BASE, "--head-url", HEAD, "--story-file", "s.stories.tsx", "--out", path.join(root, "out")];
  const badNow = spawnSync(process.execPath, [...args, "--now", "yesterday"], { encoding: "utf8" });
  assert.equal(badNow.status, 2);
  assert.match(badNow.stdout, /^error: --now must be an ISO time/);
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^error: Playwright is not installed/);
});
