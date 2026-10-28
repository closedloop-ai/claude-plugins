#!/usr/bin/env node
// Deterministic task triage for a vibe session (PRD-823, WS1 T1): classify the
// request into one class and print the step manifest, with the reason and the
// evidence for the class. No model, no network, no git: the same input always
// gives the same manifest.
//
// Usage:
//   vibe-triage.mjs classify --request <text> [--ticket-file <file>]
//                            [--paths <a,b,...> | --paths-file <file>] [--out <file>]
//       Prints (and with --out writes) the manifest JSON.
//   vibe-triage.mjs check --manifest <file>
//       Prints {"ok":true,...} or exits 1 when the manifest breaks the schema.
//
// The manifest RECOMMENDS two things for some classes: create the environment
// on first need (`environment`: defer) and leave Desktop out (`desktop`: skip).
// Each recommendation is logged in `skipped` with its reason and evidence.
// Today's flow does not change: every step's `effective` is "run" unless the
// switch VIBE_TRIAGE_APPLY_RECOMMENDATIONS is set to 1 when `classify` runs.
// The switch is off by default and `classify` is its only reader. Whether
// relaxing "Start Desktop for every session" and starting without an eager
// environment is allowed awaits the owner (ISS-13333, ISS-13334).
//
// A request the evidence does not decide is class "unknown": no pipeline skill,
// no recommendation, today's flow. The class is never guessed.
//
// Lane and e2e selection are never decided here: they come from `pnpm test:lanes`
// and the target repository's e2e path filter.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const SCHEMA_VERSION = 1;

export const SWITCH_ENV = "VIBE_TRIAGE_APPLY_RECOMMENDATIONS";

export const CLASSES = Object.freeze({
  TrivialUi: "trivial-ui",
  UiFeature: "ui-feature",
  Backend: "backend",
  DocsConfig: "docs-config",
  Mockup: "mockup",
  DataMetric: "data-metric",
  Unknown: "unknown",
});

export const ACTIONS = Object.freeze({ Run: "run", Defer: "defer", Skip: "skip", Unknown: "unknown" });

export const POLICY = "required (policy)";

// Steps of today's flow. A class never removes one; only `environment` and
// `desktop` carry a recommendation, and it takes effect only with the switch.
export const POLICY_STEPS = Object.freeze(["environment", "desktop", "ticket", "planPublish", "decisionTable", "redeploy", "handoffSteps"]);
export const RECOMMENDABLE_STEPS = Object.freeze(["environment", "desktop"]);

export const E2E_SOURCE = "pnpm test:lanes and the e2e path filter";

// Who reads the final diff and the extra gates a class adds on top of the
// handoff every class gets (plan section 4, task classes).
const CLASS_REVIEW = Object.freeze({
  [CLASSES.TrivialUi]: { scope: "consolidated-light", gates: [] },
  [CLASSES.UiFeature]: { scope: "consolidated-adversarial", gates: [] },
  [CLASSES.Backend]: { scope: "consolidated", gates: ["workflow-code-review"] },
  [CLASSES.DocsConfig]: { scope: "consolidated-light", gates: [] },
  [CLASSES.Mockup]: { scope: "design-pass", gates: [] },
  [CLASSES.DataMetric]: { scope: "consolidated-adversarial", gates: ["logical-qa"] },
  [CLASSES.Unknown]: { scope: "as-today", gates: [] },
});

const TEST_PATH = /(^|\/)(__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)e2e\/.*\.spec\.[jt]s$/;
const PROTOTYPE_PATH = /^apps\/prototypes\//;
const METRIC_PATH = /(^|\/)(metrics?|analytics|cost|reconcil\w*|aggregat\w*)(\/|[-.])/i;
const UI_PATH = /\.(tsx|css|scss)$|^packages\/(app|design-system)\/|^apps\/(app|web|storybook)\/|^apps\/desktop\/src\/renderer\//;
const BACKEND_PATH = /^apps\/(api|mcp|relay|realtime|doc-sync)\/|^packages\/(database|api|github|ai|loops-api|cost)\/|^apps\/desktop\/src\/(main|server)\/|\.sql$|schema\.prisma$/;
const DOCS_PATH = /(^|\/)(docs?|\.github|\.claude|\.agents|\.husky|\.dagger|scripts|e2e)\/|(^|\/)(AGENTS|CLAUDE|README|CHANGELOG)\.md$|\.mdx?$|\.ya?ml$|\.toml$|\.jsonc?$|\.sh$|(^|\/)\.[a-z]+rc(\.[a-z]+)?$/i;
// Surfaces a Desktop session shows: the Electron app itself and the shared UI
// package the target repository requires verifying on both web and Desktop.
const DESKTOP_PATH = /^apps\/desktop\/|^packages\/app\//;

