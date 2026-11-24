import { encodePng } from "./png-diff.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { visualQaFindingsProblems } from "../../../lib/vibe/scripts/required-visual-qa.mjs";
import { farEndCoveragePasses, inspectVisualQaOverflow, validFarEndCoverage } from "../../../lib/vibe/scripts/viewport-overflow.mjs";
import { makeHome } from "../../vibe/scripts/test-fixtures.mjs";

const height = 480;
const bands = 8;
const coverage = (filled) => ({ height, bands, filled });

test("ISS-14476 far-end coverage needs strictly more than half the visible height bands", () => {
  assert.equal(farEndCoveragePasses(coverage([0, 1, 2, 3, 4]), height), true);
  assert.equal(farEndCoveragePasses(coverage([0, 2, 5, 7]), height), false);
  assert.equal(farEndCoveragePasses(coverage([0]), height), false);
  assert.equal(farEndCoveragePasses(coverage([]), height), false);
  assert.equal(farEndCoveragePasses({ height: 20, bands: 1, filled: [0] }, 20), true);
  for (const bad of [coverage([0, 0, 1, 2, 3]), coverage([0, 1, 2, 3, 8]), { height, bands: 1, filled: [0] }, null]) {
    assert.equal(validFarEndCoverage(bad, height), false);
  }
});

test("ISS-14476 findings reject a 2,102px track with a blank 390px far end", (t) => {
  const { root, cleanup } = makeHome("vibe-qa-blank-track-");
  t.after(cleanup);
  const head = "a".repeat(40);
  const file = "apps/app/issues.tsx";
  const png = encodePng({ width: 1, height: 1, data: Buffer.alloc(4) });
  for (const name of ["rest.png", "far.png"]) writeFileSync(path.join(root, name), png);
  const entry = {
    path: "#issues", scrollWidth: 2102, clientWidth: 390, scrollHeight: height, clientHeight: height,
    horizontal: true, vertical: false, blocking: false, farEndPng: "far.png",
    protruding: { x: { path: "#add-new-issue" } },
  };
  const capture = {
    surface: "web", target: "/issues", viewport: "390x550", theme: "light", paths: [file], png: "rest.png",
    overflow: { width: 390, height: 550, checkedContainers: 2, entries: [entry] },
  };
  const record = { head, findings: [], rounds: [{ id: "vqa-6d", head, runtime: "web", captures: [capture] }] };
  const findings = path.join(root, "findings.json");
  const validate = (farEndCoverage) => {
    entry.farEndCoverage = farEndCoverage;
    writeFileSync(findings, JSON.stringify(record));
    return visualQaFindingsProblems(findings, head, null, null, { paths: [file] });
  };
  assert.match(validate(coverage([7])).join("\n"), /blank far-end viewport.*1\/8.*#add-new-issue/);
  assert.match(validate(coverage([0, 2, 5, 7])).join("\n"), /blank far-end viewport.*4\/8/);
  assert.match(validate(undefined).join("\n"), /needs far-end foreground coverage/);
  assert.match(validate({ height, bands: 1, filled: [0] }).join("\n"), /needs far-end foreground coverage/);
  assert.deepEqual(validate(coverage([1, 2, 3, 4, 5])), []);
  const probe = capture.overflow;
  delete capture.overflow;
  assert.match(validate(coverage([1, 2, 3, 4, 5])).join("\n"), /\/issues at 390x550 needs its runtime overflow probe/, "a capture without its overflow probe is refused");
  capture.overflow = { ...probe, width: 1280 };
  assert.match(validate(coverage([1, 2, 3, 4, 5])).join("\n"), /needs its runtime overflow probe/, "a probe from another viewport does not count");
  capture.overflow = probe;
});

/** A layout-bearing element: only the DOM surface inspectVisualQaOverflow reads. */
class Box {
  constructor(tag, { id = "", classes = [], style = {}, rect = [0, 0, 390, 20], client = [0, 0], scroll = null, parent = null } = {}) {
    Object.assign(this, { localName: tag, id, classList: classes, children: [], parentElement: parent, scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 });
    this.style = { overflowX: "visible", overflowY: "visible", position: "static", direction: "ltr", ...style };
    [this.left, this.top, this.right, this.bottom] = rect;
    [this.clientWidth, this.clientHeight] = client;
    [this.scrollWidth, this.scrollHeight] = scroll ?? client;
    parent?.children.push(this);
  }
  getBoundingClientRect() { return { left: this.left, top: this.top, right: this.right, bottom: this.bottom }; }
  matches(selector) { return selector === `#${this.id}`; }
  contains(node) { for (let at = node; at; at = at.parentElement) if (at === this) return true; return false; }
  get offsetParent() { for (let at = this.parentElement; at; at = at.parentElement) if (at.style.position !== "static" || !at.parentElement) return at; return null; }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]); }
}

