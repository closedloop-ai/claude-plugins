import { spawnSync } from "node:child_process";
import { z } from "zod";
import { MAX_CHECK_MS, MainSyncError, type MainSyncReceipt, type e2eLimitationSchema } from "./main-sync-contracts.js";
import { verifyReportExecution, verifyReportProducerInputs } from "./main-sync-report-inputs.js";
import { ReportExecutionOwner } from "./main-sync-report-execution.js";

export type CheckCommand = { argv: string[]; bindings?: Record<string, string>; cwd?: string; timeoutMs?: number };
// Mirrors the owner's emitted LaneCiCommand (scripts/lint/report-test-lanes.ts); `laneless` entries never leave execPlan.
const laneSchema = z.object({ script: z.string().min(1), dir: z.string().optional(),
  suites: z.string().optional(), widenReason: z.string().optional(), env: z.record(z.string()).optional() }).strict();
const discoverySchema = z.object({ commands: z.array(laneSchema).max(128),
  desktopHarness: z.object({ run: z.string().min(1), dir: z.literal("apps/desktop") }).strict().optional() }).strict();
const DISCOVERY_MODULES = ["scripts/lint/affected-test-lanes.ts", "scripts/lint/report-test-lanes.ts",
  "scripts/lint/desktop-e2e-lane.ts", "scripts/lint/workflow-shell-harness.ts"] as const;
// The changed-path set is derived in the child from the captured main and the recipe's bound HEAD, so the
// recorded argv stays one commit id, and a main import the session merged is not rediscovered path by path.
const DISCOVERY_SOURCE = String.raw`
import {execFileSync} from 'node:child_process';
import {loadOutOfGraphLanes, lanesCoveringPaths, referencedLanes} from './${DISCOVERY_MODULES[0]}';
import {laneCiCommand, execPlan} from './${DISCOVERY_MODULES[1]}';
import {desktopE2eLane} from './${DISCOVERY_MODULES[2]}';
import {loadWorkflowOrThrow} from './${DISCOVERY_MODULES[3]}';
const since = process.argv[1];
if (!/^[a-f0-9]{40}$/.test(since ?? '')) throw new Error('Lane discovery requires the captured main commit');
const paths = execFileSync('git', ['diff', '--name-only', since, 'HEAD'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe']}).trim().split('\n').filter(Boolean);
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

/**
 * Reuses structured owning exports; the report's prose and blind --exec are never launch instructions. No selected
 * lane runs locally (operator ruling, 2026-10-19: CI runs the broad suites); each required browser or Desktop e2e
 * lane comes back as a limitation that only CI evidence clears.
 */
export function discoverRequiredE2eLanes(root: string, receipt: MainSyncReceipt) {
  if (process.env.PWDEBUG) throw new MainSyncError("Headless/displayless validation cannot run with ambient PWDEBUG; no test lane was spawned");
  const discovery = { argv: ["pnpm", "exec", "node", "--import", "tsx/esm", "--input-type=module", "--eval", DISCOVERY_SOURCE, receipt.mainSha] };
  verifyReportProducerInputs(root, root, ReportExecutionOwner.Discovery, DISCOVERY_MODULES);
  verifyReportExecution(root, root, ReportExecutionOwner.Discovery, discovery.argv);
  // The owner runs one git grep per changed path; diffing from the captured main keeps that to the session's own changes.
  const run = spawnSync(discovery.argv[0]!, discovery.argv.slice(1), { cwd: root, encoding: "utf8",
    timeout: MAX_CHECK_MS, maxBuffer: 16 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new MainSyncError("Structured owning test-lane discovery failed; no test lane was spawned");
  const selected = discoverySchema.parse(JSON.parse(run.stdout));
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
    } else if (BROWSER_SCRIPT.test(lane.script)) {
      limitations.push({ argv: ["pnpm", ...(lane.dir ? ["--dir", lane.dir] : []), lane.script], bindings,
        reason: `Required browser lane ${lane.script} has no verified supported headless launch here; no lane spawned or PASS` });
    }
  }
  return limitations;
}

function displaylessPrerequisites(root: string) {
  const result = spawnSync("sh", ["-c", "command -v dbus-run-session && command -v xvfb-run && command -v gnome-keyring-daemon"],
    { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  return !result.error && result.status === 0;
}
