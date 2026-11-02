// Bounded pool for independent verify lanes (PRD-823, WS8 load-aware execution, W4, ISS-13587).
// verify-run ran every lane `pnpm test:lanes` names strictly one after another; this schedules
// them, it never skips one. Pure unit and script-suite lanes may overlap up to the pool size,
// which comes from the worker budget (heavy-budget.mjs) and is never above `poolSize`. Every
// other lane is serial: at most one runs at a time, alongside the pool. A lane this file does
// not recognise is serial. e2e lanes are serial and run under e2e-lock.mjs.
//
// VIBE_VERIFY_POOL=serial restores strictly serial execution (verify-run's previous path).
// VIBE_VERIFY_POOL_SIZE overrides the pool size; VIBE_VERIFY_POOLABLE adds root script names to
// the poolable list.

import { ENV, featureDisabled } from "./heavy-budget.mjs";

export const LaneKind = Object.freeze({ Pool: "pool", Serial: "serial" });

// Root `pnpm test:*` scripts that run `vitest run --config <file>` over scripts or skills with no
// database, port, container or browser (checked against the target repository's vitest configs
// for globalSetup, docker, DATABASE and port use). Not listed on purpose: deploy-harness, perf,
// mutation and coverage-skill, whose configs this was not checked against.
export const POOLABLE_SCRIPTS = Object.freeze([
  "test:lint", "test:ci", "test:deploy", "test:deploy-guards", "test:gardener", "test:dead-code",
  "test:coverage-scripts", "test:logical-skills", "test:logical", "test:skills",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'(?:[^']|'\\'')*'|\S+)$/;
const E2E = /\b(?:test:e2e|test:web-smoke|playwright|e2e)\b/i;
const NEEDS_STACK = /\b(?:dagger|docker|compose|prisma|postgres|migrate|storybook|db:)\b|\bdesktop\b/i;

/** Splits a lane command into its words, with the leading KEY='value' assignments dropped. */
function words(lane) {
  const tokens = lane.match(/(?:'(?:[^']|'\\'')*'|\S)+/g) ?? [];
  let at = 0;
  while (at < tokens.length && ENV_ASSIGNMENT.test(tokens[at])) at += 1;
  return tokens.slice(at);
}

/** `{ kind, e2e, reason }` for a lane command. Only a known pure `pnpm <script>` lane is poolable; anything else is serial. */
export function classifyLane(lane, env = process.env) {
  if (E2E.test(lane)) return { kind: LaneKind.Serial, e2e: true, reason: "e2e lane: one stack per machine, runs under e2e-lock.mjs" };
  if (NEEDS_STACK.test(lane)) return { kind: LaneKind.Serial, e2e: false, reason: "may bind a database, port, container or shared stack" };
  const poolable = new Set([...POOLABLE_SCRIPTS, ...String(env[ENV.poolable] ?? "").split(",").map((name) => name.trim()).filter(Boolean)]);
  const tokens = words(lane);
  if (tokens.length === 2 && tokens[0] === "pnpm" && poolable.has(tokens[1])) return { kind: LaneKind.Pool, e2e: false, reason: `pure script-suite lane (${tokens[1]})` };
  return { kind: LaneKind.Serial, e2e: false, reason: "not on the poolable list; unknown lanes default to serial" };
}

/** How many lanes may run at once: 1 when pooling is switched off, else the budget's spare workers over the minimum, between 1 and `poolSize`. */
export function poolSizeFor({ env = process.env, settings, snapshot }) {
  if (String(env[ENV.pool] ?? "").trim().toLowerCase() === "serial" || featureDisabled(env, ENV.off)) return 1;
  const spare = snapshot ? Math.floor(snapshot.available / settings.minWorkers) : settings.poolSize;
  return Math.max(1, Math.min(settings.poolSize, spare));
}

/**
 * Runs `items` ({ serial }) through `run(item, index)` with at most `size` at once and at most one serial item
 * at a time. Returns the results in item order whatever the completion order was; a rejection becomes `{ error }`.
 */
export function runScheduled(items, { size, run }) {
  const results = new Array(items.length);
  const pending = items.map((_, index) => index);
  let active = 0;
  let serialBusy = false;
  return new Promise((resolve) => {
    const pump = () => {
      while (active < size) {
        const at = pending.findIndex((index) => !items[index].serial || !serialBusy);
        if (at < 0) break;
        const [index] = pending.splice(at, 1);
        const serial = Boolean(items[index].serial);
        if (serial) serialBusy = true;
        active += 1;
        Promise.resolve().then(() => run(items[index], index)).then(
          (value) => { results[index] = value; },
          (error) => { results[index] = { error }; },
        ).finally(() => {
          active -= 1;
          if (serial) serialBusy = false;
          pump();
        });
      }
      if (active === 0 && pending.length === 0) resolve(results);
    };
    pump();
  });
}