const PROTOTYPE_WORDS = /\b(mock-?ups?|fake data|made-?up data|(build|make|create|design) (me )?(a|the) prototype)\b/i;
const METRIC_WORDS = /\b(metrics?|reconcil\w*|cost|spend|tokens used|kpi|aggregate|rollup|totals?|percentages?)\b/i;
const TRIVIAL_WORDS = /\b(copy|wording|typo|label|colou?r|spacing|padding|margin|font|tooltip)\b/i;
const UI_WORDS = /\b(page|screen|table|columns?|chips?|buttons?|menus?|dialog|drawer|board|lanes?|headers?|toolbar|checkbox|icons?|sort control|sidebar|modal|layout|bars?)\b/i;
const BACKEND_WORDS = /\b(api|endpoint|route|migration|schema|database|webhook|audit|ledger|write paths?|backend|server-only|atomic upsert)\b/i;
const DOCS_WORDS = /\b(docs?(?![-\w])|documentation|readme|skills?|config|configuration|agents\.md|runbooks?|runners?|dagger|ci)\b/i;
const BIG_WORDS = /\b(new (page|screen|flow|table|view|feature)|redesign|workflow|bulk|drawer|dialog|pagination|settings|flags?|sort\w*|filter\w*|select\w*|click\w*|press\w*|order\w*|default|clear\w*|state|mouse|keyboard|group\w*|status|move|drag\w*)\b/i;
const DESKTOP_WORDS = /\b(desktop|electron)\b|packages\/app/i;

/** Normalizes a path list given as a comma list or lines. */
export function parsePathList(text) {
  return String(text ?? "")
    .split(/[\n,]/)
    .map((entry) => entry.trim().replace(/^\.\//, ""))
    .filter(Boolean);
}

/** Which kind of file `file` is: test, prototype, metric, ui, backend, docs or other. */
export function pathKind(file) {
  if (TEST_PATH.test(file)) return "test";
  if (PROTOTYPE_PATH.test(file)) return "prototype";
  if (METRIC_PATH.test(file) && (UI_PATH.test(file) || BACKEND_PATH.test(file))) return "metric";
  if (UI_PATH.test(file)) return "ui";
  if (BACKEND_PATH.test(file)) return "backend";
  if (DOCS_PATH.test(file)) return "docs";
  return "other";
}

function words(regex, text) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...new Set([...String(text).matchAll(new RegExp(regex.source, flags))].map((match) => match[0].toLowerCase()))].sort();
}

function classifyByPaths(paths) {
  const products = paths.filter((file) => pathKind(file) !== "test");
  const considered = products.length ? products : paths;
  const kinds = considered.map(pathKind);
  const has = (kind) => kinds.includes(kind);
  if (has("other")) return { cls: CLASSES.Unknown, reason: ["a touched file is in no known area"] };
  if (has("metric")) return { cls: CLASSES.DataMetric, reason: ["a touched file is a metric or cost surface"] };
  if (kinds.every((kind) => kind === "prototype")) return { cls: CLASSES.Mockup, reason: ["every touched file is under apps/prototypes"] };
  const ui = kinds.filter((kind) => kind === "ui" || kind === "prototype").length;
  if (ui > 0) {
    if (ui === 1 && !has("backend")) return { cls: CLASSES.TrivialUi, reason: ["one UI file and no backend file"], tentative: true };
    return { cls: CLASSES.UiFeature, reason: [has("backend") ? "UI and backend files are touched together" : "more than one UI file is touched"] };
  }
  if (has("backend")) return { cls: CLASSES.Backend, reason: ["only backend files are touched (no UI file)"] };
  return { cls: CLASSES.DocsConfig, reason: ["only docs, scripts or config files are touched"] };
}

