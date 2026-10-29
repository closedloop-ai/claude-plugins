import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDiffRules } from "./diff-rules.mjs";
import { CONFIRM_RENDERS, DEFAULT_NOW, FrozenOutcome, PINNED_CONTEXT, StoryFileChange, classifyStory, frozenInputs, frozenRenders, frozenStoryFiles, frozenStoryIds, prepareBase, storyFileChanges } from "./frozen-render.mjs";
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

test("a blocking story is rendered twice more on the base and becomes unstable on base when the base varies (ISS-13317)", async (t) => {
  const { out } = sandbox(t);
  // The first two base renders agree, so the first comparison blocks; the confirmation renders show the base varies.
  const browser = fakeBrowser({
    [BASE]: {
      "a--pixels": [passes(shot(GREY)), passes(shot(GREY)), passes(shot(GREY, BLUE))],
      "b--play": [passes(shot(GREY)), passes(shot(GREY)), throws("expected dialog", shot(GREY))],
      "c--changed": passes(shot(GREY)),
      "d--same": passes(shot(GREY)),
    },
    [HEAD]: { "a--pixels": passes(shot(BLUE)), "b--play": throws("expected dialog", shot(GREY)), "c--changed": passes(shot(BLUE)), "d--same": passes(shot(GREY)) },
  });
  const summary = await frozenRenders({ ids: ["a--pixels", "b--play", "c--changed", "d--same"], fileCount: 1, baseUrl: BASE, headUrl: HEAD, browser, out, command: "frozen-render.mjs" });
  const details = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  assert.deepEqual(details.map((story) => [story.storyId, story.outcome, story.confirmRenders ?? 0]), [
    ["a--pixels", FrozenOutcome.UnstableOnBase, CONFIRM_RENDERS],
    ["b--play", FrozenOutcome.UnstableOnBase, CONFIRM_RENDERS],
    ["c--changed", FrozenOutcome.Blocking, CONFIRM_RENDERS],
    ["d--same", FrozenOutcome.Identical, 0],
  ]);
  assert.equal(details[0].reason, "the 4 base renders differ (found by 2 more base renders after a blocking first comparison)");
  assert.equal(details[1].reason, "the play's outcome differs between the 4 base renders; the branch matches one of them (found by 2 more base renders after a blocking first comparison)");
  assert.equal(details[2].reason, "the render changed");
  // The unstable story's crop shows the base renders that differ, not the branch.
  assert.ok(existsSync(details[0].crop));
  assert.deepEqual(Object.keys(details[2].renders), ["base", "base-again", "head", "base-confirm-1", "base-confirm-2"]);
  const visits = (id) => browser.visits.filter((visit) => visit.id === id).map((visit) => visit.origin === BASE ? "base" : "head");
  assert.deepEqual(visits("c--changed"), ["base", "base", "head", "base", "base"]);
  assert.deepEqual(visits("d--same"), ["base", "base", "head"]);
  assert.deepEqual(summary.blocking.map((story) => story.storyId), ["c--changed"]);
  assert.ok(existsSync(path.join(out, "base-confirm-2", "c--changed.png")));
});

test("a base whose play outcome varies clears only when the branch matches one of its outcomes", () => {
  const pass = { verdict: "PASS", reason: "completed with no exception or error event", failure: null, pixels: "p" };
  const fail = (message) => ({ verdict: "FAIL", reason: "storyThrewException fired", failure: { type: "storyThrewException", message }, pixels: "f" });
  assert.equal(classifyStory([pass, fail("flaky")], fail("flaky")).outcome, FrozenOutcome.UnstableOnBase);
  assert.equal(classifyStory([pass, fail("flaky")], pass).outcome, FrozenOutcome.UnstableOnBase);
  const neither = classifyStory([pass, fail("flaky")], fail("other"));
  assert.equal(neither.outcome, FrozenOutcome.Blocking);
  assert.match(neither.reason, /differs between the two base renders and the branch matches none of them/);
  // Same verdict, different error text: a changed failure blocks.
  const changed = classifyStory([fail("first"), fail("first")], fail("second"));
  assert.equal(changed.outcome, FrozenOutcome.Blocking);
  assert.equal(changed.reason, "the failure changed: base storyThrewException fired: first, branch storyThrewException fired: second");
  // Fails on the base and passes on the branch: still a change to a frozen story.
  assert.equal(classifyStory([fail("x"), fail("x")], pass).reason, "play FAIL on the base, PASS on the branch");
});

