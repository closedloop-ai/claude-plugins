import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { captureSettledFrozenScreenshot } from "./frozen-render-settlement.mjs";
import { encodePng } from "./png-diff.mjs";
import { FrozenOutcome, frozenRenders } from "./frozen-render.mjs";
import { BASE, BLUE, fakeBrowser, GREY, HEAD, passes, sandbox, shot } from "./frozen-render-test-fixture.mjs";

const STORY = "auth-transition--github-failure";

/** Model a story which reports PASS before React's delayed reveal commits and paints. */
function deferredBrowser({ change = false, halt = false, animate = null } = {}) {
  const browser = fakeBrowser({ [BASE]: { [STORY]: passes(shot(GREY)) }, [HEAD]: { [STORY]: passes(shot(GREY)) } });
  const open = browser.newContext;
  const captures = [];
  browser.newContext = async (...args) => {
    const context = await open(...args);
    const startPage = context.newPage;
    context.newPage = async () => {
      const page = await startPage();
      const evaluate = page.evaluate;
      const goto = page.goto;
      let origin;
      let frames = 0;
      page.goto = async (url) => { origin = new URL(url).origin; return goto(url); };
      page.evaluate = (fn, input) => {
        if (!String(fn).includes("requestAnimationFrame")) return evaluate(fn, input);
        return runInNewContext("(" + String(fn) + ")", {
          document: { getElementById: () => null, fonts: { ready: Promise.resolve() } }, setTimeout, clearTimeout,
          requestAnimationFrame(callback) {
            if (!halt) setImmediate(() => { frames += 1; callback(); });
          },
        })(input);
      };
      page.screenshot = async () => {
        captures.push({ origin, frames });
        if (animate && origin === HEAD) return animate(frames);
        // The pre-frame base and head disagree as in the reported blank-versus-content failure.
        if (frames < 2) return origin === HEAD ? shot(BLUE) : shot(GREY);
        return change && origin === HEAD ? shot(GREY, BLUE) : shot(GREY);
      };
      return page;
    };
    return context;
  };
  return { browser, captures };
}

async function compare(t, fixture, timeoutMs = 1_000) {
  const { out } = sandbox(t);
  const result = await frozenRenders({ ids: [STORY], fileCount: 1, baseUrl: BASE, headUrl: HEAD,
    browser: fixture.browser, out, timeoutMs, command: "frozen-render.mjs" });
  const [story] = JSON.parse(readFileSync(path.join(out, "results.json"), "utf8")).details;
  return { result, story };
}

test("ISS-14476 waits for delayed state to paint before comparing frozen pixels", async (t) => {
  const fixture = deferredBrowser();
  const { result, story } = await compare(t, fixture);
  assert.equal(result.ok, true);
  assert.equal(story.outcome, FrozenOutcome.Identical);
  assert.deepEqual(fixture.captures, [
    { origin: BASE, frames: 2 }, { origin: BASE, frames: 3 }, { origin: BASE, frames: 4 },
    { origin: HEAD, frames: 2 }, { origin: HEAD, frames: 3 }, { origin: HEAD, frames: 4 },
  ]);
});

test("ISS-14476 keeps a true post-paint pixel change blocking and refuses a stalled paint", async (t) => {
  const changed = deferredBrowser({ change: true });
  const { result, story } = await compare(t, changed);
  assert.equal(result.ok, false);
  assert.equal(story.reason, "the render changed");
  assert.ok(changed.captures.every(({ frames }) => frames >= 2 && frames <= 4));
  const stalled = deferredBrowser({ halt: true });
  await assert.rejects(compare(t, stalled, 15), /did not reach a painted frame/);
  assert.deepEqual(stalled.captures, []);
});

/** Exercise the evaluated DOM wait without launching Chrome. */
function emptyRootPage({ delayed = false, hidden = false, srOnly = false } = {}) {
  const events = [];
  const deadlines = [];
  let rendered = hidden || srOnly;
  const root = { matches: () => false, parentElement: null, querySelectorAll: () => [] };
  const owner = { matches: () => srOnly, parentElement: root, getClientRects: () => [{}] };
  const document = {
    fonts: { ready: Promise.resolve() }, getElementById: () => root,
    createTreeWalker() {
      let before = true;
      return { nextNode() { const next = before && rendered; before = false; return next; },
        currentNode: { parentElement: owner, textContent: "deferred story foreground" } };
    },
  };
  class Observer {
    constructor(notify) { this.notify = notify; }
    observe() {
      events.push("observe");
      if (delayed) setImmediate(() => { rendered = true; events.push("reveal"); this.notify(); });
    }
    disconnect() { events.push("disconnect"); }
  }
  const page = {
    evaluate(fn, input) {
      return runInNewContext("(" + String(fn) + ")", {
        document, NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: Observer, clearTimeout,
        setTimeout(callback, ms) { deadlines.push(ms); return setTimeout(callback, ms); },
        requestAnimationFrame(callback) { setImmediate(() => { events.push("paint"); callback(); }); },
        getComputedStyle(node) { return { display: "block", visibility: hidden && node === owner ? "hidden" : "visible", opacity: "1" }; },
      })(input);
    },
    async screenshot() { events.push("screenshot"); return shot(GREY); },
  };
  return { page, events, deadlines };
}