function classifyByText(text) {
  const hits = {
    mockup: words(PROTOTYPE_WORDS, text),
    metric: words(METRIC_WORDS, text),
    trivial: words(TRIVIAL_WORDS, text),
    big: words(BIG_WORDS, text),
    ui: words(UI_WORDS, text),
    backend: words(BACKEND_WORDS, text),
    docs: words(DOCS_WORDS, text),
  };
  const keywords = [...new Set(Object.values(hits).flat())].sort();
  const some = (key) => hits[key].length > 0;
  if (some("mockup")) return { cls: CLASSES.Mockup, reason: ["the request asks for a mockup or made-up data"], keywords };
  if (some("metric")) return { cls: CLASSES.DataMetric, reason: ["the request is about a number the product shows"], keywords };
  if (some("ui") && some("backend")) return { cls: CLASSES.UiFeature, reason: ["the request names UI and backend work together"], keywords };
  if (some("ui")) {
    if (some("trivial") && !some("big")) return { cls: CLASSES.TrivialUi, reason: ["the request is a copy, style or spacing edit"], keywords, tentative: true };
    return { cls: CLASSES.UiFeature, reason: ["the request names UI work"], keywords };
  }
  if (some("backend") && !some("docs")) return { cls: CLASSES.Backend, reason: ["the request names backend work and no UI"], keywords };
  if (some("docs") && !some("backend")) return { cls: CLASSES.DocsConfig, reason: ["the request names docs, skill or config work and no UI"], keywords };
  return { cls: CLASSES.Unknown, reason: ["the request does not name one area, so the class stays unknown"], keywords };
}

// Desktop relevance: true or false only on evidence, otherwise null (unknown).
function desktopRelevance(cls, paths, text) {
  const evidence = [];
  const files = paths.filter((file) => pathKind(file) !== "test");
  const desktopFiles = files.filter((file) => DESKTOP_PATH.test(file));
  if (desktopFiles.length) return { relevant: true, evidence: desktopFiles.map((file) => `path ${file}`) };
  const mentions = words(DESKTOP_WORDS, text);
  if (mentions.length) return { relevant: true, evidence: mentions.map((word) => `text "${word}"`) };
  if (files.length && cls !== CLASSES.Unknown && files.every((file) => ["ui", "backend", "docs", "metric"].includes(pathKind(file)))) {
    return { relevant: false, evidence: [`no touched file is under apps/desktop or packages/app (${files.length} files)`] };
  }
  return { relevant: null, evidence };
}

function recommend(cls, step, desktop, pathsKnown) {
  const run = (reason, evidence = []) => ({ action: ACTIONS.Run, reason, evidence });
  const unknown = (reason) => ({ action: ACTIONS.Unknown, reason, evidence: [] });
  if (cls === CLASSES.Unknown) return { action: ACTIONS.Unknown, reason: "the class is unknown, so today's flow applies", evidence: [] };
  if (cls === CLASSES.Mockup) return { action: ACTIONS.Unknown, reason: "a mockup follows its own flow in the vibe skill", evidence: [] };
  const wantsLess = (step === "environment" && cls !== CLASSES.UiFeature && cls !== CLASSES.DataMetric) || (step === "desktop" && cls !== CLASSES.DataMetric && desktop.relevant !== true);
  if (wantsLess && !pathsKnown) return unknown("the class rests on the request text alone, so no step is recommended to be left out");
  if (step === "environment") {
    if (cls === CLASSES.UiFeature || cls === CLASSES.DataMetric) return run("the change shows in the app");
    const reasons = {
      [CLASSES.TrivialUi]: "a small UI edit needs the environment only when it is first viewed",
      [CLASSES.Backend]: "no UI file is in the evidence, so the environment is needed only on first need",
      [CLASSES.DocsConfig]: "only docs, scripts or config are in the evidence, so the environment is needed only on first need",
    };
    return { action: ACTIONS.Defer, reason: reasons[cls], evidence: [`class ${cls}`] };
  }
  if (cls === CLASSES.DataMetric) return run("a metric surface is checked on both web and Desktop");
  if (desktop.relevant === true) return run("a Desktop-relevant surface is in the evidence", desktop.evidence);
  if (desktop.relevant === false) return { action: ACTIONS.Skip, reason: "no Desktop-relevant surface is in the evidence", evidence: desktop.evidence };
  if (cls === CLASSES.Backend || cls === CLASSES.DocsConfig) {
    return { action: ACTIONS.Skip, reason: "the evidence names no UI file, so no Desktop-relevant surface is touched", evidence: [`class ${cls}`] };
  }
  return unknown("whether a Desktop-relevant surface is touched is not known");
}

