#!/usr/bin/env node
// The orchestrator's helper ledger. Idle helper panes hide the active ones
// from the operator, so a helper (reviewer, verifier, QA prep, poller) stops
// as soon as its result is accepted and a fresh one is launched from its saved
// brief at the next trigger. `status` lists every helper whose result was
// accepted more than --idle-minutes ago and that is not recorded as stopped.
//
// Usage: helpers.mjs <orchDir> start <name> [--brief <file>]
//        helpers.mjs <orchDir> accepted <name>
//        helpers.mjs <orchDir> stopped <name>
//        helpers.mjs <orchDir> status [--idle-minutes <n, default 5>] [--now <iso>]
//
// `status` prints `STOP <name> accepted <n>m ago` lines, then `helpers: <active> active, <stop> to stop`,
// and exits 1 when any helper should be stopped.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const LEDGER = "helpers.json";
const DEFAULT_IDLE_MINUTES = 5;

/** Helpers to stop: accepted more than `idleMinutes` before `now` and never recorded stopped. */
export function stopCandidates(ledger, now, idleMinutes = DEFAULT_IDLE_MINUTES) {
  return Object.entries(ledger)
    .filter(([, helper]) => helper.acceptedAt && !helper.stoppedAt && now - Date.parse(helper.acceptedAt) > idleMinutes * 60_000)
    .map(([name, helper]) => ({ name, minutes: Math.floor((now - Date.parse(helper.acceptedAt)) / 60_000), brief: helper.brief ?? null }));
}

function read(orchDir) {
  const file = path.join(orchDir, LEDGER);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function write(orchDir, ledger) {
  const file = path.join(orchDir, LEDGER);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

function main(argv) {
  const [orchDir, action, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { brief: { type: "string" }, "idle-minutes": { type: "string" }, now: { type: "string" } },
  });
  if (!orchDir || !["start", "accepted", "stopped", "status"].includes(action)) {
    throw new Error("Usage: helpers.mjs <orchDir> start|accepted|stopped <name> | status [--idle-minutes <n>]");
  }
  const ledger = read(orchDir);
  const now = values.now ? Date.parse(values.now) : Date.now();
  if (action === "status") {
    const stop = stopCandidates(ledger, now, values["idle-minutes"] === undefined ? DEFAULT_IDLE_MINUTES : Number(values["idle-minutes"]));
    for (const helper of stop) {
      process.stdout.write(`STOP ${helper.name} accepted ${helper.minutes}m ago${helper.brief ? `; relaunch from ${helper.brief}` : ""}\n`);
    }
    const active = Object.values(ledger).filter((helper) => !helper.stoppedAt).length;
    process.stdout.write(`helpers: ${active} active, ${stop.length} to stop\n`);
    return stop.length === 0 ? 0 : 1;
  }
  const [name] = positionals;
  if (!name) {
    throw new Error(`${action} needs a helper name.`);
  }
  const at = new Date(now).toISOString();
  if (action === "start") {
    ledger[name] = { startedAt: at, ...(values.brief ? { brief: values.brief } : {}) };
  } else {
    ledger[name] = { ...(ledger[name] ?? {}), [action === "accepted" ? "acceptedAt" : "stoppedAt"]: at };
  }
  write(orchDir, ledger);
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
