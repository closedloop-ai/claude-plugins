#!/usr/bin/env node
// The frozen-render check for handoff and pull-request phases (ISS-13291,
// ISS-13317). The inventory's `frozen-render` finding lists frozen v1.0 story
// files whose rendered dependencies the session changed. This renders every
// story in those files twice on a Storybook serving the base and once on one
// serving the branch, waits for each play to finish, judges the play with
// story-play-verdict.mjs and compares the screenshots pixel for pixel, with
// no threshold (png-diff.mjs). Sessions never write their own capture loop for
// this gate.
//
// Usage:
//   frozen-render.mjs --repo <session worktree> --base <base commit>
//                     --base-url <Storybook URL serving the base>
//                     --head-url <Storybook URL serving the branch>
//                     --story-file <repo-relative story path> [--story-file ...]
//                     --out <dir> [--viewport 1280x800] [--timeout-ms 20000]
//                     [--now <ISO time>]
//
// Every input that could make two renders of the same code differ is pinned:
// Chromium rasterizes in software on one thread with sRGB color and no LCD
// text or font hinting; each render gets a fresh browser context with one
// viewport, scale 1, en-US, UTC, the light color scheme and reduced motion;
// the page clock is fixed at --now (timers still run, so plays finish); story
// args and globals are the story's own defaults; fonts finish loading before
// the screenshot, and the screenshot disables animations and transitions and
// hides the caret.
//
// Story IDs come from each file's base text. Playwright is loaded from the
// session repo (`playwright` or `@playwright/test`). Each story gets one
// outcome:
//   identical         the play passes on all three renders and the pixels match
//   unstable-on-base  the two base renders differ, so pixels are not compared
//                     with the branch; the branch's play outcome (verdict and
//                     error text) must still match a base one. Does not block;
//                     a cropped diff of the two base renders goes under --out.
//   same-failure      the play fails on the base and fails the same way (same
//                     verdict and error text) on the branch. Does not block.
//   blocking          anything else: a stable base render that changed, a
//                     play that passes on the base and fails on the branch, a
//                     changed failure, or a play outcome the base never had.
//                     A cropped diff goes under --out when the pixels differ.
// Prints one line per story, a summary line and, when nothing blocks, the
// `Frozen render unchanged: all N story files (M stories): frozen-render.mjs`
// line handoff's diff rules accept. Full screenshots and results.json stay
// under --out; read only the cropped diffs. Exits 0 when nothing blocks, 1
// when something does, 2 on a usage or setup error.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PLAY_EVENT_RECORDER, playVerdicts } from "../../vibe/scripts/story-play-verdict.mjs";
import { storyId } from "./diff-rules.mjs";
import { cropDiffPng, decodePng, pixelHash } from "./png-diff.mjs";
import { storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";

export const FrozenOutcome = Object.freeze({ Identical: "identical", UnstableOnBase: "unstable-on-base", SameFailure: "same-failure", Blocking: "blocking" });
/** Software rasterizing on one thread with fixed color and font handling, as the ISS-13164 capture launches Chromium. */
export const DETERMINISTIC_CHROMIUM_ARGS = Object.freeze([
  "--disable-gpu", "--disable-gpu-rasterization", "--disable-partial-raster", "--num-raster-threads=1",
  "--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text",
]);
export const PINNED_CONTEXT = Object.freeze({ deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce" });
export const DEFAULT_NOW = "2026-01-01T12:00:00.000Z";
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const DEFAULT_TIMEOUT_MS = 20_000;
const VIEWPORT = /^(\d{2,5})x(\d{2,5})$/;
const FINISH_EVENTS = Object.freeze(["storyFinished", "storyThrewException", "storyErrored", "playFunctionThrewException", "storyMissing", "unhandledErrorsWhilePlaying"]);
const Side = Object.freeze({ Base: "base", BaseAgain: "base-again", Head: "head" });

/** Every story ID in `storyFiles`, read from their text at `base` in `repo`. */
export function frozenStoryIds(repo, base, storyFiles) {
  return storyFiles.flatMap((file) => {
    const text = execFileSync("git", ["-C", repo, "show", `${base}:${file}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const title = storyMetaTitle(text);
    if (!title) {
      throw new Error(`${file} has no story title at ${base}`);
    }
    return storyExportNames(text).map((name) => storyId(title, name));
  });
}

/** One render of one story: its play verdict, first failure, screenshot and pixel hash. */
export async function renderStory(browser, url, id, { viewport = DEFAULT_VIEWPORT, timeoutMs = DEFAULT_TIMEOUT_MS, now = DEFAULT_NOW } = {}) {
  // A fresh context per render, so storage or cache one render leaves behind never reaches the next.
  const context = await browser.newContext({ viewport, ...PINNED_CONTEXT });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(now));
    await page.addInitScript(PLAY_EVENT_RECORDER);
    await page.goto(`${url.replace(/\/+$/, "")}/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`, { waitUntil: "load", timeout: timeoutMs });
    let finished = true;
    try {
      // The iframe renders only this story, so an event Storybook sent without a story ID is its own.
      await page.waitForFunction(([storyIdArg, types]) => (window.__vibePlayEvents ?? [])
        .some((event) => (event.storyId ?? storyIdArg) === storyIdArg && types.includes(event.type)), [id, FINISH_EVENTS], { timeout: timeoutMs });
    } catch {
      finished = false;
    }
    const events = (await page.evaluate(() => window.__vibePlayEvents ?? [])).map((event) => ({ ...event, storyId: event.storyId ?? id }));
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const screenshot = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css", fullPage: true });
    const verdict = finished ? playVerdicts(events, [id])[0]
      : { storyId: id, verdict: "FAIL", reason: `the play did not finish within ${timeoutMs} ms` };
    const failure = events.find((event) => event.storyId === id && FINISH_EVENTS.includes(event.type) && event.type !== "storyFinished");
    return { verdict: verdict.verdict, reason: verdict.reason, failure: failure ? { type: failure.type, message: failure.message ?? null } : null,
      pixels: pixelHash(decodePng(screenshot)), screenshot, events };
  } finally {
    await context.close();
  }
}

/**
 * The outcome for one story from its two base renders and its branch render.
 * `diff` names the two renders whose cropped diff is owed.
 */
export function classifyStory(base, again, head) {
  const basePlays = new Set([playOutcome(base), playOutcome(again)]);
  if (!basePlays.has(playOutcome(head))) {
    return { outcome: FrozenOutcome.Blocking, reason: playChange(base, again, head), diff: [Side.Base, Side.Head] };
  }
  if (basePlays.size > 1) {
    return { outcome: FrozenOutcome.UnstableOnBase, reason: "the play's outcome differs between the two base renders; the branch matches one of them", diff: [Side.Base, Side.BaseAgain] };
  }
  if (base.verdict === "FAIL") {
    return { outcome: FrozenOutcome.SameFailure, reason: `fails the same way on the base: ${describePlay(base)}` };
  }
  if (base.pixels !== again.pixels) {
    return { outcome: FrozenOutcome.UnstableOnBase, reason: "the two base renders differ", diff: [Side.Base, Side.BaseAgain] };
  }
  if (base.pixels !== head.pixels) {
    return { outcome: FrozenOutcome.Blocking, reason: "the render changed", diff: [Side.Base, Side.Head] };
  }
  return { outcome: FrozenOutcome.Identical };
}

/** Renders every story twice on the base and once on the branch and returns the summary; writes evidence under `out`. */
export async function frozenRenders({ ids, fileCount, baseUrl, headUrl, browser, out, viewport, timeoutMs, now, command }) {
  const stories = [];
  const options = { viewport, timeoutMs, now };
  for (const id of ids) {
    const renders = {
      [Side.Base]: await renderStory(browser, baseUrl, id, options),
      [Side.BaseAgain]: await renderStory(browser, baseUrl, id, options),
      [Side.Head]: await renderStory(browser, headUrl, id, options),
    };
    for (const [side, render] of Object.entries(renders)) {
      mkdirSync(path.join(out, side), { recursive: true });
      writeFileSync(path.join(out, side, `${id}.png`), render.screenshot);
    }
    const { diff, ...result } = classifyStory(renders[Side.Base], renders[Side.BaseAgain], renders[Side.Head]);
    const crop = diff ? writeCrop(out, id, renders[diff[0]].screenshot, renders[diff[1]].screenshot) : null;
    stories.push({ storyId: id, ...result, ...(crop ? { crop } : {}),
      renders: Object.fromEntries(Object.entries(renders).map(([side, { screenshot, ...rest }]) => [side, rest])) });
  }
  return summarize(stories, { fileCount, out, command });
}

/** One line per story, as the CLI prints it. */
export function storyLine(story) {
  return `${story.outcome} ${story.storyId}${story.reason ? `: ${story.reason}` : ""}${story.crop ? `; diff ${story.crop}` : ""}`;
}

/** Playwright's chromium from the session repo, so the plugin ships no browser dependency. */
export function loadChromium(repo) {
  const require = createRequire(path.join(path.resolve(repo), "package.json"));
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      return require(name).chromium;
    } catch {
      // Try the next package name.
    }
  }
  throw new Error(`Playwright is not installed in ${repo}; run the repo's bootstrap first`);
}

/** The verdict, reason and failure text that must match for two plays to count as the same outcome. */
function playOutcome(render) {
  return JSON.stringify([render.verdict, render.reason, render.failure?.type ?? null, render.failure?.message ?? null]);
}

function describePlay(render) {
  return `${render.reason}${render.failure?.message ? `: ${render.failure.message}` : ""}`;
}

function playChange(base, again, head) {
  if (playOutcome(base) !== playOutcome(again)) {
    return `the play's outcome differs between the two base renders and the branch matches neither: branch ${head.verdict} (${describePlay(head)})`;
  }
  if (base.verdict !== head.verdict) {
    return `play ${base.verdict} on the base, ${head.verdict} on the branch${head.verdict === "FAIL" ? ` (${describePlay(head)})` : ""}`;
  }
  return `the failure changed: base ${describePlay(base)}, branch ${describePlay(head)}`;
}

/** The cropped side-by-side diff of two screenshots under `out/diffs`, or null when their pixels match. */
function writeCrop(out, id, before, after) {
  const cropped = cropDiffPng(before, after);
  if (!cropped) {
    return null;
  }
  const file = path.join(out, "diffs", `${id}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, cropped.png);
  return file;
}

function summarize(stories, { fileCount, out, command }) {
  const pick = (outcome) => stories.filter((story) => story.outcome === outcome);
  const entry = ({ storyId: id, reason, crop }) => ({ storyId: id, reason, ...(crop ? { crop } : {}) });
  const identical = pick(FrozenOutcome.Identical).length;
  const unstableOnBase = pick(FrozenOutcome.UnstableOnBase).map(entry);
  const sameFailure = pick(FrozenOutcome.SameFailure).map(entry);
  const blocking = pick(FrozenOutcome.Blocking).map(entry);
  const results = path.join(out, "results.json");
  const named = (list) => (list.length ? ` (${list.map((story) => story.storyId).join(", ")})` : "");
  const counts = `${identical} identical, ${unstableOnBase.length} unstable on base${named(unstableOnBase)}, ${sameFailure.length} same failure${named(sameFailure)}, ${blocking.length} blocking`;
  const ok = blocking.length === 0 && stories.length > 0;
  const summary = {
    ok, storyFiles: fileCount, stories: stories.length, identical, unstableOnBase, sameFailure, blocking,
    lines: [...stories.map(storyLine), `summary: ${stories.length} stories in ${fileCount} story files: ${counts}; results ${results}`],
    ...(ok ? { changeLogLine: `Frozen render unchanged: all ${fileCount} story files (${stories.length} stories): ${command}: ${counts}; ${results}` } : {}),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(results, `${JSON.stringify({ ...summary, details: stories }, null, 2)}\n`);
  return summary;
}

function parseViewport(text) {
  if (text === undefined) {
    return DEFAULT_VIEWPORT;
  }
  const match = VIEWPORT.exec(text);
  if (!match) {
    throw new Error("--viewport must be <width>x<height>, such as 1280x800");
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, base: { type: "string" }, "base-url": { type: "string" }, "head-url": { type: "string" },
    "story-file": { type: "string", multiple: true }, out: { type: "string" }, viewport: { type: "string" }, "timeout-ms": { type: "string" },
    now: { type: "string" },
  } });
  if (!values.repo || !values.base || !values["base-url"] || !values["head-url"] || !values["story-file"]?.length || !values.out) {
    throw new Error("Usage: frozen-render.mjs --repo <worktree> --base <commit> --base-url <url> --head-url <url> --story-file <path> [--story-file ...] --out <dir> [--viewport WxH] [--timeout-ms N] [--now <ISO time>]");
  }
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error("--timeout-ms must be a whole number of at least 1000");
  }
  const now = values.now ?? DEFAULT_NOW;
  if (Number.isNaN(Date.parse(now))) {
    throw new Error("--now must be an ISO time, such as 2026-01-01T12:00:00.000Z");
  }
  const viewport = parseViewport(values.viewport);
  const storyFiles = [...new Set(values["story-file"])];
  const ids = frozenStoryIds(values.repo, values.base, storyFiles);
  const browser = await loadChromium(values.repo).launch({ args: [...DETERMINISTIC_CHROMIUM_ARGS] });
  try {
    const command = `frozen-render.mjs --base ${values.base} --story-file ${storyFiles.join(" --story-file ")}`;
    return await frozenRenders({ ids, fileCount: storyFiles.length, baseUrl: values["base-url"], headUrl: values["head-url"], browser,
      out: path.resolve(values.out), viewport, timeoutMs, now, command });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const summary = await main(process.argv.slice(2));
    process.stdout.write(`${[...summary.lines, ...(summary.changeLogLine ? [summary.changeLogLine] : [])].join("\n")}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