function effectiveFor(recommendation, applied) {
  if (!applied) return ACTIONS.Run;
  return recommendation.action === ACTIONS.Defer || recommendation.action === ACTIONS.Skip ? recommendation.action : ACTIONS.Run;
}

/**
 * Classifies one request. Touched paths, when known, decide the class; the
 * request and ticket text decide it before any path exists. `apply` is the
 * switch's state (see SWITCH_ENV).
 */
export function classify({ request = "", ticketText = "", paths = [], apply = false }) {
  const text = `${request}\n${ticketText}`;
  const byPaths = paths.length ? classifyByPaths(paths) : null;
  const byText = classifyByText(text);
  const sources = byPaths ? ["paths"] : ["text"];
  let chosen = byPaths ?? byText;
  if (byPaths && byText.cls === CLASSES.DataMetric && chosen.cls !== CLASSES.DataMetric) {
    sources.push("text");
    chosen = { cls: CLASSES.DataMetric, reason: [...byText.reason, ...chosen.reason] };
  } else if (byPaths && chosen.tentative && byText.cls === CLASSES.UiFeature) {
    sources.push("text");
    chosen = { cls: CLASSES.UiFeature, reason: [...byText.reason, ...chosen.reason] };
  }
  const desktop = desktopRelevance(chosen.cls, paths, text);
  const steps = {};
  const skipped = [];
  for (const id of POLICY_STEPS) steps[id] = { state: POLICY, effective: ACTIONS.Run };
  for (const id of RECOMMENDABLE_STEPS) {
    const recommendation = recommend(chosen.cls, id, desktop, paths.length > 0);
    steps[id] = { state: POLICY, recommendation, effective: effectiveFor(recommendation, apply) };
    if (recommendation.action === ACTIONS.Defer || recommendation.action === ACTIONS.Skip) {
      skipped.push({ step: id, action: recommendation.action, reason: recommendation.reason, evidence: recommendation.evidence, applied: apply });
    }
  }
  const review = CLASS_REVIEW[chosen.cls];
  steps.review = { state: "required", scope: review.scope };
  steps.extraGates = { state: review.gates.length ? "required" : "none", gates: [...review.gates] };
  steps.e2e = { state: "required", source: E2E_SOURCE };
  return {
    schemaVersion: SCHEMA_VERSION,
    class: chosen.cls,
    reason: chosen.reason,
    evidence: { paths: [...paths], keywords: byText.keywords, sources, desktopRelevant: desktop.relevant },
    applyRecommendations: apply,
    steps,
    skipped,
  };
}

