#!/usr/bin/env node
// Which runtime a ticket's writer starts on, and whether its pull request gets a QA-guide
// session, read from the vibe triage manifest's class and the usage lines the watcher
// already prints. Changes nothing; names a runtime, never a model.
//
// Usage: dispatch-route.mjs --manifest <triage manifest> [--codex-usage "<codex-usage line>" --codex-read-at <ISO time or epoch ms>]
//          [--claude-usage "<claude-usage line>" --claude-read-at <ISO time or epoch ms>] [--stale-seconds <n>] [--enable]
// Prints one JSON object { schema, routed, class, runtime, qaGuide, reason }; exit 0 whenever it
// printed a decision, 2 on bad usage.
//
// Off unless `--enable` or FLEET_CLASS_ROUTING=1: then `routed` is false, `runtime` is null and
// `qaGuide` is `launch`, so the orchestrator chooses as it does today ("Runtime choice" in the
// skill: judgment-heavy work to Claude, bulk mechanical work to Codex) and launches the QA guide.
// A missing or invalid manifest, or class `unknown`, is the same as off.
//
// The class to runtime mapping is NOT human-ruled yet (flagged for the owner in the pull request): the
// classes below are the plan's "small tickets", the rest are judgment work. The QA guide is skipped only for
// `docs-config`; `trivial-ui` still changes UI and keeps its guide (owner ruling on the pull request review). A usage line at or above its HIGH band, or at a limit, moves the choice to the
// other runtime when that one is not; both high, or an unreadable line, keeps the class's choice.
// A line is unreadable when it reports an unknown reading (`?%` or an `unknown` band), carries no read time,
// or was read longer ago than the staleness bound (30 minutes, as usage-state.mjs): a reading that says
// nothing, or that may no longer be true, never moves a writer.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { UsageState } from "../../codex-fleet-monitor/scripts/ratelimit.mjs";
import { DEFAULT_STALE_SECONDS } from "../../codex-fleet-monitor/scripts/usage-state.mjs";
import { CLASSES, validateManifest } from "../../vibe/scripts/vibe-triage.mjs";
import { vibeCore } from "../../../shared/vibe-core.mjs";

const { decideCloudPlacement } = await vibeCore("lib/fleet-orchestrator/scripts/cloud-placement.mjs");

export const DISPATCH_ROUTE_SCHEMA = "vibe.fleet-dispatch-route/1";
export const SWITCH_ENV = "FLEET_CLASS_ROUTING";
export const Runtime = Object.freeze({ Claude: "claude", Codex: "codex" });
export const QaGuide = Object.freeze({ Launch: "launch", Skip: "skip" });

const MECHANICAL = new Set([CLASSES.TrivialUi, CLASSES.DocsConfig]);
const NO_QA_GUIDE = new Set([CLASSES.DocsConfig]);
const HIGH_BAND = /^HIGH\(/;
const AT_LIMIT = new Set([UsageState.Limit, UsageState.SpendingCredits, UsageState.Stopped]);

/** Whether a `codex-usage <label> <band> <state> resets=<n>` line says Codex is high or at a limit; null when unreadable. */
export function codexHigh(line) {
  const [tag, , band, state] = String(line ?? "").trim().split(/\s+/);
  if (tag !== "codex-usage" || !band || !state || state === "READFAIL" || band === "unreadable" || band.startsWith("?") || state === UsageState.Unknown) return null;
  return HIGH_BAND.test(band) || AT_LIMIT.has(state);
}

/** Whether a `claude-usage <label> session=<band> week=<band>` line says Claude is high; null when unreadable. */
export function claudeHigh(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("claude-usage ") || text.includes("READFAIL")) return null;
  const bands = [...text.matchAll(/\b(?:session|week)=(\S+)/g)].map((match) => match[1]);
  if (bands.length === 0) return null;
  if (bands.some((band) => HIGH_BAND.test(band))) return true;
  return bands.some((band) => band === "unknown" || band.startsWith("?")) ? null : false;
}

/** The line itself when its read time is a valid time no later than now and no older than `staleSeconds`; otherwise null, so the line reads as unreadable. */
export function freshReading(line, readAt, { now = Date.now(), staleSeconds = DEFAULT_STALE_SECONDS } = {}) {
  const text = typeof line === "string" ? line : undefined;
  if (!text || readAt === undefined || readAt === null || readAt === "") return null;
  const read = typeof readAt === "number" || /^\d+$/.test(String(readAt)) ? Number(readAt) : Date.parse(String(readAt));
  if (!Number.isFinite(read) || read > now || now - read > staleSeconds * 1000) return null;
  return text;
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
export function chooseDispatch({ enabled, manifest, codexUsage, claudeUsage, codexReadAt, claudeReadAt, now, staleSeconds, placementInput }) {
  const bound = { now, staleSeconds };
  const placement = decideCloudPlacement(placementInput);
  const today = (reason) => ({ routed: false, class: null, runtime: null, qaGuide: QaGuide.Launch, reason, placement });
  if (!enabled) return today("class routing switch is off");
  let checked;
  try { checked = validateManifest(manifest); } catch (error) { return today(error.message); }
  if (checked.class === CLASSES.Unknown) return today("class unknown: the evidence did not decide one");
  const decision = routeClass({ manifestClass: checked.class, codexIsHigh: codexHigh(freshReading(codexUsage, codexReadAt, bound)), claudeIsHigh: claudeHigh(freshReading(claudeUsage, claudeReadAt, bound)) });
  return { routed: true, class: checked.class, ...decision, placement };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: {
    manifest: { type: "string" }, "codex-usage": { type: "string" }, "claude-usage": { type: "string" }, "codex-read-at": { type: "string" }, "claude-read-at": { type: "string" },
    "stale-seconds": { type: "string" }, "placement-file": { type: "string" }, enable: { type: "boolean" },
  } });
  if (!values.manifest) throw new Error("--manifest is required");
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(values.manifest, "utf8")); } catch { /* missing or unreadable: today's behavior */ }
  let placementInput = null;
  if (values["placement-file"]) {
    try { placementInput = JSON.parse(readFileSync(values["placement-file"], "utf8")); }
    catch { /* invalid evidence is local-only */ }
  }
  const enabled = Boolean(values.enable) || process.env[SWITCH_ENV] === "1";
  const decision = chooseDispatch({ enabled, manifest, codexUsage: values["codex-usage"], claudeUsage: values["claude-usage"],
    codexReadAt: values["codex-read-at"], claudeReadAt: values["claude-read-at"],
    ...(values["stale-seconds"] ? { staleSeconds: Number(values["stale-seconds"]) } : {}), placementInput });
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
