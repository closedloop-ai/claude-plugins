#!/usr/bin/env node
// Which runtime a ticket's writer starts on, and whether its pull request gets a QA-guide
// session, read from the vibe triage manifest's class and the usage lines the watcher
// already prints (PRD-823 WS7 F1 and F3). Changes nothing; names a runtime, never a model.
//
// Usage: dispatch-route.mjs --manifest <triage manifest> [--codex-usage "<codex-usage line>"] [--claude-usage "<claude-usage line>"] [--enable]
// Prints one JSON object { schema, routed, class, runtime, qaGuide, reason }; exit 0 whenever it
// printed a decision, 2 on bad usage.
//
// Off unless `--enable` or FLEET_CLASS_ROUTING=1: then `routed` is false, `runtime` is null and
// `qaGuide` is `launch`, so the orchestrator chooses as it does today ("Runtime choice" in the
// skill: judgment-heavy work to Claude, bulk mechanical work to Codex) and launches the QA guide.
// A missing or invalid manifest, or class `unknown`, is the same as off.
//
// The class to runtime mapping and the QA-guide classes are NOT human-ruled yet (flagged for the
// owner in the pull request): the classes below are the plan's "small tickets", the rest are
// judgment work. A usage line at or above its HIGH band, or at a limit, moves the choice to the
// other runtime when that one is not; both high, or an unreadable line, keeps the class's choice.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { UsageState } from "../../codex-fleet-monitor/scripts/ratelimit.mjs";
import { CLASSES, validateManifest } from "../../vibe/scripts/vibe-triage.mjs";

export const DISPATCH_ROUTE_SCHEMA = "vibe.fleet-dispatch-route/1";
export const SWITCH_ENV = "FLEET_CLASS_ROUTING";
export const Runtime = Object.freeze({ Claude: "claude", Codex: "codex" });
export const QaGuide = Object.freeze({ Launch: "launch", Skip: "skip" });

const MECHANICAL = new Set([CLASSES.TrivialUi, CLASSES.DocsConfig]);
const NO_QA_GUIDE = MECHANICAL;
const HIGH_BAND = /^HIGH\(/;
const AT_LIMIT = new Set([UsageState.Limit, UsageState.SpendingCredits, UsageState.Stopped]);

/** Whether a `codex-usage <label> <band> <state> resets=<n>` line says Codex is high or at a limit; null when unreadable. */
export function codexHigh(line) {
  const [tag, , band, state] = String(line ?? "").trim().split(/\s+/);
  if (tag !== "codex-usage" || !band || !state || state === "READFAIL" || band === "unreadable") return null;
  return HIGH_BAND.test(band) || AT_LIMIT.has(state);
}

/** Whether a `claude-usage <label> session=<band> week=<band>` line says Claude is high; null when unreadable. */
export function claudeHigh(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("claude-usage ") || text.includes("READFAIL")) return null;
  const bands = [...text.matchAll(/\b(?:session|week)=(\S+)/g)].map((match) => match[1]);
  return bands.length === 0 ? null : bands.some((band) => HIGH_BAND.test(band));
}

/** The decision for a validated manifest and the two usage readings (true, false or null). */
export function routeClass({ manifestClass, codexIsHigh = null, claudeIsHigh = null }) {
  const preferred = MECHANICAL.has(manifestClass) ? Runtime.Codex : Runtime.Claude;
  const qaGuide = NO_QA_GUIDE.has(manifestClass) ? QaGuide.Skip : QaGuide.Launch;
  const preferredHigh = preferred === Runtime.Codex ? codexIsHigh : claudeIsHigh;
  const otherHigh = preferred === Runtime.Codex ? claudeIsHigh : codexIsHigh;
  if (preferredHigh === true && otherHigh === false) {
    const runtime = preferred === Runtime.Codex ? Runtime.Claude : Runtime.Codex;
    return { runtime, qaGuide, reason: `class ${manifestClass} prefers ${preferred}, whose usage is high while ${runtime}'s is not` };
  }
  return { runtime: preferred, qaGuide, reason: `class ${manifestClass} prefers ${preferred}` };
}

/** The whole decision; anything short of an enabled switch, a valid manifest and a decided class is today's behavior. */
export function chooseDispatch({ enabled, manifest, codexUsage, claudeUsage }) {
  const today = (reason) => ({ routed: false, class: null, runtime: null, qaGuide: QaGuide.Launch, reason });
  if (!enabled) return today("class routing switch is off");
  let checked;
  try { checked = validateManifest(manifest); } catch (error) { return today(error.message); }
  if (checked.class === CLASSES.Unknown) return today("class unknown: the evidence did not decide one");
  const decision = routeClass({ manifestClass: checked.class, codexIsHigh: codexHigh(codexUsage), claudeIsHigh: claudeHigh(claudeUsage) });
  return { routed: true, class: checked.class, ...decision };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    manifest: { type: "string" }, "codex-usage": { type: "string" }, "claude-usage": { type: "string" }, enable: { type: "boolean" },
  } });
  if (!values.manifest) throw new Error("--manifest is required");
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(values.manifest, "utf8")); } catch { /* missing or unreadable: today's behavior */ }
  const enabled = Boolean(values.enable) || process.env[SWITCH_ENV] === "1";
  const decision = chooseDispatch({ enabled, manifest, codexUsage: values["codex-usage"], claudeUsage: values["claude-usage"] });
  process.stdout.write(`${JSON.stringify({ schema: DISPATCH_ROUTE_SCHEMA, ...decision })}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