test("a multi-line failure message stays on its story's one line", () => {
  const fail = (message) => ({ verdict: "FAIL", reason: "playFunctionThrewException fired", failure: { type: "playFunctionThrewException", message }, pixels: "f" });
  const message = "Unable to find role \"button\"\n\n  Here are the accessible roles:\n    status:";
  const story = { storyId: "s--x", ...classifyStory([fail(message), fail(message)], fail(message)) };
  assert.equal(story.reason, "fails the same way on the base: playFunctionThrewException fired: Unable to find role \"button\" Here are the accessible roles: status:");
});

test("a play that threw is never identical, even when Storybook reports it finished with success", () => {
  const base = { verdict: "PASS", reason: "ok", failure: null, pixels: "same" };
  const head = { verdict: "FAIL", reason: "playFunctionThrewException fired", failure: { type: "playFunctionThrewException", message: null }, pixels: "same" };
  assert.equal(classifyStory([base, base], head).outcome, FrozenOutcome.Blocking);
  assert.equal(classifyStory([head, head], head).outcome, FrozenOutcome.SameFailure);
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
    head: git(checkout, ["rev-parse", "HEAD"], home),
    inputs: frozenInputs(checkout, base),
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
  assert.equal(summary.changeLogLine, `Frozen render unchanged: all 2 story files (4 stories): frozen-render.mjs --base ${base} --story-file ${storyFiles[0]} --story-file ${storyFiles[1]}: 4 identical, 0 unstable on base, 0 same failure, 0 blocking; head ${base}; inputs ${frozenInputs(checkout, base)}; ${path.join(out, "results.json")}`);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
  // A line counting the 4 stories as story files, as 1.1.11 did, is refused.
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine.replace("all 2 story files (4 stories)", "all 4 story files (4 stories)")}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((entry) => entry.rule), ["frozen-render"]);
});

/**
 * A checkout whose base has a frozen Sessions story with a play that queries the canvas before the Views menu has
 * closed, and whose session changed a component the story renders and repaired that play (ISS-13120's shape).
 */
function repairedCheckout(root, home, { story } = {}) {
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  const STORY = "packages/app/sessions/sessions-contracts.stories.tsx";
  const header = "import { Surface } from \"./surface\";\nexport default { title: \"Composites v1.0/Sessions/Contracts\", tags: [\"deprecated\"] };\n";
  const broken = `${header}export const ViewAndCreation = { play: async () => { openViews(); queryCanvas(); } };\nexport const BulkSelection = {};\n`;
  const files = { [STORY]: broken, "packages/app/sessions/surface.tsx": "export const Surface = 1;\n" };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const base = git(checkout, ["rev-parse", "HEAD"], home);
  writeFileSync(path.join(checkout, "packages/app/sessions/surface.tsx"), "// a comment in the closure\nexport const Surface = 1;\n");
  const repaired = story ?? `${header}export const ViewAndCreation = { play: async () => { openViews(); await menuClosed(); queryCanvas(); } };\nexport const BulkSelection = {};\n`;
  writeFileSync(path.join(checkout, STORY), repaired);
  git(checkout, ["commit", "--quiet", "-am", "repair the play"], home);
  return { checkout, base, STORY, broken, repaired };
}

const VIEW = "composites-v1-0-sessions-contracts--view-and-creation";
const BULK = "composites-v1-0-sessions-contracts--bulk-selection";

