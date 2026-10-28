#!/usr/bin/env node
// Whether each story's play passed, judged from the Storybook channel events a
// run recorded. Storybook's `storyFinished` event reported success for a play
// that threw, so earlier "play success" verdicts read from it were false
// greens. A play passes only when its completion was observed and no
// exception or error event fired for that story; `storyFinished`'s own status
// is never trusted.
//
// Recording: inject PLAY_EVENT_RECORDER before the story loads (Playwright
// `page.addInitScript`), run the play, then read `window.__vibePlayEvents`
// and save it as JSON lines.
//
// Usage: story-play-verdict.mjs --events <events .jsonl> --story <story id> [--story <id>]...
// Prints {"ok","verdicts":[{"storyId","verdict":"PASS"|"FAIL","reason"}]}; exits 1
// when any story is not PASS. Record the verdicts as `playVerdicts` on the
// `storybook-plays` run in vibe-pr-evidence.json.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const FAILURE_EVENTS = new Set(["storyThrewException", "storyErrored", "playFunctionThrewException", "storyMissing", "unhandledErrorsWhilePlaying"]);
const COMPLETION_EVENTS = new Set(["storyFinished", "storyRendered"]);

/** Records every Storybook channel event with its story id; injected before the story loads. */
export const PLAY_EVENT_RECORDER = `(() => {
  window.__vibePlayEvents = [];
  const events = ${JSON.stringify([...FAILURE_EVENTS, ...COMPLETION_EVENTS])};
  const attach = () => {
    const channel = window.__STORYBOOK_ADDONS_CHANNEL__;
    if (!channel) return setTimeout(attach, 50);
    for (const type of events) {
      channel.on(type, (payload) => window.__vibePlayEvents.push({ type, storyId: payload?.storyId ?? payload?.id ?? null, status: payload?.status ?? null,
        message: typeof payload?.message === "string" ? payload.message.slice(0, 500) : null }));
    }
  };
  attach();
})();`;

/** One verdict per story id from the recorded events. */
export function playVerdicts(events, storyIds) {
  return storyIds.map((storyId) => {
    const own = events.filter((event) => event?.storyId === storyId);
    const failure = own.find((event) => FAILURE_EVENTS.has(event.type));
    if (failure) {
      return { storyId, verdict: "FAIL", reason: `${failure.type} fired` };
    }
    if (!own.some((event) => COMPLETION_EVENTS.has(event.type))) {
      return { storyId, verdict: "FAIL", reason: "no completion was observed" };
    }
    return { storyId, verdict: "PASS", reason: "completed with no exception or error event" };
  });
}

/** Problems with the `playVerdicts` a storybook-plays run records. */
export function playVerdictProblems(run) {
  const verdicts = Array.isArray(run?.playVerdicts) ? run.playVerdicts : [];
  if (verdicts.length === 0) {
    return ["storybook-plays: no playVerdicts; judge each play with story-play-verdict.mjs, never by storyFinished's status"];
  }
  return verdicts.filter((entry) => entry?.verdict !== "PASS").map((entry) => `storybook-plays: ${entry?.storyId ?? "a story"} is ${entry?.verdict ?? "unjudged"}${entry?.reason ? ` (${entry.reason})` : ""}`);
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { events: { type: "string" }, story: { type: "string", multiple: true } } });
  if (!values.events || !values.story?.length) {
    throw new Error("Usage: story-play-verdict.mjs --events <events .jsonl> --story <story id> [--story <id>]...");
  }
  const events = readFileSync(values.events, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const verdicts = playVerdicts(events, values.story);
  const ok = verdicts.every((entry) => entry.verdict === "PASS");
  process.stdout.write(`${JSON.stringify({ ok, verdicts }, null, 2)}\n`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
