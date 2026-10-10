import { spawnSync } from "node:child_process";
import { z } from "zod";
import { git } from "../../../plugins/vibe/skills/vibe/scripts/session-record.mjs";
import { MainSyncError, type MainSyncReceipt, type e2eLimitationSchema } from "./main-sync-contracts.js";

export type CheckCommand = { argv: string[]; bindings?: Record<string, string>; cwd?: string; timeoutMs?: number };
const laneSchema = z.object({ script: z.string().min(1), dir: z.string().optional(),
  suites: z.string().optional(), env: z.record(z.string()).optional() }).strict();
const discoverySchema = z.object({ commands: z.array(laneSchema).max(128),
  desktopHarness: z.object({ run: z.string().min(1), dir: z.literal("apps/desktop") }).strict().optional() }).strict();
const DISCOVERY_SOURCE = String.raw`
import {loadOutOfGraphLanes, lanesCoveringPaths, referencedLanes} from './scripts/lint/affected-test-lanes.ts';
import {laneCiCommand, execPlan} from './scripts/lint/report-test-lanes.ts';
import {desktopE2eLane} from './scripts/lint/desktop-e2e-lane.ts';
import {loadWorkflowOrThrow} from './scripts/lint/workflow-shell-harness.ts';
const paths = JSON.parse(process.argv[1]);
const lanes = await loadOutOfGraphLanes();
const direct = lanesCoveringPaths(paths, lanes);
const claimed = new Set(direct.flatMap(match => match.paths));
const referenced = referencedLanes(paths.filter(path => !claimed.has(path)), lanes);
const commands = new Map([...direct, ...referenced].map(({lane}) => [lane.script, laneCiCommand(lane.script, paths)]));
const desktop = desktopE2eLane(paths);
let desktopHarness;
if (desktop) {
  commands.set('desktop-e2e', desktop.ci);
  const workflow = loadWorkflowOrThrow('.github/workflows/e2e-test.yml');
  const step = workflow.jobs?.['desktop-e2e']?.steps?.find(step => step.name === 'Run Electron e2e');
  if (!step?.run || step['working-directory'] !== 'apps/desktop') throw new Error('Canonical displayless harness is unavailable');
  desktopHarness = {run: step.run, dir: step['working-directory']};
}
console.log(JSON.stringify({commands: execPlan([], [...commands.values()]), ...(desktopHarness ? {desktopHarness} : {})}));
`;
const BROWSER_SCRIPT = /^(?:test:e2e(?::.*)?|test:web-smoke)$/;

/** Reuses structured owning exports; the report's prose and blind --exec are never launch instructions. */
export function discoverCheckLanes(root: string, receipt: MainSyncReceipt) {
  if (process.env.PWDEBUG) throw new MainSyncError("Headless/displayless validation cannot run with ambient PWDEBUG; no test lane was spawned");
  const paths = git(root, ["diff", "--name-only", receipt.validationSince, "HEAD"]).split("\n").filter(Boolean);
  const discovery = { argv: ["pnpm", "exec", "node", "--import", "tsx/esm", "--input-type=module", "--eval", DISCOVERY_SOURCE, JSON.stringify(paths)] };
  const run = spawnSync(discovery.argv[0]!, discovery.argv.slice(1), { cwd: root, encoding: "utf8",
    timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new MainSyncError("Structured owning test-lane discovery failed; no test lane was spawned");
  const selected = discoverySchema.parse(JSON.parse(run.stdout));
  const commands: CheckCommand[] = [discovery, { argv: ["pnpm", "test:lanes"] }];
  const limitations: z.infer<typeof e2eLimitationSchema>[] = [];
  for (const lane of selected.commands) {
    const bindings: Record<string, string> = { ...lane.env, ...(lane.suites === undefined ? {} : { AFFECTED_SCRIPT_SUITES: lane.suites }) };
    if (bindings.PWDEBUG) throw new MainSyncError("Selected lane enables PWDEBUG; no test lane was spawned");
    if (lane.dir === "apps/desktop" && lane.script === "test:e2e") {
      const harness = selected.desktopHarness;
      if (process.platform !== "linux" || !harness || !harness.run.includes("dbus-run-session")
        || !harness.run.includes("xvfb-run") || !displaylessPrerequisites(root)) {
        limitations.push({ argv: ["pnpm", "--dir", "apps/desktop", lane.script], bindings,
          reason: `Required Desktop Electron lane has no supported displayless prerequisites on ${process.platform}; no lane spawned or PASS. No automatic Vibe-branch E2E path is established; CI dispatch requires explicit operator permission` });
        continue;
      }
      limitations.push({ argv: ["pnpm", "--dir", "apps/desktop", lane.script], bindings,
        reason: "Selected Desktop verdict reads results.json then adjacent dd-quarantine.json from fixed retained locations; no verified current-run report isolation is available here. No lane spawned or PASS; use exact-SHA authorized external coverage" });
    } else {
      if (BROWSER_SCRIPT.test(lane.script)) {
        limitations.push({ argv: ["pnpm", ...(lane.dir ? ["--dir", lane.dir] : []), lane.script], bindings,
          reason: `Required browser lane ${lane.script} has no verified supported headless launch here; no lane spawned or PASS` });
        continue;
      }
      commands.push({ argv: ["pnpm", ...(lane.dir ? ["--dir", lane.dir] : []), lane.script], bindings });
    }
  }
  return { commands, limitations };
}

function displaylessPrerequisites(root: string) {
  const result = spawnSync("sh", ["-c", "command -v dbus-run-session && command -v xvfb-run && command -v gnome-keyring-daemon"],
    { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  return !result.error && result.status === 0;
}