test("a compile-only repaired story runs the head's story file against both app codes and clears (ISS-13317)", async (t) => {
  const { root, home, out } = sandbox(t);
  const { checkout, base, STORY, repaired } = repairedCheckout(root, home);
  assert.deepEqual(storyFileChanges(checkout, base, [STORY]).map((change) => change.change), [StoryFileChange.Repaired]);
  // The base Storybook is built from a worktree at the base commit holding the head's story file and the base app code.
  const dir = path.join(root, "base-wt");
  const prepared = prepareBase({ repo: checkout, base, storyFiles: [STORY], dir });
  assert.deepEqual(prepared.headStoryFiles, [STORY]);
  assert.equal(readFileSync(path.join(dir, STORY), "utf8"), repaired);
  assert.equal(readFileSync(path.join(dir, "packages/app/sessions/surface.tsx"), "utf8"), "export const Surface = 1;\n");
  // Each commit's own story file: the broken base play fails, the repaired head passes, so it could never clear.
  const ownFiles = await frozenRenders({ ids: [VIEW], fileCount: 1, baseUrl: BASE, headUrl: HEAD, out: path.join(out, "own"), command: "frozen-render.mjs",
    browser: fakeBrowser({ [BASE]: { [VIEW]: throws("Unable to find role button Add session") }, [HEAD]: { [VIEW]: passes(shot(GREY)) } }) });
  assert.equal(ownFiles.blocking[0].reason, "play FAIL on the base, PASS on the branch");
  // The head's story file on both sides: same app render, so it clears and says why.
  const side = { [VIEW]: passes(shot(GREY)), [BULK]: passes(shot(BLUE)) };
  const summary = await frozenStoryFiles({ repo: checkout, base, storyFiles: [STORY], baseUrl: BASE, headUrl: HEAD, out, browser: fakeBrowser({ [BASE]: side, [HEAD]: side }) });
  assert.equal(summary.ok, true);
  assert.equal(summary.lines[0], `identical ${BULK}; head story file on both sides (compile-only repair of ${STORY})`);
  assert.match(summary.changeLogLine, new RegExp(`^Frozen render unchanged: all 1 story files \\(2 stories\\): .*: 2 identical, 0 unstable on base, 0 same failure, 0 blocking; head story file on both sides for 1 compile-only repaired story files \\(${STORY.replaceAll(".", "\\.")}\\); `));
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  const isFrozenStory = (text) => / v1\.0\//.test(text);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), "");
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((entry) => entry.rule), ["frozen-render"]);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
});

test("a repaired story whose render the app code changed still blocks", async (t) => {
  const { root, home, out } = sandbox(t);
  const { checkout, base, STORY } = repairedCheckout(root, home);
  const summary = await frozenStoryFiles({ repo: checkout, base, storyFiles: [STORY], baseUrl: BASE, headUrl: HEAD, out,
    browser: fakeBrowser({ [BASE]: { [VIEW]: passes(shot(GREY)), [BULK]: passes(shot(GREY)) }, [HEAD]: { [VIEW]: passes(shot(GREY, BLUE)), [BULK]: passes(shot(GREY)) } }) });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.blocking.map((story) => [story.storyId, story.reason]), [[VIEW, "the render changed"]]);
  assert.match(summary.lines.find((line) => line.startsWith("blocking")), /; head story file on both sides \(compile-only repair of .*\); diff /);
});