test("ISS-14476 waits for an empty Storybook root to receive delayed visible content", async () => {
  const { page, events } = emptyRootPage({ delayed: true });
  await captureSettledFrozenScreenshot(page, 200);
  assert.deepEqual(events, ["observe", "reveal", "disconnect", "paint", "paint", "screenshot", "paint", "screenshot", "paint", "screenshot"]);
});

test("ISS-14476 bounds intentionally empty, hidden and sr-only roots before exact capture", async () => {
  for (const behavior of [{}, { hidden: true }, { srOnly: true }]) {
    const { page, events, deadlines } = emptyRootPage(behavior);
    await captureSettledFrozenScreenshot(page, 60);
    assert.deepEqual(events, ["observe", "disconnect", "paint", "paint", "screenshot", "paint", "screenshot", "paint", "screenshot"]);
    assert.deepEqual(deadlines, [30, 60]);
  }
});

function animatedPage(frame) {
  const captures = [];
  const page = {
    evaluate(fn, input) {
      return runInNewContext("(" + String(fn) + ")", {
        document: { getElementById: () => null, fonts: { ready: Promise.resolve() } }, setTimeout, clearTimeout,
        requestAnimationFrame: (f) => setImmediate(f),
      })(input);
    },
    async screenshot() {
      const sample = frame(captures.length);
      captures.push(sample);
      return sample;
    },
  };
  return { page, captures };
}

/** Mimic a bar rectangle increasing in exact integer height before its final paint. */
function barFrame(height, color = BLUE) {
  const pixels = new Uint8Array(8 * 8 * 4).fill(255);
  for (let row = 8 - height; row < 8; row++) {
    for (const column of [3, 4]) pixels.set([...color, 255], (row * 8 + column) * 4);
  }
  return encodePng({ width: 8, height: 8, data: pixels });
}

test("ISS-14476 samples a finite Recharts-like SVG animation until the strict terminal pixel identity repeats", async () => {
  const { page, captures } = animatedPage((index) => barFrame(Math.min(index + 1, 5)));
  assert.deepEqual(await captureSettledFrozenScreenshot(page, 1_000), barFrame(5));
  assert.equal(captures.length, 7, "the final pixels must appear for three consecutive captures");
});

test("ISS-14476 waits through the measured 4.28 second force layout without extending a shorter caller budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const forceLayout = () => animatedPage((index) => {
    if (index < 5) t.mock.timers.tick(856);
    return barFrame(Math.min(index + 1, 5));
  });
  const finite = forceLayout();
  assert.deepEqual(await captureSettledFrozenScreenshot(finite.page, 20_000), barFrame(5));
  assert.equal(finite.captures.length, 7);
  const shorter = forceLayout();
  await assert.rejects(captureSettledFrozenScreenshot(shorter.page, 4_000), /did not stabilize within 4000 ms/);
});

test("ISS-14476 continuous motion at the default caller timeout still reaches the 10 second screenshot ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const continuous = animatedPage((index) => {
    t.mock.timers.tick(2_000);
    return barFrame((index % 8) + 1);
  });
  await assert.rejects(captureSettledFrozenScreenshot(continuous.page, 20_000), /did not stabilize within 10000 ms/);
  assert.equal(continuous.captures.length, 5);
});

test("ISS-14476 fails closed on continuous animation, oscillation, and missing screenshots", async () => {
  const continuous = animatedPage((index) => barFrame(5, [index & 255, (index >> 8) & 255, 255]));
  const oscillating = animatedPage((index) => barFrame(index % 2 === 0 ? 3 : 6));
  const missing = animatedPage((index) => index === 0 ? barFrame(1) : undefined);
  for (const fixture of [continuous, oscillating, missing]) {
    await assert.rejects(captureSettledFrozenScreenshot(fixture.page, 55), /frozen screenshot (?:did not stabilize|is missing)/);
    assert.ok(fixture.captures.length >= 2);
  }
});

test("ISS-14476 preserves genuine differences between stable animation endpoints", async () => {
  const base = animatedPage((index) => barFrame(Math.min(index + 1, 5)));
  const head = animatedPage((index) => barFrame(Math.min(index + 1, 6)));
  const [baseFrame, headFrame] = await Promise.all([
    captureSettledFrozenScreenshot(base.page, 1_000), captureSettledFrozenScreenshot(head.page, 1_000),
  ]);
  assert.deepEqual(baseFrame, barFrame(5));
  assert.deepEqual(headFrame, barFrame(6));
  assert.notDeepEqual(baseFrame, headFrame);
});


test("ISS-14476 records a named BLOCK and preserves the observed play when pixels never settle", async (t) => {
  const fixture = deferredBrowser({ animate: (frame) => barFrame(frame % 2 === 0 ? 2 : 6) });
  const { result, story } = await compare(t, fixture, 60);
  assert.equal(result.ok, false);
  assert.equal(story.outcome, FrozenOutcome.Blocking);
  assert.equal(story.pixelStabilityBlocked, true);
  assert.match(story.reason, /head: frozen screenshot did not stabilize/);
  assert.equal(story.renders.head.verdict, "PASS");
  assert.ok(story.renders.head.rawPngHash, "the last frame remains evidence without proving parity");
});
