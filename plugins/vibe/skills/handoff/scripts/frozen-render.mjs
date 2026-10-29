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
//   frozen-render.mjs prepare-base --repo <session worktree> --base <base commit>
//                     --story-file <path> [--story-file ...] --dir <new worktree>
//
// A frozen story file the session repaired without changing its title, tags or
// story names (a compile-only repair, the inventory's `compileOnlyV1Repairs`
// test) keeps its story IDs, but its base text may hold the broken play the
// session fixed. Comparing each commit's own story file would then always
// differ. So `prepare-base` makes the base worktree for the base Storybook: a
// detached worktree at the base commit with only those repaired story files
// taken from the session, so both Storybooks run the head's story file and
// only the app code differs. The run names those stories. A frozen story file
// changed in any other way is not compared: its stories block.
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
//                     Before it is reported the story is rendered twice more
//                     on the base and judged again over every base render, so
//                     a base that only matched itself by chance ends up
//                     unstable-on-base. A cropped diff goes under --out when
//                     the pixels differ.
// Prints one line per story, a summary line and, when nothing blocks, the
// `Frozen render unchanged: all N story files (M stories): frozen-render.mjs`
// line handoff's diff rules accept. Full screenshots and results.json stay
// under --out; read only the cropped diffs. Exits 0 when nothing blocks, 1
// when something does, 2 on a usage or setup error.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PLAY_EVENT_RECORDER, playVerdicts } from "../../vibe/scripts/story-play-verdict.mjs";
import { storyId } from "./diff-rules.mjs";
import { cropDiffPng, decodePng, pixelHash } from "./png-diff.mjs";
import { keepsStoryIdentity, storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";

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
const WHITESPACE_RUN = /\s+/g;
const FINISH_EVENTS = Object.freeze(["storyFinished", "storyThrewException", "storyErrored", "playFunctionThrewException", "storyMissing", "unhandledErrorsWhilePlaying"]);
const Side = Object.freeze({ Base: "base", BaseAgain: "base-again", Head: "head", BaseConfirm: "base-confirm" });
/** Extra base renders a blocking story gets before its verdict is reported. */
export const CONFIRM_RENDERS = 2;
export const StoryFileChange = Object.freeze({ Unchanged: "unchanged", Repaired: "repaired", Changed: "changed" });
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Every story ID in `storyFiles`, read from their text at `base` in `repo`. */
export function frozenStoryIds(repo, base, storyFiles) {
  return storyFiles.flatMap((file) => {
    const text = baseText(repo, base, file);
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
 * The outcome for one story from its base renders (two, or more after a confirmation) and its branch render. `diff`
 * names the two renders whose cropped diff is owed.
 */
export function classifyStory(bases, head) {
  const [base] = bases;
  const basePlays = new Set(bases.map(playOutcome));
  const renders = bases.length === 2 ? "the two base renders" : `the ${bases.length} base renders`;
  if (!basePlays.has(playOutcome(head))) {
    return { outcome: FrozenOutcome.Blocking, reason: playChange(bases, head, renders), diff: [base, head] };
  }
  if (basePlays.size > 1) {
    return { outcome: FrozenOutcome.UnstableOnBase, reason: `the play's outcome differs between ${renders}; the branch matches one of them`,
      diff: [base, bases.find((render) => playOutcome(render) !== playOutcome(base))] };
  }
  if (base.verdict === "FAIL") {
    return { outcome: FrozenOutcome.SameFailure, reason: `fails the same way on the base: ${describePlay(base)}` };
  }
  const varied = bases.find((render) => render.pixels !== base.pixels);
  if (varied) {
    return { outcome: FrozenOutcome.UnstableOnBase, reason: `${renders} differ`, diff: [base, varied] };
  }
  if (base.pixels !== head.pixels) {
    return { outcome: FrozenOutcome.Blocking, reason: "the render changed", diff: [base, head] };
  }
  return { outcome: FrozenOutcome.Identical };
}

/** Renders every story twice on the base and once on the branch; `head` identifies the checked-out commit in its proof line. */
export async function frozenRenders({ ids, fileCount, baseUrl, headUrl, browser, out, viewport, timeoutMs, now, command, head, inputs, repairedIds = new Map(), refused = [] }) {
  const stories = [];
  const options = { viewport, timeoutMs, now };
  for (const id of ids) {
    const renders = {
      [Side.Base]: await renderStory(browser, baseUrl, id, options),
      [Side.BaseAgain]: await renderStory(browser, baseUrl, id, options),
      [Side.Head]: await renderStory(browser, headUrl, id, options),
    };
    for (const [side, render] of Object.entries(renders)) {
      saveScreenshot(out, side, id, render);
    }
    let { diff, ...result } = classifyStory([renders[Side.Base], renders[Side.BaseAgain]], renders[Side.Head]);
    if (result.outcome === FrozenOutcome.Blocking) {
      // A base that matched itself twice can still vary (ISS-13167): a blocking verdict stands only after more base renders agree.
      for (let n = 1; n <= CONFIRM_RENDERS; n++) {
        renders[`${Side.BaseConfirm}-${n}`] = await renderStory(browser, baseUrl, id, options);
        saveScreenshot(out, `${Side.BaseConfirm}-${n}`, id, renders[`${Side.BaseConfirm}-${n}`]);
      }
      const bases = Object.entries(renders).filter(([side]) => side !== Side.Head).map(([, render]) => render);
      ({ diff, ...result } = classifyStory(bases, renders[Side.Head]));
      result.confirmRenders = CONFIRM_RENDERS;
      if (result.outcome !== FrozenOutcome.Blocking) {
        result.reason = `${result.reason} (found by ${CONFIRM_RENDERS} more base renders after a blocking first comparison)`;
      }
    }
    const crop = diff ? writeCrop(out, id, diff[0].screenshot, diff[1].screenshot) : null;
    stories.push({ storyId: id, ...result, ...(crop ? { crop } : {}), ...(repairedIds.has(id) ? { headStoryFile: repairedIds.get(id) } : {}),
      renders: Object.fromEntries(Object.entries(renders).map(([side, { screenshot, ...rest }]) => [side, rest])) });
  }
  stories.push(...refused.map((story) => ({ ...story, outcome: FrozenOutcome.Blocking })));
  return summarize(stories, { fileCount, out, command, head, inputs });
}

/**
 * What the CLI runs: every story in `storyFiles` (read at `base`), with the line counting story files and
 * their stories in parentheses. It pins HEAD before rendering and withholds the line if HEAD changes.
 */
export async function frozenStoryFiles({ repo, base, storyFiles, ...render }) {
  const files = [...new Set(storyFiles)];
  const changes = storyFileChanges(repo, base, files);
  const idsOf = (change) => frozenStoryIds(repo, base, [change.file]);
  const compared = changes.filter((change) => change.change !== StoryFileChange.Changed);
  const repairedIds = new Map(compared.filter((change) => change.change === StoryFileChange.Repaired)
    .flatMap((change) => idsOf(change).map((id) => [id, change.file])));
  const refused = changes.filter((change) => change.change === StoryFileChange.Changed).flatMap((change) => idsOf(change).map((id) => ({
    storyId: id, reason: `${change.file} changed beyond a compile-only repair (${change.headText === null ? "it is gone" : "its title, tags or story names differ"}), so it is not compared`,
  })));
  const command = `frozen-render.mjs --base ${base} --story-file ${files.join(" --story-file ")}`;
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const inputs = frozenInputs(repo, base);
  const summary = await frozenRenders({ ...render, ids: compared.flatMap(idsOf), fileCount: files.length, command, head, inputs, repairedIds, refused });
  // A commit or edit during rendering changes the proof's source identity, even when file bytes end up identical.
  if (summary.changeLogLine && (execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== head
    || frozenInputs(repo, base) !== inputs)) {
    const { changeLogLine, ...rest } = summary;
    return { ...rest, ok: false, lines: [...rest.lines, "the session's files changed during the run; run it again"] };
  }
  return summary;
}

/**
 * What the head side rendered: a digest of every file the session checkout differs from `base` in, tracked or
 * untracked, with its content. The recorded line carries it beside the exact head SHA, and the diff rules require
 * both to match. A later commit with the same file bytes still needs a new render (ISS-13321).
 */
export function frozenInputs(repo, base) {
  const run = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
  const files = [...new Set([...run(["diff", "--name-only", "--no-renames", base]).split("\n"), ...run(["ls-files", "--others", "--exclude-standard"]).split("\n")])]
    .filter((file) => file && !file.startsWith(".closedloop-ai/vibe-plans/")).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const absolute = path.join(repo, file);
    hash.update(`${file}\0${existsSync(absolute) ? createHash("sha256").update(readFileSync(absolute)).digest("hex") : "deleted"}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * How each story file in the session worktree differs from its text at `base`: unchanged, repaired (a
 * compile-only repair that keeps every story ID) or changed in any other way, including gone.
 */
export function storyFileChanges(repo, base, storyFiles) {
  return storyFiles.map((file) => {
    const before = baseText(repo, base, file);
    const headPath = path.join(repo, file);
    const headText = existsSync(headPath) ? readFileSync(headPath, "utf8") : null;
    if (headText === before) {
      return { file, change: StoryFileChange.Unchanged, headText };
    }
    return { file, change: headText !== null && keepsStoryIdentity(before, headText) ? StoryFileChange.Repaired : StoryFileChange.Changed, headText };
  });
}

/**
 * Makes `dir` a detached worktree of `repo` at `base` for the base Storybook, with each compile-only repaired story
 * file in `storyFiles` replaced by the session's text, so both Storybooks run the head's story file.
 */
export function prepareBase({ repo, base, storyFiles, dir }) {
  if (existsSync(dir)) {
    throw new Error(`${dir} already exists; prepare-base makes a new worktree`);
  }
  const changes = storyFileChanges(repo, base, [...new Set(storyFiles)]);
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", dir, base], { stdio: ["ignore", "pipe", "pipe"] });
  const repaired = changes.filter((change) => change.change === StoryFileChange.Repaired);
  for (const change of repaired) {
    writeFileSync(path.join(dir, change.file), change.headText);
  }
  return { dir, base, headStoryFiles: repaired.map((change) => change.file),
    notCompared: changes.filter((change) => change.change === StoryFileChange.Changed).map((change) => change.file) };
}

/** One line per story, as the CLI prints it. */
export function storyLine(story) {
  const repaired = story.headStoryFile ? `; head story file on both sides (compile-only repair of ${story.headStoryFile})` : "";
  return `${story.outcome} ${story.storyId}${story.reason ? `: ${story.reason}` : ""}${repaired}${story.crop ? `; diff ${story.crop}` : ""}`;
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

function baseText(repo, base, file) {
  return execFileSync("git", ["-C", repo, "show", `${base}:${file}`], { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

/** The verdict reason and failure text on one line, so each story stays one line of output. */
function describePlay(render) {
  return `${render.reason}${render.failure?.message ? `: ${render.failure.message.replace(WHITESPACE_RUN, " ").trim()}` : ""}`;
}

function playChange(bases, head, renders) {
  const [base] = bases;
  if (new Set(bases.map(playOutcome)).size > 1) {
    return `the play's outcome differs between ${renders} and the branch matches none of them: branch ${head.verdict} (${describePlay(head)})`;
  }
  if (base.verdict !== head.verdict) {
    return `play ${base.verdict} on the base, ${head.verdict} on the branch${head.verdict === "FAIL" ? ` (${describePlay(head)})` : ""}`;
  }
  return `the failure changed: base ${describePlay(base)}, branch ${describePlay(head)}`;
}

function saveScreenshot(out, side, id, render) {
  mkdirSync(path.join(out, side), { recursive: true });
  writeFileSync(path.join(out, side, `${id}.png`), render.screenshot);
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

function summarize(stories, { fileCount, out, command, head, inputs }) {
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
  const headFiles = [...new Set(stories.map((story) => story.headStoryFile).filter(Boolean))];
  const repaired = headFiles.length ? `; head story file on both sides for ${headFiles.length} compile-only repaired story files (${headFiles.join(", ")})` : "";
  const summary = {
    ok, storyFiles: fileCount, stories: stories.length, identical, unstableOnBase, sameFailure, blocking,
    lines: [...stories.map(storyLine), `summary: ${stories.length} stories in ${fileCount} story files: ${counts}${repaired}; results ${results}`],
    ...(ok ? { changeLogLine: `Frozen render unchanged: all ${fileCount} story files (${stories.length} stories): ${command}: ${counts}${repaired}${head ? `; head ${head}` : ""}${inputs ? `; inputs ${inputs}` : ""}; ${results}` } : {}),
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
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    repo: { type: "string" }, base: { type: "string" }, "base-url": { type: "string" }, "head-url": { type: "string" },
    "story-file": { type: "string", multiple: true }, out: { type: "string" }, viewport: { type: "string" }, "timeout-ms": { type: "string" },
    now: { type: "string" }, dir: { type: "string" },
  } });
  if (positionals[0] === "prepare-base") {
    if (!values.repo || !values.base || !values["story-file"]?.length || !values.dir || positionals.length > 1) {
      throw new Error("Usage: frozen-render.mjs prepare-base --repo <worktree> --base <commit> --story-file <path> [--story-file ...] --dir <new worktree>");
    }
    const prepared = prepareBase({ repo: values.repo, base: values.base, storyFiles: values["story-file"], dir: path.resolve(values.dir) });
    return { ok: true, lines: [`prepared ${prepared.dir} at ${prepared.base}; head story file for ${prepared.headStoryFiles.length} compile-only repaired story files${prepared.headStoryFiles.length ? ` (${prepared.headStoryFiles.join(", ")})` : ""}${prepared.notCompared.length ? `; not compared, changed beyond a compile-only repair: ${prepared.notCompared.join(", ")}` : ""}`] };
  }
  if (positionals.length) {
    throw new Error(`unknown command ${positionals[0]}; the only command is prepare-base`);
  }
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
  const browser = await loadChromium(values.repo).launch({ args: [...DETERMINISTIC_CHROMIUM_ARGS] });
  try {
    return await frozenStoryFiles({ repo: values.repo, base: values.base, storyFiles: values["story-file"], baseUrl: values["base-url"],
      headUrl: values["head-url"], browser, out: path.resolve(values.out), viewport, timeoutMs, now });
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
