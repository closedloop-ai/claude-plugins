import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { storyId } from "./diff-rules.mjs";
import { frozenBaseInputDigests, frozenRenders, frozenStoryFiles } from "./frozen-render.mjs";
import { baseRenderCache, CACHE_FORMAT, environmentDigest, fontsDigest } from "./frozen-render-cache.mjs";
import { BASE, BLUE, fakeBrowser, GREY, HEAD, passes, sandbox, shot } from "./frozen-render-test-fixture.mjs";
import { bindProviderInProcess, git, makeHome } from "../../vibe/scripts/test-fixtures.mjs";

bindProviderInProcess(after);

const ENVIRONMENT = { chromiumVersion: "131.0", viewport: { width: 1280, height: 800 }, now: "2026-01-01T12:00:00.000Z", timeoutMs: 20_000, fonts: "fonts" };
const baseVisits = (browser) => browser.visits.filter((visit) => visit.origin === BASE).map((visit) => visit.id);

test("a cached base render round-trips by story, inputs and environment, and a damaged entry misses", (t) => {
  const { root } = sandbox(t);
  const dir = path.join(root, "cache");
  const cache = baseRenderCache(dir, environmentDigest(ENVIRONMENT));
  const png = shot(GREY);
  cache.set("a--one", "inputs-1", { verdict: "PASS", reason: "ok", failure: null, rawPngHash: "raw", events: [{ type: "storyFinished" }], screenshot: png, timingsMs: {} });
  const hit = cache.get("a--one", "inputs-1");
  assert.deepEqual({ ...hit, screenshot: Buffer.from(hit.screenshot) }, { verdict: "PASS", reason: "ok", failure: null, rawPngHash: "raw", events: [{ type: "storyFinished" }], screenshot: Buffer.from(png) });
  assert.equal(cache.get("a--one", "inputs-2"), null, "other base inputs miss");
  assert.equal(cache.get("b--two", "inputs-1"), null, "another story misses");
  assert.equal(baseRenderCache(dir, environmentDigest({ ...ENVIRONMENT, chromiumVersion: "132.0" })).get("a--one", "inputs-1"), null, "another environment misses");
  const [bucket] = readdirSync(dir);
  const entry = readdirSync(path.join(dir, bucket)).find((name) => name.endsWith(".json"));
  const pngFile = path.join(dir, bucket, entry.replace(/\.json$/, ".png"));
  writeFileSync(pngFile, shot(BLUE));
  assert.equal(cache.get("a--one", "inputs-1"), null, "a screenshot that no longer matches its recorded hash misses");
  writeFileSync(pngFile, png);
  const jsonFile = path.join(dir, bucket, entry);
  writeFileSync(jsonFile, JSON.stringify({ ...JSON.parse(readFileSync(jsonFile, "utf8")), format: CACHE_FORMAT + 1 }));
  assert.equal(cache.get("a--one", "inputs-1"), null, "another entry format misses");
});

test("the environment digest covers Chromium, viewport, --now, timeout, fonts and the renderer's source", (t) => {
  const digest = environmentDigest(ENVIRONMENT);
  for (const change of [{ chromiumVersion: "132.0" }, { viewport: { width: 1024, height: 800 } }, { now: "2026-02-01T00:00:00.000Z" }, { timeoutMs: 30_000 }, { fonts: "other" }]) {
    assert.notEqual(environmentDigest({ ...ENVIRONMENT, ...change }), digest, JSON.stringify(change));
  }
  const { root } = sandbox(t);
  const source = path.join(root, "renderer.mjs");
  writeFileSync(source, "one");
  const withSource = environmentDigest({ ...ENVIRONMENT, sources: [source] });
  writeFileSync(source, "two");
  assert.notEqual(environmentDigest({ ...ENVIRONMENT, sources: [source] }), withSource);
  const fonts = path.join(root, "fonts");
  mkdirSync(fonts);
  const before = fontsDigest([fonts]);
  writeFileSync(path.join(fonts, "ui.woff2"), "font");
  assert.notEqual(fontsDigest([fonts]), before);
});