function withDom(build, run) {
  const html = new Box("html", { client: [390, 550], scroll: [500, 550] });
  const body = new Box("body", { parent: html, rect: [0, 0, 390, 550] });
  build(body);
  const all = [html, ...html.querySelectorAll("*")];
  const saved = Object.fromEntries(["document", "getComputedStyle", "CSS", "innerWidth", "innerHeight"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    document: { scrollingElement: html, documentElement: html,
      querySelectorAll: (selector) => selector === "*" ? all : all.filter((element) => selector === `#${element.id}`) },
    getComputedStyle: (element) => element.style, CSS: { escape: (value) => value }, innerWidth: 390, innerHeight: 550 });
  try { return run(); }
  finally { for (const [key, descriptor] of Object.entries(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; }
}

const trackPage = (withEscape) => (body) => {
  new Box("span", { id: "hidden", classes: ["sr-only"], parent: body, rect: [0, 0, 500, 1] });
  const track = new Box("div", { id: "track", parent: body, style: { overflowX: "auto", position: "relative" }, rect: [0, 30, 390, 130], client: [390, 100], scroll: [880, 100] });
  new Box("span", { id: "far", parent: track, rect: [800, 30, 880, 60] });
  const nested = new Box("div", { id: "nested", parent: track, style: { overflowX: "hidden" }, rect: [0, 60, 390, 90] });
  new Box("span", { id: "clipped", parent: nested, rect: [1900, 60, 2000, 90] });
  if (withEscape) new Box("span", { id: "escape", parent: nested, style: { position: "absolute" }, rect: [900, 60, 950, 90] });
};

test("ISS-14476 the overflow probe reports document and container overflow with the furthest unclipped descendant and its absolute and sr-only flags (the ISS-8422 class)", () => {
  const result = withDom(trackPage(true), () => inspectVisualQaOverflow({ horizontalScrollers: ["#track"] }));
  assert.equal(result.checkedContainers, 2, "the document and the one scrolling container; a clipping overflow:hidden box is not a scroller");
  const [root, track] = result.entries;
  assert.deepEqual([root.path, root.horizontal, root.vertical, root.scrollWidth, root.clientWidth], [":root", true, false, 500, 390]);
  assert.deepEqual(root.protruding.x, { path: "#hidden", absolute: false, visuallyHidden: true },
    "document overflow names the sr-only box; the track's descendants are clipped by the track");
  assert.equal(root.blocking, true, "document overflow always blocks");
  assert.deepEqual([track.path, track.horizontal, track.scrollWidth, track.clientWidth], ["#track", true, 880, 390]);
  assert.deepEqual(track.protruding.x, { path: "#escape", absolute: true, visuallyHidden: false },
    "an absolute box escapes its nested clip, while the clipped static box further out does not count");
  assert.equal(track.blocking, true, "an intended scroller still blocks when an escaping absolute box adds width its own children do not provide");
  const plain = withDom(trackPage(false), () => inspectVisualQaOverflow({ horizontalScrollers: ["#track"] })).entries[1];
  assert.deepEqual([plain.protruding.x.path, plain.blocking], ["#far", false], "intended scrolling over its own children does not block");
  assert.equal(withDom(trackPage(false), () => inspectVisualQaOverflow()).entries[1].blocking, true, "unlisted horizontal scrolling blocks");
});
