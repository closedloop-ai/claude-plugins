import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";
import { verifyReportExecution } from "./main-sync-report-inputs.js";
import { ReportExecutionOwner } from "./main-sync-report-execution.js";
import { MainSyncError } from "./main-sync-contracts.js";
import type { CheckCommand } from "./main-sync-lanes.js";

export const GENERAL_CHECK_MS = 15 * 60 * 1000;
const tasksSchema = z.object({ tasks: z.array(z.object({ taskId: z.string().min(1), package: z.string().min(1) }).passthrough()).max(50000) }).passthrough();
const affectedFilterSchema = z.string().regex(/^\.\.\.\[[a-f0-9]{40}\]$/);
const wrapperSchema = z.object({ scripts: z.record(z.string()) }).passthrough();
const AFFECTED_TYPECHECK_SHA = "01c2c50b267a071fa3ed193612c6d2c94f18fde6d01c78c6c47bfd81b56aad69";

/** The fixed affected owner and pinned direct Turbo have distinct real selectors. */
export function commandSelection(root: string, command: CheckCommand, timeoutMs = GENERAL_CHECK_MS) {
  let argv: string[];
  if (command.argv[0] === "pnpm" && command.argv[1] === "turbo") argv = [...command.argv.slice(1), "--dry=json"];
  else if (command.argv.join(" ") === "pnpm typecheck:affected") {
    const pkg = wrapperSchema.parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    if (pkg.scripts["typecheck:affected"] !== "sh scripts/typecheck-affected.sh"
      || createHash("sha256").update(readFileSync(join(root, "scripts/typecheck-affected.sh"))).digest("hex") !== AFFECTED_TYPECHECK_SHA) {
      throw new MainSyncError("Affected typecheck wrapper owner changed; no selected producer authority", "NEEDS_CHANGE");
    }
    argv = ["turbo", "typecheck", `--filter=${affectedFilter(root)}`, "--concurrency=1", "--dry=json"];
  } else return undefined;
  verifyReportExecution(root, root, ReportExecutionOwner.TurboSelection, ["pnpm", ...argv]);
  const run = spawnSync("pnpm", argv, { cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new MainSyncError("Could not bind the actual canonical Turbo task selection");
  return tasksSchema.parse(JSON.parse(run.stdout));
}

function affectedFilter(root: string) {
  verifyReportExecution(root, root, ReportExecutionOwner.AffectedFilter, ["sh", "scripts/affected-filter.sh"]);
  const selected = spawnSync("sh", ["scripts/affected-filter.sh"], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 });
  if (selected.error || selected.status !== 0) throw new MainSyncError("Existing affected-filter owner failed; no selection was derived");
  return affectedFilterSchema.parse(selected.stdout.trim());
}

/** Every selected check runs under the fixed general budget unless the recipe already fixed its own. */
export function bindCheckBudgets(commands: CheckCommand[]) {
  return commands.map((command) => ({ ...command, timeoutMs: command.timeoutMs ?? GENERAL_CHECK_MS }));
}