/** Throws a message naming the first schema violation; returns the manifest otherwise. */
export function validateManifest(manifest) {
  const fail = (message) => {
    throw new Error(`invalid manifest: ${message}`);
  };
  if (!manifest || typeof manifest !== "object") fail("not an object");
  if (manifest.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!Object.values(CLASSES).includes(manifest.class)) fail(`unknown class ${JSON.stringify(manifest.class)}`);
  if (!Array.isArray(manifest.reason) || manifest.reason.length === 0) fail("reason must be a non-empty array");
  const evidence = manifest.evidence;
  if (!evidence || !Array.isArray(evidence.paths) || !Array.isArray(evidence.keywords) || !Array.isArray(evidence.sources)) {
    fail("evidence needs paths, keywords and sources arrays");
  }
  if (typeof manifest.applyRecommendations !== "boolean") fail("applyRecommendations must be a boolean");
  const steps = manifest.steps;
  if (!steps || typeof steps !== "object") fail("steps missing");
  const logged = [];
  for (const id of POLICY_STEPS) {
    const step = steps[id];
    if (step?.state !== POLICY) fail(`step ${id} must be "${POLICY}"`);
    if (!RECOMMENDABLE_STEPS.includes(id)) {
      if (step.recommendation !== undefined || step.effective !== ACTIONS.Run) fail(`step ${id} always runs`);
      continue;
    }
    const recommendation = step.recommendation;
    if (!Object.values(ACTIONS).includes(recommendation?.action)) fail(`step ${id} needs a recommendation action`);
    if (typeof recommendation.reason !== "string" || !recommendation.reason) fail(`step ${id} recommendation needs a reason`);
    if (!Array.isArray(recommendation.evidence)) fail(`step ${id} recommendation needs an evidence array`);
    if (id === "environment" && recommendation.action === ACTIONS.Skip) fail("the environment is deferred, never skipped");
    if (id === "desktop" && recommendation.action === ACTIONS.Defer) fail("Desktop is skipped, never deferred");
    const wanted = manifest.applyRecommendations ? effectiveOf(recommendation) : ACTIONS.Run;
    if (step.effective !== wanted) fail(`step ${id} effective must be "${wanted}" with applyRecommendations ${manifest.applyRecommendations}`);
    if (recommendation.action === ACTIONS.Defer || recommendation.action === ACTIONS.Skip) {
      if (recommendation.evidence.length === 0) fail(`step ${id} recommends ${recommendation.action} without evidence`);
      logged.push(id);
    }
  }
  if (typeof steps.review?.scope !== "string") fail("step review needs a scope");
  if (!Array.isArray(steps.extraGates?.gates)) fail("step extraGates needs a gates array");
  if (steps.e2e?.source !== E2E_SOURCE) fail("step e2e must take its source from test:lanes");
  if (!Array.isArray(manifest.skipped)) fail("skipped must be an array");
  const skippedIds = manifest.skipped.map((entry) => entry?.step).sort();
  if (JSON.stringify(skippedIds) !== JSON.stringify([...logged].sort())) fail("skipped must log exactly the steps whose recommendation is defer or skip");
  for (const entry of manifest.skipped) {
    if (typeof entry.reason !== "string" || !entry.reason || !Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      fail(`skipped entry ${entry.step} needs a reason and evidence`);
    }
    if (entry.applied !== manifest.applyRecommendations) fail(`skipped entry ${entry.step} applied must match applyRecommendations`);
  }
  return manifest;
}

function effectiveOf(recommendation) {
  return recommendation.action === ACTIONS.Defer || recommendation.action === ACTIONS.Skip ? recommendation.action : ACTIONS.Run;
}

/** True when the switch is turned on in `env`. */
export function switchOn(env = process.env) {
  return env[SWITCH_ENV] === "1";
}

function readPaths(values) {
  if (values["paths-file"]) return parsePathList(readFileSync(values["paths-file"], "utf8"));
  return parsePathList(values.paths);
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: { request: { type: "string" }, "ticket-file": { type: "string" }, paths: { type: "string" }, "paths-file": { type: "string" }, manifest: { type: "string" }, out: { type: "string" } },
  });
  if (command === "classify") {
    const ticketText = values["ticket-file"] ? readFileSync(values["ticket-file"], "utf8") : "";
    const manifest = classify({ request: values.request ?? "", ticketText, paths: readPaths(values), apply: switchOn() });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (values.out) writeFileSync(values.out, text);
    process.stdout.write(text);
    return 0;
  }
  if (command === "check") {
    if (!values.manifest) throw new Error("--manifest is required");
    const manifest = validateManifest(JSON.parse(readFileSync(values.manifest, "utf8")));
    process.stdout.write(`${JSON.stringify({ ok: true, class: manifest.class, applyRecommendations: manifest.applyRecommendations })}\n`);
    return 0;
  }
  throw new Error("usage: vibe-triage.mjs classify|check (see the header of this file)");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  }
}
