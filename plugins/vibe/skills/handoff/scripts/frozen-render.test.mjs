import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDiffRules } from "./diff-rules.mjs";
import { FrozenOutcome, compareRenders, frozenRenders, frozenStoryIds } from "./frozen-render.mjs";
import { git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "frozen-render.mjs");
const BASE = "http://storybook-base";
const HEAD = "http://storybook-head";

/**
 * A stand-in for Playwright's browser. `plays[url][storyId]` is what that Storybook does for the story:
 * the channel events it emits ({type, storyId?, message?}; none means the play never finishes) and its pixels.
 */
function fakeBrowser(plays) {
  const visits = [];
  return {
    visits,
    newPage: async ({ viewport }) => {
      let play = null;
      let script = "";
      return {
        addInitScript: async (source) => {
          script = source;
        },
        goto: async (url) => {
          const [origin, query] = url.split("/iframe.html?");
          const id = decodeURIComponent(new URLSearchParams(query).get("id"));
          visits.push({ origin, id, viewport, recorder: script.includes("__vibePlayEvents") });
          play = plays[origin]?.[id] ?? { events: [{ type: "storyMissing", storyId: id }], pixels: "missing" };
        },
        waitForFunction: async () => {
          if (!play.events.length) throw new Error("Timeout");
        },
        evaluate: async () => play.events.map((event) => ({ storyId: null, status: null, message: null, ...event })),
        screenshot: async () => Buffer.from(play.pixels),
        close: async () => {},
      };
    },
  };
}

const passes = (pixels) => ({ events: [{ type: "storyRendered" }, { type: "storyFinished", status: "success" }], pixels });
const throws = (message, pixels = "error overlay") => ({ events: [{ type: "storyThrewException", message }, { type: "storyFinished", status: "error" }], pixels });

function sandbox(t) {
  const fixture = makeHome("vibe-frozen-render-");
  t.after(fixture.cleanup);
  return { ...fixture, out: path.join(fixture.root, "out") };
}

test("a story that fails identically on the base is a known main failure that does not block (ISS-13291)", async (t) => {
  const { out } = sandbox(t);
  const browser = fakeBrowser({
    [BASE]: { "row--populated": passes("row"), "branch-shell--populated": throws("No fixture for /api/pr-files"), "row--empty": passes("empty") },
    [HEAD]: { "row--populated": passes("row"), "branch-shell--populated": throws("No fixture for /api/pr-files"), "row--empty": passes("empty") },
  });
  const summary = await frozenRenders({ ids: ["row--populated", "branch-shell--populated", "row--empty"], baseUrl: BASE, headUrl: HEAD,
    browser, out, command: "frozen-render.mjs --base abc --story-file s/row.stories.tsx" });
  assert.equal(summary.ok, true);
  assert.equal(summary.identical, 2);
  assert.deepEqual(summary.knownMainFailures.map((story) => story.storyId), ["branch-shell--populated"]);
  assert.match(summary.knownMainFailures[0].reason, /fails the same way on the base: storyThrewException fired: No fixture for \/api\/pr-files/);
  assert.deepEqual(summary.differs, []);
  assert.equal(summary.changeLogLine, `Frozen render unchanged: all 3 stories: frozen-render.mjs --base abc --story-file s/row.stories.tsx: 2 identical, 1 known main failures (branch-shell--populated); ${path.join(out, "results.json")}`);
  assert.ok(browser.visits.every((visit) => visit.recorder && visit.viewport.width === 1280 && visit.viewport.height === 800));
  assert.deepEqual(browser.visits.map((visit) => `${visit.origin} ${visit.id}`), [
    `${BASE} row--populated`, `${HEAD} row--populated`, `${BASE} branch-shell--populated`, `${HEAD} branch-shell--populated`, `${BASE} row--empty`, `${HEAD} row--empty`,
  ]);
  const results = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8"));
  assert.deepEqual(results.details.map((story) => story.outcome), [FrozenOutcome.Identical, FrozenOutcome.KnownMainFailure, FrozenOutcome.Identical]);
  for (const side of ["base", "head"]) assert.ok(existsSync(path.join(out, side, "row--populated.png")));
});