test("a frozen story file changed beyond a compile-only repair is not compared and blocks", async (t) => {
  const { root, home, out } = sandbox(t);
  const renamed = "import { Surface } from \"./surface\";\nexport default { title: \"Composites v1.0/Sessions/Contracts\", tags: [\"deprecated\"] };\nexport const ViewAndCreationFixed = {};\nexport const BulkSelection = {};\n";
  const { checkout, base, STORY, broken } = repairedCheckout(root, home, { story: renamed });
  assert.deepEqual(storyFileChanges(checkout, base, [STORY]).map((change) => change.change), [StoryFileChange.Changed]);
  const dir = path.join(root, "base-wt");
  const prepared = prepareBase({ repo: checkout, base, storyFiles: [STORY], dir });
  assert.deepEqual([prepared.headStoryFiles, prepared.notCompared], [[], [STORY]]);
  assert.equal(readFileSync(path.join(dir, STORY), "utf8"), broken);
  const browser = fakeBrowser({});
  const summary = await frozenStoryFiles({ repo: checkout, base, storyFiles: [STORY], baseUrl: BASE, headUrl: HEAD, out, browser });
  assert.equal(summary.ok, false);
  assert.equal(summary.changeLogLine, undefined);
  assert.deepEqual(summary.blocking.map((story) => story.storyId).sort(), [BULK, VIEW]);
  assert.match(summary.blocking[0].reason, /changed beyond a compile-only repair \(its title, tags or story names differ\), so it is not compared$/);
  assert.equal(browser.visits.length, 0);
  // A frozen story file the session deleted is not compared either.
  rmSync(path.join(checkout, STORY));
  assert.match((await frozenStoryFiles({ repo: checkout, base, storyFiles: [STORY], baseUrl: BASE, headUrl: HEAD, out, browser })).blocking[0].reason, /\(it is gone\)/);
  assert.throws(() => prepareBase({ repo: checkout, base, storyFiles: [STORY], dir }), /already exists/);
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
  const prepareUsage = spawnSync(process.execPath, [SCRIPT, "prepare-base", "--repo", repo], { encoding: "utf8" });
  assert.equal(prepareUsage.status, 2);
  assert.match(prepareUsage.stdout, /^error: Usage: frozen-render\.mjs prepare-base/);
  const missing = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^error: Playwright is not installed/);
});

test("a recorded line clears only the exact head and files it rendered (ISS-13321)", async (t) => {
  const { root, home, out } = sandbox(t);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  const story = "apps/storybook/stories/row.stories.tsx";
  const row = "packages/design-system/components/row.tsx";
  for (const [file, text] of Object.entries({ [story]: "import { Row } from \"@repo/design-system/components/row\";\nexport default { title: \"Composites v1.0/Row\" };\nexport const Populated = {};\n", [row]: "export const Row = 1;\n" })) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, ["add", "-A"], home);
  git(checkout, ["commit", "--quiet", "-m", "base"], home);
  const base = git(checkout, ["rev-parse", "HEAD"], home);
  writeFileSync(path.join(checkout, row), "export const Row = 2;\n");
  const [id] = frozenStoryIds(checkout, base, [story]);
  const summary = await frozenStoryFiles({ repo: checkout, base, storyFiles: [story], baseUrl: BASE, headUrl: HEAD, out,
    browser: fakeBrowser({ [BASE]: { [id]: passes(shot(GREY)) }, [HEAD]: { [id]: passes(shot(GREY)) } }) });
  assert.match(summary.changeLogLine, new RegExp(`; head ${base}; inputs [0-9a-f]{16}; `));
  assert.match(summary.changeLogLine, /; inputs [0-9a-f]{16}; /);
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine}\n`);
  const isFrozenStory = (text) => / v1\.0\//.test(text);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
  git(checkout, ["commit", "--quiet", "-am", "the rendered change"], home);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((finding) => finding.rule), ["frozen-render"],
    "the same bytes on a different head require a new render proof");
  const committedHead = git(checkout, ["rev-parse", "HEAD"], home);
  const current = await frozenStoryFiles({ repo: checkout, base, storyFiles: [story], baseUrl: BASE, headUrl: HEAD, out,
    browser: fakeBrowser({ [BASE]: { [id]: passes(shot(GREY)) }, [HEAD]: { [id]: passes(shot(GREY)) } }) });
  assert.match(current.changeLogLine, new RegExp(`; head ${committedHead}; inputs [0-9a-f]{16}; `));
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${current.changeLogLine}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
  writeFileSync(path.join(checkout, row), "export const Row = 3;\n");
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((finding) => finding.rule), ["frozen-render"],
    "the line from the earlier head no longer clears the new change");
});
