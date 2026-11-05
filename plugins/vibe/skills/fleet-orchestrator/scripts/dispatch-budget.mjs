#!/usr/bin/env node
// How many heavy runs the orchestrator may have going on this machine right now, read from the
// shared worker budget (vibe/scripts/heavy-budget.mjs: leases plus a scan for vitest, turbo and
// playwright runs that hold none, so runs started by other tools or agents count) instead of a
// fixed heavy-slot count. Changes nothing: `fleet.sh ... slot heavy` still
// enforces HEAVY_SLOTS (REMOTE_HEAVY_SLOTS on a remote machine) and MAX_LOAD_PER_CORE as the
// backstop, whatever this prints.
//
// Usage: dispatch-budget.mjs [--enable]
// Prints one JSON object { schema, source, concurrentRuns, ... }; exit 0 whenever it printed one.
//
// Off unless `--enable` or FLEET_BUDGET_GUIDANCE=1: `source` is `heavy-slots` and `concurrentRuns`
// is the fixed slot count, as today. On, `source` is `heavy-budget`, `concurrentRuns` is how many
// runs at the budget's minimum workers fit in what is left (0 below that minimum), and the
// snapshot fields come straight from it. It reads this machine's budget only; a remote machine
// runs the same command there.

import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { budgetDisabled, createBudget, resolveSettings } from "../../vibe/scripts/heavy-budget.mjs";

export const DISPATCH_BUDGET_SCHEMA = "vibe.fleet-dispatch-budget/1";
export const SWITCH_ENV = "FLEET_BUDGET_GUIDANCE";
export const Source = Object.freeze({ Slots: "heavy-slots", Budget: "heavy-budget" });

/** The fixed slot count `fleet.sh slot heavy` caps at on this machine (default 1, as the script does). */
export function slotCap(env = process.env) {
  const value = Number(env.HEAVY_SLOTS);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** The guidance for `snapshot` (heavy-budget's), or the fixed slot count when the switch is off or the budget is disabled. */
export function chooseConcurrency({ enabled, snapshot, minWorkers, env = process.env }) {
  const slots = slotCap(env);
  if (!enabled) return { source: Source.Slots, concurrentRuns: slots, slotCap: slots, reason: "budget guidance switch is off" };
  if (!snapshot) return { source: Source.Slots, concurrentRuns: slots, slotCap: slots, reason: "the worker budget is disabled or unreadable" };
  const concurrentRuns = snapshot.belowMinimum ? 0 : Math.floor(snapshot.available / minWorkers);
  const { cores, capacity, leasedWorkers, unleasedCores, available, belowMinimum, leases } = snapshot;
  return { source: Source.Budget, concurrentRuns, slotCap: slots, backstop: "fleet.sh slot heavy", cores, capacity, leasedWorkers, unleasedCores, available, belowMinimum, leases, minWorkers };
}

function main(argv) {
  const { values } = parseArgs({ args: argv, options: { enable: { type: "boolean" } } });
  const enabled = Boolean(values.enable) || process.env[SWITCH_ENV] === "1";
  const settings = resolveSettings();
  const snapshot = enabled && !budgetDisabled() ? createBudget().snapshot() : null;
  process.stdout.write(`${JSON.stringify({ schema: DISPATCH_BUDGET_SCHEMA, ...chooseConcurrency({ enabled, snapshot, minWorkers: settings.minWorkers }) })}\n`);
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
