// The stand-in Storybooks and browser the frozen-render tests drive.
import path from "node:path";
import { encodePng } from "./png-diff.mjs";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";

export const BASE = "http://storybook-base";
export const HEAD = "http://storybook-head";

/** A small solid screenshot, with one pixel of `dot` color when given. */
export function shot(color, dot) {
  const [width, height] = [6, 4];
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...color, 255], i * 4);
  if (dot) data.set([...dot, 255], (2 * width + 3) * 4);
  return encodePng({ width, height, data });
}

export const GREY = [200, 200, 200];
export const BLUE = [0, 0, 255];

/**
 * A stand-in for Playwright's browser. `plays[url][storyId]` is what that Storybook does for the story, either one
 * play or a list consumed render by render: the channel events it emits ({type, storyId?, message?}; none means the
 * play never finishes) and its screenshot.
 */
export function fakeBrowser(plays) {
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

export const passes = (png) => ({ events: [{ type: "storyRendered" }, { type: "storyFinished", status: "success" }], png });
export const throws = (message, png = shot([255, 0, 0])) => ({ events: [{ type: "storyThrewException", message }, { type: "storyFinished", status: "error" }], png });

export function sandbox(t) {
  const fixture = makeHome("vibe-frozen-render-");
  t.after(fixture.cleanup);
  return { ...fixture, out: path.join(fixture.root, "out") };
}