test("a cache hit skips the first base render and keeps the verdict for a known-changed and a known-unchanged story (ISS-14395)", async (t) => {
  const plays = {
    [BASE]: { "a--unchanged": passes(shot(GREY)), "b--changed": passes(shot(GREY)) },
    [HEAD]: { "a--unchanged": passes(shot(GREY)), "b--changed": passes(shot(GREY, BLUE)) },
  };
  const { root } = sandbox(t);
  const cache = baseRenderCache(path.join(root, "cache"), environmentDigest(ENVIRONMENT));
  const baseCache = { get: (id) => cache.get(id, "inputs"), set: (id, render) => cache.set(id, "inputs", render) };
  const run = async (browser) => frozenRenders({ ids: ["a--unchanged", "b--changed"], fileCount: 1, baseUrl: BASE, headUrl: HEAD, browser,
    out: sandbox(t).out, command: "frozen-render.mjs", baseCache });
  const cold = fakeBrowser(plays);
  const first = await run(cold);
  assert.deepEqual(baseVisits(cold), ["a--unchanged", "b--changed", "b--changed", "b--changed", "b--changed"]);
  const warm = fakeBrowser(plays);
  const second = await run(warm);
  assert.deepEqual(baseVisits(warm), ["b--changed", "b--changed", "b--changed"], "only the changed story renders the base: its second and confirmation renders");
  for (const summary of [first, second]) {
    assert.equal(summary.ok, false);
    assert.deepEqual(summary.blocking.map((story) => [story.storyId, story.reason]), [["b--changed", "the render changed"]]);
    assert.equal(summary.identical, 1);
  }
});

test("a cached base a fresh render does not reproduce is replaced and the story judged on fresh renders (ISS-14395)", async (t) => {
  const { root } = sandbox(t);
  const cache = baseRenderCache(path.join(root, "cache"), environmentDigest(ENVIRONMENT));
  const store = { get: (id) => cache.get(id, "inputs"), set: (id, render) => cache.set(id, "inputs", render) };
  const run = (id, base, head) => frozenRenders({ ids: [id], fileCount: 1, baseUrl: BASE, headUrl: HEAD, out: sandbox(t).out, command: "frozen-render.mjs",
    browser: fakeBrowser({ [BASE]: { [id]: base }, [HEAD]: { [id]: head } }), baseCache: store });
  const pass = "completed with no exception or error event";

  // A stale entry the branch matches neither way: the fresh base agrees with the branch, so the story is identical.
  cache.set("a--story", "inputs", { verdict: "PASS", reason: pass, failure: null, rawPngHash: "stale", events: [], screenshot: shot(GREY, BLUE) });
  const refreshed = await run("a--story", passes(shot(GREY)), passes(shot(GREY)));
  assert.deepEqual([refreshed.ok, refreshed.identical, refreshed.unstableOnBase.length], [true, 1, 0]);
  assert.notEqual(cache.get("a--story", "inputs").rawPngHash, "stale", "the entry is overwritten with the fresh render");

  // A stale entry must not hide a real change as an unstable base: the fresh base is grey, the branch blue.
  cache.set("b--story", "inputs", { verdict: "PASS", reason: pass, failure: null, rawPngHash: "stale", events: [], screenshot: shot(GREY, BLUE) });
  const changed = await run("b--story", passes(shot(GREY)), passes(shot(BLUE)));
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.blocking.map((story) => [story.storyId, story.reason]), [["b--story", "the render changed"]]);

  // A cached base failure a fresh base does not repeat is stale too.
  cache.set("c--story", "inputs", { verdict: "FAIL", reason: "storyThrewException fired", failure: { type: "storyThrewException", message: "flake" }, rawPngHash: "f", events: [], screenshot: shot(GREY) });
  const flaked = await run("c--story", passes(shot(GREY)), passes(shot(GREY)));
  assert.deepEqual([flaked.ok, flaked.identical, flaked.unstableOnBase.length], [true, 1, 0]);
});