test("a changed render, a new failure, a changed failure or an unfinished play differs and blocks", async (t) => {
  const { out } = sandbox(t);
  const browser = fakeBrowser({
    [BASE]: { "a--render": passes("old"), "b--new-failure": passes("b"), "c--changed-failure": throws("first"), "d--unfinished": passes("d") },
    [HEAD]: { "a--render": passes("new"), "b--new-failure": throws("boom"), "c--changed-failure": throws("second"), "d--unfinished": { events: [], pixels: "d" } },
  });
  const summary = await frozenRenders({ ids: ["a--render", "b--new-failure", "c--changed-failure", "d--unfinished"], baseUrl: BASE, headUrl: HEAD,
    browser, out, timeoutMs: 1000, command: "frozen-render.mjs" });
  assert.equal(summary.ok, false);
  assert.equal(summary.changeLogLine, undefined);
  assert.deepEqual(summary.differs.map((story) => [story.storyId, story.reason]), [
    ["a--render", "the render changed"],
    ["b--new-failure", "play PASS on the base, FAIL on the branch"],
    ["c--changed-failure", "the failure changed: base storyThrewException fired, branch storyThrewException fired"],
    ["d--unfinished", "play PASS on the base, FAIL on the branch"],
  ]);
  const details = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  assert.equal(details[3].head.reason, "the play did not finish within 1000 ms");
});

test("a play that threw is never identical, even when Storybook reports it finished with success", () => {
  const base = { verdict: "PASS", reason: "ok", failure: null, sha256: "same" };
  const head = { verdict: "FAIL", reason: "playFunctionThrewException fired", failure: { type: "playFunctionThrewException", message: null }, sha256: "same" };
  assert.equal(compareRenders(base, head).outcome, FrozenOutcome.Differs);
  assert.equal(compareRenders(head, head).outcome, FrozenOutcome.KnownMainFailure);
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

test("the line it prints passes handoff's frozen-render rule", async (t) => {
  const { root, home, out } = sandbox(t);
  const checkout = path.join(root, "wt");
  git(root, ["init", "--quiet", "--initial-branch=main", checkout], home);
  const files = {
    "apps/storybook/stories/row.stories.tsx": "import { Row } from \"@repo/design-system/components/row\";\nexport default { title: \"Composites v1.0/Row\" };\nexport const Populated = {};\n",
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
  const ids = frozenStoryIds(checkout, base, ["apps/storybook/stories/row.stories.tsx"]);
  const summary = await frozenRenders({ ids, baseUrl: BASE, headUrl: HEAD, out, command: "frozen-render.mjs --base x",
    browser: fakeBrowser({ [BASE]: { [ids[0]]: throws("no fixture") }, [HEAD]: { [ids[0]]: throws("no fixture") } }) });
  const gitDir = git(checkout, ["rev-parse", "--absolute-git-dir"], home);
  const isFrozenStory = (text) => / v1\.0\//.test(text);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), "");
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking.map((finding) => finding.rule), ["frozen-render"]);
  writeFileSync(path.join(gitDir, "vibe-changes.md"), `${summary.changeLogLine}\n`);
  assert.deepEqual(runDiffRules({ worktree: checkout, base, isFrozenStory }).blocking, []);
});

test("the CLI names a missing argument or a repo without Playwright and exits 2", (t) => {
  const { root } = sandbox(t);
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(JSON.parse(usage.stdout).error, /^Usage: frozen-render\.mjs/);
  const repo = path.join(root, "bare");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", repo]);
  spawnSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "x"]);
  writeFileSync(path.join(repo, "s.stories.tsx"), "export default { title: \"A\" };\nexport const B = {};\n");
  spawnSync("git", ["-C", repo, "add", "-A"]);
  spawnSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "story"]);
  const missing = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--base", "HEAD", "--base-url", BASE, "--head-url", HEAD,
    "--story-file", "s.stories.tsx", "--out", path.join(root, "out")], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(JSON.parse(missing.stdout).error, /Playwright is not installed/);
});
