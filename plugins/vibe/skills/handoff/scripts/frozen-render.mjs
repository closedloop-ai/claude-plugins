#!/usr/bin/env node
// The frozen-render check for handoff and pull-request phases (ISS-13291).
// The inventory's `frozen-render` finding lists frozen v1.0 story files whose
// rendered dependencies the session changed. This renders every story in
// those files on a Storybook serving the base and on one serving the branch,
// with the same viewport and no args or globals, waits for each play to
// finish, and judges the play with story-play-verdict.mjs.
//
// Usage:
//   frozen-render.mjs --repo <session worktree> --base <base commit>
//                     --base-url <Storybook URL serving the base>
//                     --head-url <Storybook URL serving the branch>
//                     --story-file <repo-relative story path> [--story-file ...]
//                     --out <dir> [--viewport 1280x800] [--timeout-ms 20000]
//
// Story IDs come from each file's base text. Playwright is loaded from the
// session repo (`playwright` or `@playwright/test`). Each story gets one
// outcome:
//   identical           both plays PASS and the screenshots are byte-identical
//   known-main-failure  both plays FAIL with the same failure event and message;
//                       the session did not cause it and it does not block. It
//                       goes on the live ticket's Known main failures.
//   differs             anything else; it blocks
// Prints {"ok","stories","identical","knownMainFailures","differs",
// "changeLogLine"?} and writes it, with each side's events and screenshots,
// under --out. Exits 0 when nothing differs, 1 when something does, 2 on a
// usage or setup error. With nothing differing, `changeLogLine` is the
// `Frozen render unchanged: all N stories: ...` line handoff's diff rules read.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PLAY_EVENT_RECORDER, playVerdicts } from "../../vibe/scripts/story-play-verdict.mjs";
import { storyId } from "./diff-rules.mjs";
import { storyExportNames, storyMetaTitle } from "./storybook-taxonomy.mjs";

export const FrozenOutcome = Object.freeze({ Identical: "identical", KnownMainFailure: "known-main-failure", Differs: "differs" });
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const DEFAULT_TIMEOUT_MS = 20_000;
const VIEWPORT = /^(\d{2,5})x(\d{2,5})$/;
const FINISH_EVENTS = Object.freeze(["storyFinished", "storyThrewException", "storyErrored", "playFunctionThrewException", "storyMissing", "unhandledErrorsWhilePlaying"]);

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

/** One story on one side: its play verdict, first failure and screenshot digest. */
export async function renderStory(browser, url, id, { viewport = DEFAULT_VIEWPORT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const page = await browser.newPage({ viewport });
  try {
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
    const screenshot = await page.screenshot({ animations: "disabled", fullPage: true });
    const verdict = finished ? playVerdicts(events, [id])[0]
      : { storyId: id, verdict: "FAIL", reason: `the play did not finish within ${timeoutMs} ms` };
    const failure = events.find((event) => event.storyId === id && FINISH_EVENTS.includes(event.type) && event.type !== "storyFinished");
    return { verdict: verdict.verdict, reason: verdict.reason, failure: failure ? { type: failure.type, message: failure.message ?? null } : null,
      sha256: createHash("sha256").update(screenshot).digest("hex"), screenshot, events };
  } finally {
    await page.close();
  }
}

/** The outcome for one story from its base and branch renders. */
export function compareRenders(base, head) {
  if (base.verdict === "PASS" && head.verdict === "PASS" && base.sha256 === head.sha256) {
    return { outcome: FrozenOutcome.Identical };
  }
  if (base.verdict === "FAIL" && head.verdict === "FAIL" && base.reason === head.reason
    && JSON.stringify(base.failure) === JSON.stringify(head.failure)) {
    return { outcome: FrozenOutcome.KnownMainFailure, reason: `fails the same way on the base: ${base.reason}${base.failure?.message ? `: ${base.failure.message}` : ""}` };
  }
  const why = base.verdict !== head.verdict ? `play ${base.verdict} on the base, ${head.verdict} on the branch`
    : base.verdict === "PASS" ? "the render changed" : `the failure changed: base ${base.reason}, branch ${head.reason}`;
  return { outcome: FrozenOutcome.Differs, reason: why };
}

/** Renders every story on both sides and returns the summary; writes evidence under `out`. */
export async function frozenRenders({ ids, baseUrl, headUrl, browser, out, viewport, timeoutMs, command }) {
  const stories = [];
  for (const id of ids) {
    const base = await renderStory(browser, baseUrl, id, { viewport, timeoutMs });
    const head = await renderStory(browser, headUrl, id, { viewport, timeoutMs });
    for (const [side, render] of [["base", base], ["head", head]]) {
      mkdirSync(path.join(out, side), { recursive: true });
      writeFileSync(path.join(out, side, `${id}.png`), render.screenshot);
    }
    const strip = ({ screenshot, ...rest }) => rest;
    stories.push({ storyId: id, ...compareRenders(base, head), base: strip(base), head: strip(head) });
  }
  const pick = (outcome) => stories.filter((story) => story.outcome === outcome);
  const knownMainFailures = pick(FrozenOutcome.KnownMainFailure).map((story) => ({ storyId: story.storyId, reason: story.reason }));
  const differs = pick(FrozenOutcome.Differs).map((story) => ({ storyId: story.storyId, reason: story.reason }));
  const identical = pick(FrozenOutcome.Identical).length;
  const results = path.join(out, "results.json");
  const known = knownMainFailures.length ? ` (${knownMainFailures.map((story) => story.storyId).join(", ")})` : "";
  const summary = {
    ok: differs.length === 0, stories: stories.length, identical, knownMainFailures, differs,
    ...(differs.length === 0 && stories.length > 0 ? { changeLogLine: `Frozen render unchanged: all ${stories.length} stories: ${command}: ${identical} identical, ${knownMainFailures.length} known main failures${known}; ${results}` } : {}),
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(results, `${JSON.stringify({ ...summary, details: stories }, null, 2)}\n`);
  return summary;
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
  } });
  if (!values.repo || !values.base || !values["base-url"] || !values["head-url"] || !values["story-file"]?.length || !values.out) {
    throw new Error("Usage: frozen-render.mjs --repo <worktree> --base <commit> --base-url <url> --head-url <url> --story-file <path> [--story-file ...] --out <dir> [--viewport WxH] [--timeout-ms N]");
  }
  const timeoutMs = values["timeout-ms"] === undefined ? DEFAULT_TIMEOUT_MS : Number(values["timeout-ms"]);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new Error("--timeout-ms must be a whole number of at least 1000");
  }
  const viewport = parseViewport(values.viewport);
  const ids = frozenStoryIds(values.repo, values.base, values["story-file"]);
  const browser = await loadChromium(values.repo).launch();
  try {
    const command = `frozen-render.mjs --base ${values.base} --story-file ${values["story-file"].join(" --story-file ")}`;
    return await frozenRenders({ ids, baseUrl: values["base-url"], headUrl: values["head-url"], browser, out: path.resolve(values.out), viewport, timeoutMs, command });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const summary = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 2;
  }
}