/** A repository with two frozen story files, a shared component and render manifests, committed as the base. */
function repository(t) {
  const home = makeHome("vibe-frozen-cache-");
  t.after(home.cleanup);
  const checkout = path.join(home.root, "wt");
  git(home.root, ["init", "--quiet", "--initial-branch=main", checkout], home.home);
  const files = {
    "apps/storybook/stories/first.stories.tsx": 'import { First } from "@repo/design-system/components/first";\nexport default { title: "Composites v1.0/First", tags: ["v1.0"] };\nexport const Default = {};\n',
    "apps/storybook/stories/second.stories.tsx": 'export default { title: "Composites v1.0/Second", tags: ["v1.0"] };\nexport const Default = {};\n',
    "packages/design-system/components/first.tsx": "export const First = 1;\n",
    "apps/storybook/.storybook/preview.tsx": 'import "./preview.css";\n',
    "apps/storybook/.storybook/preview.css": ":root { color: red; }\n",
    "apps/storybook/package.json": JSON.stringify({ name: "storybook", version: "1.0.0", dependencies: { react: "^19" } }),
    "docs/notes.md": "notes\n",
  };
  const commit = (changes) => {
    for (const [file, text] of Object.entries(changes)) {
      mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
      writeFileSync(path.join(checkout, file), text);
    }
    git(checkout, ["add", "-A"], home.home);
    git(checkout, ["commit", "--quiet", "-m", "change"], home.home);
    return git(checkout, ["rev-parse", "HEAD"], home.home);
  };
  return { checkout, home, commit, base: commit(files) };
}

test("a story file's base input digest follows its import closure, global inputs and overlay, not unrelated or version-only edits", (t) => {
  const { checkout, commit, base } = repository(t);
  const first = "apps/storybook/stories/first.stories.tsx";
  const second = "apps/storybook/stories/second.stories.tsx";
  const digests = (ref, overlays) => frozenBaseInputDigests(checkout, ref, [first, second], overlays);
  const original = digests(base);
  const unrelated = digests(commit({ "docs/notes.md": "changed\n" }));
  assert.deepEqual(unrelated, original, "an unrelated file keeps both");
  const versionOnly = digests(commit({ "apps/storybook/package.json": JSON.stringify({ name: "storybook", version: "1.1.0", dependencies: { react: "^19.1" } }) }));
  assert.deepEqual(versionOnly, original, "a version or specifier edit to a render manifest keeps both");
  const component = digests(commit({ "packages/design-system/components/first.tsx": "export const First = 2;\n" }));
  assert.notEqual(component.get(first), original.get(first), "a closure file changes its story");
  assert.equal(component.get(second), original.get(second), "and leaves the other story's");
  const global = digests(commit({ "apps/storybook/.storybook/preview.css": ":root { color: blue; }\n" }));
  assert.notEqual(global.get(first), component.get(first));
  assert.notEqual(global.get(second), component.get(second), "a preview stylesheet changes every story");
  const overlaid = frozenBaseInputDigests(checkout, base, [first, second], new Map([[first, "repaired head text"]]));
  assert.notEqual(overlaid.get(first), original.get(first), "prepare-base's overlay changes its story");
  assert.equal(overlaid.get(second), original.get(second));
});

test("frozenStoryFiles with a cache directory reuses the first run's base renders on the next run (ISS-14395)", async (t) => {
  const { checkout, base } = repository(t);
  writeFileSync(path.join(checkout, "packages/design-system/components/first.tsx"), "export const First = 3;\n");
  const id = storyId("Composites v1.0/First", "Default");
  const plays = { [BASE]: { [id]: passes(shot(GREY)) }, [HEAD]: { [id]: passes(shot(GREY)) } };
  const { root } = sandbox(t);
  const cacheDir = path.join(root, "cache");
  const run = async (browser) => frozenStoryFiles({ repo: checkout, base, storyFiles: ["apps/storybook/stories/first.stories.tsx"], out: sandbox(t).out,
    baseUrl: BASE, headUrl: HEAD, browser, cacheDir });
  const cold = fakeBrowser(plays);
  const warm = fakeBrowser(plays);
  const first = await run(cold);
  const second = await run(warm);
  assert.deepEqual([baseVisits(cold), baseVisits(warm)], [[id], []]);
  assert.deepEqual([first.ok, second.ok, first.identical, second.identical], [true, true, 1, 1]);
  const uncached = fakeBrowser(plays);
  await frozenStoryFiles({ repo: checkout, base, storyFiles: ["apps/storybook/stories/first.stories.tsx"], out: sandbox(t).out, baseUrl: BASE, headUrl: HEAD, browser: uncached });
  assert.deepEqual(baseVisits(uncached), [id], "no cache directory, no reuse");
});
